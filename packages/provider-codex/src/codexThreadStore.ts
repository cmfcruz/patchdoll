import { chmodSync, existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@patchdoll/core";

const LEGACY_JSON_MIGRATION_KEY = "legacy_slack_codex_threads_json_migrated";

export interface CodexThreadRecord {
  sessionId: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  actor?: string;
  lastEventId?: string;
}

export class CodexThreadStore {
  constructor(
    private readonly db: DatabaseSync,
    legacyJsonPath?: string
  ) {
    initializeDatabase(this.db);

    if (legacyJsonPath) {
      migrateLegacyJsonStore(this.db, legacyJsonPath);
    }
  }

  get(threadKey: string): CodexThreadRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT
          session_id,
          source,
          created_at,
          updated_at,
          actor,
          last_event_id
        FROM codex_threads
        WHERE thread_key = ?`
      )
      .get(threadKey);

    if (!row) {
      return undefined;
    }

    return threadRecordFromRow(row);
  }

  upsert(threadKey: string, record: CodexThreadRecord): void {
    this.db
      .prepare(
        `INSERT INTO codex_threads (
          thread_key,
          session_id,
          source,
          actor,
          last_event_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_key) DO UPDATE SET
          session_id = excluded.session_id,
          source = excluded.source,
          actor = excluded.actor,
          last_event_id = excluded.last_event_id,
          updated_at = excluded.updated_at`
      )
      .run(
        threadKey,
        record.sessionId,
        record.source,
        record.actor ?? null,
        record.lastEventId ?? null,
        record.createdAt,
        record.updatedAt
      );
  }

  close(): void {
    this.db.close();
  }
}

export function openCodexThreadStore(
  dbPath: string,
  legacyJsonPath?: string
): CodexThreadStore {
  const db = new DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
    timeout: 5000
  });
  try {
    chmodSync(dbPath, 0o660);
  } catch {
    // The opener may have group access without owning the SQLite file.
  }

  return new CodexThreadStore(db, legacyJsonPath);
}

function initializeDatabase(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;

    CREATE TABLE IF NOT EXISTS patchdoll_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS codex_threads (
      thread_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      actor TEXT,
      last_event_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_codex_threads_updated_at
      ON codex_threads(updated_at);
  `);
}

function migrateLegacyJsonStore(db: DatabaseSync, legacyJsonPath: string): void {
  if (metaValue(db, LEGACY_JSON_MIGRATION_KEY) === "1") {
    return;
  }

  if (!existsSync(legacyJsonPath)) {
    setMetaValue(db, LEGACY_JSON_MIGRATION_KEY, "1");
    return;
  }

  const store = parseLegacyThreadStore(readFileSync(legacyJsonPath, "utf8"));

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [threadKey, record] of Object.entries(store)) {
      insertLegacyRecord(db, threadKey, record);
    }
    setMetaValue(db, LEGACY_JSON_MIGRATION_KEY, "1");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertLegacyRecord(
  db: DatabaseSync,
  threadKey: string,
  record: CodexThreadRecord
): void {
  db.prepare(
    `INSERT INTO codex_threads (
      thread_key,
      session_id,
      source,
      actor,
      last_event_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_key) DO NOTHING`
  ).run(
    threadKey,
    record.sessionId,
    record.source,
    record.actor ?? null,
    record.lastEventId ?? null,
    record.createdAt,
    record.updatedAt
  );
}

function metaValue(db: DatabaseSync, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM patchdoll_meta WHERE key = ?")
    .get(key);

  return row ? stringValue(row.value) : undefined;
}

function setMetaValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO patchdoll_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

function parseLegacyThreadStore(
  raw: string
): Record<string, CodexThreadRecord> {
  const parsed = JSON.parse(raw) as unknown;
  if (!isJsonObject(parsed) || parsed.version !== 1) {
    throw new Error("legacy thread store has an invalid version");
  }

  const threads = parsed.threads;
  if (!isJsonObject(threads)) {
    throw new Error("legacy thread store has invalid threads");
  }

  const records: Record<string, CodexThreadRecord> = {};
  for (const [key, value] of Object.entries(threads)) {
    if (!isJsonObject(value)) {
      continue;
    }

    const sessionId = stringValue(value.sessionId);
    const source = stringValue(value.source);
    const createdAt = stringValue(value.createdAt);
    const updatedAt = stringValue(value.updatedAt);

    if (!sessionId || !source || !createdAt || !updatedAt) {
      continue;
    }

    records[key] = {
      sessionId,
      source,
      createdAt,
      updatedAt,
      actor: stringValue(value.actor),
      lastEventId: stringValue(value.lastEventId)
    };
  }

  return records;
}

function threadRecordFromRow(
  row: Record<string, unknown>
): CodexThreadRecord | undefined {
  const sessionId = stringValue(row.session_id);
  const source = stringValue(row.source);
  const createdAt = stringValue(row.created_at);
  const updatedAt = stringValue(row.updated_at);

  if (!sessionId || !source || !createdAt || !updatedAt) {
    return undefined;
  }

  return {
    sessionId,
    source,
    createdAt,
    updatedAt,
    actor: stringValue(row.actor),
    lastEventId: stringValue(row.last_event_id)
  };
}

function stringValue(value: unknown): string | undefined {
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
