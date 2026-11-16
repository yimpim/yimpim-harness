/**
 * Local Pro-lease token storage and offline expiry evaluation.
 *
 * The paid zero-config cloud tunnel is leased with a JWT minted by the broker.
 * This module owns the purely LOCAL half of holding such a lease:
 *
 *   - `getAuthFilePath()` resolves where the lease lives: `$YIMPIM_AUTH_FILE`
 *     when set (tests and portable setups), otherwise `~/.yimpim/auth.json`.
 *   - `writeCachedAuth` / `readCachedAuth` / `clearCachedAuth` manage the JSON
 *     file, written owner-only (0600 file, 0700 dir) because a bearer token
 *     must never be world-readable the way a config file can be.
 *   - `isTokenActive` evaluates whether a JWT lease is still valid OFFLINE by
 *     decoding the payload's `exp` with plain base64url — no signature
 *     verification (the CLI has no broker secret), no network call. A lease
 *     whose `exp` is in the future is treated as valid until proven otherwise.
 *
 * Everything here is deliberately synchronous and side-effect-light outside
 * the single auth file: later phases (device linking, refresh polling, relay
 * routing) build on top of this module and never re-implement storage.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What lands in the auth cache file (default ~/.yimpim/auth.json). */
export interface CachedAuth {
  /** The Pro lease JWT. */
  token: string;
  /** When this lease was stored/refreshed, ISO-8601; stamped on write if omitted. */
  savedAt?: string;
}

/**
 * Resolve where the auth cache lives: `$YIMPIM_AUTH_FILE` when set (tests and
 * portable setups keep it from touching the real home directory), otherwise
 * `~/.yimpim/auth.json`.
 */
export function getAuthFilePath(): string {
  return process.env.YIMPIM_AUTH_FILE || path.join(os.homedir(), ".yimpim", "auth.json");
}

/** base64url-decode the payload segment of a JWT without verifying anything. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ persistence

/** Read the cached lease, or null when nothing (or garbage) is on disk. */
export function readCachedAuth(): CachedAuth | null {
  const file = getAuthFilePath();
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof data?.token !== "string" || !data.token) return null;
    return { token: data.token, savedAt: typeof data.savedAt === "string" ? data.savedAt : undefined };
  } catch {
    return null;
  }
}

/**
 * Persist a lease. The parent directory is created 0700 (it holds a
 * credential, so it must not inherit a loose default umask) and the file is
 * written 0600 — owner-only both ways, with an explicit chmod afterwards
 * because writeFileSync's mode only applies to a brand-new file and
 * mkdirSync's mode only applies to a brand-new directory.
 *
 * Returns the path written, so callers/tests can assert on it.
 */
export function writeCachedAuth(tokenData: CachedAuth): string {
  const file = getAuthFilePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  const cached: CachedAuth = {
    token: tokenData.token,
    savedAt: tokenData.savedAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(cached, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

/** Destroy the cached lease. Best-effort: nothing to do if none exists. */
export function clearCachedAuth(): void {
  try {
    if (fs.existsSync(getAuthFilePath())) fs.unlinkSync(getAuthFilePath());
  } catch {}
}

// ------------------------------------------------------------- offline read

/**
 * Return true when the JWT lease is still valid OFFLINE: payload.exp * 1000
 * strictly greater than now. No network, no signature check. False for
 * anything that is not a well-formed JWT with a numeric exp, and for expired
 * leases (now >= exp * 1000).
 */
export function isTokenActive(token: string, now = Date.now()): boolean {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
  return exp * 1000 > now;
}