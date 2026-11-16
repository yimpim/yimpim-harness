/**
 * The brand guidelines document: pages in a fixed order (idea, logo, versions, on colour, misuse,
 * colour, type, applications, checks). Built only from what was approved and measured: no invented
 * mission statements, no placeholder photos. Fonts used in the specimens are embedded from the
 * bundled open-licence files, so the PDF looks the same wherever it is opened.
 */
import fs from "node:fs";
import { bestTextOn, contrast } from "./colorlib.js";
import { ROLE_KEYS, type PaletteSystem } from "./palette.js";
import { fontFile, loadCatalog, type FontEntry } from "./wordmark.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(/<svg[^>]*\sxmlns\s*=/i.test(svg) ? svg : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"'), "utf-8").toString("base64")}`;

export interface GuidelineInput {
  name: string;
  /** the one idea the mark, type and colour share */
  idea: string;
  personality: string[];
  logo: { master: string; onLight: string; onDark: string; black: string; white: string; appIcon: string; appIconDark: string };
  /** lockups from the typography step (optional) */
  lockups?: { horizontal?: string; horizontalDark?: string; stacked?: string };
  palette?: PaletteSystem | null;
  type?: { wordmarkFamily?: string; display?: string; body?: string; weight?: string } | null;
  /** gates and warnings, as measured */
  checks: { id: string; kind: string; status: string; detail: string }[];
  /** short notes about what was assumed */
  assumptions: string[];
}

function fontFaces(families: (string | undefined)[]): { css: string; ok: Set<string> } {
  const catalog = loadCatalog();
  const ok = new Set<string>();
  let css = "";
  for (const fam of [...new Set(families.filter((f): f is string => !!f))]) {
    const e: FontEntry | undefined = catalog.find((c) => c.family === fam);
    if (!e) continue;
    for (const w of ["regular", "bold"] as const) {
      const f = fontFile(e, w);
      if (!f || f.weight !== w) continue;
      try {
        const b64 = fs.readFileSync(f.file).toString("base64");
        css += `@font-face{font-family:"${e.family}";font-weight:${w === "bold" ? 700 : 400};src:url(data:font/ttf;base64,${b64}) format("truetype")}`;
        ok.add(e.family);
      } catch {
        // falls back to a system face
      }
    }
  }
  return { css, ok };
}

/** Misuse examples are made from the real mark, so they show what would actually go wrong with it. */
function misuse(img: string): string {
  const cell = (label: string, style: string, bg = "#f4f4f5") =>
    `<div class="mc"><div class="mb" style="background:${bg}"><img src="${img}" style="${style}"></div><p><b class="x">✖</b> ${label}</p></div>`;
  return (
    cell("Do not stretch or squash", "width:150px;height:60px") +
    cell("Do not rotate or tilt", "width:80px;transform:rotate(22deg)") +
    cell("Do not recolour outside the supplied versions", "width:80px;filter:hue-rotate(140deg) saturate(1.6)") +
    cell("Do not add shadows or effects", "width:80px;filter:drop-shadow(5px 6px 3px rgba(0,0,0,.55))") +
    cell("Do not place it where it disappears", "width:80px;opacity:.35", "#d4d4d8") +
    cell("Do not crowd it: keep the clear space free", "width:80px;outline:3px solid #ef4444;outline-offset:-10px;padding:4px", "#f4f4f5")
  );
}

export function guidelinesHtml(g: GuidelineInput): string {
  const p = g.palette;
  const used = [g.type?.display, g.type?.body, g.type?.wordmarkFamily];
  const { css: faceCss, ok } = fontFaces(used);
  const ff = (fam: string | undefined, fb: string) => (fam && ok.has(fam) ? `"${fam}",${fb}` : fb);
  const display = ff(g.type?.display ?? g.type?.wordmarkFamily, "Georgia,serif");
  const body = ff(g.type?.body, "system-ui,sans-serif");
  const L = p?.light;
  const ground = L?.background ?? "#ffffff";
  const ink = L?.text ?? "#18181b";
  const accent = L?.primary ?? "#2563eb";

  const page = (n: number, title: string, inner: string, dark = false) =>
    `<section class="pg${dark ? " dk" : ""}"><header><span>${esc(g.name)} · Brand guidelines</span><span>${n}</span></header><h2>${esc(title)}</h2>${inner}</section>`;

  const swatches = p
    ? p.brand.map((b) => `<div class="sw" style="background:${b.hex};color:${bestTextOn(b.hex).color}"><b>${esc(b.name)}</b><span>${b.hex}</span><small>${esc(b.usage)}</small></div>`).join("")
    : "";
  const roleRows = p
    ? ROLE_KEYS.map((k) => `<tr><td>${k}</td><td><i style="background:${p.light[k]}"></i>${p.light[k]}</td><td><i style="background:${p.dark[k]}"></i>${p.dark[k]}</td></tr>`).join("")
    : "";
  const pairs = p
    ? [
        ["Text on background", p.light.text, p.light.background],
        ["Button label on primary", p.light.onPrimary, p.light.primary],
        ["Link on background", p.light.link, p.light.background],
      ]
        .map(([n, a, b]) => `<tr><td>${n} (light)</td><td><span style="background:${b};color:${a};padding:2px 8px;border-radius:4px">Aa</span></td><td>${contrast(a, b).toFixed(2)}:1</td></tr>`)
        .join("") +
      [
        ["Text on background", p.dark.text, p.dark.background],
        ["Button label on primary", p.dark.onPrimary, p.dark.primary],
        ["Link on background", p.dark.link, p.dark.background],
      ]
        .map(([n, a, b]) => `<tr><td>${n} (dark)</td><td><span style="background:${b};color:${a};padding:2px 8px;border-radius:4px">Aa</span></td><td>${contrast(a, b).toFixed(2)}:1</td></tr>`)
        .join("")
    : "";

  const pages: string[] = [];
  pages.push(
    `<section class="pg cover" style="background:${ground};color:${ink}"><img src="${uri(g.logo.onLight)}" style="width:160px"><h1 style="font-family:${display}">${esc(g.name)}</h1><p>Brand guidelines</p><small>Made with AI models and checked by measurement. Not a trademark search.</small></section>`
  );
  pages.push(
    page(2, "The idea", `<p class="big" style="font-family:${display}">${esc(g.idea)}</p><p>${g.personality.length ? `Character: ${g.personality.map(esc).join(", ")}.` : ""} One idea shapes the mark, the type and the colour; one of them is allowed to be loud and the others stay quiet.</p>`)
  );
  pages.push(
    page(3, "The logo", `<div class="row"><div class="box" style="background:#fff"><img src="${uri(g.logo.onLight)}" style="width:200px"></div><div class="box" style="background:#0f0f14"><img src="${uri(g.logo.onDark)}" style="width:200px"></div></div>
<div class="clear"><div class="cs"><img src="${uri(g.logo.onLight)}" style="width:120px"></div><p><b>Clear space.</b> Keep a margin of half the mark's height free on every side (the dashed box). The unit comes from the mark itself, so it scales with it. <b>Smallest size.</b> 16 px on screen; the favicon files are drawn for it. For print the smallest size was not determined: approve a physical proof before choosing one.</p></div>`)
  );
  const versions = [
    ["Colour on light", g.logo.onLight, "#ffffff"],
    ["Colour on dark", g.logo.onDark, "#0f0f14"],
    ["One colour, black", g.logo.black, "#ffffff"],
    ["One colour, white", g.logo.white, "#18181b"],
    ["App icon", g.logo.appIcon, "#f4f4f5"],
    ["App icon, dark mode", g.logo.appIconDark, "#f4f4f5"],
  ];
  pages.push(page(4, "Versions", `<div class="grid3">${versions.map(([l, s, bg]) => `<div class="vc"><div class="vb" style="background:${bg}"><img src="${uri(s)}" style="width:90px"></div><p>${l}</p></div>`).join("")}</div>${g.lockups?.horizontal ? `<div class="row"><div class="box" style="background:#fff"><img src="${uri(g.lockups.horizontal)}" style="width:300px"></div><div class="box" style="background:#0f0f14">${g.lockups.horizontalDark ? `<img src="${uri(g.lockups.horizontalDark)}" style="width:300px">` : ""}</div></div>` : ""}`));
  pages.push(page(5, "Misuse", `<div class="grid3">${misuse(uri(g.logo.onLight))}</div><p class="small">These are made from the actual mark. Mark-specific pitfalls should be added once it has been used in real layouts.</p>`));
  if (p) {
    pages.push(
      page(6, "Colour", `<div class="sws">${swatches}</div><table><tr><th>Role</th><th>Light</th><th>Dark</th></tr>${roleRows}</table><p class="small">Screen colours are sRGB. CMYK and Pantone are not given: ask the printer to match from the hex with their own profile, and approve a physical proof.</p>`) +
        page(7, "Approved pairs", `<table><tr><th>Pair</th><th>Sample</th><th>Contrast</th></tr>${pairs}</table><p class="small">Contrast is measured without rounding (WCAG 2.2: text 4.5:1, large text and controls 3:1). Meaning is never carried by colour alone.</p>`)
    );
  }
  if (g.type) {
    pages.push(
      page(p ? 8 : 6, "Type", `<div class="spec"><p class="aa" style="font-family:${display}">Aa</p><p><b>Display</b> ${esc(g.type.display ?? g.type.wordmarkFamily ?? "")}</p></div><div class="spec"><p class="aa" style="font-family:${body}">Aa</p><p><b>Body</b> ${esc(g.type.body ?? "")}</p></div><p style="font-family:${display};font-size:26px">${esc(g.name)} — the quick brown fox</p><p style="font-family:${body}">The same sentence in the body face, at reading size, in the brand's ink.</p><p class="small">Every font is SIL Open Font License 1.1, free for products and print. Licence texts are in the kit's fonts folder.</p>`)
    );
  }
  const n = pages.length + 1;
  pages.push(
    page(n, "Applications", `<div class="row"><div class="card" style="background:${ground};color:${ink}"><img src="${uri(g.lockups?.horizontal ?? g.logo.onLight)}" style="height:34px"><p style="font-family:${body}">Business card</p></div><div class="avatar"><img src="${uri(g.logo.appIcon)}" style="width:96px"><p>Avatar</p></div></div>
<div class="site" style="background:${ground};color:${ink};border:1px solid #8883"><div class="nav"><img src="${uri(g.lockups?.horizontal ?? g.logo.onLight)}" style="height:28px"><span style="background:${accent};color:${p ? p.light.onPrimary : "#fff"};padding:6px 12px;border-radius:6px;font-family:${body}">Call to action</span></div></div>
<div class="site" style="background:${p ? p.dark.background : "#0f0f14"};color:${p ? p.dark.text : "#fafafa"}"><div class="nav"><img src="${uri(g.lockups?.horizontalDark ?? g.logo.onDark)}" style="height:28px"><span style="background:${p ? p.dark.primary : accent};color:${p ? p.dark.onPrimary : "#fff"};padding:6px 12px;border-radius:6px;font-family:${body}">Call to action</span></div></div>`)
  );
  pages.push(
    page(n + 1, "Checks and honesty", `<table><tr><th>Check</th><th>Kind</th><th>Result</th></tr>${g.checks.map((c) => `<tr><td>${esc(c.id)}</td><td>${esc(c.kind)}</td><td>${c.status === "pass" ? "✔ " : c.status === "fail" ? "✖ " : "– not checked: "}${esc(c.detail)}</td></tr>`).join("")}</table><p class="small">A gate is measured and can fail. A warning is a heuristic. A judgement is an opinion. A clean report means nothing measurable is broken, not that the identity is good.${g.assumptions.length ? ` Assumed: ${esc(g.assumptions.join("; "))}.` : ""}</p>`)
  );

  return `<!doctype html><html><head><meta charset="utf-8"><style>${faceCss}
@page{size:1123px 794px;margin:0}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#18181b;background:#fff}
.pg{width:1123px;height:794px;padding:44px 56px;position:relative;overflow:hidden;page-break-after:always;background:#fff}
.pg header{display:flex;justify-content:space-between;font-size:11px;color:#71717a;letter-spacing:.06em;text-transform:uppercase}
.pg h2{font-size:30px;margin:18px 0 20px}
.cover{display:flex;flex-direction:column;justify-content:center;gap:10px;padding-left:96px}.cover h1{font-size:72px;margin:10px 0 0}.cover p{font-size:20px;margin:0}
.big{font-size:34px;line-height:1.25;max-width:820px}
.row{display:flex;gap:16px;margin:12px 0}.box{flex:1;height:200px;border:1px solid #8883;border-radius:10px;display:flex;align-items:center;justify-content:center}
.clear{display:flex;gap:24px;align-items:center;margin-top:16px}.cs{padding:60px;border:2px dashed #94a3b8;border-radius:6px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.vc p,.mc p{margin:6px 0 0;font-size:13px}.vb,.mb{height:128px;border:1px solid #8883;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.x{color:#dc2626}.small{font-size:12px;color:#52525b}
.sws{display:flex;gap:10px;margin-bottom:14px}.sw{flex:1;padding:14px;border-radius:8px;min-height:92px;display:flex;flex-direction:column;gap:2px}.sw small{opacity:.8}
table{border-collapse:collapse;width:100%;font-size:12.5px}td,th{text-align:left;padding:4px 8px;border-bottom:1px solid #e4e4e7}td i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:middle;border:1px solid #8884}
.spec{display:inline-block;width:46%;vertical-align:top}.aa{font-size:90px;margin:0;line-height:1}
.card{width:340px;height:200px;border-radius:10px;border:1px solid #8883;padding:22px;display:flex;flex-direction:column;justify-content:space-between}.avatar{text-align:center}
.site{border-radius:10px;margin:10px 0;padding:14px 18px}.nav{display:flex;justify-content:space-between;align-items:center}
</style></head><body>${pages.join("")}</body></html>`;
}
