import * as THREE from 'three';
import type { WeaponId } from '../../shared/weapons';
import {
  sampleTerrainHeight,
  sampleTerrainNormal,
  type TerrainDescriptor,
} from '../../shared/world';
import { buildGun, type GunModel } from './GunModels';

export type WorldWeaponPose = 'flat' | 'propped' | 'display';

export interface WorldWeaponItemOptions {
  weapon: WeaponId;
  position?: THREE.Vector3;
  yaw?: number;
  pose?: WorldWeaponPose;
  scale?: number;
  highlighted?: boolean;
}

const highlightRingGeo = new THREE.RingGeometry(0.28, 0.34, 24);
highlightRingGeo.rotateX(-Math.PI / 2);
const highlightRingMat = new THREE.MeshBasicMaterial({
  color: '#ffd166',
  transparent: true,
  opacity: 0.65,
  side: THREE.DoubleSide,
  depthWrite: false,
});

/**
 * Qayta ishlatiladigan world-item render komponenti.
 * Qurolning 3P soddalashtirilgan GLB modelini ('3p' LOD) yerda, stol ustida,
 * konteyner ichida yoki tushib ketgan qurol sifatida render qiladi.
 */
export class WorldWeaponItem {
  readonly root = new THREE.Group();
  readonly weapon: WeaponId;
  private readonly gun: GunModel;
  private readonly pivot = new THREE.Group();
  private readonly highlightRing: THREE.Mesh;
  private pose: WorldWeaponPose;
  private bobPhase = Math.random() * Math.PI * 2;
  private highlighted = false;

  constructor(opts: WorldWeaponItemOptions) {
    this.weapon = opts.weapon;
    this.pose = opts.pose ?? 'flat';
    const scale = opts.scale ?? 1.28;

    this.root.name = `world_weapon_${opts.weapon}`;
    if (opts.position) this.root.position.copy(opts.position);
    if (opts.yaw !== undefined) this.root.rotation.y = opts.yaw;

    this.gun = buildGun(opts.weapon, '3p');
    this.gun.group.scale.setScalar(scale);
    this.pivot.add(this.gun.group);
    this.root.add(this.pivot);

    this.highlightRing = new THREE.Mesh(highlightRingGeo, highlightRingMat);
    this.highlightRing.position.y = 0.015;
    this.highlightRing.visible = Boolean(opts.highlighted);
    this.highlighted = Boolean(opts.highlighted);
    this.root.add(this.highlightRing);

    this.applyPose(this.pose);
  }

  applyPose(pose: WorldWeaponPose): void {
    this.pose = pose;
    switch (pose) {
      case 'flat':
        // Yerda yoki stol ustida yonboshlab yotgan tabiiy holat
        this.pivot.position.set(0, 0.045, 0);
        this.pivot.rotation.set(0.06, 0, Math.PI / 2 - 0.12);
        break;
      case 'propped':
        // Konteyner yoki devorga suyalgan holat
        this.pivot.position.set(0, 0.16, 0);
        this.pivot.rotation.set(-0.42, 0, 0.18);
        break;
      case 'display':
        // Ko'rgazmali / suzib turuvchi holat
        this.pivot.position.set(0, 0.22, 0);
        this.pivot.rotation.set(0.12, 0, 0);
        break;
    }
  }

  /**
   * Positions the world weapon item onto the terrain surface at `(x, z)` using
   * `sampleTerrainHeight(terrain, x, z)` and optionally aligns its tilt to the terrain normal.
   */
  placeOnTerrain(
    terrain: TerrainDescriptor,
    x: number,
    z: number,
    yaw = this.root.rotation.y,
    alignToSlope = true,
  ): void {
    const y = sampleTerrainHeight(terrain, x, z);
    this.root.position.set(x, y, z);
    if (alignToSlope && terrain.kind === 'heightfield') {
      const n = sampleTerrainNormal(terrain, x, z);
      const up = new THREE.Vector3(0, 1, 0);
      const normal = new THREE.Vector3(n.x, n.y, n.z).normalize();
      const tiltQuat = new THREE.Quaternion().setFromUnitVectors(up, normal);
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(up, yaw);
      this.root.quaternion.copy(tiltQuat).multiply(yawQuat);
    } else {
      this.root.rotation.set(0, yaw, 0);
    }
  }

  setHighlighted(active: boolean): void {
    this.highlighted = active;
    this.highlightRing.visible = active;
  }

  isHighlighted(): boolean {
    return this.highlighted;
  }

  update(dt: number): void {
    if (this.pose === 'display') {
      this.bobPhase += dt * 2.2;
      this.pivot.position.y = 0.22 + Math.sin(this.bobPhase) * 0.03;
      this.pivot.rotation.y += dt * 0.85;
    }
  }

  /**
   * Sahna daraxtidan xavfsiz olib tashlaydi.
   * Umumiy keshdagi BufferGeometry va Material resurslarini buzmaydi.
   */
  dispose(): void {
    this.root.parent?.remove(this.root);
    this.pivot.clear();
    this.root.clear();
  }
}
