import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { TreeSpeciesBatchKey } from '../../shared/world';

export const FOREST_ASSET_IDS = [
  'pine_tree_01',
  'pine_tree_02',
  'spruce_tree_01',
  'birch_tree_01',
  'dead_tree_01',
  'forest_rock_01',
  'forest_bush_01',
] as const;

export type ForestAssetId = (typeof FOREST_ASSET_IDS)[number];

export const FOREST_GLB_URLS: Record<ForestAssetId, string> = {
  pine_tree_01: '/models/forest/pine_tree_01.glb',
  pine_tree_02: '/models/forest/pine_tree_02.glb',
  spruce_tree_01: '/models/forest/spruce_tree_01.glb',
  birch_tree_01: '/models/forest/birch_tree_01.glb',
  dead_tree_01: '/models/forest/dead_tree_01.glb',
  forest_rock_01: '/models/forest/forest_rock_01.glb',
  forest_bush_01: '/models/forest/forest_bush_01.glb',
};

/**
 * Deterministic mapping from `forestSample.ts` tree species batch keys to the 5 GLB tree models:
 * - Tall pine -> `pine_tree_01`
 * - Broad / leaning pine -> `pine_tree_02`
 * - Spruce -> `spruce_tree_01`
 * - Birch -> `birch_tree_01`
 * - Ancient/dead tree -> `dead_tree_01`
 */
export const TREE_BATCH_TO_ASSET_ID: Record<TreeSpeciesBatchKey, ForestAssetId> = {
  'tree:pine_tall': 'pine_tree_01',
  'tree:pine_leaning': 'pine_tree_02',
  'tree:spruce_broad': 'spruce_tree_01',
  'tree:birch_deciduous': 'birch_tree_01',
  'tree:tree_ancient_dead': 'dead_tree_01',
};

export const BATCH_KEY_TO_FOREST_ASSET: Record<string, ForestAssetId> = {
  ...TREE_BATCH_TO_ASSET_ID,
  'rock:boulder_mossy': 'forest_rock_01',
  'foliage:bush': 'forest_bush_01',
  // Flexible aliases
  tall_pine: 'pine_tree_01',
  broad_pine: 'pine_tree_02',
  spruce: 'spruce_tree_01',
  birch: 'birch_tree_01',
  dead_tree: 'dead_tree_01',
  rock: 'forest_rock_01',
  bush: 'forest_bush_01',
  pine_tree_01: 'pine_tree_01',
  pine_tree_02: 'pine_tree_02',
  spruce_tree_01: 'spruce_tree_01',
  birch_tree_01: 'birch_tree_01',
  dead_tree_01: 'dead_tree_01',
  forest_rock_01: 'forest_rock_01',
  forest_bush_01: 'forest_bush_01',
};

export function resolveForestAssetId(keyOrAlias: string): ForestAssetId | null {
  const normalized = keyOrAlias.trim();
  return BATCH_KEY_TO_FOREST_ASSET[normalized] ?? BATCH_KEY_TO_FOREST_ASSET[normalized.toLowerCase()] ?? null;
}

export interface CachedForestAssetTemplate {
  assetId: ForestAssetId;
  category: 'tree' | 'rock' | 'bush';
  barkGeo: THREE.BufferGeometry | null;
  foliageGeo: THREE.BufferGeometry | null;
  rockGeo: THREE.BufferGeometry | null;
  bounds: THREE.Box3;
  trunkRadius: number;
  triangles: number;
  meshNames: string[];
  hasVertexColors: boolean;
}

const assetCache = new Map<ForestAssetId, CachedForestAssetTemplate>();
const failedAssets = new Set<ForestAssetId>();
let preloadPromise: Promise<void> | null = null;
/**
 * Preload tugadi (barcha GLB lar yuklandi YOKI xato berdi). Muvaffaqiyatsiz id lar procedural
 * fallback bilan qoladi; tinglovchilar baribir chaqiriladi, aks holda keyin obuna bo'lganlar
 * hech qachon xabar olmas edi.
 */
let preloadSettled = false;
const readyListeners = new Set<() => void>();

function notifyReadyListeners(): void {
  preloadSettled = true;
  for (const cb of readyListeners) {
    try {
      cb();
    } catch (e) {
      console.warn('[ForestAssetRegistry] listener error:', e);
    }
  }
}

// Shared InstancedMesh materials (cached globally and never disposed on room change)
let sharedBarkMat: THREE.MeshStandardMaterial | null = null;
let sharedFoliageMat: THREE.MeshStandardMaterial | null = null;
let sharedRockMat: THREE.MeshStandardMaterial | null = null;

export function getSharedForestMaterials(): {
  barkMat: THREE.MeshStandardMaterial;
  foliageMat: THREE.MeshStandardMaterial;
  rockMat: THREE.MeshStandardMaterial;
} {
  if (!sharedBarkMat) {
    sharedBarkMat = new THREE.MeshStandardMaterial({
      name: 'forest_shared_bark',
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.0,
    });
    sharedBarkMat.userData.sharedAsset = true;
  }
  if (!sharedFoliageMat) {
    sharedFoliageMat = new THREE.MeshStandardMaterial({
      name: 'forest_shared_foliage',
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.0,
    });
    sharedFoliageMat.userData.sharedAsset = true;
  }
  if (!sharedRockMat) {
    sharedRockMat = new THREE.MeshStandardMaterial({
      name: 'forest_shared_rock',
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
    });
    sharedRockMat.userData.sharedAsset = true;
  }
  return {
    barkMat: sharedBarkMat,
    foliageMat: sharedFoliageMat,
    rockMat: sharedRockMat,
  };
}

function countGeoTriangles(geo: THREE.BufferGeometry | null): number {
  if (!geo) return 0;
  const idx = geo.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.round(pos.count / 3) : 0;
}

/**
 * Merges indexed or non-indexed BufferGeometries preserving position, normal, and 3-component RGB vertex colors.
 */
function mergeIndexedWithColors(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geometries.length === 1) {
    const single = geometries[0];
    single.computeBoundingBox();
    single.computeBoundingSphere();
    single.userData.sharedAsset = true;
    return single;
  }

  let totalVerts = 0;
  let totalIndices = 0;

  for (const g of geometries) {
    const pos = g.getAttribute('position');
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    totalVerts += pos.count;
    const idx = g.getIndex();
    totalIndices += idx ? idx.count : pos.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);

  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of geometries) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const norm = g.getAttribute('normal') as THREE.BufferAttribute;
    const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;

    for (let i = 0; i < pos.count; i++) {
      const dst = (vertOffset + i) * 3;
      positions[dst] = pos.getX(i);
      positions[dst + 1] = pos.getY(i);
      positions[dst + 2] = pos.getZ(i);

      normals[dst] = norm ? norm.getX(i) : 0;
      normals[dst + 1] = norm ? norm.getY(i) : 1;
      normals[dst + 2] = norm ? norm.getZ(i) : 0;

      colors[dst] = col ? col.getX(i) : 1;
      colors[dst + 1] = col ? col.getY(i) : 1;
      colors[dst + 2] = col ? col.getZ(i) : 1;
    }

    const idx = g.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        indices[idxOffset + i] = idx.getX(i) + vertOffset;
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
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.userData.sharedAsset = true;
  return merged;
}

/**
 * Calibrates geometry dimensions (such as lifting low spruce skirts for clear 3P camera sightlines
 * and normalizing rock/bush bounds to match physical colliders) and grades COLOR_0 vertex colors
 * so no tree, bush, or rock appears overly dark in shadow.
 */
function calibrateAndGradeGeometry(
  assetId: ForestAssetId,
  bucket: 'bark' | 'foliage' | 'rock',
  geo: THREE.BufferGeometry,
): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;

  // 1. Positional calibration per asset & bucket
  if (assetId === 'spruce_tree_01' && bucket === 'foliage') {
    // Raw spruce foliage starts at y=0.164m with radius 2.91m, which blocks 3P camera & eye-level view.
    // Smoothly lift lower boughs so canopy begins at y=2.05m and slightly trim bottom skirt width.
    const minY = bb.min.y;
    const maxY = bb.max.y;
    const span = Math.max(0.01, maxY - minY);
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      const t = THREE.MathUtils.clamp((vy - minY) / span, 0, 1);
      const newY = 2.05 + t * (9.15 - 2.05);
      const radialScale = 0.84 + 0.14 * t;
      pos.setXYZ(i, vx * radialScale, newY, vz * radialScale);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingBox();
  } else if (assetId === 'pine_tree_02' && bucket === 'foliage') {
    // Ensure broad pine lower boughs sit comfortably above 2.0m player eye/camera height
    const minY = bb.min.y;
    const maxY = bb.max.y;
    const span = Math.max(0.01, maxY - minY);
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      const t = THREE.MathUtils.clamp((vy - minY) / span, 0, 1);
      const newY = 2.08 + t * (maxY - 2.08);
      pos.setXYZ(i, vx * 0.94, newY, vz * 0.94);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingBox();
  } else if (assetId === 'forest_rock_01' && bucket === 'rock') {
    // Normalize rock geometry to unit collider footprint (~1.04 x 1.0 x 1.04, minY = -0.14)
    // so scaling by vis.transform.scale {x: sx, y: sy, z: sz} matches createGroundedRockCollider.
    const cx = (bb.min.x + bb.max.x) * 0.5;
    const cz = (bb.min.z + bb.max.z) * 0.5;
    const spanX = Math.max(0.01, bb.max.x - bb.min.x);
    const spanY = Math.max(0.01, bb.max.y - bb.min.y);
    const spanZ = Math.max(0.01, bb.max.z - bb.min.z);
    for (let i = 0; i < pos.count; i++) {
      const nx = ((pos.getX(i) - cx) / spanX) * 1.04;
      const ny = -0.14 + ((pos.getY(i) - bb.min.y) / spanY) * 1.14;
      const nz = ((pos.getZ(i) - cz) / spanZ) * 1.04;
      pos.setXYZ(i, nx, ny, nz);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingBox();
  } else if (assetId === 'forest_bush_01') {
    // Calibrate bush to waist-high natural woodland shrub (~1.35m wide, ~0.86m tall at scale=1)
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) * 0.64, pos.getY(i) * 0.6, pos.getZ(i) * 0.64);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingBox();
  }

  // 2. Vertex Color Grading (preserving GLB COLOR_0 variation while lifting overly dark linear colors)
  if (!geo.getAttribute('normal')) {
    geo.computeVertexNormals();
  }
  const norm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const rawCol = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
  const outColors = new Float32Array(pos.count * 3);
  const updatedBb = geo.boundingBox!;
  const minY = updatedBb.min.y;
  const spanY = Math.max(0.01, updatedBb.max.y - minY);

  const cShadow = new THREE.Color();
  const cMid = new THREE.Color();
  const cSun = new THREE.Color();
  const cTmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const vy = pos.getY(i);
    const ny = norm ? norm.getY(i) : 0.5;
    const hT = THREE.MathUtils.clamp((vy - minY) / spanY, 0, 1);

    const rr = rawCol ? rawCol.getX(i) : 0.5;
    const rg = rawCol ? rawCol.getY(i) : 0.5;
    const rb = rawCol ? rawCol.getZ(i) : 0.5;
    const rawLuma = rr * 0.299 + rg * 0.587 + rb * 0.114;

    if (bucket === 'foliage') {
      if (assetId === 'spruce_tree_01') {
        // Raw spruce COLOR_0 is (0.01..0.06, 0.04..0.19, 0.02..0.08) -> lift into rich mountain spruce green
        const detail = THREE.MathUtils.clamp((rg - 0.04) / 0.14, 0, 1);
        cShadow.setRGB(0.11, 0.25, 0.12, THREE.LinearSRGBColorSpace);
        cMid.setRGB(0.17, 0.35, 0.16, THREE.LinearSRGBColorSpace);
        cSun.setRGB(0.26, 0.47, 0.21, THREE.LinearSRGBColorSpace);
        const blend = THREE.MathUtils.clamp(hT * 0.52 + detail * 0.34 + Math.max(0, ny) * 0.14, 0, 1);
        cTmp.copy(cShadow).lerp(cMid, Math.min(1, blend * 1.5));
        if (blend > 0.5) cTmp.lerp(cSun, (blend - 0.5) * 2);
      } else if (assetId === 'pine_tree_01') {
        const detail = THREE.MathUtils.clamp((rg - 0.07) / 0.22, 0, 1);
        cShadow.setRGB(0.13, 0.27, 0.11, THREE.LinearSRGBColorSpace);
        cMid.setRGB(0.20, 0.38, 0.15, THREE.LinearSRGBColorSpace);
        cSun.setRGB(0.30, 0.50, 0.20, THREE.LinearSRGBColorSpace);
        const blend = THREE.MathUtils.clamp(hT * 0.5 + detail * 0.36 + Math.max(0, ny) * 0.14, 0, 1);
        cTmp.copy(cShadow).lerp(cMid, Math.min(1, blend * 1.5));
        if (blend > 0.5) cTmp.lerp(cSun, (blend - 0.5) * 2);
      } else if (assetId === 'pine_tree_02') {
        const detail = THREE.MathUtils.clamp((rg - 0.08) / 0.22, 0, 1);
        cShadow.setRGB(0.14, 0.28, 0.11, THREE.LinearSRGBColorSpace);
        cMid.setRGB(0.22, 0.40, 0.16, THREE.LinearSRGBColorSpace);
        cSun.setRGB(0.33, 0.52, 0.21, THREE.LinearSRGBColorSpace);
        const blend = THREE.MathUtils.clamp(hT * 0.48 + detail * 0.38 + Math.max(0, ny) * 0.14, 0, 1);
        cTmp.copy(cShadow).lerp(cMid, Math.min(1, blend * 1.5));
        if (blend > 0.5) cTmp.lerp(cSun, (blend - 0.5) * 2);
      } else if (assetId === 'birch_tree_01') {
        const detail = THREE.MathUtils.clamp((rg - 0.12) / 0.32, 0, 1);
        cShadow.setRGB(0.19, 0.32, 0.11, THREE.LinearSRGBColorSpace);
        cMid.setRGB(0.31, 0.45, 0.15, THREE.LinearSRGBColorSpace);
        cSun.setRGB(0.45, 0.58, 0.20, THREE.LinearSRGBColorSpace);
        const blend = THREE.MathUtils.clamp(hT * 0.45 + detail * 0.4 + Math.max(0, ny) * 0.15, 0, 1);
        cTmp.copy(cShadow).lerp(cMid, Math.min(1, blend * 1.5));
        if (blend > 0.5) cTmp.lerp(cSun, (blend - 0.5) * 2);
      } else if (assetId === 'dead_tree_01') {
        const detail = THREE.MathUtils.clamp((rg - 0.08) / 0.12, 0, 1);
        cShadow.setRGB(0.17, 0.25, 0.11, THREE.LinearSRGBColorSpace);
        cMid.setRGB(0.25, 0.34, 0.14, THREE.LinearSRGBColorSpace);
        cSun.setRGB(0.35, 0.42, 0.18, THREE.LinearSRGBColorSpace);
        const blend = THREE.MathUtils.clamp(hT * 0.45 + detail * 0.4 + Math.max(0, ny) * 0.15, 0, 1);
        cTmp.copy(cShadow).lerp(cMid, Math.min(1, blend * 1.5));
        if (blend > 0.5) cTmp.lerp(cSun, (blend - 0.5) * 2);
      } else {
        // forest_bush_01 foliage
        const detail = THREE.MathUtils.clamp((rg - 0.1) / 0.25, 0, 1);
        cShadow.setRGB(0.12, 0.26, 0.10, THREE.LinearSRGBColorSpace);
        cMid.setRGB(0.20, 0.37, 0.14, THREE.LinearSRGBColorSpace);
        cSun.setRGB(0.31, 0.49, 0.19, THREE.LinearSRGBColorSpace);
        const blend = THREE.MathUtils.clamp(hT * 0.48 + detail * 0.38 + Math.max(0, ny) * 0.14, 0, 1);
        cTmp.copy(cShadow).lerp(cMid, Math.min(1, blend * 1.5));
        if (blend > 0.5) cTmp.lerp(cSun, (blend - 0.5) * 2);
      }
    } else if (bucket === 'bark') {
      if (assetId === 'birch_tree_01') {
        // Preserve silver-white birch bark & dark horizontal lenticel bands from COLOR_0
        const bandT = THREE.MathUtils.clamp((rawLuma - 0.08) / 0.65, 0, 1);
        cShadow.setRGB(0.14, 0.12, 0.10, THREE.LinearSRGBColorSpace);
        cSun.setRGB(0.78, 0.74, 0.66, THREE.LinearSRGBColorSpace);
        cTmp.copy(cShadow).lerp(cSun, bandT);
      } else if (assetId === 'dead_tree_01') {
        const detail = THREE.MathUtils.clamp((rawLuma - 0.1) / 0.2, 0, 1);
        cShadow.setRGB(0.20, 0.16, 0.12, THREE.LinearSRGBColorSpace);
        cSun.setRGB(0.38, 0.31, 0.24, THREE.LinearSRGBColorSpace);
        cTmp.copy(cShadow).lerp(cSun, THREE.MathUtils.clamp(hT * 0.55 + detail * 0.45, 0, 1));
      } else {
        // Conifer & bush bark: warm cedar/redwood brown (lifted from dark raw values)
        const detail = THREE.MathUtils.clamp((rr - 0.12) / 0.2, 0, 1);
        cShadow.setRGB(0.19, 0.11, 0.06, THREE.LinearSRGBColorSpace);
        cSun.setRGB(0.36, 0.22, 0.12, THREE.LinearSRGBColorSpace);
        cTmp.copy(cShadow).lerp(cSun, THREE.MathUtils.clamp(hT * 0.5 + detail * 0.5, 0, 1));
      }
    } else {
      // bucket === 'rock' (forest_rock_01)
      // Weathered warm grey granite with soft olive woodland moss on upward-facing surfaces
      const stoneDetail = THREE.MathUtils.clamp((rawLuma - 0.11) / 0.18, 0, 1);
      cShadow.setRGB(0.22, 0.24, 0.25, THREE.LinearSRGBColorSpace);
      cMid.setRGB(0.38, 0.40, 0.41, THREE.LinearSRGBColorSpace);
      cSun.setRGB(0.18, 0.32, 0.12, THREE.LinearSRGBColorSpace); // mossy crown
      cTmp.copy(cShadow).lerp(cMid, THREE.MathUtils.clamp(stoneDetail * 0.65 + hT * 0.35, 0, 1));
      const mossWeight = THREE.MathUtils.clamp((ny - 0.28) * 1.15, 0, 0.72) * THREE.MathUtils.clamp(hT + 0.25, 0, 1);
      if (mossWeight > 0.01) {
        cTmp.lerp(cSun, mossWeight);
      }
    }

    outColors[i * 3] = cTmp.r;
    outColors[i * 3 + 1] = cTmp.g;
    outColors[i * 3 + 2] = cTmp.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(outColors, 3));
  pruneHiddenFaces(assetId, bucket, geo);
}

/**
 * Strips unseen underground bottom-cap triangles and occluded interior faces
 * inside dense multi-cluster foliage/twig meshes to reduce GPU vertex/triangle load
 * without altering the visible silhouette.
 */
function pruneHiddenFaces(
  assetId: ForestAssetId,
  bucket: 'bark' | 'foliage' | 'rock',
  geo: THREE.BufferGeometry,
): void {
  const idx = geo.getIndex();
  if (!idx) return;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const norm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const keptIndices: number[] = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (let i = 0; i < idx.count; i += 3) {
    const i0 = idx.getX(i);
    const i1 = idx.getX(i + 1);
    const i2 = idx.getX(i + 2);

    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);

    const avgY = (a.y + b.y + c.y) / 3;
    const avgNY = (norm.getY(i0) + norm.getY(i1) + norm.getY(i2)) / 3;

    // 1. Strip underground bottom caps buried beneath the terrain surface
    if (avgY < 0.02 && avgNY < -0.72) {
      continue;
    }

    // 2. For dense bush foliage, strip low downward-facing underside faces hidden against the ground
    if (assetId === 'forest_bush_01' && bucket === 'foliage' && avgY < 0.36 && avgNY < -0.42) {
      continue;
    }

    // 3. For birch & dead-tree bark, strip tiny sub-centimeter twig end-caps hidden high inside the canopy
    if ((assetId === 'birch_tree_01' || assetId === 'dead_tree_01') && bucket === 'bark' && avgY > 3.6) {
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const area2 = cross.crossVectors(ab, ac).length();
      if (area2 < 0.0055) {
        continue;
      }
    }

    // 4. For birch multi-sphere foliage clouds, strip interior faces pointing inward toward the crown core
    if (assetId === 'birch_tree_01' && bucket === 'foliage') {
      const cx = (a.x + b.x + c.x) / 3;
      const cz = (a.z + b.z + c.z) / 3;
      const radialDist = Math.hypot(cx, cz);
      if (radialDist < 0.85 && avgNY < -0.38 && avgY < 7.2) {
        continue;
      }
    }

    keptIndices.push(i0, i1, i2);
  }

  if (keptIndices.length > 0 && keptIndices.length < idx.count) {
    geo.setIndex(keptIndices);
  }
}

function classifyForestMeshBucket(assetId: ForestAssetId, mesh: THREE.Mesh): 'bark' | 'foliage' | 'rock' {
  if (assetId === 'forest_rock_01') return 'rock';
  const rawMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const matName = (rawMat?.name || '').toLowerCase();
  const meshName = (mesh.name || '').toLowerCase();
  if (matName.includes('rock') || meshName.includes('rock')) return 'rock';
  if (matName.includes('foliage') || matName.includes('leaf') || meshName.includes('foliage')) return 'foliage';
  return 'bark';
}

function compileForestAsset(assetId: ForestAssetId, root: THREE.Object3D): CachedForestAssetTemplate {
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const barkGeos: THREE.BufferGeometry[] = [];
  const foliageGeos: THREE.BufferGeometry[] = [];
  const rockGeos: THREE.BufferGeometry[] = [];
  const meshNames: string[] = [];
  let hasVertexColors = false;

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.geometry) return;
    meshNames.push(obj.name || 'mesh');
    const bucket = classifyForestMeshBucket(assetId, obj);
    const relMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, obj.matrixWorld);
    const cloned = obj.geometry.clone();
    cloned.applyMatrix4(relMatrix);

    if (cloned.getAttribute('color')) {
      hasVertexColors = true;
    }

    calibrateAndGradeGeometry(assetId, bucket, cloned);

    if (bucket === 'bark') barkGeos.push(cloned);
    else if (bucket === 'foliage') foliageGeos.push(cloned);
    else rockGeos.push(cloned);
  });

  if (barkGeos.length === 0 && foliageGeos.length === 0 && rockGeos.length === 0) {
    throw new Error(`[ForestAssetRegistry] GLB '${assetId}' ichida hech qanday mesh topilmadi`);
  }

  const barkGeo = barkGeos.length > 0 ? mergeIndexedWithColors(barkGeos) : null;
  const foliageGeo = foliageGeos.length > 0 ? mergeIndexedWithColors(foliageGeos) : null;
  const rockGeo = rockGeos.length > 0 ? mergeIndexedWithColors(rockGeos) : null;

  const bounds = new THREE.Box3();
  if (barkGeo?.boundingBox) bounds.union(barkGeo.boundingBox);
  if (foliageGeo?.boundingBox) bounds.union(foliageGeo.boundingBox);
  if (rockGeo?.boundingBox) bounds.union(rockGeo.boundingBox);

  // Measure trunk radius at player height (y in [0.2 .. 1.8m])
  let trunkRadius = 0.35;
  if (barkGeo) {
    const pos = barkGeo.getAttribute('position') as THREE.BufferAttribute;
    let maxR = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y >= 0.25 && y <= 1.8) {
        const r = Math.hypot(pos.getX(i), pos.getZ(i));
        if (r > maxR) maxR = r;
      }
    }
    if (maxR > 0.05) trunkRadius = Math.round(maxR * 1000) / 1000;
  }

  const triangles = countGeoTriangles(barkGeo) + countGeoTriangles(foliageGeo) + countGeoTriangles(rockGeo);
  const category =
    assetId === 'forest_rock_01' ? 'rock' : assetId === 'forest_bush_01' ? 'bush' : 'tree';

  return {
    assetId,
    category,
    barkGeo,
    foliageGeo,
    rockGeo,
    bounds,
    trunkRadius,
    triangles,
    meshNames,
    hasVertexColors,
  };
}

/**
 * Singleton GLB forest asset loader & cache.
 * Loads all 7 forest GLB models once, calibrates pivots/colors, and notifies listeners when ready.
 * Falls back cleanly to procedural prototypes if any GLB fails to load.
 */
export function preloadForestAssets(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  if (typeof window === 'undefined') {
    // Node/headless: yuklanadigan narsa yo'q — darhol "settled", hammasi procedural fallback.
    notifyReadyListeners();
    preloadPromise = Promise.resolve();
    return preloadPromise;
  }

  const loader = new GLTFLoader();
  preloadPromise = Promise.all(
    FOREST_ASSET_IDS.map(
      (assetId) =>
        new Promise<void>((resolve) => {
          if (assetCache.has(assetId)) {
            resolve();
            return;
          }
          loader.load(
            FOREST_GLB_URLS[assetId],
            (gltf) => {
              try {
                const tpl = compileForestAsset(assetId, gltf.scene);
                assetCache.set(assetId, tpl);
                failedAssets.delete(assetId);
              } catch (err) {
                console.warn(
                  `[ForestAssetRegistry] '${assetId}' GLB tahlilida xato, procedural fallback ishlatiladi:`,
                  err,
                );
                failedAssets.add(assetId);
              }
              resolve();
            },
            undefined,
            (err) => {
              console.warn(
                `[ForestAssetRegistry] '${FOREST_GLB_URLS[assetId]}' yuklanmadi, procedural fallback ishlatiladi:`,
                err,
              );
              failedAssets.add(assetId);
              resolve();
            },
          );
        }),
    ),
  ).then(notifyReadyListeners);

  return preloadPromise;
}

/**
 * Preload tugagach (yoki allaqachon tugagan bo'lsa darhol) chaqiriladi — yuklangan GLB lar
 * bilan; yuklanmaganlari procedural fallbackda qoladi.
 */
export function onForestAssetsReady(cb: () => void): () => void {
  if (preloadSettled) {
    cb();
    return () => {};
  }
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

/** Preload tugaganmi (hammasi yuklangan bo'lishi shart emas — xato bergan id lar fallbackda). */
export function areForestAssetsReady(): boolean {
  return preloadSettled;
}

export function getCachedForestAsset(assetId: ForestAssetId): CachedForestAssetTemplate | undefined {
  return assetCache.get(assetId);
}

export function getCachedForestAssetByBatchKey(batchKey: string): CachedForestAssetTemplate | undefined {
  const assetId = resolveForestAssetId(batchKey);
  return assetId ? assetCache.get(assetId) : undefined;
}

export function hasForestAssetFailed(assetId: ForestAssetId): boolean {
  return failedAssets.has(assetId);
}

/**
 * Directly compiles a parsed THREE.Object3D (useful for unit tests or custom runtime scenes)
 * and registers it in the cache.
 */
export function registerForestAssetFromObject(
  assetId: ForestAssetId,
  sceneRoot: THREE.Object3D,
): CachedForestAssetTemplate {
  const tpl = compileForestAsset(assetId, sceneRoot);
  assetCache.set(assetId, tpl);
  failedAssets.delete(assetId);
  return tpl;
}

export function getForestAssetDiagnostics(): Record<
  ForestAssetId,
  {
    loaded: boolean;
    failed: boolean;
    url: string;
    category: 'tree' | 'rock' | 'bush';
    triangles: number;
    trunkRadius: number;
    hasBark: boolean;
    hasFoliage: boolean;
    hasRock: boolean;
    hasVertexColors: boolean;
    meshNames: string[];
  }
> {
  const out = {} as ReturnType<typeof getForestAssetDiagnostics>;
  for (const id of FOREST_ASSET_IDS) {
    const tpl = assetCache.get(id);
    out[id] = {
      loaded: Boolean(tpl),
      failed: failedAssets.has(id),
      url: FOREST_GLB_URLS[id],
      category: tpl?.category ?? (id === 'forest_rock_01' ? 'rock' : id === 'forest_bush_01' ? 'bush' : 'tree'),
      triangles: tpl?.triangles ?? 0,
      trunkRadius: tpl?.trunkRadius ?? 0,
      hasBark: Boolean(tpl?.barkGeo),
      hasFoliage: Boolean(tpl?.foliageGeo),
      hasRock: Boolean(tpl?.rockGeo),
      hasVertexColors: tpl?.hasVertexColors ?? false,
      meshNames: tpl?.meshNames ?? [],
    };
  }
  return out;
}
