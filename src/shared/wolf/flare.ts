/**
 * "Tong otguncha": yarim tungi yordam yuki va signal raketasi (klient–server umumiy kontraktlar).
 *
 * Yordam yuki — 3-to'lqin boshida (tunning 50 %) xaritaning tasodifiy joyiga `supply_crate` konteyneri tushadi:
 * sayr komponentidagi nav tuguni, asosiy gulxandan SUPPLY_DROP_MIN..MAX_DIST_M narida (lagerdan tashqarida —
 * xavfli, lekin yetib borsa bo'ladi), har gulxandan ≥ SUPPLY_DROP_FIRE_CLEAR_M, g'aramlardan ≥ SUPPLY_DROP_CLEAR_M,
 * atrofi bo'sh, ochiq osmon ostida. Joy, burilish va qurol xonaning maxfiy loot seedi ⊕ raund bilan tanlanadi —
 * har xonada va har raundda boshqa, klient oldindan bila olmaydi. Quti SUPPLY_DROP_FALL_SEC parashyutda tushadi;
 * konteyner (runtime — xarita ta'rifiga kirmaydi, gameplayHash o'zgarmaydi) faqat yerga tekkanda paydo bo'ladi,
 * shungacha uni ochib bo'lmaydi. Ichida: qurol (avtomat yoki drobovik), 2 quti o'q, aptechka, granata va
 * 2 signal raketasi.
 *
 * Signal raketasi — kam uchraydigan loot buyumi (`item:flare`). Otilganda ([X]) xaritadagi HAMMA tirik bo'rilar
 * FLARE_SCARE_SEC qo'rqib qochadi (hech kimni tishlamaydi, nishon olmaydi); raketa yonib turganda paydo bo'lgan yoki
 * qayta tug'ilgan bo'ri ham qolgan vaqt davomida qochadi. Qo'shimcha: otilgan joyda FLARE_DURATION_SEC davomida
 * bo'rilar kirmaydigan FLARE_FEAR_RADIUS_M doira; to'da shu doiradagi o'yinchini nishon qilmaydi.
 */

// ---------- Yordam yuki ----------
/** Yordam yuki tushadigan to'lqin (1-asos). */
export const SUPPLY_DROP_WAVE = 3;
/**
 * Asosiy gulxandan masofa oralig'i (m): lager doirasidan ancha nari (yo'l xavfli), lekin tun yarmida borib
 * kelsa bo'ladigan — 256 m li xaritaning katta qismi.
 */
export const SUPPLY_DROP_MIN_DIST_M = 40;
export const SUPPLY_DROP_MAX_DIST_M = 160;
/** O'tin g'aramlaridan eng kam masofa (m). */
export const SUPPLY_DROP_CLEAR_M = 12;
/** Har bir gulxandan eng kam masofa (m) — yuk hech qaysi lager (olov himoyasi) ichiga tushmaydi. */
export const SUPPLY_DROP_FIRE_CLEAR_M = 30;
/** Xarita chetidan eng kam masofa (m). */
export const SUPPLY_DROP_EDGE_M = 8;
/** Parashyutda tushish vaqti (s): server konteynerni shundan keyin qo'shadi, klient shu vaqt animatsiya qiladi. */
export const SUPPLY_DROP_FALL_SEC = 3.2;
/** Qizil tutun/mayoq ustuni ko'rinib turish vaqti (s, tushgan paytdan) — quti ochilsa so'nadi. */
export const SUPPLY_BEACON_SEC = 90;
/** Yordam yuki konteyneri identifikatori prefiksi (`supply:r<round>`). */
export const SUPPLY_CONTAINER_PREFIX = 'supply:';
export function isSupplyContainerId(id: string): boolean {
  return id.startsWith(SUPPLY_CONTAINER_PREFIX);
}

/** Server → klient: yordam yuki tushmoqda (parashyut animatsiyasi, ovoz, banner, mini-xarita belgisi, mayoq). */
export interface NightSupplyDropEvent {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Quti burilishi (rad) — konteyner bilan bir xil. */
  yaw: number;
}

/** NightSnap.supply: yordam yuki holati (kech qo'shilganlar/kuzatuvchilar uchun ham). */
export interface NightSupplySnap {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  opened: boolean;
  /**
   * Tushish boshlanganidan beri o'tgan vaqt (s, 0.1 aniqlikda) — klient o'z soati bilan tushish va mayoq vaqtini
   * hisoblaydi (kech qo'shilgan o'yinchiga mayoq qaytadan SUPPLY_BEACON_SEC yonmasin).
   */
  ageSec: number;
}

/**
 * Klient soati bo'yicha yordam yuki vaqtlari (NightSupplySnap.ageSec dan — kech qo'shilgan/qayta ulangan o'yinchi
 * uchun): tushish boshlangan vaqt, mayoq so'nadigan vaqt (tushgan paytdan SUPPLY_BEACON_SEC — ulangan paytdan
 * qaytadan to'liq emas) va quti hali havodami. Sof funksiya (testlar uchun).
 */
export function supplyDropClock(ageSec: number, nowSec: number): { droppedAt: number; beaconUntil: number; falling: boolean } {
  const age = Number.isFinite(ageSec) ? Math.max(0, ageSec) : SUPPLY_DROP_FALL_SEC;
  const droppedAt = nowSec - age;
  return { droppedAt, beaconUntil: droppedAt + SUPPLY_BEACON_SEC, falling: age < SUPPLY_DROP_FALL_SEC };
}

// ---------- Signal raketasi ----------
/** Raketa doirasi (m): bo'ri kirmaydi, nishon olmaydi. */
export const FLARE_FEAR_RADIUS_M = 30;
/** Bo'ri raketa doirasi chetida to'xtaydigan masofa (m, markazdan). */
export const FLARE_STANDOFF_M = FLARE_FEAR_RADIUS_M + 2;
/** Raketa yonib turish vaqti (s). */
export const FLARE_DURATION_SEC = 20;
/** Qo'rqib qochish vaqti (s): xaritadagi hamma bo'rilar raketa yonib turguncha qochadi. */
export const FLARE_SCARE_SEC = FLARE_DURATION_SEC;
/** Bir o'yinchi ikki raketa orasidagi eng kam oraliq (s) — spamga qarshi. */
export const FLARE_USE_COOLDOWN_SEC = 3;
/** Bot raketani shu oraliqda (s) qayta ishlatmaydi. */
export const BOT_FLARE_COOLDOWN_SEC = 30;
/**
 * Bot raketa otadi (yaqinda yonib turgan gulxan, mash'al va faol raketa yo'q bo'lsa): ovlayotgan bo'ri shu
 * masofadan (m) yaqin va bot qurolsiz/o'qsiz/bo'rini ko'rmaydi yoki joni BOT_FLARE_LOW_HP dan kam; yoki
 * BOT_FLARE_SWARM_M ichida kamida BOT_FLARE_SWARM_COUNT bo'ri aynan uni ovlamoqda (qurolli bo'lsa ham).
 */
export const BOT_FLARE_WOLF_DIST_M = 6;
export const BOT_FLARE_NO_FIRE_M = 10;
export const BOT_FLARE_LOW_HP = 40;
export const BOT_FLARE_SWARM_M = 14;
export const BOT_FLARE_SWARM_COUNT = 3;

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
