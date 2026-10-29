import { WALK_SPEED } from '../shared/constants';
import { angleDiff, vcopy, vdist, type Vec3 } from '../shared/math';
import { applyWorldMovement, raycastWorld, type Body } from '../shared/physics';
import { hitboxScaleOf } from '../shared/stance';
import { sampleTerrainHeight } from '../shared/world';
import {
  WOLF_ALPHA_BUFF_SPEED_MUL,
  WOLF_ATTACK_COOLDOWN,
  WOLF_ATTACK_DURATION,
  WOLF_BITE_AT,
  WOLF_BITE_RANGE,
  WOLF_EYE_HEIGHT,
  WOLF_HEAR_SHOT_RANGE,
  WOLF_HIT_FLINCH,
  WOLF_HOWL_MAX_SEC,
  WOLF_HOWL_MIN_SEC,
  WOLF_LOSE_TARGET_SEC,
  WOLF_SIGHT_FOV_DOT,
  WOLF_SIGHT_NEAR,
  WOLF_SIGHT_RANGE,
  WOLF_SMELL_CROUCH_MUL,
  WOLF_SMELL_RANGE,
  WOLF_SMELL_SPRINT_MUL,
  WOLF_TURN_RATE,
  WOLF_UNREACHABLE_DY,
  wolfSpeedForState,
  type WolfState,
} from '../shared/wolf';
import type { FearSource, Room, ServerPlayer } from './room';
import {
  WOLF_FLANK_DRIVER_CLOSE_M,
  WOLF_FLANK_ENGAGE_M,
  WOLF_FLANK_HOLD_MAX_SEC,
  WOLF_FLANK_STALK_M,
  preyFacingDot,
  type PackOrder,
  type WolfRole,
} from './wolfPack';

/** Server tomonidagi bo'ri: fizik tana + holat; AI `WolfBrain` da. */
export interface ServerWolf extends Body {
  id: string;
  coat: number;
  hp: number;
  alive: boolean;
  yaw: number;
  state: WolfState;
  /** Ovlanayotgan o'yinchi (snapshotga chiqadi). */
  targetId: string | null;
  diedAt: number;
  /** Klassik rejimlarda qayta paydo bo'lish vaqti (survivalda Infinity). */
  respawnAt: number;
  /**
   * Ko'paytuvchilar: to'lqin × tun qiyinligi (faqat wolf_night) × rang turi (WOLF_COAT_TRAITS, barcha rejimlarda) —
   * tezlik, jon (WOLF_MAX_HP ga), tishlash zarari.
   */
  speedMul: number;
  hpMul: number;
  biteMul: number;
  /** To'da boshlig'i uvlagani uchun tezlashuv tugash vaqti (WOLF_ALPHA_BUFF_SPEED_MUL); 0 — yo'q. */
  alphaBuffUntil: number;
  /** Tong otdi ('flee'): shu vaqtgacha qochadi, keyin xonadan olib tashlanadi; boshqa holatlarda Infinity. */
  fleeUntil: number;
  /**
   * Signal raketasidan qo'rqib qochish ('flee' holati, lekin tong emas): shu vaqtgacha qochadi, keyin oddiy
   * sayrga qaytadi (xonadan olib tashlanmaydi). 0 — qo'rqmagan.
   */
  scaredUntil: number;
  /** To'dadagi vazifa (WolfPack har tick beradi; nishon yo'q — null). Snapshotga 'd'/'f' sifatida chiqadi. */
  role: WolfRole | null;
  brain: WolfBrain;
}

/** Sezish darajasi: 0 — yo'q, 1 — hid/shubha (joy ma'lum, LOS yo'q), 2 — ko'rdi. */
type SenseLevel = 0 | 1 | 2;

/** Nishon yetib bo'lmas balandlikda (2-qavat, tom) yoki gulxan/mash'al yonida bo'lsa shu oraliqda uvlaydi (s). */
const UNREACHABLE_HOWL_SEC = 9;
// Olovdan qo'rqish masofalari manbaga bog'liq (`FearSource.radius/standoff`): gulxan — CAMPFIRE_RADIUS_M /
// CAMPFIRE_STANDOFF_M, mash'al — TORCH_FEAR_RADIUS_M / TORCH_STANDOFF_M (shared/wolf/camp.ts).
/** Sayrda to'xtab hid olish ehtimoli (sekundiga). */
const ROAM_SNIFF_CHANCE = 0.06;
const SENSE_INTERVAL = 0.15;
/** Qochayotgan bo'ri shu oraliqda (s) yoki maqsadga yetganda yangi uzoq maqsad tanlaydi. */
const FLEE_REGOAL_SEC = 4;

/**
 * Bo'ri sun'iy intellekti: sayr → hid/tovush bo'yicha tekshirish → ov (yugurib quvish) → tashlanib tishlash.
 * Bo'ri zinaga chiqmaydi: nav-graf faqat yer sathi, yaqin masofada to'g'ri chiziq bilan yuradi (eshikdan
 * kiradi, lekin loft/tomga chiqolmaydi — nishon balandda bo'lsa pastda aylanib uvlaydi).
 */
export class WolfBrain {
  private path: Vec3[] = [];
  private pathIdx = 0;
  private repathAt = 0;
  private target: ServerPlayer | null = null;
  private lastSensedAt = -99;
  private lastSensedPos: Vec3 | null = null;
  private seenNow = false;
  /** Shubhali joy (hid, o'q ovozi): borib hidlaydi. */
  private investigatePos: Vec3 | null = null;
  /** Vaqtli holatlar (attack/hit/howl/sniff/alert) tugash vaqti. */
  private stateUntil = 0;
  private attackStartedAt = 0;
  private biteDone = false;
  private nextAttackAt = 0;
  private nextSenseAt = 0;
  private nextHowlAt = 0;
  private roamGoal: Vec3 | null = null;
  private roamGoalAt = 0;
  private stuckCheckAt = 0;
  private stuckPos: Vec3 = { x: 0, y: 0, z: 0 };
  private stuckCount = 0;
  /** Tong otgach qochish maqsadi (uzoqdagi nav tuguni) va tanlangan vaqti. */
  private fleeGoal: Vec3 | null = null;
  private fleeGoalAt = 0;
  /** Joriy tick vaqti (speedFor to'da boshlig'i tezlashuvini shu bilan tekshiradi). */
  private tNow = 0;
  /** To'da koordinatorining joriy buyrug'i (null — to'da nishon bermadi, o'z sezgisi bilan ishlaydi). */
  private order: PackOrder | null = null;
  /** Qanot nuqtasida kutish boshlangan vaqt (0 — kutmayapti). */
  private flankHoldSince = 0;
  private lastPackHowlAt = -99;
  /** Olov halqasi bo'ylab siljish: oxirgi tekshiruvdagi burchak/vaqt, to'silganda kengroq radius muddati. */
  private slideAngPrev = 0;
  private slideCheckAt = 0;
  private slideWideUntil = 0;

  constructor(
    private readonly room: Room,
    private readonly me: ServerWolf,
  ) {}

  onSpawn(t: number): void {
    this.path = [];
    this.pathIdx = 0;
    this.repathAt = 0;
    this.target = null;
    this.lastSensedAt = -99;
    this.lastSensedPos = null;
    this.investigatePos = null;
    this.roamGoal = null;
    this.fleeGoal = null;
    this.nextAttackAt = t;
    this.nextSenseAt = t;
    this.stuckCount = 0;
    this.stuckPos = vcopy(this.me.pos);
    this.stuckCheckAt = t + 1.5;
    this.nextHowlAt = t + 4 + Math.random() * 10;
    this.order = null;
    this.flankHoldSince = 0;
    this.me.role = null;
    this.setState('idle', t);
  }

  /**
   * To'da koordinatori buyrug'i (har tick, AI yangilanishidan oldin). Nishon o'zgarsa to'daning oxirgi ma'lum
   * joyi/vaqti qabul qilinadi (to'da xabardorligi); tishlash paytida nishon almashmaydi (buyruq keyingi tickda
   * kuchga kiradi). `null` — to'da nishon bermadi: bo'ri o'z sezgisi bilan ishlaydi (eski xatti-harakat).
   */
  setPackOrder(order: PackOrder | null, _t: number): void {
    this.order = order;
    if (!order) return;
    const p = this.room.players.get(order.targetId) ?? null;
    if (!p || !this.isHuntable(p)) {
      this.order = null;
      return;
    }
    if (this.target !== p) {
      if (this.me.state === 'attack') return;
      this.target = p;
      this.investigatePos = null;
      this.path = [];
      this.pathIdx = 0;
      this.repathAt = 0;
      this.flankHoldSince = 0;
      this.lastSensedAt = order.sensedAt;
      this.lastSensedPos = vcopy(order.sensedPos);
    } else if (order.sensedAt > this.lastSensedAt) {
      this.lastSensedAt = order.sensedAt;
      this.lastSensedPos = vcopy(order.sensedPos);
    }
  }

  /**
   * Tong otdi: nishon va izlar tashlanadi, bo'ri eng yaqin o'yinchidan teskari tomonga uzoqdagi nav tuguniga
   * yugurib qochadi ('flee'). Bu holatda tishlamaydi, nishon olmaydi, olovdan qo'rqmaydi; xona uni
   * `fleeUntil` dan keyin (yoki hammadan uzoqlashganda) olib tashlaydi.
   */
  startFlee(t: number): void {
    const me = this.me;
    if (!me.alive) return;
    this.target = null;
    this.lastSensedPos = null;
    this.investigatePos = null;
    this.roamGoal = null;
    this.path = [];
    this.pathIdx = 0;
    this.repathAt = 0;
    this.fleeGoal = this.room.pickWolfFleeGoal(me);
    this.fleeGoalAt = t;
    me.targetId = null;
    this.setState('flee', t);
  }

  /**
   * Signal raketasi (wolf_night): bo'ri `sec` soniya qochadi (tong qochishi bilan bir xil 'flee' holati, lekin
   * `scaredUntil` bilan — muddati tugagach sayrga qaytadi, xonadan olib tashlanmaydi). Nishon va izlar tashlanadi;
   * to'da buyrug'i bekor. Tong otgan bo'lsa (fleeUntil cheklangan) o'zgarmaydi.
   */
  startScared(t: number, sec: number): void {
    const me = this.me;
    if (!me.alive || Number.isFinite(me.fleeUntil)) return;
    me.scaredUntil = Math.max(me.scaredUntil, t + sec);
    this.order = null;
    me.role = null;
    if (me.state === 'flee') return;
    this.startFlee(t);
  }

  /** Zarba yedi: hujumchi nishonga aylanadi, hujum paytida bo'lmasa qisqa seskanadi. */
  onDamaged(attacker: ServerPlayer | null, t: number): void {
    const me = this.me;
    if (!me.alive || me.state === 'flee') return;
    if (attacker && attacker.alive) {
      this.target = attacker;
      this.lastSensedAt = t;
      this.lastSensedPos = vcopy(attacker.pos);
      this.investigatePos = null;
      // To'da: hujumchi haqida xabar; bu bo'ri WOLF_PACK_RETALIATE_SEC davomida aynan uni ovlaydi
      if (this.isHuntable(attacker)) this.room.pack.report(me, attacker, t, true);
    }
    if (me.state !== 'attack' && me.state !== 'dead') {
      this.setState('hit', t, WOLF_HIT_FLINCH);
    }
  }

  /** O'q ovozi: nishon bo'lmasa o'sha joyga boradi (hid oladi), bo'lsa izini yangilaydi. */
  onNoise(pos: Vec3, t: number, source: ServerPlayer | null): void {
    const me = this.me;
    if (!me.alive || me.state === 'flee') return;
    if (Math.hypot(pos.x - me.pos.x, pos.z - me.pos.z) > WOLF_HEAR_SHOT_RANGE) return;
    if (source && this.target === source) {
      this.lastSensedAt = Math.max(this.lastSensedAt, t - 0.3);
      this.lastSensedPos = vcopy(source.pos);
      return;
    }
    if (!this.target) {
      this.investigatePos = vcopy(pos);
      this.repathAt = 0;
      if (me.state === 'idle' || me.state === 'sniff') this.setState('alert', t, 0.8);
    }
  }

  /** Yaqindagi gulxan o'chdi: nishon bo'lmasa qorong'i lagerga borib tekshiradi (wolf_night). */
  onFireOut(pos: Vec3, t: number): void {
    const me = this.me;
    if (!me.alive || this.target || me.state === 'flee') return;
    this.investigatePos = vcopy(pos);
    this.roamGoal = null;
    this.repathAt = 0;
    if (me.state === 'idle' || me.state === 'sniff') this.setState('alert', t, 0.8);
  }

  private setState(s: WolfState, t: number, durationSec = 0): void {
    this.me.state = s;
    this.stateUntil = durationSec > 0 ? t + durationSec : 0;
  }

  private eye(): Vec3 {
    return { x: this.me.pos.x, y: this.me.pos.y + WOLF_EYE_HEIGHT, z: this.me.pos.z };
  }

  private canSee(p: ServerPlayer, dH: number): boolean {
    if (dH > WOLF_SIGHT_RANGE) return false;
    const me = this.me;
    const dx = p.pos.x - me.pos.x;
    const dz = p.pos.z - me.pos.z;
    if (dH > WOLF_SIGHT_NEAR) {
      // Old yarim-doira: bo'ri old yo'nalishi (-sin yaw, -cos yaw)
      const fx = -Math.sin(me.yaw);
      const fz = -Math.cos(me.yaw);
      if ((fx * dx + fz * dz) / Math.max(dH, 1e-3) < WOLF_SIGHT_FOV_DOT) return false;
    }
    const eye = this.eye();
    const center = { x: p.pos.x, y: p.pos.y + 1.0 * hitboxScaleOf(p), z: p.pos.z };
    const d = vdist(eye, center);
    if (d < 1e-3) return true;
    const dir = { x: (center.x - eye.x) / d, y: (center.y - eye.y) / d, z: (center.z - eye.z) / d };
    return !raycastWorld(this.room.world, eye, dir, d);
  }

  private senseLevel(p: ServerPlayer, dH: number): SenseLevel {
    if (this.canSee(p, dH)) return 2;
    const sprinting = Math.hypot(p.vel.x, p.vel.z) > WALK_SPEED + 0.6;
    const mul = p.crouched ? WOLF_SMELL_CROUCH_MUL : sprinting ? WOLF_SMELL_SPRINT_MUL : 1;
    return dH < WOLF_SMELL_RANGE * mul ? 1 : 0;
  }

  /** Ovlash mumkin: tirik ishtirokchi, yiqilmagan va faol signal raketasi doirasidan tashqarida. */
  private isHuntable(p: ServerPlayer): boolean {
    return this.room.isWolfPreyExposed(p);
  }

  private sense(t: number): void {
    const me = this.me;
    const pack = this.room.pack;
    let best: ServerPlayer | null = null;
    let bestLevel: SenseLevel = 0;
    let bestD = Infinity;
    let curLevel: SenseLevel = 0;
    for (const p of this.room.players.values()) {
      if (!this.isHuntable(p)) continue;
      const dH = Math.hypot(p.pos.x - me.pos.x, p.pos.z - me.pos.z);
      // Joriy nishon sezgi uchun ustunlikka ega (bir xil darajada yaqinroq bo'lmasa ham ushlab turadi)
      const level = this.senseLevel(p, dH);
      if (level === 0) continue;
      // To'da xabardorligi: ko'rilgan / yaqindan hidi olingan / ovlanayotgan o'yinchi to'daga ma'lum qilinadi
      if (level === 2 || dH < 6 || p === this.target) pack.report(me, p, t);
      if (p === this.target) curLevel = level;
      const dEff = p === this.target ? dH * 0.6 : dH;
      if (level > bestLevel || (level === bestLevel && dEff < bestD)) {
        best = p;
        bestLevel = level;
        bestD = dEff;
      }
    }
    this.seenNow = false;
    if (this.order && this.target) {
      // To'da buyrug'i bor: nishonni to'da tanlaydi, bo'ri faqat o'z sezgisi bilan izini yangilaydi
      if (curLevel > 0) {
        this.lastSensedAt = t;
        this.lastSensedPos = vcopy(this.target.pos);
        this.seenNow = curLevel === 2;
      }
      return;
    }
    if (!best) return;
    const dH = Math.hypot(best.pos.x - me.pos.x, best.pos.z - me.pos.z);
    if (bestLevel === 2 || dH < 6 || best === this.target) {
      // Ko'rdi, juda yaqin hid oldi yoki avvaldan ovlayotgan nishonning izini yangiladi
      this.target = best;
      this.lastSensedAt = t;
      this.lastSensedPos = vcopy(best.pos);
      this.investigatePos = null;
      this.seenNow = bestLevel === 2;
    } else if (!this.target) {
      // Uzoqroqdan hid: borib tekshiradi
      this.investigatePos = vcopy(best.pos);
      if (me.state === 'idle' || me.state === 'sniff') this.setState('alert', t, 1.0);
    }
  }

  /** Holat tezligi × ko'paytuvchi (to'lqin/qiyinlik/rang turi) × to'da boshlig'i uvlashi tezlashuvi. */
  private speedFor(state: WolfState): number {
    const buff = this.tNow < this.me.alphaBuffUntil ? WOLF_ALPHA_BUFF_SPEED_MUL : 1;
    return wolfSpeedForState(state) * (this.me.speedMul || 1) * buff;
  }

  private turnTowards(yaw: number, dt: number, rate = WOLF_TURN_RATE): void {
    const me = this.me;
    const d = angleDiff(me.yaw, yaw);
    const step = rate * dt;
    me.yaw += Math.abs(d) <= step ? d : Math.sign(d) * step;
  }

  private moveTowards(goal: Vec3, speed: number, dt: number): { wishX: number; wishZ: number; arrived: boolean } {
    const me = this.me;
    const dx = goal.x - me.pos.x;
    const dz = goal.z - me.pos.z;
    const dl = Math.hypot(dx, dz);
    if (dl < 0.35) return { wishX: 0, wishZ: 0, arrived: true };
    this.turnTowards(Math.atan2(-dx, -dz), dt);
    return { wishX: (dx / dl) * speed, wishZ: (dz / dl) * speed, arrived: false };
  }

  /** Nav-graf yo'li bo'ylab (zinaga chiqmaydi); yaqin va ko'rinadigan maqsadga to'g'ri yuradi. */
  private followPath(goal: Vec3, speed: number, t: number, dt: number, direct: boolean): { wishX: number; wishZ: number } {
    const me = this.me;
    if (direct) {
      this.path = [];
      this.pathIdx = 0;
      this.repathAt = 0;
      const m = this.moveTowards(goal, speed, dt);
      return { wishX: m.wishX, wishZ: m.wishZ };
    }
    if (t >= this.repathAt || this.pathIdx >= this.path.length) {
      this.path = this.room.nav.findPath(me.pos, goal);
      this.pathIdx = 0;
      this.repathAt = t + 0.7 + Math.random() * 0.3;
      if (this.path.length === 0) {
        // Yo'l topilmadi — to'g'ri yuramiz (eshik oldi, ochiq joy)
        const m = this.moveTowards(goal, speed, dt);
        return { wishX: m.wishX, wishZ: m.wishZ };
      }
    }
    const node = this.path[this.pathIdx]!;
    const dx = node.x - me.pos.x;
    const dz = node.z - me.pos.z;
    if (Math.hypot(dx, dz) < 0.9) {
      this.pathIdx++;
      if (this.pathIdx >= this.path.length) {
        const m = this.moveTowards(goal, speed, dt);
        return { wishX: m.wishX, wishZ: m.wishZ };
      }
    }
    const m = this.moveTowards(this.path[this.pathIdx]!, speed, dt);
    return { wishX: m.wishX, wishZ: m.wishZ };
  }

  /**
   * Olov manbai (yonib turgan gulxan yoki mash'al ko'targan o'yinchi) doirasidagi (+1 m, olovdan qochish
   * chegarasi) maqsadni doira chetiga — manbaning `standoff` masofasida, bo'ri turgan tomonga — suradi.
   * Aks holda bo'ri maqsadga yurish bilan olovdan qochish orasida tebranadi.
   */
  private outsideFear(goal: Vec3): Vec3 {
    const fire = this.room.fearSourceContaining(goal.x, goal.z, 1);
    if (!fire) return goal;
    const me = this.me;
    let dx = me.pos.x - fire.x;
    let dz = me.pos.z - fire.z;
    let dl = Math.hypot(dx, dz);
    if (dl < 1e-3) {
      dx = goal.x - fire.x;
      dz = goal.z - fire.z;
      dl = Math.hypot(dx, dz);
    }
    if (dl < 1e-3) {
      dx = 1;
      dz = 0;
      dl = 1;
    }
    const x = fire.x + (dx / dl) * fire.standoff;
    const z = fire.z + (dz / dl) * fire.standoff;
    return { x, y: sampleTerrainHeight(this.room.world.terrain, x, z), z };
  }

  private hasDirectLine(goal: Vec3): boolean {
    const me = this.me;
    const dH = Math.hypot(goal.x - me.pos.x, goal.z - me.pos.z);
    if (dH > 14 || dH < 1e-3) return dH < 1e-3;
    if (Math.abs(goal.y - me.pos.y) > 1.2) return false;
    const a = { x: me.pos.x, y: me.pos.y + 0.6, z: me.pos.z };
    const dir = { x: (goal.x - me.pos.x) / dH, y: 0, z: (goal.z - me.pos.z) / dH };
    return !raycastWorld(this.room.world, a, dir, dH);
  }

  private checkStuck(t: number, wishing: boolean): void {
    const me = this.me;
    if (t < this.stuckCheckAt) return;
    const moved = Math.hypot(me.pos.x - this.stuckPos.x, me.pos.z - this.stuckPos.z);
    if (wishing && moved < 0.5) {
      this.stuckCount++;
      this.repathAt = 0;
      if (this.stuckCount >= 3) {
        // Geometriyaga tiqildi: eng yaqin nav katagiga (≤3 m) qaytaramiz, nishonni/maqsadni tashlaymiz
        const nav = this.room.nav;
        const ni = nav.nearest(me.pos);
        if (ni >= 0) {
          const c = nav.center(ni);
          if (Math.hypot(c.x - me.pos.x, c.z - me.pos.z) < 3) {
            me.pos = { x: c.x, y: Math.max(me.pos.y, c.y), z: c.z };
            me.vel = { x: 0, y: 0, z: 0 };
          }
        }
        this.roamGoal = null;
        this.investigatePos = null;
        this.fleeGoal = null;
        this.stuckCount = 0;
      }
    } else {
      this.stuckCount = 0;
    }
    this.stuckPos = vcopy(me.pos);
    this.stuckCheckAt = t + 1.2;
  }

  /**
   * Tong otgach qochish: yugurish tezligida uzoq maqsadga nav-graf yo'li bo'ylab; tishlamaydi, nishon olmaydi,
   * olovdan qo'rqmaydi (gulxan tekshiruvidan oldin chaqiriladi). Raund 'ended' fazasida ham ishlaydi.
   */
  private updateFlee(dt: number, t: number): void {
    const me = this.me;
    me.targetId = null;
    if (
      !this.fleeGoal ||
      t - this.fleeGoalAt > FLEE_REGOAL_SEC ||
      Math.hypot(this.fleeGoal.x - me.pos.x, this.fleeGoal.z - me.pos.z) < 1.5
    ) {
      this.fleeGoal = this.room.pickWolfFleeGoal(me);
      this.fleeGoalAt = t;
      this.repathAt = 0;
    }
    const goal = this.fleeGoal;
    const m = this.followPath(goal, this.speedFor('flee'), t, dt, this.hasDirectLine(goal));
    applyWorldMovement(me, m.wishX, m.wishZ, false, dt, this.room.world);
    this.checkStuck(t, m.wishX !== 0 || m.wishZ !== 0);
  }

  update(dt: number, t: number): void {
    const me = this.me;
    if (!me.alive) return;
    this.tNow = t;
    // Tong otdi: faza 'ended' bo'lsa ham qochishda davom etadi (pastdagi 'idle' tarmog'i uni bekor qilmasin)
    if (me.state === 'flee') {
      if (me.scaredUntil > 0 && !Number.isFinite(me.fleeUntil) && t >= me.scaredUntil) {
        // Raketadan qo'rqish tugadi — sayrga qaytadi (nishonsiz, yangi sayr maqsadi bilan)
        me.scaredUntil = 0;
        this.fleeGoal = null;
        this.roamGoal = null;
        this.repathAt = 0;
        this.nextSenseAt = t + 1.0;
        this.setState('idle', t);
      } else {
        this.updateFlee(dt, t);
        return;
      }
    }
    if (this.room.phase !== 'playing') {
      if (me.state !== 'idle') this.setState('idle', t);
      me.targetId = null;
      applyWorldMovement(me, 0, 0, false, dt, this.room.world);
      return;
    }

    // Olovdan qo'rqish: yonib turgan gulxan yoki mash'al ko'targan o'yinchi doirasiga (+1 m) tushib qolsa —
    // tashqariga yugurib chiqadi (mash'al egasi bo'riga yaqinlashsa, bo'ri chekinadi)
    const burning = this.room.fearSourceContaining(me.pos.x, me.pos.z, 1);
    if (burning) {
      let ox = me.pos.x - burning.x;
      let oz = me.pos.z - burning.z;
      const ol = Math.hypot(ox, oz);
      if (ol < 1e-3) {
        ox = -Math.sin(me.yaw);
        oz = -Math.cos(me.yaw);
      } else {
        ox /= ol;
        oz /= ol;
      }
      if (me.state !== 'alert') this.setState('alert', t);
      me.targetId = this.target ? this.target.id : null;
      this.turnTowards(Math.atan2(-ox, -oz), dt, 10);
      const sp = this.speedFor('hunt');
      applyWorldMovement(me, ox * sp, oz * sp, false, dt, this.room.world);
      this.checkStuck(t, true);
      return;
    }

    if (t >= this.nextSenseAt) {
      this.nextSenseAt = t + SENSE_INTERVAL;
      this.sense(t);
    }
    if (this.target && (!this.isHuntable(this.target) || t - this.lastSensedAt > WOLF_LOSE_TARGET_SEC)) {
      // Izini yo'qotdi: oxirgi ko'rgan joyga borib hidlaydi
      this.investigatePos = this.lastSensedPos ? vcopy(this.lastSensedPos) : null;
      this.target = null;
      this.repathAt = 0;
    }
    me.targetId = this.target ? this.target.id : null;

    let wishX = 0;
    let wishZ = 0;
    const timed = this.stateUntil > 0;

    if (me.state === 'attack') {
      const tgt = this.target;
      if (tgt) this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 3);
      if (!this.biteDone && t - this.attackStartedAt >= WOLF_BITE_AT) {
        this.biteDone = true;
        this.room.wolfBite(me, tgt);
      }
      if (t >= this.stateUntil) {
        this.nextAttackAt = t + WOLF_ATTACK_COOLDOWN;
        this.setState(this.target ? 'hunt' : 'idle', t);
      }
    } else if (timed && t < this.stateUntil && (me.state === 'hit' || me.state === 'howl' || me.state === 'sniff' || me.state === 'alert')) {
      // Vaqtli holat: joyida turadi (alert — nishon tomonga qaraydi)
      const look = this.target?.pos ?? this.investigatePos;
      if (look) this.turnTowards(Math.atan2(-(look.x - me.pos.x), -(look.z - me.pos.z)), dt, 3);
    } else if (this.target && this.order?.howl && this.order.targetId === this.target.id && t - this.lastPackHowlAt > 20) {
      // To'da: to'lqinda birinchi nishon uzoqdan olindi — haydovchi bir marta uvlaydi (keyin quvadi)
      this.lastPackHowlAt = t;
      this.nextHowlAt = t + UNREACHABLE_HOWL_SEC;
      this.setState('howl', t, 3.0);
      this.room.wolfHowl(me);
    } else if (this.target) {
      const tgt = this.target;
      // To'da buyrug'i shu nishon uchunmi (vazifa: haydovchi / qanot, halqa o'rni)
      const order = this.order && this.order.targetId === tgt.id ? this.order : null;
      const dH = Math.hypot(tgt.pos.x - me.pos.x, tgt.pos.z - me.pos.z);
      const dy = tgt.pos.y - me.pos.y;
      const fresh = t - this.lastSensedAt < 1.0;
      // Eskirgan iz gulxan/mash'al doirasida qolgan bo'lsa — chetigacha boradi (olovga kirib-chiqib tebranmaydi)
      const goal = fresh ? tgt.pos : this.outsideFear(this.lastSensedPos ?? tgt.pos);
      const unreachable = dy > WOLF_UNREACHABLE_DY && dH < 8;
      // Nishon yonib turgan gulxan doirasida yoki o'zi mash'al ko'targan: olovga kirmaydi — chetida
      // (manba `standoff` masofasida) to'xtab qaraydi, uvlaydi
      const fire: FearSource | null = this.room.fearSourceContaining(tgt.pos.x, tgt.pos.z, 0);
      if (fire) {
        this.path = [];
        this.pathIdx = 0;
        this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt);
        if (t >= this.nextHowlAt) {
          this.nextHowlAt = t + UNREACHABLE_HOWL_SEC;
          this.setState('howl', t, 3.0);
          this.room.wolfHowl(me);
        } else if (me.state !== 'alert' && me.state !== 'howl') {
          this.setState('alert', t);
        }
        const fx = me.pos.x - fire.x;
        const fz = me.pos.z - fire.z;
        const fd = Math.hypot(fx, fz);
        const standoff = fire.standoff;
        // To'da halqa o'rni: o'z burchagiga halqa bo'ylab siljish kerakmi
        const myAng = Math.atan2(fz, fx);
        const slotDA = order?.standoffAngle !== undefined ? angleDiff(myAng, order.standoffAngle) : 0;
        const sliding = order?.standoffAngle !== undefined && Math.abs(slotDA) > 0.12 && fd < standoff + 6;
        if (!sliding) {
          this.slideAngPrev = myAng;
          this.slideCheckAt = t + 1.2;
        } else if (t >= this.slideCheckAt) {
          // Halqa bo'ylab siljish to'sildi (burchak o'zgarmadi): bir muddat kengroq radiusda aylanib o'tadi
          if (Math.abs(angleDiff(this.slideAngPrev, myAng)) < 0.06) this.slideWideUntil = t + 2.5;
          this.slideAngPrev = myAng;
          this.slideCheckAt = t + 1.2;
        }
        if (sliding) {
          const ringR = t < this.slideWideUntil ? standoff + 3 : standoff;
          const sp = this.speedFor('stalk');
          const tangential = sp * Math.min(1, 0.3 + Math.abs(slotDA) * 2);
          const sgn = Math.sign(slotDA);
          const radial = Math.max(-sp, Math.min(sp, (ringR - fd) * 2));
          wishX = -Math.sin(myAng) * sgn * tangential + (fx / Math.max(fd, 1e-3)) * radial;
          wishZ = Math.cos(myAng) * sgn * tangential + (fz / Math.max(fd, 1e-3)) * radial;
          this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        } else if (fd > standoff + 0.4) {
          // Olov chetiga yaqinlashadi (markaz tomon, lekin doiraga kirmaydi)
          const m = this.moveTowards(
            { x: fire.x + (fx / Math.max(fd, 1e-3)) * standoff, y: me.pos.y, z: fire.z + (fz / Math.max(fd, 1e-3)) * standoff },
            this.speedFor('stalk'),
            dt,
          );
          wishX = m.wishX;
          wishZ = m.wishZ;
          this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        } else if (fd < standoff - 0.6) {
          // Juda yaqin — orqaga chekinadi
          const sp = this.speedFor('stalk');
          wishX = (fx / Math.max(fd, 1e-3)) * sp;
          wishZ = (fz / Math.max(fd, 1e-3)) * sp;
        } else if (order?.standoffAngle !== undefined) {
          // O'z halqa o'rnida: turib nishonga qaraydi (to'da o'rab olgan)
        } else if (me.state === 'alert') {
          // Chetida aylanib yuradi (soat yo'nalishida, sekin)
          const sp = this.speedFor('idle') * 0.6;
          wishX = (-fz / Math.max(fd, 1e-3)) * sp;
          wishZ = (fx / Math.max(fd, 1e-3)) * sp;
        }
      } else if (unreachable) {
        // Nishon balandda (loft/tom): pastda turib qaraydi, vaqti-vaqti bilan uvlaydi
        this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt);
        if (t >= this.nextHowlAt) {
          this.nextHowlAt = t + UNREACHABLE_HOWL_SEC;
          this.setState('howl', t, 3.0);
          this.room.wolfHowl(me);
        } else if (me.state !== 'alert' && me.state !== 'howl') {
          this.setState('alert', t);
        }
        if (dH > 3.5) {
          const m = this.moveTowards({ x: tgt.pos.x, y: me.pos.y, z: tgt.pos.z }, this.speedFor('stalk'), dt);
          wishX = m.wishX;
          wishZ = m.wishZ;
        }
      } else if (
        fresh &&
        dH < WOLF_BITE_RANGE &&
        Math.abs(dy) < 1.3 &&
        t >= this.nextAttackAt &&
        // Mash'al ko'targanga tashlanmaydi (yuqoridagi olov tarmog'i buni allaqachon ushlaydi — qo'shimcha himoya)
        !this.room.hasTorch(tgt, t) &&
        Math.abs(angleDiff(me.yaw, Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)))) < 0.7
      ) {
        this.attackStartedAt = t;
        this.biteDone = false;
        this.setState('attack', t, WOLF_ATTACK_DURATION);
      } else {
        let huntState: WolfState = fresh ? 'hunt' : 'stalk';
        let moveGoal = goal;
        let hold = false;
        if (fresh && order?.role === 'flanker' && order.flankGoal) {
          // Qanot: nishon atrofidagi qanot nuqtasiga boradi; nishon yaqin (≤ 11 m) va haydovchi yetib kelgan
          // (≤ 6 m) yoki nishon orqa o'girgan bo'lsa — to'g'ri hujumga o'tadi; uzoq kutmaydi (≤ 4 s)
          const facingAway = preyFacingDot(tgt.yaw, tgt.pos, me.pos) < 0;
          const engage = dH < WOLF_FLANK_ENGAGE_M && (order.driverDist <= WOLF_FLANK_DRIVER_CLOSE_M || facingAway);
          const waited = this.flankHoldSince > 0 && t - this.flankHoldSince > WOLF_FLANK_HOLD_MAX_SEC;
          if (!engage && !waited) {
            moveGoal = this.outsideFear(order.flankGoal);
            const dGoal = Math.hypot(moveGoal.x - me.pos.x, moveGoal.z - me.pos.z);
            huntState = dH > WOLF_FLANK_STALK_M ? 'stalk' : 'hunt';
            if (dGoal < 1.2 || (this.flankHoldSince > 0 && dGoal < 2.5)) {
              hold = true;
              huntState = 'stalk';
              if (this.flankHoldSince === 0) this.flankHoldSince = t;
            } else {
              this.flankHoldSince = 0;
            }
          }
        } else {
          this.flankHoldSince = 0;
        }
        if (me.state !== huntState) this.setState(huntState, t);
        if (hold) {
          // Qanot nuqtasida nishonga qarab kutadi
          this.path = [];
          this.pathIdx = 0;
          this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        } else {
          const speed = this.speedFor(huntState);
          const direct = this.hasDirectLine(moveGoal);
          const m = this.followPath(moveGoal, speed, t, dt, direct);
          wishX = m.wishX;
          wishZ = m.wishZ;
        }
        // Yaqin masofada nishonga qarab turadi (yo'l tuguniga emas)
        if (dH < 3) this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        if (!fresh && this.lastSensedPos && dH < 1.5) {
          // Oxirgi joyga yetdi, lekin nishon yo'q — hidlaydi
          this.lastSensedAt = -99;
        }
      }
    } else if (this.investigatePos) {
      // Gulxan doirasidagi joy (o'q ovozi, hid, qayta yoqilgan gulxan) chetidan tekshiriladi
      this.investigatePos = this.outsideFear(this.investigatePos);
      const goal = this.investigatePos;
      if (me.state !== 'stalk') this.setState('stalk', t);
      const m = this.followPath(goal, this.speedFor('stalk'), t, dt, this.hasDirectLine(goal));
      wishX = m.wishX;
      wishZ = m.wishZ;
      if (Math.hypot(goal.x - me.pos.x, goal.z - me.pos.z) < 1.5) {
        this.investigatePos = null;
        this.setState('sniff', t, 1.6);
      }
    } else {
      // Sayr: nav-grafning katta komponenti bo'ylab yuradi, gohida to'xtab hid oladi, uvlaydi
      if (t >= this.nextHowlAt) {
        this.nextHowlAt = t + WOLF_HOWL_MIN_SEC + Math.random() * (WOLF_HOWL_MAX_SEC - WOLF_HOWL_MIN_SEC);
        this.setState('howl', t, 3.0);
        this.room.wolfHowl(me);
      } else if (me.state === 'idle' && Math.random() < ROAM_SNIFF_CHANCE * dt) {
        this.setState('sniff', t, 1.6);
      } else {
        if (me.state !== 'idle') this.setState('idle', t);
        if (!this.roamGoal || t - this.roamGoalAt > 25) {
          this.roamGoal = this.room.pickWolfRoamGoal(me);
          this.roamGoalAt = t;
          this.repathAt = 0;
        }
        const m = this.followPath(this.roamGoal, this.speedFor('idle'), t, dt, false);
        wishX = m.wishX;
        wishZ = m.wishZ;
        if (Math.hypot(this.roamGoal.x - me.pos.x, this.roamGoal.z - me.pos.z) < 1.2) this.roamGoal = null;
      }
    }

    if (timed && this.stateUntil > 0 && t >= this.stateUntil && me.state !== 'attack') {
      // Vaqtli holat tugadi — keyingi tickda asosiy mantiq yangi holat tanlaydi
      this.setState(this.target ? 'hunt' : 'idle', t);
    }

    applyWorldMovement(me, wishX, wishZ, false, dt, this.room.world);
    this.checkStuck(t, wishX !== 0 || wishZ !== 0);
  }
}
