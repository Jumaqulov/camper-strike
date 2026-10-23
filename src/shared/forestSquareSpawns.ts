import { PLAYER_HEIGHT, PLAYER_RADIUS, type Team } from './constants';
import { clamp } from './math';
import {
  getForestSquarePoiSites,
  type ForestSquarePoiSiteSpec,
} from './structures/contracts';
import {
  isCapsuleClearOfBoxes,
  isTerrainWalkable,
  sampleTerrainHeight,
  sampleTerrainSlopeDeg,
} from './terrain';
import {
  createSeededRng,
  type ColliderBox,
  type SpawnPointDef,
  type TerrainDescriptor,
} from './world';

const q3 = (n: number): number => Math.round(n * 1000) / 1000;

export const FOREST_SQUARE_SPAWN_BOUND = 118;
export const MAX_SPAWN_SLOPE_DEG = 28;
export const SPAWN_CLEARANCE_RADIUS = PLAYER_RADIUS + 0.65; // 1.05 m

export interface ForestSquareSpawnsOptions {
  terrain: TerrainDescriptor;
  seed: number;
  poiSites?: ForestSquarePoiSiteSpec[];
  allColliders: readonly ColliderBox[];
  roadDistSampler: (x: number, z: number) => number;
}

interface CandidateBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Generates 36 deterministic, grounded, collision-free spawn points for `forest_square` (256x256 m):
 * - 12 Red Team spawns (`sp_sq_red_00`..`11`) in the southern hemisphere (`z in [36, 112]`, `x in [-105, 105]`), >= 10 m apart
 * - 12 Blue Team spawns (`sp_sq_blue_00`..`11`) in the northern hemisphere (`z in [-112, -36]`, `x in [-105, 105]`), >= 10 m apart
 * - 12 FFA spawns (`sp_sq_ffa_00`..`11`) in outer forest glades around the 6 POIs (`distToPoi in [flatRadius + 4, blendRadius + 10]`), >= 18 m apart
 */
export function buildForestSquareSpawns(opts: ForestSquareSpawnsOptions): SpawnPointDef[] {
  const { terrain, seed, allColliders, roadDistSampler } = opts;
  const poiSites = opts.poiSites ?? getForestSquarePoiSites(seed);
  const rng = createSeededRng(seed ^ 0x7a33);

  const redSpawns: SpawnPointDef[] = [];
  const blueSpawns: SpawnPointDef[] = [];
  const ffaSpawns: SpawnPointDef[] = [];
  const allPlaced: SpawnPointDef[] = [];

  /**
   * Validates that a quantized (x, z) point meets all terrain, POI, collider, and spacing rules.
   */
  const isCandidateValid = (
    x: number,
    z: number,
    bounds: CandidateBounds,
    sameGroupSpawns: readonly SpawnPointDef[],
    minGroupDist: number,
    minAnySpawnDist: number,
  ): boolean => {
    if (
      x < -FOREST_SQUARE_SPAWN_BOUND ||
      x > FOREST_SQUARE_SPAWN_BOUND ||
      z < -FOREST_SQUARE_SPAWN_BOUND ||
      z > FOREST_SQUARE_SPAWN_BOUND
    ) {
      return false;
    }
    if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) {
      return false;
    }

    // Must not fall inside any POI flat pad (with >= 2.0m margin)
    for (const site of poiSites) {
      const distToPoi = Math.hypot(x - site.center.x, z - site.center.z);
      if (distToPoi < site.flatRadius + 2.2) {
        return false;
      }
    }

    // Terrain walkability & slope <= 28 deg
    const slope = sampleTerrainSlopeDeg(terrain, x, z);
    if (slope > MAX_SPAWN_SLOPE_DEG || !isTerrainWalkable(terrain, x, z, MAX_SPAWN_SLOPE_DEG)) {
      return false;
    }

    // Spacing from same-category spawns
    for (const sp of sameGroupSpawns) {
      if (Math.hypot(x - sp.x, z - sp.z) < minGroupDist) {
        return false;
      }
    }

    // Spacing from any already-placed spawn
    for (const sp of allPlaced) {
      if (Math.hypot(x - sp.x, z - sp.z) < minAnySpawnDist) {
        return false;
      }
    }

    // Capsule collision check against all world colliders (trees, rocks, buildings, containers)
    const y = q3(sampleTerrainHeight(terrain, x, z));
    if (
      !isCapsuleClearOfBoxes(
        allColliders,
        x,
        y + 0.02,
        z,
        SPAWN_CLEARANCE_RADIUS,
        PLAYER_HEIGHT,
      )
    ) {
      return false;
    }
    if (
      !isCapsuleClearOfBoxes(
        allColliders,
        x,
        y,
        z,
        PLAYER_RADIUS + 0.25,
        PLAYER_HEIGHT,
      )
    ) {
      return false;
    }

    return true;
  };

  /**
   * Spiral search around `(anchorX, anchorZ)` within `bounds`.
   * Prefers candidates on/near roads or open glades, and falls back to wider spiral + deterministic box scan.
   */
  const findSafeTeamSpawn = (
    id: string,
    team: Team,
    anchorX: number,
    anchorZ: number,
    baseYaw: number,
    bounds: CandidateBounds,
    sameGroupSpawns: SpawnPointDef[],
    minGroupDist: number,
  ): SpawnPointDef => {
    const jitterX = (rng() * 2 - 1) * 2.5;
    const jitterZ = (rng() * 2 - 1) * 2.5;
    const startX = clamp(anchorX + jitterX, bounds.minX + 1, bounds.maxX - 1);
    const startZ = clamp(anchorZ + jitterZ, bounds.minZ + 1, bounds.maxZ - 1);

    const maxRadius = 48;
    const radialStep = 1.25;
    const angleOffset = rng() * Math.PI * 2;

    for (let r = 0; r <= maxRadius; r += radialStep) {
      const steps = r === 0 ? 1 : Math.max(12, Math.round((2 * Math.PI * r) / 1.6));
      for (let s = 0; s < steps; s++) {
        const ang = angleOffset + (s / steps) * Math.PI * 2;
        const cx = q3(startX + Math.cos(ang) * r);
        const cz = q3(startZ + Math.sin(ang) * r);

        if (!isCandidateValid(cx, cz, bounds, sameGroupSpawns, minGroupDist, 4.0)) {
          continue;
        }

        const y = q3(sampleTerrainHeight(terrain, cx, cz));
        const yawJitter = (rng() * 2 - 1) * 0.18;
        const yaw = q3(baseYaw + yawJitter);
        return { id, x: cx, y, z: cz, yaw, team };
      }
    }

    // Fallback wide grid scan across the valid hemisphere bounds if spiral was exhausted
    for (const relaxedGroupDist of [minGroupDist, 6.0, 3.0]) {
      for (let gz = bounds.minZ + 2; gz <= bounds.maxZ - 2; gz += 2.0) {
        for (let gx = bounds.minX + 2; gx <= bounds.maxX - 2; gx += 2.0) {
          const cx = q3(gx);
          const cz = q3(gz);
          if (isCandidateValid(cx, cz, bounds, sameGroupSpawns, relaxedGroupDist, 3.0)) {
            const y = q3(sampleTerrainHeight(terrain, cx, cz));
            return { id, x: cx, y, z: cz, yaw: q3(baseYaw), team };
          }
        }
      }
    }

    throw new Error(
      `[forestSquareSpawns] Failed to locate collision-free team spawn '${id}' (${team}) near (${anchorX}, ${anchorZ})`,
    );
  };

  // ---------------- 1. Red Team Spawns (12 points, south hemisphere: z in [36, 112], x in [-105, 105]) ----------------
  const redBounds: CandidateBounds = {
    minX: -105,
    maxX: 105,
    minZ: 36,
    maxZ: 112,
  };

  // Well-spaced southern glade & road-side anchors (clear of SW camp at (-58, 70) and SE ruins at (66, 66))
  const redAnchors: Array<{ x: number; z: number; yaw: number }> = [
    { x: -94, z: 46, yaw: 0.12 },
    { x: -90, z: 98, yaw: 0.15 },
    { x: -56, z: 104, yaw: 0.08 },
    { x: -30, z: 46, yaw: 0.05 },
    { x: -24, z: 82, yaw: 0.0 },
    { x: -6, z: 104, yaw: 0.0 },
    { x: 4, z: 54, yaw: 0.0 },
    { x: 18, z: 88, yaw: -0.05 },
    { x: 34, z: 46, yaw: -0.08 },
    { x: 42, z: 102, yaw: -0.1 },
    { x: 94, z: 44, yaw: -0.15 },
    { x: 94, z: 98, yaw: -0.14 },
  ];

  for (let i = 0; i < 12; i++) {
    const id = `sp_sq_red_${String(i).padStart(2, '0')}`;
    const anchor = redAnchors[i];
    const sp = findSafeTeamSpawn(
      id,
      'red',
      anchor.x,
      anchor.z,
      anchor.yaw,
      redBounds,
      redSpawns,
      10.2, // strictly >= 10 m apart
    );
    redSpawns.push(sp);
    allPlaced.push(sp);
  }

  // ---------------- 2. Blue Team Spawns (12 points, north hemisphere: z in [-112, -36], x in [-105, 105]) ----------------
  const blueBounds: CandidateBounds = {
    minX: -105,
    maxX: 105,
    minZ: -112,
    maxZ: -36,
  };

  // Well-spaced northern glade & road-side anchors (clear of NW ranger house at (-68, -64) and NE cabins at (64, -62))
  const blueAnchors: Array<{ x: number; z: number; yaw: number }> = [
    { x: -94, z: -98, yaw: Math.PI - 0.14 },
    { x: -94, z: -44, yaw: Math.PI - 0.12 },
    { x: -64, z: -102, yaw: Math.PI - 0.08 },
    { x: -34, z: -48, yaw: Math.PI - 0.05 },
    { x: -26, z: -86, yaw: Math.PI },
    { x: -6, z: -104, yaw: Math.PI },
    { x: 4, z: -54, yaw: Math.PI },
    { x: 20, z: -88, yaw: Math.PI + 0.05 },
    { x: 32, z: -46, yaw: Math.PI + 0.08 },
    { x: 56, z: -104, yaw: Math.PI + 0.1 },
    { x: 94, z: -96, yaw: Math.PI + 0.14 },
    { x: 94, z: -44, yaw: Math.PI + 0.12 },
  ];

  for (let i = 0; i < 12; i++) {
    const id = `sp_sq_blue_${String(i).padStart(2, '0')}`;
    const anchor = blueAnchors[i];
    const sp = findSafeTeamSpawn(
      id,
      'blue',
      anchor.x,
      anchor.z,
      anchor.yaw,
      blueBounds,
      blueSpawns,
      10.2, // strictly >= 10 m apart
    );
    blueSpawns.push(sp);
    allPlaced.push(sp);
  }

  // ---------------- 3. FFA ('none') Spawns (12 points, 2 per POI in [flatRadius + 4, blendRadius + 10], >= 18 m apart) ----------------
  const ffaBounds: CandidateBounds = {
    minX: -FOREST_SQUARE_SPAWN_BOUND,
    maxX: FOREST_SQUARE_SPAWN_BOUND,
    minZ: -FOREST_SQUARE_SPAWN_BOUND,
    maxZ: FOREST_SQUARE_SPAWN_BOUND,
  };

  const findSafeFfaRingSpawn = (
    id: string,
    site: ForestSquarePoiSiteSpec,
    preferredAngle: number,
  ): SpawnPointDef => {
    const minR = site.flatRadius + 4.15;
    const maxR = site.blendRadius + 9.85;
    const midR = (minR + maxR) * 0.5;
    const maxDeltaR = (maxR - minR) * 0.5;

    // Search outward from midR toward minR and maxR across angles around preferredAngle
    const rSteps = 14;
    const angleSteps = 48;

    for (let ir = 0; ir <= rSteps; ir++) {
      const frac = Math.ceil(ir / 2) / Math.ceil(rSteps / 2);
      const sign = ir % 2 === 0 ? 1 : -1;
      const r = clamp(midR + sign * frac * maxDeltaR, minR, maxR);

      for (let ia = 0; ia < angleSteps; ia++) {
        const aSign = ia % 2 === 0 ? 1 : -1;
        const aStep = Math.ceil(ia / 2) * ((Math.PI * 2) / angleSteps);
        const ang = preferredAngle + aSign * aStep;

        const cx = q3(site.center.x + Math.cos(ang) * r);
        const cz = q3(site.center.z + Math.sin(ang) * r);

        // Verify quantized coordinates strictly stay inside [flatRadius + 4, blendRadius + 10]
        const exactDist = Math.hypot(cx - site.center.x, cz - site.center.z);
        if (exactDist < site.flatRadius + 4.0 || exactDist > site.blendRadius + 10.0) {
          continue;
        }

        if (!isCandidateValid(cx, cz, ffaBounds, ffaSpawns, 18.2, 4.5)) {
          continue;
        }

        // Prefer spots with reasonable distance to road or open glade
        const roadDist = roadDistSampler(cx, cz);
        if (ir < 4 && roadDist < 1.5) {
          continue;
        }

        const y = q3(sampleTerrainHeight(terrain, cx, cz));
        // Face generally toward the POI center
        const yaw = q3(Math.atan2(-(site.center.x - cx), -(site.center.z - cz)));
        return { id, x: cx, y, z: cz, yaw, team: 'none' };
      }
    }

    // Secondary scan across all 6 POI rings if the primary POI ring was crowded
    for (const relaxedFfaDist of [18.2, 10.0, 4.0]) {
      for (const altSite of poiSites) {
        const altMinR = altSite.flatRadius + 4.15;
        const altMaxR = altSite.blendRadius + 9.85;
        for (let r = altMinR; r <= altMaxR; r += 1.2) {
          for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
            const cx = q3(altSite.center.x + Math.cos(a) * r);
            const cz = q3(altSite.center.z + Math.sin(a) * r);
            const exactDist = Math.hypot(cx - altSite.center.x, cz - altSite.center.z);
            if (exactDist < altSite.flatRadius + 4.0 || exactDist > altSite.blendRadius + 10.0) {
              continue;
            }
            if (isCandidateValid(cx, cz, ffaBounds, ffaSpawns, relaxedFfaDist, 3.5)) {
              const y = q3(sampleTerrainHeight(terrain, cx, cz));
              const yaw = q3(Math.atan2(-(altSite.center.x - cx), -(altSite.center.z - cz)));
              return { id, x: cx, y, z: cz, yaw, team: 'none' };
            }
          }
        }
      }
    }

    throw new Error(
      `[forestSquareSpawns] Failed to locate collision-free FFA spawn '${id}' around site '${site.id}'`,
    );
  };

  for (let i = 0; i < 12; i++) {
    const id = `sp_sq_ffa_${String(i).padStart(2, '0')}`;
    const site = poiSites[i % poiSites.length];
    const pairIndex = Math.floor(i / poiSites.length); // 0 or 1
    const baseAngle =
      ((i % poiSites.length) * 1.05 + pairIndex * Math.PI + (rng() - 0.5) * 0.35) %
      (Math.PI * 2);
    const sp = findSafeFfaRingSpawn(id, site, baseAngle);
    ffaSpawns.push(sp);
    allPlaced.push(sp);
  }

  return [...redSpawns, ...blueSpawns, ...ffaSpawns];
}
