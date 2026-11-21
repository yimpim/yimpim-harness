/**
 * run_test for REPAIR. A failing test is checked by running it, and until now REPAIR could not: it patched, finished, and the whole QA gate (build, tests,
 * runtime, review) was the only way to find out whether the patch worked, once per attempt. Here it can run the failing test itself after each change.
 *
 * It runs in the REAL project, because that is where REPAIR edits (a worktree would not see its edits, and a fix has to land). It is the heal sandbox's
 * tool with the same safeguards: tests only, no shell, the program started with an argument list, secrets removed from the environment, and the code the
 * agent changed screened (injection text and destructive commands refused, anything suspicious judged by the security model, which is a different model
 * from the one that wrote it). The tree as it stands when the session starts counts as already run, since QA has just run the project's tests.
 */
import { createRunTestSession } from "./sandboxRunTest.js";
import { makeCommandReviewer } from "./commandReview.js";
import { securityReviewCall } from "./healSandbox.js";
import { runSuiteLogged } from "./testLog.js";
import type { OpenRouterClient } from "./openrouter.js";
import type { AgentConfig } from "./config.js";
import type { RunTests } from "./healEdits.js";

/** What REPAIR is told when it has run_test. */
export const REPAIR_RUN_TEST_NOTE =
  "\n\nYou have a run_test tool for the failing test(s) above. After you change the code, run the failing test (run_test with its file, and namePattern to run only the failing test) " +
  "to see whether it passes before you finish; if it still fails, read what it says and change the code again. The full verification still runs afterwards and decides, " +
  "so run_test does not replace it, but it is a much cheaper way to find out your change did not work. Change the CODE, not what the test checks.";

export function repairRunTestFor(deps: { client: OpenRouterClient; config: AgentConfig; repoRoot: string; run?: RunTests; log?: (line: string) => void }): (args: Record<string, unknown>) => Promise<string> {
  const session = createRunTestSession({
    root: deps.repoRoot,
    gate: { review: makeCommandReviewer(securityReviewCall(deps.client, deps.config, "Security: reviewing code before a repair test run")) },
    fallbackRun: deps.run ?? runSuiteLogged,
    preapproveCurrent: true,
    purpose: "repair: run the failing test in the project",
  });
  return async (args) => {
    const r = await session.run(args);
    deps.log?.(r.refused ? "repair run_test: refused" : "repair run_test: run");
    return r.text;
  };
}
