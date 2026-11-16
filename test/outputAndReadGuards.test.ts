import { test } from "node:test";
import assert from "node:assert/strict";
import { HeadTailCapture, runResolvedCommand } from "../src/commandPolicy.js";

test("head+tail capture keeps both ends and reports what was dropped", () => {
  const c = new HeadTailCapture(10, 10);
  for (let i = 0; i < 1000; i++) c.push("0123456789");
  const out = c.render();
  assert.ok(out.startsWith("0123456789"));
  assert.match(out, /9980 characters omitted/);
  assert.ok(out.endsWith("0123456789"));
  const small = new HeadTailCapture(10, 10);
  small.push("abc");
  assert.equal(small.render(), "abc");
});

test("a 30 MB flood stays bounded and keeps the final line", async () => {
  const r = await runResolvedCommand(
    process.execPath,
    ["-e", "const l='x'.repeat(1000)+String.fromCharCode(10);for(let i=0;i<30000;i++)process.stderr.write(l);console.log('SUMMARY done');process.exit(1)"],
    { cwd: process.cwd(), timeoutMs: 60000 }
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.ok(r.output.length < 8000);
  assert.match(r.output, /characters omitted/);
  assert.match(r.output, /SUMMARY done/);
});
