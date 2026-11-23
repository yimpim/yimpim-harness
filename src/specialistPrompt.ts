/**
 * The three specialist roles (Security, Logo designer, Logo judge) are not asked for on first setup, and each falls back to a role the
 * user already set. This is the logic for the one short question that tells them so: asked at the end of setup, and the first time
 * /pentest or /design runs with its role unset. Never forced: the fallback always works, and the answer is remembered so it is only
 * ever asked once per command.
 */

import fs from "node:fs";
import path from "node:path";
import { yimpimDir } from "./secrets.js";
import type { Persona } from "./models.js";

export type SpecialistCommand = "pentest" | "design";

type Chains = Partial<Record<Persona, string[] | undefined>>;

const nonEmpty = (c: string[] | undefined): c is string[] => Array.isArray(c) && c.length > 0;

/** The roles a command depends on, in the order they are asked. */
export const COMMAND_ROLES: Record<SpecialistCommand, Persona[]> = {
  pentest: ["security"],
  design: ["designer", "designerVision"],
};

/** What a role uses today when the user has not set it: the same order the runtime applies. */
export function fallbackChain(role: Persona, models: Chains): string[] {
  const pick = (...chains: (string[] | undefined)[]): string[] => chains.find(nonEmpty) ?? [];
  switch (role) {
    case "security": return pick(models.security, models.verifier, models.planner);
    case "designer": return pick(models.designer, models.planner);
    case "designerVision": return pick(models.designerVision, models.verifierVision, models.editorVision, models.verifier);
    default: return pick(models[role]);
  }
}

/** The specialist roles of a command that the user has not set themselves. */
export function unsetRoles(command: SpecialistCommand, models: Chains): Persona[] {
  return COMMAND_ROLES[command].filter((r) => !nonEmpty(models[r]));
}

// ---- remembering that the question was already asked -----------------------

function seenFile(): string {
  return path.join(yimpimDir(), "specialist-prompts.json");
}

export function hasBeenAsked(command: SpecialistCommand): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(seenFile(), "utf-8"));
    return data?.[command] === true;
  } catch {
    return false;
  }
}

export function markAsked(command: SpecialistCommand): void {
  try {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(fs.readFileSync(seenFile(), "utf-8")) ?? {}; } catch { /* first time */ }
    data[command] = true;
    fs.mkdirSync(path.dirname(seenFile()), { recursive: true });
    fs.writeFileSync(seenFile(), JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Not being able to remember only means the question may come once more.
  }
}

/** Ask now? Only when something is unset, the answer was never given, and someone can answer. */
export function shouldAsk(command: SpecialistCommand, models: Chains, opts: { interactive: boolean }): boolean {
  return opts.interactive && unsetRoles(command, models).length > 0 && !hasBeenAsked(command);
}

// ---- the words --------------------------------------------------------------

export type SpecialistChoice = "use" | "pick" | "cancel";

/** Enter uses the fallback, p picks now, ESC (undefined), q or cancel stops. Anything else is read as Enter's opposite only when it is a clear p. */
export function parseChoice(answer: string | undefined): SpecialistChoice {
  if (answer === undefined) return "cancel";
  const a = answer.trim().toLowerCase();
  if (a === "") return "use";
  if (a === "p" || a === "pick") return "pick";
  if (a === "q" || a === "quit" || a === "cancel" || a === "esc") return "cancel";
  return "use";
}

export function promptLines(command: SpecialistCommand, models: Chains): string[] {
  const used = (r: Persona) => fallbackChain(r, models).join("  →  ") || "(none)";
  if (command === "pentest") {
    return [
      `/pentest has no Security model set. It will use your ${models.verifier?.length ? "Verifier" : "Planner"} model (${used("security")}).`,
      "A stronger model is worth it here: this runs rarely, so the cost stays small, and a weak model can give false comfort.",
    ];
  }
  const out = [
    `/design has no ${unsetRoles("design", models).map((r) => (r === "designer" ? "Logo designer" : "Logo judge")).join(" or ")} model set.`,
  ];
  if (unsetRoles("design", models).includes("designer")) out.push(`Designers will use your Planner model (${used("designer")}), so every concept comes from one point of view.`);
  if (unsetRoles("design", models).includes("designerVision")) out.push(`The judge will use your Verifier (Vision) model (${used("designerVision")}).`);
  out.push("About 3 designers and 2 judges from different companies give more varied, fairer results.");
  return out;
}

export function promptOptions(): string[] {
  return ["  Enter   use those for now", "  p       pick models now", "  Esc     cancel"];
}

/** Said instead of asking, where nobody can answer (a remote or unattended run). */
export function fallbackHint(command: SpecialistCommand, models: Chains): string {
  const role = command === "pentest" ? "Security" : "Logo designer / Logo judge";
  const using = COMMAND_ROLES[command].map((r) => fallbackChain(r, models).join(" → ")).filter(Boolean).join(" · ");
  return `No ${role} model set, so using ${using}. Set one with /model.`;
}
