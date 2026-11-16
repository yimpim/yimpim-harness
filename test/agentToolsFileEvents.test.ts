/**
 * Regression tests for the `file.write` internal event that writeFile/
 * patchFile now emit alongside their existing console.log diff-stat hint —
 * this is what lets a paired phone/native client show real per-file diff
 * stats instead of regex-scraping the console text (see docs/REMOTE_SPEC.md's
 * `file.changed` wire event).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTools } from "../src/agentTools.js";
import { AgentConfig } from "../src/config.js";
import { events, YimpimEvent } from "../src/events.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-file-events-test-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function captureFileWrites(): { events: Extract<YimpimEvent, { type: "file.write" }>[]; stop: () => void } {
  const seen: Extract<YimpimEvent, { type: "file.write" }>[] = [];
  const unsubscribe = events.onEmit((e) => {
    if (e.type === "file.write") seen.push(e);
  });
  return { events: seen, stop: unsubscribe };
}

describe("AgentTools file.write event", () => {
  test("writeFile on a brand-new file emits created:true with added == its line count", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.setActiveAgent("EDITOR");
    const capture = captureFileWrites();

    await tools.writeFile("New.kt", "line1\nline2\nline3");

    capture.stop();
    assert.equal(capture.events.length, 1);
    assert.equal(capture.events[0].agent, "EDITOR");
    assert.equal(capture.events[0].path, "New.kt");
    assert.equal(capture.events[0].created, true);
    assert.equal(capture.events[0].added, 3);
    assert.equal(capture.events[0].removed, 0);
  });

  test("writeFile overwriting an existing file emits created:false with a real diff stat", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.setActiveAgent("EDITOR");
    await tools.writeFile("Existing.kt", "a\nb\nc");

    const capture = captureFileWrites();
    await tools.writeFile("Existing.kt", "a\nb\nc\nd");
    capture.stop();

    assert.equal(capture.events.length, 1);
    assert.equal(capture.events[0].created, false);
    assert.equal(capture.events[0].added, 1);
    assert.equal(capture.events[0].removed, 0);
  });

  test("patchFile always emits created:false", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.setActiveAgent("REPAIR");
    await tools.writeFile("Patch.kt", "fun old() {}\n");

    const capture = captureFileWrites();
    await tools.patchFile("Patch.kt", "fun old() {}\n", "fun renamed() {}\n");
    capture.stop();

    assert.equal(capture.events.length, 1);
    assert.equal(capture.events[0].agent, "REPAIR");
    assert.equal(capture.events[0].created, false);
    assert.equal(capture.events[0].path, "Patch.kt");
  });

  test("a failed patchFile throws and is NOT recorded as a written file", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.setActiveAgent("EDITOR");
    await tools.writeFile("Target.kt", "fun keepMe() {}\n");
    tools.beginPhase(["Target.kt"]);

    const capture = captureFileWrites();
    await assert.rejects(
      () => tools.patchFile("Target.kt", "this block does not exist", "replacement"),
      /Search block not found in Target\.kt/
    );
    capture.stop();

    // The write never reached disk, so the phase must not claim it did.
    assert.deepEqual(tools.filesWrittenThisPhase(), []);
    assert.equal(capture.events.length, 0);
    assert.equal(await fs.readFile(path.join(dir, "Target.kt"), "utf-8"), "fun keepMe() {}\n");
  });

  test("an ambiguous patchFile throws and is NOT recorded as a written file", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);
    await tools.writeFile("Dup.kt", "val x = 1\nval x = 1\n");
    tools.beginPhase(["Dup.kt"]);

    await assert.rejects(() => tools.patchFile("Dup.kt", "val x = 1\n", "val y = 2\n"), /Ambiguous patch/);

    assert.deepEqual(tools.filesWrittenThisPhase(), []);
  });

  test("a successful patchFile records the write exactly once", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);
    await tools.writeFile("Ok.kt", "fun old() {}\n");
    tools.beginPhase(["Ok.kt"]);
    assert.deepEqual(tools.filesWrittenThisPhase(), []);

    const capture = captureFileWrites();
    await tools.patchFile("Ok.kt", "fun old() {}\n", "fun renamed() {}\n");
    capture.stop();

    assert.deepEqual(tools.filesWrittenThisPhase(), ["Ok.kt"]);
    assert.equal(capture.events.length, 1);
    assert.equal(await fs.readFile(path.join(dir, "Ok.kt"), "utf-8"), "fun renamed() {}\n");
  });

  test("emits regardless of whether the NDJSON event stream is enabled (matches onEmit's contract)", async () => {
    assert.equal(events.isEnabled(), false);
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.setActiveAgent("EDITOR");
    const capture = captureFileWrites();

    await tools.writeFile("StillFires.kt", "x");

    capture.stop();
    assert.equal(capture.events.length, 1);
  });
});
