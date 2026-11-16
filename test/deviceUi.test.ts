/**
 * Guards the phone page's embedded JavaScript, which nothing else can catch:
 * it lives inside a template literal, so tsc never parses it as code and a
 * broken line fails silently in the browser at runtime.
 *
 * The bug that motivated this: the bold-span regex was written with single
 * backslashes before its asterisks. A template literal drops the backslash on
 * any escape it doesn't recognize, so the emitted regex began with an
 * unescaped asterisk — which the parser read as a block comment instead,
 * leaving a bare `esc.replace(g,…)` behind. Every activity-log row threw, so
 * the phone's feed rendered permanently blank while the connection itself
 * looked perfectly healthy.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { DEVICE_PAGE } from "../src/remote/ui.js";

const scriptBody = (): string => {
  const m = DEVICE_PAGE.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "device page should contain exactly one inline script");
  return m[1];
};

describe("device page embedded script", () => {
  test("parses as valid JavaScript", () => {
    assert.doesNotThrow(() => new Function(scriptBody()));
  });

  test("no regex was mangled into a block comment", () => {
    // `replace(/*` is never legitimate: it means a regex literal started with
    // an unescaped `*`, which the parser reads as a comment instead.
    assert.doesNotMatch(scriptBody(), /\(\/\*/);
  });

  test("every backslash escape in the source survives into the emitted JS", () => {
    // Catches the whole class, not just the ones that form comments: \d, \s,
    // \[ and friends all silently lose their backslash the same way, quietly
    // changing what a regex matches instead of throwing.
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "..", "src", "remote", "ui.ts"), "utf8");
    const body = src.slice(src.indexOf("<script>"), src.indexOf("</script>"));
    const recognized = new Set(["n", "t", "r", "\\", "`", "$", "u", "x", "0", "'", '"']);

    const offenders: string[] = [];
    body.split("\n").forEach((line, i) => {
      for (let c = 0; c < line.length - 1; c++) {
        if (line[c] !== "\\") continue;
        if (line[c + 1] === "\\") { c++; continue; }
        if (recognized.has(line[c + 1])) continue;
        offenders.push(`line ${i + 1}: \\${line[c + 1]} in ${line.trim().slice(0, 70)}`);
      }
    });

    assert.deepEqual(offenders, [], `single-backslash escape(s) will be eaten:\n${offenders.join("\n")}`);
  });
});

/** Pulls the renderer out of the embedded script so it can be exercised in Node. */
function loadRichTextToHtml(): (s: string) => string {
  const js = scriptBody();
  const slice = js.slice(js.indexOf("function escapeHtml"), js.indexOf("function ingestRemote"));
  return new Function(`${slice.replace(/\/\*\*[\s\S]*?\*\//g, "")}; return richTextToHtml;`)();
}

describe("phone richTextToHtml", () => {
  test("renders a **bold** span", () => {
    assert.equal(loadRichTextToHtml()("**Verdict: FAIL**"), "<b>Verdict: FAIL</b>");
  });

  test("renders a backtick code span", () => {
    assert.equal(loadRichTextToHtml()("see `Chicken.kt`"), "see <code>Chicken.kt</code>");
  });

  test("escapes HTML before applying any markup", () => {
    // innerHTML is what consumes this, so a log line quoting source must never
    // be able to inject a tag.
    assert.equal(loadRichTextToHtml()("<script>x</script> & y"), "&lt;script&gt;x&lt;/script&gt; &amp; y");
  });

  test("leaves plain text untouched", () => {
    assert.equal(loadRichTextToHtml()("no markers here"), "no markers here");
  });

  test("highlights a source file even when it was not backticked", () => {
    const out = loadRichTextToHtml()("both behaviors in RaceSimulation.kt: rivals now receive mutations");
    assert.match(out, /<code>RaceSimulation\.kt<\/code>/);
  });

  test("highlights a full path", () => {
    const out = loadRichTextToHtml()("read app/src/main/java/com/yimpim/Chicken.kt first");
    assert.match(out, /<code>app\/src\/main\/java\/com\/yimpim\/Chicken\.kt<\/code>/);
  });

  test("does not mistake a model version for a file", () => {
    // ".8-flash" and friends would match a loose extension pattern; this is
    // the single most common line in the whole feed, so a false <code> here
    // would be everywhere.
    assert.equal(loadRichTextToHtml()("[API] google/gemini-3.8-flash"), "[API] google/gemini-3.8-flash");
  });

  test("does not mistake a hostname for a file", () => {
    const host = "open https://blaptop.tail6ca50.ts.net now";
    assert.equal(loadRichTextToHtml()(host), host);
  });

  test("never rewrites the inside of an explicit backtick span", () => {
    // The auto-highlighter must not run over text that is already a span, or
    // over the tags it just produced.
    assert.equal(loadRichTextToHtml()("`a.kt`"), "<code>a.kt</code>");
  });
});

/**
 * Runs the real page under a minimal stub DOM so ingestRemote's row-building
 * logic — separators, path shortening, diff-stat coloring — is exercised the
 * same way a phone actually would, not just re-derived from the source text.
 */
function loadPage(): {
  ingestRemote: (raw: string, level?: string) => void;
  handleEvent: (ev: any) => void;
  openDiff: (changeId: string, path?: string) => void;
  openModelModal: () => void;
  rows: () => any[];
  renderLog: () => void;
  logNode: () => any;
  node: (id: string) => any;
} {
  let js = scriptBody();
  const marker = js.lastIndexOf("})();");
  js =
    js.slice(0, marker) +
    "globalThis.__t={ingestRemote:ingestRemote,handleEvent:handleEvent,openDiff:openDiff," +
    "openModelModal:openModelModal,rowsRef:function(){return rows},renderLog:renderLog};\n" +
    js.slice(marker);

  const stubEl = () => {
    const el: any = {
      _children: [] as any[],
      className: "",
      textContent: "",
      value: "",
      placeholder: "",
      disabled: false,
      scrollHeight: 100,
      scrollTop: 0,
      clientHeight: 100,
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(c: any) { this._children.push(c); return c; },
      addEventListener() {},
      focus() {},
      click() {},
    };
    let innerHTML = "";
    // A real innerHTML setter always clears whatever children were built via
    // appendChild — renderLog() relies on exactly this ('el.innerHTML=""'
    // before rebuilding the row list from scratch) to avoid appending onto
    // stale DOM from a previous render.
    Object.defineProperty(el, "innerHTML", {
      get: () => innerHTML,
      set: (v: string) => { innerHTML = v; el._children = []; },
    });
    return el;
  };
  const nodes: Record<string, any> = {};
  (globalThis as any).document = {
    getElementById: (id: string) => (nodes[id] ||= stubEl()),
    createElement: () => stubEl(),
    addEventListener() {},
    hidden: false,
  };
  (globalThis as any).location = { hash: "#1.s_test.p_test.a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5", origin: "https://x" };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  // Node 22+ ships its own read-only `navigator` accessor (no setter) — same
  // issue as `crypto` below, plain assignment throws in an ES module (always
  // strict mode), so it needs defineProperty too.
  Object.defineProperty(globalThis, "navigator", { value: { platform: "test" }, configurable: true });
  (globalThis as any).fetch = () => new Promise(() => {});
  (globalThis as any).AbortSignal = { timeout: () => ({}) };
  (globalThis as any).btoa = (s: string) => Buffer.from(s, "binary").toString("base64");
  (globalThis as any).atob = (s: string) => Buffer.from(s, "base64").toString("binary");
  // Node's global `crypto` is a read-only accessor — plain assignment throws.
  Object.defineProperty(globalThis, "crypto", {
    value: {
      // Both left permanently pending (never resolving), same as the real
      // page's own key setup while the QR-code pairing handshake is still in
      // flight — enough for openDiff/send to reach their pre-network side
      // effects (title/loading text) without ever needing an actual reply.
      subtle: { importKey: () => new Promise(() => {}), encrypt: () => new Promise(() => {}) },
      getRandomValues: (a: any) => a,
    },
    configurable: true,
  });
  (globalThis as any).confirm = () => true;
  (globalThis as any).history = { replaceState() {} };
  (globalThis as any).window = globalThis;

  new Function(js)();
  const t = (globalThis as any).__t;
  return {
    ingestRemote: t.ingestRemote,
    handleEvent: t.handleEvent,
    openDiff: t.openDiff,
    openModelModal: t.openModelModal,
    rows: t.rowsRef,
    renderLog: t.renderLog,
    logNode: () => nodes["log"],
    node: (id: string) => (nodes[id] ||= stubEl()),
  };
}

describe("phone ingestRemote", () => {
  test("a run of # (phase banners) collapses into one rule row", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote("#".repeat(50), "log");
    ingestRemote("### PHASE 1/2: **Rescue Domain Model**", "log");
    ingestRemote("#".repeat(50), "log");
    ingestRemote("#".repeat(50), "log"); // consecutive — should collapse with the one above
    const kinds = rows().map((r: any) => (r.rule ? "<hr>" : "row"));
    assert.deepEqual(kinds, ["<hr>", "row", "<hr>"]);
  });

  test("a run of = or - also collapses into a rule row", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote("=".repeat(58), "log");
    assert.equal(rows()[0].rule, true);
  });

  test("a patched file's path is shortened to its immediate folder and filename", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote(
      "[EDITOR] patched app/src/main/java/com/yimpim/mutantchickenracers/data/GameRepository.kt  +13 -0",
      "log"
    );
    const row = rows()[0];
    assert.equal(row.summary, "Patched data/GameRepository.kt  +13 -0");
    assert.doesNotMatch(row.html, /app\/src\/main/);
  });

  test("the token-usage table adds a Cost column when the desktop line includes one", () => {
    const { ingestRemote, rows } = loadPage();
    const usage = [
      "",
      "Token usage for this task (use this to check whether model tiering is paying off):",
      "  EDITOR      47 calls    2.6M tokens  $1.9421",
      "  TOTAL       47 calls    2.6M tokens  $1.9421",
      "",
    ].join("\n");
    ingestRemote(usage, "log");
    const html = rows()[0].bodyHtml;
    assert.match(html, /<th>Cost<\/th>/);
    assert.match(html, /<td>\$1\.9421<\/td>/);
  });

  test("the token-usage table omits the Cost column entirely when no line has one", () => {
    const { ingestRemote, rows } = loadPage();
    const usage = [
      "",
      "Token usage for this task (use this to check whether model tiering is paying off):",
      "  EDITOR      47 calls    2.6M tokens",
      "  TOTAL       47 calls    2.6M tokens",
      "",
    ].join("\n");
    ingestRemote(usage, "log");
    assert.doesNotMatch(rows()[0].bodyHtml, /Cost/);
  });

  test("a patched file's diff stat is colored: + green (diff-add), - red (diff-del)", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote("[EDITOR] patched app/src/main/GameRepository.kt  +13 -2", "log");
    const html = rows()[0].html;
    assert.match(html, /<span class="diff-add">\+13<\/span>/);
    assert.match(html, /<span class="diff-del">-2<\/span>/);
  });

  test("an in-progress edit upgrades to the colored patched row in place, not as a second row", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote("[EDITOR] Patching file: app/src/main/GameRepository.kt...", "log");
    ingestRemote("[EDITOR] patched app/src/main/GameRepository.kt  +13 -0", "log");
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].status, "done");
    assert.match(rows()[0].html, /diff-add/);
  });

  test("a short path (no nested folder) is left as-is", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote("[EDITOR] patched build.gradle  +2 -0", "log");
    assert.match(rows()[0].summary, /Patched build\.gradle  \+2 -0/);
  });

  test("the token-usage block renders as a table, including the leading blank line", () => {
    const { ingestRemote, rows } = loadPage();
    // Exact shape events.ts's renderUsage produces — a leading blank line
    // before the header is what broke the header match (^ needs the m flag
    // to find a line that isn't at position 0 of the string).
    const usage = [
      "",
      "Token usage for this task (use this to check whether model tiering is paying off):",
      "  EDITOR      47 calls    2.6M tokens",
      "  DISCOVERY   14 calls  704.7k tokens",
      "  TOTAL       61 calls    3.3M tokens",
      "",
    ].join("\n");
    ingestRemote(usage, "log");
    const row = rows()[0];
    assert.match(row.summary, /Token usage/);
    assert.match(row.bodyHtml, /<table class="usage-table">/);
    assert.match(row.bodyHtml, /<td>EDITOR<\/td><td>47<\/td><td>2\.6M<\/td>/);
    assert.match(row.bodyHtml, /class="usage-total"[^>]*><td>TOTAL<\/td>/);
  });

  test("a multi-line conclude_task explanation splits into a summary plus per-line detail", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote(
      "[AGENT EXIT] Reason: Implemented phase 2/2 across MarketViewModel.kt.\n" +
        "- Added RescueCooldown data class.\n" +
        "- Added adoptRescueChicken rejection.",
      "log"
    );
    const row = rows()[0];
    assert.equal(row.summary, "[AGENT EXIT] Reason: Implemented phase 2/2 across MarketViewModel.kt.");
    assert.deepEqual(row.detail, ["- Added RescueCooldown data class.", "- Added adoptRescueChicken rejection."]);
    assert.equal(row.expanded, true); // this line IS the content, not supplementary detail
  });

  test("a single-line message is not turned into an expandable row", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote("[GIT] Nothing left to commit.", "log");
    assert.equal(rows()[0].expandable, false);
  });

  test("an Advisor answer splits its markdown headers, rules, and lists into distinct lines", () => {
    const { ingestRemote, rows } = loadPage();
    const advisor = [
      "**Yes, absolutely.** This is the best feature to add.",
      "",
      "---",
      "",
      "### 1. Why we need this",
      "",
      '1. **The Gap:** the player has no place to inspect their flock, per `RivalFarm.kt`.',
    ].join("\n");
    ingestRemote(advisor, "log");
    const row = rows()[0];
    assert.equal(row.summary, "**Yes, absolutely.** This is the best feature to add.");
    assert.deepEqual(row.detail, ["---", "### 1. Why we need this", "1. **The Gap:** the player has no place to inspect their flock, per `RivalFarm.kt`."]);
  });

  test("expanding that row renders the embedded rule as <hr> and the heading as bold", () => {
    const { ingestRemote, rows, renderLog, logNode } = loadPage();
    ingestRemote(["Intro line.", "", "---", "", "### A Heading", "plain follow-up line."].join("\n"), "log");
    const row = rows()[0];
    assert.equal(row.expanded, true); // already expanded by default — no need to toggle
    renderLog();
    const rowDiv = logNode()._children[logNode()._children.length - 1];
    const body = rowDiv._children.find((c: any) => c.className === "logrow-body");
    assert.equal(body._children[0].className, "logrule");
    assert.equal(body._children[1].className, "dline dline-head");
    assert.equal(body._children[1].innerHTML, "<b>A Heading</b>");
    assert.equal(body._children[2].className, "dline");
    assert.equal(body._children[2].innerHTML, "plain follow-up line.");
  });
});

describe("phone ingestRemote — lookup grouping", () => {
  test("consecutive read/search/scan/outline lines collapse into one readable summary row", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote("[EDITOR] Read file: Chicken.kt → 120 lines", "log");
    ingestRemote('[EDITOR] Searched code with pattern: "fun feed" → 3 matches', "log");
    ingestRemote("[EDITOR] Scanned directory: src/data → 8 entries", "log");
    ingestRemote("[EDITOR] Outlined declarations in: Farm.kt → 5 declarations", "log");
    ingestRemote("[EDITOR] some unrelated line that ends the group", "log");
    const group = rows()[0];
    assert.equal(group.summary, "Read 1 file, searched 1 pattern, scanned 1 directory, outlined 1 file");
    assert.equal(group.expandable, true);
    assert.equal(group.detail.length, 4);
  });

  test("a batched multi-file read and multi-pattern search count every item, not just the call", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote("[DISCOVERY] Read 3 file(s): A.kt, B.kt, C.kt → 400 lines", "log");
    ingestRemote('[DISCOVERY] Searched code with pattern: "foo", "bar" → 6 matches', "log");
    ingestRemote("[DISCOVERY] closing line", "log");
    assert.equal(rows()[0].summary, "Read 3 files, searched 2 patterns");
  });

  test("a lone lookup line still renders as a proper sentence, not the old bare '1 lookup' fallback", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote("[QA] Read file: Chicken.kt → 120 lines", "log");
    ingestRemote("[QA] closing line", "log");
    assert.equal(rows()[0].summary, "Read 1 file");
  });

  test("the expanded detail keeps each line's own quick-result suffix, not just the action", () => {
    const { ingestRemote, rows } = loadPage();
    ingestRemote("[EDITOR] Read file: Chicken.kt → 120 lines", "log");
    ingestRemote("[EDITOR] closing line", "log");
    assert.deepEqual(rows()[0].detail, ["Read file: Chicken.kt → 120 lines"]);
  });
});

describe("phone handleEvent — phase/agent grouping and diff correlation", () => {
  test("phase.start adds a collapsible phase header row", () => {
    const { handleEvent, rows } = loadPage();
    handleEvent({ kind: "phase.start", phaseId: "p1", name: "Rescue Domain Model", index: 0, total: 2 });
    const row = rows()[0];
    assert.equal(row.phaseHeader, true);
    assert.equal(row.phaseId, "p1");
    assert.match(row.summary, /Phase 1\/2/);
    assert.match(row.summary, /Rescue Domain Model/);
  });

  test("the phase header renders the phase's own goal text as a dimmer sub-line, for free 'why' context", () => {
    const { handleEvent, renderLog, logNode } = loadPage();
    handleEvent({
      kind: "phase.start",
      phaseId: "p1",
      name: "Persistence Layer",
      goal: "Add persistence for favorited chickens across app restarts",
      index: 0,
      total: 1,
    });
    renderLog();
    const headerHead = logNode()._children[0]._children[0];
    assert.match(headerHead.innerHTML, /phasehead-goal/);
    assert.match(headerHead.innerHTML, /Add persistence for favorited chickens across app restarts/);
  });

  test("worker.start for a new agent within the current phase adds one agent header, not a new phase header", () => {
    const { handleEvent, rows } = loadPage();
    handleEvent({ kind: "phase.start", phaseId: "p1", name: "Setup", index: 0, total: 1 });
    handleEvent({ kind: "worker.start", agent: "EDITOR", phaseId: "p1", phaseName: "Setup" });
    const kinds = rows().map((r: any) => (r.phaseHeader ? "phase" : r.agentHeader ? "agent" : "row"));
    assert.deepEqual(kinds, ["phase", "agent"]);
  });

  test("a second worker.start for the same agent adds no additional header", () => {
    const { handleEvent, rows } = loadPage();
    handleEvent({ kind: "phase.start", phaseId: "p1", name: "Setup", index: 0, total: 1 });
    handleEvent({ kind: "worker.start", agent: "EDITOR", phaseId: "p1", phaseName: "Setup" });
    handleEvent({ kind: "worker.start", agent: "EDITOR", phaseId: "p1", phaseName: "Setup" });
    assert.equal(rows().length, 2);
  });

  test("worker.start for a phaseId not seen yet still adds its own phase header (a client joining mid-phase)", () => {
    const { handleEvent, rows } = loadPage();
    handleEvent({ kind: "worker.start", agent: "QA", phaseId: "p3", phaseName: "Repair pass" });
    assert.equal(rows()[0].phaseHeader, true);
    assert.equal(rows()[0].summary, "Repair pass");
  });

  test("phase.end and worker.end add no row of their own", () => {
    const { handleEvent, rows } = loadPage();
    handleEvent({ kind: "phase.start", phaseId: "p1", name: "Setup", index: 0, total: 1 });
    handleEvent({ kind: "worker.start", agent: "EDITOR", phaseId: "p1", phaseName: "Setup" });
    handleEvent({ kind: "worker.end", agent: "EDITOR", outcome: "completed" });
    handleEvent({ kind: "phase.end", phaseId: "p1", name: "Setup", passed: true, attempts: 1 });
    assert.equal(rows().length, 2); // just the phase header and the agent header
  });

  test("tapping a collapsed phase header hides everything belonging to that phase on the next render", () => {
    const { handleEvent, renderLog, logNode } = loadPage();
    handleEvent({ kind: "phase.start", phaseId: "p1", name: "Setup", index: 0, total: 1 });
    handleEvent({ kind: "worker.start", agent: "EDITOR", phaseId: "p1", phaseName: "Setup" });
    renderLog();
    assert.equal(logNode()._children.length, 2); // phase header + agent header, both visible

    const headerHead = logNode()._children[0]._children[0];
    headerHead.onclick(); // toggles collapsed and re-renders
    assert.equal(logNode()._children.length, 1); // only the header itself remains
  });

  test("a file.changed event attaches its changeId to the matching patched row and adds a 'view diff' hint", () => {
    const { ingestRemote, handleEvent, rows } = loadPage();
    ingestRemote("[EDITOR] patched app/src/main/GameRepository.kt  +13 -2", "log");
    handleEvent({
      kind: "file.changed",
      agent: "EDITOR",
      path: "app/src/main/GameRepository.kt",
      action: "modified",
      added: 13,
      removed: 2,
      changeId: "chg-1",
    });
    const row = rows()[0];
    assert.equal(row.diffChangeId, "chg-1");
    assert.match(row.html, /diffhint/);
  });

  test("a file.changed event for a path with no matching patch row is silently ignored", () => {
    const { handleEvent, rows } = loadPage();
    assert.doesNotThrow(() =>
      handleEvent({ kind: "file.changed", agent: "EDITOR", path: "unknown.kt", action: "modified", added: 1, removed: 0, changeId: "chg-x" })
    );
    assert.equal(rows().length, 0);
  });
});

describe("phone diff viewer", () => {
  test("openDiff shows the title and a loading state before any reply arrives", () => {
    const { openDiff, node } = loadPage();
    openDiff("chg-1", "src/foo.ts");
    assert.equal(node("diffTitle").textContent, "src/foo.ts");
    assert.equal(node("diffBody").textContent, "Loading diff…");
  });

  test("a diff.chunk reassembled from base64 renders colored add/remove/context lines", () => {
    const { openDiff, handleEvent, node } = loadPage();
    openDiff("chg-1", "src/foo.ts");
    const text = "  const x = 1;\n- const y = 2;\n+ const y = 3;";
    const data = Buffer.from(text, "utf-8").toString("base64");
    handleEvent({ kind: "diff.chunk", changeId: "chg-1", path: "src/foo.ts", seq: 0, total: 1, data });
    const body = node("diffBody");
    assert.equal(body._children.length, 3);
    assert.equal(body._children[0].className, "diffline-ctx");
    assert.equal(body._children[1].className, "diffline-del");
    assert.equal(body._children[2].className, "diffline-add");
  });

  test("a diff.chunk for a changeId the modal is no longer waiting on is ignored", () => {
    const { openDiff, handleEvent, node } = loadPage();
    openDiff("chg-1", "src/foo.ts");
    openDiff("chg-2", "src/bar.ts"); // supersedes chg-1 as the pending request
    const data = Buffer.from("+ stale", "utf-8").toString("base64");
    handleEvent({ kind: "diff.chunk", changeId: "chg-1", path: "src/foo.ts", seq: 0, total: 1, data });
    assert.equal(node("diffBody").textContent, "Loading diff…"); // unchanged — still waiting on chg-2
  });

  test("diff.unavailable for the pending request shows an explanatory message", () => {
    const { openDiff, handleEvent, node } = loadPage();
    openDiff("chg-1", "src/foo.ts");
    handleEvent({ kind: "diff.unavailable", changeId: "chg-1", reason: "evicted" });
    assert.equal(node("diffBody").textContent, "This change is no longer available.");
  });
});

/** Pulls the pure cost/context formatter out of the model wizard so it can be exercised directly. */
function loadFormatModelMeta(): (m: any) => string {
  const js = scriptBody();
  const slice = js.slice(js.indexOf("function formatModelMeta"), js.indexOf("function addModelBackButton"));
  return new Function(`${slice.replace(/\/\*\*[\s\S]*?\*\//g, "")}; return formatModelMeta;`)();
}

describe("phone formatModelMeta", () => {
  test("shows a per-million-token $ price and context length for a normally-priced model", () => {
    const out = loadFormatModelMeta()({
      isVariablePrice: false,
      isFree: false,
      pricing: { promptPerM: 0.15, completionPerM: 0.6 },
      contextLength: 128000,
    });
    assert.equal(out, "$0.15/$0.60 per M in/out, 128k ctx");
  });

  test("shows 'free' instead of a $ figure", () => {
    const out = loadFormatModelMeta()({ isVariablePrice: false, isFree: true, pricing: null, contextLength: 32000 });
    assert.equal(out, "free, 32k ctx");
  });

  test("shows 'variable price' instead of a $ figure", () => {
    const out = loadFormatModelMeta()({ isVariablePrice: true, isFree: false, pricing: null, contextLength: 8000 });
    assert.equal(out, "variable price, 8k ctx");
  });

  test("context length under 1000 is shown as a raw token count, not '0k'", () => {
    const out = loadFormatModelMeta()({
      isVariablePrice: false,
      isFree: false,
      pricing: { promptPerM: 1, completionPerM: 2 },
      contextLength: 512,
    });
    assert.match(out, /512 ctx$/);
  });
});

const ROLE_CONFIG = [
  { role: "discovery", chain: ["anthropic/claude-3.5-sonnet"] },
  { role: "discoveryVision", chain: [] },
  { role: "planner", chain: ["anthropic/claude-3.5-sonnet"] },
  { role: "editor", chain: ["anthropic/claude-3.5-sonnet", "openai/gpt-4o"] },
  { role: "editorVision", chain: ["openai/gpt-4o"] },
  { role: "repair", chain: [] },
  { role: "repairVision", chain: [] },
  { role: "verifier", chain: ["google/gemini-3.8-flash"] },
  { role: "verifierVision", chain: [] },
];

const SAMPLE_MODELS = [
  {
    id: "openai/gpt-4o-mini",
    pricing: { promptPerM: 0.15, completionPerM: 0.6 },
    isFree: false,
    isVariablePrice: false,
    contextLength: 128000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: "some/free-model",
    pricing: null,
    isFree: true,
    isVariablePrice: false,
    contextLength: 32000,
    supportsVision: true,
    supportsTools: true,
  },
];

describe("phone model settings wizard", () => {
  test("shows a loading state, then all 9 roles with their current chains once model.config arrives", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    assert.equal(node("modelBody").textContent, "Loading…");

    handleEvent({ kind: "model.config", roles: ROLE_CONFIG, scope: "project" });
    const rows = node("modelBody")._children;
    assert.equal(rows.length, 9);
    // Discovery: has a chain -> shown joined. VerifierVision: empty -> "not set".
    assert.equal(rows[0]._children[0].textContent, "Discovery");
    assert.equal(rows[0]._children[1].textContent, "anthropic/claude-3.5-sonnet");
    assert.equal(rows[8]._children[1].textContent, "not set");
  });

  test("tapping a role opens the primary picker: loading, then candidates once model.catalog arrives", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: ROLE_CONFIG, scope: "project" });
    const editorRow = node("modelBody")._children[3]; // editor
    editorRow.onclick();
    assert.equal(node("modelTitle").textContent, "Editor — primary");
    assert.equal(node("modelBody").textContent, "Loading models…");

    handleEvent({ kind: "model.catalog", role: "editor", models: SAMPLE_MODELS });
    // search input + the results list is the second child of modelBody.
    const list = node("modelBody")._children[1];
    assert.equal(list._children.length, 2);
    assert.equal(list._children[0]._children[0].textContent, "openai/gpt-4o-mini");
    assert.equal(list._children[1]._children[1].textContent, "free, 32k ctx");
  });

  test("a model.catalog for a role the wizard is no longer viewing is ignored", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: ROLE_CONFIG, scope: "project" });
    node("modelBody")._children[3].onclick(); // opens editor's primary picker
    handleEvent({ kind: "model.catalog", role: "verifier", models: SAMPLE_MODELS }); // stale/unrelated
    assert.equal(node("modelBody").textContent, "Loading models…"); // unchanged
  });

  test("picking a primary opens the backup picker, offering a 'No backup' option", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: ROLE_CONFIG, scope: "project" });
    node("modelBody")._children[3].onclick(); // editor
    handleEvent({ kind: "model.catalog", role: "editor", models: SAMPLE_MODELS });
    node("modelBody")._children[1]._children[0].onclick(); // pick openai/gpt-4o-mini as primary

    assert.equal(node("modelTitle").textContent, "Editor — backup");
    handleEvent({ kind: "model.catalog", role: "editor", models: SAMPLE_MODELS });
    const list = node("modelBody")._children[1];
    assert.equal(list._children[0]._children[0].textContent, "No backup");
  });

  test("an Unset option appears for an optional vision role that already has a chain, and submitting shows Saving…", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: ROLE_CONFIG, scope: "project" });
    node("modelBody")._children[4].onclick(); // editorVision — optional, has a chain
    handleEvent({ kind: "model.catalog", role: "editorVision", models: SAMPLE_MODELS });

    const list = node("modelBody")._children[1];
    assert.equal(list._children[0]._children[0].textContent, "Unset");
    list._children[0].onclick();
    assert.equal(node("modelBody").textContent, "Saving…");
  });

  test("no Unset option for a required role, even with a chain already set", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: ROLE_CONFIG, scope: "project" });
    node("modelBody")._children[3].onclick(); // editor — required
    handleEvent({ kind: "model.catalog", role: "editor", models: SAMPLE_MODELS });
    const list = node("modelBody")._children[1];
    assert.equal(list._children[0]._children[0].textContent, "openai/gpt-4o-mini"); // straight to candidates
  });

  test("model.catalog_unavailable shows the reason and a way back", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: ROLE_CONFIG, scope: "project" });
    node("modelBody")._children[3].onclick();
    handleEvent({ kind: "model.catalog_unavailable", role: "editor", reason: "No API key configured." });
    assert.equal(node("modelBody")._children[0].textContent, "No API key configured.");
  });

  test("a set_model command.refused while the wizard is open shows the reason inline, not the composer-restore path", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: ROLE_CONFIG, scope: "project" });
    node("modelBody")._children[3].onclick();
    handleEvent({
      kind: "command.refused",
      verb: "set_model",
      reason: "Can't change models while a task is running.",
    });
    assert.equal(node("modelBody")._children[0].textContent, "Can't change models while a task is running.");
  });

  test("a fresh model.config after a successful set_model returns the wizard to the role list", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: ROLE_CONFIG, scope: "project" });
    node("modelBody")._children[3].onclick(); // now on the primary picker

    const updated = ROLE_CONFIG.map((r) =>
      r.role === "editor" ? { role: "editor", chain: ["openai/gpt-4o-mini"] } : r
    );
    handleEvent({ kind: "model.config", roles: updated, scope: "project" });

    assert.equal(node("modelTitle").textContent, "Model Settings");
    const rows = node("modelBody")._children;
    assert.equal(rows.length, 9);
    assert.equal(rows[3]._children[1].textContent, "openai/gpt-4o-mini");
  });
});

describe("phone handleEvent — the prompt that started a task", () => {
  test("task.start shows what was asked, so a desktop-typed prompt is not invisible", () => {
    const { handleEvent, rows } = loadPage();
    handleEvent({ kind: "task.start", taskId: "t1", runId: "r1", prompt: "Add a dark mode toggle", attachments: [] });
    assert.equal(rows().length, 1);
    assert.match(rows()[0].summary, /You:\*\* Add a dark mode toggle/);
    assert.equal(rows()[0].expandable, false);
  });

  test("a multi-line prompt keeps the first line as the summary and the rest as expandable detail", () => {
    const { handleEvent, rows } = loadPage();
    handleEvent({ kind: "task.start", taskId: "t1", runId: "r1", prompt: "Fix the timeline\nstep one\nstep two", attachments: ["a.png"] });
    const r = rows()[0];
    assert.match(r.summary, /Fix the timeline/);
    assert.match(r.summary, /1 attached/);
    assert.deepEqual(r.detail, ["step one", "step two"]);
    assert.equal(r.expandable, true);
  });

  test("an empty prompt adds no row", () => {
    const { handleEvent, rows } = loadPage();
    handleEvent({ kind: "task.start", taskId: "t1", runId: "r1", prompt: "   ", attachments: [] });
    assert.equal(rows().length, 0);
  });
});

const INFO = [
  { role: "editor", label: "Editor", blurb: "Writes code.", optional: false, multi: null, needsTools: true, needsVision: false, volume: "high" },
  { role: "designer", label: "Logo designer", blurb: "Propose and draw.", optional: true, multi: { min: 1, max: 3 }, needsTools: false, needsVision: false, volume: "low" },
  { role: "security", label: "Security", blurb: "Frontier model.", optional: true, multi: null, needsTools: false, needsVision: false, volume: "low" },
  { role: "futureRole", label: "A role added later", blurb: "", optional: true, multi: null, needsTools: false, needsVision: false, volume: "low" },
];
const CONFIG_WITH_INFO = [
  { role: "editor", chain: ["a/editor"] },
  { role: "designer", chain: ["x/one", "y/two"] },
  { role: "security", chain: [] },
  { role: "futureRole", chain: [] },
];

describe("phone model settings wizard: roles described by the desktop", () => {
  test("when the desktop sends roleInfo the role list is built from it, including a role this page has never heard of", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: CONFIG_WITH_INFO, scope: "global", roleInfo: INFO });
    const rows = node("modelBody")._children;
    assert.deepEqual(rows.map((r: any) => r._children[0].textContent), ["Editor", "Logo designer (set)", "Security", "A role added later"]);
    assert.equal(rows[1]._children[1].textContent, "x/one  →  y/two");
    assert.equal(rows[2]._children[1].textContent, "not set");
  });
  test("a role that takes a set opens a multi-select: tapping adds and removes, the summary counts, Save sends the whole set", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: CONFIG_WITH_INFO, scope: "global", roleInfo: INFO });
    node("modelBody")._children[1].onclick(); // designer
    assert.equal(node("modelTitle").textContent, "Logo designer");
    handleEvent({ kind: "model.catalog", role: "designer", models: SAMPLE_MODELS });
    const body = node("modelBody")._children;
    // blurb, summary, Save, Unset (it has a chain and is optional), search, list, back
    assert.equal(body[1]._children[0].textContent, "Selected 2 of up to 3");
    assert.equal(body[1]._children[1].textContent, "x/one, y/two");
    const list = body.find((c: any) => c.className !== "suggest-item" && c._children && c._children.length === 2 && c._children[0]._children[0]?.textContent?.includes("gpt-4o-mini"));
    assert.ok(list, "the candidate list is there");
    list._children[0].onclick(); // add openai/gpt-4o-mini: now 3 of 3
    assert.equal(node("modelBody")._children[1]._children[0].textContent, "Selected 3 of up to 3");
    assert.equal(list._children[0]._children[0].textContent, "✓ openai/gpt-4o-mini");
    list._children[1].onclick(); // at the maximum: a fourth is not added
    assert.equal(node("modelBody")._children[1]._children[0].textContent, "Selected 3 of up to 3");
    list._children[0].onclick(); // tap again: removed
    assert.equal(node("modelBody")._children[1]._children[0].textContent, "Selected 2 of up to 3");
  });
  test("Save in a multi-select persists the set through set_model, and Unset clears an optional role", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: CONFIG_WITH_INFO, scope: "global", roleInfo: INFO });
    node("modelBody")._children[1].onclick();
    handleEvent({ kind: "model.catalog", role: "designer", models: SAMPLE_MODELS });
    const buttons = node("modelBody")._children.filter((c: any) => c.className === "modelback");
    assert.equal(buttons[0].textContent, "Save");
    assert.equal(buttons[1].textContent, "Unset (back to default)");
    buttons[0].onclick();
    assert.equal(node("modelBody").textContent, "Saving…");
  });
  test("a catalog for a multi-select role is accepted, and one for another role is ignored", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: CONFIG_WITH_INFO, scope: "global", roleInfo: INFO });
    node("modelBody")._children[1].onclick();
    handleEvent({ kind: "model.catalog", role: "security", models: SAMPLE_MODELS });
    assert.equal(node("modelBody").textContent, "Loading models…");
  });
  test("an older desktop that sends no roleInfo still gets the nine fixed roles", () => {
    const { openModelModal, handleEvent, node } = loadPage();
    openModelModal();
    handleEvent({ kind: "model.config", roles: ROLE_CONFIG, scope: "project" });
    assert.equal(node("modelBody")._children.length, 9);
  });
});
