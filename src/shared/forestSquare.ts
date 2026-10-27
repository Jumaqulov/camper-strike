import { PLAYER_RADIUS } from './constants';
import { isHardForestPropPrefab } from './forestProps';
import { q3 } from './math';
import {
  getForestSquareRoadNetwork,
  sampleForestSquareRoad,
  type ForestSquareRoadPolyline,
  type ForestSquareRoadSample,
} from './forestSquareRoads';
import { buildForestSquareSpawns, SPAWN_CLEARANCE_RADIUS } from './forestSquareSpawns';
import {
  buildForestSquareTerrain,
  sampleForestSquareTerrainColor,
} from './forestSquareTerrain';
import {
  buildForestSquareVegetation,
  type ForestSquareVegetationResult,
} from './forestSquareVegetation';
import { TREE_SPECIES_BATCH_KEYS, type TreeSpeciesBatchKey } from './forestSample';
import {
  FOREST_SQUARE_HALF,
  FOREST_SQUARE_SIZE,
  getForestSquarePoiSites,
  type ForestSquarePoiSiteSpec,
  type MultiSiteStructureLayout,
  type Stage04APreviewLayout,
} from './structures/contracts';
import {
  buildForestSquarePOILayout,
  getPoiBuildingFootprints,
  type ForestSquarePOILayoutOptions,
} from './structures/forestSquarePOIs';
import { sampleTerrainHeight } from './terrain';
import {
  computeGameplayHash,
  createSeededRng,
  CURRENT_WORLD_VERSION,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_PUBLIC_LAYOUT_SEED,
  getChunkCoord,
  type ColliderBox,
  type ContainerLocation,
  type SpawnPointDef,
  type VisualDescriptor,
  type WorldBounds,
  type WorldDefinition,
  type WorldLocation,
} from './world';

export {
  buildForestSquarePOILayout,
  buildForestSquareSpawns,
  buildForestSquareTerrain,
  buildForestSquareVegetation,
  FOREST_SQUARE_HALF,
  FOREST_SQUARE_SIZE,
  getForestSquarePoiSites,
  getForestSquareRoadNetwork,
  getPoiBuildingFootprints,
  sampleForestSquareRoad,
  sampleForestSquareTerrainColor,
  type ForestSquarePOILayoutOptions,
  type ForestSquarePoiSiteSpec,
  type ForestSquareRoadPolyline,
  type ForestSquareRoadSample,
  type ForestSquareVegetationResult,
  type MultiSiteStructureLayout,
};


/** Existing Stage 04B rule: decorative (non-tree/rock) visuals within this radius of a spawn are removed. */
export const SPAWN_VISUAL_FILTER_RADIUS = 1.8;
/**
 * Stage 08-FIX: a hard prop (log/stump) is removed when its collider footprint, expanded by this
 * margin, contains a spawn point. `0.6 m` prop margin + `PLAYER_RADIUS` capsule, but never less than the
 * spawn generator's own clearance radius (+5 cm) so spawns stay valid with prop colliders included.
 */
export const SPAWN_HARD_PROP_CLEARANCE = Math.max(0.6 + PLAYER_RADIUS, SPAWN_CLEARANCE_RADIUS) + 0.05;

/**
 * Returns the `sourceObjectId`s of hard props (fallen logs / stumps) that must be dropped (visual AND
 * colliders) because they sit within `SPAWN_VISUAL_FILTER_RADIUS` of a spawn or their collider footprint
 * (+`SPAWN_HARD_PROP_CLEARANCE`) intrudes on a spawn's player capsule.
 */
export function selectHardPropsNearSpawns(
  visuals: readonly VisualDescriptor[],
  propColliders: readonly ColliderBox[],
  spawnPoints: readonly SpawnPointDef[],
): Set<string> {
  const collidersBySource = new Map<string, ColliderBox[]>();
  for (const col of propColliders) {
    if (col.sourceObjectId === undefined) continue;
    const list = collidersBySource.get(col.sourceObjectId);
    if (list) list.push(col);
    else collidersBySource.set(col.sourceObjectId, [col]);
  }

  const removed = new Set<string>();
  const m = SPAWN_HARD_PROP_CLEARANCE;
  for (const vis of visuals) {
    if (!isHardForestPropPrefab(vis.prefabId)) continue;
    const vx = vis.transform.position.x;
    const vz = vis.transform.position.z;
    const cols = collidersBySource.get(vis.sourceObjectId) ?? [];
    let near = false;
    for (const sp of spawnPoints) {
      if (Math.hypot(vx - sp.x, vz - sp.z) < SPAWN_VISUAL_FILTER_RADIUS) {
        near = true;
        break;
      }
      for (const c of cols) {
        if (
          sp.x > c.min.x - m &&
          sp.x < c.max.x + m &&
          sp.z > c.min.z - m &&
          sp.z < c.max.z + m
        ) {
          near = true;
          break;
        }
      }
      if (near) break;
    }
    if (near) removed.add(vis.sourceObjectId);
  }
  return removed;
}

export interface CreateForestSquareWorldOptions {
  publicLayoutSeed?: number;
  worldVersion?: number;
  chunkSize?: number;
  layoutOpts?: ForestSquarePOILayoutOptions;
}

export type ForestSquareWorldDefinition = WorldDefinition & {
  poiLayout: MultiSiteStructureLayout;
  stage04aLayout: Stage04APreviewLayout;
  roadNetwork: ForestSquareRoadPolyline[];
};

// Deterministic cache by (seed, worldVersion, chunkSize, openFractions) to keep repeated lookups instant
const cachedForestSquareWorlds = new Map<string, ForestSquareWorldDefinition>();

function freezeWorldDefinitionDeep<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      freezeWorldDefinitionDeep(obj[i]);
    }
  } else {
    const rec = obj as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      freezeWorldDefinitionDeep(rec[key]);
    }
  }
  return obj;
}

/**
 * Builds the Stage 04B `forest_square` (256×256 m) playable forest world:
 * - Continuous 256×256 heightfield (`129×129` samples, `2m` cell step) with hills, basins, glades, rocky crags, and smooth POI pads
 * - Winding main forest road + branch trails connecting all 6 distinct searchable POIs
 * - 6 POIs (`poi_ranger_house`, `poi_cabin_cluster`, `poi_lumber_mill`, `poi_service_station`, `poi_forest_camp`, `poi_cliff_watch`)
 *   with 9 enterable modular buildings across 0°/90°/180°/270° yaw rotations, 59 interior furniture placements, and 26 loot containers
 * - ~565 collidable trees (5 GLB species), ~95 mossy boulders, ~220 bushes, and ~1,235 undergrowth instances
 * - Stage 08-FIX: solid fallen logs (segmented AABBs) and tree stumps carry `'prop'` colliders sharing `sourceObjectId`
 *   with their visuals; props intruding on spawn clearance are dropped (visual + colliders together)
 * - 36 grounded, collision-free spawn points (12 red, 12 blue, 12 FFA)
 */
export function createForestSquareWorld(
  opts: CreateForestSquareWorldOptions = {},
): ForestSquareWorldDefinition {
  const worldVersion = opts.worldVersion ?? CURRENT_WORLD_VERSION;
  const publicLayoutSeed = opts.publicLayoutSeed ?? DEFAULT_PUBLIC_LAYOUT_SEED;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const cabOpen = opts.layoutOpts?.cabinetOpenFraction ?? 0;
  const cntOpen = opts.layoutOpts?.containerOpenFraction ?? 0;

  const cacheKey = `${publicLayoutSeed}:${worldVersion}:${chunkSize}:${cabOpen}:${cntOpen}`;
  const cached = cachedForestSquareWorlds.get(cacheKey);
  if (cached) {
    return cached;
  }

  const terrain = buildForestSquareTerrain(publicLayoutSeed);
  const poiSites = getForestSquarePoiSites(publicLayoutSeed);
  const roadNetwork = getForestSquareRoadNetwork(publicLayoutSeed);
  const roadDistSampler = (x: number, z: number): number =>
    sampleForestSquareRoad(x, z, publicLayoutSeed).dist;

  // 1. Build 6 POI compounds (9 rotated/unrotated modular buildings, 59 interiors, 26 containers, yard props)
  const poiLayout = buildForestSquarePOILayout(
    terrain,
    publicLayoutSeed,
    chunkSize,
    opts.layoutOpts,
  );

  // 2. Build multi-biome forest vegetation & rocks respecting roads, POI pads, and building footprints
  const vegetation = buildForestSquareVegetation({
    terrain,
    seed: publicLayoutSeed,
    poiSites,
    structureColliders: poiLayout.colliders,
    roadDistSampler,
    chunkSize,
  });

  // Spawns are computed from POI + tree + rock colliders only, so adding hard prop colliders
  // (Stage 08-FIX) does not move any of the 36 spawn points.
  const spawnBaseColliders: ColliderBox[] = [
    ...poiLayout.colliders,
    ...vegetation.treeColliders,
    ...vegetation.rockColliders,
  ];

  // 3. Build 36 safe, grounded, collision-free spawn points (12 red, 12 blue, 12 none)
  const spawnPoints: SpawnPointDef[] = buildForestSquareSpawns({
    terrain,
    seed: publicLayoutSeed,
    poiSites,
    allColliders: spawnBaseColliders,
    roadDistSampler,
  });

  // 4a. Stage 08-FIX: drop hard props (fallen logs / stumps) near spawns — visual AND colliders together,
  //     so there is never an invisible wall or a walk-through solid visual.
  const removedHardPropIds = selectHardPropsNearSpawns(
    vegetation.visuals,
    vegetation.propColliders,
    spawnPoints,
  );
  const keptPropColliders = vegetation.propColliders.filter(
    (col) => col.sourceObjectId === undefined || !removedHardPropIds.has(col.sourceObjectId),
  );

  const colliders: ColliderBox[] = [...spawnBaseColliders, ...keptPropColliders];

  // 4b. Filter out any non-collidable bush visual (and removed log/stump) within 1.8m of a spawn point so spawn sightlines stay clean
  const filteredVegVisuals = vegetation.visuals.filter((vis) => {
    if (vis.category === 'tree' || vis.category === 'rock') return true;
    if (isHardForestPropPrefab(vis.prefabId)) {
      return !removedHardPropIds.has(vis.sourceObjectId);
    }
    const vx = vis.transform.position.x;
    const vz = vis.transform.position.z;
    for (let i = 0; i < spawnPoints.length; i++) {
      const sp = spawnPoints[i];
      if (Math.hypot(vx - sp.x, vz - sp.z) < SPAWN_VISUAL_FILTER_RADIUS) {
        return false;
      }
    }
    return true;
  });

  // 5. Add distant perimeter vista trees outside [-128, 128] (visual-only horizon framing)
  const vistaRng = createSeededRng(publicLayoutSeed ^ 0x91e10da5);
  const vistaVisuals: VisualDescriptor[] = [];
  const vistaTreeCount = 72;
  for (let i = 0; i < vistaTreeCount; i++) {
    const ang = (i / vistaTreeCount) * Math.PI * 2 + (vistaRng() - 0.5) * 0.06;
    const dist = FOREST_SQUARE_HALF + 6 + vistaRng() * 20;
    const vx = q3(Math.cos(ang) * dist);
    const vz = q3(Math.sin(ang) * dist);
    const species: TreeSpeciesBatchKey =
      TREE_SPECIES_BATCH_KEYS[i % TREE_SPECIES_BATCH_KEYS.length];
    const scaleXZ = q3(0.95 + vistaRng() * 0.45);
    const scaleY = q3(1.0 + vistaRng() * 0.5);
    const groundY = sampleTerrainHeight(terrain, vx, vz);
    const chunk = getChunkCoord(vx, vz, chunkSize);

    vistaVisuals.push({
      id: `sq_vista_tree_${i}:vis`,
      sourceObjectId: `sq_vista_tree_${i}`,
      prefabId: species,
      category: 'tree',
      batchKey: species,
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'all',
      maxDrawDistance: 230,
      transform: {
        position: { x: vx, y: q3(groundY), z: vz },
        yaw: q3(vistaRng() * Math.PI * 2),
        scale: { x: scaleXZ, y: scaleY, z: scaleXZ },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  const visuals: VisualDescriptor[] = [
    ...poiLayout.visuals,
    ...filteredVegVisuals,
    ...vistaVisuals,
  ];

  // 6. Named locations (all 6 searchable POIs + 2 scenic forest landmarks)
  const locations: WorldLocation[] = [
    ...poiLayout.locations,
    {
      id: 'loc_sq_central_crossroads',
      name: "Markaziy O'rmon Chorrahasi",
      kind: 'clearing',
      position: {
        x: 6,
        y: q3(sampleTerrainHeight(terrain, 6, -6)),
        z: -6,
      },
      yaw: 0,
      radius: 14,
      enterable: false,
    },
    {
      id: 'loc_sq_south_glade',
      name: 'Janubiy Qayinzor Yalangligi',
      kind: 'clearing',
      position: {
        x: -14,
        y: q3(sampleTerrainHeight(terrain, -14, 52)),
        z: 52,
      },
      yaw: 0,
      radius: 16,
      enterable: false,
    },
  ];

  const containerLocations: ContainerLocation[] = [...poiLayout.containerLocations];

  const bounds: WorldBounds = {
    minX: -FOREST_SQUARE_HALF,
    maxX: FOREST_SQUARE_HALF,
    minY: -8,
    maxY: 42,
    minZ: -FOREST_SQUARE_HALF,
    maxZ: FOREST_SQUARE_HALF,
  };

  const baseData = {
    mapId: 'forest_square' as const,
    worldVersion,
    publicLayoutSeed,
    bounds,
    terrain,
    colliders,
    spawnPoints,
    locations,
    containerLocations,
  };

  const result: ForestSquareWorldDefinition = {
    ...baseData,
    name: "Katta O'rmon (256×256, 6 POI)",
    chunkSize,
    visuals,
    gameplayHash: computeGameplayHash(baseData),
    poiLayout,
    stage04aLayout: poiLayout,
    roadNetwork,
  };

  freezeWorldDefinitionDeep(result);

  if (cachedForestSquareWorlds.size >= 16) {
    const oldestKey = cachedForestSquareWorlds.keys().next().value;
    if (oldestKey !== undefined) {
      cachedForestSquareWorlds.delete(oldestKey);
    }
  }
  cachedForestSquareWorlds.set(cacheKey, result);

  return result;
}
