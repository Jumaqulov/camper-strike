import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  BUILDING_ASSET_IDS,
  BUILDING_GLB_URLS,
  type BuildingAssetId,
  type Stage04AMaterialName,
} from '../../../shared/structures/contracts';
import {
  deduplicateStage04AGltfMaterials,
  getStage04ASharedMaterial,
  resolveStage04AMaterialName,
} from '../Stage04ASharedMaterials';

export interface BuildingBodyMeshPart {
  name: string;
  geometry: THREE.BufferGeometry;
  materialName: Stage04AMaterialName;
  localMatrix: THREE.Matrix4;
  isCornerPost: boolean;
  isDoorMovingPart: boolean;
}

export interface CachedBuildingAssetTemplate {
  assetId: BuildingAssetId;
  templateScene: THREE.Group;
  bodyMeshes: BuildingBodyMeshPart[];
  bounds: THREE.Box3;
  triangles: number;
  hasVertexColors: boolean;
  hasDoorPivot: boolean;
  doorPivotPos: [number, number, number] | null;
  meshNames: string[];
  materialNames: Stage04AMaterialName[];
  isFallback: boolean;
}

export interface BuildingAssetDiagnosticEntry {
  assetId: BuildingAssetId;
  loaded: boolean;
  failed: boolean;
  isFallback: boolean;
  url: string;
  triangles: number;
  hasVertexColors: boolean;
  hasDoorPivot: boolean;
  doorPivotPos: [number, number, number] | null;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  size: [number, number, number];
  meshNames: string[];
  materialNames: Stage04AMaterialName[];
  bodyMeshCount: number;
}

const assetCache = new Map<BuildingAssetId, CachedBuildingAssetTemplate>();
const fallbackCache = new Map<BuildingAssetId, CachedBuildingAssetTemplate>();
const failedAssets = new Set<BuildingAssetId>();
let preloadPromise: Promise<void> | null = null;
let assetsReady = false;
const readyListeners = new Set<() => void>();

const q3 = (n: number): number => Math.round(n * 1000) / 1000;

function countGeoTriangles(geo: THREE.BufferGeometry | null | undefined): number {
  if (!geo) return 0;
  const idx = geo.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.round(pos.count / 3) : 0;
}

function defaultColorForMaterial(matName: Stage04AMaterialName): [number, number, number] {
  switch (matName) {
    case 'roof':
      return [0.26, 0.2, 0.16];
    case 'iron':
      return [0.28, 0.3, 0.32];
    case 'painted_metal':
      return [0.32, 0.38, 0.36];
    case 'fabric':
      return [0.46, 0.38, 0.32];
    case 'wood':
    default:
      return [0.54, 0.37, 0.22];
  }
}

/**
 * Ensures geometry has a 3-component Float32 `color` attribute (`COLOR_0`) so
 * `MeshStandardMaterial({ vertexColors: true })` renders cleanly across all batches.
 */
function ensureRgbVertexColors(
  geo: THREE.BufferGeometry,
  matName: Stage04AMaterialName,
): boolean {
  const pos = geo.getAttribute('position');
  if (!pos) return false;
  const existing = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (existing) {
    if (existing.itemSize === 3 && existing.array instanceof Float32Array && !existing.normalized) {
      return true;
    }
    const rgb = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      rgb[i * 3] = existing.getX(i);
      rgb[i * 3 + 1] = existing.getY(i);
      rgb[i * 3 + 2] = existing.getZ(i);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    return true;
  }

  const [cr, cg, cb] = defaultColorForMaterial(matName);
  const rgb = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const shade = 0.94 + ((i % 7) / 7) * 0.12;
    rgb[i * 3] = Math.min(1, cr * shade);
    rgb[i * 3 + 1] = Math.min(1, cg * shade);
    rgb[i * 3 + 2] = Math.min(1, cb * shade);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  return true;
}

function createColoredBoxGeometry(
  sx: number,
  sy: number,
  sz: number,
  cx: number,
  cy: number,
  cz: number,
  matName: Stage04AMaterialName,
  rotX = 0,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  if (rotX !== 0) {
    geo.rotateX(rotX);
  }
  geo.translate(cx, cy, cz);
  ensureRgbVertexColors(geo, matName);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.sharedAsset = true;
  return geo;
}

function mergeFallbackGeometries(
  geos: THREE.BufferGeometry[],
  matName: Stage04AMaterialName,
): THREE.BufferGeometry {
  if (geos.length === 1) {
    ensureRgbVertexColors(geos[0], matName);
    geos[0].computeBoundingBox();
    geos[0].computeBoundingSphere();
    geos[0].userData.sharedAsset = true;
    return geos[0];
  }

  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of geos) {
    ensureRgbVertexColors(g, matName);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position');
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

  for (const g of geos) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const norm = g.getAttribute('normal') as THREE.BufferAttribute;
    const col = g.getAttribute('color') as THREE.BufferAttribute;

    for (let i = 0; i < pos.count; i++) {
      const dst = (vertOffset + i) * 3;
      positions[dst] = pos.getX(i);
      positions[dst + 1] = pos.getY(i);
      positions[dst + 2] = pos.getZ(i);

      normals[dst] = norm.getX(i);
      normals[dst + 1] = norm.getY(i);
      normals[dst + 2] = norm.getZ(i);

      colors[dst] = col.getX(i);
      colors[dst + 1] = col.getY(i);
      colors[dst + 2] = col.getZ(i);
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
 * Builds an exact-dimension procedural fallback hierarchy matching `BUILDING-ASSET-01/README.md`
 * so tests (Node) and pre-GLB frames have valid meshes, bounds, `corner_post`, and `door_pivot`.
 */
function buildProceduralFallbackScene(assetId: BuildingAssetId): THREE.Group {
  const root = new THREE.Group();
  root.name = assetId;

  const woodMat = getStage04ASharedMaterial('wood');
  const roofMat = getStage04ASharedMaterial('roof');
  const ironMat = getStage04ASharedMaterial('iron');

  const makeCornerPostMesh = (): THREE.Mesh => {
    const geo = createColoredBoxGeometry(0.24, 3.2, 0.24, -2.0, 1.4, 0, 'wood');
    const mesh = new THREE.Mesh(geo, woodMat);
    mesh.name = 'corner_post';
    return mesh;
  };

  switch (assetId) {
    case 'wood_wall_01': {
      // Bounds: x[-2.12, 2.00] y[-0.20, 3.00] z[-0.12, 0.12]
      const bodyGeo = createColoredBoxGeometry(4.0, 3.2, 0.2, 0, 1.4, 0, 'wood');
      const bodyMesh = new THREE.Mesh(bodyGeo, woodMat);
      bodyMesh.name = 'wood_wall_01_body';
      root.add(bodyMesh, makeCornerPostMesh());
      break;
    }

    case 'wood_wall_window_01': {
      // Bounds: x[-2.12, 2.00] y[-0.20, 3.00] z[-0.13, 0.23]
      // Window opening: x[-0.6, 0.6], y[1.0, 2.0]
      const bodyParts = [
        createColoredBoxGeometry(1.4, 3.2, 0.2, -1.3, 1.4, 0, 'wood'),
        createColoredBoxGeometry(1.4, 3.2, 0.2, 1.3, 1.4, 0, 'wood'),
        createColoredBoxGeometry(1.2, 1.2, 0.2, 0, 0.4, 0, 'wood'),
        createColoredBoxGeometry(1.2, 1.0, 0.2, 0, 2.5, 0, 'wood'),
        createColoredBoxGeometry(1.36, 0.08, 0.36, 0, 0.98, 0.05, 'wood'),
      ];
      const bodyMesh = new THREE.Mesh(mergeFallbackGeometries(bodyParts, 'wood'), woodMat);
      bodyMesh.name = 'wood_wall_window_01_body';

      const ironGeo = createColoredBoxGeometry(1.24, 0.06, 0.08, 0, 1.5, 0.14, 'iron');
      const ironMesh = new THREE.Mesh(ironGeo, ironMat);
      ironMesh.name = 'wood_wall_window_01_iron';

      root.add(bodyMesh, makeCornerPostMesh(), ironMesh);
      break;
    }

    case 'wood_wall_door_01': {
      // Bounds: x[-2.12, 2.00] y[-0.20, 3.00] z[-0.13, 0.14]
      // Door opening: x[-0.9, 0.9], y[0, 2.4]
      const bodyParts = [
        createColoredBoxGeometry(1.1, 3.2, 0.2, -1.45, 1.4, 0, 'wood'),
        createColoredBoxGeometry(1.1, 3.2, 0.2, 1.45, 1.4, 0, 'wood'),
        createColoredBoxGeometry(1.8, 0.6, 0.27, 0, 2.7, 0.005, 'wood'),
        createColoredBoxGeometry(1.8, 0.23, 0.22, 0, -0.085, 0, 'wood'),
      ];
      const bodyMesh = new THREE.Mesh(mergeFallbackGeometries(bodyParts, 'wood'), woodMat);
      bodyMesh.name = 'wood_wall_door_01_body';
      root.add(bodyMesh, makeCornerPostMesh());
      break;
    }

    case 'wood_floor_01': {
      // Bounds: x[-2.00, 2.00] y[-0.20, 0.00] z[-2.00, 2.00]
      const bodyGeo = createColoredBoxGeometry(4.0, 0.2, 4.0, 0, -0.1, 0, 'wood');
      const bodyMesh = new THREE.Mesh(bodyGeo, woodMat);
      bodyMesh.name = 'wood_floor_01_body';
      root.add(bodyMesh);
      break;
    }

    case 'wood_roof_slope_01': {
      // Bounds: x[-2.00, 2.00] y[-0.45, 1.64] z[-0.08, 2.45]
      const frameParts = [
        createColoredBoxGeometry(3.96, 0.12, 2.42, 0, 0.56, 1.16, 'wood', 0.6435),
        createColoredBoxGeometry(4.0, 0.16, 0.16, 0, -0.37, 2.37, 'wood'),
      ];
      const frameMesh = new THREE.Mesh(mergeFallbackGeometries(frameParts, 'wood'), woodMat);
      frameMesh.name = 'wood_roof_slope_01_frame';

      const shingleParts = [
        createColoredBoxGeometry(4.0, 0.1, 2.5, 0, 0.66, 1.18, 'roof', 0.6435),
        createColoredBoxGeometry(4.0, 0.14, 0.16, 0, 1.57, 0.0, 'roof'),
      ];
      const shingleMesh = new THREE.Mesh(mergeFallbackGeometries(shingleParts, 'roof'), roofMat);
      shingleMesh.name = 'wood_roof_slope_01_shingles';

      root.add(frameMesh, shingleMesh);
      break;
    }

    case 'wood_roof_gable_01': {
      // Bounds: x[-2.41, 2.41] y[-0.46, 1.68] z[-0.08, 0.16]
      const gableParts = [
        createColoredBoxGeometry(4.0, 0.55, 0.2, 0, 0.275, 0.02, 'wood'),
        createColoredBoxGeometry(2.6, 0.55, 0.2, 0, 0.825, 0.02, 'wood'),
        createColoredBoxGeometry(1.2, 0.52, 0.2, 0, 1.36, 0.02, 'wood'),
        createColoredBoxGeometry(4.82, 0.16, 0.24, 0, -0.38, 0.04, 'wood'),
        createColoredBoxGeometry(0.32, 0.16, 0.24, 0, 1.6, 0.04, 'wood'),
      ];
      const bodyMesh = new THREE.Mesh(mergeFallbackGeometries(gableParts, 'wood'), woodMat);
      bodyMesh.name = 'wood_roof_gable_01_body';
      root.add(bodyMesh);
      break;
    }

    case 'wood_door_01': {
      // Bounds: x[-0.91, 0.88] y[0.04, 2.38] z[-0.07, 0.07]
      // Hierarchy: wood_door_01 -> door_pivot (-0.88, 0, 0) -> door_leaf (wood), door_hardware (iron)
      const pivot = new THREE.Group();
      pivot.name = 'door_pivot';
      pivot.position.set(-0.88, 0, 0);

      const leafGeo = createColoredBoxGeometry(1.76, 2.34, 0.08, 0.88, 1.21, 0, 'wood');
      const leafMesh = new THREE.Mesh(leafGeo, woodMat);
      leafMesh.name = 'door_leaf';

      const hwParts = [
        // Latch handle near free edge (x ~ +1.60 in pivot space = +0.72 in door space)
        createColoredBoxGeometry(0.12, 0.18, 0.14, 1.6, 1.05, 0, 'iron'),
        // Hinge straps on pivot edge (x ~ -0.015 in pivot space = -0.895 in door space)
        createColoredBoxGeometry(0.06, 0.16, 0.12, 0.0, 0.42, 0, 'iron'),
        createColoredBoxGeometry(0.06, 0.16, 0.12, 0.0, 1.98, 0, 'iron'),
      ];
      const hwMesh = new THREE.Mesh(mergeFallbackGeometries(hwParts, 'iron'), ironMat);
      hwMesh.name = 'door_hardware';

      pivot.add(leafMesh, hwMesh);
      root.add(pivot);
      break;
    }

    case 'wood_stairs_01': {
      // Bounds: x[-0.66, 0.67] y[-0.01, 4.00] z[-4.01, 0.03]
      const stairParts: THREE.BufferGeometry[] = [];
      for (let s = 0; s < 15; s++) {
        const stepY = (s + 0.5) * 0.2;
        const stepZ = -(s + 0.5) * (4.0 / 15);
        stairParts.push(createColoredBoxGeometry(1.2, 0.06, 0.27, 0, stepY, stepZ, 'wood'));
      }
      // Stringer ramp + handrail posts on +X side up to y=4.00
      stairParts.push(createColoredBoxGeometry(1.2, 0.12, 4.95, 0, 1.48, -2.0, 'wood', 0.6435));
      stairParts.push(createColoredBoxGeometry(0.08, 1.02, 0.08, 0.62, 0.5, -0.01, 'wood'));
      stairParts.push(createColoredBoxGeometry(0.08, 1.02, 0.08, 0.63, 3.49, -3.97, 'wood'));
      stairParts.push(createColoredBoxGeometry(1.33, 0.04, 0.08, 0.005, 0.01, -0.01, 'wood'));

      const bodyMesh = new THREE.Mesh(mergeFallbackGeometries(stairParts, 'wood'), woodMat);
      bodyMesh.name = 'wood_stairs_01_body';
      root.add(bodyMesh);
      break;
    }
  }

  return root;
}

/**
 * Normalizes a loaded GLB (or fallback) hierarchy:
 * - Deduplicates materials onto the 5 Stage04A shared singletons (`wood`, `roof`, `iron`, ...)
 * - Ensures `COLOR_0` vertex colors and `userData.sharedAsset = true` on all geometries
 * - Extracts `bodyMeshes`, `bounds`, `triangles`, `hasDoorPivot`, and `doorPivotPos`
 */
function compileBuildingAsset(
  assetId: BuildingAssetId,
  rawRoot: THREE.Object3D,
  isFallback = false,
): CachedBuildingAssetTemplate {
  let templateScene: THREE.Group;
  if (rawRoot instanceof THREE.Group) {
    templateScene = rawRoot;
  } else {
    templateScene = new THREE.Group();
    templateScene.add(rawRoot);
  }
  templateScene.name = assetId;
  templateScene.position.set(0, 0, 0);
  templateScene.rotation.set(0, 0, 0);
  templateScene.scale.set(1, 1, 1);

  const usedMaterials = deduplicateStage04AGltfMaterials(templateScene);
  templateScene.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(templateScene.matrixWorld).invert();

  const pivotObj = templateScene.getObjectByName('door_pivot') ?? null;
  const hasDoorPivot = Boolean(pivotObj);
  const doorPivotPos: [number, number, number] | null = pivotObj
    ? [q3(pivotObj.position.x), q3(pivotObj.position.y), q3(pivotObj.position.z)]
    : null;

  const bodyMeshes: BuildingBodyMeshPart[] = [];
  const meshNames: string[] = [];
  const bounds = new THREE.Box3();
  let triangles = 0;
  let hasVertexColors = false;

  templateScene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.geometry) return;
    const meshName = obj.name || 'mesh';
    meshNames.push(meshName);

    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const materialName: Stage04AMaterialName =
      (mat?.userData?.stage04aMaterialName as Stage04AMaterialName | undefined) ??
      resolveStage04AMaterialName(mat?.name || meshName);

    if (ensureRgbVertexColors(obj.geometry, materialName)) {
      hasVertexColors = true;
    }
    obj.geometry.userData.sharedAsset = true;

    const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, obj.matrixWorld);
    if (!obj.geometry.boundingBox) {
      obj.geometry.computeBoundingBox();
    }
    if (obj.geometry.boundingBox) {
      const localBox = obj.geometry.boundingBox.clone().applyMatrix4(localMatrix);
      bounds.union(localBox);
    }

    const lowerName = meshName.toLowerCase();
    const parentLower = (obj.parent?.name || '').toLowerCase();
    const isCornerPost = lowerName.includes('corner_post') || parentLower.includes('corner_post');

    let isDoorMovingPart = false;
    let cursor: THREE.Object3D | null = obj.parent;
    while (cursor) {
      if (cursor.name === 'door_pivot') {
        isDoorMovingPart = true;
        break;
      }
      cursor = cursor.parent;
    }
    if (lowerName.includes('door_leaf') || lowerName.includes('door_hardware')) {
      isDoorMovingPart = true;
    }

    triangles += countGeoTriangles(obj.geometry);
    bodyMeshes.push({
      name: meshName,
      geometry: obj.geometry,
      materialName,
      localMatrix,
      isCornerPost,
      isDoorMovingPart,
    });
  });

  if (bodyMeshes.length === 0) {
    throw new Error(`[BuildingAssetRegistry] '${assetId}' ichida hech qanday mesh topilmadi`);
  }

  return {
    assetId,
    templateScene,
    bodyMeshes,
    bounds,
    triangles,
    hasVertexColors,
    hasDoorPivot,
    doorPivotPos,
    meshNames,
    materialNames: Array.from(usedMaterials),
    isFallback,
  };
}

function getOrCreateFallbackAsset(assetId: BuildingAssetId): CachedBuildingAssetTemplate {
  let fb = fallbackCache.get(assetId);
  if (!fb) {
    const group = buildProceduralFallbackScene(assetId);
    fb = compileBuildingAsset(assetId, group, true);
    fallbackCache.set(assetId, fb);
  }
  return fb;
}

function notifyReadyListeners(): void {
  for (const cb of readyListeners) {
    try {
      cb();
    } catch (err) {
      console.warn('[BuildingAssetRegistry] ready listener xatosi:', err);
    }
  }
}

/**
 * Loads all 8 Stage 04A building GLBs exactly once via `GLTFLoader`, deduplicating
 * their materials onto the shared Stage04A singleton materials (`wood`, `roof`, `iron`).
 * In headless Node/test environments (`typeof window === 'undefined'`), populates the
 * cache with exact-dimension procedural fallback templates without throwing.
 */
export function preloadBuildingAssets(): Promise<void> {
  if (preloadPromise) return preloadPromise;

  if (typeof window === 'undefined') {
    for (const id of BUILDING_ASSET_IDS) {
      if (!assetCache.has(id)) {
        assetCache.set(id, getOrCreateFallbackAsset(id));
      }
    }
    assetsReady = true;
    preloadPromise = Promise.resolve().then(() => {
      notifyReadyListeners();
    });
    return preloadPromise;
  }

  const loader = new GLTFLoader();
  preloadPromise = Promise.all(
    BUILDING_ASSET_IDS.map(
      (assetId) =>
        new Promise<void>((resolve) => {
          const existing = assetCache.get(assetId);
          if (existing && !existing.isFallback) {
            resolve();
            return;
          }
          loader.load(
            BUILDING_GLB_URLS[assetId],
            (gltf) => {
              try {
                const compiled = compileBuildingAsset(assetId, gltf.scene, false);
                assetCache.set(assetId, compiled);
                failedAssets.delete(assetId);
              } catch (err) {
                console.warn(
                  `[BuildingAssetRegistry] '${assetId}' GLB tahlilida xato, fallback ishlatiladi:`,
                  err,
                );
                failedAssets.add(assetId);
                assetCache.set(assetId, getOrCreateFallbackAsset(assetId));
              }
              resolve();
            },
            undefined,
            (err) => {
              console.warn(
                `[BuildingAssetRegistry] '${BUILDING_GLB_URLS[assetId]}' yuklanmadi, fallback ishlatiladi:`,
                err,
              );
              failedAssets.add(assetId);
              assetCache.set(assetId, getOrCreateFallbackAsset(assetId));
              resolve();
            },
          );
        }),
    ),
  ).then(() => {
    assetsReady = true;
    notifyReadyListeners();
  });

  return preloadPromise;
}

export function areBuildingAssetsReady(): boolean {
  return assetsReady || assetCache.size === BUILDING_ASSET_IDS.length;
}

export function onBuildingAssetsReady(cb: () => void): () => void {
  if (areBuildingAssetsReady()) {
    cb();
    return () => {};
  }
  readyListeners.add(cb);
  return () => {
    readyListeners.delete(cb);
  };
}

/**
 * Returns the cached building module template for `id`.
 * If called before async GLB loading finishes or in Node/test environments,
 * returns an exact-dimension procedural fallback with `userData.sharedAsset = true`.
 */
export function getCachedBuildingAsset(id: BuildingAssetId): CachedBuildingAssetTemplate {
  return assetCache.get(id) ?? getOrCreateFallbackAsset(id);
}

/**
 * Compiles and registers a custom `THREE.Object3D` into the building asset cache
 * (useful for unit tests or custom GLB scene injection).
 */
export function registerBuildingAssetFromObject(
  id: BuildingAssetId,
  sceneRoot: THREE.Object3D,
): CachedBuildingAssetTemplate {
  const compiled = compileBuildingAsset(id, sceneRoot, false);
  assetCache.set(id, compiled);
  failedAssets.delete(id);
  return compiled;
}

export function hasBuildingAssetFailed(id: BuildingAssetId): boolean {
  return failedAssets.has(id);
}

export function getBuildingAssetDiagnostics(): Record<BuildingAssetId, BuildingAssetDiagnosticEntry> {
  const out = {} as Record<BuildingAssetId, BuildingAssetDiagnosticEntry>;
  const sizeVec = new THREE.Vector3();

  for (const id of BUILDING_ASSET_IDS) {
    const tpl = assetCache.get(id) ?? getOrCreateFallbackAsset(id);
    tpl.bounds.getSize(sizeVec);
    out[id] = {
      assetId: id,
      loaded: assetCache.has(id) && !tpl.isFallback,
      failed: failedAssets.has(id),
      isFallback: tpl.isFallback,
      url: BUILDING_GLB_URLS[id],
      triangles: tpl.triangles,
      hasVertexColors: tpl.hasVertexColors,
      hasDoorPivot: tpl.hasDoorPivot,
      doorPivotPos: tpl.doorPivotPos ? [...tpl.doorPivotPos] : null,
      boundsMin: [q3(tpl.bounds.min.x), q3(tpl.bounds.min.y), q3(tpl.bounds.min.z)],
      boundsMax: [q3(tpl.bounds.max.x), q3(tpl.bounds.max.y), q3(tpl.bounds.max.z)],
      size: [q3(sizeVec.x), q3(sizeVec.y), q3(sizeVec.z)],
      meshNames: [...tpl.meshNames],
      materialNames: [...tpl.materialNames],
      bodyMeshCount: tpl.bodyMeshes.length,
    };
  }

  return out;
}
