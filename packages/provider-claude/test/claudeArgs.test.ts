import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeArgs } from "../dist/claudeProvider.js";

const baseInvocation = {
  instructionsFile: "/etc/agent/CLAUDE.md",
  prompt: "hello",
  workdir: "/workspace",
  model: "sonnet",
  effort: "medium",
  permissionMode: "default",
  maxTurns: 0,
  memoryEnabled: true,
  runtimeEnv: {}
};

test("claudeArgs disallows interactive user questions when requested", () => {
  const args = claudeArgs({
    ...baseInvocation,
    suppressInteractiveTools: true
  });

  const flagIndex = args.indexOf("--disallowedTools");
  assert.notEqual(flagIndex, -1);
  assert.equal(args[flagIndex + 1], "AskUserQuestion");
});

test("claudeArgs leaves interactive tools available outside suppressed runs", () => {
  const args = claudeArgs({
    ...baseInvocation,
    suppressInteractiveTools: false
  });

  assert.equal(args.includes("--disallowedTools"), false);
});
