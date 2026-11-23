/**
 * The reference read: each usable reference becomes structured design notes from a vision model, with measured cues as facts the
 * model is told not to contradict, named products marked recalled, and anything unusable left out with a reason.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRead, clip, imageData, readReferences, renderReads, writeReads, type ChatMsg } from "../src/referenceRead.js";
import { cuesFromSamples, type Reference } from "../src/uiReference.js";

const roots: string[] = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
const tmp = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-read-"));
  roots.push(r);
  return r;
};

const GOOD = {
  essence: "Calm, quiet confidence: one strong headline on a pale page.",
  hierarchy: "A 54px headline, then a grey lead line, then one dark pill button.",
  density: "airy",
  surfaces: "Flat pale page; one dark rounded panel carries the demo.",
  type: "One system sans; bold headline, regular body.",
  colour: "Nearly no colour: a single blue used only for a small eyebrow label.",
  layout: "A single centred 720px column.",
  borrow: ["One accent colour, used sparingly", "Generous space above the headline", "x".repeat(400)],
  doNotCopy: ["The YIMPIM mark and name", "The terminal demo panel as the hero"],
};

describe("parsing a read", () => {
  test("bounds every field and keeps the lists short", () => {
    const r = parseRead("```json\n" + JSON.stringify(GOOD) + "\n```")!;
    assert.equal(r.density, "airy");
    assert.equal(r.borrow.length, 3);
    assert.ok(r.borrow[2].length <= 321 && r.borrow[2].endsWith("…"), "an over-long item is trimmed, and says so");
    assert.deepEqual(r.doNotCopy, GOOD.doNotCopy);
  });
  test("a long field is trimmed at its last full sentence inside the limit, never mid-word", () => {
    const long = "First the headline. Then the lede in grey. " + "Then a long run of detail ".repeat(30);
    assert.equal(clip(long, 60), "First the headline. Then the lede in grey.");
    assert.equal(clip("alpha beta gamma delta", 14), "alpha beta…");
    assert.equal(clip("short", 60), "short");
  });
  test("an unknown density reads as balanced, and 'color' is accepted for colour", () => {
    const r = parseRead(JSON.stringify({ ...GOOD, density: "roomy", colour: undefined, color: "Muted greys." }))!;
    assert.equal(r.density, "balanced");
    assert.equal(r.colour, "Muted greys.");
  });
  test("no essence, or nothing to borrow, is not a read", () => {
    assert.equal(parseRead(JSON.stringify({ ...GOOD, essence: "" })), null);
    assert.equal(parseRead(JSON.stringify({ ...GOOD, borrow: [] })), null);
    assert.equal(parseRead("I cannot see the image."), null);
  });
});

describe("images for the model", () => {
  test("a saved image becomes a data URI; missing, unknown or oversized ones do not", () => {
    const r = tmp();
    fs.writeFileSync(path.join(r, "a.png"), "png");
    fs.writeFileSync(path.join(r, "b.txt"), "x");
    fs.writeFileSync(path.join(r, "big.png"), Buffer.alloc(4_000_001));
    assert.equal(imageData(r, "a.png"), `data:image/png;base64,${Buffer.from("png").toString("base64")}`);
    assert.equal(imageData(r, "b.txt"), null);
    assert.equal(imageData(r, "missing.png"), null);
    assert.equal(imageData(r, "big.png"), null);
  });
});

describe("reading the references", () => {
  const cues = cuesFromSamples([
    { tag: "body", role: "surface", bg: "rgb(251, 251, 253)", color: "rgb(0,0,0)", font: "system-ui", size: 16, weight: 400, radius: 0, area: 1000, h: 900, text: 0 },
  ]);
  const setup = () => {
    const r = tmp();
    fs.mkdirSync(path.join(r, "refs"));
    for (const f of ["site-desktop.png", "site-phone.png", "shot.png"]) fs.writeFileSync(path.join(r, "refs", f), "img");
    const refs: Reference[] = [
      { input: "https://site.example", kind: "url", label: "site.example", status: "ok", images: ["refs/site-desktop.png", "refs/site-phone.png"], cues },
      { input: "Linear", kind: "named", label: "Linear", status: "recalled", images: [] },
      { input: "https://app.example", kind: "url", label: "app.example", status: "needs-screenshot", images: [], note: "sign-in" },
      { input: "x.txt", kind: "image", label: "x.txt", status: "refused", images: [] },
      { input: "gone.png", kind: "image", label: "gone.png", status: "ok", images: ["refs/gone.png"] },
      { input: "shot.png", kind: "image", label: "shot.png", status: "ok", images: ["refs/shot.png"] },
      { input: "Unknownco", kind: "named", label: "Unknownco", status: "recalled", images: [] },
    ];
    return { r, refs };
  };

  test("a captured page is looked at with its measured facts; a named product is recalled; the rest are left out, with why", async () => {
    const { r, refs } = setup();
    const sent: { label: string; messages: ChatMsg[]; models: string[] }[] = [];
    const lines: string[] = [];
    const reads = await readReferences(refs, {
      repoRoot: r,
      models: ["vision/judge"],
      log: (l) => lines.push(l),
      call: async (models, messages, label) => {
        sent.push({ label, messages, models });
        if (label.includes("shot.png")) throw new Error("provider timeout\nstack");
        if (label.includes("Unknownco")) return JSON.stringify({ essence: "", borrow: [] });
        return JSON.stringify(GOOD);
      },
    });

    assert.deepEqual(reads.map((x) => [x.label, x.source]), [["site.example", "seen"], ["Linear", "recalled"]]);
    assert.deepEqual(sent.map((s) => s.label), ["reference read: site.example", "reference read: Linear", "reference read: shot.png", "reference read: Unknownco"], "one call each; unusable ones are never sent");
    assert.deepEqual(sent[0].models, ["vision/judge"]);

    const seen = sent[0].messages[1].content as any[];
    assert.equal(seen.filter((p) => p.type === "image_url").length, 2, "desktop and phone");
    assert.match(seen[0].text, /Measured from the rendered page \(facts\): light theme; background #fbfbfd/);
    assert.match(String(sent[0].messages[0].content), /never contradict them/);
    assert.match(String(sent[0].messages[0].content), /Do not copy: what makes this product itself/);

    assert.equal(typeof sent[1].messages[1].content, "string", "a named product is sent no image");
    assert.match(String(sent[1].messages[0].content), /describe the design you remember of it, and say less rather than invent/);

    assert.deepEqual(reads[0].measured, cues, "the measured cues are copied by code, not taken from the model");
    assert.equal(reads[1].measured, undefined);
    assert.deepEqual(lines, [
      "[REFERENCE] gone.png: its screenshot could not be read, so it was left out.",
      "[REFERENCE] shot.png: the model could not read it (provider timeout), so it was left out.",
      "[REFERENCE] Unknownco: the model did not recognise it, so it was left out.",
    ]);
  });

  test("what the next step is handed: measured facts first, recalled ones flagged, borrow and do-not-copy kept apart; saved as data and text", async () => {
    const { r, refs } = setup();
    const reads = await readReferences(refs.slice(0, 2), { repoRoot: r, models: ["m"], call: async () => JSON.stringify(GOOD) });
    const text = renderReads(reads);
    assert.match(text, /^## site\.example \(seen in its screenshots\)\nCalm, quiet confidence/);
    assert.match(text, /- Measured: light theme; background #fbfbfd/);
    assert.match(text, /## Linear \(recalled from memory, not seen: weigh it lightly\)/);
    assert.match(text, /- Borrow:\n {2}- One accent colour, used sparingly/);
    assert.match(text, /- Do not copy:\n {2}- The YIMPIM mark and name/);
    assert.equal(renderReads([]), "");

    const out = path.join(r, "out");
    writeReads(out, reads);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, "reads.json"), "utf8")).reads.length, 2);
    assert.match(fs.readFileSync(path.join(out, "READ.md"), "utf8"), /^# What the references look like\n\n## site\.example/);
  });

  test("an empty field is left out of the text, not printed as a bare label", async () => {
    const { r, refs } = setup();
    const reads = await readReferences(refs.slice(0, 1), { repoRoot: r, models: ["m"], call: async () => JSON.stringify({ ...GOOD, layout: "" }) });
    assert.doesNotMatch(renderReads(reads), /- Layout:/);
  });
});
