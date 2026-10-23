import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../shared/constants';
import type { Vec3 } from '../shared/math';
import { boxOverlap, collidesAtWorld } from '../shared/physics';
import { getWorldSpatialIndex } from '../shared/spatialIndex';
import {
  DEFAULT_WORLD,
  isTerrainWalkable,
  sampleTerrainHeight,
  type WorldDefinition,
} from '../shared/world';

const NODE_CLEAR_R = PLAYER_RADIUS + 0.2;
const MAX_NAV_CACHE_SIZE = 16;

class MinHeap {
  private f: number[] = [];
  private n: number[] = [];
  get size() { return this.n.length; }
  push(node: number, score: number) {
    this.f.push(score);
    this.n.push(node);
    let i = this.n.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.n[0];
    const lastF = this.f.pop()!;
    const lastN = this.n.pop()!;
    if (this.n.length > 0) {
      this.f[0] = lastF;
      this.n[0] = lastN;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n.length && this.f[l] < this.f[m]) m = l;
        if (r < this.n.length && this.f[r] < this.f[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.f[a], this.f[b]] = [this.f[b], this.f[a]];
    [this.n[a], this.n[b]] = [this.n[b], this.n[a]];
  }
}

/** Botlar uchun yer sathidagi yurish mumkin bo'lgan to'r (grid) + A* yo'l topish. */
export class NavGraph {
  readonly nx: number;
  readonly nz: number;
  private readonly cell: number;
  private readonly ox: number;
  private readonly oz: number;
  private readonly valid: Uint8Array;
  private readonly neighbors: number[][];
  readonly validList: number[] = [];

  constructor(private readonly world: WorldDefinition = DEFAULT_WORLD) {
    const b = this.world.bounds;
    this.cell = b.maxX - b.minX > 160 ? 4 : 2;
    this.nx = Math.floor((b.maxX - b.minX) / this.cell);
    this.nz = Math.floor((b.maxZ - b.minZ) / this.cell);
    this.ox = b.minX + this.cell / 2;
    this.oz = b.minZ + this.cell / 2;
    const n = this.nx * this.nz;
    this.valid = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.center(i);
      const walkable = isTerrainWalkable(this.world.terrain, c.x, c.z);
      const ok =
        walkable &&
        !collidesAtWorld(this.world, c.x, c.y + 0.05, c.z, NODE_CLEAR_R, PLAYER_HEIGHT - 0.1);
      this.valid[i] = ok ? 1 : 0;
      if (ok) this.validList.push(i);
    }
    this.neighbors = new Array(n);
    for (let i = 0; i < n; i++) {
      this.neighbors[i] = [];
      if (!this.valid[i]) continue;
      const ix = i % this.nx;
      const iz = Math.floor(i / this.nx);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const jx = ix + dx;
          const jz = iz + dz;
          if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
          const j = jz * this.nx + jx;
          if (!this.valid[j]) continue;
          if (dx && dz && (!this.valid[iz * this.nx + jx] || !this.valid[jz * this.nx + ix])) continue;
          if (this.segmentClear(this.center(i), this.center(j))) this.neighbors[i].push(j);
        }
      }
    }
  }

  center(i: number): Vec3 {
    const ix = i % this.nx;
    const iz = Math.floor(i / this.nx);
    const x = this.ox + ix * this.cell;
    const z = this.oz + iz * this.cell;
    const y = sampleTerrainHeight(this.world.terrain, x, z);
    return { x, y, z };
  }

  segmentClear(a: Vec3, b: Vec3, r = PLAYER_RADIUS + 0.1): boolean {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(d / 0.3));
    const h = PLAYER_HEIGHT - 0.1;
    const world = this.world;
    const bounds = world.bounds;
    // One broadphase query for the whole segment (XZ superset of every per-sample query, any height), then
    // exact `boxOverlap` per sample — identical result to calling `collidesAtWorld` per sample, but far
    // cheaper now that forest_square also carries hard prop (log/stump) colliders.
    const candidates = getWorldSpatialIndex(world).queryAABB(
      Math.min(a.x, b.x) - r,
      Math.min(a.z, b.z) - r,
      Math.max(a.x, b.x) + r,
      Math.max(a.z, b.z) + r,
    );
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      if (!isTerrainWalkable(world.terrain, x, z)) return false;
      const y = sampleTerrainHeight(world.terrain, x, z);
      const py = y + 0.05;
      if (
        x - r < bounds.minX ||
        x + r > bounds.maxX ||
        z - r < bounds.minZ ||
        z + r > bounds.maxZ
      ) {
        return false;
      }
      for (const box of candidates) {
        if (boxOverlap(x, py, z, r, h, box)) return false;
      }
    }
    return true;
  }

  nearest(p: Vec3): number {
    const cx = Math.round((p.x - this.ox) / this.cell);
    const cz = Math.round((p.z - this.oz) / this.cell);
    const cands: { i: number; d: number }[] = [];
    for (let r = 0; r <= 4 && cands.length < 6; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= this.nx || z >= this.nz) continue;
          const i = z * this.nx + x;
          if (!this.valid[i]) continue;
          const c = this.center(i);
          cands.push({ i, d: Math.hypot(c.x - p.x, c.z - p.z) });
        }
      }
    }
    if (!cands.length) return -1;
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands) if (this.segmentClear(p, this.center(c.i), PLAYER_RADIUS * 0.8)) return c.i;
    return cands[0].i;
  }

  randomPoint(): Vec3 {
    return this.center(this.validList[Math.floor(Math.random() * this.validList.length)]);
  }

  findPath(from: Vec3, to: Vec3): Vec3[] {
    const s = this.nearest(from);
    const g = this.nearest(to);
    if (s < 0 || g < 0) return [];
    if (s === g) return [this.center(g)];
    const n = this.valid.length;
    const gScore = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const gc = this.center(g);
    const h = (i: number) => {
      const c = this.center(i);
      return Math.hypot(c.x - gc.x, c.z - gc.z);
    };
    const heap = new MinHeap();
    gScore[s] = 0;
    heap.push(s, h(s));
    let found = false;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === g) {
        found = true;
        break;
      }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = this.center(cur);
      for (const nb of this.neighbors[cur]) {
        if (closed[nb]) continue;
        const nc = this.center(nb);
        const tentative = gScore[cur] + Math.hypot(nc.x - cc.x, nc.z - cc.z);
        if (tentative < gScore[nb]) {
          gScore[nb] = tentative;
          came[nb] = cur;
          heap.push(nb, tentative + h(nb));
        }
      }
    }
    if (!found) return [];
    const nodes: number[] = [];
    for (let c = g; c !== -1; c = came[c]) nodes.push(c);
    nodes.reverse();
    // Yo'lni silliqlash (string pulling)
    const pts = nodes.map((i) => this.center(i));
    const out: Vec3[] = [];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 8);
      while (j > i + 1 && !this.segmentClear(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
}

const navCache = new Map<string, NavGraph>();
export function getNav(world: WorldDefinition = DEFAULT_WORLD): NavGraph {
  const key = `${world.mapId}:${world.worldVersion}:${world.publicLayoutSeed}:${world.gameplayHash}`;
  let nav = navCache.get(key);
  if (!nav) {
    nav = new NavGraph(world);
    if (navCache.size >= MAX_NAV_CACHE_SIZE) {
      const oldestKey = navCache.keys().next().value;
      if (oldestKey !== undefined) {
        navCache.delete(oldestKey);
      }
    }
    navCache.set(key, nav);
  }
  return nav;
}
