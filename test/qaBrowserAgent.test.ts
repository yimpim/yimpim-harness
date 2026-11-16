/**
 * QA as an agent: it can only use the tools it was given, switches app state
 * to see every state a requirement covers, and its verdict is checked against
 * what actually happened.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_QA_TOOLS, browserQaSystemPrompt, runBrowserQa, validateFinish } from "../src/qaBrowserAgent.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function harness(script: any[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-agent-"));
  const calls: string[] = [];
  const prompts: string[] = [];
  let i = 0;
  const page: any = {
    emulateMedia: async (o: any) => void calls.push("scheme:" + o.colorScheme),
    setViewportSize: async (s: any) => void calls.push(`viewport:${s.width}x${s.height}`),
    viewportSize: () => ({ width: 390, height: 844 }),
    reload: async () => void calls.push("reload"),
    getByText: (t: string) => ({ first: () => ({ click: async () => void calls.push("click:" + t) }) }),
    evaluate: async (fn: any, arg: any) => (arg ? { color: "rgb(0, 0, 0)", effectiveBackground: "rgb(247, 247, 247)" } : "YIMPIM"),
  };
  const ctx = {
    page,
    goal: "logo is black in light theme and white in dark theme",
    surface: "Expo web preview",
    shoot: async () => PNG,
    screenshotDir: dir,
    label: "t",
    consoleErrors: () => [],
    complete: async (messages: any[]) => {
      prompts.push(JSON.stringify(messages[0].content));
      const next = script[Math.min(i++, script.length - 1)];
      return typeof next === "string" ? next : JSON.stringify(next);
    },
  };
  return { ctx, calls, prompts, dir };
}

describe("the tools it is told about", () => {
  test("the prompt lists every tool and states the list is complete, and what it cannot do", () => {
    const p = browserQaSystemPrompt("Expo web preview");
    for (const t of BROWSER_QA_TOOLS) assert.match(p, new RegExp("- " + t.name + " "));
    assert.match(p, /THESE ARE ALL THE TOOLS YOU HAVE/);
    assert.match(p, /host computer, a VM or the user's machine/);
    assert.match(p, /If you want something that is not in the list, it does not exist/);
  });

  test("a tool that is not on the list is refused and the model is told what exists", async () => {
    const h = harness([
      { tool: "run_shell", args: { cmd: "format c:" } },
      { tool: "finish", args: { states: [{ state: "start", verdict: "INCONCLUSIVE", screenshot: "s1", reason: "x" }], unverified: [], reason: "r" } },
    ]);
    const r = await runBrowserQa(h.ctx as any);
    assert.deepEqual(h.calls, []); // nothing was executed
    assert.match(h.prompts.length > 1 ? "ok" : "", /ok/);
    assert.equal(r.status, "INCONCLUSIVE");
  });

  test("three invalid answers in a row end the run without a verdict", async () => {
    const h = harness(["not json", "{}", { tool: "rm_rf" }]);
    const r = await runBrowserQa(h.ctx as any);
    assert.equal(r.status, "INCONCLUSIVE");
    assert.match(r.reason, /did not reach a verdict/);
  });
});

describe("it switches state to see the states the requirement covers", () => {
  test("light seen first, then dark by a tool call, then a per-state verdict", async () => {
    const h = harness([
      { tool: "set_color_scheme", args: { value: "dark" } },
      {
        tool: "finish",
        args: {
          states: [
            { state: "light theme", verdict: "PASS", screenshot: "s1", reason: "black wordmark on #f7f7f7" },
            { state: "dark theme", verdict: "DEFECT", screenshot: "s2", reason: "wordmark still black on dark navy" },
          ],
          unverified: [],
          reason: "dark wrong",
        },
      },
    ]);
    const r = await runBrowserQa(h.ctx as any);
    assert.deepEqual(h.calls, ["scheme:dark"]);
    assert.equal(r.status, "DEFECT");
    assert.match(r.reason, /\[dark theme\] wordmark still black/);
    assert.equal(r.captures.length, 2);
    assert.match(r.captures[1].label, /dark scheme/);
    for (const c of r.captures) assert.ok(fs.existsSync(c.file));
  });

  test("it can read an element's style and the harness reports it back to the model", async () => {
    const h = harness([
      { tool: "read_style", args: { text: "YIMPIM" } },
      { tool: "finish", args: { states: [], unverified: [], reason: "r" } },
    ]);
    await runBrowserQa(h.ctx as any);
    assert.match(h.prompts.length === 2 ? "two" : "", /two/);
  });
});

describe("the verdict is checked against what happened", () => {
  const shots: any[] = [
    { id: "s1", file: "a", scheme: "light", viewport: "1x1", note: "" },
    { id: "s2", file: "b", scheme: "light", viewport: "1x1", note: "" },
  ];
  test("a PASS that cites no screenshot is not a pass", () => {
    const v = validateFinish({ states: [{ state: "x", verdict: "PASS", screenshot: "s9", reason: "ok" }] }, shots);
    assert.equal(v.status, "INCONCLUSIVE");
    assert.match(v.reason, /without citing evidence that was gathered/);
  });
  test("claiming the dark state from a light-scheme screenshot is rejected", () => {
    const v = validateFinish({ states: [{ state: "dark theme", verdict: "PASS", screenshot: "s2", reason: "ok" }] }, shots);
    assert.equal(v.status, "INCONCLUSIVE");
    assert.match(v.reason, /taken with the light color scheme/);
  });
  test("an unreachable state turns a clean pass into 'could not verify'", () => {
    const v = validateFinish(
      { states: [{ state: "light theme", verdict: "PASS", screenshot: "s1", reason: "ok" }], unverified: ["signed-in state: no credentials"] },
      shots
    );
    assert.equal(v.status, "INCONCLUSIVE");
    assert.match(v.reason, /Verified: light theme/);
    assert.match(v.reason, /Could not verify: signed-in state/);
  });
  test("every state cited and right is a pass; any defect wins", () => {
    const ok = validateFinish({ states: [{ state: "light theme", verdict: "PASS", screenshot: "s1", reason: "ok" }], unverified: [] }, shots);
    assert.equal(ok.status, "PASS");
    const bad = validateFinish(
      { states: [{ state: "a", verdict: "PASS", screenshot: "s1", reason: "ok" }, { state: "b", verdict: "DEFECT", screenshot: "s2", reason: "wrong" }] },
      shots
    );
    assert.equal(bad.status, "DEFECT");
  });
});
