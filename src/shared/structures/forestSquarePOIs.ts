import { q3, type Vec3 } from '../math';
import {
  buildForestSquareOutdoorPlacements,
  buildOutdoorVisualDescriptors,
  compileAllOutdoorColliders,
} from '../outdoor';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_PUBLIC_LAYOUT_SEED,
  compilePrefabPlacement,
  sampleTerrainHeight,
  type ColliderBox,
  type ContainerKind,
  type ContainerLocation,
  type PrefabPlacement,
  type TerrainDescriptor,
  type VisualDescriptor,
  type WorldLocation,
} from '../world';
import {
  getForestSquarePoiSites,
  type BuildingModulePlacement,
  type BuildingPorchStepSpec,
  type BuildingPrefabPlacement,
  type ContainerAssetId,
  type ContainerVisualPlacement,
  type ForestSquarePoiSiteSpec,
  type InteriorFurniturePlacement,
  type MultiSiteStructureLayout,
  type WorldItemAnchor,
} from './contracts';
import {
  CONTAINER_MANIFESTS,
  buildContainerAssetColliders,
  buildInteriorAssetColliders,
} from './manifests';
import {
  buildCabin8x4Furniture,
  buildCabin8x4Prefab,
  buildRoom4x4Furniture,
  buildRoom4x4Prefab,
  compileContainerPlacementAnchors,
  compileInteriorPlacementAnchors,
} from './layoutBuilder';
import {
  assertUniqueLayoutIds,
  buildMultiSiteVisualDescriptors,
  buildWarehouse8x4Furniture,
  buildWarehouse8x4Prefab,
  buildWatchpost4x4Furniture,
  buildWatchpost4x4Prefab,
  compileMultiSiteBuildingColliders,
  rotateBuildingPrefab,
  rotateContainerPlacements,
  rotateFurniturePlacements,
} from './multiSiteLayout';


export interface ForestSquarePOILayoutOptions {
  cabinetOpenFraction?: number;
  containerOpenFraction?: number;
}

export interface PoiBuildingFootprintRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function makeContainerPlacement(
  poiId: string,
  index: number,
  assetId: ContainerAssetId,
  containerKind: ContainerKind,
  x: number,
  y: number,
  z: number,
  rotationY: number,
  openFraction: number,
): ContainerVisualPlacement {
  return {
    id: `poi:${poiId}:cnt_${index}:${assetId}`,
    locationId: poiId,
    assetId,
    containerKind,
    position: { x: q3(x), y: q3(y), z: q3(z) },
    rotationY: q3(rotationY),
    interactionRadius: CONTAINER_MANIFESTS[assetId].interactionRadius,
    openFraction,
  };
}

function reindexPoiFurniture(
  poiId: string,
  items: InteriorFurniturePlacement[],
): InteriorFurniturePlacement[] {
  return items.map((item, idx) => ({
    ...item,
    id: `poi:${poiId}:furn_${idx}:${item.assetId}`,
  }));
}

// ---------------- 1. POI: O'rmonchi Uyi (poi_ranger_house) ----------------

function buildRangerHouseSite(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  cabinetOpenFraction: number,
  containerOpenFraction: number,
): {
  buildings: BuildingPrefabPlacement[];
  interiors: InteriorFurniturePlacement[];
  containers: ContainerVisualPlacement[];
  props: PrefabPlacement[];
  floorY: number;
} {
  const cx = site.center.x;
  const cz = site.center.z;
  const floorY = q3(sampleTerrainHeight(terrain, cx, cz) + 0.16);

  const bldId = `poi:${site.id}:bld:0`;
  const origin: Vec3 = { x: q3(cx - 4), y: floorY, z: q3(cz - 2) };
  const cabin = buildCabin8x4Prefab(origin, bldId);
  cabin.name = "O'rmonchi Kulbasi (8×4m)";

  const rawFurniture = buildCabin8x4Furniture(origin, bldId, cabinetOpenFraction);
  const interiors = reindexPoiFurniture(site.id, rawFurniture);

  const yardCrateX = q3(cx + 3.2);
  const yardCrateZ = q3(cz + 3.4);
  const yardCrateY = q3(sampleTerrainHeight(terrain, yardCrateX, yardCrateZ));

  const containers: ContainerVisualPlacement[] = [
    makeContainerPlacement(
      site.id,
      0,
      'wooden_loot_crate_01',
      'supply_crate',
      origin.x + 7.35,
      floorY,
      origin.z + 3.45,
      Math.PI,
      containerOpenFraction,
    ),
    makeContainerPlacement(
      site.id,
      1,
      'metal_locker_01',
      'weapon_locker',
      origin.x + 4.35,
      floorY,
      origin.z + 0.42,
      0,
      containerOpenFraction,
    ),
    makeContainerPlacement(
      site.id,
      2,
      'old_toolbox_01',
      'ammo_box',
      origin.x + 5.8,
      floorY + 0.75,
      origin.z + 0.65,
      0,
      containerOpenFraction,
    ),
    makeContainerPlacement(
      site.id,
      3,
      'wooden_loot_crate_01',
      'camp_chest',
      yardCrateX,
      yardCrateY,
      yardCrateZ,
      -Math.PI / 2,
      containerOpenFraction,
    ),
  ];

  // Stage 08A: Outdoor woodpile is now provided by `lumber_stack_01` GLB in `outdoorPlacements.ts`
  const props: PrefabPlacement[] = [];

  return {
    buildings: [cabin],
    interiors,
    containers,
    props,
    floorY,
  };
}

// ---------------- 2. POI: Uylar Guruhi (poi_cabin_cluster) ----------------

function buildCabinClusterSite(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  cabinetOpenFraction: number,
  containerOpenFraction: number,
): {
  buildings: BuildingPrefabPlacement[];
  interiors: InteriorFurniturePlacement[];
  containers: ContainerVisualPlacement[];
  props: PrefabPlacement[];
  floorY: number;
} {
  const cx = site.center.x;
  const cz = site.center.z;
  const floorY = q3(sampleTerrainHeight(terrain, cx, cz) + 0.16);

  // Building 0: North 8x4 loft cabin (yaw = 0, south door facing +Z courtyard)
  const bld0Id = `poi:${site.id}:bld:0`;
  const origin0: Vec3 = { x: q3(cx - 4), y: floorY, z: q3(cz - 9) };
  const bld0 = buildCabin8x4Prefab(origin0, bld0Id);
  bld0.name = 'Shimoliy Kulba (8×4m)';
  const furn0 = buildCabin8x4Furniture(origin0, bld0Id, cabinetOpenFraction);
  const cnt0: ContainerVisualPlacement[] = [
    makeContainerPlacement(
      site.id,
      0,
      'wooden_loot_crate_01',
      'supply_crate',
      origin0.x + 7.35,
      floorY,
      origin0.z + 3.45,
      Math.PI,
      containerOpenFraction,
    ),
    makeContainerPlacement(
      site.id,
      1,
      'metal_locker_01',
      'weapon_locker',
      origin0.x + 4.35,
      floorY,
      origin0.z + 0.42,
      0,
      containerOpenFraction,
    ),
  ];

  // Building 1: West 4x4 house (yaw = +Math.PI / 2, doorway faces +X east into courtyard)
  const bld1Id = `poi:${site.id}:bld:1`;
  const origin1: Vec3 = { x: q3(cx - 10), y: floorY, z: q3(cz + 5) };
  const yaw1 = Math.PI / 2;
  const bld1 = rotateBuildingPrefab(buildRoom4x4Prefab(origin1, bld1Id), origin1, yaw1);
  bld1.name = "G'arbiy Uy (4×4m)";
  const furn1 = rotateFurniturePlacements(
    buildRoom4x4Furniture(origin1, bld1Id, cabinetOpenFraction),
    origin1,
    yaw1,
  );
  const cnt1 = rotateContainerPlacements(
    [
      makeContainerPlacement(
        site.id,
        2,
        'wooden_loot_crate_01',
        'supply_crate',
        origin1.x + 3.42,
        floorY,
        origin1.z + 3.55,
        Math.PI,
        containerOpenFraction,
      ),
      makeContainerPlacement(
        site.id,
        3,
        'old_toolbox_01',
        'ammo_box',
        origin1.x + 3.46,
        floorY + 0.75,
        origin1.z + 2.0,
        -Math.PI / 2,
        containerOpenFraction,
      ),
    ],
    origin1,
    yaw1,
  );

  // Building 2: East 4x4 house (yaw = -Math.PI / 2, doorway faces -X west into courtyard)
  const bld2Id = `poi:${site.id}:bld:2`;
  const origin2: Vec3 = { x: q3(cx + 10), y: floorY, z: q3(cz + 1) };
  const yaw2 = -Math.PI / 2;
  const bld2 = rotateBuildingPrefab(buildRoom4x4Prefab(origin2, bld2Id), origin2, yaw2);
  bld2.name = 'Sharqiy Uy (4×4m)';
  const furn2 = rotateFurniturePlacements(
    buildRoom4x4Furniture(origin2, bld2Id, cabinetOpenFraction),
    origin2,
    yaw2,
  );
  const cnt2 = rotateContainerPlacements(
    [
      makeContainerPlacement(
        site.id,
        4,
        'metal_locker_01',
        'weapon_locker',
        origin2.x + 1.5,
        floorY,
        origin2.z + 0.38,
        0,
        containerOpenFraction,
      ),
      makeContainerPlacement(
        site.id,
        5,
        'old_toolbox_01',
        'ammo_box',
        origin2.x + 3.46,
        floorY + 0.75,
        origin2.z + 2.0,
        -Math.PI / 2,
        containerOpenFraction,
      ),
    ],
    origin2,
    yaw2,
  );

  const interiors = reindexPoiFurniture(site.id, [...furn0, ...furn1, ...furn2]);
  const containers = [...cnt0, ...cnt1, ...cnt2];

  // Central courtyard well / bench prop
  const props: PrefabPlacement[] = [
    {
      objectId: `poi:${site.id}:prop:courtyard_bench_01`,
      prefabId: 'cluster:courtyard_bench',
      groundToTerrain: true,
      transform: {
        position: { x: q3(cx), y: 0, z: q3(cz + 6.8) },
        yaw: 0,
        scale: { x: 1, y: 1, z: 1 },
      },
      parts: [
        {
          localId: 'bench_top',
          offset: { x: 0, y: 0.24, z: 0 },
          size: { x: 2.2, y: 0.48, z: 0.7 },
          mat: 'crate',
          colliderTag: 'prop',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'prop',
          batchKey: 'poi:wood_stack',
          batchMode: 'static_box',
        },
      ],
    },
  ];

  return {
    buildings: [bld0, bld1, bld2],
    interiors,
    containers,
    props,
    floorY,
  };
}

// ---------------- 3. POI: Tashlandiq Yog'och Tilish Maydoni (poi_lumber_mill) ----------------

function buildLumberMillSite(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  cabinetOpenFraction: number,
  containerOpenFraction: number,
): {
  buildings: BuildingPrefabPlacement[];
  interiors: InteriorFurniturePlacement[];
  containers: ContainerVisualPlacement[];
  props: PrefabPlacement[];
  floorY: number;
} {
  const cx = site.center.x;
  const cz = site.center.z;
  const floorY = q3(sampleTerrainHeight(terrain, cx, cz) + 0.16);

  // 8x4 workshop warehouse rotated 90° (yaw = Math.PI / 2) on the west side of the yard
  // Unrotated [0..8]x[0..4] rotated +90° around origin spans x in [origin.x, origin.x + 4], z in [origin.z - 8, origin.z]
  const bld0Id = `poi:${site.id}:bld:0`;
  const origin0: Vec3 = { x: q3(cx - 7), y: floorY, z: q3(cz + 4) };
  const yaw0 = Math.PI / 2;
  const bld0 = rotateBuildingPrefab(buildWarehouse8x4Prefab(origin0, bld0Id), origin0, yaw0);
  bld0.name = "Yog'och Ustaxonasi Ombori (8×4m)";

  const insideFurn = rotateFurniturePlacements(
    buildWarehouse8x4Furniture(origin0, bld0Id, cabinetOpenFraction),
    origin0,
    yaw0,
  );

  // Outdoor sawmill sorting table
  const yardTableX = q3(cx + 2.5);
  const yardTableZ = q3(cz - 3.5);
  const yardTableY = q3(sampleTerrainHeight(terrain, yardTableX, yardTableZ));
  const outdoorFurn: InteriorFurniturePlacement[] = [
    {
      id: `${bld0Id}:furn_yard_table`,
      buildingId: bld0Id,
      assetId: 'wooden_table_01',
      position: { x: yardTableX, y: yardTableY, z: yardTableZ },
      rotationY: 0,
      openFraction: 0,
    },
  ];

  const interiors = reindexPoiFurniture(site.id, [...insideFurn, ...outdoorFurn]);

  // 3 containers inside rotated warehouse + 1 crate in the outdoor timber yard
  const insideContainers = rotateContainerPlacements(
    [
      makeContainerPlacement(
        site.id,
        0,
        'metal_locker_01',
        'weapon_locker',
        origin0.x + 0.6,
        floorY,
        origin0.z + 2.0,
        Math.PI / 2,
        containerOpenFraction,
      ),
      makeContainerPlacement(
        site.id,
        1,
        'wooden_loot_crate_01',
        'supply_crate',
        origin0.x + 4.1,
        floorY,
        origin0.z + 0.55,
        0,
        containerOpenFraction,
      ),
      makeContainerPlacement(
        site.id,
        2,
        'old_toolbox_01',
        'ammo_box',
        origin0.x + 5.6,
        floorY + 0.75,
        origin0.z + 3.3,
        Math.PI,
        containerOpenFraction,
      ),
    ],
    origin0,
    yaw0,
  );

  const yardCrateX = q3(cx + 4.2);
  const yardCrateZ = q3(cz - 3.5);
  const yardCrateY = q3(sampleTerrainHeight(terrain, yardCrateX, yardCrateZ));
  const containers: ContainerVisualPlacement[] = [
    ...insideContainers,
    makeContainerPlacement(
      site.id,
      3,
      'wooden_loot_crate_01',
      'supply_crate',
      yardCrateX,
      yardCrateY,
      yardCrateZ,
      Math.PI / 2,
      containerOpenFraction,
    ),
  ];

  // Stage 08A: Outdoor lumber yard timber stacks & sawhorses are now provided by `lumber_stack_01` and `sawhorse_01` GLBs
  const props: PrefabPlacement[] = [];

  return {
    buildings: [bld0],
    interiors,
    containers,
    props,
    floorY,
  };
}

// ---------------- 4. POI: Eski Servis va Ombor (poi_service_station) ----------------

function buildServiceStationSite(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  cabinetOpenFraction: number,
  containerOpenFraction: number,
): {
  buildings: BuildingPrefabPlacement[];
  interiors: InteriorFurniturePlacement[];
  containers: ContainerVisualPlacement[];
  props: PrefabPlacement[];
  floorY: number;
} {
  const cx = site.center.x;
  const cz = site.center.z;
  const floorY = q3(sampleTerrainHeight(terrain, cx, cz) + 0.16);

  // Building 0: 8x4 service warehouse rotated 180° (yaw = Math.PI)
  // Unrotated [0..8]x[0..4] rotated 180° around origin0 spans x in [origin0.x - 8, origin0.x], z in [origin0.z - 4, origin0.z]
  const bld0Id = `poi:${site.id}:bld:0`;
  const origin0: Vec3 = { x: q3(cx + 4), y: floorY, z: q3(cz - 3) };
  const yaw0 = Math.PI;
  const bld0 = rotateBuildingPrefab(buildWarehouse8x4Prefab(origin0, bld0Id), origin0, yaw0);
  bld0.name = 'Servis Ombori (8×4m)';
  const furn0 = rotateFurniturePlacements(
    buildWarehouse8x4Furniture(origin0, bld0Id, cabinetOpenFraction),
    origin0,
    yaw0,
  );
  const cnt0 = rotateContainerPlacements(
    [
      makeContainerPlacement(
        site.id,
        0,
        'metal_locker_01',
        'weapon_locker',
        origin0.x + 0.6,
        floorY,
        origin0.z + 2.0,
        Math.PI / 2,
        containerOpenFraction,
      ),
      makeContainerPlacement(
        site.id,
        1,
        'wooden_loot_crate_01',
        'supply_crate',
        origin0.x + 4.1,
        floorY,
        origin0.z + 0.55,
        0,
        containerOpenFraction,
      ),
      makeContainerPlacement(
        site.id,
        2,
        'old_toolbox_01',
        'ammo_box',
        origin0.x + 5.6,
        floorY + 0.75,
        origin0.z + 3.3,
        Math.PI,
        containerOpenFraction,
      ),
    ],
    origin0,
    yaw0,
  );

  // Building 1: 4x4 dispatcher office (yaw = 0)
  const bld1Id = `poi:${site.id}:bld:1`;
  const origin1: Vec3 = { x: q3(cx - 8), y: floorY, z: q3(cz + 2) };
  const bld1 = buildRoom4x4Prefab(origin1, bld1Id);
  bld1.name = 'Dispetcher Xonasi (4×4m)';
  const furn1 = buildRoom4x4Furniture(origin1, bld1Id, cabinetOpenFraction);
  const cnt1: ContainerVisualPlacement[] = [
    makeContainerPlacement(
      site.id,
      3,
      'metal_locker_01',
      'weapon_locker',
      origin1.x + 1.5,
      floorY,
      origin1.z + 0.38,
      0,
      containerOpenFraction,
    ),
    makeContainerPlacement(
      site.id,
      4,
      'old_toolbox_01',
      'ammo_box',
      origin1.x + 3.46,
      floorY + 0.75,
      origin1.z + 2.0,
      -Math.PI / 2,
      containerOpenFraction,
    ),
  ];

  const interiors = reindexPoiFurniture(site.id, [...furn0, ...furn1]);
  const containers = [...cnt0, ...cnt1];

  // Outdoor service platform & horizontal fuel storage tank (static_box, mat: 'metal')
  const props: PrefabPlacement[] = [
    {
      objectId: `poi:${site.id}:prop:fuel_tank_01`,
      prefabId: 'service:fuel_tank_pad',
      groundToTerrain: true,
      transform: {
        position: { x: q3(cx + 6.2), y: 0, z: q3(cz + 3.5) },
        yaw: 0,
        scale: { x: 1, y: 1, z: 1 },
      },
      parts: [
        {
          localId: 'concrete_cradle',
          offset: { x: 0, y: 0.2, z: 0 },
          size: { x: 2.2, y: 0.4, z: 4.2 },
          mat: 'wall',
          colliderTag: 'structure',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'structure',
          batchKey: 'poi:service_cradle',
          batchMode: 'static_box',
        },
        {
          localId: 'metal_tank_body',
          offset: { x: 0, y: 1.05, z: 0 },
          size: { x: 1.7, y: 1.3, z: 3.6 },
          mat: 'metal',
          colliderTag: 'prop',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'prop',
          batchKey: 'poi:service_metal',
          batchMode: 'static_box',
        },
      ],
    },
    {
      objectId: `poi:${site.id}:prop:fuel_island_01`,
      prefabId: 'service:fuel_island_pad',
      groundToTerrain: true,
      transform: {
        position: { x: q3(cx - 1.6), y: 0, z: q3(cz + 4.2) },
        yaw: 0,
        scale: { x: 1, y: 1, z: 1 },
      },
      parts: [
        {
          localId: 'island_slab',
          offset: { x: 0, y: 0.11, z: 0 },
          size: { x: 3.4, y: 0.22, z: 1.3 },
          mat: 'wall',
          colliderTag: 'structure',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'structure',
          batchKey: 'poi:service_cradle',
          batchMode: 'static_box',
        },
      ],
    },
    {
      objectId: `poi:${site.id}:prop:service_ramp_01`,
      prefabId: 'service:inspection_deck',
      groundToTerrain: true,
      transform: {
        position: { x: q3(cx + 2.4), y: 0, z: q3(cz + 4.2) },
        yaw: 0,
        scale: { x: 1, y: 1, z: 1 },
      },
      parts: [
        {
          localId: 'track_left',
          offset: { x: -0.85, y: 0.16, z: 0 },
          size: { x: 0.55, y: 0.32, z: 4.4 },
          mat: 'metal',
          colliderTag: 'structure',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'structure',
          batchKey: 'poi:service_metal',
          batchMode: 'static_box',
        },
        {
          localId: 'track_right',
          offset: { x: 0.85, y: 0.16, z: 0 },
          size: { x: 0.55, y: 0.32, z: 4.4 },
          mat: 'metal',
          colliderTag: 'structure',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'structure',
          batchKey: 'poi:service_metal',
          batchMode: 'static_box',
        },
      ],
    },
  ];

  return {
    buildings: [bld0, bld1],
    interiors,
    containers,
    props,
    floorY,
  };
}

// ---------------- 5. POI: O'rmon Kempingi (poi_forest_camp) ----------------

function buildForestCampSite(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  cabinetOpenFraction: number,
  containerOpenFraction: number,
): {
  buildings: BuildingPrefabPlacement[];
  interiors: InteriorFurniturePlacement[];
  containers: ContainerVisualPlacement[];
  props: PrefabPlacement[];
  floorY: number;
} {
  const cx = site.center.x;
  const cz = site.center.z;
  const floorY = q3(sampleTerrainHeight(terrain, cx, cz) + 0.16);

  // Building 0: 4x4 camp lodge rotated 180° (yaw = Math.PI) on the south side, doorway facing north (-Z) into camp clearing
  // Unrotated [0..4]x[0..4] rotated 180° around origin0 spans x in [origin0.x - 4, origin0.x], z in [origin0.z - 4, origin0.z]
  const bld0Id = `poi:${site.id}:bld:0`;
  const origin0: Vec3 = { x: q3(cx + 2), y: floorY, z: q3(cz + 9) };
  const yaw0 = Math.PI;
  const bld0 = rotateBuildingPrefab(buildRoom4x4Prefab(origin0, bld0Id), origin0, yaw0);
  bld0.name = 'Kemping Uychasi (4×4m)';

  const insideFurn = rotateFurniturePlacements(
    buildRoom4x4Furniture(origin0, bld0Id, cabinetOpenFraction),
    origin0,
    yaw0,
  );

  // Outdoor picnic table + 2 chairs near the central campfire clearing
  const picnicX = q3(cx + 4.6);
  const picnicZ = q3(cz - 1.5);
  const picnicY = q3(sampleTerrainHeight(terrain, picnicX, picnicZ));
  const outdoorPicnic: InteriorFurniturePlacement[] = [
    {
      id: `${bld0Id}:furn_picnic_table`,
      buildingId: bld0Id,
      assetId: 'wooden_table_01',
      position: { x: picnicX, y: picnicY, z: picnicZ },
      rotationY: 0,
      openFraction: 0,
    },
    {
      id: `${bld0Id}:furn_picnic_chair_n`,
      buildingId: bld0Id,
      assetId: 'wooden_chair_01',
      position: {
        x: picnicX,
        y: q3(sampleTerrainHeight(terrain, picnicX, picnicZ - 0.72)),
        z: q3(picnicZ - 0.72),
      },
      rotationY: 0,
      openFraction: 0,
    },
    {
      id: `${bld0Id}:furn_picnic_chair_s`,
      buildingId: bld0Id,
      assetId: 'wooden_chair_01',
      position: {
        x: picnicX,
        y: q3(sampleTerrainHeight(terrain, picnicX, picnicZ + 0.72)),
        z: q3(picnicZ + 0.72),
      },
      rotationY: Math.PI,
      openFraction: 0,
    },
  ];

  const interiors = reindexPoiFurniture(site.id, [...insideFurn, ...outdoorPicnic]);

  const insideContainers = rotateContainerPlacements(
    [
      makeContainerPlacement(
        site.id,
        0,
        'metal_locker_01',
        'weapon_locker',
        origin0.x + 1.5,
        floorY,
        origin0.z + 0.38,
        0,
        containerOpenFraction,
      ),
      makeContainerPlacement(
        site.id,
        1,
        'old_toolbox_01',
        'ammo_box',
        origin0.x + 3.46,
        floorY + 0.75,
        origin0.z + 2.0,
        -Math.PI / 2,
        containerOpenFraction,
      ),
    ],
    origin0,
    yaw0,
  );

  const chest1X = q3(cx - 4.2);
  const chest1Z = q3(cz - 5.2);
  const chest2X = q3(cx + 4.6);
  const chest2Z = q3(cz + 1.8);

  const containers: ContainerVisualPlacement[] = [
    ...insideContainers,
    makeContainerPlacement(
      site.id,
      2,
      'wooden_loot_crate_01',
      'camp_chest',
      chest1X,
      sampleTerrainHeight(terrain, chest1X, chest1Z),
      chest1Z,
      0,
      containerOpenFraction,
    ),
    makeContainerPlacement(
      site.id,
      3,
      'wooden_loot_crate_01',
      'supply_crate',
      chest2X,
      sampleTerrainHeight(terrain, chest2X, chest2Z),
      chest2Z,
      -Math.PI / 2,
      containerOpenFraction,
    ),
  ];

  // Original simple expedition utility van silhouette (static_box, mat: 'metal'), 2 wooden shelters, and campfire ring benches
  const props: PrefabPlacement[] = [
    {
      objectId: `poi:${site.id}:prop:expedition_van_01`,
      prefabId: 'camp:expedition_van_silhouette',
      groundToTerrain: true,
      transform: {
        position: { x: q3(cx - 6.8), y: 0, z: q3(cz - 1.2) },
        yaw: 0,
        scale: { x: 1, y: 1, z: 1 },
      },
      parts: [
        {
          localId: 'van_chassis_cabin',
          offset: { x: 0, y: 1.15, z: -0.3 },
          size: { x: 2.1, y: 1.5, z: 4.2 },
          mat: 'metal',
          colliderTag: 'prop',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'prop',
          batchKey: 'poi:camp_van_metal',
          batchMode: 'static_box',
        },
        {
          localId: 'van_hood',
          offset: { x: 0, y: 0.85, z: 2.25 },
          size: { x: 2.0, y: 0.9, z: 0.9 },
          mat: 'metal',
          colliderTag: 'prop',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'prop',
          batchKey: 'poi:camp_van_metal',
          batchMode: 'static_box',
        },
        {
          localId: 'wheel_fl',
          offset: { x: -0.95, y: 0.35, z: 1.65 },
          size: { x: 0.35, y: 0.7, z: 0.7 },
          mat: 'wall',
          colliderTag: 'prop',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'prop',
          batchKey: 'poi:camp_van_wheel',
          batchMode: 'static_box',
        },
        {
          localId: 'wheel_fr',
          offset: { x: 0.95, y: 0.35, z: 1.65 },
          size: { x: 0.35, y: 0.7, z: 0.7 },
          mat: 'wall',
          colliderTag: 'prop',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'prop',
          batchKey: 'poi:camp_van_wheel',
          batchMode: 'static_box',
        },
        {
          localId: 'wheel_rl',
          offset: { x: -0.95, y: 0.35, z: -1.45 },
          size: { x: 0.35, y: 0.7, z: 0.7 },
          mat: 'wall',
          colliderTag: 'prop',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'prop',
          batchKey: 'poi:camp_van_wheel',
          batchMode: 'static_box',
        },
        {
          localId: 'wheel_rr',
          offset: { x: 0.95, y: 0.35, z: -1.45 },
          size: { x: 0.35, y: 0.7, z: 0.7 },
          mat: 'wall',
          colliderTag: 'prop',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'prop',
          batchKey: 'poi:camp_van_wheel',
          batchMode: 'static_box',
        },
      ],
    },
    {
      objectId: `poi:${site.id}:prop:campfire_ring_01`,
      prefabId: 'camp:campfire_circle',
      groundToTerrain: true,
      transform: {
        position: { x: q3(cx + 0.5), y: 0, z: q3(cz - 0.4) },
        yaw: 0,
        scale: { x: 1, y: 1, z: 1 },
      },
      parts: [
        {
          localId: 'log_seat_north',
          offset: { x: 0, y: 0.22, z: -1.65 },
          size: { x: 1.8, y: 0.44, z: 0.48 },
          mat: 'crate',
          colliderTag: 'prop',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'prop',
          batchKey: 'poi:wood_stack',
          batchMode: 'static_box',
        },
        {
          localId: 'log_seat_west',
          offset: { x: -1.65, y: 0.22, z: 0 },
          size: { x: 0.48, y: 0.44, z: 1.8 },
          mat: 'crate',
          colliderTag: 'prop',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'prop',
          batchKey: 'poi:wood_stack',
          batchMode: 'static_box',
        },
      ],
    },
  ];

  return {
    buildings: [bld0],
    interiors,
    containers,
    props,
    floorY,
  };
}

// ---------------- 6. POI: Qoya Kuzatuv va Xaroba Hududi (poi_cliff_watch) ----------------

function buildCliffWatchSite(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  cabinetOpenFraction: number,
  containerOpenFraction: number,
): {
  buildings: BuildingPrefabPlacement[];
  interiors: InteriorFurniturePlacement[];
  containers: ContainerVisualPlacement[];
  props: PrefabPlacement[];
  floorY: number;
} {
  const cx = site.center.x;
  const cz = site.center.z;
  const floorY = q3(sampleTerrainHeight(terrain, cx, cz) + 0.16);

  // Building 0: 4x4 two-story watchpost (yaw = 0) with exterior west stairs ascending to y = floorY + 3.0 m
  const bld0Id = `poi:${site.id}:bld:0`;
  const origin0: Vec3 = { x: q3(cx - 2), y: floorY, z: q3(cz - 2) };
  const bld0 = buildWatchpost4x4Prefab(origin0, bld0Id);
  bld0.name = 'Qoya Kuzatuv Minorasi (4×4m)';

  const rawFurniture = buildWatchpost4x4Furniture(origin0, bld0Id, cabinetOpenFraction);
  const interiors = reindexPoiFurniture(site.id, rawFurniture);

  // 3 containers: 1 crate on the 2nd-floor observation deck (y = floorY + 3.0), 1 locker & 1 toolbox on ground floor
  const containers: ContainerVisualPlacement[] = [
    makeContainerPlacement(
      site.id,
      0,
      'wooden_loot_crate_01',
      'supply_crate',
      origin0.x + 3.25,
      floorY + 3.0,
      origin0.z + 0.75,
      0,
      containerOpenFraction,
    ),
    makeContainerPlacement(
      site.id,
      1,
      'metal_locker_01',
      'weapon_locker',
      origin0.x + 1.75,
      floorY,
      origin0.z + 0.38,
      0,
      containerOpenFraction,
    ),
    makeContainerPlacement(
      site.id,
      2,
      'old_toolbox_01',
      'ammo_box',
      origin0.x + 3.05,
      floorY + 0.75,
      origin0.z + 0.65,
      0,
      containerOpenFraction,
    ),
  ];

  // Surrounding ancient stone ruin walls & low tactical cover blocks (static_box, mat: 'wall')
  const props: PrefabPlacement[] = [
    {
      objectId: `poi:${site.id}:prop:ruin_wall_east`,
      prefabId: 'ruins:broken_stone_wall',
      groundToTerrain: true,
      transform: {
        position: { x: q3(cx + 5.8), y: 0, z: q3(cz - 0.5) },
        yaw: 0,
        scale: { x: 1, y: 1, z: 1 },
      },
      parts: [
        {
          localId: 'wall_low',
          offset: { x: 0, y: 0.65, z: 0 },
          size: { x: 0.7, y: 1.3, z: 5.2 },
          mat: 'wall',
          colliderTag: 'structure',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'structure',
          batchKey: 'poi:ruin_stone',
          batchMode: 'static_box',
        },
        {
          localId: 'pillar_north',
          offset: { x: 0, y: 1.25, z: -2.3 },
          size: { x: 0.9, y: 2.5, z: 0.9 },
          mat: 'wall',
          colliderTag: 'structure',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'structure',
          batchKey: 'poi:ruin_stone',
          batchMode: 'static_box',
        },
      ],
    },
    {
      objectId: `poi:${site.id}:prop:ruin_wall_north`,
      prefabId: 'ruins:low_parapet',
      groundToTerrain: true,
      transform: {
        position: { x: q3(cx + 1.0), y: 0, z: q3(cz - 6.4) },
        yaw: 0,
        scale: { x: 1, y: 1, z: 1 },
      },
      parts: [
        {
          localId: 'parapet_body',
          offset: { x: 0, y: 0.55, z: 0 },
          size: { x: 5.4, y: 1.1, z: 0.7 },
          mat: 'wall',
          colliderTag: 'structure',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'structure',
          batchKey: 'poi:ruin_stone',
          batchMode: 'static_box',
        },
      ],
    },
    {
      objectId: `poi:${site.id}:prop:ruin_cover_south`,
      prefabId: 'ruins:cover_blocks',
      groundToTerrain: true,
      transform: {
        position: { x: q3(cx + 4.4), y: 0, z: q3(cz + 5.2) },
        yaw: 0,
        scale: { x: 1, y: 1, z: 1 },
      },
      parts: [
        {
          localId: 'block_main',
          offset: { x: 0, y: 0.5, z: 0 },
          size: { x: 2.6, y: 1.0, z: 0.8 },
          mat: 'wall',
          colliderTag: 'structure',
          hasCollider: true,
          hasVisual: true,
          visualCategory: 'structure',
          batchKey: 'poi:ruin_stone',
          batchMode: 'static_box',
        },
      ],
    },
  ];

  return {
    buildings: [bld0],
    interiors,
    containers,
    props,
    floorY,
  };
}

// ---------------- Main Multi-Site POI Layout Builder ----------------

/**
 * Builds the complete 6-POI structure layout for `forest_square` (256x256 m).
 * Deterministic across client and server for a given `seed` and `terrain`.
 */
export function buildForestSquarePOILayout(
  terrain: TerrainDescriptor,
  seed = DEFAULT_PUBLIC_LAYOUT_SEED,
  chunkSize = DEFAULT_CHUNK_SIZE,
  opts: ForestSquarePOILayoutOptions = {},
): MultiSiteStructureLayout {
  const cabinetOpenFraction = opts.cabinetOpenFraction ?? 0;
  const containerOpenFraction = opts.containerOpenFraction ?? 0;

  const sites = getForestSquarePoiSites(seed);

  const buildings: BuildingPrefabPlacement[] = [];
  const buildingModules: BuildingModulePlacement[] = [];
  const porchSteps: BuildingPorchStepSpec[] = [];
  const interiors: InteriorFurniturePlacement[] = [];
  const containers: ContainerVisualPlacement[] = [];
  const colliders: ColliderBox[] = [];
  const propVisuals: VisualDescriptor[] = [];
  const locations: WorldLocation[] = [];

  for (const site of sites) {
    let built: {
      buildings: BuildingPrefabPlacement[];
      interiors: InteriorFurniturePlacement[];
      containers: ContainerVisualPlacement[];
      props: PrefabPlacement[];
      floorY: number;
    };

    switch (site.id) {
      case 'poi_ranger_house':
        built = buildRangerHouseSite(site, terrain, cabinetOpenFraction, containerOpenFraction);
        break;
      case 'poi_cabin_cluster':
        built = buildCabinClusterSite(site, terrain, cabinetOpenFraction, containerOpenFraction);
        break;
      case 'poi_lumber_mill':
        built = buildLumberMillSite(site, terrain, cabinetOpenFraction, containerOpenFraction);
        break;
      case 'poi_service_station':
        built = buildServiceStationSite(site, terrain, cabinetOpenFraction, containerOpenFraction);
        break;
      case 'poi_forest_camp':
        built = buildForestCampSite(site, terrain, cabinetOpenFraction, containerOpenFraction);
        break;
      case 'poi_cliff_watch':
        built = buildCliffWatchSite(site, terrain, cabinetOpenFraction, containerOpenFraction);
        break;
    }

    for (const bld of built.buildings) {
      buildings.push(bld);
      buildingModules.push(...bld.modules);
      porchSteps.push(...bld.porchSteps);
      colliders.push(...compileMultiSiteBuildingColliders(bld));
    }

    for (const furn of built.interiors) {
      interiors.push(furn);
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

    for (const cnt of built.containers) {
      containers.push(cnt);
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

    for (const prop of built.props) {
      const compiled = compilePrefabPlacement(prop, chunkSize, terrain);
      colliders.push(...compiled.colliders);
      propVisuals.push(...compiled.visuals);
    }

    locations.push({
      id: site.id,
      name: site.name,
      kind: site.kind,
      position: {
        x: q3(site.center.x),
        y: built.floorY,
        z: q3(site.center.z),
      },
      yaw: q3(site.yaw),
      radius: site.locationRadius,
      enterable: site.enterable,
    });
  }

  const outdoorPlacements = buildForestSquareOutdoorPlacements(terrain, seed);
  const outdoorColliders = compileAllOutdoorColliders(outdoorPlacements);
  const outdoorVisuals = buildOutdoorVisualDescriptors(outdoorPlacements, chunkSize);

  colliders.push(...outdoorColliders);

  const glbAndStepVisuals = buildMultiSiteVisualDescriptors({
    buildingModules,
    porchSteps,
    interiors,
    containers,
    chunkSize,
  });

  const visuals: VisualDescriptor[] = [...glbAndStepVisuals, ...propVisuals, ...outdoorVisuals];

  const worldAnchors: WorldItemAnchor[] = [
    ...interiors.flatMap((i) => compileInteriorPlacementAnchors(i)),
    ...containers.flatMap((c) => compileContainerPlacementAnchors(c)),
  ];

  const containerLocations: ContainerLocation[] = containers.map((c) => ({
    id: c.id,
    locationId: c.locationId,
    kind: c.containerKind,
    position: { ...c.position },
    yaw: c.rotationY,
    interactionRadius: c.interactionRadius,
  }));

  const layout: MultiSiteStructureLayout = {
    buildings,
    buildingModules,
    porchSteps,
    interiors,
    containers,
    outdoorPlacements,
    colliders,
    visuals,
    worldAnchors,
    locations,
    containerLocations,
  };

  assertUniqueLayoutIds(layout);
  return layout;
}

/**
 * Returns the world XZ bounding footprints (including a 1.0 m safety clearance around modules and porch steps)
 * for all modular buildings in a `MultiSiteStructureLayout`.
 * Used by vegetation, rock, and spawn generators to prevent clipping into buildings or doorways.
 */
export function getPoiBuildingFootprints(
  layout: MultiSiteStructureLayout,
): PoiBuildingFootprintRect[] {
  const footprints: PoiBuildingFootprintRect[] = [];
  const clearance = 1.0;

  for (const bld of layout.buildings) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    const bldColliders = compileMultiSiteBuildingColliders(bld);
    for (const col of bldColliders) {
      if (col.min.x < minX) minX = col.min.x;
      if (col.max.x > maxX) maxX = col.max.x;
      if (col.min.z < minZ) minZ = col.min.z;
      if (col.max.z > maxZ) maxZ = col.max.z;
    }

    if (Number.isFinite(minX) && Number.isFinite(maxX)) {
      footprints.push({
        minX: q3(minX - clearance),
        maxX: q3(maxX + clearance),
        minZ: q3(minZ - clearance),
        maxZ: q3(maxZ + clearance),
      });
    }
  }

  return footprints;
}
