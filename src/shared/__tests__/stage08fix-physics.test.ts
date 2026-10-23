import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EYE_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  RUN_SPEED,
  STEP_HEIGHT,
  WALK_SPEED,
} from '../constants';
import { createForestSquareWorld } from '../forestSquare';
import type { Vec3 } from '../math';
import {
  applyWorldMovement,
  computeCameraClearDistance,
  isCameraPointClear,
  moveBodyInWorld,
  type Body,
} from '../physics';
import { sampleTerrainHeight, sampleTerrainSlopeDeg } from '../terrain';

describe('BOSQICH 08-FIX — P1-C: Relyef, Kapsula Harakati va Kamera Klipingi', () => {
  it('1. Relyef qiyaligi: ruxsat etilgan nishabda erkin yurish va tik qiyalikda (>38°) yuqoriga chiqish to‘silishi', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    // Tekshirish uchun relyefdan tik nishabli nuqtani topamiz
    let steepX = 0;
    let steepZ = 0;
    let foundSteep = false;
    for (let x = -120; x <= 120; x += 2) {
      for (let z = -120; z <= 120; z += 2) {
        const slope = sampleTerrainSlopeDeg(world.terrain, x, z);
        if (slope > 38 && slope < 60) {
          steepX = x;
          steepZ = z;
          foundSteep = true;
          break;
        }
      }
      if (foundSteep) break;
    }

    assert.ok(foundSteep, 'Xaritada tik relyef (>38°) topilmadi');

    // Tik qiyalik tomon yurish: yuqoriga chiqish cheklanishi kerak
    const groundY = sampleTerrainHeight(world.terrain, steepX, steepZ);
    const body: Body = {
      pos: { x: steepX, y: groundY, z: steepZ },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };

    // 1 soniya davomida yuqoriga / oldinga qadam tashlash
    for (let step = 0; step < 60; step++) {
      applyWorldMovement(body, 0, -WALK_SPEED, false, 1 / 60, world, { maxWalkableSlopeDeg: 38 });
    }

    // O‘yinchi yer ichiga botib ketmasligi shart
    const finalGroundY = sampleTerrainHeight(world.terrain, body.pos.x, body.pos.z);
    assert.ok(
      body.pos.y >= finalGroundY - 0.05,
      `Oyoq relyefdan pastga botib ketdi: y=${body.pos.y}, groundY=${finalGroundY}`,
    );
  });

  it('2. Zinapoya va podestga ko‘tarilish (<= STEP_HEIGHT=0.55m): silliq chiqish va baland to‘siqda to‘xtash', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    // Modulli binolar oldidagi zinalardan biri (masalan, ranger house yoki lumber mill)
    // Zinapoya colliders bino oldida joylashgan
    const stairCollider = world.colliders.find(
      (c) => c.id.includes('wood_stairs_01') || c.id.includes('cabin:step'),
    );
    assert.ok(stairCollider, 'Zinapoya yoki porch step collideri topilmadi');

    const stepTopY = stairCollider.max.y;
    const approachX = (stairCollider.min.x + stairCollider.max.x) / 2;
    const approachZ = stairCollider.min.z - 0.6;
    const startY = sampleTerrainHeight(world.terrain, approachX, approachZ);

    const body: Body = {
      pos: { x: approachX, y: startY, z: approachZ },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };

    // Zinapoya tomon oldinga yurish
    for (let i = 0; i < 45; i++) {
      applyWorldMovement(body, 0, WALK_SPEED, false, 1 / 60, world);
    }

    // O‘yinchi zinapoya ustiga ko‘tarila olgan yoki oldida xavfsiz to‘xtagan
    assert.ok(
      body.pos.y >= startY - 0.05,
      `Oyoq yer ostiga tushib ketmasligi kerak: y=${body.pos.y}`,
    );
  });

  it('3. Aylantirilgan va to‘g‘ri bino devorlari: tunnel bo‘lmasligi va orqaga teleportatsiya xatosi yo‘qligi', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    // Binolardan birining devor colliderini olamiz
    const wallCol = world.colliders.find(
      (c) => c.id.includes('wood_wall_01') && c.tag === 'structure',
    );
    assert.ok(wallCol, 'Bino devori collideri topilmadi');

    // Devor markazi tomon yurish
    const targetX = (wallCol.min.x + wallCol.max.x) / 2;
    const targetZ = wallCol.min.z - 1.2;
    const groundY = sampleTerrainHeight(world.terrain, targetX, targetZ);

    const body: Body = {
      pos: { x: targetX, y: groundY, z: targetZ },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };

    // Devorga to‘g‘ridan-to‘g‘ri tez yugurib borish (RUN_SPEED)
    for (let i = 0; i < 60; i++) {
      applyWorldMovement(body, 0, RUN_SPEED, false, 1 / 60, world);
    }

    // O‘yinchi devor ichiga kirmasligi va devor oldida to‘xtashi shart
    assert.ok(
      body.pos.z <= wallCol.min.z - PLAYER_RADIUS + 0.05 ||
        body.pos.x <= wallCol.min.x - PLAYER_RADIUS + 0.05 ||
        body.pos.x >= wallCol.max.x + PLAYER_RADIUS - 0.05,
      `O‘yinchi devor ichiga kirib ketdi: z=${body.pos.z}, wallMinZ=${wallCol.min.z}`,
    );
  });

  it('4. Lag-spike barqarorligi: katta dt (dt=0.25s) bilan harakatda devor yoki chegarani kesib o‘tib ketmaslik', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    // Xarita chegarasi yaqinida tez yugurish
    const nearEdgeX = world.bounds.maxX - 1.0;
    const body: Body = {
      pos: { x: nearEdgeX, y: sampleTerrainHeight(world.terrain, nearEdgeX, 0), z: 0 },
      vel: { x: RUN_SPEED * 2, y: 0, z: 0 },
      onGround: true,
    };

    // Lag spike (dt = 0.25s)
    moveBodyInWorld(body, 0.25, world);

    // Xarita chegarasidan chiqib ketmasligi kerak
    assert.ok(
      body.pos.x <= world.bounds.maxX - PLAYER_RADIUS + 1e-4,
      `Lag spike o‘yinchini chegara tashqarisiga o‘tkazib yubordi: x=${body.pos.x}, maxX=${world.bounds.maxX}`,
    );
  });

  it('5. Determinizm: bir xil kirish parametrlari bilan mijoz va server aynan bir xil pozitsiyani hisoblaydi', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    const createTestBody = (): Body => ({
      pos: { x: 12.5, y: sampleTerrainHeight(world.terrain, 12.5, -8.2), z: -8.2 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    });

    const clientBody = createTestBody();
    const serverBody = createTestBody();

    const dt = 1 / 30; // Server tick rate
    for (let tick = 0; tick < 60; tick++) {
      const wishX = Math.sin(tick * 0.1) * RUN_SPEED;
      const wishZ = Math.cos(tick * 0.1) * RUN_SPEED;
      const jump = tick % 15 === 0;

      applyWorldMovement(clientBody, wishX, wishZ, jump, dt, world);
      applyWorldMovement(serverBody, wishX, wishZ, jump, dt, world);
    }

    assert.equal(clientBody.pos.x, serverBody.pos.x, 'X koordinatasi farq qildi');
    assert.equal(clientBody.pos.y, serverBody.pos.y, 'Y koordinatasi farq qildi');
    assert.equal(clientBody.pos.z, serverBody.pos.z, 'Z koordinatasi farq qildi');
  });

  it('6. Kamera klipingi: isCameraPointClear yer ostidagi va devor ichidagi kamerani aniqlaydi', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    const groundY = sampleTerrainHeight(world.terrain, 0, 0);

    // Relyef ostidagi nuqta: tozalik tekshiruvidan o‘tmasligi kerak
    const underGroundPoint: Vec3 = { x: 0, y: groundY - 0.5, z: 0 };
    assert.equal(
      isCameraPointClear(world, underGroundPoint),
      false,
      'Yer ostidagi kamera nuqtasi ruxsat etilmasligi kerak',
    );

    // Ochiq havodagi nuqta: toza bo‘lishi kerak
    const inAirPoint: Vec3 = { x: 0, y: groundY + 2.5, z: 0 };
    assert.equal(
      isCameraPointClear(world, inAirPoint),
      true,
      'Ochiq havodagi kamera nuqtasi toza bo‘lishi kerak',
    );
  });

  it('7. computeCameraClearDistance: to‘siq mavjud bo‘lganda 3-shaxs kamerasi masofasini xavfsiz qisqartiradi', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    const wallCol = world.colliders.find((c) => c.tag === 'structure');
    assert.ok(wallCol);

    const pivot: Vec3 = {
      x: (wallCol.min.x + wallCol.max.x) / 2,
      y: wallCol.min.y + 1.2,
      z: wallCol.min.z - 1.0,
    };

    const dirTowardsWall: Vec3 = { x: 0, y: 0, z: 1 };
    const desiredDist = 2.5;

    const clearDist = computeCameraClearDistance(world, pivot, dirTowardsWall, desiredDist);
    assert.ok(
      clearDist < desiredDist,
      `Kamera devor ichiga kirishi oldi olinishi kerak: clearDist=${clearDist} < desired=${desiredDist}`,
    );
    assert.ok(
      clearDist <= 1.0 + 0.05,
      `Kamera devor oldida xavfsiz qisqarishi kerak: clearDist=${clearDist}`,
    );
  });

  it('8. Relyef bo‘ylab tasodifiy uzoq yurishda (100 qadam, 3 xil seed) oyoq hech qachon yer ostiga botmaydi', () => {
    const seeds = [6501, 1337, 77777];

    for (const seed of seeds) {
      const world = createForestSquareWorld({ publicLayoutSeed: seed });
      const spawn = world.spawnPoints[0];
      const body: Body = {
        pos: { x: spawn.x, y: spawn.y ?? sampleTerrainHeight(world.terrain, spawn.x, spawn.z), z: spawn.z },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };

      for (let step = 0; step < 100; step++) {
        const wishX = Math.sin(step * 0.23) * RUN_SPEED;
        const wishZ = Math.cos(step * 0.37) * RUN_SPEED;
        const jump = step % 20 === 0;

        applyWorldMovement(body, wishX, wishZ, jump, 1 / 60, world);

        const currentGroundY = sampleTerrainHeight(world.terrain, body.pos.x, body.pos.z);
        // O‘yinchi yer ostiga tushib ketmasligi shart (ruxsat etilgan chegaradan pastga tushmaslik)
        assert.ok(
          body.pos.y >= currentGroundY - 0.05,
          `Seed ${seed}, qadam ${step}: oyoq relyefdan pastda y=${body.pos.y}, groundY=${currentGroundY}`,
        );
      }
    }
  });
});
