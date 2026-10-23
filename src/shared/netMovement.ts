import { RUN_SPEED, WALK_SPEED } from './constants';
import { clamp } from './math';
import { applyWorldMovement, type Body, type WorldMovementOptions } from './physics';
import type { PlayerInputCmd } from './protocol';
import { isWeaponId, UNARMED_SPEED_MUL, WEAPONS, type WeaponId } from './weapons';
import type { WorldDefinition } from './world';

export const FIXED_MOVE_DT = 1 / 60;
export const MIN_INPUT_DT = 1 / 240;
export const MAX_INPUT_DT = 0.05;
export const MAX_PITCH_RAD = 1.55;
export const MAX_INPUT_QUEUE_SIZE = 64;
export const MAX_INPUT_BATCH_SIZE = 16;
export const MAX_SIM_TIME_PER_TICK = 0.12;
export const RECONCILE_SMOOTH_THRESHOLD = 0.015;
export const RECONCILE_SNAP_THRESHOLD = 3.5;

export interface MovementState extends Body {
  yaw: number;
  pitch: number;
  weapon: WeaponId | null;
  scoped: boolean;
}

export function cloneMovementState(state: MovementState): MovementState {
  return {
    pos: { x: state.pos.x, y: state.pos.y, z: state.pos.z },
    vel: { x: state.vel.x, y: state.vel.y, z: state.vel.z },
    onGround: state.onGround,
    yaw: state.yaw,
    pitch: state.pitch,
    weapon: state.weapon,
    scoped: state.scoped,
  };
}

export function quantizeInputDt(dt: number): number {
  if (!Number.isFinite(dt)) {
    return FIXED_MOVE_DT;
  }
  const clamped = clamp(dt, MIN_INPUT_DT, MAX_INPUT_DT);
  return Math.round(clamped * 100000) / 100000;
}

export function normalizeYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) {
    return 0;
  }
  const TWO_PI = Math.PI * 2;
  let wrapped = yaw;
  if (wrapped < -Math.PI || wrapped > Math.PI) {
    wrapped = ((((wrapped + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
  }
  const q = Math.round(wrapped * 100000) / 100000;
  return Object.is(q, -0) ? 0 : q;
}

export function sanitizePlayerInputCmd(
  raw: unknown,
  fallbackWeapon: WeaponId | null = 'rifle',
): PlayerInputCmd | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;

  if (
    typeof r.seq !== 'number' ||
    !Number.isInteger(r.seq) ||
    r.seq < 1 ||
    r.seq > 0x7fffffff
  ) {
    return null;
  }

  if (
    typeof r.spawnId !== 'number' ||
    !Number.isInteger(r.spawnId) ||
    r.spawnId < 1 ||
    r.spawnId > 0x7fffffff
  ) {
    return null;
  }

  if (
    typeof r.dt !== 'number' ||
    !Number.isFinite(r.dt) ||
    typeof r.moveForward !== 'number' ||
    !Number.isFinite(r.moveForward) ||
    typeof r.moveRight !== 'number' ||
    !Number.isFinite(r.moveRight) ||
    typeof r.yaw !== 'number' ||
    !Number.isFinite(r.yaw) ||
    typeof r.pitch !== 'number' ||
    !Number.isFinite(r.pitch)
  ) {
    return null;
  }

  const rawFwd = Math.round(clamp(r.moveForward, -1, 1) * 1000) / 1000;
  const moveForward = Object.is(rawFwd, -0) ? 0 : rawFwd;

  const rawRight = Math.round(clamp(r.moveRight, -1, 1) * 1000) / 1000;
  const moveRight = Object.is(rawRight, -0) ? 0 : rawRight;

  const rawPitch = Math.round(clamp(r.pitch, -MAX_PITCH_RAD, MAX_PITCH_RAD) * 100000) / 100000;
  const pitch = Object.is(rawPitch, -0) ? 0 : rawPitch;

  const yaw = normalizeYaw(r.yaw);
  const dt = quantizeInputDt(r.dt);
  const weapon: WeaponId | null =
    r.weapon === null ? null : isWeaponId(r.weapon) ? r.weapon : fallbackWeapon;
  const jump = Boolean(r.jump);
  const walk = Boolean(r.walk);
  const scoped = weapon === 'sniper' ? Boolean(r.scoped) : false;

  const cmd: PlayerInputCmd = {
    seq: r.seq,
    spawnId: r.spawnId,
    dt,
    moveForward,
    moveRight,
    jump,
    walk,
    scoped,
    weapon,
    yaw,
    pitch,
  };

  if (typeof r.clientTimeMs === 'number' && Number.isFinite(r.clientTimeMs)) {
    cmd.clientTimeMs = Number(r.clientTimeMs);
  }

  return cmd;
}

export function extractSanitizedInputBatch(
  raw: unknown,
  fallbackWeapon: WeaponId | null = 'rifle',
): { spawnId: number; inputs: PlayerInputCmd[]; ping?: number } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;

  if ('inputs' in r && r.inputs !== undefined) {
    if (
      !Array.isArray(r.inputs) ||
      r.inputs.length === 0 ||
      r.inputs.length > MAX_INPUT_BATCH_SIZE
    ) {
      return null;
    }

    const hasBatchSpawnId = typeof r.spawnId === 'number' && Number.isInteger(r.spawnId);
    const batchSpawnId = hasBatchSpawnId ? (r.spawnId as number) : undefined;
    if (batchSpawnId !== undefined && (batchSpawnId < 1 || batchSpawnId > 0x7fffffff)) {
      return null;
    }

    const valid: PlayerInputCmd[] = [];
    for (const item of r.inputs) {
      const cmd = sanitizePlayerInputCmd(item, fallbackWeapon);
      if (!cmd) continue;
      if (batchSpawnId !== undefined && cmd.spawnId !== batchSpawnId) continue;
      valid.push(cmd);
    }

    if (valid.length === 0) {
      return null;
    }

    const resolvedSpawnId = batchSpawnId ?? valid[0].spawnId;
    const filtered =
      batchSpawnId !== undefined
        ? valid
        : valid.filter((cmd) => cmd.spawnId === resolvedSpawnId);

    if (filtered.length === 0) {
      return null;
    }

    const ping =
      typeof r.ping === 'number' && Number.isFinite(r.ping)
        ? clamp(r.ping, 0, 9999)
        : undefined;

    return ping !== undefined
      ? { spawnId: resolvedSpawnId, inputs: filtered, ping }
      : { spawnId: resolvedSpawnId, inputs: filtered };
  }

  const single = sanitizePlayerInputCmd(raw, fallbackWeapon);
  if (!single) {
    return null;
  }
  return {
    spawnId: single.spawnId,
    inputs: [single],
  };
}

export function computeWishVelocity(
  cmd: Pick<PlayerInputCmd, 'moveForward' | 'moveRight' | 'walk' | 'scoped' | 'weapon' | 'yaw'>,
): { wx: number; wz: number; maxSpeed: number } {
  const speedMul = cmd.weapon ? (WEAPONS[cmd.weapon]?.speedMul ?? 1) : UNARMED_SPEED_MUL;
  const maxSpeed =
    (cmd.walk ? WALK_SPEED : RUN_SPEED) *
    speedMul *
    (cmd.scoped && cmd.weapon === 'sniper' ? 0.55 : 1);

  const fwd = clamp(cmd.moveForward, -1, 1);
  const right = clamp(cmd.moveRight, -1, 1);
  const inputMag = Math.min(1, Math.hypot(fwd, right));
  if (inputMag <= 0) {
    return { wx: 0, wz: 0, maxSpeed };
  }

  const s = Math.sin(cmd.yaw);
  const c = Math.cos(cmd.yaw);
  let wx = -s * fwd + c * right;
  let wz = -c * fwd - s * right;
  const wl = Math.hypot(wx, wz);
  if (wl > 0) {
    const targetSpeed = maxSpeed * inputMag;
    wx = (wx / wl) * targetSpeed;
    wz = (wz / wl) * targetSpeed;
  } else {
    wx = 0;
    wz = 0;
  }

  return { wx, wz, maxSpeed };
}

export function stepPlayerMovement(
  state: Body & { yaw?: number; pitch?: number; weapon?: WeaponId | null; scoped?: boolean },
  cmd: PlayerInputCmd,
  world: WorldDefinition,
  opts: WorldMovementOptions = {},
): void {
  state.yaw = cmd.yaw;
  state.pitch = clamp(cmd.pitch, -MAX_PITCH_RAD, MAX_PITCH_RAD);
  state.weapon = cmd.weapon;
  state.scoped = cmd.weapon === 'sniper' ? Boolean(cmd.scoped) : false;

  const { wx, wz } = computeWishVelocity(cmd);
  const totalDt = quantizeInputDt(cmd.dt);
  const substeps = Math.max(1, Math.ceil(totalDt / FIXED_MOVE_DT));
  const sdt = totalDt / substeps;

  for (let i = 0; i < substeps; i++) {
    applyWorldMovement(state, wx, wz, cmd.jump, sdt, world, opts);
  }
}

export function stepNeutralMovement(
  body: Body,
  dt: number,
  world: WorldDefinition,
  opts: WorldMovementOptions = {},
): void {
  const totalDt = quantizeInputDt(dt);
  const substeps = Math.max(1, Math.ceil(totalDt / FIXED_MOVE_DT));
  const sdt = totalDt / substeps;

  for (let i = 0; i < substeps; i++) {
    applyWorldMovement(body, 0, 0, false, sdt, world, opts);
  }
}
