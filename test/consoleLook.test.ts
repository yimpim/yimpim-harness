import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { terminalView, setVerbose, setStatusAvailable, plainTagEmoji, wrapForTerminal, visibleWidth } from "../src/consoleView.js";
import { colorizeRoleTag, stripAnsi } from "../src/richText.js";
import { trackCall, describeLiveCalls, liveCallCount, composeStatus, dots, resetStep } from "../src/liveCalls.js";

afterEach(() => {
  setVerbose(false);
  setStatusAvailable(() => false);
  resetStep();
});
const view = (s: string): string => (terminalView("log", [s]) as string[])[0];

describe("the tag says who is speaking, on the terminal only", () => {
  test("a failed or retried call is shown under its persona, with the short model name", () => {
    assert.equal(view("[API] deepseek/deepseek-v4.1-flash-1017 (REPAIR) ❌ (3.0s)"), "[REPAIR] deepseek-v4.1-flash-1017 ❌ (3.0s)");
    assert.equal(view("[API] openai/gpt-6-luna (REPAIR_PLANNER) (retry 2/3) ✔ (4.0s)"), "[REPAIR_PLANNER] gpt-6-luna (retry 2/3) ✔ (4.0s)");
  });
  test("a leading blank line stays where it was", () => {
    assert.equal(view("\n[API] a/b (EDITOR) ❌ (1.0s)"), "\n[EDITOR] b ❌ (1.0s)");
  });
  test("the phone is not touched: terminalView only ever changes what is drawn, and its source line is passed in unchanged", () => {
    const raw = "[API] deepseek/x (REPAIR) ❌ (3.0s)";
    const args = [raw];
    terminalView("log", args);
    assert.equal(args[0], raw);
  });
});

describe("a slow call is one live status line, not a line every 20 seconds", () => {
  test("with a live status line the 'still waiting' lines are not drawn at all", () => {
    setStatusAvailable(() => true);
    for (const s of [20, 60, 120]) assert.equal(terminalView("log", [`[API] Still waiting on deepseek/x (REPAIR) — ${s}s elapsed`]), null);
  });
  test("without one, it is said once a minute under the persona", () => {
    assert.equal(terminalView("log", ["[API] Still waiting on deepseek/x (REPAIR) — 40s elapsed"]), null);
    assert.equal(view("[API] Still waiting on deepseek/x (REPAIR) — 60s elapsed"), "[REPAIR] x is still working — 60s");
  });
});

describe("decorative emoji next to a tag are dropped, meaningful ones stay", () => {
  test("before and after the tag", () => {
    assert.equal(plainTagEmoji("🧭 [PLANNER] Decided 3 open point(s)"), "[PLANNER] Decided 3 open point(s)");
    assert.equal(plainTagEmoji("\n[VERIFIER] 🛡️ Running verification"), "\n[VERIFIER] Running verification");
    assert.equal(plainTagEmoji("🧪 [TESTS] 1 failing test file."), "[TESTS] 1 failing test file.");
  });
  test("a warning or a result mark is kept", () => {
    assert.equal(plainTagEmoji("⚠️ [HARD VERIFICATION FAILURE]"), "⚠️ [HARD VERIFICATION FAILURE]");
    assert.equal(plainTagEmoji("[EDITOR] ✔ Finished patching — x"), "[EDITOR] ✔ Finished patching — x");
  });
  test("a line with no tag is left alone", () => {
    assert.equal(plainTagEmoji("🎉 done"), "🎉 done");
  });
  test("the tag then takes its colour, which the emoji used to prevent", () => {
    const out = colorizeRoleTag(plainTagEmoji("🧭 [PLANNER] x"));
    assert.ok(out.startsWith("\u001b[35m[PLANNER]"));
  });
});

describe("every persona has a colour of its own", () => {
  const personas = ["DISCOVERY", "PLANNER", "EDITOR", "REPAIR", "QA", "VERIFIER", "VERIFIER-NAV", "VERIFIER-VISUAL", "EXISTENCE", "EXISTS", "REPAIR_PLANNER", "TESTABILITY_PLANNER", "ROADMAP_PLANNER", "ROADMAP", "ADVISOR", "SETUP", "DESIGNER", "SECURITY", "TESTS"];
  test("each is coloured, and no two share one (EXISTS is the audit's own tag for EXISTENCE)", () => {
    const seen = new Map<string, string>();
    for (const p of personas) {
      const out = colorizeRoleTag(`[${p}] x`);
      assert.notEqual(out, `[${p}] x`, `${p} has a colour`);
      const code = out.slice(0, out.indexOf(`[${p}]`));
      if (p !== "EXISTS") assert.ok(!seen.has(code), `${p} shares a colour with ${seen.get(code)}`);
      seen.set(code, p);
    }
  });
  test("REPAIR_PLANNER is not read as REPAIR", () => {
    assert.notEqual(colorizeRoleTag("[REPAIR_PLANNER] x").slice(0, 8), colorizeRoleTag("[REPAIR] x").slice(0, 8));
  });
  test("infrastructure tags stay plain", () => {
    for (const t of ["API", "CONTROL", "REMOTE", "MODELS", "DISPLAY", "COST"]) assert.equal(colorizeRoleTag(`[${t}] x`), `[${t}] x`);
  });
  test("NO_COLOR turns it off", () => {
    process.env.NO_COLOR = "1";
    try {
      assert.equal(colorizeRoleTag("[EDITOR] x"), "[EDITOR] x");
    } finally {
      delete process.env.NO_COLOR;
    }
  });
});

describe("long lines wrap at words and continue under the text", () => {
  test("a bulleted line continues under the text, not under the bullet", () => {
    const out = wrapForTerminal("  - Assumed the existing reducer test file is the place to pin generic behaviour and not a new file elsewhere", 60).split("\n");
    assert.ok(out.length >= 2);
    assert.ok(out[0].startsWith("  - Assumed"));
    for (const row of out.slice(1)) assert.ok(row.startsWith("    "), `"${row}" is indented under the text`);
    for (const row of out) assert.ok(visibleWidth(row) <= 59, `"${row}" fits`);
  });
  test("no word is ever split", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
    const out = wrapForTerminal(text, 40);
    assert.deepEqual(out.split(/\s+/), text.split(" "));
  });
  test("a tag line continues under what follows the tag", () => {
    const out = wrapForTerminal("[PLANNER] one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", 50).split("\n");
    assert.ok(out.length >= 2);
    assert.ok(out[1].startsWith(" ".repeat("[PLANNER] ".length)));
  });
  test("escape codes take no width and survive", () => {
    const coloured = "\u001b[35m[PLANNER]\u001b[0m " + "word ".repeat(20).trim();
    const out = wrapForTerminal(coloured, 40);
    assert.ok(out.startsWith("\u001b[35m[PLANNER]\u001b[0m"));
    for (const row of out.split("\n")) assert.ok(visibleWidth(row) <= 39);
  });
  test("a short line, a path, and aligned columns are left alone", () => {
    assert.equal(wrapForTerminal("short line", 80), "short line");
    const path = "C:/Users/dev/app/src/components/some/very/long/path/that/goes/on/DashboardTimeline.tsx";
    assert.equal(wrapForTerminal(path, 40), path);
    const table = "  src/models/timeline.ts      |  12 +++++++-----   some trailing words to push it past the limit of the terminal";
    assert.equal(wrapForTerminal(table, 60), table);
  });
  test("an emoji counts as two columns", () => {
    assert.equal(visibleWidth("a🧭b"), 4);
  });
  test("no width (a pipe) means no wrapping", () => {
    const long = "word ".repeat(40);
    assert.equal(wrapForTerminal(long, 0), long);
  });
});

describe("what is being waited on, on one line", () => {
  test("nothing in flight is the plain running line", () => {
    assert.equal(liveCallCount(), 0);
    assert.equal(composeStatus("Phase 1 · QA"), "Phase 1 · QA running…");
    assert.equal(composeStatus(undefined), undefined);
  });
  test("several calls of one persona and model are grouped", () => {
    const a = trackCall("REPAIR", "deepseek/deepseek-v4.1-flash-1017");
    const b = trackCall("REPAIR", "deepseek/deepseek-v4.1-flash-1017");
    try {
      assert.equal(describeLiveCalls(), "REPAIR ×2 · deepseek-v4.1-flash-1017");
      const line = composeStatus("1/9 Extend vocabulary · QA", 0) as string;
      assert.match(line, /^1\/9 Extend vocabulary · QA running · calling REPAIR ×2 · deepseek-v4\.1-flash-1017/);
    } finally {
      a();
      b();
    }
    assert.equal(describeLiveCalls(), undefined);
  });
  test("on a narrow terminal the phase name gives way, never the moving dots at the end", () => {
    const a = trackCall("REPAIR", "deepseek/deepseek-v4.1-flash-1017");
    const b = trackCall("REPAIR", "deepseek/deepseek-v4.1-flash-1017");
    try {
      const line = composeStatus("1/9 Extend WorkerType vocabulary and labels · QA", 1500, 95) as string;
      assert.ok(line.length <= 95, `${line.length} columns`);
      assert.ok(line.endsWith("..."), "the dots are still there");
      assert.match(line, /…  ?running · calling REPAIR ×2/);
      // Too narrow for any of the phase name: the live part alone.
      assert.match(composeStatus("1/9 Extend WorkerType vocabulary", 0, 50) as string, /^calling REPAIR/);
    } finally {
      a();
      b();
    }
  });
  test("different personas on different models list the personas", () => {
    const a = trackCall("REPAIR", "x/one");
    const b = trackCall("VERIFIER", "x/two");
    try {
      assert.equal(describeLiveCalls(), "REPAIR, VERIFIER");
    } finally {
      a();
      b();
    }
  });
  test("ending a call twice is harmless", () => {
    const a = trackCall("REPAIR", "x/one");
    a();
    a();
    assert.equal(liveCallCount(), 0);
  });
  test("the dots move and never change width", () => {
    const frames = [0, 500, 1000, 1500].map((t) => dots(t));
    assert.equal(new Set(frames).size, 4);
    for (const f of frames) assert.equal(f.length, 3);
  });
  test("with no persona running, a lone call still says what it waits on", () => {
    const a = trackCall("REPAIR", "x/one");
    try {
      assert.match(composeStatus(undefined, 0) as string, /^calling REPAIR · one/);
    } finally {
      a();
    }
  });
});

describe("the wiring", () => {
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("a model call is counted while it is in flight and ended where its ticker stops", () => {
    const src = read("../src/openrouter.ts");
    assert.match(src, /const endCall = trackCall\(agent, model\);/);
    // Two failure paths end it as an estimate; the success path ends it with the provider's exact count.
    assert.equal(src.split("endCall();").length - 1, 2);
    assert.ok(src.includes("endCall.done(usage?.completion);"));
  });
  test("the exit note is said under the persona that is finishing", () => {
    const src = read("../src/agentLoop.ts");
    assert.match(src, /console\.log\(`\\n\[\$\{displayName\}\] \$\{outcome\}/);
    assert.doesNotMatch(src, /\[AGENT EXIT\] \$\{args\.status\}/);
  });
  test("the models row is no longer drawn, and /model still opens", () => {
    const src = read("../src/index.ts");
    assert.match(src, /const refreshModelStrip = \(\) => setModelStrip\(undefined\);/);
    assert.match(src, /registerLiveCommands\(\s*\["\/model", "\/models"\]/);
  });
  test("output is wrapped before file paths become links", () => {
    const src = read("../src/index.ts");
    assert.match(src, /linkifyFilePaths\(wrapForTerminal\(colorizeRoleTag\(toAnsi\(a\)\)/);
  });
  test("the status line animates only while calls are in flight", () => {
    const src = read("../src/index.ts");
    assert.match(src, /if \(liveCallCount\(\) > 0 \|\| stepActive\(\)\) refreshStatus\(\);/);
  });
});

void stripAnsi;
