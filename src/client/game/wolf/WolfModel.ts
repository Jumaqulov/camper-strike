import * as THREE from 'three';
import type { WolfState } from '../../../shared/wolf';
import { instantiateWolf, isWolfAssetReady, onWolfAssetReady, preloadWolfAssets, type WolfClipName, type WolfInstance } from './WolfAssetRegistry';

export interface WolfModelState {
  state: WolfState;
  /** Gorizontal tezlik (m/s) — sayrda Idle/Walk tanlash uchun. */
  speed: number;
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

/** Holat → klip. Idle/sniff harakatda Walk ga o'tadi; Walk sig'magan tezlikda (gisterezis bilan) Run. */
export function wolfClipFor(s: WolfModelState, current: WolfClipName | null = null): WolfClipName {
  const clip = baseClipFor(s);
  if (clip !== 'Walk') return clip;
  const runAbove = current === 'Run' ? WOLF_RUN_CLIP_EXIT_SPEED : WOLF_RUN_CLIP_ENTER_SPEED;
  return s.speed > runAbove ? 'Run' : 'Walk';
}

function baseClipFor(s: WolfModelState): WolfClipName {
  switch (s.state) {
    case 'hunt':
      return s.speed > 0.5 ? 'Run' : 'Alert';
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
    default:
      return s.speed > 0.4 ? 'Walk' : 'Idle';
  }
}

const LOOPING: ReadonlySet<WolfClipName> = new Set<WolfClipName>(['Idle', 'Sniff', 'Alert', 'Walk', 'Run']);
const FADE = 0.16;

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

  /** @param coat rang varianti (`WolfSnap.coat`, 0..4) */
  constructor(private readonly coat = 0) {
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

  private attach(): void {
    if (this.inst || this.disposed) return;
    const inst = instantiateWolf(this.coat);
    if (!inst) return;
    this.inst = inst;
    this.root.add(inst.root);
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
    this.disposeFallback();
    this.current = null;
  }

  private buildFallback(): void {
    const g = new THREE.Group();
    const body = new THREE.BoxGeometry(0.6, 0.55, 1.4);
    const head = new THREE.BoxGeometry(0.4, 0.38, 0.55);
    const leg = new THREE.BoxGeometry(0.14, 0.6, 0.14);
    const fur = new THREE.MeshStandardMaterial({ color: '#2a2b2e', roughness: 0.9 });
    const eye = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#ffb020', emissiveIntensity: 3 });
    this.fallbackGeos.push(body, head, leg);
    this.fallbackMats.push(fur, eye);
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
    return this.root.getWorldPosition(out).add(new THREE.Vector3(0, 0.95, 0));
  }

  update(dt: number, s: WolfModelState): void {
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
      // Yurish/yugurish tezligini haqiqiy tezlikka moslash
      const base = this.current === 'Run' ? RUN_CLIP_SPEED : WALK_CLIP_SPEED;
      const a = this.actions.get(this.current);
      if (a) a.setEffectiveTimeScale(THREE.MathUtils.clamp(s.speed / base, CLIP_TIMESCALE_MIN, CLIP_TIMESCALE_MAX));
    }
    this.mixer.update(dt);
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
  }
}
