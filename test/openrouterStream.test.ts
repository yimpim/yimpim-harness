/**
 * Regression tests for the streaming path of `OpenRouterClient.complete()`
 * (src/openrouter.ts): SSE delta buffering, tool-call fragment merging, usage
 * capture, and cooperative abort.
 *
 * No network is involved — `globalThis.fetch` is stubbed with a real
 * `ReadableStream` SSE body, the same fetch-stubbing pattern
 * test/remoteAuth.test.ts already uses. Everything here runs offline.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OpenRouterClient } from "../src/openrouter.js";
import { events } from "../src/events.js";
import { runControl, AbortedError } from "../src/remote/control.js";

const encoder = new TextEncoder();

/** An SSE response whose body is built from the given raw chunks, so a frame
 *  can deliberately be split across a chunk boundary. */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** The client writes a per-second progress ticker straight to stdout and a
 *  status line per attempt via console.log — both are real behavior, just
 *  noise in a test transcript. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  (process.stdout as any).write = () => true;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    (process.stdout as any).write = originalWrite;
    console.log = originalLog;
  }
}

describe("OpenRouterClient.complete — streaming", () => {
  test("asks for a stream and reassembles content, reasoning and split tool-call fragments", async () => {
    const originalFetch = globalThis.fetch;
    let sentBody: any = undefined;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return sseResponse([
        frame({ choices: [{ delta: { role: "assistant", content: "Hel" } }] }),
        frame({ choices: [{ delta: { content: "lo " } }] }),
        // A frame cut in half by the transport — the decoder/buffer must not
        // emit it until the newline actually arrives.
        'data: {"choices":[{"delta":{"cont',
        'ent":"world"}}]}\n\n',
        frame({ choices: [{ delta: { reasoning: "thinking" } }] }),
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"pa' } },
                ],
              },
            },
          ],
        }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] }),
        frame({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0.00042 } }),
        "data: [DONE]\n\n",
      ]);
    };

    const before = events.usageReport();
    try {
      const client = new OpenRouterClient("test-key");
      const message = await quietly(() =>
        client.complete("test/model", [{ role: "user", content: "hi" }], { agent: "EDITOR" })
      );

      assert.equal(sentBody.stream, true, "the request must ask OpenRouter for a streamed response");
      assert.equal(message.role, "assistant");
      assert.equal(message.content, "Hello world");
      assert.equal(message.reasoning, "thinking");
      assert.equal(message.tool_calls.length, 1);
      assert.equal(message.tool_calls[0].id, "call_1");
      assert.equal(message.tool_calls[0].function.name, "read_file");
      assert.equal(
        message.tool_calls[0].function.arguments,
        '{"path":"a.ts"}',
        "argument fragments must be concatenated, not replaced"
      );

      const usage = events.usageDelta(before).byAgent.EDITOR;
      assert.equal(usage.calls, 1);
      assert.equal(usage.prompt, 11);
      assert.equal(usage.completion, 7);
      assert.equal(usage.total, 18);
      assert.ok(Math.abs(usage.cost - 0.00042) < 1e-9, "the streamed usage frame's cost must be recorded");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("reports null content for a pure tool-call turn, exactly like the non-streaming API", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      sseResponse([
        frame({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "patch_file", arguments: "{}" } }] } },
          ],
        }),
        "data: [DONE]\n\n",
      ]);
    try {
      const client = new OpenRouterClient("test-key");
      const message = await quietly(() => client.complete("test/model", [{ role: "user", content: "hi" }]));
      assert.equal(message.content, null);
      assert.equal(message.tool_calls.length, 1);
      assert.equal(message.tool_calls[0].function.name, "patch_file");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("falls back to an estimated token count when the stream never reports usage", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      sseResponse([frame({ choices: [{ delta: { content: "abcdefgh" } }] }), "data: [DONE]\n\n"]);
    const before = events.usageReport();
    try {
      const client = new OpenRouterClient("test-key");
      const message = await quietly(() =>
        client.complete("test/model", [{ role: "user", content: "hi" }], { agent: "PLANNER" })
      );
      assert.equal(message.content, "abcdefgh");

      const usage = events.usageDelta(before).byAgent.PLANNER;
      assert.equal(usage.calls, 1, "a usage-less stream must still appear in the cost summary");
      assert.equal(usage.prompt, 0, "prompt tokens are unknowable here and must not be invented");
      assert.ok(usage.total > 0);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("an in-flight Stop aborts the stream immediately with an AbortedError", async () => {
    const originalFetch = globalThis.fetch;
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    (globalThis as any).fetch = async (_url: string, init: any) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "par" } }] })));
          // Never closes on its own — exactly like a model still generating.
          // Aborting the request (a Stop) is the only thing that ends it.
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
        },
      });
      release();
      return new Response(stream, { status: 200 });
    };

    runControl.reset();
    try {
      const client = new OpenRouterClient("test-key");
      const pending = quietly(() => client.complete("test/model", [{ role: "user", content: "hi" }]));
      await started;
      runControl.requestAbort("stopped from phone");

      await assert.rejects(pending, (err: any) => {
        assert.ok(err instanceof AbortedError, `expected an AbortedError, got ${err?.name}: ${err?.message}`);
        assert.equal(err.name, "AbortedError");
        return true;
      });
    } finally {
      (globalThis as any).fetch = originalFetch;
      runControl.reset();
    }
  });
});

describe("OpenRouterClient — idle-stream timeout", () => {
  // readStreamedCompletion is private; exercised directly (bypassing
  // complete()'s retry loop, which has its own hardcoded 3s backoff between
  // attempts) so this stays fast while still testing the real mechanism —
  // not a re-implementation of it.
  test("a stream that goes silent after its first chunk aborts via the idle timeout, not left waiting forever", async () => {
    const abortController = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "partial" } }] })));
        // Never closes and never enqueues again — exactly a stalled connection.
        // Wired to react to the abort the same way a real fetch's body would.
        abortController.signal.addEventListener(
          "abort",
          () => streamController.error(abortController.signal.reason),
          { once: true }
        );
      },
    });
    const response = new Response(stream, { status: 200 });
    const client = new OpenRouterClient("test-key") as any;

    const start = Date.now();
    await assert.rejects(
      client.readStreamedCompletion(response, abortController, 50, () => {}),
      (err: any) => {
        assert.equal(err.name, "TimeoutError");
        assert.equal(err.stalled, true, "must be distinguishable from a time-to-first-byte timeout");
        return true;
      }
    );
    assert.ok(Date.now() - start < 2000, "the idle timeout should fire quickly, not hang the test");
    assert.equal(abortController.signal.aborted, true);
  });

  test("a slow but steadily-arriving stream is never killed by the idle timeout — only genuine silence trips it", async () => {
    const abortController = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      async start(streamController) {
        // Three chunks, each arriving comfortably inside the 50ms idle window,
        // spanning well past 50ms in total — proves the timer resets per
        // chunk rather than capping total stream duration.
        streamController.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "a" } }] })));
        await new Promise((r) => setTimeout(r, 30));
        streamController.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "b" } }] })));
        await new Promise((r) => setTimeout(r, 30));
        streamController.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "c" } }] })));
        streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
        streamController.close();
      },
    });
    const response = new Response(stream, { status: 200 });
    const client = new OpenRouterClient("test-key") as any;

    const { message } = await client.readStreamedCompletion(response, abortController, 50, () => {});
    assert.equal(message.content, "abc");
    assert.equal(abortController.signal.aborted, false);
  });
});

describe("OpenRouterClient — maxTotalDurationMs budget", () => {
  // Neither the time-to-first-byte timeout nor the idle-stream timeout ever
  // fires here — a degraded provider that keeps trickling just enough data
  // to dodge both is exactly the case maxTotalDurationMs exists to catch, so
  // this deliberately exercises complete()'s real retry loop rather than
  // bypassing it, unlike the idle-timeout tests above.
  test("a stream that keeps trickling data without finishing is still cut off once the total-duration budget is spent", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const interval = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "." } }] })));
            } catch {}
          }, 10);
          init.signal.addEventListener(
            "abort",
            () => {
              clearInterval(interval);
              controller.error(init.signal.reason);
            },
            { once: true }
          );
        },
      });
      return new Response(stream, { status: 200 });
    };

    runControl.reset();
    try {
      const client = new OpenRouterClient("test-key");
      const start = Date.now();
      await assert.rejects(
        quietly(() =>
          client.complete("test/model", [{ role: "user", content: "hi" }], {
            maxTotalDurationMs: 30,
            // High enough that the idle-stream guard could never plausibly
            // fire first — this test is about the OTHER guard.
            idleStreamTimeoutMs: 999_999,
          })
        ),
        (err: any) => {
          assert.equal(err.name, "TimeoutError");
          assert.equal(err.budgetExceeded, true, "must be distinguishable from an idle-stream or first-byte timeout");
          return true;
        }
      );
      // A single attempt, no same-model retry backoff at all — a
      // budget-exceeded timeout is already a diagnosis ("a degraded
      // provider"), so retrying the identical model is skipped in favor of
      // falling straight through to the next one in the chain (see the
      // dedicated test below); with only one model here, that just means
      // failing fast instead of burning 2 more 30ms-budget cycles plus their
      // 3s backoffs first.
      assert.ok(Date.now() - start < 2000, "must not retry the same already-diagnosed-degraded model");
    } finally {
      (globalThis as any).fetch = originalFetch;
      runControl.reset();
    }
  });

  test("falls straight through to the next model in the chain, skipping same-model retries entirely", async () => {
    const requestedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      requestedModels.push(body.model);

      if (body.model === "test/degraded") {
        // Never stops trickling — every attempt against this model would
        // exceed the budget.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const interval = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "." } }] })));
              } catch {}
            }, 10);
            init.signal.addEventListener(
              "abort",
              () => {
                clearInterval(interval);
                controller.error(init.signal.reason);
              },
              { once: true }
            );
          },
        });
        return new Response(stream, { status: 200 });
      }

      // The backup model answers cleanly and immediately.
      return sseResponse([frame({ choices: [{ delta: { role: "assistant", content: "backup answered" } }] }), "data: [DONE]\n\n"]);
    };

    runControl.reset();
    try {
      const client = new OpenRouterClient("test-key");
      const start = Date.now();
      const message = await quietly(() =>
        client.complete(["test/degraded", "test/backup"], [{ role: "user", content: "hi" }], {
          maxTotalDurationMs: 30,
          idleStreamTimeoutMs: 999_999,
        })
      );

      assert.equal(message.content, "backup answered");
      assert.deepEqual(
        requestedModels,
        ["test/degraded", "test/backup"],
        "exactly one attempt against the degraded model, then straight to the backup — no same-model retries in between"
      );
      assert.ok(Date.now() - start < 2000, "must not burn same-model retry backoff before falling through");
    } finally {
      (globalThis as any).fetch = originalFetch;
      runControl.reset();
    }
  });

  test("a normal completion well under the budget is unaffected", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      sseResponse([frame({ choices: [{ delta: { role: "assistant", content: "hi" } }] }), "data: [DONE]\n\n"]);

    try {
      const client = new OpenRouterClient("test-key");
      const message = await quietly(() =>
        client.complete("test/model", [{ role: "user", content: "hi" }], { maxTotalDurationMs: 120_000 })
      );
      assert.equal(message.content, "hi");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("omitting maxTotalDurationMs keeps today's unbounded-while-streaming behavior", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      sseResponse([frame({ choices: [{ delta: { role: "assistant", content: "hi" } }] }), "data: [DONE]\n\n"]);

    try {
      const client = new OpenRouterClient("test-key");
      const message = await quietly(() => client.complete("test/model", [{ role: "user", content: "hi" }]));
      assert.equal(message.content, "hi");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("OpenRouterClient — insufficient credits (HTTP 402)", () => {
  // OpenRouter's documented shape for this condition:
  // {"error":{"code":402,"message":"...","metadata":{"error_type":"payment_required"}}}
  function creditsResponse(): Response {
    return new Response(
      JSON.stringify({
        error: {
          code: 402,
          message: "Your account or API key has insufficient credits. Add more credits and retry the request.",
          metadata: { error_type: "payment_required" },
        },
      }),
      { status: 402 }
    );
  }

  test("keeps retrying the SAME model (never aborts, never falls through to the next model) until credits return", async () => {
    const originalFetch = globalThis.fetch;
    const requestedModels: string[] = [];
    let call = 0;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      call++;
      requestedModels.push(JSON.parse(init.body).model);
      // The first 3 calls report insufficient credits — simulating the user
      // adding credits partway through — then the 4th succeeds.
      if (call <= 3) return creditsResponse();
      return sseResponse([frame({ choices: [{ delta: { role: "assistant", content: "resumed" } }] }), "data: [DONE]\n\n"]);
    };

    const client = new OpenRouterClient("test-key");
    // The real backoff (15-60s) would make this test hang for minutes —
    // standing in for it is the point: what's under test is that the call
    // is RETRIED, not how long it waits between attempts.
    (client as any).delay = async () => {};

    try {
      const message = await quietly(() => client.complete(["test/primary", "test/backup"], [{ role: "user", content: "hi" }]));
      assert.equal(message.content, "resumed");
      assert.equal(call, 4, "must keep retrying through the 402s rather than giving up");
      assert.deepEqual(
        requestedModels,
        ["test/primary", "test/primary", "test/primary", "test/primary"],
        "must keep hammering the SAME model — falling through to the backup is just as doomed, account credits are global"
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("notifies exactly once across repeated 402s, not once per retry, with a 'this resumes automatically' message", async () => {
    const originalFetch = globalThis.fetch;
    let call = 0;
    (globalThis as any).fetch = async () => {
      call++;
      if (call <= 3) return creditsResponse();
      return sseResponse([frame({ choices: [{ delta: { role: "assistant", content: "resumed" } }] }), "data: [DONE]\n\n"]);
    };

    const client = new OpenRouterClient("test-key");
    (client as any).delay = async () => {};

    const received: any[] = [];
    const unsubscribe = events.onEmit((e) => {
      if (e.type === "error") received.push(e);
    });

    try {
      await quietly(() => client.complete("test/primary", [{ role: "user", content: "hi" }], { agent: "EDITOR" }));
      assert.equal(received.length, 1, "three 402s in a row must produce exactly one notification, not three");
      assert.equal(received[0].fatal, false, "the run keeps going, so this must not read as a fatal abort");
      assert.match(received[0].message, /insufficient credits/i);
      assert.match(received[0].message, /openrouter\.ai\/credits/);
      assert.match(received[0].message, /resume/i);
      assert.match(received[0].message, /test\/primary/);
    } finally {
      (globalThis as any).fetch = originalFetch;
      unsubscribe();
    }
  });

  test("a LATER depletion after a successful call gets its own fresh notification", async () => {
    const originalFetch = globalThis.fetch;
    let call = 0;
    (globalThis as any).fetch = async () => {
      call++;
      // credits ok (1) -> depleted (2) -> credits ok again (3)
      if (call === 2) return creditsResponse();
      return sseResponse([frame({ choices: [{ delta: { role: "assistant", content: "ok" } }] }), "data: [DONE]\n\n"]);
    };

    const client = new OpenRouterClient("test-key");
    (client as any).delay = async () => {};

    const received: any[] = [];
    const unsubscribe = events.onEmit((e) => {
      if (e.type === "error") received.push(e);
    });

    try {
      await quietly(() => client.complete("test/primary", [{ role: "user", content: "1" }]));
      await quietly(() => client.complete("test/primary", [{ role: "user", content: "2" }]));
      assert.equal(received.length, 1, "the second call's 402 (after the first call's success reset the flag) must notify again");
    } finally {
      (globalThis as any).fetch = originalFetch;
      unsubscribe();
    }
  });
});

import { isImageUnsupportedError, withoutImages } from "../src/openrouter.js";

describe("a model that cannot read images", () => {
  const imageErr = `HTTP 404: {"error":{"message":"No endpoints found that support image input","code":404}}`;
  const withImage = (): any[] => [
    { role: "user", content: [{ type: "text", text: "what is wrong?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ];

  test("the provider's refusal is recognised, and ordinary errors are not", () => {
    assert.equal(isImageUnsupportedError(new Error(imageErr)), true);
    assert.equal(isImageUnsupportedError(new Error("HTTP 500: upstream")), false);
  });

  test("images are replaced by a note, text is kept, and no images means nothing to strip", () => {
    const out = withoutImages(withImage())!;
    assert.equal(out[0].content[0].text, "what is wrong?");
    assert.equal(out[0].content[1].type, "text");
    assert.ok(!JSON.stringify(out).includes("base64"));
    assert.equal(withoutImages([{ role: "user", content: "plain" }] as any), undefined);
  });

  test("it is not retried: one call per model, then the next model, and the first is not marked unhealthy", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body.model);
      if (body.model === "text/only") return new Response(imageErr.replace("HTTP 404: ", ""), { status: 404 });
      return sseResponse([frame({ choices: [{ delta: { role: "assistant", content: "seen" } }] }), "data: [DONE]\n\n"]);
    };
    try {
      const client = new OpenRouterClient("test-key");
      const msg: any = await quietly(() => client.complete(["text/only", "sees/images"], withImage(), {}));
      assert.equal(msg.content, "seen");
      assert.deepEqual(calls, ["text/only", "sees/images"]);
      // A text-only call afterwards still starts on the first model.
      calls.length = 0;
      await quietly(() => client.complete(["text/only", "sees/images"], [{ role: "user", content: "hi" }] as any, {}));
      assert.equal(calls[0], "text/only");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("when no model in the chain can read images the same request goes again without them", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (JSON.stringify(body.messages).includes("image_url")) return new Response(imageErr.replace("HTTP 404: ", ""), { status: 404 });
      return sseResponse([frame({ choices: [{ delta: { role: "assistant", content: "ok" } }] }), "data: [DONE]\n\n"]);
    };
    try {
      const client = new OpenRouterClient("test-key");
      const msg: any = await quietly(() => client.complete(["text/only"], withImage(), {}));
      assert.equal(msg.content, "ok");
      assert.equal(bodies.length, 2, "one refused call, one without the image");
      assert.ok(!JSON.stringify(bodies[1].messages).includes("image_url"));
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});
