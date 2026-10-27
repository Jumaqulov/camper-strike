import { clamp, q3 } from './math';
import { buildFallenLogColliders, buildTreeStumpCollider } from './forestProps';
import { TREE_SPECIES_BATCH_KEYS, type TreeSpeciesBatchKey } from './forestSample';
import {
  getForestSquarePoiSites,
  type ForestSquarePoiSiteSpec,
} from './structures/contracts';
import {
  createGroundedRockCollider,
  createGroundedTreeCollider,
  sampleTerrainHeight,
  sampleTerrainSlopeDeg,
} from './terrain';
import {
  createSeededRng,
  DEFAULT_CHUNK_SIZE,
  getChunkCoord,
  type ColliderBox,
  type TerrainDescriptor,
  type VisualDescriptor,
} from './world';


export const FOREST_SQUARE_PLAYABLE_LIMIT = 122;

export interface ForestSquareVegetationOptions {
  terrain: TerrainDescriptor;
  seed: number;
  poiSites?: ForestSquarePoiSiteSpec[];
  structureColliders?: readonly ColliderBox[];
  roadDistSampler: (x: number, z: number) => number;
  chunkSize?: number;
}

export interface ForestSquareVegetationResult {
  treeColliders: ColliderBox[];
  rockColliders: ColliderBox[];
  /**
   * Stage 08-FIX: hard prop colliders for `prop:fallen_log` (segmented `${id}:col:seg{i}`) and
   * `prop:tree_stump` (`${id}:col`), each sharing `sourceObjectId` with its visual. Soft layers
   * (bush/fern/grass/pebble/leaf litter) never get colliders.
   */
  propColliders: ColliderBox[];
  visuals: VisualDescriptor[];
  treeCount: number;
  rockCount: number;
  bushCount: number;
  undergrowthCount: number;
}

interface PlacedCircle {
  x: number;
  z: number;
  radius: number;
  species?: TreeSpeciesBatchKey;
}

interface GroveClusterSpec {
  x: number;
  z: number;
  radius: number;
  preferred: TreeSpeciesBatchKey;
  secondary: TreeSpeciesBatchKey;
}

/**
 * Generates deterministic multi-biome trees, mossy boulders, bushes, fallen logs,
 * tree stumps, ferns, grass tufts, roadside pebbles, and leaf litter across the
 * 256x256 m `forest_square` map while strictly respecting road, POI, structure,
 * slope, and trunk-spacing exclusions.
 */
export function buildForestSquareVegetation(
  opts: ForestSquareVegetationOptions,
): ForestSquareVegetationResult {
  const { terrain, seed, roadDistSampler } = opts;
  const poiSites = opts.poiSites ?? getForestSquarePoiSites(seed);
  const structureColliders = opts.structureColliders ?? [];
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const rng = createSeededRng(seed ^ 0x4b01);

  const treeColliders: ColliderBox[] = [];
  const rockColliders: ColliderBox[] = [];
  const propColliders: ColliderBox[] = [];
  const visuals: VisualDescriptor[] = [];

  const placedTrees: PlacedCircle[] = [];
  const placedRocks: PlacedCircle[] = [];

  const findPoi = (id: ForestSquarePoiSiteSpec['id']): ForestSquarePoiSiteSpec | undefined =>
    poiSites.find((s) => s.id === id);

  const lumberMillSite = findPoi('poi_lumber_mill');
  const cliffWatchSite = findPoi('poi_cliff_watch');
  const forestCampSite = findPoi('poi_forest_camp');

  /**
   * Checks whether (x, z) is outside all POI flat pads, POI roadAnchor corridors,
   * road buffers, and structure collider AABBs.
   */
  const isClearOfExclusions = (
    x: number,
    z: number,
    minRoadDist: number,
    poiFlatPadExtra: number,
    poiAnchorPad: number,
    structPad: number,
  ): boolean => {
    if (Math.abs(x) > FOREST_SQUARE_PLAYABLE_LIMIT || Math.abs(z) > FOREST_SQUARE_PLAYABLE_LIMIT) {
      return false;
    }

    if (roadDistSampler(x, z) < minRoadDist) {
      return false;
    }

    for (const site of poiSites) {
      const distCenter = Math.hypot(x - site.center.x, z - site.center.z);
      if (distCenter < site.flatRadius + poiFlatPadExtra) {
        return false;
      }
      const distAnchor = Math.hypot(x - site.roadAnchor.x, z - site.roadAnchor.z);
      if (distAnchor < poiAnchorPad) {
        return false;
      }
    }

    for (const col of structureColliders) {
      if (col.tag === 'ground' || col.tag === 'boundary') continue;
      if (
        x >= col.min.x - structPad &&
        x <= col.max.x + structPad &&
        z >= col.min.z - structPad &&
        z <= col.max.z + structPad
      ) {
        return false;
      }
    }

    return true;
  };

  const isClearOfTreesAndRocks = (x: number, z: number, treePad: number, rockPad: number): boolean => {
    for (const t of placedTrees) {
      if (Math.hypot(x - t.x, z - t.z) < t.radius + treePad) {
        return false;
      }
    }
    for (const r of placedRocks) {
      if (Math.hypot(x - r.x, z - r.z) < r.radius + rockPad) {
        return false;
      }
    }
    return true;
  };

  // Biome-aware grove clusters distributed across the 256x256 map
  const groveClusters: GroveClusterSpec[] = [
    // Northern pine & spruce highlands (z < -40)
    { x: -102, z: -98, radius: 24, preferred: 'tree:pine_tall', secondary: 'tree:spruce_broad' },
    { x: -32, z: -96, radius: 26, preferred: 'tree:spruce_broad', secondary: 'tree:pine_tall' },
    { x: 24, z: -94, radius: 25, preferred: 'tree:pine_tall', secondary: 'tree:pine_leaning' },
    { x: 100, z: -96, radius: 24, preferred: 'tree:spruce_broad', secondary: 'tree:pine_tall' },
    { x: -104, z: -34, radius: 22, preferred: 'tree:pine_tall', secondary: 'tree:spruce_broad' },
    { x: 102, z: -28, radius: 23, preferred: 'tree:spruce_broad', secondary: 'tree:pine_leaning' },

    // Mid-northern & central transition woods
    { x: -24, z: -42, radius: 22, preferred: 'tree:pine_tall', secondary: 'tree:birch_deciduous' },
    { x: 68, z: -18, radius: 24, preferred: 'tree:spruce_broad', secondary: 'tree:birch_deciduous' },
    { x: -26, z: -6, radius: 22, preferred: 'tree:birch_deciduous', secondary: 'tree:pine_tall' },

    // Around Lumber Mill (west) & Cliff Watch Ruins (SE): weathered & ancient dead trees mixed in
    { x: -106, z: 18, radius: 22, preferred: 'tree:tree_ancient_dead', secondary: 'tree:pine_leaning' },
    { x: -42, z: 26, radius: 22, preferred: 'tree:pine_leaning', secondary: 'tree:tree_ancient_dead' },
    { x: 102, z: 42, radius: 22, preferred: 'tree:tree_ancient_dead', secondary: 'tree:pine_tall' },
    { x: 36, z: 88, radius: 22, preferred: 'tree:pine_leaning', secondary: 'tree:tree_ancient_dead' },

    // Central & southern sunlit birch / mixed glades (z > 15)
    { x: -12, z: 46, radius: 25, preferred: 'tree:birch_deciduous', secondary: 'tree:pine_tall' },
    { x: 26, z: 38, radius: 24, preferred: 'tree:birch_deciduous', secondary: 'tree:spruce_broad' },
    { x: -98, z: 64, radius: 24, preferred: 'tree:spruce_broad', secondary: 'tree:birch_deciduous' },
    { x: -96, z: 102, radius: 23, preferred: 'tree:birch_deciduous', secondary: 'tree:pine_leaning' },
    { x: -18, z: 98, radius: 25, preferred: 'tree:birch_deciduous', secondary: 'tree:spruce_broad' },
    { x: 98, z: 102, radius: 22, preferred: 'tree:pine_tall', secondary: 'tree:tree_ancient_dead' },
    { x: 76, z: 18, radius: 23, preferred: 'tree:spruce_broad', secondary: 'tree:pine_tall' },
  ];

  const pickBiomeSpecies = (x: number, z: number, groundY: number): TreeSpeciesBatchKey => {
    const r = rng();

    // Near Lumber Mill or Cliff Watch ruins: higher mix of ancient dead & leaning pines
    const distLumber = lumberMillSite
      ? Math.hypot(x - lumberMillSite.center.x, z - lumberMillSite.center.z)
      : 999;
    const distRuins = cliffWatchSite
      ? Math.hypot(x - cliffWatchSite.center.x, z - cliffWatchSite.center.z)
      : 999;

    if (distLumber < 48 || distRuins < 48) {
      if (r < 0.28) return 'tree:tree_ancient_dead';
      if (r < 0.52) return 'tree:pine_leaning';
      if (r < 0.74) return 'tree:pine_tall';
      if (r < 0.90) return 'tree:spruce_broad';
      return 'tree:birch_deciduous';
    }

    // Northern sector or elevated hills: conifer-dominant (pine_tall & spruce_broad)
    if (z < -28 || groundY > 1.75) {
      if (r < 0.42) return 'tree:pine_tall';
      if (r < 0.78) return 'tree:spruce_broad';
      if (r < 0.90) return 'tree:pine_leaning';
      if (r < 0.96) return 'tree:birch_deciduous';
      return 'tree:tree_ancient_dead';
    }

    // Central & southern glades: deciduous birch-rich mixed woodland
    if (z > 8 && groundY <= 1.75) {
      if (r < 0.36) return 'tree:birch_deciduous';
      if (r < 0.60) return 'tree:pine_tall';
      if (r < 0.80) return 'tree:spruce_broad';
      if (r < 0.93) return 'tree:pine_leaning';
      return 'tree:tree_ancient_dead';
    }

    // Balanced mid-forest distribution across all 5 species
    if (r < 0.31) return 'tree:pine_tall';
    if (r < 0.59) return 'tree:spruce_broad';
    if (r < 0.76) return 'tree:birch_deciduous';
    if (r < 0.90) return 'tree:pine_leaning';
    return 'tree:tree_ancient_dead';
  };

  // ---------------- 1. Trees (520 .. 620 target: 565) ----------------
  const targetTrees = 565;
  const minTreeSpacing = 3.65; // strictly >= 3.6 m
  let treeAttempts = 0;

  while (placedTrees.length < targetTrees && treeAttempts < 12000) {
    treeAttempts++;

    let rawX: number;
    let rawZ: number;
    let preferredSpecies: TreeSpeciesBatchKey | null = null;

    if (rng() < 0.56) {
      const g = groveClusters[Math.floor(rng() * groveClusters.length)];
      const ang = rng() * Math.PI * 2;
      const dist = Math.sqrt(rng()) * g.radius;
      rawX = g.x + Math.cos(ang) * dist;
      rawZ = g.z + Math.sin(ang) * dist;
      const pickRoll = rng();
      if (pickRoll < 0.48) preferredSpecies = g.preferred;
      else if (pickRoll < 0.74) preferredSpecies = g.secondary;
    } else {
      rawX = (rng() * 2 - 1) * FOREST_SQUARE_PLAYABLE_LIMIT;
      rawZ = (rng() * 2 - 1) * FOREST_SQUARE_PLAYABLE_LIMIT;
    }

    const tx = q3(rawX);
    const tz = q3(rawZ);

    if (!isClearOfExclusions(tx, tz, 4.65, 2.65, 4.65, 2.35)) continue;
    if (sampleTerrainSlopeDeg(terrain, tx, tz) > 35) continue;

    let tooClose = false;
    for (const other of placedTrees) {
      if (Math.hypot(tx - other.x, tz - other.z) < minTreeSpacing) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const groundY = sampleTerrainHeight(terrain, tx, tz);
    // Ensure all 5 species are guaranteed representation even in early indices
    const idx = placedTrees.length;
    const species: TreeSpeciesBatchKey =
      idx < TREE_SPECIES_BATCH_KEYS.length
        ? TREE_SPECIES_BATCH_KEYS[idx]
        : (preferredSpecies ?? pickBiomeSpecies(tx, tz, groundY));

    const scaleXZ = q3(0.84 + rng() * 0.42);
    const scaleY = q3(0.86 + rng() * 0.48);
    const yaw = q3(rng() * Math.PI * 2);
    const baseRadius =
      species === 'tree:tree_ancient_dead'
        ? 0.44
        : species === 'tree:spruce_broad'
          ? 0.40
          : species === 'tree:birch_deciduous'
            ? 0.30
            : 0.35;
    const trunkRadius = q3(baseRadius * scaleXZ);
    const treeId = `sq_tree_${idx}`;

    placedTrees.push({ x: tx, z: tz, radius: trunkRadius, species });

    const treeCol = createGroundedTreeCollider(treeId, terrain, tx, tz, trunkRadius, 4.5);
    treeCol.sourceObjectId = treeId;
    treeColliders.push(treeCol);

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
      maxDrawDistance: 185,
      transform: {
        position: { x: tx, y: q3(groundY), z: tz },
        yaw,
        scale: { x: scaleXZ, y: scaleY, z: scaleXZ },
      },
      castShadow: true,
      receiveShadow: true,
    });
  }

  // ---------------- 2. Mossy Boulders / Rocks (85 .. 105 target: 95) ----------------
  const targetRocks = 95;
  let rockAttempts = 0;

  while (placedRocks.length < targetRocks && rockAttempts < 5000) {
    rockAttempts++;

    let rawX: number;
    let rawZ: number;
    // Favor rocky outcrops near cliff_watch outskirts or northern ridges for ~30% of boulders
    if (cliffWatchSite && rng() < 0.25) {
      const ang = rng() * Math.PI * 2;
      const dist = cliffWatchSite.flatRadius + 6 + rng() * 28;
      rawX = cliffWatchSite.center.x + Math.cos(ang) * dist;
      rawZ = cliffWatchSite.center.z + Math.sin(ang) * dist;
    } else {
      rawX = (rng() * 2 - 1) * (FOREST_SQUARE_PLAYABLE_LIMIT - 1);
      rawZ = (rng() * 2 - 1) * (FOREST_SQUARE_PLAYABLE_LIMIT - 1);
    }

    const rx = q3(rawX);
    const rz = q3(rawZ);

    if (!isClearOfExclusions(rx, rz, 4.65, 2.65, 4.65, 2.35)) continue;
    if (sampleTerrainSlopeDeg(terrain, rx, rz) > 35) continue;
    if (!isClearOfTreesAndRocks(rx, rz, 2.2, 2.4)) continue;

    const sx = q3(1.45 + rng() * 1.45);
    const sy = q3(0.95 + rng() * 1.15);
    const sz = q3(1.35 + rng() * 1.35);
    const footprintRadius = Math.max(sx, sz) * 0.5;

    const idx = placedRocks.length;
    const rockId = `sq_rock_${idx}`;
    placedRocks.push({ x: rx, z: rz, radius: footprintRadius });

    const rockCol = createGroundedRockCollider(rockId, terrain, rx, rz, { x: sx, y: sy, z: sz });
    rockCol.sourceObjectId = rockId;
    rockColliders.push(rockCol);

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
      maxDrawDistance: 155,
      transform: {
        position: { x: rx, y: q3(groundY), z: rz },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sx, y: sy, z: sz },
      },
      castShadow: true,
      receiveShadow: true,
    });
  }

  // ---------------- 3. Bushes (foliage:bush, ~220 instances, maxDrawDistance: 130) ----------------
  const targetBushes = 220;
  let bushCount = 0;
  let bushAttempts = 0;

  while (bushCount < targetBushes && bushAttempts < 4000) {
    bushAttempts++;
    const bx = q3((rng() * 2 - 1) * FOREST_SQUARE_PLAYABLE_LIMIT);
    const bz = q3((rng() * 2 - 1) * FOREST_SQUARE_PLAYABLE_LIMIT);

    if (!isClearOfExclusions(bx, bz, 3.45, 2.55, 4.55, 2.25)) continue;
    if (sampleTerrainSlopeDeg(terrain, bx, bz) > 35) continue;
    if (!isClearOfTreesAndRocks(bx, bz, 0.85, 0.95)) continue;

    const groundY = sampleTerrainHeight(terrain, bx, bz);
    const chunk = getChunkCoord(bx, bz, chunkSize);
    const sc = q3(0.75 + rng() * 0.65);
    const bushId = `sq_bush_${bushCount++}`;

    visuals.push({
      id: `${bushId}:vis`,
      sourceObjectId: bushId,
      prefabId: 'foliage:bush',
      category: 'foliage',
      batchKey: 'foliage:bush',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'mid',
      maxDrawDistance: 130,
      transform: {
        position: { x: bx, y: q3(groundY), z: bz },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: q3(sc * (0.8 + rng() * 0.35)), z: sc },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  let undergrowthCount = 0;

  // ---------------- 4. Fallen Logs (prop:fallen_log, ~80 instances, maxDrawDistance: 115) ----------------
  const targetLogs = 80;
  let logCount = 0;
  let logAttempts = 0;

  while (logCount < targetLogs && logAttempts < 2500) {
    logAttempts++;
    let rawX: number;
    let rawZ: number;
    if (lumberMillSite && rng() < 0.25) {
      const ang = rng() * Math.PI * 2;
      const dist = lumberMillSite.flatRadius + 5 + rng() * 26;
      rawX = lumberMillSite.center.x + Math.cos(ang) * dist;
      rawZ = lumberMillSite.center.z + Math.sin(ang) * dist;
    } else {
      rawX = (rng() * 2 - 1) * (FOREST_SQUARE_PLAYABLE_LIMIT - 2);
      rawZ = (rng() * 2 - 1) * (FOREST_SQUARE_PLAYABLE_LIMIT - 2);
    }

    const lx = q3(rawX);
    const lz = q3(rawZ);

    if (!isClearOfExclusions(lx, lz, 3.6, 2.6, 4.6, 2.3)) continue;
    if (sampleTerrainSlopeDeg(terrain, lx, lz) > 30) continue;
    if (!isClearOfTreesAndRocks(lx, lz, 1.2, 1.2)) continue;

    const groundY = sampleTerrainHeight(terrain, lx, lz);
    const chunk = getChunkCoord(lx, lz, chunkSize);
    const logId = `sq_log_${logCount++}`;
    undergrowthCount++;

    // RNG call order preserved exactly (yaw, scale.x, scale.y, scale.z) — Stage 08-FIX determinism contract.
    const logYaw = q3(rng() * Math.PI * 2);
    const logScaleX = q3(0.85 + rng() * 0.4);
    const logScaleY = q3(0.85 + rng() * 0.35);
    const logScaleZ = q3(0.9 + rng() * 0.5);
    const logTransform = {
      position: { x: lx, y: q3(groundY), z: lz },
      yaw: logYaw,
      scale: { x: logScaleX, y: logScaleY, z: logScaleZ },
    };

    visuals.push({
      id: `${logId}:vis`,
      sourceObjectId: logId,
      prefabId: 'prop:fallen_log',
      category: 'prop',
      batchKey: 'prop:fallen_log',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'mid',
      maxDrawDistance: 115,
      transform: logTransform,
      castShadow: true,
      receiveShadow: true,
    });
    propColliders.push(...buildFallenLogColliders(logId, logTransform, terrain));
  }

  // ---------------- 5. Cut Tree Stumps (prop:tree_stump, ~75 instances, maxDrawDistance: 115) ----------------
  const targetStumps = 75;
  let stumpCount = 0;
  let stumpAttempts = 0;

  while (stumpCount < targetStumps && stumpAttempts < 2500) {
    stumpAttempts++;
    let rawX: number;
    let rawZ: number;
    if (lumberMillSite && rng() < 0.32) {
      const ang = rng() * Math.PI * 2;
      const dist = lumberMillSite.flatRadius + 4.5 + rng() * 28;
      rawX = lumberMillSite.center.x + Math.cos(ang) * dist;
      rawZ = lumberMillSite.center.z + Math.sin(ang) * dist;
    } else if (forestCampSite && rng() < 0.15) {
      const ang = rng() * Math.PI * 2;
      const dist = forestCampSite.flatRadius + 4.5 + rng() * 20;
      rawX = forestCampSite.center.x + Math.cos(ang) * dist;
      rawZ = forestCampSite.center.z + Math.sin(ang) * dist;
    } else {
      rawX = (rng() * 2 - 1) * (FOREST_SQUARE_PLAYABLE_LIMIT - 1);
      rawZ = (rng() * 2 - 1) * (FOREST_SQUARE_PLAYABLE_LIMIT - 1);
    }

    const sx = q3(rawX);
    const sz = q3(rawZ);

    if (!isClearOfExclusions(sx, sz, 3.5, 2.6, 4.55, 2.25)) continue;
    if (sampleTerrainSlopeDeg(terrain, sx, sz) > 32) continue;
    if (!isClearOfTreesAndRocks(sx, sz, 1.1, 1.1)) continue;

    const groundY = sampleTerrainHeight(terrain, sx, sz);
    const chunk = getChunkCoord(sx, sz, chunkSize);
    const sc = q3(0.8 + rng() * 0.5);
    const stumpId = `sq_stump_${stumpCount++}`;
    undergrowthCount++;

    // RNG call order preserved exactly (yaw, scale.y) — Stage 08-FIX determinism contract.
    const stumpYaw = q3(rng() * Math.PI * 2);
    const stumpScaleY = q3(0.75 + rng() * 0.45);
    const stumpTransform = {
      position: { x: sx, y: q3(groundY), z: sz },
      yaw: stumpYaw,
      scale: { x: sc, y: stumpScaleY, z: sc },
    };

    visuals.push({
      id: `${stumpId}:vis`,
      sourceObjectId: stumpId,
      prefabId: 'prop:tree_stump',
      category: 'prop',
      batchKey: 'prop:tree_stump',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'mid',
      maxDrawDistance: 115,
      transform: stumpTransform,
      castShadow: true,
      receiveShadow: true,
    });
    propColliders.push(...buildTreeStumpCollider(stumpId, stumpTransform, terrain));
  }

  // ---------------- 6. Woodland Ferns (foliage:fern, ~280 instances, maxDrawDistance: 85) ----------------
  const targetFerns = 280;
  let fernCount = 0;
  let fernAttempts = 0;

  while (fernCount < targetFerns && fernAttempts < 4500) {
    fernAttempts++;
    let rawX: number;
    let rawZ: number;
    if (fernCount < 190 && placedTrees.length > 0) {
      const t = placedTrees[(fernCount * 11 + fernAttempts) % placedTrees.length];
      const ang = rng() * Math.PI * 2;
      const dist = t.radius + 0.65 + rng() * 2.4;
      rawX = clamp(t.x + Math.cos(ang) * dist, -FOREST_SQUARE_PLAYABLE_LIMIT, FOREST_SQUARE_PLAYABLE_LIMIT);
      rawZ = clamp(t.z + Math.sin(ang) * dist, -FOREST_SQUARE_PLAYABLE_LIMIT, FOREST_SQUARE_PLAYABLE_LIMIT);
    } else {
      rawX = (rng() * 2 - 1) * FOREST_SQUARE_PLAYABLE_LIMIT;
      rawZ = (rng() * 2 - 1) * FOREST_SQUARE_PLAYABLE_LIMIT;
    }

    const fx = q3(rawX);
    const fz = q3(rawZ);

    if (!isClearOfExclusions(fx, fz, 3.45, 2.55, 4.55, 2.25)) continue;
    if (sampleTerrainSlopeDeg(terrain, fx, fz) > 35) continue;

    const groundY = sampleTerrainHeight(terrain, fx, fz);
    const chunk = getChunkCoord(fx, fz, chunkSize);
    const sc = q3(0.75 + rng() * 0.55);
    const fernId = `sq_fern_${fernCount++}`;
    undergrowthCount++;

    visuals.push({
      id: `${fernId}:vis`,
      sourceObjectId: fernId,
      prefabId: 'foliage:fern',
      category: 'foliage',
      batchKey: 'foliage:fern',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: 85,
      transform: {
        position: { x: fx, y: q3(groundY), z: fz },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: sc, z: sc },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  // ---------------- 7. Grass Tufts (foliage:grass, ~420 instances, maxDrawDistance: 75) ----------------
  const targetGrass = 420;
  let grassCount = 0;
  let grassAttempts = 0;

  while (grassCount < targetGrass && grassAttempts < 6500) {
    grassAttempts++;
    const gx = q3((rng() * 2 - 1) * FOREST_SQUARE_PLAYABLE_LIMIT);
    const gz = q3((rng() * 2 - 1) * FOREST_SQUARE_PLAYABLE_LIMIT);

    if (!isClearOfExclusions(gx, gz, 3.45, 2.55, 4.55, 2.25)) continue;
    if (sampleTerrainSlopeDeg(terrain, gx, gz) > 35) continue;

    const groundY = sampleTerrainHeight(terrain, gx, gz);
    const chunk = getChunkCoord(gx, gz, chunkSize);
    const sc = q3(0.75 + rng() * 0.65);
    const grassId = `sq_grass_${grassCount++}`;
    undergrowthCount++;

    visuals.push({
      id: `${grassId}:vis`,
      sourceObjectId: grassId,
      prefabId: 'foliage:grass',
      category: 'foliage',
      batchKey: 'foliage:grass',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: 75,
      transform: {
        position: { x: gx, y: q3(groundY), z: gz },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: q3(0.7 + rng() * 0.6), z: sc },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  // ---------------- 8. Pebbles & Small Stones (prop:pebble, ~200 instances, maxDrawDistance: 70) ----------------
  const targetPebbles = 200;
  let pebbleCount = 0;
  let pebbleAttempts = 0;

  while (pebbleCount < targetPebbles && pebbleAttempts < 4000) {
    pebbleAttempts++;
    const px = q3((rng() * 2 - 1) * FOREST_SQUARE_PLAYABLE_LIMIT);
    const pz = q3((rng() * 2 - 1) * FOREST_SQUARE_PLAYABLE_LIMIT);

    if (!isClearOfExclusions(px, pz, 3.45, 2.55, 4.55, 2.25)) continue;
    if (sampleTerrainSlopeDeg(terrain, px, pz) > 35) continue;

    const groundY = sampleTerrainHeight(terrain, px, pz);
    const chunk = getChunkCoord(px, pz, chunkSize);
    const sc = q3(0.65 + rng() * 0.75);
    const pebbleId = `sq_pebble_${pebbleCount++}`;
    undergrowthCount++;

    visuals.push({
      id: `${pebbleId}:vis`,
      sourceObjectId: pebbleId,
      prefabId: 'prop:pebble',
      category: 'prop',
      batchKey: 'prop:pebble',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: 70,
      transform: {
        position: { x: px, y: q3(groundY), z: pz },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: q3(sc * 0.6), z: sc },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  // ---------------- 9. Leaf & Pine Needle Litter (foliage:leaf_patch, ~180 instances, maxDrawDistance: 80) ----------------
  const targetLeafPatches = 180;
  let leafCount = 0;
  let leafAttempts = 0;

  while (leafCount < targetLeafPatches && leafAttempts < 3500) {
    leafAttempts++;
    let rawX: number;
    let rawZ: number;
    if (leafCount < 120 && placedTrees.length > 0) {
      const t = placedTrees[(leafCount * 13 + leafAttempts) % placedTrees.length];
      const ang = rng() * Math.PI * 2;
      const dist = t.radius + 0.8 + rng() * 3.0;
      rawX = clamp(t.x + Math.cos(ang) * dist, -FOREST_SQUARE_PLAYABLE_LIMIT, FOREST_SQUARE_PLAYABLE_LIMIT);
      rawZ = clamp(t.z + Math.sin(ang) * dist, -FOREST_SQUARE_PLAYABLE_LIMIT, FOREST_SQUARE_PLAYABLE_LIMIT);
    } else {
      rawX = (rng() * 2 - 1) * (FOREST_SQUARE_PLAYABLE_LIMIT - 2);
      rawZ = (rng() * 2 - 1) * (FOREST_SQUARE_PLAYABLE_LIMIT - 2);
    }

    const lx = q3(rawX);
    const lz = q3(rawZ);

    if (!isClearOfExclusions(lx, lz, 3.45, 2.55, 4.55, 2.25)) continue;
    if (sampleTerrainSlopeDeg(terrain, lx, lz) > 32) continue;

    const groundY = sampleTerrainHeight(terrain, lx, lz);
    const chunk = getChunkCoord(lx, lz, chunkSize);
    const sc = q3(0.85 + rng() * 0.85);
    const leafId = `sq_leaf_${leafCount++}`;
    undergrowthCount++;

    visuals.push({
      id: `${leafId}:vis`,
      sourceObjectId: leafId,
      prefabId: 'foliage:leaf_patch',
      category: 'foliage',
      batchKey: 'foliage:leaf_patch',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: 80,
      transform: {
        position: { x: lx, y: q3(groundY + 0.018), z: lz },
        yaw: q3(rng() * Math.PI * 2),
        scale: { x: sc, y: 1, z: sc },
      },
      castShadow: false,
      receiveShadow: true,
    });
  }

  return {
    treeColliders,
    rockColliders,
    propColliders,
    visuals,
    treeCount: placedTrees.length,
    rockCount: placedRocks.length,
    bushCount,
    undergrowthCount,
  };
}
