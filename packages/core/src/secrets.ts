import { readFile } from "node:fs/promises";
import { parse } from "dotenv";

export const PATCHDOLL_SECRETS_PATH = "/run/secrets/patchdoll.env";

export async function readPatchdollSecrets(
  path = PATCHDOLL_SECRETS_PATH
): Promise<Record<string, string>> {
  return readPatchdollSecretsFile(path);
}

export async function patchdollSecret(
  name: string,
  path = PATCHDOLL_SECRETS_PATH
): Promise<string | undefined> {
  const value = (await readPatchdollSecrets(path))[name]?.trim();
  return value ? value : undefined;
}

async function readPatchdollSecretsFile(
  path: string
): Promise<Record<string, string>> {
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
