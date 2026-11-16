import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { slashCompleter, computeSuggestions } from "../src/terminalInput.js";
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
    assert.ok(hits.includes("/models"), "must include the alias");
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
    assert.ok(cmds.includes("/models"));
    assert.ok(cmds.includes("/model-sort"));
    assert.ok(hits.every((h) => h.desc.length > 0), "every suggestion must carry a description");
  });

  test("disappears once the line is already an exact, unambiguous command", () => {
    // /stop has no other command sharing its prefix, so once it's fully
    // typed there is nothing left for the panel to disambiguate.
    assert.deepEqual(computeSuggestions("/stop"), []);
  });

  test("stays visible on an exact match that is still ambiguous with another command", () => {
    // "/model" is itself a valid, complete command, but "/models" and
    // "/model-sort" both still share the prefix — the panel must not vanish
    // just because what's typed so far happens to also be a real command.
    const hits = computeSuggestions("/model");
    assert.ok(hits.some((h) => h.cmd === "/models"));
  });

  test("returns nothing for a prefix that matches no real command", () => {
    assert.deepEqual(computeSuggestions("/nonexistent"), []);
  });
});
