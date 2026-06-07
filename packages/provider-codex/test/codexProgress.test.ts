import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizedCodexProgressEvent } from "../dist/codexProvider.js";

test("function_call surfaces a friendly, tool-named action instead of canned text", () => {
  const edit = summarizedCodexProgressEvent(
    JSON.stringify({ type: "function_call", name: "apply_patch" })
  );
  assert.equal(edit?.message, "Editing files.");
  assert.equal(edit?.metadata?.tool, "apply_patch");

  const run = summarizedCodexProgressEvent(
    JSON.stringify({ type: "function_call", name: "exec_command" })
  );
  assert.equal(run?.message, "Running a command.");
});

test("agent_message narration is summarized to the shared length cap", () => {
  const long = "I am ".concat("really ".repeat(80), "done");
  const event = summarizedCodexProgressEvent(
    JSON.stringify({ type: "agent_message", message: long })
  );
  assert.ok(event);
  assert.equal(event.metadata?.kind, "agent_message");
  assert.ok(event.message.length <= 200);
});

test("final-answer agent messages are not surfaced as progress", () => {
  const event = summarizedCodexProgressEvent(
    JSON.stringify({
      type: "agent_message",
      message: "Here is the final answer.",
      phase: "final_answer"
    })
  );
  assert.equal(event, undefined);
});

test("reasoning events stay filtered out (no chain-of-thought leak)", () => {
  const event = summarizedCodexProgressEvent(
    JSON.stringify({
      type: "response_item",
      payload: { type: "reasoning", text: "secret thoughts" }
    })
  );
  assert.equal(event, undefined);
});
