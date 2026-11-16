/**
 * Bounded growth for codebase-memory.json's accumulating arrays. Pulled out
 * of src/index.ts as a standalone, side-effect-free module so it can be
 * unit tested directly — index.ts runs its whole CLI on import.
 *
 * liveRules, architectureRules, and techStack are all joined into every
 * single Discovery/Editor/Repair prompt as context (JSON.stringify(memory)),
 * and all three only ever grew — Set-deduplicated by exact string match,
 * but with no ceiling. Exact-match dedup does nothing for the same fact
 * restated slightly differently call to call (a real project's techStack
 * accumulated the same "React Native 0.79 / React 19..." line six separate
 * times, each phrased just differently enough to dodge the Set), so this is
 * a real, observed failure mode, not a hypothetical one: one project's
 * architectureRules reached 280 entries and techStack reached 97, an 83KB
 * JSON blob repeated into every prompt, mostly noise, in a repo that kept
 * failing the same CLASS of mistake (hallucinated external APIs) run after
 * run. architectureRules was meant to be a durable, curated set (unlike the
 * deliberately churn-prone liveRules bucket) — but "durable" was never
 * meant to mean "literally unbounded," and in practice it accumulates the
 * exact same way liveRules does once nothing ever prunes it.
 *
 * All three get the same treatment: oldest dropped first once the ceiling
 * is hit, same as historicalPitfalls (capped at 15 from the start, for
 * this exact reason). architectureRules and techStack get a more generous
 * ceiling than liveRules since they're meant to hold genuinely durable
 * facts, not day-to-day churn — but a ceiling either way, not none.
 */
export const MAX_LIVE_RULES = 40;
export const MAX_ARCHITECTURE_RULES = 60;
export const MAX_TECH_STACK_ENTRIES = 40;

/** Merges newItems into existing (deduplicated by exact string match), then
 *  trims to the MOST RECENT maxEntries entries (oldest dropped first). */
export function mergeCapped(existing: string[], newItems: string[], maxEntries: number): string[] {
  const merged = Array.from(new Set([...existing, ...newItems]));
  return merged.length > maxEntries ? merged.slice(merged.length - maxEntries) : merged;
}

/** Merges newRules into existing (deduplicated), then trims to the MOST RECENT MAX_LIVE_RULES entries. */
export function mergeLiveRules(existing: string[], newRules: string[]): string[] {
  return mergeCapped(existing, newRules, MAX_LIVE_RULES);
}

/** Merges newRules into existing (deduplicated), then trims to the MOST RECENT MAX_ARCHITECTURE_RULES entries. */
export function mergeArchitectureRules(existing: string[], newRules: string[]): string[] {
  return mergeCapped(existing, newRules, MAX_ARCHITECTURE_RULES);
}

/** Merges newEntries into existing (deduplicated), then trims to the MOST RECENT MAX_TECH_STACK_ENTRIES entries. */
export function mergeTechStack(existing: string[], newEntries: string[]): string[] {
  return mergeCapped(existing, newEntries, MAX_TECH_STACK_ENTRIES);
}
