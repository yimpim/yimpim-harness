import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PERSONAS, candidatesFor, chainProblem, roleInfoWire, type CatalogModel } from "../src/models.js";

const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf-8");
const persona = (k: string) => PERSONAS.find((p) => p.key === k)!;
const cat = (id: string, tools: boolean, vision: boolean, cost = 1): CatalogModel => ({ id, promptCost: cost, completionCost: cost, contextLength: 8000, supportsTools: tools, supportsVision: vision });

describe("the specialist roles are in the picker", () => {
  test("Designer, Designer Judge (Vision) and security exist, are optional, and are kept out of first-run setup", () => {
    for (const k of ["designer", "designerVision", "security"]) {
      const p = persona(k);
      assert.ok(p, k);
      assert.equal(p.optional, true, `${k} may be unset`);
      assert.equal(p.advanced, true, `${k} is not asked in the setup wizard`);
    }
    assert.ok(!PERSONAS.slice(0, 9).some((p) => p.advanced), "the original nine roles are unchanged and still asked");
    assert.deepEqual(PERSONAS.map((p) => p.key).slice(0, 9), ["discovery", "discoveryVision", "planner", "editor", "editorVision", "repair", "repairVision", "verifier", "verifierVision"]);
  });
  test("the logo roles take a set of models; security takes a primary and a backup", () => {
    assert.deepEqual(persona("designer").multi, { min: 1, max: 6 });
    assert.deepEqual(persona("designerVision").multi, { min: 1, max: 4 });
    assert.equal(persona("security").multi, undefined);
  });
  test("each role is offered only the models it can use: the judge needs vision, the others do not", () => {
    const catalog = [cat("a/text", false, false, 1), cat("b/vision", false, true, 2), cat("c/tools", true, false, 3)];
    assert.deepEqual(candidatesFor(catalog, persona("designerVision")).map((m) => m.id), ["b/vision"]);
    assert.deepEqual(candidatesFor(catalog, persona("designer")).map((m) => m.id), ["a/text", "b/vision", "c/tools"]);
    assert.deepEqual(candidatesFor(catalog, persona("security")).map((m) => m.id), ["a/text", "b/vision", "c/tools"]);
  });
  test("setup skips the specialist roles and still has a slot for them in its result", () => {
    const setup = src("setup.ts");
    assert.match(setup, /if \(persona\.advanced\) continue;/);
    assert.match(setup, /designer: \[\], designerVision: \[\], security: \[\],/);
  });
});

describe("what the desktop tells a phone about each role", () => {
  test("every role is described: label, blurb, optional, multi, needs, volume", () => {
    const info = roleInfoWire();
    assert.equal(info.length, PERSONAS.length);
    assert.deepEqual(info.map((i) => i.role), PERSONAS.map((p) => p.key));
    const d = info.find((i) => i.role === "designer")!;
    assert.deepEqual([d.label, d.optional, d.multi, d.needsVision], ["Designer", true, { min: 1, max: 6 }, false]);
    assert.match(d.blurb, /Pick 3 from different providers/);
    const e = info.find((i) => i.role === "editor")!;
    assert.deepEqual([e.optional, e.multi, e.needsTools, e.volume], [false, null, true, "high"]);
    assert.equal(info.find((i) => i.role === "designerVision")!.needsVision, true);
    assert.equal(info.find((i) => i.role === "designerVision")!.label, "Designer Judge (Vision)", "named like the other vision roles");
    JSON.parse(JSON.stringify(info));
  });
  test("model.config carries roleInfo on the wire, and an older phone ignoring it still has roles and scope", () => {
    const client = src("remote/client.ts");
    assert.match(client, /pushModelConfig\(roles: \{ role: Persona; chain: string\[\] \}\[\], scope: "project" \| "global", roleInfo\?: RoleInfoWire\[\]\)/);
    assert.match(client, /roleInfo \? \{ roles, scope, roleInfo \} : \{ roles, scope \}/);
    const proto = src("remote/protocol.ts");
    assert.match(proto, /kind: "model\.config"; roles: \{ role: Persona; chain: string\[\] \}\[\]; scope: "project" \| "global";[\s\S]*?roleInfo\?: RoleInfoWire\[\]/);
    const idx = src("index.ts");
    assert.equal((idx.match(/pushModelConfig\(currentModelConfig\(config\), locateConfigFile\(repoRoot\) \? "project" : "global", roleInfoWire\(\)\)/g) ?? []).length, 2, "both the initial push and the one after set_model carry it");
  });
});

describe("what set_model accepts", () => {
  test("a normal role takes a primary and at most one backup", () => {
    const editor = persona("editor");
    assert.equal(chainProblem(editor, ["a/x"]), null);
    assert.equal(chainProblem(editor, ["a/x", "b/y"]), null);
    assert.match(chainProblem(editor, ["a/x", "b/y", "c/z"])!, /primary and at most one backup/);
  });
  test("a set role takes up to its maximum, and no repeats or blanks", () => {
    const d = persona("designer");
    assert.equal(chainProblem(d, ["a/1", "b/2", "c/3", "d/4", "e/5", "f/6"]), null);
    assert.match(chainProblem(d, ["a/1", "b/2", "c/3", "d/4", "e/5", "f/6", "g/7"])!, /at most 6 models/);
    assert.match(chainProblem(persona("designerVision"), ["a", "b", "c", "d", "e"])!, /at most 4 models/);
    assert.match(chainProblem(d, ["a/1", "a/1"])!, /listed twice/);
    assert.match(chainProblem(d, ["a/1", " "])!, /empty/);
    assert.match(chainProblem(d, ["a/1", 5 as any])!, /empty/);
  });
  test("the remote handler refuses an unacceptable chain with the reason, and the desktop /model builds a set", () => {
    const idx = src("index.ts");
    assert.match(idx, /const problem = chainProblem\(persona, chain\);\s*if \(problem\) \{\s*refuse\(problem\);\s*return;\s*\}/);
    // The desktop picker (setup, /model and the specialist question share it) builds a set for a multi-model role.
    assert.match(src("wizard/modelPicker.ts"), /if \(persona\.multi\) \{[\s\S]*?model \$\{chain\.length \+ 1\} of up to \$\{persona\.multi\.max\}[\s\S]*?chain\.push\(next\);/);
  });
});
