import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openCodexThreadStore } from "./codexThreadStore.js";
import type {
  AiProvider,
  AiResult,
  JsonValue,
  ProgressEvent,
  ProgressSink,
  TaskContext
} from "@patchdoll/core";
import {
  buildPatchdollPrompt,
  extractProposedActionsFromMessage,
  patchdollThreadKey,
  stringifyLogJson
} from "@patchdoll/core";
import {
  CODEX_REASONING_EFFORTS,
  DEFAULT_SETTINGS,
  openPatchdollSettingsStoreSync
} from "@patchdoll/core/settings";

const DEFAULT_CODEX_ENV_ALLOWLIST = [
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR"
];

const SESSION_DISCOVERY_WINDOW_MS = 10000;
const MAX_CAPTURED_OUTPUT_BYTES = 256000;
const CODEX_HOME = "/patchdoll/agent";
const MODEL_INSTRUCTIONS_FILE = "/etc/codex/AGENTS.md";
const STATE_DIR = "/patchdoll/state";
const PATCHDOLL_WORKDIR = "/workspace";
const LOG_LEVELS = ["trace", "debug", "info", "warn"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40
};
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const MAX_LOG_VALUE_LENGTH = 4000;
const PATCHDOLL_LOG_LEVEL = parseLogLevel(process.env.PATCHDOLL_LOG_LEVEL);
const STATUS_CHECKING = "Checking that now.";
const STATUS_EDITING = "I'm cleaning that up.";
const STATUS_STARTED = "I'm on it.";
const STATUS_STEP_DONE = "Done with that step.";

interface CodexInvocation {
  prompt: string;
  outputPath: string;
  codexHome: string;
  workdir: string;
  model: string;
  reasoningEffort: string;
  fastMode: boolean;
  bypassSandboxAndApprovals: boolean;
  env?: Record<string, string>;
  sessionId?: string;
  progress?: ProgressSink;
}

export class CodexAiProvider implements AiProvider {
  private running = 0;

  constructor(
    private readonly timeoutMs: number,
    private readonly maxConcurrentRuns: number,
    private readonly bypassSandboxAndApprovals = true,
    private readonly stateDir = STATE_DIR,
    private readonly codexBin = "codex"
  ) {}

  async run(
    task: TaskContext,
    runtimeEnv: Record<string, string> = {}
  ): Promise<AiResult> {
    if (this.running >= this.maxConcurrentRuns) {
      throw new Error("Codex AI concurrency limit reached");
    }

    this.running += 1;
    try {
      return await this.runCodex(task, runtimeEnv);
    } finally {
      this.running -= 1;
    }
  }

  private async runCodex(
    task: TaskContext,
    runtimeEnv: Record<string, string>
  ): Promise<AiResult> {
    const codexHome = CODEX_HOME;
    const workdir = PATCHDOLL_WORKDIR;
    const stateDbPath = join(this.stateDir, "patchdoll.sqlite");
    const legacyThreadStorePath = join(
      this.stateDir,
      "slack-codex-threads.json"
    );
    const model = codexModel();
    const reasoningEffort = codexReasoningEffort();
    const fastMode = codexFastMode();

    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });

    const threadKey = patchdollThreadKey(task);
    const store = openCodexThreadStore(stateDbPath, legacyThreadStorePath);
    let existing = store.get(threadKey);
    let tempDir: string | undefined;
    const startedAt = Date.now();

    try {
      tempDir = await mkdtemp(join(tmpdir(), "patchdoll-codex-"));
      const outputPath = join(tempDir, "last-message.txt");

      const invoke = (sessionId: string | undefined) =>
        this.invokeCodex({
          prompt: buildPatchdollPrompt(task, {
            agentName: "Codex CLI",
            threadKey,
            continuingPriorThread: Boolean(sessionId),
            settingsExample: '{"codex":{"model":"gpt-5.5","reasoningEffort":"high"}}',
            supportsExecpolicy: true
          }),
          outputPath,
          codexHome,
          workdir,
          model,
          reasoningEffort,
          fastMode,
          bypassSandboxAndApprovals: this.bypassSandboxAndApprovals,
          env: runtimeEnv,
          sessionId,
          progress: task.progress
        });

      let stdout: string;
      try {
        stdout = await invoke(existing?.sessionId);
      } catch (error) {
        if (!existing?.sessionId) {
          throw error;
        }
        // A stored session can become unresumable if its rollout file was
        // pruned or rotated. Left in place, the dead id would re-fail
        // `exec resume` on every future turn and wedge this thread
        // permanently. Clear it and retry once as a fresh session so the
        // thread self-heals.
        writePatchdollLog("warn", "codex resume failed; clearing session and retrying fresh", {
          threadKey,
          error: messageOf(error)
        });
        store.delete(threadKey);
        existing = undefined;
        stdout = await invoke(undefined);
      }

      const finalMessage = await readFinalMessage(outputPath, stdout);
      const extracted = extractProposedActionsFromMessage(finalMessage);
      const reply = extracted.reply || "Codex completed without a final message.";
      const proposedActions = extracted.proposedActions;
      const sessionId =
        existing?.sessionId ??
        (await newestSessionId(codexHome, startedAt));

      if (sessionId) {
        store.upsert(threadKey, {
          sessionId,
          source: task.event.source,
          createdAt: existing?.createdAt ?? new Date(startedAt).toISOString(),
          updatedAt: new Date().toISOString(),
          actor: task.event.actor,
          lastEventId: task.event.id
        });
      }

      const metadata: Record<string, JsonValue> = {
        provider: "codex",
        model,
        reasoningEffort,
        fastMode,
        resumed: Boolean(existing),
        threadKey,
        sessionPersisted: Boolean(sessionId)
      };
      if (sessionId) {
        metadata.sessionId = sessionId;
      }

      return {
        reply,
        proposedActions: [
          {
            type: "chat.reply",
            body: reply
          },
          ...proposedActions
        ],
        metadata
      };
    } finally {
      store.close();
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }

  private async invokeCodex(invocation: CodexInvocation): Promise<string> {
    const env = buildCodexEnv(invocation.codexHome, invocation.env);
    return new Promise((resolve, reject) => {
      const args = codexArgs(invocation);
      const child = spawn(this.codexBin, args, {
        cwd: invocation.workdir,
        stdio: ["pipe", "pipe", "pipe"],
        env
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let stdoutLineBuffer = "";
      const emitProgress = (event: ProgressEvent) => {
        if (!invocation.progress) {
          return;
        }

        Promise.resolve(invocation.progress(event)).catch(() => undefined);
      };

      const { stdin, stdout: childStdout, stderr: childStderr } = child;
      if (!stdin || !childStdout || !childStderr) {
        child.kill("SIGTERM");
        reject(new Error("Codex CLI did not expose stdio pipes"));
        return;
      }

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Codex CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      childStdout.setEncoding("utf8");
      childStderr.setEncoding("utf8");
      childStdout.on("data", (chunk: string) => {
        stdout = appendTail(stdout, chunk);
        stdoutLineBuffer = parseCodexJsonlProgress(
          stdoutLineBuffer + chunk,
          emitProgress
        );
      });
      childStderr.on("data", (chunk: string) => {
        stderr = appendTail(stderr, chunk);
      });

      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new Error(
              `Codex CLI failed to start (${this.codexBin}): ${error.message}`
            )
          );
        }
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        parseCodexJsonlProgress(`${stdoutLineBuffer}\n`, emitProgress);

        if (code !== 0) {
          reject(
            new Error(
              `Codex CLI exited with ${code ?? "unknown"}: ${tailForError(
                stderr || stdout
              )}`
            )
          );
          return;
        }

        resolve(stdout);
      });

      stdin.end(invocation.prompt);
    });
  }
}

function parseCodexJsonlProgress(
  buffer: string,
  emitProgress: (event: ProgressEvent) => void
): string {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const event = summarizedCodexProgressEvent(trimmed);
    logCodexProgressLine(trimmed, event);
    if (event) {
      emitProgress(event);
    }
  }

  return remainder;
}

function logCodexProgressLine(
  line: string,
  event: ProgressEvent | undefined
): void {
  if (shouldLog("trace")) {
    writePatchdollLog("trace", "codex progress raw", {
      line: truncateLogValue(line)
    });
    return;
  }

  if (!shouldLog("debug")) {
    return;
  }

  const raw = rawCodexProgressEvent(line);
  const metadata = raw?.metadata ?? {};
  writePatchdollLog("debug", "codex progress event", {
    kind: jsonString(metadata.kind) ?? "raw",
    tool: jsonString(metadata.tool),
    progress: event?.message
  });
}

function writePatchdollLog(
  level: LogLevel,
  message: string,
  fields: Record<string, JsonValue | undefined> = {}
): void {
  const entry: Record<string, JsonValue> = {
    level,
    source: "patchdoll.provider-codex",
    message
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      entry[key] = value;
    }
  }

  const serialized = stringifyLogJson(entry);
  if (level === "warn") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[PATCHDOLL_LOG_LEVEL] <= LOG_LEVEL_ORDER[level];
}

function truncateLogValue(value: string): string {
  const suffix = "...[truncated]";
  return value.length <= MAX_LOG_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_LOG_VALUE_LENGTH - suffix.length)}${suffix}`;
}

function rawCodexProgressEvent(line: string): ProgressEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      source: "codex",
      message: line,
      metadata: { kind: "raw" }
    };
  }

  if (!isJsonObject(parsed)) {
    return {
      source: "codex",
      message: line,
      metadata: { kind: "raw" }
    };
  }

  const payload = isJsonObject(parsed.payload) ? parsed.payload : parsed;
  const type = jsonString(payload.type) ?? jsonString(parsed.type);
  const tool = jsonString(payload.name);

  return {
    source: "codex",
    message: line,
    metadata: tool ? { kind: type ?? "raw", tool } : { kind: type ?? "raw" }
  };
}

function summarizedCodexProgressEvent(
  line: string
): ProgressEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!isJsonObject(parsed)) {
    return undefined;
  }

  const agentMessage = findAgentMessage(parsed);
  if (agentMessage) {
    return agentMessage;
  }

  const payload = isJsonObject(parsed.payload) ? parsed.payload : parsed;
  const envelopeType = jsonString(parsed.type);
  const payloadType = jsonString(payload.type);
  const type = payloadType ?? envelopeType;
  if (!type) {
    return undefined;
  }

  if (type === "agent_message") {
    return progressFromAgentMessage(payload);
  }

  if (type === "function_call") {
    return progressFromFunctionCall(payload);
  }

  return progressFromCodexEvent(type, payload, envelopeType);
}

function progressFromAgentMessage(
  payload: Record<string, JsonValue>
): ProgressEvent | undefined {
  const message = jsonString(payload.message);
  const phase = jsonString(payload.phase);
  if (!message || phase === "final_answer") {
    return undefined;
  }

  return {
    source: "codex",
    message,
    metadata: { kind: "agent_message", phase: phase ?? "unknown" }
  };
}

function findAgentMessage(value: JsonValue): ProgressEvent | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAgentMessage(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (!isJsonObject(value)) {
    return undefined;
  }

  if (jsonString(value.type) === "agent_message") {
    return progressFromAgentMessage(value);
  }

  const direct = jsonString(value.agent_message);
  if (direct) {
    return {
      source: "codex",
      message: direct,
      metadata: { kind: "agent_message", phase: "unknown" }
    };
  }

  for (const nested of Object.values(value)) {
    if (typeof nested !== "object" || nested === null) {
      continue;
    }

    const found = findAgentMessage(nested);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function progressFromFunctionCall(
  payload: Record<string, JsonValue>
): ProgressEvent | undefined {
  const name = jsonString(payload.name);
  if (!name) {
    return undefined;
  }

  if (name === "exec_command") {
    return {
      source: "codex",
      message: STATUS_CHECKING,
      metadata: { kind: "function_call", tool: name }
    };
  }

  if (name === "apply_patch") {
    return {
      source: "codex",
      message: STATUS_EDITING,
      metadata: { kind: "function_call", tool: name }
    };
  }

  return {
    source: "codex",
    message: STATUS_CHECKING,
    metadata: { kind: "function_call", tool: name }
  };
}

function progressFromCodexEvent(
  type: string,
  payload: Record<string, JsonValue>,
  envelopeType: string | undefined
): ProgressEvent | undefined {
  const payloadType = jsonString(payload.type);
  const kind =
    envelopeType && payloadType && envelopeType !== payloadType
      ? `${envelopeType}.${payloadType}`
      : type;
  const knownMessage = progressMessageFromKnownCodexEvent(kind);
  if (knownMessage) {
    return {
      source: "codex",
      message: knownMessage,
      metadata: { kind }
    };
  }

  if (envelopeType === "event_msg" && payloadType === "token_count") {
    return undefined;
  }

  if (envelopeType === "response_item" && payloadType === "reasoning") {
    return undefined;
  }

  if (envelopeType === "response_item" && payloadType === "function_call_output") {
    return undefined;
  }

  if (envelopeType === "event_msg") {
    return undefined;
  }

  if (envelopeType === "response_item" && payloadType) {
    return {
      source: "codex",
      message: STATUS_CHECKING,
      metadata: { kind }
    };
  }

  return {
    source: "codex",
    message: STATUS_CHECKING,
    metadata: { kind }
  };
}

function progressMessageFromKnownCodexEvent(kind: string): string | undefined {
  if (kind === "turn.started") {
    return STATUS_STARTED;
  }

  if (kind === "item.completed") {
    return STATUS_STEP_DONE;
  }

  return undefined;
}

function codexArgs(invocation: CodexInvocation): string[] {
  const args = invocation.sessionId ? ["exec", "resume"] : ["exec"];

  args.push(
    "--config",
    `model_instructions_file="${MODEL_INSTRUCTIONS_FILE}"`
  );

  if (!invocation.sessionId) {
    args.push("--cd", invocation.workdir);
  }

  args.push("--output-last-message", invocation.outputPath, "--json");
  if (invocation.bypassSandboxAndApprovals) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  args.push("--model", invocation.model);
  args.push(
    "--config",
    `model_reasoning_effort="${invocation.reasoningEffort}"`
  );

  if (invocation.fastMode) {
    args.push("--config", 'service_tier="priority"');
  }

  const profile = process.env.PATCHDOLL_CODEX_PROFILE;
  if (profile && !invocation.sessionId) {
    args.push("--profile", profile);
  }

  if (parseBoolean(process.env.PATCHDOLL_CODEX_SKIP_GIT_REPO_CHECK, true)) {
    args.push("--skip-git-repo-check");
  }

  if (invocation.sessionId) {
    args.push(invocation.sessionId);
  }

  args.push("-");
  return args;
}

async function newestSessionId(
  codexHome: string,
  startedAt: number
): Promise<string | undefined> {
  const sessionFiles = await listJsonlFiles(join(codexHome, "sessions"));
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  for (const path of sessionFiles) {
    try {
      const info = await stat(path);
      if (
        info.isFile() &&
        info.mtimeMs >= startedAt - SESSION_DISCOVERY_WINDOW_MS
      ) {
        candidates.push({ path, mtimeMs: info.mtimeMs });
      }
    } catch {
      continue;
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of candidates) {
    const id = await sessionIdFromFile(candidate.path);
    if (id) {
      return id;
    }
  }

  return undefined;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }

  return files;
}

async function sessionIdFromFile(path: string): Promise<string | undefined> {
  const fromName = basename(path).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  )?.[1];

  try {
    const raw = await readFile(path, "utf8");
    const firstLine = raw.split(/\r?\n/, 1)[0];
    const parsed = JSON.parse(firstLine) as unknown;
    if (!isJsonObject(parsed)) {
      return fromName;
    }

    const payload = parsed.payload;
    if (!isJsonObject(payload)) {
      return fromName;
    }

    return jsonString(payload.id) ?? fromName;
  } catch {
    return fromName;
  }
}

async function readFinalMessage(
  outputPath: string,
  stdout: string
): Promise<string> {
  try {
    const message = (await readFile(outputPath, "utf8")).trim();
    if (message) {
      return message;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const fallback = stdout.trim();
  return fallback || "Codex completed without a final message.";
}

function buildCodexEnv(
  codexHome: string,
  runtimeEnv: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of DEFAULT_CODEX_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }

  env.CODEX_HOME = codexHome;
  env.HOME = codexHome;
  env.PATCHDOLL_TASK = "1";
  Object.assign(env, runtimeEnv);
  return env;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value) {
    return DEFAULT_LOG_LEVEL;
  }

  const normalized = value.trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as LogLevel;
  }

  console.warn(stringifyLogJson({
    level: "warn",
    source: "patchdoll.provider-codex",
    message: "Invalid PATCHDOLL_LOG_LEVEL; using info.",
    value
  }));
  return DEFAULT_LOG_LEVEL;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function codexModel(): string {
  return stringSetting("codex.model") ?? DEFAULT_SETTINGS["codex.model"];
}

function codexReasoningEffort(): string {
  const value = stringSetting("codex.reasoningEffort") ?? DEFAULT_SETTINGS["codex.reasoningEffort"];

  if (!(CODEX_REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new Error(
      `codex.reasoningEffort must be one of ${CODEX_REASONING_EFFORTS.join(", ")}`
    );
  }

  return value;
}

function codexFastMode(): boolean {
  return booleanSetting("codex.fastMode") ?? DEFAULT_SETTINGS["codex.fastMode"];
}

function stringSetting(key: string): string | undefined {
  const value = readSetting(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanSetting(key: string): boolean | undefined {
  const value = readSetting(key);
  return typeof value === "boolean" ? value : undefined;
}

function readSetting(key: string): JsonValue | undefined {
  try {
    const store = openPatchdollSettingsStoreSync();
    try {
      return store.get(key);
    } finally {
      store.close();
    }
  } catch {
    return undefined;
  }
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_CAPTURED_OUTPUT_BYTES
    ? next.slice(-MAX_CAPTURED_OUTPUT_BYTES)
    : next;
}

function tailForError(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonString(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
