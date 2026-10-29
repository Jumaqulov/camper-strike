import * as THREE from 'three';
import { FLARE_DURATION_SEC, type NightFlareEvent, type NightFlareSnap } from '../../../shared/wolf';
import { getSharedGlowTexture } from './CampRenderer';

/**
 * Signal raketasi (klient ko'rinishi, "Tong otguncha").
 *
 * Otilganda: FLARE_RISE_SEC davomida qizil "yulduz" tez ko'tariladi (tutun izi bilan), keyin ~FLARE_HANG_HEIGHT_M
 * balandlikda osilib FLARE_DURATION_SEC davomida sekin pastga siljiydi (parashyutdagi raketa kabi, yengil
 * tebranish). Yorug'lik: bitta qizil PointLight (intensivlik 3, masofa 60) — kameraga eng yaqin raketaga
 * biriktiriladi; konstruktorda yaratiladi (Three.js yorug'lik soni o'zgarsa shaderlar qayta kompilyatsiya bo'ladi).
 * Holat serverdan: 'night:flare' hodisasi (otilish animatsiyasi bilan) va NightSnap.flares (kech qo'shilganlar —
 * animatsiyasiz, qolgan vaqt bo'yicha balandlik).
 */

export const FLARE_RISE_SEC = 1.2;
export const FLARE_HANG_HEIGHT_M = 25;
/** Osilgan raketaning pastga siljishi (m/s). */
const FLARE_SINK_MPS = 0.45;
const FLARE_LIGHT_COLOR = '#ff3a2a';
export const FLARE_LIGHT_INTENSITY = 3;
export const FLARE_LIGHT_DISTANCE = 60;
const FLARE_LIGHT_DECAY = 1.4;
/** Tutun izi spraytlari soni va ularning yangilanish oralig'i (s). */
const TRAIL_COUNT = 10;
const TRAIL_INTERVAL = 0.09;

interface FlareInst {
  id: string;
  /** Otilgan joy (yer) va boshlanish vaqti (klient soati). */
  x: number;
  y: number;
  z: number;
  startedAt: number;
  until: number;
  /** Kech qo'shilganlar: otilish animatsiyasisiz (snapshotdan). */
  skipLaunch: boolean;
  group: THREE.Group;
  core: THREE.Mesh;
  glow: THREE.Sprite;
  glowMat: THREE.SpriteMaterial;
  trail: THREE.Sprite[];
  trailMats: THREE.SpriteMaterial[];
  trailPos: THREE.Vector3[];
  trailNextAt: number;
  sway: number;
}

let coreGeo: THREE.SphereGeometry | null = null;
let coreMat: THREE.MeshBasicMaterial | null = null;

function sharedCore() {
  coreGeo ??= new THREE.SphereGeometry(0.22, 10, 8);
  coreMat ??= new THREE.MeshBasicMaterial({ name: 'flare_core_mat', color: '#fff0e8', fog: false });
  return { coreGeo, coreMat };
}

export class FlareRenderer {
  readonly root = new THREE.Group();
  private readonly flares = new Map<string, FlareInst>();
  private readonly light: THREE.PointLight;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'night_flares';
    scene.add(this.root);
    this.light = new THREE.PointLight(FLARE_LIGHT_COLOR, 0, FLARE_LIGHT_DISTANCE, FLARE_LIGHT_DECAY);
    this.light.name = 'flare_light';
    this.light.position.set(0, -500, 0);
    scene.add(this.light);
  }

  /** 'night:flare' hodisasi: otilish animatsiyasi bilan yangi raketa. */
  onEvent(e: NightFlareEvent, nowSec: number): void {
    if (this.disposed || this.flares.has(e.id)) return;
    this.create(e.id, e.x, e.y, e.z, nowSec, nowSec + Math.max(1, e.leftSec), false);
  }

  /**
   * NightSnap.flares: yangi (hodisa kelmagan — kech qo'shilgan/kuzatuvchi) raketalar animatsiyasiz qo'shiladi,
   * mavjudlarining so'nish vaqti serverga moslanadi. Snapshotda yo'q raketalar o'z vaqti bilan so'nadi.
   */
  sync(snaps: readonly NightFlareSnap[] | undefined, nowSec: number): void {
    if (this.disposed || !snaps) return;
    for (const s of snaps) {
      const until = nowSec + Math.max(0.5, s.leftSec);
      const f = this.flares.get(s.id);
      if (f) {
        // leftSec butun soniya (yuqoriga yaxlitlangan) — kichik farqda so'nish vaqti "sakramasin"
        if (Math.abs(f.until - until) > 1.5) f.until = until;
        continue;
      }
      const elapsed = Math.max(0, FLARE_DURATION_SEC - s.leftSec);
      this.create(s.id, s.x, s.y, s.z, nowSec - elapsed, until, elapsed > FLARE_RISE_SEC);
    }
  }

  /** Faol raketalar soni va eng uzoq qolgan vaqt (s) — HUD pilli uchun. */
  activeCount(): number {
    return this.flares.size;
  }
  maxLeftSec(nowSec: number): number {
    let best = 0;
    for (const f of this.flares.values()) best = Math.max(best, f.until - nowSec);
    return best;
  }

  private create(id: string, x: number, y: number, z: number, startedAt: number, until: number, skipLaunch: boolean): void {
    const C = sharedCore();
    const group = new THREE.Group();
    group.name = `flare_${id}`;
    const core = new THREE.Mesh(C.coreGeo, C.coreMat);
    core.frustumCulled = false;
    group.add(core);
    const glowMat = new THREE.SpriteMaterial({
      map: getSharedGlowTexture(),
      color: '#ff3020',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.95,
      fog: false,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(5);
    glow.renderOrder = 14;
    group.add(glow);
    const trail: THREE.Sprite[] = [];
    const trailMats: THREE.SpriteMaterial[] = [];
    const trailPos: THREE.Vector3[] = [];
    for (let i = 0; i < TRAIL_COUNT; i++) {
      const m = new THREE.SpriteMaterial({
        map: getSharedGlowTexture(),
        color: '#b05a4a',
        transparent: true,
        depthWrite: false,
        opacity: 0,
        fog: false,
      });
      const sp = new THREE.Sprite(m);
      sp.scale.setScalar(1.2);
      sp.renderOrder = 13;
      sp.visible = false;
      this.root.add(sp);
      trail.push(sp);
      trailMats.push(m);
      trailPos.push(new THREE.Vector3(x, y, z));
    }
    this.root.add(group);
    const inst: FlareInst = {
      id,
      x,
      y,
      z,
      startedAt,
      until,
      skipLaunch,
      group,
      core,
      glow,
      glowMat,
      trail,
      trailMats,
      trailPos,
      trailNextAt: startedAt,
      sway: Math.random() * Math.PI * 2,
    };
    this.flares.set(id, inst);
    this.place(inst, startedAt);
  }

  /** Raketa joyi: ko'tarilish (ease-out) → osilib sekin tushish, yengil tebranish. */
  private place(f: FlareInst, nowSec: number): void {
    const age = Math.max(0, nowSec - f.startedAt);
    let h: number;
    if (!f.skipLaunch && age < FLARE_RISE_SEC) {
      const k = age / FLARE_RISE_SEC;
      h = FLARE_HANG_HEIGHT_M * (1 - (1 - k) * (1 - k));
    } else {
      const hang = Math.max(0, age - FLARE_RISE_SEC);
      h = Math.max(6, FLARE_HANG_HEIGHT_M - hang * FLARE_SINK_MPS);
    }
    const swayX = Math.sin(nowSec * 0.7 + f.sway) * 0.8;
    const swayZ = Math.cos(nowSec * 0.55 + f.sway * 1.3) * 0.8;
    f.group.position.set(f.x + swayX, f.y + h, f.z + swayZ);
  }

  update(dt: number, nowSec: number, camPos: THREE.Vector3): void {
    if (this.disposed) return;
    let nearest: FlareInst | null = null;
    let nearestD = Infinity;
    for (const [id, f] of this.flares) {
      if (nowSec >= f.until) {
        this.remove(id, f);
        continue;
      }
      this.place(f, nowSec);
      const age = nowSec - f.startedAt;
      const left = f.until - nowSec;
      // Oxirgi 3 s da so'nadi
      const fade = Math.min(1, left / 3);
      const flick = 0.85 + 0.15 * (Math.sin(nowSec * 17.3 + f.sway) * 0.6 + Math.sin(nowSec * 29.1 + f.sway * 2) * 0.4);
      f.glowMat.opacity = 0.95 * fade * flick;
      f.glow.scale.setScalar((4.2 + 1.2 * flick) * (0.6 + 0.4 * fade));
      f.core.scale.setScalar(0.6 + 0.4 * fade);
      // Tutun izi: ko'tarilishda zich, keyin sekin (osilgan raketadan ingichka iz)
      const rising = !f.skipLaunch && age < FLARE_RISE_SEC;
      if (nowSec >= f.trailNextAt) {
        f.trailNextAt = nowSec + (rising ? TRAIL_INTERVAL : TRAIL_INTERVAL * 6);
        const pos = f.trailPos.pop()!;
        pos.copy(f.group.position);
        f.trailPos.unshift(pos);
      }
      for (let i = 0; i < f.trail.length; i++) {
        const sp = f.trail[i]!;
        const m = f.trailMats[i]!;
        const p = f.trailPos[i]!;
        // Iz raketadan pastda qolib, yuqoriga suzadi va yoyiladi
        const k = i / f.trail.length;
        sp.position.set(p.x, p.y + k * 1.5, p.z);
        sp.scale.setScalar(1.0 + k * 2.2);
        m.opacity = (rising ? 0.55 : 0.28) * (1 - k) * fade;
        sp.visible = m.opacity > 0.02;
      }
      const d = f.group.position.distanceToSquared(camPos);
      if (d < nearestD) {
        nearestD = d;
        nearest = f;
      }
    }
    if (nearest) {
      this.light.position.copy(nearest.group.position);
      const left = nearest.until - nowSec;
      const flick = 0.9 + 0.1 * Math.sin(nowSec * 23.7);
      this.light.intensity = FLARE_LIGHT_INTENSITY * Math.min(1, left / 3) * flick;
    } else if (this.light.intensity !== 0) {
      this.light.intensity = 0;
      this.light.position.set(0, -500, 0);
    }
    void dt;
  }

  private remove(id: string, f: FlareInst): void {
    this.flares.delete(id);
    this.root.remove(f.group);
    f.glowMat.dispose();
    for (let i = 0; i < f.trail.length; i++) {
      this.root.remove(f.trail[i]!);
      f.trailMats[i]!.dispose();
    }
  }

  /** Raund almashganda: barcha raketalar o'chadi. */
  clear(): void {
    for (const [id, f] of [...this.flares]) this.remove(id, f);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.scene.remove(this.root);
    this.scene.remove(this.light);
  }
}
