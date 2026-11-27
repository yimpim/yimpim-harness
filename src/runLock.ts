/**
 * Advisory run lock for a target repository.
 *
 * The danger with locks is not contention, it is a lock that outlives the
 * process that took it. Three independent mechanisms guarantee release:
 *
 *   1. Clean exit / Ctrl-C / SIGTERM  -> the handler releases it.
 *   2. Hard crash or kill -9          -> the recorded PID is gone, so the next
 *                                        run detects a dead owner and steals it.
 *   3. Machine power-loss, or a stale
 *      lock from another host         -> the heartbeat stops being refreshed,
 *                                        so it ages out after STALE_AFTER_MS.
 *
 * The result: a crashed run never locks the user out. A lock is only honoured
 * while its owner is provably alive.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HEARTBEAT_INTERVAL_MS = 15_000;
/** A lock whose heartbeat is older than this is considered abandoned. */
const STALE_AFTER_MS = 60_000;

export interface LockInfo {
  pid: number;
  hostname: string;
  runId: string;
  command: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface AcquireResult {
  acquired: boolean;
  /** Present when acquisition failed: who currently holds it. */
  heldBy?: LockInfo;
  /** Explains a steal, for logging. */
  note?: string;
}

/**
 * Is a process with this PID currently running on this machine?
 *
 * On Windows `process.kill(pid, 0)` is NOT a reliable liveness test: a
 * recently-exited PID still resolves without throwing, because the process
 * handle outlives the process. Verified on Windows 11 — a dead PID returned
 * no-throw while an unused PID threw ESRCH. So Windows asks the OS directly.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (process.platform === "win32") {
    try {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // No match prints an INFO line rather than a CSV row.
      if (!out.includes(`"${pid}"`)) return false;
      // Guard against PID reuse by a non-node process.
      return /node|tsx|bun/i.test(out);
    } catch {
      // tasklist unavailable: fall back to the heartbeat, which never over-trusts.
      return true;
    }
  }

  try {
    // Signal 0 performs existence/permission checks without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = the process exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

function ageMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
}

export class RunLock {
  private lockPath: string;
  private heartbeat?: NodeJS.Timeout;
  private released = false;
  private info?: LockInfo;
  private cleanupBound = false;

  constructor(repoRoot: string, stateDirectory = ".agent") {
    this.lockPath = path.join(repoRoot, stateDirectory, "run.lock");
  }

  get path(): string {
    return this.lockPath;
  }

  private read(): LockInfo | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath, "utf-8")) as LockInfo;
    } catch {
      return undefined;
    }
  }

  /**
   * Decide whether an existing lock still deserves respect.
   * Same host: authoritative PID check. Other host: heartbeat age only.
   */
  private staleReason(existing: LockInfo): string | undefined {
    const sameHost = existing.hostname === os.hostname();

    if (sameHost && !isPidAlive(existing.pid)) {
      return `previous run (pid ${existing.pid}) is no longer running`;
    }

    const age = ageMs(existing.heartbeatAt);
    if (age > STALE_AFTER_MS) {
      return `last heartbeat was ${Math.round(age / 1000)}s ago (limit ${STALE_AFTER_MS / 1000}s)`;
    }

    // Our own PID, e.g. a re-entrant call in the same process.
    if (sameHost && existing.pid === process.pid) return "lock is held by this same process";

    return undefined;
  }

  acquire(runId: string, command: string, force = false): AcquireResult {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });

    let note: string | undefined;
    const existing = this.read();
    if (existing) {
      const stale = force ? "forced by --force-unlock" : this.staleReason(existing);
      if (!stale) {
        return { acquired: false, heldBy: existing };
      }
      note = `reclaimed abandoned lock: ${stale}`;
    }

    this.info = {
      pid: process.pid,
      hostname: os.hostname(),
      runId,
      command,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    this.write();
    this.startHeartbeat();
    this.installCleanup();

    return { acquired: true, note };
  }

  private write(): void {
    if (!this.info) return;
    const tmp = `${this.lockPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.info, null, 2), "utf-8");
    fs.renameSync(tmp, this.lockPath);
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (this.released || !this.info) return;
      this.info.heartbeatAt = new Date().toISOString();
      try {
        this.write();
      } catch {
        // A failed heartbeat is not fatal; the lock simply ages out.
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Never keep the event loop alive just to refresh a lock.
    this.heartbeat.unref?.();
  }

  /** Release only if we still own it, so we never delete someone else's lock. */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.heartbeat) clearInterval(this.heartbeat);

    try {
      const current = this.read();
      if (current && current.pid === process.pid && current.hostname === os.hostname()) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Best effort: a leftover lock will be detected as stale anyway.
    }
  }

  private shutdownHooks = new Set<() => Promise<void> | void>();
  private shuttingDown = false;

  /**
   * Register an async/sync teardown hook (e.g. RemoteSession.stop) to run
   * before lock release and process.exit on SIGINT/SIGTERM/SIGHUP/SIGBREAK.
   * Returns an unregister function so re-pairing never leaks listeners.
   */
  registerShutdownHook(fn: () => Promise<void> | void): () => void {
    this.shutdownHooks.add(fn);
    return () => {
      this.shutdownHooks.delete(fn);
    };
  }

  private async runShutdownHooks(timeoutMs = 2_500): Promise<void> {
    if (this.shutdownHooks.size === 0) return;
    const hooks = [...this.shutdownHooks];
    const work = Promise.allSettled(
      hooks.map(async (fn) => {
        await fn();
      })
    );
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        t.unref?.();
      }),
    ]);
  }

  private installCleanup(): void {
    if (this.cleanupBound) return;
    this.cleanupBound = true;

    const release = () => this.release();

    process.once("exit", release);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
      process.on(signal, () => {
        const code = signal === "SIGINT" ? 130 : 143;
        if (this.shuttingDown) {
          // Second signal forces immediate exit.
          release();
          process.exit(code);
        }
        this.shuttingDown = true;
        void this.runShutdownHooks().finally(() => {
          release();
          // Re-raise with the conventional exit code so Ctrl-C still feels normal.
          process.exit(code);
        });
      });
    }
    process.once("uncaughtException", (err) => {
      release();
      console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
    process.once("unhandledRejection", (err: any) => {
      release();
      console.error(`[FATAL] Unhandled rejection: ${err?.message ?? String(err)}`);
      process.exit(1);
    });
  }
}

/** Human-readable explanation shown when a lock is genuinely held. */
export function describeHeldLock(held: LockInfo, lockPath: string): string {
  const age = Math.round(ageMs(held.startedAt) / 1000);
  return [
    ``,
    `Another YIMPIM run is already active on this repository.`,
    ``,
    `  pid:       ${held.pid} on ${held.hostname}`,
    `  run:       ${held.runId}`,
    `  command:   ${held.command}`,
    `  started:   ${held.startedAt} (${age}s ago)`,
    `  heartbeat: ${held.heartbeatAt}`,
    ``,
    `If that run really is finished, the lock will clear itself:`,
    `  - automatically within 60s once its heartbeat stops, or`,
    `  - immediately, since a dead process is detected on the next attempt.`,
    ``,
    `To override now:  yimpim <command> --force-unlock`,
    `Lock file:        ${lockPath}`,
    ``,
  ].join("\n");
}
