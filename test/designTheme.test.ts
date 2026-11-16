/**
 * Light and dark themes, the head-designer brief, and getting the pictures in
 * front of the person (phone included) before they are asked to choose.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adaptColor,
  adaptForTheme,
  adaptiveSvg,
  auditSvg,
  contrastRatio,
  DARK_SURFACE,
  LIGHT_SURFACE,
  sanitizeSvg,
  themeReport,
} from "../src/svgSafety.js";
import { CONSTRUCTION_EXAMPLES, DESIGN_DIRECTOR, runDesign, themeDefects, themeNote, type ChatMsg, type DesignDeps } from "../src/designer.js";
import type { Renderer } from "../src/svgRender.js";

const circle = (fill: string) => `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="${fill}"/></svg>`;

describe("themes", () => {
  test("contrast and the report say which surface a mark fades on", () => {
    assert.ok(contrastRatio("#000000", "#ffffff") > 20.9);
    assert.deepEqual(themeReport(circle("#000000")).fadesOn, ["dark"]);
    assert.deepEqual(themeReport(circle("#ffffff")).fadesOn, ["light"]);
    assert.deepEqual(themeReport(circle("#2563eb")).fadesOn, []);
    assert.deepEqual(themeReport(circle("#101018")).fadesOn, ["dark"]);
  });

  test("what touches the page is the first shape drawn, not an accent on top of it", () => {
    const disc = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#2563eb"/><path d="M30 55L45 70L72 36" fill="none" stroke="#ffffff" stroke-width="8"/></svg>';
    assert.equal(themeReport(disc).base, "#2563eb");
    assert.deepEqual(themeReport(disc).fadesOn, [], "a white check inside a blue disc is not a theme problem");
  });

  test("a failing colour keeps its hue and gains enough contrast", () => {
    const lighter = adaptColor("#101018", DARK_SURFACE)!;
    assert.ok(contrastRatio(lighter, DARK_SURFACE) >= 3.2);
    const darker = adaptColor("#fafaf0", LIGHT_SURFACE)!;
    assert.ok(contrastRatio(darker, LIGHT_SURFACE) >= 3.2);
    assert.equal(adaptColor("#2563eb", DARK_SURFACE), null, "a colour that already holds is left alone");
    // a coloured near-black stays bluish, not grey
    const navy = adaptColor("#0b1020", DARK_SURFACE)!;
    const [r, , b] = [1, 3, 5].map((i) => parseInt(navy.slice(i, i + 2), 16));
    assert.ok(b > r);
  });

  test("adapting changes only the colour that fades, only for the theme that needs it", () => {
    const black = circle("#000000");
    assert.equal(adaptForTheme(black, "light"), black);
    const onDark = adaptForTheme(black, "dark");
    assert.notEqual(onDark, black);
    assert.ok(!themeReport(onDark).fadesOn.includes("dark"), "the dark version holds on dark (it is allowed to fade on light)");
    // a shape that relied on the default black gets its colour written out, not lost
    const dflt = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';
    assert.match(adaptForTheme(dflt, "dark"), /fill="#[0-9a-f]{6}"/);
    assert.ok(!themeReport(adaptForTheme(dflt, "dark")).fadesOn.includes("dark"));
  });

  test("the adaptive favicon follows the viewer's setting with no script, and only when it must", () => {
    const a = adaptiveSvg(circle("#000000"));
    assert.match(a, /<style>@media \(prefers-color-scheme:dark\)\{\[fill="#000000"\]\{fill:#[0-9a-f]{6}\}/);
    assert.ok(!/<script/i.test(a));
    assert.equal(adaptiveSvg(circle("#2563eb")), circle("#2563eb"));
    const w = adaptiveSvg(circle("#ffffff"));
    assert.match(w, /prefers-color-scheme:light/);
  });
});

describe("the head designer", () => {
  test("the construction examples are sound: they pass the sanitizer, hold on both themes, and read when small", () => {
    const svgs = CONSTRUCTION_EXAMPLES.match(/<svg[\s\S]*?<\/svg>/g)!;
    assert.equal(svgs.length, 3);
    for (const s of svgs) {
      const r = sanitizeSvg(s);
      assert.deepEqual(r.problems, []);
      assert.deepEqual(auditSvg(r.svg!).issues, []);
      assert.deepEqual(themeReport(r.svg!).fadesOn, [], s);
    }
  });

  test("the craft brief states what a studio holds to, including both themes and originality", () => {
    for (const must of [/identifier, not an illustration/, /16 px/, /BOTH a white page and a near-black page/, /clich/, /optical balance/, /Never copy/]) assert.match(DESIGN_DIRECTOR, must);
  });
});

// ---------------------------------------------------------------------------

const repo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pennywise", description: "budgeting for students" }));
  return dir;
};
const fakeRenderer = (): Renderer => ({ png: async () => Buffer.from("PNG"), page: async () => Buffer.from("PAGE"), close: async () => {} });

interface Call {
  label: string;
  models: string[];
  messages: ChatMsg[];
}
const text = (m: ChatMsg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

function script(over: { draw?: (label: string) => string; look?: (label: string) => { score: number; defects: string[] }; fix?: string } = {}) {
  const calls: Call[] = [];
  const call: DesignDeps["call"] = async (models, messages, label) => {
    calls.push({ label, models, messages });
    if (label === "brief") return JSON.stringify({ name: "Pennywise", offering: "budgeting", audience: "students", personality: ["calm"], avoid: [], constraints: [], assumptions: [] });
    if (label.startsWith("concepts")) {
      const n = label.split(" ")[1];
      return JSON.stringify({ concepts: [1, 2].map((k) => ({ title: `Idea ${n}${k}`, markType: ["symbol", "lettermark", "abstract"][(Number(n) + k) % 3], idea: `idea ${n}${k}`, construction: "c" })) });
    }
    if (label.startsWith("draw")) return (over.draw ?? (() => circle("#2563eb")))(label);
    if (label.startsWith("look")) return JSON.stringify((over.look ?? (() => ({ score: 7, defects: [] })))(label));
    if (label.startsWith("fix")) return over.fix ?? circle("#2563eb");
    return "{}";
  };
  return { calls, call };
}

const base = (dir: string, call: DesignDeps["call"], over: Partial<DesignDeps> = {}): DesignDeps => ({
  repoRoot: dir,
  models: ["openai/a", "google/b", "anthropic/c"],
  visionModels: ["google/b"],
  call,
  renderer: fakeRenderer(),
  log: () => {},
  ...over,
});

describe("every model is briefed as the head designer", () => {
  test("concepts, drawing and judging all start from the craft brief; only drawing gets construction examples and the theme rule", async () => {
    const s = script();
    await runDesign(base(repo(), s.call), "logo");
    const system = (re: RegExp) => s.calls.filter((c) => re.test(c.label)).map((c) => text(c.messages[0]));
    for (const re of [/^concepts/, /^draw \d+$/, /^look/]) {
      const sys = system(re);
      assert.ok(sys.length > 0);
      for (const t of sys) assert.ok(t.startsWith(DESIGN_DIRECTOR), `${re} starts with the brief`);
    }
    for (const t of system(/^draw \d+$/)) {
      assert.match(t, /Examples of how a mark is CONSTRUCTED \(do not reuse these designs\)/);
      assert.match(t, /BOTH a white page \(#ffffff\) and a near-black page \(#0f0f14\)/);
    }
    for (const t of system(/^look/)) assert.match(t, /light surface and on a dark surface/);
    assert.ok(system(/^concepts/).every((t) => !/CONSTRUCTED/.test(t)));
  });
});

describe("a mark that fades on a theme", () => {
  test("it is told so, fixed, and the fix is kept because it holds on both", async () => {
    const dir = repo();
    const s = script({ draw: () => circle("#000000"), look: () => ({ score: 8, defects: [] }), fix: circle("#2563eb") });
    const r = await runDesign(base(dir, s.call), "logo");
    const fix = s.calls.find((c) => c.label.startsWith("fix"))!;
    assert.ok(fix, "a fix was asked for even though the judge liked the shape");
    assert.match(text(fix.messages[fix.messages.length - 1]), /On the dark surface the main colour #000000 fades into the page/);
    assert.match(fs.readFileSync(path.join(r.dir!, "logo.svg"), "utf-8"), /#2563eb/);
  });

  test("a fix that fixes the shape but loses a theme is not an improvement", async () => {
    const dir = repo();
    // good colour at first (score 7); the "fix" scores higher but is black, so it fades on dark
    const s = script({ look: (l) => (l.includes(".1") ? { score: 8, defects: [] } : { score: 7, defects: ["the curve bulges"] }), fix: circle("#000000") });
    const r = await runDesign(base(dir, s.call, { limits: { rounds: 1 } }), "logo");
    assert.match(fs.readFileSync(path.join(r.dir!, "logo.svg"), "utf-8"), /#2563eb/);
  });

  test("when it cannot be fixed, the kit still gives a dark and a light version, says so, and the favicon adapts", async () => {
    const dir = repo();
    const s = script({ draw: () => circle("#000000") });
    const r = await runDesign(base(dir, s.call, { limits: { rounds: 0 } }), "logo");
    const read = (f: string) => fs.readFileSync(path.join(r.dir!, f), "utf-8");
    assert.match(read("logo.svg"), /#000000/);
    assert.ok(!/#000000/.test(read("logo-on-dark.svg")));
    assert.equal(read("logo-on-light.svg"), read("logo.svg"));
    assert.match(read("favicon.svg"), /prefers-color-scheme:dark/);
    const json = JSON.parse(read("brand.json"));
    assert.deepEqual(json.theme.fadesOn, ["dark"]);
    assert.notEqual(json.theme.onDarkColor, "#000000");
    assert.match(r.text, /Theme: the main colour #000000 fades on the dark surface/);
    assert.match(read("README.md"), /logo-on-dark\.svg/);
  });

  test("a mark that holds on both is simply the same file for each, with no theme note", async () => {
    const dir = repo();
    const r = await runDesign(base(dir, script().call), "logo");
    const read = (f: string) => fs.readFileSync(path.join(r.dir!, f), "utf-8");
    assert.equal(read("logo-on-dark.svg"), read("logo.svg"));
    assert.ok(!/Theme:/.test(r.text));
    assert.equal(themeNote(circle("#2563eb")), "");
    assert.equal(themeDefects(circle("#2563eb")).length, 0);
  });
});

describe("the person sees what they are choosing between, wherever they are", () => {
  test("a picture per concept is shown BEFORE the question, then the final board; the question carries the ideas", async () => {
    const dir = repo();
    const order: string[] = [];
    const shown: { label: string; file: string; existed: boolean }[] = [];
    let prompt = "";
    await runDesign(
      base(dir, script().call, {
        show: (label, file) => {
          order.push("show");
          shown.push({ label, file, existed: fs.existsSync(file) });
        },
        ask: async (p, choices) => {
          order.push("ask");
          if (!prompt) prompt = p; // the first question is the concept pick; the wordmark pick comes later
          return choices[0];
        },
      }),
      "logo"
    );
    assert.deepEqual(order.slice(0, 4), ["show", "show", "show", "ask"], "all three pictures arrive first");
    assert.ok(shown.slice(0, 3).every((s) => s.existed && s.file.endsWith(".png") && path.isAbsolute(s.file)));
    assert.match(shown[0].label, /Concept A — .* \(recommended\)/);
    assert.match(prompt, /A — .*: idea/);
    assert.match(prompt, /pictures are above/);
    const fin = shown.find((s) => s.label.includes("final logo on light and dark"));
    assert.ok(fin && fin.file.endsWith("preview.png") && fin.existed);
    assert.equal(shown.indexOf(fin!), shown.length - 1, "the final board comes last, after the concepts and the wordmark options");
  });

  test("with no browser there are no pictures to show, and the question says where the SVG files are", async () => {
    const dir = repo();
    const shown: string[] = [];
    let prompt = "";
    await runDesign(base(dir, script().call, { renderer: null, show: (l) => shown.push(l), ask: async (p, c) => ((prompt = p), c[0]) }), "logo");
    assert.deepEqual(shown, []);
    assert.match(prompt, /No pictures could be made; the SVG files are in/);
  });

  test("the console log carries full paths, not paths relative to somewhere", async () => {
    const dir = repo();
    const logs: string[] = [];
    const r = await runDesign(base(dir, script().call, { log: (l) => logs.push(l) }), "logo");
    assert.ok(logs.some((l) => l.includes(path.join(r.dir!, "concepts"))));
    assert.ok(logs.some((l) => l.includes(path.join(r.dir!, "concepts.png"))));
    assert.ok(r.text.includes(r.dir!));
  });
});

describe("wiring", () => {
  const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("pictures go to a paired phone through the existing image channel, and the path is printed on the console", () => {
    assert.ok(src.includes("show: (label, file) => {"));
    assert.ok(src.includes("remote.pushScreenshot(`design_"));
    assert.match(src, /console\.log\(`   🖼️  \$\{label\}: \$\{file\}`\)/);
  });
});

describe("the app icon never swallows the main shape", () => {
  test("a near-black mark with a red dot keeps both, on a tile that is not the main colour", async () => {
    const dir = repo();
    const mark = '<svg viewBox="0 0 100 100"><path d="M20 12H44V62H84V88H20Z" fill="#0b0b0f"/><circle cx="68" cy="30" r="12" fill="#ef4444"/></svg>';
    const r = await runDesign(base(dir, script({ draw: () => mark }).call, { limits: { rounds: 0 } }), "logo");
    const icon = fs.readFileSync(path.join(r.dir!, "app-icon.svg"), "utf-8");
    assert.match(icon, /<rect[^>]*fill="#ffffff"/, "light tile: the near-black L contrasts with white");
    assert.match(icon, /fill="#0b0b0f"/);
    assert.match(icon, /fill="#ef4444"/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir!, "brand.json"), "utf-8")).appIconBackground, "#ffffff");
  });

  test("a pale mark gets a dark tile", async () => {
    const dir = repo();
    const mark = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#f5f5f4"/><circle cx="50" cy="50" r="12" fill="#ef4444"/></svg>';
    const r = await runDesign(base(dir, script({ draw: () => mark }).call, { limits: { rounds: 0 } }), "logo");
    assert.match(fs.readFileSync(path.join(r.dir!, "app-icon.svg"), "utf-8"), /<rect[^>]*fill="#0f0f14"/);
  });
});

describe("a dark mark changes colour on a dark surface, the way a designer would", () => {
  test("near-black, black and dark slate flip to near-white, keeping a trace of their hue", () => {
    for (const c of ["#000000", "#0b0b0f", "#1e293b", "#0b1020"]) {
      const to = adaptColor(c, DARK_SURFACE)!;
      assert.ok(contrastRatio(to, DARK_SURFACE) > 12, c + " -> " + to + " should be near-white, not a muddy mid-grey");
    }
    const [r, , b] = [1, 3, 5].map((i) => parseInt(adaptColor("#0b1020", DARK_SURFACE)!.slice(i, i + 2), 16));
    assert.ok(b > r, "a navy keeps a cool tint");
  });

  test("a pale mark flips to near-black on a light surface; a real colour is only nudged", () => {
    assert.ok(contrastRatio(adaptColor("#fafafa", LIGHT_SURFACE)!, LIGHT_SURFACE) > 12);
    assert.equal(adaptColor("#2563eb", DARK_SURFACE), null, "this blue already holds on dark");
    const deepBlue = adaptColor("#1e3a8a", DARK_SURFACE)!;
    assert.ok(contrastRatio(deepBlue, DARK_SURFACE) >= 3 && contrastRatio(deepBlue, DARK_SURFACE) < 12, "a saturated colour stays a colour");
  });

  test("the kit has a dark-mode app icon: a dark tile with the on-dark mark", async () => {
    const dir = repo();
    const mark = '<svg viewBox="0 0 100 100"><path d="M20 12H44V62H84V88H20Z" fill="#0b0b0f"/><circle cx="68" cy="30" r="12" fill="#ef4444"/></svg>';
    const r = await runDesign(base(dir, script({ draw: () => mark }).call, { limits: { rounds: 0 } }), "logo");
    const icon = fs.readFileSync(path.join(r.dir!, "app-icon-dark.svg"), "utf-8");
    assert.match(icon, /<rect[^>]*fill="#0f0f14"/);
    assert.ok(!/#0b0b0f/.test(icon), "the L is no longer near-black on a near-black tile");
    assert.match(icon, /fill="#ef4444"/);
    assert.ok(fs.existsSync(path.join(r.dir!, "app-icon-dark-1024.png")));
    assert.match(fs.readFileSync(path.join(r.dir!, "README.md"), "utf-8"), /app-icon-dark/);
  });
});
