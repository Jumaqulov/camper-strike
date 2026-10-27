import type { Box, MaterialKind } from '../map';
import type { Vec3 } from '../math';
import type { ColliderBox, ColliderTag } from '../world';
import {
  BUILDING_ASSET_IDS,
  BUILDING_GLB_URLS,
  CONTAINER_ASSET_IDS,
  CONTAINER_GLB_URLS,
  INTERIOR_ASSET_IDS,
  INTERIOR_GLB_URLS,
  type BuildingAssetId,
  type ContainerAssetId,
  type InteriorAssetId,
  type ItemAnchorSpec,
  type LocalBoxSpec,
  type PivotSpec,
  type PlaceableSurfaceSpec,
  type Stage04AAssetId,
  type Stage04AMaterialName,
} from './contracts';

const q3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface BuildingAssetManifest {
  id: BuildingAssetId;
  url: string;
  dimensions: Vec3;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  materials: Stage04AMaterialName[];
  staticMeshes: string[];
  pivots: PivotSpec[];
  /** Segmented local AABB collider specifications. */
  colliderBoxes: LocalBoxSpec[];
}

export interface InteriorAssetManifest {
  id: InteriorAssetId;
  url: string;
  dimensions: Vec3;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  materials: Stage04AMaterialName[];
  staticMeshes: string[];
  pivots: PivotSpec[];
  /** Segmented local AABB collider boxes (preserving hollow spaces for anchors). */
  colliderBoxes: LocalBoxSpec[];
  placeableSurfaces: PlaceableSurfaceSpec[];
  itemAnchors: ItemAnchorSpec[];
}

export interface ContainerAssetManifest {
  id: ContainerAssetId;
  url: string;
  dimensions: Vec3;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  materials: Stage04AMaterialName[];
  staticMeshes: string[];
  movingNode: PivotSpec;
  /** Hollow shell segments (floor, side/back walls, internal shelves) — never a solid simpleClosed block. */
  shellSegments: LocalBoxSpec[];
  /** Lid or door collider in movingNode pivot-local space. */
  movingPart: LocalBoxSpec;
  /** Interior cavity volume in model-local space. */
  interiorVolume: LocalBoxSpec;
  interactionSphereCenter: [number, number, number];
  interactionRadius: number;
  placeableSurfaces: PlaceableSurfaceSpec[];
  itemAnchors: ItemAnchorSpec[];
}

// ---------------- 1. Building Asset Manifests (8 GLBs) ----------------

/**
 * Generates the 15 stepped AABB colliders + handrail collider for `wood_stairs_01` in model-local space.
 * - 15 steps from y = 0 to y = 3.0 m (each step rise = 0.20 m <= STEP_HEIGHT).
 * - Spans z in [0 .. -4.0 m], width 1.2 m (x in [-0.6, 0.6]).
 * - Step 1 & Step 2 have generous landing depths so a player (radius 0.38..0.40 m) can enter
 *   both straight along -Z and from the +X side when placed near a cabin wall.
 */
export function buildWoodStairsLocalBoxes(): LocalBoxSpec[] {
  const boxes: LocalBoxSpec[] = [];
  const stepWidth = 1.2;
  const stepRise = 0.2;

  // Step 1: z in [0, -0.46], y in [0, 0.20]
  // Step 2: z in [-0.46, -0.92], y in [0.20, 0.40]
  // Steps 3..15 (13 steps): z in [-0.92, -4.00], each 3.08 / 13 = 0.2369 m deep
  const zEdges: number[] = [0, -0.46, -0.92];
  const remSteps = 13;
  const remDepth = (4.0 - 0.92) / remSteps;
  for (let i = 1; i <= remSteps; i++) {
    zEdges.push(q3(-0.92 - i * remDepth));
  }

  // Emit steps from top (step_15) down to bottom (step_01) so side-entry onto step_01/02 steps up cleanly in a single pass
  for (let i = 14; i >= 0; i--) {
    const z0 = zEdges[i]!;
    const z1 = zEdges[i + 1]!;
    const depth = Math.abs(z1 - z0);
    const cz = (z0 + z1) / 2;
    const topY = (i + 1) * stepRise;
    const bottomY = i * stepRise;
    const sy = topY - bottomY;
    const cy = bottomY + sy / 2;
    boxes.push({
      name: `stair_step_${String(i + 1).padStart(2, '0')}`,
      center: [0, q3(cy), q3(cz)],
      size: [stepWidth, q3(sy), q3(depth)],
    });
  }

  // Handrail flush along +X edge (x_local in [0.52, 0.60]).
  // Faqat yuqori qismda (z in [-1.4, -4.0], y in [0.85, 4.0]): pastki 3 ta pog'ona (z in [0, -1.4]) yon tomondan
  // ochiq — o'yinchi zinaga yon tomondan (masalan, kulba eshigi tomonidan) qadam qo'ya oladi; avvalgi 4 m
  // balandlikdagi to'liq uzunlikdagi devor zinaga yo'lni butunlay to'sib qo'yardi. Yuqorida esa pog'onalar
  // o'zi (har biri 0.2 m ko'tarilish, yon devor sifatida) va dasta o'yinchini zinada ushlab turadi.
  boxes.push({
    name: 'stair_handrail_plus_x',
    center: [0.56, 2.425, -2.7],
    size: [0.08, 3.15, 2.6],
  });

  return boxes;
}

export const WOOD_STAIRS_LOCAL_BOXES: readonly LocalBoxSpec[] = buildWoodStairsLocalBoxes();

export const BUILDING_MANIFESTS: Record<BuildingAssetId, BuildingAssetManifest> = {
  wood_wall_01: {
    id: 'wood_wall_01',
    url: BUILDING_GLB_URLS.wood_wall_01,
    dimensions: { x: 4.12, y: 3.2, z: 0.24 },
    boundsMin: [-2.12, -0.2, -0.12],
    boundsMax: [2.0, 3.0, 0.12],
    materials: ['wood'],
    staticMeshes: ['wood_wall_01_body', 'corner_post'],
    pivots: [],
    colliderBoxes: [
      {
        name: 'wall_solid',
        center: [0, 1.5, 0],
        size: [4.0, 3.0, 0.2],
      },
    ],
  },
  wood_wall_window_01: {
    id: 'wood_wall_window_01',
    url: BUILDING_GLB_URLS.wood_wall_window_01,
    dimensions: { x: 4.12, y: 3.2, z: 0.36 },
    boundsMin: [-2.12, -0.2, -0.13],
    boundsMax: [2.0, 3.0, 0.23],
    materials: ['wood', 'iron'],
    staticMeshes: ['wood_wall_window_01_body', 'corner_post', 'wood_wall_window_01_iron'],
    pivots: [],
    // Leaves central 1.2 x 1.0 m window opening (x in [-0.6, 0.6], y in [1.0, 2.0]) completely open
    colliderBoxes: [
      {
        name: 'window_wall_left',
        center: [-1.3, 1.5, 0],
        size: [1.4, 3.0, 0.2],
      },
      {
        name: 'window_wall_right',
        center: [1.3, 1.5, 0],
        size: [1.4, 3.0, 0.2],
      },
      {
        name: 'window_wall_bottom_sill',
        center: [0, 0.5, 0],
        size: [1.2, 1.0, 0.2],
      },
      {
        name: 'window_wall_top_header',
        center: [0, 2.5, 0],
        size: [1.2, 1.0, 0.2],
      },
    ],
  },
  wood_wall_door_01: {
    id: 'wood_wall_door_01',
    url: BUILDING_GLB_URLS.wood_wall_door_01,
    dimensions: { x: 4.12, y: 3.2, z: 0.27 },
    boundsMin: [-2.12, -0.2, -0.13],
    boundsMax: [2.0, 3.0, 0.14],
    materials: ['wood'],
    staticMeshes: ['wood_wall_door_01_body', 'corner_post'],
    pivots: [],
    // Leaves central 1.8 x 2.4 m doorway opening (x in [-0.9, 0.9], y in [0, 2.4]) completely open
    colliderBoxes: [
      {
        name: 'door_wall_left_jamb',
        center: [-1.45, 1.5, 0],
        size: [1.1, 3.0, 0.2],
      },
      {
        name: 'door_wall_right_jamb',
        center: [1.45, 1.5, 0],
        size: [1.1, 3.0, 0.2],
      },
      {
        name: 'door_wall_top_lintel',
        center: [0, 2.7, 0],
        size: [1.8, 0.6, 0.2],
      },
    ],
  },
  wood_floor_01: {
    id: 'wood_floor_01',
    url: BUILDING_GLB_URLS.wood_floor_01,
    dimensions: { x: 4.0, y: 0.2, z: 4.0 },
    boundsMin: [-2.0, -0.2, -2.0],
    boundsMax: [2.0, 0.0, 2.0],
    materials: ['wood'],
    staticMeshes: ['wood_floor_01_body'],
    pivots: [],
    colliderBoxes: [
      {
        name: 'floor_slab',
        center: [0, -0.1, 0],
        size: [4.0, 0.2, 4.0],
      },
    ],
  },
  wood_roof_slope_01: {
    id: 'wood_roof_slope_01',
    url: BUILDING_GLB_URLS.wood_roof_slope_01,
    dimensions: { x: 4.0, y: 2.09, z: 2.53 },
    boundsMin: [-2.0, -0.45, -0.08],
    boundsMax: [2.0, 1.64, 2.45],
    materials: ['wood', 'roof'],
    staticMeshes: ['wood_roof_slope_01_frame', 'wood_roof_slope_01_shingles'],
    pivots: [],
    // Upper roof cap positioned at y >= 1.90 in local space (world y >= 4.90) so a 1.8m player on a y=3.0 loft has full standing headroom
    colliderBoxes: [
      {
        name: 'roof_slope_cap',
        center: [0, 1.95, 1.0],
        size: [4.0, 0.14, 2.5],
        rotationX: 0.6435,
      },
    ],
  },
  wood_roof_gable_01: {
    id: 'wood_roof_gable_01',
    url: BUILDING_GLB_URLS.wood_roof_gable_01,
    dimensions: { x: 4.82, y: 2.15, z: 0.24 },
    boundsMin: [-2.41, -0.46, -0.08],
    boundsMax: [2.41, 1.68, 0.16],
    materials: ['wood'],
    staticMeshes: ['wood_roof_gable_01_body'],
    pivots: [],
    colliderBoxes: [
      {
        name: 'gable_wall',
        center: [0, 0.75, 0],
        size: [4.0, 1.5, 0.2],
        // O'q uchun: GLB uchburchagi (asos y=-0.46 da ±2.41, uchi y=1.68) — quti burchaklari havoda qolmasin
        gable: { halfWidth: 2.41, baseY: -0.46, apexY: 1.68 },
      },
    ],
  },
  wood_door_01: {
    id: 'wood_door_01',
    url: BUILDING_GLB_URLS.wood_door_01,
    dimensions: { x: 1.79, y: 2.35, z: 0.14 },
    boundsMin: [-0.91, 0.04, -0.07],
    boundsMax: [0.88, 2.38, 0.07],
    materials: ['wood', 'iron'],
    staticMeshes: [],
    pivots: [
      {
        name: 'door_pivot',
        position: [-0.88, 0, 0],
        axis: 'y',
        closedAngleRad: 0,
        openAngleRad: 1.38,
        openAngleDeg: 79,
        movingMeshes: ['door_leaf', 'door_hardware'],
        collider: {
          name: 'door_leaf_box',
          center: [0.88, 1.21, 0],
          size: [1.76, 2.35, 0.08],
        },
      },
    ],
    colliderBoxes: [],
  },
  wood_stairs_01: {
    id: 'wood_stairs_01',
    url: BUILDING_GLB_URLS.wood_stairs_01,
    dimensions: { x: 1.33, y: 4.01, z: 4.04 },
    boundsMin: [-0.66, -0.01, -4.01],
    boundsMax: [0.67, 4.0, 0.03],
    materials: ['wood'],
    staticMeshes: ['wood_stairs_01_body'],
    pivots: [],
    colliderBoxes: [...WOOD_STAIRS_LOCAL_BOXES],
  },
};

// ---------------- 2. Interior Furniture Manifests (6 GLBs) ----------------

export const INTERIOR_MANIFESTS: Record<InteriorAssetId, InteriorAssetManifest> = {
  wooden_table_01: {
    id: 'wooden_table_01',
    url: INTERIOR_GLB_URLS.wooden_table_01,
    dimensions: { x: 1.408, y: 0.75, z: 0.796 },
    boundsMin: [-0.704, 0, -0.398],
    boundsMax: [0.705, 0.75, 0.398],
    materials: ['wood'],
    staticMeshes: ['wooden_table_01_body'],
    pivots: [],
    colliderBoxes: [
      {
        name: 'tabletop',
        center: [0, 0.73, 0],
        size: [1.4, 0.04, 0.8],
      },
      {
        name: 'legs_block',
        center: [0, 0.355, 0],
        size: [1.31, 0.71, 0.71],
      },
    ],
    placeableSurfaces: [
      {
        name: 'tabletop',
        y: 0.75,
        center: [0, 0.75, 0],
        size: [1.36, 0.76],
      },
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
    id: 'wooden_chair_01',
    url: INTERIOR_GLB_URLS.wooden_chair_01,
    dimensions: { x: 0.46, y: 0.899, z: 0.524 },
    boundsMin: [-0.23, -0.002, -0.297],
    boundsMax: [0.23, 0.897, 0.227],
    materials: ['wood'],
    staticMeshes: ['wooden_chair_01_body'],
    pivots: [],
    colliderBoxes: [
      {
        name: 'seat',
        center: [0, 0.235, 0],
        size: [0.46, 0.47, 0.46],
      },
      {
        name: 'backrest',
        center: [0, 0.68, -0.25],
        size: [0.46, 0.44, 0.06],
      },
    ],
    placeableSurfaces: [
      {
        name: 'seat',
        y: 0.47,
        center: [0, 0.47, 0],
        size: [0.42, 0.42],
      },
    ],
    itemAnchors: [
      { name: 'seat', position: [0, 0.47, 0.02], up: [0, 1, 0], category: 'chair_seat' },
    ],
  },
  wooden_shelf_01: {
    id: 'wooden_shelf_01',
    url: INTERIOR_GLB_URLS.wooden_shelf_01,
    dimensions: { x: 1.04, y: 1.803, z: 0.42 },
    boundsMin: [-0.52, -0.003, -0.21],
    boundsMax: [0.52, 1.8, 0.21],
    materials: ['wood'],
    staticMeshes: ['wooden_shelf_01_body'],
    pivots: [],
    colliderBoxes: [
      {
        name: 'body',
        center: [0, 0.9, 0],
        size: [1.0, 1.8, 0.4],
      },
    ],
    placeableSurfaces: [
      { name: 'shelf_1', y: 0.12, center: [0, 0.12, 0.01], size: [0.92, 0.34], clearHeight: 0.415 },
      { name: 'shelf_2', y: 0.56, center: [0, 0.56, 0.01], size: [0.92, 0.34], clearHeight: 0.415 },
      { name: 'shelf_3', y: 1.0, center: [0, 1.0, 0.01], size: [0.92, 0.34], clearHeight: 0.415 },
      { name: 'shelf_4', y: 1.44, center: [0, 1.44, 0.01], size: [0.92, 0.34], clearHeight: 0.33 },
      { name: 'top', y: 1.8, center: [0, 1.8, 0], size: [1.0, 0.4] },
    ],
    itemAnchors: [
      { name: 'shelf_1_1', position: [-0.3, 0.12, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_1_2', position: [0, 0.12, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_1_3', position: [0.3, 0.12, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_2_1', position: [-0.3, 0.56, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_2_2', position: [0, 0.56, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_2_3', position: [0.3, 0.56, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_3_1', position: [-0.3, 1.0, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_3_2', position: [0, 1.0, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_3_3', position: [0.3, 1.0, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_4_1', position: [-0.3, 1.44, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_4_2', position: [0, 1.44, 0.01], up: [0, 1, 0], category: 'shelf' },
      { name: 'shelf_4_3', position: [0.3, 1.44, 0.01], up: [0, 1, 0], category: 'shelf' },
    ],
  },
  old_bed_01: {
    id: 'old_bed_01',
    url: INTERIOR_GLB_URLS.old_bed_01,
    dimensions: { x: 2.02, y: 0.65, z: 0.97 },
    boundsMin: [-1.01, 0, -0.485],
    boundsMax: [1.01, 0.65, 0.485],
    materials: ['wood', 'fabric'],
    staticMeshes: ['old_bed_01_frame', 'old_bed_01_fabric'],
    pivots: [],
    // §4 Requirement: Hollow under-bed space (y = 0 .. 0.20 m) with 4 corner legs + elevated mattress_top + headboard
    colliderBoxes: [
      {
        name: 'mattress_top',
        center: [0, 0.33, 0],
        size: [2.0, 0.26, 0.95],
      },
      {
        name: 'headboard',
        center: [0.965, 0.555, 0],
        size: [0.09, 0.19, 0.95],
      },
      {
        name: 'bed_leg_nw',
        center: [-0.94, 0.1, -0.42],
        size: [0.1, 0.2, 0.1],
      },
      {
        name: 'bed_leg_ne',
        center: [0.94, 0.1, -0.42],
        size: [0.1, 0.2, 0.1],
      },
      {
        name: 'bed_leg_sw',
        center: [-0.94, 0.1, 0.42],
        size: [0.1, 0.2, 0.1],
      },
      {
        name: 'bed_leg_se',
        center: [0.94, 0.1, 0.42],
        size: [0.1, 0.2, 0.1],
      },
    ],
    placeableSurfaces: [
      {
        name: 'mattress',
        y: 0.46,
        center: [-0.1, 0.46, 0],
        size: [1.6, 0.8],
      },
      {
        name: 'under_bed',
        y: 0.0,
        center: [0, 0.0, 0],
        size: [1.7, 0.7],
        clearHeight: 0.2,
      },
    ],
    itemAnchors: [
      { name: 'mattress', position: [-0.2, 0.46, 0], up: [0, 1, 0], category: 'mattress' },
      { name: 'under_bed', position: [0, 0.08, 0], up: [0, 1, 0], category: 'under_bed' },
    ],
  },
  old_sofa_01: {
    id: 'old_sofa_01',
    url: INTERIOR_GLB_URLS.old_sofa_01,
    dimensions: { x: 1.7, y: 0.902, z: 0.8 },
    boundsMin: [-0.85, 0, -0.4],
    boundsMax: [0.85, 0.902, 0.4],
    materials: ['wood', 'fabric'],
    staticMeshes: ['old_sofa_01_legs', 'old_sofa_01_fabric'],
    pivots: [],
    colliderBoxes: [
      {
        name: 'seat',
        center: [0, 0.25, 0.01],
        size: [1.7, 0.5, 0.78],
      },
      {
        name: 'back',
        center: [0, 0.62, -0.31],
        size: [1.7, 0.52, 0.18],
      },
    ],
    placeableSurfaces: [
      {
        name: 'seat',
        y: 0.5,
        center: [0, 0.5, 0.08],
        size: [1.3, 0.5],
      },
    ],
    itemAnchors: [
      { name: 'seat_left', position: [-0.33, 0.5, 0.1], up: [0, 1, 0], category: 'sofa_seat' },
      { name: 'seat_right', position: [0.33, 0.5, 0.1], up: [0, 1, 0], category: 'sofa_seat' },
    ],
  },
  kitchen_cabinet_01: {
    id: 'kitchen_cabinet_01',
    url: INTERIOR_GLB_URLS.kitchen_cabinet_01,
    dimensions: { x: 1.24, y: 0.903, z: 0.575 },
    boundsMin: [-0.62, -0.003, -0.278],
    boundsMax: [0.62, 0.9, 0.297],
    materials: ['wood', 'iron'],
    staticMeshes: ['kitchen_cabinet_01_body'],
    pivots: [
      {
        name: 'door_left_pivot',
        position: [-0.585, 0, 0.255],
        axis: 'y',
        closedAngleRad: 0,
        openAngleRad: -1.75,
        openAngleDeg: -100,
        movingMeshes: ['door_left', 'door_left_hardware'],
        collider: {
          name: 'door_left_box',
          center: [0.285, 0.47, 0],
          size: [0.57, 0.72, 0.02],
        },
      },
      {
        name: 'door_right_pivot',
        position: [0.585, 0, 0.255],
        axis: 'y',
        closedAngleRad: 0,
        openAngleRad: 1.75,
        openAngleDeg: 100,
        movingMeshes: ['door_right', 'door_right_hardware'],
        collider: {
          name: 'door_right_box',
          center: [-0.285, 0.47, 0],
          size: [0.57, 0.72, 0.02],
        },
      },
    ],
    // §4 Requirement: Hollow segmented cabinet body so inside_bottom (y=0.10) and inside_shelf (y=0.479) are unobstructed
    colliderBoxes: [
      {
        name: 'left_panel',
        center: [-0.58, 0.45, 0],
        size: [0.04, 0.9, 0.55],
      },
      {
        name: 'right_panel',
        center: [0.58, 0.45, 0],
        size: [0.04, 0.9, 0.55],
      },
      {
        name: 'back_panel',
        center: [0, 0.45, -0.255],
        size: [1.12, 0.9, 0.04],
      },
      {
        name: 'bottom_plank',
        center: [0, 0.04, 0],
        size: [1.12, 0.08, 0.51],
      },
      {
        name: 'mid_shelf_plank',
        center: [0, 0.45, -0.02],
        size: [1.12, 0.04, 0.44],
      },
      {
        name: 'countertop_plank',
        center: [0, 0.87, 0],
        size: [1.2, 0.06, 0.55],
      },
    ],
    placeableSurfaces: [
      {
        name: 'countertop',
        y: 0.9,
        center: [0, 0.9, 0],
        size: [1.2, 0.52],
      },
      {
        name: 'inside_bottom',
        y: 0.1,
        center: [0, 0.1, -0.02],
        size: [1.14, 0.46],
        clearHeight: 0.33,
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'inside_shelf',
        y: 0.479,
        center: [0, 0.479, -0.04],
        size: [1.14, 0.42],
        clearHeight: 0.36,
        requiresOpenDoorOrLid: true,
      },
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

// ---------------- 3. Loot Container Manifests (3 GLBs) ----------------

export const CONTAINER_MANIFESTS: Record<ContainerAssetId, ContainerAssetManifest> = {
  wooden_loot_crate_01: {
    id: 'wooden_loot_crate_01',
    url: CONTAINER_GLB_URLS.wooden_loot_crate_01,
    dimensions: { x: 1.005, y: 0.606, z: 0.646 },
    boundsMin: [-0.502, 0, -0.317],
    boundsMax: [0.502, 0.606, 0.328],
    materials: ['wood', 'iron'],
    staticMeshes: ['crate_body', 'crate_body_metal'],
    movingNode: {
      name: 'lid_pivot',
      position: [0, 0.46, -0.3],
      axis: 'x',
      closedAngleRad: 0,
      openAngleRad: -1.92,
      openAngleDeg: -110,
      movingMeshes: ['crate_lid', 'crate_lid_metal'],
      collider: {
        name: 'crate_lid_box',
        center: [0, 0.07, 0.3],
        size: [0.9, 0.14, 0.6],
      },
    },
    shellSegments: [
      {
        name: 'crate_bottom',
        center: [0, 0.035, 0],
        size: [0.9, 0.07, 0.6],
      },
      {
        name: 'crate_left_wall',
        center: [-0.43, 0.265, 0],
        size: [0.04, 0.39, 0.6],
      },
      {
        name: 'crate_right_wall',
        center: [0.43, 0.265, 0],
        size: [0.04, 0.39, 0.6],
      },
      {
        name: 'crate_back_wall',
        center: [0, 0.265, -0.28],
        size: [0.82, 0.39, 0.04],
      },
      {
        name: 'crate_front_wall',
        center: [0, 0.265, 0.28],
        size: [0.82, 0.39, 0.04],
      },
    ],
    movingPart: {
      name: 'crate_lid_box',
      center: [0, 0.07, 0.3],
      size: [0.9, 0.14, 0.6],
    },
    interiorVolume: {
      name: 'crate_interior',
      center: [0, 0.265, 0],
      size: [0.82, 0.39, 0.52],
    },
    interactionSphereCenter: [0, 0.303, 0.005],
    interactionRadius: 1.87,
    placeableSurfaces: [
      {
        name: 'crate_floor',
        y: 0.07,
        center: [0, 0.07, 0],
        size: [0.82, 0.52],
        clearHeight: 0.39,
        requiresOpenDoorOrLid: true,
      },
    ],
    itemAnchors: [
      {
        name: 'crate_slot_left',
        position: [-0.22, 0.16, 0],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'crate_slot_center',
        position: [0, 0.16, 0],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'crate_slot_right',
        position: [0.22, 0.16, 0],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
    ],
  },
  metal_locker_01: {
    id: 'metal_locker_01',
    url: CONTAINER_GLB_URLS.metal_locker_01,
    dimensions: { x: 0.91, y: 1.8, z: 0.56 },
    boundsMin: [-0.455, 0, -0.255],
    boundsMax: [0.455, 1.8, 0.305],
    materials: ['painted_metal', 'iron'],
    staticMeshes: ['locker_body', 'locker_body_metal'],
    movingNode: {
      name: 'door_pivot',
      position: [-0.43, 0, 0.25],
      axis: 'y',
      closedAngleRad: 0,
      openAngleRad: -1.75,
      openAngleDeg: -100,
      movingMeshes: ['locker_door', 'locker_door_hardware'],
      collider: {
        name: 'locker_door_box',
        center: [0.43, 0.925, 0.0145],
        size: [0.85, 1.69, 0.03],
      },
    },
    shellSegments: [
      {
        name: 'locker_bottom_shelf',
        center: [0, 0.045, 0],
        size: [0.9, 0.09, 0.5],
      },
      {
        name: 'locker_top_cap',
        center: [0, 1.755, 0],
        size: [0.9, 0.09, 0.5],
      },
      {
        name: 'locker_left_wall',
        center: [-0.435, 0.9, 0],
        size: [0.03, 1.62, 0.5],
      },
      {
        name: 'locker_right_wall',
        center: [0.435, 0.9, 0],
        size: [0.03, 1.62, 0.5],
      },
      {
        name: 'locker_back_wall',
        center: [0, 0.9, -0.24],
        size: [0.84, 1.62, 0.02],
      },
      {
        name: 'locker_shelf_1',
        center: [0, 0.5475, -0.01],
        size: [0.84, 0.02, 0.44],
      },
      {
        name: 'locker_shelf_2',
        center: [0, 0.9975, -0.01],
        size: [0.84, 0.02, 0.44],
      },
      {
        name: 'locker_shelf_3',
        center: [0, 1.4475, -0.01],
        size: [0.84, 0.02, 0.44],
      },
    ],
    movingPart: {
      name: 'locker_door_box',
      center: [0.43, 0.925, 0.0145],
      size: [0.85, 1.69, 0.03],
    },
    interiorVolume: {
      name: 'locker_interior',
      center: [0, 0.925, -0.01],
      size: [0.84, 1.57, 0.44],
    },
    interactionSphereCenter: [0, 0.9, 0.025],
    interactionRadius: 2.247,
    placeableSurfaces: [
      {
        name: 'locker_floor_0',
        y: 0.09,
        center: [0, 0.09, -0.01],
        size: [0.84, 0.44],
        clearHeight: 0.44,
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'locker_shelf_1',
        y: 0.5575,
        center: [0, 0.5575, -0.01],
        size: [0.84, 0.44],
        clearHeight: 0.43,
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'locker_shelf_2',
        y: 1.0075,
        center: [0, 1.0075, -0.01],
        size: [0.84, 0.44],
        clearHeight: 0.43,
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'locker_shelf_3',
        y: 1.4575,
        center: [0, 1.4575, -0.01],
        size: [0.84, 0.44],
        clearHeight: 0.25,
        requiresOpenDoorOrLid: true,
      },
    ],
    itemAnchors: [
      {
        name: 'locker_slot_0',
        position: [0, 0.175, 0],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'locker_slot_1',
        position: [0, 0.645, 0],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'locker_slot_2',
        position: [0, 1.095, 0],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'locker_slot_3',
        position: [0, 1.545, 0],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
    ],
  },
  old_toolbox_01: {
    id: 'old_toolbox_01',
    url: CONTAINER_GLB_URLS.old_toolbox_01,
    dimensions: { x: 0.607, y: 0.3, z: 0.319 },
    boundsMin: [-0.303, 0, -0.157],
    boundsMax: [0.303, 0.3, 0.162],
    materials: ['painted_metal', 'iron'],
    staticMeshes: ['toolbox_body', 'toolbox_body_metal'],
    movingNode: {
      name: 'lid_pivot',
      position: [0, 0.2, -0.15],
      axis: 'x',
      closedAngleRad: 0,
      openAngleRad: -1.92,
      openAngleDeg: -110,
      movingMeshes: ['toolbox_lid', 'toolbox_lid_metal'],
      collider: {
        name: 'toolbox_lid_box',
        center: [0, 0.05, 0.15],
        size: [0.6, 0.1, 0.3],
      },
    },
    shellSegments: [
      {
        name: 'toolbox_bottom',
        center: [0, 0.0125, 0],
        size: [0.6, 0.025, 0.3],
      },
      {
        name: 'toolbox_left_wall',
        center: [-0.29, 0.1125, 0],
        size: [0.02, 0.175, 0.3],
      },
      {
        name: 'toolbox_right_wall',
        center: [0.29, 0.1125, 0],
        size: [0.02, 0.175, 0.3],
      },
      {
        name: 'toolbox_back_wall',
        center: [0, 0.1125, -0.14],
        size: [0.56, 0.175, 0.02],
      },
      {
        name: 'toolbox_front_wall',
        center: [0, 0.1125, 0.145],
        size: [0.56, 0.175, 0.01],
      },
      {
        name: 'toolbox_rear_tray',
        center: [0, 0.172, -0.08],
        size: [0.56, 0.035, 0.1],
      },
    ],
    movingPart: {
      name: 'toolbox_lid_box',
      center: [0, 0.05, 0.15],
      size: [0.6, 0.1, 0.3],
    },
    interiorVolume: {
      name: 'toolbox_interior',
      center: [0, 0.11, 0.065],
      size: [0.56, 0.17, 0.14],
    },
    interactionSphereCenter: [0, 0.15, 0.002],
    interactionRadius: 1.574,
    placeableSurfaces: [
      {
        name: 'toolbox_front_compartment',
        y: 0.025,
        center: [0, 0.025, 0.055],
        size: [0.56, 0.14],
        clearHeight: 0.175,
        requiresOpenDoorOrLid: true,
      },
    ],
    itemAnchors: [
      {
        name: 'toolbox_slot_left',
        position: [-0.14, 0.11, 0.055],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
      {
        name: 'toolbox_slot_right',
        position: [0.14, 0.11, 0.055],
        up: [0, 1, 0],
        category: 'inside_container',
        requiresOpenDoorOrLid: true,
      },
    ],
  },
};

// ---------------- 4. Pure-TS World AABB Collider Transform Builders ----------------

/**
 * Transforms a model-local `LocalBoxSpec` into a world `ColliderBox` given a root `position` and `rotationY`.
 */
export function localBoxToWorldCollider(
  id: string,
  sourceObjectId: string,
  box: LocalBoxSpec,
  position: Vec3,
  rotationY: number,
  tag: ColliderTag = 'structure',
  mat: MaterialKind = 'wall',
): ColliderBox {
  const totalYaw = rotationY + (box.rotationY ?? 0);
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);

  const [ox, oy, oz] = box.center;
  const [sx, sy, sz] = box.size;

  const rx = ox * cosY + oz * sinY;
  const rz = -ox * sinY + oz * cosY;

  const cx = position.x + rx;
  const cy = position.y + oy;
  const cz = position.z + rz;

  const cosT = Math.cos(totalYaw);
  const sinT = Math.sin(totalYaw);
  const halfX = (Math.abs(cosT) * sx + Math.abs(sinT) * sz) / 2;
  const halfY = sy / 2;
  const halfZ = (Math.abs(sinT) * sx + Math.abs(cosT) * sz) / 2;

  const out: ColliderBox = {
    id,
    sourceObjectId,
    tag,
    mat,
    min: { x: q3(cx - halfX), y: q3(cy - halfY), z: q3(cz - halfZ) },
    max: { x: q3(cx + halfX), y: q3(cy + halfY), z: q3(cz + halfZ) },
  };
  // O'q uchun aniq shakl: uchburchak old devor yoki o'qqa to'g'ri kelmaydigan (kardinal bo'lmagan) burilish
  if (box.gable) {
    const g = box.gable;
    // Uchburchak quti balandligi bilan kesishadi: asos/uch dunyo Y da, AABB ichida qoladi
    out.hit = {
      kind: 'gable',
      cx: q3(cx),
      cz: q3(cz),
      hx: Math.min(g.halfWidth, sx / 2),
      baseY: q3(position.y + g.baseY),
      apexY: q3(position.y + g.apexY),
      hz: sz / 2,
      yaw: totalYaw,
    };
  } else if (!isCardinalYaw(totalYaw)) {
    out.hit = { kind: 'obb', cx: q3(cx), cy: q3(cy), cz: q3(cz), hx: sx / 2, hy: sy / 2, hz: sz / 2, yaw: totalYaw };
  }
  return out;
}

/** Burilish 90° ga karrali (AABB aniq) bo'lsa true. */
function isCardinalYaw(yaw: number): boolean {
  const k = yaw / (Math.PI / 2);
  return Math.abs(k - Math.round(k)) < 1e-6;
}

/**
 * Transforms a pivot-local `LocalBoxSpec` (rotating around `pivot.axis` by `angleRad`) into a model-local `LocalBoxSpec`.
 */
export function transformPivotBoxToModelLocal(
  pivot: PivotSpec,
  box: LocalBoxSpec,
  angleRad: number,
): LocalBoxSpec {
  const [px, py, pz] = pivot.position;
  const [ox, oy, oz] = box.center;
  const [sx, sy, sz] = box.size;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  if (pivot.axis === 'y') {
    const rx = ox * cos + oz * sin;
    const rz = -ox * sin + oz * cos;
    return {
      name: box.name,
      center: [q3(px + rx), q3(py + oy), q3(pz + rz)],
      size: [sx, sy, sz],
      rotationY: angleRad,
    };
  }

  if (pivot.axis === 'x') {
    // Three.js right-handed X-axis rotation: y' = y*cos - z*sin, z' = y*sin + z*cos
    const ry = oy * cos - oz * sin;
    const rz = oy * sin + oz * cos;
    const effY = Math.abs(cos) * sy + Math.abs(sin) * sz;
    const effZ = Math.abs(sin) * sy + Math.abs(cos) * sz;
    return {
      name: box.name,
      center: [q3(px + ox), q3(py + ry), q3(pz + rz)],
      size: [sx, q3(effY), q3(effZ)],
    };
  }

  const rx = ox * cos - oy * sin;
  const ry = ox * sin + oy * cos;
  const effX = Math.abs(cos) * sx + Math.abs(sin) * sy;
  const effY = Math.abs(sin) * sx + Math.abs(cos) * sy;
  return {
    name: box.name,
    center: [q3(px + rx), q3(py + ry), q3(pz + oz)],
    size: [q3(effX), q3(effY), sz],
  };
}

/**
 * Computes the world AABB `ColliderBox` for `wood_door_01` rotating around `door_pivot (-0.88, 0, 0)`
 * by any `doorOpenAngleRad` (e.g. `0` closed or `1.38` open).
 */
export function buildWoodDoorLeafCollider(
  instanceId: string,
  position: Vec3,
  rotationY: number,
  doorOpenAngleRad = 0,
): ColliderBox {
  const pivot = BUILDING_MANIFESTS.wood_door_01.pivots[0]!;
  const leafSpec = pivot.collider!;
  const localRotated = transformPivotBoxToModelLocal(pivot, leafSpec, doorOpenAngleRad);
  return localBoxToWorldCollider(
    `${instanceId}:door_leaf:col`,
    instanceId,
    localRotated,
    position,
    rotationY,
    'structure',
    'crate',
  );
}

/**
 * Computes all segmented world AABB colliders for a `wood_stairs_01` module placement.
 */
export function buildWoodStairsColliders(
  instanceId: string,
  position: Vec3,
  rotationY: number,
): ColliderBox[] {
  return WOOD_STAIRS_LOCAL_BOXES.map((box) =>
    localBoxToWorldCollider(
      `${instanceId}:${box.name}:col`,
      instanceId,
      box,
      position,
      rotationY,
      'structure',
      'crate',
    ),
  );
}

/**
 * Computes world AABB colliders for `kitchen_cabinet_01` including its 6 hollow body panels
 * and 2 rotating door colliders (`door_left_pivot`, `door_right_pivot`) for `openFraction` in `[0..1]`.
 */
export function buildKitchenCabinetDoorColliders(
  instanceId: string,
  position: Vec3,
  rotationY: number,
  openFraction = 0,
): ColliderBox[] {
  const clamped = Math.max(0, Math.min(1, openFraction));
  const manifest = INTERIOR_MANIFESTS.kitchen_cabinet_01;
  return manifest.pivots.map((pivot) => {
    const angle =
      pivot.closedAngleRad + (pivot.openAngleRad - pivot.closedAngleRad) * clamped;
    const localDoor = transformPivotBoxToModelLocal(pivot, pivot.collider!, angle);
    return localBoxToWorldCollider(
      `${instanceId}:${pivot.name}:col`,
      instanceId,
      localDoor,
      position,
      rotationY,
      'prop',
      'crate',
    );
  });
}

export function buildInteriorAssetColliders(
  instanceId: string,
  assetId: InteriorAssetId,
  position: Vec3,
  rotationY: number,
  openFraction = 0,
): ColliderBox[] {
  const manifest = INTERIOR_MANIFESTS[assetId];
  const mat: MaterialKind = assetId === 'kitchen_cabinet_01' ? 'crate' : 'crate';
  const cols = manifest.colliderBoxes.map((box) =>
    localBoxToWorldCollider(
      `${instanceId}:${box.name}:col`,
      instanceId,
      box,
      position,
      rotationY,
      'prop',
      mat,
    ),
  );
  if (assetId === 'kitchen_cabinet_01') {
    cols.push(...buildKitchenCabinetDoorColliders(instanceId, position, rotationY, openFraction));
  }
  return cols;
}

/**
 * Computes segmented hollow shell colliders + moving lid/door collider for any of the 3 loot containers.
 * Never uses `simpleClosed`.
 */
export function buildContainerAssetColliders(
  instanceId: string,
  assetId: ContainerAssetId,
  position: Vec3,
  rotationY: number,
  openFraction = 0,
): ColliderBox[] {
  const manifest = CONTAINER_MANIFESTS[assetId];
  const clamped = Math.max(0, Math.min(1, openFraction));
  const mat: MaterialKind = assetId === 'wooden_loot_crate_01' ? 'crate' : 'metal';

  const shellCols = manifest.shellSegments.map((seg) =>
    localBoxToWorldCollider(
      `${instanceId}:${seg.name}:col`,
      instanceId,
      seg,
      position,
      rotationY,
      'prop',
      mat,
    ),
  );

  const pivot = manifest.movingNode;
  const angle = pivot.closedAngleRad + (pivot.openAngleRad - pivot.closedAngleRad) * clamped;
  const localMoving = transformPivotBoxToModelLocal(pivot, manifest.movingPart, angle);
  const movingCol = localBoxToWorldCollider(
    `${instanceId}:${manifest.movingPart.name}:col`,
    instanceId,
    localMoving,
    position,
    rotationY,
    'prop',
    mat,
  );

  return [...shellCols, movingCol];
}

/**
 * Computes segmented world AABB colliders for any `BuildingAssetId` module.
 */
export function buildBuildingModuleColliders(
  instanceId: string,
  moduleId: BuildingAssetId,
  position: Vec3,
  rotationY: number,
  doorOpenAngleRad = 0,
): ColliderBox[] {
  if (moduleId === 'wood_door_01') {
    return [buildWoodDoorLeafCollider(instanceId, position, rotationY, doorOpenAngleRad)];
  }
  if (moduleId === 'wood_stairs_01') {
    return buildWoodStairsColliders(instanceId, position, rotationY);
  }
  const manifest = BUILDING_MANIFESTS[moduleId];
  const mat: MaterialKind =
    moduleId === 'wood_roof_slope_01'
      ? 'roof'
      : moduleId === 'wood_floor_01'
        ? 'crate'
        : 'wall';
  return manifest.colliderBoxes.map((box) =>
    localBoxToWorldCollider(
      `${instanceId}:${box.name}:col`,
      instanceId,
      box,
      position,
      rotationY,
      'structure',
      mat,
    ),
  );
}

/**
 * Checks whether a 3D point `p` (with optional sphere `radius`, default `0`) lies strictly inside any box.
 */
export function isPointInsideAnyBox(
  boxes: readonly Box[],
  p: Vec3,
  radius = 0,
): boolean {
  for (const b of boxes) {
    if (
      p.x + radius > b.min.x &&
      p.x - radius < b.max.x &&
      p.y + radius > b.min.y &&
      p.y - radius < b.max.y &&
      p.z + radius > b.min.z &&
      p.z - radius < b.max.z
    ) {
      return true;
    }
  }
  return false;
}

export function getStage04AAssetUrl(assetId: Stage04AAssetId): string {
  if (assetId in BUILDING_GLB_URLS) {
    return BUILDING_GLB_URLS[assetId as BuildingAssetId];
  }
  if (assetId in INTERIOR_GLB_URLS) {
    return INTERIOR_GLB_URLS[assetId as InteriorAssetId];
  }
  return CONTAINER_GLB_URLS[assetId as ContainerAssetId];
}

export {
  BUILDING_ASSET_IDS,
  INTERIOR_ASSET_IDS,
  CONTAINER_ASSET_IDS,
};
