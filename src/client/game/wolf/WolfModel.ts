import * as THREE from 'three';
import { wolfCoatTraits, type WolfState } from '../../../shared/wolf';
import {
  instantiateWolf,
  isWolfAssetReady,
  onWolfAssetReady,
  preloadWolfAssets,
  wolfLodTriangles,
  type WolfClipName,
  type WolfInstance,
} from './WolfAssetRegistry';
import { pickWolfLod, wolfCastsShadowAt, wolfMixerStride, type WolfLodLevel } from './wolfLod';
import { WOLF_STEALTH_FUR_TINT, wolfStealthEyeGlow } from './wolfStealth';

export interface WolfModelState {
  state: WolfState;
  /** Gorizontal tezlik (m/s) — sayrda Idle/Walk tanlash uchun. */
  speed: number;
  /** Bo'ri yuzi tomonga emas, orqaga siljiyapti (`wolfBackpedal`) — Walk teskari o'ynaydi. */
  backwards?: boolean;
}

/** Klip tabiiy tezliklari (m/s, timeScale 1): Run 2.4 m/0.6 s = 4 m/s, Walk 1.2 m/s. */
const RUN_CLIP_SPEED = 4.0;
const WALK_CLIP_SPEED = 1.2;
const CLIP_TIMESCALE_MIN = 0.6;
const CLIP_TIMESCALE_MAX = 2.2;
/**
 * Walk klipi ko'pi bilan 1.2 × 2.2 ≈ 2.64 m/s ga yetadi — undan tez harakatda (masalan, olovdan WOLF_RUN_SPEED
 * bilan qochayotgan 'alert' bo'ri yoki stalk 4.2 m/s) oyoqlar sirpanadi, shuning uchun har qanday holatda Run.
 * Run eng sekini 4 × 0.6 = 2.4 m/s; gisterezis (kirish 2.8 / chiqish 2.5) snapshot shovqinida almashib turmaslik uchun.
 */
export const WOLF_RUN_CLIP_ENTER_SPEED = 2.8;
export const WOLF_RUN_CLIP_EXIT_SPEED = 2.5;

/**
 * Orqaga yurish: harakat bilan yuz orasidagi burchak kosinusi shundan past bo'lsa (harakat yuzdan 120° dan ko'proq
 * og'gan) — orqaga; qaytish uchun -0.2 dan oshishi kerak (gisterezis: burilish/snapshot shovqinida klip
 * oldinga-orqaga almashib turmaydi).
 */
export const WOLF_BACKPEDAL_ENTER_COS = -0.5;
export const WOLF_BACKPEDAL_EXIT_COS = -0.2;
/** Shundan sekin (m/s) — orqaga yurish yo'q (to'xtagan bo'rida yo'nalish ma'nosiz; klip baribir Idle/Alert). */
export const WOLF_BACKPEDAL_MIN_SPEED = 0.3;
/**
 * Silliqlangan tezlik vektori moduli shu ulushdan kam bo'lsa (tezlik modulining o'zi bilan solishtirganda) —
 * harakat izchil emas (har tik yo'nalish almashadi, zigzag): yo'nalish ishonchsiz, orqaga yurish yo'q
 * (aks holda Walk har necha kadrda teskari/oldinga almashib turardi).
 */
export const WOLF_BACKPEDAL_MIN_COHERENCE = 0.5;

/**
 * Bo'ri orqaga siljiyaptimi (gisterezis bilan). `velX/velZ` — silliqlangan gorizontal tezlik vektori (m/s, jahon
 * o'qlarida), `yaw` — joriy yo'nalish (oldinga = (-sin yaw, -cos yaw)), `speed` — xuddi shunday silliqlangan tezlik
 * moduli (izchillik uchun). Haydovchi soxta hamladan keyin o'ljaga qarab chekinadi, olov halqasidan orqaga silliq
 * chekinadi — shunda oyoqlar oldinga yugurmasin ("moonwalk").
 */
export function wolfBackpedal(prev: boolean, velX: number, velZ: number, yaw: number, speed: number): boolean {
  const v = Math.hypot(velX, velZ);
  if (!(v > WOLF_BACKPEDAL_MIN_SPEED) || !Number.isFinite(yaw) || v < WOLF_BACKPEDAL_MIN_COHERENCE * speed) return false;
  const fwd = velX * -Math.sin(yaw) + velZ * -Math.cos(yaw);
  return fwd / v < (prev ? WOLF_BACKPEDAL_EXIT_COS : WOLF_BACKPEDAL_ENTER_COS);
}

/**
 * Holat → klip. Idle/sniff harakatda Walk ga o'tadi; Walk sig'magan tezlikda (gisterezis bilan) Run.
 * 'flee' (tong otdi — o'rmonga qochish) ham shu yo'l bilan: WOLF_RUN_SPEED da Run, to'xtaganda Alert.
 * Orqaga siljiyotgan (`backwards`) bo'ri yugurmaydi — Walk (teskari o'ynaladi, `wolfClipTimeScale`).
 */
export function wolfClipFor(s: WolfModelState, current: WolfClipName | null = null): WolfClipName {
  const clip = baseClipFor(s);
  if (s.backwards && (clip === 'Walk' || clip === 'Run')) return 'Walk';
  if (clip !== 'Walk') return clip;
  const runAbove = current === 'Run' ? WOLF_RUN_CLIP_EXIT_SPEED : WOLF_RUN_CLIP_ENTER_SPEED;
  return s.speed > runAbove ? 'Run' : 'Walk';
}

/**
 * Yurish/yugurish klipi tezligi (timeScale) haqiqiy tezlikka mos (katta bo'rining qadami ham masshtab bo'yicha
 * uzun), CLIP_TIMESCALE_MIN..MAX ichida. Orqaga Walk — manfiy: klip teskari o'ynaydi (orqaga qadam tashlaydi).
 * Boshqa kliplar — 1.
 */
export function wolfClipTimeScale(clip: WolfClipName, s: WolfModelState, scale = 1): number {
  if (clip !== 'Run' && clip !== 'Walk') return 1;
  const base = (clip === 'Run' ? RUN_CLIP_SPEED : WALK_CLIP_SPEED) * scale;
  const ts = THREE.MathUtils.clamp(s.speed / base, CLIP_TIMESCALE_MIN, CLIP_TIMESCALE_MAX);
  return s.backwards && clip === 'Walk' ? -ts : ts;
}

function baseClipFor(s: WolfModelState): WolfClipName {
  switch (s.state) {
    case 'hunt':
      return s.speed > 0.5 ? 'Run' : 'Alert';
    case 'flee':
      // Tezlik bo'yicha Walk → (gisterezis) Run; Run klipi timeScale bilan haqiqiy tezlikka moslanadi
      return s.speed > 0.4 ? 'Walk' : 'Alert';
    case 'stalk':
      return s.speed > 0.3 ? 'Walk' : 'Alert';
    case 'alert':
      return s.speed > 0.4 ? 'Walk' : 'Alert';
    case 'attack':
      return 'Attack';
    case 'hit':
      return 'Hit';
    case 'howl':
      return 'Howl';
    case 'dead':
      return 'Death';
    case 'sniff':
      return s.speed > 0.4 ? 'Walk' : 'Sniff';
    case 'idle':
      return s.speed > 0.4 ? 'Walk' : 'Idle';
    default: {
      // Yangi WolfState qo'shilsa — kompilyatsiya xatosi (bu yerda klip tanlanishi shart)
      const unknownState: never = s.state;
      void unknownState;
      return s.speed > 0.4 ? 'Walk' : 'Idle';
    }
  }
}

/** GLB dagi ko'z materiali (emissive, KHR_materials_emissive_strength = 4). */
const WOLF_EYES_MATERIAL = 'wolf_eyes';
/** To'da boshlig'ining ko'zlari yorqinroq yonadi (oddiy bo'ri — 4). */
const ALPHA_EYE_EMISSIVE = 7;

/**
 * To'da boshlig'i: ko'z materialining yorqinligini oshiradi. Material shu coat GLB nusxalarida umumiy
 * (oq coat = faqat boshliq), shuning uchun mutlaq qiymat qo'yiladi — takroriy chaqiruv xavfsiz.
 */
function boostAlphaEyes(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m instanceof THREE.MeshStandardMaterial && m.name === WOLF_EYES_MATERIAL) m.emissiveIntensity = ALPHA_EYE_EMISSIVE;
    }
  });
}

/**
 * "Tun soyasi": nusxaning standart materiallarini o'ziga klonlaydi (shablon materiallari shu coat nusxalarida
 * umumiy — ularni o'zgartirmaymiz). Ko'z klonlari `eyes` ga yig'iladi (yorqinligi masofaga qarab, `update()` da);
 * mo'yna to'qroq va xira (`WOLF_STEALTH_FUR_TINT`). Qaytaradi: barcha klonlar (`dispose()` da tozalanadi).
 */
function cloneStealthMaterials(root: THREE.Object3D, eyes: THREE.MeshStandardMaterial[]): THREE.Material[] {
  const clones = new Map<THREE.Material, THREE.Material>();
  const swap = (m: THREE.Material): THREE.Material => {
    if (!(m instanceof THREE.MeshStandardMaterial)) return m;
    const done = clones.get(m);
    if (done) return done;
    const c = m.clone();
    c.userData.sharedAsset = false;
    if (m.name === WOLF_EYES_MATERIAL) {
      eyes.push(c);
    } else {
      c.color.multiplyScalar(WOLF_STEALTH_FUR_TINT);
      c.roughness = 1;
    }
    clones.set(m, c);
    return c;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  return [...clones.values()];
}

const LOOPING: ReadonlySet<WolfClipName> = new Set<WolfClipName>(['Idle', 'Sniff', 'Alert', 'Walk', 'Run']);
const FADE = 0.16;

/** Bo'ri turi bo'yicha model masshtabi (`WOLF_COAT_TRAITS`: to'da boshlig'i 1.22, chaqqon 0.92). */
export function wolfModelScale(coat: number | undefined): number {
  const s = wolfCoatTraits(coat).scale;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/**
 * Bitta bo'rining 3D ko'rinishi: GLB nusxasi + AnimationMixer; GLB kelguncha (yoki xatoda) procedural
 * zaxira (qorong'i gavda + bosh + yonuvchi ko'zlar). `root` ni sahnaga qo'shing, `update()` har kadr.
 */
export class WolfModel {
  readonly root = new THREE.Group();
  private inst: WolfInstance | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<WolfClipName, THREE.AnimationAction>();
  private current: WolfClipName | null = null;
  private fallback: THREE.Group | null = null;
  private fallbackGeos: THREE.BufferGeometry[] = [];
  private fallbackMats: THREE.Material[] = [];
  private unsubReady: (() => void) | null = null;
  private disposed = false;
  private lastState: WolfState = 'idle';
  /** Joriy LOD darajasi (kamera masofasi bo'yicha, gisterezis bilan) va har darajadagi uchburchak soni. */
  private lod: WolfLodLevel = 0;
  private lodTris: [number, number, number] = [0, 0, 0];
  private shadowOn = true;
  /** Mikser kadr hisoblagichi va yig'ilgan dt (uzoqda har 2-/4-kadr yangilanadi, animatsiya tezligi saqlanadi). */
  private mixerFrame = 0;
  private mixerDtAcc = 0;
  /**
   * "Tun soyasi": nusxaning o'z ko'z materiallari (GLB klonlari yoki zaxira ko'zi) — yorqinligi kameragacha masofa
   * bo'yicha (`wolfStealthEyeGlow`), barcha LOD darajalarida bir xil (LOD faqat geometriyani almashtiradi).
   */
  private stealthEyes: THREE.MeshStandardMaterial[] = [];
  /** Soya uchun klonlangan GLB materiallari (shablonniki o'zgarmaydi) — `dispose()` da tozalanadi. */
  private stealthMats: THREE.Material[] = [];
  /** So'nggi kamera masofasi (m); birinchi `update()` gacha noma'lum — soya ko'zlari xira boshlanadi. */
  private camDist = Infinity;

  /** Tur bo'yicha masshtab (root ga qo'llangan). */
  readonly scale: number;
  /** "Tun soyasi" (`wolfCoatTraits(coat).stealthy`): ko'zlari xira, mo'ynasi to'q. */
  readonly stealthy: boolean;

  /** @param coat rang varianti (`WolfSnap.coat`, 0..4) — u bo'ri turini ham belgilaydi (`wolfCoatTraits`). */
  constructor(readonly coat = 0) {
    this.scale = wolfModelScale(coat);
    this.stealthy = wolfCoatTraits(coat).stealthy;
    this.root.scale.setScalar(this.scale);
    void preloadWolfAssets(coat);
    if (isWolfAssetReady(coat)) this.attach();
    if (!this.inst) {
      this.buildFallback();
      this.unsubReady = onWolfAssetReady(() => this.attach(), coat);
    }
  }

  usesAsset(): boolean {
    return this.inst !== null;
  }

  /** Joriy LOD darajasi (0 — to'liq; zaxira model ham 0). */
  get lodLevel(): WolfLodLevel {
    return this.lod;
  }

  /** Hozir chizilayotgan uchburchaklar soni (joriy LOD bo'yicha; zaxira model — 0). */
  get lodTriangles(): number {
    return this.inst ? this.lodTris[this.lod] : 0;
  }

  /** LOD geometriyasini almashtiradi (bir xil skelet/bindMatrix; `null` — mesh ko'rinmaydi, masalan ko'zlar LOD2 da). */
  private applyLod(level: WolfLodLevel): void {
    this.lod = level;
    if (!this.inst) return;
    for (const [mesh, set] of this.inst.lods) {
      const g = set[level];
      if (!g) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      if (mesh.geometry !== g) mesh.geometry = g;
    }
  }

  private applyShadow(on: boolean): void {
    this.shadowOn = on;
    if (!this.inst) return;
    for (const m of this.inst.skinnedMeshes) m.castShadow = on;
  }

  /** Soya ko'zlari yorqinligi (oddiy bo'rida `stealthEyes` bo'sh — hech narsa qilmaydi). */
  private applyStealthEyes(): void {
    if (!this.stealthEyes.length) return;
    const glow = wolfStealthEyeGlow(this.camDist);
    for (const m of this.stealthEyes) m.emissiveIntensity = glow;
  }

  private attach(): void {
    if (this.inst || this.disposed) return;
    const inst = instantiateWolf(this.coat);
    if (!inst) return;
    this.inst = inst;
    this.root.add(inst.root);
    this.lodTris = [0, 0, 0];
    for (const set of inst.lods.values()) {
      const [a, b, c] = wolfLodTriangles(set);
      this.lodTris[0] += a;
      this.lodTris[1] += b;
      this.lodTris[2] += c;
    }
    // Nusxa LOD0 bilan keladi; oldin (zaxira paytida) tanlangan daraja/soya qo'llanadi
    if (this.lod !== 0) this.applyLod(this.lod);
    if (!this.shadowOn) this.applyShadow(false);
    this.mixer = new THREE.AnimationMixer(inst.root);
    for (const [name, clip] of inst.clips) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      a.setEffectiveWeight(0);
      if (LOOPING.has(name)) {
        a.setLoop(THREE.LoopRepeat, Infinity);
      } else {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      this.actions.set(name, a);
    }
    if (wolfCoatTraits(this.coat).kind === 'alpha') boostAlphaEyes(inst.root);
    this.disposeFallback();
    if (this.stealthy) {
      this.stealthMats = cloneStealthMaterials(inst.root, this.stealthEyes);
      this.applyStealthEyes();
    }
    this.current = null;
  }

  private buildFallback(): void {
    const g = new THREE.Group();
    const body = new THREE.BoxGeometry(0.6, 0.55, 1.4);
    const head = new THREE.BoxGeometry(0.4, 0.38, 0.55);
    const leg = new THREE.BoxGeometry(0.14, 0.6, 0.14);
    // Soya — to'qroq gavda, ko'zlari masofaga qarab xira (`applyStealthEyes`)
    const fur = this.stealthy
      ? new THREE.MeshStandardMaterial({ color: '#16161a', roughness: 1 })
      : new THREE.MeshStandardMaterial({ color: '#2a2b2e', roughness: 0.9 });
    const alpha = wolfCoatTraits(this.coat).kind === 'alpha';
    const eye = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#ffb020', emissiveIntensity: alpha ? 5 : 3 });
    this.fallbackGeos.push(body, head, leg);
    this.fallbackMats.push(fur, eye);
    if (this.stealthy) {
      this.stealthEyes.push(eye);
      this.applyStealthEyes();
    }
    const b = new THREE.Mesh(body, fur);
    b.position.set(0, 0.85, 0.1);
    const h = new THREE.Mesh(head, fur);
    h.position.set(0, 1.0, -0.75);
    const eyeGeo = new THREE.SphereGeometry(0.045, 6, 6);
    this.fallbackGeos.push(eyeGeo);
    for (const sx of [-0.1, 0.1]) {
      const e = new THREE.Mesh(eyeGeo, eye);
      e.position.set(sx, 1.08, -1.0);
      g.add(e);
    }
    for (const [x, z] of [
      [-0.2, -0.45],
      [0.2, -0.45],
      [-0.2, 0.55],
      [0.2, 0.55],
    ]) {
      const l = new THREE.Mesh(leg, fur);
      l.position.set(x, 0.3, z);
      g.add(l);
    }
    g.add(b, h);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    this.fallback = g;
    this.root.add(g);
  }

  private disposeFallback(): void {
    if (this.fallback) {
      this.root.remove(this.fallback);
      this.fallback = null;
    }
    if (this.stealthEyes.length) this.stealthEyes = this.stealthEyes.filter((m) => !this.fallbackMats.includes(m));
    for (const g of this.fallbackGeos) g.dispose();
    for (const m of this.fallbackMats) m.dispose();
    this.fallbackGeos = [];
    this.fallbackMats = [];
  }

  private play(name: WolfClipName, restart: boolean): void {
    const a = this.actions.get(name);
    if (!a) return;
    if (this.current === name && !restart) return;
    const prev = this.current ? this.actions.get(this.current) : null;
    this.current = name;
    a.reset();
    a.setEffectiveTimeScale(1);
    a.setEffectiveWeight(1);
    a.play();
    if (prev && prev !== a) {
      prev.crossFadeTo(a, FADE, false);
    } else {
      a.fadeIn(FADE);
    }
  }

  /** Jag' soketi (tishlash nuqtasi) jahon koordinatasida — qon effekti uchun. */
  getMouthWorld(out: THREE.Vector3): THREE.Vector3 {
    const s = this.inst?.sockets.get('socket_mouth');
    if (s) return s.getWorldPosition(out);
    return this.root.getWorldPosition(out).add(new THREE.Vector3(0, 0.95 * this.scale, 0));
  }

  /**
   * Har kadr. `camDist` — kameragacha masofa (m): LOD (18/40 m, 2 m gisterezis), soya (40 m dan yo'q), mikser
   * yangilanish qadami (70 m dan har 2-, 110 m dan har 4-kadr, 160 m dan yangilanmaydi — pozitsiya lerp qoladi)
   * va "Tun soyasi" ko'zlari yorqinligi (`wolfStealthEyeGlow`).
   */
  update(dt: number, s: WolfModelState, camDist = 0): void {
    const lod = pickWolfLod(camDist, this.lod);
    if (lod !== this.lod) this.applyLod(lod);
    const shadow = wolfCastsShadowAt(camDist);
    if (shadow !== this.shadowOn) this.applyShadow(shadow);
    this.camDist = camDist;
    this.applyStealthEyes();
    if (!this.mixer) {
      // Zaxira: oddiy "yurish" tebranishi
      if (this.fallback) this.fallback.rotation.z = s.speed > 0.3 ? Math.sin(performance.now() / 90) * 0.05 : 0;
      this.lastState = s.state;
      return;
    }
    const clip = wolfClipFor(s, this.current);
    // Hujum/zarba/uvlash har safar boshidan (holatga qayta kirganda), looplar davom etadi
    const restart = s.state !== this.lastState && !LOOPING.has(clip);
    this.play(clip, restart);
    this.lastState = s.state;
    if (this.current === 'Run' || this.current === 'Walk') {
      // Yurish/yugurish tezligini haqiqiy tezlikka moslash; orqaga siljisa Walk teskari (manfiy timeScale)
      const a = this.actions.get(this.current);
      if (a) a.setEffectiveTimeScale(wolfClipTimeScale(this.current, s, this.scale));
    }
    const stride = wolfMixerStride(camDist);
    this.mixerDtAcc = Math.min(0.5, this.mixerDtAcc + dt);
    if (stride === 0) return;
    this.mixerFrame = (this.mixerFrame + 1) % 4;
    if (this.mixerFrame % stride !== 0) return;
    this.mixer.update(this.mixerDtAcc);
    this.mixerDtAcc = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubReady?.();
    this.unsubReady = null;
    if (this.mixer) {
      this.mixer.stopAllAction();
      if (this.inst) this.mixer.uncacheRoot(this.inst.root);
      this.mixer = null;
    }
    this.actions.clear();
    if (this.inst) {
      this.root.remove(this.inst.root);
      this.inst.dispose();
      this.inst = null;
    }
    this.disposeFallback();
    for (const m of this.stealthMats) m.dispose();
    this.stealthMats = [];
    this.stealthEyes = [];
  }
}
