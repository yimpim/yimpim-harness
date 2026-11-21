/**
 * Things that keep the "what is already built?" check from paying for the same answer twice:
 *  - a finished roadmap whose code has not changed since its last unit answers "what is left?" from its own record, with no model call;
 *  - a result is remembered for the same question and the same code (the same commit and the same uncommitted changes);
 *  - the calls it did make are counted per pass, so it is visible where the tokens go.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { loadRoadmap, progress as roadmapProgress } from "./roadmap.js";
import type { ExistenceResult } from "./existence.js";

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return "";
  }
}

/** Paths whose change says nothing about whether the roadmap's work is still in place: the harness's own state and prose. */
const NOT_WORK = /^(\.agent\/|.*\.md$)/i;

/**
 * For a roadmap that is finished (every unit done, each with the commit that did it) and whose code has not changed since its last unit: the answer to
 * "what is left?", from the record. Undefined when it cannot be said for certain, and the check then runs as usual.
 */
export function roadmapCompleteAnswer(repoRoot: string): { text: string } | undefined {
  const rm: any = loadRoadmap(repoRoot);
  if (!rm) return undefined;
  const progress = roadmapProgress(rm);
  if (progress.total === 0 || progress.done !== progress.total) return undefined;
  const units: any[] = rm.units ?? [];
  const done = units.filter((u) => u?.status === "done");
  const last = [...done].reverse().find((u) => typeof u?.done?.commit === "string" && u.done.commit);
  if (!last) return undefined;
  const commit: string = last.done.commit;
  if (!git(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`])) return undefined;
  const changed = [...git(repoRoot, ["diff", "--name-only", commit, "HEAD"]).split(/\r?\n/), ...git(repoRoot, ["diff", "--name-only", "HEAD"]).split(/\r?\n/)]
    .map((l) => l.trim().replace(/\\/g, "/"))
    .filter(Boolean)
    .filter((p) => !NOT_WORK.test(p));
  if (changed.length > 0) return undefined;
  const lines = done.map((u) => `  ✓ ${u.id} ${String(u.title ?? "").slice(0, 80)}${u.done?.commit ? ` (commit ${String(u.done.commit).slice(0, 7)}, ${u.done.files?.length ?? 0} file(s))` : ""}`);
  return {
    text:
      `The roadmap is complete: ${progress.done}/${progress.total} units are done, each built, tested and checked by QA when it ran, and nothing in the code has changed since the last one ` +
      `(${commit.slice(0, 7)}). Nothing is left to do.\n${lines.join("\n")}\n` +
      `(This is from the roadmap's own record, so no model was asked. To check the brief's requirements against the code anyway, name the document, for example "check reference/<brief> against the code".)`,
  };
}

// ------------------------------------------------------------------------------------------------------------------------ cache

const CACHE_FILE = (repoRoot: string) => path.join(repoRoot, ".agent", "existence-cache.json");
const KEEP = 5;

/** The same question about the same code: the question, the document, the commit, and the uncommitted changes (their content, and the new files' names). */
export function cacheKey(repoRoot: string, request: string, docs: string | undefined): string | undefined {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  if (!head) return undefined;
  const diff = git(repoRoot, ["diff", "HEAD", "--", ".", ":(exclude).agent"]);
  const fresh = git(repoRoot, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter((p) => p && !p.startsWith(".agent/")).sort().join("\n");
  return crypto.createHash("sha256").update(JSON.stringify([request, docs ?? "", head, diff, fresh])).digest("hex");
}

export function readCache(repoRoot: string, key: string | undefined): ExistenceResult | undefined {
  if (!key) return undefined;
  try {
    const rows: { key: string; result: ExistenceResult }[] = JSON.parse(fs.readFileSync(CACHE_FILE(repoRoot), "utf8"));
    const hit = rows.find((r) => r.key === key);
    return hit && hit.result?.applies ? hit.result : undefined;
  } catch {
    return undefined;
  }
}

export function writeCache(repoRoot: string, key: string | undefined, result: ExistenceResult): void {
  if (!key || !result.applies) return;
  try {
    let rows: { key: string; result: ExistenceResult }[] = [];
    try {
      rows = JSON.parse(fs.readFileSync(CACHE_FILE(repoRoot), "utf8"));
    } catch {
      rows = [];
    }
    rows = [{ key, result }, ...rows.filter((r) => r.key !== key)].slice(0, KEEP);
    fs.mkdirSync(path.dirname(CACHE_FILE(repoRoot)), { recursive: true });
    fs.writeFileSync(CACHE_FILE(repoRoot), JSON.stringify(rows));
  } catch {
    // a cache is a help, never a reason to fail
  }
}

// ------------------------------------------------------------------------------------------------------------------------ the tally

export interface PassTally {
  /** pass label -> tier -> calls and approximate tokens (a quarter of the characters sent and received). */
  rows: Map<string, { calls: number; tokens: number }>;
}

export function newTally(): PassTally {
  return { rows: new Map() };
}

export function countCall(t: PassTally, label: string, tier: "cheap" | "strong", sent: string, received: string): void {
  const k = `${tier} ${label}`;
  const row = t.rows.get(k) ?? { calls: 0, tokens: 0 };
  row.calls++;
  row.tokens += Math.ceil((sent.length + received.length) / 4);
  t.rows.set(k, row);
}

export function renderTally(t: PassTally): string {
  if (t.rows.size === 0) return "";
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  return `[EXISTS] Calls: ${[...t.rows.entries()].map(([k, v]) => `${k} ${v.calls} (~${fmt(v.tokens)} tokens)`).join(" · ")}`;
}
