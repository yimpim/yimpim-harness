/**
 * Reference intake: what was given (an image, a URL, a named product), the request guard a live capture runs behind, colours and fonts read
 * from computed styles, the pages that are not captured (sign-in, bot walls, errors) and asked for as screenshots instead.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyReference,
  requestVerdict,
  hostChecker,
  cssColor,
  primaryFont,
  cuesFromSamples,
  describeCues,
  whyNotCaptured,
  gatherReferences,
  describeReferences,
  type StyleSample,
  type ReferenceBrowser,
  type PageVisit,
} from "../src/uiReference.js";

const roots: string[] = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
const tmp = (files: Record<string, string> = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-ref-"));
  roots.push(root);
  for (const [rel, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), c);
  }
  return root;
};

describe("what was given", () => {
  const root = tmp({ "shots/home.png": "x", "notes": "y" });
  test("a web address, with or without its scheme", () => {
    assert.deepEqual(classifyReference("https://linear.app/features", root), { kind: "url", value: "https://linear.app/features" });
    assert.deepEqual(classifyReference("stripe.com/payments", root), { kind: "url", value: "https://stripe.com/payments" });
    assert.deepEqual(classifyReference("example.co.uk", root), { kind: "url", value: "https://example.co.uk" });
  });
  test("a file on disk, or anything ending in an image extension (a missing one is reported, never searched for on the web)", () => {
    assert.equal(classifyReference("shots/home.png", root).kind, "image");
    assert.equal(classifyReference("notes", root).kind, "image");
    assert.equal(classifyReference("missing/screen.jpg", root).kind, "image");
  });
  test("anything else is a named product, kept as the person's words", () => {
    assert.deepEqual(classifyReference("Linear", root), { kind: "named", value: "Linear" });
    assert.deepEqual(classifyReference("like Stripe's dashboard", root), { kind: "named", value: "like Stripe's dashboard" });
  });
});

describe("the request guard a live capture runs behind", () => {
  test("data and blob always; other schemes, credentials, local names and private addresses never", () => {
    assert.equal(requestVerdict("data:image/png;base64,AA"), "allow");
    assert.equal(requestVerdict("blob:https://x.com/1"), "allow");
    for (const u of ["file:///etc/passwd", "ftp://x.com/a", "chrome://settings", "https://user:pw@x.com", "http://localhost:3000", "http://router.local", "http://db.internal", "http://printer.lan", "http://127.0.0.1", "http://10.0.0.8/admin", "http://192.168.1.1", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://0.0.0.0"])
      assert.equal(requestVerdict(u), "block", u);
    assert.equal(requestVerdict("https://93.184.216.34/"), "allow", "a public address literal");
    assert.equal(requestVerdict("https://fonts.example.com/a.woff2"), "check", "a host name is checked against its DNS answer");
  });

  test("a host is allowed only if every address it resolves to is public, asked once per capture", async () => {
    let asked = 0;
    const check = hostChecker(async (h) => {
      asked++;
      if (h === "public.example") return [{ address: "93.184.216.34" }];
      if (h === "rebind.example") return [{ address: "93.184.216.34" }, { address: "10.0.0.5" }];
      throw new Error("NXDOMAIN");
    });
    assert.equal(await check("public.example"), true);
    assert.equal(await check("public.example"), true);
    assert.equal(asked, 1);
    assert.equal(await check("rebind.example"), false, "one private answer is enough to refuse");
    assert.equal(await check("nothing.example"), false);
  });
});

describe("reading the rendered page", () => {
  test("computed colours: rgb and rgba become hex; mostly transparent is nothing", () => {
    assert.equal(cssColor("rgb(45, 85, 214)"), "#2d55d6");
    assert.equal(cssColor("rgba(255, 255, 255, 0.9)"), "#ffffff");
    assert.equal(cssColor("rgba(0, 0, 0, 0)"), null);
    assert.equal(cssColor("rgb(0 0 0 / 20%)"), null);
    assert.equal(cssColor("transparent"), null);
  });

  test("the typeface is the first real one in the stack; a system stack reads as system UI", () => {
    assert.equal(primaryFont(`"Inter Variable", Inter, -apple-system, sans-serif`), "Inter Variable");
    assert.equal(primaryFont(`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial`), "system UI");
    assert.equal(primaryFont(`Georgia, serif`), "Georgia");
    assert.equal(primaryFont(`var(--font), monospace`), null);
  });

  const s = (o: Partial<StyleSample>): StyleSample => ({ tag: "div", role: "surface", bg: null, color: "rgb(0, 0, 0)", font: "Inter, sans-serif", size: 16, weight: 400, radius: 0, area: 0, h: 20, text: 0, ...o });
  const samples: StyleSample[] = [
    s({ tag: "body", bg: "rgb(251, 251, 253)", area: 1440 * 1800 }),
    s({ tag: "section", bg: "rgb(250, 250, 252)", area: 1440 * 400 }), // reads as the same background
    s({ tag: "div", bg: "rgb(255, 255, 255)", area: 600 * 400, h: 400, radius: 16 }),
    s({ tag: "h1", role: "heading", color: "rgb(22, 24, 29)", font: `"Söhne", sans-serif`, size: 56, weight: 650, text: 30 }),
    s({ tag: "h2", role: "heading", color: "rgb(22, 24, 29)", font: `"Söhne", sans-serif`, size: 32, weight: 600, text: 20 }),
    s({ tag: "p", role: "text", color: "rgb(93, 99, 112)", font: `Inter, sans-serif`, size: 17, text: 600 }),
    s({ tag: "p", role: "text", color: "rgb(93, 99, 112)", font: `Inter, sans-serif`, size: 17, text: 400 }),
    s({ tag: "a", role: "button", bg: "rgb(45, 85, 214)", color: "rgb(255, 255, 255)", size: 16, weight: 600, radius: 10, area: 160 * 44, h: 44, text: 11 }),
    s({ tag: "nav", role: "text", color: "rgb(93, 99, 112)", size: 13, text: 900 }), // navigation text: not body text
    s({ tag: "span", role: "surface", bg: "rgb(60, 60, 70)", area: 12 * 12, h: 12, radius: 6 }), // a round dot: not a panel
    s({ tag: "a", role: "link", color: "rgb(45, 85, 214)", text: 30 }),
  ];
  const cues = cuesFromSamples(samples);

  test("background, text and accent come from what covers the screen and what is pressed", () => {
    assert.equal(cues.theme, "light");
    assert.equal(cues.background, "#fbfbfd");
    assert.equal(cues.text, "#5d6370");
    assert.equal(cues.accent, "#2d55d6");
    assert.ok(cues.palette.includes("#2d55d6") && cues.palette.length <= 6);
    assert.ok(!cues.palette.includes("#fafafc"), "near-identical colours are one");
  });

  test("fonts, sizes, weight and corner radius", () => {
    assert.deepEqual(cues.fonts, { heading: "Söhne", body: "Inter" });
    assert.deepEqual(cues.sizes, { body: 17, h1: 56 });
    assert.equal(cues.headingWeight, 650);
    assert.deepEqual(cues.radius, { button: 10, surface: 16 });
    assert.equal(cues.button, "#2d55d6");
    assert.match(describeCues(cues), /^light theme; background #fbfbfd; text #5d6370; accent #2d55d6; main button #2d55d6; fonts: Söhne for headings, Inter for text; body 17px, h1 56px, headings weight 650; corners: buttons 10px, surfaces 16px$/);
  });

  test("a dark pill button and an accent only in coloured text (as on yimpim.com)", () => {
    const c = cuesFromSamples([
      s({ tag: "body", bg: "rgb(251, 251, 253)", area: 1440 * 1800 }),
      s({ tag: "p", role: "text", color: "rgb(45, 85, 214)", size: 13, text: 30 }), // the eyebrow
      s({ tag: "p", role: "text", color: "rgb(93, 99, 112)", size: 16, text: 400 }),
      s({ tag: "a", role: "button", bg: "rgb(22, 24, 29)", color: "rgb(255, 255, 255)", radius: 999, h: 44, area: 144 * 44, text: 11 }),
    ]);
    assert.equal(c.accent, "#2d55d6");
    assert.equal(c.button, "#16181d");
    assert.equal(c.radius.button, "pill");
    assert.match(describeCues(c), /corners: buttons pill/);
  });

  test("a panel holding its own text (a terminal, a code block) still counts for surface corners", () => {
    const c = cuesFromSamples([s({ tag: "pre", role: "text", bg: "rgb(18, 20, 26)", radius: 16, h: 220, area: 720 * 220, text: 120 })]);
    assert.equal(c.radius.surface, 16);
  });

  test("a dark page reads as dark", () => {
    assert.equal(cuesFromSamples([s({ tag: "body", bg: "rgb(14, 16, 20)", area: 1000 })]).theme, "dark");
  });
});

describe("pages that are not what the person meant", () => {
  const v = (o: Partial<PageVisit>) => ({ finalUrl: "https://x.com/", status: 200, title: "X", passwordField: false, ...o });
  test("sign-in, by status, by address or by a password field", () => {
    assert.match(whyNotCaptured(v({ status: 401 }))!, /needs sign-in/);
    assert.match(whyNotCaptured(v({ finalUrl: "https://x.com/login?next=/app" }))!, /behind a sign-in page/);
    assert.match(whyNotCaptured(v({ finalUrl: "https://x.com/auth/sign-in" }))!, /behind a sign-in page/);
    assert.match(whyNotCaptured(v({ passwordField: true }))!, /behind a sign-in page/);
  });
  test("a bot wall, and an error status", () => {
    assert.equal(whyNotCaptured(v({ status: 403, title: "Just a moment..." })), "the site blocks automated browsers");
    assert.equal(whyNotCaptured(v({ status: 200, title: "Attention Required! | Cloudflare" })), "the site blocks automated browsers");
    assert.equal(whyNotCaptured(v({ status: 404 })), "it answered 404");
  });
  test("an ordinary page, including one whose name merely contains 'auth'", () => {
    assert.equal(whyNotCaptured(v({})), null);
    assert.equal(whyNotCaptured(v({ finalUrl: "https://x.com/authors" })), null);
  });
});

describe("the whole step", () => {
  const png = Buffer.from("\x89PNG\r\n\x1a\nfake");
  const page = (over: Partial<PageVisit> = {}): PageVisit => ({
    finalUrl: "https://good.example/",
    status: 200,
    title: "Good",
    passwordField: false,
    desktop: png,
    phone: png,
    samples: [{ tag: "body", role: "surface", bg: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)", font: "Inter", size: 16, weight: 400, radius: 0, area: 100, text: 0 }],
    ...over,
  });
  const browser: ReferenceBrowser = {
    async visit(url) {
      if (url.includes("signin.example")) return page({ finalUrl: "https://signin.example/login" });
      if (url.includes("down.example")) throw new Error("net::ERR_NAME_NOT_RESOLVED\n    at goto");
      if (url.includes("wall.example")) return page({ status: 403, title: "Just a moment..." });
      return page({ phone: url.includes("nophone") ? null : png });
    },
    async close() {},
  };
  const isPublic = async (u: string) => (/127\.0\.0\.1|localhost|10\.0\./.test(u) ? null : new URL(u));

  test("each kind of reference is handled, and what could not be captured asks for a screenshot", async () => {
    const root = tmp({ "inspo/dashboard.png": "\x89PNG\r\n\x1a\nx", "inspo/notes.txt": "words" });
    const out = path.join(root, "design-system/references");
    const refs = await gatherReferences(
      ["https://good.example/pricing", "inspo/dashboard.png", "Linear", "signin.example", "http://127.0.0.1:3000", "https://down.example", "inspo/notes.txt", "https://wall.example", "https://later.example"],
      { repoRoot: root, outDir: out, browser, isPublic, max: 8 }
    );
    const by = (i: number) => refs[i];
    assert.deepEqual(by(0).images, ["design-system/references/ref-1-good-example-pricing-desktop.png", "design-system/references/ref-1-good-example-pricing-phone.png"]);
    assert.equal(by(0).status, "ok");
    assert.equal(by(0).cues?.background, "#ffffff");
    assert.deepEqual([by(1).status, by(1).images], ["ok", ["design-system/references/ref-2-dashboard.png"]]);
    assert.deepEqual([by(2).kind, by(2).status], ["named", "recalled"]);
    assert.match(by(2).note!, /never presented as measured/);
    assert.match(by(3).note!, /^it is behind a sign-in page: send a screenshot instead$/);
    assert.deepEqual([by(4).status, by(4).note], ["refused", "not a public web address (local, private, or not http/https): send a screenshot instead"]);
    assert.match(by(5).note!, /^it could not be opened \(net::ERR_NAME_NOT_RESOLVED\): send a screenshot instead$/);
    assert.deepEqual([by(6).status, by(6).note], ["refused", "not an image"]);
    assert.match(by(7).note!, /^the site blocks automated browsers/);
    assert.deepEqual([by(8).status, by(8).note], ["refused", "over the 8-reference limit"]);
    for (const r of refs) for (const img of r.images) assert.ok(fs.existsSync(path.join(root, img)), img);
    const saved = JSON.parse(fs.readFileSync(path.join(out, "references.json"), "utf8"));
    assert.equal(saved.references.length, 9);
  });

  test("with no browser, a URL is asked for as a screenshot; a private one is refused before anything opens", async () => {
    const root = tmp();
    let opened = 0;
    const refs = await gatherReferences(["https://good.example", "http://10.0.0.2/"], {
      repoRoot: root,
      outDir: path.join(root, "r"),
      browser: null,
      isPublic: async (u) => (opened++, /10\.0\./.test(u) ? null : new URL(u)),
    });
    assert.match(refs[0].note!, /no browser is available/);
    assert.equal(refs[1].status, "refused");
  });

  test("the lines shown to the person", () => {
    const lines = describeReferences([
      { input: "a", kind: "url", label: "linear.app", status: "ok", images: ["x"], cues: cuesFromSamples([]) },
      { input: "b", kind: "named", label: "Stripe", status: "recalled", images: [], note: "not looked at: only what a model already knows about it, never presented as measured" },
      { input: "c", kind: "url", label: "app.example", status: "needs-screenshot", images: [], note: "it is behind a sign-in page: send a screenshot instead" },
    ]);
    assert.match(lines[0], /^\[REFERENCE\] linear\.app: captured \(light theme;/);
    assert.equal(lines[1], "[REFERENCE] Stripe: not looked at: only what a model already knows about it, never presented as measured.");
    assert.equal(lines[2], "[REFERENCE] app.example: skipped, it is behind a sign-in page: send a screenshot instead.");
  });
});
