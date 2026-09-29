/** Largest machine-number font size (px) — what every label used before it became width-aware. */
export const MACHINE_LABEL_MAX_FONT_PX = 11;
/** Rough glyph width of the bold label font as a fraction of the font size (a little generous, so
 * the estimate errs on the side of fitting). */
const LABEL_GLYPH_WIDTH_EM = 0.62;
const LABEL_SIDE_PADDING_PX = 2;

/** Font size that keeps a machine number inside a box `widthPx` wide: the normal 11 px when it
 * fits, otherwise shrunk just enough — e.g. a 5-digit number on a 1.5 m machine. */
export function machineLabelFontSize(label: string, widthPx: number): number {
  const chars = Math.max(1, label.length);
  const fit = (widthPx - LABEL_SIDE_PADDING_PX * 2) / (chars * LABEL_GLYPH_WIDTH_EM);
  return Math.max(4, Math.min(MACHINE_LABEL_MAX_FONT_PX, fit));
}

/** Shifts the LAST number inside a machine label by `delta`, keeping any prefix/suffix and the
 * digit count: NDE01 +1 → NDE02, NDE09 +1 → NDE10, 12 −1 → 11, A-099B +1 → A-100B. A label with
 * no digits gets "-n" appended instead (n = |delta|); results never go below 0. */
export function shiftMachineLabel(label: string, delta: number): string {
  const match = /^(.*?)(\d+)(\D*)$/.exec(label);
  if (!match) return `${label}-${Math.abs(delta)}`;
  const [, prefix, digits, suffix] = match;
  const next = Math.max(0, parseInt(digits, 10) + delta);
  return `${prefix}${String(next).padStart(digits.length, '0')}${suffix}`;
}
