/**
 * The competitor shelf: who the product sits next to, and what they look like. A model names the likely
 * direct competitors (and any the request names); code reads each public home page for its colours and
 * fonts. A page that cannot be read falls back to the model's recollection, labelled "recalled" and
 * never presented as measured.
 *
 * Only the competitor's own public URL is requested, with no project details, from a generic client.
 * Pages are fetched through a guard that refuses non-web schemes, private or loopback addresses (also
 * after redirects), and anything over a size and time limit.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { hexToOklch } from "./colorlib.js";
import { normalizeColor } from "./svgSafety.js";
import type { Rival } from "./palette.js";

export interface RivalInfo extends Rival {
  url?: string;
  fonts: string[];
}

export type FetchPage = (url: string) => Promise<string | null>;

const MAX_BYTES = 600_000;
const TIMEOUT_MS = 7000;

const privateAddress = (ip: string): boolean => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
};

export async function safeToFetch(raw: string): Promise<URL | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (net.isIP(host)) return privateAddress(host) ? null : u;
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length === 0 || addrs.some((a) => privateAddress(a.address))) return null;
  } catch {
    return null;
  }
  return u;
}

/** The default reader: guarded, bounded, follows at most 3 redirects and re-checks each hop. */
export const readPublicPage: FetchPage = async (raw) => {
  let url = await safeToFetch(raw);
  for (let hop = 0; url && hop < 4; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { redirect: "manual", signal: ctl.signal, headers: { "user-agent": "brand-research-reader/1.0", accept: "text/html,text/css" } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        url = loc ? await safeToFetch(new URL(loc, url).toString()) : null;
        continue;
      }
      if (!res.ok || !res.body) return null;
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let n = 0;
      while (n < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        n += value.length;
      }
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
      return Buffer.concat(chunks).toString("utf-8").slice(0, MAX_BYTES);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
};

const GENERIC_FONTS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "inherit", "initial", "unset", "-apple-system", "blinkmacsystemfont", "segoe ui", "roboto", "helvetica", "helvetica neue", "arial", "emoji", "apple color emoji", "noto color emoji"]);

/** The page's brand colour: a theme-color meta if chromatic, else the most used chromatic hex in its styles. */
export function pageColours(html: string): { primary: string | null; fonts: string[] } {
  const theme = /<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["']/i.exec(html);
  const themeHex = theme ? normalizeColor(theme[1]) : null;
  if (themeHex && hexToOklch(themeHex).c >= 0.06) return { primary: themeHex, fonts: pageFonts(html) };
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const hex = normalizeColor("#" + m[1]);
    if (!hex) continue;
    const c = hexToOklch(hex);
    if (c.c < 0.07 || c.l < 0.2 || c.l > 0.92) continue;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { primary: top && top[1] >= 2 ? top[0] : null, fonts: pageFonts(html) };
}

function pageFonts(text: string): string[] {
  const seen = new Map<string, number>();
  for (const m of text.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    const first = m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).find((s) => s && !GENERIC_FONTS.has(s.toLowerCase()) && !/^var\(/i.test(s));
    if (first && first.length < 40) seen.set(first, (seen.get(first) ?? 0) + 1);
  }
  for (const m of text.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&:]+)/gi)) {
    const f = decodeURIComponent(m[1]).replace(/\+/g, " ");
    seen.set(f, (seen.get(f) ?? 0) + 2);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
}

export const RIVAL_SYSTEM =
  "Name the 3 to 5 most likely DIRECT competitors of this product, real and well known, plus any the request names. " +
  "For each give its public website address (https) and, if you remember it, its main brand colour as a hex (say null if unsure; never guess a hex you do not recall). " +
  'Respond ONLY with JSON: {"rivals": [{"name": string, "url": "https://...", "hex": "#rrggbb"|null}]}';

export async function readRivals(
  propose: () => Promise<any>,
  fetchPage: FetchPage,
  log: (line: string) => void
): Promise<RivalInfo[]> {
  let j: any;
  try {
    j = await propose();
  } catch {
    return [];
  }
  const out: RivalInfo[] = [];
  const list: any[] = (Array.isArray(j?.rivals) ? j.rivals : []).slice(0, 6);
  const results = await Promise.allSettled(
    list.map(async (r) => {
      const name = String(r?.name ?? "").trim().slice(0, 40);
      if (!name) return null;
      const recalled = typeof r?.hex === "string" ? normalizeColor(r.hex) : null;
      let url: string | undefined = typeof r?.url === "string" ? r.url.slice(0, 200) : undefined;
      let measured: { primary: string | null; fonts: string[] } | null = null;
      if (url) {
        const html = await fetchPage(url);
        if (html) measured = pageColours(html);
        else url = undefined;
      }
      if (measured?.primary) return { name, hex: measured.primary, source: "measured" as const, url, fonts: measured.fonts };
      if (recalled) return { name, hex: recalled, source: "recalled" as const, url, fonts: measured?.fonts ?? [] };
      return null;
    })
  );
  for (const r of results) if (r.status === "fulfilled" && r.value) out.push(r.value);
  log(`[DESIGN] Competitors: ${out.map((r) => `${r.name} ${r.hex} (${r.source})`).join(", ") || "none could be read"}`);
  return out;
}
