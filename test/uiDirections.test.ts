/**
 * The look of a new app or site: asked about only for a new user-facing build in a new project with no design system, never
 * when nobody can answer or questions are off; the answer read as a choice or as references, and the references read.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wantsVisualIntake, parseReferenceAnswer, askForLook, REFERENCE_QUESTION, SHOW_DIRECTIONS, DECIDE_LOOK, type VisualIntake } from "../src/uiDirections.js";

const roots: string[] = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
const tmp = (files: Record<string, string | Buffer> = {}) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-look-"));
  roots.push(r);
  for (const [rel, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true });
    fs.writeFileSync(path.join(r, rel), c);
  }
  return r;
};

describe("when the look is asked about", () => {
  test("only a new user-facing build, in a new project, with no design system yet", () => {
    assert.equal(wantsVisualIntake({ ui: "new", exists: false, newProject: true }), true);
    assert.equal(wantsVisualIntake({ ui: "new", exists: false, newProject: false }), false, "an existing app");
    assert.equal(wantsVisualIntake({ ui: "new", exists: true, newProject: true }), false, "a design system exists");
    for (const ui of ["restyle", "extend", "none"]) assert.equal(wantsVisualIntake({ ui, exists: false, newProject: true }), false, ui);
  });

  test("the design step checks all of that before it loads the module, which it loads dynamically", () => {
    const src = fs.readFileSync("src/uiDesign.ts", "utf8").replace(/\r\n/g, "\n");
    assert.match(src, /if \(ctx\.visual && decision\.ui === "new" && !exists && ctx\.visual\.newProject\) \{\n\s+try \{\n\s+const \{ askForLook \} = await import\("\.\/uiDirections\.js"\);/);
    assert.doesNotMatch(src, /from "\.\/uiDirections\.js"/);
    const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");
    assert.match(idx, /autonomous: config\.planning\.questions === "autonomous",\n\s+newProject: isNewProject\(repoRoot\),/);
  });
});

describe("the answer", () => {
  test("the two choices, and the ways people say them", () => {
    assert.deepEqual(parseReferenceAnswer(SHOW_DIRECTIONS), { mode: "directions" });
    assert.deepEqual(parseReferenceAnswer("show me some options"), { mode: "directions" });
    assert.deepEqual(parseReferenceAnswer(DECIDE_LOOK), { mode: "decide" });
    assert.deepEqual(parseReferenceAnswer("no"), { mode: "decide" });
    assert.deepEqual(parseReferenceAnswer(""), { mode: "decide" });
    assert.deepEqual(parseReferenceAnswer(undefined), { mode: "decide" });
  });
  test("anything else is references: addresses, paths and names, without the filler words; quoted names stay whole", () => {
    assert.deepEqual(parseReferenceAnswer(`like linear.app and "Stripe dashboard", inspo/home.png`), { mode: "references", inputs: ["linear.app", "Stripe dashboard", "inspo/home.png"] });
  });
  test("the question offers both choices and asks for a screenshot first", () => {
    assert.match(REFERENCE_QUESTION, /a screenshot works best/);
    assert.ok(REFERENCE_QUESTION.includes(SHOW_DIRECTIONS) && REFERENCE_QUESTION.includes(DECIDE_LOOK));
  });
});

describe("asking, and reading what was given", () => {
  const base = (over: Partial<VisualIntake> = {}): VisualIntake => ({ visionModels: ["vision/judge"], autonomous: false, newProject: true, ...over });

  test("nothing is asked when questions are off or nobody can answer", async () => {
    let asked = 0;
    const ask = async () => (asked++, "linear.app");
    const lines: string[] = [];
    assert.deepEqual(await askForLook(base({ ask, autonomous: true }), { repoRoot: tmp(), call: async () => "", log: (l) => lines.push(l) }), { mode: "decide", reads: [] });
    assert.deepEqual(await askForLook(base(), { repoRoot: tmp(), call: async () => "", log: () => {} }), { mode: "decide", reads: [] });
    assert.equal(asked, 0);
    assert.match(lines[0], /recommended direction is used/);
  });

  test("the question is asked once, with free text allowed and 'decide for me' as the fallback", async () => {
    const seen: [string, string[], string][] = [];
    const r = await askForLook(base({ ask: async (p, c, f) => (seen.push([p, c, f]), SHOW_DIRECTIONS) }), { repoRoot: tmp(), call: async () => "", log: () => {} });
    assert.deepEqual(r, { mode: "directions", reads: [] });
    assert.deepEqual(seen, [[REFERENCE_QUESTION, [SHOW_DIRECTIONS, DECIDE_LOOK], DECIDE_LOOK]]);
  });

  test("references are gathered into design-system/references and read; the reads are saved", async () => {
    const root = tmp({ "design-system/references/ref-1.png": Buffer.from("png") });
    let gatheredInto = "";
    const r = await askForLook(
      base({
        ask: async () => "linear.app",
        references: async (inputs, outDir) => {
          gatheredInto = outDir;
          assert.deepEqual(inputs, ["linear.app"]);
          return [{ input: "linear.app", kind: "url", label: "linear.app", status: "ok", images: ["design-system/references/ref-1.png"] }];
        },
      }),
      { repoRoot: root, call: async () => JSON.stringify({ essence: "Dark and precise.", borrow: ["One accent"], density: "dense" }), log: () => {} }
    );
    assert.equal(gatheredInto, path.join(root, "design-system", "references"));
    assert.equal(r.mode, "references");
    assert.deepEqual(r.reads.map((x) => [x.label, x.essence]), [["linear.app", "Dark and precise."]]);
    assert.ok(fs.existsSync(path.join(root, "design-system/references/READ.md")));
  });

  test("when none of the references can be used, the three directions are offered instead", async () => {
    const lines: string[] = [];
    const r = await askForLook(
      base({ ask: async () => "app.example", references: async () => [{ input: "app.example", kind: "url", label: "app.example", status: "needs-screenshot", images: [], note: "it is behind a sign-in page: send a screenshot instead" }] }),
      { repoRoot: tmp(), call: async () => "", log: (l) => lines.push(l) }
    );
    assert.deepEqual(r, { mode: "directions", reads: [] });
    assert.ok(lines.some((l) => /behind a sign-in page/.test(l)));
    assert.ok(lines.some((l) => /three directions to choose from instead/.test(l)));
  });
});
