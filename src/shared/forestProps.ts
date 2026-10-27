/**
 * Stage 08-FIX — Hard forest prop colliders (`prop:fallen_log`, `prop:tree_stump`).
 *
 * Pure (no THREE) collider builders that mirror the procedural instanced geometry built by
 * `ForestRenderer.ts#buildUndergrowthPrototypes` and the per-instance matrix composed there:
 *
 * - Fallen log: `CylinderGeometry(0.22, 0.27, 2.7)` rotated about Z by `(π/2 − 0.04)` and moved to
 *   `y = 0.2` → the log axis runs along local **X** (half-length ≈ 1.349 m). The thin end (r = 0.22)
 *   sits at local −X (y ≈ 0.254), the thick end (r = 0.27) at local +X (y ≈ 0.146).
 *   Instance matrix = `T(position) · R(tilt to terrain normal) · R_y(yaw) · S(scale)`.
 * - Tree stump: `CylinderGeometry(0.28, 0.42, 0.62)` at `y = 0.28` → base radius 0.42, top y ≈ 0.59.
 *   Instance matrix = `T(position) · R_y(yaw) · S(sc, sy, sc)` (no slope alignment).
 *
 * Fallen logs are approximated by N yaw-aware AABB segments along the (tilted) log axis so the union
 * of segment AABBs never overhangs the true visual footprint by more than ~0.1 m (no invisible walls),
 * while the log body itself cannot be walked through. Stumps use one AABB (half-extent 0.8 × base radius).
 */
import { q3, type Vec3 } from './math';
import { sampleTerrainHeight, sampleTerrainNormal } from './terrain';
import type { ColliderBox, PlacementTransform, TerrainDescriptor } from './world';


export const FALLEN_LOG_PREFAB_ID = 'prop:fallen_log';
export const TREE_STUMP_PREFAB_ID = 'prop:tree_stump';

/** Prefab IDs of forest props that are solid (must have colliders). Soft layers are NOT listed. */
export const HARD_FOREST_PROP_PREFAB_IDS: readonly string[] = [FALLEN_LOG_PREFAB_ID, TREE_STUMP_PREFAB_ID];

export function isHardForestPropPrefab(prefabId: string): boolean {
  return prefabId === FALLEN_LOG_PREFAB_ID || prefabId === TREE_STUMP_PREFAB_ID;
}

// ---------------- Renderer geometry mirror (ForestRenderer.buildUndergrowthPrototypes) ----------------

const LOG_CYL_HALF_LENGTH = 2.7 / 2;
const LOG_TILT_Z = Math.PI / 2 - 0.04;
/** Half-length of the log axis projected on local X (≈ 1.3489 m). */
export const FALLEN_LOG_LOCAL_HALF_LENGTH = LOG_CYL_HALF_LENGTH * Math.sin(LOG_TILT_Z);
/** Vertical rise of the thin end above the center line (≈ 0.054 m). */
const LOG_HALF_RISE = LOG_CYL_HALF_LENGTH * Math.cos(LOG_TILT_Z);
const LOG_CENTER_Y = 0.2;
const LOG_RADIUS_THIN = 0.22; // local −X end
const LOG_RADIUS_THICK = 0.27; // local +X end
export const FALLEN_LOG_MAX_RADIUS = LOG_RADIUS_THICK;

export const TREE_STUMP_BASE_RADIUS = 0.42;
export const TREE_STUMP_TOP_Y = 0.28 + 0.62 / 2; // 0.59
/** Stump collider half-extent as a fraction of the base radius (keeps the box inside the visual). */
export const TREE_STUMP_HALF_EXTENT_FACTOR = 0.8;

// ---------------- Segmentation tolerances ----------------

/** Max sideways overhang (perpendicular to the log axis) of any segment AABB beyond the visual. */
const LOG_PERP_TOLERANCE = 0.1;
/** Max overhang beyond the log end caps (end segments are pulled inward to respect it). */
const LOG_END_TOLERANCE = 0.08;
const LOG_MAX_SEGMENTS = 18;
/** Collider bottom below the lowest sampled terrain point under the footprint. */
const GROUND_EPSILON = 0.05;

/** Center-line height of the log at local axis coordinate `u` (unscaled). */
function logCenterY(u: number): number {
  return LOG_CENTER_Y - (u / FALLEN_LOG_LOCAL_HALF_LENGTH) * LOG_HALF_RISE;
}

/** Nominal cylinder radius of the log at local axis coordinate `u` (unscaled). */
function logRadius(u: number): number {
  const t = (u / FALLEN_LOG_LOCAL_HALF_LENGTH + 1) * 0.5; // 0 at thin end (−X), 1 at thick end (+X)
  return LOG_RADIUS_THIN + (LOG_RADIUS_THICK - LOG_RADIUS_THIN) * Math.min(1, Math.max(0, t));
}

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
    y: a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
    z: a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function quatApply(q: Quat, v: Vec3): Vec3 {
  // Same formula as THREE.Vector3.applyQuaternion
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

/** Mirrors `tiltQuat.setFromUnitVectors(up, n) · yawQuat.setFromAxisAngle(up, yaw)` in ForestRenderer. */
function logOrientation(terrain: TerrainDescriptor | undefined, x: number, z: number, yaw: number): Quat {
  const half = yaw * 0.5;
  const yawQ: Quat = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
  if (!terrain) return yawQ;
  const n = sampleTerrainNormal(terrain, x, z);
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  const nx = n.x / len;
  const ny = n.y / len;
  const nz = n.z / len;
  // setFromUnitVectors((0,1,0), n): cross = up × n = (nz, 0, −nx), w = dot + 1
  let tilt: Quat = { x: nz, y: 0, z: -nx, w: ny + 1 };
  const tl = Math.hypot(tilt.x, tilt.y, tilt.z, tilt.w);
  tilt = tl > 1e-9 ? { x: tilt.x / tl, y: 0, z: tilt.z / tl, w: tilt.w / tl } : { x: 0, y: 0, z: 0, w: 1 };
  return quatMul(tilt, yawQ);
}

function groundAt(terrain: TerrainDescriptor | undefined, x: number, z: number, fallbackY: number): number {
  return terrain ? sampleTerrainHeight(terrain, x, z) : fallbackY;
}

export interface FallenLogFootprint {
  /** World-space center-line endpoints (thin end `a` at local −X, thick end `b` at local +X). */
  a: Vec3;
  b: Vec3;
  /** Horizontal half-width (nominal max radius × scale.z). */
  halfWidth: number;
  /** World Y of the visual top (max over the log). */
  topY: number;
}

/** World point on the (tilted, scaled, yawed) log center line at local axis coordinate `u`. */
function logAxisPoint(q: Quat, t: PlacementTransform, u: number): Vec3 {
  const local: Vec3 = { x: u * t.scale.x, y: logCenterY(u) * t.scale.y, z: 0 };
  const r = quatApply(q, local);
  return { x: t.position.x + r.x, y: t.position.y + r.y, z: t.position.z + r.z };
}

/**
 * Oriented horizontal footprint of the fallen-log visual (used by tests / debug overlays).
 */
export function getFallenLogFootprint(
  transform: PlacementTransform,
  terrain?: TerrainDescriptor,
): FallenLogFootprint {
  const q = logOrientation(terrain, transform.position.x, transform.position.z, transform.yaw);
  const U = FALLEN_LOG_LOCAL_HALF_LENGTH;
  const a = logAxisPoint(q, transform, -U);
  const b = logAxisPoint(q, transform, U);
  const topY = Math.max(a.y + LOG_RADIUS_THIN * transform.scale.y, b.y + LOG_RADIUS_THICK * transform.scale.y);
  return { a, b, halfWidth: LOG_RADIUS_THICK * transform.scale.z, topY };
}

/**
 * Builds segmented, yaw-aware AABB colliders for one `prop:fallen_log` instance.
 * IDs: `${id}:col:seg{i}`, `sourceObjectId = id`, tag `'prop'`, mat `'crate'`.
 *
 * `terrain` (optional) enables the renderer's slope alignment and terrain-grounded collider bottoms;
 * without it the log is treated as lying on flat ground at `transform.position.y`.
 */
export function buildFallenLogColliders(
  id: string,
  transform: PlacementTransform,
  terrain?: TerrainDescriptor,
): ColliderBox[] {
  const { position, scale } = transform;
  const q = logOrientation(terrain, position.x, position.z, transform.yaw);
  const U = FALLEN_LOG_LOCAL_HALF_LENGTH;

  const endA = logAxisPoint(q, transform, -U);
  const endB = logAxisPoint(q, transform, U);
  let dx = endB.x - endA.x;
  let dz = endB.z - endA.z;
  const horizLen = Math.hypot(dx, dz);
  if (horizLen < 1e-6) {
    dx = 1;
    dz = 0;
  } else {
    dx /= horizLen;
    dz /= horizLen;
  }
  // |sin 2φ| of the horizontal axis direction drives how much an AABB overhangs a rotated rectangle.
  const s2 = Math.abs(2 * dx * dz);
  const maxHalfWidth = LOG_RADIUS_THICK * scale.z;

  // Pull end segments inward so the AABB corners do not poke past the end caps by > LOG_END_TOLERANCE.
  const worldPerLocalU = horizLen / (2 * U) || scale.x;
  const endShrinkWorld = Math.min(0.25 * horizLen, Math.max(0, maxHalfWidth * s2 - LOG_END_TOLERANCE));
  const endShrinkU = endShrinkWorld / worldPerLocalU;
  const u0 = -U + endShrinkU;
  const u1 = U - endShrinkU;
  const usedLen = (u1 - u0) * worldPerLocalU;

  // Segment length ℓ overhangs sideways by (ℓ/2)·|sin 2φ| → ℓ ≤ 2·tol/|sin 2φ|.
  const segCount = Math.max(
    1,
    Math.min(LOG_MAX_SEGMENTS, Math.ceil((usedLen * s2) / (2 * LOG_PERP_TOLERANCE) - 1e-9)),
  );

  const colliders: ColliderBox[] = [];
  const nx = -dz;
  const nz = dx;
  for (let i = 0; i < segCount; i++) {
    const ua = u0 + ((u1 - u0) * i) / segCount;
    const ub = u0 + ((u1 - u0) * (i + 1)) / segCount;
    const pa = logAxisPoint(q, transform, ua);
    const pb = logAxisPoint(q, transform, ub);
    const halfW = Math.max(logRadius(ua), logRadius(ub)) * scale.z;

    const cornersX = [pa.x + nx * halfW, pa.x - nx * halfW, pb.x + nx * halfW, pb.x - nx * halfW];
    const cornersZ = [pa.z + nz * halfW, pa.z - nz * halfW, pb.z + nz * halfW, pb.z - nz * halfW];
    const minX = Math.min(...cornersX);
    const maxX = Math.max(...cornersX);
    const minZ = Math.min(...cornersZ);
    const maxZ = Math.max(...cornersZ);

    let lowGround = Math.min(
      groundAt(terrain, pa.x, pa.z, position.y),
      groundAt(terrain, pb.x, pb.z, position.y),
    );
    for (let c = 0; c < 4; c++) {
      lowGround = Math.min(lowGround, groundAt(terrain, cornersX[c], cornersZ[c], position.y));
    }
    const visualBottom = Math.min(pa.y - logRadius(ua) * scale.y, pb.y - logRadius(ub) * scale.y);
    const minY = Math.min(lowGround - GROUND_EPSILON, visualBottom);
    let maxY = Math.max(pa.y + logRadius(ua) * scale.y, pb.y + logRadius(ub) * scale.y);
    if (maxY < minY + 0.1) maxY = minY + 0.1;

    colliders.push({
      id: `${id}:col:seg${i}`,
      tag: 'prop',
      mat: 'crate',
      sourceObjectId: id,
      min: { x: q3(minX), y: q3(minY), z: q3(minZ) },
      max: { x: q3(maxX), y: q3(maxY), z: q3(maxZ) },
    });
  }
  return colliders;
}

/**
 * Builds a single AABB collider for one `prop:tree_stump` instance (approximates the round stump with
 * half-extent `0.8 × baseRadius × scale.x` so it never overhangs the visual by more than a few cm).
 * ID: `${id}:col`, `sourceObjectId = id`, tag `'prop'`, mat `'crate'`.
 */
export function buildTreeStumpCollider(
  id: string,
  transform: PlacementTransform,
  terrain?: TerrainDescriptor,
): ColliderBox[] {
  const { position, scale } = transform;
  const half = TREE_STUMP_BASE_RADIUS * TREE_STUMP_HALF_EXTENT_FACTOR * Math.max(scale.x, scale.z);
  const minX = position.x - half;
  const maxX = position.x + half;
  const minZ = position.z - half;
  const maxZ = position.z + half;
  let lowGround = groundAt(terrain, position.x, position.z, position.y);
  for (const [cx, cz] of [
    [minX, minZ],
    [maxX, minZ],
    [minX, maxZ],
    [maxX, maxZ],
  ] as const) {
    lowGround = Math.min(lowGround, groundAt(terrain, cx, cz, position.y));
  }
  const minY = Math.min(lowGround, position.y) - GROUND_EPSILON;
  const maxY = Math.max(position.y + TREE_STUMP_TOP_Y * scale.y, minY + 0.1);
  return [
    {
      id: `${id}:col`,
      tag: 'prop',
      mat: 'crate',
      sourceObjectId: id,
      min: { x: q3(minX), y: q3(minY), z: q3(minZ) },
      max: { x: q3(maxX), y: q3(maxY), z: q3(maxZ) },
    },
  ];
}

/**
 * Dispatches to the matching hard-prop collider builder; returns `[]` for soft/visual-only prefabs.
 */
export function buildHardForestPropColliders(
  prefabId: string,
  id: string,
  transform: PlacementTransform,
  terrain?: TerrainDescriptor,
): ColliderBox[] {
  if (prefabId === FALLEN_LOG_PREFAB_ID) return buildFallenLogColliders(id, transform, terrain);
  if (prefabId === TREE_STUMP_PREFAB_ID) return buildTreeStumpCollider(id, transform, terrain);
  return [];
}
