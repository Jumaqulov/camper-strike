import { angleDiff, type Vec3 } from '../shared/math';
import { sampleTerrainHeight } from '../shared/world';
import { WOLF_LOSE_TARGET_SEC, wolfCoatTraits } from '../shared/wolf';
import type { Room, ServerPlayer } from './room';
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
  /** Haydovchining nishongacha masofasi (m) — qanot hujumga o'tish sharti. */
  driverDist: number;
  /** Nishon olov (gulxan/mash'al) ichida: bo'rining halqadagi o'z o'rni (burchak, rad) — to'da o'rab oladi. */
  standoffAngle?: number;
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
/** Qanot nishondan shu masofada (m) va shart bajarilsa to'g'ri hujumga o'tadi. */
export const WOLF_FLANK_ENGAGE_M = 11;
/** Haydovchi nishonga shuncha (m) yaqinlashsa qanotlar hujumga o'tadi. */
export const WOLF_FLANK_DRIVER_CLOSE_M = 6;
/** Qanot nuqtasiga borishda nishondan shu masofadan (m) uzoqda bo'lsa poylab (stalk), yaqin bo'lsa yugurib boradi. */
export const WOLF_FLANK_STALK_M = 15;
/** Qanot nuqtasida kutish chegarasi (s): haydovchi yetib kelmasa ham hujumga o'tadi. */
export const WOLF_FLANK_HOLD_MAX_SEC = 4;
/** Qanot burchaklari (nishon→haydovchi yo'nalishidan, gradus): ±100°, ±125°, ±150°. */
export const WOLF_FLANK_MIN_DEG = 100;
export const WOLF_FLANK_MAX_DEG = 150;
const WOLF_FLANK_STEP_DEG = 25;
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
}

interface PreyInfo {
  p: ServerPlayer;
  base: number;
}

/**
 * To'da koordinatori (xona egasi, har tick bo'rilar AI dan oldin): bo'rilar sezgan o'yinchilarni to'playdi
 * (to'da xabardorligi), har bir o'yinchiga ball beradi (yolg'iz, gulxandan uzoq, yarador — afzal; ko'p bo'ri
 * yopishgan — jarima), bo'rilarni taqsimlaydi va vazifa beradi: nishonga eng yaqini haydovchi (old tomondan
 * boradi), qolganlari qanot (nishon atrofidagi doirada ±100..150° nuqtaga nav-graf bo'ylab borib, keyin
 * orqadan tashlanadi). Nishon olov ichida bo'lsa to'da halqa bo'ylab teng yoyiladi. Yiqilgan/o'lgan nishon
 * darhol tashlanadi (isWolfPrey). Deterministik: tasodif yo'q, bo'rilar id tartibida ko'riladi.
 */
export class WolfPack {
  private readonly sightings = new Map<string, Sighting>();
  private readonly wolfState = new Map<string, WolfPackState>();
  private readonly retaliate = new Map<string, { targetId: string; until: number }>();
  private readonly driverByPrey = new Map<string, string>();
  /** Olov halqasidagi o'rinlar (nishon → guruh kaliti va bo'ri → burchak). */
  private readonly slotsByPrey = new Map<string, { key: string; slots: Map<string, number> }>();
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
      const fire = room.nearestLitFire(p.pos.x, p.pos.z);
      const fireDist = fire ? Math.min(SCORE_FIRE_DIST_MAX, Math.hypot(fire.x - p.pos.x, fire.z - p.pos.z)) : SCORE_FIRE_DIST_MAX;
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
          // Joriy haydovchi nishonga kirishib bo'lgan (≤ WOLF_FLANK_ENGAGE_M) yoki eng yaqinidan sal uzoq bo'lsa qoladi
          const pd = Math.hypot(prev.pos.x - p.pos.x, prev.pos.z - p.pos.z);
          if (pd <= driverD + DRIVER_SWAP_MARGIN_M || pd <= WOLF_FLANK_ENGAGE_M) {
            driver = prev;
            driverD = pd;
          }
        }
      }
      this.driverByPrey.set(preyId, driver.id);

      // Olov himoyasi — xona gisterezisi (WolfBrain bilan bir xil javob: halqa o'rinlari va "chetida tur" mos keladi)
      const fire = room.preyFearSource(p);
      let slots: Map<string, number> | null = null;
      if (fire) {
        // Halqa o'rinlari: guruh tarkibi o'zgarmaguncha saqlanadi (to'plangan bo'rilar har tick o'rin almashmasin).
        // Birinchi hisobda joriy burchak bo'yicha saralanadi: birinchisi joyida qoladi, qolganlari 360/n qadam bilan.
        const key = group.map((w) => w.id).join('|');
        const prev = this.slotsByPrey.get(preyId);
        if (prev && prev.key === key) {
          slots = prev.slots;
        } else {
          const n = group.length;
          const withAng = group
            .map((w) => ({ w, a: Math.atan2(w.pos.z - fire.z, w.pos.x - fire.x) }))
            .sort((a, b) => a.a - b.a || (a.w.id < b.w.id ? -1 : 1));
          slots = new Map();
          const base = withAng[0]!.a;
          for (let i = 0; i < n; i++) slots.set(withAng[i]!.w.id, base + (i * Math.PI * 2) / n);
          this.slotsByPrey.set(preyId, { key, slots });
        }
      } else {
        this.slotsByPrey.delete(preyId);
      }

      let flankIdx = 0;
      for (const w of group) {
        const isDriver = w === driver;
        const order: PackOrder = {
          targetId: preyId,
          role: isDriver ? 'driver' : 'flanker',
          sensedAt: s.at,
          sensedPos: s.pos,
          driverDist: driverD,
        };
        const st = this.stateOf(w.id);
        if (slots) {
          order.standoffAngle = slots.get(w.id);
          st.flankGoal = null;
        } else if (!isDriver) {
          if (!st.flankGoal || t - st.flankAt >= WOLF_FLANK_REEVAL_SEC) {
            st.flankGoal = this.flankPoint(p, driver, flankIdx);
            st.flankAt = t;
          }
          if (st.flankGoal) order.flankGoal = st.flankGoal;
          flankIdx++;
        } else {
          st.flankGoal = null;
        }
        if (isDriver && howlDue && !howled && driverD > WOLF_PACK_HOWL_MIN_DIST_M) {
          order.howl = true;
          howled = true;
        }
        w.role = order.role;
        w.brain.setPackOrder(order, t);
      }
    }
    if (howlDue) this.lastHowlWave = wave;
  }

  private stateOf(id: string): WolfPackState {
    let st = this.wolfState.get(id);
    if (!st) {
      st = { flankGoal: null, flankAt: -99 };
      this.wolfState.set(id, st);
    }
    return st;
  }

  /**
   * Qanot nuqtasi: nishon atrofidagi WOLF_FLANK_RADIUS_M doirada, nishon→haydovchi yo'nalishidan
   * ±(100°..150°) (k-qanot: tomonlar almashib, har juftlikda burchak 25° kattaroq). Nav-grafdan tashqarida
   * bo'lsa qarama-qarshi tomon sinaladi; u ham bo'lmasa null (qanot to'g'ri boradi).
   */
  private flankPoint(prey: ServerPlayer, driver: ServerWolf, k: number): Vec3 | null {
    const a0 = Math.atan2(driver.pos.z - prey.pos.z, driver.pos.x - prey.pos.x);
    const side = k % 2 === 0 ? 1 : -1;
    const offDeg = Math.min(WOLF_FLANK_MAX_DEG, WOLF_FLANK_MIN_DEG + Math.floor(k / 2) * WOLF_FLANK_STEP_DEG);
    const off = (offDeg * Math.PI) / 180;
    const nav = this.room.nav;
    const terrain = this.room.world.terrain;
    for (const sgn of [side, -side]) {
      const ang = a0 + sgn * off;
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
