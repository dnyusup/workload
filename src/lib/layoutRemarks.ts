import type { LayoutRemark } from '../types';

export const REMARK_LINE_HEIGHT = 1.25;
/** Font size (layout world px) a new remark starts with. */
export const DEFAULT_REMARK_FONT_SIZE = 14;
/** Rough glyph width as a fraction of the font size — only used to size the click/selection box. */
const REMARK_GLYPH_WIDTH_EM = 0.58;

export function remarkLines(remark: LayoutRemark): string[] {
  return remark.text.split('\n');
}

/** Approximate box the remark's text occupies, from its top-left corner (layout world px). */
export function remarkBounds(remark: LayoutRemark): { width: number; height: number } {
  const lines = remarkLines(remark);
  const longest = Math.max(1, ...lines.map((line) => line.length));
  return {
    width: longest * remark.fontSize * REMARK_GLYPH_WIDTH_EM,
    height: lines.length * remark.fontSize * REMARK_LINE_HEIGHT,
  };
}
