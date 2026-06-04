import type { AiResult, JsonValue } from "./types.js";

/**
 * Explicit, opt-in commands that clear a thread's stored CLI session so the
 * next turn starts fresh. This is the safe human escape hatch for the case a
 * resume fails with wording the resume-failure matcher doesn't recognize (see
 * resumeFailure.ts) — rather than broadening auto-deletion, a human asks for it.
 */
const RESET_THREAD_COMMANDS = [
  "reset thread",
  "reset this thread",
  "start fresh"
] as const;

/**
 * True only when the message body is *exactly* a reset command (after trimming,
 * lowercasing, collapsing whitespace, and dropping trailing punctuation).
 * Matched against the whole body — never as a substring — so ordinary prose that
 * merely mentions "reset" or "start fresh" can't nuke a session by accident.
 */
export function isResetThreadCommand(body: string | undefined): boolean {
  if (!body) {
    return false;
  }
  const normalized = body
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
  return (RESET_THREAD_COMMANDS as readonly string[]).includes(normalized);
}

export interface ResetThreadOutcome {
  /** Provider name, for metadata/logging. */
  provider: string;
  /** The thread key whose session was (or would be) cleared. */
  threadKey: string;
  /** Whether the requesting actor is an admin (reset is admin-only). */
  actorIsAdmin: boolean;
  /** Whether a stored session actually existed and was deleted. */
  cleared: boolean;
}

/** Build the chat reply for a reset-thread command. Reset is admin-only. */
export function buildResetThreadResult(outcome: ResetThreadOutcome): AiResult {
  const reply = resetThreadReply(outcome);
  const metadata: Record<string, JsonValue> = {
    provider: outcome.provider,
    threadKey: outcome.threadKey,
    resetThread: true,
    actorIsAdmin: outcome.actorIsAdmin,
    cleared: outcome.cleared
  };
  return {
    reply,
    proposedActions: [{ type: "chat.reply", body: reply }],
    metadata
  };
}

/** The hint appended to user-facing failures where `reset thread` may help. */
export const RESET_THREAD_HINT =
  "If this thread seems stuck, an admin can send `reset thread` to start fresh.";

function resetThreadReply(outcome: ResetThreadOutcome): string {
  if (!outcome.actorIsAdmin) {
    return "🔒 Only an admin can reset this thread's saved session. Ask an admin to send `reset thread`.";
  }
  if (outcome.cleared) {
    return "✅ Cleared this thread's saved session — your next message starts a fresh conversation.";
  }
  return "Nothing to clear — this thread had no saved session. The next message starts fresh either way.";
}
