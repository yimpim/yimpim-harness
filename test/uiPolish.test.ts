/**
 * The polish pass: which of the critique's changes are made (a conflict with the project's own documents only on purpose), the task
 * the normal pipeline runs, and, once it has passed, the same screens captured again, re-scored and set side by side.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isUiPolishRequest,
  parsePolishArgs,
  chooseChanges,
  polishTask,
  loadLastCritique,
  routesOf,
  pairScreens,
  parsePolishScore,
  polishAfter,
  renderPolish,
  beforeAfterHtml,
} from "../src/uiPolish.js";
import type { UiCritique } from "../src/uiCritique.js";
import type { CaptureReport } from "../src/uiCapture.js";

const roots: string[] = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
function repo(files: Record<string, string | Buffer> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-polish-"));
  roots.push(root);
  for (const [rel, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), c);
  }
  return root;
}

const CRITIQUE: UiCritique = {
  firstImpression: "x",
  works: [],
  scores: { hierarchy: 2, spacing: 3, density: 3, surfaces: 3, typography: 3, colour: 2, consistency: 2, states: 2, accessibility: 2, originality: 2 },
  slop: [],
  screens: [],
  tokens: [{ token: "radius.card", now: "16", proposed: "12", why: "match the buttons" }],
  changes: [
    { change: "Make History dark like the dashboard.", why: "one theme", screens: ["History"], impact: "high", conflicts: "reference/specs/VISUAL_PARITY_SPEC.md" },
    { change: "Label the login fields", why: "placeholders vanish", screens: ["Login"], impact: "high", conflicts: null },
    { change: "Add pressed states", why: "feedback", screens: [], impact: "medium", conflicts: null },
  ],
  referenceGaps: [],
  total: 24,
  outOf: 50,
};

const BEFORE: CaptureReport = {
  router: "Expo Router",
  screens: [
    { name: "History", route: "/history", viewport: "phone", file: "design-system/critique/before/history-phone.png", from: "nav map" },
    { name: "Login", route: "/login", viewport: "phone", file: "design-system/critique/before/login-phone.png", from: "nav map" },
    { name: "Login", route: "/login", viewport: "desktop", file: "design-system/critique/before/login-desktop.png", from: "nav map" },
    { name: "mine", route: "", viewport: "provided", file: "design-system/critique/before/provided-mine.png", from: "provided" },
  ],
  skipped: [],
  nameOnly: [],
};

describe("the command and what it changes", () => {
  test("only an explicit polish of the UI, app or screens", () => {
    for (const s of ["polish ui", "polish my app 1,3", "polish the screens --include-conflicts"]) assert.ok(isUiPolishRequest(s), s);
    for (const s of ["polish the logo", "critique ui", "a polished logo"]) assert.equal(isUiPolishRequest(s), null, s);
  });

  test("numbers in any form, and the conflicts flag", () => {
    assert.deepEqual(parsePolishArgs("1,3 5"), { pick: [1, 3, 5], includeConflicts: false });
    assert.deepEqual(parsePolishArgs("all --include-conflicts"), { pick: [], includeConflicts: true });
    assert.deepEqual(parsePolishArgs(""), { pick: [], includeConflicts: false });
  });

  test("by default every change except one that conflicts with the project's own documents, which is left out with why", () => {
    const { chosen, left } = chooseChanges(CRITIQUE, { pick: [], includeConflicts: false });
    assert.deepEqual(chosen.map((c) => c.n), [2, 3]);
    assert.equal(left.length, 1);
    assert.match(left[0].why, /^it conflicts with reference\/specs\/VISUAL_PARITY_SPEC\.md \(pick it by number, or add --include-conflicts/);
  });

  test("picked by number, or with --include-conflicts, a conflicting change is made: the person chose it", () => {
    assert.deepEqual(chooseChanges(CRITIQUE, { pick: [1], includeConflicts: false }).chosen.map((c) => c.n), [1]);
    assert.deepEqual(chooseChanges(CRITIQUE, { pick: [], includeConflicts: true }).chosen.map((c) => c.n), [1, 2, 3]);
    assert.deepEqual(chooseChanges(CRITIQUE, { pick: [2, 9], includeConflicts: false }).left, [{ n: 9, why: "there is no change 9" }]);
  });

  test("the task names each change, its screens and why, the token changes, and what must not change", () => {
    const task = polishTask(CRITIQUE, chooseChanges(CRITIQUE, { pick: [1, 2], includeConflicts: false }).chosen);
    assert.match(task, /^Polish the app's UI, following design-system\/CRITIQUE\.md\. Make exactly these changes, and nothing beyond them:\n1\. Make History dark like the dashboard\. Screens: History\. Why: one theme This one conflicts with reference\/specs\/VISUAL_PARITY_SPEC\.md: update that document to match, in the same change\.\n2\. Label the login fields\. Screens: Login\. Why: placeholders vanish\n/);
    assert.match(task, /- radius\.card: 16 -> 12\. match the buttons/);
    assert.match(task, /never hard-code the new value in a component/);
    assert.match(task, /keep its behaviour, its navigation, what its text means, and its tests passing/);
  });
});

describe("the last critique", () => {
  test("is read from critique.json and the capture record; missing or malformed is nothing", () => {
    const r = repo({ "design-system/critique/critique.json": JSON.stringify({ critique: CRITIQUE }), "design-system/critique/before/capture.json": JSON.stringify(BEFORE) });
    assert.equal(loadLastCritique(r)?.critique.total, 24);
    assert.equal(loadLastCritique(repo()), null);
    assert.equal(loadLastCritique(repo({ "design-system/critique/critique.json": "{", "design-system/critique/before/capture.json": "{}" })), null);
  });

  test("the screens to capture again are the captured routes, once each; screenshots the person gave are not recaptured", () => {
    assert.deepEqual(routesOf(BEFORE).map((r) => r.route), ["/history", "/login"]);
  });
});

describe("after the polish task has passed", () => {
  const AFTER: CaptureReport = {
    router: "Expo Router",
    screens: [
      { name: "History", route: "/history", viewport: "phone", file: "design-system/critique/after/history-phone.png", from: "nav map" },
      { name: "Login", route: "/login", viewport: "phone", file: "design-system/critique/after/login-phone.png", from: "nav map" },
    ],
    skipped: [{ route: "/login", name: "Login", reason: "redirected to /x" }],
    nameOnly: [],
  };

  test("before and after are paired by screen and size, only where both exist", () => {
    assert.deepEqual(pairScreens(BEFORE.screens, AFTER.screens).map((p) => `${p.name}/${p.viewport}`), ["History/phone", "Login/phone"]);
  });

  test("the re-score is bounded, and verdicts are kept only for changes that were made", () => {
    const chosen = chooseChanges(CRITIQUE, { pick: [], includeConflicts: false }).chosen;
    const s = parsePolishScore(
      JSON.stringify({ scores: { hierarchy: 4, spacing: 4, density: 3, surfaces: 4, typography: 4, colour: 3, consistency: 4, states: 3, accessibility: 9, originality: 3 }, verdicts: [{ n: 2, verdict: "done", note: "labels above fields" }, { n: 3, verdict: "maybe" }, { n: 7, verdict: "done" }] }),
      chosen
    )!;
    assert.equal(s.total, 37, "accessibility's 9 is clamped to 5");
    assert.deepEqual(s.verdicts.map((v) => [v.n, v.verdict]), [[2, "done"], [3, "partly"]]);
    assert.equal(parsePolishScore(JSON.stringify({ scores: { hierarchy: 4 } }), chosen), null);
  });

  test("captures the same screens into after/, re-scores once, writes POLISH.md and the side-by-side picture", async () => {
    const png = Buffer.from("\x89PNG\r\n\x1a\nimg");
    const root = repo({
      "design-system/critique/before/history-phone.png": png,
      "design-system/critique/before/login-phone.png": png,
      "design-system/critique/after/history-phone.png": png,
      "design-system/critique/after/login-phone.png": png,
    });
    const last = { critique: CRITIQUE, capture: BEFORE };
    const { chosen, left } = chooseChanges(CRITIQUE, { pick: [], includeConflicts: false });
    let recaptured: string[] = [];
    let calls = 0;
    let sheetHtml = "";
    const result = await polishAfter(last, chosen, left, {
      repoRoot: root,
      visionModels: ["vision/judge"],
      log: () => {},
      capture: async (routes) => ((recaptured = routes.map((r) => r.route)), AFTER),
      renderer: { page: async (html: string) => ((sheetHtml = html), Buffer.from("sheet")), png: async () => Buffer.from(""), close: async () => {} },
      call: async (_m, messages) => {
        calls++;
        const content = messages[1].content as any[];
        assert.equal(content.filter((p) => p.type === "image_url").length, 2);
        assert.match(content[0].text, /Changes asked for:\n2\. Label the login fields\n3\. Add pressed states/);
        return JSON.stringify({ scores: { hierarchy: 4, spacing: 4, density: 3, surfaces: 4, typography: 4, colour: 3, consistency: 4, states: 3, accessibility: 4, originality: 3 }, verdicts: [{ n: 2, verdict: "done", note: "labels above fields" }] });
      },
    });
    assert.deepEqual(recaptured, ["/history", "/login"]);
    assert.equal(calls, 1);
    assert.match(sheetHtml, /<th colspan="2">History <span>phone<\/span><\/th>/);
    assert.equal(fs.readFileSync(path.join(root, "design-system/critique/before-after.png"), "utf8"), "sheet");
    const md = fs.readFileSync(path.join(root, "design-system/critique/POLISH.md"), "utf8");
    assert.match(md, /\| hierarchy \| 2 \| 4 \(\+2\) \|/);
    assert.match(md, /\| \*\*total\*\* \| \*\*24 of 50\*\* \| \*\*36 of 50\*\* \|/);
    assert.match(md, /2\. Label the login fields {2}\n {3}✅ done: labels above fields/);
    assert.match(md, /## Left out\n- 1: it conflicts with/);
    assert.match(md, /Not captured after: Login \(redirected to \/x\)\./);
    assert.equal(result.text, "Polish compared in design-system/critique/POLISH.md: 24 of 50 before, 36 of 50 after (+12); side by side in design-system/critique/before-after.png.");
  });

  test("without a browser or a usable re-score, the comparison is still written, and says so", () => {
    const md = renderPolish({ critique: CRITIQUE, chosen: [], left: [], after: null, pairs: 0, capture: { router: null, screens: [], skipped: [], nameOnly: [] }, sheet: null });
    assert.match(md, /No side-by-side picture could be made/);
    assert.match(md, /\*\*not re-scored\*\*/);
  });

  test("the side-by-side page leaves out a pair whose image cannot be read", () => {
    const html = beforeAfterHtml([{ name: "A", viewport: "phone", before: "a", after: "b" }], (f) => (f === "a" ? "data:image/png;base64,AA" : null));
    assert.doesNotMatch(html, /<img/);
  });
});

test("wired only to `/design polish ui …`: loaded there and in the after-step, and the after-step runs only for that exact task", () => {
  const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");
  assert.equal(idx.split('await import("./uiPolish.js")').length - 1, 2, "the command and the after-step");
  assert.doesNotMatch(idx, /from "\.\/uiPolish\.js"/);
  assert.match(idx, /pendingPolish = \{ task, chosen, left, last \};\n\s+queuedInstructions = task;\n\s+continue taskLoop;/);
  assert.match(idx, /if \(pendingPolish\) \{\n\s+const p = pendingPolish;\n\s+pendingPolish = undefined;\n\s+if \(instructions\.trim\(\) === p\.task\.trim\(\)\) \{/);
});
