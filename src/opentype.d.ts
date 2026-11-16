/**
 * opentype.js ships no types. Only what the wordmark engine uses is declared.
 */
declare module "opentype.js" {
  export interface BoundingBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }
  export interface PathCommand {
    type: string;
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export interface Path {
    commands: PathCommand[];
    getBoundingBox(): BoundingBox;
    toPathData(decimalPlaces?: number): string;
  }
  export interface Glyph {
    index: number;
    advanceWidth?: number;
    getPath(x?: number, y?: number, fontSize?: number): Path;
  }
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    tables: { os2?: { sCapHeight?: number; sxHeight?: number } };
    charToGlyph(c: string): Glyph;
    getKerningValue(left: Glyph, right: Glyph): number;
    forEachGlyph(
      text: string,
      x: number,
      y: number,
      fontSize: number,
      options: Record<string, unknown> | undefined,
      callback: (glyph: Glyph, x: number, y: number, fontSize: number) => void
    ): void;
  }
  export function parse(buffer: ArrayBuffer): Font;
  const opentype: { parse: typeof parse };
  export default opentype;
}
