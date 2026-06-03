import { readFileSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { readPeerCredentials } from "./peercred.js";
import {
  parseWorkerRunMessage,
  readSingleWorkerLine,
  writeWorkerMessage
} from "./providerSocket.js";
import { stringifyLogJson } from "./log.js";
import type { AiResult, TaskContext } from "./types.js";

export interface ProviderWorkerRuntimeConfig {
  timeoutMs: number;
  maxConcurrentRuns: number;
}

export interface ProviderWorkerProvider {
  run(
    task: TaskContext,
    runtimeEnv?: Record<string, string>
  ): Promise<AiResult>;
}

export interface StartProviderWorkerOptions {
  providerName: string;
  socketPath: string;
  provider: ProviderWorkerProvider;
  allowedUser?: string;
  logLevel?: string;
}

export function providerWorkerRuntimeConfig(): ProviderWorkerRuntimeConfig {
  return {
    timeoutMs: (optionalInteger("PATCHDOLL_AI_TIMEOUT_SECONDS") ?? 900) * 1000,
    maxConcurrentRuns: optionalInteger("PATCHDOLL_AI_MAX_CONCURRENT_RUNS") ?? 1
  };
}

export async function startProviderWorker(
  options: StartProviderWorkerOptions
): Promise<void> {
  const allowedUser = options.allowedUser ?? "patchdoll";
  const allowedUid = uidForUser(allowedUser);
  const allowedGid = gidForUser(allowedUser);
  const socketPath = options.socketPath;
  const providerLogName = options.providerName.toLowerCase();

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
  await rm(socketPath, { force: true });

  const server = createServer((socket) => {
    handleConnection(
      socket,
      options.providerName,
      allowedUid,
      allowedGid,
      options.provider
    ).catch((error) => {
      writeWorkerMessage(socket, {
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
        message: `${providerLogName} worker listening`,
        socketPath,
        allowedUid,
        allowedGid,
        logLevel: options.logLevel ?? process.env.PATCHDOLL_LOG_LEVEL ?? "info"
      })
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.log(
      stringifyLogJson({
        message: `${providerLogName} worker shutting down`,
        signal
      })
    );

    server.close(() => {
      rm(socketPath, { force: true })
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

async function handleConnection(
  socket: Socket,
  providerName: string,
  allowedUid: number,
  allowedGid: number,
  provider: ProviderWorkerProvider
): Promise<void> {
  const credentials = await readPeerCredentials(socket);
  if (credentials.uid !== allowedUid || credentials.gid !== allowedGid) {
    throw new Error(
      `Rejected ${providerName} worker client uid=${credentials.uid} gid=${credentials.gid}`
    );
  }

  const line = await readSingleWorkerLine(socket, providerName);
  const request = parseWorkerRunMessage(line);
  const result = await provider.run(
    {
      ...request.task,
      progress(event) {
        writeWorkerMessage(socket, {
          type: "progress",
          event
        });
      }
    },
    request.env
  );
  writeWorkerMessage(socket, {
    type: "result",
    result
  });
  socket.end();
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
