import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTreeStumpCollider } from '../forestProps';
import { rayBox, rayCollider, rayCylinderY, rayEllipsoid, rayGable, rayObbY, raycastWorld } from '../physics';
import { localBoxToWorldCollider } from '../structures/manifests';
import { createGroundedRockCollider, createGroundedTreeCollider } from '../terrain';
import { computeGameplayHash, createWorldDefinition, type ColliderBox } from '../world';

const DIR_Z: { x: number; y: number; z: number } = { x: 0, y: 0, z: 1 };
const S2 = Math.SQRT1_2;
const DIAG: { x: number; y: number; z: number } = { x: S2, y: 0, z: S2 };

describe('Bosqich 14 — o‘q uchun aniq hit-shakllar (daraxt, tosh, burilgan quti, tom old devori)', () => {
  it('1. Silindr: markazdan o‘tgan nur tegadi, quti burchagidan o‘tgan nur tegmaydi', () => {
    // r=0.4, y 0..5; quti burchagi (0.38, 0.38) silindr tashqarisida (masofa 0.54 > 0.4)
    const hitCenter = rayCylinderY({ x: 0, y: 1, z: -5 }, DIR_Z, 0, 0, 0.4, 0, 5, 20);
    assert.ok(hitCenter && Math.abs(hitCenter.t - 4.6) < 1e-6, 'markaz: t = 4.6');
    assert.ok(hitCenter!.nz < -0.99, 'normal nur tomon');
    // Diagonal nur: chiziq x − z = 0.8 → markazgacha masofa 0.566 > 0.4, lekin kvadrat quti burchagidan o'tadi
    const corner = rayCylinderY({ x: -1.6, y: 1, z: -2.4 }, DIAG, 0, 0, 0.4, 0, 5, 20);
    assert.equal(corner, null, 'burchak: tegmaydi');
    const cornerBox = rayCollider(
      { id: 'c', tag: 'tree', mat: 'wall', min: { x: -0.4, y: 0, z: -0.4 }, max: { x: 0.4, y: 5, z: 0.4 } },
      { x: -1.6, y: 1, z: -2.4 },
      DIAG,
      20,
    );
    assert.ok(cornerBox, 'shaklsiz quti bu nurga tegadi (eski xatti-harakat)');
    const above = rayCylinderY({ x: 0, y: 6, z: -5 }, DIR_Z, 0, 0, 0.4, 0, 5, 20);
    assert.equal(above, null, 'tepadan o‘tgan nur tegmaydi');
    // Tepadan pastga tushayotgan nur qopqoqqa tegadi
    const top = rayCylinderY({ x: 0.1, y: 8, z: 0 }, { x: 0, y: -1, z: 0 }, 0, 0, 0.4, 0, 5, 20);
    assert.ok(top && Math.abs(top.t - 3) < 1e-6 && top.ny === 1);
  });

  it('2. Ellipsoid: markaz tegadi, quti burchagi tegmaydi; OBB: burilgan devor burchagi tegmaydi', () => {
    const e = (x: number, y: number) => rayEllipsoid({ x, y, z: -5 }, DIR_Z, 0, 0.5, 0, 1, 0.5, 0.8, 20);
    assert.ok(e(0, 0.5), 'markaz');
    assert.equal(e(0.9, 0.95), null, 'burchak (0.9, 0.45 balandda) ellipsoid tashqarisida');
    assert.ok(e(0.5, 0.5), 'yarim radiusda tegadi');

    // 4 m x 0.2 m devor, 45° burilgan: AABB ≈ 2.97 x 2.97. Burchak nuqtasi (1.3, 1.3) OBB tashqarisida.
    const yaw = Math.PI / 4;
    const hitMid = rayObbY({ x: 0, y: 1, z: -5 }, DIR_Z, 0, 1, 0, 2, 1, 0.1, yaw, 20);
    assert.ok(hitMid, 'devor markazi tegadi');
    // Devorga parallel, undan 0.3 m narida o'tgan nur: AABB burchaklaridan o'tadi, OBB (qalinligi 0.2) ga tegmaydi
    const ax = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const az = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const par = { x: -3 * ax.x + 0.3 * az.x, y: 1, z: -3 * ax.z + 0.3 * az.z };
    const parDir = { x: ax.x, y: 0, z: ax.z };
    const miss = rayObbY(par, parDir, 0, 1, 0, 2, 1, 0.1, yaw, 20);
    assert.equal(miss, null, 'devorga parallel 0.3 m narida — OBB ga tegmaydi');
    const aabbHit = rayCollider(
      { id: 'w', tag: 'structure', mat: 'wall', min: { x: -1.49, y: 0, z: -1.49 }, max: { x: 1.49, y: 2, z: 1.49 } },
      par,
      parDir,
      20,
    );
    assert.ok(aabbHit, 'shaklsiz AABB shu nurga tegardi');
    const through = rayObbY({ x: -3 * az.x, y: 1, z: -3 * az.z }, { x: az.x, y: 0, z: az.z }, 0, 1, 0, 2, 1, 0.1, yaw, 20);
    assert.ok(through && Math.abs(through.t - 2.9) < 1e-6, 'devorga perpendikulyar nur qalinlik yuzasida tegadi');
  });

  it('3. Gable (uchburchak): uchi ostidan o‘tgan nur tegadi, quti yuqori burchagidan o‘tgan nur tegmaydi', () => {
    // hx 2.41, asos y -0.46, uch y 1.68, qalinlik ±0.1, yaw 0
    const g = (x: number, y: number) => rayGable({ x, y, z: -5 }, DIR_Z, 0, 0, 2.41, -0.46, 1.68, 0.1, 0, 20);
    assert.ok(g(0, 1.5), 'uch yaqinida markaz');
    assert.ok(g(-1.0, 0.0), 'asos yaqinida chap');
    assert.equal(g(1.9, 1.4), null, 'quti yuqori burchagi uchburchak tashqarisida');
    assert.equal(g(0, -0.6), null, 'asos ostidan o‘tgan nur tegmaydi');
  });

  it('4. Kollayder yaratuvchilar hit-shakl beradi; rayCollider AABB tegsa ham shakl tegmasa null', () => {
    const terrain = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 } as never).terrain;
    const tree = createGroundedTreeCollider('t', terrain, 10, 10, 0.4, 4.5);
    assert.equal(tree.hit?.kind, 'cylinder');
    const rock = createGroundedRockCollider('r', terrain, 20, 20, { x: 2, y: 1.2, z: 1.6 });
    assert.equal(rock.hit?.kind, 'ellipsoid');
    // Daraxt qutisining burchagi orqali o'tgan nur: AABB tegadi, silindr tegmaydi
    const y = tree.min.y + 1;
    const corner = rayCollider(tree, { x: 10 - 1.6, y, z: 10 - 2.4 }, DIAG, 30);
    assert.equal(corner, null);
    const center = rayCollider(tree, { x: 10, y, z: 0 }, DIR_Z, 30);
    assert.ok(center && Math.abs(center.t - (10 - 0.4)) < 1e-6);

    // Kardinal burilishda OBB kerak emas, 30° da OBB
    const spec = { name: 'w', center: [0, 1, 0] as [number, number, number], size: [4, 2, 0.2] as [number, number, number] };
    const straight = localBoxToWorldCollider('a', 'a', spec, { x: 0, y: 0, z: 0 }, Math.PI / 2);
    assert.equal(straight.hit, undefined);
    const turned = localBoxToWorldCollider('b', 'b', spec, { x: 0, y: 0, z: 0 }, Math.PI / 6);
    assert.equal(turned.hit?.kind, 'obb');
    const gable = localBoxToWorldCollider(
      'g',
      'g',
      { ...spec, gable: { halfWidth: 2.41, baseY: -0.46, apexY: 1.68 } },
      { x: 0, y: 3, z: 0 },
      0,
    );
    assert.equal(gable.hit?.kind, 'gable');
  });

  it('5. Forest Square: har bir daraxt/tosh kollayderida shakl bor va raycastWorld quti burchagini e‘tiborsiz qoldiradi', () => {
    const world = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 } as never);
    const trees = world.colliders.filter((c) => c.tag === 'tree');
    const rocks = world.colliders.filter((c) => c.tag === 'rock');
    assert.ok(trees.length > 100 && rocks.length > 20);
    for (const c of trees) assert.equal(c.hit?.kind, 'cylinder', `daraxt ${c.id}`);
    for (const c of rocks) assert.equal(c.hit?.kind, 'ellipsoid', `tosh ${c.id}`);
    for (const c of world.colliders) {
      if (c.hit?.kind === 'gable') {
        assert.ok(c.hit.apexY > c.hit.baseY);
      }
    }
    const gables = world.colliders.filter((c) => c.hit?.kind === 'gable');
    assert.ok(gables.length >= 2, 'tom old devorlari gable shaklida');

    // Daraxt qutisi burchagidan o'tgan nur: endi daraxtga tegmaydi (boshqa narsaga tegishi mumkin, lekin shu daraxtga emas)
    let checked = 0;
    for (const tree of trees.slice(0, 60)) {
      const h = tree.hit as { kind: 'cylinder'; cx: number; cz: number; r: number };
      // Diagonal nur, markazdan 1.25·r perpendikulyar masofada: kvadrat burchagidan o'tadi, silindrdan emas
      const off = h.r * 1.25;
      const origin = { x: h.cx + off * S2 - 3 * S2, y: tree.min.y + 1.2, z: h.cz - off * S2 - 3 * S2 };
      const hit = raycastWorld(world, origin, DIAG, 6);
      if (hit && hit.colliderId === tree.id) {
        assert.fail(`daraxt ${tree.id}: quti burchagi orqali o‘tgan nur silindrga tegmasligi kerak`);
      }
      checked++;
    }
    assert.ok(checked >= 60);

    // Hit-shakl gameplayHash ga kiradi: shakl o'zgarsa (yoki olib tashlansa) xesh o'zgaradi
    const { gameplayHash: _h, visuals: _v, name: _n, chunkSize: _c, ...hashData } = world;
    assert.equal(computeGameplayHash(hashData), world.gameplayHash);
    const plain: ColliderBox = { ...trees[0]! };
    delete plain.hit;
    const withoutShape = computeGameplayHash({ ...hashData, colliders: [plain, ...world.colliders.slice(1)] });
    assert.notEqual(withoutShape, world.gameplayHash, 'hit-shakl olib tashlansa xesh o‘zgaradi');
    const t0 = trees[0]!;
    const h0 = t0.hit as { kind: 'cylinder'; cx: number; cz: number; r: number };
    const shrunk: ColliderBox = { ...t0, hit: { ...h0, r: h0.r - 0.05 } };
    const idx0 = world.colliders.indexOf(t0);
    const cols2 = world.colliders.slice();
    cols2[idx0] = shrunk;
    assert.notEqual(computeGameplayHash({ ...hashData, colliders: cols2 }), world.gameplayHash, 'silindr radiusi xeshga kiradi');
  });

  it('6. Kardinal (q3 yaxlitlangan) yaw da OBB yo‘q; to‘nka, tik bochka va gulxan halqasida silindr; gable AABB bilan kesiladi', () => {
    const spec = { name: 'w', center: [0, 1.5, 0] as [number, number, number], size: [4, 3, 0.2] as [number, number, number] };
    for (const yaw of [1.571, -1.571, 3.142, 4.713, 6.284]) {
      const c = localBoxToWorldCollider('q', 'q', spec, { x: 3, y: 0, z: -2 }, yaw);
      assert.equal(c.hit, undefined, `yaw ${yaw}: AABB aniq (OBB kerak emas)`);
    }
    assert.equal(localBoxToWorldCollider('q', 'q', spec, { x: 0, y: 0, z: 0 }, 1.56).hit?.kind, 'obb', '0.6° og‘ish — OBB');

    const world = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 } as never);
    // Haqiqiy kardinal bo'lmagan OBB lar qoladi, q3 kardinallari yo'q
    for (const c of world.colliders) {
      if (c.hit?.kind !== 'obb') continue;
      const k = c.hit.yaw / (Math.PI / 2);
      assert.ok(Math.abs(k - Math.round(k)) * (Math.PI / 2) >= 1e-3, `${c.id}: kardinal yaw da OBB bo‘lmasligi kerak`);
    }
    const stumps = world.colliders.filter((c) => /^sq_stump_\d+:col$/.test(c.id));
    const barrels = world.colliders.filter((c) => c.id.endsWith(':rusty_barrel_01:col:barrel'));
    const rings = world.colliders.filter((c) => c.id.endsWith(':campfire_pit_01:col:ring'));
    assert.ok(stumps.length > 20 && barrels.length >= 4 && rings.length >= 3);
    for (const c of [...stumps, ...barrels, ...rings]) {
      assert.equal(c.hit?.kind, 'cylinder', `${c.id} silindr`);
      const h = c.hit as { kind: 'cylinder'; cx: number; cz: number; r: number };
      // Silindr AABB ichida (q3 yaxlitlash ±1 mm)
      assert.ok(h.cx - h.r >= c.min.x - 1e-3 && h.cx + h.r <= c.max.x + 1e-3, `${c.id} x`);
      assert.ok(h.cz - h.r >= c.min.z - 1e-3 && h.cz + h.r <= c.max.z + 1e-3, `${c.id} z`);
    }

    // To'nka: quti burchagidan o'tgan diagonal nur AABB ga tegadi, silindrga emas
    const stump = buildTreeStumpCollider('s', { position: { x: 0, y: 0, z: 0 }, yaw: 0, scale: { x: 1, y: 1, z: 1 } })[0]!;
    const sh = stump.hit as { kind: 'cylinder'; cx: number; cz: number; r: number };
    const off = sh.r * 1.25;
    const o = { x: off * S2 - 3 * S2, y: 0.3, z: -off * S2 - 3 * S2 };
    assert.ok(rayBox(o, DIAG, stump.min, stump.max, 10), 'AABB burchagi');
    assert.equal(rayCollider(stump, o, DIAG, 10), null, 'silindr burchakni e‘tiborsiz qoldiradi');
    assert.ok(rayCollider(stump, { x: 0, y: 0.3, z: -3 }, DIR_Z, 10), 'markazdan — tegadi');

    // Gable: prizma (−0.46..1.68) quti (0..1.5) bilan kesiladi — quti tepasidan yuqorida (uch qismi) tegish yo'q,
    // AABB ga keyinroq kiradigan qiya nur ham quti tashqarisidagi nuqtada "tegmaydi"
    const gSpec = { name: 'g', center: [0, 0.75, 0] as [number, number, number], size: [4, 1.5, 0.2] as [number, number, number] };
    const gable = localBoxToWorldCollider('g', 'g', { ...gSpec, gable: { halfWidth: 2.41, baseY: -0.46, apexY: 1.68 } }, { x: 0, y: 6, z: 0 }, 0);
    assert.equal(rayCollider(gable, { x: 0, y: 7.6, z: -3 }, DIR_Z, 10), null, 'quti tepasidan yuqori (y=7.6 > 7.5)');
    const down = { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 };
    // (0, 10.5, −3) dan 45° pastga: kesishsiz prizma old yuzasiga y ≈ 7.6 da (quti tashqarisida) tegardi;
    // kesilganda quti tepasiga (y = 7.5, z = 0) tegadi
    const slanted = rayCollider(gable, { x: 0, y: 10.5, z: -3 }, down, 10);
    assert.ok(slanted, 'qiya nur uchburchakka tegadi');
    const hitY = 10.5 + down.y * slanted!.t;
    assert.ok(hitY <= gable.max.y + 1e-6, `tegish nuqtasi AABB ichida (y=${hitY.toFixed(3)} ≤ ${gable.max.y})`);
    assert.ok(Math.abs(slanted!.ny - 1) < 1e-9, 'quti tepasi (kesish tekisligi) normali');
    assert.ok(rayCollider(gable, { x: 0, y: 7.0, z: -3 }, DIR_Z, 10), 'uchburchak ichi tegadi');
    assert.equal(rayCollider(gable, { x: 1.9, y: 7.4, z: -3 }, DIR_Z, 10), null, 'quti yuqori burchagi bo‘sh');
  });
});
