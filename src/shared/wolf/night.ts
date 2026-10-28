/**
 * "Tong otguncha" (wolf_night) rejimi — tun davomida bo'ri to'lqinlaridan omon qolish.
 *
 * Raund = tun. Vaqt bo'laklarga bo'lingan: har to'lqinda bo'rilar soni, tezligi va joni oshadi.
 * Tong otganda (taymer tugaganda) barcha tirik ishtirokchilar birgalikda g'olib; hamma o'lsa — bo'rilar yutadi.
 * Xavfsiz zona bu rejimda yo'q. Jadval deterministik: server har tickda `evaluateNightWave` ni chaqiradi.
 */

export const NIGHT_WAVE_COUNT = 4;

export interface NightWave {
  /** 1..NIGHT_WAVE_COUNT */
  wave: number;
  /** Shu to'lqindagi bo'rilar soni (xonadagi bo'rilar shu songa tenglashtiriladi). */
  wolves: number;
  /** Bo'ri yugurish/poylash tezligi ko'paytuvchisi. */
  speedMul: number;
  /** Bo'ri joni ko'paytuvchisi (WOLF_MAX_HP ga nisbatan). */
  hpMul: number;
  /** Tishlash zarari ko'paytuvchisi. */
  biteMul: number;
}

/** To'lqinlar: oxirgisi eng kuchli. Bo'rilar soni WOLF_MAX_PER_ROOM dan oshmasligi kerak. */
export const NIGHT_WAVES: readonly NightWave[] = [
  { wave: 1, wolves: 1, speedMul: 0.92, hpMul: 0.85, biteMul: 1.0 },
  { wave: 2, wolves: 2, speedMul: 1.0, hpMul: 1.0, biteMul: 1.0 },
  { wave: 3, wolves: 3, speedMul: 1.06, hpMul: 1.15, biteMul: 1.1 },
  { wave: 4, wolves: 4, speedMul: 1.12, hpMul: 1.3, biteMul: 1.2 },
];

/** Har to'lqinning boshlanishi — tun davomiyligi ulushida. */
export const NIGHT_WAVE_STARTS: readonly number[] = [0, 0.25, 0.5, 0.75];

/** Tun davomiyligi chegaralari (daqiqa): lobbida tanlanadi, standart 8. */
export const NIGHT_DEFAULT_MINUTES = 8;
export const NIGHT_MIN_MINUTES = 3;
export const NIGHT_MAX_MINUTES = 20;

import type { CampfireSnap, WoodPileSnap } from './camp';

/** Klientga yuboriladigan tun holati (SurvivalStateSnap.night). */
export interface NightSnap {
  wave: number;
  waveCount: number;
  wolvesAlive: number;
  /** Keyingi to'lqingacha (s); oxirgi to'lqinda tong otguncha qolgan vaqt. */
  nextWaveInSec: number;
  /** Tong otguncha qolgan vaqt (s). */
  dawnInSec: number;
  /** Lager gulxanlari (server tanlagan joylar, o'tin holati bilan). */
  fires: CampfireSnap[];
  /** O'tin g'aramlari. */
  piles: WoodPileSnap[];
}

export interface NightWaveEval {
  wave: NightWave;
  /** Keyingi to'lqin boshlanishigacha (s); oxirgi to'lqinda — tonggacha. */
  nextWaveInSec: number;
  dawnInSec: number;
}

/** Tun boshidan `elapsedSec` o'tgandagi to'lqin. */
export function evaluateNightWave(elapsedSec: number, durationSec: number): NightWaveEval {
  const D = Math.max(1, durationSec);
  const t = Math.max(0, Math.min(D, elapsedSec));
  let idx = 0;
  for (let i = 0; i < NIGHT_WAVE_STARTS.length; i++) {
    if (t >= NIGHT_WAVE_STARTS[i]! * D) idx = i;
  }
  const wave = NIGHT_WAVES[Math.min(idx, NIGHT_WAVES.length - 1)]!;
  const nextStart = idx + 1 < NIGHT_WAVE_STARTS.length ? NIGHT_WAVE_STARTS[idx + 1]! * D : D;
  return { wave, nextWaveInSec: Math.max(0, nextStart - t), dawnInSec: Math.max(0, D - t) };
}

/** HUD uchun qisqa holat matni. */
export function formatNightStatusUz(n: NightSnap): string {
  const mm = Math.floor(n.dawnInSec / 60);
  const ss = String(Math.floor(n.dawnInSec % 60)).padStart(2, '0');
  return `Tonggacha ${mm}:${ss} · ${n.wave}/${n.waveCount}-to'lqin · Bo'ri: ${n.wolvesAlive}`;
}
