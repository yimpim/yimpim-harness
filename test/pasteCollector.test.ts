import { test } from "node:test";
import assert from "node:assert/strict";
import { PasteCollector } from "../src/pasteCollector.js";

test("a multi-line paste becomes one placeholder that expands to the full text", () => {
  const p = new PasteCollector();
  p.start();
  assert.equal(p.pasting, true);
  p.line("first line");
  p.line("second line");
  const token = p.end("third line");
  assert.equal(p.pasting, false);
  assert.match(token!, /^\[Pasted text #1 \+3 lines\]$/);
  assert.equal(p.expand(`please fix: ${token}`), "please fix: first line\nsecond line\nthird line");
  // consumed once
  assert.equal(p.expand(token!), token);
});

test("a trailing newline does not add an empty line", () => {
  const p = new PasteCollector();
  p.start();
  p.line("a");
  p.line("b");
  const token = p.end("");
  assert.equal(p.expand(token!), "a\nb");
});

test("a single pasted line is left to readline", () => {
  const p = new PasteCollector();
  p.start();
  assert.equal(p.end("just one line"), undefined);
});

test("one newline-terminated line comes back as plain text, not a placeholder", () => {
  const p = new PasteCollector();
  p.start();
  p.line("only line");
  assert.equal(p.end(""), "only line");
});

test("a second paste gets its own number", () => {
  const p = new PasteCollector();
  p.start();
  p.line("a");
  p.end("b");
  p.start();
  p.line("c");
  assert.match(p.end("d")!, /#2/);
});
