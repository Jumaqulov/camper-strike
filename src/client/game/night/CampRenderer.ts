import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CAMPFIRE_LOW_FUEL_SEC,
  NIGHT_CAMPFIRE_COUNT,
  WOOD_PILE_BEACON_RANGE_M,
  type CampfireSnap,
  type WoodPileSnap,
} from '../../../shared/wolf/camp';
import { radialTexture } from '../Textures';

/**
 * "Tong otguncha" lageri — gulxanlar va o'tin g'aramlari (klient tomoni, faqat ko'rinish).
 *
 * Joylashuv serverdan NightSnap.fires / piles orqali keladi va raund davomida o'zgarmaydi: modellar
 * birinchi snapshotda bir marta quriladi, keyin har snapshotda faqat holat (o'tin, yonish, bo'sh/to'la)
 * yangilanadi. Har kadrda olov lipillashi, uchqunlar, yorug'lik titrashi yangilanadi.
 *
 * Arzonlik: barcha geometriyalar umumiy (modul keshi), bir gulxan = tosh halqa + g'o'lalar (bitta mesh,
 * vertex ranglar) + olov (bitta ShaderMaterial mesh, lipillash vertex shaderda) + uchqun/tutun Points +
 * yer shu'lasi diski + PointLight. Yonayotgan gulxan ≈ 4 draw call, o'chgani ≈ 2.
 *
 * PointLight'lar konstruktorda darhol (intensivligi 0 bilan) sahnaga qo'shiladi — Three.js yorug'lik
 * SONI o'zgarganda barcha materiallarni qayta kompilyatsiya qiladi, bu o'yin o'rtasida qotish beradi.
 */

/** Olov balandligi: o'tin ulushi 0..1 → 0.5..1.2. */
export function flameScaleForFuel(fuelSec: number, maxFuelSec: number): number {
  const k = maxFuelSec > 0 ? Math.max(0, Math.min(1, fuelSec / maxFuelSec)) : 0;
  return 0.5 + 0.7 * k;
}

export interface CampFireView {
  id: string;
  x: number;
  y: number;
  z: number;
  lit: boolean;
  main: boolean;
  /** Ekstrapolyatsiya qilingan qolgan o'tin (s). */
  fuelSec: number;
  maxFuelSec: number;
  /** Olov balandligi 0.5..1.2 (ovoz kuchi uchun ham). */
  flame: number;
}

export interface CampPileView {
  id: string;
  x: number;
  y: number;
  z: number;
  available: boolean;
  respawnInSec: number;
}

const FIRE_LIGHT_COLOR = '#ff9a3c';
const FIRE_LIGHT_INTENSITY = 3.5;
const FIRE_LIGHT_DISTANCE = 16;
const FIRE_LIGHT_DECAY = 1.6;
const FIRE_LIGHT_HEIGHT = 0.95;
const EMBER_COUNT = 28;
const SMOKE_COUNT = 10;
/** Uchqun/tutun zarralari shu masofadan nari yangilanmaydi (kamera, m). */
const PARTICLE_UPDATE_DIST = 60;

// ---------------- Umumiy (modul) geometriya va materiallar ----------------

interface SharedCampAssets {
  /** Tosh halqa + yonayotgan g'o'lalar (vertex ranglar). */
  fireBaseLitGeo: THREE.BufferGeometry;
  /** Tosh halqa + kuygan qora g'o'lalar. */
  fireBaseOutGeo: THREE.BufferGeometry;
  fireBaseMat: THREE.MeshStandardMaterial;
  flameGeo: THREE.BufferGeometry;
  glowGeo: THREE.CircleGeometry;
  glowTex: THREE.Texture;
  particleTex: THREE.Texture;
  emberMat: THREE.PointsMaterial;
  smokeMat: THREE.PointsMaterial;
  pileFullGeo: THREE.BufferGeometry;
  pileEmptyGeo: THREE.BufferGeometry;
  pileMat: THREE.MeshStandardMaterial;
  pileEmptyMat: THREE.MeshStandardMaterial;
}

let shared: SharedCampAssets | null = null;

const FLAME_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uHeight;
  uniform float uSway;
  attribute float aSeed;
  attribute float aH;
  varying float vT;
  varying float vRim;
  void main() {
    vT = position.y / aH; // 0 — tag, 1 — uch
    // Har bir alanga o'z fazasida "nafas oladi" va uchi shamolda tebranadi
    float breathe = 0.86 + 0.14 * sin(uTime * (6.0 + aSeed * 3.0) + aSeed * 6.2831);
    vec3 p = position;
    p.y *= uHeight * breathe;
    float sway = vT * vT * uSway;
    p.x += sin(uTime * 8.5 + aSeed * 4.0 + vT * 3.0) * sway;
    p.z += cos(uTime * 6.9 + aSeed * 2.3 + vT * 2.4) * sway;
    vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vec3 viewDir = normalize(-mvPos.xyz);
    vRim = abs(dot(n, viewDir));
    gl_Position = projectionMatrix * mvPos;
  }
`;

const FLAME_FRAG = /* glsl */ `
  precision highp float;
  uniform float uIntensity;
  varying float vT;
  varying float vRim;
  void main() {
    // Tagida sariq-oq, uchida qizg'ish-to'q sariq; chetlarida va uchida shaffoflashadi
    vec3 base = vec3(1.0, 0.86, 0.42);
    vec3 tip = vec3(1.0, 0.30, 0.04);
    vec3 col = mix(base, tip, smoothstep(0.05, 0.85, vT));
    float a = (1.0 - vT) * (0.35 + 0.65 * vRim) * uIntensity;
    a *= smoothstep(0.0, 0.08, vT);
    gl_FragColor = vec4(col * a, a);
  }
`;

/** Silindr geometriyasiga vertex ranglar: yon — po'stloq, qopqoqlar — kesilgan yog'och (ochroq). */
function colorLog(geo: THREE.CylinderGeometry, bark: THREE.Color, cut: THREE.Color): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const idx = geo.getIndex()!;
  for (const grp of geo.groups) {
    const c = grp.materialIndex === 0 ? bark : cut;
    for (let i = grp.start; i < grp.start + grp.count; i++) {
      const v = idx.getX(i);
      colors[v * 3] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.clearGroups();
  return geo;
}

function solidColor(geo: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** Yog'och g'o'la: `len` m uzunlikda, `r` radius, berilgan pozitsiya/burilish bilan (yotgan holda, X bo'ylab). */
function makeLog(
  len: number,
  r: number,
  bark: THREE.Color,
  cut: THREE.Color,
  px: number,
  py: number,
  pz: number,
  yaw: number,
  tilt = 0,
): THREE.BufferGeometry {
  const cyl = new THREE.CylinderGeometry(r * 0.92, r, len, 7, 1);
  colorLog(cyl, bark, cut);
  // Dodekaedr toshlar indekssiz — birlashtirish uchun g'o'lalar ham indekssiz bo'lsin
  const g = cyl.toNonIndexed();
  cyl.dispose();
  // Silindr Y bo'ylab — yotqizamiz (Z atrofida 90°), keyin tilt va yaw
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(tilt, yaw, Math.PI / 2, 'YXZ');
  q.setFromEuler(e);
  m.compose(new THREE.Vector3(px, py, pz), q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Tosh halqa (9 ta past dodekaedr) — vertex ranglar bilan, kulrang tuslar. */
function makeStoneRing(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.17;
    const rr = 0.72 + ((i * 37) % 7) * 0.012;
    const s = 0.19 + ((i * 53) % 5) * 0.018;
    const g = new THREE.DodecahedronGeometry(s, 0);
    const shade = 0.36 + ((i * 29) % 6) * 0.03;
    solidColor(g, new THREE.Color(shade, shade * 0.98, shade * 0.95));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.7, a, i * 0.4));
    m.compose(new THREE.Vector3(Math.cos(a) * rr, s * 0.55, Math.sin(a) * rr), q, new THREE.Vector3(1.15, 0.7, 1.0));
    g.applyMatrix4(m);
    out.push(g);
  }
  return out;
}

/** Chalishtirilgan 4 g'o'la (ikkitasi yotiq, ikkitasi suyanib). */
function makeFireLogs(bark: THREE.Color, cut: THREE.Color): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  out.push(makeLog(0.95, 0.075, bark, cut, 0, 0.08, 0, 0.35));
  out.push(makeLog(0.9, 0.07, bark, cut, 0, 0.09, 0, 0.35 + Math.PI / 2));
  out.push(makeLog(0.85, 0.065, bark, cut, 0.06, 0.26, 0, 1.1, 0.5));
  out.push(makeLog(0.8, 0.06, bark, cut, -0.05, 0.27, 0.04, -0.9, -0.55));
  return out;
}

/** Olov: 4 konus (tag y=0, uch y=1), har biri o'z `aSeed` bilan — vertex shaderda lipillaydi. */
function makeFlameGeo(): THREE.BufferGeometry {
  const cones: THREE.BufferGeometry[] = [];
  const spec: [number, number, number, number][] = [
    // radius, height, x, z
    [0.34, 1.0, 0, 0],
    [0.22, 0.78, 0.16, 0.1],
    [0.2, 0.7, -0.15, 0.12],
    [0.18, 0.62, 0.02, -0.17],
  ];
  spec.forEach(([r, h, x, z], i) => {
    const g = new THREE.ConeGeometry(r, h, 7, 1, true);
    g.translate(x, h / 2, z); // tag y=0, uch y=h
    const count = g.getAttribute('position').count;
    // aSeed — alanga fazasi, aH — konus balandligi (shaderda y/aH = 0..1 "tagdan uchga")
    g.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(count).fill(i / spec.length), 1));
    g.setAttribute('aH', new THREE.BufferAttribute(new Float32Array(count).fill(h), 1));
    cones.push(g);
  });
  const merged = mergeGeometries(cones, false)!;
  for (const c of cones) c.dispose();
  return merged;
}

/** O'tin g'arami: 6 g'o'la piramida (3 + 2 + 1). */
function makePileGeo(bark: THREE.Color, cut: THREE.Color, full: boolean): THREE.BufferGeometry {
  const logs: THREE.BufferGeometry[] = [];
  const r = 0.11;
  if (full) {
    logs.push(makeLog(1.1, r, bark, cut, 0, r, -0.24, 0.04));
    logs.push(makeLog(1.15, r, bark, cut, 0.02, r, 0, -0.03));
    logs.push(makeLog(1.05, r, bark, cut, -0.03, r, 0.24, 0.05));
    logs.push(makeLog(1.08, r, bark, cut, 0.01, r * 2.85, -0.12, -0.02));
    logs.push(makeLog(1.0, r, bark, cut, -0.02, r * 2.85, 0.12, 0.03));
    logs.push(makeLog(0.95, r * 0.95, bark, cut, 0.03, r * 4.6, 0, 0.0));
  } else {
    logs.push(makeLog(1.0, r * 0.9, bark, cut, 0, r * 0.9, 0.05, 0.08));
  }
  const merged = mergeGeometries(logs, false)!;
  for (const l of logs) l.dispose();
  return merged;
}

function getShared(): SharedCampAssets {
  if (shared) return shared;
  const bark = new THREE.Color('#5a3a1e');
  const cut = new THREE.Color('#c9a06a');
  const charBark = new THREE.Color('#1a1411');
  const charCut = new THREE.Color('#3a2a1e');

  const stones = makeStoneRing();
  const litLogs = makeFireLogs(bark, cut);
  const outLogs = makeFireLogs(charBark, charCut);
  const fireBaseLitGeo = mergeGeometries([...stones.map((g) => g.clone()), ...litLogs], false)!;
  const fireBaseOutGeo = mergeGeometries([...stones, ...outLogs], false)!;
  for (const g of [...litLogs, ...outLogs, ...stones]) g.dispose();

  const fireBaseMat = new THREE.MeshStandardMaterial({
    name: 'camp_fire_base_mat',
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.02,
  });

  const flameGeo = makeFlameGeo();
  const glowGeo = new THREE.CircleGeometry(1, 28);
  glowGeo.rotateX(-Math.PI / 2);
  const glowTex = radialTexture('rgba(255,150,60,0.85)', 'rgba(255,120,40,0)', 128);
  const particleTex = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 32);
  const emberMat = new THREE.PointsMaterial({
    map: particleTex,
    color: '#ffb347',
    size: 0.07,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const smokeMat = new THREE.PointsMaterial({
    map: particleTex,
    color: '#8a8a8a',
    size: 0.55,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });

  const pileMat = new THREE.MeshStandardMaterial({
    name: 'camp_pile_mat',
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
  });
  const pileEmptyMat = new THREE.MeshStandardMaterial({
    name: 'camp_pile_empty_mat',
    vertexColors: true,
    roughness: 0.9,
    transparent: true,
    opacity: 0.45,
  });

  shared = {
    fireBaseLitGeo,
    fireBaseOutGeo,
    fireBaseMat,
    flameGeo,
    glowGeo,
    glowTex,
    particleTex,
    emberMat,
    smokeMat,
    pileFullGeo: makePileGeo(bark, cut, true),
    pileEmptyGeo: makePileGeo(bark, cut, false),
    pileMat,
    pileEmptyMat,
  };
  return shared;
}

/**
 * Mash'al (TorchRenderer) uchun umumiy alanga geometriyasi va shu shader bilan yangi alanga materiali —
 * gulxan alangasi bilan bir xil ko'rinish (lipillash vertex shaderda, uniformlar: uTime/uHeight/uSway/uIntensity).
 */
export function getSharedFlameGeo(): THREE.BufferGeometry {
  return getShared().flameGeo;
}
export function getSharedGlowTexture(): THREE.Texture {
  return getShared().glowTex;
}
export function createFlameMaterial(sway = 0.16): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uHeight: { value: 1 },
      uSway: { value: sway },
      uIntensity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
}

// ---------------- Gulxan / g'aram instansiyalari ----------------

interface FireInst {
  snap: CampfireSnap;
  /** Snapshot kelgan vaqt (s) — o'tinni ekstrapolyatsiya qilish uchun. */
  snapAt: number;
  root: THREE.Group;
  base: THREE.Mesh;
  flame: THREE.Mesh;
  flameMat: THREE.ShaderMaterial;
  glow: THREE.Mesh;
  glowMat: THREE.MeshBasicMaterial;
  particles: THREE.Points;
  particleGeo: THREE.BufferGeometry;
  /** Har zarra: [faza, tezlik, radius] */
  particleMeta: Float32Array;
  light: THREE.PointLight;
  seed: number;
}

interface PileInst {
  snap: WoodPileSnap;
  mesh: THREE.Mesh;
  /** Ustidagi 🪵 belgisi — uzoqdan ko'rinib, g'aramni topishni osonlashtiradi. */
  beacon: THREE.Sprite;
}

let beaconTexture: THREE.CanvasTexture | null = null;
/** 🪵 belgisi: qorong'i dumaloq fon ustida emoji (canvas → sprite teksturasi, bir marta). */
function getBeaconTexture(): THREE.CanvasTexture {
  if (beaconTexture) return beaconTexture;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  g.fillStyle = 'rgba(20, 12, 6, 0.78)';
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = '#ffb020';
  g.stroke();
  g.font = '72px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('🪵', size / 2, size / 2 + 4);
  beaconTexture = new THREE.CanvasTexture(c);
  beaconTexture.colorSpace = THREE.SRGBColorSpace;
  return beaconTexture;
}

export class CampRenderer {
  readonly root = new THREE.Group();
  private fires = new Map<string, FireInst>();
  private piles = new Map<string, PileInst>();
  private lightPool: THREE.PointLight[] = [];
  private built = false;
  /** Jonli tun holati kelmayapti (raund yakuni: snapshot'da night null) — o'tin ekstrapolyatsiyasi to'xtatilgan. */
  private fuelFrozen = false;
  private time = 0;
  private readonly assets: SharedCampAssets;

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'night_camp';
    this.assets = getShared();
    scene.add(this.root);
    // Yorug'lik tugunlari oldindan — material qayta kompilyatsiyasi o'yin boshida (prewarm) bo'lsin
    for (let i = 0; i < NIGHT_CAMPFIRE_COUNT; i++) this.makeLight();
  }

  private makeLight(): THREE.PointLight {
    const l = new THREE.PointLight(FIRE_LIGHT_COLOR, 0, FIRE_LIGHT_DISTANCE, FIRE_LIGHT_DECAY);
    l.position.set(0, -500, 0);
    this.root.add(l);
    this.lightPool.push(l);
    return l;
  }

  /** Snapshot: birinchi marta modellarni quradi, keyin faqat holatni yangilaydi. */
  sync(fires: readonly CampfireSnap[], piles: readonly WoodPileSnap[], nowSec: number): void {
    const fireIds = new Set(fires.map((f) => f.id));
    const pileIds = new Set(piles.map((p) => p.id));
    // Yo'qolganlar (yangi raundda joylar o'zgarishi mumkin)
    for (const [id, f] of this.fires) {
      if (!fireIds.has(id)) this.removeFire(id, f);
    }
    for (const [id, p] of this.piles) {
      if (!pileIds.has(id)) this.removePile(id, p);
    }
    for (const f of fires) {
      let inst = this.fires.get(f.id);
      if (!inst) {
        inst = this.createFire(f);
        this.fires.set(f.id, inst);
      } else if (Math.hypot(inst.snap.x - f.x, inst.snap.z - f.z) > 0.01) {
        inst.root.position.set(f.x, f.y, f.z);
      }
      const wasLit = inst.snap.lit;
      inst.snap = f;
      inst.snapAt = nowSec;
      if (wasLit !== f.lit) this.applyLitState(inst);
    }
    for (const p of piles) {
      let inst = this.piles.get(p.id);
      if (!inst) {
        inst = this.createPile(p);
        this.piles.set(p.id, inst);
      }
      const changed = inst.snap.available !== p.available;
      inst.snap = p;
      if (changed) this.applyPileState(inst);
    }
    this.built = true;
    this.fuelFrozen = false;
  }

  /**
   * Server tun holatini yubormay qo'ydi (raund yakuni / natijalar ekrani): joriy ekstrapolyatsiya qilingan o'tin
   * qotiriladi — aks holda gulxanlar natijalar ekranida "yonib tugab" o'chib qoladi. Keyingi sync() davom ettiradi.
   */
  freezeFuel(nowSec: number): void {
    if (this.fuelFrozen) return;
    for (const f of this.fires.values()) {
      f.snap = { ...f.snap, fuelSec: this.fuelAt(f, nowSec) };
      f.snapAt = nowSec;
    }
    this.fuelFrozen = true;
  }

  /** Gulxan hodisasi (server broadcast) — snapshotni kutmasdan darhol aks ettiramiz. */
  applyFireEvent(fireId: string, fuelSec: number, lit: boolean, nowSec: number): void {
    const inst = this.fires.get(fireId);
    if (!inst) return;
    const wasLit = inst.snap.lit;
    inst.snap = { ...inst.snap, fuelSec, lit };
    inst.snapAt = nowSec;
    if (wasLit !== lit) this.applyLitState(inst);
  }

  hasCamp(): boolean {
    return this.built && this.fires.size > 0;
  }

  /** Ekstrapolyatsiya qilingan qolgan o'tin (s): yonayotgan gulxanda sekundiga 1 kamayadi (freezeFuel da — yo'q). */
  fuelAt(inst: { snap: CampfireSnap; snapAt: number }, nowSec: number): number {
    if (!inst.snap.lit) return 0;
    if (this.fuelFrozen) return Math.max(0, inst.snap.fuelSec);
    return Math.max(0, inst.snap.fuelSec - Math.max(0, nowSec - inst.snapAt));
  }

  /** HUD/ovoz/minimap uchun gulxanlar ko'rinishi. */
  getFires(nowSec: number): CampFireView[] {
    const out: CampFireView[] = [];
    for (const f of this.fires.values()) {
      const fuel = this.fuelAt(f, nowSec);
      out.push({
        id: f.snap.id,
        x: f.snap.x,
        y: f.snap.y,
        z: f.snap.z,
        lit: f.snap.lit && fuel > 0,
        main: f.snap.main,
        fuelSec: fuel,
        maxFuelSec: f.snap.maxFuelSec,
        flame: flameScaleForFuel(fuel, f.snap.maxFuelSec),
      });
    }
    return out;
  }

  getMainFire(nowSec: number): CampFireView | null {
    for (const f of this.getFires(nowSec)) if (f.main) return f;
    return null;
  }

  getPiles(): CampPileView[] {
    const out: CampPileView[] = [];
    for (const p of this.piles.values()) {
      out.push({
        id: p.snap.id,
        x: p.snap.x,
        y: p.snap.y,
        z: p.snap.z,
        available: p.snap.available,
        respawnInSec: p.snap.respawnInSec ?? 0,
      });
    }
    return out;
  }

  private createFire(f: CampfireSnap): FireInst {
    const A = this.assets;
    const root = new THREE.Group();
    root.name = `campfire_${f.id}`;
    root.position.set(f.x, f.y, f.z);
    const seed = Math.random() * 100;
    root.rotation.y = seed;

    const base = new THREE.Mesh(A.fireBaseLitGeo, A.fireBaseMat);
    base.castShadow = false;
    base.receiveShadow = true;
    root.add(base);

    const flameMat = new THREE.ShaderMaterial({
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uHeight: { value: 1 },
        uSway: { value: 0.16 },
        uIntensity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const flame = new THREE.Mesh(A.flameGeo, flameMat);
    flame.position.y = 0.16;
    flame.renderOrder = 12;
    flame.frustumCulled = false;
    root.add(flame);

    const glowMat = new THREE.MeshBasicMaterial({
      map: A.glowTex,
      color: '#ff9a3c',
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const glow = new THREE.Mesh(A.glowGeo, glowMat);
    glow.position.y = 0.05;
    glow.scale.setScalar(2.6);
    glow.renderOrder = 11;
    root.add(glow);

    const particleGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(EMBER_COUNT * 3);
    const meta = new Float32Array(EMBER_COUNT * 3);
    for (let i = 0; i < EMBER_COUNT; i++) {
      meta[i * 3] = Math.random() * Math.PI * 2;
      meta[i * 3 + 1] = 0.6 + Math.random() * 0.9;
      meta[i * 3 + 2] = 0.05 + Math.random() * 0.22;
      pos[i * 3 + 1] = Math.random() * 1.8;
    }
    particleGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const particles = new THREE.Points(particleGeo, A.emberMat);
    particles.frustumCulled = false;
    particles.renderOrder = 13;
    root.add(particles);

    const light = this.lightPool.find((l) => !l.userData.fireId) ?? this.makeLight();
    light.userData.fireId = f.id;
    light.position.set(0, FIRE_LIGHT_HEIGHT, 0);
    root.add(light);

    this.root.add(root);
    const inst: FireInst = {
      snap: f,
      snapAt: 0,
      root,
      base,
      flame,
      flameMat,
      glow,
      glowMat,
      particles,
      particleGeo,
      particleMeta: meta,
      light,
      seed,
    };
    this.applyLitState(inst);
    return inst;
  }

  private applyLitState(inst: FireInst): void {
    const A = this.assets;
    const lit = inst.snap.lit;
    inst.base.geometry = lit ? A.fireBaseLitGeo : A.fireBaseOutGeo;
    inst.flame.visible = lit;
    inst.glow.visible = lit;
    inst.particles.material = lit ? A.emberMat : A.smokeMat;
    inst.particleGeo.setDrawRange(0, lit ? EMBER_COUNT : SMOKE_COUNT);
    if (!lit) inst.light.intensity = 0;
  }

  private removeFire(id: string, inst: FireInst): void {
    this.root.remove(inst.root);
    inst.light.userData.fireId = undefined;
    inst.light.intensity = 0;
    inst.light.position.set(0, -500, 0);
    this.root.add(inst.light);
    inst.flameMat.dispose();
    inst.glowMat.dispose();
    inst.particleGeo.dispose();
    this.fires.delete(id);
  }

  private createPile(p: WoodPileSnap): PileInst {
    const A = this.assets;
    const mesh = new THREE.Mesh(A.pileFullGeo, A.pileMat);
    mesh.name = `woodpile_${p.id}`;
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    // Belgi: har g'aram uchun alohida material (masofaga qarab shaffofligi o'zgaradi), tumandan ta'sirlanmaydi
    const beaconMat = new THREE.SpriteMaterial({ map: getBeaconTexture(), transparent: true, depthWrite: false, fog: false });
    const beacon = new THREE.Sprite(beaconMat);
    beacon.name = `woodpile_beacon_${p.id}`;
    beacon.position.set(p.x, p.y + 1.7, p.z);
    beacon.scale.setScalar(0.85);
    beacon.renderOrder = 5;
    this.root.add(beacon);
    const inst: PileInst = { snap: p, mesh, beacon };
    this.applyPileState(inst);
    return inst;
  }

  /** Eng yaqin olish mumkin bo'lgan g'aramgacha masofa (m), yo'q bo'lsa null. */
  nearestAvailablePileDist(x: number, z: number): number | null {
    let best: number | null = null;
    for (const p of this.piles.values()) {
      if (!p.snap.available) continue;
      const d = Math.hypot(p.snap.x - x, p.snap.z - z);
      if (best === null || d < best) best = d;
    }
    return best;
  }

  private applyPileState(inst: PileInst): void {
    const A = this.assets;
    const ok = inst.snap.available;
    inst.mesh.geometry = ok ? A.pileFullGeo : A.pileEmptyGeo;
    inst.mesh.material = ok ? A.pileMat : A.pileEmptyMat;
  }

  private removePile(id: string, inst: PileInst): void {
    this.root.remove(inst.mesh);
    this.root.remove(inst.beacon);
    inst.beacon.material.dispose();
    this.piles.delete(id);
  }

  /** Har kadr: olov lipillashi, yorug'lik titrashi, uchqunlar/tutun. */
  update(dt: number, nowSec: number, camPos: THREE.Vector3): void {
    if (!this.built) return;
    this.time += dt;
    const t = this.time;
    // G'aram belgilari: faqat olish mumkin bo'lganlarda, 45 m gacha, uzoqlashgan sari xiralashadi va kattalashadi
    for (const p of this.piles.values()) {
      const dist = Math.hypot(p.snap.x - camPos.x, p.snap.z - camPos.z);
      const show = p.snap.available && dist < WOOD_PILE_BEACON_RANGE_M && dist > 2.5;
      p.beacon.visible = show;
      if (show) {
        const k = 1 - dist / WOOD_PILE_BEACON_RANGE_M;
        p.beacon.material.opacity = 0.35 + 0.65 * k;
        p.beacon.scale.setScalar(0.85 + dist * 0.02);
        p.beacon.position.y = p.snap.y + 1.7 + Math.sin(t * 2 + p.snap.x) * 0.06;
      }
    }
    for (const f of this.fires.values()) {
      const dist = Math.hypot(f.snap.x - camPos.x, f.snap.z - camPos.z);
      const fuel = this.fuelAt(f, nowSec);
      const lit = f.snap.lit && fuel > 0;
      if (lit !== f.flame.visible) {
        // O'tin tugadi (snapshot kelmasidan oldin) — o'chgan ko'rinishga o'tamiz
        f.snap = { ...f.snap, lit, fuelSec: fuel };
        this.applyLitState(f);
      }
      if (lit) {
        const h = flameScaleForFuel(fuel, f.snap.maxFuelSec);
        const low = fuel < CAMPFIRE_LOW_FUEL_SEC;
        // Kam o'tin: sekin, kuchsizroq pulsatsiya
        const pulse = low ? 0.72 + 0.2 * Math.sin(t * 2.6 + f.seed) : 1;
        const flick = 0.9 + 0.1 * (Math.sin(t * 11.3 + f.seed) * 0.6 + Math.sin(t * 17.7 + f.seed * 1.7) * 0.4);
        const u = f.flameMat.uniforms;
        u.uTime.value = t + f.seed;
        u.uHeight.value = h * pulse;
        u.uIntensity.value = (0.85 + 0.15 * flick) * (low ? 0.8 : 1);
        u.uSway.value = 0.12 + 0.08 * h;
        f.light.intensity = FIRE_LIGHT_INTENSITY * (0.55 + 0.45 * h) * pulse * flick;
        f.light.position.y = FIRE_LIGHT_HEIGHT * (0.8 + 0.2 * h);
        f.glowMat.opacity = 0.3 * (0.5 + 0.5 * h) * pulse * flick;
        f.glow.scale.setScalar(2.2 + 0.8 * h);
      }
      if (dist < PARTICLE_UPDATE_DIST) this.updateParticles(f, dt, lit, lit ? flameScaleForFuel(fuel, f.snap.maxFuelSec) : 0);
    }
  }

  private updateParticles(f: FireInst, dt: number, lit: boolean, h: number): void {
    const pos = f.particleGeo.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const meta = f.particleMeta;
    const n = lit ? EMBER_COUNT : SMOKE_COUNT;
    const top = lit ? 1.4 + h * 1.2 : 3.2;
    const riseMul = lit ? 1 : 0.45;
    const spread = lit ? 1 : 1.8;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const phase = meta[j];
      const speed = meta[j + 1] * riseMul;
      const r = meta[j + 2] * spread;
      let y = arr[j + 1] + speed * dt;
      if (y > top) {
        y = lit ? 0.2 + Math.random() * 0.3 : 0.3;
        meta[j] = Math.random() * Math.PI * 2;
      }
      const sw = y * 0.35;
      arr[j] = Math.cos(phase + y * 1.7) * (r + sw * 0.4);
      arr[j + 1] = y;
      arr[j + 2] = Math.sin(phase + y * 1.3) * (r + sw * 0.4);
    }
    pos.needsUpdate = true;
  }

  dispose(): void {
    for (const [id, f] of [...this.fires]) this.removeFire(id, f);
    for (const [id, p] of [...this.piles]) this.removePile(id, p);
    for (const l of this.lightPool) {
      l.dispose();
      this.root.remove(l);
    }
    this.lightPool.length = 0;
    this.scene.remove(this.root);
    // Umumiy geometriya/materiallar modul keshida qoladi (keyingi tun uchun qayta ishlatiladi)
  }
}
