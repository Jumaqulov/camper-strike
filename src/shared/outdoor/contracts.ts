import type { Vec3 } from '../math';
import type { ForestSquarePoiId } from '../structures/contracts';
import type { ColliderBox, VisualDescriptor } from '../world';

export const OUTDOOR_ASSET_IDS = [
  'wooden_signpost_01',
  'lumber_stack_01',
  'sawhorse_01',
  'old_fuel_pump_01',
  'rusty_barrel_01',
  'forest_tent_01',
  'campfire_pit_01',
  'wooden_railing_01',
] as const;

export type OutdoorAssetId = (typeof OUTDOOR_ASSET_IDS)[number];

export const OUTDOOR_GLB_URLS: Record<OutdoorAssetId, string> = {
  wooden_signpost_01: '/models/outdoor/wooden_signpost_01.glb',
  lumber_stack_01: '/models/outdoor/lumber_stack_01.glb',
  sawhorse_01: '/models/outdoor/sawhorse_01.glb',
  old_fuel_pump_01: '/models/outdoor/old_fuel_pump_01.glb',
  rusty_barrel_01: '/models/outdoor/rusty_barrel_01.glb',
  forest_tent_01: '/models/outdoor/forest_tent_01.glb',
  campfire_pit_01: '/models/outdoor/campfire_pit_01.glb',
  wooden_railing_01: '/models/outdoor/wooden_railing_01.glb',
};

export type OutdoorMaterialName = 'wood' | 'stone' | 'iron' | 'fabric' | 'painted_metal';

export type OutdoorAssetCategory =
  | 'navigation_prop'
  | 'industrial_prop'
  | 'service_station_prop'
  | 'camp_structure'
  | 'camp_prop'
  | 'modular_architecture';

export const SIGNPOST_ANCHOR_NAMES = [
  'sign_1_text_front',
  'sign_1_text_back',
  'sign_2_text_front',
  'sign_2_text_back',
  'sign_3_text_front',
  'sign_3_text_back',
] as const;

export type OutdoorSignpostAnchorName = (typeof SIGNPOST_ANCHOR_NAMES)[number];

export interface OutdoorSignpostAnchorSpec {
  name: OutdoorSignpostAnchorName;
  boardIndex: 1 | 2 | 3;
  side: 'front' | 'back';
  position: [number, number, number];
  boardYawDeg: number;
}

export interface OutdoorSignpostBoardLabel {
  boardIndex: 1 | 2 | 3;
  textFront: string;
  textBack?: string;
  subtitle?: string;
}

export type OutdoorSiteId = ForestSquarePoiId | 'loc_sq_central_crossroads';

export interface OutdoorPlacement {
  /** Globally unique deterministic ID, e.g. `poi:poi_lumber_mill:out_0:lumber_stack_01` */
  id: string;
  /** Parent POI ID or `loc_sq_central_crossroads` */
  siteId: OutdoorSiteId;
  assetId: OutdoorAssetId;
  /** World-space origin position (with terrain/pad/deck Y already resolved) */
  position: Vec3;
  /** World-space Y rotation (yaw in radians) */
  rotationY: number;
  /** Optional X tilt in radians */
  rotationX?: number;
  /** Optional Z tilt in radians (e.g. `Math.PI / 2` for a tipped barrel) */
  rotationZ?: number;
  /** Scale vector (defaults to `{ x: 1, y: 1, z: 1 }`) */
  scale: Vec3;
  /** True when placed on an elevated structure/island/deck rather than raw terrain */
  elevatedSurface?: boolean;
  /** For `wooden_railing_01`: hides `railing_post_start` when chained end-to-end */
  hideStartPost?: boolean;
  /** For `wooden_signpost_01`: Uzbek directional labels on the 3 signboards */
  signLabels?: OutdoorSignpostBoardLabel[];
  /** For `campfire_pit_01`: whether stylized low-poly flame/glow is active at `fire_anchor` */
  campfireLit?: boolean;
  /** Semantic role tag for diagnostics and QA */
  role?: string;
}

export interface OutdoorAssetManifestEntry {
  code: string;
  assetId: OutdoorAssetId;
  glbUrl: string;
  category: OutdoorAssetCategory;
  expectedTriangles: number;
  expectedVertices: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  dimensions: [number, number, number];
  groundSinkY: number;
  meshNames: readonly string[];
  materials: readonly OutdoorMaterialName[];
  maxDrawDistance: number;
  lodSphereRadius: number;
}

export const SIGNPOST_TEXT_ANCHORS: readonly OutdoorSignpostAnchorSpec[] = [
  {
    name: 'sign_1_text_front',
    boardIndex: 1,
    side: 'front',
    position: [0.34, 1.72, -0.004],
    boardYawDeg: 10,
  },
  {
    name: 'sign_1_text_back',
    boardIndex: 1,
    side: 'back',
    position: [0.33, 1.72, -0.043],
    boardYawDeg: 10,
  },
  {
    name: 'sign_2_text_front',
    boardIndex: 2,
    side: 'front',
    position: [-0.298, 1.5, 0.039],
    boardYawDeg: -165,
  },
  {
    name: 'sign_2_text_back',
    boardIndex: 2,
    side: 'back',
    position: [-0.283, 1.5, 0.076],
    boardYawDeg: -165,
  },
  {
    name: 'sign_3_text_front',
    boardIndex: 3,
    side: 'front',
    position: [0.135, 1.28, -0.236],
    boardYawDeg: 65,
  },
  {
    name: 'sign_3_text_back',
    boardIndex: 3,
    side: 'back',
    position: [0.096, 1.28, -0.245],
    boardYawDeg: 65,
  },
] as const;

export const CAMPFIRE_FIRE_ANCHOR_LOCAL: readonly [number, number, number] = [0, 0.15, 0] as const;

export const OUTDOOR_ASSET_MANIFEST: Record<OutdoorAssetId, OutdoorAssetManifestEntry> = {
  wooden_signpost_01: {
    code: 'OUT-001',
    assetId: 'wooden_signpost_01',
    glbUrl: OUTDOOR_GLB_URLS.wooden_signpost_01,
    category: 'navigation_prop',
    expectedTriangles: 586,
    expectedVertices: 1758,
    boundsMin: [-0.623, -0.05, -0.562],
    boundsMax: [0.722, 2.07, 0.249],
    dimensions: [1.345, 2.12, 0.811],
    groundSinkY: -0.05,
    meshNames: ['wooden_signpost_01_wood', 'wooden_signpost_01_rocks'],
    materials: ['wood', 'stone'],
    maxDrawDistance: 135,
    lodSphereRadius: 1.6,
  },
  lumber_stack_01: {
    code: 'OUT-002',
    assetId: 'lumber_stack_01',
    glbUrl: OUTDOOR_GLB_URLS.lumber_stack_01,
    category: 'industrial_prop',
    expectedTriangles: 688,
    expectedVertices: 2064,
    boundsMin: [-1.129, -0.103, -0.695],
    boundsMax: [1.14, 1.003, 0.695],
    dimensions: [2.269, 1.106, 1.39],
    groundSinkY: -0.103,
    meshNames: ['lumber_stack_01_wood'],
    materials: ['wood'],
    maxDrawDistance: 145,
    lodSphereRadius: 1.9,
  },
  sawhorse_01: {
    code: 'OUT-003',
    assetId: 'sawhorse_01',
    glbUrl: OUTDOOR_GLB_URLS.sawhorse_01,
    category: 'industrial_prop',
    expectedTriangles: 480,
    expectedVertices: 1440,
    boundsMin: [-0.779, -0.011, -0.418],
    boundsMax: [0.779, 1.016, 0.415],
    dimensions: [1.558, 1.028, 0.833],
    groundSinkY: -0.011,
    meshNames: ['sawhorse_01_wood', 'sawhorse_01_metal'],
    materials: ['wood', 'iron'],
    maxDrawDistance: 125,
    lodSphereRadius: 1.35,
  },
  old_fuel_pump_01: {
    code: 'OUT-004',
    assetId: 'old_fuel_pump_01',
    glbUrl: OUTDOOR_GLB_URLS.old_fuel_pump_01,
    category: 'service_station_prop',
    expectedTriangles: 1510,
    expectedVertices: 4530,
    boundsMin: [-0.35, 0, -0.3],
    boundsMax: [0.39, 1.6, 0.3],
    dimensions: [0.74, 1.6, 0.6],
    groundSinkY: 0,
    meshNames: ['old_fuel_pump_01_body', 'old_fuel_pump_01_metal', 'old_fuel_pump_01_base'],
    materials: ['painted_metal', 'iron', 'stone'],
    maxDrawDistance: 140,
    lodSphereRadius: 1.5,
  },
  rusty_barrel_01: {
    code: 'OUT-005',
    assetId: 'rusty_barrel_01',
    glbUrl: OUTDOOR_GLB_URLS.rusty_barrel_01,
    category: 'industrial_prop',
    expectedTriangles: 912,
    expectedVertices: 2736,
    boundsMin: [-0.298, 0, -0.291],
    boundsMax: [0.298, 0.895, 0.291],
    dimensions: [0.596, 0.895, 0.581],
    groundSinkY: 0,
    meshNames: ['rusty_barrel_01_body'],
    materials: ['painted_metal'],
    maxDrawDistance: 130,
    lodSphereRadius: 0.95,
  },
  forest_tent_01: {
    code: 'OUT-006',
    assetId: 'forest_tent_01',
    glbUrl: OUTDOOR_GLB_URLS.forest_tent_01,
    category: 'camp_structure',
    expectedTriangles: 524,
    expectedVertices: 1572,
    boundsMin: [-1.097, -0.048, -1.332],
    boundsMax: [1.097, 1.63, 1.283],
    dimensions: [2.193, 1.678, 2.615],
    groundSinkY: -0.048,
    meshNames: ['forest_tent_01_fabric', 'forest_tent_01_poles'],
    materials: ['fabric', 'wood'],
    maxDrawDistance: 155,
    lodSphereRadius: 2.35,
  },
  campfire_pit_01: {
    code: 'OUT-007',
    assetId: 'campfire_pit_01',
    glbUrl: OUTDOOR_GLB_URLS.campfire_pit_01,
    category: 'camp_prop',
    expectedTriangles: 1462,
    expectedVertices: 4386,
    boundsMin: [-0.683, -0.02, -0.683],
    boundsMax: [0.685, 0.385, 0.689],
    dimensions: [1.368, 0.405, 1.371],
    groundSinkY: -0.02,
    meshNames: ['campfire_pit_01_stones', 'campfire_pit_01_logs'],
    materials: ['stone', 'wood'],
    maxDrawDistance: 125,
    lodSphereRadius: 1.15,
  },
  wooden_railing_01: {
    code: 'OUT-008',
    assetId: 'wooden_railing_01',
    glbUrl: OUTDOOR_GLB_URLS.wooden_railing_01,
    category: 'modular_architecture',
    expectedTriangles: 164,
    expectedVertices: 492,
    boundsMin: [-1.56, -0.15, -0.06],
    boundsMax: [1.5, 1.2, 0.101],
    dimensions: [3.06, 1.35, 0.161],
    groundSinkY: -0.15,
    meshNames: ['wooden_railing_01_body', 'railing_post_start', 'wooden_railing_01_metal'],
    materials: ['wood', 'iron'],
    maxDrawDistance: 140,
    lodSphereRadius: 1.9,
  },
};

export interface OutdoorLayoutResult {
  placements: OutdoorPlacement[];
  colliders: ColliderBox[];
  visuals: VisualDescriptor[];
}
