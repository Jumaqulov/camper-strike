import type { WeaponId } from '../weapons';
import type { ContainerKind } from '../world';
import type { LootCatalogEntry, LootCatalogId, LootErrorCode } from './contracts';

export const MAX_WEAPON_SLOTS = 4;
export const MAX_MEDKITS_PER_PLAYER = 3;
export const MEDKIT_HEAL_AMOUNT = 45;
export const MAX_GRENADES_LOOT_MODE = 3;
export const DEFAULT_CONTAINER_EXTRA_MARGIN_M = 0.55;
export const GROUND_ITEM_PICKUP_RADIUS_M = 2.4;

export const MAX_AMMO_RESERVE: Record<WeaponId, number> = {
  rifle: 180,
  pistol: 96,
  shotgun: 42,
  sniper: 35,
};

export const LOOT_CATALOG_IDS: readonly LootCatalogId[] = [
  'weapon:rifle',
  'weapon:pistol',
  'weapon:shotgun',
  'weapon:sniper',
  'ammo:rifle',
  'ammo:pistol',
  'ammo:shotgun',
  'ammo:sniper',
  'heal:medkit',
  'throwable:grenade',
] as const;

export const LOOT_CATALOG: Record<LootCatalogId, LootCatalogEntry> = {
  'weapon:rifle': {
    catalogId: 'weapon:rifle',
    kind: 'weapon',
    nameUz: 'Avtomat',
    shortNameUz: 'Avtomat',
    descriptionUz: "O'rta va yaqin masofa uchun avtomatik miltiq (30 o'q).",
    weaponId: 'rifle',
    defaultQuantity: 1,
    maxStack: 1,
    spawnWeight: 18,
    hasGlbAsset: true,
  },
  'weapon:pistol': {
    catalogId: 'weapon:pistol',
    kind: 'weapon',
    nameUz: "To'pponcha",
    shortNameUz: "To'pponcha",
    descriptionUz: "Yengil va tez o'qlanadigan yordamchi qurol (12 o'q).",
    weaponId: 'pistol',
    defaultQuantity: 1,
    maxStack: 1,
    spawnWeight: 26,
    hasGlbAsset: true,
  },
  'weapon:shotgun': {
    catalogId: 'weapon:shotgun',
    kind: 'weapon',
    nameUz: 'Drobovik',
    shortNameUz: 'Drobovik',
    descriptionUz: "Yaqin masofada kuchli zarba beruvchi sochma o'qli miltiq (7 o'q).",
    weaponId: 'shotgun',
    defaultQuantity: 1,
    maxStack: 1,
    spawnWeight: 16,
    hasGlbAsset: true,
  },
  'weapon:sniper': {
    catalogId: 'weapon:sniper',
    kind: 'weapon',
    nameUz: 'Snayper',
    shortNameUz: 'Snayper',
    descriptionUz: "Uzoq masofadan yuqori aniqlikda zarba beruvchi optik miltiq (5 o'q).",
    weaponId: 'sniper',
    defaultQuantity: 1,
    maxStack: 1,
    spawnWeight: 10,
    hasGlbAsset: true,
  },
  'ammo:rifle': {
    catalogId: 'ammo:rifle',
    kind: 'ammo',
    nameUz: "Avtomat o'qlari",
    shortNameUz: "5.56 o'q",
    descriptionUz: "Avtomat uchun zaxira o'q-dori qutisi (+30).",
    ammoWeapon: 'rifle',
    defaultQuantity: 30,
    maxStack: MAX_AMMO_RESERVE.rifle,
    spawnWeight: 28,
    hasGlbAsset: false,
  },
  'ammo:pistol': {
    catalogId: 'ammo:pistol',
    kind: 'ammo',
    nameUz: "To'pponcha o'qlari",
    shortNameUz: "9mm o'q",
    descriptionUz: "To'pponcha uchun zaxira o'q-dori qutisi (+24).",
    ammoWeapon: 'pistol',
    defaultQuantity: 24,
    maxStack: MAX_AMMO_RESERVE.pistol,
    spawnWeight: 32,
    hasGlbAsset: false,
  },
  'ammo:shotgun': {
    catalogId: 'ammo:shotgun',
    kind: 'ammo',
    nameUz: 'Drobovik patronlari',
    shortNameUz: '12G patron',
    descriptionUz: 'Drobovik uchun sochma patronlar qutisi (+14).',
    ammoWeapon: 'shotgun',
    defaultQuantity: 14,
    maxStack: MAX_AMMO_RESERVE.shotgun,
    spawnWeight: 22,
    hasGlbAsset: false,
  },
  'ammo:sniper': {
    catalogId: 'ammo:sniper',
    kind: 'ammo',
    nameUz: "Snayper o'qlari",
    shortNameUz: "7.62 o'q",
    descriptionUz: "Snayper miltig'i uchun yirik kalibrli o'qlar (+10).",
    ammoWeapon: 'sniper',
    defaultQuantity: 10,
    maxStack: MAX_AMMO_RESERVE.sniper,
    spawnWeight: 16,
    hasGlbAsset: false,
  },
  'heal:medkit': {
    catalogId: 'heal:medkit',
    kind: 'medkit',
    nameUz: 'Tibbiy quti (Aptechka)',
    shortNameUz: 'Aptechka',
    descriptionUz: "Jonni +45 HP ga tiklaydigan dala tibbiy to'plami.",
    defaultQuantity: 1,
    maxStack: MAX_MEDKITS_PER_PLAYER,
    healAmount: MEDKIT_HEAL_AMOUNT,
    spawnWeight: 24,
    hasGlbAsset: false,
  },
  'throwable:grenade': {
    catalogId: 'throwable:grenade',
    kind: 'grenade',
    nameUz: 'Granata',
    shortNameUz: 'Granata',
    descriptionUz: "Portlovchi qo'l granatasi.",
    defaultQuantity: 1,
    maxStack: MAX_GRENADES_LOOT_MODE,
    spawnWeight: 20,
    hasGlbAsset: false,
  },
};

export const CONTAINER_KIND_LABELS_UZ: Record<ContainerKind, string> = {
  supply_crate: "Ta'minot qutisi",
  weapon_locker: 'Qurol shkafi',
  ammo_box: "O'q-dori qutisi",
  camp_chest: 'Lager sandig‘i',
};

export const LOOT_ERROR_MESSAGES_UZ: Record<LootErrorCode, string> = {
  INVALID_REQUEST: "Noto'g'ri so'rov yuborildi.",
  NOT_IN_LOOT_MODE: "Bu xonada o'lja (loot) rejimi yoqilmagan.",
  ROUND_NOT_ACTIVE: 'Raund hali faol emas — jang boshlanishini kuting',
  PLAYER_DEAD: "O'yinchi safdan chiqqan vaqtda bu amalni bajara olmaydi.",
  PLAYER_NOT_FOUND: "O'yinchi topilmadi.",
  CONTAINER_NOT_FOUND: 'Quti yoki shkaf topilmadi.',
  CONTAINER_CLOSED: 'Avval qutini ochish kerak.',
  OUT_OF_RANGE: 'Masofa juda uzoq — yaqinroq boring.',
  LOS_BLOCKED: "Ko'rish chizig'i devor yoki to'siq bilan yopilgan.",
  ITEM_NOT_FOUND: 'Buyum topilmadi.',
  ITEM_ALREADY_TAKEN: 'Bu buyum allaqachon olingan.',
  INVENTORY_FULL: "Inventar to'lgan.",
  WEAPON_ALREADY_OWNED: 'Bu qurol sizda allaqachon bor.',
  AMMO_FULL: "Bu qurol uchun zaxira o'qlar to'la.",
  MEDKITS_FULL: "Tibbiy qutilar (aptechka) limiti to'lgan (maks. 3 ta).",
  GRENADES_FULL: "Granatalar limiti to'lgan (maks. 3 ta).",
  WEAPON_NOT_OWNED: "Bu qurol hali topilmagan (inventarda yo'q).",
  NO_MEDKITS: 'Sizda tibbiy quti (aptechka) yo‘q.',
  HP_ALREADY_FULL: "Joningiz allaqachon to'la (100 HP).",
  RATE_LIMITED: "Juda ko'p so'rov yuborildi, biroz kuting.",
};

export function isLootCatalogId(x: unknown): x is LootCatalogId {
  return typeof x === 'string' && (LOOT_CATALOG_IDS as readonly string[]).includes(x);
}

export function getWeaponCatalogId(w: WeaponId): LootCatalogId {
  switch (w) {
    case 'rifle':
      return 'weapon:rifle';
    case 'pistol':
      return 'weapon:pistol';
    case 'shotgun':
      return 'weapon:shotgun';
    case 'sniper':
      return 'weapon:sniper';
  }
}

export function getAmmoCatalogId(w: WeaponId): LootCatalogId {
  switch (w) {
    case 'rifle':
      return 'ammo:rifle';
    case 'pistol':
      return 'ammo:pistol';
    case 'shotgun':
      return 'ammo:shotgun';
    case 'sniper':
      return 'ammo:sniper';
  }
}
