import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, validateSetting } from "../dist/settings.js";

test("ai.memoryEnabled is an unseeded override so providers keep native defaults", () => {
  // Intentionally absent from DEFAULT_SETTINGS: when unset, each provider falls
  // back to its own native memory default (Codex off, Claude on).
  assert.ok(!("ai.memoryEnabled" in DEFAULT_SETTINGS));
});

test("ai.memoryEnabled validates and coerces boolean-ish values when set", () => {
  assert.equal(validateSetting("ai.memoryEnabled", true), true);
  assert.equal(validateSetting("ai.memoryEnabled", false), false);
  // Mirrors the coercion the other boolean settings (e.g. codex.fastMode) accept
  // from the patchdollctl/Slack string path.
  assert.equal(validateSetting("ai.memoryEnabled", "off"), false);
  assert.equal(validateSetting("ai.memoryEnabled", "true"), true);
});

test("ai.memoryEnabled rejects non-boolean values", () => {
  assert.throws(() => validateSetting("ai.memoryEnabled", "maybe"));
  assert.throws(() => validateSetting("ai.memoryEnabled", 2));
});
