/**
 * Which folders are not the user's project, and which are their tests and specs: the one definition every stage reads (existence, discovery, the Planner's tree, the security scans, test
 * settling, the repo map, the design reader). It used to be written out a dozen times, each a little different, so a folder one stage skipped another walked.
 *
 * Ignored folders come from safety.blockedDirectories (the user's list, set once when the config loads) plus build and dependency output no project owns. A stage that must also leave out
 * something of its own (the native android/ and ios/ trees an Expo prebuild writes, which would bloat a model's context) names it as `extra`.
 */

/** The default for safety.blockedDirectories. */
export const DEFAULT_BLOCKED_DIRECTORIES = [".git", "node_modules", ".venv", "venv", "__pycache__", ".agent", "dist", "build", ".gradle", ".idea"];

/** Generated or vendored output no project owns, skipped by every walker whatever safety.blockedDirectories says. */
export const GENERATED_DIRS = [".next", ".expo", ".turbo", ".dart_tool", "coverage", "out", "target", "Pods", "vendor"];

/** The native trees an Expo/React Native prebuild writes; a stage that reads the JS/TS app, not the generated native project, adds these. */
export const NATIVE_TREES = ["android", "ios"];

let configured: string[] | undefined;
const cache = new Map<string, Set<string>>();

/** Called once when the config loads: the user's safety.blockedDirectories becomes what every walker skips. */
export function setBlockedDirectories(dirs: string[] | undefined): void {
  configured = dirs ? [...dirs] : undefined;
  cache.clear();
}

/** Folder NAMES to skip: the blocked directories, the generated ones, and `extra`. */
export function ignoredDirs(extra: readonly string[] = []): Set<string> {
  const key = extra.join("\0");
  let s = cache.get(key);
  if (!s) {
    s = new Set([...(configured ?? DEFAULT_BLOCKED_DIRECTORIES), ...GENERATED_DIRS, ...extra]);
    cache.set(key, s);
  }
  return s;
}

/** A set that reads the current configuration each time it is asked (a module can build it at load, before the config is known). */
export function lazyIgnore(extra: readonly string[] = []): { has(name: string): boolean } {
  return { has: (name: string) => ignoredDirs(extra).has(name) };
}

// ------------------------------------------------------------------------------------------------------------------------ tests and specs

/** Folders that hold a project's own tests, in any language. */
export const TEST_DIR_NAMES = ["__tests__", "tests?", "e2e"];
/** Folders that hold its specifications. Tests for most stages, but protected (not exempt) for the write budget. */
export const SPEC_DIR_NAMES = ["specs?"];

/** The regex alternation for a test OR spec folder name: `__tests__|tests?|e2e|specs?`. */
export const TEST_OR_SPEC_DIR = [...TEST_DIR_NAMES, ...SPEC_DIR_NAMES].join("|");
/** The regex alternation for a test folder name only (no specs). */
export const TEST_DIR = TEST_DIR_NAMES.join("|");

/** A path inside a test or spec folder. */
export const inTestOrSpecDir = (rel: string): boolean => new RegExp(String.raw`(^|\/)(${TEST_OR_SPEC_DIR})\/`, "i").test(rel.replace(/\\/g, "/"));
