/**
 * Forest Survival — xavfsiz zona torayishi.
 *
 * Raund davomida xarita ustida aylana "xavfsiz zona" bosqichma-bosqich torayadi. Zonadan tashqarida
 * qolgan o'yinchi sekundiga ma'lum zarar oladi. Butun jadval raund boshida (seed + raund davomiyligi)
 * deterministik quriladi, shuning uchun server har tick'da faqat `evaluateSurvivalZone` ni chaqiradi.
 *
 * Klientga faqat snapshot (joriy va maqsad aylana + qolgan vaqt) yuboriladi; klient ularni chiziqli
 * interpolyatsiya qiladi.
 */

import { createSeededRng } from '../math';

export interface SurvivalZoneCircle {
  cx: number;
  cz: number;
  radius: number;
}

export interface SurvivalZoneStage extends SurvivalZoneCircle {
  /** Shu bosqich aylanasi to'liq o'rnatilgandan keyin kutish vaqti (s). */
  holdSec: number;
  /** Keyingi bosqich aylanasiga torayish davomiyligi (s); oxirgi bosqichda 0. */
  shrinkSec: number;
  /** Shu bosqichda zonadan tashqarida bo'lganlarga sekundlik zarar. */
  dps: number;
}

export interface SurvivalZoneTimeline {
  stages: SurvivalZoneStage[];
  roundDurationSec: number;
}

export interface SurvivalZoneSnap {
  /** Joriy aylana (torayish paytida oraliq holat). */
  cx: number;
  cz: number;
  radius: number;
  /** Keyingi (yoki joriy, agar torayish bo'lmasa) maqsad aylana. */
  targetCx: number;
  targetCz: number;
  targetRadius: number;
  /** Hozir torayish ketyaptimi. */
  shrinking: boolean;
  /**
   * Keyingi o'zgarishgacha qolgan vaqt (s): torayishda — maqsadga yetishgacha, kutishda — torayish
   * boshlanishigacha. Oxirgi bosqichda raund tugashigacha qolgan vaqt.
   */
  nextChangeInSec: number;
  /** Boshlangan torayishlar soni (0 = hali butun xarita). */
  stage: number;
  /** Jami torayishlar soni. */
  stageCount: number;
  /** Zonadan tashqarida sekundlik zarar (joriy bosqich). */
  dps: number;
}

/** Zona zarari qancha oraliqda qo'llanadi (s). */
export const ZONE_DAMAGE_INTERVAL_SEC = 0.5;
/** O'yinchi kapsulasining gorizontal radiusi — chegarada turgan o'yinchi hali "ichkarida" hisoblanadi. */
export const ZONE_PLAYER_MARGIN_M = 0.4;
/** Oxirgi aylana radiusi (m). */
export const ZONE_FINAL_RADIUS_M = 14;

/** Bosqich radiuslari xarita yarim kengligiga nisbatan (0-bosqich butun xaritani qoplaydi). */
const RADIUS_FRACTIONS = [1.45, 0.7, 0.42, 0.24] as const;
/** Har bir torayish oldidagi kutish va torayish davomiyligi — raund davomiyligi ulushida (jami 0.85). */
const HOLD_FRACTIONS = [0.22, 0.12, 0.1, 0.06] as const;
const SHRINK_FRACTIONS = [0.12, 0.1, 0.08, 0.05] as const;
/** Bosqich bo'yicha zonadan tashqaridagi zarar (hp/s); indeks = boshlangan torayishlar soni. */
const STAGE_DPS = [2, 4, 7, 11, 15] as const;

/** Umumiy Mulberry32 (`createSeededRng`); urug' 0 bo'lsa 1 ishlatiladi — eski jadval bilan bit-mos. */
function mulberry32(seed: number): () => number {
  return createSeededRng((seed >>> 0) || 1);
}

/**
 * Raund uchun zona jadvalini quradi.
 * @param seed raundga xos deterministik urug'
 * @param roundDurationSec raund davomiyligi (s)
 * @param half xaritaning yarim kengligi (m); markaz (0,0) deb olinadi
 */
export function buildSurvivalZoneTimeline(seed: number, roundDurationSec: number, half: number): SurvivalZoneTimeline {
  const rng = mulberry32(seed);
  const D = Math.max(1, roundDurationSec);
  const radii = [...RADIUS_FRACTIONS.map((f) => f * half), ZONE_FINAL_RADIUS_M];
  const stages: SurvivalZoneStage[] = [];
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < radii.length; i++) {
    const r = radii[i]!;
    if (i > 0) {
      const prev = stages[i - 1]!;
      // Yangi aylana avvalgisining ichida qolsin va asosan xarita ichida bo'lsin
      const maxOffset = Math.max(0, (prev.radius - r) * 0.8);
      const ang = rng() * Math.PI * 2;
      const dist = Math.sqrt(rng()) * maxOffset;
      const lim = Math.max(0, half - r * 0.65);
      cx = Math.max(-lim, Math.min(lim, prev.cx + Math.cos(ang) * dist));
      cz = Math.max(-lim, Math.min(lim, prev.cz + Math.sin(ang) * dist));
    }
    const last = i === radii.length - 1;
    stages.push({
      cx,
      cz,
      radius: r,
      holdSec: last ? Infinity : HOLD_FRACTIONS[i]! * D,
      shrinkSec: last ? 0 : SHRINK_FRACTIONS[i]! * D,
      dps: STAGE_DPS[Math.min(i, STAGE_DPS.length - 1)]!,
    });
  }
  return { stages, roundDurationSec: D };
}

/** Raund boshidan `elapsedSec` o'tgandagi zona holati. */
export function evaluateSurvivalZone(tl: SurvivalZoneTimeline, elapsedSec: number): SurvivalZoneSnap {
  const stages = tl.stages;
  const stageCount = stages.length - 1;
  let t = Math.max(0, elapsedSec);
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]!;
    const next = stages[i + 1];
    if (!next) {
      // Oxirgi aylana: raund tugashigacha ushlab turiladi
      return {
        cx: s.cx,
        cz: s.cz,
        radius: s.radius,
        targetCx: s.cx,
        targetCz: s.cz,
        targetRadius: s.radius,
        shrinking: false,
        nextChangeInSec: Math.max(0, tl.roundDurationSec - elapsedSec),
        stage: stageCount,
        stageCount,
        dps: s.dps,
      };
    }
    if (t < s.holdSec) {
      return {
        cx: s.cx,
        cz: s.cz,
        radius: s.radius,
        targetCx: next.cx,
        targetCz: next.cz,
        targetRadius: next.radius,
        shrinking: false,
        nextChangeInSec: s.holdSec - t,
        stage: i,
        stageCount,
        dps: s.dps,
      };
    }
    t -= s.holdSec;
    if (t < s.shrinkSec) {
      const f = s.shrinkSec > 0 ? t / s.shrinkSec : 1;
      return {
        cx: s.cx + (next.cx - s.cx) * f,
        cz: s.cz + (next.cz - s.cz) * f,
        radius: s.radius + (next.radius - s.radius) * f,
        targetCx: next.cx,
        targetCz: next.cz,
        targetRadius: next.radius,
        shrinking: true,
        nextChangeInSec: s.shrinkSec - t,
        stage: i + 1,
        stageCount,
        dps: next.dps,
      };
    }
    t -= s.shrinkSec;
  }
  // Yetib bo'lmaydigan holat (oxirgi bosqich yuqorida qaytariladi)
  const last = stages[stages.length - 1]!;
  return {
    cx: last.cx,
    cz: last.cz,
    radius: last.radius,
    targetCx: last.cx,
    targetCz: last.cz,
    targetRadius: last.radius,
    shrinking: false,
    nextChangeInSec: 0,
    stage: stageCount,
    stageCount,
    dps: last.dps,
  };
}

/** Nuqta zonadan tashqaridami (o'yinchi radiusi hisobga olinadi). */
export function isOutsideSurvivalZone(zone: SurvivalZoneCircle, x: number, z: number): boolean {
  const dx = x - zone.cx;
  const dz = z - zone.cz;
  return Math.hypot(dx, dz) > zone.radius + ZONE_PLAYER_MARGIN_M;
}

/**
 * Klient tomonida: oxirgi snapshotdan `dtSinceSnap` soniya o'tgandagi taxminiy aylana
 * (torayishda maqsadga chiziqli yaqinlashadi).
 */
export function interpolateSurvivalZone(snap: SurvivalZoneSnap, dtSinceSnap: number): SurvivalZoneCircle {
  if (!snap.shrinking || snap.nextChangeInSec <= 0) {
    return { cx: snap.cx, cz: snap.cz, radius: snap.radius };
  }
  const f = Math.max(0, Math.min(1, dtSinceSnap / snap.nextChangeInSec));
  return {
    cx: snap.cx + (snap.targetCx - snap.cx) * f,
    cz: snap.cz + (snap.targetCz - snap.cz) * f,
    radius: snap.radius + (snap.targetRadius - snap.radius) * f,
  };
}

/** HUD uchun qisqa holat matni. */
export function formatZoneStatusUz(snap: SurvivalZoneSnap): string {
  if (snap.stage >= snap.stageCount && !snap.shrinking) return 'Zona: oxirgi';
  const s = Math.max(0, Math.ceil(snap.nextChangeInSec));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return snap.shrinking ? `Zona torayapti ${mm}:${ss}` : `Zona ${mm}:${ss}`;
}
