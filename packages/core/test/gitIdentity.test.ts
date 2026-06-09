import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureGitAuthorIdentity } from "../dist/gitIdentity.js";

interface Call {
  file: string;
  args: readonly string[];
}

function mockExecFile(calls: Call[]) {
  return async (file: string, args: readonly string[]) => {
    calls.push({ file, args });
    const command = [file, ...args].join(" ");
    if (command === "git config --global --get user.name") {
      throw new Error("unset");
    }
    if (command === "git config --global --get user.email") {
      throw new Error("unset");
    }
    if (command === "gh auth status --hostname github.com") {
      return {
        stdout: "github.com\n  ✓ Logged in to github.com as patchdoll-daisy[bot] (GH_TOKEN)\n",
        stderr: ""
      };
    }
    if (command === "gh api users/patchdoll-daisy%5Bbot%5D --jq .id") {
      return { stdout: "290106101\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

test("infers a bot noreply git identity from gh", async () => {
  const calls: Call[] = [];
  await ensureGitAuthorIdentity({
    env: { GH_TOKEN: "redacted" },
    execFile: mockExecFile(calls)
  });

  assert.deepEqual(
    calls.map((call) => [call.file, ...call.args]),
    [
      ["git", "config", "--global", "--get", "user.name"],
      ["git", "config", "--global", "--get", "user.email"],
      ["gh", "auth", "status", "--hostname", "github.com"],
      ["gh", "api", "users/patchdoll-daisy%5Bbot%5D", "--jq", ".id"],
      ["git", "config", "--global", "--replace-all", "user.name", "patchdoll-daisy[bot]"],
      [
        "git",
        "config",
        "--global",
        "--replace-all",
        "user.email",
        "290106101+patchdoll-daisy[bot]@users.noreply.github.com"
      ]
    ]
  );
});

test("uses explicit Patchdoll git identity when both env vars are set", async () => {
  const oldName = process.env.PATCHDOLL_GIT_USER_NAME;
  const oldEmail = process.env.PATCHDOLL_GIT_USER_EMAIL;
  process.env.PATCHDOLL_GIT_USER_NAME = "Patchdoll";
  process.env.PATCHDOLL_GIT_USER_EMAIL = "patchdoll@example.com";
  try {
    const calls: Call[] = [];
    await ensureGitAuthorIdentity({ env: {}, execFile: mockExecFile(calls) });

    assert.deepEqual(
      calls.map((call) => [call.file, ...call.args]),
      [
        ["git", "config", "--global", "--replace-all", "user.name", "Patchdoll"],
        [
          "git",
          "config",
          "--global",
          "--replace-all",
          "user.email",
          "patchdoll@example.com"
        ]
      ]
    );
  } finally {
    if (oldName === undefined) delete process.env.PATCHDOLL_GIT_USER_NAME;
    else process.env.PATCHDOLL_GIT_USER_NAME = oldName;
    if (oldEmail === undefined) delete process.env.PATCHDOLL_GIT_USER_EMAIL;
    else process.env.PATCHDOLL_GIT_USER_EMAIL = oldEmail;
  }
});
