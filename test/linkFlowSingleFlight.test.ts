/**
 * /link watches its QR for as long as the broker lets a phone claim it, only one run watches a QR at a time (in this process
 * and across windows), every run that ends without linking says its QR is no longer watched, and a broker that keeps
 * answering with an error is reported instead of waited on in silence.
 */
import { test, describe, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeLinkFlow, linkEndedNotice, LINK_FLOW_TIMEOUT_MS, getValidProToken } from "../src/remote/auth.js";

const dirs: string[] = [];
const originalAuthFile = process.env.YIMPIM_AUTH_FILE;
let authDir = "";
let printed: string[] = [];
const originalLog = console.log;
const originalFetch = globalThis.fetch;

const jwt = (expSecs: number) => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "u_1", exp: expSecs })}.sig`;
};
const lease = () => jwt(Math.floor(Date.now() / 1000) + 3600);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  authDir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-link-"));
  dirs.push(authDir);
  process.env.YIMPIM_AUTH_FILE = path.join(authDir, "auth.json");
  printed = [];
  console.log = (...a: unknown[]) => printed.push(a.map(String).join(" "));
});
afterEach(() => {
  console.log = originalLog;
  (globalThis as any).fetch = originalFetch;
});
after(() => {
  if (originalAuthFile === undefined) delete process.env.YIMPIM_AUTH_FILE;
  else process.env.YIMPIM_AUTH_FILE = originalAuthFile;
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

/** A broker whose codes stay pending until `claim(code)` is called. */
function fakeBroker(opts: { expiresInMs?: number; pollStatus?: () => Response | undefined } = {}) {
  let n = 0;
  const claimed = new Set<string>();
  const leases = new Map<string, string>();
  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (init?.method === "POST") {
      const code = `CODE${++n}`;
      return json({ code, claimUrl: `https://broker.test/link#${code}`, ...(opts.expiresInMs ? { expiresInMs: opts.expiresInMs } : {}) });
    }
    const override = opts.pollStatus?.();
    if (override) return override;
    const code = decodeURIComponent(url.split("/poll/")[1]);
    if (claimed.has(code)) return json({ token: leases.get(code) });
    return json({ status: "pending" });
  };
  return {
    claim(code: string) {
      const l = lease();
      leases.set(code, l);
      claimed.add(code);
      return l;
    },
  };
}

describe("how long a link is watched", () => {
  test("as long as the broker says the code can be claimed (expiresInMs), not a fixed budget", async () => {
    fakeBroker({ expiresInMs: 60 });
    const started = Date.now();
    assert.equal(await executeLinkFlow({ brokerBase: "https://broker.test", pollIntervalMs: 5 }), null);
    assert.ok(Date.now() - started < 3000, "it stopped when the broker's 60ms expiry passed");
    assert.ok(printed.some((l) => l === linkEndedNotice("it expired after 1 min")), printed.join("\n"));
  });

  test("with no expiry from the broker, the default matches the broker's own 10 minutes", () => {
    assert.equal(LINK_FLOW_TIMEOUT_MS, 10 * 60 * 1000);
  });

  test("the notice is the same plain sentence wherever a run ends", () => {
    assert.equal(linkEndedNotice("x"), "[PRO] Link session ended — this QR code is no longer being watched (x). Run /link for a new one.");
  });

  test("a code the broker no longer knows ends the run with the notice", async () => {
    fakeBroker({ pollStatus: () => json({ error: "unknown or expired code" }, 404) });
    assert.equal(await executeLinkFlow({ brokerBase: "https://broker.test", pollIntervalMs: 5, timeoutMs: 5000 }), null);
    assert.ok(printed.some((l) => l.includes("no longer being watched (the broker no longer knows this code")), printed.join("\n"));
  });
});

describe("one /link at a time", () => {
  test("a second /link in this process cancels the first, which says its QR is no longer watched; the second links", async () => {
    const broker = fakeBroker();
    const first = executeLinkFlow({ brokerBase: "https://broker.test", pollIntervalMs: 5, timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 30));
    const second = executeLinkFlow({ brokerBase: "https://broker.test", pollIntervalMs: 5, timeoutMs: 10_000 });
    assert.equal(await first, null);
    assert.ok(printed.includes("[PRO] The previous /link was cancelled: its QR code is no longer being watched."), printed.join("\n"));
    assert.ok(printed.includes(linkEndedNotice("a newer /link replaced it")), printed.join("\n"));
    await new Promise((r) => setTimeout(r, 30));
    const l = broker.claim("CODE2");
    assert.equal(await second, l);
    assert.equal(getValidProToken(), l);
  });

  test("a /link started in another window replaces this one", async () => {
    fakeBroker();
    const run = executeLinkFlow({ brokerBase: "https://broker.test", pollIntervalMs: 5, timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 30));
    const marker = path.join(authDir, "link-active.json");
    assert.ok(fs.existsSync(marker), "the running link marks itself beside the lease");
    // Another process wrote its own run there.
    fs.writeFileSync(marker, JSON.stringify({ runId: "other-window", pid: 1, code: "ZZZZ", startedAt: new Date().toISOString() }));
    assert.equal(await run, null);
    assert.ok(printed.includes(linkEndedNotice("a /link started in another window replaced it")), printed.join("\n"));
    assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).runId, "other-window", "it leaves the newer run's marker alone");
  });

  test("a run that ends removes its own marker", async () => {
    const broker = fakeBroker();
    const run = executeLinkFlow({ brokerBase: "https://broker.test", pollIntervalMs: 5, timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 30));
    broker.claim("CODE1");
    assert.ok(await run);
    assert.equal(fs.existsSync(path.join(authDir, "link-active.json")), false);
  });
});

describe("a broker that keeps answering with an error", () => {
  test("is reported with its actual answer after several failures in a row, and the last answer is in the end notice", async () => {
    fakeBroker({ pollStatus: () => json({ error: "could not check that code — try again" }, 503) });
    assert.equal(await executeLinkFlow({ brokerBase: "https://broker.test", pollIntervalMs: 2, timeoutMs: 200 }), null);
    assert.ok(
      printed.some((l) => /^\[PRO\] The link service is not answering normally \(HTTP 503 — could not check that code — try again, 5 times in a row\); still trying…$/.test(l)),
      printed.join("\n")
    );
    assert.ok(printed.some((l) => l.includes("no longer being watched (it expired after 1 min; the last answer was HTTP 503")), printed.join("\n"));
  });

  test("a few failures followed by a normal answer are not reported", async () => {
    let calls = 0;
    const broker = fakeBroker({ pollStatus: () => (++calls <= 3 ? json({ error: "busy" }, 503) : undefined) });
    const run = executeLinkFlow({ brokerBase: "https://broker.test", pollIntervalMs: 2, timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 60));
    broker.claim("CODE1");
    assert.ok(await run);
    assert.ok(!printed.some((l) => l.includes("not answering normally")), printed.join("\n"));
  });
});
