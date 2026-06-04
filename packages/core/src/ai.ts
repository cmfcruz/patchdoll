import type { AiProvider, PatchdollConfig } from "./types.js";

type CodexProviderModule = {
  CODEX_SOCKET_PATH: string;
  CodexSocketAiProvider: new (
    socketPath: string,
    timeoutMs: number,
    maxConcurrentRuns: number
  ) => AiProvider;
};

type ClaudeProviderModule = {
  CLAUDE_SOCKET_PATH: string;
  ClaudeSocketAiProvider: new (
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
  if (config.ai.provider === "codex") {
    return createCodexProvider(config);
  }
  if (config.ai.provider === "claude") {
    return createClaudeProvider(config);
  }

  throw new Error(`Unsupported AI provider: ${config.ai.provider}`);
}

async function createCodexProvider(config: PatchdollConfig): Promise<AiProvider> {
  const provider = (await dynamicImport(
    "@patchdoll/provider-codex"
  )) as CodexProviderModule;
  return new provider.CodexSocketAiProvider(
    provider.CODEX_SOCKET_PATH,
    config.ai.timeoutSeconds * 1000,
    config.ai.maxConcurrentRuns
  );
}

async function createClaudeProvider(config: PatchdollConfig): Promise<AiProvider> {
  const provider = (await dynamicImport(
    "@patchdoll/provider-claude"
  )) as ClaudeProviderModule;
  return new provider.ClaudeSocketAiProvider(
    provider.CLAUDE_SOCKET_PATH,
    config.ai.timeoutSeconds * 1000,
    config.ai.maxConcurrentRuns
  );
}
