/**
 * Regression tests for the dual-tier relay routing in src/remote/autoRelay.ts.
 *
 * The ORDERING is the whole contract of this module and the easiest thing to
 * break: a valid Pro lease must win over everything, an expired lease gets
 * exactly one refresh attempt, and the `/link` offer must only ever be made
 * when there is neither a lease nor a usable Tailscale. Every case stubs
 * globalThis.fetch so no test ever talks to a real broker, and
 * `tailscaleAvailable: false` keeps the machine's own Tailscale install from
 * changing which tier the test exercises.
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { provisionRelay, provisionCloudTunnel, RelayUnavailable } from "../src/remote/autoRelay.js";
import { saveProToken, readSavedToken } from "../src/remote/auth.js";

const tempDirs: string[] = [];
const originalAuthFile = process.env.YIMPIM_AUTH_FILE;
const originalFetch = globalThis.fetch;

/** Install a fetch stub for one test. Restored globally in `after`. */
function stubFetch(impl: (url: string, init?: any) => Promise<Response> | Response): void {
  (globalThis as any).fetch = async (url: any, init?: any) => impl(String(url), init);
}

function jwtWithExp(expSecs: number, extra: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u_1", exp: expSecs, ...extra })}.fake-signature`;
}

/** A startLocalRelay that must never be reached on any of the cloud paths. */
const noLocalRelay = async (): Promise<{ server: Server; port: number }> => {
  throw new Error("startLocalRelay must not be called when a cloud tier answers");
};

const noTailscale = { tailscaleAvailable: false } as const;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-relay-test-"));
  tempDirs.push(dir);
  process.env.YIMPIM_AUTH_FILE = path.join(dir, "auth.json");
});

after(async () => {
  if (originalAuthFile === undefined) delete process.env.YIMPIM_AUTH_FILE;
  else process.env.YIMPIM_AUTH_FILE = originalAuthFile;
  (globalThis as any).fetch = originalFetch;
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("provisionCloudTunnel", () => {
  test("returns the broker's endpoint and never starts a local relay", async () => {
    stubFetch(async () => new Response(JSON.stringify({ url: "https://abc.tunnel.yimpim.com" }), { status: 200 }));
    const relay = await provisionCloudTunnel("lease-jwt", { brokerBase: "https://broker.test" });
    assert.equal(relay.url, "https://abc.tunnel.yimpim.com");
    assert.equal(relay.source, "cloud");
    await relay.stop(); // a no-op, not a throw
  });

  test("sends the lease in the POST body to /api/tunnel/provision", async () => {
    let seen: { url: string; init: any } | undefined;
    stubFetch(async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ url: "https://abc.tunnel.yimpim.com" }), { status: 200 });
    });
    await provisionCloudTunnel("lease-jwt", { brokerBase: "https://broker.test/" });
    assert.equal(seen?.url, "https://broker.test/api/tunnel/provision", "trailing slash is normalised away");
    assert.equal(seen?.init.method, "POST");
    assert.deepEqual(JSON.parse(seen?.init.body), { token: "lease-jwt" });
  });

  test("fails closed on a 401 so the caller can fall through to another tier", async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: "revoked" }), { status: 401 }));
    await assert.rejects(
      () => provisionCloudTunnel("stale", { brokerBase: "https://broker.test" }),
      (err: any) => err instanceof RelayUnavailable
    );
  });

  test("fails closed when the broker answers 200 with no usable endpoint", async () => {
    stubFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await assert.rejects(
      () => provisionCloudTunnel("lease-jwt", { brokerBase: "https://broker.test" }),
      (err: any) => err instanceof RelayUnavailable
    );
  });

  test("fails closed when the broker is unreachable", async () => {
    stubFetch(async () => {
      throw new Error("ENOTFOUND broker.test");
    });
    await assert.rejects(
      () => provisionCloudTunnel("lease-jwt", { brokerBase: "https://broker.test" }),
      (err: any) => err instanceof RelayUnavailable
    );
  });

  test("accepts a tunnelUrl alias from the broker", async () => {
    stubFetch(async () => new Response(JSON.stringify({ tunnelUrl: "https://alias.example/" }), { status: 200 }));
    const relay = await provisionCloudTunnel("lease-jwt", { brokerBase: "https://broker.test" });
    assert.equal(relay.url, "https://alias.example");
  });
});

describe("provisionRelay — tier ordering", () => {
  test("a valid lease routes straight to the cloud tunnel, ahead of a configured URL", async () => {
    saveProToken(jwtWithExp(Math.floor(Date.now() / 1000) + 3600, { tier: "pro" }));

    const urls: string[] = [];
    stubFetch(async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ url: "https://cloud.example" }), { status: 200 });
    });

    const logs: string[] = [];
    const relay = await provisionRelay({
      configuredUrl: "https://my-own-relay.example",
      startLocalRelay: noLocalRelay,
      log: (m) => logs.push(m),
      brokerBase: "https://broker.test",
      ...noTailscale,
    });

    assert.equal(relay.source, "cloud");
    assert.equal(relay.url, "https://cloud.example");
    assert.deepEqual(urls, ["https://broker.test/api/tunnel/provision"], "no /healthz probe of the configured URL");
    assert.ok(logs.some((l) => /cloud tunnel/i.test(l)), `logged the cloud path: ${logs.join(" | ")}`);
  });

  test("an expired lease gets exactly one refresh attempt, then the cloud tunnel", async () => {
    saveProToken(jwtWithExp(Math.floor(Date.now() / 1000) - 60));
    const fresh = jwtWithExp(Math.floor(Date.now() / 1000) + 3600, { tier: "pro" });

    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(url);
      if (url.endsWith("/api/device/refresh")) return new Response(JSON.stringify({ token: fresh }), { status: 200 });
      return new Response(JSON.stringify({ url: "https://cloud.example" }), { status: 200 });
    });

    const relay = await provisionRelay({
      configuredUrl: "",
      startLocalRelay: noLocalRelay,
      log: () => {},
      brokerBase: "https://broker.test",
      ...noTailscale,
    });

    assert.equal(relay.source, "cloud");
    assert.deepEqual(calls, [
      "https://broker.test/api/device/refresh",
      "https://broker.test/api/tunnel/provision",
    ]);
    assert.equal(readSavedToken()?.token, fresh, "the renewed lease is persisted");
  });

  test("a refresh the broker rejects clears the stale lease and does not dead-end silently", async () => {
    saveProToken(jwtWithExp(Math.floor(Date.now() / 1000) - 60));
    stubFetch(async () => new Response(JSON.stringify({ error: "revoked" }), { status: 401 }));

    await assert.rejects(
      () =>
        provisionRelay({
          configuredUrl: "",
          startLocalRelay: noLocalRelay,
          log: () => {},
          brokerBase: "https://broker.test",
          ...noTailscale,
        }),
      (err: any) => err instanceof RelayUnavailable && err.guidance.length > 0
    );
    assert.equal(readSavedToken(), null, "a 401 on refresh must clear the saved lease");
  });

  test("no lease, no Tailscale, declined offer -> actionable guidance, no link prompt beyond the one ask", async () => {
    stubFetch(async () => {
      throw new Error("no network call is expected on this path");
    });

    let asked = 0;
    await assert.rejects(
      () =>
        provisionRelay({
          configuredUrl: "",
          startLocalRelay: noLocalRelay,
          log: () => {},
          brokerBase: "https://broker.test",
          confirmLinkFlow: async () => {
            asked++;
            return false;
          },
          ...noTailscale,
        }),
      (err: any) => err instanceof RelayUnavailable && err.guidance.length > 0
    );
    assert.equal(asked, 1, "the user is offered the link flow exactly once");
  });

  test("no lease, no Tailscale, user consents -> link flow, lease saved, cloud tunnel", async () => {
    const lease = jwtWithExp(Math.floor(Date.now() / 1000) + 3600, { tier: "pro" });
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(url);
      if (url.endsWith("/api/device/request-link")) {
        return new Response(JSON.stringify({ code: "ABCD1234", claimUrl: "https://broker.test/link#ABCD1234" }), {
          status: 200,
        });
      }
      if (url.includes("/api/device/poll/")) return new Response(JSON.stringify({ token: lease }), { status: 200 });
      if (url.endsWith("/api/tunnel/provision")) {
        return new Response(JSON.stringify({ url: "https://cloud.example" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const originalLog = console.log;
    console.log = () => {};
    try {
      const relay = await provisionRelay({
        configuredUrl: "",
        startLocalRelay: noLocalRelay,
        log: () => {},
        brokerBase: "https://broker.test",
        confirmLinkFlow: async () => true,
        linkFlowOptions: { pollIntervalMs: 1, timeoutMs: 500 },
        ...noTailscale,
      });
      assert.equal(relay.source, "cloud");
      assert.ok(calls.includes("https://broker.test/api/device/request-link"));
      assert.ok(calls.includes("https://broker.test/api/tunnel/provision"));
      assert.equal(readSavedToken()?.token, lease, "the lease claimed on the phone is persisted");
    } finally {
      console.log = originalLog;
    }
  });
});
