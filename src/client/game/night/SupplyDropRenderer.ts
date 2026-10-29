import * as THREE from 'three';
import { SUPPLY_BEACON_SEC, type NightSupplyDropEvent, type NightSupplySnap } from '../../../shared/wolf';
import { instantiateContainerAsset, onContainerAssetsReady, type InstantiatedContainerHierarchy } from '../containers';
import { getSharedGlowTexture } from './CampRenderer';

/**
 * Yarim tungi yordam yuki (klient ko'rinishi, "Tong otguncha").
 *
 * Konteyner — `wooden_loot_crate_01` GLB nusxasi (runtime konteyner xarita vizuallarida yo'q, shuning uchun bu
 * yerda chiziladi); qopqoq `opened` bo'lganda ochiladi. 'night:supplyDrop' kelganda quti parashyut bilan
 * DROP_FALL_SEC davomida tushadi (kech qo'shilganlar — NightSnap.supply — animatsiyasiz). Quti yonida
 * SUPPLY_BEACON_SEC davomida uzoqdan ko'rinadigan qizil tutun/mayoq ustuni (additiv spraytlar) va lipillovchi
 * qizil PointLight (konstruktorda yaratiladi — yorug'lik soni o'zgarmasin); quti ochilsa mayoq so'nadi.
 */

const DROP_FALL_SEC = 3.2;
const DROP_START_HEIGHT_M = 40;
const BEACON_SEGMENTS = 7;
const BEACON_HEIGHT_M = 22;
const BEACON_LIGHT_COLOR = '#ff3b2a';
const BEACON_LIGHT_INTENSITY = 2.2;
const BEACON_LIGHT_DISTANCE = 24;
const PUFF_COUNT = 6;

interface Puff {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  phase: number;
  speed: number;
  dx: number;
  dz: number;
}

export class SupplyDropRenderer {
  readonly root = new THREE.Group();
  private readonly light: THREE.PointLight;
  private crate: InstantiatedContainerHierarchy | null = null;
  private crateGroup: THREE.Group | null = null;
  private chute: THREE.Group | null = null;
  private beacon: THREE.Sprite[] = [];
  private beaconMats: THREE.SpriteMaterial[] = [];
  private puffs: Puff[] = [];
  private id: string | null = null;
  private pos = new THREE.Vector3();
  private yaw = 0;
  private droppedAt = -Infinity;
  private beaconUntil = -Infinity;
  private opened = false;
  /** Qopqoq burchagi (0..1 ochiq ulushi), silliq. */
  private lidK = 0;
  private unsubscribeReady: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'night_supply_drop';
    scene.add(this.root);
    this.light = new THREE.PointLight(BEACON_LIGHT_COLOR, 0, BEACON_LIGHT_DISTANCE, 1.6);
    this.light.name = 'supply_beacon_light';
    this.light.position.set(0, -500, 0);
    scene.add(this.light);
    // GLB keyinroq yuklansa — zaxira quti o'rniga haqiqiysi
    this.unsubscribeReady = onContainerAssetsReady(() => {
      if (this.disposed || !this.id || !this.crate?.isFallback) return;
      const { x, y, z } = this.pos;
      this.buildCrate(x, y, z, this.yaw);
    });
  }

  hasDrop(): boolean {
    return this.id !== null;
  }

  getId(): string | null {
    return this.id;
  }

  /** 'night:supplyDrop': parashyut bilan tushish animatsiyasi, mayoq SUPPLY_BEACON_SEC. */
  onDrop(e: NightSupplyDropEvent, nowSec: number): void {
    if (this.disposed) return;
    if (this.id === e.id) return;
    this.place(e.id, e.x, e.y, e.z, nowSec, false);
    this.droppedAt = nowSec;
    this.beaconUntil = nowSec + SUPPLY_BEACON_SEC;
  }

  /**
   * NightSnap.supply: yo'q bo'lsa (yangi raund) quti olib tashlanadi; yangi id — animatsiyasiz paydo bo'ladi
   * (mayoq ham yoqiladi — kech qo'shilgan o'yinchi ham ko'rsin); `opened` har safar moslanadi.
   */
  sync(snap: NightSupplySnap | undefined, nowSec: number): void {
    if (this.disposed) return;
    if (!snap) {
      if (this.id) this.clear();
      return;
    }
    if (this.id !== snap.id) {
      this.place(snap.id, snap.x, snap.y, snap.z, nowSec, true);
      this.droppedAt = nowSec - DROP_FALL_SEC;
      this.beaconUntil = nowSec + SUPPLY_BEACON_SEC;
    }
    this.setOpened(snap.opened);
  }

  /** Quti ochildi (container:state yoki snapshot): qopqoq ochiladi, mayoq so'nadi. */
  setOpened(opened: boolean): void {
    if (this.opened === opened) return;
    this.opened = opened;
    if (opened) this.beaconUntil = -Infinity;
  }

  private place(id: string, x: number, y: number, z: number, nowSec: number, instant: boolean): void {
    this.clear();
    this.id = id;
    this.pos.set(x, y, z);
    // Burilish deterministik (id bo'yicha) — hamma klientda bir xil
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    this.yaw = ((h >>> 0) % 4) * (Math.PI / 2);
    this.opened = false;
    this.lidK = 0;
    this.buildCrate(x, y, z, this.yaw);
    if (!instant) this.buildChute();
    this.buildBeacon(x, y, z);
    void nowSec;
  }

  private buildCrate(x: number, y: number, z: number, yaw: number): void {
    if (this.crateGroup) {
      this.root.remove(this.crateGroup);
      this.crateGroup = null;
      this.crate = null;
    }
    const inst = instantiateContainerAsset('wooden_loot_crate_01');
    inst.root.position.set(x, y, z);
    inst.root.rotation.set(0, yaw, 0);
    inst.root.name = `supply_crate_${this.id ?? ''}`;
    this.root.add(inst.root);
    this.crate = inst;
    this.crateGroup = inst.root;
    this.applyLid();
  }

  /** Parashyut: gumbaz (yarim sfera) + 4 ip; tushish tugagach olib tashlanadi. */
  private buildChute(): void {
    const g = new THREE.Group();
    g.name = 'supply_chute';
    const canopyGeo = new THREE.SphereGeometry(1.9, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const canopyMat = new THREE.MeshStandardMaterial({ color: '#d9d4c7', roughness: 0.9, side: THREE.DoubleSide });
    const canopy = new THREE.Mesh(canopyGeo, canopyMat);
    canopy.position.y = 3.2;
    g.add(canopy);
    const lineMat = new THREE.LineBasicMaterial({ color: '#2a2a2a' });
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      pts.push(new THREE.Vector3(Math.cos(a) * 1.6, 3.2, Math.sin(a) * 1.6), new THREE.Vector3(0, 0.6, 0));
    }
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
    g.add(lines);
    this.root.add(g);
    this.chute = g;
  }

  private buildBeacon(x: number, y: number, z: number): void {
    const tex = getSharedGlowTexture();
    for (let i = 0; i < BEACON_SEGMENTS; i++) {
      const m = new THREE.SpriteMaterial({
        map: tex,
        color: '#ff2a1a',
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        fog: false,
      });
      const sp = new THREE.Sprite(m);
      const k = i / (BEACON_SEGMENTS - 1);
      sp.position.set(x, y + 1.2 + k * BEACON_HEIGHT_M, z);
      sp.scale.set(2.2 + k * 2.6, 4.5, 1);
      sp.renderOrder = 12;
      this.root.add(sp);
      this.beacon.push(sp);
      this.beaconMats.push(m);
    }
    for (let i = 0; i < PUFF_COUNT; i++) {
      const m = new THREE.SpriteMaterial({ map: tex, color: '#c43a2e', transparent: true, depthWrite: false, opacity: 0, fog: false });
      const sp = new THREE.Sprite(m);
      sp.renderOrder = 11;
      this.root.add(sp);
      this.puffs.push({ sprite: sp, mat: m, phase: Math.random(), speed: 0.75 + Math.random() * 0.4, dx: (Math.random() - 0.5) * 0.9, dz: (Math.random() - 0.5) * 0.9 });
    }
  }

  private applyLid(): void {
    const c = this.crate;
    if (!c) return;
    const spec = c.pivotSpec;
    const ang = spec.closedAngleRad + (spec.openAngleRad - spec.closedAngleRad) * this.lidK;
    const axis = spec.axis;
    c.pivotNode.rotation.set(0, 0, 0);
    if (axis === 'x') c.pivotNode.rotation.x = ang;
    else if (axis === 'y') c.pivotNode.rotation.y = ang;
    else c.pivotNode.rotation.z = ang;
  }

  update(dt: number, nowSec: number, camPos: THREE.Vector3): void {
    if (this.disposed || !this.id || !this.crateGroup) return;
    const sd = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    // Tushish: parashyut bilan tekis pastga, oxirida yengil "tup"
    const fall = nowSec - this.droppedAt;
    if (fall < DROP_FALL_SEC) {
      const k = Math.min(1, fall / DROP_FALL_SEC);
      const h = DROP_START_HEIGHT_M * (1 - k) * (1 - k * 0.15);
      const sway = Math.sin(nowSec * 1.3) * 0.6 * (1 - k);
      this.crateGroup.position.set(this.pos.x + sway, this.pos.y + h, this.pos.z);
      if (this.chute) {
        this.chute.position.copy(this.crateGroup.position);
        this.chute.rotation.z = Math.sin(nowSec * 1.3) * 0.08 * (1 - k);
      }
    } else {
      if (this.crateGroup.position.y !== this.pos.y) this.crateGroup.position.copy(this.pos);
      if (this.chute) {
        // Parashyut qisqa vaqt yonida yotadi, keyin yo'qoladi
        const since = fall - DROP_FALL_SEC;
        if (since > 4) {
          this.root.remove(this.chute);
          this.disposeGroup(this.chute);
          this.chute = null;
        } else {
          this.chute.position.set(this.pos.x + 1.6, this.pos.y - 2.6 + Math.max(0, 0.6 - since * 0.3), this.pos.z + 0.8);
          this.chute.rotation.z = Math.min(1.3, since * 0.6);
        }
      }
    }
    // Qopqoq
    const target = this.opened ? 1 : 0;
    if (this.lidK !== target) {
      this.lidK = THREE.MathUtils.damp(this.lidK, target, 8, sd);
      if (Math.abs(this.lidK - target) < 0.004) this.lidK = target;
      this.applyLid();
    }
    // Mayoq ustuni va tutun (quti yerga tushgach): ochilgunga/muddatigacha, oxirgi 8 s da so'nadi
    const landed = fall >= DROP_FALL_SEC * 0.75;
    const left = this.beaconUntil - nowSec;
    const on = landed && left > 0;
    const fade = on ? Math.min(1, left / 8) : 0;
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(nowSec * 2.4));
    for (let i = 0; i < this.beacon.length; i++) {
      const k = i / (this.beacon.length - 1);
      const m = this.beaconMats[i]!;
      m.opacity = fade * (0.42 - k * 0.3) * (0.85 + 0.15 * pulse);
      this.beacon[i]!.visible = m.opacity > 0.01;
      // Ustun yuqoriga qarab yengil chayqaladi
      this.beacon[i]!.position.x = this.pos.x + Math.sin(nowSec * 0.6 + k * 2.1) * k * 1.4;
      this.beacon[i]!.position.z = this.pos.z + Math.cos(nowSec * 0.5 + k * 1.7) * k * 1.4;
    }
    for (const p of this.puffs) {
      if (!on) {
        p.sprite.visible = false;
        continue;
      }
      const cyc = ((nowSec * p.speed * 0.22 + p.phase) % 1 + 1) % 1;
      const h = 0.6 + cyc * 7;
      p.sprite.position.set(this.pos.x + p.dx * (1 + cyc * 3), this.pos.y + h, this.pos.z + p.dz * (1 + cyc * 3));
      p.sprite.scale.setScalar(0.9 + cyc * 2.6);
      p.mat.opacity = fade * 0.34 * Math.sin(cyc * Math.PI);
      p.sprite.visible = true;
    }
    if (on) {
      this.light.position.set(this.pos.x, this.pos.y + 2.2, this.pos.z);
      // Lipillash: 1.2 s da bir "chaqnash"
      const blink = Math.pow(0.5 + 0.5 * Math.sin(nowSec * 5.2), 3);
      this.light.intensity = BEACON_LIGHT_INTENSITY * fade * (0.35 + 0.65 * blink);
    } else if (this.light.intensity !== 0) {
      this.light.intensity = 0;
      this.light.position.set(0, -500, 0);
    }
    void camPos;
  }

  private disposeGroup(g: THREE.Object3D): void {
    g.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        if (o.geometry && !o.geometry.userData?.sharedAsset) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m && !(m as THREE.Material).userData?.sharedAsset) (m as THREE.Material).dispose();
      }
    });
  }

  /** Quti va mayoqni olib tashlaydi (yangi raund / dispose). */
  clear(): void {
    if (this.crateGroup) {
      // GLB geometriya/materiallari umumiy (sharedAsset) — faqat sahnadan olib tashlanadi
      this.root.remove(this.crateGroup);
      this.crateGroup = null;
      this.crate = null;
    }
    if (this.chute) {
      this.root.remove(this.chute);
      this.disposeGroup(this.chute);
      this.chute = null;
    }
    for (let i = 0; i < this.beacon.length; i++) {
      this.root.remove(this.beacon[i]!);
      this.beaconMats[i]!.dispose();
    }
    this.beacon = [];
    this.beaconMats = [];
    for (const p of this.puffs) {
      this.root.remove(p.sprite);
      p.mat.dispose();
    }
    this.puffs = [];
    this.id = null;
    this.opened = false;
    this.lidK = 0;
    this.beaconUntil = -Infinity;
    this.droppedAt = -Infinity;
    if (this.light.intensity !== 0) {
      this.light.intensity = 0;
      this.light.position.set(0, -500, 0);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.unsubscribeReady?.();
    this.unsubscribeReady = null;
    this.scene.remove(this.root);
    this.scene.remove(this.light);
  }
}
