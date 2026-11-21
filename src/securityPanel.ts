/**
 * The security panel as a reviewer for the places that screen code before running it (the heal sandbox's and REPAIR's run_test), built from the same settings
 * the harness's own panel uses: judges from the configured security, planner and repair models (security.panel), each asked to reason. Undefined when fewer than two
 * distinct models are configured, and the caller then keeps the single reviewer.
 */
import type { OpenRouterClient } from "./openrouter.js";
import type { AgentConfig } from "./config.js";
import type { ReviewRequest, ReviewOutcome } from "./commandReview.js";
import { makePanel, pickJudges } from "./commandPanel.js";
import { runLabeledCompletion } from "./agentLoop.js";

export function panelReviewerFor(client: OpenRouterClient, config: AgentConfig): ((req: ReviewRequest) => Promise<ReviewOutcome>) | undefined {
  if (config.security?.commandReview === false) return undefined;
  const cfg = config.security?.panel;
  if (cfg?.enabled === false) return undefined;
  const judges = pickJudges(config.models, { size: cfg?.size, models: cfg?.models });
  if (judges.length < 2) return undefined;
  const panel = makePanel(
    judges.map((model) => ({
      model,
      call: (messages) =>
        runLabeledCompletion({ client, models: [model], messages: messages as any, agentName: "SECURITY", jsonMode: true, reasoning: cfg?.reasoning ?? "medium", reason: `Security panel (test run): ${model}` }),
    }))
  );
  return (req) => panel.reviewCommand(req);
}
