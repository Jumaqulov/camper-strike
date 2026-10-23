import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NavGraph } from '../../server/navgraph';
import { PLAYER_HEIGHT, PLAYER_RADIUS, WALK_SPEED } from '../constants';
import {
  buildFallenLogColliders,
  buildTreeStumpCollider,
  FALLEN_LOG_PREFAB_ID,
  getFallenLogFootprint,
  isHardForestPropPrefab,
  TREE_STUMP_BASE_RADIUS,
  TREE_STUMP_PREFAB_ID,
  TREE_STUMP_TOP_Y,
} from '../forestProps';
import {
  buildForestSquarePOILayout,
  buildForestSquareTerrain,
  buildForestSquareVegetation,
  createForestSquareWorld,
  getForestSquarePoiSites,
  sampleForestSquareRoad,
  type ForestSquareWorldDefinition,
} from '../forestSquare';
import { buildForestSquareSpawns, SPAWN_CLEARANCE_RADIUS } from '../forestSquareSpawns';
import { applyWorldMovement, collidesAtWorld, isSpawnPointSafe, type Body } from '../physics';
import { isCapsuleClearOfBoxes, sampleTerrainHeight, sampleTerrainSlopeDeg } from '../terrain';
import type { ColliderBox, VisualDescriptor } from '../world';

const SEEDS = [6501, 1, 42, 1337, 2024, 9001, 77777, 123456];
const SOFT_PREFABS = new Set([
  'foliage:bush',
  'foliage:fern',
  'foliage:grass',
  'foliage:leaf_patch',
  'prop:pebble',
]);

const isHardPropCollider = (c: ColliderBox): boolean =>
  c.sourceObjectId !== undefined && /^sq_(log|stump)_\d+$/.test(c.sourceObjectId);

const hardVisuals = (w: ForestSquareWorldDefinition): VisualDescriptor[] =>
  w.visuals.filter((v) => isHardForestPropPrefab(v.prefabId));

function groupBySource(cols: readonly ColliderBox[]): Map<string, ColliderBox[]> {
  const m = new Map<string, ColliderBox[]>();
  for (const c of cols) {
    if (!c.sourceObjectId) continue;
    const list = m.get(c.sourceObjectId);
    if (list) list.push(c);
    else m.set(c.sourceObjectId, [c]);
  }
  return m;
}

/** Horizontal distance from (x, z) to the oriented log footprint rectangle (0 when inside). */
function distToLogFootprint(
  fp: ReturnType<typeof getFallenLogFootprint>,
  x: number,
  z: number,
): { dist: number; t: number; perp: number; len: number } {
  const dx = fp.b.x - fp.a.x;
  const dz = fp.b.z - fp.a.z;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const rx = x - fp.a.x;
  const rz = z - fp.a.z;
  const t = rx * ux + rz * uz;
  const perp = Math.abs(-rx * uz + rz * ux);
  const along = Math.max(0, -t, t - len);
  const side = Math.max(0, perp - fp.halfWidth);
  return { dist: Math.hypot(along, side), t, perp, len };
}

describe("BOSQICH 08-FIX — Qattiq prop colliderlari (fallen_log / tree_stump)", () => {
  it("1. Har bir fallen_log/tree_stump visualida bir xil sourceObjectId li ≥1 collider bor va aksincha (yetim collider/visual yo'q) — 8 seed", () => {
    for (const seed of SEEDS) {
      const w = createForestSquareWorld({ publicLayoutSeed: seed });
      const hv = hardVisuals(w);
      const hardCols = w.colliders.filter(isHardPropCollider);
      const bySource = groupBySource(hardCols);
      const visIds = new Set(hv.map((v) => v.sourceObjectId));

      assert.ok(hv.filter((v) => v.prefabId === FALLEN_LOG_PREFAB_ID).length >= 70, `seed ${seed}: log soni`);
      assert.ok(hv.filter((v) => v.prefabId === TREE_STUMP_PREFAB_ID).length >= 65, `seed ${seed}: stump soni`);

      for (const v of hv) {
        const cols = bySource.get(v.sourceObjectId) ?? [];
        assert.ok(cols.length >= 1, `seed ${seed}: ${v.sourceObjectId} visualida collider yo'q`);
        for (const c of cols) {
          assert.equal(c.tag, 'prop', `seed ${seed}: ${c.id} tag`);
          if (v.prefabId === FALLEN_LOG_PREFAB_ID) {
            assert.match(c.id, new RegExp(`^${v.sourceObjectId}:col:seg\\d+$`));
          } else {
            assert.equal(c.id, `${v.sourceObjectId}:col`);
          }
        }
      }
      for (const sid of bySource.keys()) {
        assert.ok(visIds.has(sid), `seed ${seed}: ${sid} collideri bor, lekin visuali yo'q (ko'rinmas devor)`);
      }
      const ids = new Set(w.colliders.map((c) => c.id));
      assert.equal(ids.size, w.colliders.length, `seed ${seed}: collider IDlar unikal`);
    }
  });

  it("2. O'yinchi kapsulasi (PLAYER_RADIUS/PLAYER_HEIGHT) har bir log/stump vizual markazida bloklanadi — 8 seed", () => {
    for (const seed of SEEDS) {
      const w = createForestSquareWorld({ publicLayoutSeed: seed });
      for (const v of hardVisuals(w)) {
        let cx = v.transform.position.x;
        let cz = v.transform.position.z;
        if (v.prefabId === FALLEN_LOG_PREFAB_ID) {
          const fp = getFallenLogFootprint(v.transform, w.terrain);
          cx = (fp.a.x + fp.b.x) / 2;
          cz = (fp.a.z + fp.b.z) / 2;
        }
        const gy = sampleTerrainHeight(w.terrain, cx, cz);
        assert.equal(
          collidesAtWorld(w, cx, gy + 0.01, cz, PLAYER_RADIUS, PLAYER_HEIGHT),
          true,
          `seed ${seed}: ${v.sourceObjectId} markazida (${cx.toFixed(2)}, ${cz.toFixed(2)}) collidesAtWorld=false`,
        );
      }
    }
  });

  it("3. Real applyWorldMovement yurishi (dt=1/60) logga perpendikulyar: o'yinchi log ichidan yer sathida o'tib keta olmaydi (bloklanadi yoki ustiga chiqadi)", () => {
    const dt = 1 / 60;
    let tested = 0;
    let blocked = 0;
    let steppedOver = 0;
    for (const seed of SEEDS) {
      const w = createForestSquareWorld({ publicLayoutSeed: seed });
      const bySource = groupBySource(w.colliders.filter(isHardPropCollider));
      for (const v of hardVisuals(w)) {
        if (v.prefabId !== FALLEN_LOG_PREFAB_ID) continue;
        const fp = getFallenLogFootprint(v.transform, w.terrain);
        const own = bySource.get(v.sourceObjectId) ?? [];
        const minTop = Math.min(...own.map((c) => c.max.y));
        const cx = (fp.a.x + fp.b.x) / 2;
        const cz = (fp.a.z + fp.b.z) / 2;
        const len = Math.hypot(fp.b.x - fp.a.x, fp.b.z - fp.a.z);
        const ux = (fp.b.x - fp.a.x) / len;
        const uz = (fp.b.z - fp.a.z) / len;
        for (const side of [1, -1]) {
          const nx = -uz * side;
          const nz = ux * side;
          const startDist = fp.halfWidth + PLAYER_RADIUS + 1.4;
          const sx = cx + nx * startDist;
          const sz = cz + nz * startDist;
          const endX = cx - nx * startDist;
          const endZ = cz - nz * startDist;

          // Only use clean approach corridors: walkable terrain and no foreign colliders along the path.
          let clean = true;
          for (let s = 0; s <= 20 && clean; s++) {
            const px = sx + ((endX - sx) * s) / 20;
            const pz = sz + ((endZ - sz) * s) / 20;
            if (sampleTerrainSlopeDeg(w.terrain, px, pz) > 30) clean = false;
            const gy = sampleTerrainHeight(w.terrain, px, pz);
            for (const c of w.colliders) {
              if (c.sourceObjectId === v.sourceObjectId) continue;
              if (
                px + PLAYER_RADIUS + 0.3 > c.min.x &&
                px - PLAYER_RADIUS - 0.3 < c.max.x &&
                pz + PLAYER_RADIUS + 0.3 > c.min.z &&
                pz - PLAYER_RADIUS - 0.3 < c.max.z &&
                gy + PLAYER_HEIGHT + 1 > c.min.y &&
                gy - 1 < c.max.y
              ) {
                clean = false;
                break;
              }
            }
          }
          if (!clean) continue;

          const sy = sampleTerrainHeight(w.terrain, sx, sz);
          const body: Body = { pos: { x: sx, y: sy, z: sz }, vel: { x: 0, y: 0, z: 0 }, onGround: true };
          let violated = false;
          let maxY = -Infinity;
          for (let tick = 0; tick < 150; tick++) {
            applyWorldMovement(body, -nx * WALK_SPEED, -nz * WALK_SPEED, false, dt, w);
            const d = distToLogFootprint(fp, body.pos.x, body.pos.z);
            const insideCore =
              d.perp < fp.halfWidth * 0.8 && d.t > d.len * 0.2 && d.t < d.len * 0.8;
            if (insideCore) maxY = Math.max(maxY, body.pos.y);
            if (insideCore && body.pos.y < minTop - 0.05) {
              violated = true;
              break;
            }
          }
          assert.equal(
            violated,
            false,
            `seed ${seed}: ${v.sourceObjectId} (side ${side}) — o'yinchi log ichidan yer sathida o'tib ketdi (y=${body.pos.y.toFixed(3)}, top=${minTop.toFixed(3)})`,
          );
          tested++;
          if (maxY === -Infinity) blocked++;
          else steppedOver++;
        }
      }
    }
    assert.ok(tested >= 80, `kamida 80 ta real yurish sinovi bo'lishi shart (tested=${tested})`);
    assert.ok(blocked + steppedOver === tested);
  });

  it("4. 36 ta spawn o'zgarmagan (prop colliderlarsiz hisoblangan bilan bir xil), xavfsiz va determinizm saqlangan — 8 seed", () => {
    for (const seed of SEEDS) {
      const w = createForestSquareWorld({ publicLayoutSeed: seed });
      assert.equal(w.spawnPoints.length, 36);
      const expected = buildForestSquareSpawns({
        terrain: w.terrain,
        seed,
        poiSites: getForestSquarePoiSites(seed),
        allColliders: w.colliders.filter((c) => !isHardPropCollider(c)),
        roadDistSampler: (x, z) => sampleForestSquareRoad(x, z, seed).dist,
      });
      assert.deepEqual(w.spawnPoints, expected, `seed ${seed}: spawnlar prop colliderlar sabab siljimasligi shart`);

      const hardCols = w.colliders.filter(isHardPropCollider);
      for (const sp of w.spawnPoints) {
        assert.ok(isSpawnPointSafe(w, sp), `seed ${seed}: ${sp.id} xavfsiz emas`);
        assert.ok(
          isCapsuleClearOfBoxes(hardCols, sp.x, sp.y + 0.02, sp.z, SPAWN_CLEARANCE_RADIUS, PLAYER_HEIGHT),
          `seed ${seed}: ${sp.id} atrofida log/stump collideri bor`,
        );
      }

      // Determinizm: vegetation ikki marta bir xil prop colliderlarni beradi
      const terrain = buildForestSquareTerrain(seed);
      const poi = buildForestSquarePOILayout(terrain, seed, w.chunkSize);
      const mk = () =>
        buildForestSquareVegetation({
          terrain,
          seed,
          poiSites: getForestSquarePoiSites(seed),
          structureColliders: poi.colliders,
          roadDistSampler: (x, z) => sampleForestSquareRoad(x, z, seed).dist,
          chunkSize: w.chunkSize,
        });
      const vA = mk();
      const vB = mk();
      assert.deepEqual(vA.propColliders, vB.propColliders);
      assert.deepEqual(vA.visuals, vB.visuals);
    }
  });

  it("5. Daraxt (565), tosh (95), konteyner (26), spawn (36) soni o'zgarmagan; yumshoq qatlamlarda (bush/fern/grass/leaf/pebble) collider yo'q", () => {
    for (const seed of SEEDS) {
      const w = createForestSquareWorld({ publicLayoutSeed: seed });
      const trees = w.colliders.filter((c) => c.tag === 'tree' && /^sq_tree_\d+$/.test(c.id));
      const rocks = w.colliders.filter((c) => c.tag === 'rock' && /^sq_rock_\d+$/.test(c.id));
      assert.equal(trees.length, 565, `seed ${seed}: daraxt colliderlari`);
      assert.equal(rocks.length, 95, `seed ${seed}: tosh colliderlari`);
      assert.equal(w.visuals.filter((v) => v.category === 'tree' && v.id.startsWith('sq_tree_')).length, 565);
      assert.equal(w.visuals.filter((v) => v.category === 'rock' && v.id.startsWith('sq_rock_')).length, 95);
      assert.equal(w.containerLocations.length, 26, `seed ${seed}: konteynerlar`);
      assert.equal(w.spawnPoints.length, 36);

      const softIds = new Set(w.visuals.filter((v) => SOFT_PREFABS.has(v.prefabId)).map((v) => v.sourceObjectId));
      assert.ok(softIds.size > 500, `seed ${seed}: yumshoq qatlam visuallari mavjud`);
      for (const c of w.colliders) {
        assert.ok(
          c.sourceObjectId === undefined || !softIds.has(c.sourceObjectId),
          `seed ${seed}: yumshoq qatlam ${c.sourceObjectId} uchun collider bo'lmasligi shart`,
        );
        assert.ok(!/^sq_(bush|fern|grass|pebble|leaf)_/.test(c.id), `seed ${seed}: ${c.id}`);
      }
    }
  });

  it("6. Collider izi (footprint) vizual izdan 0.15 m dan ortiq chiqmaydi va balandligi vizual tepadan oshmaydi (ko'rinmas devor yo'q)", () => {
    for (const seed of SEEDS) {
      const w = createForestSquareWorld({ publicLayoutSeed: seed });
      const bySource = groupBySource(w.colliders.filter(isHardPropCollider));
      for (const v of hardVisuals(w)) {
        const cols = bySource.get(v.sourceObjectId) ?? [];
        if (v.prefabId === FALLEN_LOG_PREFAB_ID) {
          const fp = getFallenLogFootprint(v.transform, w.terrain);
          for (const c of cols) {
            for (const [x, z] of [
              [c.min.x, c.min.z],
              [c.max.x, c.min.z],
              [c.min.x, c.max.z],
              [c.max.x, c.max.z],
            ] as const) {
              const d = distToLogFootprint(fp, x, z).dist;
              assert.ok(d <= 0.15, `seed ${seed}: ${c.id} burchagi vizualdan ${d.toFixed(3)} m tashqarida`);
            }
            assert.ok(c.max.y <= fp.topY + 0.02, `seed ${seed}: ${c.id} max.y vizual tepadan baland`);
            const gy = sampleTerrainHeight(w.terrain, (c.min.x + c.max.x) / 2, (c.min.z + c.max.z) / 2);
            assert.ok(c.max.y - gy <= 0.85, `seed ${seed}: ${c.id} past prop bo'lishi kerak`);
          }
        } else {
          const { position, scale } = v.transform;
          const r = TREE_STUMP_BASE_RADIUS * scale.x;
          for (const c of cols) {
            const corner = Math.hypot(c.max.x - position.x, c.max.z - position.z);
            assert.ok(corner - r <= 0.15, `seed ${seed}: ${c.id} burchagi vizualdan ${(corner - r).toFixed(3)} m tashqarida`);
            assert.ok(c.max.y <= position.y + TREE_STUMP_TOP_Y * scale.y + 0.02);
          }
        }
      }
    }
  });

  it("7. Segmentlash yaw ga bog'liq: o'q bo'ylab (yaw=0) 1 segment, diagonal (yaw=π/4) ko'p segment; stump bitta quti", () => {
    const base = { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const axis = buildFallenLogColliders('t_log', { ...base, yaw: 0 });
    assert.equal(axis.length, 1);
    assert.ok(Math.abs(axis[0].max.x - axis[0].min.x - 2 * 1.349) < 0.01);
    assert.ok(Math.abs(axis[0].max.z - axis[0].min.z - 2 * 0.27) < 0.01);
    const diag = buildFallenLogColliders('t_log', { ...base, yaw: Math.PI / 4 });
    assert.ok(diag.length >= 8, `diagonal log segmentlari: ${diag.length}`);
    for (const c of diag) assert.equal(c.sourceObjectId, 't_log');
    const stump = buildTreeStumpCollider('t_stump', { ...base, yaw: 1.1 });
    assert.equal(stump.length, 1);
    assert.equal(stump[0].id, 't_stump:col');
    assert.ok(Math.abs(stump[0].max.x - stump[0].min.x - 2 * 0.8 * 0.42) < 0.01);
  });

  it("8. NavGraph world.colliders dan foydalanadi: botlar yo'li log orqali kesib o'tmaydi (seed 6501)", () => {
    const w = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const nav = new NavGraph(w);
    const bySource = groupBySource(w.colliders.filter(isHardPropCollider));
    let tested = 0;
    for (const v of hardVisuals(w)) {
      if (v.prefabId !== FALLEN_LOG_PREFAB_ID) continue;
      const fp = getFallenLogFootprint(v.transform, w.terrain);
      const cx = (fp.a.x + fp.b.x) / 2;
      const cz = (fp.a.z + fp.b.z) / 2;
      const len = Math.hypot(fp.b.x - fp.a.x, fp.b.z - fp.a.z);
      const nx = -(fp.b.z - fp.a.z) / len;
      const nz = (fp.b.x - fp.a.x) / len;
      const d = fp.halfWidth + PLAYER_RADIUS + 0.9;
      const a = { x: cx + nx * d, y: 0, z: cz + nz * d };
      const b = { x: cx - nx * d, y: 0, z: cz - nz * d };
      a.y = sampleTerrainHeight(w.terrain, a.x, a.z);
      b.y = sampleTerrainHeight(w.terrain, b.x, b.z);
      if (collidesAtWorld(w, a.x, a.y + 0.05, a.z) || collidesAtWorld(w, b.x, b.y + 0.05, b.z)) continue;
      assert.ok(bySource.has(v.sourceObjectId));
      assert.equal(nav.segmentClear(a, b), false, `${v.sourceObjectId}: NavGraph segmenti log orqali o'tmasligi shart`);
      tested++;
    }
    assert.ok(tested >= 20, `kamida 20 ta log NavGraph orqali sinalishi shart (tested=${tested})`);
  });
});
