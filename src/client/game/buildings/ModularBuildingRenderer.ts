import * as THREE from 'three';
import {
  type BuildingAssetId,
  type BuildingModulePlacement,
  type BuildingPorchStepSpec,
  type BuildingPrefabPlacement,
  type Stage04AMaterialName,
} from '../../../shared/structures/contracts';
import { getStage04ASharedMaterial } from '../Stage04ASharedMaterials';
import {
  areBuildingAssetsReady,
  getCachedBuildingAsset,
  onBuildingAssetsReady,
  preloadBuildingAssets,
} from './BuildingAssetRegistry';

export const WALL_HEIGHT_M = 3.0;
export const DOOR_MAX_OPEN_ANGLE_RAD = 1.45;
export const DEFAULT_PUBLIC_DOOR_OPEN_ANGLE_RAD = 1.38;

export interface ModularBuildingDoorController {
  doorId: string;
  buildingId: string;
  pivot: THREE.Object3D;
  defaultAngleRad: number;
  setOpenFraction: (t01: number) => void;
  setAngleRad: (rad: number) => void;
  resetToDefault: () => void;
}

export interface ModularBuildingsHandle {
  group: THREE.Group;
  doorControllers: Map<string, ModularBuildingDoorController>;
  setDevDoorDemoAngle: (angleRad: number | null, targetId?: string) => void;
  dispose: () => void;
}

interface TransformChunkSpec {
  geometry: THREE.BufferGeometry;
  worldMatrix: THREE.Matrix4;
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const EXTRA_END_POST_OFFSET = new THREE.Matrix4().makeTranslation(4.0, 0, 0);

/**
 * Places a 4m wall (or roof gable) between grid nodes `(ax, az) -> (bx, bz)` at height `y`
 * using the exact formula from `BUILDING-ASSET-01/README.md`:
 * - `corner_post` sits at node `(ax, az)`
 * - Exterior face (`+Z`) faces to the RIGHT of the `(ax, az) -> (bx, bz)` direction
 */
export function placeWall(
  obj: THREE.Object3D,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y = 0,
): void {
  obj.position.set((ax + bx) / 2, y, (az + bz) / 2);
  obj.rotation.y = Math.atan2(-(bz - az), bx - ax);
}

/**
 * Merges multiple template BufferGeometries transformed by their respective world matrices
 * into a single indexed BufferGeometry preserving `position`, `normal`, and 3-component `color`.
 */
function mergeTransformedGeometries(chunks: TransformChunkSpec[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;

  for (const { geometry } of chunks) {
    const pos = geometry.getAttribute('position');
    if (!pos) continue;
    totalVerts += pos.count;
    const idx = geometry.getIndex();
    totalIndices += idx ? idx.count : pos.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);

  const tmpPos = new THREE.Vector3();
  const tmpNorm = new THREE.Vector3();
  const normalMat = new THREE.Matrix3();

  let vertOffset = 0;
  let idxOffset = 0;

  for (const { geometry, worldMatrix } of chunks) {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    if (!geometry.getAttribute('normal')) {
      geometry.computeVertexNormals();
    }
    const norm = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;

    normalMat.getNormalMatrix(worldMatrix);

    for (let i = 0; i < pos.count; i++) {
      const dst = (vertOffset + i) * 3;

      tmpPos.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(worldMatrix);
      positions[dst] = tmpPos.x;
      positions[dst + 1] = tmpPos.y;
      positions[dst + 2] = tmpPos.z;

      if (norm) {
        tmpNorm.set(norm.getX(i), norm.getY(i), norm.getZ(i)).applyNormalMatrix(normalMat);
        normals[dst] = tmpNorm.x;
        normals[dst + 1] = tmpNorm.y;
        normals[dst + 2] = tmpNorm.z;
      } else {
        normals[dst] = 0;
        normals[dst + 1] = 1;
        normals[dst + 2] = 0;
      }

      colors[dst] = col ? col.getX(i) : 0.54;
      colors[dst + 1] = col ? col.getY(i) : 0.37;
      colors[dst + 2] = col ? col.getZ(i) : 0.22;
    }

    const idx = geometry.getIndex();
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
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.userData.sharedAsset = false;
  return merged;
}

function buildPorchStepGeometry(step: BuildingPorchStepSpec): THREE.BufferGeometry {
  const sx = Math.max(0.05, step.size.x);
  const sy = Math.max(0.04, step.size.y);
  const sz = Math.max(0.05, step.size.z);
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const vy = pos.getY(i);
    const topFactor = vy > 0 ? 1.04 : 0.9;
    colors[i * 3] = Math.min(1, 0.52 * topFactor);
    colors[i * 3 + 1] = Math.min(1, 0.35 * topFactor);
    colors[i * 3 + 2] = Math.min(1, 0.2 * topFactor);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.userData.sharedAsset = false;
  return geo;
}

/**
 * Collects all unique `BuildingPorchStepSpec` items from both `buildings[].porchSteps`
 * and the explicit `porchSteps` parameter.
 */
function collectUniquePorchSteps(
  buildings: BuildingPrefabPlacement[],
  porchSteps: BuildingPorchStepSpec[],
): BuildingPorchStepSpec[] {
  const byId = new Map<string, BuildingPorchStepSpec>();
  for (const b of buildings) {
    if (!b.porchSteps) continue;
    for (const step of b.porchSteps) {
      byId.set(step.id, step);
    }
  }
  for (const step of porchSteps) {
    byId.set(step.id, step);
  }
  return Array.from(byId.values());
}

/**
 * Builds the Stage 04A Modular Buildings scene group:
 * - Static building modules (`wood_wall_01`, `wood_wall_window_01`, `wood_wall_door_01`,
 *   `wood_floor_01`, `wood_roof_slope_01`, `wood_roof_gable_01`, `wood_stairs_01`) are batched
 *   by shared material (`wood`, `roof`, `iron`) for minimal draw calls.
 * - `hideCornerPost` omits the `corner_post` mesh on interior/shared-node walls;
 *   `extraEndCornerPost` adds a standalone `corner_post` at the open `+X` end.
 * - `wood_door_01` modules are cloned as individual hierarchies so `door_pivot` (`[-0.88, 0, 0]`)
 *   rotates independently (defaulting to `module.doorOpenAngleRad ?? 1.38` rad in public rooms).
 * - `porchSteps` are rendered with the shared `wood` material (`getStage04ASharedMaterial('wood')`).
 */
export function buildModularBuildingsScene(
  buildings: BuildingPrefabPlacement[],
  porchSteps: BuildingPorchStepSpec[] = [],
): ModularBuildingsHandle {
  if (!areBuildingAssetsReady()) {
    void preloadBuildingAssets();
  }

  const group = new THREE.Group();
  group.name = 'stage04a_modular_buildings';

  const staticBatchGroup = new THREE.Group();
  staticBatchGroup.name = 'buildings_static_batches';
  group.add(staticBatchGroup);

  const porchGroup = new THREE.Group();
  porchGroup.name = 'buildings_porch_steps';
  group.add(porchGroup);

  const doorsGroup = new THREE.Group();
  doorsGroup.name = 'buildings_doors';
  group.add(doorsGroup);

  const staticModules: BuildingModulePlacement[] = [];
  const doorModules: BuildingModulePlacement[] = [];

  for (const building of buildings) {
    for (const mod of building.modules) {
      if (mod.moduleId === 'wood_door_01') {
        doorModules.push(mod);
      } else {
        staticModules.push(mod);
      }
    }
  }

  const allPorchSteps = collectUniquePorchSteps(buildings, porchSteps);
  const doorControllers = new Map<string, ModularBuildingDoorController>();

  const disposeGroupDynamicGeometries = (targetGroup: THREE.Group): void => {
    for (let i = targetGroup.children.length - 1; i >= 0; i--) {
      const child = targetGroup.children[i];
      targetGroup.remove(child);
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.geometry && !obj.geometry.userData?.sharedAsset) {
          obj.geometry.dispose();
        }
      });
    }
  };

  const rebuildStaticBatches = (): void => {
    disposeGroupDynamicGeometries(staticBatchGroup);

    const chunksByMat = new Map<Stage04AMaterialName, TransformChunkSpec[]>();
    const modPos = new THREE.Vector3();
    const modQuat = new THREE.Quaternion();
    const moduleMatrix = new THREE.Matrix4();

    for (const mod of staticModules) {
      const tpl = getCachedBuildingAsset(mod.moduleId as BuildingAssetId);
      modPos.set(mod.position.x, mod.position.y, mod.position.z);
      modQuat.setFromAxisAngle(UP_AXIS, mod.rotationY);
      moduleMatrix.compose(modPos, modQuat, UNIT_SCALE);

      for (const part of tpl.bodyMeshes) {
        if (part.isDoorMovingPart) continue;

        if (!part.isCornerPost || !mod.hideCornerPost) {
          const worldMatrix = new THREE.Matrix4().multiplyMatrices(moduleMatrix, part.localMatrix);
          let list = chunksByMat.get(part.materialName);
          if (!list) {
            list = [];
            chunksByMat.set(part.materialName, list);
          }
          list.push({ geometry: part.geometry, worldMatrix });
        }

        if (part.isCornerPost && mod.extraEndCornerPost) {
          const shiftedLocal = new THREE.Matrix4().multiplyMatrices(
            EXTRA_END_POST_OFFSET,
            part.localMatrix,
          );
          const extraWorldMatrix = new THREE.Matrix4().multiplyMatrices(moduleMatrix, shiftedLocal);
          let list = chunksByMat.get(part.materialName);
          if (!list) {
            list = [];
            chunksByMat.set(part.materialName, list);
          }
          list.push({ geometry: part.geometry, worldMatrix: extraWorldMatrix });
        }
      }
    }

    for (const [matName, chunks] of chunksByMat.entries()) {
      if (chunks.length === 0) continue;
      const mergedGeo = mergeTransformedGeometries(chunks);
      const sharedMat = getStage04ASharedMaterial(matName);
      const batchMesh = new THREE.Mesh(mergedGeo, sharedMat);
      batchMesh.name = `buildings_static_${matName}`;
      batchMesh.castShadow = true;
      batchMesh.receiveShadow = true;
      batchMesh.matrixAutoUpdate = false;
      batchMesh.updateMatrix();
      batchMesh.userData.materialName = matName;
      batchMesh.userData.partCount = chunks.length;
      staticBatchGroup.add(batchMesh);
    }
  };

  const rebuildPorchSteps = (): void => {
    disposeGroupDynamicGeometries(porchGroup);
    if (allPorchSteps.length === 0) return;

    const stepChunks: TransformChunkSpec[] = [];
    const tempGeos: THREE.BufferGeometry[] = [];
    const stepPos = new THREE.Vector3();
    const stepQuat = new THREE.Quaternion();

    for (const step of allPorchSteps) {
      const stepGeo = buildPorchStepGeometry(step);
      tempGeos.push(stepGeo);
      stepPos.set(step.position.x, step.position.y, step.position.z);
      stepQuat.setFromAxisAngle(UP_AXIS, step.rotationY);
      const worldMatrix = new THREE.Matrix4().compose(stepPos, stepQuat, UNIT_SCALE);
      stepChunks.push({ geometry: stepGeo, worldMatrix });
    }

    const mergedStepsGeo = mergeTransformedGeometries(stepChunks);
    for (const g of tempGeos) {
      g.dispose();
    }

    const woodMat = getStage04ASharedMaterial('wood');
    const porchMesh = new THREE.Mesh(mergedStepsGeo, woodMat);
    porchMesh.name = 'buildings_porch_steps_wood';
    porchMesh.castShadow = true;
    porchMesh.receiveShadow = true;
    porchMesh.matrixAutoUpdate = false;
    porchMesh.updateMatrix();
    porchMesh.userData.materialName = 'wood';
    porchMesh.userData.porchStepCount = allPorchSteps.length;
    porchMesh.userData.porchStepIds = allPorchSteps.map((s) => s.id);
    porchGroup.add(porchMesh);
  };

  // Build initial static batches and porch steps
  rebuildStaticBatches();
  rebuildPorchSteps();

  // Build cloned wood_door_01 hierarchies with independent door_pivot nodes
  for (const mod of doorModules) {
    const doorTpl = getCachedBuildingAsset('wood_door_01');
    const doorRoot = doorTpl.templateScene.clone(true);
    doorRoot.name = mod.id;
    doorRoot.position.set(mod.position.x, mod.position.y, mod.position.z);
    doorRoot.rotation.set(0, mod.rotationY, 0);
    doorRoot.userData = {
      moduleId: 'wood_door_01',
      buildingId: mod.buildingId,
      doorId: mod.id,
    };

    let pivot = doorRoot.getObjectByName('door_pivot');
    if (!pivot) {
      pivot = new THREE.Group();
      pivot.name = 'door_pivot';
      pivot.position.set(-0.88, 0, 0);
      doorRoot.add(pivot);
    }

    const defaultAngleRad = mod.doorOpenAngleRad ?? DEFAULT_PUBLIC_DOOR_OPEN_ANGLE_RAD;
    pivot.rotation.set(0, defaultAngleRad, 0);
    doorRoot.updateMatrixWorld(true);
    doorsGroup.add(doorRoot);

    const controller: ModularBuildingDoorController = {
      doorId: mod.id,
      buildingId: mod.buildingId,
      pivot,
      defaultAngleRad,
      setOpenFraction: (t01: number) => {
        const clamped = THREE.MathUtils.clamp(t01, 0, 1);
        pivot.rotation.y = clamped * DOOR_MAX_OPEN_ANGLE_RAD;
      },
      setAngleRad: (rad: number) => {
        pivot.rotation.y = THREE.MathUtils.clamp(rad, 0, DOOR_MAX_OPEN_ANGLE_RAD);
      },
      resetToDefault: () => {
        pivot.rotation.y = defaultAngleRad;
      },
    };

    doorControllers.set(mod.id, controller);
  }

  // Upgrade fallback meshes to real GLB meshes when async preload finishes
  const unsubReady = onBuildingAssetsReady(() => {
    rebuildStaticBatches();

    const loadedDoorTpl = getCachedBuildingAsset('wood_door_01');
    const srcPivot = loadedDoorTpl.templateScene.getObjectByName('door_pivot');
    if (srcPivot) {
      for (const ctrl of doorControllers.values()) {
        const currentY = ctrl.pivot.rotation.y;
        ctrl.pivot.position.copy(srcPivot.position);
        for (let i = ctrl.pivot.children.length - 1; i >= 0; i--) {
          ctrl.pivot.remove(ctrl.pivot.children[i]);
        }
        for (const srcChild of srcPivot.children) {
          ctrl.pivot.add(srcChild.clone(true));
        }
        ctrl.pivot.rotation.y = currentY;
        ctrl.pivot.updateMatrixWorld(true);
      }
    }
  });

  group.userData = {
    buildingIds: buildings.map((b) => b.id),
    staticModuleCount: staticModules.length,
    doorCount: doorModules.length,
    porchStepCount: allPorchSteps.length,
  };

  const setDevDoorDemoAngle = (angleRad: number | null, targetId?: string): void => {
    for (const ctrl of doorControllers.values()) {
      if (targetId && ctrl.doorId !== targetId && ctrl.buildingId !== targetId) {
        continue;
      }
      if (angleRad === null) {
        ctrl.resetToDefault();
      } else {
        ctrl.setAngleRad(THREE.MathUtils.clamp(angleRad, 0, DOOR_MAX_OPEN_ANGLE_RAD));
      }
    }
  };

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubReady();
    if (group.parent) {
      group.parent.remove(group);
    }
    group.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) {
        obj.dispose();
      }
      if (obj instanceof THREE.Mesh) {
        if (obj.geometry && !obj.geometry.userData?.sharedAsset) {
          obj.geometry.dispose();
        }
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m && !m.userData?.sharedAsset) {
            m.dispose();
          }
        }
      }
    });
  };

  return {
    group,
    doorControllers,
    setDevDoorDemoAngle,
    dispose,
  };
}
