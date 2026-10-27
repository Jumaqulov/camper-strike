import { dirFromAngles, isVec3, type Vec3, vnorm, vsub } from '../math';
import { rayBox, rayCollider } from '../physics';
import { raycastTerrain } from '../terrain';
import { isWeaponId, type WeaponDef } from '../weapons';
import type { WorldDefinition } from '../world';
import type {
  ContainerOpenReq,
  EquipWeaponReq,
  LootContextValidationResult,
  LootPickupReq,
  UseMedkitReq,
} from './contracts';

const ID_PATTERN = /^[a-zA-Z0-9_.:-]+$/;

export function isValidRequestId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 64 && ID_PATTERN.test(id);
}

export function isValidEntityId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 96 && ID_PATTERN.test(id);
}

export function isValidPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 0x7fffffff;
}

export function validateRequestRoundAndSpawnContext(
  raw: unknown,
  expectedRoundId: number,
  expectedSpawnId: number,
  requireContext = true,
): LootContextValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'INVALID_CONTEXT' };
  }
  const o = raw as Record<string, unknown>;
  const hasRound = o.roundId !== undefined && o.roundId !== null;
  const hasSpawn = o.spawnId !== undefined && o.spawnId !== null;

  if (!hasRound || !hasSpawn) {
    if (requireContext) {
      return { ok: false, reason: 'MISSING_CONTEXT' };
    }
    if (hasRound) {
      if (!isValidPositiveInt(o.roundId)) return { ok: false, reason: 'INVALID_CONTEXT' };
      if (o.roundId !== expectedRoundId) {
        return { ok: false, reason: 'ROUND_MISMATCH', roundId: o.roundId };
      }
    }
    if (hasSpawn) {
      if (!isValidPositiveInt(o.spawnId)) return { ok: false, reason: 'INVALID_CONTEXT' };
      if (o.spawnId !== expectedSpawnId) {
        return { ok: false, reason: 'SPAWN_MISMATCH', spawnId: o.spawnId };
      }
    }
    return { ok: true };
  }

  if (!isValidPositiveInt(o.roundId) || !isValidPositiveInt(o.spawnId)) {
    return { ok: false, reason: 'INVALID_CONTEXT' };
  }
  if (o.roundId !== expectedRoundId) {
    return { ok: false, reason: 'ROUND_MISMATCH', roundId: o.roundId, spawnId: o.spawnId };
  }
  if (o.spawnId !== expectedSpawnId) {
    return { ok: false, reason: 'SPAWN_MISMATCH', roundId: o.roundId, spawnId: o.spawnId };
  }

  return { ok: true, roundId: o.roundId, spawnId: o.spawnId };
}

export function sanitizeContainerOpenReq(raw: unknown): ContainerOpenReq | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isValidRequestId(o.requestId)) return null;
  if (!isValidEntityId(o.containerId)) return null;
  const req: ContainerOpenReq = {
    requestId: o.requestId,
    containerId: o.containerId,
  };
  if (o.roundId !== undefined && isValidPositiveInt(o.roundId)) {
    req.roundId = o.roundId;
  }
  if (o.spawnId !== undefined && isValidPositiveInt(o.spawnId)) {
    req.spawnId = o.spawnId;
  }
  return req;
}

export function sanitizeLootPickupReq(raw: unknown): LootPickupReq | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isValidRequestId(o.requestId)) return null;
  if (!isValidEntityId(o.itemId)) return null;

  let containerId: string | null = null;
  if (o.containerId !== undefined && o.containerId !== null) {
    if (!isValidEntityId(o.containerId)) return null;
    containerId = o.containerId;
  }

  const req: LootPickupReq = {
    requestId: o.requestId,
    containerId,
    itemId: o.itemId,
  };
  if (o.roundId !== undefined && isValidPositiveInt(o.roundId)) {
    req.roundId = o.roundId;
  }
  if (o.spawnId !== undefined && isValidPositiveInt(o.spawnId)) {
    req.spawnId = o.spawnId;
  }
  return req;
}

export function sanitizeEquipWeaponReq(raw: unknown): EquipWeaponReq | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isValidRequestId(o.requestId)) return null;
  if (o.weapon !== null && !isWeaponId(o.weapon)) return null;
  const req: EquipWeaponReq = {
    requestId: o.requestId,
    weapon: o.weapon,
  };
  if (o.roundId !== undefined && isValidPositiveInt(o.roundId)) {
    req.roundId = o.roundId;
  }
  if (o.spawnId !== undefined && isValidPositiveInt(o.spawnId)) {
    req.spawnId = o.spawnId;
  }
  return req;
}

export function sanitizeUseMedkitReq(raw: unknown): UseMedkitReq | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isValidRequestId(o.requestId)) return null;
  const req: UseMedkitReq = {
    requestId: o.requestId,
  };
  if (o.roundId !== undefined && isValidPositiveInt(o.roundId)) {
    req.roundId = o.roundId;
  }
  if (o.spawnId !== undefined && isValidPositiveInt(o.spawnId)) {
    req.spawnId = o.spawnId;
  }
  return req;
}

export function isWithinInteractionDistance(
  playerPos: Vec3,
  targetPos: Vec3,
  allowedRadius: number,
): { ok: boolean; dist3d: number; distH: number } {
  const distH = Math.hypot(playerPos.x - targetPos.x, playerPos.z - targetPos.z);
  const dist3d = Math.hypot(
    playerPos.x - targetPos.x,
    playerPos.y - targetPos.y,
    playerPos.z - targetPos.z,
  );
  const vertDiff = Math.abs(playerPos.y + 0.9 - (targetPos.y + 0.45));
  const ok = distH <= allowedRadius && vertDiff <= 2.4;
  return { ok, dist3d, distH };
}

export function hasLineOfSightToContainer(
  world: WorldDefinition,
  eye: Vec3,
  containerPos: Vec3,
  containerId: string,
): boolean {
  const mid: Vec3 = { x: containerPos.x, y: containerPos.y + 0.42, z: containerPos.z };
  const top: Vec3 = { x: containerPos.x, y: containerPos.y + 0.72, z: containerPos.z };

  const rayClear = (target: Vec3): boolean => {
    const delta = vsub(target, eye);
    const dist = Math.hypot(delta.x, delta.y, delta.z);
    if (dist <= 0.15) return true;

    const dir: Vec3 = { x: delta.x / dist, y: delta.y / dist, z: delta.z / dist };
    const maxT = Math.max(0.05, dist - 0.15);

    if (raycastTerrain(world.terrain, eye, dir, maxT)) {
      return false;
    }

    for (const col of world.colliders) {
      if (col.sourceObjectId === containerId || col.id.startsWith(containerId)) {
        continue;
      }
      // Aniq shakl (daraxt silindri, tosh ellipsoidi, burilgan quti) bilan — quti burchaklari LOS ni to'smasin
      const t = (col.hit ? rayCollider(col, eye, dir, maxT) : rayBox(eye, dir, col.min, col.max, maxT))?.t ?? null;
      if (t === null) continue;

      if (
        col.tag === 'structure' ||
        col.tag === 'rock' ||
        col.tag === 'tree' ||
        col.tag === 'boundary'
      ) {
        return false;
      }
      if (col.tag === 'prop' && t < dist - 0.45) {
        return false;
      }
    }

    return true;
  };

  return rayClear(mid) || rayClear(top);
}

export function validateBulletDirectionsAgainstAim(
  dirs: unknown,
  weaponDef: WeaponDef,
  authYaw: number,
  authPitch: number,
): { ok: boolean; sanitizedDirs: Vec3[]; reason?: string } {
  if (!Array.isArray(dirs) || dirs.length < 1) {
    return { ok: false, sanitizedDirs: [], reason: 'EMPTY_DIRS' };
  }

  const maxPellets = Math.max(1, weaponDef.pellets);
  const sanitizedDirs: Vec3[] = [];
  for (const d of dirs.slice(0, maxPellets)) {
    if (!isVec3(d)) continue;
    const len = Math.hypot(d.x, d.y, d.z);
    if (len <= 1e-4) continue;
    sanitizedDirs.push(vnorm(d));
  }

  if (sanitizedDirs.length === 0) {
    return { ok: false, sanitizedDirs: [], reason: 'EMPTY_DIRS' };
  }

  const authAim = dirFromAngles(authYaw, authPitch);
  const maxAngleRad = Math.min(
    0.45,
    (weaponDef.spread + weaponDef.moveSpread + weaponDef.maxBloom + 0.06) * 1.85 + 0.18,
  );
  const minCos = Math.cos(maxAngleRad);

  for (const u of sanitizedDirs) {
    const dot = u.x * authAim.x + u.y * authAim.y + u.z * authAim.z;
    if (dot < minCos) {
      return { ok: false, sanitizedDirs: [], reason: 'AIM_CONE_VIOLATION' };
    }
  }

  return { ok: true, sanitizedDirs };
}
