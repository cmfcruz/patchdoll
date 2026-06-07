// Shared status-update summarizer used by every AI provider so Slack progress
// updates feel the same regardless of which agent is running. Providers parse
// their own native event streams, but they funnel the user-visible text through
// these helpers so Claude and Codex surface consistent, concise, safe summaries
// instead of two independently hand-tuned vocabularies.
//
// Safety: these helpers summarize *visible* agent output and tool activity only.
// They are never given raw chain-of-thought / hidden reasoning — providers must
// filter those events out before they reach here.

// Upper bound on a single progress line, applied before Slack's own sanitizer
// trims further. Keeping it provider-side means both agents truncate narration
// at the same point rather than relying on the adapter's wider cap.
export const PROGRESS_TEXT_LIMIT = 200;

const ELLIPSIS = "…";

// Tool/command identifiers grouped by what the user actually cares about: what
// kind of work is happening, not the internal tool name. Keys are lowercased.
// Both Claude tool names and Codex function-call names are covered so the two
// providers describe the same activity with the same words.
const EDIT_TOOLS = new Set([
  "apply_patch",
  "edit",
  "multiedit",
  "write",
  "str_replace",
  "str_replace_editor",
  "notebookedit"
]);
const RUN_TOOLS = new Set([
  "exec_command",
  "bash",
  "shell",
  "local_shell",
  "run_terminal_cmd"
]);
const READ_TOOLS = new Set(["read", "view", "cat"]);
const SEARCH_TOOLS = new Set([
  "grep",
  "glob",
  "search",
  "codebase_search",
  "ripgrep"
]);
const WEB_TOOLS = new Set(["webfetch", "websearch", "web_search", "fetch"]);

// Collapse and clamp a stretch of visible agent narration into a single concise
// progress line. Returns undefined when there is nothing worth showing so the
// caller can skip emitting an empty update.
export function summarizeProgressText(
  text: string | undefined | null
): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }

  if (collapsed.length <= PROGRESS_TEXT_LIMIT) {
    return collapsed;
  }

  return `${collapsed.slice(0, PROGRESS_TEXT_LIMIT - 1).trimEnd()}${ELLIPSIS}`;
}

// Friendly, user-facing description of a tool/command invocation. Maps known
// tool names to a plain-language action and falls back to a generic "Using
// <tool>" for anything unrecognized, mirroring how Claude already names tools.
export function toolActivityMessage(tool: string | undefined | null): string {
  const raw = typeof tool === "string" ? tool.trim() : "";
  if (!raw) {
    return "Working on it.";
  }

  const key = raw.toLowerCase();
  if (EDIT_TOOLS.has(key)) {
    return "Editing files.";
  }
  if (RUN_TOOLS.has(key)) {
    return "Running a command.";
  }
  if (READ_TOOLS.has(key)) {
    return "Reading the code.";
  }
  if (SEARCH_TOOLS.has(key)) {
    return "Searching the code.";
  }
  if (WEB_TOOLS.has(key)) {
    return "Looking something up.";
  }

  return `Using ${raw}.`;
}
