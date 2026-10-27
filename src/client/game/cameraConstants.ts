/**
 * 3-shaxs (3P) kamera konstantalari — lokal o'yinchi kamerasi (Game) va kuzatuvchi kamerasi
 * (SpectatorController) bir xil yelka ofsetini ishlatadi, masofa esa ataylab farq qiladi.
 */

/** 3P yelka ofseti (m): kamera pivoti boshdan o'ng yelka tomon shuncha suriladi. */
export const TP_SHOULDER_OFFSET = 0.42;
/** Yelka pivoti bilan devor orasida saqlanadigan bo'shliq (m). */
export const TP_SHOULDER_PAD = 0.15;
/** Lokal o'yinchi 3P kamerasining maksimal orqa masofasi (m). */
export const TP_MAX_DIST_LOCAL = 2.35;
/** Kuzatuvchi (spectator) kamerasi ataylab biroz uzoqroq turadi — nishonning atrofi kengroq ko'rinsin. */
export const TP_MAX_DIST_SPECTATOR = 2.55;
