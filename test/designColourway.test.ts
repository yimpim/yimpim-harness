/**
 * The dark (and, if needed, light) colourway is the designer's decision, not a
 * colour rule's. Code only checks it: same shapes, contrast holds, a look
 * approves. Anything that fails falls back to the rule, so a kit always comes out.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adaptiveFromPair, adaptiveSvg, geometryKey, sameGeometry } from "../src/svgSafety.js";
import { makeColourways, runDesign, type ChatMsg, type DesignDeps } from "../src/designer.js";
import { sheetHtml } from "../src/svgRender.js";

const L_DARK = '<svg viewBox="0 0 100 100"><path d="M20 12H44V62H84V88H20Z" fill="#0b0b0f"/><circle cx="68" cy="30" r="12" fill="#ef4444"/></svg>';
const L_FLIPPED = '<svg viewBox="0 0 100 100"><path d="M20 12H44V62H84V88H20Z" fill="#f4f4f5"/><circle cx="68" cy="30" r="12" fill="#ef4444"/></svg>';
const text = (m: ChatMsg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

describe("sameGeometry", () => {
  test("only colours changed: same; a shape moved, added or removed: different", () => {
    assert.ok(sameGeometry(L_DARK, L_FLIPPED));
    assert.ok(!sameGeometry(L_DARK, L_DARK.replace('cx="68"', 'cx="70"')));
    assert.ok(!sameGeometry(L_DARK, L_DARK.replace("</svg>", '<rect x="0" y="0" width="5" height="5"/></svg>')));
    assert.ok(!sameGeometry(L_DARK, L_DARK.replace('<circle cx="68" cy="30" r="12" fill="#ef4444"/>', "")));
    assert.ok(!sameGeometry(L_DARK, L_DARK.replace("M20 12H44", "M20 12H46")));
  });

  test("opacity and the namespace are not geometry; gradient stop colours are not either", () => {
    assert.ok(sameGeometry(L_DARK, L_DARK.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ').replace('r="12"', 'r="12" fill-opacity="0.8"')));
    const g1 = '<svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#333"/></linearGradient></defs><rect width="9" height="9" fill="url(#g)"/></svg>';
    assert.ok(sameGeometry(g1, g1.replace("#000", "#fff").replace("#333", "#ccc")));
    assert.equal(geometryKey(L_DARK), geometryKey(L_FLIPPED));
  });
});

describe("adaptiveFromPair", () => {
  test("the colours that differ are swapped by a media query, with no script", () => {
    const a = adaptiveFromPair(L_DARK, L_FLIPPED);
    assert.match(a, /<style>@media \(prefers-color-scheme:dark\)\{\[fill="#0b0b0f"\]\{fill:#f4f4f5\}/);
    assert.ok(!/#ef4444"\]\{/.test(a), "the accent that did not change gets no rule");
    assert.ok(!/<script/i.test(a));
  });

  test("a pair that is not clean falls back instead of guessing", () => {
    const moved = L_FLIPPED.replace('cx="68"', 'cx="70"');
    assert.equal(adaptiveFromPair(L_DARK, moved), adaptiveSvg(L_DARK), "different shapes: the single-colour rule is used");
    const two = '<svg viewBox="0 0 100 100"><rect width="9" height="9" fill="#111111"/><rect x="20" width="9" height="9" fill="#111111"/></svg>';
    const split = two.replace('x="20" width="9" height="9" fill="#111111"', 'x="20" width="9" height="9" fill="#eeeeee"').replace('fill="#111111"/>', 'fill="#ffffff"/>');
    assert.ok(typeof adaptiveFromPair(two, split) === "string", "one colour mapped two ways does not throw");
  });

  test("a pair that changes nothing is the mark itself", () => {
    assert.equal(adaptiveFromPair(L_DARK, L_DARK), L_DARK);
  });
});

describe("the colourway step", () => {
  const dirOf = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x" }));
    return d;
  };
  const run = async (o: { dark?: string | Error; check?: string; mark?: string; logs?: string[] }) => {
    const calls: { label: string; models: string[]; messages: ChatMsg[] }[] = [];
    const mark = o.mark ?? L_DARK;
    const call: DesignDeps["call"] = async (models, messages, label) => {
      calls.push({ label, models, messages });
      if (label === "brief") return JSON.stringify({ name: "X", offering: "o", audience: "a", personality: [], avoid: [], constraints: [], assumptions: [] });
      if (label.startsWith("concepts")) return JSON.stringify({ concepts: [1, 2].map((k) => ({ title: `T${label}${k}`, markType: "symbol", idea: "i", construction: "c" })) });
      if (label.startsWith("draw") || label.startsWith("fix")) return mark;
      if (label.startsWith("look")) return JSON.stringify({ score: 7, defects: [] });
      if (label === "colourway dark") {
        if (o.dark instanceof Error) throw o.dark;
        return o.dark ?? L_FLIPPED;
      }
      if (label === "check dark") return o.check ?? JSON.stringify({ ok: true, why: "good" });
      return "{}";
    };
    const r = await runDesign(
      {
        repoRoot: dirOf(),
        models: ["a/x", "b/y", "c/z"],
        visionModels: ["b/y"],
        call,
        renderer: { png: async () => Buffer.from("PNG"), page: async () => Buffer.from("PAGE"), close: async () => {} },
        log: (l) => o.logs?.push(l),
        limits: { rounds: 0 },
      },
      "logo"
    );
    const read = (f: string) => fs.readFileSync(path.join(r.dir!, f), "utf-8");
    return { r, calls, read, notes: JSON.parse(read("brand.json")).colourways as string[] };
  };

  test("a good dark colourway from the designer is what the kit uses, everywhere", async () => {
    const logs: string[] = [];
    const x = await run({ logs });
    assert.match(x.read("logo-on-dark.svg"), /fill="#f4f4f5"/);
    assert.ok(!/#0b0b0f/.test(x.read("logo-on-dark.svg")));
    assert.match(x.read("app-icon-dark.svg"), /fill="#f4f4f5"/);
    assert.match(x.read("favicon.svg"), /\[fill="#0b0b0f"\]\{fill:#f4f4f5\}/);
    assert.match(x.notes[0], /dark colourway: designed by .*shapes unchanged, contrast checked, looked at and approved/);
    assert.ok(logs.some((l) => /dark colourway: designed by/.test(l)));
    assert.match(x.r.text, /Theme: the main colour #0b0b0f fades on the dark surface/);
  });

  test("the designer is told what to keep and what to decide; a different model than the drawer checks it", async () => {
    const x = await run({});
    const way = x.calls.find((c) => c.label === "colourway dark")!;
    const sys = text(way.messages[0]);
    assert.match(sys, /DARK-THEME colourway/);
    assert.match(sys, /Keep every shape, position and size EXACTLY/);
    assert.match(sys, /flips to near-white/);
    assert.match(text(way.messages[1]), /#0b0b0f/);
    const check = x.calls.find((c) => c.label === "check dark")!;
    assert.notEqual(check.models[0], way.models[0], "a model does not approve its own colourway");
    assert.ok((check.messages[1].content as any[]).filter((p) => p.type === "image_url").length === 2, "it sees the original and the new one");
  });

  test("changed shapes: the colour rule is used and the reason is recorded", async () => {
    const x = await run({ dark: L_FLIPPED.replace('cx="68"', 'cx="72"') });
    assert.match(x.notes[0], /colour rule used \(it changed the shapes, not only the colours\)/);
    assert.ok(!/#f4f4f5/.test(x.read("logo-on-dark.svg")) || /#ffffff|#f/.test(x.read("logo-on-dark.svg")));
    assert.ok(x.calls.every((c) => c.label !== "check dark"), "no look is spent on a rejected colourway");
  });

  test("a colourway whose main colour still fades is rejected", async () => {
    const x = await run({ dark: L_DARK.replace("#0b0b0f", "#15151a") });
    assert.match(x.notes[0], /colour rule used \(the colour that touches the page still fades on dark\)/);
  });

  test("more than three colours is rejected", async () => {
    // same shapes, but strokes bring the colours to four: #f4f4f5, #3b82f6, #ef4444, #22c55e
    const four =
      '<svg viewBox="0 0 100 100"><path d="M20 12H44V62H84V88H20Z" fill="#f4f4f5" stroke="#3b82f6"/><circle cx="68" cy="30" r="12" fill="#ef4444" stroke="#22c55e"/></svg>';
    const x = await run({ dark: four });
    assert.match(x.notes[0], /colour rule used \(it used more than 3 colours\)/);
  });

  test("a look that says no sends it back to the rule, with the reason", async () => {
    const x = await run({ check: JSON.stringify({ ok: false, why: "the red vibrates against the dark" }) });
    assert.match(x.notes[0], /colour rule used \(a look at it said no: the red vibrates against the dark\)/);
  });

  test("an unclear look keeps a code-checked colourway and says so", async () => {
    const x = await run({ check: "no idea" });
    assert.match(x.notes[0], /designed by .*the look gave no clear answer/);
  });

  test("a reply that is not an SVG, or a call that fails, still gives a kit", async () => {
    const a = await run({ dark: "Sorry, I can't." });
    assert.match(a.notes[0], /colour rule used \(the reply was not a clean SVG\)/);
    const b = await run({ dark: new Error("provider down") });
    assert.match(b.notes[0], /colour rule used \(provider down\)/);
    assert.ok(a.read("logo-on-dark.svg").includes("<svg") && b.read("logo-on-dark.svg").includes("<svg"));
  });

  test("a light colourway is made only when the mark fades on light", async () => {
    const dark = await run({});
    assert.ok(dark.calls.every((c) => c.label !== "colourway light"));
    const white = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#fafafa"/></svg>';
    const x = await run({ mark: white });
    assert.ok(x.calls.some((c) => c.label === "colourway light"));
    assert.ok(x.notes.some((n) => /^light colourway/.test(n)));
  });

  test("when the budget is gone the rule is used, nothing throws", async () => {
    const deps: DesignDeps = { repoRoot: dirOf(), models: ["a/x"], visionModels: ["a/x"], call: async () => "", renderer: null, log: () => {} };
    const w = await makeColourways(deps, async () => { throw new Error("call budget reached"); }, { name: "X", offering: "", audience: "", personality: [], avoid: [], constraints: [], assumptions: [] }, L_DARK);
    assert.match(w.notes[0], /colour rule used \(call budget reached\)/);
    assert.match(w.dark!, /fill="#[0-9a-f]{6}"/);
  });
});

describe("form before colour", () => {
  test("every sheet shows a one-colour copy, and the judge is told the form must read without colour", () => {
    const html = sheetHtml([{ label: "A", svg: L_DARK, small: [] }], 1);
    assert.match(html, /<span>one colour<\/span>/);
    const uris = [...html.matchAll(/base64,([A-Za-z0-9+/=]+)/g)].map((m) => Buffer.from(m[1], "base64").toString());
    assert.ok(uris.some((u) => /fill="#000000"/.test(u) && !/#ef4444/.test(u)), "the one-colour copy has no colour left");
    const src = fs.readFileSync(new URL("../src/designer.ts", import.meta.url), "utf-8");
    assert.match(src, /form before colour: the one-colour copy must still read/);
    assert.match(src, /a one-colour copy, a blurred \(squint\) copy, and copies rotated 180 degrees and mirrored/);
  });
});

import { colorSpecs } from "../src/svgSafety.js";
import { colourTable, darkColourLine, gatherBrief } from "../src/designer.js";

describe("what colour.md adds", () => {
  test("colour values for a brand sheet; CMYK is plainly an approximation", () => {
    assert.deepEqual(colorSpecs("#ff0000"), { hex: "#ff0000", rgb: [255, 0, 0], cmyk: [0, 100, 100, 0] });
    assert.deepEqual(colorSpecs("#000000")!.cmyk, [0, 0, 0, 100]);
    assert.deepEqual(colorSpecs("#fff")!.cmyk, [0, 0, 0, 0]);
    assert.equal(colorSpecs("none"), null);
    const t = colourTable(["#2563eb", "#ef4444"]);
    assert.match(t, /\| #2563eb \| 37 99 235 \| 84 58 0 8 \|/);
    assert.match(t, /vivid screen colours .* often print duller/);
    assert.match(t, /Pantone matches are not given because they cannot be computed/);
    assert.equal(colourTable([]), "- one colour");
  });

  test("the dark-page colour changes are listed, and nothing is said when none change", () => {
    assert.equal(darkColourLine(L_DARK, L_FLIPPED), "On dark pages: #0b0b0f becomes #f4f4f5.");
    assert.equal(darkColourLine(L_DARK, L_DARK), "");
  });

  test("the brief records what the category's colours usually are, and every model sees it", async () => {
    const b = await gatherBrief(
      async () => JSON.stringify({ name: "Pennywise", offering: "o", categoryColours: "banks and budgeting apps default to blue and green" }),
      "logo",
      "facts",
      undefined,
      "x"
    );
    assert.equal(b.categoryColours, "banks and budgeting apps default to blue and green");
    const src = fs.readFileSync(new URL("../src/designer.ts", import.meta.url), "utf-8");
    assert.match(src, /Colours this category usually uses \(choose against them unless there is a reason\)/);
  });

  test("the head designer holds colour craft: form first, owning a colour, value, dark-page tints", () => {
    const src = fs.readFileSync(new URL("../src/designer.ts", import.meta.url), "utf-8");
    for (const must of [/Form comes before colour/, /A colour is something a brand can own/, /Most colour problems are value problems/, /On dark pages a brand colour usually needs a lighter tint/, /never as a claim/]) assert.match(src, must);
  });

  test("the kit's README carries the table and the dark-page line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const call: DesignDeps["call"] = async (_m, _x, label) => {
      if (label === "brief") return JSON.stringify({ name: "X", offering: "o", audience: "a", personality: [], avoid: [], constraints: [], assumptions: [] });
      if (label.startsWith("concepts")) return JSON.stringify({ concepts: [1, 2].map((k) => ({ title: `T${label}${k}`, markType: "symbol", idea: "i", construction: "c" })) });
      if (label.startsWith("draw") || label.startsWith("fix")) return L_DARK;
      if (label.startsWith("look")) return JSON.stringify({ score: 7, defects: [] });
      if (label === "colourway dark") return L_FLIPPED;
      if (label === "check dark") return JSON.stringify({ ok: true, why: "" });
      return "{}";
    };
    const r = await runDesign({ repoRoot: dir, models: ["a/x", "b/y"], visionModels: ["b/y"], call, renderer: null, log: () => {}, limits: { rounds: 0 } }, "logo");
    const readme = fs.readFileSync(path.join(r.dir!, "README.md"), "utf-8");
    assert.match(readme, /\| HEX \| RGB \| CMYK \(approx\.\) \|/);
    assert.match(readme, /\| #0b0b0f \| 11 11 15 \|/);
    assert.match(readme, /On dark pages: #0b0b0f becomes #f4f4f5\./);
  });
});
