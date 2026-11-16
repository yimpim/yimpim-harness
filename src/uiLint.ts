/**
 * Cheap, deterministic checks on the UI code a phase just wrote, run from static QA. They look only at
 * ADDED lines of user-facing files. A regex cannot know intent, so only the unambiguous cases are
 * defects (they trigger a repair); the rest are concerns shown to the reviewer.
 */
import path from "node:path";

export interface UiSignal {
  severity: "defect" | "concern";
  requirement: string;
  message: string;
}

const UI_FILE = /\.(tsx|jsx|vue|svelte|html?|css|scss|less|astro|dart)$/i;
const TEST_FILE = /(^|\/)(__tests__|tests?|e2e|stories|fixtures?)\/|\.(test|spec|stories)\.[a-z]+$/i;
const TOKEN_FILE = /(^|\/)(design-system|theme|themes|tokens|colors|colours|palette|styles?\/(variables|tokens))[^/]*(\/|\.)|tailwind\.config|design-tokens/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_ONLY = /^[\s\p{Extended_Pictographic}️‍⃣\u{1F3FB}-\u{1F3FF}]+$/u;
const COMMENT = /^\s*(\/\/|\/\*|\*|#|<!--|--)/;

export interface DiffSegmentLike {
  file?: string;
  diff: string;
}

/** The added lines of one file's diff, without the markers. */
function added(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/** An emoji standing alone as an icon: markup text, a string, or an icon prop. */
export function emojiAsIcon(line: string): boolean {
  if (COMMENT.test(line) || /console\.(log|warn|error)|\bt\(['"`]|aria-hidden/.test(line)) return false;
  if (!EMOJI.test(line)) return false;
  // >🔥< , '🔥' , "🔥" , `🔥`
  for (const m of line.matchAll(/>\s*([^<>{}]{1,12}?)\s*</g)) if (EMOJI_ONLY.test(m[1]) && EMOJI.test(m[1])) return true;
  for (const m of line.matchAll(/(['"`])\s*([^'"`]{1,12}?)\s*\1/g)) if (EMOJI_ONLY.test(m[2]) && EMOJI.test(m[2])) return true;
  // icon: "🔥" / icon={…}/ emoji: '…' / tabBarIcon … 🔥
  return /(icon|emoji|glyph|symbol|tabBarIcon)\w*\s*[:=]/i.test(line);
}

const PURPLE_GRADIENT = /(linear|radial|conic)-gradient\([^)]*(#(7c3aed|8b5cf6|a855f7|6366f1|9333ea|c026d3|ec4899|d946ef|a78bfa)\b|\b(purple|violet|fuchsia|magenta)\b)/i;

interface Hit {
  file: string;
  sample: string;
}

export function uiSignals(segments: DiffSegmentLike[], opts: { designSystem?: boolean } = {}): UiSignal[] {
  const hits: Record<string, Hit[]> = {};
  const add = (k: string, file: string, sample: string) => (hits[k] ??= []).push({ file, sample: sample.trim().slice(0, 100) });

  for (const seg of segments) {
    const file = seg.file?.replace(/\\/g, "/");
    if (!file || !UI_FILE.test(file) || TEST_FILE.test(file)) continue;
    const isTokenFile = TOKEN_FILE.test(file);
    for (const line of added(seg.diff)) {
      if (!line.trim() || COMMENT.test(line)) continue;
      if (emojiAsIcon(line)) add("emoji-icon", file, line);
      else if (EMOJI.test(line) && !/console\./.test(line)) add("emoji-text", file, line);
      if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b|userScalable\s*:\s*false/i.test(line)) add("zoom", file, line);
      if (/outline\s*:\s*(none|0)\b/i.test(line) && !/focus-visible|:focus\s*\{[^}]*(box-shadow|border)/i.test(line)) add("outline", file, line);
      if (/<img\b/i.test(line) && !/\balt\s*=/i.test(line) && !/\{\.\.\./.test(line) && /\/?>/.test(line)) add("img-alt", file, line);
      if (/<(div|span)\b[^>]*\bonClick\s*=/i.test(line) && !/\brole\s*=\s*["']?(button|link|tab|menuitem)/i.test(line)) add("div-click", file, line);
      const px = /font-size\s*:\s*(\d+(?:\.\d+)?)px/i.exec(line) ?? /\bfontSize\s*:\s*(\d+(?:\.\d+)?)\b/.exec(line);
      if (px && Number(px[1]) < 12 && Number(px[1]) > 0) add("tiny-text", file, line);
      if (/z-index\s*:\s*\d{4,}|zIndex\s*:\s*\d{4,}/i.test(line)) add("z-index", file, line);
      if (/lorem ipsum/i.test(line)) add("lorem", file, line);
      if (PURPLE_GRADIENT.test(line)) add("purple-gradient", file, line);
      if (opts.designSystem && !isTokenFile && /(?:^|[^&\w])#[0-9a-f]{6}\b|(?:^|[^&\w])#[0-9a-f]{3}\b(?![0-9a-f])/i.test(line) && !/(href|src|id|url)\s*=|url\(|\/\/\s*#/i.test(line)) add("hard-colour", file, line);
    }
  }

  const where = (k: string, n = 3) => {
    const h = hits[k] ?? [];
    const files = [...new Set(h.map((x) => x.file))].slice(0, n).join(", ");
    return `${h.length} place(s) in ${files}, for example: ${h[0]?.sample}`;
  };
  const out: UiSignal[] = [];
  if (hits["emoji-icon"]) {
    out.push({
      severity: "defect",
      requirement: "No emoji used as icons in the UI",
      message: `Emoji are used as icons (${where("emoji-icon")}). Replace them with the project's vector icon set (or small inline SVG icons), one consistent style; emoji render differently per device and cannot be recoloured. If an emoji is user-facing content the user asked for, say so instead.`,
    });
  }
  if (hits["zoom"]) {
    out.push({ severity: "defect", requirement: "Pinch zoom and text resize stay enabled", message: `Zoom is disabled (${where("zoom")}). Remove user-scalable=no / maximum-scale=1: it blocks low-vision users.` });
  }
  const concerns: [string, string][] = [
    ["emoji-text", "Emoji appear in UI text; if they stand in for icons, use real icons"],
    ["outline", "A focus outline is removed with nothing visible in its place"],
    ["img-alt", "An image has no alt attribute (use descriptive alt, or alt=\"\" for decoration)"],
    ["div-click", "A div or span is clickable; use a button or link (keyboard and screen readers)"],
    ["tiny-text", "Text smaller than 12 is set; body text should be 16"],
    ["z-index", "A very large z-index is used; use a small scale (10, 20, 30, 50)"],
    ["lorem", "Lorem ipsum placeholder text; write believable content in the product's voice"],
    ["purple-gradient", "A purple/pink gradient is used; it is the most common generated-UI default, so keep it only if the brand is built on it"],
    ["hard-colour", "Hard-coded hex colours in components while a design system exists; use the tokens in design-system/ so light and dark stay correct"],
  ];
  for (const [k, text] of concerns) if (hits[k]) out.push({ severity: "concern", requirement: "UI craft", message: `${text} (${where(k)}).` });
  return out;
}

/** Path helper for callers that only have changed file names. */
export const isUiFile = (file: string) => UI_FILE.test(file) && !TEST_FILE.test(file.replace(/\\/g, "/")) && path.basename(file) !== "";
