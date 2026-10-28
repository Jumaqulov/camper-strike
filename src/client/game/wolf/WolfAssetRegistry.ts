import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Vahshiy bo'ri GLB (`scripts/generate-wolf-glb.mjs`): bitta skinlangan mesh (wolf_main + wolf_eyes),
 * 24 suyak, 9 klip, 4 soket. Bu registr personaj registriga o'xshash: bir marta yuklaydi, tekshiradi,
 * har bo'ri uchun SkeletonUtils.clone bilan mustaqil nusxa beradi.
 */
export const WOLF_GLB_URL = '/models/characters/feral_wolf_rigged.glb';
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

export interface WolfInstance {
  root: THREE.Object3D;
  skinnedMeshes: THREE.SkinnedMesh[];
  bones: Map<string, THREE.Bone>;
  sockets: Map<string, THREE.Object3D>;
  clips: ReadonlyMap<WolfClipName, THREE.AnimationClip>;
  dispose(): void;
}

type AssetState = 'idle' | 'loading' | 'ready' | 'failed';

let state: AssetState = 'idle';
let template: WolfAssetTemplate | null = null;
let clipMap: ReadonlyMap<WolfClipName, THREE.AnimationClip> | null = null;
let preloadPromise: Promise<void> | null = null;
let warned = false;
const readyListeners = new Set<() => void>();

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

function notifyReady(): void {
  const ls = [...readyListeners];
  readyListeners.clear();
  for (const cb of ls) {
    try {
      cb();
    } catch (e) {
      console.warn('[WolfAssetRegistry] ready listener error:', e);
    }
  }
}

function adopt(t: WolfAssetTemplate): void {
  if (t.validation.ok) {
    template = t;
    clipMap = buildClipMap(t.clips);
    state = 'ready';
    notifyReady();
  } else {
    template = null;
    clipMap = null;
    state = 'failed';
    if (!warned) {
      warned = true;
      console.warn(`[WolfAssetRegistry] '${WOLF_GLB_URL}' validation failed: ${t.validation.errors.join('; ')}`);
    }
  }
}

/** Bir martalik yuklash; xatoda 'failed' (bo'ri procedural zaxira bilan chiziladi). Node/testda no-op. */
export function preloadWolfAssets(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    preloadPromise = Promise.resolve();
    return preloadPromise;
  }
  state = 'loading';
  preloadPromise = (async () => {
    try {
      const res = await fetch(WOLF_GLB_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const tpl = await parseWolfGlb(await res.arrayBuffer());
      if (state !== 'loading') return;
      adopt(tpl);
    } catch (err) {
      if (state !== 'loading') return;
      state = 'failed';
      if (!warned) {
        warned = true;
        console.warn(`[WolfAssetRegistry] '${WOLF_GLB_URL}' yuklanmadi, procedural zaxira:`, err);
      }
    }
  })();
  return preloadPromise;
}

export function isWolfAssetReady(): boolean {
  return state === 'ready' && template !== null;
}

export function onWolfAssetReady(cb: () => void): () => void {
  if (isWolfAssetReady()) {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) cb();
    });
    return () => {
      cancelled = true;
    };
  }
  readyListeners.add(cb);
  return () => {
    readyListeners.delete(cb);
  };
}

/** Mustaqil bo'ri nusxasi (o'z suyaklari, umumiy geometriya/material/kliplar). Tayyor bo'lmasa null. */
export function instantiateWolf(): WolfInstance | null {
  const tpl = template;
  const cm = clipMap;
  if (state !== 'ready' || !tpl || !cm) return null;
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
  for (const m of skinnedMeshes) {
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
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const sk of skeletons) sk.dispose();
    },
  };
}

/** Test ilgagi: tayyor shablonni o'rnatadi yoki `null` bilan registrni tiklaydi. */
export function registerWolfTemplateForTest(t: WolfAssetTemplate | null): void {
  warned = false;
  if (!t) {
    state = 'idle';
    template = null;
    clipMap = null;
    preloadPromise = null;
    readyListeners.clear();
    return;
  }
  preloadPromise = Promise.resolve();
  adopt(t);
}
