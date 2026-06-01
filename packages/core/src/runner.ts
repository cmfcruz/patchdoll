import { loadAgentsMd } from "./agents.js";
import { executeAllowedActions } from "./actions.js";
import { evaluateActions } from "./policy.js";
import type {
  AiProvider,
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
    const agentsMd = await loadAgentsMd(this.config.agentsMdPath);
    const actorIsAdmin = actorIsListed(event.actor, this.config.admins);
    const aiResult = await this.ai.run({
      event,
      agentsMd,
      config: {
        capabilities: this.config.capabilities,
        actorIsAdmin
      },
      progress: options.progress
    });

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
