import { MACHINE_H, MACHINE_W } from './layoutConstants';

export interface RoutePoint {
  x: number;
  y: number;
  /** Actual machine footprint in px, when this point represents a machine (resized machines carry
   * their own values here); falls back to the standard MACHINE_W/MACHINE_H when absent, e.g. for
   * plain operator/start points that aren't machines at all. */
  widthPx?: number;
  heightPx?: number;
}

type Interval = [number, number];

interface RowBand {
  topY: number;
  bottomY: number;
  occupiedX: Interval[];
}

/** Lets a caller reuse the row-band computation across many calls in the same simulation run
 * (row layout is derived purely from machine positions, which never change mid-run) — matters at
 * ~1500-machine scale where clusterRows() would otherwise re-sort/re-bucket every single machine
 * on every single walk decision. Pass the SAME object on every call; it self-populates once. */
export interface RoutingRowCache {
  machines: RoutePoint[] | null;
  rows: RowBand[];
}

export function createRoutingRowCache(): RoutingRowCache {
  return { machines: null, rows: [] };
}

/** Default scale (px per meter) used only if a caller doesn't have the real Movement Parameters
 * value on hand — matches the app-wide default (see layoutConstants.ts). */
const DEFAULT_PIXELS_PER_METER = 20;

/** Minimum empty vertical space (meters) between two machine bodies for it to count as a walkable
 * aisle — anything tighter than this is treated as the same row (no meaningful gap to route through).
 * Kept small so genuinely separate rows are never merged, even in a tightly-packed custom layout. */
const MIN_AISLE_GAP_METERS = 0.3;
/** How far past the outermost machines (meters) a corridor may be searched for — lets the operator
 * swing around the end of a row, not just through gaps between pairs. */
const CORRIDOR_SEARCH_MARGIN_METERS = 6;
/** Clearance (meters) added on EACH SIDE of every machine when looking for a corridor that crosses
 * one or more full rows in between (same-row and adjacent-row hops never reach this code path at
 * all, so this only ever affects genuine multi-row crossings). The default pair gap is ~0.7m, so
 * this has to stay well under half of that (0.35m) or it swallows the gap whole and forces every
 * multi-row crossing out to the edge — kept small so the real gap between paired machines stays
 * usable, with just enough margin that the drawn line doesn't sit exactly on a machine's edge. */
const CORRIDOR_CLEARANCE_METERS = 0.15;

/** Groups machines into horizontal rows using the actual empty space between machine edges (not a
 * fixed center-to-center guess), and records each row's occupied X ranges so a vertical corridor
 * that's actually clear in every row being crossed can be found. */
function clusterRows(machines: RoutePoint[], clearancePx: number, minAisleGapPx: number): RowBand[] {
  const sorted = [...machines].sort((a, b) => a.y - b.y);
  const rows: RowBand[] = [];
  for (const m of sorted) {
    const w = m.widthPx ?? MACHINE_W;
    const h = m.heightPx ?? MACHINE_H;
    const top = m.y - h / 2;
    const bottom = m.y + h / 2;
    const interval: Interval = [m.x - w / 2 - clearancePx, m.x + w / 2 + clearancePx];
    const last = rows[rows.length - 1];
    if (last && top - last.bottomY < minAisleGapPx) {
      last.topY = Math.min(last.topY, top);
      last.bottomY = Math.max(last.bottomY, bottom);
      last.occupiedX.push(interval);
    } else {
      rows.push({ topY: top, bottomY: bottom, occupiedX: [interval] });
    }
  }
  return rows;
}

/** Which row a point belongs to (or is nearest to, if it sits in an aisle just outside every row —
 * true for most service-zone points, which are drawn a few px outside their own machine's edge). */
function nearestRowIndex(rows: RowBand[], y: number): number {
  let bestIndex = 0;
  let bestDistance = Infinity;
  rows.forEach((row, index) => {
    const distance = y < row.topY ? row.topY - y : y > row.bottomY ? y - row.bottomY : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [[...sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = merged[merged.length - 1];
    const [s, e] = sorted[i];
    if (s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

function dedupe(points: RoutePoint[]): RoutePoint[] {
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.5);
}

/** How close two Y values have to be to treat a hop as "already aligned" — e.g. the same zone type
 * on two machines in the same row — where a direct line can't dip into any row's body anyway. */
const SAME_Y_TOLERANCE = 1;

/** The row-boundary aisle immediately above/below a given row (falling back to a fixed margin past
 * the very first/last row, for a hop that starts or ends outside every row band). */
function adjacentAisleY(rows: RowBand[], rowIndex: number, side: 'above' | 'below', searchMarginPx: number): number {
  if (side === 'above') {
    return rowIndex > 0 ? (rows[rowIndex - 1].bottomY + rows[rowIndex].topY) / 2 : rows[rowIndex].topY - searchMarginPx;
  }
  return rowIndex < rows.length - 1
    ? (rows[rowIndex].bottomY + rows[rowIndex + 1].topY) / 2
    : rows[rowIndex].bottomY + searchMarginPx;
}

/** Routes the operator's walk between machines through a vertical corridor that's clear in every
 * row it crosses (e.g. the gap between pairs, or past the end of a row), rather than a straight
 * line — so a hop between two far-apart machines doesn't cut through whatever rows sit in between.
 * This is a heuristic, not real pathfinding: if no single corridor is clear across every row being
 * crossed, it still bends through the nearest aisles rather than guaranteeing zero overlap.
 *
 * Also covers hops that stay within the SAME row but change zone type (e.g. Payoff of one pair to
 * Cradle of another) — a direct line there can still cut diagonally through whatever pair sits
 * between them, so it's routed through that row's own boundary aisle too, not left as a straight
 * line just because no row is being crossed. */
export function computeWalkingWaypoints(
  start: RoutePoint,
  end: RoutePoint,
  machines: RoutePoint[],
  pixelsPerMeter: number = DEFAULT_PIXELS_PER_METER,
  rowCache?: RoutingRowCache,
): RoutePoint[] {
  if (machines.length === 0 || Math.abs(start.y - end.y) < SAME_Y_TOLERANCE) return [start, end];
  const scale = pixelsPerMeter > 0 ? pixelsPerMeter : DEFAULT_PIXELS_PER_METER;
  const clearancePx = CORRIDOR_CLEARANCE_METERS * scale;
  const minAisleGapPx = MIN_AISLE_GAP_METERS * scale;
  const searchMarginPx = CORRIDOR_SEARCH_MARGIN_METERS * scale;

  let rows: RowBand[];
  if (rowCache) {
    if (rowCache.machines !== machines) {
      rowCache.rows = clusterRows(machines, clearancePx, minAisleGapPx);
      rowCache.machines = machines;
    }
    rows = rowCache.rows;
  } else {
    rows = clusterRows(machines, clearancePx, minAisleGapPx);
  }
  if (rows.length === 0) return [start, end];

  const startRow = nearestRowIndex(rows, start.y);
  const endRow = nearestRowIndex(rows, end.y);

  if (startRow === endRow) {
    // Same row: bend through whichever of its two boundary aisles is nearer to these two points,
    // so the horizontal crossing happens in a fully clear aisle instead of through the row itself.
    const avgY = (start.y + end.y) / 2;
    const aboveY = adjacentAisleY(rows, startRow, 'above', searchMarginPx);
    const belowY = adjacentAisleY(rows, startRow, 'below', searchMarginPx);
    const aisleY = Math.abs(avgY - aboveY) <= Math.abs(avgY - belowY) ? aboveY : belowY;
    const occupied = mergeIntervals(rows[startRow].occupiedX);
    const rowLeft = occupied[0]?.[0] ?? Math.min(start.x, end.x);
    const rowRight = occupied[occupied.length - 1]?.[1] ?? Math.max(start.x, end.x);
    const crossesMachineBlock =
      (start.x >= rowLeft && start.x <= rowRight) ||
      (end.x >= rowLeft && end.x <= rowRight);
    if (crossesMachineBlock) {
      const leftCorridorX = rowLeft - clearancePx - 1;
      const rightCorridorX = rowRight + clearancePx + 1;
      const corridorX =
        Math.abs((start.x + end.x) / 2 - leftCorridorX) <= Math.abs((start.x + end.x) / 2 - rightCorridorX)
          ? leftCorridorX
          : rightCorridorX;
      // Leave the machine row through its boundary aisle first, then go around the
      // outside edge of the complete row/group before approaching the destination.
      return dedupe([
        start,
        { x: start.x, y: aisleY },
        { x: corridorX, y: aisleY },
        { x: corridorX, y: end.y },
        end,
      ]);
    }
    return dedupe([start, { x: start.x, y: aisleY }, { x: end.x, y: aisleY }, end]);
  }

  const dir = endRow > startRow ? 1 : -1;
  const exitAisleY = adjacentAisleY(rows, startRow, dir === 1 ? 'below' : 'above', searchMarginPx);
  const entryAisleY = adjacentAisleY(rows, endRow, dir === 1 ? 'above' : 'below', searchMarginPx);

  // Only the rows strictly BETWEEN start and end need a clear corridor — the start/end rows
  // themselves obviously contain the very machines being left/visited, and are already handled by
  // the dedicated exit/entry segments below, not the middle corridor crossing.
  const allX = machines.map((m) => m.x);
  const minX = Math.min(...allX, start.x, end.x) - searchMarginPx;
  const maxX = Math.max(...allX, start.x, end.x) + searchMarginPx;

  // For adjacent rows, the aisle between the two row bodies is safe and avoids a
  // needless trip around the entire layout. Only use the outer corridor when the
  // route must cross one or more intervening rows.
  const leftOuterX = minX;
  const rightOuterX = maxX;
  const preferredX = (start.x + end.x) / 2;
  const corridorX =
    Math.abs(endRow - startRow) === 1
      ? preferredX
      : Math.abs(preferredX - leftOuterX) <= Math.abs(preferredX - rightOuterX)
        ? leftOuterX
        : rightOuterX;

  return dedupe([
    start,
    { x: start.x, y: exitAisleY },
    { x: corridorX, y: exitAisleY },
    { x: corridorX, y: entryAisleY },
    { x: end.x, y: entryAisleY },
    end,
  ]);
}
