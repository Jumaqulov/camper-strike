import { EYE_HEIGHT, GRENADES_PER_LIFE, MAX_HP, RUN_SPEED, type Team } from '../../shared/constants';
import { clamp, dirFromAngles, spreadDir, type Vec3 } from '../../shared/math';
import type { MovementState } from '../../shared/netMovement';
import type { Body } from '../../shared/physics';
import type { PlayerInputCmd, PlayerSnap, SpawnEvent } from '../../shared/protocol';
import { emptyAmmo, fullAmmo, WEAPON_SLOTS, WEAPONS, type AmmoState, type WeaponId } from '../../shared/weapons';
import { DEFAULT_WORLD, type WorldDefinition } from '../../shared/world';
import { ClientPrediction, type ReconcileResult } from './ClientPrediction';

/** Lokal o'yinchi: harakat (klient tomonida bashorat va server bilan solishtirish) va qurol holati. */
export class LocalPlayer {
  private world: WorldDefinition = DEFAULT_WORLD;
  readonly prediction = new ClientPrediction();
  body: Body = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, onGround: true };
  yaw = 0;
  pitch = 0;
  alive = false;
  hp = MAX_HP;
  spawnId = 0;
  roundId = 1;
  team: Team = 'none';
  lootPreview = false;
  inventoryVersion = 0;
  weapon: WeaponId | null = 'rifle';
  ownedWeapons = new Set<WeaponId>(WEAPON_SLOTS);
  ammo: AmmoState = fullAmmo();
  reloadUntil = 0;
  reloadWeapon: WeaponId | null = null;
  lastShot = -10;
  switchUntil = 0;
  grenades = GRENADES_PER_LIFE;
  medkits = 0;
  lastGrenade = -10;
  bloom = 0;
  scoped = false;

  setWorld(world: WorldDefinition): void {
    this.world = world;
  }

  setLootPreview(enabled: boolean): void {
    this.lootPreview = enabled;
    if (enabled) {
      this.weapon = null;
      this.ownedWeapons.clear();
      this.ammo = emptyAmmo();
      this.grenades = 0;
      this.medkits = 0;
      this.scoped = false;
      this.reloadWeapon = null;
    } else {
      this.weapon = 'rifle';
      this.ownedWeapons = new Set<WeaponId>(WEAPON_SLOTS);
      this.ammo = fullAmmo();
      this.grenades = GRENADES_PER_LIFE;
      this.medkits = 0;
    }
  }

  resetPrediction(): void {
    this.prediction.clear();
  }

  spawn(e: SpawnEvent, t: number): void {
    if (e.lootEnabled !== undefined) {
      this.lootPreview = Boolean(e.lootEnabled);
    } else if (e.lootPreview !== undefined) {
      this.lootPreview = Boolean(e.lootPreview);
    }
    if (e.roundId !== undefined && Number.isFinite(e.roundId)) {
      this.roundId = e.roundId;
    }
    this.body.pos = { x: e.x, y: e.y, z: e.z };
    this.body.vel = { x: 0, y: 0, z: e.z * 0 };
    this.body.onGround = true;
    this.yaw = e.yaw;
    this.pitch = 0;
    this.alive = true;
    this.hp = MAX_HP;
    this.spawnId = e.spawnId;
    this.team = e.team;
    this.reloadWeapon = null;
    this.bloom = 0;
    this.scoped = false;

    if (this.lootPreview) {
      this.weapon = e.weapon !== undefined ? e.weapon : null;
      this.ownedWeapons.clear();
      if (this.weapon) this.ownedWeapons.add(this.weapon);
      this.ammo = emptyAmmo();
      this.grenades = 0;
      this.medkits = 0;
      this.switchUntil = this.weapon ? t + WEAPONS[this.weapon].switchTime : t;
    } else {
      this.weapon = e.weapon !== undefined ? e.weapon : (this.weapon ?? 'rifle');
      this.ownedWeapons = new Set<WeaponId>(WEAPON_SLOTS);
      this.ammo = fullAmmo();
      this.grenades = GRENADES_PER_LIFE;
      this.medkits = 0;
      this.switchUntil = this.weapon ? t + WEAPONS[this.weapon].switchTime : t;
    }
    this.prediction.resetForSpawn(e.spawnId);
  }

  applyInventorySnap(
    snap: {
      roundId?: number;
      spawnId?: number;
      inventoryVersion: number;
      lootPreview: boolean;
      lootEnabled?: boolean;
      equippedWeapon: WeaponId | null;
      ownedWeapons: WeaponId[];
      ammo: AmmoState;
      grenades: number;
      medkits: number;
    },
    t: number = performance.now() / 1000,
  ): boolean {
    if (snap.roundId !== undefined && this.roundId > 0 && snap.roundId < this.roundId) {
      return false;
    }
    if (snap.spawnId !== undefined && this.spawnId > 0 && snap.spawnId !== this.spawnId) {
      return false;
    }
    if (
      snap.inventoryVersion < this.inventoryVersion &&
      (snap.roundId === undefined || snap.roundId === this.roundId)
    ) {
      return false;
    }
    if (snap.roundId !== undefined) {
      this.roundId = snap.roundId;
    }
    this.inventoryVersion = snap.inventoryVersion;
    this.lootPreview = Boolean(snap.lootEnabled ?? snap.lootPreview);
    this.ownedWeapons = new Set<WeaponId>(snap.ownedWeapons);
    for (const w of WEAPON_SLOTS) {
      if (snap.ammo[w]) {
        this.ammo[w] = { mag: snap.ammo[w].mag, reserve: snap.ammo[w].reserve };
      }
    }
    this.grenades = snap.grenades;
    this.medkits = snap.medkits;
    const prevWeapon = this.weapon;
    this.weapon = snap.equippedWeapon;
    if (this.weapon !== prevWeapon) {
      this.reloadWeapon = null;
      this.scoped = false;
      this.bloom = 0;
      this.switchUntil = this.weapon ? t + WEAPONS[this.weapon].switchTime : t;
      return true;
    }
    return false;
  }

  private getMovementState(): MovementState {
    return {
      pos: { x: this.body.pos.x, y: this.body.pos.y, z: this.body.pos.z },
      vel: { x: this.body.vel.x, y: this.body.vel.y, z: this.body.vel.z },
      onGround: this.body.onGround,
      yaw: this.yaw,
      pitch: this.pitch,
      weapon: this.weapon,
      scoped: this.scoped,
    };
  }

  private applyMovementState(state: MovementState): void {
    this.body.pos = { x: state.pos.x, y: state.pos.y, z: state.pos.z };
    this.body.vel = { x: state.vel.x, y: state.vel.y, z: state.vel.z };
    this.body.onGround = state.onGround;
  }

  move(dt: number, fwd: number, right: number, jump: boolean, walk: boolean): PlayerInputCmd {
    const state = this.getMovementState();
    const cmd = this.prediction.recordAndStepInput(
      state,
      {
        dt,
        moveForward: fwd,
        moveRight: right,
        jump,
        walk,
        scoped: this.scoped,
        weapon: this.weapon,
        yaw: this.yaw,
        pitch: this.pitch,
      },
      this.world,
    );
    this.applyMovementState(state);
    return cmd;
  }

  reconcile(snap: PlayerSnap, serverTick?: number): ReconcileResult {
    const state = this.getMovementState();
    const res = this.prediction.reconcileSnapshot(state, snap, serverTick, this.world);
    this.applyMovementState(state);
    return res;
  }

  smoothedPos(): Vec3 {
    return this.prediction.getSmoothedPosition(this.body.pos);
  }

  smoothedEye(): Vec3 {
    const p = this.smoothedPos();
    return { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
  }

  speedH(): number {
    return Math.hypot(this.body.vel.x, this.body.vel.z);
  }

  eye(): Vec3 {
    return { x: this.body.pos.x, y: this.body.pos.y + EYE_HEIGHT, z: this.body.pos.z };
  }

  aimDir(): Vec3 {
    return dirFromAngles(this.yaw, this.pitch);
  }

  currentSpread(): number {
    if (!this.weapon) return 0.008;
    const def = WEAPONS[this.weapon];
    const moveK = clamp(this.speedH() / RUN_SPEED, 0, 1);
    const air = this.body.onGround ? 0 : 0.06;
    if (def.id === 'sniper') return this.scoped ? 0.0008 + moveK * 0.06 + air : def.spread + moveK * def.moveSpread + air;
    return def.spread + this.bloom + moveK * def.moveSpread + air;
  }

  ownsWeapon(w: WeaponId): boolean {
    return this.ownedWeapons.has(w);
  }

  canFire(t: number): boolean {
    if (!this.weapon || !this.ownedWeapons.has(this.weapon)) return false;
    return this.alive && t >= this.switchUntil && this.reloadWeapon === null && t - this.lastShot >= WEAPONS[this.weapon].fireInterval;
  }

  /** O'q uzadi va pellet yo'nalishlarini qaytaradi. */
  fire(t: number): Vec3[] {
    if (!this.weapon || !this.ownedWeapons.has(this.weapon)) return [];
    const def = WEAPONS[this.weapon];
    this.ammo[this.weapon].mag--;
    this.lastShot = t;
    const spread = this.currentSpread();
    const aim = this.aimDir();
    const dirs: Vec3[] = [];
    for (let i = 0; i < def.pellets; i++) dirs.push(spreadDir(aim, spread));
    this.bloom = Math.min(def.maxBloom, this.bloom + def.bloom);
    return dirs;
  }

  startReload(t: number): boolean {
    if (!this.alive || this.reloadWeapon || !this.weapon || !this.ownedWeapons.has(this.weapon)) return false;
    const def = WEAPONS[this.weapon];
    const a = this.ammo[this.weapon];
    if (a.mag >= def.magSize || a.reserve <= 0) return false;
    this.reloadWeapon = this.weapon;
    this.reloadUntil = t + def.reloadTime;
    this.scoped = false;
    return true;
  }

  /** Qayta o'qlash tugasa true. */
  updateTimers(dt: number, t: number): boolean {
    this.bloom = Math.max(0, this.bloom - dt * 0.12);
    if (this.reloadWeapon && t >= this.reloadUntil) {
      const w = this.reloadWeapon;
      this.reloadWeapon = null;
      const a = this.ammo[w];
      const take = Math.min(WEAPONS[w].magSize - a.mag, a.reserve);
      a.mag += take;
      a.reserve -= take;
      return true;
    }
    return false;
  }

  switchTo(w: WeaponId | null, t: number): boolean {
    if (w === this.weapon || !this.alive) return false;
    if (w !== null && !this.ownedWeapons.has(w)) return false;
    this.weapon = w;
    this.reloadWeapon = null;
    this.scoped = false;
    this.bloom = 0;
    this.switchUntil = w ? t + WEAPONS[w].switchTime : t;
    return true;
  }
}
