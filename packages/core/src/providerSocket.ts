import { createConnection, type Socket } from "node:net";
import type {
  AiResult,
  JsonValue,
  ProgressEvent,
  TaskContext
} from "./types.js";

const PROVIDER_SOCKET_DIR = "/run/patchdoll/providers";

export type WorkerTask = Omit<TaskContext, "progress">;

export interface WorkerRunMessage {
  type: "run";
  task: WorkerTask;
  env?: Record<string, string>;
}

export interface WorkerRunRequest {
  task: WorkerTask;
  env: Record<string, string>;
}

export interface WorkerResultMessage {
  type: "result";
  result: AiResult;
}

export interface WorkerProgressMessage {
  type: "progress";
  event: ProgressEvent;
}

export interface WorkerErrorMessage {
  type: "error";
  error: string;
}

export type WorkerMessage =
  | WorkerResultMessage
  | WorkerProgressMessage
  | WorkerErrorMessage;

export interface ProviderSocketRunOptions {
  providerName: string;
  socketPath: string;
  timeoutMs: number;
  task: TaskContext;
  env?: Record<string, string>;
}

export function providerSocketPath(providerName: string): string {
  return `${PROVIDER_SOCKET_DIR}/${providerName}.sock`;
}

export function runProviderSocketWorker(
  options: ProviderSocketRunOptions
): Promise<AiResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `${options.providerName} worker timed out after ${options.timeoutMs}ms`
        )
      );
    }, options.timeoutMs);
    let buffer = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const payload: WorkerRunMessage = {
        type: "run",
        task: {
          event: options.task.event,
          agentsMd: options.task.agentsMd,
          config: options.task.config
        },
        env: options.env
      };
      socket.write(`${JSON.stringify(payload)}\n`);
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let message: WorkerMessage;
        try {
          message = parseWorkerMessage(trimmed);
        } catch (error) {
          finish(() =>
            reject(
              new Error(
                `${options.providerName} worker sent an invalid message: ${messageOf(error)}`
              )
            )
          );
          socket.destroy();
          return;
        }

        if (message.type === "progress") {
          Promise.resolve(options.task.progress?.(message.event)).catch(
            () => undefined
          );
          continue;
        }

        if (message.type === "error") {
          finish(() => reject(new Error(message.error)));
          socket.destroy();
          return;
        }

        finish(() => resolve(message.result));
        socket.end();
        return;
      }
    });

    socket.on("error", (error) => {
      finish(() =>
        reject(
          new Error(
            `${options.providerName} worker socket failed: ${error.message}`
          )
        )
      );
    });

    socket.on("close", () => {
      finish(() =>
        reject(
          new Error(`${options.providerName} worker closed without a result`)
        )
      );
    });
  });
}

export function parseWorkerMessage(line: string): WorkerMessage {
  const value = JSON.parse(line) as JsonValue;
  if (!isObject(value) || typeof value.type !== "string") {
    throw new Error("Invalid worker message");
  }

  if (value.type === "progress" && isObject(value.event)) {
    return {
      type: "progress",
      event: value.event as unknown as ProgressEvent
    };
  }

  if (value.type === "result" && isObject(value.result)) {
    return {
      type: "result",
      result: value.result as unknown as AiResult
    };
  }

  if (value.type === "error") {
    return {
      type: "error",
      error: typeof value.error === "string" ? value.error : "Worker error"
    };
  }

  throw new Error("Invalid worker message");
}

export function readSingleWorkerLine(
  socket: Socket,
  providerName: string
): Promise<string> {
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
      reject(
        new Error(
          `${providerName} worker client closed before sending a request`
        )
      );
    });
  });
}

export function parseWorkerRunMessage(line: string): WorkerRunRequest {
  const parsed = JSON.parse(line) as JsonValue;
  if (!isObject(parsed) || parsed.type !== "run" || !isObject(parsed.task)) {
    throw new Error("Invalid worker request");
  }

  return {
    task: parsed.task as unknown as WorkerTask,
    env: parseRuntimeEnv(parsed.env)
  };
}

export function writeWorkerMessage(
  socket: Socket,
  message: WorkerMessage
): void {
  socket.write(`${JSON.stringify(message)}\n`);
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

function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
