/**
 * A roadmap holds a large job above any one task: what is needed, what depends
 * on what, what is done, and what no unit covers yet.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_UNITS,
  addUnits,
  coverage,
  emptyRoadmap,
  findCycles,
  loadRoadmap,
  markBlocked,
  markDone,
  markDropped,
  markStarted,
  nextUnits,
  progress,
  renderRoadmap,
  reopen,
  roadmapPath,
  saveRoadmap,
  setConventions,
  unitTaskPrompt,
  validateRoadmap,
  waitingUnits,
} from "../src/roadmap.js";

const rm = () => emptyRoadmap("Rebuild the Android app for iOS", "port");
const seeded = () => {
  const r = rm();
  addUnits(r, [
    { title: "Theme and design tokens", area: "Foundation", summary: "Colors, type, spacing." },
    { title: "Data models", area: "Foundation", summary: "Entities." },
    { title: "Network layer", area: "Foundation", deps: ["Data models"] },
    { title: "Cart screen", area: "Shopping", deps: ["Theme and design tokens", "Data models", "Network layer"], refs: ["ref/Cart.kt"] },
    { title: "Checkout screen", area: "Shopping", deps: ["Cart screen"], refs: ["ref/Checkout.kt"] },
  ]);
  return r;
};

describe("adding units", () => {
  test("ids are assigned in order, titles in deps are resolved, and the order is kept", () => {
    const r = seeded();
    assert.deepEqual(r.units.map((u) => u.id), ["U001", "U002", "U003", "U004", "U005"]);
    assert.deepEqual(r.units[3].deps, ["U001", "U002", "U003"]);
    assert.deepEqual(r.units.map((u) => u.order), [1, 2, 3, 4, 5]);
  });

  test("adding the same unit again updates it instead of duplicating it", () => {
    const r = seeded();
    const res = addUnits(r, [{ title: "cart  screen", area: "shopping", summary: "Now with promo codes.", refs: ["ref/Cart.kt", "ref/Promo.kt"] }]);
    assert.equal(r.units.length, 5);
    assert.equal(res.updated.length, 1);
    assert.equal(res.updated[0].summary, "Now with promo codes.");
    assert.deepEqual(res.updated[0].refs, ["ref/Cart.kt", "ref/Promo.kt"]);
    assert.deepEqual(res.updated[0].deps, ["U001", "U002", "U003"], "fields not mentioned are kept");
  });

  test("a unit that is already done is left alone and reported", () => {
    const r = seeded();
    markDone(r, "U001", { files: ["src/theme.ts"] });
    const res = addUnits(r, [{ title: "Theme and design tokens", area: "Foundation", summary: "changed" }]);
    assert.equal(res.updated.length, 0);
    assert.match(res.skipped[0], /U001 .* \(already done\)/);
    assert.notEqual(r.units[0].summary, "changed");
  });

  test("a new unit can depend on a unit proposed in the same batch, in either order", () => {
    const r = rm();
    addUnits(r, [{ title: "Screen", deps: ["Model"] }, { title: "Model" }]);
    assert.deepEqual(r.units[0].deps, [r.units[1].id]);
  });

  test("a dependency that names nothing, or itself, is dropped with a warning", () => {
    const r = rm();
    const res = addUnits(r, [{ title: "Lonely", deps: ["Nothing like this", "Lonely"] }]);
    assert.deepEqual(r.units[0].deps, []);
    assert.equal(res.warnings.length, 2);
  });

  test("a circular dependency is broken, not stored", () => {
    const r = rm();
    const res = addUnits(r, [{ title: "A", deps: ["B"] }, { title: "B", deps: ["A"] }]);
    assert.deepEqual(findCycles(r), []);
    assert.ok(res.warnings.some((w) => /circular/.test(w)));
  });

  test("the roadmap has a size limit and says so", () => {
    const r = rm();
    const res = addUnits(r, Array.from({ length: MAX_UNITS + 5 }, (_, i) => ({ title: `Unit ${i}` })));
    assert.equal(r.units.length, MAX_UNITS);
    assert.ok(res.warnings.some((w) => /roadmap is full/.test(w)));
  });
});

describe("what is next", () => {
  test("only units whose dependencies are done, lowest order first", () => {
    const r = seeded();
    assert.deepEqual(nextUnits(r, 5).map((u) => u.id), ["U001", "U002"]);
    markDone(r, "U001", { files: [] });
    markDone(r, "U002", { files: [] });
    assert.deepEqual(nextUnits(r, 5).map((u) => u.id), ["U003"]);
  });

  test("a unit already in progress comes first, so a resumed job picks up where it stopped", () => {
    const r = seeded();
    markStarted(r, "U002");
    assert.equal(nextUnits(r, 1)[0].id, "U002");
    assert.equal(r.units[1].attempts, 1);
  });

  test("a dropped dependency no longer holds work up", () => {
    const r = seeded();
    markDone(r, "U001", { files: [] });
    markDone(r, "U002", { files: [] });
    markDropped(r, "U003", "not needed");
    assert.deepEqual(nextUnits(r, 5).map((u) => u.id), ["U004"]);
  });

  test("it says what each waiting unit is waiting for", () => {
    const w = waitingUnits(seeded());
    const cart = w.find((x) => x.unit.id === "U004")!;
    assert.deepEqual(cart.waitingFor.map((u) => u.id), ["U001", "U002", "U003"]);
  });

  test("a blocked unit is not offered, and reopening puts it back", () => {
    const r = seeded();
    markBlocked(r, "U001", "needs a design decision");
    assert.ok(!nextUnits(r, 5).some((u) => u.id === "U001"));
    reopen(r, "U001");
    assert.ok(nextUnits(r, 5).some((u) => u.id === "U001"));
  });
});

describe("recording what is done", () => {
  test("a finished unit keeps the commit and files it produced", () => {
    const r = seeded();
    markDone(r, "u001", { commit: "abc1234", files: ["src/theme.ts", "src\\tokens.ts"], summary: "Tokens in place." });
    assert.equal(r.units[0].status, "done");
    assert.deepEqual(r.units[0].done!.files, ["src/theme.ts", "src/tokens.ts"]);
    assert.equal(r.units[0].done!.commit, "abc1234");
  });

  test("progress counts dropped units out of the total", () => {
    const r = seeded();
    markDone(r, "U001", { files: [] });
    markDropped(r, "U005");
    const p = progress(r);
    assert.deepEqual({ total: p.total, done: p.done, dropped: p.dropped, percent: p.percent }, { total: 4, done: 1, dropped: 1, percent: 25 });
  });
});

describe("making sure nothing was missed", () => {
  test("reference files no unit covers are reported, and covered paths that are not there", () => {
    const r = seeded();
    const c = coverage(r, ["ref/Cart.kt", "ref/Checkout.kt", "ref/Profile.kt", "ref/Search.kt"]);
    assert.deepEqual(c.uncovered, ["ref/Profile.kt", "ref/Search.kt"]);
    assert.deepEqual(c.unknown, []);
    addUnits(r, [{ title: "Ghost", refs: ["ref/Deleted.kt"] }]);
    assert.deepEqual(coverage(r, ["ref/Cart.kt", "ref/Checkout.kt"]).unknown, ["ref/Deleted.kt"]);
  });

  test("a dropped unit's files count as uncovered again, so dropping cannot hide them", () => {
    const r = seeded();
    markDropped(r, "U004");
    assert.ok(coverage(r, ["ref/Cart.kt", "ref/Checkout.kt"]).uncovered.includes("ref/Cart.kt"));
  });

  test("validation finds an unknown dependency and a loop", () => {
    const r = seeded();
    r.units[0].deps = ["U999"];
    assert.ok(validateRoadmap(r).some((i) => /depends on unknown U999/.test(i)));
    r.units[0].deps = ["U005"];
    assert.ok(validateRoadmap(r).some((i) => /circular dependency/.test(i)));
  });
});

describe("telling a person where things stand", () => {
  test("progress, what is next, what is stuck, and units by area", () => {
    const r = seeded();
    markDone(r, "U001", { files: [] });
    markBlocked(r, "U003", "waiting on an API key");
    const text = renderRoadmap(r);
    assert.match(text, /Roadmap: Rebuild the Android app for iOS/);
    assert.match(text, /1\/5 done \(20%\).*1 blocked/);
    assert.match(text, /Next up:\n {2}U002/);
    assert.match(text, /U003.*waiting on an API key/);
    assert.match(text, /Foundation \(1\/3\)/);
    assert.match(text, /\[x\] U001 Theme and design tokens/);
    assert.match(text, /\[!\] U003/);
  });

  test("a long roadmap is cut with a count, not dumped", () => {
    const r = rm();
    addUnits(r, Array.from({ length: 80 }, (_, i) => ({ title: `Unit ${i}`, area: "A" })));
    assert.match(renderRoadmap(r, { maxUnits: 20 }), /more unit\(s\) not shown/);
  });
});

describe("the task a unit becomes", () => {
  test("it carries the goal, the unit, its reference files, what is already built, the conventions, and what not to build", () => {
    const r = seeded();
    setConventions(r, ["Use SwiftUI and MVVM", "One folder per feature"]);
    markDone(r, "U001", { files: ["Sources/Theme/Tokens.swift"] });
    markDone(r, "U002", { files: ["Sources/Models/Item.swift"] });
    markDone(r, "U003", { files: ["Sources/Net/Client.swift"] });
    const text = unitTaskPrompt(r, r.units[3]);
    assert.match(text, /ROADMAP UNIT U004: Cart screen .*unit 4 of 5; 3 already done/);
    assert.match(text, /Overall goal: Rebuild the Android app for iOS/);
    assert.match(text, /- ref\/Cart\.kt/);
    assert.match(text, /U003 Network layer \(this unit depends on it\): Sources\/Net\/Client\.swift/);
    assert.match(text, /- Use SwiftUI and MVVM/);
    assert.match(text, /Do NOT build these here; other units own them: Checkout screen/);
    assert.match(text, /Stay inside this unit/);
  });

  test("it does not list the unit itself or finished units as work to avoid", () => {
    const r = seeded();
    markDone(r, "U001", { files: [] });
    const later = unitTaskPrompt(r, r.units[1]).split("Do NOT build these here; other units own them:")[1];
    assert.doesNotMatch(later, /Theme and design tokens/);
    assert.doesNotMatch(later, /Data models/);
  });
});

describe("remembering it", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "rm-"));

  test("it is one file, written whole, and reads back the same", () => {
    const d = dir();
    const r = seeded();
    markDone(r, "U001", { files: ["a.ts"] });
    saveRoadmap(d, r);
    assert.deepEqual(fs.readdirSync(path.join(d, ".agent")), ["roadmap.json"]);
    const back = loadRoadmap(d)!;
    assert.equal(back.units.length, 5);
    assert.equal(back.units[0].status, "done");
  });

  test("saving again replaces it; it does not grow", () => {
    const d = dir();
    const r = seeded();
    saveRoadmap(d, r);
    const size = fs.statSync(roadmapPath(d)).size;
    saveRoadmap(d, r);
    saveRoadmap(d, r);
    assert.equal(fs.statSync(roadmapPath(d)).size, size);
  });

  test("a missing or unreadable file is no roadmap, not a crash", () => {
    const d = dir();
    assert.equal(loadRoadmap(d), undefined);
    fs.mkdirSync(path.join(d, ".agent"));
    fs.writeFileSync(roadmapPath(d), "{ not json");
    assert.equal(loadRoadmap(d), undefined);
  });
});
