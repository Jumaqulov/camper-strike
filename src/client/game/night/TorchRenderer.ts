import * as THREE from 'three';
import { createFlameMaterial, getSharedFlameGeo, getSharedGlowTexture } from './CampRenderer';

/**
 * "Tong otguncha" mash'ali (klient ko'rinishi).
 *
 * `TorchProp` — qo'lga ulanadigan model: 0.5 m yog'och dasta + mato o'ralgan uchi + gulxan shaderidagi kichik
 * alanga + shu'la spraytи. Alanga uniformlari `update(t)` da yangilanadi. PointLight'lar propda YO'Q — ular
 * `TorchLightPool` da (sahnada doim 4 ta, intensivligi 0 bilan): Three.js yorug'lik soni o'zgarsa barcha
 * materiallarni qayta kompilyatsiya qiladi, shuning uchun pool konstruktorda bir marta yaratiladi va eng yaqin
 * 4 mash'alga biriktiriladi.
 */

const TORCH_LIGHT_COLOR = '#ff9a3c';
export const TORCH_LIGHT_INTENSITY = 1.6;
export const TORCH_LIGHT_DISTANCE = 9;
const TORCH_LIGHT_DECAY = 1.6;
/** Sahnadagi mash'al yoritgichlari soni (eng yaqinlari yoritiladi). */
export const TORCH_LIGHT_POOL = 4;
/** Dasta uzunligi (m) va alanga masshtabi (gulxan alangasi ~1 m, mash'alniki ~0.22 m). */
const TORCH_STICK_LEN = 0.5;
const TORCH_FLAME_SCALE = 0.22;

let stickGeo: THREE.CylinderGeometry | null = null;
let headGeo: THREE.CylinderGeometry | null = null;
let stickMat: THREE.MeshStandardMaterial | null = null;
let headMat: THREE.MeshStandardMaterial | null = null;

function sharedTorchParts() {
  stickGeo ??= new THREE.CylinderGeometry(0.016, 0.02, TORCH_STICK_LEN, 7);
  headGeo ??= new THREE.CylinderGeometry(0.034, 0.03, 0.09, 8);
  stickMat ??= new THREE.MeshStandardMaterial({ name: 'torch_stick_mat', color: '#6b4a26', roughness: 0.95, metalness: 0 });
  headMat ??= new THREE.MeshStandardMaterial({
    name: 'torch_head_mat',
    color: '#2a1a10',
    emissive: '#ff6a1a',
    emissiveIntensity: 0.9,
    roughness: 0.8,
  });
  return { stickGeo, headGeo, stickMat, headMat };
}

export class TorchProp {
  readonly root = new THREE.Group();
  private readonly flameMat: THREE.ShaderMaterial;
  private readonly glowMat: THREE.SpriteMaterial;
  private readonly seed = Math.random() * 100;
  private disposed = false;

  constructor() {
    const P = sharedTorchParts();
    this.root.name = 'torch_prop';
    // Dasta: markazi y = len/2 (pastki uchi qo'lda, uchi yuqorida)
    const stick = new THREE.Mesh(P.stickGeo, P.stickMat);
    stick.position.y = TORCH_STICK_LEN / 2;
    stick.castShadow = false;
    this.root.add(stick);
    const head = new THREE.Mesh(P.headGeo, P.headMat);
    head.position.y = TORCH_STICK_LEN - 0.03;
    this.root.add(head);

    this.flameMat = createFlameMaterial(0.1);
    const flame = new THREE.Mesh(getSharedFlameGeo(), this.flameMat);
    flame.scale.setScalar(TORCH_FLAME_SCALE);
    flame.position.y = TORCH_STICK_LEN + 0.01;
    flame.renderOrder = 12;
    flame.frustumCulled = false;
    this.root.add(flame);

    this.glowMat = new THREE.SpriteMaterial({
      map: getSharedGlowTexture(),
      color: '#ff9a3c',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.35,
      fog: false,
    });
    const glow = new THREE.Sprite(this.glowMat);
    glow.scale.setScalar(0.42);
    glow.position.y = TORCH_STICK_LEN + 0.1;
    glow.renderOrder = 11;
    this.root.add(glow);
  }

  /** Alanga lipillashi (har kadr). */
  update(t: number): void {
    const u = this.flameMat.uniforms;
    const flick = 0.9 + 0.1 * (Math.sin(t * 12.1 + this.seed) * 0.6 + Math.sin(t * 19.3 + this.seed * 1.7) * 0.4);
    u.uTime.value = t + this.seed;
    u.uHeight.value = 0.9 + 0.15 * Math.sin(t * 7.3 + this.seed);
    u.uIntensity.value = 0.85 + 0.15 * flick;
    this.glowMat.opacity = 0.28 + 0.1 * flick;
  }

  /** Alanga uchining dunyo koordinatasi (yoritgich va ovoz uchun). */
  getFlameWorld(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, TORCH_STICK_LEN + 0.08, 0);
    return this.root.localToWorld(out);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.flameMat.dispose();
    this.glowMat.dispose();
  }
}

/** Mash'al yoritgichlari hovuzi: eng yaqin TORCH_LIGHT_POOL mash'alga iliq lipillovchi PointLight. */
export class TorchLightPool {
  private readonly lights: THREE.PointLight[] = [];

  constructor(private readonly scene: THREE.Scene, max = TORCH_LIGHT_POOL) {
    for (let i = 0; i < max; i++) {
      const l = new THREE.PointLight(TORCH_LIGHT_COLOR, 0, TORCH_LIGHT_DISTANCE, TORCH_LIGHT_DECAY);
      l.name = `torch_light_${i}`;
      l.position.set(0, -500, 0);
      scene.add(l);
      this.lights.push(l);
    }
  }

  /** `torches` — ko'rinadigan mash'allar; eng yaqinlari yoritiladi, qolgan yoritgichlar o'chiq (intensivlik 0). */
  update(torches: readonly TorchProp[], camPos: THREE.Vector3, t: number): void {
    const ranked: { d: number; pos: THREE.Vector3 }[] = [];
    for (const tp of torches) {
      const pos = tp.getFlameWorld(new THREE.Vector3());
      ranked.push({ d: pos.distanceToSquared(camPos), pos });
    }
    ranked.sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i]!;
      const r = ranked[i];
      if (!r) {
        if (l.intensity !== 0) {
          l.intensity = 0;
          l.position.set(0, -500, 0);
        }
        continue;
      }
      l.position.copy(r.pos);
      const flick = 0.9 + 0.1 * (Math.sin(t * 13.7 + i) * 0.6 + Math.sin(t * 21.1 + i * 2.3) * 0.4);
      l.intensity = TORCH_LIGHT_INTENSITY * flick;
    }
  }

  dispose(): void {
    for (const l of this.lights) {
      this.scene.remove(l);
      l.dispose();
    }
    this.lights.length = 0;
  }
}
