const { readFileSync } = require("node:fs");
const http = require("node:http");
const { App } = require("@slack/bolt");

const patchdollSecretsPaths = ["/run/secrets/patchdoll.env", "/run/patchdoll/secrets.env"];
const patchdollSecretsPath = patchdollSecretsPaths.join(" or ");
const patchdollSocketPath = "/run/patchdoll/core.sock";
const patchdollPath = "/webhooks/slack";
const commandName = process.env.PATCHDOLL_SLACK_COMMAND || "/patchdoll";
const maxSlackTextLength = 3900;
// Cap for the single edited progress/draft message. Large enough for a live
// token draft (DRAFT_TAIL_LIMIT in the Claude provider) plus its header, while
// staying under Slack's per-message text limit.
const maxProgressTextLength = 1600;
const initialProgressText = "hmm?";
const requestFailurePrefix = "That's annoying, but manageable";

const app = new App({
  token: requiredSecret("PATCHDOLL_SLACK_BOT_TOKEN"),
  socketMode: true,
  appToken: requiredSecret("PATCHDOLL_SLACK_APP_TOKEN")
});

app.command(commandName, async ({ command, ack, respond, client }) => {
  await ack();
  const progress = createProgressUpdater({
    update: (text) =>
      respond({
        response_type: "in_channel",
        replace_original: true,
        text
      }),
    publishAdditional: (text) =>
      respond({
        response_type: "in_channel",
        text
      })
  });

  try {
    await respond({
      response_type: "in_channel",
      text: initialProgressText
    });

    const threadContext = await fetchSlackThreadContext(client, {
      channelId: command.channel_id,
      threadTs: command.thread_ts || command.message_ts,
      requestTs: command.message_ts
    });

    const result = await callPatchdoll({
      type: "slack.command",
      title: command.command,
      body: command.text || "",
      actor: command.user_name || command.user_id,
      metadata: {
        channelId: command.channel_id,
        teamId: command.team_id,
        threadTs: command.thread_ts || command.message_ts,
        messageTs: command.message_ts,
        triggerId: command.trigger_id,
        threadContext
      }
    }, {
      onProgress: progress.update
    });

    await progress.final(extractReply(result));
  } catch (error) {
    await progress.final(`${requestFailurePrefix}: ${messageOf(error)}`);
  }
});

app.event("app_mention", async ({ event, say, client }) => {
  app.logger.info("Forwarding Slack app_mention event to Patchdoll");
  const threadTs = event.thread_ts || event.ts;
  const threadContext = await fetchSlackThreadContext(client, {
    channelId: event.channel,
    threadTs,
    requestTs: event.ts,
    channelType: event.channel_type
  });
  const initial = await say({
    text: initialProgressText,
    thread_ts: threadTs
  });
  const progress = createProgressUpdater({
    update: (text) =>
      client.chat.update({
        channel: event.channel,
        ts: initial.ts,
        text
      }),
    publishAdditional: (text) =>
      client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text
      })
  });

  try {
    const result = await callPatchdoll({
      type: "slack.app_mention",
      title: "Slack app mention",
      body: stripBotMention(event.text || ""),
      actor: event.user,
      url: slackMessageUrl(event),
      metadata: {
        channelId: event.channel,
        eventTs: event.ts,
        threadTs,
        threadContext
      }
    }, {
      onProgress: progress.update
    });

    await progress.final(extractReply(result));
  } catch (error) {
    await progress.final(`${requestFailurePrefix}: ${messageOf(error)}`);
  }
});

app.message(async ({ message, say, client }) => {
  if (!isDirectUserMessage(message)) {
    return;
  }

  app.logger.info("Forwarding Slack direct message event to Patchdoll");
  const threadTs = message.thread_ts || message.ts;
  const threadContext = await fetchSlackThreadContext(client, {
    channelId: message.channel,
    threadTs,
    requestTs: message.ts,
    channelType: message.channel_type
  });
  const initial = await say({
    text: initialProgressText,
    thread_ts: threadTs
  });
  const progress = createProgressUpdater({
    update: (text) =>
      client.chat.update({
        channel: message.channel,
        ts: initial.ts,
        text
      }),
    publishAdditional: (text) =>
      client.chat.postMessage({
        channel: message.channel,
        thread_ts: threadTs,
        text
      })
  });

  try {
    const result = await callPatchdoll({
      type: "slack.direct_message",
      title: "Slack direct message",
      body: message.text || "",
      actor: message.user,
      url: slackMessageUrl(message),
      metadata: {
        channelId: message.channel,
        eventTs: message.ts,
        threadTs,
        teamId: message.team,
        threadContext
      }
    }, {
      onProgress: progress.update
    });

    await progress.final(extractReply(result));
  } catch (error) {
    await progress.final(`${requestFailurePrefix}: ${messageOf(error)}`);
  }
});

(async () => {
  try {
    await app.start();
    app.logger.info("Patchdoll Slack Bolt bridge started");
  } catch (error) {
    app.logger.error(
      logSafeText(`Patchdoll Slack Bolt bridge failed: ${messageOf(error)}`)
    );
    process.exit(1);
  }
})();

let shuttingDown = false;

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  app.logger.info(`Stopping Patchdoll Slack Bolt bridge after ${signal}`);

  const forceExit = setTimeout(() => {
    app.logger.error("Patchdoll Slack Bolt bridge shutdown timed out");
    process.exit(1);
  }, 5000);
  forceExit.unref();

  try {
    await app.stop();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    app.logger.error(
      logSafeText(
        `Patchdoll Slack Bolt bridge shutdown failed: ${messageOf(error)}`
      )
    );
    process.exit(1);
  }
}

async function callPatchdoll(payload, options = {}) {
  const body = JSON.stringify(payload);

  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: patchdollSocketPath,
        path: patchdollPath,
        method: "POST",
        headers: {
          "accept": "application/x-ndjson",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        }
      },
      async (response) => {
        try {
          if (isNdjsonResponse(response)) {
            resolve(await readPatchdollStream(response, options.onProgress));
            return;
          }

          const text = await readResponseText(response);
          if (!isOkResponse(response)) {
            reject(new Error(`HTTP ${response.statusCode}: ${text}`));
            return;
          }

          resolve(text ? JSON.parse(text) : {});
        } catch (error) {
          reject(error);
        }
      }
    );

    request.on("error", reject);
    request.end(body);
  });
}

async function readPatchdollStream(response, onProgress) {
  let result;
  let buffer = "";
  const decoder = new TextDecoder();

  if (!isOkResponse(response)) {
    throw new Error(`HTTP ${response.statusCode}: ${await readResponseText(response)}`);
  }

  for await (const chunk of response) {
    buffer += decoder.decode(chunk, { stream: true });
    const parsed = await readNdjsonLines(buffer, onProgress);
    buffer = parsed.remainder;
    if (parsed.result) {
      result = parsed.result;
    }
  }

  buffer += decoder.decode();
  const parsed = await readNdjsonLines(`${buffer}\n`, onProgress);
  return parsed.result || result || {};
}

async function readNdjsonLines(buffer, onProgress) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() || "";
  let result;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const event = JSON.parse(trimmed);
    if (event.type === "progress" && onProgress) {
      await onProgress(progressText(event.event));
    } else if (event.type === "result") {
      result = event;
    } else if (event.type === "error") {
      throw new Error(event.error || "Patchdoll stream failed");
    }
  }

  return { remainder, result };
}

function isNdjsonResponse(response) {
  const contentType = response.headers["content-type"] || "";
  return String(contentType).toLowerCase().includes("application/x-ndjson");
}

async function readResponseText(response) {
  let text = "";
  response.setEncoding("utf8");
  for await (const chunk of response) {
    text += chunk;
  }
  return text;
}

function isOkResponse(response) {
  return response.statusCode >= 200 && response.statusCode < 300;
}

function createProgressUpdater(delivery) {
  const minIntervalMs = 2500;
  let lastText;
  let lastSentAt = 0;
  let pending;
  let flushTimer;

  async function send(text, options = {}) {
    const force = Boolean(options.force);
    const message = options.final
      ? sanitizeFinalSlackText(text)
      : progressMessageText(text);
    if (!message) {
      return;
    }

    if (message === lastText) {
      return;
    }

    const now = Date.now();
    if (!force && now - lastSentAt < minIntervalMs) {
      pending = message;
      scheduleFlush(minIntervalMs - (now - lastSentAt));
      return;
    }

    clearFlush();
    pending = undefined;
    lastText = message;
    lastSentAt = now;
    await delivery.update(message);
  }

  function scheduleFlush(delayMs) {
    if (flushTimer) {
      return;
    }

    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      if (pending) {
        send(pending).catch(() => undefined);
      }
    }, Math.max(0, delayMs));
  }

  function clearFlush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }

  return {
    update(text) {
      return send(text);
    },
    async final(text) {
      clearFlush();
      const chunks = splitSlackText(sanitizeFinalSlackText(text));
      const first = chunks.shift();
      if (!first) {
        return;
      }

      await send(first, { force: true, final: true });
      for (const chunk of chunks) {
        await delivery.publishAdditional(chunk);
      }
    }
  };
}

function progressMessageText(text) {
  return sanitizeProgressSlackText(text);
}

function progressText(event) {
  if (isLowSignalProgressEvent(event)) {
    return "";
  }

  if (!event || !event.message) {
    return "Patchdoll is working...";
  }

  const metadata = event.metadata && typeof event.metadata === "object"
    ? event.metadata
    : {};
  // Live token draft: prefix a header so the rolling text reads as an
  // in-progress draft rather than a finished reply.
  if (String(metadata.kind || "").toLowerCase() === "text_delta") {
    return `✎ Claude is drafting…\n${String(event.message)}`;
  }

  return String(event.message);
}

function isLowSignalProgressEvent(event) {
  if (!event || typeof event !== "object") {
    return false;
  }

  const message = String(event.message || "").trim().toLowerCase();
  const metadata = event.metadata && typeof event.metadata === "object"
    ? event.metadata
    : {};
  const kind = String(metadata.kind || "").toLowerCase();

  return (
    message === "patchdoll accepted the request." ||
    kind === "event_msg.token_count" ||
    kind === "response_item.reasoning" ||
    kind === "response_item.function_call_output"
  );
}

function sanitizeProgressSlackText(text) {
  return String(text || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxProgressTextLength);
}

function sanitizeFinalSlackText(text) {
  return normalizeSlackText(text);
}

function normalizeSlackText(text) {
  return String(text || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
}

function splitSlackText(text) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxSlackTextLength) {
    const splitAt = slackTextSplitIndex(remaining, maxSlackTextLength);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function slackTextSplitIndex(text, limit) {
  const candidates = [
    text.lastIndexOf("\n\n", limit),
    text.lastIndexOf("\n", limit),
    text.lastIndexOf(" ", limit)
  ].filter((index) => index > Math.floor(limit * 0.6));

  return candidates.length ? Math.max(...candidates) : limit;
}

function extractReply(result) {
  const reply = (
    result &&
    result.result &&
    result.result.aiResult &&
    result.result.aiResult.reply
  ) || "Patchdoll handled the request.";
  const actionSummary = formatActionSummary(result && result.result);

  return actionSummary ? `${reply}\n\n${actionSummary}` : reply;
}

function formatActionSummary(result) {
  if (!result) {
    return "";
  }

  const denied = (result.decisions || [])
    .filter((decision) => !decision.allowed)
    .filter((decision) => decision.action && decision.action.type !== "chat.reply")
    .map((decision) => `- denied ${decision.action.type}: ${decision.reason || "not allowed"}`);
  const executed = (result.executed || [])
    .filter((execution) => execution.action && execution.action.type !== "chat.reply")
    .map((execution) =>
      `- ${execution.ok ? "applied" : "failed"} ${execution.action.type}: ${execution.message}`
    );
  const lines = [...executed, ...denied];

  return lines.length ? `Patchdoll actions:\n${lines.join("\n")}` : "";
}

function stripBotMention(text) {
  return text.replace(/^<@[A-Z0-9]+>\s*/i, "").trim();
}

async function fetchSlackThreadContext(client, input) {
  const channelId = input.channelId;
  const threadTs = input.threadTs;
  if (!channelId || !threadTs) {
    return {
      available: false,
      reason: "missing_channel_or_thread"
    };
  }

  const maxMessages = parsePositiveInteger(
    process.env.PATCHDOLL_SLACK_THREAD_MAX_MESSAGES,
    100
  );
  if (maxMessages <= 0) {
    return {
      available: false,
      reason: "disabled"
    };
  }

  const messages = [];
  let cursor;
  let hasMore;

  try {
    do {
      const remaining = maxMessages - messages.length;
      const response = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: Math.min(remaining, 200),
        cursor
      });

      for (const message of response.messages || []) {
        messages.push(formatSlackThreadMessage(message));
        if (messages.length >= maxMessages) {
          break;
        }
      }

      cursor = response.response_metadata && response.response_metadata.next_cursor;
      hasMore = Boolean(response.has_more || cursor);
    } while (cursor && messages.length < maxMessages);

    return {
      available: true,
      channelId,
      threadTs,
      requestTs: input.requestTs,
      messageCount: messages.length,
      truncated: Boolean(hasMore),
      messages
    };
  } catch (error) {
    const diagnostic = slackThreadFetchDiagnostic(error, input);
    app.logger.warn({
      message: "slack thread transcript fetch failed",
      method: "conversations.replies",
      slackErrorCode: diagnostic.errorCode,
      reason: diagnostic.reason,
      requiredScopes: diagnostic.requiredScopes,
      providedScopes: diagnostic.providedScopes,
      channelId: redactSlackIdentifier(channelId),
      threadTs: redactSlackIdentifier(threadTs),
      requestTs: redactSlackIdentifier(input.requestTs),
      retryCount: 0,
      botChannelAccess: diagnostic.botChannelAccess
    });

    return {
      available: false,
      channelId,
      threadTs,
      reason: diagnostic.reason,
      error: diagnostic.safeError,
      requiredScopes: diagnostic.requiredScopes,
      remediation: diagnostic.remediation
    };
  }
}

function slackThreadFetchDiagnostic(error, input = {}) {
  const errorCode = slackApiErrorCode(error);
  const reason = slackThreadFailureReason(error, errorCode);
  const requiredScopes = reason === "slack_missing_scope"
    ? slackThreadRequiredScopes(error, input)
    : undefined;
  const providedScopes = reason === "slack_missing_scope"
    ? slackErrorScopes(error && error.data && error.data.provided)
    : undefined;
  const remediation = reason === "slack_missing_scope"
    ? "Add the required Bot Token Scope(s) in Slack OAuth & Permissions, reinstall the app to the workspace, then restart Patchdoll if the bot token changed."
    : undefined;

  return {
    errorCode,
    reason,
    requiredScopes,
    providedScopes,
    remediation,
    botChannelAccess: reason === "slack_channel_not_accessible"
      ? "denied_or_not_joined"
      : "unknown",
    safeError: errorCode
      ? `${errorCode}: ${messageOf(error).slice(0, 500)}`
      : messageOf(error).slice(0, 500)
  };
}

function slackThreadFailureReason(error, errorCode) {
  if (
    errorCode === "ratelimited" ||
    error && error.code === "slack_webapi_rate_limited_error" ||
    error && error.statusCode === 429
  ) {
    return "slack_rate_limited";
  }

  if (errorCode === "missing_scope") {
    return "slack_missing_scope";
  }

  if (
    errorCode === "not_in_channel" ||
    errorCode === "channel_not_found" ||
    errorCode === "no_permission"
  ) {
    return "slack_channel_not_accessible";
  }

  if (
    errorCode === "invalid_auth" ||
    errorCode === "not_authed" ||
    errorCode === "token_revoked" ||
    errorCode === "account_inactive"
  ) {
    return "slack_auth_error";
  }

  if (
    errorCode === "internal_error" ||
    errorCode === "fatal_error" ||
    errorCode === "service_unavailable" ||
    errorCode === "request_timeout" ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(error && error.code)
  ) {
    return "slack_transient_error";
  }

  return errorCode ? `slack_api_error:${errorCode}` : "slack_api_error:unknown";
}

function slackThreadRequiredScopes(error, input) {
  const fromSlack = slackErrorScopes(error && error.data && error.data.needed);
  if (fromSlack.length) {
    return fromSlack;
  }

  const inferred = slackThreadScopesForChannel(
    input && input.channelId,
    input && input.channelType
  );
  return inferred.length ? inferred : [
    "channels:history",
    "groups:history",
    "im:history",
    "mpim:history"
  ];
}

function slackThreadScopesForChannel(channelId, channelType) {
  const type = String(channelType || "").toLowerCase();
  if (["channel", "public_channel", "public"].includes(type)) {
    return ["channels:history"];
  }
  if (["group", "private_channel", "private"].includes(type)) {
    return ["groups:history"];
  }
  if (type === "im") {
    return ["im:history"];
  }
  if (type === "mpim") {
    return ["mpim:history"];
  }

  const id = String(channelId || "");
  if (id.startsWith("C")) {
    return ["channels:history"];
  }
  if (id.startsWith("D")) {
    return ["im:history"];
  }
  if (id.startsWith("G")) {
    return ["groups:history", "mpim:history"];
  }

  return [];
}

function slackErrorScopes(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  return [...new Set(
    raw
      .map((scope) => String(scope || "").trim())
      .filter(Boolean)
  )];
}

function slackApiErrorCode(error) {
  const dataError = error && error.data && error.data.error;
  if (typeof dataError === "string" && dataError.trim()) {
    return dataError.trim();
  }

  const code = error && error.code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

function redactSlackIdentifier(value) {
  const text = String(value || "");
  if (!text) return undefined;
  return text.length <= 6 ? "[redacted]" : `${text.slice(0, 2)}...${text.slice(-4)}`;
}

function formatSlackThreadMessage(message) {
  const user = message.user || message.bot_id || message.username || "unknown";
  const actor = message.user ? `<@${message.user}>` : user;

  return {
    ts: String(message.ts || ""),
    actor,
    user: message.user,
    botId: message.bot_id,
    subtype: message.subtype,
    text: sanitizeThreadText(message.text || "")
  };
}

function sanitizeThreadText(text) {
  const maxChars = parsePositiveInteger(
    process.env.PATCHDOLL_SLACK_THREAD_MAX_MESSAGE_CHARS,
    4000
  );
  const sanitized = String(text || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return sanitized.length > maxChars
    ? `${sanitized.slice(0, maxChars)} [truncated]`
    : sanitized;
}

function isDirectUserMessage(message) {
  return (
    message &&
    message.channel_type === "im" &&
    message.type === "message" &&
    !message.subtype &&
    !message.bot_id &&
    !message.bot_profile &&
    typeof message.user === "string"
  );
}

function slackMessageUrl(event) {
  if (!event.channel || !event.ts) {
    return undefined;
  }

  return `slack://channel?team=${event.team || ""}&id=${event.channel}&message=${event.ts}`;
}

function requiredSecret(name) {
  if (process.env[name] && process.env.PATCHDOLL_SECRETS_ENV_ALLOWED === "1") {
    return process.env[name];
  }

  if (process.env[name]) {
    throw new Error(`${name} must be configured in ${patchdollSecretsPath}`);
  }

  const value = readSlackSecrets()[name];
  if (!value) {
    throw new Error(`${name} is required in ${patchdollSecretsPath}`);
  }

  return value;
}

function readSlackSecrets() {
  if (!readSlackSecrets.cache) {
    readSlackSecrets.cache = Object.assign({}, ...patchdollSecretsPaths.map(readEnvFileIfPresent));
  }
  return readSlackSecrets.cache;
}

function readEnvFileIfPresent(filePath) {
  try {
    return parseEnvFile(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function parseEnvFile(raw) {
  const values = {};

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

    values[match[1]] = parseEnvValue(match[2]);
  }

  return values;
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function logSafeText(value) {
  return String(value).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}
