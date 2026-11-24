/**
 * The UI critique: the explicit command and its arguments, the project's own theme and design documents found on any stack, the
 * judge's reply bounded and ranked by code, the report, and the whole step with capture, references and the model injected.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseCritiqueArgs,
  isUiCritiqueRequest,
  discoverTheme,
  discoverConstraints,
  isConstraintDoc,
  parseUiCritique,
  renderUiCritique,
  runUiCritique,
  UI_DIMENSIONS,
} from "../src/uiCritique.js";
import type { CaptureReport } from "../src/uiCapture.js";
import type { ChatMsg } from "../src/referenceRead.js";

const roots: string[] = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
function repo(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-critique-"));
  roots.push(root);
  for (const [rel, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), c);
  }
  return root;
}

describe("the command", () => {
  test("only an explicit critique of the UI, app or screens; a logo request or a logo critique is not this", () => {
    for (const s of ["critique ui", "critique UI https://linear.app", "review my app", "audit the screens", "critique interface"]) assert.ok(isUiCritiqueRequest(s), s);
    for (const s of ["a logo for my app", "critique my logo", "critique the logo", "refresh the app icon", "uiux things"]) assert.equal(isUiCritiqueRequest(s), null, s);
    assert.equal(isUiCritiqueRequest("critique ui linear.app --screens a.png")?.rest, "linear.app --screens a.png");
  });

  test("references first, the person's own screenshots after --screens; quoted names stay whole", () => {
    assert.deepEqual(parseCritiqueArgs(`https://linear.app "Stripe dashboard" inspo/a.png --screens shots/home.png "shots/my settings.png"`), {
      references: ["https://linear.app", "Stripe dashboard", "inspo/a.png"],
      screens: ["shots/home.png", "shots/my settings.png"],
    });
    assert.deepEqual(parseCritiqueArgs(""), { references: [], screens: [] });
    assert.deepEqual(parseCritiqueArgs("--screens a.png --like b.png"), { references: ["b.png"], screens: ["a.png"] });
  });
});

describe("what the project says about itself, on any stack", () => {
  test("token files, Tailwind config and theme modules; MASTER.md first", () => {
    const r = repo({
      "design-system/MASTER.md": "# Master",
      "tailwind.config.ts": "export default {}",
      "src/theme/tokens.ts": "export const tokens = {}",
      "src/components/Button.tsx": "x",
      "node_modules/x/theme.js": "no",
    });
    assert.deepEqual(discoverTheme(r).map((f) => f.rel), ["design-system/MASTER.md", "src/theme/tokens.ts", "tailwind.config.ts"]);
  });

  test("a plain site with CSS variables on :root has a theme too", () => {
    const r = repo({ "assets/site.css": ":root { --accent: #2d55d6; }\nbody{}", "assets/other.css": "body{color:red}" });
    assert.deepEqual(discoverTheme(r).map((f) => f.rel), ["assets/site.css"]);
  });

  test("design, brand, parity and visual documents are found; the critique's own output is not", () => {
    const r = repo({
      "reference/specs/VISUAL_PARITY_SPEC.md": "# Visual parity: Expo cards must match Android",
      "docs/brand-guidelines.md": "# Brand",
      "docs/api.md": "# API",
      "design-system/CRITIQUE.md": "# old critique",
      "README.md": "# readme",
      "reference/HISTORY_GUIDE.md": "# not about design",
    });
    const found = discoverConstraints(r).map((f) => f.rel);
    assert.deepEqual(found, ["docs/brand-guidelines.md", "reference/specs/VISUAL_PARITY_SPEC.md"]);
  });

  test("a document is a design rule by a whole word in its name, never by letters inside another word", () => {
    for (const n of ["VISUAL_PARITY_SPEC.md", "brand-guidelines.md", "StyleGuide.md", "ui-kit.md", "UX.md", "design.md", "theme-notes.md", "GUIDELINES.md"])
      assert.equal(isConstraintDoc(n), true, n);
    for (const n of ["HISTORY_GUIDE.md", "build.md", "quickstart.md", "requirements.md", "design.txt", "PARITY_TRACKER.txt"])
      assert.equal(isConstraintDoc(n), false, n);
  });
});

const REPLY = {
  firstImpression: "Competent but generic.",
  works: ["Clear primary action"],
  scores: Object.fromEntries(UI_DIMENSIONS.map((d, i) => [d, i === 0 ? 9 : 3])),
  slop: [{ sign: "three identical rounded cards", where: "Dashboard" }],
  screens: [{ screen: "dashboard", findings: ["The phase cards all weigh the same", ""] }, { screen: "Login", findings: [] }],
  tokens: [{ token: "radius.card", now: "16", proposed: "12", why: "matches the button radius" }, { token: "", proposed: "x" }],
  changes: [
    { change: "Tighten the card padding", why: "density", screens: ["Dashboard"], impact: "low", conflicts: null },
    { change: "Make History dark like the dashboard.", why: "one theme", screens: ["History"], impact: "high", conflicts: "VISUAL_PARITY_SPEC.md" },
    { change: "Give empty states a designed look", why: "states", screens: [], impact: "sometimes", conflicts: "none" },
  ],
  referenceGaps: ["Uses more colour than the references"],
};

describe("the judge's reply", () => {
  const docs = ["reference/specs/VISUAL_PARITY_SPEC.md"];
  test("scores are clamped, the total is worked out here, and too few scores is not a critique", () => {
    const c = parseUiCritique(JSON.stringify(REPLY), ["Dashboard", "History", "Login"], docs)!;
    assert.equal(c.scores.hierarchy, 5);
    assert.equal(c.total, 5 + 3 * 9);
    assert.equal(c.outOf, 50);
    assert.equal(parseUiCritique(JSON.stringify({ ...REPLY, scores: { hierarchy: 3, spacing: 3 } }), [], docs), null);
    assert.equal(parseUiCritique("no json here", [], docs), null);
  });

  test("changes are ranked by impact, a conflict names the project document, and screen names match the captured ones", () => {
    const c = parseUiCritique(JSON.stringify(REPLY), ["Dashboard", "History", "Login"], docs)!;
    assert.deepEqual(c.changes.map((x) => [x.change, x.impact]), [
      ["Make History dark like the dashboard.", "high"],
      ["Give empty states a designed look", "medium"],
      ["Tighten the card padding", "low"],
    ]);
    assert.equal(c.changes[0].conflicts, "reference/specs/VISUAL_PARITY_SPEC.md");
    assert.equal(c.changes[1].conflicts, null, "'none' is no conflict");
    assert.deepEqual(c.screens, [{ screen: "Dashboard", findings: ["The phase cards all weigh the same"] }], "empty findings and screens are dropped");
    assert.deepEqual(c.tokens.map((t) => t.token), ["radius.card"]);
  });

  test("the report: scorecard, slop, ranked changes with the conflict warning, tokens, per screen, and what was not looked at", () => {
    const c = parseUiCritique(JSON.stringify(REPLY), ["Dashboard", "History"], docs)!;
    const md = renderUiCritique(c, {
      screens: [{ name: "Dashboard", route: "/dashboard", viewport: "phone", file: "design-system/critique/before/dashboard-phone.png", from: "x" }],
      reads: [],
      constraints: docs,
      theme: ["src/theme/tokens.ts"],
      capture: { router: "Expo Router", screens: [], skipped: [{ route: "/", name: "Splash", reason: "redirected to /login" }], nameOnly: [] },
    });
    assert.match(md, /^# UI critique\n\n\*\*First impression\.\*\* Competent but generic\./);
    assert.match(md, /\[Dashboard \(phone\)\]\(critique\/before\/dashboard-phone\.png\)/);
    assert.match(md, /Not looked at: Splash \(redirected to \/login\)\./);
    assert.match(md, /Held to the project's own documents: `reference\/specs\/VISUAL_PARITY_SPEC\.md`/);
    assert.match(md, /## Scorecard \(32 of 50\)/);
    assert.match(md, /- \*\*three identical rounded cards\*\*: Dashboard/);
    assert.match(md, /1\. \*\*Make History dark like the dashboard\.\*\* \(high; History\)  \n {3}one theme  \n {3}⚠️ Conflicts with `reference\/specs\/VISUAL_PARITY_SPEC\.md`: do it only if that document changes too\./);
    assert.match(md, /\| `radius\.card` \| 16 \| 12 \| matches the button radius \|/);
    assert.match(md, /Nothing in the app was changed\.\n$/);
  });
});

describe("the whole step", () => {
  const png = Buffer.from("\x89PNG\r\n\x1a\nimg");
  const captured = (root: string): CaptureReport => ({
    router: "Expo Router",
    screens: [
      { name: "Dashboard", route: "/dashboard", viewport: "phone", file: "design-system/critique/before/dashboard-phone.png", from: "QA setup" },
      { name: "History", route: "/history", viewport: "phone", file: "design-system/critique/before/history-phone.png", from: "nav map" },
    ],
    skipped: [],
    nameOnly: [],
    setupNotes: "Fixture buttons are QA-only.",
  });

  test("captures, reads the references, sends the judge every image and everything it is held to, and writes the report", async () => {
    const root = repo({
      "design-system/critique/before/dashboard-phone.png": png,
      "design-system/critique/before/history-phone.png": png,
      "design-system/critique/references/ref-1.png": png,
      "reference/specs/VISUAL_PARITY_SPEC.md": "# Visual parity: Expo cards must match Android",
      "src/theme/tokens.ts": "export const radius = { card: 16 }",
    });
    const calls: { label: string; messages: ChatMsg[]; models: string[] }[] = [];
    const lines: string[] = [];
    const result = await runUiCritique(
      { references: ["inspo.png"], screens: [] },
      {
        repoRoot: root,
        visionModels: ["vision/judge"],
        log: (l) => lines.push(l),
        capture: async () => captured(root),
        references: async () => [{ input: "inspo.png", kind: "image", label: "inspo.png", status: "ok", images: ["design-system/critique/references/ref-1.png"] }],
        call: async (models, messages, label) => {
          calls.push({ label, messages, models });
          if (label.startsWith("reference read")) return JSON.stringify({ essence: "Calm.", borrow: ["One accent"], density: "airy" });
          return JSON.stringify(REPLY);
        },
      }
    );
    assert.equal(result.ok, true, result.text);
    assert.deepEqual(calls.map((c) => c.label), ["reference read: inspo.png", "UI critique"]);
    const judge = calls[1].messages[1].content as any[];
    assert.equal(judge.filter((p) => p.type === "image_url").length, 2);
    const intro = judge[0].text as string;
    assert.match(intro, /^Screens, in the order of the images: 1\. Dashboard \(phone\); 2\. History \(phone\)\./);
    assert.match(intro, /Fixture buttons are QA-only/);
    assert.match(intro, /## inspo\.png \(seen in its screenshots\)\nCalm\./);
    assert.match(intro, /--- reference\/specs\/VISUAL_PARITY_SPEC\.md\n# Visual parity/);
    assert.match(intro, /--- src\/theme\/tokens\.ts\nexport const radius/);
    assert.match(String(calls[1].messages[0].content), /binding\. A change that would break one stays in the list but names that document/);
    const md = fs.readFileSync(path.join(root, "design-system/CRITIQUE.md"), "utf8");
    assert.match(md, /Compared with: inspo\.png\./);
    assert.ok(fs.existsSync(path.join(root, "design-system/critique/critique.json")));
    assert.ok(fs.existsSync(path.join(root, "design-system/critique/references/READ.md")));
    assert.match(result.text, /^Critique written to design-system\/CRITIQUE\.md: 32 of 50, 1 slop sign\(s\), 3 change\(s\); the first: Make History dark like the dashboard\. Nothing in the app was changed\.$/);
  });

  test("no screens: nothing is critiqued and the person is told how to send screenshots; no model is called", async () => {
    const root = repo({});
    let called = 0;
    const result = await runUiCritique(
      { references: [], screens: [] },
      { repoRoot: root, visionModels: ["m"], log: () => {}, capture: async () => ({ router: null, screens: [], skipped: [], nameOnly: [], unavailable: "no web build" }), call: async () => (called++, "") }
    );
    assert.equal(result.ok, false);
    assert.match(result.text, /\/design critique ui --screens <image paths>/);
    assert.equal(called, 0);
  });

  test("an unusable reply writes no report", async () => {
    const root = repo({ "design-system/critique/before/dashboard-phone.png": png, "design-system/critique/before/history-phone.png": png });
    const result = await runUiCritique({ references: [], screens: [] }, { repoRoot: root, visionModels: ["m"], log: () => {}, capture: async () => captured(root), call: async () => "I can't see images." });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(path.join(root, "design-system/CRITIQUE.md")), false);
  });
});

test("the command is wired only to `/design critique ui …`, loading the module there and nowhere else", () => {
  const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");
  assert.equal(idx.split('await import("./uiCritique.js")').length - 1, 1, "one dynamic import, inside the command");
  assert.match(idx, /else if \(uiCritique\) await runUiCritiqueCommand\(what\);\n\s+else await runDesignJob\(what\);/);
  assert.doesNotMatch(idx, /from "\.\/uiCritique\.js"/, "never a static import a routine run would load");
});
