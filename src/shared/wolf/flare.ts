/**
 * "Tong otguncha": yarim tungi yordam yuki va signal raketasi (klient–server umumiy kontraktlar).
 *
 * Yordam yuki — 3-to'lqin boshida (tunning 50 %) server asosiy gulxandan 35–70 m narida, g'aramlar va
 * gulxanlardan ≥ 12 m uzoqda, ochiq osmon ostidagi nav tuguniga `supply_crate` konteynerini tushiradi
 * (runtime konteyner — xarita ta'rifiga kirmaydi, gameplayHash o'zgarmaydi). Ichida: qurol (avtomat yoki
 * drobovik), 2 quti o'q, aptechka, granata va 2 signal raketasi.
 *
 * Signal raketasi — kam uchraydigan loot buyumi (`item:flare`). Otilganda ([X]) o'yinchi turgan joyda
 * FLARE_DURATION_SEC davomida bo'rilar kirmaydigan FLARE_FEAR_RADIUS_M doira paydo bo'ladi, FLARE_SCARE_RADIUS_M
 * ichidagi bo'rilar FLARE_SCARE_SEC qochadi; to'da raketa doirasidagi o'yinchini nishon qilmaydi.
 */

// ---------- Yordam yuki ----------
/** Yordam yuki tushadigan to'lqin (1-asos). */
export const SUPPLY_DROP_WAVE = 3;
/** Asosiy gulxandan masofa oralig'i (m). */
export const SUPPLY_DROP_MIN_DIST_M = 35;
export const SUPPLY_DROP_MAX_DIST_M = 70;
/** O'tin g'aramlari va gulxanlardan eng kam masofa (m). */
export const SUPPLY_DROP_CLEAR_M = 12;
/** Qizil tutun/mayoq ustuni ko'rinib turish vaqti (s) — quti ochilsa so'nadi. */
export const SUPPLY_BEACON_SEC = 90;
/** Yordam yuki konteyneri identifikatori prefiksi (`supply:r<round>`). */
export const SUPPLY_CONTAINER_PREFIX = 'supply:';
export function isSupplyContainerId(id: string): boolean {
  return id.startsWith(SUPPLY_CONTAINER_PREFIX);
}

/** Server → klient: yordam yuki tushdi (ovoz, banner, mini-xarita belgisi, mayoq). */
export interface NightSupplyDropEvent {
  id: string;
  x: number;
  y: number;
  z: number;
}

/** NightSnap.supply: yordam yuki holati (kech qo'shilganlar/kuzatuvchilar uchun ham). */
export interface NightSupplySnap {
  id: string;
  x: number;
  y: number;
  z: number;
  opened: boolean;
}

// ---------- Signal raketasi ----------
/** Raketa doirasi (m): bo'ri kirmaydi, nishon olmaydi. */
export const FLARE_FEAR_RADIUS_M = 30;
/** Bo'ri raketa doirasi chetida to'xtaydigan masofa (m, markazdan). */
export const FLARE_STANDOFF_M = FLARE_FEAR_RADIUS_M + 2;
/** Raketa yonib turish vaqti (s). */
export const FLARE_DURATION_SEC = 20;
/** Otilgan paytda shu radiusdagi (m) bo'rilar qochadi. */
export const FLARE_SCARE_RADIUS_M = 45;
/** Qo'rqib qochish vaqti (s). */
export const FLARE_SCARE_SEC = 20;
/** Bir o'yinchi ikki raketa orasidagi eng kam oraliq (s) — spamga qarshi. */
export const FLARE_USE_COOLDOWN_SEC = 3;
/** Bot raketani shu oraliqda (s) qayta ishlatmaydi. */
export const BOT_FLARE_COOLDOWN_SEC = 30;
/** Bot raketa otadi: ovlayotgan bo'ri shu masofadan (m) yaqin, yaqinda (m) yonib turgan gulxan yo'q. */
export const BOT_FLARE_WOLF_DIST_M = 6;
export const BOT_FLARE_NO_FIRE_M = 10;

/** Klient → server: signal raketasini otish ('night:useFlare', so'rov tanasi bo'sh). */
export type UseFlareReq = Record<string, never>;
export type FlareError = 'NOT_NIGHT' | 'ROUND_NOT_ACTIVE' | 'DOWNED' | 'NO_FLARE' | 'COOLDOWN' | 'NOT_FOUND';
export interface UseFlareAck {
  ok: boolean;
  error?: FlareError;
  /** Amaldan keyin qolgan raketalar. */
  flares: number;
  /** Raketa so'nish vaqti (server vaqti, s). */
  until?: number;
}
export const FLARE_ERROR_MESSAGES_UZ: Record<FlareError, string> = {
  NOT_NIGHT: "Bu rejimda signal raketasi yo'q",
  ROUND_NOT_ACTIVE: 'Hozir raketa otib bo‘lmaydi',
  DOWNED: "Yiqilgan holatda bo'lmaydi — sherigingizni kuting",
  NO_FLARE: "Sizda signal raketasi yo'q",
  COOLDOWN: 'Biroz kuting',
  NOT_FOUND: 'Topilmadi',
};

/** Server → klient: raketa otildi (vizual, ovoz, HUD pilli). */
export interface NightFlareEvent {
  id: string;
  x: number;
  y: number;
  z: number;
  byId: string;
  byName: string;
  /** So'nish vaqti (server vaqti, s). */
  until: number;
  /** Qolgan vaqt (s) — klient o'z soati bilan hisoblaydi (server vaqti bilan farq bo'lmasin). */
  leftSec: number;
}

/** NightSnap.flares elementi: faol raketa. */
export interface NightFlareSnap {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Qolgan vaqt (s). */
  leftSec: number;
}

/**
 * Kompas yo'nalishi (o'zbekcha): dx = sharq (+X), dz = janub (+Z, Three.js'da -Z shimol).
 * 8 sektor: shimol, shimoli-sharq, sharq, janubi-sharq, janub, janubi-g'arb, g'arb, shimoli-g'arb.
 */
export function compassDirUz(dx: number, dz: number): string {
  const names = ['shimol', 'shimoli-sharq', 'sharq', 'janubi-sharq', 'janub', "janubi-g'arb", "g'arb", "shimoli-g'arb"];
  if (Math.hypot(dx, dz) < 1e-6) return names[0]!;
  // Burchak shimoldan (-Z) soat yo'nalishida
  const ang = Math.atan2(dx, -dz);
  const sector = Math.round((ang / (Math.PI * 2)) * 8);
  return names[((sector % 8) + 8) % 8]!;
}
