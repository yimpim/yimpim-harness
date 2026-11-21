import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tuneRequest, isReasoningRejected, isPriceCapMiss, isDeepseek } from "../src/requestTuning.js";
import { ConfigSchema } from "../src/config.js";

const DS = "deepseek/deepseek-v4.1-flash-1017";
const defaults = ConfigSchema.parse({ models: { discovery: ["x/y"], planner: ["x/y"], editor: ["x/y"], repair: ["x/y"], verifier: ["x/y"] } } as any);

describe("DeepSeek settings", () => {
  test("the defaults are throughput, the 0.30 / 0.75 caps, and thinking off for Discovery and Editor", () => {
    assert.equal(defaults.deepseek.sort, "throughput");
    assert.equal(defaults.deepseek.maxPromptPrice, 0.3);
    assert.equal(defaults.deepseek.maxCompletionPrice, 0.75);
    assert.deepEqual(defaults.deepseek.reasoningOff, ["DISCOVERY", "EDITOR"]);
  });
  test("a DeepSeek call is sorted by throughput and capped on price, in one provider object", () => {
    const t = tuneRequest(DS, "REPAIR", defaults);
    assert.deepEqual(t.provider, { sort: "throughput", max_price: { prompt: 0.3, completion: 0.75 } });
  });
  test("thinking is turned off for Discovery and Editor, not for the roles that diagnose", () => {
    assert.deepEqual(tuneRequest(DS, "DISCOVERY", defaults).reasoning, { effort: "none" });
    assert.deepEqual(tuneRequest(DS, "EDITOR", defaults).reasoning, { effort: "none" });
    assert.deepEqual(tuneRequest(DS, "editor", defaults).reasoning, { effort: "none" }, "case does not matter");
    for (const a of ["REPAIR", "REPAIR_PLANNER", "VERIFIER", "PLANNER", "EXISTENCE"]) assert.equal(tuneRequest(DS, a, defaults).reasoning, undefined, a);
  });
  test("it can be extended to other agents, or switched off", () => {
    const more = { ...defaults, deepseek: { ...defaults.deepseek, reasoningOff: ["DISCOVERY", "EDITOR", "REPAIR"] } };
    assert.deepEqual(tuneRequest(DS, "REPAIR", more).reasoning, { effort: "none" });
    const none = { ...defaults, deepseek: { ...defaults.deepseek, reasoningOff: [] } };
    assert.equal(tuneRequest(DS, "EDITOR", none).reasoning, undefined);
  });
});

describe("only DeepSeek is touched", () => {
  test("another model gets neither the price cap, nor the reasoning change", () => {
    for (const m of ["anthropic/claude-x", "google/gemini-4-hydrogen", "openai/gpt-6-luna"]) {
      const t = tuneRequest(m, "EDITOR", defaults);
      assert.equal(t.reasoning, undefined, m);
      assert.equal(t.provider, undefined, m);
    }
    assert.ok(isDeepseek(DS) && !isDeepseek("notdeepseek/x"));
  });
  test("the global provider.sort still applies to a model that is not DeepSeek", () => {
    const cfg = { ...defaults, provider: { sort: "latency" as const } };
    assert.deepEqual(tuneRequest("openai/gpt-6-luna", "EDITOR", cfg).provider, { sort: "latency" });
  });
  test("for DeepSeek its own sort wins over the global one; 'default' falls back to the global", () => {
    const cfg = { ...defaults, provider: { sort: "price" as const } };
    assert.equal((tuneRequest(DS, "EDITOR", cfg).provider as any).sort, "throughput");
    const dflt = { ...cfg, deepseek: { ...cfg.deepseek, sort: "default" as const } };
    assert.equal((tuneRequest(DS, "EDITOR", dflt).provider as any).sort, "price");
  });
});

describe("a cap of 0 is no cap", () => {
  test("both zero leaves only the sort", () => {
    const cfg = { ...defaults, deepseek: { ...defaults.deepseek, maxPromptPrice: 0, maxCompletionPrice: 0 } };
    assert.deepEqual(tuneRequest(DS, "EDITOR", cfg).provider, { sort: "throughput" });
  });
  test("one side zero caps only the other", () => {
    const cfg = { ...defaults, deepseek: { ...defaults.deepseek, maxPromptPrice: 0 } };
    assert.deepEqual((tuneRequest(DS, "EDITOR", cfg).provider as any).max_price, { completion: 0.75 });
  });
  test("with the sort default and no caps, nothing is added at all", () => {
    const cfg = { ...defaults, deepseek: { sort: "default" as const, maxPromptPrice: 0, maxCompletionPrice: 0, reasoningOff: [] } };
    assert.deepEqual(tuneRequest(DS, "EDITOR", cfg), {});
  });
});

describe("a model that will not turn its thinking off", () => {
  test("once refused, the call goes without the setting", () => {
    assert.equal(tuneRequest(DS, "EDITOR", defaults, { reasoningRejected: true }).reasoning, undefined);
    assert.ok(tuneRequest(DS, "EDITOR", defaults, { reasoningRejected: true }).provider, "the provider settings stay");
  });
  test("only a refusal that is about reasoning counts", () => {
    assert.ok(isReasoningRejected(400, '{"error":{"message":"reasoning effort none is not supported for this model"}}'));
    assert.ok(!isReasoningRejected(400, '{"error":{"message":"messages must not be empty"}}'));
    assert.ok(!isReasoningRejected(500, "reasoning"));
  });
});

describe("no provider under the price cap", () => {
  test("recognised only when a cap was sent", () => {
    assert.ok(isPriceCapMiss(404, '{"error":{"message":"No endpoints found matching your price"}}', true));
    assert.ok(!isPriceCapMiss(404, '{"error":{"message":"No endpoints found"}}', false));
    assert.ok(!isPriceCapMiss(401, "price", true));
  });
});

describe("the wiring", () => {
  const src = fs.readFileSync(new URL("../src/openrouter.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("the request body takes provider and reasoning from the tuning, and the old sort-only block is gone", () => {
    // (a call that must think, a security judge, asks for it: `forceReasoning`, see panelReasoning.test.ts)
    assert.match(src, /tuneRequest\(model, agent, this\.config, \{ reasoningRejected, forceReasoning: options\?\.reasoning \}\)/);
    assert.match(src, /bodyPayload\.reasoning = tuned\.reasoning/);
    assert.doesNotMatch(src, /bodyPayload\.provider = \{ sort: providerSort \}/);
  });
  test("a refused reasoning setting is retried once without it, outside the attempt budget", () => {
    assert.match(src, /reasoningRejected = true;[\s\S]{0,200}attempt--;\s*continue;/);
  });
});
