/** Smart guides for dragging machines on the Layout Builder: alignment snapping + guide lines, and
 * the gap to the nearest machine on each side. All values are in world (layout) pixels. */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GapMarker extends GuideLine {
  /** Gap length in world px (convert with pixelsPerMeter for display). */
  distance: number;
}

export interface DragGuides {
  /** Offset to add to the dragged position so it snaps onto the nearest alignment. */
  snapDx: number;
  snapDy: number;
  lines: GuideLine[];
  gaps: GapMarker[];
}

const refsX = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w];
const refsY = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h];
/** How close two edges must be (world px) to count as exactly aligned once snapped. */
const ALIGNED_EPS = 0.5;

/** Finds the smallest shift (≤ threshold) that lines up any of the moving box's edges/center with
 * any other machine's edges/center, per axis. */
function bestSnap(moving: number[], others: Box[], refs: (b: Box) => number[], threshold: number): number {
  let best: number | null = null;
  for (const other of others) {
    for (const target of refs(other)) {
      for (const ref of moving) {
        const diff = target - ref;
        if (Math.abs(diff) <= threshold && (best === null || Math.abs(diff) < Math.abs(best))) best = diff;
      }
    }
  }
  return best ?? 0;
}

/**
 * @param moving    bounding box of everything being dragged, at the proposed (unsnapped) position
 * @param others    every machine NOT being dragged
 * @param threshold snap distance in world px (0 = show guides/gaps but never snap)
 * @param maxGap    gaps longer than this (world px) aren't shown
 */
export function computeDragGuides(moving: Box, others: Box[], threshold: number, maxGap: number): DragGuides {
  const snapDx = threshold > 0 ? bestSnap(refsX(moving), others, refsX, threshold) : 0;
  const snapDy = threshold > 0 ? bestSnap(refsY(moving), others, refsY, threshold) : 0;
  const box: Box = { ...moving, x: moving.x + snapDx, y: moving.y + snapDy };

  // Guide lines: one per aligned reference, spanning the dragged box and every machine sharing it.
  const lines: GuideLine[] = [];
  refsX(box).forEach((x) => {
    const aligned = others.filter((o) => refsX(o).some((ox) => Math.abs(ox - x) <= ALIGNED_EPS));
    if (aligned.length === 0) return;
    const top = Math.min(box.y, ...aligned.map((o) => o.y));
    const bottom = Math.max(box.y + box.h, ...aligned.map((o) => o.y + o.h));
    lines.push({ x1: x, y1: top, x2: x, y2: bottom });
  });
  refsY(box).forEach((y) => {
    const aligned = others.filter((o) => refsY(o).some((oy) => Math.abs(oy - y) <= ALIGNED_EPS));
    if (aligned.length === 0) return;
    const left = Math.min(box.x, ...aligned.map((o) => o.x));
    const right = Math.max(box.x + box.w, ...aligned.map((o) => o.x + o.w));
    lines.push({ x1: left, y1: y, x2: right, y2: y });
  });

  // Gaps: nearest machine on each side that overlaps the dragged box across that axis.
  const gaps: GapMarker[] = [];
  const overlapY = (o: Box) => Math.min(box.y + box.h, o.y + o.h) - Math.max(box.y, o.y);
  const overlapX = (o: Box) => Math.min(box.x + box.w, o.x + o.w) - Math.max(box.x, o.x);
  const midY = (o: Box) => (Math.max(box.y, o.y) + Math.min(box.y + box.h, o.y + o.h)) / 2;
  const midX = (o: Box) => (Math.max(box.x, o.x) + Math.min(box.x + box.w, o.x + o.w)) / 2;
  const nearest = (candidates: { box: Box; gap: number }[]) =>
    candidates.filter((c) => c.gap >= 0 && c.gap <= maxGap).sort((a, b) => a.gap - b.gap)[0];

  const left = nearest(others.filter((o) => overlapY(o) > 0).map((o) => ({ box: o, gap: box.x - (o.x + o.w) })));
  if (left) gaps.push({ x1: left.box.x + left.box.w, y1: midY(left.box), x2: box.x, y2: midY(left.box), distance: left.gap });
  const right = nearest(others.filter((o) => overlapY(o) > 0).map((o) => ({ box: o, gap: o.x - (box.x + box.w) })));
  if (right) gaps.push({ x1: box.x + box.w, y1: midY(right.box), x2: right.box.x, y2: midY(right.box), distance: right.gap });
  const up = nearest(others.filter((o) => overlapX(o) > 0).map((o) => ({ box: o, gap: box.y - (o.y + o.h) })));
  if (up) gaps.push({ x1: midX(up.box), y1: up.box.y + up.box.h, x2: midX(up.box), y2: box.y, distance: up.gap });
  const down = nearest(others.filter((o) => overlapX(o) > 0).map((o) => ({ box: o, gap: o.y - (box.y + box.h) })));
  if (down) gaps.push({ x1: midX(down.box), y1: box.y + box.h, x2: midX(down.box), y2: down.box.y, distance: down.gap });

  return { snapDx, snapDy, lines, gaps };
}
