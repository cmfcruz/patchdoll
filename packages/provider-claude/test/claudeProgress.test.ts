import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProgressEvent } from "@patchdoll/core";
import { createClaudeStreamParser } from "../dist/claudeProvider.js";

// Drives the public stream parser with whole `type:"assistant"` lines and
// collects the progress events it emits, so we test the same surface the
// provider runs in production rather than an internal helper.
function progressFrom(line: Record<string, unknown>): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  const parser = createClaudeStreamParser({
    onProgress: (e) => events.push(e),
    onResultLine: () => {}
  });
  parser.push(`${JSON.stringify(line)}\n`);
  return events;
}

function assistant(content: unknown): Record<string, unknown> {
  return { type: "assistant", message: { content } };
}

test("tool_use describes the activity the same way Codex does", () => {
  // Claude's Edit/Write and Codex's apply_patch must read identically.
  const [edit] = progressFrom(assistant([{ type: "tool_use", name: "Edit" }]));
  assert.equal(edit?.message, "Editing files.");
  assert.equal(edit?.metadata?.tool, "Edit");

  const [run] = progressFrom(assistant([{ type: "tool_use", name: "Bash" }]));
  assert.equal(run?.message, "Running a command.");
});

test("assistant text fallback is summarized to the shared length cap", () => {
  const long = "Looking at ".concat("the config ".repeat(50), "now");
  const [event] = progressFrom(assistant([{ type: "text", text: long }]));
  assert.ok(event);
  assert.equal(event.metadata?.kind, "text");
  assert.ok(event.message.length <= 200);
});

test("non-assistant lines and empty text produce no progress", () => {
  assert.deepEqual(progressFrom({ type: "system" }), []);
  assert.deepEqual(progressFrom(assistant([{ type: "text", text: "   " }])), []);
});
