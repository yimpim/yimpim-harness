/**
 * Files the harness quarantines (see revertAgentChanges) are saved with a
 * ".rejected" suffix so a test runner or compiler scanning the repo never
 * treats them as project code. Older runs saved them under their original
 * names, where `jest` happily collected a quarantined `__tests__/x.test.ts`
 * and failed on its now-unresolvable imports. This renames those leftovers in
 * place; nothing is deleted.
 */

import fsSync from "fs";
import path from "path";

export function neutralizeLegacyQuarantine(repoRoot: string): number {
  const root = path.join(repoRoot, ".agent", "rejected");
  let renamed = 0;
  const walk = (dir: string) => {
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && !e.name.endsWith(".rejected")) {
        try {
          fsSync.renameSync(full, `${full}.rejected`);
          renamed++;
        } catch {}
      }
    }
  };
  walk(root);
  return renamed;
}
