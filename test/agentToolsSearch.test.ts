/**
 * Regression tests for search_code's batched-pattern mode (searchCodeMulti).
 * Discovery routinely tries several near-variant patterns in a row (a naming
 * guess, a synonym, an abbreviation) — before this, each one cost a full tool
 * round, and every round resends the whole growing conversation, so that
 * shotgun exploration was the single biggest driver of Discovery's token
 * cost. This locks in that batching several patterns into one call returns
 * the same coverage as running them one at a time, just labeled and combined.
 *
 * It also locks in the pattern preprocessing that makes a model-written PCRE
 * pattern survivable through `grep -E` (POSIX ERE): a leading `(?i)` flag is
 * stripped and carried into `-i`, searching is case-insensitive by default
 * unless the caller opts into `caseSensitive: true`, and a pattern that is
 * still invalid ERE falls back to a `-F` fixed-string search rather than
 * returning a dead-end "repetition-operator error".
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTools, normalizeSearchPattern } from "../src/agentTools.js";
import { AgentConfig } from "../src/config.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-search-test-"));
  tempDirs.push(dir);
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: dir });
  await fs.writeFile(path.join(dir, "Chicken.kt"), "class Chicken {\n  val SPD = 1\n}\n");
  await fs.writeFile(path.join(dir, "Race.kt"), "class Race {\n  val STA = 2\n}\n");
  // Mixed-case symbol: only a case-insensitive search can find it from "tracker".
  await fs.writeFile(path.join(dir, "MixedCase.kt"), "class MixedCase {\n  val Tracker = 3\n}\n");
  // Literal text that is NOT a valid POSIX ERE (unmatched "("), so -E rejects
  // it and the -F fixed-string retry is the only way to find it.
  await fs.writeFile(path.join(dir, "Notes.kt"), "class Notes {\n  // TODO: fix chicken( in parser\n}\n");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("searchCodeMulti", () => {
  test("returns a labeled section per pattern, matching what single searchCode calls would each return", async () => {
    const dir = await makeTempRepo();
    const tools = new AgentTools(dir, {} as AgentConfig);

    const combined = await tools.searchCodeMulti(["SPD", "STA", "nonexistent_xyz"]);

    assert.match(combined, /=== "SPD" ===/);
    assert.match(combined, /Chicken\.kt.*SPD/);
    assert.match(combined, /=== "STA" ===/);
    assert.match(combined, /Race\.kt.*STA/);
    assert.match(combined, /=== "nonexistent_xyz" ===\nNo matches found\./);
  });

  test("caps at 8 patterns and reports the overflow instead of silently dropping the rest", async () => {
    const dir = await makeTempRepo();
    const tools = new AgentTools(dir, {} as AgentConfig);

    const patterns = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const combined = await tools.searchCodeMulti(patterns);

    assert.match(combined, /=== "p0" ===/);
    assert.match(combined, /=== "p7" ===/);
    assert.doesNotMatch(combined, /=== "p8" ===/);
    assert.match(combined, /2 more pattern\(s\) were not run — batch capped at 8 per call\./);
  });

  test("a batched search covers the same ground as the equivalent single-pattern calls", async () => {
    const dir = await makeTempRepo();
    const tools = new AgentTools(dir, {} as AgentConfig);

    const [single1, single2] = await Promise.all([tools.searchCode("SPD"), tools.searchCode("STA")]);
    const combined = await tools.searchCodeMulti(["SPD", "STA"]);

    assert.match(combined, new RegExp(single1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(combined, new RegExp(single2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("normalizeSearchPattern", () => {
  test("strips a leading (?i) flag group and turns it into case-insensitivity", () => {
    assert.deepEqual(normalizeSearchPattern("(?i)spd", true), { pattern: "spd", caseSensitive: false });
  });

  test("strips a leading (?-i) flag group and turns it into case-sensitivity", () => {
    assert.deepEqual(normalizeSearchPattern("(?-i)SPD", false), { pattern: "SPD", caseSensitive: true });
  });

  test("leaves patterns without an inline flag group untouched", () => {
    assert.deepEqual(normalizeSearchPattern("val SPD", false), { pattern: "val SPD", caseSensitive: false });
    assert.deepEqual(normalizeSearchPattern("val SPD", true), { pattern: "val SPD", caseSensitive: true });
  });

  test("a pattern that is nothing but flags is kept as-is instead of becoming an empty grep argument", () => {
    assert.deepEqual(normalizeSearchPattern("(?i)", false), { pattern: "(?i)", caseSensitive: false });
  });
});

describe("searchCode pattern preprocessing and fallback", () => {
  test("a (?i)-prefixed pattern is stripped and matched case-insensitively without a syntax error", async () => {
    const dir = await makeTempRepo();
    const tools = new AgentTools(dir, {} as AgentConfig);

    // `grep -E` rejects `(?i)` with a "repetition-operator error"; the flag is
    // stripped and carried into `-i` instead, so the lowercase pattern still
    // finds the uppercase `val SPD = 1`.
    const result = await tools.searchCode("(?i)spd");

    assert.match(result, /Chicken\.kt.*SPD/);
    assert.doesNotMatch(result, /repetition-operator/);
    assert.doesNotMatch(result, /Search could not be completed/);
  });

  test("search is case-insensitive by default and honours caseSensitive: true", async () => {
    const dir = await makeTempRepo();
    const tools = new AgentTools(dir, {} as AgentConfig);

    // Default: lowercase pattern finds the mixed-case `val Tracker = 3`.
    const insensitive = await tools.searchCode("tracker");
    assert.match(insensitive, /MixedCase\.kt.*Tracker/);

    // Explicit opt-in to exact case finds nothing.
    const sensitive = await tools.searchCode("tracker", undefined, true);
    assert.equal(sensitive, "No matches found.");

    // An explicit (?i) overrides an outer caseSensitive: true.
    const overridden = await tools.searchCode("(?i)tracker", undefined, true);
    assert.match(overridden, /MixedCase\.kt.*Tracker/);
  });

  test("an invalid ERE pattern falls back to a fixed-string -F search instead of failing", async () => {
    const dir = await makeTempRepo();
    const tools = new AgentTools(dir, {} as AgentConfig);

    // Unmatched "(" is a syntax error under -E, but the text exists literally.
    const result = await tools.searchCode("chicken(");

    assert.match(result, /Notes\.kt.*chicken\(/);
    assert.doesNotMatch(result, /Search could not be completed/);
  });

  test("an invalid ERE pattern that also has no literal match reports no matches rather than an error", async () => {
    const dir = await makeTempRepo();
    const tools = new AgentTools(dir, {} as AgentConfig);

    const result = await tools.searchCode("nonexistent_xyz(");

    assert.equal(result, "No matches found.");
  });
});
