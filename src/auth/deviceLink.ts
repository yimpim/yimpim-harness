/**
 * Client-side device linking and Pro-lease refresh.
 *
 * The paid zero-config cloud tunnel is leased like a phone pairing: the
 * desktop POSTs for a short alphanumeric session code, the user claims it in
 * the app, and the broker hands back a JWT lease the CLI stores in its local
 * auth cache (see `tokenStorage.ts`). This module is the HTTP half of that
 * flow — the interactive CLI surface that drives it lives in a later phase.
 *
 * Endpoints consumed (all `application/json`):
 *
 *   POST /api/device/request-link   -> { code, claimUrl, userCode?, expiresInMs? }
 *   GET  /api/device/poll/:code      -> { status: "pending" } | { token | jwt | proToken }
 *   POST /api/device/refresh        -> { token | jwt | proToken }    (401 = revoked)
 *
 * Every fetch response is explicitly type-narrowed before any field is read,
 * so a malformed (or unexpected) payload degrades to a typed `null` instead
 * of a TS2339 crash. Refresh failure is fail-open like the rest of the lease
 * lifecycle: only a 401 (permanently revoked) destroys the cached lease.
 */

import { clearCachedAuth, writeCachedAuth } from "./tokenStorage.js";

/** Default broker origin, overridable per call for tests and self-hosting. */
export const BROKER_BASE = "https://broker.yimpim.com";

/** How long pollDeviceClaim waits for the user to claim the code. */
export const LINK_FLOW_TIMEOUT_MS = 5 * 60 * 1000;
/** How often pollDeviceClaim re-checks the claim endpoint. */
export const LINK_POLL_INTERVAL_MS = 2_000;
/** Abort budget for a single HTTP exchange. */
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- typing

/** One of the endpoint responses this module understands. */
export type LinkResult =
  | { kind: "initiated"; code: string; claimUrl: string; userCode?: string }
  | { kind: "claimed"; token: string }
  | { kind: "pending" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

/**
 * Type-narrow a parsed JSON body down to a success payload carrying a lease
 * under exactly one of the accepted field names. Returns null for anything
 * that is not a plain object with a non-empty string lease field.
 */
export function parseClaimedToken(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const raw =
    typeof record.token === "string" ? record.token :
    typeof record.jwt === "string" ? record.jwt :
    typeof record.proToken === "string" ? record.proToken : null;
  return raw && raw.trim() ? raw : null;
}

/** Narrow a parsed JSON body down to `{ status: "pending" }`. */
function isPendingStatus(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  return record.status === "pending";
}

/** Narrow a parsed JSON body down to a string error field, if present. */
function errorMessageFrom(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const record = body as Record<string, unknown>;
  return typeof record.error === "string" ? record.error.trim() : "";
}

/** Parse the response body defensively; anything unreadable becomes null. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Strip a trailing slash so `${base}/path` never doubles up. */
function normalizeBase(brokerUrl: string): string {
  return brokerUrl.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------ pairing prompt

/**
 * Best-effort terminal QR, then ALWAYS the plain-text claim URL.
 *
 * The QR code is a convenience: the claim URL is printed as readable text no
 * matter what happens here, and the dynamic import of `qrcode-terminal` is
 * wrapped so a stripped install or headless terminal degrades to the same
 * usable prompt instead of throwing. The renderer must stay dynamic —
 * `qrcode-terminal` is CommonJS with only a hand-written ambient type, and
 * a static import would surface at startup and make the whole module
 * unloadable when the package is missing.
 */
export async function renderPairingPrompt(claimUrl: string, userCode?: string): Promise<void> {
  if (userCode) {
    console.log(`\nPairing code:  ${userCode}\n`);
  }
  try {
    const qr: unknown = await import("qrcode-terminal");
    const api = (qr as { default?: unknown }).default ?? qr;
    if (typeof (api as { generate?: unknown }).generate === "function") {
      await new Promise<void>((resolve) => {
        (api as { generate: (text: string, opts: unknown, cb: (code: string) => void) => void }).generate(
          claimUrl,
          { small: true },
          (code: string) => {
            console.log(code);
            resolve();
          }
        );
      });
    } else {
      console.log("QR renderer unavailable — the claim URL below works the same.\n");
    }
  } catch {
    console.log("QR renderer unavailable — the claim URL below works the same.\n");
  }
  console.log(`Claim on your phone:\n  ${claimUrl}\n`);
}

// ------------------------------------------------------------ request

export interface InitiateDeviceLinkOptions {
  /** Abort budget for the single request-link exchange. */
  timeoutMs?: number;
}

/**
 * Ask the broker for a fresh pairing session: POST /api/device/request-link.
 * Resolves with the session code and claim URL (returned by the broker or
 * derived from the base when the broker omits one) on success — the caller
 * then renders the prompt and starts polling. Any reachability problem or
 * non-2xx answer throws with a human-readable message.
 */
export async function initiateDeviceLink(
  brokerUrl: string,
  opts: InitiateDeviceLinkOptions = {}
): Promise<LinkResult> {
  const base = normalizeBase(brokerUrl);
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetch(`${base}/api/device/request-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach the link service: ${message}`);
  }

  const body = await readJson(res);
  if (!res.ok) {
    const detail = errorMessageFrom(body);
    throw new Error(`Link request failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  if (typeof body !== "object" || body === null) {
    throw new Error("Link service returned an unreadable response.");
  }

  const record = body as Record<string, unknown>;
  const code = typeof record.code === "string" && record.code.trim() ? record.code.trim() : "";
  if (!code) throw new Error("Link service returned no pairing code.");
  const claimUrl =
    typeof record.claimUrl === "string" && record.claimUrl.trim()
      ? record.claimUrl.trim()
      : `${base}/link#${code}`;
  const userCode =
    typeof record.userCode === "string" && record.userCode.trim() ? record.userCode.trim() : undefined;

  return { kind: "initiated", code, claimUrl, userCode };
}

// -------------------------------------------------------------- polling

export interface PollDeviceClaimOptions {
  /** Poll cadence; defaults to LINK_POLL_INTERVAL_MS (2s). */
  pollIntervalMs?: number;
  /** Total budget for waiting on the user; defaults to LINK_FLOW_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Abort budget for each individual poll request. */
  requestTimeoutMs?: number;
}

/**
 * Poll GET /api/device/poll/:code until the user claims the session, the
 * link dies, or the time budget runs out.
 *
 * Resolves with `{ kind: "claimed", token }` and the lease already persisted
 * via `writeCachedAuth` when the poll answer carries a lease; `{ kind:
 * "pending" }` when the budget ran out with the link still alive; `{ kind:
 * "expired" }` on a 404 (link died — nothing is saved); or `{ kind: "error" }`
 * on a hard failure. Transient network blips are retried silently — they
 * cost nothing and the lease still has time.
 */
export async function pollDeviceClaim(
  brokerUrl: string,
  sessionCode: string,
  opts: PollDeviceClaimOptions = {}
): Promise<LinkResult> {
  const base = normalizeBase(brokerUrl);
  const pollIntervalMs = opts.pollIntervalMs ?? LINK_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? LINK_FLOW_TIMEOUT_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);

    let res: Response;
    try {
      res = await fetch(`${base}/api/device/poll/${encodeURIComponent(sessionCode)}`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      continue; // transient blip — the lease still has time
    }

    if (res.status === 404) {
      return { kind: "expired" };
    }
    if (!res.ok) continue;

    const body = await readJson(res);
    const token = parseClaimedToken(body);
    if (token) {
      writeCachedAuth({ token });
      return { kind: "claimed", token };
    }
    // A live poll that is not (yet) a lease: only `status: "pending"` is a
    // recognized intermediate — anything else is retried, same as a blip.
    if (!isPendingStatus(body)) continue;
  }

  return { kind: "pending" };
}

// -------------------------------------------------------------- refresh

export interface AttemptTokenRefreshOptions {
  /** Abort budget for the single refresh exchange. */
  timeoutMs?: number;
}

/**
 * Re-arm an expiring lease via POST /api/device/refresh. On success the new
 * lease is saved through the shared auth cache and returned. A 401 means the
 * lease is permanently revoked (churned, or outside its refresh window) and
 * the cached lease is destroyed via `clearCachedAuth`. Any other failure —
 * unreachable broker, non-2xx, malformed reply — is fail-open: the existing
 * cache is left exactly as it was, since an unreachable broker must never
 * erase a lease that is still valid on its own.
 */
export async function attemptTokenRefresh(
  brokerUrl: string,
  refreshToken: string,
  opts: AttemptTokenRefreshOptions = {}
): Promise<string | null> {
  const base = normalizeBase(brokerUrl);
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetch(`${base}/api/device/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: refreshToken }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[PRO] Lease refresh unreachable (${message}) — keeping the saved lease.`);
    return null;
  }

  if (res.status === 401) {
    clearCachedAuth();
    console.log("[PRO] Lease rejected by the broker — cleared saved auth.");
    return null;
  }
  if (!res.ok) return null;

  const next = parseClaimedToken(await readJson(res));
  if (!next) return null; // malformed reply — keep the existing cache as-is

  writeCachedAuth({ token: next });
  return next;
}