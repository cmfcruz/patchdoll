#!/usr/bin/env node
import { escapeLogText, stringifyLogJson } from "./log.js";
import { openPatchdollSettingsStore } from "./settings.js";
import type { JsonValue } from "./types.js";

async function main(argv: string[]): Promise<void> {
  const [resource, command, ...args] = argv;
  if (resource !== "settings" || !command || ["-h", "--help"].includes(resource)) {
    usage();
    return;
  }

  const store = await openPatchdollSettingsStore();
  try {
    if (command === "list") {
      console.log(stringifyLogJson(store.list(), 2));
      return;
    }
    if (command === "get") {
      const key = required(args[0], "setting key");
      const value = store.get(key);
      if (value === undefined) throw new Error(`Setting not found: ${key}`);
      console.log(stringifyLogJson(value));
      return;
    }
    if (command === "set") {
      const key = required(args[0], "setting key");
      const raw = required(args[1], "setting value");
      store.set(key, parseValue(raw));
      console.log(`Updated ${key}`);
      return;
    }
    usage();
    process.exitCode = 2;
  } finally {
    store.close();
  }
}

function parseValue(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function usage(): void {
  console.log(`Usage:\n  patchdollctl settings list\n  patchdollctl settings get <key>\n  patchdollctl settings set <key> <json-or-string>\n\nExamples:\n  patchdollctl settings set ai.provider codex\n  patchdollctl settings set ai.provider claude\n  patchdollctl settings set claude.model sonnet\n  patchdollctl settings set claude.effort high\n  patchdollctl settings set codex.reasoningEffort high\n  patchdollctl settings set codex.fastMode true`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(
    escapeLogText(error instanceof Error ? error.message : String(error))
  );
  process.exitCode = 1;
});
