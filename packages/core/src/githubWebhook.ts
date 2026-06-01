import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readBody, sendJson } from "./http.js";
import { stringifyLogJson } from "./log.js";
import { patchdollSecret } from "./secrets.js";
import { postSlackNotification } from "./slackNotify.js";
import type { JsonValue, NormalizedEvent } from "./types.js";

const DEFAULT_STATE_DB_PATH = "/patchdoll/state/patchdoll.sqlite";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_EVENTS = new Set([
  "issues.opened",
  "pull_request.opened",
  "issue_comment.created",
  "issue_comment.edited",
  "pull_request_review_comment.created",
  "pull_request_review_comment.edited"
]);

interface GithubWebhookHeaders {
  deliveryId: string;
  eventName: string;
  signature: string;
}

interface GithubWebhookConfig {
  maxBodyBytes: number;
  notifySlackChannel?: string;
  allowedRepos?: Set<string>;
  stateDbPath: string;
}

interface NormalizedGithubWebhook {
  event: NormalizedEvent;
  repo: string;
  eventName: string;
  action: string;
  eventKey: string;
  number?: number;
  htmlUrl?: string;
  comment?: GithubWebhookComment;
}

interface GithubWebhookTarget {
  kind: "Issue" | "PR";
  number: number;
  title: string;
  htmlUrl?: string;
}

interface GithubWebhookComment {
  htmlUrl?: string;
  excerpt?: string;
}

export async function handleGithubWebhook(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const config = githubWebhookConfig();

  let body: Buffer;
  try {
    body = await readBody(request, { maxBytes: config.maxBodyBytes });
  } catch (error) {
    sendJson(response, 413, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const headers = githubWebhookHeaders(request);
  if (!headers) {
    logGithubWebhookTrace("GitHub webhook rejected", {
      reason: "missing_required_headers",
      hasDeliveryId: Boolean(headerString(request, "x-github-delivery")),
      hasEventName: Boolean(headerString(request, "x-github-event")),
      hasSignature: Boolean(headerString(request, "x-hub-signature-256"))
    });
    sendJson(response, 400, {
      ok: false,
      error: "Missing required GitHub webhook headers"
    });
    return;
  }

  logGithubWebhookTrace("GitHub webhook received", {
    deliveryId: headers.deliveryId,
    githubEvent: headers.eventName,
    bodyBytes: body.length
  });

  const secret = await githubWebhookSecret();
  if (!secret) {
    logGithubWebhookTrace("GitHub webhook rejected", {
      deliveryId: headers.deliveryId,
      githubEvent: headers.eventName,
      reason: "secret_not_configured"
    });
    sendJson(response, 503, {
      ok: false,
      error: "GitHub webhook secret is not configured"
    });
    return;
  }

  if (!verifyGithubSignature(body, headers.signature, secret)) {
    logGithubWebhookTrace("GitHub webhook rejected", {
      deliveryId: headers.deliveryId,
      githubEvent: headers.eventName,
      reason: "invalid_signature"
    });
    sendJson(response, 401, {
      ok: false,
      error: "Invalid GitHub webhook signature"
    });
    return;
  }

  let payload: JsonValue;
  try {
    payload = parseJson(body);
  } catch {
    logGithubWebhookTrace("GitHub webhook rejected", {
      deliveryId: headers.deliveryId,
      githubEvent: headers.eventName,
      reason: "invalid_json"
    });
    sendJson(response, 400, {
      ok: false,
      error: "Invalid GitHub webhook JSON payload"
    });
    return;
  }

  if (headers.eventName === "ping") {
    rememberDelivery(config.stateDbPath, headers, payload);
    logGithubWebhookTrace("GitHub webhook accepted", {
      deliveryId: headers.deliveryId,
      githubEvent: headers.eventName,
      status: "ping"
    });
    sendJson(response, 200, {
      ok: true,
      event: "ping"
    });
    return;
  }

  const normalized = normalizeGithubWebhook(headers, payload);
  if (!normalized) {
    rememberDelivery(config.stateDbPath, headers, payload);
    logGithubWebhookTrace("GitHub webhook ignored", {
      deliveryId: headers.deliveryId,
      githubEvent: headers.eventName,
      ...githubPayloadLogSummary(payload),
      reason: "unsupported_event"
    });
    sendJson(response, 202, {
      ok: true,
      ignored: true,
      reason: "unsupported_event"
    });
    return;
  }

  if (isDuplicateDelivery(config.stateDbPath, headers, normalized)) {
    logGithubWebhookTrace("GitHub webhook ignored", {
      ...githubNormalizedLogSummary(normalized),
      reason: "duplicate_delivery"
    });
    sendJson(response, 202, {
      ok: true,
      duplicate: true
    });
    return;
  }

  if (!isAllowedGithubEvent(config, normalized)) {
    logGithubWebhookTrace("GitHub webhook ignored", {
      ...githubNormalizedLogSummary(normalized),
      reason: "disallowed_event"
    });
    sendJson(response, 202, {
      ok: true,
      ignored: true,
      reason: "disallowed_event"
    });
    return;
  }

  if (!config.notifySlackChannel) {
    logGithubWebhookWarning("GitHub webhook Slack notification channel is not configured", normalized);
    logGithubWebhookTrace("GitHub webhook ignored", {
      ...githubNormalizedLogSummary(normalized),
      reason: "slack_channel_not_configured"
    });
    sendJson(response, 202, {
      ok: true,
      ignored: true,
      reason: "slack_channel_not_configured"
    });
    return;
  }

  try {
    await postSlackNotification({
      channel: config.notifySlackChannel,
      text: githubSlackMessage(normalized)
    });
  } catch (error) {
    logGithubWebhookTrace("GitHub webhook Slack notification failed", {
      ...githubNormalizedLogSummary(normalized),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }

  logGithubWebhookTrace("GitHub webhook notified Slack", githubNormalizedLogSummary(normalized));

  sendJson(response, 202, {
    ok: true,
    event: normalized.event.kind,
    deliveryId: headers.deliveryId
  });
}

function githubWebhookConfig(): GithubWebhookConfig {
  return {
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    notifySlackChannel: nonEmptyString(process.env.PATCHDOLL_GITHUB_NOTIFY_SLACK_CHANNEL),
    allowedRepos: optionalSet(process.env.PATCHDOLL_GITHUB_WEBHOOK_TRACKED_REPOS, normalizeRepoName),
    stateDbPath: process.env.PATCHDOLL_STATE_DB_PATH || DEFAULT_STATE_DB_PATH
  };
}

async function githubWebhookSecret(): Promise<string | undefined> {
  rejectSecretEnv("PATCHDOLL_GITHUB_WEBHOOK_SECRET");
  return patchdollSecret("PATCHDOLL_GITHUB_WEBHOOK_SECRET");
}

function githubWebhookHeaders(
  request: IncomingMessage
): GithubWebhookHeaders | undefined {
  const deliveryId = headerString(request, "x-github-delivery");
  const eventName = headerString(request, "x-github-event");
  const signature = headerString(request, "x-hub-signature-256");

  if (!deliveryId || !eventName || !signature) {
    return undefined;
  }

  return { deliveryId, eventName, signature };
}

function verifyGithubSignature(
  body: Buffer,
  signatureHeader: string,
  secret: string
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(signatureHeader, "utf8");

  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function parseJson(body: Buffer): JsonValue {
  if (body.length === 0) {
    return {};
  }
  return JSON.parse(body.toString("utf8")) as JsonValue;
}

function normalizeGithubWebhook(
  headers: GithubWebhookHeaders,
  payload: JsonValue
): NormalizedGithubWebhook | undefined {
  const action = jsonString(readJsonPath(payload, "$.action")) ?? "";
  const repo = normalizeRepoName(jsonString(readJsonPath(payload, "$.repository.full_name")) ?? "");
  const sender = jsonString(readJsonPath(payload, "$.sender.login"));
  const target = githubTarget(headers.eventName, payload);
  const comment = githubComment(headers.eventName, payload);
  if (!action || !repo || !target) {
    return undefined;
  }

  const eventKey = normalizeEventKey(`${headers.eventName}.${action}`);
  const title = `${target.kind} #${target.number}: ${target.title}`;

  return {
    repo,
    eventName: headers.eventName,
    action,
    eventKey,
    number: target.number,
    htmlUrl: target.htmlUrl,
    comment,
    event: {
      id: headers.deliveryId || randomUUID(),
      source: "github",
      kind: `github.${eventKey}`,
      actor: sender,
      title,
      body: githubEventBody({ repo, eventKey, sender, target }),
      url: target.htmlUrl,
      receivedAt: new Date().toISOString(),
      raw: payload,
      metadata: {
        deliveryId: headers.deliveryId,
        repository: repo,
        githubEvent: headers.eventName,
        action,
        number: target.number,
        htmlUrl: target.htmlUrl ?? null,
        commentHtmlUrl: comment?.htmlUrl ?? null
      }
    }
  };
}

function githubTarget(
  eventName: string,
  payload: JsonValue
): GithubWebhookTarget | undefined {
  const root = githubTargetRoot(eventName, payload);

  if (!isJsonObject(root)) {
    return undefined;
  }

  const number = jsonNumber(root.number);
  const title = jsonString(root.title);
  if (number === undefined || !title) {
    return undefined;
  }

  return {
    kind: githubTargetKind(eventName, root),
    number,
    title,
    htmlUrl: githubTargetHtmlUrl(eventName, payload, root)
  };
}

function githubTargetRoot(eventName: string, payload: JsonValue): JsonValue {
  if (eventName === "issues" || eventName === "issue_comment") {
    return readJsonPath(payload, "$.issue");
  }
  if (eventName === "pull_request" || eventName === "pull_request_review_comment") {
    return readJsonPath(payload, "$.pull_request");
  }
  return null;
}

function githubTargetKind(eventName: string, root: Record<string, JsonValue>): "Issue" | "PR" {
  if (eventName === "pull_request" || eventName === "pull_request_review_comment") {
    return "PR";
  }
  return isJsonObject(root.pull_request) ? "PR" : "Issue";
}

function githubTargetHtmlUrl(
  eventName: string,
  payload: JsonValue,
  root: Record<string, JsonValue>
): string | undefined {
  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    return jsonString(readJsonPath(payload, "$.comment.html_url")) ?? jsonString(root.html_url);
  }
  return jsonString(root.html_url);
}

function githubComment(eventName: string, payload: JsonValue): GithubWebhookComment | undefined {
  if (eventName !== "issue_comment" && eventName !== "pull_request_review_comment") {
    return undefined;
  }

  const body = jsonString(readJsonPath(payload, "$.comment.body"));
  const htmlUrl = jsonString(readJsonPath(payload, "$.comment.html_url"));
  const excerpt = body ? commentExcerpt(body, 300) : undefined;

  if (!htmlUrl && !excerpt) {
    return undefined;
  }

  return { htmlUrl, excerpt };
}

function githubEventBody(input: {
  repo: string;
  eventKey: string;
  sender?: string;
  target: { number: number; title: string; htmlUrl?: string };
}): string {
  const lines = [
    `Repository: ${input.repo}`,
    `Event: ${input.eventKey}`,
    `Actor: ${input.sender ?? "unknown"}`,
    `Number: ${input.target.number}`,
    `Title: ${input.target.title}`
  ];

  if (input.target.htmlUrl) {
    lines.push(`URL: ${input.target.htmlUrl}`);
  }

  return lines.join("\n");
}

function githubSlackMessage(normalized: NormalizedGithubWebhook): string {
  const title = normalized.event.title ?? normalized.event.kind;
  const link = normalized.htmlUrl
    ? `<${escapeSlackLinkUrl(normalized.htmlUrl)}|${escapeSlackText(title)}>`
    : escapeSlackText(title);
  const actor = normalized.event.actor ?? "unknown";
  const lines = [`${link}`, `Actor: ${escapeSlackText(actor)}`];

  if (normalized.comment?.excerpt) {
    lines.push(`Comment: ${escapeSlackText(normalized.comment.excerpt)}`);
  }

  return lines.join("\n");
}

function isDuplicateDelivery(
  dbPath: string,
  headers: GithubWebhookHeaders,
  normalized: NormalizedGithubWebhook
): boolean {
  const db = openGithubWebhookDb(dbPath);
  try {
    const result = db.prepare(
      `INSERT OR IGNORE INTO github_webhook_deliveries (
        delivery_id,
        event_name,
        action,
        repository,
        received_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      headers.deliveryId,
      normalized.eventName,
      normalized.action,
      normalized.repo,
      new Date().toISOString()
    );

    return result.changes === 0;
  } finally {
    db.close();
  }
}

function rememberDelivery(
  dbPath: string,
  headers: GithubWebhookHeaders,
  payload: JsonValue
): void {
  const repo = normalizeRepoName(jsonString(readJsonPath(payload, "$.repository.full_name")) ?? "");
  const action = jsonString(readJsonPath(payload, "$.action")) ?? "";
  const db = openGithubWebhookDb(dbPath);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO github_webhook_deliveries (
        delivery_id,
        event_name,
        action,
        repository,
        received_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(headers.deliveryId, headers.eventName, action, repo, new Date().toISOString());
  } finally {
    db.close();
  }
}

function openGithubWebhookDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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

    CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      action TEXT NOT NULL,
      repository TEXT NOT NULL,
      received_at TEXT NOT NULL
    ) STRICT;
  `);

  return db;
}

function isAllowedGithubEvent(
  config: GithubWebhookConfig,
  normalized: NormalizedGithubWebhook
): boolean {
  const repoAllowed = !config.allowedRepos || config.allowedRepos.has(normalized.repo);
  return repoAllowed && ALLOWED_EVENTS.has(normalized.eventKey);
}

function logGithubWebhookWarning(
  message: string,
  normalized: NormalizedGithubWebhook
): void {
  console.warn(
    stringifyLogJson({
      level: "warn",
      source: "patchdoll.githubWebhook",
      message,
      event: normalized.eventKey,
      repository: normalized.repo,
      deliveryId: normalized.event.id
    })
  );
}

function logGithubWebhookTrace(
  message: string,
  fields: Record<string, JsonValue | undefined> = {}
): void {
  if (process.env.PATCHDOLL_LOG_LEVEL?.trim().toLowerCase() !== "trace") {
    return;
  }

  console.log(
    stringifyLogJson({
      level: "trace",
      source: "patchdoll.githubWebhook",
      message,
      ...fields
    })
  );
}

function githubNormalizedLogSummary(
  normalized: NormalizedGithubWebhook
): Record<string, JsonValue> {
  return {
    deliveryId: normalized.event.id,
    repository: normalized.repo,
    githubEvent: normalized.eventName,
    action: normalized.action,
    event: normalized.eventKey,
    number: normalized.number ?? null,
    htmlUrl: normalized.htmlUrl ?? null,
    commentHtmlUrl: normalized.comment?.htmlUrl ?? null
  };
}

function githubPayloadLogSummary(payload: JsonValue): Record<string, JsonValue> {
  return {
    repository: normalizeRepoName(jsonString(readJsonPath(payload, "$.repository.full_name")) ?? ""),
    action: jsonString(readJsonPath(payload, "$.action")) ?? "",
    number:
      jsonNumber(readJsonPath(payload, "$.issue.number")) ??
      jsonNumber(readJsonPath(payload, "$.pull_request.number")) ??
      null
  };
}

function headerString(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function readJsonPath(value: JsonValue, path: string): JsonValue {
  if (!path.startsWith("$.")) {
    return null;
  }

  const parts = path.slice(2).split(".").filter(Boolean);
  let current: JsonValue | undefined = value;

  for (const part of parts) {
    if (!isJsonObject(current)) {
      return null;
    }
    current = current[part];
  }

  return current ?? null;
}

function jsonString(value: JsonValue): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function jsonNumber(value: JsonValue): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalSet(
  value: string | undefined,
  normalize: (item: string) => string
): Set<string> | undefined {
  const items = parseStringList(value).map(normalize).filter(Boolean);
  return items.length ? new Set(items) : undefined;
}

function parseStringList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRepoName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeEventKey(value: string): string {
  return value.trim().toLowerCase();
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function commentExcerpt(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  return `${chars.slice(0, maxChars).join("")}…`;
}

function rejectSecretEnv(name: string): void {
  if (process.env[name]) {
    throw new Error(`${name} must be configured in /run/secrets/patchdoll.env`);
  }
}

function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeSlackLinkUrl(value: string): string {
  return value.replace(/>/g, "%3E").replace(/\|/g, "%7C");
}
