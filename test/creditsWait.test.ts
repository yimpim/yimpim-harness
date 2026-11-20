/**
 * Out of credits: alert once, then check again every four minutes, for as long as it takes, one request per check, and carry on exactly
 * where the run was when money is back. The user's cost control is the limit on their own OpenRouter key; the harness never gives up on it.
 * (It used to stop after about an hour of 15-60 second waits.) A user Stop still ends the wait at once.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenRouterClient, CREDITS_RECHECK_MS } from "../src/openrouter.js";
import { events } from "../src/events.js";
import { runControl, AbortedError } from "../src/remote/control.js";

const enc = new TextEncoder();
const ok = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "hello" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const noCredits = () =>
  new Response(JSON.stringify({ error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits", metadata: { error_type: "payment_required" } } }), { status: 402 });

const originalFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  runControl.reset();
});

/** A client whose waits are recorded instead of slept, and a fetch that answers 402 `times` times and then succeeds. */
function setup(times: number) {
  const waits: number[] = [];
  let fetches = 0;
  (globalThis as any).fetch = async () => (++fetches <= times ? noCredits() : ok());
  const client = new OpenRouterClient("test-key");
  (client as any).creditsDelay = async (ms: number) => {
    waits.push(ms);
  };
  return { client, waits, fetches: () => fetches };
}

/** The client prints a status line per attempt and a ticker: noise in a test transcript, and the console lines are what some tests read. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = originalLog;
  }
}
const ask = (client: OpenRouterClient) => client.complete(["some/model"], [{ role: "user", content: "hi" }], { agent: "EDITOR" });

describe("out of credits", () => {
  test("the check is every four minutes, and the call carries on once money is back", async () => {
    assert.equal(CREDITS_RECHECK_MS, 240_000);
    const s = setup(2);
    assert.equal(s.client.creditsRecheckMs, 240_000, "the default");
    const { value } = await quietly(() => ask(s.client));
    assert.equal(value.content, "hello", "the same request, answered");
    assert.deepEqual(s.waits, [240_000, 240_000], "no growing back-off, no short waits");
  });

  test("one request per check: it never hammers the API while it waits", async () => {
    const s = setup(3);
    await quietly(() => ask(s.client));
    assert.equal(s.fetches(), 4, "three refused, one answered");
    assert.equal(s.waits.length, 3);
  });

  test("there is no limit: a hundred refusals in a row, then it succeeds", async () => {
    const s = setup(100);
    const { value } = await quietly(() => ask(s.client));
    assert.equal(value.content, "hello");
    assert.equal(s.waits.length, 100);
    assert.equal(s.fetches(), 101);
  });

  test("it says so on the console each time, with when the wait began", async () => {
    const s = setup(2);
    const { lines } = await quietly(() => ask(s.client));
    const says = lines.filter((l) => /\[CREDITS\] Out of OpenRouter credits\. Checking again in 4 min \(waiting since \d/.test(l));
    assert.equal(says.length, 2);
    assert.match(says[0], /Add credits any time: no need to restart/);
  });

  test("the user is alerted ONCE for a run of refusals, and again only after a success and a new refusal", async () => {
    const alerts: string[] = [];
    const emit = events.emit.bind(events);
    (events as any).emit = (e: any) => {
      if (e?.type === "error" && /insufficient credits/i.test(e.message)) alerts.push(e.message);
      return emit(e);
    };
    try {
      const s = setup(3);
      await quietly(() => ask(s.client));
      assert.equal(alerts.length, 1, "three refusals, one alert");
      assert.match(alerts[0], /resume automatically/);
      // a later run of refusals is a new situation
      let n = 0;
      (globalThis as any).fetch = async () => (++n <= 2 ? noCredits() : ok());
      await quietly(() => ask(s.client));
      assert.equal(alerts.length, 2, "a new alert after it had succeeded in between");
    } finally {
      (events as any).emit = emit;
    }
  });

  test("a user Stop ends the wait at once, with no further request", async () => {
    let fetches = 0;
    (globalThis as any).fetch = async () => (++fetches, noCredits());
    const client = new OpenRouterClient("test-key");
    client.creditsRecheckMs = 60_000; // the REAL wait, which a Stop must be able to cut short
    const pending = quietly(() => ask(client));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fetches, 1, "one request, now waiting");
    runControl.requestAbort("keyboard (/stop)");
    const started = Date.now();
    await assert.rejects(() => pending, AbortedError);
    assert.ok(Date.now() - started < 2_000, "it did not wait out the minute");
    assert.equal(fetches, 1, "and it did not ask again");
  });

  test("a Stop that was already requested does not start a wait at all", async () => {
    let fetches = 0;
    (globalThis as any).fetch = async () => (++fetches, noCredits());
    const client = new OpenRouterClient("test-key");
    client.creditsRecheckMs = 60_000;
    runControl.requestAbort("keyboard (/stop)");
    const started = Date.now();
    await assert.rejects(() => quietly(() => ask(client)), AbortedError);
    assert.ok(Date.now() - started < 2_000);
    assert.ok(fetches <= 1, "at most the request that was already on its way");
  });
});
