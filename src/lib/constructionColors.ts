/** Mid-tone fills that keep the white machine label readable and stay clearly apart from the
 * gray "unplanned" body. */
const FILL_PALETTE = [
  '#2563eb', '#db2777', '#ca8a04', '#16a34a', '#7c3aed', '#ea580c',
  '#0891b2', '#dc2626', '#059669', '#9333ea', '#65a30d', '#c026d3',
];

/** The i-th of an open-ended set of distinct body fills: the curated palette first, then
 * golden-angle hue steps (never repeating a hue) with alternating lightness, so any number of
 * Constructions/operators each get their own color. */
export function distinctFillColor(index: number): string {
  if (index < FILL_PALETTE.length) return FILL_PALETTE[index];
  const k = index - FILL_PALETTE.length;
  const hue = (k * 137.508 + 20) % 360;
  const lightness = [38, 46, 32][k % 3];
  return `hsl(${hue.toFixed(1)} 62% ${lightness}%)`;
}

/** Assigns each id its own distinct fill, in the given order. */
export function buildDistinctColorMap(ids: string[]): Map<string, string> {
  const map = new Map<string, string>();
  ids.forEach((id) => {
    if (!map.has(id)) map.set(id, distinctFillColor(map.size));
  });
  return map;
}

/** One color per Construction Detail used in a Production Setup — shared by the Setup canvas
 * (machine body fill) and the Production Run canvas (machine border) so the same Construction is
 * the same color on both screens. Ordered like WL_Products (`productIdsInOrder`), with any
 * assigned id missing from that list appended. */
export function buildSetupConstructionColorMap(
  assignedConstructionIds: (string | undefined)[],
  productIdsInOrder: string[],
): Map<string, string> {
  const used = new Set(assignedConstructionIds.filter((id): id is string => !!id));
  const ordered = productIdsInOrder.filter((id) => used.has(id));
  const orderedSet = new Set(ordered);
  used.forEach((id) => {
    if (!orderedSet.has(id)) ordered.push(id);
  });
  return buildDistinctColorMap(ordered);
}
