/**
 * What the visual-techniques, svg-construction, testing-checklist and mark-types
 * references add, in our own words: craft notes for drawing, a type guide for
 * proposing, a squint view for judging, and a sanitizer that does not punish a
 * harmless <title>.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CRAFT_NOTES, DESIGN_DIRECTOR, proposeConcepts, runDesign, TYPE_GUIDE, type ChatMsg, type DesignDeps } from "../src/designer.js";
import { sanitizeSvg } from "../src/svgSafety.js";
import { sheetHtml } from "../src/svgRender.js";

const svg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#2563eb"/></svg>';
const text = (m: ChatMsg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

const run = async (concepts?: (label: string) => string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  const calls: { label: string; messages: ChatMsg[] }[] = [];
  const call: DesignDeps["call"] = async (_m, messages, label) => {
    calls.push({ label, messages });
    if (label === "brief") return JSON.stringify({ name: "X", offering: "o", audience: "a", personality: [], avoid: [], constraints: [], assumptions: [] });
    if (label.startsWith("concepts")) return (concepts ?? ((l) => JSON.stringify({ concepts: [1, 2].map((k) => ({ title: `T${l}${k}`, markType: "symbol", idea: "i", construction: "c" })) })))(label);
    if (label.startsWith("draw") || label.startsWith("fix")) return svg;
    if (label.startsWith("look")) return JSON.stringify({ score: 7, defects: [] });
    return "{}";
  };
  await runDesign({ repoRoot: dir, models: ["a/x", "b/y"], visionModels: ["b/y"], call, renderer: { png: async () => Buffer.from("P"), page: async () => Buffer.from("G"), close: async () => {} }, log: () => {}, limits: { rounds: 0 } }, "logo");
  return calls;
};

describe("craft notes reach the model that draws", () => {
  test("optical corrections, construction method, merging and balance are in the drawing prompt", async () => {
    const calls = await run();
    const draw = text(calls.find((c) => /^draw \d+$/.test(c.label))!.messages[0]);
    assert.ok(draw.includes(CRAFT_NOTES));
    for (const must of [/overshoot by 1-3 units/, /bone effect/, /horizontals look heavier than verticals/, /about 0\.55 of its radius/, /merge them into one path/, /near-square footprint/, /small corner radius to a full pill/, /1\/32 of the mark width/, /3 to 5 flat steps/, /snap dimensions to multiples of it/]) {
      assert.match(CRAFT_NOTES, must);
    }
  });

  test("the notes are bounded: they add craft, not bulk, to every call", () => {
    assert.ok(CRAFT_NOTES.length < 2200, `${CRAFT_NOTES.length} chars`);
    assert.ok(TYPE_GUIDE.length < 1800, `${TYPE_GUIDE.length} chars`);
    assert.ok(DESIGN_DIRECTOR.length < 3200, `${DESIGN_DIRECTOR.length} chars`);
  });
});

describe("mark types reach the model that proposes", () => {
  test("the guide is in every proposer's prompt, and says no text", async () => {
    const calls = await run();
    const p = text(calls.find((c) => c.label.startsWith("concepts"))!.messages[0]);
    assert.ok(p.includes(TYPE_GUIDE));
    for (const must of [/no wordmark or text/, /letterform: one initial/, /monogram: two or more initials/, /pictorial: a recognisable object/, /abstract: a form for an idea/, /negative-space: .* never force one/, /at least three different types/]) assert.match(TYPE_GUIDE, must);
  });

  test("letterform and pictorial are kept as types, not turned into 'abstract'", async () => {
    const out = await proposeConcepts(
      { models: ["a/x", "b/y"] },
      async (_m, _x, label) =>
        JSON.stringify({ concepts: [{ title: `L ${label}`, markType: "letterform", idea: "i", construction: "c" }, { title: `P ${label}`, markType: "pictorial", idea: "i", construction: "c" }, { title: `N ${label}`, markType: "made-up-type", idea: "i", construction: "c" }] }),
      { name: "X", offering: "", audience: "", personality: [], avoid: [], constraints: [], assumptions: [] },
      6
    );
    const types = new Set(out.map((c) => c.markType));
    assert.ok(types.has("letterform") && types.has("pictorial"));
    assert.ok(types.has("abstract"), "an unknown type falls back to abstract");
    assert.ok(!types.has("made-up-type"));
  });
});

describe("what the judge looks at", () => {
  test("a squint copy is on every sheet, and the judge is told what to check in it", async () => {
    const html = sheetHtml([{ label: "A", svg, small: [] }], 1);
    assert.match(html, /filter:blur\(2\.5px\)/);
    assert.match(html, /<span>squint<\/span>/);
    const calls = await run();
    const judge = text(calls.find((c) => c.label.startsWith("look"))!.messages[0]);
    assert.match(judge, /a blurred \(squint\) copy/);
    assert.match(judge, /\(7\) squint: in the blurred copy the silhouette alone must still be distinctive/);
    assert.match(judge, /\(8\) optical: round forms look smaller than flat ones/);
  });
});

describe("a harmless label is not a reason to redraw", () => {
  test("title, desc and metadata are dropped quietly, with no problem raised", () => {
    const r = sanitizeSvg(
      '<svg viewBox="0 0 100 100" role="img" aria-labelledby="t"><title id="t">Harbor logo</title><desc>a logo</desc><metadata><x>y</x></metadata><circle cx="50" cy="50" r="40" fill="#2563eb"/></svg>'
    );
    assert.deepEqual(r.problems, []);
    assert.ok(r.svg);
    assert.ok(!/title|desc|metadata|Harbor/.test(r.svg!));
    assert.match(r.svg!, /<circle/);
  });

  test("real problems are still reported next to them", () => {
    const r = sanitizeSvg('<svg viewBox="0 0 100 100"><title>x</title><script>1</script><text>P</text><circle cx="5" cy="5" r="4"/></svg>');
    assert.ok(r.problems.some((p) => /uses <text>/.test(p)));
    assert.ok(r.problems.some((p) => /script/.test(p)));
  });
});
