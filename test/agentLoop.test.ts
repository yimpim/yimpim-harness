/**
 * Regression tests for extracting the Editor's own how-to-verify notes back
 * out of conclude_task's plain-string return value. This is the Editor->QA
 * acceptance-criteria handoff: if this silently breaks, the Verifier just
 * quietly stops getting the notes and nobody sees an error for it.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractHowToVerify, buildContextualSystemPrompt, runToolAgent } from "../src/agentLoop.js";
import { AgentConfig } from "../src/config.js";
import { AgentTools } from "../src/agentTools.js";

describe("extractHowToVerify", () => {
  test("returns undefined when the editor left no how-to-verify notes", () => {
    assert.equal(extractHowToVerify("TASK_CONCLUDED: Applied changes to GarageScreen.kt"), undefined);
  });

  test("extracts the notes when the editor left them", () => {
    const result =
      "TASK_CONCLUDED: Added a fast-forward control to the race screen." +
      "\n\n[HOW TO VERIFY]\nTap Fast Forward up to 5 times; each tap increases speed one level.";
    assert.equal(
      extractHowToVerify(result),
      "Tap Fast Forward up to 5 times; each tap increases speed one level."
    );
  });

  test("trims surrounding whitespace from the extracted notes", () => {
    const result = "TASK_CONCLUDED: done.\n\n[HOW TO VERIFY]\n   Tap the button.   \n\n";
    assert.equal(extractHowToVerify(result), "Tap the button.");
  });

  test("returns undefined for a marker with nothing after it", () => {
    const result = "TASK_CONCLUDED: done.\n\n[HOW TO VERIFY]\n   ";
    assert.equal(extractHowToVerify(result), undefined);
  });

  test("returns undefined for other conclude_task outcomes, which never carry the marker", () => {
    assert.equal(extractHowToVerify("TASK_ALREADY_SATISFIED: already present in Foo.kt"), undefined);
  });
});

/**
 * Regression tests for injecting .agent/nav_map.json into every agent's
 * context — the Editor's only way to write an honest verification path for a
 * screen it never navigated to itself, and QA's head start on which element
 * to try first during its live, still-visually-confirmed navigation walk.
 */
describe("buildContextualSystemPrompt — nav map injection", () => {
  const tempDirs: string[] = [];
  const fakeConfig = { prompts: { systemPersona: "You are YIMPIM." } } as AgentConfig;

  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function makeRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-navmap-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("injects a populated nav map into the persona", async () => {
    const dir = await makeRepo();
    await fs.mkdir(path.join(dir, ".agent"));
    await fs.writeFile(path.join(dir, "Race.kt"), "// screen file\n");
    await fs.writeFile(
      path.join(dir, ".agent", "nav_map.json"),
      JSON.stringify({
        RaceScreen: {
          file: "Race.kt",
          reachedFrom: "BettingScreen, tap \"LET'S RACE\"",
          controls: [{ label: "Fast Forward", leadsTo: "increases sim speed" }],
        },
      })
    );

    const persona = buildContextualSystemPrompt("EDITOR", fakeConfig, dir);
    assert.match(persona, /\[KNOWN SCREEN NAVIGATION MAP\]/);
    assert.match(persona, /RaceScreen/);
    assert.match(persona, /LET'S RACE/);
  });

  test("says nothing about a nav map that doesn't exist yet", async () => {
    const dir = await makeRepo();
    const persona = buildContextualSystemPrompt("EDITOR", fakeConfig, dir);
    assert.doesNotMatch(persona, /KNOWN SCREEN NAVIGATION MAP/);
  });

  test("says nothing about an empty nav map ({})", async () => {
    const dir = await makeRepo();
    await fs.mkdir(path.join(dir, ".agent"));
    await fs.writeFile(path.join(dir, ".agent", "nav_map.json"), "{}");

    const persona = buildContextualSystemPrompt("EDITOR", fakeConfig, dir);
    assert.doesNotMatch(persona, /KNOWN SCREEN NAVIGATION MAP/);
  });

  test("prunes a screen entry whose file no longer exists, same as repo_map.json's cleanup", async () => {
    const dir = await makeRepo();
    await fs.mkdir(path.join(dir, ".agent"));
    // RaceScreen's file exists; GhostScreen's does not.
    await fs.writeFile(path.join(dir, "Race.kt"), "// screen file\n");
    await fs.writeFile(
      path.join(dir, ".agent", "nav_map.json"),
      JSON.stringify({
        RaceScreen: { file: "Race.kt", controls: [] },
        GhostScreen: { file: "DeletedScreen.kt", controls: [] },
      })
    );

    const persona = buildContextualSystemPrompt("EDITOR", fakeConfig, dir);
    assert.match(persona, /RaceScreen/);
    assert.doesNotMatch(persona, /GhostScreen/);

    // The cleanup is persisted back to disk, not just filtered in memory.
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, ".agent", "nav_map.json"), "utf-8"));
    assert.ok(!("GhostScreen" in onDisk));
    assert.ok("RaceScreen" in onDisk);
  });

  test("is available regardless of agent name, same as the repo map", async () => {
    const dir = await makeRepo();
    await fs.mkdir(path.join(dir, ".agent"));
    await fs.writeFile(path.join(dir, "Race.kt"), "// screen file\n");
    await fs.writeFile(
      path.join(dir, ".agent", "nav_map.json"),
      JSON.stringify({ RaceScreen: { file: "Race.kt", controls: [] } })
    );

    for (const agent of ["DISCOVERY", "EDITOR", "REPAIR", "ADVISOR"]) {
      const persona = buildContextualSystemPrompt(agent, fakeConfig, dir);
      assert.match(persona, /KNOWN SCREEN NAVIGATION MAP/, `expected nav map for ${agent}`);
    }
  });
});

/**
 * Regression tests for dispatching `stage_file_for_deletion` through
 * runToolAgent's tool-call switch. Without this branch the model's call fell
 * through to `Unknown tool: stage_file_for_deletion`: staging silently never
 * happened, and nothing was ever offered to the user at the end of the run.
 */
describe("runToolAgent — stage_file_for_deletion dispatch", () => {
  const tempDirs: string[] = [];
  const dispatchConfig = { prompts: { systemPersona: "You are YIMPIM." } } as AgentConfig;

  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function makeRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-stagedispatch-test-"));
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "dead.ts"), "export const dead = 1;\n", "utf-8");
    return dir;
  }

  function toolCall(name: string, args: Record<string, unknown>, id = `call-${name}`) {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  /** Replies from a scripted queue of assistant messages, recording every request. */
  function fakeClient(queue: any[]) {
    const requests: any[][] = [];
    return {
      requests,
      client: {
        async complete(_models: string[], messages: any[]) {
          requests.push(messages);
          return { choices: [{ message: queue.shift() ?? { role: "assistant", content: "done" } }] };
        },
      } as any,
    };
  }

  test("invokes stageFileForDeletion and returns the staging text to the model", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, dispatchConfig);
    const { requests, client } = fakeClient([
      {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("stage_file_for_deletion", { path: "src/dead.ts", reason: "superseded by src/live.ts" })],
      },
      { role: "assistant", content: "Staged it." },
    ]);

    const result = await runToolAgent({
      prompt: "Remove the dead module.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: dispatchConfig,
      agentTools: tools,
      models: ["test-model"],
      agentName: "DISCOVERY",
    });

    assert.equal(result, "Staged it.");
    assert.deepEqual(tools.getStagedDeletions(), ["src/dead.ts"]);
    assert.equal(tools.getDeletionReason("src/dead.ts"), "superseded by src/live.ts");

    const toolResult = requests[1].find((m: any) => m.role === "tool");
    assert.ok(toolResult, "the staging call must produce a role:tool response");
    assert.equal(toolResult.name, "stage_file_for_deletion");
    assert.match(toolResult.content, /Staged "src\/dead\.ts"/);
    assert.match(toolResult.content, /superseded by src\/live\.ts/);
    assert.doesNotMatch(toolResult.content, /Unknown tool/);
  });

  test("staging a path that does not exist reports back without crashing the loop", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, dispatchConfig);
    const { requests, client } = fakeClient([
      { role: "assistant", content: null, tool_calls: [toolCall("stage_file_for_deletion", { path: "src/ghost.ts" })] },
      { role: "assistant", content: "Nothing to stage." },
    ]);

    await runToolAgent({
      prompt: "Remove the dead module.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: dispatchConfig,
      agentTools: tools,
      models: ["test-model"],
      agentName: "DISCOVERY",
    });

    const toolResult = requests[1].find((m: any) => m.role === "tool");
    assert.match(toolResult.content, /does not exist/i);
    assert.deepEqual(tools.getStagedDeletions(), []);
  });

  test("staging ends the in-loop read streak, exactly like an edit", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, dispatchConfig);
    const readCalls = Array.from({ length: 4 }, (_, i) => toolCall("read_file", { path: `src/f${i}.ts` }, `r${i}`));
    const moreReadCalls = Array.from({ length: 4 }, (_, i) => toolCall("read_file", { path: `src/f${i}.ts` }, `s${i}`));
    const { requests, client } = fakeClient([
      { role: "assistant", content: null, tool_calls: readCalls },
      { role: "assistant", content: null, tool_calls: [toolCall("stage_file_for_deletion", { path: "src/dead.ts" })] },
      { role: "assistant", content: null, tool_calls: moreReadCalls },
      { role: "assistant", content: "Done looking." },
    ]);

    await runToolAgent({
      prompt: "Remove the dead module.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: dispatchConfig,
      agentTools: tools,
      models: ["test-model"],
      // EDITOR, so the in-loop circuit breaker is actually armed.
      agentName: "EDITOR",
    });

    const intervened = requests.some((msgs) =>
      msgs.some((m: any) => typeof m.content === "string" && m.content.includes("[CIRCUIT BREAKER]"))
    );
    assert.equal(
      intervened,
      false,
      "4 reads + staging + 4 reads is only 4 consecutive inspections: the staging call must reset the streak"
    );
  });
});

/**
 * Regression test for a real incident: hitting the round budget used to
 * discard everything gathered and return a bare "Turn limit of N reached"
 * placeholder, with no partial findings or answer — reported directly by the
 * user for Advisor. Fixed by forcing one guaranteed final answer (tools
 * stripped entirely) before giving up, mirroring the same "clear tools, ask
 * it to conclude" pattern Advisor/Planner already use for their own budgets.
 */
describe("runToolAgent — recovers a real answer when the round budget runs out", () => {
  const tempDirs: string[] = [];
  const roundLimitConfig = {
    prompts: { systemPersona: "You are YIMPIM." },
    limits: { maxToolRounds: 2 },
  } as unknown as AgentConfig;

  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function makeRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-turnlimit-test-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "dead.ts"), "export const dead = 1;\n", "utf-8");
    return dir;
  }

  function toolCall(name: string, args: Record<string, unknown>, id: string) {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  /** Replies from a scripted queue, recording every request's messages AND options. */
  function fakeClient(queue: any[]) {
    const requests: any[][] = [];
    const optionsSeen: any[] = [];
    return {
      requests,
      optionsSeen,
      client: {
        async complete(_models: string[], messages: any[], options?: any) {
          requests.push(messages);
          optionsSeen.push(options);
          return { choices: [{ message: queue.shift() ?? { role: "assistant", content: "done" } }] };
        },
      } as any,
    };
  }

  test("a model that never stops calling tools still gets a real final answer, not the placeholder", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, roundLimitConfig);
    const neverConcludes = (id: string) => ({
      role: "assistant",
      content: null,
      tool_calls: [toolCall("read_file", { path: "dead.ts" }, id)],
    });
    const { requests, optionsSeen, client } = fakeClient([
      neverConcludes("r1"),
      neverConcludes("r2"),
      // The forced final call, once the 2-round budget is spent: the ONLY
      // response shape the model can actually produce, since the fix strips
      // every tool from this specific request.
      { role: "assistant", content: "Based on dead.ts, here is my best answer." },
    ]);

    const result = await runToolAgent({
      prompt: "Investigate dead.ts.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: roundLimitConfig,
      agentTools: tools,
      models: ["test-model"],
      agentName: "DISCOVERY",
    });

    assert.equal(result, "Based on dead.ts, here is my best answer.");
    assert.doesNotMatch(result, /Turn limit/);
    assert.equal(requests.length, 3, "2 rounds under the cap, plus exactly one forced final call");
    assert.deepEqual(optionsSeen[2].tools, [], "the forced final call must strip every tool");

    const lastMessage = requests[2][requests[2].length - 1];
    assert.equal(lastMessage.role, "system");
    assert.match(lastMessage.content, /\[TURN LIMIT\]/);
  });

  test("falls back to the placeholder if even the forced final call produces nothing", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, roundLimitConfig);
    const neverConcludes = (id: string) => ({
      role: "assistant",
      content: null,
      tool_calls: [toolCall("read_file", { path: "dead.ts" }, id)],
    });
    const { client } = fakeClient([
      neverConcludes("r1"),
      neverConcludes("r2"),
      { role: "assistant", content: "" },
    ]);

    const result = await runToolAgent({
      prompt: "Investigate dead.ts.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: roundLimitConfig,
      agentTools: tools,
      models: ["test-model"],
      agentName: "DISCOVERY",
    });

    assert.match(result, /Turn limit of 2 reached/);
  });
});

/**
 * Regression tests for maxRoundsOverride — built for a real REPAIR_PLANNER
 * failure: a build failure with 11 reported TypeScript errors across 5-6
 * distinct root causes blew through the Planner-shared 8-round default
 * (REPAIR_PLANNER's own bounded-diagnosis role shares that cap) and came
 * back with "turn_limit reached" and no diagnosis at all, handing REPAIR the
 * entire investigation from a cold start instead of a head start. index.ts
 * now scales REPAIR_PLANNER's round budget by how many failures it's
 * triaging — this locks in that the override actually takes effect.
 */
describe("runToolAgent — maxRoundsOverride", () => {
  const tempDirs: string[] = [];
  const tightDefaultConfig = {
    prompts: { systemPersona: "You are YIMPIM." },
    // A tiny default (well below REPAIR_PLANNER's normal 12-round share of
    // the Planner's cap) -- proves the override replaces this, not merely
    // adds to it.
    limits: { maxToolRounds: 2 },
  } as unknown as AgentConfig;

  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function makeRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-maxroundsoverride-test-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "dead.ts"), "export const dead = 1;\n", "utf-8");
    return dir;
  }

  function toolCall(name: string, args: Record<string, unknown>, id: string) {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  function fakeClient(queue: any[]) {
    const requests: any[][] = [];
    return {
      requests,
      client: {
        async complete(_models: string[], messages: any[], _options?: any) {
          requests.push(messages);
          return { choices: [{ message: queue.shift() ?? { role: "assistant", content: "done" } }] };
        },
      } as any,
    };
  }

  test("a round budget past the agent's own default is honored, not clamped back down to it", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, tightDefaultConfig);
    const readThenConclude = (id: string) => ({
      role: "assistant",
      content: null,
      tool_calls: [toolCall("read_file", { path: "dead.ts" }, id)],
    });
    // 5 read rounds -- already past tightDefaultConfig's own maxToolRounds
    // (2) and past REPAIR_PLANNER's normal 8-round share of the Planner cap
    // would have been irrelevant anyway since this config's default is
    // smaller than that share. The point: all 5 must actually run, proving
    // maxRoundsOverride (6) governs instead of the config default (2).
    const { requests, client } = fakeClient([
      readThenConclude("r1"),
      readThenConclude("r2"),
      readThenConclude("r3"),
      readThenConclude("r4"),
      readThenConclude("r5"),
      { role: "assistant", content: "Root cause: dead.ts never exports what app.ts imports." },
    ]);

    const result = await runToolAgent({
      prompt: "Diagnose the failure.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: tightDefaultConfig,
      agentTools: tools,
      models: ["test-model"],
      agentName: "REPAIR_PLANNER",
      maxRoundsOverride: 6,
    });

    assert.equal(result, "Root cause: dead.ts never exports what app.ts imports.");
    assert.doesNotMatch(result, /Turn limit/);
    assert.equal(requests.length, 6, "all 5 read rounds plus the concluding round must have run");
  });

  test("without an override, REPAIR_PLANNER still falls back to its normal Planner-shared default", async () => {
    const dir = await makeRepo();
    // maxToolRounds here is intentionally larger than the Planner-shared
    // default (12) this agent falls back to without an override, so hitting
    // the limit at round 12 (not the config's own ceiling) proves the normal
    // isPlanner-based default is still what applies.
    const bigConfig = {
      prompts: { systemPersona: "You are YIMPIM." },
      limits: { maxToolRounds: 40 },
    } as unknown as AgentConfig;
    const tools = new AgentTools(dir, bigConfig);
    const neverConcludes = (id: string) => ({
      role: "assistant",
      content: null,
      tool_calls: [toolCall("read_file", { path: "dead.ts" }, id)],
    });
    const { client } = fakeClient([
      ...Array.from({ length: 12 }, (_, i) => neverConcludes(`r${i + 1}`)),
      // The forced final call once the 12-round budget is spent -- empty
      // content so the result falls through to the "Turn limit" placeholder
      // (see the describe block above: a real final answer here would be
      // returned as-is instead, same as that block's own first test).
      { role: "assistant", content: "" },
    ]);

    const result = await runToolAgent({
      prompt: "Diagnose the failure.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: bigConfig,
      agentTools: tools,
      models: ["test-model"],
      agentName: "REPAIR_PLANNER",
    });

    assert.match(result, /Turn limit of 12 reached/);
  });
});

/**
 * Regression tests for the leaked-tool-call detection: a provider that fails
 * to translate a model's native tool-call template into the structured
 * tool_calls field can leak the raw serialization into `content` instead,
 * which ADVISOR (and any other non-editing agent) used to hand straight back
 * as if it were a real prose answer -- the real failure this was built from
 * showed a paired phone an ADVISOR "answer" that was literally malformed
 * `<|DSML|invoke name="read_file">...` tags instead of any actual response.
 */
describe("runToolAgent — leaked tool-call detection", () => {
  const tempDirs: string[] = [];
  const leakedConfig = { prompts: { systemPersona: "You are YIMPIM." } } as AgentConfig;
  const LEAKED = '<|DSML|calls><|DSML|invoke name="read_file"><|DSML|parameter name="path" string="true">app/history.tsx</|DSML|parameter></|DSML|invoke></|DSML|calls>';

  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function makeRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-leakedtoolcall-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function fakeClient(queue: any[]) {
    return {
      client: {
        async complete(_models: string[], _messages: any[]) {
          return { choices: [{ message: queue.shift() ?? { role: "assistant", content: "done" } }] };
        },
      } as any,
    };
  }

  test("ADVISOR retries instead of returning a leaked tool-call attempt as its answer", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, leakedConfig);
    const { client } = fakeClient([
      { role: "assistant", content: LEAKED },
      { role: "assistant", content: "The history screen paginates via a cursor, oldest last." },
    ]);

    const result = await runToolAgent({
      prompt: "How does history paging work?",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: leakedConfig,
      agentTools: tools,
      models: ["test-model"],
      agentName: "ADVISOR",
    });

    assert.equal(result, "The history screen paginates via a cursor, oldest last.");
  });

  test("gives up after the retry cap and returns whatever came back, rather than looping forever", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, leakedConfig);
    const { client } = fakeClient([
      { role: "assistant", content: LEAKED },
      { role: "assistant", content: LEAKED },
      { role: "assistant", content: LEAKED },
    ]);

    const result = await runToolAgent({
      prompt: "How does history paging work?",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: leakedConfig,
      agentTools: tools,
      models: ["test-model"],
      agentName: "ADVISOR",
    });

    assert.equal(result, LEAKED, "after 2 retries (the cap) the 3rd attempt's content is returned as-is");
  });

  test("a genuine prose answer that merely mentions 'invoke' or 'parameter' once is never mistaken for a leak", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, leakedConfig);
    const { client } = fakeClient([
      { role: "assistant", content: "You invoke the function with a single parameter named id." },
    ]);

    const result = await runToolAgent({
      prompt: "How do I call this?",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: leakedConfig,
      agentTools: tools,
      models: ["test-model"],
      agentName: "ADVISOR",
    });

    assert.equal(result, "You invoke the function with a single parameter named id.");
  });

  test("DISCOVERY (not just ADVISOR) also retries a leaked tool-call attempt", async () => {
    const dir = await makeRepo();
    const tools = new AgentTools(dir, leakedConfig);
    const { client } = fakeClient([
      { role: "assistant", content: LEAKED },
      { role: "assistant", content: '```json\n{"shortDescription":"ok"}\n```' },
    ]);

    const result = await runToolAgent({
      prompt: "Map the codebase.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config: leakedConfig,
      agentTools: tools,
      models: ["test-model"],
      agentName: "DISCOVERY",
    });

    assert.match(result, /shortDescription/);
  });
});
