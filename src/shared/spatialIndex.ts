import type { Box } from './map';
import type { Vec3 } from './math';
import type { ColliderBox, WorldDefinition } from './world';

export interface SpatialGridOptions {
  cellSize?: number;
}

/**
 * Deterministic 2D XZ uniform spatial grid index for AABB colliders (`ColliderBox` or `Box`).
 * Supports negative and positive world coordinates, multi-cell colliders, and
 * fast broadphase AABB, radius, and ray queries with deterministic ordering.
 */
export class SpatialGridIndex<T extends Box = ColliderBox> {
  readonly cellSize: number;
  private readonly items: T[] = [];
  private readonly cells = new Map<string, number[]>();

  constructor(items: readonly T[] = [], opts: SpatialGridOptions = {}) {
    this.cellSize = Math.max(1, opts.cellSize ?? 8);
    for (const item of items) {
      this.insert(item);
    }
  }

  private cellCoord(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  private cellKey(cx: number, cz: number): string {
    return `${cx}:${cz}`;
  }

  /**
   * Inserts a collider into all 2D grid cells overlapped by its XZ footprint.
   */
  insert(item: T): number {
    const idx = this.items.length;
    this.items.push(item);

    const minCx = this.cellCoord(item.min.x);
    const maxCx = this.cellCoord(item.max.x);
    const minCz = this.cellCoord(item.min.z);
    const maxCz = this.cellCoord(item.max.z);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = this.cellKey(cx, cz);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(idx);
      }
    }
    return idx;
  }

  /**
   * Returns all indexed items in insertion order.
   */
  getAll(): readonly T[] {
    return this.items;
  }

  /**
   * Queries all colliders whose XZ (and optional Y) bounds overlap the given AABB.
   * Returned in deterministic insertion order, identical to a brute-force filter.
   */
  queryAABB(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    minY = -Infinity,
    maxY = Infinity,
  ): T[] {
    const qMinX = Math.min(minX, maxX);
    const qMaxX = Math.max(minX, maxX);
    const qMinZ = Math.min(minZ, maxZ);
    const qMaxZ = Math.max(minZ, maxZ);
    const qMinY = Math.min(minY, maxY);
    const qMaxY = Math.max(minY, maxY);

    const minCx = this.cellCoord(qMinX);
    const maxCx = this.cellCoord(qMaxX);
    const minCz = this.cellCoord(qMinZ);
    const maxCz = this.cellCoord(qMaxZ);

    const seen = new Set<number>();
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.cells.get(this.cellKey(cx, cz));
        if (!bucket) continue;
        for (const idx of bucket) {
          seen.add(idx);
        }
      }
    }

    if (seen.size === 0) return [];
    const sortedIndices = Array.from(seen).sort((a, b) => a - b);
    const results: T[] = [];
    for (const idx of sortedIndices) {
      const b = this.items[idx];
      if (
        b.max.x >= qMinX &&
        b.min.x <= qMaxX &&
        b.max.z >= qMinZ &&
        b.min.z <= qMaxZ &&
        b.max.y >= qMinY &&
        b.min.y <= qMaxY
      ) {
        results.push(b);
      }
    }
    return results;
  }

  /**
   * Queries all colliders whose XZ footprint is within `radius` meters of `(x, z)`.
   */
  queryRadius(x: number, z: number, radius: number, minY = -Infinity, maxY = Infinity): T[] {
    const r = Math.max(0, radius);
    const candidates = this.queryAABB(x - r, z - r, x + r, z + r, minY, maxY);
    const rSq = r * r;
    return candidates.filter((b) => {
      const clampedX = Math.max(b.min.x, Math.min(x, b.max.x));
      const clampedZ = Math.max(b.min.z, Math.min(z, b.max.z));
      const dx = x - clampedX;
      const dz = z - clampedZ;
      return dx * dx + dz * dz <= rSq + 1e-9;
    });
  }

  /**
   * Queries candidate colliders along a 3D ray segment `[origin, origin + dir * maxT]`
   * using 2D Amanatides & Woo grid traversal (with 1-cell safety padding for numerical robustness)
   * and returns them in deterministic insertion order.
   */
  queryRay(origin: Vec3, dir: Vec3, maxT: number): T[] {
    if (maxT <= 0) return [];
    const endX = origin.x + dir.x * maxT;
    const endZ = origin.z + dir.z * maxT;
    const endY = origin.y + dir.y * maxT;

    const minY = Math.min(origin.y, endY) - 1e-4;
    const maxY = Math.max(origin.y, endY) + 1e-4;

    const seen = new Set<number>();
    const addCell = (cx: number, cz: number) => {
      const bucket = this.cells.get(this.cellKey(cx, cz));
      if (!bucket) return;
      for (const idx of bucket) seen.add(idx);
    };

    let cx = this.cellCoord(origin.x);
    let cz = this.cellCoord(origin.z);
    const endCx = this.cellCoord(endX);
    const endCz = this.cellCoord(endZ);

    const dx = endX - origin.x;
    const dz = endZ - origin.z;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    const tDeltaX = stepX !== 0 ? Math.abs(this.cellSize / dx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(this.cellSize / dz) : Infinity;

    const nextBoundaryX = stepX > 0 ? (cx + 1) * this.cellSize : cx * this.cellSize;
    const nextBoundaryZ = stepZ > 0 ? (cz + 1) * this.cellSize : cz * this.cellSize;

    let tMaxX = stepX !== 0 ? Math.abs((nextBoundaryX - origin.x) / dx) : Infinity;
    let tMaxZ = stepZ !== 0 ? Math.abs((nextBoundaryZ - origin.z) / dz) : Infinity;

    const maxCells = Math.abs(endCx - cx) + Math.abs(endCz - cz) + 4;
    for (let i = 0; i <= maxCells; i++) {
      addCell(cx, cz);
      if (cx === endCx && cz === endCz) break;
      if (tMaxX < tMaxZ) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxZ < tMaxX) {
        cz += stepZ;
        tMaxZ += tDeltaZ;
      } else {
        // Ray crosses corner: add both adjacent cells for safety
        addCell(cx + stepX, cz);
        addCell(cx, cz + stepZ);
        cx += stepX;
        cz += stepZ;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      }
    }

    if (seen.size === 0) return [];
    const sortedIndices = Array.from(seen).sort((a, b) => a - b);
    const results: T[] = [];
    for (const idx of sortedIndices) {
      const b = this.items[idx];
      if (b.max.y >= minY && b.min.y <= maxY) {
        results.push(b);
      }
    }
    return results;
  }
}

const worldSpatialCache = new WeakMap<WorldDefinition, SpatialGridIndex<ColliderBox>>();

/**
 * Returns or builds the isolated `SpatialGridIndex` associated with a `WorldDefinition`.
 * Because each room has its own `WorldDefinition` instance, spatial indices never bleed across rooms.
 */
export function getWorldSpatialIndex(world: WorldDefinition): SpatialGridIndex<ColliderBox> {
  let index = worldSpatialCache.get(world);
  if (!index) {
    index = new SpatialGridIndex(world.colliders, { cellSize: 8 });
    worldSpatialCache.set(world, index);
  }
  return index;
}
