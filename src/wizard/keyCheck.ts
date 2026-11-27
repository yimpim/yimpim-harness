/**
 * Checking an OpenRouter key without ever showing it. The key is only ever displayed masked (sk-or-••••1234), and every error that
 * could carry it is passed through sanitize() before anyone sees it.
 */

import { scrubCredentials } from "../redact.js";
import { OPENROUTER_APP_HEADERS } from "../openrouter.js";

export const AUTH_KEY_URL = "https://openrouter.ai/api/v1/auth/key";

/** OpenRouter keys start with sk-or-. Used only for a warning: formats change, so it never blocks. */
export function looksLikeOpenRouterKey(key: string): boolean {
  return /^sk-or-[A-Za-z0-9_-]{8,}$/.test(key.trim());
}

/** sk-or-••••1234. Short or odd input shows no characters at all. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length < 12) return "••••";
  const prefix = k.startsWith("sk-or-") ? "sk-or-" : "";
  return `${prefix}••••${k.slice(-4)}`;
}

/** Removes the key itself, and anything else credential-shaped, from text meant for a person. */
export function sanitize(text: string, key?: string): string {
  let out = String(text ?? "");
  const k = key?.trim();
  if (k && k.length >= 6) out = out.split(k).join(maskKey(k));
  return scrubCredentials(out).text;
}

export interface KeyInfo {
  label?: string;
  /** Dollars used on this key so far. */
  usage?: number;
  /** The key's credit limit in dollars; null when it has none. */
  limit: number | null;
  limitRemaining?: number | null;
  isFreeTier?: boolean;
}

export type KeyCheck = { ok: true; info: KeyInfo } | { ok: false; reason: string };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Reads OpenRouter's /auth/key answer. Tolerant: a field it does not recognise is left out, never guessed. */
export function parseKeyInfo(body: unknown): KeyInfo {
  const d: any = (body as any)?.data ?? {};
  const limit = num(d.limit);
  return {
    label: typeof d.label === "string" && d.label.trim() ? d.label.trim() : undefined,
    usage: num(d.usage),
    limit: limit === undefined ? null : limit,
    limitRemaining: d.limit_remaining === null ? null : num(d.limit_remaining),
    isFreeTier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : undefined,
  };
}

/** Asks OpenRouter whether the key works. Never throws, never returns text containing the key. */
export async function checkKey(
  key: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<KeyCheck> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(AUTH_KEY_URL, {
      headers: { authorization: `Bearer ${key.trim()}`, ...OPENROUTER_APP_HEADERS },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err: any) {
    const why = err?.name === "TimeoutError" || err?.name === "AbortError" ? "OpenRouter took too long to answer" : sanitize(err?.message ?? String(err), key);
    return { ok: false, reason: `Could not reach OpenRouter (${why}). Check your connection and try again.` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "OpenRouter did not accept this key. Check it was copied in full." };
  if (!res.ok) return { ok: false, reason: `OpenRouter answered HTTP ${res.status}. Try again in a moment.` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { ok: true, info: parseKeyInfo(body) };
}

const dollars = (n: number) => `$${n.toFixed(2)}`;

/** One line about the key, for the screen after it was checked. */
export function describeKey(info: KeyInfo): string {
  const parts: string[] = [];
  if (info.label) parts.push(info.label);
  if (info.usage !== undefined) parts.push(`${dollars(info.usage)} used`);
  parts.push(info.limit === null ? "no spend limit" : `limit ${dollars(info.limit)}${info.limitRemaining != null ? ` (${dollars(info.limitRemaining)} left)` : ""}`);
  return parts.join(" · ");
}

/** The warning shown when the key can spend without limit. YIMPIM does not cap spend itself. */
export function spendLimitWarning(info: KeyInfo): string | undefined {
  if (info.limit !== null) return undefined;
  return "This key has no spend limit. YIMPIM does not cap what it spends, so set one at openrouter.ai/keys.";
}
