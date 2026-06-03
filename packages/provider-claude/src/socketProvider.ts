import { join } from "node:path";
import type { AiProvider, AiResult, TaskContext } from "@patchdoll/core";
import {
  githubAppEnv,
  providerSocketPath,
  runProviderSocketWorker
} from "@patchdoll/core";

const STATE_DIR = "/patchdoll/state";

export const CLAUDE_SOCKET_PATH = providerSocketPath("claude");

export class ClaudeSocketAiProvider implements AiProvider {
  private running = 0;

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number,
    private readonly maxConcurrentRuns: number
  ) {}

  async run(task: TaskContext): Promise<AiResult> {
    if (this.running >= this.maxConcurrentRuns) {
      throw new Error("Claude AI concurrency limit reached");
    }

    this.running += 1;
    try {
      const runtimeEnv = await githubAppEnv(join(STATE_DIR, "patchdoll.sqlite"));
      return await runProviderSocketWorker({
        providerName: "Claude",
        socketPath: this.socketPath,
        timeoutMs: this.timeoutMs,
        task,
        env: runtimeEnv
      });
    } finally {
      this.running -= 1;
    }
  }
}
