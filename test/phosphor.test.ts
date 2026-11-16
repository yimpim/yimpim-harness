import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CORE_ICONS, ICON_NOTICE, PHOSPHOR_MIT, catalogue, fetchIconPaths, iconNamesTxt, iconUrl, iconsDoc, iconsTs, isIcon, packageFor, parseIconSvg, pascal, readIcon, resolveIconWords, searchIcons,
} from "../src/phosphor.js";
import { ensureDesignSystem, DESIGN_DIR } from "../src/uiDesign.js";

const HOUSE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M219.31,108.68l-80-80a16,16,0,0,0-22.62,0Z"/></svg>';

describe("the catalogue", () => {
  test("every icon is addressable: names are plain, unique, with categories and tags", () => {
    const c = catalogue();
    assert.ok(c.length > 1400);
    assert.equal(new Set(c.map((e) => e.n)).size, c.length);
    assert.ok(c.every((e) => /^[a-z0-9-]+$/.test(e.n) && e.c.length > 0 && e.t.length > 0));
  });
  test("every role in the core set is a real icon", () => {
    for (const [role, n] of Object.entries(CORE_ICONS)) assert.ok(isIcon(n), `${role} -> ${n}`);
    assert.ok(!isIcon("not-an-icon") && !isIcon("../etc/passwd") && !isIcon(42));
  });
  test("component names are PascalCase of the name", () => {
    assert.equal(pascal("arrow-square-in"), "ArrowSquareIn");
    assert.equal(pascal("house"), "House");
  });
  test("a word finds the plain icon first, then related ones, by name and by tag; nothing for nonsense", () => {
    assert.equal(searchIcons("house")[0], "house");
    assert.ok(searchIcons("newspaper").includes("newspaper"));
    assert.ok(searchIcons("football").includes("football"));
    assert.deepEqual(searchIcons("zzzzqqq"), []);
    assert.deepEqual(searchIcons("   "), []);
    assert.ok(searchIcons("savings").length > 0, "a tag-only word still finds icons");
    assert.deepEqual(resolveIconWords(["newspaper", "newspaper", "bookmark"]).filter((n, i, a) => a.indexOf(n) !== i), [], "no repeats");
    assert.ok(resolveIconWords(Array.from({ length: 40 }, () => "star"), 5, 7).length <= 7);
  });
  test("the full name list is grouped by category and complete", () => {
    const t = iconNamesTxt();
    assert.match(t, /^# arrows\n/m);
    for (const e of catalogue().slice(0, 50)) assert.ok(t.includes(e.n), e.n);
  });
});

describe("the shapes", () => {
  test("only plain path data is kept; anything else is refused", () => {
    assert.match(parseIconSvg(HOUSE)!, /^M219\.31,108\.68/);
    assert.equal(parseIconSvg('<svg viewBox="0 0 256 256"><path d="M0 0"/><script>alert(1)</script></svg>'), null);
    assert.equal(parseIconSvg('<svg viewBox="0 0 256 256"><g><path d="M0 0"/></g></svg>'), null);
    assert.equal(parseIconSvg('<svg viewBox="0 0 256 256"><image href="x"/></svg>'), null);
    assert.equal(parseIconSvg('<svg viewBox="0 0 256 256"><path d="M0 0 url(javascript:x)"/></svg>'), null);
    assert.equal(parseIconSvg("not svg"), null);
    assert.equal(parseIconSvg('<svg><path d="M0 0"/></svg>' + "x".repeat(40000)), null);
    assert.match(parseIconSvg('<svg><path d="M1 1L2 2"/><path d="M3 3L4 4"/></svg>')!, /^M1 1L2 2 M3 3L4 4$/);
  });
  test("urls follow the package layout: regular has no suffix, other weights do", () => {
    assert.equal(iconUrl("house", "regular"), "https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2.1.1/assets/regular/house.svg");
    assert.equal(iconUrl("house", "bold"), "https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2.1.1/assets/bold/house-bold.svg");
    assert.equal(iconUrl("house", "fill"), "https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2.1.1/assets/fill/house-fill.svg");
  });
  test("fetching asks only for real icons, in the weights wanted, and tolerates failures", async () => {
    const asked: string[] = [];
    const out = await fetchIconPaths(["house", "../../etc/passwd", "not-an-icon", "user", "gear"], ["regular", "fill", "duotone"], async (url) => {
      asked.push(url);
      return url.includes("user-fill") ? null : url.includes("gear") ? "<svg><script/></svg>" : HOUSE;
    });
    assert.deepEqual(Object.keys(out).sort(), ["house", "user"]);
    assert.ok(out["house"].regular && out["house"].fill && out["user"].regular && !out["user"].fill);
    assert.ok(asked.every((u) => u.startsWith("https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2.1.1/assets/")));
    assert.ok(!asked.some((u) => /passwd|not-an-icon|duotone/.test(u)), asked.join("\n"));
    assert.deepEqual(await fetchIconPaths(["house"], ["regular"], async () => { throw new Error("down"); }), {});
  });
  test("the reader refuses any other host, scheme, package, query or credentials, without touching the network", async () => {
    for (const u of [
      "https://evil.example/npm/@phosphor-icons/core@2.1.1/assets/regular/house.svg",
      "http://cdn.jsdelivr.net/npm/@phosphor-icons/core@2.1.1/assets/regular/house.svg",
      "https://cdn.jsdelivr.net/npm/other-package@1/assets/regular/house.svg",
      "https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2.1.1/assets/regular/house.svg?x=1",
      "https://user:pw@cdn.jsdelivr.net/npm/@phosphor-icons/core@2.1.1/assets/regular/house.svg",
      "file:///etc/passwd",
      "not a url",
    ]) assert.equal(await readIcon(u), null, u);
  });
  test("icons.ts is data only, carries the licence notice, and escapes names", () => {
    const ts = iconsTs({ house: { regular: "M0 0", fill: "M1 1" }, "arrow-left": { regular: "M2 2" } });
    assert.match(ts, /MIT License, Copyright \(c\) 2023 Phosphor Icons/);
    assert.match(ts, /export const viewBox = "0 0 256 256"/);
    assert.match(ts, /"arrow-left": \{ regular: "M2 2" \},/);
    assert.match(ts, /export type IconName = keyof typeof phosphor/);
  });
});

describe("what the project is told", () => {
  test("the official package for each stack", () => {
    assert.equal(packageFor(["expo", "react-native"], "native").pkg, "phosphor-react-native");
    assert.equal(packageFor(["expo", "react-native"], "native").also, "react-native-svg");
    assert.equal(packageFor(["next", "react"], "web").pkg, "@phosphor-icons/react");
    assert.equal(packageFor(["vue"], "web").pkg, "@phosphor-icons/vue");
    assert.equal(packageFor([], "web").pkg, "@phosphor-icons/web");
    assert.equal(packageFor([], "native", true).pkg, "phosphor_flutter");
  });
  const doc = (over: object = {}) => iconsDoc({ library: "phosphor", installed: false, pkg: packageFor(["next", "react"], "web"), weight: "bold", extra: ["newspaper", "football"], haveShapes: true, styleNote: "Pair it with the type.", ...over });
  test("it says what to install, the one weight, the core roles, every other name, and keeps the full licence", () => {
    const d = doc();
    for (const re of [/@phosphor-icons\/react/, /dependency flow \(request_dependency/, /One weight for the whole UI: \*\*bold\*\*/, /fill` for the active or selected state/, /home: `house` \(House\)/, /Chosen for this product/, /`newspaper` \(Newspaper\)/, /design-system\/icon-names\.txt/, /icons\.ts/, /Permission is hereby granted/]) assert.match(d, re);
    assert.ok(d.includes(PHOSPHOR_MIT) && ICON_NOTICE.includes("2023 Phosphor Icons"));
  });
  test("when already installed there is no install step and no path-data fallback", () => {
    const d = doc({ installed: true, library: "phosphor-react-native", haveShapes: false });
    assert.match(d, /Already installed \(`phosphor-react-native`\)/);
    assert.ok(!/dependency flow/.test(d) && !/If nothing can be installed/.test(d));
  });
});

// ---------------------------------------------------------------------------

const repo = (pkg: object) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
};
const WEB = { dependencies: { next: "15", react: "19", "react-dom": "19" } };
const model = (direction: object = {}, decision: object = { ui: "new", platform: "web", playbook: "news", product: "news-media-platform" }) => async (_m: string[], _x: any[], label: string) => {
  if (label === "design decision") return JSON.stringify(decision);
  if (label === "design direction") return JSON.stringify({ style: "editorial", pairing: "news-editorial", signature: "#b4231f", iconWeight: "light", iconWords: ["newspaper", "bookmark", "football", "not-a-real-thing-xyz"], ...direction });
  return "{}";
};
const run = (dir: string, call: any, fetchIcon: any) => ensureDesignSystem({ call, models: ["a/x"], repoRoot: dir, request: "build me a news website", log: () => {}, fetchIcon });
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, DESIGN_DIR, f), "utf-8");

describe("the design step and icons", () => {
  test("no icon library: Phosphor by default, notes, the name list, and path data fetched for the core set and this product", async () => {
    const dir = repo(WEB);
    const asked: string[] = [];
    const r = (await run(dir, model(), async (u: string) => (asked.push(u), HOUSE)))!;
    for (const f of ["icons.md", "icon-names.txt", "icons.ts"]) assert.ok(r.files.includes(`design-system/${f}`), f);
    const md = read(dir, "icons.md");
    assert.match(md, /One weight for the whole UI: \*\*light\*\*/);
    assert.match(md, /`newspaper` \(Newspaper\)/);
    assert.match(md, /`football`/);
    assert.ok(!/not-a-real-thing/.test(md), "a word that matches nothing never becomes a name");
    assert.match(md, /@phosphor-icons\/react/);
    assert.match(read(dir, "MASTER.md"), /Phosphor \(all icons; names, usage and licence in design-system\/icons\.md\)\. One weight: light/);
    assert.match(read(dir, "MASTER.md"), /design-system\/icons\.md/);
    assert.ok(asked.some((u) => u.includes("/regular/house.svg")) && asked.some((u) => u.includes("/fill/house-fill.svg")) && asked.some((u) => u.includes("/light/newspaper-light.svg")));
    assert.match(read(dir, "icons.ts"), /"house": \{ regular: "M219/);
  });
  test("already installed: no fetching, no path data, still the notes and the full list", async () => {
    const dir = repo({ dependencies: { ...WEB.dependencies, "@phosphor-icons/react": "2" } });
    let asked = 0;
    const r = (await run(dir, model({ iconLibrary: "phosphor" }), async () => (asked++, HOUSE)))!;
    assert.equal(asked, 0);
    assert.ok(!r.files.includes("design-system/icons.ts"));
    assert.ok(r.files.includes("design-system/icons.md") && r.files.includes("design-system/icon-names.txt"));
    assert.match(read(dir, "icons.md"), /Already installed \(`@phosphor-icons\/react`\)/);
  });
  test("when the shapes cannot be fetched the notes are still written, without icons.ts", async () => {
    const dir = repo(WEB);
    const r = (await run(dir, model(), async () => null))!;
    assert.ok(r.files.includes("design-system/icons.md") && !r.files.includes("design-system/icons.ts"));
    assert.ok(!/If nothing can be installed/.test(read(dir, "icons.md")));
  });
  test("a project that already uses another icon library keeps it; no Phosphor files are written", async () => {
    const dir = repo({ dependencies: { ...WEB.dependencies, "lucide-react": "1" } });
    const r = (await run(dir, model({ iconLibrary: "lucide-react" }), async () => HOUSE))!;
    assert.ok(!r.files.some((f) => /icons\.md|icon-names|icons\.ts/.test(f)));
    assert.match(read(dir, "MASTER.md"), /lucide-react \(already installed\)/);
  });
  test("asking for inline SVG instead is respected", async () => {
    const dir = repo(WEB);
    const r = (await run(dir, model({ iconLibrary: "inline-svg" }), async () => HOUSE))!;
    assert.ok(!r.files.some((f) => /icon/.test(f)));
  });
  test("an expo app is pointed at phosphor-react-native with react-native-svg", async () => {
    const dir = repo({ dependencies: { expo: "52", "react-native": "0.76" } });
    await run(dir, model({}, { ui: "new", platform: "native", playbook: "tracker" }), async () => HOUSE);
    const md = read(dir, "icons.md");
    assert.match(md, /phosphor-react-native/);
    assert.match(md, /react-native-svg/);
  });
  test("a weight that is not a real UI weight falls back to regular", async () => {
    const dir = repo(WEB);
    await run(dir, model({ iconWeight: "fill" }), async () => null);
    assert.match(read(dir, "icons.md"), /\*\*regular\*\*/);
  });
});
