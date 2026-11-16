import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PAIRINGS, PLAYBOOKS, RULES, SLOP_SIGNS, STYLES, coreRulesBlock, findPairing, findStyle } from "../src/uiKnowledge.js";
import {
  DESIGN_DIR, buildDesignSystem, designSystemForPrompt, detectUiStack, ensureDesignSystem, masterDoc, nativeTokens, parseDirection, parseUiDecision, typeScale, webTokens, radiusTokens,
} from "../src/uiDesign.js";
import { emojiAsIcon, uiSignals } from "../src/uiLint.js";
import { deterministicSignals, staticQaReview, type ChangeSet } from "../src/staticQa.js";
import { buildContextualSystemPrompt } from "../src/agentLoop.js";
import { findPlaybook } from "../src/uiKnowledge.js";

const repo = (pkg: object = {}, files: Record<string, string> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
};
const EXPO = { dependencies: { expo: "52", "react-native": "0.76", "lucide-react-native": "1", "react-native-svg": "15" } };
const WEB = { dependencies: { next: "15", react: "19", "react-dom": "19", tailwindcss: "4" } };

describe("the knowledge is consistent", () => {
  test("ids are unique and every playbook points at real styles and pairings", () => {
    for (const list of [PLAYBOOKS.map((p) => p.id), STYLES.map((s) => s.id), PAIRINGS.map((p) => p.id), RULES.map((r) => r.id)]) assert.equal(new Set(list).size, list.length);
    for (const p of PLAYBOOKS) {
      assert.ok(p.styles.length > 0 && p.styles.every((s) => findStyle(s)), `${p.id} styles`);
      assert.ok(p.pairings.length > 0 && p.pairings.every((x) => findPairing(x)), `${p.id} pairings`);
      assert.ok(p.structure.length > 80 && p.musts.length > 0 && p.anti.length > 0, p.id);
    }
  });
  test("a news site has a news playbook that rules out the generated-template look", () => {
    const n = findPlaybook("news")!;
    assert.match(n.structure, /Masthead/);
    assert.match(n.structure, /60-70 characters/);
    assert.ok(n.anti.some((a) => /centred marketing hero/.test(a)) && n.anti.some((a) => /three identical/.test(a)));
    assert.equal(n.pairings[0], "news-editorial");
  });
  test("emoji-as-icon is the first critical rule, in the short block, for any platform", () => {
    assert.equal(RULES[0].id, "no-emoji-icons");
    assert.equal(RULES[0].sev, "critical");
    for (const p of ["web", "native", "unknown"] as const) {
      const b = coreRulesBlock(p);
      assert.match(b, /Emoji as icons/);
      assert.match(b, /Hard-coded hex values/);
      assert.ok(b.length < 4200, `${p}: ${b.length}`);
    }
    assert.match(coreRulesBlock("native"), /44pt/);
    assert.ok(!/outline: none/.test(coreRulesBlock("native")), "web-only rules stay out of a native app");
    assert.match(coreRulesBlock("web"), /outline: none/);
  });
  test("the slop list names the emoji and the purple gradient", () => {
    assert.ok(SLOP_SIGNS.some((s) => /emoji/.test(s)) && SLOP_SIGNS.some((s) => /purple-to-pink/.test(s)));
  });
});

describe("what the project is", () => {
  test("an Expo app is native with its installed icon library and no web", () => {
    const s = detectUiStack(repo(EXPO, { "src/theme.ts": "export const x = 1" }));
    assert.equal(s.platform, "native");
    assert.deepEqual(s.iconLibs.sort(), ["lucide-react-native", "react-native-svg"]);
    assert.deepEqual(s.themeFiles, ["src/theme.ts"]);
    assert.ok(s.hasUi);
  });
  test("a Next site is web; a backend-only repo has no UI", () => {
    assert.equal(detectUiStack(repo(WEB)).platform, "web");
    const b = detectUiStack(repo({ dependencies: { express: "4" } }));
    assert.equal(b.platform, "unknown");
    assert.equal(b.hasUi, false);
  });
  test("a broken manifest does not throw", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-"));
    fs.writeFileSync(path.join(dir, "package.json"), "{nope");
    assert.equal(detectUiStack(dir).platform, "unknown");
  });
});

describe("the decision and the direction are validated", () => {
  const stack = detectUiStack(repo(EXPO));
  test("only a known kind and a known playbook survive; junk is none", () => {
    assert.deepEqual(parseUiDecision('{"ui":"new","platform":"web","playbook":"news","why":"x"}', stack), { ui: "new", platform: "web", playbook: "news", product: null, why: "x" });
    assert.equal(parseUiDecision('{"ui":"new","playbook":"unicorns"}', stack)!.playbook, null);
    assert.equal(parseUiDecision('{"ui":"make it pop"}', stack)!.ui, "none");
    assert.equal(parseUiDecision("{}", stack)!.platform, "native");
    assert.equal(parseUiDecision("nonsense", stack), null);
  });
  const pb = findPlaybook("news")!;
  test("unknown style or pairing falls back to the playbook's; a grey or near-white signature is replaced", () => {
    const d = parseDirection(JSON.stringify({ style: "vaporwave", pairing: "nope", signature: "#eeeeee", icons: "x" }), pb, stack, "Folder")!;
    assert.equal(d.style, "editorial");
    assert.equal(d.pairing, "news-editorial");
    assert.notEqual(d.signature, "#eeeeee");
    assert.match(d.signature, /^#[0-9a-f]{6}$/i);
    assert.equal(d.name, "Folder");
  });
  test("the icon library must be one that is installed, or inline SVG; otherwise the installed one is used", () => {
    assert.equal(parseDirection(JSON.stringify({ iconLibrary: "fontawesome" }), pb, stack, "x")!.iconLibrary, "lucide-react-native");
    assert.equal(parseDirection(JSON.stringify({ iconLibrary: "inline-svg" }), pb, stack, "x")!.iconLibrary, "inline-svg");
    assert.equal(parseDirection("{}", pb, detectUiStack(repo(WEB)), "x")!.iconLibrary, "phosphor", "no library installed: Phosphor is the default");
  });
  test("a good choice is kept", () => {
    const d = parseDirection(JSON.stringify({ name: "The Ledger", style: "swiss", pairing: "magazine", signature: "#b4231f", accent: "#0f766e", ground: "warm", radius: "sharp", density: "dense", motion: "still", memorableMove: "a red rule under every kicker" }), pb, stack, "x")!;
    assert.deepEqual([d.name, d.style, d.pairing, d.signature, d.accent, d.ground, d.radius, d.density, d.motion], ["The Ledger", "swiss", "magazine", "#b4231f", "#0f766e", "warm", "sharp", "dense", "still"]);
  });
});

describe("tokens and the document", () => {
  const web = detectUiStack(repo(WEB));
  const native = detectUiStack(repo(EXPO));
  const dir = (s = web) => parseDirection(JSON.stringify({ name: "The Ledger", style: "editorial", pairing: "news-editorial", signature: "#b4231f", ground: "warm", memorableMove: "a red rule under every kicker" }), findPlaybook("news")!, s, "x")!;
  test("the type scale is a real modular scale with a body of 16 and legible sizes", () => {
    const t = typeScale(1.25);
    assert.equal(t[2].size, 16);
    assert.ok(t.every((x, i) => i === 0 || x.size > t[i - 1].size));
    assert.ok(t.every((x) => x.size >= 12 && x.line > x.size));
    assert.ok(radiusTokens("sharp").md < radiusTokens("round").md);
  });
  test("a web system: contrast gates pass, light and dark roles exist, tokens.css has fonts, space and reduced motion", () => {
    const s = buildDesignSystem(dir(), "web", web);
    assert.equal(s.palette.checks.find((c) => c.id === "contrast")!.status, "pass");
    const css = webTokens(s);
    for (const re of [/--color-background:/, /--color-on-primary:/, /--space-4: 16px/, /--radius-md:/, /--font-heading: "Newsreader"/, /--text-base: 1rem/, /prefers-reduced-motion/, /:focus-visible/, /\[data-theme="dark"\]/, /fonts\.googleapis\.com\/css2\?family=Newsreader/]) assert.match(css, re);
  });
  test("a native app with no font package uses the system font and says so; with one it uses the pairing", () => {
    const s = buildDesignSystem(dir(native), "native", native);
    assert.equal(s.type.heading, "System");
    assert.match(s.type.fontNote, /system font/);
    const withFonts = detectUiStack(repo({ dependencies: { ...EXPO.dependencies, "@expo-google-fonts/inter": "1", "expo-font": "1" } }));
    assert.equal(buildDesignSystem(dir(withFonts), "native", withFonts).type.heading, "Newsreader");
    const ts = nativeTokens(s);
    assert.match(ts, /export const colors = \{/);
    assert.match(ts, /touchTarget = 48/);
    assert.match(ts, /primary: "#/);
  });
  test("MASTER.md carries the move, the structure, measured colour, icon rules and the slop list, and fits the prompt budget", () => {
    const s = buildDesignSystem(dir(), "web", web);
    const md = masterDoc(s, web, "build a news website");
    for (const re of [/a red rule under every kicker/, /Masthead/, /\| background \|/, /PASS contrast/, /Never emoji as icons/, /design-system\/tokens\.css/, /How this design would give itself away/, /three identical rounded cards/]) assert.match(md, re);
    assert.ok(md.length < 11000, String(md.length));
    // The part that must reach the model is in the first 7500 characters.
    assert.match(md.slice(0, 7500), /Never emoji as icons/);
    assert.match(md.slice(0, 7500), /## Files/);
  });
});

// ---------------------------------------------------------------------------

function modelFor(over: { decision?: any; direction?: any; failDirection?: boolean } = {}) {
  const calls: string[] = [];
  const call = async (_m: string[], _msgs: any[], label: string) => {
    calls.push(label);
    if (label === "design decision") return JSON.stringify(over.decision ?? { ui: "new", platform: "web", playbook: "news", why: "a new site" });
    if (label === "design direction") {
      if (over.failDirection) throw new Error("down");
      return JSON.stringify(over.direction ?? { name: "The Ledger", style: "editorial", pairing: "news-editorial", signature: "#b4231f", ground: "warm", neutralHue: 40, memorableMove: "a red rule under every kicker", iconLibrary: "inline-svg" });
    }
    return "{}";
  };
  return { call, calls };
}
const ensure = (dir: string, m: ReturnType<typeof modelFor>, over: any = {}) => ensureDesignSystem({ call: m.call, models: ["a/x"], repoRoot: dir, request: "build me a news website", log: () => {}, fetchIcon: async () => null, ...over });

describe("ensureDesignSystem", () => {
  test("a new news site gets MASTER.md and tokens.css, written once, and nothing is installed", async () => {
    const dir = repo(WEB);
    const r = (await ensure(dir, modelFor()))!;
    assert.ok(r.created);
    assert.deepEqual(r.files.sort(), ["design-system/MASTER.md", "design-system/design.json", "design-system/stack.md", "design-system/style.md", "design-system/tokens.css"]);
    assert.match(fs.readFileSync(path.join(dir, DESIGN_DIR, "MASTER.md"), "utf-8"), /Design system: The Ledger/);
    assert.match(r.summary, /News and media, Editorial grid, Newsreader \/ Source Sans 3, signature #b4231f/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")), WEB);
  });
  test("an Expo app gets tokens.ts, not tokens.css", async () => {
    const dir = repo(EXPO);
    const r = (await ensure(dir, modelFor({ decision: { ui: "new", platform: "native", playbook: "tracker" }, direction: { style: "organic", pairing: "wellness-calm", signature: "#0d9488", iconLibrary: "lucide-react-native" } })))!;
    assert.deepEqual(r.files.sort(), ["design-system/MASTER.md", "design-system/design.json", "design-system/native.md", "design-system/stack.md", "design-system/style.md", "design-system/tokens.ts"]);
  });
  test("a bug fix, a backend task and a change inside existing UI make nothing, and cost one call", async () => {
    for (const ui of ["none", "extend"]) {
      const dir = repo(WEB);
      const m = modelFor({ decision: { ui } });
      assert.equal(await ensure(dir, m), null);
      assert.deepEqual(m.calls, ["design decision"]);
      assert.ok(!fs.existsSync(path.join(dir, DESIGN_DIR)));
    }
  });
  test("an existing design system is kept: a new request does not overwrite it", async () => {
    const dir = repo(WEB, { "design-system/MASTER.md": "# mine" });
    assert.equal(await ensure(dir, modelFor()), null);
    assert.equal(fs.readFileSync(path.join(dir, DESIGN_DIR, "MASTER.md"), "utf-8"), "# mine");
  });
  test("a restyle replaces it but keeps the old one beside it", async () => {
    const dir = repo(WEB, { "design-system/MASTER.md": "# old", "design-system/tokens.css": "/* old */" });
    const r = (await ensure(dir, modelFor({ decision: { ui: "restyle", platform: "web", playbook: "saas" } })))!;
    assert.ok(r.created);
    assert.match(fs.readFileSync(path.join(dir, DESIGN_DIR, "MASTER.md"), "utf-8"), /Design system:/);
    const prev = fs.readdirSync(path.join(dir, DESIGN_DIR)).find((f) => f.startsWith("previous-"))!;
    assert.equal(fs.readFileSync(path.join(dir, DESIGN_DIR, prev, "MASTER.md"), "utf-8"), "# old");
    assert.equal(fs.readFileSync(path.join(dir, DESIGN_DIR, prev, "tokens.css"), "utf-8"), "/* old */");
  });
  test("when the direction cannot be had, the playbook's own picks still give a measured system", async () => {
    const dir = repo(WEB);
    const r = (await ensure(dir, modelFor({ failDirection: true })))!;
    assert.ok(r.created);
    assert.match(fs.readFileSync(path.join(dir, DESIGN_DIR, "MASTER.md"), "utf-8"), /PASS contrast/);
  });
  test("a failing decision call returns null without throwing", async () => {
    const dir = repo(WEB);
    const r = await ensureDesignSystem({ call: async () => { throw new Error("x"); }, models: ["a/x"], repoRoot: dir, request: "x", log: () => {} });
    assert.equal(r, null);
  });
  test("what the agents are given is bounded and empty when there is no design system", async () => {
    const dir = repo(WEB);
    assert.equal(designSystemForPrompt(dir), "");
    await ensure(dir, modelFor());
    const full = designSystemForPrompt(dir, 100000);
    assert.ok(designSystemForPrompt(dir, 500).length < full.length);
    assert.match(designSystemForPrompt(dir, 500), /truncated: read design-system\/MASTER\.md/);
  });
});

describe("agents are given the design system and the craft rules", () => {
  const cfg: any = { prompts: { systemPersona: "PERSONA" }, memory: {} };
  test("the Editor and Planner see the design system; the Editor also the craft rules; Discovery sees neither", async () => {
    const dir = repo(WEB);
    await ensure(dir, modelFor());
    const editor = buildContextualSystemPrompt("EDITOR", cfg, dir);
    assert.match(editor, /\[DESIGN SYSTEM \(design-system\/MASTER\.md\) — binding/);
    assert.match(editor, /Design system: The Ledger/);
    assert.match(editor, /UI CRAFT RULES/);
    assert.match(editor, /wires them in before any screen uses them/);
    const planner = buildContextualSystemPrompt("PLANNER", cfg, dir);
    assert.match(planner, /Design system: The Ledger/);
    assert.ok(!/UI CRAFT RULES/.test(planner));
    const disc = buildContextualSystemPrompt("DISCOVERY", cfg, dir);
    assert.ok(!/DESIGN SYSTEM/.test(disc) && !/UI CRAFT RULES/.test(disc));
  });
  test("a UI project without a design system still gets the craft rules in the Editor; a backend repo gets nothing", () => {
    assert.match(buildContextualSystemPrompt("EDITOR", cfg, repo(EXPO)), /Emoji as icons/);
    assert.ok(!/UI CRAFT RULES/.test(buildContextualSystemPrompt("EDITOR", cfg, repo({ dependencies: { express: "4" } }))));
  });
  test("a verify-only planner is not given it", async () => {
    const dir = repo(WEB);
    await ensure(dir, modelFor());
    assert.ok(!/DESIGN SYSTEM/.test(buildContextualSystemPrompt("PLANNER", cfg, dir, true)));
  });
});

// ---------------------------------------------------------------------------

const seg = (file: string, lines: string[]) => ({ file, diff: `diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n${lines.map((l) => "+" + l).join("\n")}` });

describe("UI lint", () => {
  test("emoji standing in as an icon is a defect: markup, string, icon prop", () => {
    for (const l of ["<Text>🔥</Text>", "  <span>🏠</span>", "const tabs = [{ label: 'Home', icon: '🏠' }]", 'tabBarIcon: () => <Text style={s.i}>📰</Text>', "<Button title=\"🔍\" />", "icon: `🔥`"]) assert.ok(emojiAsIcon(l), l);
  });
  test("emoji in a comment, a log, a longer sentence of content, or no emoji at all is not an icon", () => {
    for (const l of ["// 🔥 hot", "console.log('🔥 done')", "<p>We love our readers 🙏 thanks for subscribing</p>", "const a = 1", "<Text aria-hidden>🔥</Text>"]) assert.ok(!emojiAsIcon(l), l);
  });
  test("an emoji icon in a component is a defect with a fix, and a stray emoji in text is only a concern", () => {
    const s = uiSignals([seg("src/Tabs.tsx", ["<Text>🏠</Text>", "<p>Great news 🎉 for all of you readers today</p>"]), seg("src/notes.md", ["<Text>🏠</Text>"])]);
    const d = s.filter((x) => x.severity === "defect");
    assert.equal(d.length, 1);
    assert.equal(d[0].requirement, "No emoji used as icons in the UI");
    assert.match(d[0].message, /Tabs\.tsx/);
    assert.match(d[0].message, /vector icon set/);
  });
  test("tests, stories and non-UI files are ignored", () => {
    assert.deepEqual(uiSignals([seg("src/Tabs.test.tsx", ["<Text>🏠</Text>"]), seg("src/api.ts", ["x = '🏠'"]), seg("__tests__/a.tsx", ["<Text>🏠</Text>"])]), []);
  });
  test("disabled zoom is a defect; the rest are concerns", () => {
    const s = uiSignals([
      seg("index.html", ['<meta name="viewport" content="width=device-width, user-scalable=no">', '<img src="a.png">', "<div onClick={go}>x</div>".replace("{go}", '"go()"')]),
      seg("a.css", ["a:focus { outline: none; }", "p { font-size: 11px; }", ".x { z-index: 9999; }", ".hero { background: linear-gradient(135deg, #7c3aed, #ec4899); }"]),
      seg("B.tsx", ["<p>Lorem ipsum dolor sit amet</p>"]),
    ]);
    assert.ok(s.some((x) => x.severity === "defect" && /Zoom is disabled/.test(x.message)));
    const concerns = s.filter((x) => x.severity === "concern").map((x) => x.message).join("\n");
    for (const re of [/no alt attribute/, /div or span is clickable/, /focus outline is removed/, /smaller than 12/, /very large z-index/, /purple\/pink gradient/, /Lorem ipsum/]) assert.match(concerns, re);
  });
  test("an outline that is replaced with a focus-visible ring is fine; an image with alt is fine", () => {
    assert.deepEqual(uiSignals([seg("a.css", ["a:focus-visible { outline: none; box-shadow: 0 0 0 2px blue; }"]), seg("a.html", ['<img src="a.png" alt="A harbour">'])]), []);
  });
  test("hard-coded colours are only flagged when a design system exists, and not in token files", () => {
    const comp = seg("src/Card.tsx", ["const s = { color: '#b4231f', background: '#fff' };"]);
    assert.deepEqual(uiSignals([comp]), []);
    const s = uiSignals([comp, seg("design-system/tokens.css", [":root{--a:#b4231f}"]), seg("src/theme.ts", ["export const c = '#b4231f'"])], { designSystem: true });
    assert.equal(s.length, 1);
    assert.match(s[0].message, /Hard-coded hex colours/);
    assert.match(s[0].message, /Card\.tsx/);
    assert.ok(!/theme\.ts|tokens\.css/.test(s[0].message));
  });
  test("a clean component produces nothing", () => {
    assert.deepEqual(uiSignals([seg("src/Card.tsx", ["export const Card = () => <article className=\"card\"><h2>Title</h2></article>;"])], { designSystem: true }), []);
  });
});

describe("static QA uses the lint", () => {
  const change = (diffLines: string[], over: Partial<ChangeSet> = {}): ChangeSet => ({
    diff: seg("src/Tabs.tsx", diffLines).diff,
    modified: [],
    added: ["src/Tabs.tsx"],
    deleted: [],
    renamed: [],
    isEmpty: false,
    ...over,
  });
  test("an emoji icon in a diff becomes a deterministic defect", () => {
    const s = deterministicSignals(change(["<Text>🏠</Text>"]));
    assert.ok(s.some((x) => x.severity === "defect" && x.requirement === "No emoji used as icons in the UI"));
  });
  test("a review of it reports a defect against the emoji rule even if the model finds everything fine", async () => {
    const review = await staticQaReview("add a tab bar", change(["<Text>🏠</Text>"]), { ask: async () => JSON.stringify({ findings: [{ requirement: "tab bar", status: "satisfied", evidence: "present" }], concerns: [], summary: "ok", needsPerFileReview: false }) }, "ctx");
    assert.ok(review.defectFound);
    assert.ok(review.findings.some((f) => f.requirement === "No emoji used as icons in the UI" && f.status === "missing" && /vector icon set/.test(f.evidence)));
  });
  test("a clean diff is untouched, and the old stub signals keep their own requirement name", async () => {
    assert.deepEqual(deterministicSignals(change(["export const A = () => <article><h2>x</h2></article>;"])), []);
    const dead = deterministicSignals({ ...change(["a"]), deleted: ["src/a.test.ts"] });
    assert.ok(dead.some((x) => x.severity === "defect" && !x.requirement));
  });
});

describe("type scale steps", () => {
  test("no two steps are the same size at any ratio, and the base stays 16", () => {
    for (const r of [1.125, 1.2, 1.25, 1.333, 1.5]) {
      const t = typeScale(r);
      assert.equal(t[2].size, 16, String(r));
      for (let i = 1; i < t.length; i++) assert.ok(t[i].size > t[i - 1].size, `${r}: ${t.map((x) => x.size)}`);
    }
  });
});

describe("an approved brand kit rules the product UI", () => {
  const kit = (over: object = {}) => ({ name: "Lumen", paletteSystem: { brand: [{ hex: "#0d9488", locked: true }, { hex: "#e11d48", locked: true }] }, typography: { pairing: { display: "Newsreader", body: "Source Sans 3" } }, ...over });
  test("the signature, accent and type come from brand.json, not from a fresh choice", async () => {
    const { findBrandKit } = await import("../src/uiDesign.js");
    const dir = repo(WEB, { "brand/lumen/brand.json": JSON.stringify(kit()) });
    const k = findBrandKit(dir)!;
    assert.deepEqual([k.signature, k.accent, k.display, k.body, k.name, k.dir], ["#0d9488", "#e11d48", "Newsreader", "Source Sans 3", "Lumen", "brand/lumen"]);
    const r = (await ensure(dir, modelFor()))!;
    const md = fs.readFileSync(path.join(dir, DESIGN_DIR, "MASTER.md"), "utf-8");
    assert.match(md, /Signature #0d9488/);
    assert.match(md, /Newsreader/);
    assert.match(r.summary, /signature #0d9488/);
  });
  test("no kit, a kit with no colour, and broken json are all ignored", async () => {
    const { findBrandKit } = await import("../src/uiDesign.js");
    assert.equal(findBrandKit(repo(WEB)), null);
    assert.equal(findBrandKit(repo(WEB, { "brand/x/brand.json": JSON.stringify(kit({ paletteSystem: { brand: [{ hex: "#111111" }] } })) })), null);
    assert.equal(findBrandKit(repo(WEB, { "brand/x/brand.json": "{nope" })), null);
  });
});
