import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GRAVITY, JUMP_SPEED, PLAYER_HEIGHT } from '../constants';
import { collidesAtWorld, raycastWorld } from '../physics';
import { BUILDING_MANIFESTS, ROOF_SLOPE_LOCAL_BOXES } from '../structures/manifests';
import { buildCabin8x4Prefab } from '../structures/layoutBuilder';
import { createWorldDefinition } from '../world';

describe('Bosqich 15 — loft kulbasi: to‘liq 2-qavat, qattiq qiya tom, tutqichsiz zina', () => {
  it('1. Kulba 8x4: 23 modul, tom va old devorlar y = +6, 2-qavat devorlari y = +3; zinada tutqich kollayderi yo‘q', () => {
    const cabin = buildCabin8x4Prefab({ x: 0, y: 10, z: 0 }, 'c');
    assert.equal(cabin.modules.length, 23);
    const roofs = cabin.modules.filter((m) => m.moduleId === 'wood_roof_slope_01' || m.moduleId === 'wood_roof_gable_01');
    assert.equal(roofs.length, 6);
    for (const r of roofs) assert.equal(r.position.y, 16, `${r.id} tomi y = 16 (10 + 6) bo‘lishi kerak`);
    const upperWalls = cabin.modules.filter((m) => m.position.y === 13 && m.moduleId.startsWith('wood_wall'));
    assert.equal(upperWalls.length, 6, '2-qavatda 6 ta devor moduli');
    assert.ok(BUILDING_MANIFESTS.wood_stairs_01.colliderBoxes.every((b) => !b.name.includes('handrail')));
    // Tom qiyaligi: 8 pog'ona, har biri STEP_HEIGHT dan past ko'tarilish, tizmadan chetga pasayadi
    assert.equal(ROOF_SLOPE_LOCAL_BOXES.length, 8);
    for (let i = 1; i < ROOF_SLOPE_LOCAL_BOXES.length; i++) {
      const prev = ROOF_SLOPE_LOCAL_BOXES[i - 1]!;
      const cur = ROOF_SLOPE_LOCAL_BOXES[i]!;
      assert.ok(cur.center[1] < prev.center[1], 'pog‘onalar chet tomon pasayadi');
      assert.ok(prev.center[1] - cur.center[1] < 0.55, 'ko‘tarilish qadam balandligidan past');
    }
  });

  it('2. Forest Square kulbasi: loftda 3 m bosh balandligi, sakrab tomga yetib bo‘lmaydi, tom teshib o‘tilmaydi', () => {
    const world = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 } as never);
    const cabinCols = world.colliders.filter((c) => c.id.startsWith('poi:poi_cabin_cluster:bld:0:'));
    assert.ok(cabinCols.length > 0, 'kulba kollayderlari topildi');
    assert.ok(world.colliders.every((c) => !c.id.includes('handrail')), 'xaritada tutqich kollayderi yo‘q');

    // Loft pol plitasi (mod_03, y = +3)
    const loft = cabinCols.find((c) => c.id.includes('mod_03:wood_floor_01'))!;
    assert.ok(loft, 'loft pol plitasi');
    const loftTop = loft.max.y;
    const lx = (loft.min.x + loft.max.x) / 2;
    const lz = (loft.min.z + loft.max.z) / 2;

    // Loft markazida tik turgan o'yinchi hech narsaga tegmaydi (bosh balandligi yetarli)
    assert.ok(!collidesAtWorld(world, lx, loftTop + 0.02, lz), 'loftda tik turish mumkin');
    // Yuqoriga nur: kamida 2.9 m bo'sh joy (tom endi 2-qavat devorlari ustida)
    const up = raycastWorld(world, { x: lx, y: loftTop + 0.1, z: lz }, { x: 0, y: 1, z: 0 }, 2.9);
    assert.equal(up, null, 'loft ustida 2.9 m bo‘sh joy');

    // Sakrash cho'qqisi: tomning eng past pog'onasidan ham past
    const jumpApex = (JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY);
    const roofSteps = cabinCols.filter((c) => c.id.includes('roof_slope_step'));
    assert.ok(roofSteps.length >= 32, 'kulbada 4 qiyalik × 8 pog‘ona');
    const lowestRoof = Math.min(...roofSteps.map((c) => c.min.y));
    const lowestRoofTop = Math.min(...roofSteps.map((c) => c.max.y));
    // Oyoq sakrash cho'qqisida ham eng past tom pog'onasi ustiga chiqmaydi (tom ustida turib bo'lmaydi)
    assert.ok(loftTop + jumpApex < lowestRoofTop, `loftdan sakrab tom ustiga chiqib bo‘lmaydi (oyoq ${(loftTop + jumpApex).toFixed(2)}, tom usti ${lowestRoofTop.toFixed(2)})`);
    // Tik turganda bosh tomga tegmaydi (loft markazida)
    assert.ok(loftTop + PLAYER_HEIGHT < lowestRoof, 'loft markazida tik turish uchun joy bor');

    // Tom ustidan pastga nur: tom pog'onasiga tegadi (teshib o'tmaydi) — tizma yaqinida va chetga yaqin joyda
    const ridgeHit = raycastWorld(world, { x: lx, y: lowestRoof + 6, z: lz }, { x: 0, y: -1, z: 0 }, 10);
    assert.ok(ridgeHit && ridgeHit.colliderId?.includes('roof_slope_step'), 'tizma yaqinida tom qattiq');
    const nearEave = raycastWorld(world, { x: lx, y: lowestRoof + 6, z: loft.max.z + 0.2 }, { x: 0, y: -1, z: 0 }, 10);
    assert.ok(nearEave && nearEave.colliderId?.includes('roof_slope_step'), 'chetga yaqin joyda ham tom qattiq');
  });
});
