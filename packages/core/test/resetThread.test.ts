import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildResetThreadResult,
  isResetThreadCommand
} from "../dist/resetThread.js";

test("isResetThreadCommand matches explicit commands, ignoring case/space/punctuation", () => {
  for (const body of [
    "reset thread",
    "Reset Thread",
    "  reset   thread  ",
    "reset thread.",
    "reset this thread",
    "start fresh!"
  ]) {
    assert.equal(isResetThreadCommand(body), true, `expected match for: ${body}`);
  }
});

test("isResetThreadCommand does NOT match prose that merely mentions reset", () => {
  for (const body of [
    "please reset the thread for me",
    "can you start fresh after lunch?",
    "reset",
    "let's reset thread state in the db",
    "thread reset",
    "",
    undefined
  ]) {
    assert.equal(
      isResetThreadCommand(body),
      false,
      `expected NO match for: ${String(body)}`
    );
  }
});

test("buildResetThreadResult denies non-admins without clearing", () => {
  const result = buildResetThreadResult({
    provider: "codex",
    threadKey: "slack:C1:1",
    actorIsAdmin: false,
    cleared: false
  });
  assert.match(result.reply ?? "", /only an admin/i);
  assert.equal(result.metadata?.resetThread, true);
  assert.equal(result.metadata?.cleared, false);
  assert.equal(result.proposedActions?.[0]?.type, "chat.reply");
});

test("buildResetThreadResult confirms a cleared session for admins", () => {
  const result = buildResetThreadResult({
    provider: "claude",
    threadKey: "slack:C1:1",
    actorIsAdmin: true,
    cleared: true
  });
  assert.match(result.reply ?? "", /cleared/i);
  assert.equal(result.metadata?.cleared, true);
});

test("buildResetThreadResult reports nothing-to-clear for admins with no session", () => {
  const result = buildResetThreadResult({
    provider: "codex",
    threadKey: "slack:C1:1",
    actorIsAdmin: true,
    cleared: false
  });
  assert.match(result.reply ?? "", /nothing to clear/i);
  assert.equal(result.metadata?.cleared, false);
});
