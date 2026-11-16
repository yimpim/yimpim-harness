import { spawnSync } from "node:child_process";
const r = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log("Build smoke test passed.");
