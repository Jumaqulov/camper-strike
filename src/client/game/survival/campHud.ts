/**
 * "Tong otguncha" lager HUD'ining sof qismi (DOM'siz, Node'da testlanadi):
 * - gulxan indikatorlari qatori (uchala gulxan: nom, olov holati, o'tin m:ss, yo'nalish strelkasi, masofa);
 * - o'yinchi qarashiga nisbatan yo'nalish (kompas strelkasi va uvlash indikatori uchun);
 * - ogohlantirish banneri uchun "eng yomon" gulxanni tanlash va matni.
 */
import { angleDiff } from '../../../shared/math';
import { CAMPFIRE_LOW_FUEL_SEC, CAMP_FIRE_NAMES_UZ } from '../../../shared/wolf/camp';

/** Game har kadr `camp.getFires()` dan tuzib beradi (bearing — o'yinchi yaw'iga nisbatan, rad). */
export interface FireIndicatorInput {
  id: string;
  name: string;
  main: boolean;
  lit: boolean;
  fuelSec: number;
  bearingRad: number;
  distM: number;
}

export type FireIndicatorState = 'ok' | 'low' | 'out';

/** Chizish uchun tayyor qator elementi (matnlar qochirilmagan — SurvivalUI esc qiladi). */
export interface FireIndicatorView {
  id: string;
  main: boolean;
  state: FireIndicatorState;
  /** Qisqa nom: "Asosiy", "2-lager". */
  tag: string;
  /** To'liq nom (title uchun). */
  name: string;
  /** "2:30" yoki "—" (o'chgan). */
  fuelText: string;
  /** "34 m". */
  distText: string;
  /** Strelka burilishi (CSS/SVG, gradus, butun son): 0 — oldinda, musbat — soat yo'nalishi (o'ngda). */
  arrowDeg: number;
}

/**
 * `to` nuqtaning `from` dagi kuzatuvchi (yaw — three.js YXZ, 0 = -Z, musbat = chapga burilish) ga nisbatan
 * yo'nalishi, rad, (-π, π]: 0 — to'g'ri oldinda, musbat — chapda, manfiy — o'ngda. Zarar indikatori bilan bir xil.
 */
export function bearingToward(from: { x: number; z: number }, to: { x: number; z: number }, yaw: number): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
  return angleDiff(yaw, Math.atan2(-dx, -dz));
}

/** Ekrandagi strelka burilishi (gradus, soat yo'nalishi musbat): chapdagi nishon → manfiy gradus. */
export function bearingToArrowDeg(bearingRad: number): number {
  // `|| 0` — -0 ni 0 ga keltiradi; -180 va 180 bir xil — barqaror kalit uchun 180
  const deg = Math.round((-bearingRad * 180) / Math.PI) || 0;
  return deg === -180 ? 180 : deg;
}

/** Qisqa nom: nomning birinchi so'zi ("Asosiy lager" → "Asosiy", "2-lager" → "2-lager"). */
export function fireShortNameUz(name: string, main: boolean): string {
  const w = (name || '').trim().split(/\s+/)[0] ?? '';
  if (w) return w;
  return main ? (CAMP_FIRE_NAMES_UZ[0] ?? 'Asosiy').split(/\s+/)[0]! : 'Lager';
}

export function fireIndicatorState(f: { lit: boolean; fuelSec: number }): FireIndicatorState {
  if (!f.lit || f.fuelSec <= 0) return 'out';
  return f.fuelSec <= CAMPFIRE_LOW_FUEL_SEC ? 'low' : 'ok';
}

/** O'tin vaqti "m:ss" (pastga yaxlitlanadi). */
export function formatFuelMmSs(fuelSec: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(fuelSec) ? fuelSec : 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Gulxanlar qatori: asosiy birinchi, qolganlari id bo'yicha (fire:1, fire:2, ...). */
export function formatFireIndicatorsUz(fires: readonly FireIndicatorInput[]): FireIndicatorView[] {
  return [...fires]
    .sort((a, b) => (a.main === b.main ? a.id.localeCompare(b.id, 'en', { numeric: true }) : a.main ? -1 : 1))
    .map((f) => {
      const state = fireIndicatorState(f);
      return {
        id: f.id,
        main: f.main,
        state,
        tag: fireShortNameUz(f.name, f.main),
        name: f.name,
        fuelText: state === 'out' ? '—' : formatFuelMmSs(f.fuelSec),
        distText: `${Math.max(0, Math.round(Number.isFinite(f.distM) ? f.distM : 0))} m`,
        arrowDeg: bearingToArrowDeg(f.bearingRad),
      };
    });
}

/**
 * Ogohlantirish banneri uchun gulxan: o'chgan o'chayotgandan yomon; teng holatda asosiy gulxan birinchi,
 * keyin id tartibi. Hamma yonib tursa va o'tin yetarli bo'lsa — null.
 */
export function pickCampWarningFire<T extends { id: string; main: boolean; lit: boolean; fuelSec: number }>(
  fires: readonly T[],
): { fire: T; level: 'low' | 'out' } | null {
  let best: { fire: T; level: 'low' | 'out'; rank: number } | null = null;
  for (const f of fires) {
    const state = fireIndicatorState(f);
    if (state === 'ok') continue;
    const rank = (state === 'out' ? 2 : 0) + (f.main ? 1 : 0);
    if (!best || rank > best.rank || (rank === best.rank && f.id.localeCompare(best.fire.id, 'en', { numeric: true }) < 0)) {
      best = { fire: f, level: state, rank };
    }
  }
  return best ? { fire: best.fire, level: best.level } : null;
}

/** Banner matni: "ASOSIY GULXAN O'CHMOQDA — O'TIN KELTIRING!", "2-LAGER GULXANI O'CHDI — BO'RILAR KELMOQDA!". */
export function campWarningTextUz(level: 'low' | 'out', fireName: string, main: boolean): string {
  const who = main ? 'ASOSIY GULXAN' : `${fireShortNameUz(fireName, main).toUpperCase()} GULXANI`;
  return level === 'out' ? `${who} O'CHDI — BO'RILAR KELMOQDA!` : `${who} O'CHMOQDA — O'TIN KELTIRING!`;
}
