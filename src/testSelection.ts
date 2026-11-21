/**
 * Which tests a change can reach. ONE function, used by the verifier's test gate and by the Editor's own sweep before it concludes, so the Editor checks
 * exactly the tests QA will run and the two cannot drift apart.
 */
import { selectTests, type TestSelection } from "./testGraph.js";
import { staleSince } from "./testLog.js";

export function selectForChange(repoRoot: string, touched: string[]): { sel: TestSelection; staleCount: number } {
  let sel = selectTests(repoRoot, touched);
  let staleCount = 0;
  // Tests whose dependencies changed since they last ran (an earlier task that stopped mid-edit, a rename by an editor) are not reached by THIS change but are
  // stale all the same: run them now, so one red test is found now and not eighteen later.
  if (!sel.everything) {
    const stale = staleSince(repoRoot, sel.selected);
    if (stale.length > 0) {
      sel = { ...sel, selected: [...sel.selected, ...stale], skipped: sel.skipped.filter((t) => !stale.includes(t)) };
      staleCount = stale.length;
    }
  }
  return { sel, staleCount };
}
