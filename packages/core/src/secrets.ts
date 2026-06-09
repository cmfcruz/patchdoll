import { readFile } from "node:fs/promises";
import { parse } from "dotenv";

export const PATCHDOLL_SECRETS_PATHS = [
  "/run/secrets/patchdoll.env",
  "/run/patchdoll/secrets.env"
] as const;

type PatchdollSecretsPath = string | readonly string[];

export async function readPatchdollSecrets(
  path: PatchdollSecretsPath = PATCHDOLL_SECRETS_PATHS
): Promise<Record<string, string>> {
  const paths = Array.isArray(path) ? path : [path];
  const secrets: Record<string, string> = {};

  for (const candidate of paths) {
    Object.assign(secrets, await readPatchdollSecretsFile(candidate));
  }

  return secrets;
}

export async function patchdollSecret(
  name: string,
  path: PatchdollSecretsPath = PATCHDOLL_SECRETS_PATHS
): Promise<string | undefined> {
  const value = (await readPatchdollSecrets(path))[name]?.trim();
  return value ? value : undefined;
}

async function readPatchdollSecretsFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function parseEnvFile(raw: string): Record<string, string> {
  return parse(raw);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
