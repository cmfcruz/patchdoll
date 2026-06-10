import type { AiResult, JsonValue } from "./types.js";

/**
 * The coarse "may this person drive Patchdoll at all" gate, evaluated before any
 * AI work begins. This is deliberately separate from the per-action admin gate
 * in policy.ts: that one decides whether an already-running agent may take a
 * privileged action; this one decides whether the agent starts at all.
 *
 * Fails closed, with no escape hatch. With no trusted users and no admins,
 * nobody is admitted — a forgotten allowlist denies rather than silently
 * reverting to open access. Admins are implicitly trusted so a fresh install can
 * still be bootstrapped by whoever is in PATCHDOLL_ADMINS; at least one of
 * PATCHDOLL_ADMINS / PATCHDOLL_TRUSTED_USERS must be set or Patchdoll answers
 * no one.
 */
export interface InvocationPolicy {
  admins: string[];
  trustedUsers: string[];
}

/**
 * True when `actor` is allowed to invoke Patchdoll. Decide on the current
 * message's actor only — never thread participants or quoted transcript content,
 * which are untrusted data, not authority.
 */
export function actorMayInvoke(
  actor: string | undefined,
  policy: InvocationPolicy
): boolean {
  if (actor === undefined) {
    return false;
  }
  return policy.admins.includes(actor) || policy.trustedUsers.includes(actor);
}

/** Build the chat reply returned when an untrusted actor is turned away. */
export function buildInvocationDeniedResult(actor: string | undefined): AiResult {
  const reply =
    "🔒 You're not on Patchdoll's trusted-users list, so I won't run this. " +
    "Ask an admin to add your Slack user ID to `PATCHDOLL_TRUSTED_USERS`.";
  const metadata: Record<string, JsonValue> = {
    invocationDenied: true,
    actor: actor ?? null
  };
  return {
    reply,
    proposedActions: [{ type: "chat.reply", body: reply }],
    metadata
  };
}
