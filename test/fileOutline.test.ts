/**
 * A file too big for one read comes back with a table of contents of the WHOLE file, so the next read goes straight to a block. No language is assumed.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { outlineEntries, truncationOutline } from "../src/fileOutline.js";
import { AgentTools } from "../src/agentTools.js";
import { ConfigSchema } from "../src/config.js";

const entries = (text: string) => outlineEntries(text.split("\n")).map((e) => `${e.start}-${e.end} ${e.text}`);

describe("declarations, in any language", () => {
  test("TypeScript: functions, classes, top-level arrow bindings and exported consts, with the lines each covers; inner hooks and comments are not declarations", () => {
    const ts = [
      "import x from 'x';", //1
      "export function Dashboard() {", //2
      "  const ref = useRef(null);", //3
      "  const load = async () => {", //4 indent 2 arrow: not shown (indent <= 4 but binding needs indent 0 or arrow) -> arrow IS shown
      "    await go();", //5
      "  };", //6
      "  return null;", //7
      "}", //8
      "// function notThis() {}", //9
      "export class Store {", //10
      "  async fetch() {}", //11
      "}", //12
      "export const THEME = { a: 1 };", //13
    ].join("\n");
    const e = entries(ts);
    assert.ok(e.some((l) => /^2-9 export function Dashboard/.test(l)), e.join("|"));
    assert.ok(e.some((l) => /^10-12 export class Store/.test(l)));
    assert.ok(e.some((l) => /^13-13 export const THEME/.test(l)));
    assert.ok(!e.some((l) => /useRef/.test(l)), "an inner hook is not a declaration");
    assert.ok(!e.some((l) => /notThis/.test(l)), "a comment is not a declaration");
  });
  test("Python, Go, Kotlin and Rust", () => {
    assert.deepEqual(entries("import os\n\nclass A:\n    def run(self):\n        pass\n\ndef main():\n    pass\n"), ["3-6 class A:", "4-6 def run(self):", "7-8 def main():"]);
    const go = entries("package x\n\nfunc (s *Server) Start() error {\n  return nil\n}\n\nfunc main() {\n}\n");
    assert.ok(go.some((l) => /^3-6 func \(s \*Server\) Start/.test(l)) && go.some((l) => /^7-8 func main/.test(l)), go.join("|"));
    assert.ok(entries("class Foo {\n    fun bar() {}\n}\nfun top() {}\n").length === 3);
    assert.ok(entries("pub struct A;\nimpl A {\n    pub fn new() -> A { A }\n}\nfn main() {}\n").length === 4);
  });
  test("a file with nothing this reads gives no outline and no extra text", () => {
    assert.equal(truncationOutline("just some prose\nand more prose\n"), "");
  });
  test("the outline is capped, says how many more there are, and trims long lines", () => {
    const many = Array.from({ length: 200 }, (_, i) => `function f${i}() {}`).join("\n");
    const out = truncationOutline(many, 80);
    assert.equal(out.split("\n").filter((l) => /^L\d+-\d+ {2}function f/.test(l)).length, 80);
    assert.match(out, /120 more declaration\(s\); search_code finds them by name\./);
    assert.ok(entries("export function " + "x".repeat(300) + "() {}")[0].endsWith("..."));
  });
});

describe("read_file on a file bigger than maxFileBytes", () => {
  let root = "";
  const tools = () => new AgentTools(root, ConfigSchema.parse({ limits: { maxFileBytes: 1500 } }));
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "outline-"));
    const body: string[] = ["import React from 'react';", "export function Dashboard() {", "  const [a, setA] = useState(0);"];
    for (let i = 0; i < 120; i++) body.push(`  // filler line ${i} of the component body that makes it long`);
    body.push("  return null;", "}", "", "export function PollStream() {", "  return null;", "}", "", "export const TAIL = 1;");
    fs.writeFileSync(path.join(root, "big.tsx"), body.join("\n"));
    fs.writeFileSync(path.join(root, "small.ts"), "export function a() {}\n");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("a whole-file read that is cut carries the outline of the WHOLE file, including declarations past the cut", async () => {
    const out = await tools().readFile("big.tsx");
    assert.match(out, /truncated: big\.tsx is/);
    assert.match(out, /Outline of the WHOLE file/);
    assert.match(out, /L2-\d+ {2}export function Dashboard/);
    assert.match(out, /L\d+-\d+ {2}export function PollStream/, "a declaration the cut hid is in the outline");
    assert.match(out, /L\d+-\d+ {2}export const TAIL/);
  });
  test("a range read too large for the cap also carries it", async () => {
    const out = await tools().readFile("big.tsx", 1, 140);
    assert.match(out, /Request a narrower line range/);
    assert.match(out, /export function PollStream/);
  });
  test("the line numbers in the outline are the ones a range read uses: reading the block it names gives that declaration", async () => {
    const out = await tools().readFile("big.tsx");
    const m = /L(\d+)-(\d+) {2}export function PollStream/.exec(out)!;
    const block = await tools().readFile("big.tsx", Number(m[1]), Number(m[2]));
    assert.match(block, /export function PollStream/);
    assert.doesNotMatch(block, /truncated/);
  });
  test("a file that fits is read exactly as before: no outline", async () => {
    const out = await tools().readFile("small.ts");
    assert.doesNotMatch(out, /Outline/);
    assert.equal(out.trim(), "export function a() {}");
  });
  test("get_file_outline sees the whole big file, and still does after the file was already read", async () => {
    const t = tools();
    await t.readFile("big.tsx");
    const o = await t.getFileOutline("big.tsx");
    assert.match(o, /export const TAIL/, "past the 1500-byte cut");
    assert.doesNotMatch(o, /already shown/);
  });
});
