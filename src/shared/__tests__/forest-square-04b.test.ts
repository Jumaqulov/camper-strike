import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { buildWorld } from '../../client/game/World';
import { NavGraph, getNav } from '../../server/navgraph';
import { validateMapSpawns } from '../../server/room';
import { PLAYER_HEIGHT, PLAYER_RADIUS, RUN_SPEED } from '../constants';
import {
  FOREST_SQUARE_HALF,
  FOREST_SQUARE_SIZE,
  createForestSquareWorld,
  getForestSquarePoiSites,
  getForestSquareRoadNetwork,
  getPoiBuildingFootprints,
  sampleForestSquareRoad,
} from '../forestSquare';
import {
  applyWorldMovement,
  collidesAtWorld,
  isSpawnPointSafe,
  pointInsideBoxes,
  raycastWorld,
  type Body,
} from '../physics';
import {
  CONTAINER_ASSET_IDS,
  FOREST_SQUARE_POI_IDS,
  INTERIOR_ASSET_IDS,
  buildContainerAssetColliders,
  buildInteriorAssetColliders,
  compileContainerPlacementAnchors,
  compileInteriorPlacementAnchors,
  isPointInsideAnyBox,
} from '../structures';
import {
  createWorldDefinition,
  extractWorldMeta,
  sampleTerrainHeight,
  validateWorldCompatibility,
} from '../world';

describe('BOSQICH 04B — forest_square (256×256 m, 6 POI, Multi-Biome Forest & Navigation QA)', () => {
  it('1. forest_square haqiqiy 256×256 dunyo (kichik forest_sample emas!)', () => {
    const world = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 });
    const sampleWorld = createWorldDefinition({ mapId: 'forest_sample', publicLayoutSeed: 6501 });

    assert.equal(world.mapId, 'forest_square');
    assert.equal(FOREST_SQUARE_SIZE, 256);
    assert.equal(FOREST_SQUARE_HALF, 128);

    // Bounds check: 256x256 m [-128, 128]
    assert.equal(world.bounds.minX, -128);
    assert.equal(world.bounds.maxX, 128);
    assert.equal(world.bounds.minZ, -128);
    assert.equal(world.bounds.maxZ, 128);

    // Heightfield terrain check: 256x256, cellSize=2, 129x129 samples
    assert.equal(world.terrain.kind, 'heightfield');
    if (world.terrain.kind === 'heightfield') {
      assert.equal(world.terrain.width, 256);
      assert.equal(world.terrain.depth, 256);
      assert.equal(world.terrain.cellSize, 2);
      assert.equal(world.terrain.cols, 129);
      assert.equal(world.terrain.rows, 129);
      assert.equal(world.terrain.heights.length, 129 * 129);
    }

    // Fundamentally distinct from the small forest_sample world
    assert.notEqual(world.gameplayHash, sampleWorld.gameplayHash);
    assert.notEqual(world.colliders.length, sampleWorld.colliders.length);
    assert.ok(
      world.colliders.length > 1000,
      `forest_square colliderlar soni 1000 dan ko'p bo'lishi shart (actual=${world.colliders.length})`,
    );

    // World compatibility handshake check
    const meta = extractWorldMeta(world);
    assert.equal(validateWorldCompatibility(meta, meta).ok, true);
    assert.equal(validateWorldCompatibility(meta, extractWorldMeta(sampleWorld)).ok, false);
  });

  it('2. Seed determinizmi va 5+ xil seed barqarorligi', () => {
    const wA = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const wB = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 });

    assert.equal(wA.gameplayHash, wB.gameplayHash);
    assert.deepEqual(wA.colliders, wB.colliders);
    assert.deepEqual(wA.spawnPoints, wB.spawnPoints);
    assert.deepEqual(wA.locations, wB.locations);
    assert.deepEqual(wA.containerLocations, wB.containerLocations);

    const seeds = [101, 2026, 6501, 7777, 99999];
    const hashes = new Set<string>();

    for (const seed of seeds) {
      const w = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: seed });
      assert.equal(w.mapId, 'forest_square');
      assert.equal(w.publicLayoutSeed, seed);
      hashes.add(w.gameplayHash);

      // All 36 spawns must be safe for every seed
      assert.equal(w.spawnPoints.length, 36, `Seed ${seed} da 36 ta spawn bo'lishi shart`);
      const invalidSpawns = validateMapSpawns(w);
      assert.deepEqual(
        invalidSpawns,
        [],
        `Seed ${seed} da xavfsiz bo'lmagan spawnlar topildi: ${invalidSpawns.join(', ')}`,
      );
      for (const sp of w.spawnPoints) {
        assert.equal(
          isSpawnPointSafe(w, sp),
          true,
          `Seed ${seed} da spawn ${sp.id} isSpawnPointSafe dan o'tishi shart`,
        );
      }

      // Unique IDs across colliders, visuals, spawns, locations, and containerLocations
      const colIds = new Set(w.colliders.map((c) => c.id));
      assert.equal(colIds.size, w.colliders.length, `Seed ${seed}: collider IDlar unikal bo'lishi shart`);

      const visIds = new Set(w.visuals.map((v) => v.id));
      assert.equal(visIds.size, w.visuals.length, `Seed ${seed}: visual IDlar unikal bo'lishi shart`);

      const spIds = new Set(w.spawnPoints.map((s) => s.id));
      assert.equal(spIds.size, w.spawnPoints.length, `Seed ${seed}: spawn IDlar unikal bo'lishi shart`);

      const locIds = new Set(w.locations.map((l) => l.id));
      assert.equal(locIds.size, w.locations.length, `Seed ${seed}: location IDlar unikal bo'lishi shart`);

      const cntIds = new Set(w.containerLocations.map((c) => c.id));
      assert.equal(
        cntIds.size,
        w.containerLocations.length,
        `Seed ${seed}: containerLocation IDlar unikal bo'lishi shart`,
      );
    }

    assert.equal(hashes.size, seeds.length, '5 xil seed 5 xil gameplayHash berishi shart');
  });

  it('3. 6 ta POI (locations), 9 ta modulli bino va 0° / 90° / 180° / 270° rotatsiya + eshik/zinapoya harakati', () => {
    const seed = 6501;
    const world = createForestSquareWorld({ publicLayoutSeed: seed });
    const sites = getForestSquarePoiSites(seed);
    const layout = world.poiLayout;

    // 3a) All 6 POIs exist, are inside [-112, 112], and are >= 45m apart
    assert.equal(sites.length, 6);
    for (const poiId of FOREST_SQUARE_POI_IDS) {
      const loc = world.locations.find((l) => l.id === poiId);
      assert.ok(loc, `POI location ${poiId} mavjud bo'lishi shart`);
      assert.equal(loc.enterable, true);
      assert.ok(
        loc.position.x >= -112 &&
          loc.position.x <= 112 &&
          loc.position.z >= -112 &&
          loc.position.z <= 112,
        `POI ${poiId} [-112, 112] chegarasida bo'lishi shart`,
      );
    }

    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const d = Math.hypot(
          sites[i].center.x - sites[j].center.x,
          sites[i].center.z - sites[j].center.z,
        );
        assert.ok(
          d >= 45,
          `${sites[i].id} va ${sites[j].id} orasidagi masofa >= 45m bo'lishi shart (actual=${d.toFixed(2)}m)`,
        );
      }
    }

    // 3b) 9 modular buildings across all 4 cardinal rotations (0, pi/2, pi, -pi/2)
    assert.equal(layout.buildings.length, 9);
    const rotSet = new Set(layout.buildings.map((b) => Number(b.rotationY.toFixed(3))));
    const q3 = (n: number) => Number((Math.round(n * 1000) / 1000).toFixed(3));
    assert.equal(rotSet.has(q3(0)), true, '0 rad rotatsiyali bino bo‘lishi shart');
    assert.equal(rotSet.has(q3(Math.PI / 2)), true, '+90° (PI/2) rotatsiyali bino bo‘lishi shart');
    assert.equal(rotSet.has(q3(Math.PI)), true, '180° (PI) rotatsiyali bino bo‘lishi shart');
    assert.equal(rotSet.has(q3(-Math.PI / 2)), true, '-90° (-PI/2) rotatsiyali bino bo‘lishi shart');

    const dt = 1 / 60;
    const siteMap = new Map(sites.map((s) => [s.id, s]));

    // 3c) Walk into rotated buildings via applyWorldMovement and verify walls block player/raycast
    // (1) poi_cabin_cluster West 4x4 house (+90°): doorway faces +X
    {
      const clusterSite = siteMap.get('poi_cabin_cluster')!;
      const bldWest = layout.buildings.find((b) => b.id === 'poi:poi_cabin_cluster:bld:1')!;
      const ox = clusterSite.center.x - 10;
      const oz = clusterSite.center.z + 5;
      const startX = ox + 5.4;
      const startZ = oz - 1.95;
      const body: Body = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      for (let i = 0; i < 36; i++) {
        applyWorldMovement(body, -RUN_SPEED, 0, false, dt, world);
      }
      assert.ok(
        body.pos.x < ox + 3.2 && body.pos.x > ox + 1.5 && Math.abs(body.pos.y - bldWest.floorY) < 0.06,
        `poi_cabin_cluster g'arbiy +90° uyiga eshikdan kirilishi shart (pos=${JSON.stringify(body.pos)}, floorY=${bldWest.floorY})`,
      );
      // Raycast against solid west back wall (at x = ox)
      const wallHit = raycastWorld(
        world,
        { x: ox + 2.0, y: bldWest.floorY + 1.4, z: oz - 1.2 },
        { x: -1, y: 0, z: 0 },
        3.0,
      );
      assert.ok(
        wallHit !== null && wallHit.kind === 'collider',
        "poi_cabin_cluster g'arbiy +90° uy devori raycastni to'sishi shart",
      );
    }

    // (2) poi_cabin_cluster East 4x4 house (-90°): doorway faces -X
    {
      const clusterSite = siteMap.get('poi_cabin_cluster')!;
      const bldEast = layout.buildings.find((b) => b.id === 'poi:poi_cabin_cluster:bld:2')!;
      const ox = clusterSite.center.x + 10;
      const oz = clusterSite.center.z + 1;
      const startX = ox - 5.4;
      const startZ = oz + 1.95;
      const body: Body = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      for (let i = 0; i < 36; i++) {
        applyWorldMovement(body, RUN_SPEED, 0, false, dt, world);
      }
      assert.ok(
        body.pos.x > ox - 3.2 && body.pos.x < ox - 1.5 && Math.abs(body.pos.y - bldEast.floorY) < 0.06,
        `poi_cabin_cluster sharqiy -90° uyiga eshikdan kirilishi shart (pos=${JSON.stringify(body.pos)}, floorY=${bldEast.floorY})`,
      );
      // Raycast against solid east back wall (at x = ox)
      const wallHit = raycastWorld(
        world,
        { x: ox - 2.0, y: bldEast.floorY + 1.4, z: oz + 1.2 },
        { x: 1, y: 0, z: 0 },
        3.0,
      );
      assert.ok(
        wallHit !== null && wallHit.kind === 'collider',
        'poi_cabin_cluster sharqiy -90° uy devori raycastni to‘sishi shart',
      );
    }

    // (3) poi_lumber_mill 8x4 warehouse (+90°): doorway faces +X
    {
      const millSite = siteMap.get('poi_lumber_mill')!;
      const bldMill = layout.buildings.find((b) => b.id === 'poi:poi_lumber_mill:bld:0')!;
      const ox = millSite.center.x - 7;
      const oz = millSite.center.z + 4;
      const startX = ox + 5.5;
      const startZ = oz - 2.1;
      const body: Body = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      for (let i = 0; i < 45; i++) {
        applyWorldMovement(body, -RUN_SPEED, 0, false, dt, world);
      }
      assert.ok(
        body.pos.x < ox + 3.2 && body.pos.x > ox + 0.8 && Math.abs(body.pos.y - bldMill.floorY) < 0.06,
        `poi_lumber_mill +90° omboriga eshikdan kirilishi shart (pos=${JSON.stringify(body.pos)}, floorY=${bldMill.floorY})`,
      );
    }

    // (4) poi_service_station 8x4 warehouse (180°): north doorway faces -Z (approach from north walking +Z)
    {
      const serviceSite = siteMap.get('poi_service_station')!;
      const bldService = layout.buildings.find((b) => b.id === 'poi:poi_service_station:bld:0')!;
      const ox = serviceSite.center.x + 4;
      const oz = serviceSite.center.z - 3;
      const startX = ox - 2.1;
      const startZ = oz - 5.5;
      const body: Body = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      for (let i = 0; i < 45; i++) {
        applyWorldMovement(body, 0, RUN_SPEED, false, dt, world);
      }
      assert.ok(
        body.pos.z > oz - 3.2 && body.pos.z < oz - 0.8 && Math.abs(body.pos.y - bldService.floorY) < 0.06,
        `poi_service_station 180° omboriga eshikdan kirilishi shart (pos=${JSON.stringify(body.pos)}, floorY=${bldService.floorY})`,
      );
    }

    // (5) poi_forest_camp 4x4 lodge (180°): doorway faces -Z (approach from north walking +Z)
    {
      const campSite = siteMap.get('poi_forest_camp')!;
      const bldCamp = layout.buildings.find((b) => b.id === 'poi:poi_forest_camp:bld:0')!;
      const ox = campSite.center.x + 2;
      const oz = campSite.center.z + 9;
      const startX = ox - 1.95;
      const startZ = oz - 5.4;
      const body: Body = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      for (let i = 0; i < 36; i++) {
        applyWorldMovement(body, 0, RUN_SPEED, false, dt, world);
      }
      assert.ok(
        body.pos.z > oz - 3.2 && body.pos.z < oz - 1.5 && Math.abs(body.pos.y - bldCamp.floorY) < 0.06,
        `poi_forest_camp 180° uychasiga eshikdan kirilishi shart (pos=${JSON.stringify(body.pos)}, floorY=${bldCamp.floorY})`,
      );
      // Continued +Z movement must be blocked by south back wall at z = oz
      for (let i = 0; i < 60; i++) {
        applyWorldMovement(body, 0, RUN_SPEED, false, dt, world);
      }
      assert.ok(
        body.pos.z < oz,
        `poi_forest_camp 180° uychasining orqa devori o'yinchini to'sishi shart (z=${body.pos.z.toFixed(2)}, oz=${oz})`,
      );
    }

    // 3d) Climb wood_stairs_01 to y = floorY + 3.0m in poi_ranger_house (cabin_8x4) and poi_cliff_watch (watchpost_4x4)
    {
      const bldRanger = layout.buildings.find((b) => b.id === 'poi:poi_ranger_house:bld:0')!;
      const ox = bldRanger.origin.x;
      const oz = bldRanger.origin.z;
      const floorY = bldRanger.floorY;

      const climber: Body = {
        pos: { x: ox + 2.0, y: floorY, z: oz + 1.86 },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      // Move west to stair base x ~ ox + 0.52
      for (let i = 0; i < 60; i++) {
        applyWorldMovement(climber, -RUN_SPEED, 0, false, dt, world);
      }
      // Move north onto bottom stair landing z ~ oz + 0.85
      for (let i = 0; i < 45; i++) {
        applyWorldMovement(climber, 0, -RUN_SPEED, false, dt, world);
      }
      // Climb +X up all 15 steps onto the y = floorY + 3.0m loft floor
      for (let i = 0; i < 75; i++) {
        applyWorldMovement(climber, RUN_SPEED, 0, false, dt, world);
      }
      assert.ok(
        climber.pos.x > ox + 4.5 &&
          climber.pos.x < ox + 7.8 &&
          Math.abs(climber.pos.y - (floorY + 3.0)) < 0.06,
        `poi_ranger_house da zinapoyadan y=${(floorY + 3.0).toFixed(2)}m ikkinchi qavatga chiqilishi shart (pos=${JSON.stringify(climber.pos)})`,
      );
    }

    {
      const bldWatch = layout.buildings.find((b) => b.id === 'poi:poi_cliff_watch:bld:0')!;
      const ox = bldWatch.origin.x;
      const oz = bldWatch.origin.z;
      const floorY = bldWatch.floorY;
      const startX = ox - 0.75;
      const startZ = oz + 4.6;

      const watchClimber: Body = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      // Walk north (-Z) up the exterior west stairs until reaching the upper landing (z ~ oz - 0.55, y = floorY + 3.0)
      for (let i = 0; i < 90 && watchClimber.pos.z > oz - 0.5; i++) {
        applyWorldMovement(watchClimber, 0, -RUN_SPEED, false, dt, world);
      }
      assert.ok(
        Math.abs(watchClimber.pos.y - (floorY + 3.0)) < 0.06,
        `poi_cliff_watch da tashqi zinapoyadan y=${(floorY + 3.0).toFixed(2)}m 2-qavat kuzatuv maydoniga chiqilishi shart (pos=${JSON.stringify(watchClimber.pos)})`,
      );
    }
  });

  it('4. Konteynerlar (>= 20, amalda 26 ta), mebellar va unikal namespaced IDlar hamda ko‘milmagan anchorlar', () => {
    // Build with open cabinets and containers so interior/container anchors can also be tested against open doors/lids
    const world = createForestSquareWorld({
      publicLayoutSeed: 6501,
      layoutOpts: { cabinetOpenFraction: 1, containerOpenFraction: 1 },
    });
    const layout = world.poiLayout;

    // 4a) Total containers >= 20 (26), at least 3 per POI, 100% unique namespaced IDs
    assert.ok(world.containerLocations.length >= 20);
    assert.equal(world.containerLocations.length, 26);
    assert.equal(layout.containers.length, 26);

    const idPattern = /^poi:(poi_[a-z_]+):cnt_\d+:(wooden_loot_crate_01|metal_locker_01|old_toolbox_01)$/;
    const seenIds = new Set<string>();
    const countsByPoi = new Map<string, number>();

    for (const cnt of world.containerLocations) {
      assert.match(
        cnt.id,
        idPattern,
        `Konteyner ID formati "poi:<poiId>:cnt_<idx>:<assetId>" bo'lishi shart: ${cnt.id}`,
      );
      assert.equal(seenIds.has(cnt.id), false, `Takroriy konteyner ID: ${cnt.id}`);
      seenIds.add(cnt.id);
      countsByPoi.set(cnt.locationId, (countsByPoi.get(cnt.locationId) ?? 0) + 1);
    }

    for (const poiId of FOREST_SQUARE_POI_IDS) {
      const c = countsByPoi.get(poiId) ?? 0;
      assert.ok(c >= 3, `${poiId} da kamida 3 ta konteyner bo'lishi shart (actual=${c})`);
    }

    // 4b) All 3 container GLB types and all 6 interior furniture GLB types are present on the map
    const presentContainerAssets = new Set(layout.containers.map((c) => c.assetId));
    for (const assetId of CONTAINER_ASSET_IDS) {
      assert.equal(
        presentContainerAssets.has(assetId),
        true,
        `Konteyner GLB turi ${assetId} xaritada qatnashishi shart`,
      );
    }

    const presentInteriorAssets = new Set(layout.interiors.map((f) => f.assetId));
    for (const assetId of INTERIOR_ASSET_IDS) {
      assert.equal(
        presentInteriorAssets.has(assetId),
        true,
        `Mebel GLB turi ${assetId} xaritada qatnashishi shart`,
      );
    }

    // 4c) Verify under_bed, inside_bottom/inside_shelf, and inside_container anchors are NOT buried inside any collider
    const nonFloorWorldColliders = world.colliders.filter(
      (c) => !c.id.includes(':wood_floor_01:floor_slab'),
    );

    const beds = layout.interiors.filter((f) => f.assetId === 'old_bed_01');
    assert.ok(beds.length >= 4, 'Xaritada kamida 4 ta old_bed_01 (shu jumladan aylantirilgan binolarda) bo‘lishi shart');
    for (const bed of beds) {
      const bedCols = buildInteriorAssetColliders(
        bed.id,
        bed.assetId,
        bed.position,
        bed.rotationY,
        bed.openFraction,
      );
      const anchors = compileInteriorPlacementAnchors(bed);
      const underBed = anchors.find((a) => a.name === 'under_bed');
      assert.ok(underBed, `${bed.id} da under_bed anchori bo'lishi shart`);
      assert.equal(
        pointInsideBoxes(bedCols, underBed.worldPosition),
        false,
        `${bed.id} (yaw=${bed.rotationY}) under_bed anchori pointInsideBoxes bo'yicha collider ichida ko'milmasligi shart`,
      );
      assert.equal(
        pointInsideBoxes(nonFloorWorldColliders, underBed.worldPosition),
        false,
        `${bed.id} under_bed anchori bino/mebel colliderlari ichida ko'milmasligi shart`,
      );
      assert.equal(
        isPointInsideAnyBox(world.colliders, underBed.worldPosition),
        false,
        `${bed.id} under_bed anchori collider ichida bo'lmasligi shart`,
      );
    }

    const cabinets = layout.interiors.filter((f) => f.assetId === 'kitchen_cabinet_01');
    assert.ok(cabinets.length >= 6, 'Xaritada kamida 6 ta kitchen_cabinet_01 bo‘lishi shart');
    for (const cab of cabinets) {
      const cabCols = buildInteriorAssetColliders(
        cab.id,
        cab.assetId,
        cab.position,
        cab.rotationY,
        cab.openFraction,
      );
      const cabWallAndDoorCols = cabCols.filter((c) => !c.id.includes('_plank:'));
      const anchors = compileInteriorPlacementAnchors(cab).filter(
        (a) => a.name.startsWith('inside_bottom') || a.name.startsWith('inside_shelf'),
      );
      assert.equal(anchors.length, 4);
      for (const anchor of anchors) {
        assert.equal(
          pointInsideBoxes(cabWallAndDoorCols, anchor.worldPosition),
          false,
          `${cab.id} (yaw=${cab.rotationY}) -> ${anchor.name} pointInsideBoxes bo'yicha shkaf devor/eshik colliderlari ichida ko'milmasligi shart`,
        );
        assert.equal(
          isPointInsideAnyBox(cabCols, anchor.worldPosition),
          false,
          `${cab.id} (yaw=${cab.rotationY}) -> ${anchor.name} korpus/polka colliderlari ichida ko'milmasligi shart`,
        );
        assert.equal(
          isPointInsideAnyBox(world.colliders, anchor.worldPosition),
          false,
          `${cab.id} -> ${anchor.name} dunyo colliderlari ichida bo'lmasligi shart`,
        );
      }
    }

    for (const cnt of layout.containers) {
      const cntCols = buildContainerAssetColliders(
        cnt.id,
        cnt.assetId,
        cnt.position,
        cnt.rotationY,
        cnt.openFraction,
      );
      const anchors = compileContainerPlacementAnchors(cnt);
      assert.ok(anchors.length >= 2);
      for (const anchor of anchors) {
        assert.equal(anchor.category, 'inside_container');
        assert.equal(
          pointInsideBoxes(cntCols, anchor.worldPosition),
          false,
          `${cnt.id} (yaw=${cnt.rotationY}) -> ${anchor.name} pointInsideBoxes bo'yicha collider ichida ko'milmasligi shart`,
        );
        assert.equal(
          pointInsideBoxes(nonFloorWorldColliders, anchor.worldPosition),
          false,
          `${cnt.id} -> ${anchor.name} bino/konteyner colliderlari ichida ko'milmasligi shart`,
        );
        assert.equal(
          isPointInsideAnyBox(world.colliders, anchor.worldPosition),
          false,
          `${cnt.id} -> ${anchor.name} collider ichida bo'lmasligi shart`,
        );
      }
    }
  });

  it('5. Yo‘l tarmog‘i, o‘rmon vegetatsiyasi (500+ daraxt, 80+ tosh) va to‘qnashmaslik (no overlap)', () => {
    const seed = 6501;
    const world = createForestSquareWorld({ publicLayoutSeed: seed });
    const sites = getForestSquarePoiSites(seed);
    const roads = getForestSquareRoadNetwork(seed);
    const footprints = getPoiBuildingFootprints(world.poiLayout);

    // 5a) Main road + branch roads exist and connect all 6 POI roadAnchors
    assert.ok(roads.length >= 4, 'Asosiy yo‘l va shoxobcha yo‘llar mavjud bo‘lishi shart');
    assert.equal(roads.some((r) => r.id === 'main_road'), true);
    assert.equal(roads.some((r) => r.id.startsWith('branch_')), true);

    for (const site of sites) {
      const sample = sampleForestSquareRoad(site.roadAnchor.x, site.roadAnchor.z, seed);
      assert.ok(
        sample.dist < 2.5,
        `POI ${site.id} roadAnchor yo'l tarmog'iga ulangan bo'lishi shart (dist=${sample.dist.toFixed(2)}m)`,
      );
    }

    // 5b) Tree colliders >= 500, rock colliders >= 80
    const treeColliders = world.colliders.filter((c) => c.tag === 'tree');
    const rockColliders = world.colliders.filter((c) => c.tag === 'rock');
    assert.ok(
      treeColliders.length >= 500,
      `Daraxt colliderlari >= 500 bo'lishi shart (actual=${treeColliders.length})`,
    );
    assert.ok(
      rockColliders.length >= 80,
      `Tosh colliderlari >= 80 bo'lishi shart (actual=${rockColliders.length})`,
    );

    // 5c) No tree or rock collider overlaps the road surface, any POI flatRadius pad, or any building footprint
    for (const col of [...treeColliders, ...rockColliders]) {
      const cx = (col.min.x + col.max.x) * 0.5;
      const cz = (col.min.z + col.max.z) * 0.5;

      const roadSample = sampleForestSquareRoad(cx, cz, seed);
      assert.ok(
        roadSample.dist >= 3.4,
        `${col.id} (${cx.toFixed(1)}, ${cz.toFixed(1)}) yo'l ustida bo'lmasligi shart (dist=${roadSample.dist.toFixed(2)}m)`,
      );

      for (const site of sites) {
        const dToPoi = Math.hypot(cx - site.center.x, cz - site.center.z);
        assert.ok(
          dToPoi >= site.flatRadius,
          `${col.id} POI ${site.id} tekis maydonchasi (flatRadius=${site.flatRadius}m) ichiga tushmasligi shart (d=${dToPoi.toFixed(2)}m)`,
        );
      }

      for (const fp of footprints) {
        const insideBuilding =
          col.max.x > fp.minX && col.min.x < fp.maxX && col.max.z > fp.minZ && col.min.z < fp.maxZ;
        assert.equal(
          insideBuilding,
          false,
          `${col.id} bino footprinti ichiga tushmasligi shart`,
        );
      }
    }
  });

  it('6. 36 ta Spawn nuqtasi, NavGraph yo‘l topishi va buildWorld sahna culler/shadow tekshiruvi', (t) => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    // 6a) 12 'red', 12 'blue', 12 'none' spawns — all safe and non-colliding
    assert.equal(world.spawnPoints.length, 36);
    const redSpawns = world.spawnPoints.filter((s) => s.team === 'red');
    const blueSpawns = world.spawnPoints.filter((s) => s.team === 'blue');
    const ffaSpawns = world.spawnPoints.filter((s) => s.team === 'none');
    assert.equal(redSpawns.length, 12);
    assert.equal(blueSpawns.length, 12);
    assert.equal(ffaSpawns.length, 12);

    for (const sp of world.spawnPoints) {
      assert.equal(isSpawnPointSafe(world, sp), true, `Spawn ${sp.id} xavfsiz bo'lishi shart`);
      assert.equal(
        collidesAtWorld(world, sp.x, sp.y + 0.02, sp.z, PLAYER_RADIUS, PLAYER_HEIGHT - 0.02),
        false,
        `Spawn ${sp.id} hech qanday collider bilan to'qnashmasligi shart`,
      );
    }

    // 6b) new NavGraph(world) builds and finds paths from north to south & between POIs.
    // 08B-FINAL-QA: the < 250 ms budget lives in src/shared/__perf__/navgraph-build.perf.test.ts
    // (`npm run test:perf`, serial, warm-up + median). Under the parallel functional suite this
    // single cold sample measured CPU contention (327–507 ms), not NavGraph itself (~150–190 ms alone).
    const t0 = performance.now();
    const nav = new NavGraph(world);
    t.diagnostic(`NavGraph(forest_square) build (parallel suite, info only): ${(performance.now() - t0).toFixed(1)} ms`);
    assert.equal(nav.nx, 64);
    assert.equal(nav.nz, 64);
    assert.ok(nav.validList.length > 2500);

    // Path from north red spawn to south blue spawn
    const northRed = redSpawns[0];
    const southBlue = blueSpawns[0];
    const pathNS = nav.findPath(
      { x: northRed.x, y: northRed.y, z: northRed.z },
      { x: southBlue.x, y: southBlue.y, z: southBlue.z },
    );
    assert.ok(
      pathNS.length >= 2,
      `Shimoldan janubga NavGraph findPath yo'l topishi shart (len=${pathNS.length})`,
    );

    // Path between POI road anchors (e.g. poi_ranger_house -> poi_service_station -> poi_cliff_watch)
    const sites = getForestSquarePoiSites(6501);
    const rangerAnchor = sites.find((s) => s.id === 'poi_ranger_house')!.roadAnchor;
    const serviceAnchor = sites.find((s) => s.id === 'poi_service_station')!.roadAnchor;
    const cliffAnchor = sites.find((s) => s.id === 'poi_cliff_watch')!.roadAnchor;

    const pathPoi1 = nav.findPath(
      {
        x: rangerAnchor.x,
        y: sampleTerrainHeight(world.terrain, rangerAnchor.x, rangerAnchor.z),
        z: rangerAnchor.z,
      },
      {
        x: serviceAnchor.x,
        y: sampleTerrainHeight(world.terrain, serviceAnchor.x, serviceAnchor.z),
        z: serviceAnchor.z,
      },
    );
    assert.ok(pathPoi1.length >= 2, 'poi_ranger_house va poi_service_station orasida yo‘l topilishi shart');

    const pathPoi2 = nav.findPath(
      {
        x: serviceAnchor.x,
        y: sampleTerrainHeight(world.terrain, serviceAnchor.x, serviceAnchor.z),
        z: serviceAnchor.z,
      },
      {
        x: cliffAnchor.x,
        y: sampleTerrainHeight(world.terrain, cliffAnchor.x, cliffAnchor.z),
        z: cliffAnchor.z,
      },
    );
    assert.ok(pathPoi2.length >= 2, 'poi_service_station va poi_cliff_watch orasida yo‘l topilishi shart');

    // Verify getNav(world) caching works
    const cachedNav = getNav(world);
    assert.equal(getNav(world), cachedNav);

    // 6c) buildWorld(scene, world, 'medium') builds scene, runs PoiScalabilityCuller & PlayerFollowingSunShadow, and disposes cleanly
    const scene = new THREE.Scene();
    const handles = buildWorld(scene, world, 'medium');
    assert.ok(handles.stage04a, 'forest_square buildWorld stage04a handle qaytarishi shart');
    assert.equal(handles.stage04a!.buildings.doorControllers.size, 11);
    assert.equal(handles.stage04a!.containers.controllers.size, 26);

    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 500);
    // Position camera near poi_ranger_house (-68, 4, -50) looking at (-68, 2, -64)
    camera.position.set(-68, 4, -50);
    camera.lookAt(-68, 2, -64);
    camera.updateProjectionMatrix();

    handles.update?.(camera, { x: -68, y: 2, z: -64 }, false);
    assert.equal(
      handles.sun.target.position.x,
      -68,
      'PlayerFollowingSunShadow quyosh nishonini 4m qadam bilan o‘yinchi X koordinatasiga moslashi shart',
    );
    assert.equal(
      handles.sun.target.position.z,
      -64,
      'PlayerFollowingSunShadow quyosh nishonini 4m qadam bilan o‘yinchi Z koordinatasiga moslashi shart',
    );

    // Distant POI furniture (e.g. poi_cliff_watch at ~66, 66, >180m away) must be culled when camera is at (-68, 4, -50)
    const distantFurnGroup = handles.stage04a!.interiors.instances.get(
      'poi:poi_cliff_watch:furn_0:wooden_shelf_01',
    );
    assert.ok(distantFurnGroup, 'poi_cliff_watch mebel guruhi mavjud bo‘lishi shart');
    assert.equal(
      distantFurnGroup.visible,
      false,
      'Uzoqdagi (>62m) POI mebellari PoiScalabilityCuller tomonidan yashirilishi shart',
    );

    // Switch to top-down overview (camera.y > 32) and verify shadow frustum expands to ±135m
    camera.position.set(0, 180, 0.01);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    handles.update?.(camera, { x: 0, y: 0, z: 0 }, false);
    assert.equal(handles.sun.shadow.camera.right, 135);
    assert.equal(distantFurnGroup.visible, true);

    handles.dispose();
  });
});
