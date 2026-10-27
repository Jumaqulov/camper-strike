import assert from 'node:assert/strict';
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
} from '../groundCover';
import {
  GRASS_VARIANT_IDS,
  getGrassAsset,
  preloadGrassAssets,
  getGrassAssetDiagnostics,
  onGrassAssetsReady,
  setGrassLoaderFactoryForTesting,
  setGrassAssetForTesting,
  resetGrassAssetRegistryForTesting,
  type GrassVariantId,
  type CachedGrassAsset,
} from '../../client/game/grass/GrassAssetRegistry';
import { createGrassRenderer } from '../../client/game/grass/GrassRenderer';
import { createEnhancedTerrainMaterial } from '../../client/game/terrain/TerrainMaterial';
import { DEFAULT_PUBLIC_LAYOUT_SEED } from '../world';

/**
 * STAGE 08-TERRAIN-QA — Regressiya va Birlik Testlari (Sub-agent C)
 *
 * 1. GLB Birinchi yuklanish va asset o'tishlari (Fallback -> Real GLB transition).
 * 2. GrassRenderer ichida atomik geometriya almashtirish (Atomic geometry swap).
 * 3. Terrain shader va GLSL invariantlari (smoothstep tartibi, onBeforeCompile, rang namunalari).
 * 4. Gameplay hash va dunyo invariantlarining saqlanishi (Seed 6501, 36 spawn, 26 container, 2356 collider).
 */

describe('BOSQICH 08-TERRAIN-QA — GLB Lifecycle, Atomik Swap, Terrain Shader va Determinizm Regressiyasi', () => {

  // =========================================================================
  // 1. GLB Birinchi Yuklanish va Asset O'tishlari (GrassAssetRegistry)
  // =========================================================================
  describe('1. GLB Birinchi Yuklanish va Asset O‘tishlari (GrassAssetRegistry)', () => {

    it('1.1 Kesh bo‘sh bo‘lganda getGrassAsset chaqirilishi xavfsiz procedural fallback qaytaradi (isFallback: true, sharedAsset: true)', () => {
      resetGrassAssetRegistryForTesting();

      for (const variantId of GRASS_VARIANT_IDS) {
        const asset = getGrassAsset(variantId);
        assert.ok(asset, `Asset mavjud bo'lishi kerak: ${variantId}`);
        assert.equal(asset.variantId, variantId);
        assert.equal(asset.isFallback, true, `Boshlang'ich kesh bo'shligida fallback bo'lishi kerak: ${variantId}`);
        assert.ok(asset.geometry instanceof THREE.BufferGeometry, 'Geometriya BufferGeometry bo\'lishi kerak');
        assert.ok(asset.geometry.getAttribute('position'), 'position atributi mavjud bo\'lishi kerak');
        assert.ok(asset.geometry.getAttribute('color'), 'color atributi mavjud bo\'lishi kerak');
        assert.ok(asset.geometry.getAttribute('aCategory'), 'aCategory atributi mavjud bo\'lishi kerak');
        assert.equal(asset.geometry.userData?.sharedAsset, true, 'sharedAsset bayrog\'i true bo\'lishi kerak');
        assert.ok(asset.triangles > 0, `Uchburchaklar soni musbat bo'lishi kerak: ${asset.triangles}`);
      }
    });

    it('1.2 getGrassAsset oldin chaqirilgan bo‘lsa ham preloadGrassAssets haqiqiy GLB larga o‘tishni bloklamaydi (muddatidan oldin qaytish xatosi yo‘q)', async () => {
      resetGrassAssetRegistryForTesting();

      // Barcha 17 variant uchun avval getGrassAsset chaqirib, keshni fallback bilan to'ldiramiz
      for (const id of GRASS_VARIANT_IDS) {
        const fallback = getGrassAsset(id);
        assert.equal(fallback.isFallback, true);
      }

      const diagBefore = getGrassAssetDiagnostics();
      assert.equal(diagBefore.activeFallbackVariantCount, 17);
      assert.equal(diagBefore.activeGLBVariantCount, 0);
      assert.equal(diagBefore.isAllLoaded, false);

      // Endi mock GLTF loader orqali preloadGrassAssets chaqiramiz
      const mockLoader = {
        loadAsync: async (url: string) => {
          const group = new THREE.Group();
          const geom = new THREE.BoxGeometry(0.12, 0.35, 0.12);
          const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
          group.add(mesh);
          return { scene: group };
        },
      };

      setGrassLoaderFactoryForTesting(() => mockLoader as any);
      await preloadGrassAssets();

      const diagAfter = getGrassAssetDiagnostics();
      assert.equal(diagAfter.loadedGLBCount, 17, 'Barcha 17 GLB muvaffaqiyatli yuklangan bo\'lishi kerak');
      assert.equal(diagAfter.failedGLBCount, 0, 'Hech qanday xatolik bo\'lmasligi kerak');
      assert.equal(diagAfter.activeGLBVariantCount, 17, 'Faol GLB soni 17 bo\'lishi kerak');
      assert.equal(diagAfter.activeFallbackVariantCount, 0, 'Faol fallback soni 0 bo\'lishi kerak');
      assert.equal(diagAfter.isAllLoaded, true, 'isAllLoaded true bo\'lishi kerak');

      // Har bir asset endi isFallback === false bo'lishini tekshiramiz
      for (const id of GRASS_VARIANT_IDS) {
        const asset = getGrassAsset(id);
        assert.equal(asset.isFallback, false, `Asset fallback emas, real model bo'lishi kerak: ${id}`);
        assert.equal(asset.geometry.userData?.sharedAsset, true);
      }
    });

    it('1.3 onGrassAssetsReady hodisa tinglovchisi har bir GLB yuklanganda va barcha modellar tayyor bo‘lganda to‘g‘ri chaqiriladi', async () => {
      resetGrassAssetRegistryForTesting();

      const receivedVariants: (GrassVariantId | undefined)[] = [];
      const unsub = onGrassAssetsReady((variantId) => {
        receivedVariants.push(variantId);
      });

      const mockLoader = {
        loadAsync: async () => {
          const group = new THREE.Group();
          group.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.25, 0.1)));
          return { scene: group };
        },
      };

      setGrassLoaderFactoryForTesting(() => mockLoader as any);
      await preloadGrassAssets();

      // Kamida 17 ta alohida variant chaqiruvi va 1 ta yakuniy (undefined) chaqiruv
      assert.ok(receivedVariants.length >= 18, `Tinglovchi kamida 18 marta chaqirilishi kerak: ${receivedVariants.length}`);
      assert.ok(receivedVariants.includes(undefined), 'Yakuniy "hamma tayyor" xabari (undefined) bo\'lishi kerak');

      // Barcha 17 variant ro'yxatda bo'lishi kerak
      for (const id of GRASS_VARIANT_IDS) {
        assert.ok(receivedVariants.includes(id), `Tinglovchiga ${id} variant kelgan bo'lishi kerak`);
      }

      // Unsubscribe tekshiruvi: yangi hodisalarda boshqa chaqirilmasligi kerak
      const countBefore = receivedVariants.length;
      unsub();
      // Yana bitta soxta asset o'rnatib ko'ramiz
      const dummyAsset = getGrassAsset('grass_short_soft_01');
      setGrassAssetForTesting(dummyAsset);
      assert.equal(receivedVariants.length, countBefore, 'Unsubscribe qilingandan so\'ng yangi hodisa kelmasligi kerak');
    });

    it('1.4 getGrassAssetDiagnostics barcha holatlarda to‘liq va aniq hisobot qaytaradi', () => {
      resetGrassAssetRegistryForTesting();

      const emptyDiag = getGrassAssetDiagnostics();
      assert.equal(emptyDiag.totalVariants, 17);
      assert.equal(emptyDiag.loadedGLBCount, 0);
      assert.equal(emptyDiag.failedGLBCount, 0);
      assert.equal(emptyDiag.activeFallbackVariantCount, 17);
      assert.equal(emptyDiag.activeGLBVariantCount, 0);
      assert.equal(emptyDiag.isAllLoaded, false);
      assert.equal(Object.keys(emptyDiag.variants).length, 17);

      for (const id of GRASS_VARIANT_IDS) {
        assert.equal(emptyDiag.variants[id].isFallback, true);
      }
    });

    it('1.5 Qisman nosozlikka chidamlilik: agar 1 ta GLB yuklanmasa, qolgan 16 tasi normal ishlaydi va o‘yin to‘xtab qolmaydi', async () => {
      resetGrassAssetRegistryForTesting();

      const failingVariant: GrassVariantId = 'flower_purple_01';

      const mockLoader = {
        loadAsync: async (url: string) => {
          if (url.includes(failingVariant)) {
            throw new Error(`Simulated CDN 404 for ${failingVariant}`);
          }
          const group = new THREE.Group();
          group.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.1)));
          return { scene: group };
        },
      };

      setGrassLoaderFactoryForTesting(() => mockLoader as any);
      await preloadGrassAssets();

      const diag = getGrassAssetDiagnostics();
      assert.equal(diag.failedGLBCount, 1, 'Aynan 1 ta xato qayd etilishi kerak');
      assert.equal(diag.loadedGLBCount, 16, '16 ta GLB muvaffaqiyatli yuklangan bo\'lishi kerak');
      assert.equal(diag.activeGLBVariantCount, 16, 'Faol GLB soni 16 bo\'lishi kerak');
      assert.equal(diag.activeFallbackVariantCount, 1, 'Faol fallback soni 1 bo\'lishi kerak');
      assert.equal(diag.isAllLoaded, false, 'Barcha modellar yuklanmaganligi sababli isAllLoaded false');

      // Nosoz variant fallback geometriyada qolgan
      const failedAsset = getGrassAsset(failingVariant);
      assert.equal(failedAsset.isFallback, true, 'Nosoz variant xavfsiz fallbackda qolishi kerak');
      assert.ok(failedAsset.geometry instanceof THREE.BufferGeometry);

      // Qolgan ixtiyoriy variant haqiqiy modelga o'tgan
      const goodAsset = getGrassAsset('grass_meadow_wide_01');
      assert.equal(goodAsset.isFallback, false, 'Muvaffaqiyatli variant haqiqiy GLB bo\'lishi kerak');
    });
  });

  // =========================================================================
  // 2. Atomic Geometry Swap in GrassRenderer
  // =========================================================================
  describe('2. GrassRenderer Ichida Atomik Geometriya Almashtirish (Atomic Geometry Swap)', () => {

    it('2.1 InstancedMesh fallback bilan ochilib, GLB kelganda mesh.geometry atomik almashtiriladi (count, instanceMatrix va scene o‘zgarmaydi)', async () => {
      resetGrassAssetRegistryForTesting();

      const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
      const field = buildForestSquareGroundCover(world);
      assert.ok(field.total > 0, 'Maydonda instansiyalar mavjud bo\'lishi kerak');

      // 1. Dastlab fallback geometriyalar bilan renderer yaratiladi
      const renderer = createGrassRenderer(field, 'high', 6501);
      const initialStats = renderer.getStats();

      assert.equal(initialStats.totalInstances, field.total);
      assert.equal(initialStats.activeFallbackVariantCount, 17, 'Dastlab 17 ta fallback bo\'lishi kerak');
      assert.equal(initialStats.activeGLBVariantCount, 0, 'Dastlab 0 ta GLB bo\'lishi kerak');
      assert.equal(initialStats.isAllLoaded, false);

      // Renderer scene guruhidagi har bir InstancedMesh tekshiriladi
      const meshesBefore: THREE.InstancedMesh[] = [];
      const geometriesBefore: THREE.BufferGeometry[] = [];
      const instanceMatricesBefore: Float32Array[] = [];

      renderer.group.traverse((child) => {
        if ((child as THREE.InstancedMesh).isInstancedMesh) {
          const im = child as THREE.InstancedMesh;
          meshesBefore.push(im);
          geometriesBefore.push(im.geometry);
          instanceMatricesBefore.push(im.instanceMatrix.array.slice() as Float32Array);
        }
      });

      assert.ok(meshesBefore.length > 0, 'InstancedMesh lar mavjud bo\'lishi kerak');

      // 2. Mock GLTF loader orqali preload bajariladi (live swap trigger)
      const mockLoader = {
        loadAsync: async () => {
          const group = new THREE.Group();
          group.add(new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.35, 0.15)));
          return { scene: group };
        },
      };

      setGrassLoaderFactoryForTesting(() => mockLoader as any);
      await preloadGrassAssets();

      // 3. Renderer stats endi to'liq GLB holatini ko'rsatishi shart
      const updatedStats = renderer.getStats();
      assert.equal(updatedStats.activeFallbackVariantCount, 0, 'GLB kelgach fallbacklar 0 bo\'lishi kerak');
      assert.equal(updatedStats.activeGLBVariantCount, 17, 'Barcha 17 variant GLB ga o\'tishi kerak');
      assert.equal(updatedStats.isAllLoaded, true);
      assert.equal(updatedStats.totalInstances, field.total, 'Umumiy instansiyalar soni o\'zgarmasligi shart');

      // 4. Har bir InstancedMesh ning geometriyasi yangilangan, ammo obyekt va massivlar yaxlit
      let index = 0;
      renderer.group.traverse((child) => {
        if ((child as THREE.InstancedMesh).isInstancedMesh) {
          const im = child as THREE.InstancedMesh;
          // Mesh obyekti o'sha-o'sha sahnada qolgan (scene reference intact)
          assert.equal(im, meshesBefore[index], 'InstancedMesh obyekt referensi saqlanishi kerak');
          // Geometriya yangi GLB geometriyasiga almashgan
          assert.notEqual(im.geometry, geometriesBefore[index], 'Geometriya yangilangan bo\'lishi kerak');
          assert.equal(im.geometry.userData?.sharedAsset, true);
          // Instance matrix buffer uzunligi saqlangan
          assert.equal(im.instanceMatrix.array.length, instanceMatricesBefore[index].length);
          index++;
        }
      });

      renderer.dispose();
    });

    it('2.2 mesh.geometry.userData?.sharedAsset umumiy keshdagi geometriyalar dispose() paytida yo‘q qilinishini oldini oladi', () => {
      resetGrassAssetRegistryForTesting();

      const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
      const field = buildForestSquareGroundCover(world);

      const renderer = createGrassRenderer(field, 'high', 6501);

      // Keshdagi geometriyani olib qo'yamiz
      const cachedAsset = getGrassAsset('grass_short_soft_01');
      assert.ok(cachedAsset.geometry);
      assert.equal(cachedAsset.geometry.userData?.sharedAsset, true);

      // Renderer dispose qilinadi
      renderer.dispose();

      // Keshdagi geometriya attributlari hali ham buzilmagan va mavjud
      const posAttr = cachedAsset.geometry.getAttribute('position');
      assert.ok(posAttr, 'Geometriya position atributi dispose qilinmagan bo\'lishi kerak');
      assert.ok(posAttr.count > 0, 'Position attributi nuqtalari mavjud bo\'lishi kerak');

      // Yangi renderer yaratilganda o'sha umumiy geometriyani qayta ishlata oladi
      const renderer2 = createGrassRenderer(field, 'medium', 6501);
      assert.ok(renderer2);
      renderer2.dispose();
    });
  });

  // =========================================================================
  // 3. Terrain Shader & GLSL Invariants
  // =========================================================================
  describe('3. Terrain Shader va GLSL Invariantlari (TerrainMaterial)', () => {

    it('3.1 createEnhancedTerrainMaterial to‘g‘ri material xossalarini (vertexColors, roughness: 0.94, metalness: 0.0) va dastur kesh kalitini o‘rnatadi', () => {
      const mat = createEnhancedTerrainMaterial(new THREE.MeshStandardMaterial(), 6501);
      assert.equal(mat.vertexColors, true);
      assert.equal(mat.roughness, 0.94);
      assert.equal(mat.metalness, 0.0);
      assert.ok(typeof mat.customProgramCacheKey === 'function');
      assert.ok(mat.customProgramCacheKey().includes('6501'));

      const defaultMat = createEnhancedTerrainMaterial(undefined, 42);
      assert.ok(defaultMat instanceof THREE.MeshStandardMaterial);
      assert.equal(defaultMat.vertexColors, true);
      assert.equal(defaultMat.roughness, 0.94);
      assert.equal(defaultMat.metalness, 0.0);
    });

    it('3.2 onBeforeCompile shader hooklari #include <common>, <worldpos_vertex>, <color_fragment>, <roughnessmap_fragment> larni to‘g‘ri almashtiradi', () => {
      const mat = createEnhancedTerrainMaterial(new THREE.MeshStandardMaterial(), 77);

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

      assert.ok(typeof mat.onBeforeCompile === 'function');
      mat.onBeforeCompile(
        mockShader as unknown as THREE.WebGLProgramParametersWithUniforms,
        {} as THREE.WebGLRenderer,
      );

      // Uniforms tekshiruvi
      assert.equal(mockShader.uniforms.uTerrainSeed?.value, 77);

      // Vertex shader o'zgarishlari
      assert.ok(
        mockShader.vertexShader.includes('varying vec3 vWorldPosition;'),
        'Vertex shader vWorldPosition ni e\'lon qilishi kerak',
      );
      assert.ok(
        mockShader.vertexShader.includes('vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;'),
        'Vertex shader vWorldPosition ni hisoblashi kerak',
      );

      // Fragment shader o'zgarishlari
      assert.ok(
        mockShader.fragmentShader.includes('varying vec3 vWorldPosition;'),
        'Fragment shader vWorldPosition ni qabul qilishi kerak',
      );
      assert.ok(
        mockShader.fragmentShader.includes('uniform float uTerrainSeed;'),
        'Fragment shader uTerrainSeed ni e\'lon qilishi kerak',
      );
      assert.ok(
        mockShader.fragmentShader.includes('terrainNoise2D'),
        'Fragment shader terrainNoise2D funksiyasini o\'z ichiga olishi kerak',
      );
      assert.ok(
        mockShader.fragmentShader.includes('terrainHash21'),
        'Fragment shader terrainHash21 funksiyasini o\'z ichiga olishi kerak',
      );
      assert.ok(
        mockShader.fragmentShader.includes('soilGrit'),
        'Fragment shader soilGrit tuproq donalarini hisoblashi kerak',
      );
      assert.ok(
        mockShader.fragmentShader.includes('mossCol') || mockShader.fragmentShader.includes('velvet'),
        'Fragment shader velvet mox o\'zgaruvchanligini hisoblashi kerak',
      );
      assert.ok(
        mockShader.fragmentShader.includes('needleMask') || mockShader.fragmentShader.includes('needleColor'),
        'Fragment shader ignabargli o\'rmon qoldiqlari (pine needles) ni hisoblashi kerak',
      );
      assert.ok(
        mockShader.fragmentShader.includes('roughnessFactor'),
        'Fragment shader roughnessFactor ni modulyatsiya qilishi kerak',
      );
      assert.ok(
        mockShader.fragmentShader.includes('#include <dithering_fragment>'),
        'Fragment shader dithering fragmentni buzmasdan saqlashi kerak',
      );
    });

    it('3.3 GLSL shaderda noaniq xatti-harakatga sabab bo‘luvchi smoothstep(0.24, 0.14, ...) mavjud emas, to‘g‘ri 1.0 - smoothstep(0.14, 0.24, ...) ishlatilgan', () => {
      const mat = createEnhancedTerrainMaterial(undefined, 6501);
      const shader = {
        uniforms: {} as Record<string, { value: unknown }>,
        vertexShader: THREE.ShaderLib.standard.vertexShader,
        fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      };

      mat.onBeforeCompile(
        shader as unknown as THREE.WebGLProgramParametersWithUniforms,
        {} as THREE.WebGLRenderer,
      );

      // GLSL qoidasi bo'yicha: edge0 < edge1 bo'lishi shart!
      // smoothstep(0.24, 0.14, x) bu noto'g'ri (edge0 > edge1)
      const hasInvalidSmoothstep = /smoothstep\s*\(\s*0\.24\s*,\s*0\.14/.test(shader.fragmentShader);
      assert.equal(
        hasInvalidSmoothstep,
        false,
        'Shaderda teskari smoothstep(0.24, 0.14, ...) qolmasligi kerak!',
      );

      // To'g'ri almashtirilgan ifoda mavjudligini tasdiqlash
      const hasValidSmoothstep = shader.fragmentShader.includes('1.0 - smoothstep(0.14, 0.24');
      assert.ok(
        hasValidSmoothstep,
        'Shaderda to\'g\'ri (1.0 - smoothstep(0.14, 0.24, ...)) ishlatilgan bo\'lishi kerak',
      );
    });

    it('3.4 sampleForestSquareTerrainColor butun relyef bo‘ylab [0, 1] oralig‘idagi qiymatlarni qaytaradi', () => {
      const seed = DEFAULT_PUBLIC_LAYOUT_SEED;
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
    });

    it('3.5 sampleForestSquareTerrainColor tik qoyalarni tosh-kulrang, yo‘llarni to‘q tuproqrang qilib ajratadi', () => {
      const seed = DEFAULT_PUBLIC_LAYOUT_SEED;

      // Tik qoya NW qismida (-108, -106)
      const [rRock, gRock, bRock] = sampleForestSquareTerrainColor(-108, 2.5, -106, 46, seed);
      assert.ok(rRock >= 0.19 && rRock <= 0.26, `Tosh qoya qizil rangi slate grey bo'lishi kerak: ${rRock}`);
      assert.ok(gRock >= 0.23 && gRock <= 0.31, `Tosh qoya yashil rangi moss-slate bo'lishi kerak: ${gRock}`);
      assert.ok(bRock >= 0.16 && bRock <= 0.28, `Tosh qoya ko'k rangi cool slate bo'lishi kerak: ${bRock}`);

      // Yo'l koordinatasi topiladi
      let roadX = 0;
      let roadZ = 0;
      let foundRoad = false;
      for (let x = -30; x <= 30; x += 1) {
        for (let z = -30; z <= 30; z += 1) {
          const sample = sampleForestSquareRoad(x, z, seed);
          if (sample.dist < 0.2 && sample.blend > 0.95) {
            roadX = x;
            roadZ = z;
            foundRoad = true;
            break;
          }
        }
        if (foundRoad) break;
      }
      assert.ok(foundRoad, 'Yo\'l namunasi topilmadi');

      const [rRoad, gRoad, bRoad] = sampleForestSquareTerrainColor(roadX, 0.0, roadZ, 2, seed);
      assert.ok(rRoad > gRoad, `Yo'l qizil komponenti (${rRoad}) yashildan (${gRoad}) ustun bo'lishi kerak`);
      assert.ok(gRoad > bRoad, `Yo'l yashil komponenti (${gRoad}) ko'kdan (${bRoad}) ustun bo'lishi kerak`);
      assert.ok(rRoad >= 0.16 && rRoad <= 0.25, `Yo'l tuproq qizilligi: ${rRoad}`);
      assert.ok(gRoad >= 0.10 && gRoad <= 0.18, `Yo'l tuproq yashilligi: ${gRoad}`);
      assert.ok(bRoad >= 0.05 && bRoad <= 0.11, `Yo'l tuproq ko'k rangi: ${bRoad}`);
    });

    it('3.6 POI hovlilari, tepaliklar va pastliklar alohida material/rang tuslariga ega', () => {
      const seed = DEFAULT_PUBLIC_LAYOUT_SEED;
      const sites = getForestSquarePoiSites(seed);
      assert.ok(sites.length > 0);
      const site = sites[0]!;

      // POI hovli markazi: iliq tuproq
      const [rYard, gYard, bYard] = sampleForestSquareTerrainColor(
        site.center.x,
        site.padElevation,
        site.center.z,
        1,
        seed,
      );
      assert.ok(rYard > gYard, `Hovli qizilligi (${rYard}) yashilligidan (${gYard}) ustun`);
      assert.ok(rYard >= 0.20 && rYard <= 0.26);

      // Quyoshli tepalik (x=24, z=94): zaytun-yashil
      const [rHill, gHill, bHill] = sampleForestSquareTerrainColor(24, 2.5, 94, 8, seed);
      assert.ok(gHill > rHill, 'Tepalikda yashil rang dominant');
      assert.ok(gHill >= 0.25 && gHill <= 0.35);

      // Nam pastlik (x=-24, z=88, y=-1.4): to'q mox-yashil
      const [rHollow, gHollow, bHollow] = sampleForestSquareTerrainColor(-24, -1.4, 88, 6, seed);
      assert.ok(gHollow > rHollow, 'Pastlikda yashil dominant');
      assert.ok(rHollow <= 0.13, 'Pastlik qizilligi juda past (to\'q mox)');
      assert.ok(gHollow >= 0.17 && gHollow <= 0.25);
    });
  });

  // =========================================================================
  // 4. Preservation of Gameplay Hash & World Invariants
  // =========================================================================
  describe('4. Determinizm, Gameplay Hash va Dunyo Invariantlarining Saqlanishi', () => {

    it('4.1 buildForestSquareTerrain(6501) deterministik balandlik va qiyalik profilini hosil qiladi', () => {
      const t1 = buildForestSquareTerrain(6501);
      const t2 = buildForestSquareTerrain(6501);

      assert.equal(t1.width, 256);
      assert.equal(t1.depth, 256);
      assert.equal(t1.cellSize, 2);
      assert.equal(t1.cols, 129);
      assert.equal(t1.rows, 129);
      assert.equal(t1.heights.length, 129 * 129);
      assert.deepEqual(t1.heights, t2.heights, 'Qayta chaqirilganda relyef balandliklari 100% teng bo\'lishi shart');
    });

    it('4.2 Seed 6501 uchun gameplayHash aynan "d82286ad69e55014" ga teng va barcha xaritalash invariantlari daxlsiz', () => {
      const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

      assert.equal(
        world.gameplayHash,
        'd82286ad69e55014',
        'seed 6501 uchun gameplayHash aynan d82286ad69e55014 bo\'lishi shart',
      );
      assert.equal(world.spawnPoints.length, 36, 'O\'rmon xaritasida aynan 36 ta spawn nuqtasi bo\'lishi kerak');
      assert.equal(world.containerLocations.length, 26, 'O\'rmon xaritasida aynan 26 ta loot konteyneri bo\'lishi kerak');
      assert.equal(world.colliders.length, 2356, 'O\'rmon xaritasida aynan 2356 ta fizik kollayder bo\'lishi kerak');
    });

    it('4.3 Ground cover va shader vizual o‘zgarishlari dunyo hashiga yoki kollayderlar ro‘yxatiga ta’sir qilmaydi', () => {
      const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
      const hashBefore = world.gameplayHash;
      const collidersBefore = JSON.stringify(world.colliders);

      // Ground cover yaratamiz
      const field = buildForestSquareGroundCover(world);
      assert.ok(field.total > 0);

      // Hash va kollayderlar aslo o'zgarmasligi kerak
      assert.equal(world.gameplayHash, hashBefore, 'Ground cover yaratilishi gameplayHash ni o\'zgartirmasligi kerak');
      assert.equal(JSON.stringify(world.colliders), collidersBefore, 'Kollayderlar ro\'yxati mutlaqo daxlsiz bo\'lishi shart');
      assert.equal(world.spawnPoints.length, 36);
      assert.equal(world.containerLocations.length, 26);
      assert.equal(world.colliders.length, 2356);
    });
  });
});
