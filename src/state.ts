import fs from "node:fs/promises";
import path from "node:path";
import { Config } from "./config.js";
import { RunState } from "./types.js";

export class RunStore {
  private dir: string;
  private eventsPath: string;
  private statePath: string;
  constructor(private repoRoot: string, private config: Config, runId: string) {
    this.dir = path.join(repoRoot, config.recovery.stateDirectory, "runs", runId);
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.statePath = path.join(this.dir, "state.json");
  }
  async init(state: RunState) {
    await fs.mkdir(this.dir, { recursive: true });
    await this.save(state);
  }
  async save(state: RunState) {
    state.updatedAt = new Date().toISOString();
    const tmp = this.statePath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tmp, this.statePath);
  }
  async event(type: string, data: unknown = {}) {
    await fs.mkdir(this.dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), type, data }) + "\n";
    await fs.appendFile(this.eventsPath, line, "utf8");
  }
  async saveArtifact(name: string, value: unknown) {
    const p = path.join(this.dir, name);
    const tmp = p + ".tmp";
    await fs.writeFile(tmp, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tmp, p);
  }
  get path() { return this.statePath; }
}

export async function findLatestInterrupted(repoRoot: string, config: Config): Promise<string | null> {
  const runsDir = path.join(repoRoot, config.recovery.stateDirectory, "runs");
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const candidates: { id: string; mtime: number }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(runsDir, e.name, "state.json"), "utf8")) as RunState;
        if (!["completed","failed"].includes(raw.status)) {
          candidates.push({ id: e.name, mtime: new Date(raw.updatedAt).getTime() });
        }
      } catch {}
    }
    candidates.sort((a,b) => b.mtime - a.mtime);
    return candidates[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function loadState(repoRoot: string, config: Config, runId: string): Promise<RunState> {
  const p = path.join(repoRoot, config.recovery.stateDirectory, "runs", runId, "state.json");
  return JSON.parse(await fs.readFile(p, "utf8")) as RunState;
}
