/**
 * `npm test` entry point.
 *
 * node --test's own directory discovery doesn't pick up .ts files on every
 * Node version this project supports, and npm scripts get no shell glob
 * expansion on Windows anyway (npm runs them through cmd.exe). Discovering
 * files here, in plain Node, works identically everywhere.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const testDir = path.join(import.meta.dirname, "..", "test");
const files = findTests(testDir);

if (files.length === 0) {
  console.error(`No *.test.ts files found under ${testDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
