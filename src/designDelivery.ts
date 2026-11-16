/**
 * Small pieces of how a finished design reaches the person and the repository.
 *
 *  - The kit's .gitignore: the working files (options that were not chosen, option cards, an HTML copy of the
 *    guidelines with embedded fonts, preview pictures) are regenerable, so they stay out of version control; the
 *    parts an app depends on (brand.json, logos, icons, tokens, font licences, the PDF) are committed.
 *  - Staging a picture for the phone: a copy in .agent/screenshots/, the one folder the phone can re-request
 *    pictures from, so a choice made after a reconnect can still be seen.
 */
import fs from "node:fs";
import path from "node:path";

export const KIT_IGNORED = ["concepts/", "typography/", "guidelines.html", "guidelines-preview.png", "preview.png"];

/** Written when the kit folder is made, so even an unfinished run leaves nothing bulky to be committed. */
export function writeKitGitignore(dir: string): void {
  try {
    const file = path.join(dir, ".gitignore");
    if (fs.existsSync(file)) return;
    fs.writeFileSync(
      file,
      "# Working files from the logo designer: regenerable, so not committed.\n# The logos, icons, tokens, font licences, brand.json and guidelines.pdf are the kit and are committed.\n" + KIT_IGNORED.join("\n") + "\n"
    );
  } catch {
    // a missing .gitignore must never stop a design
  }
}

let counter = 0;

/**
 * A copy of a design picture in .agent/screenshots/ (never outside the project), named so it cannot collide.
 * Returns the copy's path, or the original if it could not be copied.
 */
export function stageDesignImage(repoRoot: string, file: string): string {
  try {
    const dir = path.resolve(repoRoot, ".agent", "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const safe = path.basename(file).replace(/[^A-Za-z0-9._-]/g, "_");
    const staged = path.join(dir, `design-${Date.now()}-${++counter}-${safe}`);
    fs.copyFileSync(file, staged);
    return staged;
  } catch {
    return file;
  }
}
