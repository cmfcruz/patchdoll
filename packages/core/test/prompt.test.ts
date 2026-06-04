import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPatchdollPrompt } from "../dist/prompt.js";

test("buildPatchdollPrompt includes Slack missing-scope remediation", () => {
  const prompt = buildPatchdollPrompt({
    agentsMd: "",
    config: {
      actorIsAdmin: true,
      capabilities: {}
    },
    event: {
      id: "event-1",
      source: "slack",
      kind: "slack.app_mention",
      actor: "U123",
      body: "summarize this thread",
      receivedAt: "2026-06-04T00:00:00.000Z",
      raw: {},
      metadata: {
        channelId: "C123",
        threadTs: "1780584649.493209",
        threadContext: {
          available: false,
          reason: "slack_missing_scope",
          requiredScopes: ["channels:history"],
          remediation: "Add channels:history and reinstall the app."
        }
      }
    }
  }, {
    agentName: "Codex",
    settingsExample: "{\"codex\":{\"model\":\"gpt-5.5\"}}"
  });

  assert.match(prompt, /Slack thread transcript:/);
  assert.match(prompt, /unavailable: slack_missing_scope/);
  assert.match(prompt, /required Slack bot scope\(s\): channels:history/);
  assert.match(prompt, /remediation: Add channels:history and reinstall the app\./);
});
