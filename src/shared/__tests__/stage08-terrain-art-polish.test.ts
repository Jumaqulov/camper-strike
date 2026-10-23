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
  buildGroundCoverField,
  getForestSquareGroundCoverInput,
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
  type GrassVariantId,
} from '../../client/game/grass/GrassVariantPlanner';
import {
  getGrassAsset,
  preloadGrassAssets,
  getGrassAssetDiagnostics,
  onGrassAssetsReady,
  setGrassLoaderFactoryForTesting,
  resetGrassAssetRegistryForTesting,
  type CachedGrassAsset,
} from '../../client/game/grass/GrassAssetRegistry';
import { createGrassRenderer } from '../../client/game/grass/GrassRenderer';
import { createEnhancedTerrainMaterial } from '../../client/game/terrain/TerrainMaterial';
import { DEFAULT_PUBLIC_LAYOUT_SEED } from '../world';

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

describe('BOSQICH 08-TERRAIN-ART-POLISH — Relyef Ranglari, Ko‘p Qatlamli Shader, O‘simlik Taqsimoti va Regressiya QA', () => {
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
    assert.ok(
      totalBytes > 200 * 1024 && totalBytes < 225 * 1024,
      `Jami 17 ta GLB hajmi ~207 KB bo'lishi kerak: haqiqiy ${totalBytes} bayt`,
    );
  });

  // =========================================================================
  // 2. Soil Roads & Terrain Color Sampling
  // =========================================================================
  it('2. Tuproq Yo‘llar va Relyef Ranglari: sampleForestSquareTerrainColor [0, 1] oralig‘ida bo‘lishi, yo‘l markazi to‘q tuproq, g‘ildirak izlari va organik yonbag‘irlar bilan ajralishi shart', () => {
    for (const seed of TEST_SEEDS) {
      for (let x = -120; x <= 120; x += 30) {
        for (let z = -120; z <= 120; z += 30) {
          for (const y of [-1.5, 0.0, 1.5, 3.5]) {
            for (const slope of [5, 20, 36, 48]) {
              const [r, g, b] = sampleForestSquareTerrainColor(x, y, z, slope, seed);
              assert.ok(r >= 0 && r <= 1, `r=${r} [0, 1] oralig'ida bo'lishi kerak`);
              assert.ok(g >= 0 && g <= 1, `g=${g} [0, 1] oralig'ida bo'lishi kerak`);
              assert.ok(b >= 0 && b <= 1, `b=${b} [0, 1] oralig'ida bo'lishi kerak`);
            }
          }
        }
      }

      // Yo'l markazi: to'q tuproq rang (r > g > b)
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

      assert.ok(roadPoint !== null, `Yo'l koordinatasi topilishi kerak: seed=${seed}`);
      const [rRoad, gRoad, bRoad] = sampleForestSquareTerrainColor(roadPoint.x, 0.0, roadPoint.z, 2, seed);
      assert.ok(rRoad > gRoad, `Yo'l tuproq qizilligi (${rRoad}) yashilligidan (${gRoad}) ustun bo'lishi kerak: seed=${seed}`);
      assert.ok(gRoad > bRoad, `Yo'l yashilligi (${gRoad}) ko'k rangidan (${bRoad}) ustun bo'lishi kerak: seed=${seed}`);
      assert.ok(rRoad >= 0.17 && rRoad <= 0.26, `Yo'l qizil rangi: ${rRoad}`);
      assert.ok(gRoad >= 0.10 && gRoad <= 0.20, `Yo'l yashil rangi: ${gRoad}`);
      assert.ok(bRoad >= 0.04 && bRoad <= 0.12, `Yo'l ko'k rangi: ${bRoad}`);

      // Tik qoya: slate grey stone (low color saturation)
      const [rRock, gRock, bRock] = sampleForestSquareTerrainColor(-108, 2.5, -106, 46, seed);
      const rockMaxDiff = Math.max(
        Math.abs(rRock - gRock),
        Math.abs(rRock - bRock),
        Math.abs(gRock - bRock),
      );
      assert.ok(rockMaxDiff <= 0.06, `Tik qoya neytral tosh-kulrang bo'lishi kerak: maxDiff=${rockMaxDiff}`);
    }
  });

  // =========================================================================
  // 3. Multi-Scale Terrain Shader Invariants
  // =========================================================================
  it('3. Terrain Shader Invariantlari: createEnhancedTerrainMaterial ko‘p qatlamli (makro, mezo, mikro) prosedural shader generatsiyasi va to‘g‘ri GLSL smoothstep dan foydalanadi', () => {
    const mat = createEnhancedTerrainMaterial(new THREE.MeshStandardMaterial(), 6501);
    assert.equal(mat.vertexColors, true);
    assert.ok(mat.roughness >= 0.90 && mat.roughness <= 0.98);
    assert.equal(mat.metalness, 0.0);
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

    // GLSL qoidasi bo'yicha: edge0 < edge1 bo'lishi shart!
    const hasInvalidSmoothstep = /smoothstep\s*\(\s*0\.24\s*,\s*0\.14/.test(mockShader.fragmentShader);
    assert.equal(
      hasInvalidSmoothstep,
      false,
      'Shaderda teskari smoothstep(0.24, 0.14, ...) qolmasligi shart!',
    );

    // To'g'ri (1.0 - smoothstep(0.14, 0.24, ...))
    const hasValidSmoothstep = mockShader.fragmentShader.includes('1.0 - smoothstep(0.14, 0.24');
    assert.ok(
      hasValidSmoothstep,
      'Shaderda to‘g‘ri (1.0 - smoothstep(0.14, 0.24, ...)) ishlatilgan bo‘lishi kerak',
    );

    // Micro soil grain, velvet moss, roughness modulation
    assert.ok(mockShader.fragmentShader.includes('soilGrit'), 'soilGrit micro noise mavjud bo‘lishi kerak');
    assert.ok(mockShader.fragmentShader.includes('roughnessFactor'), 'roughnessFactor modulyatsiyasi mavjud bo‘lishi kerak');
  });

  // =========================================================================
  // 4. World Determinism & Hash Preservation
  // =========================================================================
  it('4. Dunyo Determinizmi va Hash Saqlanishi: Relyef balandliklari deterministik, gameplayHash="670a9c21f0565c94", 36 spawn, 26 container, colliders daxlsiz', () => {
    const t1 = buildForestSquareTerrain(6501);
    const t2 = buildForestSquareTerrain(6501);
    const buf1 = Buffer.from(new Float32Array(t1.heights).buffer);
    const buf2 = Buffer.from(new Float32Array(t2.heights).buffer);
    assert.ok(buf1.equals(buf2), 'Relyef balandliklari baytma-bayt bir xil bo‘lishi shart');

    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    assert.equal(
      world.gameplayHash,
      '670a9c21f0565c94',
      'Seed 6501 uchun gameplayHash aynan 670a9c21f0565c94 bo‘lishi shart',
    );
    assert.equal(world.spawnPoints.length, 36, 'Aynan 36 ta spawn saqlanishi kerak');
    assert.equal(world.containerLocations.length, 26, 'Aynan 26 ta konteyner saqlanishi kerak');

    const collidersCount = world.colliders.length;
    const collidersJson = JSON.stringify(world.colliders);

    const field = buildForestSquareGroundCover(world);
    assert.ok(field.total > 16000 && field.total < 22000, `Instansiyalar soni budgetda bo‘lishi kerak: ${field.total}`);
    assert.equal(world.gameplayHash, '670a9c21f0565c94', 'Ground cover yaratilishi gameplayHash ni aslo o‘zgartirmasligi shart');
    assert.equal(world.colliders.length, collidersCount, 'Yangi kollayder qo‘shilmasligi shart');
    assert.equal(JSON.stringify(world.colliders), collidersJson, 'Kollayderlar massivi aynan saqlanishi shart');
  });

  // =========================================================================
  // 5. PvP Scale Capping & Road Walking Clearance
  // =========================================================================
  it('5. PvP Balandlik Cheklovlari va Yo‘l Tozaligi: barcha o‘simliklar PvP mezonlariga mos (maysa<=0.45m, gul<=0.35m, fern<=0.60m) va yo‘l o‘qida (dist < 1.0m) maysa bo‘lmasligi shart', () => {
    for (const variantId of GRASS_VARIANT_IDS) {
      const category = getVariantCategory(variantId);
      const baseH = GRASS_VARIANT_HEIGHT[variantId];
      const maxScale = GRASS_VARIANT_MAX_SCALE[variantId];
      const maxHeight = baseH * maxScale;
      const limit = MAX_WORLD_HEIGHT[category];

      assert.ok(
        maxHeight <= limit + 1e-4,
        `${variantId} (${category}) maksimal balandligi ${maxHeight.toFixed(3)}m PvP limitidan (${limit}m) oshmasligi shart`,
      );
    }

    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const field = buildForestSquareGroundCover(world);

    let instancesOnRoadCenter = 0;
    for (const chunk of field.chunks) {
      for (const kind of GROUND_COVER_KINDS) {
        const batch = chunk.batches[kind];
        if (!batch) continue;
        for (let i = 0; i < batch.length; i += GROUND_COVER_STRIDE) {
          const x = batch[i]!;
          const z = batch[i + 2]!;
          const road = sampleForestSquareRoad(x, z, 6501);
          if (road.dist < 1.0) {
            instancesOnRoadCenter++;
          }
        }
      }
    }

    assert.equal(
      instancesOnRoadCenter,
      0,
      `Yo‘l markaziy yurish yo‘lagida (dist < 1.0m) 0 ta o‘simlik bo‘lishi shart, topildi: ${instancesOnRoadCenter}`,
    );
  });
});
