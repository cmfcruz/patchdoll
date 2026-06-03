import { join } from "node:path";
import type {
  AiProvider,
  AiResult,
  TaskContext
} from "@patchdoll/core";
import {
  githubAppEnv,
  providerSocketPath,
  runProviderSocketWorker
} from "@patchdoll/core";

const STATE_DIR = "/patchdoll/state";

export const CODEX_SOCKET_PATH = providerSocketPath("codex");

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
    return runProviderSocketWorker({
      providerName: "Codex",
      socketPath: this.socketPath,
      timeoutMs: this.timeoutMs,
      task,
      env: runtimeEnv
    });
  }
}
