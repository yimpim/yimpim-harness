/**
 * run_dependency_install's approval prompt must be VISIBLE on the terminal.
 * askFn's own terminal prompt is just "Your answer: ", so the question text has
 * to be printed first (as askUser does) or the user sees a bare, unexplained
 * prompt while only a paired phone can read what is being asked.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AgentTools } from "../src/agentTools.js";
import type { AgentConfig } from "../src/config.js";

const config = { prompts: { systemPersona: "x" } } as AgentConfig;

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  return { lines, restore: () => (console.log = orig) };
}

function withTty<T>(isTTY: boolean, fn: () => Promise<T>): Promise<T> {
  const inD = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const outD = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  const restore = () => {
    for (const [s, d] of [[process.stdin, inD], [process.stdout, outD]] as const) {
      if (d) Object.defineProperty(s, "isTTY", d);
      else delete (s as any).isTTY;
    }
  };
  return fn().finally(restore);
}

describe("runDependencyInstall approval prompt", () => {
  test("prints the plan and (yes/no) on the console before asking, and honors a yes", async () => {
    const asked: string[] = [];
    const tools = new AgentTools(process.cwd(), config, async (q) => {
      asked.push(q);
      return "yes";
    });
    tools.setActiveAgent("REPAIR");
    let approved: boolean | undefined;
    tools.setDependencyInstallRunner(async (_files, approve) => {
      approved = await approve("npm install left-pad");
      return "ok";
    });

    const cap = captureConsole();
    try {
      await withTty(true, () => tools.runDependencyInstall());
    } finally {
      cap.restore();
    }
    const out = cap.lines.join("\n");
    assert.match(out, /USER INTERACTION REQUIRED/);
    assert.match(out, /REPAIR wants to run: npm install left-pad/);
    assert.match(out, /Approve\? \(yes\/no\)/);
    assert.equal(asked.length, 1);
    assert.equal(approved, true);
  });

  test("non-interactive: declines without ever calling askFn (no hang)", async () => {
    let asked = false;
    const tools = new AgentTools(process.cwd(), config, async () => {
      asked = true;
      return "yes";
    });
    let approved: boolean | undefined;
    tools.setDependencyInstallRunner(async (_files, approve) => {
      approved = await approve("npm install left-pad");
      return "declined";
    });

    const cap = captureConsole();
    try {
      await withTty(false, () => tools.runDependencyInstall());
    } finally {
      cap.restore();
    }
    assert.equal(asked, false);
    assert.equal(approved, false);
    assert.match(cap.lines.join("\n"), /auto-declined/);
  });
});
