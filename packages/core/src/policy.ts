import type {
  ActionDecision,
  Capabilities,
  ProposedAction
} from "./types.js";

export function evaluateActions(
  actions: ProposedAction[] | undefined,
  capabilities: Capabilities,
  context: { actorIsAdmin?: boolean } = {}
): ActionDecision[] {
  return (actions ?? []).map((action) => {
    if (!action.type) {
      return {
        action,
        allowed: false,
        reason: "Action type is required"
      };
    }

    if (!capabilities[action.type]) {
      return {
        action,
        allowed: false,
        reason: `Capability ${action.type} is disabled`
      };
    }

    if (action.type === "patchdoll.settings.update" && !context.actorIsAdmin) {
      return {
        action,
        allowed: false,
        reason: "Patchdoll settings changes require an admin actor"
      };
    }

    if (action.type.startsWith("policy.") && !context.actorIsAdmin) {
      return {
        action,
        allowed: false,
        reason: "Policy changes require an admin actor"
      };
    }

    return {
      action,
      allowed: true
    };
  });
}
