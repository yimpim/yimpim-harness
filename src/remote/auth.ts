/**
 * CLI Pro-leasing authentication.
 *
 * The paid zero-config cloud tunnel is leased with a JWT minted by the broker
 * (a dynamic Google Play lease tied to the user's subscription). This module
 * owns everything the CLI needs to hold such a lease locally:
 *
 *   - `~/.yimpim/auth.json` persistence, owner-only (0600 file, 0700 dir) —
 *     the token is a bearer credential, so it must never be world-readable
 *     the way a config file can be.
 *   - Offline validity checks: the JWT payload's `exp` is decoded with plain
 *     base64url — no signature verification (the CLI has no broker secret),
 *     no network call. A lease whose `exp` is in the future is treated as
 *     valid until proven otherwise; anything else is worthless offline.
 *   - `attemptTokenRefresh` re-arms the lease against the broker, and is the
 *     one place a saved lease is destroyed: a 401 means it is permanently
 *     revoked (churned/expired past the refresh window), and a refresh that
 *     answers with an explicit downgrade marker means Pro access ended — in
 *     both cases the saved token must not linger.
 *   - `executeLinkFlow` is the phone-pairing entry point for a machine with
 *     no lease at all: request a short alphanumeric link code, show the
 *     claim URL (QR plus plain-text fallback), and poll until the phone
 *     claims it and the broker hands back a fresh lease.
 *
 * Network failures are deliberately fail-open: an unreachable broker must
 * never make a still-valid-in-its-own-right lease disappear.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BROKER_BASE = "https://broker.yimpim.com";

/**
 * How long executeLinkFlow waits for a phone to claim the code when the broker does not say. The broker normally does
 * (`expiresInMs`, 10 minutes): the desktop then watches the code for exactly as long as a phone can claim it, so a late scan
 * never lands on a code nobody is collecting.
 */
export const LINK_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
/** After this many failed polls in a row, the broker's actual answer is shown instead of waiting in silence. */
export const LINK_POLL_FAILURES_BEFORE_NOTICE = 5;
export const LINK_POLL_INTERVAL_MS = 2_000;

/** What lands in ~/.yimpim/auth.json. */
export interface SavedToken {
  /** The Pro lease JWT. */
  token: string;
  /** When this lease was stored/refreshed, ISO-8601. */
  savedAt: string;
}

/**
 * Custom store location for tests and portable setups. Defaults to
 * ~/.yimpim/auth.json; the env override keeps tests (and a user who wants
 * their auth elsewhere) from touching the real home directory.
 */
function authFilePath(): string {
  return process.env.YIMPIM_AUTH_FILE || path.join(os.homedir(), ".yimpim", "auth.json");
}

/** base64url-decode the payload segment of a JWT without verifying anything. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Explicitly free/downgraded leases. Fail-open: only a recognizable downgrade
 * marker counts — a payload that just happens to lack these fields is not
 * downgraded, since exp is what actually governs lease validity.
 */
function isDowngraded(payload: Record<string, unknown>): boolean {
  if (payload.plan === "free" || payload.tier === "free") return true;
  if (payload.pro === false) return true;
  const sub = payload.subscription;
  if (sub && typeof sub === "object" && (sub as Record<string, unknown>).active === false) return true;
  return false;
}

// ------------------------------------------------------------ persistence

export function readSavedToken(): SavedToken | null {
  const file = authFilePath();
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof data?.token !== "string" || !data.token) return null;
    return { token: data.token, savedAt: typeof data.savedAt === "string" ? data.savedAt : "" };
  } catch {
    return null;
  }
}

/**
 * Persist a lease. `~/.yimpim` is created 0700 (it holds credentials, so it
 * must not inherit a loose default umask) and auth.json is written 0600 —
 * owner-only both ways, with an explicit chmod afterwards because
 * writeFileSync's mode only applies to a brand-new file and mkdirSync's mode
 * only applies to a brand-new directory.
 *
 * The bytes are written to a sibling temp file and renamed into place, so an
 * interrupted save can never leave a half-written auth.json behind: a
 * truncated lease file parses as garbage, which reads identically to "no
 * lease saved" and would silently throw away a credential the user just
 * paid for. The temp file carries the same 0600 mode, so the rename cannot
 * widen the permissions.
 */
export function saveProToken(token: string): string {
  const file = authFilePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  const saved: SavedToken = { token, savedAt: new Date().toISOString() };
  const payload = JSON.stringify(saved, null, 2) + "\n";

  const tmp = `${file}.${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {}
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows can refuse the swap while another process holds the
      // destination open. Writing in place is still far better than failing
      // the save outright, so degrade to that and drop the scratch file.
      fs.writeFileSync(file, payload, { encoding: "utf-8", mode: 0o600 });
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }

  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

/** Destroy the saved lease. Best-effort: nothing to do if none exists. */
export function clearProToken(): void {
  try {
    if (fs.existsSync(authFilePath())) fs.unlinkSync(authFilePath());
  } catch {}
}

// ------------------------------------------------------------- offline read

/**
 * Return the saved lease if it is still valid OFFLINE: payload.exp * 1000
 * strictly greater than now. No network, no signature check, no refresh —
 * that is attemptTokenRefresh's job. Returns null when there is no saved
 * token, when it is not a JWT with a numeric exp, or when it has expired.
 */
export function getValidProToken(now = Date.now()): string | null {
  const saved = readSavedToken();
  if (!saved) return null;
  const payload = decodeJwtPayload(saved.token);
  const exp = payload?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp * 1000 <= now) return null;
  return saved.token;
}

// ---------------------------------------------------------------- renewal

export interface RefreshOptions {
  /** Defaults to https://broker.yimpim.com. */
  brokerBase?: string;
  timeoutMs?: number;
}

/**
 * Re-arm the saved lease via POST /api/device/refresh. On success the new
 * lease is saved and returned. A 401 (revoked or outside the refresh window)
 * or an explicit downgrade in the refreshed payload DESTROYS the saved token
 * and returns null. A network failure keeps the saved lease untouched — an
 * unreachable broker must never erase a token that is still valid in itself.
 */
export async function attemptTokenRefresh(opts: RefreshOptions = {}): Promise<string | null> {
  const base = (opts.brokerBase ?? BROKER_BASE).replace(/\/+$/, "");
  const saved = readSavedToken();
  if (!saved) return null; // nothing to refresh

  let res: Response;
  try {
    res = await fetch(`${base}/api/device/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: saved.token }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err: any) {
    console.warn(`[PRO] Lease refresh unreachable (${err?.message ?? err}) — keeping the saved lease.`);
    return null;
  }

  if (res.status === 401) {
    clearProToken();
    console.log(`[PRO] Lease rejected by the broker — cleared saved auth.`);
    return null;
  }
  if (!res.ok) return null;

  let body: any;
  try {
    body = await res.json();
  } catch {
    return null;
  }

  const next =
    typeof body?.token === "string" ? body.token :
    typeof body?.jwt === "string" ? body.jwt :
    typeof body?.proToken === "string" ? body.proToken : undefined;
  if (!next) return null;

  const payload = decodeJwtPayload(next);
  if (!payload || typeof payload.exp !== "number") return null; // malformed reply — keep old state
  if (isDowngraded(payload)) {
    clearProToken();
    console.log(`[PRO] Subscription downgraded — cleared saved auth.`);
    return null;
  }

  saveProToken(next);
  return next;
}

// ------------------------------------------------------------- link flow

export interface LinkFlowOptions {
  /** Defaults to https://broker.yimpim.com. */
  brokerBase?: string;
  /** Line sink for progress messages; defaults to console.log("[PRO] ..."). */
  log?: (msg: string) => void;
  /** Poll cadence for the claim endpoint; defaults to 2s. */
  pollIntervalMs?: number;
  /** Total budget for waiting on the phone; defaults to the broker's own expiry for the code (expiresInMs). */
  timeoutMs?: number;
  requestTimeoutMs?: number;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ---- one /link at a time ---------------------------------------------------------------------------------------------
// Two link runs watching two QR codes is how a scan lands on a code nobody collects: the newest run always wins. Inside this
// process the previous run's AbortController is aborted; across windows (another terminal, another repo, the same lease
// file) a marker beside the lease names the newest run, and an older run that sees another run's id there stops.

let activeLink: AbortController | null = null;

function activeLinkFile(): string {
  return path.join(path.dirname(authFilePath()), "link-active.json");
}

function claimActiveLink(runId: string, code: string): void {
  try {
    fs.mkdirSync(path.dirname(activeLinkFile()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(activeLinkFile(), JSON.stringify({ runId, pid: process.pid, code, startedAt: new Date().toISOString() }), { mode: 0o600 });
  } catch {
    // the in-process guard still works; another window just will not be told
  }
}

function activeLinkRunId(): string | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(activeLinkFile(), "utf8"));
    return typeof v?.runId === "string" ? v.runId : undefined;
  } catch {
    return undefined;
  }
}

function releaseActiveLink(runId: string): void {
  try {
    if (activeLinkRunId() === runId) fs.rmSync(activeLinkFile(), { force: true });
  } catch {
    // nothing to tidy
  }
}

/** Shown whenever a link run stops without linking, so an older QR in the scrollback is never taken for a live one. */
export function linkEndedNotice(why: string): string {
  return `[PRO] Link session ended — this QR code is no longer being watched (${why}). Run /link for a new one.`;
}

/**
 * Best-effort terminal QR. The claim URL is ALWAYS printed as plain text
 * regardless of what happens here, so the flow works even where the
 * renderer cannot load (headless CI, a stripped install).
 */
async function renderClaimQr(claimUrl: string, log: (msg: string) => void): Promise<void> {
  try {
    const qr: any = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      (qr.default ?? qr).generate(claimUrl, { small: true }, (code: string) => {
        console.log(code);
        resolve();
      });
    });
  } catch {
    log("QR renderer unavailable — the claim URL printed below works the same.");
  }
}

/** The poll response carries a lease once claimed; anything else is pending. */
function claimedTokenFrom(body: any): string | undefined {
  const raw =
    typeof body?.token === "string" ? body.token :
    typeof body?.jwt === "string" ? body.jwt :
    typeof body?.proToken === "string" ? body.proToken : undefined;
  if (!raw) return undefined;
  const payload = decodeJwtPayload(raw);
  // Only a real lease (JWT with a numeric exp) satisfies the poll — this
  // never saves a placeholder field the broker happened to reuse.
  if (!payload || typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return undefined;
  return raw;
}

/**
 * The no-lease-on-this-machine path: POST /api/device/request-link for a short code, show it with its claim URL (QR +
 * plain-text fallback), then poll GET /api/device/poll/:code every 2s until the phone claims it and the broker returns a
 * lease, or the code expires (the broker's expiresInMs).
 *
 * Only one run watches a QR at a time: a new run cancels the previous one, in this process or in another window. Every way
 * a run ends without linking prints linkEndedNotice. A broker that keeps answering with an error is reported, not waited on
 * in silence. Returns the saved lease on success, null otherwise.
 */
export async function executeLinkFlow(opts: LinkFlowOptions = {}): Promise<string | null> {
  const base = (opts.brokerBase ?? BROKER_BASE).replace(/\/+$/, "");
  const log = opts.log ?? ((m: string) => console.log(`[PRO] ${m}`));
  const pollInterval = opts.pollIntervalMs ?? LINK_POLL_INTERVAL_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;

  // ---- 0. the newest /link wins ---------------------------------------------
  if (activeLink && !activeLink.signal.aborted) {
    activeLink.abort();
    console.log(`[PRO] The previous /link was cancelled: its QR code is no longer being watched.`);
  }
  const controller = new AbortController();
  activeLink = controller;
  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // ---- 1. request the link code -------------------------------------------
    let res: Response;
    try {
      res = await fetch(`${base}/api/device/request-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err: any) {
      throw new Error(`Could not reach the link service: ${err?.message ?? err}`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const errBody: unknown = await res.json();
        if (errBody && typeof errBody === "object" && "error" in errBody) {
          const err = (errBody as { error?: unknown }).error;
          if (typeof err === "string") detail = err.trim();
        }
      } catch {
        // Non-JSON error body — fall back to the bare status line below.
      }
      throw new Error(`Link request failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    const code = typeof body?.code === "string" && body.code.trim() ? body.code.trim() : "";
    if (!code) throw new Error("Link service returned no pairing code.");
    const claimUrl =
      typeof body?.claimUrl === "string" && body.claimUrl.trim() ? body.claimUrl.trim() : `${base}/link#${code}`;
    // Only this desktop holds the poll secret, and the broker hands the claimed lease only to its holder: the code shown on
    // screen identifies the link, it is not enough to collect it. An older broker sends none, and polling works as before.
    const pollSecret = typeof body?.pollSecret === "string" && body.pollSecret.trim() ? body.pollSecret.trim() : "";
    // Watch the code for as long as the broker lets a phone claim it.
    const brokerTtl = typeof body?.expiresInMs === "number" && body.expiresInMs > 0 ? body.expiresInMs : undefined;
    const timeoutMs = opts.timeoutMs ?? brokerTtl ?? LINK_FLOW_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const minutes = Math.max(1, Math.round(timeoutMs / 60000));
    claimActiveLink(runId, code);

    // ---- 2. print the code and the claim URL (QR is a bonus, never required) -
    console.log();
    console.log("=".repeat(58));
    console.log("🔗 LINK THIS DEVICE TO YIMPIM PRO");
    console.log("=".repeat(58));
    console.log(`\nPairing code:  ${code}\n`);
    await renderClaimQr(claimUrl, log);
    console.log(`Claim on your phone:\n  ${claimUrl}\n`);
    console.log(`Waiting for you to claim the link (up to ${minutes} min)…`);
    log(`claimUrl=${claimUrl}`);

    // ---- 3. poll until claimed, cancelled, or the code expires ---------------
    let lastProgressLog = Date.now();
    let failures = 0;
    let lastProblem = "";
    let lastProblemLog = 0;
    const noteFailure = (problem: string) => {
      failures++;
      lastProblem = problem;
      if (failures >= LINK_POLL_FAILURES_BEFORE_NOTICE && Date.now() - lastProblemLog >= 30_000) {
        lastProblemLog = Date.now();
        console.log(`[PRO] The link service is not answering normally (${problem}, ${failures} times in a row); still trying…`);
      }
    };
    while (Date.now() < deadline) {
      await sleep(pollInterval, controller.signal);
      if (controller.signal.aborted) {
        console.log(linkEndedNotice("a newer /link replaced it"));
        return null;
      }
      const newest = activeLinkRunId();
      if (newest && newest !== runId) {
        console.log(linkEndedNotice("a /link started in another window replaced it"));
        return null;
      }

      let pollRes: Response;
      try {
        pollRes = await fetch(`${base}/api/device/poll/${encodeURIComponent(code)}`, {
          ...(pollSecret ? { headers: { authorization: `Bearer ${pollSecret}` } } : {}),
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (err: any) {
        noteFailure(`could not reach it: ${String(err?.message ?? err).split("\n")[0].slice(0, 80)}`);
        continue; // transient network blip — the code still has time
      }

      if (pollRes.status === 404) {
        console.log(linkEndedNotice("the broker no longer knows this code: it expired or was already used"));
        return null;
      }
      if (!pollRes.ok) {
        let detail = "";
        try {
          const e: any = await pollRes.json();
          if (typeof e?.error === "string") detail = ` — ${e.error.trim().slice(0, 100)}`;
        } catch {
          // no JSON body
        }
        noteFailure(`HTTP ${pollRes.status}${detail}`);
        continue;
      }

      let pollBody: any;
      try {
        pollBody = await pollRes.json();
      } catch {
        noteFailure("an unreadable answer");
        continue;
      }
      failures = 0;
      const lease = claimedTokenFrom(pollBody);
      if (lease) {
        saveProToken(lease);
        console.log(`\n✅ Device linked — Pro lease saved.`);
        return lease;
      }

      if (Date.now() - lastProgressLog >= 30_000) {
        lastProgressLog = Date.now();
        console.log(`Still waiting for you to claim the link on your phone… (code ${code})`);
      }
    }

    console.log(linkEndedNotice(`it expired after ${minutes} min${lastProblem && failures > 0 ? `; the last answer was ${lastProblem}` : ""}`));
    return null;
  } finally {
    releaseActiveLink(runId);
    if (activeLink === controller) activeLink = null;
  }
}
