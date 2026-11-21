/**
 * The security judges must think before they answer. For a DeepSeek model, reasoning can be switched off by agent name (deepseek.reasoningOff), and a model that
 * is not asked may not reason at all, so a judge asks for it by name: `reasoning` on the call. It beats the "off" list, applies to any model, and a model that
 * cannot take the field is called again without it rather than failing the review.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tuneRequest } from "../src/requestTuning.js";
import { OpenRouterClient } from "../src/openrouter.js";
import { runLabeledCompletion } from "../src/agentLoop.js";
import { ConfigSchema } from "../src/config.js";

const DS = "deepseek/deepseek-v4.1-flash";
const OTHER = "google/gemini-3.8-flash";
const cfg = (reasoningOff: string[]) => ({ provider: { sort: "default" as const }, deepseek: { sort: "default" as const, maxPromptPrice: 0, maxCompletionPrice: 0, reasoningOff } });

describe("tuneRequest: asking to think", () => {
  test("it overrides the 'reasoning off' list, even when SECURITY is on it", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      assert.deepEqual(tuneRequest(DS, "SECURITY", cfg(["SECURITY", "EDITOR"]), { forceReasoning: effort }).reasoning, { effort });
    }
  });

  test("without it, nothing changes: the off list still turns thinking off for the agents on it, and only for them", () => {
    assert.deepEqual(tuneRequest(DS, "EDITOR", cfg(["EDITOR"])).reasoning, { effort: "none" });
    assert.equal(tuneRequest(DS, "SECURITY", cfg(["EDITOR"])).reasoning, undefined);
  });

  test("it is not specific to one model: any model is asked to think, so the judges are not weaker when the user picks another", () => {
    assert.deepEqual(tuneRequest(OTHER, "SECURITY", cfg([]), { forceReasoning: "medium" }).reasoning, { effort: "medium" });
    assert.deepEqual(tuneRequest("some/other-model", "SECURITY", undefined, { forceReasoning: "high" }).reasoning, { effort: "high" });
  });

  test("a model that refused the field is not asked again", () => {
    assert.equal(tuneRequest(DS, "SECURITY", cfg(["SECURITY"]), { forceReasoning: "medium", reasoningRejected: true }).reasoning, undefined);
  });

  test("the price ceiling and the sort still apply to a judge", () => {
    const c = { provider: { sort: "default" as const }, deepseek: { sort: "throughput" as const, maxPromptPrice: 0.3, maxCompletionPrice: 0.75, reasoningOff: ["SECURITY"] } };
    const t = tuneRequest(DS, "SECURITY", c, { forceReasoning: "medium" });
    assert.deepEqual(t.reasoning, { effort: "medium" });
    assert.deepEqual(t.provider, { sort: "throughput", max_price: { prompt: 0.3, completion: 0.75 } });
  });
});

describe("the request that is sent", () => {
  const encoder = new TextEncoder();
  const sse = (text: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: text } }] })}\n\n`));
          c.enqueue(encoder.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const w = process.stdout.write.bind(process.stdout);
    const l = console.log;
    (process.stdout as any).write = () => true;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      (process.stdout as any).write = w;
      console.log = l;
    }
  };
  const withFetch = async (handler: (body: any, n: number) => Response, run: (bodies: any[]) => Promise<void>) => {
    const original = globalThis.fetch;
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return handler(body, bodies.length);
    };
    try {
      await run(bodies);
    } finally {
      (globalThis as any).fetch = original;
    }
  };
  const config: any = { ...ConfigSchema.shape.deepseek.parse({}), deepseek: { sort: "default", maxPromptPrice: 0, maxCompletionPrice: 0, reasoningOff: ["SECURITY"] } };
  const msgs: any = [{ role: "user", content: "judge this" }];

  test("a judge's call carries reasoning, even when this agent is on the 'off' list", async () => {
    await withFetch(() => sse("{}"), async (bodies) => {
      await quietly(() => new OpenRouterClient("k", config).complete([DS], msgs, { agent: "SECURITY", jsonMode: true, reasoning: "medium" }));
      assert.deepEqual(bodies[0].reasoning, { effort: "medium" });
    });
  });

  test("the same agent with no request for it is sent with thinking off, as the setting says (so the override is what makes the difference)", async () => {
    await withFetch(() => sse("{}"), async (bodies) => {
      await quietly(() => new OpenRouterClient("k", config).complete([DS], msgs, { agent: "SECURITY", jsonMode: true }));
      assert.deepEqual(bodies[0].reasoning, { effort: "none" });
    });
  });

  test("a model that refuses the reasoning field is called again without it, once, and the review is not lost", async () => {
    await withFetch(
      (_b, n) => (n === 1 ? new Response(JSON.stringify({ error: { message: "reasoning is not supported by this model" } }), { status: 400 }) : sse('{"verdict":"safe"}')),
      async (bodies) => {
        const msg: any = await quietly(() => new OpenRouterClient("k", config).complete([OTHER], msgs, { agent: "SECURITY", jsonMode: true, reasoning: "medium" }));
        assert.equal(msg.content, '{"verdict":"safe"}');
        assert.equal(bodies.length, 2);
        assert.deepEqual(bodies[0].reasoning, { effort: "medium" });
        assert.equal(bodies[1].reasoning, undefined);
      }
    );
  });

  test("runLabeledCompletion passes it through to the call", async () => {
    await withFetch(() => sse('{"verdict":"safe"}'), async (bodies) => {
      const out = await quietly(() => runLabeledCompletion({ client: new OpenRouterClient("k", config), models: [DS], messages: msgs, agentName: "SECURITY", jsonMode: true, reasoning: "high" }));
      assert.equal(out, '{"verdict":"safe"}');
      assert.deepEqual(bodies[0].reasoning, { effort: "high" });
    });
  });
});

describe("the panel uses it", () => {
  test("every judge call asks for reasoning, at the configured effort, medium by default", () => {
    const src = fs.readFileSync("src/index.ts", "utf8");
    assert.ok(src.includes('jsonMode: true, reasoning: panelCfg?.reasoning ?? "medium", reason: `Security panel: ${model}`'));
  });

  test("the setting: medium by default, and only low, medium or high", () => {
    const security = (ConfigSchema.shape as any).security;
    assert.equal(security.parse({}).panel.reasoning, "medium");
    assert.equal(security.parse({ panel: { reasoning: "high" } }).panel.reasoning, "high");
    assert.throws(() => security.parse({ panel: { reasoning: "none" } }), "thinking cannot be turned off for a judge");
    assert.throws(() => security.parse({ panel: { reasoning: "off" } }));
  });
});
