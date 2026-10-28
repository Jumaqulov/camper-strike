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
  { wave: 1, wolves: 2, speedMul: 0.95, hpMul: 0.9, biteMul: 1.0 },
  { wave: 2, wolves: 3, speedMul: 1.03, hpMul: 1.05, biteMul: 1.1 },
  { wave: 3, wolves: 4, speedMul: 1.1, hpMul: 1.25, biteMul: 1.2 },
  { wave: 4, wolves: 6, speedMul: 1.18, hpMul: 1.45, biteMul: 1.3 },
];
/** Tunda o'ldirilgan bo'ri shuncha soniyadan keyin qaytadan keladi (klassik rejimdagi 25 s dan tezroq). */
export const WOLF_NIGHT_RESPAWN_SEC = 14;

// ---------- Qiyinlik va ishtirokchilar soniga moslash ----------

/** Lobbida tanlanadigan tun qiyinligi. */
export type NightDifficulty = 'easy' | 'normal' | 'hard';
export const NIGHT_DIFFICULTY_IDS: readonly NightDifficulty[] = ['easy', 'normal', 'hard'];
export const NIGHT_DEFAULT_DIFFICULTY: NightDifficulty = 'normal';

export interface NightDifficultyPreset {
  id: NightDifficulty;
  nameUz: string;
  /** To'lqindagi bo'rilar soni ko'paytuvchisi (ishtirokchilar soniga moslashdan keyin). */
  wolvesMul: number;
  /** To'lqin ko'paytuvchilari ustidan qo'shimcha ko'paytuvchilar. */
  speedMul: number;
  hpMul: number;
  biteMul: number;
  /** O'ldirilgan bo'rining qaytish vaqti (s). */
  respawnSec: number;
}

export const NIGHT_DIFFICULTIES: Readonly<Record<NightDifficulty, NightDifficultyPreset>> = {
  easy: { id: 'easy', nameUz: 'Oson', wolvesMul: 0.7, speedMul: 0.92, hpMul: 0.85, biteMul: 0.75, respawnSec: 20 },
  normal: { id: 'normal', nameUz: "O'rta", wolvesMul: 1, speedMul: 1, hpMul: 1, biteMul: 1, respawnSec: WOLF_NIGHT_RESPAWN_SEC },
  hard: { id: 'hard', nameUz: 'Qiyin', wolvesMul: 1.3, speedMul: 1.06, hpMul: 1.2, biteMul: 1.25, respawnSec: 10 },
};

/** Noma'lum qiymat → standart qiyinlik. */
export function sanitizeNightDifficulty(v: unknown): NightDifficulty {
  return typeof v === 'string' && (NIGHT_DIFFICULTY_IDS as readonly string[]).includes(v)
    ? (v as NightDifficulty)
    : NIGHT_DEFAULT_DIFFICULTY;
}

/** wolf_night xonasidagi bo'rilar chegarasi (klassik rejimlardagi WOLF_MAX_PER_ROOM dan katta). */
export const NIGHT_WOLF_CAP = 8;

/**
 * To'lqindagi bo'rilar soni: jadval (NIGHT_WAVES, ~3 ishtirokchi uchun sozlangan) × ishtirokchilar soni
 * omili × qiyinlik. `contenders` — to'lqin boshlangan paytdagi tirik ishtirokchilar (odam + bot), kamida 1.
 * Natija 1..NIGHT_WOLF_CAP.
 */
export function nightWolvesForWave(wave: NightWave, contenders: number, difficulty: NightDifficulty): number {
  const n = Math.max(1, Math.floor(contenders));
  const playersFactor = Math.min(1.7, Math.max(0.7, 0.6 + 0.13 * n));
  const raw = wave.wolves * playersFactor * NIGHT_DIFFICULTIES[difficulty].wolvesMul;
  return Math.min(NIGHT_WOLF_CAP, Math.max(1, Math.round(raw)));
}

// ---------- Tong otishi ----------

/** Tun oxiridagi shuncha soniyada osmon asta yorishadi (klient yorug'lik/osmon interpolyatsiyasi). */
export const NIGHT_DAWN_TRANSITION_SEC = 60;
/** Tong otgach bo'rilar shuncha soniya ichida o'rmonga qochib, keyin yo'qoladi (yakun ekrani davomida). */
export const WOLF_DAWN_FLEE_SEC = 7;

/** Tong otish darajasi 0 (tun) .. 1 (tong): oxirgi NIGHT_DAWN_TRANSITION_SEC da chiziqli o'sadi. */
export function nightDawnProgress(dawnInSec: number): number {
  if (!Number.isFinite(dawnInSec)) return 0;
  return Math.min(1, Math.max(0, 1 - dawnInSec / NIGHT_DAWN_TRANSITION_SEC));
}

// ---------- Raund natijasi: shaxsiy statistika va mukofotlar ----------

/** Bitta ishtirokchining tun statistikasi (server raund davomida yig'adi). */
export interface NightPlayerStats {
  id: string;
  name: string;
  isBot: boolean;
  /** O'ldirgan bo'rilari (to'da boshlig'i ham kiradi). */
  wolfKills: number;
  /** O'ldirgan to'da boshliqlari (oq bo'ri). */
  alphaKills: number;
  /** Bo'rilarga bergan zarari (hp). */
  wolfDamage: number;
  /** Gulxanlarga tashlagan o'tinlari. */
  logsFed: number;
  /** O'chgan gulxanni qayta yoqgan marta. */
  relights: number;
  /** Tong otganda tirikmi. */
  survived: boolean;
}

export type NightAwardKind = 'mvp' | 'hunter' | 'woodsman' | 'firekeeper';

export interface NightAward {
  kind: NightAwardKind;
  playerId: string;
  playerName: string;
  /** Mukofot asosidagi qiymat (mvp — ball, hunter — bo'rilar, woodsman — o'tinlar, firekeeper — qayta yoqishlar). */
  value: number;
  titleUz: string;
}

/** Tun oxirida yuboriladigan natija (SurvivalStateSnap.nightSummary, faqat 'ended' fazasida). */
export interface NightRoundSummary {
  difficulty: NightDifficulty;
  /** Tong otdimi (aks holda bo'rilar yutdi). */
  dawn: boolean;
  /** Ball bo'yicha kamayish tartibida. */
  stats: NightPlayerStats[];
  awards: NightAward[];
}

export const NIGHT_AWARD_TITLES_UZ: Readonly<Record<NightAwardKind, string>> = {
  mvp: 'Tun qahramoni',
  hunter: "Bo'ri ovchisi",
  woodsman: "Eng yaxshi o'tinchi",
  firekeeper: "Olov qo'riqchisi",
};

/** MVP balli: bo'ri ×3 (boshliq yana +3), o'tin ×2, qayta yoqish ×3, tongga yetish +4, zarar /100. */
export function nightPlayerScore(s: NightPlayerStats): number {
  return s.wolfKills * 3 + s.alphaKills * 3 + s.logsFed * 2 + s.relights * 3 + (s.survived ? 4 : 0) + Math.floor(s.wolfDamage / 100);
}

/**
 * Statistikani ball bo'yicha saralaydi va mukofotlarni tanlaydi. Mukofot qiymati 0 bo'lsa berilmaydi;
 * teng qiymatda ball, keyin `stats` dagi tartib (barqaror) hal qiladi. Sof funksiya — server va testlar uchun.
 */
export function computeNightSummary(stats: readonly NightPlayerStats[], difficulty: NightDifficulty, dawn: boolean): NightRoundSummary {
  const sorted = stats
    .map((s, i) => ({ s, i, score: nightPlayerScore(s) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const pick = (kind: NightAwardKind, value: (s: NightPlayerStats) => number): NightAward | null => {
    let best: { s: NightPlayerStats; v: number } | null = null;
    for (const e of sorted) {
      const v = value(e.s);
      if (v > 0 && (!best || v > best.v)) best = { s: e.s, v };
    }
    return best ? { kind, playerId: best.s.id, playerName: best.s.name, value: best.v, titleUz: NIGHT_AWARD_TITLES_UZ[kind] } : null;
  };
  const awards = [
    pick('mvp', nightPlayerScore),
    pick('hunter', (s) => s.wolfKills),
    pick('woodsman', (s) => s.logsFed),
    pick('firekeeper', (s) => s.relights),
  ].filter((a): a is NightAward => a !== null);
  return { difficulty, dawn, stats: sorted.map((e) => e.s), awards };
}

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
