import { wolfCoatTraits } from '../../../shared/wolf';

/**
 * "Tun soyasi" (qora bo'ri, `stealthy`) qorong'ida yaxshi yashirinadi: ko'zlari boshqa bo'rilardek mayoq bo'lib
 * yonmaydi (faqat yaqinda xira ko'rinadi), mo'ynasi yorug'likni kamroq qaytaradi, uvlashi HUD strelkasi va
 * mini-xarita belgisi bilan aniq joyini oshkor qilmaydi. Ovoz tomoni — `wolfAudioRangeMul` (wolfThreat.ts).
 * Sof funksiyalar (DOM/Three yo'q) — testlanadi.
 */

/** Soya ko'zlari: shu masofagacha (m) eng yorqin (`WOLF_STEALTH_EYE_NEAR`), undan nari so'nib boradi. */
export const WOLF_STEALTH_EYE_NEAR_M = 5;
/** Shu masofadan (m) nari ko'zlar deyarli ko'rinmaydi (`WOLF_STEALTH_EYE_FAR`). */
export const WOLF_STEALTH_EYE_FAR_M = 14;
/** Soya ko'zlari emissive yorqinligi: yaqinda / uzoqda (oddiy bo'ri — 4, to'da boshlig'i — 7; GLB `wolf_eyes`). */
export const WOLF_STEALTH_EYE_NEAR = 1;
export const WOLF_STEALTH_EYE_FAR = 0.12;
/** Soya mo'ynasi rangi ko'paytuvchisi (vertex ranglar ustidan): och tumshug'i/ko'kragi olov yorug'ida porlamasin. */
export const WOLF_STEALTH_FUR_TINT = 0.7;

/**
 * Soya ko'zlarining emissive yorqinligi kameragacha masofa (m) bo'yicha: `WOLF_STEALTH_EYE_NEAR_M` gacha
 * `WOLF_STEALTH_EYE_NEAR`, `WOLF_STEALTH_EYE_FAR_M` dan nari `WOLF_STEALTH_EYE_FAR`, oraliqda chiziqli.
 * Noma'lum masofa (NaN/∞) — uzoq (xira).
 */
export function wolfStealthEyeGlow(camDist: number): number {
  if (!Number.isFinite(camDist)) return WOLF_STEALTH_EYE_FAR;
  const k = (camDist - WOLF_STEALTH_EYE_NEAR_M) / (WOLF_STEALTH_EYE_FAR_M - WOLF_STEALTH_EYE_NEAR_M);
  const u = Math.min(1, Math.max(0, k));
  return WOLF_STEALTH_EYE_NEAR + (WOLF_STEALTH_EYE_FAR - WOLF_STEALTH_EYE_NEAR) * u;
}

/**
 * Uvlash HUD strelkasi va mini-xarita belgisi bilan bo'ri joyini ko'rsatadimi: soya — yo'q (uvlashi faqat
 * eshitiladi), qolganlari (va noma'lum bo'ri) — ha.
 */
export function wolfHowlRevealsPosition(coat: number | undefined): boolean {
  return !wolfCoatTraits(coat).stealthy;
}
