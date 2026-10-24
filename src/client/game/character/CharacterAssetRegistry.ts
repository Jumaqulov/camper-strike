import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

export const CAMPER_BUDDY_URL = '/models/characters/camper_buddy_balanced_rigged.glb';
export const CAMPER_BUDDY_CLIPS = ['Idle', 'Walk', 'Run', 'JumpStart', 'JumpAir', 'Land', 'Interact'] as const;
export type CamperBuddyClipName = (typeof CAMPER_BUDDY_CLIPS)[number];
export const CAMPER_BUDDY_SOCKETS = ['Hand_R_Grip', 'Hand_L_Support', 'Head_Attach', 'Back_Attach'] as const;

/** 22 joints of the single skin, in GLB authoring order (see docs/stage08b-char/CONTRACTS.md). */
export const CAMPER_BUDDY_JOINTS = [
  'Root',
  'Hips',
  'Spine',
  'Chest',
  'Neck',
  'Head',
  'Shoulder_L',
  'UpperArm_L',
  'LowerArm_L',
  'Hand_L',
  'Shoulder_R',
  'UpperArm_R',
  'LowerArm_R',
  'Hand_R',
  'UpperLeg_L',
  'LowerLeg_L',
  'Foot_L',
  'Toe_L',
  'UpperLeg_R',
  'LowerLeg_R',
  'Foot_R',
  'Toe_R',
] as const;

const MAIN_MATERIAL_NAME = 'buddy_main';
const TEAM_MATERIAL_NAME = 'buddy_team_color';
const EXPECTED_SKINNED_MESHES = 2;
const INSTANCE_ROOT_NAME = 'camper_buddy_instance';

// Animated pose bbox stays within ±0.8 m of the body axis; one generous sphere keeps frustum culling on
// without per-frame SkinnedMesh.computeBoundingSphere() (which would only ever capture the bind pose).
const CULL_SPHERE_CENTER = new THREE.Vector3(0, 0.9, 0);
const CULL_SPHERE_RADIUS = 1.3;

export interface CharacterValidation {
  ok: boolean;
  clips: string[];
  joints: number;
  sockets: string[];
  skinnedMeshes: number;
  triangles: number;
  errors: string[];
}

export interface CharacterAssetTemplate {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
  validation: CharacterValidation;
}

export interface CamperBuddyInstance {
  /** SkeletonUtils.clone of the template scene — owns its bones/skeleton. */
  root: THREE.Object3D;
  skinnedMeshes: THREE.SkinnedMesh[];
  /** Keyed by joint name (22). */
  bones: Map<string, THREE.Bone>;
  /** Keyed by socket name (4). */
  sockets: Map<string, THREE.Object3D>;
  /** Shared, immutable clips (one AnimationMixer per instance binds them to its own bones). */
  clips: ReadonlyMap<CamperBuddyClipName, THREE.AnimationClip>;
  /** Per-instance clone of `buddy_team_color` — safe to recolor. */
  teamMaterial: THREE.MeshStandardMaterial;
  /** Shared `buddy_main` — never mutate. */
  mainMaterial: THREE.Material;
  /** Disposes only per-instance resources (team material clone, skeleton bone textures). Idempotent. */
  dispose(): void;
}

type CharacterAssetState = 'idle' | 'loading' | 'ready' | 'failed';

export interface CharacterAssetDiagnostics {
  url: string;
  state: CharacterAssetState;
  error: string | null;
  validation: CharacterValidation | null;
  liveInstances: number;
  createdInstances: number;
  disposedInstances: number;
  loadMs: number | null;
}

let state: CharacterAssetState = 'idle';
let template: CharacterAssetTemplate | null = null;
let templateClipMap: ReadonlyMap<CamperBuddyClipName, THREE.AnimationClip> | null = null;
let lastError: string | null = null;
let lastValidation: CharacterValidation | null = null;
let loadMs: number | null = null;
let preloadPromise: Promise<void> | null = null;
let warnedOnce = false;
const readyListeners = new Set<() => void>();

// Bumped on every test re-register so instances from an older template don't skew the live counter
let generation = 0;
let liveInstances = 0;
let createdInstances = 0;
let disposedInstances = 0;

function countGeoTriangles(geo: THREE.BufferGeometry | undefined | null): number {
  if (!geo) return 0;
  const idx = geo.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.round(pos.count / 3) : 0;
}

function firstMaterial(mesh: THREE.Mesh): THREE.Material | undefined {
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
}

function collectSkinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) out.push(obj as THREE.SkinnedMesh);
  });
  return out;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function warnOnce(message: string, err?: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  if (err !== undefined) console.warn(message, err);
  else console.warn(message);
}

/**
 * Checks the parsed buddy against the contract: exactly the 7 clips, 22 skin joints, 4 sockets,
 * 2 SkinnedMeshes (`buddy_main` + `buddy_team_color`). Never throws — problems go into `errors`.
 */
export function validateCharacterTemplate(
  scene: THREE.Object3D,
  clips: readonly THREE.AnimationClip[],
): CharacterValidation {
  const errors: string[] = [];

  const clipNames = clips.map((c) => c.name);
  for (const name of CAMPER_BUDDY_CLIPS) {
    if (!clipNames.includes(name)) errors.push(`missing clip '${name}'`);
  }
  for (const name of clipNames) {
    if (!(CAMPER_BUDDY_CLIPS as readonly string[]).includes(name)) errors.push(`unexpected clip '${name}'`);
  }
  if (clipNames.length !== CAMPER_BUDDY_CLIPS.length) {
    errors.push(`expected ${CAMPER_BUDDY_CLIPS.length} clips, got ${clipNames.length}`);
  }

  const skinned = collectSkinnedMeshes(scene);
  if (skinned.length !== EXPECTED_SKINNED_MESHES) {
    errors.push(`expected ${EXPECTED_SKINNED_MESHES} skinned meshes, got ${skinned.length}`);
  }

  let triangles = 0;
  let hasMain = false;
  let hasTeam = false;
  const jointNames = new Set<string>();
  for (const mesh of skinned) {
    triangles += countGeoTriangles(mesh.geometry);
    const mat = firstMaterial(mesh);
    if (mat?.name === MAIN_MATERIAL_NAME) hasMain = true;
    if (mat?.name === TEAM_MATERIAL_NAME) {
      hasTeam = true;
      if (!(mat instanceof THREE.MeshStandardMaterial)) {
        errors.push(`'${TEAM_MATERIAL_NAME}' is not a MeshStandardMaterial`);
      }
    }
    for (const bone of mesh.skeleton?.bones ?? []) jointNames.add(bone.name);
  }
  if (!hasMain) errors.push(`material '${MAIN_MATERIAL_NAME}' not found on a skinned mesh`);
  if (!hasTeam) errors.push(`material '${TEAM_MATERIAL_NAME}' not found on a skinned mesh`);

  if (jointNames.size !== CAMPER_BUDDY_JOINTS.length) {
    errors.push(`expected ${CAMPER_BUDDY_JOINTS.length} joints, got ${jointNames.size}`);
  }
  for (const joint of CAMPER_BUDDY_JOINTS) {
    if (!jointNames.has(joint)) errors.push(`missing joint '${joint}'`);
  }

  const sockets: string[] = [];
  for (const socket of CAMPER_BUDDY_SOCKETS) {
    if (scene.getObjectByName(socket)) sockets.push(socket);
    else errors.push(`missing socket '${socket}'`);
  }

  return {
    ok: errors.length === 0,
    clips: clipNames,
    joints: jointNames.size,
    sockets,
    skinnedMeshes: skinned.length,
    triangles,
    errors,
  };
}

/**
 * One-time template normalisation: shared culling sphere on geometry + SkinnedMesh (the latter is what
 * Frustum.intersectsObject reads and is copied into every SkeletonUtils clone), shadows, shared-asset flags.
 */
function prepareTemplateScene(scene: THREE.Object3D): void {
  scene.traverse((obj) => {
    obj.userData.sharedAsset = true;
    if (!(obj as THREE.SkinnedMesh).isSkinnedMesh) return;
    const mesh = obj as THREE.SkinnedMesh;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.geometry.boundingSphere = new THREE.Sphere(CULL_SPHERE_CENTER.clone(), CULL_SPHERE_RADIUS);
    mesh.boundingSphere = new THREE.Sphere(CULL_SPHERE_CENTER.clone(), CULL_SPHERE_RADIUS);
    mesh.geometry.userData.sharedAsset = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m.userData.sharedAsset = true;
  });
}

/**
 * Parses the buddy GLB from memory. Works in Node/tsx too (the asset has no textures/images),
 * which is how unit tests feed the registry via `registerCharacterTemplateForTest`.
 */
export async function parseCharacterGlb(data: ArrayBuffer): Promise<CharacterAssetTemplate> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(data, '');
  const scene = gltf.scene;
  const clips = gltf.animations ?? [];
  prepareTemplateScene(scene);
  scene.updateMatrixWorld(true);
  return { scene, clips, validation: validateCharacterTemplate(scene, clips) };
}

function buildClipMap(clips: readonly THREE.AnimationClip[]): ReadonlyMap<CamperBuddyClipName, THREE.AnimationClip> {
  const map = new Map<CamperBuddyClipName, THREE.AnimationClip>();
  for (const name of CAMPER_BUDDY_CLIPS) {
    const clip = clips.find((c) => c.name === name);
    if (clip) map.set(name, clip);
  }
  return map;
}

function notifyReadyListeners(): void {
  const listeners = [...readyListeners];
  readyListeners.clear();
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      console.warn('[CharacterAssetRegistry] ready listener error:', e);
    }
  }
}

function adoptTemplate(t: CharacterAssetTemplate): void {
  lastValidation = t.validation;
  if (t.validation.ok) {
    template = t;
    templateClipMap = buildClipMap(t.clips);
    state = 'ready';
    lastError = null;
    notifyReadyListeners();
  } else {
    template = null;
    templateClipMap = null;
    state = 'failed';
    lastError = `validation failed: ${t.validation.errors.join('; ')}`;
    warnOnce(`[CharacterAssetRegistry] '${CAMPER_BUDDY_URL}' ${lastError} — procedural Stickman fallback`);
  }
}

/**
 * Singleton loader for the Camper Buddy GLB: fetches + parses once, validates, and notifies listeners.
 * Never rejects; on any failure the state becomes 'failed' and callers keep the procedural Stickman.
 * In Node/test (no `window`/`fetch`) it is a no-op — tests register a parsed template directly.
 */
export function preloadCharacterAssets(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  if (state === 'ready' || state === 'failed') {
    preloadPromise = Promise.resolve();
    return preloadPromise;
  }
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    preloadPromise = Promise.resolve();
    return preloadPromise;
  }

  state = 'loading';
  const t0 = nowMs();
  preloadPromise = (async () => {
    try {
      const res = await fetch(CAMPER_BUDDY_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = await res.arrayBuffer();
      const tpl = await parseCharacterGlb(buf);
      // A test/dev re-register while we were in flight wins
      if (state !== 'loading') return;
      loadMs = Math.round(nowMs() - t0);
      adoptTemplate(tpl);
    } catch (err) {
      if (state !== 'loading') return;
      loadMs = Math.round(nowMs() - t0);
      state = 'failed';
      lastError = err instanceof Error ? err.message : String(err);
      warnOnce(`[CharacterAssetRegistry] '${CAMPER_BUDDY_URL}' yuklanmadi, procedural Stickman fallback:`, err);
    }
  })();
  return preloadPromise;
}

export function isCharacterAssetReady(): boolean {
  return state === 'ready' && template !== null;
}

export function hasCharacterAssetFailed(): boolean {
  return state === 'failed';
}

/** Fires once when the asset becomes ready (on a microtask if it already is). Never fires on failure. */
export function onCharacterAssetReady(cb: () => void): () => void {
  if (isCharacterAssetReady()) {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        cb();
      } catch (e) {
        console.warn('[CharacterAssetRegistry] ready listener error:', e);
      }
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

/**
 * Creates an independent buddy: own bones/skeleton (SkeletonUtils.clone), own team material,
 * shared geometry / `buddy_main` / clips. Returns null while loading, failed or invalid.
 */
export function instantiateCamperBuddy(): CamperBuddyInstance | null {
  const tpl = template;
  const clipMap = templateClipMap;
  if (state !== 'ready' || !tpl || !clipMap) return null;

  let root: THREE.Object3D;
  try {
    root = cloneSkinned(tpl.scene);
  } catch (err) {
    console.warn('[CharacterAssetRegistry] SkeletonUtils.clone failed:', err);
    return null;
  }
  root.name = INSTANCE_ROOT_NAME;
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.userData.sharedAsset = false;

  const skinnedMeshes = collectSkinnedMeshes(root);
  let mainMaterial: THREE.Material | null = null;
  let teamTemplateMaterial: THREE.MeshStandardMaterial | null = null;
  let teamMesh: THREE.SkinnedMesh | null = null;
  const bones = new Map<string, THREE.Bone>();
  const skeletons = new Set<THREE.Skeleton>();

  // Both primitives come from one glTF skin, but SkeletonUtils.clone gives each mesh its own Skeleton over
  // the same cloned bones — bind them to one so bone matrices / the bone texture are computed once per frame.
  const sharedSkeleton = skinnedMeshes[0]?.skeleton;
  for (const mesh of skinnedMeshes) {
    if (!sharedSkeleton || mesh.skeleton === sharedSkeleton) continue;
    const sameBones =
      mesh.skeleton.bones.length === sharedSkeleton.bones.length &&
      mesh.skeleton.bones.every((b, i) => b === sharedSkeleton.bones[i]);
    if (sameBones) mesh.bind(sharedSkeleton, mesh.bindMatrix);
  }

  for (const mesh of skinnedMeshes) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    if (!mesh.boundingSphere) {
      mesh.boundingSphere = new THREE.Sphere(CULL_SPHERE_CENTER.clone(), CULL_SPHERE_RADIUS);
    }
    const mat = firstMaterial(mesh);
    if (mat?.name === MAIN_MATERIAL_NAME) mainMaterial = mat;
    if (mat?.name === TEAM_MATERIAL_NAME && mat instanceof THREE.MeshStandardMaterial) {
      teamTemplateMaterial = mat;
      teamMesh = mesh;
    }
    skeletons.add(mesh.skeleton);
    for (const bone of mesh.skeleton.bones) bones.set(bone.name, bone);
  }

  const sockets = new Map<string, THREE.Object3D>();
  for (const name of CAMPER_BUDDY_SOCKETS) {
    const node = root.getObjectByName(name);
    if (node) sockets.set(name, node);
  }

  if (!mainMaterial || !teamTemplateMaterial || !teamMesh || sockets.size !== CAMPER_BUDDY_SOCKETS.length) {
    // Validation guarantees these; a mismatch means the template was mutated after registration
    for (const sk of skeletons) sk.dispose();
    console.warn('[CharacterAssetRegistry] instance is missing materials/sockets, using procedural fallback');
    return null;
  }

  const teamMaterial = teamTemplateMaterial.clone();
  teamMaterial.userData.sharedAsset = false;
  teamMesh.material = teamMaterial;

  const instGeneration = generation;
  createdInstances++;
  liveInstances++;
  let disposed = false;

  return {
    root,
    skinnedMeshes,
    bones,
    sockets,
    clips: clipMap,
    teamMaterial,
    mainMaterial,
    dispose() {
      if (disposed) return;
      disposed = true;
      teamMaterial.dispose();
      for (const sk of skeletons) sk.dispose();
      if (instGeneration === generation) {
        liveInstances = Math.max(0, liveInstances - 1);
        disposedInstances++;
      }
    },
  };
}

/**
 * Test hook: installs an already-parsed template (validated → 'ready', invalid → 'failed'),
 * or with `null` resets the registry to 'idle' including counters.
 */
export function registerCharacterTemplateForTest(t: CharacterAssetTemplate | null): void {
  generation++;
  liveInstances = 0;
  createdInstances = 0;
  disposedInstances = 0;
  loadMs = null;
  warnedOnce = false;
  if (!t) {
    state = 'idle';
    template = null;
    templateClipMap = null;
    lastError = null;
    lastValidation = null;
    preloadPromise = null;
    readyListeners.clear();
    return;
  }
  preloadPromise = Promise.resolve();
  adoptTemplate(t);
}

export function getCharacterAssetDiagnostics(): CharacterAssetDiagnostics {
  return {
    url: CAMPER_BUDDY_URL,
    state,
    error: lastError,
    validation: lastValidation,
    liveInstances,
    createdInstances,
    disposedInstances,
    loadMs,
  };
}
