import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { linkifyFilePaths, supportsHyperlinks } from "../src/terminalLinks.js";
import { stripAnsi } from "../src/richText.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gage-links-"));
fs.mkdirSync(path.join(dir, "design"));
fs.writeFileSync(path.join(dir, "design", "guidelines.html"), "x");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("clickable file paths", () => {
  test("an existing file becomes a hyperlink and still reads as the same text", () => {
    const out = linkifyFilePaths("Saved design/guidelines.html (3 files)", [dir], true);
    const ESC = String.fromCharCode(27);
    const BS = String.fromCharCode(92);
    assert.ok(out.startsWith(`Saved ${ESC}]8;;file:///`));
    assert.ok(out.includes(`guidelines.html${ESC}${BS}design/guidelines.html${ESC}]8;;${ESC}${BS} (3 files)`));
    assert.equal(stripAnsi(out), "Saved design/guidelines.html (3 files)");
  });
  test("files that do not exist, URLs and version numbers are left alone", () => {
    for (const s of ["missing/none.html", "see https://example.com/a.html", "v1.2.3 released"]) assert.equal(linkifyFilePaths(s, [dir], true), s);
  });
  test("an absolute path works, and nothing changes when links are off", () => {
    const abs = path.join(dir, "design", "guidelines.html");
    assert.ok(linkifyFilePaths(`wrote ${abs}`, [], true).includes(String.fromCharCode(27) + "]8;;"));
    assert.equal(linkifyFilePaths("design/guidelines.html", [dir], false), "design/guidelines.html");
  });
  test("only terminals that understand links get them", () => {
    assert.equal(supportsHyperlinks({ WT_SESSION: "x" }, true), true);
    assert.equal(supportsHyperlinks({ TERM_PROGRAM: "vscode" }, true), true);
    assert.equal(supportsHyperlinks({ WT_SESSION: "x" }, false), false);
    assert.equal(supportsHyperlinks({ WT_SESSION: "x", GAGE_LINKS: "0" }, true), false);
    assert.equal(supportsHyperlinks({}, true), false);
  });
});
