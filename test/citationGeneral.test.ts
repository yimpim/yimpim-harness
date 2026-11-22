/**
 * The citation and reading layer assumes no language and no project layout: a request that cites a .py, .go or .html place (in a repo with no src/ or app/ folder) is read where it
 * cites; a request that cites nothing is found by its words as before; and the harness's own places are never evidence or read as the user's code.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCandidates, citationsFor, type Requirement } from "../src/existence.js";
import { parseCodeRefs, resolveRefs, resolveOnDisk, readRange, SAFE } from "../src/codeContext.js";

const file = (rel: string, lines: number, at: Record<number, string> = {}) => ({ rel, text: Array.from({ length: lines }, (_, i) => at[i + 1] ?? `# filler ${i + 1}`).join("\n") });
const lowerOf = (files: { rel: string; text: string }[]) => new Map(files.map((f) => [f.rel, f.text.toLowerCase()]));
const counts = (files: { rel: string; text: string }[]) => files.map((f) => ({ rel: f.rel, lines: f.text.split("\n").length }));
const req = (text: string, terms: string[] = []): Requirement => ({ id: "R1", text, terms });

describe("no language and no layout is assumed", () => {
  test("any extension is read as a citation, and what is not a file in this project is dropped when it is checked against the tree", () => {
    const text = "Fix billing/invoice.py:40-60, cmd/server/main.go:12, web/index.html lines 5-9, lib/worker.ex:7, init.lua (line 3), and mind the e.g. and Node.js notes.";
    const refs = parseCodeRefs(text);
    assert.deepEqual(refs.filter((r) => r.from !== undefined).map((r) => [r.file, r.from, r.to]), [
      ["billing/invoice.py", 40, 60],
      ["cmd/server/main.go", 12, 12],
      ["web/index.html", 5, 9],
      ["lib/worker.ex", 7, 7],
      ["init.lua", 3, 3],
    ]);
    const tree = [{ rel: "billing/invoice.py", lines: 100 }, { rel: "cmd/server/main.go", lines: 30 }, { rel: "web/index.html", lines: 20 }, { rel: "lib/worker.ex", lines: 9 }, { rel: "init.lua", lines: 4 }];
    const real = resolveRefs(refs, tree).map((r) => r.file).sort();
    assert.deepEqual(real, ["billing/invoice.py", "cmd/server/main.go", "init.lua", "lib/worker.ex", "web/index.html"], "the prose words found no file, so they are not citations");
  });

  test("a cited .py place in a repo with no src/ or app/ is the first candidate, led by the cited lines", () => {
    const files = [file("billing/invoice.py", 200, { 120: "def total_with_tax(items):  # cited", 121: "    return sum(i.price for i in items)" }), file("billing/tax.py", 50, { 3: "def tax_rate(): return 0.2" }), file("main.go", 20)];
    const r = req("Invoices show the tax (billing/invoice.py:118-125)", ["tax"]);
    const cited = citationsFor(r, [], counts(files));
    assert.deepEqual(cited, [{ file: "billing/invoice.py", from: 118, to: 125 }]);
    const out = findCandidates(r, files, lowerOf(files), new Set(), 4, false, new Set(), cited);
    assert.equal(out[0].file, "billing/invoice.py");
    assert.match(out[0].snippet, /120: def total_with_tax/);
  });

  test("a cited .html file and a Go file at the project root work the same way", () => {
    const files = [file("index.html", 80, { 40: "<section id=\"streak\">7 days</section>" }), file("main.go", 60, { 10: "func main() { serve() }" })];
    const r = req("The page shows the streak (index.html:38-44) and main.go:8-12 starts it", ["streak"]);
    const cited = citationsFor(r, [], counts(files));
    assert.deepEqual(cited.map((c) => c.file).sort(), ["index.html", "main.go"]);
    const out = findCandidates(r, files, lowerOf(files), new Set(), 4, false, new Set(), cited);
    assert.deepEqual(out.map((c) => c.file).sort(), ["index.html", "main.go"]);
  });

  test("a request with no citation at all finds its files by words exactly as before, in any language", () => {
    const files = [file("billing/invoice.py", 60, { 30: "def apply_discount(order): return order.total * 0.9" }), file("other.go", 30)];
    const r = req("Orders can have a discount applied", ["apply_discount"]);
    assert.deepEqual(parseCodeRefs("Orders can have a discount applied. Please make it so."), []);
    assert.deepEqual(citationsFor(r, [], counts(files)), []);
    const out = findCandidates(r, files, lowerOf(files));
    assert.deepEqual(out.map((c) => c.file), ["billing/invoice.py"]);
    assert.deepEqual(findCandidates(r, files, lowerOf(files), new Set(), 4, false, new Set(), []), out);
  });
});

describe("the harness's own places stay out", () => {
  test("a cited file under reference/, a spec folder or a test folder is never evidence for an ordinary requirement", () => {
    const files = [file("reference/screen.py", 40, { 5: "def streak(): pass" }), file("specs/streak.py", 40, { 5: "def streak(): pass" }), file("tests/test_streak.py", 40, { 5: "def streak(): pass" })];
    const r = req("The streak shows (reference/screen.py:3-8, specs/streak.py:3-8, tests/test_streak.py:3-8)", ["streak"]);
    const cited = citationsFor(r, [], counts(files));
    assert.deepEqual(cited, [], "none of them is a place that can be evidence, so none is a citation for the requirement");
    const asCited = [{ file: "reference/screen.py", from: 3, to: 8 }, { file: "specs/streak.py", from: 3, to: 8 }, { file: "tests/test_streak.py", from: 3, to: 8 }];
    assert.deepEqual(findCandidates(r, files, lowerOf(files), new Set(), 4, false, new Set(), asCited), [], "even when forced in, they are not candidates");
  });

  test(".yimpim/ is never a citation and never readable by the shared reader; AGENTS.md is only ever a document", () => {
    assert.deepEqual(parseCodeRefs("see .yimpim/state.json:3 and .yimpim/notes.md"), []);
    assert.equal(SAFE(".yimpim/state.json"), false);
    assert.equal(SAFE("pkg/a.py"), true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-"));
    try {
      fs.mkdirSync(path.join(root, ".yimpim"), { recursive: true });
      fs.writeFileSync(path.join(root, ".yimpim/state.json"), "{}\n");
      fs.writeFileSync(path.join(root, "AGENTS.md"), "rules\n");
      assert.equal(readRange(root, ".yimpim/state.json"), undefined);
      assert.deepEqual(resolveOnDisk(root, parseCodeRefs(".yimpim/state.json:1")), []);
      const docs = [file("AGENTS.md", 10, { 2: "streak rules" })];
      const out = findCandidates(req("streak (AGENTS.md:1-5)", ["streak"]), docs, lowerOf(docs), new Set(), 4, false, new Set(), [{ file: "AGENTS.md", from: 1, to: 5 }]);
      assert.ok(out.every((c) => c.file !== "AGENTS.md") || out.length === 1, "a document is at most a document");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
