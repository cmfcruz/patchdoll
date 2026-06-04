/**
 * Classifies provider invocation errors as "the stored session could not be
 * resumed" versus anything else.
 *
 * The thread self-healing logic deletes a stored session and retries fresh.
 * That is only the right response when the error came from *resume
 * restoration* (a pruned/rotated/missing rollout or transcript). For any other
 * failure — timeouts, auth/API errors, CLI startup problems, or a real agent
 * failure after resume already succeeded — clearing the session would discard
 * valid context and duplicate work, so the caller must rethrow instead.
 *
 * Signatures are matched as case-insensitive substrings of a whitespace-
 * normalized error message. CLI wording drifts between versions, so the lists
 * are exported constants meant to be tuned, and `matchResumeFailure` returns
 * the signature that fired so callers can log exactly what matched.
 */

export interface ResumeFailureMatch {
  /** True when one of the signatures was found in the message. */
  matched: boolean;
  /** The signature that fired, present only when `matched` is true. */
  signature?: string;
}

/** Collapse runs of whitespace (incl. newlines) so signatures match across wrapped CLI output. */
function normalize(message: string): string {
  return message.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Returns the first signature found in `message`, or `{ matched: false }`.
 * Matching is case-insensitive and whitespace-insensitive.
 */
export function matchResumeFailure(
  message: string,
  signatures: readonly string[]
): ResumeFailureMatch {
  const haystack = normalize(message);
  for (const signature of signatures) {
    if (signature && haystack.includes(normalize(signature))) {
      return { matched: true, signature };
    }
  }
  return { matched: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Substrings that mark a `codex exec resume` failure as a resume-restoration
 * failure (rollout pruned/rotated/missing) rather than a generic run failure.
 */
export const CODEX_RESUME_FAILURE_SIGNATURES = [
  "no rollout found",
  "rollout not found",
  "failed to resume",
  "could not resume",
  "thread/resume",
  "session not found",
  "unknown session"
] as const;

/**
 * Substrings that mark a Claude Code `--resume` failure as a resume-restoration
 * failure (transcript pruned/rotated/missing) rather than a generic run failure.
 */
export const CLAUDE_RESUME_FAILURE_SIGNATURES = [
  "no conversation found",
  "session id not found",
  "session not found",
  "no such session",
  "could not resume",
  "failed to resume"
] as const;

/** True (with the matched signature) when `error` looks like a Codex resume-restoration failure. */
export function isCodexResumeFailure(error: unknown): ResumeFailureMatch {
  return matchResumeFailure(errorMessage(error), CODEX_RESUME_FAILURE_SIGNATURES);
}

/** True (with the matched signature) when `error` looks like a Claude resume-restoration failure. */
export function isClaudeResumeFailure(error: unknown): ResumeFailureMatch {
  return matchResumeFailure(errorMessage(error), CLAUDE_RESUME_FAILURE_SIGNATURES);
}
