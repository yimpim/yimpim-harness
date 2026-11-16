/**
 * The open relay.
 *
 * A small, deliberately dumb relay for running remote control yourself (over Tailscale, or `gage relay` on a machine both
 * your computer and phone can reach over HTTPS). It routes opaque, end-to-end encrypted envelopes between one agent and one
 * paired device. It never holds the session key, so a compromised relay can deny service and nothing more.
 *
 * This is the free, self-hosted path. It has no accounts, no subscriptions, no push notifications, no usage metrics and no
 * hosted tunnel: those belong to the hosted YIMPIM service, which is a separate product with its own terms.
 *
 * Sessions live in memory and expire; restarting this relay unpairs everyone.
 */

import http from "node:http";
import { Envelope, generateId, hashToken, safeEqual } from "./protocol.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 2 * 60 * 1000;
const MAX_QUEUE = 500;
const MAX_BODY_BYTES = 1_000_000;
const LONG_POLL_MS = 25_000;

interface Session {
  id: string;
  agentTokenHash: string;
  /** Hash of the one-time pairing secret; cleared once redeemed. */
  pairingHash?: string;
  pairingExpiresAt: number;
  /** Exactly one device may be paired. */
  deviceTokenHash?: string;
  events: Envelope[];
  commands: Envelope[];
  lastSeenAt: number;
  /** Agents currently long-polling for commands. */
  waiters: (() => void)[];
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

/** Authenticate by comparing the presented token's hash, in constant time. */
function authed(token: string | undefined, expectedHash: string | undefined): boolean {
  if (!token || !expectedHash) return false;
  return safeEqual(hashToken(token), expectedHash);
}

export function createRelay(): http.Server {
  const sessions = new Map<string, Session>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeenAt > SESSION_TTL_MS) sessions.delete(id);
  }, 60_000);
  sweep.unref?.();

  const getSession = (id: unknown): Session | undefined => {
    if (typeof id !== "string") return undefined;
    const s = sessions.get(id);
    if (s) s.lastSeenAt = Date.now();
    return s;
  };
  const wake = (s: Session) => {
    for (const w of s.waiters.splice(0)) w();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    try {
      // Agent: open a session.
      if (req.method === "POST" && path === "/v1/register") {
        const body = await readBody(req);
        if (typeof body.pairingHash !== "string" || body.pairingHash.length !== 64) {
          return json(res, 400, { error: "pairingHash required (sha256 hex)" });
        }
        const sessionId = generateId("s");
        const agentToken = generateId("at") + generateId("x");
        sessions.set(sessionId, {
          id: sessionId,
          agentTokenHash: hashToken(agentToken),
          pairingHash: body.pairingHash,
          pairingExpiresAt: Date.now() + PAIRING_TTL_MS,
          events: [],
          commands: [],
          lastSeenAt: Date.now(),
          waiters: [],
        });
        return json(res, 200, { sessionId, agentToken, pairingTtlMs: PAIRING_TTL_MS });
      }

      // Device: redeem the one-time pairing secret.
      if (req.method === "POST" && path === "/v1/pair") {
        const body = await readBody(req);
        const s = getSession(body.sessionId);
        if (!s) return json(res, 404, { error: "session not found", code: "session_not_found" });
        if (!s.pairingHash) return json(res, 409, { error: "already paired — re-pair from the desktop", code: "already_paired" });
        if (Date.now() > s.pairingExpiresAt) return json(res, 410, { error: "pairing code expired — re-pair from the desktop", code: "pairing_expired" });
        if (typeof body.pairing !== "string" || !safeEqual(hashToken(body.pairing), s.pairingHash)) {
          // A wrong guess burns the code; it is single use by design.
          s.pairingHash = undefined;
          return json(res, 403, { error: "invalid pairing code — code burned, re-pair from the desktop", code: "pairing_invalid" });
        }
        const deviceToken = generateId("dt") + generateId("y");
        s.deviceTokenHash = hashToken(deviceToken);
        s.pairingHash = undefined;
        return json(res, 200, { deviceToken, sessionId: s.id, pro: false });
      }

      // Agent: end a session now.
      if (req.method === "POST" && path === "/v1/unregister") {
        const body = await readBody(req);
        const s = getSession(body.sessionId);
        if (!s || !authed(bearer(req), s.agentTokenHash)) return json(res, 401, { error: "unauthorized" });
        sessions.delete(s.id);
        return json(res, 200, { ok: true });
      }

      // Agent: push encrypted events.
      if (req.method === "POST" && path === "/v1/events") {
        const body = await readBody(req);
        const s = getSession(body.sessionId);
        if (!s || !authed(bearer(req), s.agentTokenHash)) return json(res, 401, { error: "unauthorized" });
        const incoming: Envelope[] = Array.isArray(body.events) ? body.events : [];
        s.events.push(...incoming);
        if (s.events.length > MAX_QUEUE) s.events.splice(0, s.events.length - MAX_QUEUE);
        return json(res, 200, { ok: true, paired: Boolean(s.deviceTokenHash) });
      }

      // Agent: long-poll for commands.
      if (req.method === "GET" && path === "/v1/commands") {
        const s = getSession(url.searchParams.get("sessionId"));
        if (!s || !authed(bearer(req), s.agentTokenHash)) return json(res, 401, { error: "unauthorized" });
        if (s.commands.length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), LONG_POLL_MS);
            timer.unref?.();
            s.waiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        return json(res, 200, { commands: s.commands.splice(0), paired: Boolean(s.deviceTokenHash) });
      }

      // Device: read events.
      if (req.method === "GET" && path === "/v1/stream") {
        const s = getSession(url.searchParams.get("sessionId"));
        if (!s || !authed(bearer(req), s.deviceTokenHash)) return json(res, 401, { error: "unauthorized" });
        const after = Number(url.searchParams.get("after") ?? -1);
        return json(res, 200, { events: s.events.filter((e) => e.seq > after) });
      }

      // Device: submit a command.
      if (req.method === "POST" && path === "/v1/command") {
        const body = await readBody(req);
        const s = getSession(body.sessionId);
        if (!s || !authed(bearer(req), s.deviceTokenHash)) return json(res, 401, { error: "unauthorized" });
        if (!body.envelope) return json(res, 400, { error: "envelope required" });
        s.commands.push(body.envelope as Envelope);
        if (s.commands.length > MAX_QUEUE) s.commands.splice(0, s.commands.length - MAX_QUEUE);
        wake(s);
        return json(res, 200, { ok: true });
      }

      // The phone page, fully self-contained.
      if (req.method === "GET" && (path === "/p" || path === "/")) {
        const { DEVICE_PAGE } = await import("./ui.js");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
        });
        return res.end(DEVICE_PAGE);
      }

      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true, sessions: sessions.size });

      // Push notifications, accounts and the hosted tunnel are not part of the open relay.
      return json(res, 404, { error: "not found" });
    } catch (err: any) {
      return json(res, 400, { error: err?.message ?? "bad request" });
    }
  });
  return server;
}
