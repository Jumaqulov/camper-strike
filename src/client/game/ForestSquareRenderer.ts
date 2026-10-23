import * as THREE from 'three';
import type { MaterialKind } from '../../shared/map';
import type {
  BuildingPrefabPlacement,
  Stage04APreviewLayout,
} from '../../shared/structures/contracts';
import type { VisualDescriptor, WorldDefinition } from '../../shared/world';
import type { QualityLevel } from '../settings';
import type { ModularBuildingsHandle } from './buildings';
import type { ContainerVisualsSceneHandles } from './containers';
import type { InteriorFurnitureSceneHandles } from './interiors';
import { TEX_SCALE } from './Textures';

/**
 * Scales `BoxGeometry` UVs by face dimensions and texture world scale.
 */
export function scaleBoxUVs(
  geo: THREE.BoxGeometry,
  w: number,
  h: number,
  d: number,
  scale: number | null,
): void {
  if (!scale) return;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const dims: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / scale, (uv.getY(i) * dims[f][1]) / scale);
    }
  }
  uv.needsUpdate = true;
}

/**
 * Merges indexed static geometries that share a material (preserving `position`, `normal`, `uv`),
 * disposing intermediate input geometries to prevent memory leaks.
 */
export function mergeStaticGeometriesWithUV(
  geometries: THREE.BufferGeometry[],
): THREE.BufferGeometry {
  if (geometries.length === 1) {
    geometries[0].computeBoundingSphere();
    geometries[0].computeBoundingBox();
    geometries[0].userData.sharedAsset = false;
    return geometries[0];
  }

  let totalVerts = 0;
  let totalIndices = 0;
  let hasUv = true;

  for (let gIdx = 0; gIdx < geometries.length; gIdx++) {
    const g = geometries[gIdx];
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) hasUv = false;
    const pos = g.getAttribute('position');
    totalVerts += pos.count;
    const idx = g.getIndex();
    totalIndices += idx ? idx.count : pos.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = hasUv ? new Float32Array(totalVerts * 2) : null;
  const indices = new Uint32Array(totalIndices);

  let vertOffset = 0;
  let idxOffset = 0;

  for (let gIdx = 0; gIdx < geometries.length; gIdx++) {
    const g = geometries[gIdx];
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const norm = g.getAttribute('normal') as THREE.BufferAttribute;
    const uv = hasUv ? (g.getAttribute('uv') as THREE.BufferAttribute) : null;

    positions.set(pos.array as Float32Array, vertOffset * 3);
    normals.set(norm.array as Float32Array, vertOffset * 3);
    if (uvs && uv) uvs.set(uv.array as Float32Array, vertOffset * 2);

    const idx = g.getIndex();
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
    g.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (uvs) merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  merged.userData.sharedAsset = false;
  return merged;
}

export interface BuildMergedStaticBoxMeshesOptions {
  /**
   * When true, skips `vis.prefabId === 'cabin:porch_step'` descriptors that are already rendered
   * by `ModularBuildingRenderer`'s porch step batch. Defaults to `false`.
   */
  excludePorchSteps?: boolean;
}

/**
 * Merges all `vis.batchMode === 'static_box'` procedural prop and structure boxes
 * (`lumber_mill` timber stacks, `service_station` service bay/canopy, `forest_camp` camper van/tents,
 * `cliff_watch` stone ruins, etc.) into one merged `THREE.Mesh` per `MaterialKind` (1–4 draw calls total).
 *
 * Applies UV scaling first, then `geo.rotateY(vis.transform.yaw)` when `yaw !== 0`, and finally
 * `geo.translate(cx, cy, cz)` so rotated POI props align 100% with their physical colliders.
 */
export function buildMergedStaticBoxMeshes(
  visuals: readonly VisualDescriptor[],
  mats: Record<MaterialKind, THREE.MeshStandardMaterial>,
  texScale: Record<MaterialKind, number | null> = TEX_SCALE,
  opts?: BuildMergedStaticBoxMeshesOptions,
): THREE.Mesh[] {
  const excludePorchSteps = opts?.excludePorchSteps ?? false;
  const staticGeosByMat = new Map<MaterialKind, THREE.BufferGeometry[]>();
  const castShadowByMat = new Map<MaterialKind, boolean>();
  const receiveShadowByMat = new Map<MaterialKind, boolean>();

  for (let i = 0; i < visuals.length; i++) {
    const vis = visuals[i];
    if (vis.batchMode !== 'static_box' || !vis.boxDims || !vis.material) continue;
    if (excludePorchSteps && vis.prefabId === 'cabin:porch_step') continue;

    const w = vis.boxDims.x;
    const h = vis.boxDims.y;
    const d = vis.boxDims.z;
    const cx = vis.transform.position.x;
    const cy = vis.transform.position.y;
    const cz = vis.transform.position.z;
    const yaw = vis.transform.yaw;
    const mat = vis.material;

    const geo = new THREE.BoxGeometry(w, h, d);
    scaleBoxUVs(geo, w, h, d, texScale[mat] ?? null);
    if (yaw !== 0) {
      geo.rotateY(yaw);
    }
    geo.translate(cx, cy, cz);

    let list = staticGeosByMat.get(mat);
    if (!list) {
      list = [];
      staticGeosByMat.set(mat, list);
      castShadowByMat.set(mat, false);
      receiveShadowByMat.set(mat, false);
    }
    list.push(geo);

    if (vis.castShadow) {
      castShadowByMat.set(mat, true);
    }
    if (vis.receiveShadow) {
      receiveShadowByMat.set(mat, true);
    }
  }

  const meshes: THREE.Mesh[] = [];
  for (const [mat, geos] of staticGeosByMat.entries()) {
    if (geos.length === 0) continue;
    const matInstance = mats[mat];
    if (!matInstance) {
      for (let i = 0; i < geos.length; i++) {
        geos[i].dispose();
      }
      continue;
    }

    const boxCount = geos.length;
    const mergedGeo = mergeStaticGeometriesWithUV(geos);
    const mergedMesh = new THREE.Mesh(mergedGeo, matInstance);
    mergedMesh.name = `static_box_merged_${mat}`;
    mergedMesh.castShadow = castShadowByMat.get(mat) ?? mat !== 'ground';
    mergedMesh.receiveShadow = receiveShadowByMat.get(mat) ?? true;
    mergedMesh.matrixAutoUpdate = false;
    mergedMesh.updateMatrix();
    mergedMesh.userData.materialKind = mat;
    mergedMesh.userData.boxCount = boxCount;
    meshes.push(mergedMesh);
  }

  return meshes;
}

/**
 * Computes the world-space center `(cx, cy, cz)` and bounding sphere radius of a `BuildingPrefabPlacement`,
 * accounting for both `rotationY` and all placed building modules.
 */
export function computeBuildingWorldBounds(
  building: BuildingPrefabPlacement,
): { cx: number; cy: number; cz: number; radius: number } {
  const cos = Math.cos(building.rotationY || 0);
  const sin = Math.sin(building.rotationY || 0);
  const halfW = building.gridWidthM * 0.5;
  const halfD = building.gridDepthM * 0.5;

  let cx = building.origin.x + halfW * cos + halfD * sin;
  let cy = building.floorY + 2.2;
  let cz = building.origin.z - halfW * sin + halfD * cos;

  if (building.modules.length > 0) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = building.floorY;
    let maxY = building.floorY + 4.2;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < building.modules.length; i++) {
      const p = building.modules[i].position;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y + 3.0 > maxY) maxY = p.y + 3.0;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }

    if (Number.isFinite(minX) && Number.isFinite(maxX)) {
      cx = (minX + maxX) * 0.5;
      cy = (minY + maxY) * 0.5;
      cz = (minZ + maxZ) * 0.5;
    }
  }

  let radius = Math.hypot(halfW, halfD, 3.2) + 3.5;
  for (let i = 0; i < building.modules.length; i++) {
    const p = building.modules[i].position;
    const d = Math.hypot(p.x - cx, p.y - cy, p.z - cz) + 3.0;
    if (d > radius) radius = d;
  }

  return { cx, cy, cz, radius };
}

export interface PoiInteriorLightEntry {
  light: THREE.PointLight;
  x: number;
  y: number;
  z: number;
  buildingId: string;
}

export interface PoiScalabilityCullerOptions {
  layout: Stage04APreviewLayout;
  buildingsHandle: ModularBuildingsHandle;
  interiorsHandle: InteriorFurnitureSceneHandles;
  containersHandle: ContainerVisualsSceneHandles;
  interiorLights: Array<{
    light: THREE.PointLight;
    x: number;
    y: number;
    z: number;
    buildingId: string;
  }>;
}

export interface PoiCullerStats {
  totalBuildings: number;
  visibleBuildings: number;
  totalInteriors: number;
  visibleInteriors: number;
  shadowCastingInteriors: number;
  totalContainers: number;
  visibleContainers: number;
  shadowCastingContainers: number;
  totalDoors: number;
  visibleDoors: number;
  totalLights: number;
  activeLights: number;
}

export interface PoiScalabilityCuller {
  /**
   * Zero-allocation per-frame distance, frustum, shadow, and point-light culler
   * for multi-POI buildings, interior furniture, loot containers, doors, and interior lights.
   */
  update: (
    camera: THREE.Camera,
    frustum: THREE.Frustum,
    quality: QualityLevel,
    isTopDownOverview: boolean,
  ) => void;
  /** Returns latest culling counts without allocating new objects when inspecting state. */
  getStats: () => Readonly<PoiCullerStats>;
}

interface IndexedBuildingRecord {
  id: string;
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  distSq: number;
  inFrustum: boolean;
  interiorsVisible: boolean;
  interiorsCastShadow: boolean;
}

interface IndexedFurnitureRecord {
  id: string;
  buildingId: string;
  buildingIndex: number;
  x: number;
  y: number;
  z: number;
  sphereRadius: number;
  cachedGroup: THREE.Group | undefined;
  cachedMeshes: THREE.Mesh[];
  lastCastShadow: boolean | null;
}

interface IndexedContainerRecord {
  id: string;
  locationId: string;
  x: number;
  y: number;
  z: number;
  sphereRadius: number;
  cachedGroup: THREE.Group | undefined;
  cachedMeshes: THREE.Mesh[];
  lastCastShadow: boolean | null;
}

interface IndexedDoorRecord {
  doorId: string;
  buildingId: string;
  buildingIndex: number;
  root: THREE.Object3D;
  pivot: THREE.Object3D;
  x: number;
  y: number;
  z: number;
  sphereRadius: number;
  cachedPivotChild: THREE.Object3D | undefined;
  cachedMeshes: THREE.Mesh[];
  lastCastShadow: boolean | null;
}

interface IndexedLightRecord {
  light: THREE.PointLight;
  x: number;
  y: number;
  z: number;
  buildingId: string;
  buildingIndex: number;
}

function syncObjectMeshes(root: THREE.Object3D, outMeshes: THREE.Mesh[]): void {
  outMeshes.length = 0;
  const stack: THREE.Object3D[] = [root];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    if (curr instanceof THREE.Mesh) {
      outMeshes.push(curr);
    }
    const children = curr.children;
    for (let i = 0; i < children.length; i++) {
      stack.push(children[i]);
    }
  }
}

function applyCachedMeshesCastShadow(
  rec: { cachedMeshes: THREE.Mesh[]; lastCastShadow: boolean | null },
  wantCastShadow: boolean,
): void {
  if (rec.lastCastShadow === wantCastShadow) return;
  const meshes = rec.cachedMeshes;
  for (let i = 0; i < meshes.length; i++) {
    meshes[i].castShadow = wantCastShadow;
  }
  rec.lastCastShadow = wantCastShadow;
}

/**
 * Creates a zero-allocation scalability culler for `forest_square` (256x256 m) POI structures,
 * indexing all buildings, interior furniture instances, loot containers, doors, and interior `PointLight`s.
 */
export function createPoiScalabilityCuller(
  opts: PoiScalabilityCullerOptions,
): PoiScalabilityCuller {
  const { layout, buildingsHandle, interiorsHandle, containersHandle, interiorLights } = opts;

  const buildingRecords: IndexedBuildingRecord[] = [];
  const buildingIndexById = new Map<string, number>();

  for (let i = 0; i < layout.buildings.length; i++) {
    const b = layout.buildings[i];
    const bounds = computeBuildingWorldBounds(b);
    let radius = bounds.radius;

    // Expand building sphere radius to guarantee enclosing all furniture assigned to this building
    for (let f = 0; f < layout.interiors.length; f++) {
      const furn = layout.interiors[f];
      if (furn.buildingId !== b.id) continue;
      const d = Math.hypot(
        furn.position.x - bounds.cx,
        furn.position.y - bounds.cy,
        furn.position.z - bounds.cz,
      ) + 2.5;
      if (d > radius) radius = d;
    }

    const idx = buildingRecords.length;
    buildingIndexById.set(b.id, idx);
    buildingRecords.push({
      id: b.id,
      cx: bounds.cx,
      cy: bounds.cy,
      cz: bounds.cz,
      radius,
      distSq: 0,
      inFrustum: true,
      interiorsVisible: true,
      interiorsCastShadow: false,
    });
  }

  const furnitureRecords: IndexedFurnitureRecord[] = [];
  const indexedFurnitureIds = new Set<string>();

  for (let i = 0; i < layout.interiors.length; i++) {
    const item = layout.interiors[i];
    const bIdx = buildingIndexById.get(item.buildingId) ?? -1;
    const group = interiorsHandle.instances.get(item.id);
    const cachedMeshes: THREE.Mesh[] = [];
    if (group) {
      syncObjectMeshes(group, cachedMeshes);
    }
    indexedFurnitureIds.add(item.id);
    furnitureRecords.push({
      id: item.id,
      buildingId: item.buildingId,
      buildingIndex: bIdx,
      x: item.position.x,
      y: item.position.y + 0.65,
      z: item.position.z,
      sphereRadius: 2.6,
      cachedGroup: group,
      cachedMeshes,
      lastCastShadow: null,
    });
  }

  for (const [id, group] of interiorsHandle.instances.entries()) {
    if (indexedFurnitureIds.has(id)) continue;
    const buildingId = typeof group.userData?.buildingId === 'string' ? group.userData.buildingId : '';
    const bIdx = buildingIndexById.get(buildingId) ?? -1;
    const cachedMeshes: THREE.Mesh[] = [];
    syncObjectMeshes(group, cachedMeshes);
    furnitureRecords.push({
      id,
      buildingId,
      buildingIndex: bIdx,
      x: group.position.x,
      y: group.position.y + 0.65,
      z: group.position.z,
      sphereRadius: 2.6,
      cachedGroup: group,
      cachedMeshes,
      lastCastShadow: null,
    });
  }

  const containerRecords: IndexedContainerRecord[] = [];
  const indexedContainerIds = new Set<string>();

  for (let i = 0; i < layout.containers.length; i++) {
    const cnt = layout.containers[i];
    const group = containersHandle.instances.get(cnt.id);
    const cachedMeshes: THREE.Mesh[] = [];
    if (group) {
      syncObjectMeshes(group, cachedMeshes);
    }
    indexedContainerIds.add(cnt.id);
    containerRecords.push({
      id: cnt.id,
      locationId: cnt.locationId,
      x: cnt.position.x,
      y: cnt.position.y + 0.55,
      z: cnt.position.z,
      sphereRadius: 2.4,
      cachedGroup: group,
      cachedMeshes,
      lastCastShadow: null,
    });
  }

  for (const [id, group] of containersHandle.instances.entries()) {
    if (indexedContainerIds.has(id)) continue;
    const locationId = typeof group.userData?.locationId === 'string' ? group.userData.locationId : '';
    const cachedMeshes: THREE.Mesh[] = [];
    syncObjectMeshes(group, cachedMeshes);
    containerRecords.push({
      id,
      locationId,
      x: group.position.x,
      y: group.position.y + 0.55,
      z: group.position.z,
      sphereRadius: 2.4,
      cachedGroup: group,
      cachedMeshes,
      lastCastShadow: null,
    });
  }

  const doorRecords: IndexedDoorRecord[] = [];
  for (const ctrl of buildingsHandle.doorControllers.values()) {
    const doorRoot = ctrl.pivot.parent ?? ctrl.pivot;
    const bIdx = buildingIndexById.get(ctrl.buildingId) ?? -1;
    const cachedMeshes: THREE.Mesh[] = [];
    syncObjectMeshes(doorRoot, cachedMeshes);
    doorRecords.push({
      doorId: ctrl.doorId,
      buildingId: ctrl.buildingId,
      buildingIndex: bIdx,
      root: doorRoot,
      pivot: ctrl.pivot,
      x: doorRoot.position.x,
      y: doorRoot.position.y + 1.2,
      z: doorRoot.position.z,
      sphereRadius: 2.6,
      cachedPivotChild: ctrl.pivot.children[0],
      cachedMeshes,
      lastCastShadow: null,
    });
  }

  const lightRecords: IndexedLightRecord[] = [];
  for (let i = 0; i < interiorLights.length; i++) {
    const entry = interiorLights[i];
    const bIdx = buildingIndexById.get(entry.buildingId) ?? -1;
    lightRecords.push({
      light: entry.light,
      x: entry.x,
      y: entry.y,
      z: entry.z,
      buildingId: entry.buildingId,
      buildingIndex: bIdx,
    });
  }

  const scratchSphere = new THREE.Sphere();
  const stats: PoiCullerStats = {
    totalBuildings: buildingRecords.length,
    visibleBuildings: buildingRecords.length,
    totalInteriors: furnitureRecords.length,
    visibleInteriors: furnitureRecords.length,
    shadowCastingInteriors: 0,
    totalContainers: containerRecords.length,
    visibleContainers: containerRecords.length,
    shadowCastingContainers: 0,
    totalDoors: doorRecords.length,
    visibleDoors: doorRecords.length,
    totalLights: lightRecords.length,
    activeLights: 0,
  };

  const update = (
    camera: THREE.Camera,
    frustum: THREE.Frustum,
    quality: QualityLevel,
    isTopDownOverview: boolean,
  ): void => {
    if (isTopDownOverview) {
      buildingsHandle.group.visible = true;
      interiorsHandle.group.visible = true;
      containersHandle.group.visible = true;

      for (let i = 0; i < buildingRecords.length; i++) {
        const b = buildingRecords[i];
        b.inFrustum = true;
        b.interiorsVisible = true;
        b.interiorsCastShadow = false;
      }

      let visInteriors = 0;
      for (let i = 0; i < furnitureRecords.length; i++) {
        const rec = furnitureRecords[i];
        const group = interiorsHandle.instances.get(rec.id);
        if (!group) continue;
        if (group !== rec.cachedGroup) {
          rec.cachedGroup = group;
          syncObjectMeshes(group, rec.cachedMeshes);
          rec.lastCastShadow = null;
        }
        group.visible = true;
        applyCachedMeshesCastShadow(rec, false);
        visInteriors++;
      }

      let visContainers = 0;
      for (let i = 0; i < containerRecords.length; i++) {
        const rec = containerRecords[i];
        const group = containersHandle.instances.get(rec.id);
        if (!group) continue;
        if (group !== rec.cachedGroup) {
          rec.cachedGroup = group;
          syncObjectMeshes(group, rec.cachedMeshes);
          rec.lastCastShadow = null;
        }
        group.visible = true;
        applyCachedMeshesCastShadow(rec, false);
        visContainers++;
      }

      for (let i = 0; i < doorRecords.length; i++) {
        const rec = doorRecords[i];
        const firstChild = rec.pivot.children[0];
        if (firstChild !== rec.cachedPivotChild) {
          rec.cachedPivotChild = firstChild;
          syncObjectMeshes(rec.root, rec.cachedMeshes);
          rec.lastCastShadow = null;
        }
        rec.root.visible = true;
        applyCachedMeshesCastShadow(rec, false);
      }

      for (let i = 0; i < lightRecords.length; i++) {
        lightRecords[i].light.visible = false;
      }

      stats.visibleBuildings = buildingRecords.length;
      stats.visibleInteriors = visInteriors;
      stats.shadowCastingInteriors = 0;
      stats.visibleContainers = visContainers;
      stats.shadowCastingContainers = 0;
      stats.visibleDoors = doorRecords.length;
      stats.activeLights = 0;
      return;
    }

    const camPos = camera.position;
    const camX = camPos.x;
    const camY = camPos.y;
    const camZ = camPos.z;

    const interiorMaxDist = quality === 'low' ? 42 : quality === 'medium' ? 62 : 88;
    const interiorMaxDistSq = interiorMaxDist * interiorMaxDist;
    const interiorShadowDistSq = 24 * 24;

    const containerMaxDist = quality === 'low' ? 65 : quality === 'medium' ? 95 : 135;
    const containerMaxDistSq = containerMaxDist * containerMaxDist;
    const containerShadowDistSq = 32 * 32;

    const doorMaxDist = quality === 'low' ? 95 : quality === 'medium' ? 135 : 185;
    const doorMaxDistSq = doorMaxDist * doorMaxDist;
    const doorShadowDistSq = 36 * 36;

    const lightMaxDistSq = 34 * 34;

    // 1. Evaluate per-building distance & bounding-sphere frustum state
    let visBuildings = 0;
    for (let i = 0; i < buildingRecords.length; i++) {
      const b = buildingRecords[i];
      const dx = b.cx - camX;
      const dy = b.cy - camY;
      const dz = b.cz - camZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      b.distSq = distSq;

      scratchSphere.center.set(b.cx, b.cy, b.cz);
      scratchSphere.radius = b.radius;
      const inFrustum = frustum.intersectsSphere(scratchSphere);
      b.inFrustum = inFrustum;
      if (inFrustum) visBuildings++;

      const interiorsVisible = distSq <= interiorMaxDistSq && inFrustum;
      b.interiorsVisible = interiorsVisible;
      b.interiorsCastShadow =
        interiorsVisible && quality === 'high' && distSq <= interiorShadowDistSq;
    }

    // 2. Interior furniture culling & shadow gating
    let visInteriors = 0;
    let shadowInteriors = 0;
    for (let i = 0; i < furnitureRecords.length; i++) {
      const rec = furnitureRecords[i];
      const group = interiorsHandle.instances.get(rec.id);
      if (!group) continue;
      if (group !== rec.cachedGroup) {
        rec.cachedGroup = group;
        syncObjectMeshes(group, rec.cachedMeshes);
        rec.lastCastShadow = null;
      }

      let visible = false;
      let wantShadow = false;
      if (rec.buildingIndex >= 0) {
        const b = buildingRecords[rec.buildingIndex];
        visible = b.interiorsVisible;
        if (visible && quality === 'high') {
          const fdx = rec.x - camX;
          const fdy = rec.y - camY;
          const fdz = rec.z - camZ;
          const fDistSq = fdx * fdx + fdy * fdy + fdz * fdz;
          wantShadow = b.interiorsCastShadow || fDistSq <= interiorShadowDistSq;
        }
      } else {
        const dx = rec.x - camX;
        const dy = rec.y - camY;
        const dz = rec.z - camZ;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq <= interiorMaxDistSq) {
          scratchSphere.center.set(rec.x, rec.y, rec.z);
          scratchSphere.radius = rec.sphereRadius;
          visible = frustum.intersectsSphere(scratchSphere);
        }
        wantShadow = visible && quality === 'high' && distSq <= interiorShadowDistSq;
      }

      group.visible = visible;
      applyCachedMeshesCastShadow(rec, wantShadow);
      if (visible) visInteriors++;
      if (wantShadow) shadowInteriors++;
    }

    // 3. Container visual instances culling & shadow gating
    let visContainers = 0;
    let shadowContainers = 0;
    for (let i = 0; i < containerRecords.length; i++) {
      const rec = containerRecords[i];
      const group = containersHandle.instances.get(rec.id);
      if (!group) continue;
      if (group !== rec.cachedGroup) {
        rec.cachedGroup = group;
        syncObjectMeshes(group, rec.cachedMeshes);
        rec.lastCastShadow = null;
      }

      const dx = rec.x - camX;
      const dy = rec.y - camY;
      const dz = rec.z - camZ;
      const distSq = dx * dx + dy * dy + dz * dz;

      let visible = false;
      if (distSq <= containerMaxDistSq) {
        scratchSphere.center.set(rec.x, rec.y, rec.z);
        scratchSphere.radius = rec.sphereRadius;
        visible = frustum.intersectsSphere(scratchSphere);
      }

      const wantShadow = visible && distSq <= containerShadowDistSq;
      group.visible = visible;
      applyCachedMeshesCastShadow(rec, wantShadow);
      if (visible) visContainers++;
      if (wantShadow) shadowContainers++;
    }

    // 4. Building door hierarchy culling & shadow gating
    let visDoors = 0;
    for (let i = 0; i < doorRecords.length; i++) {
      const rec = doorRecords[i];
      const firstChild = rec.pivot.children[0];
      if (firstChild !== rec.cachedPivotChild) {
        rec.cachedPivotChild = firstChild;
        syncObjectMeshes(rec.root, rec.cachedMeshes);
        rec.lastCastShadow = null;
      }

      const dx = rec.x - camX;
      const dy = rec.y - camY;
      const dz = rec.z - camZ;
      const distSq = dx * dx + dy * dy + dz * dz;

      let visible = false;
      if (distSq <= doorMaxDistSq) {
        if (rec.buildingIndex >= 0 && buildingRecords[rec.buildingIndex].inFrustum) {
          visible = true;
        } else {
          scratchSphere.center.set(rec.x, rec.y, rec.z);
          scratchSphere.radius = rec.sphereRadius;
          visible = frustum.intersectsSphere(scratchSphere) || distSq <= 144;
        }
      }

      const wantShadow = visible && quality !== 'low' && distSq <= doorShadowDistSq;
      rec.root.visible = visible;
      applyCachedMeshesCastShadow(rec, wantShadow);
      if (visible) visDoors++;
    }

    // 5. Interior PointLight culling (active only when quality !== 'low' and within 34m)
    let activeLights = 0;
    for (let i = 0; i < lightRecords.length; i++) {
      const rec = lightRecords[i];
      if (quality === 'low') {
        rec.light.visible = false;
        continue;
      }
      const ldx = rec.x - camX;
      const ldy = rec.y - camY;
      const ldz = rec.z - camZ;
      const lightDistSq = ldx * ldx + ldy * ldy + ldz * ldz;
      const bDistSq =
        rec.buildingIndex >= 0 ? buildingRecords[rec.buildingIndex].distSq : lightDistSq;
      const isNear = Math.min(lightDistSq, bDistSq) <= lightMaxDistSq;
      rec.light.visible = isNear;
      if (isNear) activeLights++;
    }

    stats.visibleBuildings = visBuildings;
    stats.visibleInteriors = visInteriors;
    stats.shadowCastingInteriors = shadowInteriors;
    stats.visibleContainers = visContainers;
    stats.shadowCastingContainers = shadowContainers;
    stats.visibleDoors = visDoors;
    stats.activeLights = activeLights;
  };

  return {
    update,
    getStats: () => stats,
  };
}

export interface PlayerFollowingSunShadowState {
  quantizedX: number;
  quantizedZ: number;
  halfExtent: number;
  isTopDownOverview: boolean;
  updateCount: number;
}

export interface PlayerFollowingSunShadow {
  /**
   * Updates the directional sun light and its target to follow the active camera/player XZ
   * quantized in 4-meter steps (`Math.round(x / 4) * 4`) to eliminate shadow swimming,
   * or expands the orthographic shadow frustum to `±135m` in top-down overview mode (`camPos.y > 32`).
   */
  update: (
    cameraOrPos: THREE.Camera | { x: number; y?: number; z: number },
    focusPosOrOverview?: { x: number; y?: number; z: number } | boolean,
    isTopDownOverview?: boolean,
  ) => void;
  /** Returns current quantized shadow state without allocating memory. */
  getState: () => Readonly<PlayerFollowingSunShadowState>;
}

function normalizeZero(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

/**
 * Creates a player/camera-following directional sun shadow controller for `256x256` worlds.
 * - Quantizes target XZ coordinates in **4-meter steps** (`Math.round(x / 4) * 4`) so small camera movements
 *   do not recompute the shadow matrix or cause shadow swimming.
 * - Expands the shadow camera frustum to `±135m` centered at `(0, 0, 0)` when `isTopDownOverview` (`camPos.y > 32`) is active.
 */
export function createPlayerFollowingSunShadow(
  sun: THREE.DirectionalLight,
  world: WorldDefinition,
): PlayerFollowingSunShadow {
  const offsetX = (sun.position.x - sun.target.position.x) || 52;
  const offsetY = (sun.position.y - sun.target.position.y) || 54;
  const offsetZ = (sun.position.z - sun.target.position.z) || 36;

  const sc = sun.shadow.camera;
  const baseHalfExtent = Math.max(54, Math.abs(sc.right) || 54);
  const overviewHalfExtent = 135;
  const baseNear = sc.near || 8;
  const baseFar = Math.max(165, sc.far || 165);
  const overviewFar = 280;

  const minX = world.bounds.minX;
  const maxX = world.bounds.maxX;
  const minZ = world.bounds.minZ;
  const maxZ = world.bounds.maxZ;

  let lastQuantX = Number.NaN;
  let lastQuantZ = Number.NaN;
  let lastOverview: boolean | null = null;

  const state: PlayerFollowingSunShadowState = {
    quantizedX: 0,
    quantizedZ: 0,
    halfExtent: baseHalfExtent,
    isTopDownOverview: false,
    updateCount: 0,
  };

  const update = (
    cameraOrPos: THREE.Camera | { x: number; y?: number; z: number },
    focusPosOrOverview?: { x: number; y?: number; z: number } | boolean,
    explicitOverview?: boolean,
  ): void => {
    let rawX = 0;
    let rawZ = 0;
    let camY = 0;

    if ('position' in cameraOrPos && cameraOrPos.position) {
      const camPos = cameraOrPos.position;
      camY = camPos.y;
      if (focusPosOrOverview && typeof focusPosOrOverview === 'object') {
        rawX = focusPosOrOverview.x;
        rawZ = focusPosOrOverview.z;
      } else {
        rawX = camPos.x;
        rawZ = camPos.z;
      }
    } else {
      const pos = cameraOrPos as { x: number; y?: number; z: number };
      rawX = pos.x;
      rawZ = pos.z;
      camY = pos.y ?? 0;
    }

    const isTopDownOverview =
      typeof explicitOverview === 'boolean'
        ? explicitOverview
        : typeof focusPosOrOverview === 'boolean'
          ? focusPosOrOverview
          : camY > 32;

    if (isTopDownOverview) {
      if (lastOverview !== true || lastQuantX !== 0 || lastQuantZ !== 0) {
        lastOverview = true;
        lastQuantX = 0;
        lastQuantZ = 0;

        sun.target.position.set(0, 0, 0);
        sun.position.set(offsetX, offsetY, offsetZ);
        sun.target.updateMatrixWorld();
        sun.updateMatrixWorld();

        sc.left = -overviewHalfExtent;
        sc.right = overviewHalfExtent;
        sc.top = overviewHalfExtent;
        sc.bottom = -overviewHalfExtent;
        sc.near = baseNear;
        sc.far = overviewFar;
        sc.updateProjectionMatrix();

        state.quantizedX = 0;
        state.quantizedZ = 0;
        state.halfExtent = overviewHalfExtent;
        state.isTopDownOverview = true;
        state.updateCount++;
      }
      return;
    }

    if (lastOverview !== false) {
      lastOverview = false;
      sc.left = -baseHalfExtent;
      sc.right = baseHalfExtent;
      sc.top = baseHalfExtent;
      sc.bottom = -baseHalfExtent;
      sc.near = baseNear;
      sc.far = baseFar;
      sc.updateProjectionMatrix();
      state.halfExtent = baseHalfExtent;
      state.isTopDownOverview = false;
    }

    const clampedX = THREE.MathUtils.clamp(rawX, minX, maxX);
    const clampedZ = THREE.MathUtils.clamp(rawZ, minZ, maxZ);
    const qx = normalizeZero(Math.round(clampedX / 4) * 4);
    const qz = normalizeZero(Math.round(clampedZ / 4) * 4);

    if (qx !== lastQuantX || qz !== lastQuantZ) {
      lastQuantX = qx;
      lastQuantZ = qz;

      sun.target.position.set(qx, 0, qz);
      sun.position.set(qx + offsetX, offsetY, qz + offsetZ);
      sun.target.updateMatrixWorld();
      sun.updateMatrixWorld();

      state.quantizedX = qx;
      state.quantizedZ = qz;
      state.updateCount++;
    }
  };

  return {
    update,
    getState: () => state,
  };
}
