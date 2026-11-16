/**
 * Live OpenRouter model catalog.
 *
 * Model names are never hardcoded or validated against a baked-in list. The
 * catalog is fetched with the user's own key, so the choices offered are
 * exactly what that key can actually reach — and a slug can never be "wrong".
 */

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number;
  /** USD per million prompt tokens; null when the price is variable. */
  promptCost: number | null;
  /** USD per million completion tokens; null when variable. */
  completionCost: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
}

export type Persona =
  | "discovery"
  | "planner"
  | "editor"
  | "repair"
  | "verifier"
  | "discoveryVision"
  | "editorVision"
  | "repairVision"
  | "verifierVision"
  | "designer"
  | "designerVision"
  | "security";

export interface PersonaNeeds {
  key: Persona;
  label: string;
  blurb: string;
  requiresTools: boolean;
  requiresVision: boolean;
  /** Roughly how much this role consumes, to guide cost choices. */
  volume: "low" | "high";
  /** The dedicated vision roles are opt-in — skippable in setup and in
   *  `/model`, unlike the four base roles every run actually needs. */
  optional?: boolean;
  /**
   * A role that takes a SET of models to rotate through (1 to `max`), not a [primary, backup] chain. Different
   * models propose and draw different logo concepts, because one model alone settles into one style.
   */
  multi?: { min: number; max: number };
  /** Left out of the first-run setup wizard (it is still in /model and on the phone): opt-in specialist roles. */
  advanced?: boolean;
}

/** The wire shape of one role's description, so a phone can build its picker from what the desktop sends. */
export interface RoleInfoWire {
  role: Persona;
  label: string;
  blurb: string;
  /** May be cleared back to unset (set_model with an empty chain). */
  optional: boolean;
  /** A set of models (1 to max) rather than a [primary, backup] chain; null for a chain. */
  multi: { min: number; max: number } | null;
  needsTools: boolean;
  needsVision: boolean;
  volume: "low" | "high";
}

export const PERSONAS: PersonaNeeds[] = [
  {
    key: "discovery",
    label: "Discovery",
    blurb: "Explores the repo to build context. Needs tool calling.",
    requiresTools: true,
    requiresVision: false,
    volume: "low",
  },
  {
    key: "discoveryVision",
    label: "Discovery (Vision)",
    blurb:
      "Used instead of Discovery for a WHOLE exploration pass, only on a task with an attached image. " +
      "Optional — unconfigured just means Discovery never looks at the image, no warning.",
    requiresTools: true,
    requiresVision: true,
    volume: "low",
    optional: true,
  },
  {
    key: "planner",
    label: "Planner",
    blurb:
      "Writes the phase plan. No tools, one call per task — pick a vision-capable model (Vision) if you " +
      "plan to attach reference images; a single call is a much smaller cost than a whole Editor/Discovery " +
      "pass, so this role has no separate vision variant.",
    requiresTools: false,
    requiresVision: false,
    volume: "low",
  },
  {
    key: "editor",
    label: "Editor",
    blurb: "Writes the actual code. Needs tool calling. HIGHEST token volume.",
    requiresTools: true,
    requiresVision: false,
    volume: "high",
  },
  {
    key: "editorVision",
    label: "Editor (Vision)",
    blurb:
      "Used instead of Editor/Repair for the WHOLE phase, only on a task with an attached image (every " +
      "round of that phase reuses it, so pick this deliberately — it's usually pricier, never silently " +
      "mixed into your normal Editor chain). Unconfigured: the image only reaches the Planner, and you're " +
      "warned in the console rather than silently paying for or missing vision.",
    requiresTools: true,
    requiresVision: true,
    volume: "high",
    optional: true,
  },
  {
    key: "repair",
    label: "Repair",
    blurb:
      "Fixes defects QA found after Editor's diff. Needs tool calling. Diagnosing someone else's failure " +
      "from error text alone is a harder job than executing an already-clear plan, so this is worth a " +
      "stronger model than Editor even while Editor itself stays cheap. Optional — unconfigured just " +
      "reuses models.editor exactly, no warning.",
    requiresTools: true,
    requiresVision: false,
    volume: "high",
    optional: true,
  },
  {
    key: "repairVision",
    label: "Repair (Vision)",
    blurb:
      "Used instead of Repair for the WHOLE phase, only on a task with an attached image. Optional — " +
      "unconfigured just reuses models.editorVision (or models.repair/models.editor) exactly, no warning.",
    requiresTools: true,
    requiresVision: true,
    volume: "high",
    optional: true,
  },
  {
    key: "verifier",
    label: "Verifier",
    blurb: "QA's text-only checks (semantic diff review, etc). No image input needed here.",
    requiresTools: false,
    requiresVision: false,
    volume: "low",
  },
  {
    key: "verifierVision",
    label: "Verifier (Vision)",
    blurb:
      "QA's screenshot-driven checks (navigation, visual audit) — used on essentially every UI project's " +
      "normal QA pass, not just when you attach a reference image. Unconfigured: falls back to Verifier, " +
      "which must then support vision itself or these checks silently degrade.",
    requiresTools: false,
    requiresVision: true,
    volume: "low",
    optional: true,
  },
  {
    key: "designer",
    label: "Logo designer",
    blurb:
      "The models that propose and draw logo and brand concepts, rotated so each concept comes from a different one " +
      "(one model alone drifts into one style). Pick 3 from different providers; strong coding and geometry skill " +
      "matters most, since they draw as SVG. Optional: unset uses the Planner's models.",
    requiresTools: false,
    requiresVision: false,
    volume: "low",
    optional: true,
    multi: { min: 1, max: 6 },
    advanced: true,
  },
  {
    key: "designerVision",
    label: "Logo judge (Vision)",
    blurb:
      "Looks at the rendered concepts (light and dark, small, greyscale) and judges them. Pick at least 2 from " +
      "different providers so the judge is not the model that drew the mark. Optional: unset uses Verifier (Vision).",
    requiresTools: false,
    requiresVision: true,
    volume: "low",
    optional: true,
    multi: { min: 1, max: 4 },
    advanced: true,
  },
  {
    key: "security",
    label: "Security",
    blurb:
      "Threat models for sensitive tasks, the attacker-style review of risky changes, and /pentest. It runs rarely, " +
      "so a frontier model is worth the cost here. Optional: unset uses Verifier, then Planner.",
    requiresTools: false,
    requiresVision: false,
    volume: "low",
    optional: true,
    advanced: true,
  },
];

export function roleInfoWire(): RoleInfoWire[] {
  return PERSONAS.map((p) => ({ role: p.key, label: p.label, blurb: p.blurb, optional: Boolean(p.optional), multi: p.multi ?? null, needsTools: p.requiresTools, needsVision: p.requiresVision, volume: p.volume }));
}

/**
 * Why a chain is not acceptable for a role, or null. A normal role is a primary and an optional backup; a "multi"
 * role is a set of 1 to max different models. Empty is the "clear" request and is judged by the caller.
 */
export function chainProblem(persona: PersonaNeeds, chain: string[]): string | null {
  if (chain.some((id) => typeof id !== "string" || !id.trim())) return "A model id is empty.";
  if (new Set(chain).size !== chain.length) return "The same model is listed twice.";
  if (persona.multi) {
    if (chain.length > persona.multi.max) return `${persona.label} takes at most ${persona.multi.max} models.`;
    return null;
  }
  return chain.length > 2 ? `${persona.label} takes a primary and at most one backup.` : null;
}

/**
 * OpenRouter reports a negative price for router/auto models, meaning "varies by
 * whichever model gets picked". Treating that as a number makes them sort as the
 * cheapest thing available, which is badly misleading — so they are flagged as
 * variable-cost instead.
 */
function perMillion(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

export async function fetchCatalog(apiKey: string): Promise<CatalogModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter returned HTTP ${res.status}. Check your API key.`);
  }

  const body: any = await res.json();
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];

  return rows
    .map((m): CatalogModel => {
      const params: string[] = Array.isArray(m?.supported_parameters) ? m.supported_parameters : [];
      const inputs: string[] =
        m?.architecture?.input_modalities ??
        (typeof m?.architecture?.modality === "string" ? m.architecture.modality.split("->")[0].split("+") : []);

      return {
        id: String(m?.id ?? ""),
        name: String(m?.name ?? m?.id ?? ""),
        contextLength: Number(m?.context_length ?? 0),
        promptCost: perMillion(m?.pricing?.prompt),
        completionCost: perMillion(m?.pricing?.completion),
        supportsTools: params.includes("tools") || params.includes("tool_choice"),
        supportsVision: inputs.some((i) => String(i).trim() === "image"),
      };
    })
    .filter((m) => m.id.length > 0)
    // `:batch` variants are queued through OpenRouter's separate batch API and
    // reject a normal synchronous chat completion outright (HTTP 404). YIMPIM
    // never does batch work — discovery, planning, editing and verification
    // all need an answer in the same call — so a batch endpoint can never
    // actually serve any role here and is excluded before a user ever sees it.
    .filter((m) => !m.id.endsWith(":batch"));
}

/** Models valid for a persona, cheapest first — the ordering that matters for tiering. */
export function candidatesFor(catalog: CatalogModel[], persona: PersonaNeeds): CatalogModel[] {
  // Variable-price router models sort last: their cost is unknowable up front,
  // so they must never appear as the "cheapest" recommendation.
  const rank = (m: CatalogModel): number =>
    m.promptCost === null || m.completionCost === null
      ? Number.POSITIVE_INFINITY
      : m.promptCost + m.completionCost;

  return catalog
    .filter((m) => (!persona.requiresTools || m.supportsTools) && (!persona.requiresVision || m.supportsVision))
    .sort((a, b) => rank(a) - rank(b));
}

export function formatModel(m: CatalogModel): string {
  const cost =
    m.promptCost === null || m.completionCost === null
      ? "variable price"
      : m.promptCost === 0 && m.completionCost === 0
        ? "free"
        : `$${m.promptCost.toFixed(2)}/$${m.completionCost.toFixed(2)} per M in/out`;
  const ctx = m.contextLength >= 1000 ? `${Math.round(m.contextLength / 1000)}k ctx` : `${m.contextLength} ctx`;
  return `${m.id}  —  ${cost}, ${ctx}`;
}
