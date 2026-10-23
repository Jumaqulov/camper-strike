import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  FOREST_ASSET_IDS,
  FOREST_GLB_URLS,
  getCachedForestAsset,
  getCachedForestAssetByBatchKey,
  getForestAssetDiagnostics,
  registerForestAssetFromObject,
  resolveForestAssetId,
  TREE_BATCH_TO_ASSET_ID,
  type ForestAssetId,
} from '../../client/game/ForestAssetRegistry';
import {
  buildForestSampleScene,
  computeFairThirdPersonCameraDist,
} from '../../client/game/ForestRenderer';
import { Stickman } from '../../client/game/Stickman';
import { createForestSampleWorld, TREE_SPECIES_BATCH_KEYS } from '../forestSample';

function parseGlbBuffer(filePath: string): Promise<THREE.Group> {
  const buf = fs.readFileSync(filePath);
  const magic = buf.readUInt32LE(0);
  assert.equal(magic, 0x46546c67, `${filePath} haqiqiy GLB fayli bo'lishi kerak`);
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

describe('BOSQICH 03.5 — GLB Forest Integration, InstancedMesh, Visual Polish & Performance testlari', () => {
  it("1. public/models/forest/ ichida barcha 7 ta GLB fayl mavjud va haqiqiy glTF 2.0 strukturaga ega", async () => {
    const publicDir = path.resolve(process.cwd(), 'public');
    for (const assetId of FOREST_ASSET_IDS) {
      const relUrl = FOREST_GLB_URLS[assetId].replace(/^\//, '');
      const fullPath = path.join(publicDir, relUrl);
      assert.ok(fs.existsSync(fullPath), `${fullPath} mavjud bo'lishi shart`);
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 10_000, `${assetId}.glb hajmi > 10 KB bo'lishi kerak`);

      const scene = await parseGlbBuffer(fullPath);
      const tpl = registerForestAssetFromObject(assetId, scene);
      assert.ok(tpl, `${assetId} muvaffaqiyatli kompilatsiya qilinishi kerak`);
      assert.equal(tpl.hasVertexColors, true, `${assetId} COLOR_0 vertex ranglariga ega bo'lishi kerak`);
      assert.ok(tpl.triangles > 100, `${assetId} uchburchaklar soni > 100 bo'lishi kerak`);
    }

    const diag = getForestAssetDiagnostics();
    for (const assetId of FOREST_ASSET_IDS) {
      assert.equal(diag[assetId].loaded, true);
      assert.equal(diag[assetId].failed, false);
      assert.equal(diag[assetId].hasVertexColors, true);
    }
  });

  it("2. 5 xil daraxt turi, tosh va buta GLB modellarga to'g'ri va moslashuvchan bog'langan", () => {
    assert.equal(TREE_BATCH_TO_ASSET_ID['tree:pine_tall'], 'pine_tree_01');
    assert.equal(TREE_BATCH_TO_ASSET_ID['tree:pine_leaning'], 'pine_tree_02');
    assert.equal(TREE_BATCH_TO_ASSET_ID['tree:spruce_broad'], 'spruce_tree_01');
    assert.equal(TREE_BATCH_TO_ASSET_ID['tree:birch_deciduous'], 'birch_tree_01');
    assert.equal(TREE_BATCH_TO_ASSET_ID['tree:tree_ancient_dead'], 'dead_tree_01');

    assert.equal(resolveForestAssetId('rock:boulder_mossy'), 'forest_rock_01');
    assert.equal(resolveForestAssetId('foliage:bush'), 'forest_bush_01');
    assert.equal(resolveForestAssetId('tall_pine'), 'pine_tree_01');
    assert.equal(resolveForestAssetId('broad_pine'), 'pine_tree_02');
    assert.equal(resolveForestAssetId('spruce'), 'spruce_tree_01');
    assert.equal(resolveForestAssetId('birch'), 'birch_tree_01');
    assert.equal(resolveForestAssetId('dead_tree'), 'dead_tree_01');
  });

  it("3. Vizual va fizika mosligi: spruce_tree_01 pastki shoxlari ko'z darajasidan balandda (y >= 2.0m), qoramtir ranglar yoritilgan va forest_rock_01 kollayder o'lchamiga normallashtirilgan", () => {
    const spruce = getCachedForestAsset('spruce_tree_01')!;
    assert.ok(spruce.foliageGeo);
    spruce.foliageGeo.computeBoundingBox();
    assert.ok(
      spruce.foliageGeo.boundingBox!.min.y >= 2.0,
      `Spruce foliage minY (${spruce.foliageGeo.boundingBox!.min.y.toFixed(2)}) >= 2.0m bo'lishi kerak (3P kamerani to'smasligi uchun)`,
    );

    // Spruce foliage vertex colors should be lifted so average green channel is >= 0.30 (not raw 0.11)
    const spruceCol = spruce.foliageGeo.getAttribute('color') as THREE.BufferAttribute;
    let sumG = 0;
    for (let i = 0; i < spruceCol.count; i++) sumG += spruceCol.getY(i);
    const avgG = sumG / spruceCol.count;
    assert.ok(avgG >= 0.3, `Spruce foliage avg green (${avgG.toFixed(2)}) haddan tashqari qoramtir bo'lmasligi kerak`);

    // Rock normalized to ~1.04 x 1.14 x 1.04 unit collider box
    const rock = getCachedForestAsset('forest_rock_01')!;
    assert.ok(rock.rockGeo);
    rock.rockGeo.computeBoundingBox();
    const rbb = rock.rockGeo.boundingBox!;
    const rx = rbb.max.x - rbb.min.x;
    const rz = rbb.max.z - rbb.min.z;
    assert.ok(rx > 0.95 && rx < 1.15, `Normalized rock X span (${rx.toFixed(2)}) ~1.04 bo'lishi kerak`);
    assert.ok(rz > 0.95 && rz < 1.15, `Normalized rock Z span (${rz.toFixed(2)}) ~1.04 bo'lishi kerak`);
    assert.ok(rbb.min.y <= -0.1, `Rock minY (${rbb.min.y.toFixed(2)}) yerga botirilgan bo'lishi kerak`);
  });

  it("4. ForestRenderer barcha daraxt, tosh va butalarni InstancedMesh orqali chizadi va keshdagi geometriyalarni dispose() da yo'q qilmaydi", () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    const scene = new THREE.Scene();
    const handles = buildForestSampleScene(scene, world, 'high');

    for (const species of TREE_SPECIES_BATCH_KEYS) {
      const expectedTpl = getCachedForestAssetByBatchKey(species)!;
      const trunkMesh = scene.getObjectByName(`inst_${species}_trunk`) as THREE.InstancedMesh;
      const foliageMesh = scene.getObjectByName(`inst_${species}_foliage`) as THREE.InstancedMesh;
      assert.ok(trunkMesh instanceof THREE.InstancedMesh, `${species} trunk InstancedMesh bo'lishi kerak`);
      assert.ok(foliageMesh instanceof THREE.InstancedMesh, `${species} foliage InstancedMesh bo'lishi kerak`);
      assert.equal(trunkMesh.geometry, expectedTpl.barkGeo, `${species} trunk GLB geometriyasini ishlatishi kerak`);
      assert.equal(foliageMesh.geometry, expectedTpl.foliageGeo, `${species} foliage GLB geometriyasini ishlatishi kerak`);
    }

    const rockMesh = scene.getObjectByName('inst_rock:boulder_mossy') as THREE.InstancedMesh;
    const bushMesh = scene.getObjectByName('inst_foliage:bush') as THREE.InstancedMesh;
    assert.equal(rockMesh.geometry, getCachedForestAsset('forest_rock_01')!.rockGeo);
    assert.equal(bushMesh.geometry, getCachedForestAsset('forest_bush_01')!.foliageGeo);

    // Dispose scene and verify cached GLB geometries remain intact for subsequent scenes
    handles.dispose();
    const scene2 = new THREE.Scene();
    const handles2 = buildForestSampleScene(scene2, world, 'medium');
    const trunkMesh2 = scene2.getObjectByName('inst_tree:pine_tall_trunk') as THREE.InstancedMesh;
    assert.equal(trunkMesh2.geometry, getCachedForestAsset('pine_tree_01')!.barkGeo);
    assert.ok(trunkMesh2.geometry.getAttribute('position').count > 0);
    handles2.dispose();
  });

  it('5. Chunk frustum culling, quality presets (low/medium/high) va 3P kamera yaqinidagi foliage yashirish haqiqiy farq beradi', () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 202603, worldVersion: 1 });
    const scene = new THREE.Scene();
    const handles = buildForestSampleScene(scene, world, 'high');

    const grassMesh = scene.getObjectByName('inst_foliage:grass') as THREE.InstancedMesh;
    const highGrassCount = grassMesh.count;

    handles.setQuality!('medium');
    const medGrassCount = grassMesh.count;

    handles.setQuality!('low');
    const lowGrassCount = grassMesh.count;

    assert.ok(
      lowGrassCount < medGrassCount && medGrassCount < highGrassCount,
      `Quality presets must scale undergrowth counts: low=${lowGrassCount}, medium=${medGrassCount}, high=${highGrassCount}`,
    );

    // Camera frustum culling test: looking near map edge should cull chunks behind the camera
    handles.setQuality!('high');
    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 1500);
    cam.position.set(0, 2, -40);
    cam.rotation.set(0, 0, 0); // Looking North (-Z), so most of the map (+Z) is behind the camera
    handles.update!(cam, { x: 0, y: 0, z: -42 }, false);

    const tallTrunk = scene.getObjectByName('inst_tree:pine_tall_trunk') as THREE.InstancedMesh;
    const culledCount = tallTrunk.count;

    // Now place camera at top-down overview (y=78) where entire map is visible
    cam.position.set(0, 78, 54);
    cam.rotation.set(-1.02, 0, 0);
    handles.update!(cam, { x: 0, y: 0, z: 0 }, false);
    const fullOverviewCount = tallTrunk.count;

    assert.ok(
      culledCount < fullOverviewCount,
      `Frustum culling must reduce active tree instances when looking away: culled=${culledCount}, overview=${fullOverviewCount}`,
    );

    handles.dispose();
  });

  it("6. 03.5-QA PvP Foliage adolatliligi: 1P va 3P rejimda yaqin daraxt/buta cover hech qachon yo'qolmaydi va kichraymaydi; 3P kamera to'siq oldiga tortiladi", () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 6501, worldVersion: 1 });
    const scene = new THREE.Scene();
    const handles = buildForestSampleScene(scene, world, 'high');

    const bushVis = world.visuals.find((v) => v.batchKey === 'foliage:bush')!;
    const treeVis = world.visuals.find((v) => v.batchKey === 'tree:spruce_broad')!;
    assert.ok(bushVis && treeVis);

    const bushMesh = scene.getObjectByName('inst_foliage:bush') as THREE.InstancedMesh;
    const spruceFoliage = scene.getObjectByName('inst_tree:spruce_broad_foliage') as THREE.InstancedMesh;

    // Place camera right next to the bush (0.6m away) and compare 1P vs 3P with same camera pose
    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 1500);
    cam.position.set(bushVis.transform.position.x, bushVis.transform.position.y + 1.55, bushVis.transform.position.z + 0.6);
    cam.rotation.set(0, 0, 0);

    handles.update!(cam, { x: bushVis.transform.position.x, y: bushVis.transform.position.y, z: bushVis.transform.position.z }, false);
    const bushCount1P = bushMesh.count;
    const spruceCount1P = spruceFoliage.count;

    // Force a tiny camera rotation (> 1e-4) and switch to 3P right through the bush
    cam.rotation.set(0, 0.002, 0);
    handles.update!(cam, { x: bushVis.transform.position.x, y: bushVis.transform.position.y, z: bushVis.transform.position.z - 0.8 }, true);
    const bushCount3P = bushMesh.count;
    const spruceCount3P = spruceFoliage.count;

    assert.equal(bushCount3P, bushCount1P, "3P ga o'tganda yaqin buta (bush cover) yashirilmasligi shart");
    assert.equal(spruceCount3P, spruceCount1P, "3P ga o'tganda yaqin daraxt barglari (tree foliage) yashirilmasligi shart");

    // Verify no instance matrix in bushMesh was shrunk by fadeDummy
    const m4 = new THREE.Matrix4();
    const scaleVec = new THREE.Vector3();
    for (let i = 0; i < bushMesh.count; i++) {
      bushMesh.getMatrixAt(i, m4);
      scaleVec.setFromMatrixScale(m4);
      assert.ok(scaleVec.x >= 0.7, `Bush instance #${i} scale.x (${scaleVec.x.toFixed(2)}) kichraytirilmasligi kerak`);
    }

    // Verify computeFairThirdPersonCameraDist pulls camera forward when backed into a tree canopy volume or trunk
    const tx = treeVis.transform.position.x;
    const ty = treeVis.transform.position.y;
    const tz = treeVis.transform.position.z;
    const pivotNearCanopy = { x: tx, y: ty + 2.5, z: tz + 1.9 };
    const backIntoCanopy = { x: 0, y: 0.25, z: -0.968 }; // Ray pointing backward into the tree canopy
    const pulledDist = computeFairThirdPersonCameraDist(world, pivotNearCanopy, backIntoCanopy, 2.35);
    assert.ok(
      pulledDist < 2.35,
      `3P kamera daraxt shoxlari/tanasi ichiga kirib ketmasdan oldinga tortilishi kerak (dist=${pulledDist.toFixed(2)})`,
    );

    // Verify local-player-only proximity fade on Stickman
    const localStickman = new Stickman('#2e75e8');
    localStickman.setCameraProximityFade(0.42);
    // When camera is < 0.48m from player pivot, local player's own body hides so it doesn't block crosshair
    localStickman.setCameraProximityFade(1.8);
    localStickman.dispose();

    handles.dispose();
  });

  it("7. 03.5-QA Statik instancing dirty-flag va kesh: harakatsiz kamerada ortiqcha setMatrixAt va buffer upload bajarilmaydi", () => {
    const world = createForestSampleWorld({ publicLayoutSeed: 6501, worldVersion: 1 });
    const scene = new THREE.Scene();
    const handles = buildForestSampleScene(scene, world, 'medium');

    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 1500);
    cam.position.set(11.5, 2.0, 16.5);
    cam.rotation.set(0, 0.42, 0);

    handles.resetCullingProfile!();
    // 1st frame after reset evaluates culling (since camera moved from initial NaN)
    handles.update!(cam, { x: 11.5, y: 0.45, z: 16.5 }, false);
    const profAfterFirst = handles.getCullingProfile!();
    assert.equal(profAfterFirst.evaluatedFrames, 1);
    const initialUploads = profAfterFirst.batchBufferUploads;

    // Next 60 frames with stationary camera: must skip 100% of culling & buffer uploads
    for (let f = 0; f < 60; f++) {
      handles.update!(cam, { x: 11.5, y: 0.45, z: 16.5 }, false);
    }
    const profStatic = handles.getCullingProfile!();
    assert.equal(profStatic.calls, 61);
    assert.equal(profStatic.skippedStaticFrames, 60, "Harakatsiz kamerada 60 ta kadr to'liq skip qilinishi kerak");
    assert.equal(
      profStatic.batchBufferUploads,
      initialUploads,
      "Harakatsiz kamerada instanceMatrix/instanceColor qayta GPUga yuklanmasligi kerak",
    );

    // Move camera slightly (5cm) where visible instances in most batches remain unchanged
    cam.position.x += 0.05;
    handles.update!(cam, { x: 11.55, y: 0.45, z: 16.5 }, false);
    const profSmallMove = handles.getCullingProfile!();
    assert.equal(profSmallMove.evaluatedFrames, 2);
    assert.ok(
      profSmallMove.batchBufferSkips > 0,
      `Ko'rinadigan instansiyalar o'zgarmagan batchlarda buffer upload skip qilinishi kerak (skips=${profSmallMove.batchBufferSkips})`,
    );

    handles.dispose();
  });
});
