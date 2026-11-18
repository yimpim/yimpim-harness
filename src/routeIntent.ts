/**
 * Where a typed request goes. The decision is the router model's, made from what each route does (see INTENT_SYSTEM): no list of
 * phrases decides anything. What this file holds is the plumbing around that decision:
 *  - the routes that exist, so the prompt, the parser and the dispatcher cannot drift apart,
 *  - FACTS about the session that are handed to the model as context (how many numbered jobs the request lists, whether the previous
 *    reply was an audit report), never turned into rules that overrule it,
 *  - reading its answer, where anything unusable falls to "task", the full pipeline.
 */

export const INTENTS = [
  "question",
  "task",
  "verify",
  "git_review",
  "branch_only",
  "merge_only",
  "note",
  "program",
  "roadmap",
  "design",
  "pentest",
  "audit",
  "tests",
] as const;

export type Intent = (typeof INTENTS)[number];

export interface RoutedIntent {
  intent: Intent;
  branch: string | null;
  reference: unknown;
  documents: unknown;
  roadmapAction: unknown;
  roadmapRequest: unknown;
  resolvedManualSteps: unknown;
  /** The request carries on from the audit report the session just gave. */
  followsLastAudit: boolean;
}

/** Reads the router's JSON. Anything unusable is a plain task: the one route that never silently does nothing. */
export function parseIntentReply(raw: string): RoutedIntent {
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    parsed = {};
  }
  const intent: Intent = INTENTS.includes(parsed?.intent) ? parsed.intent : "task";
  return {
    intent,
    branch: typeof parsed?.branch === "string" && parsed.branch.trim() ? parsed.branch.trim() : null,
    reference: parsed?.reference,
    documents: parsed?.documents,
    roadmapAction: parsed?.roadmapAction,
    roadmapRequest: parsed?.roadmapRequest,
    resolvedManualSteps: parsed?.resolvedManualSteps,
    followsLastAudit: parsed?.followsLastAudit === true,
  };
}

/** Facts about this moment in the session, given to the router as context. They inform its choice; they never make it. */
export function routeFacts(a: { numberedJobs: number; lastAuditRequest?: string | null }): string {
  const lines: string[] = [];
  if (a.numberedJobs >= 2) lines.push(`The request lists ${a.numberedJobs} numbered jobs.`);
  if (a.lastAuditRequest) {
    lines.push(
      `The previous reply in this session was an audit report from checking "${a.lastAuditRequest.replace(/\s+/g, " ").slice(0, 200)}" against the code. ` +
        `Nothing was changed. A request that carries on from that report ("finish it", "do the rest", "go ahead", "fix what it found") continues it.`
    );
  }
  return lines.length ? `Facts about the session:\n${lines.map((l) => `- ${l}`).join("\n")}\n\n` : "";
}
