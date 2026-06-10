import { loadAgentsMd } from "./agents.js";
import { executeAllowedActions } from "./actions.js";
import { actorMayInvoke, buildInvocationDeniedResult } from "./invocationGate.js";
import { evaluateActions } from "./policy.js";
import type {
  AiProvider,
  AiResult,
  ExternalActionHandler,
  PatchdollConfig,
  NormalizedEvent,
  ProgressSink,
  RunResult
} from "./types.js";

export class PatchdollRunner {
  constructor(
    private readonly config: PatchdollConfig,
    private readonly ai: AiProvider,
    private readonly actionHandlers: ExternalActionHandler[]
  ) {}

  async run(
    event: NormalizedEvent,
    options: { progress?: ProgressSink } = {}
  ): Promise<RunResult> {
    const actorIsAdmin = actorIsListed(event.actor, this.config.admins);

    // Stop untrusted invocations before any AI work starts. This runs in the
    // core — the single chokepoint every surface funnels through — so it can't
    // be bypassed by anything that reaches the runner directly.
    if (
      !actorMayInvoke(event.actor, {
        admins: this.config.admins,
        trustedUsers: this.config.trustedUsers
      })
    ) {
      return this.finalize(event, buildInvocationDeniedResult(event.actor), actorIsAdmin);
    }

    const agentsMd = await loadAgentsMd(this.config.agentsMdPath);
    const aiResult = await this.ai.run({
      event,
      agentsMd,
      config: {
        capabilities: this.config.capabilities,
        actorIsAdmin
      },
      progress: options.progress
    });

    return this.finalize(event, aiResult, actorIsAdmin);
  }

  private async finalize(
    event: NormalizedEvent,
    aiResult: AiResult,
    actorIsAdmin: boolean
  ): Promise<RunResult> {
    const decisions = evaluateActions(
      aiResult.proposedActions,
      this.config.capabilities,
      { actorIsAdmin }
    );
    const allowed = decisions
      .filter((decision) => decision.allowed)
      .map((decision) => decision.action);
    const executed = await executeAllowedActions(allowed, this.actionHandlers);

    return {
      event,
      aiResult,
      decisions,
      executed
    };
  }
}

function actorIsListed(
  actor: string | undefined,
  actors: string[]
): boolean {
  return actor !== undefined && actors.includes(actor);
}
