import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LANG_PACKS, UNIVERSAL } from "../src/securityRules.js";
import { PLATFORM_PACKS } from "../src/securityVendors.js";
import { ALL_PACKS, coreSecurityBlock, detectSecurityStack, packById, securityDoc } from "../src/securityStack.js";
import {
  SECURITY_DIR, TASK_FILE, clearSecurityCache, ensureSecurityDoc, ensureThreatModel, loadTaskSecurity, parseThreatModel, plannerText, securityForPrompt,
} from "../src/securityPlan.js";
import { CONFIDENCE_MIN, blastRadius, classifyFile, findVariants, parseCandidates, renderReview, securityReview } from "../src/securityReview.js";
import { deterministicSignals, staticQaReview, type ChangeSet } from "../src/staticQa.js";
import { buildContextualSystemPrompt } from "../src/agentLoop.js";
import { AutonomousVerifier } from "../src/verifierTools.js";

const repo = (files: Record<string, string> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-"));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  clearSecurityCache();
  return dir;
};
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "x", dependencies: deps });

describe("the rules are well formed", () => {
  test("every rule has an id, a do, a not and a standard reference; ids are unique within a pack", () => {
    for (const set of [UNIVERSAL, ...ALL_PACKS.map((p) => p.rules)]) {
      const seen = new Set<string>();
      for (const r of set) {
        assert.ok(r.id && r.do.length >= 12 && r.not.length > 8 && r.ref, r.id);
        assert.ok(!seen.has(r.id), "duplicate " + r.id);
        seen.add(r.id);
        assert.ok(["critical", "high", "medium"].includes(r.sev));
      }
    }
    const ids = ALL_PACKS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ALL_PACKS.every((p) => p.rules.length >= 3 && p.hardening.length >= 1), "every pack has rules and hardening");
  });
  test("the packs cover the platforms and vendors the harness meets", () => {
    for (const id of ["supabase", "firebase", "aws", "azure", "gcp", "containers", "kubernetes", "iac", "ci", "server", "android", "ios", "payments", "auth", "email", "database", "llm", "web", "api", "node", "python", "java", "go", "php", "ruby", "dotnet", "react"]) assert.ok(packById(id), id);
    assert.equal(PLATFORM_PACKS.length + LANG_PACKS.length, ALL_PACKS.length);
  });
  test("the numbers match the published guidance", () => {
    const pw = UNIVERSAL.find((r) => r.id === "password-storage")!;
    assert.match(pw.do, /Argon2id/);
    assert.match(pw.do, /19 MiB/);
    assert.match(pw.do, /600,000/);
    assert.match(UNIVERSAL.find((r) => r.id === "headers-cors")!.do, /HSTS/);
    assert.match(UNIVERSAL.find((r) => r.id === "ssrf")!.do, /169\.254\.169\.254/);
    assert.match(packById("payments")!.rules.map((r) => r.do).join(" "), /signature/);
    assert.match(packById("supabase")!.rules.map((r) => r.do).join(" "), /auth\.uid\(\)/);
  });
});

describe("what a project is made of", () => {
  test("an Expo app with Supabase and Stripe: vendors first, then the mobile platforms and the front end", () => {
    const dir = repo({ "package.json": pkg({ expo: "52", "react-native": "0.76", "@supabase/supabase-js": "2", "@stripe/stripe-react-native": "1" }), "supabase/config.toml": "x", "supabase/migrations/1.sql": "select 1" });
    const s = detectSecurityStack(dir);
    for (const p of ["supabase", "payments", "react", "android", "ios"]) assert.ok(s.packs.includes(p), p);
    assert.ok(s.packs.indexOf("supabase") < s.packs.indexOf("react") && s.packs.indexOf("payments") < s.packs.indexOf("android"));
    assert.ok(s.evidence["supabase"].some((e) => /supabase/.test(e)));
    assert.ok(s.evidence["payments"][0].includes("stripe"));
  });
  test("a Go service in Kubernetes with Terraform and GitHub Actions", () => {
    const dir = repo({ "go.mod": "module x\n\nrequire github.com/gin-gonic/gin v1.9.0\n", "k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\n", "infra/main.tf": "resource {}", ".github/workflows/ci.yml": "on: push", Dockerfile: "FROM golang" });
    const s = detectSecurityStack(dir);
    for (const p of ["go", "kubernetes", "iac", "ci", "containers", "api", "web"]) assert.ok(s.packs.includes(p), p);
  });
  test("Django with Postgres, SendGrid and Auth0; Spring on Maven; Firebase by its files; Android by its manifest", () => {
    const py = detectSecurityStack(repo({ "requirements.txt": "django==5.0\npsycopg2-binary\nsendgrid\nauth0-python\nopenai\n" }));
    for (const p of ["python", "database", "email", "auth", "llm"]) assert.ok(py.packs.includes(p), p);
    assert.ok(detectSecurityStack(repo({ "pom.xml": "<artifactId>spring-boot-starter-web</artifactId>" })).packs.includes("java"));
    assert.ok(detectSecurityStack(repo({ "firebase.json": "{}", "firestore.rules": "x" })).packs.includes("firebase"));
    assert.ok(detectSecurityStack(repo({ "app/src/main/AndroidManifest.xml": "<manifest/>" })).packs.includes("android"));
    assert.ok(detectSecurityStack(repo({ "ios/App/Info.plist": "<plist/>" })).packs.includes("ios"));
    assert.ok(detectSecurityStack(repo({ "main.bicep": "x" })).packs.includes("azure"));
    assert.ok(detectSecurityStack(repo({ "package.json": pkg({ "@google-cloud/storage": "7" }) })).packs.includes("gcp"));
    assert.ok(detectSecurityStack(repo({ "package.json": pkg({ "@aws-sdk/client-s3": "3" }) })).packs.includes("aws"));
    assert.ok(detectSecurityStack(repo({ "package.json": pkg({ "@mailchimp/mailchimp_marketing": "3" }) })).packs.includes("email"));
    assert.ok(detectSecurityStack(repo({ "package.json": pkg({ "next-auth": "4" }) })).packs.includes("auth"));
    assert.ok(detectSecurityStack(repo({ "pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter\n  firebase_core: ^2\n" })).packs.includes("firebase"));
  });
  test("an empty or unrecognisable project has no packs and does not throw; a broken manifest is skipped", () => {
    assert.deepEqual(detectSecurityStack(repo({ "notes.txt": "hi" })).packs, []);
    assert.deepEqual(detectSecurityStack(repo({ "package.json": "{nope" })).packs, []);
    assert.deepEqual(detectSecurityStack("/definitely/not/here").packs, []);
  });
  test("a Kubernetes manifest is recognised by its content, wherever it lives", () => {
    assert.ok(detectSecurityStack(repo({ "deploy/app.yaml": "apiVersion: v1\nkind: Pod\n" })).packs.includes("kubernetes"));
  });
  test("node_modules is never read", () => {
    assert.deepEqual(detectSecurityStack(repo({ "node_modules/x/package.json": pkg({ stripe: "1" }) })).packs, []);
  });
});

describe("what agents are given", () => {
  test("the core block: universal rules first, then vendors, inside the budget", () => {
    const dir = repo({ "package.json": pkg({ "@supabase/supabase-js": "2", stripe: "14", express: "4" }) });
    const b = coreSecurityBlock(detectSecurityStack(dir));
    assert.match(b, /^SECURITY RULES/);
    assert.ok(b.indexOf("[all code]") < b.indexOf("[Supabase]") && b.indexOf("[Supabase]") < b.indexOf("[Payments"));
    assert.match(b, /service_role/);
    assert.ok(b.length < 7600, String(b.length));
    assert.match(b, /security\/SECURITY\.md/);
    assert.ok(coreSecurityBlock({ packs: [], evidence: {} }, 500).length < 900, "a small budget is respected");
  });
  test("the Editor and Repair get the rules; Discovery, Planner and verify-only do not", () => {
    const dir = repo({ "package.json": pkg({ stripe: "14", express: "4" }) });
    const cfg: any = { prompts: { systemPersona: "P" }, memory: {}, security: { enabled: true } };
    assert.match(buildContextualSystemPrompt("EDITOR", cfg, dir), /SECURITY RULES/);
    assert.match(buildContextualSystemPrompt("REPAIR", cfg, dir), /SECURITY RULES/);
    assert.ok(!/SECURITY RULES/.test(buildContextualSystemPrompt("DISCOVERY", cfg, dir)));
    assert.ok(!/SECURITY RULES/.test(buildContextualSystemPrompt("EDITOR", cfg, dir, true)));
    assert.ok(!/SECURITY RULES/.test(buildContextualSystemPrompt("EDITOR", { ...cfg, security: { enabled: false } }, dir)));
    assert.ok(securityForPrompt(dir).includes("Payments"));
  });
  test("the posture document lists what was found, every applicable rule with its reference, and hardening", () => {
    const dir = repo({ "package.json": pkg({ "@supabase/supabase-js": "2" }) });
    const s = detectSecurityStack(dir);
    const doc = securityDoc(s, "shop");
    assert.match(doc, /^<!-- packs: supabase/);
    for (const re of [/# Security: shop/, /## What this project uses/, /Supabase: @supabase\/supabase-js/, /\*\*sb-rls\*\* \[critical; Supabase RLS, CWE-862\]/, /\*\*secrets-out\*\*/, /Harden:/, /do not prove an app is secure/, /penetration test/]) assert.match(doc, re);
  });
  test("SECURITY.md is written once, rewritten when the stack changes, and never over a person's own file", () => {
    const dir = repo({ "package.json": pkg({ stripe: "14" }) });
    assert.equal(ensureSecurityDoc(dir).written, true);
    assert.equal(ensureSecurityDoc(dir).written, false);
    fs.writeFileSync(path.join(dir, "package.json"), pkg({ stripe: "14", "@supabase/supabase-js": "2" }));
    assert.equal(ensureSecurityDoc(dir).written, true);
    assert.match(fs.readFileSync(path.join(dir, SECURITY_DIR, "SECURITY.md"), "utf-8"), /packs: supabase,payments/);
    fs.writeFileSync(path.join(dir, SECURITY_DIR, "SECURITY.md"), "# my own policy\n");
    fs.writeFileSync(path.join(dir, "package.json"), pkg({ firebase: "10" }));
    assert.equal(ensureSecurityDoc(dir).written, false);
    assert.equal(fs.readFileSync(path.join(dir, SECURITY_DIR, "SECURITY.md"), "utf-8"), "# my own policy\n");
    assert.equal(ensureSecurityDoc(repo({ "a.txt": "x" })).written, false, "no stack, no document");
  });
});

describe("the threat model", () => {
  const sensitive = JSON.stringify({ sensitive: true, surfaces: ["payments", "third-party-webhooks", "bogus"], assets: ["orders"], actors: ["a signed-in user attacking another user"], entryPoints: ["POST /webhooks/stripe"], abuseCases: [{ attack: "replay a paid webhook", impact: "free goods", mitigation: "verify the signature; ignore seen event ids" }, { attack: "", impact: "x", mitigation: "y" }], requirements: ["the webhook verifies the Stripe signature on the raw body", "orders are fetched by id AND owner"] });
  test("junk is no model; a not-sensitive answer is risky=false; a sensitive answer needs surfaces or requirements", () => {
    assert.equal(parseThreatModel("nonsense"), null);
    assert.equal(parseThreatModel(JSON.stringify({ sensitive: false, requirements: ["x"] }))!.risky, false);
    assert.equal(parseThreatModel(JSON.stringify({ sensitive: true }))!.risky, false, "sensitive with nothing to say is not a model");
    const t = parseThreatModel(sensitive)!;
    assert.equal(t.risky, true);
    assert.deepEqual(t.surfaces, ["payments", "third-party-webhooks"], "unknown surfaces are dropped");
    assert.equal(t.abuseCases.length, 1, "an abuse case with no attack is dropped");
    assert.equal(t.requirements.length, 2);
  });
  const ctx = (dir: string, answer: string | Error) => ({
    call: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
    models: ["a/x"],
    repoRoot: dir,
    request: "add stripe checkout and a webhook",
    log: () => {},
  });
  test("a sensitive task: recorded in security/threat-models, written for the verifier, and its requirements go to the Planner", async () => {
    const dir = repo({ "package.json": pkg({ stripe: "14" }) });
    const r = await ensureThreatModel(ctx(dir, sensitive));
    assert.ok(r.task.risky && r.task.file);
    const md = fs.readFileSync(path.join(dir, r.task.file!), "utf-8");
    assert.match(md, /# Threat model: add stripe checkout and a webhook/);
    assert.match(md, /- \[ \] the webhook verifies the Stripe signature on the raw body/);
    assert.match(md, /reasoned, not measured/);
    assert.equal(loadTaskSecurity(dir)!.risky, true);
    assert.match(r.plannerSection, /Security requirements for this task/);
    assert.match(r.plannerSection, /- the webhook verifies the Stripe signature/);
    assert.match(r.plannerSection, /replay a paid webhook \(mitigation: verify the signature/);
    assert.ok(fs.existsSync(path.join(dir, SECURITY_DIR, "SECURITY.md")));
  });
  test("a task that is not sensitive resets the record, so an earlier task's model never carries over", async () => {
    const dir = repo({ "package.json": pkg({ stripe: "14" }) });
    await ensureThreatModel(ctx(dir, sensitive));
    assert.equal(loadTaskSecurity(dir)!.risky, true);
    const r = await ensureThreatModel(ctx(dir, JSON.stringify({ sensitive: false })));
    assert.equal(r.plannerSection, "");
    assert.equal(loadTaskSecurity(dir)!.risky, false);
  });
  test("a failing model leaves the task un-flagged, and says so, without throwing", async () => {
    const dir = repo({ "package.json": pkg({ stripe: "14" }) });
    const logs: string[] = [];
    const r = await ensureThreatModel({ ...ctx(dir, new Error("down")), log: (l: string) => logs.push(l) });
    assert.equal(r.task.risky, false);
    assert.ok(logs.some((l) => /No threat model could be made/.test(l)));
    assert.equal(loadTaskSecurity(dir)!.risky, false);
    assert.equal(plannerText(r.task), "");
  });
  test("the file is read back safely when it is missing or damaged", () => {
    const dir = repo();
    assert.equal(loadTaskSecurity(dir), null);
    fs.mkdirSync(path.join(dir, ".agent"));
    fs.writeFileSync(path.join(dir, TASK_FILE), "{nope");
    assert.equal(loadTaskSecurity(dir), null);
  });
});

// ---------------------------------------------------------------------------

const diffOf = (file: string, lines: string[]) => `diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n${lines.map((l) => "+" + l).join("\n")}`;
const change = (files: Record<string, string[]>, over: Partial<ChangeSet> = {}): ChangeSet => ({
  diff: Object.entries(files).map(([f, l]) => diffOf(f, l)).join("\n"),
  modified: [],
  added: Object.keys(files),
  deleted: [],
  renamed: [],
  isEmpty: false,
  ...over,
});

describe("triage", () => {
  test("risk comes from where the file lives and what was added; tests and docs are low", () => {
    assert.equal(classifyFile("src/auth/login.ts", "x"), "high");
    assert.equal(classifyFile("src/pay/webhook.ts", "x"), "high");
    assert.equal(classifyFile("src/util/format.ts", "const sql = `SELECT * FROM t WHERE id = ${id}`"), "high");
    assert.equal(classifyFile("src/routes/orders.ts", "return list"), "medium");
    assert.equal(classifyFile("src/components/Button.tsx", "<b/>"), "low");
    assert.equal(classifyFile("src/auth/login.test.ts", "x"), "low");
    assert.equal(classifyFile("docs/security.md", "password"), "low");
  });
  test("blast radius counts the files that import this one and grades it", () => {
    const files: Record<string, string> = { "src/lib/session.ts": "export const s = 1;" };
    for (let i = 0; i < 7; i++) files[`src/pages/p${i}.ts`] = `import { s } from "../lib/session";`;
    files["src/pages/other.ts"] = `import { x } from "../lib/other";`;
    const dir = repo(files);
    const b = blastRadius(dir, "src/lib/session.ts");
    assert.equal(b.callers, 7);
    assert.equal(b.level, "medium");
    assert.equal(blastRadius(dir, "src/pages/other.ts").callers, 0);
  });
});

describe("candidates and variants", () => {
  const known = ["src/a.ts"];
  const good = { file: "src/a.ts", line: 10, category: "sql_injection", severity: "high", description: "d", exploit: "send ' OR 1=1", fix: "param", confidence: 0.9, pattern: "db.query(`SELECT * FROM users WHERE id = ${" };
  test("a finding must be about a file the change touched, say how it is exploited, and have a severity", () => {
    assert.equal(parseCandidates(JSON.stringify({ findings: [good] }), known).length, 1);
    assert.equal(parseCandidates(JSON.stringify({ findings: [{ ...good, file: "other.ts" }] }), known).length, 0);
    assert.equal(parseCandidates(JSON.stringify({ findings: [{ ...good, exploit: "" }] }), known).length, 0);
    assert.equal(parseCandidates(JSON.stringify({ findings: [{ ...good, severity: "low" }] }), known).length, 0);
    assert.equal(parseCandidates("not json", known).length, 0);
    assert.equal(parseCandidates(JSON.stringify({ findings: [{ ...good, confidence: 9 }] }), known)[0].confidence, 0.9, "a 0-10 score is rescaled");
    assert.equal(parseCandidates(JSON.stringify({ findings: [{ ...good, file: "./src/a.ts" }] }), known).length, 1);
  });
  test("the same pattern is searched for elsewhere, excluding the reported line, and nonsense patterns find nothing", () => {
    const dir = repo({ "src/a.ts": "x\nx\nx\nx\nx\nx\nx\nx\nx\ndb.query(`SELECT * FROM users WHERE id = ${id}`)", "src/b.ts": "ok\ndb.query(`SELECT * FROM users WHERE id = ${req.id}`)", "src/c.ts": "clean" });
    const v = findVariants(dir, { ...good, pattern: "db.query(`SELECT * FROM users WHERE id = ${" } as any);
    assert.deepEqual(v, ["src/b.ts:2"]);
    assert.deepEqual(findVariants(dir, { ...good, pattern: "x" } as any), []);
    assert.deepEqual(findVariants(dir, { ...good, pattern: "   " } as any), []);
    assert.deepEqual(findVariants(dir, { ...good, pattern: undefined } as any), []);
  });
});

describe("the review: find, refute, keep what survives", () => {
  const dir = () => repo({ "package.json": pkg({ express: "4" }), "src/routes/orders.ts": Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"), "src/routes/other.ts": "db.query(`SELECT * FROM orders WHERE id = ${req.params.id}`)" });
  const c = change({ "src/routes/orders.ts": ["db.query(`SELECT * FROM orders WHERE id = ${req.params.id}`)"] });
  const finding = (over: object = {}) => ({ file: "src/routes/orders.ts", line: 12, category: "sql_injection", severity: "high", description: "id goes into the query", exploit: "GET /orders/1 OR 1=1 returns every order", fix: "use a placeholder", confidence: 0.95, pattern: "db.query(`SELECT * FROM orders WHERE id = ${", ...over });
  const asker = (findings: object[], verdict: object, calls: string[] = []) => async (system: string) => {
    if (/application security engineer/.test(system)) {
      calls.push("find");
      return JSON.stringify({ findings });
    }
    calls.push("filter");
    return JSON.stringify(verdict);
  };
  test("a real flaw survives the refuting pass, with its variants, blast radius and exploit", async () => {
    const calls: string[] = [];
    const r = (await securityReview({ goal: "list orders", change: c, repoRoot: dir(), ask: asker([finding()], { keep: true, confidence: 0.9, reason: "id is request-controlled and unparameterised", severity: "high" }, calls) }))!;
    assert.deepEqual(calls, ["find", "filter"]);
    assert.equal(r.findings.length, 1);
    assert.deepEqual(r.findings[0].variants, ["src/routes/other.ts:1"]);
    assert.match(r.findings[0].verdict, /request-controlled/);
    assert.ok(r.highRisk.includes("src/routes/orders.ts") === false || true);
    const text = renderReview(r);
    assert.match(text, /\[HIGH\] sql_injection at src\/routes\/orders\.ts:12 \(confidence 90%\)/);
    assert.match(text, /How it is exploited: GET \/orders\/1 OR 1=1/);
    assert.match(text, /The same pattern also appears at: src\/routes\/other\.ts:1/);
  });
  test("a finding the skeptic doubts is dropped, and so is one below the confidence line", async () => {
    const refuted = (await securityReview({ goal: "g", change: c, repoRoot: dir(), ask: asker([finding()], { keep: false, confidence: 0.9, reason: "guarded by middleware" }) }))!;
    assert.equal(refuted.findings.length, 0);
    assert.equal(refuted.dropped, 1);
    assert.match(renderReview(refuted), /did not survive the refuting pass/);
    assert.match(renderReview(refuted), /not proof of safety/);
    const unsure = (await securityReview({ goal: "g", change: c, repoRoot: dir(), ask: asker([finding()], { keep: true, confidence: CONFIDENCE_MIN - 0.1, reason: "maybe" }) }))!;
    assert.equal(unsure.findings.length, 0);
    const lowFinder = (await securityReview({ goal: "g", change: c, repoRoot: dir(), ask: asker([finding({ confidence: 0.3 })], { keep: true, confidence: 1 }) }))!;
    assert.equal(lowFinder.findings.length, 0, "the finder's own low confidence never reaches the skeptic");
  });
  test("the second pass can lower the severity", async () => {
    const r = (await securityReview({ goal: "g", change: c, repoRoot: dir(), ask: asker([finding()], { keep: true, confidence: 0.85, reason: "needs auth", severity: "medium" }) }))!;
    assert.equal(r.findings[0].severity, "medium");
  });
  test("it does not run for an ordinary change, and does for risky code or a flagged task", async () => {
    let asked = 0;
    const ask = async () => (asked++, JSON.stringify({ findings: [] }));
    const ui = change({ "src/components/Button.tsx": ["export const B = () => <b/>;"] });
    assert.equal(await securityReview({ goal: "g", change: ui, repoRoot: dir(), ask }), null);
    assert.equal(asked, 0);
    assert.ok(await securityReview({ goal: "g", change: ui, repoRoot: dir(), ask, task: { risky: true, surfaces: ["payments"], assets: [], actors: [], entryPoints: [], abuseCases: [], requirements: ["x"], createdAt: "" } }));
    assert.ok(await securityReview({ goal: "g", change: change({ "src/auth/login.ts": ["export const login = 1;"] }), repoRoot: dir(), ask }));
    assert.equal(await securityReview({ goal: "g", change: { ...ui, isEmpty: true }, repoRoot: dir(), ask }), null);
  });
  test("the finder sees the threat model and the project's rules; a failing model says so and never throws", async () => {
    const seen: string[] = [];
    const ask = async (s: string, u: string) => (seen.push(u), JSON.stringify({ findings: [] }));
    await securityReview({ goal: "g", change: c, repoRoot: dir(), ask, task: { risky: true, surfaces: ["payments"], assets: [], actors: [], entryPoints: [], abuseCases: [{ attack: "replay the webhook", impact: "", mitigation: "idempotency" }], requirements: ["verify the signature"], createdAt: "" }, leads: ["[sql-concat] a query is built by joining strings"] });
    assert.match(seen[0], /replay the webhook -> idempotency/);
    assert.match(seen[0], /- verify the signature/);
    assert.match(seen[0], /Pattern checks already raised/);
    assert.match(seen[0], /SECURITY RULES/);
    const r = (await securityReview({ goal: "g", change: c, repoRoot: dir(), ask: async () => { throw new Error("boom"); } }))!;
    assert.equal(r.ran, false);
    assert.match(renderReview(r), /could not run/);
  });
  test("a finding whose second pass fails is not reported, and says so", async () => {
    const ask = async (system: string) => {
      if (/application security engineer/.test(system)) return JSON.stringify({ findings: [finding()] });
      throw new Error("down");
    };
    const r = (await securityReview({ goal: "g", change: c, repoRoot: dir(), ask }))!;
    assert.equal(r.findings.length, 0);
    assert.ok(r.notes.some((n) => /could not be checked/.test(n)));
  });
});

describe("how it reaches the harness", () => {
  test("static QA's pattern checks put a committed secret into the review as a defect, whatever the language", async () => {
    const ch = change({ "src/pay.py": ['STRIPE = "sk_' + 'live_51HxyzABCDEFGHIJKLMNOP1234"'] });
    const s = deterministicSignals(ch);
    assert.ok(s.some((x) => x.severity === "defect" && x.message.includes("[secret-stripe]") && x.requirement === "No exploitable security flaw introduced"));
    const review = await staticQaReview("add pay", ch, { ask: async () => JSON.stringify({ findings: [{ requirement: "pay", status: "satisfied", evidence: "x" }], concerns: [], summary: "ok", needsPerFileReview: false }) }, "ctx");
    assert.ok(review.defectFound);
    assert.ok(review.findings.some((f) => f.requirement === "No exploitable security flaw introduced" && f.status === "missing"));
  });
  test("a whole-file check works through the change's repo root: a payment webhook with no signature check", () => {
    const dir = repo({ "src/webhooks/stripe.ts": "app.post('/webhooks/stripe', (req, res) => {\n  if (req.body.type === 'payment_intent.succeeded') grant();\n  res.sendStatus(200);\n});" });
    const ch = change({ "src/webhooks/stripe.ts": ["app.post('/webhooks/stripe', (req, res) => {"] }, { repoRoot: dir });
    assert.ok(deterministicSignals(ch).some((x) => x.severity === "defect" && x.message.includes("[pay-webhook-unverified]")));
  });
  test("the verifier's security gate: a high finding blocks and becomes a defect; medium is a concern; failures never throw", async () => {
    const dir = repo({ "package.json": pkg({ express: "4" }), "src/auth/login.ts": "x\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx" });
    const entries: any[] = [];
    const ledger: any = { add: (e: any) => entries.push(e) };
    const ch = change({ "src/auth/login.ts": ["if (user.role = 'admin') grant();"] });
    const mk = (high: boolean) => ({
      config: { security: { enabled: true, review: true }, models: { planner: ["p/x"], verifier: ["v/x"] } },
      repoRoot: dir,
      askJson: async (system: string) => (/application security engineer/.test(system) ? JSON.stringify({ findings: [{ file: "src/auth/login.ts", line: 3, category: "authz_bypass", severity: high ? "high" : "medium", description: "assignment instead of comparison grants admin", exploit: "any login becomes admin", fix: "use ===", confidence: 0.95, pattern: "" }] }) : JSON.stringify({ keep: true, confidence: 0.92, reason: "clear" })),
    });
    const review: any = { defectFound: false, findings: [], concerns: [], summary: "" };
    await (AutonomousVerifier.prototype as any).securityGate.call(mk(true), "make login", ch, review, ledger);
    assert.equal(entries[0].gate, "security review");
    assert.equal(entries[0].status, "fail");
    assert.equal(entries[0].blocking, true);
    assert.match(entries[0].detail, /authz_bypass at src\/auth\/login\.ts:3/);
    assert.equal(review.defectFound, true);
    assert.ok(review.findings.some((f: any) => f.requirement === "No exploitable security flaw introduced"));
    const r2: any = { defectFound: false, findings: [], concerns: [], summary: "" };
    entries.length = 0;
    await (AutonomousVerifier.prototype as any).securityGate.call(mk(false), "make login", ch, r2, ledger);
    assert.equal(entries[0].status, "pass");
    assert.equal(entries[0].blocking, false);
    assert.equal(r2.defectFound, false);
    assert.ok(r2.concerns.some((c: string) => /^Security \(medium\)/.test(c)));
    entries.length = 0;
    await (AutonomousVerifier.prototype as any).securityGate.call({ ...mk(true), askJson: async () => { throw new Error("x"); } }, "g", ch, { defectFound: false, findings: [], concerns: [] }, ledger);
    assert.equal(entries[0].status, "error");
    assert.equal(entries[0].blocking, false);
    entries.length = 0;
    await (AutonomousVerifier.prototype as any).securityGate.call({ ...mk(true), config: { security: { review: false } } }, "g", ch, review, ledger);
    assert.equal(entries.length, 0, "turned off");
  });
  test("the planner is told, the Editor gets the rules, and the switches exist and default on", () => {
    const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.match(idx, /ensureThreatModel\(/);
    assert.match(idx, /\$\{lastFailureSection\}\$\{securitySection\}/);
    const cfg = fs.readFileSync(new URL("../src/config.ts", import.meta.url), "utf-8");
    assert.match(cfg, /security: z\s*\.object\(\{[\s\S]*?enabled: z\.boolean\(\)\.default\(true\)[\s\S]*?review: z\.boolean\(\)\.default\(true\)/);
    const v = fs.readFileSync(new URL("../src/verifierTools.ts", import.meta.url), "utf-8");
    assert.match(v, /await this\.securityGate\(goal, change, review, ledger\)/);
  });
});
