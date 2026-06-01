import { chmodSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import type { JsonValue } from "./types.js";

export const PATCHDOLL_STATE_DB_PATH = "/patchdoll/state/patchdoll.sqlite";

export const DEFAULT_SETTINGS = {
  "ai.timeoutSeconds": 900,
  "ai.maxConcurrentRuns": 1,
  "ai.bypassSandboxAndApprovals": true,
  "codex.model": "gpt-5.5",
  "codex.reasoningEffort": "medium",
  "codex.fastMode": false,
  "slack.command": "/patchdoll"
} as const satisfies Record<string, JsonValue>;

export const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const SETTING_DEFINITIONS: Record<string, (value: JsonValue) => JsonValue> = {
  "ai.timeoutSeconds": positiveInteger,
  "ai.maxConcurrentRuns": positiveInteger,
  "ai.bypassSandboxAndApprovals": booleanValue,
  "codex.model": nonEmptyString,
  "codex.reasoningEffort": enumValue([...CODEX_REASONING_EFFORTS]),
  "codex.fastMode": booleanValue,
  "slack.command": nonEmptyString
};

export class PatchdollSettingsStore {
  constructor(private readonly db: DatabaseSync) {
    initializeSettingsDatabase(this.db);
  }

  get(key: string): JsonValue | undefined {
    const row = this.db.prepare("SELECT value FROM patchdoll_settings WHERE key = ?").get(key);
    if (!row || typeof row !== "object" || !("value" in row)) return undefined;
    return JSON.parse(String(row.value)) as JsonValue;
  }

  list(): Record<string, JsonValue> {
    const rows = this.db.prepare("SELECT key, value FROM patchdoll_settings ORDER BY key").all();
    const values: Record<string, JsonValue> = {};
    for (const row of rows) {
      if (row && typeof row === "object" && "key" in row && "value" in row) {
        values[String(row.key)] = JSON.parse(String(row.value)) as JsonValue;
      }
    }
    return values;
  }

  set(key: string, rawValue: JsonValue): void {
    const value = validateSetting(key, rawValue);
    this.db.prepare(
      `INSERT INTO patchdoll_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(value));
  }

  close(): void {
    this.db.close();
  }
}

export async function openPatchdollSettingsStore(path = PATCHDOLL_STATE_DB_PATH): Promise<PatchdollSettingsStore> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
  await chmod(path, 0o660).catch(() => undefined);
  return new PatchdollSettingsStore(db);
}

export function openPatchdollSettingsStoreSync(path = PATCHDOLL_STATE_DB_PATH): PatchdollSettingsStore {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
  try {
    chmodSync(path, 0o660);
  } catch {
    // The opener may have group access without owning the SQLite file.
  }
  return new PatchdollSettingsStore(db);
}

export function validateSetting(key: string, value: JsonValue): JsonValue {
  const validator = SETTING_DEFINITIONS[key];
  if (!validator) throw new Error(`Unsupported setting: ${key}`);
  return validator(value);
}

function initializeSettingsDatabase(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;

    CREATE TABLE IF NOT EXISTS patchdoll_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    ) STRICT;
  `);

  const insert = db.prepare(
    `INSERT INTO patchdoll_settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insert.run(key, JSON.stringify(value));
  }

  db.prepare(
    `DELETE FROM patchdoll_settings
     WHERE key = ?
        OR key LIKE ?`
  ).run("patchdoll.mode", "capabilities.%");
  db.prepare("DELETE FROM patchdoll_settings WHERE key = ?").run("ai.provider");
}

function enumValue(allowed: string[]): (value: JsonValue) => string {
  return (value) => {
    const text = nonEmptyString(value);
    if (!allowed.includes(text)) throw new Error(`Value must be one of ${allowed.join(", ")}`);
    return text;
  };
}

function nonEmptyString(value: JsonValue): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Value must be a non-empty string");
  return value.trim();
}

function positiveInteger(value: JsonValue): number {
  const number = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(number) || number < 1) throw new Error("Value must be a positive integer");
  return number;
}

function booleanValue(value: JsonValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  throw new Error("Value must be a boolean");
}
