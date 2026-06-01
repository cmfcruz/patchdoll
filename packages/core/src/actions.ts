import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openPatchdollSettingsStore, validateSetting } from "./settings.js";
import type {
  ActionExecutionResult,
  ExternalActionHandler,
  JsonValue,
  ProposedAction
} from "./types.js";

export function createDefaultActionHandlers(): ExternalActionHandler[] {
  return [
    {
      type: "chat.reply",
      async execute(action) {
        const body = action.body ?? "";
        console.log(JSON.stringify({ action: "chat.reply", body }));
        return ok(action, "Chat reply emitted to stdout");
      }
    },
    {
      type: "patchdoll.settings.update",
      async execute(action) {
        const update = settingsUpdateFromPayload(action.payload);
        if (!update.ok) {
          return fail(action, update.message);
        }

        const store = await openPatchdollSettingsStore();
        try {
          for (const [key, value] of Object.entries(update.values)) {
            store.set(key, value);
          }
        } finally {
          store.close();
        }

        return ok(action, `Patchdoll settings updated: ${Object.keys(update.values).join(", ")}`);
      }
    },
    {
      type: "policy.codex.execpolicy.add_rule",
      async execute(action) {
        const rule = execpolicyRuleFromPayload(action.payload);
        if (!rule.ok) {
          return fail(action, rule.message);
        }

        const path = codexExecpolicyPath();
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await appendFile(path, `\n${rule.rule}\n`, "utf8");

        return ok(action, `Codex execpolicy rule appended to ${path}`);
      }
    }
  ];
}

export async function executeAllowedActions(
  actions: ProposedAction[],
  handlers: ExternalActionHandler[]
): Promise<ActionExecutionResult[]> {
  const byType = new Map(handlers.map((handler) => [handler.type, handler]));
  const results: ActionExecutionResult[] = [];

  for (const action of actions) {
    const handler = byType.get(action.type);
    if (!handler) {
      results.push(fail(action, `No handler registered for ${action.type}`));
      continue;
    }

    results.push(await handler.execute(action));
  }

  return results;
}

function ok(action: ProposedAction, message: string): ActionExecutionResult {
  return {
    action,
    ok: true,
    message
  };
}

function fail(action: ProposedAction, message: string): ActionExecutionResult {
  return {
    action,
    ok: false,
    message
  };
}

type RuleResult =
  | { ok: true; rule: string }
  | { ok: false; message: string };

function execpolicyRuleFromPayload(value: JsonValue | undefined): RuleResult {
  if (!isJsonObject(value)) {
    return { ok: false, message: "Execpolicy rule payload must be an object" };
  }

  const pattern = parsePattern(value.pattern);
  if (!pattern.ok) {
    return pattern;
  }

  const decision = typeof value.decision === "string" ? value.decision : "";
  if (!["allow", "prompt", "forbidden"].includes(decision)) {
    return {
      ok: false,
      message: "Execpolicy decision must be allow, prompt, or forbidden"
    };
  }

  const justification =
    typeof value.justification === "string" ? value.justification.trim() : "";
  if (!justification) {
    return {
      ok: false,
      message: "Execpolicy justification is required"
    };
  }

  const rule = [
    "# Added by Patchdoll.",
    "prefix_rule(",
    `    pattern = ${formatPattern(pattern.pattern)},`,
    `    decision = ${quote(decision)},`,
    `    justification = ${quote(justification)},`,
    ")"
  ].join("\n");

  return { ok: true, rule };
}

type PatternToken = string | string[];

function parsePattern(
  value: JsonValue | undefined
): { ok: true; pattern: PatternToken[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      message: "Execpolicy pattern must be a non-empty array"
    };
  }

  const pattern: PatternToken[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const token = item.trim();
      if (!token) {
        return { ok: false, message: "Execpolicy pattern tokens cannot be empty" };
      }
      pattern.push(token);
      continue;
    }

    if (Array.isArray(item) && item.length > 0) {
      const alternatives: string[] = [];
      for (const alternative of item) {
        if (typeof alternative !== "string" || !alternative.trim()) {
          return {
            ok: false,
            message: "Execpolicy pattern alternatives must be non-empty strings"
          };
        }
        alternatives.push(alternative.trim());
      }
      pattern.push(alternatives);
      continue;
    }

    return {
      ok: false,
      message: "Execpolicy pattern entries must be strings or string arrays"
    };
  }

  return { ok: true, pattern };
}

function formatPattern(pattern: PatternToken[]): string {
  return `[${pattern
    .map((item) =>
      Array.isArray(item)
        ? `[${item.map((alternative) => quote(alternative)).join(", ")}]`
        : quote(item)
    )
    .join(", ")}]`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function codexExecpolicyPath(): string {
  return join("/patchdoll/codex", "execpolicy.rules");
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


type SettingsUpdateResult =
  | { ok: true; values: Record<string, JsonValue> }
  | { ok: false; message: string };

function settingsUpdateFromPayload(
  value: JsonValue | undefined
): SettingsUpdateResult {
  if (!isJsonObject(value)) {
    return { ok: false, message: "Settings update payload must be an object" };
  }

  const raw = isJsonObject(value.patch) ? value.patch : value;
  const values = flattenSettingsPatch(raw);
  if (Object.keys(values).length === 0) {
    return { ok: false, message: "Settings update payload must include at least one setting" };
  }

  try {
    for (const [key, item] of Object.entries(values)) {
      values[key] = validateSetting(key, item);
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, values };
}

function flattenSettingsPatch(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "ai" && isJsonObject(item)) addPrefixed(values, "ai", item);
    else if (key === "codex" && isJsonObject(item)) addPrefixed(values, "codex", item);
    else values[key] = item;
  }
  return values;
}

function addPrefixed(
  target: Record<string, JsonValue>,
  prefix: string,
  value: Record<string, JsonValue>
): void {
  for (const [key, item] of Object.entries(value)) {
    if (isJsonObject(item)) {
      addPrefixed(target, `${prefix}.${key}`, item);
    } else {
      target[`${prefix}.${key}`] = item;
    }
  }
}
