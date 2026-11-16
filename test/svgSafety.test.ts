/**
 * An SVG a model wrote is untrusted. It is rebuilt from an allowlist, measured,
 * and recoloured by the harness (no model redraws a variant).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { auditSvg, buildIco, extractSvg, innerSvg, luminance, normalizeColor, placeOnTile, recolorSvg, sanitizeSvg } from "../src/svgSafety.js";

const GOOD = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#ff0000"/><rect x="40" y="40" width="20" height="20" fill="#ffffff"/></svg>';

describe("sanitizeSvg", () => {
  test("a plain mark passes through, with the namespace added", () => {
    const r = sanitizeSvg(GOOD);
    assert.equal(r.problems.length, 0);
    assert.match(r.svg!, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100">/);
    assert.match(r.svg!, /<circle cx="50" cy="50" r="40" fill="#ff0000"\/>/);
  });

  test("it is found inside prose and a code fence", () => {
    assert.equal(extractSvg("Here you go:\n```svg\n" + GOOD + "\n```\nEnjoy"), GOOD);
    assert.ok(sanitizeSvg("Sure!\n```xml\n" + GOOD + "\n```").svg);
    assert.equal(sanitizeSvg("I cannot draw that").svg, null);
  });

  test("script, event handlers and embedded html never survive", () => {
    const r = sanitizeSvg(
      '<svg viewBox="0 0 100 100" onload="alert(1)"><script>alert(1)</script><circle cx="5" cy="5" r="4" onclick="x()" fill="red"/><foreignObject><div>hi</div></foreignObject></svg>'
    );
    assert.ok(r.svg);
    assert.ok(!/script|onload|onclick|foreignObject|alert|<div/i.test(r.svg!));
    assert.match(r.svg!, /<circle cx="5" cy="5" r="4" fill="red"\/>/);
    assert.ok(r.problems.some((p) => /not allowed/.test(p)));
  });

  test("nothing may point outside the drawing", () => {
    const r = sanitizeSvg(
      '<svg viewBox="0 0 100 100"><image href="https://evil.example/x.png"/><use href="data:image/svg+xml;base64,AAA"/><rect width="9" height="9" fill="url(https://evil.example/g)"/><rect width="8" height="8" fill="url(#ok)"/><path d="M0 0 L9 9" fill="javascript:alert(1)"/></svg>'
    );
    assert.ok(r.svg);
    assert.ok(!/evil|javascript|data:|<image|<use/i.test(r.svg!));
    assert.match(r.svg!, /fill="url\(#ok\)"/);
  });

  test("a path with anything but path commands is dropped", () => {
    const r = sanitizeSvg('<svg viewBox="0 0 100 100"><path d="M0 0 <script>" fill="red"/><path d="M10 10 L90 10 L50 90 Z" fill="red"/></svg>');
    assert.equal((r.svg!.match(/<path/g) ?? []).length, 2);
    assert.ok(!/<script/.test(r.svg!));
  });

  test("text is refused with an instruction to draw the letters as shapes", () => {
    const r = sanitizeSvg('<svg viewBox="0 0 100 100"><text x="5" y="50">Acme</text><circle cx="5" cy="5" r="4"/></svg>');
    assert.ok(r.svg);
    assert.ok(!/<text|Acme/.test(r.svg!));
    assert.ok(r.problems.some((p) => /uses <text>/.test(p) && /outlines or simple shapes/.test(p)));
  });

  test("style and class are reported, because dropping them silently loses colours", () => {
    const r = sanitizeSvg('<svg viewBox="0 0 100 100"><circle cx="5" cy="5" r="4" style="fill:red" class="a"/></svg>');
    assert.ok(r.problems.some((p) => /attribute style/.test(p)));
  });

  test("a cut-off or unbalanced reply yields nothing usable and says why", () => {
    const r = sanitizeSvg('<svg viewBox="0 0 100 100"><g><circle cx="5" cy="5" r="4"/></svg>');
    assert.equal(r.svg, null);
    assert.ok(r.problems.length > 0);
  });

  test("a missing viewBox is taken from width and height, or reported", () => {
    assert.match(sanitizeSvg('<svg width="64" height="64"><circle cx="5" cy="5" r="4"/></svg>').svg!, /viewBox="0 0 64 64"/);
    const r = sanitizeSvg('<svg><circle cx="5" cy="5" r="4"/></svg>');
    assert.equal(r.svg, null);
    assert.ok(r.problems.some((p) => /viewBox/.test(p)));
  });

  test("an oversize reply is refused outright", () => {
    assert.equal(sanitizeSvg('<svg viewBox="0 0 1 1">' + "<g/>".repeat(20000) + "</svg>").svg, null);
  });

  test("element names keep their case where SVG needs it", () => {
    const r = sanitizeSvg('<svg viewBox="0 0 100 100"><defs><LINEARGRADIENT id="g"><stop offset="0" stop-color="#000"/></LINEARGRADIENT></defs><rect width="9" height="9" fill="url(#g)"/></svg>');
    assert.match(r.svg!, /<linearGradient id="g">/);
  });
});

describe("auditSvg", () => {
  test("it counts shapes and colours", () => {
    const a = auditSvg(sanitizeSvg(GOOD).svg!);
    assert.equal(a.shapes, 2);
    assert.deepEqual(new Set(a.colors), new Set(["#ff0000", "#ffffff"]));
    assert.deepEqual(a.issues, []);
  });

  test("a shape with no fill is black", () => {
    assert.deepEqual(auditSvg('<svg viewBox="0 0 100 100"><circle cx="5" cy="5" r="4"/></svg>').colors, ["#000000"]);
  });

  test("it flags what makes a poor mark", () => {
    const many = '<svg viewBox="0 0 100 100">' + ["#111", "#222", "#333", "#444"].map((c) => `<rect width="9" height="9" fill="${c}"/>`).join("") + "</svg>";
    assert.ok(auditSvg(many).issues.some((i) => /4 colours/.test(i)));
    assert.ok(auditSvg('<svg viewBox="0 0 100 100"></svg>').issues.some((i) => /nothing/.test(i)));
    assert.ok(auditSvg('<svg viewBox="0 0 200 100"><rect width="9" height="9"/></svg>').issues.some((i) => /square/.test(i)));
    const busy = '<svg viewBox="0 0 100 100">' + '<circle cx="5" cy="5" r="4"/>'.repeat(41) + "</svg>";
    assert.ok(auditSvg(busy).issues.some((i) => /41 shapes/.test(i)));
  });
});

describe("recolour and placement, done by the harness", () => {
  test("every paint becomes one colour; none stays none; default-black shapes are recoloured", () => {
    const svg = '<svg viewBox="0 0 100 100"><circle cx="5" cy="5" r="4"/><rect width="9" height="9" fill="#ff0000" stroke="none"/><path d="M0 0L9 9" fill="none" stroke="#00ff00"/></svg>';
    const r = recolorSvg(svg, "#ffffff");
    assert.ok(!/#ff0000|#00ff00/.test(r));
    assert.match(r, /<rect width="9" height="9" fill="#ffffff" stroke="none"\/>/);
    assert.match(r, /fill="none" stroke="#ffffff"/);
    assert.match(r, /<circle cx="5" cy="5" r="4" fill="#ffffff"\/>/);
  });

  test("a light part of a two-colour mark stays visible: it becomes the knockout colour, not the mark colour", () => {
    const disc = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#2563eb"/><path d="M30 55L45 70L72 36" fill="none" stroke="#ffffff" stroke-width="8"/></svg>';
    const black = recolorSvg(disc, "#000000", undefined, "#ffffff");
    assert.match(black, /<circle[^>]*fill="#000000"/);
    assert.match(black, /<path[^>]*stroke="#ffffff"/, "the check is still white against the black disc");
    const white = recolorSvg(disc, "#ffffff", undefined, "#111111");
    assert.match(white, /<circle[^>]*fill="#ffffff"/);
    assert.match(white, /<path[^>]*stroke="#111111"/);
  });

  test("a mark whose only colour is light is not turned into a knockout of nothing", () => {
    const light = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#fafafa"/></svg>';
    assert.match(recolorSvg(light, "#000000", undefined, "#ffffff"), /fill="#000000"/);
  });

  test("evenodd holes survive a recolour", () => {
    const svg = '<svg viewBox="0 0 100 100"><path d="M0 0H100V100H0Z M30 30H70V70H30Z" fill="#123456" fill-rule="evenodd"/></svg>';
    assert.match(recolorSvg(svg, "#000000"), /fill-rule="evenodd"/);
  });

  test("a background is a rect the size of the viewBox", () => {
    assert.match(recolorSvg('<svg viewBox="0 0 64 64"><circle cx="5" cy="5" r="4"/></svg>', "#fff", "#111111"), /<rect x="0" y="0" width="64" height="64" fill="#111111"\/>/);
  });

  test("a tile puts the mark in the middle of a 100 box at the given scale", () => {
    const t = placeOnTile('<svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20" fill="#f00"/></svg>', { scale: 0.5, background: "#0000ff", rounded: 20, mark: "#ffffff" });
    assert.match(t, /viewBox="0 0 100 100"/);
    assert.match(t, /<rect width="100" height="100" rx="20" fill="#0000ff"\/>/);
    assert.match(t, /translate\(25\.000 25\.000\) scale\(1\.00000\)/);
    assert.match(t, /fill="#ffffff"/);
    assert.ok(!/#f00/.test(t));
    assert.equal(innerSvg('<svg viewBox="0 0 1 1"><g/></svg>'), "<g/>");
  });

  test("colour parsing and luminance", () => {
    assert.equal(normalizeColor("#abc"), "#aabbcc");
    assert.equal(normalizeColor("rgb(255, 0, 0)"), "#ff0000");
    assert.equal(normalizeColor("White"), "#ffffff");
    assert.equal(normalizeColor("none"), null);
    assert.equal(normalizeColor("url(#g)"), null);
    assert.ok(luminance("#ffffff") > 0.99 && luminance("#000000") < 0.01);
  });
});

describe("buildIco", () => {
  test("a valid header, an entry per image, and the images themselves", () => {
    const a = Buffer.from("AAAA");
    const b = Buffer.from("BBBBBB");
    const ico = buildIco([{ size: 16, data: a }, { size: 32, data: b }]);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    assert.equal(ico.readUInt8(6), 16);
    assert.equal(ico.readUInt32LE(6 + 8), 4);
    const off2 = ico.readUInt32LE(6 + 16 + 12);
    assert.equal(ico.subarray(off2, off2 + 6).toString(), "BBBBBB");
  });
});
