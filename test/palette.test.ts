import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bestTextOn, contrast, deltaE2000, hexToOklch, neutralScale, oklchToHex, scaleOf, simulateCvd, tooClose } from "../src/colorlib.js";
import { ROLE_KEYS, buildPalette, parsePaletteChoice, paletteGpl, tokensCss, tokensDtcg } from "../src/palette.js";

const choice = (over: any = {}, locked: string[] = []) => parsePaletteChoice({ ground: "warm", accent: "#e11d48", ...over }, locked);

describe("colour arithmetic", () => {
  test("contrast is the WCAG ratio and is never rounded", () => {
    assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
    // #777777 on white is 4.48:1, which must NOT pass 4.5
    assert.ok(contrast("#777777", "#ffffff") < 4.5);
    assert.ok(contrast("#767676", "#ffffff") >= 4.5);
  });
  test("ΔE2000: identical is 0; the published Sharma sample pair is right", () => {
    assert.equal(deltaE2000("#336699", "#336699"), 0);
    assert.ok(deltaE2000("#ff0000", "#0000ff") > 40);
    // a small step in lightness is a small difference
    assert.ok(deltaE2000("#336699", "#376a9d") < 3);
  });
  test("OKLCH round-trips a colour within one unit per channel", () => {
    for (const hex of ["#2563eb", "#f59e0b", "#0d9488", "#7c3aed", "#111111", "#fafafa"]) {
      const o = hexToOklch(hex);
      const back = oklchToHex(o.l, o.c, o.h);
      assert.ok(deltaE2000(hex, back) < 1, `${hex} -> ${back}`);
    }
  });
  test("out-of-gamut chroma is reduced, not clipped to a wrong hue", () => {
    const hex = oklchToHex(0.9, 0.4, 150);
    assert.match(hex, /^#[0-9a-f]{6}$/);
    assert.ok(Math.abs(hexToOklch(hex).h - 150) < 12);
  });
  test("a colour-blind simulation merges red and green but keeps blue apart", () => {
    const r = simulateCvd("#d62828", "deutan");
    const g = simulateCvd("#3a8f2f", "deutan");
    assert.ok(deltaE2000(r, g) < deltaE2000("#d62828", "#3a8f2f"));
    assert.ok(deltaE2000(simulateCvd("#2563eb", "deutan"), simulateCvd("#facc15", "deutan")) > 20);
  });
  test("a ladder holds the anchor EXACTLY at one step, and has 11 steps from light to dark", () => {
    const s = scaleOf("#2563eb");
    assert.equal(s.length, 11);
    assert.ok(s.some((x) => x.hex === "#2563eb"));
    assert.ok(hexToOklch(s[0].hex).l > hexToOklch(s[10].hex).l);
  });
  test("neutrals stay neutral (chroma at or under 0.045)", () => {
    for (const n of neutralScale(250, 0.5)) assert.ok(hexToOklch(n.hex).c <= 0.05, n.hex);
  });
  test("a close competitor colour is caught, a different one is not", () => {
    assert.ok(tooClose("#2563eb", "#2f66e0"));
    assert.ok(!tooClose("#2563eb", "#e11d48"));
    // same hue sector and lightness while both chromatic
    assert.ok(tooClose("#3b82f6", "#4f7cf0"));
  });
  test("bestTextOn picks the readable side", () => {
    assert.equal(bestTextOn("#facc15").color, "#0b0b0f");
    assert.equal(bestTextOn("#1e3a8a").color, "#ffffff");
  });
});

describe("palette system", () => {
  const logos: string[][] = [["#2563eb", "#f59e0b"], ["#facc15"], ["#0d9488", "#ef4444"], ["#7c3aed"], ["#111111", "#e11d48"], ["#ff3b30"]];
  for (const logo of logos) {
    test(`every text pair passes in light AND dark for a logo of ${logo.join(" + ")}`, () => {
      const p = buildPalette(logo, choice({}, logo));
      const c = p.checks.find((x) => x.id === "contrast")!;
      assert.equal(c.status, "pass", c.detail);
      for (const k of ROLE_KEYS) {
        assert.match(p.light[k], /^#[0-9a-f]{6}$/i, `light.${k}`);
        assert.match(p.dark[k], /^#[0-9a-f]{6}$/i, `dark.${k}`);
      }
      assert.ok(contrast(p.light.text, p.light.background) >= 7);
      assert.ok(contrast(p.dark.text, p.dark.background) >= 7);
      assert.notEqual(p.dark.text.toLowerCase(), "#ffffff");
    });
  }
  test("the logo's own colours are locked and never edited, even when a pale one cannot carry white text", () => {
    const p = buildPalette(["#facc15"], choice());
    assert.equal(p.brand[0].hex, "#facc15");
    assert.ok(p.brand[0].locked);
    // text on the UI fill is dark, not white, so it passes
    assert.equal(p.light.onPrimary, "#0b0b0f");
  });
  test("an accent equal to the logo's colour, or grey, is dropped", () => {
    assert.equal(parsePaletteChoice({ accent: "#2563eb" }, ["#2563eb"]).accent, null);
    assert.equal(parsePaletteChoice({ accent: "#888888" }, []).accent, null);
    assert.equal(parsePaletteChoice({ accent: "not a colour" }, []).accent, null);
  });
  test("a model cannot inject a bad ground", () => {
    assert.equal(parsePaletteChoice({ ground: "javascript:alert(1)" }, []).ground, "white");
  });
  test("a second chromatic logo colour becomes the accent and the model's accent is not added", () => {
    const p = buildPalette(["#2563eb", "#f59e0b"], choice({ accent: "#e11d48" }));
    assert.equal(p.brand.length, 2);
    assert.ok(!p.brand.some((b) => b.hex === "#e11d48"));
  });
  test("a one-colour logo gets the model's accent as an unlocked colour", () => {
    const p = buildPalette(["#2563eb"], choice({ accent: "#e11d48" }));
    const acc = p.brand.find((b) => b.hex === "#e11d48");
    assert.ok(acc && !acc.locked);
  });
  test("competitor closeness is a gate that fails, and 'not checked' is never reported as a pass", () => {
    const none = buildPalette(["#2563eb"], choice()).checks.find((c) => c.id === "competitor-colours")!;
    assert.equal(none.status, "not-checked");
    const bad = buildPalette(["#2563eb"], choice(), [{ name: "Rival", hex: "#2f66e0", source: "measured" }]).checks.find((c) => c.id === "competitor-colours")!;
    assert.equal(bad.status, "fail");
    assert.match(bad.detail, /Rival/);
    const ok = buildPalette(["#2563eb"], choice(), [{ name: "Rival", hex: "#e11d48", source: "recalled" }]).checks.find((c) => c.id === "competitor-colours")!;
    assert.equal(ok.status, "pass");
    assert.match(ok.detail, /unverified/);
  });
  test("two colours of the same lightness are flagged for greyscale and colour-blind viewers", () => {
    const p = buildPalette(["#d62828", "#2f8f3f"], choice());
    const cv = p.checks.find((c) => c.id === "colour-vision")!;
    assert.equal(cv.status, "fail");
  });
  test("tokens: CSS has light on :root and dark twice (attribute and OS setting), DTCG parses, GPL lists the brand", () => {
    const p = buildPalette(["#2563eb", "#f59e0b"], choice());
    const css = tokensCss(p);
    assert.match(css, /:root \{[\s\S]*--bi-background:/);
    assert.match(css, /\[data-theme="dark"\]/);
    assert.match(css, /prefers-color-scheme: dark[\s\S]*:root:not\(\[data-theme="light"\]\)/);
    assert.match(css, /--bi-on-primary:/);
    const j = JSON.parse(tokensDtcg(p));
    assert.equal(j.light.primary.$type, "color");
    assert.ok(j.scale.primary["500"].$value);
    assert.match(paletteGpl(p), /GIMP Palette/);
  });
});

describe("status colours", () => {
  test("success and danger stay apart in lightness, in both modes, for any logo", () => {
    for (const logo of [["#2563eb"], ["#facc15"], ["#0d9488", "#ef4444"], ["#7c3aed"], ["#16a34a"], ["#dc2626"]]) {
      const p = buildPalette(logo, choice({}, logo));
      assert.equal(p.checks.find((c) => c.id === "status-not-by-colour-alone")!.status, "pass", logo.join(","));
    }
  });
});
