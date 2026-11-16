/**
 * A reference app (or any pile of source) read WITHOUT a model: what files it
 * has, what each declares, which parts use which, grouped into modules and
 * ordered so what others depend on comes first.
 *
 * A model cannot read a whole app in one pass, and it should not have to. This
 * is the deterministic part: it scans everything, so nothing is skipped because
 * nobody opened it. A model then only has to describe and group what this found.
 * The same scan later answers "is every reference file covered by some unit".
 *
 * Nothing here knows a platform. A file's role comes from its name and shape,
 * and "uses" comes from one rule that works in any language: a file that
 * mentions a type declared (exactly once) in another file depends on it.
 */
import fs from "fs";
import path from "path";
import { extractDeclaredSymbols } from "./repoMapSync.js";

export type Role = "ui" | "state" | "network" | "data" | "model" | "navigation" | "config" | "resource" | "build" | "test" | "other";

export interface InvFile {
  path: string;
  lang?: string;
  lines: number;
  bytes: number;
  symbols: string[];
  role: Role;
}

export interface InvModule {
  id: string;
  dir: string;
  files: string[];
  lines: number;
  roles: Partial<Record<Role, number>>;
  /** The names that best say what it is: declared types first. */
  symbols: string[];
}

export interface InvEdge {
  from: string;
  to: string;
  weight: number;
}

export interface Inventory {
  dir: string;
  totalFiles: number;
  scanned: number;
  /** Images, fonts, audio and the like: counted, not read. */
  assets: number;
  /** Too large to read; listed, not parsed. */
  skippedLarge: number;
  totalLines: number;
  /** The scan stopped at its file limit. */
  truncated: boolean;
  files: InvFile[];
  modules: InvModule[];
  edges: InvEdge[];
}

export interface ScanOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  /** A directory with more files than this is split into several modules. */
  maxModuleFiles?: number;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "build", "dist", "out", ".gradle", ".idea", ".vscode", "Pods", "DerivedData", "__pycache__", "venv", ".venv",
  "target", ".dart_tool", ".expo", ".next", ".cxx", "captures", ".svn", ".hg", "xcuserdata", "bin", "obj",
]);

const ASSET_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "ttf", "otf", "woff", "woff2", "mp3", "wav", "ogg", "m4a", "mp4", "mov", "webm", "pdf",
  "zip", "jar", "aar", "so", "a", "dylib", "class", "dex", "apk", "ipa", "keystore", "jks", "lottie", "riv", "bin",
]);

const TEXT_EXT = new Set([
  "kt", "kts", "java", "xml", "gradle", "swift", "m", "mm", "h", "hpp", "c", "cc", "cpp", "cs", "dart", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json",
  "yaml", "yml", "md", "txt", "py", "rb", "php", "go", "rs", "html", "css", "scss", "sql", "proto", "plist", "storyboard", "xib", "strings", "toml",
  "properties", "cfg", "ini", "scala", "gql", "graphql", "vue", "svelte", "pbxproj", "podspec", "env",
]);

const ext = (rel: string) => (rel.split(".").pop() ?? "").toLowerCase();
const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Declarations in languages the shared reader does not cover. */
function fallbackSymbols(source: string, e: string): string[] | undefined {
  const rules: Record<string, RegExp[]> = {
    dart: [/^[ \t]*(?:abstract\s+)?(?:class|mixin|enum|extension)\s+(\w+)/gm],
    m: [/^@(?:interface|implementation|protocol)\s+(\w+)/gm],
    mm: [/^@(?:interface|implementation|protocol)\s+(\w+)/gm],
    h: [/^@(?:interface|protocol)\s+(\w+)/gm, /^[ \t]*(?:class|struct)\s+(\w+)/gm],
    hpp: [/^[ \t]*(?:class|struct)\s+(\w+)/gm],
    cpp: [/^[ \t]*(?:class|struct)\s+(\w+)/gm],
    cc: [/^[ \t]*(?:class|struct)\s+(\w+)/gm],
    c: [/^[ \t]*struct\s+(\w+)/gm],
    scala: [/^[ \t]*(?:case\s+)?(?:class|object|trait)\s+(\w+)/gm],
    vue: [],
    svelte: [],
  };
  const rs = rules[e];
  if (!rs) return undefined;
  const out = new Set<string>();
  for (const re of rs) for (const m of source.slice(0, 400_000).matchAll(re)) if (m[1] && m[1].length >= 2) out.add(m[1]);
  return [...out];
}

function roleOf(rel: string, source: string, symbols: string[]): Role {
  const p = rel.toLowerCase();
  const base = p.split("/").pop() ?? p;
  const names = symbols.join(" ");
  if (/(^|\/)(tests?|androidtest|unittest|__tests__|spec|specs|uitests?)(\/|$)/.test(p) || /(tests?|spec)\.[a-z]+$/.test(base) || /_test\./.test(base)) return "test";
  if (/(^|\/)(build\.gradle|settings\.gradle|package\.json|podfile|pubspec\.yaml|cargo\.toml|pom\.xml|gradle\.properties|project\.pbxproj)/.test(p) || /\.(gradle|podspec|pbxproj)$/.test(base)) return "build";
  if (/(^|\/)res\//.test(p) || /(^|\/)(assets|resources|drawable|mipmap|values|layout)[^/]*\//.test(p) || /\.(strings|storyboard|xib)$/.test(base)) return "resource";
  if (/androidmanifest|info\.plist|\.env|config|settings|\.(ya?ml|toml|properties|ini|cfg)$/.test(base)) return "config";
  const hay = `${base} ${names}`;
  if (/(navigation|navhost|navgraph|router|route|coordinator|navigator)/i.test(hay)) return "navigation";
  if (/@composable|swiftui|: view\b|statelesswidget|statefulwidget|setcontentview|uiviewcontroller|react\.component|jsx\.element/i.test(source.slice(0, 60_000)) ||
      /(screen|activity|fragment|page|view|viewcontroller|widget|component|dialog|adapter|cell|composable)\b/i.test(base.replace(/\.[a-z]+$/, "")) ||
      /(^|\/)(ui|screens?|views?|pages?|components?|presentation|layouts?)(\/|$)/.test(p)) return "ui";
  if (/(viewmodel|store|bloc|cubit|reducer|presenter|controller|provider|interactor|usecase|state)/i.test(hay)) return "state";
  if (/(api|client|service|retrofit|endpoint|request|response|interceptor|http|socket|websocket|graphql|network|remote)/i.test(hay)) return "network";
  if (/(repository|dao|database|datasource|cache|storage|preferences|persistence|room|sqlite|realm|coredata)/i.test(hay)) return "data";
  if (/(model|dto|entity|data class|struct|schema|domain)/i.test(hay) || /(^|\/)(models?|domain|entities)(\/|$)/.test(p)) return "model";
  return "other";
}

function listFiles(root: string, dirRel: string, limit: number): { files: string[]; assets: number; truncated: boolean } {
  const files: string[] = [];
  let assets = 0;
  let truncated = false;
  const stack = [norm(dirRel)];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(child);
      } else if (e.isFile()) {
        const x = ext(e.name);
        if (ASSET_EXT.has(x)) assets++;
        else if (TEXT_EXT.has(x)) {
          if (files.length >= limit) {
            truncated = true;
            return { files, assets, truncated };
          }
          files.push(child);
        }
      }
    }
  }
  return { files, assets, truncated };
}

/** Groups files into modules by folder, splitting large folders and merging tiny ones. */
function clusterModules(files: InvFile[], maxModuleFiles: number): { dir: string; files: InvFile[] }[] {
  const out: { dir: string; files: InvFile[] }[] = [];
  const group = (prefix: string, list: InvFile[]) => {
    if (list.length <= maxModuleFiles) {
      out.push({ dir: prefix || ".", files: list });
      return;
    }
    const direct: InvFile[] = [];
    const children = new Map<string, InvFile[]>();
    for (const f of list) {
      const rest = prefix ? f.path.slice(prefix.length + 1) : f.path;
      const i = rest.indexOf("/");
      if (i === -1) direct.push(f);
      else {
        const seg = rest.slice(0, i);
        children.set(seg, [...(children.get(seg) ?? []), f]);
      }
    }
    const leftover = [...direct];
    for (const [seg, kids] of [...children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const childPrefix = prefix ? `${prefix}/${seg}` : seg;
      // A tiny folder is not worth a module of its own: it joins its parent's.
      if (kids.length < 3 && list.length - kids.length > 0) leftover.push(...kids);
      else group(childPrefix, kids);
    }
    // A folder that is itself too big (a flat pile of files) is cut into runs.
    for (let i = 0; i < leftover.length; i += maxModuleFiles) {
      out.push({ dir: prefix || ".", files: leftover.slice(i, i + maxModuleFiles) });
    }
  };
  group("", [...files].sort((a, b) => a.path.localeCompare(b.path)));
  return out;
}

export function scanReference(repoRoot: string, dirRel: string, opts: ScanOptions = {}): Inventory {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxFileBytes = opts.maxFileBytes ?? 400_000;
  const maxModuleFiles = opts.maxModuleFiles ?? 40;
  const dir = norm(dirRel).replace(/\/+$/, "");
  const listed = listFiles(repoRoot, dir, maxFiles);

  const files: InvFile[] = [];
  const sources = new Map<string, string>();
  let skippedLarge = 0;
  let totalLines = 0;
  for (const rel of listed.files) {
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(repoRoot, rel));
    } catch {
      continue;
    }
    if (st.size > maxFileBytes) {
      skippedLarge++;
      files.push({ path: rel, lang: ext(rel), lines: 0, bytes: st.size, symbols: [], role: roleOf(rel, "", []) });
      continue;
    }
    let source = "";
    try {
      source = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
    } catch {
      continue;
    }
    const lines = source === "" ? 0 : source.split("\n").length;
    totalLines += lines;
    const symbols = extractDeclaredSymbols(source, rel) ?? fallbackSymbols(source, ext(rel)) ?? [];
    files.push({ path: rel, lang: ext(rel), lines, bytes: st.size, symbols: symbols.slice(0, 60), role: roleOf(rel, source, symbols) });
    sources.set(rel, source);
  }

  // Modules.
  const clusters = clusterModules(files, maxModuleFiles);
  const modules: InvModule[] = clusters.map((c, i) => {
    const roles: Partial<Record<Role, number>> = {};
    for (const f of c.files) roles[f.role] = (roles[f.role] ?? 0) + 1;
    const all = [...new Set(c.files.flatMap((f) => f.symbols))];
    const types = all.filter((s) => /^[A-Z]/.test(s));
    return {
      id: `M${String(i + 1).padStart(3, "0")}`,
      dir: c.dir,
      files: c.files.map((f) => f.path),
      lines: c.files.reduce((n, f) => n + f.lines, 0),
      roles,
      symbols: [...types, ...all.filter((s) => !types.includes(s))].slice(0, 12),
    };
  });
  const moduleOf = new Map<string, string>();
  for (const m of modules) for (const f of m.files) moduleOf.set(f, m.id);

  // "Uses": a file that mentions a type declared exactly once, in another file.
  const declaredIn = new Map<string, string[]>();
  for (const f of files) {
    if (f.role === "test") continue;
    for (const s of f.symbols) if (/^[A-Z]/.test(s) && s.length >= 4) declaredIn.set(s, [...(declaredIn.get(s) ?? []), f.path]);
  }
  const unique = new Map<string, string>();
  for (const [s, where] of declaredIn) if (where.length === 1) unique.set(s, where[0]);
  const weights = new Map<string, number>();
  for (const [rel, source] of sources) {
    const from = moduleOf.get(rel);
    if (!from) continue;
    const seen = new Set<string>();
    for (const m of source.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const owner = unique.get(m[0]);
      if (!owner || owner === rel || seen.has(m[0])) continue;
      seen.add(m[0]);
      const to = moduleOf.get(owner);
      if (!to || to === from) continue;
      weights.set(`${from}>${to}`, (weights.get(`${from}>${to}`) ?? 0) + 1);
    }
  }
  const edges: InvEdge[] = [...weights.entries()].map(([k, weight]) => {
    const [from, to] = k.split(">");
    return { from, to, weight };
  });

  return { dir, totalFiles: files.length + listed.assets, scanned: files.length - skippedLarge, assets: listed.assets, skippedLarge, totalLines, truncated: listed.truncated, files, modules, edges };
}

/**
 * Module groups in the order they can be built: what others use comes first.
 * Modules that use each other in a loop are one group (they have to be done
 * together). Plain graph ordering: no model.
 */
export function buildOrder(inv: Pick<Inventory, "modules" | "edges">): string[][] {
  const adj = new Map<string, string[]>();
  for (const m of inv.modules) adj.set(m.id, []);
  for (const e of inv.edges) adj.get(e.from)?.push(e.to);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let i = 0;
  const visit = (v: string) => {
    index.set(v, i);
    low.set(v, i);
    i++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp.sort());
    }
  };
  for (const m of inv.modules) if (!index.has(m.id)) visit(m.id);
  // Components come out dependencies-first already; a stable order among equals.
  return out;
}

/** Every path a roadmap should account for: all scanned text files except build plumbing. */
export function coverageFiles(inv: Inventory, skipRoles: Role[] = ["build"]): string[] {
  return inv.files.filter((f) => !skipRoles.includes(f.role)).map((f) => f.path);
}

/** The inventory as text a model can read, build order first. One string when it fits. */
export function renderInventory(inv: Inventory, maxChars = 12_000): string[] {
  const order = buildOrder(inv).flat();
  const byId = new Map(inv.modules.map((m) => [m.id, m]));
  const uses = new Map<string, string[]>();
  const usedBy = new Map<string, string[]>();
  for (const e of inv.edges) {
    uses.set(e.from, [...(uses.get(e.from) ?? []), e.to]);
    usedBy.set(e.to, [...(usedBy.get(e.to) ?? []), e.from]);
  }
  const head =
    `REFERENCE: ${inv.dir} — ${inv.scanned} source file(s), ${inv.totalLines} lines, ${inv.assets} asset file(s)` +
    `${inv.skippedLarge ? `, ${inv.skippedLarge} too large to read` : ""}${inv.truncated ? ", SCAN STOPPED AT ITS FILE LIMIT" : ""}. Modules listed with what they depend on first.`;
  const lines = order.map((id) => {
    const m = byId.get(id)!;
    const roles = Object.entries(m.roles).sort((a, b) => b[1]! - a[1]!).slice(0, 3).map(([r, n]) => `${r}:${n}`).join(" ");
    const u = [...new Set(uses.get(id) ?? [])];
    const d = [...new Set(usedBy.get(id) ?? [])];
    return (
      `${m.id} ${m.dir} — ${m.files.length} files, ${m.lines} lines [${roles}]` +
      `${m.symbols.length ? ` — ${m.symbols.slice(0, 8).join(", ")}` : ""}` +
      `${u.length ? ` — uses ${u.slice(0, 8).join(", ")}` : ""}${d.length ? ` — used by ${d.slice(0, 8).join(", ")}` : ""}`
    );
  });
  const chunks: string[] = [];
  let cur = head;
  for (const l of lines) {
    if (cur.length + l.length + 1 > maxChars && cur !== head) {
      chunks.push(cur);
      cur = `${head}\n(continued)`;
    }
    cur += `\n${l}`;
  }
  chunks.push(cur);
  return chunks;
}
