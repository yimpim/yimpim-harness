/**
 * QA's agent on an iOS Simulator. simctl is faked, so this runs anywhere.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { iosBackend, IOS_PRIVACY_SERVICES } from "../src/qaIosBackend.js";
import { qaAgentSystemPrompt, qaCatalog, runQaAgent } from "../src/qaBrowserAgent.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const make = () => {
  const calls: string[][] = [];
  const state = { appearance: "light", size: "large" };
  const exec = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "ui" && args[2] === "appearance") {
      if (args[3]) state.appearance = args[3];
      return state.appearance + "\n";
    }
    if (args[0] === "ui" && args[2] === "content_size") {
      if (args[3]) state.size = args[3];
      return state.size + "\n";
    }
    return "ok";
  };
  const backend = iosBackend({ exec, bundleId: "com.example.app", shoot: async () => PNG });
  return { backend, calls, state };
};

describe("the iOS backend", () => {
  test("it has no tap or type tool, and says so in its prompt", () => {
    const { backend } = make();
    const names = backend.tools.map((t) => t.name);
    assert.ok(!names.some((n) => /tap|type|click/.test(n)));
    const p = qaAgentSystemPrompt("iOS Simulator", qaCatalog(backend), "ios", undefined);
    assert.match(p, /on an iOS Simulator/);
    assert.match(p, /this simulator has no tap tool/);
    assert.match(p, /put back when you finish/);
  });

  test("it starts from the simulator's real appearance", () => {
    assert.equal(make().backend.state().scheme, "light");
  });

  test("appearance changes through simctl, and is put back", async () => {
    const { backend, calls, state } = make();
    const out = await backend.run("set_appearance", { value: "dark" });
    assert.match(out.retake!, /dark/);
    assert.equal(backend.state().scheme, "dark");
    assert.deepEqual(calls.find((c) => c[3] === "dark"), ["ui", "booted", "appearance", "dark"]);
    await backend.restore!();
    assert.equal(state.appearance, "light");
  });

  test("text size, location and permissions are all undone", async () => {
    const { backend, calls, state } = make();
    await backend.run("set_text_size", { value: "accessibility-extra-large" });
    await backend.run("set_location", { latitude: 37.77, longitude: -122.41 });
    await backend.run("set_permission", { service: "location", value: "revoked" });
    assert.ok(backend.state().conditions!.includes("location revoked"));
    await backend.restore!();
    assert.equal(state.size, "large");
    assert.ok(calls.some((c) => c[0] === "location" && c[2] === "clear"));
    assert.ok(calls.some((c) => c[0] === "privacy" && c[2] === "reset" && c[3] === "location"));
  });

  test("anything outside the lists is refused before simctl is called", async () => {
    const { backend, calls } = make();
    const before = calls.length;
    await assert.rejects(backend.run("set_permission", { service: "camera; rm -rf", value: "granted" }), /service must be one of/);
    await assert.rejects(backend.run("set_text_size", { value: "huge" }), /value must be one of/);
    await assert.rejects(backend.run("set_location", { latitude: 999, longitude: 0 }), /latitude/);
    await assert.rejects(backend.run("open_link", { uri: "not a link" }), /must start with a scheme/);
    assert.equal(calls.length, before);
    assert.ok((IOS_PRIVACY_SERVICES as readonly string[]).includes("photos"));
  });

  test("a bundle id that could inject into a log predicate is refused", () => {
    assert.throws(() => iosBackend({ exec: () => "", bundleId: 'x" OR 1=1 OR "', shoot: async () => PNG }), /unusable bundle id/);
  });

  test("logs are evidence the agent can cite", async () => {
    const { backend } = make();
    const out = await backend.run("read_logs", { minutes: 3 });
    assert.ok(out.evidence);
  });

  test("the agent can drive it end to end and the simulator is put back", async () => {
    const { backend, state } = make();
    let i = 0;
    const script = [
      { tool: "set_appearance", args: { value: "dark" } },
      {
        tool: "finish",
        args: {
          states: [
            { state: "light appearance", verdict: "PASS", screenshot: "s1", reason: "ok" },
            { state: "dark appearance", verdict: "DEFECT", screenshot: "s2", reason: "logo still black" },
          ],
          unverified: [],
          reason: "r",
        },
      },
    ];
    const r = await runQaAgent({
      backend,
      goal: "logo flips with appearance",
      surface: "iOS Simulator",
      screenshotDir: ".",
      label: "ios-test",
      failure: "DEFECT: dark logo on dark",
      complete: async () => JSON.stringify(script[Math.min(i++, script.length - 1)]),
    } as any);
    assert.equal(r.status, "DEFECT");
    assert.equal(state.appearance, "light");
    for (const c of r.captures) {
      const fs = await import("node:fs");
      fs.rmSync(c.file, { force: true });
    }
  });
});
