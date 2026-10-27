import * as THREE from 'three';

/**
 * Umumiy geometriya yordamchilari (World, ForestRenderer va forest_square sahna yordamchilari
 * uchun yagona nusxa).
 */

/**
 * `BoxGeometry` UV larini yuza o'lchamlari va tekstura dunyo masshtabiga ko'ra cho'zadi
 * (`scale` metr/tile; `null` bo'lsa UV o'zgarmaydi).
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
  // yuzalar tartibi: +x, -x, +y, -y, +z, -z (har biri 4 ta uch)
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
 * Bitta materialga tegishli indekslangan statik geometriyalarni birlashtiradi
 * (`position`, `normal`, `uv` saqlanadi). Kirish geometriyalari dispose qilinadi (xotira oqmasin).
 * Natija `userData.sharedAsset = false` — sahna dispose qilinganda bemalol o'chiriladi.
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
