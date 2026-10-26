import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WEAPON_SLOTS, type WeaponId } from '../../shared/weapons';

export type WeaponLodVariant = '1p' | '3p';

export const WEAPON_GLB_URLS: Record<WeaponId, string> = {
  rifle: '/models/weapons/ak47.glb',
  pistol: '/models/weapons/pistol.glb',
  shotgun: '/models/weapons/shotgun.glb',
  sniper: '/models/weapons/awp.glb',
};

interface WeaponCalibration {
  scale: number;
  offset: THREE.Vector3;
  muzzle: THREE.Vector3;
  ejectPort: THREE.Vector3;
  slidePivot: THREE.Vector3;
  magPivot: THREE.Vector3;
}

const CALIBRATION: Record<WeaponId, WeaponCalibration> = {
  rifle: {
    scale: 1.12,
    offset: new THREE.Vector3(0, 0.012, 0.02),
    muzzle: new THREE.Vector3(0, 0.068, -0.765),
    ejectPort: new THREE.Vector3(0.032, 0.082, -0.05),
    slidePivot: new THREE.Vector3(0, 0.082, -0.05),
    magPivot: new THREE.Vector3(0, 0.01, -0.14),
  },
  pistol: {
    scale: 1.55,
    offset: new THREE.Vector3(0, 0.015, -0.02),
    muzzle: new THREE.Vector3(0, 0.092, -0.252),
    ejectPort: new THREE.Vector3(0.024, 0.112, -0.066),
    slidePivot: new THREE.Vector3(0, 0.088, -0.05),
    magPivot: new THREE.Vector3(0, -0.14, 0.048),
  },
  shotgun: {
    scale: 1.14,
    offset: new THREE.Vector3(0, 0.018, -0.01),
    muzzle: new THREE.Vector3(0, 0.069, -0.774),
    ejectPort: new THREE.Vector3(0.032, 0.054, -0.066),
    slidePivot: new THREE.Vector3(0, 0.032, -0.352),
    magPivot: new THREE.Vector3(0, 0.01, -0.05),
  },
  sniper: {
    scale: 1.05,
    offset: new THREE.Vector3(0, 0.004, -0.02),
    muzzle: new THREE.Vector3(0, 0.067, -1.007),
    ejectPort: new THREE.Vector3(0.032, 0.068, -0.06),
    // Bolt rotation axis on the AWP receiver centerline
    slidePivot: new THREE.Vector3(0, 0.067, 0.017),
    magPivot: new THREE.Vector3(0, -0.02, -0.115),
  },
};

// ============== Stilizatsiyalangan o'rmon atmosferasiga mos materiallar ==============
const stylizedMaterials: Record<string, THREE.MeshStandardMaterial> = {
  metal: new THREE.MeshStandardMaterial({
    name: 'stylized_metal',
    color: '#5c6978',
    metalness: 0.38,
    roughness: 0.44,
  }),
  dark_metal: new THREE.MeshStandardMaterial({
    name: 'stylized_dark_metal',
    color: '#353e49',
    metalness: 0.32,
    roughness: 0.50,
  }),
  wood: new THREE.MeshStandardMaterial({
    name: 'stylized_wood',
    color: '#a85d28',
    metalness: 0.04,
    roughness: 0.58,
  }),
  wood_dark: new THREE.MeshStandardMaterial({
    name: 'stylized_wood_dark',
    color: '#6e3916',
    metalness: 0.04,
    roughness: 0.66,
  }),
  polymer: new THREE.MeshStandardMaterial({
    name: 'stylized_polymer',
    color: '#2a3038',
    metalness: 0.12,
    roughness: 0.68,
  }),
  rubber: new THREE.MeshStandardMaterial({
    name: 'stylized_rubber',
    color: '#1e2227',
    metalness: 0.05,
    roughness: 0.82,
  }),
  brass: new THREE.MeshStandardMaterial({
    name: 'stylized_brass',
    color: '#e2b03f',
    metalness: 0.48,
    roughness: 0.34,
  }),
  stock_green: new THREE.MeshStandardMaterial({
    name: 'stylized_stock_green',
    color: '#546e3c',
    metalness: 0.08,
    roughness: 0.56,
  }),
  lens: new THREE.MeshStandardMaterial({
    name: 'stylized_lens',
    color: '#28b8d8',
    metalness: 0.35,
    roughness: 0.16,
    emissive: '#0c5266',
    emissiveIntensity: 0.45,
  }),
  sight_dot: new THREE.MeshStandardMaterial({
    name: 'stylized_sight_dot',
    color: '#f4f7d4',
    metalness: 0.05,
    roughness: 0.28,
    emissive: '#6ee755',
    emissiveIntensity: 0.75,
  }),
};

// Barcha stilizatsiyalangan materiallar umumiy kesh: tushgan qurol/granata o'chganda dispose qilinmasin
for (const m of Object.values(stylizedMaterials)) m.userData.sharedAsset = true;

const fallbackCustomMaterials = new Map<string, THREE.MeshStandardMaterial>();

function resolveStylizedMaterial(rawMat: THREE.Material | undefined): THREE.MeshStandardMaterial {
  const rawName = (rawMat?.name || '').trim().toLowerCase();
  if (rawName && stylizedMaterials[rawName]) {
    return stylizedMaterials[rawName];
  }
  const cacheKey = rawName || 'default_fallback';
  const existing = fallbackCustomMaterials.get(cacheKey);
  if (existing) return existing;

  const std = rawMat instanceof THREE.MeshStandardMaterial ? rawMat : null;
  const baseColor = std ? std.color.clone() : new THREE.Color('#4c5663');
  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);
  if (hsl.l < 0.18) baseColor.setHSL(hsl.h, Math.min(0.6, hsl.s), 0.24);

  const created = new THREE.MeshStandardMaterial({
    name: `stylized_${cacheKey}`,
    color: baseColor,
    metalness: std ? Math.min(0.42, std.metalness * 0.55) : 0.25,
    roughness: std ? THREE.MathUtils.clamp(std.roughness, 0.38, 0.82) : 0.55,
  });
  created.userData.sharedAsset = true;
  fallbackCustomMaterials.set(cacheKey, created);
  return created;
}

type PartBucket = 'static' | 'slide' | 'mag';

function normalizeNodeToken(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.\d+$/, '')
    .replace(/_\d+$/, '');
}

function collectLineageTokens(obj: THREE.Object3D): string[] {
  const tokens: string[] = [];
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (cur.name) tokens.push(normalizeNodeToken(cur.name));
    cur = cur.parent;
  }
  return tokens;
}

function classifyMeshPart(weapon: WeaponId, mesh: THREE.Mesh): PartBucket {
  const tokens = collectLineageTokens(mesh);
  const has = (names: string[]) => tokens.some((t) => names.includes(t));

  switch (weapon) {
    case 'pistol':
      if (
        has([
          'slide',
          'ejection_port',
          'serration_rear',
          'serration_front',
          'front_sight',
          'rear_sight',
          'sight_dot',
        ])
      ) {
        return 'slide';
      }
      if (has(['magazine', 'mag', 'mag_base'])) return 'mag';
      return 'static';

    case 'shotgun':
      if (has(['pump', 'pump_ring', 'action_bar', 'forend'])) return 'slide';
      return 'static';

    case 'rifle':
      if (has(['magazine', 'mag', 'mag_floorplate', 'mag_base'])) return 'mag';
      if (has(['slide', 'bolt', 'bolt_carrier', 'charging_handle'])) return 'slide';
      return 'static';

    case 'sniper':
      if (has(['bolt_handle', 'bolt_knob', 'bolt_shroud', 'bolt'])) return 'slide';
      if (has(['magazine', 'mag', 'mag_base', 'mag_floorplate'])) return 'mag';
      return 'static';
  }
}

const MICRO_DETAIL_TOKENS = new Set([
  'rail_tooth',
  'serration_rear',
  'serration_front',
  'rivet',
  'pin',
  'handguard_groove',
  'handguard_vent',
  'forend_vent',
  'pump_ring',
  'brake_port',
  'grip_texture',
]);

function isMicroDetailMesh(mesh: THREE.Mesh): boolean {
  const tokens = collectLineageTokens(mesh);
  return tokens.some((t) => MICRO_DETAIL_TOKENS.has(t));
}

function mergeGeometriesSimple(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geometries.length === 1) return geometries[0];

  let totalVerts = 0;
  let totalIndices = 0;
  let hasUv = true;

  const prepared = geometries.map((g) => {
    const pos = g.getAttribute('position');
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) hasUv = false;
    totalVerts += pos.count;
    const idx = g.getIndex();
    totalIndices += idx ? idx.count : pos.count;
    return g;
  });

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = hasUv ? new Float32Array(totalVerts * 2) : null;
  const indices = new Uint32Array(totalIndices);

  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of prepared) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const norm = g.getAttribute('normal') as THREE.BufferAttribute;
    const uv = hasUv ? (g.getAttribute('uv') as THREE.BufferAttribute) : null;

    positions.set(pos.array as Float32Array, vertOffset * 3);
    normals.set(norm.array as Float32Array, vertOffset * 3);
    if (uvs && uv) uvs.set(uv.array as Float32Array, vertOffset * 2);

    const idx = g.getIndex();
    if (idx) {
      const arr = idx.array;
      for (let i = 0; i < idx.count; i++) {
        indices[idxOffset + i] = arr[i] + vertOffset;
      }
      idxOffset += idx.count;
    } else {
      for (let i = 0; i < pos.count; i++) {
        indices[idxOffset + i] = vertOffset + i;
      }
      idxOffset += pos.count;
    }

    vertOffset += pos.count;
    g.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (uvs) merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  // Keshdagi umumiy geometriya: tushgan qurol/granata o'chganda dispose qilinmasligi kerak
  merged.userData.sharedAsset = true;
  return merged;
}

export interface MergedMeshSlice {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

export interface CachedWeaponTemplate {
  weapon: WeaponId;
  muzzle: THREE.Vector3;
  ejectPort: THREE.Vector3;
  slidePivot: THREE.Vector3;
  magPivot: THREE.Vector3;
  hasSlide: boolean;
  hasMag: boolean;
  bounds1p: THREE.Box3;
  triangles1p: number;
  triangles3p: number;
  drawCalls1p: number;
  drawCalls3p: number;
  partNamesFound: { slide: string[]; mag: string[]; staticCount: number };
  lod: Record<
    WeaponLodVariant,
    {
      staticSlices: MergedMeshSlice[];
      slideSlices: MergedMeshSlice[];
      magSlices: MergedMeshSlice[];
    }
  >;
}

const templateCache = new Map<WeaponId, CachedWeaponTemplate>();
const failedWeapons = new Set<WeaponId>();
let preloadPromise: Promise<void> | null = null;
const readyListeners = new Set<() => void>();

function countTris(slices: MergedMeshSlice[]): number {
  let n = 0;
  for (const s of slices) {
    const idx = s.geometry.getIndex();
    const pos = s.geometry.getAttribute('position');
    n += idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
  }
  return Math.round(n);
}

function compileWeaponScene(weapon: WeaponId, root: THREE.Object3D): CachedWeaponTemplate {
  const cal = CALIBRATION[weapon];
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const baseTransform = new THREE.Matrix4()
    .makeTranslation(cal.offset.x, cal.offset.y, cal.offset.z)
    .multiply(new THREE.Matrix4().makeScale(cal.scale, cal.scale, cal.scale));

  const rawEntries: {
    bucket: PartBucket;
    micro: boolean;
    mat: THREE.MeshStandardMaterial;
    geo: THREE.BufferGeometry;
    name: string;
  }[] = [];

  const slideNames = new Set<string>();
  const magNames = new Set<string>();
  let staticCount = 0;

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.geometry) return;
    const bucket = classifyMeshPart(weapon, obj);
    const micro = isMicroDetailMesh(obj);
    const nameToken = normalizeNodeToken(obj.name || obj.parent?.name || 'mesh');
    if (bucket === 'slide') slideNames.add(nameToken);
    else if (bucket === 'mag') magNames.add(nameToken);
    else staticCount++;

    const rawMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const mat = resolveStylizedMaterial(rawMat);

    const relMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, obj.matrixWorld);
    const finalMatrix = new THREE.Matrix4().multiplyMatrices(baseTransform, relMatrix);

    const clonedGeo = obj.geometry.clone();
    clonedGeo.applyMatrix4(finalMatrix);

    // If the mesh belongs to slide or mag, shift its vertices into the pivot's local space
    if (bucket === 'slide') {
      clonedGeo.translate(-cal.slidePivot.x, -cal.slidePivot.y, -cal.slidePivot.z);
    } else if (bucket === 'mag') {
      clonedGeo.translate(-cal.magPivot.x, -cal.magPivot.y, -cal.magPivot.z);
    }

    rawEntries.push({ bucket, micro, mat, geo: clonedGeo, name: nameToken });
  });

  if (rawEntries.length === 0) {
    throw new Error(`GLB model '${weapon}' ichida hech qanday mesh topilmadi`);
  }

  const buildLodSlices = (variant: WeaponLodVariant) => {
    const groupMap: Record<PartBucket, Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>> = {
      static: new Map(),
      slide: new Map(),
      mag: new Map(),
    };

    for (const entry of rawEntries) {
      if (variant === '3p' && entry.micro && entry.bucket === 'static') {
        continue;
      }
      if (variant === '3p' && entry.micro && entry.bucket === 'slide' && entry.name !== 'pump' && entry.name !== 'slide') {
        continue;
      }
      const bucketMap = groupMap[entry.bucket];
      let list = bucketMap.get(entry.mat);
      if (!list) {
        list = [];
        bucketMap.set(entry.mat, list);
      }
      list.push(entry.geo.clone());
    }

    const toSlices = (m: Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>): MergedMeshSlice[] => {
      const out: MergedMeshSlice[] = [];
      for (const [material, geos] of m.entries()) {
        if (!geos.length) continue;
        out.push({
          geometry: mergeGeometriesSimple(geos),
          material,
        });
      }
      return out;
    };

    return {
      staticSlices: toSlices(groupMap.static),
      slideSlices: toSlices(groupMap.slide),
      magSlices: toSlices(groupMap.mag),
    };
  };

  const lod1p = buildLodSlices('1p');
  const lod3p = buildLodSlices('3p');

  const bounds1p = new THREE.Box3();
  for (const s of lod1p.staticSlices) {
    if (s.geometry.boundingBox) bounds1p.union(s.geometry.boundingBox);
  }
  for (const s of lod1p.slideSlices) {
    if (s.geometry.boundingBox) {
      const b = s.geometry.boundingBox.clone().translate(cal.slidePivot);
      bounds1p.union(b);
    }
  }
  for (const s of lod1p.magSlices) {
    if (s.geometry.boundingBox) {
      const b = s.geometry.boundingBox.clone().translate(cal.magPivot);
      bounds1p.union(b);
    }
  }

  for (const e of rawEntries) e.geo.dispose();

  const drawCalls1p = lod1p.staticSlices.length + lod1p.slideSlices.length + lod1p.magSlices.length;
  const drawCalls3p = lod3p.staticSlices.length + lod3p.slideSlices.length + lod3p.magSlices.length;
  const triangles1p = countTris(lod1p.staticSlices) + countTris(lod1p.slideSlices) + countTris(lod1p.magSlices);
  const triangles3p = countTris(lod3p.staticSlices) + countTris(lod3p.slideSlices) + countTris(lod3p.magSlices);

  return {
    weapon,
    muzzle: cal.muzzle.clone(),
    ejectPort: cal.ejectPort.clone(),
    slidePivot: cal.slidePivot.clone(),
    magPivot: cal.magPivot.clone(),
    hasSlide: lod1p.slideSlices.length > 0,
    hasMag: lod1p.magSlices.length > 0,
    bounds1p,
    triangles1p,
    triangles3p,
    drawCalls1p,
    drawCalls3p,
    partNamesFound: {
      slide: [...slideNames],
      mag: [...magNames],
      staticCount,
    },
    lod: {
      '1p': lod1p,
      '3p': lod3p,
    },
  };
}

/**
 * Singleton GLB weapon asset loader & cache.
 * Loads each weapon GLB once, merges static/animated sub-meshes by stylized material,
 * and notifies listeners when ready. Falls back cleanly if a GLB fails to load.
 */
export function preloadWeaponAssets(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  if (typeof window === 'undefined') {
    preloadPromise = Promise.resolve();
    return preloadPromise;
  }

  const loader = new GLTFLoader();
  preloadPromise = Promise.all(
    WEAPON_SLOTS.map(
      (weapon) =>
        new Promise<void>((resolve) => {
          if (templateCache.has(weapon)) {
            resolve();
            return;
          }
          loader.load(
            WEAPON_GLB_URLS[weapon],
            (gltf) => {
              try {
                const tpl = compileWeaponScene(weapon, gltf.scene);
                templateCache.set(weapon, tpl);
                failedWeapons.delete(weapon);
              } catch (err) {
                console.warn(`[WeaponAssetRegistry] '${weapon}' GLB tahlilida xato, procedural fallback ishlatiladi:`, err);
                failedWeapons.add(weapon);
              }
              resolve();
            },
            undefined,
            (err) => {
              console.warn(`[WeaponAssetRegistry] '${WEAPON_GLB_URLS[weapon]}' yuklanmadi, procedural fallback ishlatiladi:`, err);
              failedWeapons.add(weapon);
              resolve();
            },
          );
        }),
    ),
  ).then(() => {
    for (const cb of readyListeners) {
      try {
        cb();
      } catch (e) {
        console.warn('[WeaponAssetRegistry] listener error:', e);
      }
    }
  });

  return preloadPromise;
}

export function onWeaponAssetsReady(cb: () => void): () => void {
  if (templateCache.size === WEAPON_SLOTS.length) {
    cb();
    return () => {};
  }
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

export function getCachedWeaponTemplate(weapon: WeaponId): CachedWeaponTemplate | undefined {
  return templateCache.get(weapon);
}

export function hasWeaponAssetFailed(weapon: WeaponId): boolean {
  return failedWeapons.has(weapon);
}

/**
 * Directly compiles a parsed THREE.Object3D (useful for unit tests or custom runtime scenes)
 * and registers it in the cache.
 */
export function registerWeaponTemplateFromObject(weapon: WeaponId, sceneRoot: THREE.Object3D): CachedWeaponTemplate {
  const tpl = compileWeaponScene(weapon, sceneRoot);
  templateCache.set(weapon, tpl);
  failedWeapons.delete(weapon);
  return tpl;
}

export function getWeaponAssetDiagnostics(): Record<
  WeaponId,
  {
    loaded: boolean;
    failed: boolean;
    url: string;
    triangles1p: number;
    triangles3p: number;
    drawCalls1p: number;
    drawCalls3p: number;
    hasSlide: boolean;
    hasMag: boolean;
    slideParts: string[];
    magParts: string[];
  }
> {
  const out = {} as ReturnType<typeof getWeaponAssetDiagnostics>;
  for (const w of WEAPON_SLOTS) {
    const tpl = templateCache.get(w);
    out[w] = {
      loaded: Boolean(tpl),
      failed: failedWeapons.has(w),
      url: WEAPON_GLB_URLS[w],
      triangles1p: tpl?.triangles1p ?? 0,
      triangles3p: tpl?.triangles3p ?? 0,
      drawCalls1p: tpl?.drawCalls1p ?? 0,
      drawCalls3p: tpl?.drawCalls3p ?? 0,
      hasSlide: tpl?.hasSlide ?? false,
      hasMag: tpl?.hasMag ?? false,
      slideParts: tpl?.partNamesFound.slide ?? [],
      magParts: tpl?.partNamesFound.mag ?? [],
    };
  }
  return out;
}
