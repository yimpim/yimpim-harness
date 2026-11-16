import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  collectFiles, gitIn, hotspotChange, lookupVulns, osvFetch, pickHotspots, readLockedDeps, renderAudit, runSecurityAudit, scanHistory, summaryText, type Audit, type Dep,
} from "../src/securityAudit.js";
import { auditText, redactSecrets } from "../src/securityLint.js";
import { INTENT_SYSTEM } from "../src/prompts.js";

const repo = (files: Record<string, string> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
};
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const STRIPE = "sk_" + "live_51HxyzABCDEFGHIJKLMNOP1234";

describe("reading the project", () => {
  test("source and config files are collected; dependencies, build output, .git, .agent and big files are not", () => {
    const dir = repo({ "src/a.ts": "x", "node_modules/x/i.js": "x", "dist/b.js": "x", ".git/config": "x", ".agent/m.json": "{}", "big.js": "x".repeat(400_000), "empty.ts": "", "Dockerfile": "FROM node:20", ".env": "A=1", "README.md": "hi", "security/SECURITY.md": "x", "src/security/auth.ts": "y" });
    const rels = collectFiles(dir).map((f) => f.rel).sort();
    assert.deepEqual(rels, [".env", "Dockerfile", "src/a.ts", "src/security/auth.ts"].sort());
  });
  test("the count is bounded", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`s/f${i}.ts`] = "x";
    assert.equal(collectFiles(repo(files), 10).length, 10);
  });
});

describe("whole-file checks keep line numbers and never keep a secret", () => {
  test("hits carry the file and line; the code sample is kept for code, never for secrets", () => {
    const hits = auditText("src/pay.ts", ["const a = 1;", `const k = "${STRIPE}";`, "el.innerHTML = msg;"].join("\n"));
    const s = hits.find((h) => h.id === "secret-stripe")!;
    assert.deepEqual([s.line, s.severity, s.sample], [2, "defect", ""]);
    const x = hits.find((h) => h.id === "xss-sink")!;
    assert.deepEqual([x.line, x.sample], [3, "el.innerHTML = msg;"]);
    assert.ok(!JSON.stringify(hits).includes(STRIPE));
  });
  test("tests and docs are skipped, a real .env is flagged, an example is not", () => {
    assert.deepEqual(auditText("src/a.test.ts", [`const k = "${STRIPE}";`].join("\n")), []);
    assert.ok(auditText(".env", "A=1").some((h) => h.id === "env-committed"));
    assert.deepEqual(auditText(".env.example", "A=changeme"), []);
  });
  test("redaction removes known secret formats and credential assignments, and nothing else", () => {
    const text = `const a = "${TOKEN}";\nconst s = "${STRIPE}";\nconst password = "Tr0ub4dor&3xAmple9";\nconst ok = "hello";`;
    const r = redactSecrets(text);
    for (const bad of [TOKEN, STRIPE, "Tr0ub4dor"]) assert.ok(!r.includes(bad), bad);
    assert.match(r, /\[REDACTED\]/);
    assert.match(r, /const ok = "hello";/);
  });
});

// ---------------------------------------------------------------------------

describe("git history", () => {
  const log = [
    "@@@abc1234",
    "diff --git a/src/old.ts b/src/old.ts",
    "--- /dev/null",
    "+++ b/src/old.ts",
    "@@ -0,0 +1,2 @@",
    `+const t = "${TOKEN}";`,
    "+const x = 1;",
    "@@@def5678",
    "diff --git a/src/pay.ts b/src/pay.ts",
    "--- /dev/null",
    "+++ b/src/pay.ts",
    `+const k = "${STRIPE}";`,
    `+const k2 = "${STRIPE}";`,
    "@@@0000001",
    "diff --git a/package-lock.json b/package-lock.json",
    "+++ b/package-lock.json",
    `+"x": "${TOKEN}"`,
  ].join("\n");
  const fakeGit = (tracked = ".env\nsrc/a.ts\nconfig/serviceAccountKey.json\n.env.example\n"): any => async (args: string[]) => (args[0] === "ls-files" ? tracked : log);
  test("secrets ever committed are found by commit and file, once each, whether or not they are still there", async () => {
    const r = await scanHistory("/x", fakeGit(), new Map([["src/pay.ts", new Set(["secret-stripe"])]]));
    assert.deepEqual(r.hits.map((h) => [h.commit, h.file, h.id, h.inCurrent]), [["abc1234", "src/old.ts", "secret-github", false], ["def5678", "src/pay.ts", "secret-stripe", true]]);
    assert.equal(r.commitsScanned, 3);
    assert.ok(!JSON.stringify(r).includes(TOKEN) && !JSON.stringify(r).includes(STRIPE), "values are never kept");
  });
  test("tracked sensitive files are listed; examples are not", async () => {
    const r = await scanHistory("/x", fakeGit());
    assert.deepEqual(r.trackedSensitive.sort(), [".env", "config/serviceAccountKey.json"]);
  });
  test("a folder that is not a repository, and a history that cannot be read, say so and never throw", async () => {
    const none = await scanHistory("/x", (async () => { throw new Error("not a git repository"); }) as any);
    assert.match(none.note, /not a git repository/);
    const broken = await scanHistory("/x", (async (a: string[]) => { if (a[0] === "ls-files") return ""; throw new Error("boom"); }) as any);
    assert.match(broken.note, /could not be read/);
  });
  test("a long history is reported as partly scanned", async () => {
    const many = Array.from({ length: 6 }, (_, i) => `@@@c${i}`).join("\n");
    const r = await scanHistory("/x", (async (a: string[]) => (a[0] === "ls-files" ? "" : many)) as any, new Map(), 5);
    assert.match(r.note, /Only the most recent 5 commits/);
  });
  test("with real git: a token committed and then deleted is still found, marked as removed from the current code", { skip: (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return false; } catch { return true; } })() }, async () => {
    const dir = repo({ "src/a.ts": "export const a = 1;\n" });
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
    g("init", "-q");
    g("add", "."), g("commit", "-q", "-m", "one");
    fs.writeFileSync(path.join(dir, "src/a.ts"), `export const a = "${TOKEN}";\n`);
    g("commit", "-q", "-am", "oops");
    fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = process.env.A;\n");
    g("commit", "-q", "-am", "fixed");
    const r = await scanHistory(dir, gitIn(dir));
    assert.equal(r.hits.length, 1);
    assert.deepEqual([r.hits[0].file, r.hits[0].id, r.hits[0].inCurrent], ["src/a.ts", "secret-github", false]);
    assert.equal(r.commitsScanned, 3);
  });
});

// ---------------------------------------------------------------------------

describe("locked package versions, across ecosystems", () => {
  const lock = (rel: string, text: string) => [{ rel, text }];
  const names = (deps: Dep[]) => deps.map((d) => `${d.ecosystem}:${d.name}@${d.version}`).sort();
  test("npm package-lock (v3 and v1), yarn, pnpm", () => {
    const v3 = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "x" }, "node_modules/express": { version: "4.18.2" }, "node_modules/@scope/pkg": { version: "1.0.0" }, "node_modules/a/node_modules/lodash": { version: "4.17.20" } } });
    assert.deepEqual(names(readLockedDeps("/x", lock("package-lock.json", v3))), ["npm:@scope/pkg@1.0.0", "npm:express@4.18.2", "npm:lodash@4.17.20"]);
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } } } });
    assert.deepEqual(names(readLockedDeps("/x", lock("package-lock.json", v1))), ["npm:a@1.0.0", "npm:b@2.0.0"]);
    assert.deepEqual(names(readLockedDeps("/x", lock("yarn.lock", '"@scope/pkg@^1.0.0":\n  version "1.2.3"\n  resolved "x"\n\nlodash@^4.17.0:\n  version "4.17.21"\n'))), ["npm:@scope/pkg@1.2.3", "npm:lodash@4.17.21"]);
    assert.deepEqual(names(readLockedDeps("/x", lock("pnpm-lock.yaml", "packages:\n\n  /express@4.18.2:\n    resolution: {}\n  '@scope/pkg@1.2.3':\n    resolution: {}\n"))), ["npm:@scope/pkg@1.2.3", "npm:express@4.18.2"]);
  });
  test("Python, Rust, PHP, Ruby, Go, Dart", () => {
    assert.deepEqual(names(readLockedDeps("/x", lock("requirements.txt", "django==4.2.1\nrequests==2.31.0 # pinned\n-e .\nflask>=2\n"))), ["PyPI:django@4.2.1", "PyPI:requests@2.31.0"]);
    assert.deepEqual(names(readLockedDeps("/x", lock("poetry.lock", '[[package]]\nname = "flask"\nversion = "2.0.1"\n\n[[package]]\nname = "jinja2"\nversion = "3.1.2"\n'))), ["PyPI:flask@2.0.1", "PyPI:jinja2@3.1.2"]);
    assert.deepEqual(names(readLockedDeps("/x", lock("Cargo.lock", '[[package]]\nname = "serde"\nversion = "1.0.1"\nsource = "x"\n'))), ["crates.io:serde@1.0.1"]);
    assert.deepEqual(names(readLockedDeps("/x", lock("Pipfile.lock", JSON.stringify({ default: { requests: { version: "==2.0.0" } }, develop: {} })))), ["PyPI:requests@2.0.0"]);
    assert.deepEqual(names(readLockedDeps("/x", lock("composer.lock", JSON.stringify({ packages: [{ name: "laravel/framework", version: "v10.0.0" }], "packages-dev": [] })))), ["Packagist:laravel/framework@10.0.0"]);
    assert.deepEqual(names(readLockedDeps("/x", lock("Gemfile.lock", "GEM\n  specs:\n    rails (7.0.4)\n      actionpack (= 7.0.4)\n"))), ["RubyGems:rails@7.0.4"]);
    assert.deepEqual(names(readLockedDeps("/x", lock("go.sum", "github.com/gin-gonic/gin v1.9.0 h1:abc=\ngithub.com/gin-gonic/gin v1.9.0/go.mod h1:def=\n"))), ["Go:github.com/gin-gonic/gin@1.9.0"]);
    assert.deepEqual(names(readLockedDeps("/x", lock("pubspec.lock", 'packages:\n  http:\n    dependency: "direct main"\n    version: "0.13.5"\n'))), ["Pub:http@0.13.5"]);
  });
  test("a damaged lockfile gives nothing and does not throw", () => {
    assert.deepEqual(readLockedDeps("/x", lock("package-lock.json", "{nope")), []);
  });
});

describe("the vulnerability lookup", () => {
  const deps: Dep[] = [{ ecosystem: "npm", name: "lodash", version: "4.17.20" }, { ecosystem: "npm", name: "express", version: "4.18.2" }];
  test("only package names, versions and ecosystems are sent; advisories are detailed, ranked and mapped", async () => {
    const sent: any[] = [];
    const fetchJson = async (url: string, body?: any) => {
      sent.push({ url, body });
      if (url.endsWith("/querybatch")) return { results: [{ vulns: [{ id: "GHSA-1" }, { id: "GHSA-2" }] }, { vulns: [] }] };
      if (url.endsWith("GHSA-1")) return { summary: "Prototype pollution", database_specific: { severity: "HIGH" }, affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }] };
      return { summary: "Minor", database_specific: { severity: "LOW" } };
    };
    const r = await lookupVulns(deps, fetchJson as any);
    const batch = sent.find((s) => s.url.endsWith("/querybatch"))!;
    assert.deepEqual(batch.body, { queries: [{ package: { name: "lodash", ecosystem: "npm" }, version: "4.17.20" }, { package: { name: "express", ecosystem: "npm" }, version: "4.18.2" }] });
    assert.deepEqual(Object.keys(batch.body), ["queries"]);
    assert.deepEqual(r.vulns.map((v) => [v.id, v.severity, v.package, v.fixed]), [["GHSA-1", "high", "lodash", "4.17.21"], ["GHSA-2", "low", "lodash", ""]]);
    assert.equal(r.checked, 2);
  });
  test("an unreachable database, and no lockfile, are reported, never thrown", async () => {
    assert.match((await lookupVulns(deps, (async () => { throw new Error("offline"); }) as any)).note, /could not be reached/);
    assert.match((await lookupVulns([])).note, /No lockfile/);
  });
  test("the real reader refuses any host but api.osv.dev, without touching the network", async () => {
    for (const u of ["https://evil.example/v1/querybatch", "http://api.osv.dev/v1/querybatch", "file:///etc/passwd"]) await assert.rejects(() => osvFetch(u), /only api\.osv\.dev|Invalid URL/, u);
  });
});

// ---------------------------------------------------------------------------

describe("choosing what the attacker-style review reads", () => {
  test("risky files first, boosted by pattern defects and by how many files use them; UI and tests last", () => {
    const files = [
      { rel: "src/auth/login.ts", text: "export function login(password) {}" },
      { rel: "src/components/Button.tsx", text: "export const B = () => <b/>;" },
      { rel: "src/routes/orders.ts", text: "export const r = 1;" },
      { rel: "src/util/format.ts", text: "export const f = 1;" },
    ];
    const root = repo(Object.fromEntries(files.map((f) => [f.rel, f.text])));
    const spots = pickHotspots(files, root, [{ file: "src/routes/orders.ts", line: 1, id: "sql-concat", severity: "defect", message: "", sample: "" }], 5);
    assert.deepEqual(spots.map((s) => s.file), ["src/auth/login.ts", "src/routes/orders.ts"]);
  });
  test("the hotspots become a change the reviewer can read, one block per file", () => {
    const c = hotspotChange([{ rel: "a/x.ts", text: "one\ntwo" }, { rel: "b/y.ts", text: "three" }], [{ file: "a/x.ts", risk: "high", callers: 2 }, { file: "b/y.ts", risk: "medium", callers: 0 }]);
    assert.match(c.diff, /diff --git a\/a\/x\.ts b\/a\/x\.ts[\s\S]*\+one\n\+two[\s\S]*diff --git a\/b\/y\.ts/);
    assert.deepEqual(c.added, ["a/x.ts", "b/y.ts"]);
    assert.equal(hotspotChange([], []).isEmpty, true);
  });
});

// ---------------------------------------------------------------------------

const PROJECT = {
  "package.json": JSON.stringify({ name: "shop", dependencies: { express: "4", stripe: "14", "@supabase/supabase-js": "2" } }),
  "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/lodash": { version: "4.17.20" } } }),
  "src/auth/login.ts": `export function login(user, password) {\n  const k = "${STRIPE}";\n  return db.query("SELECT * FROM users WHERE name = '" + req.body.name + "'");\n}\n`,
  "src/routes/orders.ts": "export const list = (req) => db.query(`SELECT * FROM orders WHERE id = ${req.params.id}`);\n",
  "src/components/Button.tsx": "export const B = () => <b/>;\n",
  ".env": `STRIPE_SECRET=${STRIPE}\n`,
};
const modelCall = (seen: string[] = [], fail = false) => async (messages: { role: string; content: string }[], label: string) => {
  const all = messages.map((m) => m.content).join("\n");
  seen.push(all);
  if (fail) throw new Error("model down");
  if (/auditing an EXISTING application/.test(all) && /security architect/.test(all)) return JSON.stringify({ sensitive: true, surfaces: ["payments", "authorisation"], assets: ["orders"], actors: ["a signed-in user"], entryPoints: ["GET /orders/:id"], abuseCases: [{ attack: "read another user's order by id", impact: "data breach", mitigation: "check order.userId" }], requirements: ["order routes check the owner"] });
  if (/application security engineer/.test(all)) return JSON.stringify({ findings: [{ file: "src/routes/orders.ts", line: 1, category: "authz_bypass", severity: "high", description: "any user can read any order", exploit: "GET /orders/2 as user 1 returns user 2's order", fix: "filter by the caller", confidence: 0.95, pattern: "db.query(`SELECT * FROM orders WHERE id = ${" }] });
  return JSON.stringify({ keep: true, confidence: 0.9, reason: "no ownership check on the path", severity: "high" });
};
const noGit = (async (a: string[]) => { if (a[0] === "ls-files") return ".env\n"; return "@@@aaa1111\ndiff --git a/src/old.ts b/src/old.ts\n+++ b/src/old.ts\n+const t = \"" + TOKEN + "\";\n"; }) as any;
const osv = (async (url: string) => (url.endsWith("/querybatch") ? { results: [{ vulns: [{ id: "GHSA-9" }] }] } : { summary: "Prototype pollution in lodash", database_specific: { severity: "HIGH" }, affected: [{ ranges: [{ events: [{ fixed: "4.17.21" }] }] }] })) as any;

describe("the audit, end to end", () => {
  test("it reports attack paths, pattern findings, history secrets and vulnerable packages, with the report kept out of git", async () => {
    const dir = repo(PROJECT);
    const logs: string[] = [];
    const r = await runSecurityAudit({ repoRoot: dir, call: modelCall() as any, git: noGit, fetchJson: osv, log: (l) => logs.push(l) });
    assert.ok(r.ok && r.report);
    assert.deepEqual([r.counts.confirmed, r.counts.history, r.counts.vulnerable], [1, 1, 1]);
    assert.ok(r.counts.defects >= 2);
    const md = fs.readFileSync(path.join(dir, r.report!), "utf-8");
    for (const re of [/# Security audit: pt-/, /Nothing was attacked and no running app was contacted/, /\[HIGH\] authz_bypass at src\/routes\/orders\.ts:1/, /GET \/orders\/2 as user 1 returns user 2's order/, /secret-github.*src\/old\.ts.*removed since, but still in git history/, /\.env` is tracked by git/, /lodash@4\.17\.20.*GHSA-9.*fixed in 4\.17\.21/, /\*\*secret-stripe\*\*/, /Hardening checklist \(not verified/, /not a certified penetration test/, /Stage 2, not enabled/]) assert.match(md, re);
    assert.equal(fs.readFileSync(path.join(dir, "security/audits/.gitignore"), "utf-8").includes("*"), true);
    assert.ok(logs.some((l) => /Read-only/.test(l)));
  });
  test("no secret value is ever written to the report, the log, the summary or a model prompt", async () => {
    const dir = repo(PROJECT);
    const seen: string[] = [];
    const logs: string[] = [];
    const r = await runSecurityAudit({ repoRoot: dir, call: modelCall(seen) as any, git: noGit, fetchJson: osv, log: (l) => logs.push(l) });
    const everything = [fs.readFileSync(path.join(dir, r.report!), "utf-8"), r.text, ...logs, ...seen].join("\n");
    assert.ok(!everything.includes(STRIPE), "the Stripe key leaked");
    assert.ok(!everything.includes(TOKEN), "the GitHub token leaked");
    assert.ok(seen.length >= 2, "the models were consulted");
  });
  test("a local .env that git does not track is not a finding; a tracked one is", async () => {
    const dir = repo(PROJECT);
    const untracked = await runSecurityAudit({ repoRoot: dir, call: modelCall() as any, git: (async (a: string[]) => (a[0] === "ls-files" ? "" : "")) as any, fetchJson: osv, log: () => {} });
    assert.ok(!fs.readFileSync(path.join(dir, untracked.report!), "utf-8").includes("env-committed"));
    const tracked = await runSecurityAudit({ repoRoot: dir, call: modelCall() as any, git: noGit, fetchJson: osv, log: () => {} });
    assert.match(fs.readFileSync(path.join(dir, tracked.report!), "utf-8"), /env-committed/);
  });
  test("with the lookup off nothing is sent to the vulnerability database", async () => {
    const dir = repo(PROJECT);
    let called = 0;
    const r = await runSecurityAudit({ repoRoot: dir, call: modelCall() as any, git: noGit, dependencyLookup: false, fetchJson: (async () => (called++, {})) as any, log: () => {} });
    assert.equal(called, 0);
    assert.match(fs.readFileSync(path.join(dir, r.report!), "utf-8"), /vulnerability lookup is turned off/);
  });
  test("a failing model still yields a report from the checks, history and packages, and says what is missing", async () => {
    const dir = repo(PROJECT);
    const r = await runSecurityAudit({ repoRoot: dir, call: modelCall([], true) as any, git: noGit, fetchJson: osv, log: () => {} });
    assert.ok(r.ok);
    assert.equal(r.counts.confirmed, 0);
    assert.ok(r.counts.defects >= 2 && r.counts.history === 1);
    assert.match(fs.readFileSync(path.join(dir, r.report!), "utf-8"), /None found by the review \(the review could not run|did not survive|could not be made|No application-level model/);
  });
  test("a second audit on the same day gets its own file; an empty folder says there is nothing to audit", async () => {
    const dir = repo(PROJECT);
    const a = await runSecurityAudit({ repoRoot: dir, call: modelCall() as any, git: noGit, fetchJson: osv, log: () => {} });
    const b = await runSecurityAudit({ repoRoot: dir, call: modelCall() as any, git: noGit, fetchJson: osv, log: () => {} });
    assert.notEqual(a.report, b.report);
    assert.ok(fs.existsSync(path.join(dir, a.report!)) && fs.existsSync(path.join(dir, b.report!)));
    const empty = await runSecurityAudit({ repoRoot: repo(), call: modelCall() as any, log: () => {} });
    assert.equal(empty.ok, false);
    assert.match(empty.text, /no source files/);
  });
  test("the summary leads with what matters, points at the report, and is honest about its limits", async () => {
    const dir = repo(PROJECT);
    const r = await runSecurityAudit({ repoRoot: dir, call: modelCall() as any, git: noGit, fetchJson: osv, log: () => {} });
    assert.match(r.text, /^Security audit of pt-\w+: 1 confirmed attack path\(s\)/);
    assert.match(r.text, /- \[HIGH\] authz_bypass at src\/routes\/orders\.ts:1: any user can read any order/);
    assert.match(r.text, /\[SECRET\] secret-github in src\/old\.ts \(commit aaa1111\), removed since but still in history: rotate it/);
    assert.match(r.text, /Say "fix the security findings in security\/audits\/[\d-]+-audit\.md"/);
    assert.match(r.text, /Read-only audit: nothing was attacked and no running app was contacted\./);
    assert.match(r.text, /not a penetration test, audit or guarantee of security/);
  });
  test("a clean project does not claim to be secure", () => {
    const a: Audit = { name: "x", date: "2026-11-15", stack: { packs: [], evidence: {} }, filesScanned: 3, hits: [], history: { hits: [], trackedSensitive: [], commitsScanned: 4, note: "" }, deps: { checked: 0, vulns: [], note: "" }, model: null, hotspots: [], findings: [], reviewNote: "no risky files were identified" };
    const s = summaryText(a, undefined, { defects: 0, concerns: 0, confirmed: 0, history: 0, vulnerable: 0 });
    assert.match(s, /No high-priority findings\. That does not mean the app is secure/);
    assert.match(renderAudit(a), /does not mean the app is secure/);
  });
});

describe("how /pentest is reached", () => {
  test("the intent classifier knows it, and the command and the config switch exist", () => {
    assert.match(INTENT_SYSTEM, /"pentest" \| "branch"|"design" \| "pentest"/);
    assert.match(INTENT_SYSTEM, /"pentest" — they want a SECURITY AUDIT/);
    const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    for (const re of [/trimmed === "\/pentest" \|\| trimmed\.startsWith\("\/pentest "\)/, /runSecurityAudit\(/, /outcome === "pentest"/, /\/pentest {10}Security audit of this project/]) assert.match(idx, re);
    const cfg = fs.readFileSync(new URL("../src/config.ts", import.meta.url), "utf-8");
    assert.match(cfg, /dependencyLookup: z\.boolean\(\)\.default\(true\)/);
  });
});

describe("streaming a large history", () => {
  const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
  const make = () => {
    const dir = repo({ "src/a.ts": "export const a = 1;\n" });
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
    g("init", "-q");
    g("add", "."), g("commit", "-q", "-m", "one");
    fs.writeFileSync(path.join(dir, "src/a.ts"), `export const a = "${TOKEN}";\n`);
    g("commit", "-q", "-am", "oops");
    return dir;
  };
  test("the line stream finds the same secret without buffering the whole history", { skip: !hasGit }, async () => {
    const { gitLinesIn } = await import("../src/securityAudit.js");
    const dir = make();
    const r = await scanHistory(dir, gitIn(dir), new Map([["src/a.ts", new Set(["secret-github"])]]), 500, gitLinesIn(dir));
    assert.deepEqual(r.hits.map((h) => [h.file, h.id, h.inCurrent]), [["src/a.ts", "secret-github", true]]);
    assert.equal(r.commitsScanned, 2);
    assert.equal(r.note, "");
  });
  test("a size limit stops the scan and says so", { skip: !hasGit }, async () => {
    const { gitLinesIn } = await import("../src/securityAudit.js");
    const dir = make();
    const r = await scanHistory(dir, gitIn(dir), new Map(), 500, gitLinesIn(dir, 40));
    assert.match(r.note, /stopped at its size or time limit/);
  });
  test("a failing git command is reported, not thrown", async () => {
    const { gitLinesIn } = await import("../src/securityAudit.js");
    const r = await scanHistory("/definitely/not/here", (async () => "") as any, new Map(), 500, gitLinesIn(os.tmpdir() + "/nope-" + Date.now()));
    assert.match(r.note, /could not be read/);
  });
});

describe("history ignores what the current scan ignores", () => {
  test("a secret-shaped value in a test file or fixture in history is not reported", async () => {
    const log = ["@@@aaa", "diff --git a/test/pay.test.ts b/test/pay.test.ts", "+++ b/test/pay.test.ts", `+const k = "${STRIPE}";`, "diff --git a/src/pay.ts b/src/pay.ts", "+++ b/src/pay.ts", `+const k = "${STRIPE}";`].join("\n");
    const r = await scanHistory("/x", (async (a: string[]) => (a[0] === "ls-files" ? "" : log)) as any);
    assert.deepEqual(r.hits.map((h) => h.file), ["src/pay.ts"]);
  });
});
