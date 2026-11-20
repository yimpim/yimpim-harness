/**
 * A deviation is a test changed to follow the WORKING app where it differs from the spec in a cosmetic way. It is the riskiest change a heal makes, so
 * nothing is taken on trust: evidence that exists in the project, no assertion removed or weakened, a cap on the tests touched, and one follow-up
 * ticket per app file and spec place however often it is found.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseRef,
  refsIn,
  validateDeviation,
  deviationKey,
  deviationTitle,
  describeDeviation,
  deviationGutting,
  testsModified,
  emitDeviationUnits,
  DEFAULT_DEVIATION_TEST_CAP,
  type DeviationRecord,
} from "../src/healDeviation.js";
import { saveRoadmap, loadRoadmap } from "../src/roadmap.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let root = "";
const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "__tests__"));
  fs.writeFileSync(path.join(root, "src/Card.tsx"), lines(40));
  fs.writeFileSync(path.join(root, "docs/SPEC.md"), "# Spec\n\nSome intro.\n\nThe two choice buttons are labelled Yes and No and send the desktop's own style.\n\nMore text.\n");
  fs.writeFileSync(path.join(root, "__tests__/a.test.ts"), "test('a', () => {});\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const rec = (over: Partial<DeviationRecord> = {}): DeviationRecord => ({ appFile: "src/Card.tsx", appLine: 12, specFile: "docs/SPEC.md", specLine: 5, summary: "The spec labels the buttons Yes/No; the app shows yes/no.", ...over });

describe("references", () => {
  test("path:line, with a range or a Windows slash", () => {
    assert.deepEqual(parseRef("src/Card.tsx:12"), { file: "src/Card.tsx", line: 12 });
    assert.deepEqual(parseRef("src\\Card.tsx:12-30"), { file: "src/Card.tsx", line: 12 });
    assert.equal(parseRef("src/Card.tsx"), undefined);
    assert.equal(parseRef("just some words"), undefined);
  });
  test("every path:line in some text, for handing on as places to check", () => {
    assert.deepEqual(refsIn("src/Card.tsx:1247 renders yes; docs/PHONE_SPEC.md:461 says Yes. See also http://x.io:8080/a and v1.2:3"), ["src/Card.tsx:1247", "docs/PHONE_SPEC.md:461"]);
    assert.deepEqual(refsIn("no places here"), []);
  });
});

describe("validateDeviation: evidence that exists", () => {
  test("a real app file:line and a real spec file:line are accepted", () => {
    const c = validateDeviation(root, { app: "src/Card.tsx:12", spec: "docs/SPEC.md:5", summary: "The spec labels them Yes/No; the app shows yes/no." });
    assert.ok(c.ok);
    if (c.ok) assert.deepEqual(c.rec, { appFile: "src/Card.tsx", appLine: 12, specFile: "docs/SPEC.md", specLine: 5, summary: "The spec labels them Yes/No; the app shows yes/no." });
  });
  test("the app side: not a path:line, a file that is not there, a line past its end, a test file", () => {
    const why = (app: string) => {
      const c = validateDeviation(root, { app, spec: "docs/SPEC.md:5", summary: "A real summary here." });
      assert.equal(c.ok, false, app);
      return c.ok ? "" : c.why;
    };
    assert.match(why("somewhere in the card"), /app: give the app's code as path:line/);
    assert.match(why("src/Nope.tsx:3"), /app: src\/Nope\.tsx does not exist/);
    assert.match(why("src/Card.tsx:999"), /app: src\/Card\.tsx has 40 lines, so line 999 does not exist/);
    assert.match(why("src/Card.tsx:0"), /does not exist/);
    assert.match(why("__tests__/a.test.ts:1"), /is a test file/);
    assert.match(why("../outside.ts:1"), /does not exist/);
  });
  test("the spec side: a file that is not there, a line past its end, a test file, the same place as the app", () => {
    const why = (spec: string, app = "src/Card.tsx:12") => {
      const c = validateDeviation(root, { app, spec, summary: "A real summary here." });
      assert.equal(c.ok, false, spec);
      return c.ok ? "" : c.why;
    };
    assert.match(why("docs/Nope.md:3"), /spec: docs\/Nope\.md does not exist/);
    assert.match(why("docs/SPEC.md:500"), /spec: docs\/SPEC\.md has \d+ lines/);
    assert.match(why("__tests__/a.test.ts:1"), /is a test file, which is not a spec/);
    assert.match(why("src/Card.tsx:12"), /same line/);
    assert.match(why("a vague idea"), /give the spec's place as path:line/);
  });
  test("the spec as its own words must really be in a document of the project, and then it gets a file and a line", () => {
    const c = validateDeviation(root, { app: "src/Card.tsx:12", spec: "The two choice buttons are labelled Yes and No and send the desktop's own style", summary: "Labels differ in case." });
    assert.ok(c.ok);
    if (c.ok) assert.deepEqual([c.rec.specFile, c.rec.specLine], ["docs/SPEC.md", 5]);
    const invented = validateDeviation(root, { app: "src/Card.tsx:12", spec: "The buttons must always glow in the dark on Tuesdays", summary: "Labels differ in case." });
    assert.equal(invented.ok, false, "words that are in no document are not evidence");
  });
  test("a summary is required: what the spec says and what the app does", () => {
    const c = validateDeviation(root, { app: "src/Card.tsx:12", spec: "docs/SPEC.md:5", summary: "diff" });
    assert.equal(c.ok, false);
  });
});

describe("what identifies one deviation", () => {
  test("the app file and the spec place: another line of the same app file for the same spec is the same deviation; a different spec place is not", () => {
    assert.equal(deviationKey(rec()), deviationKey(rec({ appLine: 99, summary: "worded differently" })));
    assert.notEqual(deviationKey(rec()), deviationKey(rec({ specLine: 6 })));
    assert.notEqual(deviationKey(rec()), deviationKey(rec({ appFile: "src/Other.tsx" })));
    assert.equal(deviationKey(rec({ appFile: "SRC/CARD.TSX" })), deviationKey(rec()), "case does not matter");
  });
  test("the ticket title follows the key alone, so the same deviation is always the same title", () => {
    assert.equal(deviationTitle(rec()), deviationTitle(rec({ appLine: 7, summary: "x".repeat(40) })));
    assert.notEqual(deviationTitle(rec()), deviationTitle(rec({ specLine: 6 })));
    assert.match(deviationTitle(rec()), /^Match the spec: Card\.tsx vs SPEC\.md:5 \[[0-9a-f]{6}\]$/);
  });
  test("it is described with both places", () => {
    assert.equal(describeDeviation(rec()), "app src/Card.tsx:12 vs spec docs/SPEC.md:5: The spec labels the buttons Yes/No; the app shows yes/no.");
  });
});

describe("deviationGutting: a test must not pass by losing its checks", () => {
  const body = (expects: string[]) => ["test('a', () => {", ...expects.map((e) => `  ${e}`), "});", ""].join("\n");
  const many = (n: number) => Array.from({ length: n }, (_, i) => `expect(v${i}).toBe(${i});`);
  test("changing what is expected is fine", () => {
    assert.equal(deviationGutting(body(many(5)), body(many(5)).replace("toBe(2)", "toBe('Yes')")), undefined);
  });
  test("removing an expect(...) is refused, even by one", () => {
    const after = body(many(5).slice(1));
    assert.match(deviationGutting(body(many(5)), after) ?? "", /4 expect\(\.\.\.\) calls where there were 5/);
  });
  test("an assertion line replaced by another is fine", () => {
    const before = body(many(5));
    assert.equal(deviationGutting(before, before.replace("expect(v1).toBe(1);", "expect(label(v1)).toBe('Yes');")), undefined);
    assert.equal(deviationGutting(before, before.replace("  expect(v1).toBe(1);\n", "").replace("});", "  expect(v9).toBe(9);\n});")), undefined, "one out, one in");
  });
  test("two assertion lines folded into one line keep the count but lose a check's line: refused", () => {
    const before = body(many(5));
    const merged = before.replace("  expect(v1).toBe(1);\n  expect(v2).toBe(2);\n", "  expect(v1).toBe(1); expect(v2).toBe(2); expect(v8).toBe(8);\n");
    assert.match(deviationGutting(before, merged) ?? "", /removes 1 assertion line without replacing it/);
  });
  test("a specific assertion turned into one that cannot fail is refused", () => {
    const before = body(many(5));
    assert.match(deviationGutting(before, before.replace("expect(v2).toBe(2);", "expect(v2).toBeDefined();")) ?? "", /cannot fail/);
  });
  test("more assertions than before is fine", () => {
    assert.equal(deviationGutting(body(many(3)), body(many(4))), undefined);
  });
});

describe("testsModified: how many tests a change touches", () => {
  const file = (bodies: string[], setup = "const x = 1;") => [setup, ...bodies.map((b, i) => `test('t${i + 1}', () => {\n  ${b}\n});`), ""].join("\n");
  test("only the tests whose text differs", () => {
    const a = file(["a", "b", "c", "d"]);
    assert.equal(testsModified(a, a), 0);
    assert.equal(testsModified(a, file(["a", "B", "c", "d"])), 1);
    assert.equal(testsModified(a, file(["A", "B", "c", "d"])), 2);
  });
  test("a changed setup above the tests is one more; a test added or removed counts", () => {
    const a = file(["a", "b"]);
    assert.equal(testsModified(a, file(["a", "b"], "const x = 2;")), 1);
    assert.equal(testsModified(a, file(["a", "b", "c"])), 1);
    assert.equal(testsModified(a, file(["a"])), 1);
  });
  test("the cap's default is 12", () => assert.equal(DEFAULT_DEVIATION_TEST_CAP, 12));
});

describe("emitDeviationUnits: one follow-up ticket per app file and spec place", () => {
  const roadmap = () =>
    saveRoadmap(root, { version: 1, goal: "g", kind: "idea", conventions: [], units: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);

  test("no roadmap: nothing is written, nothing fails", () => {
    assert.deepEqual(emitDeviationUnits(root, [rec()]), []);
    assert.equal(loadRoadmap(root), undefined);
  });
  test("a ticket is added with the spec's own line as the acceptance criterion", () => {
    roadmap();
    const out = emitDeviationUnits(root, [rec()]);
    assert.match(out[0], /follow-up ticket added: Match the spec: Card\.tsx vs SPEC\.md:5/);
    const rm = loadRoadmap(root)!;
    assert.equal(rm.units.length, 1);
    const u = rm.units[0];
    assert.equal(u.area, "Spec deviations");
    assert.equal(u.status, "todo");
    assert.match(u.acceptance[0], /docs\/SPEC\.md:5 holds: "The two choice buttons are labelled Yes and No/);
    assert.match(u.acceptance[1], /change the test back/);
    assert.deepEqual(u.refs, ["src/Card.tsx", "docs/SPEC.md"]);
  });
  test("the same deviation found again (another run) is not a second ticket", () => {
    roadmap();
    emitDeviationUnits(root, [rec()]);
    const again = emitDeviationUnits(root, [rec({ appLine: 30, summary: "worded in another way entirely" })]);
    assert.match(again[0], /already tracked as U001/);
    assert.equal(loadRoadmap(root)!.units.length, 1);
  });
  test("several tests in one file reporting the same deviation in one batch add one ticket", () => {
    roadmap();
    emitDeviationUnits(root, [rec(), rec({ appLine: 13 }), rec({ appLine: 14 })]);
    assert.equal(loadRoadmap(root)!.units.length, 1);
  });
  test("a different spec place is its own ticket", () => {
    roadmap();
    emitDeviationUnits(root, [rec(), rec({ specLine: 3 })]);
    assert.equal(loadRoadmap(root)!.units.length, 2);
  });
  test("a ticket already done is left alone and not reopened", () => {
    roadmap();
    emitDeviationUnits(root, [rec()]);
    const rm = loadRoadmap(root)!;
    rm.units[0].status = "done";
    saveRoadmap(root, rm);
    const again = emitDeviationUnits(root, [rec()]);
    assert.match(again[0], /already tracked/);
    assert.equal(loadRoadmap(root)!.units[0].status, "done");
  });
});
