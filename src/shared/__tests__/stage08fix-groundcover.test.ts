import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildForestSquareVegetation,
  createForestSquareWorld,
  getForestSquarePoiSites,
  sampleForestSquareRoad,
  type ForestSquareWorldDefinition,
} from '../forestSquare';
import {
  buildForestSquareGroundCover,
  buildGroundCoverField,
  getForestSquareGroundCoverInput,
  getGroundCoverSummary,
  groundCoverCategoryOf,
  GROUND_COVER_BASE_HEIGHT,
  GROUND_COVER_CHUNK_SIZE,
  GROUND_COVER_FLOWER_ROAD_MIN,
  GROUND_COVER_GROUND_TOUCH,
  GROUND_COVER_KINDS,
  GROUND_COVER_MAX_SCALE,
  GROUND_COVER_MAX_SLOPE_DEG,
  GROUND_COVER_PLAYABLE_LIMIT,
  GROUND_COVER_ROAD_STRIP,
  GROUND_COVER_STRIDE,
  type GroundCoverField,
  type GroundCoverKind,
} from '../groundCover';
import { sampleTerrainHeight, sampleTerrainSlopeDeg } from '../terrain';
import { computeGameplayHash, type ColliderBox } from '../world';

const SEEDS = [6501, 1, 42, 1337, 2024, 9001, 77777, 123456];
const FLOWER_KINDS: GroundCoverKind[] = ['flower_white', 'flower_yellow', 'flower_purple'];

interface Inst {
  kind: GroundCoverKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

function flatten(field: GroundCoverField): Inst[] {
  const out: Inst[] = [];
  for (const ch of field.chunks) {
    for (const kind of GROUND_COVER_KINDS) {
      const a = ch.batches[kind];
      if (!a) continue;
      for (let i = 0; i < a.length; i += GROUND_COVER_STRIDE) {
        out.push({ kind, x: a[i]!, y: a[i + 1]!, z: a[i + 2]!, yaw: a[i + 3]!, scale: a[i + 4]! });
      }
    }
  }
  return out;
}

const worldCache = new Map<number, ForestSquareWorldDefinition>();
const fieldCache = new Map<number, GroundCoverField>();
function getWorld(seed: number): ForestSquareWorldDefinition {
  let w = worldCache.get(seed);
  if (!w) {
    w = createForestSquareWorld({ publicLayoutSeed: seed });
    worldCache.set(seed, w);
  }
  return w;
}
function getField(seed: number): GroundCoverField {
  let f = fieldCache.get(seed);
  if (!f) {
    f = buildForestSquareGroundCover(getWorld(seed));
    fieldCache.set(seed, f);
  }
  return f;
}

/** Hard colliders that physically sit on the ground at (x,z) — same rule a player sees. */
function groundTouchingHardColliders(world: ForestSquareWorldDefinition): ColliderBox[] {
  return world.colliders.filter((c) => c.tag !== 'ground' && c.tag !== 'boundary');
}

function sameField(a: GroundCoverField, b: GroundCoverField): boolean {
  if (a.total !== b.total || a.chunks.length !== b.chunks.length) return false;
  for (let i = 0; i < a.chunks.length; i++) {
    const ca = a.chunks[i]!;
    const cb = b.chunks[i]!;
    if (ca.key !== cb.key || ca.minY !== cb.minY || ca.maxY !== cb.maxY) return false;
    for (const kind of GROUND_COVER_KINDS) {
      const xa = ca.batches[kind];
      const xb = cb.batches[kind];
      if (!xa && !xb) continue;
      if (!xa || !xb || xa.length !== xb.length) return false;
      const ba = Buffer.from(xa.buffer, xa.byteOffset, xa.byteLength);
      const bb = Buffer.from(xb.buffer, xb.byteOffset, xb.byteLength);
      if (!ba.equals(bb)) return false;
    }
  }
  return true;
}

describe('STAGE 08-FIX: yer qoplami (maysa, gullar, kichik paporotniklar)', () => {
  it('determinizm: bir xil seed → bir xil Float32Array baytlari; kesh bir xil obyektni qaytaradi', () => {
    const w = getWorld(6501);
    const a = buildGroundCoverField(getForestSquareGroundCoverInput(w));
    const b = buildGroundCoverField(getForestSquareGroundCoverInput(w));
    assert.ok(sameField(a, b), 'ikki marta qurilgan maydon bir xil bo‘lishi kerak');
    assert.ok(sameField(a, getField(6501)), 'keshlangan maydon ham bir xil');
    assert.equal(buildForestSquareGroundCover(w), buildForestSquareGroundCover(w));
    assert.equal(a.seed, 6501);
    assert.equal(a.chunkSize, GROUND_COVER_CHUNK_SIZE);
  });

  it('turli seedlar turli yer qoplamini beradi', () => {
    const a = getField(6501);
    const b = getField(1);
    assert.equal(sameField(a, b), false);
    assert.notEqual(a.total, b.total);
  });

  it('8 seed: umumiy son 8k–20k (har seed ~19.2k ga kalibrlangan, 17k–20k); maysa ustun, gullar 6–10%, fern 6–18%', () => {
    for (const seed of SEEDS) {
      const f = getField(seed);
      const s = getGroundCoverSummary(f);
      assert.equal(s.total, f.total, `seed ${seed}: summary.total == field.total`);
      for (const kind of GROUND_COVER_KINDS) {
        assert.equal(s.counts[kind], f.counts[kind], `seed ${seed}: ${kind} soni mos`);
      }
      assert.ok(f.total >= 8000 && f.total <= 20000, `seed ${seed}: total=${f.total}`);
      assert.ok(f.total >= 17000, `seed ${seed}: kalibrlangan total=${f.total}`);
      assert.ok(s.byCategory.grass / s.total > 0.7, `seed ${seed}: maysa ulushi ${s.byCategory.grass / s.total}`);
      assert.ok(s.flowerFraction >= 0.06 && s.flowerFraction <= 0.1, `seed ${seed}: gul ulushi ${s.flowerFraction}`);
      const fernFrac = s.byCategory.fern / s.total;
      assert.ok(fernFrac >= 0.06 && fernFrac <= 0.18, `seed ${seed}: fern ulushi ${fernFrac}`);
      assert.ok(s.counts.grass_tuft > 0 && s.counts.grass_short > 0, `seed ${seed}: ikkala maysa turi bor`);
      assert.equal(s.instanceBytes, s.total * GROUND_COVER_STRIDE * 4);
    }
  });

  it('uchala gul rangi (oq/sariq/binafsha) har seedda ≥400 tadan (gul 8% × 19.2k ÷ 3 ≈ 510)', () => {
    for (const seed of SEEDS) {
      const f = getField(seed);
      for (const kind of FLOWER_KINDS) {
        assert.ok(f.counts[kind] >= 400, `seed ${seed}: ${kind}=${f.counts[kind]}`);
      }
    }
  });

  it('har bir instansiya: chegarada (|x|,|z|≤124), yo‘l yurish yo‘lagida emas, qiyalik ≤38°, Y = terrain balandligi', () => {
    for (const seed of SEEDS) {
      const w = getWorld(seed);
      for (const p of flatten(getField(seed))) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
        assert.ok(Math.abs(p.x) <= GROUND_COVER_PLAYABLE_LIMIT + 1e-3, `seed ${seed}: x=${p.x}`);
        assert.ok(Math.abs(p.z) <= GROUND_COVER_PLAYABLE_LIMIT + 1e-3, `seed ${seed}: z=${p.z}`);
        const rd = sampleForestSquareRoad(p.x, p.z, seed).dist;
        const minRoad = groundCoverCategoryOf(p.kind) === 'flower' ? GROUND_COVER_FLOWER_ROAD_MIN : GROUND_COVER_ROAD_STRIP;
        // Float32 rounding of x/z can move the point by ~4e-6 m.
        assert.ok(rd >= minRoad - 1e-3, `seed ${seed}: ${p.kind} yo‘l markazidan ${rd.toFixed(3)} m`);
        assert.ok(sampleTerrainSlopeDeg(w.terrain, p.x, p.z) <= GROUND_COVER_MAX_SLOPE_DEG + 0.5);
        assert.ok(Math.abs(sampleTerrainHeight(w.terrain, p.x, p.z) - p.y) < 2e-3, `seed ${seed}: Y terrainga yopishgan`);
      }
    }
  });

  it('hech bir instansiya yerga tegib turgan qattiq collider (bino poli, devor, daraxt, tosh, prop) ichida emas', () => {
    for (const seed of SEEDS) {
      const w = getWorld(seed);
      const cols = groundTouchingHardColliders(w);
      let floorsChecked = 0;
      for (const p of flatten(getField(seed))) {
        for (const c of cols) {
          if (p.x < c.min.x || p.x > c.max.x || p.z < c.min.z || p.z > c.max.z) continue;
          const g = p.y;
          const touches = c.min.y < g + GROUND_COVER_GROUND_TOUCH && c.max.y > g - 0.25;
          assert.equal(touches, false, `seed ${seed}: ${p.kind} (${p.x.toFixed(2)},${p.z.toFixed(2)}) collider ${c.id} ichida`);
        }
      }
      // Bino ichi: yer qavatidagi har bir pol plitasi ostida yer qoplami yo‘q.
      const floors = w.colliders.filter((c) => c.id.includes('floor_slab'));
      for (const fl of floors) {
        const g = sampleTerrainHeight(w.terrain, (fl.min.x + fl.max.x) / 2, (fl.min.z + fl.max.z) / 2);
        if (fl.min.y > g + GROUND_COVER_GROUND_TOUCH) continue; // 2-qavat poli
        floorsChecked++;
        for (const p of flatten(getField(seed))) {
          const inside = p.x > fl.min.x && p.x < fl.max.x && p.z > fl.min.z && p.z < fl.max.z;
          assert.equal(inside, false, `seed ${seed}: bino poli ${fl.id} ostida ${p.kind}`);
        }
      }
      assert.ok(floorsChecked >= 9, `seed ${seed}: kamida 9 bino yer-qavat poli tekshirildi (${floorsChecked})`);
    }
  });

  it('chunk metadata: kalit formati, instansiyalar chunk chegarasida, minY/maxY to‘g‘ri', () => {
    for (const seed of [6501, 42]) {
      const f = getField(seed);
      const keys = new Set<string>();
      for (const ch of f.chunks) {
        assert.equal(ch.key, `${ch.cx},${ch.cz}`);
        assert.ok(!keys.has(ch.key), 'takrorlanmas kalit');
        keys.add(ch.key);
        assert.equal(ch.maxX - ch.minX, GROUND_COVER_CHUNK_SIZE);
        assert.equal(ch.minX, ch.cx * GROUND_COVER_CHUNK_SIZE);
        assert.equal(ch.minZ, ch.cz * GROUND_COVER_CHUNK_SIZE);
        for (const kind of GROUND_COVER_KINDS) {
          const a = ch.batches[kind];
          if (!a) continue;
          assert.ok(a instanceof Float32Array && a.length > 0 && a.length % GROUND_COVER_STRIDE === 0);
          for (let i = 0; i < a.length; i += GROUND_COVER_STRIDE) {
            assert.ok(a[i]! >= ch.minX - 1e-3 && a[i]! <= ch.maxX + 1e-3);
            assert.ok(a[i + 2]! >= ch.minZ - 1e-3 && a[i + 2]! <= ch.maxZ + 1e-3);
            assert.ok(a[i + 1]! >= ch.minY - 1e-4 && a[i + 1]! <= ch.maxY + 1e-4);
          }
        }
      }
    }
  });

  it('PvP adolat: balandlik cheklovlari (maysa ≤0.45 m, gul ≤0.35 m, fern ≤0.6 m) va yaw/scale diapazoni', () => {
    const limitByCat = { grass: 0.45, flower: 0.35, fern: 0.6 } as const;
    for (const kind of GROUND_COVER_KINDS) {
      const cat = groundCoverCategoryOf(kind);
      assert.ok(GROUND_COVER_BASE_HEIGHT[kind] * GROUND_COVER_MAX_SCALE[kind] <= limitByCat[cat] + 1e-9, kind);
    }
    assert.ok(GROUND_COVER_MAX_SCALE.grass_tuft <= 1.4 && GROUND_COVER_MAX_SCALE.grass_short <= 1.4);
    assert.ok(GROUND_COVER_MAX_SCALE.fern_small <= 1.3);
    for (const k of FLOWER_KINDS) assert.ok(GROUND_COVER_MAX_SCALE[k] <= 1.3);
    for (const seed of SEEDS) {
      for (const p of flatten(getField(seed))) {
        assert.ok(p.scale > 0.3 && p.scale <= GROUND_COVER_MAX_SCALE[p.kind] + 1e-6, `${p.kind} scale=${p.scale}`);
        const h = p.scale * GROUND_COVER_BASE_HEIGHT[p.kind];
        assert.ok(h <= limitByCat[groundCoverCategoryOf(p.kind)] + 1e-6, `${p.kind} balandligi ${h}`);
        assert.ok(p.yaw >= 0 && p.yaw < Math.PI * 2 + 1e-6);
      }
    }
  });

  it('gullar kichik tabiiy guruhlarda: o‘rtacha eng yaqin qo‘shni masofasi bir tekis taqsimotdan ancha kichik, gilam yo‘q', () => {
    for (const seed of SEEDS) {
      const flowers = flatten(getField(seed)).filter((p) => groundCoverCategoryOf(p.kind) === 'flower');
      const cell = 2;
      const grid = new Map<string, Inst[]>();
      for (const p of flowers) {
        const k = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
        let b = grid.get(k);
        if (!b) grid.set(k, (b = []));
        b.push(p);
      }
      let sum = 0;
      for (const p of flowers) {
        const gx = Math.floor(p.x / cell);
        const gz = Math.floor(p.z / cell);
        let best = Infinity;
        for (let r = 1; r <= 8 && best > (r - 1) * cell; r++) {
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r && r > 1) continue;
              for (const q of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
                if (q === p) continue;
                const d = Math.hypot(q.x - p.x, q.z - p.z);
                if (d < best) best = d;
              }
            }
          }
        }
        sum += Math.min(best, 16);
      }
      const meanNN = sum / flowers.length;
      const area = (2 * GROUND_COVER_PLAYABLE_LIMIT) ** 2;
      const uniformNN = 0.5 * Math.sqrt(area / flowers.length);
      assert.ok(meanNN < uniformNN * 0.25, `seed ${seed}: meanNN=${meanNN.toFixed(3)} uniform=${uniformNN.toFixed(3)}`);
      // "Rangli gilam" yo‘q: hech bir 4×4 m katakda 24 tadan ortiq gul emas.
      const big = new Map<string, number>();
      for (const p of flowers) {
        const k = `${Math.floor(p.x / 4)},${Math.floor(p.z / 4)}`;
        big.set(k, (big.get(k) ?? 0) + 1);
      }
      const maxCell = Math.max(...big.values());
      assert.ok(maxCell <= 24, `seed ${seed}: 4×4 m katakda ${maxCell} gul`);
    }
  });

  it('fern_small daraxtlar tagida to‘plangan (maysadan ancha ko‘proq daraxt yaqinida)', () => {
    for (const seed of [6501, 1337]) {
      const w = getWorld(seed);
      const trees = w.visuals.filter(
        (v) => v.category === 'tree' && Math.abs(v.transform.position.x) <= 124 && Math.abs(v.transform.position.z) <= 124,
      );
      const near = (x: number, z: number) =>
        trees.some((t) => Math.hypot(t.transform.position.x - x, t.transform.position.z - z) < 3.6);
      const inst = flatten(getField(seed));
      const ferns = inst.filter((p) => p.kind === 'fern_small');
      const grass = inst.filter((p) => groundCoverCategoryOf(p.kind) === 'grass').filter((_, i) => i % 7 === 0);
      const fernNear = ferns.filter((p) => near(p.x, p.z)).length / ferns.length;
      const grassNear = grass.filter((p) => near(p.x, p.z)).length / grass.length;
      assert.ok(fernNear >= 0.7, `seed ${seed}: fern daraxt yaqinida ${fernNear.toFixed(2)}`);
      assert.ok(fernNear > grassNear + 0.25, `seed ${seed}: fern ${fernNear.toFixed(2)} vs maysa ${grassNear.toFixed(2)}`);
    }
  });

  it('chunk ichida aralashtirilgan: har qanday prefiks bir tekis kichik namuna (density preset uchun)', () => {
    const f = getField(6501);
    let checked = 0;
    let devSum = 0;
    for (const ch of f.chunks) {
      const a = ch.batches.grass_tuft;
      if (!a || a.length / GROUND_COVER_STRIDE < 40) continue;
      const n = a.length / GROUND_COVER_STRIDE;
      const half = Math.floor(n * 0.3);
      let mxAll = 0;
      let mzAll = 0;
      let mxPre = 0;
      let mzPre = 0;
      for (let i = 0; i < n; i++) {
        mxAll += a[i * GROUND_COVER_STRIDE]!;
        mzAll += a[i * GROUND_COVER_STRIDE + 2]!;
        if (i < half) {
          mxPre += a[i * GROUND_COVER_STRIDE]!;
          mzPre += a[i * GROUND_COVER_STRIDE + 2]!;
        }
      }
      devSum += Math.hypot(mxAll / n - mxPre / half, mzAll / n - mzPre / half);
      checked++;
    }
    assert.ok(checked >= 20, `tekshirilgan chunklar: ${checked}`);
    // Uniform 16 m chunk: prefix-30% centroid deviates ~ 4.6/sqrt(0.3n) ≈ 1.2 m; sorted order would give ≫ 3 m.
    assert.ok(devSum / checked < 2.2, `o‘rtacha og‘ish ${(devSum / checked).toFixed(2)} m`);
  });

  it('densityScale yer qoplami sonini mos ravishda kamaytiradi', () => {
    const w = getWorld(6501);
    const full = getField(6501).total;
    const half = buildGroundCoverField(getForestSquareGroundCoverInput(w), { densityScale: 0.5 }).total;
    assert.ok(half > full * 0.3 && half < full * 0.7, `0.5 → ${half} / ${full}`);
  });

  it('faqat vizual qatlam: world.visuals, gameplayHash va vegetatsiya RNG o‘zgarmaydi', () => {
    const seed = 6501;
    const w = getWorld(seed);
    const hashBefore = w.gameplayHash;
    const visualsBefore = w.visuals.length;
    const vegInput = {
      terrain: w.terrain,
      seed,
      poiSites: getForestSquarePoiSites(seed),
      structureColliders: w.poiLayout.colliders,
      roadDistSampler: (x: number, z: number) => sampleForestSquareRoad(x, z, seed).dist,
      chunkSize: w.chunkSize,
    };
    const vegBefore = JSON.stringify(buildForestSquareVegetation(vegInput).visuals);

    buildGroundCoverField(getForestSquareGroundCoverInput(w));
    buildForestSquareGroundCover(w);

    const vegAfter = JSON.stringify(buildForestSquareVegetation(vegInput).visuals);
    assert.equal(vegAfter, vegBefore, 'vegetatsiya RNG ketma-ketligi o‘zgarmagan');
    assert.equal(w.gameplayHash, hashBefore);
    assert.equal(w.visuals.length, visualsBefore);
    assert.ok(!w.visuals.some((v) => /ground_cover|grass_tuft|grass_short|fern_small|flower_/.test(v.prefabId)));
    const { gameplayHash: _h, visuals: _v, name: _n, chunkSize: _c, ...rest } = w;
    assert.equal(computeGameplayHash(rest), hashBefore, 'gameplayHash qayta hisoblanganda ham bir xil');
    const fresh = createForestSquareWorld({ publicLayoutSeed: seed });
    assert.equal(fresh.gameplayHash, hashBefore);
  });

  it('ishlash: seed 6501 uchun generatsiya < 400 ms (Node), xotira ~20 bayt/instansiya', () => {
    const w = getWorld(6501);
    const input = getForestSquareGroundCoverInput(w);
    const t0 = performance.now();
    const f = buildGroundCoverField(input);
    const ms = performance.now() - t0;
    const s = getGroundCoverSummary(f);
    assert.ok(ms < 400, `generatsiya ${ms.toFixed(1)} ms`);
    assert.ok(s.instanceBytes <= 20000 * GROUND_COVER_STRIDE * 4);
    console.log(
      `[groundcover] seed 6501: ${ms.toFixed(1)} ms, total=${s.total}, ${JSON.stringify(s.counts)}, bytes=${s.instanceBytes}`,
    );
  });
});
