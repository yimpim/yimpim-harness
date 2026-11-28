/**
 * Prompt-cache hits are measurable: OpenRouter's cached_tokens reach the usage ledger, per agent and per model, with a hit rate in /usage. And a request never asks for (or gets)
 * OpenRouter's silent middle-out compression.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenRouterClient } from "../src/openrouter.js";
import { events } from "../src/events.js";
import { UsageLedger, renderLedger, cacheText } from "../src/usageLedger.js";

const enc = new TextEncoder();
const sse = (usage: Record<string, unknown> | undefined) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "hi" } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const original = globalThis.fetch;
afterEach(() => {
  (globalThis as any).fetch = original;
});

async function call(usage: Record<string, unknown> | undefined) {
  let body: any;
  (globalThis as any).fetch = async (_u: string, init: any) => ((body = JSON.parse(String(init.body))), sse(usage));
  const log = console.log;
  console.log = () => {};
  try {
    let reported: any;
    const off = events.onUsage((_a, _m, u) => (reported = u));
    await new OpenRouterClient("k").complete(["m/one"], [{ role: "user", content: "hi" }], { agent: "EDITOR" });
    (off as any)?.();
    return { body, usage: reported };
  } finally {
    console.log = log;
  }
}

describe("the request", () => {
  test("turns middle-out compression off explicitly, and still asks for usage", async () => {
    const { body } = await call(undefined);
    assert.deepEqual(body.transforms, []);
    assert.deepEqual(body.usage, { include: true });
  });
});

describe("cached tokens", () => {
  test("OpenRouter's prompt_tokens_details.cached_tokens is read off the usage block; absent stays undefined, not 0", async () => {
    const withCache = await call({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, cost: 0.001, prompt_tokens_details: { cached_tokens: 800 } });
    assert.equal(withCache.usage.cached, 800);
    const without = await call({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 });
    assert.equal(without.usage.cached, undefined);
  });
});

describe("the ledger", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "usage-ledger.json");
  const ledger = new UsageLedger(file);
  test("cached tokens add up per agent and per model, and the rate counts only calls that reported", () => {
    ledger.recordCall({ role: "EDITOR", model: "m/one", prompt: 1000, completion: 10, total: 1010, cached: 800 });
    ledger.recordCall({ role: "EDITOR", model: "m/one", prompt: 1000, completion: 10, total: 1010, cached: 0 });
    ledger.recordCall({ role: "EDITOR", model: "m/one", prompt: 5000, completion: 10, total: 5010 }); // a route that did not report: not in the rate
    const snap = ledger.snapshot();
    assert.equal(snap.totals.cached, 800);
    assert.equal(snap.totals.cachedOf, 2000);
    assert.equal(snap.byAgent.EDITOR.cached, 800);
    assert.equal(snap.byModel["m/one"].cachedOf, 2000);
    assert.equal(cacheText(snap.totals), "  cache 40%");
  });
  test("it survives a save and a reload, and an older ledger without the fields loads as zero", () => {
    ledger.flush();
    assert.equal(new UsageLedger(file).snapshot().totals.cached, 800);
    const oldFile = path.join(path.dirname(file), "old-usage-ledger.json");
    const old = { v: 1, desktopId: "d", since: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", totals: { calls: 2, prompt: 10, completion: 1, total: 11, cost: 0, pricedCalls: 0 }, taskCount: 0, byAgent: {}, byModel: {}, tasks: [] };
    fs.writeFileSync(oldFile, JSON.stringify(old));
    const reloaded = new UsageLedger(oldFile).snapshot();
    assert.equal(reloaded.totals.cached, 0);
    assert.equal(cacheText(reloaded.totals), "");
  });
  test("/usage shows the rate only where a call reported one", () => {
    const l2 = new UsageLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "u.json"));
    l2.recordCall({ role: "EDITOR", model: "m/one", prompt: 1000, completion: 10, total: 1010, cached: 500 });
    l2.recordCall({ role: "QA", model: "m/two", prompt: 1000, completion: 10, total: 1010 });
    const text = renderLedger(l2.snapshot());
    assert.match(text, /EDITOR\s+1 calls[^\n]*cache 50%/);
    assert.doesNotMatch(text.split("\n").find((l) => /QA\s+1 calls/.test(l)) ?? "", /cache/);
  });
});
