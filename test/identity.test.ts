import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPalette, parsePaletteChoice } from "../src/palette.js";
import { IDENTITY_PENALTY, findBrandKit, identityDefects, readPalette, readUiTheme, themeConstraints, writeUiTheme } from "../src/identity.js";
import { DESIGN_DIR, ensureDesignSystem } from "../src/uiDesign.js";
import { loadCatalog } from "../src/wordmark.js";
import { runDesign, type ChatMsg, type DesignDeps } from "../src/designer.js";
import type { Renderer } from "../src/svgRender.js";

const circle = (c: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="38" fill="${c}"/></svg>`;
const repo = (pkg: object = { dependencies: { next: "15", react: "19", "react-dom": "19" } }, files: Record<string, string> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "id-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
};
const PALETTE = buildPalette(["#0d9488", "#e11d48"], parsePaletteChoice({ ground: "warm", neutralHue: 190 }, ["#0d9488"]));
const kit = (over: object = {}) => ({
  name: "Lumen",
  paletteSystem: PALETTE,
  typography: { pairing: { display: "Poppins", body: "Barlow" }, wordmark: { family: "Poppins" } },
  brief: { personality: ["calm", "bright"] },
  mechanism: "an L with a dot",
  ...over,
});
const withKit = (k: object = kit(), extra: Record<string, string> = {}) => repo(undefined, { "brand/lumen/brand.json": JSON.stringify(k), ...extra });

describe("reading a brand kit back", () => {
  test("a complete palette round-trips exactly; a damaged one is refused", () => {
    const back = readPalette(JSON.parse(JSON.stringify(PALETTE)))!;
    assert.deepEqual(back.light, PALETTE.light);
    assert.deepEqual(back.dark, PALETTE.dark);
    assert.deepEqual(back.brand.map((b) => b.hex), PALETTE.brand.map((b) => b.hex));
    assert.equal(back.scales.primary.length, 11);
    const bad = JSON.parse(JSON.stringify(PALETTE));
    delete bad.light.focus;
    assert.equal(readPalette(bad), null);
    const bad2 = JSON.parse(JSON.stringify(PALETTE));
    bad2.dark.text = "red";
    assert.equal(readPalette(bad2), null);
    const bad3 = JSON.parse(JSON.stringify(PALETTE));
    bad3.scales.primary = bad3.scales.primary.slice(0, 5);
    assert.equal(readPalette(bad3), null);
    assert.equal(readPalette(null), null);
    assert.equal(readPalette({ brand: [] }), null);
  });
  test("the kit's facts: signature, accent, type, personality, idea, and only the files that exist", () => {
    const dir = withKit(kit(), { "brand/lumen/logo-on-light.svg": "<svg/>", "brand/lumen/lockup-horizontal.svg": "<svg/>", "brand/lumen/favicon.svg": "<svg/>" });
    const k = findBrandKit(dir)!;
    assert.deepEqual([k.signature, k.accent, k.display, k.body, k.dir, k.idea], ["#0d9488", "#e11d48", "Poppins", "Barlow", "brand/lumen", "an L with a dot"]);
    assert.deepEqual(k.personality, ["calm", "bright"]);
    assert.deepEqual(k.files.sort(), ["favicon.svg", "lockup-horizontal.svg", "logo-on-light.svg"]);
    assert.ok(k.palette);
  });
  test("a kit with a damaged palette still gives its colours but no palette to reuse", () => {
    const k = findBrandKit(withKit(kit({ paletteSystem: { brand: [{ hex: "#0d9488" }] } })))!;
    assert.equal(k.signature, "#0d9488");
    assert.equal(k.palette, undefined);
  });
});

describe("the UI follows the brand kit", () => {
  const model = (log: { system: string }[] = []) => async (_m: string[], msgs: any[], label: string) => {
    if (label === "design decision") return JSON.stringify({ ui: "new", platform: "web", playbook: "news", product: "news-media-platform" });
    if (label === "design direction") {
      log.push({ system: String(msgs[0].content) });
      // the model tries to choose its own identity; it must be ignored
      return JSON.stringify({ style: "editorial", pairing: "news-editorial", signature: "#123456", accent: "#654321", ground: "cool", neutralHue: 10, iconLibrary: "inline-svg" });
    }
    return "{}";
  };
  const run = (dir: string, log?: { system: string }[]) => ensureDesignSystem({ call: model(log), models: ["a/x"], repoRoot: dir, request: "build me a news website", log: () => {}, fetchIcon: async () => null });
  const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, DESIGN_DIR, f), "utf-8");

  test("the palette is the kit's own, not rebuilt: same roles, and the model's colours are ignored", async () => {
    const dir = withKit();
    await run(dir);
    const css = read(dir, "tokens.css");
    assert.match(css, new RegExp(`--color-primary: ${PALETTE.light.primary};`));
    assert.match(css, new RegExp(`--color-background: ${PALETTE.light.background};`));
    assert.match(css, new RegExp(`--color-focus: ${PALETTE.dark.focus};`));
    assert.ok(!/#123456|#654321/i.test(css));
    const md = read(dir, "MASTER.md");
    assert.match(md, /The palette is the approved brand kit's \(brand\/lumen\); it was not rebuilt/);
    assert.match(md, new RegExp(`\\| primary \\| ${PALETTE.light.primary} \\| ${PALETTE.dark.primary} \\|`));
  });
  test("the type is the kit's, and the Google link asks for those families", async () => {
    const dir = withKit();
    await run(dir);
    const css = read(dir, "tokens.css");
    assert.match(css, /--font-heading: "Poppins"/);
    assert.match(css, /--font-body: "Barlow"/);
    assert.match(css, /family=Poppins:wght@400;700&family=Barlow:wght@400;700/);
    assert.match(read(dir, "MASTER.md"), /The type is the approved brand kit's: Poppins \/ Barlow/);
  });
  test("a kit with only a wordmark face: a text face serves as both, a display face takes the chosen body", async () => {
    const cat = loadCatalog();
    const bodyFace = cat.find((f) => f.body)!;
    const displayFace = cat.find((f) => !f.body)!;
    const a = withKit(kit({ typography: { wordmark: { family: bodyFace.family } } }));
    await run(a);
    assert.match(read(a, "tokens.css"), new RegExp(`--font-body: "${bodyFace.family}"`));
    const b = withKit(kit({ typography: { wordmark: { family: displayFace.family } } }));
    await run(b);
    assert.match(read(b, "tokens.css"), new RegExp(`--font-heading: "${displayFace.family}"`));
    assert.match(read(b, "tokens.css"), /--font-body: "Open Sans"/, "Poppins is a display face here, so it takes the known pairing it belongs to");
  });
  test("the direction prompt says the identity is decided, and what it is", async () => {
    const log: { system: string }[] = [];
    await run(withKit(), log);
    assert.match(log[0].system, /THE IDENTITY IS ALREADY DECIDED \(an approved brand kit at brand\/lumen\)/);
    assert.match(log[0].system, /signature colour #0d9488, accent #e11d48, type Poppins \/ Barlow, with a measured light and dark palette/);
    assert.match(log[0].system, /personality: calm, bright/);
    assert.match(log[0].system, /Its idea: an L with a dot/);
    assert.match(log[0].system, /answers will be ignored/);
  });
  test("MASTER points the UI at the kit's real logo files, and says not to redraw them", async () => {
    const dir = withKit(kit(), { "brand/lumen/lockup-horizontal.svg": "<svg/>", "brand/lumen/lockup-horizontal-on-dark.svg": "<svg/>", "brand/lumen/favicon.svg": "<svg/>", "brand/lumen/app-icon.svg": "<svg/>" });
    await run(dir);
    const md = read(dir, "MASTER.md");
    assert.match(md, /## Identity \(shared with the logo\)/);
    assert.match(md, /header logo on light: `brand\/lumen\/lockup-horizontal\.svg`/);
    assert.match(md, /header logo on dark: `brand\/lumen\/lockup-horizontal-on-dark\.svg`/);
    assert.match(md, /favicon: `brand\/lumen\/favicon\.svg`/);
    assert.match(md, /Do not recolour or redraw the logo/);
  });
  test("design.json records that the identity came from the brand kit, with the kit's colours", async () => {
    const dir = withKit();
    await run(dir);
    const t = readUiTheme(dir)!;
    assert.equal(t.source, "brand");
    assert.equal(t.brandDir, "brand/lumen");
    assert.equal(t.signature, "#0d9488");
    assert.equal(t.accent, "#e11d48");
    assert.equal(t.heading, "Poppins");
  });
  test("with no kit the UI chooses its identity and says it is the source", async () => {
    const dir = repo();
    await run(dir);
    const t = readUiTheme(dir)!;
    assert.equal(t.source, "ui");
    assert.equal(t.brandDir, undefined);
    assert.match(read(dir, "MASTER.md"), /This design system is the identity source \(design-system\/design\.json\)/);
    assert.match(read(dir, "MASTER.md"), new RegExp(`must use signature ${t.signature}`));
  });
});

describe("the logo follows the UI theme", () => {
  test("the theme round-trips; junk is ignored", () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, DESIGN_DIR));
    writeUiTheme(path.join(dir, DESIGN_DIR), { name: "The Ledger", signature: "#b4231f", accent: "#0f766e", ground: "warm", neutralHue: 40, heading: "Newsreader", body: "Source Sans 3", style: "editorial", personality: ["calm"], memorableMove: "a red rule", source: "ui" });
    const t = readUiTheme(dir)!;
    assert.deepEqual([t.signature, t.accent, t.ground, t.neutralHue, t.heading], ["#b4231f", "#0f766e", "warm", 40, "Newsreader"]);
    assert.equal(readUiTheme(repo()), null);
    fs.writeFileSync(path.join(dir, DESIGN_DIR, "design.json"), "{nope");
    assert.equal(readUiTheme(dir), null);
    fs.writeFileSync(path.join(dir, DESIGN_DIR, "design.json"), JSON.stringify({ signature: "not a colour" }));
    assert.equal(readUiTheme(dir), null);
  });
  test("a logo is held to the UI's signature colour: close passes, far fails, no theme passes", () => {
    const theme = { signature: "#b4231f" };
    assert.deepEqual(identityDefects(circle("#b4231f"), theme), []);
    assert.deepEqual(identityDefects(circle("#b8271f"), theme), [], "a near miss is fine");
    const far = identityDefects(circle("#2563eb"), theme);
    assert.equal(far.length, 1);
    assert.match(far[0], /main colour #2563eb does not match the product UI's signature colour #b4231f/);
    assert.deepEqual(identityDefects(circle("#2563eb"), undefined), []);
    assert.ok(IDENTITY_PENALTY > 0);
  });
  test("the constraints the designers are given say exactly which colours and type to use", () => {
    const c = themeConstraints({ name: "x", signature: "#b4231f", accent: "#0f766e", ground: "white", neutralHue: null, heading: "Newsreader", body: "Source Sans 3", style: "editorial", personality: ["calm", "sharp"], memorableMove: "", source: "ui" });
    assert.match(c[0], /main colour must be exactly #b4231f; a second colour, if there is one, must be #0f766e/);
    assert.match(c[1], /headings in Newsreader and text in Source Sans 3/);
    assert.match(c[2], /calm, sharp/);
  });
});

// ---------------------------------------------------------------------------

const renderer = (): Renderer => ({ png: async () => Buffer.from("PNG"), page: async () => Buffer.from("PAGE"), close: async () => {} });
interface Call { label: string; messages: ChatMsg[] }
const text = (m: ChatMsg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

function script(draw: (label: string) => string) {
  const calls: Call[] = [];
  const call: DesignDeps["call"] = async (_m, messages, label) => {
    calls.push({ label, messages });
    if (label === "brief") return JSON.stringify({ name: "Lumen", offering: "study planner", audience: "students", personality: ["calm"], avoid: [], constraints: [], assumptions: [] });
    if (label.startsWith("concepts")) return JSON.stringify({ concepts: [1, 2].map((k) => ({ title: `Idea ${label.split(" ")[1]}${k}`, markType: ["symbol", "abstract"][k % 2], idea: `idea ${k}`, construction: "two squares" })) });
    if (label.startsWith("draw") || label.startsWith("fix")) return draw(label);
    if (label.startsWith("look")) return JSON.stringify({ score: 7, defects: [] });
    return "{}";
  };
  return { calls, call };
}
const base = (dir: string, call: DesignDeps["call"], over: Partial<DesignDeps> = {}): DesignDeps => ({ repoRoot: dir, models: ["openai/a", "google/b", "anthropic/c"], visionModels: ["google/b"], call, renderer: renderer(), log: () => {}, fetchPage: async () => null, limits: { competitors: false }, ...over });
const THEME = { name: "The Ledger", signature: "#b4231f", accent: "#0f766e", ground: "warm" as const, neutralHue: 40, heading: "Newsreader", body: "Source Sans 3", style: "editorial", personality: ["calm"], memorableMove: "a red rule", source: "ui" as const };
const withTheme = () => {
  const dir = repo({ name: "ledger" });
  fs.mkdirSync(path.join(dir, DESIGN_DIR), { recursive: true });
  writeUiTheme(path.join(dir, DESIGN_DIR), THEME);
  return dir;
};

describe("the logo designer with a UI theme in the project", () => {
  test("every model is told the colour, and the kit is made in that colour", async () => {
    const dir = withTheme();
    const s = script(() => circle("#b4231f"));
    const res = await runDesign(base(dir, s.call), "logo");
    assert.ok(res.ok, res.text);
    const draw = s.calls.find((c) => /^draw \d+$/.test(c.label))!;
    assert.match(text(draw.messages[1]), /main colour must be exactly #b4231f; a second colour, if there is one, must be #0f766e/);
    assert.match(text(s.calls.find((c) => c.label === "concepts 1")!.messages[1]), /already uses #b4231f/);
    const brand = JSON.parse(fs.readFileSync(path.join(res.dir!, "brand.json"), "utf-8"));
    assert.equal(brand.checks.find((c: any) => c.id === "matches-ui-theme").status, "pass");
  });
  test("a mark in the wrong colour is sent back to be fixed, and the fix is kept", async () => {
    const dir = withTheme();
    const s = script((l) => (l.startsWith("fix") ? circle("#b4231f") : circle("#2563eb")));
    const res = await runDesign(base(dir, s.call), "logo");
    const fix = s.calls.find((c) => c.label.startsWith("fix"));
    assert.ok(fix, "a fix round was asked for");
    assert.match(text(fix!.messages[fix!.messages.length - 1]), /does not match the product UI's signature colour #b4231f/);
    assert.match(fs.readFileSync(path.join(res.dir!, "logo.svg"), "utf-8"), /#b4231f/);
  });
  test("a mark that stays in the wrong colour is ranked down and the gate says so, instead of passing", async () => {
    const dir = withTheme();
    const s = script(() => circle("#2563eb"));
    const res = await runDesign(base(dir, s.call), "logo");
    assert.ok(res.ok);
    const brand = JSON.parse(fs.readFileSync(path.join(res.dir!, "brand.json"), "utf-8"));
    const g = brand.checks.find((c: any) => c.id === "matches-ui-theme");
    assert.equal(g.status, "fail");
    assert.match(g.detail, /#2563eb does not match/);
  });
  test("the brand palette takes the UI's ground and neutral tint", async () => {
    const dir = withTheme();
    const s = script(() => circle("#b4231f"));
    const call: DesignDeps["call"] = async (m, msgs, l, j) => (l === "palette" ? JSON.stringify({ ground: "cool", neutralHue: 250, accent: "#7c3aed" }) : s.call(m, msgs, l, j));
    const res = await runDesign(base(dir, call), "logo");
    const brand = JSON.parse(fs.readFileSync(path.join(res.dir!, "brand.json"), "utf-8"));
    assert.equal(brand.paletteSystem.ground, "warm", "the UI's ground, not the model's");
    assert.ok(brand.paletteSystem.brand.some((b: any) => b.hex === "#0f766e"), "the UI's accent, not the model's");
    assert.ok(!brand.paletteSystem.brand.some((b: any) => b.hex === "#7c3aed"));
  });
  test("the wordmark step is told which faces the UI already uses", async () => {
    const dir = withTheme();
    const s = script(() => circle("#b4231f"));
    await runDesign(base(dir, s.call), "logo");
    const t = s.calls.find((c) => c.label === "typography")!;
    assert.match(text(t.messages[1]), /already sets headings in Newsreader and text in Source Sans 3/);
  });
  test("with no UI theme nothing changes, and the gate says it was not checked", async () => {
    const dir = repo({ name: "x" });
    const s = script(() => circle("#2563eb"));
    const res = await runDesign(base(dir, s.call), "logo");
    const brand = JSON.parse(fs.readFileSync(path.join(res.dir!, "brand.json"), "utf-8"));
    assert.equal(brand.checks.find((c: any) => c.id === "matches-ui-theme").status, "not-checked");
    assert.ok(!s.calls.some((c) => c.label.startsWith("fix")));
  });
});
