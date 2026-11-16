/**
 * The Designer, with scripted models and a fake renderer: different models
 * propose and draw, a model other than the drawer looks, fixes are kept only if
 * they are no worse, the harness builds the variants, and the budget holds.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatherBrief, parseJsonObject, projectFacts, rotate, runDesign, slugify, type ChatMsg, type DesignDeps } from "../src/designer.js";
import type { Renderer } from "../src/svgRender.js";

const svgOf = (color: string) => `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="${color}"/></svg>`;
const repo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dz-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pennywise", description: "A budgeting app for students" }));
  return dir;
};
const fakeRenderer = (): Renderer & { pngs: number } => {
  const r: any = {
    pngs: 0,
    png: async () => (r.pngs++, Buffer.from("PNGDATA")),
    page: async () => Buffer.from("SHEET"),
    close: async () => {},
  };
  return r;
};

interface Call {
  models: string[];
  label: string;
  messages: ChatMsg[];
}

function scripted(opts: { scores?: (label: string) => number; badDraw?: boolean } = {}) {
  const calls: Call[] = [];
  const call: DesignDeps["call"] = async (models, messages, label) => {
    calls.push({ models, label, messages });
    if (label === "brief") return JSON.stringify({ name: "Pennywise", offering: "budgeting for students", audience: "students", personality: ["friendly", "sharp"], avoid: ["piggy bank"], constraints: [], assumptions: [] });
    if (label.startsWith("concepts")) {
      const n = label.split(" ")[1];
      return JSON.stringify({
        concepts: [1, 2, 3].map((k) => ({ title: `Idea ${n}${k}`, markType: ["symbol", "lettermark", "negative-space"][(Number(n) + k) % 3], idea: `idea ${n}${k}`, construction: "a circle and a bar" })),
      });
    }
    if (label.startsWith("draw")) return opts.badDraw ? "I can't draw" : svgOf("#" + (calls.length % 9) + "00000".slice(0, 5) + "0");
    if (label.startsWith("look")) return JSON.stringify({ score: (opts.scores ?? (() => 6))(label), defects: ["the left curve bulges"] });
    if (label.startsWith("fix")) return svgOf("#0a0a0a");
    return "{}";
  };
  return { calls, call };
}

const base = (dir: string, over: Partial<DesignDeps> = {}): DesignDeps => ({
  repoRoot: dir,
  models: ["openai/a", "google/b", "anthropic/c"],
  visionModels: ["google/b", "openai/a"],
  call: scripted().call,
  renderer: fakeRenderer(),
  log: () => {},
  ...over,
});

describe("helpers", () => {
  test("JSON is found inside prose; rotation and slugs behave", () => {
    assert.deepEqual(parseJsonObject('Sure: {"a": 1} done'), { a: 1 });
    assert.equal(parseJsonObject("no json"), null);
    assert.deepEqual(rotate(["a", "b", "c"], 1), ["b", "c", "a"]);
    assert.deepEqual(rotate(["a", "b", "c"], -1), ["c", "a", "b"]);
    assert.equal(slugify("  Penny & Wise!! "), "penny-wise");
    assert.equal(slugify("***"), "brand");
  });

  test("the project speaks for itself: facts come from its own files and existing marks", () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "logo.png"), "x");
    const f = projectFacts(dir);
    assert.match(f, /A budgeting app for students/);
    assert.match(f, /Existing brand-like files and attachments: assets\/logo\.png/);
  });

  test("a brief never asks; what it could not learn becomes a stated assumption", async () => {
    const b = await gatherBrief(async () => JSON.stringify({ name: null, offering: "x" }), "a logo", "facts", undefined, "myapp");
    assert.equal(b.name, "myapp");
    assert.ok(b.assumptions.some((a) => /folder name "myapp"/.test(a)));
  });
});

describe("runDesign", () => {
  test("concepts come from different models, are drawn by different models, and are looked at by one that did not draw them", async () => {
    const dir = repo();
    const s = scripted();
    await runDesign(base(dir, { call: s.call }), "I need a logo");
    const proposers = new Set(s.calls.filter((c) => c.label.startsWith("concepts")).map((c) => c.models[0]));
    assert.ok(proposers.size >= 3, "each proposer starts from a different model");
    const lenses = s.calls.filter((c) => c.label.startsWith("concepts")).map((c) => String((c.messages[0] as any).content).match(/SYMBOLS|LETTERS|GEOMETRY/)?.[0]);
    assert.equal(new Set(lenses).size, 3, "and a different lens");
    const drawers = new Set(s.calls.filter((c) => /^draw \d+$/.test(c.label)).map((c) => c.models[0]));
    assert.ok(drawers.size >= 2, "drawn by more than one model");
    assert.ok(s.calls.some((c) => c.label.startsWith("look")), "every mark is looked at");
  });

  test("the judge is never the model that drew the mark when there is a choice", async () => {
    const dir = repo();
    const s = scripted();
    await runDesign(base(dir, { call: s.call, models: ["google/b", "openai/a"], visionModels: ["google/b", "openai/a"] }), "logo");
    // Candidate A is drawn by rotate(models,1)[0] = openai/a; its judge must not be openai/a.
    const drawA = s.calls.find((c) => c.label === "draw 1")!;
    const lookA = s.calls.find((c) => c.label === "look A")!;
    assert.equal(drawA.models[0], "openai/a");
    assert.equal(lookA.models[0], "google/b");
  });

  test("it writes the concepts, the sheet, and a full kit, and recommends the best", async () => {
    const dir = repo();
    const s = scripted({ scores: (l) => (l.includes("A") ? 8 : 5) });
    const messages: string[] = [];
    const r = await runDesign(base(dir, { call: s.call, log: (l) => messages.push(l) }), "a logo for my budgeting app");
    assert.ok(r.ok, r.text);
    const kit = fs.readdirSync(r.dir!);
    for (const f of ["logo.svg", "logo-black.svg", "logo-white.svg", "favicon.svg", "favicon.ico", "favicon-16.png", "favicon-32.png", "favicon-48.png", "app-icon.svg", "app-icon-512.png", "maskable-512.png", "apple-touch-icon.png", "brand.json", "README.md", "concepts.png", "concepts"]) {
      assert.ok(kit.includes(f), `missing ${f}`);
    }
    assert.ok(fs.readdirSync(path.join(r.dir!, "concepts")).length >= 2);
    assert.match(fs.readFileSync(path.join(r.dir!, "logo-white.svg"), "utf-8"), /#ffffff/);
    const json = JSON.parse(fs.readFileSync(path.join(r.dir!, "brand.json"), "utf-8"));
    assert.equal(json.name, "Pennywise");
    assert.ok(json.modelsInvolved.length >= 3);
    assert.match(fs.readFileSync(path.join(r.dir!, "README.md"), "utf-8"), /No trademark search/);
    assert.match(r.text, /not a trademark search/);
  });

  test("a two-colour mark keeps its light part in every variant (no blob)", async () => {
    const dir = repo();
    const s = scripted();
    const call: DesignDeps["call"] = async (m, msgs, label, json) =>
      label.startsWith("draw") || label.startsWith("fix")
        ? '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#2563eb"/><path d="M30 55L45 70L72 36" fill="none" stroke="#ffffff" stroke-width="8"/></svg>'
        : s.call(m, msgs, label, json);
    const r = await runDesign(base(dir, { call }), "logo");
    const read = (f: string) => fs.readFileSync(path.join(r.dir!, f), "utf-8");
    // the app icon keeps the blue disc AND the white check, on a neutral tile that the disc contrasts with
    assert.match(read("app-icon.svg"), /<rect[^>]*fill="#ffffff"/);
    assert.match(read("app-icon.svg"), /<circle[^>]*fill="#2563eb"/);
    assert.match(read("app-icon.svg"), /stroke="#ffffff"/);
    assert.match(read("maskable-icon.svg"), /stroke="#ffffff"/);
    // the one-colour versions keep a visible check
    assert.match(read("logo-black.svg"), /<circle[^>]*fill="#000000"/);
    assert.match(read("logo-black.svg"), /stroke="#ffffff"/);
    assert.match(read("logo-white.svg"), /stroke="#111111"/);
  });

  test("the person's pick is used; an answer that matches nothing takes the recommended one", async () => {
    const pick = async (answer: string) => {
      const dir = repo();
      let asked: { prompt: string; choices: string[] } | null = null;
      const r = await runDesign(
        base(dir, {
          call: scripted({ scores: (l) => (l.includes("A") ? 9 : 6) }).call,
          ask: async (prompt, choices) => ((asked = { prompt, choices }), answer),
        }),
        "logo"
      );
      return { r, asked: asked! };
    };
    const b = await pick("B — whatever");
    assert.match(b.asked.choices[0], /recommended/);
    assert.match(b.r.text, new RegExp("Idea"));
    const chosenB = JSON.parse(fs.readFileSync(path.join(b.r.dir!, "brand.json"), "utf-8")).concept.title;
    const garbage = await pick("hmm not sure");
    const chosenDefault = JSON.parse(fs.readFileSync(path.join(garbage.r.dir!, "brand.json"), "utf-8")).concept.title;
    const a = await pick("A");
    const chosenA = JSON.parse(fs.readFileSync(path.join(a.r.dir!, "brand.json"), "utf-8")).concept.title;
    assert.equal(chosenDefault, chosenA, "unclear → recommended");
    assert.notEqual(chosenB, chosenA);
  });

  test("a fix is kept only if the next look scores no lower", async () => {
    const run = async (afterFix: number) => {
      const dir = repo();
      let first = new Map<string, boolean>();
      const s = scripted({
        scores: (label) => {
          // first look at each is 6; any look that follows a fix uses afterFix
          if (first.get(label)) return afterFix;
          first.set(label, true);
          return 6;
        },
      });
      const r = await runDesign(base(dir, { call: s.call, limits: { rounds: 1 } }), "logo");
      return { r, calls: s.calls };
    };
    const better = await run(8);
    assert.match(fs.readFileSync(path.join(better.r.dir!, "logo.svg"), "utf-8"), /#0a0a0a/, "the better fix is used");
    const worse = await run(2);
    assert.ok(!/#0a0a0a/.test(fs.readFileSync(path.join(worse.r.dir!, "logo.svg"), "utf-8")), "a worse fix is thrown away");
  });

  test("an unusable drawing gets one repair with the exact problems; text is one of them", async () => {
    const dir = repo();
    const calls: Call[] = [];
    const s = scripted();
    const call: DesignDeps["call"] = async (m, msgs, label, json) => {
      calls.push({ models: m, label, messages: msgs });
      if (label === "draw 1") return '<svg viewBox="0 0 100 100"><text x="1" y="1">P</text></svg>';
      if (label === "draw 1 repair") return svgOf("#123456");
      return s.call(m, msgs, label, json);
    };
    await runDesign(base(dir, { call }), "logo");
    const repair = calls.find((c) => c.label === "draw 1 repair")!;
    assert.ok(repair);
    const last = repair.messages[repair.messages.length - 1].content as string;
    assert.match(last, /uses <text>/);
  });

  test("nothing usable from the models is reported plainly, not hidden", async () => {
    const dir = repo();
    const r = await runDesign(base(dir, { call: scripted({ badDraw: true }).call }), "logo");
    assert.equal(r.ok, false);
    assert.match(r.text, /None of the drawings could be used/);
  });

  test("the call budget is a hard ceiling", async () => {
    const dir = repo();
    const s = scripted();
    await runDesign(base(dir, { call: s.call, limits: { maxCalls: 9 } }), "logo");
    assert.ok(s.calls.length <= 9, `${s.calls.length} calls`);
  });

  test("without a browser it says so, writes only SVG, and still finishes", async () => {
    const dir = repo();
    const logs: string[] = [];
    const r = await runDesign(base(dir, { renderer: null, call: scripted().call, log: (l) => logs.push(l) }), "logo");
    assert.ok(r.ok);
    const files = fs.readdirSync(r.dir!);
    assert.ok(files.includes("logo.svg") && files.includes("app-icon.svg"));
    assert.ok(!files.some((f) => f.endsWith(".png") || f.endsWith(".ico")));
    assert.match(r.text, /not looked at and no PNG icons/);
    assert.ok(logs.some((l) => /cannot be looked at/.test(l)));
  });

  test("one model only is a stated limitation, not a silent one", async () => {
    const dir = repo();
    const logs: string[] = [];
    await runDesign(base(dir, { models: ["only/one"], visionModels: ["only/one"], call: scripted().call, log: (l) => logs.push(l) }), "logo");
    assert.ok(logs.some((l) => /Only one model is configured/.test(l)));
  });

  test("a second design never overwrites the first, and files stay inside the project", async () => {
    const dir = repo();
    const a = await runDesign(base(dir, { call: scripted().call }), "logo");
    const b = await runDesign(base(dir, { call: scripted().call }), "logo");
    assert.notEqual(a.dir, b.dir);
    assert.match(b.dir!, /pennywise-v2$/);
    const c = await runDesign(base(dir, { call: scripted().call, limits: { outputDir: "../../outside" } }), "logo");
    assert.ok(path.resolve(c.dir!).startsWith(path.resolve(dir) + path.sep));
  });
});
