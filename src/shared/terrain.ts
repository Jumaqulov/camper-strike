import { PLAYER_HEIGHT, PLAYER_RADIUS } from './constants';
import { clamp, q3, type Vec3 } from './math';
import type { ColliderBox, HeightfieldTerrainDescriptor, TerrainDescriptor } from './world';

export const DEFAULT_MAX_WALKABLE_SLOPE_DEG = 42;

const RAD_TO_DEG = 180 / Math.PI;


/**
 * Exact triangle-aligned height sampling.
 * For `HeightfieldTerrainDescriptor`, each grid cell (ix, iz) is split along the diagonal `u + v = 1`
 * into two triangles:
 * - Upper-left (`u + v <= 1`): (0, h00, 0), (1, h10, 0), (0, h01, 1)
 * - Lower-right (`u + v > 1`): (1, h10, 0), (1, h11, 1), (0, h01, 1)
 * This matches the exact triangulation built by `buildTerrainMeshData` in the renderer.
 */
export function sampleTerrainHeight(terrain: TerrainDescriptor, x: number, z: number): number {
  return sampleHeightfieldTriangle(terrain, x, z).height;
}

export function sampleTerrainNormal(terrain: TerrainDescriptor, x: number, z: number): Vec3 {
  return sampleHeightfieldTriangle(terrain, x, z).normal;
}

export function sampleTerrainSlopeDeg(terrain: TerrainDescriptor, x: number, z: number): number {
  const n = sampleTerrainNormal(terrain, x, z);
  return Math.acos(clamp(n.y, -1, 1)) * RAD_TO_DEG;
}

export function isTerrainWalkable(
  terrain: TerrainDescriptor,
  x: number,
  z: number,
  maxWalkableSlopeDeg = DEFAULT_MAX_WALKABLE_SLOPE_DEG,
): boolean {
  return sampleTerrainSlopeDeg(terrain, x, z) <= maxWalkableSlopeDeg;
}

function getGridHeightClamped(hf: HeightfieldTerrainDescriptor, col: number, row: number): number {
  const c = clamp(col, 0, hf.cols - 1);
  const r = clamp(row, 0, hf.rows - 1);
  return hf.heights[r * hf.cols + c] ?? 0;
}

export interface HeightfieldSample {
  height: number;
  normal: Vec3;
  slopeDeg: number;
}

export type TerrainTriangleSample = HeightfieldSample;

export function sampleHeightfieldTriangle(
  hf: HeightfieldTerrainDescriptor,
  x: number,
  z: number,
): HeightfieldSample {
  const maxX = hf.originX + hf.width;
  const maxZ = hf.originZ + hf.depth;
  const cx = clamp(x, hf.originX, maxX);
  const cz = clamp(z, hf.originZ, maxZ);

  const gx = (cx - hf.originX) / hf.cellSize;
  const gz = (cz - hf.originZ) / hf.cellSize;

  const ix = clamp(Math.floor(gx), 0, Math.max(0, hf.cols - 2));
  const iz = clamp(Math.floor(gz), 0, Math.max(0, hf.rows - 2));

  const u = clamp(gx - ix, 0, 1);
  const v = clamp(gz - iz, 0, 1);

  const h00 = getGridHeightClamped(hf, ix, iz);
  const h10 = getGridHeightClamped(hf, ix + 1, iz);
  const h01 = getGridHeightClamped(hf, ix, iz + 1);
  const h11 = getGridHeightClamped(hf, ix + 1, iz + 1);

  let height: number;
  let dhdx: number;
  let dhdz: number;

  if (u + v <= 1) {
    // Upper-left triangle: (0,0) -> (1,0) -> (0,1)
    height = h00 + u * (h10 - h00) + v * (h01 - h00);
    dhdx = (h10 - h00) / hf.cellSize;
    dhdz = (h01 - h00) / hf.cellSize;
  } else {
    // Lower-right triangle: (1,0) -> (1,1) -> (0,1)
    height = h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
    dhdx = (h11 - h01) / hf.cellSize;
    dhdz = (h11 - h10) / hf.cellSize;
  }

  const invLen = 1 / Math.hypot(dhdx, 1, dhdz);
  const normal: Vec3 = {
    x: -dhdx * invLen,
    y: invLen,
    z: -dhdz * invLen,
  };
  const slopeDeg = Math.acos(clamp(normal.y, -1, 1)) * RAD_TO_DEG;

  return { height, normal, slopeDeg };
}

// ---------------- Ray vs Terrain Intersection ----------------

export interface TerrainRayHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
}

function intersectRayTriangle(
  o: Vec3,
  d: Vec3,
  v0: Vec3,
  v1: Vec3,
  v2: Vec3,
  maxT: number,
): TerrainRayHit | null {
  const e1x = v1.x - v0.x;
  const e1y = v1.y - v0.y;
  const e1z = v1.z - v0.z;

  const e2x = v2.x - v0.x;
  const e2y = v2.y - v0.y;
  const e2z = v2.z - v0.z;

  const px = d.y * e2z - d.z * e2y;
  const py = d.z * e2x - d.x * e2z;
  const pz = d.x * e2y - d.y * e2x;

  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-8) return null;
  const invDet = 1 / det;

  const tx = o.x - v0.x;
  const ty = o.y - v0.y;
  const tz = o.z - v0.z;

  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < -1e-6 || u > 1 + 1e-6) return null;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v = (d.x * qx + d.y * qy + d.z * qz) * invDet;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;

  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (t < 0 || t > maxT) return null;

  // Compute upward unit normal of triangle (v0, v1, v2)
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return { t, nx: nx / len, ny: ny / len, nz: nz / len };
}

export function raycastTerrain(
  terrain: TerrainDescriptor,
  origin: Vec3,
  dir: Vec3,
  maxT: number,
): TerrainRayHit | null {
  return raycastHeightfieldTerrain(terrain, origin, dir, maxT);
}

function raycastHeightfieldTerrain(
  hf: HeightfieldTerrainDescriptor,
  origin: Vec3,
  dir: Vec3,
  maxT: number,
): TerrainRayHit | null {
  const minX = hf.originX;
  const maxX = hf.originX + hf.width;
  const minZ = hf.originZ;
  const maxZ = hf.originZ + hf.depth;

  // Clip ray XZ segment to heightfield XZ bounds
  let t0 = 0;
  let t1 = maxT;
  const origArr = [origin.x, origin.z];
  const dirArr = [dir.x, dir.z];
  const bMin = [minX, minZ];
  const bMax = [maxX, maxZ];

  for (let a = 0; a < 2; a++) {
    if (Math.abs(dirArr[a]) < 1e-9) {
      if (origArr[a] < bMin[a] || origArr[a] > bMax[a]) return null;
      continue;
    }
    const inv = 1 / dirArr[a];
    let ta = (bMin[a] - origArr[a]) * inv;
    let tb = (bMax[a] - origArr[a]) * inv;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }

  const cellsX = hf.cols - 1;
  const cellsZ = hf.rows - 1;
  if (cellsX <= 0 || cellsZ <= 0) return null;

  let best: TerrainRayHit | null = null;
  let bestT = maxT;

  const testCell = (ix: number, iz: number) => {
    if (ix < 0 || iz < 0 || ix >= cellsX || iz >= cellsZ) return;
    const x0 = hf.originX + ix * hf.cellSize;
    const z0 = hf.originZ + iz * hf.cellSize;
    const x1 = x0 + hf.cellSize;
    const z1 = z0 + hf.cellSize;

    const h00 = getGridHeightClamped(hf, ix, iz);
    const h10 = getGridHeightClamped(hf, ix + 1, iz);
    const h01 = getGridHeightClamped(hf, ix, iz + 1);
    const h11 = getGridHeightClamped(hf, ix + 1, iz + 1);

    const v00: Vec3 = { x: x0, y: h00, z: z0 };
    const v10: Vec3 = { x: x1, y: h10, z: z0 };
    const v01: Vec3 = { x: x0, y: h01, z: z1 };
    const v11: Vec3 = { x: x1, y: h11, z: z1 };

    // Upper-left triangle: v00, v01, v10
    const hitA = intersectRayTriangle(origin, dir, v00, v01, v10, bestT);
    if (hitA && hitA.t < bestT) {
      best = hitA;
      bestT = hitA.t;
    }

    // Lower-right triangle: v10, v01, v11
    const hitB = intersectRayTriangle(origin, dir, v10, v01, v11, bestT);
    if (hitB && hitB.t < bestT) {
      best = hitB;
      bestT = hitB.t;
    }
  };

  // Step along the ray in cell-sized increments and test the 2x2 neighborhood around each step
  const horizSpeed = Math.hypot(dir.x, dir.z);
  const stepT = horizSpeed > 1e-5 ? (hf.cellSize * 0.45) / horizSpeed : t1 - t0 + 1;
  const maxSteps = Math.min(2048, Math.ceil((t1 - t0) / Math.max(1e-4, stepT)) + 2);

  let prevIx = -999999;
  let prevIz = -999999;

  for (let s = 0; s <= maxSteps; s++) {
    const t = Math.min(t1, t0 + s * stepT);
    if (t > bestT + stepT) break;
    const px = origin.x + dir.x * t;
    const pz = origin.z + dir.z * t;
    const ix = clamp(Math.floor((px - hf.originX) / hf.cellSize), 0, cellsX - 1);
    const iz = clamp(Math.floor((pz - hf.originZ) / hf.cellSize), 0, cellsZ - 1);
    if (ix === prevIx && iz === prevIz) continue;
    prevIx = ix;
    prevIz = iz;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        testCell(ix + dx, iz + dz);
      }
    }
  }

  return best;
}

// ---------------- Shared Terrain Mesh Triangulation Builder ----------------

export interface TerrainMeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export type TerrainMeshData = TerrainMeshBuffers;

/**
 * Generates vertex/index buffers for a `HeightfieldTerrainDescriptor` using the exact same
 * `u + v <= 1` diagonal triangulation used by `sampleHeightfieldTriangle` and `raycastHeightfieldTerrain`.
 * Colors vertices by elevation and slope so walkable vs. steep (> maxWalkableSlopeDeg) regions are visually clear.
 */
export type TerrainVertexColorSampler = (
  x: number,
  y: number,
  z: number,
  slopeDeg: number,
) => [number, number, number];

export function buildTerrainMeshData(
  hf: HeightfieldTerrainDescriptor,
  maxWalkableSlopeDeg = DEFAULT_MAX_WALKABLE_SLOPE_DEG,
  colorSampler?: TerrainVertexColorSampler,
): TerrainMeshBuffers {
  const cols = hf.cols;
  const rows = hf.rows;
  const vertCount = cols * rows;
  const cellsX = cols - 1;
  const cellsZ = rows - 1;
  const indexCount = cellsX * cellsZ * 6;

  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(indexCount);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const x = hf.originX + c * hf.cellSize;
      const z = hf.originZ + r * hf.cellSize;
      const y = getGridHeightClamped(hf, c, r);

      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;

      uvs[idx * 2] = x * 0.25;
      uvs[idx * 2 + 1] = z * 0.25;

      // Smooth vertex normal from neighboring samples
      const hL = getGridHeightClamped(hf, c - 1, r);
      const hR = getGridHeightClamped(hf, c + 1, r);
      const hD = getGridHeightClamped(hf, c, r - 1);
      const hU = getGridHeightClamped(hf, c, r + 1);
      const dhdx = (hR - hL) / (2 * hf.cellSize);
      const dhdz = (hU - hD) / (2 * hf.cellSize);
      const invLen = 1 / Math.hypot(dhdx, 1, dhdz);
      const nx = -dhdx * invLen;
      const ny = invLen;
      const nz = -dhdz * invLen;

      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = ny;
      normals[idx * 3 + 2] = nz;

      // Also check max face slope among adjacent triangles so steep cliffs color accurately
      const sample = sampleHeightfieldTriangle(
        hf,
        clamp(x + 0.01, hf.originX, hf.originX + hf.width - 0.01),
        clamp(z + 0.01, hf.originZ, hf.originZ + hf.depth - 0.01),
      );
      const slopeDeg = Math.max(Math.acos(clamp(ny, -1, 1)) * RAD_TO_DEG, sample.slopeDeg);

      if (colorSampler) {
        const [cr, cg, cb] = colorSampler(x, y, z, slopeDeg);
        colors[idx * 3] = cr;
        colors[idx * 3 + 1] = cg;
        colors[idx * 3 + 2] = cb;
      } else if (slopeDeg > maxWalkableSlopeDeg) {
        // Steep unwalkable rock/cliff face (slate-grey stone)
        colors[idx * 3] = 0.44;
        colors[idx * 3 + 1] = 0.46;
        colors[idx * 3 + 2] = 0.48;
      } else if (y < -0.25) {
        // Low hollow / depression (warm earthy soil-moss)
        const k = clamp((-y - 0.25) / 1.8, 0, 1);
        colors[idx * 3] = 0.28 + k * 0.14;
        colors[idx * 3 + 1] = 0.42 - k * 0.10;
        colors[idx * 3 + 2] = 0.18 - k * 0.04;
      } else if (y > 0.6) {
        // Walkable hill / high ground (warm sunlit meadow green)
        const k = clamp((y - 0.6) / 3.0, 0, 1);
        colors[idx * 3] = 0.34 + k * 0.10;
        colors[idx * 3 + 1] = 0.52 + k * 0.08;
        colors[idx * 3 + 2] = 0.22 + k * 0.04;
      } else {
        // Base forest grass
        colors[idx * 3] = 0.30;
        colors[idx * 3 + 1] = 0.47;
        colors[idx * 3 + 2] = 0.20;
      }
    }
  }

  let ptr = 0;
  for (let r = 0; r < cellsZ; r++) {
    for (let c = 0; c < cellsX; c++) {
      const i00 = r * cols + c;
      const i10 = i00 + 1;
      const i01 = (r + 1) * cols + c;
      const i11 = i01 + 1;

      // Upper-left triangle (u + v <= 1): i00 -> i01 -> i10 (CCW facing +Y)
      indices[ptr++] = i00;
      indices[ptr++] = i01;
      indices[ptr++] = i10;

      // Lower-right triangle (u + v > 1): i10 -> i01 -> i11 (CCW facing +Y)
      indices[ptr++] = i10;
      indices[ptr++] = i01;
      indices[ptr++] = i11;
    }
  }

  return { positions, normals, colors, uvs, indices };
}

// ---------------- Deterministic Technical Terrain Fixture & Object Grounding ----------------

export interface BuildTechnicalHeightfieldOpts {
  seed: number;
  width?: number;
  depth?: number;
  cellSize?: number;
}

/**
 * Builds the deterministic 02B technical heightfield containing:
 * - Walkable hill (`tepalik`) at (-14, 0) with peak ~ +3.0 m and ~24 deg slopes
 * - Depression (`pastlik`) at (14, -12) dipping to ~ -2.0 m
 * - Walkable gentle slope (`yurish mumkin bo'lgan qiyalik`) along (-14..0, 0)
 * - Steep unwalkable ridge (`juda tik qiyalik`, > 52 deg) around (0, -18)
 */
export function buildTechnicalHeightfield(
  seedOrOpts: number | BuildTechnicalHeightfieldOpts = 6501,
): HeightfieldTerrainDescriptor {
  const opts: BuildTechnicalHeightfieldOpts =
    typeof seedOrOpts === 'number' ? { seed: seedOrOpts } : seedOrOpts;
  const width = opts.width ?? 64;
  const depth = opts.depth ?? 64;
  const cellSize = opts.cellSize ?? 2;
  const originX = -width / 2;
  const originZ = -depth / 2;
  const cols = Math.floor(width / cellSize) + 1;
  const rows = Math.floor(depth / cellSize) + 1;
  const heights: number[] = new Array(cols * rows);

  // Deterministic seed phase offset (pure function of opts.seed)
  const seedPhase = ((opts.seed * 2654435761) >>> 0) / 4294967296;
  const microAmp = 0.06;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = originX + c * cellSize;
      const z = originZ + r * cellSize;

      // 1. Walkable hill centered at (-14, 0): radius ~11m, peak +3.0m (max slope ~25 deg <= 42 deg)
      const dHill = Math.hypot(x - -14, z - 0);
      const hill = dHill < 11 ? 3.0 * Math.pow(Math.cos((dHill / 11) * (Math.PI / 2)), 2) : 0;

      // 2. Depression / hollow centered at (14, -12): radius ~9m, depth -2.0m (walkable bowl)
      const dPit = Math.hypot(x - 14, z - -12);
      const pit = dPit < 9 ? -2.0 * Math.pow(Math.cos((dPit / 9) * (Math.PI / 2)), 2) : 0;

      // 3. Steep unwalkable cliff ridge centered at (0, -20): x in [-8..8], z in [-24..-16]
      // Rises 5.2m over 4m (1.3 m/m => 52.4 deg slope > 42 deg maxWalkableSlopeDeg!)
      let cliff = 0;
      if (Math.abs(x) <= 8 && z >= -24 && z <= -16) {
        const xMask = clamp((8 - Math.abs(x)) / 2, 0, 1);
        const distFromRidge = Math.abs(z - -20);
        cliff = 5.2 * Math.max(0, 1 - distFromRidge / 4) * xMask;
      }

      // Keep platform/wall zone around (x: -8..18, z: 8..20) va spawn nuqtalari tekisroq
      const flatZoneMask = z >= 6 && z <= 22 && x >= -10 && x <= 20 ? 0 : 1;
      const micro =
        flatZoneMask *
        microAmp *
        Math.sin(x * 0.18 + seedPhase * Math.PI * 2) *
        Math.cos(z * 0.18 - seedPhase * Math.PI);

      heights[r * cols + c] = q3(hill + pit + cliff + micro);
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
 * Helper for grounding future buildings, trees, rocks, and loot items on the terrain.
 */
export function getGroundedPosition(
  terrain: TerrainDescriptor,
  x: number,
  z: number,
  yOffset = 0,
): Vec3 {
  return {
    x: q3(x),
    y: q3(sampleTerrainHeight(terrain, x, z) + yOffset),
    z: q3(z),
  };
}

export function createGroundedTreeCollider(
  id: string,
  terrain: TerrainDescriptor,
  x: number,
  z: number,
  trunkRadius = 0.45,
  trunkHeight = 4.5,
): ColliderBox {
  const baseY = sampleTerrainHeight(terrain, x, z);
  return {
    id,
    tag: 'tree',
    mat: 'wall',
    min: { x: q3(x - trunkRadius), y: q3(baseY - 0.2), z: q3(z - trunkRadius) },
    max: { x: q3(x + trunkRadius), y: q3(baseY + trunkHeight), z: q3(z + trunkRadius) },
    // O'q uchun: dumaloq tana (quti burchaklari emas)
    hit: { kind: 'cylinder', cx: q3(x), cz: q3(z), r: q3(trunkRadius) },
  };
}

export function createGroundedRockCollider(
  id: string,
  terrain: TerrainDescriptor,
  x: number,
  z: number,
  sizeOrSx: Vec3 | number,
  sy = 1.4,
  sz = 1.8,
): ColliderBox {
  const sx = typeof sizeOrSx === 'number' ? sizeOrSx : sizeOrSx.x;
  const h = typeof sizeOrSx === 'number' ? sy : sizeOrSx.y;
  const d = typeof sizeOrSx === 'number' ? sz : sizeOrSx.z;
  const baseY = sampleTerrainHeight(terrain, x, z);
  const minY = q3(baseY - 0.15);
  const maxY = q3(baseY + h - 0.15);
  return {
    id,
    tag: 'rock',
    mat: 'wall',
    min: { x: q3(x - sx / 2), y: minY, z: q3(z - d / 2) },
    max: { x: q3(x + sx / 2), y: maxY, z: q3(z + d / 2) },
    // O'q uchun: yumaloq tosh (ellipsoid), quti burchaklari havoda qolmasin
    hit: {
      kind: 'ellipsoid',
      cx: q3(x),
      cy: q3((minY + maxY) / 2),
      cz: q3(z),
      rx: q3(sx / 2),
      ry: q3((maxY - minY) / 2),
      rz: q3(d / 2),
    },
  };
}

export function isCapsuleClearOfBoxes(
  boxes: readonly ColliderBox[],
  x: number,
  y: number,
  z: number,
  r = PLAYER_RADIUS,
  h = PLAYER_HEIGHT,
): boolean {
  for (const b of boxes) {
    if (
      x + r > b.min.x &&
      x - r < b.max.x &&
      y + h > b.min.y &&
      y < b.max.y &&
      z + r > b.min.z &&
      z - r < b.max.z
    ) {
      return false;
    }
  }
  return true;
}
