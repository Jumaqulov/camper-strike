import type { Team } from './constants';
import {
  buildForestAssetsPreviewTerrain,
  buildForestCabinPlacement,
  buildForestSampleTerrain,
  createForestAssetsPreviewWorld,
  createForestSampleWorld,
  FOREST_SAMPLE_HALF,
  FOREST_SAMPLE_SIZE,
  sampleForestRoad,
  sampleForestTerrainColor,
  TREE_SPECIES_BATCH_KEYS,
  type ForestRoadSample,
  type TreeSpeciesBatchKey,
} from './forestSample';
import {
  buildForestSquarePOILayout,
  buildForestSquareSpawns,
  buildForestSquareTerrain,
  buildForestSquareVegetation,
  createForestSquareWorld,
  FOREST_SQUARE_HALF,
  FOREST_SQUARE_SIZE,
  getForestSquarePoiSites,
  getForestSquareRoadNetwork,
  getPoiBuildingFootprints,
  sampleForestSquareRoad,
  sampleForestSquareTerrainColor,
  type ForestSquarePOILayoutOptions,
  type ForestSquarePoiSiteSpec,
  type ForestSquareRoadPolyline,
  type ForestSquareRoadSample,
  type ForestSquareVegetationResult,
  type ForestSquareWorldDefinition,
  type MultiSiteStructureLayout,
} from './forestSquare';
import { q3, type Vec3 } from './math';
import { isOutdoorYawAxisAligned } from './outdoor/outdoorColliders';
import type { Stage04APreviewLayout } from './structures/contracts';
import {
  buildTechnicalHeightfield,
  buildTerrainMeshData,
  createGroundedRockCollider,
  createGroundedTreeCollider,
  DEFAULT_MAX_WALKABLE_SLOPE_DEG,
  getGroundedPosition,
  isTerrainWalkable,
  raycastTerrain,
  sampleHeightfieldTriangle,
  sampleTerrainHeight,
  type TerrainMeshData,
  type TerrainTriangleSample,
} from './terrain';

export {
  buildForestAssetsPreviewTerrain,
  buildForestCabinPlacement,
  buildForestSampleTerrain,
  buildForestSquarePOILayout,
  buildForestSquareSpawns,
  buildForestSquareTerrain,
  buildForestSquareVegetation,
  buildTechnicalHeightfield,
  buildTerrainMeshData,
  createForestAssetsPreviewWorld,
  createForestSampleWorld,
  createForestSquareWorld,
  createGroundedRockCollider,
  createGroundedTreeCollider,
  DEFAULT_MAX_WALKABLE_SLOPE_DEG,
  FOREST_SAMPLE_HALF,
  FOREST_SAMPLE_SIZE,
  FOREST_SQUARE_HALF,
  FOREST_SQUARE_SIZE,
  getForestSquarePoiSites,
  getForestSquareRoadNetwork,
  getGroundedPosition,
  getPoiBuildingFootprints,
  isTerrainWalkable,
  raycastTerrain,
  sampleForestRoad,
  sampleForestSquareRoad,
  sampleForestSquareTerrainColor,
  sampleForestTerrainColor,
  sampleHeightfieldTriangle,
  TREE_SPECIES_BATCH_KEYS,
  type ForestRoadSample,
  type ForestSquarePOILayoutOptions,
  type ForestSquarePoiSiteSpec,
  type ForestSquareRoadPolyline,
  type ForestSquareRoadSample,
  type ForestSquareVegetationResult,
  type ForestSquareWorldDefinition,
  type MultiSiteStructureLayout,
  type Stage04APreviewLayout,
  type TerrainMeshData,
  type TerrainTriangleSample,
  type TreeSpeciesBatchKey,
};

export type MapId =
  | 'forest_technical'
  | 'forest_sample'
  | 'forest_assets_preview'
  | 'forest_square';

export const CURRENT_WORLD_VERSION = 2;
export const DEFAULT_PUBLIC_LAYOUT_SEED = 6501;
export const DEFAULT_CHUNK_SIZE = 32;

export interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Kollayder/vizual material turi (tekstura va UV masshtabi shu kalit bo'yicha tanlanadi). */
export type MaterialKind = 'ground' | 'wall' | 'concrete' | 'crate' | 'metal' | 'roof';

/** Eng sodda o'qlarga tekislangan to'qnashuv qutisi (AABB). */
export interface Box {
  min: Vec3;
  max: Vec3;
  mat: MaterialKind;
}

export interface SpawnPoint {
  x: number;
  z: number;
  yaw: number;
  team: Team;
}

export interface HeightfieldTerrainDescriptor {
  kind: 'heightfield';
  width: number;
  depth: number;
  cellSize: number;
  originX: number;
  originZ: number;
  /** Row-major (z * cols + x) height samples in meters. */
  cols: number;
  rows: number;
  heights: number[];
}

/** Barcha xaritalar heightfield relyefga ega (tekis 'flat' relyef eski Dust Arena bilan birga olib tashlangan). */
export type TerrainDescriptor = HeightfieldTerrainDescriptor;

export type ColliderTag = 'ground' | 'structure' | 'prop' | 'tree' | 'rock' | 'boundary';

/**
 * O'q/ko'rinish (raycast) uchun aniq shakl. Harakat fizikasi hamon AABB (`min`/`max`) bilan ishlaydi,
 * lekin o'q trayektoriyasi vizual shaklga mos keladi: dumaloq daraxt tanasi, yumaloq tosh, burilgan devor,
 * uchburchak tom old devori. Shakl doim AABB ichida bo'lishi shart (keng faza AABB bo'yicha); gable prizmasi
 * GLB uchburchagidan olingani uchun qutidan chiqib turadi — `rayCollider` uni AABB ning y oralig'i bilan kesadi.
 * gameplayHash ga kiradi (`hitShapeCanonical`): klient/server shakllari farq qilsa, ulanish tekshiruvi buni ushlaydi.
 */
export type ColliderHitShape =
  | { kind: 'cylinder'; cx: number; cz: number; r: number }
  | { kind: 'ellipsoid'; cx: number; cy: number; cz: number; rx: number; ry: number; rz: number }
  | { kind: 'obb'; cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; yaw: number }
  | {
      kind: 'gable';
      cx: number;
      cz: number;
      /** Uchburchak asosi yarim kengligi (lokal X) va asos/uch balandliklari (dunyo Y). */
      hx: number;
      baseY: number;
      apexY: number;
      /** Qalinlik yarmi (lokal Z) va burilish. */
      hz: number;
      yaw: number;
    };

export interface ColliderBox extends Box {
  id: string;
  tag: ColliderTag;
  sourceObjectId?: string;
  hit?: ColliderHitShape;
}

export interface SpawnPointDef extends SpawnPoint {
  id: string;
  y: number;
}

export type LocationKind =
  | 'arena_center'
  | 'ranger_house'
  | 'cabin_cluster'
  | 'lumber_mill'
  | 'service_station'
  | 'camp'
  | 'stone_ruins'
  | 'clearing';

export interface WorldLocation {
  id: string;
  name: string;
  kind: LocationKind;
  position: Vec3;
  yaw: number;
  radius: number;
  enterable: boolean;
}

export type ContainerKind = 'supply_crate' | 'weapon_locker' | 'ammo_box' | 'camp_chest';

/**
 * Public container placement descriptor.
 * Does NOT contain loot contents or secret server loot seeds.
 */
export interface ContainerLocation {
  id: string;
  locationId: string;
  kind: ContainerKind;
  position: Vec3;
  yaw: number;
  interactionRadius: number;
}

export interface PlacementTransform {
  position: Vec3;
  yaw: number;
  scale: Vec3;
}

export interface ChunkCoord {
  cx: number;
  cz: number;
  key: string;
}

export type RenderBatchMode = 'static_box' | 'instanced' | 'prefab_group';
export type LodTier = 'near' | 'mid' | 'far' | 'all';
export type VisualCategory = 'ground' | 'structure' | 'tree' | 'rock' | 'foliage' | 'prop';

export interface VisualDescriptor {
  id: string;
  sourceObjectId: string;
  prefabId: string;
  category: VisualCategory;
  /** Grouping key for InstancedMesh / geometry batching (e.g. 'tree:pine_tall'). */
  batchKey: string;
  batchMode: RenderBatchMode;
  chunkKey: string;
  lod: LodTier;
  maxDrawDistance: number;
  transform: PlacementTransform;
  boxDims?: Vec3;
  material?: MaterialKind;
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface WorldMeta {
  mapId: MapId;
  worldVersion: number;
  publicLayoutSeed: number;
  gameplayHash: string;
}

export interface WorldDefinition extends WorldMeta {
  name: string;
  chunkSize: number;
  bounds: WorldBounds;
  terrain: TerrainDescriptor;
  colliders: ColliderBox[];
  visuals: VisualDescriptor[];
  spawnPoints: SpawnPointDef[];
  locations: WorldLocation[];
  containerLocations: ContainerLocation[];
  stage04aLayout?: Stage04APreviewLayout;
}

export interface CreateWorldOpts {
  mapId?: MapId;
  worldVersion?: number;
  publicLayoutSeed?: number;
  chunkSize?: number;
}

// ---------------- Deterministic PRNG & Hashing ----------------

/** Mulberry32 PRNG — amalga oshirish `math.ts` da; eski `./world` import yo'li saqlangan. */
export { createSeededRng } from './math';

/**
 * Pure TypeScript 64-bit FNV-1a hash (two 32-bit halves) for canonical strings.
 * No Node/DOM/Three.js dependencies.
 */
export function hashCanonicalString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c ^ (i & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${hex1}${hex2}`;
}

/** Hit-shaklning kanonik satri (q3 yaxlitlangan) — `computeGameplayHash` uchun. */
function hitShapeCanonical(h: ColliderHitShape): string {
  switch (h.kind) {
    case 'cylinder':
      return `cyl:${q3(h.cx)},${q3(h.cz)},${q3(h.r)}`;
    case 'ellipsoid':
      return `ell:${q3(h.cx)},${q3(h.cy)},${q3(h.cz)},${q3(h.rx)},${q3(h.ry)},${q3(h.rz)}`;
    case 'obb':
      return `obb:${q3(h.cx)},${q3(h.cy)},${q3(h.cz)},${q3(h.hx)},${q3(h.hy)},${q3(h.hz)},${q3(h.yaw)}`;
    case 'gable':
      return `gab:${q3(h.cx)},${q3(h.cz)},${q3(h.hx)},${q3(h.baseY)},${q3(h.apexY)},${q3(h.hz)},${q3(h.yaw)}`;
  }
}

/**
 * Computes the canonical gameplay hash from gameplay-affecting fields ONLY.
 * Explicitly ignores `visuals` (render descriptors, LODs, shadows) and any secret server loot seed.
 */
export function computeGameplayHash(
  data: Omit<WorldDefinition, 'gameplayHash' | 'visuals' | 'name' | 'chunkSize'>,
): string {
  const parts: string[] = [];
  parts.push(`map:${data.mapId}|v:${data.worldVersion}|seed:${data.publicLayoutSeed}`);
  const b = data.bounds;
  parts.push(
    `bounds:${q3(b.minX)},${q3(b.maxX)},${q3(b.minY)},${q3(b.maxY)},${q3(b.minZ)},${q3(b.maxZ)}`,
  );

  {
    const t = data.terrain;
    const hStr = t.heights.map((h) => q3(h)).join(',');
    parts.push(
      `terrain:hf:${q3(t.width)},${q3(t.depth)},${q3(t.cellSize)},${q3(t.originX)},${q3(t.originZ)},${t.cols},${t.rows}:[${hStr}]`,
    );
  }

  for (const c of data.colliders) {
    // O'q hit-shakli ham gameplay: server o'q tegishi va klient o'q izi/ko'rinishi bir xil shakldan foydalanishi shart
    const hit = c.hit ? `|hit:${hitShapeCanonical(c.hit)}` : '';
    parts.push(
      `col:${c.id}:${c.tag}:${c.mat}:${q3(c.min.x)},${q3(c.min.y)},${q3(c.min.z)}->${q3(c.max.x)},${q3(c.max.y)},${q3(c.max.z)}${hit}`,
    );
  }

  for (const s of data.spawnPoints) {
    parts.push(`sp:${s.id}:${s.team}:${q3(s.x)},${q3(s.y)},${q3(s.z)},${q3(s.yaw)}`);
  }

  for (const loc of data.locations) {
    parts.push(
      `loc:${loc.id}:${loc.kind}:${loc.enterable ? 1 : 0}:${q3(loc.position.x)},${q3(loc.position.y)},${q3(loc.position.z)},${q3(loc.yaw)},${q3(loc.radius)}`,
    );
  }

  for (const cnt of data.containerLocations) {
    parts.push(
      `cnt:${cnt.id}:${cnt.locationId}:${cnt.kind}:${q3(cnt.position.x)},${q3(cnt.position.y)},${q3(cnt.position.z)},${q3(cnt.yaw)},${q3(cnt.interactionRadius)}`,
    );
  }

  return hashCanonicalString(parts.join('\n'));
}

export function extractWorldMeta(world: WorldDefinition): WorldMeta {
  return {
    mapId: world.mapId,
    worldVersion: world.worldVersion,
    publicLayoutSeed: world.publicLayoutSeed,
    gameplayHash: world.gameplayHash,
  };
}

export interface WorldCompatibilityResult {
  ok: boolean;
  reason?: string;
}

export function validateWorldCompatibility(
  expected: WorldMeta,
  received: WorldMeta | undefined | null,
): WorldCompatibilityResult {
  if (!received || typeof received !== 'object') {
    return { ok: false, reason: "Mijoz xarita ma'lumotlarini yubormadi" };
  }
  if (received.mapId !== expected.mapId) {
    return {
      ok: false,
      reason: `Xarita turi mos kelmadi (server: ${expected.mapId}, mijoz: ${String(received.mapId)})`,
    };
  }
  if (received.worldVersion !== expected.worldVersion) {
    return {
      ok: false,
      reason: `Xarita versiyasi mos kelmadi (server: v${expected.worldVersion}, mijoz: v${String(received.worldVersion)})`,
    };
  }
  if (received.publicLayoutSeed !== expected.publicLayoutSeed) {
    return {
      ok: false,
      reason: `Xarita seed raqami mos kelmadi (server: ${expected.publicLayoutSeed}, mijoz: ${String(received.publicLayoutSeed)})`,
    };
  }
  if (received.gameplayHash !== expected.gameplayHash) {
    return {
      ok: false,
      reason: `Xarita xeshi mos kelmadi (server: ${expected.gameplayHash}, mijoz: ${String(received.gameplayHash)})`,
    };
  }
  return { ok: true };
}

// ---------------- Chunk & Prefab Transform Helpers ----------------

export function getChunkCoord(x: number, z: number, chunkSize = DEFAULT_CHUNK_SIZE): ChunkCoord {
  const cx = Math.floor(x / chunkSize);
  const cz = Math.floor(z / chunkSize);
  return { cx, cz, key: `${cx}:${cz}` };
}

/** Relyef namunalash — yagona amalga oshirish `terrain.ts` da; `./world` orqali ham import qilish mumkin. */
export { sampleTerrainHeight, sampleTerrainNormal, sampleTerrainSlopeDeg } from './terrain';

export interface LocalBoxPart {
  localId: string;
  offset: Vec3;
  size: Vec3;
  mat: MaterialKind;
  colliderTag?: ColliderTag;
  hasCollider: boolean;
  hasVisual: boolean;
  visualCategory: VisualCategory;
  batchKey: string;
  batchMode: RenderBatchMode;
  lod?: LodTier;
  maxDrawDistance?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export interface PrefabPlacement {
  objectId: string;
  prefabId: string;
  transform: PlacementTransform;
  parts: LocalBoxPart[];
  /**
   * When true and `terrain` is provided to `compilePrefabPlacement`,
   * the placement's `position.y` is grounded to `sampleTerrainHeight(terrain, x, z)`.
   */
  groundToTerrain?: boolean;
}

/**
 * Generates both VisualDescriptor[] and ColliderBox[] from a single shared PrefabPlacement
 * so that visual models and physical colliders remain strictly aligned in world coordinates.
 */
export function compilePrefabPlacement(
  placement: PrefabPlacement,
  chunkSize = DEFAULT_CHUNK_SIZE,
  terrain?: TerrainDescriptor,
): { visuals: VisualDescriptor[]; colliders: ColliderBox[] } {
  const visuals: VisualDescriptor[] = [];
  const colliders: ColliderBox[] = [];
  const { position, yaw, scale } = placement.transform;
  const baseY =
    placement.groundToTerrain && terrain
      ? sampleTerrainHeight(terrain, position.x, position.z) + position.y
      : position.y;

  // Support cardinal 90-degree rotations for axis-aligned collider boxes, or unrotated offsets
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);

  for (const part of placement.parts) {
    const sx = part.size.x * scale.x;
    const sy = part.size.y * scale.y;
    const sz = part.size.z * scale.z;

    const ox = part.offset.x * scale.x;
    const oy = part.offset.y * scale.y;
    const oz = part.offset.z * scale.z;

    const rx = ox * cos + oz * sin;
    const rz = -ox * sin + oz * cos;

    const cx = position.x + rx;
    const cy = baseY + oy;
    const cz = position.z + rz;

    // Axis-aligned footprint after rotation
    const halfW = (Math.abs(cos) * sx + Math.abs(sin) * sz) / 2;
    const halfD = (Math.abs(sin) * sx + Math.abs(cos) * sz) / 2;
    const min: Vec3 = { x: q3(cx - halfW), y: q3(cy - sy / 2), z: q3(cz - halfD) };
    const max: Vec3 = { x: q3(cx + halfW), y: q3(cy + sy / 2), z: q3(cz + halfD) };

    const chunk = getChunkCoord(cx, cz, chunkSize);

    if (part.hasCollider) {
      const col: ColliderBox = {
        id: `${placement.objectId}:${part.localId}:col`,
        sourceObjectId: placement.objectId,
        tag: part.colliderTag ?? 'structure',
        mat: part.mat,
        min,
        max,
      };
      // Kardinal bo'lmagan burilishda AABB shishadi — o'q uchun haqiqiy burilgan quti
      // (q3 yaxlitlangan 1.571 / 3.142 kabi yaw lar kardinal hisoblanadi — `isOutdoorYawAxisAligned`, 1e-3 rad)
      if (!isOutdoorYawAxisAligned(yaw)) {
        col.hit = { kind: 'obb', cx: q3(cx), cy: q3(cy), cz: q3(cz), hx: sx / 2, hy: sy / 2, hz: sz / 2, yaw };
      }
      colliders.push(col);
    }

    if (part.hasVisual) {
      visuals.push({
        id: `${placement.objectId}:${part.localId}:vis`,
        sourceObjectId: placement.objectId,
        prefabId: placement.prefabId,
        category: part.visualCategory,
        batchKey: part.batchKey,
        batchMode: part.batchMode,
        chunkKey: chunk.key,
        lod: part.lod ?? 'all',
        maxDrawDistance: part.maxDrawDistance ?? 350,
        transform: {
          position: { x: q3(cx), y: q3(cy), z: q3(cz) },
          yaw: q3(yaw),
          scale: { x: q3(scale.x), y: q3(scale.y), z: q3(scale.z) },
        },
        boxDims: { x: q3(sx), y: q3(sy), z: q3(sz) },
        material: part.mat,
        castShadow: part.castShadow ?? part.mat !== 'ground',
        receiveShadow: part.receiveShadow ?? true,
      });
    }
  }

  return { visuals, colliders };
}

// ---------------- Stage 02B Technical Terrain Fixture ----------------

/**
 * Builds the Stage 02B Technical Terrain Test Fixture (`mapId: 'forest_sample'`).
 * Includes:
 * - 1 walkable hill (`tepalik`) at `(-14, 0)` (peak ~3.0 m, slope ~22 deg)
 * - 1 hollow (`pastlik`) at `(14, -12)` (depth ~-2.0 m, slope ~18 deg)
 * - 1 walkable slope (`yurish mumkin bo'lgan qiyalik`) on the hill flank `(-9, 0)`
 * - 1 steep unwalkable ridge (`juda tik qiyalik`) at `(0, -20)` (height ~3.6 m, slope ~61 deg)
 * - 1 elevated wooden platform (`platforma`) with step-up stairs at `(14, 12)`
 * - 1 grounded stone wall (`devor`) at `(0, 14)`
 * - Grounded tree and rock colliders for grounding verification
 */
export function createTechnicalTerrainFixture(
  opts: { publicLayoutSeed?: number; worldVersion?: number; chunkSize?: number } = {},
): WorldDefinition {
  const worldVersion = opts.worldVersion ?? CURRENT_WORLD_VERSION;
  const publicLayoutSeed = opts.publicLayoutSeed ?? DEFAULT_PUBLIC_LAYOUT_SEED;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const terrain = buildTechnicalHeightfield(publicLayoutSeed);
  const colliders: ColliderBox[] = [];
  const visuals: VisualDescriptor[] = [];

  // 1) Elevated platform at (14, 12) grounded to terrain with 3 step-up stairs on its west side
  const platformPlacement: PrefabPlacement = {
    objectId: 'tech_platform_01',
    prefabId: 'wood_deck_platform',
    groundToTerrain: true,
    transform: {
      position: { x: 14, y: 0, z: 12 },
      yaw: 0,
      scale: { x: 1, y: 1, z: 1 },
    },
    parts: [
      // Elevated deck: top at +1.14 m above ground, bottom at +0.84 m (hollow underneath)
      {
        localId: 'deck',
        offset: { x: 0, y: 0.99, z: 0 },
        size: { x: 6, y: 0.3, z: 6 },
        mat: 'crate',
        colliderTag: 'structure',
        hasCollider: true,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'tech:platform_deck',
        batchMode: 'static_box',
      },
      // Corner support posts (visual + collider)
      {
        localId: 'post_nw',
        offset: { x: -2.7, y: 0.42, z: -2.7 },
        size: { x: 0.4, y: 0.84, z: 0.4 },
        mat: 'crate',
        colliderTag: 'structure',
        hasCollider: true,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'tech:platform_post',
        batchMode: 'static_box',
      },
      {
        localId: 'post_ne',
        offset: { x: 2.7, y: 0.42, z: -2.7 },
        size: { x: 0.4, y: 0.84, z: 0.4 },
        mat: 'crate',
        colliderTag: 'structure',
        hasCollider: true,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'tech:platform_post',
        batchMode: 'static_box',
      },
      {
        localId: 'post_sw',
        offset: { x: -2.7, y: 0.42, z: 2.7 },
        size: { x: 0.4, y: 0.84, z: 0.4 },
        mat: 'crate',
        colliderTag: 'structure',
        hasCollider: true,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'tech:platform_post',
        batchMode: 'static_box',
      },
      {
        localId: 'post_se',
        offset: { x: 2.7, y: 0.42, z: 2.7 },
        size: { x: 0.4, y: 0.84, z: 0.4 },
        mat: 'crate',
        colliderTag: 'structure',
        hasCollider: true,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'tech:platform_post',
        batchMode: 'static_box',
      },
      // 3 step-up stairs on the west edge (-X), each 0.38 m high (<= STEP_HEIGHT = 0.55 m)
      {
        localId: 'step_1',
        offset: { x: -4.5, y: 0.19, z: 0 },
        size: { x: 0.7, y: 0.38, z: 2.2 },
        mat: 'crate',
        colliderTag: 'structure',
        hasCollider: true,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'tech:platform_step',
        batchMode: 'static_box',
      },
      {
        localId: 'step_2',
        offset: { x: -3.9, y: 0.38, z: 0 },
        size: { x: 0.7, y: 0.76, z: 2.2 },
        mat: 'crate',
        colliderTag: 'structure',
        hasCollider: true,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'tech:platform_step',
        batchMode: 'static_box',
      },
      {
        localId: 'step_3',
        offset: { x: -3.3, y: 0.57, z: 0 },
        size: { x: 0.7, y: 1.14, z: 2.2 },
        mat: 'crate',
        colliderTag: 'structure',
        hasCollider: true,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'tech:platform_step',
        batchMode: 'static_box',
      },
    ],
  };

  const compiledPlatform = compilePrefabPlacement(platformPlacement, chunkSize, terrain);
  colliders.push(...compiledPlatform.colliders);
  visuals.push(...compiledPlatform.visuals);

  // 2) Grounded stone wall at (0, 14)
  const wallPlacement: PrefabPlacement = {
    objectId: 'tech_wall_01',
    prefabId: 'stone_barrier_wall',
    groundToTerrain: true,
    transform: {
      position: { x: 0, y: 0, z: 14 },
      yaw: 0,
      scale: { x: 1, y: 1, z: 1 },
    },
    parts: [
      {
        localId: 'wall_main',
        offset: { x: 0, y: 1.4, z: 0 },
        size: { x: 8, y: 2.8, z: 0.8 },
        mat: 'wall',
        colliderTag: 'structure',
        hasCollider: true,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'tech:stone_wall',
        batchMode: 'static_box',
      },
    ],
  };
  const compiledWall = compilePrefabPlacement(wallPlacement, chunkSize, terrain);
  colliders.push(...compiledWall.colliders);
  visuals.push(...compiledWall.visuals);

  // 3) Grounded tree collider + visual on hill slope (-10, 8) and rock at (-6, -8)
  const treeCol = createGroundedTreeCollider('tech_tree_01', terrain, -10, 8, 0.45, 5.5);
  colliders.push(treeCol);
  visuals.push({
    id: 'tech_tree_01:trunk:vis',
    sourceObjectId: 'tech_tree_01',
    prefabId: 'pine_trunk_proxy',
    category: 'tree',
    batchKey: 'tech:tree_trunk',
    batchMode: 'static_box',
    chunkKey: getChunkCoord(-10, 8, chunkSize).key,
    lod: 'all',
    maxDrawDistance: 250,
    transform: {
      position: {
        x: -10,
        y: q3((treeCol.min.y + treeCol.max.y) / 2),
        z: 8,
      },
      yaw: 0,
      scale: { x: 1, y: 1, z: 1 },
    },
    boxDims: { x: 0.9, y: 5.5, z: 0.9 },
    material: 'crate',
    castShadow: true,
    receiveShadow: true,
  });

  const rockCol = createGroundedRockCollider('tech_rock_01', terrain, -6, -8, {
    x: 2.2,
    y: 1.5,
    z: 1.8,
  });
  colliders.push(rockCol);
  visuals.push({
    id: 'tech_rock_01:main:vis',
    sourceObjectId: 'tech_rock_01',
    prefabId: 'boulder_proxy',
    category: 'rock',
    batchKey: 'tech:rock',
    batchMode: 'static_box',
    chunkKey: getChunkCoord(-6, -8, chunkSize).key,
    lod: 'all',
    maxDrawDistance: 250,
    transform: {
      position: {
        x: -6,
        y: q3((rockCol.min.y + rockCol.max.y) / 2),
        z: -8,
      },
      yaw: 0,
      scale: { x: 1, y: 1, z: 1 },
    },
    boxDims: { x: 2.2, y: 1.5, z: 1.8 },
    material: 'wall',
    castShadow: true,
    receiveShadow: true,
  });

  const rawSpawns: Array<{ id: string; x: number; z: number; yaw: number; team: Team }> = [
    { id: 'sp_tech_0', x: 0, z: 4, yaw: 0, team: 'red' },
    { id: 'sp_tech_1', x: -22, z: 0, yaw: -Math.PI / 2, team: 'red' },
    { id: 'sp_tech_2', x: 22, z: -12, yaw: Math.PI / 2, team: 'blue' },
    { id: 'sp_tech_3', x: 4, z: 22, yaw: Math.PI, team: 'blue' },
    { id: 'sp_tech_4', x: 0, z: 0, yaw: 0, team: 'none' },
    { id: 'sp_tech_5', x: -14, z: 0, yaw: 0, team: 'none' },
  ];

  const spawnPoints: SpawnPointDef[] = rawSpawns.map((s) => ({
    id: s.id,
    x: q3(s.x),
    y: q3(sampleTerrainHeight(terrain, s.x, s.z)),
    z: q3(s.z),
    yaw: q3(s.yaw),
    team: s.team,
  }));

  const locations: WorldLocation[] = [
    {
      id: 'loc_tech_hill',
      name: 'Walkable Hill',
      kind: 'clearing',
      position: getGroundedPosition(terrain, -14, 0),
      yaw: 0,
      radius: 10,
      enterable: false,
    },
    {
      id: 'loc_tech_hollow',
      name: 'Basin Hollow',
      kind: 'clearing',
      position: getGroundedPosition(terrain, 14, -12),
      yaw: 0,
      radius: 9,
      enterable: false,
    },
    {
      id: 'loc_tech_platform',
      name: 'Test Platform',
      kind: 'camp',
      position: getGroundedPosition(terrain, 14, 12),
      yaw: 0,
      radius: 6,
      enterable: true,
    },
  ];

  const containerLocations: ContainerLocation[] = [];

  const bounds: WorldBounds = {
    minX: -31,
    maxX: 31,
    minY: -6,
    maxY: 25,
    minZ: -31,
    maxZ: 31,
  };

  const baseData = {
    mapId: 'forest_technical' as const,
    worldVersion,
    publicLayoutSeed,
    bounds,
    terrain,
    colliders,
    spawnPoints,
    locations,
    containerLocations,
  };

  return {
    ...baseData,
    name: 'Technical Terrain Fixture (02B)',
    chunkSize,
    visuals,
    gameplayHash: computeGameplayHash(baseData),
  };
}

/**
 * Factory for creating a deterministic `WorldDefinition` by `mapId`, `worldVersion`, and `publicLayoutSeed`.
 */
export function createWorldDefinition(opts: CreateWorldOpts = {}): WorldDefinition {
  // Standart xarita lobbi bilan bir xil: forest_square.
  const mapId: MapId = opts.mapId ?? 'forest_square';
  const worldVersion = opts.worldVersion ?? CURRENT_WORLD_VERSION;
  const publicLayoutSeed = opts.publicLayoutSeed ?? DEFAULT_PUBLIC_LAYOUT_SEED;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;

  if (mapId === 'forest_technical') {
    return createTechnicalTerrainFixture({ publicLayoutSeed, worldVersion, chunkSize });
  }
  if (mapId === 'forest_sample') {
    return createForestSampleWorld({ publicLayoutSeed, worldVersion, chunkSize });
  }
  if (mapId === 'forest_assets_preview') {
    return createForestAssetsPreviewWorld({ publicLayoutSeed, worldVersion, chunkSize });
  }
  return createForestSquareWorld({ publicLayoutSeed, worldVersion, chunkSize });
}
