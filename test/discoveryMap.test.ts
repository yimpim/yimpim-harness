/**
 * Discovery starts from the repo map's likely files, and has a reading budget
 * so it cannot spend every turn searching and then write nothing down.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderShortlist, shortlistFromMap, withImportedNeighbors, words } from "../src/mapShortlist.js";
import { DISCOVERY_FILE_BUDGET, runToolAgent } from "../src/agentLoop.js";
import { AgentConfig } from "../src/config.js";
import { AgentTools } from "../src/agentTools.js";

const MAP = {
  DashboardScreen: { path: "app/dashboard.tsx", summary: "Main screen: renders the session timeline of cards and the composer.", exports: ["DashboardScreen"] },
  TimelineReducer: { path: "src/models/timeline.ts", summary: "Reduces stream events into timeline cards.", exports: ["reduceTimeline"] },
  EventLog: { path: "src/services/eventLog.ts", summary: "Durable ordered event log with a cursor.", exports: ["EventLog"] },
  LoginScreen: { path: "app/login.tsx", summary: "Sign-in form.", exports: ["LoginScreen"] },
  ThemeTokens: { path: "src/theme/tokens.ts", summary: "Colours and spacing.", exports: ["tokens"] },
};

describe("words", () => {
  test("splits camelCase and snake_case, folds plurals, drops noise", () => {
    assert.deepEqual(words("DashboardArchiveFetch"), ["dashboard", "archive", "fetch"]);
    assert.deepEqual(words("the event_log cards"), ["event", "log", "card"]);
  });
});

describe("shortlistFromMap", () => {
  test("ranks the entries that share the task's words, best first", () => {
    const out = shortlistFromMap("The dashboard shows a card from the old session timeline", MAP);
    assert.equal(out[0].path, "app/dashboard.tsx");
    assert.ok(out.some((s) => s.path === "src/models/timeline.ts"));
    assert.ok(!out.some((s) => s.path === "src/theme/tokens.ts"));
  });

  test("entries that share a file are combined into one line", () => {
    const map = { A: { path: "x.ts", summary: "alpha beta" }, B: { path: "x.ts", summary: "alpha gamma" } };
    const out = shortlistFromMap("alpha", map);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].names, ["A", "B"]);
  });

  test("a task that shares nothing, or an empty map, gives nothing rather than a guess", () => {
    assert.deepEqual(shortlistFromMap("zzz qqq", MAP), []);
    assert.deepEqual(shortlistFromMap("dashboard", {}), []);
  });

  test("the rendered block says it is a starting point and asks for taskFindings", () => {
    const text = renderShortlist(shortlistFromMap("dashboard timeline", MAP));
    assert.match(text, /LIKELY RELEVANT FILES/);
    assert.match(text, /a starting point, not an answer/);
    assert.match(text, /write taskFindings/);
    assert.equal(renderShortlist([]), "");
  });
});

describe("withImportedNeighbors", () => {
  test("files a top hit imports are added when they are in the map", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "dm-"));
    fsSync.mkdirSync(path.join(dir, "app"), { recursive: true });
    fsSync.writeFileSync(
      path.join(dir, "app/dashboard.tsx"),
      'import { reduceTimeline } from "../src/models/timeline";\nimport { EventLog } from "@/services/eventLog";\nimport React from "react";\n'
    );
    const base = shortlistFromMap("dashboard", MAP);
    const out = withImportedNeighbors(base, MAP, dir);
    const added = out.filter((s) => s.via);
    assert.deepEqual(added.map((s) => s.path).sort(), ["src/models/timeline.ts", "src/services/eventLog.ts"]);
    assert.ok(added.every((s) => s.via === "app/dashboard.tsx"));
    assert.match(renderShortlist(out), /\[imported by app\/dashboard\.tsx\]/);
  });

  test("a missing file or a package import adds nothing and does not throw", () => {
    const out = withImportedNeighbors(shortlistFromMap("dashboard", MAP), MAP, os.tmpdir());
    assert.equal(out.filter((s) => s.via).length, 0);
  });
});

describe("Discovery's reading budget", () => {
  const tempDirs: string[] = [];
  const config = { prompts: { systemPersona: "You are YIMPIM." }, limits: { maxToolRounds: 40 } } as unknown as AgentConfig;
  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });

  test("after enough files are read its tools are removed and it must write up what it found", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-discbudget-"));
    tempDirs.push(dir);
    const total = DISCOVERY_FILE_BUDGET + 5;
    for (let i = 0; i < total; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`, "utf-8");

    const requests: any[][] = [];
    const toolsSeen: any[] = [];
    const queue: any[] = Array.from({ length: total }, (_, i) => ({
      role: "assistant",
      content: null,
      tool_calls: [toolCall("read_file", { path: `f${i}.ts` }, `c${i}`)],
    }));
    const client = {
      async complete(_m: string[], messages: any[], options?: any) {
        requests.push(messages.map((m) => ({ ...m })));
        toolsSeen.push(options?.tools);
        return { choices: [{ message: queue.shift() ?? { role: "assistant", content: "taskFindings written" } }] };
      },
    } as any;

    const result = await runToolAgent({
      prompt: "Find the dashboard code.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config,
      agentTools: new AgentTools(dir, config),
      models: ["m"],
      agentName: "DISCOVERY",
    });

    assert.equal(result, "taskFindings written");
    // It did not get to read all 15: the budget stopped it at the limit.
    const last = requests[requests.length - 1];
    const toolMessages = last.filter((m: any) => m.role === "tool");
    const refused = toolMessages.filter((m: any) => String(m.content).startsWith("Discovery's reading budget is spent"));
    const reads = toolMessages.length - refused.length;
    assert.equal(reads, DISCOVERY_FILE_BUDGET, `${reads} files were actually read`);
    assert.ok(refused.length > 0, "calls after the budget were refused, not run");
    assert.ok(last.some((m: any) => typeof m.content === "string" && m.content.includes("[DISCOVERY INTERVENTION]")));
    assert.ok(last.some((m: any) => typeof m.content === "string" && m.content.includes("taskFindings JSON block")));
    assert.deepEqual(toolsSeen[toolsSeen.length - 1] ?? [], []);
  });

  test("directory listings do not use up the budget, only files read do", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-discbudget-"));
    tempDirs.push(dir);
    for (let d = 0; d < 12; d++) {
      await fs.mkdir(path.join(dir, `dir${d}`), { recursive: true });
      await fs.writeFile(path.join(dir, `dir${d}`, "a.ts"), "export const a = 1;\n", "utf-8");
    }
    const requests: any[][] = [];
    // Twelve directory listings in a row: none of them is a file read.
    const queue: any[] = Array.from({ length: 12 }, (_, i) => ({
      role: "assistant",
      content: null,
      tool_calls: [toolCall("list_files", { path: `dir${i}` }, `c${i}`)],
    }));
    const client = {
      async complete(_m: string[], messages: any[]) {
        requests.push(messages.map((m) => ({ ...m })));
        return { choices: [{ message: queue.shift() ?? { role: "assistant", content: "done" } }] };
      },
    } as any;
    await runToolAgent({
      prompt: "Look around.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config,
      agentTools: new AgentTools(dir, config),
      models: ["m"],
      agentName: "DISCOVERY",
    });
    assert.ok(!requests.some((msgs) => msgs.some((m: any) => typeof m.content === "string" && m.content.includes("[DISCOVERY INTERVENTION]"))));
  });

  test("it does not apply to any other agent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-discbudget-"));
    tempDirs.push(dir);
    for (let i = 0; i < 12; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`, "utf-8");
    const requests: any[][] = [];
    const queue: any[] = Array.from({ length: 12 }, (_, i) => ({
      role: "assistant",
      content: null,
      tool_calls: [toolCall("read_file", { path: `f${i}.ts` }, `c${i}`)],
    }));
    const client = {
      async complete(_m: string[], messages: any[]) {
        requests.push(messages.map((m) => ({ ...m })));
        return { choices: [{ message: queue.shift() ?? { role: "assistant", content: "done" } }] };
      },
    } as any;
    await runToolAgent({
      prompt: "Answer a question.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config,
      agentTools: new AgentTools(dir, config),
      models: ["m"],
      agentName: "ADVISOR",
    });
    assert.ok(!requests.some((msgs) => msgs.some((m: any) => typeof m.content === "string" && m.content.includes("[DISCOVERY INTERVENTION]"))));
  });
});
