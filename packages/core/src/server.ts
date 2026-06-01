import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { createDefaultActionHandlers } from "./actions.js";
import { createAiProvider } from "./ai.js";
import { readBody, sendJson, startNdjson, wantsNdjson, writeNdjson } from "./http.js";
import { loadConfig } from "./config.js";
import { stringifyLogJson } from "./log.js";
import { PatchdollRunner } from "./runner.js";
import type { JsonValue, NormalizedEvent } from "./types.js";

const slackIngressPath = "/webhooks/slack";
const slackIngressSocketPath = "/run/patchdoll/core.sock";

const config = await loadConfig();
const ai = await createAiProvider(config);
const actionHandlers = createDefaultActionHandlers();
const runner = new PatchdollRunner(config, ai, actionHandlers);

const healthServer = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  if (request.method === "GET" && path === "/health") {
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": "2"
    });
    response.end("OK");
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: "Not found"
  });
});

const slackIngressServer = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  try {
    if (request.method !== "POST" || path !== slackIngressPath) {
      sendJson(response, 404, {
        ok: false,
        error: "Not found"
      });
      return;
    }

    const body = await readBody(request);
    const event = normalizeSlackIngress(body);
    const stream = wantsNdjson(request);

    if (stream) {
      startNdjson(response);
      writeNdjson(response, {
        type: "progress",
        event: {
          source: "runner",
          message: "I hear you."
        }
      });

      const result = await runner.run(event, {
        progress(progressEvent) {
          writeNdjson(response, {
            type: "progress",
            event: progressEvent
          });
        }
      });

      writeNdjson(response, {
        type: "result",
        ok: true,
        result
      });
      response.end();
      return;
    }

    const result = await runner.run(event);

    sendJson(response, 202, {
      ok: true,
      result
    });
  } catch (error) {
    if (response.headersSent) {
      writeNdjson(response, {
        type: "error",
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
      response.end();
      return;
    }

    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

healthServer.listen(config.server.port, config.server.host, () => {
  console.log(
    stringifyLogJson({
      message: "patchdoll listening",
      host: config.server.host,
      port: config.server.port
    })
  );
});

await listenUnix(slackIngressServer, slackIngressSocketPath);

let shuttingDown = false;

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(
    stringifyLogJson({
      message: "patchdoll shutting down",
      signal
    })
  );

  const forceExit = setTimeout(() => {
    console.error(
      stringifyLogJson({
        message: "patchdoll shutdown timed out",
        signal
      })
    );
    healthServer.closeAllConnections();
    slackIngressServer.closeAllConnections();
    process.exit(1);
  }, 5000);
  forceExit.unref();

  closeServers([healthServer, slackIngressServer], async (error) => {
    clearTimeout(forceExit);
    await rm(slackIngressSocketPath, { force: true });

    if (error) {
      console.error(
        stringifyLogJson({
          message: "patchdoll shutdown failed",
          error: error.message
        })
      );
      process.exit(1);
    }

    process.exit(0);
  });
}

async function listenUnix(server: Server, socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o770 });
  await rm(socketPath, { force: true });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      console.log(
        stringifyLogJson({
          message: "patchdoll slack ingress listening",
          socketPath
        })
      );
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServers(
  servers: Server[],
  callback: (error?: Error) => void | Promise<void>
): void {
  let remaining = servers.length;
  let firstError: Error | undefined;

  for (const server of servers) {
    server.close((error) => {
      firstError ??= error ?? undefined;
      remaining -= 1;
      if (remaining === 0) {
        void callback(firstError);
      }
    });
  }
}

function normalizeSlackIngress(body: Buffer): NormalizedEvent {
  const payload = parseJson(body);
  const metadata = recordJson(readJsonPath(payload, "$.metadata"));

  return {
    id: randomUUID(),
    source: "slack",
    kind: jsonString(readJsonPath(payload, "$.type")) ?? "slack.received",
    actor: jsonString(readJsonPath(payload, "$.actor")),
    title: jsonString(readJsonPath(payload, "$.title")),
    body: jsonString(readJsonPath(payload, "$.body")),
    url: jsonString(readJsonPath(payload, "$.url")),
    receivedAt: new Date().toISOString(),
    raw: payload,
    metadata
  };
}

function parseJson(body: Buffer): JsonValue {
  if (body.length === 0) {
    return {};
  }

  return JSON.parse(body.toString("utf8")) as JsonValue;
}

function readJsonPath(value: JsonValue, path: string): JsonValue {
  if (!path.startsWith("$.")) {
    return null;
  }

  const parts = path.slice(2).split(".").filter(Boolean);
  let current: JsonValue | undefined = value;

  for (const part of parts) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
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

function recordJson(value: JsonValue): Record<string, JsonValue> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value;
}
