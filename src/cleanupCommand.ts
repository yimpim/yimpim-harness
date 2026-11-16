/**
 * The manual-removal command shown when the user declines (or isn't around
 * to confirm) automatically deleting files staged via stage_file_for_deletion.
 * Pulled out of index.ts as a standalone, side-effect-free function so it can
 * be unit tested directly — index.ts runs its whole CLI on import.
 */

/** `Remove-Item "a", "b"` on Windows, `rm 'a' 'b'` everywhere else — whichever
 *  shell the desktop this process runs on actually understands, not the
 *  phone's platform (a paired phone never runs this command itself, it's
 *  just reading the same text the desktop terminal shows). */
export function buildRemovalCommand(paths: string[], platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return `Remove-Item ${paths.map((p) => `"${p}"`).join(", ")}`;
  }
  return `rm ${paths.map((p) => `'${p}'`).join(" ")}`;
}
