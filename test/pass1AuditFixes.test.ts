import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTools, PLANNER_TOOLS_SCHEMA, REPAIR_PLANNER_WIDENED_TOOLS_SCHEMA } from "../src/agentTools.js";
import { buildContextualSystemPrompt, runToolAgent } from "../src/agentLoop.js";
import { compactRepoMapView } from "../src/repoMap.js";
import { RunLock } from "../src/runLock.js";
import { RemoteSession } from "../src/remote/client.js";
import type { AgentConfig } from "../src/config.js";

const tempDirs: string[] = [];
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-pass1-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const baseConfig = {
  prompts: { systemPersona: "You are YIMPIM." },
  limits: { maxToolRounds: 8, maxFileBytes: 50_000, maxFilesPerPhase: 10 },
  safety: { blockedDirectories: [], blockedFilePatterns: [] },
} as unknown as AgentConfig;

describe("Pass 1 audit fixes", () => {
  test("REPAIR_PLANNER defaults to PLANNER_TOOLS_SCHEMA and widened schema adds only search_code", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, baseConfig);
    tools.beginPlannerInspection(["a.ts"], 5);
    let capturedTools: any[] = [];
    const fakeClient = {
      complete: async (_models: string[], _msgs: any[], opts: any) => {
        capturedTools = opts?.tools ?? [];
        return { role: "assistant", content: "Root cause identified." };
      },
    } as any;

    await runToolAgent({
      prompt: "Diagnose failure",
      repo: { repoRoot: dir } as any,
      repoRoot: dir,
      client: fakeClient,
      config: baseConfig,
      agentTools: tools,
      models: ["test/model"],
      agentName: "REPAIR_PLANNER",
    });

    const names = capturedTools.map((t) => t.function?.name).sort();
    assert.deepEqual(names, PLANNER_TOOLS_SCHEMA.map((t) => t.function.name).sort());

    const widenedNames = REPAIR_PLANNER_WIDENED_TOOLS_SCHEMA.map((t) => t.function.name).sort();
    assert.deepEqual(widenedNames, ["get_symbol_definition", "read_file", "search_code"]);
  });

  test("getSymbolDefinition does not poison readLedger for other lines in the same file", async () => {
    const dir = await makeRepo();
    await fs.writeFile(
      path.join(dir, "sample.ts"),
      [
        "export function alpha() {",
        "  return 1;",
        "}",
        "",
        "export function beta() {",
        "  return 2;",
        "}",
      ].join("\n")
    );
    const tools = new AgentTools(dir, baseConfig);
    tools.beginPlannerInspection(["sample.ts"], 5);
    tools.readLedger.begin("PLANNER");

    await tools.withReadStage("PLANNER", async () => {
      const first = await tools.getSymbolDefinition("sample.ts", "alpha");
      assert.match(first, /function alpha/);

      // A second symbol in the same file must still be found (not poisoned by full-file ledger entry).
      const second = await tools.getSymbolDefinition("sample.ts", "beta");
      assert.match(second, /function beta/);

      // Reading lines 5-7 directly after only alpha was shown must still work cleanly.
      tools.readLedger.begin("PLANNER");
      await tools.getSymbolDefinition("sample.ts", "alpha");
      const ranged = await tools.readFileBounded("sample.ts", 5, 7);
      assert.match(ranged, /function beta/);
    });
  });

  test("readMemo invalidates after patching the same file twice in a 1-file phase", async () => {
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, "only.ts"), "export const v = 1;\n");
    const tools = new AgentTools(dir, baseConfig);
    tools.beginPhase(["only.ts"], 5, "phase-1");

    let step = 0;
    const seenReads: string[] = [];
    const fakeClient = {
      complete: async (_models: string[], msgs: any[]) => {
        const last = msgs[msgs.length - 1];
        if (last?.role === "tool" && typeof last.content === "string" && last.content.includes("export const v")) {
          seenReads.push(last.content);
        }
        step++;
        if (step === 1) {
          return {
            role: "assistant",
            tool_calls: [{ id: "1", type: "function", function: { name: "patch_file", arguments: JSON.stringify({ path: "only.ts", search: "v = 1", replace: "v = 2" }) } }],
          };
        }
        if (step === 2) {
          return {
            role: "assistant",
            tool_calls: [{ id: "2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "only.ts" }) } }],
          };
        }
        if (step === 3) {
          return {
            role: "assistant",
            tool_calls: [{ id: "3", type: "function", function: { name: "patch_file", arguments: JSON.stringify({ path: "only.ts", search: "v = 2", replace: "v = 3" }) } }],
          };
        }
        if (step === 4) {
          return {
            role: "assistant",
            tool_calls: [{ id: "4", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "only.ts" }) } }],
          };
        }
        return { role: "assistant", content: "done" };
      },
    } as any;

    await runToolAgent({
      prompt: "Edit only.ts twice",
      repo: { repoRoot: dir } as any,
      repoRoot: dir,
      client: fakeClient,
      config: baseConfig,
      agentTools: tools,
      models: ["test/model"],
      agentName: "EDITOR",
    });

    assert.equal(seenReads.length, 2, "both post-patch reads must return fresh file contents");
    assert.match(seenReads[0], /v = 2/);
    assert.match(seenReads[1], /v = 3/);
  });

  test("compactRepoMapView sorts alphabetically and strips volatile fields; PLANNER system prompt omits maps", async () => {
    const dir = await makeRepo();
    await fs.mkdir(path.join(dir, ".agent"), { recursive: true });
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(dir, "z.ts"), "export const z = 1;\n");
    const rawMap = {
      Zed: { path: "z.ts", summary: "Z module", exports: ["z"], lastUpdated: 200, mtimeMs: 999, size: 12 },
      Alpha: { path: "a.ts", summary: "A module", exports: ["a"], lastUpdated: 100, mtimeMs: 888, size: 12 },
    };
    const compact = compactRepoMapView(rawMap);
    assert.deepEqual(Object.keys(compact), ["Alpha", "Zed"]);
    assert.deepEqual(compact.Alpha, { path: "a.ts", summary: "A module", exports: ["a"] });
    assert.equal("mtimeMs" in (compact.Alpha as any), false);
    assert.equal("lastUpdated" in (compact.Alpha as any), false);
    assert.equal("stale" in (compact.Alpha as any), false);

    await fs.writeFile(path.join(dir, ".agent", "repo_map.json"), JSON.stringify(rawMap));
    await fs.writeFile(
      path.join(dir, ".agent", "nav_map.json"),
      JSON.stringify({ Home: { file: "a.ts", controls: [] } })
    );
    const plannerSystem = buildContextualSystemPrompt("PLANNER", baseConfig, dir);
    assert.ok(!plannerSystem.includes("KNOWN ARCHITECTURE REPO MAP"));
    assert.ok(!plannerSystem.includes("KNOWN SCREEN NAVIGATION MAP"));
  });

  test("RemoteSession re-queues events on non-2xx flush responses instead of dropping them", async () => {
    const origFetch = globalThis.fetch;
    let eventAttempts = 0;
    let deliveredEvents = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      const s = String(url);
      if (s.endsWith("/v1/events")) {
        eventAttempts++;
        if (eventAttempts === 1) {
          return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
        }
        const body = JSON.parse(String(init?.body ?? "{}"));
        deliveredEvents += Array.isArray(body.events) ? body.events.length : 0;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    try {
      const session = new RemoteSession({ brokerUrl: "http://127.0.0.1:9999", allowAnswer: false, redactLogs: false });
      (session as any).sessionId = "sess-1";
      (session as any).agentToken = "tok-1";
      session.push("log", { level: "info", message: "must-not-drop" });
      assert.equal((session as any).outbox.length, 1);

      // Simulate first flush hitting 503, then stop() flushing the re-queued event.
      (session as any).beginFlushing();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(eventAttempts, 1);
      assert.equal((session as any).outbox.length, 1, "event must be re-queued after 503");

      await session.stop("test done");
      assert.ok(deliveredEvents >= 2, "re-queued log + session.end must both flush on retry/stop");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("RunLock.registerShutdownHook registers and unregisters cleanly", async () => {
    const dir = await makeRepo();
    const lock = new RunLock(dir);
    let called = 0;
    const unreg = lock.registerShutdownHook(() => {
      called++;
    });
    await (lock as any).runShutdownHooks(500);
    assert.equal(called, 1);
    unreg();
    await (lock as any).runShutdownHooks(500);
    assert.equal(called, 1);
  });
});
