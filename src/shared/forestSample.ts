import type { Team } from './constants';
import { clamp, type Vec3 } from './math';
import {
  createGroundedRockCollider,
  createGroundedTreeCollider,
  DEFAULT_MAX_WALKABLE_SLOPE_DEG,
  getGroundedPosition,
  isTerrainWalkable,
  sampleTerrainHeight,
  sampleTerrainSlopeDeg,
} from './terrain';
import {
  buildStage04APreviewLayout,
  type Stage04APreviewLayoutOptions,
} from './structures/layoutBuilder';
import type { Stage04APreviewLayout } from './structures/contracts';
import {
  compilePrefabPlacement,
  computeGameplayHash,
  createSeededRng,
  CURRENT_WORLD_VERSION,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_PUBLIC_LAYOUT_SEED,
  getChunkCoord,
  type ColliderBox,
  type ContainerLocation,
  type HeightfieldTerrainDescriptor,
  type LocalBoxPart,
  type PrefabPlacement,
  type SpawnPointDef,
  type VisualDescriptor,
  type WorldBounds,
  type WorldDefinition,
  type WorldLocation,
} from './world';

const q3 = (n: number): number => Math.round(n * 1000) / 1000;

export const FOREST_SAMPLE_SIZE = 96;
export const FOREST_SAMPLE_HALF = FOREST_SAMPLE_SIZE / 2; // 48

export type TreeSpeciesBatchKey =
  | 'tree:pine_tall'
  | 'tree:spruce_broad'
  | 'tree:pine_leaning'
  | 'tree:tree_ancient_dead'
  | 'tree:birch_deciduous';

export const TREE_SPECIES_BATCH_KEYS: readonly TreeSpeciesBatchKey[] = [
  'tree:pine_tall',
  'tree:spruce_broad',
  'tree:pine_leaning',
  'tree:tree_ancient_dead',
  'tree:birch_deciduous',
];

export interface ForestRoadSample {
  /** Shortest XZ distance to road centerline (main road or cabin spur). */
  dist: number;
  /** 0..1 weight (1 = on compacted dirt road, 0 = outside road shoulder). */
  blend: number;
  /** 0..1 weight for gravelly/pebbly roadside shoulder transition. */
  shoulderBlend: number;
  /** X coordinate of the main S-curve road at the given Z. */
  mainRoadX: number;
  /** Approximate tangent yaw of the main road at the given Z. */
  tangentYaw: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Computes the main winding forest dirt road X coordinate for a given Z in [-48..48],
 * plus distance & blend weights for both the main road and the cabin porch spur path.
 */
export function sampleForestRoad(x: number, z: number, seed = DEFAULT_PUBLIC_LAYOUT_SEED): ForestRoadSample {
  const phase = ((seed % 997) / 997) * 0.35;
  // Natural S-curve winding from south (z=+46) past cabin front (z=-6) to north (z=-46)
  const mainRoadX =
    3.6 +
    7.4 * Math.sin(z * 0.066 + 0.42 + phase) +
    3.1 * Math.cos(z * 0.128 - 0.55 - phase * 0.5);

  const dMaindx =
    7.4 * 0.066 * Math.cos(z * 0.066 + 0.42 + phase) -
    3.1 * 0.128 * Math.sin(z * 0.128 - 0.55 - phase * 0.5);

  // Perpendicular distance approximation to main road
  const mainDist = Math.abs(x - mainRoadX) / Math.hypot(1, dMaindx);
  const tangentYaw = Math.atan2(dMaindx, 1);

  // Spur path leading from the main road at z = -6 (x ~ 4.4) west to the cabin front steps at (x = -2.2, z = -6)
  const spurStartX = -2.2;
  const spurEndX = mainRoadX;
  const clampedSpurX = clamp(x, Math.min(spurStartX, spurEndX), Math.max(spurStartX, spurEndX));
  const spurCenterZ = -6.0 + 0.45 * Math.sin(((clampedSpurX - spurStartX) / Math.max(1, spurEndX - spurStartX)) * Math.PI);
  const spurDist = Math.hypot(x - clampedSpurX, z - spurCenterZ);

  const dist = Math.min(mainDist, spurDist * 1.12);
  const blend = 1 - smoothstep(1.35, 3.1, dist);
  const shoulderBlend = (1 - smoothstep(1.1, 2.3, Math.abs(dist - 2.2))) * (1 - blend * 0.65);

  return {
    dist,
    blend,
    shoulderBlend,
    mainRoadX,
    tangentYaw,
  };
}

/**
 * Deterministic 2D smooth value noise (no repeating sine grid artifacts).
 */
function hash2D(ix: number, iz: number, seed: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041);
  n = (n ^ (n >>> 13)) * 1274126177;
  return (((n ^ (n >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}

function smoothNoise2D(x: number, z: number, scale: number, seed: number): number {
  const gx = x / scale;
  const gz = z / scale;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);

  const n00 = hash2D(ix, iz, seed);
  const n10 = hash2D(ix + 1, iz, seed);
  const n01 = hash2D(ix, iz + 1, seed);
  const n11 = hash2D(ix + 1, iz + 1, seed);

  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  return nx0 + v * (nx1 - nx0);
}

/**
 * Builds the 96x96 meter heightfield terrain for `forest_sample`.
 */
export function buildForestSampleTerrain(seed = DEFAULT_PUBLIC_LAYOUT_SEED): HeightfieldTerrainDescriptor {
  const width = FOREST_SAMPLE_SIZE;
  const depth = FOREST_SAMPLE_SIZE;
  const cellSize = 2;
  const originX = -FOREST_SAMPLE_HALF;
  const originZ = -FOREST_SAMPLE_HALF;
  const cols = Math.floor(width / cellSize) + 1; // 49
  const rows = Math.floor(depth / cellSize) + 1; // 49
  const heights: number[] = new Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = originX + c * cellSize;
      const z = originZ + r * cellSize;

      // 1. Cabin clearing terrace centered at (-7.5, -6): flattened to +0.80 m
      const dCabin = Math.hypot((x - -7.2) * 0.9, (z - -6.0) * 0.85);
      const cabinFlatMask = smoothstep(6.8, 13.5, dCabin); // 0 inside cabin pad, 1 outside

      // 2. Walkable hills & ridges
      // NW Pine Knoll (-25, -23) -> peak +3.35 m
      const dNW = Math.hypot((x - -25) / 18, (z - -23) / 17);
      const hNW = dNW < 1 ? 3.35 * Math.pow(Math.cos(dNW * (Math.PI / 2)), 2) : 0;

      // NE Lookout Hill (23, -21) -> peak +3.10 m
      const dNE = Math.hypot((x - 23) / 17, (z - -21) / 16);
      const hNE = dNE < 1 ? 3.1 * Math.pow(Math.cos(dNE * (Math.PI / 2)), 2) : 0;

      // SE Sunlit Glade Hill (24, 19) -> peak +2.55 m
      const dSE = Math.hypot((x - 24) / 17, (z - 19) / 16);
      const hSE = dSE < 1 ? 2.55 * Math.pow(Math.cos(dSE * (Math.PI / 2)), 2) : 0;

      // West gentle ridge (-34, 4) -> peak +2.15 m
      const dW = Math.hypot((x - -34) / 14, (z - 4) / 18);
      const hW = dW < 1 ? 2.15 * Math.pow(Math.cos(dW * (Math.PI / 2)), 2) : 0;

      // 3. Natural hollows / depressions
      // SW Mossy Hollow (-21, 22) -> depth -1.65 m
      const dSW = Math.hypot((x - -21) / 15, (z - 22) / 14);
      const hSW = dSW < 1 ? -1.65 * Math.pow(Math.cos(dSW * (Math.PI / 2)), 2) : 0;

      // East Creek Dip (15, -2) -> depth -0.95 m
      const dEC = Math.hypot((x - 15) / 11, (z - -2) / 12);
      const hEC = dEC < 1 ? -0.95 * Math.pow(Math.cos(dEC * (Math.PI / 2)), 2) : 0;

      // 4. North Rocky Crag at (-11, -41) -> natural steep rocky outcrop (+4.3 m, slope > 45 deg)
      let crag = 0;
      if (x >= -17 && x <= -5 && z >= -45 && z <= -37) {
        const xm = clamp((6 - Math.abs(x - -11)) / 2, 0, 1);
        const zm = Math.max(0, 1 - Math.abs(z - -41) / 3.6);
        crag = 4.3 * xm * zm;
      }

      // 5. Organic 2-octave value noise (non-repeating)
      const n1 = smoothNoise2D(x, z, 18, seed) * 0.55;
      const n2 = smoothNoise2D(x + 31, z - 19, 8.5, seed + 17) * 0.22;

      // 6. Road crown / slight track wear
      const road = sampleForestRoad(x, z, seed);
      const roadCarve = -0.09 * road.blend;

      const rawH = hNW + hNE + hSE + hW + hSW + hEC + crag + (n1 + n2) * (1 - road.blend * 0.65) + roadCarve;
      const cabinPadH = 0.80;
      const blendedH = cabinPadH * (1 - cabinFlatMask) + rawH * cabinFlatMask;
      // Smoothly feather outer 3m perimeter toward y=0 so the 96x96 terrain meets the outer valley floor seamlessly
      const edgeDist = Math.min(FOREST_SAMPLE_HALF - Math.abs(x), FOREST_SAMPLE_HALF - Math.abs(z));
      const edgeFeather = smoothstep(0, 3.5, edgeDist);
      const finalH = blendedH * edgeFeather;

      heights[r * cols + c] = q3(finalH);
    }
  }

  return {
    kind: 'heightfield',
    width,
    depth,
    cellSize,
    originX,
    originZ,
    cols,
    rows,
    heights,
  };
}

/**
 * Vertex color sampler for the 96x96 `forest_sample` terrain mesh.
 * Blends dirt/gravel road, pebbly shoulders, mossy hollows, olive/emerald grass, sunlit hills, and rocky crags.
 */
export function sampleForestTerrainColor(
  x: number,
  y: number,
  z: number,
  slopeDeg: number,
  seed = DEFAULT_PUBLIC_LAYOUT_SEED,
): [number, number, number] {
  if (slopeDeg > DEFAULT_MAX_WALKABLE_SLOPE_DEG - 4) {
    // Moss-touched rocky crag / steep slope
    const moss = clamp((DEFAULT_MAX_WALKABLE_SLOPE_DEG + 8 - slopeDeg) / 16, 0, 1);
    return [
      0.28 - moss * 0.05,
      0.31 + moss * 0.04,
      0.29 - moss * 0.07,
    ];
  }

  const road = sampleForestRoad(x, z, seed);
  // Multi-scale organic woodland floor variation (macro glades + mid moss patches + micro pine-needle dappling)
  const macroNoise = smoothNoise2D(x, z, 15, seed + 101) * 0.5 + 0.5;
  const midNoise = smoothNoise2D(x + 19, z - 13, 6.2, seed + 157) * 0.5 + 0.5;
  const microNoise = smoothNoise2D(x * 1.8, z * 1.8, 2.6, seed + 229) * 0.5 + 0.5;

  // Base forest floor: grounded woodland moss, clover, and olive-pine greens (calibrated for ACES tone mapping)
  let r = 0.125 + macroNoise * 0.038 + midNoise * 0.024 + (microNoise - 0.5) * 0.018;
  let g = 0.235 + macroNoise * 0.052 + midNoise * 0.034 + (microNoise - 0.5) * 0.022;
  let b = 0.082 + macroNoise * 0.022 + midNoise * 0.014;

  // Subtle slope-based shading so hillsides have natural depth
  const slopeShade = clamp(slopeDeg / 38, 0, 1) * 0.14;
  r *= 1 - slopeShade * 0.5;
  g *= 1 - slopeShade;
  b *= 1 - slopeShade * 0.6;

  if (y < -0.25) {
    // Damp mossy hollow (deep emerald-olive moss & rich humus soil)
    const k = clamp((-y - 0.25) / 1.5, 0, 1);
    r = r * (1 - k) + 0.105 * k;
    g = g * (1 - k) + 0.205 * k;
    b = b * (1 - k) + 0.078 * k;
  } else if (y > 1.1) {
    // Sunlit warm olive-ochre hilltops
    const k = clamp((y - 1.1) / 2.4, 0, 1);
    r = r * (1 - k) + 0.205 * k;
    g = g * (1 - k) + 0.305 * k;
    b = b * (1 - k) + 0.105 * k;
  }

  // Cabin yard compacted earth/pine-needle apron around (-7.2, -6)
  const dCabinYard = Math.hypot(x - -6.5, z - -6.0) + (midNoise - 0.5) * 0.9;
  const yardBlend = (1 - smoothstep(3.8, 8.2, dCabinYard)) * 0.65;
  if (yardBlend > 0) {
    r = r * (1 - yardBlend) + 0.235 * yardBlend;
    g = g * (1 - yardBlend) + 0.185 * yardBlend;
    b = b * (1 - yardBlend) + 0.108 * yardBlend;
  }

  // Organic noisy road edge distance for natural, non-uniform dirt-to-grass transition
  const edgeJitter = (midNoise - 0.5) * 0.72 + (microNoise - 0.5) * 0.35;
  const noisyRoadDist = Math.max(0, road.dist + edgeJitter);
  const organicRoadBlend = 1 - smoothstep(1.15, 3.35, noisyRoadDist);
  const organicShoulder = (1 - smoothstep(0.95, 2.65, Math.abs(noisyRoadDist - 2.35))) * (1 - organicRoadBlend * 0.55);

  // Gravelly/leafy road shoulder transition (dry pine needles + weathered soil)
  if (organicShoulder > 0.01) {
    const sb = organicShoulder * 0.78;
    r = r * (1 - sb) + (0.215 + (microNoise - 0.5) * 0.03) * sb;
    g = g * (1 - sb) + (0.205 + (microNoise - 0.5) * 0.025) * sb;
    b = b * (1 - sb) + 0.105 * sb;
  }

  // Main winding dirt & gravel road track with subtle wheel ruts & center grass crown
  if (organicRoadBlend > 0.01) {
    const grit = (microNoise - 0.5) * 0.045;
    const rutDist = Math.abs(road.dist - 0.85);
    const rutMask = 1 - smoothstep(0.0, 0.55, rutDist);
    const dirtR = 0.275 - rutMask * 0.032 + grit;
    const dirtG = 0.198 - rutMask * 0.024 + grit * 0.75;
    const dirtB = 0.118 - rutMask * 0.015 + grit * 0.45;
    r = r * (1 - organicRoadBlend) + dirtR * organicRoadBlend;
    g = g * (1 - organicRoadBlend) + dirtG * organicRoadBlend;
    b = b * (1 - organicRoadBlend) + dirtB * organicRoadBlend;
  }

  // Feather outer 5m perimeter smoothly into the outer valley floor color so top-down view has no hard border
  const edgeDist = Math.min(FOREST_SAMPLE_HALF - Math.abs(x), FOREST_SAMPLE_HALF - Math.abs(z));
  const outerBlend = 1 - smoothstep(0.0, 5.5, edgeDist);
  if (outerBlend > 0.001) {
    r = r * (1 - outerBlend) + 0.142 * outerBlend;
    g = g * (1 - outerBlend) + 0.248 * outerBlend;
    b = b * (1 - outerBlend) + 0.092 * outerBlend;
  }

  return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
}

// ---------------- 8 x 6 m Enterable Original Wooden Cabin ----------------

/**
 * Builds the `PrefabPlacement` for the enterable 8 x 6 m wooden ranger cabin at (-8, -6).
 * Features:
 * - Wooden floor + front porch (`y = baseY .. baseY + 0.26`)
 * - East front step-up stairs and south exit step-up stairs (`<= STEP_HEIGHT`)
 * - Real open east doorway (`1.8 m` wide x `2.40 m` tall) and south doorway (`1.8 m` wide x `2.40 m` tall)
 * - 4 framed window openings (east left/right, west wide, north)
 * - Pitched gable roof + overhanging porch roof + stone chimney
 * - Interior table, storage shelves, and decorative supply crate
 */
export function buildForestCabinPlacement(): PrefabPlacement {
  const floorH = 0.26;
  const wallH = 3.2;
  const wallBaseY = floorH;
  const wallCenterY = wallBaseY + wallH / 2;
  const t = 0.26; // wall thickness

  const parts: LocalBoxPart[] = [
    // 1. Main Cabin Floor (6.0m X by 8.0m Z) + Front Porch Floor (1.8m X by 8.0m Z) => total 7.8m X [-3.0..+4.8]
    {
      localId: 'cabin_floor',
      offset: { x: 0.9, y: floorH / 2, z: 0 },
      size: { x: 7.8, y: floorH, z: 8.0 },
      mat: 'crate',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:floor',
      batchMode: 'static_box',
    },
    // 2. East Front Entrance Steps (facing the dirt road): 2 wide steps (0.13m high)
    {
      localId: 'front_step_1',
      offset: { x: 5.25, y: 0.065, z: 0 },
      size: { x: 0.9, y: 0.13, z: 2.4 },
      mat: 'crate',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:step',
      batchMode: 'static_box',
    },
    // 3. South Side Exit Step (outside south doorway at x=0, z=+4.0)
    {
      localId: 'south_step_1',
      offset: { x: 0, y: 0.065, z: 4.45 },
      size: { x: 2.2, y: 0.13, z: 0.9 },
      mat: 'crate',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:step',
      batchMode: 'static_box',
    },

    // ---------------- EAST FRONT WALL (x = +3.0, z in [-4.0 .. +4.0]) ----------------
    // Doorway is at z in [-0.9 .. +0.9] (1.8m wide, 2.40m tall)
    // Door lintel above front doorway (y from floorH + 2.40 to floorH + 3.20)
    {
      localId: 'east_door_lintel',
      offset: { x: 3.0, y: wallBaseY + 2.8, z: 0 },
      size: { x: t, y: 0.8, z: 1.8 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    // North-East front wall section (z in [-4.0 .. -0.9], length 3.1m) with window at z in [-3.0 .. -1.7]
    {
      localId: 'east_left_sill',
      offset: { x: 3.0, y: wallBaseY + 0.525, z: -2.45 },
      size: { x: t, y: 1.05, z: 3.1 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'east_left_header',
      offset: { x: 3.0, y: wallBaseY + 2.675, z: -2.45 },
      size: { x: t, y: 1.05, z: 3.1 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'east_left_corner_post',
      offset: { x: 3.0, y: wallCenterY, z: -3.5 },
      size: { x: t, y: wallH, z: 1.0 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'east_left_door_jamb',
      offset: { x: 3.0, y: wallCenterY, z: -1.3 },
      size: { x: t, y: wallH, z: 0.8 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },

    // South-East front wall section (z in [+0.9 .. +4.0], length 3.1m) with window at z in [+1.7 .. +3.0]
    {
      localId: 'east_right_sill',
      offset: { x: 3.0, y: wallBaseY + 0.525, z: 2.45 },
      size: { x: t, y: 1.05, z: 3.1 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'east_right_header',
      offset: { x: 3.0, y: wallBaseY + 2.675, z: 2.45 },
      size: { x: t, y: 1.05, z: 3.1 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'east_right_door_jamb',
      offset: { x: 3.0, y: wallCenterY, z: 1.3 },
      size: { x: t, y: wallH, z: 0.8 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'east_right_corner_post',
      offset: { x: 3.0, y: wallCenterY, z: 3.5 },
      size: { x: t, y: wallH, z: 1.0 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },

    // ---------------- WEST BACK WALL (x = -3.0, z in [-4.0 .. +4.0]) ----------------
    // Wide window at z in [-1.5 .. +1.5]
    {
      localId: 'west_north_seg',
      offset: { x: -3.0, y: wallCenterY, z: -2.75 },
      size: { x: t, y: wallH, z: 2.5 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'west_south_seg',
      offset: { x: -3.0, y: wallCenterY, z: 2.75 },
      size: { x: t, y: wallH, z: 2.5 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'west_win_sill',
      offset: { x: -3.0, y: wallBaseY + 0.525, z: 0 },
      size: { x: t, y: 1.05, z: 3.0 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'west_win_header',
      offset: { x: -3.0, y: wallBaseY + 2.675, z: 0 },
      size: { x: t, y: 1.05, z: 3.0 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },

    // ---------------- NORTH WALL (z = -4.0, x in [-3.0 .. +3.0]) ----------------
    // Window at x in [-0.8 .. +1.2]
    {
      localId: 'north_west_seg',
      offset: { x: -1.9, y: wallCenterY, z: -4.0 },
      size: { x: 2.2, y: wallH, z: t },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'north_east_seg',
      offset: { x: 2.1, y: wallCenterY, z: -4.0 },
      size: { x: 1.8, y: wallH, z: t },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'north_win_sill',
      offset: { x: 0.2, y: wallBaseY + 0.525, z: -4.0 },
      size: { x: 2.0, y: 1.05, z: t },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'north_win_header',
      offset: { x: 0.2, y: wallBaseY + 2.675, z: -4.0 },
      size: { x: 2.0, y: 1.05, z: t },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },

    // ---------------- SOUTH WALL (z = +4.0, x in [-3.0 .. +3.0]) ----------------
    // Secondary exit doorway at x in [-0.9 .. +0.9] (1.8m wide x 2.40m tall)
    {
      localId: 'south_west_seg',
      offset: { x: -1.95, y: wallCenterY, z: 4.0 },
      size: { x: 2.1, y: wallH, z: t },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'south_east_seg',
      offset: { x: 1.95, y: wallCenterY, z: 4.0 },
      size: { x: 2.1, y: wallH, z: t },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },
    {
      localId: 'south_door_lintel',
      offset: { x: 0, y: wallBaseY + 2.8, z: 4.0 },
      size: { x: 1.8, y: 0.8, z: t },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:wall',
      batchMode: 'static_box',
    },

    // ---------------- ROOF, CHIMNEY & PORCH POSTS ----------------
    {
      localId: 'roof_eave_slab',
      offset: { x: 0.9, y: wallBaseY + wallH + 0.16, z: 0 },
      size: { x: 8.4, y: 0.32, z: 8.6 },
      mat: 'roof',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:roof',
      batchMode: 'static_box',
    },
    {
      localId: 'roof_upper_tier',
      offset: { x: 0.2, y: wallBaseY + wallH + 0.56, z: 0 },
      size: { x: 5.8, y: 0.48, z: 8.4 },
      mat: 'roof',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:roof',
      batchMode: 'static_box',
    },
    {
      localId: 'roof_ridge_crest',
      offset: { x: 0, y: wallBaseY + wallH + 0.96, z: 0 },
      size: { x: 3.0, y: 0.36, z: 8.5 },
      mat: 'roof',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:roof',
      batchMode: 'static_box',
    },
    {
      localId: 'stone_chimney',
      offset: { x: -1.8, y: wallBaseY + 2.4, z: -4.25 },
      size: { x: 1.2, y: 4.8, z: 0.9 },
      mat: 'wall',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:chimney',
      batchMode: 'static_box',
    },
    // Porch corner posts (leaving front stairs at z = 0 completely clear)
    {
      localId: 'porch_post_ne',
      offset: { x: 4.6, y: wallCenterY, z: -3.7 },
      size: { x: 0.24, y: wallH, z: 0.24 },
      mat: 'crate',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:post',
      batchMode: 'static_box',
    },
    {
      localId: 'porch_post_se',
      offset: { x: 4.6, y: wallCenterY, z: 3.7 },
      size: { x: 0.24, y: wallH, z: 0.24 },
      mat: 'crate',
      colliderTag: 'structure',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'structure',
      batchKey: 'cabin:post',
      batchMode: 'static_box',
    },

    // ---------------- INTERIOR PROPS (Table, Shelves, Crate) ----------------
    // Wooden worktable in NW corner
    {
      localId: 'interior_table',
      offset: { x: -2.0, y: wallBaseY + 0.42, z: -2.9 },
      size: { x: 1.2, y: 0.84, z: 1.5 },
      mat: 'crate',
      colliderTag: 'prop',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'prop',
      batchKey: 'cabin:furniture',
      batchMode: 'static_box',
    },
    // Storage shelf rack in SW corner
    {
      localId: 'interior_shelf',
      offset: { x: -2.2, y: wallBaseY + 0.95, z: 2.9 },
      size: { x: 0.8, y: 1.9, z: 1.4 },
      mat: 'crate',
      colliderTag: 'prop',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'prop',
      batchKey: 'cabin:furniture',
      batchMode: 'static_box',
    },
    // Decorative wooden supply crate in NE corner
    {
      localId: 'interior_supply_crate',
      offset: { x: 1.9, y: wallBaseY + 0.38, z: -3.1 },
      size: { x: 0.95, y: 0.76, z: 0.85 },
      mat: 'crate',
      colliderTag: 'prop',
      hasCollider: true,
      hasVisual: true,
      visualCategory: 'prop',
      batchKey: 'cabin:furniture',
      batchMode: 'static_box',
    },
  ];

  return {
    objectId: 'forest_cabin_main',
    prefabId: 'ranger_wood_cabin_8x6',
    groundToTerrain: true,
    transform: {
      position: { x: -8, y: 0, z: -6 },
      yaw: 0,
      scale: { x: 1, y: 1, z: 1 },
    },
    parts,
  };
}

// ---------------- Full 96x96 Forest Sample World Generator ----------------

export function createForestSampleWorld(
  opts: { publicLayoutSeed?: number; worldVersion?: number; chunkSize?: number } = {},
): WorldDefinition {
  const worldVersion = opts.worldVersion ?? CURRENT_WORLD_VERSION;
  const publicLayoutSeed = opts.publicLayoutSeed ?? DEFAULT_PUBLIC_LAYOUT_SEED;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const terrain = buildForestSampleTerrain(publicLayoutSeed);
  const colliders: ColliderBox[] = [];
  const visuals: VisualDescriptor[] = [];

  // 1. Compile Enterable 8x6 Wooden Cabin at (-8, -6)
  const cabinPlacement = buildForestCabinPlacement();
  const compiledCabin = compilePrefabPlacement(cabinPlacement, chunkSize, terrain);
  colliders.push(...compiledCabin.colliders);
  visuals.push(...compiledCabin.visuals);

  // 2. Define Safe Grounded Spawn Points across the 96x96 Forest
  const rawSpawns: Array<{ id: string; x: number; z: number; yaw: number; team: Team }> = [
    // Red Team (South & Southeast Glade / Road entrance)
    { id: 'sp_f_red_0', x: 4, z: 38, yaw: 0, team: 'red' },
    { id: 'sp_f_red_1', x: 14, z: 34, yaw: 0.25, team: 'red' },
    { id: 'sp_f_red_2', x: -8, z: 36, yaw: -0.2, team: 'red' },
    { id: 'sp_f_red_3', x: 24, z: 22, yaw: 0.5, team: 'red' },
    { id: 'sp_f_red_4', x: -20, z: 22, yaw: -0.4, team: 'red' },
    { id: 'sp_f_red_5', x: 2, z: 26, yaw: 0, team: 'red' },
    { id: 'sp_f_red_6', x: 32, z: 28, yaw: 0.6, team: 'red' },
    { id: 'sp_f_red_7', x: -30, z: 32, yaw: -0.5, team: 'red' },

    // Blue Team (North & Northeast / Northwest Hills)
    { id: 'sp_f_blue_0', x: 2, z: -36, yaw: Math.PI, team: 'blue' },
    { id: 'sp_f_blue_1', x: 16, z: -32, yaw: Math.PI - 0.3, team: 'blue' },
    { id: 'sp_f_blue_2', x: -24, z: -24, yaw: Math.PI + 0.4, team: 'blue' },
    { id: 'sp_f_blue_3', x: 24, z: -20, yaw: Math.PI - 0.5, team: 'blue' },
    { id: 'sp_f_blue_4', x: -32, z: -30, yaw: Math.PI + 0.5, team: 'blue' },
    { id: 'sp_f_blue_5', x: 32, z: -30, yaw: Math.PI - 0.6, team: 'blue' },
    { id: 'sp_f_blue_6', x: 8, z: -26, yaw: Math.PI, team: 'blue' },
    { id: 'sp_f_blue_7', x: -16, z: -28, yaw: Math.PI + 0.2, team: 'blue' },

    // FFA / General Forest Spawns (Cabin Yard, Road Bends, Clearings)
    { id: 'sp_f_ffa_0', x: 4, z: -6, yaw: Math.PI / 2, team: 'none' },
    { id: 'sp_f_ffa_1', x: 9, z: 14, yaw: 0.4, team: 'none' },
    { id: 'sp_f_ffa_2', x: -24, z: 4, yaw: -1.1, team: 'none' },
    { id: 'sp_f_ffa_3', x: 22, z: 2, yaw: 1.2, team: 'none' },
    { id: 'sp_f_ffa_4', x: -8, z: 16, yaw: 0, team: 'none' },
    { id: 'sp_f_ffa_5', x: 15, z: -12, yaw: 2.2, team: 'none' },
    { id: 'sp_f_ffa_6', x: -28, z: -12, yaw: -1.8, team: 'none' },
    { id: 'sp_f_ffa_7', x: 30, z: 10, yaw: 1.5, team: 'none' },
  ];

  const spawnPoints: SpawnPointDef[] = rawSpawns.map((s) => ({
    id: s.id,
    x: q3(s.x),
    y: q3(sampleTerrainHeight(terrain, s.x, s.z)),
    z: q3(s.z),
    yaw: q3(s.yaw),
    team: s.team,
  }));

  // Helper to check exclusion zones (road, cabin yard, spawn points)
  const isClearOfKeyZones = (x: number, z: number, roadPad: number, cabinPad: number, spawnPad: number): boolean => {
    const road = sampleForestRoad(x, z, publicLayoutSeed);
    if (road.dist < roadPad) return false;

    // Cabin + porch + entry/exit yards exclusion box: cabin spans x: [-11.5 .. -2.0], z: [-10.6 .. -1.0]
    if (
      x >= -11.5 - cabinPad &&
      x <= -2.0 + cabinPad &&
      z >= -10.6 - cabinPad &&
      z <= -1.0 + cabinPad
    ) {
      return false;
    }

    for (const sp of spawnPoints) {
      if (Math.hypot(x - sp.x, z - sp.z) < spawnPad) return false;
    }

    return true;
  };

  // 3. Deterministic Natural Forest Tree Placement (5 Species, ~225 inside playable 96x96 bounds + ~36 vista trees)
  const rng = createSeededRng(publicLayoutSeed ^ 0x5f3759df);
  const placedTrees: Array<{ x: number; z: number; radius: number; species: TreeSpeciesBatchKey }> = [];

  // Natural grove centers for organic clustering (dense woods vs open glades)
  const groveCenters: Array<{ x: number; z: number; radius: number; preferred: TreeSpeciesBatchKey }> = [
    { x: -28, z: -26, radius: 18, preferred: 'tree:pine_tall' },
    { x: -34, z: -4, radius: 16, preferred: 'tree:spruce_broad' },
    { x: -26, z: 24, radius: 17, preferred: 'tree:birch_deciduous' },
    { x: 24, z: -24, radius: 18, preferred: 'tree:pine_tall' },
    { x: 30, z: 4, radius: 16, preferred: 'tree:spruce_broad' },
    { x: 24, z: 28, radius: 17, preferred: 'tree:pine_leaning' },
    { x: -12, z: -32, radius: 14, preferred: 'tree:tree_ancient_dead' },
    { x: 14, z: 28, radius: 14, preferred: 'tree:birch_deciduous' },
    { x: -36, z: -36, radius: 15, preferred: 'tree:spruce_broad' },
    { x: 36, z: -36, radius: 15, preferred: 'tree:pine_tall' },
    { x: -36, z: 36, radius: 15, preferred: 'tree:pine_leaning' },
    { x: 36, z: 36, radius: 15, preferred: 'tree:spruce_broad' },
  ];

  const pickSpecies = (x: number, z: number): TreeSpeciesBatchKey => {
    const r = rng();
    // Near hollow or road edges, favor birch or leaning pines
    if (z > 12 && x < -8 && r < 0.38) return 'tree:birch_deciduous';
    if (r < 0.34) return 'tree:pine_tall';
    if (r < 0.64) return 'tree:spruce_broad';
    if (r < 0.80) return 'tree:pine_leaning';
    if (r < 0.91) return 'tree:birch_deciduous';
    return 'tree:tree_ancient_dead';
  };

  const targetPlayableTrees = 228;
  let attempts = 0;
  while (placedTrees.length < targetPlayableTrees && attempts < 4500) {
    attempts++;
    let tx: number;
    let tz: number;
    let species: TreeSpeciesBatchKey;

    if (rng() < 0.68) {
      // Sample around a natural grove cluster
      const g = groveCenters[Math.floor(rng() * groveCenters.length)];
      const ang = rng() * Math.PI * 2;
      const dist = Math.sqrt(rng()) * g.radius;
      tx = g.x + Math.cos(ang) * dist;
      tz = g.z + Math.sin(ang) * dist;
      species = rng() < 0.55 ? g.preferred : pickSpecies(tx, tz);
    } else {
      // Scattered woodland trees across [-45.5 .. +45.5]
      tx = (rng() * 2 - 1) * 45.5;
      tz = (rng() * 2 - 1) * 45.5;
      species = pickSpecies(tx, tz);
    }

    if (Math.abs(tx) > 45.8 || Math.abs(tz) > 45.8) continue;
    if (!isClearOfKeyZones(tx, tz, 3.6, 2.6, 3.2)) continue;
    if (sampleTerrainSlopeDeg(terrain, tx, tz) > 38) continue;

    // Ensure natural irregular spacing (no grid lines, no overlapping trunks)
    const minSpacing = species === 'tree:spruce_broad' ? 3.2 : 2.7;
    let tooClose = false;
    for (const other of placedTrees) {
      if (Math.hypot(tx - other.x, tz - other.z) < minSpacing) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const scaleXZ = 0.84 + rng() * 0.42;
    const scaleY = 0.86 + rng() * 0.48;
    const yaw = rng() * Math.PI * 2;
    const baseRadius =
      species === 'tree:tree_ancient_dead'
        ? 0.44
        : species === 'tree:spruce_broad'
          ? 0.40
          : species === 'tree:birch_deciduous'
            ? 0.30
            : 0.35;
    const trunkRadius = q3(baseRadius * scaleXZ);
    const idx = placedTrees.length;
    const treeId = `forest_tree_${idx}`;

    placedTrees.push({ x: tx, z: tz, radius: trunkRadius, species });

    // Physical collider for the lower trunk ONLY (leaves/branches do not block movement)
    const treeCol = createGroundedTreeCollider(treeId, terrain, tx, tz, trunkRadius, 4.4);
    colliders.push(treeCol);

    const groundY = sampleTerrainHeight(terrain, tx, tz);
    const chunk = getChunkCoord(tx, tz, chunkSize);
    visuals.push({
      id: `${treeId}:vis`,
      sourceObjectId: treeId,
      prefabId: species,
      category: 'tree',
      batchKey: species,
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'all',
      maxDrawDistance: 220,
      transform: {
        position: { x: q3(tx), y: q3(groundY), z: q3(tz) },
        yaw: q3(yaw),
        scale: { x: q3(scaleXZ), y: q3(scaleY), z: q3(scaleXZ) },
      },
      castShadow: true,
      receiveShadow: true,
    });
  }

  // Outer backdrop trees beyond the 96x96 playable boundary (visual only, ~36 trees for horizon continuity)
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2 + (rng() - 0.5) * 0.12;
    const r = 53 + rng() * 18;
    let tx = Math.cos(a) * r;
    let tz = Math.sin(a) * r;
    const maxCoord = Math.max(Math.abs(tx), Math.abs(tz));
    if (maxCoord < 50.5) {
      const boost = 50.5 / Math.max(1, maxCoord);
      tx *= boost;
      tz *= boost;
    }
    const species = TREE_SPECIES_BATCH_KEYS[i % TREE_SPECIES_BATCH_KEYS.length];
    const scaleXZ = 1.05 + rng() * 0.35;
    const scaleY = 1.05 + rng() * 0.45;
    const groundY = sampleTerrainHeight(terrain, tx, tz);
    const chunk = getChunkCoord(tx, tz, chunkSize);
    visuals.push({
      id: `forest_vista_tree_${i}:vis`,
      sourceObjectId: `forest_vista_tree_${i}`,
      prefabId: species,
      category: 'tree',
      batchKey: species,
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'far',
      maxDrawDistance: 260,
      transform: {
        position: { x: q3(tx), y: q3(groundY), z: q3(tz) },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: q3(scaleXZ), y: q3(scaleY), z: q3(scaleXZ) },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  // 4. Large Irregular Mossy Boulders (with physical colliders)
  let rockCount = 0;
  let rockAttempts = 0;
  while (rockCount < 22 && rockAttempts < 600) {
    rockAttempts++;
    const rx = (rng() * 2 - 1) * 43;
    const rz = (rng() * 2 - 1) * 43;
    if (!isClearOfKeyZones(rx, rz, 3.8, 3.2, 3.4)) continue;
    let hitTree = false;
    for (const t of placedTrees) {
      if (Math.hypot(rx - t.x, rz - t.z) < 2.2) {
        hitTree = true;
        break;
      }
    }
    if (hitTree) continue;

    const sx = q3(1.5 + rng() * 1.4);
    const sy = q3(1.0 + rng() * 1.1);
    const sz = q3(1.4 + rng() * 1.3);
    const rockId = `forest_rock_${rockCount++}`;
    const rockCol = createGroundedRockCollider(rockId, terrain, rx, rz, { x: sx, y: sy, z: sz });
    colliders.push(rockCol);

    const groundY = sampleTerrainHeight(terrain, rx, rz);
    const chunk = getChunkCoord(rx, rz, chunkSize);
    visuals.push({
      id: `${rockId}:vis`,
      sourceObjectId: rockId,
      prefabId: 'rock:boulder_mossy',
      category: 'rock',
      batchKey: 'rock:boulder_mossy',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'mid',
      maxDrawDistance: 160,
      transform: {
        position: { x: q3(rx), y: q3(groundY), z: q3(rz) },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sx, y: sy, z: sz },
      },
      castShadow: true,
      receiveShadow: true,
    });
  }

  // 5. Fallen Logs & Cut Tree Stumps (non-blocking woodland floor details)
  for (let i = 0; i < 18; i++) {
    const lx = (rng() * 2 - 1) * 42;
    const lz = (rng() * 2 - 1) * 42;
    if (!isClearOfKeyZones(lx, lz, 4.0, 3.5, 3.0)) continue;
    if (!isTerrainWalkable(terrain, lx, lz)) continue;
    const groundY = sampleTerrainHeight(terrain, lx, lz);
    const chunk = getChunkCoord(lx, lz, chunkSize);
    visuals.push({
      id: `forest_log_${i}:vis`,
      sourceObjectId: `forest_log_${i}`,
      prefabId: 'prop:fallen_log',
      category: 'prop',
      batchKey: 'prop:fallen_log',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'mid',
      maxDrawDistance: 120,
      transform: {
        position: { x: q3(lx), y: q3(groundY), z: q3(lz) },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: q3(0.85 + rng() * 0.4), y: q3(0.85 + rng() * 0.35), z: q3(0.9 + rng() * 0.5) },
      },
      castShadow: true,
      receiveShadow: true,
    });
  }

  for (let i = 0; i < 24; i++) {
    const sx = (rng() * 2 - 1) * 43;
    const sz = (rng() * 2 - 1) * 43;
    if (!isClearOfKeyZones(sx, sz, 3.4, 3.0, 2.8)) continue;
    const groundY = sampleTerrainHeight(terrain, sx, sz);
    const chunk = getChunkCoord(sx, sz, chunkSize);
    const sc = q3(0.8 + rng() * 0.5);
    visuals.push({
      id: `forest_stump_${i}:vis`,
      sourceObjectId: `forest_stump_${i}`,
      prefabId: 'prop:tree_stump',
      category: 'prop',
      batchKey: 'prop:tree_stump',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'mid',
      maxDrawDistance: 110,
      transform: {
        position: { x: q3(sx), y: q3(groundY), z: q3(sz) },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: q3(0.75 + rng() * 0.45), z: sc },
      },
      castShadow: true,
      receiveShadow: true,
    });
  }

  // 6. Forest Undergrowth Layers: Bushes, Ferns, Grass Clumps, Roadside Pebbles, Leaf Litter
  // 6a. Bushes (~96 instances)
  for (let i = 0; i < 96; i++) {
    const bx = (rng() * 2 - 1) * 45;
    const bz = (rng() * 2 - 1) * 45;
    if (!isClearOfKeyZones(bx, bz, 2.8, 2.0, 2.2)) continue;
    const groundY = sampleTerrainHeight(terrain, bx, bz);
    const chunk = getChunkCoord(bx, bz, chunkSize);
    const sc = q3(0.75 + rng() * 0.65);
    visuals.push({
      id: `forest_bush_${i}:vis`,
      sourceObjectId: `forest_bush_${i}`,
      prefabId: 'foliage:bush',
      category: 'foliage',
      batchKey: 'foliage:bush',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'mid',
      maxDrawDistance: 110,
      transform: {
        position: { x: q3(bx), y: q3(groundY), z: q3(bz) },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: q3(sc * (0.8 + rng() * 0.35)), z: sc },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  // 6b. Woodland Ferns (~140 instances, favoring shaded tree bases & hollow)
  for (let i = 0; i < 140; i++) {
    let fx: number;
    let fz: number;
    if (i < 100 && placedTrees.length > 0) {
      const t = placedTrees[(i * 7) % placedTrees.length];
      const a = rng() * Math.PI * 2;
      const d = 0.8 + rng() * 2.2;
      fx = clamp(t.x + Math.cos(a) * d, -45.5, 45.5);
      fz = clamp(t.z + Math.sin(a) * d, -45.5, 45.5);
    } else {
      fx = (rng() * 2 - 1) * 45;
      fz = (rng() * 2 - 1) * 45;
    }
    if (!isClearOfKeyZones(fx, fz, 2.4, 1.5, 1.5)) continue;
    const groundY = sampleTerrainHeight(terrain, fx, fz);
    const chunk = getChunkCoord(fx, fz, chunkSize);
    const sc = q3(0.75 + rng() * 0.55);
    visuals.push({
      id: `forest_fern_${i}:vis`,
      sourceObjectId: `forest_fern_${i}`,
      prefabId: 'foliage:fern',
      category: 'foliage',
      batchKey: 'foliage:fern',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: 75,
      transform: {
        position: { x: q3(fx), y: q3(groundY), z: q3(fz) },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: sc, z: sc },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  // 6c. Grass Tufts (~380 instances across clearings, hills, and road shoulders)
  for (let i = 0; i < 380; i++) {
    const gx = (rng() * 2 - 1) * 45.5;
    const gz = (rng() * 2 - 1) * 45.5;
    if (!isClearOfKeyZones(gx, gz, 1.9, 1.2, 0.8)) continue;
    if (sampleTerrainSlopeDeg(terrain, gx, gz) > 40) continue;
    const groundY = sampleTerrainHeight(terrain, gx, gz);
    const chunk = getChunkCoord(gx, gz, chunkSize);
    const sc = q3(0.75 + rng() * 0.65);
    visuals.push({
      id: `forest_grass_${i}:vis`,
      sourceObjectId: `forest_grass_${i}`,
      prefabId: 'foliage:grass',
      category: 'foliage',
      batchKey: 'foliage:grass',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: 68,
      transform: {
        position: { x: q3(gx), y: q3(groundY), z: q3(gz) },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: q3(0.7 + rng() * 0.6), z: sc },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  // 6d. Roadside Pebbles & Small Stones (~130 instances along road shoulders and crags)
  for (let i = 0; i < 130; i++) {
    let px: number;
    let pz: number;
    if (i < 85) {
      // Along the winding dirt road shoulder
      pz = (rng() * 2 - 1) * 44;
      const roadSample = sampleForestRoad(0, pz, publicLayoutSeed);
      const side = rng() < 0.5 ? -1 : 1;
      px = clamp(roadSample.mainRoadX + side * (1.7 + rng() * 1.6), -45, 45);
    } else {
      px = (rng() * 2 - 1) * 45;
      pz = (rng() * 2 - 1) * 45;
    }
    if (!isClearOfKeyZones(px, pz, 1.4, 1.4, 1.0)) continue;
    const groundY = sampleTerrainHeight(terrain, px, pz);
    const chunk = getChunkCoord(px, pz, chunkSize);
    const sc = q3(0.65 + rng() * 0.75);
    visuals.push({
      id: `forest_pebble_${i}:vis`,
      sourceObjectId: `forest_pebble_${i}`,
      prefabId: 'prop:pebble',
      category: 'prop',
      batchKey: 'prop:pebble',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: 65,
      transform: {
        position: { x: q3(px), y: q3(groundY), z: q3(pz) },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: q3(sc * 0.6), z: sc },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  // 6e. Fallen Leaf & Pine Needle Litter Patches (~110 instances under trees and along road edges)
  for (let i = 0; i < 110; i++) {
    const lx = (rng() * 2 - 1) * 44;
    const lz = (rng() * 2 - 1) * 44;
    if (!isClearOfKeyZones(lx, lz, 1.2, 1.5, 0.5)) continue;
    if (sampleTerrainSlopeDeg(terrain, lx, lz) > 35) continue;
    const groundY = sampleTerrainHeight(terrain, lx, lz);
    const chunk = getChunkCoord(lx, lz, chunkSize);
    const sc = q3(0.85 + rng() * 0.85);
    visuals.push({
      id: `forest_leaf_${i}:vis`,
      sourceObjectId: `forest_leaf_${i}`,
      prefabId: 'foliage:leaf_patch',
      category: 'foliage',
      batchKey: 'foliage:leaf_patch',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: 65,
      transform: {
        position: { x: q3(lx), y: q3(groundY + 0.018), z: q3(lz) },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: 1, z: sc },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  const locations: WorldLocation[] = [
    {
      id: 'loc_ranger_cabin',
      name: "O'rmonchi Kulbasi (8x6m)",
      kind: 'ranger_house',
      position: getGroundedPosition(terrain, -8, -6),
      yaw: 0,
      radius: 9,
      enterable: true,
    },
    {
      id: 'loc_nw_knoll',
      name: "Shimoli-g'arbiy Qarag'ay Tepaligi",
      kind: 'clearing',
      position: getGroundedPosition(terrain, -25, -23),
      yaw: 0,
      radius: 14,
      enterable: false,
    },
    {
      id: 'loc_sw_hollow',
      name: 'Moxli Pastlik',
      kind: 'clearing',
      position: getGroundedPosition(terrain, -21, 22),
      yaw: 0,
      radius: 12,
      enterable: false,
    },
    {
      id: 'loc_se_glade',
      name: 'Quyoshli Yalanglik',
      kind: 'clearing',
      position: getGroundedPosition(terrain, 24, 19),
      yaw: 0,
      radius: 14,
      enterable: false,
    },
  ];

  const containerLocations: ContainerLocation[] = [
    {
      id: 'cnt_cabin_supply_01',
      locationId: 'loc_ranger_cabin',
      kind: 'supply_crate',
      position: getGroundedPosition(terrain, -6.1, -9.1, 0.26),
      yaw: 0,
      interactionRadius: 2.2,
    },
  ];

  const bounds: WorldBounds = {
    minX: -FOREST_SAMPLE_HALF,
    maxX: FOREST_SAMPLE_HALF,
    minY: -8,
    maxY: 36,
    minZ: -FOREST_SAMPLE_HALF,
    maxZ: FOREST_SAMPLE_HALF,
  };

  const baseData = {
    mapId: 'forest_sample' as const,
    worldVersion,
    publicLayoutSeed,
    bounds,
    terrain,
    colliders,
    spawnPoints,
    locations,
    containerLocations,
  };

  return {
    ...baseData,
    name: "O'rmon Namunasi (96×96)",
    chunkSize,
    visuals,
    gameplayHash: computeGameplayHash(baseData),
  };
}

/**
 * Builds the 96x96 heightfield terrain for `forest_assets_preview` (Stage 04A),
 * flattening both the `cabin_8x4` clearing (`-11..-3, -8..-3`) and the `room_4x4` clearing (`-14..-10, 2..7`)
 * to a level `+0.80 m` courtyard terrace while keeping the rest of the 96x96 forest identical.
 */
export function buildForestAssetsPreviewTerrain(
  seed = DEFAULT_PUBLIC_LAYOUT_SEED,
): HeightfieldTerrainDescriptor {
  const base = buildForestSampleTerrain(seed);
  const heights = [...base.heights];
  const { cols, rows, originX, originZ, cellSize } = base;
  const padH = 0.8;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = originX + c * cellSize;
      const z = originZ + r * cellSize;
      // Flatten terrace around room_4x4 (-14..-10, 2..6) and courtyard between cabin_8x4 and room_4x4
      const dRoom = Math.hypot((x - -12.0) * 0.9, (z - 4.2) * 0.8);
      const roomMask = smoothstep(5.8, 11.5, dRoom); // 0 inside room pad, 1 outside
      if (roomMask < 1) {
        const idx = r * cols + c;
        const oldH = heights[idx];
        const edgeDist = Math.min(FOREST_SAMPLE_HALF - Math.abs(x), FOREST_SAMPLE_HALF - Math.abs(z));
        const edgeFeather = smoothstep(0, 3.5, edgeDist);
        const blended = padH * (1 - roomMask) + oldH * roomMask;
        heights[idx] = q3(blended * edgeFeather);
      }
    }
  }

  return {
    ...base,
    heights,
  };
}

function isInsideStage04ACompound(x: number, z: number, pad = 0): boolean {
  // 8x4 cabin + porch yard: x in [-12.8, -1.2], z in [-10.0, -0.8]
  if (
    x >= -12.8 - pad &&
    x <= -1.2 + pad &&
    z >= -10.0 - pad &&
    z <= -0.8 + pad
  ) {
    return true;
  }
  // 4x4 test room + porch yard: x in [-15.8, -8.2], z in [-0.8, 8.6]
  if (
    x >= -15.8 - pad &&
    x <= -8.2 + pad &&
    z >= -0.8 - pad &&
    z <= 8.6 + pad
  ) {
    return true;
  }
  return false;
}

/**
 * Builds the Stage 04A `forest_assets_preview` WorldDefinition:
 * - 96x96 stylized forest with GLB trees, rocks, undergrowth, and winding dirt road
 * - Replaces the legacy procedural cabin with the Stage 04A `cabin_8x4` (with loft & `wood_stairs_01`)
 *   and `room_4x4` (furnished test room), covering all 8 building GLBs, 6 interior furniture GLBs,
 *   and 3 loot container GLBs with segmented colliders and item anchors.
 */
export function createForestAssetsPreviewWorld(
  opts: {
    publicLayoutSeed?: number;
    worldVersion?: number;
    chunkSize?: number;
    layoutOpts?: Stage04APreviewLayoutOptions;
  } = {},
): WorldDefinition & { stage04aLayout: Stage04APreviewLayout } {
  const worldVersion = opts.worldVersion ?? CURRENT_WORLD_VERSION;
  const publicLayoutSeed = opts.publicLayoutSeed ?? DEFAULT_PUBLIC_LAYOUT_SEED;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const baseWorld = createForestSampleWorld({ publicLayoutSeed, worldVersion, chunkSize });
  const terrain = buildForestAssetsPreviewTerrain(publicLayoutSeed);
  const stage04aLayout = buildStage04APreviewLayout(terrain, chunkSize, opts.layoutOpts);

  // Filter out the legacy procedural cabin and any forest props/trees/rocks inside the Stage 04A compound
  const excludedSourceIds = new Set<string>(['forest_cabin_main']);
  for (const vis of baseWorld.visuals) {
    if (vis.sourceObjectId === 'forest_cabin_main' || vis.batchMode === 'static_box') {
      excludedSourceIds.add(vis.sourceObjectId);
      continue;
    }
    const px = vis.transform.position.x;
    const pz = vis.transform.position.z;
    const pad = vis.category === 'tree' || vis.category === 'rock' ? 1.8 : 0.8;
    if (isInsideStage04ACompound(px, pz, pad)) {
      excludedSourceIds.add(vis.sourceObjectId);
    }
  }

  const forestVisuals: VisualDescriptor[] = [];
  for (const vis of baseWorld.visuals) {
    if (excludedSourceIds.has(vis.sourceObjectId)) continue;
    const px = vis.transform.position.x;
    const pz = vis.transform.position.z;
    const groundY = sampleTerrainHeight(terrain, px, pz);
    const yOffset = vis.batchKey === 'foliage:leaf_patch' ? 0.018 : 0;
    forestVisuals.push({
      ...vis,
      transform: {
        ...vis.transform,
        position: {
          x: px,
          y: q3(groundY + yOffset),
          z: pz,
        },
      },
    });
  }

  const forestColliders: ColliderBox[] = [];
  for (const col of baseWorld.colliders) {
    if (col.sourceObjectId && excludedSourceIds.has(col.sourceObjectId)) continue;
    if (col.id.startsWith('forest_cabin_main:')) continue;
    const cx = q3((col.min.x + col.max.x) * 0.5);
    const cz = q3((col.min.z + col.max.z) * 0.5);
    if (isInsideStage04ACompound(cx, cz, 1.8)) continue;

    if (col.tag === 'tree') {
      const trunkRadius = q3((col.max.x - col.min.x) * 0.5);
      forestColliders.push(
        createGroundedTreeCollider(col.sourceObjectId ?? col.id, terrain, cx, cz, trunkRadius, 4.4),
      );
    } else if (col.tag === 'rock') {
      const sx = q3((col.max.x - col.min.x) / 1.04);
      const sy = q3((col.max.y - col.min.y) / 1.14);
      const sz = q3((col.max.z - col.min.z) / 1.04);
      forestColliders.push(
        createGroundedRockCollider(col.sourceObjectId ?? col.id, terrain, cx, cz, {
          x: sx,
          y: sy,
          z: sz,
        }),
      );
    } else {
      forestColliders.push(col);
    }
  }

  const spawnPoints: SpawnPointDef[] = baseWorld.spawnPoints.map((sp) => ({
    ...sp,
    y: q3(sampleTerrainHeight(terrain, sp.x, sp.z)),
  }));

  const colliders: ColliderBox[] = [...stage04aLayout.colliders, ...forestColliders];
  const visuals: VisualDescriptor[] = [...stage04aLayout.visuals, ...forestVisuals];
  const locations: WorldLocation[] = [
    ...stage04aLayout.locations,
    ...baseWorld.locations.filter((l) => l.id !== 'loc_ranger_cabin'),
  ];
  const containerLocations: ContainerLocation[] = [...stage04aLayout.containerLocations];

  const baseData = {
    mapId: 'forest_assets_preview' as const,
    worldVersion,
    publicLayoutSeed,
    bounds: baseWorld.bounds,
    terrain,
    colliders,
    spawnPoints,
    locations,
    containerLocations,
  };

  return {
    ...baseData,
    name: 'Forest Assets Preview (04A Binolar & Interyer)',
    chunkSize,
    visuals,
    gameplayHash: computeGameplayHash(baseData),
    stage04aLayout,
  };
}
