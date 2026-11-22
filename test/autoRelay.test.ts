/**
 * Remote control runs through the hosted YIMPIM broker and only through it: a valid Pro lease goes to the cloud tunnel, an
 * expired one gets exactly one refresh, a machine with no lease is offered the `/link` flow once, and otherwise the answer is
 * "link this machine to YIMPIM Pro". There is no self-hosted relay, no Tailscale path and no configurable relay URL to fall
 * back to. Every case stubs globalThis.fetch, so no test talks to a real broker.
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionRelay, provisionCloudTunnel, RelayUnavailable, LINK_GUIDANCE } from "../src/remote/autoRelay.js";
import { saveProToken, readSavedToken } from "../src/remote/auth.js";
import { ConfigSchema } from "../src/config.js";
import { SETTINGS } from "../src/settings.js";

const tempDirs: string[] = [];
const originalAuthFile = process.env.YIMPIM_AUTH_FILE;
const originalFetch = globalThis.fetch;

function stubFetch(impl: (url: string, init?: any) => Promise<Response> | Response): void {
  (globalThis as any).fetch = async (url: any, init?: any) => impl(String(url), init);
}

function jwtWithExp(expSecs: number, extra: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u_1", exp: expSecs, ...extra })}.fake-signature`;
}
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const aMinuteAgo = () => Math.floor(Date.now() / 1000) - 60;

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
  test("returns the broker's endpoint", async () => {
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

  test("fails closed on a 401, on a 200 with no endpoint, and when the broker is unreachable", async () => {
    for (const impl of [
      async () => new Response(JSON.stringify({ error: "revoked" }), { status: 401 }),
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      async () => {
        throw new Error("ENOTFOUND broker.test");
      },
    ]) {
      stubFetch(impl);
      await assert.rejects(() => provisionCloudTunnel("lease-jwt", { brokerBase: "https://broker.test" }), (err: any) => err instanceof RelayUnavailable);
    }
  });

  test("accepts a tunnelUrl alias from the broker", async () => {
    stubFetch(async () => new Response(JSON.stringify({ tunnelUrl: "https://alias.example/" }), { status: 200 }));
    const relay = await provisionCloudTunnel("lease-jwt", { brokerBase: "https://broker.test" });
    assert.equal(relay.url, "https://alias.example");
  });
});

describe("provisionRelay — the hosted broker only", () => {
  test("a valid lease goes straight to the cloud tunnel", async () => {
    saveProToken(jwtWithExp(inAnHour(), { tier: "pro" }));
    const urls: string[] = [];
    stubFetch(async (url) => (urls.push(url), new Response(JSON.stringify({ url: "https://cloud.example" }), { status: 200 })));
    const logs: string[] = [];
    const relay = await provisionRelay({ log: (m) => logs.push(m), brokerBase: "https://broker.test" });
    assert.equal(relay.source, "cloud");
    assert.equal(relay.url, "https://cloud.example");
    assert.deepEqual(urls, ["https://broker.test/api/tunnel/provision"]);
    assert.ok(logs.some((l) => /cloud tunnel/i.test(l)), logs.join(" | "));
  });

  test("a valid lease the broker cannot serve fails with the broker's reason: there is nothing else to fall back to", async () => {
    saveProToken(jwtWithExp(inAnHour(), { tier: "pro" }));
    stubFetch(async () => {
      throw new Error("ENOTFOUND broker.test");
    });
    await assert.rejects(() => provisionRelay({ log: () => {}, brokerBase: "https://broker.test" }), (err: any) => err instanceof RelayUnavailable && /reach the YIMPIM broker/.test(err.message));
  });

  test("an expired lease gets exactly one refresh attempt, then the cloud tunnel", async () => {
    saveProToken(jwtWithExp(aMinuteAgo()));
    const fresh = jwtWithExp(inAnHour(), { tier: "pro" });
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(url);
      if (url.endsWith("/api/device/refresh")) return new Response(JSON.stringify({ token: fresh }), { status: 200 });
      return new Response(JSON.stringify({ url: "https://cloud.example" }), { status: 200 });
    });
    const relay = await provisionRelay({ log: () => {}, brokerBase: "https://broker.test" });
    assert.equal(relay.source, "cloud");
    assert.deepEqual(calls, ["https://broker.test/api/device/refresh", "https://broker.test/api/tunnel/provision"]);
    assert.equal(readSavedToken()?.token, fresh, "the renewed lease is persisted");
  });

  test("a refresh the broker rejects clears the stale lease and ends with the link guidance", async () => {
    saveProToken(jwtWithExp(aMinuteAgo()));
    stubFetch(async () => new Response(JSON.stringify({ error: "revoked" }), { status: 401 }));
    await assert.rejects(() => provisionRelay({ log: () => {}, brokerBase: "https://broker.test" }), (err: any) => err instanceof RelayUnavailable && err.guidance === LINK_GUIDANCE);
    assert.equal(readSavedToken(), null, "a 401 on refresh must clear the saved lease");
  });

  test("no lease, declined offer: asked exactly once, then the link guidance, with no network call", async () => {
    stubFetch(async () => {
      throw new Error("no network call is expected on this path");
    });
    let asked = 0;
    await assert.rejects(
      () => provisionRelay({ log: () => {}, brokerBase: "https://broker.test", confirmLinkFlow: async () => (asked++, false) }),
      (err: any) => err instanceof RelayUnavailable && /not linked to YIMPIM Pro/.test(err.message) && err.guidance.some((g: string) => g.includes("/link"))
    );
    assert.equal(asked, 1);
  });

  test("no lease, user consents: link flow, lease saved, cloud tunnel", async () => {
    const lease = jwtWithExp(inAnHour(), { tier: "pro" });
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(url);
      if (url.endsWith("/api/device/request-link")) return new Response(JSON.stringify({ code: "ABCD1234", claimUrl: "https://broker.test/link#ABCD1234" }), { status: 200 });
      if (url.includes("/api/device/poll/")) return new Response(JSON.stringify({ token: lease }), { status: 200 });
      if (url.endsWith("/api/tunnel/provision")) return new Response(JSON.stringify({ url: "https://cloud.example" }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      const relay = await provisionRelay({ log: () => {}, brokerBase: "https://broker.test", confirmLinkFlow: async () => true, linkFlowOptions: { pollIntervalMs: 1, timeoutMs: 500 } });
      assert.equal(relay.source, "cloud");
      assert.ok(calls.includes("https://broker.test/api/device/request-link"));
      assert.equal(readSavedToken()?.token, lease);
    } finally {
      console.log = originalLog;
    }
  });
});

describe("no self-hosted path is left in the harness", () => {
  const src = (f: string) => fsSync.readFileSync(f, "utf8");
  test("the relay server and its device page are gone, and nothing imports them", () => {
    assert.equal(fsSync.existsSync("src/remote/relay.ts"), false);
    assert.equal(fsSync.existsSync("src/remote/ui.ts"), false);
    for (const f of fsSync.readdirSync("src", { recursive: true }) as string[]) {
      if (!f.endsWith(".ts")) continue;
      assert.doesNotMatch(src(path.join("src", f)), /remote\/relay\.js|remote\/ui\.js|\.\/relay\.js|\.\/ui\.js|createRelay|DEVICE_PAGE/, f);
    }
  });
  test("no Tailscale tier, no configured relay URL, no `relay` command", () => {
    assert.doesNotMatch(src("src/remote/autoRelay.ts"), /tailscale|configuredUrl|startLocalRelay/i);
    assert.equal("brokerUrl" in (ConfigSchema.parse({}).remote as any), false);
    assert.equal(SETTINGS.some((s: { key: string }) => s.key === "remote.brokerUrl"), false);
    assert.doesNotMatch(src("src/cli.ts"), /"relay"|yimpim relay/);
    assert.doesNotMatch(src("README.md"), /yimpim relay|tailscale serve|remote\.brokerUrl/i);
  });
  test("an old config that still sets remote.brokerUrl loads, the key dropped", () => {
    const c = ConfigSchema.parse({ remote: { brokerUrl: "https://my-relay.example", redactLogs: true } }) as any;
    assert.equal(c.remote.redactLogs, true);
    assert.equal("brokerUrl" in c.remote, false);
  });
});
