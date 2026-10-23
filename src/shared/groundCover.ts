/**
 * STAGE 08-FIX — Client-side stylized ground cover (grass / small ferns / wild flowers)
 * for the 256×256 m `forest_square` map.
 *
 * Pure & deterministic (no THREE, no DOM). Uses its OWN seeded RNG streams derived from
 * `seed ^ GROUND_COVER_SALT`, so it never touches the vegetation RNG, `world.visuals`
 * or `world.gameplayHash`. It is a visual-only layer: never sent to / computed on the server.
 *
 * Output layout: per 16×16 m chunk, per kind, one packed `Float32Array` with
 * `GROUND_COVER_STRIDE` (= 5) floats per instance: `x, y, z, yaw, scale`.
 * Instances inside each (chunk, kind) batch are deterministically shuffled so that any
 * prefix is a uniform random subsample (used by the renderer for density presets).
 */
import {
  getForestSquarePoiSites,
  type ForestSquarePoiSiteSpec,
} from './structures/contracts';
import { sampleForestSquareRoad } from './forestSquareRoads';
import { sampleTerrainHeight, sampleTerrainNormal } from './terrain';
import type {
  ColliderBox,
  TerrainDescriptor,
  VisualDescriptor,
  WorldDefinition,
} from './world';

// Structural import only (avoids a runtime import cycle with forestSquare.ts).
import type { ForestSquareWorldDefinition } from './forestSquare';

// ---------------------------------------------------------------------------
// Public contract (Contract 3 — do NOT rename / reshape)
// ---------------------------------------------------------------------------

export type GroundCoverKind =
  | 'grass_tuft'
  | 'grass_short'
  | 'fern_small'
  | 'flower_white'
  | 'flower_yellow'
  | 'flower_purple';

export const GROUND_COVER_KINDS: readonly GroundCoverKind[] = [
  'grass_tuft',
  'grass_short',
  'fern_small',
  'flower_white',
  'flower_yellow',
  'flower_purple',
] as const;

/** Floats per instance: x, y, z, yaw, scale. */
export const GROUND_COVER_STRIDE = 5;
/** Chunk edge length in meters. */
export const GROUND_COVER_CHUNK_SIZE = 16;

export interface GroundCoverChunk {
  key: string; // `${cx},${cz}`
  cx: number;
  cz: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Lowest instance base Y in this chunk. */
  minY: number;
  /** Highest instance base Y + tallest possible plant height (`GROUND_COVER_MAX_PLANT_HEIGHT`). */
  maxY: number;
  // instances shuffled within chunk so any prefix is a uniform subsample (for density presets)
  batches: Partial<Record<GroundCoverKind, Float32Array>>;
}

export interface GroundCoverField {
  seed: number;
  chunkSize: number;
  chunks: GroundCoverChunk[];
  counts: Record<GroundCoverKind, number>;
  total: number;
}

export interface GroundCoverInput {
  seed: number;
  terrain: TerrainDescriptor;
  colliders: readonly ColliderBox[]; // world.colliders (hard footprint exclusion)
  visuals: readonly VisualDescriptor[]; // to find trees (fern under trees) & POI
  poiSites: ForestSquarePoiSiteSpec[];
  roadDistSampler: (x: number, z: number) => number;
  /**
   * OPTIONAL (additive, backwards compatible): open clearings that get denser grass and
   * more flower clusters. `buildForestSquareGroundCover` fills it from `world.locations`
   * (`kind === 'clearing'`).
   */
  clearings?: ReadonlyArray<{ x: number; z: number; radius: number }>;
  /**
   * OPTIONAL: Spawn points to keep completely clear of ground cover.
   */
  spawnPoints?: ReadonlyArray<{ x: number; z: number }>;
  /**
   * OPTIONAL: Loot containers to keep clear of ground cover.
   */
  containerLocations?: ReadonlyArray<{ x: number; z: number }>;
}

// ---------------------------------------------------------------------------
// Tunables / limits (exported for tests and the renderer)
// ---------------------------------------------------------------------------

/** XOR salt for the ground-cover RNG streams (independent of vegetation `seed ^ 0x4b01`). */
export const GROUND_COVER_SALT = 0x6c0ffee;
/** Instances never appear with |x| or |z| above this (playable area). */
export const GROUND_COVER_PLAYABLE_LIMIT = 124;
/** Road walking strip half-width measured from the road center line (no ground cover). */
export const GROUND_COVER_ROAD_STRIP = 1.1;
/** Flowers keep a little further away from the road center line. */
export const GROUND_COVER_FLOWER_ROAD_MIN = 1.35;
/** Max terrain slope (degrees) that may carry ground cover. */
export const GROUND_COVER_MAX_SLOPE_DEG = 38;
/** XZ padding around hard collider footprints. */
export const GROUND_COVER_COLLIDER_PAD = 0.15;
/** A collider "touches the ground" when `min.y < groundY + this`. */
export const GROUND_COVER_GROUND_TOUCH = 0.3;

/** Renderer base mesh heights (meters at scale 1) — agreed with GroundCoverRenderer. */
export const GROUND_COVER_BASE_HEIGHT: Readonly<Record<GroundCoverKind, number>> = {
  grass_tuft: 0.32,
  grass_short: 0.2,
  fern_small: 0.45,
  flower_white: 0.26,
  flower_yellow: 0.26,
  flower_purple: 0.26,
};

/** Hard scale caps (PvP fairness: grass ≤0.45 m, flowers ≤0.35 m, fern_small ≤0.6 m). */
export const GROUND_COVER_MAX_SCALE: Readonly<Record<GroundCoverKind, number>> = {
  grass_tuft: 1.4,
  grass_short: 1.4,
  fern_small: 1.3,
  flower_white: 1.3,
  flower_yellow: 1.3,
  flower_purple: 1.3,
};

/** Tallest possible instance height (fern 0.45 × 1.3 ≈ 0.585 m), used for chunk `maxY`. */
export const GROUND_COVER_MAX_PLANT_HEIGHT = 0.6;

export type GroundCoverCategory = 'grass' | 'flower' | 'fern';

export function groundCoverCategoryOf(kind: GroundCoverKind): GroundCoverCategory {
  if (kind === 'fern_small') return 'fern';
  if (kind === 'grass_tuft' || kind === 'grass_short') return 'grass';
  return 'flower';
}

export interface GroundCoverSummary {
  total: number;
  counts: Record<GroundCoverKind, number>;
  byCategory: Record<GroundCoverCategory, number>;
  flowerFraction: number;
  chunkCount: number;
  /** Bytes held by all instance Float32Arrays. */
  instanceBytes: number;
}

export function getGroundCoverSummary(field: GroundCoverField): GroundCoverSummary {
  const counts = emptyCounts();
  let instanceBytes = 0;
  for (const chunk of field.chunks) {
    for (const kind of GROUND_COVER_KINDS) {
      const arr = chunk.batches[kind];
      if (!arr) continue;
      counts[kind] += arr.length / GROUND_COVER_STRIDE;
      instanceBytes += arr.byteLength;
    }
  }
  const byCategory: Record<GroundCoverCategory, number> = { grass: 0, flower: 0, fern: 0 };
  let total = 0;
  for (const kind of GROUND_COVER_KINDS) {
    byCategory[groundCoverCategoryOf(kind)] += counts[kind];
    total += counts[kind];
  }
  return {
    total,
    counts,
    byCategory,
    flowerFraction: total > 0 ? byCategory.flower / total : 0,
    chunkCount: field.chunks.length,
    instanceBytes,
  };
}

// ---------------------------------------------------------------------------
// Deterministic hashing / RNG / value noise (private to this module)
// ---------------------------------------------------------------------------

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul((b + 0x632be59b) | 0, 0xc2b2ae35);
  h = (h ^ (h >>> 13)) | 0;
  h ^= Math.imul((c + 0x27d4eb2f) | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Mulberry32 (same algorithm as `createSeededRng`, but a private instance/stream). */
function makeRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INV_U32 = 1 / 4294967296;

function valueNoise(x: number, z: number, salt: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash3(ix, iz, salt) * INV_U32;
  const b = hash3(ix + 1, iz, salt) * INV_U32;
  const c = hash3(ix, iz + 1, salt) * INV_U32;
  const d = hash3(ix + 1, iz + 1, salt) * INV_U32;
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uz;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function emptyCounts(): Record<GroundCoverKind, number> {
  return {
    grass_tuft: 0,
    grass_short: 0,
    fern_small: 0,
    flower_white: 0,
    flower_yellow: 0,
    flower_purple: 0,
  };
}

// ---------------------------------------------------------------------------
// Spatial helpers (typed-array uniform grids)
// ---------------------------------------------------------------------------

const GRID_MIN = -128;
const GRID_SPAN = 256;

/** Uniform bucket grid of padded, ground-relevant collider AABBs (XZ). */
class ColliderFootprintGrid {
  private readonly cell = 2;
  private readonly dim = GRID_SPAN / 2;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly minX: Float64Array;
  private readonly maxX: Float64Array;
  private readonly minZ: Float64Array;
  private readonly maxZ: Float64Array;
  private readonly minY: Float64Array;
  private readonly maxY: Float64Array;

  constructor(colliders: readonly ColliderBox[], pad: number) {
    const sel: ColliderBox[] = [];
    for (const c of colliders) {
      if (c.tag === 'ground' || c.tag === 'boundary') continue;
      sel.push(c);
    }
    const n = sel.length;
    this.minX = new Float64Array(n);
    this.maxX = new Float64Array(n);
    this.minZ = new Float64Array(n);
    this.maxZ = new Float64Array(n);
    this.minY = new Float64Array(n);
    this.maxY = new Float64Array(n);
    const dim = this.dim;
    const counts = new Int32Array(dim * dim + 1);
    const ranges = new Int32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const c = sel[i]!;
      this.minX[i] = c.min.x - pad;
      this.maxX[i] = c.max.x + pad;
      this.minZ[i] = c.min.z - pad;
      this.maxZ[i] = c.max.z + pad;
      this.minY[i] = c.min.y;
      this.maxY[i] = c.max.y;
      const x0 = this.cellOf(this.minX[i]!);
      const x1 = this.cellOf(this.maxX[i]!);
      const z0 = this.cellOf(this.minZ[i]!);
      const z1 = this.cellOf(this.maxZ[i]!);
      ranges[i * 4] = x0;
      ranges[i * 4 + 1] = x1;
      ranges[i * 4 + 2] = z0;
      ranges[i * 4 + 3] = z1;
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) counts[gz * dim + gx + 1]!++;
      }
    }
    for (let i = 1; i < counts.length; i++) counts[i]! += counts[i - 1]!;
    this.start = counts;
    const fill = counts.slice(0, dim * dim);
    this.items = new Int32Array(counts[dim * dim]!);
    for (let i = 0; i < n; i++) {
      const x0 = ranges[i * 4]!;
      const x1 = ranges[i * 4 + 1]!;
      const z0 = ranges[i * 4 + 2]!;
      const z1 = ranges[i * 4 + 3]!;
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) this.items[fill[gz * dim + gx]!++] = i;
      }
    }
  }

  private cellOf(v: number): number {
    const g = Math.floor((v - GRID_MIN) / this.cell);
    return g < 0 ? 0 : g >= this.dim ? this.dim - 1 : g;
  }

  /** True when (x,z) lies in a padded footprint of a collider that touches ground level. */
  blocks(x: number, z: number, groundY: number): boolean {
    const ci = this.cellOf(z) * this.dim + this.cellOf(x);
    const s = this.start[ci]!;
    const e = this.start[ci + 1]!;
    const touchY = groundY + GROUND_COVER_GROUND_TOUCH;
    for (let k = s; k < e; k++) {
      const i = this.items[k]!;
      if (
        x >= this.minX[i]! &&
        x <= this.maxX[i]! &&
        z >= this.minZ[i]! &&
        z <= this.maxZ[i]! &&
        this.minY[i]! < touchY &&
        this.maxY[i]! > groundY - 0.25
      ) {
        return true;
      }
    }
    return false;
  }
}

interface TreePoint {
  x: number;
  z: number;
  r: number;
}

/** Uniform bucket grid of tree trunk points (4 m cells). */
class TreeGrid {
  private readonly cell = 4;
  private readonly dim = GRID_SPAN / 4;
  private readonly start: Int32Array;
  private readonly xs: Float64Array;
  private readonly zs: Float64Array;

  constructor(trees: readonly TreePoint[]) {
    const dim = this.dim;
    const counts = new Int32Array(dim * dim + 1);
    const cellIdx = new Int32Array(trees.length);
    for (let i = 0; i < trees.length; i++) {
      const ci = this.cellOf(trees[i]!.z) * dim + this.cellOf(trees[i]!.x);
      cellIdx[i] = ci;
      counts[ci + 1]!++;
    }
    for (let i = 1; i < counts.length; i++) counts[i]! += counts[i - 1]!;
    this.start = counts;
    const fill = counts.slice(0, dim * dim);
    this.xs = new Float64Array(trees.length);
    this.zs = new Float64Array(trees.length);
    for (let i = 0; i < trees.length; i++) {
      const slot = fill[cellIdx[i]!]!++;
      this.xs[slot] = trees[i]!.x;
      this.zs[slot] = trees[i]!.z;
    }
  }

  private cellOf(v: number): number {
    const g = Math.floor((v - GRID_MIN) / this.cell);
    return g < 0 ? 0 : g >= this.dim ? this.dim - 1 : g;
  }

  /**
   * Returns nearest trunk distance (capped at 8 m) and writes the number of trunks within
   * `shadeRadius` into `out[1]`.
   */
  query(x: number, z: number, shadeRadius: number, out: Float64Array): void {
    const gx = this.cellOf(x);
    const gz = this.cellOf(z);
    let best = 64; // 8 m squared cap
    let cnt = 0;
    const sr2 = shadeRadius * shadeRadius;
    for (let dz = -2; dz <= 2; dz++) {
      const cz = gz + dz;
      if (cz < 0 || cz >= this.dim) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const cx = gx + dx;
        if (cx < 0 || cx >= this.dim) continue;
        const ci = cz * this.dim + cx;
        for (let k = this.start[ci]!; k < this.start[ci + 1]!; k++) {
          const ddx = this.xs[k]! - x;
          const ddz = this.zs[k]! - z;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < best) best = d2;
          if (d2 < sr2) cnt++;
        }
      }
    }
    out[0] = Math.sqrt(best);
    out[1] = cnt;
  }
}

/** Coarse occupancy grid of flower cluster centers to keep clusters apart (no carpets). */
class PointSpacingGrid {
  private readonly cell: number;
  private readonly dim: number;
  private readonly buckets: Map<number, number[]> = new Map();

  constructor(cell: number) {
    this.cell = cell;
    this.dim = Math.ceil(GRID_SPAN / cell);
  }

  private key(gx: number, gz: number): number {
    return gz * this.dim + gx;
  }

  isFree(x: number, z: number, minDist: number): boolean {
    const gx = Math.floor((x - GRID_MIN) / this.cell);
    const gz = Math.floor((z - GRID_MIN) / this.cell);
    const r = Math.ceil(minDist / this.cell);
    const md2 = minDist * minDist;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const b = this.buckets.get(this.key(gx + dx, gz + dz));
        if (!b) continue;
        for (let i = 0; i < b.length; i += 2) {
          const ddx = b[i]! - x;
          const ddz = b[i + 1]! - z;
          if (ddx * ddx + ddz * ddz < md2) return false;
        }
      }
    }
    return true;
  }

  add(x: number, z: number): void {
    const k = this.key(
      Math.floor((x - GRID_MIN) / this.cell),
      Math.floor((z - GRID_MIN) / this.cell),
    );
    let b = this.buckets.get(k);
    if (!b) {
      b = [];
      this.buckets.set(k, b);
    }
    b.push(x, z);
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

const KIND_INDEX: Record<GroundCoverKind, number> = {
  grass_tuft: 0,
  grass_short: 1,
  fern_small: 2,
  flower_white: 3,
  flower_yellow: 4,
  flower_purple: 5,
};
const FLOWER_KINDS: readonly GroundCoverKind[] = ['flower_white', 'flower_yellow', 'flower_purple'];
const TWO_PI = Math.PI * 2;
const COS_MAX_SLOPE = Math.cos((GROUND_COVER_MAX_SLOPE_DEG * Math.PI) / 180);

/** Default total instance budget (densityScale = 1); the grass pass is calibrated per seed. */
export const GROUND_COVER_TARGET_TOTAL = 19400;
/** Candidate density for the dry calibration pass; `GRASS_MAX_...` caps the real pass. */
const GRASS_MAX_CANDIDATES_PER_M2 = 1.3;
const GRASS_CALIBRATION_CANDIDATES_PER_M2 = 0.28;
/** Target flower share of the final total. */
const FLOWER_TARGET_FRACTION = 0.08;

const CHUNK_DIM = GRID_SPAN / GROUND_COVER_CHUNK_SIZE; // 16 × 16 chunks

export function buildGroundCoverField(
  input: GroundCoverInput,
  opts?: { densityScale?: number },
): GroundCoverField {
  const densityScale = Math.max(0, opts?.densityScale ?? 1);
  const seed = input.seed | 0;
  const baseSeed = (seed ^ GROUND_COVER_SALT) | 0;
  const { terrain, roadDistSampler, poiSites } = input;
  const clearings = input.clearings ?? [];
  const LIMIT = GROUND_COVER_PLAYABLE_LIMIT;

  const footprints = new ColliderFootprintGrid(input.colliders, GROUND_COVER_COLLIDER_PAD);

  // Trees inside the playable area (vista trees outside ±124 are ignored).
  const trees: TreePoint[] = [];
  for (const v of input.visuals) {
    if (v.category !== 'tree') continue;
    const p = v.transform.position;
    if (Math.abs(p.x) > LIMIT || Math.abs(p.z) > LIMIT) continue;
    trees.push({ x: p.x, z: p.z, r: 0.4 * Math.max(0.5, v.transform.scale.x) });
  }
  const treeGrid = new TreeGrid(trees);
  const tq = new Float64Array(2);

  // Outdoor POI props (tents etc.): nothing grows inside their rotated visual footprint,
  // even where hard colliders only cover the walls (e.g. the open tent interior).
  const propBoxes: Array<{ x: number; z: number; c: number; s: number; hx: number; hz: number; r2: number }> = [];
  for (const v of input.visuals) {
    if (!v.boxDims || !v.batchKey.startsWith('outdoor:')) continue;
    const hx = (v.boxDims.x * v.transform.scale.x) / 2 + 0.1;
    const hz = (v.boxDims.z * v.transform.scale.z) / 2 + 0.1;
    propBoxes.push({
      x: v.transform.position.x,
      z: v.transform.position.z,
      c: Math.cos(v.transform.yaw),
      s: Math.sin(v.transform.yaw),
      hx,
      hz,
      r2: hx * hx + hz * hz,
    });
  }
  const insidePropBox = (x: number, z: number): boolean => {
    for (let i = 0; i < propBoxes.length; i++) {
      const b = propBoxes[i]!;
      const dx = x - b.x;
      const dz = z - b.z;
      if (dx * dx + dz * dz > b.r2) continue;
      // World → local (three.js Y rotation: wx = lx·c + lz·s, wz = −lx·s + lz·c).
      const lx = dx * b.c - dz * b.s;
      const lz = dx * b.s + dz * b.c;
      if (Math.abs(lx) <= b.hx && Math.abs(lz) <= b.hz) return true;
    }
    return false;
  };

  // Doorway, spawn point, and container clear zones to guarantee unobstructed gameplay
  const clearZones: Array<{ x: number; z: number; r2: number }> = [];
  for (const v of input.visuals) {
    if (
      v.prefabId.includes('wood_door_01') ||
      v.prefabId.includes('wood_wall_door_01') ||
      v.batchKey.includes('wood_door_01') ||
      v.batchKey.includes('wood_wall_door_01')
    ) {
      clearZones.push({
        x: v.transform.position.x,
        z: v.transform.position.z,
        r2: 1.35 * 1.35,
      });
    }
  }
  if (input.spawnPoints) {
    for (const sp of input.spawnPoints) {
      clearZones.push({ x: sp.x, z: sp.z, r2: 1.2 * 1.2 });
    }
  }
  if (input.containerLocations) {
    for (const c of input.containerLocations) {
      clearZones.push({ x: c.x, z: c.z, r2: 1.2 * 1.2 });
    }
  }
  const insideClearZone = (x: number, z: number): boolean => {
    for (let i = 0; i < clearZones.length; i++) {
      const cz = clearZones[i]!;
      const dx = x - cz.x;
      const dz = z - cz.z;
      if (dx * dx + dz * dz < cz.r2) return true;
    }
    return false;
  };

  // Per-chunk, per-kind growable buffers.
  const buffers: number[][] = new Array(CHUNK_DIM * CHUNK_DIM * GROUND_COVER_KINDS.length);
  for (let i = 0; i < buffers.length; i++) buffers[i] = [];
  const counts = emptyCounts();

  const salts = {
    patchLo: hash3(baseSeed, 11, 1),
    patchHi: hash3(baseSeed, 12, 2),
    sunny: hash3(baseSeed, 13, 3),
  };

  /** Patchy low-frequency lushness in [0, 1]. */
  const lushness = (x: number, z: number): number => {
    const lo = valueNoise(x / 27 + 0.37, z / 27 + 0.71, salts.patchLo);
    const hi = valueNoise(x / 8.5, z / 8.5, salts.patchHi);
    return smoothstep(0.22, 0.78, lo * 0.68 + hi * 0.32);
  };

  const openAreaBoost = (x: number, z: number): { clearing: number; yard: number } => {
    let clearing = 0;
    for (const c of clearings) {
      const d = Math.hypot(x - c.x, z - c.z);
      const t = 1 - smoothstep(c.radius * 0.55, c.radius * 1.25, d);
      if (t > clearing) clearing = t;
    }
    let yard = 0;
    for (const s of poiSites) {
      const d = Math.hypot(x - s.center.x, z - s.center.z);
      const t = 1 - smoothstep(s.flatRadius - 3, s.flatRadius + 7, d);
      if (t > yard) yard = t;
    }
    const dEast = Math.hypot(x - 64, z - 4);
    const tEast = 1 - smoothstep(18 * 0.50, 18 * 1.20, dEast);
    if (tEast > clearing) clearing = tEast;
    return { clearing, yard };
  };

  /**
   * Returns ground Y if (x,z) may carry ground cover, otherwise NaN.
   * `roadDist` may be passed when already known (NaN → sample).
   */
  const placeable = (x: number, z: number, roadMin: number, roadDist: number): number => {
    if (x < -LIMIT || x > LIMIT || z < -LIMIT || z > LIMIT) return NaN;
    const rd = Number.isNaN(roadDist) ? roadDistSampler(x, z) : roadDist;
    if (rd < roadMin) return NaN;
    const n = sampleTerrainNormal(terrain, x, z);
    if (n.y < COS_MAX_SLOPE) return NaN;
    const y = sampleTerrainHeight(terrain, x, z);
    if (footprints.blocks(x, z, y)) return NaN;
    if (propBoxes.length > 0 && insidePropBox(x, z)) return NaN;
    if (clearZones.length > 0 && insideClearZone(x, z)) return NaN;
    return y;
  };

  const emit = (kind: GroundCoverKind, x: number, y: number, z: number, yaw: number, scale: number) => {
    const cx = Math.min(CHUNK_DIM - 1, Math.max(0, Math.floor((x - GRID_MIN) / GROUND_COVER_CHUNK_SIZE)));
    const cz = Math.min(CHUNK_DIM - 1, Math.max(0, Math.floor((z - GRID_MIN) / GROUND_COVER_CHUNK_SIZE)));
    const s = Math.min(scale, GROUND_COVER_MAX_SCALE[kind]);
    const buf = buffers[(cz * CHUNK_DIM + cx) * GROUND_COVER_KINDS.length + KIND_INDEX[kind]]!;
    buf.push(x, y, z, yaw, s);
    counts[kind]++;
  };

  // ---------------- 1. Small ferns around tree trunks ----------------
  {
    const rng = makeRng(hash3(baseSeed, 0xfe2, 0x7ee));
    const keep = Math.min(1, densityScale);
    for (const tr of trees) {
      const groupRoll = rng();
      const groups = groupRoll < 0.28 ? 0 : groupRoll < 0.82 ? 1 : 2;
      for (let g = 0; g < groups; g++) {
        const baseAng = rng() * TWO_PI;
        const n = 1 + Math.floor(rng() * 3.5); // 1..4
        for (let k = 0; k < n; k++) {
          const a = baseAng + (rng() - 0.5) * 1.2;
          const d = tr.r + 0.35 + rng() * 2.3;
          const yaw = rng() * TWO_PI;
          const sr = rng();
          const keepRoll = rng();
          if (keepRoll >= keep) continue;
          const x = tr.x + Math.cos(a) * d;
          const z = tr.z + Math.sin(a) * d;
          const y = placeable(x, z, GROUND_COVER_ROAD_STRIP, NaN);
          if (Number.isNaN(y)) continue;
          emit('fern_small', x, y, z, yaw, 0.72 + 0.5 * sr);
        }
      }
    }
  }

  // ---------------- 2. Grass clumps (+ scattered shade ferns), calibrated to target ----------------
  /**
   * Runs the per-chunk grass pass with `candPerM2` clump candidates per m².
   * `dry === true` only counts what would be emitted (used for per-seed calibration so
   * the total stays near `GROUND_COVER_TARGET_TOTAL` on every seed).
   */
  const runGrassPass = (candPerM2: number, dry: boolean): number => {
    let produced = 0;
    const candidatesPerChunk = Math.round(GROUND_COVER_CHUNK_SIZE * GROUND_COVER_CHUNK_SIZE * candPerM2);
    for (let cz = 0; cz < CHUNK_DIM; cz++) {
      for (let cx = 0; cx < CHUNK_DIM; cx++) {
        const x0 = GRID_MIN + cx * GROUND_COVER_CHUNK_SIZE;
        const z0 = GRID_MIN + cz * GROUND_COVER_CHUNK_SIZE;
        if (
          x0 >= LIMIT ||
          z0 >= LIMIT ||
          x0 + GROUND_COVER_CHUNK_SIZE <= -LIMIT ||
          z0 + GROUND_COVER_CHUNK_SIZE <= -LIMIT
        ) {
          continue;
        }
        const rng = makeRng(hash3(baseSeed, cx + 101, cz + 307));
        for (let i = 0; i < candidatesPerChunk; i++) {
          const subIdx = i % 64;
          const subX = subIdx % 8;
          const subZ = Math.floor(subIdx / 8);
          const x = x0 + (subX + rng()) * (GROUND_COVER_CHUNK_SIZE / 8);
          const z = z0 + (subZ + rng()) * (GROUND_COVER_CHUNK_SIZE / 8);
          const accept = rng();
          const kindRoll = rng();
          const sizeRoll = rng();
          if (x < -LIMIT || x > LIMIT || z < -LIMIT || z > LIMIT) continue;
          const rd = roadDistSampler(x, z);
          if (rd < GROUND_COVER_ROAD_STRIP) continue;

          // Prune wasteful instances in distant boundary mountain crags (|x|, |z| > 88)
          const distBorder = Math.max(Math.abs(x), Math.abs(z));
          const borderTaper = 1 - 0.70 * smoothstep(88, 120, distBorder);
          const lush = lushness(x, z);
          treeGrid.query(x, z, 4.2, tq);
          const { clearing, yard } = openAreaBoost(x, z);
          const glade = smoothstep(2.2, 6.0, tq[0]!);
          const open = Math.max(clearing, yard);
          const shade = Math.min(1, tq[1]! / 3.5) * (1 - 0.65 * open);
          // Road: no cover on the walking strip, thin on the dirt, lush verge 1.2–5 m.
          const roadMul = 0.40 + 0.60 * smoothstep(GROUND_COVER_ROAD_STRIP, 2.2, rd);
          const verge = 1 - smoothstep(0, 1.1, Math.abs(rd - 2.8) - 0.9);

          // Patchy: lush meadows vs. sparse forest floor (never fully bare: floor 0.14).
          // Walkable open ground (glades, POI yards, road verges) gets the most.
          let density = (0.26 + 0.74 * (0.35 * lush + 0.65 * lush * lush)) * (1 - 0.45 * shade);
          density += 0.55 * clearing + 0.45 * yard + 0.38 * verge + 0.32 * glade;
          density = Math.min(1.35, density) * roadMul * borderTaper;
          if (accept * 1.35 >= density) continue;

          // Shady forest floor: some clumps become small ferns instead of grass.
          if (kindRoll < 0.14 * shade * (1 - clearing)) {
            const y = placeable(x, z, GROUND_COVER_ROAD_STRIP, rd);
            if (!Number.isNaN(y)) {
              produced++;
              if (!dry) emit('fern_small', x, y, z, rng() * TWO_PI, 0.7 + 0.5 * sizeRoll);
            }
            continue;
          }

          const sunny = valueNoise(x / 19, z / 19, salts.sunny);
          const pTuft = Math.min(0.85, 0.25 + 0.38 * sunny + 0.22 * (1 - shade) + 0.15 * verge);
          const clumpKind: GroundCoverKind = kindRoll < pTuft ? 'grass_tuft' : 'grass_short';
          const isLushMeadow = (glade > 0.25 || open > 0.20 || lush > 0.48 || verge > 0.30) && shade < 0.55;
          const tufts = isLushMeadow
            ? 2 + Math.floor(rng() * 4) // Zone 1: Denser clusters of lush meadow grasses (2..5 stems)
            : 1 + Math.floor(rng() * (1.8 + 2.6 * Math.max(lush, open, verge * 0.7))); // 1..4 stems
          for (let t = 0; t < tufts; t++) {
            let tx = x;
            let tz = z;
            let trd = rd;
            if (t > 0) {
              const a = rng() * TWO_PI;
              const d = 0.10 + rng() * 0.46;
              tx = x + Math.cos(a) * d;
              tz = z + Math.sin(a) * d;
              trd = NaN;
            }
            const flip = rng() < 0.20;
            const kind: GroundCoverKind = flip
              ? clumpKind === 'grass_tuft'
                ? 'grass_short'
                : 'grass_tuft'
              : clumpKind;
            const yaw = rng() * TWO_PI;
            const sr = rng();
            const y = placeable(tx, tz, GROUND_COVER_ROAD_STRIP, trd);
            if (Number.isNaN(y)) continue;
            produced++;
            if (dry) continue;
            const scale =
              kind === 'grass_tuft'
                ? 0.82 + 0.46 * sr * (0.65 + 0.35 * lush) + 0.08 * verge
                : 0.74 + 0.50 * sr;
            emit(kind, tx, y, tz, yaw, scale);
          }
        }
      }
    }
    return produced;
  };

  {
    const treeFerns = counts.fern_small;
    const grassTarget = Math.max(
      0,
      GROUND_COVER_TARGET_TOTAL * densityScale * (1 - FLOWER_TARGET_FRACTION) - treeFerns,
    );
    if (grassTarget > 0) {
      const probe = runGrassPass(GRASS_CALIBRATION_CANDIDATES_PER_M2, true);
      const cand = probe > 0 ? (GRASS_CALIBRATION_CANDIDATES_PER_M2 * grassTarget) / probe : 0;
      runGrassPass(Math.min(cand, GRASS_MAX_CANDIDATES_PER_M2), false);
    }
  }

  // ---------------- 3. Wild flower clusters (3 colors, 3–9 per cluster) ----------------
  {
    const nonFlower = counts.grass_tuft + counts.grass_short + counts.fern_small;
    const target = Math.round((nonFlower * FLOWER_TARGET_FRACTION) / (1 - FLOWER_TARGET_FRACTION));
    const rng = makeRng(hash3(baseSeed, 0xf10, 0x3e5));
    const spacing = new PointSpacingGrid(3.5);
    // Balanced color rotation (deterministic per seed), so all 3 colors stay well represented.
    const colorOrder = [0, 1, 2];
    for (let i = 2; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = colorOrder[i]!;
      colorOrder[i] = colorOrder[j]!;
      colorOrder[j] = tmp;
    }
    let flowers = 0;
    let clusterIdx = 0;
    const maxCandidates = 60000;
    for (let c = 0; c < maxCandidates && flowers < target; c++) {
      const x = (rng() * 2 - 1) * (LIMIT - 1);
      const z = (rng() * 2 - 1) * (LIMIT - 1);
      const accept = rng();
      const rd = roadDistSampler(x, z);
      if (rd < GROUND_COVER_FLOWER_ROAD_MIN + 0.15) continue;

      const distBorder = Math.max(Math.abs(x), Math.abs(z));
      const borderTaper = 1 - 0.70 * smoothstep(88, 120, distBorder);
      treeGrid.query(x, z, 4.2, tq);
      const glade = smoothstep(2.5, 6.5, tq[0]!);
      const roadEdge = rd >= 1.5 && rd <= 4.2 ? 1 : 0;
      const { clearing, yard } = openAreaBoost(x, z);
      const forestOpening = (glade > 0.25 && tq[1]! <= 2) ? 0.65 : 0;
      const habitat = Math.max(glade * 0.85, roadEdge * 0.9, yard * 0.85, clearing * 1.20, forestOpening);
      const score = habitat * (0.35 + 0.65 * lushness(x, z)) * borderTaper;
      if (accept >= score * 0.60) continue;
      if (!spacing.isFree(x, z, 3.0)) continue;
      if (Number.isNaN(placeable(x, z, GROUND_COVER_FLOWER_ROAD_MIN, rd))) continue;
      spacing.add(x, z);

      const mainColor = colorOrder[clusterIdx % 3]!;
      clusterIdx++;
      const n = 4 + Math.floor(rng() * 5); // 4..8 blossoms huddled in organic bouquet
      const radius = 0.32 + rng() * 0.48;
      for (let k = 0; k < n; k++) {
        const a = rng() * TWO_PI;
        const d = Math.sqrt(rng()) * radius;
        const colorRoll = rng();
        const yaw = rng() * TWO_PI;
        const sr = rng();
        const fx = k === 0 ? x : x + Math.cos(a) * d;
        const fz = k === 0 ? z : z + Math.sin(a) * d;
        const y = placeable(fx, fz, GROUND_COVER_FLOWER_ROAD_MIN, NaN);
        if (Number.isNaN(y)) continue;
        const color = colorRoll < 0.86 ? mainColor : (mainColor + 1 + (colorRoll < 0.93 ? 0 : 1)) % 3;
        emit(FLOWER_KINDS[color]!, fx, y, fz, yaw, 0.82 + 0.40 * sr);
        flowers++;
      }
    }
  }

  // ---------------- 4. Pack chunks (deterministic in-chunk shuffle) ----------------
  const chunks: GroundCoverChunk[] = [];
  const nk = GROUND_COVER_KINDS.length;
  for (let cz = 0; cz < CHUNK_DIM; cz++) {
    for (let cx = 0; cx < CHUNK_DIM; cx++) {
      const ci = cz * CHUNK_DIM + cx;
      let any = false;
      let minY = Infinity;
      let maxY = -Infinity;
      const batches: Partial<Record<GroundCoverKind, Float32Array>> = {};
      for (let k = 0; k < nk; k++) {
        const buf = buffers[ci * nk + k]!;
        if (buf.length === 0) continue;
        any = true;
        const n = buf.length / GROUND_COVER_STRIDE;
        const order = new Uint32Array(n);
        for (let i = 0; i < n; i++) order[i] = i;
        const srng = makeRng(hash3(baseSeed ^ 0x5a17, ci, k + 1));
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(srng() * (i + 1));
          const tmp = order[i]!;
          order[i] = order[j]!;
          order[j] = tmp;
        }
        const arr = new Float32Array(buf.length);
        for (let i = 0; i < n; i++) {
          const src = order[i]! * GROUND_COVER_STRIDE;
          const dst = i * GROUND_COVER_STRIDE;
          arr[dst] = buf[src]!;
          arr[dst + 1] = buf[src + 1]!;
          arr[dst + 2] = buf[src + 2]!;
          arr[dst + 3] = buf[src + 3]!;
          arr[dst + 4] = buf[src + 4]!;
          const y = buf[src + 1]!;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        batches[GROUND_COVER_KINDS[k]!] = arr;
      }
      if (!any) continue;
      const gx = cx + Math.floor(GRID_MIN / GROUND_COVER_CHUNK_SIZE);
      const gz = cz + Math.floor(GRID_MIN / GROUND_COVER_CHUNK_SIZE);
      chunks.push({
        key: `${gx},${gz}`,
        cx: gx,
        cz: gz,
        minX: gx * GROUND_COVER_CHUNK_SIZE,
        minZ: gz * GROUND_COVER_CHUNK_SIZE,
        maxX: (gx + 1) * GROUND_COVER_CHUNK_SIZE,
        maxZ: (gz + 1) * GROUND_COVER_CHUNK_SIZE,
        minY,
        maxY: maxY + GROUND_COVER_MAX_PLANT_HEIGHT,
        batches,
      });
    }
  }

  let total = 0;
  for (const kind of GROUND_COVER_KINDS) total += counts[kind];

  return {
    seed,
    chunkSize: GROUND_COVER_CHUNK_SIZE,
    chunks,
    counts,
    total,
  };
}

// ---------------------------------------------------------------------------
// forest_square convenience entry (cached by seed + gameplayHash)
// ---------------------------------------------------------------------------

const groundCoverCache = new Map<string, GroundCoverField>();

/** Builds the `GroundCoverInput` for a `forest_square` world (exported for tests/tools). */
export function getForestSquareGroundCoverInput(
  world: ForestSquareWorldDefinition | WorldDefinition,
): GroundCoverInput {
  const seed = world.publicLayoutSeed;
  return {
    seed,
    terrain: world.terrain,
    colliders: world.colliders,
    visuals: world.visuals,
    poiSites: getForestSquarePoiSites(seed),
    roadDistSampler: (x, z) => sampleForestSquareRoad(x, z, seed).dist,
    clearings: world.locations
      .filter((l) => l.kind === 'clearing')
      .map((l) => ({ x: l.position.x, z: l.position.z, radius: l.radius })),
    spawnPoints: (world as ForestSquareWorldDefinition).spawnPoints
      ? (world as ForestSquareWorldDefinition).spawnPoints.map((s) => ({ x: s.x, z: s.z }))
      : undefined,
    containerLocations: (world as ForestSquareWorldDefinition).containerLocations
      ? (world as ForestSquareWorldDefinition).containerLocations.map((c) => ({ x: c.position.x, z: c.position.z }))
      : undefined,
  };
}

export function buildForestSquareGroundCover(world: ForestSquareWorldDefinition): GroundCoverField {
  const key = `${world.publicLayoutSeed}:${world.gameplayHash}`;
  const cached = groundCoverCache.get(key);
  if (cached) return cached;
  const field = buildGroundCoverField(getForestSquareGroundCoverInput(world));
  if (groundCoverCache.size >= 4) {
    const oldest = groundCoverCache.keys().next().value;
    if (oldest !== undefined) groundCoverCache.delete(oldest);
  }
  groundCoverCache.set(key, field);
  return field;
}
