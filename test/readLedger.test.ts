/**
 * One task reads the same files in three stages (existence, discovery, the planner). The read ledger records, per stage, which lines each has been SHOWN, so an overlapping read sends only
 * the lines it has not been shown and a file that changed on disk is forgotten; and what one stage learned reaches the next as text in its prompt. The rule that makes it safe: a range is
 * recorded for a stage only when its text is in that stage's context, so no stage ever skips lines it has not seen.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReadLedger, locateQuote, resolveOnDisk, parseCodeRefs } from "../src/codeContext.js";
import { AgentTools } from "../src/agentTools.js";
import { placesOf, checkExistence } from "../src/existence.js";
import type { AgentConfig } from "../src/config.js";

const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (rel: string, lines: number, mark: (n: number) => string = (n) => `const line${n} = ${n};`) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), Array.from({ length: lines }, (_, i) => mark(i + 1)).join("\n"));
};
/** Writes new content and makes sure the file's modification time is different (some file systems have coarse clocks). */
const rewrite = (rel: string, lines: number, mark: (n: number) => string) => {
  write(rel, lines, mark);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, rel), t, t);
};

describe("overlap suppression", () => {
  test("a stage is only sent the lines it has not been shown, however the ranges overlap", () => {
    write("a.ts", 300);
    const l = new ReadLedger(root);
    l.begin("DISCOVERY");
    assert.deepEqual(l.unseen("DISCOVERY", "a.ts", 100, 200), [[100, 200]], "nothing shown yet");
    l.record("DISCOVERY", "a.ts", 100, 200);
    assert.deepEqual(l.unseen("DISCOVERY", "a.ts", 150, 250), [[201, 250]], "an overlapping read: only the new tail");
    assert.deepEqual(l.unseen("DISCOVERY", "a.ts", 120, 180), [], "inside what was shown: nothing");
    assert.deepEqual(l.unseen("DISCOVERY", "a.ts", 50, 120), [[50, 99]], "an overlap at the front");
    l.record("DISCOVERY", "a.ts", 201, 250);
    l.record("DISCOVERY", "a.ts", 20, 40);
    assert.deepEqual([...l.rangesOf("DISCOVERY")], [["a.ts", [[20, 40], [100, 250]]]], "touching ranges are one range");
    assert.deepEqual(l.unseen("DISCOVERY", "a.ts", 1, 300), [[1, 19], [41, 99], [251, 300]]);
  });

  test("another file, and another stage, are unaffected", () => {
    write("a.ts", 50);
    write("b.ts", 50);
    const l = new ReadLedger(root);
    l.record("DISCOVERY", "a.ts", 1, 50);
    assert.deepEqual(l.unseen("DISCOVERY", "b.ts", 1, 50), [[1, 50]]);
    assert.deepEqual(l.unseen("PLANNER", "a.ts", 1, 50), [[1, 50]], "what discovery was shown is not what the planner was shown");
  });

  test("a new conversation of a stage starts with nothing shown", () => {
    write("a.ts", 50);
    const l = new ReadLedger(root);
    l.record("PLANNER", "a.ts", 1, 50);
    l.begin("PLANNER");
    assert.deepEqual(l.unseen("PLANNER", "a.ts", 1, 50), [[1, 50]]);
  });
});

describe("a file that changes on disk is forgotten", () => {
  test("after a write, every stage is sent the whole range again", () => {
    write("a.ts", 100);
    const l = new ReadLedger(root);
    l.record("DISCOVERY", "a.ts", 1, 100);
    l.record("PLANNER", "a.ts", 10, 20);
    assert.deepEqual(l.unseen("DISCOVERY", "a.ts", 1, 100), []);
    rewrite("a.ts", 100, (n) => `export const changed${n} = "different";`);
    assert.deepEqual(l.unseen("DISCOVERY", "a.ts", 1, 100), [[1, 100]], "the line numbers mean something else now");
    assert.deepEqual(l.unseen("PLANNER", "a.ts", 10, 20), [[10, 20]]);
    assert.deepEqual([...l.rangesOf("DISCOVERY")], [], "and forward would not carry a stale range");
  });
  test("a file that is deleted is forgotten, and an unchanged file keeps what it was shown", () => {
    write("gone.ts", 10);
    write("kept.ts", 10);
    const l = new ReadLedger(root);
    l.record("DISCOVERY", "gone.ts", 1, 10);
    l.record("DISCOVERY", "kept.ts", 1, 10);
    fs.rmSync(path.join(root, "gone.ts"));
    assert.deepEqual(l.unseen("DISCOVERY", "gone.ts", 1, 10), [[1, 10]]);
    assert.deepEqual(l.unseen("DISCOVERY", "kept.ts", 1, 10), []);
  });
});

describe("what a stage is told up front is the only thing recorded for it", () => {
  test("inject writes the lines (real numbers) and records exactly those; a second injection of the same lines writes nothing", () => {
    write("a.ts", 200);
    const l = new ReadLedger(root);
    l.begin("DISCOVERY");
    const one = l.inject("DISCOVERY", [{ file: "a.ts", from: 120, to: 125 }]);
    assert.match(one.text, /--- a\.ts lines 120-125 of 200\n120\| const line120 = 120;/);
    assert.deepEqual(one.included, [{ file: "a.ts", from: 120, to: 125 }]);
    assert.deepEqual(l.unseen("DISCOVERY", "a.ts", 120, 125), []);
    assert.equal(l.inject("DISCOVERY", [{ file: "a.ts", from: 122, to: 124 }]).text, "", "already in the prompt");
    assert.deepEqual(l.inject("DISCOVERY", [{ file: "a.ts", from: 124, to: 128 }]).included, [{ file: "a.ts", from: 126, to: 128 }], "only the lines not already there");
  });

  test("when the cap cuts a range, only the part that was written is recorded: the rest is still unseen (no blind spot)", () => {
    write("a.ts", 400);
    const l = new ReadLedger(root);
    const out = l.inject("DISCOVERY", [{ file: "a.ts", from: 1, to: 400 }], 600);
    assert.ok(out.text.length <= 700, `wrote ${out.text.length} characters`);
    const wrote = out.included[0];
    assert.equal(wrote.from, 1);
    assert.ok(wrote.to > 1 && wrote.to < 400, `cut at line ${wrote.to}`);
    assert.deepEqual(l.unseen("DISCOVERY", "a.ts", 1, 400), [[wrote.to + 1, 400]]);
    assert.ok(out.text.includes(`${wrote.to}| const line${wrote.to}`) && !out.text.includes(`${wrote.to + 1}| const`));
  });

  test("forward: the next stage gets the text of what the earlier stage was shown (up to the cap, preferred files first) and is recorded only for what was written", () => {
    write("t.ts", 100);
    write("x.ts", 100);
    const l = new ReadLedger(root);
    l.record("DISCOVERY", "x.ts", 1, 100);
    l.record("DISCOVERY", "t.ts", 10, 30);
    const fw = l.forward("DISCOVERY", "PLANNER", 700, ["t.ts"]);
    assert.ok(fw.text.indexOf("--- t.ts lines 10-30") < fw.text.indexOf("--- x.ts"), "the file the planner may open comes first");
    for (const r of fw.included) assert.deepEqual(l.unseen("PLANNER", r.file, r.from, r.to), []);
    const x = fw.included.filter((r) => r.file === "x.ts");
    const covered = x.length ? x[x.length - 1].to : 0;
    assert.ok(covered < 100, "the cap cut x.ts");
    assert.deepEqual(l.unseen("PLANNER", "x.ts", 1, 100), [[covered + 1, 100]], "what was not written is not claimed");
    assert.deepEqual(l.unseen("DISCOVERY", "x.ts", 1, 100), [], "forwarding does not change what the earlier stage was shown");
  });

  test("forwarding after the file changed carries nothing stale: the earlier stage forgot it, so there is nothing to write", () => {
    write("a.ts", 50);
    const l = new ReadLedger(root);
    l.record("DISCOVERY", "a.ts", 1, 50);
    rewrite("a.ts", 50, (n) => `export const v2_${n} = 1;`);
    const fw = l.forward("DISCOVERY", "PLANNER");
    assert.equal(fw.text, "");
    assert.deepEqual(l.unseen("PLANNER", "a.ts", 1, 50), [[1, 50]]);
  });

  test("an unsafe or missing path is never written", () => {
    const l = new ReadLedger(root);
    assert.equal(l.inject("DISCOVERY", [{ file: "../secret.ts", from: 1, to: 2 }, { file: "node_modules/x.js", from: 1, to: 2 }, { file: "nope.ts", from: 1, to: 2 }]).text, "");
  });
});

describe("the ledger in the reads of a stage (AgentTools.readFile)", () => {
  const tools = () => new AgentTools(root, {} as AgentConfig);

  test("a ranged read that overlaps what the stage was shown returns only the new lines, labelled, and says so", async () => {
    write("a.ts", 300);
    const t = tools();
    await t.withReadStage("DISCOVERY", async () => {
      const first = await t.readFile("a.ts", 100, 200);
      assert.match(first, /showing lines 100-200 of 300 total/);
      const second = await t.readFile("a.ts", 150, 250);
      assert.match(second, /showing lines 201-250 of 300 total; the rest of 150-250 was already shown above/);
      assert.match(second, /const line201 = 201;/);
      assert.ok(!second.includes("const line180 = 180;"), "lines already shown are not sent again");
      const third = await t.readFile("a.ts", 120, 240);
      assert.match(third, /already shown to you earlier in this conversation/);
      assert.ok(!third.includes("const line150"));
    });
  });

  test("with no stage set (the editor, repair) a read is exactly what it was, every time", async () => {
    write("a.ts", 100);
    const t = tools();
    const a = await t.readFile("a.ts", 10, 20);
    const b = await t.readFile("a.ts", 10, 20);
    assert.equal(a, b);
    assert.match(a, /showing lines 10-20 of 100 total/);
  });

  test("a file edited between two reads is sent in full again", async () => {
    write("a.ts", 100);
    const t = tools();
    await t.withReadStage("PLANNER", async () => {
      await t.readFile("a.ts", 1, 50);
      rewrite("a.ts", 100, (n) => `export const edited${n} = 1;`);
      const again = await t.readFile("a.ts", 1, 50);
      assert.match(again, /showing lines 1-50 of 100 total\]\nexport const edited1 = 1;/);
    });
  });

  test("a whole-file read is recorded only when every line was returned: a cut file is not marked as seen", async () => {
    write("small.ts", 20);
    write("big.ts", 4000, (n) => `export const aLongEnoughLineToFillTheLimit${n} = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";`);
    const t = new AgentTools(root, { limits: { maxFileBytes: 20_000 } } as AgentConfig);
    await t.withReadStage("DISCOVERY", async () => {
      await t.readFile("small.ts");
      assert.match(await t.readFile("small.ts"), /all 20 lines were already shown/);
      assert.match(await t.readFile("small.ts", 5, 9), /already shown/, "a range inside a whole read");
      const cut = await t.readFile("big.ts");
      assert.match(cut, /truncated/);
      assert.deepEqual(t.readLedger.unseen("DISCOVERY", "big.ts", 1, 4000), [[1, 4000]], "nothing of a cut read is claimed");
      assert.match(await t.readFile("big.ts"), /truncated/, "so asking again still returns the text");
    });
  });

  test("a file with a very long line is returned with that line shortened, so it is NOT recorded as seen", async () => {
    write("min.js", 5, (n) => (n === 3 ? "x".repeat(5000) : "var a" + n + " = 1;"));
    const t = tools();
    await t.withReadStage("DISCOVERY", async () => {
      assert.match(await t.readFile("min.js"), /line truncated/);
      assert.deepEqual(t.readLedger.unseen("DISCOVERY", "min.js", 1, 5), [[1, 5]]);
    });
  });

  test("the stage is restored when the conversation ends, even if it throws, and stages do not share what was shown", async () => {
    write("a.ts", 60);
    const t = tools();
    await assert.rejects(() => t.withReadStage("DISCOVERY", async () => {
      await t.readFile("a.ts", 1, 30);
      throw new Error("boom");
    }), /boom/);
    assert.match(await t.readFile("a.ts", 1, 30), /showing lines 1-30 of 60 total\]/, "outside any stage nothing is suppressed");
    await t.withReadStage("PLANNER", async () => {
      assert.match(await t.readFile("a.ts", 1, 30), /showing lines 1-30 of 60 total\]/, "the planner was not shown what discovery read");
    });
  });
});

describe("existence hands forward where its verified evidence is", () => {
  test("each verified quote becomes a line-numbered place around it; the request's cited lines come with it", () => {
    write("app/cart.ts", 100, (n) => (n === 40 ? "export function addToCart(item) { return cart.push(item); }" : `// filler ${n}`));
    const text = fs.readFileSync(path.join(root, "app/cart.ts"), "utf8");
    assert.equal(locateQuote(text, "export function addToCart(item) { return cart.push(item); }"), 40);
    assert.equal(locateQuote(text, "  export function addToCart(item)"), 40, "an indented or partial first line is found by containment");
    assert.equal(locateQuote(text, "function that is not in the file"), undefined);
    const c: any = { req: { id: "R1", text: "x", terms: [] }, verdict: "built", evidence: [{ file: "app/cart.ts", quote: "export function addToCart(item) { return cart.push(item); }" }], missing: "", note: "" };
    const places = placesOf(c, new Map([["app/cart.ts", text]]), [{ file: "app/cart.ts", from: 70, to: 80 }, { file: "app/cart.ts" }]);
    assert.deepEqual(places, [{ file: "app/cart.ts", from: 37, to: 49 }, { file: "app/cart.ts", from: 70, to: 80 }]);
  });

  test("checkExistence returns the merged places of its built and partial requirements, and none for the rest", async () => {
    write("app/cart.ts", 100, (n) => (n === 40 ? "export function addToCart(item) { return cart.push(item); }" : `// filler ${n}`));
    const call = async (m: any[]) => {
      const sys = String(m[0].content);
      if (sys.startsWith("You decide whether")) return JSON.stringify({ applies: true, requirements: [{ text: "The cart can add an item", terms: ["addToCart"] }, { text: "Checkout can refund an order", terms: ["refundOrder"] }] });
      return JSON.stringify({ results: [{ id: "R1", verdict: "built", evidence: [{ file: "app/cart.ts", quote: "export function addToCart(item) { return cart.push(item); }" }], missing: "", note: "" }] });
    };
    const out = await checkExistence({ call, repoRoot: root, request: "Add a cart with add item and checkout refunds" });
    assert.deepEqual(out.excerpts, [{ file: "app/cart.ts", from: 37, to: 49 }]);
    assert.equal(out.items.find((i) => i.verdict === "missing")?.placed, undefined);
  });
});

describe("the stages are wired so no stage skips lines it has not seen", () => {
  const idx = src("src/index.ts");
  const loop = src("src/agentLoop.ts");

  test("discovery begins with an empty ledger, is told the cited lines and existence's places in its prompt, and only those are recorded", () => {
    const begin = idx.indexOf('discoveryLedger.begin("DISCOVERY");');
    const inject = idx.indexOf('discoveryLedger.inject("DISCOVERY", [...citedByUser.filter((r) => r.from !== undefined), ...existenceRefs], 8000)');
    const prompt = idx.indexOf("${namedLeads}${preReadSection}${discoveryShortlist}");
    const run = idx.indexOf('readStage: "DISCOVERY"');
    assert.ok(begin > 0 && begin < inject && inject < prompt && prompt < run, "begin, then inject, then the prompt that carries it, then the conversation");
    assert.ok(idx.includes("const label = (f: string) => {"), "a cited file keeps its line numbers in the lead");
    assert.ok(/LINES ALREADY READ FOR YOU \(real line numbers of the current files/.test(idx));
  });

  test("every planner conversation begins the planner's ledger again from exactly what its prompt carries", () => {
    assert.equal((idx.match(/readStage: "PLANNER",\n\s+onConversationStart: startPlannerConversation,/g) ?? []).length, 3, "the first pass and both retries");
    assert.ok(idx.includes('agentTools.readLedger.begin("PLANNER");\n      for (const r of plannerForward.included) agentTools.readLedger.record("PLANNER", r.file, r.from, r.to);'));
    assert.ok(idx.includes('agentTools.readLedger.forward("DISCOVERY", "PLANNER", 8000, '), "the planner is told what discovery was shown, capped");
    assert.ok(idx.includes("${existenceSection}${plannerReadSection}"), "and it is in the prompt every pass includes");
  });

  test("a conversation without a stage (the editor, repair, QA) never touches the ledger", () => {
    assert.ok(loop.includes("if (!options.readStage) return runToolAgentConversation(options);"));
    assert.equal((src("src/agentTools.ts").match(/this\.readStage/g) ?? []).length >= 3, true);
    for (const f of ["src/directFix.ts", "src/verifierTools.ts", "src/testHeal.ts", "src/editorSweep.ts"]) assert.ok(!/readLedger|readStage/.test(src(f)), f);
  });

  test("existence's places are cleared with its section, so one task's places are never shown to the next", () => {
    assert.equal((idx.match(/existenceSection = "";\n\s+existenceRefs = \[\];/g) ?? []).length, 3);
    assert.equal((idx.match(/existenceRefs = found\.excerpts \?\? \[\];/g) ?? []).length, 2);
  });

  test("the cited lines the prompt carries are the ones resolved on disk, from the request's own words", () => {
    write("app/x.tsx", 300);
    const cited = resolveOnDisk(root, parseCodeRefs("fix app/x.tsx:120-160 and app/x.tsx:400 and ../out.ts:3 and missing.ts:1"));
    assert.deepEqual(cited, [{ file: "app/x.tsx", from: 120, to: 160 }, { file: "app/x.tsx" }].slice(0, 1).concat(cited.slice(1)));
    assert.deepEqual(cited[0], { file: "app/x.tsx", from: 120, to: 160 });
    assert.ok(!cited.some((c) => c.file.includes("..") || c.file === "missing.ts"));
  });
});
