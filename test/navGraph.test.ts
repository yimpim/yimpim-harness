/**
 * Route-finding over nav_map.json. Maps here are invented and deliberately
 * unlike each other (different naming styles, a web-style app, an unregistered
 * source screen) — the module must not depend on any one project's wording.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildNavGraph, findRoute, formatRoute, markEdgesVerified, readNavMap, stepsActuallyTapped, labelsMatch } from "../src/navGraph.js";
import { AgentTools } from "../src/agentTools.js";
import { AgentConfig } from "../src/config.js";

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-navgraph-test-"));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const structured = {
  home: { file: "a", reachedFrom: "launch", isLaunchScreen: true, controls: [{ label: "Pricing", leadsTo: "opens pricing", leadsToScreen: "pricing" }] },
  pricing: {
    file: "b",
    reachedFrom: "home",
    reachedFromScreen: "home",
    reachedViaLabel: "Pricing",
    controls: [
      { label: "Pro lease", leadsTo: "opens pro lease details", leadsToScreen: "pro-lease" },
      { label: "Back", leadsTo: "goes back", leadsToScreen: "home" },
    ],
  },
  "pro-lease": { file: "c", reachedFrom: "pricing", reachedFromScreen: "pricing", reachedViaLabel: "Pro lease", controls: [] },
};

describe("buildNavGraph / findRoute", () => {
  test("finds a multi-hop route from structured fields", () => {
    const g = buildNavGraph(structured);
    const route = findRoute(g, "pro-lease")!;
    assert.deepEqual(route.map((s) => [s.from, s.label, s.to]), [
      ["home", "Pricing", "pricing"],
      ["pricing", "Pro lease", "pro-lease"],
    ]);
  });

  test("a launch screen needs no navigation; an unknown screen has no route", () => {
    const g = buildNavGraph(structured);
    assert.deepEqual(findRoute(g, "home"), []);
    assert.equal(findRoute(g, "nope"), undefined);
  });

  test("no recorded launch screen means no route, rather than a guessed one", () => {
    const noStart = { ...structured, home: { ...structured.home, isLaunchScreen: undefined } };
    assert.equal(findRoute(buildNavGraph(noStart), "pro-lease"), undefined);
  });

  test("a source screen that was referenced but never registered still becomes a node", () => {
    const g = buildNavGraph({
      Settings: { file: "s", reachedFrom: "x", reachedFromScreen: "Menu", reachedViaLabel: "Settings", isLaunchScreen: false, controls: [] },
      Menu: undefined as any,
    });
    assert.ok(g.screens.includes("Menu"));
    assert.ok(g.edges.some((e) => e.from === "Menu" && e.to === "Settings"));
  });

  test("falls back to free-text fields for maps written before the structured ones existed", () => {
    const g = buildNavGraph({
      Home: { file: "a", reachedFrom: "app launch", isLaunchScreen: true, controls: [{ label: "Go", leadsTo: "Details" }] },
      Details: { file: "b", reachedFrom: 'Home, tap "Go"', controls: [] },
    });
    assert.equal(findRoute(g, "Details")?.length, 1);
  });

  test("a control whose prose names two screens is ambiguous and creates no edge", () => {
    const g = buildNavGraph({
      A: { file: "a", reachedFrom: "launch", isLaunchScreen: true, controls: [{ label: "x", leadsTo: "goes from A to B or C" }] },
      B: { file: "b", reachedFrom: "?", controls: [] },
      C: { file: "c", reachedFrom: "?", controls: [] },
    });
    assert.equal(g.edges.length, 0);
  });

  test("junk screen names are ignored", () => {
    const g = buildNavGraph({ undefined: { file: "x", controls: [] }, Real: { file: "y", isLaunchScreen: true, controls: [] } });
    assert.deepEqual(g.screens, ["Real"]);
  });

  test("labelsMatch ignores emoji, case and punctuation", () => {
    assert.ok(labelsMatch("🛒 Market!", "market"));
    assert.ok(!labelsMatch("Market", "Settings"));
  });
});

describe("verified edges", () => {
  test("only tapped steps are marked, and the route then reports them as walked", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, ".agent"));
    await fs.writeFile(path.join(dir, ".agent", "nav_map.json"), JSON.stringify(structured));

    const route = findRoute(buildNavGraph(readNavMap(dir)), "pro-lease")!;
    markEdgesVerified(dir, stepsActuallyTapped(route, ["pricing"]));

    const after = findRoute(buildNavGraph(readNavMap(dir)), "pro-lease")!;
    assert.ok(after[0].verifiedAt);
    assert.equal(after[1].verifiedAt, undefined);
    assert.match(formatRoute("pro-lease", after), /walked successfully/);
    assert.match(formatRoute("pro-lease", after), /never walked/);
  });

  test("re-registering a screen keeps what QA already walked into it", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);
    await tools.registerScreenNav({ screen: "Home", file: "h", isLaunchScreen: true, controls: [{ label: "Go", leadsTo: "x", leadsToScreen: "Next" }] });
    await tools.registerScreenNav({ screen: "Next", file: "n", reachedFromScreen: "Home", reachedViaLabel: "Go", controls: [] });
    markEdgesVerified(dir, [{ from: "Home", label: "Go", to: "Next" }]);
    await tools.registerScreenNav({ screen: "Next", file: "n", reachedFromScreen: "Home", reachedViaLabel: "Go", controls: [] });

    const route = findRoute(buildNavGraph(readNavMap(dir)), "Next")!;
    assert.ok(route[0].verifiedAt);
  });

  test("registerScreenNav rejects a missing screen name instead of storing 'undefined'", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);
    const result = await tools.registerScreenNav({ file: "f", controls: [] } as any);
    assert.match(result, /Not recorded/);
    assert.deepEqual(readNavMap(dir), {});
  });
});

import { markEdgeStale, recordObservedEdge, recordObservedLaunch, canonicalScreenName } from "../src/navGraph.js";

describe("what QA observes at runtime", () => {
  test("with no code analysis at all, observed launch + taps are enough to route", async () => {
    const dir = await makeTempDir();
    recordObservedLaunch(dir, "Landing");
    recordObservedEdge(dir, "Landing", "Pricing", "Plans");
    recordObservedEdge(dir, "Plans", "Pro lease", "Lease details");

    const route = findRoute(buildNavGraph(readNavMap(dir)), "Lease details")!;
    assert.deepEqual(route.map((s) => s.label), ["Pricing", "Pro lease"]);
    assert.ok(route.every((s) => s.verifiedAt), "observed edges count as walked");
    assert.equal(readNavMap(dir)["Plans"].source, "observed");
  });

  test("a control missing from its screen is routed around until something newer confirms it", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, ".agent"));
    await fs.writeFile(path.join(dir, ".agent", "nav_map.json"), JSON.stringify(structured));

    const edge = { from: "home", label: "Pricing", to: "pricing" };
    await new Promise((r) => setTimeout(r, 5));
    markEdgeStale(dir, edge);
    assert.equal(findRoute(buildNavGraph(readNavMap(dir)), "pro-lease"), undefined);

    await new Promise((r) => setTimeout(r, 5));
    markEdgesVerified(dir, [edge]);
    assert.equal(findRoute(buildNavGraph(readNavMap(dir)), "pro-lease")?.length, 2);
  });

  test("re-registering a screen after the stale mark clears it (the code was re-read)", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);
    await tools.registerScreenNav({ screen: "Home", file: "h", isLaunchScreen: true, controls: [{ label: "Go", leadsTo: "x", leadsToScreen: "Next" }] });
    await tools.registerScreenNav({ screen: "Next", file: "n", controls: [] });
    await new Promise((r) => setTimeout(r, 5));
    markEdgeStale(dir, { from: "Home", label: "Go", to: "Next" });
    assert.equal(findRoute(buildNavGraph(readNavMap(dir)), "Next"), undefined);

    await new Promise((r) => setTimeout(r, 5));
    await tools.registerScreenNav({ screen: "Home", file: "h", isLaunchScreen: true, controls: [{ label: "Go", leadsTo: "x", leadsToScreen: "Next" }] });
    assert.equal(findRoute(buildNavGraph(readNavMap(dir)), "Next")?.length, 1);
  });

  test("registering code analysis over an observed screen keeps the observations", async () => {
    const dir = await makeTempDir();
    recordObservedLaunch(dir, "Home");
    recordObservedEdge(dir, "Home", "Go", "Next");
    const tools = new AgentTools(dir, {} as AgentConfig);
    await tools.registerScreenNav({ screen: "Home", file: "h.kt", controls: [] });

    const map = readNavMap(dir);
    assert.equal(map.Home.file, "h.kt");
    assert.equal(findRoute(buildNavGraph(map), "Next")?.length, 1);
  });

  test("canonicalScreenName snaps to a known name and rejects junk", () => {
    assert.equal(canonicalScreenName("pricing page", ["Pricing Page"]), "Pricing Page");
    assert.equal(canonicalScreenName("New Thing", ["A"]), "New Thing");
    assert.equal(canonicalScreenName(null, ["A"]), undefined);
    assert.equal(canonicalScreenName("undefined", ["A"]), undefined);
  });
});
