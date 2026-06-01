import { readFile } from "node:fs/promises";
import type { AiConfig, Capabilities, JsonValue, PatchdollConfig } from "./types.js";
import { openPatchdollSettingsStore } from "./settings.js";

const CONFIG_PATH = "/patchdoll/config/config.json";
const AGENTS_PATH = "/workspace/AGENTS.md";

const DEFAULT_CAPABILITIES: Capabilities = {
  "chat.reply": true,
  "policy.codex.execpolicy.add_rule": true,
  "patchdoll.settings.update": true
};

const DEFAULT_AI: AiConfig = {
  timeoutSeconds: 900,
  maxConcurrentRuns: 1,
  bypassSandboxAndApprovals: true
};

export async function loadConfig(): Promise<PatchdollConfig> {
  const fileConfig = await loadConfigFile();
  const settings = await loadDbSettings();
  const ai = {
    ...DEFAULT_AI,
    timeoutSeconds: asNumber(settings["ai.timeoutSeconds"], DEFAULT_AI.timeoutSeconds),
    maxConcurrentRuns: asNumber(settings["ai.maxConcurrentRuns"], DEFAULT_AI.maxConcurrentRuns),
    bypassSandboxAndApprovals: asBoolean(settings["ai.bypassSandboxAndApprovals"], DEFAULT_AI.bypassSandboxAndApprovals),
    ...fileConfig.ai
  };

  return {
    server: {
      host: process.env.HOST ?? fileConfig.server?.host ?? "0.0.0.0",
      port: parseInteger(process.env.PORT, fileConfig.server?.port ?? 3000)
    },
    agentsMdPath: AGENTS_PATH,
    ai: {
      ...ai,
      timeoutSeconds: parseInteger(
        process.env.PATCHDOLL_AI_TIMEOUT_SECONDS,
        ai.timeoutSeconds
      ),
      maxConcurrentRuns: parseInteger(
        process.env.PATCHDOLL_AI_MAX_CONCURRENT_RUNS,
        ai.maxConcurrentRuns
      ),
      bypassSandboxAndApprovals: parseBoolean(
        process.env.PATCHDOLL_CODEX_BYPASS_APPROVALS_AND_SANDBOX,
        ai.bypassSandboxAndApprovals
      )
    },
    capabilities: DEFAULT_CAPABILITIES,
    admins: parseStringList(process.env.PATCHDOLL_ADMINS) ?? []
  };
}

async function loadConfigFile(): Promise<Partial<PatchdollConfig>> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as Partial<PatchdollConfig>;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function parseStringList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function loadDbSettings(): Promise<Record<string, JsonValue>> {
  try {
    const store = await openPatchdollSettingsStore();
    try {
      return store.list();
    } finally {
      store.close();
    }
  } catch {
    return {};
  }
}

function asNumber(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
