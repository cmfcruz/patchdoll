import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPatchdollPrompt } from "../dist/prompt.js";
import type { TaskContext } from "../dist/types.js";

function task(source: TaskContext["event"]["source"]): TaskContext {
  return {
    event: {
      id: "evt-1",
      source,
      kind: "test",
      body: "hello"
    },
    config: {
      actorIsAdmin: false
    }
  };
}

test("buildPatchdollPrompt tells Slack runs to avoid interactive user-input tools", () => {
  const prompt = buildPatchdollPrompt(task("slack"), {
    agentName: "Codex CLI",
    settingsExample: "{}"
  });

  assert.match(prompt, /cannot show interactive pickers or use user-input tools/i);
  assert.match(prompt, /ask as normal assistant text/i);
});

test("buildPatchdollPrompt does not add Slack-only interactive guidance elsewhere", () => {
  const prompt = buildPatchdollPrompt(task("github"), {
    agentName: "Codex CLI",
    settingsExample: "{}"
  });

  assert.doesNotMatch(prompt, /cannot show interactive pickers/i);
});
