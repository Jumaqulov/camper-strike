export {
  areBuildingAssetsReady,
  getBuildingAssetDiagnostics,
  getCachedBuildingAsset,
  hasBuildingAssetFailed,
  onBuildingAssetsReady,
  preloadBuildingAssets,
  registerBuildingAssetFromObject,
  type BuildingAssetDiagnosticEntry,
  type BuildingBodyMeshPart,
  type CachedBuildingAssetTemplate,
} from './BuildingAssetRegistry';

export {
  buildModularBuildingsScene,
  DEFAULT_PUBLIC_DOOR_OPEN_ANGLE_RAD,
  DOOR_MAX_OPEN_ANGLE_RAD,
  placeWall,
  WALL_HEIGHT_M,
  type ModularBuildingDoorController,
  type ModularBuildingsHandle,
} from './ModularBuildingRenderer';
