/** Stable, distinct border colors so each Construction Detail used in a Production Setup can be
 * told apart visually on the layout canvas, independent of the fill color used for planning
 * status (unplanned/planned/assigned). */
const PALETTE = [
  '#38bdf8', '#f472b6', '#facc15', '#4ade80', '#a78bfa',
  '#fb923c', '#22d3ee', '#f87171', '#34d399', '#c084fc',
  '#fbbf24', '#60a5fa', '#e879f9', '#2dd4bf', '#f97316',
];

export function colorForConstructionIndex(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/** Builds a stable productId -> color map from the FULL WL_Products list order (not just the
 * ones currently assigned), so a Construction's color never shifts as assignments change. */
export function buildConstructionColorMap(productIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  productIds.forEach((id, index) => map.set(id, colorForConstructionIndex(index)));
  return map;
}
