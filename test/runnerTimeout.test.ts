import { test } from "node:test";
import assert from "node:assert/strict";
import { runResolvedCommand } from "../src/commandPolicy.js";

test("a command that never exits is killed and reports a timeout with a hint", async () => {
  const r = await runResolvedCommand(process.execPath, ["-e", "console.log('up');setInterval(()=>{},1000)"], {
    cwd: process.cwd(),
    timeoutMs: 1500,
  });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.output, /TIMED OUT AFTER/);
  assert.match(r.output, /up/);
});

test("stdin is closed and the environment is non-interactive", async () => {
  const r = await runResolvedCommand(
    process.execPath,
    ["-e", "process.stdin.on('end',()=>console.log('eof ci='+process.env.CI)).resume()"],
    { cwd: process.cwd(), timeoutMs: 5000 }
  );
  assert.equal(r.ok, true);
  assert.match(r.output, /eof ci=true/);
});
