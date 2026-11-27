import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { documentationOnlyPaths, isHarnessMetadataPath } from "../src/verifierTools.js";
import { collectChangeSet } from "../src/staticQa.js";
import { projectBackend, isInlineBrowserProbeCommand, detectInstalledBrowsers } from "../src/qaProjectBackend.js";
import { RemoteSession } from "../src/remote/client.js";
import { decodePairing, open, type Envelope } from "../src/remote/protocol.js";
import { deduplicateClarifierOptions, ClarifyingQuestionSchema } from "../src/planner.js";

const tempDirs: string[] = [];
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("QA doc-only exclusion of QA_REVIEW.md / .yimpim & full task range diff", () => {
  test("documentationOnlyPaths excludes QA_REVIEW.md and .yimpim/** metadata", () => {
    assert.equal(isHarnessMetadataPath("QA_REVIEW.md"), true);
    assert.equal(isHarnessMetadataPath(".yimpim/state.json"), true);

    // QA_REVIEW.md alone must NOT classify as doc-only
    const onlyQaReview = documentationOnlyPaths({
      modified: ["QA_REVIEW.md"],
      added: [".yimpim/notes.md"],
      deleted: [],
      renamed: [],
      diff: "",
      isEmpty: false,
      emptied: [],
      lockFiles: [],
    });
    assert.equal(onlyQaReview, undefined);

    // Real code + QA_REVIEW.md must NOT classify as doc-only
    const codeAndReview = documentationOnlyPaths({
      modified: ["src/App.tsx", "QA_REVIEW.md"],
      added: [],
      deleted: [],
      renamed: [],
      diff: "",
      isEmpty: false,
      emptied: [],
      lockFiles: [],
    });
    assert.equal(codeAndReview, undefined);

    // Genuine README.md + QA_REVIEW.md returns only README.md
    const realDocsOnly = documentationOnlyPaths({
      modified: ["README.md", "QA_REVIEW.md"],
      added: [],
      deleted: [],
      renamed: [],
      diff: "",
      isEmpty: false,
      emptied: [],
      lockFiles: [],
    });
    assert.deepEqual(realDocsOnly, ["README.md"]);
  });

  test("collectChangeSet with taskBaseSha includes earlier code commits even when latest commit only touched QA_REVIEW.md", async () => {
    const dir = await makeTempDir("yimpim-taskrange-");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });

    await fs.writeFile(path.join(dir, "App.tsx"), "export const x = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });
    const taskBaseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();

    // Phase 1 commits UI code change
    await fs.writeFile(path.join(dir, "App.tsx"), "export const x = 2;\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "phase 1 code"], { cwd: dir });

    // Phase 2 only updates QA_REVIEW.md in working tree
    await fs.writeFile(path.join(dir, "QA_REVIEW.md"), "## Review\nPassed\n");

    const change = await collectChangeSet(dir, undefined, taskBaseSha);
    assert.ok(change.modified.includes("App.tsx"), "must include App.tsx from taskBaseSha..HEAD");
    assert.equal(documentationOnlyPaths(change), undefined, "must not classify task as doc-only");
  });
});

describe("Native QA browser-availability detection without security prompt", () => {
  test("projectBackend intercepts inline node -e playwright/puppeteer probe natively without calling runCommand", async () => {
    const dir = await makeTempDir("yimpim-browserprobe-");
    await fs.mkdir(path.join(dir, "node_modules", "playwright"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules", "playwright", "package.json"), JSON.stringify({ name: "playwright", main: "index.js" }));
    await fs.writeFile(path.join(dir, "node_modules", "playwright", "index.js"), "module.exports = {};\n");

    let runCommandCalled = false;
    const backend = projectBackend({
      repoRoot: dir,
      readFile: async () => "",
      searchCode: async () => "",
      listFiles: async () => "",
      runCommand: async () => {
        runCommandCalled = true;
        return "should not be called";
      },
    });

    const probeCmd = `node -e "const a=['playwright','puppeteer']; console.log(a.map(p=>{try{return require.resolve(p)}catch{return null}}))"`;
    assert.equal(isInlineBrowserProbeCommand(probeCmd), true);

    const res = await backend.run("run_command", { command: probeCmd, purpose: "check browser tools" });
    assert.equal(runCommandCalled, false, "inline browser probe must not invoke runCommand or security panel");
    assert.match(res.text, /playwright/i);

    const native = detectInstalledBrowsers(dir);
    assert.ok(native.installed.includes("playwright"));
  });
});

describe("Remote SECURITY worker.end payload enrichment", () => {
  test("RemoteSession.push guarantees command, safeCount, totalJudges, and summary on SECURITY worker.end", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith("/v1/register")) {
        return new Response(JSON.stringify({ sessionId: "sess_sec", agentToken: "tok_sec" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, commands: [] }), { status: 200 });
    }) as any;

    try {
      const session = new RemoteSession({ brokerUrl: "https://broker.example.invalid", allowAnswer: true, redactLogs: false });
      const pairingUrl = await session.start("run-sec", "my-repo", {
        onAbort: () => {},
        onAnswer: () => {},
        onAttach: () => {},
        onMessage: () => {},
        onFetchDiff: () => {},
        onFetchHistory: () => {},
        onHistoryList: () => {},
        onFetchScreenshot: () => {},
        onGetModelConfig: () => {},
        onGetUsage: () => {},
        onListModels: () => {},
        onSetModel: () => {},
      });
      const key = Buffer.from(decodePairing(pairingUrl.split("#")[1]).key, "base64url");
      (session as any).outbox.length = 0;

      // Even if a caller emits a bare SECURITY worker.end, RemoteSession ensures rich summary fields
      session.push("worker.end", { agent: "SECURITY", outcome: "completed", command: "npm run build", safeCount: 3, totalJudges: 3 });
      session.push("worker.end", { agent: "SECURITY", outcome: "escalated", command: "rm -rf tmp", safeCount: 2, totalJudges: 3, allowed: false });

      const decoded = ((session as any).outbox as Envelope[]).map((e) => open<any>(key, e));
      assert.equal(decoded[0].command, "npm run build");
      assert.equal(decoded[0].safeCount, 3);
      assert.equal(decoded[0].totalJudges, 3);
      assert.equal(decoded[0].summary, "3/3 safe · npm run build");

      assert.equal(decoded[1].command, "rm -rf tmp");
      assert.equal(decoded[1].safeCount, 2);
      assert.equal(decoded[1].totalJudges, 3);
      assert.equal(decoded[1].summary, "2/3 escalated · rm -rf tmp");

      await session.stop("done");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("Clarifier (Recommended) option deduplication", () => {
  test("deduplicateClarifierOptions merges duplicate base options and attaches (Recommended) once", () => {
    const res = deduplicateClarifierOptions([
      "Use SQLite",
      "Use Postgres",
      "Use JSON file",
      "Use SQLite (Recommended)",
    ]);
    assert.deepEqual(res.options, [
      "Use SQLite (Recommended)",
      "Use Postgres",
      "Use JSON file",
    ]);
    assert.equal(res.recommended, "Use SQLite (Recommended)");

    const parenRes = deduplicateClarifierOptions([
      "Keep existing theme (matches current app)",
      "Add dark mode",
      "Keep existing theme (Recommended)",
    ]);
    assert.deepEqual(parenRes.options, [
      "Keep existing theme (matches current app) (Recommended)",
      "Add dark mode",
    ]);

    const parsed = ClarifyingQuestionSchema.parse({
      question: "Which storage?",
      options: ["Local file", "Cloud DB", "Local file (Recommended)"],
    });
    assert.deepEqual(parsed.options, ["Local file (Recommended)", "Cloud DB"]);
  });
});
