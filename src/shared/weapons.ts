export type WeaponId = 'rifle' | 'pistol' | 'shotgun' | 'sniper';
export type EquippedWeapon = WeaponId | null;

/** Qurolsiz (bo'sh qo'l) holatdagi harakat tezligi multiplikatori */
export const UNARMED_SPEED_MUL = 1.0;

/** 1-4 tugmalari tartibi */
export const WEAPON_SLOTS: WeaponId[] = ['rifle', 'pistol', 'shotgun', 'sniper'];

export interface WeaponDef {
  id: WeaponId;
  name: string;
  damage: number;
  headMult: number;
  fireInterval: number; // soniya
  magSize: number;
  reserve: number;
  reloadTime: number;
  spread: number; // radian
  moveSpread: number;
  bloom: number; // har o'qdan keyin qo'shiladigan tarqalish
  maxBloom: number;
  pellets: number;
  range: number;
  auto: boolean;
  zoomFov?: number;
  recoil: number; // radian (yuqoriga tepish)
  falloffStart: number;
  minDamageMul: number;
  speedMul: number;
  switchTime: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  rifle: {
    id: 'rifle', name: 'Avtomat', damage: 27, headMult: 3, fireInterval: 0.1, magSize: 30, reserve: 120,
    reloadTime: 2.1, spread: 0.006, moveSpread: 0.05, bloom: 0.006, maxBloom: 0.05, pellets: 1, range: 200,
    auto: true, recoil: 0.009, falloffStart: 40, minDamageMul: 0.75, speedMul: 0.93, switchTime: 0.5,
  },
  pistol: {
    id: 'pistol', name: "To'pponcha", damage: 24, headMult: 2.6, fireInterval: 0.16, magSize: 12, reserve: 60,
    reloadTime: 1.3, spread: 0.01, moveSpread: 0.03, bloom: 0.012, maxBloom: 0.05, pellets: 1, range: 120,
    auto: false, recoil: 0.014, falloffStart: 20, minDamageMul: 0.6, speedMul: 1.0, switchTime: 0.35,
  },
  shotgun: {
    id: 'shotgun', name: 'Drobovik', damage: 12, headMult: 1.5, fireInterval: 0.8, magSize: 7, reserve: 28,
    reloadTime: 2.4, spread: 0.07, moveSpread: 0.02, bloom: 0, maxBloom: 0, pellets: 9, range: 40,
    auto: false, recoil: 0.05, falloffStart: 8, minDamageMul: 0.2, speedMul: 0.95, switchTime: 0.55,
  },
  sniper: {
    // Tanaga 85 (bir o'q o'ldirmaydi, oyoqqa 60), boshga 212 — snayper faqat headshot bilan bir o'qda o'ldiradi
    id: 'sniper', name: 'Snayper', damage: 85, headMult: 2.5, fireInterval: 1.3, magSize: 5, reserve: 25,
    reloadTime: 2.8, spread: 0.09, moveSpread: 0.1, bloom: 0, maxBloom: 0, pellets: 1, range: 300,
    auto: false, zoomFov: 22, recoil: 0.06, falloffStart: 300, minDamageMul: 1, speedMul: 0.85, switchTime: 0.65,
  },
};

export const GRENADE_LABEL = 'Granata';

export function isWeaponId(x: unknown): x is WeaponId {
  return typeof x === 'string' && (WEAPON_SLOTS as string[]).includes(x);
}

/** Oyoqlarga tekkan o'q zarari (tana zarariga nisbatan). */
export const LEGS_DAMAGE_MUL = 0.7;

export type DamageZone = 'head' | 'torso' | 'legs';

/**
 * Masofa va tegish zonasiga qarab zarar: bosh ×headMult, tana ×1, oyoqlar ×LEGS_DAMAGE_MUL.
 * (`true`/`false` — eski bosh/tana chaqiruvlari bilan moslik.)
 */
export function damageAt(def: WeaponDef, dist: number, zone: DamageZone | boolean): number {
  let mul = 1;
  if (dist > def.falloffStart) {
    const k = Math.min(1, (dist - def.falloffStart) / Math.max(1, def.range - def.falloffStart));
    mul = 1 + (def.minDamageMul - 1) * k;
  }
  const z: DamageZone = zone === true ? 'head' : zone === false ? 'torso' : zone;
  const zoneMul = z === 'head' ? def.headMult : z === 'legs' ? LEGS_DAMAGE_MUL : 1;
  return def.damage * mul * zoneMul;
}

export type AmmoState = Record<WeaponId, { mag: number; reserve: number }>;

export function fullAmmo(): AmmoState {
  const a = {} as AmmoState;
  for (const id of WEAPON_SLOTS) a[id] = { mag: WEAPONS[id].magSize, reserve: WEAPONS[id].reserve };
  return a;
}

export function emptyAmmo(): AmmoState {
  const a = {} as AmmoState;
  for (const id of WEAPON_SLOTS) a[id] = { mag: 0, reserve: 0 };
  return a;
}
