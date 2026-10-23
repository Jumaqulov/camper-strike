import * as THREE from 'three';
import type { QualityLevel } from '../../settings';
import {
  areAllOutdoorAssetsLoaded,
  CAMPFIRE_FIRE_ANCHOR_LOCAL,
  getCachedOutdoorAsset,
  getOutdoorSharedMaterial,
  onOutdoorAssetsReady,
  OUTDOOR_ASSET_IDS,
  OUTDOOR_ASSET_MANIFEST,
  preloadOutdoorAssets,
  SIGNPOST_TEXT_ANCHORS,
  type OutdoorAssetId,
  type OutdoorPlacement,
  type OutdoorSignpostBoardLabel,
} from './OutdoorAssetRegistry';

export interface OutdoorRendererDiagnostics {
  totalPlacements: number;
  visiblePlacements: number;
  instancedBatchCount: number;
  activeDrawCalls: number;
  signpostOverlayCount: number;
  campfireEffectCount: number;
  allGlbLoaded: boolean;
  byAssetCount: Record<OutdoorAssetId, number>;
}

export interface OutdoorSceneHandles {
  group: THREE.Group;
  placements: readonly OutdoorPlacement[];
  update: (
    camera: THREE.Camera,
    frustum: THREE.Frustum,
    quality: QualityLevel,
    isTopDownOverview: boolean,
  ) => void;
  setQuality: (quality: QualityLevel) => void;
  getDiagnostics: () => OutdoorRendererDiagnostics;
  dispose: () => void;
}

interface CompiledPlacementRecord {
  placementIndex: number;
  placement: OutdoorPlacement;
  assetId: OutdoorAssetId;
  x: number;
  y: number;
  z: number;
  centerY: number;
  sphereRadius: number;
  maxDrawDistance: number;
  matrix: THREE.Matrix4;
  visible: boolean;
  distSq: number;
}

interface ManagedOutdoorBatch {
  assetId: OutdoorAssetId;
  meshName: string;
  mesh: THREE.InstancedMesh;
  records: CompiledPlacementRecord[];
  activeCount: number;
  activeSignature: number;
}

interface SignpostOverlayRecord {
  placementRecord: CompiledPlacementRecord;
  group: THREE.Group;
}

interface CampfireEffectRecord {
  placementRecord: CompiledPlacementRecord;
  group: THREE.Group;
}

// Singleton shared geometry & materials for signpost text overlays and campfire flames
let sharedSignPlaneGeo: THREE.PlaneGeometry | null = null;
const signLabelMaterialCache = new Map<string, THREE.MeshBasicMaterial>();

let sharedFlameOuterGeo: THREE.BufferGeometry | null = null;
let sharedFlameInnerGeo: THREE.BufferGeometry | null = null;
let sharedFlameOuterMat: THREE.MeshBasicMaterial | null = null;
let sharedFlameInnerMat: THREE.MeshBasicMaterial | null = null;

function getSharedSignPlaneGeometry(): THREE.PlaneGeometry {
  if (!sharedSignPlaneGeo) {
    sharedSignPlaneGeo = new THREE.PlaneGeometry(0.56, 0.14);
    sharedSignPlaneGeo.computeBoundingBox();
    sharedSignPlaneGeo.computeBoundingSphere();
    sharedSignPlaneGeo.userData.sharedAsset = true;
  }
  return sharedSignPlaneGeo;
}

function createSignLabelTexture(text: string, subtitle?: string): THREE.Texture {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Subtle dark burned-wood backing strip with feathered border for readability
      ctx.fillStyle = 'rgba(34, 21, 12, 0.72)';
      ctx.fillRect(6, 6, canvas.width - 12, canvas.height - 12);
      ctx.strokeStyle = 'rgba(235, 206, 152, 0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f7e5be';

      if (subtitle) {
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText(text, canvas.width * 0.5, 24, canvas.width - 28);
        ctx.font = '600 15px sans-serif';
        ctx.fillStyle = '#e0c28b';
        ctx.fillText(subtitle, canvas.width * 0.5, 46, canvas.width - 28);
      } else {
        ctx.font = 'bold 25px sans-serif';
        ctx.fillText(text, canvas.width * 0.5, canvas.height * 0.5, canvas.width - 24);
      }

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      tex.userData.sharedAsset = true;
      return tex;
    }
  }

  // Headless Node fallback DataTexture
  const data = new Uint8Array(16 * 4 * 4);
  for (let i = 0; i < 16 * 4; i++) {
    data[i * 4] = 242;
    data[i * 4 + 1] = 222;
    data[i * 4 + 2] = 180;
    data[i * 4 + 3] = 230;
  }
  const fallbackTex = new THREE.DataTexture(data, 16, 4, THREE.RGBAFormat);
  fallbackTex.needsUpdate = true;
  fallbackTex.userData.sharedAsset = true;
  return fallbackTex;
}

function getSignLabelMaterial(text: string, subtitle?: string): THREE.MeshBasicMaterial {
  const key = `${text}__${subtitle ?? ''}`;
  let mat = signLabelMaterialCache.get(key);
  if (!mat) {
    const tex = createSignLabelTexture(text, subtitle);
    mat = new THREE.MeshBasicMaterial({
      name: `signpost_label_${key}`,
      map: tex,
      transparent: true,
      alphaTest: 0.05,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    mat.userData.sharedAsset = true;
    signLabelMaterialCache.set(key, mat);
  }
  return mat;
}

function getSharedCampfireFlameAssets(): {
  outerGeo: THREE.BufferGeometry;
  innerGeo: THREE.BufferGeometry;
  outerMat: THREE.MeshBasicMaterial;
  innerMat: THREE.MeshBasicMaterial;
} {
  if (!sharedFlameOuterGeo) {
    // 5-sided open cone = 5 triangles (2 cones = 10 triangles <= 24 triangles budget)
    sharedFlameOuterGeo = new THREE.ConeGeometry(0.22, 0.42, 5, 1, true);
    sharedFlameOuterGeo.translate(0, 0.21, 0);
    sharedFlameOuterGeo.computeBoundingBox();
    sharedFlameOuterGeo.computeBoundingSphere();
    sharedFlameOuterGeo.userData.sharedAsset = true;
  }
  if (!sharedFlameInnerGeo) {
    sharedFlameInnerGeo = new THREE.ConeGeometry(0.13, 0.3, 5, 1, true);
    sharedFlameInnerGeo.translate(0, 0.15, 0);
    sharedFlameInnerGeo.computeBoundingBox();
    sharedFlameInnerGeo.computeBoundingSphere();
    sharedFlameInnerGeo.userData.sharedAsset = true;
  }
  if (!sharedFlameOuterMat) {
    sharedFlameOuterMat = new THREE.MeshBasicMaterial({
      name: 'campfire_flame_outer',
      color: '#ff7a1c',
    });
    sharedFlameOuterMat.userData.sharedAsset = true;
  }
  if (!sharedFlameInnerMat) {
    sharedFlameInnerMat = new THREE.MeshBasicMaterial({
      name: 'campfire_flame_inner',
      color: '#ffe169',
    });
    sharedFlameInnerMat.userData.sharedAsset = true;
  }
  return {
    outerGeo: sharedFlameOuterGeo,
    innerGeo: sharedFlameInnerGeo,
    outerMat: sharedFlameOuterMat,
    innerMat: sharedFlameInnerMat,
  };
}

function buildSignpostOverlayGroup(
  placement: OutdoorPlacement,
  labels: readonly OutdoorSignpostBoardLabel[],
): THREE.Group {
  const group = new THREE.Group();
  group.name = `signpost_overlay_${placement.id}`;
  group.position.set(placement.position.x, placement.position.y, placement.position.z);
  group.rotation.order = 'YXZ';
  group.rotation.set(
    placement.rotationX ?? 0,
    placement.rotationY ?? 0,
    placement.rotationZ ?? 0,
  );
  group.scale.set(
    placement.scale?.x ?? 1,
    placement.scale?.y ?? 1,
    placement.scale?.z ?? 1,
  );

  const planeGeo = getSharedSignPlaneGeometry();
  const tpl = getCachedOutdoorAsset('wooden_signpost_01');

  for (const anchor of SIGNPOST_TEXT_ANCHORS) {
    const labelSpec = labels.find((l) => l.boardIndex === anchor.boardIndex);
    if (!labelSpec) continue;

    const rawText =
      anchor.side === 'front'
        ? labelSpec.textFront
        : (labelSpec.textBack ?? labelSpec.textFront);
    if (!rawText) continue;

    const mat = getSignLabelMaterial(rawText, labelSpec.subtitle);
    const plane = new THREE.Mesh(planeGeo, mat);
    plane.name = anchor.name;
    const anchorPos = tpl.signAnchors?.[anchor.name] ?? anchor.position;
    plane.position.set(anchorPos[0], anchorPos[1], anchorPos[2]);
    // Rotate along the board angle; back face rotates +180 deg around Y so text faces outward
    const yawDeg = anchor.boardYawDeg + (anchor.side === 'back' ? 180 : 0);
    plane.rotation.y = THREE.MathUtils.degToRad(yawDeg);
    plane.castShadow = false;
    plane.receiveShadow = false;
    plane.userData.boardIndex = anchor.boardIndex;
    plane.userData.side = anchor.side;
    plane.userData.text = rawText;
    group.add(plane);
  }

  group.updateMatrixWorld(true);
  return group;
}

function buildCampfireFlameGroup(placement: OutdoorPlacement): THREE.Group {
  const { outerGeo, innerGeo, outerMat, innerMat } = getSharedCampfireFlameAssets();
  const group = new THREE.Group();
  group.name = `campfire_flame_${placement.id}`;

  const tpl = getCachedOutdoorAsset('campfire_pit_01');
  const anchor = tpl.fireAnchor ?? CAMPFIRE_FIRE_ANCHOR_LOCAL;

  group.position.set(
    placement.position.x + anchor[0] * (placement.scale?.x ?? 1),
    placement.position.y + anchor[1] * (placement.scale?.y ?? 1),
    placement.position.z + anchor[2] * (placement.scale?.z ?? 1),
  );
  group.rotation.y = placement.rotationY ?? 0;
  group.scale.set(
    placement.scale?.x ?? 1,
    placement.scale?.y ?? 1,
    placement.scale?.z ?? 1,
  );

  const outerCone = new THREE.Mesh(outerGeo, outerMat);
  outerCone.name = 'campfire_flame_outer_cone';
  outerCone.castShadow = false;
  outerCone.receiveShadow = false;

  const innerCone = new THREE.Mesh(innerGeo, innerMat);
  innerCone.name = 'campfire_flame_inner_cone';
  innerCone.rotation.y = 0.62;
  innerCone.castShadow = false;
  innerCone.receiveShadow = false;

  group.add(outerCone, innerCone);
  group.updateMatrixWorld(true);
  return group;
}

/**
 * Builds the Stage 08A (`OUTDOOR-ASSET-01`) batched outdoor scene:
 * - Batches all placements of the 8 outdoor GLB assets into `THREE.InstancedMesh` instances
 *   by sub-mesh (at most 16 instanced draw calls across all 8 models).
 * - Omits `railing_post_start` instances on `wooden_railing_01` placements where `hideStartPost === true`.
 * - Hot-swaps `InstancedMesh` geometries when `onOutdoorAssetsReady` fires.
 * - Renders Uzbek POI text overlays on `wooden_signpost_01` boards and stylized low-poly flame cones
 *   at `fire_anchor` (`[0, 0.15, 0]`) on lit `campfire_pit_01` placements.
 */
export function buildOutdoorScene(
  placements: readonly OutdoorPlacement[],
  initialQuality: QualityLevel = 'medium',
): OutdoorSceneHandles {
  if (!areAllOutdoorAssetsLoaded()) {
    void preloadOutdoorAssets();
  }

  const group = new THREE.Group();
  group.name = 'stage08a_outdoor_scene';

  const instancedGroup = new THREE.Group();
  instancedGroup.name = 'outdoor_instanced_batches';
  group.add(instancedGroup);

  const signpostGroup = new THREE.Group();
  signpostGroup.name = 'outdoor_signpost_overlays';
  group.add(signpostGroup);

  const campfireGroup = new THREE.Group();
  campfireGroup.name = 'outdoor_campfire_effects';
  group.add(campfireGroup);

  const byAssetCount: Record<OutdoorAssetId, number> = {
    wooden_signpost_01: 0,
    lumber_stack_01: 0,
    sawhorse_01: 0,
    old_fuel_pump_01: 0,
    rusty_barrel_01: 0,
    forest_tent_01: 0,
    campfire_pit_01: 0,
    wooden_railing_01: 0,
  };

  const posVec = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const quat = new THREE.Quaternion();
  const scaleVec = new THREE.Vector3(1, 1, 1);

  const placementRecords: CompiledPlacementRecord[] = [];
  const recordsByAsset = new Map<OutdoorAssetId, CompiledPlacementRecord[]>();

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    byAssetCount[p.assetId] = (byAssetCount[p.assetId] ?? 0) + 1;

    const manifest = OUTDOOR_ASSET_MANIFEST[p.assetId];
    const sx = p.scale?.x ?? 1;
    const sy = p.scale?.y ?? 1;
    const sz = p.scale?.z ?? 1;
    const maxScale = Math.max(sx, sy, sz);

    posVec.set(p.position.x, p.position.y, p.position.z);
    euler.set(p.rotationX ?? 0, p.rotationY ?? 0, p.rotationZ ?? 0, 'YXZ');
    quat.setFromEuler(euler);
    scaleVec.set(sx, sy, sz);

    const matrix = new THREE.Matrix4().compose(posVec, quat, scaleVec);
    const midY = (manifest.boundsMin[1] + manifest.boundsMax[1]) * 0.5 * sy;

    const rec: CompiledPlacementRecord = {
      placementIndex: i,
      placement: p,
      assetId: p.assetId,
      x: p.position.x,
      y: p.position.y,
      z: p.position.z,
      centerY: p.position.y + midY,
      sphereRadius: manifest.lodSphereRadius * maxScale,
      maxDrawDistance: manifest.maxDrawDistance,
      matrix,
      visible: true,
      distSq: 0,
    };

    placementRecords.push(rec);
    let list = recordsByAsset.get(p.assetId);
    if (!list) {
      list = [];
      recordsByAsset.set(p.assetId, list);
    }
    list.push(rec);
  }

  const managedBatches: ManagedOutdoorBatch[] = [];
  const signpostOverlays: SignpostOverlayRecord[] = [];
  const campfireEffects: CampfireEffectRecord[] = [];

  for (const assetId of OUTDOOR_ASSET_IDS) {
    const assetRecords = recordsByAsset.get(assetId);
    if (!assetRecords || assetRecords.length === 0) continue;

    const tpl = getCachedOutdoorAsset(assetId);
    for (const subMesh of tpl.subMeshes) {
      const eligibleRecords =
        assetId === 'wooden_railing_01' && subMesh.meshName === 'railing_post_start'
          ? assetRecords.filter((r) => !r.placement.hideStartPost)
          : assetRecords;

      if (eligibleRecords.length === 0) continue;

      const mat = getOutdoorSharedMaterial(subMesh.materialName);
      const instMesh = new THREE.InstancedMesh(subMesh.geometry, mat, eligibleRecords.length);
      instMesh.name = `outdoor_inst_${assetId}_${subMesh.meshName}`;
      instMesh.frustumCulled = false;
      instMesh.receiveShadow = subMesh.receiveShadow;
      instMesh.castShadow =
        initialQuality === 'low'
          ? assetId === 'forest_tent_01' || assetId === 'lumber_stack_01'
          : subMesh.castShadow;

      let sig = 2166136261;
      for (let k = 0; k < eligibleRecords.length; k++) {
        const rec = eligibleRecords[k];
        instMesh.setMatrixAt(k, rec.matrix);
        sig = Math.imul(sig ^ rec.placementIndex, 16777619) | 0;
      }
      instMesh.count = eligibleRecords.length;
      instMesh.instanceMatrix.needsUpdate = true;
      instancedGroup.add(instMesh);

      managedBatches.push({
        assetId,
        meshName: subMesh.meshName,
        mesh: instMesh,
        records: eligibleRecords,
        activeCount: eligibleRecords.length,
        activeSignature: sig,
      });
    }
  }

  // Build signpost text overlays & campfire flame effects
  for (const rec of placementRecords) {
    const p = rec.placement;
    if (p.assetId === 'wooden_signpost_01' && p.signLabels && p.signLabels.length > 0) {
      const overlay = buildSignpostOverlayGroup(p, p.signLabels);
      signpostGroup.add(overlay);
      signpostOverlays.push({
        placementRecord: rec,
        group: overlay,
      });
    } else if (p.assetId === 'campfire_pit_01' && p.campfireLit !== false) {
      const flame = buildCampfireFlameGroup(p);
      flame.visible = initialQuality !== 'low';
      campfireGroup.add(flame);
      campfireEffects.push({
        placementRecord: rec,
        group: flame,
      });
    }
  }

  let currentQuality: QualityLevel = initialQuality;
  let visiblePlacementsCount = placementRecords.length;

  // Hot-swap InstancedMesh geometries & anchor positions when GLB loading completes
  const unsubReady = onOutdoorAssetsReady(() => {
    for (const batch of managedBatches) {
      const tpl = getCachedOutdoorAsset(batch.assetId);
      const match = tpl.subMeshes.find((sm) => sm.meshName === batch.meshName);
      if (match && batch.mesh.geometry !== match.geometry) {
        batch.mesh.geometry = match.geometry;
      }
    }
    const signTpl = getCachedOutdoorAsset('wooden_signpost_01');
    if (signTpl.signAnchors) {
      for (const item of signpostOverlays) {
        for (const anchor of SIGNPOST_TEXT_ANCHORS) {
          const child = item.group.getObjectByName(anchor.name);
          const pos = signTpl.signAnchors[anchor.name];
          if (child && pos) {
            child.position.set(pos[0], pos[1], pos[2]);
          }
        }
      }
    }
    const fireTpl = getCachedOutdoorAsset('campfire_pit_01');
    if (fireTpl.fireAnchor) {
      for (const item of campfireEffects) {
        const p = item.placementRecord.placement;
        item.group.position.set(
          p.position.x + fireTpl.fireAnchor[0] * (p.scale?.x ?? 1),
          p.position.y + fireTpl.fireAnchor[1] * (p.scale?.y ?? 1),
          p.position.z + fireTpl.fireAnchor[2] * (p.scale?.z ?? 1),
        );
      }
    }
  });

  const instSphere = new THREE.Sphere();
  const visibleScratch: CompiledPlacementRecord[] = [];
  const SHADOW_DISTANCE_SQ = 42 * 42;
  const NEARBY_SHADOW_CASTER_SQ = 10 * 10;
  const LOW_QUALITY_FLAME_SQ = 28 * 28;

  const update = (
    camera: THREE.Camera,
    frustum: THREE.Frustum,
    quality: QualityLevel,
    isTopDownOverview: boolean,
  ): void => {
    currentQuality = quality;
    const camPos = camera.position;

    if (isTopDownOverview) {
      visiblePlacementsCount = placementRecords.length;
      const showSmallDetails = camPos.y <= 150;

      for (let i = 0; i < placementRecords.length; i++) {
        placementRecords[i].visible = true;
      }

      for (const batch of managedBatches) {
        batch.mesh.castShadow = false;
        const total = batch.records.length;
        let sig = 2166136261;
        for (let k = 0; k < total; k++) {
          sig = Math.imul(sig ^ batch.records[k].placementIndex, 16777619) | 0;
        }
        if (batch.activeCount !== total || batch.activeSignature !== sig) {
          for (let k = 0; k < total; k++) {
            batch.mesh.setMatrixAt(k, batch.records[k].matrix);
          }
          batch.mesh.count = total;
          batch.mesh.instanceMatrix.needsUpdate = true;
          batch.activeCount = total;
          batch.activeSignature = sig;
        }
      }

      for (const item of signpostOverlays) {
        item.group.visible = showSmallDetails;
      }
      for (const item of campfireEffects) {
        item.group.visible = showSmallDetails && quality !== 'low';
      }
      return;
    }

    const distMul = quality === 'low' ? 0.65 : quality === 'medium' ? 0.85 : 1.0;
    let visCount = 0;

    for (let i = 0; i < placementRecords.length; i++) {
      const rec = placementRecords[i];
      const dx = rec.x - camPos.x;
      const dy = rec.centerY - camPos.y;
      const dz = rec.z - camPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      rec.distSq = distSq;

      const maxD = rec.maxDrawDistance * distMul;
      if (distSq > maxD * maxD) {
        rec.visible = false;
        continue;
      }

      instSphere.center.set(rec.x, rec.centerY, rec.z);
      instSphere.radius = rec.sphereRadius;
      if (!frustum.intersectsSphere(instSphere) && distSq > NEARBY_SHADOW_CASTER_SQ) {
        rec.visible = false;
        continue;
      }

      rec.visible = true;
      visCount++;
    }

    visiblePlacementsCount = visCount;

    for (const batch of managedBatches) {
      visibleScratch.length = 0;
      let sig = 2166136261;
      let minDistSq = Infinity;

      for (let i = 0; i < batch.records.length; i++) {
        const rec = batch.records[i];
        if (!rec.visible) continue;
        visibleScratch.push(rec);
        sig = Math.imul(sig ^ rec.placementIndex, 16777619) | 0;
        if (rec.distSq < minDistSq) {
          minDistSq = rec.distSq;
        }
      }

      const outIdx = visibleScratch.length;
      if (quality === 'low') {
        batch.mesh.castShadow =
          outIdx > 0 &&
          (batch.assetId === 'forest_tent_01' || batch.assetId === 'lumber_stack_01') &&
          minDistSq <= SHADOW_DISTANCE_SQ;
      } else {
        batch.mesh.castShadow = outIdx > 0 && minDistSq <= SHADOW_DISTANCE_SQ;
      }

      if (outIdx !== batch.activeCount || sig !== batch.activeSignature) {
        for (let k = 0; k < outIdx; k++) {
          batch.mesh.setMatrixAt(k, visibleScratch[k].matrix);
        }
        batch.mesh.count = outIdx;
        batch.mesh.instanceMatrix.needsUpdate = true;
        batch.activeCount = outIdx;
        batch.activeSignature = sig;
      }
    }

    for (const item of signpostOverlays) {
      item.group.visible = item.placementRecord.visible;
    }

    for (const item of campfireEffects) {
      const rec = item.placementRecord;
      if (!rec.visible) {
        item.group.visible = false;
      } else if (quality === 'low') {
        item.group.visible = rec.distSq <= LOW_QUALITY_FLAME_SQ;
      } else {
        item.group.visible = true;
      }
    }
  };

  const setQuality = (quality: QualityLevel): void => {
    currentQuality = quality;
    for (const batch of managedBatches) {
      if (quality === 'low') {
        batch.mesh.castShadow =
          batch.activeCount > 0 &&
          (batch.assetId === 'forest_tent_01' || batch.assetId === 'lumber_stack_01');
      } else {
        batch.mesh.castShadow = batch.activeCount > 0;
      }
    }
    for (const item of campfireEffects) {
      item.group.visible = item.placementRecord.visible && quality !== 'low';
    }
  };

  const getDiagnostics = (): OutdoorRendererDiagnostics => {
    let activeDrawCalls = 0;
    for (const batch of managedBatches) {
      if (batch.mesh.visible && batch.activeCount > 0) {
        activeDrawCalls++;
      }
    }
    return {
      totalPlacements: placements.length,
      visiblePlacements: visiblePlacementsCount,
      instancedBatchCount: managedBatches.length,
      activeDrawCalls,
      signpostOverlayCount: signpostOverlays.length,
      campfireEffectCount: campfireEffects.length,
      allGlbLoaded: areAllOutdoorAssetsLoaded(),
      byAssetCount: { ...byAssetCount },
    };
  };

  const dispose = (): void => {
    unsubReady();
    for (const batch of managedBatches) {
      batch.mesh.dispose();
    }
    group.traverse((obj) => {
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
    placements,
    update,
    setQuality,
    getDiagnostics,
    dispose,
  };
}
