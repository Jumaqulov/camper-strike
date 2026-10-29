import { WALK_SPEED } from '../shared/constants';
import { angleDiff, vcopy, vdist, type Vec3 } from '../shared/math';
import { applyWorldMovement, raycastWorld, type Body } from '../shared/physics';
import { hitboxScaleOf } from '../shared/stance';
import { sampleTerrainHeight } from '../shared/world';
import {
  FEAR_FLINCH_M,
  FEAR_PATH_MARGIN_M,
  FEAR_SOFT_BAND_M,
  WOLF_ALPHA_BUFF_SPEED_MUL,
  WOLF_ATTACK_COOLDOWN,
  WOLF_ATTACK_DURATION,
  WOLF_BITE_AT,
  WOLF_BITE_RANGE,
  WOLF_DAWN_HOWL_SEC,
  WOLF_EYE_HEIGHT,
  WOLF_HEAR_SHOT_RANGE,
  WOLF_HIT_FLINCH,
  WOLF_HOWL_MAX_SEC,
  WOLF_HOWL_MIN_SEC,
  WOLF_LOSE_TARGET_SEC,
  WOLF_RADIUS,
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
/** Halqada turish o'lik zonasi (m): standoff ± shu ichida bo'ri qimirlamaydi (mikro-qadam tebranishi bo'lmasin). */
const RING_DEADBAND_M = 0.4;
/** Halqadan shuncha (m) uzoqda bo'lsa chetiga nav yo'li bilan (olovni aylanib) boradi, yaqinroq — to'g'ri radial. */
const RING_PATH_DIST_M = 3;
/** Maqsad yaqinida yetib keldi deb hisoblanadigan masofa (m): undan yaqin maqsadga qadam bosilmaydi. */
const ARRIVE_M = 0.35;
/** Olov sabab majburiy qayta yo'l topish oralig'i (s) — yo'l tuguni olov ichida qolsa har tick A* ishlamasin. */
const FEAR_REPATH_MIN_SEC = 0.5;
/** Nishon shu masofada (m) bo'lsa og'iz→nishon to'siq tekshiruvi (devor orqali tishlamaslik) yuritiladi. */
export const WOLF_LOS_CHECK_M = 8;
/** To'siq tekshiruvi oralig'i (s) — chiziq ochilsa (nishon eshikdan chiqdi) shuncha vaqt ichida ov davom etadi. */
export const WOLF_LOS_CHECK_SEC = 0.5;
/** Shuncha soniya uzluksiz to'silgan (va nav yo'li ham yetkazmagan) nishon "devor ortida" deb qabul qilinadi. */
export const WOLF_LOS_BLOCKED_SEC = 1.5;
/** Devor ortidagi nishon atrofida aylanish: radius (m), keyingi nuqtaga o'tish oralig'i (s), burchak qadami (rad). */
const WALL_CIRCLE_R = 6;
const WALL_CIRCLE_STEP_SEC = 3;
const WALL_CIRCLE_STEP_RAD = 1.2;
/** Bo'ri tanasi to'qnashuv radiusi (WOLF_RADIUS; o'yinchi radiusi emas). */
const WOLF_MOVE_OPTS = { radius: WOLF_RADIUS };

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
  /** Tong xori: shu vaqtda uvlaydi, uvlab bo'lgach qochadi; null — tong xorida emas. */
  private dawnHowlAt: number | null = null;
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
  /** Olov sabab oxirgi majburiy qayta yo'l topish vaqti. */
  private fearRepathAt = -99;
  /** Hozir qattiq seskanish (olovdan yugurib chiqish) holatidami (hisob uchun chekka aniqlash). */
  private flinching = false;
  /** Qattiq olov seskanishlari soni (radius + 0.5 ichiga tushib yugurib chiqish) — testlar/QA uchun. */
  fearFlinchCount = 0;
  /** Og'iz→nishon to'siq tekshiruvi: bloklanish boshlangan vaqt (0 — chiziq ochiq), keyingi tekshiruv vaqti, nishon. */
  private losBlockedSince = 0;
  private losCheckAt = 0;
  private losTargetId: string | null = null;
  /** Oxirgi tekshiruvda nav yo'li nishonni tishlash joyiga olib keladimi (eshik bor). */
  private losPathReaches = false;
  /** Devor ortidagi nishon atrofida aylanish: joriy maqsad tuguni, tanlangan vaqti, halqa burchagi. */
  private wallGoal: Vec3 | null = null;
  private wallGoalAt = 0;
  private wallAng = 0;
  /** Testlar/QA uchun: hozir nishon devor ortida (yetib bo'lmas) deb hisoblanmoqdami. */
  walled = false;

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
    this.dawnHowlAt = null;
    this.nextAttackAt = t;
    this.nextSenseAt = t;
    this.stuckCount = 0;
    this.stuckPos = vcopy(this.me.pos);
    this.stuckCheckAt = t + 1.5;
    this.nextHowlAt = t + 4 + Math.random() * 10;
    this.order = null;
    this.flankHoldSince = 0;
    this.me.role = null;
    this.losBlockedSince = 0;
    this.losCheckAt = 0;
    this.losTargetId = null;
    this.losPathReaches = false;
    this.wallGoal = null;
    this.walled = false;
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
   * Tong otdi (tong xori): nishon, izlar va to'da buyrug'i tashlanadi; bo'ri `howlAt` gacha joyida turadi ('idle'),
   * keyin WOLF_DAWN_HOWL_SEC uvlaydi ('howl', xona 'wolf:howl' yuboradi) va o'rmonga qochadi (startFlee).
   * Uvlash vaqtlarini xona navbatlab beradi — xor bir zumda emas, ketma-ket. Faza 'ended' bo'lsa ham ishlaydi.
   */
  startDawn(t: number, howlAt: number): void {
    const me = this.me;
    if (!me.alive) return;
    this.target = null;
    this.lastSensedPos = null;
    this.investigatePos = null;
    this.roamGoal = null;
    this.path = [];
    this.pathIdx = 0;
    this.order = null;
    me.role = null;
    me.targetId = null;
    this.dawnHowlAt = Math.max(t, howlAt);
    this.setState('idle', t);
  }

  /** Tong xori: navbati kelguncha joyida turadi, uvlaydi, uvlash tugagach qochishga o'tadi. */
  private updateDawnHowl(dt: number, t: number, howlAt: number): void {
    const me = this.me;
    me.targetId = null;
    if (me.state === 'howl' && t >= this.stateUntil) {
      this.dawnHowlAt = null;
      this.startFlee(t);
      this.updateFlee(dt, t);
      return;
    }
    if (me.state !== 'howl' && t >= howlAt) {
      this.setState('howl', t, WOLF_DAWN_HOWL_SEC);
      this.room.wolfHowl(me);
    }
    applyWorldMovement(me, 0, 0, false, dt, this.room.world, WOLF_MOVE_OPTS);
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

  /**
   * Maqsad tomon istak tezligi; ARRIVE_M ichida — qimirlamaydi (o'lik zona). `turn=false` — yo'nalishni
   * burmaydi (chaqiruvchi nishonga qaratadi; ikki turnTowards bir tickda bir-birini chayqatmasin).
   */
  private moveTowards(goal: Vec3, speed: number, dt: number, turn = true): { wishX: number; wishZ: number; arrived: boolean } {
    const me = this.me;
    const dx = goal.x - me.pos.x;
    const dz = goal.z - me.pos.z;
    const dl = Math.hypot(dx, dz);
    if (dl < ARRIVE_M) return { wishX: 0, wishZ: 0, arrived: true };
    if (turn) this.turnTowards(Math.atan2(-dx, -dz), dt);
    return { wishX: (dx / dl) * speed, wishZ: (dz / dl) * speed, arrived: false };
  }

  /**
   * Nav-graf yo'li bo'ylab (zinaga chiqmaydi); yaqin va ko'rinadigan maqsadga to'g'ri yuradi. `avoidFear` —
   * A* yonib turgan gulxan / mash'al / raketa doiralarini (radius + FEAR_PATH_MARGIN_M) bloklangan tugun deb
   * chetlab o'tadi; yo'l tuguni keyinroq olov ichida qolsa (gulxan qayta yoqildi) qayta yo'l topiladi.
   */
  private followPath(goal: Vec3, speed: number, t: number, dt: number, direct: boolean, avoidFear = true, turn = true): { wishX: number; wishZ: number } {
    const me = this.me;
    if (direct) {
      this.path = [];
      this.pathIdx = 0;
      this.repathAt = 0;
      const m = this.moveTowards(goal, speed, dt, turn);
      return { wishX: m.wishX, wishZ: m.wishZ };
    }
    // Keyingi yo'l tuguni olov ichida (yo'l topilgandan keyin yoqilgan gulxan / yaqinlashgan mash'al): qayta yo'l
    if (avoidFear && t >= this.repathAt - 0.5 && t - this.fearRepathAt >= FEAR_REPATH_MIN_SEC && this.pathIdx < this.path.length - 1) {
      const wp = this.path[this.pathIdx]!;
      if (this.room.fearSourceContaining(wp.x, wp.z, FEAR_PATH_MARGIN_M)) {
        this.repathAt = 0;
        this.fearRepathAt = t;
      }
    }
    // Yo'l bo'sh (topilmagan) bo'lsa har tick qayta A* ishlamaydi — faqat repathAt kelganda
    if (t >= this.repathAt || (this.path.length > 0 && this.pathIdx >= this.path.length)) {
      this.path = this.room.nav.findPath(me.pos, goal, avoidFear ? this.fearBlocked() : undefined);
      this.pathIdx = 0;
      this.repathAt = t + 0.7 + Math.random() * 0.3;
    }
    if (this.path.length === 0) {
      // Yo'l topilmadi — to'g'ri yuramiz (eshik oldi, ochiq joy)
      const m = this.moveTowards(goal, speed, dt, turn);
      return { wishX: m.wishX, wishZ: m.wishZ };
    }
    const node = this.path[this.pathIdx]!;
    const dx = node.x - me.pos.x;
    const dz = node.z - me.pos.z;
    if (Math.hypot(dx, dz) < 0.9) {
      this.pathIdx++;
      if (this.pathIdx >= this.path.length) {
        const m = this.moveTowards(goal, speed, dt, turn);
        return { wishX: m.wishX, wishZ: m.wishZ };
      }
    }
    const m = this.moveTowards(this.path[this.pathIdx]!, speed, dt, turn);
    return { wishX: m.wishX, wishZ: m.wishZ };
  }

  /**
   * A* uchun bloklovchi predikat: nuqta hozir faol olov manbai (radius + FEAR_PATH_MARGIN_M) ichida. Manbalar
   * yo'q bo'lsa undefined (A* oddiy tez yo'l). Manbalar ro'yxati bir marta olinadi, har tugun uchun ≤ bir necha
   * masofa hisobi.
   */
  private fearBlocked(): ((x: number, z: number) => boolean) | undefined {
    const src = this.room.fearSources();
    if (src.length === 0) return undefined;
    return (x, z) => {
      for (const f of src) {
        const r = f.radius + FEAR_PATH_MARGIN_M;
        const dx = x - f.x;
        const dz = z - f.z;
        if (dx * dx + dz * dz <= r * r) return true;
      }
      return false;
    };
  }

  /** Kesma (a→b) faol olov manbai doirasini (radius + FEAR_FLINCH_M) kesib o'tadimi. */
  private segmentCrossesFear(a: Vec3, b: Vec3): boolean {
    const src = this.room.fearSources();
    if (src.length === 0) return false;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    for (const f of src) {
      const r = f.radius + FEAR_FLINCH_M;
      let px = a.x;
      let pz = a.z;
      if (len2 > 1e-9) {
        const u = Math.max(0, Math.min(1, ((f.x - a.x) * dx + (f.z - a.z) * dz) / len2));
        px = a.x + dx * u;
        pz = a.z + dz * u;
      }
      const ex = px - f.x;
      const ez = pz - f.z;
      if (ex * ex + ez * ez < r * r) return true;
    }
    return false;
  }

  /**
   * Olov manbai (yonib turgan gulxan, mash'al ko'targan o'yinchi, raketa) doirasidagi (radius + FEAR_PATH_MARGIN_M)
   * maqsadni doira chetiga — manbaning `standoff` masofasiga — suradi. Maqsad doira chetiga yaqin bo'lsa (masalan,
   * himoyasiz nishon 1 m halqada) o'z yo'nalishi bo'ylab tashqariga (eng yaqin chet nuqta), chuqur ichkarida bo'lsa
   * bo'ri turgan tomonga. Aks holda bo'ri maqsadga yurish bilan olovdan qochish orasida tebranadi.
   */
  private outsideFear(goal: Vec3): Vec3 {
    const fire = this.room.fearSourceContaining(goal.x, goal.z, FEAR_PATH_MARGIN_M);
    if (!fire) return goal;
    const me = this.me;
    let dx = goal.x - fire.x;
    let dz = goal.z - fire.z;
    let dl = Math.hypot(dx, dz);
    if (dl < fire.radius * 0.6) {
      dx = me.pos.x - fire.x;
      dz = me.pos.z - fire.z;
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

  /** Maqsadga to'g'ri chiziq bor (≤ 14 m, to'siqsiz; `avoidFear` — olov doirasini ham kesib o'tmaydi). */
  private hasDirectLine(goal: Vec3, avoidFear = true): boolean {
    const me = this.me;
    const dH = Math.hypot(goal.x - me.pos.x, goal.z - me.pos.z);
    if (dH > 14 || dH < 1e-3) return dH < 1e-3;
    if (Math.abs(goal.y - me.pos.y) > 1.2) return false;
    if (avoidFear && this.segmentCrossesFear(me.pos, goal)) return false;
    const a = { x: me.pos.x, y: me.pos.y + 0.6, z: me.pos.z };
    const dir = { x: (goal.x - me.pos.x) / dH, y: 0, z: (goal.z - me.pos.z) / dH };
    return !raycastWorld(this.room.world, a, dir, dH);
  }

  /**
   * Nav yo'li nishonni tishlash joyiga olib keladimi: yo'l oxiridagi tugun nishondan ≤ 4 m va undan nishonga og'iz
   * chizig'i ochiq (eshik/ochiq tomon). Uy ichidagi nishon uchun eng yaqin tugun devor ortida — yolg'on.
   */
  private pathReaches(tgt: ServerPlayer): boolean {
    const path = this.room.nav.findPath(this.me.pos, tgt.pos, this.fearBlocked());
    const last = path[path.length - 1];
    if (!last) return false;
    if (Math.hypot(last.x - tgt.pos.x, last.z - tgt.pos.z) > 4) return false;
    return this.room.wolfCanReach({ pos: last }, tgt);
  }

  /**
   * Devor ortidagi nishon atrofida aylanish uchun keyingi nuqta: nishon atrofidagi WALL_CIRCLE_R halqada burchak
   * WALL_CIRCLE_STEP_RAD qadam bilan siljiydi, nuqta eng yaqin nav tuguniga (yer sathi, uy tashqarisi) tortiladi;
   * nishonga juda yaqin (uy ichi/devor yoni), bo'ri turgan joy yoki olov doirasidagi tugun o'tkazib yuboriladi.
   */
  private pickWallGoal(tgt: ServerPlayer): Vec3 | null {
    const me = this.me;
    const nav = this.room.nav;
    const terrain = this.room.world.terrain;
    for (let k = 0; k < 6; k++) {
      this.wallAng += WALL_CIRCLE_STEP_RAD;
      const x = tgt.pos.x + Math.cos(this.wallAng) * WALL_CIRCLE_R;
      const z = tgt.pos.z + Math.sin(this.wallAng) * WALL_CIRCLE_R;
      const ni = nav.nearest({ x, y: sampleTerrainHeight(terrain, x, z), z });
      if (ni < 0) continue;
      const c = nav.center(ni);
      if (Math.hypot(c.x - tgt.pos.x, c.z - tgt.pos.z) < 2.5) continue;
      if (Math.hypot(c.x - me.pos.x, c.z - me.pos.z) < 1.5) continue;
      if (this.room.fearSourceContaining(c.x, c.z, FEAR_PATH_MARGIN_M)) continue;
      return c;
    }
    return null;
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
    // Qochishda olovdan qo'rqmaydi — yo'l rejalashtirish ham olov doiralarini hisobga olmaydi
    const m = this.followPath(goal, this.speedFor('flee'), t, dt, this.hasDirectLine(goal, false), false);
    applyWorldMovement(me, m.wishX, m.wishZ, false, dt, this.room.world, WOLF_MOVE_OPTS);
    this.checkStuck(t, m.wishX !== 0 || m.wishZ !== 0);
  }

  update(dt: number, t: number): void {
    const me = this.me;
    if (!me.alive) return;
    this.tNow = t;
    // Tong xori: uvlash navbatini kutadi, uvlaydi, keyin qochadi (faza 'ended' — pastdagi 'idle' tarmog'iga tushmaydi)
    if (this.dawnHowlAt !== null) {
      this.updateDawnHowl(dt, t, this.dawnHowlAt);
      return;
    }
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
      applyWorldMovement(me, 0, 0, false, dt, this.room.world, WOLF_MOVE_OPTS);
      return;
    }

    // Olovdan qo'rqish: yonib turgan gulxan / mash'al ko'targan o'yinchi / raketa doirasi (radius + FEAR_FLINCH_M).
    // Ikki qavat: chuqur (radius + 0.5 dan ichkarida) — qattiq seskanish: alert, tashqariga yugurib chiqadi
    // (mash'al egasi bo'riga yaqinlashsa, bo'ri chekinadi); yumshoq halqa (radius + 0.5 .. + 1.0) — holat va yo'l
    // o'zgarmaydi, faqat istak tezligiga tashqariga silliq surish qo'shiladi (halqada turgan bo'ri sal oshib
    // ketsa yoki yo'l tuguni chetga tegsa seskanib tebranmaydi).
    const burning = this.room.fearSourceContaining(me.pos.x, me.pos.z, FEAR_FLINCH_M);
    let softPush: { ox: number; oz: number; k: number } | null = null;
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
      const depth = burning.radius + FEAR_FLINCH_M - ol;
      if (depth >= FEAR_SOFT_BAND_M) {
        if (!this.flinching) {
          this.flinching = true;
          this.fearFlinchCount++;
        }
        if (me.state !== 'alert') this.setState('alert', t);
        me.targetId = this.target ? this.target.id : null;
        this.path = [];
        this.pathIdx = 0;
        this.repathAt = 0;
        this.turnTowards(Math.atan2(-ox, -oz), dt, 10);
        const sp = this.speedFor('hunt');
        applyWorldMovement(me, ox * sp, oz * sp, false, dt, this.room.world, WOLF_MOVE_OPTS);
        this.checkStuck(t, true);
        return;
      }
      softPush = { ox, oz, k: Math.min(1, Math.max(0, depth / FEAR_SOFT_BAND_M)) };
    }
    this.flinching = false;

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
    if (!this.target) {
      this.walled = false;
      this.losBlockedSince = 0;
      this.wallGoal = null;
    }

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
      // Devor orqali tishlamaslik: nishon yaqin (≤ WOLF_LOS_CHECK_M) bo'lsa har WOLF_LOS_CHECK_SEC da og'izdan
      // ko'kragi va oyog'igacha to'siqsiz chiziq bormi tekshiriladi; WOLF_LOS_BLOCKED_SEC uzluksiz to'silgan va nav
      // yo'li ham tishlash joyiga olib kelmaydigan (eshik yo'q — uy ichida) nishon "devor ortida" (walled):
      // balandlikdagi nishon kabi yetib bo'lmas — devorga yopishib turmaydi, atrofida aylanib uvlaydi. Chiziq
      // ochilsa (eshikdan chiqdi) keyingi tekshiruvda ov davom etadi.
      if (this.losTargetId !== tgt.id) {
        this.losTargetId = tgt.id;
        this.losBlockedSince = 0;
        this.losCheckAt = 0;
        this.losPathReaches = false;
        this.wallGoal = null;
      }
      // Gisterezis: devor ortida deb topilgach aylanish halqasi (WALL_CIRCLE_R + tugun siljishi) tekshiruv
      // masofasidan chiqib ketsa ham holat tashlanmaydi (aks holda aylanish ↔ ov almashinib turadi)
      const losRange = this.walled ? WOLF_LOS_CHECK_M + 6 : WOLF_LOS_CHECK_M;
      if (dH <= losRange) {
        if (t >= this.losCheckAt) {
          this.losCheckAt = t + WOLF_LOS_CHECK_SEC;
          if (this.room.wolfCanReach(me, tgt)) {
            this.losBlockedSince = 0;
            this.losPathReaches = true;
          } else {
            if (this.losBlockedSince === 0) this.losBlockedSince = t;
            this.losPathReaches = this.pathReaches(tgt);
          }
        }
      } else {
        this.losBlockedSince = 0;
        this.losCheckAt = 0;
      }
      const walled = this.losBlockedSince > 0 && t - this.losBlockedSince >= WOLF_LOS_BLOCKED_SEC && !this.losPathReaches;
      if (walled && !this.walled) this.wallAng = Math.atan2(me.pos.z - tgt.pos.z, me.pos.x - tgt.pos.x);
      this.walled = walled;
      if (walled) this.room.pack.reportUnreachable(tgt, t);
      else this.wallGoal = null;
      // Nishon yonib turgan gulxan doirasida yoki o'zi mash'al ko'targan: olovga kirmaydi — chetida
      // (manba `standoff` masofasida) to'xtab qaraydi, uvlaydi. Himoya — xona gisterezisi (kirish radius + 1.0,
      // chiqish radius + 1.6; to'da koordinatori bilan bir xil javob), chetdagi halqada turgan nishon uchun
      // "halqada tur" ↔ "ov qil" almashinuvi bo'lmaydi.
      const fire: FearSource | null = this.room.preyFearSource(tgt);
      if (fire) {
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
        const ux = fx / Math.max(fd, 1e-3);
        const uz = fz / Math.max(fd, 1e-3);
        const stalkSp = this.speedFor('stalk');
        if (sliding) {
          this.path = [];
          this.pathIdx = 0;
          const ringR = t < this.slideWideUntil ? standoff + 3 : standoff;
          const tangential = stalkSp * Math.min(1, 0.3 + Math.abs(slotDA) * 2);
          const sgn = Math.sign(slotDA);
          const radial = Math.max(-stalkSp, Math.min(stalkSp, (ringR - fd) * 2));
          wishX = -Math.sin(myAng) * sgn * tangential + ux * radial;
          wishZ = Math.cos(myAng) * sgn * tangential + uz * radial;
          this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        } else if (fd > standoff + RING_DEADBAND_M) {
          // Olov chetiga yaqinlashadi (markaz tomon, lekin doiraga kirmaydi): uzoqdan nav yo'li bilan (olovni
          // aylanib), yaqinda radial, halqaga yetganda sekinlashib (proporsional tezlik — oshib ketmaydi)
          const ringPt = { x: fire.x + ux * standoff, y: me.pos.y, z: fire.z + uz * standoff };
          if (fd > standoff + RING_PATH_DIST_M) {
            ringPt.y = sampleTerrainHeight(this.room.world.terrain, ringPt.x, ringPt.z);
            const m = this.followPath(ringPt, stalkSp, t, dt, this.hasDirectLine(ringPt), true, false);
            wishX = m.wishX;
            wishZ = m.wishZ;
          } else {
            this.path = [];
            this.pathIdx = 0;
            const sp = Math.min(stalkSp, Math.max(0.4, (fd - standoff) * 2));
            const m = this.moveTowards(ringPt, sp, dt, false);
            wishX = m.wishX;
            wishZ = m.wishZ;
          }
          this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        } else if (fd < standoff - RING_DEADBAND_M) {
          // Juda yaqin — orqaga silliq chekinadi (qanchalik ichkarida, shunchalik tez)
          this.path = [];
          this.pathIdx = 0;
          const sp = Math.min(stalkSp, Math.max(0.4, (standoff - fd) * 2.5));
          wishX = ux * sp;
          wishZ = uz * sp;
        } else if (order?.standoffAngle !== undefined) {
          // O'z halqa o'rnida: turib nishonga qaraydi (to'da o'rab olgan) — qimirlamaydi
          this.path = [];
          this.pathIdx = 0;
        } else if (me.state === 'alert') {
          // Chetida aylanib yuradi (soat yo'nalishida, sekin), radiusni halqada ushlab
          this.path = [];
          this.pathIdx = 0;
          const sp = this.speedFor('idle') * 0.6;
          const radial = Math.max(-sp, Math.min(sp, (standoff - fd) * 2));
          wishX = -uz * sp + ux * radial;
          wishZ = ux * sp + uz * radial;
        }
      } else if (walled) {
        // Nishon devor ortida (uy ichida, eshik yo'q): devorga yopishib turmaydi — atrofidagi (WALL_CIRCLE_R) nav
        // tugunlari bo'ylab aylanadi, nishonga qarab turadi, vaqti-vaqti bilan uvlaydi
        if (t >= this.nextHowlAt) {
          this.nextHowlAt = t + UNREACHABLE_HOWL_SEC;
          this.setState('howl', t, 3.0);
          this.room.wolfHowl(me);
        } else if (me.state !== 'alert' && me.state !== 'howl') {
          this.setState('alert', t);
        }
        if (
          !this.wallGoal ||
          t - this.wallGoalAt > WALL_CIRCLE_STEP_SEC ||
          Math.hypot(this.wallGoal.x - me.pos.x, this.wallGoal.z - me.pos.z) < 1.2
        ) {
          this.wallGoal = this.pickWallGoal(tgt);
          this.wallGoalAt = t;
          this.repathAt = 0;
        }
        // Uzoqdagi nuqtaga yurganda yo'nalish bo'ylab qaraydi, yaqinlashganda nishonga
        const far = !!this.wallGoal && Math.hypot(this.wallGoal.x - me.pos.x, this.wallGoal.z - me.pos.z) > 2;
        if (this.wallGoal) {
          const m = this.followPath(this.wallGoal, this.speedFor('stalk'), t, dt, this.hasDirectLine(this.wallGoal), true, far);
          wishX = m.wishX;
          wishZ = m.wishZ;
        }
        if (!far) this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
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
        Math.abs(angleDiff(me.yaw, Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)))) < 0.7 &&
        // Orada devor/tokcha bo'lsa tashlanmaydi (og'izdan ko'krak va oyoqqa to'siqsiz chiziq)
        this.room.wolfCanReach(me, tgt)
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
          // Maqsad hech qachon olov doirasi (radius + FEAR_PATH_MARGIN_M) ichida bo'lmaydi: himoyasiz nishon
          // chetdagi halqada tursa — unga eng yaqin chet nuqtaga boradi (tishlash masofasida)
          moveGoal = this.outsideFear(moveGoal);
          const speed = this.speedFor(huntState);
          const direct = this.hasDirectLine(moveGoal);
          const near = dH < 3;
          const m = this.followPath(moveGoal, speed, t, dt, direct, true, !near);
          wishX = m.wishX;
          wishZ = m.wishZ;
          // Yaqin masofada nishonga qarab turadi (yo'l tuguniga emas)
          if (near) this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        }
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
      // Vaqtli holat tugadi — keyingi tickda asosiy mantiq yangi holat tanlaydi (nishon olov himoyasida bo'lsa
      // to'g'ridan-to'g'ri 'alert': uvlashdan keyin 'hunt' ga sakrab yana 'alert' ga qaytmasin)
      const next: WolfState = this.target ? (this.room.preyFearSource(this.target) ? 'alert' : 'hunt') : 'idle';
      this.setState(next, t);
    }

    if (softPush && me.state !== 'attack') {
      // Yumshoq olov halqasi: ichkariga yo'nalgan istak olib tashlanadi, tashqariga proporsional surish qo'shiladi
      const inward = -(wishX * softPush.ox + wishZ * softPush.oz);
      if (inward > 0) {
        wishX += softPush.ox * inward;
        wishZ += softPush.oz * inward;
      }
      const sp = this.speedFor('stalk') * softPush.k;
      wishX += softPush.ox * sp;
      wishZ += softPush.oz * sp;
    }

    applyWorldMovement(me, wishX, wishZ, false, dt, this.room.world, WOLF_MOVE_OPTS);
    this.checkStuck(t, wishX !== 0 || wishZ !== 0);
  }
}
