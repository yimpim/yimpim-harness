/**
 * /model's role list: every chain starts in one column, and a chain too long for the terminal breaks at a "→" with a hanging indent under its
 * first model, instead of the terminal soft-wrapping it to the left margin (where it read as a new row under the role names).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { roleRow, roleColumnWidth, visibleWidth, RAIL_WIDTH, RADIO_WIDTH, CHAIN_SEPARATOR } from "../src/wizard/modelPicker.js";
import { PERSONAS } from "../src/models.js";

const labels = PERSONAS.map((p) => p.label);
const labelWidth = roleColumnWidth(labels);
const designer = ["deepseek/deepseek-v4.1-flash-1017", "openai/gpt-5.4-mini", "z-ai/glm-5.3-flash", "openai/gpt-5.6-luna", "google/gemini-3.8-flash", "qwen/qwen3-coder"];
const judge = ["deepseek/deepseek-v4.1-flash-1017", "google/gemini-3.8-flash", "qwen/qwen3.7-plus", "openai/gpt-5-mini"];
const OPTIONAL_HINT = " (optional)".length;

/** What clack draws: the rail in front of every line, the radio in front of the first. */
const onScreen = (label: string) => label.split("\n").map((l, i) => " ".repeat(RAIL_WIDTH) + (i === 0 ? " ".repeat(RADIO_WIDTH) : "") + l);

describe("the role column", () => {
  test("is as wide as the longest label, Designer Judge (Vision), plus a gap", () => {
    assert.equal(Math.max(...labels.map((l) => l.length)), "Designer Judge (Vision)".length);
    assert.equal(labelWidth, "Designer Judge (Vision)".length + 2);
  });

  test("every role's chain starts in the same screen column, set or unset", () => {
    const set = PERSONAS.map((p) => onScreen(roleRow(p.label, ["x/y"], "(unset)", { columns: 120, labelWidth }))[0].indexOf("x/y"));
    const unset = PERSONAS.map((p) => onScreen(roleRow(p.label, undefined, "(unset)", { columns: 120, labelWidth }))[0].indexOf("(unset)"));
    assert.equal(new Set([...set, ...unset]).size, 1, `chains start at ${[...set, ...unset].join(",")}`);
    assert.equal(set[0], RAIL_WIDTH + RADIO_WIDTH + labelWidth);
  });
});

for (const columns of [80, 100]) {
  describe(`a ${columns}-column terminal`, () => {
    for (const [label, chain, optional] of [["Designer", designer, true], ["Designer Judge (Vision)", judge, true], ["Planner", ["google/gemini-4-hydrogen", "openai/gpt-5.4-mini"], false]] as const) {
      const row = roleRow(label, [...chain], "(unset)", { columns, labelWidth, reserve: optional ? OPTIONAL_HINT : 0 });
      const screen = onScreen(row);

      test(`${label}: no line reaches the edge, and the last leaves room for the (optional) hint`, () => {
        // Strictly inside: a line filling the last column can make a console wrap the cursor onto a blank line.
        for (const l of screen) assert.ok(visibleWidth(l) < columns, `${visibleWidth(l)} cols: ${l}`);
        assert.ok(visibleWidth(screen[screen.length - 1]) + (optional ? OPTIONAL_HINT : 0) < columns, screen[screen.length - 1]);
      });

      test(`${label}: continuation lines hang under the first model and open with "→"`, () => {
        const chainCol = RAIL_WIDTH + RADIO_WIDTH + labelWidth;
        assert.equal(screen[0].indexOf(chain[0]), chainCol);
        for (const l of screen.slice(1)) {
          assert.equal(l.search(/\S/), chainCol, `continuation starts under the chain: "${l}"`);
          assert.ok(l.slice(chainCol).startsWith("→  "), l);
        }
      });

      test(`${label}: breaks only at separators, and every model is there once, in order`, () => {
        const text = row.split("\n").map((l, i) => (i === 0 ? l.slice(labelWidth) : l.trimStart().replace(/^→ {2}/, ""))).join(CHAIN_SEPARATOR);
        assert.equal(text, chain.join(CHAIN_SEPARATOR));
      });
    }

    test("the six-model Designer chain actually wraps here, so the hanging indent is exercised", () => {
      assert.ok(roleRow("Designer", designer, "(unset)", { columns, labelWidth, reserve: OPTIONAL_HINT }).split("\n").length >= 2);
    });
  });
}

describe("edges", () => {
  test("a short chain stays on one line", () => {
    assert.equal(roleRow("Planner", ["a/b", "c/d"], "(unset)", { columns: 80, labelWidth }), "Planner".padEnd(labelWidth) + "a/b  →  c/d");
  });

  test("an unset role shows its fallback text in the chain column", () => {
    assert.equal(roleRow("Existence", undefined, "(unset: uses Discovery)", { columns: 80, labelWidth }), "Existence".padEnd(labelWidth) + "(unset: uses Discovery)");
    assert.equal(roleRow("Security", [], "(unset)", { columns: 80, labelWidth }), "Security".padEnd(labelWidth) + "(unset)");
  });

  test("one model id wider than the whole column is hard-broken rather than overflowing", () => {
    const long = "vendor/" + "x".repeat(90);
    for (const l of onScreen(roleRow("Editor", [long], "(unset)", { columns: 60, labelWidth }))) assert.ok(visibleWidth(l) < 60, l);
  });
});

test("/model builds its role rows with roleRow at the terminal's width", () => {
  const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");
  assert.match(idx, /label: roleRow\(p\.label, config\.models\[p\.key\], unsetLabel\(p,/);
  assert.match(idx, /columns: process\.stdout\.columns \|\| 80,\n\s+labelWidth: roleColumnWidth\(PERSONAS\.map\(\(x\) => x\.label\)\),/);
  assert.doesNotMatch(idx, /p\.label\.padEnd\(20\)/);
});
