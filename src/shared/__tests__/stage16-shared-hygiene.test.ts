import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSeededRng, q3 } from '../math';
import { pointInsideCollider, rayBox, stepProjectileInWorld } from '../physics';
import { buildSurvivalZoneTimeline } from '../survival/zone';
import { createGroundedRockCollider, createGroundedTreeCollider, sampleTerrainHeight } from '../terrain';
import {
  createSeededRng as createSeededRngFromWorld,
  createWorldDefinition,
  sampleTerrainHeight as sampleTerrainHeightFromWorld,
  type ColliderBox,
  type WorldDefinition,
} from '../world';

/** groundCover.ts dagi eski xususiy `makeRng` nusxasi (`seed | 0`). */
function legacyGroundCoverRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** survival/zone.ts dagi eski xususiy `mulberry32` nusxasi (`seed >>> 0 || 1`). */
function legacyZoneRng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = [0, 1, 5, -1, 0xffffffff, 0x1_0000_0005, 6501, 123456789, 2147483647, -2147483648];
const S2 = Math.SQRT1_2;

function sequence(rng: () => number, n = 64): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng());
  return out;
}

/** Heightfield dunyo + faqat berilgan kollayderlar (spatial index yangi obyekt uchun qayta quriladi). */
function worldWith(colliders: ColliderBox[]): WorldDefinition {
  const base = createWorldDefinition({ mapId: 'forest_technical', publicLayoutSeed: 6501 } as never);
  return { ...base, colliders };
}

/** Gorizontal parvoz: har tikdan so'ng vertikal tezlik nolga qaytariladi (tortishish yerga tushirib qo'ymasin). */
function flyGrenade(world: WorldDefinition, pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }, ticks = 60) {
  const g = { pos: { ...pos }, vel: { ...vel } };
  let bounced = false;
  for (let i = 0; i < ticks; i++) {
    if (stepProjectileInWorld(g, 1 / 60, world)) bounced = true;
    g.vel.y = 0;
  }
  return { g, bounced };
}

describe('Bosqich 16 — umumiy kod gigiyenasi (RNG, q3, hit-shakl granata)', () => {
  it('1. createSeededRng: world.ts re-eksporti math.ts bilan bir xil funksiya', () => {
    assert.equal(createSeededRngFromWorld, createSeededRng);
    assert.equal(sampleTerrainHeightFromWorld, sampleTerrainHeight);
    assert.equal(q3(1.23456), 1.235);
  });

  it('2. groundCover ning eski xususiy RNG ketma-ketligi umumiy RNG bilan bit-mos', () => {
    for (const seed of SEEDS) {
      assert.deepEqual(sequence(createSeededRng(seed)), sequence(legacyGroundCoverRng(seed)), `seed ${seed}`);
    }
  });

  it('3. zone ning eski RNG si: `createSeededRng((seed >>> 0) || 1)` bilan bit-mos; urug‘ 0 ≡ 1', () => {
    for (const seed of SEEDS) {
      assert.deepEqual(sequence(createSeededRng((seed >>> 0) || 1)), sequence(legacyZoneRng(seed)), `seed ${seed}`);
    }
    // Urug' 0 holati: jadval urug' 1 bilan bir xil, 2 bilan farqli
    const z0 = buildSurvivalZoneTimeline(0, 600, 120);
    assert.deepEqual(z0, buildSurvivalZoneTimeline(1, 600, 120));
    assert.notDeepEqual(z0, buildSurvivalZoneTimeline(2, 600, 120));
    // 32-bit o'ram: 0x1_0000_0005 >>> 0 === 5, -1 >>> 0 === 0xffffffff
    assert.deepEqual(buildSurvivalZoneTimeline(0x1_0000_0005, 600, 120), buildSurvivalZoneTimeline(5, 600, 120));
    assert.deepEqual(buildSurvivalZoneTimeline(-1, 600, 120), buildSurvivalZoneTimeline(0xffffffff, 600, 120));
  });

  it('4. pointInsideCollider: silindr/ellipsoid/OBB/gable burchaklari bo‘sh, shaklsiz quti to‘liq', () => {
    const terrain = createWorldDefinition({ mapId: 'forest_technical', publicLayoutSeed: 6501 } as never).terrain;
    const tree = createGroundedTreeCollider('t', terrain, 10, 10, 0.4, 4.5);
    const y = tree.min.y + 1.5;
    assert.equal(pointInsideCollider(tree, { x: 10.1, y, z: 10 }), true, 'tana ichi');
    assert.equal(pointInsideCollider(tree, { x: 10.38, y, z: 9.62 }), false, 'quti burchagi (masofa 0.54 > 0.48)');
    assert.equal(pointInsideCollider(tree, { x: 10.1, y: tree.max.y + 0.2, z: 10 }), false, 'tepasidan yuqori');
    const plain: ColliderBox = { ...tree };
    delete plain.hit;
    assert.equal(pointInsideCollider(plain, { x: 10.38, y, z: 9.62 }), true, 'shaklsiz quti: burchak ham to‘siq');

    const rock = createGroundedRockCollider('r', terrain, 20, 20, { x: 2, y: 1.2, z: 1.6 });
    const rh = rock.hit as { kind: 'ellipsoid'; cx: number; cy: number; cz: number; rx: number; ry: number; rz: number };
    assert.equal(pointInsideCollider(rock, { x: rh.cx, y: rh.cy, z: rh.cz }), true, 'tosh markazi');
    assert.equal(
      pointInsideCollider(rock, { x: rock.max.x - 0.02, y: rock.max.y - 0.02, z: rock.max.z - 0.02 }),
      false,
      'tosh qutisining burchagi',
    );

    // 45° burilgan devor 4 x 2 x 0.2: AABB ≈ ±1.49, OBB qalinligi ±0.1 (+0.08 pad)
    const yaw = Math.PI / 4;
    const obb: ColliderBox = {
      id: 'w',
      tag: 'structure',
      mat: 'wall',
      min: { x: -1.49, y: 0, z: -1.49 },
      max: { x: 1.49, y: 2, z: 1.49 },
      hit: { kind: 'obb', cx: 0, cy: 1, cz: 0, hx: 2, hy: 1, hz: 0.1, yaw },
    };
    const ax = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const az = { x: Math.sin(yaw), z: Math.cos(yaw) };
    assert.equal(pointInsideCollider(obb, { x: 1.2 * ax.x, y: 1, z: 1.2 * ax.z }), true, 'devor bo‘ylab');
    assert.equal(pointInsideCollider(obb, { x: 0.5 * az.x, y: 1, z: 0.5 * az.z }), false, 'devordan 0.5 m narida (AABB ichida)');
    assert.equal(pointInsideCollider(obb, { x: 0.12 * az.x, y: 1, z: 0.12 * az.z }), true, 'pad ichida (0.12 < 0.18)');

    // Tom old devori: asos ±2 m, y 0..2, qalinlik ±0.1
    const gable: ColliderBox = {
      id: 'g',
      tag: 'structure',
      mat: 'wall',
      min: { x: -2, y: 0, z: -0.1 },
      max: { x: 2, y: 2, z: 0.1 },
      hit: { kind: 'gable', cx: 0, cz: 0, hx: 2, baseY: 0, apexY: 2, hz: 0.1, yaw: 0 },
    };
    assert.equal(pointInsideCollider(gable, { x: 0, y: 1, z: 0 }), true, 'uchburchak ichi');
    assert.equal(pointInsideCollider(gable, { x: 1.5, y: 1.5, z: 0 }), false, 'qiya qirra ustidagi bo‘sh burchak');
    assert.equal(pointInsideCollider(gable, { x: 1.5, y: 0.3, z: 0 }), true, 'asos yaqinida');
  });

  it('5. Granata daraxt qutisining bo‘sh burchagidan o‘tadi, tanaga tegsa qaytadi; shaklsiz quti eskicha', () => {
    const base = createWorldDefinition({ mapId: 'forest_technical', publicLayoutSeed: 6501 } as never);
    const tree = createGroundedTreeCollider('t', base.terrain, 10, 10, 0.4, 4.5);
    const world = worldWith([tree]);

    // Diagonal (+x, +z) yo'l x − z = 0.8 chizig'i bo'ylab: (10.4, 9.6) quti burchagidan o'tadi (pad bilan
    // AABB ±0.48 — burchak (10.48, 9.52) chiziqning narigi tomonida), silindr markazigacha masofa 0.566 > 0.48.
    // 3 m/s — pastki qadamlar 0.05 m, o'q bo'yicha "zinapoya" chetlanishi ≈ 0.035 m.
    let groundMax = -Infinity;
    for (let s = 0; s <= 20; s++) {
      const x = 8.8 + s * 0.15;
      groundMax = Math.max(groundMax, sampleTerrainHeight(base.terrain, x, x - 0.8));
    }
    const y = Math.max(groundMax + 1.0, tree.min.y + 1.5);
    assert.ok(y < tree.max.y - 0.5, 'granata balandligi tana oralig‘ida');
    const start = { x: 8.8, y, z: 8.0 }; // x − z = 0.8
    const diag = { x: 3 * S2, y: 0, z: 3 * S2 };
    const corner = flyGrenade(world, start, diag, 60);
    assert.equal(corner.bounced, false, 'bo‘sh burchak: qaytmaydi');
    assert.ok(corner.g.vel.x > 2 && corner.g.vel.z > 2, 'gorizontal tezlik saqlanadi');
    assert.ok(corner.g.pos.x > 10.5 && corner.g.pos.z > 9.7, 'daraxt yonidan o‘tib ketdi');

    // Shaklsiz quti (eski xatti-harakat): shu yo'lda burchakka uriladi
    const plain: ColliderBox = { ...tree };
    delete plain.hit;
    const old = flyGrenade(worldWith([plain]), start, diag, 60);
    assert.equal(old.bounced, true, 'shaklsiz AABB burchagi granatani qaytaradi');
    assert.ok(old.g.vel.x < 0 || old.g.vel.z < 0, 'o‘q bo‘yicha qaytish');

    // To'g'ridan-to'g'ri tanaga: radial normal bilan qaytadi (vel.x teskari), tana ichiga kirmaydi
    const head = flyGrenade(world, { x: 8.5, y, z: 10 }, { x: 3, y: 0, z: 0 }, 60);
    assert.equal(head.bounced, true, 'tana: qaytadi');
    assert.ok(head.g.vel.x < 0, 'tezlik teskari');
    assert.ok(head.g.pos.x < 10 - 0.4, 'tana ichiga kirmagan');
    assert.ok(Math.abs(head.g.vel.z) < 1e-6, 'markazga to‘g‘ri urilganda yon tezlik hosil bo‘lmaydi');

    // Qiyshiq urilish: radial normal granatani yonga og'diradi (AABB yuzasi bo'lsa vel.z o'zgarmasdi)
    const glance = flyGrenade(world, { x: 8.5, y, z: 10.3 }, { x: 3, y: 0, z: 0 }, 60);
    assert.equal(glance.bounced, true);
    assert.ok(glance.g.vel.z > 0.2, `radial normal yon tezlik beradi (vel.z=${glance.g.vel.z.toFixed(3)})`);
  });

  it('6. rayBox LOS uchun ham ishlaydi (validation.ts dagi nusxa olib tashlandi)', () => {
    const hit = rayBox({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: -1 }, { x: 1, y: 2, z: 1 }, 20);
    assert.ok(hit && Math.abs(hit.t - 4) < 1e-9 && hit.nz === -1);
    assert.equal(rayBox({ x: 5, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: -1 }, { x: 1, y: 2, z: 1 }, 20), null);
  });
});
