import { q3, type Vec3 } from '../math';
import { sampleTerrainHeight } from '../terrain';
import {
  DEFAULT_CHUNK_SIZE,
  getChunkCoord,
  type ColliderBox,
  type ContainerLocation,
  type TerrainDescriptor,
  type VisualDescriptor,
  type WorldLocation,
} from '../world';
import type {
  BuildingAssetId,
  BuildingModulePlacement,
  BuildingPorchStepSpec,
  BuildingPrefabPlacement,
  ContainerAssetId,
  ContainerVisualPlacement,
  InteriorAssetId,
  InteriorFurniturePlacement,
  Stage04APreviewLayout,
  WorldItemAnchor,
} from './contracts';
import {
  BUILDING_MANIFESTS,
  CONTAINER_MANIFESTS,
  INTERIOR_MANIFESTS,
  buildBuildingModuleColliders,
  buildContainerAssetColliders,
  buildInteriorAssetColliders,
} from './manifests';


/**
 * Computes the wall module placement transform between grid nodes `(ax, az)` and `(bx, bz)` at elevation `y`.
 * Matches the BUILDING-ASSET-01 specification:
 * - `position`: midpoint `((ax + bx) / 2, y, (az + bz) / 2)`
 * - `rotationY`: `Math.atan2(-(bz - az), bx - ax)`
 * - Exterior face (+Z in local space) is to the right of the directed edge `a -> b`, and `corner_post` sits at `a`.
 */
export function placeWallTransform(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y = 0,
): { position: Vec3; rotationY: number } {
  return {
    position: {
      x: q3((ax + bx) / 2),
      y: q3(y),
      z: q3((az + bz) / 2),
    },
    rotationY: q3(Math.atan2(-(bz - az), bx - ax)),
  };
}

/**
 * Builds the 8x4 m two-story loft cabin prefab (`examples/sample_cabin_layout.json`; 17 base modules +
 * 6 second-floor walls = 23 building modules, roof at y = 6.0)
 * plus entrance porch step-up pads (`porchSteps`) outside the front doorway at `(origin.x + 2, origin.y, origin.z + 4)`.
 */
export function buildCabin8x4Prefab(
  origin: Vec3,
  idPrefix = 'cabin_8x4',
): BuildingPrefabPlacement {
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;

  const addMod = (
    index: number,
    moduleId: BuildingAssetId,
    lx: number,
    ly: number,
    lz: number,
    rotationY: number,
    extra: Partial<Pick<BuildingModulePlacement, 'doorOpenAngleRad' | 'hideCornerPost' | 'extraEndCornerPost'>> = {},
  ): BuildingModulePlacement => ({
    id: `${idPrefix}:mod_${String(index).padStart(2, '0')}:${moduleId}`,
    buildingId: idPrefix,
    moduleId,
    position: { x: q3(ox + lx), y: q3(oy + ly), z: q3(oz + lz) },
    rotationY: q3(rotationY),
    ...extra,
  });

  const wWest = placeWallTransform(0, 0, 0, 4, 0);
  const wSouthWestDoor = placeWallTransform(0, 4, 4, 4, 0);
  const wSouthEastWin = placeWallTransform(4, 4, 8, 4, 0);
  const wEast = placeWallTransform(8, 4, 8, 0, 0);
  const wNorthEastWin = placeWallTransform(8, 0, 4, 0, 0);
  const wNorthWest = placeWallTransform(4, 0, 0, 0, 0);
  // Ikkinchi qavat devorlari (y = 3.0), birinchi qavat bilan bir xil perimetr
  const wWest2 = placeWallTransform(0, 0, 0, 4, 3);
  const wSouthWest2 = placeWallTransform(0, 4, 4, 4, 3);
  const wSouthEast2 = placeWallTransform(4, 4, 8, 4, 3);
  const wEast2 = placeWallTransform(8, 4, 8, 0, 3);
  const wNorthEast2 = placeWallTransform(8, 0, 4, 0, 3);
  const wNorthWest2 = placeWallTransform(4, 0, 0, 0, 3);

  const modules: BuildingModulePlacement[] = [
    // 1-2. Ground floor 4x4 slabs (y = 0)
    addMod(1, 'wood_floor_01', 2, 0, 2, 0),
    addMod(2, 'wood_floor_01', 6, 0, 2, 0),
    // 3. Second-floor loft slab (y = 3.0)
    addMod(3, 'wood_floor_01', 6, 3, 2, 0),
    // 4-9. Perimeter walls (CCW around (0,0)->(0,4)->(8,4)->(8,0)->(0,0))
    addMod(4, 'wood_wall_window_01', wWest.position.x, wWest.position.y, wWest.position.z, wWest.rotationY),
    addMod(
      5,
      'wood_wall_door_01',
      wSouthWestDoor.position.x,
      wSouthWestDoor.position.y,
      wSouthWestDoor.position.z,
      wSouthWestDoor.rotationY,
    ),
    addMod(
      6,
      'wood_wall_window_01',
      wSouthEastWin.position.x,
      wSouthEastWin.position.y,
      wSouthEastWin.position.z,
      wSouthEastWin.rotationY,
    ),
    addMod(7, 'wood_wall_01', wEast.position.x, wEast.position.y, wEast.position.z, wEast.rotationY),
    addMod(
      8,
      'wood_wall_window_01',
      wNorthEastWin.position.x,
      wNorthEastWin.position.y,
      wNorthEastWin.position.z,
      wNorthEastWin.rotationY,
    ),
    addMod(
      9,
      'wood_wall_01',
      wNorthWest.position.x,
      wNorthWest.position.y,
      wNorthWest.position.z,
      wNorthWest.rotationY,
    ),
    // 10. Open front door leaf (1.38 rad inward)
    addMod(10, 'wood_door_01', 2, 0, 4, 0, { doorOpenAngleRad: 1.38 }),
    // 11-12. Roof gables at x = 0 and x = 8 (y = 6.0 — ikkinchi qavat devorlari ustida; avval y = 3.0 da bo'lib,
    // loft tomi 1.64 m balandlikda edi: o'yinchi boshi tomdan chiqib, sakrab tom ustiga chiqib tushib ketardi)
    addMod(11, 'wood_roof_gable_01', 0, 6, 2, -Math.PI / 2),
    addMod(12, 'wood_roof_gable_01', 8, 6, 2, Math.PI / 2),
    // 13-16. Roof slopes (y = 6.0)
    addMod(13, 'wood_roof_slope_01', 2, 6, 2, 0),
    addMod(14, 'wood_roof_slope_01', 2, 6, 2, Math.PI),
    addMod(15, 'wood_roof_slope_01', 6, 6, 2, 0),
    addMod(16, 'wood_roof_slope_01', 6, 6, 2, Math.PI),
    // 17. Interior stairs ascending from (0.15, 0, 0.85) toward +X loft at (4.15, 3.0, 0.85)
    addMod(17, 'wood_stairs_01', 0.15, 0, 0.85, -Math.PI / 2),
    // 18-23. Ikkinchi qavat devorlari (y = 3.0): loft to'liq balandlikdagi xona bo'ladi (3 m bosh balandligi).
    // G'arbiy yarim (x 0..4) ustidagi devorlar ochiq zal ustida turadi (ikki qavatli zal, loft unga qaraydi).
    addMod(18, 'wood_wall_window_01', wWest2.position.x, wWest2.position.y, wWest2.position.z, wWest2.rotationY),
    addMod(19, 'wood_wall_01', wSouthWest2.position.x, wSouthWest2.position.y, wSouthWest2.position.z, wSouthWest2.rotationY),
    addMod(20, 'wood_wall_window_01', wSouthEast2.position.x, wSouthEast2.position.y, wSouthEast2.position.z, wSouthEast2.rotationY),
    addMod(21, 'wood_wall_window_01', wEast2.position.x, wEast2.position.y, wEast2.position.z, wEast2.rotationY),
    addMod(22, 'wood_wall_window_01', wNorthEast2.position.x, wNorthEast2.position.y, wNorthEast2.position.z, wNorthEast2.rotationY),
    addMod(23, 'wood_wall_01', wNorthWest2.position.x, wNorthWest2.position.y, wNorthWest2.position.z, wNorthWest2.rotationY),
  ];

  // Porch steps outside the south doorway (x = ox + 2, z = oz + 4) so player can walk in/out smoothly
  const porchSteps: BuildingPorchStepSpec[] = [
    {
      id: `${idPrefix}:porch_step_upper`,
      buildingId: idPrefix,
      position: { x: q3(ox + 2.0), y: q3(oy - 0.1), z: q3(oz + 4.65) },
      size: { x: 2.6, y: 0.2, z: 1.3 },
      rotationY: 0,
    },
    {
      id: `${idPrefix}:porch_step_lower`,
      buildingId: idPrefix,
      position: { x: q3(ox + 2.0), y: q3(oy - 0.26), z: q3(oz + 5.75) },
      size: { x: 2.6, y: 0.2, z: 1.1 },
      rotationY: 0,
    },
  ];

  return {
    id: idPrefix,
    name: 'Modulli Yog‘och Kulba (8×4m)',
    kind: 'cabin_8x4',
    origin: { x: q3(ox), y: q3(oy), z: q3(oz) },
    rotationY: 0,
    floorY: q3(oy),
    gridWidthM: 8,
    gridDepthM: 4,
    modules,
    porchSteps,
  };
}

/**
 * Builds the 4x4 m test room prefab (`examples/sample_room_layout.json`) with floor, 4 walls
 * (south door, west window, east & north solid walls), open door (`1.35 rad`), roof gables/slopes,
 * and entrance porch steps.
 */
export function buildRoom4x4Prefab(
  origin: Vec3,
  idPrefix = 'room_4x4',
): BuildingPrefabPlacement {
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;

  const addMod = (
    index: number,
    moduleId: BuildingAssetId,
    lx: number,
    ly: number,
    lz: number,
    rotationY: number,
    extra: Partial<Pick<BuildingModulePlacement, 'doorOpenAngleRad'>> = {},
  ): BuildingModulePlacement => ({
    id: `${idPrefix}:mod_${String(index).padStart(2, '0')}:${moduleId}`,
    buildingId: idPrefix,
    moduleId,
    position: { x: q3(ox + lx), y: q3(oy + ly), z: q3(oz + lz) },
    rotationY: q3(rotationY),
    ...extra,
  });

  const wWestWin = placeWallTransform(0, 0, 0, 4, 0);
  const wSouthDoor = placeWallTransform(0, 4, 4, 4, 0);
  const wEastSolid = placeWallTransform(4, 4, 4, 0, 0);
  const wNorthSolid = placeWallTransform(4, 0, 0, 0, 0);

  const modules: BuildingModulePlacement[] = [
    addMod(1, 'wood_floor_01', 2, 0, 2, 0),
    addMod(2, 'wood_wall_window_01', wWestWin.position.x, wWestWin.position.y, wWestWin.position.z, wWestWin.rotationY),
    addMod(3, 'wood_wall_door_01', wSouthDoor.position.x, wSouthDoor.position.y, wSouthDoor.position.z, wSouthDoor.rotationY),
    addMod(4, 'wood_door_01', 2, 0, 4, 0, { doorOpenAngleRad: 1.35 }),
    addMod(5, 'wood_wall_01', wEastSolid.position.x, wEastSolid.position.y, wEastSolid.position.z, wEastSolid.rotationY),
    addMod(6, 'wood_wall_01', wNorthSolid.position.x, wNorthSolid.position.y, wNorthSolid.position.z, wNorthSolid.rotationY),
    addMod(7, 'wood_roof_gable_01', 0, 3, 2, -Math.PI / 2),
    addMod(8, 'wood_roof_gable_01', 4, 3, 2, Math.PI / 2),
    addMod(9, 'wood_roof_slope_01', 2, 3, 2, 0),
    addMod(10, 'wood_roof_slope_01', 2, 3, 2, Math.PI),
  ];

  const porchSteps: BuildingPorchStepSpec[] = [
    {
      id: `${idPrefix}:porch_step_upper`,
      buildingId: idPrefix,
      position: { x: q3(ox + 2.0), y: q3(oy - 0.1), z: q3(oz + 4.65) },
      size: { x: 2.6, y: 0.2, z: 1.3 },
      rotationY: 0,
    },
    {
      id: `${idPrefix}:porch_step_lower`,
      buildingId: idPrefix,
      position: { x: q3(ox + 2.0), y: q3(oy - 0.26), z: q3(oz + 5.75) },
      size: { x: 2.6, y: 0.2, z: 1.1 },
      rotationY: 0,
    },
  ];

  return {
    id: idPrefix,
    name: 'Jihozlangan Sinov Xonasi (4×4m)',
    kind: 'room_4x4',
    origin: { x: q3(ox), y: q3(oy), z: q3(oz) },
    rotationY: 0,
    floorY: q3(oy),
    gridWidthM: 4,
    gridDepthM: 4,
    modules,
    porchSteps,
  };
}

/**
 * Builds the 6 furniture types (7 instances) inside the 4x4 room (`examples/sample_room_layout.json`).
 * `kitchen_cabinet_01` is positioned at `(0.38, 0, 3.10)` so that even when both cabinet doors are
 * 100% open (`-1.75 / +1.75 rad`), the central player walkway (`x in [1.50, 2.45], z in [1.20, 4.0]`)
 * remains completely unobstructed for `PLAYER_RADIUS = 0.38..0.40`.
 */
export function buildRoom4x4Furniture(
  origin: Vec3,
  buildingId = 'room_4x4',
  cabinetOpenFraction = 0,
): InteriorFurniturePlacement[] {
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;

  const item = (
    suffix: string,
    assetId: InteriorAssetId,
    lx: number,
    ly: number,
    lz: number,
    rotationY: number,
    openFraction = 0,
  ): InteriorFurniturePlacement => ({
    id: `${buildingId}:furn_${suffix}`,
    buildingId,
    assetId,
    position: { x: q3(ox + lx), y: q3(oy + ly), z: q3(oz + lz) },
    rotationY: q3(rotationY),
    openFraction,
  });

  return [
    item('shelf_01', 'wooden_shelf_01', 0.7, 0, 0.335, 0),
    item('bed_01', 'old_bed_01', 2.84, 0, 0.61, 0),
    item('sofa_01', 'old_sofa_01', 0.535, 0, 1.45, Math.PI / 2),
    item('cabinet_01', 'kitchen_cabinet_01', 0.38, 0, 3.1, Math.PI / 2, cabinetOpenFraction),
    item('table_01', 'wooden_table_01', 3.46, 0, 2.0, -Math.PI / 2),
    item('chair_01', 'wooden_chair_01', 2.75, 0, 1.75, Math.PI / 2),
    item('chair_02', 'wooden_chair_01', 3.45, 0, 3.05, Math.PI),
  ];
}

/**
 * Builds interior furniture placements inside the 8x4 cabin (ground floor + y=3.0 loft).
 * Keeps the entrance doorway `(2, 0, 4)`, stair approach `(0.52, 0, 0.85)`, stairs, and loft landing clear.
 */
export function buildCabin8x4Furniture(
  origin: Vec3,
  buildingId = 'cabin_8x4',
  cabinetOpenFraction = 0,
): InteriorFurniturePlacement[] {
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;

  const item = (
    suffix: string,
    assetId: InteriorAssetId,
    lx: number,
    ly: number,
    lz: number,
    rotationY: number,
    openFraction = 0,
  ): InteriorFurniturePlacement => ({
    id: `${buildingId}:furn_${suffix}`,
    buildingId,
    assetId,
    position: { x: q3(ox + lx), y: q3(oy + ly), z: q3(oz + lz) },
    rotationY: q3(rotationY),
    openFraction,
  });

  return [
    item('table_01', 'wooden_table_01', 5.8, 0, 0.65, 0),
    item('chair_01', 'wooden_chair_01', 5.8, 0, 1.35, Math.PI),
    item('cabinet_01', 'kitchen_cabinet_01', 7.55, 0, 1.25, -Math.PI / 2, cabinetOpenFraction),
    item('sofa_01', 'old_sofa_01', 5.8, 0, 3.4, Math.PI),
    item('shelf_01', 'wooden_shelf_01', 3.4, 0, 3.65, Math.PI),
    // Loft bed on the 2nd floor (y = 3.0)
    item('loft_bed_01', 'old_bed_01', 6.8, 3.0, 3.3, 0),
  ];
}

/**
 * Builds loot container placements (all 3 container GLBs) across the 8x4 cabin and 4x4 room.
 */
export function buildStage04AContainers(
  cabinOrigin: Vec3,
  roomOrigin: Vec3,
  openFraction = 0,
  cabinLocationId = 'loc_stage04a_cabin_8x4',
  roomLocationId = 'loc_stage04a_room_4x4',
): ContainerVisualPlacement[] {
  return [
    {
      id: 'cnt_cabin_crate_01',
      locationId: cabinLocationId,
      assetId: 'wooden_loot_crate_01',
      containerKind: 'supply_crate',
      position: {
        x: q3(cabinOrigin.x + 7.35),
        y: q3(cabinOrigin.y),
        z: q3(cabinOrigin.z + 3.45),
      },
      rotationY: q3(Math.PI),
      interactionRadius: CONTAINER_MANIFESTS.wooden_loot_crate_01.interactionRadius,
      openFraction,
    },
    {
      id: 'cnt_cabin_locker_01',
      locationId: cabinLocationId,
      assetId: 'metal_locker_01',
      containerKind: 'weapon_locker',
      position: {
        x: q3(cabinOrigin.x + 4.35),
        y: q3(cabinOrigin.y),
        z: q3(cabinOrigin.z + 0.42),
      },
      rotationY: 0,
      interactionRadius: CONTAINER_MANIFESTS.metal_locker_01.interactionRadius,
      openFraction,
    },
    {
      id: 'cnt_cabin_toolbox_01',
      locationId: cabinLocationId,
      assetId: 'old_toolbox_01',
      containerKind: 'ammo_box',
      position: {
        x: q3(cabinOrigin.x + 5.8),
        y: q3(cabinOrigin.y + 0.75),
        z: q3(cabinOrigin.z + 0.65),
      },
      rotationY: 0,
      interactionRadius: CONTAINER_MANIFESTS.old_toolbox_01.interactionRadius,
      openFraction,
    },
    {
      id: 'cnt_room_crate_01',
      locationId: roomLocationId,
      assetId: 'wooden_loot_crate_01',
      containerKind: 'supply_crate',
      position: {
        x: q3(roomOrigin.x + 3.42),
        y: q3(roomOrigin.y),
        z: q3(roomOrigin.z + 3.55),
      },
      rotationY: q3(Math.PI),
      interactionRadius: CONTAINER_MANIFESTS.wooden_loot_crate_01.interactionRadius,
      openFraction,
    },
    {
      id: 'cnt_room_locker_01',
      locationId: roomLocationId,
      assetId: 'metal_locker_01',
      containerKind: 'weapon_locker',
      position: {
        x: q3(roomOrigin.x + 1.5),
        y: q3(roomOrigin.y),
        z: q3(roomOrigin.z + 0.38),
      },
      rotationY: 0,
      interactionRadius: CONTAINER_MANIFESTS.metal_locker_01.interactionRadius,
      openFraction,
    },
    {
      id: 'cnt_room_toolbox_01',
      locationId: roomLocationId,
      assetId: 'old_toolbox_01',
      containerKind: 'ammo_box',
      position: {
        x: q3(roomOrigin.x + 3.46),
        y: q3(roomOrigin.y + 0.75),
        z: q3(roomOrigin.z + 2.0),
      },
      rotationY: q3(-Math.PI / 2),
      interactionRadius: CONTAINER_MANIFESTS.old_toolbox_01.interactionRadius,
      openFraction,
    },
  ];
}

/**
 * Compiles all segmented world `ColliderBox[]` for a `BuildingPrefabPlacement` (modules + porchSteps).
 */
export function compileBuildingPrefabColliders(prefab: BuildingPrefabPlacement): ColliderBox[] {
  const colliders: ColliderBox[] = [];

  for (const mod of prefab.modules) {
    colliders.push(
      ...buildBuildingModuleColliders(
        mod.id,
        mod.moduleId,
        mod.position,
        mod.rotationY,
        mod.doorOpenAngleRad ?? 0,
      ),
    );
  }

  for (const step of prefab.porchSteps) {
    const hx = step.size.x / 2;
    const hy = step.size.y / 2;
    const hz = step.size.z / 2;
    colliders.push({
      id: `${step.id}:col`,
      sourceObjectId: step.id,
      tag: 'structure',
      mat: 'crate',
      min: {
        x: q3(step.position.x - hx),
        y: q3(step.position.y - hy),
        z: q3(step.position.z - hz),
      },
      max: {
        x: q3(step.position.x + hx),
        y: q3(step.position.y + hy),
        z: q3(step.position.z + hz),
      },
    });
  }

  return colliders;
}

/**
 * Transforms model-local `itemAnchors` of an interior furniture placement into `WorldItemAnchor[]`.
 */
export function compileInteriorPlacementAnchors(
  placement: InteriorFurniturePlacement,
): WorldItemAnchor[] {
  const manifest = INTERIOR_MANIFESTS[placement.assetId];
  const cos = Math.cos(placement.rotationY);
  const sin = Math.sin(placement.rotationY);

  return manifest.itemAnchors.map((anchor) => {
    const [lx, ly, lz] = anchor.position;
    const rx = lx * cos + lz * sin;
    const rz = -lx * sin + lz * cos;
    return {
      id: `${placement.id}:anchor:${anchor.name}`,
      name: anchor.name,
      sourceInstanceId: placement.id,
      assetId: placement.assetId,
      category: anchor.category,
      localPosition: [lx, ly, lz],
      worldPosition: {
        x: q3(placement.position.x + rx),
        y: q3(placement.position.y + ly),
        z: q3(placement.position.z + rz),
      },
      up: [...anchor.up],
      requiresOpenDoorOrLid: Boolean(anchor.requiresOpenDoorOrLid),
    };
  });
}

/**
 * Transforms model-local `itemAnchors` of a loot container placement into `WorldItemAnchor[]`.
 */
export function compileContainerPlacementAnchors(
  placement: ContainerVisualPlacement,
): WorldItemAnchor[] {
  const manifest = CONTAINER_MANIFESTS[placement.assetId];
  const cos = Math.cos(placement.rotationY);
  const sin = Math.sin(placement.rotationY);

  return manifest.itemAnchors.map((anchor) => {
    const [lx, ly, lz] = anchor.position;
    const rx = lx * cos + lz * sin;
    const rz = -lx * sin + lz * cos;
    return {
      id: `${placement.id}:anchor:${anchor.name}`,
      name: anchor.name,
      sourceInstanceId: placement.id,
      assetId: placement.assetId,
      category: anchor.category,
      localPosition: [lx, ly, lz],
      worldPosition: {
        x: q3(placement.position.x + rx),
        y: q3(placement.position.y + ly),
        z: q3(placement.position.z + rz),
      },
      up: [...anchor.up],
      requiresOpenDoorOrLid: Boolean(anchor.requiresOpenDoorOrLid ?? true),
    };
  });
}

function buildModuleVisualDescriptor(
  mod: BuildingModulePlacement,
  chunkSize: number,
): VisualDescriptor {
  const manifest = BUILDING_MANIFESTS[mod.moduleId];
  const chunk = getChunkCoord(mod.position.x, mod.position.z, chunkSize);
  return {
    id: `${mod.id}:vis`,
    sourceObjectId: mod.id,
    prefabId: `glb:building:${mod.moduleId}`,
    category: 'structure',
    batchKey: `glb:building:${mod.moduleId}`,
    batchMode: 'prefab_group',
    chunkKey: chunk.key,
    lod: 'all',
    maxDrawDistance: 300,
    transform: {
      position: { ...mod.position },
      yaw: mod.rotationY,
      scale: { x: 1, y: 1, z: 1 },
    },
    boxDims: { ...manifest.dimensions },
    material: mod.moduleId === 'wood_roof_slope_01' ? 'roof' : 'wall',
    castShadow: true,
    receiveShadow: true,
  };
}

function buildPorchStepVisualDescriptor(
  step: BuildingPorchStepSpec,
  chunkSize: number,
): VisualDescriptor {
  const chunk = getChunkCoord(step.position.x, step.position.z, chunkSize);
  return {
    id: `${step.id}:vis`,
    sourceObjectId: step.id,
    prefabId: 'cabin:porch_step',
    category: 'structure',
    batchKey: 'cabin:step',
    batchMode: 'static_box',
    chunkKey: chunk.key,
    lod: 'all',
    maxDrawDistance: 240,
    transform: {
      position: { ...step.position },
      yaw: step.rotationY,
      scale: { x: 1, y: 1, z: 1 },
    },
    boxDims: { ...step.size },
    material: 'crate',
    castShadow: true,
    receiveShadow: true,
  };
}

function buildInteriorVisualDescriptor(
  item: InteriorFurniturePlacement,
  chunkSize: number,
): VisualDescriptor {
  const manifest = INTERIOR_MANIFESTS[item.assetId];
  const chunk = getChunkCoord(item.position.x, item.position.z, chunkSize);
  return {
    id: `${item.id}:vis`,
    sourceObjectId: item.id,
    prefabId: `glb:interior:${item.assetId}`,
    category: 'prop',
    batchKey: `glb:interior:${item.assetId}`,
    batchMode: 'prefab_group',
    chunkKey: chunk.key,
    lod: 'near',
    maxDrawDistance: 160,
    transform: {
      position: { ...item.position },
      yaw: item.rotationY,
      scale: { x: 1, y: 1, z: 1 },
    },
    boxDims: { ...manifest.dimensions },
    material: 'crate',
    castShadow: true,
    receiveShadow: true,
  };
}

function buildContainerVisualDescriptor(
  cnt: ContainerVisualPlacement,
  chunkSize: number,
): VisualDescriptor {
  const manifest = CONTAINER_MANIFESTS[cnt.assetId];
  const chunk = getChunkCoord(cnt.position.x, cnt.position.z, chunkSize);
  return {
    id: `${cnt.id}:vis`,
    sourceObjectId: cnt.id,
    prefabId: `glb:container:${cnt.assetId}`,
    category: 'prop',
    batchKey: `glb:container:${cnt.assetId}`,
    batchMode: 'prefab_group',
    chunkKey: chunk.key,
    lod: 'near',
    maxDrawDistance: 160,
    transform: {
      position: { ...cnt.position },
      yaw: cnt.rotationY,
      scale: { x: 1, y: 1, z: 1 },
    },
    boxDims: { ...manifest.dimensions },
    material: cnt.assetId === 'wooden_loot_crate_01' ? 'crate' : 'metal',
    castShadow: true,
    receiveShadow: true,
  };
}

export interface Stage04APreviewLayoutOptions {
  cabinetOpenFraction?: number;
  containerOpenFraction?: number;
}

function sampleMaxFootprintHeight(
  t: TerrainDescriptor,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): number {
  let maxH = -Infinity;
  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      const h = sampleTerrainHeight(t, x, z);
      if (h > maxH) maxH = h;
    }
  }
  return maxH;
}

/**
 * Places both the 8x4 two-story loft cabin (`cabin_8x4`) and the 4x4 furnished test room (`room_4x4`)
 * onto the 96x96 terrain without blocking roads or spawn points, returning all segmented colliders,
 * visual descriptors, world item anchors, world locations, and container locations.
 */
export function buildStage04APreviewLayout(
  terrain: TerrainDescriptor,
  chunkSize = DEFAULT_CHUNK_SIZE,
  opts: Stage04APreviewLayoutOptions = {},
): Stage04APreviewLayout {
  const cabinetOpenFraction = opts.cabinetOpenFraction ?? 0;
  const containerOpenFraction = opts.containerOpenFraction ?? 0;

  // 1. Place 8x4 loft cabin on the flattened cabin clearing at (-11, -8) (spans x: -11..-3, z: -8..-4)
  // Doorway is at (-9, floorY, -4) where terrain is flat at +0.80 m
  const cabinMaxGroundY = sampleMaxFootprintHeight(terrain, -11, -3, -8, -3.5);
  const cabinFloorY = q3(cabinMaxGroundY + 0.16);
  const cabinOrigin: Vec3 = { x: -11, y: cabinFloorY, z: -8 };
  const cabinPrefab = buildCabin8x4Prefab(cabinOrigin, 'cabin_8x4');

  // 2. Place 4x4 furnished room in the adjacent south-west clearing at (-14, 2) (spans x: -14..-10, z: 2..6)
  // Doorway is at (-12, floorY, 6), well clear of main road (x ~ 10.6) and all spawn points
  const roomMaxGroundY = sampleMaxFootprintHeight(terrain, -14, -10, 2, 6.5);
  const roomFloorY = q3(roomMaxGroundY + 0.16);
  const roomOrigin: Vec3 = { x: -14, y: roomFloorY, z: 2 };
  const roomPrefab = buildRoom4x4Prefab(roomOrigin, 'room_4x4');

  const buildings: BuildingPrefabPlacement[] = [cabinPrefab, roomPrefab];
  const buildingModules: BuildingModulePlacement[] = [
    ...cabinPrefab.modules,
    ...roomPrefab.modules,
  ];
  const porchSteps: BuildingPorchStepSpec[] = [
    ...cabinPrefab.porchSteps,
    ...roomPrefab.porchSteps,
  ];

  // 3. Furniture placements across both buildings (covering all 6 interior GLB assets)
  const interiors: InteriorFurniturePlacement[] = [
    ...buildCabin8x4Furniture(cabinOrigin, cabinPrefab.id, cabinetOpenFraction),
    ...buildRoom4x4Furniture(roomOrigin, roomPrefab.id, cabinetOpenFraction),
  ];

  // 4. Container placements across both buildings (covering all 3 container GLB assets)
  const cabinLocId = 'loc_stage04a_cabin_8x4';
  const roomLocId = 'loc_stage04a_room_4x4';
  const containers: ContainerVisualPlacement[] = buildStage04AContainers(
    cabinOrigin,
    roomOrigin,
    containerOpenFraction,
    cabinLocId,
    roomLocId,
  );

  // 5. Compile segmented colliders
  const colliders: ColliderBox[] = [
    ...compileBuildingPrefabColliders(cabinPrefab),
    ...compileBuildingPrefabColliders(roomPrefab),
  ];

  for (const furn of interiors) {
    colliders.push(
      ...buildInteriorAssetColliders(
        furn.id,
        furn.assetId,
        furn.position,
        furn.rotationY,
        furn.openFraction,
      ),
    );
  }

  for (const cnt of containers) {
    colliders.push(
      ...buildContainerAssetColliders(
        cnt.id,
        cnt.assetId,
        cnt.position,
        cnt.rotationY,
        cnt.openFraction,
      ),
    );
  }

  // 6. Compile VisualDescriptors
  const visuals: VisualDescriptor[] = [
    ...buildingModules.map((m) => buildModuleVisualDescriptor(m, chunkSize)),
    ...porchSteps.map((s) => buildPorchStepVisualDescriptor(s, chunkSize)),
    ...interiors.map((i) => buildInteriorVisualDescriptor(i, chunkSize)),
    ...containers.map((c) => buildContainerVisualDescriptor(c, chunkSize)),
  ];

  // 7. Compile WorldItemAnchors
  const worldAnchors: WorldItemAnchor[] = [
    ...interiors.flatMap((i) => compileInteriorPlacementAnchors(i)),
    ...containers.flatMap((c) => compileContainerPlacementAnchors(c)),
  ];

  // 8. WorldLocations & ContainerLocations
  const locations: WorldLocation[] = [
    {
      id: cabinLocId,
      name: cabinPrefab.name,
      kind: 'ranger_house',
      position: { x: q3(cabinOrigin.x + 4), y: cabinFloorY, z: q3(cabinOrigin.z + 2) },
      yaw: 0,
      radius: 7,
      enterable: true,
    },
    {
      id: roomLocId,
      name: roomPrefab.name,
      kind: 'cabin_cluster',
      position: { x: q3(roomOrigin.x + 2), y: roomFloorY, z: q3(roomOrigin.z + 2) },
      yaw: 0,
      radius: 5,
      enterable: true,
    },
  ];

  const containerLocations: ContainerLocation[] = containers.map((c) => ({
    id: c.id,
    locationId: c.locationId,
    kind: c.containerKind,
    position: { ...c.position },
    yaw: c.rotationY,
    interactionRadius: c.interactionRadius,
  }));

  return {
    buildings,
    buildingModules,
    porchSteps,
    interiors,
    containers,
    colliders,
    visuals,
    worldAnchors,
    locations,
    containerLocations,
  };
}

export type {
  BuildingAssetId,
  ContainerAssetId,
  InteriorAssetId,
};
