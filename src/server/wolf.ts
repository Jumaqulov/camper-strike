import { WALK_SPEED } from '../shared/constants';
import { angleDiff, vcopy, vdist, type Vec3 } from '../shared/math';
import { applyWorldMovement, raycastWorld, type Body } from '../shared/physics';
import { hitboxScaleOf } from '../shared/stance';
import {
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
import type { Room, ServerPlayer } from './room';

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
  /** To'lqin ko'paytuvchilari (wolf_night; boshqa rejimlarda 1): tezlik, jon (WOLF_MAX_HP ga), tishlash zarari. */
  speedMul: number;
  hpMul: number;
  biteMul: number;
  brain: WolfBrain;
}

/** Sezish darajasi: 0 — yo'q, 1 — hid/shubha (joy ma'lum, LOS yo'q), 2 — ko'rdi. */
type SenseLevel = 0 | 1 | 2;

/** Nishon yetib bo'lmas balandlikda (2-qavat, tom) bo'lsa shu oraliqda uvlaydi (s). */
const UNREACHABLE_HOWL_SEC = 9;
/** Sayrda to'xtab hid olish ehtimoli (sekundiga). */
const ROAM_SNIFF_CHANCE = 0.06;
const SENSE_INTERVAL = 0.15;

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
    this.nextAttackAt = t;
    this.nextSenseAt = t;
    this.stuckCount = 0;
    this.stuckPos = vcopy(this.me.pos);
    this.stuckCheckAt = t + 1.5;
    this.nextHowlAt = t + 4 + Math.random() * 10;
    this.setState('idle', t);
  }

  /** Zarba yedi: hujumchi nishonga aylanadi, hujum paytida bo'lmasa qisqa seskanadi. */
  onDamaged(attacker: ServerPlayer | null, t: number): void {
    const me = this.me;
    if (!me.alive) return;
    if (attacker && attacker.alive) {
      this.target = attacker;
      this.lastSensedAt = t;
      this.lastSensedPos = vcopy(attacker.pos);
      this.investigatePos = null;
    }
    if (me.state !== 'attack' && me.state !== 'dead') {
      this.setState('hit', t, WOLF_HIT_FLINCH);
    }
  }

  /** O'q ovozi: nishon bo'lmasa o'sha joyga boradi (hid oladi), bo'lsa izini yangilaydi. */
  onNoise(pos: Vec3, t: number, source: ServerPlayer | null): void {
    const me = this.me;
    if (!me.alive) return;
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

  private isHuntable(p: ServerPlayer): boolean {
    return this.room.isWolfPrey(p);
  }

  private sense(t: number): void {
    const me = this.me;
    let best: ServerPlayer | null = null;
    let bestLevel: SenseLevel = 0;
    let bestD = Infinity;
    for (const p of this.room.players.values()) {
      if (!this.isHuntable(p)) continue;
      const dH = Math.hypot(p.pos.x - me.pos.x, p.pos.z - me.pos.z);
      // Joriy nishon sezgi uchun ustunlikka ega (bir xil darajada yaqinroq bo'lmasa ham ushlab turadi)
      const level = this.senseLevel(p, dH);
      if (level === 0) continue;
      const dEff = p === this.target ? dH * 0.6 : dH;
      if (level > bestLevel || (level === bestLevel && dEff < bestD)) {
        best = p;
        bestLevel = level;
        bestD = dEff;
      }
    }
    this.seenNow = false;
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

  /** Holat tezligi × to'lqin ko'paytuvchisi (wolf_night to'lqinlarida bo'rilar tezlashadi). */
  private speedFor(state: WolfState): number {
    return wolfSpeedForState(state) * (this.me.speedMul || 1);
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
        this.stuckCount = 0;
      }
    } else {
      this.stuckCount = 0;
    }
    this.stuckPos = vcopy(me.pos);
    this.stuckCheckAt = t + 1.2;
  }

  update(dt: number, t: number): void {
    const me = this.me;
    if (!me.alive) return;
    if (this.room.phase !== 'playing') {
      if (me.state !== 'idle') this.setState('idle', t);
      me.targetId = null;
      applyWorldMovement(me, 0, 0, false, dt, this.room.world);
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
    } else if (this.target) {
      const tgt = this.target;
      const dH = Math.hypot(tgt.pos.x - me.pos.x, tgt.pos.z - me.pos.z);
      const dy = tgt.pos.y - me.pos.y;
      const fresh = t - this.lastSensedAt < 1.0;
      const goal = fresh ? tgt.pos : (this.lastSensedPos ?? tgt.pos);
      const unreachable = dy > WOLF_UNREACHABLE_DY && dH < 8;
      if (unreachable) {
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
        Math.abs(angleDiff(me.yaw, Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)))) < 0.7
      ) {
        this.attackStartedAt = t;
        this.biteDone = false;
        this.setState('attack', t, WOLF_ATTACK_DURATION);
      } else {
        const huntState: WolfState = fresh ? 'hunt' : 'stalk';
        if (me.state !== huntState) this.setState(huntState, t);
        const speed = this.speedFor(huntState);
        const direct = this.hasDirectLine(goal);
        const m = this.followPath(goal, speed, t, dt, direct);
        wishX = m.wishX;
        wishZ = m.wishZ;
        // Yaqin masofada nishonga qarab turadi (yo'l tuguniga emas)
        if (dH < 3) this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        if (!fresh && this.lastSensedPos && dH < 1.5) {
          // Oxirgi joyga yetdi, lekin nishon yo'q — hidlaydi
          this.lastSensedAt = -99;
        }
      }
    } else if (this.investigatePos) {
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
