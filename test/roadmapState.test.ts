import { test } from "node:test";
import assert from "node:assert/strict";
import { roadmapStateWire, roadmapWire, type Roadmap } from "../src/roadmap.js";

const unit = (id: string, status: any, extra: object = {}) => ({ id, title: id, area: "a", summary: "s", deps: [], refs: [], acceptance: [], status, order: 1, attempts: 0, addedBy: "plan" as const, ...extra });
const rm = (units: any[]): Roadmap => ({ version: 1, goal: "Build it", kind: "idea", conventions: [], units, createdAt: "2026-11-16T10:00:00.000Z", updatedAt: "2026-11-16T10:00:00.000Z" });

test("the flat snapshot uses the phone's names and statuses", () => {
  const w = roadmapStateWire(roadmapWire(rm([unit("U1", "done"), unit("U2", "in_progress", { taskId: "task-1" }), unit("U3", "todo")])))!;
  assert.equal(w.roadmapId, "2026-11-16T10:00:00.000Z");
  assert.equal(w.title, "Build it");
  assert.deepEqual([w.done, w.total, w.state], [1, 3, "active"]);
  assert.deepEqual(w.units.map((u) => u.status), ["done", "running", "todo"]);
  assert.equal(w.units[1].taskId, "task-1");
  assert.equal(w.units[2].taskId, null);
  assert.equal(w.units[1].summary, null);
});

test("a finished roadmap says finished, and a removed one says reset with the id the phone knows", () => {
  assert.equal(roadmapStateWire(roadmapWire(rm([unit("U1", "done")])))!.state, "finished");
  assert.deepEqual(roadmapStateWire(null, "rid"), { roadmapId: "rid", title: "", done: 0, total: 0, state: "reset", units: [] });
  assert.equal(roadmapStateWire(null), null);
});
