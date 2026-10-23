import * as THREE from 'three';

/**
 * Builds an annular (hollow) outer skirt geometry around the playable area.
 * The inner rectangular region [-innerHalf, innerHalf] x [-innerHalf, innerHalf]
 * is 100% open (zero triangles), ensuring the heightfield terrain mesh is NEVER
 * occluded by the outer skirt plane, even in deep depressions, hollows, or glades (y < 0).
 *
 * Consists of 4 disjoint rectangular strips: North, South, West, and East.
 * Total: 16 vertices, 8 triangles (24 indices).
 *
 * @param innerHalf Half-width of the inner hole (e.g. 128 for 256x256 forest_square).
 * @param outerHalf Half-width of the outer perimeter (e.g. 600 for 1200x1200 horizon).
 * @param y Height of the skirt plane (defaults to 0.0, matching the heightfield boundary).
 */
export function buildAnnularSkirtGeometry(
  innerHalf: number,
  outerHalf: number,
  y = 0.0,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();

  const x0 = -outerHalf;
  const x1 = -innerHalf;
  const x2 =  innerHalf;
  const x3 =  outerHalf;

  const z0 = -outerHalf;
  const z1 = -innerHalf;
  const z2 =  innerHalf;
  const z3 =  outerHalf;

  // 4 disjoint strips forming the complete annulus:
  // 1. North strip: [x0, x3] x [z0, z1]
  // 2. South strip: [x0, x3] x [z2, z3]
  // 3. West strip:  [x0, x1] x [z1, z2]
  // 4. East strip:  [x2, x3] x [z1, z2]
  const strips = [
    { minX: x0, maxX: x3, minZ: z0, maxZ: z1 },
    { minX: x0, maxX: x3, minZ: z2, maxZ: z3 },
    { minX: x0, maxX: x1, minZ: z1, maxZ: z2 },
    { minX: x2, maxX: x3, minZ: z1, maxZ: z2 },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const spanX = x3 - x0;
  const spanZ = z3 - z0;

  for (let s = 0; s < strips.length; s++) {
    const { minX, maxX, minZ, maxZ } = strips[s]!;
    const baseIdx = s * 4;

    // 4 vertices per rectangular strip in XZ plane:
    // v0: (minX, minZ), v1: (maxX, minZ), v2: (maxX, maxZ), v3: (minX, maxZ)
    positions.push(
      minX, y, minZ,
      maxX, y, minZ,
      maxX, y, maxZ,
      minX, y, maxZ,
    );

    normals.push(
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
    );

    uvs.push(
      (minX - x0) / spanX, (minZ - z0) / spanZ,
      (maxX - x0) / spanX, (minZ - z0) / spanZ,
      (maxX - x0) / spanX, (maxZ - z0) / spanZ,
      (minX - x0) / spanX, (maxZ - z0) / spanZ,
    );

    // Two triangles per strip (counter-clockwise looking down from +Y):
    // Triangle A: (v0, v3, v1)
    // Triangle B: (v1, v3, v2)
    indices.push(
      baseIdx + 0, baseIdx + 3, baseIdx + 1,
      baseIdx + 1, baseIdx + 3, baseIdx + 2,
    );
  }

  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));

  return geo;
}
