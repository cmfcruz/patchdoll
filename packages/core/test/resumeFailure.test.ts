import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_RESUME_FAILURE_SIGNATURES,
  CODEX_RESUME_FAILURE_SIGNATURES,
  isClaudeResumeFailure,
  isCodexResumeFailure,
  matchResumeFailure
} from "../dist/resumeFailure.js";

test("matchResumeFailure finds a signature case- and whitespace-insensitively", () => {
  const result = matchResumeFailure(
    "Codex CLI exited with 1:   No   Rollout\n  Found for session abc",
    CODEX_RESUME_FAILURE_SIGNATURES
  );
  assert.equal(result.matched, true);
  assert.equal(result.signature, "no rollout found");
});

test("matchResumeFailure returns no match for unrelated errors", () => {
  const result = matchResumeFailure(
    "Codex CLI timed out after 600000ms",
    CODEX_RESUME_FAILURE_SIGNATURES
  );
  assert.equal(result.matched, false);
  assert.equal(result.signature, undefined);
});

test("isCodexResumeFailure classifies a missing rollout as resume failure", () => {
  const error = new Error("Codex CLI exited with 1: no rollout found");
  assert.equal(isCodexResumeFailure(error).matched, true);
});

test("isCodexResumeFailure does NOT self-heal on generic failures", () => {
  for (const message of [
    "Codex CLI timed out after 600000ms",
    "Codex CLI exited with 1: 401 Unauthorized",
    "Codex AI concurrency limit reached",
    "Codex CLI failed to start (codex): ENOENT"
  ]) {
    assert.equal(
      isCodexResumeFailure(new Error(message)).matched,
      false,
      `expected no resume match for: ${message}`
    );
  }
});

test("isClaudeResumeFailure classifies a missing conversation as resume failure", () => {
  const error = new Error(
    "Claude Code exited with 1: No conversation found with session ID: 123"
  );
  const result = isClaudeResumeFailure(error);
  assert.equal(result.matched, true);
  assert.equal(result.signature, "no conversation found");
});

test("isClaudeResumeFailure does NOT self-heal on generic failures", () => {
  for (const message of [
    "Claude Code timed out after 600000ms",
    "Claude Code exited with 1: 529 Overloaded",
    "Claude Code returned invalid JSON: Unexpected end of input",
    "Claude AI concurrency limit reached"
  ]) {
    assert.equal(
      isClaudeResumeFailure(new Error(message)).matched,
      false,
      `expected no resume match for: ${message}`
    );
  }
});

test("classifiers accept non-Error thrown values", () => {
  assert.equal(isCodexResumeFailure("no rollout found").matched, true);
  assert.equal(isClaudeResumeFailure({ unexpected: true }).matched, false);
});

test("signature lists are non-empty", () => {
  assert.ok(CODEX_RESUME_FAILURE_SIGNATURES.length > 0);
  assert.ok(CLAUDE_RESUME_FAILURE_SIGNATURES.length > 0);
});
