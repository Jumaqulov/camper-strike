import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { buildForestSampleScene } from '../../client/game/ForestRenderer';
import { buildWorld } from '../../client/game/World';
import { getNav } from '../../server/navgraph';
import { validateMapSpawns } from '../../server/room';
import { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_RADIUS, RUN_SPEED } from '../constants';
import {
  createForestSampleWorld,
  FOREST_SAMPLE_HALF,
  FOREST_SAMPLE_SIZE,
  sampleForestRoad,
  TREE_SPECIES_BATCH_KEYS,
} from '../forestSample';
import { vnorm, vsub, type Vec3 } from '../math';
import {
  applyWorldMovement,
  collidesAtWorld,
  isSpawnPointSafe,
  raycastWorld,
  type Body,
} from '../physics';
import {
  createTechnicalTerrainFixture,
  createWorldDefinition,
  DEFAULT_WORLD,
  sampleTerrainHeight,
  validateWorldCompatibility,
   extractWorldMeta,
} from '../world';

describe("Bosqich 03 — 96×96 Haqiqiy 3D O'rmon (forest_sample) testlari", () => {
  it('1. forest_sample bir xil seed va worldVersion bilan aynan bir xil WorldDefinition va gameplayHash yaratadi', () => {
    const w1 = createWorldDefinition({ mapId: 'forest_sample', worldVersion: 1, publicLayoutSeed: 202603 });
    const w2 = createWorldDefinition({ mapId: 'forest_sample', worldVersion: 1, publicLayoutSeed: 202603 });
    const wDiffSeed = createWorldDefinition({ mapId: 'forest_sample', worldVersion: 1, publicLayoutSeed: 999999 });

    assert.equal(w1.mapId, 'forest_sample');
    assert.equal(w1.gameplayHash, w2.gameplayHash);
    assert.equal(w1.colliders.length, w2.colliders.length);
    assert.equal(w1.visuals.length, w2.visuals.length);
    assert.deepEqual(w1.spawnPoints, w2.spawnPoints);
    assert.notEqual(w1.gameplayHash, wDiffSeed.gameplayHash);

    const compat = validateWorldCompatibility(extractWorldMeta(w1), extractWorldMeta(w2));
    assert.equal(compat.ok, true);
  });

  it('2. forest_sample 96 × 96 metr o\'lchamda va heightfield relyefga ega', () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    assert.equal(FOREST_SAMPLE_SIZE, 96);
    assert.equal(FOREST_SAMPLE_HALF, 48);
    assert.equal(world.bounds.minX, -48);
    assert.equal(world.bounds.maxX, 48);
    assert.equal(world.bounds.minZ, -48);
    assert.equal(world.bounds.maxZ, 48);
    assert.equal(world.terrain.kind, 'heightfield');
    assert.equal(world.terrain.width, 96);
    assert.equal(world.terrain.depth, 96);
  });

  it("3. forest_sample o'ynaladigan hududida kamida 180 ta daraxt bor, 5 xil siluet mavjud va 85%+ qismi playable zona ichida", () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    const treeKeySet = new Set<string>(TREE_SPECIES_BATCH_KEYS);
    const allTrees = world.visuals.filter((v) => v.batchKey && treeKeySet.has(v.batchKey));
    const playableTrees = allTrees.filter(
      (v) =>
        Math.abs(v.transform.position.x) <= FOREST_SAMPLE_HALF &&
        Math.abs(v.transform.position.z) <= FOREST_SAMPLE_HALF,
    );

    assert.ok(
      playableTrees.length >= 180,
      `Expected >= 180 playable trees, got ${playableTrees.length}`,
    );
    const playableRatio = playableTrees.length / allTrees.length;
    assert.ok(
      playableRatio >= 0.85,
      `Expected >= 85% of trees inside playable bounds, got ${(playableRatio * 100).toFixed(1)}%`,
    );

    // 5 xil daraxt turi (silueti) ishtirok etganini tekshirish
    for (const key of TREE_SPECIES_BATCH_KEYS) {
      const count = playableTrees.filter((v) => v.batchKey === key).length;
      assert.ok(count >= 12, `Expected at least 12 trees of species ${key}, got ${count}`);
    }
  });

  it("4. Daraxtlar yerga sampleTerrainHeight(x, z) bilan aniq bog'langan (havoda osilib qolmagan)", () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    const treeKeySet = new Set<string>(TREE_SPECIES_BATCH_KEYS);
    const trees = world.visuals.filter((v) => v.batchKey && treeKeySet.has(v.batchKey));

    for (const t of trees) {
      const { x, y, z } = t.transform.position;
      const groundY = sampleTerrainHeight(world.terrain, x, z);
      assert.ok(
        Math.abs(y - groundY) < 1e-3,
        `Tree ${t.id} at (${x}, ${z}) not grounded: y=${y}, groundY=${groundY}`,
      );
    }
  });

  it("5 & 6. Daraxt kollayderlari faqat tana (trunk) qismida, o'yinchini to'sadi va barglar (foliage) kollayder emas", () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    const treeCols = world.colliders.filter((c) => c.tag === 'tree' && c.id.startsWith('forest_tree_'));
    const playableTrees = world.visuals.filter(
      (v) =>
        v.batchKey &&
        (TREE_SPECIES_BATCH_KEYS as readonly string[]).includes(v.batchKey) &&
        Math.abs(v.transform.position.x) <= FOREST_SAMPLE_HALF &&
        Math.abs(v.transform.position.z) <= FOREST_SAMPLE_HALF,
    );

    assert.equal(treeCols.length, playableTrees.length, 'Every playable tree must have a trunk collider');

    // Barg (foliage / canopy) kollayderi umuman yo'qligini va tana radiusi kichik (0.24..0.60m) ekanini tekshirish
    const foliageCols = world.colliders.filter((c) => c.id.includes('foliage') || c.id.includes('canopy') || c.id.includes('leaf'));
    assert.equal(foliageCols.length, 0);

    for (const tc of treeCols) {
      const halfW = (tc.max.x - tc.min.x) / 2;
      const halfD = (tc.max.z - tc.min.z) / 2;
      assert.ok(halfW >= 0.24 && halfW <= 0.6, `Trunk half-width ${halfW} should match trunk radius, not canopy`);
      assert.ok(halfD >= 0.24 && halfD <= 0.6, `Trunk half-depth ${halfD} should match trunk radius, not canopy`);
    }

    // O'yinchi daraxt tanasi ichidan o'tib keta olmaydi
    const sampleTree = treeCols[0];
    const tx = (sampleTree.min.x + sampleTree.max.x) / 2;
    const tz = (sampleTree.min.z + sampleTree.max.z) / 2;
    const ty = sampleTerrainHeight(world.terrain, tx, tz);
    assert.equal(collidesAtWorld(world, tx, ty + 0.05, tz, PLAYER_RADIUS, PLAYER_HEIGHT - 0.1), true);
  });

  it('7. Toshlar (mossy boulders) yerga biroz botirilgan va ustiga sakrab chiqish yoki orqasiga yashirinish mumkin', () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    const rockCols = world.colliders.filter((c) => c.tag === 'rock' && c.id.startsWith('forest_rock_'));
    assert.ok(rockCols.length >= 18, `Expected >= 18 boulder colliders, got ${rockCols.length}`);

    for (const rc of rockCols) {
      const cx = (rc.min.x + rc.max.x) / 2;
      const cz = (rc.min.z + rc.max.z) / 2;
      const groundY = sampleTerrainHeight(world.terrain, cx, cz);
      // Yerga 0.15m botirilgan
      assert.ok(rc.min.y <= groundY - 0.1, `Rock ${rc.id} must be embedded slightly into terrain`);
      assert.ok(rc.max.y > groundY + 0.6, `Rock ${rc.id} must have cover height above ground`);
    }

    // Tosh o'qni (raycastWorld) to'sadi (cover)
    const rc0 = rockCols[0];
    const rx = (rc0.min.x + rc0.max.x) / 2;
    const rz = (rc0.min.z + rc0.max.z) / 2;
    const ry = (rc0.min.y + rc0.max.y) / 2;
    const hit = raycastWorld(world, { x: rx - 3, y: ry, z: rz }, { x: 1, y: 0, z: 0 }, 6);
    assert.ok(hit, 'Ray aimed at boulder must hit cover');
  });

  it('8. Kulba eshigidan (sharqiy va janubiy eshiklardan) ichkariga yurib kirish va chiqish mumkin', () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    // Kulba markazi (-8, -6), sharqiy eshik x = -5, z = -6 (ayvon x = -5 .. -3.2, zina x = -3.2 .. -2.3)
    const startX = -1.6;
    const startZ = -6.0;
    const body: Body = {
      pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };

    // G'arbga (-X) qarab yurib, ayvon zinasidan chiqib, sharqiy eshikdan kulba markaziga (-7.5, -6.0) kirish
    for (let i = 0; i < 60; i++) {
      applyWorldMovement(body, -RUN_SPEED, 0, false, 1 / 60, world);
    }

    assert.ok(
      body.pos.x < -5.5 && body.pos.x > -10.6,
      `Player should walk through east doorway into cabin interior, got x=${body.pos.x.toFixed(2)}, z=${body.pos.z.toFixed(2)}`,
    );
    const cabinFloorCol = world.colliders.find((c) => c.id === 'forest_cabin_main:cabin_floor:col')!;
    assert.ok(
      Math.abs(body.pos.y - cabinFloorCol.max.y) < 0.05,
      `Player inside cabin should stand on wooden floor y=${cabinFloorCol.max.y}, got y=${body.pos.y}`,
    );

    // Endi kulba ichidan janubiy eshik (x = -8, z = -2.0) orqali janubga (+Z) qarab tashqariga chiqish
    body.pos.x = -8.0;
    body.pos.z = -5.5;
    for (let i = 0; i < 60; i++) {
      applyWorldMovement(body, 0, RUN_SPEED, false, 1 / 60, world);
    }
    assert.ok(body.pos.z > -0.8, `Player should walk out through south doorway, got z=${body.pos.z.toFixed(2)}`);
  });

  it("9. Kulba devorlari o'yinchini va raycastWorld() ni to'sadi, oyna teshiklaridan esa ray o'tadi", () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    const floorCol = world.colliders.find((c) => c.id === 'forest_cabin_main:cabin_floor:col')!;
    const floorY = floorCol.max.y;

    // A) G'arbiy devorning shimoliy qismi (x = -11.0, z = -8.75) raycastni to'sadi
    const originWall: Vec3 = { x: -14, y: floorY + 1.5, z: -8.75 };
    const hitWall = raycastWorld(world, originWall, { x: 1, y: 0, z: 0 }, 6);
    assert.ok(hitWall, 'Ray aimed at solid cabin wall must hit wall collider');
    assert.equal(hitWall.kind, 'collider');
    assert.equal(hitWall.colliderId, 'forest_cabin_main:west_north_seg:col');

    // B) G'arbiy oyna teshigi (x = -11.0, z = -6.0, y = floorY + 1.55) orqali ray kulba ichiga o'tadi
    const originWin: Vec3 = { x: -14, y: floorY + 1.55, z: -6.0 };
    const hitWin = raycastWorld(world, originWin, { x: 1, y: 0, z: 0 }, 5);
    assert.equal(hitWin, null, 'Ray through open window aperture should pass into cabin interior without hitting west wall');
  });

  it('10. Kulba ichida 3-shaxs kamerasi raycastWorld() orqali devor va shift oldida xavfsiz qisqaradi', () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    const floorCol = world.colliders.find((c) => c.id === 'forest_cabin_main:cabin_floor:col')!;
    const floorY = floorCol.max.y;

    // O'yinchi kulba ichida g'arbiy devor (x = -11.0, z = -8.5) yaqinida sharqqa qarab turibdi (kamera orqaga -X ga tortiladi)
    const pivot: Vec3 = { x: -9.8, y: floorY + EYE_HEIGHT + 0.18, z: -8.5 };
    const backDir = vnorm({ x: -1, y: 0.15, z: 0 });
    const maxDist = 2.35;
    const hit = raycastWorld(world, pivot, backDir, maxDist);
    assert.ok(hit, '3P camera ray inside cabin must detect wall collider behind player');
    const safeDist = Math.max(0.35, hit.t - 0.22);
    const camX = pivot.x + backDir.x * safeDist;
    // G'arbiy devor ichki yuzasi x = -10.87; kamera x > -10.87 bo'lib kulba ichida qolishi shart
    assert.ok(camX > -10.87, `Camera must stay inside cabin wall (x > -10.87), got camX=${camX}`);
  });

  it("11. Yo'l (road) daraxt yoki tosh bilan to'silib qolmagan", () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    const treeAndRockCols = world.colliders.filter((c) => c.tag === 'tree' || c.tag === 'rock');

    // Yo'lning barcha nuqtalarida (shu jumladan kulba hovlisiga olib boruvchi yo'lakda)
    // hech qanday daraxt yoki tosh kollayderi yo'l ustida yo'qligini tekshiramiz
    for (const col of treeAndRockCols) {
      const cx = (col.min.x + col.max.x) / 2;
      const cz = (col.min.z + col.max.z) / 2;
      const road = sampleForestRoad(cx, cz, 202603);
      assert.ok(
        road.dist >= 3.4,
        `Collider ${col.id} at (${cx}, ${cz}) is too close to road (dist=${road.dist.toFixed(2)})`,
      );
    }

    // Asosiy tuproq yo'l markazi bo'ylab (x >= 0) z = -44 dan +44 gacha to'siqsiz o'tish mumkin
    for (let z = -44; z <= 44; z += 1) {
      for (let x = 0; x <= 14; x += 1) {
        const road = sampleForestRoad(x, z, 202603);
        if (road.blend >= 0.85) {
          const y = sampleTerrainHeight(world.terrain, x, z);
          const blocked = collidesAtWorld(world, x, y + 0.1, z, PLAYER_RADIUS, PLAYER_HEIGHT - 0.2);
          assert.equal(
            blocked,
            false,
            `Main dirt road blocked at (${x}, ${z}) with blend=${road.blend.toFixed(2)}`,
          );
        }
      }
    }
  });

  it("12 & 13. Barcha forest_sample spawn nuqtalari isSpawnPointSafe() dan o'tadi va havodagi spawn rad etiladi", () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    assert.ok(world.spawnPoints.length >= 20, `Expected >= 20 spawn points, got ${world.spawnPoints.length}`);

    const invalid = validateMapSpawns(world);
    assert.deepEqual(invalid, [], `Invalid spawns found: ${invalid.join(', ')}`);

    for (const sp of world.spawnPoints) {
      assert.equal(isSpawnPointSafe(world, sp), true, `Spawn ${sp.id} must be safe`);
    }

    // Havoda osilib turgan spawn (y = 10) rad etilishi shart
    assert.equal(isSpawnPointSafe(world, { x: 0, y: 10, z: 0 }), false);
    // Yer ostidagi spawn rad etilishi shart
    const gy = sampleTerrainHeight(world.terrain, 0, 0);
    assert.equal(isSpawnPointSafe(world, { x: 0, y: gy - 1.0, z: 0 }), false);
  });

  it('14. dust_arena va forest_technical rejimlari buzilmagan hamda ForestRenderer low/medium/high sifatlarda ishlaydi', () => {
    assert.equal(DEFAULT_WORLD.mapId, 'dust_arena');
    assert.equal(DEFAULT_WORLD.terrain.kind, 'flat');
    assert.deepEqual(validateMapSpawns(DEFAULT_WORLD), []);

    const tech = createTechnicalTerrainFixture();
    assert.equal(tech.mapId, 'forest_technical');
    assert.equal(tech.terrain.kind, 'heightfield');
    assert.equal(tech.terrain.width, 64);
    assert.deepEqual(validateMapSpawns(tech), []);

    // NavGraph forest_sample da yo'l topa oladi
    const forest = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    const nav = getNav(forest);
    assert.ok(nav.validList.length > 1000, `Expected > 1000 valid nav nodes in 96x96 forest, got ${nav.validList.length}`);
    const path = nav.findPath(forest.spawnPoints[0], forest.spawnPoints[6]);
    assert.ok(path.length > 0, 'NavGraph must find path between spawns in forest_sample');

    // ForestRenderer scene qurilishi, InstancedMesh ishlatilishi va quality presetlari
    const scene = new THREE.Scene();
    const handles = buildWorld(scene, forest, 'medium');
    assert.ok(handles.sun);
    assert.ok(handles.sky);
    assert.ok(handles.setQuality);

    let instancedCount = 0;
    scene.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) instancedCount++;
    });
    assert.ok(instancedCount >= 12, `Expected >= 12 InstancedMeshes for trees and undergrowth, got ${instancedCount}`);

    handles.setQuality!('low');
    assert.equal(handles.sun.shadow.mapSize.x, 1024);
    handles.setQuality!('high');
    assert.equal(handles.sun.shadow.mapSize.x, 3072);
    handles.setQuality!('medium');
    assert.equal(handles.sun.shadow.mapSize.x, 2048);

    handles.dispose();
  });
});
