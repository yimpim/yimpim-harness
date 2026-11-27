import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { OPENROUTER_APP_HEADERS, OpenRouterClient } from "../src/openrouter.js";
import { fetchCatalog } from "../src/models.js";
import { checkKey } from "../src/wizard/keyCheck.js";

describe("OpenRouter unified attribution headers", () => {
  test("OPENROUTER_APP_HEADERS reports as Yimpim / https://yimpim.com", () => {
    assert.deepEqual(OPENROUTER_APP_HEADERS, {
      "HTTP-Referer": "https://yimpim.com",
      "X-Title": "Yimpim",
    });
  });

  test("checkKey sends OPENROUTER_APP_HEADERS", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const res = await checkKey("sk-or-test-12345678", {
      fetchImpl: (async (_url: any, init?: any) => {
        seenHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ data: { limit: 10 } }), { status: 200 });
      }) as any,
    });
    assert.equal(res.ok, true);
    assert.equal(seenHeaders?.["HTTP-Referer"], "https://yimpim.com");
    assert.equal(seenHeaders?.["X-Title"], "Yimpim");
  });

  test("fetchCatalog sends OPENROUTER_APP_HEADERS", async () => {
    const origFetch = globalThis.fetch;
    let seenHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: any, init?: any) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as any;
    try {
      await fetchCatalog("sk-or-test-12345678");
      assert.equal(seenHeaders?.["HTTP-Referer"], "https://yimpim.com");
      assert.equal(seenHeaders?.["X-Title"], "Yimpim");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("OpenRouterClient.complete sends OPENROUTER_APP_HEADERS", async () => {
    const origFetch = globalThis.fetch;
    let seenHeaders: Record<string, string> | undefined;
    const sseBody =
      'data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n' +
      "data: [DONE]\n\n";
    globalThis.fetch = (async (_url: any, init?: any) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as any;
    try {
      const client = new OpenRouterClient("sk-or-test-12345678");
      await client.complete(["openai/gpt-5"], [{ role: "user", content: "hi" }]);
      assert.equal(seenHeaders?.["HTTP-Referer"], "https://yimpim.com");
      assert.equal(seenHeaders?.["X-Title"], "Yimpim");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
