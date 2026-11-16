/**
 * A mark that clogs at 16 px gets a simplified drawing for small sizes (favicon, tab, avatar). The
 * model simplifies; code checks it is a valid, simpler drawing of the same colours before it is used.
 */
import { auditSvg, sanitizeSvg, type SvgAudit } from "./svgSafety.js";

export const SMALL_SYSTEM =
  "You simplify a logo mark for tiny sizes (16 to 32 px). Keep the same idea, silhouette and colours, but remove or merge fine detail: fewer shapes, nothing thinner than 6 units, no gap narrower than 6 units, bolder strokes. " +
  'Output ONLY one <svg viewBox="0 0 100 100"> element of flat shapes (path, circle, ellipse, rect, line, polyline, polygon, g), no text, no filters, no scripts, hex fills only.';

/** Worth drawing when it has many parts, or the judge said it clogs when small. */
export function needsSmallMark(audit: SvgAudit, defects: string[]): boolean {
  return audit.shapes > 8 || defects.some((d) => /\b(16|32) ?px\b|clog|too small|tiny size|fine detail|thin/i.test(d));
}

export async function drawSmallMark(
  call: (system: string, user: string) => Promise<string>,
  svg: string,
  original: SvgAudit
): Promise<{ svg: string; audit: SvgAudit } | null> {
  let reply: string;
  try {
    reply = await call(SMALL_SYSTEM, `The mark:\n${svg}\n\nReturn the simplified small-size version.`);
  } catch {
    return null;
  }
  const s = sanitizeSvg(reply);
  if (!s.svg || s.problems.length > 0) return null;
  const audit = auditSvg(s.svg);
  // Must be simpler, still drawable, and stay inside the logo's own colours.
  if (audit.shapes < 1 || audit.shapes >= original.shapes || audit.colors.length > original.colors.length) return null;
  if (audit.colors.some((c) => !original.colors.includes(c))) return null;
  return { svg: s.svg, audit };
}
