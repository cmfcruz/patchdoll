import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeStreamParser } from "../dist/claudeProvider.js";

interface Captured {
  progress: Array<{ message: string; kind?: string; tool?: string }>;
  resultLines: string[];
}

function collect(): {
  parser: ReturnType<typeof createClaudeStreamParser>;
  captured: Captured;
} {
  const captured: Captured = { progress: [], resultLines: [] };
  const parser = createClaudeStreamParser({
    onProgress: (event) => {
      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      captured.progress.push({
        message: event.message,
        kind: typeof metadata.kind === "string" ? metadata.kind : undefined,
        tool: typeof metadata.tool === "string" ? metadata.tool : undefined
      });
    },
    onResultLine: (line) => captured.resultLines.push(line)
  });
  return { parser, captured };
}

function streamEvent(event: unknown): string {
  return JSON.stringify({ type: "stream_event", event });
}

function textDelta(text: string): string {
  return streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text } });
}

test("accumulates text_delta into a cumulative, visible draft", () => {
  const { parser, captured } = collect();
  parser.push(textDelta("Check") + "\n");
  parser.push(textDelta("ing the ") + "\n");
  parser.push(textDelta("provider.") + "\n");

  assert.deepEqual(
    captured.progress.map((p) => p.message),
    ["Check", "Checking the ", "Checking the provider."]
  );
  for (const p of captured.progress) assert.equal(p.kind, "text_delta");
});

test("streams only visible text — skips thinking and tool-input deltas", () => {
  const { parser, captured } = collect();
  parser.push(streamEvent({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "secret" } }) + "\n");
  parser.push(streamEvent({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"a\":" } }) + "\n");
  parser.push(textDelta("visible") + "\n");

  assert.deepEqual(captured.progress.map((p) => p.message), ["visible"]);
});

test("message_start resets the draft for a new assistant turn", () => {
  const { parser, captured } = collect();
  parser.push(textDelta("first") + "\n");
  parser.push(streamEvent({ type: "message_start" }) + "\n");
  parser.push(textDelta("second") + "\n");

  assert.deepEqual(captured.progress.map((p) => p.message), ["first", "second"]);
});

test("reassembles deltas split across chunk boundaries", () => {
  const { parser, captured } = collect();
  const line = textDelta("hello world") + "\n";
  parser.push(line.slice(0, 10));
  parser.push(line.slice(10, 25));
  parser.push(line.slice(25));

  assert.deepEqual(captured.progress.map((p) => p.message), ["hello world"]);
});

test("surfaces tool_use from the consolidated assistant message", () => {
  const { parser, captured } = collect();
  parser.push(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: {} }] }
  }) + "\n");

  assert.equal(captured.progress.length, 1);
  assert.equal(captured.progress[0].message, "Using tool: Read");
  assert.equal(captured.progress[0].kind, "tool_use");
  assert.equal(captured.progress[0].tool, "Read");
});

test("suppresses the assistant text block once it was streamed live", () => {
  const { parser, captured } = collect();
  parser.push(textDelta("Hello there") + "\n");
  parser.push(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Hello there" }] }
  }) + "\n");

  // Only the live delta — no duplicate snippet clobbering the draft.
  assert.deepEqual(captured.progress.map((p) => p.message), ["Hello there"]);
});

test("falls back to assistant text when no deltas were seen", () => {
  const { parser, captured } = collect();
  parser.push(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "No partials here" }] }
  }) + "\n");

  assert.deepEqual(captured.progress.map((p) => ({ message: p.message, kind: p.kind })), [
    { message: "No partials here", kind: "text" }
  ]);
});

test("routes the final result line to onResultLine, not progress", () => {
  const { parser, captured } = collect();
  const resultLine = JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "abc" });
  parser.push(textDelta("working") + "\n");
  parser.push(resultLine + "\n");

  assert.deepEqual(captured.resultLines, [resultLine]);
  assert.deepEqual(captured.progress.map((p) => p.message), ["working"]);
});

test("ignores malformed JSON and non-object lines", () => {
  const { parser, captured } = collect();
  parser.push("not json\n");
  parser.push("[1,2,3]\n");
  parser.push("null\n");
  parser.push(textDelta("ok") + "\n");

  assert.deepEqual(captured.progress.map((p) => p.message), ["ok"]);
  assert.equal(captured.resultLines.length, 0);
});

test("flush consumes a trailing line with no newline", () => {
  const { parser, captured } = collect();
  parser.push(textDelta("partial"));
  assert.equal(captured.progress.length, 0, "no newline yet → buffered");
  parser.flush();
  assert.deepEqual(captured.progress.map((p) => p.message), ["partial"]);
});

test("emits the tail once the draft outgrows the limit", () => {
  const { parser, captured } = collect();
  const big = "x".repeat(2000);
  parser.push(textDelta(big) + "\n");

  const last = captured.progress.at(-1)!.message;
  assert.ok(last.length <= 1501, `expected tail-capped draft, got ${last.length}`);
  assert.ok(last.startsWith("…"), "expected ellipsis prefix on truncated draft");
  assert.ok(last.endsWith("x"), "expected the most recent text to be retained");
});
