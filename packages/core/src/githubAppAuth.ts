import { createSign } from "node:crypto";
import { chmodSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TOKEN_CACHE_FLOOR_MS = 60 * 1000;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const PATCHDOLL_SECRETS_PATHS = ["/run/secrets/patchdoll.env", "/run/patchdoll/secrets.env"];

interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

interface InstallationTokenResponse {
  token?: unknown;
  expires_at?: unknown;
  permissions?: unknown;
}

interface InstallationToken {
  token: string;
  expiresAt: string;
  permissions?: string;
}

export async function githubAppEnv(
  stateDbPath: string
): Promise<Record<string, string>> {
  const config = await githubAppConfig();
  if (!config) {
    return {};
  }

  await mkdir(dirname(stateDbPath), { recursive: true, mode: 0o700 });
  const token = await installationToken(stateDbPath, config);
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GH_PROMPT_DISABLED: "1"
  };
}

async function installationToken(
  stateDbPath: string,
  config: GitHubAppConfig
): Promise<string> {
  const cached = cachedInstallationToken(stateDbPath, config.installationId);
  if (cached) {
    return cached;
  }

  const token = await requestInstallationToken(config);
  storeInstallationToken(stateDbPath, config.installationId, token);
  return token.token;
}

function cachedInstallationToken(
  stateDbPath: string,
  installationId: string
): string | undefined {
  const db = openTokenDb(stateDbPath);
  try {
    const now = Date.now();
    const minFetchedAt = new Date(now - TOKEN_CACHE_FLOOR_MS).toISOString();
    const minExpiresAt = new Date(now + TOKEN_EXPIRY_BUFFER_MS).toISOString();
    const row = db
      .prepare(
        `SELECT token
         FROM github_installation_tokens
         WHERE installation_id = ?
           AND fetched_at >= ?
           AND expires_at > ?
         LIMIT 1`
      )
      .get(installationId, minFetchedAt, minExpiresAt);

    if (!row || typeof row !== "object" || !("token" in row)) {
      return undefined;
    }

    return typeof row.token === "string" && row.token ? row.token : undefined;
  } finally {
    db.close();
  }
}

function storeInstallationToken(
  stateDbPath: string,
  installationId: string,
  token: InstallationToken
): void {
  const db = openTokenDb(stateDbPath);
  try {
    db.prepare(
      `INSERT INTO github_installation_tokens (
         installation_id,
         token,
         fetched_at,
         expires_at,
         permissions
       )
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET
         token = excluded.token,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at,
         permissions = excluded.permissions`
    ).run(
      installationId,
      token.token,
      new Date().toISOString(),
      token.expiresAt,
      token.permissions ?? null
    );
  } finally {
    db.close();
  }
}

function openTokenDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5000
  });
  try {
    chmodSync(path, 0o660);
  } catch {
    // The opener may have group access without owning the SQLite file.
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;

    CREATE TABLE IF NOT EXISTS github_installation_tokens (
      installation_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      expires_at TEXT,
      permissions TEXT
    ) STRICT;
  `);

  ensureTokenDbColumn(db, "expires_at", "TEXT");
  ensureTokenDbColumn(db, "permissions", "TEXT");

  return db;
}

function ensureTokenDbColumn(
  db: DatabaseSync,
  name: string,
  definition: string
): void {
  const rows = db.prepare("PRAGMA table_info(github_installation_tokens)").all();
  const exists = rows.some(
    (row) =>
      row &&
      typeof row === "object" &&
      "name" in row &&
      row.name === name
  );
  if (!exists) {
    db.exec(
      `ALTER TABLE github_installation_tokens ADD COLUMN ${name} ${definition}`
    );
  }
}

async function requestInstallationToken(
  config: GitHubAppConfig
): Promise<InstallationToken> {
  const jwt = githubAppJwt(config.appId, config.privateKey);
  const response = await fetch(
    `${GITHUB_API_URL}/app/installations/${encodeURIComponent(
      config.installationId
    )}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": GITHUB_API_VERSION
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub App installation token request failed with HTTP ${response.status}`
    );
  }

  const body = (await response.json()) as InstallationTokenResponse;
  if (typeof body.token !== "string" || !body.token) {
    throw new Error(
      "GitHub App installation token response did not include a token"
    );
  }

  if (typeof body.expires_at !== "string" || !body.expires_at) {
    throw new Error(
      "GitHub App installation token response did not include expires_at"
    );
  }

  return {
    token: body.token,
    expiresAt: body.expires_at,
    permissions: stringifyPermissions(body.permissions)
  };
}

function stringifyPermissions(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return JSON.stringify(value);
}

function githubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId
  });
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(privateKey);

  return `${unsigned}.${base64Url(signature)}`;
}

async function githubAppConfig(): Promise<GitHubAppConfig | undefined> {
  const secrets = await readPatchdollSecrets();
  const appId = secretValue(secrets, "PATCHDOLL_GITHUB_APP_ID");
  const installationId = secretValue(
    secrets,
    "PATCHDOLL_GITHUB_APP_INSTALLATION_ID"
  );
  const privateKeyBase64 = secretValue(
    secrets,
    "PATCHDOLL_GITHUB_APP_PRIVATE_KEY_BASE64"
  );

  if (!appId && !installationId && !privateKeyBase64) {
    return undefined;
  }

  if (!appId || !installationId || !privateKeyBase64) {
    throw new Error(
      "PATCHDOLL_GITHUB_APP_ID, PATCHDOLL_GITHUB_APP_INSTALLATION_ID, and PATCHDOLL_GITHUB_APP_PRIVATE_KEY_BASE64 must all be configured for GitHub App auth"
    );
  }

  const privateKey = decodePrivateKey(privateKeyBase64);
  return { appId, installationId, privateKey };
}

function decodePrivateKey(value: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8").trim();
  } catch {
    throw new Error("PATCHDOLL_GITHUB_APP_PRIVATE_KEY_BASE64 is not valid base64");
  }

  if (!decoded.includes("BEGIN") || !decoded.includes("PRIVATE KEY")) {
    throw new Error(
      "PATCHDOLL_GITHUB_APP_PRIVATE_KEY_BASE64 did not decode to a PEM private key"
    );
  }

  return decoded;
}

async function readPatchdollSecrets(): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};

  for (const path of PATCHDOLL_SECRETS_PATHS) {
    try {
      Object.assign(secrets, parseEnvFile(await readFile(path, "utf8")));
    } catch (error) {
      // Skip paths that are absent or that this process is not permitted to
      // read. The worker-private stash (/run/patchdoll/secrets.env) is owned
      // root:0600 and is intentionally unreadable by the patchdoll-group
      // server process; the shared App credentials live in the group-readable
      // /run/secrets/patchdoll.env instead.
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EACCES")) {
        continue;
      }
      throw error;
    }
  }

  return secrets;
}

function secretValue(
  secrets: Record<string, string>,
  name: string
): string | undefined {
  const value = (secrets[name] ?? process.env[name])?.trim();
  return value ? value : undefined;
}

function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    values[match[1]!] = parseEnvValue(match[2]!);
  }
  return values;
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function base64UrlJson(value: Record<string, string | number>): string {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
