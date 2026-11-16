import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelPanel } from "../src/modelPanel.js";
import type { CatalogModel, PersonaNeeds } from "../src/models.js";

const persona = (key: string, extra: object = {}): PersonaNeeds => ({ key, label: key[0].toUpperCase() + key.slice(1), blurb: "", requiresTools: true, requiresVision: false, volume: "low", ...extra }) as PersonaNeeds;
const model = (id: string): CatalogModel => ({ id, name: id, contextLength: 1, promptCost: 1, completionCost: 1, supportsTools: true, supportsVision: false });
const flush = () => new Promise((r) => setTimeout(r, 5));

function setup(personas = [persona("editor"), persona("planner"), persona("editorVision", { optional: true }), persona("designer", { multi: { min: 1, max: 3 } })]) {
  const chosen: [string, string[] | undefined][] = [];
  let updates = 0;
  const panel = new ModelPanel({
    personas: personas as any,
    current: (r) => (r === "editor" ? ["a/old", "a/backup"] : undefined),
    pending: () => undefined,
    candidates: async () => [model("x/alpha"), model("y/beta"), model("x/gamma")],
    format: (m) => m.id,
    choose: (r, c) => chosen.push([r, c]),
    onUpdate: () => updates++,
  });
  return { panel, chosen, updates: () => updates };
}
const enter = { name: "return" };

test("pick a role, filter, choose: the backup model is kept", async () => {
  const { panel, chosen } = setup();
  assert.match(panel.rows().join("\n"), /Change a model/);
  assert.equal(panel.key(undefined, enter), "redraw");
  await flush();
  for (const ch of "gam") panel.key(ch, {});
  assert.match(panel.rows().join("\n"), /x\/gamma/);
  assert.doesNotMatch(panel.rows().join("\n"), /y\/beta/);
  assert.equal(panel.key(undefined, enter), "close");
  assert.deepEqual(chosen, [["editor", ["x/gamma", "a/backup"]]]);
});

test("arrows move, Esc goes back and then closes", async () => {
  const { panel } = setup();
  panel.key(undefined, { name: "down" });
  panel.key(undefined, enter);
  await flush();
  assert.match(panel.rows()[0], /Planner/);
  assert.equal(panel.key(undefined, { name: "escape" }), "redraw");
  assert.match(panel.rows()[0], /Change a model/);
  assert.equal(panel.key(undefined, { name: "escape" }), "close");
});

test("an optional role can be cleared, and a multi-model role points to the idle menu", async () => {
  const { panel, chosen } = setup();
  panel.key(undefined, { name: "down" });
  panel.key(undefined, { name: "down" });
  panel.key(undefined, enter);
  await flush();
  assert.match(panel.rows().join("\n"), /leave this role unset/);
  assert.equal(panel.key(undefined, enter), "close");
  assert.deepEqual(chosen, [["editorVision", undefined]]);

  const b = setup();
  for (let i = 0; i < 3; i++) b.panel.key(undefined, { name: "down" });
  b.panel.key(undefined, enter);
  assert.match(b.panel.rows().join("\n"), /idle \/model menu/);
});

test("a long list is windowed and a failed catalog says why", async () => {
  const many = Array.from({ length: 40 }, (_, i) => persona(`r${i}`));
  const { panel } = setup(many);
  assert.ok(panel.rows().length <= 9);
  const failing = new ModelPanel({ personas: [persona("editor")] as any, current: () => undefined, pending: () => undefined, candidates: async () => { throw new Error("no key"); }, format: (m) => m.id, choose: () => {}, onUpdate: () => {} });
  failing.key(undefined, enter);
  await flush();
  assert.match(failing.rows().join("\n"), /Could not load models: no key/);
});
