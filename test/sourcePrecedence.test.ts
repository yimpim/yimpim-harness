/**
 * The user's brief and specs decide how the product behaves. The security agent sees them, its requirements are advisory
 * against them, and the Planner and the question checker are told a disagreement between sources is never a question.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ensureThreatModel, plannerText } from "../src/securityPlan.js";
import { PLANNER_SYSTEM } from "../src/prompts.js";
import os from "node:os";
import path from "node:path";

const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf-8");

describe("which source wins", () => {
  test("security requirements reach the Planner as advice that gives way to the user's documents", () => {
    const text = plannerText({ risky: true, surfaces: ["identity"], assets: [], actors: [], entryPoints: [], abuseCases: [], requirements: ["keep the session until re-login"], createdAt: "" } as any);
    assert.match(text, /do not decide how the product behaves/);
    assert.match(text, /follow the documents/);
    assert.match(text, /Do not ask the user which wins/);
  });
  test("the security agent is shown the brief the request names", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prec-"));
    const seen: string[] = [];
    await ensureThreatModel({
      call: async (_m, messages) => {
        seen.push(messages.map((m: any) => m.content).join("\n"));
        return JSON.stringify({ sensitive: false });
      },
      models: ["m"],
      repoRoot: root,
      request: "Port the retry policy",
      documents: "BRIEF: Pairing is wiped ONLY on a real, persistent 401 after a 120-second grace.",
      log: () => {},
    });
    assert.ok(seen.some((t) => t.includes("persistent 401 after a 120-second grace")));
    assert.ok(seen.some((t) => /never contradict a behavior they state/.test(t)));
  });
  test("the Planner and the question checker carry the rule, and the documents are read before the security step", () => {
    assert.match(PLANNER_SYSTEM, /outrank the security requirements, QA notes and your own inference/);
    assert.match(src("questionVerify.ts"), /the one the user gave wins/);
    const idx = src("index.ts");
    assert.ok(idx.indexOf("const userDocsSection = renderUserDocuments") < idx.indexOf("await ensureThreatModel({"));
    assert.match(idx, /documents: userDocsSection,/);
  });
});

describe("a question that reaches the person is one the documents do not answer", () => {
  test("so it never offers 'follow the brief' as a choice", () => {
    const idx = src("index.ts");
    assert.match(idx, /questionsToAsk\(activePlan, \{ hasSpec: false[,} ]/);
    assert.match(PLANNER_SYSTEM, /never offer "follow the brief" as one of its options/);
  });
});

describe("documents cut to fit", () => {
  test("the header says partial, and to read the rest, only when something was cut", async () => {
    const { renderUserDocuments } = await import("../src/userFiles.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-"));
    fs.writeFileSync(path.join(root, "brief.md"), "x".repeat(500));
    const full = renderUserDocuments(["brief.md"], root);
    assert.match(full, /\(in full;/);
    assert.doesNotMatch(full, /PARTIAL/);
    const cut = renderUserDocuments(["brief.md"], root, 100, 100);
    assert.match(cut, /PARTIAL/);
    assert.match(cut, /read_file/);
    assert.doesNotMatch(cut, /\(in full;/);
    fs.writeFileSync(path.join(root, "b2.md"), "y");
    const skipped = renderUserDocuments(["brief.md", "b2.md"], root, 100, 100);
    assert.match(skipped, /PARTIAL/);
    assert.match(skipped, /b2\.md was not included/);
  });
});
