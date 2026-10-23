import * as THREE from 'three';
import type {
  AnchorSurfaceCategory,
  ContainerAssetId,
  ContainerVisualPlacement,
  PivotSpec,
  WorldItemAnchor,
} from '../../../shared/structures/contracts';
import type { ContainerKind } from '../../../shared/world';
import {
  CONTAINER_ASSET_MANIFEST,
  getCachedContainerAsset,
  instantiateContainerAsset,
  onContainerAssetsReady,
  preloadContainerAssets,
} from './ContainerAssetRegistry';

const ANCHOR_HELPER_COLOR = 0xef476f;
const DEFAULT_DAMP_LAMBDA = 10;

export interface ContainerInstanceController {
  id: string;
  locationId: string;
  assetId: ContainerAssetId;
  containerKind: ContainerKind;
  root: THREE.Group;
  pivotNode: THREE.Object3D;
  pivotSpec: PivotSpec;
  axis: 'x' | 'y' | 'z';
  closedAngleRad: number;
  openAngleRad: number;
  staticMeshes: THREE.Mesh[];
  movingMeshes: THREE.Mesh[];
  defaultOpenFraction: number;
  openFraction: number;
  targetOpenFraction: number;
  currentAngleRad: number;
  targetAngleRad: number;
  getOpenFraction(): number;
  getTargetOpenFraction(): number;
  getPivotAngleRad(): number;
  setOpenFraction(openFraction: number, damped?: boolean): void;
  setTargetOpenFraction(openFraction: number): void;
  updateDamped(dt: number, lambda?: number): void;
}

export interface ContainerVisualsSceneHandles {
  /** Root group containing all placed container instances and optional anchor helpers. */
  root: THREE.Group;
  /** Alias for `root` for convenience across callers. */
  group: THREE.Group;
  /** Placed container root groups keyed by `placement.id`. */
  instances: Map<string, THREE.Group>;
  /** Independent pivot animation controllers keyed by `placement.id`. */
  controllers: Map<string, ContainerInstanceController>;
  /** Alias for `controllers`. */
  containerControllers: Map<string, ContainerInstanceController>;
  /** Group holding debug sphere meshes for inside-container item anchors (`visible = false` by default). */
  anchorHelpersGroup: THREE.Group;
  /** World-space item anchors resolved for all placed containers. */
  worldAnchors: WorldItemAnchor[];
  /** Sets the open fraction (`[0..1]`) for a single container instance by `placement.id` or `locationId`. */
  setContainerOpenFraction(containerId: string, openFraction: number, damped?: boolean): void;
  /** Gets the current open fraction (`[0..1]`) for a container instance. */
  getContainerOpenFraction(containerId: string): number;
  /**
   * Dev-preview override for container lid/door open state (`0` = closed, `1` = open, `null` = restore default `0`).
   * - If `containerId` is provided, overrides only that specific container instance independently.
   * - If `containerId` is omitted, overrides all container instances in the scene.
   */
  setDevContainersOpenFraction(
    openFraction: number | null,
    containerId?: string,
    damped?: boolean,
  ): void;
  /** Returns current dev open-fraction override (`null` when using default multiplayer closed state). */
  getDevContainersOpenFraction(containerId?: string): number | null;
  /**
   * Advances damped pivot rotations (`THREE.MathUtils.damp(pivot.rotation[axis], target, 10, dt)`)
   * across all container instances without modifying static body meshes.
   */
  updateDampedAnimations(dt: number): void;
  /** Toggles visibility of debug spheres at inside-container anchor coordinates (`false` by default). */
  setAnchorHelpersVisible(visible: boolean): void;
  /** Returns whether debug anchor helper spheres are visible. */
  areAnchorHelpersVisible(): boolean;
  /** Disposes scene-local helper resources while preserving `userData.sharedAsset` geometries and materials. */
  dispose(): void;
}

/**
 * Computes world-space `WorldItemAnchor` points (`category: 'inside_container'`)
 * for all placed containers from their local manifest coordinates.
 */
export function computeContainerWorldAnchors(
  placements: ContainerVisualPlacement[],
): WorldItemAnchor[] {
  const out: WorldItemAnchor[] = [];
  const mat4 = new THREE.Matrix4();
  const posVec = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scaleVec = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler(0, 0, 0, 'XYZ');
  const localPt = new THREE.Vector3();
  const localUp = new THREE.Vector3();
  const normalMat = new THREE.Matrix3();

  for (const p of placements) {
    const spec = CONTAINER_ASSET_MANIFEST[p.assetId];
    if (!spec) continue;

    posVec.set(p.position.x, p.position.y, p.position.z);
    euler.set(0, p.rotationY, 0);
    quat.setFromEuler(euler);
    mat4.compose(posVec, quat, scaleVec);
    normalMat.getNormalMatrix(mat4);

    for (const anchor of spec.itemAnchors) {
      localPt.set(anchor.position[0], anchor.position[1], anchor.position[2]).applyMatrix4(mat4);
      localUp
        .set(anchor.up[0], anchor.up[1], anchor.up[2])
        .applyMatrix3(normalMat)
        .normalize();

      out.push({
        id: `${p.id}:${anchor.name}`,
        name: anchor.name,
        sourceInstanceId: p.id,
        assetId: p.assetId,
        category: anchor.category as AnchorSurfaceCategory,
        localPosition: [anchor.position[0], anchor.position[1], anchor.position[2]],
        worldPosition: {
          x: Number(localPt.x.toFixed(4)),
          y: Number(localPt.y.toFixed(4)),
          z: Number(localPt.z.toFixed(4)),
        },
        up: [
          Number(localUp.x.toFixed(4)),
          Number(localUp.y.toFixed(4)),
          Number(localUp.z.toFixed(4)),
        ],
        requiresOpenDoorOrLid: Boolean(anchor.requiresOpenDoorOrLid ?? true),
      });
    }
  }

  return out;
}

function clampOpenFraction(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return THREE.MathUtils.clamp(value, 0, 1);
}

function createContainerController(
  placement: ContainerVisualPlacement,
  instantiated: ReturnType<typeof instantiateContainerAsset>,
  initialFraction: number,
): ContainerInstanceController {
  const { root, pivotNode, pivotSpec, staticMeshes, movingMeshes } = instantiated;
  const axis = pivotSpec.axis;
  const closedAngleRad = pivotSpec.closedAngleRad ?? 0;
  const openAngleRad = pivotSpec.openAngleRad;
  const defaultOpenFraction = clampOpenFraction(placement.openFraction ?? 0);

  const applyAngleToPivot = (angleRad: number) => {
    pivotNode.rotation.set(0, 0, 0);
    pivotNode.rotation[axis] = angleRad;
    for (const sm of staticMeshes) {
      sm.rotation.set(0, 0, 0);
      sm.updateMatrix();
    }
    pivotNode.updateMatrix();
    root.updateMatrixWorld(true);
  };

  const controller: ContainerInstanceController = {
    id: placement.id,
    locationId: placement.locationId,
    assetId: placement.assetId,
    containerKind: placement.containerKind,
    root,
    pivotNode,
    pivotSpec,
    axis,
    closedAngleRad,
    openAngleRad,
    staticMeshes,
    movingMeshes,
    defaultOpenFraction,
    openFraction: 0,
    targetOpenFraction: 0,
    currentAngleRad: closedAngleRad,
    targetAngleRad: closedAngleRad,

    getOpenFraction(): number {
      return controller.openFraction;
    },

    getTargetOpenFraction(): number {
      return controller.targetOpenFraction;
    },

    getPivotAngleRad(): number {
      return pivotNode.rotation[axis];
    },

    setOpenFraction(nextFraction: number, damped = false): void {
      const clamped = clampOpenFraction(nextFraction);
      const targetAngle = closedAngleRad + (openAngleRad - closedAngleRad) * clamped;
      controller.targetOpenFraction = clamped;
      controller.targetAngleRad = targetAngle;

      if (!damped) {
        controller.openFraction = clamped;
        controller.currentAngleRad = targetAngle;
        applyAngleToPivot(targetAngle);
      }
    },

    setTargetOpenFraction(nextFraction: number): void {
      const clamped = clampOpenFraction(nextFraction);
      controller.targetOpenFraction = clamped;
      controller.targetAngleRad = closedAngleRad + (openAngleRad - closedAngleRad) * clamped;
    },

    updateDamped(dt: number, lambda = DEFAULT_DAMP_LAMBDA): void {
      const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
      const targetAngle = closedAngleRad + (openAngleRad - closedAngleRad) * controller.targetOpenFraction;
      controller.targetAngleRad = targetAngle;

      const currentPivotAngle = pivotNode.rotation[axis];
      let nextAngle =
        safeDt > 0
          ? THREE.MathUtils.damp(currentPivotAngle, targetAngle, lambda, safeDt)
          : targetAngle;

      if (Math.abs(nextAngle - targetAngle) < 1e-4) {
        nextAngle = targetAngle;
      }

      controller.currentAngleRad = nextAngle;
      const span = openAngleRad - closedAngleRad;
      controller.openFraction =
        Math.abs(span) > 1e-6
          ? THREE.MathUtils.clamp((nextAngle - closedAngleRad) / span, 0, 1)
          : controller.targetOpenFraction;

      applyAngleToPivot(nextAngle);
    },
  };

  controller.setOpenFraction(initialFraction, false);
  return controller;
}

/**
 * Builds the Stage 04A visual-only loot containers scene from `ContainerVisualPlacement[]`.
 * - Places each container instance (`wooden_loot_crate_01`, `metal_locker_01`, `old_toolbox_01`)
 *   at its world `position` and `rotationY`.
 * - Ensures every instance has an independent `lid_pivot` or `door_pivot` node so opening one
 *   container never affects other instances of the same model or its static body meshes.
 * - Keeps all containers in their default closed state (`openFraction = 0`) in live multiplayer rooms.
 * - Provides `setDevContainersOpenFraction(openFraction, containerId)` and `updateDampedAnimations(dt)`
 *   for dev-preview open/closed inspection.
 * - Preserves all `userData.sharedAsset` cached geometries and materials on `dispose()`.
 */
export function buildContainerVisualsScene(
  placements: ContainerVisualPlacement[],
  anchors?: WorldItemAnchor[],
): ContainerVisualsSceneHandles {
  void preloadContainerAssets();

  const root = new THREE.Group();
  root.name = 'stage04a_container_visuals';

  const containersGroup = new THREE.Group();
  containersGroup.name = 'container_visual_instances';
  root.add(containersGroup);

  const anchorHelpersGroup = new THREE.Group();
  anchorHelpersGroup.name = 'container_anchor_helpers';
  anchorHelpersGroup.visible = false;
  root.add(anchorHelpersGroup);

  const instances = new Map<string, THREE.Group>();
  const controllers = new Map<string, ContainerInstanceController>();
  const locationIdToPlacementId = new Map<string, string>();

  let devGlobalOpenFraction: number | null = null;
  const devPerContainerOverrides = new Map<string, number>();
  let disposed = false;
  let builtWithFallback = false;

  const resolvePlacementId = (idOrLocationId: string): string | undefined => {
    if (controllers.has(idOrLocationId)) return idOrLocationId;
    return locationIdToPlacementId.get(idOrLocationId);
  };

  const getEffectiveTargetFraction = (placement: ContainerVisualPlacement): number => {
    const perId = devPerContainerOverrides.get(placement.id);
    if (perId !== undefined) return perId;
    if (devGlobalOpenFraction !== null) return devGlobalOpenFraction;
    return clampOpenFraction(placement.openFraction ?? 0);
  };

  const populateContainerInstances = () => {
    if (disposed) return;

    const previousAngles = new Map<string, { openFraction: number; targetOpenFraction: number }>();
    for (const [id, ctrl] of controllers.entries()) {
      previousAngles.set(id, {
        openFraction: ctrl.openFraction,
        targetOpenFraction: ctrl.targetOpenFraction,
      });
    }

    while (containersGroup.children.length > 0) {
      containersGroup.remove(containersGroup.children[0]);
    }
    instances.clear();
    controllers.clear();
    locationIdToPlacementId.clear();
    builtWithFallback = false;

    for (const placement of placements) {
      const tpl = getCachedContainerAsset(placement.assetId);
      if (tpl.isFallback) {
        builtWithFallback = true;
      }

      const instantiated = instantiateContainerAsset(placement.assetId);
      const model = instantiated.root;
      model.name = placement.id;
      model.userData.placementId = placement.id;
      model.userData.locationId = placement.locationId;
      model.userData.assetId = placement.assetId;
      model.userData.containerKind = placement.containerKind;
      model.userData.interactionRadius = placement.interactionRadius;
      model.position.set(placement.position.x, placement.position.y, placement.position.z);
      model.rotation.set(0, placement.rotationY, 0);
      model.updateMatrixWorld(true);

      containersGroup.add(model);
      instances.set(placement.id, model);
      if (placement.locationId) {
        locationIdToPlacementId.set(placement.locationId, placement.id);
      }

      const prev = previousAngles.get(placement.id);
      const initialFraction = prev ? prev.targetOpenFraction : getEffectiveTargetFraction(placement);
      const ctrl = createContainerController(placement, instantiated, initialFraction);
      controllers.set(placement.id, ctrl);
    }
  };

  populateContainerInstances();

  const unsubscribeReady = onContainerAssetsReady(() => {
    if (!disposed && builtWithFallback) {
      populateContainerInstances();
    }
  });

  const resolvedAnchors =
    anchors && anchors.length > 0 ? anchors : computeContainerWorldAnchors(placements);

  const helperSphereGeo = new THREE.SphereGeometry(0.04, 8, 6);
  const helperSphereMat = new THREE.MeshBasicMaterial({
    name: 'container_anchor_helper_mat',
    color: ANCHOR_HELPER_COLOR,
  });

  for (const anchor of resolvedAnchors) {
    const sphere = new THREE.Mesh(helperSphereGeo, helperSphereMat);
    sphere.name = `anchor_helper_${anchor.id}`;
    sphere.position.set(anchor.worldPosition.x, anchor.worldPosition.y, anchor.worldPosition.z);
    sphere.userData = {
      anchorId: anchor.id,
      anchorName: anchor.name,
      category: anchor.category,
      sourceInstanceId: anchor.sourceInstanceId,
      assetId: anchor.assetId,
      requiresOpenDoorOrLid: anchor.requiresOpenDoorOrLid,
    };
    anchorHelpersGroup.add(sphere);
  }

  return {
    root,
    group: root,
    instances,
    controllers,
    containerControllers: controllers,
    anchorHelpersGroup,
    worldAnchors: resolvedAnchors,

    setContainerOpenFraction(containerId: string, openFraction: number, damped = false): void {
      const resolvedId = resolvePlacementId(containerId);
      if (!resolvedId) return;
      const ctrl = controllers.get(resolvedId);
      if (!ctrl) return;
      const clamped = clampOpenFraction(openFraction);
      devPerContainerOverrides.set(resolvedId, clamped);
      ctrl.setOpenFraction(clamped, damped);
    },

    getContainerOpenFraction(containerId: string): number {
      const resolvedId = resolvePlacementId(containerId);
      if (!resolvedId) return 0;
      return controllers.get(resolvedId)?.getOpenFraction() ?? 0;
    },

    setDevContainersOpenFraction(
      openFraction: number | null,
      containerId?: string,
      damped = false,
    ): void {
      if (containerId !== undefined) {
        const resolvedId = resolvePlacementId(containerId);
        if (!resolvedId) return;
        const ctrl = controllers.get(resolvedId);
        if (!ctrl) return;

        if (openFraction === null) {
          devPerContainerOverrides.delete(resolvedId);
          const fallbackTarget =
            devGlobalOpenFraction !== null ? devGlobalOpenFraction : ctrl.defaultOpenFraction;
          ctrl.setOpenFraction(fallbackTarget, damped);
        } else {
          const clamped = clampOpenFraction(openFraction);
          devPerContainerOverrides.set(resolvedId, clamped);
          ctrl.setOpenFraction(clamped, damped);
        }
        return;
      }

      if (openFraction === null) {
        devGlobalOpenFraction = null;
        devPerContainerOverrides.clear();
        for (const ctrl of controllers.values()) {
          ctrl.setOpenFraction(ctrl.defaultOpenFraction, damped);
        }
      } else {
        const clamped = clampOpenFraction(openFraction);
        devGlobalOpenFraction = clamped;
        devPerContainerOverrides.clear();
        for (const ctrl of controllers.values()) {
          ctrl.setOpenFraction(clamped, damped);
        }
      }
    },

    getDevContainersOpenFraction(containerId?: string): number | null {
      if (containerId !== undefined) {
        const resolvedId = resolvePlacementId(containerId);
        if (!resolvedId) return null;
        if (devPerContainerOverrides.has(resolvedId)) {
          return devPerContainerOverrides.get(resolvedId)!;
        }
        return devGlobalOpenFraction;
      }
      return devGlobalOpenFraction;
    },

    updateDampedAnimations(dt: number): void {
      if (disposed) return;
      for (const ctrl of controllers.values()) {
        ctrl.updateDamped(dt);
      }
    },

    setAnchorHelpersVisible(visible: boolean): void {
      anchorHelpersGroup.visible = Boolean(visible);
    },

    areAnchorHelpersVisible(): boolean {
      return anchorHelpersGroup.visible;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeReady();
      if (root.parent) {
        root.parent.remove(root);
      }
      root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (obj.geometry && !obj.geometry.userData?.sharedAsset) {
          obj.geometry.dispose();
        }
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m && !m.userData?.sharedAsset) {
            m.dispose();
          }
        }
      });
      helperSphereGeo.dispose();
      helperSphereMat.dispose();
      instances.clear();
      controllers.clear();
      locationIdToPlacementId.clear();
      devPerContainerOverrides.clear();
    },
  };
}
