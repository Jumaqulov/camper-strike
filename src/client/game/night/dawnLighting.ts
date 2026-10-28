import * as THREE from 'three';
import { nightDawnProgress } from '../../../shared/wolf/night';

/**
 * "Tong otguncha" — tong otishi: tunning oxirgi NIGHT_DAWN_TRANSITION_SEC soniyasida osmon, tuman, oy nuri,
 * yarimshar/ambient yorug'lik va ekspozitsiya tun ko'rinishidan tong ko'rinishiga asta o'tadi.
 *
 * Bu faylda: (1) sof yordamchilar — maqsadli daraja va kadrma-kadr silliqlash (`DawnTracker`), testlanadi;
 * (2) `createDawnLighting` — sahna yorug'liklarini tun ↔ tong parametrlari orasida interpolyatsiya qiladi.
 */

/** Silliqlash: daraja soniyasiga ko'pi bilan shuncha o'zgaradi (yangi raundda tongdan tunga ~2 s da qaytadi). */
export const DAWN_MAX_RATE_PER_SEC = 0.5;
/**
 * Server `dawnInSec` ni butun soniyada (ceil) 2 Hz da yuboradi: haqiqiy qoldiq (v-1, v] oralig'ida. Lokal soat
 * har kadr dt ga kamayadi va shu oraliqqa yumshoq tortiladi (soniyasiga shuncha ulush) — sakrashsiz.
 */
const DAWN_CLOCK_CORRECT_PER_SEC = 3;

export interface DawnMatchInput {
  /** Survival fazasi: 'waiting' | 'countdown' | 'playing' | 'ended'. */
  phase: string;
  /** MatchState.winReason / survival.winReason ('dawn' — tong otdi). */
  winReason?: string | null;
  /** survival.night.dawnInSec (faqat 'playing'da). */
  dawnInSec?: number | null;
}

/**
 * Maqsadli tong darajasi 0 (tun) .. 1 (tong):
 * - 'playing' — `nightDawnProgress(dawnInSec)` (tun ma'lumoti bo'lmasa 0);
 * - 'ended' + winReason 'dawn' — 1 (natija ekrani davomida tong saqlanadi);
 * - 'ended' boshqa sabab bilan (bo'rilar yutdi) — null: joriy daraja o'zgarmaydi;
 * - 'waiting' / 'countdown' — 0 (yangi tun).
 */
export function dawnTargetProgress(m: DawnMatchInput): number | null {
  if (m.phase === 'playing') {
    return typeof m.dawnInSec === 'number' ? nightDawnProgress(m.dawnInSec) : 0;
  }
  if (m.phase === 'ended') return m.winReason === 'dawn' ? 1 : null;
  return 0;
}

/** Bir kadr: `current` ni `target` ga soniyasiga `maxRatePerSec` dan tez bo'lmagan holda yaqinlashtiradi. */
export function stepDawnProgress(current: number, target: number, dt: number, maxRatePerSec = DAWN_MAX_RATE_PER_SEC): number {
  const step = Math.max(0, dt) * maxRatePerSec;
  const d = target - current;
  if (Math.abs(d) <= step) return target;
  return current + Math.sign(d) * step;
}

/** Ko'rinish egri chizig'i (smoothstep): boshida sezilmas, o'rtada tez, oxirida yumshoq. */
export function dawnBlendFactor(progress: number): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return p * p * (3 - 2 * p);
}

/**
 * Match yangilanishlari (2 Hz) orasida tong darajasini silliq kuzatuvchi. `onMatch` — har MatchState da,
 * `update` — har kadr (silliqlangan daraja 0..1 qaytaradi; ko'rinish uchun `dawnBlendFactor` ga bering).
 */
export class DawnTracker {
  private progress = 0;
  private phase = 'waiting';
  private winReason: string | null = null;
  /** Server bergan butun soniyali qoldiq (faqat 'playing') va undan silliq yuritiladigan lokal taxmin. */
  private serverDawnInSec: number | null = null;
  private estDawnInSec: number | null = null;
  private initialized = false;

  onMatch(m: DawnMatchInput): void {
    const next = m.phase === 'playing' && typeof m.dawnInSec === 'number' && Number.isFinite(m.dawnInSec) ? m.dawnInSec : null;
    this.serverDawnInSec = next;
    if (next === null) this.estDawnInSec = null;
    else if (this.estDawnInSec === null) this.estDawnInSec = Math.max(0, next - 0.5);
    this.phase = m.phase;
    this.winReason = m.winReason ?? null;
    if (!this.initialized) {
      // Raund o'rtasida kirgan o'yinchi: tongga yaqin bo'lsa ham "tun → tong" o'tishini kutib o'tirmasin
      this.initialized = true;
      this.progress = this.target() ?? 0;
    }
  }

  /** Joriy lokal taxmin bo'yicha maqsad (null — joriy daraja saqlanadi). */
  target(): number | null {
    return dawnTargetProgress({ phase: this.phase, winReason: this.winReason, dawnInSec: this.estDawnInSec });
  }

  update(dt: number): number {
    const v = this.serverDawnInSec;
    if (v !== null && this.estDawnInSec !== null) {
      const prev = this.estDawnInSec;
      let est = prev - Math.max(0, dt);
      const inRange = Math.min(v, Math.max(v - 1, est));
      est += (inRange - est) * Math.min(1, Math.max(0, dt) * DAWN_CLOCK_CORRECT_PER_SEC);
      // Soat orqaga yurmaydi (orqada qolsa — faqat sekinlashadi): tong darajasi 'playing'da kamaymaydi
      this.estDawnInSec = Math.max(0, Math.min(prev, est));
    }
    const t = this.target();
    if (t !== null) this.progress = stepDawnProgress(this.progress, t, dt);
    return this.progress;
  }

  get value(): number {
    return this.progress;
  }
}

// ---------------- Tun ↔ tong yorug'lik parametrlari ----------------

/** Tun (joriy "Tong otguncha" sozlamalari) va tong ko'rinishlari. Ranglar sRGB hex. */
export const NIGHT_LOOK = {
  hemiSky: '#2b3a66',
  hemiGround: '#0d1410',
  hemiIntensity: 0.45,
  moonColor: '#aebfff',
  moonIntensity: 0.5,
  rimColor: '#9ec4ed',
  rimIntensity: 0.25,
  skyTop: '#05070f',
  skyHorizon: '#1b2240',
  fog: '#0a0f1c',
  exposure: 0.9,
} as const;

export const DAWN_LOOK = {
  hemiSky: '#a3a6c9',
  hemiGround: '#3f3a2c',
  hemiIntensity: 1.0,
  // Oy nuri iliqlashadi va pasayadi (ufqqa yaqin, past burchakdan)
  moonColor: '#ffc39a',
  moonIntensity: 0.95,
  rimColor: '#d9a9c4',
  rimIntensity: 0.4,
  skyTop: '#3a5a90',
  // Pushti-to'q sariq ufq; sharqda qo'shimcha iliq shafaq (sky shader `dawnColor`)
  skyHorizon: '#d4928c',
  fog: '#9d8e99',
  exposure: 1.0,
  /** Tuman ko'tariladi: near/far shu ko'paytuvchilar bilan uzoqlashadi. */
  fogNearMul: 1.6,
  fogFarMul: 1.75,
  /** Oyning ufqdan balandligi (rad) tongda. */
  moonElevation: THREE.MathUtils.degToRad(26),
  /** Osmondagi oy gardishi so'nadi. */
  moonGlowCoreMul: 0.45,
  moonGlowHaloMul: 0.7,
  /** Sharqiy shafaq kuchi (sky shader). */
  glowAmount: 0.85,
} as const;

/** Tong otishiga moslashadigan osmon shaderi uniformlari (World.ts va ForestRenderer.ts osmonlari). */
export interface DawnSkyUniforms {
  top: THREE.IUniform<THREE.Color>;
  horizon: THREE.IUniform<THREE.Color>;
  sunDir: THREE.IUniform<THREE.Vector3>;
  glowColor: THREE.IUniform<THREE.Color>;
  glowCore: THREE.IUniform<number>;
  glowHalo: THREE.IUniform<number>;
  dawnDir: THREE.IUniform<THREE.Vector3>;
  dawnColor: THREE.IUniform<THREE.Color>;
  dawnAmount: THREE.IUniform<number>;
}

/** Osmon shaderiga qo'shiladigan shafaq uniformlari (tun boshida o'chiq). */
export function dawnSkyUniformDefaults(): Pick<DawnSkyUniforms, 'dawnDir' | 'dawnColor' | 'dawnAmount'> {
  return {
    dawnDir: { value: new THREE.Vector3(-1, 0, 0) },
    // Chiziqli qiymat: to'q sariq-pushti shafaq
    dawnColor: { value: new THREE.Color(1.0, 0.42, 0.17) },
    dawnAmount: { value: 0 },
  };
}

/**
 * GLSL bo'lagi: `col` ga sharqiy shafaqni qo'shadi (`d` — normallashgan ko'rish yo'nalishi). Faqat ufqqa yaqin
 * pastki qismda va `dawnDir` azimutida eng kuchli; `dawnAmount` = 0 bo'lsa hech narsa o'zgarmaydi.
 */
export const DAWN_SKY_GLSL_UNIFORMS = /* glsl */ `
      uniform vec3 dawnDir;
      uniform vec3 dawnColor;
      uniform float dawnAmount;`;
export const DAWN_SKY_GLSL_APPLY = /* glsl */ `
        float dawnLow = 1.0 - clamp(d.y * 2.4, 0.0, 1.0);
        float dawnAz = max(dot(d, dawnDir), 0.0);
        col += dawnColor * dawnAmount * dawnLow * dawnLow * (0.3 + 0.7 * dawnAz * dawnAz);`;

export interface DawnLightingTargets {
  hemi: THREE.HemisphereLight;
  /** Tunda oy vazifasini bajaruvchi yo'naltirilgan yorug'lik (soyalar bilan). */
  moon: THREE.DirectionalLight;
  rim?: THREE.DirectionalLight | null;
  sky: DawnSkyUniforms;
  fog: THREE.Fog;
  /** Tuman near/far asosiy qiymatlari (ForestRenderer yuqoridan ko'rinishda o'zgartiradi). */
  fogBase: () => { near: number; far: number };
}

export interface DawnLighting {
  /** Tong darajasi (0..1, `dawnBlendFactor` qo'llanmagan) — hamma narsani shu darajaga keltiradi. */
  apply(progress: number): void;
  /** Oy yorug'ligini joriy darajadagi yo'nalishga qaytaradi (soya kuzatuvchisi pozitsiyani qayta yozgandan keyin). */
  reapplyMoonDirection(): void;
  /** Tuman near/far ni joriy daraja bo'yicha qayta qo'yadi. */
  reapplyFog(): void;
  readonly factor: number;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * Tun sahnasining yorug'liklarini tong darajasiga moslaydi. Yaratilgan paytdagi oy pozitsiyasi (nishonga
 * nisbatan) tun yo'nalishi sifatida saqlanadi; tongda oy o'z azimutida ufqqa pasayadi, shafaq qarama-qarshi
 * (sharq) tomonda. `apply` arzon: daraja o'zgarmasa hech narsa qilmaydi.
 */
export function createDawnLighting(t: DawnLightingTargets): DawnLighting {
  const c = (hex: string) => new THREE.Color(hex);
  const night = {
    hemiSky: c(NIGHT_LOOK.hemiSky),
    hemiGround: c(NIGHT_LOOK.hemiGround),
    moon: c(NIGHT_LOOK.moonColor),
    rim: c(NIGHT_LOOK.rimColor),
    top: t.sky.top.value.clone(),
    horizon: t.sky.horizon.value.clone(),
    glow: t.sky.glowColor.value.clone(),
    fog: t.fog.color.clone(),
  };
  const dawn = {
    hemiSky: c(DAWN_LOOK.hemiSky),
    hemiGround: c(DAWN_LOOK.hemiGround),
    moon: c(DAWN_LOOK.moonColor),
    rim: c(DAWN_LOOK.rimColor),
    top: c(DAWN_LOOK.skyTop),
    horizon: c(DAWN_LOOK.skyHorizon),
    glow: new THREE.Color(1.0, 0.84, 0.68),
    fog: c(DAWN_LOOK.fog),
  };
  const hemiI = t.hemi.intensity;
  const moonI = t.moon.intensity;
  const rimI = t.rim?.intensity ?? 0;
  const glowCore = t.sky.glowCore.value;
  const glowHalo = t.sky.glowHalo.value;
  // Oy yo'nalishi: nishondan yorug'likkacha bo'lgan vektor (masofa saqlanadi)
  const offset = t.moon.position.clone().sub(t.moon.target.position);
  const dist = offset.length() || 1;
  const horiz = Math.hypot(offset.x, offset.z) || 1;
  const azX = offset.x / horiz;
  const azZ = offset.z / horiz;
  const nightElev = Math.atan2(offset.y, horiz);
  // Shafaq oy botayotgan tomonga qarama-qarshi — sharqda
  t.sky.dawnDir.value.set(-azX, 0, -azZ).normalize();
  const moonOffset = offset.clone();
  const tmpDir = new THREE.Vector3();

  let factor = -1;

  const reapplyMoonDirection = () => {
    t.moon.position.copy(t.moon.target.position).add(moonOffset);
  };
  const reapplyFog = () => {
    const f = Math.max(0, factor);
    const base = t.fogBase();
    t.fog.near = base.near * lerp(1, DAWN_LOOK.fogNearMul, f);
    t.fog.far = base.far * lerp(1, DAWN_LOOK.fogFarMul, f);
  };

  return {
    get factor() {
      return Math.max(0, factor);
    },
    reapplyMoonDirection,
    reapplyFog,
    apply(progress: number) {
      const f = dawnBlendFactor(progress);
      if (Math.abs(f - factor) < 1e-4) return;
      factor = f;
      t.hemi.color.copy(night.hemiSky).lerp(dawn.hemiSky, f);
      t.hemi.groundColor.copy(night.hemiGround).lerp(dawn.hemiGround, f);
      t.hemi.intensity = lerp(hemiI, DAWN_LOOK.hemiIntensity, f);
      t.moon.color.copy(night.moon).lerp(dawn.moon, f);
      t.moon.intensity = lerp(moonI, DAWN_LOOK.moonIntensity, f);
      if (t.rim) {
        t.rim.color.copy(night.rim).lerp(dawn.rim, f);
        t.rim.intensity = lerp(rimI, DAWN_LOOK.rimIntensity, f);
      }
      // Oy o'z azimutida pasayadi (soyalar uzayadi), masofa o'zgarmaydi
      const elev = lerp(nightElev, DAWN_LOOK.moonElevation, f);
      const ch = Math.cos(elev);
      moonOffset.set(azX * ch * dist, Math.sin(elev) * dist, azZ * ch * dist);
      reapplyMoonDirection();
      tmpDir.copy(moonOffset).normalize();
      t.sky.sunDir.value.copy(tmpDir);
      t.sky.top.value.copy(night.top).lerp(dawn.top, f);
      t.sky.horizon.value.copy(night.horizon).lerp(dawn.horizon, f);
      t.sky.glowColor.value.copy(night.glow).lerp(dawn.glow, f);
      t.sky.glowCore.value = glowCore * lerp(1, DAWN_LOOK.moonGlowCoreMul, f);
      t.sky.glowHalo.value = glowHalo * lerp(1, DAWN_LOOK.moonGlowHaloMul, f);
      t.sky.dawnAmount.value = DAWN_LOOK.glowAmount * f;
      t.fog.color.copy(night.fog).lerp(dawn.fog, f);
      reapplyFog();
    },
  };
}

/** Tone mapping ekspozitsiyasi tong darajasida (Game). */
export function dawnExposure(progress: number): number {
  return lerp(NIGHT_LOOK.exposure, DAWN_LOOK.exposure, dawnBlendFactor(progress));
}
