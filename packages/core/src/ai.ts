import type { AiProvider, PatchdollConfig } from "./types.js";

type CodexProviderModule = {
  CODEX_SOCKET_PATH: string;
  CodexSocketAiProvider: new (
    socketPath: string,
    timeoutMs: number,
    maxConcurrentRuns: number
  ) => AiProvider;
};

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<unknown>;

export async function createAiProvider(
  config: PatchdollConfig
): Promise<AiProvider> {
  const provider = (await dynamicImport(
    "@patchdoll/provider-codex"
  )) as CodexProviderModule;
  return new provider.CodexSocketAiProvider(
    provider.CODEX_SOCKET_PATH,
    config.ai.timeoutSeconds * 1000,
    config.ai.maxConcurrentRuns
  );
}
