/**
 * Memory is checked against the disk it describes, and test failures that have
 * nothing to do with a phase's change are recognised instead of repaired.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractPathTokens, findBlockedDirClaim, reconcileMemoryWithDisk } from "../src/memoryHealth.js";
import { failuresUnrelatedToChange } from "../src/repairPolicy.js";
import { DISCOVERY_SYSTEM } from "../src/prompts.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function repo(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-mem-"));
  dirs.push(dir);
  for (const [rel, c] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, c);
  }
  return dir;
}
const mem = (extra: Partial<Record<"architectureRules" | "liveRules" | "historicalPitfalls", string[]>> = {}) => ({
  architectureRules: [] as string[],
  liveRules: [] as string[],
  historicalPitfalls: [] as string[],
  ...extra,
});

// The real entry that sent the Planner chasing tests nobody could read (trimmed).
const BLOCKED_ENTRY =
  "__tests__/ (including __tests__/e2e/) is a BLOCKED directory in this environment: list_files, read_file and " +
  "path-scoped search_code all fail with ENOENT/'No matches found' against it. Only agent-log text " +
  "(docs/remote_history/*.jsonl) describes its contents — including a __tests__/timeline.test.ts with describe('Timeline').";

describe("path extraction", () => {
  test("finds repo-relative files and folders, ignoring URLs, globs, absolute paths and noise", () => {
    const t =
      "See `src/models/timeline.ts:1085`, __tests__/e2e/harness.ts and the app/ folder; not https://x.io/a/b.ts, " +
      "docs/*.md, /etc/hosts, ../up/file.ts, and ENOENT/'No matches' or and/or.";
    assert.deepEqual(extractPathTokens(t), ["src/models/timeline.ts", "__tests__/e2e/harness.ts", "app/"]);
  });

  test("generated output folders are never judged", () => {
    assert.deepEqual(extractPathTokens("built into dist/app.js and .expo/dev/logs/export.log, node_modules/x/y.js"), []);
  });

  test("finds a 'blocked directory' claim and the directory it is about", () => {
    assert.equal(findBlockedDirClaim(BLOCKED_ENTRY), "__tests__");
    assert.equal(findBlockedDirClaim("src/secret is inaccessible to agents"), "src/secret");
    assert.equal(findBlockedDirClaim("The router is configured in app/_layout.tsx"), undefined);
  });
});

describe("a 'blocked' claim is checked against the disk", () => {
  test("a folder that is merely missing is rewritten as missing, not blocked", () => {
    const r = repo({ "src/a.ts": "x" });
    const m = mem({ architectureRules: [BLOCKED_ENTRY] });
    const stats = reconcileMemoryWithDisk(m, r);
    assert.equal(stats.rewrittenMissing, 1);
    assert.match(m.architectureRules[0], /^\[STALE — recorded as blocked, but the folder is simply missing\]/);
    assert.match(m.architectureRules[0], /__tests__\/ does not exist/);
    assert.match(m.architectureRules[0], /NOT on the harness's block list/);
    assert.doesNotMatch(m.architectureRules[0], /timeline\.test/, "the stale contents are gone, not repeated");
  });

  test("a folder that exists, is readable and is not blocked has the claim dropped", () => {
    const r = repo({ "__tests__/a.test.ts": "x", "app/index.ts": "x" });
    const m = mem({ architectureRules: [BLOCKED_ENTRY, "Keep screens in app/."] });
    const stats = reconcileMemoryWithDisk(m, r);
    assert.equal(stats.droppedContradicted, 1);
    assert.deepEqual(m.architectureRules, ["Keep screens in app/."]);
  });

  test("a folder that really is on the block list keeps its claim", () => {
    const r = repo({ "dist/x.js": "x" });
    const claim = "dist/ is a blocked directory and may not be read.";
    const m = mem({ liveRules: [claim] });
    reconcileMemoryWithDisk(m, r, ["dist"]);
    assert.deepEqual(m.liveRules, [claim]);
  });
});

describe("entries naming files that are gone are marked stale", () => {
  test("every named file gone -> the whole entry is marked, with what is missing", () => {
    const r = repo({ "src/a.ts": "x" });
    const m = mem({ architectureRules: ["__tests__/timeline.test.ts loads reference/fixture.jsonl"] });
    const stats = reconcileMemoryWithDisk(m, r);
    assert.equal(stats.staleMarked, 1);
    assert.match(m.architectureRules[0], /^\[STALE — no longer on disk: __tests__\/timeline\.test\.ts, reference\/fixture\.jsonl; was true earlier, verify before relying on it\]/);
    assert.match(m.architectureRules[0], /timeline\.test\.ts loads/);
  });

  test("only some files gone -> the entry stays, annotated with which", () => {
    const r = repo({ "src/a.ts": "x" });
    const m = mem({ liveRules: ["src/a.ts calls src/old.ts for parsing"] });
    reconcileMemoryWithDisk(m, r);
    assert.equal(m.liveRules[0], "src/a.ts calls src/old.ts for parsing (no longer on disk: src/old.ts)");
  });

  test("an entry whose files all exist, or that names none, is untouched", () => {
    const r = repo({ "src/a.ts": "x" });
    const m = mem({ historicalPitfalls: ["src/a.ts must stay pure", "Never block the main thread"] });
    const stats = reconcileMemoryWithDisk(m, r);
    assert.deepEqual(m.historicalPitfalls, ["src/a.ts must stay pure", "Never block the main thread"]);
    assert.equal(stats.staleMarked, 0);
  });

  test("it is idempotent, and the mark disappears when the files come back", () => {
    const r = repo({ "src/a.ts": "x" });
    const m = mem({ liveRules: ["__tests__/x.test.ts covers it", "src/a.ts calls src/old.ts"] });
    reconcileMemoryWithDisk(m, r);
    const once = JSON.stringify(m);
    reconcileMemoryWithDisk(m, r);
    assert.equal(JSON.stringify(m), once);

    fs.mkdirSync(path.join(r, "__tests__"));
    fs.writeFileSync(path.join(r, "__tests__/x.test.ts"), "x");
    fs.writeFileSync(path.join(r, "src/old.ts"), "x");
    reconcileMemoryWithDisk(m, r);
    assert.deepEqual(m.liveRules, ["__tests__/x.test.ts covers it", "src/a.ts calls src/old.ts"]);
  });
});

describe("not everything slash-shaped in a note is a stale path", () => {
  test("an abbreviated path that is the tail of a real one is present", () => {
    const r = repo({ "reference/android-ui/dashboard/DashboardPhaseModels.kt": "x", "reference/android-ui/theme/Color.kt": "x" });
    const m = mem({ liveRules: ["Ported from dashboard/DashboardPhaseModels.kt and theme/Color.kt"] });
    reconcileMemoryWithDisk(m, r);
    assert.deepEqual(m.liveRules, ["Ported from dashboard/DashboardPhaseModels.kt and theme/Color.kt"]);
  });

  test("prose joined with slashes is not mistaken for a file", () => {
    const r = repo({ "src/a.ts": "x" });
    const m = mem({ architectureRules: ["No native Gradle/manifest/MainApplication.kt edits"] });
    reconcileMemoryWithDisk(m, r);
    assert.deepEqual(m.architectureRules, ["No native Gradle/manifest/MainApplication.kt edits"]);
  });

  test("a capitalised top-level folder that really exists is still checked", () => {
    const r = repo({ "Sources/a.swift": "x" });
    const m = mem({ liveRules: ["Entry is Sources/a.swift and Sources/gone.swift"] });
    reconcileMemoryWithDisk(m, r);
    assert.match(m.liveRules[0], /\(no longer on disk: Sources\/gone\.swift\)/);
  });

  test("a file that is truly gone is still marked even though the folder exists", () => {
    const r = repo({ "__tests__/keep.test.ts": "x" });
    const m = mem({ liveRules: ["__tests__/old.test.ts pins the contract"] });
    reconcileMemoryWithDisk(m, r);
    assert.match(m.liveRules[0], /^\[STALE — no longer on disk: __tests__\/old\.test\.ts/);
  });
});

describe("Discovery is told fresh evidence beats memory", () => {
  test("the prompt carries the rule and the exact condition for calling something blocked", () => {
    assert.match(DISCOVERY_SYSTEM, /FRESH EVIDENCE BEATS MEMORY/);
    assert.match(DISCOVERY_SYSTEM, /\[ACCESS DENIED\] \.\.\. is a blocked directory/);
    assert.match(DISCOVERY_SYSTEM, /ENOENT means the path\s+is MISSING or empty/);
  });
});

describe("failuresUnrelatedToChange", () => {
  const testFailure = (detail: string) => [{ tier: "build", gate: "npm run test", detail }];
  const JEST_OUTPUT =
    "FAIL __tests__/archiveHistory.test.ts\n  at Object.toEqual (__tests__/archiveHistory.test.ts:121:65)\n" +
    "  at warn (src/storage/history.ts:110:13)\nTest Suites: 20 failed, 2 passed";

  test("a red suite that never mentions the changed file is unrelated", () => {
    const v = failuresUnrelatedToChange(testFailure(JEST_OUTPUT), ["src/models/timeline.ts"]);
    assert.equal(v.unrelated, true);
    assert.match(v.summary, /src\/models\/timeline\.ts/);
  });

  test("a stack that passes through the changed file, by path or by name, is related", () => {
    assert.equal(failuresUnrelatedToChange(testFailure(`${JEST_OUTPUT}\n at reduce (src/models/timeline.ts:88:3)`), ["src/models/timeline.ts"]).unrelated, false);
    assert.equal(failuresUnrelatedToChange(testFailure(`${JEST_OUTPUT}\nFAIL __tests__/timeline.test.ts`), ["src/models/timeline.ts"]).unrelated, false);
    assert.equal(failuresUnrelatedToChange(testFailure(JEST_OUTPUT.replace(/\//g, "\\")), ["src\\storage\\history.ts"]).unrelated, false);
  });

  test("anything that is not purely a test-run failure is never called unrelated", () => {
    const mixed = [...testFailure(JEST_OUTPUT), { tier: "build", gate: "tsc typecheck", detail: "error TS2304: Cannot find name 'x'" }];
    assert.equal(failuresUnrelatedToChange(mixed, ["src/models/timeline.ts"]).unrelated, false);
    assert.equal(failuresUnrelatedToChange([{ tier: "visual", gate: "web visual QA", detail: JEST_OUTPUT }], ["src/a.ts"]).unrelated, false);
  });

  test("no changed files, no failure text, or a very short file name all fall back to 'related'", () => {
    assert.equal(failuresUnrelatedToChange(testFailure(JEST_OUTPUT), []).unrelated, false);
    assert.equal(failuresUnrelatedToChange(testFailure("   "), ["src/a.ts"]).unrelated, false);
    assert.equal(failuresUnrelatedToChange(undefined, ["src/a.ts"]).unrelated, false);
    assert.equal(failuresUnrelatedToChange(testFailure(JEST_OUTPUT), ["src/x.ts"]).unrelated, false);
  });

  test("a changed file whose name is a whole word in the output counts, but only as a whole word", () => {
    assert.equal(failuresUnrelatedToChange(testFailure("FAIL history suite"), ["src/history.ts"]).unrelated, false);
    assert.equal(failuresUnrelatedToChange(testFailure("FAIL prehistoric suite"), ["src/history.ts"]).unrelated, true);
  });
});
