/**
 * Before a roadmap is saved: the libraries its conventions name ("use expo-sqlite for storage", "zustand for state") are looked up in the real registry. One that does not exist, is
 * deprecated, has had no release in two years, or looks like a popular package with a typo is written into the conventions as something to REVIEW, so no ticket is built on a
 * package that cannot be installed or should not be. One that is fine gets its facts written next to it ("expo-sqlite 15.x, last release ..."). Nothing here installs anything.
 */
import { lookupPackage, chooseVersion, type FetchFn } from "./dependencyFacts.js";
import { lookAlikeOf } from "./packageNames.js";

/** What reads like a package name in a convention: in backticks, or a hyphenated or scoped name after "use", "using", "with", "install", "library" or "package". */
export function packagesNamedIn(conventions: string[], max = 8): string[] {
  const found: string[] = [];
  const add = (n: string) => {
    const name = n.trim().replace(/[.,;:)]+$/, "");
    if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name) && name.length >= 3 && name.length <= 80 && !found.includes(name)) found.push(name);
  };
  for (const c of conventions) {
    for (const m of c.matchAll(/`((?:@[\w.-]+\/)?[\w.-]+)`/g)) add(m[1]);
    for (const m of c.matchAll(/\b(?:use|using|with|install|library|package|via)\s+((?:@[a-z0-9][\w.-]*\/)?[a-z0-9]+(?:-[a-z0-9]+)+)\b/gi)) add(m[1].toLowerCase());
    for (const m of c.matchAll(/(?:^|[\s(])(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/g)) add(m[1]);
  }
  return found.slice(0, max);
}

const TWO_YEARS_MS = 2 * 365 * 86_400_000;

export interface PackageNotesDeps {
  fetchFn?: FetchFn;
  now?: () => Date;
}

/** One line per package named, for the roadmap's conventions. The lookup never throws: a registry that cannot be reached is said so, and nothing is claimed. */
export function makePackageNotes(deps: PackageNotesDeps = {}): (conventions: string[]) => Promise<string[]> {
  return async (conventions) => {
    const notes: string[] = [];
    for (const name of packagesNamedIn(conventions)) {
      try {
        const facts = await lookupPackage("npm", name, deps.fetchFn);
        if (facts.lookupError) {
          notes.push(`Could not check "${name}" in the registry (${facts.lookupError.slice(0, 80)}); check it before it is installed`);
          continue;
        }
        if (!facts.exists) {
          notes.push(`REVIEW: "${name}" does not exist in the npm registry, so no ticket can install it. Choose a package that does`);
          continue;
        }
        const look = lookAlikeOf("npm", name);
        if (look) {
          notes.push(`REVIEW: "${name}" looks like "${look}", a very popular package. Make sure the right one is meant`);
          continue;
        }
        const latest = chooseVersion(facts).version ?? facts.registryLatest;
        const v = facts.versions.find((x) => x.version === latest);
        const last = v?.publishedAt ? Date.parse(v.publishedAt) : NaN;
        const now = (deps.now ?? (() => new Date()))().getTime();
        if (v?.deprecated) notes.push(`REVIEW: "${name}" ${latest} is deprecated (${v.deprecated.slice(0, 100)}). Choose another`);
        else if (Number.isFinite(last) && now - last > TWO_YEARS_MS) notes.push(`REVIEW: "${name}" has had no release since ${new Date(last).toISOString().slice(0, 10)}. Check it is still maintained`);
        else notes.push(`Checked in the registry: ${name} ${latest ?? "(version unknown)"}${Number.isFinite(last) ? `, last release ${new Date(last).toISOString().slice(0, 10)}` : ""}${facts.weeklyDownloads !== undefined ? `, ${facts.weeklyDownloads} downloads last week` : ""}`);
      } catch {
        // a package note is a help, never a reason to fail a roadmap
      }
    }
    return notes;
  };
}
