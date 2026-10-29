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

/** Qanot (orqadan aylanib kelayotgan, ovdagi bo'ri) shu masofadan (m) ogohlantiradi. */
export const WOLF_FLANK_WARN_DIST = 18;

export type WolfWarnLevel = '' | 'near' | 'hunt' | 'flank';

export interface WolfThreatView {
  x: number;
  z: number;
  state: WolfState;
  targetId: string | null;
  alive: boolean;
  coat?: number;
  /** To'dadagi vazifa (snapshot `WolfSnap.role`): 'd' — haydovchi, 'f' — qanot. */
  role?: 'd' | 'f';
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
 * HUD ogohlantirishi: 'flank' — meni ovlayotgan bo'ri (stalk/hunt/attack) 18 m ichida orqamda (`me.yaw` berilsa;
 * to'da qanoti — orqamdagi nuqtada 'stalk' da poylab turganda ham), 'hunt' — tirik bo'ri meni quvyapti (soya — faqat
 * yaqin bo'lsa), 'near' — bo'ri yaqinda (soya — qisqaroq masofada). Qochayotgan ('flee', tong otdi) va o'lik bo'rilar
 * e'tiborga olinmaydi.
 */
export function wolfWarningFor(
  wolves: Iterable<WolfThreatView>,
  me: { x: number; z: number; alive: boolean; yaw?: number },
  myId: string,
): WolfWarning {
  if (!me.alive) return { level: '', nameUz: null };
  let near = false;
  let hunt: WolfWarning | null = null;
  for (const w of wolves) {
    if (!w.alive || w.state === 'flee' || w.state === 'dead') continue;
    const traits = wolfCoatTraits(w.coat);
    const dx = w.x - me.x;
    const dz = w.z - me.z;
    const d = Math.hypot(dx, dz);
    if (w.targetId === myId && isWolfThreatState(w.state) && (!traits.stealthy || d < WOLF_STEALTH_HUNT_WARN_DIST)) {
      // Holat bo'yicha ajratilmaydi: qanot orqa nuqtasida 'stalk' ga cho'kkanda banner 'hunt' ga sakramasin
      if (
        me.yaw !== undefined &&
        d < WOLF_FLANK_WARN_DIST &&
        d > 1e-3 &&
        // O'yinchi old yo'nalishi (-sin yaw, -cos yaw) bilan dot < 0 — bo'ri orqada
        (-Math.sin(me.yaw) * dx - Math.cos(me.yaw) * dz) / d < 0
      ) {
        return { level: 'flank', nameUz: traits.nameUz };
      }
      hunt ??= { level: 'hunt', nameUz: traits.nameUz };
      continue;
    }
    const mul = traits.stealthy ? WOLF_STEALTH_WARN_MUL : 1;
    const alerted = w.state === 'alert' || w.state === 'stalk' || w.state === 'hunt';
    if (d < WOLF_WARN_NEAR_DIST * mul || (alerted && d < WOLF_WARN_ALERT_DIST * mul)) near = true;
  }
  if (hunt) return hunt;
  return { level: near ? 'near' : '', nameUz: null };
}

/**
 * HUD banneri: `wolfWarningFor`, lekin raund tugagach (`MatchState.phase` 'ended' — tong epilogi va natija ekrani
 * ham) hech narsa. Tongda bo'rilar avval 'idle'/'howl' da turadi (tishlamaydi, keyin qochadi), o'yinchi qotgan —
 * "Yaqinda bo'ri bor · sekin yuring" "Tong otdi!" belgisi ustida chiqmasin.
 */
export function wolfHudWarning(
  roundPhase: string | null | undefined,
  wolves: Iterable<WolfThreatView>,
  me: { x: number; z: number; alive: boolean; yaw?: number },
  myId: string,
): WolfWarning {
  if (roundPhase === 'ended') return { level: '', nameUz: null };
  return wolfWarningFor(wolves, me, myId);
}
