/**
 * Phosphor Icons (MIT, https://phosphoricons.com): about 1,500 icons in six weights. The catalogue of names,
 * categories and tags is bundled (assets/ui/phosphor.json) so every icon can be found; the shapes themselves
 * are not bundled. A project gets them in one of two ways:
 *   - the official package for its stack (every icon, tree-shaken), added through the dependency flow, or
 *   - design-system/icons.ts: the path data of the icons this product needs, fetched from the published
 *     @phosphor-icons/core package, for when nothing can be installed.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const PHOSPHOR_VERSION = "2.1.1";
const CDN_HOST = "cdn.jsdelivr.net";
const CDN_PREFIX = `/npm/@phosphor-icons/core@${PHOSPHOR_VERSION}/assets/`;
const CATALOGUE = fileURLToPath(new URL("../assets/ui/phosphor.json", import.meta.url));

export type IconWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
export const WEIGHTS: IconWeight[] = ["thin", "light", "regular", "bold", "fill", "duotone"];

export interface IconEntry {
  n: string;
  c: string[];
  t: string[];
}

let cache: IconEntry[] | null = null;
export function catalogue(file: string = CATALOGUE): IconEntry[] {
  if (file === CATALOGUE && cache) return cache;
  let list: IconEntry[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(raw)) list = raw.filter((e: any) => e && typeof e.n === "string" && /^[a-z0-9-]+$/.test(e.n) && Array.isArray(e.t));
  } catch {
    list = [];
  }
  if (file === CATALOGUE) cache = list;
  return list;
}

const names = (): Set<string> => new Set(catalogue().map((e) => e.n));
export const isIcon = (name: unknown): name is string => typeof name === "string" && names().has(name);

/** arrow-square-in -> ArrowSquareIn: the component name in the React and React Native packages. */
export const pascal = (name: string) => name.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

/**
 * The icons that best match a word or short phrase: an exact name first, then names containing it, then tag
 * matches. The model supplies words ("newspaper", "football"); code supplies real names, so a name that does
 * not exist can never reach the project.
 */
export function searchIcons(word: string, limit = 2): string[] {
  const q = word.toLowerCase().replace(/[^a-z0-9 -]/g, " ").trim().replace(/\s+/g, "-");
  if (!q) return [];
  const scored: { n: string; s: number }[] = [];
  for (const e of catalogue()) {
    let s = 0;
    if (e.n === q) s = 100;
    else if (e.n.startsWith(q + "-")) s = 60;
    else if (e.n.split("-").includes(q)) s = 50;
    else if (e.n.includes(q)) s = 35;
    else if (e.t.some((t) => t.toLowerCase() === q.replace(/-/g, " "))) s = 30;
    else if (e.t.some((t) => t.toLowerCase().includes(q.replace(/-/g, " ")))) s = 15;
    // Shorter names are plainer, more general icons (house before house-simple-door-open).
    if (s > 0) scored.push({ n: e.n, s: s - e.n.length / 100 });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.n);
}

export function resolveIconWords(words: string[], perWord = 2, max = 30): string[] {
  const out: string[] = [];
  for (const w of words) for (const n of searchIcons(w, perWord)) if (!out.includes(n)) out.push(n);
  return out.slice(0, max);
}

/** What almost every interface needs, by role. Each name is checked against the catalogue in tests. */
export const CORE_ICONS: Record<string, string> = {
  home: "house", search: "magnifying-glass", profile: "user", settings: "gear", close: "x", menu: "list", back: "arrow-left", forward: "arrow-right",
  check: "check", add: "plus", remove: "minus", delete: "trash", edit: "pencil-simple", share: "share-network", notifications: "bell", favourite: "heart",
  rating: "star", cart: "shopping-cart", filter: "funnel", calendar: "calendar-blank", time: "clock", info: "info", warning: "warning", error: "warning-circle",
  success: "check-circle", visible: "eye", hidden: "eye-slash", lock: "lock", email: "envelope", phone: "phone", location: "map-pin", download: "download-simple",
  upload: "upload-simple", copy: "copy", link: "link", bookmark: "bookmark-simple", play: "play", pause: "pause", more: "dots-three", expand: "caret-down",
  help: "question", refresh: "arrow-clockwise", logout: "sign-out", image: "image", chat: "chat-circle", send: "paper-plane-tilt",
  file: "file", folder: "folder", document: "file-text", video: "video-camera", chart: "chart-line", bars: "chart-bar", table: "table", grid: "squares-four",
  sidebar: "sidebar", like: "thumbs-up", addUser: "user-plus", team: "users", mobile: "device-mobile", desktop: "desktop", wifi: "wifi-high", battery: "battery-full",
  secure: "shield-check", key: "key", unlock: "lock-open", map: "map-trifold", navigate: "navigation-arrow", timer: "timer", done: "calendar-check", wallet: "wallet",
  tag: "tag", scan: "scan", mic: "microphone", camera: "camera", music: "music-notes", sun: "sun", moon: "moon", globe: "globe", news: "newspaper",
};

// ---------------------------------------------------------------------------
// the shapes
// ---------------------------------------------------------------------------

export const iconFile = (name: string, weight: IconWeight) => (weight === "regular" ? `${name}.svg` : `${name}-${weight}.svg`);
export const iconUrl = (name: string, weight: IconWeight) => `https://${CDN_HOST}${CDN_PREFIX}${weight}/${iconFile(name, weight)}`;

/**
 * The path data of a Phosphor SVG (a viewBox 256 icon made only of path elements), or null when the file is
 * anything else. Nothing but plain path data is ever kept.
 */
export function parseIconSvg(svg: string): string | null {
  const m = /^\s*<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg);
  if (!m || svg.length > 30000) return null;
  const inner = m[1].trim();
  const paths = [...inner.matchAll(/<path\b[^>]*?\sd="([^"]+)"[^>]*\/?>/g)];
  if (paths.length === 0) return null;
  const rest = inner.replace(/<path\b[^>]*\/?>(?:<\/path>)?/g, "").trim();
  if (rest !== "") return null; // anything besides paths (script, image, style, groups)
  const d = paths.map((p) => p[1]).join(" ");
  return /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s-]+$/.test(d) ? d : null;
}

export type FetchText = (url: string) => Promise<string | null>;

/** The only reader: one host, one pinned package, bounded size and time. */
export const readIcon: FetchText = async (url) => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== CDN_HOST || !u.pathname.startsWith(CDN_PREFIX) || u.search || u.username) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const res = await fetch(u, { signal: ctl.signal, redirect: "error", headers: { "user-agent": "icon-reader/1.0" } });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length <= 30000 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export type IconPaths = Record<string, Partial<Record<IconWeight, string>>>;

/** Fetches the shapes for these icons in these weights; anything missing or odd is simply absent. */
export async function fetchIconPaths(iconNames: string[], weights: IconWeight[], read: FetchText = readIcon): Promise<IconPaths> {
  const out: IconPaths = {};
  const jobs: { n: string; w: IconWeight }[] = [];
  for (const n of [...new Set(iconNames)].filter(isIcon).slice(0, 90)) for (const w of weights) if (WEIGHTS.includes(w) && w !== "duotone") jobs.push({ n, w });
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const { n, w } = jobs[i++];
      try {
        const text = await read(iconUrl(n, w));
        const d = text ? parseIconSvg(text) : null;
        if (d) (out[n] ??= {})[w] = d;
      } catch {
        // that icon stays out
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// what the project gets
// ---------------------------------------------------------------------------

export interface PhosphorPackage {
  pkg: string;
  also?: string;
  usage: string;
}

/** The official package for a stack. The dependency flow checks the name against the real registry before adding it. */
export function packageFor(frameworks: string[], platform: string, hasFlutter = false): PhosphorPackage {
  const f = new Set(frameworks);
  if (hasFlutter) return { pkg: "phosphor_flutter", usage: 'Icon(PhosphorIcons.house(), size: 24); weights: PhosphorIcons.houseBold(), PhosphorIcons.houseFill()' };
  if (f.has("react-native") || f.has("expo") || platform === "native") return { pkg: "phosphor-react-native", also: "react-native-svg", usage: 'import { House } from "phosphor-react-native";  <House size={24} weight="regular" color={colors.text} />' };
  if (f.has("vue") || f.has("nuxt")) return { pkg: "@phosphor-icons/vue", usage: 'import { PhHouse } from "@phosphor-icons/vue";  <PhHouse :size="24" weight="regular" />' };
  if (f.has("react") || f.has("next")) return { pkg: "@phosphor-icons/react", usage: 'import { House } from "@phosphor-icons/react";  <House size={24} weight="regular" aria-hidden />' };
  return { pkg: "@phosphor-icons/web", usage: 'import "@phosphor-icons/web/regular";  <i class="ph ph-house" aria-hidden="true"></i>  (bold: ph-bold, fill: ph-fill)' };
}

/** The licence text, kept with any copy of the icon shapes. */
export const PHOSPHOR_MIT = [
  "MIT License",
  "",
  "Copyright (c) 2023 Phosphor Icons",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'of this software and associated documentation files (the "Software"), to deal',
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
].join("\n");

export const ICON_NOTICE =
  "Phosphor Icons, MIT License, Copyright (c) 2023 Phosphor Icons (https://phosphoricons.com). Full licence text: design-system/icons.md.";

export function iconNamesTxt(): string {
  const byCat = new Map<string, string[]>();
  for (const e of catalogue()) (byCat.get(e.c[0] ?? "other") ?? byCat.set(e.c[0] ?? "other", []).get(e.c[0] ?? "other")!).push(e.n);
  return [...byCat.entries()].map(([c, list]) => `# ${c}\n${list.join(" ")}`).join("\n\n") + "\n";
}

export function iconsDoc(o: {
  library: string;
  installed: boolean;
  pkg: PhosphorPackage;
  weight: IconWeight;
  extra: string[];
  haveShapes: boolean;
  styleNote: string;
}): string {
  const core = Object.entries(CORE_ICONS).filter(([, n]) => isIcon(n));
  const comp = (n: string) => pascal(n);
  return (
    `# Icons: Phosphor\n\n` +
    `Phosphor is a free, MIT-licensed set of about ${catalogue().length} icons, each in six weights (thin, light, regular, bold, fill, duotone). Use it for every icon in this product; never emoji, never a second set.\n\n` +
    `## Get it\n` +
    (o.installed
      ? `- Already installed (\`${o.library}\`). Import from it; every icon is available.\n`
      : `- Add \`${o.pkg.pkg}\`${o.pkg.also ? ` (and \`${o.pkg.also}\`)` : ""} through the dependency flow (request_dependency, then the add command with scripts skipped). It has every icon and tree-shakes to the ones you import.\n`) +
    `- Usage: \`${o.pkg.usage}\`\n` +
    (o.haveShapes ? `- If nothing can be installed: \`design-system/icons.ts\` has the path data of the icons below (viewBox \`0 0 256 256\`, fill currentColor). Draw one with \`<svg viewBox="0 0 256 256" width={24} height={24} fill="currentColor"><path d={phosphor.house.regular} /></svg>\` (react-native-svg: \`<Svg viewBox="0 0 256 256"><Path d={...} fill={color} /></Svg>\`).\n` : "") +
    `\n## Rules\n- One weight for the whole UI: **${o.weight}**. ${o.styleNote} Use \`fill\` for the active or selected state (tab bar, toggled favourite) and nowhere else; do not mix thin and bold in one view.\n` +
    `- Sizes: 16, 20, 24 (default), 32. An icon next to text is the size of the text's line height; keep icons optically aligned with the text baseline.\n` +
    `- Colour from tokens (\`currentColor\` or the text role); status icons always sit beside a word or have an accessible label. Icon-only buttons need an accessible label and a 44px target.\n` +
    `- Every icon has one of three jobs, and the job decides the markup: DECORATIVE (beside visible text that says the same) is hidden from screen readers (aria-hidden); MEANINGFUL (carries information with no text beside it) gets a text alternative; INTERACTIVE (inside a button or link) gives the control an accessible name and exposes its state (aria-pressed, aria-expanded, selected) rather than putting the label on the icon.\n\n` +
    `## The ones almost every screen needs (role: name${o.installed || !o.haveShapes ? "" : " | in icons.ts"})\n` +
    core.map(([role, n]) => `- ${role}: \`${n}\` (${comp(n)})`).join("\n") + "\n\n" +
    (o.extra.length ? `## Chosen for this product\n${o.extra.map((n) => `- \`${n}\` (${comp(n)})`).join("\n")}\n\n` : "") +
    `## Any other icon\nEvery name in \`design-system/icon-names.txt\` is valid (grouped by category; search it, do not guess a name). Component name = the name in PascalCase (arrow-square-in is ArrowSquareIn).\n\n` +
    `## Licence\n${ICON_NOTICE}\n\n${PHOSPHOR_MIT}\n`
  );
}

export function iconsTs(paths: IconPaths): string {
  const entries = Object.entries(paths)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, w]) => `  ${JSON.stringify(n)}: { ${Object.entries(w).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} },`);
  return (
    `// ${ICON_NOTICE}\n// Path data for the icons this product uses; viewBox is "0 0 256 256". More: the package in design-system/icons.md.\n` +
    `export const viewBox = "0 0 256 256";\nexport const phosphor = {\n${entries.join("\n")}\n} as const;\nexport type IconName = keyof typeof phosphor;\n`
  );
}

