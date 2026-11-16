/**
 * Short-lived, in-memory cache of full diff text for recent file writes, so a
 * paired phone can fetch the actual change behind a "+N -M" summary on
 * demand (see remote/protocol.ts's `fetch_diff` verb and `diff.chunk`/
 * `diff.unavailable` events) instead of every write shipping its diff
 * eagerly whether anyone ever looks or not.
 *
 * Nothing here ever touches disk — a change nobody asks about costs only its
 * byte count in memory until it's evicted.
 */

export interface StoredDiff {
  path: string;
  diffText: string;
  bytes: number;
}

const MAX_ENTRIES = 300;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

class DiffStore {
  private entries = new Map<string, StoredDiff>();
  private totalBytes = 0;

  record(changeId: string, path: string, diffText: string): void {
    const bytes = Buffer.byteLength(diffText, "utf-8");
    this.entries.set(changeId, { path, diffText, bytes });
    this.totalBytes += bytes;
    this.evictIfNeeded();
  }

  get(changeId: string): StoredDiff | undefined {
    return this.entries.get(changeId);
  }

  private evictIfNeeded(): void {
    // A Map preserves insertion order, so the oldest entry is always first —
    // same "drop the oldest" policy as RemoteSession's own outbox cap and
    // seenCommands replay-guard cap (src/remote/client.ts).
    while (this.entries.size > MAX_ENTRIES || this.totalBytes > MAX_TOTAL_BYTES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey)!;
      this.totalBytes -= oldest.bytes;
      this.entries.delete(oldestKey);
    }
  }
}

export const diffStore = new DiffStore();
