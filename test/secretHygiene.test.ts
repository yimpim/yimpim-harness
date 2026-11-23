/**
 * Secrets stay on this machine and stages agree on what is not the project. One list of secret files is used by every reader (the file tools, search results, the shared line reader, the git
 * searches); a narrow outbound pass replaces credential-shaped values before a request leaves; the walkers share one ignore list built from safety.blockedDirectories, keeping the native
 * android/ and ios/ trees out where a JS/TS stage would otherwise read them; and test/spec folders mean the same thing everywhere.
 */
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { redactMessages, scrubCredentials } from "../src/redact.js";
import { isSensitiveName, SENSITIVE_PATHSPECS, DEFAULT_BLOCKED_FILE_PATTERNS } from "../src/sensitivePaths.js";
import { SAFE, readRange, parseCodeRefs } from "../src/codeContext.js";
import { AgentTools } from "../src/agentTools.js";
import { ConfigSchema } from "../src/config.js";
import { resolveConfig } from "../src/settings.js";
import { OpenRouterClient } from "../src/openrouter.js";
import { ignoredDirs, setBlockedDirectories, DEFAULT_BLOCKED_DIRECTORIES, GENERATED_DIRS, NATIVE_TREES, TEST_OR_SPEC_DIR, inTestOrSpecDir } from "../src/projectPaths.js";
import { isTestPath, isScopeExemptPath } from "../src/focusTests.js";
import { classifyFile } from "../src/securityReview.js";

const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

// Built at run time so this file itself holds no credential-shaped literal.
const OR_KEY = "sk-or-" + "v1-" + "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const PROJ_KEY = "sk-proj-" + "Abc123_def456-GHI789jkl012";
const AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
const GH_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun", "-----END RSA PRIVATE KEY-----"].join("\n");

afterEach(() => setBlockedDirectories(undefined));

describe("outbound redaction", () => {
  test("each high-confidence prefix is replaced, and says what it was", () => {
    for (const [secret, label] of [[OR_KEY, "OpenRouter key"], [PROJ_KEY, "OpenAI project key"], [AWS_KEY, "AWS access key id"], [GH_TOKEN, "GitHub token"]] as const) {
      const r = scrubCredentials(`token is ${secret} ok`);
      assert.ok(!r.text.includes(secret), label);
      assert.match(r.text, new RegExp(`\\[REDACTED ${label}\\]`));
      assert.equal(r.hits[label], 1);
    }
  });
  test("a private key block is replaced whole, and a block cut short is replaced without eating the message after it", () => {
    const whole = scrubCredentials(`before\n${PEM}\nafter`);
    assert.ok(!whole.text.includes("MIIEow"));
    assert.match(whole.text, /^before\n\[REDACTED private key\]\nafter$/);
    const cut = scrubCredentials("before\n-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEeP\n\nThe rest of the message is not a key.");
    assert.ok(!cut.text.includes("MIIEow"));
    assert.match(cut.text, /The rest of the message is not a key\./);
  });
  test("ordinary text, short look-alikes and the words themselves are left alone", () => {
    for (const t of ["use sk-or- as the prefix", "AKIA is how AWS keys start", "ghp_ tokens", "-----BEGIN PRIVATE KEY----- is the header", "const key = process.env.OPENROUTER_API_KEY;", "AKIAshort"]) assert.equal(scrubCredentials(t).text, t, t);
  });
  test("redactMessages replaces in string and structured content, logs one [REDACT] line, and returns the same array when there is nothing to do", () => {
    const lines: string[] = [];
    const clean = [{ role: "user", content: "hello" }];
    assert.equal(redactMessages(clean, (l) => lines.push(l)), clean);
    assert.deepEqual(lines, []);
    const msgs = [
      { role: "user", content: `key ${OR_KEY}` },
      { role: "tool", content: [{ type: "text", text: `aws ${AWS_KEY} and ${GH_TOKEN}` }, { type: "image_url", image_url: { url: "data:x" } }] },
    ];
    const out = redactMessages(msgs, (l) => lines.push(l));
    assert.ok(!JSON.stringify(out).includes(OR_KEY) && !JSON.stringify(out).includes(AWS_KEY) && !JSON.stringify(out).includes(GH_TOKEN));
    assert.equal((out[1].content as any[])[1].image_url.url, "data:x");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[REDACT\] Replaced 1 OpenRouter key, 1 AWS access key id, 1 GitHub token/);
    assert.ok(msgs[0].content.includes(OR_KEY), "the caller's messages are not mutated");
  });
  test("the client scrubs the request it actually sends", async () => {
    const original = globalThis.fetch;
    let sent = "";
    (globalThis as any).fetch = async (_u: string, init: any) => {
      sent = String(init.body);
      return new Response("nope", { status: 400 });
    };
    const log = console.log;
    const logged: string[] = [];
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      await new OpenRouterClient("k").complete(["some/model"], [{ role: "user", content: `please use ${OR_KEY} and ${PEM}` }], { agent: "EDITOR" }).catch(() => {});
    } finally {
      console.log = log;
      (globalThis as any).fetch = original;
    }
    assert.ok(sent.length > 0);
    assert.ok(!sent.includes(OR_KEY) && !sent.includes("MIIEow"), "neither value is in the body that left");
    assert.ok(logged.some((l) => l.startsWith("[REDACT]")));
  });
});

describe("one list of secret files", () => {
  test("env files, keys, keystores, SSH keys and service-account JSON are secret, in any folder", () => {
    for (const f of [".env", ".env.local", ".env.production", "prod.env", "a/b/.env", "server.pem", "certs/tls.key", "release.jks", "app.keystore", "id_rsa", "id_ed25519", "AuthKey_X.p8", "service-account.json", "config/my-service-account-prod.json", "serviceAccountKey.json", "gcp-credentials.json", "credentials.json", "firebase-adminsdk-abc12.json", "KEY.PEM"]) assert.equal(isSensitiveName(f), true, f);
  });
  test("env templates and ordinary files are not", () => {
    for (const f of [".env.example", ".env.sample", "env.template", "package.json", "google-services.json", "src/keys.ts", "tsconfig.json", "service.ts", "README.md"]) assert.equal(isSensitiveName(f), false, f);
  });
  test("the default of safety.blockedFilePatterns is that list", () => {
    assert.deepEqual(ConfigSchema.parse({}).safety.blockedFilePatterns, DEFAULT_BLOCKED_FILE_PATTERNS);
  });
});

describe("every reader refuses them", () => {
  let root = "";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "secret-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@e.com");
    git("config", "user.name", "t");
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "certs"));
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const x = process.env.API_SECRET;\n");
    fs.writeFileSync(path.join(root, ".env"), "API_SECRET=hunter2\n");
    fs.writeFileSync(path.join(root, ".env.example"), "API_SECRET=\n");
    fs.writeFileSync(path.join(root, "certs/server.pem"), "API_SECRET pem body\n");
    fs.writeFileSync(path.join(root, "config/service-account.json"), '{"API_SECRET":"x"}\n');
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("search_code shows the ordinary file and never a secret file's line", async () => {
    const tools = new AgentTools(root, ConfigSchema.parse({}));
    const out = await tools.searchCode("API_SECRET");
    assert.match(out, /src\/a\.ts:1:/);
    assert.doesNotMatch(out, /hunter2|\.env:|server\.pem|service-account/);
  });
  test("read_file refuses a secret file and reads the template", async () => {
    const tools = new AgentTools(root, ConfigSchema.parse({}));
    await assert.rejects(() => tools.readFile(".env"), /ACCESS DENIED|sensitive|blocked/i);
    await assert.rejects(() => tools.readFile("certs/server.pem"), /ACCESS DENIED|sensitive|blocked/i);
    assert.match(await tools.readFile(".env.example"), /API_SECRET/);
  });
  test("the shared line reader and the citation parser skip them", () => {
    assert.equal(SAFE(".env"), false);
    assert.equal(SAFE("certs/server.pem"), false);
    assert.equal(SAFE("config/service-account.json"), false);
    assert.equal(SAFE("src/a.ts"), true);
    assert.equal(readRange(root, ".env"), undefined);
    assert.equal(readRange(root, "certs/server.pem"), undefined);
    assert.ok(readRange(root, "src/a.ts"));
    assert.deepEqual(parseCodeRefs("see .env:1 and certs/server.pem:3 and config/service-account.json:1"), []);
  });
  test("the git search pathspecs leave the secret files out and keep the rest (a real git grep)", () => {
    const grep = (...extra: string[]) => execFileSync("git", ["grep", "-n", "-I", "-F", "-e", "API_SECRET", "--", ".", ...extra], { cwd: root, encoding: "utf8" });
    const all = grep();
    assert.match(all, /hunter2/);
    const safe = grep(...SENSITIVE_PATHSPECS);
    assert.match(safe, /src\/a\.ts/);
    assert.doesNotMatch(safe, /hunter2|server\.pem|service-account|\.env:/);
  });
  test("the callers that search with git use the pathspecs", () => {
    for (const f of ["src/healEdits.ts", "src/repoTools.ts", "src/failureEvidence.ts"]) assert.match(src(f), /SENSITIVE_PATHSPECS/, f);
    assert.match(src("src/securityReview.ts"), /!isSensitiveName\(s\.file\)/, "a secret file's diff is never sent to the security reviewer");
  });
});

describe("one ignore list for every walker", () => {
  test("by default: the blocked directories and the generated ones, and nothing else", () => {
    const s = ignoredDirs();
    for (const d of [...DEFAULT_BLOCKED_DIRECTORIES, ...GENERATED_DIRS]) assert.equal(s.has(d), true, d);
    assert.equal(s.has("src"), false);
    assert.equal(s.has("android"), false, "the native trees are only skipped where a stage asks");
    assert.equal(ignoredDirs(NATIVE_TREES).has("android") && ignoredDirs(NATIVE_TREES).has("ios"), true);
  });
  test("the user's safety.blockedDirectories is what is skipped once the config is loaded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
    try {
      fs.writeFileSync(path.join(dir, "agent.config.yaml"), "safety:\n  blockedDirectories: [generated_stuff, node_modules]\n");
      // The real loader, with no personal global config underneath it.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
      const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        resolveConfig({ repoRoot: dir });
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        fs.rmSync(home, { recursive: true, force: true });
      }
      const s = ignoredDirs();
      assert.equal(s.has("generated_stuff"), true);
      assert.equal(s.has("dist"), false, "no longer blocked by the user's list");
      assert.equal(s.has("coverage"), true, "generated output is always skipped");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test("uiDesign, testSettle, memoryHealth and focusTests still leave out android/ and ios/; the walkers no longer carry their own lists", () => {
    for (const f of ["src/uiDesign.ts", "src/testSettle.ts", "src/memoryHealth.ts", "src/focusTests.ts"]) assert.match(src(f), /lazyIgnore\(NATIVE_TREES\)/, f);
    for (const f of ["src/securityStack.ts", "src/securityAudit.ts", "src/securityReview.ts", "src/failureDigest.ts"]) assert.match(src(f), /lazyIgnore\(/, f);
    for (const f of ["src/securityReview.ts", "src/failureDigest.ts", "src/testSettle.ts", "src/securityStack.ts"]) assert.doesNotMatch(src(f), /new Set\(\["node_modules"/, f);
  });
});

describe("test and spec folders mean the same thing everywhere", () => {
  test("tests/, __tests__/, e2e/ and specs/ are one list", () => {
    for (const p of ["tests/a.ts", "x/__tests__/a.ts", "e2e/login.ts", "specs/a.ts", "spec/a.ts", "pkg/specs/deep/a.ts"]) assert.equal(inTestOrSpecDir(p), true, p);
    for (const p of ["src/inspect/a.ts", "src/latest/a.ts", "specification.ts"]) assert.equal(inTestOrSpecDir(p), false, p);
    assert.equal(TEST_OR_SPEC_DIR, "__tests__|tests?|e2e|specs?");
  });
  test("the security stages treat a specs/ or e2e/ file as not production code, as they do tests/", () => {
    for (const f of ["tests/auth.ts", "specs/auth/login.ts", "e2e/auth/login.ts", "spec/auth/login.ts"]) assert.equal(classifyFile(f, "password"), "low", f);
    assert.equal(classifyFile("src/auth/login.ts", "password"), "high");
  });
  test("focus tests: e2e/ and specs/ are tests; e2e/ is exempt from the write budget and specs/ stays protected", () => {
    assert.equal(isTestPath("e2e/login.ts"), true);
    assert.equal(isTestPath("specs/a.ts"), true);
    assert.equal(isScopeExemptPath("e2e/login.ts"), true);
    assert.equal(isScopeExemptPath("tests/a.ts"), true);
    assert.equal(isScopeExemptPath("specs/other.ts"), false);
    assert.equal(isScopeExemptPath("reference/a.test.ts"), false);
  });
  test("existence, the security lint and review, and question scope read the shared list", () => {
    for (const f of ["src/existence.ts", "src/securityLint.ts", "src/securityReview.ts", "src/questionScope.ts"]) assert.match(src(f), /TEST_OR_SPEC_DIR/, f);
  });
});

describe("memory.summaryWordLimit and the removed memory.stateFile", () => {
  test("the repo-map summary is cut at the configured number of words (15 by default)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-"));
    try {
      const words = Array.from({ length: 30 }, (_, i) => `w${i + 1}`).join(" ");
      const read = () => JSON.parse(fs.readFileSync(path.join(dir, ".agent/repo_map.json"), "utf8"));
      await new AgentTools(dir, ConfigSchema.parse({})).registerComponent({ name: "A", path: "a.ts", summary: words });
      assert.equal(read().A.summary, words.split(" ").slice(0, 15).join(" ") + "...");
      await new AgentTools(dir, ConfigSchema.parse({ memory: { summaryWordLimit: 5 } })).registerComponent({ name: "B", path: "b.ts", summary: words });
      assert.equal(read().B.summary, "w1 w2 w3 w4 w5...");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test("the limit is bounded, and stateFile is gone from the schema (a config that sets it still loads)", () => {
    assert.equal(ConfigSchema.safeParse({ memory: { summaryWordLimit: 1 } }).success, false);
    assert.equal(ConfigSchema.safeParse({ memory: { summaryWordLimit: 500 } }).success, false);
    const parsed = ConfigSchema.parse({ memory: { stateFile: ".agent/other.json" } }) as any;
    assert.equal("stateFile" in parsed.memory, false);
  });
});
