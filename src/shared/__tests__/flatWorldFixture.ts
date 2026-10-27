import type { Vec3 } from '../math';
import {
  computeGameplayHash,
  type ColliderBox,
  type ColliderTag,
  type HeightfieldTerrainDescriptor,
  type MapId,
  type MaterialKind,
  type WorldDefinition,
} from '../world';

/**
 * Testlar uchun tekis heightfield relyef: barcha balandliklar `baseY`.
 * Eski Dust Arena ("flat" relyef) o'rniga fizika testlarida shu fixture ishlatiladi —
 * `applyWorldMovement` / `stepProjectileInWorld` / `raycastWorld` haqiqiy relyef kodidan o'tadi.
 */
export function buildFlatHeightfield(size = 80, baseY = 0, cellSize = 2): HeightfieldTerrainDescriptor {
  const cols = Math.floor(size / cellSize) + 1;
  return {
    kind: 'heightfield',
    width: size,
    depth: size,
    cellSize,
    originX: -size / 2,
    originZ: -size / 2,
    cols,
    rows: cols,
    heights: new Array<number>(cols * cols).fill(baseY),
  };
}

export interface FlatWorldOpts {
  /** Dunyo tomoni (m), markaz (0, 0). */
  size?: number;
  /** Relyef balandligi (m). */
  baseY?: number;
  mapId?: MapId;
  publicLayoutSeed?: number;
}

/** Berilgan kollayderlar bilan tekis dunyo (`WorldDefinition`) yaratadi. */
export function makeFlatWorld(colliders: ColliderBox[], opts: FlatWorldOpts = {}): WorldDefinition {
  const size = opts.size ?? 80;
  const baseY = opts.baseY ?? 0;
  const half = size / 2;
  const base = {
    mapId: opts.mapId ?? ('forest_technical' as const),
    worldVersion: 1,
    publicLayoutSeed: opts.publicLayoutSeed ?? 6501,
    bounds: { minX: -half, maxX: half, minY: baseY - 10, maxY: baseY + 40, minZ: -half, maxZ: half },
    terrain: buildFlatHeightfield(size, baseY),
    colliders,
    spawnPoints: [],
    locations: [],
    containerLocations: [],
  };
  return {
    ...base,
    name: 'Flat Test World',
    chunkSize: 32,
    visuals: [],
    gameplayHash: computeGameplayHash(base),
  };
}

/** Oddiy AABB kollayder (test uchun). */
export function boxCollider(
  id: string,
  min: Vec3,
  max: Vec3,
  mat: MaterialKind = 'wall',
  tag: ColliderTag = 'structure',
): ColliderBox {
  return { id, tag, mat, min: { ...min }, max: { ...max } };
}
