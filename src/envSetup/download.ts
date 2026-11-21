/**
 * Downloading a tool: only from the vendors' own hosts over HTTPS, only extracted after its checksum matches the one the vendor published, and only after the archive's file list has
 * been checked for paths that would escape the destination. `extractVerified` is the single way an archive is opened: there is no path that extracts first and checks later.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { type Runner, ok } from "./exec.js";

/** The only hosts a download may come from (and be redirected to). */
export const ALLOWED_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "dl.google.com",
  "storage.googleapis.com",
]);

export class ChecksumError extends Error {}
export class UnsafeArchiveError extends Error {}

export function assertAllowedUrl(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`refusing a non-HTTPS download: ${url}`);
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new Error(`refusing a download from ${u.hostname}: it is not one of the vendors' hosts`);
  return u;
}

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
const defaultFetcher: Fetcher = (url, init) => fetch(url, { ...init, redirect: "follow" });

async function checked(url: string, fetcher: Fetcher, init?: { headers?: Record<string, string> }): Promise<Response> {
  assertAllowedUrl(url);
  const res = await fetcher(url, { headers: { "user-agent": "yimpim-setup-env", ...(init?.headers ?? {}) } });
  // A redirect may only lead to another of the vendors' hosts.
  if (res.url) assertAllowedUrl(res.url);
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res;
}

export async function fetchText(url: string, fetcher: Fetcher = defaultFetcher): Promise<string> {
  return (await checked(url, fetcher)).text();
}
export async function fetchJson<T = any>(url: string, fetcher: Fetcher = defaultFetcher): Promise<T> {
  return JSON.parse(await fetchText(url, fetcher)) as T;
}

/** Streams a download to a file (an SDK can be over a gigabyte): never held in memory. */
export async function downloadTo(url: string, dest: string, fetcher: Fetcher = defaultFetcher): Promise<void> {
  const res = await checked(url, fetcher);
  if (!res.body) throw new Error(`${url} sent no data`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest, { mode: 0o600 }));
}

// ------------------------------------------------------------------------------------------------------------------------ checksums

/** The algorithm a vendor's published checksum is in, from its length: SHA-256 (64 hex) or SHA-1 (40 hex, what Google publishes for the Android tools). Anything else is refused. */
export function digestAlgorithm(hex: string): "sha256" | "sha1" | undefined {
  if (/^[0-9a-f]{64}$/i.test(hex)) return "sha256";
  if (/^[0-9a-f]{40}$/i.test(hex)) return "sha1";
  return undefined;
}

export function fileDigests(file: string): { sha1: string; sha256: string } {
  const h1 = crypto.createHash("sha1");
  const h2 = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) {
      h1.update(buf.subarray(0, n));
      h2.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha1: h1.digest("hex"), sha256: h2.digest("hex") };
}

export interface Verified {
  algorithm: "sha256" | "sha1";
  digest: string;
  /** Always the SHA-256 of what was downloaded, kept in the machine record whatever the vendor published. */
  sha256: string;
}

/** Throws unless the file's digest equals the vendor's published one. The comparison is made in the algorithm the vendor published. */
export function verifyChecksum(file: string, expectedHex: string): Verified {
  const algorithm = digestAlgorithm(expectedHex.trim());
  if (!algorithm) throw new ChecksumError(`the published checksum is not a SHA-256 or SHA-1 value: ${expectedHex.slice(0, 20)}…`);
  const d = fileDigests(file);
  const got = d[algorithm];
  const want = expectedHex.trim().toLowerCase();
  const a = Buffer.from(got, "hex");
  const b = Buffer.from(want, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ChecksumError(`${path.basename(file)} does not match the checksum its vendor published (${algorithm}): expected ${want}, got ${got}. It was not extracted.`);
  }
  return { algorithm, digest: got, sha256: d.sha256 };
}

/** `sha256sum` format ("<hash>  <file>"), as uv publishes: the hash for that file. */
export function parseSha256Sum(text: string, fileName?: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m && (!fileName || path.basename(m[2]) === fileName)) return m[1].toLowerCase();
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------------------------------ extraction

export type ArchiveKind = "tar.gz" | "tar.xz" | "zip";

/** An archive entry that is absolute, climbs out with "..", or has a drive letter would write outside the destination. */
export function assertSafeEntries(entries: string[]): void {
  for (const raw of entries) {
    const e = raw.replace(/\\/g, "/");
    if (!e || e.startsWith("/") || /^[A-Za-z]:/.test(e) || e.split("/").includes("..") || e.includes("\0")) {
      throw new UnsafeArchiveError(`the archive has an entry that would be written outside its destination: ${JSON.stringify(raw).slice(0, 100)}`);
    }
  }
}

function listCmd(kind: ArchiveKind, archive: string) {
  return kind === "zip" ? { bin: "unzip", args: ["-Z1", archive] } : { bin: "tar", args: [kind === "tar.xz" ? "-tJf" : "-tzf", archive] };
}
function extractCmd(kind: ArchiveKind, archive: string, dest: string) {
  return kind === "zip"
    ? { bin: "unzip", args: ["-q", "-o", archive, "-d", dest] }
    : { bin: "tar", args: [kind === "tar.xz" ? "-xJf" : "-xzf", archive, "-C", dest, "--no-same-owner"] };
}

/**
 * Verify, then list, then extract. If the checksum does not match, or the list holds an unsafe path, nothing is extracted and the error says so. Returns what was verified.
 */
export function extractVerified(run: Runner, archive: string, expectedHex: string, dest: string, kind: ArchiveKind): Verified {
  const verified = verifyChecksum(archive, expectedHex); // throws before any extraction
  const listed = run(listCmd(kind, archive));
  if (!ok(listed)) throw new UnsafeArchiveError(`could not read the archive's file list (${(listed.stderr || listed.error || "").slice(0, 120)})`);
  assertSafeEntries(listed.stdout.split(/\r?\n/).filter(Boolean));
  fs.mkdirSync(dest, { recursive: true });
  const done = run(extractCmd(kind, archive, dest));
  if (!ok(done)) throw new Error(`could not extract ${path.basename(archive)} (${(done.stderr || done.error || "").slice(0, 160)})`);
  return verified;
}
