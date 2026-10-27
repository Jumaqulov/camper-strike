import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * STAGE 08-TERRAIN-VISUAL — GLB Grass Asset Registry
 *
 * Preloads, caches, and deduplicates the 17 stylized vegetation GLB models from `/models/grass/`.
 * Ensures exactly ONE shared `THREE.MeshStandardMaterial` is used across all variants.
 * Provides procedural fallback geometry for every variant so loading failures or headless
 * environments never crash the game.
 */

import {
  getCategoryIndex,
  getVariantCategory,
  GRASS_VARIANT_HEIGHT,
  GRASS_VARIANT_IDS,
  MAX_WORLD_HEIGHT,
  type GrassCategory,
  type GrassVariantId,
} from './grassVariantData';

// Variant id/kategoriya/balandlik jadvallari `grassVariantData.ts` da (planner bilan umumiy).
// Eski nomlar moslik uchun qayta eksport qilinadi.
export {
  getCategoryIndex,
  getVariantCategory,
  GRASS_VARIANT_HEIGHT,
  GRASS_VARIANT_HEIGHT as VARIANT_BASE_HEIGHTS,
  GRASS_VARIANT_IDS,
  MAX_WORLD_HEIGHT,
  MAX_WORLD_HEIGHT as CATEGORY_HEIGHT_LIMITS,
  maxScaleForVariant as getMaxScaleForVariant,
  type GrassCategory,
  type GrassVariantId,
} from './grassVariantData';

export interface CachedGrassAsset {
  variantId: GrassVariantId;
  category: GrassCategory;
  geometry: THREE.BufferGeometry;
  triangles: number;
  baseHeight: number;
  bounds: THREE.Box3;
  isFallback: boolean;
}

// ---------------------------------------------------------------------------------------------
// Shared Material (Deduplicated single THREE.MeshStandardMaterial)
// ---------------------------------------------------------------------------------------------

let sharedVegetationMaterial: THREE.MeshStandardMaterial | null = null;

export interface GrassShaderUniforms {
  uGcTime: { value: number };
  uGcWind: { value: number };
  uGcCam: { value: THREE.Vector3 };
  uGcDistances: { value: THREE.Vector3 }; // x: grass, y: flower, z: fern
}

let sharedUniforms: GrassShaderUniforms | null = null;

export function getSharedGrassUniforms(): GrassShaderUniforms {
  if (!sharedUniforms) {
    sharedUniforms = {
      uGcTime: { value: 0 },
      uGcWind: { value: 1.0 },
      uGcCam: { value: new THREE.Vector3() },
      uGcDistances: { value: new THREE.Vector3(75, 65, 80) },
    };
  }
  return sharedUniforms;
}

/**
 * Returns the single deduplicated `MeshStandardMaterial` for all vegetation instances.
 * Installs the vertex shader hook for wind sway and distance-based fade.
 */
export function getSharedVegetationMaterial(): THREE.MeshStandardMaterial {
  if (sharedVegetationMaterial) return sharedVegetationMaterial;

  const uniforms = getSharedGrassUniforms();
  const mat = new THREE.MeshStandardMaterial({
    name: 'vegetation',
    roughness: 0.88,
    metalness: 0.0,
    vertexColors: true,
    side: THREE.FrontSide, // Both sides modeled in GLB geometry!
  });

  mat.userData.sharedAsset = true;
  mat.customProgramCacheKey = () => 'shared_vegetation_v2';

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGcTime = uniforms.uGcTime;
    shader.uniforms.uGcWind = uniforms.uGcWind;
    shader.uniforms.uGcCam = uniforms.uGcCam;
    shader.uniforms.uGcDistances = uniforms.uGcDistances;

    shader.vertexShader =
      'attribute float aCategory;\n' +
      'uniform float uGcTime;\n' +
      'uniform float uGcWind;\n' +
      'uniform vec3 uGcDistances;\n' +
      'uniform vec3 uGcCam;\n' +
      shader.vertexShader
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
// Stylized foliage upward normal bias for smooth, soft canopy lighting
objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.35));`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 gcOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#else
  vec3 gcOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#endif
  float gcH = max(position.y, 0.0);
  float gcW = sin(uGcTime * 1.5 + gcOrigin.x * 0.31 + gcOrigin.z * 0.23) * 0.65
            + sin(uGcTime * 2.6 + gcOrigin.x * 0.83 - gcOrigin.z * 0.57) * 0.25;
  transformed.x += gcW * uGcWind * gcH * 0.22;
  transformed.z += gcW * uGcWind * gcH * 0.12;

  float gcFar = (aCategory < 0.5) ? uGcDistances.x : ((aCategory < 1.5) ? uGcDistances.y : uGcDistances.z);
  float gcDist = distance(gcOrigin.xz, uGcCam.xz);
  float rawFade = clamp((gcFar - gcDist) / max(0.15 * gcFar, 0.001), 0.0, 1.0);
  float gcFade = rawFade * rawFade * (3.0 - 2.0 * rawFade);
  transformed *= gcFade;`,
        );

    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;',
      `vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  // Half-lambert wrap lighting: soften dark backfaces and retain soft foliage luminosity
  totalDiffuse = totalDiffuse * 0.7 + diffuseColor.rgb * 0.3;`,
    );
  };

  sharedVegetationMaterial = mat;
  return sharedVegetationMaterial;
}

// ---------------------------------------------------------------------------------------------
// Procedural Geometry Fallbacks
// ---------------------------------------------------------------------------------------------

class ProceduralBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];

  tri(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    ca: THREE.Color,
    cb: THREE.Color,
    cc: THREE.Color,
  ): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    let len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    // Upward bias
    nx = nx * 0.45;
    ny = ny * 0.45 + 0.55;
    nz = nz * 0.45;
    len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    // Front-facing triangle
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);

    // Modeled back-facing triangle for two-sided visibility with FrontSide material
    this.pos.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(ca.r, ca.g, ca.b, cc.r, cc.g, cc.b, cb.r, cb.g, cb.b);
  }

  blade(
    a: number,
    baseW: number,
    topW: number,
    h: number,
    lean: number,
    root: THREE.Color,
    tip: THREE.Color,
    offset = 0,
  ): void {
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const ox = -sa * offset;
    const oz = ca * offset;
    const lx = -sa * lean;
    const lz = ca * lean;
    const b0: [number, number, number] = [ox - ca * baseW * 0.5, 0, oz - sa * baseW * 0.5];
    const b1: [number, number, number] = [ox + ca * baseW * 0.5, 0, oz + sa * baseW * 0.5];
    const t0: [number, number, number] = [ox + lx - ca * topW * 0.5, h, oz + lz - sa * topW * 0.5];
    const t1: [number, number, number] = [ox + lx + ca * topW * 0.5, h, oz + lz + sa * topW * 0.5];
    this.tri(b0, b1, t1, root, root, tip);
    this.tri(b0, t1, t0, root, tip, tip);
  }

  build(category: GrassCategory): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));

    const count = this.pos.length / 3;
    const catVal = getCategoryIndex(category);
    const catAttr = new Float32Array(count).fill(catVal);
    geo.setAttribute('aCategory', new THREE.BufferAttribute(catAttr, 1));

    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    geo.userData.sharedAsset = true;
    geo.userData.isTemporaryFallback = true;
    return geo;
  }
}

const hexColor = (hex: string) => new THREE.Color(hex);

function createGrassFallbackGeometry(targetH: number, isStraw: boolean, isShade: boolean): THREE.BufferGeometry {
  const pb = new ProceduralBuilder();
  const root = isStraw ? hexColor('#4a4825') : isShade ? hexColor('#1e3818') : hexColor('#2f5323');
  const tip1 = isStraw ? hexColor('#bda45d') : isShade ? hexColor('#567838') : hexColor('#7aa043');
  const tip2 = isStraw ? hexColor('#caba6a') : isShade ? hexColor('#48682e') : hexColor('#86ab4a');

  const bladeCount = targetH > 0.4 ? 6 : 4;
  for (let i = 0; i < bladeCount; i++) {
    const ang = (i / bladeCount) * Math.PI * 2 + 0.25;
    const h = targetH * (0.85 + (i % 3) * 0.1);
    const lean = 0.04 + (i % 2) * 0.03;
    const w = targetH > 0.4 ? 0.07 : 0.06;
    pb.blade(ang, w, 0.012, h, lean, root, i % 2 === 0 ? tip1 : tip2, 0.03);
  }
  return pb.build('grass');
}

function createFlowerFallbackGeometry(petalHex: string, centerHex: string, targetH: number): THREE.BufferGeometry {
  const pb = new ProceduralBuilder();
  const stemRoot = hexColor('#2e5222');
  const stemTop = hexColor('#4d7a30');
  const leaf = hexColor('#5b8a36');
  const petal = hexColor(petalHex);
  const petalInner = hexColor(petalHex).clone().lerp(hexColor(centerHex), 0.5);
  const center = hexColor(centerHex);

  const headY = targetH * 0.84;
  pb.blade(0.4, 0.018, 0.01, headY, 0.02, stemRoot, stemTop);
  pb.tri([0, 0.02, 0], [0.08, 0.08, 0.02], [0.02, 0.09, -0.015], stemRoot, leaf, leaf);
  pb.tri([0, 0.03, 0], [-0.07, 0.1, -0.02], [-0.02, 0.11, 0.02], stemRoot, leaf, leaf);

  const tilt = 0.5;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const hx = 0.02;
  const headPt = (r: number, ang: number): [number, number, number] => {
    const px = Math.cos(ang) * r;
    const pz = Math.sin(ang) * r;
    return [hx + px, headY + 0.012 - pz * st, pz * ct];
  };
  const c0: [number, number, number] = [hx, headY + 0.018, 0];
  const R = 0.055;
  const half = 0.36;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    pb.tri(c0, headPt(R, a - half), headPt(R, a + half), center, petalInner, petal);
  }
  return pb.build('flower');
}

function createFernFallbackGeometry(targetH: number, isWide: boolean): THREE.BufferGeometry {
  const pb = new ProceduralBuilder();
  const base = hexColor('#22451c');
  const mid = hexColor('#3f7a2e');
  const tip = hexColor('#6a9e3f');

  const frondCount = isWide ? 7 : 5;
  for (let i = 0; i < frondCount; i++) {
    const a = (i / frondCount) * Math.PI * 2 + (i % 2) * 0.18;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const midR = isWide ? 0.22 : 0.17;
    const tipR = (isWide ? 0.45 : 0.36) - (i % 2) * 0.04;
    const midH = targetH * (0.75 - (i % 3) * 0.05);
    const tipH = targetH * (0.45 - (i % 2) * 0.05);
    const w = isWide ? 0.1 : 0.085;
    const b: [number, number, number] = [ca * 0.02, 0.01, sa * 0.02];
    const l: [number, number, number] = [ca * midR - sa * w, midH, sa * midR + ca * w];
    const r: [number, number, number] = [ca * midR + sa * w, midH - 0.03, sa * midR - ca * w];
    const t: [number, number, number] = [ca * tipR, tipH, sa * tipR];
    pb.tri(b, l, r, base, mid, mid);
    pb.tri(l, t, r, mid, tip, mid);
  }
  return pb.build('fern');
}

export function createProceduralFallback(variantId: GrassVariantId): THREE.BufferGeometry {
  const h = GRASS_VARIANT_HEIGHT[variantId] ?? 0.25;
  const cat = getVariantCategory(variantId);

  switch (cat) {
    case 'flower': {
      if (variantId === 'flower_yellow_01') return createFlowerFallbackGeometry('#f2c73a', '#b5651d', h);
      if (variantId === 'flower_purple_01') return createFlowerFallbackGeometry('#9a6bd1', '#f0d76a', h);
      return createFlowerFallbackGeometry('#f4f1e6', '#e8c547', h);
    }
    case 'fern': {
      return createFernFallbackGeometry(h, variantId === 'fern_wide_01');
    }
    case 'grass':
    default: {
      const isStraw = variantId === 'grass_dry_straw_01' || variantId === 'grass_olive_tuft_01';
      const isShade = variantId.includes('shade') || variantId.includes('forest') || variantId.includes('wavy');
      return createGrassFallbackGeometry(h, isStraw, isShade);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Cache & Loader
// ---------------------------------------------------------------------------------------------

export interface GrassAssetDiagnostics {
  loadedGLBCount: number;
  failedGLBCount: number;
  activeGLBVariantCount: number;
  activeFallbackVariantCount: number;
  totalVariants: number;
  isAllLoaded: boolean;
  variants: Record<GrassVariantId, { isFallback: boolean; triangles: number; baseHeight: number }>;
}

const assetCache = new Map<GrassVariantId, CachedGrassAsset>();
const loadedGLBSet = new Set<GrassVariantId>();
const failedGLBSet = new Set<GrassVariantId>();
const readyListeners = new Set<(variantId?: GrassVariantId) => void>();
let preloadPromise: Promise<void> | null = null;
let customLoaderFactory: (() => GLTFLoader) | null = null;

export function onGrassAssetsReady(listener: (variantId?: GrassVariantId) => void): () => void {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

function notifyReadyListeners(variantId?: GrassVariantId): void {
  for (const listener of readyListeners) {
    try {
      listener(variantId);
    } catch (err) {
      console.error('[GrassAssetRegistry] Error in onGrassAssetsReady listener:', err);
    }
  }
}

function countTriangles(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.round(pos.count / 3) : 0;
}

function isIdentityMatrix(m: THREE.Matrix4): boolean {
  const e = m.elements;
  return (
    e[0] === 1 && e[1] === 0 && e[2] === 0 && e[3] === 0 &&
    e[4] === 0 && e[5] === 1 && e[6] === 0 && e[7] === 0 &&
    e[8] === 0 && e[9] === 0 && e[10] === 1 && e[11] === 0 &&
    e[12] === 0 && e[13] === 0 && e[14] === 0 && e[15] === 1
  );
}

function extractGeometryFromScene(gltfScene: THREE.Group): THREE.BufferGeometry | null {
  gltfScene.updateMatrixWorld(true);
  let resultGeo: THREE.BufferGeometry | null = null;

  gltfScene.traverse((child) => {
    if (resultGeo) return;
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) {
        const cloned = mesh.geometry.clone();
        if (!isIdentityMatrix(mesh.matrixWorld)) {
          cloned.applyMatrix4(mesh.matrixWorld);
        }
        resultGeo = cloned;
      }
    }
  });

  return resultGeo;
}

function normalizeExtractedGeometry(
  geo: THREE.BufferGeometry,
  category: GrassCategory,
): THREE.BufferGeometry {
  if (!geo.getAttribute('normal')) {
    geo.computeVertexNormals();
  }

  // Ensure vertex color attribute exists
  const pos = geo.getAttribute('position');
  if (!geo.getAttribute('color')) {
    const colArray = new Float32Array(pos.count * 3);
    const defCol = category === 'flower' ? [0.9, 0.9, 0.9] : [0.45, 0.65, 0.25];
    for (let i = 0; i < pos.count; i++) {
      colArray[i * 3] = defCol[0];
      colArray[i * 3 + 1] = defCol[1];
      colArray[i * 3 + 2] = defCol[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colArray, 3));
  }

  // Attach aCategory attribute for single-material shader dispatch
  const catVal = getCategoryIndex(category);
  const catArray = new Float32Array(pos.count).fill(catVal);
  geo.setAttribute('aCategory', new THREE.BufferAttribute(catArray, 1));

  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.sharedAsset = true;
  geo.userData.isTemporaryFallback = false;
  return geo;
}

async function loadSingleVariant(
  loader: GLTFLoader,
  variantId: GrassVariantId,
): Promise<CachedGrassAsset> {
  const category = getVariantCategory(variantId);
  const baseH = GRASS_VARIANT_HEIGHT[variantId] ?? 0.25;

  try {
    if (typeof window === 'undefined' && !customLoaderFactory) {
      // In Node test runner without browser DOM/fetch or custom loader
      const fallbackGeo = createProceduralFallback(variantId);
      return {
        variantId,
        category,
        geometry: fallbackGeo,
        triangles: countTriangles(fallbackGeo),
        baseHeight: baseH,
        bounds: fallbackGeo.boundingBox ?? new THREE.Box3(),
        isFallback: true,
      };
    }

    const url = `/models/grass/${variantId}.glb`;
    const gltf = await loader.loadAsync(url);
    const extracted = extractGeometryFromScene(gltf.scene);
    if (!extracted) {
      throw new Error(`No mesh found in ${url}`);
    }

    const normalized = normalizeExtractedGeometry(extracted, category);
    return {
      variantId,
      category,
      geometry: normalized,
      triangles: countTriangles(normalized),
      baseHeight: baseH,
      bounds: normalized.boundingBox ?? new THREE.Box3(),
      isFallback: false,
    };
  } catch (err) {
    console.warn(`[GrassAssetRegistry] Failed to load GLB for ${variantId}, using fallback:`, err);
    const existing = assetCache.get(variantId);
    if (existing && existing.isFallback) {
      return existing;
    }
    const fallbackGeo = createProceduralFallback(variantId);
    return {
      variantId,
      category,
      geometry: fallbackGeo,
      triangles: countTriangles(fallbackGeo),
      baseHeight: baseH,
      bounds: fallbackGeo.boundingBox ?? new THREE.Box3(),
      isFallback: true,
    };
  }
}

/**
 * Preloads all 17 GLB grass models concurrently.
 * Cached persistently across room joins so subsequent joins are instant.
 */
export async function preloadGrassAssets(): Promise<void> {
  const allLoadedReal = GRASS_VARIANT_IDS.every(
    (id) => assetCache.get(id) && !assetCache.get(id)!.isFallback,
  );
  if (allLoadedReal) {
    return;
  }
  if (preloadPromise) {
    return preloadPromise;
  }

  preloadPromise = (async () => {
    const loader = customLoaderFactory ? customLoaderFactory() : new GLTFLoader();
    await Promise.all(
      GRASS_VARIANT_IDS.map(async (id) => {
        const existing = assetCache.get(id);
        if (existing && !existing.isFallback) return;

        const asset = await loadSingleVariant(loader, id);
        assetCache.set(asset.variantId, asset);
        if (!asset.isFallback) {
          loadedGLBSet.add(asset.variantId);
          failedGLBSet.delete(asset.variantId);
        } else {
          failedGLBSet.add(asset.variantId);
        }
        notifyReadyListeners(asset.variantId);
      }),
    );
    notifyReadyListeners(undefined);
  })().finally(() => {
    preloadPromise = null;
  });

  return preloadPromise;
}

export function isGrassAssetsLoaded(): boolean {
  return GRASS_VARIANT_IDS.every(
    (id) => assetCache.get(id) && !assetCache.get(id)!.isFallback,
  );
}

export function getGrassAssetDiagnostics(): GrassAssetDiagnostics {
  let activeGLBVariantCount = 0;
  let activeFallbackVariantCount = 0;
  const variants = {} as Record<
    GrassVariantId,
    { isFallback: boolean; triangles: number; baseHeight: number }
  >;

  for (const id of GRASS_VARIANT_IDS) {
    const cached = assetCache.get(id);
    if (cached) {
      if (cached.isFallback) {
        activeFallbackVariantCount++;
      } else {
        activeGLBVariantCount++;
      }
      variants[id] = {
        isFallback: cached.isFallback,
        triangles: cached.triangles,
        baseHeight: cached.baseHeight,
      };
    } else {
      activeFallbackVariantCount++;
      variants[id] = {
        isFallback: true,
        triangles: 0,
        baseHeight: GRASS_VARIANT_HEIGHT[id] ?? 0.25,
      };
    }
  }

  const allLoadedReal = GRASS_VARIANT_IDS.every(
    (id) => assetCache.get(id) && !assetCache.get(id)!.isFallback,
  );

  return {
    loadedGLBCount: loadedGLBSet.size,
    failedGLBCount: failedGLBSet.size,
    activeGLBVariantCount,
    activeFallbackVariantCount,
    totalVariants: GRASS_VARIANT_IDS.length,
    isAllLoaded: allLoadedReal,
    variants,
  };
}

/**
 * Retrieves a cached grass asset. If assets are not yet loaded (e.g. synchronous call),
 * instantly provides a procedural fallback asset so nothing crashes.
 */
export function getGrassAsset(variantId: GrassVariantId): CachedGrassAsset {
  const cached = assetCache.get(variantId);
  if (cached) return cached;

  // Immediate procedural fallback
  const category = getVariantCategory(variantId);
  const fallbackGeo = createProceduralFallback(variantId);
  const baseH = GRASS_VARIANT_HEIGHT[variantId] ?? 0.25;
  const asset: CachedGrassAsset = {
    variantId,
    category,
    geometry: fallbackGeo,
    triangles: countTriangles(fallbackGeo),
    baseHeight: baseH,
    bounds: fallbackGeo.boundingBox ?? new THREE.Box3(),
    isFallback: true,
  };
  assetCache.set(variantId, asset);
  return asset;
}

export function getAllGrassAssets(): Map<GrassVariantId, CachedGrassAsset> {
  // Ensure all 17 exist
  for (const id of GRASS_VARIANT_IDS) {
    if (!assetCache.has(id)) {
      getGrassAsset(id);
    }
  }
  return assetCache;
}

// ---------------------------------------------------------------------------------------------
// Testing Helpers
// ---------------------------------------------------------------------------------------------

export function setGrassLoaderFactoryForTesting(factory: (() => GLTFLoader) | null): void {
  customLoaderFactory = factory;
}

export function setGrassAssetForTesting(asset: CachedGrassAsset): void {
  assetCache.set(asset.variantId, asset);
  if (!asset.isFallback) {
    loadedGLBSet.add(asset.variantId);
    failedGLBSet.delete(asset.variantId);
  } else {
    failedGLBSet.add(asset.variantId);
  }
  notifyReadyListeners(asset.variantId);
}

export function resetGrassAssetRegistryForTesting(): void {
  assetCache.clear();
  loadedGLBSet.clear();
  failedGLBSet.clear();
  preloadPromise = null;
  readyListeners.clear();
  customLoaderFactory = null;
}
