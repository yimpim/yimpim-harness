/**
 * Critique and redesign: both start from a logo that already exists, so both
 * start by looking at it. The model judges; code reads the file safely, bounds
 * what comes back, and works out the total itself.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIMENSIONS, equityConstraints, loadExistingLogo, parseCritique, parseEquity, renderCritique, type Critique } from "../src/designCritique.js";
import { runDesign, type ChatMsg, type DesignDeps } from "../src/designer.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#2563eb"/></svg>';
const repo = (files: Record<string, string | Buffer> = {}): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcr-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pennywise", description: "budgeting" }));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};
const renderer = { png: async () => Buffer.from("PNG"), page: async () => Buffer.from("PAGE"), close: async () => {} };
const text = (m: ChatMsg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

const goodScores = Object.fromEntries(DIMENSIONS.map((d, i) => [d, 3 + (i % 3)]));

describe("parseCritique", () => {
  test("scores are clamped to 1-5, the total is worked out here, not taken from the model", () => {
    const c = parseCritique(JSON.stringify({ firstImpression: "Clean.", works: ["simple"], scores: { idea: 9, simplicity: 0.2, craft: 4, total: 50, distinction: "x" }, fatalFlaw: null, changes: ["a", "b"], total: 50 }))!;
    assert.deepEqual(c.scores, { idea: 5, simplicity: 1, craft: 4 });
    assert.equal(c.total, 10);
    assert.equal(c.outOf, 15);
  });

  test("a dimension that could not be judged is left out, not scored zero", () => {
    const { typography, ...rest } = goodScores;
    const c = parseCritique(JSON.stringify({ scores: rest, changes: [] }))!;
    assert.equal(c.scores.typography, undefined);
    assert.equal(c.outOf, 45);
  });

  test("fewer than three real scores is not a scorecard", () => {
    assert.equal(parseCritique(JSON.stringify({ scores: { idea: 4, craft: 4 } })), null);
    assert.equal(parseCritique("it looks fine"), null);
  });

  test("'none' is not a fatal flaw; lists are bounded; JSON in prose is found", () => {
    const c = parseCritique('Here: ' + JSON.stringify({ scores: goodScores, fatalFlaw: "None.", changes: ["1", "2", "3", "4", "5"], works: ["a", "b", "c", "d"] }))!;
    assert.equal(c.fatalFlaw, null);
    assert.equal(c.changes.length, 3);
    assert.equal(c.works.length, 3);
    assert.equal(parseCritique(JSON.stringify({ scores: goodScores, fatalFlaw: "It reads as a different company's mark." }))!.fatalFlaw, "It reads as a different company's mark.");
  });

  test("the written critique carries the scorecard, the fatal flaw and the order of changes", () => {
    const c: Critique = { firstImpression: "Generic.", works: ["round"], scores: { idea: 2, craft: 4, colour: 3 }, fatalFlaw: "No idea.", changes: ["Find one idea", "Fix the gap"], total: 9, outOf: 15 };
    const md = renderCritique(c, "Pennywise");
    assert.match(md, /# Critique of the Pennywise logo/);
    assert.match(md, /\| idea \| 2 \|/);
    assert.match(md, /9 of 15, a rough guide: one fatal flaw outweighs a high total/);
    assert.match(md, /\*\*Fatal flaw\.\*\* No idea\./);
    assert.match(md, /1\. Find one idea\n2\. Fix the gap/);
    assert.ok(!/typography/.test(md), "unscored dimensions are not listed");
  });
});

describe("parseEquity", () => {
  test("a refresh that keeps nothing is a rebuild", () => {
    assert.equal(parseEquity(JSON.stringify({ strategy: "refresh", keep: [], change: ["all"], why: "w" }))!.strategy, "rebuild");
    assert.equal(parseEquity(JSON.stringify({ strategy: "refresh", keep: ["the blue disc"], change: [], why: "w" }))!.strategy, "refresh");
    assert.equal(parseEquity("nope"), null);
  });

  test("it becomes constraints the normal pipeline works within", () => {
    const c = equityConstraints({ strategy: "refresh", keep: ["the blue disc", "the check"], change: ["the stroke weight"], why: "" });
    assert.deepEqual(c, ["Keep (it is what people recognise): the blue disc", "Keep (it is what people recognise): the check", "Free to change: the stroke weight", "This is a refresh: evolve the mark, do not replace the idea."]);
    assert.ok(equityConstraints({ strategy: "rebuild", keep: [], change: [], why: "" }).some((x) => /rebuild: a new idea is allowed/.test(x)));
  });
});

describe("loadExistingLogo", () => {
  test("an SVG in the project is shown on a light and a dark page", async () => {
    const dir = repo({ "assets/logo.svg": SVG });
    const r = await loadExistingLogo(dir, "assets/logo.svg", renderer);
    assert.ok("logo" in r);
    if ("logo" in r) {
      assert.equal(r.logo.kind, "svg");
      assert.equal(r.logo.images.length, 2);
      assert.match(r.logo.svg!, /<circle/);
    }
  });

  test("a raster is shown as it is, and needs no browser", async () => {
    const dir = repo({ "assets/logo.png": Buffer.from("PNGBYTES") });
    const r = await loadExistingLogo(dir, "assets/logo.png", null);
    assert.ok("logo" in r && r.logo.images[0].startsWith("data:image/png;base64,"));
  });

  test("what cannot be looked at says why, and never reads outside the project", async () => {
    const dir = repo({ "assets/logo.svg": SVG, "notes.txt": "x", "big.png": Buffer.alloc(6 * 1024 * 1024) });
    assert.match((await loadExistingLogo(dir, "assets/logo.svg", null) as any).error, /needs a browser/);
    assert.match((await loadExistingLogo(dir, "notes.txt", renderer) as any).error, /only SVG, PNG, JPG and WebP/);
    assert.match((await loadExistingLogo(dir, "big.png", renderer) as any).error, /over 5 MB/);
    assert.match((await loadExistingLogo(dir, "../outside.png", renderer) as any).error, /not in the project/);
    assert.match((await loadExistingLogo(dir, "missing.svg", renderer) as any).error, /not in the project/);
    assert.match((await loadExistingLogo(dir, path.resolve(dir, "assets/logo.svg"), renderer) as any).error, /not in the project/, "an absolute path is not accepted");
    assert.match((await loadExistingLogo(dir, undefined, renderer) as any).error, /not in the project/);
  });

  test("an SVG that is not a drawing is refused, not rendered", async () => {
    const dir = repo({ "bad.svg": "<html>not svg</html>" });
    assert.match((await loadExistingLogo(dir, "bad.svg", renderer) as any).error, /could not be read as a drawing/);
  });
});

// ---------------------------------------------------------------------------

function script(o: { mode?: string; existing?: string | null; critique?: string; equity?: string; throwCritique?: boolean }) {
  const calls: { label: string; models: string[]; messages: ChatMsg[] }[] = [];
  const call: DesignDeps["call"] = async (models, messages, label) => {
    calls.push({ label, models, messages });
    if (label === "brief") return JSON.stringify({ name: "Pennywise", offering: "budgeting", audience: "students", personality: [], avoid: [], constraints: [], assumptions: [], mode: o.mode, existing: o.existing });
    if (label === "critique") {
      if (o.throwCritique) throw new Error("vision down");
      return o.critique ?? JSON.stringify({ firstImpression: "A plain disc.", works: ["simple"], scores: goodScores, fatalFlaw: null, changes: ["Add one distinctive move", "Open the gap", "Deepen the blue"] });
    }
    if (label === "equity") return o.equity ?? JSON.stringify({ strategy: "refresh", keep: ["the blue disc"], change: ["the weight"], why: "People know the blue disc." });
    if (label.startsWith("concepts")) return JSON.stringify({ concepts: [1, 2].map((k) => ({ title: `T${label}${k}`, markType: "symbol", idea: "i", construction: "c" })) });
    if (label.startsWith("draw") || label.startsWith("fix")) return SVG;
    if (label.startsWith("look")) return JSON.stringify({ score: 7, defects: [] });
    return "{}";
  };
  return { calls, call };
}

const run = async (o: Parameters<typeof script>[0], files: Record<string, string | Buffer> = { "assets/logo.svg": SVG }, over: Partial<DesignDeps> = {}) => {
  const dir = repo(files);
  const s = script(o);
  const shown: string[] = [];
  const r = await runDesign({ repoRoot: dir, models: ["a/x", "b/y"], visionModels: ["b/y"], call: s.call, renderer, log: () => {}, show: (l) => shown.push(l), limits: { rounds: 0 }, ...over }, "request");
  return { r, calls: s.calls, dir, shown };
};

describe("critique mode", () => {
  test("it looks at the logo, writes the scorecard, redesigns nothing, and spends only the calls it needs", async () => {
    const x = await run({ mode: "critique", existing: "assets/logo.svg" });
    assert.ok(x.r.ok);
    assert.deepEqual(x.calls.map((c) => c.label), ["brief", "critique"]);
    assert.match(x.r.text, /# Critique of the Pennywise logo/);
    assert.match(x.r.text, /Nothing was redesigned/);
    assert.ok(fs.existsSync(path.join(x.r.dir!, "critique.md")));
    assert.ok(!fs.existsSync(path.join(x.r.dir!, "logo.svg")), "no kit is made for a critique");
    assert.deepEqual(x.shown, ["Current logo"]);
  });

  test("a vision model critiques it, with both pages, the method, and the scorecard asked for", async () => {
    const x = await run({ mode: "critique", existing: "assets/logo.svg" });
    const c = x.calls.find((c) => c.label === "critique")!;
    assert.deepEqual(c.models, ["b/y"]);
    const sys = text(c.messages[0]);
    for (const must of [/Critique the work, never the person/, /A single fatal flaw can outweigh a high total/, /mush when small = too much detail/, /"idea": 1-5/, /"typography": 1-5/, /leave out a dimension you cannot judge/]) assert.match(sys, must);
    const images = (c.messages[1].content as any[]).filter((p) => p.type === "image_url");
    assert.equal(images.length, 2);
    assert.match(text(c.messages[1]), /Image 1 is the logo on a light page, image 2 on a dark page/);
  });

  test("a logo it cannot look at is reported, and a new logo is NOT designed in its place", async () => {
    const x = await run({ mode: "critique", existing: "nope/logo.svg" });
    assert.equal(x.r.ok, false);
    assert.match(x.r.text, /I could not look at the logo to critique: that file is not in the project/);
    assert.deepEqual(x.calls.map((c) => c.label), ["brief"]);
  });

  test("a critique that fails or comes back as nonsense says so", async () => {
    const a = await run({ mode: "critique", existing: "assets/logo.svg", throwCritique: true });
    assert.match(a.r.text, /The critique could not be made/);
    const b = await run({ mode: "critique", existing: "assets/logo.svg", critique: "looks nice" });
    assert.equal(b.r.ok, false);
  });

  test("a file the model made up cannot be read: only what is on disk inside the project", async () => {
    const x = await run({ mode: "critique", existing: "../../etc/passwd" });
    assert.equal(x.r.ok, false);
    assert.ok(!x.calls.some((c) => c.label === "critique"));
  });

  test("a logo the person attached from a phone can be critiqued", async () => {
    const x = await run({ mode: "critique", existing: ".agent/attachments/my-logo.png" }, { ".agent/attachments/my-logo.png": Buffer.from("PNG") });
    assert.ok(x.r.ok, x.r.text);
    const brief = text(x.calls[0].messages[1]);
    assert.match(brief, /\.agent\/attachments\/my-logo\.png/, "the attachment is listed to the brief writer");
  });
});

describe("redesign mode", () => {
  test("diagnosis, then an equity audit, then the normal pipeline working within what must be kept", async () => {
    const x = await run({ mode: "redesign", existing: "assets/logo.svg" });
    assert.ok(x.r.ok, x.r.text);
    const labels = x.calls.map((c) => c.label);
    assert.deepEqual(labels.slice(0, 3), ["brief", "critique", "equity"]);
    assert.ok(labels.some((l) => l.startsWith("concepts")) && labels.some((l) => /^draw/.test(l)));
    const concepts = text(x.calls.find((c) => c.label.startsWith("concepts"))!.messages[1]);
    assert.match(concepts, /Keep \(it is what people recognise\): the blue disc/);
    assert.match(concepts, /This is a refresh: evolve the mark, do not replace the idea/);
    assert.match(concepts, /REDESIGN of an existing logo/);
    assert.match(concepts, /The current logo's source \(being refreshed\)/);
    assert.match(concepts, /<circle/);
  });

  test("the diagnosis is saved with the kit, and the current logo was shown first", async () => {
    const x = await run({ mode: "redesign", existing: "assets/logo.svg" });
    const d = fs.readFileSync(path.join(x.r.dir!, "diagnosis.md"), "utf-8");
    assert.match(d, /# Critique of the Pennywise logo/);
    assert.match(d, /## Equity audit/);
    assert.match(d, /Strategy: refresh\. People know the blue disc\./);
    assert.equal(x.shown[0], "Current logo");
    assert.match(x.r.text, /diagnosis\.md/);
    assert.ok(fs.existsSync(path.join(x.r.dir!, "logo.svg")));
  });

  test("the redesign is recorded as an assumption, so the person sees why", async () => {
    const x = await run({ mode: "redesign", existing: "assets/logo.svg" });
    assert.match(x.r.text, /Assumed: .*Redesign \(refresh\): People know the blue disc\./);
  });

  test("with no usable logo it designs a new one and says that is what it did", async () => {
    const x = await run({ mode: "redesign", existing: "nope.svg" });
    assert.ok(x.r.ok);
    assert.match(x.r.text, /No existing logo could be looked at \(that file is not in the project\), so this was designed as a new logo/);
    assert.ok(!x.calls.some((c) => c.label === "equity"));
  });

  test("an audit that fails does not stop the redesign, and nothing is claimed as 'keep'", async () => {
    const x = await run({ mode: "redesign", existing: "assets/logo.svg", equity: "no idea" });
    assert.ok(x.r.ok);
    assert.match(x.r.text, /equity audit could not be made/);
    assert.ok(!/Keep \(it is what people recognise\)/.test(text(x.calls.find((c) => c.label.startsWith("concepts"))!.messages[1])));
  });

  test("a rebuild is allowed to bring a new idea", async () => {
    const x = await run({ mode: "redesign", existing: "assets/logo.svg", equity: JSON.stringify({ strategy: "rebuild", keep: ["the blue"], change: ["everything else"], why: "It resembles a competitor." }) });
    assert.match(text(x.calls.find((c) => c.label.startsWith("concepts"))!.messages[1]), /This is a rebuild: a new idea is allowed/);
  });
});

describe("a new logo is unchanged by all this", () => {
  test("no look at an existing file, no critique, no equity audit", async () => {
    const x = await run({ mode: "new" });
    assert.ok(!x.calls.some((c) => c.label === "critique" || c.label === "equity"));
    assert.ok(x.r.ok);
  });

  test("an unknown or missing mode means new", async () => {
    const x = await run({ mode: "something else", existing: "assets/logo.svg" });
    assert.ok(!x.calls.some((c) => c.label === "critique"));
  });
});

describe("routing", () => {
  test("the classifier sends critique and refresh requests to the Designer, and the help says so", () => {
    const prompts = fs.readFileSync(new URL("../src/prompts.ts", import.meta.url), "utf-8");
    assert.match(prompts, /asking for feedback on, or a refresh or redesign of, a logo or brand mark they already have/);
    const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.match(idx, /also critiques or refreshes/);
  });
});
