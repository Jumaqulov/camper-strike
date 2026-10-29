/**
 * "Tong otguncha" lageri: gulxanlar va o'tin g'aramlari.
 *
 * Gulxan yonib turganda uning atrofidagi doiraga bo'ri kirmaydi (qo'rqadi, chetida aylanib uvlaydi).
 * O'tin vaqt o'tishi bilan tugaydi — o'yinchilar o'rmondagi o'tin g'aramlaridan o'tin olib kelib,
 * gulxanga tashlashi kerak. Gulxan/g'aram joylarini server xarita POI'lari atrofida nav-grafga mos
 * qilib tanlaydi va klientga snapshot (NightSnap.fires / piles) orqali yuboradi — klient hech narsani
 * o'zi hisoblamaydi.
 */

/** Yonib turgan gulxan bo'rini shu radiusda (m) ushlab turadi. */
export const CAMPFIRE_RADIUS_M = 7.5;
/** Gulxan o'tin sig'imi (s), raund boshidagi o'tin, bitta o'tin qo'shadigan vaqt, "o'chmoqda" ogohlantirish chegarasi. */
export const CAMPFIRE_MAX_FUEL_SEC = 180;
export const CAMPFIRE_START_FUEL_SEC = 90;
export const CAMPFIRE_WOOD_FUEL_SEC = 45;
export const CAMPFIRE_LOW_FUEL_SEC = 30;
/** O'yinchi ko'tarib yura oladigan o'tin soni. */
export const WOOD_CARRY_MAX = 3;
/** Bo'shagan o'tin g'arami qayta to'lish vaqti (s) va har olishda beriladigan o'tin. */
export const WOOD_PILE_RESPAWN_SEC = 45;
export const WOOD_PILE_GIVE = 1;
/** O'tin olish / gulxanga tashlash masofasi (m, oyoq nuqtalari orasida). */
export const CAMP_INTERACT_RANGE_M = 2.6;
/** Lagerdagi gulxanlar va o'tin g'aramlari soni (server tanlaydi). */
export const NIGHT_CAMPFIRE_COUNT = 3;
export const NIGHT_WOOD_PILE_COUNT = 12;
/** O'tin g'aramlari eng yaqin gulxandan shu oraliqda (m) va bir-biridan kamida GAP uzoqda joylashadi. */
export const WOOD_PILE_MIN_DIST_M = 16;
export const WOOD_PILE_MAX_DIST_M = 42;
export const WOOD_PILE_GAP_M = 10;
/** O'tin g'arami belgisi (🪵) shu masofadan ko'rinadi (m). */
export const WOOD_PILE_BEACON_RANGE_M = 45;
/** Asosiy lager gulxani atrofida o'yinchilar paydo bo'ladigan halqa radiusi (m). */
export const CAMP_SPAWN_RING_M = 3.2;

/** Gulxan holati (snapshot). */
export interface CampfireSnap {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Qolgan o'tin (s); 0 — o'chgan. */
  fuelSec: number;
  maxFuelSec: number;
  lit: boolean;
  /** Asosiy lager (o'yinchilar shu yerda boshlaydi). */
  main: boolean;
}

/** O'tin g'arami holati (snapshot). */
export interface WoodPileSnap {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Olish mumkinmi (bo'shagan bo'lsa qayta to'lguncha false). */
  available: boolean;
  /** Qayta to'lishgacha (s), faqat bo'sh bo'lsa. */
  respawnInSec?: number;
}

// ---------- Klient → server ----------
export interface TakeWoodReq {
  pileId: string;
}
export interface FeedFireReq {
  fireId: string;
}
export type CampActionError =
  | 'NOT_NIGHT'
  | 'ROUND_NOT_ACTIVE'
  | 'NOT_FOUND'
  | 'TOO_FAR'
  | 'PILE_EMPTY'
  | 'HANDS_FULL'
  | 'NO_WOOD'
  | 'FIRE_FULL'
  | 'DOWNED';
export interface CampActionAck {
  ok: boolean;
  error?: CampActionError;
  /** Amaldan keyin o'yinchidagi o'tin soni. */
  wood: number;
  /** Gulxanga tashlanganda — yangi o'tin zaxirasi (s). */
  fuelSec?: number;
}

export const CAMP_ERROR_MESSAGES_UZ: Record<CampActionError, string> = {
  NOT_NIGHT: "Bu rejimda gulxan yo'q",
  ROUND_NOT_ACTIVE: 'Raund hali boshlanmadi',
  NOT_FOUND: 'Topilmadi',
  TOO_FAR: 'Yaqinroq keling',
  PILE_EMPTY: "G'aram bo'sh — biroz kuting",
  HANDS_FULL: "Qo'lingiz to'la (3 ta o'tin)",
  NO_WOOD: "Sizda o'tin yo'q — g'aramdan oling",
  FIRE_FULL: "Gulxan to'la",
  DOWNED: "Yiqilgan holatda bo'lmaydi — sherigingizni kuting",
};

// ---------- Server → klient hodisasi ----------
/** Gulxan holati o'zgardi: yoqildi/o'chdi/o'tin tashlandi (ovoz va chat uchun). */
export interface CampfireEvent {
  fireId: string;
  kind: 'fed' | 'out' | 'low';
  /** O'tin tashlagan o'yinchi (fed). */
  by?: string;
  byName?: string;
  fuelSec: number;
}

/** Gulxan yonib turibdimi va nuqta uning himoya doirasidami. */
export function isInsideLitCampfire(fire: { x: number; z: number; lit: boolean }, x: number, z: number, margin = 0): boolean {
  return fire.lit && Math.hypot(fire.x - x, fire.z - z) <= CAMPFIRE_RADIUS_M + margin;
}
