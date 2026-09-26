/** Machine bodies (and walls) as walking obstacles: go straight when nothing is in the way,
 * otherwise take the shortest way around whatever machines and walls actually sit between the two
 * points — works for any machine orientation or arrangement (e.g. horizontal machines stacked in a
 * column are walked around their nearer end). */

import { segmentCrossesWall, type WallGraph } from './wallRouting';

export interface ObstaclePoint {
  x: number;
  y: number;
}

/** Axis-aligned rectangle: left, top, right, bottom (world px). */
export type Rect = [number, number, number, number];

export interface MachineObstacles {
  rects: Rect[];
  /** Touching machines merged into one block (bounding box of each connected cluster). */
  blocks: Rect[];
  /** Indices into `rects` of the machines making up each block. */
  blockMembers: number[][];
  /** Padding (world px) around each machine of a split block (see `memberRect`): half the merge gap,
   * so neighbours in the block still close the gap between them. */
  memberPad: number;
  /** Fallback detours are recomputed for the same endpoints again and again — memoised. */
  paths: Map<string, ObstaclePoint[] | null>;
  /** Edge tolerance (world px): service points sit a couple of px inside a machine's box and
   * operators walk along machine edges, so only paths deeper than this into a body count. */
  inset: number;
  /** Corner-to-corner (and wall-end) visibility, shared by every search: the same corners around
   * the same machines are tested over and over. Keyed by node-id pair (see detourAroundMachines). */
  visibility: Map<number, boolean>;
  /** Walls the cached `paths`/`visibility` were found around (both are dropped when they change). */
  wallsFor: WallGraph | null;
}

const PATH_CACHE_LIMIT = 50_000;
const VISIBILITY_CACHE_LIMIT = 1_000_000;
/** The search neighbourhood doubles from the start margin at most this many times over (keeps a
 * hopeless search from sweeping the whole plant on every call). */
const MAX_MARGIN_FACTOR = 32;

export function buildMachineObstacles(
  machines: { x: number; y: number; widthPx?: number; heightPx?: number }[],
  defaultW: number,
  defaultH: number,
  mergeGapPx: number,
  insetPx: number,
): MachineObstacles {
  const rects: Rect[] = machines.map((m) => {
    const w = m.widthPx ?? defaultW;
    const h = m.heightPx ?? defaultH;
    return [m.x - w / 2, m.y - h / 2, m.x + w / 2, m.y + h / 2];
  });

  // Union-find over rects closer than mergeGapPx on both axes (sorted sweep on x keeps it cheap).
  const parent = rects.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const order = rects.map((_, i) => i).sort((a, b) => rects[a][0] - rects[b][0]);
  for (let oi = 0; oi < order.length; oi += 1) {
    const a = rects[order[oi]];
    for (let oj = oi + 1; oj < order.length; oj += 1) {
      const b = rects[order[oj]];
      if (b[0] - a[2] > mergeGapPx) break;
      const gapX = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
      const gapY = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
      if (gapX <= mergeGapPx && gapY <= mergeGapPx) parent[find(order[oi])] = find(order[oj]);
    }
  }
  const blockByRoot = new Map<number, { rect: Rect; members: number[] }>();
  rects.forEach((r, i) => {
    const root = find(i);
    const b = blockByRoot.get(root);
    if (b) {
      b.rect[0] = Math.min(b.rect[0], r[0]);
      b.rect[1] = Math.min(b.rect[1], r[1]);
      b.rect[2] = Math.max(b.rect[2], r[2]);
      b.rect[3] = Math.max(b.rect[3], r[3]);
      b.members.push(i);
    } else {
      blockByRoot.set(root, { rect: [...r], members: [i] });
    }
  });
  const grouped = [...blockByRoot.values()];
  return {
    rects,
    blocks: grouped.map((g) => g.rect),
    blockMembers: grouped.map((g) => g.members),
    memberPad: mergeGapPx / 2,
    paths: new Map(),
    inset: insetPx,
    visibility: new Map(),
    wallsFor: null,
  };
}

/** Is p deeper than `inset` inside r? */
const inside = (p: ObstaclePoint, r: Rect, inset: number) =>
  p.x > r[0] + inset && p.x < r[2] - inset && p.y > r[1] + inset && p.y < r[3] - inset;

/** Does segment a→b pass through the interior of r (shrunk by `inset`, so walking along an edge is
 * fine)? Liang–Barsky clip. */
function segmentHitsRect(a: ObstaclePoint, b: ObstaclePoint, r: Rect, inset: number): boolean {
  const l = r[0] + inset;
  const t = r[1] + inset;
  const rr = r[2] - inset;
  const bb = r[3] - inset;
  if (l >= rr || t >= bb) return false;
  if (Math.max(a.x, b.x) <= l || Math.min(a.x, b.x) >= rr || Math.max(a.y, b.y) <= t || Math.min(a.y, b.y) >= bb) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q > 0;
    const u = q / p;
    if (p < 0) {
      if (u > t1) return false;
      if (u > t0) t0 = u;
    } else {
      if (u < t0) return false;
      if (u < t1) t1 = u;
    }
    return true;
  };
  return clip(-dx, a.x - l) && clip(dx, rr - a.x) && clip(-dy, a.y - t) && clip(dy, bb - a.y) && t1 - t0 > 1e-9;
}

/** One machine of a block that has to be split (an endpoint lies inside the block), padded so the
 * sub-merge-gap slits between it and its neighbours stay closed — nobody walks between machines
 * that close together. */
function memberRect(obstacles: MachineObstacles, m: number): Rect {
  const r = obstacles.rects[m];
  const p = obstacles.memberPad + obstacles.inset; // `inset` is taken off again by the hit test
  return [r[0] - p, r[1] - p, r[2] + p, r[3] + p];
}

/** The obstacles a walk from a to b has to respect: every block, except that a block containing
 * one of the endpoints is walked INTO — it's replaced by its machines minus the one(s) holding that
 * endpoint (the rest still count, and still can't be squeezed between). `split` gets the bounding
 * boxes of the blocks that were split. */
function obstaclesFor(
  a: ObstaclePoint,
  b: ObstaclePoint,
  obstacles: MachineObstacles,
  blockIdx: Iterable<number>,
  out: Rect[],
  outIds: number[] | null,
  split: Rect[] | null,
) {
  const inset = obstacles.inset;
  for (const i of blockIdx) {
    const r = obstacles.blocks[i];
    if (!inside(a, r, inset) && !inside(b, r, inset)) {
      out.push(r);
      outIds?.push(i);
      continue;
    }
    split?.push(r);
    for (const m of obstacles.blockMembers[i]) {
      const mr = obstacles.rects[m];
      if (inside(a, mr, inset) || inside(b, mr, inset)) continue;
      out.push(memberRect(obstacles, m));
      outIds?.push(-1);
    }
  }
}

/** Does a→b cut through no machine block (see `obstaclesFor`)? */
function clearOf(a: ObstaclePoint, b: ObstaclePoint, obstacles: MachineObstacles): boolean {
  const inset = obstacles.inset;
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  for (let i = 0; i < obstacles.blocks.length; i += 1) {
    const r = obstacles.blocks[i];
    if (r[2] - inset <= minX || r[0] + inset >= maxX || r[3] - inset <= minY || r[1] + inset >= maxY) continue;
    const rects: Rect[] = [];
    obstaclesFor(a, b, obstacles, [i], rects, null, null);
    for (const rr of rects) if (segmentHitsRect(a, b, rr, inset)) return false;
  }
  return true;
}

function crossesWall(a: ObstaclePoint, b: ObstaclePoint, walls: WallGraph | null | undefined): boolean {
  if (!walls) return false;
  for (const w of walls.walls) if (segmentCrossesWall(a, b, w)) return true;
  return false;
}

export function routeIsClear(route: ObstaclePoint[], obstacles: MachineObstacles, walls?: WallGraph | null): boolean {
  for (let i = 1; i < route.length; i += 1) {
    if (!clearOf(route[i - 1], route[i], obstacles)) return false;
    if (crossesWall(route[i - 1], route[i], walls)) return false;
  }
  return true;
}

export function straightIsClear(a: ObstaclePoint, b: ObstaclePoint, obstacles: MachineObstacles, walls?: WallGraph | null): boolean {
  return clearOf(a, b, obstacles) && !crossesWall(a, b, walls);
}

/** Shortest way from a to b around the machines AND walls near them — a visibility graph whose
 * nodes are the corners of the machine blocks (`clearancePx` out) and the ends of the walls, so the
 * walk reads the objects actually around it instead of assuming a row layout. Searches a growing
 * neighbourhood so a long block is still walked around its nearer end. Null if no clear way is
 * found. */
export function detourAroundMachines(
  a: ObstaclePoint,
  b: ObstaclePoint,
  obstacles: MachineObstacles,
  clearancePx: number,
  startMarginPx: number,
  walls?: WallGraph | null,
): ObstaclePoint[] | null {
  const wallGraph = walls ?? null;
  if (obstacles.wallsFor !== wallGraph) {
    obstacles.paths.clear();
    obstacles.visibility.clear();
    obstacles.wallsFor = wallGraph;
  }
  const key = `${Math.round(a.x)},${Math.round(a.y)}>${Math.round(b.x)},${Math.round(b.y)}`;
  if (obstacles.paths.has(key)) {
    const cached = obstacles.paths.get(key)!;
    return cached ? [a, ...cached.slice(1, -1), b] : null;
  }

  let result: ObstaclePoint[] | null = null;
  const all = obstacles.blocks;
  const inset = obstacles.inset;
  for (let margin = startMarginPx; margin <= startMarginPx * MAX_MARGIN_FACTOR; margin *= 2) {
    const minX = Math.min(a.x, b.x) - margin;
    const maxX = Math.max(a.x, b.x) + margin;
    const minY = Math.min(a.y, b.y) - margin;
    const maxY = Math.max(a.y, b.y) + margin;
    const localIdx: number[] = [];
    all.forEach((r, i) => {
      if (r[2] >= minX && r[0] <= maxX && r[3] >= minY && r[1] <= maxY) localIdx.push(i);
    });
    // blockIds: the block index for whole blocks (their corners get stable node ids), −1 for the
    // single machines of a split block.
    const blocking: Rect[] = [];
    const blockIds: number[] = [];
    const split: Rect[] = [];
    obstaclesFor(a, b, obstacles, localIdx, blocking, blockIds, split);
    // `owner` per node: the block whose corner it is (null for the endpoints and wall ends). A path
    // only ever bends at a corner by wrapping around it, so an edge touching a corner node must be
    // tangent to that node's block — the whole block on one side of the line (reduced visibility
    // graph). That rules out most edges before any (costlier) visibility test.
    // ids: stable per corner of a whole block (4·block + k) or wall end (4·blocks + n) so their
    // mutual visibility can be cached across searches; −1 for a, b and split-block corners.
    const nodes: ObstaclePoint[] = [];
    const owner: (Rect | null)[] = [null, null];
    const ids: number[] = [-1, -1];
    blocking.forEach((r, bi) => {
      const c = clearancePx;
      const corners = [
        { x: r[0] - c, y: r[1] - c },
        { x: r[2] + c, y: r[1] - c },
        { x: r[2] + c, y: r[3] + c },
        { x: r[0] - c, y: r[3] + c },
      ];
      corners.forEach((p, k) => {
        if (!blocking.some((o) => inside(p, o, 0))) {
          nodes.push(p);
          owner.push(r);
          ids.push(blockIds[bi] >= 0 ? blockIds[bi] * 4 + k : -1);
        }
      });
    });
    if (wallGraph) {
      wallGraph.nodes.forEach((p, wi) => {
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return;
        if (!blocking.some((o) => inside(p, o, 0))) {
          nodes.push(p);
          owner.push(null);
          ids.push(all.length * 4 + wi);
        }
      });
    }
    const idSpan = all.length * 4 + (wallGraph?.nodes.length ?? 0);
    const pts = [a, b, ...nodes];
    const tangentAt = (r: Rect | null, p: ObstaclePoint, dx: number, dy: number) => {
      if (!r) return true;
      // Signs of the block's four corners relative to the line — tangent when none disagree.
      const l = -dy * (r[0] - p.x);
      const rr = -dy * (r[2] - p.x);
      const t = dx * (r[1] - p.y);
      const bt = dx * (r[3] - p.y);
      const c1 = t + l;
      const c2 = t + rr;
      const c3 = bt + rr;
      const c4 = bt + l;
      const eps = 1e-9;
      const pos = c1 > eps || c2 > eps || c3 > eps || c4 > eps;
      const neg = c1 < -eps || c2 < -eps || c3 < -eps || c4 < -eps;
      return !(pos && neg);
    };
    // Legs to/from a or b are exempt: service points sit right at (inside the clearance of) their
    // machine, so the first/last leg runs along the block rather than tangent to it.
    const tangent = (i: number, j: number) => {
      if (i < 2 || j < 2) return true;
      const dx = pts[j].x - pts[i].x;
      const dy = pts[j].y - pts[i].y;
      return tangentAt(owner[i], pts[i], dx, dy) && tangentAt(owner[j], pts[j], dx, dy);
    };
    const test = (i: number, j: number) => {
      for (const r of blocking) if (segmentHitsRect(pts[i], pts[j], r, inset)) return false;
      return !crossesWall(pts[i], pts[j], wallGraph);
    };
    // Cached only between stable nodes, and only when the answer doesn't depend on this search's
    // endpoints (a leg through a split block is visible now but not for other endpoints). A block
    // outside this search's window could in principle make a cached "visible" wrong — the full check
    // on the finished path below still catches it.
    const visible = (i: number, j: number) => {
      if (ids[i] < 0 || ids[j] < 0) return test(i, j);
      if (split.some((r) => segmentHitsRect(pts[i], pts[j], r, inset))) return test(i, j);
      const key = ids[i] < ids[j] ? ids[i] * idSpan + ids[j] : ids[j] * idSpan + ids[i];
      const cached = obstacles.visibility.get(key);
      if (cached !== undefined) return cached;
      const ok = test(i, j);
      if (obstacles.visibility.size >= VISIBILITY_CACHE_LIMIT) obstacles.visibility.clear();
      obstacles.visibility.set(key, ok);
      return ok;
    };
    // A* (straight-line distance to b as the heuristic) with on-demand visibility — only the few
    // nodes heading towards b ever get expanded, so most visibility tests are never run.
    const n = pts.length;
    const toB = pts.map((p) => Math.hypot(p.x - b.x, p.y - b.y));
    const dist = new Array(n).fill(Infinity);
    const est = new Array(n).fill(Infinity);
    const prev = new Array<number>(n).fill(-1);
    const done = new Array(n).fill(false);
    dist[0] = 0;
    est[0] = toB[0];
    for (let it = 0; it < n; it += 1) {
      let u = -1;
      for (let i = 0; i < n; i += 1) if (!done[i] && (u === -1 || est[i] < est[u])) u = i;
      if (u === -1 || est[u] === Infinity || u === 1) break;
      done[u] = true;
      // b first: once a way to b is known, any node that can't beat it is skipped unchecked.
      for (let k = 0; k < n; k += 1) {
        const v = k === 0 ? 1 : k === 1 ? 0 : k;
        if (done[v] || v === u) continue;
        const d = dist[u] + Math.hypot(pts[u].x - pts[v].x, pts[u].y - pts[v].y);
        if (d >= dist[v]) continue;
        const e = d + toB[v];
        if (e >= dist[1] || !tangent(u, v)) continue;
        if (visible(u, v)) {
          dist[v] = d;
          est[v] = e;
          prev[v] = u;
        }
      }
    }
    if (dist[1] < Infinity) {
      const path: ObstaclePoint[] = [];
      for (let v = 1; v !== -1; v = prev[v]) path.unshift(pts[v]);
      // Only nearby blocks were considered — accept the path once it's clear of EVERY machine,
      // otherwise widen the search.
      if (routeIsClear(path, obstacles, wallGraph)) {
        result = path;
        break;
      }
    }
    if (localIdx.length === all.length) break; // searched everything, no way around
  }
  if (obstacles.paths.size >= PATH_CACHE_LIMIT) obstacles.paths.clear();
  obstacles.paths.set(key, result);
  return result;
}
