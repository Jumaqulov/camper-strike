import * as THREE from 'three';
import type {
  AnchorSurfaceCategory,
  InteriorFurniturePlacement,
  WorldItemAnchor,
} from '../../../shared/structures/contracts';
import {
  getCachedInteriorAsset,
  INTERIOR_ASSET_MANIFEST,
  instantiateInteriorAsset,
  KITCHEN_CABINET_LEFT_OPEN_ANGLE_RAD,
  KITCHEN_CABINET_LEFT_PIVOT_NAME,
  KITCHEN_CABINET_LEFT_PIVOT_POS,
  KITCHEN_CABINET_RIGHT_OPEN_ANGLE_RAD,
  KITCHEN_CABINET_RIGHT_PIVOT_NAME,
  KITCHEN_CABINET_RIGHT_PIVOT_POS,
  onInteriorAssetsReady,
  preloadInteriorAssets,
} from './InteriorAssetRegistry';

const ANCHOR_CATEGORY_COLORS: Record<AnchorSurfaceCategory, number> = {
  tabletop: 0xffd166,
  countertop: 0x06d6a0,
  shelf: 0x4cc9f0,
  under_bed: 0xf72585,
  inside_cabinet: 0xff9f1c,
  mattress: 0xb5179e,
  sofa_seat: 0x7209b7,
  chair_seat: 0x4361ee,
  inside_container: 0xef476f,
};

export interface KitchenCabinetController {
  id: string;
  buildingId: string;
  root: THREE.Group;
  body: THREE.Object3D | null;
  doorLeftPivot: THREE.Object3D;
  doorRightPivot: THREE.Object3D;
  defaultOpenFraction: number;
  openFraction: number;
  getOpenFraction(): number;
  setOpenFraction(openFraction: number): void;
}

export interface InteriorFurnitureSceneHandles {
  /** Root group containing all placed interior furniture and optional anchor helpers. */
  root: THREE.Group;
  /** Alias for `root` for convenience across callers. */
  group: THREE.Group;
  /** Placed furniture root groups keyed by `placement.id`. */
  instances: Map<string, THREE.Group>;
  /** Independent door pivot controllers for each placed `kitchen_cabinet_01` keyed by `placement.id`. */
  cabinetControllers: Map<string, KitchenCabinetController>;
  /** Group holding debug sphere meshes for item anchors (`visible = false` by default). */
  anchorHelpersGroup: THREE.Group;
  /** World-space item anchors resolved for this interior scene. */
  worldAnchors: WorldItemAnchor[];
  /** Sets the door open fraction (`[0..1]`) for a specific `kitchen_cabinet_01` instance. */
  setCabinetOpenFraction(placementId: string, openFraction: number): void;
  /**
   * Overrides all `kitchen_cabinet_01` instances in dev-demo mode (`0..1` -> `-1.75 / +1.75 rad`),
   * or pass `null` to restore each cabinet's default `placement.openFraction` (e.g. `0` in live multiplayer).
   */
  setDevCabinetOpenFraction(openFraction: number | null): void;
  /** Returns current dev override (`null` when using per-placement default `openFraction`). */
  getDevCabinetOpenFraction(): number | null;
  /** Toggles visibility of small colored debug spheres at item anchor locations (`false` by default). */
  setAnchorHelpersVisible(visible: boolean): void;
  /** Returns whether anchor helper spheres are currently visible. */
  areAnchorHelpersVisible(): boolean;
  /** Disposes non-shared scene resources while preserving `userData.sharedAsset` geometries and materials. */
  dispose(): void;
}

/**
 * Computes world-space `WorldItemAnchor` records from a list of `InteriorFurniturePlacement`s
 * using the `INTERIOR-ASSET-01` manifest local coordinates and `applyMatrix4(furniture.matrixWorld)`.
 */
export function computeInteriorWorldAnchors(
  placements: InteriorFurniturePlacement[],
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
    const spec = INTERIOR_ASSET_MANIFEST[p.assetId];
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
        category: anchor.category,
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
        requiresOpenDoorOrLid: Boolean(anchor.requiresOpenDoorOrLid),
      });
    }
  }

  return out;
}

function attachCabinetController(
  placement: InteriorFurniturePlacement,
  model: THREE.Group,
  initialFraction: number,
): KitchenCabinetController {
  const body = model.getObjectByName('kitchen_cabinet_01_body') ?? null;

  let doorLeftPivot = model.getObjectByName(KITCHEN_CABINET_LEFT_PIVOT_NAME);
  if (!doorLeftPivot) {
    doorLeftPivot = new THREE.Group();
    doorLeftPivot.name = KITCHEN_CABINET_LEFT_PIVOT_NAME;
    doorLeftPivot.position.set(...KITCHEN_CABINET_LEFT_PIVOT_POS);
    model.add(doorLeftPivot);
  }

  let doorRightPivot = model.getObjectByName(KITCHEN_CABINET_RIGHT_PIVOT_NAME);
  if (!doorRightPivot) {
    doorRightPivot = new THREE.Group();
    doorRightPivot.name = KITCHEN_CABINET_RIGHT_PIVOT_NAME;
    doorRightPivot.position.set(...KITCHEN_CABINET_RIGHT_PIVOT_POS);
    model.add(doorRightPivot);
  }

  const defaultOpenFraction = THREE.MathUtils.clamp(placement.openFraction ?? 0, 0, 1);

  const controller: KitchenCabinetController = {
    id: placement.id,
    buildingId: placement.buildingId,
    root: model,
    body,
    doorLeftPivot,
    doorRightPivot,
    defaultOpenFraction,
    openFraction: 0,
    getOpenFraction() {
      return controller.openFraction;
    },
    setOpenFraction(nextFraction: number) {
      const clamped = THREE.MathUtils.clamp(
        Number.isFinite(nextFraction) ? nextFraction : 0,
        0,
        1,
      );
      controller.openFraction = clamped;
      doorLeftPivot.rotation.set(0, KITCHEN_CABINET_LEFT_OPEN_ANGLE_RAD * clamped, 0);
      doorRightPivot.rotation.set(0, KITCHEN_CABINET_RIGHT_OPEN_ANGLE_RAD * clamped, 0);
      if (body) {
        body.rotation.set(0, 0, 0);
      }
      doorLeftPivot.updateMatrix();
      doorRightPivot.updateMatrix();
      model.updateMatrixWorld(true);
    },
  };

  controller.setOpenFraction(initialFraction);
  return controller;
}

/**
 * Builds the Stage 04A interior furniture scene from `InteriorFurniturePlacement[]` and optional `WorldItemAnchor[]`.
 * - Places all 6 furniture models (`wooden_table_01`, `wooden_chair_01`, `wooden_shelf_01`, `old_bed_01`,
 *   `old_sofa_01`, `kitchen_cabinet_01`) at their world `position` and `rotationY`.
 * - Exposes `cabinetControllers` so `kitchen_cabinet_01` `door_left_pivot` (`-1.75 * openFraction`) and
 *   `door_right_pivot` (`+1.75 * openFraction`) rotate independently around their hinge axes while
 *   `kitchen_cabinet_01_body` remains static.
 * - Defaults to `placement.openFraction` (e.g. `0` in public multiplayer rooms) and supports dev-demo
 *   override via `setDevCabinetOpenFraction(openFraction)`.
 * - Supports optional dev-mode item anchor visualization via `setAnchorHelpersVisible(visible)`.
 */
export function buildInteriorFurnitureScene(
  placements: InteriorFurniturePlacement[],
  anchors?: WorldItemAnchor[],
): InteriorFurnitureSceneHandles {
  void preloadInteriorAssets();

  const root = new THREE.Group();
  root.name = 'stage04a_interior_furniture';

  const furnitureGroup = new THREE.Group();
  furnitureGroup.name = 'interior_furniture_instances';
  root.add(furnitureGroup);

  const anchorHelpersGroup = new THREE.Group();
  anchorHelpersGroup.name = 'interior_anchor_helpers';
  anchorHelpersGroup.visible = false;
  root.add(anchorHelpersGroup);

  const instances = new Map<string, THREE.Group>();
  const cabinetControllers = new Map<string, KitchenCabinetController>();
  let devCabinetOpenFraction: number | null = null;
  let disposed = false;
  let builtWithFallback = false;

  const populateFurnitureInstances = () => {
    if (disposed) return;

    const previousFractions = new Map<string, number>();
    for (const [id, ctrl] of cabinetControllers.entries()) {
      previousFractions.set(id, ctrl.openFraction);
    }

    while (furnitureGroup.children.length > 0) {
      furnitureGroup.remove(furnitureGroup.children[0]);
    }
    instances.clear();
    cabinetControllers.clear();
    builtWithFallback = false;

    for (const placement of placements) {
      const tpl = getCachedInteriorAsset(placement.assetId);
      if (tpl.isFallback) {
        builtWithFallback = true;
      }

      const model = instantiateInteriorAsset(placement.assetId);
      model.name = placement.id;
      model.userData.placementId = placement.id;
      model.userData.buildingId = placement.buildingId;
      model.userData.assetId = placement.assetId;
      model.position.set(placement.position.x, placement.position.y, placement.position.z);
      model.rotation.set(0, placement.rotationY, 0);
      model.updateMatrixWorld(true);

      furnitureGroup.add(model);
      instances.set(placement.id, model);

      if (placement.assetId === 'kitchen_cabinet_01') {
        const effectiveFraction =
          devCabinetOpenFraction !== null
            ? devCabinetOpenFraction
            : (previousFractions.get(placement.id) ?? placement.openFraction ?? 0);
        const ctrl = attachCabinetController(placement, model, effectiveFraction);
        cabinetControllers.set(placement.id, ctrl);
      }
    }
  };

  populateFurnitureInstances();

  const unsubscribeReady = onInteriorAssetsReady(() => {
    if (!disposed && builtWithFallback) {
      populateFurnitureInstances();
    }
  });

  // Resolve world anchors (use provided anchors or compute from placements)
  const resolvedAnchors =
    anchors && anchors.length > 0 ? anchors : computeInteriorWorldAnchors(placements);

  const helperSphereGeo = new THREE.SphereGeometry(0.045, 8, 6);
  const helperMaterialsByCategory = new Map<AnchorSurfaceCategory, THREE.MeshBasicMaterial>();

  const getHelperMaterial = (category: AnchorSurfaceCategory): THREE.MeshBasicMaterial => {
    let mat = helperMaterialsByCategory.get(category);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        name: `anchor_helper_mat_${category}`,
        color: ANCHOR_CATEGORY_COLORS[category] ?? 0xffffff,
      });
      helperMaterialsByCategory.set(category, mat);
    }
    return mat;
  };

  for (const anchor of resolvedAnchors) {
    const sphere = new THREE.Mesh(helperSphereGeo, getHelperMaterial(anchor.category));
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
    cabinetControllers,
    anchorHelpersGroup,
    worldAnchors: resolvedAnchors,

    setCabinetOpenFraction(placementId: string, openFraction: number): void {
      const ctrl = cabinetControllers.get(placementId);
      if (ctrl) {
        ctrl.setOpenFraction(openFraction);
      }
    },

    setDevCabinetOpenFraction(openFraction: number | null): void {
      devCabinetOpenFraction =
        openFraction === null
          ? null
          : THREE.MathUtils.clamp(Number.isFinite(openFraction) ? openFraction : 0, 0, 1);

      for (const ctrl of cabinetControllers.values()) {
        const target =
          devCabinetOpenFraction !== null ? devCabinetOpenFraction : ctrl.defaultOpenFraction;
        ctrl.setOpenFraction(target);
      }
    },

    getDevCabinetOpenFraction(): number | null {
      return devCabinetOpenFraction;
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
      for (const mat of helperMaterialsByCategory.values()) {
        mat.dispose();
      }
      helperMaterialsByCategory.clear();
      instances.clear();
      cabinetControllers.clear();
    },
  };
}
