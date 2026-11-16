/**
 * The wordmark step: a model chooses a real font and how to set it, code sets it exactly,
 * a different model looks, the person picks, and the kit gets real files with their licences.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  catalogPrompt,
  defaultTypeOptions,
  designTypography,
  letterList,
  parseTypeJudgement,
  parseTypeOptions,
  proposeSystem,
  TYPE_NOTES,
  type ChatMsg,
  type TypographyContext,
} from "../src/typography.js";
import { loadCatalog } from "../src/wordmark.js";
import { runDesign, DESIGN_DIRECTOR, type DesignDeps } from "../src/designer.js";
import { lockupCardHtml } from "../src/svgRender.js";
import { ConfigSchema } from "../src/config.js";

const SYM = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#2563eb"/><path d="M30 55L45 70L72 36" fill="none" stroke="#ffffff" stroke-width="8"/></svg>';
const catalog = loadCatalog();
const text = (m: ChatMsg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

const option = (over: Record<string, unknown> = {}) => ({ fontId: "poppins", weight: "bold", case: "lower", tracking: 0.02, replaceLetter: null, why: "w", ...over });
const proposal = (options: any[], pairing: any = { display: "poppins", body: "barlow", why: "a clean pair" }) => JSON.stringify({ options, pairing });
const THREE = proposal([option({ replaceLetter: 1, why: "the o is the mark" }), option({ fontId: "dmserifdisplay", weight: "regular", case: "as-is", why: "editorial" }), option({ fontId: "spacemono", case: "lower", why: "technical" })]);

describe("what the model is told", () => {
  test("the catalogue is listed with voice, feel, weights and the body/caps/mono flags", () => {
    const p = catalogPrompt(catalog);
    assert.equal(p.split("\n").length, 14);
    assert.match(p, /- poppins: Poppins; geometric sans; .*; weights: regular, bold/);
    assert.match(p, /- varelaround: Varela Round; .*; weights: regular$/m);
    assert.match(p, /bebasneue: .*; capitals only/);
    assert.match(p, /barlow: .*; body/);
    assert.match(p, /spacemono: .*; monospace/);
  });

  test("the craft notes carry what the typography reference says, in our words", () => {
    for (const must of [/you never draw letters/, /lowercase reads approachable and contemporary, capitals stable and institutional/, /Long names shrink badly/, /nothing ownable is forgettable/, /replacing a ROUND letter/, /DIFFERENT font/, /at most two families/, /lacks a character/]) assert.match(TYPE_NOTES, must);
    assert.ok(TYPE_NOTES.length < 2400);
  });

  test("the proposal prompt is the designer brief, the notes, the fonts and the JSON shape", () => {
    const s = proposeSystem(DESIGN_DIRECTOR, catalog);
    assert.ok(s.startsWith(DESIGN_DIRECTOR));
    assert.ok(s.includes(TYPE_NOTES));
    assert.match(s, /"replaceLetter": letter number or null/);
    assert.match(s, /"body": id marked body/);
  });

  test("letters are named by number, spaces skipped, so a replacement is unambiguous", () => {
    assert.equal(letterList("Moon ly"), "0:M 1:o 2:o 3:n 4:l 5:y");
  });
});

describe("parseTypeOptions", () => {
  test("three different fonts, each set and checked, with a pairing", () => {
    const r = parseTypeOptions(THREE, "Moonly", catalog);
    assert.deepEqual(r.options.map((o) => o.spec.fontId), ["poppins", "dmserifdisplay", "spacemono"]);
    assert.ok(r.options[0].embedded, "letter 1 (the first o) was replaced");
    assert.equal(r.options[1].embedded, undefined);
    assert.equal(r.pairing!.display.id, "poppins");
    assert.equal(r.pairing!.body.id, "barlow");
    assert.deepEqual(r.notes, []);
  });

  test("a font used twice, one that does not exist, and a fourth are all dropped", () => {
    const r = parseTypeOptions(proposal([option(), option({ weight: "regular" }), option({ fontId: "comicsans" }), option({ fontId: "barlow" }), option({ fontId: "arvo" }), option({ fontId: "anton" })]), "Moonly", catalog);
    assert.deepEqual(r.options.map((o) => o.spec.fontId), ["poppins", "barlow", "arvo"]);
    assert.ok(r.notes.some((n) => /not available \("comicsans"\)/.test(n)));
  });

  test("a name the font cannot set drops that option, with the reason; bad values are repaired, not trusted", () => {
    const r = parseTypeOptions(proposal([option({ tracking: 99, case: "shouting", weight: "ultra" })]), "Moonly", catalog);
    assert.equal(r.options[0].spec.tracking, 0.3);
    assert.equal(r.options[0].spec.caseMode, "as-is");
    assert.equal(r.options[0].spec.weight, "regular");
    const none = parseTypeOptions(proposal([option()]), "Moon☃", catalog);
    assert.equal(none.options.length, 0);
    assert.ok(none.notes.some((n) => /Poppins was dropped: Poppins has no letter for "☃"/.test(n)));
  });

  test("a letter replacement that cannot work keeps the option and says so", () => {
    const r = parseTypeOptions(proposal([option({ replaceLetter: 4 })]), "Moonly", catalog); // l
    assert.equal(r.options.length, 1);
    assert.equal(r.options[0].embedded, undefined);
    assert.equal(r.options[0].spec.replaceLetter, null);
    assert.ok(r.notes.some((n) => /too narrow.*kept without replacing a letter/.test(n)));
    assert.equal(parseTypeOptions(proposal([option({ replaceLetter: -1 })]), "Moonly", catalog).options[0].spec.replaceLetter, null);
    assert.equal(parseTypeOptions(proposal([option({ replaceLetter: "1" })]), "Moonly", catalog).options[0].spec.replaceLetter, null, "a string is not a letter number");
  });

  test("the body face must be a body face; otherwise one is chosen", () => {
    const r = parseTypeOptions(proposal([option()], { display: "poppins", body: "alfaslabone", why: "x" }), "Moonly", catalog);
    assert.ok(r.pairing!.body.body, "a loud slab is not a body face");
    const missing = parseTypeOptions(proposal([option({ fontId: "barlow" })], null), "Moonly", catalog);
    assert.equal(missing.pairing!.display.id, "barlow");
    assert.notEqual(missing.pairing!.body.id, "barlow", "two different families");
  });

  test("nonsense is nothing", () => {
    assert.equal(parseTypeOptions("I like Helvetica", "Moonly", catalog).options.length, 0);
    assert.equal(parseTypeOptions("{}", "Moonly", catalog).pairing, undefined);
  });

  test("the safe defaults are three real, different, readable faces", () => {
    const d = defaultTypeOptions("Moonly", catalog);
    assert.equal(d.length, 3);
    assert.equal(new Set(d.map((o) => o.spec.fontId)).size, 3);
    assert.equal(defaultTypeOptions("Moon☃", catalog).length, 0, "and none if no font can set the name");
  });
});

describe("parseTypeJudgement", () => {
  test("scores are clamped, unknown ids ignored, the pick must be one of the options", () => {
    const j = parseTypeJudgement(JSON.stringify({ scores: [{ id: "a", score: 12, defects: ["x", "y", "z", "w"] }, { id: "Z", score: 5 }, { id: "B", score: "n/a" }], pick: "c" }), ["A", "B", "C"]);
    assert.deepEqual([...j.scores], [["A", { score: 10, defects: ["x", "y", "z"] }]]);
    assert.equal(j.pick, "C");
    assert.equal(parseTypeJudgement(JSON.stringify({ pick: "Q" }), ["A"]).pick, null);
    assert.equal(parseTypeJudgement("no", ["A"]).scores.size, 0);
  });
});

// ---------------------------------------------------------------------------

interface Call {
  label: string;
  models: string[];
  messages: ChatMsg[];
}
const png = (calls?: any[]) => async (_svg: string, opts: any) => (calls?.push(opts), Buffer.from("PNG"));

function ctxFor(over: Partial<TypographyContext> & { script?: (label: string) => string | Error } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ty-"));
  const calls: Call[] = [];
  const pngCalls: any[] = [];
  const script = over.script ?? ((l: string) => (l === "typography" ? THREE : JSON.stringify({ scores: [{ id: "A", score: 8, defects: [] }, { id: "B", score: 6, defects: ["tight"] }, { id: "C", score: 5, defects: [] }], pick: "A" })));
  const ctx: TypographyContext = {
    call: async (models, messages, label) => {
      calls.push({ label, models, messages });
      const r = script(label);
      if (r instanceof Error) throw r;
      return r;
    },
    director: DESIGN_DIRECTOR,
    models: ["a/x", "b/y"],
    visionModels: ["b/y"],
    renderer: { png: png(pngCalls), page: async () => Buffer.from("PAGE"), close: async () => {} },
    briefText: "Name: Moonly",
    name: "Moonly",
    conceptNote: "Check disc (symbol): a check in a disc",
    symbolLight: SYM,
    symbolDark: SYM,
    dir,
    log: () => {},
    ...over,
  };
  return { ctx, calls, dir, pngCalls };
}

describe("designTypography", () => {
  test("the happy path: options, a look, the recommended one, real files with licences", async () => {
    const { ctx, calls, dir } = ctxFor();
    const kit = (await designTypography(ctx))!;
    assert.deepEqual(calls.map((c) => c.label), ["typography", "typography look"]);
    const names = kit.files.map((f) => f.name);
    for (const n of ["wordmark.svg", "wordmark-on-dark.svg", "lockup-horizontal.svg", "lockup-horizontal-on-dark.svg", "lockup-stacked.svg", "lockup-stacked-on-dark.svg", "wordmark-with-mark.svg", "wordmark-with-mark-on-dark.svg", "lockup-horizontal.png", "lockup-stacked-on-dark.png", "fonts/OFL-poppins.txt", "fonts/OFL-barlow.txt"]) assert.ok(names.includes(n), n);
    assert.match(kit.summary, /Wordmark: Poppins Bold, lowercase, tracking \+0\.02 em, the mark replaces a letter\./);
    assert.deepEqual((kit.info as any).wordmark.replacedLetter, 1);
    assert.equal((kit.info as any).licence, "SIL Open Font License 1.1");
    assert.ok(fs.existsSync(path.join(dir, "typography", "option-a.png")) && fs.existsSync(path.join(dir, "typography", "option-c.svg")));
    assert.match(kit.readme, /## Typography/);
    assert.match(kit.readme, /\[Poppins\]\(https:\/\/fonts\.google\.com\/specimen\/Poppins\)/);
    assert.match(kit.readme, /SIL Open Font License 1\.1/);
    assert.match(kit.readme, /Check pairs such as AV and To by eye/);
  });

  test("every file in the kit is clean: shapes only, passing the sanitizer", async () => {
    const { ctx } = ctxFor();
    const kit = (await designTypography(ctx))!;
    const { sanitizeSvg } = await import("../src/svgSafety.js");
    for (const f of kit.files.filter((f) => f.name.endsWith(".svg"))) {
      const s = sanitizeSvg(String(f.data));
      assert.deepEqual(s.problems, [], f.name);
      assert.ok(!/<text|font-family/i.test(String(f.data)), f.name);
    }
  });

  test("the proposer and the looker are different models, and the looker sees every option as an image", async () => {
    const { ctx, calls } = ctxFor();
    await designTypography(ctx);
    const look = calls.find((c) => c.label === "typography look")!;
    assert.notEqual(look.models[0], calls[0].models[0]);
    assert.equal((look.messages[1].content as any[]).filter((p) => p.type === "image_url").length, 3);
    assert.match(text(look.messages[0]), /spacing and kerning look even/);
    assert.match(text(calls[0].messages[1]), /Letters by number: 0:M 1:o 2:o 3:n 4:l 5:y/);
  });

  test("the pictures are shown BEFORE the question; the question carries each option; the pick is used", async () => {
    const order: string[] = [];
    let prompt = "";
    let choices: string[] = [];
    const { ctx } = ctxFor({
      show: (label) => order.push("show:" + label.slice(0, 10)),
      ask: async (p, c) => {
        order.push("ask");
        prompt = p;
        choices = c;
        return "B — whatever";
      },
    });
    const kit = (await designTypography(ctx))!;
    assert.deepEqual(order, ["show:Wordmark A", "show:Wordmark B", "show:Wordmark C", "ask"]);
    assert.match(choices[0], /A — Poppins Bold.*\(recommended\)/);
    assert.match(prompt, /B — DM Serif Display, tracking \+0\.02 em: editorial/);
    assert.match(prompt, /pictures are above/);
    assert.equal((kit.info as any).wordmark.family, "DM Serif Display");
    assert.equal((kit.info as any).wordmark.replacedLetter, null);
    assert.ok(!kit.files.some((f) => f.name.startsWith("wordmark-with-mark")), "no letter was replaced in B, so no such file");
  });

  test("an answer that matches nothing takes the recommended one; the judge's pick is the recommendation", async () => {
    let choices: string[] = [];
    const { ctx } = ctxFor({
      script: (l) => (l === "typography" ? THREE : JSON.stringify({ scores: [{ id: "A", score: 5 }, { id: "B", score: 6 }, { id: "C", score: 9 }], pick: "C" })),
      ask: async (_p, c) => ((choices = c), "hmm not sure"),
    });
    const kit = (await designTypography(ctx))!;
    assert.match(choices[2], /C — Space Mono Bold.*\(recommended\)/);
    assert.equal((kit.info as any).wordmark.family, "Space Mono");
  });

  test("with no one to ask, the recommended option is taken", async () => {
    const { ctx } = ctxFor();
    assert.equal(((await designTypography(ctx))!.info as any).wordmark.family, "Poppins");
  });

  test("without a browser: no pictures, no look, no PNGs, and the SVGs are on disk for the question", async () => {
    const shown: string[] = [];
    let prompt = "";
    const { ctx, calls, dir } = ctxFor({ renderer: null, show: (l) => shown.push(l), ask: async (p, c) => ((prompt = p), c[0]) });
    const kit = (await designTypography(ctx))!;
    assert.deepEqual(calls.map((c) => c.label), ["typography"]);
    assert.deepEqual(shown, []);
    assert.ok(!kit.files.some((f) => f.name.endsWith(".png")));
    assert.match(prompt, /No pictures could be made; the SVG files are in/);
    assert.ok(fs.existsSync(path.join(dir, "typography", "option-b.svg")));
    assert.ok(!/and PNGs/.test(kit.readme));
  });

  test("wide lockups are rendered at their own shape, 1200 across, never boxed square", async () => {
    const { ctx, pngCalls } = ctxFor();
    await designTypography(ctx);
    assert.ok(pngCalls.length >= 4);
    for (const o of pngCalls) {
      assert.equal(o.size, 1200);
      assert.ok(o.height > 100 && o.height < 1200, `height ${o.height}`);
    }
    assert.ok(pngCalls.some((o) => o.height < 600), "the horizontal one is wide");
  });

  test("a failed proposal falls back to safe defaults and says so; a failed look does not stop it", async () => {
    const { ctx } = ctxFor({ script: (l) => (l === "typography" ? new Error("provider down") : new Error("vision down")) });
    const kit = (await designTypography(ctx))!;
    assert.ok(kit.notes.some((n) => /type proposal failed \(provider down\)/.test(n)));
    assert.ok(kit.notes.some((n) => /safe defaults/.test(n)));
    assert.ok(kit.notes.some((n) => /could not be looked at/.test(n)));
    assert.ok(kit.files.some((f) => f.name === "lockup-horizontal.svg"));
  });

  test("a reply that is not usable falls back to the defaults", async () => {
    const { ctx } = ctxFor({ script: (l) => (l === "typography" ? "I would use Papyrus" : "{}") });
    const kit = (await designTypography(ctx))!;
    assert.ok(kit.notes.some((n) => /safe defaults/.test(n)));
  });

  test("a name no bundled font can set means no wordmark, said plainly, nothing thrown", async () => {
    const logs: string[] = [];
    const { ctx } = ctxFor({ name: "☃☃☃", log: (l) => logs.push(l) });
    assert.equal(await designTypography(ctx), null);
    assert.ok(logs.some((l) => /could not be set in any bundled font/.test(l)));
  });

  test("the option card shows the lockup on both pages, small and large, and the letter-replaced version when there is one", () => {
    const html = lockupCardHtml({ label: "A — Poppins", light: SYM, dark: SYM, lightAlt: SYM, darkAlt: SYM });
    assert.equal((html.match(/<img /g) ?? []).length, 6);
    assert.match(html, /height:64px/);
    assert.match(html, /height:24px/);
    assert.equal((lockupCardHtml({ label: "x", light: SYM, dark: SYM }).match(/<img /g) ?? []).length, 4);
  });
});

// ---------------------------------------------------------------------------

describe("in a whole design run", () => {
  const dirOf = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tyd-"));
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "moonly" }));
    return d;
  };
  const run = async (o: { lockup?: boolean; typography?: boolean; renderer?: any } = {}) => {
    const calls: string[] = [];
    const call: DesignDeps["call"] = async (_m, _x, label) => {
      calls.push(label);
      if (label === "brief") return JSON.stringify({ name: "Moonly", offering: "budgeting", audience: "a", personality: [], avoid: [], constraints: [], assumptions: [], lockup: o.lockup });
      if (label.startsWith("concepts")) return JSON.stringify({ concepts: [1, 2].map((k) => ({ title: `T${label}${k}`, markType: "symbol", idea: "i", construction: "c" })) });
      if (label.startsWith("draw") || label.startsWith("fix")) return SYM;
      if (label.startsWith("look")) return JSON.stringify({ score: 7, defects: [] });
      if (label === "typography") return THREE;
      if (label === "typography look") return JSON.stringify({ scores: [{ id: "A", score: 8 }], pick: "A" });
      return "{}";
    };
    const r = await runDesign(
      { repoRoot: dirOf(), models: ["a/x", "b/y"], visionModels: ["b/y"], call, renderer: o.renderer === undefined ? { png: png(), page: async () => Buffer.from("P"), close: async () => {} } : o.renderer, log: () => {}, limits: { rounds: 0, ...(o.typography === undefined ? {} : { typography: o.typography }) } },
      "logo"
    );
    const read = (f: string) => fs.readFileSync(path.join(r.dir!, f), "utf-8");
    return { r, calls, read, has: (f: string) => fs.existsSync(path.join(r.dir!, f)) };
  };

  test("by default the kit has the wordmark, the lockups, the fonts' licences, and says so", async () => {
    const x = await run();
    for (const f of ["wordmark.svg", "lockup-horizontal.svg", "lockup-stacked-on-dark.svg", "wordmark-with-mark.svg", "fonts/OFL-poppins.txt", "typography/option-a.png"]) assert.ok(x.has(f), f);
    assert.match(x.r.text, /Wordmark: Poppins Bold, lowercase/);
    assert.match(x.read("README.md"), /## Typography/);
    const json = JSON.parse(x.read("brand.json"));
    assert.equal(json.typography.wordmark.family, "Poppins");
    assert.equal(json.typography.pairing.body, "Barlow");
    assert.ok(x.calls.includes("typography"));
  });

  test("the lockup uses the designer's own dark colourway, not a recolour", async () => {
    const x = await run();
    assert.match(x.read("lockup-horizontal-on-dark.svg"), /fill="#fafafa"/);
  });

  test("turned off in config, there is no wordmark and no call for one", async () => {
    const x = await run({ typography: false });
    assert.ok(!x.has("wordmark.svg") && !x.has("lockup-horizontal.svg"));
    assert.ok(!x.calls.includes("typography"));
    assert.ok(!/Typography/.test(x.read("README.md")));
    assert.equal(JSON.parse(x.read("brand.json")).typography, null);
  });

  test("a request for a symbol with no name gets no wordmark", async () => {
    const x = await run({ lockup: false });
    assert.ok(!x.has("wordmark.svg"));
    assert.ok(!x.calls.includes("typography"));
  });

  test("without a browser the wordmark still comes out, as SVG only", async () => {
    const x = await run({ renderer: null });
    assert.ok(x.has("lockup-horizontal.svg") && !x.has("lockup-horizontal.png"));
  });

  test("the config switch exists, defaults on, and is not forced", () => {
    assert.equal(ConfigSchema.parse({}).designer.typography, true);
    assert.equal(ConfigSchema.parse({ designer: { typography: false } }).designer.typography, false);
  });
});
