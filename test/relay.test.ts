/**
 * The open relay: routes encrypted envelopes between one agent and one paired device, and nothing else. No accounts, no
 * subscriptions, no push, no hosted tunnel (those are the hosted service's, which is a separate product).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { createRelay } from "../src/remote/relay.js";
import { hashToken } from "../src/remote/protocol.js";

let server: http.Server;
let base = "";

before(async () => {
  server = createRelay();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
};
const env = (sessionId: string, seq: number) => ({ v: 1, sessionId, seq, iv: "iv", data: "data", tag: "tag" });

async function paired() {
  const pairing = `secret-${Math.random()}`;
  const reg = await call("POST", "/v1/register", { pairingHash: hashToken(pairing) });
  const pair = await call("POST", "/v1/pair", { sessionId: reg.json.sessionId, pairing });
  return { sessionId: reg.json.sessionId as string, agent: reg.json.agentToken as string, device: pair.json.deviceToken as string };
}

describe("the open relay", () => {
  test("an agent and a device exchange envelopes both ways, and the relay never sees plaintext keys", async () => {
    const s = await paired();
    assert.equal((await call("POST", "/v1/events", { sessionId: s.sessionId, events: [env(s.sessionId, 1), env(s.sessionId, 2)] }, s.agent)).json.paired, true);
    assert.deepEqual((await call("GET", `/v1/stream?sessionId=${s.sessionId}&after=1`, undefined, s.device)).json.events.map((e: any) => e.seq), [2]);
    assert.equal((await call("POST", "/v1/command", { sessionId: s.sessionId, envelope: env(s.sessionId, 9) }, s.device)).status, 200);
    assert.deepEqual((await call("GET", `/v1/commands?sessionId=${s.sessionId}`, undefined, s.agent)).json.commands.map((e: any) => e.seq), [9]);
  });

  test("tokens are not interchangeable and a wrong one is refused", async () => {
    const s = await paired();
    assert.equal((await call("GET", `/v1/stream?sessionId=${s.sessionId}`, undefined, s.agent)).status, 401);
    assert.equal((await call("POST", "/v1/events", { sessionId: s.sessionId, events: [] }, s.device)).status, 401);
    assert.equal((await call("POST", "/v1/events", { sessionId: s.sessionId, events: [] }, "nope")).status, 401);
  });

  test("a pairing code works once, and a wrong guess burns it", async () => {
    const pairing = "one-time";
    const reg = await call("POST", "/v1/register", { pairingHash: hashToken(pairing) });
    assert.equal((await call("POST", "/v1/pair", { sessionId: reg.json.sessionId, pairing: "wrong" })).status, 403);
    assert.equal((await call("POST", "/v1/pair", { sessionId: reg.json.sessionId, pairing })).status, 409);
  });

  test("an agent can end its session", async () => {
    const s = await paired();
    assert.equal((await call("POST", "/v1/unregister", { sessionId: s.sessionId }, s.agent)).status, 200);
    assert.equal((await call("GET", `/v1/stream?sessionId=${s.sessionId}`, undefined, s.device)).status, 401);
  });

  test("it serves the phone page and a health check, and none of the hosted service's routes", async () => {
    const page = await call("GET", "/p");
    assert.equal(page.status, 200);
    assert.match(page.text, /<html|<!doctype/i);
    assert.equal((await call("GET", "/healthz")).json.ok, true);
    for (const [m, p] of [["POST", "/api/device/request-link"], ["POST", "/api/tunnel/provision"], ["POST", "/v1/push/register"], ["POST", "/v1/push/notify"]] as const) {
      assert.equal((await call(m, p, {})).status, 404, p);
    }
  });

  test("a Pro lease in a register call changes nothing: there is no account check here", async () => {
    const reg = await call("POST", "/v1/register", { pairingHash: hashToken("x"), proToken: "not-a-real-lease" });
    assert.equal(reg.status, 200);
  });
});
