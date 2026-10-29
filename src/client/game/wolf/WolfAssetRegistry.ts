import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { WOLF_LOD1_CELL_M, WOLF_LOD2_CELL_M, clusterDecimateSkinned, geometryTriangleCount } from './wolfLod';

/**
 * Vahshiy bo'ri GLB (`scripts/generate-wolf-glb.mjs`): bitta skinlangan mesh (wolf_main + wolf_eyes),
 * 24 suyak, 9 klip, 4 soket. Bu registr personaj registriga o'xshash: bir marta yuklaydi, tekshiradi,
 * har bo'ri uchun SkeletonUtils.clone bilan mustaqil nusxa beradi. Har rang varianti (coat) — alohida GLB
 * (bir xil mesh, rig va kliplar, boshqa vertex ranglar), shuning uchun shablon har coat uchun alohida.
 */
export const WOLF_GLB_URL = '/models/characters/feral_wolf_rigged.glb';
/** Rang variantlari: `WolfSnap.coat` indeksi bo'yicha (generator tartibi: charcoal, red, tan, black, white). */
export const WOLF_COAT_URLS = [
  WOLF_GLB_URL,
  '/models/characters/feral_wolf_red_rigged.glb',
  '/models/characters/feral_wolf_tan_rigged.glb',
  '/models/characters/feral_wolf_black_rigged.glb',
  '/models/characters/feral_wolf_white_rigged.glb',
] as const;
export const WOLF_COAT_COUNT = WOLF_COAT_URLS.length;
export const WOLF_CLIPS = ['Idle', 'Sniff', 'Alert', 'Walk', 'Run', 'Howl', 'Attack', 'Hit', 'Death'] as const;
export type WolfClipName = (typeof WOLF_CLIPS)[number];
export const WOLF_SOCKETS = ['socket_mouth', 'socket_eyes', 'socket_back', 'socket_nose'] as const;
export const WOLF_JOINT_COUNT = 24;

const INSTANCE_ROOT_NAME = 'feral_wolf_instance';
// Animatsiyalangan poza (hujumda oldinga sakrash) ±1.3 m ichida; bitta saxiy sfera frustum culling uchun.
const CULL_SPHERE_CENTER = new THREE.Vector3(0, 0.6, 0);
const CULL_SPHERE_RADIUS = 1.7;

export interface WolfValidation {
  ok: boolean;
  clips: string[];
  joints: number;
  sockets: string[];
  triangles: number;
  errors: string[];
}

export interface WolfAssetTemplate {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
  validation: WolfValidation;
}

/**
 * Bir skinlangan mesh uchun LOD geometriyalari: [LOD0 (asl), LOD1, LOD2]; `null` — shu darajada mesh chizilmaydi
 * (ko'zlar LOD2 da). Hammasi bir xil suyak tartibi/bindMatrix bilan ishlaydi — `mesh.geometry = lod` almashtiriladi.
 * Shablon (coat) uchun bir marta quriladi, nusxalar bo'lishadi.
 */
export type WolfLodGeometries = readonly [THREE.BufferGeometry, THREE.BufferGeometry, THREE.BufferGeometry | null];

export interface WolfInstance {
  root: THREE.Object3D;
  skinnedMeshes: THREE.SkinnedMesh[];
  bones: Map<string, THREE.Bone>;
  sockets: Map<string, THREE.Object3D>;
  clips: ReadonlyMap<WolfClipName, THREE.AnimationClip>;
  /** Har skinlangan mesh uchun LOD geometriyalari (shablon bilan umumiy; dispose qilinmaydi). */
  lods: ReadonlyMap<THREE.SkinnedMesh, WolfLodGeometries>;
  dispose(): void;
}

/** GLB dagi ko'z materiali nomi (LOD2 da ko'z primitivi tashlanadi). */
const WOLF_EYES_MATERIAL_NAME = 'wolf_eyes';
/** LOD0 geometriya → LOD to'plami (shablon va SkeletonUtils.clone nusxalari geometriyani bo'lishadi). */
const lodSets = new WeakMap<THREE.BufferGeometry, WolfLodGeometries>();

function isEyesMesh(m: THREE.SkinnedMesh): boolean {
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  return mats.some((mat) => mat.name === WOLF_EYES_MATERIAL_NAME);
}

/** Mesh uchun LOD to'plami (bir marta quriladi): asosiy tana — klaster dekimatsiya, ko'zlar — LOD1 asl, LOD2 yo'q. */
function buildLods(m: THREE.SkinnedMesh): WolfLodGeometries {
  const g0 = m.geometry;
  const existing = lodSets.get(g0);
  if (existing) return existing;
  let set: WolfLodGeometries;
  if (isEyesMesh(m)) {
    set = [g0, g0, null];
  } else {
    const g1 = clusterDecimateSkinned(g0, WOLF_LOD1_CELL_M).geometry;
    const g2 = clusterDecimateSkinned(g0, WOLF_LOD2_CELL_M).geometry;
    for (const g of [g1, g2]) {
      // Bir xil saxiy culling sferasi (animatsiya pozasi uchun), umumiy aktiv
      g.boundingSphere = new THREE.Sphere(CULL_SPHERE_CENTER.clone(), CULL_SPHERE_RADIUS);
      g.userData.sharedAsset = true;
    }
    set = [g0, g1, g2];
  }
  lodSets.set(g0, set);
  return set;
}

/** LOD0 geometriya uchun qurilgan LOD to'plami (testlar/diagnostika), yo'q bo'lsa null. */
export function wolfLodGeometriesFor(geo: THREE.BufferGeometry): WolfLodGeometries | null {
  return lodSets.get(geo) ?? null;
}

/** LOD to'plamining har darajadagi uchburchak soni ([lod0, lod1, lod2]). */
export function wolfLodTriangles(set: WolfLodGeometries): [number, number, number] {
  return [geometryTriangleCount(set[0]), geometryTriangleCount(set[1]), geometryTriangleCount(set[2])];
}

type AssetState = 'idle' | 'loading' | 'ready' | 'failed';

interface CoatEntry {
  url: string;
  state: AssetState;
  template: WolfAssetTemplate | null;
  clipMap: ReadonlyMap<WolfClipName, THREE.AnimationClip> | null;
  preloadPromise: Promise<void> | null;
  /** 'failed' tarmoq xatosidan (validatsiyadan emas): keyingi preload chaqiruvi yana urinadi. */
  failedOnNetwork: boolean;
  warned: boolean;
  readyListeners: Set<() => void>;
}

const coats: CoatEntry[] = WOLF_COAT_URLS.map((url) => ({
  url,
  state: 'idle',
  template: null,
  clipMap: null,
  preloadPromise: null,
  failedOnNetwork: false,
  warned: false,
  readyListeners: new Set(),
}));

/** Noma'lum / diapazondan tashqari coat → 0 (charcoal). */
function coatEntry(coat: number | undefined): CoatEntry {
  const i = Number.isInteger(coat) && coat! >= 0 && coat! < WOLF_COAT_COUNT ? coat! : 0;
  return coats[i]!;
}

function countTriangles(geo: THREE.BufferGeometry | undefined | null): number {
  if (!geo) return 0;
  const idx = geo.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.round(pos.count / 3) : 0;
}

function collectSkinned(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh);
  });
  return out;
}

export function validateWolfTemplate(scene: THREE.Object3D, clips: readonly THREE.AnimationClip[]): WolfValidation {
  const errors: string[] = [];
  const clipNames = clips.map((c) => c.name);
  for (const n of WOLF_CLIPS) if (!clipNames.includes(n)) errors.push(`missing clip '${n}'`);
  const skinned = collectSkinned(scene);
  if (skinned.length === 0) errors.push('no skinned mesh');
  let triangles = 0;
  const joints = new Set<string>();
  for (const m of skinned) {
    triangles += countTriangles(m.geometry);
    for (const b of m.skeleton?.bones ?? []) joints.add(b.name);
  }
  if (joints.size !== WOLF_JOINT_COUNT) errors.push(`expected ${WOLF_JOINT_COUNT} joints, got ${joints.size}`);
  for (const j of ['Root', 'Hips', 'Chest', 'Head', 'Jaw']) if (!joints.has(j)) errors.push(`missing joint '${j}'`);
  const sockets: string[] = [];
  for (const s of WOLF_SOCKETS) {
    if (scene.getObjectByName(s)) sockets.push(s);
    else errors.push(`missing socket '${s}'`);
  }
  return { ok: errors.length === 0, clips: clipNames, joints: joints.size, sockets, triangles, errors };
}

function prepareTemplate(scene: THREE.Object3D): void {
  scene.traverse((o) => {
    o.userData.sharedAsset = true;
    if (!(o as THREE.SkinnedMesh).isSkinnedMesh) return;
    const m = o as THREE.SkinnedMesh;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = true;
    m.geometry.boundingSphere = new THREE.Sphere(CULL_SPHERE_CENTER.clone(), CULL_SPHERE_RADIUS);
    m.boundingSphere = new THREE.Sphere(CULL_SPHERE_CENTER.clone(), CULL_SPHERE_RADIUS);
    m.geometry.userData.sharedAsset = true;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      mat.userData.sharedAsset = true;
      // Vertex ranglar GLB da; ko'z materiali emissive (qorong'ida yonadi)
      if (mat instanceof THREE.MeshStandardMaterial) mat.vertexColors = true;
    }
    // LOD geometriyalari (coat shabloni uchun bir marta, ~5 ms): nusxalar bo'lishadi
    buildLods(m);
  });
}

export async function parseWolfGlb(data: ArrayBuffer): Promise<WolfAssetTemplate> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(data, '');
  const scene = gltf.scene;
  const clips = gltf.animations ?? [];
  prepareTemplate(scene);
  scene.updateMatrixWorld(true);
  return { scene, clips, validation: validateWolfTemplate(scene, clips) };
}

function buildClipMap(clips: readonly THREE.AnimationClip[]): ReadonlyMap<WolfClipName, THREE.AnimationClip> {
  const m = new Map<WolfClipName, THREE.AnimationClip>();
  for (const n of WOLF_CLIPS) {
    const c = clips.find((x) => x.name === n);
    if (c) m.set(n, c);
  }
  return m;
}

function notifyReady(e: CoatEntry): void {
  const ls = [...e.readyListeners];
  e.readyListeners.clear();
  for (const cb of ls) {
    try {
      cb();
    } catch (e) {
      console.warn('[WolfAssetRegistry] ready listener error:', e);
    }
  }
}

function adopt(e: CoatEntry, t: WolfAssetTemplate): void {
  if (t.validation.ok) {
    e.template = t;
    e.clipMap = buildClipMap(t.clips);
    e.state = 'ready';
    notifyReady(e);
  } else {
    e.template = null;
    e.clipMap = null;
    e.state = 'failed';
    if (!e.warned) {
      e.warned = true;
      console.warn(`[WolfAssetRegistry] '${e.url}' validation failed: ${t.validation.errors.join('; ')}`);
    }
  }
}

function preloadCoat(e: CoatEntry): Promise<void> {
  if (e.preloadPromise) return e.preloadPromise;
  if (e.state === 'ready' || (e.state === 'failed' && !e.failedOnNetwork)) {
    e.preloadPromise = Promise.resolve();
    return e.preloadPromise;
  }
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    e.preloadPromise = Promise.resolve();
    return e.preloadPromise;
  }
  e.state = 'loading';
  e.failedOnNetwork = false;
  e.preloadPromise = (async () => {
    // Tarmoq xatosida (server qayta ishga tushayotganda) bir necha marta qayta urinamiz
    const delays = [1500, 4000, 10000];
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(e.url, { cache: attempt === 0 ? 'default' : 'reload' });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const tpl = await parseWolfGlb(await res.arrayBuffer());
        if (e.state !== 'loading') return;
        adopt(e, tpl);
        return;
      } catch (err) {
        if (e.state !== 'loading') return;
        if (attempt < delays.length) {
          console.warn(`[WolfAssetRegistry] '${e.url}' yuklanmadi, ${delays[attempt]! / 1000} s dan keyin qayta urinish:`, err);
          await new Promise((r) => setTimeout(r, delays[attempt]));
          if (e.state !== 'loading') return;
          continue;
        }
        // Keyingi preload chaqiruvi (yangi bo'ri / keyingi xona) yana urinadi
        e.state = 'failed';
        e.failedOnNetwork = true;
        e.preloadPromise = null;
        if (!e.warned) {
          e.warned = true;
          console.warn(`[WolfAssetRegistry] '${e.url}' yuklanmadi, procedural zaxira:`, err);
        }
        return;
      }
    }
  })();
  return e.preloadPromise;
}

/**
 * Bir martalik yuklash; xatoda 'failed' (bo'ri procedural zaxira bilan chiziladi). `coat` berilmasa —
 * barcha rang variantlari. Node/testda no-op.
 */
export function preloadWolfAssets(coat?: number): Promise<void> {
  if (coat === undefined) return Promise.all(coats.map(preloadCoat)).then(() => undefined);
  return preloadCoat(coatEntry(coat));
}

export function isWolfAssetReady(coat = 0): boolean {
  const e = coatEntry(coat);
  return e.state === 'ready' && e.template !== null;
}

export function onWolfAssetReady(cb: () => void, coat = 0): () => void {
  if (isWolfAssetReady(coat)) {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) cb();
    });
    return () => {
      cancelled = true;
    };
  }
  const e = coatEntry(coat);
  e.readyListeners.add(cb);
  return () => {
    e.readyListeners.delete(cb);
  };
}

/** Mustaqil bo'ri nusxasi (o'z suyaklari, umumiy geometriya/material/kliplar). Tayyor bo'lmasa null. */
export function instantiateWolf(coat = 0): WolfInstance | null {
  const e = coatEntry(coat);
  const tpl = e.template;
  const cm = e.clipMap;
  if (e.state !== 'ready' || !tpl || !cm) return null;
  let root: THREE.Object3D;
  try {
    root = cloneSkinned(tpl.scene);
  } catch (err) {
    console.warn('[WolfAssetRegistry] SkeletonUtils.clone failed:', err);
    return null;
  }
  root.name = INSTANCE_ROOT_NAME;
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.userData.sharedAsset = false;
  const skinnedMeshes = collectSkinned(root);
  const shared = skinnedMeshes[0]?.skeleton;
  const skeletons = new Set<THREE.Skeleton>();
  const bones = new Map<string, THREE.Bone>();
  const lods = new Map<THREE.SkinnedMesh, WolfLodGeometries>();
  for (const m of skinnedMeshes) {
    // Nusxa geometriyani shablon bilan bo'lishadi — LOD to'plami shu kalit bo'yicha
    const set = lodSets.get(m.geometry) ?? buildLods(m);
    lods.set(m, set);
    if (shared && m.skeleton !== shared) {
      const same =
        m.skeleton.bones.length === shared.bones.length && m.skeleton.bones.every((b, i) => b === shared.bones[i]);
      if (same) m.bind(shared, m.bindMatrix);
    }
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = true;
    if (!m.boundingSphere) m.boundingSphere = new THREE.Sphere(CULL_SPHERE_CENTER.clone(), CULL_SPHERE_RADIUS);
    skeletons.add(m.skeleton);
    for (const b of m.skeleton.bones) bones.set(b.name, b);
  }
  const sockets = new Map<string, THREE.Object3D>();
  for (const s of WOLF_SOCKETS) {
    const n = root.getObjectByName(s);
    if (n) sockets.set(s, n);
  }
  let disposed = false;
  return {
    root,
    skinnedMeshes,
    bones,
    sockets,
    clips: cm,
    lods,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const sk of skeletons) sk.dispose();
    },
  };
}

/**
 * Test ilgagi: tayyor shablonni o'rnatadi yoki `null` bilan registrni tiklaydi.
 * `coat` berilmasa — barcha rang variantlariga.
 */
export function registerWolfTemplateForTest(t: WolfAssetTemplate | null, coat?: number): void {
  for (const e of coat === undefined ? coats : [coatEntry(coat)]) {
    e.warned = false;
    e.failedOnNetwork = false;
    if (!t) {
      e.state = 'idle';
      e.template = null;
      e.clipMap = null;
      e.preloadPromise = null;
      e.readyListeners.clear();
      continue;
    }
    e.preloadPromise = Promise.resolve();
    adopt(e, t);
  }
}
