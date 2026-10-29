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
/**
 * O'tinning og'irligi: qo'ldagi o'tin soniga (0..WOOD_CARRY_MAX) ko'ra yurish tezligi ko'paytuvchisi.
 * WOOD_CARRY_MAX ta o'tin bilan sprint umuman yo'q (`computeWishVelocity` / `stepPlayerMovement` — server va
 * klient bashorati bir xil hisoblaydi).
 */
export const WOOD_SPEED_MUL: readonly number[] = [1, 0.97, 0.93, 0.88];
export function woodSpeedMul(wood: number | undefined): number {
  const n = Number.isFinite(wood as number) ? Math.floor(wood as number) : 0;
  const w = Math.max(0, Math.min(WOOD_CARRY_MAX, n));
  return WOOD_SPEED_MUL[w] ?? WOOD_SPEED_MUL[WOOD_SPEED_MUL.length - 1]!;
}
/** To'la qo'l (WOOD_CARRY_MAX o'tin) — sprint bloklanadi. */
export function woodBlocksSprint(wood: number | undefined): boolean {
  return (wood ?? 0) >= WOOD_CARRY_MAX;
}

// ---------- Mash'al ----------
/** Mash'al yonish vaqti (s). */
export const TORCH_BURN_SEC = 40;
/** Mash'al olish gulxandan shuncha o'tin (s) oladi; gulxan o'tini shundan kam/teng bo'lsa olib bo'lmaydi. */
export const TORCH_FUEL_COST_SEC = 10;
/** Bo'rilar mash'al ko'targan o'yinchiga shu radiusdan (m) yaqin kelmaydi (kichik "ko'chma gulxan"). */
export const TORCH_FEAR_RADIUS_M = 4;
/** Bo'ri mash'al ko'targanning atrofida shu masofada (m, markazdan) to'xtab aylanadi. */
export const TORCH_STANDOFF_M = TORCH_FEAR_RADIUS_M + 1.0;
/** Bo'ri yonib turgan gulxan doirasidan tashqarida, shu masofada (markazdan) to'xtab aylanadi (m). */
export const CAMPFIRE_STANDOFF_M = CAMPFIRE_RADIUS_M + 1.5;
/** Mash'al bilan ishlatish mumkin bo'lgan qurollar (bir qo'l band): pichoq va to'pponcha. */
export const TORCH_ALLOWED_WEAPONS: readonly string[] = ['knife', 'pistol'];
export function isTorchWeapon(w: string | null | undefined): boolean {
  return w === 'knife' || w === 'pistol';
}
export const TORCH_WEAPON_MESSAGE_UZ = "Mash'al bilan faqat pichoq yoki to'pponcha";
export const WOOD_HEAVY_MESSAGE_UZ = "Og'ir yuk — yugura olmaysiz";
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

/** Gulxan nomlari (tartib: asosiy, keyin raqamli lagerlar); HUD indikatorlari va ogohlantirishlarda ishlatiladi. */
export const CAMP_FIRE_NAMES_UZ: readonly string[] = ['Asosiy lager', '2-lager', '3-lager', '4-lager', '5-lager'];

/** Gulxan nomi (0-indeks — asosiy). */
export function campFireNameUz(index: number): string {
  return CAMP_FIRE_NAMES_UZ[index] ?? `${index + 1}-lager`;
}

/** Gulxan holati (snapshot). */
export interface CampfireSnap {
  id: string;
  /** Nomi ("Asosiy lager", "2-lager", ...). Eski server yubormasa klient asosiy/id bo'yicha tuzadi. */
  name?: string;
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
/** Yonib turgan gulxandan mash'al olish ('night:takeTorch'). */
export interface TakeTorchReq {
  fireId: string;
}
/** Qo'ldagi mash'alni muddatidan oldin tashlash ('night:dropTorch', so'rov tanasi bo'sh). */
export type DropTorchReq = Record<string, never>;
export type CampActionError =
  | 'NOT_NIGHT'
  | 'ROUND_NOT_ACTIVE'
  | 'NOT_FOUND'
  | 'TOO_FAR'
  | 'PILE_EMPTY'
  | 'HANDS_FULL'
  | 'NO_WOOD'
  | 'FIRE_FULL'
  | 'DOWNED'
  | 'FIRE_OUT'
  | 'FIRE_LOW'
  | 'HAS_TORCH'
  | 'NO_TORCH';
export interface CampActionAck {
  ok: boolean;
  error?: CampActionError;
  /** Amaldan keyin o'yinchidagi o'tin soni. */
  wood: number;
  /** Gulxanga tashlanganda / mash'al olinganda — gulxanning yangi o'tin zaxirasi (s). */
  fuelSec?: number;
  /** Mash'al amallari: qo'ldagi mash'alning qolgan vaqti (s); 0 — mash'al yo'q. */
  torchSec?: number;
  /** Mash'al olinganda server qurolni almashtirgan bo'lsa — yangi joriy qurol (klient ham shunga o'tadi). */
  weapon?: string | null;
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
  FIRE_OUT: "Gulxan o'chgan — mash'al yoqib bo'lmaydi",
  FIRE_LOW: 'Gulxan juda kuchsiz',
  HAS_TORCH: "Sizda allaqachon mash'al bor",
  NO_TORCH: "Sizda mash'al yo'q",
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
