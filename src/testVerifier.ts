import path from "path";
import process from "process";
import { AutonomousVerifier } from "./verifierTools.js";
import { loadConfig } from "./config.js";
import { OpenRouterClient } from "./openrouter.js";
import { createRepoTools } from "./repoTools.js";

async function main() {
  const repoArgIndex = process.argv.indexOf("--repo");
  const targetRepo =
    repoArgIndex !== -1 && process.argv[repoArgIndex + 1]
      ? path.resolve(process.argv[repoArgIndex + 1])
      : process.cwd();

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("[ERROR] OPENROUTER_API_KEY environment variable is not set.");
    process.exit(1);
  }

  const config = loadConfig(targetRepo);
  const client = new OpenRouterClient(apiKey);
  const repo = createRepoTools(targetRepo, config);
  const verifier = new AutonomousVerifier(targetRepo, client, repo, config);

  console.log(`[TEST-VERIFIER] 🎯 Target repo: ${targetRepo}`);
  console.log(`[TEST-VERIFIER] ⚙️ Running autonomous discovery & test execution...`);
  const startTime = Date.now();

  const result = await verifier.runVerification("Verify project builds and all tests/linting pass cleanly.");
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  if (result.passed) {
    console.log(`\n✅ [PASSED] Verification succeeded in ${elapsedSec}s!`);
  } else {
    console.log(`\n❌ [FAILED] Verification failed in ${elapsedSec}s.`);
    console.log(`\n--- Error Log Captured ---\n`);
    console.log(result.errorOutput);
  }
}

main().catch((err: any) => {
  console.error(`[TEST-VERIFIER] 💥 Execution crashed:`, err.message);
});

