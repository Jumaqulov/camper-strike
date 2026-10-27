import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  getBuildingAssetDiagnostics,
  registerBuildingAssetFromObject,
} from '../../client/game/buildings';
import {
  getContainerAssetDiagnostics,
  registerContainerAssetFromObject,
} from '../../client/game/containers';
import {
  getInteriorAssetDiagnostics,
  registerInteriorAssetFromObject,
} from '../../client/game/interiors';
import { getStage04ASharedMaterial } from '../../client/game/Stage04ASharedMaterials';
import { buildWorld } from '../../client/game/World';
import { makeFlatWorld } from './flatWorldFixture';
import { getNav } from '../../server/navgraph';
import { validateMapSpawns } from '../../server/room';
import { PLAYER_HEIGHT, RUN_SPEED, STEP_HEIGHT } from '../constants';
import {
  applyWorldMovement,
  collidesAt,
  isSpawnPointSafe,
  pointInsideBoxes,
  raycastBoxes,
  raycastWorld,
  type Body,
} from '../physics';
import {
  BUILDING_ASSET_IDS,
  BUILDING_GLB_URLS,
  BUILDING_MANIFESTS,
  CONTAINER_ASSET_IDS,
  CONTAINER_GLB_URLS,
  CONTAINER_MANIFESTS,
  INTERIOR_ASSET_IDS,
  INTERIOR_GLB_URLS,
  INTERIOR_MANIFESTS,
  STAGE04A_ASSET_IDS,
  buildBuildingModuleColliders,
  buildCabin8x4Furniture,
  buildCabin8x4Prefab,
  buildContainerAssetColliders,
  buildInteriorAssetColliders,
  buildKitchenCabinetDoorColliders,
  buildRoom4x4Furniture,
  buildRoom4x4Prefab,
  buildStage04APreviewLayout,
  buildWoodDoorLeafCollider,
  compileBuildingPrefabColliders,
  compileContainerPlacementAnchors,
  compileInteriorPlacementAnchors,
  isPointInsideAnyBox,
} from '../structures';
import {
  buildForestSampleTerrain,
  computeGameplayHash,
  createForestAssetsPreviewWorld,
  createWorldDefinition,
  sampleTerrainHeight,
  type ColliderBox,
  type WorldDefinition,
} from '../world';

function parseGlbFile(fullPath: string): Promise<THREE.Group> {
  const buf = fs.readFileSync(fullPath);
  const magic = buf.readUInt32LE(0);
  assert.equal(magic, 0x46546c67, `${fullPath} haqiqiy GLB fayli bo‘lishi shart`);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      '',
      (gltf) => resolve(gltf.scene),
      (err) => reject(err),
    );
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Tekis (barcha balandliklar `baseY`) heightfield dunyo — eski Dust Arena "flat" relyefi o'rniga. */
function makeFlatWorldWithColliders(colliders: ColliderBox[], baseY = -5): WorldDefinition {
  return makeFlatWorld(colliders, { size: 128, baseY, mapId: 'forest_sample' });
}

describe('BOSQICH 04A — Shared Structures, Segmented Colliders & Layout Builder', () => {
  it('1. 17 ta GLB manifestlari to‘liq hamda deraza (1.2x1.0m) va eshik (1.8x2.4m) bo‘shliqlari raycastWorld uchun ochiq', () => {
    assert.equal(STAGE04A_ASSET_IDS.length, 17);
    assert.equal(BUILDING_ASSET_IDS.length, 8);
    assert.equal(INTERIOR_ASSET_IDS.length, 6);
    assert.equal(CONTAINER_ASSET_IDS.length, 3);

    const cabin = buildCabin8x4Prefab({ x: 0, y: 0, z: 0 }, 'test_cabin');
    const room = buildRoom4x4Prefab({ x: 20, y: 0, z: 0 }, 'test_room');
    assert.equal(cabin.modules.length, 23); // 17 asosiy + 6 ta ikkinchi qavat devori
    assert.equal(room.modules.length, 10);

    const world = makeFlatWorldWithColliders([
      ...compileBuildingPrefabColliders(cabin),
      ...compileBuildingPrefabColliders(room),
    ]);

    // 1a) Cabin front doorway at (2, 0..2.4, 4): center ray at (2.15, 1.2, 6) -> (0, 0, -1) passes into cabin
    const doorPassHit = raycastWorld(
      world,
      { x: 2.15, y: 1.2, z: 6.0 },
      { x: 0, y: 0, z: -1 },
      3.5,
    );
    assert.equal(doorPassHit, null, 'Ochiq eshik bo‘shlig‘idan (2.15, 1.2) ray o‘tishi shart');

    // Left jamb of door wall at x = 0.55, y = 1.2, z = 4 blocks ray
    const doorJambHit = raycastWorld(
      world,
      { x: 0.55, y: 1.2, z: 6.0 },
      { x: 0, y: 0, z: -1 },
      3.5,
    );
    assert.ok(doorJambHit !== null && doorJambHit.kind === 'collider', 'Eshik chap kesakisi o‘qni to‘sishi shart');

    // Top lintel above doorway at x = 2.0, y = 2.7, z = 4 blocks ray
    const doorLintelHit = raycastWorld(
      world,
      { x: 2.0, y: 2.7, z: 6.0 },
      { x: 0, y: 0, z: -1 },
      3.5,
    );
    assert.ok(doorLintelHit !== null && doorLintelHit.kind === 'collider', 'Eshik tepa to‘sini o‘qni to‘sishi shart');

    // Closed door leaf (0 rad) blocks doorway ray, while open door leaf (1.38 rad) leaves doorway clear
    const closedDoorCol = buildWoodDoorLeafCollider('closed_door', { x: 2, y: 0, z: 4 }, 0, 0);
    const closedDoorHit = raycastBoxes(
      [closedDoorCol],
      { x: 2.15, y: 1.2, z: 6.0 },
      { x: 0, y: 0, z: -1 },
      3.5,
    );
    assert.ok(closedDoorHit !== null, 'Yopiq eshik tabaqasi (0 rad) o‘qni to‘sishi shart');

    // 1b) Window wall at (6, 0, 4): window opening x in [5.4, 6.6], y in [1.0, 2.0] is open
    const winPassHit = raycastWorld(
      world,
      { x: 6.0, y: 1.5, z: 6.0 },
      { x: 0, y: 0, z: -1 },
      3.5,
    );
    assert.equal(winPassHit, null, 'Deraza teshigidan (6.0, 1.5) ray bemalol o‘tishi shart');

    // Window sill below opening (y = 0.5) and header above opening (y = 2.5) block ray
    const winSillHit = raycastWorld(
      world,
      { x: 6.0, y: 0.5, z: 6.0 },
      { x: 0, y: 0, z: -1 },
      3.5,
    );
    assert.ok(winSillHit !== null, 'Deraza ostki tokchasi (y=0.5) o‘qni to‘sishi shart');

    const winHeaderHit = raycastWorld(
      world,
      { x: 6.0, y: 2.5, z: 6.0 },
      { x: 0, y: 0, z: -1 },
      3.5,
    );
    assert.ok(winHeaderHit !== null, 'Deraza ustki to‘sini (y=2.5) o‘qni to‘sishi shart');

    // 1c) 4x4 room west window at (20, 1.5, 2) passes ray along +X
    const roomWinPass = raycastWorld(
      world,
      { x: 18.0, y: 1.5, z: 2.0 },
      { x: 1, y: 0, z: 0 },
      3.5,
    );
    assert.equal(roomWinPass, null, '4x4 xona g‘arbiy derazasidan ray o‘tishi shart');
  });

  it('2. O‘yinchi (applyWorldMovement, PLAYER_RADIUS = 0.38, PLAYER_HEIGHT = 1.8) 8x4 kulba va 4x4 xonaga kirib-chiqa oladi hamda zinadan y = 3.0m loftga ko‘tariladi', () => {
    const dt = 1 / 60;
    const cabin = buildCabin8x4Prefab({ x: 0, y: 0, z: 0 }, 'walk_cabin');
    const cabinBoxes = compileBuildingPrefabColliders(cabin);
    const cabinWorld = makeFlatWorldWithColliders(cabinBoxes, 0);

    // 2a) Walk from outside (2.1, 0, 5.5) into 8x4 cabin (z < 2.2) and back out (z > 5.0)
    const bodyCabin: Body = {
      pos: { x: 2.1, y: 0, z: 5.5 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };

    for (let i = 0; i < 90; i++) {
      applyWorldMovement(bodyCabin, 0, -RUN_SPEED, false, dt, cabinWorld);
    }
    assert.ok(
      bodyCabin.pos.z < 2.3 && Math.abs(bodyCabin.pos.y) < 0.05,
      `O‘yinchi 8x4 kulba eshigidan ichkariga kira olishi shart (z=${bodyCabin.pos.z.toFixed(2)}, y=${bodyCabin.pos.y.toFixed(2)})`,
    );

    // Walk back out through doorway
    for (let i = 0; i < 90; i++) {
      applyWorldMovement(bodyCabin, 0, RUN_SPEED, false, dt, cabinWorld);
    }
    assert.ok(
      bodyCabin.pos.z > 4.8,
      `O‘yinchi 8x4 kulbadan tashqariga chiqa olishi shart (z=${bodyCabin.pos.z.toFixed(2)})`,
    );

    // 2b) Walk into 8x4 cabin (z = 1.86 clears both open door leaf z >= 2.27 and stairs z <= 1.45), approach stairs at (0.52, 0, 0.85), and climb up to y = 3.0 m loft floor
    const stairClimber: Body = {
      pos: { x: 2.0, y: 0, z: 1.86 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    // Move west to x ~ 0.52
    for (let i = 0; i < 60; i++) {
      applyWorldMovement(stairClimber, -RUN_SPEED, 0, false, dt, cabinWorld);
    }
    // Move north onto bottom stair landing at z ~ 0.85
    for (let i = 0; i < 45; i++) {
      applyWorldMovement(stairClimber, 0, -RUN_SPEED, false, dt, cabinWorld);
    }
    assert.ok(
      stairClimber.pos.z < 1.15 && stairClimber.pos.y >= 0.19,
      `O‘yinchi zina boshiga chiqa olishi shart (pos=${JSON.stringify(stairClimber.pos)})`,
    );

    // Climb +X up all 15 steps onto the y = 3.0m loft floor (x in [4.5, 7.5])
    for (let i = 0; i < 75; i++) {
      applyWorldMovement(stairClimber, RUN_SPEED, 0, false, dt, cabinWorld);
    }
    assert.ok(
      stairClimber.pos.x > 4.5 && stairClimber.pos.x < 7.8 && Math.abs(stairClimber.pos.y - 3.0) < 0.05,
      `O‘yinchi wood_stairs_01 orqali y=3.0m ikkinchi qavat loft poliga chiqa olishi shart (x=${stairClimber.pos.x.toFixed(2)}, y=${stairClimber.pos.y.toFixed(2)})`,
    );

    // Verify every stair step rise is <= STEP_HEIGHT (0.45m)
    assert.equal(BUILDING_MANIFESTS.wood_stairs_01.colliderBoxes.length, 15); // 15 steps, tutqich kollayderi yo‘q
    for (const box of BUILDING_MANIFESTS.wood_stairs_01.colliderBoxes) {
      if (box.name.startsWith('stair_step_')) {
        assert.ok(box.size[1] <= 0.45 && box.size[1] <= STEP_HEIGHT);
      }
    }

    // 2c) Walk into and out of 4x4 furnished room (with open cabinet doors)
    const roomOrigin = { x: 0, y: 0, z: 0 };
    const roomPrefab = buildRoom4x4Prefab(roomOrigin, 'walk_room');
    const roomFurn = buildRoom4x4Furniture(roomOrigin, 'walk_room', 1.0);
    const roomBoxes: ColliderBox[] = [
      ...compileBuildingPrefabColliders(roomPrefab),
      ...roomFurn.flatMap((f) =>
        buildInteriorAssetColliders(f.id, f.assetId, f.position, f.rotationY, f.openFraction),
      ),
    ];
    const roomWorld = makeFlatWorldWithColliders(roomBoxes, 0);

    const roomWalker: Body = {
      pos: { x: 1.95, y: 0, z: 5.4 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 36; i++) {
      applyWorldMovement(roomWalker, 0, -RUN_SPEED, false, dt, roomWorld);
    }
    assert.ok(
      roomWalker.pos.z < 1.9 && Math.abs(roomWalker.pos.y) < 0.05,
      `O‘yinchi 4x4 xonaga bemalol yurib kira olishi shart (z=${roomWalker.pos.z.toFixed(2)}, y=${roomWalker.pos.y.toFixed(2)})`,
    );
    for (let i = 0; i < 40; i++) {
      applyWorldMovement(roomWalker, 0, RUN_SPEED, false, dt, roomWorld);
    }
    assert.ok(
      roomWalker.pos.z > 4.8,
      `O‘yinchi 4x4 xonadan tashqariga qaytib chiqa olishi shart (z=${roomWalker.pos.z.toFixed(2)})`,
    );
  });

  it('3. old_bed_01 ning under_bed anchori (y = 0..0.20m) hech qanday collider ichida ko‘milmagan (pointInsideBoxes === false)', () => {
    const bedManifest = INTERIOR_MANIFESTS.old_bed_01;
    // Must not use solid frame_mattress
    assert.ok(
      !bedManifest.colliderBoxes.some((b) => b.name === 'frame_mattress'),
      'old_bed_01 da yaxlit frame_mattress collider ishlatilmasligi shart',
    );
    assert.equal(bedManifest.colliderBoxes.length, 6); // mattress_top + headboard + 4 corner legs

    const bedPos = { x: 2.84, y: 0, z: 0.61 };
    const bedCols = buildInteriorAssetColliders('test_bed', 'old_bed_01', bedPos, 0);
    const bedAnchors = compileInteriorPlacementAnchors({
      id: 'test_bed',
      buildingId: 'room_4x4',
      assetId: 'old_bed_01',
      position: bedPos,
      rotationY: 0,
      openFraction: 0,
    });

    const underBedAnchor = bedAnchors.find((a) => a.name === 'under_bed');
    assert.ok(underBedAnchor, 'under_bed anchori mavjud bo‘lishi shart');
    assert.equal(
      pointInsideBoxes(bedCols, underBedAnchor.worldPosition),
      false,
      'under_bed (0, 0.08, 0) nuqtasi pointInsideBoxes bo‘yicha collider ichida bo‘lmasligi shart',
    );
    assert.equal(
      isPointInsideAnyBox(bedCols, { x: bedPos.x, y: 0.05, z: bedPos.z }),
      false,
      'Karavot ostidagi y=0.05m bo‘shliq colliderlardan xoli bo‘lishi shart',
    );
  });

  it('4. kitchen_cabinet_01 ichki anchorlari korpus colliderlarida ko‘milmagan va eshiklar (-1.75/+1.75 rad) ochilganda 4x4 xona yo‘lagi ochiq qoladi', () => {
    const cabManifest = INTERIOR_MANIFESTS.kitchen_cabinet_01;
    assert.ok(
      !cabManifest.colliderBoxes.some((b) => b.name === 'body'),
      'kitchen_cabinet_01 da yaxlit body collider ishlatilmasligi shart',
    );
    assert.equal(cabManifest.colliderBoxes.length, 6);

    const cabPos = { x: 0.38, y: 0, z: 3.1 };
    const cabYaw = Math.PI / 2;
    const openCols = buildInteriorAssetColliders('test_cab', 'kitchen_cabinet_01', cabPos, cabYaw, 1.0);
    const doorCols = buildKitchenCabinetDoorColliders('test_cab', cabPos, cabYaw, 1.0);
    assert.equal(doorCols.length, 2);

    const cabAnchors = compileInteriorPlacementAnchors({
      id: 'test_cab',
      buildingId: 'room_4x4',
      assetId: 'kitchen_cabinet_01',
      position: cabPos,
      rotationY: cabYaw,
      openFraction: 1.0,
    });

    const insideBottom = cabAnchors.filter((a) => a.name.startsWith('inside_bottom'));
    const insideShelf = cabAnchors.filter((a) => a.name.startsWith('inside_shelf'));
    assert.equal(insideBottom.length, 2);
    assert.equal(insideShelf.length, 2);

    for (const anchor of [...insideBottom, ...insideShelf]) {
      assert.equal(
        isPointInsideAnyBox(openCols, anchor.worldPosition),
        false,
        `Shkaf ichki anchori (${anchor.name}) hech qanday korpus/eshik collideri ichida ko‘milmasligi shart`,
      );
      // Horizontal raycast from room interior (x = 1.6) into open cabinet (-X direction) reaches anchor without hitting any collider
      const dir = { x: -1, y: 0, z: 0 };
      const origin = { x: 1.6, y: anchor.worldPosition.y + 0.02, z: anchor.worldPosition.z };
      const distToAnchor = origin.x - anchor.worldPosition.x;
      const hit = raycastBoxes(openCols, origin, dir, distToAnchor);
      assert.equal(
        hit,
        null,
        `Ochiq shkaf eshiklarida (${anchor.name}) ga oldindan yuborilgan ray to‘silmasligi shart`,
      );
    }

    // Check 4x4 room central walkway with PLAYER_RADIUS = 0.38 when cabinet doors are fully open (-1.75 / +1.75 rad)
    const roomOrigin = { x: 0, y: 0, z: 0 };
    const roomPrefab = buildRoom4x4Prefab(roomOrigin, 'room_4x4');
    const roomFurnOpen = buildRoom4x4Furniture(roomOrigin, 'room_4x4', 1.0);
    const allRoomCols: ColliderBox[] = [
      ...compileBuildingPrefabColliders(roomPrefab),
      ...roomFurnOpen.flatMap((f) =>
        buildInteriorAssetColliders(f.id, f.assetId, f.position, f.rotationY, f.openFraction),
      ),
    ];

    const playerRadius = 0.38;
    for (let z = 1.55; z <= 3.9; z += 0.15) {
      const blocked = collidesAt(allRoomCols, 2.0, 0.01, z, playerRadius, PLAYER_HEIGHT);
      assert.equal(
        blocked,
        false,
        `kitchen_cabinet_01 eshiklari to‘liq ochilganda ham (x=2.00, z=${z.toFixed(2)}) yo‘lak PLAYER_RADIUS=0.38 uchun ochiq bo‘lishi shart`,
      );
    }
  });

  it('5. 3 ta loot konteynerda simpleClosed emas, ichi bo‘sh shellSegments ishlatilgan va qopqoq/eshik ochilganda ichki anchorlarga raycast yetib boradi', () => {
    for (const assetId of CONTAINER_ASSET_IDS) {
      const manifest = CONTAINER_MANIFESTS[assetId];
      assert.ok(manifest.shellSegments.length >= 5, `${assetId} kamida 5 ta ichi bo‘sh segmentga ega bo‘lishi shart`);
      assert.ok(
        !manifest.shellSegments.some((s) => s.name === 'simpleClosed' || s.name === 'staticBody'),
        `${assetId} yaxlit simpleClosed collider ishlatmasligi shart`,
      );

      const pos = { x: 0, y: 0, z: 0 };
      const closedCols = buildContainerAssetColliders(`test_${assetId}`, assetId, pos, 0, 0);
      const openCols = buildContainerAssetColliders(`test_${assetId}`, assetId, pos, 0, 1);
      const anchors = compileContainerPlacementAnchors({
        id: `test_${assetId}`,
        locationId: 'loc_test',
        assetId,
        containerKind: 'supply_crate',
        position: pos,
        rotationY: 0,
        interactionRadius: manifest.interactionRadius,
        openFraction: 1,
      });

      assert.ok(anchors.length >= 2, `${assetId} ichki anchor nuqtalariga ega bo‘lishi shart`);

      for (const anchor of anchors) {
        assert.equal(
          isPointInsideAnyBox(openCols, anchor.worldPosition),
          false,
          `${assetId} -> ${anchor.name} collider ichida ko‘milmasligi shart`,
        );
        assert.equal(
          pointInsideBoxes(openCols, anchor.worldPosition),
          false,
          `${assetId} -> ${anchor.name} pointInsideBoxes (GR=0.08) bo‘yicha ham colliderga tegmasligi shart`,
        );

        if (assetId === 'metal_locker_01') {
          // Raycast from front (+Z -> -Z)
          const rayOrigin = { x: anchor.worldPosition.x, y: anchor.worldPosition.y, z: 1.0 };
          const rayDir = { x: 0, y: 0, z: -1 };
          const dist = rayOrigin.z - anchor.worldPosition.z;
          assert.ok(
            raycastBoxes(closedCols, rayOrigin, rayDir, dist) !== null,
            'Yopiq metal_locker_01 eshigi oldindan rayni to‘sishi shart',
          );
          assert.equal(
            raycastBoxes(openCols, rayOrigin, rayDir, dist),
            null,
            `Ochiq metal_locker_01 da ${anchor.name} ga oldindan ray hech qanday colliderga urilmasdan yetib borishi shart`,
          );
        } else {
          // Raycast from top (+Y -> -Y) for crate and toolbox
          const rayOrigin = { x: anchor.worldPosition.x, y: 1.2, z: anchor.worldPosition.z };
          const rayDir = { x: 0, y: -1, z: 0 };
          const dist = rayOrigin.y - anchor.worldPosition.y;
          assert.ok(
            raycastBoxes(closedCols, rayOrigin, rayDir, dist) !== null,
            `Yopiq ${assetId} qopqog‘i tepadan rayni to‘sishi shart`,
          );
          assert.equal(
            raycastBoxes(openCols, rayOrigin, rayDir, dist),
            null,
            `Ochiq ${assetId} da ${anchor.name} ga tepadan ray hech qanday colliderga urilmasdan yetib borishi shart`,
          );
        }
      }
    }

    // Verify full 96x96 preview layout deterministic generation
    const terrain = buildForestSampleTerrain(6501);
    const layoutA = buildStage04APreviewLayout(terrain);
    const layoutB = buildStage04APreviewLayout(terrain);
    assert.equal(layoutA.buildings.length, 2);
    assert.equal(layoutA.colliders.length, layoutB.colliders.length);
    assert.deepEqual(layoutA.colliders, layoutB.colliders);
    assert.ok(layoutA.worldAnchors.length >= 40);
  });

  it('6. src/shared/structures/ ichida hech qanday three (Three.js) importi yo‘q', () => {
    const structuresDir = path.resolve(__dirname, '../structures');
    const files = fs.readdirSync(structuresDir).filter((f) => f.endsWith('.ts'));
    assert.ok(files.includes('contracts.ts'));
    assert.ok(files.includes('manifests.ts'));
    assert.ok(files.includes('layoutBuilder.ts'));
    assert.ok(files.includes('index.ts'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(structuresDir, file), 'utf8');
      assert.equal(
        /\bfrom\s+['"]three['"]|\bimport\s*\(\s*['"]three['"]\s*\)/i.test(content),
        false,
        `${file} ichida Three.js importi bo‘lmasligi shart`,
      );
    }
  });

  it('7. forest_assets_preview WorldDefinition deterministik, barcha spawnlar xavfsiz va applyWorldMovement bilan 8x4 kulba/loft hamda 4x4 xonaga kiriladi', () => {
    const w1 = createWorldDefinition({
      mapId: 'forest_assets_preview',
      worldVersion: 1,
      publicLayoutSeed: 6501,
    });
    const w2 = createForestAssetsPreviewWorld({
      worldVersion: 1,
      publicLayoutSeed: 6501,
    });

    assert.equal(w1.mapId, 'forest_assets_preview');
    assert.equal(w1.gameplayHash, w2.gameplayHash);
    assert.equal(w1.locations.some((l) => l.id === 'loc_stage04a_cabin_8x4'), true);
    assert.equal(w1.locations.some((l) => l.id === 'loc_stage04a_room_4x4'), true);
    assert.equal(w1.containerLocations.length, 6);

    const invalidSpawns = validateMapSpawns(w1);
    assert.deepEqual(invalidSpawns, []);
    for (const sp of w1.spawnPoints) {
      assert.equal(isSpawnPointSafe(w1, sp), true, `Spawn ${sp.id} xavfsiz bo‘lishi shart`);
    }

    const nav = getNav(w1);
    assert.ok(nav.validList.length > 1000);

    // Walk into cabin_8x4 at (-11, 0.96, -8) from doorway at (-8.9, groundY, -2.5)
    const startX = -8.9;
    const startZ = -2.2;
    const body: Body = {
      pos: { x: startX, y: sampleTerrainHeight(w1.terrain, startX, startZ), z: startZ },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 75; i++) {
      applyWorldMovement(body, 0, -RUN_SPEED, false, 1 / 60, w1);
    }
    assert.ok(
      body.pos.z < -5.5 && Math.abs(body.pos.y - 0.96) < 0.05,
      `O‘yinchi forest_assets_preview da 8x4 kulbaga kira olishi shart (pos=${JSON.stringify(body.pos)})`,
    );

    // Walk into room_4x4 at (-14, 0.96, 2) from doorway at (-12.05, groundY, 7.6)
    const roomBody: Body = {
      pos: { x: -12.05, y: sampleTerrainHeight(w1.terrain, -12.05, 7.6), z: 7.6 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 36; i++) {
      applyWorldMovement(roomBody, 0, -RUN_SPEED, false, 1 / 60, w1);
    }
    assert.ok(
      roomBody.pos.z < 4.5 && roomBody.pos.z > 3.2 && Math.abs(roomBody.pos.y - 0.96) < 0.05,
      `O‘yinchi forest_assets_preview da 4x4 xonaga kira olishi shart (pos=${JSON.stringify(roomBody.pos)})`,
    );
  });

  it('8. Barcha 17 ta GLB keshga yuklanadi, buildWorld(forest_assets_preview) eshik/shkaf/konteyner pivotlarini mustaqil boshqaradi va dispose() umumiy keshni buzmaydi', async () => {
    const publicDir = path.resolve(process.cwd(), 'public');

    for (const id of BUILDING_ASSET_IDS) {
      const scene = await parseGlbFile(path.join(publicDir, BUILDING_GLB_URLS[id].replace(/^\//, '')));
      registerBuildingAssetFromObject(id, scene);
    }
    for (const id of INTERIOR_ASSET_IDS) {
      const scene = await parseGlbFile(path.join(publicDir, INTERIOR_GLB_URLS[id].replace(/^\//, '')));
      registerInteriorAssetFromObject(id, scene);
    }
    for (const id of CONTAINER_ASSET_IDS) {
      const scene = await parseGlbFile(path.join(publicDir, CONTAINER_GLB_URLS[id].replace(/^\//, '')));
      registerContainerAssetFromObject(id, scene);
    }

    const bDiag = getBuildingAssetDiagnostics();
    const iDiag = getInteriorAssetDiagnostics();
    const cDiag = getContainerAssetDiagnostics();

    for (const id of BUILDING_ASSET_IDS) {
      assert.equal(bDiag[id].loaded, true);
      assert.equal(bDiag[id].isFallback, false);
      assert.equal(bDiag[id].hasVertexColors, true);
    }
    for (const id of INTERIOR_ASSET_IDS) {
      assert.equal(iDiag[id].loaded, true);
      assert.equal(iDiag[id].isFallback, false);
      assert.equal(iDiag[id].hasVertexColors, true);
    }
    for (const id of CONTAINER_ASSET_IDS) {
      assert.equal(cDiag[id].loaded, true);
      assert.equal(cDiag[id].isFallback, false);
      assert.equal(cDiag[id].hasVertexColors, true);
    }

    // Build full 3D scene for forest_assets_preview
    const world = createForestAssetsPreviewWorld({ publicLayoutSeed: 6501, worldVersion: 1 });
    const scene = new THREE.Scene();
    const handles = buildWorld(scene, world, 'high');
    assert.ok(handles.stage04a, 'forest_assets_preview stage04a handle qaytarishi shart');

    const { buildings, interiors, containers } = handles.stage04a!;
    assert.equal(buildings.doorControllers.size, 2);
    assert.equal(interiors.cabinetControllers.size, 2);
    assert.equal(containers.controllers.size, 6);

    // Verify independent door pivot demo angle (0 rad closed -> 1.45 rad open -> null default)
    buildings.setDevDoorDemoAngle(0);
    for (const ctrl of buildings.doorControllers.values()) {
      assert.ok(Math.abs(ctrl.pivot.rotation.y) < 1e-4);
    }
    buildings.setDevDoorDemoAngle(1.42);
    for (const ctrl of buildings.doorControllers.values()) {
      assert.ok(Math.abs(ctrl.pivot.rotation.y - 1.42) < 1e-4);
    }
    buildings.setDevDoorDemoAngle(null);

    // Verify kitchen_cabinet_01 dual door pivots (-1.75 / +1.75 rad)
    interiors.setDevCabinetOpenFraction(1);
    for (const cab of interiors.cabinetControllers.values()) {
      assert.ok(Math.abs(cab.doorLeftPivot.rotation.y - -1.75) < 1e-4);
      assert.ok(Math.abs(cab.doorRightPivot.rotation.y - 1.75) < 1e-4);
    }
    interiors.setDevCabinetOpenFraction(null);

    // Verify independent container pivot rotation (opening one crate does not rotate the other crate)
    containers.setDevContainersOpenFraction(1, 'cnt_cabin_crate_01', false);
    const cabinCrate = containers.controllers.get('cnt_cabin_crate_01')!;
    const roomCrate = containers.controllers.get('cnt_room_crate_01')!;
    assert.ok(Math.abs(cabinCrate.getPivotAngleRad() - -1.92) < 1e-4);
    assert.ok(Math.abs(roomCrate.getPivotAngleRad()) < 1e-4);

    // Verify dispose() preserves shared materials and cached GLB geometries
    const woodMat = getStage04ASharedMaterial('wood');
    handles.dispose();
    assert.equal(woodMat.userData.sharedAsset, true);

    const scene2 = new THREE.Scene();
    const handles2 = buildWorld(scene2, world, 'medium');
    assert.ok(handles2.stage04a);
    handles2.dispose();
  });
});
