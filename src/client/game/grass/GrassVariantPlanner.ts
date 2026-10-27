import { sampleForestSquareRoad } from '../../../shared/forestSquareRoads';
import { buildForestSquareTerrain } from '../../../shared/forestSquareTerrain';
import { createForestSquareWorld } from '../../../shared/forestSquare';
import { sampleTerrainSlopeDeg } from '../../../shared/terrain';
import type { GroundCoverKind } from '../../../shared/groundCover';
import type { HeightfieldTerrainDescriptor, WorldDefinition } from '../../../shared/world';
import { GrassTreeGrid } from './GrassTreeGrid';
import { maxScaleForVariant, type GrassVariantId } from './grassVariantData';

// Sof ma'lumotlar `grassVariantData.ts` da (registry bilan umumiy); bu yerdan qayta eksport —
// testlar va eski import yo'llari uchun.
export {
  CATEGORY_MAX_SCALE,
  getVariantCategory,
  GRASS_VARIANT_HEIGHT,
  GRASS_VARIANT_IDS,
  GRASS_VARIANT_MAX_SCALE,
  maxScaleForVariant,
  MAX_WORLD_HEIGHT,
  type GrassVariantCategory,
  type GrassVariantId,
} from './grassVariantData';

export interface PlannedGrassInstance {
  variantId: GrassVariantId;
  yaw: number;
  scale: number;
}

/**
 * Pure 100% deterministic 3D hash returning uniform [0, 1) float.
 * Math.random() is strictly forbidden.
 */
export function hashInstance(
  x: number,
  y: number,
  z: number,
  seed: number,
  salt = 0,
): number {
  const ix = Math.round(x * 100) | 0;
  const iy = Math.round(y * 100) | 0;
  const iz = Math.round(z * 100) | 0;
  let h =
    Math.imul(ix, 374761393) ^
    Math.imul(iy, 1274126177) ^
    Math.imul(iz, 668265263) ^
    Math.imul(seed, 1442695041) ^
    Math.imul(salt, 2246822519);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Chaqiruvchi beradigan kontekst: jonli dunyo daraxtlari va relyefi. Berilsa planner
 * `createForestSquareWorld` ni qayta qurmaydi (seed bo'yicha keshlangan zaxira yo'li
 * faqat kontekstsiz chaqiruvlar — masalan testlar — uchun qoladi).
 */
export interface GrassPlannerContext {
  treeGrid?: GrassTreeGrid;
  terrain?: HeightfieldTerrainDescriptor;
}

/**
 * Jonli `WorldDefinition` dan planner konteksti: `world.visuals` dagi daraxt pozitsiyalari
 * (`category === 'tree'`) va heightfield relyef. Flat relyefli dunyoda `terrain` undefined qoladi
 * (seed bo'yicha zaxira yo'l ishlaydi).
 */
export function createGrassPlannerContext(world: WorldDefinition): GrassPlannerContext {
  const treeList: Array<{ x: number; z: number }> = [];
  for (const v of world.visuals) {
    if (v.category === 'tree') {
      treeList.push({ x: v.transform.position.x, z: v.transform.position.z });
    }
  }
  return {
    treeGrid: new GrassTreeGrid(treeList),
    terrain: world.terrain,
  };
}

// Kontekstsiz chaqiruvlar uchun seed bo'yicha ichki keshlar (so'rovlar mikrosekund darajasida qolsin)
const treeGridCache = new Map<number, GrassTreeGrid>();
const terrainCache = new Map<number, HeightfieldTerrainDescriptor>();

export function setCustomTreePositions(
  seed: number,
  trees: ReadonlyArray<{ x: number; z: number }>,
): void {
  treeGridCache.set(seed, new GrassTreeGrid(trees));
}

export function clearGrassVariantPlannerCache(): void {
  treeGridCache.clear();
  terrainCache.clear();
}

function getTreeGrid(seed: number, ctx?: GrassPlannerContext): GrassTreeGrid {
  if (ctx?.treeGrid) return ctx.treeGrid;
  let grid = treeGridCache.get(seed);
  if (!grid) {
    try {
      const world = createForestSquareWorld({ publicLayoutSeed: seed });
      const treeList: Array<{ x: number; z: number }> = [];
      for (const v of world.visuals) {
        if (v.category === 'tree') {
          treeList.push({
            x: v.transform.position.x,
            z: v.transform.position.z,
          });
        }
      }
      grid = new GrassTreeGrid(treeList);
    } catch {
      grid = new GrassTreeGrid([]);
    }
    treeGridCache.set(seed, grid);
  }
  return grid;
}

function getTerrain(seed: number, ctx?: GrassPlannerContext): HeightfieldTerrainDescriptor {
  if (ctx?.terrain) return ctx.terrain;
  let terrain = terrainCache.get(seed);
  if (!terrain) {
    terrain = buildForestSquareTerrain(seed);
    terrainCache.set(seed, terrain);
  }
  return terrain;
}

/**
 * Computes road inward direction vector and yaw towards road center.
 */
export function computeRoadInwardDirection(
  x: number,
  z: number,
  seed: number,
): { toRoadX: number; toRoadZ: number; roadNormalYaw: number } {
  const eps = 0.05;
  const distPx = sampleForestSquareRoad(x + eps, z, seed).dist;
  const distMx = sampleForestSquareRoad(x - eps, z, seed).dist;
  const distPz = sampleForestSquareRoad(x, z + eps, seed).dist;
  const distMz = sampleForestSquareRoad(x, z - eps, seed).dist;
  const toRoadX = -(distPx - distMx) / (2 * eps);
  const toRoadZ = -(distPz - distMz) / (2 * eps);
  // Three.js Y rotation: local +X transforms to (cos(yaw), 0, -sin(yaw)).
  // For local +X (blade curvature) to face toRoad (toRoadX, toRoadZ):
  // cos(yaw) ~ toRoadX, -sin(yaw) ~ toRoadZ => sin(yaw) ~ -toRoadZ.
  const roadNormalYaw = Math.atan2(-toRoadZ, toRoadX);
  return { toRoadX, toRoadZ, roadNormalYaw };
}

function isCragOrSteepSlope(x: number, z: number, seed: number, ctx?: GrassPlannerContext): boolean {
  const terrain = getTerrain(seed, ctx);
  const slopeDeg = sampleTerrainSlopeDeg(terrain, x, z);
  if (slopeDeg > 25) return true;

  // Rocky crag centers in forest_square
  const dCragNW = Math.hypot((x - -108) / 8.0, (z - -106) / 7.5);
  if (dCragNW < 1.0) return true;
  const dCragSE = Math.hypot((x - 104) / 8.5, (z - 96) / 7.5);
  if (dCragSE < 1.0) return true;

  return false;
}

/**
 * Deterministic Biome Grass Variant Planner.
 *
 * Maps a generic GroundCoverKind instance into one of 17 stylized Claude GLB models
 * respecting road shoulders, tree canopy shade, hollows, crags, and open meadows,
 * with strict PvP scale capping.
 */
export function planGrassVariant(
  x: number,
  y: number,
  z: number,
  baseKind: GroundCoverKind,
  baseYaw: number,
  baseScale: number,
  seed: number,
  ctx?: GrassPlannerContext,
): PlannedGrassInstance {
  let variantId: GrassVariantId;
  let yaw = baseYaw;

  if (baseKind === 'flower_white') {
    variantId = 'flower_white_01';
  } else if (baseKind === 'flower_yellow') {
    variantId = 'flower_yellow_01';
  } else if (baseKind === 'flower_purple') {
    variantId = 'flower_purple_01';
  } else if (baseKind === 'fern_small') {
    // Zone 2 Fern undergrowth colonies: beneath mature tree canopies and in shady hollows
    const isUnderstory = y < -1.8 || getTreeGrid(seed, ctx).hasTreeWithin(x, z, 2.5);
    const roll = hashInstance(x, y, z, seed, 0xfe3);
    if (isUnderstory) {
      // 55% fern_small_01, 45% fern_wide_01 for rich undergrowth colonies
      variantId = roll < 0.55 ? 'fern_small_01' : 'fern_wide_01';
    } else {
      // Open / edge ferns
      variantId = roll < 0.72 ? 'fern_small_01' : 'fern_wide_01';
    }
  } else {
    // baseKind === 'grass_tuft' || baseKind === 'grass_short'
    const road = sampleForestSquareRoad(x, z, seed);

    if (road.dist >= 1.05 && road.dist <= 3.2) {
      // Zone 3: Road Shoulders (dist 1.05m - 3.2m):
      // Specific path-edge grass grass_path_edge_01 oriented with its main blade curvature (+X)
      // leaning gently towards the center of the road, giving roads natural organic borders.
      variantId = 'grass_path_edge_01';
      const inward = computeRoadInwardDirection(x, z, seed);
      if (Math.hypot(inward.toRoadX, inward.toRoadZ) > 1e-4) {
        // Natural organic lean towards the road centerline with slight deterministic variation (+- 0.15 rad)
        const jitter = (hashInstance(x, y, z, seed, 0x70ad) - 0.5) * 0.3;
        yaw = inward.roadNormalYaw + jitter;
      }
    } else if (y < -1.8 || getTreeGrid(seed, ctx).hasTreeWithin(x, z, 2.2)) {
      // Zone 2: Deep Tree Canopy & Shaded Hollows (within 5m of tree bases or hollow y < 0.2)
      // Shade-loving grasses: grass_wavy_broad_01 (38%), grass_shade_dark_01 (34%), grass_forest_sparse_01 (28%)
      const roll = hashInstance(x, y, z, seed, 0x54ad);
      if (roll < 0.42) {
        variantId = 'grass_wavy_broad_01';
      } else if (roll < 0.74) {
        variantId = 'grass_shade_dark_01';
      } else {
        variantId = 'grass_forest_sparse_01';
      }
    } else if (isCragOrSteepSlope(x, z, seed, ctx)) {
      // Dry crag or steep slope > 25°
      const roll = hashInstance(x, y, z, seed, 0xca6);
      variantId = roll < 0.5 ? 'grass_dry_straw_01' : 'grass_olive_tuft_01';
    } else {
      // Zone 1: Sunlit Glades & Open Meadows:
      // Prominently features wider silhouette models (grass_meadow_wide_01, grass_short_dense_01, grass_wavy_broad_01)
      const roll = hashInstance(x, y, z, seed, 0x3e1d);
      if (roll < 0.30) {
        variantId = 'grass_meadow_wide_01';
      } else if (roll < 0.55) {
        variantId = 'grass_short_dense_01';
      } else if (roll < 0.67) {
        variantId = 'grass_wavy_broad_01';
      } else if (roll < 0.80) {
        variantId = 'grass_short_soft_01';
      } else if (roll < 0.86) {
        variantId = 'grass_meadow_thin_01';
      } else if (roll < 0.90) {
        variantId = 'grass_dry_straw_01';
      } else if (roll < 0.94) {
        variantId = 'grass_olive_tuft_01';
      } else if (roll < 0.97) {
        variantId = 'grass_tall_wild_01';
      } else {
        variantId = 'grass_tall_seeded_01';
      }
    }
  }

  // Silhouette volume enhancement: slightly scale up wider silhouette models
  // so up-close 1P/3P views have fuller, thicker, more stylized volume
  let adjustedScale = baseScale;
  if (variantId === 'grass_meadow_wide_01') {
    adjustedScale = baseScale * 1.18;
  } else if (variantId === 'grass_wavy_broad_01') {
    adjustedScale = baseScale * 1.20;
  } else if (variantId === 'grass_short_dense_01') {
    adjustedScale = baseScale * 1.22;
  } else if (variantId === 'grass_short_soft_01') {
    adjustedScale = baseScale * 1.15;
  } else if (variantId === 'grass_path_edge_01') {
    adjustedScale = baseScale * 1.12;
  } else if (variantId === 'fern_wide_01') {
    adjustedScale = Math.max(0.85, baseScale * 0.98);
  }

  // Strict PvP scale clamping: guarantees height <= 0.45m (grass), <= 0.35m (flower), <= 0.60m (fern)
  const maxScale = maxScaleForVariant(variantId);
  const scale = Math.min(adjustedScale, maxScale);

  return { variantId, yaw, scale };
}
