/**
 * STAGE 08-TERRAIN-VISUAL — 17 ta GLB o't varianti uchun sof ma'lumotlar (id, kategoriya,
 * balandlik, masshtab chegaralari).
 *
 * Bu modul `three` yoki `GLTFLoader` import qilmaydi: `GrassVariantPlanner` ni Node testlari
 * to'g'ridan-to'g'ri import qiladi, `GrassAssetRegistry` esa shu jadvallardan foydalanadi —
 * ikkalasi uchun yagona manba.
 */

/** public/models/grass/ dagi 17 ta Claude GLB modeli. */
export const GRASS_VARIANT_IDS = [
  'grass_short_soft_01',
  'grass_short_dense_01',
  'grass_meadow_wide_01',
  'grass_meadow_thin_01',
  'grass_tall_wild_01',
  'grass_tall_seeded_01',
  'grass_dry_straw_01',
  'grass_olive_tuft_01',
  'grass_shade_dark_01',
  'grass_forest_sparse_01',
  'grass_path_edge_01',
  'grass_wavy_broad_01',
  'flower_white_01',
  'flower_yellow_01',
  'flower_purple_01',
  'fern_small_01',
  'fern_wide_01',
] as const;

export type GrassVariantId = (typeof GRASS_VARIANT_IDS)[number];

export type GrassCategory = 'grass' | 'flower' | 'fern';
/** Eski nom (planner API); `GrassCategory` bilan bir xil. */
export type GrassVariantCategory = GrassCategory;

export function getVariantCategory(variantId: GrassVariantId): GrassCategory {
  if (variantId.startsWith('flower_')) return 'flower';
  if (variantId.startsWith('fern_')) return 'fern';
  return 'grass';
}

export function getCategoryIndex(category: GrassCategory): number {
  switch (category) {
    case 'grass':
      return 0;
    case 'flower':
      return 1;
    case 'fern':
      return 2;
  }
}

/** Masshtabsiz GLB model balandliklari, metrda (asset manifestdan). */
export const GRASS_VARIANT_HEIGHT: Readonly<Record<GrassVariantId, number>> = {
  grass_short_soft_01: 0.17,
  grass_short_dense_01: 0.15,
  grass_meadow_wide_01: 0.34,
  grass_meadow_thin_01: 0.3,
  grass_tall_wild_01: 0.52,
  grass_tall_seeded_01: 0.54,
  grass_dry_straw_01: 0.36,
  grass_olive_tuft_01: 0.26,
  grass_shade_dark_01: 0.24,
  grass_forest_sparse_01: 0.22,
  grass_path_edge_01: 0.22,
  grass_wavy_broad_01: 0.3,
  flower_white_01: 0.26,
  flower_yellow_01: 0.3,
  flower_purple_01: 0.42,
  fern_small_01: 0.34,
  fern_wide_01: 0.6,
};

/**
 * PvP adolati uchun ruxsat etilgan maksimal dunyo balandliklari:
 * - o't: <= 0.45 m
 * - gul: <= 0.35 m
 * - paporotnik: <= 0.60 m
 */
export const MAX_WORLD_HEIGHT: Readonly<Record<GrassCategory, number>> = {
  grass: 0.45,
  flower: 0.35,
  fern: 0.6,
};

/**
 * Kategoriya bo'yicha masshtab shipi (vizual: past modellar PvP chegarasiga yetguncha
 * cho'zilib ketmasin).
 *
 * Ilgari registry da `Math.min(1.3, …)` (ishlatilmagan, o'lik kod) va planner da `grass: 1.4`
 * (haqiqiy render yo'li) bo'lib ikki xil qiymat bor edi. 1.4 saqlandi: PvP balandlik chegarasini
 * `MAX_WORLD_HEIGHT` kafolatlaydi (`calculateMaxScale` avval maxWorldH/baseH ni oladi, masalan
 * grass_meadow_wide_01 0.34 m -> 1.323 < 1.4), 1.4 esa faqat past o'tlarning (0.15–0.22 m)
 * vizual hajmi uchun kerak — ular 1.4 da ham 0.31 m dan oshmaydi.
 */
export const CATEGORY_MAX_SCALE: Readonly<Record<GrassCategory, number>> = {
  grass: 1.4,
  flower: 1.3,
  fern: 1.3,
};

function calculateMaxScale(variantId: GrassVariantId): number {
  const category = getVariantCategory(variantId);
  const baseH = GRASS_VARIANT_HEIGHT[variantId];
  const maxWorldH = MAX_WORLD_HEIGHT[category];
  const cap = CATEGORY_MAX_SCALE[category];
  const raw = maxWorldH / baseH;
  if (raw < cap) {
    // 3 xonagacha pastga yaxlitlash: baseH * scale <= maxWorldH qat'iy kafolatlanadi
    return Math.floor(raw * 1000) / 1000;
  }
  return cap;
}

/**
 * Har bir variant uchun PvP chegarasidan kelib chiqqan maksimal masshtab:
 * - grass_tall_wild_01 (0.52 m) -> 0.45 / 0.52 = 0.865
 * - grass_tall_seeded_01 (0.54 m) -> 0.45 / 0.54 = 0.833
 * - flower_purple_01 (0.42 m) -> 0.35 / 0.42 = 0.833
 * - fern_wide_01 (0.60 m) -> 1.0
 * Qolganlari o'z kategoriyasi shipigacha.
 */
export const GRASS_VARIANT_MAX_SCALE: Readonly<Record<GrassVariantId, number>> = Object.fromEntries(
  GRASS_VARIANT_IDS.map((id) => [id, calculateMaxScale(id)]),
) as Record<GrassVariantId, number>;

export function maxScaleForVariant(variantId: GrassVariantId): number {
  return GRASS_VARIANT_MAX_SCALE[variantId];
}
