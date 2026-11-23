/**
 * User-global settings at ~/.yimpim/config.yaml.
 *
 * Model choices and the relay belong to the person, not the repository, so they
 * are answered once and apply everywhere. A project may still override anything
 * with its own agent.config.yaml.
 *
 * Resolution order, lowest to highest:
 *   built-in defaults -> ~/.yimpim/config.yaml -> ./agent.config.yaml -> YIMPIM_* env -> --set
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { yimpimDir } from "./secrets.js";

export function globalConfigPath(): string {
  return path.join(yimpimDir(), "config.yaml");
}

export function hasGlobalConfig(): boolean {
  return fs.existsSync(globalConfigPath());
}

export function readGlobalConfig(): Record<string, any> {
  try {
    return yaml.parse(fs.readFileSync(globalConfigPath(), "utf-8")) ?? {};
  } catch {
    return {};
  }
}

export function writeGlobalConfig(data: Record<string, any>): string {
  const file = globalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const doc = new yaml.Document(data);
  doc.commentBefore = [
    " YIMPIM — your personal settings.",
    "",
    " These apply to every project. A repo can override any of them with its own",
    " agent.config.yaml. Change them any time with:",
    "   yimpim setup          (re-run the guided wizard)",
    "   yimpim config set <key> <value>",
  ].join("\n");

  // Owner-only: it holds no secret (the key lives in the OS credential store), but it is personal settings all the same.
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }), { encoding: "utf-8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows: permissions come from the user profile folder */ }
  return file;
}

/** Deep merge where later sources win, used to layer global under project. */
export function mergeConfig(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = mergeConfig(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}
