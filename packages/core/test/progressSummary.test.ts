import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROGRESS_TEXT_LIMIT,
  summarizeProgressText,
  toolActivityMessage
} from "../dist/progressSummary.js";

test("summarizeProgressText collapses whitespace and trims", () => {
  assert.equal(
    summarizeProgressText("  Looking   at\nthe  config  "),
    "Looking at the config"
  );
});

test("summarizeProgressText returns undefined for empty or non-string input", () => {
  assert.equal(summarizeProgressText(""), undefined);
  assert.equal(summarizeProgressText("   \n  "), undefined);
  assert.equal(summarizeProgressText(undefined), undefined);
  assert.equal(summarizeProgressText(null), undefined);
});

test("summarizeProgressText caps long text at the shared limit with an ellipsis", () => {
  const long = "x".repeat(PROGRESS_TEXT_LIMIT + 50);
  const summary = summarizeProgressText(long);
  assert.ok(summary);
  assert.equal(summary.length, PROGRESS_TEXT_LIMIT);
  assert.ok(summary.endsWith("…"));
});

test("summarizeProgressText leaves text at the limit untouched", () => {
  const exact = "y".repeat(PROGRESS_TEXT_LIMIT);
  assert.equal(summarizeProgressText(exact), exact);
});

test("toolActivityMessage maps Claude and Codex tool names to the same action", () => {
  // Editing — Claude (Edit/Write) and Codex (apply_patch) describe it identically.
  assert.equal(toolActivityMessage("Edit"), "Editing files.");
  assert.equal(toolActivityMessage("Write"), "Editing files.");
  assert.equal(toolActivityMessage("apply_patch"), "Editing files.");

  // Running a command — Claude (Bash) and Codex (exec_command).
  assert.equal(toolActivityMessage("Bash"), "Running a command.");
  assert.equal(toolActivityMessage("exec_command"), "Running a command.");

  // Searching/reading the code, regardless of provider casing.
  assert.equal(toolActivityMessage("Grep"), "Searching the code.");
  assert.equal(toolActivityMessage("read"), "Reading the code.");
});

test("toolActivityMessage falls back to a generic, tool-named message", () => {
  assert.equal(toolActivityMessage("mcp__weather"), "Using mcp__weather.");
});

test("toolActivityMessage handles missing tool names", () => {
  assert.equal(toolActivityMessage(undefined), "Working on it.");
  assert.equal(toolActivityMessage(""), "Working on it.");
  assert.equal(toolActivityMessage("   "), "Working on it.");
});
