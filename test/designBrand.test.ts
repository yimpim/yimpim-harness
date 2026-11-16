import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLICHES, DEFAULTS_NOTE, clicheHits, colourDefaultHit } from "../src/designDefaults.js";
import { pageColours, readRivals, safeToFetch } from "../src/competitors.js";
import { drawSmallMark, needsSmallMark } from "../src/smallMark.js";
import { auditSvg } from "../src/svgSafety.js";
import { buildPalette, parsePaletteChoice } from "../src/palette.js";
import { guidelinesHtml } from "../src/guidelines.js";
import { clichePenalty, conceptHits, runDesign, type ChatMsg, type DesignDeps } from "../src/designer.js";
import type { Renderer } from "../src/svgRender.js";

const circle = (c: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="38" fill="${c}"/></svg>`;

describe("the default and cliché list", () => {
  test("matches whole words in a concept, not substrings", () => {
    assert.deepEqual(clicheHits("A leaf in a circle").map((c) => c.id), ["leaf"]);
    assert.deepEqual(clicheHits("A shield with a bolt").map((c) => c.id).sort(), ["bolt", "shield"]);
    assert.deepEqual(clicheHits("A leafy hexagon").map((c) => c.id), ["hexagon"]);
    assert.deepEqual(clicheHits("Two offset squares sharing an edge"), []);
    assert.deepEqual(clicheHits("An arrowhead-free notch"), []);
  });
  test("every cliché has a label and at least one pattern", () => {
    for (const c of CLICHES) assert.ok(c.label && c.words.length > 0, c.id);
  });
  test("the note tells models how to justify a default and to offer one that avoids them", () => {
    assert.match(DEFAULTS_NOTE, /would I propose this same one for another brand in this sector/);
    assert.match(DEFAULTS_NOTE, /'feels warm' or 'feels premium' is not a reason/);
    assert.match(DEFAULTS_NOTE, /at least one concept that uses none/);
  });
  test("the colour clusters are found on the real colours: cream + terracotta + gold, and navy + gold", () => {
    assert.match(colourDefaultHit("#c2603a", "#d4a937", "warm") ?? "", /terracotta and gold/);
    assert.equal(colourDefaultHit("#c2603a", "#d4a937", "white"), null);
    assert.match(colourDefaultHit("#14284b", "#d4a937", "white") ?? "", /navy with gold/);
    assert.equal(colourDefaultHit("#2563eb", "#e11d48", "warm"), null);
  });
  test("a default palette is flagged by the palette checks, a distinct one is not", () => {
    const flagged = buildPalette(["#c2603a", "#d4a937"], parsePaletteChoice({ ground: "warm" }, []));
    assert.equal(flagged.checks.find((c) => c.id === "ai-default-colours")?.status, "fail");
    const fine = buildPalette(["#0d9488", "#e11d48"], parsePaletteChoice({ ground: "white" }, []));
    assert.equal(fine.checks.find((c) => c.id === "ai-default-colours")?.status, "pass");
  });
  test("a cliché without a reason costs more than one with a reason", () => {
    const c = { title: "Leaf", markType: "pictorial", idea: "a leaf", construction: "a leaf shape", by: "x" };
    assert.ok(conceptHits(c).includes("leaf"));
    assert.equal(clichePenalty(c), 1.5);
    assert.equal(clichePenalty({ ...c, why: "the product is a plant shop" }), 0.5);
    assert.equal(clichePenalty({ ...c, title: "Cut", idea: "a cut", construction: "two squares" }), 0);
  });
});

describe("competitors", () => {
  test("pages: a chromatic theme-color wins; otherwise the most used chromatic hex; fonts skip generic stacks", () => {
    const a = pageColours('<meta name="theme-color" content="#ff5a1f"><style>a{color:#2563eb}</style>');
    assert.equal(a.primary, "#ff5a1f");
    const b = pageColours("<style>.a{color:#2563eb}.b{background:#2563eb}.c{color:#2563eb}.d{color:#111}.e{color:#fafafa}h1{font-family:'Fraunces',serif}p{font-family:Inter,system-ui,sans-serif}</style>");
    assert.equal(b.primary, "#2563eb");
    assert.deepEqual(b.fonts.sort(), ["Fraunces", "Inter"]);
    assert.equal(pageColours("<style>a{color:#2563eb}</style>").primary, null, "one use is not a brand colour");
    assert.equal(pageColours('<meta name="theme-color" content="#ffffff"><p>hi</p>').primary, null);
  });
  test("a page that cannot be read falls back to the model's recalled colour, labelled so; no colour at all drops it", async () => {
    const logs: string[] = [];
    const rivals = await readRivals(
      async () => ({ rivals: [{ name: "Read", url: "https://read.example", hex: null }, { name: "Recalled", url: "https://gone.example", hex: "#e11d48" }, { name: "Nothing", url: "https://none.example", hex: null }] }),
      async (u) => (u.includes("read.") ? '<meta name="theme-color" content="#0d9488">' : null),
      (l) => logs.push(l)
    );
    assert.deepEqual(rivals.map((r) => [r.name, r.hex, r.source]), [["Read", "#0d9488", "measured"], ["Recalled", "#e11d48", "recalled"]]);
    assert.match(logs[0], /Competitors: Read #0d9488 \(measured\), Recalled #e11d48 \(recalled\)/);
  });
  test("a model that fails or returns junk gives no rivals, and no error", async () => {
    assert.deepEqual(await readRivals(async () => { throw new Error("x"); }, async () => null, () => {}), []);
    assert.deepEqual(await readRivals(async () => "nonsense", async () => null, () => {}), []);
  });
  test("the fetch guard refuses non-web schemes, credentials, loopback and private addresses", async () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com", "http://localhost/x", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "https://user:pw@example.com/", "http://nas.local/", "not a url", "http://172.16.0.1/", "http://0.0.0.0/"]) {
      assert.equal(await safeToFetch(u), null, u);
    }
    assert.ok(await safeToFetch("http://93.184.216.34/"), "a public address is allowed");
  });
});

describe("the small-size mark", () => {
  const busy = `<svg viewBox="0 0 100 100">${Array.from({ length: 10 }, (_, i) => `<circle cx="${10 + i * 8}" cy="50" r="3" fill="#2563eb"/>`).join("")}</svg>`;
  test("worth drawing for a busy mark or a judge's small-size complaint, not for a simple one", () => {
    assert.ok(needsSmallMark(auditSvg(busy), []));
    assert.ok(needsSmallMark(auditSvg(circle("#2563eb")), ["the detail clogs at 16 px"]));
    assert.ok(!needsSmallMark(auditSvg(circle("#2563eb")), ["the curve bulges"]));
  });
  test("accepted only when simpler, drawable, and in the same colours", async () => {
    const orig = auditSvg(busy);
    const ok = await drawSmallMark(async () => circle("#2563eb"), busy, orig);
    assert.ok(ok && ok.audit.shapes === 1);
    assert.equal(await drawSmallMark(async () => circle("#ff0000"), busy, orig), null, "a new colour is refused");
    assert.equal(await drawSmallMark(async () => busy, busy, orig), null, "not simpler");
    assert.equal(await drawSmallMark(async () => "<svg><script>alert(1)</script></svg>", busy, orig), null);
    assert.equal(await drawSmallMark(async () => { throw new Error("x"); }, busy, orig), null);
  });
});

describe("guidelines", () => {
  const palette = buildPalette(["#2563eb", "#f59e0b"], parsePaletteChoice({ ground: "warm" }, []));
  const input = (over: any = {}) => ({
    name: "Pennywise <b>",
    idea: "A coin that is also a door",
    personality: ["calm"],
    logo: { master: circle("#2563eb"), onLight: circle("#2563eb"), onDark: circle("#93c5fd"), black: circle("#000000"), white: circle("#ffffff"), appIcon: circle("#2563eb"), appIconDark: circle("#93c5fd") },
    palette,
    type: { display: "Poppins", body: "Barlow", wordmarkFamily: "Poppins" },
    checks: [{ id: "contrast", kind: "gate", status: "pass", detail: "ok" }, { id: "trademark", kind: "gate", status: "not-checked", detail: "No trademark search was done." }],
    assumptions: ["a"],
    ...over,
  });
  test("has the pages in order, escapes the name, shows measured contrast and says 'not checked' as such", () => {
    const html = guidelinesHtml(input());
    const heads = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);
    assert.deepEqual(heads, ["The idea", "The logo", "Versions", "Misuse", "Colour", "Approved pairs", "Type", "Applications", "Checks and honesty"]);
    assert.ok(!html.includes("Pennywise <b>"));
    assert.match(html, /Pennywise &lt;b&gt;/);
    assert.match(html, /\d+\.\d\d:1/);
    assert.match(html, /not checked: No trademark search was done/);
    assert.match(html, /half the mark's height/);
    assert.match(html, /font-family:"Poppins"/);
    assert.match(html, /@font-face\{font-family:"Barlow"/);
    assert.ok(!/<script/i.test(html));
  });
  test("without a palette or type those pages drop out instead of being faked", () => {
    const html = guidelinesHtml(input({ palette: null, type: null }));
    assert.ok(!/<h2>Colour<\/h2>/.test(html) && !/<h2>Type<\/h2>/.test(html));
  });
});

// ---------------------------------------------------------------------------

const repo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pennywise", description: "budgeting for students" }));
  return dir;
};
const renderer = (): Renderer & { pdfs: number } => {
  const r: any = { pdfs: 0, png: async () => Buffer.from("PNG"), page: async () => Buffer.from("PAGE"), close: async () => {} };
  r.pdf = async () => (r.pdfs++, Buffer.from("%PDF"));
  return r;
};
const lbl = (calls: { label: string }[]) => calls.map((c) => c.label);

function script(over: { palette?: any; rivals?: any; concepts?: (n: string) => any[] } = {}) {
  const calls: { label: string; messages: ChatMsg[] }[] = [];
  const call: DesignDeps["call"] = async (_m, messages, label) => {
    calls.push({ label, messages });
    if (label === "brief") return JSON.stringify({ name: "Pennywise", offering: "budgeting", audience: "students", personality: ["calm"], avoid: [], constraints: [], assumptions: [] });
    if (label === "rivals") return JSON.stringify(over.rivals ?? { rivals: [{ name: "RivalBank", url: "https://rival.example", hex: null }] });
    if (label === "palette") return JSON.stringify(over.palette ?? { names: { "#2563eb": "Pennywise Blue" }, accent: "#e11d48", ground: "white", neutralHue: 250, why: "a calm blue against the category's green" });
    if (label.startsWith("concepts")) {
      const n = label.split(" ")[1];
      return JSON.stringify({ concepts: over.concepts ? over.concepts(n) : [1, 2].map((k) => ({ title: `Idea ${n}${k}`, markType: ["symbol", "lettermark", "abstract"][(Number(n) + k) % 3], idea: `idea ${n}${k}`, construction: "two squares" })) });
    }
    if (label.startsWith("draw")) return circle("#2563eb");
    if (label.startsWith("look")) return JSON.stringify({ score: 7, defects: [] });
    return "{}";
  };
  return { calls, call };
}
const base = (dir: string, call: DesignDeps["call"], over: Partial<DesignDeps> = {}): DesignDeps => ({
  repoRoot: dir,
  models: ["openai/a", "google/b", "anthropic/c"],
  visionModels: ["google/b"],
  call,
  renderer: renderer(),
  log: () => {},
  fetchPage: async (u) => (u.includes("rival") ? '<meta name="theme-color" content="#2f66e0">' : null),
  ...over,
});

describe("the whole run with the new steps", () => {
  test("competitors are read before the concepts and shown to every drawer; the palette comes after the mark is chosen", async () => {
    const s = script();
    await runDesign(base(repo(), s.call), "logo");
    const labels = lbl(s.calls);
    assert.ok(labels.indexOf("rivals") > labels.indexOf("brief") && labels.indexOf("rivals") < labels.indexOf("concepts 1"));
    assert.ok(labels.indexOf("palette") > labels.findIndex((l) => l.startsWith("look")));
    const draw = s.calls.find((c) => /^draw \d+$/.test(c.label))!;
    assert.match(JSON.stringify(draw.messages), /Direct competitors .*RivalBank #2f66e0/);
    const concepts = s.calls.find((c) => c.label === "concepts 1")!;
    assert.match(JSON.stringify(concepts.messages), /would I propose this same one for another brand/);
  });

  test("the kit has the palette folder, a PDF and a preview, and the files hold the measured system", async () => {
    const dir = repo();
    const r = renderer();
    const s = script();
    const res = await runDesign(base(dir, s.call, { renderer: r }), "logo");
    assert.ok(res.ok, res.text);
    const d = res.dir!;
    for (const f of ["palette/tokens.css", "palette/tokens.dtcg.json", "palette/tailwind.palette.js", "palette/palette.gpl", "palette/palette.png", "guidelines.pdf", "guidelines.html", "guidelines-preview.png"]) assert.ok(fs.existsSync(path.join(d, f)), f);
    assert.equal(r.pdfs, 1);
    const brand = JSON.parse(fs.readFileSync(path.join(d, "brand.json"), "utf-8"));
    assert.equal(brand.mechanism, brand.concept.idea);
    assert.equal(brand.paletteSystem.brand[0].hex, "#2563eb");
    assert.equal(brand.paletteSystem.brand[0].name, "Pennywise Blue");
    const ids = brand.checks.map((c: any) => c.id);
    for (const id of ["contrast", "competitor-colours", "concept-cliches", "logo-on-both-themes", "trademark", "font-licence", "design-quality"]) assert.ok(ids.includes(id), id);
    const comp = brand.checks.find((c: any) => c.id === "competitor-colours");
    assert.equal(comp.status, "fail", "#2563eb is close to the rival's #2f66e0");
    assert.match(comp.detail, /RivalBank/);
    assert.equal(brand.checks.find((c: any) => c.id === "trademark").status, "not-checked");
    const readme = fs.readFileSync(path.join(d, "README.md"), "utf-8");
    assert.match(readme, /## Colour system/);
    assert.match(readme, /## Checks/);
    assert.match(readme, /FAIL \[gate\] competitor-colours/);
    assert.match(readme, /NOT CHECKED \[gate\] trademark/);
    assert.match(res.text, /Colour system: Pennywise Blue #2563eb/);
    assert.match(res.text, /Gates failing: competitor-colours./);
    assert.match(fs.readFileSync(path.join(d, "palette", "tokens.css"), "utf-8"), /--bi-primary:/);
  });

  test("the colour system card is shown to the person", async () => {
    const shown: string[] = [];
    await runDesign(base(repo(), script().call, { show: (l) => shown.push(l) }), "logo");
    assert.ok(shown.some((l) => /colour system/i.test(l)), shown.join("|"));
  });

  test("a model that gives nothing for rivals and palette still ends in a measured system", async () => {
    const s = script({ rivals: "nonsense", palette: "nonsense" });
    const res = await runDesign(base(repo(), s.call), "logo");
    assert.ok(res.ok);
    const brand = JSON.parse(fs.readFileSync(path.join(res.dir!, "brand.json"), "utf-8"));
    assert.equal(brand.checks.find((c: any) => c.id === "competitor-colours").status, "not-checked");
    assert.equal(brand.checks.find((c: any) => c.id === "contrast").status, "pass");
  });

  test("a throwing call for rivals or palette does not stop the kit", async () => {
    const s = script();
    const call: DesignDeps["call"] = async (m, msgs, l, j) => {
      if (l === "rivals" || l === "palette") throw new Error("down");
      return s.call(m, msgs, l, j);
    };
    const res = await runDesign(base(repo(), call), "logo");
    assert.ok(res.ok, res.text);
  });

  test("competitors can be turned off: nothing is fetched and no call is made", async () => {
    let fetched = 0;
    const s = script();
    await runDesign(base(repo(), s.call, { limits: { competitors: false }, fetchPage: async () => (fetched++, null) }), "logo");
    assert.ok(!lbl(s.calls).includes("rivals"));
    assert.equal(fetched, 0);
  });

  test("guidelines can be turned off", async () => {
    const res = await runDesign(base(repo(), script().call, { limits: { guidelines: false } }), "logo");
    assert.ok(!fs.existsSync(path.join(res.dir!, "guidelines.pdf")) && !fs.existsSync(path.join(res.dir!, "guidelines.html")));
  });

  test("without a PDF-capable browser the HTML guidelines are still written", async () => {
    const r: any = { png: async () => Buffer.from("P"), page: async () => Buffer.from("G"), close: async () => {} };
    const res = await runDesign(base(repo(), script().call, { renderer: r }), "logo");
    assert.ok(fs.existsSync(path.join(res.dir!, "guidelines.html")));
    assert.ok(!fs.existsSync(path.join(res.dir!, "guidelines.pdf")));
  });

  test("a cliché concept without a reason ranks below an equally scored one without it, and one clear concept is always shown", async () => {
    const s = script({
      concepts: (n) => [
        { title: `Leaf ${n}`, markType: "pictorial", idea: "a leaf", construction: "a leaf shape" },
        { title: `Cut ${n}`, markType: "abstract", idea: "a cut disc", construction: "a disc with a notch" },
      ],
    });
    const res = await runDesign(base(repo(), s.call), "logo");
    assert.ok(res.ok);
    assert.match(res.text, /Cut/);
  });

  test("a mark with many parts gets a simplified small mark, used for the 16 and 32 px favicon files", async () => {
    const busy = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${Array.from({ length: 10 }, (_, i) => `<circle cx="${10 + i * 8}" cy="50" r="5" fill="#2563eb"/>`).join("")}</svg>`;
    const pngSvgs: string[] = [];
    const r: any = { png: async (svg: string) => (pngSvgs.push(svg), Buffer.from("P")), page: async () => Buffer.from("G"), close: async () => {} };
    const calls: string[] = [];
    const s = script();
    const call: DesignDeps["call"] = async (m, msgs, l, j) => {
      calls.push(l);
      if (/^draw/.test(l)) return busy;
      if (l === "small mark") return circle("#2563eb");
      return s.call(m, msgs, l, j);
    };
    const res = await runDesign(base(repo(), call, { renderer: r }), "logo");
    assert.ok(calls.includes("small mark"));
    assert.ok(fs.existsSync(path.join(res.dir!, "logo-small.svg")));
    assert.ok(pngSvgs.some((x) => x === circle("#2563eb") || x.includes('r="38"')), "the 16/32 px renders use the small mark");
  });
});

describe("critique gates", () => {
  test("measured checks are kept apart from opinion, and what was not checked says so", async () => {
    const { critiqueGates, renderGates } = await import("../src/designCritique.js");
    const g = critiqueGates({ file: "logo.svg", kind: "svg", svg: circle("#000000"), images: [] }, false);
    const by = Object.fromEntries(g.map((x) => [x.id, x]));
    assert.equal(by["both-themes"].status, "fail");
    assert.match(by["both-themes"].detail, /fades on the dark surface/);
    assert.equal(by["small-size"].status, "not-checked");
    assert.equal(by["competitor-confusion"].status, "not-checked");
    assert.equal(critiqueGates({ file: "logo.svg", kind: "svg", svg: circle("#2563eb"), images: [] }, true).find((x) => x.id === "both-themes")!.status, "pass");
    const raster = critiqueGates({ file: "logo.png", kind: "raster", images: ["data:"] }, true);
    assert.equal(raster.find((x) => x.id === "vector-file")!.status, "fail");
    assert.equal(raster.find((x) => x.id === "both-themes")!.status, "not-checked");
    assert.match(renderGates(g), /A clean list means nothing measurable is broken, not that the logo is good/);
  });
});

describe("what reaches the phone", () => {
  test("the guidelines pages go out as a picture, after the final logo preview", async () => {
    const shown: string[] = [];
    const r = renderer();
    await runDesign(base(repo(), script().call, { renderer: r, show: (label) => shown.push(label) }), "logo");
    const i = shown.findIndex((l) => /final logo on light and dark/.test(l));
    const j = shown.findIndex((l) => /brand guidelines \(all pages\)/.test(l));
    assert.ok(i >= 0 && j > i, shown.join(" | "));
    assert.ok(shown.some((l) => /colour system/i.test(l)));
  });
  test("without a PDF-capable browser there is no guidelines picture to send", async () => {
    const shown: string[] = [];
    const r: any = { png: async () => Buffer.from("P"), page: async () => Buffer.from("G"), close: async () => {} };
    await runDesign(base(repo(), script().call, { renderer: r, show: (label) => shown.push(label) }), "logo");
    assert.ok(!shown.some((l) => /brand guidelines/.test(l)));
  });
});
