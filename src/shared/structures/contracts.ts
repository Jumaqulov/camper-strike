import type { Vec3 } from '../math';
import type { OutdoorPlacement } from '../outdoor/contracts';
import type {
  ColliderBox,
  ContainerKind,
  ContainerLocation,
  LocationKind,
  PrefabPlacement,
  VisualDescriptor,
  WorldLocation,
} from '../world';

export const BUILDING_ASSET_IDS = [
  'wood_wall_01',
  'wood_wall_window_01',
  'wood_wall_door_01',
  'wood_floor_01',
  'wood_roof_slope_01',
  'wood_roof_gable_01',
  'wood_door_01',
  'wood_stairs_01',
] as const;

export type BuildingAssetId = (typeof BUILDING_ASSET_IDS)[number];

export const INTERIOR_ASSET_IDS = [
  'wooden_table_01',
  'wooden_chair_01',
  'wooden_shelf_01',
  'old_bed_01',
  'old_sofa_01',
  'kitchen_cabinet_01',
] as const;

export type InteriorAssetId = (typeof INTERIOR_ASSET_IDS)[number];

export const CONTAINER_ASSET_IDS = [
  'wooden_loot_crate_01',
  'metal_locker_01',
  'old_toolbox_01',
] as const;

export type ContainerAssetId = (typeof CONTAINER_ASSET_IDS)[number];

export const STAGE04A_ASSET_IDS = [
  ...BUILDING_ASSET_IDS,
  ...INTERIOR_ASSET_IDS,
  ...CONTAINER_ASSET_IDS,
] as const;

export type Stage04AAssetId = (typeof STAGE04A_ASSET_IDS)[number];

export type Stage04AMaterialName = 'wood' | 'roof' | 'iron' | 'fabric' | 'painted_metal';

export const BUILDING_GLB_URLS: Record<BuildingAssetId, string> = {
  wood_wall_01: '/models/buildings/wood_wall_01.glb',
  wood_wall_window_01: '/models/buildings/wood_wall_window_01.glb',
  wood_wall_door_01: '/models/buildings/wood_wall_door_01.glb',
  wood_floor_01: '/models/buildings/wood_floor_01.glb',
  wood_roof_slope_01: '/models/buildings/wood_roof_slope_01.glb',
  wood_roof_gable_01: '/models/buildings/wood_roof_gable_01.glb',
  wood_door_01: '/models/buildings/wood_door_01.glb',
  wood_stairs_01: '/models/buildings/wood_stairs_01.glb',
};

export const INTERIOR_GLB_URLS: Record<InteriorAssetId, string> = {
  wooden_table_01: '/models/interior/wooden_table_01.glb',
  wooden_chair_01: '/models/interior/wooden_chair_01.glb',
  wooden_shelf_01: '/models/interior/wooden_shelf_01.glb',
  old_bed_01: '/models/interior/old_bed_01.glb',
  old_sofa_01: '/models/interior/old_sofa_01.glb',
  kitchen_cabinet_01: '/models/interior/kitchen_cabinet_01.glb',
};

export const CONTAINER_GLB_URLS: Record<ContainerAssetId, string> = {
  wooden_loot_crate_01: '/models/loot/wooden_loot_crate_01.glb',
  metal_locker_01: '/models/loot/metal_locker_01.glb',
  old_toolbox_01: '/models/loot/old_toolbox_01.glb',
};

export interface LocalBoxSpec {
  name: string;
  center: [number, number, number];
  size: [number, number, number];
  rotationX?: number;
  rotationY?: number;
  /**
   * O'q uchun aniq uchburchak (gable) shakli: modul lokal fazosida asos yarim kengligi va asos/uch Y.
   * AABB o'zgarmaydi (harakat fizikasi), faqat raycast uchburchak ichida tegadi.
   */
  gable?: { halfWidth: number; baseY: number; apexY: number };
}

export interface PivotSpec {
  name: string;
  position: [number, number, number];
  axis: 'x' | 'y' | 'z';
  closedAngleRad: number;
  openAngleRad: number;
  openAngleDeg: number;
  movingMeshes: string[];
  collider?: LocalBoxSpec;
}

export type AnchorSurfaceCategory =
  | 'tabletop'
  | 'chair_seat'
  | 'shelf'
  | 'mattress'
  | 'under_bed'
  | 'sofa_seat'
  | 'countertop'
  | 'inside_cabinet'
  | 'inside_container';

export interface ItemAnchorSpec {
  name: string;
  position: [number, number, number];
  up: [number, number, number];
  category: AnchorSurfaceCategory;
  requiresOpenDoorOrLid?: boolean;
}

export interface PlaceableSurfaceSpec {
  name: string;
  y: number;
  center: [number, number, number];
  size: [number, number];
  clearHeight?: number;
  requiresOpenDoorOrLid?: boolean;
}

export interface WorldItemAnchor {
  id: string;
  name: string;
  sourceInstanceId: string;
  assetId: InteriorAssetId | ContainerAssetId;
  category: AnchorSurfaceCategory;
  localPosition: [number, number, number];
  worldPosition: Vec3;
  up: [number, number, number];
  requiresOpenDoorOrLid: boolean;
}

export interface BuildingModulePlacement {
  id: string;
  buildingId: string;
  moduleId: BuildingAssetId;
  position: Vec3;
  rotationY: number;
  hideCornerPost?: boolean;
  /** Extra standalone corner post placed at the open +X end of an interior partition wall if needed. */
  extraEndCornerPost?: boolean;
  /** Static door leaf rotation (rad) in public multiplayer rooms (e.g. 1.38 rad open inward). */
  doorOpenAngleRad?: number;
}

export interface BuildingPorchStepSpec {
  id: string;
  buildingId: string;
  position: Vec3;
  size: Vec3;
  rotationY: number;
}

export type BuildingPrefabKind = 'cabin_8x4' | 'room_4x4' | 'warehouse_8x4' | 'watchpost_4x4';

export interface BuildingPrefabPlacement {
  id: string;
  name: string;
  kind: BuildingPrefabKind;
  origin: Vec3;
  rotationY: number;
  floorY: number;
  gridWidthM: number;
  gridDepthM: number;
  modules: BuildingModulePlacement[];
  porchSteps: BuildingPorchStepSpec[];
}

export interface InteriorFurniturePlacement {
  id: string;
  buildingId: string;
  assetId: InteriorAssetId;
  position: Vec3;
  rotationY: number;
  /** Public room static state is 0 (closed) unless overridden in dev demo. */
  openFraction: number;
}

export interface ContainerVisualPlacement {
  id: string;
  locationId: string;
  assetId: ContainerAssetId;
  containerKind: ContainerKind;
  position: Vec3;
  rotationY: number;
  interactionRadius: number;
  /** Public room static state is 0 (closed) unless overridden in dev demo. */
  openFraction: number;
}

export interface Stage04APreviewLayout {
  buildings: BuildingPrefabPlacement[];
  buildingModules: BuildingModulePlacement[];
  porchSteps: BuildingPorchStepSpec[];
  interiors: InteriorFurniturePlacement[];
  containers: ContainerVisualPlacement[];
  outdoorPlacements?: OutdoorPlacement[];
  colliders: ColliderBox[];
  visuals: VisualDescriptor[];
  worldAnchors: WorldItemAnchor[];
  locations: WorldLocation[];
  containerLocations: ContainerLocation[];
}

// ---------------- Stage 04B: 256x256 Forest Square & Multi-Site POI Contracts ----------------

export const FOREST_SQUARE_SIZE = 256;
export const FOREST_SQUARE_HALF = FOREST_SQUARE_SIZE / 2; // 128
export const FOREST_SQUARE_CELL_SIZE = 2;

export type ForestSquarePoiId =
  | 'poi_ranger_house'
  | 'poi_cabin_cluster'
  | 'poi_lumber_mill'
  | 'poi_service_station'
  | 'poi_forest_camp'
  | 'poi_cliff_watch';

export const FOREST_SQUARE_POI_IDS: readonly ForestSquarePoiId[] = [
  'poi_ranger_house',
  'poi_cabin_cluster',
  'poi_lumber_mill',
  'poi_service_station',
  'poi_forest_camp',
  'poi_cliff_watch',
] as const;

export interface ForestSquarePoiSiteSpec {
  id: ForestSquarePoiId;
  name: string;
  kind: LocationKind;
  /** World XZ center of the flattened POI pad (deterministic function of seed). */
  center: { x: number; z: number };
  /** Target elevation (meters) of the flattened POI pad. */
  padElevation: number;
  /** Inner completely flat radius (meters) for buildings and courtyards. */
  flatRadius: number;
  /** Outer smooth blend radius (meters) into surrounding natural terrain. */
  blendRadius: number;
  /** Cardinal or custom orientation yaw (radians) of the POI site. */
  yaw: number;
  /** Road connection point at the edge of the POI courtyard/driveway. */
  roadAnchor: { x: number; z: number };
  /** Radius of the WorldLocation marker. */
  locationRadius: number;
  enterable: boolean;
}

export interface PoiBuildingBlueprint {
  localId: string;
  name: string;
  kind: BuildingPrefabKind;
  /** Offset of building's local (0,0,0) origin relative to POI center (in POI local space before POI yaw). */
  localOffset: Vec3;
  /** Rotation of the building relative to POI yaw (typically 0, Math.PI/2, Math.PI, -Math.PI/2). */
  localYaw: number;
  furniturePreset?: 'cabin_8x4' | 'room_4x4' | 'warehouse_8x4' | 'watchpost_4x4' | 'none';
}

export interface PoiContainerBlueprint {
  localId: string;
  assetId: ContainerAssetId;
  containerKind: ContainerKind;
  /** Position in POI local space (or relative to a building if buildingLocal is used). */
  localOffset: Vec3;
  localYaw: number;
}

export interface PoiSiteBlueprint {
  site: ForestSquarePoiSiteSpec;
  buildings: PoiBuildingBlueprint[];
  extraFurniture?: Array<{
    localId: string;
    buildingLocalId?: string;
    assetId: InteriorAssetId;
    localOffset: Vec3;
    localYaw: number;
  }>;
  containers: PoiContainerBlueprint[];
  proceduralProps?: PrefabPlacement[];
}

export type MultiSiteStructureLayout = Stage04APreviewLayout;

const q3Contract = (n: number): number => Math.round(n * 1000) / 1000;

function seedOffsetPair(seed: number, salt: number, maxShift: number): { dx: number; dz: number } {
  let h1 = Math.imul(seed ^ (salt * 374761393), 668265263);
  h1 = (h1 ^ (h1 >>> 13)) * 1274126177;
  const u = ((h1 ^ (h1 >>> 16)) >>> 0) / 4294967296;

  let h2 = Math.imul(seed ^ (salt * 1442695041 + 97), 374761393);
  h2 = (h2 ^ (h2 >>> 13)) * 1274126177;
  const v = ((h2 ^ (h2 >>> 16)) >>> 0) / 4294967296;

  // Quantize to 1.0m steps so grid alignment stays crisp while shifting across seeds
  const dx = Math.round((u * 2 - 1) * maxShift);
  const dz = Math.round((v * 2 - 1) * maxShift);
  return { dx, dz };
}

/**
 * Returns the 6 deterministic POI site specifications for `forest_square` (256x256 m).
 * Shared by terrain generation, road network routing, POI structure placement, and vegetation exclusion.
 */
export function getForestSquarePoiSites(seed = 6501): ForestSquarePoiSiteSpec[] {
  const s1 = seedOffsetPair(seed, 101, 4);
  const s2 = seedOffsetPair(seed, 202, 4);
  const s3 = seedOffsetPair(seed, 303, 4);
  const s4 = seedOffsetPair(seed, 404, 3);
  const s5 = seedOffsetPair(seed, 505, 4);
  const s6 = seedOffsetPair(seed, 606, 4);

  const c1 = { x: -68 + s1.dx, z: -64 + s1.dz };
  const c2 = { x: 64 + s2.dx, z: -62 + s2.dz };
  const c3 = { x: -74 + s3.dx, z: 14 + s3.dz };
  const c4 = { x: 18 + s4.dx, z: -8 + s4.dz };
  const c5 = { x: -58 + s5.dx, z: 70 + s5.dz };
  const c6 = { x: 66 + s6.dx, z: 66 + s6.dz };

  return [
    {
      id: 'poi_ranger_house',
      name: "O'rmonchi Uyi",
      kind: 'ranger_house',
      center: c1,
      padElevation: q3Contract(1.4 + ((seed % 5) - 2) * 0.08),
      flatRadius: 15,
      blendRadius: 26,
      yaw: 0,
      roadAnchor: { x: c1.x + 2, z: c1.z + 10 },
      locationRadius: 14,
      enterable: true,
    },
    {
      id: 'poi_cabin_cluster',
      name: 'Uylar Guruhi',
      kind: 'cabin_cluster',
      center: c2,
      padElevation: q3Contract(1.75 + ((seed % 7) - 3) * 0.06),
      flatRadius: 19,
      blendRadius: 30,
      yaw: 0,
      roadAnchor: { x: c2.x - 12, z: c2.z + 6 },
      locationRadius: 18,
      enterable: true,
    },
    {
      id: 'poi_lumber_mill',
      name: "Tashlandiq Yog'och Tilish Maydoni",
      kind: 'lumber_mill',
      center: c3,
      padElevation: q3Contract(0.95 + ((seed % 5) - 2) * 0.06),
      flatRadius: 18,
      blendRadius: 29,
      yaw: 0,
      roadAnchor: { x: c3.x + 12, z: c3.z },
      locationRadius: 17,
      enterable: true,
    },
    {
      id: 'poi_service_station',
      name: 'Eski Servis va Ombor',
      kind: 'service_station',
      center: c4,
      padElevation: q3Contract(0.65 + ((seed % 3) - 1) * 0.06),
      flatRadius: 18,
      blendRadius: 29,
      yaw: 0,
      roadAnchor: { x: c4.x - 12, z: c4.z },
      locationRadius: 17,
      enterable: true,
    },
    {
      id: 'poi_forest_camp',
      name: "O'rmon Kempingi",
      kind: 'camp',
      center: c5,
      padElevation: q3Contract(0.55 + ((seed % 5) - 2) * 0.05),
      flatRadius: 17,
      blendRadius: 28,
      yaw: 0,
      roadAnchor: { x: c5.x + 11, z: c5.z - 6 },
      locationRadius: 16,
      enterable: true,
    },
    {
      id: 'poi_cliff_watch',
      name: 'Qoya Kuzatuv va Xaroba Hududi',
      kind: 'stone_ruins',
      center: c6,
      padElevation: q3Contract(2.5 + ((seed % 5) - 2) * 0.08),
      flatRadius: 17,
      blendRadius: 28,
      yaw: 0,
      roadAnchor: { x: c6.x - 11, z: c6.z - 6 },
      locationRadius: 16,
      enterable: true,
    },
  ];
}
