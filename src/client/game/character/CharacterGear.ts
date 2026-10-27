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
  // Granatalar chap kamarda qisqichi tanaga qaragan holda osilib turadi, aptechkalar o'ng kamarda ilmog'i tanaga qaragan
  grenades: [
    { pos: [-0.27, 0.0, 0.12], rot: [0.12, Math.PI, -0.08], scale: 1.15 },
    { pos: [-0.29, 0.0, 0.0], rot: [0, Math.PI, -0.1], scale: 1.15 },
    { pos: [-0.27, 0.0, -0.12], rot: [-0.12, Math.PI, -0.08], scale: 1.15 },
  ],
  medkits: [
    { pos: [0.27, 0.02, 0.1], rot: [0, Math.PI / 2, 0], scale: 1.15 },
    { pos: [0.27, 0.02, -0.08], rot: [0, Math.PI / 2, 0], scale: 1.15 },
    { pos: [0.1, 0.03, -0.25], rot: [0, Math.PI, 0], scale: 1.15 },
  ],
};

// ---------- Umumiy geometriya / materiallar ----------
// Barcha jihozlar umumiy geometriya va materiallardan yig'iladi (dispose qilinmaydi, userData.sharedAsset).
interface GearShared {
  geo: Record<string, THREE.BufferGeometry>;
  mat: Record<string, THREE.MeshStandardMaterial>;
}

let shared: GearShared | null = null;

function getShared(): GearShared {
  if (shared) return shared;
  const g = <T extends THREE.BufferGeometry>(x: T): T => {
    x.userData.sharedAsset = true;
    return x;
  };
  const m = (opts: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
    const mat = new THREE.MeshStandardMaterial(opts);
    mat.userData.sharedAsset = true;
    return mat;
  };
  shared = {
    geo: {
      // Kaska
      helmetDome: g(new THREE.SphereGeometry(0.235, 26, 16, 0, Math.PI * 2, 0, Math.PI * 0.56)),
      helmetRim: g(new THREE.TorusGeometry(0.236, 0.02, 8, 30)),
      helmetBand: g(new THREE.TorusGeometry(0.238, 0.011, 6, 30)),
      helmetVisor: g(new THREE.BoxGeometry(0.16, 0.012, 0.07)),
      helmetStrap: g(new THREE.BoxGeometry(0.012, 0.15, 0.028)),
      helmetRivet: g(new THREE.SphereGeometry(0.011, 8, 6)),
      // Nimcha (plita ko'targich)
      vestPlate: g(new THREE.BoxGeometry(0.36, 0.3, 0.06)),
      vestMolle: g(new THREE.BoxGeometry(0.3, 0.016, 0.008)),
      vestShoulder: g(new THREE.BoxGeometry(0.07, 0.03, 0.44)),
      vestSide: g(new THREE.BoxGeometry(0.04, 0.2, 0.3)),
      vestPouch: g(new THREE.BoxGeometry(0.08, 0.1, 0.05)),
      vestPouchFlap: g(new THREE.BoxGeometry(0.085, 0.03, 0.056)),
      vestBuckle: g(new THREE.BoxGeometry(0.03, 0.018, 0.012)),
      vestRadio: g(new THREE.BoxGeometry(0.04, 0.09, 0.03)),
      vestAntenna: g(new THREE.CylinderGeometry(0.003, 0.003, 0.09, 6)),
      // Granata (ananas tipli)
      grenadeBody: g(new THREE.SphereGeometry(0.05, 16, 12)),
      grenadeRingH: g(new THREE.TorusGeometry(0.049, 0.0055, 6, 24)),
      grenadeRingV: g(new THREE.TorusGeometry(0.052, 0.0045, 6, 24)),
      grenadeNeck: g(new THREE.CylinderGeometry(0.017, 0.021, 0.03, 10)),
      grenadeCap: g(new THREE.CylinderGeometry(0.015, 0.015, 0.022, 10)),
      grenadeLever: g(new THREE.BoxGeometry(0.012, 0.095, 0.018)),
      grenadeRing: g(new THREE.TorusGeometry(0.014, 0.003, 6, 14)),
      grenadeClip: g(new THREE.BoxGeometry(0.03, 0.05, 0.01)),
      // Aptechka (tibbiy sumkacha)
      medkitBody: g(new THREE.BoxGeometry(0.13, 0.1, 0.07)),
      medkitFlap: g(new THREE.BoxGeometry(0.135, 0.036, 0.076)),
      medkitZip: g(new THREE.BoxGeometry(0.122, 0.005, 0.005)),
      medkitPatch: g(new THREE.CircleGeometry(0.03, 20)),
      medkitCross: g(new THREE.BoxGeometry(0.012, 0.038, 0.004)),
      medkitLoop: g(new THREE.BoxGeometry(0.035, 0.085, 0.012)),
      medkitSnap: g(new THREE.SphereGeometry(0.006, 8, 6)),
    },
    mat: {
      helmet: m({ color: '#4a5a3a', roughness: 0.72, metalness: 0.08 }),
      helmetBand: m({ color: '#2f3a28', roughness: 0.95 }),
      strap: m({ color: '#23291f', roughness: 0.95 }),
      metal: m({ color: '#8d9188', roughness: 0.4, metalness: 0.65 }),
      metalDark: m({ color: '#4c5049', roughness: 0.5, metalness: 0.5 }),
      vest: m({ color: '#59663f', roughness: 0.9 }),
      vestDark: m({ color: '#3f4a2d', roughness: 0.92 }),
      grenade: m({ color: '#3b5230', roughness: 0.65, metalness: 0.12 }),
      grenadeGroove: m({ color: '#263620', roughness: 0.7, metalness: 0.1 }),
      medkit: m({ color: '#b3261e', roughness: 0.88 }),
      medkitDark: m({ color: '#8a1b15', roughness: 0.9 }),
      white: m({ color: '#f4f4f0', roughness: 0.7 }),
      red: m({ color: '#d7342a', roughness: 0.7 }),
    },
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

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, castShadow = false): THREE.Mesh {
  const x = new THREE.Mesh(geo, mat);
  x.castShadow = castShadow;
  x.receiveShadow = true;
  return x;
}

/** Jangovar kaska: gumbaz, gardish, kamuflyaj tasmasi, old qalpoqcha, iyak tasmalari, parchinlar. */
export function buildHelmetMesh(): THREE.Group {
  const s = getShared();
  const g = new THREE.Group();
  g.name = 'gear_helmet';
  const dome = mesh(s.geo.helmetDome!, s.mat.helmet!, true);
  dome.scale.set(1, 0.9, 1.07);
  g.add(dome);
  const rim = mesh(s.geo.helmetRim!, s.mat.helmet!);
  rim.rotation.x = Math.PI / 2;
  rim.scale.set(1, 1.07, 1);
  rim.position.y = 0.005;
  g.add(rim);
  const band = mesh(s.geo.helmetBand!, s.mat.helmetBand!);
  band.rotation.x = Math.PI / 2;
  band.scale.set(0.98, 1.05, 1);
  band.position.y = 0.075;
  g.add(band);
  const visor = mesh(s.geo.helmetVisor!, s.mat.helmet!);
  visor.position.set(0, -0.002, 0.26);
  visor.rotation.x = 0.18;
  g.add(visor);
  for (const sx of [-1, 1]) {
    const strap = mesh(s.geo.helmetStrap!, s.mat.strap!);
    strap.position.set(sx * 0.225, -0.075, 0.03);
    strap.rotation.z = sx * 0.12;
    g.add(strap);
    for (const z of [-0.08, 0.1]) {
      const rivet = mesh(s.geo.helmetRivet!, s.mat.metalDark!);
      rivet.position.set(sx * 0.23, 0.04, z);
      g.add(rivet);
    }
  }
  return g;
}

/** Plita ko'targich nimcha: old/orqa plitalar, MOLLE tasmalar, yelka va yon tasmalar, magazin cho'ntaklari, ratsiya. */
export function buildVestMesh(): THREE.Group {
  const s = getShared();
  const g = new THREE.Group();
  g.name = 'gear_vest';
  const front = mesh(s.geo.vestPlate!, s.mat.vest!, true);
  front.position.set(0, 0, 0.2);
  g.add(front);
  const back = mesh(s.geo.vestPlate!, s.mat.vest!);
  back.position.set(0, 0.02, -0.19);
  g.add(back);
  // MOLLE tasmalar (old va orqa)
  for (let i = 0; i < 4; i++) {
    const y = 0.1 - i * 0.055;
    const mf = mesh(s.geo.vestMolle!, s.mat.vestDark!);
    mf.position.set(0, y, 0.234);
    g.add(mf);
    const mb = mesh(s.geo.vestMolle!, s.mat.vestDark!);
    mb.position.set(0, y + 0.02, -0.224);
    g.add(mb);
  }
  for (const sx of [-1, 1]) {
    const shoulder = mesh(s.geo.vestShoulder!, s.mat.vestDark!);
    shoulder.position.set(sx * 0.12, 0.165, 0.0);
    g.add(shoulder);
    const buckle = mesh(s.geo.vestBuckle!, s.mat.metalDark!);
    buckle.position.set(sx * 0.12, 0.17, 0.17);
    g.add(buckle);
    const side = mesh(s.geo.vestSide!, s.mat.vestDark!);
    side.position.set(sx * 0.19, -0.03, 0);
    g.add(side);
  }
  // Oldidagi uchta magazin cho'ntagi (qopqoqli)
  for (const x of [-0.1, 0, 0.1]) {
    const pouch = mesh(s.geo.vestPouch!, s.mat.vestDark!);
    pouch.position.set(x, -0.05, 0.255);
    g.add(pouch);
    const flap = mesh(s.geo.vestPouchFlap!, s.mat.vest!);
    flap.position.set(x, 0.005, 0.258);
    g.add(flap);
  }
  // Chap yelkadagi ratsiya va antenna
  const radio = mesh(s.geo.vestRadio!, s.mat.strap!);
  radio.position.set(-0.13, 0.08, 0.235);
  g.add(radio);
  const antenna = mesh(s.geo.vestAntenna!, s.mat.metalDark!);
  antenna.position.set(-0.14, 0.17, 0.235);
  g.add(antenna);
  return g;
}

/** "Ananas" tipli qo'l granatasi: segmentli tana, bo'yin, zapal qalpog'i, richag va halqa, kamar qisqichi. */
export function buildGrenadeMesh(): THREE.Group {
  const s = getShared();
  const g = new THREE.Group();
  g.name = 'gear_grenade';
  const body = mesh(s.geo.grenadeBody!, s.mat.grenade!, true);
  body.scale.set(1, 1.25, 1);
  g.add(body);
  for (const y of [-0.028, 0, 0.028]) {
    const ring = mesh(s.geo.grenadeRingH!, s.mat.grenadeGroove!);
    ring.rotation.x = Math.PI / 2;
    const k = Math.sqrt(Math.max(0.2, 1 - (y / 0.0625) ** 2));
    ring.scale.set(k, k, 1);
    ring.position.y = y;
    g.add(ring);
  }
  for (let i = 0; i < 4; i++) {
    const ring = mesh(s.geo.grenadeRingV!, s.mat.grenadeGroove!);
    ring.rotation.y = (i * Math.PI) / 4;
    ring.scale.set(1, 1.2, 1);
    g.add(ring);
  }
  const neck = mesh(s.geo.grenadeNeck!, s.mat.metalDark!);
  neck.position.y = 0.07;
  g.add(neck);
  const cap = mesh(s.geo.grenadeCap!, s.mat.metal!);
  cap.position.y = 0.094;
  g.add(cap);
  const lever = mesh(s.geo.grenadeLever!, s.mat.metal!);
  lever.position.set(0.034, 0.05, 0);
  lever.rotation.z = -0.22;
  g.add(lever);
  const ring = mesh(s.geo.grenadeRing!, s.mat.metal!);
  ring.position.set(0.012, 0.105, 0.018);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  // Kamarga osish qisqichi (orqa tomonda)
  const clip = mesh(s.geo.grenadeClip!, s.mat.strap!);
  clip.position.set(-0.04, 0.03, 0);
  clip.rotation.y = Math.PI / 2;
  g.add(clip);
  return g;
}

/** Tibbiy sumkacha: qizil mato tana, qopqoq, zamok chizig'i, oq doira ichida qizil xoch, kamar ilmog'i. */
export function buildMedkitMesh(): THREE.Group {
  const s = getShared();
  const g = new THREE.Group();
  g.name = 'gear_medkit';
  const body = mesh(s.geo.medkitBody!, s.mat.medkit!, true);
  g.add(body);
  const flap = mesh(s.geo.medkitFlap!, s.mat.medkitDark!);
  flap.position.set(0, 0.035, 0.004);
  g.add(flap);
  const zip = mesh(s.geo.medkitZip!, s.mat.metalDark!);
  zip.position.set(0, 0.015, 0.037);
  g.add(zip);
  const patch = mesh(s.geo.medkitPatch!, s.mat.white!);
  patch.position.set(0, -0.012, 0.0362);
  g.add(patch);
  const crossV = mesh(s.geo.medkitCross!, s.mat.red!);
  crossV.position.set(0, -0.012, 0.0385);
  g.add(crossV);
  const crossH = mesh(s.geo.medkitCross!, s.mat.red!);
  crossH.position.set(0, -0.012, 0.0385);
  crossH.rotation.z = Math.PI / 2;
  g.add(crossH);
  for (const sx of [-1, 1]) {
    const snap = mesh(s.geo.medkitSnap!, s.mat.metal!);
    snap.position.set(sx * 0.045, 0.035, 0.043);
    g.add(snap);
  }
  // Kamar ilmog'i (orqada, yuqoriga ko'tarilgan)
  const loop = mesh(s.geo.medkitLoop!, s.mat.strap!);
  loop.position.set(0, 0.02, -0.04);
  g.add(loop);
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
