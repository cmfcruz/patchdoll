import { createConnection } from "node:net";
import { join } from "node:path";
import { githubAppEnv } from "./githubAppAuth.js";
import type {
  AiProvider,
  AiResult,
  JsonValue,
  ProgressEvent,
  TaskContext
} from "@patchdoll/core";

type WorkerTask = Omit<TaskContext, "progress">;

interface WorkerRunMessage {
  type: "run";
  task: WorkerTask;
  env?: Record<string, string>;
}

interface WorkerResultMessage {
  type: "result";
  result: AiResult;
}

interface WorkerProgressMessage {
  type: "progress";
  event: ProgressEvent;
}

interface WorkerErrorMessage {
  type: "error";
  error: string;
}

type WorkerMessage =
  | WorkerResultMessage
  | WorkerProgressMessage
  | WorkerErrorMessage;

const PROVIDER_SOCKET_DIR = "/run/patchdoll/providers";
const STATE_DIR = "/patchdoll/state";

export const CODEX_SOCKET_PATH = providerSocketPath("codex");

export function providerSocketPath(providerName: string): string {
  return `${PROVIDER_SOCKET_DIR}/${providerName}.sock`;
}

export class CodexSocketAiProvider implements AiProvider {
  private running = 0;

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number,
    private readonly maxConcurrentRuns: number
  ) {}

  async run(task: TaskContext): Promise<AiResult> {
    if (this.running >= this.maxConcurrentRuns) {
      throw new Error("Codex AI concurrency limit reached");
    }

    this.running += 1;
    try {
      return await this.runWorker(task);
    } finally {
      this.running -= 1;
    }
  }

  private async runWorker(task: TaskContext): Promise<AiResult> {
    const runtimeEnv = await githubAppEnv(join(STATE_DIR, "patchdoll.sqlite"));

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Codex worker timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
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
            event: task.event,
            agentsMd: task.agentsMd,
            config: task.config
          },
          env: runtimeEnv
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
                  `Codex worker sent an invalid message: ${messageOf(error)}`
                )
              )
            );
            socket.destroy();
            return;
          }

          if (message.type === "progress") {
            Promise.resolve(task.progress?.(message.event)).catch(
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
          reject(new Error(`Codex worker socket failed: ${error.message}`))
        );
      });

      socket.on("close", () => {
        finish(() => reject(new Error("Codex worker closed without a result")));
      });
    });
  }
}

function parseWorkerMessage(line: string): WorkerMessage {
  const value = JSON.parse(line) as JsonValue;
  if (!isObject(value) || typeof value.type !== "string") {
    throw new Error("Invalid Codex worker message");
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

  throw new Error("Invalid Codex worker message");
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
