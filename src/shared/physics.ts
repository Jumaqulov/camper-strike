import {
  AIR_ACCEL,
  BODY_HITBOX,
  GRAVITY,
  GROUND_ACCEL,
  HEAD_HITBOX,
  JUMP_SPEED,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  STEP_HEIGHT,
} from './constants';
import type { Box } from './map';
import type { Vec3 } from './math';
import { getWorldSpatialIndex } from './spatialIndex';
import {
  DEFAULT_MAX_WALKABLE_SLOPE_DEG,
  isTerrainWalkable,
  raycastTerrain,
  sampleTerrainHeight,
  sampleTerrainNormal,
  sampleTerrainSlopeDeg,
} from './terrain';
import type { ColliderBox, WorldDefinition } from './world';

export interface Body {
  pos: Vec3; // oyoq nuqtasi
  vel: Vec3;
  onGround: boolean;
}

export interface WorldMovementOptions {
  maxWalkableSlopeDeg?: number;
}

export function boxOverlap(x: number, y: number, z: number, r: number, h: number, b: Box): boolean {
  return (
    x + r > b.min.x && x - r < b.max.x &&
    y + h > b.min.y && y < b.max.y &&
    z + r > b.min.z && z - r < b.max.z
  );
}

export function collidesAt(boxes: Box[], x: number, y: number, z: number, r = PLAYER_RADIUS, h = PLAYER_HEIGHT): boolean {
  for (const b of boxes) if (boxOverlap(x, y, z, r, h, b)) return true;
  return false;
}

/**
 * Spatial-indexed collider lookup around `(x, z)` within `radius`.
 */
export function queryNearbyColliders(
  world: WorldDefinition,
  x: number,
  z: number,
  radius: number,
  minY = -Infinity,
  maxY = Infinity,
): ColliderBox[] {
  return getWorldSpatialIndex(world).queryRadius(x, z, radius, minY, maxY);
}

/**
 * Unified world overlap check against world bounds, heightfield terrain, and spatial-indexed colliders.
 */
export function collidesAtWorld(
  world: WorldDefinition,
  x: number,
  y: number,
  z: number,
  r = PLAYER_RADIUS,
  h = PLAYER_HEIGHT,
): boolean {
  if (
    x - r < world.bounds.minX ||
    x + r > world.bounds.maxX ||
    z - r < world.bounds.minZ ||
    z + r > world.bounds.maxZ
  ) {
    return true;
  }
  if (world.terrain.kind === 'heightfield') {
    const groundY = sampleTerrainHeight(world.terrain, x, z);
    if (y < groundY - 1e-3) return true;
  }
  const candidates = getWorldSpatialIndex(world).queryAABB(x - r, z - r, x + r, z + r, y, y + h);
  for (const b of candidates) {
    if (boxOverlap(x, y, z, r, h, b)) return true;
  }
  return false;
}

/**
 * Checks whether a spawn point is safe: inside world bounds, on walkable terrain or a structure surface,
 * and free of collider or underground overlap.
 */
export function isSpawnPointSafe(
  world: WorldDefinition,
  spawn: { x: number; y?: number; z: number },
  maxWalkableSlopeDeg = DEFAULT_MAX_WALKABLE_SLOPE_DEG,
): boolean {
  const r = PLAYER_RADIUS;
  const h = PLAYER_HEIGHT;
  if (
    spawn.x - r < world.bounds.minX ||
    spawn.x + r > world.bounds.maxX ||
    spawn.z - r < world.bounds.minZ ||
    spawn.z + r > world.bounds.maxZ
  ) {
    return false;
  }

  const groundY = sampleTerrainHeight(world.terrain, spawn.x, spawn.z);
  const y = spawn.y ?? groundY;

  if (y < groundY - 0.05) return false;

  const onTerrain = Math.abs(y - groundY) <= 0.08;
  if (onTerrain && !isTerrainWalkable(world.terrain, spawn.x, spawn.z, maxWalkableSlopeDeg)) {
    return false;
  }

  const candidates = getWorldSpatialIndex(world).queryAABB(
    spawn.x - r,
    spawn.z - r,
    spawn.x + r,
    spawn.z + r,
    y - 0.1,
    y + h,
  );

  let hasColliderSupport = false;
  for (const b of candidates) {
    if (b.tag === 'ground') continue;
    // Check if player capsule above feet overlaps any solid collider
    if (boxOverlap(spawn.x, y + 0.01, spawn.z, r, h - 0.01, b)) return false;
    // Check if this collider's top surface supports the player's feet
    if (
      b.tag !== 'boundary' &&
      spawn.x + r > b.min.x &&
      spawn.x - r < b.max.x &&
      spawn.z + r > b.min.z &&
      spawn.z - r < b.max.z &&
      Math.abs(y - b.max.y) <= 0.08
    ) {
      hasColliderSupport = true;
    }
  }

  // Must rest either on walkable terrain OR on top of a valid support collider (not floating in mid-air)
  if (!onTerrain && !hasColliderSupport) {
    return false;
  }

  return true;
}

function moveAxis(body: Body, axis: 'x' | 'z', d: number, boxes: Box[], canStep: boolean) {
  if (d === 0) return;
  const p = body.pos;
  const r = PLAYER_RADIUS;
  const h = PLAYER_HEIGHT;
  p[axis] += d;
  for (const b of boxes) {
    if (!boxOverlap(p.x, p.y, p.z, r, h, b)) continue;
    const rise = b.max.y - p.y;
    if (canStep && rise > 0 && rise <= STEP_HEIGHT && !collidesAt(boxes, p.x, b.max.y + 0.001, p.z)) {
      p.y = b.max.y + 0.001; // zinaga chiqish
      continue;
    }
    if (d > 0) p[axis] = b.min[axis] - r - 1e-4;
    else p[axis] = b.max[axis] + r + 1e-4;
    body.vel[axis] = 0;
  }
}

/** AABB to'qnashuvli harakat (o'qlar bo'yicha alohida, kichik qadamlar bilan). */
export function moveBody(body: Body, dt: number, boxes: Box[]): void {
  const p = body.pos;
  const v = body.vel;
  const maxComp = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  const steps = Math.max(1, Math.ceil((maxComp * dt) / 0.2));
  const sdt = dt / steps;
  body.onGround = false;
  for (let s = 0; s < steps; s++) {
    // Y
    p.y += v.y * sdt;
    for (const b of boxes) {
      if (!boxOverlap(p.x, p.y, p.z, PLAYER_RADIUS, PLAYER_HEIGHT, b)) continue;
      if (v.y <= 0) {
        p.y = b.max.y;
        body.onGround = true;
      } else {
        p.y = b.min.y - PLAYER_HEIGHT - 1e-4;
      }
      v.y = 0;
    }
    moveAxis(body, 'x', v.x * sdt, boxes, body.onGround);
    moveAxis(body, 'z', v.z * sdt, boxes, body.onGround);
  }
}

/** Kiritilgan yo'nalish (dunyo koordinatalarida, m/s) bo'yicha tezlanish + gravitatsiya + to'qnashuv. */
export function applyMovement(body: Body, wishX: number, wishZ: number, jump: boolean, dt: number, boxes: Box[]): void {
  const v = body.vel;
  const hasInput = wishX !== 0 || wishZ !== 0;
  if (body.onGround || hasInput) {
    const accel = body.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const dx = wishX - v.x;
    const dz = wishZ - v.z;
    const dl = Math.hypot(dx, dz);
    const maxDelta = accel * dt;
    if (dl > maxDelta) {
      v.x += (dx / dl) * maxDelta;
      v.z += (dz / dl) * maxDelta;
    } else {
      v.x = wishX;
      v.z = wishZ;
    }
  }
  if (jump && body.onGround) {
    v.y = JUMP_SPEED;
    body.onGround = false;
  }
  v.y = Math.max(v.y - GRAVITY * dt, -45);
  moveBody(body, dt, boxes);
}

// ---------- Terrain + Structure World Movement (Stage 02B) ----------

/** Tolerance for deciding that the capsule was touching (not inside) a face before an axis move. */
const AXIS_CONTACT_EPS = 2e-3;
/** Overlap depth (m) along the other axes that counts as "genuinely inside" a box. */
const DEEP_OVERLAP_MIN = 0.02;

function overlapsOtherAxesDeeply(p: Vec3, axis: 'x' | 'z', r: number, h: number, b: Box): boolean {
  const other = axis === 'x' ? 'z' : 'x';
  const penOther = Math.min(p[other] + r - b.min[other], b.max[other] - (p[other] - r));
  const penY = Math.min(p.y + h - b.min.y, b.max.y - p.y);
  return penOther > DEEP_OVERLAP_MIN && penY > DEEP_OVERLAP_MIN;
}

/**
 * 08-FIX: before each substep, pushes the capsule out of colliders it already overlaps
 * horizontally, along the minimum-translation axis (e.g. mm-level overlap after the 1 mm snapshot
 * quantization used for reconciliation, a respawn/teleport placed slightly inside a tree, ...).
 * The legacy per-axis rule instead snapped such bodies to the box face in the *movement direction*,
 * which could teleport them through or along a wall by metres. Boxes the body stands on / touches
 * with its head are left to the vertical pass. A push is rejected if it would create a new overlap.
 */
function depenetrateHorizontal(p: Vec3, r: number, h: number, boxes: readonly Box[]): void {
  for (const b of boxes) {
    if (!boxOverlap(p.x, p.y, p.z, r, h, b)) continue;
    if (b.max.y - p.y <= 0.12) continue; // standing on / stepping onto it: vertical pass resolves
    if (p.y + h - b.min.y <= 0.12) continue; // head brushing the underside: vertical pass resolves
    const penXMin = p.x + r - b.min.x;
    const penXMax = b.max.x - (p.x - r);
    const penZMin = p.z + r - b.min.z;
    const penZMax = b.max.z - (p.z - r);
    const m = Math.min(penXMin, penXMax, penZMin, penZMax);
    const ox = p.x;
    const oz = p.z;
    if (m === penXMin) p.x = b.min.x - r - 1e-4;
    else if (m === penXMax) p.x = b.max.x + r + 1e-4;
    else if (m === penZMin) p.z = b.min.z - r - 1e-4;
    else p.z = b.max.z + r + 1e-4;
    for (const o of boxes) {
      if (o !== b && boxOverlap(p.x, p.y, p.z, r, h, o) && !boxOverlap(ox, p.y, oz, r, h, o)) {
        p.x = ox;
        p.z = oz;
        break;
      }
    }
  }
}

function isStandingOnCollider(p: Vec3, r: number, boxes: readonly Box[]): Box | null {
  let best: Box | null = null;
  for (const b of boxes) {
    if (p.x + r <= b.min.x || p.x - r >= b.max.x || p.z + r <= b.min.z || p.z - r >= b.max.z) {
      continue;
    }
    if (Math.abs(p.y - b.max.y) <= 0.06) {
      if (!best || b.max.y > best.max.y) best = b;
    }
  }
  return best;
}

function moveAxisInWorld(
  body: Body,
  axis: 'x' | 'z',
  d: number,
  world: WorldDefinition,
  boxes: ColliderBox[],
  canStep: boolean,
  maxWalkableSlopeDeg: number,
): boolean {
  if (d === 0) return false;
  const p = body.pos;
  const r = PLAYER_RADIUS;
  const h = PLAYER_HEIGHT;

  const prevCoord = p[axis];
  const prevY = p.y;
  const prevGroundY = sampleTerrainHeight(world.terrain, p.x, p.z);

  p[axis] += d;

  // World bounds clamp
  const minBound = (axis === 'x' ? world.bounds.minX : world.bounds.minZ) + r;
  const maxBound = (axis === 'x' ? world.bounds.maxX : world.bounds.maxZ) - r;
  if (p[axis] < minBound) {
    p[axis] = minBound;
    body.vel[axis] = 0;
  } else if (p[axis] > maxBound) {
    p[axis] = maxBound;
    body.vel[axis] = 0;
  }

  let steppedOnStructure = false;
  for (const b of boxes) {
    if (!boxOverlap(p.x, p.y, p.z, r, h, b)) continue;
    const rise = b.max.y - p.y;
    if (
      canStep &&
      rise > 0 &&
      rise <= STEP_HEIGHT &&
      !collidesAt(boxes, p.x, b.max.y + 0.001, p.z, r, h)
    ) {
      p.y = b.max.y + 0.001;
      if (body.vel.y < 0) body.vel.y = 0;
      body.onGround = true;
      steppedOnStructure = true;
      continue;
    }
    // 08-FIX: only clamp against a face the body actually crossed during THIS axis move.
    // If the capsule already overlapped the box along this axis before the move (e.g. mm-level
    // overlap from snapshot quantization, knockback or a spawn), the legacy "snap to the far
    // face by move direction" rule could teleport the body through or along a wall by metres.
    const prevMinA = prevCoord - r;
    const prevMaxA = prevCoord + r;
    const crossedMinFace = prevMaxA <= b.min[axis] + AXIS_CONTACT_EPS;
    const crossedMaxFace = prevMinA >= b.max[axis] - AXIS_CONTACT_EPS;
    if (d > 0 && crossedMinFace) {
      p[axis] = Math.min(p[axis], b.min[axis] - r - 1e-4);
      body.vel[axis] = 0;
    } else if (d < 0 && crossedMaxFace) {
      p[axis] = Math.max(p[axis], b.max[axis] + r + 1e-4);
      body.vel[axis] = 0;
    } else if (!crossedMinFace && !crossedMaxFace) {
      // Pre-existing overlap along this axis: never move deeper toward the box centre
      // (cannot tunnel), but allow sliding/escaping motion.
      const centre = (b.min[axis] + b.max[axis]) / 2;
      if (Math.abs(p[axis] - centre) < Math.abs(prevCoord - centre) && overlapsOtherAxesDeeply(p, axis, r, h, b)) {
        p[axis] = prevCoord;
        body.vel[axis] = 0;
      }
    }
  }

  // Terrain slope blocking when moving uphill on heightfield terrain
  if (world.terrain.kind === 'heightfield' && !steppedOnStructure) {
    const newGroundY = sampleTerrainHeight(world.terrain, p.x, p.z);
    const onStructure = isStandingOnCollider(p, r, boxes) !== null && p.y > newGroundY + 0.08;
    if (!onStructure && newGroundY > prevGroundY + 1e-5 && p.y <= newGroundY + 0.25) {
      const slopeAtDest = sampleTerrainSlopeDeg(world.terrain, p.x, p.z);
      const horizDist = Math.abs(p[axis] - prevCoord);
      const stepSlopeDeg =
        horizDist > 1e-5 ? (Math.atan2(newGroundY - prevGroundY, horizDist) * 180) / Math.PI : 0;
      if (slopeAtDest > maxWalkableSlopeDeg || stepSlopeDeg > maxWalkableSlopeDeg + 1) {
        p[axis] = prevCoord;
        p.y = prevY;
        body.vel[axis] = 0;
      }
    }
  }

  return steppedOnStructure;
}

/**
 * Moves a player body through a `WorldDefinition`, resolving heightfield terrain,
 * walkable/unwalkable slopes, elevated platforms/floors, stairs, walls, and world bounds.
 */
export function moveBodyInWorld(
  body: Body,
  dt: number,
  world: WorldDefinition,
  opts: WorldMovementOptions = {},
): void {
  if (dt <= 0) return;

  // Preserve 100% identical behavior on flat legacy arenas (e.g. dust_arena)
  if (world.terrain.kind === 'flat') {
    moveBody(body, dt, world.colliders);
    const r = PLAYER_RADIUS;
    if (body.pos.x < world.bounds.minX + r) {
      body.pos.x = world.bounds.minX + r;
      body.vel.x = 0;
    } else if (body.pos.x > world.bounds.maxX - r) {
      body.pos.x = world.bounds.maxX - r;
      body.vel.x = 0;
    }
    if (body.pos.z < world.bounds.minZ + r) {
      body.pos.z = world.bounds.minZ + r;
      body.vel.z = 0;
    } else if (body.pos.z > world.bounds.maxZ - r) {
      body.pos.z = world.bounds.maxZ - r;
      body.vel.z = 0;
    }
    return;
  }

  const maxWalkableSlopeDeg = opts.maxWalkableSlopeDeg ?? DEFAULT_MAX_WALKABLE_SLOPE_DEG;
  const p = body.pos;
  const v = body.vel;
  const r = PLAYER_RADIUS;
  const h = PLAYER_HEIGHT;

  // Substep so large dt (e.g. lag spikes) cannot tunnel through walls or terrain
  const maxComp = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  const steps = Math.max(1, Math.min(64, Math.ceil((maxComp * dt) / 0.15), Math.ceil(dt / (1 / 60))));
  const sdt = dt / steps;

  const spatial = getWorldSpatialIndex(world);

  for (let s = 0; s < steps; s++) {
    const wasOnGround = body.onGround;
    const oldY = p.y;
    const oldGroundY = sampleTerrainHeight(world.terrain, p.x, p.z);
    const wasOnTerrain = wasOnGround && Math.abs(oldY - oldGroundY) <= 0.08;

    const searchRadius = r + Math.hypot(v.x, v.z) * sdt + 0.5;
    const boxes = spatial.queryAABB(
      p.x - searchRadius,
      p.z - searchRadius,
      p.x + searchRadius,
      p.z + searchRadius,
      Math.min(oldY, oldGroundY) - 1,
      oldY + h + Math.abs(v.y * sdt) + 1,
    );

    // 08-FIX: resolve horizontal overlap left by quantized snapshots / respawns before moving
    depenetrateHorizontal(p, r, h, boxes);

    body.onGround = false;
    let onStructure = false;

    // 1) Vertical axis against structure/prop colliders
    p.y += v.y * sdt;
    for (const b of boxes) {
      if (!boxOverlap(p.x, p.y, p.z, r, h, b)) continue;
      if (v.y <= 0 && oldY >= b.max.y - 0.12) {
        p.y = b.max.y;
        v.y = 0;
        body.onGround = true;
        onStructure = true;
      } else if (v.y > 0 && oldY + h <= b.min.y + 0.12) {
        p.y = b.min.y - h - 1e-4;
        v.y = 0;
      }
    }

    // Check if vertically landed on terrain before horizontal step
    const midGroundY = sampleTerrainHeight(world.terrain, p.x, p.z);
    if (!onStructure && p.y <= midGroundY) {
      p.y = midGroundY;
      if (v.y <= 0) {
        v.y = 0;
        if (isTerrainWalkable(world.terrain, p.x, p.z, maxWalkableSlopeDeg)) {
          body.onGround = true;
        }
      }
    }

    const canStep = body.onGround || wasOnGround;

    // 2) Horizontal axes (X then Z)
    const preHX = p.x;
    const preHZ = p.z;
    const steppedX = moveAxisInWorld(body, 'x', v.x * sdt, world, boxes, canStep, maxWalkableSlopeDeg);
    const steppedZ = moveAxisInWorld(body, 'z', v.z * sdt, world, boxes, canStep, maxWalkableSlopeDeg);
    if (steppedX || steppedZ) {
      onStructure = true;
    }

    // Re-check if standing on a structure top after XZ move
    const supportBox = isStandingOnCollider(p, r, boxes);
    const newGroundY = sampleTerrainHeight(world.terrain, p.x, p.z);
    if (supportBox && supportBox.max.y >= newGroundY - 1e-3 && v.y <= 0) {
      p.y = supportBox.max.y;
      v.y = 0;
      body.onGround = true;
      onStructure = true;
    }

    // 3) Resolve heightfield ground surface contact & downhill terrain following
    if (!onStructure) {
      const horizStep = Math.hypot(v.x, v.z) * sdt;
      const maxStickDrop = Math.max(0.16, horizStep * 1.35 + 0.06);

      if (p.y < newGroundY) {
        // Feet penetrated terrain (e.g. walking uphill or landing)
        if (!collidesAt(boxes, p.x, newGroundY + 0.001, p.z, r, h)) {
          p.y = newGroundY;
          if (v.y <= 0) {
            v.y = 0;
            if (isTerrainWalkable(world.terrain, p.x, p.z, maxWalkableSlopeDeg)) {
              body.onGround = true;
            } else {
              // Steep slope: slide downhill along terrain normal
              const n = sampleTerrainNormal(world.terrain, p.x, p.z);
              v.x += n.x * GRAVITY * sdt * 0.6;
              v.z += n.z * GRAVITY * sdt * 0.6;
              body.onGround = false;
            }
          }
        } else {
          // 08-FIX: the terrain surface here is covered by a collider (e.g. a low beam/overhang),
          // so the feet cannot be lifted onto it. Previously the feet stayed under the terrain;
          // instead reject this substep's horizontal move.
          p.x = preHX;
          p.z = preHZ;
          v.x = 0;
          v.z = 0;
          const backGroundY = sampleTerrainHeight(world.terrain, p.x, p.z);
          if (p.y < backGroundY) p.y = backGroundY;
        }
      } else if (
        wasOnTerrain &&
        v.y <= 0 &&
        p.y - newGroundY <= maxStickDrop &&
        isTerrainWalkable(world.terrain, p.x, p.z, maxWalkableSlopeDeg) &&
        !collidesAt(boxes, p.x, newGroundY + 0.001, p.z, r, h)
      ) {
        // Walking across or downhill on walkable terrain: keep feet grounded smoothly
        p.y = newGroundY;
        v.y = 0;
        body.onGround = true;
      } else if (Math.abs(p.y - newGroundY) <= 1e-3 && v.y <= 0) {
        p.y = newGroundY;
        v.y = 0;
        if (isTerrainWalkable(world.terrain, p.x, p.z, maxWalkableSlopeDeg)) {
          body.onGround = true;
        }
      }
    } else if (p.y < newGroundY - 1e-3 && !collidesAt(boxes, p.x, newGroundY + 0.001, p.z, r, h)) {
      // 08-FIX invariant: a structure/prop top that is partly buried by the terrain must never
      // leave the feet under the visible ground surface.
      p.y = newGroundY;
      if (v.y < 0) v.y = 0;
    }
  }
}

/**
 * Applies player acceleration, jump, gravity, and world collision (terrain + colliders + bounds).
 */
export function applyWorldMovement(
  body: Body,
  wishX: number,
  wishZ: number,
  jump: boolean,
  dt: number,
  world: WorldDefinition,
  opts: WorldMovementOptions = {},
): void {
  if (world.terrain.kind === 'flat') {
    applyMovement(body, wishX, wishZ, jump, dt, world.colliders);
    const r = PLAYER_RADIUS;
    if (body.pos.x < world.bounds.minX + r) {
      body.pos.x = world.bounds.minX + r;
      body.vel.x = 0;
    } else if (body.pos.x > world.bounds.maxX - r) {
      body.pos.x = world.bounds.maxX - r;
      body.vel.x = 0;
    }
    if (body.pos.z < world.bounds.minZ + r) {
      body.pos.z = world.bounds.minZ + r;
      body.vel.z = 0;
    } else if (body.pos.z > world.bounds.maxZ - r) {
      body.pos.z = world.bounds.maxZ - r;
      body.vel.z = 0;
    }
    return;
  }

  const v = body.vel;
  const hasInput = wishX !== 0 || wishZ !== 0;
  if (body.onGround || hasInput) {
    const accel = body.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const dx = wishX - v.x;
    const dz = wishZ - v.z;
    const dl = Math.hypot(dx, dz);
    const maxDelta = accel * dt;
    if (dl > maxDelta) {
      v.x += (dx / dl) * maxDelta;
      v.z += (dz / dl) * maxDelta;
    } else {
      v.x = wishX;
      v.z = wishZ;
    }
  }
  if (jump && body.onGround) {
    v.y = JUMP_SPEED;
    body.onGround = false;
  }
  v.y = Math.max(v.y - GRAVITY * dt, -45);
  moveBodyInWorld(body, dt, world, opts);
}

// ---------- Raycast ----------

export interface RayHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
}

export interface WorldRayHit extends RayHit {
  kind: 'collider' | 'terrain';
  colliderId?: string;
  point: Vec3;
}

export function rayBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3, maxT: number): RayHit | null {
  let tmin = 0;
  let tmax = maxT;
  let axis = -1;
  let sign = 0;
  const os = [o.x, o.y, o.z];
  const ds = [d.x, d.y, d.z];
  const mins = [min.x, min.y, min.z];
  const maxs = [max.x, max.y, max.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(ds[a]) < 1e-9) {
      if (os[a] < mins[a] || os[a] > maxs[a]) return null;
      continue;
    }
    const inv = 1 / ds[a];
    let t1 = (mins[a] - os[a]) * inv;
    let t2 = (maxs[a] - os[a]) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1; t1 = t2; t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = a;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return {
    t: tmin,
    nx: axis === 0 ? sign : 0,
    ny: axis === 1 ? sign : 0,
    nz: axis === 2 ? sign : 0,
  };
}

export function raycastBoxes(boxes: Box[], o: Vec3, d: Vec3, maxT: number): RayHit | null {
  let best: RayHit | null = null;
  let limit = maxT;
  for (const b of boxes) {
    const h = rayBox(o, d, b.min, b.max, limit);
    if (h) {
      best = h;
      limit = h.t;
    }
  }
  return best;
}

/**
 * Unified world raycast against both spatial-indexed AABB colliders and heightfield terrain.
 * Ensures hills (`tepaliklar`) and walls/structures accurately block bullets and line-of-sight.
 */
export function raycastWorld(
  world: WorldDefinition,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): WorldRayHit | null {
  let bestHit: RayHit | null = null;
  let bestKind: 'collider' | 'terrain' = 'collider';
  let bestColliderId: string | undefined;
  let limit = maxDist;

  const candidates = getWorldSpatialIndex(world).queryRay(origin, dir, maxDist);
  for (const b of candidates) {
    const h = rayBox(origin, dir, b.min, b.max, limit);
    if (h) {
      bestHit = h;
      bestKind = 'collider';
      bestColliderId = b.id;
      limit = h.t;
    }
  }

  if (world.terrain.kind === 'heightfield') {
    const th = raycastTerrain(world.terrain, origin, dir, limit);
    if (th && th.t <= limit) {
      bestHit = th;
      bestKind = 'terrain';
      bestColliderId = undefined;
      limit = th.t;
    }
  }

  if (!bestHit) return null;
  return {
    ...bestHit,
    kind: bestKind,
    colliderId: bestColliderId,
    point: {
      x: origin.x + dir.x * bestHit.t,
      y: origin.y + dir.y * bestHit.t,
      z: origin.z + dir.z * bestHit.t,
    },
  };
}

// ---------- Camera clearance (08-FIX: camera clipping vs body clipping) ----------

export interface CameraClearanceOptions {
  /** Approximate near-plane "sphere" radius kept clear of colliders (m). */
  radius?: number;
  /** Minimum height of the camera above the sampled terrain surface (m). */
  terrainClearance?: number;
  /** Closest allowed distance to the pivot (m). */
  minDist?: number;
  /** Pull-in step (m) when searching for a clear camera spot. */
  step?: number;
}

/**
 * True when a camera at `p` (with a small near-plane sphere) is above the terrain surface and not
 * inside/too close to any collider. Pure + deterministic; used by the client 3P/death cameras.
 */
export function isCameraPointClear(
  world: WorldDefinition,
  p: Vec3,
  radius = 0.12,
  terrainClearance = 0.16,
): boolean {
  const groundY = sampleTerrainHeight(world.terrain, p.x, p.z);
  if (p.y < groundY + terrainClearance) return false;
  const candidates = getWorldSpatialIndex(world).queryAABB(
    p.x - radius,
    p.z - radius,
    p.x + radius,
    p.z + radius,
    p.y - radius,
    p.y + radius,
  );
  for (const b of candidates) {
    if (
      p.x + radius > b.min.x &&
      p.x - radius < b.max.x &&
      p.y + radius > b.min.y &&
      p.y - radius < b.max.y &&
      p.z + radius > b.min.z &&
      p.z - radius < b.max.z
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Returns the largest distance `<= desiredDist` along unit vector `dir` from `pivot` where the camera
 * neither crosses a collider/terrain (ray test padded by `radius`) nor sits inside terrain/colliders.
 * Never returns more than `desiredDist`; returns 0 (camera on the pivot) if no clear spot exists.
 */
export function computeCameraClearDistance(
  world: WorldDefinition,
  pivot: Vec3,
  dir: Vec3,
  desiredDist: number,
  opts: CameraClearanceOptions = {},
): number {
  const radius = opts.radius ?? 0.12;
  const terrainClearance = opts.terrainClearance ?? 0.16;
  const minDist = opts.minDist ?? 0.1;
  const step = opts.step ?? 0.05;
  if (!(desiredDist > minDist)) return Math.max(0, Math.min(desiredDist, minDist));
  let dist = desiredDist;
  const hit = raycastWorld(world, pivot, dir, desiredDist + radius);
  if (hit) dist = Math.min(dist, hit.t - radius);
  while (dist > minDist) {
    const p = { x: pivot.x + dir.x * dist, y: pivot.y + dir.y * dist, z: pivot.z + dir.z * dist };
    if (isCameraPointClear(world, p, radius, terrainClearance)) return Math.min(desiredDist, dist);
    dist -= step;
  }
  // No clear spot along the arm: collapse onto the pivot (head/shoulder), which callers keep clear.
  return 0;
}

export function rayVsPlayer(o: Vec3, d: Vec3, feet: Vec3, maxT: number): { t: number; head: boolean } | null {
  const hr = HEAD_HITBOX.radius;
  const br = BODY_HITBOX.radius;
  const head = rayBox(
    o, d,
    { x: feet.x - hr, y: feet.y + HEAD_HITBOX.bottom, z: feet.z - hr },
    { x: feet.x + hr, y: feet.y + HEAD_HITBOX.top, z: feet.z + hr },
    maxT,
  );
  const body = rayBox(
    o, d,
    { x: feet.x - br, y: feet.y + BODY_HITBOX.bottom, z: feet.z - br },
    { x: feet.x + br, y: feet.y + BODY_HITBOX.top, z: feet.z + br },
    maxT,
  );
  if (head && (!body || head.t <= body.t)) return { t: head.t, head: true };
  if (body) return { t: body.t, head: false };
  return null;
}

// ---------- Granata fizikasi ----------

const GR = 0.08;

function pointHits(boxes: Box[], p: Vec3): boolean {
  for (const b of boxes) {
    if (
      p.x + GR > b.min.x && p.x - GR < b.max.x &&
      p.y + GR > b.min.y && p.y - GR < b.max.y &&
      p.z + GR > b.min.z && p.z - GR < b.max.z
    ) return true;
  }
  return false;
}

export function pointInsideBoxes(boxes: Box[], p: Vec3): boolean {
  return pointHits(boxes, p);
}

/** Granatani bir qadam harakatlantiradi. Qattiq urilish bo'lsa true qaytaradi. */
export function stepProjectile(g: { pos: Vec3; vel: Vec3 }, dt: number, boxes: Box[]): boolean {
  g.vel.y -= GRAVITY * dt;
  const speed = Math.hypot(g.vel.x, g.vel.y, g.vel.z);
  const steps = Math.max(1, Math.ceil((speed * dt) / 0.1));
  const sdt = dt / steps;
  let bounced = false;
  for (let s = 0; s < steps; s++) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const old = g.pos[axis];
      g.pos[axis] += g.vel[axis] * sdt;
      if (pointHits(boxes, g.pos)) {
        g.pos[axis] = old;
        if (Math.abs(g.vel[axis]) > 2) bounced = true;
        if (axis === 'y') {
          g.vel.y *= -0.35;
          g.vel.x *= 0.7;
          g.vel.z *= 0.7;
          if (Math.abs(g.vel.y) < 1) g.vel.y = 0;
        } else {
          g.vel[axis] *= -0.45;
        }
      }
    }
  }
  return bounced;
}

/**
 * World-aware grenade physics step supporting both AABB colliders and heightfield terrain.
 */
export function stepProjectileInWorld(
  g: { pos: Vec3; vel: Vec3 },
  dt: number,
  world: WorldDefinition,
): boolean {
  if (world.terrain.kind === 'flat') {
    return stepProjectile(g, dt, world.colliders);
  }
  g.vel.y -= GRAVITY * dt;
  const speed = Math.hypot(g.vel.x, g.vel.y, g.vel.z);
  const steps = Math.max(1, Math.ceil((speed * dt) / 0.1));
  const sdt = dt / steps;
  let bounced = false;
  for (let s = 0; s < steps; s++) {
    const candidates = queryNearbyColliders(world, g.pos.x, g.pos.z, 1.0);
    for (const axis of ['x', 'y', 'z'] as const) {
      const old = g.pos[axis];
      g.pos[axis] += g.vel[axis] * sdt;
      const groundY = sampleTerrainHeight(world.terrain, g.pos.x, g.pos.z);
      const hitTerrain = g.pos.y - GR < groundY;
      if (hitTerrain || pointHits(candidates, g.pos)) {
        g.pos[axis] = old;
        if (Math.abs(g.vel[axis]) > 2) bounced = true;
        if (axis === 'y') {
          g.vel.y *= -0.35;
          g.vel.x *= 0.7;
          g.vel.z *= 0.7;
          if (Math.abs(g.vel.y) < 1) g.vel.y = 0;
        } else {
          g.vel[axis] *= -0.45;
        }
      }
    }
  }
  return bounced;
}
