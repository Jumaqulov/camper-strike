import * as THREE from 'three';
import type { Stage04AMaterialName } from '../../shared/structures/contracts';

const materialCache = new Map<Stage04AMaterialName, THREE.MeshStandardMaterial>();

const MATERIAL_SPECS: Record<
  Stage04AMaterialName,
  { roughness: number; metalness: number }
> = {
  wood: { roughness: 0.88, metalness: 0.0 },
  roof: { roughness: 0.92, metalness: 0.0 },
  iron: { roughness: 0.6, metalness: 0.45 },
  fabric: { roughness: 0.97, metalness: 0.0 },
  painted_metal: { roughness: 0.72, metalness: 0.25 },
};

/**
 * Returns a globally cached, deduplicated `THREE.MeshStandardMaterial` for Stage 04A
 * building, interior, and loot container GLBs (`wood`, `roof`, `iron`, `fabric`, `painted_metal`).
 * Marked with `userData.sharedAsset = true` so room dispose() never destroys shared materials.
 */
export function getStage04ASharedMaterial(name: Stage04AMaterialName): THREE.MeshStandardMaterial {
  let mat = materialCache.get(name);
  if (!mat) {
    const spec = MATERIAL_SPECS[name] ?? MATERIAL_SPECS.wood;
    mat = new THREE.MeshStandardMaterial({
      name: `stage04a_${name}`,
      vertexColors: true,
      roughness: spec.roughness,
      metalness: spec.metalness,
    });
    mat.userData.sharedAsset = true;
    mat.userData.stage04aMaterialName = name;
    materialCache.set(name, mat);
  }
  return mat;
}

export function resolveStage04AMaterialName(rawName: string | undefined): Stage04AMaterialName {
  const n = (rawName ?? '').trim().toLowerCase();
  if (n.includes('roof') || n.includes('shingle')) return 'roof';
  if (n.includes('painted_metal') || n.includes('locker') || n.includes('toolbox')) return 'painted_metal';
  if (n.includes('iron') || n.includes('metal') || n.includes('hardware')) return 'iron';
  if (n.includes('fabric') || n.includes('mattress') || n.includes('sofa')) return 'fabric';
  return 'wood';
}

/**
 * Replaces per-GLB duplicate materials on a loaded glTF hierarchy with the 5 shared
 * singleton materials, disposes the loader's temporary material instances, and marks
 * all template geometries with `userData.sharedAsset = true`.
 */
export function deduplicateStage04AGltfMaterials(root: THREE.Object3D): Set<Stage04AMaterialName> {
  const used = new Set<Stage04AMaterialName>();
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.geometry) {
      if (!obj.geometry.getAttribute('normal')) {
        obj.geometry.computeVertexNormals();
      }
      obj.geometry.computeBoundingBox();
      obj.geometry.computeBoundingSphere();
      obj.geometry.userData.sharedAsset = true;
    }
    const oldMats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const resolvedNames = oldMats.map((m) => resolveStage04AMaterialName(m?.name));
    for (const m of oldMats) {
      if (m && !m.userData?.sharedAsset) {
        m.dispose();
      }
    }
    for (const rn of resolvedNames) used.add(rn);
    if (Array.isArray(obj.material)) {
      obj.material = resolvedNames.map((rn) => getStage04ASharedMaterial(rn));
    } else {
      obj.material = getStage04ASharedMaterial(resolvedNames[0] ?? 'wood');
    }
    obj.castShadow = true;
    obj.receiveShadow = true;
  });
  return used;
}

export function getStage04ASharedMaterialCount(): number {
  return materialCache.size;
}
