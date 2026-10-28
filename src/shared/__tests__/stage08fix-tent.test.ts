import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PLAYER_HEIGHT, PLAYER_RADIUS, RUN_SPEED, WALK_SPEED } from '../constants';
import { createForestSquareWorld } from '../forestSquare';
import {
  buildOutdoorPlacementColliders,
  compileAllOutdoorColliders,
  getOutdoorLocalColliderSpecs,
  isOutdoorYawAxisAligned,
  OUTDOOR_ROTATED_MAX_PIECES,
  OUTDOOR_ROTATED_MAX_SEGMENTS,
  OUTDOOR_ROTATED_SEGMENT_TOLERANCE,
  type OutdoorAssetId,
  type OutdoorPlacement,
} from '../outdoor';
import { applyWorldMovement, collidesAtWorld, type Body } from '../physics';
import {
  sampleTerrainHeight,
  type ColliderBox,
  type HeightfieldTerrainDescriptor,
  type WorldDefinition,
} from '../world';

/**
 * STAGE 08-FIX (P1-B): rotatsiyalangan forest_tent_01 / wooden_railing_01 / rusty_barrel_01 colliderlari.
 * Haqiqiy o'yinchi tanasi (PLAYER_RADIUS = 0.4, PLAYER_HEIGHT = 1.8) va haqiqiy `applyWorldMovement`
 * (dt = 1/60) bilan yurish sinovlari.
 */

const DT = 1 / 60;
const SEEDS = [6501, 1, 42, 1337, 2024, 9001, 77777, 123456];
const SYNTH_TENT_YAWS = [0, 0.35, -0.35, Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI];
const q3 = (n: number): number => Math.round(n * 1000) / 1000;
/** Segment tolerance 0.06 m + small cap relaxation (×1.05 steps) + q3 rounding. */
const STRICT_TOL = 0.07;

// Measured from public/models/outdoor/forest_tent_01.glb (no node transforms, renderer applies only
// position + YXZ rotation + scale): fabric x ∈ [-1.02, 1.02], ridge y ≈ 1.6, side slopes z ∈ [-1.20, 1.15],
// closed back gable at z ≈ -1.20, open +Z gable.
const TENT_FRONT_Z = 1.15;
const TENT_INNER_HALF_WIDTH = 0.8;
const TENT_OUTER_HALF_WIDTH = 1.02;
const TENT_BACK_INNER_Z = -1.13;

interface LocalPoint {
  lx: number;
  lz: number;
}

function toWorld(p: OutdoorPlacement, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(p.rotationY);
  const s = Math.sin(p.rotationY);
  return { x: p.position.x + lx * c + lz * s, z: p.position.z - lx * s + lz * c };
}

function toLocal(p: OutdoorPlacement, x: number, z: number): LocalPoint {
  const c = Math.cos(p.rotationY);
  const s = Math.sin(p.rotationY);
  const dx = x - p.position.x;
  const dz = z - p.position.z;
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

function localDirToWorld(p: OutdoorPlacement, dlx: number, dlz: number): { x: number; z: number } {
  const c = Math.cos(p.rotationY);
  const s = Math.sin(p.rotationY);
  return { x: dlx * c + dlz * s, z: -dlx * s + dlz * c };
}

function makeFlatWorld(base: WorldDefinition, colliders: ColliderBox[]): WorldDefinition {
  const size = 80;
  const cellSize = 2;
  const cols = size / cellSize + 1;
  const terrain: HeightfieldTerrainDescriptor = {
    kind: 'heightfield',
    width: size,
    depth: size,
    cellSize,
    originX: -size / 2,
    originZ: -size / 2,
    cols,
    rows: cols,
    heights: new Array<number>(cols * cols).fill(0),
  };
  return {
    ...base,
    terrain,
    bounds: { ...base.bounds, minX: -size / 2, maxX: size / 2, minZ: -size / 2, maxZ: size / 2 },
    colliders,
  };
}

function synthPlacement(
  assetId: OutdoorAssetId,
  yaw: number,
  pos: { x: number; y: number; z: number },
  extra: Partial<OutdoorPlacement> = {},
): OutdoorPlacement {
  return {
    id: `test:${assetId}:${yaw.toFixed(4)}`,
    siteId: 'poi_forest_camp',
    assetId,
    position: { ...pos },
    rotationY: yaw,
    scale: { x: 1, y: 1, z: 1 },
    ...extra,
  } as OutdoorPlacement;
}

function bodyAt(world: WorldDefinition, x: number, z: number): Body {
  return {
    pos: { x, y: sampleTerrainHeight(world.terrain, x, z), z },
    vel: { x: 0, y: 0, z: 0 },
    onGround: true,
  };
}

/** Steers toward `target` every tick (wish velocity), returns the minimum distance reached. */
function walkToward(
  world: WorldDefinition,
  body: Body,
  target: { x: number; z: number },
  speed: number,
  maxSteps: number,
  stopDist: number,
  onStep?: (b: Body) => void,
): number {
  let minD = Infinity;
  for (let i = 0; i < maxSteps; i++) {
    const dx = target.x - body.pos.x;
    const dz = target.z - body.pos.z;
    const d = Math.hypot(dx, dz);
    minD = Math.min(minD, d);
    if (d <= stopDist) break;
    const s = Math.min(speed, d * 8);
    applyWorldMovement(body, (dx / d) * s, (dz / d) * s, false, DT, world);
    onStep?.(body);
  }
  const fd = Math.hypot(target.x - body.pos.x, target.z - body.pos.z);
  return Math.min(minD, fd);
}

/** Holds a fixed world-space wish direction (optionally spamming jump). */
function walkFixed(
  world: WorldDefinition,
  body: Body,
  dir: { x: number; z: number },
  speed: number,
  steps: number,
  jump: boolean,
  onStep: (b: Body) => void,
): void {
  for (let i = 0; i < steps; i++) {
    applyWorldMovement(body, dir.x * speed, dir.z * speed, jump, DT, world);
    onStep(body);
  }
}

/** No deep penetration: a slightly shrunken capsule box at the body position must be collider-free. */
function assertNotEmbedded(world: WorldDefinition, b: Body, label: string): void {
  assert.equal(
    collidesAtWorld(world, b.pos.x, b.pos.y + 0.03, b.pos.z, PLAYER_RADIUS - 0.02, PLAYER_HEIGHT - 0.1),
    false,
    `${label}: o'yinchi tanasi colliderga botib qolmasligi shart (pos=${b.pos.x.toFixed(3)},${b.pos.y.toFixed(3)},${b.pos.z.toFixed(3)})`,
  );
}

function isInsideTentFootprint(p: OutdoorPlacement, b: Body): boolean {
  const l = toLocal(p, b.pos.x, b.pos.z);
  return Math.abs(l.lx) < TENT_INNER_HALF_WIDTH && l.lz > TENT_BACK_INNER_Z && l.lz < TENT_FRONT_Z - 0.1;
}

function findFreeLocal(
  world: WorldDefinition,
  p: OutdoorPlacement,
  candidates: LocalPoint[],
): LocalPoint | null {
  for (const c of candidates) {
    const w = toWorld(p, c.lx, c.lz);
    const gy = sampleTerrainHeight(world.terrain, w.x, w.z);
    if (!collidesAtWorld(world, w.x, gy + 0.01, w.z)) return c;
  }
  return null;
}

interface TentWalkResult {
  startLz: number;
  minDistToCenter: number;
  exitDist: number;
}

/** Walk from ≥1.8 m outside the +Z doorway to the interior centre and back out with real movement. */
function walkIntoTentAndOut(world: WorldDefinition, tent: OutdoorPlacement, label: string): TentWalkResult {
  const start = findFreeLocal(world, tent, [
    { lx: 0, lz: TENT_FRONT_Z + 1.8 },
    { lx: 0, lz: TENT_FRONT_Z + 1.4 },
    { lx: 0, lz: 1.8 },
  ]);
  assert.ok(start, `${label}: kirish oldida (+Z) bo'sh boshlang'ich nuqta topilishi shart`);
  assert.ok(start.lz >= 1.8 - 1e-9, `${label}: boshlang'ich nuqta markazdan kamida 1.8 m tashqarida bo'lishi shart`);

  const startW = toWorld(tent, start.lx, start.lz);
  const center = toWorld(tent, 0, 0);
  const body = bodyAt(world, startW.x, startW.z);
  const check = (b: Body) => assertNotEmbedded(world, b, label);

  const minDistToCenter = walkToward(world, body, center, WALK_SPEED, 600, 0.05, check);
  assert.ok(
    minDistToCenter <= 0.25,
    `${label}: o'yinchi +Z kirishdan chodir markaziga (≤0.25 m) yetib borishi shart (min=${minDistToCenter.toFixed(3)} m, pos=${body.pos.x.toFixed(2)},${body.pos.z.toFixed(2)})`,
  );
  const gy = sampleTerrainHeight(world.terrain, body.pos.x, body.pos.z);
  assert.equal(
    collidesAtWorld(world, body.pos.x, Math.max(body.pos.y, gy) + 0.01, body.pos.z),
    false,
    `${label}: chodir ichida turgan o'yinchi kapsulasi bo'sh bo'lishi shart`,
  );

  const exitDist = walkToward(world, body, startW, RUN_SPEED, 600, 0.05, check);
  assert.ok(exitDist <= 0.3, `${label}: o'yinchi chodirdan qaytib chiqa olishi shart (dist=${exitDist.toFixed(3)} m)`);
  const lOut = toLocal(tent, body.pos.x, body.pos.z);
  assert.ok(lOut.lz > TENT_FRONT_Z + PLAYER_RADIUS - 0.05, `${label}: chiqqandan keyin o'yinchi kirish tashqarisida bo'lishi shart`);
  return { startLz: start.lz, minDistToCenter, exitDist };
}

/** Try to cross the side walls / back wall from outside: must never get into the tent footprint. */
function attemptWallCrossings(world: WorldDefinition, tent: OutdoorPlacement, label: string, jump: boolean): number {
  const attempts: Array<{ from: LocalPoint[]; dir: LocalPoint; name: string }> = [
    { name: 'o‘ng yon devor (+X)', from: [{ lx: 2.6, lz: 0 }, { lx: 2.6, lz: -0.5 }, { lx: 2.2, lz: 0.3 }], dir: { lx: -1, lz: 0 } },
    { name: 'chap yon devor (-X)', from: [{ lx: -2.6, lz: 0 }, { lx: -2.6, lz: -0.5 }, { lx: -2.2, lz: 0.3 }], dir: { lx: 1, lz: 0 } },
    { name: 'orqa devor (-Z)', from: [{ lx: 0, lz: -2.8 }, { lx: 0.3, lz: -2.6 }, { lx: -0.3, lz: -2.4 }], dir: { lx: 0, lz: 1 } },
  ];
  let performed = 0;
  for (const a of attempts) {
    const start = findFreeLocal(world, tent, a.from);
    if (!start) continue;
    performed++;
    const w = toWorld(tent, start.lx, start.lz);
    const dir = localDirToWorld(tent, a.dir.lx, a.dir.lz);
    const body = bodyAt(world, w.x, w.z);
    const center = toWorld(tent, 0, 0);
    let minD = Infinity;
    walkFixed(world, body, dir, RUN_SPEED, 180, jump, (b) => {
      minD = Math.min(minD, Math.hypot(b.pos.x - center.x, b.pos.z - center.z));
      assert.equal(
        isInsideTentFootprint(tent, b),
        false,
        `${label}: ${a.name} orqali${jump ? ' (sakrab)' : ''} chodir ichiga o'tib bo'lmasligi shart (local=${JSON.stringify(toLocal(tent, b.pos.x, b.pos.z))})`,
      );
    });
    assert.ok(minD > 0.9, `${label}: ${a.name} devoridan o'tib markazga yetib bo'lmasligi shart (min=${minD.toFixed(3)})`);
  }
  return performed;
}

// ---------- exact 2D footprint fidelity helpers (SAT: world-axis square body vs yawed rectangle) ----------

interface YawedRect {
  cx: number;
  cz: number;
  a: number; // half-extent along local x
  b: number; // half-extent along local z
  yaw: number;
  minY: number;
  maxY: number;
}

function partRects(p: OutdoorPlacement): YawedRect[] {
  return getOutdoorLocalColliderSpecs(p).map((part) => {
    const lx = part.center[0] * (p.scale?.x ?? 1);
    const lz = part.center[2] * (p.scale?.z ?? 1);
    const c = toWorld(p, lx, lz);
    const ly = part.center[1] * (p.scale?.y ?? 1);
    const hy = 0.5 * part.size[1] * (p.scale?.y ?? 1);
    return {
      cx: c.x,
      cz: c.z,
      a: 0.5 * part.size[0] * (p.scale?.x ?? 1),
      b: 0.5 * part.size[2] * (p.scale?.z ?? 1),
      yaw: p.rotationY,
      minY: p.position.y + ly - hy,
      maxY: p.position.y + ly + hy,
    };
  });
}

/** Max separation along the 4 SAT axes between the rect inflated by `inflate` and a square of half `r`. */
function satSeparation(rect: YawedRect, x: number, z: number, r: number, inflate: number): number {
  const c = Math.cos(rect.yaw);
  const s = Math.sin(rect.yaw);
  const ux = { x: c, z: -s };
  const vx = { x: s, z: c };
  const a = rect.a + inflate;
  const b = rect.b + inflate;
  const dx = x - rect.cx;
  const dz = z - rect.cz;
  const sepX = Math.abs(dx) - (a * Math.abs(ux.x) + b * Math.abs(vx.x) + r);
  const sepZ = Math.abs(dz) - (a * Math.abs(ux.z) + b * Math.abs(vx.z) + r);
  const sepU = Math.abs(dx * ux.x + dz * ux.z) - (a + r * (Math.abs(ux.x) + Math.abs(ux.z)));
  const sepV = Math.abs(dx * vx.x + dz * vx.z) - (b + r * (Math.abs(vx.x) + Math.abs(vx.z)));
  return Math.max(sepX, sepZ, sepU, sepV);
}

/**
 * Over a dense grid around a placement in a flat world containing only that placement's colliders:
 * - body square clear of every part rectangle inflated by `tol` → `collidesAtWorld` must be false (no phantom),
 * - body square overlapping a part rectangle (shrunk by 2 mm) → must be true (no hole / walk-through).
 */
function assertFootprintFidelity(world: WorldDefinition, p: OutdoorPlacement, tol: number, label: string): void {
  const rects = partRects(p);
  const y = 0; // flat test world: ground y = 0
  const r = PLAYER_RADIUS;
  let phantom = 0;
  let holes = 0;
  let firstPhantom = '';
  let firstHole = '';
  const extent = 3.2;
  const step = 0.04;
  for (let gx = -extent; gx <= extent + 1e-9; gx += step) {
    for (let gz = -extent; gz <= extent + 1e-9; gz += step) {
      const x = p.position.x + gx;
      const z = p.position.z + gz;
      const hit = collidesAtWorld(world, x, y + 0.001, z, r, PLAYER_HEIGHT);
      const verticalRects = rects.filter((rc) => rc.maxY > y + 0.001 && rc.minY < y + 0.001 + PLAYER_HEIGHT);
      const clear = verticalRects.every((rc) => satSeparation(rc, x, z, r, tol) > 0);
      const overlap = verticalRects.some((rc) => satSeparation(rc, x, z, r, -0.002) < 0);
      if (clear && hit) {
        phantom++;
        if (!firstPhantom) firstPhantom = `(${gx.toFixed(2)},${gz.toFixed(2)})`;
      }
      if (overlap && !hit) {
        holes++;
        if (!firstHole) firstHole = `(${gx.toFixed(2)},${gz.toFixed(2)})`;
      }
    }
  }
  assert.equal(phantom, 0, `${label}: vizualdan ${tol} m dan uzoqda phantom devor bo'lmasligi shart (count=${phantom}, first=${firstPhantom})`);
  assert.equal(holes, 0, `${label}: collider ichida teshik (o'tib ketish) bo'lmasligi shart (count=${holes}, first=${firstHole})`);
}

/** Largest distance from any piece-AABB corner (xz) to the union of the true part rectangles. */
function maxAabbOvershoot(p: OutdoorPlacement, cols: ColliderBox[]): number {
  const rects = partRects(p);
  const distToRect = (rc: YawedRect, x: number, z: number): number => {
    const l = { lx: 0, lz: 0 };
    const c = Math.cos(rc.yaw);
    const s = Math.sin(rc.yaw);
    const dx = x - rc.cx;
    const dz = z - rc.cz;
    l.lx = dx * c - dz * s;
    l.lz = dx * s + dz * c;
    const ox = Math.max(0, Math.abs(l.lx) - rc.a);
    const oz = Math.max(0, Math.abs(l.lz) - rc.b);
    return Math.hypot(ox, oz);
  };
  let worst = 0;
  for (const col of cols) {
    for (const x of [col.min.x, col.max.x]) {
      for (const z of [col.min.z, col.max.z]) {
        const d = Math.min(...rects.map((rc) => distToRect(rc, x, z)));
        worst = Math.max(worst, d);
      }
    }
  }
  return worst;
}

describe('BOSQICH 08-FIX — P1-B: rotatsiyalangan chodir, panjara va bochka colliderlari (real kapsula yurishi)', () => {
  const base = createForestSquareWorld({ publicLayoutSeed: 6501 });

  it('1. forest_tent_01 GLB o‘lchamlari collider joylashuviga mos: +Z kirish ochiq, ichki kenglik 0.8 m tanaga yetarli', () => {
    const glbPath = path.resolve(process.cwd(), 'public/models/outdoor/forest_tent_01.glb');
    const buf = fs.readFileSync(glbPath);
    assert.equal(buf.readUInt32LE(0), 0x46546c67, 'forest_tent_01.glb magic glTF bo‘lishi shart');
    const jsonLen = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as {
      nodes: Array<{ name?: string; mesh?: number; translation?: number[]; scale?: number[]; rotation?: number[] }>;
      meshes: Array<{ primitives: Array<{ attributes: { POSITION: number } }> }>;
      accessors: Array<{ min?: number[]; max?: number[] }>;
    };
    // No node transforms → accessor bounds are the model-space bounds the renderer uses.
    for (const n of gltf.nodes) {
      assert.equal(n.translation, undefined, `tent node ${n.name} translation bo'lmasligi shart`);
      assert.equal(n.scale, undefined, `tent node ${n.name} scale bo'lmasligi shart`);
      assert.equal(n.rotation, undefined, `tent node ${n.name} rotation bo'lmasligi shart`);
    }
    const fabricNode = gltf.nodes.find((n) => n.name === 'forest_tent_01_fabric');
    assert.ok(fabricNode && fabricNode.mesh !== undefined, 'forest_tent_01_fabric mesh mavjud bo‘lishi shart');
    const acc = gltf.accessors[gltf.meshes[fabricNode.mesh!].primitives[0].attributes.POSITION];
    assert.ok(acc.min && acc.max);
    assert.ok(Math.abs(acc.min[0] + TENT_OUTER_HALF_WIDTH) < 0.01 && Math.abs(acc.max[0] - TENT_OUTER_HALF_WIDTH) < 0.01, 'fabric x ∈ [-1.02, 1.02]');
    assert.ok(acc.max[1] >= 1.55 && acc.max[1] <= 1.65, 'fabric ridge y ≈ 1.6');

    const tent = synthPlacement('forest_tent_01', 0, { x: 0, y: 0, z: 0 });
    const cols = buildOutdoorPlacementColliders(tent);
    assert.equal(cols.length, 5, 'yaw=0 da chodir 5 ta devor segmentidan iborat');
    // Outer faces never exceed the visual footprint (+1 cm), inner side faces leave ≥1.6 m interior
    let minInnerSide = Infinity;
    for (const c of cols) {
      assert.ok(c.min.x >= -TENT_OUTER_HALF_WIDTH - 0.01 && c.max.x <= TENT_OUTER_HALF_WIDTH + 0.01, `${c.id} vizual kenglikdan chiqmasligi shart`);
      assert.ok(c.max.z <= TENT_FRONT_Z + 0.01, `${c.id} +Z kirish chizig‘idan oldinga chiqmasligi shart`);
      assert.ok(c.min.z >= -1.3, `${c.id} orqa gable dan uzoqqa chiqmasligi shart`);
      if (!c.id.endsWith('back_wall')) minInnerSide = Math.min(minInnerSide, Math.abs(c.min.x) < Math.abs(c.max.x) ? Math.abs(c.min.x) : Math.abs(c.max.x));
    }
    assert.ok(minInnerSide >= TENT_INNER_HALF_WIDTH - 1e-6, `ichki yarim kenglik ≥ 0.8 m (actual=${minInnerSide})`);
    assert.ok(2 * minInnerSide >= 2 * PLAYER_RADIUS + 0.6, '0.8 m tana ikki tomondan ≥0.3 m bo‘shliq bilan sig‘ishi shart');
    // Walls taller than the max jump apex (JUMP_SPEED²/2g ≈ 1.31 m) and taller than STEP_HEIGHT
    for (const c of cols) assert.ok(c.max.y - c.min.y >= 1.4, `${c.id} balandligi ≥ 1.4 m`);
    // Doorway: nothing in front of the interior between the side walls
    const doorway = cols.filter((c) => c.max.z > 0.6 && c.min.x < TENT_INNER_HALF_WIDTH - 0.01 && c.max.x > -TENT_INNER_HALF_WIDTH + 0.01);
    assert.deepEqual(doorway.map((c) => c.id), [], '+Z kirish ochiq bo‘lishi shart');
  });

  it('2. Yaw-aware segmentatsiya: axis-aligned yawlarda eski ID/box, aylantirilganda ≤0.06 m AABB oshishi, determinizm, ≤24 strip / ≤32 bo‘lak', () => {
    const legacy = (p: OutdoorPlacement): ColliderBox[] => {
      const c = Math.cos(p.rotationY);
      const s = Math.sin(p.rotationY);
      return getOutdoorLocalColliderSpecs(p).map((part) => {
        const rx = part.center[0] * p.scale.x;
        const ry = part.center[1] * p.scale.y;
        const rz = part.center[2] * p.scale.z;
        const wx = p.position.x + rx * c + rz * s;
        const wy = p.position.y + ry;
        const wz = p.position.z - rx * s + rz * c;
        const hx = 0.5 * (Math.abs(part.size[0] * p.scale.x * c) + Math.abs(part.size[2] * p.scale.z * s));
        const hy = 0.5 * part.size[1] * p.scale.y;
        const hz = 0.5 * (Math.abs(part.size[0] * p.scale.x * s) + Math.abs(part.size[2] * p.scale.z * c));
        return {
          id: `${p.id}:col:${part.name}`,
          tag: part.tag,
          sourceObjectId: p.id,
          mat: part.mat,
          min: { x: q3(wx - hx), y: q3(wy - hy), z: q3(wz - hz) },
          max: { x: q3(wx + hx), y: q3(wy + hy), z: q3(wz + hz) },
        };
      });
    };

    let aligned = 0;
    let rotated = 0;
    for (const seed of SEEDS) {
      const w = createForestSquareWorld({ publicLayoutSeed: seed });
      const placements = w.poiLayout.outdoorPlacements!;
      for (const p of placements) {
        const cols = buildOutdoorPlacementColliders(p);
        assert.ok(cols.length >= 1, `${p.id} kamida 1 collider`);
        assert.deepEqual(buildOutdoorPlacementColliders(p), cols, `${p.id} deterministik`);
        for (const c of cols) {
          for (const v of [c.min.x, c.min.y, c.min.z, c.max.x, c.max.y, c.max.z]) assert.equal(v, q3(v), `${c.id} q3 yaxlitlangan`);
        }
        if (isOutdoorYawAxisAligned(p.rotationY)) {
          aligned++;
          // Harakat qutisi eskicha; dumaloq qismlarda (bochka, gulxan halqasi) qo'shimcha o'q silindri bor
          const boxesOnly = cols.map(({ hit: _hit, ...rest }) => rest);
          assert.deepEqual(boxesOnly, legacy(p), `${p.id} (axis-aligned) eski ID va box saqlanishi shart`);
        } else {
          rotated++;
          const specs = getOutdoorLocalColliderSpecs(p);
          assert.ok(cols.length <= specs.length * OUTDOOR_ROTATED_MAX_PIECES, `${p.id} bo'laklar soni cheklangan`);
          for (const c of cols) {
            assert.match(c.id, new RegExp(`^${p.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:col:[a-z_]+(_s\\d+)?$`));
          }
          const overshoot = maxAabbOvershoot(p, cols.filter((c) => specs.some((s) => s.yawMode !== 'invariant' && c.id.includes(`:col:${s.name}`))));
          // Tents / railings / tipped barrels: strict tolerance; thick solid stacks may relax when capped at 24 pieces
          const strict = p.assetId === 'forest_tent_01' || p.assetId === 'wooden_railing_01' || p.assetId === 'rusty_barrel_01';
          const limit = strict ? STRICT_TOL : 0.15;
          assert.ok(overshoot <= limit, `${p.id} AABB oshishi ${overshoot.toFixed(4)} m ≤ ${limit} bo'lishi shart`);
        }
      }
      // Every placement still covered in world.colliders; world outdoor colliders == compiled set
      const compiled = compileAllOutdoorColliders(placements);
      const byId = new Map(w.colliders.map((c) => [c.id, c]));
      for (const c of compiled) assert.deepEqual(byId.get(c.id), c, `Seed ${seed}: ${c.id} world.colliders ichida bo'lishi shart`);
      const covered = new Set(compiled.map((c) => c.sourceObjectId));
      for (const p of placements) assert.ok(covered.has(p.id), `Seed ${seed}: ${p.id} collider bilan qoplangan bo'lishi shart`);
      assert.equal(new Set(w.colliders.map((c) => c.id)).size, w.colliders.length, `Seed ${seed}: collider IDlar unikal`);
    }
    assert.ok(aligned > 0 && rotated > 0);

    // Synthetic: rotated railing must never become one huge phantom box
    const rail = synthPlacement('wooden_railing_01', 0.6, { x: 0, y: 0, z: 0 });
    const railCols = buildOutdoorPlacementColliders(rail);
    assert.ok(railCols.length > 1 && railCols.length <= OUTDOOR_ROTATED_MAX_PIECES);
    assert.ok(railCols.every((c) => /:col:barrier_s\d+$/.test(c.id)));
    assert.ok(maxAabbOvershoot(rail, railCols) <= STRICT_TOL);
  });

  it('3. Sintetik chodir (yaw 0, ±0.35, ±π/2, π, −π) tekis dunyoda: 1.8 m tashqaridan markazga kirish/chiqish, devorlardan o‘tish bloklangan', () => {
    for (const yaw of SYNTH_TENT_YAWS) {
      const tent = synthPlacement('forest_tent_01', yaw, { x: 0, y: 0, z: 0 });
      const world = makeFlatWorld(base, buildOutdoorPlacementColliders(tent));
      const label = `sintetik chodir yaw=${yaw.toFixed(3)}`;
      assert.equal(collidesAtWorld(world, 0, 0.01, 0, PLAYER_RADIUS, PLAYER_HEIGHT), false, `${label}: markaz bo'sh`);
      const res = walkIntoTentAndOut(world, tent, label);
      assert.equal(res.startLz, TENT_FRONT_Z + 1.8);
      assert.equal(attemptWallCrossings(world, tent, label, false), 3);
      assert.equal(attemptWallCrossings(world, tent, label, true), 3);
      assertFootprintFidelity(world, tent, STRICT_TOL, label);
    }
  });

  it('4. Sintetik chodir haqiqiy forest_square relyefida (real chodir joyida, faqat chodir colliderlari) barcha yawlarda kirish/chiqish', () => {
    const realTent = base.poiLayout.outdoorPlacements!.find((p) => p.id === 'poi:poi_forest_camp:out_1:forest_tent_01')!;
    assert.ok(realTent);
    for (const yaw of SYNTH_TENT_YAWS) {
      const tent = synthPlacement('forest_tent_01', yaw, realTent.position);
      const world: WorldDefinition = { ...base, colliders: buildOutdoorPlacementColliders(tent) };
      const label = `relyefdagi sintetik chodir yaw=${yaw.toFixed(3)}`;
      const gy = sampleTerrainHeight(world.terrain, tent.position.x, tent.position.z);
      assert.equal(collidesAtWorld(world, tent.position.x, gy + 0.01, tent.position.z), false, `${label}: markaz bo'sh`);
      walkIntoTentAndOut(world, tent, label);
      assert.equal(attemptWallCrossings(world, tent, label, false), 3);
    }
  });

  it('5. Ikkala haqiqiy chodir 8 ta seedda (to‘liq world.colliders): markaz bo‘sh, kirish/chiqish, devor orqali o‘tish bloklangan', () => {
    for (const seed of SEEDS) {
      const world = createForestSquareWorld({ publicLayoutSeed: seed });
      const tents = world.poiLayout.outdoorPlacements!.filter((p) => p.assetId === 'forest_tent_01');
      assert.equal(tents.length, 2, `Seed ${seed}: 2 ta chodir`);
      for (const tent of tents) {
        const label = `Seed ${seed} ${tent.id} (yaw=${tent.rotationY})`;
        const gy = sampleTerrainHeight(world.terrain, tent.position.x, tent.position.z);
        assert.equal(
          collidesAtWorld(world, tent.position.x, gy + 0.01, tent.position.z, PLAYER_RADIUS, PLAYER_HEIGHT),
          false,
          `${label}: ichki markazda collidesAtWorld === false bo'lishi shart`,
        );
        walkIntoTentAndOut(world, tent, label);
        const n = attemptWallCrossings(world, tent, label, false);
        assert.ok(n >= 2, `${label}: kamida 2 ta devor-kesish urinishi bajarilishi shart (actual=${n})`);
      }
    }
  });

  it('6. Aylantirilgan wooden_railing_01: perpendikulyar kesib o‘tish bloklanadi, 0.15 m yonidan parallel yurish erkin (phantom devor yo‘q)', () => {
    for (const yaw of [0.35, -0.35, 0.6, Math.PI / 4, 1.2, -2.5, 0]) {
      const rail = synthPlacement('wooden_railing_01', yaw, { x: 0, y: 0, z: 0 });
      const world = makeFlatWorld(base, buildOutdoorPlacementColliders(rail));
      const label = `railing yaw=${yaw.toFixed(3)}`;
      const halfLen = 1.5;
      const halfThick = 0.09;

      // 6a) Perpendicular crossing (both sides) inside the railing span is blocked
      for (const side of [-1, 1]) {
        for (const lx of [-0.8, 0, 0.8]) {
          const s = toWorld(rail, lx, side * 1.5);
          const body = bodyAt(world, s.x, s.z);
          const dir = localDirToWorld(rail, 0, -side);
          walkFixed(world, body, dir, RUN_SPEED, 90, false, (b) => {
            const l = toLocal(rail, b.pos.x, b.pos.z);
            if (Math.abs(l.lx) < halfLen - PLAYER_RADIUS) {
              assert.ok(
                side * l.lz > halfThick + PLAYER_RADIUS - 0.08,
                `${label}: panjarani (lx=${lx}, side=${side}) kesib o'tib bo'lmasligi shart (local=${l.lx.toFixed(3)},${l.lz.toFixed(3)})`,
              );
            }
          });
        }
      }

      // 6b) Walking parallel with the body surface 0.15 m from the visual railing line is never blocked
      for (const side of [-1, 1]) {
        const offset = side * (0.095 + PLAYER_RADIUS + 0.15);
        const s = toWorld(rail, -3.2, offset);
        const e = toWorld(rail, 3.2, offset);
        const body = bodyAt(world, s.x, s.z);
        const d = walkToward(world, body, e, RUN_SPEED, 240, 0.05);
        assert.ok(d <= 0.1, `${label}: panjara yonidan (offset=${offset.toFixed(3)}) parallel yurish to'silmasligi shart (qolgan=${d.toFixed(3)})`);
      }
      assertFootprintFidelity(world, rail, STRICT_TOL, label);
    }
  });

  it('7. Aylantirilgan va yonbosh yotgan rusty_barrel_01: markaz bloklangan, 0.9 m uzoqlikda erkin, yonbosh bochka izi aniq', () => {
    // Upright (yaw-invariant cylinder footprint)
    for (const yaw of [0.403, 0.794, 2.106, -1.0]) {
      const barrel = synthPlacement('rusty_barrel_01', yaw, { x: 0, y: 0, z: 0 });
      const cols = buildOutdoorPlacementColliders(barrel);
      assert.equal(cols.length, 1);
      const world = makeFlatWorld(base, cols);
      const label = `tik bochka yaw=${yaw}`;
      assert.equal(collidesAtWorld(world, 0, 0.01, 0), true, `${label}: markaz bloklangan`);
      // World-axis directions (the player body is a world-aligned 0.8 m square, so diagonal 0.9 m would
      // overlap even a perfect 0.58 m cylinder box)
      for (const [dx, dz] of [[0.9, 0], [-0.9, 0], [0, 0.9], [0, -0.9]]) {
        assert.equal(collidesAtWorld(world, dx, 0.01, dz), false, `${label}: (${dx},${dz}) erkin bo'lishi shart`);
      }
      // Walking straight at it is blocked
      const body = bodyAt(world, -2, 0);
      walkFixed(world, body, { x: 1, z: 0 }, RUN_SPEED, 90, false, (b) => {
        assert.ok(b.pos.x < -0.29 - PLAYER_RADIUS + 0.01, `${label}: bochka orqali o'tib bo'lmasligi shart`);
      });
    }
    // Tipped (rotationZ = π/2): rectangle 0.9 × 0.58 along local −X from the origin
    for (const yaw of [0.9, 0.45, -0.7, 2.3]) {
      const barrel = synthPlacement('rusty_barrel_01', yaw, { x: 0, y: 0.305, z: 0 }, { rotationZ: Math.PI / 2 });
      const cols = buildOutdoorPlacementColliders(barrel);
      const world = makeFlatWorld(base, cols);
      const label = `yonbosh bochka yaw=${yaw}`;
      const c = toWorld(barrel, -0.45, 0);
      assert.equal(collidesAtWorld(world, c.x, 0.01, c.z), true, `${label}: markaz bloklangan`);
      // 0.95 m from the axis (both sides) → free. (A world-aligned 0.8 m body square at yaw ≈ ±0.7 projects
      // 0.56 m onto the barrel normal, so at exactly 0.9 m the clearance to the TRUE 0.29 m radius is only
      // 0.046 m — inside the 0.06 m segment tolerance; 0.95 m gives a clean margin.)
      for (const side of [-1, 1]) {
        const pnt = toWorld(barrel, -0.45, side * 0.95);
        assert.equal(collidesAtWorld(world, pnt.x, 0.01, pnt.z), false, `${label}: o'qqa perpendikulyar 0.95 m da erkin`);
      }
      // 0.9 m beyond each end cap along the axis → free
      for (const lx of [-0.45 - 0.45 - 0.9, -0.45 + 0.45 + 0.9]) {
        const pnt = toWorld(barrel, lx, 0);
        assert.equal(collidesAtWorld(world, pnt.x, 0.01, pnt.z), false, `${label}: uchidan 0.9 m da erkin`);
      }
      assertFootprintFidelity(world, barrel, STRICT_TOL, label);
    }
  });
});
