/** Walking around walls. The row-based heuristic in operatorRouting.ts knows nothing about walls;
 * this post-processes its route: every leg that would cross a wall is replaced by the shortest
 * path through a visibility graph whose nodes sit just past each wall's ends (with clearance), so
 * operators walk around the wall instead of through it. */

export interface WallPoint {
  x: number;
  y: number;
}

export interface WallSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface WallGraph {
  walls: WallSegment[];
  clearancePx: number;
  nodes: WallPoint[];
  /** visible[i][j]: node i can see node j without crossing any wall. */
  visible: boolean[][];
  /** Detours are recomputed for the same endpoints over and over (every candidate-machine ETA) —
   * memoised by rounded endpoints. */
  cache: Map<string, WallPoint[]>;
}

const CACHE_LIMIT = 50_000;

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return Math.min(ax, bx) - 1e-9 <= px && px <= Math.max(ax, bx) + 1e-9 && Math.min(ay, by) - 1e-9 <= py && py <= Math.max(ay, by) + 1e-9;
}

/** True when segment p1→p2 touches or crosses wall w (collinear overlap counts). */
export function segmentCrossesWall(p1: WallPoint, p2: WallPoint, w: WallSegment): boolean {
  const d1 = cross(w.x1, w.y1, w.x2, w.y2, p1.x, p1.y);
  const d2 = cross(w.x1, w.y1, w.x2, w.y2, p2.x, p2.y);
  const d3 = cross(p1.x, p1.y, p2.x, p2.y, w.x1, w.y1);
  const d4 = cross(p1.x, p1.y, p2.x, p2.y, w.x2, w.y2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (Math.abs(d1) < 1e-9 && onSegment(w.x1, w.y1, w.x2, w.y2, p1.x, p1.y)) return true;
  if (Math.abs(d2) < 1e-9 && onSegment(w.x1, w.y1, w.x2, w.y2, p2.x, p2.y)) return true;
  if (Math.abs(d3) < 1e-9 && onSegment(p1.x, p1.y, p2.x, p2.y, w.x1, w.y1)) return true;
  if (Math.abs(d4) < 1e-9 && onSegment(p1.x, p1.y, p2.x, p2.y, w.x2, w.y2)) return true;
  return false;
}

function blocked(a: WallPoint, b: WallPoint, walls: WallSegment[]): boolean {
  for (const w of walls) if (segmentCrossesWall(a, b, w)) return true;
  return false;
}

/** Builds the (static) visibility graph once per layout: four corner nodes around each wall end,
 * `clearancePx` beyond the end and to either side. */
export function buildWallGraph(walls: WallSegment[], clearancePx: number): WallGraph | null {
  const usable = walls.filter((w) => Math.hypot(w.x2 - w.x1, w.y2 - w.y1) > 1e-6);
  if (usable.length === 0) return null;
  const nodes: WallPoint[] = [];
  usable.forEach((w) => {
    const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    const ux = (w.x2 - w.x1) / len;
    const uy = (w.y2 - w.y1) / len;
    const nx = -uy;
    const ny = ux;
    for (const [ex, ey, s] of [[w.x1, w.y1, -1], [w.x2, w.y2, 1]] as const) {
      nodes.push({ x: ex + s * ux * clearancePx + nx * clearancePx, y: ey + s * uy * clearancePx + ny * clearancePx });
      nodes.push({ x: ex + s * ux * clearancePx - nx * clearancePx, y: ey + s * uy * clearancePx - ny * clearancePx });
    }
  });
  const visible = nodes.map(() => nodes.map(() => false));
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const ok = !blocked(nodes[i], nodes[j], usable);
      visible[i][j] = ok;
      visible[j][i] = ok;
    }
  }
  return { walls: usable, clearancePx, nodes, visible, cache: new Map() };
}

/** Shortest wall-free path from a to b (inclusive), or null if the walls leave no way around. */
function shortestDetour(a: WallPoint, b: WallPoint, graph: WallGraph): WallPoint[] | null {
  const key = `${Math.round(a.x)},${Math.round(a.y)}>${Math.round(b.x)},${Math.round(b.y)}`;
  const cached = graph.cache.get(key);
  if (cached) return [a, ...cached.slice(1, -1), b];

  const { nodes, visible, walls } = graph;
  const n = nodes.length;
  // Index n = start, n + 1 = end.
  const all = [...nodes, a, b];
  const startIdx = n;
  const endIdx = n + 1;
  const seesStart = nodes.map((node) => !blocked(a, node, walls));
  const seesEnd = nodes.map((node) => !blocked(node, b, walls));
  const canSee = (i: number, j: number): boolean => {
    if (i === startIdx) return j === endIdx ? !blocked(a, b, walls) : seesStart[j];
    if (j === startIdx) return canSee(j, i);
    if (i === endIdx) return j === startIdx ? !blocked(a, b, walls) : seesEnd[j];
    if (j === endIdx) return seesEnd[i];
    return visible[i][j];
  };

  // Dijkstra over n + 2 nodes (graphs stay small: 4 nodes per wall).
  const dist = new Array(n + 2).fill(Infinity);
  const prev = new Array<number>(n + 2).fill(-1);
  const done = new Array(n + 2).fill(false);
  dist[startIdx] = 0;
  for (let iter = 0; iter < n + 2; iter += 1) {
    let u = -1;
    for (let i = 0; i < n + 2; i += 1) if (!done[i] && (u === -1 || dist[i] < dist[u])) u = i;
    if (u === -1 || dist[u] === Infinity) break;
    if (u === endIdx) break;
    done[u] = true;
    for (let v = 0; v < n + 2; v += 1) {
      if (done[v] || v === u || !canSee(u, v)) continue;
      const d = dist[u] + Math.hypot(all[u].x - all[v].x, all[u].y - all[v].y);
      if (d < dist[v]) {
        dist[v] = d;
        prev[v] = u;
      }
    }
  }
  if (dist[endIdx] === Infinity) return null;
  const path: WallPoint[] = [];
  for (let v = endIdx; v !== -1; v = prev[v]) path.unshift(all[v]);
  if (graph.cache.size >= CACHE_LIMIT) graph.cache.clear();
  graph.cache.set(key, path);
  return path;
}

function distanceToWall(p: WallPoint, w: WallSegment): number {
  const dx = w.x2 - w.x1;
  const dy = w.y2 - w.y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((p.x - w.x1) * dx + (p.y - w.y1) * dy) / lenSq)) : 0;
  return Math.hypot(p.x - (w.x1 + t * dx), p.y - (w.y1 + t * dy));
}

/** Replaces every leg of `route` that crosses a wall with the shortest way around. Legs that are
 * already clear — and every route when there are no walls — pass through unchanged. If the walls
 * fully enclose a point, that leg is left straight rather than failing the whole walk. */
export function detourAroundWalls<T extends WallPoint>(route: T[], graph: WallGraph | null | undefined): (T | WallPoint)[] {
  if (!graph || route.length < 2) return route;
  // The aisle heuristic's intermediate bends can land on (or right next to) a wall — e.g. a corridor
  // picked halfway between two machines exactly where a wall runs. Such a bend can't be reached
  // without touching the wall, so drop it and let the detour find the way instead. The real start
  // (operator) and end (service point) are always kept.
  const tooClose = (p: WallPoint) => graph.walls.some((w) => distanceToWall(p, w) < graph.clearancePx / 2);
  const points = route.filter((p, i) => i === 0 || i === route.length - 1 || !tooClose(p));
  const out: (T | WallPoint)[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!blocked(a, b, graph.walls)) {
      out.push(b);
      continue;
    }
    const detour = shortestDetour(a, b, graph);
    if (!detour) {
      out.push(b);
      continue;
    }
    out.push(...detour.slice(1, -1), b);
  }
  return out;
}
