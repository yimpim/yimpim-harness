/**
 * Draws an SVG to a PNG so it can be LOOKED at, by a vision model and by the
 * person choosing. Looking is what turns a model's first attempt into a usable
 * mark: it cannot see lumpy curves or an unreadable 16 px version from the code.
 *
 * The SVG is shown as an <img> (never inlined), so even a mark that slipped past
 * the sanitizer could not run script or load anything.
 */
import { recolorSvg } from "./svgSafety.js";

export interface RenderOptions {
  /** Width in px; also the height unless `height` is given (a wide lockup should not be boxed square). */
  size: number;
  height?: number;
  /** CSS colour behind the mark; transparent when absent. */
  background?: string;
  grayscale?: boolean;
}

export interface Renderer {
  png(svg: string, opts: RenderOptions): Promise<Buffer>;
  /** A whole HTML page as a PNG (used for the side-by-side sheet). */
  page(html: string, width: number, height: number): Promise<Buffer>;
  /** A document as a PDF (fixed-size pages). Absent when the renderer cannot make one. */
  pdf?(html: string, width: number, height: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** A browser will not draw an SVG data-URI that lacks its namespace, so one is added if missing. */
const withNs = (svg: string) => (/<svg[^>]*\sxmlns\s*=/i.test(svg) ? svg : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"'));
const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(withNs(svg), "utf-8").toString("base64")}`;

/** null when there is no browser to draw with; callers carry on without looking and say so. */
export async function openRenderer(): Promise<Renderer | null> {
  let browser: any;
  try {
    const mod: any = await import("playwright");
    browser = await mod.chromium.launch({ headless: true });
  } catch {
    return null;
  }
  const withPage = async <T>(width: number, height: number, html: string, f: (page: any) => Promise<T>): Promise<T> => {
    const context = await browser.newContext({ viewport: { width, height }, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load" });
      return await f(page);
    } finally {
      await context.close();
    }
  };
  return {
    async png(svg, opts) {
      const filter = opts.grayscale ? "filter:grayscale(1);" : "";
      const html = `<!doctype html><html><body style="margin:0;background:${opts.background ?? "transparent"}"><img src="${dataUri(svg)}" style="display:block;width:${opts.size}px;height:${opts.height ?? opts.size}px;${filter}"></body></html>`;
      return withPage(opts.size, opts.height ?? opts.size, html, (p) => p.screenshot({ type: "png", omitBackground: !opts.background }));
    },
    async page(html, width, height) {
      return withPage(width, height, html, (p) => p.screenshot({ type: "png", fullPage: true }));
    },
    async pdf(html, width, height) {
      return withPage(width, height, html, (p) => p.pdf({ width: `${width}px`, height: `${height}px`, printBackground: true, preferCSSPageSize: true }));
    },
    async close() {
      try {
        await browser.close();
      } catch {
        // already gone
      }
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface SheetCell {
  label: string;
  svg: string;
  /** Prerendered tiny PNGs (shown enlarged and unsmoothed so what is lost at that size shows). */
  small: { size: number; png: Buffer }[];
}

/**
 * One image holding every cell: the mark large, then small and enlarged,
 * greyscale, and on dark. A mark has to survive all of these.
 */
export function sheetHtml(cells: SheetCell[], columns = 3): string {
  const cell = (c: SheetCell) => {
    const smalls = c.small
      .map(
        (s) =>
          `<div class="s"><img class="px" src="data:image/png;base64,${s.png.toString("base64")}" style="width:${Math.max(48, s.size * 3)}px;height:${Math.max(48, s.size * 3)}px"><span>${s.size}px</span></div>`
      )
      .join("");
    return `<div class="c"><div class="t">${esc(c.label)}</div>
<div class="row"><div class="light"><img src="${dataUri(c.svg)}" style="width:150px;height:150px"><span>light surface</span></div>
<div class="dark"><img src="${dataUri(c.svg)}" style="width:150px;height:150px"><span>dark surface</span></div></div>
<div class="row"><div class="gray"><img src="${dataUri(c.svg)}" style="width:64px;height:64px;filter:grayscale(1)"><span>greyscale</span></div><div class="gray"><img src="${dataUri(c.svg)}" style="width:64px;height:64px;transform:rotate(180deg)"><span>rotated</span></div><div class="gray"><img src="${dataUri(c.svg)}" style="width:64px;height:64px;transform:scaleX(-1)"><span>mirrored</span></div><div class="gray"><img src="${dataUri(recolorSvg(withNs(c.svg), "#000000", undefined, "#ffffff"))}" style="width:64px;height:64px"><span>one colour</span></div><div class="gray"><img src="${dataUri(c.svg)}" style="width:64px;height:64px;filter:blur(2.5px)"><span>squint</span></div>${smalls}</div></div>
`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:16px;background:#f4f4f5;font:14px system-ui,sans-serif;color:#18181b}
.g{display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:16px}
.c{background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:12px}
.t{font-weight:600;margin-bottom:8px}
.row{display:flex;gap:12px;align-items:flex-end;margin-bottom:8px;flex-wrap:wrap}
.light{background:#ffffff;border:1px solid #e4e4e7;padding:8px;border-radius:6px;text-align:center;font-size:11px}
.dark{background:#0f0f14;padding:8px;border-radius:6px;text-align:center;color:#fafafa;font-size:11px}
.gray{text-align:center;font-size:11px}
.s{text-align:center;font-size:11px}.px{image-rendering:pixelated;display:block}
.light span,.dark span,.gray span,.s span{display:block}
</style></head><body><div class="g">${cells.map(cell).join("")}</div></body></html>`;
}

export async function renderSheet(r: Renderer, cells: SheetCell[], columns = 3): Promise<Buffer> {
  const width = 16 + columns * 400 + (columns - 1) * 16 + 16;
  return r.page(sheetHtml(cells, columns), width, 400);
}

/** The enlarged tiny versions for one mark. */
export async function smallRenders(r: Renderer, svg: string, sizes = [32, 16]): Promise<{ size: number; png: Buffer }[]> {
  const out: { size: number; png: Buffer }[] = [];
  for (const size of sizes) out.push({ size, png: await r.png(svg, { size, background: "#ffffff" }) });
  return out;
}

/**
 * The finished logo as it will be met: on a light page and a dark page, as a
 * tab-sized icon on each, and as the app icon. One image, easy to look at on a phone.
 */
export function boardHtml(o: { name: string; onLight: string; onDark: string; appIcon: string; appIconDark?: string; smallLight: Buffer; smallDark: Buffer }): string {
  const img = (svg: string, px: number) => `<img src="${dataUri(svg)}" style="width:${px}px;height:${px}px">`;
  const px = (b: Buffer) => `<img class="px" src="data:image/png;base64,${b.toString("base64")}" style="width:48px;height:48px">`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:14px system-ui,sans-serif}
.p{display:flex;align-items:center;gap:20px;padding:24px 28px}
.l{background:#ffffff;color:#18181b}.d{background:#0f0f14;color:#fafafa}
.t{font-weight:600;font-size:18px}.m{opacity:.6;font-size:12px}
.px{image-rendering:pixelated}
.i{display:flex;gap:20px;align-items:center;justify-content:center;padding:20px;background:#e4e4e7}
</style></head><body>
<div class="p l">${img(o.onLight, 96)}<div><div class="t">${esc(o.name)}</div><div class="m">on a light page</div></div><div style="margin-left:auto">${px(o.smallLight)}</div></div>
<div class="p d">${img(o.onDark, 96)}<div><div class="t">${esc(o.name)}</div><div class="m">on a dark page</div></div><div style="margin-left:auto">${px(o.smallDark)}</div></div>
<div class="i">${img(o.appIcon, 96)}${img(o.appIcon, 56)}${img(o.appIcon, 32)}<span class="m">app icon</span>${o.appIconDark ? `${img(o.appIconDark, 96)}${img(o.appIconDark, 56)}<span class="m">dark mode</span>` : ""}</div>
</body></html>`;
}

/**
 * One wordmark option: the lockup on a light page and a dark page, each at a comfortable size
 * and at a small one (a header or an app bar), because type that is fine large and mush small is no use.
 */
export function lockupCardHtml(o: { label: string; light: string; dark: string; lightAlt?: string; darkAlt?: string }): string {
  const img = (svg: string, h: number) => `<img src="${dataUri(svg)}" style="height:${h}px;max-width:420px">`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:13px system-ui,sans-serif}
.t{padding:10px 16px;background:#f4f4f5;font-weight:600;color:#18181b}
.l,.d{display:flex;align-items:center;gap:28px;padding:18px 16px}
.l{background:#ffffff}.d{background:#0f0f14}
</style></head><body>
<div class="t">${esc(o.label)}</div>
<div class="l">${img(o.light, 64)}${img(o.light, 24)}${o.lightAlt ? img(o.lightAlt, 64) : ""}</div>
<div class="d">${img(o.dark, 64)}${img(o.dark, 24)}${o.darkAlt ? img(o.darkAlt, 64) : ""}</div>
</body></html>`;
}
