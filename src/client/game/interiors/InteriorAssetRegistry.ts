import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  INTERIOR_ASSET_IDS,
  INTERIOR_GLB_URLS,
  type AnchorSurfaceCategory,
  type InteriorAssetId,
  type ItemAnchorSpec,
  type LocalBoxSpec,
  type PivotSpec,
  type PlaceableSurfaceSpec,
  type Stage04AMaterialName,
} from '../../../shared/structures/contracts';
import {
  deduplicateStage04AGltfMaterials,
  getStage04ASharedMaterial,
} from '../Stage04ASharedMaterials';

export { INTERIOR_ASSET_IDS, INTERIOR_GLB_URLS, type InteriorAssetId };

export const KITCHEN_CABINET_LEFT_PIVOT_NAME = 'door_left_pivot';
export const KITCHEN_CABINET_RIGHT_PIVOT_NAME = 'door_right_pivot';
export const KITCHEN_CABINET_LEFT_PIVOT_POS: [number, number, number] = [-0.585, 0, 0.255];
export const KITCHEN_CABINET_RIGHT_PIVOT_POS: [number, number, number] = [0.585, 0, 0.255];
export const KITCHEN_CABINET_LEFT_OPEN_ANGLE_RAD = -1.75;
export const KITCHEN_CABINET_RIGHT_OPEN_ANGLE_RAD = 1.75;

export interface InteriorAssetManifestSpec {
  assetId: InteriorAssetId;
  dimensions: [number, number, number];
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  expectedTriangles: number;
  expectedMaterials: Stage04AMaterialName[];
  staticMeshes: string[];
  movingMeshes: Record<string, string[]>;
  pivots: PivotSpec[];
  colliders: LocalBoxSpec[];
  simpleCollider: LocalBoxSpec;
  placeableSurfaces: PlaceableSurfaceSpec[];
  itemAnchors: ItemAnchorSpec[];
  cover?: {
    height: number;
    hideSide: '-Z';
    hideSpot: [number, number, number];
  };
}

export const INTERIOR_ASSET_MANIFEST: Record<InteriorAssetId, InteriorAssetManifestSpec> = {
  wooden_table_01: {
    assetId: 'wooden_table_01',
    dimensions: [1.408, 0.75, 0.796],
    boundsMin: [-0.704, 0, -0.398],
    boundsMax: [0.705, 0.75, 0.398],
    expectedTriangles: 288,
    expectedMaterials: ['wood'],
    staticMeshes: ['wooden_table_01_body'],
    movingMeshes: {},
    pivots: [],
    colliders: [
      { name: 'tabletop', center: [0, 0.73, 0], size: [1.4, 0.04, 0.8] },
      { name: 'legs_block', center: [0, 0.355, 0], size: [1.31, 0.71, 0.71] },
    ],
    simpleCollider: { name: 'simple', center: [0, 0.375, 0], size: [1.4, 0.75, 0.8] },
    placeableSurfaces: [
      { name: 'tabletop', y: 0.75, center: [0, 0.75, 0], size: [1.36, 0.76] },
    ],
    itemAnchors: [
      { name: 'anchor_0', position: [-0.45, 0.75, -0.2], up: [0, 1, 0], category: 'tabletop' },
      { name: 'anchor_1', position: [0, 0.75, -0.2], up: [0, 1, 0], category: 'tabletop' },
      { name: 'anchor_2', position: [0.45, 0.75, -0.2], up: [0, 1, 0], category: 'tabletop' },
      { name: 'anchor_3', position: [-0.45, 0.75, 0.2], up: [0, 1, 0], category: 'tabletop' },
      { name: 'anchor_4', position: [0, 0.75, 0.2], up: [0, 1, 0], category: 'tabletop' },
      { name: 'anchor_5', position: [0.45, 0.75, 0.2], up: [0, 1, 0], category: 'tabletop' },
    ],
  },
  wooden_chair_01: {
    assetId: 'wooden_chair_01',
    dimensions: [0.46, 0.899, 0.524],
    boundsMin: [-0.23, -0.002, -0.297],
    boundsMax: [0.23, 0.897, 0.227],
    expectedTriangles: 404,
    expectedMaterials: ['wood'],
    staticMeshes: ['wooden_chair_01_body'],
    movingMeshes: {},
    pivots: [],
    colliders: [
      { name: 'seat', center: [0, 0.235, 0], size: [0.46, 0.47, 0.46] },
      { name: 'backrest', center: [0, 0.68, -0.25], size: [0.46, 0.44, 0.06] },
    ],
    simpleCollider: { name: 'simple', center: [0, 0.45, -0.03], size: [0.47, 0.9, 0.53] },
    placeableSurfaces: [
      { name: 'seat', y: 0.47, center: [0, 0.47, 0], size: [0.42, 0.42] },
    ],
    itemAnchors: [
      { name: 'seat', position: [0, 0.47, 0.02], up: [0, 1, 0], category: 'chair_seat' },
    ],
  },
  wooden_shelf_01: {
    assetId: 'wooden_shelf_01',
    dimensions: [1.04, 1.803, 0.42],
    boundsMin: [-0.52, -0.003, -0.21],
    boundsMax: [0.52, 1.8, 0.21],
    expectedTriangles: 436,
    expectedMaterials: ['wood'],
    staticMeshes: ['wooden_shelf_01_body'],
    movingMeshes: {},
    pivots: [],
    colliders: [
      { name: 'body', center: [0, 0.9, 0], size: [1, 1.8, 0.4] },
    ],
    simpleCollider: { name: 'simple', center: [0, 0.9, 0], size: [1, 1.8, 0.4] },
    placeableSurfaces: [
      { name: 'shelf_1', y: 0.12, center: [0, 0.12, 0.01], size: [0.92, 0.34], clearHeight: 0.415 },
      { name: 'shelf_2', y: 0.56, center: [0, 0.56, 0.01], size: [0.92, 0.34], clearHeight: 0.415 },
      { name: 'shelf_3', y: 1, center: [0, 1, 0.01], size: [0.92, 0.34], clearHeight: 0.415 },
      { name: 'shelf_4', y: 1.44, center: [0, 1.44, 0.01], size: [0.92, 0.34], clearHeight: 0.33 },
      { name: 'top', y: 1.8, center: [0, 1.8, 0], size: [1, 0.4] },
    ],
    itemAnchors: [
      { name: 'shelf_1_1', position: [-0.3, 0.12, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_1_2', position: [0, 0.12, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_1_3', position: [0.3, 0.12, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_2_1', position: [-0.3, 0.56, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_2_2', position: [0, 0.56, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_2_3', position: [0.3, 0.56, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_3_1', position: [-0.3, 1, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_3_2', position: [0, 1, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_3_3', position: [0.3, 1, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_4_1', position: [-0.3, 1.44, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_4_2', position: [0, 1.44, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_4_3', position: [0.3, 1.44, 0.01], up: [0, 1, 0], category: 'shelf' },
    ],
  },
  old_bed_01: {
    assetId: 'old_bed_01',
    dimensions: [2.02, 0.65, 0.97],
    boundsMin: [-1.01, 0, -0.485],
    boundsMax: [1.01, 0.65, 0.485],
    expectedTriangles: 838,
    expectedMaterials: ['wood', 'fabric'],
    staticMeshes: ['old_bed_01_frame', 'old_bed_01_fabric'],
    movingMeshes: {},
    pivots: [],
    colliders: [
      { name: 'frame_mattress', center: [0, 0.23, 0], size: [2, 0.46, 0.95] },
      { name: 'headboard', center: [0.965, 0.555, 0], size: [0.09, 0.19, 0.95] },
    ],
    simpleCollider: { name: 'simple', center: [0, 0.325, 0], size: [2, 0.65, 0.95] },
    placeableSurfaces: [
      { name: 'mattress', y: 0.46, center: [-0.1, 0.46, 0], size: [1.6, 0.8] },
    ],
    itemAnchors: [
      { name: 'mattress', position: [-0.2, 0.46, 0], up: [0, 1, 0], category: 'mattress' },
      { name: 'under_bed', position: [0, 0, 0], up: [0, 1, 0], category: 'under_bed' },
    ],
  },
  old_sofa_01: {
    assetId: 'old_sofa_01',
    dimensions: [1.7, 0.902, 0.8],
    boundsMin: [-0.85, 0, -0.4],
    boundsMax: [0.85, 0.902, 0.4],
    expectedTriangles: 958,
    expectedMaterials: ['wood', 'fabric'],
    staticMeshes: ['old_sofa_01_legs', 'old_sofa_01_fabric'],
    movingMeshes: {},
    pivots: [],
    colliders: [
      { name: 'seat', center: [0, 0.25, 0.01], size: [1.7, 0.5, 0.78] },
      { name: 'back', center: [0, 0.62, -0.31], size: [1.7, 0.52, 0.18] },
    ],
    simpleCollider: { name: 'simple', center: [0, 0.45, 0], size: [1.7, 0.9, 0.8] },
    placeableSurfaces: [
      { name: 'seat', y: 0.5, center: [0, 0.5, 0.08], size: [1.3, 0.5] },
    ],
    itemAnchors: [
      { name: 'seat_left', position: [-0.33, 0.5, 0.1], up: [0, 1, 0], category: 'sofa_seat' },
      { name: 'seat_right', position: [0.33, 0.5, 0.1], up: [0, 1, 0], category: 'sofa_seat' },
    ],
    cover: {
      height: 0.88,
      hideSide: '-Z',
      hideSpot: [0, 0, -0.7],
    },
  },
  kitchen_cabinet_01: {
    assetId: 'kitchen_cabinet_01',
    dimensions: [1.24, 0.903, 0.575],
    boundsMin: [-0.62, -0.003, -0.278],
    boundsMax: [0.62, 0.9, 0.297],
    expectedTriangles: 688,
    expectedMaterials: ['wood', 'iron'],
    staticMeshes: ['kitchen_cabinet_01_body'],
    movingMeshes: {
      door_left_pivot: ['door_left', 'door_left_hardware'],
      door_right_pivot: ['door_right', 'door_right_hardware'],
    },
    pivots: [
      {
        name: KITCHEN_CABINET_LEFT_PIVOT_NAME,
        position: KITCHEN_CABINET_LEFT_PIVOT_POS,
        axis: 'y',
        closedAngleRad: 0,
        openAngleRad: KITCHEN_CABINET_LEFT_OPEN_ANGLE_RAD,
        openAngleDeg: -100,
        movingMeshes: ['door_left', 'door_left_hardware'],
        collider: { name: 'door_left_collider', center: [0.285, 0.47, 0], size: [0.57, 0.72, 0.02] },
      },
      {
        name: KITCHEN_CABINET_RIGHT_PIVOT_NAME,
        position: KITCHEN_CABINET_RIGHT_PIVOT_POS,
        axis: 'y',
        closedAngleRad: 0,
        openAngleRad: KITCHEN_CABINET_RIGHT_OPEN_ANGLE_RAD,
        openAngleDeg: 100,
        movingMeshes: ['door_right', 'door_right_hardware'],
        collider: { name: 'door_right_collider', center: [-0.285, 0.47, 0], size: [0.57, 0.72, 0.02] },
      },
    ],
    colliders: [
      { name: 'body', center: [0, 0.45, 0], size: [1.2, 0.9, 0.55] },
    ],
    simpleCollider: { name: 'simple', center: [0, 0.45, 0], size: [1.2, 0.9, 0.55] },
    placeableSurfaces: [
      { name: 'countertop', y: 0.9, center: [0, 0.9, 0], size: [1.2, 0.52] },
      { name: 'inside_bottom', y: 0.1, center: [0, 0.1, -0.02], size: [1.14, 0.46], requiresOpenDoorOrLid: true },
      { name: 'inside_shelf', y: 0.479, center: [0, 0.479, -0.04], size: [1.14, 0.42], requiresOpenDoorOrLid: true },
    ],
    itemAnchors: [
      { name: 'countertop_1', position: [-0.4, 0.9, 0], up: [0, 1, 0], category: 'countertop' },
      { name: 'countertop_2', position: [0, 0.9, 0], up: [0, 1, 0], category: 'countertop' },
      { name: 'countertop_3', position: [0.4, 0.9, 0], up: [0, 1, 0], category: 'countertop' },
      {
        name: 'inside_bottom_1',
        position: [-0.29, 0.1, -0.03],
        up: [0, 1, 0],
        category: 'inside_cabinet',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'inside_bottom_2',
        position: [0.29, 0.1, -0.03],
        up: [0, 1, 0],
        category: 'inside_cabinet',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'inside_shelf_1',
        position: [-0.29, 0.479, -0.03],
        up: [0, 1, 0],
        category: 'inside_cabinet',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'inside_shelf_2',
        position: [0.29, 0.479, -0.03],
        up: [0, 1, 0],
        category: 'inside_cabinet',
        requiresOpenDoorOrLid: true,
      },
    ],
  },
};

export interface InteriorPivotDiagnostics {
  doorLeftPivotFound: boolean;
  doorRightPivotFound: boolean;
  doorLeftPivotPosition: [number, number, number] | null;
  doorRightPivotPosition: [number, number, number] | null;
  doorLeftPivotPositionOK: boolean;
  doorRightPivotPositionOK: boolean;
  doorLeftOpenAngleRad: number;
  doorRightOpenAngleRad: number;
}

export interface CachedInteriorAssetTemplate {
  assetId: InteriorAssetId;
  scene: THREE.Group;
  bounds: THREE.Box3;
  dimensions: THREE.Vector3;
  triangles: number;
  meshNames: string[];
  materialsUsed: Stage04AMaterialName[];
  hasVertexColors: boolean;
  noCamerasOrLights: boolean;
  pivots: InteriorPivotDiagnostics;
  isFallback: boolean;
}

const assetCache = new Map<InteriorAssetId, CachedInteriorAssetTemplate>();
const fallbackCache = new Map<InteriorAssetId, CachedInteriorAssetTemplate>();
const failedAssets = new Set<InteriorAssetId>();
let preloadPromise: Promise<void> | null = null;
const readyListeners = new Set<() => void>();

function createColoredBoxGeometry(
  width: number,
  height: number,
  depth: number,
  hexColor: string,
  translate: [number, number, number] = [0, 0, 0],
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(width, height, depth);
  if (translate[0] !== 0 || translate[1] !== 0 || translate[2] !== 0) {
    geo.translate(translate[0], translate[1], translate[2]);
  }
  const pos = geo.getAttribute('position');
  const col = new THREE.Color(hexColor);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.sharedAsset = true;
  return geo;
}

function createFallbackMesh(
  name: string,
  geo: THREE.BufferGeometry,
  materialName: Stage04AMaterialName,
): THREE.Mesh {
  const mat = getStage04ASharedMaterial(materialName);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.sharedAsset = true;
  return mesh;
}

/**
 * Builds a deterministic procedural fallback hierarchy matching the exact node names,
 * materials (`wood`, `iron`, `fabric`), `COLOR_0` vertex colors, and pivot positions
 * (`door_left_pivot` at `(-0.585, 0, 0.255)` and `door_right_pivot` at `(0.585, 0, 0.255)`)
 * required when running in Node/test (`typeof window === 'undefined'`) or before GLBs finish loading.
 */
export function buildProceduralInteriorFallback(assetId: InteriorAssetId): THREE.Group {
  const root = new THREE.Group();
  root.name = assetId;
  root.userData.sharedAsset = true;

  switch (assetId) {
    case 'wooden_table_01': {
      const geo = createColoredBoxGeometry(1.408, 0.75, 0.796, '#7a5233', [0, 0.375, 0]);
      root.add(createFallbackMesh('wooden_table_01_body', geo, 'wood'));
      break;
    }
    case 'wooden_chair_01': {
      const geo = createColoredBoxGeometry(0.46, 0.9, 0.524, '#754e2f', [0, 0.45, -0.035]);
      root.add(createFallbackMesh('wooden_chair_01_body', geo, 'wood'));
      break;
    }
    case 'wooden_shelf_01': {
      const geo = createColoredBoxGeometry(1.04, 1.8, 0.42, '#6e472b', [0, 0.9, 0]);
      root.add(createFallbackMesh('wooden_shelf_01_body', geo, 'wood'));
      break;
    }
    case 'old_bed_01': {
      const frameGeo = createColoredBoxGeometry(2.02, 0.65, 0.97, '#684328', [0, 0.325, 0]);
      const fabricGeo = createColoredBoxGeometry(1.86, 0.22, 0.9, '#8c8275', [-0.04, 0.35, 0]);
      root.add(createFallbackMesh('old_bed_01_frame', frameGeo, 'wood'));
      root.add(createFallbackMesh('old_bed_01_fabric', fabricGeo, 'fabric'));
      break;
    }
    case 'old_sofa_01': {
      const legsGeo = createColoredBoxGeometry(1.66, 0.16, 0.76, '#5e3c23', [0, 0.08, 0]);
      const fabricGeo = createColoredBoxGeometry(1.7, 0.76, 0.8, '#5a6351', [0, 0.52, 0]);
      root.add(createFallbackMesh('old_sofa_01_legs', legsGeo, 'wood'));
      root.add(createFallbackMesh('old_sofa_01_fabric', fabricGeo, 'fabric'));
      break;
    }
    case 'kitchen_cabinet_01': {
      const bodyGeo = createColoredBoxGeometry(1.24, 0.9, 0.55, '#734b2d', [0, 0.45, -0.01]);
      root.add(createFallbackMesh('kitchen_cabinet_01_body', bodyGeo, 'wood'));

      const leftPivot = new THREE.Group();
      leftPivot.name = KITCHEN_CABINET_LEFT_PIVOT_NAME;
      leftPivot.position.set(...KITCHEN_CABINET_LEFT_PIVOT_POS);
      leftPivot.userData.sharedAsset = true;

      const leftDoorGeo = createColoredBoxGeometry(0.57, 0.72, 0.02, '#805534', [0.285, 0.47, 0]);
      const leftHwGeo = createColoredBoxGeometry(0.03, 0.12, 0.025, '#3b3f42', [0.51, 0.47, 0.02]);
      leftPivot.add(createFallbackMesh('door_left', leftDoorGeo, 'wood'));
      leftPivot.add(createFallbackMesh('door_left_hardware', leftHwGeo, 'iron'));
      root.add(leftPivot);

      const rightPivot = new THREE.Group();
      rightPivot.name = KITCHEN_CABINET_RIGHT_PIVOT_NAME;
      rightPivot.position.set(...KITCHEN_CABINET_RIGHT_PIVOT_POS);
      rightPivot.userData.sharedAsset = true;

      const rightDoorGeo = createColoredBoxGeometry(0.57, 0.72, 0.02, '#805534', [-0.285, 0.47, 0]);
      const rightHwGeo = createColoredBoxGeometry(0.03, 0.12, 0.025, '#3b3f42', [-0.51, 0.47, 0.02]);
      rightPivot.add(createFallbackMesh('door_right', rightDoorGeo, 'wood'));
      rightPivot.add(createFallbackMesh('door_right_hardware', rightHwGeo, 'iron'));
      root.add(rightPivot);
      break;
    }
  }

  deduplicateStage04AGltfMaterials(root);
  return root;
}

function countGeoTriangles(geo: THREE.BufferGeometry | undefined): number {
  if (!geo) return 0;
  const idx = geo.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.round(pos.count / 3) : 0;
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

function compileInteriorAsset(
  assetId: InteriorAssetId,
  rawScene: THREE.Object3D,
  isFallback = false,
): CachedInteriorAssetTemplate {
  const scene = rawScene instanceof THREE.Group ? rawScene : new THREE.Group().add(rawScene);
  scene.name = assetId;

  const usedMaterials = deduplicateStage04AGltfMaterials(scene);

  let triangles = 0;
  let hasVertexColors = true;
  let meshCount = 0;
  let noCamerasOrLights = true;
  const meshNames: string[] = [];

  scene.traverse((obj) => {
    obj.userData.sharedAsset = true;
    if (obj instanceof THREE.Camera || obj instanceof THREE.Light) {
      noCamerasOrLights = false;
    }
    if (obj instanceof THREE.Mesh && obj.geometry) {
      meshCount++;
      meshNames.push(obj.name || 'mesh');
      triangles += countGeoTriangles(obj.geometry);
      if (!obj.geometry.getAttribute('color')) {
        hasVertexColors = false;
      }
    }
  });

  if (meshCount === 0) {
    throw new Error(`[InteriorAssetRegistry] '${assetId}' ichida hech qanday mesh topilmadi`);
  }

  let pivots: InteriorPivotDiagnostics = {
    doorLeftPivotFound: false,
    doorRightPivotFound: false,
    doorLeftPivotPosition: null,
    doorRightPivotPosition: null,
    doorLeftPivotPositionOK: true,
    doorRightPivotPositionOK: true,
    doorLeftOpenAngleRad: 0,
    doorRightOpenAngleRad: 0,
  };

  if (assetId === 'kitchen_cabinet_01') {
    const leftPivot = scene.getObjectByName(KITCHEN_CABINET_LEFT_PIVOT_NAME);
    const rightPivot = scene.getObjectByName(KITCHEN_CABINET_RIGHT_PIVOT_NAME);
    if (!leftPivot || !rightPivot) {
      throw new Error(
        `[InteriorAssetRegistry] 'kitchen_cabinet_01' ichida '${KITCHEN_CABINET_LEFT_PIVOT_NAME}' yoki '${KITCHEN_CABINET_RIGHT_PIVOT_NAME}' topilmadi`,
      );
    }
    const leftPosOK = isPositionNear(leftPivot.position, KITCHEN_CABINET_LEFT_PIVOT_POS);
    const rightPosOK = isPositionNear(rightPivot.position, KITCHEN_CABINET_RIGHT_PIVOT_POS);
    pivots = {
      doorLeftPivotFound: true,
      doorRightPivotFound: true,
      doorLeftPivotPosition: [
        Number(leftPivot.position.x.toFixed(4)),
        Number(leftPivot.position.y.toFixed(4)),
        Number(leftPivot.position.z.toFixed(4)),
      ],
      doorRightPivotPosition: [
        Number(rightPivot.position.x.toFixed(4)),
        Number(rightPivot.position.y.toFixed(4)),
        Number(rightPivot.position.z.toFixed(4)),
      ],
      doorLeftPivotPositionOK: leftPosOK,
      doorRightPivotPositionOK: rightPosOK,
      doorLeftOpenAngleRad: KITCHEN_CABINET_LEFT_OPEN_ANGLE_RAD,
      doorRightOpenAngleRad: KITCHEN_CABINET_RIGHT_OPEN_ANGLE_RAD,
    };
  }

  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene);
  const dimensions = bounds.getSize(new THREE.Vector3());

  return {
    assetId,
    scene,
    bounds,
    dimensions,
    triangles,
    meshNames,
    materialsUsed: [...usedMaterials],
    hasVertexColors,
    noCamerasOrLights,
    pivots,
    isFallback,
  };
}

function getOrCreateFallbackTemplate(assetId: InteriorAssetId): CachedInteriorAssetTemplate {
  let tpl = fallbackCache.get(assetId);
  if (!tpl) {
    const fallbackGroup = buildProceduralInteriorFallback(assetId);
    tpl = compileInteriorAsset(assetId, fallbackGroup, true);
    fallbackCache.set(assetId, tpl);
  }
  return tpl;
}

/**
 * Singleton GLB interior furniture loader & cache.
 * Loads all 6 interior furniture GLBs once via `GLTFLoader`, deduplicates materials via
 * `deduplicateStage04AGltfMaterials`, verifies `kitchen_cabinet_01` door pivots, and notifies listeners.
 * In Node/test (`typeof window === 'undefined'`), prepares procedural fallback templates cleanly.
 */
export function preloadInteriorAssets(): Promise<void> {
  if (preloadPromise) return preloadPromise;

  if (typeof window === 'undefined') {
    for (const assetId of INTERIOR_ASSET_IDS) {
      getOrCreateFallbackTemplate(assetId);
    }
    preloadPromise = Promise.resolve().then(() => {
      for (const cb of readyListeners) {
        try {
          cb();
        } catch (e) {
          console.warn('[InteriorAssetRegistry] listener error:', e);
        }
      }
    });
    return preloadPromise;
  }

  const loader = new GLTFLoader();
  preloadPromise = Promise.all(
    INTERIOR_ASSET_IDS.map(
      (assetId) =>
        new Promise<void>((resolve) => {
          const existing = assetCache.get(assetId);
          if (existing && !existing.isFallback) {
            resolve();
            return;
          }
          loader.load(
            INTERIOR_GLB_URLS[assetId],
            (gltf) => {
              try {
                const tpl = compileInteriorAsset(assetId, gltf.scene, false);
                assetCache.set(assetId, tpl);
                failedAssets.delete(assetId);
              } catch (err) {
                console.warn(
                  `[InteriorAssetRegistry] '${assetId}' GLB tahlilida xato, procedural fallback ishlatiladi:`,
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
                `[InteriorAssetRegistry] '${INTERIOR_GLB_URLS[assetId]}' yuklanmadi, procedural fallback ishlatiladi:`,
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
    for (const cb of readyListeners) {
      try {
        cb();
      } catch (e) {
        console.warn('[InteriorAssetRegistry] listener error:', e);
      }
    }
  });

  return preloadPromise;
}

export function areInteriorAssetsReady(): boolean {
  if (assetCache.size === INTERIOR_ASSET_IDS.length) {
    return true;
  }
  if (typeof window === 'undefined' && fallbackCache.size === INTERIOR_ASSET_IDS.length) {
    return true;
  }
  return false;
}

export function onInteriorAssetsReady(cb: () => void): () => void {
  if (assetCache.size === INTERIOR_ASSET_IDS.length) {
    cb();
    return () => {};
  }
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

/**
 * Returns the cached interior asset template for `id`.
 * If the GLB has not finished loading yet or when running in Node/test (`typeof window === 'undefined'`),
 * returns the procedural fallback template (with `door_left_pivot` and `door_right_pivot` on `kitchen_cabinet_01`).
 */
export function getCachedInteriorAsset(id: InteriorAssetId): CachedInteriorAssetTemplate {
  return assetCache.get(id) ?? getOrCreateFallbackTemplate(id);
}

export function hasInteriorAssetFailed(id: InteriorAssetId): boolean {
  return failedAssets.has(id);
}

/**
 * Directly compiles and caches a parsed `THREE.Object3D` for an interior furniture asset
 * (useful in Node unit tests parsing GLBs from disk).
 */
export function registerInteriorAssetFromObject(
  assetId: InteriorAssetId,
  sceneRoot: THREE.Object3D,
): CachedInteriorAssetTemplate {
  const tpl = compileInteriorAsset(assetId, sceneRoot, false);
  assetCache.set(assetId, tpl);
  failedAssets.delete(assetId);
  return tpl;
}

/**
 * Clones a furniture instance hierarchy from the cached template (or procedural fallback),
 * sharing the singleton geometries and `Stage04ASharedMaterials` (`wood`, `iron`, `fabric`).
 */
export function instantiateInteriorAsset(assetId: InteriorAssetId): THREE.Group {
  const tpl = getCachedInteriorAsset(assetId);
  const clone = tpl.scene.clone(true);
  clone.name = assetId;
  return clone;
}

export function getInteriorAssetDiagnostics(): Record<
  InteriorAssetId,
  {
    loaded: boolean;
    failed: boolean;
    isFallback: boolean;
    url: string;
    triangles: number;
    dimensions: [number, number, number];
    materialsUsed: Stage04AMaterialName[];
    hasVertexColors: boolean;
    noCamerasOrLights: boolean;
    meshNames: string[];
    pivots: InteriorPivotDiagnostics;
    itemAnchorCategories: AnchorSurfaceCategory[];
  }
> {
  const out = {} as ReturnType<typeof getInteriorAssetDiagnostics>;
  for (const id of INTERIOR_ASSET_IDS) {
    const loadedTpl = assetCache.get(id);
    const tpl = loadedTpl ?? getOrCreateFallbackTemplate(id);
    const manifest = INTERIOR_ASSET_MANIFEST[id];
    const categories = Array.from(new Set(manifest.itemAnchors.map((a) => a.category)));
    out[id] = {
      loaded: Boolean(loadedTpl && !loadedTpl.isFallback),
      failed: failedAssets.has(id),
      isFallback: tpl.isFallback,
      url: INTERIOR_GLB_URLS[id],
      triangles: tpl.triangles,
      dimensions: [
        Number(tpl.dimensions.x.toFixed(3)),
        Number(tpl.dimensions.y.toFixed(3)),
        Number(tpl.dimensions.z.toFixed(3)),
      ],
      materialsUsed: tpl.materialsUsed,
      hasVertexColors: tpl.hasVertexColors,
      noCamerasOrLights: tpl.noCamerasOrLights,
      meshNames: tpl.meshNames,
      pivots: tpl.pivots,
      itemAnchorCategories: categories,
    };
  }
  return out;
}
