import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openClaudeThreadStore } from "./claudeThreadStore.js";
import type {
  AiProvider,
  AiResult,
  JsonValue,
  TaskContext
} from "@patchdoll/core";
import {
  buildPatchdollPrompt,
  buildResetThreadResult,
  extractProposedActionsFromMessage,
  isClaudeResumeFailure,
  isResetThreadCommand,
  patchdollThreadKey,
  RESET_THREAD_HINT,
  stringifyLogJson
} from "@patchdoll/core";
import {
  CLAUDE_EFFORTS,
  DEFAULT_SETTINGS,
  openPatchdollSettingsStoreSync
} from "@patchdoll/core/settings";

const CLAUDE_HOME = "/patchdoll/agent";
const MODEL_INSTRUCTIONS_FILE = "/etc/agent/AGENTS.md";
const STATE_DIR = "/patchdoll/state";
const PATCHDOLL_WORKDIR = "/workspace";
const MAX_CAPTURED_OUTPUT_BYTES = 256000;
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

interface ClaudeInvocation {
  instructionsFile: string;
  prompt: string;
  workdir: string;
  model: string;
  effort: string;
  permissionMode: string;
  maxTurns: number;
  memoryEnabled: boolean;
  runtimeEnv: Record<string, string>;
  sessionId?: string;
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
}

export class ClaudeAiProvider implements AiProvider {
  private running = 0;

  constructor(
    private readonly timeoutMs: number,
    private readonly maxConcurrentRuns: number,
    private readonly stateDir = STATE_DIR,
    private readonly claudeBin = "claude"
  ) {}

  async run(
    task: TaskContext,
    runtimeEnv: Record<string, string> = {}
  ): Promise<AiResult> {
    if (this.running >= this.maxConcurrentRuns) {
      throw new Error("Claude AI concurrency limit reached");
    }

    this.running += 1;
    try {
      return await this.runClaude(task, runtimeEnv);
    } finally {
      this.running -= 1;
    }
  }

  private async runClaude(
    task: TaskContext,
    runtimeEnv: Record<string, string>
  ): Promise<AiResult> {
    await mkdir(CLAUDE_HOME, { recursive: true, mode: 0o700 });
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });

    const model = claudeModel();
    const effort = claudeEffort();
    const permissionMode = claudePermissionMode();
    const maxTurns = claudeMaxTurns();
    const memoryEnabled = aiMemoryEnabled();
    const threadKey = patchdollThreadKey(task);
    const stateDbPath = join(this.stateDir, "patchdoll.sqlite");
    const store = openClaudeThreadStore(stateDbPath);

    // Explicit human escape hatch: `reset thread` clears the stored session
    // without invoking the CLI. Admin-only so a stray message can't drop a
    // valid session's context.
    if (isResetThreadCommand(task.event.body)) {
      try {
        const actorIsAdmin = task.config.actorIsAdmin;
        let cleared = false;
        if (actorIsAdmin) {
          cleared = Boolean(store.get(threadKey)?.sessionId);
          store.delete(threadKey);
        }
        writePatchdollLog("info", "claude reset-thread command", {
          threadKey,
          actorIsAdmin,
          cleared
        });
        return buildResetThreadResult({
          provider: "claude",
          threadKey,
          actorIsAdmin,
          cleared
        });
      } finally {
        store.close();
      }
    }

    const startedAt = new Date();

    let result: ClaudeJsonResult;
    let existing;
    try {
      existing = store.get(threadKey);

      const invoke = (sessionId: string | undefined) =>
        this.invokeClaude({
          instructionsFile: MODEL_INSTRUCTIONS_FILE,
          prompt: buildPatchdollPrompt(task, {
            agentName: "Claude Code",
            threadKey,
            continuingPriorThread: Boolean(sessionId),
            settingsExample: '{"claude":{"model":"opus","effort":"high"}}'
          }),
          workdir: PATCHDOLL_WORKDIR,
          model,
          effort,
          permissionMode,
          maxTurns,
          memoryEnabled,
          runtimeEnv,
          sessionId
        });

      try {
        result = await invoke(existing?.sessionId);
      } catch (error) {
        // Only self-heal when the stored session itself failed to resume. Any
        // other failure (timeout, auth, CLI startup, or a real agent failure
        // after resume already succeeded) must propagate untouched — clearing
        // the session there would discard valid context and duplicate work.
        const hadSession = Boolean(existing?.sessionId);
        const resume = hadSession
          ? isClaudeResumeFailure(error)
          : { matched: false };
        if (!resume.matched) {
          // Observability: a stored session failed with wording we don't
          // recognize as a resume failure. We leave it intact rather than guess
          // and delete valid context, but surface it — this is the sample we
          // need to tune the signature lists, and it explains a wedged thread.
          if (hadSession) {
            writePatchdollLog(
              "warn",
              "claude invocation failed with a stored session but no resume signature matched; leaving session intact",
              {
                threadKey,
                sessionId: existing?.sessionId,
                error: messageOf(error)
              }
            );
            // Surface the escape hatch: we kept the session (right call), but if
            // it's actually a dead-session failure we don't recognize, an admin
            // can recover with `reset thread`.
            throw new Error(`${messageOf(error)}\n\n${RESET_THREAD_HINT}`);
          }
          throw error;
        }
        // A stored session can become unresumable if its transcript was pruned
        // or rotated. Left in place, the dead id would re-fail `--resume` on
        // every future turn and wedge this thread permanently. Clear it and
        // retry once as a fresh session so the thread self-heals.
        writePatchdollLog("warn", "claude resume failed; clearing session and retrying fresh", {
          threadKey,
          signature: resume.signature,
          error: messageOf(error)
        });
        store.delete(threadKey);
        existing = undefined;
        result = await invoke(undefined);
      }

      // Resuming a session returns its (possibly forked) id; persist whatever
      // the latest run reported so the next turn resumes from the newest point.
      const sessionId = result.session_id ?? existing?.sessionId;
      if (sessionId) {
        store.upsert(threadKey, {
          sessionId,
          source: task.event.source,
          createdAt: existing?.createdAt ?? startedAt.toISOString(),
          updatedAt: new Date().toISOString(),
          actor: task.event.actor,
          lastEventId: task.event.id
        });
      }
    } finally {
      store.close();
    }

    const sessionId = result.session_id ?? existing?.sessionId;
    const finalMessage = result.result?.trim() || "Claude Code returned no response.";
    const extracted = extractProposedActionsFromMessage(finalMessage);
    const reply = extracted.reply || "Claude Code returned no response.";
    const proposedActions = extracted.proposedActions;
    const metadata: Record<string, JsonValue> = {
      provider: "claude",
      model,
      effort,
      permissionMode,
      maxTurns,
      memoryEnabled,
      threadKey,
      resumed: Boolean(existing),
      sessionPersisted: Boolean(sessionId)
    };

    if (sessionId) metadata.sessionId = sessionId;
    if (typeof result.total_cost_usd === "number") {
      metadata.totalCostUsd = result.total_cost_usd;
    }
    if (typeof result.num_turns === "number") metadata.numTurns = result.num_turns;
    if (typeof result.duration_ms === "number") metadata.durationMs = result.duration_ms;
    if (typeof result.duration_api_ms === "number") {
      metadata.durationApiMs = result.duration_api_ms;
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
  }

  private async invokeClaude(invocation: ClaudeInvocation): Promise<ClaudeJsonResult> {
    writePatchdollLog("debug", "claude invocation start", {
      model: invocation.model,
      permissionMode: invocation.permissionMode,
      maxTurns: invocation.maxTurns,
      workdir: invocation.workdir,
      resuming: Boolean(invocation.sessionId)
    });
    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBin, claudeArgs(invocation), {
        cwd: invocation.workdir,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildClaudeEnv(invocation.runtimeEnv, invocation.memoryEnabled)
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        writePatchdollLog("warn", "claude invocation timed out", {
          timeoutMs: this.timeoutMs
        });
        reject(new Error(`Claude Code timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = appendTail(stdout, chunk);
        if (shouldLog("trace")) {
          writePatchdollLog("trace", "claude stdout", {
            chunk: truncateLogValue(chunk)
          });
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = appendTail(stderr, chunk);
        if (shouldLog("trace")) {
          writePatchdollLog("trace", "claude stderr", {
            chunk: truncateLogValue(chunk)
          });
        }
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        writePatchdollLog("warn", "claude failed to start", {
          bin: this.claudeBin,
          error: error.message
        });
        reject(new Error(`Claude Code failed to start (${this.claudeBin}): ${error.message}`));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          writePatchdollLog("warn", "claude exited with non-zero code", {
            code: code ?? null,
            stderr: truncateLogValue(tailForError(stderr || stdout))
          });
          reject(new Error(`Claude Code exited with ${code ?? "unknown"}: ${tailForError(stderr || stdout)}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as ClaudeJsonResult;
          if (parsed.is_error) {
            writePatchdollLog("warn", "claude returned an error result", {
              subtype: parsed.subtype ?? null
            });
            reject(new Error(`Claude Code returned an error result: ${parsed.subtype ?? "unknown"}`));
            return;
          }
          writePatchdollLog("debug", "claude invocation completed", {
            subtype: parsed.subtype,
            numTurns: parsed.num_turns,
            durationMs: parsed.duration_ms,
            durationApiMs: parsed.duration_api_ms,
            totalCostUsd: parsed.total_cost_usd,
            sessionId: parsed.session_id
          });
          resolve(parsed);
        } catch (error) {
          writePatchdollLog("warn", "claude returned invalid JSON", {
            error: messageOf(error),
            stdout: truncateLogValue(tailForError(stdout))
          });
          reject(new Error(`Claude Code returned invalid JSON: ${messageOf(error)}`));
        }
      });
    });
  }
}

function claudeArgs(invocation: ClaudeInvocation): string[] {
  const args = [
    "--append-system-prompt-file",
    invocation.instructionsFile, 
    "-p",
    invocation.prompt,
    "--output-format",
    "json",
    "--model",
    invocation.model,
    "--effort",
    invocation.effort,
    "--permission-mode",
    invocation.permissionMode
  ];
  if (invocation.sessionId) {
    args.push("--resume", invocation.sessionId);
  }
  if (invocation.maxTurns > 0) {
    args.push("--max-turns", String(invocation.maxTurns));
  }
  return args;
}

function buildClaudeEnv(
  runtimeEnv: Record<string, string> = {},
  memoryEnabled = true
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: CLAUDE_HOME,
    CLAUDE_CONFIG_DIR: CLAUDE_HOME,
    DISABLE_AUTOUPDATER: "1",
    TERM: process.env.TERM,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE
  };
  // Claude Code auto-memory is on by default; the only way to turn it off is
  // this env var. When the toggle is enabled we leave it unset so the default
  // (memory on) applies.
  if (!memoryEnabled) {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  // Runtime env (e.g. GH_TOKEN/GITHUB_TOKEN minted from the GitHub App) is
  // injected last so the spawned `claude` process can use the `gh` CLI.
  Object.assign(env, runtimeEnv);
  return env;
}

function claudeModel(): string {
  const value = setting("claude.model", DEFAULT_SETTINGS["claude.model"]);
  return typeof value === "string" ? value : DEFAULT_SETTINGS["claude.model"];
}

function claudeEffort(): string {
  const value = setting("claude.effort", DEFAULT_SETTINGS["claude.effort"]);
  const effort = typeof value === "string" ? value : DEFAULT_SETTINGS["claude.effort"];

  if (!(CLAUDE_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`claude.effort must be one of ${CLAUDE_EFFORTS.join(", ")}`);
  }

  return effort;
}

function claudePermissionMode(): string {
  const value = setting("claude.permissionMode", DEFAULT_SETTINGS["claude.permissionMode"]);
  return typeof value === "string" ? value : DEFAULT_SETTINGS["claude.permissionMode"];
}

function claudeMaxTurns(): number {
  const value = setting("claude.maxTurns", DEFAULT_SETTINGS["claude.maxTurns"]);
  return typeof value === "number" ? value : DEFAULT_SETTINGS["claude.maxTurns"];
}

// Claude Code's native default is auto-memory ON. The shared `ai.memoryEnabled`
// setting is an optional override: when unset, we preserve that native default
// so Claude users see no surprise change in behavior.
const CLAUDE_NATIVE_MEMORY_ENABLED = true;

function aiMemoryEnabled(): boolean {
  const value = setting("ai.memoryEnabled", CLAUDE_NATIVE_MEMORY_ENABLED);
  return typeof value === "boolean" ? value : CLAUDE_NATIVE_MEMORY_ENABLED;
}

function setting(key: string, fallback: JsonValue): JsonValue {
  const store = openPatchdollSettingsStoreSync();
  try {
    return store.get(key) ?? fallback;
  } finally {
    store.close();
  }
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_CAPTURED_OUTPUT_BYTES
    ? next
    : next.slice(next.length - MAX_CAPTURED_OUTPUT_BYTES);
}

function tailForError(value: string): string {
  const trimmed = value.trim();
  return trimmed || "no output";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writePatchdollLog(
  level: LogLevel,
  message: string,
  fields: Record<string, JsonValue | undefined> = {}
): void {
  const entry: Record<string, JsonValue> = {
    level,
    source: "patchdoll.provider-claude",
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
    source: "patchdoll.provider-claude",
    message: "Invalid PATCHDOLL_LOG_LEVEL; using info.",
    value
  }));
  return DEFAULT_LOG_LEVEL;
}
