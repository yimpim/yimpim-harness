/** The router: every route is known to the prompt, the parser and the dispatcher; the model decides; facts go in as context. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INTENTS, parseIntentReply, routeFacts } from "../src/routeIntent.js";
import { INTENT_SYSTEM } from "../src/prompts.js";
import { EXTRACT_AUDIT_SYSTEM, EXTRACT_SYSTEM, checkExistence } from "../src/existence.js";

describe("the routes", () => {
  test("every route is described to the router model", () => {
    for (const r of INTENTS) assert.ok(INTENT_SYSTEM.includes(`"${r}"`), `INTENT_SYSTEM does not describe "${r}"`);
  });
  test("the two routes a completeness question and a red suite need exist", () => {
    assert.ok(INTENTS.includes("audit") && INTENTS.includes("tests"));
    assert.match(INTENT_SYSTEM, /"audit"[^]*did we finish everything in the brief/);
    assert.match(INTENT_SYSTEM, /"tests"[^]*fix the failing tests/);
  });
});

describe("reading the router's answer", () => {
  test("each known route is taken as given", () => {
    for (const r of INTENTS) assert.equal(parseIntentReply(JSON.stringify({ intent: r })).intent, r);
  });
  test("anything unusable is a plain task", () => {
    for (const raw of ["", "not json", "{}", JSON.stringify({ intent: "banana" }), JSON.stringify({ intent: 7 })]) {
      assert.equal(parseIntentReply(raw).intent, "task", raw);
    }
  });
  test("the follow-up flag is true only when the router said true", () => {
    assert.equal(parseIntentReply(JSON.stringify({ intent: "task", followsLastAudit: true })).followsLastAudit, true);
    assert.equal(parseIntentReply(JSON.stringify({ intent: "task", followsLastAudit: "yes" })).followsLastAudit, false);
    assert.equal(parseIntentReply(JSON.stringify({ intent: "task" })).followsLastAudit, false);
  });
  test("a branch name is trimmed, and an empty one is none", () => {
    assert.equal(parseIntentReply(JSON.stringify({ intent: "branch_only", branch: "  go-api " })).branch, "go-api");
    assert.equal(parseIntentReply(JSON.stringify({ intent: "branch_only", branch: "  " })).branch, null);
  });
});

describe("facts for the router", () => {
  test("nothing to say gives nothing", () => {
    assert.equal(routeFacts({ numberedJobs: 0 }), "");
    assert.equal(routeFacts({ numberedJobs: 1 }), "");
  });
  test("the number of jobs and a report just given are stated, not acted on", () => {
    const f = routeFacts({ numberedJobs: 4, lastAuditRequest: "did we finish the brief?" });
    assert.match(f, /lists 4 numbered jobs/);
    assert.match(f, /audit report from checking "did we finish the brief\?"/);
    assert.match(f, /finish it/);
  });
});

describe("no phrase list decides a route", () => {
  test("the wording-based helpers are gone from the source", () => {
    const ex = fs.readFileSync(new URL("../src/existence.ts", import.meta.url), "utf-8");
    const ix = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.ok(!/wantsReportOnly|isAuditFollowUp/.test(ex + ix));
  });
});

describe("an audit reads the document, whatever the wording", () => {
  const BRIEF = "# Brief\n- Roadmap card shows done units\n- Worker cards use agent names\n";
  const reply = JSON.stringify({ applies: true, requirements: [{ text: "Roadmap card shows done units", terms: ["roadmap"] }, { text: "Worker cards use agent names", terms: ["worker"] }] });

  test("a question about the brief is not stood down as 'not a feature request'", async () => {
    const systems: string[] = [];
    const call = async (m: { role: string; content: string }[]) => {
      systems.push(m[0].content);
      return m[0].content === EXTRACT_AUDIT_SYSTEM ? reply : JSON.stringify({ results: [] });
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-x-"));
    try {
      const r = await checkExistence({ call: call as any, repoRoot: dir, request: "did we finish everything in the brief?", docs: BRIEF, audit: true });
      assert.equal(r.applies, true);
      assert.equal(systems[0], EXTRACT_AUDIT_SYSTEM);
      assert.equal(r.items.length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the build-side extractor still stands down for a question", () => {
    assert.match(EXTRACT_SYSTEM, /a question/);
    assert.match(EXTRACT_AUDIT_SYSTEM, /whatever|their wording is only a question/);
  });

  test("every requirement in a long document is checked: no cap in an audit", async () => {
    const many = JSON.stringify({ applies: true, requirements: Array.from({ length: 40 }, (_, i) => ({ text: `Requirement number ${i + 1}`, terms: [`term${i}`] })) });
    const call = async (m: { role: string; content: string }[]) => (m[0].content === EXTRACT_AUDIT_SYSTEM ? many : JSON.stringify({ results: [] }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-y-"));
    try {
      const r = await checkExistence({ call: call as any, repoRoot: dir, request: "are we done?", docs: "x", audit: true, maxRequirements: 12 });
      assert.equal(r.items.length, 40);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
