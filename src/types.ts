export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Phase {
  id: string;
  name: string;
  goal: string;
  files: string[];
  changes: string[];
  verification: string[];
}

export interface DiscoveryResult {
  status: "ready" | "needs_clarification";
  summary: string;
  affectedFiles: { path: string; reason: string }[];
  possiblyAffectedFiles: { path: string; reason: string }[];
  questions: string[];
}

export interface PlanResult {
  goal: string;
  assumptions: string[];
  phases: Phase[];
}

export interface VerificationResult {
  passed: boolean;
  stage: "verification";
  errorOutput?: string;
}

export type RunStatus =
  | "starting" | "discovering" | "clarifying" | "planning"
  | "executing" | "verifying" | "committing"
  | "paused" | "failed" | "completed";

export interface RunState {
  version: 1;
  runId: string;
  repoRoot: string;
  request: string;
  status: RunStatus;
  phaseIndex: number;
  phaseAttempt: number;
  plan?: PlanResult;
  discovery?: DiscoveryResult;
  lastEventId: number;
  startedAt: string;
  updatedAt: string;
  baseCommit: string;
  phaseCheckpoint?: string;
  lastVerification?: VerificationResult;
  error?: string;
}
