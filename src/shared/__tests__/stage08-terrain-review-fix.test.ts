import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
  createForestSquareWorld,
  getForestSquarePoiSites,
  sampleForestSquareRoad,
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
  GROUND_COVER_STRIDE,
} from '../groundCover';
import {
  GRASS_VARIANT_HEIGHT,
  GRASS_VARIANT_IDS,
  GRASS_VARIANT_MAX_SCALE,
  MAX_WORLD_HEIGHT,
  getVariantCategory,
} from '../../client/game/grass/GrassVariantPlanner';
import { createEnhancedTerrainMaterial } from '../../client/game/terrain/TerrainMaterial';

/**
 * 17 ta yangi GLB o'simlik modeli (public/models/grass/).
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

/**
 * Rekursiv barcha .glb fayllarni topish.
 */
function getAllGlbFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllGlbFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.glb')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * glTF 2.0 binar sarlavhasini (magic, version, reportedLen) tekshirish.
 */
function assertValidGltfHeader(filePath: string): void {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);

  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const reportedLen = buf.readUInt32LE(8);

  assert.equal(magic, 0x46546c67, `GLB magic 'glTF' mos kelmadi: ${filePath}`);
  assert.equal(version, 2, `glTF versiyasi 2 bo'lishi shart: ${filePath}`);
  assert.equal(reportedLen, stat.size, `Reported length fayl hajmiga teng bo'lishi shart: ${filePath}`);
}

describe('STAGE 08-TERRAIN-ART-POLISH-REVIEW-FIX — Unit & Integratsiya QA', () => {
  // =========================================================================
  // 1. Asset Integrity
  // =========================================================================
  it('1. Asset Butunligi: public/models/grass/ da barcha 17 GLB (5 KB - 35 KB) va public/models/ da jami 53 GLB mavjud, glTF 2.0 to‘g‘ri', () => {
    const grassDir = path.resolve(process.cwd(), 'public/models/grass');
    const modelsDir = path.resolve(process.cwd(), 'public/models');

    assert.ok(fs.existsSync(grassDir), `Grass papkasi mavjud bo'lishi kerak: ${grassDir}`);
    assert.ok(fs.existsSync(modelsDir), `Models papkasi mavjud bo'lishi kerak: ${modelsDir}`);

    // 1a. 17 ta grass GLB tekshiruvi
    for (const fileName of EXPECTED_GRASS_GLBS) {
      const fullPath = path.join(grassDir, fileName);
      assert.ok(fs.existsSync(fullPath), `GLB topilmadi: ${fileName}`);

      const stat = fs.statSync(fullPath);
      assert.ok(
        stat.size >= 5 * 1024,
        `Fayl hajmi kamida 5 KB bo'lishi kerak: ${fileName} (${stat.size} bayt)`,
      );
      assert.ok(
        stat.size <= 35 * 1024,
        `Fayl hajmi ko'pi bilan 35 KB bo'lishi kerak: ${fileName} (${stat.size} bayt)`,
      );

      assertValidGltfHeader(fullPath);
    }
    assert.equal(EXPECTED_GRASS_GLBS.length, 17, 'Aynan 17 ta grass GLB bo\'lishi shart');

    // 1b. Jami 53 GLB tekshiruvi (36 ta dastlabki + 17 ta grass). 08B: personaj GLB'lari
    // (public/models/characters/) alohida hisoblanadi — muhit/qurol 53 ta GLB o'zgarmasligi shart.
    const charactersDir = path.join(modelsDir, 'characters');
    const allGlbs = getAllGlbFiles(modelsDir);
    const envGlbs = allGlbs.filter((p) => !p.startsWith(charactersDir + path.sep));
    assert.equal(
      envGlbs.length,
      53,
      `public/models/ ichida (characters/ dan tashqari) jami aynan 53 ta GLB bo'lishi shart, topildi: ${envGlbs.length}`,
    );
    const characterGlbs = allGlbs.length - envGlbs.length;
    assert.equal(characterGlbs, 1, `08B: public/models/characters/ da aynan 1 ta GLB bo'lishi shart, topildi: ${characterGlbs}`);

    for (const glbPath of allGlbs) {
      assertValidGltfHeader(glbPath);
    }
  });

  // =========================================================================
  // 2. Deterministic World & Gameplay Hash
  // =========================================================================
  it('2. Deterministik Dunyo va Gameplay Hash: seed 6501 uchun gameplayHash="670a9c21f0565c94", worldVersion=2, 2341 kollayder, 36 spawn, 26 container, 6 POI', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    assert.equal(
      world.gameplayHash,
      '670a9c21f0565c94',
      'Seed 6501 uchun gameplayHash aynan 670a9c21f0565c94 bo‘lishi shart',
    );
    assert.equal(world.worldVersion, 2, 'worldVersion aynan 2 bo‘lishi shart');
    assert.equal(world.colliders.length, 2341, 'Aynan 2,341 kollayder saqlanishi shart');
    assert.equal(world.spawnPoints.length, 36, 'Aynan 36 ta spawn nuqtasi saqlanishi shart');
    assert.equal(world.containerLocations.length, 26, 'Aynan 26 ta konteyner saqlanishi shart');

    const poiSites = getForestSquarePoiSites(6501);
    assert.equal(poiSites.length, 6, 'Aynan 6 ta POI maydoni saqlanishi shart');

    // Relyef determinizmi: baytma-bayt tenglik
    const t1 = buildForestSquareTerrain(6501);
    const t2 = buildForestSquareTerrain(6501);
    const buf1 = Buffer.from(new Float32Array(t1.heights).buffer);
    const buf2 = Buffer.from(new Float32Array(t2.heights).buffer);
    assert.ok(buf1.equals(buf2), 'Relyef balandliklari baytma-bayt deterministik bo‘lishi shart');

    // Ground cover yaratilishi server gameplay parametrlarini buzmasligi
    const collidersJson = JSON.stringify(world.colliders);
    const field = buildForestSquareGroundCover(world);
    assert.ok(field.total > 0, 'Ground cover muvaffaqiyatli qurilishi shart');
    assert.equal(world.gameplayHash, '670a9c21f0565c94', 'gameplayHash ground cover chaqiruvidan keyin o‘zgarmasligi shart');
    assert.equal(world.colliders.length, 2341, 'Kollayderlar soni o‘zgarmasligi shart');
    assert.equal(JSON.stringify(world.colliders), collidersJson, 'Kollayderlar tarkibi o‘zgarmasligi shart');
  });

  // =========================================================================
  // 3. Ground Cover & Clearance Invariants
  // =========================================================================
  it('3. O‘simlik Maydoni va Tozalik Invariantlari: yo‘l o‘qi (dist < 1.0m) toza, spawn va konteynerlardan 1.2m toza, aylantirilgan chodirlar (forest_tent_01) ichi toza, PvP balandlik mezonlari saqlangan', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const field = buildForestSquareGroundCover(world);

    assert.ok(field.chunks.length === 256, '16x16 chunklar (jami 256) mavjud bo‘lishi kerak');
    assert.ok(
      field.total >= 17000 && field.total <= 22000,
      `Instansiyalar soni budjetda (~19.4k) bo‘lishi shart: haqiqiy ${field.total}`,
    );

    // Chodirlar (forest_tent_01)
    const tents = world.visuals.filter(
      (v) => (v.prefabId.includes('tent') || v.batchKey.includes('tent')) && v.boxDims,
    );
    assert.ok(tents.length >= 2, `Kamida 2 ta chodir topilishi kerak, topildi: ${tents.length}`);

    let roadViolations = 0;
    let spawnViolations = 0;
    let containerViolations = 0;
    let tentViolations = 0;
    let pvpHeightViolations = 0;

    for (const chunk of field.chunks) {
      for (const kind of GROUND_COVER_KINDS) {
        const batch = chunk.batches[kind];
        if (!batch) continue;

        const cat = groundCoverCategoryOf(kind);
        const pvpLimit = cat === 'grass' ? 0.45 : cat === 'flower' ? 0.35 : 0.60;
        const baseHeight = GROUND_COVER_BASE_HEIGHT[kind];

        for (let i = 0; i < batch.length; i += GROUND_COVER_STRIDE) {
          const x = batch[i]!;
          const z = batch[i + 2]!;
          const scale = batch[i + 4]!;

          // 3a. Yo'l o'qi tozaligi (dist < 1.0m)
          const road = sampleForestSquareRoad(x, z, 6501);
          if (road.dist < 1.0) {
            roadViolations++;
          }

          // 3b. Spawn nuqtalari tozaligi (radius 1.2m)
          for (const sp of world.spawnPoints) {
            if (Math.hypot(x - sp.x, z - sp.z) < 1.2) {
              spawnViolations++;
            }
          }

          // 3c. Konteynerlar tozaligi (radius 1.2m)
          for (const c of world.containerLocations) {
            if (Math.hypot(x - c.position.x, z - c.position.z) < 1.2) {
              containerViolations++;
            }
          }

          // 3d. Rotatsiyalangan chodirlar ichi tozaligi
          for (const t of tents) {
            const dx = x - t.transform.position.x;
            const dz = z - t.transform.position.z;
            const cosY = Math.cos(t.transform.yaw);
            const sinY = Math.sin(t.transform.yaw);
            // World -> Local OBB
            const lx = dx * cosY - dz * sinY;
            const lz = dx * sinY + dz * cosY;
            const hx = (t.boxDims!.x * t.transform.scale.x) / 2;
            const hz = (t.boxDims!.z * t.transform.scale.z) / 2;
            if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) {
              tentViolations++;
            }
          }

          // 3e. Instansiya balandligi PvP cheklovi
          const instanceHeight = scale * baseHeight;
          if (instanceHeight > pvpLimit + 1e-4) {
            pvpHeightViolations++;
          }
        }
      }
    }

    assert.equal(roadViolations, 0, `Yo‘l o‘qida (dist < 1.0m) 0 ta o‘simlik bo‘lishi shart, topildi: ${roadViolations}`);
    assert.equal(spawnViolations, 0, `Spawnlardan 1.2m radiusda 0 ta o‘simlik bo‘lishi shart, topildi: ${spawnViolations}`);
    assert.equal(containerViolations, 0, `Konteynerlardan 1.2m radiusda 0 ta o‘simlik bo‘lishi shart, topildi: ${containerViolations}`);
    assert.equal(tentViolations, 0, `Aylantirilgan chodirlar (forest_tent_01) ichida 0 ta o‘simlik bo‘lishi shart, topildi: ${tentViolations}`);
    assert.equal(pvpHeightViolations, 0, `PvP balandlik limitini buzgan instansiyalar soni 0 bo‘lishi shart, topildi: ${pvpHeightViolations}`);

    // Variant planner balandlik mezonlari tekshiruvi
    for (const variantId of GRASS_VARIANT_IDS) {
      const cat = getVariantCategory(variantId);
      const baseH = GRASS_VARIANT_HEIGHT[variantId];
      const maxScale = GRASS_VARIANT_MAX_SCALE[variantId];
      const maxHeight = baseH * maxScale;
      const limit = MAX_WORLD_HEIGHT[cat];

      assert.ok(
        maxHeight <= limit + 1e-4,
        `Variant ${variantId} (${cat}) maks balandligi ${maxHeight.toFixed(3)}m PvP limitidan (${limit}m) oshmasligi shart`,
      );
    }
  });

  // =========================================================================
  // 4. Enhanced Terrain Shading & Sampler
  // =========================================================================
  it('4. Relyef Shading va Rang Sampleri: 5 ta seedda barcha ranglar [0, 1] oralig‘ida, tuproq yo‘llar qoramtir-tuproq rang, qoyalar kulrang, shaderda teskari smoothstep yo‘q', () => {
    for (const seed of TEST_SEEDS) {
      // 4a. [0, 1] oralig'i tekshiruvi
      for (let x = -120; x <= 120; x += 30) {
        for (let z = -120; z <= 120; z += 30) {
          for (const y of [-1.5, 0.0, 1.5, 3.5]) {
            for (const slope of [5, 20, 36, 48]) {
              const [r, g, b] = sampleForestSquareTerrainColor(x, y, z, slope, seed);
              assert.ok(r >= 0 && r <= 1, `r=${r} [0, 1] oralig'ida bo'lishi shart (seed=${seed}, x=${x}, z=${z})`);
              assert.ok(g >= 0 && g <= 1, `g=${g} [0, 1] oralig'ida bo'lishi shart (seed=${seed}, x=${x}, z=${z})`);
              assert.ok(b >= 0 && b <= 1, `b=${b} [0, 1] oralig'ida bo'lishi shart (seed=${seed}, x=${x}, z=${z})`);
            }
          }
        }
      }

      // 4b. Tuproq yo'llar: to'q tuproq tus (r > g > b), maysadan ajralib turadi
      let roadPoint: { x: number; z: number } | null = null;
      for (let x = -30; x <= 30; x += 2) {
        for (let z = -30; z <= 30; z += 2) {
          const sample = sampleForestSquareRoad(x, z, seed);
          if (sample.dist < 0.25 && sample.blend > 0.9) {
            roadPoint = { x, z };
            break;
          }
        }
        if (roadPoint) break;
      }
      assert.ok(roadPoint !== null, `Yo'l koordinatasi topilishi shart: seed=${seed}`);

      const [rRoad, gRoad, bRoad] = sampleForestSquareTerrainColor(roadPoint.x, 0.0, roadPoint.z, 2, seed);
      assert.ok(rRoad > gRoad, `Yo'l qizilligi (${rRoad}) yashilligidan (${gRoad}) ustun bo'lishi shart (tuproq tus): seed=${seed}`);
      assert.ok(gRoad > bRoad, `Yo'l yashilligi (${gRoad}) ko'k rangidan (${bRoad}) ustun bo'lishi shart: seed=${seed}`);
      assert.ok(rRoad >= 0.17 && rRoad <= 0.26, `Yo'l qizil kanali: ${rRoad}`);
      assert.ok(gRoad >= 0.10 && gRoad <= 0.20, `Yo'l yashil kanali: ${gRoad}`);
      assert.ok(bRoad >= 0.04 && bRoad <= 0.12, `Yo'l ko'k kanali: ${bRoad}`);

      // O'rmon maysasi: yashil ustun (g > r)
      const [rGrass, gGrass, bGrass] = sampleForestSquareTerrainColor(64, 0.0, 4, 3, seed);
      assert.ok(gGrass > rGrass, `O'rmon maysasida yashil (${gGrass}) qizildan (${rGrass}) ustun bo'lishi shart: seed=${seed}`);

      // 4c. Tik qoya: slate grey stone (neytral tosh-kulrang)
      const [rRock, gRock, bRock] = sampleForestSquareTerrainColor(-108, 2.5, -106, 46, seed);
      const rockMaxDiff = Math.max(
        Math.abs(rRock - gRock),
        Math.abs(rRock - bRock),
        Math.abs(gRock - bRock),
      );
      assert.ok(rockMaxDiff <= 0.06, `Tik qoya neytral tosh-kulrang bo'lishi shart: maxDiff=${rockMaxDiff}`);
    }

    // 4d. createEnhancedTerrainMaterial tekshiruvi: to'g'ri GLSL, no reverse smoothstep
    const mat = createEnhancedTerrainMaterial(new THREE.MeshStandardMaterial(), 6501);
    assert.equal(mat.vertexColors, true, 'vertexColors=true bo‘lishi shart');
    assert.ok(mat.roughness >= 0.90 && mat.roughness <= 0.98, 'roughness ~0.94 bo‘lishi shart');
    assert.equal(mat.metalness, 0.0, 'metalness=0.0 bo‘lishi shart');
    assert.ok(typeof mat.customProgramCacheKey === 'function');
    assert.ok(mat.customProgramCacheKey().includes('6501'));

    const mockShader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: `
#include <common>
void main() {
  #include <worldpos_vertex>
}
`,
      fragmentShader: `
#include <common>
void main() {
  #include <color_fragment>
  #include <roughnessmap_fragment>
  #include <dithering_fragment>
}
`,
    };

    mat.onBeforeCompile(
      mockShader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );

    // GLSL qoidasi: teskari smoothstep(0.24, 0.14) bo'lmasligi shart
    const hasInvalidSmoothstep = /smoothstep\s*\(\s*0\.24\s*,\s*0\.14/.test(mockShader.fragmentShader);
    assert.equal(hasInvalidSmoothstep, false, 'Shaderda teskari smoothstep(0.24, 0.14) bo‘lmasligi shart');

    // To'g'ri (1.0 - smoothstep(0.14, 0.24, ...))
    const hasValidSmoothstep = mockShader.fragmentShader.includes('1.0 - smoothstep(0.14, 0.24');
    assert.ok(hasValidSmoothstep, 'Shaderda to‘g‘ri (1.0 - smoothstep(0.14, 0.24, ...)) mavjud bo‘lishi shart');

    // Multi-scale qatlam tokenlari mavjudligi
    assert.ok(mockShader.fragmentShader.includes('soilGrit'), 'soilGrit micro noise mavjud bo‘lishi shart');
    assert.ok(mockShader.fragmentShader.includes('velvet'), 'velvet mezo noise mavjud bo‘lishi shart');
    assert.ok(mockShader.fragmentShader.includes('macroNoise'), 'macroNoise makro noise mavjud bo‘lishi shart');
    assert.ok(mockShader.fragmentShader.includes('uTerrainSeed'), 'uTerrainSeed uniform mavjud bo‘lishi shart');
  });
});
