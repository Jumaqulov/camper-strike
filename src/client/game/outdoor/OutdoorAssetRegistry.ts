import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { q3 } from '../../../shared/math';
import {
  CAMPFIRE_FIRE_ANCHOR_LOCAL,
  OUTDOOR_ASSET_IDS,
  OUTDOOR_ASSET_MANIFEST,
  OUTDOOR_GLB_URLS,
  SIGNPOST_ANCHOR_NAMES,
  SIGNPOST_TEXT_ANCHORS,
  type OutdoorAssetCategory,
  type OutdoorAssetId,
  type OutdoorAssetManifestEntry,
  type OutdoorMaterialName,
  type OutdoorPlacement,
  type OutdoorSignpostAnchorName,
  type OutdoorSignpostAnchorSpec,
  type OutdoorSignpostBoardLabel,
} from '../../../shared/outdoor/contracts';

export {
  CAMPFIRE_FIRE_ANCHOR_LOCAL,
  OUTDOOR_ASSET_IDS,
  OUTDOOR_ASSET_MANIFEST,
  OUTDOOR_GLB_URLS,
  SIGNPOST_ANCHOR_NAMES,
  SIGNPOST_TEXT_ANCHORS,
  type OutdoorAssetCategory,
  type OutdoorAssetId,
  type OutdoorAssetManifestEntry,
  type OutdoorMaterialName,
  type OutdoorPlacement,
  type OutdoorSignpostAnchorName,
  type OutdoorSignpostAnchorSpec,
  type OutdoorSignpostBoardLabel,
};

export const OUTDOOR_MATERIAL_NAMES: readonly OutdoorMaterialName[] = [
  'wood',
  'stone',
  'iron',
  'fabric',
  'painted_metal',
] as const;

const OUTDOOR_MATERIAL_SPECS: Record<
  OutdoorMaterialName,
  { roughness: number; metalness: number }
> = {
  wood: { roughness: 0.88, metalness: 0.0 },
  stone: { roughness: 0.92, metalness: 0.0 },
  iron: { roughness: 0.6, metalness: 0.45 },
  fabric: { roughness: 0.97, metalness: 0.0 },
  painted_metal: { roughness: 0.72, metalness: 0.25 },
};

const materialCache = new Map<OutdoorMaterialName, THREE.MeshStandardMaterial>();

/**
 * Returns a globally cached, deduplicated `THREE.MeshStandardMaterial` for Stage 08A
 * outdoor GLB assets (`wood`, `stone`, `iron`, `fabric`, `painted_metal`).
 * Marked with `vertexColors: true` and `userData.sharedAsset = true` so scene disposal
 * never destroys shared materials.
 */
export function getOutdoorSharedMaterial(name: OutdoorMaterialName): THREE.MeshStandardMaterial {
  let mat = materialCache.get(name);
  if (!mat) {
    const spec = OUTDOOR_MATERIAL_SPECS[name] ?? OUTDOOR_MATERIAL_SPECS.wood;
    mat = new THREE.MeshStandardMaterial({
      name: `outdoor_${name}`,
      vertexColors: true,
      roughness: spec.roughness,
      metalness: spec.metalness,
    });
    mat.userData.sharedAsset = true;
    mat.userData.outdoorMaterialName = name;
    materialCache.set(name, mat);
  }
  return mat;
}

/**
 * Resolves a raw glTF material or mesh name (including `'rock'` from Blender exports)
 * into one of the 5 canonical `OutdoorMaterialName` keys.
 */
export function resolveOutdoorMaterialName(rawName: string | undefined): OutdoorMaterialName {
  const n = (rawName ?? '').trim().toLowerCase();
  if (
    n === 'painted_metal' ||
    n.includes('painted_metal') ||
    n.includes('fuel_pump_01_body') ||
    n.includes('rusty_barrel') ||
    n.includes('barrel')
  ) {
    return 'painted_metal';
  }
  if (n === 'iron' || n.includes('iron') || n.includes('metal') || n.includes('hardware')) {
    return 'iron';
  }
  if (
    n === 'stone' ||
    n === 'rock' ||
    n.includes('stone') ||
    n.includes('rock') ||
    n.includes('fuel_pump_01_base')
  ) {
    return 'stone';
  }
  if (n === 'fabric' || n.includes('fabric') || n.includes('cloth') || n.includes('canvas')) {
    return 'fabric';
  }
  return 'wood';
}

export function getOutdoorSharedMaterialCount(): number {
  return materialCache.size;
}

export interface CompiledOutdoorSubMesh {
  meshName: string;
  materialName: OutdoorMaterialName;
  geometry: THREE.BufferGeometry;
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface SignpostAnchorDiagnostic {
  name: OutdoorSignpostAnchorName;
  found: boolean;
  position: [number, number, number];
  positionOK: boolean;
}

export interface CampfireAnchorDiagnostic {
  name: 'fire_anchor';
  found: boolean;
  position: [number, number, number];
  positionOK: boolean;
}

export interface CachedOutdoorAssetTemplate {
  assetId: OutdoorAssetId;
  code: string;
  url: string;
  category: OutdoorAssetCategory;
  scene: THREE.Group;
  templateScene: THREE.Group;
  subMeshes: CompiledOutdoorSubMesh[];
  meshNames: string[];
  materialsUsed: OutdoorMaterialName[];
  materialNames: OutdoorMaterialName[];
  triangles: number;
  vertices: number;
  hasVertexColors: boolean;
  noCamerasOrLights: boolean;
  bounds: THREE.Box3;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  dimensions: THREE.Vector3;
  size: [number, number, number];
  signAnchors: Record<OutdoorSignpostAnchorName, [number, number, number]> | null;
  signAnchorDiagnostics: SignpostAnchorDiagnostic[];
  fireAnchor: [number, number, number] | null;
  fireAnchorDiagnostic: CampfireAnchorDiagnostic | null;
  hasRailingPostStart: boolean;
  isFallback: boolean;
}

export interface OutdoorAssetDiagnosticEntry {
  assetId: OutdoorAssetId;
  code: string;
  url: string;
  category: OutdoorAssetCategory;
  loaded: boolean;
  failed: boolean;
  isFallback: boolean;
  triangles: number;
  expectedTriangles: number;
  trianglesMatch: boolean;
  vertices: number;
  expectedVertices: number;
  meshNames: string[];
  subMeshCount: number;
  materialsUsed: OutdoorMaterialName[];
  materialNames: OutdoorMaterialName[];
  hasVertexColors: boolean;
  noCamerasOrLights: boolean;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  dimensions: [number, number, number];
  size: [number, number, number];
  signAnchors: Record<OutdoorSignpostAnchorName, [number, number, number]> | null;
  signAnchorDiagnostics: SignpostAnchorDiagnostic[];
  fireAnchor: [number, number, number] | null;
  fireAnchorDiagnostic: CampfireAnchorDiagnostic | null;
  hasRailingPostStart: boolean;
}

const assetCache = new Map<OutdoorAssetId, CachedOutdoorAssetTemplate>();
const fallbackCache = new Map<OutdoorAssetId, CachedOutdoorAssetTemplate>();
const failedAssets = new Set<OutdoorAssetId>();
let preloadPromise: Promise<void> | null = null;
const readyListeners = new Set<() => void>();

function countGeoTriangles(geo: THREE.BufferGeometry | null | undefined): number {
  if (!geo) return 0;
  const idx = geo.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.round(pos.count / 3) : 0;
}

function countGeoVertices(geo: THREE.BufferGeometry | null | undefined): number {
  if (!geo) return 0;
  const pos = geo.getAttribute('position');
  return pos ? pos.count : 0;
}

function defaultColorForOutdoorMaterial(
  assetId: OutdoorAssetId,
  matName: OutdoorMaterialName,
): [number, number, number] {
  switch (matName) {
    case 'stone':
      return [0.42, 0.43, 0.41];
    case 'iron':
      return [0.27, 0.29, 0.31];
    case 'fabric':
      return [0.34, 0.44, 0.29];
    case 'painted_metal':
      if (assetId === 'old_fuel_pump_01') {
        return [0.68, 0.22, 0.17];
      }
      return [0.46, 0.32, 0.24];
    case 'wood':
    default:
      return [0.54, 0.37, 0.22];
  }
}

/**
 * Ensures `geo` has a 3-component Float32 `color` attribute (`COLOR_0`) so
 * `MeshStandardMaterial({ vertexColors: true })` renders cleanly across all batches.
 */
function ensureOutdoorVertexColors(
  geo: THREE.BufferGeometry,
  assetId: OutdoorAssetId,
  matName: OutdoorMaterialName,
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

  const [cr, cg, cb] = defaultColorForOutdoorMaterial(assetId, matName);
  const rgb = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const shade = 0.92 + ((i % 7) / 7) * 0.14;
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
  assetId: OutdoorAssetId,
  matName: OutdoorMaterialName,
  rotY = 0,
  rotZ = 0,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  if (rotZ !== 0) {
    geo.rotateZ(rotZ);
  }
  if (rotY !== 0) {
    geo.rotateY(rotY);
  }
  if (cx !== 0 || cy !== 0 || cz !== 0) {
    geo.translate(cx, cy, cz);
  }
  ensureOutdoorVertexColors(geo, assetId, matName);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.sharedAsset = true;
  return geo;
}

function mergeFallbackGeometries(
  geos: THREE.BufferGeometry[],
  assetId: OutdoorAssetId,
  matName: OutdoorMaterialName,
): THREE.BufferGeometry {
  if (geos.length === 1) {
    ensureOutdoorVertexColors(geos[0], assetId, matName);
    geos[0].computeBoundingBox();
    geos[0].computeBoundingSphere();
    geos[0].userData.sharedAsset = true;
    return geos[0];
  }

  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of geos) {
    ensureOutdoorVertexColors(g, assetId, matName);
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

function createFallbackMesh(
  name: string,
  geo: THREE.BufferGeometry,
  matName: OutdoorMaterialName,
): THREE.Mesh {
  const mat = getOutdoorSharedMaterial(matName);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.sharedAsset = true;
  return mesh;
}

/**
 * Builds a deterministic procedural fallback hierarchy matching the exact sub-mesh names,
 * materials (`wood`, `stone`, `iron`, `fabric`, `painted_metal`), bounds, and anchor nodes
 * (`sign_1_text_front`..`sign_3_text_back` and `fire_anchor`) for all 8 `OutdoorAssetId`s.
 */
export function buildProceduralOutdoorFallback(assetId: OutdoorAssetId): THREE.Group {
  const root = new THREE.Group();
  root.name = assetId;
  root.userData.sharedAsset = true;

  switch (assetId) {
    case 'wooden_signpost_01': {
      const woodGeo = mergeFallbackGeometries(
        [
          createColoredBoxGeometry(0.14, 2.078, 0.14, 0, 0.989, 0, assetId, 'wood'),
          createColoredBoxGeometry(0.66, 0.16, 0.04, 0.34, 1.72, -0.02, assetId, 'wood', THREE.MathUtils.degToRad(10)),
          createColoredBoxGeometry(0.58, 0.15, 0.04, -0.29, 1.5, 0.055, assetId, 'wood', THREE.MathUtils.degToRad(-165)),
          createColoredBoxGeometry(0.5, 0.15, 0.04, 0.115, 1.28, -0.24, assetId, 'wood', THREE.MathUtils.degToRad(65)),
        ],
        assetId,
        'wood',
      );
      const rocksGeo = createColoredBoxGeometry(0.52, 0.22, 0.48, 0, 0.06, 0, assetId, 'stone');
      root.add(
        createFallbackMesh('wooden_signpost_01_wood', woodGeo, 'wood'),
        createFallbackMesh('wooden_signpost_01_rocks', rocksGeo, 'stone'),
      );
      for (const spec of SIGNPOST_TEXT_ANCHORS) {
        const node = new THREE.Object3D();
        node.name = spec.name;
        node.position.set(spec.position[0], spec.position[1], spec.position[2]);
        node.rotation.y = THREE.MathUtils.degToRad(
          spec.boardYawDeg + (spec.side === 'back' ? 180 : 0),
        );
        node.userData.sharedAsset = true;
        root.add(node);
      }
      break;
    }

    case 'lumber_stack_01': {
      const woodGeo = createColoredBoxGeometry(2.448, 1.261, 1.32, 0, 0.527, 0, assetId, 'wood');
      root.add(createFallbackMesh('lumber_stack_01_wood', woodGeo, 'wood'));
      break;
    }

    case 'sawhorse_01': {
      const woodGeo = createColoredBoxGeometry(1.643, 1.046, 0.903, 0, 0.512, 0, assetId, 'wood');
      const metalGeo = createColoredBoxGeometry(0.24, 0.18, 0.22, 0, 0.82, 0, assetId, 'iron');
      root.add(
        createFallbackMesh('sawhorse_01_wood', woodGeo, 'wood'),
        createFallbackMesh('sawhorse_01_metal', metalGeo, 'iron'),
      );
      break;
    }

    case 'old_fuel_pump_01': {
      const bodyGeo = createColoredBoxGeometry(0.56, 1.38, 0.42, 0, 0.77, 0, assetId, 'painted_metal');
      const metalGeo = createColoredBoxGeometry(0.22, 0.46, 0.22, 0.26, 1.42, 0, assetId, 'iron');
      const baseGeo = createColoredBoxGeometry(0.72, 0.1, 0.62, 0, 0.05, 0, assetId, 'stone');
      root.add(
        createFallbackMesh('old_fuel_pump_01_body', bodyGeo, 'painted_metal'),
        createFallbackMesh('old_fuel_pump_01_metal', metalGeo, 'iron'),
        createFallbackMesh('old_fuel_pump_01_base', baseGeo, 'stone'),
      );
      break;
    }

    case 'rusty_barrel_01': {
      const cylGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.909, 12);
      cylGeo.translate(0, 0.4545, 0);
      ensureOutdoorVertexColors(cylGeo, assetId, 'painted_metal');
      cylGeo.computeVertexNormals();
      cylGeo.computeBoundingBox();
      cylGeo.computeBoundingSphere();
      cylGeo.userData.sharedAsset = true;
      root.add(createFallbackMesh('rusty_barrel_01_body', cylGeo, 'painted_metal'));
      break;
    }

    case 'forest_tent_01': {
      const fabricGeo = mergeFallbackGeometries(
        [
          createColoredBoxGeometry(0.1, 1.72, 2.55, -0.52, 0.74, 0, assetId, 'fabric', 0, -0.58),
          createColoredBoxGeometry(0.1, 1.72, 2.55, 0.52, 0.74, 0, assetId, 'fabric', 0, 0.58),
          createColoredBoxGeometry(1.4, 1.15, 0.08, 0, 0.58, -1.24, assetId, 'fabric'),
        ],
        assetId,
        'fabric',
      );
      const polesGeo = mergeFallbackGeometries(
        [
          createColoredBoxGeometry(0.08, 1.58, 0.08, 0, 0.76, 1.26, assetId, 'wood'),
          createColoredBoxGeometry(0.08, 1.58, 0.08, 0, 0.76, -1.26, assetId, 'wood'),
          createColoredBoxGeometry(0.07, 0.07, 2.68, 0, 1.52, 0, assetId, 'wood'),
        ],
        assetId,
        'wood',
      );
      root.add(
        createFallbackMesh('forest_tent_01_fabric', fabricGeo, 'fabric'),
        createFallbackMesh('forest_tent_01_poles', polesGeo, 'wood'),
      );
      break;
    }

    case 'campfire_pit_01': {
      const stonesGeo = createColoredBoxGeometry(1.347, 0.24, 1.36, 0, 0.1, 0, assetId, 'stone');
      const logsGeo = createColoredBoxGeometry(0.76, 0.22, 0.76, 0, 0.18, 0, assetId, 'wood');
      root.add(
        createFallbackMesh('campfire_pit_01_stones', stonesGeo, 'stone'),
        createFallbackMesh('campfire_pit_01_logs', logsGeo, 'wood'),
      );
      const fireAnchor = new THREE.Object3D();
      fireAnchor.name = 'fire_anchor';
      fireAnchor.position.set(
        CAMPFIRE_FIRE_ANCHOR_LOCAL[0],
        CAMPFIRE_FIRE_ANCHOR_LOCAL[1],
        CAMPFIRE_FIRE_ANCHOR_LOCAL[2],
      );
      fireAnchor.userData.sharedAsset = true;
      root.add(fireAnchor);
      break;
    }

    case 'wooden_railing_01': {
      const bodyGeo = mergeFallbackGeometries(
        [
          createColoredBoxGeometry(3.0, 0.1, 0.12, 0, 0.94, 0, assetId, 'wood'),
          createColoredBoxGeometry(3.0, 0.08, 0.1, 0, 0.5, 0, assetId, 'wood'),
          createColoredBoxGeometry(0.14, 1.142, 0.14, 1.5, 0.421, 0, assetId, 'wood'),
        ],
        assetId,
        'wood',
      );
      const startPostGeo = createColoredBoxGeometry(
        0.14,
        1.142,
        0.14,
        -1.5,
        0.421,
        0,
        assetId,
        'wood',
      );
      const metalGeo = createColoredBoxGeometry(0.18, 0.08, 0.16, 0, 0.94, 0, assetId, 'iron');
      root.add(
        createFallbackMesh('wooden_railing_01_body', bodyGeo, 'wood'),
        createFallbackMesh('railing_post_start', startPostGeo, 'wood'),
        createFallbackMesh('wooden_railing_01_metal', metalGeo, 'iron'),
      );
      break;
    }
  }

  return root;
}

function isPositionNear(
  actual: readonly [number, number, number] | THREE.Vector3,
  expected: readonly [number, number, number],
  tolerance = 0.035,
): boolean {
  const ax = Array.isArray(actual) ? actual[0] : (actual as THREE.Vector3).x;
  const ay = Array.isArray(actual) ? actual[1] : (actual as THREE.Vector3).y;
  const az = Array.isArray(actual) ? actual[2] : (actual as THREE.Vector3).z;
  return (
    Math.abs(ax - expected[0]) <= tolerance &&
    Math.abs(ay - expected[1]) <= tolerance &&
    Math.abs(az - expected[2]) <= tolerance
  );
}

function resolveMeshMaterialName(mesh: THREE.Mesh): OutdoorMaterialName {
  const rawMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const tagged = rawMat?.userData?.outdoorMaterialName as OutdoorMaterialName | undefined;
  if (tagged) return tagged;
  const matName = (rawMat?.name ?? '').trim();
  const meshName = (mesh.name ?? '').trim();
  // Prefer explicit material name when it resolves to a non-default material, or combine with meshName
  return resolveOutdoorMaterialName(`${matName} ${meshName}`);
}

/**
 * Traverses `rawRoot`, normalizes materials to the 5 shared `OutdoorMaterialName` singletons,
 * extracts compiled local-to-root `CompiledOutdoorSubMesh` geometries for `InstancedMesh` rendering,
 * and verifies anchor nodes (`sign_1_text_front`..`sign_3_text_back`, `fire_anchor`).
 */
function compileOutdoorAsset(
  assetId: OutdoorAssetId,
  rawRoot: THREE.Object3D,
  isFallback = false,
): CachedOutdoorAssetTemplate {
  const manifest = OUTDOOR_ASSET_MANIFEST[assetId];
  const scene = rawRoot instanceof THREE.Group ? rawRoot : new THREE.Group().add(rawRoot);
  scene.name = assetId;
  scene.position.set(0, 0, 0);
  scene.rotation.set(0, 0, 0);
  scene.scale.set(1, 1, 1);
  scene.updateMatrixWorld(true);

  const rootInverse = new THREE.Matrix4().copy(scene.matrixWorld).invert();

  const meshNames: string[] = [];
  const usedMaterials = new Set<OutdoorMaterialName>();
  const rawSubMeshes: CompiledOutdoorSubMesh[] = [];
  let triangles = 0;
  let vertices = 0;
  let hasVertexColors = true;
  let noCamerasOrLights = true;

  scene.traverse((obj) => {
    obj.userData.sharedAsset = true;
    if (obj instanceof THREE.Camera || obj instanceof THREE.Light) {
      noCamerasOrLights = false;
    }
    if (!(obj instanceof THREE.Mesh) || !obj.geometry) return;

    const mName = obj.name || 'mesh';
    meshNames.push(mName);

    const materialName = resolveMeshMaterialName(obj);
    usedMaterials.add(materialName);

    // Replace duplicate GLTF material with shared singleton
    const oldMats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of oldMats) {
      if (m && !m.userData?.sharedAsset) {
        m.dispose();
      }
    }
    obj.material = getOutdoorSharedMaterial(materialName);
    obj.castShadow = true;
    obj.receiveShadow = true;

    const relMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, obj.matrixWorld);
    const clonedGeo = obj.geometry.clone();
    clonedGeo.applyMatrix4(relMatrix);

    if (!clonedGeo.getAttribute('normal')) {
      clonedGeo.computeVertexNormals();
    }
    if (!ensureOutdoorVertexColors(clonedGeo, assetId, materialName)) {
      hasVertexColors = false;
    }
    clonedGeo.computeBoundingBox();
    clonedGeo.computeBoundingSphere();
    clonedGeo.userData.sharedAsset = true;
    obj.geometry.userData.sharedAsset = true;

    triangles += countGeoTriangles(clonedGeo);
    vertices += countGeoVertices(clonedGeo);

    rawSubMeshes.push({
      meshName: mName,
      materialName,
      geometry: clonedGeo,
      castShadow: true,
      receiveShadow: true,
    });
  });

  if (rawSubMeshes.length === 0) {
    throw new Error(`[OutdoorAssetRegistry] '${assetId}' ichida hech qanday mesh topilmadi`);
  }

  // Order subMeshes deterministically matching OUTDOOR_ASSET_MANIFEST[assetId].meshNames first
  const subMeshes: CompiledOutdoorSubMesh[] = [];
  const remaining = [...rawSubMeshes];
  for (const expectedName of manifest.meshNames) {
    const idx = remaining.findIndex((s) => s.meshName === expectedName);
    if (idx >= 0) {
      subMeshes.push(remaining.splice(idx, 1)[0]);
    }
  }
  subMeshes.push(...remaining);

  const bounds = new THREE.Box3();
  for (const sm of subMeshes) {
    if (sm.geometry.boundingBox) {
      bounds.union(sm.geometry.boundingBox);
    }
  }
  const dimensions = bounds.isEmpty() ? new THREE.Vector3() : bounds.getSize(new THREE.Vector3());
  const boundsMin: [number, number, number] = bounds.isEmpty()
    ? [0, 0, 0]
    : [q3(bounds.min.x), q3(bounds.min.y), q3(bounds.min.z)];
  const boundsMax: [number, number, number] = bounds.isEmpty()
    ? [0, 0, 0]
    : [q3(bounds.max.x), q3(bounds.max.y), q3(bounds.max.z)];
  const size: [number, number, number] = [q3(dimensions.x), q3(dimensions.y), q3(dimensions.z)];

  let signAnchors: Record<OutdoorSignpostAnchorName, [number, number, number]> | null = null;
  const signAnchorDiagnostics: SignpostAnchorDiagnostic[] = [];

  if (assetId === 'wooden_signpost_01') {
    signAnchors = {} as Record<OutdoorSignpostAnchorName, [number, number, number]>;
    const tmpPos = new THREE.Vector3();
    for (const spec of SIGNPOST_TEXT_ANCHORS) {
      const node = scene.getObjectByName(spec.name);
      if (node) {
        tmpPos.setFromMatrixPosition(node.matrixWorld).applyMatrix4(rootInverse);
        const posTuple: [number, number, number] = [q3(tmpPos.x), q3(tmpPos.y), q3(tmpPos.z)];
        signAnchors[spec.name] = posTuple;
        signAnchorDiagnostics.push({
          name: spec.name,
          found: true,
          position: posTuple,
          positionOK: isPositionNear(posTuple, spec.position),
        });
      } else {
        const fallbackPos: [number, number, number] = [
          spec.position[0],
          spec.position[1],
          spec.position[2],
        ];
        signAnchors[spec.name] = fallbackPos;
        signAnchorDiagnostics.push({
          name: spec.name,
          found: false,
          position: fallbackPos,
          positionOK: false,
        });
      }
    }
  }

  let fireAnchor: [number, number, number] | null = null;
  let fireAnchorDiagnostic: CampfireAnchorDiagnostic | null = null;

  if (assetId === 'campfire_pit_01') {
    const node = scene.getObjectByName('fire_anchor');
    if (node) {
      const tmpPos = new THREE.Vector3()
        .setFromMatrixPosition(node.matrixWorld)
        .applyMatrix4(rootInverse);
      fireAnchor = [q3(tmpPos.x), q3(tmpPos.y), q3(tmpPos.z)];
      fireAnchorDiagnostic = {
        name: 'fire_anchor',
        found: true,
        position: fireAnchor,
        positionOK: isPositionNear(fireAnchor, CAMPFIRE_FIRE_ANCHOR_LOCAL),
      };
    } else {
      fireAnchor = [
        CAMPFIRE_FIRE_ANCHOR_LOCAL[0],
        CAMPFIRE_FIRE_ANCHOR_LOCAL[1],
        CAMPFIRE_FIRE_ANCHOR_LOCAL[2],
      ];
      fireAnchorDiagnostic = {
        name: 'fire_anchor',
        found: false,
        position: fireAnchor,
        positionOK: false,
      };
    }
  }

  const hasRailingPostStart = subMeshes.some((sm) => sm.meshName === 'railing_post_start');
  const materialsList = Array.from(usedMaterials);

  return {
    assetId,
    code: manifest.code,
    url: manifest.glbUrl,
    category: manifest.category,
    scene,
    templateScene: scene,
    subMeshes,
    meshNames,
    materialsUsed: materialsList,
    materialNames: materialsList,
    triangles,
    vertices,
    hasVertexColors,
    noCamerasOrLights,
    bounds,
    boundsMin,
    boundsMax,
    dimensions,
    size,
    signAnchors,
    signAnchorDiagnostics,
    fireAnchor,
    fireAnchorDiagnostic,
    hasRailingPostStart,
    isFallback,
  };
}

function getOrCreateFallbackTemplate(assetId: OutdoorAssetId): CachedOutdoorAssetTemplate {
  let tpl = fallbackCache.get(assetId);
  if (!tpl) {
    const fallbackGroup = buildProceduralOutdoorFallback(assetId);
    tpl = compileOutdoorAsset(assetId, fallbackGroup, true);
    fallbackCache.set(assetId, tpl);
  }
  return tpl;
}

function notifyReadyListeners(): void {
  for (const cb of readyListeners) {
    try {
      cb();
    } catch (e) {
      console.warn('[OutdoorAssetRegistry] listener error:', e);
    }
  }
}

/**
 * Registers a parsed `THREE.Object3D` (or procedural fallback) for `assetId` into the cache,
 * extracting compiled sub-mesh geometries for `InstancedMesh` rendering.
 */
export function registerOutdoorAssetFromObject(
  assetId: OutdoorAssetId,
  root: THREE.Object3D,
  isFallback = false,
): CachedOutdoorAssetTemplate {
  const tpl = compileOutdoorAsset(assetId, root, isFallback);
  if (isFallback) {
    fallbackCache.set(assetId, tpl);
    if (!assetCache.has(assetId)) {
      assetCache.set(assetId, tpl);
    }
  } else {
    assetCache.set(assetId, tpl);
    failedAssets.delete(assetId);
    notifyReadyListeners();
  }
  return tpl;
}

/**
 * Preloads all 8 Stage 08A `OUTDOOR-ASSET-01` GLB models once via `GLTFLoader`.
 * In headless Node tests (`typeof window === 'undefined'`), prepares procedural fallbacks cleanly.
 */
export function preloadOutdoorAssets(): Promise<void> {
  if (preloadPromise) return preloadPromise;

  for (const assetId of OUTDOOR_ASSET_IDS) {
    getOrCreateFallbackTemplate(assetId);
  }

  if (typeof window === 'undefined') {
    preloadPromise = Promise.resolve().then(() => {
      notifyReadyListeners();
    });
    return preloadPromise;
  }

  const loader = new GLTFLoader();
  preloadPromise = Promise.all(
    OUTDOOR_ASSET_IDS.map(
      (assetId) =>
        new Promise<void>((resolve) => {
          const existing = assetCache.get(assetId);
          if (existing && !existing.isFallback) {
            resolve();
            return;
          }
          loader.load(
            OUTDOOR_GLB_URLS[assetId],
            (gltf) => {
              try {
                const tpl = compileOutdoorAsset(assetId, gltf.scene, false);
                assetCache.set(assetId, tpl);
                failedAssets.delete(assetId);
              } catch (err) {
                console.warn(
                  `[OutdoorAssetRegistry] '${assetId}' GLB tahlilida xato, procedural fallback ishlatiladi:`,
                  err,
                );
                failedAssets.add(assetId);
                assetCache.set(assetId, getOrCreateFallbackTemplate(assetId));
              }
              resolve();
            },
            undefined,
            (err) => {
              console.warn(
                `[OutdoorAssetRegistry] '${OUTDOOR_GLB_URLS[assetId]}' yuklanmadi, procedural fallback ishlatiladi:`,
                err,
              );
              failedAssets.add(assetId);
              assetCache.set(assetId, getOrCreateFallbackTemplate(assetId));
              resolve();
            },
          );
        }),
    ),
  ).then(() => {
    notifyReadyListeners();
  });

  return preloadPromise;
}

/**
 * Subscribes a callback that fires when outdoor assets finish loading (or whenever new GLBs
 * are registered via `registerOutdoorAssetFromObject`). Returns an unsubscribe function.
 */
export function onOutdoorAssetsReady(cb: () => void): () => void {
  readyListeners.add(cb);
  if (areAllOutdoorAssetsLoaded()) {
    try {
      cb();
    } catch (e) {
      console.warn('[OutdoorAssetRegistry] listener error:', e);
    }
  }
  return () => {
    readyListeners.delete(cb);
  };
}

/**
 * Returns the cached `CachedOutdoorAssetTemplate` for `assetId`, or its synchronous
 * procedural fallback if async GLB loading has not completed yet.
 */
export function getCachedOutdoorAsset(assetId: OutdoorAssetId): CachedOutdoorAssetTemplate {
  const cached = assetCache.get(assetId);
  if (cached) return cached;
  return getOrCreateFallbackTemplate(assetId);
}

/**
 * Returns `true` when all 8 `OutdoorAssetId`s have non-fallback GLB templates registered.
 */
export function areAllOutdoorAssetsLoaded(): boolean {
  for (const id of OUTDOOR_ASSET_IDS) {
    const tpl = assetCache.get(id);
    if (!tpl || tpl.isFallback) {
      return false;
    }
  }
  return true;
}

export function hasOutdoorAssetFailed(assetId: OutdoorAssetId): boolean {
  return failedAssets.has(assetId);
}

/**
 * Returns detailed per-asset diagnostics across all 8 `OUTDOOR-ASSET-01` models.
 */
export function getOutdoorAssetDiagnostics(): Record<OutdoorAssetId, OutdoorAssetDiagnosticEntry> {
  const out = {} as Record<OutdoorAssetId, OutdoorAssetDiagnosticEntry>;
  for (const id of OUTDOOR_ASSET_IDS) {
    const loadedTpl = assetCache.get(id);
    const tpl = loadedTpl ?? getOrCreateFallbackTemplate(id);
    const manifest = OUTDOOR_ASSET_MANIFEST[id];
    out[id] = {
      assetId: id,
      code: manifest.code,
      url: manifest.glbUrl,
      category: manifest.category,
      loaded: Boolean(loadedTpl && !loadedTpl.isFallback),
      failed: failedAssets.has(id),
      isFallback: tpl.isFallback,
      triangles: tpl.triangles,
      expectedTriangles: manifest.expectedTriangles,
      trianglesMatch: tpl.triangles === manifest.expectedTriangles,
      vertices: tpl.vertices,
      expectedVertices: manifest.expectedVertices,
      meshNames: [...tpl.meshNames],
      subMeshCount: tpl.subMeshes.length,
      materialsUsed: [...tpl.materialsUsed],
      materialNames: [...tpl.materialNames],
      hasVertexColors: tpl.hasVertexColors,
      noCamerasOrLights: tpl.noCamerasOrLights,
      boundsMin: [...tpl.boundsMin],
      boundsMax: [...tpl.boundsMax],
      dimensions: [...tpl.size],
      size: [...tpl.size],
      signAnchors: tpl.signAnchors ? { ...tpl.signAnchors } : null,
      signAnchorDiagnostics: [...tpl.signAnchorDiagnostics],
      fireAnchor: tpl.fireAnchor ? [...tpl.fireAnchor] : null,
      fireAnchorDiagnostic: tpl.fireAnchorDiagnostic ? { ...tpl.fireAnchorDiagnostic } : null,
      hasRailingPostStart: tpl.hasRailingPostStart,
    };
  }
  return out;
}
