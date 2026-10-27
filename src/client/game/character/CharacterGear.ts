import * as THREE from 'three';

/**
 * O'yinchi modeliga osilgan jihozlar: kaska (bosh), zirh nimcha (ko'krak), granatalar va aptechkalar
 * (kamar, ovchi uslubida). Ham Camper Buddy GLB suyaklariga, ham protsedural stickman guruhlariga ulanadi.
 *
 * Geometriya va materiallar umumiy (dispose qilinmaydi); har rig faqat o'z Mesh'larini yaratadi.
 */

export interface CharacterGearState {
  helmet: boolean;
  armor: boolean;
  /** 0..3 */
  grenades: number;
  /** 0..3 */
  medkits: number;
}

export const EMPTY_GEAR: CharacterGearState = { helmet: false, armor: false, grenades: 0, medkits: 0 };

export type GearLayout = 'procedural' | 'buddy';

interface GearPoint {
  pos: [number, number, number];
  rot?: [number, number, number];
  scale?: number;
}

interface GearLayoutTable {
  helmet: GearPoint;
  vest: GearPoint;
  grenades: GearPoint[];
  medkits: GearPoint[];
}

/** Protsedural stickman: headGroup (bosh markazi), chest (ko'krak), hips (tos) guruhlari koordinatalarida. */
const LAYOUT_PROCEDURAL: GearLayoutTable = {
  helmet: { pos: [0, 0.14, 0], scale: 1.18 },
  vest: { pos: [0, -0.02, 0], scale: 1.0 },
  grenades: [
    { pos: [-0.27, 0.05, 0.1] },
    { pos: [-0.29, 0.05, -0.03] },
    { pos: [-0.27, 0.05, -0.16] },
  ],
  medkits: [
    { pos: [0.27, 0.05, 0.08], rot: [0, Math.PI / 2, 0] },
    { pos: [0.27, 0.05, -0.08], rot: [0, Math.PI / 2, 0] },
    { pos: [0.1, 0.06, -0.26], rot: [0, 0, 0] },
  ],
};

/** Camper Buddy GLB: Head, Chest, Hips suyaklari lokal koordinatalarida (suyak o'qi Y bo'ylab yuqoriga). */
const LAYOUT_BUDDY: GearLayoutTable = {
  helmet: { pos: [0, 0.12, 0.01], scale: 1.0 },
  // Chest suyagining +Z o'qi orqaga qaraydi — nimcha 180° burilib, cho'ntaklar oldinga chiqadi
  vest: { pos: [0, 0.1, 0], rot: [0, Math.PI, 0], scale: 0.9 },
  grenades: [
    { pos: [-0.27, 0.04, 0.12] },
    { pos: [-0.29, 0.04, 0.0] },
    { pos: [-0.27, 0.04, -0.12] },
  ],
  medkits: [
    { pos: [0.27, 0.04, 0.1], rot: [0, Math.PI / 2, 0] },
    { pos: [0.27, 0.04, -0.08], rot: [0, Math.PI / 2, 0] },
    { pos: [0.1, 0.05, -0.25], rot: [0, 0, 0] },
  ],
};

// ---------- Umumiy geometriya / materiallar ----------
let shared: {
  helmetDome: THREE.BufferGeometry;
  helmetBrim: THREE.BufferGeometry;
  vestFront: THREE.BufferGeometry;
  vestStrap: THREE.BufferGeometry;
  vestPouch: THREE.BufferGeometry;
  grenadeBody: THREE.BufferGeometry;
  grenadeCap: THREE.BufferGeometry;
  medkitBox: THREE.BufferGeometry;
  medkitCross: THREE.BufferGeometry;
  matHelmet: THREE.MeshStandardMaterial;
  matVest: THREE.MeshStandardMaterial;
  matStrap: THREE.MeshStandardMaterial;
  matGrenade: THREE.MeshStandardMaterial;
  matGrenadeCap: THREE.MeshStandardMaterial;
  matMedkit: THREE.MeshStandardMaterial;
  matCross: THREE.MeshStandardMaterial;
} | null = null;

function getShared() {
  if (shared) return shared;
  const mark = <T extends { userData: Record<string, unknown> }>(o: T): T => {
    o.userData.sharedAsset = true;
    return o;
  };
  shared = {
    helmetDome: mark(new THREE.SphereGeometry(0.235, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52)),
    helmetBrim: mark(new THREE.CylinderGeometry(0.255, 0.265, 0.035, 18)),
    vestFront: mark(new THREE.BoxGeometry(0.38, 0.3, 0.05)),
    vestStrap: mark(new THREE.BoxGeometry(0.06, 0.28, 0.4)),
    vestPouch: mark(new THREE.BoxGeometry(0.1, 0.08, 0.05)),
    grenadeBody: mark(new THREE.SphereGeometry(0.052, 12, 9)),
    grenadeCap: mark(new THREE.CylinderGeometry(0.02, 0.02, 0.04, 8)),
    medkitBox: mark(new THREE.BoxGeometry(0.14, 0.1, 0.07)),
    medkitCross: mark(new THREE.BoxGeometry(0.02, 0.06, 0.01)),
    matHelmet: mark(new THREE.MeshStandardMaterial({ color: '#4b5a3c', roughness: 0.6, metalness: 0.15 })),
    matVest: mark(new THREE.MeshStandardMaterial({ color: '#3f5a3a', roughness: 0.85 })),
    matStrap: mark(new THREE.MeshStandardMaterial({ color: '#1f2a1d', roughness: 0.9 })),
    matGrenade: mark(new THREE.MeshStandardMaterial({ color: '#33502e', roughness: 0.7 })),
    matGrenadeCap: mark(new THREE.MeshStandardMaterial({ color: '#8a8f86', roughness: 0.45, metalness: 0.4 })),
    matMedkit: mark(new THREE.MeshStandardMaterial({ color: '#c62828', roughness: 0.6 })),
    matCross: mark(new THREE.MeshStandardMaterial({ color: '#f5f5f5', roughness: 0.6 })),
  };
  return shared;
}

function applyPoint(o: THREE.Object3D, p: GearPoint): void {
  o.position.set(p.pos[0], p.pos[1], p.pos[2]);
  if (p.rot) o.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
  else o.rotation.set(0, 0, 0);
  const s = p.scale ?? 1;
  o.scale.setScalar(s);
}

export function buildHelmetMesh(): THREE.Group {
  const s = getShared();
  const g = new THREE.Group();
  g.name = 'gear_helmet';
  const dome = new THREE.Mesh(s.helmetDome, s.matHelmet);
  dome.castShadow = true;
  g.add(dome);
  const brim = new THREE.Mesh(s.helmetBrim, s.matHelmet);
  brim.position.y = 0.01;
  g.add(brim);
  return g;
}

export function buildVestMesh(): THREE.Group {
  const s = getShared();
  const g = new THREE.Group();
  g.name = 'gear_vest';
  // Yupqa old va orqa plitalar tanaga yopishib turadi (ryukzak emas, nimcha), yon tasmalar va old cho'ntaklar
  const front = new THREE.Mesh(s.vestFront, s.matVest);
  front.position.set(0, 0, 0.2);
  front.castShadow = true;
  g.add(front);
  const back = new THREE.Mesh(s.vestFront, s.matVest);
  back.position.set(0, 0.02, -0.19);
  g.add(back);
  for (const sx of [-1, 1]) {
    const strap = new THREE.Mesh(s.vestStrap, s.matStrap);
    strap.position.set(sx * 0.2, 0.06, 0);
    g.add(strap);
    const pouch = new THREE.Mesh(s.vestPouch, s.matStrap);
    pouch.position.set(sx * 0.1, -0.07, 0.245);
    g.add(pouch);
  }
  return g;
}

export function buildGrenadeMesh(): THREE.Group {
  const s = getShared();
  const g = new THREE.Group();
  g.name = 'gear_grenade';
  g.add(new THREE.Mesh(s.grenadeBody, s.matGrenade));
  const cap = new THREE.Mesh(s.grenadeCap, s.matGrenadeCap);
  cap.position.y = 0.06;
  g.add(cap);
  return g;
}

export function buildMedkitMesh(): THREE.Group {
  const s = getShared();
  const g = new THREE.Group();
  g.name = 'gear_medkit';
  g.add(new THREE.Mesh(s.medkitBox, s.matMedkit));
  const v = new THREE.Mesh(s.medkitCross, s.matCross);
  v.position.z = 0.036;
  g.add(v);
  const h = new THREE.Mesh(s.medkitCross, s.matCross);
  h.position.z = 0.036;
  h.rotation.z = Math.PI / 2;
  g.add(h);
  return g;
}

/** Shader isitish uchun har bir jihozdan bittadan. */
export function createGearPrewarmGroup(): THREE.Group {
  const g = new THREE.Group();
  const items = [buildHelmetMesh(), buildVestMesh(), buildGrenadeMesh(), buildMedkitMesh()];
  items.forEach((it, i) => {
    it.position.set(i * 0.8, 0, 0);
    g.add(it);
  });
  return g;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/** Bitta personajning jihoz osmalari (bosh/ko'krak/kamar ushlagichlari). */
export class CharacterGearRig {
  private readonly headHolder = new THREE.Group();
  private readonly chestHolder = new THREE.Group();
  private readonly beltHolder = new THREE.Group();
  private helmet: THREE.Group | null = null;
  private vest: THREE.Group | null = null;
  private readonly grenades: THREE.Group[] = [];
  private readonly medkits: THREE.Group[] = [];
  private layout: GearLayout = 'procedural';
  private state: CharacterGearState = { ...EMPTY_GEAR };
  private scaleDirty = false;

  constructor() {
    this.headHolder.name = 'gear_head';
    this.chestHolder.name = 'gear_chest';
    this.beltHolder.name = 'gear_belt';
  }

  /** Ushlagichlarni berilgan ota obyektlarga (suyak yoki guruh) ko'chiradi. */
  attach(
    layout: GearLayout,
    head: THREE.Object3D | null,
    chest: THREE.Object3D | null,
    hips: THREE.Object3D | null,
  ): void {
    this.layout = layout;
    this.headHolder.removeFromParent();
    this.chestHolder.removeFromParent();
    this.beltHolder.removeFromParent();
    head?.add(this.headHolder);
    chest?.add(this.chestHolder);
    hips?.add(this.beltHolder);
    for (const h of [this.headHolder, this.chestHolder, this.beltHolder]) h.scale.setScalar(1);
    // GLB suyaklari masshtabli bo'lishi mumkin — birinchi update'da teskari masshtab qo'llanadi
    this.scaleDirty = layout === 'buddy';
    this.applyLayout();
  }

  /** Suyak dunyo masshtabini kompensatsiya qiladi (matrixWorld yangilangach bir marta). */
  update(): void {
    if (!this.scaleDirty) return;
    let done = true;
    for (const h of [this.headHolder, this.chestHolder, this.beltHolder]) {
      const parent = h.parent;
      if (!parent) continue;
      parent.matrixWorld.decompose(_pos, _quat, _scale);
      if (_scale.x === 0 || !Number.isFinite(_scale.x)) {
        done = false;
        continue;
      }
      // Faqat suyak masshtabini olib tashlaymiz (modelning root masshtabi saqlanadi)
      let rootScale = 1;
      let o: THREE.Object3D | null = parent;
      while (o && !o.name.startsWith('camper_buddy')) o = o.parent;
      if (o) {
        o.matrixWorld.decompose(_pos, _quat, _scale);
        rootScale = _scale.x || 1;
        parent.matrixWorld.decompose(_pos, _quat, _scale);
      }
      const k = rootScale / (_scale.x || 1);
      h.scale.setScalar(Number.isFinite(k) && k > 0 ? k : 1);
    }
    if (done) this.scaleDirty = false;
  }

  setState(next: CharacterGearState): void {
    const s = this.state;
    if (
      s.helmet === next.helmet &&
      s.armor === next.armor &&
      s.grenades === next.grenades &&
      s.medkits === next.medkits
    ) {
      return;
    }
    this.state = { helmet: next.helmet, armor: next.armor, grenades: next.grenades, medkits: next.medkits };
    this.applyLayout();
  }

  getState(): CharacterGearState {
    return { ...this.state };
  }

  private applyLayout(): void {
    const table = this.layout === 'buddy' ? LAYOUT_BUDDY : LAYOUT_PROCEDURAL;
    const s = this.state;

    if (s.helmet) {
      if (!this.helmet) {
        this.helmet = buildHelmetMesh();
        this.headHolder.add(this.helmet);
      }
      applyPoint(this.helmet, table.helmet);
      this.helmet.visible = true;
    } else if (this.helmet) {
      this.helmet.visible = false;
    }

    if (s.armor) {
      if (!this.vest) {
        this.vest = buildVestMesh();
        this.chestHolder.add(this.vest);
      }
      applyPoint(this.vest, table.vest);
      this.vest.visible = true;
    } else if (this.vest) {
      this.vest.visible = false;
    }

    const grenadeCount = Math.max(0, Math.min(table.grenades.length, Math.round(s.grenades)));
    while (this.grenades.length < grenadeCount) {
      const m = buildGrenadeMesh();
      this.beltHolder.add(m);
      this.grenades.push(m);
    }
    this.grenades.forEach((m, i) => {
      m.visible = i < grenadeCount;
      if (m.visible) applyPoint(m, table.grenades[i]!);
    });

    const medkitCount = Math.max(0, Math.min(table.medkits.length, Math.round(s.medkits)));
    while (this.medkits.length < medkitCount) {
      const m = buildMedkitMesh();
      this.beltHolder.add(m);
      this.medkits.push(m);
    }
    this.medkits.forEach((m, i) => {
      m.visible = i < medkitCount;
      if (m.visible) applyPoint(m, table.medkits[i]!);
    });
  }

  dispose(): void {
    this.headHolder.removeFromParent();
    this.chestHolder.removeFromParent();
    this.beltHolder.removeFromParent();
    this.headHolder.clear();
    this.chestHolder.clear();
    this.beltHolder.clear();
    this.helmet = null;
    this.vest = null;
    this.grenades.length = 0;
    this.medkits.length = 0;
  }
}
