import { isWolfThreatState, wolfCoatTraits, type WolfState } from '../../../shared/wolf';

/**
 * Bo'ri xavfi (HUD banneri) va ovoz eshitilish masofasi — bo'ri turiga qarab. "Tun soyasi" (stealthy)
 * sezdirmay keladi: nafas/irillash yaqindan eshitiladi, "yaqinda bo'ri" ogohlantirishi kechroq yonadi.
 * Sof funksiyalar (DOM/Three yo'q) — testlanadi.
 */

/** Oddiy bo'ri: shu masofada (m) har qanday holatda "yaqinda bo'ri". */
export const WOLF_WARN_NEAR_DIST = 14;
/** Hushyor / poylayotgan / ovdagi bo'ri shu masofadan ogohlantiradi. */
export const WOLF_WARN_ALERT_DIST = 26;
/** Soya: ogohlantirish masofalari shu ko'paytuvchi bilan qisqaradi. */
export const WOLF_STEALTH_WARN_MUL = 0.5;
/** Soya sizni quvayotganini HUD faqat shu masofada (m) bildiradi — undan uzoqda u ko'rinmas ovchi. */
export const WOLF_STEALTH_HUNT_WARN_DIST = 18;
/** Soyaning doimiy ovozlari (nafas, irillash) eshitilish masofasi ko'paytuvchisi. */
export const WOLF_STEALTH_AUDIO_MUL = 0.45;

export type WolfWarnLevel = '' | 'near' | 'hunt';

export interface WolfThreatView {
  x: number;
  z: number;
  state: WolfState;
  targetId: string | null;
  alive: boolean;
  coat?: number;
}

export interface WolfWarning {
  level: WolfWarnLevel;
  /** 'hunt' bo'lsa — quvayotgan bo'ri turi nomi (`wolfCoatTraits(coat).nameUz`). */
  nameUz: string | null;
}

/** Bo'ri doimiy ovozlari eshitilish masofasi ko'paytuvchisi (soya — qisqa). */
export function wolfAudioRangeMul(coat: number | undefined): number {
  return wolfCoatTraits(coat).stealthy ? WOLF_STEALTH_AUDIO_MUL : 1;
}

/**
 * HUD ogohlantirishi: 'hunt' — tirik bo'ri meni quvyapti (soya — faqat yaqin bo'lsa), 'near' — bo'ri yaqinda
 * (soya — qisqaroq masofada). Qochayotgan ('flee', tong otdi) va o'lik bo'rilar e'tiborga olinmaydi.
 */
export function wolfWarningFor(
  wolves: Iterable<WolfThreatView>,
  me: { x: number; z: number; alive: boolean },
  myId: string,
): WolfWarning {
  if (!me.alive) return { level: '', nameUz: null };
  let near = false;
  for (const w of wolves) {
    if (!w.alive || w.state === 'flee' || w.state === 'dead') continue;
    const traits = wolfCoatTraits(w.coat);
    const d = Math.hypot(w.x - me.x, w.z - me.z);
    if (w.targetId === myId && isWolfThreatState(w.state) && (!traits.stealthy || d < WOLF_STEALTH_HUNT_WARN_DIST)) {
      return { level: 'hunt', nameUz: traits.nameUz };
    }
    const mul = traits.stealthy ? WOLF_STEALTH_WARN_MUL : 1;
    const alerted = w.state === 'alert' || w.state === 'stalk' || w.state === 'hunt';
    if (d < WOLF_WARN_NEAR_DIST * mul || (alerted && d < WOLF_WARN_ALERT_DIST * mul)) near = true;
  }
  return { level: near ? 'near' : '', nameUz: null };
}
