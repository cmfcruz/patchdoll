import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rolloutExistsForSession } from "../dist/codexProvider.js";

const SESSION_ID = "0123abcd-1234-5678-9abc-def012345678";

async function makeCodexHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "patchdoll-codex-preflight-"));
}

test("rolloutExistsForSession finds a rollout file by its session UUID", async () => {
  const home = await makeCodexHome();
  try {
    const dir = join(home, "sessions", "2026", "06", "04");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-06-04T00-00-00-${SESSION_ID}.jsonl`),
      "{}\n"
    );
    assert.equal(await rolloutExistsForSession(home, SESSION_ID), true);
    // Case-insensitive match.
    assert.equal(
      await rolloutExistsForSession(home, SESSION_ID.toUpperCase()),
      true
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rolloutExistsForSession returns false when no rollout matches", async () => {
  const home = await makeCodexHome();
  try {
    const dir = join(home, "sessions", "2026", "06", "04");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-2026-06-04T00-00-00-ffffffff-0000-0000-0000-000000000000.jsonl"),
      "{}\n"
    );
    assert.equal(await rolloutExistsForSession(home, SESSION_ID), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rolloutExistsForSession returns false when the sessions dir is absent", async () => {
  const home = await makeCodexHome();
  try {
    assert.equal(await rolloutExistsForSession(home, SESSION_ID), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rolloutExistsForSession returns false for an empty session id", async () => {
  const home = await makeCodexHome();
  try {
    assert.equal(await rolloutExistsForSession(home, ""), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
