/** The status line says how long a model call has been going and how much has come back, so waiting and working look different. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackCall, describeLiveCalls, composeStatus, estimateTokens, formatTokens, formatElapsed } from "../src/liveCalls.js";

const T0 = 1_000_000;

describe("the seconds", () => {
  test("count from when the call started, and keep counting", () => {
    const end = trackCall("REPAIR", "deepseek/x", T0);
    try {
      assert.match(describeLiveCalls(T0) as string, /· 0s · waiting$/);
      assert.match(describeLiveCalls(T0 + 1000) as string, /· 1s ·/);
      assert.match(describeLiveCalls(T0 + 59_000) as string, /· 59s ·/);
      assert.match(describeLiveCalls(T0 + 60_000) as string, /· 1m 00s ·/);
      assert.match(describeLiveCalls(T0 + 120_000) as string, /· 2m 00s ·/);
      assert.match(describeLiveCalls(T0 + 121_000) as string, /· 2m 01s ·/);
    } finally {
      end();
    }
  });
  test("with several calls, it is the longest wait", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    const b = trackCall("REPAIR", "deepseek/x", T0 + 60_000);
    try {
      assert.match(describeLiveCalls(T0 + 90_000) as string, /REPAIR ×2 · x · 1m 30s ·/);
    } finally {
      a();
      b();
    }
  });
  test("it is in the status line the person reads", () => {
    const end = trackCall("REPAIR", "deepseek/x", T0);
    try {
      assert.match(composeStatus("Phase 2 · QA", T0 + 45_000) as string, /running · calling REPAIR · x · 45s · waiting/);
    } finally {
      end();
    }
  });
});

describe("what has come back", () => {
  test("nothing yet is 'waiting', so a silent call is not mistaken for a busy one", () => {
    const end = trackCall("REPAIR", "deepseek/x", T0);
    try {
      assert.match(describeLiveCalls(T0 + 30_000) as string, /waiting$/);
    } finally {
      end();
    }
  });
  test("once the model produces anything, an estimated token count replaces it", () => {
    const end = trackCall("REPAIR", "deepseek/x", T0);
    try {
      end.progress(400);
      assert.match(describeLiveCalls(T0 + 5000) as string, /· 5s · ↓ ~100 tokens$/);
      end.progress(5600);
      assert.match(describeLiveCalls(T0 + 9000) as string, /· 9s · ↓ ~1\.4k tokens$/);
      end.progress(28_000);
      assert.match(describeLiveCalls(T0 + 90_000) as string, /· 1m 30s · ↓ ~7\.0k tokens$/, "the form Claude's own terminal uses");
    } finally {
      end();
    }
  });
  test("several calls add up", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    const b = trackCall("REPAIR", "deepseek/x", T0);
    try {
      a.progress(4000);
      b.progress(2000);
      assert.match(describeLiveCalls(T0 + 1000) as string, /↓ ~1\.5k tokens$/);
    } finally {
      a();
      b();
    }
  });
  test("an ended call stops counting", () => {
    const end = trackCall("REPAIR", "deepseek/x", T0);
    end.progress(4000);
    end();
    assert.equal(describeLiveCalls(T0 + 1000), undefined);
  });
  test("the estimate is four characters to a token, written compactly", () => {
    assert.equal(estimateTokens(4000), 1000);
    assert.equal(formatTokens(850), "850");
    assert.equal(formatTokens(1000), "1.0k");
    assert.equal(formatTokens(7000), "7.0k");
    assert.equal(formatTokens(1450), "1.5k");
    assert.equal(formatTokens(12_400), "12.4k");
  });
  test("elapsed time: seconds to 59, then minutes, then hours", () => {
    assert.equal(formatElapsed(0), "0s");
    assert.equal(formatElapsed(45), "45s");
    assert.equal(formatElapsed(59), "59s");
    assert.equal(formatElapsed(60), "1m 00s");
    assert.equal(formatElapsed(90), "1m 30s");
    assert.equal(formatElapsed(605), "10m 05s");
    assert.equal(formatElapsed(3600), "1h 00m 00s");
    assert.equal(formatElapsed(3725), "1h 02m 05s");
    assert.equal(formatElapsed(-4), "0s");
  });
});

describe("the wiring", () => {
  const src = fs.readFileSync(new URL("../src/openrouter.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("the stream reports its progress to the call that is being tracked, and the count is of everything the model writes", () => {
    assert.ok(src.includes("endCall.progress"));
    assert.ok(src.includes("let chars = content.length + reasoning.length + thought.length;"));
    assert.ok(src.includes("chars += tc?.function?.arguments?.length ?? 0;"));
  });
});
