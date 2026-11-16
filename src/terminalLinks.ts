/**
 * Clickable file paths in the terminal.
 *
 * Modern terminals (Windows Terminal, VS Code, iTerm2, WezTerm, GNOME Terminal and others) treat the OSC 8 escape sequence as
 * a hyperlink: Ctrl+click (Cmd+click on macOS) opens the target. Any token in a line of output that names a file which exists
 * is wrapped in a `file://` link, so a path Gage prints can be opened without copying it.
 *
 * Display only: callers apply this to the text going to the terminal, never to what is logged, mirrored to the phone or saved.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OSC = "\u001b]8;;";
const ST = "\u001b\\";

/** True when this terminal is known (or forced) to understand hyperlinks. */
export function supportsHyperlinks(env: NodeJS.ProcessEnv = process.env, isTTY: boolean = Boolean(process.stdout.isTTY)): boolean {
  if (env.GAGE_LINKS === "0" || env.NO_COLOR === "1") return false;
  if (env.GAGE_LINKS === "1" || env.FORCE_HYPERLINK === "1") return true;
  if (!isTTY || env.CI || env.TERM === "dumb") return false;
  if (env.WT_SESSION || env.WEZTERM_EXECUTABLE || env.KITTY_WINDOW_ID || env.KONSOLE_VERSION) return true;
  if (env.TERM_PROGRAM && /^(vscode|iTerm\.app|WezTerm|ghostty|Hyper|Tabby)$/i.test(env.TERM_PROGRAM)) return true;
  if (env.VTE_VERSION && Number(env.VTE_VERSION) >= 5000) return true;
  return false;
}

export function hyperlink(label: string, absPath: string): string {
  return `${OSC}${pathToFileURL(absPath).href}${ST}${label}${OSC}${ST}`;
}

// A path-looking token: optional drive, folders, then a file name with an extension.
const PATH_TOKEN = /(?:[A-Za-z]:[\\/])?(?:[\w.@~+-]+[\\/])*[\w.@+-]+\.[A-Za-z0-9]{1,8}(?![\w\\/])/g;
const MAX_CACHE = 500;

/**
 * Wrap each existing file named in `text` in a hyperlink. `baseDirs` are tried in order for relative names. Text that is
 * already hyperlinked is left alone.
 */
export function linkifyFilePaths(text: string, baseDirs: string[], enabled: boolean = supportsHyperlinks()): string {
  if (!enabled || !text || text.includes(OSC)) return text;
  const cache = new Map<string, string | null>();
  const resolve = (token: string): string | null => {
    if (cache.has(token)) return cache.get(token) ?? null;
    let found: string | null = null;
    if (!/^[a-z]+:\/\//i.test(token) && !/^\d+(\.\d+)+$/.test(token)) {
      const candidates = path.isAbsolute(token) ? [token] : baseDirs.map((d) => path.resolve(d, token));
      for (const c of candidates) {
        try {
          if (fs.statSync(c).isFile()) {
            found = c;
            break;
          }
        } catch {
          /* not a file here */
        }
      }
    }
    if (cache.size < MAX_CACHE) cache.set(token, found);
    return found;
  };
  return text.replace(PATH_TOKEN, (token, offset: number) => {
    // Skip a token that is part of a longer word or URL, or sits inside an escape sequence.
    const before = text[offset - 1];
    if (before && /[\w/\\:.]/.test(before) && !/^[A-Za-z]:/.test(token)) return token;
    const abs = resolve(token);
    return abs ? hyperlink(token, abs) : token;
  });
}
