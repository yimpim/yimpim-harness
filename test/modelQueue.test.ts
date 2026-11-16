import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelQueue, renderModelStrip, type ModelChange } from "../src/modelQueue.js";

const make = () => {
  const models: Record<string, any> = { editor: ["a/old"], planner: ["p/one"], verifier: ["v/one"], editorVision: undefined };
  const q = new ModelQueue(models, ["editor", "planner", "verifier", "editorVision"]);
  const seen: ModelChange[] = [];
  q.onChange((c) => seen.push(c));
  return { models, q, seen };
};

test("an idle role takes the change at once", () => {
  const { models, q } = make();
  assert.equal(q.queue("editor", ["b/new"]), "applied");
  assert.deepEqual(models.editor, ["b/new"]);
});

test("a working role keeps its model until it finishes, then switches", () => {
  const { models, q, seen } = make();
  q.agentStarted("EDITOR");
  assert.equal(q.queue("editor", ["b/new"]), "queued");
  assert.deepEqual(models.editor, ["a/old"]);
  assert.deepEqual(q.pendingFor("editor"), ["b/new"]);
  q.agentEnded("EDITOR");
  assert.deepEqual(models.editor, ["b/new"]);
  assert.equal(q.hasPending(), false);
  assert.deepEqual(seen.map((c) => c.when), ["queued", "applied"]);
});

test("a role's vision twin is busy with it, and other roles are not blocked", () => {
  const { models, q } = make();
  q.agentStarted("EDITOR");
  assert.equal(q.queue("editorVision", ["v/img"]), "queued");
  assert.equal(q.queue("planner", ["p/two"]), "applied");
  assert.deepEqual(models.planner, ["p/two"]);
  assert.equal(models.editorVision, undefined);
  q.agentEnded("EDITOR");
  assert.deepEqual(models.editorVision, ["v/img"]);
});

test("nested starts need every end, QA sub-roles map to the verifier, and unknown labels are idle", () => {
  const { models, q } = make();
  q.agentStarted("VERIFIER");
  q.agentStarted("verifier-nav");
  q.queue("verifier", ["v/two"]);
  q.agentEnded("verifier-nav");
  assert.deepEqual(models.verifier, ["v/one"]);
  q.agentEnded("VERIFIER");
  assert.deepEqual(models.verifier, ["v/two"]);
  q.agentStarted("SOMETHING_ELSE");
  assert.equal(q.queue("editor", ["c/x"]), "applied");
});

test("a direct assignment wins and discards what was waiting", () => {
  const { models, q } = make();
  q.agentStarted("EDITOR");
  q.queue("editor", ["b/new"]);
  models.editor = ["z/direct"];
  assert.deepEqual(models.editor, ["z/direct"]);
  q.agentEnded("EDITOR");
  assert.deepEqual(models.editor, ["z/direct"]);
});

test("clearing an optional role waits like any change, and the strip marks what is waiting", () => {
  const { models, q } = make();
  models.editorVision = ["v/img"];
  q.agentStarted("EDITOR");
  q.queue("editorVision", undefined);
  assert.deepEqual(models.editorVision, ["v/img"]);
  const roles = [{ key: "editor", label: "Editor" }, { key: "editorVision", label: "Editor (Vision)" }];
  q.queue("editor", ["b/new"]);
  const strip = renderModelStrip(q, roles, ["editor", "editorVision"]);
  assert.match(strip, /editor old→new\*/);
  assert.match(strip, /editorVision img→unset\*/);
  q.agentEnded("EDITOR");
  assert.equal(models.editorVision, undefined);
});
