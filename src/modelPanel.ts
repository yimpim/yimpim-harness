/**
 * The model picker that opens in the pinned area while a task is running: pick a role, then a model; the change is queued
 * (see modelQueue.ts) and the stream keeps scrolling above. The terminal side only draws `rows()` and forwards keys, so this
 * is plain state with no terminal in it.
 */
import type { CatalogModel, PersonaNeeds } from "./models.js";

export interface PanelDeps {
  personas: PersonaNeeds[];
  current: (role: string) => string[] | undefined;
  /** What is waiting for the role: undefined = nothing, null = a clear. */
  pending: (role: string) => string[] | null | undefined;
  /** Models the person's key can reach that meet the role's needs. */
  candidates: (persona: PersonaNeeds) => Promise<CatalogModel[]>;
  format: (m: CatalogModel) => string;
  /** Queue the change. `undefined` clears an optional role. */
  choose: (role: string, chain: string[] | undefined) => void;
  /** Called when rows changed without a key (a catalog finished loading). */
  onUpdate: () => void;
  maxRows?: number;
}

export interface PanelKey {
  name?: string;
  ctrl?: boolean;
}
export type PanelOutcome = "close" | "redraw";

export class ModelPanel {
  private stage: "roles" | "models" = "roles";
  private sel = 0;
  private filter = "";
  private persona?: PersonaNeeds;
  private options: CatalogModel[] = [];
  private status = "";
  private loading = false;
  private readonly maxRows: number;

  constructor(private readonly d: PanelDeps) {
    this.maxRows = Math.max(3, d.maxRows ?? 7);
  }

  /** Models matching the typed filter, with "leave unset" first for an optional role that is set. */
  private visible(): { label: string; id?: string; clear?: boolean }[] {
    const f = this.filter.trim().toLowerCase();
    const rows: { label: string; id?: string; clear?: boolean }[] = [];
    if (this.persona?.optional && !f) rows.push({ label: "(leave this role unset)", clear: true });
    for (const m of this.options) {
      if (f && !m.id.toLowerCase().includes(f) && !m.name.toLowerCase().includes(f)) continue;
      rows.push({ label: this.d.format(m), id: m.id });
    }
    return rows;
  }

  private window<T>(items: T[]): { slice: T[]; offset: number } {
    const n = items.length;
    const start = Math.min(Math.max(0, this.sel - Math.floor(this.maxRows / 2)), Math.max(0, n - this.maxRows));
    return { slice: items.slice(start, start + this.maxRows), offset: start };
  }

  rows(): string[] {
    if (this.stage === "roles") {
      const roles = this.d.personas;
      const { slice, offset } = this.window(roles);
      const out = ["\x1b[1mChange a model\x1b[0m  ↑↓ choose · Enter select · Esc close   (applies when that role next starts)"];
      slice.forEach((p, i) => {
        const idx = offset + i;
        const now = this.d.current(p.key)?.[0] ?? "unset";
        const pend = this.d.pending(p.key);
        const tail = pend === undefined ? now : `${now} → ${pend === null ? "unset" : pend[0]}  (waiting)`;
        out.push(`${idx === this.sel ? "\x1b[7m›" : " "} ${p.label.padEnd(18)} ${tail}${idx === this.sel ? "\x1b[0m" : ""}`);
      });
      if (this.status) out.push(`  ${this.status}`);
      return out;
    }
    const p = this.persona!;
    const out = [`\x1b[1m${p.label}\x1b[0m  type to filter · ↑↓ · Enter choose · Esc back${p.volume === "high" ? "  ⚠ high volume: drives your bill" : ""}`];
    if (this.loading) {
      out.push("  Checking which models your key can reach…");
      return out;
    }
    if (this.status) {
      out.push(`  ${this.status}`);
      return out;
    }
    out.push(`  filter: ${this.filter}█`);
    const list = this.visible();
    if (list.length === 0) out.push("  no model matches");
    const { slice, offset } = this.window(list);
    slice.forEach((r, i) => out.push(`${offset + i === this.sel ? "\x1b[7m›" : " "} ${r.label}${offset + i === this.sel ? "\x1b[0m" : ""}`));
    return out;
  }

  key(str: string | undefined, key: PanelKey | undefined): PanelOutcome {
    const name = key?.name;
    if (name === "escape") {
      if (this.stage === "models") {
        this.stage = "roles";
        this.sel = Math.max(0, this.d.personas.findIndex((p) => p.key === this.persona?.key));
        this.status = "";
        return "redraw";
      }
      return "close";
    }
    if (key?.ctrl) return "redraw";
    const max = this.stage === "roles" ? this.d.personas.length : this.visible().length;
    if (name === "up") {
      this.sel = Math.max(0, this.sel - 1);
      return "redraw";
    }
    if (name === "down") {
      this.sel = Math.min(Math.max(0, max - 1), this.sel + 1);
      return "redraw";
    }
    if (name === "return" || name === "enter") return this.enter();
    if (this.stage === "models" && !this.loading) {
      if (name === "backspace") this.filter = this.filter.slice(0, -1);
      else if (str && str.length === 1 && str >= " " && str !== "\x7f") this.filter += str;
      else return "redraw";
      this.sel = 0;
    }
    return "redraw";
  }

  private enter(): PanelOutcome {
    if (this.stage === "roles") {
      const p = this.d.personas[this.sel];
      if (!p) return "redraw";
      if (p.multi) {
        this.status = `${p.label} takes a set of models. Change it from the idle /model menu.`;
        return "redraw";
      }
      this.persona = p;
      this.stage = "models";
      this.filter = "";
      this.sel = 0;
      this.status = "";
      this.loading = true;
      void this.d
        .candidates(p)
        .then((list) => {
          this.options = list;
          if (list.length === 0) this.status = `No model your key can reach meets ${p.label}'s requirements.`;
        })
        .catch((err: any) => {
          this.status = `Could not load models: ${err?.message ?? err}`;
        })
        .finally(() => {
          this.loading = false;
          this.d.onUpdate();
        });
      return "redraw";
    }
    if (this.loading || this.status) return "redraw";
    const pick = this.visible()[this.sel];
    if (!pick) return "redraw";
    if (pick.clear) {
      this.d.choose(this.persona!.key, undefined);
      return "close";
    }
    const existing = this.d.current(this.persona!.key) ?? [];
    // Keep the role's backup model when there is one and it is a different model.
    const backup = existing.slice(1).filter((m) => m !== pick.id);
    this.d.choose(this.persona!.key, [pick.id!, ...backup].slice(0, 2));
    return "close";
  }
}
