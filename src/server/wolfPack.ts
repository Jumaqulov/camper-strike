import { angleDiff, type Vec3 } from '../shared/math';
import { collidesAtWorld } from '../shared/physics';
import { sampleTerrainHeight } from '../shared/world';
import { WOLF_LOSE_TARGET_SEC, WOLF_RADIUS, wolfCoatTraits } from '../shared/wolf';
import type { FearSource, Room, ServerPlayer } from './room';
import type { ServerWolf } from './wolf';

/** To'dadagi vazifa: 'driver' — old tomondan chalg'itib boradi, 'flanker' — orqadan/yondan aylanib keladi. */
export type WolfRole = 'driver' | 'flanker';

/** To'da koordinatorining har tickdagi buyrug'i (WolfBrain.setPackOrder). */
export interface PackOrder {
  targetId: string;
  role: WolfRole;
  /** Nishonning to'daga ma'lum oxirgi joyi va vaqti (to'da xabardorligi — ko'rmagan bo'ri ham biladi). */
  sensedAt: number;
  sensedPos: Vec3;
  /** Qanot nuqtasi (faqat 'flanker', nishon olov ichida bo'lmasa). */
  flankGoal?: Vec3;
  /** Nishondan haydovchi tomon yo'nalish (XZ burchak, rad) — qanotning orqa sektori shunga nisbatan. */
  driverAng: number;
  /**
   * To'da hujumga o'tdi: qanotlar orqaga yetdi yoki chalg'itish muddati tugadi (yakka bo'ri — doim). Bunga qadar
   * haydovchi nishon oldida chalg'itadi, qanotlar faqat orqa sektordan (yoki nishon orqa o'girsa) tashlanadi.
   */
  commit: boolean;
  /** Hujum boshlangan vaqt (commit bo'lsa; qanot shundan WOLF_FLANK_LATE_SEC o'tib orqaga yetmasa ham tashlanadi). */
  commitAt: number;
  /** Nishon olov (gulxan/mash'al) ichida: bo'rining halqadagi o'z o'rni (burchak, rad) — to'da o'rab oladi. */
  standoffAngle?: number;
  /** Halqa o'rni radiusi (m): standoff nuqtasini bezak (panjara, g'aram) to'sgan bo'lsa kengroq; yo'q — manba standoff. */
  standoffR?: number;
  /** Haydovchi uvlasin (to'lqinda birinchi nishon uzoqdan olinganda, bir marta). */
  howl?: boolean;
}

/** Bir bo'ri ko'rgan o'yinchi joyi shu masofadagi (m) boshqa bo'rilarga ma'lum bo'ladi. */
export const WOLF_PACK_SHARE_RANGE_M = 60;
/** To'da boshlig'i (oq) ko'rgani uzoqroqqa yetadi. */
export const WOLF_PACK_ALPHA_SHARE_RANGE_M = 90;
/** Ulashilgan joy shuncha soniya amal qiladi. */
export const WOLF_PACK_SHARE_SEC = 6;
/** Qanot nuqtalari nishon atrofidagi doira radiusi (m). */
export const WOLF_FLANK_RADIUS_M = 9;
/** Qanot nuqtasi shu oraliqda qayta hisoblanadi (s). */
export const WOLF_FLANK_REEVAL_SEC = 0.8;
/** Qanot orqa sektorda nishondan shu masofada (m) bo'lsa (va shart bajarilsa) to'g'ri hujumga o'tadi. */
export const WOLF_FLANK_ENGAGE_M = 11;
/** Orqa sektor (gradus): nishon→qanot yo'nalishi nishon→haydovchi yo'nalishidan shundan ko'p burilgan. */
export const WOLF_FLANK_REAR_DEG = 90;
/** Qanot nuqtasiga shuncha (m) qolganda poylab (stalk) yuradi; undan uzoqda aylanib o'tishda yuguradi. */
export const WOLF_FLANK_STALK_M = 4;
/** Qanot nuqtasida kutish chegarasi (s): to'da hujumga o'tmasa ham shundan keyin tashlanadi. */
export const WOLF_FLANK_HOLD_MAX_SEC = 4;
/**
 * Aylanib o'tish doirasi (m): qanot nuqtasi nishon atrofida uzoq burchakda bo'lsa qanot avval shu kengroq doiradagi
 * oraliq nuqtalar bo'ylab o'z tomonidan aylanadi (old tomondan, haydovchi yonidan nishonga kesib o'tmaydi).
 */
export const WOLF_FLANK_SWING_M = 14;
/** Hujum boshlangach qanot shuncha soniyada orqa sektorga yetmasa — turgan joyidan tashlanadi. */
export const WOLF_FLANK_LATE_SEC = 3;
/** Qanot burchaklari (nishon→haydovchi yo'nalishidan, gradus): ±120°, ±150°. */
export const WOLF_FLANK_MIN_DEG = 120;
export const WOLF_FLANK_MAX_DEG = 150;
const WOLF_FLANK_STEP_DEG = 30;
/** Haydovchi chalg'itish masofasi (m): qanotlar orqaga yetguncha nishon oldida shu masofada irillab turadi. */
export const WOLF_DRIVER_FEINT_M = 6.5;
/** Aldab tashlanish (m): haydovchi vaqti-vaqti bilan nishonga shu masofagacha otilib, yana chekinadi. */
export const WOLF_DRIVER_LUNGE_M = 4.5;
/** Haydovchi nishondan shuncha (m) yaqin bo'lsa (nishon o'zi bostirib keldi) — to'da darhol hujumga o'tadi. */
export const WOLF_DRIVER_COMMIT_M = 3;
/** Chalg'itish chegarasi (s): haydovchi chalg'itish masofasiga yetgach qanotlar yetmasa ham shundan keyin hujum. */
export const WOLF_FEINT_MAX_SEC = 4.5;
/** To'da hujumining umumiy chegarasi (s): guruh tuzilgandan shuncha o'tsa (haydovchi yetib kelmagan bo'lsa ham) hujum. */
export const WOLF_PACK_COMMIT_MAX_SEC = 10;
/** Zarba yegan bo'ri shuncha soniya hujumchini ovlashda qoladi (to'da buyrug'idan ustun). */
export const WOLF_PACK_RETALIATE_SEC = 4;
/** To'lqinda birinchi nishon shu masofadan (m) uzoqda olinsa haydovchi uvlaydi. */
export const WOLF_PACK_HOWL_MIN_DIST_M = 18;
/** Yetib bo'lmas (devor ortidagi) nishon haqidagi xabar shuncha soniya amal qiladi (ball jarimasi). */
export const WOLF_PACK_UNREACHABLE_SEC = 3;
/** Yetib bo'lmas nishon ball jarimasi — boshqa yetib boriladigan o'lja afzal (yolg'iz nishon bo'lsa baribir u). */
export const SCORE_UNREACHABLE = 40;

/** Ball koeffitsiyentlari (preyScore). */
const SCORE_FIRE_DIST = 0.6;
const SCORE_FIRE_DIST_MAX = 40;
const SCORE_ALLY_DIST = 0.8;
const SCORE_ALLY_DIST_MAX = 30;
const SCORE_WOUNDED = 12;
const SCORE_WOUNDED_HP = 40;
const SCORE_PACK_DIST = 0.25;
const SCORE_PER_ASSIGNED = 6;
const SCORE_CURRENT_TARGET = 3;
/** Haydovchi almashishi uchun boshqa bo'ri nishonga shuncha (m) yaqinroq bo'lishi kerak (tebranmasin). */
const DRIVER_SWAP_MARGIN_M = 2;
/** Qanot o'z nuqtasiga shuncha (m) yaqin bo'lsa joyida deb hisoblanadi (to'da hujumi sharti). */
const FLANK_IN_POSITION_M = 2.5;
/** Gulxan halqasi namunalari soni (10° qadam) — bezak to'sgan nuqtalarni aniqlash va o'rinlarni surish uchun. */
const RING_SAMPLES = 36;
/** Standoff nuqtasi to'silgan bo'lsa shu qo'shimcha radiuslar (m) sinaladi. */
const RING_EXTRA_R_M: readonly number[] = [0, 1.5, 3];

interface Sighting {
  /** Oxirgi sezish vaqti/joyi va kim sezgani (uning joyi va ulashish radiusi). */
  at: number;
  pos: Vec3;
  byId: string;
  byX: number;
  byZ: number;
  range: number;
  /** Har bir bo'rining o'zi shu o'yinchini oxirgi sezgan vaqti. */
  byWolf: Map<string, number>;
}

interface WolfPackState {
  flankGoal: Vec3 | null;
  flankAt: number;
  /** Qanot nuqtasi qaysi nishon va qaysi burchak (rad) uchun hisoblangan — o'zgarsa darhol qayta hisoblanadi. */
  flankPrey: string | null;
  flankOff: number;
}

/** To'daning olovdan tashqaridagi nishonga hujumi: haydovchi chalg'itadi → qanotlar orqaga yetadi → hujum. */
interface PackHunt {
  startedAt: number;
  /** Haydovchi chalg'itish masofasiga yetgan vaqt (0 — hali yetmagan). */
  feintSince: number;
  /** To'da hujumga o'tgan vaqt (0 — hali chalg'itmoqda). */
  commitAt: number;
  /** Oldingi tickdagi guruh hajmi (yakka bo'riga sherik qo'shilsa chalg'itish qaytadan boshlanadi). */
  size: number;
}

/** Olov halqasidagi o'rin: burchak (rad) va radius (m). */
interface RingSlot {
  ang: number;
  r: number;
}

interface PreyInfo {
  p: ServerPlayer;
  base: number;
}

/**
 * To'da koordinatori (xona egasi, har tick bo'rilar AI dan oldin): bo'rilar sezgan o'yinchilarni to'playdi
 * (to'da xabardorligi), har bir o'yinchiga ball beradi (yolg'iz, gulxandan uzoq, yarador — afzal; ko'p bo'ri
 * yopishgan — jarima; mash'al ko'targan — gulxan yonidagidek himoyalangan), bo'rilarni taqsimlaydi va vazifa
 * beradi: nishonga eng yaqini haydovchi (old tomondan kelib chalg'itadi), qolganlari qanot (kengroq doira
 * bo'ylab o'z tomonidan aylanib, nishon atrofidagi doirada ±120..150° nuqtaga boradi va orqadan tashlanadi).
 * Qanotlar orqaga yetgach (yoki chalg'itish muddati tugagach) to'da hujumga o'tadi. Nishon olov ichida bo'lsa
 * to'da halqa bo'ylab yoyiladi (bezak to'sgan nuqtalar o'tkazib yuboriladi). Yiqilgan/o'lgan nishon darhol
 * tashlanadi (isWolfPrey). Deterministik: tasodif yo'q, bo'rilar id tartibida ko'riladi.
 */
export class WolfPack {
  private readonly sightings = new Map<string, Sighting>();
  private readonly wolfState = new Map<string, WolfPackState>();
  private readonly retaliate = new Map<string, { targetId: string; until: number }>();
  private readonly driverByPrey = new Map<string, string>();
  /** Olov halqasidagi o'rinlar (nishon → guruh kaliti va bo'ri → o'rin). */
  private readonly slotsByPrey = new Map<string, { key: string; slots: Map<string, RingSlot> }>();
  /** Gulxan halqasining bo'sh nuqtalari (gulxan joyi → nuqtalar; null — halqa butunlay ochiq). Gulxan qimirlamaydi. */
  private readonly ringFreeCache = new Map<string, RingSlot[] | null>();
  /** Olovdan tashqaridagi nishonlarga hujum holati (nishon → chalg'itish/hujum vaqtlari). */
  private readonly huntByPrey = new Map<string, PackHunt>();
  /** Yetib bo'lmas (devor ortidagi) nishonlar: o'yinchi → xabar amal qilish muddati. */
  private readonly unreachableUntil = new Map<string, number>();
  private lastHowlWave = -2;

  constructor(private readonly room: Room) {}

  /**
   * Bo'ri nishoniga yetolmaydi (og'izdan to'siqsiz chiziq yo'q va nav yo'li ham tishlash joyiga olib kelmaydi — uy
   * ichida): WOLF_PACK_UNREACHABLE_SEC davomida bu o'ljaga SCORE_UNREACHABLE jarima — to'da yetib boriladigan
   * boshqa o'ljani afzal ko'radi; yolg'iz nishon bo'lsa bo'rilar uning atrofida qoladi.
   */
  reportUnreachable(p: ServerPlayer, t: number): void {
    this.unreachableUntil.set(p.id, t + WOLF_PACK_UNREACHABLE_SEC);
  }

  /** Testlar uchun: o'lja hozir yetib bo'lmas deb belgilanganmi. */
  isUnreachable(playerId: string, t: number = this.room.now()): boolean {
    const until = this.unreachableUntil.get(playerId);
    return until !== undefined && t <= until;
  }

  /** Bo'ri o'yinchini sezdi (ko'rdi / yaqindan hid oldi / tishlandi): to'daga xabar. */
  report(w: ServerWolf, p: ServerPlayer, t: number, retaliate = false): void {
    let s = this.sightings.get(p.id);
    const range = wolfCoatTraits(w.coat).kind === 'alpha' ? WOLF_PACK_ALPHA_SHARE_RANGE_M : WOLF_PACK_SHARE_RANGE_M;
    if (!s) {
      s = { at: t, pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z }, byId: w.id, byX: w.pos.x, byZ: w.pos.z, range, byWolf: new Map() };
      this.sightings.set(p.id, s);
    } else if (t >= s.at) {
      s.at = t;
      s.pos = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
      s.byId = w.id;
      s.byX = w.pos.x;
      s.byZ = w.pos.z;
      s.range = range;
    }
    s.byWolf.set(w.id, Math.max(s.byWolf.get(w.id) ?? -Infinity, t));
    if (retaliate) this.retaliate.set(w.id, { targetId: p.id, until: t + WOLF_PACK_RETALIATE_SEC });
  }

  /** Testlar uchun: o'yinchi to'daga ma'lummi (oxirgi WOLF_LOSE_TARGET_SEC ichida kimdir sezgan). */
  knowsPrey(playerId: string, t: number = this.room.now()): boolean {
    const s = this.sightings.get(playerId);
    return !!s && t - s.at <= WOLF_LOSE_TARGET_SEC;
  }

  /** Bo'ri shu o'yinchini ovlashi mumkinmi: o'zi yaqinda sezgan yoki ulashuvchi bo'riga yaqin (to'da xabardorligi). */
  private eligible(w: ServerWolf, s: Sighting, t: number): boolean {
    const own = s.byWolf.get(w.id);
    if (own !== undefined && t - own <= WOLF_LOSE_TARGET_SEC) return true;
    if (t - s.at > WOLF_PACK_SHARE_SEC) return false;
    return Math.hypot(w.pos.x - s.byX, w.pos.z - s.byZ) <= s.range;
  }

  private clearOrders(): void {
    for (const w of this.room.wolves.values()) {
      w.role = null;
      w.brain.setPackOrder(null, 0);
    }
  }

  update(t: number): void {
    const room = this.room;
    if (room.phase !== 'playing') {
      this.sightings.clear();
      this.driverByPrey.clear();
      this.slotsByPrey.clear();
      this.huntByPrey.clear();
      this.clearOrders();
      return;
    }
    // Eskirgan izlar va yo'q bo'rilar
    for (const [id, s] of this.sightings) {
      const p = room.players.get(id);
      if (!p || !room.isWolfPrey(p) || t - s.at > WOLF_LOSE_TARGET_SEC) this.sightings.delete(id);
    }
    for (const id of this.wolfState.keys()) if (!room.wolves.has(id)) this.wolfState.delete(id);
    for (const [id, r] of this.retaliate) if (t > r.until || !room.wolves.has(id)) this.retaliate.delete(id);
    for (const [id, until] of this.unreachableUntil) if (t > until || !room.players.has(id)) this.unreachableUntil.delete(id);

    const wolves = [...room.wolves.values()].filter((w) => w.alive && w.state !== 'flee').sort((a, b) => (a.id < b.id ? -1 : 1));
    if (wolves.length === 0) return;

    // Nishon ballari (bo'riga bog'liq bo'lmagan qism). Faol signal raketasi doirasidagi o'yinchi taqsimlanmaydi
    // (isWolfPreyExposed) — to'da uni tashlaydi, raketa so'ngach yana ko'radi.
    const prey: PreyInfo[] = [];
    const preyAll = [...room.players.values()].filter((p) => room.isWolfPreyExposed(p));
    for (const p of preyAll) {
      if (!this.sightings.has(p.id)) continue;
      // Mash'al ko'targan (yoki sherigining mash'ali yonida turgan) o'yinchi gulxan yonidagidek himoyalangan —
      // "gulxandan uzoq" balli berilmaydi (bo'ri unga baribir yaqinlasha olmaydi)
      const torchLit = room.hasTorch(p, t) || room.preyFearSource(p)?.kind === 'torch';
      const fire = torchLit ? null : room.nearestLitFire(p.pos.x, p.pos.z);
      const fireDist = torchLit ? 0 : fire ? Math.min(SCORE_FIRE_DIST_MAX, Math.hypot(fire.x - p.pos.x, fire.z - p.pos.z)) : SCORE_FIRE_DIST_MAX;
      let allyDist = SCORE_ALLY_DIST_MAX;
      for (const o of preyAll) {
        if (o === p) continue;
        allyDist = Math.min(allyDist, Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z));
      }
      const base = SCORE_FIRE_DIST * fireDist + SCORE_ALLY_DIST * allyDist + (p.hp < SCORE_WOUNDED_HP ? SCORE_WOUNDED : 0);
      prey.push({ p, base });
    }

    // Taqsimlash (ochko'z, bo'rilar id tartibida)
    const assigned = new Map<string, ServerPlayer>();
    const counts = new Map<string, number>();
    for (const w of wolves) {
      const lock = this.retaliate.get(w.id);
      if (lock) {
        const lp = room.players.get(lock.targetId);
        if (lp && room.isWolfPreyExposed(lp) && this.sightings.has(lp.id)) {
          assigned.set(w.id, lp);
          counts.set(lp.id, (counts.get(lp.id) ?? 0) + 1);
          continue;
        }
      }
      let best: ServerPlayer | null = null;
      let bestScore = -Infinity;
      for (const { p, base } of prey) {
        const s = this.sightings.get(p.id)!;
        if (!this.eligible(w, s, t)) continue;
        const score =
          base -
          SCORE_PACK_DIST * Math.hypot(p.pos.x - w.pos.x, p.pos.z - w.pos.z) -
          SCORE_PER_ASSIGNED * (counts.get(p.id) ?? 0) -
          (this.unreachableUntil.has(p.id) ? SCORE_UNREACHABLE : 0) +
          (w.targetId === p.id ? SCORE_CURRENT_TARGET : 0);
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      if (best) {
        assigned.set(w.id, best);
        counts.set(best.id, (counts.get(best.id) ?? 0) + 1);
      }
    }

    // Guruhlar: nishon → bo'rilar
    const groups = new Map<string, ServerWolf[]>();
    for (const w of wolves) {
      const p = assigned.get(w.id);
      if (!p) {
        w.role = null;
        w.brain.setPackOrder(null, t);
        continue;
      }
      const g = groups.get(p.id);
      if (g) g.push(w);
      else groups.set(p.id, [w]);
    }
    for (const id of this.driverByPrey.keys()) if (!groups.has(id)) this.driverByPrey.delete(id);
    for (const id of this.slotsByPrey.keys()) if (!groups.has(id)) this.slotsByPrey.delete(id);
    for (const id of this.huntByPrey.keys()) if (!groups.has(id)) this.huntByPrey.delete(id);

    // Uvlash: yangi to'lqinda to'da birinchi nishonni uzoqdan olganda haydovchi bir marta uvlaydi (faqat wolf_night)
    const wave = room.isNight ? room.currentNightWaveIdx() : -1;
    const howlDue = room.isNight && groups.size > 0 && wave !== this.lastHowlWave;
    let howled = false;

    for (const [preyId, group] of groups) {
      const p = room.players.get(preyId)!;
      const s = this.sightings.get(preyId)!;
      // Haydovchi: nishonga eng yaqini (joriy haydovchi DRIVER_SWAP_MARGIN_M gacha ustunlikka ega)
      let driver = group[0]!;
      let driverD = Infinity;
      for (const w of group) {
        const d = Math.hypot(w.pos.x - p.pos.x, w.pos.z - p.pos.z);
        if (d < driverD) {
          driverD = d;
          driver = w;
        }
      }
      const prevId = this.driverByPrey.get(preyId);
      if (prevId && prevId !== driver.id) {
        const prev = group.find((w) => w.id === prevId);
        if (prev) {
          // Joriy haydovchi nishonga kirishib bo'lgan (≤ WOLF_FLANK_ENGAGE_M) yoki eng yaqinidan sal uzoq bo'lsa
          // qoladi. To'da hali chalg'itmoqda (hujumga o'tmagan) yoki haydovchi uvlayapti — ham qoladi: to'lqin
          // boshidagi uvlash paytida qanotlar aylanib yaqinlashadi, vazifa almashsa qanot nuqtalari buziladi
          const pd = Math.hypot(prev.pos.x - p.pos.x, prev.pos.z - p.pos.z);
          const feinting = this.huntByPrey.get(preyId)?.commitAt === 0;
          if (pd <= driverD + DRIVER_SWAP_MARGIN_M || pd <= WOLF_FLANK_ENGAGE_M || prev.state === 'howl' || feinting) {
            driver = prev;
            driverD = pd;
          }
        }
      }
      this.driverByPrey.set(preyId, driver.id);
      const driverAng = Math.atan2(driver.pos.z - p.pos.z, driver.pos.x - p.pos.x);

      // Olov himoyasi — xona gisterezisi (WolfBrain bilan bir xil javob: halqa o'rinlari va "chetida tur" mos keladi)
      const fire = room.preyFearSource(p);
      let slots: Map<string, RingSlot> | null = null;
      if (fire) {
        // Halqa o'rinlari: guruh tarkibi (va gulxan) o'zgarmaguncha saqlanadi (to'plangan bo'rilar har tick o'rin
        // almashmasin). Olov ichidagi nishonga hujum holati tashlanadi — chiqsa to'da yana chalg'itib aylanadi.
        const key = group.map((w) => w.id).join('|') + (fire.kind === 'fire' ? `@${fire.x.toFixed(1)},${fire.z.toFixed(1)}` : '');
        const prev = this.slotsByPrey.get(preyId);
        if (prev && prev.key === key) {
          slots = prev.slots;
        } else {
          slots = this.ringSlots(fire, group);
          this.slotsByPrey.set(preyId, { key, slots });
        }
        this.huntByPrey.delete(preyId);
      } else {
        this.slotsByPrey.delete(preyId);
      }

      // Qanot burchaklari: qanotlar hozirgi tomoniga qarab taqsimlanadi
      const flankOff = slots ? null : this.flankOffsets(group, driver, p, driverAng);
      const orders: { w: ServerWolf; order: PackOrder }[] = [];
      for (const w of group) {
        const isDriver = w === driver;
        const order: PackOrder = {
          targetId: preyId,
          role: isDriver ? 'driver' : 'flanker',
          sensedAt: s.at,
          sensedPos: s.pos,
          driverAng,
          commit: true,
          commitAt: 0,
        };
        const st = this.stateOf(w.id);
        if (slots) {
          const slot = slots.get(w.id);
          if (slot) {
            order.standoffAngle = slot.ang;
            order.standoffR = slot.r;
          }
          st.flankGoal = null;
        } else if (!isDriver) {
          const off = flankOff!.get(w.id) ?? (WOLF_FLANK_MIN_DEG * Math.PI) / 180;
          if (!st.flankGoal || st.flankPrey !== preyId || st.flankOff !== off || t - st.flankAt >= WOLF_FLANK_REEVAL_SEC) {
            st.flankGoal = this.flankPoint(p, driverAng, off);
            st.flankAt = t;
            st.flankPrey = preyId;
            st.flankOff = off;
          }
          if (st.flankGoal) order.flankGoal = st.flankGoal;
        } else {
          st.flankGoal = null;
        }
        if (isDriver && howlDue && !howled && driverD > WOLF_PACK_HOWL_MIN_DIST_M) {
          order.howl = true;
          howled = true;
        }
        orders.push({ w, order });
      }
      // Hujum sharti (qanot nuqtalari shu tickda yangilangandan keyin tekshiriladi)
      if (!slots) {
        const hunt = this.huntOf(preyId, group, driver, driverD, driverAng, p, t);
        for (const { order } of orders) {
          order.commit = hunt.commitAt > 0;
          order.commitAt = hunt.commitAt;
        }
      }
      for (const { w, order } of orders) {
        w.role = order.role;
        w.brain.setPackOrder(order, t);
      }
    }
    if (howlDue) this.lastHowlWave = wave;
  }

  private stateOf(id: string): WolfPackState {
    let st = this.wolfState.get(id);
    if (!st) {
      st = { flankGoal: null, flankAt: -99, flankPrey: null, flankOff: 0 };
      this.wolfState.set(id, st);
    }
    return st;
  }

  /**
   * Nishonga hujum holati (olovdan tashqarida): haydovchi chalg'itish masofasiga yetgan vaqtni yozadi va hujum
   * shartini tekshiradi — barcha qanotlar orqa sektorga (yoki o'z nuqtasiga) yetdi, chalg'itish WOLF_FEINT_MAX_SEC
   * davom etdi, guruh WOLF_PACK_COMMIT_MAX_SEC dan beri ovlayapti, nishon haydovchiga o'zi yaqinlashdi
   * (≤ WOLF_DRIVER_COMMIT_M) yoki to'dadan birini urdi (qasos). Yakka bo'ri darhol hujum qiladi; unga sherik
   * qo'shilsa (haydovchi nishonga hali yopishmagan bo'lsa) chalg'itish qaytadan boshlanadi.
   */
  private huntOf(preyId: string, group: ServerWolf[], driver: ServerWolf, driverD: number, driverAng: number, p: ServerPlayer, t: number): PackHunt {
    const solo = group.length < 2;
    let h = this.huntByPrey.get(preyId);
    if (!h || (h.size < 2 && !solo && driverD > WOLF_DRIVER_COMMIT_M + 1)) {
      h = { startedAt: t, feintSince: 0, commitAt: 0, size: group.length };
      this.huntByPrey.set(preyId, h);
    }
    h.size = group.length;
    if (h.commitAt > 0) return h;
    if (h.feintSince === 0 && driverD <= WOLF_DRIVER_FEINT_M + 1.5) h.feintSince = t;
    let ready = true;
    for (const w of group) {
      if (w !== driver && !this.flankerInPosition(w, p, driverAng)) {
        ready = false;
        break;
      }
    }
    const struck = group.some((w) => this.retaliate.get(w.id)?.targetId === preyId);
    if (
      solo ||
      struck ||
      driverD <= WOLF_DRIVER_COMMIT_M ||
      t - h.startedAt >= WOLF_PACK_COMMIT_MAX_SEC ||
      (h.feintSince > 0 && (ready || t - h.feintSince >= WOLF_FEINT_MAX_SEC))
    ) {
      h.commitAt = t;
    }
    return h;
  }

  /** Qanot joyida: o'z nuqtasiga yetdi yoki nishonning orqa sektorida (WOLF_FLANK_ENGAGE_M ichida); nuqtasi yo'q — kutilmaydi. */
  private flankerInPosition(w: ServerWolf, p: ServerPlayer, driverAng: number): boolean {
    const g = this.wolfState.get(w.id)?.flankGoal;
    if (!g) return true;
    if (Math.hypot(g.x - w.pos.x, g.z - w.pos.z) < FLANK_IN_POSITION_M) return true;
    const d = Math.hypot(w.pos.x - p.pos.x, w.pos.z - p.pos.z);
    const rel = Math.abs(angleDiff(driverAng, Math.atan2(w.pos.z - p.pos.z, w.pos.x - p.pos.x)));
    return d <= WOLF_FLANK_ENGAGE_M && rel >= (WOLF_FLANK_REAR_DEG * Math.PI) / 180;
  }

  /**
   * Qanot burchaklari (nishon→haydovchi yo'nalishidan, rad): ±MIN, ±(MIN+STEP), ... gacha MAX. Qanotlar hozirgi
   * tomoniga qarab saralanib taqsimlanadi (eng musbat tomondagisi eng musbat o'ringa) — yo'llari kesishmaydi,
   * har biri o'z tomonidan aylanadi.
   */
  private flankOffsets(group: ServerWolf[], driver: ServerWolf, p: ServerPlayer, driverAng: number): Map<string, number> {
    const flankers = group.filter((w) => w !== driver);
    const offs: number[] = [];
    for (let k = 0; k < flankers.length; k++) {
      const deg = Math.min(WOLF_FLANK_MAX_DEG, WOLF_FLANK_MIN_DEG + Math.floor(k / 2) * WOLF_FLANK_STEP_DEG);
      offs.push(((k % 2 === 0 ? 1 : -1) * deg * Math.PI) / 180);
    }
    offs.sort((a, b) => b - a);
    const sorted = flankers
      .map((w) => ({ w, rel: angleDiff(driverAng, Math.atan2(w.pos.z - p.pos.z, w.pos.x - p.pos.x)) }))
      .sort((a, b) => b.rel - a.rel || (a.w.id < b.w.id ? -1 : 1));
    const out = new Map<string, number>();
    sorted.forEach((e, i) => out.set(e.w.id, offs[i]!));
    return out;
  }

  /**
   * Halqa o'rinlari (nishon olov ichida): bo'rilar joriy burchagi bo'yicha saralanib 360/n qadam bilan teng
   * yoyiladi (birinchisi joyida qoladi). Gulxan atrofida bezaklar (kulba, panjara, o'tin g'arami) bo'lsa halqaning
   * to'silgan nuqtalari o'tkazib yuboriladi: har o'rin eng yaqin bo'sh nuqtaga suriladi, burilish esa eng kichik
   * oraliq eng katta (teng bo'lsa — bo'rilar eng kam yuradigan) qilib tanlanadi. Mash'al/raketa — teng qadam.
   */
  private ringSlots(fire: FearSource, group: ServerWolf[]): Map<string, RingSlot> {
    const n = group.length;
    const TWO_PI = Math.PI * 2;
    const withAng = group
      .map((w) => ({ w, a: Math.atan2(w.pos.z - fire.z, w.pos.x - fire.x) }))
      .sort((a, b) => a.a - b.a || (a.w.id < b.w.id ? -1 : 1));
    const out = new Map<string, RingSlot>();
    const free = fire.kind === 'fire' ? this.ringFreePoints(fire) : null;
    if (!free || free.length < n) {
      const base = withAng[0]!.a;
      for (let i = 0; i < n; i++) out.set(withAng[i]!.w.id, { ang: base + (i * TWO_PI) / n, r: fire.standoff });
      return out;
    }
    let best: RingSlot[] | null = null;
    let bestGap = -1;
    let bestCost = Infinity;
    for (let b = 0; b < RING_SAMPLES; b++) {
      const base = -Math.PI + (b * TWO_PI) / RING_SAMPLES;
      const used = new Set<number>();
      const picked: RingSlot[] = [];
      for (let i = 0; i < n; i++) {
        const ideal = base + (i * TWO_PI) / n;
        let bi = -1;
        let bd = Infinity;
        for (let j = 0; j < free.length; j++) {
          if (used.has(j)) continue;
          const d = Math.abs(angleDiff(ideal, free[j]!.ang));
          if (d < bd) {
            bd = d;
            bi = j;
          }
        }
        used.add(bi);
        picked.push(free[bi]!);
      }
      picked.sort((x, y) => x.ang - y.ang);
      let gap = n === 1 ? TWO_PI : picked[0]!.ang + TWO_PI - picked[n - 1]!.ang;
      for (let i = 0; i + 1 < n; i++) gap = Math.min(gap, picked[i + 1]!.ang - picked[i]!.ang);
      // Bo'rilar (burchak tartibida) o'rinlarga aylanma moslanadi — eng kam umumiy burilish
      let cost = Infinity;
      let rot = 0;
      for (let r = 0; r < n; r++) {
        let c = 0;
        for (let i = 0; i < n; i++) c += Math.abs(angleDiff(withAng[i]!.a, picked[(i + r) % n]!.ang));
        if (c < cost) {
          cost = c;
          rot = r;
        }
      }
      if (gap > bestGap + 1e-6 || (Math.abs(gap - bestGap) <= 1e-6 && cost < bestCost)) {
        bestGap = gap;
        bestCost = cost;
        best = picked.map((_, i) => picked[(i + rot) % n]!);
      }
    }
    for (let i = 0; i < n; i++) out.set(withAng[i]!.w.id, best![i]!);
    return out;
  }

  /**
   * Gulxan halqasining bo'sh nuqtalari (RING_SAMPLES burchak): standoff radiusida (to'silgan bo'lsa +1.5 / +3 m)
   * bo'ri sig'adigan, relyefi gulxan sathida va eng yaqin nav tuguniga to'siqsiz ulangan nuqta. Butun halqa
   * standoff radiusida ochiq bo'lsa null (oddiy teng qadam). Gulxan qimirlamaydi — natija keshlanadi.
   */
  private ringFreePoints(fire: FearSource): RingSlot[] | null {
    const key = `${fire.x.toFixed(2)},${fire.z.toFixed(2)}`;
    const cached = this.ringFreeCache.get(key);
    if (cached !== undefined) return cached;
    const world = this.room.world;
    const nav = this.room.nav;
    const pts: RingSlot[] = [];
    let open = true;
    for (let k = 0; k < RING_SAMPLES; k++) {
      const ang = -Math.PI + (k * Math.PI * 2) / RING_SAMPLES;
      let found = false;
      for (const dr of RING_EXTRA_R_M) {
        const r = fire.standoff + dr;
        const x = fire.x + Math.cos(ang) * r;
        const z = fire.z + Math.sin(ang) * r;
        const pt = { x, y: sampleTerrainHeight(world.terrain, x, z), z };
        if (Math.abs(pt.y - fire.y) > 1.5) continue;
        if (collidesAtWorld(world, x, pt.y + 0.05, z, WOLF_RADIUS + 0.15, 1.0)) continue;
        const ni = nav.nearest(pt);
        if (ni < 0) continue;
        const c = nav.center(ni);
        if (Math.hypot(c.x - x, c.z - z) > 3.5 || !nav.segmentClear(pt, c, WOLF_RADIUS)) continue;
        pts.push({ ang, r });
        found = true;
        if (dr > 0) open = false;
        break;
      }
      if (!found) open = false;
    }
    const res = open ? null : pts;
    this.ringFreeCache.set(key, res);
    return res;
  }

  /**
   * Qanot nuqtasi: nishon atrofidagi WOLF_FLANK_RADIUS_M doirada, nishon→haydovchi yo'nalishidan `off` (rad)
   * burilgan. Nav-grafdan tashqarida bo'lsa qarama-qarshi tomon sinaladi; u ham bo'lmasa null (qanot to'g'ri boradi).
   */
  private flankPoint(prey: ServerPlayer, driverAng: number, off: number): Vec3 | null {
    const nav = this.room.nav;
    const terrain = this.room.world.terrain;
    for (const sgn of [1, -1]) {
      const ang = driverAng + sgn * off;
      const x = prey.pos.x + Math.cos(ang) * WOLF_FLANK_RADIUS_M;
      const z = prey.pos.z + Math.sin(ang) * WOLF_FLANK_RADIUS_M;
      const pt = { x, y: sampleTerrainHeight(terrain, x, z), z };
      const ni = nav.nearest(pt);
      if (ni < 0) continue;
      const c = nav.center(ni);
      if (Math.hypot(c.x - x, c.z - z) > 3) continue;
      return pt;
    }
    return null;
  }

  /** Testlar/QA uchun: bo'riga berilgan qanot nuqtasi (bo'lsa). */
  flankGoalOf(wolfId: string): Vec3 | null {
    return this.wolfState.get(wolfId)?.flankGoal ?? null;
  }

  /** Testlar/QA uchun: nishonga hujum bosqichi — 'feint' (haydovchi chalg'itmoqda), 'commit' (hujum), null (olov ichida / to'da yo'q). */
  huntPhaseOf(preyId: string): 'feint' | 'commit' | null {
    const h = this.huntByPrey.get(preyId);
    return h ? (h.commitAt > 0 ? 'commit' : 'feint') : null;
  }
}

/** Nishon old yo'nalishi bilan nishon→bo'ri vektori orasidagi dot (<0 — bo'ri nishonning orqasida). */
export function preyFacingDot(preyYaw: number, prey: Vec3, wolf: Vec3): number {
  const dx = wolf.x - prey.x;
  const dz = wolf.z - prey.z;
  const l = Math.hypot(dx, dz) || 1;
  return (-Math.sin(preyYaw) * dx - Math.cos(preyYaw) * dz) / l;
}

/** Burchaklar orasidagi eng kichik farq (rad, 0..π) — testlar uchun qulaylik. */
export function angularSeparation(a: number, b: number): number {
  return Math.abs(angleDiff(a, b));
}
