/**
 * Makes the orchestrator design before it builds. When a request creates (or restyles) user-facing UI,
 * a design system is written into the project once, and every later agent builds from it:
 *
 *   1. decide  — does this request need one, and for which kind of product? (a model reads the request)
 *   2. direct  — a model chooses among our playbooks, styles and type pairings, and one signature colour
 *   3. build   — code validates the choice and builds the scales, the light/dark colour roles (measured
 *                with the same contrast gates the logo kit uses), type scale, spacing, radius, motion
 *   4. write   — design-system/MASTER.md (read by the Planner and Editor), tokens.css and/or tokens.ts
 *
 * A model chooses what judgement should choose; code checks what can be measured. Nothing is installed.
 */
import fs from "node:fs";
import path from "node:path";
import { buildPalette, parsePaletteChoice, tokensCss, ROLE_KEYS, type PaletteSystem } from "./palette.js";
import { normalizeColor } from "./svgSafety.js";
import { PAGE_TYPES, PLAYBOOKS, RULES, SLOP_SIGNS, STYLES, VARIANCE, findPageType, findPlaybook, findStyle, type Pairing, type Platform, type Playbook, type StyleFamily } from "./uiKnowledge.js";
import {
  allPairings, chartRows, findAnyPairing, findLanding, findProduct, landingMenu, landingPatterns, nativeRules, productMenu, stackKeys, stackNotes, styleDetail, type ProductRow,
} from "./uiData.js";
import { hexToOklch } from "./colorlib.js";
import { findFont, loadCatalog } from "./wordmark.js";
import { CORE_ICONS, WEIGHTS, fetchIconPaths, iconNamesTxt, iconsDoc, iconsTs, packageFor, readIcon, resolveIconWords, type FetchText, type IconWeight } from "./phosphor.js";

export type Call = (models: string[], messages: { role: "system" | "user" | "assistant"; content: string | any[] }[], label: string, json: boolean) => Promise<string>;

import { DESIGN_DIR, THEME_FILE, findBrandKit, writeUiTheme, type BrandFacts } from "./identity.js";
export { DESIGN_DIR, findBrandKit, type BrandFacts };

// ---------------------------------------------------------------------------
// what the project already is
// ---------------------------------------------------------------------------

export interface UiStack {
  platform: "web" | "native" | "both" | "unknown";
  frameworks: string[];
  styling: string[];
  iconLibs: string[];
  fontPackages: string[];
  themeFiles: string[];
  hasUi: boolean;
}

const ICON_LIBS = ["lucide-react", "lucide-react-native", "@expo/vector-icons", "react-native-vector-icons", "phosphor-react", "phosphor-react-native", "@phosphor-icons/react", "@heroicons/react", "react-icons", "@tabler/icons-react", "@tabler/icons-react-native", "lucide-vue-next", "lucide-svelte", "@iconify/react", "react-native-svg"];

export function detectUiStack(repoRoot: string): UiStack {
  const deps = new Set<string>();
  const readDeps = (file: string) => {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf-8"));
      for (const k of Object.keys({ ...j.dependencies, ...j.devDependencies })) deps.add(k);
    } catch {
      // no manifest here
    }
  };
  readDeps(path.join(repoRoot, "package.json"));
  for (const sub of ["app", "web", "mobile", "frontend", "client", "apps/web", "apps/mobile"]) readDeps(path.join(repoRoot, sub, "package.json"));
  const has = (re: RegExp) => [...deps].some((d) => re.test(d));
  const native = has(/^(react-native|expo)$/) || fs.existsSync(path.join(repoRoot, "pubspec.yaml")) || fs.existsSync(path.join(repoRoot, "app.json"));
  const web = has(/^(next|react-dom|vue|nuxt|svelte|@sveltejs\/kit|astro|vite|@angular\/core|solid-js|remix|@remix-run\/react)$/) || fs.existsSync(path.join(repoRoot, "index.html"));
  const frameworks = [...deps].filter((d) => /^(react|react-native|expo|next|vue|nuxt|svelte|@sveltejs\/kit|astro|@angular\/core|solid-js|vite|expo-router|react-navigation|@react-navigation\/native)$/.test(d));
  const styling = [...deps].filter((d) => /^(tailwindcss|nativewind|styled-components|@emotion\/react|@mui\/material|@chakra-ui\/react|@mantine\/core|sass|@shopify\/restyle|tamagui|unistyles|react-native-paper|shadcn|@radix-ui\/react-slot)$/.test(d));
  const fontPackages = [...deps].filter((d) => /^@expo-google-fonts\/|^expo-font$|^@fontsource/.test(d));
  const iconLibs = ICON_LIBS.filter((d) => deps.has(d));
  const themeFiles: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || themeFiles.length >= 10) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || ["node_modules", "dist", "build", "android", "ios", DESIGN_DIR].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/^(theme|tokens|colors|colours|palette|tailwind\.config|design-tokens)\.(ts|tsx|js|cjs|mjs|json|css)$/i.test(e.name)) themeFiles.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
    }
  };
  walk(repoRoot, 0);
  const platform: UiStack["platform"] = native && web ? "both" : native ? "native" : web ? "web" : "unknown";
  return { platform, frameworks, styling, iconLibs, fontPackages, themeFiles, hasUi: native || web || themeFiles.length > 0 };
}

// ---------------------------------------------------------------------------
// 1. does this request need a design system?
// ---------------------------------------------------------------------------

export interface UiDecision {
  ui: "none" | "new" | "restyle" | "extend";
  platform: "web" | "native" | "both" | "unknown";
  playbook: string | null;
  /** A row of the product reference table (musts, conditions, category palette), or null. */
  product: string | null;
  why: string;
}

export const DECIDE_SYSTEM =
  "You decide whether a software request needs a DESIGN SYSTEM written first. Answer by what the request asks the product to LOOK like:\n" +
  '- "new": it creates a new user-facing product, site, app or a set of major screens from scratch (a news website, a habit tracker app, a dashboard).\n' +
  '- "restyle": it asks to redesign, refresh, modernise or change the look of existing UI as a whole.\n' +
  '- "extend": it adds or changes a feature or a screen inside UI that already exists.\n' +
  '- "none": no user-facing UI is involved (backend, logic, bug fix, tests, tooling, docs, configuration).\n' +
  "Also say which platform (web, native for a phone app, both, or unknown), pick the closest playbook id for the kind of product (or null), and the closest row of the product list (or null).\n" +
  'Respond ONLY with JSON: {"ui": "none"|"new"|"restyle"|"extend", "platform": "web"|"native"|"both"|"unknown", "playbook": id|null, "product": product id|null, "why": "one sentence"}';

export function parseUiDecision(text: string, stack: UiStack): UiDecision | null {
  const j = parseObj(text);
  if (!j) return null;
  const ui = j.ui === "new" || j.ui === "restyle" || j.ui === "extend" ? j.ui : "none";
  const platform = j.platform === "web" || j.platform === "native" || j.platform === "both" ? j.platform : stack.platform;
  return {
    ui,
    platform,
    playbook: findPlaybook(j.playbook) ? String(j.playbook) : null,
    product: findProduct(j.product) ? String(j.product) : null,
    why: typeof j.why === "string" ? j.why.slice(0, 200) : "",
  };
}

// ---------------------------------------------------------------------------
// 2. the direction (a model chooses; code validates)
// ---------------------------------------------------------------------------

export interface Direction {
  name: string;
  playbook: string;
  style: string;
  secondStyle?: string;
  pairing: string;
  signature: string;
  accent: string | null;
  ground: "white" | "warm" | "cool";
  neutralHue: number | null;
  radius: StyleFamily["radius"];
  density: "airy" | "balanced" | "dense";
  motion: "still" | "subtle" | "expressive";
  imagery: string;
  memorableMove: string;
  personality: string[];
  /** An installed icon library, "phosphor" (the default set), or "inline-svg". */
  iconLibrary: string;
  iconWeight: IconWeight;
  /** Plain words for the icons this product needs; code turns them into real Phosphor names. */
  iconWords: string[];
  avoid: string[];
  contentNote: string;
  /** The product reference row this was designed against, if any. */
  product?: string;
  /** How adventurous the layouts are. */
  variance: "low" | "mid" | "high";
  /** Which theme the product opens in. */
  defaultMode: "light" | "dark" | "system";
  /** Which of the product row's conditions apply to this product (validated against the row). */
  applies: string[];
  /** The main screens, each with the kind of page it is. */
  screens: { name: string; pageType: string }[];
  /** A landing-page structure (web marketing pages), or null. */
  landing: string | null;
  /** The product shows charts or dense data. */
  dataViz: boolean;
}

const strs = (v: unknown, n: number): string[] => (Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim().slice(0, 140)).filter(Boolean).slice(0, n);

export function parseDirection(text: string, playbook: Playbook, stack: UiStack, fallbackName: string, product?: ProductRow): Direction | null {
  const j = parseObj(text);
  if (!j) return null;
  const style = findStyle(j.style) ? String(j.style) : playbook.styles[0];
  const second = findStyle(j.secondStyle) && j.secondStyle !== style ? String(j.secondStyle) : undefined;
  const pairing = findAnyPairing(j.pairing) ? String(j.pairing) : playbook.pairings[0];
  const conditions = Object.keys(product?.when ?? {});
  const screens = (Array.isArray(j.screens) ? j.screens : [])
    .map((s: any) => ({ name: String(s?.name ?? "").trim().slice(0, 40), pageType: String(s?.pageType ?? "") }))
    .filter((s: { name: string; pageType: string }) => s.name && findPageType(s.pageType))
    .slice(0, 8);
  const sig = typeof j.signature === "string" ? normalizeColor(j.signature) : null;
  // A signature that is grey or near-white/near-black is not a colour a brand can own.
  const o = sig ? hexToOklch(sig) : null;
  const signature = sig && o && o.c >= 0.06 && o.l > 0.25 && o.l < 0.85 ? sig : fallbackSignature(playbook);
  const acc = typeof j.accent === "string" ? normalizeColor(j.accent) : null;
  const available = stack.iconLibs.filter((l) => l !== "react-native-svg");
  const phosphorInstalled = available.find((l) => /phosphor/i.test(l));
  let iconLibrary = typeof j.iconLibrary === "string" && (available.includes(j.iconLibrary) || j.iconLibrary === "inline-svg" || j.iconLibrary === "phosphor") ? j.iconLibrary : available[0] ?? "phosphor";
  if (iconLibrary === "phosphor" && phosphorInstalled) iconLibrary = phosphorInstalled;
  const fam = findStyle(style)!;
  return {
    name: typeof j.name === "string" && j.name.trim() ? j.name.trim().slice(0, 60) : fallbackName,
    playbook: playbook.id,
    style,
    secondStyle: second,
    pairing,
    signature,
    accent: acc && hexToOklch(acc).c >= 0.05 ? acc : null,
    ground: j.ground === "warm" || j.ground === "cool" ? j.ground : "white",
    neutralHue: Number.isFinite(Number(j.neutralHue)) ? ((Number(j.neutralHue) % 360) + 360) % 360 : null,
    radius: j.radius === "sharp" || j.radius === "soft" || j.radius === "round" ? j.radius : fam.radius,
    density: j.density === "airy" || j.density === "dense" ? j.density : "balanced",
    motion: j.motion === "still" || j.motion === "expressive" ? j.motion : "subtle",
    imagery: typeof j.imagery === "string" ? j.imagery.slice(0, 240) : "",
    memorableMove: typeof j.memorableMove === "string" ? j.memorableMove.slice(0, 240) : "",
    personality: strs(j.personality, 5),
    iconLibrary,
    iconWeight: (WEIGHTS as string[]).includes(j.iconWeight) && j.iconWeight !== "duotone" && j.iconWeight !== "fill" ? j.iconWeight : "regular",
    iconWords: strs(j.iconWords, 24),
    avoid: strs(j.avoid, 6),
    contentNote: typeof j.contentNote === "string" ? j.contentNote.slice(0, 240) : "",
    product: product?.id,
    variance: j.variance === "low" || j.variance === "high" ? j.variance : "mid",
    defaultMode: j.defaultMode === "dark" || j.defaultMode === "light" ? j.defaultMode : "system",
    applies: strs(j.applies, 8).filter((a) => conditions.includes(a)),
    screens,
    landing: findLanding(j.landing) ? String(j.landing) : null,
    dataViz: j.dataViz === true,
  };
}

function fallbackSignature(p: Playbook): string {
  // A deliberate, non-default hue per kind of product, so a missing choice does not become default blue.
  const by: Record<string, string> = { news: "#b4231f", blog: "#8a3b2f", health: "#0f7b6c", fintech: "#1d4ed8", education: "#6d28d9", kids: "#f97316", restaurant: "#b45309", tracker: "#0d9488", ai: "#2f6f4e", devtool: "#2563eb", ecommerce: "#0f766e" };
  return by[p.id] ?? "#2f5fd0";
}

/** What the product reference row says, as the brief a designer would be handed. */
export function productBrief(p: ProductRow | undefined): string {
  if (!p) return "";
  const when = Object.entries(p.when).map(([c, a]) => `- if ${c}: ${a.join("; ")}`).join("\n");
  return (
    `\nReference for "${p.name}" (a starting point, not a template):\n- Pattern: ${p.pattern}. Style priority: ${p.style}. Colour mood: ${p.colour}. Type mood: ${p.type}. Key effects: ${p.fx}.\n- Anti-patterns: ${p.anti}.\n` +
    (p.must.length ? `- Must have: ${p.must.join("; ")}.\n` : "") +
    (when ? `Conditions (list in "applies" the ones that are true for this product):\n${when}\n` : "") +
    `- The usual palette for this kind of product: primary ${p.palette.primary}, accent ${p.palette.accent}, background ${p.palette.background}${p.palette.note ? ` (${p.palette.note})` : ""}. That is the category norm: either choose deliberately against it, or stay within it and say why in the memorable move.\n`
  );
}

/** The approved identity, as a brief the direction must honour rather than re-choose. */
export function brandBrief(brand: BrandFacts | null | undefined): string {
  if (!brand) return "";
  return (
    `THE IDENTITY IS ALREADY DECIDED (an approved brand kit at ${brand.dir}). The product UI is the same identity, not a new one: ` +
    `signature colour ${brand.signature}${brand.accent ? `, accent ${brand.accent}` : ""}${brand.display ? `, type ${brand.display}${brand.body ? ` / ${brand.body}` : ""}` : ""}${brand.palette ? ", with a measured light and dark palette that will be used as it is" : ""}. ` +
    `${brand.personality.length ? `Its personality: ${brand.personality.join(", ")}. ` : ""}${brand.idea ? `Its idea: ${brand.idea} ` : ""}` +
    `Do not choose a different signature, accent, ground or typeface; choose the style, density, motion, variance, screens and the rest so that they suit THIS identity. Your \"signature\" and \"pairing\" answers will be ignored.

`
  );
}

export function directionSystem(playbook: Playbook, stack: UiStack, platform: string, product?: ProductRow, brand?: BrandFacts | null): string {
  const web = platform !== "native";
  return (
    brandBrief(brand) +
    "You are the head of design for a product team. You choose the look of a product BEFORE anything is built, so that the result looks designed, not generated. " +
    "Your job is to choose, not to describe. Principles: one clear idea; a strong hierarchy; a restrained palette (one signature colour, at most one accent); a type pairing with a role for each face; real content; consistent spacing and radius; every state designed. " +
    "Choose against the clichés of the category and of generated UI:\n- " + SLOP_SIGNS.join("\n- ") + "\n" +
    "Reflex test: would you propose this same colour, typeface or layout for any other product of this kind? If yes, change it or justify it from the brief.\n\n" +
    `The chosen playbook is "${playbook.name}". Its structure: ${playbook.structure}\nIts colour guidance: ${playbook.colour}\nIts type guidance: ${playbook.type}\nIt must have: ${playbook.musts.join("; ")}\nIt must avoid: ${playbook.anti.join("; ")}\n\n` +
    `Styles to choose from (id: name — traits):\n${STYLES.map((s) => `${s.id}: ${s.name} — ${s.traits.slice(0, 110)}`).join("\n")}\n\n` +
    productBrief(product) + "\n" +
    `Type pairings (id: heading / body — mood). Some cover other scripts (Japanese, Korean, Chinese, Arabic, Thai, Hebrew, Vietnamese): choose one of those if the product serves that language.\n${allPairings().map((p) => `${p.id}: ${p.heading} / ${p.body} — ${p.mood.slice(0, 70)}`).join("\n")}\n\n` +
    (web && landingPatterns().length ? `Landing-page structures (id: name — section order), for a marketing page; choose one or null:\n${landingMenu()}\n\n` : "") +
    `Page types for the screens: ${PAGE_TYPES.map((p) => p.id).join(", ")}.\n\n` +
    `The project: platform ${platform}; ${stack.frameworks.length ? `uses ${stack.frameworks.join(", ")}; ` : ""}${stack.styling.length ? `styling ${stack.styling.join(", ")}; ` : ""}${stack.iconLibs.length ? `icon libraries installed: ${stack.iconLibs.join(", ")}` : "no icon library installed (Phosphor is the default set)"}.\n` +
    'Respond ONLY with JSON: {"name": "the product name if known", "style": style id, "secondStyle": style id|null, "pairing": pairing id, "signature": "#hex (a colour with a clear hue, mid lightness, not the category default)", "accent": "#hex"|null, ' +
    '"ground": "white"|"warm"|"cool", "neutralHue": 0-360, "radius": "sharp"|"soft"|"round", "density": "airy"|"balanced"|"dense", "motion": "still"|"subtle"|"expressive", ' +
    '"personality": [3-5 adjectives], "memorableMove": "the ONE distinctive thing about this design, in one sentence", "imagery": "what the visuals are and how placeholders look", ' +
    '"iconLibrary": an installed library name, or "phosphor" (the default: free, MIT, about 1,500 icons in six weights), "iconWeight": "thin"|"light"|"regular"|"bold" (match the weight of the type), "iconWords": [up to 20 plain words for the icons this product needs, e.g. newspaper, bookmark, football, share], "contentNote": "what real sample content to write and where it lives", "avoid": [things specific to this product to avoid], ' +
    '"variance": "low" (predictable, symmetric)|"mid"|"high" (asymmetric, bold) — how adventurous the layouts are, "defaultMode": "light"|"dark"|"system", ' +
    '"applies": [condition names from the reference that are true here], "screens": [{"name": "Home", "pageType": one of the page types}, 3 to 8 of the main screens], ' +
    '"landing": a landing-page id or null, "dataViz": true if the product shows charts or dense data}'
  );
}

// ---------------------------------------------------------------------------
// 3. the tokens
// ---------------------------------------------------------------------------

export interface TypeStep {
  name: string;
  size: number;
  line: number;
}

export function typeScale(ratio: number, base = 16): TypeStep[] {
  const names = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl"];
  const exps = [-2, -1, 0, 1, 2, 3, 4, 5];
  const out = exps.map((e, i) => {
    const size = Math.max(12, Math.round(base * Math.pow(ratio, e)));
    return { name: names[i], size, line: Math.round(size * (e <= 0 ? 1.55 : e <= 2 ? 1.35 : 1.15)) };
  });
  // The floor of 12 must not make two steps the same size: each step is at least one larger than the one below.
  for (let i = 1; i < out.length; i++) {
    if (out[i].size <= out[i - 1].size) {
      out[i].size = out[i - 1].size + 1;
      out[i].line = Math.round(out[i].size * (exps[i] <= 0 ? 1.55 : exps[i] <= 2 ? 1.35 : 1.15));
    }
  }
  return out;
}

export const SPACING = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96];

export function radiusTokens(r: StyleFamily["radius"]): Record<string, number> {
  const t = { sharp: { sm: 2, md: 4, lg: 6 }, soft: { sm: 6, md: 10, lg: 16 }, round: { sm: 10, md: 16, lg: 28 } }[r];
  return { ...t, full: 999 };
}

export function elevationTokens(e: StyleFamily["elevation"]): Record<string, string> {
  if (e === "flat") return { sm: "none", md: "none", lg: "0 0 0 1px rgb(0 0 0 / 0.08)" };
  if (e === "subtle") return { sm: "0 1px 2px rgb(0 0 0 / 0.06)", md: "0 4px 12px rgb(0 0 0 / 0.08)", lg: "0 12px 32px rgb(0 0 0 / 0.12)" };
  return { sm: "0 2px 4px rgb(0 0 0 / 0.10)", md: "0 8px 20px rgb(0 0 0 / 0.14)", lg: "0 20px 48px rgb(0 0 0 / 0.20)" };
}

export function motionTokens(m: Direction["motion"]): { fast: number; base: number; slow: number } {
  return m === "still" ? { fast: 80, base: 120, slow: 160 } : m === "expressive" ? { fast: 140, base: 240, slow: 420 } : { fast: 120, base: 200, slow: 320 };
}

export interface DesignSystem {
  direction: Direction;
  platform: "web" | "native" | "both";
  playbook: Playbook;
  style: StyleFamily;
  pairing: Pairing;
  palette: PaletteSystem;
  type: { heading: string; body: string; scale: TypeStep[]; fontNote: string };
  radius: Record<string, number>;
  elevation: Record<string, string>;
  motion: { fast: number; base: number; slow: number };
  notes: string[];
  /** The approved brand kit this system took its identity from, if any. */
  brand?: BrandFacts;
}

/**
 * The typeface pair an approved brand kit fixes: its heading face, and for text its own body face, else the
 * heading face itself when that is a text face, else the pairing the design step chose.
 */
function brandPairing(brand: BrandFacts, fallback: Pairing): Pairing | null {
  if (!brand.display) return null;
  const entry = findFont(loadCatalog().find((f) => f.family === brand.display)?.id);
  const body = brand.body ?? (entry?.body ? brand.display : fallback.body);
  return { id: "brand", heading: brand.display, body, mood: "from the approved brand kit", weights: { heading: "400;700", body: "400;700" } };
}

export function buildDesignSystem(d: Direction, platform: "web" | "native" | "both", stack: UiStack, brand?: BrandFacts | null): DesignSystem {
  const playbook = findPlaybook(d.playbook)!;
  const style = findStyle(d.style)!;
  const chosenPairing = findAnyPairing(d.pairing)!;
  const pairing = (brand && brandPairing(brand, chosenPairing)) || chosenPairing;
  const notes: string[] = [];
  const choice = parsePaletteChoice({ ground: d.ground, neutralHue: d.neutralHue, accent: d.accent, why: d.memorableMove }, [d.signature]);
  // An approved brand kit's measured palette is used as it is: the same colours, scales, light and dark roles.
  const palette = brand?.palette ?? buildPalette([d.signature], choice);
  if (brand?.palette) notes.push(`The palette is the approved brand kit's (${brand.dir}); it was not rebuilt.`);
  if (brand && pairing.id === "brand") notes.push(`The type is the approved brand kit's: ${pairing.heading}${pairing.body !== pairing.heading ? ` / ${pairing.body}` : ""}.`);
  // Native apps use the system face unless a font package is already installed: nothing is installed for style.
  const nativeOnly = platform === "native";
  const useCustom = !nativeOnly || stack.fontPackages.length > 0;
  const type = {
    heading: useCustom ? pairing.heading : "System",
    body: useCustom ? pairing.body : "System",
    scale: typeScale(style.scale + (d.density === "airy" ? 0.05 : d.density === "dense" ? -0.05 : 0)),
    fontNote: useCustom
      ? nativeOnly
        ? `${pairing.heading} / ${pairing.body} through the installed font package; fall back to the system font until loaded.`
        : `Load ${pairing.heading} and ${pairing.body} from Google Fonts with font-display: swap, falling back to the system stack.`
      : `Native app with no font package installed: use the platform system font and create hierarchy with size and weight. (${pairing.heading} / ${pairing.body} is the pairing to adopt if a font package is added later.)`,
  };
  if (palette.checks.some((c) => c.id === "ai-default-colours" && c.status === "fail")) notes.push("The palette is a common default combination; keep it only if it is right for this product.");
  return { direction: d, platform, playbook, style, pairing, palette, type, radius: radiusTokens(d.radius), elevation: elevationTokens(style.elevation), motion: motionTokens(d.motion), notes, brand: brand ?? undefined };
}

// ---------------------------------------------------------------------------
// 4. the files
// ---------------------------------------------------------------------------

const fontStack = (family: string) => (family === "System" ? 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' : `"${family}", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`);

export function webTokens(s: DesignSystem): string {
  const gf = [s.pairing.heading, s.pairing.body]
    .filter((f, i, a) => a.indexOf(f) === i)
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@${(f === s.pairing.heading ? s.pairing.weights.heading : s.pairing.weights.body).split(";").join(";")}`)
    .join("&");
  const t = s.type.scale.map((x) => `  --text-${x.name}: ${(x.size / 16).toFixed(3).replace(/\.?0+$/, "")}rem;\n  --leading-${x.name}: ${x.line}px;`).join("\n");
  return (
    `/* Generated by the design step from design-system/MASTER.md. Use these tokens; do not hard-code colours or sizes. */\n` +
    `/* Fonts: <link rel="stylesheet" href="https://fonts.googleapis.com/css2?${gf}&display=swap"> */\n` +
    tokensCss(s.palette, "color").replace(/^\/\*.*\*\/\n/, "") +
    `:root {\n  --font-heading: ${fontStack(s.type.heading)};\n  --font-body: ${fontStack(s.type.body)};\n${t}\n` +
    SPACING.map((v, i) => `  --space-${i}: ${v}px;`).join("\n") + "\n" +
    Object.entries(s.radius).map(([k, v]) => `  --radius-${k}: ${v}px;`).join("\n") + "\n" +
    Object.entries(s.elevation).map(([k, v]) => `  --shadow-${k}: ${v};`).join("\n") + "\n" +
    `  --duration-fast: ${s.motion.fast}ms;\n  --duration-base: ${s.motion.base}ms;\n  --duration-slow: ${s.motion.slow}ms;\n  --ease-out: cubic-bezier(0.2, 0.7, 0.2, 1);\n` +
    `  --z-sticky: 20;\n  --z-overlay: 30;\n  --z-modal: 50;\n  --measure: 68ch;\n  --target-min: 44px;\n}\n` +
    `@media (prefers-reduced-motion: reduce) {\n  :root { --duration-fast: 0.01ms; --duration-base: 0.01ms; --duration-slow: 0.01ms; }\n}\n` +
    `:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }\n`
  );
}

export function nativeTokens(s: DesignSystem): string {
  const obj = (o: Record<string, string | number>) => "{ " + Object.entries(o).map(([k, v]) => `${/^[a-z_][a-z0-9_]*$/i.test(k) ? k : JSON.stringify(k)}: ${typeof v === "number" ? v : JSON.stringify(v)}`).join(", ") + " }";
  const roles = (r: Record<string, string>) => `{\n${ROLE_KEYS.map((k) => `    ${k}: ${JSON.stringify(r[k])},`).join("\n")}\n  }`;
  return (
    `// Generated by the design step from design-system/MASTER.md. Use these tokens; do not hard-code colours or sizes.\n` +
    `export const colors = {\n  light: ${roles(s.palette.light as any)},\n  dark: ${roles(s.palette.dark as any)},\n} as const;\n\n` +
    `export const brand = ${JSON.stringify(s.palette.brand.map((b) => ({ name: b.name, hex: b.hex })))} as const;\n\n` +
    `export const spacing = [${SPACING.join(", ")}] as const; // index = step\n\n` +
    `export const radius = ${obj(s.radius)} as const;\n\n` +
    `export const typography = {\n  heading: ${JSON.stringify(s.type.heading)},\n  body: ${JSON.stringify(s.type.body)},\n  scale: ${obj(Object.fromEntries(s.type.scale.map((x) => [x.name, x.size])))},\n  lineHeight: ${obj(Object.fromEntries(s.type.scale.map((x) => [x.name, x.line])))},\n} as const;\n\n` +
    `export const motion = ${obj(s.motion)} as const; // milliseconds; skip animation when reduce-motion is on\n\n` +
    `export const touchTarget = 48; // dp/pt minimum for anything tappable\n`
  );
}

export const REFERENCE_FILES = ["style.md", "screens.md", "charts.md", "native.md", "stack.md", "icons.md", "icon-names.txt", "icons.ts"];

export interface RefDoc {
  name: string;
  /** one line for MASTER.md: when to read it */
  about: string;
  data: string;
}

/**
 * Longer reference notes, written beside MASTER.md and read on demand, so the always-on prompt stays short:
 * how to build the chosen style, what each screen needs, chart rules, native-app rules, stack notes.
 */
export function referenceDocs(s: DesignSystem, stack: UiStack): RefDoc[] {
  const d = s.direction;
  const out: RefDoc[] = [];

  const styles = [s.style, d.secondStyle ? findStyle(d.secondStyle) : undefined].filter((x): x is StyleFamily => !!x);
  const sd = styles.map((x) => ({ fam: x, det: styleDetail(x.ref) })).filter((x) => x.det);
  if (sd.length) {
    out.push({
      name: "style.md",
      about: "before writing any component: how to build the chosen style (CSS notes, variables, checklist)",
      data:
        `# How to build: ${styles.map((x) => x.name).join(" + ")}\n\n` +
        sd
          .map(
            ({ fam, det }) =>
              `## ${fam.name}\n- Traits: ${fam.traits}\n- Best for: ${det!.best}. Not for: ${det!.avoid}.\n- Effects: ${det!.fx}\n- Accessibility: ${det!.a11y}. Always keep text contrast at 4.5:1, visible focus and a reduced-motion version.\n- CSS and technical notes: ${det!.css}\n- Variables: ${det!.vars}\n- Before you finish:\n${det!.checklist.map((c) => `  - ${c}`).join("\n")}\n`
          )
          .join("\n"),
    });
  }

  const lines: string[] = [];
  for (const sc of d.screens) {
    const pt = findPageType(sc.pageType);
    if (pt) lines.push(`## ${sc.name} (${pt.name})\n- Layout: ${pt.layout}\n- Components: ${pt.components}\n- States to design: ${pt.states}\n- Watch for: ${pt.watch}\n`);
  }
  const lp = findLanding(d.landing);
  if (lp) lines.push(`## Landing structure: ${lp.name}\n- Section order: ${lp.sections}\n- Primary action placement: ${lp.cta}\n- Colour use: ${lp.colour}\n- Effects: ${lp.fx}\n- Conversion notes: ${lp.convert}\n`);
  if (lines.length) {
    out.push({ name: "screens.md", about: "before building each screen: what that kind of page needs", data: `# Screens\n\nVariance: ${d.variance}. ${VARIANCE[d.variance]}\n\n${lines.join("\n")}` });
  }

  if (d.dataViz && chartRows().length) {
    out.push({
      name: "charts.md",
      about: "before building any chart or data table: which chart for which data, and how to keep it accessible",
      data:
        `# Charts\n\nPick the chart from the data, not the other way round. Never separate series by hue alone; always offer a table or text summary.\n\n` +
        chartRows()
          .map((c) => `## ${c.data}: ${c.best} (also: ${c.alt || "none"})\n- Use when: ${c.use}\n- Not when: ${c.not}\n- Size: ${c.volume}\n- Colour: ${c.colour}\n- Accessibility: ${c.a11y} Fallback: ${c.fallback}\n- Library: ${c.lib}\n`)
          .join("\n"),
    });
  }

  if (s.platform !== "web" && nativeRules().length) {
    const rules = nativeRules();
    out.push({
      name: "native.md",
      about: "before building any native screen: iOS, Android and React Native interface rules",
      data:
        `# Native interface rules\n\n` +
        rules.map((r) => `- [${r.sev}] ${r.issue} (${r.platform}): ${r.do} Not: ${r.not}${r.good ? `\n  good: ${r.good}\n  bad: ${r.bad}` : ""}`).join("\n") +
        "\n",
    });
  }

  const keys = stackKeys(stack.frameworks, stack.styling, s.platform, stack.frameworks.includes("flutter"));
  const notes = keys.flatMap((k) => stackNotes(k).map((n) => ({ k, n })));
  if (notes.length) {
    out.push({
      name: "stack.md",
      about: "when styling components in this stack: the UI practices that matter here",
      data: `# Stack notes (${keys.join(", ")})\n\n` + notes.map(({ k, n }) => `- [${n.sev}] ${k} / ${n.cat}: ${n.rule}. ${n.do} Not: ${n.not}`).join("\n") + "\n",
    });
  }
  return out;
}

export function masterDoc(s: DesignSystem, stack: UiStack, request: string, refs: RefDoc[] = [], brand?: BrandFacts | null): string {
  const d = s.direction;
  const p = s.palette;
  const platform = s.platform === "both" ? "web and native" : s.platform;
  const rules = RULES.filter((r) => (r.sev === "critical" || r.sev === "high") && (r.platform === "all" || s.platform === "both" || r.platform === s.platform));
  const role = (k: (typeof ROLE_KEYS)[number]) => `| ${k} | ${p.light[k]} | ${p.dark[k]} |`;
  return (
    `# Design system: ${d.name}\n\n` +
    `Read this before you write or change any screen, page or component. It is binding for all user-facing UI in this project. Made at the start of the work from the request: "${request.replace(/\s+/g, " ").slice(0, 160)}".\n\n` +
    `## Direction\n- Product type: ${s.playbook.name} (${platform}). Style: ${s.style.name}${d.secondStyle ? ` with ${findStyle(d.secondStyle)?.name}` : ""}. Personality: ${d.personality.join(", ") || "calm, clear"}.\n` +
    `- The one memorable move: ${d.memorableMove || "(not stated)"}\n- Imagery: ${d.imagery || "real photography or intentional flat placeholders with fixed aspect ratios"}\n` +
    `- Density: ${d.density}. Radius: ${d.radius}. Motion: ${d.motion} (${s.motion.fast}/${s.motion.base}/${s.motion.slow} ms; none when reduce-motion is on). Opens in the ${d.defaultMode} theme; both themes must pass.\n` +
    `- Layout variance ${d.variance}: ${VARIANCE[d.variance]}\n` +
    (d.screens.length ? `- Main screens: ${d.screens.map((x) => `${x.name} (${findPageType(x.pageType)?.name ?? x.pageType})`).join(", ")}.\n` : "") +
    `\n` +
    (() => {
      if (brand) {
        const f = (n: string) => (brand.files.includes(n) ? `\`${brand.dir}/${n}\`` : null);
        const use = [
          ["header logo on light", "lockup-horizontal.svg", "logo-on-light.svg"],
          ["header logo on dark", "lockup-horizontal-on-dark.svg", "logo-on-dark.svg"],
          ["favicon", "favicon.svg", "favicon.ico"],
          ["app icon", "app-icon.svg", "apple-touch-icon.png"],
        ]
          .map(([role, a, b]) => {
            const x = f(a) ?? f(b);
            return x ? `- ${role}: ${x}\n` : "";
          })
          .join("");
        return `## Identity (shared with the logo)\n- From the approved brand kit at \`${brand.dir}\`: the palette, type and logo are the kit's and were not chosen again. Do not recolour or redraw the logo; copy the kit's files into the app's assets.\n${use}\n`;
      }
      return `## Identity (shared with the logo)\n- This design system is the identity source (design-system/design.json). A logo made later must use signature ${s.palette.brand[0]?.hex}. Until then, set the product name in ${s.type.heading}; never a placeholder emoji or a stock mark.\n\n`;
    })() +
    `## Files (import these; do not hard-code values)\n${s.platform !== "native" ? "- `design-system/tokens.css` (CSS variables: `--color-*`, `--space-*`, `--radius-*`, `--text-*`, `--duration-*`)\n" : ""}${s.platform !== "web" ? "- `design-system/tokens.ts` (colors.light / colors.dark, spacing, radius, typography, motion)\n" : ""}` +
    (stack.themeFiles.length ? `- Existing theme files: ${stack.themeFiles.join(", ")}. Make them read from the tokens instead of keeping a second palette.\n` : "") +
    (refs.length ? `Also read, when it applies (these files are in design-system/):\n${refs.map((r) => `- \`design-system/${r.name}\` — ${r.about}`).join("\n")}\n` : "") +
    `\n## Structure of this kind of product\n${s.playbook.structure}\nMust have: ${[...s.playbook.musts, ...(findProduct(d.product)?.must ?? [])].filter((x, i, a) => a.indexOf(x) === i).join("; ")}.\n` +
    (() => {
      const row = findProduct(d.product);
      const on = d.applies.map((c) => `- If ${c}: ${(row?.when[c] ?? []).join("; ")}`);
      return on.length ? `Conditions that apply here:\n${on.join("\n")}\n` : "";
    })() +
    "\n" +
    `## Colour (measured)\nBrand: ${p.brand.map((b) => `${b.name} ${b.hex}`).join(", ")}. Use roles, never raw hex, and never raw scale steps in components.\n\n| Role | Light | Dark |\n|---|---|---|\n${ROLE_KEYS.map(role).join("\n")}\n\n` +
    `${p.checks.filter((c) => c.kind !== "judgement" && (c.id === "contrast" || c.status === "fail")).map((c) => `- ${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "NOT CHECKED"} ${c.id}: ${c.detail}`).join("\n")}\n` +
    `The loudest colour gets the least area. Primary actions use primary/onPrimary; links use link; status colours always come with an icon or word.\n\n` +
    `## Type\n- Heading: ${s.type.heading}. Body: ${s.type.body}. ${s.type.fontNote}\n- Scale (px / line): ${s.type.scale.map((x) => `${x.name} ${x.size}/${x.line}`).join(", ")}. Body at ${s.type.scale[2].size}px. Headings are clearly larger or heavier than body. Reading text 60-70 characters wide.\n\n` +
    `## Space, shape, depth\n- Spacing steps: ${SPACING.join(", ")} px (use steps only). Radius: ${Object.entries(s.radius).map(([k, v]) => `${k} ${v}`).join(", ")}. Elevation: ${s.style.elevation}.\n- Touch targets at least 44px (48dp on Android); 8px between them. Z-index scale 10/20/30/50.\n\n` +
    `## Components\n- Every control has default, hover (web), pressed, focus-visible, disabled and, where it can wait, loading states.\n- Inputs have a visible label above, helper text, and an error that says how to fix it. Buttons have one primary per view.\n- Every list or feed has an empty state, a loading skeleton and an error state with a retry.\n- Cards share one anatomy; do not make three identical cards the answer to every section.\n\n` +
    `## Icons\n- Library: ${/phosphor/i.test(d.iconLibrary) ? `Phosphor (all icons; names, usage and licence in design-system/icons.md). One weight: ${d.iconWeight}; fill only for active states.` : d.iconLibrary === "inline-svg" ? "none installed: write small inline SVG icon components in one icon file (24px grid, 1.75px stroke, rounded caps) and reuse them" : d.iconLibrary + " (already installed)"}. One set, one weight, one size scale.\n- Never emoji as icons, bullets, tab labels or status markers. Icon-only buttons need an accessible label.\n\n` +
    `## Content\n- ${d.contentNote || "Write believable sample content in the product's voice in one data file; replace it from real data later."}\n- No lorem ipsum, no 'Item 1', no made-up statistics or testimonials presented as real.\n\n` +
    `## Rules that are checked\n${rules.map((r) => `- ${r.do} Not: ${r.not}`).join("\n")}\n\n` +
    `## How this design would give itself away as generated (avoid)\n${[...SLOP_SIGNS, ...s.playbook.anti, ...d.avoid].map((x) => `- ${x}`).join("\n")}\n\n` +
    (s.notes.length ? `Notes: ${s.notes.join(" ")}\n` : "")
  );
}

// ---------------------------------------------------------------------------
// the step
// ---------------------------------------------------------------------------

export interface EnsureContext {
  call: Call;
  models: string[];
  repoRoot: string;
  request: string;
  log: (line: string) => void;
  /** Rebuild even if a design system already exists (the request asked for a redesign). */
  force?: boolean;
  /** Reads an icon's SVG from the published package (default: the pinned jsDelivr copy). Tests replace it. */
  fetchIcon?: FetchText;
}

export interface EnsureResult {
  created: boolean;
  dir: string;
  summary: string;
  files: string[];
}

function parseObj(text: string): any | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch {
      return null;
    }
  }
}

export function designSystemExists(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, DESIGN_DIR, "MASTER.md"));
}

/**
 * Writes the design system when the request calls for one. Never throws; never overwrites an existing
 * design system unless asked to; returns null when nothing was needed or nothing could be made.
 */
/** The person's own words about the look (design-system/BRIEF.md, written from the questionnaire), or "" when there is none. */
export function readDesignBrief(repoRoot: string): string {
  try {
    return fs.readFileSync(path.join(repoRoot, DESIGN_DIR, "BRIEF.md"), "utf8").slice(0, 1600);
  } catch {
    return "";
  }
}

export async function ensureDesignSystem(ctx: EnsureContext): Promise<EnsureResult | null> {
  const stack = detectUiStack(ctx.repoRoot);
  // When the person was asked about the look, the system is built from what they said and not from assumptions.
  const brief = readDesignBrief(ctx.repoRoot);
  const request = brief ? `${ctx.request.slice(0, 1500)}\n\nThe person's own words about the look and feel (follow them; a line marked "decided" was not answered by them):\n${brief}` : ctx.request.slice(0, 1500);
  const dir = path.join(ctx.repoRoot, DESIGN_DIR);
  let decision: UiDecision | null = null;
  try {
    decision = parseUiDecision(
      await ctx.call(
        ctx.models,
        [
          { role: "system", content: DECIDE_SYSTEM },
          {
            role: "user",
            content:
              `The request:\n${request.slice(0, 3200)}\n\nThe project: ${stack.platform}; ${stack.frameworks.join(", ") || "no framework found"}; ${stack.hasUi ? "has existing UI" : "no UI yet"}.\n\nPlaybooks (id: name — kinds of product):\n` +
              PLAYBOOKS.map((p) => `${p.id}: ${p.name} — ${p.aka.split(" ").slice(0, 8).join(" ")}`).join("\n") +
              `\n\nProduct list (id: name), pick the closest row or null:\n${productMenu()}`,
          },
        ],
        "design decision",
        true
      ),
      stack
    );
  } catch {
    return null;
  }
  if (!decision || decision.ui === "none" || decision.ui === "extend") return null;
  const exists = designSystemExists(ctx.repoRoot);
  if (exists && !ctx.force && decision.ui !== "restyle") return null;
  const playbook = findPlaybook(decision.playbook) ?? PLAYBOOKS.find((p) => p.id === "saas")!;
  const platform: "web" | "native" | "both" = decision.platform === "unknown" ? (playbook.kind === "native" ? "native" : "web") : decision.platform;
  const product = findProduct(decision.product);
  const brand = findBrandKit(ctx.repoRoot);
  let direction: Direction | null = null;
  try {
    direction = parseDirection(
      await ctx.call(
        ctx.models,
        [
          { role: "system", content: directionSystem(playbook, stack, platform, product, brand) },
          { role: "user", content: `The request:\n${request.slice(0, 3200)}\n\nThe folder name is "${path.basename(ctx.repoRoot)}". Choose the design direction.` },
        ],
        "design direction",
        true
      ),
      playbook,
      stack,
      path.basename(ctx.repoRoot),
      product
    );
  } catch {
    direction = null;
  }
  // No usable choice: fall back to the playbook's own first picks, so there is still a measured system.
  if (!direction) {
    direction = parseDirection("{}", playbook, stack, path.basename(ctx.repoRoot), product)!;
    ctx.log("[DESIGN] No usable design direction came back, so the playbook's defaults were used.");
  }
  if (brand) {
    // The approved identity wins over a fresh choice: same signature, same accent, and the type if it is in our pairings.
    direction.signature = brand.signature;
    direction.accent = brand.accent ?? direction.accent;
    if (brand.name && direction.name === path.basename(ctx.repoRoot)) direction.name = brand.name;
    const match = allPairings().find((p) => p.heading === brand.display && (!brand.body || p.body === brand.body)) ?? allPairings().find((p) => p.heading === brand.display);
    if (match) direction.pairing = match.id;
    ctx.log("[DESIGN] Using the approved brand kit's colours" + (match ? " and type" : "") + " for the product UI.");
  }
  const system = buildDesignSystem(direction, platform, stack, brand);
  // A redesign replaces the system, but the old one is kept beside it, never overwritten.
  const outDir = dir;
  fs.mkdirSync(outDir, { recursive: true });
  if (exists) {
    const old = path.join(dir, `previous-${Date.now()}`);
    fs.mkdirSync(old, { recursive: true });
    for (const f of ["MASTER.md", "tokens.css", "tokens.ts", THEME_FILE, ...REFERENCE_FILES]) {
      try {
        fs.renameSync(path.join(dir, f), path.join(old, f));
      } catch {
        // that file was not there
      }
    }
  }
  const rel = (f: string) => path.relative(ctx.repoRoot, path.join(outDir, f)).replace(/\\/g, "/");
  const files: string[] = [];
  const put = (name: string, data: string) => {
    fs.writeFileSync(path.join(outDir, name), data);
    files.push(rel(name));
  };
  const refs = [...referenceDocs(system, stack), ...(await iconDocs(system, stack, ctx.fetchIcon ?? readIcon))];
  put("MASTER.md", masterDoc(system, stack, ctx.request, refs, brand));
  // The machine-readable identity: the logo designer reads this so a logo made later matches the UI.
  writeUiTheme(outDir, {
    name: direction.name,
    signature: system.palette.brand[0]?.hex ?? direction.signature,
    accent: system.palette.brand.find((b) => b.hex !== (system.palette.brand[0]?.hex ?? ""))?.hex ?? direction.accent,
    ground: system.palette.ground,
    neutralHue: direction.neutralHue,
    heading: system.type.heading,
    body: system.type.body,
    style: system.style.id,
    personality: direction.personality,
    memorableMove: direction.memorableMove,
    source: brand ? "brand" : "ui",
    brandDir: brand?.dir,
  });
  files.push(rel(THEME_FILE));
  for (const r of refs) put(r.name, r.data);
  if (platform !== "native") put("tokens.css", webTokens(system));
  if (platform !== "web") put("tokens.ts", nativeTokens(system));
  const failed = system.palette.checks.filter((c) => c.kind === "gate" && c.status === "fail").map((c) => c.id);
  const summary =
    `Design system for ${direction.name}: ${system.playbook.name}, ${system.style.name}, ${system.pairing.heading} / ${system.pairing.body}, signature ${direction.signature}. ` +
    (direction.memorableMove ? `The move: ${direction.memorableMove} ` : "") +
    (failed.length ? `Gates failing: ${failed.join(", ")}.` : "Every measured colour gate passes.");
  ctx.log(`[DESIGN] ${summary}\n[DESIGN] Written to ${files.join(", ")}`);
  return { created: true, dir: outDir, summary, files };
}

// ---------------------------------------------------------------------------
// what agents are given
// ---------------------------------------------------------------------------

/** The design system for the system prompt, bounded; empty when the project has none. */
export function designSystemForPrompt(repoRoot: string, maxChars = 7500): string {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, DESIGN_DIR, "MASTER.md"), "utf-8");
    return raw.length > maxChars ? raw.slice(0, maxChars) + "\n...(truncated: read design-system/MASTER.md for the rest)" : raw;
  } catch {
    return "";
  }
}

export type { Platform };

/**
 * The icon notes: which package, which weight, which names, and (when nothing is installed) the path data of the
 * icons this product needs. Every name comes from the catalogue; the model only supplies plain words.
 */
export async function iconDocs(s: DesignSystem, stack: UiStack, read: FetchText): Promise<RefDoc[]> {
  const d = s.direction;
  if (!/phosphor/i.test(d.iconLibrary)) return [];
  const installed = stack.iconLibs.some((l) => /phosphor/i.test(l));
  const extra = resolveIconWords(d.iconWords).filter((n) => !Object.values(CORE_ICONS).includes(n));
  const wanted: IconWeight[] = [...new Set<IconWeight>(["regular", "fill", d.iconWeight])];
  let shapes: Awaited<ReturnType<typeof fetchIconPaths>> = {};
  if (!installed) {
    try {
      shapes = await fetchIconPaths([...Object.values(CORE_ICONS), ...extra], wanted, read);
    } catch {
      shapes = {};
    }
  }
  const haveShapes = Object.keys(shapes).length > 0;
  const pkg = packageFor(stack.frameworks, s.platform, stack.frameworks.includes("flutter"));
  const out: RefDoc[] = [
    {
      name: "icons.md",
      about: "before adding any icon: the package, the one weight, the names for common roles, and the licence",
      data: iconsDoc({ library: d.iconLibrary, installed, pkg, weight: d.iconWeight, extra, haveShapes, styleNote: "Pair it with the type: light or thin icons beside light type, bold beside bold." }),
    },
    { name: "icon-names.txt", about: "every valid icon name, by category (search it; do not guess names)", data: iconNamesTxt() },
  ];
  if (haveShapes) out.push({ name: "icons.ts", about: "icon path data for when nothing can be installed", data: iconsTs(shapes) });
  return out;
}
