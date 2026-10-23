import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  createForestSquareWorld,
  getForestSquarePoiSites,
  sampleForestSquareRoad,
  type ForestSquareWorldDefinition,
} from '../forestSquare';
import {
  buildForestSquareTerrain,
  sampleForestSquareTerrainColor,
} from '../forestSquareTerrain';
import {
  buildForestSquareGroundCover,
  groundCoverCategoryOf,
  GROUND_COVER_BASE_HEIGHT,
  GROUND_COVER_KINDS,
  GROUND_COVER_MAX_SCALE,
  GROUND_COVER_ROAD_STRIP,
  GROUND_COVER_STRIDE,
  type GroundCoverField,
  type GroundCoverKind,
} from '../groundCover';
import {
  GRASS_VARIANT_HEIGHT,
  GRASS_VARIANT_IDS,
  GRASS_VARIANT_MAX_SCALE,
  MAX_WORLD_HEIGHT,
  getVariantCategory,
  planGrassVariant,
} from '../../client/game/grass/GrassVariantPlanner';

/**
 * 17 ta yangi GRASS-ASSET-01 GLB modeli (12 maysa, 3 gul, 2 paporotnik).
 */
const EXPECTED_GRASS_GLBS = [
  'grass_short_soft_01.glb',
  'grass_short_dense_01.glb',
  'grass_meadow_wide_01.glb',
  'grass_meadow_thin_01.glb',
  'grass_tall_wild_01.glb',
  'grass_tall_seeded_01.glb',
  'grass_dry_straw_01.glb',
  'grass_olive_tuft_01.glb',
  'grass_shade_dark_01.glb',
  'grass_forest_sparse_01.glb',
  'grass_path_edge_01.glb',
  'grass_wavy_broad_01.glb',
  'flower_white_01.glb',
  'flower_yellow_01.glb',
  'flower_purple_01.glb',
  'fern_small_01.glb',
  'fern_wide_01.glb',
] as const;

const TEST_SEEDS = [6501, 1, 42, 1337, 2024] as const;

interface ParsedInstance {
  kind: GroundCoverKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

function extractAllInstances(field: GroundCoverField): ParsedInstance[] {
  const result: ParsedInstance[] = [];
  for (const chunk of field.chunks) {
    for (const kind of GROUND_COVER_KINDS) {
      const arr = chunk.batches[kind];
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += GROUND_COVER_STRIDE) {
        result.push({
          kind,
          x: arr[i]!,
          y: arr[i + 1]!,
          z: arr[i + 2]!,
          yaw: arr[i + 3]!,
          scale: arr[i + 4]!,
        });
      }
    }
  }
  return result;
}

/**
 * Yo'llardan va POI maydonlaridan uzoqda joylashgan ochiq tabiiy maysazor nuqtasini topish.
 */
function findOpenMeadowPoint(seed: number): { x: number; y: number; z: number } {
  const sites = getForestSquarePoiSites(seed);
  const candidates = [
    { x: -35, z: 35 },
    { x: -25, z: -25 },
    { x: 30, z: -35 },
    { x: -20, z: 45 },
    { x: 25, z: 35 },
  ];
  for (const c of candidates) {
    const road = sampleForestSquareRoad(c.x, c.z, seed);
    if (road.dist < 10) continue;
    const nearPoi = sites.some(
      (s) => Math.hypot(s.center.x - c.x, s.center.z - c.z) < s.flatRadius + 6,
    );
    if (nearPoi) continue;
    return { x: c.x, y: 0, z: c.z };
  }
  return { x: -35, y: 0, z: 35 };
}

describe('BOSQICH 08-TERRAIN-VISUAL — GLB Maysalar, Relyef Ranglari, Yo‘l Tozaligi va Regressiya QA', () => {
  // =========================================================================
  // 1. Asset Verification
  // =========================================================================
  it('1. Asset Tekshiruvi: public/models/grass/ da barcha 17 ta GLB mavjud, hajmi 5 KB - 35 KB oralig‘ida va glTF 2.0 binar sarlavhasi to‘g‘ri', () => {
    const grassDir = path.resolve(process.cwd(), 'public/models/grass');
    assert.ok(fs.existsSync(grassDir), `Grass papkasi mavjud bo'lishi kerak: ${grassDir}`);

    let totalBytes = 0;

    for (const fileName of EXPECTED_GRASS_GLBS) {
      const fullPath = path.join(grassDir, fileName);
      assert.ok(
        fs.existsSync(fullPath),
        `GLB fayl topilmadi: ${fileName} (${fullPath})`,
      );

      const stat = fs.statSync(fullPath);
      assert.ok(
        stat.size > 5 * 1024,
        `Fayl hajmi 5 KB dan katta bo'lishi kerak: ${fileName} (${stat.size} bayt)`,
      );
      assert.ok(
        stat.size < 35 * 1024,
        `Fayl hajmi 35 KB dan kichik bo'lishi kerak: ${fileName} (${stat.size} bayt)`,
      );

      totalBytes += stat.size;

      // glTF 2.0 binar sarlavhasi tekshiruvi:
      // Byte 0-3: 'glTF' (0x46546C67)
      // Byte 4-7: version 2
      // Byte 8-11: length
      const fd = fs.openSync(fullPath, 'r');
      const headerBuf = Buffer.alloc(12);
      fs.readSync(fd, headerBuf, 0, 12, 0);
      fs.closeSync(fd);

      const magic = headerBuf.readUInt32LE(0);
      const version = headerBuf.readUInt32LE(4);
      const reportedLen = headerBuf.readUInt32LE(8);

      assert.equal(
        magic,
        0x46546c67,
        `GLB magic header 'glTF' mos kelmadi: ${fileName}`,
      );
      assert.equal(
        version,
        2,
        `glTF versiyasi 2 bo'lishi kerak: ${fileName}`,
      );
      assert.equal(
        reportedLen,
        stat.size,
        `GLB header length faylning haqiqiy hajmiga teng bo'lishi kerak: ${fileName}`,
      );
    }

    assert.equal(EXPECTED_GRASS_GLBS.length, 17, 'Aynan 17 ta GLB model tekshirilishi kerak');
    // Jami hajm taxminan 206-215 KB oralig'ida
    assert.ok(
      totalBytes > 200 * 1024 && totalBytes < 225 * 1024,
      `Jami 17 ta GLB hajmi ~207 KB bo'lishi kerak: haqiqiy ${totalBytes} bayt`,
    );
  });

  // =========================================================================
  // 2. Terrain Color Sampling
  // =========================================================================
  it('2. Relyef Rangi Namunalari: sampleForestSquareTerrainColor 5 xil seedda to‘g‘ri [r, g, b] qaytaradi, yo‘l markazi tuproqrang va tik qiyaliklar tosh-kulrang', () => {
    for (const seed of TEST_SEEDS) {
      // 2a. Turli koordinatalar va balandliklarda qiymatlar [0..1] oralig'ida bo'lishini tekshirish
      const samplePoints = [
        { x: 0, y: 0, z: 0, slope: 0 },
        { x: -50, y: 1.5, z: 40, slope: 12 },
        { x: 60, y: -0.8, z: -70, slope: 8 },
        { x: -108, y: 5.0, z: -106, slope: 48 }, // tik qoya
        { x: 104, y: 4.5, z: 96, slope: 52 },   // tik qoya
        { x: 25, y: 0.1, z: -15, slope: 2 },
      ];

      for (const pt of samplePoints) {
        const color = sampleForestSquareTerrainColor(pt.x, pt.y, pt.z, pt.slope, seed);
        assert.ok(
          Array.isArray(color) && color.length === 3,
          `Rang 3 elementli tuple bo'lishi kerak: seed=${seed}`,
        );
        const [r, g, b] = color;
        assert.ok(
          r >= 0 && r <= 1,
          `Red kanal [0, 1] oralig'ida bo'lishi kerak: r=${r}, seed=${seed}`,
        );
        assert.ok(
          g >= 0 && g <= 1,
          `Green kanal [0, 1] oralig'ida bo'lishi kerak: g=${g}, seed=${seed}`,
        );
        assert.ok(
          b >= 0 && b <= 1,
          `Blue kanal [0, 1] oralig'ida bo'lishi kerak: b=${b}, seed=${seed}`,
        );
      }

      // 2b. Yo'l markazi tuproq rang (earthy/dirt) bo'lib, ochiq maysazorga qaraganda to'qroq va jigar-qizg'ish
      // POI roadAnchor nuqtalari to'g'ridan-to'g'ri yo'l poliliniyasi ustida yotadi
      const poiSites = getForestSquarePoiSites(seed);
      const serviceSite = poiSites.find((s) => s.id === 'poi_service_station')!;
      const roadAnchor = serviceSite.roadAnchor;

      const roadInfo = sampleForestSquareRoad(roadAnchor.x, roadAnchor.z, seed);
      assert.ok(
        roadInfo.dist < 0.25,
        `roadAnchor yo'l markaziy chizig'ida bo'lishi kerak: dist=${roadInfo.dist} (seed=${seed})`,
      );

      const roadColor = sampleForestSquareTerrainColor(roadAnchor.x, 0, roadAnchor.z, 0, seed);
      // Ochiq tabiiy maysazor: yo'ldan va POI hovlisidan uzoq
      const meadow = findOpenMeadowPoint(seed);
      const meadowRoadInfo = sampleForestSquareRoad(meadow.x, meadow.z, seed);
      assert.ok(meadowRoadInfo.dist > 10, `Ochiq maysazor yo'ldan uzoqda: dist=${meadowRoadInfo.dist}`);
      const grassColor = sampleForestSquareTerrainColor(meadow.x, meadow.y, meadow.z, 2, seed);

      const [rRoad, gRoad, bRoad] = roadColor;
      const [rGrass, gGrass, bGrass] = grassColor;

      // Maysazorda yashil dominant (g > r)
      assert.ok(
        gGrass > rGrass,
        `Ochiq maysazorda yashil komponent qizildan ustun bo'lishi kerak: g=${gGrass} > r=${rGrass} (seed=${seed})`,
      );

      // Yo'l markazida tuproq jigar-qizg'ish tusga ega (r > g)
      assert.ok(
        rRoad > gRoad,
        `Yo'l markazida tuproq-jigarrang qizil komponenti yashildan ustun bo'lishi kerak: r=${rRoad} > g=${gRoad} (seed=${seed})`,
      );

      // Yo'lning yashilligi ochiq maysazordan sezilarli kam (tuproq tusli)
      assert.ok(
        gRoad < gGrass,
        `Yo'l markazidagi yashillik maysazor yashilligidan kam bo'lishi kerak: gRoad=${gRoad} < gGrass=${gGrass} (seed=${seed})`,
      );

      // Yo'ldagi tuproq qizil/jigarrang komponenti maysazordan yuqori
      assert.ok(
        rRoad > rGrass,
        `Yo'l markazida tuproq komponenti maysazor qizilidan ko'proq: rRoad=${rRoad} > rGrass=${rGrass} (seed=${seed})`,
      );

      // 2c. Tik qiyaliklar (slopeDeg > 45°) tosh kulrang / slate tonlarda bo'lishi kerak
      const steepSlopes = [46, 50, 60, 75];
      for (const slope of steepSlopes) {
        const steepColor = sampleForestSquareTerrainColor(0, 0, 0, slope, seed);
        const [rSteep, gSteep, bSteep] = steepColor;

        // Barcha kanallar muvozanatli (neytral kulrang/tosh tus, farq <= 0.06)
        const maxDiff = Math.max(
          Math.abs(rSteep - gSteep),
          Math.abs(rSteep - bSteep),
          Math.abs(gSteep - bSteep),
        );
        assert.ok(
          maxDiff <= 0.06,
          `Tik qiyalik (slope=${slope}°) neytral tosh-kulrang bo'lishi kerak, maxDiff=${maxDiff} (seed=${seed})`,
        );

        // Yashil haddan tashqari dominant emas (o't emas, tosh)
        assert.ok(
          gSteep < 0.36,
          `Tik qoyada yashil rang chegaralangan bo'lishi kerak: g=${gSteep} (seed=${seed})`,
        );
      }
    }
  });

  // =========================================================================
  // 3. World Determinism & Hash Preservation
  // =========================================================================
  it('3. Determinizm va Hash Saqlanishi: Relyef heightfield takroriy chaqiriqda baytma-bayt bir xil, ground cover gameplayHash va colliderlarga tegmaydi, 36 spawn va 26 konteyner o‘zgarmaydi', () => {
    for (const seed of TEST_SEEDS) {
      // 3a. buildForestSquareTerrain determinizmi
      const terrainA = buildForestSquareTerrain(seed);
      const terrainB = buildForestSquareTerrain(seed);

      assert.equal(
        terrainA.heights.length,
        terrainB.heights.length,
        `Relyef nuqtalari soni teng bo'lishi kerak: seed=${seed}`,
      );
      assert.equal(
        terrainA.cols,
        terrainB.cols,
        `Relyef ustunlari soni teng: seed=${seed}`,
      );
      assert.equal(
        terrainA.rows,
        terrainB.rows,
        `Relyef qatorlari soni teng: seed=${seed}`,
      );

      const bufA = Buffer.from(new Float32Array(terrainA.heights).buffer);
      const bufB = Buffer.from(new Float32Array(terrainB.heights).buffer);
      assert.ok(
        bufA.equals(bufB),
        `buildForestSquareTerrain heightfield baytma-bayt bir xil bo'lishi kerak: seed=${seed}`,
      );

      // 3b. World yaratish va hash saqlanishi
      const world = createForestSquareWorld({ publicLayoutSeed: seed });
      const originalGameplayHash = world.gameplayHash;
      const originalColliderCount = world.colliders.length;
      const originalCollidersJson = JSON.stringify(world.colliders);
      const originalSpawnsCount = world.spawnPoints.length;
      const originalContainersCount = world.containerLocations.length;

      // 3c. 36 ta spawn va 26 ta konteyner mavjudligini tasdiqlash
      assert.equal(
        originalSpawnsCount,
        36,
        `O'rmon xaritasida aynan 36 ta spawn bo'lishi kerak: haqiqiy ${originalSpawnsCount} (seed=${seed})`,
      );
      assert.equal(
        originalContainersCount,
        26,
        `O'rmon xaritasida aynan 26 ta loot konteyneri bo'lishi kerak: haqiqiy ${originalContainersCount} (seed=${seed})`,
      );

      // 3d. Ground cover chaqiruvi world obyektini o'zgartirmasligi kerak
      const fieldA = buildForestSquareGroundCover(world);
      assert.ok(fieldA.total > 0, `Ground cover instansiyalari hosil bo'lishi kerak (seed=${seed})`);

      assert.equal(
        world.gameplayHash,
        originalGameplayHash,
        `Ground cover yaratilishi gameplayHash ni aslo o'zgartirmasligi kerak! seed=${seed}`,
      );
      assert.equal(
        world.colliders.length,
        originalColliderCount,
        `Ground cover yangi fizika collideri qo'shmasligi kerak! seed=${seed}`,
      );
      assert.equal(
        JSON.stringify(world.colliders),
        originalCollidersJson,
        `Colliderlar massivi o'zgarmasdan saqlanishi kerak: seed=${seed}`,
      );
      assert.equal(
        world.spawnPoints.length,
        36,
        `Spawnlar soni 36 tadan kamaymasligi yoki ko'paymasligi kerak: seed=${seed}`,
      );
      assert.equal(
        world.containerLocations.length,
        26,
        `Konteynerlar soni 26 tadan kamaymasligi yoki ko'paymasligi kerak: seed=${seed}`,
      );

      // 3e. Field ning o'zi ham deterministik
      const fieldB = buildForestSquareGroundCover(world);
      assert.equal(
        fieldA.total,
        fieldB.total,
        `Qayta chaqirilganda instansiyalar soni teng bo'lishi kerak: seed=${seed}`,
      );
    }
  });

  // =========================================================================
  // 4. PvP Height Limits
  // =========================================================================
  it('4. PvP Balandlik Chegaralari: Barcha o‘simliklar ko‘rish/otishma adolatini buzmaydi (maysa <= 0.45m, gul <= 0.35m, paporotnik <= 0.60m)', () => {
    // 4a. Shared groundCover nazariy maksimal balandliklari (BASE_HEIGHT * MAX_SCALE)
    for (const kind of GROUND_COVER_KINDS) {
      const baseH = GROUND_COVER_BASE_HEIGHT[kind];
      const maxScale = GROUND_COVER_MAX_SCALE[kind];
      const theoreticalMaxH = baseH * maxScale;
      const cat = groundCoverCategoryOf(kind);

      if (cat === 'grass') {
        assert.ok(
          theoreticalMaxH <= 0.4501,
          `Maysa ${kind} nazariy maksimal balandligi 0.45m dan oshmasligi kerak: ${theoreticalMaxH}m`,
        );
      } else if (cat === 'flower') {
        assert.ok(
          theoreticalMaxH <= 0.3501,
          `Gul ${kind} nazariy maksimal balandligi 0.35m dan oshmasligi kerak: ${theoreticalMaxH}m`,
        );
      } else if (cat === 'fern') {
        assert.ok(
          theoreticalMaxH <= 0.6001,
          `Paporotnik ${kind} nazariy maksimal balandligi 0.60m dan oshmasligi kerak: ${theoreticalMaxH}m`,
        );
      }
    }

    // 4b. GrassVariantPlanner dagi barcha 17 GLB modellari uchun scale cap tekshiruvi
    for (const variantId of GRASS_VARIANT_IDS) {
      const baseH = GRASS_VARIANT_HEIGHT[variantId];
      const maxScale = GRASS_VARIANT_MAX_SCALE[variantId];
      const category = getVariantCategory(variantId);
      const allowedWorldH = MAX_WORLD_HEIGHT[category];
      const worldH = baseH * maxScale;

      assert.ok(
        worldH <= allowedWorldH + 0.001,
        `Variant ${variantId} (${category}) balandligi (${worldH.toFixed(3)}m) PvP chegarasi ${allowedWorldH}m dan oshmasligi kerak`,
      );
    }

    // 4c. Amaliy instansiyalar bo'yicha haqiqiy generatsiya va planGrassVariant tekshiruvi (5 ta seedda)
    for (const seed of TEST_SEEDS) {
      const world = createForestSquareWorld({ publicLayoutSeed: seed });
      const field = buildForestSquareGroundCover(world);
      const instances = extractAllInstances(field);

      let maxObservedGrass = 0;
      let maxObservedFlower = 0;
      let maxObservedFern = 0;

      let maxPlannedGrassH = 0;
      let maxPlannedFlowerH = 0;
      let maxPlannedFernH = 0;

      for (const inst of instances) {
        const baseH = GROUND_COVER_BASE_HEIGHT[inst.kind];
        const h = baseH * inst.scale;
        const cat = groundCoverCategoryOf(inst.kind);

        if (cat === 'grass') {
          if (h > maxObservedGrass) maxObservedGrass = h;
          assert.ok(h <= 0.4501, `Amaldagi maysa <= 0.45m bo'lishi kerak: h=${h.toFixed(3)}m`);
        } else if (cat === 'flower') {
          if (h > maxObservedFlower) maxObservedFlower = h;
          assert.ok(h <= 0.3501, `Amaldagi gul <= 0.35m bo'lishi kerak: h=${h.toFixed(3)}m`);
        } else if (cat === 'fern') {
          if (h > maxObservedFern) maxObservedFern = h;
          assert.ok(h <= 0.6001, `Amaldagi paporotnik <= 0.60m bo'lishi kerak: h=${h.toFixed(3)}m`);
        }

        // GrassVariantPlanner orqali GLB modelga moslashtirilganda ham PvP chegarasiga rioya qilinishi
        const planned = planGrassVariant(inst.x, inst.y, inst.z, inst.kind, inst.yaw, inst.scale, seed);
        const plannedH = GRASS_VARIANT_HEIGHT[planned.variantId] * planned.scale;
        const plannedCat = getVariantCategory(planned.variantId);

        if (plannedCat === 'grass') {
          if (plannedH > maxPlannedGrassH) maxPlannedGrassH = plannedH;
          assert.ok(plannedH <= 0.4501, `GLB maysa ${planned.variantId} balandligi <= 0.45m bo'lishi kerak`);
        } else if (plannedCat === 'flower') {
          if (plannedH > maxPlannedFlowerH) maxPlannedFlowerH = plannedH;
          assert.ok(plannedH <= 0.3501, `GLB gul ${planned.variantId} balandligi <= 0.35m bo'lishi kerak`);
        } else if (plannedCat === 'fern') {
          if (plannedH > maxPlannedFernH) maxPlannedFernH = plannedH;
          assert.ok(plannedH <= 0.6001, `GLB paporotnik ${planned.variantId} balandligi <= 0.60m bo'lishi kerak`);
        }
      }

      assert.ok(maxObservedGrass > 0.15 && maxObservedGrass <= 0.45);
      assert.ok(maxObservedFlower > 0.15 && maxObservedFlower <= 0.35);
      assert.ok(maxObservedFern > 0.25 && maxObservedFern <= 0.60);

      assert.ok(maxPlannedGrassH > 0.15 && maxPlannedGrassH <= 0.45);
      assert.ok(maxPlannedFlowerH > 0.15 && maxPlannedFlowerH <= 0.35);
      assert.ok(maxPlannedFernH > 0.25 && maxPlannedFernH <= 0.60);
    }

    // 4d. GRASS-ASSET-01 manifestidagi 17 ta modelning balandlik spetsifikatsiyalari
    const manifestPath = path.resolve(process.cwd(), 'docs/stage08terrain/grass_asset_manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok(Array.isArray(manifest.models), 'Manifestda models massivi mavjud');
      assert.equal(manifest.models.length, 17, 'Manifestda 17 ta model mavjud');

      for (const m of manifest.models) {
        assert.ok(m.height > 0, `Model height musbat son bo'lishi kerak: ${m.name}`);
        if (m.name === 'grass_tall_wild_01') {
          assert.equal(m.height, 0.52);
        } else if (m.name === 'grass_tall_seeded_01') {
          assert.equal(m.height, 0.54);
        } else if (m.name === 'flower_purple_01') {
          assert.equal(m.height, 0.42);
        } else if (m.name === 'fern_wide_01') {
          assert.equal(m.height, 0.60);
        }
      }
    }
  });

  // =========================================================================
  // 5. Road Walking Clearance
  // =========================================================================
  it('5. Yo‘l Harakati Erkinligi: Yo‘lning markaziy o‘qida (dist < 1.0m) hech qanday o‘simlik instansiyasi o‘yinchi yo‘lini to‘smaydi', () => {
    // GROUND_COVER_ROAD_STRIP = 1.1m (yo'l markazidan har tomonga kamida 1.1m toza zona)
    assert.ok(
      GROUND_COVER_ROAD_STRIP >= 1.0,
      `GROUND_COVER_ROAD_STRIP kamida 1.0m bo'lishi kerak: ${GROUND_COVER_ROAD_STRIP}m`,
    );

    for (const seed of TEST_SEEDS) {
      const world = createForestSquareWorld({ publicLayoutSeed: seed });
      const field = buildForestSquareGroundCover(world);
      const instances = extractAllInstances(field);

      let violationsCount = 0;
      let minObservedDist = 99999;
      let pathEdgeCount = 0;

      for (const inst of instances) {
        const road = sampleForestSquareRoad(inst.x, inst.z, seed);
        if (road.dist < minObservedDist) {
          minObservedDist = road.dist;
        }
        if (road.dist < 1.0) {
          violationsCount++;
        }

        const planned = planGrassVariant(inst.x, inst.y, inst.z, inst.kind, inst.yaw, inst.scale, seed);
        if (planned.variantId === 'grass_path_edge_01') {
          pathEdgeCount++;
          // Yo'l cheti maysasi faqat yo'l chetida (dist 1.05m .. 3.2m oralig'ida) bo'lishi kerak
          assert.ok(
            road.dist >= 1.0 && road.dist <= 3.5,
            `grass_path_edge_01 faqat yo'l chetida bo'lishi kerak: dist=${road.dist.toFixed(2)}m`,
          );
        }
      }

      assert.equal(
        violationsCount,
        0,
        `Yo'l markazida (dist < 1.0m) hech qanday instansiya bo'lmasligi kerak: seed=${seed}, buzilishlar=${violationsCount}`,
      );

      assert.ok(
        minObservedDist >= GROUND_COVER_ROAD_STRIP - 0.001,
        `Eng yaqin instansiya masofasi ROAD_STRIP (${GROUND_COVER_ROAD_STRIP}m) dan kam emas: haqiqiy ${minObservedDist.toFixed(3)}m (seed=${seed})`,
      );

      // Yo'l cheti bo'ylab yo'naltirilgan grass_path_edge_01 modellari hosil bo'lgan
      assert.ok(
        pathEdgeCount > 100,
        `Yo'l cheti bo'ylab kamida 100 ta grass_path_edge_01 modeli joylashishi kerak: haqiqiy ${pathEdgeCount} (seed=${seed})`,
      );
    }
  });
});
