import { q3, type Vec3 } from '../math';
import {
  DEFAULT_CHUNK_SIZE,
  getChunkCoord,
  type ColliderBox,
  type VisualDescriptor,
} from '../world';
import type {
  BuildingAssetId,
  BuildingModulePlacement,
  BuildingPorchStepSpec,
  BuildingPrefabPlacement,
  ContainerVisualPlacement,
  InteriorAssetId,
  InteriorFurniturePlacement,
  MultiSiteStructureLayout,
} from './contracts';
import {
  BUILDING_MANIFESTS,
  CONTAINER_MANIFESTS,
  INTERIOR_MANIFESTS,
  buildBuildingModuleColliders,
  localBoxToWorldCollider,
} from './manifests';
import { placeWallTransform } from './layoutBuilder';


/**
 * Rotates a 3D point `(pos.x, pos.y, pos.z)` around `pivotOrigin` by `deltaYaw` radians around the Y axis.
 * Matches Three.js `Object3D.rotation.y` and `manifests.ts` (`localBoxToWorldCollider`) conventions:
 * - `newX = pivotOrigin.x + dx * Math.cos(deltaYaw) + dz * Math.sin(deltaYaw)`
 * - `newZ = pivotOrigin.z - dx * Math.sin(deltaYaw) + dz * Math.cos(deltaYaw)`
 */
export function rotatePointAroundPivot(
  pos: Vec3,
  pivotOrigin: Vec3,
  deltaYaw: number,
): Vec3 {
  if (Math.abs(deltaYaw) < 1e-9) {
    return { x: q3(pos.x), y: q3(pos.y), z: q3(pos.z) };
  }
  const cos = Math.cos(deltaYaw);
  const sin = Math.sin(deltaYaw);
  const dx = pos.x - pivotOrigin.x;
  const dz = pos.z - pivotOrigin.z;
  return {
    x: q3(pivotOrigin.x + dx * cos + dz * sin),
    y: q3(pos.y),
    z: q3(pivotOrigin.z - dx * sin + dz * cos),
  };
}

/**
 * Rotates an entire `BuildingPrefabPlacement` (its `origin`, `rotationY`, all `modules`, and all `porchSteps`)
 * around `pivotOrigin` by `deltaYaw` radians.
 */
export function rotateBuildingPrefab(
  prefab: BuildingPrefabPlacement,
  pivotOrigin: Vec3,
  deltaYaw: number,
): BuildingPrefabPlacement {
  if (Math.abs(deltaYaw) < 1e-9) {
    return prefab;
  }
  return {
    ...prefab,
    origin: rotatePointAroundPivot(prefab.origin, pivotOrigin, deltaYaw),
    rotationY: q3(prefab.rotationY + deltaYaw),
    modules: prefab.modules.map((mod) => ({
      ...mod,
      position: rotatePointAroundPivot(mod.position, pivotOrigin, deltaYaw),
      rotationY: q3(mod.rotationY + deltaYaw),
    })),
    porchSteps: prefab.porchSteps.map((step) => ({
      ...step,
      position: rotatePointAroundPivot(step.position, pivotOrigin, deltaYaw),
      rotationY: q3(step.rotationY + deltaYaw),
    })),
  };
}

/**
 * Compiles all segmented world `ColliderBox[]` for a `BuildingPrefabPlacement` (including rotated buildings).
 * Uses `buildBuildingModuleColliders` for every module and `localBoxToWorldCollider` for every `porchStep`
 * so `90° / 180° / 270°` rotated porch step colliders have accurately rotated world AABBs.
 */
export function compileMultiSiteBuildingColliders(
  prefab: BuildingPrefabPlacement,
): ColliderBox[] {
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
    colliders.push(
      localBoxToWorldCollider(
        `${step.id}:col`,
        step.id,
        {
          name: 'porch_step',
          center: [0, 0, 0],
          size: [step.size.x, step.size.y, step.size.z],
        },
        step.position,
        step.rotationY,
        'structure',
        'crate',
      ),
    );
  }

  return colliders;
}

/**
 * Rotates an array of `InteriorFurniturePlacement` items around `pivotOrigin` by `deltaYaw` radians.
 */
export function rotateFurniturePlacements(
  items: InteriorFurniturePlacement[],
  pivotOrigin: Vec3,
  deltaYaw: number,
): InteriorFurniturePlacement[] {
  if (Math.abs(deltaYaw) < 1e-9) {
    return items;
  }
  return items.map((item) => ({
    ...item,
    position: rotatePointAroundPivot(item.position, pivotOrigin, deltaYaw),
    rotationY: q3(item.rotationY + deltaYaw),
  }));
}

/**
 * Rotates an array of `ContainerVisualPlacement` items around `pivotOrigin` by `deltaYaw` radians.
 */
export function rotateContainerPlacements(
  items: ContainerVisualPlacement[],
  pivotOrigin: Vec3,
  deltaYaw: number,
): ContainerVisualPlacement[] {
  if (Math.abs(deltaYaw) < 1e-9) {
    return items;
  }
  return items.map((item) => ({
    ...item,
    position: rotatePointAroundPivot(item.position, pivotOrigin, deltaYaw),
    rotationY: q3(item.rotationY + deltaYaw),
  }));
}

/**
 * Builds an 8x4 m single-story dual-entrance warehouse/workshop (`warehouse_8x4`):
 * - Two 4x4 ground floor slabs (`wood_floor_01`) at `y = 0`
 * - South doorway `(0,4)->(4,4)` and North doorway `(8,0)->(4,0)` (`wood_wall_door_01`)
 * - Two open `wood_door_01` leaves (`1.38 rad`)
 * - Four windowed perimeter walls (`wood_wall_window_01`)
 * - Two roof gables (`wood_roof_gable_01`) and four roof slopes (`wood_roof_slope_01`)
 * - Entrance `porchSteps` outside both south and north doorways
 */
export function buildWarehouse8x4Prefab(
  origin: Vec3,
  idPrefix = 'warehouse_8x4',
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
    extra: Partial<
      Pick<BuildingModulePlacement, 'doorOpenAngleRad' | 'hideCornerPost' | 'extraEndCornerPost'>
    > = {},
  ): BuildingModulePlacement => ({
    id: `${idPrefix}:mod_${String(index).padStart(2, '0')}:${moduleId}`,
    buildingId: idPrefix,
    moduleId,
    position: { x: q3(ox + lx), y: q3(oy + ly), z: q3(oz + lz) },
    rotationY: q3(rotationY),
    ...extra,
  });

  const wWestWin = placeWallTransform(0, 0, 0, 4, 0);
  const wSouthWestDoor = placeWallTransform(0, 4, 4, 4, 0);
  const wSouthEastWin = placeWallTransform(4, 4, 8, 4, 0);
  const wEastWin = placeWallTransform(8, 4, 8, 0, 0);
  const wNorthEastDoor = placeWallTransform(8, 0, 4, 0, 0);
  const wNorthWestWin = placeWallTransform(4, 0, 0, 0, 0);

  const modules: BuildingModulePlacement[] = [
    // 1-2. Ground floor 4x4 slabs (y = 0)
    addMod(1, 'wood_floor_01', 2, 0, 2, 0),
    addMod(2, 'wood_floor_01', 6, 0, 2, 0),
    // 3-8. Perimeter walls (CCW)
    addMod(
      3,
      'wood_wall_window_01',
      wWestWin.position.x,
      wWestWin.position.y,
      wWestWin.position.z,
      wWestWin.rotationY,
    ),
    addMod(
      4,
      'wood_wall_door_01',
      wSouthWestDoor.position.x,
      wSouthWestDoor.position.y,
      wSouthWestDoor.position.z,
      wSouthWestDoor.rotationY,
    ),
    addMod(
      5,
      'wood_wall_window_01',
      wSouthEastWin.position.x,
      wSouthEastWin.position.y,
      wSouthEastWin.position.z,
      wSouthEastWin.rotationY,
    ),
    addMod(
      6,
      'wood_wall_window_01',
      wEastWin.position.x,
      wEastWin.position.y,
      wEastWin.position.z,
      wEastWin.rotationY,
    ),
    addMod(
      7,
      'wood_wall_door_01',
      wNorthEastDoor.position.x,
      wNorthEastDoor.position.y,
      wNorthEastDoor.position.z,
      wNorthEastDoor.rotationY,
    ),
    addMod(
      8,
      'wood_wall_window_01',
      wNorthWestWin.position.x,
      wNorthWestWin.position.y,
      wNorthWestWin.position.z,
      wNorthWestWin.rotationY,
    ),
    // 9-10. Open door leaves on South (2, 0, 4) and North (6, 0, 0) doorways
    addMod(9, 'wood_door_01', 2, 0, 4, 0, { doorOpenAngleRad: 1.38 }),
    addMod(10, 'wood_door_01', 6, 0, 0, Math.PI, { doorOpenAngleRad: 1.38 }),
    // 11-12. Roof gables at x = 0 and x = 8 (y = 3.0)
    addMod(11, 'wood_roof_gable_01', 0, 3, 2, -Math.PI / 2),
    addMod(12, 'wood_roof_gable_01', 8, 3, 2, Math.PI / 2),
    // 13-16. Roof slopes (y = 3.0)
    addMod(13, 'wood_roof_slope_01', 2, 3, 2, 0),
    addMod(14, 'wood_roof_slope_01', 2, 3, 2, Math.PI),
    addMod(15, 'wood_roof_slope_01', 6, 3, 2, 0),
    addMod(16, 'wood_roof_slope_01', 6, 3, 2, Math.PI),
  ];

  const porchSteps: BuildingPorchStepSpec[] = [
    // South doorway porch steps at (ox + 2, oz + 4)
    {
      id: `${idPrefix}:porch_south_upper`,
      buildingId: idPrefix,
      position: { x: q3(ox + 2.0), y: q3(oy - 0.1), z: q3(oz + 4.65) },
      size: { x: 2.6, y: 0.2, z: 1.3 },
      rotationY: 0,
    },
    {
      id: `${idPrefix}:porch_south_lower`,
      buildingId: idPrefix,
      position: { x: q3(ox + 2.0), y: q3(oy - 0.26), z: q3(oz + 5.75) },
      size: { x: 2.6, y: 0.2, z: 1.1 },
      rotationY: 0,
    },
    // North doorway porch steps at (ox + 6, oz + 0)
    {
      id: `${idPrefix}:porch_north_upper`,
      buildingId: idPrefix,
      position: { x: q3(ox + 6.0), y: q3(oy - 0.1), z: q3(oz - 0.65) },
      size: { x: 2.6, y: 0.2, z: 1.3 },
      rotationY: q3(Math.PI),
    },
    {
      id: `${idPrefix}:porch_north_lower`,
      buildingId: idPrefix,
      position: { x: q3(ox + 6.0), y: q3(oy - 0.26), z: q3(oz - 1.75) },
      size: { x: 2.6, y: 0.2, z: 1.1 },
      rotationY: q3(Math.PI),
    },
  ];

  return {
    id: idPrefix,
    name: 'Modulli Ustaxona Ombori (8×4m)',
    kind: 'warehouse_8x4',
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
 * Builds a 4x4 m two-story observation watchpost (`watchpost_4x4`):
 * - Ground floor `wood_floor_01` at `y = 0`
 * - South door wall (`wood_wall_door_01`) + open `wood_door_01` (`1.35 rad`) and 3 windowed walls (`wood_wall_window_01`)
 * - Second-floor observation deck `wood_floor_01` at `y = 3.0`
 * - 2 roof gables (`wood_roof_gable_01`) and 2 roof slopes (`wood_roof_slope_01`)
 * - Exterior stairs `wood_stairs_01` along the west wall from `(-0.75, 0, 3.85)` along `-Z` (`rotationY = 0`)
 *   ascending to `y = 3.0 m` onto the 2nd-floor observation deck
 * - Entrance `porchSteps` + stair approach & upper deck landing bridge
 */
export function buildWatchpost4x4Prefab(
  origin: Vec3,
  idPrefix = 'watchpost_4x4',
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
  const wEastWin = placeWallTransform(4, 4, 4, 0, 0);
  const wNorthWin = placeWallTransform(4, 0, 0, 0, 0);
  const wWest2 = placeWallTransform(0, 0, 0, 4, 3);
  const wSouth2 = placeWallTransform(0, 4, 4, 4, 3);
  const wEast2 = placeWallTransform(4, 4, 4, 0, 3);
  const wNorth2 = placeWallTransform(4, 0, 0, 0, 3);

  const modules: BuildingModulePlacement[] = [
    // 1. Ground floor slab (y = 0)
    addMod(1, 'wood_floor_01', 2, 0, 2, 0),
    // 2. Second-floor observation deck slab (y = 3.0)
    addMod(2, 'wood_floor_01', 2, 3, 2, 0),
    // 3-7. Ground floor perimeter walls + open door
    addMod(
      3,
      'wood_wall_window_01',
      wWestWin.position.x,
      wWestWin.position.y,
      wWestWin.position.z,
      wWestWin.rotationY,
    ),
    addMod(
      4,
      'wood_wall_door_01',
      wSouthDoor.position.x,
      wSouthDoor.position.y,
      wSouthDoor.position.z,
      wSouthDoor.rotationY,
    ),
    addMod(5, 'wood_door_01', 2, 0, 4, 0, { doorOpenAngleRad: 1.35 }),
    addMod(
      6,
      'wood_wall_window_01',
      wEastWin.position.x,
      wEastWin.position.y,
      wEastWin.position.z,
      wEastWin.rotationY,
    ),
    addMod(
      7,
      'wood_wall_window_01',
      wNorthWin.position.x,
      wNorthWin.position.y,
      wNorthWin.position.z,
      wNorthWin.rotationY,
    ),
    // 8-9. Roof gables (y = 6.0 — ikkinchi qavat ustida; avval y = 3.0 da bo'lib, kuzatuv maydoni tom ichida qolardi)
    addMod(8, 'wood_roof_gable_01', 0, 6, 2, -Math.PI / 2),
    addMod(9, 'wood_roof_gable_01', 4, 6, 2, Math.PI / 2),
    // 10-11. Roof slopes (y = 6.0)
    addMod(10, 'wood_roof_slope_01', 2, 6, 2, 0),
    addMod(11, 'wood_roof_slope_01', 2, 6, 2, Math.PI),
    // 12. Exterior stairs along the west wall from (-0.75, 0, 3.85) along -Z (rotationY = 0) to y = 3.0
    addMod(12, 'wood_stairs_01', -0.75, 0, 3.85, 0),
    // 13-16. Second-floor observation room walls (y = 3.0): 3 windowed walls to shoot from,
    // north wall with an open doorway (no leaf) where the stair landing bridge arrives
    addMod(13, 'wood_wall_window_01', wWest2.position.x, wWest2.position.y, wWest2.position.z, wWest2.rotationY),
    addMod(14, 'wood_wall_window_01', wSouth2.position.x, wSouth2.position.y, wSouth2.position.z, wSouth2.rotationY),
    addMod(15, 'wood_wall_window_01', wEast2.position.x, wEast2.position.y, wEast2.position.z, wEast2.rotationY),
    addMod(16, 'wood_wall_door_01', wNorth2.position.x, wNorth2.position.y, wNorth2.position.z, wNorth2.rotationY),
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
    // Bottom approach step for exterior stairs at (-0.75, 0, 3.85)
    {
      id: `${idPrefix}:stair_entry_step`,
      buildingId: idPrefix,
      position: { x: q3(ox - 0.75), y: q3(oy - 0.1), z: q3(oz + 4.35) },
      size: { x: 1.3, y: 0.2, z: 1.0 },
      rotationY: 0,
    },
    // Top landing balcony at y = 3.0 connecting the top of wood_stairs_01 (-0.75, 3.0, -0.15) to the 2nd-floor
    // north doorway (x in [1.1, 2.9] at z = 0): spans x in [-1.35, 2.65]
    {
      id: `${idPrefix}:upper_deck_landing`,
      buildingId: idPrefix,
      position: { x: q3(ox + 0.65), y: q3(oy + 2.9), z: q3(oz - 0.65) },
      size: { x: 4.0, y: 0.2, z: 1.3 },
      rotationY: 0,
    },
  ];

  return {
    id: idPrefix,
    name: 'Kuzatuv Minorasi (4×4m)',
    kind: 'watchpost_4x4',
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
 * Builds interior furniture placements for an unrotated `warehouse_8x4` building,
 * keeping both the south doorway `(2, 0, 4)` and north doorway `(6, 0, 0)` completely unobstructed.
 */
export function buildWarehouse8x4Furniture(
  origin: Vec3,
  buildingId = 'warehouse_8x4',
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
    item('shelf_01', 'wooden_shelf_01', 1.1, 0, 0.35, 0),
    item('shelf_02', 'wooden_shelf_01', 2.5, 0, 0.35, 0),
    item('table_01', 'wooden_table_01', 5.6, 0, 3.3, Math.PI),
    item('chair_01', 'wooden_chair_01', 5.6, 0, 2.55, 0),
    item('cabinet_01', 'kitchen_cabinet_01', 7.55, 0, 2.8, -Math.PI / 2, cabinetOpenFraction),
  ];
}

/**
 * Builds interior furniture placements for an unrotated `watchpost_4x4` building
 * (both ground floor and `y = 3.0` second-floor observation deck).
 */
export function buildWatchpost4x4Furniture(
  origin: Vec3,
  buildingId = 'watchpost_4x4',
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
    item('shelf_01', 'wooden_shelf_01', 0.75, 0, 0.35, 0),
    item('table_01', 'wooden_table_01', 3.05, 0, 0.65, 0),
    item('chair_01', 'wooden_chair_01', 3.05, 0, 1.38, Math.PI),
    item('cabinet_01', 'kitchen_cabinet_01', 0.38, 0, 3.1, Math.PI / 2, cabinetOpenFraction),
    // Upper deck lookout chair on 2nd floor (y = 3.0)
    item('upper_chair_01', 'wooden_chair_01', 3.1, 3.0, 3.1, Math.PI),
  ];
}

/**
 * Compiles `VisualDescriptor[]` for multi-site modular buildings, porch steps, interior furniture, and loot containers.
 */
export function buildMultiSiteVisualDescriptors(params: {
  buildingModules: BuildingModulePlacement[];
  porchSteps: BuildingPorchStepSpec[];
  interiors: InteriorFurniturePlacement[];
  containers: ContainerVisualPlacement[];
  chunkSize?: number;
}): VisualDescriptor[] {
  const chunkSize = params.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const visuals: VisualDescriptor[] = [];

  for (const mod of params.buildingModules) {
    const manifest = BUILDING_MANIFESTS[mod.moduleId];
    const chunk = getChunkCoord(mod.position.x, mod.position.z, chunkSize);
    visuals.push({
      id: `${mod.id}:vis`,
      sourceObjectId: mod.id,
      prefabId: `glb:building:${mod.moduleId}`,
      category: 'structure',
      batchKey: `glb:building:${mod.moduleId}`,
      batchMode: 'prefab_group',
      chunkKey: chunk.key,
      lod: 'all',
      maxDrawDistance: 320,
      transform: {
        position: { ...mod.position },
        yaw: mod.rotationY,
        scale: { x: 1, y: 1, z: 1 },
      },
      boxDims: { ...manifest.dimensions },
      material: mod.moduleId === 'wood_roof_slope_01' ? 'roof' : 'wall',
      castShadow: true,
      receiveShadow: true,
    });
  }

  for (const step of params.porchSteps) {
    const chunk = getChunkCoord(step.position.x, step.position.z, chunkSize);
    visuals.push({
      id: `${step.id}:vis`,
      sourceObjectId: step.id,
      prefabId: 'cabin:porch_step',
      category: 'structure',
      batchKey: 'cabin:step',
      batchMode: 'static_box',
      chunkKey: chunk.key,
      lod: 'all',
      maxDrawDistance: 260,
      transform: {
        position: { ...step.position },
        yaw: step.rotationY,
        scale: { x: 1, y: 1, z: 1 },
      },
      boxDims: { ...step.size },
      material: 'crate',
      castShadow: true,
      receiveShadow: true,
    });
  }

  for (const item of params.interiors) {
    const manifest = INTERIOR_MANIFESTS[item.assetId];
    const chunk = getChunkCoord(item.position.x, item.position.z, chunkSize);
    visuals.push({
      id: `${item.id}:vis`,
      sourceObjectId: item.id,
      prefabId: `glb:interior:${item.assetId}`,
      category: 'prop',
      batchKey: `glb:interior:${item.assetId}`,
      batchMode: 'prefab_group',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: 180,
      transform: {
        position: { ...item.position },
        yaw: item.rotationY,
        scale: { x: 1, y: 1, z: 1 },
      },
      boxDims: { ...manifest.dimensions },
      material: 'crate',
      castShadow: true,
      receiveShadow: true,
    });
  }

  for (const cnt of params.containers) {
    const manifest = CONTAINER_MANIFESTS[cnt.assetId];
    const chunk = getChunkCoord(cnt.position.x, cnt.position.z, chunkSize);
    visuals.push({
      id: `${cnt.id}:vis`,
      sourceObjectId: cnt.id,
      prefabId: `glb:container:${cnt.assetId}`,
      category: 'prop',
      batchKey: `glb:container:${cnt.assetId}`,
      batchMode: 'prefab_group',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: 180,
      transform: {
        position: { ...cnt.position },
        yaw: cnt.rotationY,
        scale: { x: 1, y: 1, z: 1 },
      },
      boxDims: { ...manifest.dimensions },
      material: cnt.assetId === 'wooden_loot_crate_01' ? 'crate' : 'metal',
      castShadow: true,
      receiveShadow: true,
    });
  }

  return visuals;
}

/**
 * Verifies that every collection in a `MultiSiteStructureLayout` has 100% unique IDs.
 * Throws an descriptive `Error` if any duplicate ID is detected.
 */
export function assertUniqueLayoutIds(layout: MultiSiteStructureLayout): void {
  const checkCollection = <T extends { id: string }>(label: string, items: readonly T[]): void => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) {
        throw new Error(`Duplicate ${label} ID detected in MultiSiteStructureLayout: "${item.id}"`);
      }
      seen.add(item.id);
    }
  };

  checkCollection('buildings', layout.buildings);
  checkCollection('buildingModules', layout.buildingModules);
  checkCollection('porchSteps', layout.porchSteps);
  checkCollection('interiors', layout.interiors);
  checkCollection('containers', layout.containers);
  if (layout.outdoorPlacements) {
    checkCollection('outdoorPlacements', layout.outdoorPlacements);
  }
  checkCollection('colliders', layout.colliders);
  checkCollection('visuals', layout.visuals);
  checkCollection('worldAnchors', layout.worldAnchors);
  checkCollection('locations', layout.locations);
  checkCollection('containerLocations', layout.containerLocations);
}
