import { createSign } from "node:crypto";
import { chmodSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TOKEN_FRESHNESS_MS = 30 * 60 * 1000;
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const PATCHDOLL_SECRETS_PATH = "/run/secrets/patchdoll.env";

interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

interface InstallationTokenResponse {
  token?: unknown;
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
  return token;
}

function cachedInstallationToken(
  stateDbPath: string,
  installationId: string
): string | undefined {
  const db = openTokenDb(stateDbPath);
  try {
    const minFetchedAt = new Date(Date.now() - TOKEN_FRESHNESS_MS).toISOString();
    const row = db
      .prepare(
        `SELECT token
         FROM github_installation_tokens
         WHERE installation_id = ? AND fetched_at >= ?
         LIMIT 1`
      )
      .get(installationId, minFetchedAt);

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
  token: string
): void {
  const db = openTokenDb(stateDbPath);
  try {
    db.prepare(
      `INSERT INTO github_installation_tokens (installation_id, token, fetched_at)
       VALUES (?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET
         token = excluded.token,
         fetched_at = excluded.fetched_at`
    ).run(installationId, token, new Date().toISOString());
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
      fetched_at TEXT NOT NULL
    ) STRICT;
  `);

  return db;
}

async function requestInstallationToken(
  config: GitHubAppConfig
): Promise<string> {
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

  return body.token;
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
  try {
    return parseEnvFile(await readFile(PATCHDOLL_SECRETS_PATH, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
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
