import {
  BACKPEDAL_SPEED_MUL,
  CROUCH_SPEED,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  RUN_SPEED,
  SPRINT_MIN_FORWARD,
  STAMINA_REGEN_SECONDS,
  STAMINA_RELOCK_THRESHOLD,
  STAMINA_SPRINT_SECONDS,
  STRAFE_SPEED_MUL,
  WALK_SPEED,
} from './constants';
import { clamp } from './math';
import { applyWorldMovement, collidesAtWorld, type Body, type WorldMovementOptions } from './physics';
import type { PlayerInputCmd } from './protocol';
import { isWeaponId, UNARMED_SPEED_MUL, WEAPONS, type WeaponId } from './weapons';
import { woodBlocksSprint, woodSpeedMul } from './wolf/camp';
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
  /** Sprint chidamliligi 0..1 (server va klient bashorati bir xil simulyatsiya qiladi); yo'q bo'lsa 1. */
  stamina?: number;
  /** Stamina tugagan: STAMINA_RELOCK_THRESHOLD gacha tiklanmaguncha sprint yo'q. */
  staminaLocked?: boolean;
  /**
   * wolf_night: qo'ldagi o'tin soni (0..WOOD_CARRY_MAX) — og'irlik: tezlik ko'paytuvchisi `woodSpeedMul`,
   * to'la qo'lda sprint yo'q. Server `p.wood` ni, klient snapshotdan bilgan o'tinini beradi; yo'q bo'lsa 0.
   */
  wood?: number;
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
    stamina: state.stamina ?? 1,
    staminaLocked: Boolean(state.staminaLocked),
    crouched: Boolean(state.crouched),
    // O'tin maydoni faqat berilgan bo'lsa nusxalanadi (o'tinsiz rejimlardagi holat tuzilishi o'zgarmaydi)
    ...(state.wood !== undefined ? { wood: state.wood } : {}),
  };
}

/**
 * Turish tekshiruvi oyoqdan shu masofa yuqoridan boshlanadi: oyoq ostidagi pol/relyef bilan tegish
 * to'qnashuv hisoblanmaydi (`isSpawnPointSafe` dagi kabi), tepa esa aynan `PLAYER_HEIGHT` da qoladi.
 */
const STAND_UP_PROBE_EPS = 0.01;

/**
 * O'tirish/turish holatini kirishga qarab yangilaydi (server va klient bashorati bir xil chaqiradi).
 * - `wantCrouch` — darhol o'tiradi;
 * - qo'yib yuborilgan va hozir o'tirgan bo'lsa — joriy oyoq nuqtasida tik turgan kapsula sig'sagina turadi,
 *   aks holda (past shift, quvur ostida va h.k.) o'tirgan holatda qoladi.
 */
export function resolveStance(state: Body, wantCrouch: boolean, world: WorldDefinition): void {
  if (wantCrouch) {
    state.crouched = true;
    return;
  }
  if (!state.crouched) return;
  const p = state.pos;
  if (
    !collidesAtWorld(
      world,
      p.x,
      p.y + STAND_UP_PROBE_EPS,
      p.z,
      PLAYER_RADIUS,
      PLAYER_HEIGHT - STAND_UP_PROBE_EPS,
    )
  ) {
    state.crouched = false;
  }
}

/** Kirish sprintni talab qiladimi (Shift + asosan oldinga harakat). */
export function wantsSprint(cmd: Pick<PlayerInputCmd, 'moveForward' | 'moveRight' | 'walk'>): boolean {
  if (!cmd.walk) return false;
  const fwd = clamp(cmd.moveForward, -1, 1);
  const right = clamp(cmd.moveRight, -1, 1);
  const mag = Math.hypot(fwd, right);
  if (mag <= 0) return false;
  return fwd / mag > SPRINT_MIN_FORWARD;
}

/**
 * Stamina yangilanishi (server va klientda bir xil): sprint qilinsa kamayadi, aks holda tiklanadi.
 * Qaytaradi: shu qadamda sprint ruxsat etilganmi.
 */
export function stepStamina(
  state: { stamina?: number; staminaLocked?: boolean },
  sprintRequested: boolean,
  dt: number,
): boolean {
  let st = Number.isFinite(state.stamina) ? clamp(state.stamina as number, 0, 1) : 1;
  let locked = Boolean(state.staminaLocked);
  const canSprint = sprintRequested && !locked && st > 0;
  if (canSprint) {
    st -= dt / STAMINA_SPRINT_SECONDS;
    if (st <= 0) {
      st = 0;
      locked = true;
    }
  } else {
    st += dt / STAMINA_REGEN_SECONDS;
    if (st > 1) st = 1;
    if (locked && st >= STAMINA_RELOCK_THRESHOLD) locked = false;
  }
  state.stamina = st;
  state.staminaLocked = locked;
  return canSprint;
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
  // Eski klientlar `crouch` yubormaydi — false (tik turish)
  const crouch = Boolean(r.crouch);
  const scoped = weapon === 'sniper' ? Boolean(r.scoped) : false;

  const cmd: PlayerInputCmd = {
    seq: r.seq,
    spawnId: r.spawnId,
    dt,
    moveForward,
    moveRight,
    jump,
    walk,
    crouch,
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

/**
 * Kirishdan istalgan gorizontal tezlik.
 * `crouched` — o'yinchining (avtoritativ) o'tirgan holati: asosiy tezlik `CROUCH_SPEED`, sprint yo'q
 * (yo'nalish, qurol va snayper pritsel ko'paytuvchilari baribir qo'llanadi).
 * `wood` — qo'ldagi o'tin (wolf_night): `woodSpeedMul` ko'paytuvchisi, to'la qo'lda (WOOD_CARRY_MAX) sprint yo'q.
 */
export function computeWishVelocity(
  cmd: Pick<PlayerInputCmd, 'moveForward' | 'moveRight' | 'walk' | 'scoped' | 'weapon' | 'yaw'>,
  crouched = false,
  wood = 0,
): { wx: number; wz: number; maxSpeed: number } {
  const speedMul = (cmd.weapon ? (WEAPONS[cmd.weapon]?.speedMul ?? 1) : UNARMED_SPEED_MUL) * woodSpeedMul(wood);
  const scopedMul = cmd.scoped && cmd.weapon === 'sniper' ? 0.55 : 1;

  const fwd = clamp(cmd.moveForward, -1, 1);
  const right = clamp(cmd.moveRight, -1, 1);
  const inputMag = Math.min(1, Math.hypot(fwd, right));
  if (inputMag <= 0) {
    return { wx: 0, wz: 0, maxSpeed: (crouched ? CROUCH_SPEED : WALK_SPEED) * speedMul * scopedMul };
  }

  // Yo'nalishga bog'liq tezlik: oldinga 1.0, yon tomonga STRAFE, orqaga BACKPEDAL (diagonal — oraliq).
  const f = fwd / Math.hypot(fwd, right); // -1 (orqaga) .. +1 (oldinga)
  const dirMul = f >= 0 ? STRAFE_SPEED_MUL + (1 - STRAFE_SPEED_MUL) * f : STRAFE_SPEED_MUL + (BACKPEDAL_SPEED_MUL - STRAFE_SPEED_MUL) * -f;
  // Sprint (Shift) faqat asosan oldinga harakatda; orqaga/yon sprint yo'q. O'tirganda va to'la qo'l o'tin bilan
  // sprint umuman yo'q.
  const sprinting = !crouched && !woodBlocksSprint(wood) && cmd.walk && f > SPRINT_MIN_FORWARD;
  const baseSpeed = crouched ? CROUCH_SPEED : sprinting ? RUN_SPEED : WALK_SPEED;
  const maxSpeed = baseSpeed * dirMul * speedMul * scopedMul;

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
  state: Body & {
    yaw?: number;
    pitch?: number;
    weapon?: WeaponId | null;
    scoped?: boolean;
    stamina?: number;
    staminaLocked?: boolean;
    /** wolf_night: qo'ldagi o'tin (og'irlik) — server `p.wood`, klient snapshotdan; yo'q bo'lsa 0. */
    wood?: number;
  },
  cmd: PlayerInputCmd,
  world: WorldDefinition,
  opts: WorldMovementOptions = {},
): void {
  state.yaw = cmd.yaw;
  state.pitch = clamp(cmd.pitch, -MAX_PITCH_RAD, MAX_PITCH_RAD);
  state.weapon = cmd.weapon;
  state.scoped = cmd.weapon === 'sniper' ? Boolean(cmd.scoped) : false;

  // O'tirish/turish — harakatdan oldin (tepada joy bo'lmasa o'tirgan holat saqlanadi)
  resolveStance(state, Boolean(cmd.crouch), world);
  const crouched = Boolean(state.crouched);
  const wood = state.wood ?? 0;

  const totalDt = quantizeInputDt(cmd.dt);
  // Stamina: sprint faqat chidamlilik bo'lsa; tugaganda avtomatik yurishga o'tadi.
  // O'tirganda yoki to'la qo'l o'tin bilan sprint so'ralmagan hisoblanadi — stamina tiklanadi (kamaymaydi).
  const sprintOk = stepStamina(state, !crouched && !woodBlocksSprint(wood) && wantsSprint(cmd), totalDt);
  const { wx, wz } = computeWishVelocity(sprintOk === cmd.walk ? cmd : { ...cmd, walk: sprintOk }, crouched, wood);
  const substeps = Math.max(1, Math.ceil(totalDt / FIXED_MOVE_DT));
  const sdt = totalDt / substeps;

  for (let i = 0; i < substeps; i++) {
    applyWorldMovement(state, wx, wz, cmd.jump, sdt, world, opts);
  }
}

/** Kirishsiz (starvation) qadam: joriy o'tirish/turish holati o'zgarmaydi. */
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
