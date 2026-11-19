/**
 * What ends a heal, and what deliberately does not.
 *
 * A heal ends when it is STUCK (the same failure comes back, or its lookups turn up nothing new twice in a row), never because it reached
 * a number: the number that suits one project is wrong for the next one. In particular a heal is never refused for changing "too much" of
 * a test, never cut off after a fixed count of lookups, and never stopped because the failing count did not drop (fixing one cause often
 * exposes the next, so the count can stay flat while the failure changes). What it changed is reported, not judged.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { healTests, changedLines } from "../src/testHeal.js";

let dir = "";
const FILE = "__tests__/x.test.ts";
const read = () => fs.readFileSync(path.join(dir, FILE), "utf8");
const body = (n: number) => Array.from({ length: n }, (_, i) => `it('case ${i}', () => { expect(${i}).toBe(${i}); });`).join("\n");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "healguard-"));
  fs.mkdirSync(path.join(dir, "__tests__"), { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), `// v0\n${body(120)}\n`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Fails until the file says FIXED. Each output carries the file's current marker, so a changed file gives a different failure. */
const runner = (failing: (marker: string) => number, tag = true) => async (root: string) => {
  const text = fs.readFileSync(path.join(root, FILE), "utf8");
  if (text.includes("FIXED")) return { ok: true, output: "PASS " + FILE };
  const marker = /\/\/ (v\d+)/.exec(text)?.[1] ?? "v0";
  const n = failing(marker);
  return { ok: false, output: `FAIL ${FILE}\n` + Array.from({ length: n }, (_, i) => `  ● case ${i}\n    Error: boom ${tag ? marker : ""}\n`).join("\n") };
};

const heal = (call: (m: { role: string; content: string }[]) => Promise<string>, run = runner(() => 5)) =>
  healTests({ repoRoot: dir, run, settle: false, call: async (messages) => call(messages) });

describe("counting what changed", () => {
  test("lines added plus lines removed, order ignored", () => {
    assert.equal(changedLines("a\nb\nc", "a\nb\nc"), 0);
    assert.equal(changedLines("a\nb\nc", "a\nB\nc"), 2);
    assert.equal(changedLines("a\nb", "a\nb\nc\nd"), 2);
    assert.equal(changedLines("a\nb\nc", "c\nb\na"), 0);
  });
});

describe("what it changed is reported, never judged", () => {
  test("a small change says how small", async () => {
    const r = await heal(async () => JSON.stringify({ verdict: "stale-test", reason: "mock updated", edits: [{ find: "// v0", replace: "// v0 FIXED" }] }));
    assert.equal(r.results[0].status, "healed");
    assert.match(r.results[0].note, /mock updated \(2 lines changed\)/);
  });
  test("a large change is not refused: it is done, and the report says how large, for the person to look at", async () => {
    const big = `// v1 FIXED\n${body(120)}\n${body(150).replace(/case/g, "extra")}\n`;
    const r = await heal(async () => JSON.stringify({ verdict: "stale-test", reason: "the whole API was renamed", test: big }));
    assert.equal(r.results[0].status, "healed");
    assert.match(r.results[0].note, /\(\d{3} lines changed\)/);
    assert.equal(read(), big);
  });
});

describe("a flat failure count is not a stall", () => {
  test("fixing one cause exposes the next: five failing, five failing, then fixed, and it carries on", async () => {
    let n = 0;
    const r = await heal(async () => {
      n++;
      const next = n < 3 ? `// v${n}` : "// v3 FIXED";
      return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: `// v${n - 1}`, replace: next }] });
    }); // 5 failing at every step but the last, each with a different message
    assert.equal(r.results[0].status, "healed");
    assert.equal(r.results[0].attempts, 3);
  });
});

describe("what does end it: the same failure coming back", () => {
  test("an attempt that changes nothing about the failure is put back, however small the change", async () => {
    const before = read();
    let n = 0;
    const r = await heal(
      async () => {
        n++;
        return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: `// v${n - 1}`, replace: `// v${n}` }] });
      },
      runner(() => 5, false), // the failure text does not change with the file
    );
    assert.equal(r.results[0].status, "unhealed");
    assert.match(r.results[0].note, /the same failure came back/);
    assert.equal(read(), before);
  });
});

describe("looking around: as long as it is useful", () => {
  test("it is not cut off at a number of rounds: twelve productive lookups, then a decision, heals it", async () => {
    let calls = 0;
    const r = await heal(async () => {
      calls++;
      if (calls <= 12) return JSON.stringify({ need: [{ search: `case ${calls}` }] });
      return JSON.stringify({ verdict: "stale-test", reason: "found it", edits: [{ find: "// v0", replace: "// v0 FIXED" }] });
    });
    assert.equal(r.results[0].status, "healed");
    assert.equal(calls, 13);
  });
  test("two lookups in a row that turn up nothing end it: nothing matched is nothing learned", async () => {
    let calls = 0;
    const r = await heal(async () => {
      calls++;
      return JSON.stringify({ need: [{ search: `zzz-not-there-${calls}` }] });
    });
    assert.equal(r.results[0].status, "unclear");
    assert.match(r.results[0].note, /its lookups turned up nothing new/);
    assert.equal(calls, 2);
  });
  test("one empty lookup is not the end: the next productive one resets it", async () => {
    let calls = 0;
    const r = await heal(async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ need: [{ search: "zzz-not-there" }] });
      if (calls === 2) return JSON.stringify({ need: [{ search: "case 5" }] });
      if (calls === 3) return JSON.stringify({ need: [{ search: "zzz-again-nothing" }] });
      return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "// v0", replace: "// v0 FIXED" }] });
    });
    assert.equal(r.results[0].status, "healed");
  });
  test("asking for the same thing twice is not answered twice", async () => {
    let calls = 0;
    const seen: string[] = [];
    await heal(async (messages) => {
      calls++;
      seen.push(messages[messages.length - 1].content);
      return calls < 3 ? JSON.stringify({ need: [{ search: "case 7" }] }) : JSON.stringify({ verdict: "unclear", reason: "decided" });
    });
    assert.match(seen[1], /--- search "case 7"/);
    assert.match(seen[2], /Nothing new turned up/);
  });
});

describe("the limits that were considered and refused", () => {
  const src = fs.readFileSync(new URL("../src/testHeal.ts", import.meta.url), "utf-8");
  test("there is no fixed count of lookups, no cap on how much may change, and no failing-count stall rule", () => {
    assert.doesNotMatch(src, /MAX_LOOKUPS|MIN_CHANGE_LIMIT|CHANGE_FRACTION|changeLimit|stalls|bestFailing/);
  });
});
