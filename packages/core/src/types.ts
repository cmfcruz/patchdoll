export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ServerConfig {
  host: string;
  port: number;
}

export interface AiConfig {
  provider: string;
  timeoutSeconds: number;
  maxConcurrentRuns: number;
  bypassSandboxAndApprovals: boolean;
}

export type CapabilityName =
  | "chat.reply"
  | "policy.codex.execpolicy.add_rule"
  | "patchdoll.settings.update"
  | (string & {});

export type Capabilities = Record<CapabilityName, boolean>;

export interface PatchdollConfig {
  server: ServerConfig;
  agentsMdPath: string;
  ai: AiConfig;
  capabilities: Capabilities;
  admins: string[];
}

export interface NormalizedEvent {
  id: string;
  source: string;
  kind: string;
  actor?: string;
  title?: string;
  body?: string;
  url?: string;
  receivedAt: string;
  raw: JsonValue;
  metadata?: Record<string, JsonValue>;
}

export interface TaskContext {
  event: NormalizedEvent;
  agentsMd: string;
  config: {
    capabilities: Capabilities;
    actorIsAdmin: boolean;
  };
  progress?: ProgressSink;
}

export interface ProposedAction {
  type: string;
  target?: string;
  body?: string;
  label?: string;
  url?: string;
  payload?: JsonValue;
  metadata?: Record<string, JsonValue>;
}

export interface AiResult {
  reply?: string;
  proposedActions?: ProposedAction[];
  files?: Array<{
    path: string;
    content: string;
  }>;
  metadata?: Record<string, JsonValue>;
}

export interface ActionDecision {
  action: ProposedAction;
  allowed: boolean;
  reason?: string;
}

export interface RunResult {
  event: NormalizedEvent;
  aiResult: AiResult;
  decisions: ActionDecision[];
  executed: ActionExecutionResult[];
}

export interface ProgressEvent {
  source: "codex" | "runner" | (string & {});
  message: string;
  metadata?: Record<string, JsonValue>;
}

export type ProgressSink = (event: ProgressEvent) => void | Promise<void>;

export interface ActionExecutionResult {
  action: ProposedAction;
  ok: boolean;
  message: string;
}

export interface ExternalActionHandler {
  type: string;
  execute(action: ProposedAction): Promise<ActionExecutionResult>;
}

export interface AiProvider {
  run(task: TaskContext): Promise<AiResult>;
}
