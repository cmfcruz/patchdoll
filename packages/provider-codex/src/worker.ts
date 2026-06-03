import { CodexAiProvider } from "./codexProvider.js";
import { CODEX_SOCKET_PATH } from "./socketProvider.js";
import {
  providerWorkerRuntimeConfig,
  startProviderWorker
} from "@patchdoll/core";

const { timeoutMs, maxConcurrentRuns } = providerWorkerRuntimeConfig();
const bypassSandboxAndApprovals = parseBoolean(
  process.env.PATCHDOLL_CODEX_BYPASS_APPROVALS_AND_SANDBOX,
  true
);
const provider = new CodexAiProvider(
  timeoutMs,
  maxConcurrentRuns,
  bypassSandboxAndApprovals
);

await startProviderWorker({
  providerName: "Codex",
  socketPath: CODEX_SOCKET_PATH,
  provider
});

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}
