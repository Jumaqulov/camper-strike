import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Server, Socket } from 'socket.io';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  areAllOutdoorAssetsLoaded,
  CAMPFIRE_FIRE_ANCHOR_LOCAL,
  getCachedOutdoorAsset,
  getOutdoorAssetDiagnostics,
  getOutdoorSharedMaterial,
  OUTDOOR_ASSET_IDS,
  OUTDOOR_ASSET_MANIFEST,
  OUTDOOR_GLB_URLS,
  registerOutdoorAssetFromObject,
  SIGNPOST_ANCHOR_NAMES,
} from '../../client/game/outdoor';
import { buildWorld } from '../../client/game/World';
import { Room, validateMapSpawns } from '../../server/room';
import { EYE_HEIGHT, RUN_SPEED, STEP_HEIGHT } from '../constants';
import {
  createForestSquareWorld,
  getForestSquarePoiSites,
  sampleForestSquareRoad,
} from '../forestSquare';
import { hasLineOfSightToContainer } from '../loot';
import { vnorm, vsub, type Vec3 } from '../math';
import {
  buildForestSquareOutdoorPlacements,
  buildOutdoorPlacementColliders,
  getOutdoorPlacementSummary,
  getOutdoorTentEntrancePoint,
  getOutdoorTentInteriorPoint,
  type OutdoorAssetId,
  type OutdoorPlacement,
} from '../outdoor';
import {
  applyWorldMovement,
  isSpawnPointSafe,
  raycastBoxes,
  raycastWorld,
  type Body,
} from '../physics';
import {
  buildContainerAssetColliders,
  FOREST_SQUARE_POI_IDS,
  isPointInsideAnyBox,
} from '../structures';
import { WEAPONS } from '../weapons';
import {
  computeGameplayHash,
  createWorldDefinition,
  sampleTerrainHeight,
  type ColliderBox,
} from '../world';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

function parseGlbFile(fullPath: string): Promise<{
  scene: THREE.Group;
  magic: number;
  version: number;
  byteLength: number;
}> {
  assert.equal(fs.existsSync(fullPath), true, `GLB fayli mavjud bo'lishi shart: ${fullPath}`);
  const buf = fs.readFileSync(fullPath);
  assert.ok(buf.byteLength >= 20, `GLB fayli bo'sh bo'lmasligi shart: ${fullPath}`);
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const declaredLength = buf.readUInt32LE(8);
  assert.equal(magic, 0x46546c67, `${fullPath} magic === 0x46546c67 ('glTF') bo'lishi shart`);
  assert.equal(version, 2, `${fullPath} glTF version === 2 bo'lishi shart`);
  assert.equal(declaredLength, buf.byteLength, `${fullPath} uzunligi header bilan mos bo'lishi shart`);

  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      '',
      (gltf) =>
        resolve({
          scene: gltf.scene,
          magic,
          version,
          byteLength: buf.byteLength,
        }),
      (err) => reject(err),
    );
  });
}

function boxesOverlap(a: ColliderBox, b: ColliderBox, eps = 0.01): boolean {
  return (
    a.min.x + eps < b.max.x &&
    a.max.x - eps > b.min.x &&
    a.min.y + eps < b.max.y &&
    a.max.y - eps > b.min.y &&
    a.min.z + eps < b.max.z &&
    a.max.z - eps > b.min.z
  );
}

// ---------------- Fake Socket.IO Harness for Room Regression Test ----------------

interface EmittedRoomEvent {
  room: string;
  event: string;
  payload: unknown;
}

function createFakeIo(): { io: Server; emitted: EmittedRoomEvent[] } {
  const emitted: EmittedRoomEvent[] = [];
  const io = {
    to(room: string) {
      const emitFn = (event: string, payload: unknown) => {
        emitted.push({ room, event, payload });
      };
      return {
        emit: emitFn,
        volatile: {
          emit: emitFn,
        },
      };
    },
  } as unknown as Server;
  return { io, emitted };
}

function createFakeSocket(id: string): { socket: Socket } {
  const socket = {
    id,
    join() {},
    leave() {},
    emit() {},
    to() {
      return {
        emit() {},
      };
    },
  } as unknown as Socket;
  return { socket };
}

function findClearPlayerPosNearContainer(
  world: ReturnType<typeof createForestSquareWorld>,
  cnt: { id: string; position: Vec3; rotationY: number },
): Vec3 | null {
  const candidates: Vec3[] = [];
  for (const frontDist of [0.75, 0.9, 1.1]) {
    candidates.push({
      x: cnt.position.x + Math.sin(cnt.rotationY) * frontDist,
      y: cnt.position.y,
      z: cnt.position.z + Math.cos(cnt.rotationY) * frontDist,
    });
  }
  for (let angleDeg = 0; angleDeg < 360; angleDeg += 20) {
    const rad = (angleDeg * Math.PI) / 180;
    for (const r of [0.75, 1.0, 1.25]) {
      const x = cnt.position.x + Math.cos(rad) * r;
      const z = cnt.position.z + Math.sin(rad) * r;
      const terrainY = sampleTerrainHeight(world.terrain, x, z);
      const baseFloorY =
        cnt.position.y - terrainY > 0.65 && cnt.position.y - terrainY < 1.15
          ? cnt.position.y - 0.75
          : cnt.position.y;
      candidates.push({ x, y: baseFloorY, z });
      candidates.push({ x, y: terrainY, z });
    }
  }

  for (const pos of candidates) {
    const eye: Vec3 = { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z };
    if (hasLineOfSightToContainer(world, eye, cnt.position, cnt.id)) {
      return pos;
    }
  }
  return null;
}

describe('BOSQICH 08A — OUTDOOR-ASSET-01 (8 GLB Models, 42 Placements, Colliders & Batched Renderer)', () => {
  it('1. 8 ta Outdoor GLB va jami 36 ta GLB fayl butunligi, uchburchaklar soni, mesh nomlari hamda anchorlar tekshiruvi', async () => {
    assert.equal(OUTDOOR_ASSET_IDS.length, 8);

    // 1a) Shared outdoor module must not import Three.js
    const sharedOutdoorDir = path.resolve(__dirname, '../outdoor');
    const sharedFiles = fs.readdirSync(sharedOutdoorDir).filter((f) => f.endsWith('.ts'));
    for (const file of sharedFiles) {
      const content = fs.readFileSync(path.join(sharedOutdoorDir, file), 'utf8');
      assert.equal(
        /\bfrom\s+['"]three['"]|\bimport\s*\(\s*['"]three['"]\s*\)/i.test(content),
        false,
        `src/shared/outdoor/${file} ichida Three.js importi bo'lmasligi shart`,
      );
    }

    // 1b) Parse and register all 8 outdoor GLB files
    let totalTriangles = 0;
    for (const id of OUTDOOR_ASSET_IDS) {
      const relUrl = OUTDOOR_GLB_URLS[id].replace(/^\//, '');
      const fullPath = path.join(PUBLIC_DIR, relUrl);
      const parsed = await parseGlbFile(fullPath);
      registerOutdoorAssetFromObject(id, parsed.scene);
    }

    assert.equal(areAllOutdoorAssetsLoaded(), true, 'Barcha 8 ta outdoor GLB yuklangan bo‘lishi shart');
    const diag = getOutdoorAssetDiagnostics();

    const expectedTriMap: Record<OutdoorAssetId, number> = {
      wooden_signpost_01: 586,
      lumber_stack_01: 688,
      sawhorse_01: 480,
      old_fuel_pump_01: 1510,
      rusty_barrel_01: 912,
      forest_tent_01: 524,
      campfire_pit_01: 1462,
      wooden_railing_01: 164,
    };

    for (const id of OUTDOOR_ASSET_IDS) {
      const d = diag[id];
      const manifest = OUTDOOR_ASSET_MANIFEST[id];
      assert.equal(d.loaded, true, `${id} loaded === true bo'lishi shart`);
      assert.equal(d.isFallback, false, `${id} isFallback === false bo'lishi shart`);
      assert.equal(d.failed, false, `${id} failed === false bo'lishi shart`);
      assert.equal(d.hasVertexColors, true, `${id} hasVertexColors === true bo'lishi shart`);
      assert.equal(d.noCamerasOrLights, true, `${id} ichida kamera yoki chiroq bo'lmasligi shart`);
      assert.equal(d.triangles, expectedTriMap[id], `${id} uchburchaklar soni mos kelishi shart`);
      assert.equal(d.triangles, manifest.expectedTriangles);
      assert.equal(d.trianglesMatch, true);
      totalTriangles += d.triangles;

      for (const expectedMeshName of manifest.meshNames) {
        assert.ok(
          d.meshNames.includes(expectedMeshName),
          `${id} ichida '${expectedMeshName}' sub-mesh bo'lishi shart (actual=${d.meshNames.join(', ')})`,
        );
      }
      assert.equal(d.meshNames.length, manifest.meshNames.length);
    }

    assert.equal(totalTriangles, 6326, 'Jami 8 ta outdoor GLB 6,326 uchburchakdan iborat bo‘lishi shart');

    // Verify wooden_signpost_01 has all 6 text anchors
    const signDiag = diag.wooden_signpost_01;
    assert.ok(signDiag.signAnchors, 'wooden_signpost_01 signAnchors mavjud bo‘lishi shart');
    assert.equal(signDiag.signAnchorDiagnostics.length, 6);
    for (const anchorName of SIGNPOST_ANCHOR_NAMES) {
      assert.ok(signDiag.signAnchors![anchorName], `Anchor ${anchorName} mavjud bo'lishi shart`);
      const entry = signDiag.signAnchorDiagnostics.find((a) => a.name === anchorName);
      assert.ok(entry && entry.found && entry.positionOK, `${anchorName} aniq pozitsiyada topilishi shart`);
    }

    // Verify campfire_pit_01 has fire_anchor at [0, 0.15, 0]
    const fireDiag = diag.campfire_pit_01;
    assert.deepEqual(fireDiag.fireAnchor, [...CAMPFIRE_FIRE_ANCHOR_LOCAL]);
    assert.ok(
      fireDiag.fireAnchorDiagnostic?.found && fireDiag.fireAnchorDiagnostic.positionOK,
      'campfire_pit_01 fire_anchor [0, 0.15, 0] da topilishi shart',
    );

    // Verify wooden_railing_01 has railing_post_start
    assert.equal(diag.wooden_railing_01.hasRailingPostStart, true);

    // 1c) Verify all 36 GLB files across all 6 subdirectories in public/models/ exist on disk
    const expectedSubdirs: Record<string, number> = {
      forest: 7,
      weapons: 4,
      buildings: 8,
      interior: 6,
      loot: 3,
      outdoor: 8,
    };
    let totalGlbFiles = 0;
    for (const [sub, expectedCount] of Object.entries(expectedSubdirs)) {
      const dirPath = path.join(PUBLIC_DIR, 'models', sub);
      assert.equal(fs.existsSync(dirPath), true, `public/models/${sub} papkasi mavjud bo'lishi shart`);
      const glbs = fs.readdirSync(dirPath).filter((f) => f.endsWith('.glb'));
      assert.equal(
        glbs.length,
        expectedCount,
        `public/models/${sub} ichida ${expectedCount} ta .glb bo'lishi shart`,
      );
      totalGlbFiles += glbs.length;
    }
    assert.equal(totalGlbFiles, 36, 'Loyihada jami 36 ta .glb fayl bo‘lishi shart');
  });

  it('2. 6 ta POI va Markaziy Chorraha bo‘ylab 42 ta OutdoorPlacement joylashuvi va yerga moslashuvi (grounding)', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const placements = world.poiLayout.outdoorPlacements;
    assert.ok(placements, 'world.poiLayout.outdoorPlacements mavjud bo‘lishi shart');
    assert.equal(placements.length, 42, 'Jami 42 ta outdoor placement bo‘lishi shart');

    const summary = getOutdoorPlacementSummary(placements);
    assert.equal(summary.total, 42);

    // Verify counts per assetId
    assert.ok(summary.byAsset.wooden_signpost_01 >= 7 && summary.byAsset.wooden_signpost_01 === 8);
    assert.ok(summary.byAsset.lumber_stack_01 >= 5 && summary.byAsset.lumber_stack_01 === 5);
    assert.ok(summary.byAsset.sawhorse_01 >= 4 && summary.byAsset.sawhorse_01 === 4);
    assert.ok(summary.byAsset.old_fuel_pump_01 >= 2 && summary.byAsset.old_fuel_pump_01 === 2);
    assert.ok(summary.byAsset.rusty_barrel_01 >= 8 && summary.byAsset.rusty_barrel_01 === 10);
    assert.ok(summary.byAsset.forest_tent_01 >= 2 && summary.byAsset.forest_tent_01 === 2);
    assert.ok(summary.byAsset.campfire_pit_01 >= 3 && summary.byAsset.campfire_pit_01 === 3);
    assert.ok(summary.byAsset.wooden_railing_01 >= 6 && summary.byAsset.wooden_railing_01 === 8);

    // Verify coverage across all 6 POIs + loc_sq_central_crossroads
    for (const poiId of FOREST_SQUARE_POI_IDS) {
      assert.ok((summary.bySite[poiId] ?? 0) >= 5, `${poiId} da kamida 5 ta outdoor ob'ekt bo'lishi shart`);
    }
    assert.equal(summary.bySite.loc_sq_central_crossroads, 2);

    // Check signpost Uzbek labels
    const signposts = placements.filter((p) => p.assetId === 'wooden_signpost_01');
    for (const sp of signposts) {
      assert.ok(sp.signLabels && sp.signLabels.length === 3, `${sp.id} da 3 ta o'zbekcha yozuv bo'lishi shart`);
      for (const lbl of sp.signLabels!) {
        assert.ok(lbl.textFront.trim().length >= 3);
      }
    }

    // Check both upright and tipped barrels exist
    const barrels = placements.filter((p) => p.assetId === 'rusty_barrel_01');
    const uprightBarrels = barrels.filter((b) => Math.abs(b.rotationZ ?? 0) < 0.01);
    const tippedBarrels = barrels.filter((b) => Math.abs((b.rotationZ ?? 0) - Math.PI / 2) < 0.01);
    assert.ok(uprightBarrels.length >= 6, 'Tik turgan bochkalar bo‘lishi shart');
    assert.ok(tippedBarrels.length >= 2, 'Yonbosh yotgan (rotationZ = PI/2) bochkalar bo‘lishi shart');

    // Check chained railings with hideStartPost: true
    const railings = placements.filter((p) => p.assetId === 'wooden_railing_01');
    const chainedRailings = railings.filter((r) => r.hideStartPost === true);
    assert.ok(chainedRailings.length >= 2, 'Ulangan panjaralarda hideStartPost: true ishlatilgan bo‘lishi shart');

    // Check grounding: no placement floats > 0.05m above its surface or sinks below groundSinkY
    for (const p of placements) {
      const terrainY = sampleTerrainHeight(world.terrain, p.position.x, p.position.z);
      const manifest = OUTDOOR_ASSET_MANIFEST[p.assetId];
      if (!p.elevatedSurface) {
        const diff = Math.abs(p.position.y - terrainY);
        assert.ok(
          diff <= 0.05,
          `${p.id} yerdan >0.05m havoda muallaq turmasligi shart (y=${p.position.y}, terrainY=${terrainY})`,
        );
        assert.ok(
          p.position.y >= terrainY + manifest.groundSinkY - 0.01,
          `${p.id} groundSinkY dan chuqur ko'milmasligi shart`,
        );
      } else if (p.assetId === 'old_fuel_pump_01') {
        // Placed on 0.22m concrete fuel island slab
        assert.ok(
          Math.abs(p.position.y - (terrainY + 0.22)) <= 0.06,
          `${p.id} beton ostravok ustida (terrainY + 0.22m) turishi shart`,
        );
      } else if (p.assetId === 'rusty_barrel_01') {
        // Tipped barrel rotated 90 deg around Z has center at terrainY + 0.305m
        assert.ok(
          Math.abs(p.position.y - (terrainY + 0.305)) <= 0.05,
          `${p.id} yonboshlagan bochka yerga tegib turishi shart`,
        );
      }
    }
  });

  it('3. Seed determinizmi (publicLayoutSeed = 6501 ikki marta chaqirilganda 100% bir xil natija)', () => {
    const w1 = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const w2 = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 });

    assert.equal(w1.gameplayHash, w2.gameplayHash);
    assert.deepEqual(w1.poiLayout.outdoorPlacements, w2.stage04aLayout?.outdoorPlacements);
    assert.deepEqual(w1.colliders, w2.colliders);
    assert.deepEqual(w1.visuals, w2.visuals);

    const pA = buildForestSquareOutdoorPlacements(w1.terrain, 6501);
    const pB = buildForestSquareOutdoorPlacements(w1.terrain, 6501);
    assert.deepEqual(pA, pB);
  });

  it('4. 5 xil seed barqarorligi (6501, 1001, 2026, 7777, 424242): unikal IDlar, xavfsiz spawnlar va daraxt/tosh ustma-ust tushmasligi', () => {
    const seeds = [6501, 1001, 2026, 7777, 424242];
    const hashes = new Set<string>();

    for (const seed of seeds) {
      const w = createForestSquareWorld({ publicLayoutSeed: seed });
      hashes.add(w.gameplayHash);

      const outPlacements = w.poiLayout.outdoorPlacements!;
      assert.equal(outPlacements.length, 42, `Seed ${seed}: 42 ta outdoor placement bo'lishi shart`);

      // Unique IDs across outdoorPlacements, colliders, visuals, spawnPoints, containerLocations
      const outIds = new Set(outPlacements.map((p) => p.id));
      assert.equal(outIds.size, outPlacements.length);

      const colIds = new Set(w.colliders.map((c) => c.id));
      assert.equal(colIds.size, w.colliders.length);

      const visIds = new Set(w.visuals.map((v) => v.id));
      assert.equal(visIds.size, w.visuals.length);

      const spIds = new Set(w.spawnPoints.map((s) => s.id));
      assert.equal(spIds.size, w.spawnPoints.length);

      const cntIds = new Set(w.containerLocations.map((c) => c.id));
      assert.equal(cntIds.size, w.containerLocations.length);

      // All 36 spawns safe
      assert.equal(w.spawnPoints.length, 36);
      assert.deepEqual(validateMapSpawns(w), []);
      for (const sp of w.spawnPoints) {
        assert.equal(isSpawnPointSafe(w, sp), true, `Seed ${seed}: spawn ${sp.id} xavfsiz bo'lishi shart`);
      }

      // No tree or rock collider overlaps any outdoor placement collider
      const outdoorIdSet = new Set(outPlacements.map((p) => p.id));
      const outdoorCols = w.colliders.filter(
        (c) => c.sourceObjectId !== undefined && outdoorIdSet.has(c.sourceObjectId),
      );
      const treeAndRockCols = w.colliders.filter((c) => c.tag === 'tree' || c.tag === 'rock');

      assert.ok(outdoorCols.length >= 50);
      assert.ok(treeAndRockCols.length >= 400);

      for (const outCol of outdoorCols) {
        for (const natCol of treeAndRockCols) {
          assert.equal(
            boxesOverlap(outCol, natCol),
            false,
            `Seed ${seed}: ${outCol.id} va ${natCol.id} ustma-ust tushmasligi shart`,
          );
        }
      }
    }

    assert.equal(hashes.size, seeds.length, '5 xil seed 5 xil gameplayHash hosil qilishi shart');
  });

  it('5. forest_tent_01 ning +Z kirish qismi va ichki bo‘shlig‘i ochiqligi (yaxlit quti EMAS, 5 ta devor segmenti)', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const tents = world.poiLayout.outdoorPlacements!.filter((p) => p.assetId === 'forest_tent_01');
    assert.equal(tents.length, 2, 'poi_forest_camp da 2 ta forest_tent_01 bo‘lishi shart');

    for (const tent of tents) {
      const tentCols = buildOutdoorPlacementColliders(tent);
      // STAGE 08-FIX: rotated tents are split into yaw-aware AABB pieces (`${part}_s${i}` IDs), so the
      // old exact `length === 5` assertion encoded the inflated-AABB bug. Require all 5 wall segments
      // to be present (unsplit or as pieces) and still no single solid box.
      const tentParts = ['left_wall_front', 'left_wall_back', 'right_wall_front', 'right_wall_back', 'back_wall'];
      assert.ok(
        tentCols.length >= 5,
        `${tent.id} 5 ta devor segmentidan iborat bo'lishi shart (yaxlit solid box emas!)`,
      );
      for (const partName of tentParts) {
        assert.ok(
          tentCols.some((c) => new RegExp(`:col:${partName}(_s\\d+)?$`).test(c.id)),
          `${tent.id} ${partName} devor segmenti mavjud bo'lishi shart`,
        );
      }

      const interiorPt = getOutdoorTentInteriorPoint(tent);
      const entrancePt = getOutdoorTentEntrancePoint(tent);
      const outsideApproachPt = getOutdoorTentEntrancePoint(tent, 1.8);

      // Interior and entrance points must not be inside any tent collider or world collider
      assert.equal(
        isPointInsideAnyBox(tentCols, interiorPt),
        false,
        `${tent.id} ichki markazi (interiorPt) colliderlardan xoli bo'lishi shart`,
      );
      assert.equal(
        isPointInsideAnyBox(world.colliders, interiorPt),
        false,
        `${tent.id} ichki markazi dunyo colliderlaridan xoli bo'lishi shart`,
      );
      assert.equal(
        isPointInsideAnyBox(tentCols, entrancePt),
        false,
        `${tent.id} +Z kirish og'zi ochiq bo'lishi shart`,
      );

      // Raycast from outside +Z entrance into tent interior must be completely unobstructed
      const toInterior = vsub(interiorPt, outsideApproachPt);
      const distToInterior = Math.hypot(toInterior.x, toInterior.y, toInterior.z);
      const dirToInterior = vnorm(toInterior);
      const entranceHit = raycastBoxes(tentCols, outsideApproachPt, dirToInterior, distToInterior);
      assert.equal(
        entranceHit,
        null,
        `${tent.id} +Z kirishidan ichkariga yo'nalgan ray hech qanday devorga urilmasligi shart`,
      );

      // Raycast from interior backward (-Z local) and sideways (±X local) must hit the back and side walls
      const yaw = tent.rotationY;
      const backDir: Vec3 = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
      const rightDir: Vec3 = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
      const leftDir: Vec3 = { x: -Math.cos(yaw), y: 0, z: Math.sin(yaw) };

      const backHit = raycastBoxes(tentCols, interiorPt, backDir, 2.0);
      const rightHit = raycastBoxes(tentCols, interiorPt, rightDir, 2.0);
      const leftHit = raycastBoxes(tentCols, interiorPt, leftDir, 2.0);

      assert.ok(backHit !== null, `${tent.id} orqa devori (-Z) rayni to'sishi shart`);
      assert.ok(rightHit !== null, `${tent.id} o'ng yon devori (+X) rayni to'sishi shart`);
      assert.ok(leftHit !== null, `${tent.id} chap yon devori (-X) rayni to'sishi shart`);
    }
  });

  it('6. Barcha 26 ta loot konteyner, yo‘l ko‘rsatkich ustunlari (wooden_signpost_01) va gulxan (campfire_pit_01) harakat erkinligi', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const placements = world.poiLayout.outdoorPlacements!;
    const outdoorIdSet = new Set(placements.map((p) => p.id));
    const outdoorCols = world.colliders.filter(
      (c) => c.sourceObjectId !== undefined && outdoorIdSet.has(c.sourceObjectId),
    );

    // 6a) All 26 containers have clear interaction radius and unobstructed hasLineOfSightToContainer
    assert.equal(world.poiLayout.containers.length, 26);
    for (const cnt of world.poiLayout.containers) {
      const cntCols = buildContainerAssetColliders(
        cnt.id,
        cnt.assetId,
        cnt.position,
        cnt.rotationY,
        cnt.openFraction,
      );
      for (const cBox of cntCols) {
        for (const oBox of outdoorCols) {
          assert.equal(
            boxesOverlap(cBox, oBox),
            false,
            `Konteyner ${cnt.id} va outdoor ob'ekt ${oBox.id} to'qnashmasligi shart`,
          );
        }
      }
      const clearPos = findClearPlayerPosNearContainer(world, cnt);
      assert.ok(
        clearPos !== null,
        `Konteyner ${cnt.id} oldida hasLineOfSightToContainer ochiq nuqta topilishi shart`,
      );
    }

    // 6b) Signposts: >= 3.4m away from road centerlines at crossroads and clear of road driving lanes at POI entrances,
    // and only central post (0.16 x 2.0 x 0.16m) has collider (signboards are collider-free)
    const signposts = placements.filter((p) => p.assetId === 'wooden_signpost_01');
    assert.equal(signposts.length, 8);
    for (const sp of signposts) {
      const roadSample = sampleForestSquareRoad(sp.position.x, sp.position.z, 6501);
      if (sp.siteId === 'loc_sq_central_crossroads') {
        assert.ok(
          roadSample.dist >= 3.4,
          `Markaziy chorraha ko'rsatkichi ${sp.id} yo'l markazidan >= 3.4m chetda bo'lishi shart (actual=${roadSample.dist.toFixed(2)}m)`,
        );
      } else {
        assert.ok(
          roadSample.dist >= 1.9,
          `POI ko'rsatkichi ${sp.id} qatnov yo'lakchasidan chetda bo'lishi shart (actual=${roadSample.dist.toFixed(2)}m)`,
        );
      }

      const spCols = buildOutdoorPlacementColliders(sp);
      assert.equal(spCols.length, 1);
      assert.ok(spCols[0].max.x - spCols[0].min.x <= 0.25);

      // Raycast through the signboard height (y = pos.y + 1.5m, offset x = +0.45m from post center) hits NO signpost collider
      const boardRayOrigin: Vec3 = {
        x: sp.position.x + 0.45,
        y: sp.position.y + 1.5,
        z: sp.position.z - 1.0,
      };
      const boardHit = raycastBoxes(spCols, boardRayOrigin, { x: 0, y: 0, z: 1 }, 2.0);
      assert.equal(
        boardHit,
        null,
        `${sp.id} yuqori yozuv taxtachalari o'q yoki harakatni to'smasligi shart`,
      );
    }

    // 6c) Campfire pit: collider height <= 0.25m (<= STEP_HEIGHT) so player steps over smoothly
    const campfires = placements.filter((p) => p.assetId === 'campfire_pit_01');
    assert.equal(campfires.length, 3);
    for (const cf of campfires) {
      const cfCols = buildOutdoorPlacementColliders(cf);
      assert.equal(cfCols.length, 1);
      const h = cfCols[0].max.y - cfCols[0].min.y;
      assert.ok(h <= 0.25 && h <= STEP_HEIGHT, `Gulxan collider balandligi <= 0.25m bo'lishi shart (h=${h})`);
    }

    // Walk player across the central campfire pit at poi_forest_camp
    const campFire = campfires.find((c) => c.siteId === 'poi_forest_camp')!;
    const startZ = campFire.position.z - 1.5;
    const walker: Body = {
      pos: {
        x: campFire.position.x,
        y: sampleTerrainHeight(world.terrain, campFire.position.x, startZ),
        z: startZ,
      },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 45; i++) {
      applyWorldMovement(walker, 0, RUN_SPEED, false, 1 / 60, world);
    }
    assert.ok(
      walker.pos.z > campFire.position.z + 0.9,
      `O'yinchi gulxan tosh halqasi ustidan qoqilmasdan o'ta olishi shart (z=${walker.pos.z.toFixed(2)})`,
    );
  });

  it('7. wooden_railing_01 to‘siq fizikasi hamda old_fuel_pump_01, lumber_stack_01, sawhorse_01 va rusty_barrel_01 raycast/material tekshiruvi', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const placements = world.poiLayout.outdoorPlacements!;

    // 7a) Walking perpendicular into cliff-edge wooden_railing_01 at poi_cliff_watch stops the player
    const southRailing = placements.find(
      (p) => p.siteId === 'poi_cliff_watch' && p.role === 'cliff_railing_south_1',
    )!;
    assert.ok(southRailing);
    const startX = southRailing.position.x;
    const startZ = southRailing.position.z - 1.5;
    const body: Body = {
      pos: {
        x: startX,
        y: sampleTerrainHeight(world.terrain, startX, startZ),
        z: startZ,
      },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };

    for (let i = 0; i < 60; i++) {
      applyWorldMovement(body, 0, RUN_SPEED, false, 1 / 60, world);
    }
    assert.ok(
      body.pos.z < southRailing.position.z - 0.25,
      `wooden_railing_01 (balandligi 1.1m > STEP_HEIGHT) o'yinchini jarlik chetida to'xtatishi shart (z=${body.pos.z.toFixed(2)}, railingZ=${southRailing.position.z})`,
    );

    // 7b) Verify raycastWorld hits old_fuel_pump_01, lumber_stack_01, sawhorse_01, and upright + tipped rusty_barrel_01
    const checkPlacementRayHit = (
      p: OutdoorPlacement,
      expectedMat: 'metal' | 'crate' | 'wall',
      partName?: string,
    ) => {
      const cols = buildOutdoorPlacementColliders(p);
      const targetCol = partName ? cols.find((c) => c.id.endsWith(`:${partName}`))! : cols[0];
      assert.ok(targetCol, `${p.id} uchun collider topilishi shart`);
      assert.equal(targetCol.mat, expectedMat);

      const center: Vec3 = {
        x: (targetCol.min.x + targetCol.max.x) * 0.5,
        y: (targetCol.min.y + targetCol.max.y) * 0.5,
        z: (targetCol.min.z + targetCol.max.z) * 0.5,
      };
      const origin: Vec3 = { x: center.x, y: center.y, z: targetCol.max.z + 0.6 };
      const hit = raycastWorld(world, origin, { x: 0, y: 0, z: -1 }, 1.5);
      // STAGE 08-FIX: rotated placements are split into several yaw-aware pieces; the ray may legitimately
      // hit a neighbouring piece of the SAME placement first (old exact-ID check assumed one inflated box).
      const hitPiece = hit !== null && hit.kind === 'collider'
        ? world.colliders.find((c) => c.id === hit.colliderId)
        : undefined;
      assert.ok(
        hit !== null &&
          hit.kind === 'collider' &&
          (hit.colliderId === targetCol.id || hitPiece?.sourceObjectId === p.id),
        `raycastWorld ${p.id} (${targetCol.id}) ni urishi shart`,
      );
      const hitCol = world.colliders.find((c) => c.id === hit.colliderId);
      assert.ok(hitCol, `${hit.colliderId} world.colliders ichida topilishi shart`);
      assert.equal(hitCol.mat, expectedMat, `${p.id} zarba materiali '${expectedMat}' bo'lishi shart`);
    };

    const fuelPump = placements.find((p) => p.assetId === 'old_fuel_pump_01')!;
    const lumberStack = placements.find((p) => p.assetId === 'lumber_stack_01')!;
    const sawhorse = placements.find((p) => p.assetId === 'sawhorse_01')!;
    const uprightBarrel = placements.find(
      (p) => p.assetId === 'rusty_barrel_01' && Math.abs(p.rotationZ ?? 0) < 0.01,
    )!;
    const tippedBarrel = placements.find(
      (p) => p.assetId === 'rusty_barrel_01' && Math.abs((p.rotationZ ?? 0) - Math.PI / 2) < 0.01,
    )!;

    checkPlacementRayHit(fuelPump, 'metal', 'body');
    checkPlacementRayHit(lumberStack, 'crate');
    checkPlacementRayHit(sawhorse, 'crate');
    checkPlacementRayHit(uprightBarrel, 'metal');
    checkPlacementRayHit(tippedBarrel, 'metal');
  });

  it('8. gameplayHash sezgirligi va freezeWorldDefinitionDeep immutability kafolati', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const outdoorPlacements = world.poiLayout.outdoorPlacements!;

    assert.equal(Object.isFrozen(world), true);
    assert.equal(Object.isFrozen(world.poiLayout), true);
    assert.equal(Object.isFrozen(outdoorPlacements), true);
    assert.equal(Object.isFrozen(outdoorPlacements[0]), true);
    assert.equal(Object.isFrozen(outdoorPlacements[0].position), true);
    assert.equal(Object.isFrozen(outdoorPlacements[0].scale), true);

    assert.throws(() => {
      outdoorPlacements.push(outdoorPlacements[0]);
    }, TypeError);

    assert.throws(() => {
      outdoorPlacements[0].position.x = 999;
    }, TypeError);

    // Verify gameplayHash changes if an outdoor collider is altered
    const modifiedColliders = world.colliders.map((c, idx) =>
      idx === world.colliders.length - 1
        ? { ...c, max: { ...c.max, y: c.max.y + 0.5 } }
        : c,
    );
    const alteredHash = computeGameplayHash({
      mapId: world.mapId,
      worldVersion: world.worldVersion,
      publicLayoutSeed: world.publicLayoutSeed,
      bounds: world.bounds,
      terrain: world.terrain,
      colliders: modifiedColliders,
      spawnPoints: world.spawnPoints,
      locations: world.locations,
      containerLocations: world.containerLocations,
    });
    assert.notEqual(
      alteredHash,
      world.gameplayHash,
      'Outdoor collider o‘zgarganda gameplayHash ham o‘zgarishi shart',
    );
  });

  it('9. Client OutdoorRenderer: InstancedMesh batching (<= 16), frustum/distance culling, top-down overview, sifat rejimlari va xavfsiz dispose()', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const scene = new THREE.Scene();
    const handles = buildWorld(scene, world, 'medium');

    assert.ok(handles.stage04a?.outdoor, 'handles.stage04a.outdoor mavjud bo‘lishi shart');
    const outdoor = handles.stage04a!.outdoor!;

    const diagInitial = outdoor.getDiagnostics();
    assert.equal(diagInitial.totalPlacements, 42);
    assert.ok(
      diagInitial.instancedBatchCount > 0 && diagInitial.instancedBatchCount <= 16,
      `InstancedMesh batchlar soni <= 16 bo'lishi shart (actual=${diagInitial.instancedBatchCount})`,
    );
    assert.equal(diagInitial.signpostOverlayCount, 8);
    assert.equal(diagInitial.campfireEffectCount, 3);
    assert.equal(diagInitial.allGlbLoaded, true);

    // Verify railing_post_start omits instances with hideStartPost: true (6 posts vs 8 railing bodies)
    const bodyBatch = outdoor.group.getObjectByName(
      'outdoor_inst_wooden_railing_01_wooden_railing_01_body',
    ) as THREE.InstancedMesh | undefined;
    const postBatch = outdoor.group.getObjectByName(
      'outdoor_inst_wooden_railing_01_railing_post_start',
    ) as THREE.InstancedMesh | undefined;
    assert.ok(bodyBatch instanceof THREE.InstancedMesh);
    assert.ok(postBatch instanceof THREE.InstancedMesh);
    assert.equal(bodyBatch.count, 8);
    assert.equal(postBatch.count, 6);

    // Test ground-level camera culling near poi_ranger_house (-68, 4, -50) looking at (-68, 2, -64)
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
    camera.position.set(-68, 4, -50);
    camera.lookAt(-68, 2, -64);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    handles.update?.(camera, { x: -68, y: 2, z: -64 }, false);
    const diagCulled = outdoor.getDiagnostics();
    assert.ok(
      diagCulled.visiblePlacements > 0 && diagCulled.visiblePlacements < diagCulled.totalPlacements,
      `Uzoqdagi POI ob'ektlari cull qilinishi shart (visible=${diagCulled.visiblePlacements}/${diagCulled.totalPlacements})`,
    );

    // Test top-down overview camera (0, 180, 0.01) looking at (0, 0, 0)
    camera.position.set(0, 180, 0.01);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    handles.update?.(camera, { x: 0, y: 0, z: 0 }, false);
    const diagOverview = outdoor.getDiagnostics();
    assert.equal(
      diagOverview.visiblePlacements,
      diagOverview.totalPlacements,
      'Top-down overview rejimida barcha 42 ta placement ko‘rinishi shart',
    );

    // Test quality switching ('low' -> 'high' -> 'medium')
    handles.setQuality?.('low');
    handles.setQuality?.('high');
    handles.setQuality?.('medium');

    // Verify dispose() preserves shared materials and cached GLB geometries
    const woodMat = getOutdoorSharedMaterial('wood');
    const signpostTpl = getCachedOutdoorAsset('wooden_signpost_01');
    handles.dispose();

    assert.equal(woodMat.userData.sharedAsset, true);
    assert.equal(signpostTpl.subMeshes[0].geometry.userData.sharedAsset, true);

    // Rebuild world a second time cleanly
    const scene2 = new THREE.Scene();
    const handles2 = buildWorld(scene2, world, 'high');
    assert.ok(handles2.stage04a?.outdoor);
    assert.equal(handles2.stage04a!.outdoor!.getDiagnostics().totalPlacements, 42);
    handles2.dispose();
  });

  it('10. Stage 07-QA va eski xaritalar (dust_arena, forest_sample, forest_assets_preview) hamda Forest Survival Room regressiya tekshiruvi', () => {
    // 10a) Legacy maps build and render cleanly (provide headless canvas stub for dust_arena's addRoadSign / addGravestone)
    const prevDoc = (globalThis as Record<string, unknown>).document;
    if (!prevDoc) {
      const ctxStub = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
              return () => ({ addColorStop() {} });
            }
            if (prop === 'measureText') {
              return () => ({ width: 50 });
            }
            return () => {};
          },
        },
      );
      (globalThis as Record<string, unknown>).document = {
        createElement: () => ({
          width: 256,
          height: 256,
          getContext: () => ctxStub,
        }),
      };
    }
    try {
      for (const mapId of ['dust_arena', 'forest_sample', 'forest_assets_preview'] as const) {
        const w = createWorldDefinition({ mapId, publicLayoutSeed: 6501 });
        assert.equal(w.mapId, mapId);
        const s = new THREE.Scene();
        const h = buildWorld(s, w, 'medium');
        h.dispose();
      }
    } finally {
      if (!prevDoc) {
        delete (globalThis as Record<string, unknown>).document;
      }
    }

    // 10b) Forest Survival Room on forest_square with Stage 08A outdoor colliders works end-to-end
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Stage 08A Survival Regression Room',
        mode: 'forest_survival',
        mapId: 'forest_square',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 3,
        scoreLimit: 1,
        publicLayoutSeed: 6501,
        countdownSec: 2,
      },
      io,
      () => {},
    );

    try {
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      room.addHuman(sock1.socket, 'SurvivorAlpha');
      room.addHuman(sock2.socket, 'SurvivorBravo');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });

      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;

      // Find a container with weapon + ammo, open it, and pick up loot
      let chosenCntId = '';
      let weaponItemId = '';
      for (const cntId of room.loot.getAuthoritativeContainerIds()) {
        const raw = room.loot.getRawContainerForServerTest(cntId)!;
        for (const item of raw.items.values()) {
          if (item.kind === 'weapon' && item.weaponId) {
            chosenCntId = cntId;
            weaponItemId = item.id;
            break;
          }
        }
        if (chosenCntId) break;
      }
      assert.ok(chosenCntId && weaponItemId);
      const rawCnt = room.loot.getRawContainerForServerTest(chosenCntId)!;
      const worldSq = createForestSquareWorld({ publicLayoutSeed: 6501 });
      const clearPos = findClearPlayerPosNearContainer(worldSq, {
        id: rawCnt.id,
        position: rawCnt.position,
        rotationY: rawCnt.yaw,
      });
      assert.ok(clearPos);
      p1.pos = clearPos;

      const openAck = room.onContainerOpen('p1', {
        requestId: 's08a_open_1',
        containerId: chosenCntId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(openAck.ok, true);

      const pickAck = room.onLootPickup('p1', {
        requestId: 's08a_pick_1',
        containerId: chosenCntId,
        itemId: weaponItemId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(pickAck.ok, true);
      assert.ok(p1.weapon !== null);

      // Eliminate p2 via grenade explosion and verify round ends cleanly and blocks dead player actions
      const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
      const gx = serviceSite.center.x - 6;
      const gz = serviceSite.center.z + 6;
      const gy = sampleTerrainHeight(room.world.terrain, gx, gz);

      p1.pos = { x: gx + 18, y: sampleTerrainHeight(room.world.terrain, gx + 18, gz), z: gz };
      p2.pos = { x: gx, y: gy, z: gz };
      p2.hp = 25;
      p1.spawnTime = -99;
      p2.spawnTime = -99;
      p1.grenades = 1;
      p1.lastGrenade = -10;

      room.onGrenade('p1', { dir: { x: -1, y: 0, z: 0 } });
      const grenades = (room as unknown as { grenades: Array<{ pos: Vec3; vel: Vec3; explodeAt: number }> }).grenades;
      assert.equal(grenades.length, 1);
      grenades[0].pos = { x: gx + 0.1, y: gy + 0.2, z: gz };
      grenades[0].vel = { x: 0, y: 0, z: 0 };
      grenades[0].explodeAt = room.now() + 0.02;

      room.advanceTimeForTest(0.1, 0.05);
      assert.equal(p2.alive, false);
      assert.equal(room.phase, 'ended');

      // Dead player action must be rejected
      const deadOpenAck = room.onContainerOpen('p2', {
        requestId: 's08a_dead_open',
        containerId: chosenCntId,
        roundId: room.getRoundId(),
        spawnId: p2.spawnId,
      });
      assert.equal(deadOpenAck.ok, false);
      assert.ok(WEAPONS[p1.weapon!]);
    } finally {
      room.destroy();
    }
  });
});
