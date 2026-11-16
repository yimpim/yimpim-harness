import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTools } from "../src/agentTools.js";
import type { AgentConfig } from "../src/types.js";

const cfg = { prompts: { systemPersona: "x" } } as AgentConfig;
const mk = async () => fs.mkdtemp(path.join(os.tmpdir(), "yimpim-read-"));

test("a NUL byte in the first 4 KB is reported as a binary file", async () => {
  const dir = await mk();
  try {
    await fs.writeFile(path.join(dir, "a.bin"), Buffer.concat([Buffer.from("hello"), Buffer.from([0]), Buffer.from("world")]));
    const out = await new AgentTools(dir, cfg).readFile("a.bin");
    assert.match(out, /^\[BINARY FILE/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a 10,000-character line is clamped to 200 characters with its real length", async () => {
  const dir = await mk();
  try {
    await fs.writeFile(path.join(dir, "min.js"), `ok\n${"y".repeat(10_000)}\nend\n`);
    const out = await new AgentTools(dir, cfg).readFile("min.js");
    assert.match(out, /y{200}\.\.\.\[line truncated, 10000 chars\]/);
    assert.ok(!out.includes("y".repeat(201)));
    assert.match(out, /^ok\n/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the 60 KB whole-file cap truncates, and a line range reads past it", async () => {
  const dir = await mk();
  try {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} ${"z".repeat(30)}`);
    await fs.writeFile(path.join(dir, "big.txt"), lines.join("\n"));
    const tools = new AgentTools(dir, cfg);
    const whole = await tools.readFile("big.txt");
    assert.match(whole, /truncated: big\.txt is \d+ bytes, showing first 60000/);
    const ranged = await tools.readFile("big.txt", 3990, 4000);
    assert.match(ranged, /showing lines 3990-4000 of 4000/);
    assert.match(ranged, /line 4000 /);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
