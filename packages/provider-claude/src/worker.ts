import { ClaudeAiProvider } from "./claudeProvider.js";
import { CLAUDE_SOCKET_PATH } from "./socketProvider.js";
import {
  providerWorkerRuntimeConfig,
  startProviderWorker
} from "@patchdoll/core";

const { timeoutMs, maxConcurrentRuns } = providerWorkerRuntimeConfig();
const provider = new ClaudeAiProvider(timeoutMs, maxConcurrentRuns);

await startProviderWorker({
  providerName: "Claude",
  socketPath: CLAUDE_SOCKET_PATH,
  provider
});
