import type { ProposedAction } from "./types.js";

export interface ExtractedProposedActions {
  reply: string;
  proposedActions: ProposedAction[];
}

export function extractProposedActionsFromMessage(
  message: string
): ExtractedProposedActions {
  const actionBlockPattern = /```patchdoll-actions\s*([\s\S]*?)```/g;
  const proposedActions: ProposedAction[] = [];

  for (const match of message.matchAll(actionBlockPattern)) {
    proposedActions.push(...parseProposedActions(match[1] ?? ""));
  }

  return {
    reply: message.replace(actionBlockPattern, "").trim(),
    proposedActions
  };
}

function parseProposedActions(raw: string): ProposedAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter(isProposedAction);
}

function isProposedAction(value: unknown): value is ProposedAction {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
