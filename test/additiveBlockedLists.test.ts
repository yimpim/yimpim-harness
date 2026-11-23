/**
 * safety.blockedDirectories and safety.blockedFilePatterns can be added to but never shortened: a person's entries are unioned with the
 * built-in ones. The stale agent.config.yaml this repo used to ship (7 file patterns where the built-in list has 17) is the case this exists for.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSchema } from "../src/config.js";
import { resolveConfig, writeSetting } from "../src/settings.js";
import { compileBlockedPatterns, isSensitiveName, DEFAULT_BLOCKED_FILE_PATTERNS } from "../src/sensitivePaths.js";
import { DEFAULT_BLOCKED_DIRECTORIES } from "../src/projectPaths.js";

const parse = (safety: Record<string, unknown>) => ConfigSchema.parse({ safety }).safety;

/** The file patterns the repo's old agent.config.yaml carried: 7 of the built-in 17. */
const STALE_PATTERNS = ["*.keystore", "*.jks", "*.p12", "*.pem", "*.key", ".env", "*.env.*"];

/** resolveConfig with a project file and no personal global file underneath it. */
function resolveWith(projectYaml: string, overrides: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-additive-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-additive-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fs.writeFileSync(path.join(dir, "agent.config.yaml"), projectYaml);
    return resolveConfig({ repoRoot: dir, overrides }).config.safety;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("a custom list extends the built-in one", () => {
  test("with nothing set, both lists are exactly the built-in ones", () => {
    const s = parse({});
    assert.deepEqual(s.blockedFilePatterns, DEFAULT_BLOCKED_FILE_PATTERNS);
    assert.deepEqual(s.blockedDirectories, DEFAULT_BLOCKED_DIRECTORIES);
  });

  test("custom file patterns are added, and every built-in pattern is still there", () => {
    const s = parse({ blockedFilePatterns: ["*.secret", "vault.json"] });
    for (const p of DEFAULT_BLOCKED_FILE_PATTERNS) assert.ok(s.blockedFilePatterns.includes(p), `built-in ${p} kept`);
    assert.ok(s.blockedFilePatterns.includes("*.secret") && s.blockedFilePatterns.includes("vault.json"));
    assert.equal(s.blockedFilePatterns.length, DEFAULT_BLOCKED_FILE_PATTERNS.length + 2);
  });

  test("custom directories are added, and every built-in directory is still there", () => {
    const s = parse({ blockedDirectories: ["generated_stuff"] });
    for (const d of DEFAULT_BLOCKED_DIRECTORIES) assert.ok(s.blockedDirectories.includes(d), `built-in ${d} kept`);
    assert.ok(s.blockedDirectories.includes("generated_stuff"));
  });

  test("the built-in entries come first, then the person's, in the order they wrote them", () => {
    const s = parse({ blockedDirectories: ["zzz", "aaa"] });
    assert.deepEqual(s.blockedDirectories, [...DEFAULT_BLOCKED_DIRECTORIES, "zzz", "aaa"]);
  });

  test("an entry that is already built in, or listed twice, appears once", () => {
    const s = parse({ blockedFilePatterns: [".env", "*.pem", "*.mine", "*.mine"], blockedDirectories: ["node_modules", "x", "x"] });
    assert.equal(s.blockedFilePatterns.filter((p) => p === ".env").length, 1);
    assert.equal(s.blockedFilePatterns.filter((p) => p === "*.mine").length, 1);
    assert.equal(s.blockedDirectories.filter((d) => d === "node_modules").length, 1);
    assert.equal(s.blockedDirectories.filter((d) => d === "x").length, 1);
  });
});

describe("a shorter list can never weaken the built-in one", () => {
  test("the stale 7-pattern list from the repo's old config still blocks all 17 built-in patterns", () => {
    assert.equal(STALE_PATTERNS.length, 7);
    const s = parse({ blockedFilePatterns: STALE_PATTERNS });
    assert.equal(s.blockedFilePatterns.length, DEFAULT_BLOCKED_FILE_PATTERNS.length);
    const compiled = compileBlockedPatterns(s.blockedFilePatterns);
    for (const secret of ["server.pfx", "AuthKey.p8", "prod.env", "id_rsa", "id_ed25519", "my-service-account.json", "credentials.json", "firebase-adminsdk-abc.json"]) {
      assert.equal(isSensitiveName(secret, compiled), true, `${secret} stays blocked`);
    }
  });

  test("an empty list is the built-in list", () => {
    const s = parse({ blockedFilePatterns: [], blockedDirectories: [] });
    assert.deepEqual(s.blockedFilePatterns, DEFAULT_BLOCKED_FILE_PATTERNS);
    assert.deepEqual(s.blockedDirectories, DEFAULT_BLOCKED_DIRECTORIES);
  });

  test("a list without the built-in directories still blocks them", () => {
    const s = parse({ blockedDirectories: [".wrangler"] });
    for (const d of [".git", "node_modules", "dist", "build", ".gradle", ".agent"]) assert.ok(s.blockedDirectories.includes(d), d);
  });
});

describe("it holds on every path a setting can arrive by", () => {
  test("a project file", () => {
    const s = resolveWith("safety:\n  blockedFilePatterns: [\"*.pem\", \"*.mine\"]\n  blockedDirectories: [custom_out]\n");
    assert.ok(s.blockedFilePatterns.includes("*.mine") && s.blockedFilePatterns.includes("id_rsa"));
    assert.ok(s.blockedDirectories.includes("custom_out") && s.blockedDirectories.includes("node_modules"));
  });

  test("--set, which replaces the file's list with a shorter one but not the built-in entries", () => {
    const s = resolveWith("safety:\n  blockedFilePatterns: [\"*.mine\"]\n", ["safety.blockedFilePatterns=*.other"]);
    assert.ok(s.blockedFilePatterns.includes("*.other"));
    assert.ok(!s.blockedFilePatterns.includes("*.mine"), "--set overrides the file's own entries, as for any setting");
    assert.ok(s.blockedFilePatterns.includes("id_rsa"), "but never the built-in ones");
  });

  test("config set writes only the person's entries, and what is used is the union", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-additive-set-"));
    const file = path.join(dir, "agent.config.yaml");
    try {
      writeSetting(file, "safety.blockedDirectories", ["scratch"]);
      assert.match(fs.readFileSync(file, "utf8"), /scratch/);
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /node_modules/, "the built-in list is not copied into the file");
      assert.ok(ConfigSchema.parse(JSON.parse(JSON.stringify({ safety: { blockedDirectories: ["scratch"] } }))).safety.blockedDirectories.includes("node_modules"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the settings list says so", () => {
    const text = fs.readFileSync("src/settings.ts", "utf8");
    assert.match(text, /Your entries are added to the built-in list[^"]*a built-in entry cannot be removed/);
  });
});
