import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { slashCompleter, computeSuggestions } from "../src/terminalInput.js";
import fs from "node:fs";
import { DESKTOP_SLASH_COMMANDS } from "../src/slashCommands.js";

describe("slashCompleter", () => {
  test("does nothing for a line that isn't a slash command", () => {
    assert.deepEqual(slashCompleter("add a logout button"), [[], "add a logout button"]);
  });

  test("a unique prefix auto-completes to the single match, with a trailing space", () => {
    const [hits] = slashCompleter("/memo");
    assert.deepEqual(hits, ["/memory "]);
  });

  test("an ambiguous prefix lists every match, untouched (no trailing spaces)", () => {
    const [hits] = slashCompleter("/model");
    assert.ok(hits.includes("/model"), "must include the exact command itself");
    assert.ok(!hits.includes("/models"), "aliases are not suggested from a prefix");
    assert.ok(hits.includes("/model-sort"), "must include the other command sharing this prefix");
    assert.ok(hits.every((h) => !h.endsWith(" ")), "a multi-match list must not carry trailing spaces");
  });

  test("no match returns an empty list rather than suggesting everything", () => {
    assert.deepEqual(slashCompleter("/nonexistent"), [[], "/nonexistent"]);
  });

  test("an already-complete, unambiguous command still re-offers itself with the trailing space", () => {
    // /stop has no other command sharing its prefix, so typing it in full
    // and hitting Tab again is harmless — it just adds the space.
    const [hits] = slashCompleter("/stop");
    assert.deepEqual(hits, ["/stop "]);
  });

  test("every entry in the fixed command list is actually completable to itself", () => {
    for (const { cmd } of DESKTOP_SLASH_COMMANDS) {
      const [hits] = slashCompleter(cmd);
      assert.ok(
        hits.some((h) => h.trim() === cmd),
        `${cmd} did not appear among its own completions`
      );
    }
  });
});

describe("computeSuggestions", () => {
  test("shows nothing for plain text", () => {
    assert.deepEqual(computeSuggestions("add a logout button"), []);
  });

  test("shows nothing for a bare slash with nothing typed after it yet", () => {
    assert.deepEqual(computeSuggestions("/"), []);
  });

  test("lists every command sharing a typed prefix, with descriptions", () => {
    const hits = computeSuggestions("/model");
    const cmds = hits.map((h) => h.cmd);
    assert.ok(cmds.includes("/model"));
    assert.ok(!cmds.includes("/models"), "an alias is not listed");
    assert.ok(cmds.includes("/model-sort"));
    assert.ok(hits.every((h) => h.desc.length > 0), "every suggestion must carry a description");
  });

  test("disappears once the line is already an exact, unambiguous command", () => {
    // /stop has no other command sharing its prefix, so once it's fully
    // typed there is nothing left for the panel to disambiguate.
    assert.deepEqual(computeSuggestions("/stop"), []);
  });

  test("stays visible on an exact match that is still ambiguous with another command", () => {
    // "/model" is itself a valid, complete command, but "/model-sort" still shares the prefix — the panel must not vanish
    // just because what's typed so far happens to also be a real command.
    const hits = computeSuggestions("/model");
    assert.ok(hits.some((h) => h.cmd === "/model-sort"));
  });

  test("returns nothing for a prefix that matches no real command", () => {
    assert.deepEqual(computeSuggestions("/nonexistent"), []);
  });
});


describe("every command the prompt handles is suggested", () => {
  test("/r lists the short top-level commands, and the roadmap sub-commands appear once /roadmap is typed", () => {
    const top = computeSuggestions("/r").map((c) => c.cmd);
    assert.ok(top.includes("/roadmap") && top.includes("/remote-control"));
    assert.ok(!top.some((c) => c.startsWith("/roadmap ")), "sub-commands do not crowd the short list");
    const sub = computeSuggestions("/roadmap ").map((c) => c.cmd);
    assert.ok(sub.includes("/roadmap reset") && sub.includes("/roadmap new") && sub.includes("/roadmap open"));
    assert.deepEqual(computeSuggestions("/roadmap re").map((c) => c.cmd), ["/roadmap reopen", "/roadmap reset"]);
  });
  test("/design and /pentest are suggested too, and every handled slash command is in the list", () => {
    assert.ok(computeSuggestions("/pe").some((c) => c.cmd === "/pentest"));
    assert.ok(computeSuggestions("/des").some((c) => c.cmd === "/design"));
    const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    const handled = [...src.matchAll(/trimmed === "(\/[a-z-]+)"/g)].map((m) => m[1]);
    const listed = new Set(DESKTOP_SLASH_COMMANDS.map((c) => c.cmd));
    assert.deepEqual(handled.filter((c) => !listed.has(c)), []);
  });
});

describe("leaving the session does not leave the pinned rows on screen", () => {
  test("/exit closes the pinned input before saying goodbye and exiting, and closing erases its rows", async () => {
    const fsx = await import("node:fs");
    const index = fsx.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
    const at = index.indexOf('trimmed === "/exit"');
    const block = index.slice(at, index.indexOf("process.exit(0);", at));
    assert.ok(block.indexOf("stopPersistentInput();") > 0 && block.indexOf("stopPersistentInput();") < block.indexOf("Session terminated"));
    const ti = fsx.readFileSync(new URL("../src/terminalInput.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
    const disposer = ti.slice(ti.indexOf("setup();\n  return () => {"), ti.indexOf("function teardown"));
    assert.match(disposer, /clearInputArea\(\);[\s\S]*teardown\(\);/);
  });
});

import { statusRepaintSequence } from "../src/terminalInput.js";

describe("the status row is rewritten in place, in one write", () => {
  test("up to the row, clear it, write it, back down, and to the cursor's own column", () => {
    assert.equal(statusRepaintSequence("▸ REPAIR running", 3, 11), "\u001b[3A\r\u001b[2K▸ REPAIR running\u001b[3B\u001b[12G");
  });
  test("it is a single string, so the terminal never shows the row half done", () => {
    assert.equal(typeof statusRepaintSequence("x", 2, 0), "string");
  });
  test("setStatusLine uses it only when just the words changed, and otherwise redraws everything as before", () => {
    const src = fs.readFileSync(new URL("../src/terminalInput.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
    assert.match(src, /if \(hadRow && text !== undefined && paintStatusInPlace\(text\)\) return;\n\s+clearInputArea\(\);\n\s+redrawInputArea\(\);/);
    // Only with certain geometry: a one-row prompt, the cursor on it, the status row present, no paste in progress.
    assert.match(src, /lastStatusRows !== 1 \|\| lastPromptRows !== 1/);
    assert.match(src, /pos\.rows !== 0/);
  });
});
