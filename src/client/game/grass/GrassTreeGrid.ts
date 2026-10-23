/**
 * 2D spatial hash grid for tree positions in forest_square (256x256 m).
 * Provides O(1) proximity queries so grass planning runs in microseconds.
 */
export class GrassTreeGrid {
  private readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: Array<Array<{ x: number; z: number }>>;

  constructor(
    trees: ReadonlyArray<{ x: number; z: number }>,
    cellSize = 8,
    minX = -132,
    minZ = -132,
    maxX = 132,
    maxZ = 132,
  ) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
    this.minX = minX;
    this.minZ = minZ;
    this.cols = Math.ceil((maxX - minX) * this.invCellSize);
    this.rows = Math.ceil((maxZ - minZ) * this.invCellSize);
    this.cells = new Array(this.cols * this.rows);

    for (let i = 0; i < trees.length; i++) {
      const tree = trees[i]!;
      const gx = Math.floor((tree.x - minX) * this.invCellSize);
      const gz = Math.floor((tree.z - minZ) * this.invCellSize);
      if (gx < 0 || gx >= this.cols || gz < 0 || gz >= this.rows) continue;
      const idx = gz * this.cols + gx;
      let bucket = this.cells[idx];
      if (!bucket) {
        bucket = [];
        this.cells[idx] = bucket;
      }
      bucket.push(tree);
    }
  }

  /**
   * Fast O(1) boolean check: is there any tree trunk within `maxDist` meters of (x, z)?
   */
  hasTreeWithin(x: number, z: number, maxDist: number): boolean {
    const maxDistSq = maxDist * maxDist;
    const minGx = Math.max(0, Math.floor((x - maxDist - this.minX) * this.invCellSize));
    const maxGx = Math.min(this.cols - 1, Math.floor((x + maxDist - this.minX) * this.invCellSize));
    const minGz = Math.max(0, Math.floor((z - maxDist - this.minZ) * this.invCellSize));
    const maxGz = Math.min(this.rows - 1, Math.floor((z + maxDist - this.minZ) * this.invCellSize));

    for (let gz = minGz; gz <= maxGz; gz++) {
      const rowOffset = gz * this.cols;
      for (let gx = minGx; gx <= maxGx; gx++) {
        const bucket = this.cells[rowOffset + gx];
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const t = bucket[i]!;
          const dx = t.x - x;
          const dz = t.z - z;
          if (dx * dx + dz * dz < maxDistSq) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Returns distance to the nearest tree within `searchRadius`, or `Infinity` if none.
   */
  getDistanceToNearestTree(x: number, z: number, searchRadius = 12): number {
    let nearestSq = searchRadius * searchRadius;
    const minGx = Math.max(0, Math.floor((x - searchRadius - this.minX) * this.invCellSize));
    const maxGx = Math.min(this.cols - 1, Math.floor((x + searchRadius - this.minX) * this.invCellSize));
    const minGz = Math.max(0, Math.floor((z - searchRadius - this.minZ) * this.invCellSize));
    const maxGz = Math.min(this.rows - 1, Math.floor((z + searchRadius - this.minZ) * this.invCellSize));

    let found = false;
    for (let gz = minGz; gz <= maxGz; gz++) {
      const rowOffset = gz * this.cols;
      for (let gx = minGx; gx <= maxGx; gx++) {
        const bucket = this.cells[rowOffset + gx];
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const t = bucket[i]!;
          const dx = t.x - x;
          const dz = t.z - z;
          const dsq = dx * dx + dz * dz;
          if (dsq < nearestSq) {
            nearestSq = dsq;
            found = true;
          }
        }
      }
    }
    return found ? Math.sqrt(nearestSq) : Infinity;
  }
}
