import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  CONTAINER_ASSET_IDS,
  CONTAINER_GLB_URLS,
  type ContainerAssetId,
  type ContainerVisualPlacement,
  type ItemAnchorSpec,
  type LocalBoxSpec,
  type PivotSpec,
  type Stage04AMaterialName,
} from '../../../shared/structures/contracts';
import type { ContainerKind } from '../../../shared/world';
import {
  deduplicateStage04AGltfMaterials,
  getStage04ASharedMaterial,
  resolveStage04AMaterialName,
} from '../Stage04ASharedMaterials';

export {
  CONTAINER_ASSET_IDS,
  CONTAINER_GLB_URLS,
  type ContainerAssetId,
  type ContainerVisualPlacement,
  type PivotSpec,
};

export const CONTAINER_KIND_TO_ASSET_ID: Record<ContainerKind, ContainerAssetId> = {
  supply_crate: 'wooden_loot_crate_01',
  camp_chest: 'wooden_loot_crate_01',
  weapon_locker: 'metal_locker_01',
  ammo_box: 'old_toolbox_01',
};

export function resolveContainerAssetId(idOrKind: string): ContainerAssetId {
  const normalized = idOrKind.trim().toLowerCase();
  if (normalized === 'wooden_loot_crate_01' || normalized === 'supply_crate' || normalized === 'camp_chest' || normalized === 'crate') {
    return 'wooden_loot_crate_01';
  }
  if (normalized === 'metal_locker_01' || normalized === 'weapon_locker' || normalized === 'locker') {
    return 'metal_locker_01';
  }
  if (normalized === 'old_toolbox_01' || normalized === 'ammo_box' || normalized === 'toolbox') {
    return 'old_toolbox_01';
  }
  return 'wooden_loot_crate_01';
}

export const CONTAINER_PIVOT_SPECS: Record<ContainerAssetId, PivotSpec> = {
  wooden_loot_crate_01: {
    name: 'lid_pivot',
    position: [0, 0.46, -0.3],
    axis: 'x',
    closedAngleRad: 0,
    openAngleRad: -1.92,
    openAngleDeg: -110,
    movingMeshes: ['crate_lid', 'crate_lid_metal'],
    collider: {
      name: 'movingPart',
      center: [0, 0.07, 0.3],
      size: [0.9, 0.14, 0.6],
    },
  },
  metal_locker_01: {
    name: 'door_pivot',
    position: [-0.43, 0, 0.25],
    axis: 'y',
    closedAngleRad: 0,
    openAngleRad: -1.75,
    openAngleDeg: -100,
    movingMeshes: ['locker_door', 'locker_door_hardware'],
    collider: {
      name: 'movingPart',
      center: [0.43, 0.925, 0.0145],
      size: [0.85, 1.69, 0.03],
    },
  },
  old_toolbox_01: {
    name: 'lid_pivot',
    position: [0, 0.2, -0.15],
    axis: 'x',
    closedAngleRad: 0,
    openAngleRad: -1.92,
    openAngleDeg: -110,
    movingMeshes: ['toolbox_lid', 'toolbox_lid_metal'],
    collider: {
      name: 'movingPart',
      center: [0, 0.05, 0.15],
      size: [0.6, 0.1, 0.3],
    },
  },
};

export interface ContainerAssetManifestSpec {
  assetId: ContainerAssetId;
  dimensions: [number, number, number];
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  expectedTriangles: number;
  expectedMaterials: Stage04AMaterialName[];
  staticMeshes: string[];
  movingMeshes: string[];
  pivot: PivotSpec;
  colliders: {
    staticBody: LocalBoxSpec;
    movingPart: LocalBoxSpec;
    simpleClosed: LocalBoxSpec;
  };
  interaction: {
    sphereCenter: [number, number, number];
    sphereRadius: number;
    recommendedMaxDistanceFromBounds: number;
  };
  interiorVolume: {
    center: [number, number, number];
    size: [number, number, number];
  };
  itemAnchors: ItemAnchorSpec[];
}

export const CONTAINER_ASSET_MANIFEST: Record<ContainerAssetId, ContainerAssetManifestSpec> = {
  wooden_loot_crate_01: {
    assetId: 'wooden_loot_crate_01',
    dimensions: [1.005, 0.606, 0.646],
    boundsMin: [-0.502, 0, -0.317],
    boundsMax: [0.502, 0.606, 0.328],
    expectedTriangles: 1140,
    expectedMaterials: ['wood', 'iron'],
    staticMeshes: ['crate_body', 'crate_body_metal'],
    movingMeshes: ['crate_lid', 'crate_lid_metal'],
    pivot: CONTAINER_PIVOT_SPECS.wooden_loot_crate_01,
    colliders: {
      staticBody: { name: 'staticBody', center: [0, 0.23, 0], size: [0.9, 0.46, 0.6] },
      movingPart: { name: 'movingPart', center: [0, 0.07, 0.3], size: [0.9, 0.14, 0.6] },
      simpleClosed: { name: 'simpleClosed', center: [0, 0.3, 0], size: [0.9, 0.6, 0.6] },
    },
    interaction: {
      sphereCenter: [0, 0.303, 0.005],
      sphereRadius: 1.87,
      recommendedMaxDistanceFromBounds: 1.5,
    },
    interiorVolume: {
      center: [0, 0.265, 0],
      size: [0.82, 0.39, 0.52],
    },
    itemAnchors: [
      {
        name: 'crate_floor_left',
        position: [-0.22, 0.07, 0],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'crate_floor_right',
        position: [0.22, 0.07, 0],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
    ],
  },
  metal_locker_01: {
    assetId: 'metal_locker_01',
    dimensions: [0.91, 1.8, 0.56],
    boundsMin: [-0.455, 0, -0.255],
    boundsMax: [0.455, 1.8, 0.305],
    expectedTriangles: 1406,
    expectedMaterials: ['painted_metal', 'iron'],
    staticMeshes: ['locker_body', 'locker_body_metal'],
    movingMeshes: ['locker_door', 'locker_door_hardware'],
    pivot: CONTAINER_PIVOT_SPECS.metal_locker_01,
    colliders: {
      staticBody: { name: 'staticBody', center: [0, 0.9, 0], size: [0.9, 1.8, 0.5] },
      movingPart: { name: 'movingPart', center: [0.43, 0.925, 0.0145], size: [0.85, 1.69, 0.03] },
      simpleClosed: { name: 'simpleClosed', center: [0, 0.9, 0], size: [0.9, 1.8, 0.5] },
    },
    interaction: {
      sphereCenter: [0, 0.9, 0.025],
      sphereRadius: 2.247,
      recommendedMaxDistanceFromBounds: 1.5,
    },
    interiorVolume: {
      center: [0, 0.925, -0.01],
      size: [0.84, 1.57, 0.44],
    },
    itemAnchors: [
      {
        name: 'locker_shelf_bottom',
        position: [0, 0.09, -0.01],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'locker_shelf_1',
        position: [0, 0.5575, -0.01],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'locker_shelf_2',
        position: [0, 1.0075, -0.01],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'locker_shelf_3',
        position: [0, 1.4575, -0.01],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
    ],
  },
  old_toolbox_01: {
    assetId: 'old_toolbox_01',
    dimensions: [0.607, 0.3, 0.319],
    boundsMin: [-0.303, 0, -0.157],
    boundsMax: [0.303, 0.3, 0.162],
    expectedTriangles: 926,
    expectedMaterials: ['painted_metal', 'iron'],
    staticMeshes: ['toolbox_body', 'toolbox_body_metal'],
    movingMeshes: ['toolbox_lid', 'toolbox_lid_metal'],
    pivot: CONTAINER_PIVOT_SPECS.old_toolbox_01,
    colliders: {
      staticBody: { name: 'staticBody', center: [0, 0.1, 0], size: [0.6, 0.2, 0.3] },
      movingPart: { name: 'movingPart', center: [0, 0.05, 0.15], size: [0.6, 0.1, 0.3] },
      simpleClosed: { name: 'simpleClosed', center: [0, 0.15, 0], size: [0.6, 0.3, 0.3] },
    },
    interaction: {
      sphereCenter: [0, 0.15, 0.002],
      sphereRadius: 1.574,
      recommendedMaxDistanceFromBounds: 1.5,
    },
    interiorVolume: {
      center: [0, 0.11, 0.065],
      size: [0.56, 0.17, 0.14],
    },
    itemAnchors: [
      {
        name: 'toolbox_front_bay',
        position: [0, 0.025, 0.065],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'toolbox_rear_tray',
        position: [0, 0.172, -0.07],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
    ],
  },
};

export interface ContainerPivotDiagnostics {
  pivotFound: boolean;
  pivotName: string;
  pivotPosition: [number, number, number];
  expectedPosition: [number, number, number];
  pivotPositionOK: boolean;
  axis: 'x' | 'y' | 'z';
  closedAngleRad: number;
  openAngleRad: number;
  openAngleDeg: number;
  movingMeshesFound: string[];
  staticMeshesFound: string[];
  movingDisplacement: number;
  staticUnchanged: boolean;
  opens: boolean;
}

export interface CachedContainerAssetTemplate {
  assetId: ContainerAssetId;
  url: string;
  scene: THREE.Group;
  templateScene: THREE.Group;
  bounds: THREE.Box3;
  dimensions: THREE.Vector3;
  triangles: number;
  meshNames: string[];
  staticMeshes: string[];
  movingMeshes: string[];
  materialsUsed: Stage04AMaterialName[];
  materialNames: Stage04AMaterialName[];
  hasVertexColors: boolean;
  noCamerasOrLights: boolean;
  pivot: PivotSpec;
  pivotSpec: PivotSpec;
  movingNode: PivotSpec;
  pivotDiagnostics: ContainerPivotDiagnostics;
  isFallback: boolean;
}

export interface ContainerAssetDiagnosticEntry {
  assetId: ContainerAssetId;
  loaded: boolean;
  failed: boolean;
  isFallback: boolean;
  url: string;
  triangles: number;
  dimensions: [number, number, number];
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  materialsUsed: Stage04AMaterialName[];
  materialNames: Stage04AMaterialName[];
  hasVertexColors: boolean;
  noCamerasOrLights: boolean;
  meshNames: string[];
  staticMeshes: string[];
  movingMeshes: string[];
  pivotFound: boolean;
  pivotName: string;
  pivotPosition: [number, number, number];
  pivotPositionOK: boolean;
  axis: 'x' | 'y' | 'z';
  openAngleRad: number;
  movingDisplacement: number;
  staticUnchanged: boolean;
  opens: boolean;
  pivot: PivotSpec;
}

export interface InstantiatedContainerHierarchy {
  assetId: ContainerAssetId;
  root: THREE.Group;
  pivotNode: THREE.Object3D;
  pivotSpec: PivotSpec;
  staticMeshes: THREE.Mesh[];
  movingMeshes: THREE.Mesh[];
  isFallback: boolean;
}

const assetCache = new Map<ContainerAssetId, CachedContainerAssetTemplate>();
const fallbackCache = new Map<ContainerAssetId, CachedContainerAssetTemplate>();
const failedAssets = new Set<ContainerAssetId>();
let preloadPromise: Promise<void> | null = null;
const readyListeners = new Set<() => void>();

const q3 = (n: number): number => Math.round(n * 1000) / 1000;

function countGeoTriangles(geo: THREE.BufferGeometry | undefined | null): number {
  if (!geo) return 0;
  const idx = geo.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.round(pos.count / 3) : 0;
}

function defaultColorForMaterial(
  assetId: ContainerAssetId,
  matName: Stage04AMaterialName,
): [number, number, number] {
  if (matName === 'iron') {
    return [0.27, 0.29, 0.31];
  }
  if (matName === 'painted_metal') {
    if (assetId === 'old_toolbox_01') {
      // Weathered red/rust painted toolbox
      return [0.58, 0.21, 0.18];
    }
    // Olive/slate industrial metal locker
    return [0.31, 0.38, 0.35];
  }
  // Warm crate wood
  return [0.55, 0.38, 0.22];
}

function ensureRgbVertexColors(
  geo: THREE.BufferGeometry,
  assetId: ContainerAssetId,
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

  const [cr, cg, cb] = defaultColorForMaterial(assetId, matName);
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
  assetId: ContainerAssetId,
  matName: Stage04AMaterialName,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  if (cx !== 0 || cy !== 0 || cz !== 0) {
    geo.translate(cx, cy, cz);
  }
  ensureRgbVertexColors(geo, assetId, matName);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.sharedAsset = true;
  return geo;
}

function createFallbackMesh(
  name: string,
  geo: THREE.BufferGeometry,
  matName: Stage04AMaterialName,
): THREE.Mesh {
  const mat = getStage04ASharedMaterial(matName);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.sharedAsset = true;
  return mesh;
}

function isPositionNear(
  actual: THREE.Vector3,
  expected: [number, number, number],
  tolerance = 0.025,
): boolean {
  return (
    Math.abs(actual.x - expected[0]) <= tolerance &&
    Math.abs(actual.y - expected[1]) <= tolerance &&
    Math.abs(actual.z - expected[2]) <= tolerance
  );
}

/**
 * Builds a deterministic procedural fallback hierarchy matching `LOOT-ASSET-01/README.md`
 * and `loot_asset_manifest.json` (`crate_body` / `crate_body_metal`, `locker_body` / `locker_body_metal`,
 * `toolbox_body` / `toolbox_body_metal` static meshes and `lid_pivot` / `door_pivot` moving nodes).
 * Used cleanly in Node/test (`typeof window === 'undefined'`) or before GLB loading finishes.
 */
export function buildProceduralContainerFallback(assetId: ContainerAssetId): THREE.Group {
  const root = new THREE.Group();
  root.name = assetId;
  root.userData.sharedAsset = true;

  switch (assetId) {
    case 'wooden_loot_crate_01': {
      // Static body: 1.005 x 0.46 x 0.646 base
      const bodyGeo = createColoredBoxGeometry(
        0.96,
        0.46,
        0.6,
        0,
        0.23,
        0,
        assetId,
        'wood',
      );
      const bodyMetalGeo = createColoredBoxGeometry(
        1.005,
        0.44,
        0.634,
        0,
        0.22,
        0,
        assetId,
        'iron',
      );
      root.add(
        createFallbackMesh('crate_body', bodyGeo, 'wood'),
        createFallbackMesh('crate_body_metal', bodyMetalGeo, 'iron'),
      );

      // Moving lid pivot at (0, 0.46, -0.30), axis 'x', openAngleRad = -1.92
      const lidPivot = new THREE.Group();
      lidPivot.name = 'lid_pivot';
      lidPivot.position.set(0, 0.46, -0.3);
      lidPivot.userData.sharedAsset = true;

      const lidGeo = createColoredBoxGeometry(
        0.96,
        0.14,
        0.6,
        0,
        0.07,
        0.3,
        assetId,
        'wood',
      );
      const lidMetalGeo = createColoredBoxGeometry(
        1.005,
        0.146,
        0.645,
        0,
        0.073,
        0.305,
        assetId,
        'iron',
      );
      lidPivot.add(
        createFallbackMesh('crate_lid', lidGeo, 'wood'),
        createFallbackMesh('crate_lid_metal', lidMetalGeo, 'iron'),
      );
      root.add(lidPivot);
      break;
    }

    case 'metal_locker_01': {
      // Static body: 0.91 x 1.80 x 0.56 cabinet
      const bodyGeo = createColoredBoxGeometry(
        0.9,
        1.8,
        0.5,
        0,
        0.9,
        0,
        assetId,
        'painted_metal',
      );
      const bodyMetalGeo = createColoredBoxGeometry(
        0.91,
        1.8,
        0.51,
        0,
        0.9,
        0,
        assetId,
        'iron',
      );
      root.add(
        createFallbackMesh('locker_body', bodyGeo, 'painted_metal'),
        createFallbackMesh('locker_body_metal', bodyMetalGeo, 'iron'),
      );

      // Moving door pivot at (-0.43, 0, 0.25), axis 'y', openAngleRad = -1.75
      const doorPivot = new THREE.Group();
      doorPivot.name = 'door_pivot';
      doorPivot.position.set(-0.43, 0, 0.25);
      doorPivot.userData.sharedAsset = true;

      const doorGeo = createColoredBoxGeometry(
        0.85,
        1.69,
        0.03,
        0.43,
        0.925,
        0.0145,
        assetId,
        'painted_metal',
      );
      const doorHwGeo = createColoredBoxGeometry(
        0.06,
        0.18,
        0.04,
        0.78,
        0.95,
        0.035,
        assetId,
        'iron',
      );
      doorPivot.add(
        createFallbackMesh('locker_door', doorGeo, 'painted_metal'),
        createFallbackMesh('locker_door_hardware', doorHwGeo, 'iron'),
      );
      root.add(doorPivot);
      break;
    }

    case 'old_toolbox_01': {
      // Static body: 0.607 x 0.20 x 0.319 lower box
      const bodyGeo = createColoredBoxGeometry(
        0.6,
        0.2,
        0.3,
        0,
        0.1,
        0,
        assetId,
        'painted_metal',
      );
      const bodyMetalGeo = createColoredBoxGeometry(
        0.606,
        0.19,
        0.314,
        0,
        0.095,
        0,
        assetId,
        'iron',
      );
      root.add(
        createFallbackMesh('toolbox_body', bodyGeo, 'painted_metal'),
        createFallbackMesh('toolbox_body_metal', bodyMetalGeo, 'iron'),
      );

      // Moving lid pivot at (0, 0.20, -0.15), axis 'x', openAngleRad = -1.92
      const lidPivot = new THREE.Group();
      lidPivot.name = 'lid_pivot';
      lidPivot.position.set(0, 0.2, -0.15);
      lidPivot.userData.sharedAsset = true;

      const lidGeo = createColoredBoxGeometry(
        0.6,
        0.1,
        0.3,
        0,
        0.05,
        0.15,
        assetId,
        'painted_metal',
      );
      const lidMetalGeo = createColoredBoxGeometry(
        0.606,
        0.1,
        0.312,
        0,
        0.05,
        0.156,
        assetId,
        'iron',
      );
      lidPivot.add(
        createFallbackMesh('toolbox_lid', lidGeo, 'painted_metal'),
        createFallbackMesh('toolbox_lid_metal', lidMetalGeo, 'iron'),
      );
      root.add(lidPivot);
      break;
    }
  }

  deduplicateStage04AGltfMaterials(root);
  return root;
}

function computeMeshesWorldCenter(meshes: THREE.Mesh[], root: THREE.Object3D): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of meshes) {
    if (!m.geometry.boundingBox) {
      m.geometry.computeBoundingBox();
    }
    if (m.geometry.boundingBox) {
      const worldBox = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
      box.union(worldBox);
    }
  }
  return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
}

function isDescendantOf(obj: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = obj.parent;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Normalizes and verifies a loaded container GLB (or procedural fallback) scene:
 * - Calls `deduplicateStage04AGltfMaterials(scene)` so `wood`, `iron`, `painted_metal` are shared singletons
 * - Ensures `COLOR_0` vertex colors and `userData.sharedAsset = true` on all geometries and nodes
 * - Verifies static body meshes (`crate_body`/`crate_body_metal`, `locker_body`/`locker_body_metal`,
 *   `toolbox_body`/`toolbox_body_metal`) and the moving pivot node (`lid_pivot` / `door_pivot`)
 * - Measures pivot opening displacement and ensures static body remains unchanged when pivot rotates
 */
function compileContainerAsset(
  assetId: ContainerAssetId,
  rawScene: THREE.Object3D,
  isFallback = false,
): CachedContainerAssetTemplate {
  const manifest = CONTAINER_ASSET_MANIFEST[assetId];
  const expectedPivot = CONTAINER_PIVOT_SPECS[assetId];

  const scene = rawScene instanceof THREE.Group ? rawScene : new THREE.Group().add(rawScene);
  scene.name = assetId;
  scene.position.set(0, 0, 0);
  scene.rotation.set(0, 0, 0);
  scene.scale.set(1, 1, 1);

  const usedMaterials = deduplicateStage04AGltfMaterials(scene);

  let pivotNode = scene.getObjectByName(expectedPivot.name) ?? null;
  const pivotFound = Boolean(pivotNode);
  if (!pivotNode) {
    throw new Error(
      `[ContainerAssetRegistry] '${assetId}' ichida '${expectedPivot.name}' pivot tuguni topilmadi`,
    );
  }

  // Reset pivot to canonical closed rotation (0 rad) before measuring bounds
  pivotNode.rotation.set(0, 0, 0);

  let triangles = 0;
  let hasVertexColors = true;
  let noCamerasOrLights = true;
  const meshNames: string[] = [];
  const staticMeshesFound: string[] = [];
  const movingMeshesFound: string[] = [];
  const staticMeshObjs: THREE.Mesh[] = [];
  const movingMeshObjs: THREE.Mesh[] = [];

  scene.traverse((obj) => {
    obj.userData.sharedAsset = true;
    if (obj instanceof THREE.Camera || obj instanceof THREE.Light) {
      noCamerasOrLights = false;
    }
    if (obj instanceof THREE.Mesh && obj.geometry) {
      const mName = obj.name || 'mesh';
      meshNames.push(mName);
      triangles += countGeoTriangles(obj.geometry);

      const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const matName: Stage04AMaterialName =
        (mat?.userData?.stage04aMaterialName as Stage04AMaterialName | undefined) ??
        resolveStage04AMaterialName(mat?.name || mName);

      if (!ensureRgbVertexColors(obj.geometry, assetId, matName)) {
        hasVertexColors = false;
      }
      obj.geometry.userData.sharedAsset = true;

      if (isDescendantOf(obj, pivotNode!)) {
        movingMeshesFound.push(mName);
        movingMeshObjs.push(obj);
      } else {
        staticMeshesFound.push(mName);
        staticMeshObjs.push(obj);
      }
    }
  });

  if (meshNames.length === 0) {
    throw new Error(`[ContainerAssetRegistry] '${assetId}' ichida hech qanday mesh topilmadi`);
  }

  for (const reqStatic of manifest.staticMeshes) {
    if (!staticMeshesFound.includes(reqStatic)) {
      throw new Error(
        `[ContainerAssetRegistry] '${assetId}' ichida statik korpus meshi '${reqStatic}' topilmadi`,
      );
    }
  }
  for (const reqMoving of manifest.movingMeshes) {
    if (!movingMeshesFound.includes(reqMoving)) {
      throw new Error(
        `[ContainerAssetRegistry] '${assetId}' '${expectedPivot.name}' ichida harakatlanuvchi mesh '${reqMoving}' topilmadi`,
      );
    }
  }

  const pivotPosOK = isPositionNear(pivotNode.position, expectedPivot.position);
  if (!pivotPosOK) {
    throw new Error(
      `[ContainerAssetRegistry] '${assetId}' '${expectedPivot.name}' pozitsiyasi mos emas: ` +
        `actual=(${pivotNode.position.x.toFixed(3)}, ${pivotNode.position.y.toFixed(3)}, ${pivotNode.position.z.toFixed(3)}), ` +
        `expected=(${expectedPivot.position.join(', ')})`,
    );
  }

  // Measure closed bounds & verify opening pivot rotation moves lid/door without moving static body
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene);
  const dimensions = bounds.getSize(new THREE.Vector3());

  const closedMovingCenter = computeMeshesWorldCenter(movingMeshObjs, scene);
  const closedStaticCenter = computeMeshesWorldCenter(staticMeshObjs, scene);

  const axis = expectedPivot.axis;
  pivotNode.rotation[axis] = expectedPivot.openAngleRad;
  const openMovingCenter = computeMeshesWorldCenter(movingMeshObjs, scene);
  const openStaticCenter = computeMeshesWorldCenter(staticMeshObjs, scene);

  // Restore canonical closed state on cached template
  pivotNode.rotation.set(0, 0, 0);
  scene.updateMatrixWorld(true);

  const movingDisplacement = q3(closedMovingCenter.distanceTo(openMovingCenter));
  const staticDrift = closedStaticCenter.distanceTo(openStaticCenter);
  const staticUnchanged = staticDrift < 1e-4;
  const opens = movingDisplacement > 0.1 && staticUnchanged;

  const actualPivotPos: [number, number, number] = [
    q3(pivotNode.position.x),
    q3(pivotNode.position.y),
    q3(pivotNode.position.z),
  ];

  const pivotSpec: PivotSpec = {
    ...expectedPivot,
    position: actualPivotPos,
    movingMeshes: [...movingMeshesFound],
  };

  const pivotDiagnostics: ContainerPivotDiagnostics = {
    pivotFound,
    pivotName: expectedPivot.name,
    pivotPosition: actualPivotPos,
    expectedPosition: [...expectedPivot.position],
    pivotPositionOK: pivotPosOK,
    axis: expectedPivot.axis,
    closedAngleRad: expectedPivot.closedAngleRad,
    openAngleRad: expectedPivot.openAngleRad,
    openAngleDeg: expectedPivot.openAngleDeg,
    movingMeshesFound: [...movingMeshesFound],
    staticMeshesFound: [...staticMeshesFound],
    movingDisplacement,
    staticUnchanged,
    opens,
  };

  const materialsArray = Array.from(usedMaterials);

  return {
    assetId,
    url: CONTAINER_GLB_URLS[assetId],
    scene,
    templateScene: scene,
    bounds,
    dimensions,
    triangles,
    meshNames,
    staticMeshes: [...staticMeshesFound],
    movingMeshes: [...movingMeshesFound],
    materialsUsed: materialsArray,
    materialNames: materialsArray,
    hasVertexColors,
    noCamerasOrLights,
    pivot: pivotSpec,
    pivotSpec,
    movingNode: pivotSpec,
    pivotDiagnostics,
    isFallback,
  };
}

function getOrCreateFallbackTemplate(assetId: ContainerAssetId): CachedContainerAssetTemplate {
  let tpl = fallbackCache.get(assetId);
  if (!tpl) {
    const group = buildProceduralContainerFallback(assetId);
    tpl = compileContainerAsset(assetId, group, true);
    fallbackCache.set(assetId, tpl);
  }
  return tpl;
}

function notifyReadyListeners(): void {
  for (const cb of readyListeners) {
    try {
      cb();
    } catch (e) {
      console.warn('[ContainerAssetRegistry] ready listener xatosi:', e);
    }
  }
}

/**
 * Singleton GLB loot container asset loader & cache.
 * Loads all 3 container GLB models (`wooden_loot_crate_01`, `metal_locker_01`, `old_toolbox_01`)
 * once via `GLTFLoader`, deduplicates materials onto `Stage04ASharedMaterials` (`wood`, `iron`, `painted_metal`),
 * verifies static body meshes and `lid_pivot` / `door_pivot` nodes, and notifies listeners when ready.
 * In Node/test (`typeof window === 'undefined'`), prepares procedural fallback hierarchies cleanly.
 */
export function preloadContainerAssets(): Promise<void> {
  if (preloadPromise) return preloadPromise;

  if (typeof window === 'undefined') {
    for (const assetId of CONTAINER_ASSET_IDS) {
      getOrCreateFallbackTemplate(assetId);
    }
    preloadPromise = Promise.resolve().then(() => {
      notifyReadyListeners();
    });
    return preloadPromise;
  }

  const loader = new GLTFLoader();
  preloadPromise = Promise.all(
    CONTAINER_ASSET_IDS.map(
      (assetId) =>
        new Promise<void>((resolve) => {
          const existing = assetCache.get(assetId);
          if (existing && !existing.isFallback) {
            resolve();
            return;
          }
          loader.load(
            CONTAINER_GLB_URLS[assetId],
            (gltf) => {
              try {
                const tpl = compileContainerAsset(assetId, gltf.scene, false);
                assetCache.set(assetId, tpl);
                failedAssets.delete(assetId);
              } catch (err) {
                console.warn(
                  `[ContainerAssetRegistry] '${assetId}' GLB tahlilida xato, procedural fallback ishlatiladi:`,
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
                `[ContainerAssetRegistry] '${CONTAINER_GLB_URLS[assetId]}' yuklanmadi, procedural fallback ishlatiladi:`,
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

export function areContainerAssetsReady(): boolean {
  if (assetCache.size === CONTAINER_ASSET_IDS.length) {
    return true;
  }
  if (typeof window === 'undefined' && fallbackCache.size === CONTAINER_ASSET_IDS.length) {
    return true;
  }
  return false;
}

export function onContainerAssetsReady(cb: () => void): () => void {
  if (assetCache.size === CONTAINER_ASSET_IDS.length) {
    cb();
    return () => {};
  }
  readyListeners.add(cb);
  return () => {
    readyListeners.delete(cb);
  };
}

/**
 * Returns the cached container asset template for `id`.
 * If called before async GLB loading completes or in Node/test (`typeof window === 'undefined'`),
 * returns the procedural fallback template with exact `lid_pivot` / `door_pivot` hierarchy.
 */
export function getCachedContainerAsset(id: ContainerAssetId): CachedContainerAssetTemplate {
  return assetCache.get(id) ?? getOrCreateFallbackTemplate(id);
}

export function hasContainerAssetFailed(id: ContainerAssetId): boolean {
  return failedAssets.has(id);
}

/**
 * Directly compiles and caches a parsed `THREE.Object3D` for a container asset
 * (useful in Node unit tests parsing GLBs from disk).
 */
export function registerContainerAssetFromObject(
  assetId: ContainerAssetId,
  sceneRoot: THREE.Object3D,
): CachedContainerAssetTemplate {
  const tpl = compileContainerAsset(assetId, sceneRoot, false);
  assetCache.set(assetId, tpl);
  failedAssets.delete(assetId);
  if (assetCache.size === CONTAINER_ASSET_IDS.length) {
    notifyReadyListeners();
  }
  return tpl;
}

/**
 * Clones an independent container instance hierarchy from the cached template (or procedural fallback).
 * Shares the singleton geometries (`userData.sharedAsset = true`) and `Stage04ASharedMaterials`
 * while giving each instance its own independent `lid_pivot` / `door_pivot` node for rotation.
 */
export function instantiateContainerAsset(assetId: ContainerAssetId): InstantiatedContainerHierarchy {
  const tpl = getCachedContainerAsset(assetId);
  const root = tpl.scene.clone(true);
  root.name = assetId;
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);

  const pivotNode = root.getObjectByName(tpl.pivot.name);
  if (!pivotNode) {
    throw new Error(
      `[ContainerAssetRegistry] '${assetId}' nusxasida '${tpl.pivot.name}' tuguni topilmadi`,
    );
  }
  pivotNode.rotation.set(0, 0, 0);

  const staticMeshes: THREE.Mesh[] = [];
  const movingMeshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    if (isDescendantOf(obj, pivotNode)) {
      movingMeshes.push(obj);
    } else {
      staticMeshes.push(obj);
    }
  });

  return {
    assetId,
    root,
    pivotNode,
    pivotSpec: tpl.pivot,
    staticMeshes,
    movingMeshes,
    isFallback: tpl.isFallback,
  };
}

export function getContainerAssetDiagnostics(): Record<ContainerAssetId, ContainerAssetDiagnosticEntry> {
  const out = {} as Record<ContainerAssetId, ContainerAssetDiagnosticEntry>;
  for (const id of CONTAINER_ASSET_IDS) {
    const loadedTpl = assetCache.get(id);
    const tpl = loadedTpl ?? getOrCreateFallbackTemplate(id);
    const pd = tpl.pivotDiagnostics;
    out[id] = {
      assetId: id,
      loaded: Boolean(loadedTpl && !loadedTpl.isFallback),
      failed: failedAssets.has(id),
      isFallback: tpl.isFallback,
      url: CONTAINER_GLB_URLS[id],
      triangles: tpl.triangles,
      dimensions: [q3(tpl.dimensions.x), q3(tpl.dimensions.y), q3(tpl.dimensions.z)],
      boundsMin: [q3(tpl.bounds.min.x), q3(tpl.bounds.min.y), q3(tpl.bounds.min.z)],
      boundsMax: [q3(tpl.bounds.max.x), q3(tpl.bounds.max.y), q3(tpl.bounds.max.z)],
      materialsUsed: [...tpl.materialsUsed],
      materialNames: [...tpl.materialNames],
      hasVertexColors: tpl.hasVertexColors,
      noCamerasOrLights: tpl.noCamerasOrLights,
      meshNames: [...tpl.meshNames],
      staticMeshes: [...tpl.staticMeshes],
      movingMeshes: [...tpl.movingMeshes],
      pivotFound: pd.pivotFound,
      pivotName: pd.pivotName,
      pivotPosition: [...pd.pivotPosition],
      pivotPositionOK: pd.pivotPositionOK,
      axis: pd.axis,
      openAngleRad: pd.openAngleRad,
      movingDisplacement: pd.movingDisplacement,
      staticUnchanged: pd.staticUnchanged,
      opens: pd.opens,
      pivot: tpl.pivot,
    };
  }
  return out;
}
