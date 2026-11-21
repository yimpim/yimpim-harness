/**
 * Per-request OpenRouter settings for DeepSeek: which backend serves the call, a price ceiling, and whether the model thinks first.
 *
 * DeepSeek is served by several providers at different speeds and prices (unlike a model with one maker), so the call is sent to the
 * fastest one that is still under a price cap. "throughput" alone would pick the fastest whatever it costs, which is why the two
 * go together: the cap is what stops a surprise rate. With no provider under the cap, OpenRouter does not run the request.
 *
 * Reasoning is billed as output tokens. Discovery reads and searches, and the Editor applies a plan the Planner already made, so
 * neither needs to think first; the roles that diagnose (Repair, Verifier, Planner) keep whatever the model does by default.
 */

export type ProviderSort = "default" | "throughput" | "price" | "latency";

export interface DeepseekTuning {
  sort?: ProviderSort;
  /** Dollars per million prompt tokens. 0 means no ceiling. */
  maxPromptPrice?: number;
  /** Dollars per million completion tokens. 0 means no ceiling. */
  maxCompletionPrice?: number;
  /** Agents (by name prefix) for which reasoning is turned off. */
  reasoningOff?: string[];
}

export interface TuningConfig {
  provider?: { sort?: ProviderSort };
  deepseek?: DeepseekTuning;
}

export interface Tuned {
  provider?: Record<string, unknown>;
  reasoning?: { effort: "none" | "low" | "medium" | "high" };
}

export const isDeepseek = (model: string): boolean => /^deepseek\//i.test(model);

/**
 * What to add to the request body. `reasoningRejected` is set once the model has refused `effort: "none"` (a model whose reasoning
 * cannot be turned off): the request is then sent without it.
 */
export function tuneRequest(
  model: string,
  agent: string,
  cfg: TuningConfig | undefined,
  state: { reasoningRejected?: boolean; forceReasoning?: "low" | "medium" | "high" } = {}
): Tuned {
  const out: Tuned = {};
  const global = cfg?.provider?.sort;
  const ds = isDeepseek(model) ? cfg?.deepseek : undefined;

  const sort = ds?.sort && ds.sort !== "default" ? ds.sort : global && global !== "default" ? global : undefined;
  const provider: Record<string, unknown> = {};
  if (sort) provider.sort = sort;
  if (ds) {
    const prompt = ds.maxPromptPrice ?? 0;
    const completion = ds.maxCompletionPrice ?? 0;
    // A ceiling on one side only is a ceiling on that side only.
    if (prompt > 0 || completion > 0) {
      provider.max_price = { ...(prompt > 0 ? { prompt } : {}), ...(completion > 0 ? { completion } : {}) };
    }
  }
  if (Object.keys(provider).length > 0) out.provider = provider;

  // A call that must think (a security judge) asks for it by name, whatever the settings turn off for this agent and whatever the model does when it is
  // not asked. A model that refuses the field is retried without it (reasoningRejected), the same as for the "none" above.
  if (state.forceReasoning && !state.reasoningRejected) {
    out.reasoning = { effort: state.forceReasoning };
    return out;
  }
  if (ds && !state.reasoningRejected) {
    const a = agent.toUpperCase();
    if ((ds.reasoningOff ?? []).some((r) => r && a.startsWith(r.toUpperCase()))) out.reasoning = { effort: "none" };
  }
  return out;
}

/** A refusal of the `reasoning` field itself (the model cannot turn it off), as opposed to any other bad request. */
export function isReasoningRejected(status: number, body: string): boolean {
  return (status === 400 || status === 422) && /reasoning/i.test(body);
}

/** No provider for the model is under the price cap: OpenRouter does not run the request. */
export function isPriceCapMiss(status: number, body: string, sentCap: boolean): boolean {
  return sentCap && (status === 404 || status === 400) && /price|endpoint|provider/i.test(body);
}
