import { WALK_SPEED } from '../shared/constants';
import { angleDiff, vcopy, vdist, type Vec3 } from '../shared/math';
import { applyWorldMovement, collidesAtWorld, raycastWorld, type Body } from '../shared/physics';
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
  WOLF_WALK_SPEED,
  wolfSpeedForState,
  type WolfState,
} from '../shared/wolf';
import type { FearSource, Room, ServerPlayer } from './room';
import {
  WOLF_DRIVER_FEINT_M,
  WOLF_DRIVER_LUNGE_M,
  WOLF_FLANK_ENGAGE_M,
  WOLF_FLANK_HOLD_MAX_SEC,
  WOLF_FLANK_LATE_SEC,
  WOLF_FLANK_NEAR_EXTRA_M,
  WOLF_FLANK_REAR_DEG,
  WOLF_FLANK_STALK_M,
  WOLF_FLANK_SWING_M,
  WOLF_FLANK_SWING_MAX_SEC,
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
/** Halqa o'rniga yo'l bilan borishda tiqilsa (o'rin yetib bo'lmas) shuncha soniya halqa bo'ylab oddiy siljishga qaytadi. */
const RING_SLOT_GIVE_UP_SEC = 5;
/** Halqa bo'ylab siljish kengroq radiusda ham to'silsa (o'rin burchagiga yetib bo'lmaydi) shuncha (s) joyida turadi. */
const RING_SLIDE_HOLD_SEC = 3;
/**
 * Davriy qayta yo'l topish (keepPath): maqsad oxirgi A* maqsadidan PATH_KEEP_GOAL_M (m) ichida va yo'lda tugun
 * qolgan bo'lsa yangi yo'l faqat eski yo'lning qolganidan PATH_KEEP_GAIN_M (m) qisqa bo'lsa olinadi.
 */
const PATH_KEEP_GOAL_M = 1;
const PATH_KEEP_GAIN_M = 0.5;
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
/** Qanot orqa sektori (rad): nishon→haydovchi yo'nalishidan shundan ko'p burilgan. */
const FLANK_REAR_RAD = (WOLF_FLANK_REAR_DEG * Math.PI) / 180;
/** Qanot o'z nuqtasi burchagiga shuncha (rad) yetmagan bo'lsa ham qanot maydonida deb hisoblanadi. */
const FLANK_AREA_TOL_RAD = (15 * Math.PI) / 180;
/** Qanot nuqtasi nishon atrofida shundan (rad) yaqin burchakda bo'lsa to'g'ri boradi, uzoq — kengroq doirada aylanadi. */
const FLANK_SWING_DIRECT_RAD = (40 * Math.PI) / 180;
/** Aylanib o'tishdagi oraliq nuqta qanot burchagidan shuncha (rad) oldinda. */
const FLANK_SWING_LEAD_RAD = (45 * Math.PI) / 180;
/** Oraliq nuqta qayta hisoblanish oralig'i (s). */
const FLANK_SWING_REEVAL_SEC = 0.25;
/** Haydovchi chalg'itishda shu oraliqda (s) aldab tashlanadi va tashlanish shuncha (s) davom etadi. */
const FEINT_LUNGE_EVERY_SEC = 1.8;
const FEINT_LUNGE_SEC = 0.5;
/** Tiqilgandan keyin bo'sh yo'nalish bo'ylab sirpanish davomiyligi (s). */
const SLIP_SEC = 0.8;
/** Istak bor-u tezlik deyarli nol bo'lsa shuncha (s) o'tib sirpanish boshlanadi. */
const SNAG_SEC = 0.25;
/**
 * Sirpanishda tana harakat tomoniga shu tezlikda (rad/s) buriladi — shu tickda maqsad/nishonga burilishdan (6–8)
 * kuchliroq, ~0.3 s ichida orqaga qaragan bo'ri ham sirpanish tomoniga o'giriladi.
 */
const SLIP_TURN_RATE = 20;

/**
 * Bo'ri sun'iy intellekti: sayr → hid/tovush bo'yicha tekshirish → ov (yugurib quvish) → tashlanib tishlash.
 * Bo'ri zinaga chiqmaydi: nav-graf faqat yer sathi, yaqin masofada to'g'ri chiziq bilan yuradi (eshikdan
 * kiradi, lekin loft/tomga chiqolmaydi — nishon balandda bo'lsa pastda aylanib uvlaydi).
 */
export class WolfBrain {
  private path: Vec3[] = [];
  private pathIdx = 0;
  private repathAt = 0;
  /** Joriy yo'l topilgan A* maqsadi (keepPath: maqsad o'zgarmagan bo'lsa davriy qayta yo'l topilmaydi). */
  private pathGoal: { x: number; z: number } | null = null;
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
  /**
   * Tiqilib qoldi: shu vaqtgacha "to'g'ri chiziq bor" deb to'g'ri yurilmaydi, nav yo'li bilan aylanib o'tadi
   * (hasDirectLine bitta nur — past to'nka/tosh ustidan o'tadi, tana esa unga tiraladi).
   */
  private noDirectUntil = 0;
  /**
   * Harakat daraxt/quti burchagiga tiralsa (o'qlar bo'yicha fizika ikkala o'qni ham to'xtatadi): shu vaqtgacha
   * istak tezligi bo'sh yo'nalishga (o'q yoki yon qadam, birlik vektor) buriladi — bo'ri to'siqdan sirpanib chiqadi.
   */
  private slipUntil = 0;
  private slipDir: { x: number; z: number } | null = null;
  private slipSide = 1;
  /** Istak bor, lekin bo'ri joyidan siljimayapti — shu vaqt (s) davom etmoqda. */
  private snagSec = 0;
  /** Oxirgi nolmas istak tezligi (tiqilganda sirpanish yo'nalishini tanlash uchun). */
  private lastWishX = 0;
  private lastWishZ = 0;
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
  /** Qanot hujumga o'tdi (orqadan tashlanmoqda) — qaror shu nishon va vazifa uchun qaytmaydi. */
  private flankEngaged = false;
  /** Qanot nishon yaqiniga (aylanib o'tish doirasiga) birinchi kelgan vaqt (0 — hali uzoqda): kechikish shundan. */
  private flankNearAt = 0;
  /** Qanotning aylanib o'tish oraliq nuqtasi (null — qanot nuqtasiga to'g'ri) va hisoblangan vaqti. */
  private swingGoal: Vec3 | null = null;
  private swingGoalAt = -99;
  /** Haydovchi chalg'itishdagi navbatdagi aldab tashlanish vaqti (0 — chalg'itmayapti). */
  private feintLungeAt = 0;
  private lastPackHowlAt = -99;
  /** Olov halqasi bo'ylab siljish: oxirgi tekshiruvdagi burchak/vaqt, to'silganda kengroq radius muddati. */
  private slideAngPrev = 0;
  private slideCheckAt = 0;
  private slideWideUntil = 0;
  /** Kengroq radiusda ham to'silgan siljish: shu vaqtgacha joyida turib nishonga qaraydi (devorga tiralmaydi). */
  private slideHoldUntil = 0;
  /** Halqa o'rniga nav yo'li bilan borish shu vaqtgacha to'xtatilgan (o'rin tomon yo'lda tiqildi) va oxirgi borilgan vaqt. */
  private slotGiveUpUntil = 0;
  private slotPathAt = -99;
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
    this.noDirectUntil = 0;
    this.slipUntil = 0;
    this.slipDir = null;
    this.snagSec = 0;
    this.stuckPos = vcopy(this.me.pos);
    this.stuckCheckAt = t + 1.5;
    this.nextHowlAt = t + 4 + Math.random() * 10;
    this.order = null;
    this.flankHoldSince = 0;
    this.flankEngaged = false;
    this.flankNearAt = 0;
    this.swingGoal = null;
    this.swingGoalAt = -99;
    this.feintLungeAt = 0;
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
      this.flankEngaged = false;
      this.flankNearAt = 0;
      this.swingGoal = null;
      this.swingGoalAt = -99;
      this.feintLungeAt = 0;
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
    // Qochish yangidan boshlanadi: joyida uvlash (tong xori) yoki ov oxirida to'siqqa tiralgan istak tiqilish deb
    // hisoblanmaydi va eski istak bo'yicha sirpanish boshlanmaydi
    this.stuckPos = vcopy(me.pos);
    this.stuckCheckAt = t + 1.2;
    this.stuckCount = 0;
    this.slipDir = null;
    this.slipUntil = 0;
    this.snagSec = 0;
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
      if (this.target !== attacker) {
        // Boshqa nishonga o'tdi — oldingi nishondagi qanot/chalg'itish holati tashlanadi
        this.flankHoldSince = 0;
        this.flankEngaged = false;
        this.flankNearAt = 0;
        this.swingGoal = null;
        this.feintLungeAt = 0;
      }
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
   * chetlab o'tadi; yo'l tuguni keyinroq olov ichida qolsa (gulxan qayta yoqildi) qayta yo'l topiladi. `keepPath` —
   * qo'zg'almas maqsad: davriy qayta topishda maqsad oxirgi A* maqsadidan PATH_KEEP_GOAL_M ichida va yo'lda tugun
   * qolgan bo'lsa yangi yo'l faqat sezilarli qisqa bo'lsa olinadi (A* boshlang'ich tuguni ikki qo'shni tugun orasida
   * almashib, har qayta topishda yo'l teskari tomonga burilmasin — bo'ri ikki yo'l orasida borib-kelib qolmasin;
   * yurgan sari qisqaroq yo'l ochilsa — o'tadi); majburiy qayta topish (repathAt = 0: tiqilish, olov) va tugagan
   * yo'l — odatdagidek.
   */
  private followPath(
    goal: Vec3,
    speed: number,
    t: number,
    dt: number,
    direct: boolean,
    avoidFear = true,
    turn = true,
    keepPath = false,
  ): { wishX: number; wishZ: number } {
    const me = this.me;
    if (direct && t >= this.noDirectUntil) {
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
    const left = this.pathIdx < this.path.length;
    if (t >= this.repathAt || (this.path.length > 0 && !left)) {
      const path = this.room.nav.findPath(me.pos, goal, avoidFear ? this.fearBlocked() : undefined);
      const pg = this.pathGoal;
      // keepPath: maqsad joyida, eski yo'l davom etmoqda — yangisi sezilarli qisqa bo'lsagina almashadi
      const keep =
        keepPath &&
        left &&
        this.repathAt > 0 &&
        path.length > 0 &&
        !!pg &&
        Math.hypot(goal.x - pg.x, goal.z - pg.z) < PATH_KEEP_GOAL_M &&
        this.pathLength(path, 0, goal) > this.pathLength(this.path, this.pathIdx, goal) - PATH_KEEP_GAIN_M;
      if (!keep) {
        this.path = path;
        this.pathIdx = 0;
        this.pathGoal = { x: goal.x, z: goal.z };
      }
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

  /** Yo'l uzunligi (XZ, m): bo'ridan `from`-tugungacha, tugunlar bo'ylab va oxirgi tugundan maqsadgacha. */
  private pathLength(path: Vec3[], from: number, goal: Vec3): number {
    let px = this.me.pos.x;
    let pz = this.me.pos.z;
    let len = 0;
    for (let i = from; i < path.length; i++) {
      const n = path[i]!;
      len += Math.hypot(n.x - px, n.z - pz);
      px = n.x;
      pz = n.z;
    }
    return len + Math.hypot(goal.x - px, goal.z - pz);
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

  /**
   * Qanotning aylanib o'tish maqsadi: qanot nuqtasi nishon atrofida FLANK_SWING_DIRECT_RAD dan uzoq burchakda
   * bo'lsa — WOLF_FLANK_SWING_M doiradagi, qanot turgan burchakdan nuqta tomonga FLANK_SWING_LEAD_RAD oldindagi
   * oraliq nuqta (qanot old tomondan, haydovchi yonidan nishonga kesib o'tmaydi — kengroq aylanadi); yaqin
   * burchakda yoki oraliq nuqta nav-grafdan tashqarida bo'lsa — qanot nuqtasining o'zi.
   */
  private flankSwingGoal(tgt: ServerPlayer, flankGoal: Vec3, t: number): Vec3 {
    if (t - this.swingGoalAt < FLANK_SWING_REEVAL_SEC) return this.swingGoal ?? flankGoal;
    const me = this.me;
    const aMe = Math.atan2(me.pos.z - tgt.pos.z, me.pos.x - tgt.pos.x);
    const dA = angleDiff(aMe, Math.atan2(flankGoal.z - tgt.pos.z, flankGoal.x - tgt.pos.x));
    let goal: Vec3 | null = null;
    if (Math.abs(dA) > FLANK_SWING_DIRECT_RAD) {
      const a = aMe + Math.sign(dA) * Math.min(Math.abs(dA), FLANK_SWING_LEAD_RAD);
      const x = tgt.pos.x + Math.cos(a) * WOLF_FLANK_SWING_M;
      const z = tgt.pos.z + Math.sin(a) * WOLF_FLANK_SWING_M;
      const pt = { x, y: sampleTerrainHeight(this.room.world.terrain, x, z), z };
      const ni = this.room.nav.nearest(pt);
      if (ni >= 0) {
        const c = this.room.nav.center(ni);
        if (Math.hypot(c.x - x, c.z - z) <= 3) goal = this.outsideFear(pt);
      }
    }
    this.swingGoal = goal;
    this.swingGoalAt = t;
    return goal ?? flankGoal;
  }

  /** Haydovchi chalg'itishda aldab tashlanish payti: har FEINT_LUNGE_EVERY_SEC da FEINT_LUNGE_SEC davomida. */
  private feintLunge(t: number): boolean {
    if (this.feintLungeAt === 0 || t >= this.feintLungeAt + FEINT_LUNGE_SEC) this.feintLungeAt = t + FEINT_LUNGE_EVERY_SEC;
    return t >= this.feintLungeAt;
  }

  /**
   * Tiqilganda sirpanish yo'nalishi (birlik vektor): avval istakning o'qlari — kichik komponent o'qi oldin (katta
   * komponent bo'ylab to'siqqa tiralgan bo'lishi ehtimoli ko'p), o'q istakning kamida chorak qismini olib borsin;
   * bo'lmasa (to'siqqa deyarli tik tiralgan) — istakka tik chap/o'ng yon qadam. Yo'nalish bo'ylab qisqa qadam
   * (oyoqdan baland — mayda relyef hisobga olinmaydi) to'siqsiz bo'lishi kerak; topilmasa null.
   */
  private freeSlipDir(): { x: number; z: number } | null {
    const me = this.me;
    const wx = this.lastWishX;
    const wz = this.lastWishZ;
    const wl = Math.hypot(wx, wz);
    if (wl < 1e-6) return null;
    const free = (d: { x: number; z: number }) =>
      !collidesAtWorld(this.room.world, me.pos.x + d.x * 0.5, me.pos.y + 0.3, me.pos.z + d.z * 0.5, WOLF_RADIUS, 0.8);
    const cands: { x: number; z: number }[] = [];
    const ax = { x: Math.sign(wx), z: 0 };
    const az = { x: 0, z: Math.sign(wz) };
    const axes = Math.abs(wx) < Math.abs(wz) ? [[ax, wx], [az, wz]] : [[az, wz], [ax, wx]];
    for (const [d, comp] of axes as [{ x: number; z: number }, number][]) if (Math.abs(comp) >= wl * 0.25) cands.push(d);
    // Yon qadam tomoni har safar almashadi (bir tomonda yana tiralsa, keyingisida narigi tomonga)
    this.slipSide = -this.slipSide;
    const side = this.slipSide;
    cands.push({ x: (-wz / wl) * side, z: (wx / wl) * side }, { x: (wz / wl) * side, z: (-wx / wl) * side });
    // Aylanib o'tayotgan qanot nishon tomonga sirg'almaydi (daraxtni ichkaridan aylanib, old tomondan nishon
    // yonidan kesib o'tib qolmasin): avval aylanish tomoniga (doira bo'ylab) va nishondan tashqariga, keyin
    // qolganlari; istakka teskarilari (ichkariga yugurib to'siqqa tiralgan qanot uchun "tashqariga" — ortga qaytish,
    // keyin yana o'sha to'siqqa) yon qadamlardan keyin, nishon tomonga qaraganlari eng oxirida (tartib barqaror)
    const tgt = this.target;
    const goal = this.order?.flankGoal;
    if (tgt && goal && this.order?.role === 'flanker' && this.order.targetId === tgt.id && !this.flankEngaged) {
      const rx = me.pos.x - tgt.pos.x;
      const rz = me.pos.z - tgt.pos.z;
      const rl = Math.hypot(rx, rz) || 1;
      const ux = rx / rl;
      const uz = rz / rl;
      const dA = angleDiff(Math.atan2(rz, rx), Math.atan2(goal.z - tgt.pos.z, goal.x - tgt.pos.x));
      const sg = dA >= 0 ? 1 : -1;
      cands.unshift({ x: -uz * sg, z: ux * sg }, { x: ux, z: uz });
      const rank = (d: { x: number; z: number }) =>
        -(d.x * ux + d.z * uz) > 0.5 ? 2 : (d.x * wx + d.z * wz) / wl < -0.3 ? 1 : 0;
      cands.sort((a, b) => rank(a) - rank(b));
    }
    for (const d of cands) if (free(d)) return d;
    return null;
  }

  /** Tiqilish/tiralish: to'g'ri yurish bir muddat taqiqlanadi (nav yo'li), bo'sh yo'nalish bo'lsa — u bo'ylab sirpanish. */
  private startSlip(t: number): void {
    this.repathAt = 0;
    this.noDirectUntil = t + 2;
    this.slipDir = this.freeSlipDir();
    this.slipUntil = this.slipDir ? t + SLIP_SEC : 0;
    this.snagSec = 0;
  }

  private checkStuck(t: number, wishing: boolean): void {
    const me = this.me;
    if (t < this.stuckCheckAt) return;
    const moved = Math.hypot(me.pos.x - this.stuckPos.x, me.pos.z - this.stuckPos.z);
    if (wishing && moved < 0.5) {
      this.stuckCount++;
      this.startSlip(t);
      if (this.stuckCount >= 3) {
        // Geometriyaga tiqildi: eng yaqin nav katagiga (≤3 m) qaytaramiz, nishonni/maqsadni tashlaymiz. Olovdan
        // tashqarida tiqilgan bo'ri olov doirasining qattiq seskanish qavatidagi katakka ko'chirilmaydi (mash'alchi
        // yonida tiqilib, olovga ko'chib, seskanib qochib, yana qaytib kelmasin); seskanib qochayotganda devorga
        // qisilib qolgan bo'ri esa ko'chiriladi; qochayotgan (tong) bo'ri olovdan qo'rqmaydi
        const nav = this.room.nav;
        const ni = nav.nearest(me.pos);
        if (ni >= 0) {
          const c = nav.center(ni);
          const burns =
            me.state !== 'flee' && !this.flinching && !!this.room.fearSourceContaining(c.x, c.z, FEAR_FLINCH_M - FEAR_SOFT_BAND_M);
          if (Math.hypot(c.x - me.pos.x, c.z - me.pos.z) < 3 && !burns) {
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
    // Ovdagidek: daraxt/quti burchagiga tiralsa sirpanib chiqadi (joyida qotib, o'rmonga yugurish o'rniga o'chib
    // ketmaydi)
    this.moveWithSlip(m.wishX, m.wishZ, dt, t, true);
  }

  /**
   * Istak tezligi bilan yurish (ov va qochish uchun umumiy dum): `slipOk` bo'lsa to'siqqa tiralgandagi sirpanish
   * (slipDir) qo'llanadi va burchakka tiralish (SNAG_SEC) sirpanishni boshlaydi; keyin tiqilish tekshiruvi.
   * `slipOk = false` — tishlash yoki yumshoq olov halqasi (istak olovdan tashqariga surilgan).
   */
  private moveWithSlip(wishX: number, wishZ: number, dt: number, t: number, slipOk: boolean): void {
    const me = this.me;
    const wishSp = Math.hypot(wishX, wishZ);
    if (wishSp > 0) {
      this.lastWishX = wishX;
      this.lastWishZ = wishZ;
      if (slipOk && this.slipDir && t < this.slipUntil) {
        // To'siqqa tiralgan edi: istak bo'sh yo'nalishga buriladi (to'liq tezlik bilan sirpanib chiqadi). Tana ham
        // shu tomonga buriladi (SLIP_TURN_RATE — shu tickdagi maqsad/nishonga burilishdan kuchliroq): aks holda
        // bo'ri orqasi yoki yoni bilan to'liq tezlikda chopib ketadi (mijoz oldinga yugurish klipini qo'yadi)
        wishX = this.slipDir.x * wishSp;
        wishZ = this.slipDir.z * wishSp;
        this.turnTowards(Math.atan2(-this.slipDir.x, -this.slipDir.z), dt, SLIP_TURN_RATE);
      }
    }
    applyWorldMovement(me, wishX, wishZ, false, dt, this.room.world, WOLF_MOVE_OPTS);
    // Burchakka tiralish: istak bor, tezlik esa deyarli nol (to'siq ikkala o'qni to'xtatdi) — SNAG_SEC dan keyin
    // darhol sirpanadi (checkStuck ning 1.2 s tekshiruvini kutmaydi)
    if (slipOk && wishSp > 1 && Math.hypot(me.vel.x, me.vel.z) < wishSp * 0.15) {
      this.snagSec += dt;
      if (this.snagSec >= SNAG_SEC && t >= this.slipUntil) this.startSlip(t);
    } else {
      this.snagSec = 0;
    }
    this.checkStuck(t, wishX !== 0 || wishZ !== 0);
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
      // Qanot hujum qarori va yaqinlashish vaqti faqat qanot vazifasida saqlanadi (haydovchiga aylansa / buyruq
      // yo'q — tashlanadi)
      if (order?.role !== 'flanker') {
        this.flankEngaged = false;
        this.flankNearAt = 0;
      }
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
        // Olovdan chiqsa to'da qaytadan chalg'itib aylanadi — qanot hujum qarori tashlanadi
        this.flankEngaged = false;
        this.flankNearAt = 0;
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
        // Halqa radiusi: to'da o'rni bezak (panjara, g'aram) to'sgan joyda bo'lsa kengroq (standoffR)
        const standoff = order?.standoffR ?? fire.standoff;
        // To'da halqa o'rni: o'z burchagiga halqa bo'ylab siljish kerakmi
        const myAng = Math.atan2(fz, fx);
        const slotDA = order?.standoffAngle !== undefined ? angleDiff(myAng, order.standoffAngle) : 0;
        // O'rin nuqtasi uzoqda (halqaning narigi tomoni, kulba/panjara ortida): halqa bo'ylab sirpanmaydi (bezakka
        // tiqiladi) — olov va bezaklarni hisobga olgan nav yo'li bilan boradi; yaqinida — oddiy siljish/turish.
        // O'rin nuqtasining o'zi to'silgan (mash'alchi devor yoniga yurib keldi) yoki unga yo'lda tiqilgan bo'lsa
        // (RING_SLOT_GIVE_UP_SEC) yo'l bilan bormaydi — halqa bo'ylab siljiydi, to'silsa kengroq radiusda turadi
        // (devorga tiralib qolib, mash'al doirasi ichidagi nav tuguniga ko'chirilmasin)
        let slotPt: Vec3 | null = null;
        if (order?.standoffAngle !== undefined) {
          if (this.stuckCount >= 2 && t - this.slotPathAt < 0.25) this.slotGiveUpUntil = t + RING_SLOT_GIVE_UP_SEC;
          const sx = fire.x + Math.cos(order.standoffAngle) * standoff;
          const sz = fire.z + Math.sin(order.standoffAngle) * standoff;
          if (t >= this.slotGiveUpUntil && Math.hypot(sx - me.pos.x, sz - me.pos.z) > RING_PATH_DIST_M) {
            const sy = sampleTerrainHeight(this.room.world.terrain, sx, sz);
            if (!collidesAtWorld(this.room.world, sx, sy + 0.05, sz, WOLF_RADIUS + 0.15, 1.0)) slotPt = { x: sx, y: sy, z: sz };
          }
        }
        if (slotPt) this.slotPathAt = t;
        const sliding = !slotPt && order?.standoffAngle !== undefined && Math.abs(slotDA) > 0.12 && fd < standoff + 6;
        if (!sliding) this.slideHoldUntil = 0;
        if (!sliding || t < this.slideHoldUntil) {
          // Siljimayapti yoki joyida kutmoqda: tekshiruv to'xtaydi (kutish tugagach yana siljib ko'radi)
          this.slideAngPrev = myAng;
          this.slideCheckAt = t + 1.2;
        } else if (t >= this.slideCheckAt) {
          // Halqa bo'ylab siljish to'sildi (burchak o'zgarmadi): bir muddat kengroq radiusda aylanib o'tadi. Kengroq
          // radiusda ham to'silgan bo'lsa o'rin burchagiga yetib bo'lmaydi (devor, xarita cheti): RING_SLIDE_HOLD_SEC
          // joyida turadi — devorga tiralib turmaydi, tiqilish tekshiruvi uni nav tuguniga ko'chirmaydi; keyin
          // kengroq radiusda yana urinib ko'radi (mash'alchi siljigan / o'rin almashgan bo'lishi mumkin)
          if (Math.abs(angleDiff(this.slideAngPrev, myAng)) < 0.06) {
            if (t < this.slideWideUntil) {
              this.slideHoldUntil = t + RING_SLIDE_HOLD_SEC;
              this.slideWideUntil = this.slideHoldUntil + 2.5;
            } else {
              this.slideWideUntil = t + 2.5;
            }
          }
          this.slideAngPrev = myAng;
          this.slideCheckAt = t + 1.2;
        }
        const ux = fx / Math.max(fd, 1e-3);
        const uz = fz / Math.max(fd, 1e-3);
        const stalkSp = this.speedFor('stalk');
        if (slotPt) {
          // Uzoqda yo'nalish bo'ylab qaraydi, o'rniga yaqinlashganda — nishonga
          const far = Math.hypot(slotPt.x - me.pos.x, slotPt.z - me.pos.z) > RING_PATH_DIST_M * 2;
          // O'rin nuqtasi qo'zg'almas — davriy qayta topishda yo'l faqat sezilarli qisqarsa almashadi (keepPath)
          const m = this.followPath(slotPt, stalkSp, t, dt, this.hasDirectLine(slotPt), true, false, true);
          wishX = m.wishX;
          wishZ = m.wishZ;
          if (far && (wishX !== 0 || wishZ !== 0)) this.turnTowards(Math.atan2(-wishX, -wishZ), dt, 10);
          else this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        } else if (sliding && t < this.slideHoldUntil) {
          // O'rin burchagiga halqa bo'ylab yetib bo'lmaydi: joyida turib nishonga qaraydi (istak yo'q)
          this.path = [];
          this.pathIdx = 0;
          this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        } else if (sliding) {
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
        let feint = false;
        if (fresh && order?.role === 'flanker' && order.flankGoal) {
          // Qanot: kengroq doira bo'ylab o'z tomonidan aylanib (old tomondan kesib o'tmaydi) qanot nuqtasiga
          // yuguradi, u yerda poylab kutadi. Orqa sektorda (nishon→haydovchi yo'nalishidan > 90°, ≤ 11 m) nishon
          // orqa o'girgan yoki to'da hujumga o'tgan bo'lsa tashlanadi; kutish (≤ 4 s) va kechikish cheklangan —
          // hujumdan 3 s va o'zi nishon yaqiniga kelganidan 6 s o'tib ham orqaga yetmasa turgan joyidan tashlanadi
          // (hujum boshlangandan keyin qo'shilgan qanot ham avval aylanib oladi). Zarba yegan qanot (qasos) orqa
          // sektorda bo'lsa to'da hujumini kutmay tashlanadi, hali aylanmagan bo'lsa — aylanishda davom etadi (o'q
          // uzib qanotni oldga chaqirib bo'lmaydi). Tashlangach qaror qaytmaydi.
          if (this.flankNearAt === 0 && dH <= WOLF_FLANK_SWING_M + WOLF_FLANK_NEAR_EXTRA_M) this.flankNearAt = t;
          if (!this.flankEngaged) {
            // Qanot maydoni: orqa sektor va o'z nuqtasi burchagigacha FLANK_AREA_TOL_RAD qolgan (yon tomondan emas,
            // haqiqatan orqadan tashlansin)
            const myRel = Math.abs(angleDiff(order.driverAng, Math.atan2(me.pos.z - tgt.pos.z, me.pos.x - tgt.pos.x)));
            const goalRel = Math.abs(angleDiff(order.driverAng, Math.atan2(order.flankGoal.z - tgt.pos.z, order.flankGoal.x - tgt.pos.x)));
            const rear = dH < WOLF_FLANK_ENGAGE_M && myRel >= Math.max(FLANK_REAR_RAD, goalRel - FLANK_AREA_TOL_RAD);
            const facingAway = preyFacingDot(tgt.yaw, tgt.pos, me.pos) < 0;
            const waited = this.flankHoldSince > 0 && t - this.flankHoldSince > WOLF_FLANK_HOLD_MAX_SEC;
            const late =
              order.commit &&
              t - order.commitAt > WOLF_FLANK_LATE_SEC &&
              this.flankNearAt > 0 &&
              t - this.flankNearAt > WOLF_FLANK_SWING_MAX_SEC;
            if ((rear && (order.commit || facingAway || order.retaliate)) || waited || late) this.flankEngaged = true;
          }
          if (!this.flankEngaged) {
            const flankGoal = this.outsideFear(order.flankGoal);
            const dGoal = Math.hypot(flankGoal.x - me.pos.x, flankGoal.z - me.pos.z);
            moveGoal = this.flankSwingGoal(tgt, flankGoal, t);
            huntState = dGoal > WOLF_FLANK_STALK_M ? 'hunt' : 'stalk';
            if (dGoal < 1.2 || (this.flankHoldSince > 0 && dGoal < 2.5)) {
              hold = true;
              huntState = 'stalk';
              if (this.flankHoldSince === 0) this.flankHoldSince = t;
            } else {
              this.flankHoldSince = 0;
            }
          }
        } else if (fresh && order?.role === 'driver' && !order.commit && !order.retaliate && dH <= WOLF_DRIVER_FEINT_M + 1.5) {
          // Haydovchi chalg'itadi (qanotlar orqaga aylanguncha): nishon oldida WOLF_DRIVER_FEINT_M da irillab
          // (stalk) unga qarab turadi, vaqti-vaqti bilan WOLF_DRIVER_LUNGE_M gacha aldab otilib, yana chekinadi.
          // Zarba yegan haydovchi (qasos) chalg'itmaydi — to'g'ri tashlanadi
          this.flankHoldSince = 0;
          feint = true;
          const lunge = this.feintLunge(t);
          const r = lunge ? WOLF_DRIVER_LUNGE_M : WOLF_DRIVER_FEINT_M;
          const ux = (me.pos.x - tgt.pos.x) / Math.max(dH, 1e-3);
          const uz = (me.pos.z - tgt.pos.z) / Math.max(dH, 1e-3);
          moveGoal = { x: tgt.pos.x + ux * r, y: me.pos.y, z: tgt.pos.z + uz * r };
          huntState = lunge ? 'hunt' : 'stalk';
        } else {
          this.flankHoldSince = 0;
          this.feintLungeAt = 0;
        }
        if (me.state !== huntState) this.setState(huntState, t);
        if (hold) {
          // Qanot nuqtasida nishonga qarab kutadi
          this.path = [];
          this.pathIdx = 0;
          this.turnTowards(Math.atan2(-(tgt.pos.x - me.pos.x), -(tgt.pos.z - me.pos.z)), dt, 8);
        } else if (feint) {
          // Chalg'itish: nishon bilan bir chiziqda qisqa masofaga chekinadi/otiladi (yo'l topilmaydi), proporsional
          // tezlik bilan (nuqtadan oshib ketmaydi), doim nishonga qaraydi. Otilishdan keyingi chekinish (nishondan
          // uzoqlashish, orqa bilan) — sekin, yurish tezligida (WOLF_WALK_SPEED): orqaga yurish bo'lib ko'rinadi
          this.path = [];
          this.pathIdx = 0;
          const fg = this.outsideFear(moveGoal);
          const dl = Math.hypot(fg.x - me.pos.x, fg.z - me.pos.z);
          const backOff = huntState === 'stalk' && dH < WOLF_DRIVER_FEINT_M;
          const feintSp = backOff ? Math.min(this.speedFor(huntState), WOLF_WALK_SPEED) : this.speedFor(huntState);
          const m = this.moveTowards(fg, Math.min(feintSp, Math.max(0.5, dl * 3)), dt, false);
          wishX = m.wishX;
          wishZ = m.wishZ;
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

    // Tishlashda va yumshoq olov halqasida sirpanmaydi
    this.moveWithSlip(wishX, wishZ, dt, t, me.state !== 'attack' && !softPush);
  }
}
