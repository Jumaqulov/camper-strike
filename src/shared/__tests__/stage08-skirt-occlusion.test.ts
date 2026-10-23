import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createForestSquareWorld } from '../forestSquare';
import { sampleTerrainHeight } from '../terrain';
import { buildAnnularSkirtGeometry } from '../../client/game/terrain/skirtGeometry';

describe('BOSQICH 08-TERRAIN-SKIRT-OCCLUSION-FIX — Relyef qoplamasi va tashqi skirt sinovlari', () => {
  it('1. Reproduktsiya: seed 6501 da x64/z4, x-14/z58, x-14/z52 nuqtalarida eski skirt (-0.02m) terrain ustida bo‘lganini isbotlash', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    const yFirstJoin = sampleTerrainHeight(world.terrain, 64, 4);
    const yRoadEdge = sampleTerrainHeight(world.terrain, -14, 58);
    const yMeadow = sampleTerrainHeight(world.terrain, -14, 52);
    const yDirtRoad = sampleTerrainHeight(world.terrain, 3.05, -87.5);

    const legacySkirtY = -0.02;

    // First Join: y ≈ -0.324m (skirt 0.304m balandroq bo'lib yopgan)
    assert.ok(yFirstJoin < legacySkirtY, `First join terrain (${yFirstJoin}) eski skirt (${legacySkirtY}) ostida qolgan`);
    assert.ok(Math.abs(yFirstJoin - (-0.324)) < 0.02, `First join balandligi -0.324m ga yaqin: ${yFirstJoin}`);

    // Road Edge: y ≈ -0.141m (skirt 0.121m balandroq bo'lib yopgan)
    assert.ok(yRoadEdge < legacySkirtY, `Road edge terrain (${yRoadEdge}) eski skirt ostida qolgan`);
    assert.ok(Math.abs(yRoadEdge - (-0.141)) < 0.02, `Road edge balandligi -0.141m ga yaqin: ${yRoadEdge}`);

    // Meadow: y ≈ -0.130m (skirt 0.110m balandroq bo'lib yopgan)
    assert.ok(yMeadow < legacySkirtY, `Meadow terrain (${yMeadow}) eski skirt ostida qolgan`);
    assert.ok(Math.abs(yMeadow - (-0.130)) < 0.02, `Meadow balandligi -0.130m ga yaqin: ${yMeadow}`);

    // Dirt road baland joyda bo'lgani sababli yopilmagan (y ≈ +2.958m)
    assert.ok(yDirtRoad > legacySkirtY, `Dirt road (${yDirtRoad}) skirt ustida bo'lgan`);
  });

  it('2. Yangi annular skirt geometriyasi: ichki [-128, 128] x [-128, 128] hududida 0 ta uchburchak va 0 hit mavjud', () => {
    const skirtGeo = buildAnnularSkirtGeometry(128, 600, 0.0);
    const mesh = new THREE.Mesh(skirtGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld();

    const raycaster = new THREE.Raycaster();

    const checkPointHits = (x: number, z: number): number => {
      raycaster.set(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
      return raycaster.intersectObject(mesh).length;
    };

    // Playable hududdagi barcha muhim nuqtalar tekshiriladi
    const keyPoints = [
      { name: 'First Join (64, 4)', x: 64, z: 4 },
      { name: 'Road Edge (-14, 58)', x: -14, z: 58 },
      { name: 'Meadow 1P/3P (-14, 52)', x: -14, z: 52 },
      { name: 'Origin (0, 0)', x: 0, z: 0 },
      { name: 'Dirt Road (3.05, -87.5)', x: 3.05, z: -87.5 },
      { name: 'Ranger House (-71, -48)', x: -71, z: -48 },
      { name: 'Near NE border (126, 126)', x: 126, z: 126 },
      { name: 'Near SW border (-126, -126)', x: -126, z: -126 },
      { name: 'Near NW border (-126, 126)', x: -126, z: 126 },
      { name: 'Near SE border (126, -126)', x: 126, z: -126 },
    ];

    for (const pt of keyPoints) {
      const hits = checkPointHits(pt.x, pt.z);
      assert.equal(hits, 0, `${pt.name} da skirt yuzasi bo'lmasligi shart, lekin ${hits} ta hit topildi!`);
    }

    // O'ynaladigan maydon bo'ylab muntazam panjara (grid) tekshiruvi: 41 x 41 nuqta
    for (let x = -120; x <= 120; x += 10) {
      for (let z = -120; z <= 120; z += 10) {
        assert.equal(checkPointHits(x, z), 0, `Playable maydon ichida (${x}, ${z}) nuqtada skirt bo'lmasligi shart`);
      }
    }
  });

  it('3. Tashqi skirt hududi: [-600, 600] oralig‘ida xarita tashqarisida aynan 1 ta hit mavjud', () => {
    const skirtGeo = buildAnnularSkirtGeometry(128, 600, 0.0);
    const mesh = new THREE.Mesh(skirtGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld();

    const raycaster = new THREE.Raycaster();

    const checkPointHits = (x: number, z: number): number => {
      raycaster.set(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
      return raycaster.intersectObject(mesh).length;
    };

    // Xarita tashqarisidagi 4 yo'nalish
    assert.equal(checkPointHits(0, -300), 1, 'Shimoliy tashqi skirt');
    assert.equal(checkPointHits(0, 300), 1, 'Janubiy tashqi skirt');
    assert.equal(checkPointHits(-300, 0), 1, 'G‘arbiy tashqi skirt');
    assert.equal(checkPointHits(300, 0), 1, 'Sharqiy tashqi skirt');
    assert.equal(checkPointHits(400, 400), 1, 'Janubiy-sharqiy burchak tashqi skirt');
    assert.equal(checkPointHits(-400, -400), 1, 'Shimoliy-g‘arbiy burchak tashqi skirt');

    // Skirt tashqarisida (xarita ufqidan uzoqda) 0 ta hit
    assert.equal(checkPointHits(700, 0), 0, 'Sharqdan tashqarida hit yo‘q');
    assert.equal(checkPointHits(0, -700), 0, 'Shimoldan tashqarida hit yo‘q');
  });

  it('4. Choksiz ulanish: xarita chegarasi (|x|=128 yoki |z|=128) va skirt ichki chegarasi y=0.0 da to‘liq mos', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    // Terrain chegarasidagi balandliklar
    for (let x = -128; x <= 128; x += 16) {
      assert.equal(sampleTerrainHeight(world.terrain, x, -128), 0.0, `Terrain shimoliy chegarasi (${x}, -128) y=0.0 bo'lishi shart`);
      assert.equal(sampleTerrainHeight(world.terrain, x, 128), 0.0, `Terrain janubiy chegarasi (${x}, 128) y=0.0 bo'lishi shart`);
    }
    for (let z = -128; z <= 128; z += 16) {
      assert.equal(sampleTerrainHeight(world.terrain, -128, z), 0.0, `Terrain g‘arbiy chegarasi (-128, ${z}) y=0.0 bo'lishi shart`);
      assert.equal(sampleTerrainHeight(world.terrain, 128, z), 0.0, `Terrain sharqiy chegarasi (128, ${z}) y=0.0 bo'lishi shart`);
    }

    // Skirt geometriyasi ichki koordinatalari
    const skirtGeo = buildAnnularSkirtGeometry(128, 600, 0.0);
    const pos = skirtGeo.getAttribute('position') as THREE.BufferAttribute;
    assert.equal(pos.count, 16, '4 ta to‘g‘ri to‘rtburchak = 16 ta vertex');

    // Barcha vertexlar y koordinatasi 0.0 bo'lishi shart
    for (let i = 0; i < pos.count; i++) {
      assert.equal(pos.getY(i), 0.0, `Skirt vertex #${i} y=0.0 bo'lishi shart`);
    }
  });
});
