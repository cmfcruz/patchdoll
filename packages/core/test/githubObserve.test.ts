import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  githubObserveConfigFromEnv,
  githubObserveDecision,
  isGithubObserveEvent,
  needsGithubObserveRuntimeStatus,
  readGithubObserveRuntimeStatus
} from "../dist/githubObserve.js";

const AVAILABLE = { state: "available" } as const;

test("dispatches issue opened and edited events when issue intake is enabled", () => {
  for (const eventKey of ["issues.opened", "issues.edited"]) {
    const decision = githubObserveDecision(
      observeEvent(eventKey),
      { issuesEnabled: true, prsEnabled: false },
      AVAILABLE
    );

    assert.equal(decision.dispatch, true);
    if (decision.dispatch) {
      assert.equal(decision.target.mode, "issue-content-intake");
      assert.equal(decision.target.number, 51);
    }
  }
});

test("dispatches PR opened and synchronize events when PR intake is enabled", () => {
  for (const eventKey of ["pull_request.opened", "pull_request.synchronize"]) {
    const decision = githubObserveDecision(
      observeEvent(eventKey),
      { issuesEnabled: false, prsEnabled: true },
      AVAILABLE
    );

    assert.equal(decision.dispatch, true);
    if (decision.dispatch) {
      assert.equal(decision.target.mode, "pr-code-intake");
      assert.equal(decision.target.number, 51);
    }
  }
});

test("does not dispatch comment events for intake review", () => {
  for (const eventKey of [
    "issue_comment.created",
    "issue_comment.edited",
    "pull_request_review_comment.created",
    "pull_request_review_comment.edited"
  ]) {
    assert.equal(isGithubObserveEvent(eventKey), false);

    const decision = githubObserveDecision(
      observeEvent(eventKey),
      { issuesEnabled: true, prsEnabled: true },
      AVAILABLE
    );

    assert.deepEqual(decision, {
      dispatch: false,
      reason: "unsupported_event"
    });
  }
});

test("requires the matching feature gate", () => {
  assert.deepEqual(
    githubObserveDecision(
      observeEvent("issues.opened"),
      { issuesEnabled: false, prsEnabled: true },
      AVAILABLE
    ),
    {
      dispatch: false,
      reason: "feature_disabled",
      mode: "issue-content-intake"
    }
  );

  assert.deepEqual(
    githubObserveDecision(
      observeEvent("pull_request.opened"),
      { issuesEnabled: true, prsEnabled: false },
      AVAILABLE
    ),
    {
      dispatch: false,
      reason: "feature_disabled",
      mode: "pr-code-intake"
    }
  );
});

test("does not need runtime status until a matching feature gate can dispatch", () => {
  assert.equal(
    needsGithubObserveRuntimeStatus(
      observeEvent("issues.opened"),
      { issuesEnabled: false, prsEnabled: true }
    ),
    false
  );
  assert.equal(
    needsGithubObserveRuntimeStatus(
      observeEvent("issues.opened"),
      { issuesEnabled: true, prsEnabled: false }
    ),
    true
  );
  assert.equal(
    needsGithubObserveRuntimeStatus(
      observeEvent("pull_request.opened"),
      { issuesEnabled: true, prsEnabled: false }
    ),
    false
  );
  assert.equal(
    needsGithubObserveRuntimeStatus(
      { ...observeEvent("pull_request.opened"), number: undefined },
      { issuesEnabled: true, prsEnabled: true }
    ),
    false
  );
  assert.equal(
    needsGithubObserveRuntimeStatus(
      observeEvent("issue_comment.created"),
      { issuesEnabled: true, prsEnabled: true }
    ),
    false
  );
});

test("requires an available observe runtime", () => {
  assert.deepEqual(
    githubObserveDecision(
      observeEvent("issues.opened"),
      { issuesEnabled: true, prsEnabled: true },
      { state: "disabled" }
    ),
    {
      dispatch: false,
      reason: "runtime_disabled",
      mode: "issue-content-intake",
      runtimeState: "disabled",
      runtimeReason: undefined
    }
  );

  assert.deepEqual(
    githubObserveDecision(
      observeEvent("pull_request.opened"),
      { issuesEnabled: true, prsEnabled: true },
      { state: "missing", reason: "runtime_status_missing" }
    ),
    {
      dispatch: false,
      reason: "runtime_unavailable",
      mode: "pr-code-intake",
      runtimeState: "missing",
      runtimeReason: "runtime_status_missing"
    }
  );
});

test("parses observe feature gates from environment-style values", () => {
  assert.deepEqual(
    githubObserveConfigFromEnv({
      PATCHDOLL_GITHUB_OBSERVE_ISSUES_ENABLED: "yes",
      PATCHDOLL_GITHUB_OBSERVE_PRS_ENABLED: "0"
    }),
    {
      issuesEnabled: true,
      prsEnabled: false
    }
  );
});

test("reads observe runtime status files", async () => {
  const dir = join(process.cwd(), ".cache", "github-observe-test");
  const path = join(dir, "runtime.env");

  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    path,
    [
      "PATCHDOLL_GITHUB_OBSERVE_RUNTIME_STATUS=unavailable",
      "PATCHDOLL_GITHUB_OBSERVE_RUNTIME_REASON=worker_image_missing"
    ].join("\n"),
    "utf8"
  );

  assert.deepEqual(await readGithubObserveRuntimeStatus(path), {
    state: "unavailable",
    reason: "worker_image_missing"
  });

  await writeFile(path, "PATCHDOLL_GITHUB_OBSERVE_RUNTIME_STATUS=nope\n", "utf8");
  assert.deepEqual(await readGithubObserveRuntimeStatus(path), {
    state: "invalid",
    reason: "runtime_status_invalid"
  });

  await rm(dir, { force: true, recursive: true });
});

function observeEvent(eventKey: string) {
  const separator = eventKey.indexOf(".");
  return {
    deliveryId: "delivery-1",
    repository: "cmfcruz/patchdoll",
    eventName: eventKey.slice(0, separator),
    action: eventKey.slice(separator + 1),
    eventKey,
    number: 51,
    htmlUrl: "https://github.com/cmfcruz/patchdoll/issues/51"
  };
}
