/**
 * The craft checks a good identity designer runs, taken from the logo-design
 * skill's process: letter test, junctions, accidental readings (rotated and
 * mirrored), literalness, familiarity, geometry discipline, and usage guidance.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDesign, type ChatMsg, type DesignDeps } from "../src/designer.js";
import { sheetHtml } from "../src/svgRender.js";

const svg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#2563eb"/></svg>';
const text = (m: ChatMsg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

describe("the sheet a judge and a person look at", () => {
  test("it shows the mark rotated 180 degrees and mirrored, where an accidental reading shows up", () => {
    const html = sheetHtml([{ label: "A", svg, small: [] }], 1);
    assert.match(html, /transform:rotate\(180deg\)/);
    assert.match(html, /transform:scaleX\(-1\)/);
    assert.match(html, /<span>rotated<\/span>/);
    assert.match(html, /<span>mirrored<\/span>/);
    assert.match(html, /light surface/);
    assert.match(html, /dark surface/);
  });
});

describe("what each model is told", () => {
  const run = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const calls: { label: string; messages: ChatMsg[] }[] = [];
    const call: DesignDeps["call"] = async (_m, messages, label) => {
      calls.push({ label, messages });
      if (label === "brief") return JSON.stringify({ name: "X", offering: "o", audience: "a", personality: [], avoid: [], constraints: [], assumptions: [] });
      if (label.startsWith("concepts")) return JSON.stringify({ concepts: [1, 2].map((k) => ({ title: `T${label}${k}`, markType: "symbol", idea: "i", construction: "c" })) });
      if (label.startsWith("draw")) return svg;
      if (label.startsWith("look")) return JSON.stringify({ score: 7, defects: [] });
      return svg;
    };
    const r = await runDesign(
      { repoRoot: dir, models: ["a/x", "b/y"], visionModels: ["b/y"], call, renderer: { png: async () => Buffer.from("P"), page: async () => Buffer.from("G"), close: async () => {} }, log: () => {} },
      "logo"
    );
    return { calls, r };
  };

  test("the judge runs the craft pass: letters, junctions, accidental readings, literalness, familiarity", async () => {
    const { calls } = await run();
    const judge = text(calls.find((c) => c.label.startsWith("look"))!.messages[0]);
    for (const must of [/letter test/, /junctions/, /rotated and mirrored copies, name any unintended shape/, /literalness/, /clip-art, so score it 5 or less/, /familiarity/, /strongly resembles a well-known mark/]) assert.match(judge, must);
    assert.match(judge, /copies rotated 180 degrees and mirrored/);
  });

  test("the drawer gets geometry discipline: exact angles, true arcs, overshoot, optical centre", async () => {
    const { calls } = await run();
    const draw = text(calls.find((c) => /^draw \d+$/.test(c.label))!.messages[0]);
    for (const must of [/exact angles \(0, 15, 30, 45, 60, 90 degrees\)/, /true arcs/, /overshoots its edge by 1-3 units/, /optical centre sits slightly above the geometric centre/]) assert.match(draw, must);
  });

  test("the proposers are told not to draw the product", async () => {
    const { calls } = await run();
    const p = text(calls.find((c) => c.label.startsWith("concepts"))!.messages[0]);
    assert.match(p, /one-sentence test/);
    assert.match(p, /evoke the attitude, do not illustrate the thing/);
  });

  test("the kit's README says how to use the logo, including which file for which theme", async () => {
    const { r } = await run();
    const readme = fs.readFileSync(path.join(r.dir!, "README.md"), "utf-8");
    for (const must of [/## Using it/, /half the mark's height/, /Smallest size: 16 px/, /Do not stretch/, /logo-on-dark\.svg/, /logo-on-light\.svg/]) assert.match(readme, must);
  });
});

describe("the renderer does not depend on the namespace being present", () => {
  test("every image in a sheet carries one, so a mark without it still draws", () => {
    const html = sheetHtml([{ label: "A", svg: '<svg viewBox="0 0 100 100"><circle cx="5" cy="5" r="4"/></svg>', small: [] }], 1);
    const uris = [...html.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g)].map((m) => Buffer.from(m[1], "base64").toString());
    assert.ok(uris.length >= 5);
    for (const u of uris) assert.match(u, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  test("one that already has it is not given a second", () => {
    const html = sheetHtml([{ label: "A", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>', small: [] }], 1);
    const u = Buffer.from(/base64,([A-Za-z0-9+/=]+)/.exec(html)![1], "base64").toString();
    assert.equal((u.match(/xmlns=/g) ?? []).length, 1);
  });
});
