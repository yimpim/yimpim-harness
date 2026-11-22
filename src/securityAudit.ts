/**
 * /pentest, stage 1: a security audit of the whole project as it stands. Read-only: it reads files and git history
 * on this machine and attacks nothing. (Live testing of a running app is a separate, gated stage.)
 *
 *   1. every file against the pattern checks (not just a diff), with line numbers;
 *   2. git history for secrets that were committed once, even if deleted since (they are still leaked);
 *   3. installed packages against the public OSV vulnerability database (names and versions only are sent);
 *   4. an application-level threat model, then an attacker-style review of the riskiest files (find, refute, keep
 *      what survives at high confidence, search for the same flaw elsewhere);
 *   5. a report: what was found, how it would be exploited, how to fix it, and what was NOT covered.
 *
 * Nothing that looks like a credential is ever written to the report or sent to a model.
 */
import { SECURITY_NOTICE_SHORT, SECURITY_NOTICE_FULL } from "./disclaimer.js";
import { lazyIgnore } from "./projectPaths.js";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";
import { THREAT_SYSTEM, parseThreatModel, type TaskSecurity } from "./securityPlan.js";
import { detectSecurityStack, packById, type SecurityStack } from "./securityStack.js";
import { auditText, isSkippedPath, lineHits, type AuditHit } from "./securityLint.js";
import { blastRadius, classifyFile, renderFinding, securityReview, type Finding, type Risk } from "./securityReview.js";
import type { ChangeSet } from "./staticQa.js";

const execFileAsync = promisify(execFile);

export type Ask = (system: string, user: string) => Promise<string>;
export type Call = (messages: { role: "system" | "user"; content: string }[], label: string, json: boolean) => Promise<string>;

// The shared ignore list (projectPaths.ts) plus the folder the audit writes its own report into.
const SKIP_DIRS = lazyIgnore(["security"]);
const TEXT = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|rb|php|java|kt|kts|swift|m|mm|go|rs|cs|dart|scala|sh|bash|ps1|html?|erb|ejs|hbs|twig|xml|plist|gradle|ya?ml|json|toml|tf|tfvars|bicep|sql|rules|conf|ini|env|properties|cfg|dockerfile)$/i;
const NAMED = /(^|\/)(Dockerfile[^/]*|Jenkinsfile|Procfile|Caddyfile|\.env(\.[a-z0-9_-]+)?|\.npmrc|\.pypirc)$/i;

export interface FileText {
  rel: string;
  text: string;
}

/** The project's text files, bounded in count and size. */
export function collectFiles(root: string, maxFiles = 4000, maxBytes = 300_000): FileText[] {
  const out: FileText[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 10 || out.length >= maxFiles) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) && !(e.name === "security" && depth > 0)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (e.isDirectory()) walk(full, depth + 1);
      else if (TEXT.test(e.name) || NAMED.test(rel)) {
        try {
          const st = fs.statSync(full);
          if (st.size > maxBytes || st.size === 0) continue;
          out.push({ rel, text: fs.readFileSync(full, "utf-8") });
        } catch {
          // unreadable: skipped
        }
      }
      if (out.length >= maxFiles) return;
    }
  };
  walk(root, 0);
  return out;
}

// ---------------------------------------------------------------------------
// 2. git history
// ---------------------------------------------------------------------------

export interface HistoryHit {
  commit: string;
  file: string;
  id: string;
  message: string;
  /** Still in the current code? Then it is a live finding too; if not, it only needs rotating. */
  inCurrent: boolean;
}

export interface HistoryResult {
  hits: HistoryHit[];
  trackedSensitive: string[];
  commitsScanned: number;
  note: string;
}

export type Git = (args: string[]) => Promise<string>;

/** Streams a git command's output line by line (history can be tens of megabytes). Returns true if it stopped early at a limit. */
export type GitLines = (args: string[], onLine: (line: string) => void) => Promise<boolean>;

export const gitLinesIn = (root: string, maxBytes = 400 * 1024 * 1024, maxMs = 90_000): GitLines => (args, onLine) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let bytes = 0;
    let early = false;
    const stop = () => {
      early = true;
      child.kill();
    };
    const timer = setTimeout(stop, maxMs);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (l) => {
      bytes += l.length + 1;
      if (bytes > maxBytes) return stop();
      onLine(l);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !early) reject(new Error("git exited with " + code));
      else resolve(early);
    });
  });

export const gitIn = (root: string): Git => async (args) => (await execFileAsync("git", args, { cwd: root, maxBuffer: 48 * 1024 * 1024, windowsHide: true })).stdout;

const SENSITIVE_FILE = /(^|\/)(\.env(\.[a-z0-9_-]+)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|p12|pfx|jks|keystore)|serviceAccount[^/]*\.json|[^/]*service[-_]account[^/]*\.json|credentials\.json|\.pypirc|\.netrc)$/i;
const SENSITIVE_OK = /\.(example|sample|template|dist)$|(^|\/)\.env\.(example|sample|template)$/i;

/** Secrets that were committed at some point. Values are never kept: only commit, file and kind. */
export async function scanHistory(root: string, git: Git = gitIn(root), currentIds: Map<string, Set<string>> = new Map(), maxCommits = 500, gitLines?: GitLines): Promise<HistoryResult> {
  let tracked: string[] = [];
  try {
    tracked = (await git(["ls-files"])).split(/\r?\n/).filter((f) => f && SENSITIVE_FILE.test(f) && !SENSITIVE_OK.test(f));
  } catch {
    return { hits: [], trackedSensitive: [], commitsScanned: 0, note: "This folder is not a git repository (or git is not available), so history was not checked." };
  }
  const hits: HistoryHit[] = [];
  const seen = new Set<string>();
  let commit = "";
  let file = "";
  let commits = 0;
  const onLine = (l: string) => {
    if (l.startsWith("@@@")) {
      commit = l.slice(3).trim();
      commits++;
      return;
    }
    if (l.startsWith("+++ b/")) {
      file = l.slice(6).trim();
      return;
    }
    if (!l.startsWith("+") || l.startsWith("+++") || !file) return;
    if (isSkippedPath(file)) return;
    if (/\.(lock|min\.js|map|svg|png|jpg|snap)$/i.test(file) || /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.sum|composer\.lock)$/.test(file) || /(^|\/)(node_modules|dist|build)\//.test(file)) return;
    for (const h of lineHits(file, l.slice(1))) {
      if (!h.id.startsWith("secret-") || h.id === "secret-in-log" || h.id === "secret-generic") continue;
      const key = `${file}|${h.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ commit, file, id: h.id, message: h.message, inCurrent: currentIds.get(file)?.has(h.id) ?? false });
    }
  };
  const args = ["log", "--all", "--no-color", "-p", "-U0", "--diff-filter=AM", `--max-count=${maxCommits}`, "--format=@@@%h"];
  let stoppedEarly = false;
  try {
    stoppedEarly = await (gitLines ?? (async (a: string[], cb: (l: string) => void) => {
      for (const l of (await git(a)).split("\n")) cb(l);
      return false;
    }))(args, onLine);
  } catch (err: any) {
    return { hits: [], trackedSensitive: tracked, commitsScanned: 0, note: `History could not be read (${String(err?.message ?? err).slice(0, 80)}).` };
  }
  return {
    hits,
    trackedSensitive: tracked,
    commitsScanned: commits,
    note: stoppedEarly ? `The history scan stopped at its size or time limit after ${commits} commits; older history was not scanned.` : commits >= maxCommits ? `Only the most recent ${maxCommits} commits were scanned; older history was not.` : "",
  };
}

// ---------------------------------------------------------------------------
// 3. dependencies
// ---------------------------------------------------------------------------

export interface Dep {
  ecosystem: "npm" | "PyPI" | "crates.io" | "Packagist" | "RubyGems" | "Go" | "Pub";
  name: string;
  version: string;
}

function tomlPackages(text: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  for (const m of text.matchAll(/\[\[package\]\]\s*\n(?:[^\n\[]*\n)*?name\s*=\s*"([^"]+)"\s*\n(?:[^\n\[]*\n)*?version\s*=\s*"([^"]+)"/g)) out.push({ name: m[1], version: m[2] });
  return out;
}

/** Locked package versions from the lockfiles present. The same package at two versions is checked at both. */
export function readLockedDeps(root: string, files = collectLocks(root)): Dep[] {
  const out = new Map<string, Dep>();
  const add = (ecosystem: Dep["ecosystem"], name: string, version: string) => {
    if (!name || !/^[\w.+~!-]+$/.test(version.replace(/^v/, "")) || version.length > 40) return;
    out.set(`${ecosystem}|${name}|${version}`, { ecosystem, name, version: version.replace(/^v/, "") });
  };
  for (const { rel, text } of files) {
    const base = path.basename(rel);
    try {
      if (base === "package-lock.json") {
        const j = JSON.parse(text);
        for (const [k, v] of Object.entries<any>(j.packages ?? {})) {
          const m = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(k);
          if (m && v?.version) add("npm", m[1], v.version);
        }
        const walk = (deps: any) => {
          for (const [n, v] of Object.entries<any>(deps ?? {})) {
            if (v?.version) add("npm", n, v.version);
            walk(v?.dependencies);
          }
        };
        if (!j.packages) walk(j.dependencies);
      } else if (base === "yarn.lock") {
        for (const m of text.matchAll(/^"?((?:@[^@\s"\/]+\/)?[^@\s"\/]+)@[^\n]*:\n\s+version:?\s+"?([^"\n\s]+)"?/gm)) add("npm", m[1], m[2]);
      } else if (base === "pnpm-lock.yaml") {
        for (const m of text.matchAll(/^\s{2,6}'?\/?((?:@[^@\s'\/]+\/)?[^@\s'\/]+)@(\d[^\s:'(]*)\)?'?:/gm)) add("npm", m[1], m[2]);
      } else if (base === "poetry.lock") {
        for (const p of tomlPackages(text)) add("PyPI", p.name, p.version);
      } else if (base === "Cargo.lock") {
        for (const p of tomlPackages(text)) add("crates.io", p.name, p.version);
      } else if (base === "Pipfile.lock") {
        const j = JSON.parse(text);
        for (const sect of [j.default, j.develop]) for (const [n, v] of Object.entries<any>(sect ?? {})) if (typeof v?.version === "string") add("PyPI", n, v.version.replace(/^==/, ""));
      } else if (/^requirements.*\.txt$/.test(base)) {
        for (const m of text.matchAll(/^\s*([A-Za-z0-9_.\-]+)==([A-Za-z0-9_.\-+!]+)/gm)) add("PyPI", m[1], m[2]);
      } else if (base === "composer.lock") {
        const j = JSON.parse(text);
        for (const p of [...(j.packages ?? []), ...(j["packages-dev"] ?? [])]) if (p?.name && p?.version) add("Packagist", p.name, String(p.version).replace(/^v/, ""));
      } else if (base === "Gemfile.lock") {
        for (const m of text.matchAll(/^ {4}([A-Za-z0-9_.\-]+) \(([0-9][^)\s]*)\)/gm)) add("RubyGems", m[1], m[2]);
      } else if (base === "go.sum") {
        for (const m of text.matchAll(/^(\S+) v([0-9][^\s/]*)\/go\.mod /gm)) add("Go", m[1], "v" + m[2]);
      } else if (base === "pubspec.lock") {
        for (const m of text.matchAll(/^ {2}([a-z0-9_]+):\n(?: {4}[^\n]*\n)*? {4}version: "([^"]+)"/gm)) add("Pub", m[1], m[2]);
      }
    } catch {
      // a damaged lockfile contributes nothing
    }
  }
  return [...out.values()];
}

const LOCKS = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|Pipfile\.lock|requirements[^/]*\.txt|composer\.lock|Gemfile\.lock|go\.sum|pubspec\.lock)$/;

/** Lockfiles are large and are skipped by the normal walk, so they are found on their own. */
export function collectLocks(root: string): FileText[] {
  const out: FileText[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5 || out.length >= 12) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (e.isDirectory()) walk(full, depth + 1);
      else if (LOCKS.test(rel)) {
        try {
          if (fs.statSync(full).size <= 12_000_000) out.push({ rel, text: fs.readFileSync(full, "utf-8") });
        } catch {
          // skip
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

export interface Vuln {
  id: string;
  package: string;
  version: string;
  ecosystem: string;
  severity: "critical" | "high" | "moderate" | "low" | "unknown";
  summary: string;
  fixed: string;
}

export type FetchJson = (url: string, body?: unknown) => Promise<any>;

/** The only external reader for packages: one host, bounded size and time. Names and versions are all that is sent. */
export const osvFetch: FetchJson = async (url, body) => {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hostname !== "api.osv.dev") throw new Error("only api.osv.dev is queried");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(u, { method: body ? "POST" : "GET", signal: ctl.signal, redirect: "error", headers: { "content-type": "application/json", "user-agent": "dependency-audit/1.0" }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`OSV answered ${res.status}`);
    const text = await res.text();
    if (text.length > 4_000_000) throw new Error("OSV answer too large");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
};

const SEV: Record<string, Vuln["severity"]> = { CRITICAL: "critical", HIGH: "high", MODERATE: "moderate", MEDIUM: "moderate", LOW: "low" };

export async function lookupVulns(deps: Dep[], fetchJson: FetchJson = osvFetch, maxDeps = 1500): Promise<{ vulns: Vuln[]; checked: number; note: string }> {
  const list = deps.slice(0, maxDeps);
  if (list.length === 0) return { vulns: [], checked: 0, note: "No lockfile was found, so installed package versions could not be checked." };
  const ids = new Map<string, Dep[]>();
  try {
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const res = await fetchJson("https://api.osv.dev/v1/querybatch", { queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) });
      (res?.results ?? []).forEach((r: any, k: number) => {
        for (const v of r?.vulns ?? []) if (v?.id) ids.set(v.id, [...(ids.get(v.id) ?? []), chunk[k]]);
      });
    }
  } catch (err: any) {
    return { vulns: [], checked: 0, note: `The vulnerability database could not be reached (${String(err?.message ?? err).slice(0, 80)}); packages were not checked.` };
  }
  const vulns: Vuln[] = [];
  const unique = [...ids.keys()].slice(0, 60);
  await Promise.all(
    unique.map(async (id) => {
      let d: any = null;
      try {
        d = await fetchJson(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`);
      } catch {
        d = null;
      }
      const sev = SEV[String(d?.database_specific?.severity ?? "").toUpperCase()] ?? "unknown";
      const fixed = (d?.affected ?? []).flatMap((a: any) => (a?.ranges ?? []).flatMap((r: any) => (r?.events ?? []).map((e: any) => e?.fixed).filter(Boolean)))[0] ?? "";
      for (const dep of ids.get(id) ?? []) vulns.push({ id, package: dep.name, version: dep.version, ecosystem: dep.ecosystem, severity: sev, summary: String(d?.summary ?? "").slice(0, 160), fixed: String(fixed).slice(0, 40) });
    })
  );
  const order = { critical: 0, high: 1, moderate: 2, low: 3, unknown: 4 };
  vulns.sort((a, b) => order[a.severity] - order[b.severity]);
  return { vulns, checked: list.length, note: ids.size > unique.length ? `Only the first ${unique.length} advisories were detailed.` : "" };
}

// ---------------------------------------------------------------------------
// 4. the application-level review
// ---------------------------------------------------------------------------

export const AUDIT_THREAT_SYSTEM = THREAT_SYSTEM.replace(
  "You are a security architect. You think like an attacker BEFORE code is written. Read the request and decide whether it touches something an attacker would want:",
  "You are a security architect auditing an EXISTING application. Think like an attacker. From the project's stack and its file layout, work out what the application does and what an attacker would want:"
).replace("answer sensitive=false with empty lists. ", "still list what you can infer. ").replace("Requirements must be specific and testable", "Requirements are what a correct implementation must do here, and must be specific and testable");

export interface Hotspot {
  file: string;
  risk: Risk;
  callers: number;
}

/** The files most worth an attacker's attention: risky by name and content, and depended on by many others. */
export function pickHotspots(files: FileText[], root: string, hits: AuditHit[], max = 10): Hotspot[] {
  const hitFiles = new Set(hits.filter((h) => h.severity === "defect").map((h) => h.file));
  const scored = files
    .filter((f) => /\.(js|jsx|ts|tsx|mjs|py|rb|php|java|kt|swift|go|rs|cs|dart|sql|rules|tf|ya?ml)$/i.test(f.rel))
    .map((f) => ({ f, risk: classifyFile(f.rel, f.text.slice(0, 6000)) }))
    .filter((x) => x.risk !== "low")
    .map((x) => ({ ...x, score: (x.risk === "high" ? 10 : 4) + (hitFiles.has(x.f.rel) ? 5 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max * 2);
  const paths = files.map((f) => path.join(root, f.rel));
  return scored
    .map((x) => ({ file: x.f.rel, risk: x.risk, callers: blastRadius(root, x.f.rel, paths).callers, score: x.score }))
    .sort((a, b) => b.score + Math.min(a.callers, 30) / 3 - (a.score + Math.min(b.callers, 30) / 3))
    .slice(0, max)
    .map(({ file, risk, callers }) => ({ file, risk, callers }));
}

/** The hotspots as a change set (each file as if newly added), so the same reviewer can read them. */
export function hotspotChange(files: FileText[], spots: Hotspot[]): ChangeSet {
  const byRel = new Map(files.map((f) => [f.rel, f.text]));
  const diff = spots
    .map((s) => {
      const body = (byRel.get(s.file) ?? "").split(/\r?\n/).slice(0, 400).map((l) => "+" + l).join("\n");
      return `diff --git a/${s.file} b/${s.file}\n--- /dev/null\n+++ b/${s.file}\n@@ new file @@\n${body}`;
    })
    .join("\n");
  return { diff, modified: [], added: spots.map((s) => s.file), deleted: [], renamed: [], isEmpty: spots.length === 0 };
}

// ---------------------------------------------------------------------------
// the audit
// ---------------------------------------------------------------------------

export interface AuditDeps {
  repoRoot: string;
  call: Call;
  /** false skips the vulnerability-database lookup (nothing is then sent anywhere but the model). */
  dependencyLookup?: boolean;
  git?: Git;
  fetchJson?: FetchJson;
  log: (line: string) => void;
}

export interface AuditResult {
  ok: boolean;
  text: string;
  report?: string;
  counts: { defects: number; concerns: number; confirmed: number; history: number; vulnerable: number };
}

export interface Audit {
  name: string;
  date: string;
  stack: SecurityStack;
  filesScanned: number;
  hits: AuditHit[];
  history: HistoryResult;
  deps: { checked: number; vulns: Vuln[]; note: string };
  model: TaskSecurity | null;
  hotspots: Hotspot[];
  findings: Finding[];
  reviewNote: string;
}

const sevOrder = (h: AuditHit) => (h.severity === "defect" ? 0 : 1);

export function renderAudit(a: Audit): string {
  const defects = a.hits.filter((h) => h.severity === "defect");
  const concerns = a.hits.filter((h) => h.severity === "concern");
  const byId = (list: AuditHit[]) => {
    const m = new Map<string, AuditHit[]>();
    for (const h of list) m.set(h.id, [...(m.get(h.id) ?? []), h]);
    return [...m.entries()].sort((x, y) => y[1].length - x[1].length);
  };
  const place = (h: AuditHit) => `${h.file}:${h.line}${h.sample ? `  \`${h.sample.replace(/`/g, "'")}\`` : ""}`;
  const group = (list: AuditHit[]) =>
    byId(list)
      .map(([id, hs]) => `- **${id}** (${hs.length}): ${hs[0].message}\n${hs.slice(0, 6).map((h) => `  - ${place(h)}`).join("\n")}${hs.length > 6 ? `\n  - ... and ${hs.length - 6} more` : ""}`)
      .join("\n");
  const hist = a.history.hits;
  const checklist = a.stack.packs
    .map((id) => packById(id))
    .filter(Boolean)
    .map((p) => `### ${p!.name}\n${p!.hardening.map((h) => `- [ ] ${h}`).join("\n")}`)
    .join("\n\n");
  return (
    `# Security audit: ${a.name}\n\nDate: ${a.date}. Stage 1 of /pentest: a read-only audit of the code, its git history and its packages. Nothing was attacked and no running app was contacted.\n\n` +
    `## Summary\n- ${a.findings.length} attack path(s) confirmed by the attacker-style review (${a.findings.filter((f) => f.severity === "high").length} high, ${a.findings.filter((f) => f.severity === "medium").length} medium)\n` +
    `- ${defects.length} pattern defect(s) and ${concerns.length} concern(s) across ${a.filesScanned} files\n- ${hist.length} secret(s) found in git history${hist.length ? ` (${hist.filter((h) => !h.inCurrent).length} no longer in the current code)` : ""}; ${a.history.trackedSensitive.length} sensitive file(s) tracked by git\n` +
    `- ${a.deps.vulns.length} vulnerable package version(s) among ${a.deps.checked} checked\n- Stack: ${a.stack.packs.join(", ") || "not recognised"}\n\n` +
    `## Confirmed attack paths\n${a.findings.length ? a.findings.map((f, i) => `### ${i + 1}. ${renderFinding(f).split("\n")[0]}\n${renderFinding(f).split("\n").slice(1).join("\n")}\nWhy it was kept: ${f.verdict}`).join("\n\n") : `None found by the review${a.reviewNote ? ` (${a.reviewNote})` : ""}. The review reads the ${a.hotspots.length} riskiest files, not every file.`}\n\n` +
    `## Secrets\n${hist.length || a.history.trackedSensitive.length ? [...hist.map((h) => `- **${h.id}** in \`${h.file}\` (commit ${h.commit})${h.inCurrent ? " and still in the current code" : ": removed since, but still in git history"}. ${h.inCurrent ? "Remove it and rotate it." : "Rotate it: anything that was ever committed must be treated as leaked."}`), ...a.history.trackedSensitive.map((f) => `- \`${f}\` is tracked by git. Untrack it, add it to .gitignore, and rotate what it holds.`)].join("\n") : "- No secrets found in history or tracked files."}${a.history.note ? `\n- ${a.history.note}` : ""}\n\n` +
    `## Vulnerable packages\n${a.deps.vulns.length ? a.deps.vulns.slice(0, 40).map((v) => `- [${v.severity}] ${v.package}@${v.version} (${v.ecosystem}) ${v.id}: ${v.summary || "see the advisory"}${v.fixed ? `; fixed in ${v.fixed}` : ""}`).join("\n") : "- None known for the versions checked."}\n${a.deps.note ? `- ${a.deps.note}\n` : ""}Only package names and versions were sent to the public OSV database (api.osv.dev). Whether a vulnerable function is reachable from this app was not determined.\n\n` +
    `## Pattern findings: defects\n${defects.length ? group(defects) : "- None."}\n\n## Pattern findings: concerns (review each; many are fine)\n${concerns.length ? group(concerns) : "- None."}\n\n` +
    `## What the application does (inferred, reasoned not measured)\n${a.model?.risky || a.model?.requirements.length ? `Assets: ${a.model.assets.join("; ") || "n/a"}\nEntry points: ${a.model.entryPoints.join("; ") || "n/a"}\nRequirements a correct implementation must meet:\n${a.model.requirements.map((r) => `- [ ] ${r}`).join("\n")}` : "No application-level model could be made."}\n\n` +
    `## Hardening checklist (not verified by this audit: confirm each by hand)\n${checklist || "- (no stack recognised)"}\n\n` +
    `## What this audit did not cover\n- Live behaviour of a running app: authentication and authorisation as seen from outside, headers, cookies, exposed files, rate limits. (Stage 2, not enabled.)\n- Business-logic flaws that need real accounts and real data to see.\n- Code outside the ${a.hotspots.length} files the review read in full, beyond the pattern checks; history beyond ${a.history.commitsScanned} commits.\n- Vendor-side configuration that lives in a dashboard, not in the repository (database policies set in a console, bucket permissions, API key restrictions).\n- Whether a vulnerable package function is reachable.\n\nThis is an automated assessment. It is not a certified penetration test, and a clean result does not mean the app is secure. For anything holding money, health or identity data, have an independent tester assess it.\n`
  );
}

/** Runs the audit; never throws. */
export async function runSecurityAudit(deps: AuditDeps): Promise<AuditResult> {
  const root = path.resolve(deps.repoRoot);
  const log = deps.log;
  const zero = { defects: 0, concerns: 0, confirmed: 0, history: 0, vulnerable: 0 };
  let files: FileText[];
  try {
    files = collectFiles(root);
  } catch (err: any) {
    return { ok: false, text: `The project could not be read: ${String(err?.message ?? err).slice(0, 100)}`, counts: zero };
  }
  if (files.length === 0) return { ok: false, text: "There are no source files here to audit.", counts: zero };
  log(`[PENTEST] Auditing ${files.length} file(s) in ${path.basename(root)}. Read-only: nothing is attacked and no running app is contacted.`);

  const stack = detectSecurityStack(root);
  let hits: AuditHit[] = [];
  const currentIds = new Map<string, Set<string>>();
  for (const f of files) {
    for (const h of auditText(f.rel, f.text)) {
      hits.push(h);
      if (h.id.startsWith("secret-")) currentIds.set(f.rel, (currentIds.get(f.rel) ?? new Set()).add(h.id));
    }
  }
  hits.sort((a, b) => sevOrder(a) - sevOrder(b));
  log(`[PENTEST] Pattern checks: ${hits.filter((h) => h.severity === "defect").length} defect(s), ${hits.filter((h) => h.severity === "concern").length} concern(s).`);

  const history = await scanHistory(root, deps.git ?? gitIn(root), currentIds, 500, deps.git ? undefined : gitLinesIn(root));
  // A local .env that git does not track is normal configuration, not a finding; a tracked one is.
  if (!/not a git repository/.test(history.note)) {
    const tracked = new Set(history.trackedSensitive);
    hits = hits.filter((h) => !(/(^|\/)\.env(\.[a-z0-9_-]+)?$/i.test(h.file) && !tracked.has(h.file)));
  }
  log(`[PENTEST] Git history: ${history.hits.length} secret(s) over ${history.commitsScanned} commit(s); ${history.trackedSensitive.length} sensitive file(s) tracked.`);

  let depResult = { vulns: [] as Vuln[], checked: 0, note: "The vulnerability lookup is turned off (security.dependencyLookup)." };
  if (deps.dependencyLookup !== false) {
    const locked = readLockedDeps(root);
    depResult = await lookupVulns(locked, deps.fetchJson ?? osvFetch);
    log(`[PENTEST] Packages: ${depResult.vulns.length} known vulnerable version(s) among ${depResult.checked} checked.`);
  }

  // The application-level review.
  const ask: Ask = (system, user) => deps.call([{ role: "system", content: system }, { role: "user", content: user }], "pentest review", true);
  let model: TaskSecurity | null = null;
  try {
    const layout = files.map((f) => f.rel).filter((r) => !/\.(json|lock)$/.test(r)).slice(0, 220).join("\n");
    model = parseThreatModel(await ask(AUDIT_THREAT_SYSTEM, `The project is built on: ${stack.packs.map((p) => `${p} (${(stack.evidence[p] ?? []).slice(0, 2).join(", ")})`).join("; ") || "nothing recognised"}.\n\nFile layout:\n${layout}`));
  } catch {
    model = null;
  }
  const spots = pickHotspots(files, root, hits);
  let findings: Finding[] = [];
  let reviewNote = "";
  if (spots.length === 0) reviewNote = "no risky files were identified";
  else {
    log(`[PENTEST] Attacker-style review of ${spots.length} risky file(s)...`);
    try {
      const r = await securityReview({ goal: `A security audit of the whole application ${path.basename(root)}.`, change: hotspotChange(files, spots), repoRoot: root, ask, task: model, leads: hits.filter((h) => h.severity === "defect").slice(0, 8).map((h) => `[${h.id}] ${h.message} (${h.file}:${h.line})`), audit: true });
      if (r) {
        findings = r.findings;
        reviewNote = r.ran ? (r.dropped ? `${r.dropped} candidate(s) did not survive the refuting pass` : "") : r.notes.join(" ");
      }
    } catch (err: any) {
      reviewNote = `the review could not run (${String(err?.message ?? err).slice(0, 80)})`;
    }
  }

  const audit: Audit = { name: path.basename(root), date: new Date().toISOString().slice(0, 10), stack, filesScanned: files.length, hits, history, deps: depResult, model, hotspots: spots, findings, reviewNote };
  const md = renderAudit(audit);
  let report: string | undefined;
  try {
    const dir = path.join(root, "security", "audits");
    fs.mkdirSync(dir, { recursive: true });
    // An audit is a map of the weak points: it stays out of version control unless a person decides otherwise.
    const gi = path.join(dir, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "# Audit reports list the weak points of the application. Not committed by default (this file ignores itself too).\n*\n");
    let file = path.join(dir, `${audit.date}-audit.md`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${audit.date}-audit-${n}.md`);
    fs.writeFileSync(file, `${SECURITY_NOTICE_FULL}\n\n---\n\n${md}\n\n---\n\n${SECURITY_NOTICE_FULL}\n`);
    report = path.relative(root, file).split(path.sep).join("/");
  } catch {
    report = undefined;
  }
  const counts = {
    defects: hits.filter((h) => h.severity === "defect").length,
    concerns: hits.filter((h) => h.severity === "concern").length,
    confirmed: findings.length,
    history: history.hits.length,
    vulnerable: depResult.vulns.length,
  };
  return { ok: true, report, counts, text: summaryText(audit, report, counts) };
}

export function summaryText(a: Audit, report: string | undefined, c: AuditResult["counts"]): string {
  const top: string[] = [];
  for (const f of a.findings.slice(0, 4)) top.push(`[${f.severity.toUpperCase()}] ${f.category} at ${f.file}${f.line ? `:${f.line}` : ""}: ${f.description}`);
  for (const h of a.history.hits.slice(0, 3)) top.push(`[SECRET] ${h.id} in ${h.file} (commit ${h.commit})${h.inCurrent ? "" : ", removed since but still in history: rotate it"}`);
  for (const v of a.deps.vulns.filter((x) => x.severity === "critical" || x.severity === "high").slice(0, 3)) top.push(`[${v.severity.toUpperCase()}] ${v.package}@${v.version}: ${v.summary || v.id}`);
  for (const h of a.hits.filter((x) => x.severity === "defect").slice(0, 4)) top.push(`[DEFECT] ${h.id} at ${h.file}:${h.line}`);
  return (
    `Security audit of ${a.name}: ${c.confirmed} confirmed attack path(s), ${c.defects} pattern defect(s), ${c.concerns} concern(s), ${c.history} secret(s) in history, ${c.vulnerable} vulnerable package version(s).\n` +
    (top.length ? `Most important:\n${top.slice(0, 8).map((t) => `- ${t}`).join("\n")}\n` : "No high-priority findings. That does not mean the app is secure: see what the audit did not cover.\n") +
    (report ? `Full report: ${report} (kept out of git by default). Say "fix the security findings in ${report}" to plan the repairs.\n` : "") +
    `Read-only audit: nothing was attacked and no running app was contacted.\n${SECURITY_NOTICE_SHORT}`
  );
}
