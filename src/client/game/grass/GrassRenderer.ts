import * as THREE from 'three';
import {
  GROUND_COVER_KINDS,
  GROUND_COVER_STRIDE,
  type GroundCoverField,
} from '../../../shared/groundCover';
import type { QualityLevel } from '../../settings';
import {
  GRASS_VARIANT_IDS,
  getSharedGrassUniforms,
  getSharedVegetationMaterial,
  getGrassAsset,
  getVariantCategory,
  onGrassAssetsReady,
  type GrassCategory,
  type GrassVariantId,
} from './GrassAssetRegistry';
import { planGrassVariant } from './GrassVariantPlanner';

/**
 * STAGE 08-TERRAIN-VISUAL — High Performance GLB Grass Renderer
 *
 * Renders the 17 stylized Claude GLB vegetation variants using pooled `THREE.InstancedMesh`.
 * - Max 17 draw calls (1 per variant model).
 * - Single shared `MeshStandardMaterial` for 0 pipeline rebinds.
 * - Chunk-based CPU frustum & circular distance culling (16x16 m chunks).
 * - GPU vertex shader distance fade (outer 15% distance) + procedural wind sway.
 * - Zero per-frame allocations during steady rendering.
 * - Full compliance with `GroundCoverRendererHandle` interface.
 */

export interface GroundCoverStats {
  visibleGrass: number;
  visibleFlowers: number;
  visibleFerns: number;
  visibleChunks: number;
  totalInstances: number;
  drawCalls: number;
  /** Extra diagnostics (optional consumers). */
  visibleTriangles?: number;
  quality?: QualityLevel;
  gpuBytes?: number;
  uploads?: number;
  lastUpdateMs?: number;
  buildMs?: number;
  activeGLBVariantCount?: number;
  activeFallbackVariantCount?: number;
  isAllLoaded?: boolean;
}

export interface GroundCoverRendererHandle {
  group: THREE.Group;
  update(camera: THREE.Camera, frustum: THREE.Frustum, isTopDown: boolean): void;
  setQuality(q: QualityLevel): void;
  getStats(): GroundCoverStats;
  dispose(): void;
}

export interface GrassQualityPreset {
  density: number;
  grassDist: number;
  flowerDist: number;
  fernDist: number;
  wind: number;
  receiveShadow: boolean;
}

/** Quality presets matching Stage 08 requirements. */
export const GRASS_QUALITY_PRESETS: Record<QualityLevel, GrassQualityPreset> = {
  high: { density: 1.0, grassDist: 75, flowerDist: 65, fernDist: 80, wind: 1.0, receiveShadow: true },
  medium: { density: 0.8, grassDist: 55, flowerDist: 48, fernDist: 60, wind: 0.7, receiveShadow: false },
  low: { density: 0.3, grassDist: 30, flowerDist: 26, fernDist: 34, wind: 0.0, receiveShadow: false },
};

function presetDist(p: GrassQualityPreset, cat: GrassCategory): number {
  return cat === 'grass' ? p.grassDist : cat === 'flower' ? p.flowerDist : p.fernDist;
}

/**
 * Masofaviy LOD: o'yinchi atrofidagi `LOD_FULL_DIST` metr ichida barcha o'tlar ko'rsatiladi,
 * undan keyin ulush chiziqli kamayib `LOD_FAR_FRACTION` gacha tushadi (maydon 5x zich bo'lgani
 * uchun uzoqdagi 0.22 ulush ham avvalgi asosiy zichlikdan kam emas).
 */
const LOD_FULL_DIST = 16;
const LOD_FULL_DIST2 = LOD_FULL_DIST * LOD_FULL_DIST;
const LOD_FALLOFF_INV = 1 / 22; // 16 m → 38 m oralig'ida 1.0 → 0.0 (floor bilan 0.16)
const LOD_FAR_FRACTION = 0.16;

interface VariantBatch {
  variantId: GrassVariantId;
  category: GrassCategory;
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  /** All instance matrices of this variant, grouped contiguous by chunk (16 floats each). */
  matrices: Float32Array;
  /** All instance colors of this variant, same order (3 floats each). */
  colors: Float32Array;
  /** Per chunk index: first instance index and instance count for this variant. */
  chunkStart: Int32Array;
  chunkCount: Int32Array;
  capacity: number;
  visible: number;
  gpuBytes: number;
  tris: number;
  isFallback: boolean;
}

const noopRaycast = () => {};

function hash01(x: number, z: number, salt: number): number {
  let h =
    Math.imul(Math.floor(x * 97.13) ^ 0x9e3779b1, 0x85ebca6b) ^
    Math.imul(Math.floor(z * 61.7) + salt, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

interface TempInstance {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

export function createGrassRenderer(
  field: GroundCoverField,
  quality: QualityLevel,
  seed = 6501,
): GroundCoverRendererHandle {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'ground_cover_glb';

  const sharedUniforms = getSharedGrassUniforms();
  const sharedMaterial = getSharedVegetationMaterial();

  const chunks = field.chunks;
  const nChunks = chunks.length;

  // Chunk AABBs for frustum tests
  const chunkBoxes: THREE.Box3[] = chunks.map(
    (c) =>
      new THREE.Box3(
        new THREE.Vector3(c.minX - 1.5, c.minY - 0.25, c.minZ - 1.5),
        new THREE.Vector3(c.maxX + 1.5, c.maxY + 0.75, c.maxZ + 1.5),
      ),
  );

  // Group instances by chunk and variant
  // Variant ID index lookup
  const variantIndexMap = new Map<GrassVariantId, number>();
  for (let i = 0; i < GRASS_VARIANT_IDS.length; i++) {
    variantIndexMap.set(GRASS_VARIANT_IDS[i], i);
  }

  const chunkVariantLists: TempInstance[][][] = new Array(nChunks);
  const totalPerVariant = new Int32Array(GRASS_VARIANT_IDS.length);

  for (let ci = 0; ci < nChunks; ci++) {
    const c = chunks[ci];
    chunkVariantLists[ci] = new Array(GRASS_VARIANT_IDS.length);
    for (let vi = 0; vi < GRASS_VARIANT_IDS.length; vi++) {
      chunkVariantLists[ci][vi] = [];
    }

    for (const kind of GROUND_COVER_KINDS) {
      const arr = c.batches[kind];
      if (!arr) continue;
      const count = Math.floor(arr.length / GROUND_COVER_STRIDE);
      for (let i = 0; i < count; i++) {
        const o = i * GROUND_COVER_STRIDE;
        const x = arr[o]!;
        const y = arr[o + 1]!;
        const z = arr[o + 2]!;
        const baseYaw = arr[o + 3]!;
        const baseScale = arr[o + 4]!;

        const planned = planGrassVariant(x, y, z, kind, baseYaw, baseScale, seed);
        const vi = variantIndexMap.get(planned.variantId) ?? 0;
        chunkVariantLists[ci][vi].push({
          x,
          y,
          z,
          yaw: planned.yaw,
          scale: planned.scale,
        });
        totalPerVariant[vi]++;
      }
    }
  }

  const batches: VariantBatch[] = [];
  const camWorld = new THREE.Vector3();
  const updateMeshTime = () => {
    sharedUniforms.uGcTime.value = performance.now() * 0.001;
  };

  // Build batches for each active variant
  for (let vi = 0; vi < GRASS_VARIANT_IDS.length; vi++) {
    const total = totalPerVariant[vi];
    if (total === 0) continue;

    const variantId = GRASS_VARIANT_IDS[vi];
    const category = getVariantCategory(variantId);
    const asset = getGrassAsset(variantId);
    const geometry = asset.geometry;

    const matrices = new Float32Array(total * 16);
    const colors = new Float32Array(total * 3);
    const chunkStart = new Int32Array(nChunks);
    const chunkCount = new Int32Array(nChunks);
    const isFlower = category === 'flower';

    let idx = 0;
    for (let ci = 0; ci < nChunks; ci++) {
      chunkStart[ci] = idx;
      const list = chunkVariantLists[ci][vi];
      const count = list.length;
      chunkCount[ci] = count;

      for (let i = 0; i < count; i++) {
        const inst = list[i]!;
        const x = inst.x;
        const y = inst.y - 0.015; // Sink slightly to avoid floating roots
        const z = inst.z;
        const yaw = inst.yaw;
        const s = inst.scale;

        const cs = Math.cos(yaw) * s;
        const sn = Math.sin(yaw) * s;
        const m = idx * 16;

        matrices[m] = cs;
        matrices[m + 1] = 0;
        matrices[m + 2] = -sn;
        matrices[m + 3] = 0;
        matrices[m + 4] = 0;
        matrices[m + 5] = s;
        matrices[m + 6] = 0;
        matrices[m + 7] = 0;
        matrices[m + 8] = sn;
        matrices[m + 9] = 0;
        matrices[m + 10] = cs;
        matrices[m + 11] = 0;
        matrices[m + 12] = x;
        matrices[m + 13] = y;
        matrices[m + 14] = z;
        matrices[m + 15] = 1;

        // Subtle per-instance tint modulation multiplying GLB vertex colors
        const h1 = hash01(x, z, vi * 7 + 1);
        const h2 = hash01(z, x, vi * 13 + 5);
        const bright = isFlower ? 0.94 + h1 * 0.12 : 0.88 + h1 * 0.22;
        const warm = isFlower ? 0 : (h2 - 0.5) * 0.08;
        const c3 = idx * 3;
        colors[c3] = bright * (1 + warm);
        colors[c3 + 1] = bright;
        colors[c3 + 2] = bright * (1 - warm * 0.6);

        idx++;
      }
    }

    const mesh = new THREE.InstancedMesh(geometry, sharedMaterial, total);
    mesh.name = `inst_grass:${variantId}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // Culled per chunk on CPU
    mesh.matrixAutoUpdate = false;
    mesh.raycast = noopRaycast;
    mesh.onBeforeRender = (_r, _s, camera) => {
      camWorld.setFromMatrixPosition(camera.matrixWorld);
      sharedUniforms.uGcCam.value.copy(camWorld);
      updateMeshTime();
    };

    group.add(mesh);

    const vtx = geometry.getAttribute('position').count;
    batches.push({
      variantId,
      category,
      mesh,
      geometry,
      matrices,
      colors,
      chunkStart,
      chunkCount,
      capacity: total,
      visible: 0,
      gpuBytes: vtx * 36 + total * 76,
      tris: asset.triangles,
      isFallback: asset.isFallback,
    });
  }

  let currentQuality: QualityLevel = quality;
  let preset = GRASS_QUALITY_PRESETS[currentQuality];
  let dirty = true;
  let lastTopDown = false;
  let lastCamera: THREE.Camera | null = null;
  let lastFrustum: THREE.Frustum | null = null;
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let lastZ = Number.NaN;
  let lastQx = 0;
  let lastQy = 0;
  let lastQz = 0;
  let lastQw = 1;
  let lastProj0 = Number.NaN;
  let lastProj5 = Number.NaN;
  let visibleChunks = 0;
  let uploads = 0;
  let lastUpdateMs = 0;
  const COS_HALF_2DEG = Math.cos((2 * Math.PI) / 180 / 2);

  const applyPreset = () => {
    preset = GRASS_QUALITY_PRESETS[currentQuality];
    sharedUniforms.uGcWind.value = preset.wind;
    sharedUniforms.uGcDistances.value.set(preset.grassDist, preset.flowerDist, preset.fernDist);
    for (const b of batches) {
      b.mesh.receiveShadow = preset.receiveShadow;
    }
  };
  applyPreset();

  const setAllCounts = (n: number) => {
    for (const b of batches) {
      if (b.mesh.count !== n) {
        b.mesh.count = n;
      }
      b.visible = n;
    }
  };

  const swapGeometries = (targetVariantId?: GrassVariantId) => {
    let anySwapped = false;
    for (const batch of batches) {
      if (targetVariantId && batch.variantId !== targetVariantId) continue;
      const currentAsset = getGrassAsset(batch.variantId);
      if (batch.mesh.geometry !== currentAsset.geometry) {
        const oldGeo = batch.mesh.geometry;
        batch.mesh.geometry = currentAsset.geometry;
        batch.geometry = currentAsset.geometry;
        batch.tris = currentAsset.triangles;
        batch.isFallback = currentAsset.isFallback;
        const vtx = currentAsset.geometry.getAttribute('position')?.count ?? 0;
        batch.gpuBytes = vtx * 36 + batch.capacity * 76;
        anySwapped = true;
        dirty = true;
        // If oldGeo was a temporary procedural fallback not in assetCache, dispose it safely
        if (oldGeo.userData?.isTemporaryFallback) {
          oldGeo.dispose();
        }
      }
    }
    if (anySwapped && lastCamera && lastFrustum) {
      update(lastCamera, lastFrustum, lastTopDown);
    }
  };

  const unsubscribeAssets = onGrassAssetsReady((variantId) => {
    swapGeometries(variantId);
  });

  const update = (camera: THREE.Camera, frustum: THREE.Frustum, isTopDown: boolean): void => {
    lastCamera = camera;
    lastFrustum = frustum;
    const camPos = camera.position;
    const q = camera.quaternion;
    const pe = camera.projectionMatrix.elements;

    if (isTopDown) {
      if (!lastTopDown) {
        group.visible = false;
        setAllCounts(0);
        visibleChunks = 0;
        lastTopDown = true;
      }
      return;
    }

    const dx = camPos.x - lastX;
    const dy = camPos.y - lastY;
    const dz = camPos.z - lastZ;
    const moved = !(dx * dx + dy * dy + dz * dz <= 0.5625); // > 0.75 m
    const dot = Math.abs(q.x * lastQx + q.y * lastQy + q.z * lastQz + q.w * lastQw);
    const rotated = dot < COS_HALF_2DEG; // > ~2°
    const projChanged = pe[0] !== lastProj0 || pe[5] !== lastProj5;
    if (!dirty && !lastTopDown && !moved && !rotated && !projChanged) return;

    const t1 = performance.now();
    lastTopDown = false;
    group.visible = true;
    lastX = camPos.x;
    lastY = camPos.y;
    lastZ = camPos.z;
    lastQx = q.x;
    lastQy = q.y;
    lastQz = q.z;
    lastQw = q.w;
    lastProj0 = pe[0];
    lastProj5 = pe[5];

    const cx = camPos.x;
    const cz = camPos.z;
    const density = preset.density;

    // CPU culling distance extends +1.5m beyond shader fade end so no pop occurs during <0.75m sub-threshold moves
    const grassD = preset.grassDist + 1.5;
    const flowerD = preset.flowerDist + 1.5;
    const fernD = preset.fernDist + 1.5;
    const maxD = Math.max(grassD, flowerD, fernD);
    const maxD2 = maxD * maxD;

    for (const b of batches) b.visible = 0;
    visibleChunks = 0;

    for (let ci = 0; ci < nChunks; ci++) {
      const c = chunks[ci];
      const ndx = c.minX - cx > 0 ? c.minX - cx : cx - c.maxX > 0 ? cx - c.maxX : 0;
      const ndz = c.minZ - cz > 0 ? c.minZ - cz : cz - c.maxZ > 0 ? cz - c.maxZ : 0;
      const near2 = ndx * ndx + ndz * ndz;
      if (near2 > maxD2) continue;
      if (!frustum.intersectsBox(chunkBoxes[ci])) continue;

      const fdx = Math.max(Math.abs(cx - c.minX), Math.abs(cx - c.maxX));
      const fdz = Math.max(Math.abs(cz - c.minZ), Math.abs(cz - c.maxZ));
      const far2 = fdx * fdx + fdz * fdz;

      let anyInChunk = false;
      for (let bi = 0; bi < batches.length; bi++) {
        const b = batches[bi];
        const n = b.chunkCount[ci];
        if (n === 0) continue;

        const d = b.category === 'grass' ? grassD : b.category === 'flower' ? flowerD : fernD;
        const d2 = d * d;
        if (near2 > d2) continue;

        let take = Math.round(n * density);
        if (take <= 0) continue;
        if (take > n) take = n;

        const src = b.matrices;
        const srcC = b.colors;
        const dst = b.mesh.instanceMatrix.array as Float32Array;
        const dstC = b.mesh.instanceColor!.array as Float32Array;
        const start = b.chunkStart[ci];
        let out = b.visible;

        if (far2 <= d2 && far2 <= LOD_FULL_DIST2) {
          // Whole chunk within draw radius AND inside the full-density ring: bulk copy slice
          const s16 = start * 16;
          const e16 = (start + take) * 16;
          let o16 = out * 16;
          for (let j = s16; j < e16; j++) dst[o16++] = src[j]!;

          const s3 = start * 3;
          const e3 = (start + take) * 3;
          let o3 = out * 3;
          for (let j = s3; j < e3; j++) dstC[o3++] = srcC[j]!;

          out += take;
        } else {
          // Boundary / mid-distance chunk: per-instance radius test + distance LOD.
          // Instances inside a chunk are a shuffled uniform sample, so "rank < fraction(distance)"
          // thins the meadow smoothly with distance (dense around the player, sparse far away)
          // without popping whole chunks.
          const invN = 1 / n;
          for (let i = start; i < start + take; i++) {
            const m = i * 16;
            const ix = src[m + 12]! - cx;
            const iz = src[m + 14]! - cz;
            const id2 = ix * ix + iz * iz;
            if (id2 > d2) continue;
            if (id2 > LOD_FULL_DIST2) {
              const rank = (i - start) * invN;
              const dist = Math.sqrt(id2);
              let frac = 1 - (dist - LOD_FULL_DIST) * LOD_FALLOFF_INV;
              if (frac < LOD_FAR_FRACTION) frac = LOD_FAR_FRACTION;
              if (rank >= frac) continue;
            }

            let o16 = out * 16;
            for (let j = m; j < m + 16; j++) dst[o16++] = src[j]!;

            const c3 = i * 3;
            const o3 = out * 3;
            dstC[o3] = srcC[c3]!;
            dstC[o3 + 1] = srcC[c3 + 1]!;
            dstC[o3 + 2] = srcC[c3 + 2]!;

            out++;
          }
        }

        if (out !== b.visible) anyInChunk = true;
        b.visible = out;
      }

      if (anyInChunk) visibleChunks++;
    }

    for (const b of batches) {
      b.mesh.count = b.visible;
      if (b.visible > 0) {
        const im = b.mesh.instanceMatrix;
        im.clearUpdateRanges();
        im.addUpdateRange(0, b.visible * 16);
        im.needsUpdate = true;
        const ic = b.mesh.instanceColor!;
        ic.clearUpdateRanges();
        ic.addUpdateRange(0, b.visible * 3);
        ic.needsUpdate = true;
        uploads++;
      }
    }

    dirty = false;
    lastUpdateMs = performance.now() - t1;
  };

  const setQuality = (q: QualityLevel): void => {
    currentQuality = q;
    applyPreset();
    dirty = true;
  };

  const getStats = (): GroundCoverStats => {
    let visibleGrass = 0;
    let visibleFlowers = 0;
    let visibleFerns = 0;
    let drawCalls = 0;
    let gpuBytes = 0;
    let visibleTriangles = 0;
    let activeGLBVariantCount = 0;
    let activeFallbackVariantCount = 0;

    for (const b of batches) {
      gpuBytes += b.gpuBytes;
      if (b.isFallback) {
        activeFallbackVariantCount++;
      } else {
        activeGLBVariantCount++;
      }
      if (group.visible) visibleTriangles += b.visible * b.tris;
      if (group.visible && b.visible > 0) drawCalls++;
      if (b.category === 'grass') visibleGrass += b.visible;
      else if (b.category === 'flower') visibleFlowers += b.visible;
      else visibleFerns += b.visible;
    }

    return {
      visibleGrass,
      visibleFlowers,
      visibleFerns,
      visibleChunks,
      totalInstances: field.total,
      drawCalls,
      visibleTriangles,
      quality: currentQuality,
      gpuBytes,
      uploads,
      lastUpdateMs: Number(lastUpdateMs.toFixed(4)),
      buildMs: Number(buildMs.toFixed(2)),
      activeGLBVariantCount,
      activeFallbackVariantCount,
      isAllLoaded: activeFallbackVariantCount === 0 && activeGLBVariantCount === batches.length,
    };
  };

  const dispose = (): void => {
    unsubscribeAssets();
    group.parent?.remove(group);
    for (const b of batches) {
      b.mesh.dispose();
      // Geometries and materials are shared via GrassAssetRegistry, so they are not disposed here
    }
    batches.length = 0;
  };

  const buildMs = performance.now() - t0;
  if (import.meta.env?.DEV) {
    console.info(
      `[GrassRenderer] built ${field.total} instances across ${nChunks} chunks, ${batches.length} GLB batches in ${buildMs.toFixed(1)} ms`,
    );
  }

  return { group, update, setQuality, getStats, dispose };
}
