import { readFileSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { CodexAiProvider } from "./codexProvider.js";
import { readPeerCredentials } from "./peercred.js";
import { CODEX_SOCKET_PATH } from "./socketProvider.js";
import type {
  AiResult,
  JsonValue,
  ProgressEvent,
  TaskContext
} from "@patchdoll/core";
import { stringifyLogJson } from "@patchdoll/core";

const socketPath = CODEX_SOCKET_PATH;
const allowedUid = uidForUser("patchdoll");
const allowedGid = gidForUser("patchdoll");
const timeoutMs =
  optionalInteger("PATCHDOLL_AI_TIMEOUT_SECONDS") !== undefined
    ? optionalInteger("PATCHDOLL_AI_TIMEOUT_SECONDS")! * 1000
    : 900000;
const maxConcurrentRuns =
  optionalInteger("PATCHDOLL_AI_MAX_CONCURRENT_RUNS") ?? 1;
const bypassSandboxAndApprovals = parseBoolean(
  process.env.PATCHDOLL_CODEX_BYPASS_APPROVALS_AND_SANDBOX,
  true
);
const provider = new CodexAiProvider(
  timeoutMs,
  maxConcurrentRuns,
  bypassSandboxAndApprovals
);

interface WorkerRunRequest {
  task: Omit<TaskContext, "progress">;
  env: Record<string, string>;
}

await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
await rm(socketPath, { force: true });

const server = createServer((socket) => {
  handleConnection(socket).catch((error) => {
    writeMessage(socket, {
      type: "error",
      error: error instanceof Error ? error.message : String(error)
    });
    socket.end();
  });
});

server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660);
  console.log(
    stringifyLogJson({
      message: "codex worker listening",
      socketPath,
      allowedUid,
      allowedGid,
      logLevel: process.env.PATCHDOLL_LOG_LEVEL || "info"
    })
  );
});

let shuttingDown = false;
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

async function handleConnection(socket: Socket): Promise<void> {
  const credentials = await readPeerCredentials(socket);
  if (
    credentials.uid !== allowedUid ||
    (allowedGid !== undefined && credentials.gid !== allowedGid)
  ) {
    throw new Error(
      `Rejected Codex worker client uid=${credentials.uid} gid=${credentials.gid}`
    );
  }

  const line = await readSingleLine(socket);
  const request = parseRunMessage(line);
  const result = await provider.run(
    {
      ...request.task,
      progress(event) {
        writeMessage(socket, {
          type: "progress",
          event
        });
      }
    },
    request.env
  );
  writeMessage(socket, {
    type: "result",
    result
  });
  socket.end();
}

function readSingleLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      resolve(buffer.slice(0, newline));
    });
    socket.on("error", reject);
    socket.on("close", () => {
      reject(new Error("Codex worker client closed before sending a request"));
    });
  });
}

function parseRunMessage(line: string): WorkerRunRequest {
  const parsed = JSON.parse(line) as JsonValue;
  if (!isObject(parsed) || parsed.type !== "run" || !isObject(parsed.task)) {
    throw new Error("Invalid Codex worker request");
  }

  return {
    task: parsed.task as unknown as Omit<TaskContext, "progress">,
    env: parseRuntimeEnv(parsed.env)
  };
}

function parseRuntimeEnv(value: JsonValue | undefined): Record<string, string> {
  if (!isObject(value)) {
    return {};
  }

  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && isValidEnvName(key)) {
      env[key] = item;
    }
  }
  return env;
}

function writeMessage(
  socket: Socket,
  message:
    | { type: "progress"; event: ProgressEvent }
    | { type: "result"; result: AiResult }
    | { type: "error"; error: string }
): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function optionalInteger(name: string): number | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function uidForUser(name: string): number {
  const entry = passwdEntryForUser(name);
  const uid = Number.parseInt(entry[2], 10);
  if (!Number.isFinite(uid)) {
    throw new Error(`Invalid uid for user ${name}`);
  }
  return uid;
}

function gidForUser(name: string): number {
  const entry = passwdEntryForUser(name);
  const gid = Number.parseInt(entry[3], 10);
  if (!Number.isFinite(gid)) {
    throw new Error(`Invalid gid for user ${name}`);
  }
  return gid;
}

function passwdEntryForUser(name: string): string[] {
  const passwd = readFileSync("/etc/passwd", "utf8");
  for (const line of passwd.split(/\r?\n/)) {
    const fields = line.split(":");
    if (fields[0] === name) {
      return fields;
    }
  }
  throw new Error(`Unable to find user ${name} in /etc/passwd`);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(
    stringifyLogJson({
      message: "codex worker shutting down",
      signal
    })
  );

  server.close(() => {
    rm(socketPath, { force: true })
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
