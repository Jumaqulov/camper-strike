import * as THREE from 'three';
import type { MaterialKind } from '../../shared/map';
import { raycastWorld } from '../../shared/physics';
import {
  buildForestSquarePOILayout,
  buildStage04APreviewLayout,
  type Stage04APreviewLayout,
} from '../../shared/structures';
import {
  buildTerrainMeshData,
  DEFAULT_MAX_WALKABLE_SLOPE_DEG,
  sampleForestSquareTerrainColor,
  sampleForestTerrainColor,
  sampleTerrainHeight,
  sampleTerrainNormal,
  TREE_SPECIES_BATCH_KEYS,
  type TreeSpeciesBatchKey,
  type VisualDescriptor,
  type WorldDefinition,
} from '../../shared/world';
import type { QualityLevel } from '../settings';
import {
  buildModularBuildingsScene,
  onBuildingAssetsReady,
  preloadBuildingAssets,
  type ModularBuildingsHandle,
} from './buildings';
import {
  buildContainerVisualsScene,
  onContainerAssetsReady,
  preloadContainerAssets,
  type ContainerVisualsSceneHandles,
} from './containers';
import {
  getCachedForestAssetByBatchKey,
  getSharedForestMaterials,
  onForestAssetsReady,
  preloadForestAssets,
} from './ForestAssetRegistry';
import {
  buildMergedStaticBoxMeshes,
  computeBuildingWorldBounds,
  createPlayerFollowingSunShadow,
  createPoiScalabilityCuller,
  type PlayerFollowingSunShadow,
  type PoiInteriorLightEntry,
  type PoiScalabilityCuller,
} from './ForestSquareRenderer';
import {
  buildInteriorFurnitureScene,
  onInteriorAssetsReady,
  preloadInteriorAssets,
  type InteriorFurnitureSceneHandles,
} from './interiors';
import {
  buildOutdoorScene,
  onOutdoorAssetsReady,
  preloadOutdoorAssets,
  type OutdoorSceneHandles,
} from './outdoor';
import { createTextures, TEX_SCALE } from './Textures';
import type { WorldHandles } from './World';
import type { ForestSquareWorldDefinition } from '../../shared/forestSquare';
import { buildForestSquareGroundCover } from '../../shared/groundCover';
import { createGroundCoverRenderer, type GroundCoverRendererHandle } from './GroundCoverRenderer';
import { createEnhancedTerrainMaterial } from './terrain/TerrainMaterial';
import { buildAnnularSkirtGeometry } from './terrain/skirtGeometry';
import { preloadGrassAssets, onGrassAssetsReady } from './grass/GrassAssetRegistry';

export interface Stage04ASceneHandles {
  layout: Stage04APreviewLayout;
  buildings: ModularBuildingsHandle;
  interiors: InteriorFurnitureSceneHandles;
  containers: ContainerVisualsSceneHandles;
  outdoor?: OutdoorSceneHandles;
}

export interface CullingProfileStats {
  calls: number;
  evaluatedFrames: number;
  skippedStaticFrames: number;
  batchBufferUploads: number;
  batchBufferSkips: number;
  lastCpuMs: number;
  avgCpuMs: number;
  p95CpuMs: number;
  maxCpuMs: number;
}

/**
 * Computes a PvP-fair 3P camera spring-arm distance (`dist` in `[0.35, maxDist]`).
 * - Never hides or shrinks any bush or tree foliage in the world (preventing unfair PvP cover reveal).
 * - Pulls the camera forward before solid colliders/terrain (`raycastWorld`) AND before any 3D tree canopy
 *   volume (`y in [canopyMinY, canopyMaxY]`) that directly intersects the segment between the local player's
 *   shoulder pivot and the desired 3P camera position.
 */
export function computeFairThirdPersonCameraDist(
  world: WorldDefinition,
  pivot: { x: number; y: number; z: number },
  backDir: { x: number; y: number; z: number },
  maxDist = 2.35,
): number {
  const solidHit = raycastWorld(world, pivot, backDir, maxDist);
  let dist = solidHit ? Math.max(0.35, solidHit.t - 0.22) : maxDist;

  // Check if the 3D spring-arm ray [0.18 .. dist] enters a nearby tree's 3D canopy volume.
  // Only pulls the camera forward along the spring-arm; never hides or modifies world foliage.
  for (const vis of world.visuals) {
    if (vis.category !== 'tree') continue;
    const tx = vis.transform.position.x;
    const ty = vis.transform.position.y - 0.08;
    const tz = vis.transform.position.z;
    const sx = vis.transform.scale.x;
    const sy = vis.transform.scale.y;

    const dxPivot = tx - pivot.x;
    const dzPivot = tz - pivot.z;
    if (dxPivot * dxPivot + dzPivot * dzPivot > (maxDist + 3.2) * (maxDist + 3.2)) {
      continue;
    }

    const canopyMinY = ty + 2.05 * sy;
    const canopyMaxY = ty + 8.8 * sy;
    const baseRadius = 1.65 * sx;

    // Sample along the 3D spring-arm ray from player shoulder toward camera
    const steps = 6;
    for (let s = 1; s <= steps; s++) {
      const t = (s / steps) * dist;
      const ry = pivot.y + backDir.y * t;
      if (ry < canopyMinY || ry > canopyMaxY) continue;

      const rx = pivot.x + backDir.x * t;
      const rz = pivot.z + backDir.z * t;
      const hFrac = (ry - canopyMinY) / Math.max(0.1, canopyMaxY - canopyMinY);
      const radiusAtY = baseRadius * (1.0 - 0.55 * hFrac);
      const dXZ = Math.hypot(rx - tx, rz - tz);
      if (dXZ < radiusAtY) {
        dist = Math.min(dist, Math.max(0.42, t - 0.16));
        break;
      }
    }
  }

  return dist;
}

/**
 * Merges multiple BufferGeometries (converting each to non-indexed with position, normal, color)
 * into a single prototype BufferGeometry for fast InstancedMesh rendering.
 */
function mergePartGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonIndexed = parts.map((g) => {
    const ni = g.index ? g.toNonIndexed() : g.clone();
    if (!ni.getAttribute('normal')) ni.computeVertexNormals();
    return ni;
  });

  let totalVerts = 0;
  for (const g of nonIndexed) {
    totalVerts += g.getAttribute('position').count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);

  let offset = 0;
  for (const g of nonIndexed) {
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    const col = g.getAttribute('color');
    const count = pos.count;

    for (let i = 0; i < count; i++) {
      const dst = (offset + i) * 3;
      positions[dst] = pos.getX(i);
      positions[dst + 1] = pos.getY(i);
      positions[dst + 2] = pos.getZ(i);

      normals[dst] = norm ? norm.getX(i) : 0;
      normals[dst + 1] = norm ? norm.getY(i) : 1;
      normals[dst + 2] = norm ? norm.getZ(i) : 0;

      colors[dst] = col ? col.getX(i) : 1;
      colors[dst + 1] = col ? col.getY(i) : 1;
      colors[dst + 2] = col ? col.getZ(i) : 1;
    }
    offset += count;
    g.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/**
 * Merges indexed static geometries that share a material (preserving position, normal, uv).
 */
function mergeStaticGeometriesWithUV(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geometries.length === 1) {
    geometries[0].computeBoundingSphere();
    geometries[0].computeBoundingBox();
    return geometries[0];
  }
  let totalVerts = 0;
  let totalIndices = 0;
  let hasUv = true;

  for (const g of geometries) {
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

  for (const g of geometries) {
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
  return merged;
}

/**
 * Applies a vertical + radial vertex color gradient to a geometry in local space,
 * then transforms it into its final local offset/rotation/scale.
 */
function colorAndTransformPart(
  geo: THREE.BufferGeometry,
  bottomColor: THREE.Color,
  topColor: THREE.Color,
  opts: {
    pos?: [number, number, number];
    rot?: [number, number, number];
    scale?: [number, number, number];
    radialJitter?: number;
    seed?: number;
  } = {},
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const pos = g.getAttribute('position');
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const minY = bb.min.y;
  const spanY = Math.max(0.001, bb.max.y - bb.min.y);

  const jitter = opts.radialJitter ?? 0;
  const seed = opts.seed ?? 1;
  if (jitter > 0) {
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      const h = Math.sin(vx * 7.3 + vy * 4.1 + vz * 6.7 + seed) * jitter;
      pos.setXYZ(i, vx * (1 + h), vy + h * 0.18, vz * (1 + h));
    }
    g.computeVertexNormals();
  }

  const colors = new Float32Array(pos.count * 3);
  const tmpCol = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const vy = pos.getY(i);
    const t = THREE.MathUtils.clamp((vy - minY) / spanY, 0, 1);
    tmpCol.copy(bottomColor).lerp(topColor, t);
    colors[i * 3] = tmpCol.r;
    colors[i * 3 + 1] = tmpCol.g;
    colors[i * 3 + 2] = tmpCol.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat4 = new THREE.Matrix4();
  const p = new THREE.Vector3(...(opts.pos ?? [0, 0, 0]));
  const e = new THREE.Euler(...(opts.rot ?? [0, 0, 0]));
  const q = new THREE.Quaternion().setFromEuler(e);
  const s = new THREE.Vector3(...(opts.scale ?? [1, 1, 1]));
  mat4.compose(p, q, s);
  g.applyMatrix4(mat4);
  return g;
}

interface TreePrototypePair {
  trunkGeo: THREE.BufferGeometry;
  foliageGeo: THREE.BufferGeometry | null;
}

/**
 * Procedural fallback tree prototypes (used only if GLB files have not finished loading or fail).
 */
function buildFallbackTreePrototypes(): Record<TreeSpeciesBatchKey, TreePrototypePair> {
  const barkDark = new THREE.Color('#4a311e');
  const barkMid = new THREE.Color('#6b462a');
  const barkWarm = new THREE.Color('#825736');

  const pineDeep = new THREE.Color('#2b5927');
  const pineMid = new THREE.Color('#3f7331');
  const pineSun = new THREE.Color('#5e913e');

  const spruceDeep = new THREE.Color('#265432');
  const spruceTip = new THREE.Color('#568c47');

  const tallTrunkParts: THREE.BufferGeometry[] = [
    colorAndTransformPart(new THREE.CylinderGeometry(0.24, 0.36, 3.6, 7), barkDark, barkMid, {
      pos: [0, 1.7, 0],
    }),
    colorAndTransformPart(new THREE.CylinderGeometry(0.16, 0.24, 5.2, 6), barkMid, barkWarm, {
      pos: [0, 6.0, 0],
    }),
  ];
  const tallFoliageParts: THREE.BufferGeometry[] = [
    colorAndTransformPart(new THREE.ConeGeometry(1.6, 2.3, 7), pineDeep, pineMid, { pos: [0, 5.9, 0] }),
    colorAndTransformPart(new THREE.ConeGeometry(1.35, 2.2, 7), pineMid, pineSun, { pos: [0, 7.6, 0] }),
    colorAndTransformPart(new THREE.ConeGeometry(0.95, 2.0, 6), pineMid, pineSun, { pos: [0, 9.2, 0] }),
  ];

  const spruceTrunkParts: THREE.BufferGeometry[] = [
    colorAndTransformPart(new THREE.CylinderGeometry(0.26, 0.42, 3.2, 7), barkDark, barkMid, { pos: [0, 1.5, 0] }),
    colorAndTransformPart(new THREE.CylinderGeometry(0.12, 0.26, 5.2, 6), barkMid, barkWarm, { pos: [0, 5.6, 0] }),
  ];
  const spruceFoliageParts: THREE.BufferGeometry[] = [
    colorAndTransformPart(new THREE.ConeGeometry(2.1, 2.2, 7), spruceDeep, spruceTip, { pos: [0, 3.2, 0] }),
    colorAndTransformPart(new THREE.ConeGeometry(1.75, 2.1, 7), spruceDeep, spruceTip, { pos: [0, 4.9, 0] }),
    colorAndTransformPart(new THREE.ConeGeometry(1.35, 2.0, 7), spruceDeep, spruceTip, { pos: [0, 6.6, 0] }),
    colorAndTransformPart(new THREE.ConeGeometry(0.85, 1.8, 6), spruceDeep, spruceTip, { pos: [0, 8.2, 0] }),
  ];

  const leanTrunkParts: THREE.BufferGeometry[] = [
    colorAndTransformPart(new THREE.CylinderGeometry(0.22, 0.35, 3.0, 7), barkDark, barkMid, { pos: [0.1, 1.4, 0] }),
    colorAndTransformPart(new THREE.CylinderGeometry(0.14, 0.22, 4.8, 6), barkMid, barkWarm, { pos: [0.4, 5.2, 0] }),
  ];
  const leanFoliageParts: THREE.BufferGeometry[] = [
    colorAndTransformPart(new THREE.ConeGeometry(1.55, 2.1, 7), pineDeep, pineMid, { pos: [0.4, 5.2, 0] }),
    colorAndTransformPart(new THREE.ConeGeometry(1.25, 2.0, 7), pineMid, pineSun, { pos: [0.6, 6.9, 0] }),
    colorAndTransformPart(new THREE.ConeGeometry(0.85, 1.8, 6), pineMid, pineSun, { pos: [0.7, 8.4, 0] }),
  ];

  const deadBarkDark = new THREE.Color('#524438');
  const deadBarkTop = new THREE.Color('#85725e');
  const snagOlive = new THREE.Color('#3d5429');
  const snagRust = new THREE.Color('#6e7d3c');
  const ancientTrunkParts: THREE.BufferGeometry[] = [
    colorAndTransformPart(new THREE.CylinderGeometry(0.32, 0.5, 3.2, 7), deadBarkDark, deadBarkTop, { pos: [0, 1.5, 0] }),
    colorAndTransformPart(new THREE.CylinderGeometry(0.18, 0.32, 3.6, 6), deadBarkDark, deadBarkTop, { pos: [0, 4.8, 0] }),
  ];
  const ancientFoliageParts: THREE.BufferGeometry[] = [
    colorAndTransformPart(new THREE.DodecahedronGeometry(1.0, 0), snagOlive, snagRust, {
      pos: [0.6, 6.5, 0.2],
      scale: [1.2, 0.55, 1.0],
    }),
  ];

  const birchBase = new THREE.Color('#453e38');
  const birchWhite = new THREE.Color('#e6dfd0');
  const birchLeafShadow = new THREE.Color('#426b2a');
  const birchLeafSun = new THREE.Color('#87ab42');
  const birchTrunkParts: THREE.BufferGeometry[] = [
    colorAndTransformPart(new THREE.CylinderGeometry(0.18, 0.28, 2.6, 7), birchBase, birchWhite, { pos: [0, 1.2, 0] }),
    colorAndTransformPart(new THREE.CylinderGeometry(0.09, 0.17, 4.6, 6), birchWhite, birchWhite, { pos: [0.1, 4.6, 0] }),
  ];
  const birchFoliageParts: THREE.BufferGeometry[] = [
    colorAndTransformPart(new THREE.IcosahedronGeometry(1.4, 1), birchLeafShadow, birchLeafSun, {
      pos: [0.15, 6.6, 0],
      scale: [1.1, 0.8, 1.05],
    }),
    colorAndTransformPart(new THREE.IcosahedronGeometry(1.1, 1), birchLeafShadow, birchLeafSun, {
      pos: [-0.5, 5.8, -0.2],
      scale: [1.05, 0.75, 1.0],
    }),
  ];

  return {
    'tree:pine_tall': {
      trunkGeo: mergePartGeometries(tallTrunkParts),
      foliageGeo: mergePartGeometries(tallFoliageParts),
    },
    'tree:spruce_broad': {
      trunkGeo: mergePartGeometries(spruceTrunkParts),
      foliageGeo: mergePartGeometries(spruceFoliageParts),
    },
    'tree:pine_leaning': {
      trunkGeo: mergePartGeometries(leanTrunkParts),
      foliageGeo: mergePartGeometries(leanFoliageParts),
    },
    'tree:tree_ancient_dead': {
      trunkGeo: mergePartGeometries(ancientTrunkParts),
      foliageGeo: mergePartGeometries(ancientFoliageParts),
    },
    'tree:birch_deciduous': {
      trunkGeo: mergePartGeometries(birchTrunkParts),
      foliageGeo: mergePartGeometries(birchFoliageParts),
    },
  };
}

/**
 * Builds instanced prototypes for undergrowth & forest floor props, plus fallback rock/bush if GLBs aren't loaded yet.
 */
function buildUndergrowthPrototypes(): Record<string, THREE.BufferGeometry> {
  const rockStone = new THREE.Color('#5c6164');
  const rockMoss = new THREE.Color('#4f7035');
  const boulderParts = [
    colorAndTransformPart(new THREE.DodecahedronGeometry(0.55, 1), rockStone, rockMoss, {
      pos: [0, 0.42, 0],
      scale: [0.95, 0.82, 0.95],
      radialJitter: 0.12,
      seed: 501,
    }),
  ];

  const logBark = new THREE.Color('#4f3420');
  const logMoss = new THREE.Color('#43632b');
  const fallenLogParts = [
    colorAndTransformPart(new THREE.CylinderGeometry(0.22, 0.27, 2.7, 7), logBark, logMoss, {
      pos: [0, 0.2, 0],
      rot: [0, 0, Math.PI / 2 - 0.04],
      radialJitter: 0.05,
      seed: 521,
    }),
  ];

  const stumpBark = new THREE.Color('#4a301d');
  const stumpWood = new THREE.Color('#b89160');
  const stumpParts = [
    colorAndTransformPart(new THREE.CylinderGeometry(0.28, 0.42, 0.62, 7), stumpBark, stumpWood, {
      pos: [0, 0.28, 0],
      radialJitter: 0.06,
      seed: 541,
    }),
  ];

  const bushDark = new THREE.Color('#2c5926');
  const bushTop = new THREE.Color('#63943c');
  const bushParts = [
    colorAndTransformPart(new THREE.DodecahedronGeometry(0.52, 0), bushDark, bushTop, {
      pos: [0, 0.38, 0],
      scale: [1.1, 0.78, 1.05],
      radialJitter: 0.1,
      seed: 601,
    }),
  ];

  const fernBase = new THREE.Color('#264c20');
  const fernTip = new THREE.Color('#5d8a38');
  const fernParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + (i % 2) * 0.15;
    fernParts.push(
      colorAndTransformPart(new THREE.ConeGeometry(0.15, 0.68, 3), fernBase, fernTip, {
        pos: [Math.cos(a) * 0.26, 0.22, Math.sin(a) * 0.26],
        rot: [Math.sin(a) * 0.95, -a, -Math.cos(a) * 0.95],
        scale: [0.85, 1.0, 0.28],
      }),
    );
  }

  const grassRoot = new THREE.Color('#284a1e');
  const grassTip = new THREE.Color('#5a8033');
  const grassParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const tilt = 0.22 + (i % 2) * 0.12;
    grassParts.push(
      colorAndTransformPart(new THREE.ConeGeometry(0.085, 0.46, 3), grassRoot, grassTip, {
        pos: [Math.cos(a) * 0.08, 0.21, Math.sin(a) * 0.08],
        rot: [Math.sin(a) * tilt, a, -Math.cos(a) * tilt],
        scale: [0.65, 1.0, 0.35],
      }),
    );
  }

  const pebbleDark = new THREE.Color('#5c6063');
  const pebbleLight = new THREE.Color('#807d76');
  const pebbleParts = [
    colorAndTransformPart(new THREE.DodecahedronGeometry(0.14, 0), pebbleDark, pebbleLight, {
      pos: [0, 0.06, 0],
      scale: [1.2, 0.65, 1.0],
    }),
  ];

  const leafDark = new THREE.Color('#664423');
  const leafGold = new THREE.Color('#966a33');
  const leafParts = [
    colorAndTransformPart(new THREE.CylinderGeometry(0.44, 0.46, 0.024, 5), leafDark, leafGold, {
      pos: [0, 0.012, 0],
      scale: [1.15, 1, 0.88],
    }),
  ];

  return {
    'rock:boulder_mossy': mergePartGeometries(boulderParts),
    'prop:fallen_log': mergePartGeometries(fallenLogParts),
    'prop:tree_stump': mergePartGeometries(stumpParts),
    'foliage:bush': mergePartGeometries(bushParts),
    'foliage:fern': mergePartGeometries(fernParts),
    'foliage:grass': mergePartGeometries(grassParts),
    'prop:pebble': mergePartGeometries(pebbleParts),
    'foliage:leaf_patch': mergePartGeometries(leafParts),
  };
}

function scaleBoxUVs(geo: THREE.BoxGeometry, w: number, h: number, d: number, scale: number | null) {
  if (!scale) return;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / scale, (uv.getY(i) * dims[f][1]) / scale);
    }
  }
  uv.needsUpdate = true;
}

/**
 * Adds architectural craft details to the 8x6m wooden cabin at (-8, -6),
 * merging static trim/sill geometry by material to minimize draw calls.
 */
function decorateForestCabin(
  group: THREE.Group,
  baseY: number,
  mats: Record<MaterialKind, THREE.MeshStandardMaterial>,
  disposableMats: THREE.Material[],
): THREE.PointLight {
  const cabinGroup = new THREE.Group();
  cabinGroup.name = 'forest_cabin_decor';
  cabinGroup.position.set(-8, baseY, -6);

  const trimMat = new THREE.MeshStandardMaterial({ color: '#4a2f1b', roughness: 0.88 });
  const doorMat = new THREE.MeshStandardMaterial({ color: '#7a4b27', roughness: 0.82 });
  const lanternGlowMat = new THREE.MeshBasicMaterial({ color: '#ffdf8e' });
  const metalMat = new THREE.MeshStandardMaterial({ color: '#2b3033', metalness: 0.6, roughness: 0.45 });
  const clothMat = new THREE.MeshStandardMaterial({ color: '#355e4b', roughness: 0.85 });
  disposableMats.push(trimMat, doorMat, lanternGlowMat, metalMat, clothMat);

  const floorH = 0.26;

  // Swung-open wooden front door leaf on the east porch (x=3.0, z=-0.9 hinged outward)
  const doorPivot = new THREE.Group();
  doorPivot.position.set(3.08, floorH + 1.18, -0.88);
  doorPivot.rotation.y = -1.05;
  const doorLeaf = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.32, 1.55), doorMat);
  doorLeaf.position.set(0, 0, 0.76);
  doorLeaf.castShadow = true;
  doorLeaf.receiveShadow = true;
  doorPivot.add(doorLeaf);
  cabinGroup.add(doorPivot);

  // Merge all trim rails and window sills into a single static mesh
  const trimGeos: THREE.BufferGeometry[] = [];
  for (const sz of [-3.82, 3.82]) {
    const g = new THREE.BoxGeometry(1.5, 0.1, 0.12);
    g.translate(3.85, floorH + 0.92, sz);
    trimGeos.push(g);
  }
  for (const rz of [-2.55, 2.55]) {
    const g = new THREE.BoxGeometry(0.12, 0.1, 2.2);
    g.translate(4.6, floorH + 0.92, rz);
    trimGeos.push(g);
  }
  const windowSills: Array<[number, number, number, number, number, number]> = [
    [3.0, floorH + 1.06, -2.35, 0.36, 0.08, 1.5],
    [3.0, floorH + 1.06, 2.35, 0.36, 0.08, 1.5],
    [-3.0, floorH + 1.06, 0, 0.36, 0.08, 3.1],
    [0.2, floorH + 1.06, -4.0, 2.1, 0.08, 0.36],
  ];
  for (const [wx, wy, wz, sx, sy, sz] of windowSills) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(wx, wy, wz);
    trimGeos.push(g);
  }
  const trimMesh = new THREE.Mesh(mergeStaticGeometriesWithUV(trimGeos), trimMat);
  trimMesh.castShadow = true;
  trimMesh.receiveShadow = true;
  cabinGroup.add(trimMesh);

  // Porch posts flanking stairs
  const postGeos: THREE.BufferGeometry[] = [];
  for (const rz of [-1.4, 1.4]) {
    const g = new THREE.BoxGeometry(0.2, 3.2, 0.2);
    g.translate(4.6, floorH + 1.6, rz);
    postGeos.push(g);
  }
  const postMesh = new THREE.Mesh(mergeStaticGeometriesWithUV(postGeos), mats.crate);
  postMesh.castShadow = true;
  postMesh.receiveShadow = true;
  cabinGroup.add(postMesh);

  // Interior table details
  const radio = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.24, 0.26), metalMat);
  radio.position.set(-2.0, floorH + 0.96, -3.15);
  radio.rotation.y = 0.28;
  cabinGroup.add(radio);

  const lanternBody = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.28, 8), lanternGlowMat);
  lanternBody.position.set(-1.82, floorH + 0.98, -2.55);
  cabinGroup.add(lanternBody);

  const bedroll = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.95, 8), clothMat);
  bedroll.rotation.x = Math.PI / 2;
  bedroll.position.set(-2.2, floorH + 1.98, 2.9);
  cabinGroup.add(bedroll);

  // Warm interior point light illuminating the wooden cabin interior & porch
  const cabinLight = new THREE.PointLight('#ffbe6b', 2.2, 14, 1.4);
  cabinLight.position.set(-0.4, floorH + 2.45, -0.5);
  cabinLight.castShadow = false;
  cabinGroup.add(cabinLight);

  group.add(cabinGroup);
  return cabinLight;
}

interface CompiledInstanceRecord {
  index: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  centerY: number;
  sphereRadius: number;
  chunkKey: string;
  maxDist: number;
  strideHash: number;
  matrix: THREE.Matrix4;
  color: THREE.Color;
}

interface ManagedInstancedBatch {
  batchKey: string;
  mesh: THREE.InstancedMesh;
  records: CompiledInstanceRecord[];
  chunkBuckets: Map<string, CompiledInstanceRecord[]>;
  isTreeFoliage: boolean;
  isBushFoliage: boolean;
  isDensityScalable: boolean;
  baseCastShadow: boolean;
  activeCount: number;
  activeSignature: number;
}

function buildChunkBuckets(records: CompiledInstanceRecord[]): Map<string, CompiledInstanceRecord[]> {
  const map = new Map<string, CompiledInstanceRecord[]>();
  for (const r of records) {
    let list = map.get(r.chunkKey);
    if (!list) {
      list = [];
      map.set(r.chunkKey, list);
    }
    list.push(r);
  }
  return map;
}

/**
 * Builds the Stage 03.5 Stylized 96x96 Forest Preview Scene (`mapId === 'forest_sample'`)
 * with GLB forest models, InstancedMesh batching, chunk frustum culling, distance/LOD culling,
 * and 3P camera foliage obstruction prevention.
 */
export function buildForestSampleScene(
  scene: THREE.Scene,
  world: WorldDefinition,
  initialQuality: QualityLevel = 'medium',
): WorldHandles {
  void preloadForestAssets();
  const isForestSquare = world.mapId === 'forest_square';
  const isModularStructuresMap = world.mapId === 'forest_assets_preview' || isForestSquare;
  if (isModularStructuresMap) {
    void preloadBuildingAssets();
    void preloadInteriorAssets();
    void preloadContainerAssets();
    void preloadOutdoorAssets();
  }
  if (isForestSquare) {
    void preloadGrassAssets();
  }

  const textures = createTextures();
  const mats = {} as Record<MaterialKind, THREE.MeshStandardMaterial>;
  for (const k of Object.keys(textures) as MaterialKind[]) {
    mats[k] = new THREE.MeshStandardMaterial({
      map: textures[k],
      roughness: k === 'metal' ? 0.45 : 0.88,
      metalness: k === 'metal' ? 0.22 : 0,
    });
  }
  const disposableMats: THREE.Material[] = [];

  const group = new THREE.Group();
  group.name = isForestSquare ? 'forest_square_world' : 'forest_sample_world';

  // 1. Heightfield Terrain Mesh with Winding Dirt Road & Mossy Hollow Vertex Blending
  if (world.terrain.kind !== 'heightfield') {
    throw new Error(`${world.mapId} requires a heightfield terrain descriptor`);
  }
  const meshData = buildTerrainMeshData(
    world.terrain,
    DEFAULT_MAX_WALKABLE_SLOPE_DEG,
    isForestSquare
      ? (x, y, z, slopeDeg) =>
          sampleForestSquareTerrainColor(x, y, z, slopeDeg, world.publicLayoutSeed)
      : (x, y, z, slopeDeg) => sampleForestTerrainColor(x, y, z, slopeDeg, world.publicLayoutSeed),
  );
  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
  terrainGeo.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(meshData.colors, 3));
  terrainGeo.setAttribute('uv', new THREE.BufferAttribute(meshData.uvs, 2));
  terrainGeo.setIndex(new THREE.BufferAttribute(meshData.indices, 1));

  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
  });
  if (isForestSquare) {
    createEnhancedTerrainMaterial(terrainMat, world.publicLayoutSeed);
  }
  disposableMats.push(terrainMat);

  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.name = 'forest_heightfield_terrain';
  terrainMesh.receiveShadow = true;
  terrainMesh.castShadow = false;
  group.add(terrainMesh);

  // 2. Structure & Interior Rendering (`forest_assets_preview` / `forest_square` GLBs vs `forest_sample` procedural cabin)
  let stage04aHandles: Stage04ASceneHandles | undefined;
  let poiCuller: PoiScalabilityCuller | null = null;
  const interiorLights: THREE.PointLight[] = [];
  const poiLightEntries: PoiInteriorLightEntry[] = [];

  if (isModularStructuresMap) {
    const layout =
      world.stage04aLayout ??
      (isForestSquare
        ? buildForestSquarePOILayout(world.terrain, world.publicLayoutSeed, world.chunkSize)
        : buildStage04APreviewLayout(world.terrain, world.chunkSize));
    const buildingsHandle = buildModularBuildingsScene(layout.buildings, []);
    const interiorsHandle = buildInteriorFurnitureScene(
      layout.interiors,
      layout.worldAnchors.filter((a) => a.category !== 'inside_container'),
    );
    const containersHandle = buildContainerVisualsScene(
      layout.containers,
      layout.worldAnchors.filter((a) => a.category === 'inside_container'),
    );
    const outdoorHandle = buildOutdoorScene(layout.outdoorPlacements ?? [], initialQuality);

    group.add(buildingsHandle.group);
    group.add(interiorsHandle.group);
    group.add(containersHandle.group);
    group.add(outdoorHandle.group);

    // Render any non-porch static_box POI yard props (lumber stacks, service bay, camp van/tents, stone ruins)
    const mergedPoiBoxMeshes = buildMergedStaticBoxMeshes(world.visuals, mats, TEX_SCALE, {
      excludePorchSteps: true,
    });
    for (const m of mergedPoiBoxMeshes) {
      group.add(m);
    }

    for (const b of layout.buildings) {
      const bBounds = computeBuildingWorldBounds(b);
      const light = new THREE.PointLight('#ffbe6b', 2.4, 15, 1.35);
      light.position.set(bBounds.cx, b.floorY + 2.55, bBounds.cz);
      light.castShadow = false;
      group.add(light);
      interiorLights.push(light);
      poiLightEntries.push({
        light,
        x: bBounds.cx,
        y: b.floorY + 2.55,
        z: bBounds.cz,
        buildingId: b.id,
      });
    }

    poiCuller = createPoiScalabilityCuller({
      layout,
      buildingsHandle,
      interiorsHandle,
      containersHandle,
      interiorLights: poiLightEntries,
    });

    stage04aHandles = {
      layout,
      buildings: buildingsHandle,
      interiors: interiorsHandle,
      containers: containersHandle,
      outdoor: outdoorHandle,
    };
  } else {
    const staticGeosByMat = new Map<MaterialKind, THREE.BufferGeometry[]>();
    for (const vis of world.visuals) {
      if (vis.batchMode !== 'static_box' || !vis.boxDims || !vis.material) continue;
      const w = vis.boxDims.x;
      const h = vis.boxDims.y;
      const d = vis.boxDims.z;
      const cx = vis.transform.position.x;
      const cy = vis.transform.position.y;
      const cz = vis.transform.position.z;
      const mat = vis.material;

      const geo = new THREE.BoxGeometry(w, h, d);
      scaleBoxUVs(geo, w, h, d, TEX_SCALE[mat]);
      geo.translate(cx, cy, cz);

      let list = staticGeosByMat.get(mat);
      if (!list) {
        list = [];
        staticGeosByMat.set(mat, list);
      }
      list.push(geo);
    }
    for (const [mat, geos] of staticGeosByMat.entries()) {
      if (geos.length === 0) continue;
      const mergedStatic = new THREE.Mesh(mergeStaticGeometriesWithUV(geos), mats[mat]);
      mergedStatic.name = `cabin_merged_${mat}`;
      mergedStatic.castShadow = true;
      mergedStatic.receiveShadow = true;
      mergedStatic.matrixAutoUpdate = false;
      mergedStatic.updateMatrix();
      group.add(mergedStatic);
    }

    // Add architectural trim, open door, window sills, and warm interior light to the cabin
    const cabinGroundY = sampleTerrainHeight(world.terrain, -8, -6);
    const cabinLight = decorateForestCabin(group, cabinGroundY, mats, disposableMats);
    interiorLights.push(cabinLight);
  }

  // 3. InstancedMesh Rendering for 5 GLB Tree Species + GLB Rock + GLB Bush + Undergrowth Layers
  const fallbackTreeProtos = buildFallbackTreePrototypes();
  const underProtos = buildUndergrowthPrototypes();
  const { barkMat, foliageMat, rockMat } = getSharedForestMaterials();

  // Precompute spatial chunk 3D bounding boxes for fast O(1) chunk frustum culling
  const chunkBounds = new Map<string, { box: THREE.Box3; centerX: number; centerZ: number }>();
  const registerInChunk = (chunkKey: string, x: number, y: number, z: number, padXZ: number, padY: number) => {
    let entry = chunkBounds.get(chunkKey);
    if (!entry) {
      const box = new THREE.Box3(
        new THREE.Vector3(x - padXZ, y - 1, z - padXZ),
        new THREE.Vector3(x + padXZ, y + padY, z + padXZ),
      );
      entry = { box, centerX: x, centerZ: z };
      chunkBounds.set(chunkKey, entry);
    } else {
      entry.box.min.x = Math.min(entry.box.min.x, x - padXZ);
      entry.box.min.y = Math.min(entry.box.min.y, y - 1);
      entry.box.min.z = Math.min(entry.box.min.z, z - padXZ);
      entry.box.max.x = Math.max(entry.box.max.x, x + padXZ);
      entry.box.max.y = Math.max(entry.box.max.y, y + padY);
      entry.box.max.z = Math.max(entry.box.max.z, z + padXZ);
      entry.centerX = (entry.box.min.x + entry.box.max.x) * 0.5;
      entry.centerZ = (entry.box.min.z + entry.box.max.z) * 0.5;
    }
  };

  // Group instanced VisualDescriptors by batchKey
  const batches = new Map<string, VisualDescriptor[]>();
  for (const vis of world.visuals) {
    if (vis.batchMode !== 'instanced') continue;
    let list = batches.get(vis.batchKey);
    if (!list) {
      list = [];
      batches.set(vis.batchKey, list);
    }
    list.push(vis);
  }

  const dummy = new THREE.Object3D();
  const upVec = new THREE.Vector3(0, 1, 0);
  const normVec = new THREE.Vector3();
  const tiltQuat = new THREE.Quaternion();
  const yawQuat = new THREE.Quaternion();

  const managedBatches: ManagedInstancedBatch[] = [];
  const treeMeshPairs = new Map<
    TreeSpeciesBatchKey,
    { trunkMesh: THREE.InstancedMesh; foliageMesh: THREE.InstancedMesh }
  >();
  let boulderInstMesh: THREE.InstancedMesh | null = null;
  let bushFoliageInstMesh: THREE.InstancedMesh | null = null;
  let bushBarkInstMesh: THREE.InstancedMesh | null = null;

  // 3a. Build InstancedMeshes for the 5 Tree Species (GLB with procedural fallback)
  for (const species of TREE_SPECIES_BATCH_KEYS) {
    const items = batches.get(species) ?? [];
    if (items.length === 0) continue;

    const glbTpl = getCachedForestAssetByBatchKey(species);
    const fallback = fallbackTreeProtos[species];
    const trunkGeo = glbTpl?.barkGeo ?? fallback.trunkGeo;
    const foliageGeo = glbTpl?.foliageGeo ?? fallback.foliageGeo!;

    const trunkMesh = new THREE.InstancedMesh(trunkGeo, barkMat, items.length);
    trunkMesh.name = `inst_${species}_trunk`;
    trunkMesh.castShadow = true;
    trunkMesh.receiveShadow = true;
    trunkMesh.frustumCulled = false;

    const foliageMesh = new THREE.InstancedMesh(foliageGeo, foliageMat, items.length);
    foliageMesh.name = `inst_${species}_foliage`;
    foliageMesh.castShadow = true;
    foliageMesh.receiveShadow = true;
    foliageMesh.frustumCulled = false;

    const records: CompiledInstanceRecord[] = [];
    items.forEach((vis, i) => {
      const { position, yaw, scale } = vis.transform;
      const py = position.y - 0.08;
      dummy.position.set(position.x, py, position.z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(scale.x, scale.y, scale.z);
      dummy.updateMatrix();

      const v = ((i * 37) % 17) / 17;
      const col = new THREE.Color().setRGB(0.92 + v * 0.14, 0.93 + v * 0.14, 0.90 + v * 0.12);

      trunkMesh.setMatrixAt(i, dummy.matrix);
      trunkMesh.setColorAt(i, col);
      foliageMesh.setMatrixAt(i, dummy.matrix);
      foliageMesh.setColorAt(i, col);

      registerInChunk(vis.chunkKey, position.x, py, position.z, 3.5, 12.5);
      records.push({
        index: i,
        x: position.x,
        y: py,
        z: position.z,
        yaw,
        sx: scale.x,
        sy: scale.y,
        sz: scale.z,
        centerY: py + 4.8 * scale.y,
        sphereRadius: 5.6 * Math.max(scale.x, scale.y),
        chunkKey: vis.chunkKey,
        maxDist: vis.maxDrawDistance,
        strideHash: (i * 37 + 11) % 100,
        matrix: dummy.matrix.clone(),
        color: col,
      });
    });

    trunkMesh.instanceMatrix.needsUpdate = true;
    if (trunkMesh.instanceColor) trunkMesh.instanceColor.needsUpdate = true;
    foliageMesh.instanceMatrix.needsUpdate = true;
    if (foliageMesh.instanceColor) foliageMesh.instanceColor.needsUpdate = true;

    group.add(trunkMesh);
    group.add(foliageMesh);
    treeMeshPairs.set(species, { trunkMesh, foliageMesh });

    const chunkBuckets = buildChunkBuckets(records);
    managedBatches.push({
      batchKey: `${species}:trunk`,
      mesh: trunkMesh,
      records,
      chunkBuckets,
      isTreeFoliage: false,
      isBushFoliage: false,
      isDensityScalable: false,
      baseCastShadow: true,
      activeCount: records.length,
      activeSignature: -1,
    });
    managedBatches.push({
      batchKey: `${species}:foliage`,
      mesh: foliageMesh,
      records,
      chunkBuckets,
      isTreeFoliage: true,
      isBushFoliage: false,
      isDensityScalable: false,
      baseCastShadow: true,
      activeCount: records.length,
      activeSignature: -1,
    });
  }

  // 3b. Build InstancedMeshes for Rocks (`forest_rock_01.glb`), Bushes (`forest_bush_01.glb`), and Undergrowth
  for (const [batchKey, fallbackGeo] of Object.entries(underProtos)) {
    const items = batches.get(batchKey) ?? [];
    if (items.length === 0) continue;

    const alignToSlope =
      batchKey === 'prop:fallen_log' ||
      batchKey === 'foliage:leaf_patch' ||
      batchKey === 'foliage:grass' ||
      batchKey === 'foliage:fern';

    const isDensityScalable =
      batchKey === 'foliage:grass' ||
      batchKey === 'foliage:fern' ||
      batchKey === 'prop:pebble' ||
      batchKey === 'foliage:leaf_patch';

    const records: CompiledInstanceRecord[] = [];
    items.forEach((vis, i) => {
      const { position, yaw, scale } = vis.transform;
      dummy.position.set(position.x, position.y, position.z);
      if (alignToSlope) {
        const n = sampleTerrainNormal(world.terrain, position.x, position.z);
        normVec.set(n.x, n.y, n.z).normalize();
        tiltQuat.setFromUnitVectors(upVec, normVec);
        yawQuat.setFromAxisAngle(upVec, yaw);
        dummy.quaternion.copy(tiltQuat).multiply(yawQuat);
      } else {
        dummy.rotation.set(0, yaw, 0);
      }
      dummy.scale.set(scale.x, scale.y, scale.z);
      dummy.updateMatrix();

      const v = ((i * 53) % 19) / 19;
      const col = new THREE.Color().setRGB(0.91 + v * 0.16, 0.92 + v * 0.15, 0.90 + v * 0.13);
      registerInChunk(vis.chunkKey, position.x, position.y, position.z, 2.2, 2.5);

      records.push({
        index: i,
        x: position.x,
        y: position.y,
        z: position.z,
        yaw,
        sx: scale.x,
        sy: scale.y,
        sz: scale.z,
        centerY: position.y + 0.55 * scale.y,
        sphereRadius: 1.45 * Math.max(scale.x, scale.z),
        chunkKey: vis.chunkKey,
        maxDist: vis.maxDrawDistance,
        strideHash: (i * 41 + 7) % 100,
        matrix: dummy.matrix.clone(),
        color: col,
      });
    });

    const chunkBuckets = buildChunkBuckets(records);

    if (batchKey === 'rock:boulder_mossy') {
      const glbRock = getCachedForestAssetByBatchKey('rock:boulder_mossy');
      const rockGeo = glbRock?.rockGeo ?? fallbackGeo;
      const instMesh = new THREE.InstancedMesh(rockGeo, rockMat, items.length);
      instMesh.name = 'inst_rock:boulder_mossy';
      instMesh.castShadow = true;
      instMesh.receiveShadow = true;
      instMesh.frustumCulled = false;
      records.forEach((r, i) => {
        instMesh.setMatrixAt(i, r.matrix);
        instMesh.setColorAt(i, r.color);
      });
      instMesh.instanceMatrix.needsUpdate = true;
      if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;
      group.add(instMesh);
      boulderInstMesh = instMesh;
      managedBatches.push({
        batchKey,
        mesh: instMesh,
        records,
        chunkBuckets,
        isTreeFoliage: false,
        isBushFoliage: false,
        isDensityScalable: false,
        baseCastShadow: true,
        activeCount: records.length,
        activeSignature: -1,
      });
      continue;
    }

    if (batchKey === 'foliage:bush') {
      const glbBush = getCachedForestAssetByBatchKey('foliage:bush');
      const bushFoliageGeo = glbBush?.foliageGeo ?? fallbackGeo;
      const instMesh = new THREE.InstancedMesh(bushFoliageGeo, foliageMat, items.length);
      instMesh.name = 'inst_foliage:bush';
      instMesh.castShadow = false;
      instMesh.receiveShadow = true;
      instMesh.frustumCulled = false;
      records.forEach((r, i) => {
        instMesh.setMatrixAt(i, r.matrix);
        instMesh.setColorAt(i, r.color);
      });
      instMesh.instanceMatrix.needsUpdate = true;
      if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;
      group.add(instMesh);
      bushFoliageInstMesh = instMesh;
      managedBatches.push({
        batchKey,
        mesh: instMesh,
        records,
        chunkBuckets,
        isTreeFoliage: false,
        isBushFoliage: true,
        isDensityScalable: true,
        baseCastShadow: false,
        activeCount: records.length,
        activeSignature: -1,
      });

      // Bush wooden twig stems from forest_bush_01.glb
      const bushBarkGeo = glbBush?.barkGeo ?? fallbackGeo;
      const barkInst = new THREE.InstancedMesh(bushBarkGeo, barkMat, items.length);
      barkInst.name = 'inst_foliage:bush_bark';
      barkInst.castShadow = false;
      barkInst.receiveShadow = true;
      barkInst.frustumCulled = false;
      barkInst.visible = Boolean(glbBush?.barkGeo);
      records.forEach((r, i) => {
        barkInst.setMatrixAt(i, r.matrix);
        barkInst.setColorAt(i, r.color);
      });
      barkInst.instanceMatrix.needsUpdate = true;
      if (barkInst.instanceColor) barkInst.instanceColor.needsUpdate = true;
      group.add(barkInst);
      bushBarkInstMesh = barkInst;
      managedBatches.push({
        batchKey: 'foliage:bush_bark',
        mesh: barkInst,
        records,
        chunkBuckets,
        isTreeFoliage: false,
        isBushFoliage: true,
        isDensityScalable: true,
        baseCastShadow: false,
        activeCount: records.length,
        activeSignature: -1,
      });
      continue;
    }

    const isStoneOrWood =
      batchKey === 'prop:fallen_log' || batchKey === 'prop:tree_stump' || batchKey === 'prop:pebble';
    const instMesh = new THREE.InstancedMesh(
      fallbackGeo,
      isStoneOrWood ? barkMat : foliageMat,
      items.length,
    );
    instMesh.name = `inst_${batchKey}`;
    const castsShadow = batchKey === 'prop:tree_stump';
    instMesh.castShadow = castsShadow;
    instMesh.receiveShadow = true;
    instMesh.frustumCulled = false;

    records.forEach((r, i) => {
      instMesh.setMatrixAt(i, r.matrix);
      instMesh.setColorAt(i, r.color);
    });
    instMesh.instanceMatrix.needsUpdate = true;
    if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;
    group.add(instMesh);

    managedBatches.push({
      batchKey,
      mesh: instMesh,
      records,
      chunkBuckets,
      isTreeFoliage: false,
      isBushFoliage: false,
      isDensityScalable,
      baseCastShadow: castsShadow,
      activeCount: records.length,
      activeSignature: -1,
    });
  }

  // Hot-swap fallback geometries with compiled GLB geometries when async preload finishes
  const unsubAssets = onForestAssetsReady(() => {
    for (const species of TREE_SPECIES_BATCH_KEYS) {
      const tpl = getCachedForestAssetByBatchKey(species);
      const pair = treeMeshPairs.get(species);
      if (tpl && pair) {
        if (tpl.barkGeo) pair.trunkMesh.geometry = tpl.barkGeo;
        if (tpl.foliageGeo) pair.foliageMesh.geometry = tpl.foliageGeo;
      }
    }
    const rockTpl = getCachedForestAssetByBatchKey('rock:boulder_mossy');
    if (rockTpl?.rockGeo && boulderInstMesh) {
      boulderInstMesh.geometry = rockTpl.rockGeo;
    }
    const bushTpl = getCachedForestAssetByBatchKey('foliage:bush');
    if (bushTpl) {
      if (bushTpl.foliageGeo && bushFoliageInstMesh) {
        bushFoliageInstMesh.geometry = bushTpl.foliageGeo;
      }
      if (bushTpl.barkGeo && bushBarkInstMesh) {
        bushBarkInstMesh.geometry = bushTpl.barkGeo;
        bushBarkInstMesh.visible = true;
      }
    }
  });

  // 4. Merged Subtle Sunbeam Shafts Filtering Through the Forest Canopy (1 draw call)
  const beamMat = new THREE.MeshBasicMaterial({
    color: '#ffe8a3',
    transparent: true,
    opacity: 0.028,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
  disposableMats.push(beamMat);
  const beamPositions: Array<[number, number, number]> = isForestSquare
    ? [
        [5, 6.5, -6],
        [42, 7.0, 28],
        [-48, 7.5, -36],
        [68, 7.0, -32],
        [-52, 6.5, 42],
        [18, 6.8, -68],
        [-22, 6.8, 74],
      ]
    : [
        [5, 6.5, -6],
        [12, 6.5, 14],
        [-16, 7.5, -14],
        [18, 7.0, -10],
        [-14, 6.2, 16],
      ];
  const beamGeos: THREE.BufferGeometry[] = [];
  for (const [bx, by, bz] of beamPositions) {
    const g = new THREE.CylinderGeometry(0.9, 3.2, 16, 10, 1, true);
    const m4 = new THREE.Matrix4().compose(
      new THREE.Vector3(bx, by, bz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.28, 0.4, -0.35)),
      new THREE.Vector3(1, 1, 1),
    );
    g.applyMatrix4(m4);
    beamGeos.push(g);
  }
  const sunbeamMesh = new THREE.Mesh(mergeStaticGeometriesWithUV(beamGeos), beamMat);
  sunbeamMesh.name = 'forest_sunbeams';
  group.add(sunbeamMesh);

  // 5. Distant Forested Valley Ridges & Outer Ground Skirt (Merged into 3 draw calls total)
  const outerSkirtMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(0.142, 0.248, 0.092),
    roughness: 0.96,
    metalness: 0.0,
  });
  disposableMats.push(outerSkirtMat);
  let outerSkirt: THREE.Mesh;
  if (isForestSquare) {
    // Stage 08 Review Fix: Annular skirt leaves [-128, 128] x [-128, 128] 100% open so terrain depressions (y < 0) are never occluded!
    const skirtGeo = buildAnnularSkirtGeometry(128, 600, 0.0);
    outerSkirt = new THREE.Mesh(skirtGeo, outerSkirtMat);
    outerSkirt.receiveShadow = false;
  } else {
    // Preserve legacy solid plane for forest_sample (bounds [-48, 48])
    const skirtSize = 900;
    const skirtGeo = new THREE.PlaneGeometry(skirtSize, skirtSize);
    outerSkirt = new THREE.Mesh(skirtGeo, outerSkirtMat);
    outerSkirt.rotation.x = -Math.PI / 2;
    outerSkirt.position.y = -0.02;
    outerSkirt.receiveShadow = true;
  }
  outerSkirt.name = 'forest_outer_skirt';
  group.add(outerSkirt);

  const ridgeMatNear = new THREE.MeshStandardMaterial({ color: '#334d2c', roughness: 0.96 });
  const ridgeMatFar = new THREE.MeshStandardMaterial({ color: '#475e4c', roughness: 0.96 });
  disposableMats.push(ridgeMatNear, ridgeMatFar);
  const nearHillGeos: THREE.BufferGeometry[] = [];
  const farHillGeos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const isFar = i % 2 === 1;
    const r = isForestSquare
      ? isFar
        ? 295 + (i % 3) * 26
        : 220 + (i % 4) * 18
      : isFar
        ? 175 + (i % 3) * 22
        : 122 + (i % 4) * 14;
    const h = isFar ? 38 + (i % 5) * 10 : 22 + (i % 4) * 7;
    const rad = isFar ? 38 + (i % 3) * 10 : 28 + (i % 4) * 8;
    const cone = new THREE.ConeGeometry(rad, h, 7);
    const m4 = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * r, h / 2 - 4, Math.sin(a) * r),
      new THREE.Quaternion().setFromAxisAngle(upVec, i * 0.7),
      new THREE.Vector3(1, 1, 1),
    );
    cone.applyMatrix4(m4);
    if (isFar) farHillGeos.push(cone);
    else nearHillGeos.push(cone);
  }
  const nearHillsMesh = new THREE.Mesh(mergeStaticGeometriesWithUV(nearHillGeos), ridgeMatNear);
  nearHillsMesh.name = 'forest_ridges_near';
  group.add(nearHillsMesh);
  const farHillsMesh = new THREE.Mesh(mergeStaticGeometriesWithUV(farHillGeos), ridgeMatFar);
  farHillsMesh.name = 'forest_ridges_far';
  group.add(farHillsMesh);

  scene.add(group);

  // 5b. STAGE 08-FIX: visual-only ground cover (grass tufts / short grass / small ferns / 3 wildflower colors).
  // Client-only, deterministic from the public layout seed, never in world.visuals / gameplayHash / server.
  let groundCover: GroundCoverRendererHandle | null = null;
  if (isForestSquare && 'roadNetwork' in world) {
    try {
      const field = buildForestSquareGroundCover(world as ForestSquareWorldDefinition);
      groundCover = createGroundCoverRenderer(field, initialQuality, world.publicLayoutSeed);
      scene.add(groundCover.group);
    } catch (err) {
      // Purely cosmetic layer: never break world rendering if ground cover generation fails.
      console.error('[GroundCover] failed to build ground cover layer', err);
      groundCover = null;
    }
  }
  // 6. Dedicated Forest Environment Lighting & Golden-Hour Atmosphere
  const hemi = new THREE.HemisphereLight('#d4e6ff', '#354d24', 1.25);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#ffe1a6', 2.65);
  sun.position.set(52, 54, 36);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -54;
  sc.right = 54;
  sc.top = 54;
  sc.bottom = -54;
  sc.near = 8;
  sc.far = 165;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  const sunShadowFollower: PlayerFollowingSunShadow | null = isForestSquare
    ? createPlayerFollowingSunShadow(sun, world)
    : null;

  // Cool sky rim-light from opposite direction so shaded trunks & GLB foliage have readable 3D depth
  const rimLight = new THREE.DirectionalLight('#9ec4ed', 0.58);
  rimLight.position.set(-45, 32, -40);
  scene.add(rimLight);

  const sunDir = sun.position.clone().normalize();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color('#27629e') },
      horizon: { value: new THREE.Color('#e6d3b3') },
      sunDir: { value: sunDir },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y * 1.45 + 0.08, 0.0, 1.0);
        vec3 col = mix(horizon, top, pow(h, 0.72));
        float s = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.89, 0.64) * (pow(s, 700.0) * 3.8 + pow(s, 9.0) * 0.34);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(isForestSquare ? 780 : 600, 24, 12), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // Natural woodland depth fog
  const forestFog = new THREE.Fog('#c4d6ba', isForestSquare ? 62 : 50, isForestSquare ? 265 : 215);
  scene.fog = forestFog;

  // 7. Dynamic Per-Chunk Frustum Culling, Quality LOD/Distance Scaling & Dirty-Flag Caching
  let currentQuality: QualityLevel = initialQuality;
  const projScreenMatrix = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const visibleChunks = new Set<string>();
  const instSphere = new THREE.Sphere();
  const visibleScratch: CompiledInstanceRecord[] = [];

  // Camera pose & quality dirty-detection state (prevents redundant O(N) CPU & GPU buffer uploads)
  let forceDirty = true;
  let lastCamX = Number.NaN;
  let lastCamY = Number.NaN;
  let lastCamZ = Number.NaN;
  let lastQuatX = Number.NaN;
  let lastQuatY = Number.NaN;
  let lastQuatZ = Number.NaN;
  let lastQuatW = Number.NaN;
  let lastProjElem0 = Number.NaN;

  // Ensure async structure/interior/container asset loads trigger a fresh culling pass
  const unsubBuildingAssets = isModularStructuresMap
    ? onBuildingAssetsReady(() => {
        forceDirty = true;
      })
    : () => {};
  const unsubInteriorAssets = isModularStructuresMap
    ? onInteriorAssetsReady(() => {
        forceDirty = true;
      })
    : () => {};
  const unsubContainerAssets = isModularStructuresMap
    ? onContainerAssetsReady(() => {
        forceDirty = true;
      })
    : () => {};
  const unsubOutdoorAssets = isModularStructuresMap
    ? onOutdoorAssetsReady(() => {
        forceDirty = true;
      })
    : () => {};
  const unsubGrassAssets = isForestSquare
    ? onGrassAssetsReady(() => {
        forceDirty = true;
      })
    : () => {};

  // Built-in high-resolution CPU culling profiler
  let profCalls = 0;
  let profEvaluated = 0;
  let profSkippedStatic = 0;
  let profBatchUploads = 0;
  let profBatchSkips = 0;
  let profLastCpuMs = 0;
  let profTotalCpuMs = 0;
  let profMaxCpuMs = 0;
  const profSamples: number[] = [];

  const recordProfSample = (ms: number) => {
    profLastCpuMs = ms;
    profTotalCpuMs += ms;
    if (ms > profMaxCpuMs) profMaxCpuMs = ms;
    profSamples.push(ms);
    if (profSamples.length > 2400) profSamples.shift();
  };

  const resetCullingProfile = () => {
    profCalls = 0;
    profEvaluated = 0;
    profSkippedStatic = 0;
    profBatchUploads = 0;
    profBatchSkips = 0;
    profLastCpuMs = 0;
    profTotalCpuMs = 0;
    profMaxCpuMs = 0;
    profSamples.length = 0;
  };

  const getCullingProfile = (): CullingProfileStats => {
    let p95 = 0;
    if (profSamples.length > 0) {
      const sorted = [...profSamples].sort((a, b) => a - b);
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
    return {
      calls: profCalls,
      evaluatedFrames: profEvaluated,
      skippedStaticFrames: profSkippedStatic,
      batchBufferUploads: profBatchUploads,
      batchBufferSkips: profBatchSkips,
      lastCpuMs: Number(profLastCpuMs.toFixed(4)),
      avgCpuMs: profCalls > 0 ? Number((profTotalCpuMs / profCalls).toFixed(4)) : 0,
      p95CpuMs: Number(p95.toFixed(4)),
      maxCpuMs: Number(profMaxCpuMs.toFixed(4)),
    };
  };

  const updateVisibility = (
    camera?: THREE.Camera,
    focusPos?: { x: number; y: number; z: number },
    _thirdPerson = false,
  ) => {
    const t0 = performance.now();
    profCalls++;

    const distMul = currentQuality === 'low' ? 0.56 : currentQuality === 'medium' ? 0.8 : 1.0;
    const densityPct = currentQuality === 'low' ? 35 : currentQuality === 'medium' ? 72 : 100;

    if (!camera) {
      // Fallback when no camera is passed (e.g. quality switch or unit test): apply quality density settings
      for (const batch of managedBatches) {
        const pct = batch.isDensityScalable ? densityPct : 100;
        let outIdx = 0;
        let sig = 2166136261;
        for (let i = 0; i < batch.records.length; i++) {
          const rec = batch.records[i];
          if (rec.strideHash >= pct) continue;
          batch.mesh.setMatrixAt(outIdx, rec.matrix);
          batch.mesh.setColorAt(outIdx, rec.color);
          sig = Math.imul(sig ^ rec.index, 16777619) | 0;
          outIdx++;
        }
        batch.mesh.count = outIdx;
        batch.mesh.instanceMatrix.needsUpdate = true;
        if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
        batch.activeCount = outIdx;
        batch.activeSignature = sig;
        profBatchUploads++;
      }
      forceDirty = true;
      profEvaluated++;
      recordProfSample(performance.now() - t0);
      return;
    }

    camera.updateMatrixWorld();
    const camPos = camera.position;
    const camQuat = camera.quaternion;
    const projElem0 = camera.projectionMatrix.elements[0];

    // Level 1 Dirty Check: Skip culling & GPU buffer uploads if camera pose and quality are unchanged
    const posDeltaSq =
      (camPos.x - lastCamX) * (camPos.x - lastCamX) +
      (camPos.y - lastCamY) * (camPos.y - lastCamY) +
      (camPos.z - lastCamZ) * (camPos.z - lastCamZ);
    const rotDelta =
      Math.abs(camQuat.x - lastQuatX) +
      Math.abs(camQuat.y - lastQuatY) +
      Math.abs(camQuat.z - lastQuatZ) +
      Math.abs(camQuat.w - lastQuatW);

    if (!forceDirty && posDeltaSq < 1e-5 && rotDelta < 1e-4 && projElem0 === lastProjElem0) {
      profSkippedStatic++;
      recordProfSample(performance.now() - t0);
      return;
    }

    lastCamX = camPos.x;
    lastCamY = camPos.y;
    lastCamZ = camPos.z;
    lastQuatX = camQuat.x;
    lastQuatY = camQuat.y;
    lastQuatZ = camQuat.z;
    lastQuatW = camQuat.w;
    lastProjElem0 = projElem0;

    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);

    const isTopDownOverview = camPos.y > 32;

    if (isForestSquare) {
      forestFog.near = isTopDownOverview ? 160 : 62;
      forestFog.far = isTopDownOverview ? 520 : 265;
    }

    sunShadowFollower?.update(camera, focusPos, isTopDownOverview);
    poiCuller?.update(camera, frustum, currentQuality, isTopDownOverview);
    stage04aHandles?.outdoor?.update(camera, frustum, currentQuality, isTopDownOverview);
    groundCover?.update(camera, frustum, isTopDownOverview);

    visibleChunks.clear();
    for (const [key, chunk] of chunkBounds.entries()) {
      if (isTopDownOverview || frustum.intersectsBox(chunk.box)) {
        visibleChunks.add(key);
        continue;
      }
      // Keep nearby chunks within 11m behind camera so trees still cast shadows into view
      const dx = chunk.centerX - camPos.x;
      const dz = chunk.centerZ - camPos.z;
      if (dx * dx + dz * dz <= 121) {
        visibleChunks.add(key);
      }
    }

    for (const batch of managedBatches) {
      if (batch.batchKey === 'foliage:bush_bark' && isTopDownOverview) {
        if (batch.activeCount !== 0 || forceDirty) {
          batch.mesh.count = 0;
          batch.mesh.instanceMatrix.needsUpdate = true;
          batch.activeCount = 0;
          batch.activeSignature = 0;
          profBatchUploads++;
        } else {
          profBatchSkips++;
        }
        continue;
      }

      const pct = batch.isDensityScalable ? densityPct : 100;
      const isTreeBatch = batch.batchKey.startsWith('tree:');
      visibleScratch.length = 0;
      let sig = 2166136261;

      // Iterate only records belonging to visibleChunks (O(visible_chunks), scalable to 256x256 in Stage 04)
      for (const chunkKey of visibleChunks) {
        const bucket = batch.chunkBuckets.get(chunkKey);
        if (!bucket) continue;

        for (let i = 0; i < bucket.length; i++) {
          const rec = bucket[i];
          if (rec.strideHash >= pct) continue;

          const dx = rec.x - camPos.x;
          const dy = rec.y - camPos.y;
          const dz = rec.z - camPos.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          const maxD =
            isTopDownOverview && (isTreeBatch || batch.batchKey === 'rock:boulder_mossy' || batch.batchKey === 'foliage:bush')
              ? isForestSquare
                ? 440
                : 240
              : rec.maxDist * distMul;
          if (distSq > maxD * maxD) continue;

          // Per-instance 3D sphere frustum culling (keeping close shadow-casting trees within 12m behind camera)
          if (!isTopDownOverview) {
            instSphere.center.set(rec.x, rec.centerY, rec.z);
            instSphere.radius = rec.sphereRadius;
            if (!frustum.intersectsSphere(instSphere)) {
              if (!isTreeBatch || distSq > 144) {
                continue;
              }
            }
          }

          // NOTE (Stage 03.5-QA PvP Fairness):
          // World bushes (`foliage:bush`) and tree canopies (`tree:*:foliage`) are NEVER hidden or shrunk
          // based on local camera distance or 1P/3P mode, ensuring 100% fair PvP cover across all clients.
          visibleScratch.push(rec);
          sig = Math.imul(sig ^ rec.index, 16777619) | 0;
        }
      }

      const outIdx = visibleScratch.length;
      // Level 2 Dirty Check: Only write matrices/colors and mark GPU buffers dirty if visible set changed
      if (!forceDirty && outIdx === batch.activeCount && sig === batch.activeSignature) {
        profBatchSkips++;
        continue;
      }

      for (let k = 0; k < outIdx; k++) {
        const rec = visibleScratch[k];
        batch.mesh.setMatrixAt(k, rec.matrix);
        batch.mesh.setColorAt(k, rec.color);
      }
      batch.mesh.count = outIdx;
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
      batch.activeCount = outIdx;
      batch.activeSignature = sig;
      profBatchUploads++;
    }

    forceDirty = false;
    profEvaluated++;
    recordProfSample(performance.now() - t0);
  };

  const applyQuality = (q: QualityLevel) => {
    currentQuality = q;
    forceDirty = true;
    for (const batch of managedBatches) {
      if (batch.isTreeFoliage) {
        // Low quality disables canopy shadow casting; medium/high cast canopy shadows
        batch.mesh.castShadow = q !== 'low';
      } else if (batch.batchKey.endsWith(':trunk')) {
        // In medium quality, the wide foliage canopy casts the tree shadow; trunks cast shadows in low & high
        batch.mesh.castShadow = q !== 'medium';
      } else if (batch.batchKey === 'rock:boulder_mossy' || batch.batchKey === 'prop:tree_stump') {
        batch.mesh.castShadow = q === 'high';
      } else {
        batch.mesh.castShadow = batch.baseCastShadow;
      }
    }
    const mapSz = q === 'low' ? 1024 : q === 'medium' ? 2048 : 3072;
    if (sun.shadow.mapSize.x !== mapSz) {
      sun.shadow.mapSize.set(mapSz, mapSz);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
    }
    for (const light of interiorLights) {
      light.visible = q !== 'low';
    }
    stage04aHandles?.outdoor?.setQuality(q);
    groundCover?.setQuality(q);
    sunbeamMesh.visible = q !== 'low';
    updateVisibility();
  };
  applyQuality(initialQuality);

  // Stable reference for DEV stats (keeps returning zeros instead of throwing after dispose).
  const groundCoverStatsSource = groundCover;

  return {
    sun,
    sky,
    setQuality: applyQuality,
    update: updateVisibility,
    getCullingProfile,
    resetCullingProfile,
    getGroundCoverStats: groundCoverStatsSource ? () => groundCoverStatsSource.getStats() : undefined,
    stage04a: stage04aHandles,
    dispose: () => {
      unsubAssets();
      groundCover?.dispose();
      groundCover = null;
      unsubBuildingAssets();
      unsubInteriorAssets();
      unsubContainerAssets();
      unsubOutdoorAssets();
      unsubGrassAssets();
      stage04aHandles?.buildings.dispose();
      stage04aHandles?.interiors.dispose();
      stage04aHandles?.containers.dispose();
      stage04aHandles?.outdoor?.dispose();
      sun.shadow.map?.dispose();
      scene.remove(group);
      scene.remove(hemi);
      scene.remove(sun);
      scene.remove(sun.target);
      scene.remove(rimLight);
      scene.remove(sky);
      sky.geometry.dispose();
      group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) {
          o.dispose();
        }
        if (o instanceof THREE.Mesh && !o.geometry.userData?.sharedAsset) {
          o.geometry.dispose();
        }
      });
      for (const proto of Object.values(fallbackTreeProtos)) {
        proto.trunkGeo.dispose();
        proto.foliageGeo?.dispose();
      }
      for (const geo of Object.values(underProtos)) {
        geo.dispose();
      }
      for (const m of disposableMats) {
        m.dispose();
      }
      Object.values(mats).forEach((m) => m.dispose());
      Object.values(textures).forEach((t) => t.dispose());
      skyMat.dispose();
    },
  };
}
