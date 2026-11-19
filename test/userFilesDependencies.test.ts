/** A path into a dependency in a request is a stack-trace frame, not a file the person is asking about. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userNamedFiles } from "../src/userFiles.js";

test("files the project owns are picked up; a dependency named in a pasted failure is not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uf-"));
  try {
    for (const f of ["app/dashboard.tsx", "__tests__/dashboard.test.ts", "node_modules/@babel/runtime/helpers/asyncToGenerator.js", "venv/lib/site-packages/x/mod.py"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "x");
    }
    const request = [
      "Fix the code so __tests__/dashboard.test.ts passes. The code is in app/dashboard.tsx.",
      "    at asyncGeneratorStep (node_modules/@babel/runtime/helpers/asyncToGenerator.js:3:17)",
      "    at handler (venv/lib/site-packages/x/mod.py:9)",
    ].join("\n");
    const named = userNamedFiles(request, dir);
    assert.deepEqual(named.sort(), ["__tests__/dashboard.test.ts", "app/dashboard.tsx"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
