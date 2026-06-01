import { readFile } from "node:fs/promises";

export async function loadAgentsMd(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return [
        "# Patchdoll Default Instructions",
        "",
        "No AGENTS.md file was found. Be conservative, concise, and propose no",
        "external action unless it is clearly requested by the event context."
      ].join("\n");
    }

    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
