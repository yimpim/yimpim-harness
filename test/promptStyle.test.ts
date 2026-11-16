/**
 * One yes/no wording and one answer parser for every terminal question.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { YES_NO, YES_NO_ENTER_NO, YES_NO_ENTER_YES, parseYesNo } from "../src/promptStyle.js";

describe("parseYesNo", () => {
  test("y and yes, in any case, are yes; n and no are no", () => {
    for (const a of ["y", "Y", "yes", "YES", " Yes ", "yep"]) assert.equal(parseYesNo(a, "none"), true, a);
    for (const a of ["n", "N", "no", "NO", " no "]) assert.equal(parseYesNo(a, "yes"), false, a);
  });

  test("a bare Enter means what the prompt said it means", () => {
    assert.equal(parseYesNo("", "no"), false);
    assert.equal(parseYesNo("   ", "no"), false);
    assert.equal(parseYesNo("", "none"), false);
    assert.equal(parseYesNo("", "yes"), true);
    assert.equal(parseYesNo("\n", "yes"), true);
  });

  test("an answer that is neither yes nor no is no, even when Enter means yes", () => {
    assert.equal(parseYesNo("maybe", "yes"), false);
    assert.equal(parseYesNo("what?", "no"), false);
  });

  test("the default is no when none is given", () => {
    assert.equal(parseYesNo(""), false);
  });

  test("typing the short form works where a prompt once demanded the whole word", () => {
    // `Continue? [yes/no]` used to treat "y" as no and clear the task queue.
    assert.equal(parseYesNo("y", "none"), true);
  });
});

describe("the three suffixes say in words what Enter does", () => {
  test("wording", () => {
    assert.equal(YES_NO_ENTER_NO, "(yes/no, Enter = no)");
    assert.equal(YES_NO_ENTER_YES, "(yes/no, Enter = yes)");
    assert.equal(YES_NO, "(yes/no)");
  });
});

describe("no hand-written suffix is left in the source", () => {
  test("no prompt string uses [y/N], [Y/n] or [yes/no] any more", () => {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = path.join(here, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts")) {
          fs.readFileSync(full, "utf-8")
            .split(/\r?\n/)
            .forEach((line, i) => {
              if (/\[y\/N\]|\[Y\/n\]|\[yes\/no\]/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) && !/APPROVAL_SUFFIX_PATTERN/.test(line)) {
                offenders.push(`${path.relative(src, full)}:${i + 1}: ${line.trim().slice(0, 90)}`);
              }
            });
        }
      }
    };
    walk(src);
    assert.deepEqual(offenders, [], `use the constants in promptStyle.ts:\n${offenders.join("\n")}`);
  });
});
