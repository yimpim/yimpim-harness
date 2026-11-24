/**
 * Three directions to pick from: proposed together, near-duplicates dropped, each built into a real design system and drawn in its
 * own tokens, then picked by the person (or the recommended one when nobody can answer).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDirections, tooAlike, parseDirectionChoice, directionsSheetHtml, chooseFromDirections, DIRECTIONS_INSTRUCTION, DECIDE_LOOK, type VisualIntake } from "../src/uiDirections.js";
import { detectUiStack, parseDirection, buildDesignSystem } from "../src/uiDesign.js";
import { PLAYBOOKS } from "../src/uiKnowledge.js";

const roots: string[] = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
const tmp = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-dirs-"));
  roots.push(r);
  return r;
};

const playbook = PLAYBOOKS.find((p) => p.id === "saas")!;
const D1 = { name: "Ledger", style: "swiss", pairing: "news-editorial", signature: "#2d55d6", density: "balanced", radius: "soft", pitch: "Calm and exact, like a good spreadsheet." };
const D2 = { name: "Ledger", style: "editorial", pairing: "magazine", signature: "#c2410c", density: "airy", radius: "sharp", pitch: "Warm and literary, generous space." };
const D3 = { name: "Ledger", style: "flat", pairing: "minimal-editorial", signature: "#0f766e", density: "dense", radius: "round", pitch: "Dense and friendly, rounded and quick." };

describe("the proposals", () => {
  test("three raw directions and the recommended one (0-based; the first when unsaid or out of range)", () => {
    assert.deepEqual(parseDirections(JSON.stringify({ directions: [D1, D2, D3], recommended: 2 })).recommended, 1);
    assert.equal(parseDirections("```json\n" + JSON.stringify({ directions: [D1, D2, D3, D1] }) + "\n```").raws.length, 3);
    assert.equal(parseDirections(JSON.stringify({ directions: [D1], recommended: 3 })).recommended, 0);
    assert.deepEqual(parseDirections("nothing"), { raws: [], recommended: 0 });
  });

  test("the instruction asks for three clearly different directions, each with a pitch", () => {
    assert.match(DIRECTIONS_INSTRUCTION, /THREE that are clearly different/);
    assert.match(DIRECTIONS_INSTRUCTION, /"pitch"/);
  });

  test("too alike to be a choice: same style and pairing, or same style and nearly the same colour", () => {
    const stack = detectUiStack(tmp());
    const d = (o: object) => parseDirection(JSON.stringify(o), playbook, stack, "x")!;
    assert.equal(tooAlike(d(D1), d({ ...D1, signature: "#c2410c" })), true, "same style and pairing");
    assert.equal(tooAlike(d(D1), d({ ...D1, pairing: "magazine", signature: "#3a5fe0" })), true, "same style, nearly the same blue");
    assert.equal(tooAlike(d(D1), d(D2)), false);
  });

  test("a choice by number, by label, or anything else is the recommended one", () => {
    const labels = ["1 — a", "2 — b", "3 — c"];
    assert.equal(parseDirectionChoice("2", labels, 0), 1);
    assert.equal(parseDirectionChoice("3 — c", labels, 0), 2);
    assert.equal(parseDirectionChoice(DECIDE_LOOK, labels, 1), 1);
    assert.equal(parseDirectionChoice("9", labels, 2), 2);
  });
});

describe("drawing them", () => {
  test("each sample uses its own colours, type, corners and density, and loads its typefaces", () => {
    const stack = detectUiStack(tmp());
    const opts = [D1, D2].map((raw, i) => {
      const direction = parseDirection(JSON.stringify(raw), playbook, stack, "x")!;
      return { n: i + 1, direction, system: buildDesignSystem(direction, "web", stack), pitch: raw.pitch };
    });
    const html = directionsSheetHtml(opts);
    assert.match(html, /fonts\.googleapis\.com\/css2\?family=Newsreader/);
    for (const o of opts) {
      assert.ok(html.includes(o.system.palette.light.primary), "its primary colour");
      assert.ok(html.includes(`'${o.system.pairing.heading}'`), "its heading face");
      assert.ok(html.includes(o.pitch));
    }
    assert.match(html, /padding:16px/, "balanced density");
    assert.match(html, /padding:24px/, "airy density");
  });
});

describe("choosing", () => {
  const ctx = (call: (m: string[], msgs: any[]) => Promise<string>, repoRoot = tmp()) => ({
    call: async (m: string[], msgs: any[]) => call(m, msgs),
    models: ["designer"],
    repoRoot,
    log: () => {},
    playbook,
    stack: detectUiStack(repoRoot),
    platform: "web" as const,
    userText: "The request:\nBuild a budgeting app",
  });

  test("proposes, draws, shows, asks, and returns the picked one with a note for MASTER.md", async () => {
    const root = tmp();
    const asked: { prompt: string; choices: string[]; fallback: string }[] = [];
    const shown: string[] = [];
    let opened = 0;
    let sent: any[] = [];
    const intake: VisualIntake = {
      visionModels: ["v"],
      autonomous: false,
      newProject: true,
      ask: async (prompt, choices, fallback) => (asked.push({ prompt, choices, fallback }), "3"),
      show: (_label, file) => shown.push(file),
      openRenderer: async () => (opened++, { page: async () => Buffer.from("png"), png: async () => Buffer.from(""), close: async () => {} }),
    };
    const picked = await chooseFromDirections(intake, ctx(async (_m, msgs) => ((sent = msgs), JSON.stringify({ directions: [D1, D2, D3], recommended: 2 })), root));
    assert.match(sent[0].content, /THREE that are clearly different/);
    assert.match(sent[1].content, /Build a budgeting app/);
    assert.equal(opened, 1);
    assert.deepEqual(shown, [path.join(root, "design-system", "directions.png")]);
    assert.equal(asked[0].prompt, "Which look should the app have? (recommended: 2)");
    assert.deepEqual(asked[0].choices.slice(-1), [DECIDE_LOOK]);
    assert.equal(asked[0].fallback, asked[0].choices[1], "nobody answering takes the recommended one");
    assert.equal(picked?.direction.style, "flat");
    assert.match(picked!.note, /^Chosen from three directions \(design-system\/directions\.png\): 3\. Dense and friendly, rounded and quick\. Not chosen: 1\. Calm and exact/);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "design-system/directions.json"), "utf8"));
    assert.equal(saved.directions.length, 3);
    assert.equal(saved.recommended, 2);
  });

  test("with questions off, the recommended one is used without asking; with no browser, it is still offered in words", async () => {
    let asked = 0;
    const picked = await chooseFromDirections(
      { visionModels: [], autonomous: true, newProject: true, ask: async () => (asked++, "1"), openRenderer: async () => null },
      ctx(async () => JSON.stringify({ directions: [D1, D2, D3], recommended: 2 }))
    );
    assert.equal(asked, 0);
    assert.equal(picked?.direction.style, "editorial");
  });

  test("fewer than two distinct directions, a reply that is not JSON, or a failed call: null, and the caller makes the single one", async () => {
    const intake: VisualIntake = { visionModels: [], autonomous: false, newProject: true, ask: async () => "1" };
    assert.equal(await chooseFromDirections(intake, ctx(async () => JSON.stringify({ directions: [D1, { ...D1, signature: "#3a5fe0" }] }))), null);
    assert.equal(await chooseFromDirections(intake, ctx(async () => "sorry")), null);
    assert.equal(await chooseFromDirections(intake, ctx(async () => { throw new Error("down"); })), null);
  });
});

test("the design step uses the pick and records how it was chosen in MASTER.md", () => {
  const src = fs.readFileSync("src/uiDesign.ts", "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /if \(look\.mode === "directions" && ctx\.visual\) \{\n\s+try \{\n\s+const \{ chooseFromDirections \} = await import\("\.\/uiDirections\.js"\);/);
  assert.match(src, /if \(!direction\) try \{\n\s+direction = parseDirection\(/);
  assert.match(src, /## How this direction was chosen/);
});
