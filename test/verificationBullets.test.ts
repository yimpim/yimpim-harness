/**
 * Verification bullets: "[A1][tag] text" parsing, plan-wide ID assignment
 * (including legacy plans with no IDs), and the deterministic quality lint that
 * keeps QA from being handed assertions it cannot judge.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyVerificationQuality,
  extractQuotedUiStrings,
  formatVerificationBullet,
  hasObservable,
  isFluff,
  lintPlanVerification,
  normalizeVerificationIds,
  parseVerificationBullet,
} from "../src/verificationBullets.js";
import { parsePlan, phaseVerificationGoal } from "../src/planner.js";
import { loadResumeState } from "../src/resumeState.js";

const phase = (verification: string[], extra: Record<string, unknown> = {}) => ({
  name: "p",
  goal: "g",
  changes: [] as string[],
  newFiles: [] as string[],
  verification,
  ...extra,
});

describe("parseVerificationBullet / format", () => {
  test("splits ID, tags and text", () => {
    const b = parseVerificationBullet("[A3][weak][requires:device] The camera opens");
    assert.equal(b.id, "A3");
    assert.deepEqual(b.tags, ["weak", "requires:device"]);
    assert.equal(b.text, "The camera opens");
    assert.equal(b.quality, "weak");
    assert.equal(formatVerificationBullet(b), "[A3][weak][requires:device] The camera opens");
  });

  test("a bullet with no prefix has no id", () => {
    const b = parseVerificationBullet("The list is empty");
    assert.equal(b.id, null);
    assert.equal(b.text, "The list is empty");
  });

  test("a leading bracketed UI word is text, not a tag", () => {
    const b = parseVerificationBullet("[Edit] button is visible");
    assert.equal(b.id, null);
    assert.deepEqual(b.tags, []);
    assert.equal(b.text, "[Edit] button is visible");
  });

  test("ids are case-insensitive but normalised, and a second id is not an id", () => {
    const b = parseVerificationBullet("[a2][A9] x");
    assert.equal(b.id, "A2");
    assert.equal(b.text, "[A9] x");
  });
});

describe("normalizeVerificationIds", () => {
  test("numbers un-prefixed (legacy) bullets plan-wide, in order", () => {
    const plan = { phases: [phase(["one", "two"]), phase(["three"])] };
    normalizeVerificationIds(plan);
    assert.deepEqual(plan.phases[0].verification, ["[A1] one", "[A2] two"]);
    assert.deepEqual(plan.phases[1].verification, ["[A3] three"]);
  });

  test("keeps existing ids and fills only the gaps without reusing them", () => {
    const plan = { phases: [phase(["[A2] kept", "fresh"]), phase(["[A1] also kept"])] };
    normalizeVerificationIds(plan);
    assert.deepEqual(plan.phases[0].verification, ["[A2] kept", "[A3] fresh"]);
    assert.deepEqual(plan.phases[1].verification, ["[A1] also kept"]);
  });

  test("a duplicated id gets a new one on its second use", () => {
    const plan = { phases: [phase(["[A1] a"]), phase(["[A1] b"])] };
    normalizeVerificationIds(plan);
    assert.deepEqual(plan.phases[0].verification, ["[A1] a"]);
    assert.equal(parseVerificationBullet(plan.phases[1].verification[0]).id, "A2");
  });

  test("is idempotent and preserves tags", () => {
    const plan = { phases: [phase(["[A1][weak] a", "b"])] };
    normalizeVerificationIds(plan);
    const once = JSON.stringify(plan);
    normalizeVerificationIds(plan);
    assert.equal(JSON.stringify(plan), once);
    assert.equal(plan.phases[0].verification[0], "[A1][weak] a");
  });
});

describe("fluff / observable detection", () => {
  test("flags the generic phrases", () => {
    assert.ok(isFluff("File attachment works correctly"));
    assert.ok(isFluff("Everything works as expected"));
    assert.ok(isFluff("The screen functions normally"));
    assert.ok(isFluff("There are no errors"));
    assert.ok(isFluff("Verify file attachment works."));
    assert.ok(!isFluff("The filename is visible in the composer"));
  });

  test("recognises observable outcomes and explicit negatives", () => {
    assert.ok(hasObservable("The filename is visible in the composer"));
    assert.ok(hasObservable("The settings screen no longer appears after logout"));
    assert.ok(hasObservable("The app does not crash"));
    assert.ok(hasObservable("The upload request is sent with a non-empty uri"));
    assert.ok(!hasObservable("It works correctly"));
  });
});

describe("extractQuotedUiStrings", () => {
  test("keeps UI-looking strings, skips code, paths and numbers", () => {
    const text =
      'Tap "Attach File", see “Remove” and `Send`; not `src/a.ts`, `useThing()`, `my_key`, `camelCase`, "42", `README.md`';
    assert.deepEqual(extractQuotedUiStrings(text), ["Attach File", "Remove", "Send"]);
  });

  test("shell commands are not UI labels", () => {
    assert.deepEqual(extractQuotedUiStrings("Run `npm run build` or `npx vite build --mode dev`, then see `Done`"), ["Done"]);
  });
});

describe("lintPlanVerification", () => {
  const ctx = { knownText: "" };

  test("a vague bullet with nothing observable is weak", () => {
    const issues = lintPlanVerification({ phases: [phase(["[A1] File attachment works correctly"])] }, ctx);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, "weak");
    assert.equal(issues[0].id, "A1");
  });

  test("fluff wording is fine when it also names something observable", () => {
    const issues = lintPlanVerification(
      { phases: [phase(["[A1] The list renders correctly and shows the new row"])] },
      ctx
    );
    assert.deepEqual(issues, []);
  });

  test("a quoted label found nowhere is flagged", () => {
    const issues = lintPlanVerification({ phases: [phase(['[A1] Tapping "Zorp Button" shows a dialog'])] }, ctx);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, "label_unverified");
    assert.match(issues[0].message, /Zorp Button/);
  });

  test("a label is accepted when it appears in the nav map / request / discovery text", () => {
    const issues = lintPlanVerification(
      { phases: [phase(['[A1] Tapping "Attach File" shows the chooser'])] },
      { knownText: JSON.stringify({ Dashboard: { controls: [{ label: "📎 Attach file" }] } }) }
    );
    assert.deepEqual(issues, []);
  });

  test("a label the plan itself builds is accepted, even in a different phase", () => {
    const plan = {
      phases: [
        phase([], { changes: ['Add a "Retry" button to the error banner'] }),
        phase(['[A1] The "Retry" button is visible after a failed upload']),
      ],
    };
    assert.deepEqual(lintPlanVerification(plan, ctx), []);
  });

  test("quoted code or paths do not count as guessed labels", () => {
    const issues = lintPlanVerification(
      { phases: [phase(["[A1] `src/ui/Composer.tsx` renders the chip and `onAttach()` is called"])] },
      ctx
    );
    assert.deepEqual(issues, []);
  });
});

describe("applyVerificationQuality", () => {
  test("tags the flagged bullets in place, once", () => {
    const plan = { phases: [phase(["[A1] File attachment works correctly", "[A2] The row is visible"])] };
    const issues = lintPlanVerification(plan, { knownText: "" });
    applyVerificationQuality(plan, issues);
    applyVerificationQuality(plan, issues);
    assert.equal(plan.phases[0].verification[0], "[A1][weak] File attachment works correctly");
    assert.equal(plan.phases[0].verification[1], "[A2] The row is visible");
  });
});

describe("integration with the plan pipeline", () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  test("parsePlan numbers every bullet across phases", () => {
    const raw = JSON.stringify({
      goal: "g",
      phases: [
        { id: "phase-1", name: "a", goal: "x", files: ["a.ts"], changes: ["c"], verification: ["first", "second"] },
        { id: "phase-2", name: "b", goal: "y", files: ["b.ts"], changes: ["c"], verification: ["third"] },
      ],
    });
    const { plan } = parsePlan(raw, "g");
    assert.deepEqual(
      plan.phases.flatMap((p) => p.verification),
      ["[A1] first", "[A2] second", "[A3] third"]
    );
  });

  test("a legacy saved plan gets synthetic ids when loaded for --resume", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-resume-ids-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, ".agent"));
    fs.writeFileSync(
      path.join(dir, ".agent", "last-plan.json"),
      JSON.stringify({
        instructions: "i",
        planOutput: "{}",
        timestamp: "t",
        plan: { goal: "g", phases: [phase(["old one", "old two"])] },
      })
    );
    const state = loadResumeState(dir);
    assert.deepEqual((state as any).plan.phases[0].verification, ["[A1] old one", "[A2] old two"]);
  });

  test("QA's goal text keeps the id and explains a quality flag in words", () => {
    const plan: any = { goal: "obj", phases: [] };
    const p: any = {
      id: "phase-1",
      name: "n",
      goal: "g",
      executor: "EDITOR",
      files: [],
      newFiles: [],
      changes: [],
      verification: ["[A1][weak] It works correctly", "[A2][label_unverified] Tap \"Zorp\"", "[A3] The row is visible"],
    };
    const goal = phaseVerificationGoal(plan, p);
    assert.match(goal, /\[A1\] It works correctly\s+\(vaguely worded/);
    assert.match(goal, /\[A2\] Tap "Zorp"\s+\(a quoted label here was not found/);
    assert.match(goal, /\[A3\] The row is visible\n?/);
    assert.doesNotMatch(goal, /\[weak\]|\[label_unverified\]/);
  });
});
