import { readFile } from "node:fs/promises";
import { stringifyLogJson } from "./log.js";

export const GITHUB_OBSERVE_RUNTIME_STATUS_PATH = "/run/patchdoll/github-observe-runtime.env";

export type GithubObserveMode = "issue-content-intake" | "pr-code-intake";

export type GithubObserveRuntimeState =
  | "available"
  | "disabled"
  | "unavailable"
  | "missing"
  | "invalid";

export type GithubObserveSkipReason =
  | "unsupported_event"
  | "feature_disabled"
  | "missing_target"
  | "runtime_disabled"
  | "runtime_unavailable";

export interface GithubObserveConfig {
  issuesEnabled: boolean;
  prsEnabled: boolean;
}

export interface GithubObserveRuntimeStatus {
  state: GithubObserveRuntimeState;
  reason?: string;
}

export interface GithubObserveWebhookEvent {
  deliveryId: string;
  repository: string;
  eventName: string;
  action: string;
  eventKey: string;
  number?: number;
  htmlUrl?: string;
}

export interface GithubObserveTarget {
  mode: GithubObserveMode;
  deliveryId: string;
  repository: string;
  number: number;
  eventName: string;
  action: string;
  eventKey: string;
  htmlUrl?: string;
}

export type GithubObserveDecision =
  | {
      dispatch: true;
      target: GithubObserveTarget;
    }
  | {
      dispatch: false;
      reason: GithubObserveSkipReason;
      mode?: GithubObserveMode;
      runtimeState?: GithubObserveRuntimeState;
      runtimeReason?: string;
    };

export interface GithubObserveDispatcher {
  dispatch(target: GithubObserveTarget): void | Promise<void>;
}

const OBSERVE_EVENT_MODES = new Map<string, GithubObserveMode>([
  ["issues.opened", "issue-content-intake"],
  ["issues.edited", "issue-content-intake"],
  ["pull_request.opened", "pr-code-intake"],
  ["pull_request.synchronize", "pr-code-intake"]
]);

const LOG_ONLY_GITHUB_OBSERVE_DISPATCHER: GithubObserveDispatcher = {
  dispatch(target) {
    logGithubObserveTrace("GitHub observe dispatch seam reached", {
      ...githubObserveTargetLogSummary(target),
      status: "worker_not_implemented"
    });
  }
};

export function githubObserveConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): GithubObserveConfig {
  return {
    issuesEnabled: isEnabled(env.PATCHDOLL_GITHUB_OBSERVE_ISSUES_ENABLED),
    prsEnabled: isEnabled(env.PATCHDOLL_GITHUB_OBSERVE_PRS_ENABLED)
  };
}

export function isGithubObserveEvent(eventKey: string): boolean {
  return OBSERVE_EVENT_MODES.has(eventKey);
}

export async function readGithubObserveRuntimeStatus(
  path = GITHUB_OBSERVE_RUNTIME_STATUS_PATH
): Promise<GithubObserveRuntimeStatus> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { state: "missing", reason: "runtime_status_missing" };
    }
    return { state: "unavailable", reason: "runtime_status_unreadable" };
  }

  const values = parseRuntimeStatusFile(raw);
  const state = values.PATCHDOLL_GITHUB_OBSERVE_RUNTIME_STATUS;
  const reason = nonEmptyString(values.PATCHDOLL_GITHUB_OBSERVE_RUNTIME_REASON);

  if (state === "available" || state === "disabled" || state === "unavailable") {
    return { state, reason };
  }

  return { state: "invalid", reason: reason ?? "runtime_status_invalid" };
}

export function githubObserveDecision(
  event: GithubObserveWebhookEvent,
  config: GithubObserveConfig,
  runtime: GithubObserveRuntimeStatus
): GithubObserveDecision {
  const mode = OBSERVE_EVENT_MODES.get(event.eventKey);
  if (!mode) {
    return { dispatch: false, reason: "unsupported_event" };
  }

  if (event.number === undefined) {
    return { dispatch: false, reason: "missing_target", mode };
  }

  if (
    (mode === "issue-content-intake" && !config.issuesEnabled) ||
    (mode === "pr-code-intake" && !config.prsEnabled)
  ) {
    return { dispatch: false, reason: "feature_disabled", mode };
  }

  if (runtime.state !== "available") {
    return {
      dispatch: false,
      reason: runtime.state === "disabled" ? "runtime_disabled" : "runtime_unavailable",
      mode,
      runtimeState: runtime.state,
      runtimeReason: runtime.reason
    };
  }

  return {
    dispatch: true,
    target: {
      mode,
      deliveryId: event.deliveryId,
      repository: event.repository,
      number: event.number,
      eventName: event.eventName,
      action: event.action,
      eventKey: event.eventKey,
      htmlUrl: event.htmlUrl
    }
  };
}

export function scheduleGithubObserveDispatch(
  target: GithubObserveTarget,
  dispatcher: GithubObserveDispatcher = LOG_ONLY_GITHUB_OBSERVE_DISPATCHER
): void {
  logGithubObserveTrace("GitHub observe dispatch scheduled", githubObserveTargetLogSummary(target));

  void Promise.resolve()
    .then(() => dispatcher.dispatch(target))
    .catch((error: unknown) => {
      console.warn(
        stringifyLogJson({
          level: "warn",
          source: "patchdoll.githubObserve",
          message: "GitHub observe dispatch failed",
          ...githubObserveTargetLogSummary(target),
          error: error instanceof Error ? error.message : String(error)
        })
      );
    });
}

export function logGithubObserveSkipped(
  event: GithubObserveWebhookEvent,
  decision: Extract<GithubObserveDecision, { dispatch: false }>
): void {
  logGithubObserveTrace("GitHub observe dispatch skipped", {
    deliveryId: event.deliveryId,
    repository: event.repository,
    githubEvent: event.eventName,
    action: event.action,
    event: event.eventKey,
    number: event.number ?? null,
    reason: decision.reason,
    mode: decision.mode ?? null,
    runtimeState: decision.runtimeState ?? null,
    runtimeReason: decision.runtimeReason ?? null
  });
}

function githubObserveTargetLogSummary(
  target: GithubObserveTarget
): Record<string, string | number | null> {
  return {
    deliveryId: target.deliveryId,
    repository: target.repository,
    githubEvent: target.eventName,
    action: target.action,
    event: target.eventKey,
    number: target.number,
    mode: target.mode,
    htmlUrl: target.htmlUrl ?? null
  };
}

function parseRuntimeStatusFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).trim();
  }
  return values;
}

function logGithubObserveTrace(
  message: string,
  fields: Record<string, string | number | null | undefined> = {}
): void {
  if (process.env.PATCHDOLL_LOG_LEVEL?.trim().toLowerCase() !== "trace") {
    return;
  }

  console.log(
    stringifyLogJson({
      level: "trace",
      source: "patchdoll.githubObserve",
      message,
      ...fields
    })
  );
}

function isEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
