/**
 * The phone's roadmap card: the whole roadmap on the wire (summaries clipped, no acceptance lists), sent whenever it changes,
 * and a roadmap unit's task says which unit it is.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addUnits, emptyRoadmap, markBlocked, markDone, markDropped, markStarted, onRoadmapChanged, roadmapWire, saveRoadmap } from "../src/roadmap.js";
import { resetRoadmap } from "../src/roadmapFlow.js";

const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf-8");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rmw-"));

describe("what the phone is sent", () => {
  test("no roadmap is null; otherwise the whole thing, in order, with counts and the running unit", () => {
    assert.equal(roadmapWire(undefined), null);
    const rm = emptyRoadmap("Rebuild the app", "port");
    addUnits(rm, [
      { title: "Sign-in screen", area: "Auth", summary: "Email and password.", acceptance: ["a test passes"], refs: ["ref/a.ts"] },
      { title: "History list", area: "History", summary: "x".repeat(500) },
      { title: "Settings", area: "Settings" },
      { title: "Old idea", area: "Misc" },
    ]);
    const [a, b, c, d] = rm.units;
    markStarted(rm, a.id);
    markDone(rm, a.id, { commit: "a1b2c3d", files: ["src/a.ts", "src/b.ts"], summary: "Added the sign-in screen." });
    markStarted(rm, b.id);
    markBlocked(rm, c.id, "needs an API key");
    markDropped(rm, d.id, "not needed");
    const w = roadmapWire(rm)!;
    assert.deepEqual([w.done, w.total, w.activeUnitId, w.kind], [1, 3, b.id, "port"]);
    assert.deepEqual(w.units.map((u) => u.status), ["done", "in_progress", "blocked", "dropped"]);
    assert.deepEqual(w.units[0].result, { summary: "Added the sign-in screen.", fileCount: 2, commit: "a1b2c3d" });
    assert.equal(w.units[1].summary.length, 200, "summaries are clipped");
    assert.equal(w.units[2].blockedReason, "needs an API key");
    assert.equal("acceptance" in w.units[0], false, "acceptance lists stay on the desktop");
    assert.equal("refs" in w.units[0], false);
    assert.equal(w.units[1].result, undefined, "only a finished unit has a result");
    JSON.parse(JSON.stringify(w));
  });
});

describe("when it is sent", () => {
  test("every save and a reset tell the listener, and the listener can be removed", () => {
    const root = tmp();
    const seen: string[] = [];
    const off = onRoadmapChanged((r) => seen.push(r));
    const rm = emptyRoadmap("g", "idea");
    saveRoadmap(root, rm);
    resetRoadmap(root);
    assert.deepEqual(seen, [root, root]);
    off();
    saveRoadmap(root, rm);
    assert.equal(seen.length, 2);
  });
  test("a listener that throws does not break the save", () => {
    const root = tmp();
    const off = onRoadmapChanged(() => {
      throw new Error("boom");
    });
    try {
      saveRoadmap(root, emptyRoadmap("g", "idea"));
      assert.ok(fs.existsSync(path.join(root, ".agent", "roadmap.json")));
    } finally {
      off();
    }
  });
});

describe("the protocol", () => {
  test("a new event, a new always-allowed read, never stored in history, and a unit id on task.start", () => {
    const proto = src("remote/protocol.ts");
    assert.match(proto, /\| \{ verb: "get_roadmap" \}/);
    assert.match(proto, /ALWAYS_ALLOWED: VerbName\[\] = \[[^\]]*"get_roadmap"/);
    assert.match(proto, /kind: "roadmap\.state"; roadmap: import\("\.\.\/roadmap\.js"\)\.RoadmapWire \| null/);
    assert.match(proto, /kind: "task\.start"; taskId: string; runId: string; prompt: string; attachments: string\[\]; [^}]*roadmapUnitId\?: string/);
    const client = src("remote/client.ts");
    assert.match(client, /NOT_PERSISTED_KINDS = new Set\(\[[\s\S]*?"roadmap\.state"/);
    assert.match(client, /case "get_roadmap":\s*this\.handlers\?\.onGetRoadmap\?\.\(\);/);
    assert.match(client, /pushRoadmapState\(roadmap: RoadmapWire \| null\)/);
  });
  test("the desktop sends it when a phone connects, on every change, on request, and tags a unit's task", () => {
    const idx = src("index.ts");
    assert.match(idx, /session\.pushRoadmapState\(roadmapWire\(loadRoadmap\(repoRoot\)\)\);\s*const stopRoadmapFeed = onRoadmapChanged/);
    assert.match(idx, /onGetRoadmap: \(\) => \{\s*session\.pushRoadmapState\(roadmapWire\(loadRoadmap\(repoRoot\)\)\);/);
    assert.match(idx, /\.\.\.\(activeUnitId \? \{ roadmapUnitId: activeUnitId, roadmapId: loadRoadmap\(repoRoot\)\?\.createdAt \} : \{\}\),/);
    assert.match(idx, /const teardown = \(\) => \{ stopRoadmapFeed\(\);/);
  });
});
