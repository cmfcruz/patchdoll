import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { patchdollSecret, readPatchdollSecrets } from "../dist/secrets.js";

test("readPatchdollSecrets merges runtime secret files with later paths winning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patchdoll-secrets-"));
  try {
    const preferred = join(dir, "patchdoll.env");
    const fallback = join(dir, "secrets.env");
    await writeFile(preferred, "PATCHDOLL_SLACK_BOT_TOKEN=preferred\nSHARED=preferred\n");
    await writeFile(fallback, "SHARED=fallback\nPATCHDOLL_GITHUB_WEBHOOK_SECRET=fallback\n");

    assert.deepEqual(await readPatchdollSecrets([preferred, fallback]), {
      PATCHDOLL_SLACK_BOT_TOKEN: "preferred",
      SHARED: "fallback",
      PATCHDOLL_GITHUB_WEBHOOK_SECRET: "fallback"
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("patchdollSecret only accepts process env when explicitly allowed", async () => {
  const previousSecret = process.env.PATCHDOLL_TEST_SECRET;
  const previousAllowed = process.env.PATCHDOLL_SECRETS_ENV_ALLOWED;
  process.env.PATCHDOLL_TEST_SECRET = "from-env";
  delete process.env.PATCHDOLL_SECRETS_ENV_ALLOWED;

  try {
    assert.equal(await patchdollSecret("PATCHDOLL_TEST_SECRET", []), undefined);

    process.env.PATCHDOLL_SECRETS_ENV_ALLOWED = "1";
    assert.equal(await patchdollSecret("PATCHDOLL_TEST_SECRET", []), "from-env");
  } finally {
    if (previousSecret === undefined) {
      delete process.env.PATCHDOLL_TEST_SECRET;
    } else {
      process.env.PATCHDOLL_TEST_SECRET = previousSecret;
    }

    if (previousAllowed === undefined) {
      delete process.env.PATCHDOLL_SECRETS_ENV_ALLOWED;
    } else {
      process.env.PATCHDOLL_SECRETS_ENV_ALLOWED = previousAllowed;
    }
  }
});
