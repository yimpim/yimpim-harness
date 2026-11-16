/**
 * Real type, turned into shapes. These use the actual bundled fonts, so a font that
 * is damaged, missing a letter, or mis-described in the manifest fails here, not in front of a user.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import os from "node:os";
import path from "node:path";
import {
  applyCase,
  buildLockupSvg,
  buildWordmarkSvg,
  clampTracking,
  findFont,
  fontFile,
  INK,
  layoutWordmark,
  licenceFile,
  loadCatalog,
  MARK_FIT,
  pathToD,
  placeSymbol,
  type Wordmark,
} from "../src/wordmark.js";
import { auditSvg, sanitizeSvg } from "../src/svgSafety.js";

const SYM = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#2563eb"/><path d="M30 55L45 70L72 36" fill="none" stroke="#ffffff" stroke-width="8"/></svg>';
const set = (over: Partial<Parameters<typeof layoutWordmark>[0]> = {}): Wordmark => {
  const r = layoutWordmark({ fontId: "poppins", weight: "bold", text: "Moonly", caseMode: "as-is", tracking: 0, ...over });
  if ("error" in r) throw new Error(r.error);
  return r.wordmark;
};
const width = (w: Wordmark) => w.box.x2 - w.box.x1;

describe("the catalogue", () => {
  const catalog = loadCatalog();

  test("fourteen families, each with its licence and real files", () => {
    assert.equal(catalog.length, 14);
    assert.equal(new Set(catalog.map((f) => f.id)).size, 14, "ids are unique");
    for (const f of catalog) {
      assert.ok(f.voice && f.feel, `${f.id} is described`);
      assert.ok(licenceFile(f), `${f.id} ships its OFL text`);
      for (const w of ["regular", "bold"] as const) {
        const got = fontFile(f, w);
        assert.ok(got && fs.existsSync(got.file), `${f.id} ${w}`);
      }
    }
  });

  test("every licence text is the SIL Open Font License", () => {
    for (const f of catalog) assert.match(fs.readFileSync(licenceFile(f)!, "utf-8"), /SIL OPEN FONT LICENSE Version 1\.1/, f.id);
  });

  test("the voices cover what a brand might want, and body faces exist", () => {
    assert.ok(catalog.filter((f) => f.body).length >= 3);
    for (const must of [/geometric sans/, /serif/, /rounded/, /slab/, /condensed/, /mono/, /script/]) assert.ok(catalog.some((f) => must.test(f.voice)), String(must));
  });

  test("a bold that does not exist falls back to the regular and says so", () => {
    const f = findFont("varelaround")!;
    assert.deepEqual(fontFile(f, "bold")!.weight, "regular");
    assert.equal(fontFile(findFont("poppins")!, "bold")!.weight, "bold");
  });

  test("a broken or missing manifest is an empty catalogue, not a crash", () => {
    assert.deepEqual(loadCatalog(path.join(os.tmpdir(), "no-such-fonts-dir")), []);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "fonts-"));
    fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ fonts: [{ id: "ghost", family: "Ghost", voice: "v", feel: "f", files: { regular: "Ghost.ttf" } }, { nonsense: true }] }));
    assert.deepEqual(loadCatalog(d), [], "an entry whose file is missing is dropped");
  });

  test("the package ships the fonts", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    assert.ok(pkg.files.includes("assets/fonts"));
    assert.ok(pkg.dependencies["opentype.js"]);
  });
});

describe("every font sets a real name without a damaged outline", () => {
  test("all fonts, both weights: caps, lowercase, digits and punctuation", () => {
    for (const f of loadCatalog()) {
      for (const weight of ["regular", "bold"] as const) {
        const r = layoutWordmark({ fontId: f.id, weight, text: "Wavy Tower 42 & Quick-Fox", caseMode: "as-is", tracking: 0.01 });
        assert.ok(!("error" in r), `${f.id} ${weight}: ${"error" in r ? r.error : ""}`);
        if (!("error" in r)) {
          assert.ok(!/NaN|Infinity/.test(r.wordmark.d));
          assert.ok(r.wordmark.capHeight > 40 && r.wordmark.capHeight < 100, `${f.id} cap height ${r.wordmark.capHeight}`);
        }
      }
    }
  });

  test("the path data comes from the outline's own commands: the library's serializer made NaN from ordinary numbers", () => {
    // DM Serif Display's "Pennywise" put a glyph at x = 276.40000000000003, which the library wrote as NaN.
    const w = set({ fontId: "dmserifdisplay", weight: "regular", text: "Pennywise" });
    assert.ok(!/NaN/.test(w.d));
    assert.match(w.d, /^M-?\d/);
  });

  test("pathToD rounds, never writes -0, and refuses anything not finite", () => {
    const p = (commands: any[]) => ({ commands, getBoundingBox: () => ({ x1: 0, y1: 0, x2: 1, y2: 1 }), toPathData: () => "" }) as any;
    assert.equal(pathToD(p([{ type: "M", x: 1.234567, y: -0.001 }, { type: "L", x: 2, y: 3 }, { type: "Q", x1: 1, y1: 1, x: 2, y: 2 }, { type: "C", x1: 1, y1: 1, x2: 2, y2: 2, x: 3, y: 3 }, { type: "Z" }])), "M1.23 0 L2 3 Q1 1 2 2 C1 1 2 2 3 3 Z");
    assert.equal(pathToD(p([{ type: "M", x: NaN, y: 1 }])), null);
    assert.equal(pathToD(p([{ type: "L", x: 1 }])), null, "a missing coordinate is not zero");
    assert.equal(pathToD(p([{ type: "X", x: 1, y: 1 }])), null, "an unknown command is refused");
  });
});

describe("setting the word", () => {
  test("case: as-is, lower, upper, title; a capitals-only face is always capitals", () => {
    assert.equal(applyCase("  moon  LY ", "as-is"), "moon LY");
    assert.equal(applyCase("Moon LY", "lower"), "moon ly");
    assert.equal(applyCase("Moon ly", "upper"), "MOON LY");
    assert.equal(applyCase("mOON lY", "title"), "Moon Ly");
    assert.equal(applyCase("moonly", "lower", true), "MOONLY");
    assert.equal(set({ fontId: "bebasneue", weight: "regular", caseMode: "lower" }).text, "MOONLY");
  });

  test("tracking is bounded", () => {
    assert.equal(clampTracking(5), 0.3);
    assert.equal(clampTracking(-5), -0.06);
    assert.equal(clampTracking("x"), 0);
    assert.equal(clampTracking(0.1), 0.1);
  });

  test("open tracking widens the word, and the font's kerning tightens pairs", () => {
    assert.ok(width(set({ tracking: 0.2 })) > width(set({ tracking: 0 })) + 30);
    // Barlow kerns AV by a clear amount. Work out where the V lands with and without it from the font itself.
    const b = fs.readFileSync(fontFile(findFont("barlow")!, "regular")!.file);
    const font: any = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const [gA, gV] = [font.charToGlyph("A"), font.charToGlyph("V")];
    const unit = 100 / font.unitsPerEm;
    const kern = font.getKerningValue(gA, gV) * unit;
    assert.ok(kern < -3, `Barlow kerns AV (${kern})`);
    const inkWidth = (gap: number) => {
      const bbA = gA.getPath(0, 0, 100).getBoundingBox();
      const xV = gA.advanceWidth * unit + gap;
      const bbV = gV.getPath(xV, 0, 100).getBoundingBox();
      return Math.max(bbA.x2, bbV.x2) - Math.min(bbA.x1, bbV.x1);
    };
    const got = width(set({ fontId: "barlow", weight: "regular", text: "AV", tracking: 0 }));
    assert.ok(Math.abs(got - inkWidth(kern)) < 0.5, `kerned: ${got} vs ${inkWidth(kern)}`);
    assert.ok(inkWidth(0) - got > 3, "and it really is tighter than the unkerned pair");
  });

  test("a bold that the font lacks is set in the regular and reported as such", () => {
    assert.equal(set({ fontId: "varelaround", weight: "bold" }).font.weight, "regular");
  });

  test("what cannot be set says why", () => {
    const err = (spec: any) => (layoutWordmark({ fontId: "poppins", weight: "bold", text: "Moonly", caseMode: "as-is", tracking: 0, ...spec }) as any).error as string;
    assert.match(err({ fontId: "nope" }), /no font "nope"/);
    assert.match(err({ text: "   " }), /no name/);
    assert.match(err({ text: "x".repeat(41) }), /over 40 characters/);
    assert.match(err({ text: "Moon☃" }), /Poppins has no letter for "☃"/);
  });

  test("the baseline is zero, letters rise above it, and the box holds everything", () => {
    const w = set();
    assert.ok(w.box.y1 < -w.capHeight * 0.9, "tops are above the baseline");
    assert.ok(w.box.y2 > 0 && w.box.y2 < w.capHeight * 0.4, "only the y descends");
    assert.ok(w.xHeight < w.capHeight);
  });
});

describe("replacing a letter with the mark", () => {
  test("a round letter gives a slot about as tall as the letter, scaled to look as tall as its neighbours", () => {
    const plain = set();
    const w = set({ replaceLetter: 1 }); // moonly: m0 o1 o2 n3 l4 y5
    assert.ok(w.slot);
    assert.ok(w.slot!.size > w.xHeight * 0.9 && w.slot!.size < w.xHeight * MARK_FIT * 1.3, `slot ${w.slot!.size} vs x-height ${w.xHeight}`);
    assert.notEqual(w.d, plain.d, "the replaced letter is not drawn");
    assert.ok(w.slot!.x >= w.box.x1 - 0.01 && w.slot!.x + w.slot!.size <= w.box.x2 + 0.01, "the slot is inside the box");
  });

  test("spaces are not letters: the index counts letters only", () => {
    const a = set({ text: "ab o", replaceLetter: 2 });
    assert.ok(a.slot, "letter 2 of 'ab o' is the o");
    assert.match((layoutWordmark({ fontId: "poppins", weight: "bold", text: "ab o", caseMode: "as-is", tracking: 0, replaceLetter: 3 }) as any).error, /no letter number 3/);
  });

  test("a narrow letter cannot hold the mark", () => {
    const r = layoutWordmark({ fontId: "poppins", weight: "bold", text: "Moonly", caseMode: "as-is", tracking: 0, replaceLetter: 4 }) as any; // l
    assert.match(r.error, /too narrow/);
  });

  test("what follows the replaced letter moves to suit, so the word keeps its rhythm", () => {
    const a = set({ replaceLetter: 1 });
    const b = set({ replaceLetter: 2 });
    assert.notEqual(a.d, b.d);
    // the same two o's in either case: the word is about as wide as before, not collapsed or gapped
    assert.ok(Math.abs(width(a) - width(set())) < set().capHeight * 0.6);
  });
});

describe("lockups", () => {
  const word = set();

  test("a lockup is a clean SVG: shapes only, no text, nothing the sanitizer would remove", () => {
    for (const layout of ["horizontal", "stacked"] as const) {
      const svg = buildLockupSvg(SYM, word, layout, INK.light);
      const s = sanitizeSvg(svg);
      assert.deepEqual(s.problems, [], layout);
      assert.ok(!/<text|font-family/i.test(svg));
      assert.match(svg, /fill="#18181b"/);
      assert.ok(auditSvg(svg).viewBox.w > 0);
    }
  });

  test("beside the word the symbol is about twice the cap height; above it, about three times", () => {
    const h = buildLockupSvg(SYM, word, "horizontal", INK.light);
    const s = buildLockupSvg(SYM, word, "stacked", INK.light);
    assert.match(h, /scale\(/);
    const vbH = auditSvg(h).viewBox;
    const vbS = auditSvg(s).viewBox;
    assert.ok(vbH.w > vbH.h * 2.5, "horizontal is wide");
    assert.ok(vbS.h > vbS.w * 0.5 && vbS.w < vbH.w, "stacked is compact");
    const scaleOf = (svg: string) => Number(/scale\(([\d.]+)\)/.exec(svg)![1]);
    assert.ok(Math.abs(scaleOf(h) * 100 - word.capHeight * 2) < 1);
    assert.ok(Math.abs(scaleOf(s) * 100 - word.capHeight * 3) < 1);
  });

  test("the on-dark version uses the light ink", () => {
    assert.match(buildLockupSvg(SYM, word, "horizontal", INK.dark), /fill="#fafafa"/);
    assert.notEqual(INK.light, INK.dark);
  });

  test("a word with a slot puts the mark in it; without a symbol the slot is simply empty", () => {
    const w = set({ replaceLetter: 1 });
    const withMark = buildWordmarkSvg(w, INK.light, SYM);
    assert.match(withMark, /<g transform="translate\([-\d.]+ [-\d.]+\) scale\(/);
    assert.deepEqual(sanitizeSvg(withMark).problems, []);
    assert.ok(!/<g transform/.test(buildWordmarkSvg(w, INK.light)));
  });

  test("placeSymbol centres the mark where asked, whatever its viewBox", () => {
    const g = placeSymbol('<svg viewBox="10 20 50 50"><rect width="1" height="1"/></svg>', 100, 200, 100);
    // scale 2; the centre of the viewBox is (35, 45) and must land on (100, 200)
    assert.match(g, /translate\(30 110\) scale\(2\)/);
  });
});
