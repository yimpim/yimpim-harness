import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PAIRINGS, STYLES, PAGE_TYPES, VARIANCE, findPageType } from "../src/uiKnowledge.js";
import {
  allPairings, chartRows, findAnyPairing, findLanding, findProduct, landingMenu, landingPatterns, nativeRules, productMenu, products, stackKeys, stackNotes, styleDetail, styleDetails,
} from "../src/uiData.js";
import { buildDesignSystem, detectUiStack, directionSystem, masterDoc, parseDirection, referenceDocs } from "../src/uiDesign.js";
import { findPlaybook } from "../src/uiKnowledge.js";

const repo = (pkg: object) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
};
const EXPO = detectUiStack(repo({ dependencies: { expo: "52", "react-native": "0.76" } }));
const WEB = detectUiStack(repo({ dependencies: { next: "15", react: "19", "react-dom": "19", tailwindcss: "4" } }));

describe("the reference tables", () => {
  test("they load with the expected sizes and clean rows", () => {
    assert.equal(products().length, 192);
    assert.equal(landingPatterns().length, 34);
    assert.equal(chartRows().length, 25);
    assert.equal(nativeRules().length, 32);
    assert.ok(styleDetails().length >= 50);
    for (const list of [products().map((p) => p.id), landingPatterns().map((p) => p.id), styleDetails().map((s) => s.id)]) assert.equal(new Set(list).size, list.length);
    for (const p of products()) {
      assert.ok(p.name && p.pattern && p.style, p.id);
      for (const h of [p.palette.primary, p.palette.accent, p.palette.background]) assert.match(h, /^#[0-9a-f]{6}$/i, `${p.id} ${h}`);
    }
  });
  test("the news row and its category palette are there; conditions are readable words", () => {
    const n = findProduct("news-media-platform")!;
    assert.deepEqual(n.must, ["mobile first reading", "category navigation"]);
    assert.match(n.palette.primary, /^#/);
    const withWhen = products().find((p) => Object.keys(p.when).length > 0)!;
    for (const [c, a] of Object.entries(withWhen.when)) {
      assert.ok(!c.startsWith("if_") && !c.includes("_"), c);
      assert.ok(a.length > 0);
    }
  });
  test("every style of ours that names a reference style finds its implementation notes", () => {
    for (const s of STYLES.filter((x) => x.ref)) {
      const d = styleDetail(s.ref);
      assert.ok(d, `${s.id} -> ${s.ref}`);
      assert.ok(d!.checklist.length > 0 && d!.css.length > 0, s.id);
    }
    assert.equal(styleDetail(undefined), undefined);
    assert.equal(styleDetail("nope"), undefined);
  });
  test("menus a model picks from carry ids", () => {
    assert.match(productMenu(), /^saas-general: SaaS \(General\)$/m);
    assert.match(landingMenu(), /^hero-features-cta: Hero \+ Features \+ CTA — /m);
    assert.ok(findLanding("hero-features-cta") && !findLanding("nope"));
  });
  test("the attribution travels with the data", () => {
    const notice = fs.readFileSync(new URL("../assets/ui/NOTICE.md", import.meta.url), "utf-8");
    assert.match(notice, /MIT License/);
    assert.match(notice, /ui-ux-pro-max-skill/);
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    assert.ok(pkg.files.includes("assets/ui"));
  });
});

describe("type pairings", () => {
  test("ours first, then the reference ones, with no repeats of the same two fonts", () => {
    const all = allPairings();
    assert.ok(all.length > PAIRINGS.length + 20);
    assert.deepEqual(all.slice(0, PAIRINGS.length).map((p) => p.id), PAIRINGS.map((p) => p.id));
    const keys = all.map((p) => `${p.heading}|${p.body}`.toLowerCase());
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(new Set(all.map((p) => p.id)).size, all.length);
  });
  test("other scripts are covered, with weights parsed from the font URL", () => {
    const names = allPairings().map((p) => `${p.heading} ${p.body}`).join("|");
    for (const f of ["Noto Serif JP", "Noto Sans KR", "Noto Naskh Arabic", "Noto Sans Thai", "Noto Sans Hebrew", "Be Vietnam Pro"]) assert.match(names, new RegExp(f));
    const jp = allPairings().find((p) => p.heading === "Noto Serif JP")!;
    assert.match(jp.weights.heading, /^[0-9;]+$/);
    assert.ok(findAnyPairing(jp.id));
    assert.equal(findAnyPairing("nope"), undefined);
  });
});

describe("stack notes", () => {
  test("a project's frameworks pick the right notes; unknown ones pick nothing", () => {
    assert.deepEqual(stackKeys(["expo", "react-native", "react"], [], "native"), ["react-native"]);
    assert.deepEqual(stackKeys(["next", "react"], ["tailwindcss"], "web").sort(), ["html-tailwind", "nextjs"]);
    assert.deepEqual(stackKeys(["react"], ["tailwindcss", "shadcn"], "web").sort(), ["html-tailwind", "react", "shadcn"]);
    assert.deepEqual(stackKeys([], [], "unknown"), []);
    assert.ok(stackNotes("react-native").length > 5 && stackNotes("react-native").every((n) => n.rule && n.do));
    assert.deepEqual(stackNotes("cobol"), []);
  });
});

describe("the direction uses the product row", () => {
  const pb = findPlaybook("news")!;
  const row = findProduct("news-media-platform")!;
  const withConditions = products().find((p) => Object.keys(p.when).length >= 1)!;
  test("the prompt carries the row's musts, the category palette as a norm to choose against, and a landing menu for the web only", () => {
    const web = directionSystem(pb, WEB, "web", row);
    assert.match(web, /Reference for "News\/Media Platform"/);
    assert.match(web, /Must have: mobile first reading; category navigation/);
    assert.match(web, /That is the category norm/);
    assert.match(web, /Landing-page structures/);
    assert.match(web, /Noto Serif JP/);
    assert.ok(!/Landing-page structures/.test(directionSystem(pb, EXPO, "native", row)));
    assert.ok(!/Reference for/.test(directionSystem(pb, WEB, "web")));
  });
  test("new fields are validated: conditions must be the row's, screens must be real page types, landing must exist", () => {
    const cond = Object.keys(withConditions.when)[0];
    const d = parseDirection(
      JSON.stringify({ applies: [cond, "made up condition"], screens: [{ name: "Home", pageType: "home" }, { name: "Bad", pageType: "bogus" }, { pageType: "feed" }], landing: "hero-features-cta", variance: "high", defaultMode: "dark", dataViz: true }),
      pb, WEB, "x", withConditions
    )!;
    assert.deepEqual(d.applies, [cond]);
    assert.deepEqual(d.screens, [{ name: "Home", pageType: "home" }]);
    assert.equal(d.landing, "hero-features-cta");
    assert.deepEqual([d.variance, d.defaultMode, d.dataViz, d.product], ["high", "dark", true, withConditions.id]);
    const bad = parseDirection(JSON.stringify({ landing: "nope", variance: "extreme", defaultMode: "purple", dataViz: "yes" }), pb, WEB, "x")!;
    assert.deepEqual([bad.landing, bad.variance, bad.defaultMode, bad.dataViz, bad.applies, bad.screens], [null, "mid", "system", false, [], []]);
  });
  test("a pairing for another script can be chosen", () => {
    const jp = allPairings().find((p) => p.heading === "Noto Serif JP")!;
    assert.equal(parseDirection(JSON.stringify({ pairing: jp.id }), pb, WEB, "x")!.pairing, jp.id);
  });
});

describe("reference docs", () => {
  const make = (j: object, stack = WEB, platform: "web" | "native" | "both" = "web") => {
    const d = parseDirection(JSON.stringify(j), findPlaybook("dashboard")!, stack, "x", findProduct("financial-dashboard"))!;
    const s = buildDesignSystem(d, platform, stack);
    return { s, refs: referenceDocs(s, stack) };
  };
  test("a web dashboard with charts gets style, screens and charts notes, and no native rules", () => {
    const { s, refs } = make({ style: "data-dense", dataViz: true, screens: [{ name: "Overview", pageType: "dashboard" }], landing: "hero-features-cta" });
    const names = refs.map((r) => r.name).sort();
    assert.deepEqual(names, ["charts.md", "screens.md", "stack.md", "style.md"]);
    const screens = refs.find((r) => r.name === "screens.md")!.data;
    assert.match(screens, /## Overview \(Dashboard\)/);
    assert.match(screens, /Every widget has loading, empty and error/);
    assert.match(screens, /## Landing structure: Hero \+ Features \+ CTA/);
    assert.match(refs.find((r) => r.name === "charts.md")!.data, /Never separate series by hue alone/);
    const md = masterDoc(s, WEB, "build a dashboard", refs);
    assert.match(md, /Also read, when it applies/);
    assert.match(md, /`design-system\/charts\.md`/);
  });
  test("charts only when the product has data; native rules only for native; both together for both", () => {
    assert.ok(!make({ dataViz: false }).refs.some((r) => r.name === "charts.md"));
    assert.ok(!make({}, WEB, "web").refs.some((r) => r.name === "native.md"));
    const nat = make({}, EXPO, "native").refs;
    assert.match(nat.find((r) => r.name === "native.md")!.data, /accessibilityLabel/);
    assert.ok(nat.some((r) => r.name === "stack.md" && /react-native/.test(r.data)));
    assert.ok(make({}, WEB, "both").refs.some((r) => r.name === "native.md"));
  });
  test("a screen with no real page type is left out, and nothing is written when there is nothing to say", () => {
    const { refs } = make({ screens: [{ name: "X", pageType: "bogus" }] });
    assert.ok(!refs.some((r) => r.name === "screens.md"));
  });
  test("page types and variance are complete", () => {
    assert.ok(PAGE_TYPES.length >= 14 && PAGE_TYPES.every((p) => p.layout && p.components && p.states && p.watch));
    assert.ok(findPageType("checkout") && !findPageType("nope"));
    assert.deepEqual(Object.keys(VARIANCE).sort(), ["high", "low", "mid"]);
  });
  test("MASTER lists the conditions that apply and fits the prompt budget with its pointers early", () => {
    const row = findProduct("news-media-platform")!;
    const withWhen = products().find((p) => Object.keys(p.when).length >= 1)!;
    const d = parseDirection(JSON.stringify({ applies: [Object.keys(withWhen.when)[0]], style: "editorial", screens: [{ name: "Front page", pageType: "feed" }] }), findPlaybook("news")!, WEB, "x", withWhen)!;
    const s = buildDesignSystem(d, "web", WEB);
    const md = masterDoc(s, WEB, "news", referenceDocs(s, WEB));
    assert.match(md, /Conditions that apply here:\n- If /);
    assert.ok(md.indexOf("Also read") > 0 && md.indexOf("Also read") < 3000);
    assert.ok(md.indexOf("## Files") < 2000);
    assert.ok(md.length < 12000, String(md.length));
    assert.ok(row);
  });
});
