import * as THREE from 'three';
import {
  GROUND_COVER_KINDS,
  GROUND_COVER_STRIDE,
  type GroundCoverField,
  type GroundCoverKind,
} from '../../shared/groundCover';
import type { QualityLevel } from '../settings';
import { createGrassRenderer } from './grass/GrassRenderer';

/**
 * STAGE 08-FIX — Visual-only ground cover renderer (grass tufts, short grass, small ferns, wildflowers).
 *
 * - One `THREE.InstancedMesh` per kind (6 draw calls max), ultra-low-poly stylized geometry with vertex colors.
 * - Per-instance matrices/colors are precomputed ONCE at build time into contiguous Float32Arrays grouped by
 *   chunk (instances inside a chunk are pre-shuffled by `buildGroundCoverField`, so any prefix is a uniform
 *   subsample → density presets copy a contiguous per-chunk prefix).
 * - CPU culling only when the camera moved > 0.75 m, rotated > ~2°, the projection changed, or quality changed:
 *   chunk AABB vs frustum + XZ distance per kind class; fully-inside chunks are bulk-copied, boundary chunks are
 *   tested per instance (circular draw edge instead of blocky chunk edges).
 * - GPU: tiny vertex-shader hook (`onBeforeCompile`) that shrinks instances over the last 15% of the draw
 *   distance (hides pop-in) and adds a cheap wind sway (amplitude 0 on `low`).
 * - Zero per-frame allocations. No shadow casting. `receiveShadow` only on `high`.
 * - Purely cosmetic: no colliders, not in `world.visuals`, not part of gameplayHash, never on server.
 *
 * GPU memory estimate per kind (bytes):
 *   geometry = vertexCount × 36 (position + normal + color, float32×3 each)
 *   instances = capacity × (64 matrix + 12 color) = capacity × 76
 * e.g. ~14k instances total ≈ 1.06 MB instance data + < 4 KB geometry. Exact values in `getStats().gpuBytes`.
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

type KindClass = 'grass' | 'flower' | 'fern';

interface QualityPreset {
  density: number;
  grassDist: number;
  flowerDist: number;
  fernDist: number;
  wind: number;
  receiveShadow: boolean;
}

/** Quality presets — must look clearly different (Contract 4). */
export const GROUND_COVER_QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  high: { density: 1.0, grassDist: 75, flowerDist: 65, fernDist: 80, wind: 1.0, receiveShadow: true },
  medium: { density: 0.65, grassDist: 55, flowerDist: 48, fernDist: 60, wind: 0.7, receiveShadow: false },
  low: { density: 0.35, grassDist: 35, flowerDist: 30, fernDist: 40, wind: 0, receiveShadow: false },
};

/** Base (scale 1) model heights in metres; used to clamp instance scale to PvP-fair height limits. */
const KIND_BASE_HEIGHT: Record<GroundCoverKind, number> = {
  grass_tuft: 0.32,
  grass_short: 0.2,
  fern_small: 0.45,
  flower_white: 0.26,
  flower_yellow: 0.26,
  flower_purple: 0.26,
};
/** Contract 3 PvP height limits (grass ≤0.45, flowers ≤0.35, fern_small ≤0.6). */
const KIND_HEIGHT_LIMIT: Record<GroundCoverKind, number> = {
  grass_tuft: 0.45,
  grass_short: 0.45,
  fern_small: 0.6,
  flower_white: 0.35,
  flower_yellow: 0.35,
  flower_purple: 0.35,
};

function kindClassOf(kind: GroundCoverKind): KindClass {
  if (kind === 'fern_small') return 'fern';
  if (kind === 'grass_tuft' || kind === 'grass_short') return 'grass';
  return 'flower';
}

function presetDist(p: QualityPreset, cls: KindClass): number {
  return cls === 'grass' ? p.grassDist : cls === 'flower' ? p.flowerDist : p.fernDist;
}

// ---------------------------------------------------------------------------------------------
// Geometry builders (non-indexed: position + normal + color)
// ---------------------------------------------------------------------------------------------

class TriBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];

  /**
   * Adds one triangle. `upBias` blends the face normal towards +Y (classic stylized-grass lighting trick so
   * both sides of thin blades read bright and soft instead of flickering dark/light).
   */
  tri(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    ca: THREE.Color,
    cb: THREE.Color,
    cc: THREE.Color,
    upBias = 1.0,
  ): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    let len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    // Blades are double-sided: orient the face normal to the upper hemisphere before biasing.
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    nx *= 0.45;
    ny = ny * 0.45 + upBias;
    nz *= 0.45;
    len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const [p, c2] of [
      [a, ca],
      [b, cb],
      [c, cc],
    ] as Array<[[number, number, number], THREE.Color]>) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
      this.col.push(c2.r, c2.g, c2.b);
    }
  }

  /** Tapered quad (2 tris) from base center (bx,bz) leaning to (tx,tz) at height h, oriented along angle `a`. */
  blade(
    a: number,
    baseW: number,
    topW: number,
    h: number,
    lean: number,
    root: THREE.Color,
    tip: THREE.Color,
    offset = 0,
  ): void {
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // blade plane spans direction (ca, sa); leans along its normal (-sa, ca)
    const ox = -sa * offset;
    const oz = ca * offset;
    const lx = -sa * lean;
    const lz = ca * lean;
    const b0: [number, number, number] = [ox - ca * baseW * 0.5, 0, oz - sa * baseW * 0.5];
    const b1: [number, number, number] = [ox + ca * baseW * 0.5, 0, oz + sa * baseW * 0.5];
    const t0: [number, number, number] = [ox + lx - ca * topW * 0.5, h, oz + lz - sa * topW * 0.5];
    const t1: [number, number, number] = [ox + lx + ca * topW * 0.5, h, oz + lz + sa * topW * 0.5];
    this.tri(b0, b1, t1, root, root, tip);
    this.tri(b0, t1, t0, root, tip, tip);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const C = (hex: string) => new THREE.Color(hex);

/**
 * grass_tuft: clump of 5 tapered blades (10 tris), ~0.32 m tallest, footprint ~1.4× a single tuft
 * (blades offset around the center and leaning outward with slight height/lean variation).
 */
function buildGrassTuftGeometry(): THREE.BufferGeometry {
  const tb = new TriBuilder();
  const root = C('#2f5323');
  const tips = [C('#7aa043'), C('#86ab4a'), C('#6f9a3c'), C('#7fa546'), C('#739d3f')];
  // [plane angle, offset along blade normal, height, outward lean]
  const blades: Array<[number, number, number, number]> = [
    [0.2, 0.065, 0.32, 0.055],
    [1.45, -0.055, 0.27, -0.045],
    [2.6, 0.075, 0.3, 0.05],
    [3.9, -0.05, 0.25, -0.06],
    [5.1, 0.03, 0.29, 0.035],
  ];
  for (let i = 0; i < blades.length; i++) {
    const [a, off, h, lean] = blades[i];
    tb.blade(a, 0.08, 0.012, h, lean, root, tips[i], off);
  }
  return tb.build();
}

/** grass_short: 4 wide fanned single-triangle blades (4 tris), ~0.2 m, slightly drier/lighter palette. */
function buildGrassShortGeometry(): THREE.BufferGeometry {
  const tb = new TriBuilder();
  const root = C('#3b5f26');
  const tip = C('#97b457');
  const tip2 = C('#88aa4c');
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.35;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const w = 0.06;
    const out = 0.09; // tip leans outward
    const h = i % 2 === 0 ? 0.2 : 0.16;
    // base edge perpendicular to the outward direction
    tb.tri(
      [-sa * w, 0, ca * w],
      [sa * w, 0, -ca * w],
      [ca * out, h, sa * out],
      root,
      root,
      i % 2 === 0 ? tip : tip2,
    );
  }
  return tb.build();
}

/** fern_small: 5 arching diamond fronds (10 tris), ~0.45 m peak. */
function buildFernSmallGeometry(): THREE.BufferGeometry {
  const tb = new TriBuilder();
  const base = C('#22451c');
  const mid = C('#3f7a2e');
  const tip = C('#6a9e3f');
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + (i % 2) * 0.18;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const midR = 0.17;
    const tipR = 0.36 - (i % 2) * 0.04;
    const midH = 0.43 - (i % 3) * 0.04;
    const tipH = 0.24 - (i % 2) * 0.04;
    const w = 0.085;
    const b: [number, number, number] = [ca * 0.02, 0.01, sa * 0.02];
    const l: [number, number, number] = [ca * midR - sa * w, midH, sa * midR + ca * w];
    const r: [number, number, number] = [ca * midR + sa * w, midH - 0.03, sa * midR - ca * w];
    const t: [number, number, number] = [ca * tipR, tipH, sa * tipR];
    tb.tri(b, l, r, base, mid, mid, 0.8);
    tb.tri(l, t, r, mid, tip, mid, 0.8);
  }
  return tb.build();
}

/** Flower: thin stem (2 tris) + 2 leaf tris + 5-petal tilted head (5 tris) = 9 tris, ~0.26 m. */
function buildFlowerGeometry(petalHex: string, centerHex: string): THREE.BufferGeometry {
  const tb = new TriBuilder();
  const stemRoot = C('#2e5222');
  const stemTop = C('#4d7a30');
  const leaf = C('#5b8a36');
  const petal = C(petalHex);
  const petalInner = C(petalHex).lerp(C(centerHex), 0.55);
  const center = C(centerHex);

  const headY = 0.218; // petal tips top out at ~0.26 m (base height) at scale 1
  // Stem (one thin quad, double-sided)
  tb.blade(0.4, 0.016, 0.01, headY, 0.02, stemRoot, stemTop);
  // Two small leaves near the base
  tb.tri([0, 0.02, 0], [0.09, 0.09, 0.02], [0.03, 0.1, -0.015], stemRoot, leaf, leaf, 0.9);
  tb.tri([0, 0.03, 0], [-0.08, 0.11, -0.02], [-0.02, 0.12, 0.02], stemRoot, leaf, leaf, 0.9);

  // Head: 5 petals around a center, tilted ~30° so it reads from player eye height
  const tilt = 0.52;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const hx = 0.02; // head offset (stem top lean)
  const headPt = (r: number, ang: number): [number, number, number] => {
    const px = Math.cos(ang) * r;
    const pz = Math.sin(ang) * r;
    // rotate about X by tilt
    const y = -pz * st;
    const z = pz * ct;
    return [hx + px, headY + 0.012 + y, z];
  };
  const c0: [number, number, number] = [hx, headY + 0.018, 0];
  const R = 0.058;
  const half = 0.36; // petal half angular width (gaps between petals)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    tb.tri(c0, headPt(R, a - half), headPt(R, a + half), center, petalInner, petal, 1.0);
  }
  return tb.build();
}

// ---------------------------------------------------------------------------------------------
// Shader hook (fade + wind)
// ---------------------------------------------------------------------------------------------

interface SharedUniforms {
  uGcTime: { value: number };
  uGcWind: { value: number };
  uGcCam: { value: THREE.Vector3 };
}

function installGroundCoverShaderHook(
  material: THREE.MeshLambertMaterial,
  shared: SharedUniforms,
  far: { value: number },
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGcTime = shared.uGcTime;
    shader.uniforms.uGcWind = shared.uGcWind;
    shader.uniforms.uGcCam = shared.uGcCam;
    shader.uniforms.uGcFar = far;
    shader.vertexShader =
      'uniform float uGcTime;\nuniform float uGcWind;\nuniform float uGcFar;\nuniform vec3 uGcCam;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 gcOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#else
  vec3 gcOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#endif
  float gcH = max(position.y, 0.0);
  float gcW = sin(uGcTime * 1.5 + gcOrigin.x * 0.31 + gcOrigin.z * 0.23) * 0.65
            + sin(uGcTime * 2.6 + gcOrigin.x * 0.83 - gcOrigin.z * 0.57) * 0.25;
  transformed.x += gcW * uGcWind * gcH * 0.22;
  transformed.z += gcW * uGcWind * gcH * 0.12;
  float gcDist = distance(gcOrigin.xz, uGcCam.xz);
  float rawFade = clamp((uGcFar - gcDist) / max(0.15 * uGcFar, 0.001), 0.0, 1.0);
  float gcFade = rawFade * rawFade * (3.0 - 2.0 * rawFade);
  transformed *= gcFade;`,
      );
    // Double-sided thin blades: keep the (up-biased) normal for both faces so back faces aren't dark.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'),
    );
  };
}

// ---------------------------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------------------------

interface KindBatch {
  kind: GroundCoverKind;
  cls: KindClass;
  mesh: THREE.InstancedMesh;
  material: THREE.MeshLambertMaterial;
  geometry: THREE.BufferGeometry;
  far: { value: number };
  /** All instance matrices of this kind, grouped contiguous by chunk (16 floats each). */
  matrices: Float32Array;
  /** All instance colors of this kind, same order (3 floats each). */
  colors: Float32Array;
  /** Per chunk index: first instance index and instance count for this kind. */
  chunkStart: Int32Array;
  chunkCount: Int32Array;
  capacity: number;
  visible: number;
  gpuBytes: number;
  tris: number;
}

const noopRaycast = () => {};

function hash01(x: number, z: number, salt: number): number {
  let h = Math.imul(Math.floor(x * 97.13) ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(Math.floor(z * 61.7) + salt, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

export function createProceduralGroundCoverRenderer(
  field: GroundCoverField,
  quality: QualityLevel,
): GroundCoverRendererHandle {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'ground_cover';

  const shared: SharedUniforms = {
    uGcTime: { value: 0 },
    uGcWind: { value: 0 },
    uGcCam: { value: new THREE.Vector3() },
  };

  const chunks = field.chunks;
  const nChunks = chunks.length;

  // Chunk AABBs for frustum tests (padded so slight sub-threshold rotations don't pop edge chunks).
  const chunkBoxes: THREE.Box3[] = chunks.map(
    (c) =>
      new THREE.Box3(
        new THREE.Vector3(c.minX - 1.5, c.minY - 0.25, c.minZ - 1.5),
        new THREE.Vector3(c.maxX + 1.5, c.maxY + 0.75, c.maxZ + 1.5),
      ),
  );

  const geoFactories: Record<GroundCoverKind, () => THREE.BufferGeometry> = {
    grass_tuft: buildGrassTuftGeometry,
    grass_short: buildGrassShortGeometry,
    fern_small: buildFernSmallGeometry,
    flower_white: () => buildFlowerGeometry('#f4f1e6', '#e8c547'),
    flower_yellow: () => buildFlowerGeometry('#f2c73a', '#b5651d'),
    flower_purple: () => buildFlowerGeometry('#9a6bd1', '#f0d76a'),
  };

  const batches: KindBatch[] = [];
  const updateMeshTime = () => {
    shared.uGcTime.value = performance.now() * 0.001;
  };
  const camWorld = new THREE.Vector3();

  for (let k = 0; k < GROUND_COVER_KINDS.length; k++) {
    const kind = GROUND_COVER_KINDS[k];
    // Count instances of this kind
    let total = 0;
    for (const c of chunks) {
      const arr = c.batches[kind];
      if (arr) total += Math.floor(arr.length / GROUND_COVER_STRIDE);
    }
    if (total === 0) continue;

    const matrices = new Float32Array(total * 16);
    const colors = new Float32Array(total * 3);
    const chunkStart = new Int32Array(nChunks);
    const chunkCount = new Int32Array(nChunks);
    const maxScale = KIND_HEIGHT_LIMIT[kind] / KIND_BASE_HEIGHT[kind];
    const isFlower = kindClassOf(kind) === 'flower';

    let idx = 0;
    for (let ci = 0; ci < nChunks; ci++) {
      chunkStart[ci] = idx;
      const arr = chunks[ci].batches[kind];
      if (!arr) continue;
      const n = Math.floor(arr.length / GROUND_COVER_STRIDE);
      for (let i = 0; i < n; i++) {
        const o = i * GROUND_COVER_STRIDE;
        const x = arr[o];
        const y = arr[o + 1] - 0.015; // sink slightly so bases never float on slopes
        const z = arr[o + 2];
        const yaw = arr[o + 3];
        const s = Math.min(arr[o + 4], maxScale);
        const cs = Math.cos(yaw) * s;
        const sn = Math.sin(yaw) * s;
        const m = idx * 16;
        // column-major makeRotationY(yaw) * scale(s), translation (x,y,z)
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
        // Slight per-instance tint variation (brightness + subtle warm/cool shift)
        const h1 = hash01(x, z, k * 7 + 1);
        const h2 = hash01(z, x, k * 13 + 5);
        const bright = isFlower ? 0.92 + h1 * 0.14 : 0.84 + h1 * 0.26;
        const warm = isFlower ? 0 : (h2 - 0.5) * 0.12;
        const c3 = idx * 3;
        colors[c3] = bright * (1 + warm);
        colors[c3 + 1] = bright;
        colors[c3 + 2] = bright * (1 - warm * 0.6);
        idx++;
      }
      chunkCount[ci] = n;
    }

    const geometry = geoFactories[kind]();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    material.name = `ground_cover_${kind}`;
    const far = { value: 50 };
    installGroundCoverShaderHook(material, shared, far);

    const mesh = new THREE.InstancedMesh(geometry, material, total);
    mesh.name = `inst_ground_cover:${kind}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // culled per chunk on the CPU
    mesh.matrixAutoUpdate = false;
    mesh.raycast = noopRaycast;
    mesh.onBeforeRender = (_r, _s, camera) => {
      camWorld.setFromMatrixPosition(camera.matrixWorld);
      shared.uGcCam.value.copy(camWorld);
      updateMeshTime();
    };
    group.add(mesh);

    const vtx = geometry.getAttribute('position').count;
    batches.push({
      kind,
      cls: kindClassOf(kind),
      mesh,
      material,
      geometry,
      far,
      matrices,
      colors,
      chunkStart,
      chunkCount,
      capacity: total,
      visible: 0,
      gpuBytes: vtx * 36 + total * 76,
      tris: vtx / 3,
    });
  }

  let currentQuality: QualityLevel = quality;
  let preset = GROUND_COVER_QUALITY_PRESETS[currentQuality];
  let dirty = true;
  let lastTopDown = false;
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

  const applyPresetToMaterials = () => {
    preset = GROUND_COVER_QUALITY_PRESETS[currentQuality];
    shared.uGcWind.value = preset.wind;
    for (const b of batches) {
      b.far.value = presetDist(preset, b.cls);
      b.mesh.receiveShadow = preset.receiveShadow;
    }
  };
  applyPresetToMaterials();

  const setAllCounts = (n: number) => {
    for (const b of batches) {
      if (b.mesh.count !== n) {
        b.mesh.count = n;
      }
      b.visible = n;
    }
  };

  const update = (camera: THREE.Camera, frustum: THREE.Frustum, isTopDown: boolean): void => {
    const camPos = camera.position;
    const q = camera.quaternion;
    const pe = camera.projectionMatrix.elements;

    if (isTopDown) {
      // Overview camera: ground cover is invisible at that altitude anyway → render nothing (0 draw calls).
      // (`lastTopDown` forces a fresh pass when returning to the gameplay camera.)
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
    const moved = !(dx * dx + dy * dy + dz * dz <= 0.5625); // > 0.75 m (also true for NaN)
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
    // CPU distance slightly beyond the shader fade end so instances never pop while the camera moves < 0.75 m.
    const grassD = preset.grassDist + 1.5;
    const flowerD = preset.flowerDist + 1.5;
    const fernD = preset.fernDist + 1.5;
    const maxD = Math.max(grassD, flowerD, fernD);
    const maxD2 = maxD * maxD;

    for (const b of batches) b.visible = 0;
    visibleChunks = 0;

    for (let ci = 0; ci < nChunks; ci++) {
      const c = chunks[ci];
      // nearest / farthest XZ distance² from camera to chunk rect
      const ndx = c.minX - cx > 0 ? c.minX - cx : cx - c.maxX > 0 ? cx - c.maxX : 0;
      const ndz = c.minZ - cz > 0 ? c.minZ - cz : cz - c.maxZ > 0 ? cz - c.maxZ : 0;
      const near2 = ndx * ndx + ndz * ndz;
      if (near2 > maxD2) continue;
      if (!frustum.intersectsBox(chunkBoxes[ci])) continue;
      const fdx = Math.max(Math.abs(cx - c.minX), Math.abs(cx - c.maxX));
      const fdz = Math.max(Math.abs(cz - c.minZ), Math.abs(cz - c.maxZ));
      const far2 = fdx * fdx + fdz * fdz;

      let any = false;
      for (let bi = 0; bi < batches.length; bi++) {
        const b = batches[bi];
        const n = b.chunkCount[ci];
        if (n === 0) continue;
        const d = b.cls === 'grass' ? grassD : b.cls === 'flower' ? flowerD : fernD;
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

        if (far2 <= d2) {
          // Whole chunk inside the draw radius → bulk copy prefix
          const s16 = start * 16;
          const e16 = (start + take) * 16;
          let o16 = out * 16;
          for (let j = s16; j < e16; j++) dst[o16++] = src[j];
          const s3 = start * 3;
          const e3 = (start + take) * 3;
          let o3 = out * 3;
          for (let j = s3; j < e3; j++) dstC[o3++] = srcC[j];
          out += take;
        } else {
          for (let i = start; i < start + take; i++) {
            const m = i * 16;
            const ix = src[m + 12] - cx;
            const iz = src[m + 14] - cz;
            if (ix * ix + iz * iz > d2) continue;
            let o16 = out * 16;
            for (let j = m; j < m + 16; j++) dst[o16++] = src[j];
            const c3 = i * 3;
            const o3 = out * 3;
            dstC[o3] = srcC[c3];
            dstC[o3 + 1] = srcC[c3 + 1];
            dstC[o3 + 2] = srcC[c3 + 2];
            out++;
          }
        }
        if (out !== b.visible) any = true;
        b.visible = out;
      }
      if (any) visibleChunks++;
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
    applyPresetToMaterials();
    dirty = true;
  };

  const getStats = (): GroundCoverStats => {
    let visibleGrass = 0;
    let visibleFlowers = 0;
    let visibleFerns = 0;
    let drawCalls = 0;
    let gpuBytes = 0;
    let visibleTriangles = 0;
    for (const b of batches) {
      gpuBytes += b.gpuBytes;
      if (group.visible) visibleTriangles += b.visible * b.tris;
      if (group.visible && b.visible > 0) drawCalls++;
      if (b.cls === 'grass') visibleGrass += b.visible;
      else if (b.cls === 'flower') visibleFlowers += b.visible;
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
      activeGLBVariantCount: 0,
      activeFallbackVariantCount: batches.length,
      isAllLoaded: false,
    };
  };

  const dispose = (): void => {
    group.parent?.remove(group);
    for (const b of batches) {
      b.mesh.dispose();
      b.geometry.dispose();
      b.material.dispose();
    }
    batches.length = 0;
  };

  const buildMs = performance.now() - t0;
  if (import.meta.env?.DEV) {
    const perKind = batches
      .map((b) => `${b.kind}=${b.capacity} (${(b.gpuBytes / 1024).toFixed(1)} KB, ${b.tris} tris)`)
      .join(', ');
    console.info(
      `[GroundCover] built ${field.total} instances in ${nChunks} chunks, ${batches.length} meshes, ${buildMs.toFixed(1)} ms — ${perKind}`,
    );
  }

  return { group, update, setQuality, getStats, dispose };
}

/**
 * Re-export GLB grass lifecycle & diagnostics API from GrassAssetRegistry
 * for unified consumer access.
 */
export {
  onGrassAssetsReady,
  getGrassAssetDiagnostics,
  type GrassAssetDiagnostics,
} from './grass/GrassAssetRegistry';

/**
 * STAGE 08-TERRAIN-VISUAL entry point:
 * Builds the 17-variant GLB vegetation renderer, falling back safely to the procedural
 * renderer if GLB assets fail or if running in an environment without model assets.
 */
export function createGroundCoverRenderer(
  field: GroundCoverField,
  quality: QualityLevel,
  seed = 6501,
): GroundCoverRendererHandle {
  try {
    return createGrassRenderer(field, quality, seed);
  } catch (err) {
    console.warn('[GroundCover] Failed to initialize GLB grass renderer, using procedural fallback:', err);
    return createProceduralGroundCoverRenderer(field, quality);
  }
}

