import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { WorldWeaponItem } from '../../client/game/WorldWeaponItem';
import { getNav } from '../../server/navgraph';
import { validateMapSpawns } from '../../server/room';
import { PLAYER_HEIGHT, PLAYER_RADIUS, RUN_SPEED, STEP_HEIGHT } from '../constants';
import { MAP } from '../map';
import { vnorm, vsub, type Vec3 } from '../math';
import {
  applyMovement,
  applyWorldMovement,
   boxOverlap,
  collidesAtWorld,
  isSpawnPointSafe,
  queryNearbyColliders,
  rayBox,
  raycastBoxes,
  raycastWorld,
  type Body,
} from '../physics';
import { getWorldSpatialIndex, SpatialGridIndex } from '../spatialIndex';
import {
  buildTerrainMeshData,
  compilePrefabPlacement,
  createGroundedRockCollider,
  createGroundedTreeCollider,
  createTechnicalTerrainFixture,
  createWorldDefinition,
  DEFAULT_MAX_WALKABLE_SLOPE_DEG,
  DEFAULT_WORLD,
  isTerrainWalkable,
  sampleHeightfieldTriangle,
  sampleTerrainHeight,
  sampleTerrainNormal,
  sampleTerrainSlopeDeg,
  type ColliderBox,
} from '../world';

describe('Bosqich 02B — Heightfield Terrain, Fizika va Spatial Index testlari', () => {
  it('1. Tekis yerdagi harakat eski buildDustArena() / MAP.boxes natijasi bilan 100% mos', () => {
    const bLegacy: Body = { pos: { x: -38, y: 0, z: -22 }, vel: { x: 0, y: 0, z: 0 }, onGround: true };
    const bWorld: Body = { pos: { x: -38, y: 0, z: -22 }, vel: { x: 0, y: 0, z: 0 }, onGround: true };

    for (let i = 0; i < 60; i++) {
      const jump = i === 10;
      applyMovement(bLegacy, 5.2, 2.8, jump, 1 / 60, MAP.boxes);
      applyWorldMovement(bWorld, 5.2, 2.8, jump, 1 / 60, DEFAULT_WORLD);
    }

    assert.deepEqual(bWorld, bLegacy);
  });

  it('2. Render va fizika uchburchak interpolatsiyasi aynan bir xil balandlik va normal qaytaradi', () => {
    const fixture = createTechnicalTerrainFixture();
    assert.equal(fixture.terrain.kind, 'heightfield');
    const hf = fixture.terrain;
    const meshData = buildTerrainMeshData(hf);

    // Har bir uchburchakning markazida (barycentric 1/3, 1/3, 1/3) mesh uchburchagi balandligi
    // va sampleTerrainHeight(x, z) qiymati 1e-5 aniqlikda ustma-ust tushishini tekshiramiz
    const idx = meshData.indices;
    const pos = meshData.positions;
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t] * 3;
      const i1 = idx[t + 1] * 3;
      const i2 = idx[t + 2] * 3;

      const cx = (pos[i0] + pos[i1] + pos[i2]) / 3;
      const cy = (pos[i0 + 1] + pos[i1 + 1] + pos[i2 + 1]) / 3;
      const cz = (pos[i0 + 2] + pos[i1 + 2] + pos[i2 + 2]) / 3;

      const physY = sampleTerrainHeight(hf, cx, cz);
      assert.ok(
        Math.abs(physY - cy) < 1e-4,
        `Triangle centroid (${cx}, ${cz}) mismatch: mesh=${cy}, physics=${physY}`,
      );
    }

    // Normal birlik vektor ekanligi va tepalik cho'qqisida yuqoriga qaraganini tekshirish
    const hillPeakY = sampleTerrainHeight(hf, -14, 0);
    assert.ok(hillPeakY > 2.8, `Hill peak at (-14, 0) expected > 2.8m, got ${hillPeakY}`);
    const hollowBottomY = sampleTerrainHeight(hf, 14, -12);
    assert.ok(hollowBottomY < -1.8, `Hollow depth at (14, -12) expected < -1.8m, got ${hollowBottomY}`);

    const nSlope = sampleTerrainNormal(hf, -9, 0);
    const nLen = Math.hypot(nSlope.x, nSlope.y, nSlope.z);
    assert.ok(Math.abs(nLen - 1) < 1e-6);
    assert.ok(nSlope.y > 0);
  });

  it("3. Tepalikka ko'tarilish va pastlikka tushish tabiiy ishlaydi, o'yinchi yerga botmaydi va havoda osilib qolmaydi", () => {
    const fixture = createTechnicalTerrainFixture();

    // A) Tepalikka ko'tarilish: (-24, 0) dan (-14, 0) cho'qqiga qarab yurish
    const climber: Body = {
      pos: { x: -24, y: sampleTerrainHeight(fixture.terrain, -24, 0), z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    const startY = climber.pos.y;
    for (let i = 0; i < 120; i++) {
      applyWorldMovement(climber, RUN_SPEED, 0, false, 1 / 60, fixture);
      const groundY = sampleTerrainHeight(fixture.terrain, climber.pos.x, climber.pos.z);
      // Yerga botib ketmasligi kerak
      assert.ok(climber.pos.y >= groundY - 1e-4);
      // Havoda osilib qolmasligi kerak
      assert.ok(Math.abs(climber.pos.y - groundY) < 0.05);
      assert.equal(climber.onGround, true);
    }
    assert.ok(climber.pos.y > startY + 2.2, `Climber should ascend hill: start=${startY}, end=${climber.pos.y}`);

    // B) Pastlikka tushish: (4, -12) dan (14, -12) chuqurlikka qarab yurish
    const descender: Body = {
      pos: { x: 4, y: sampleTerrainHeight(fixture.terrain, 4, -12), z: -12 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 120; i++) {
      applyWorldMovement(descender, RUN_SPEED, 0, false, 1 / 60, fixture);
      const groundY = sampleTerrainHeight(fixture.terrain, descender.pos.x, descender.pos.z);
      assert.ok(Math.abs(descender.pos.y - groundY) < 0.06, `Descender floated above hollow: y=${descender.pos.y}, ground=${groundY}`);
      assert.equal(descender.onGround, true);
    }
    assert.ok(descender.pos.y < -1.5, `Descender should reach hollow bottom (< -1.5m), got ${descender.pos.y}`);
  });

  it("4. Juda tik qiyalikda (> maxWalkableSlopeDeg) oddiy yurish bilan chiqib ketolmaydi, lekin pastga tusha oladi", () => {
    const fixture = createTechnicalTerrainFixture();
    // Tik qiyalik (0, -20) atrofida joylashgan (balandligi ~3.6m, nishabligi ~61 deg > 42 deg)
    const steepSlope = sampleTerrainSlopeDeg(fixture.terrain, 0, -18.5);
    assert.ok(
      steepSlope > DEFAULT_MAX_WALKABLE_SLOPE_DEG,
      `Expected steep slope > ${DEFAULT_MAX_WALKABLE_SLOPE_DEG} deg, got ${steepSlope}`,
    );
    assert.equal(isTerrainWalkable(fixture.terrain, 0, -18.5), false);

    // (0, -15) dan shimolga (-Z) tik qiyalik cho'qqisi (0, -20) tomon yurishga urinish
    const body: Body = {
      pos: { x: 0, y: sampleTerrainHeight(fixture.terrain, 0, -15), z: -15 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };

    for (let i = 0; i < 120; i++) {
      applyWorldMovement(body, 0, -RUN_SPEED, false, 1 / 60, fixture);
    }

    // Cho'qqiga (z = -20, y = 3.6) chiqib ketolmasligi shart
    assert.ok(body.pos.z > -18.5, `Player should be blocked before steep peak z=-20, got z=${body.pos.z}`);
    assert.ok(body.pos.y < 1.5, `Player should not climb 3.6m steep ridge, got y=${body.pos.y}`);

    // Endi orqaga (+Z, pastga) yurganda bemalol qaytib chiqa olishi kerak (tiqilib qolmasligi shart)
    const blockedZ = body.pos.z;
    for (let i = 0; i < 60; i++) {
      applyWorldMovement(body, 0, RUN_SPEED, false, 1 / 60, fixture);
    }
    assert.ok(body.pos.z > blockedZ + 1.5, 'Player must be able to walk downhill away from steep slope');
  });

  it('5. Yer ustida sakrash va qayta yerga tushish (notekis relyefda)', () => {
    const fixture = createTechnicalTerrainFixture();
    const x = -11;
    const z = 0;
    const groundY = sampleTerrainHeight(fixture.terrain, x, z);
    const body: Body = {
      pos: { x, y: groundY, z },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };

    // Sakrashni boshlash
    applyWorldMovement(body, 0, 0, true, 1 / 60, fixture);
    assert.equal(body.onGround, false);
    assert.ok(body.vel.y > 5);

    let maxAirY = body.pos.y;
    for (let i = 0; i < 90; i++) {
      applyWorldMovement(body, 0, 0, false, 1 / 60, fixture);
      maxAirY = Math.max(maxAirY, body.pos.y);
      if (body.onGround) break;
    }

    assert.ok(maxAirY > groundY + 0.8, 'Player should jump into the air above sloped terrain');
    assert.equal(body.onGround, true, 'Player should land back on terrain');
    const landedGroundY = sampleTerrainHeight(fixture.terrain, body.pos.x, body.pos.z);
    assert.ok(Math.abs(body.pos.y - landedGroundY) < 1e-3);
  });

  it('6. Platforma ustida turish va pastdagi yer bilan adashmaslik (teleport/snap xatosi yo`q)', () => {
    const fixture = createTechnicalTerrainFixture();
    const deckCol = fixture.colliders.find((c) => c.id === 'tech_platform_01:deck:col')!;
    assert.ok(deckCol);

    const groundY = sampleTerrainHeight(fixture.terrain, 14, 12);
    const deckTopY = deckCol.max.y;
    assert.ok(deckTopY > groundY + 1.0);

    // A) Platforma ustida turgan o'yinchi pastga tushib ketmaydi, platforma yuzasida qoladi
    const onDeck: Body = {
      pos: { x: 14, y: deckTopY, z: 12 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 30; i++) {
      applyWorldMovement(onDeck, 1.0, 0, false, 1 / 60, fixture);
    }
    assert.equal(onDeck.onGround, true);
    assert.ok(Math.abs(onDeck.pos.y - deckTopY) < 1e-3);

    // B) Platforma yonida / ostida yer sathida (y = groundY) turgan o'yinchi
    // platformaning ustiga (y = deckTopY) avtomatik sakrab/teleport bo'lib chiqib ketmaydi!
    const onGroundNearDeck: Body = {
      pos: { x: 14, y: groundY, z: 8.6 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 40; i++) {
      // Platformaning shimoliy chetiga (+Z) qarab yerda yurish (zina yo'q tomondan)
      applyWorldMovement(onGroundNearDeck, 0, RUN_SPEED, false, 1 / 60, fixture);
    }
    assert.ok(
      onGroundNearDeck.pos.y < groundY + 0.25,
      `Player on ground must NOT teleport onto platform top (${deckTopY}), got y=${onGroundNearDeck.pos.y}`,
    );
  });

  it('7. Zinadan chiqish (<= STEP_HEIGHT) orqali platforma ustiga ko`tarilish', () => {
    const fixture = createTechnicalTerrainFixture();
    const deckCol = fixture.colliders.find((c) => c.id === 'tech_platform_01:deck:col')!;
    const startX = 8.4;
    const startZ = 12;
    const body: Body = {
      pos: { x: startX, y: sampleTerrainHeight(fixture.terrain, startX, startZ), z: startZ },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };

    // G'arbdan sharqqa (+X) 3 ta pog'onali zina (har biri 0.38m <= STEP_HEIGHT=0.45m) orqali yurish
    for (let i = 0; i < 55; i++) {
      applyWorldMovement(body, RUN_SPEED, 0, false, 1 / 60, fixture);
    }

    assert.ok(STEP_HEIGHT >= 0.38);
    assert.ok(body.pos.x > 11.5 && body.pos.x < 16.5, `Player should climb stairs onto platform deck, x=${body.pos.x}`);
    assert.ok(
      Math.abs(body.pos.y - deckCol.max.y) < 0.01,
      `Player should reach platform top y=${deckCol.max.y}, got y=${body.pos.y}`,
    );
  });

  it("8. Devor to'qnashuvi va xarita chegarasida (bounds) ushlab qolish", () => {
    const fixture = createTechnicalTerrainFixture();

    // A) Devor (0, 14) orqali o'tib ketmaslik
    const wallTest: Body = {
      pos: { x: 0, y: sampleTerrainHeight(fixture.terrain, 0, 11.5), z: 11.5 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 90; i++) {
      applyWorldMovement(wallTest, 0, RUN_SPEED, false, 1 / 60, fixture);
    }
    assert.ok(wallTest.pos.z < 13.3, `Player must stop in front of wall at z=14, got z=${wallTest.pos.z}`);

    // B) Xarita chegarasidan (bounds.maxX = 31) chiqib ketmaslik
    const boundTest: Body = {
      pos: { x: 28, y: sampleTerrainHeight(fixture.terrain, 28, 0), z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 120; i++) {
      applyWorldMovement(boundTest, RUN_SPEED, 0, false, 1 / 60, fixture);
    }
    assert.ok(
      boundTest.pos.x <= fixture.bounds.maxX - PLAYER_RADIUS + 1e-4,
      `Player exceeded world maxX bound: ${boundTest.pos.x}`,
    );
  });

  it("9. raycastWorld tepalik (terrain) va devor (collider) ni to'g'ri uradi va o'qni/ko'rishni to'sadi", () => {
    const fixture = createTechnicalTerrainFixture();

    // A) Tepalik (-14, 0, peak ~3.0m) orqali (-24, 1.2, 0) dan (-4, 1.2, 0) ga otilgan nur tepalikka uriladi
    const originA: Vec3 = { x: -24, y: 1.2, z: 0 };
    const targetA: Vec3 = { x: -4, y: 1.2, z: 0 };
    const dirA = vnorm(vsub(targetA, originA));
    const distA = Math.hypot(targetA.x - originA.x, targetA.y - originA.y, targetA.z - originA.z);

    const hitTerrain = raycastWorld(fixture, originA, dirA, distA);
    assert.ok(hitTerrain, 'Ray through hill must hit terrain');
    assert.equal(hitTerrain.kind, 'terrain');
    assert.ok(hitTerrain.t < distA);
    assert.ok(hitTerrain.ny > 0);

    // B) Devor (0, 14) orqali (0, 1.2, 10) dan (0, 1.2, 18) ga otilgan nur devor collideriga uriladi
    const originB: Vec3 = { x: 0, y: 1.2, z: 10 };
    const targetB: Vec3 = { x: 0, y: 1.2, z: 18 };
    const dirB = vnorm(vsub(targetB, originB));
    const distB = 8;

    const hitWall = raycastWorld(fixture, originB, dirB, distB);
    assert.ok(hitWall, 'Ray through stone wall must hit collider');
    assert.equal(hitWall.kind, 'collider');
    assert.equal(hitWall.colliderId, 'tech_wall_01:wall_main:col');
  });

  it('10. Spatial index natijalari manfiy/musbat koordinatalarda brute-force qidiruv bilan 100% mos va xonalar izolyatsiyalangan', () => {
    const fixture = createTechnicalTerrainFixture();
    const spatial = getWorldSpatialIndex(fixture);

    // Bir nechta cellni kesib o'tuvchi katta colliderni ham tekshiramiz
    const testQueries = [
      { minX: -30, minZ: -30, maxX: 30, maxZ: 30 },
      { minX: -15, minZ: -12, maxX: -5, maxZ: 12 },
      { minX: 9, minZ: 8, maxX: 18, maxZ: 16 },
      { minX: -4, minZ: 12, maxX: 4, maxZ: 16 },
    ];

    for (const q of testQueries) {
      const indexed = spatial.queryAABB(q.minX, q.minZ, q.maxX, q.maxZ);
      const brute = fixture.colliders.filter(
        (b) => b.max.x >= q.minX && b.min.x <= q.maxX && b.max.z >= q.minZ && b.min.z <= q.maxZ,
      );
      assert.deepEqual(
        indexed.map((c) => c.id),
        brute.map((c) => c.id),
      );
    }

    // Radius qidiruvi brute-force bilan mosligi
    const rIndexed = queryNearbyColliders(fixture, 14, 12, 4.5);
    const rBrute = fixture.colliders.filter((b) => {
      const cx = Math.max(b.min.x, Math.min(14, b.max.x));
      const cz = Math.max(b.min.z, Math.min(12, b.max.z));
      return (14 - cx) ** 2 + (12 - cz) ** 2 <= 4.5 ** 2 + 1e-9;
    });
    assert.deepEqual(
      rIndexed.map((c) => c.id),
      rBrute.map((c) => c.id),
    );

    // Raycast spatial vs brute-force raycastBoxes on Dust Arena
    const rayOrigins: Vec3[] = [
      { x: -35, y: 1.5, z: -20 },
      { x: 0, y: 1.5, z: -25 },
      { x: 25, y: 2.0, z: 15 },
    ];
    const rayDirs: Vec3[] = [
      vnorm({ x: 1, y: -0.05, z: 0.4 }),
      vnorm({ x: 0.2, y: 0, z: 1 }),
      vnorm({ x: -1, y: 0.02, z: -0.5 }),
    ];
    for (let i = 0; i < rayOrigins.length; i++) {
      const hitWorld = raycastWorld(DEFAULT_WORLD, rayOrigins[i], rayDirs[i], 100);
      const hitBrute = raycastBoxes(DEFAULT_WORLD.colliders, rayOrigins[i], rayDirs[i], 100);
      assert.equal(hitWorld?.t, hitBrute?.t);
      assert.equal(hitWorld?.nx, hitBrute?.nx);
      assert.equal(hitWorld?.ny, hitBrute?.ny);
      assert.equal(hitWorld?.nz, hitBrute?.nz);
    }

    // Ikki xil WorldDefinition mustaqil spatial indexga ega
    const worldA = createWorldDefinition({ mapId: 'dust_arena', publicLayoutSeed: 101 });
    const worldB = createWorldDefinition({ mapId: 'forest_sample', publicLayoutSeed: 202 });
    assert.notEqual(getWorldSpatialIndex(worldA), getWorldSpatialIndex(worldB));
  });

  it("11. Spawn nuqtasining xavfsizligi (isSpawnPointSafe) va kelajakdagi obyektlarni yerga bog'lash (grounding)", () => {
    const fixture = createTechnicalTerrainFixture();
    const deckCol = fixture.colliders.find((c) => c.id === 'tech_platform_01:deck:col')!;

    // Barcha standart va texnik spawn nuqtalar xavfsiz bo'lishi shart
    assert.deepEqual(validateMapSpawns(DEFAULT_WORLD), []);
    assert.deepEqual(validateMapSpawns(fixture), []);

    // 1) Yer ustidagi spawn — xavfsiz
    const groundY0 = sampleTerrainHeight(fixture.terrain, 0, 0);
    assert.equal(isSpawnPointSafe(fixture, { x: 0, y: groundY0, z: 0 }), true);

    // 2) Haqiqiy platforma ustidagi spawn — xavfsiz
    assert.equal(isSpawnPointSafe(fixture, { x: 14, y: deckCol.max.y, z: 12 }), true);

    // 3) Havoda osilib turgan spawn (tayanchi yo'q, masalan y = 10) — xavfsiz emas
    assert.equal(isSpawnPointSafe(fixture, { x: 0, y: 10, z: 0 }), false);
    assert.equal(isSpawnPointSafe(DEFAULT_WORLD, { x: 0, y: 10, z: 10 }), false);

    // 4) Yer ichidagi spawn — xavfsiz emas
    assert.equal(isSpawnPointSafe(fixture, { x: 0, y: groundY0 - 0.5, z: 0 }), false);

    // 5) Tik qiyalikdagi spawn (0, -18.5) — xavfsiz emas
    assert.equal(
      isSpawnPointSafe(fixture, { x: 0, y: sampleTerrainHeight(fixture.terrain, 0, -18.5), z: -18.5 }),
      false,
    );

    // Devor ichidagi nuqta xavfsiz emas
    assert.equal(isSpawnPointSafe(fixture, { x: 0, y: sampleTerrainHeight(fixture.terrain, 0, 14), z: 14 }), false);
    // Xarita chegarasidan tashqaridagi nuqta xavfsiz emas
    assert.equal(isSpawnPointSafe(fixture, { x: 99, y: 0, z: 0 }), false);

    // Daraxt, tosh, prefab va WorldWeaponItem yerga aniq bog'lanishi
    const treeCol = createGroundedTreeCollider('test_pine', fixture.terrain, -12, 3, 0.4, 5.0);
    const expectedTreeY = sampleTerrainHeight(fixture.terrain, -12, 3);
    assert.ok(Math.abs(treeCol.min.y - (expectedTreeY - 0.2)) < 1e-3);
    assert.ok(Math.abs(treeCol.max.y - (expectedTreeY + 5.0)) < 1e-3);

    const rockCol = createGroundedRockCollider('test_rock', fixture.terrain, 10, -10, { x: 2, y: 1.4, z: 2 });
    const expectedRockY = sampleTerrainHeight(fixture.terrain, 10, -10);
    assert.ok(Math.abs(rockCol.min.y - (expectedRockY - 0.15)) < 1e-3);

    const item = new WorldWeaponItem({ weapon: 'rifle', pose: 'flat' });
    item.placeOnTerrain(fixture.terrain, -11, 2, 0.5, true);
    assert.ok(Math.abs(item.root.position.y - sampleTerrainHeight(fixture.terrain, -11, 2)) < 1e-4);
    item.dispose();
  });

  it('12. Kichik (1/240s) va katta (0.25s) dt qiymatlarida fizik barqarorlik hamda NavGraph mosligi', () => {
    const fixture = createTechnicalTerrainFixture();

    // Kichik dt (240 FPS) va katta dt (lag spike 0.25s) da devordan o'tib ketmaslik va yerga tushib ketmaslik
    for (const dt of [1 / 240, 0.25]) {
      const b: Body = {
        pos: { x: 0, y: sampleTerrainHeight(fixture.terrain, 0, 10), z: 10 },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      const totalTime = 2.0;
      const steps = Math.round(totalTime / dt);
      for (let i = 0; i < steps; i++) {
        applyWorldMovement(b, 0, RUN_SPEED, false, dt, fixture);
        const gy = sampleTerrainHeight(fixture.terrain, b.pos.x, b.pos.z);
        assert.ok(b.pos.y >= gy - 1e-3, `Fell below terrain at dt=${dt}: y=${b.pos.y}, ground=${gy}`);
      }
      // Devordan (z = 14) o'tib ketmagan bo'lishi shart
      assert.ok(b.pos.z < 13.4, `Tunneled through wall at dt=${dt}: z=${b.pos.z}`);
    }

    // NavGraph tik qiyalikdan qochib yo'l topishi va eskisini buzmasligi
    const nav = getNav(fixture);
    assert.ok(nav.validList.length > 50);
    const path = nav.findPath({ x: -10, y: 0, z: -18 }, { x: 10, y: 0, z: -18 });
    assert.ok(path.length > 0, 'NavGraph should find a path around the steep ridge');
    for (const pt of path) {
      assert.equal(isTerrainWalkable(fixture.terrain, pt.x, pt.z), true);
    }
  });
});
