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
  /** Spatial grid over the blocks (boxes padded to cover their split-machine rects too): segment
   * and point tests only look at the blocks actually along the way. Cell key → block indices. */
  cell: number;
  grid: Map<number, number[]>;
  /** Scratch marks de-duplicating blocks met in several grid cells. */
  stamp: Int32Array;
  stampId: number;
  /** Navigation graph for the current walls/clearance (built lazily; see `navFor`). */
  nav: NavGraph | null;
}

/** The corners and wall ends a walk can bend at, fixed for a whole run (machines and walls never
 * move), with each node's neighbours worked out once — on first use — instead of on every search. */
interface NavGraph {
  walls: WallGraph | null;
  clearance: number;
  /** Stable nodes: corner k of block i is id 4i + k, wall-end node w is 4·blocks + w. */
  pos: ObstaclePoint[];
  owner: (Rect | null)[];
  /** Blocks whose padded box contains the node — the only ones that can ever rule it out. */
  containers: number[][];
  /** Per node (lazy): tangent neighbours in sight — no machine block or wall in between — and the
   * length of each of those legs. */
  open: (Int32Array | null)[];
  openLen: (Float64Array | null)[];
  /** Per node (lazy): tangent neighbours hidden by a few machine blocks (no wall), as runs of
   * [v, count, ...blocks] — in sight after all in a search that leaves those blocks out (outside
   * its neighbourhood) or walks into them. */
  soft: (Int32Array | null)[];
}

const PATH_CACHE_LIMIT = 50_000;
/** Neighbours hidden by more blocks than this are treated as never in sight. */
const SOFT_BLOCKER_LIMIT = 8;
const GRID_CELL_PX = 64;
const GRID_OFFSET = 1 << 20;
const cellKey = (cx: number, cy: number) => (cx + GRID_OFFSET) * 2 * GRID_OFFSET + (cy + GRID_OFFSET);
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
  const blocks = grouped.map((g) => g.rect);
  const memberPad = mergeGapPx / 2;
  // Split-machine rects reach `memberPad + inset` past their block's box (see memberRect).
  const reach = memberPad + insetPx + 1;
  const grid = new Map<number, number[]>();
  blocks.forEach((r, i) => {
    const c0 = Math.floor((r[0] - reach) / GRID_CELL_PX);
    const c1 = Math.floor((r[2] + reach) / GRID_CELL_PX);
    const r0 = Math.floor((r[1] - reach) / GRID_CELL_PX);
    const r1 = Math.floor((r[3] + reach) / GRID_CELL_PX);
    for (let cx = c0; cx <= c1; cx += 1) {
      for (let cy = r0; cy <= r1; cy += 1) {
        const key = cellKey(cx, cy);
        const list = grid.get(key);
        if (list) list.push(i);
        else grid.set(key, [i]);
      }
    }
  });
  return {
    rects,
    blocks,
    blockMembers: grouped.map((g) => g.members),
    memberPad,
    paths: new Map(),
    inset: insetPx,
    cell: GRID_CELL_PX,
    grid,
    stamp: new Int32Array(blocks.length),
    stampId: 0,
    nav: null,
  };
}

/** Calls `visit` once for every block registered in a grid cell the segment a→b passes through
 * (a superset of the blocks it can hit), cell by cell from a towards b — obstacles usually sit near
 * one end, so a blocked segment is usually settled within the first few cells; stops — returning
 * true — as soon as `visit` does. */
function someBlockAlong(o: MachineObstacles, a: ObstaclePoint, b: ObstaclePoint, visit: (i: number) => boolean): boolean {
  o.stampId += 1;
  if (o.stampId > 2_000_000_000) {
    o.stamp.fill(0);
    o.stampId = 1;
  }
  const id = o.stampId;
  const cell = o.cell;
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const c0 = Math.floor(x0 / cell);
  const c1 = Math.floor(x1 / cell);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const stepX = dx < 0 ? -1 : 1;
  const stepY = dy < 0 ? -1 : 1;
  for (let cx = stepX > 0 ? c0 : c1; stepX > 0 ? cx <= c1 : cx >= c0; cx += stepX) {
    let ya = a.y;
    let yb = b.y;
    if (c0 !== c1 && dx !== 0) {
      ya = a.y + ((Math.max(x0, cx * cell) - a.x) * dy) / dx;
      yb = a.y + ((Math.min(x1, (cx + 1) * cell) - a.x) * dy) / dx;
    }
    const r0 = Math.floor((Math.min(ya, yb) - 1e-6) / cell);
    const r1 = Math.floor((Math.max(ya, yb) + 1e-6) / cell);
    for (let cy = stepY > 0 ? r0 : r1; stepY > 0 ? cy <= r1 : cy >= r0; cy += stepY) {
      const list = o.grid.get(cellKey(cx, cy));
      if (!list) continue;
      for (const i of list) {
        if (o.stamp[i] === id) continue;
        o.stamp[i] = id;
        if (visit(i)) return true;
      }
    }
  }
  return false;
}

/** Blocks registered in the grid cell holding p (every block whose padded box could contain it). */
function blocksAt(o: MachineObstacles, p: ObstaclePoint): number[] {
  return o.grid.get(cellKey(Math.floor(p.x / o.cell), Math.floor(p.y / o.cell))) ?? [];
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
  const rects: Rect[] = [];
  return !someBlockAlong(obstacles, a, b, (i) => {
    const r = obstacles.blocks[i];
    if (r[2] - inset <= minX || r[0] + inset >= maxX || r[3] - inset <= minY || r[1] + inset >= maxY) return false;
    rects.length = 0;
    obstaclesFor(a, b, obstacles, [i], rects, null, null);
    for (const rr of rects) if (segmentHitsRect(a, b, rr, inset)) return true;
    return false;
  });
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

/** Is the line through p with direction (dx, dy) tangent to r — all of r on one side of it? A path
 * only ever bends at a corner by wrapping around it, so any other edge at a corner node is never
 * part of a shortest path (reduced visibility graph). Always true for a node without a block. */
function tangentAt(r: Rect | null, p: ObstaclePoint, dx: number, dy: number): boolean {
  if (!r) return true;
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
}

/** The navigation graph for these walls and this clearance (rebuilt — and the path memo dropped —
 * only if either changes). */
function navFor(o: MachineObstacles, walls: WallGraph | null, clearance: number): NavGraph {
  if (o.nav && o.nav.walls === walls && o.nav.clearance === clearance) return o.nav;
  o.paths.clear();
  const pos: ObstaclePoint[] = [];
  const owner: (Rect | null)[] = [];
  o.blocks.forEach((r) => {
    pos.push({ x: r[0] - clearance, y: r[1] - clearance });
    pos.push({ x: r[2] + clearance, y: r[1] - clearance });
    pos.push({ x: r[2] + clearance, y: r[3] + clearance });
    pos.push({ x: r[0] - clearance, y: r[3] + clearance });
    owner.push(r, r, r, r);
  });
  walls?.nodes.forEach((p) => {
    pos.push(p);
    owner.push(null);
  });
  const reach = o.memberPad + o.inset;
  const containers = pos.map((p) =>
    blocksAt(o, p).filter((i) => {
      const r = o.blocks[i];
      return inside(p, [r[0] - reach, r[1] - reach, r[2] + reach, r[3] + reach], 0);
    }),
  );
  o.nav = {
    walls,
    clearance,
    pos,
    owner,
    containers,
    open: pos.map(() => null),
    openLen: pos.map(() => null),
    soft: pos.map(() => null),
  };
  return o.nav;
}

/** Works out (once) which stable nodes node u can walk straight to — see NavGraph.open/soft. */
function neighboursOf(o: MachineObstacles, nav: NavGraph, u: number) {
  if (nav.open[u]) return;
  const inset = o.inset;
  const pu = nav.pos[u];
  const open: number[] = [];
  const openLen: number[] = [];
  const soft: number[] = [];
  for (let v = 0; v < nav.pos.length; v += 1) {
    if (v === u) continue;
    const pv = nav.pos[v];
    const dx = pv.x - pu.x;
    const dy = pv.y - pu.y;
    if (!tangentAt(nav.owner[u], pu, dx, dy) || !tangentAt(nav.owner[v], pv, dx, dy)) continue;
    if (crossesWall(pu, pv, nav.walls)) continue;
    const blockers: number[] = [];
    someBlockAlong(o, pu, pv, (i) => {
      if (!segmentHitsRect(pu, pv, o.blocks[i], inset)) return false;
      blockers.push(i);
      return blockers.length > SOFT_BLOCKER_LIMIT;
    });
    if (blockers.length === 0) {
      open.push(v);
      openLen.push(Math.hypot(pu.x - pv.x, pu.y - pv.y));
    } else if (blockers.length <= SOFT_BLOCKER_LIMIT) soft.push(v, blockers.length, ...blockers);
  }
  nav.open[u] = Int32Array.from(open);
  nav.openLen[u] = Float64Array.from(openLen);
  nav.soft[u] = Int32Array.from(soft);
}

/** Min-heap of (estimate, node index) — ties go to the lower index. */
class NodeHeap {
  private est: number[] = [];
  private idx: number[] = [];

  get size() {
    return this.idx.length;
  }

  private less(i: number, j: number) {
    return this.est[i] < this.est[j] || (this.est[i] === this.est[j] && this.idx[i] < this.idx[j]);
  }

  private swap(i: number, j: number) {
    const e = this.est[i];
    this.est[i] = this.est[j];
    this.est[j] = e;
    const x = this.idx[i];
    this.idx[i] = this.idx[j];
    this.idx[j] = x;
  }

  push(e: number, i: number) {
    this.est.push(e);
    this.idx.push(i);
    let c = this.idx.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!this.less(c, p)) break;
      this.swap(c, p);
      c = p;
    }
  }

  /** Removes the top entry; returns its node index (its estimate is `topEst` before the call). */
  pop(): number {
    const top = this.idx[0];
    const lastE = this.est.pop()!;
    const lastI = this.idx.pop()!;
    if (this.idx.length > 0) {
      this.est[0] = lastE;
      this.idx[0] = lastI;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < this.idx.length && this.less(l, m)) m = l;
        if (r < this.idx.length && this.less(r, m)) m = r;
        if (m === c) break;
        this.swap(c, m);
        c = m;
      }
    }
    return top;
  }

  get topEst() {
    return this.est[0];
  }
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
  const nav = navFor(obstacles, wallGraph, clearancePx);
  const key = `${Math.round(a.x)},${Math.round(a.y)}>${Math.round(b.x)},${Math.round(b.y)}`;
  if (obstacles.paths.has(key)) {
    const cached = obstacles.paths.get(key)!;
    return cached ? [a, ...cached.slice(1, -1), b] : null;
  }

  let result: ObstaclePoint[] | null = null;
  const all = obstacles.blocks;
  const inset = obstacles.inset;
  const wallBase = all.length * 4;
  const localOf = new Int32Array(nav.pos.length).fill(-1);
  for (let margin = startMarginPx; margin <= startMarginPx * MAX_MARGIN_FACTOR; margin *= 2) {
    const minX = Math.min(a.x, b.x) - margin;
    const maxX = Math.max(a.x, b.x) + margin;
    const minY = Math.min(a.y, b.y) - margin;
    const maxY = Math.max(a.y, b.y) + margin;
    const localIdx: number[] = [];
    all.forEach((r, i) => {
      if (r[2] >= minX && r[0] <= maxX && r[3] >= minY && r[1] <= maxY) localIdx.push(i);
    });
    // mark: 0 = outside this search, 1 = whole block, 2 = split (an endpoint is inside it — walked
    // into, so only its other machines count; see obstaclesFor).
    const mark = new Uint8Array(all.length);
    const splitRects = new Map<number, Rect[]>();
    for (const i of localIdx) {
      const r = all[i];
      if (!inside(a, r, inset) && !inside(b, r, inset)) {
        mark[i] = 1;
        continue;
      }
      mark[i] = 2;
      const rects: Rect[] = [];
      obstaclesFor(a, b, obstacles, [i], rects, null, null);
      splitRects.set(i, rects);
    }
    // Every remaining machine of the split blocks: they reach a little past their block's box (see
    // memberRect), so even a leg the neighbour lists see as clear may still graze one.
    const splitAll: Rect[] = [];
    splitRects.forEach((rects) => splitAll.push(...rects));
    /** Is p clear of this search's obstacles (among the blocks listed in `near`)? */
    const pointFree = (p: ObstaclePoint, near: number[]) => {
      for (const i of near) {
        if (mark[i] === 1) {
          if (inside(p, all[i], 0)) return false;
        } else if (mark[i] === 2) {
          for (const mr of splitRects.get(i)!) if (inside(p, mr, 0)) return false;
        }
      }
      return true;
    };
    /** Can p and q see each other past this search's obstacles and the walls? (`fromQ`: look for
     * obstacles starting at q's end — only the order of the search, never the answer, changes.) */
    const sees = (p: ObstaclePoint, q: ObstaclePoint, fromQ = false) =>
      !someBlockAlong(obstacles, fromQ ? q : p, fromQ ? p : q, (i) => {
        if (mark[i] === 1) return segmentHitsRect(p, q, all[i], inset);
        if (mark[i] === 2) for (const mr of splitRects.get(i)!) if (segmentHitsRect(p, q, mr, inset)) return true;
        return false;
      }) && !crossesWall(p, q, wallGraph);

    // Nodes in a fixed order (it breaks ties between equally short ways): per local block its 4
    // corners — or, for a split block, those of each of its remaining machines — then the wall
    // ends. ids: stable node id; −1 for a, b and split-machine corners (`loose`, tested on the spot).
    const pts: ObstaclePoint[] = [a, b];
    const owner: (Rect | null)[] = [null, null];
    const ids: number[] = [-1, -1];
    const loose: number[] = [];
    for (const i of localIdx) {
      if (mark[i] === 1) {
        for (let k = 0; k < 4; k += 1) {
          const id = i * 4 + k;
          if (!pointFree(nav.pos[id], nav.containers[id])) continue;
          localOf[id] = pts.length;
          pts.push(nav.pos[id]);
          owner.push(all[i]);
          ids.push(id);
        }
        continue;
      }
      const c = clearancePx;
      for (const r of splitRects.get(i)!) {
        for (const p of [
          { x: r[0] - c, y: r[1] - c },
          { x: r[2] + c, y: r[1] - c },
          { x: r[2] + c, y: r[3] + c },
          { x: r[0] - c, y: r[3] + c },
        ]) {
          if (!pointFree(p, blocksAt(obstacles, p))) continue;
          loose.push(pts.length);
          pts.push(p);
          owner.push(r);
          ids.push(-1);
        }
      }
    }
    if (wallGraph) {
      wallGraph.nodes.forEach((p, wi) => {
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return;
        const id = wallBase + wi;
        if (!pointFree(p, nav.containers[id])) return;
        localOf[id] = pts.length;
        pts.push(p);
        owner.push(null);
        ids.push(id);
      });
    }

    // A* (straight-line distance to b as the heuristic). Stable nodes step along their precomputed
    // neighbour lists; only legs involving a, b or split-machine corners are tested on the spot.
    const n = pts.length;
    const toB = pts.map((p) => Math.hypot(p.x - b.x, p.y - b.y));
    const dist = new Float64Array(n).fill(Infinity);
    const est = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const heap = new NodeHeap();
    dist[0] = 0;
    est[0] = toB[0];
    heap.push(est[0], 0);
    let u = 0;
    // `known`: already known to be tangent and in sight (from the neighbour lists). Legs to/from a
    // or b are exempt from tangency: service points sit right at (inside the clearance of) their
    // machine, so the first/last leg runs along the block.
    const relax = (v: number, known: boolean) => {
      if (done[v] || v === u) return;
      const d = dist[u] + Math.hypot(pts[u].x - pts[v].x, pts[u].y - pts[v].y);
      if (d >= dist[v]) return;
      const e = d + toB[v];
      if (e >= dist[1]) return;
      if (known) {
        for (const r of splitAll) if (segmentHitsRect(pts[u], pts[v], r, inset)) return;
      } else {
        if (u >= 2 && v >= 2) {
          const dx = pts[v].x - pts[u].x;
          const dy = pts[v].y - pts[u].y;
          if (!tangentAt(owner[u], pts[u], dx, dy) || !tangentAt(owner[v], pts[v], dx, dy)) return;
        }
        // Towards b, obstacles are most likely right around b (the machine it's at).
        if (!sees(pts[u], pts[v], v === 1)) return;
      }
      dist[v] = d;
      est[v] = e;
      prev[v] = u;
      heap.push(e, v);
    };
    while (heap.size > 0) {
      const e = heap.topEst;
      const top = heap.pop();
      if (done[top] || e !== est[top]) continue; // stale entry
      if (top === 1) break;
      u = top;
      done[u] = 1;
      // b first: once a way to b is known, any node that can't beat it is skipped unchecked.
      relax(1, false);
      relax(0, false);
      const id = ids[u];
      if (id >= 0) {
        neighboursOf(obstacles, nav, id);
        // relax(v, true), inlined — this is the hot loop.
        const open = nav.open[id]!;
        const openLen = nav.openLen[id]!;
        const du = dist[u];
        for (let k = 0; k < open.length; k += 1) {
          const v = localOf[open[k]];
          if (v < 0 || done[v]) continue;
          const d = du + openLen[k];
          if (d >= dist[v]) continue;
          const e = d + toB[v];
          if (e >= dist[1]) continue;
          if (splitAll.length > 0 && splitAll.some((r) => segmentHitsRect(pts[u], pts[v], r, inset))) continue;
          dist[v] = d;
          est[v] = e;
          prev[v] = u;
          heap.push(e, v);
        }
        // Hidden only by blocks this search leaves out or walks into: in sight when none of them is
        // a whole block here; re-tested when one is walked into (its other machines still count).
        const soft = nav.soft[id]!;
        for (let s = 0; s < soft.length; s += 2 + soft[s + 1]) {
          const v = localOf[soft[s]];
          if (v < 0) continue;
          let whole = false;
          let split = false;
          for (let k = 0; k < soft[s + 1]; k += 1) {
            const m = mark[soft[s + 2 + k]];
            if (m === 1) whole = true;
            else if (m === 2) split = true;
          }
          if (!whole) relax(v, !split);
        }
        for (const v of loose) relax(v, false);
      } else {
        for (let v = 2; v < n; v += 1) relax(v, false);
      }
    }
    for (let v = 2; v < n; v += 1) if (ids[v] >= 0) localOf[ids[v]] = -1;
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
