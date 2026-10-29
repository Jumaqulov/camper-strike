import { CROUCH_EYE_HEIGHT, EYE_HEIGHT, GRENADES_PER_LIFE, MAX_HP, RUN_SPEED, type Team } from '../../shared/constants';
import { clamp, dirFromAngles, spreadDir, type Vec3 } from '../../shared/math';
import type { MovementState } from '../../shared/netMovement';
import type { Body } from '../../shared/physics';
import type { PlayerInputCmd, PlayerSnap, SpawnEvent } from '../../shared/protocol';
import { eyeHeightOf } from '../../shared/stance';
import { emptyAmmo, fullAmmo, isMeleeWeapon, WEAPON_SLOTS, WEAPONS, type AmmoState, type WeaponId } from '../../shared/weapons';
import type { WorldDefinition } from '../../shared/world';
import { ClientPrediction, type ReconcileResult } from './ClientPrediction';

/** Kamera ko'z balandligining tik turish ↔ o'tirish o'tish vaqti, s (faqat vizual; o'q chiqish nuqtasi darhol). */
export const CROUCH_VIEW_BLEND_TIME = 0.12;
/** Lokal o'yinchi: harakat (klient tomonida bashorat va server bilan solishtirish) va qurol holati. */
export class LocalPlayer {
  /** Harakat bashorati uchun dunyo; `setWorld()` orqali (yoki konstruktorda) o'rnatiladi. */
  private world: WorldDefinition | null;
  readonly prediction = new ClientPrediction();
  body: Body = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, onGround: true, crouched: false };
  /** Kamera uchun silliqlangan o'tirish ulushi 0 (tik) .. 1 (o'tirgan); `updateViewCrouch()` yangilaydi. */
  viewCrouch = 0;
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
  stamina = 1;
  staminaLocked = false;
  armor = 0;
  helmet = 0;
  /** "Tong otguncha": qo'ldagi o'tin (PlayerSnap.wood dan; yo'q bo'lsa 0) — harakat bashoratida og'irlik. */
  wood = 0;
  /** "Tong otguncha": qo'ldagi mash'alning qolgan vaqti (s, PlayerSnap.torchSec dan; 0 — yo'q). */
  torchSec = 0;

  constructor(world: WorldDefinition | null = null) {
    this.world = world;
  }

  setWorld(world: WorldDefinition): void {
    this.world = world;
  }

  /** Harakat/reconcile uchun dunyo o'rnatilgan bo'lishi shart — aks holda aniq xato. */
  private requireWorld(): WorldDefinition {
    if (!this.world) throw new Error("LocalPlayer: dunyo o'rnatilmagan (setWorld chaqirilmagan)");
    return this.world;
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
    this.body.vel = { x: 0, y: 0, z: 0 };
    this.body.onGround = true;
    this.body.crouched = false;
    this.viewCrouch = 0;
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
    this.stamina = 1;
    this.staminaLocked = false;
    this.armor = 0;
    this.helmet = 0;
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
      armor?: number;
      helmet?: number;
    },
    t: number = performance.now() / 1000,
    /** true: snapshot'dagi equippedWeapon ni e'tiborsiz qoldirib, lokal qurolni saqlash (yaqinda almashtirilgan). */
    keepEquipped = false,
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
    this.armor = snap.armor ?? 0;
    this.helmet = snap.helmet ?? 0;
    const prevWeapon = this.weapon;
    const nextWeapon = snap.equippedWeapon;
    // Yaqinda lokal almashtirilgan bo'lsa va snapshot egasi bo'lmagan qurolni ko'rsatmasa, lokalni saqlaymiz
    if (keepEquipped && (this.weapon === null || this.ownedWeapons.has(this.weapon))) {
      return false;
    }
    this.weapon = nextWeapon;
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
      crouched: Boolean(this.body.crouched),
      yaw: this.yaw,
      pitch: this.pitch,
      weapon: this.weapon,
      scoped: this.scoped,
      stamina: this.stamina,
      staminaLocked: this.staminaLocked,
      // O'tinning og'irligi: server `p.wood` bilan bir xil qoida (to'la qo'lda sprint yo'q, tezlik ko'paytuvchisi)
      wood: this.wood,
    };
  }

  private applyMovementState(state: MovementState): void {
    this.body.pos = { x: state.pos.x, y: state.pos.y, z: state.pos.z };
    this.body.vel = { x: state.vel.x, y: state.vel.y, z: state.vel.z };
    this.body.onGround = state.onGround;
    this.body.crouched = Boolean(state.crouched);
    this.stamina = state.stamina ?? this.stamina;
    this.staminaLocked = Boolean(state.staminaLocked);
  }

  /** `walk` — Shift = SPRINT (protokoldagi `PlayerInputCmd.walk` nomi tarixiy, o'zgartirilmagan). */
  move(dt: number, fwd: number, right: number, jump: boolean, walk: boolean, crouch = false): PlayerInputCmd {
    const state = this.getMovementState();
    const cmd = this.prediction.recordAndStepInput(
      state,
      {
        dt,
        moveForward: fwd,
        moveRight: right,
        jump,
        walk,
        crouch,
        scoped: this.scoped,
        weapon: this.weapon,
        yaw: this.yaw,
        pitch: this.pitch,
      },
      this.requireWorld(),
    );
    this.applyMovementState(state);
    return cmd;
  }

  reconcile(snap: PlayerSnap, serverTick?: number): ReconcileResult {
    const state = this.getMovementState();
    const res = this.prediction.reconcileSnapshot(state, snap, serverTick, this.requireWorld());
    this.applyMovementState(state);
    return res;
  }

  smoothedPos(): Vec3 {
    return this.prediction.getSmoothedPosition(this.body.pos);
  }

  smoothedEye(): Vec3 {
    const p = this.smoothedPos();
    return { x: p.x, y: p.y + eyeHeightOf(this.body), z: p.z };
  }

  /**
   * Kamera ko'z balandligini (bashorat qilingan) o'tirish holatiga qarab `CROUCH_VIEW_BLEND_TIME` ichida
   * chiziqli siljitadi. Har kadrda bir marta chaqiriladi; qaytaradi: joriy `viewEyeHeight()`.
   */
  updateViewCrouch(dt: number): number {
    const target = this.body.crouched ? 1 : 0;
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0) / CROUCH_VIEW_BLEND_TIME;
    if (this.viewCrouch < target) this.viewCrouch = Math.min(target, this.viewCrouch + step);
    else if (this.viewCrouch > target) this.viewCrouch = Math.max(target, this.viewCrouch - step);
    return this.viewEyeHeight();
  }

  /** Kamera uchun silliqlangan ko'z balandligi (oyoqdan), m: EYE_HEIGHT ↔ CROUCH_EYE_HEIGHT (smoothstep). */
  viewEyeHeight(): number {
    const k = clamp(this.viewCrouch, 0, 1);
    const e = k * k * (3 - 2 * k);
    return EYE_HEIGHT + (CROUCH_EYE_HEIGHT - EYE_HEIGHT) * e;
  }

  speedH(): number {
    return Math.hypot(this.body.vel.x, this.body.vel.z);
  }

  /** O'q chiqish nuqtasi — server bilan bir xil (o'tirganda CROUCH_EYE_HEIGHT, silliqlashsiz). */
  eye(): Vec3 {
    return { x: this.body.pos.x, y: this.body.pos.y + eyeHeightOf(this.body), z: this.body.pos.z };
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

  /** Pichoq har doim mavjud; o'qotar qurollar inventar bo'yicha. */
  ownsWeapon(w: WeaponId): boolean {
    return isMeleeWeapon(w) || this.ownedWeapons.has(w);
  }

  canFire(t: number): boolean {
    if (!this.weapon || !this.ownsWeapon(this.weapon)) return false;
    return this.alive && t >= this.switchUntil && this.reloadWeapon === null && t - this.lastShot >= WEAPONS[this.weapon].fireInterval;
  }

  /** O'q uzadi va pellet yo'nalishlarini qaytaradi. */
  fire(t: number): Vec3[] {
    if (!this.weapon || !this.ownsWeapon(this.weapon)) return [];
    const def = WEAPONS[this.weapon];
    if (!isMeleeWeapon(this.weapon)) this.ammo[this.weapon].mag--;
    this.lastShot = t;
    const spread = this.currentSpread();
    const aim = this.aimDir();
    const dirs: Vec3[] = [];
    for (let i = 0; i < def.pellets; i++) dirs.push(spreadDir(aim, spread));
    this.bloom = Math.min(def.maxBloom, this.bloom + def.bloom);
    return dirs;
  }

  startReload(t: number): boolean {
    if (!this.alive || this.reloadWeapon || !this.weapon || !this.ownsWeapon(this.weapon)) return false;
    if (isMeleeWeapon(this.weapon)) return false;
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
    if (w !== null && !this.ownsWeapon(w)) return false;
    this.weapon = w;
    this.reloadWeapon = null;
    this.scoped = false;
    this.bloom = 0;
    this.switchUntil = w ? t + WEAPONS[w].switchTime : t;
    return true;
  }
}
