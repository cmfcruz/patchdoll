import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PROVIDER = "claude";

export interface ClaudeThreadRecord {
  sessionId: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  actor?: string;
  lastEventId?: string;
}

export class ClaudeThreadStore {
  constructor(private readonly db: DatabaseSync) {
    initializeDatabase(this.db);
  }

  get(threadKey: string): ClaudeThreadRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT
          session_id,
          source,
          created_at,
          updated_at,
          actor,
          last_event_id
        FROM provider_threads
        WHERE provider = ? AND thread_key = ?`
      )
      .get(PROVIDER, threadKey);

    if (!row) {
      return undefined;
    }

    return threadRecordFromRow(row);
  }

  upsert(threadKey: string, record: ClaudeThreadRecord): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO provider_threads (
            provider,
            thread_key,
            session_id,
            source,
            actor,
            last_event_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, thread_key) DO UPDATE SET
            session_id = excluded.session_id,
            source = excluded.source,
            actor = excluded.actor,
            last_event_id = excluded.last_event_id,
            updated_at = excluded.updated_at`
        )
        .run(
          PROVIDER,
          threadKey,
          record.sessionId,
          record.source,
          record.actor ?? null,
          record.lastEventId ?? null,
          record.createdAt,
          record.updatedAt
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function openClaudeThreadStore(dbPath: string): ClaudeThreadStore {
  const db = new DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
    timeout: 5000
  });
  try {
    chmodSync(dbPath, 0o660);
  } catch {
    // The opener may have group access without owning the SQLite file.
  }

  return new ClaudeThreadStore(db);
}

function initializeDatabase(db: DatabaseSync): void {
  // The `provider_threads` table is shared with the Codex provider in the same
  // SQLite file; these statements are idempotent so either provider can be the
  // one that first creates it.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;

    CREATE TABLE IF NOT EXISTS provider_threads (
      provider TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      actor TEXT,
      last_event_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, thread_key)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_provider_threads_updated_at
      ON provider_threads(updated_at);
  `);
}

function threadRecordFromRow(
  row: Record<string, unknown>
): ClaudeThreadRecord | undefined {
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
