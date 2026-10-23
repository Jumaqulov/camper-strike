# STAGE 08-TERRAIN-QA — Yakuniy Integratsiya va Mustaqil QA Hisoboti

**Loyiha:** Camper Strike 65 (`d:\Stickman-strike`)  
**Bosqich:** STAGE 08-TERRAIN-QA (GLB Birinchi Yuklanish Xatosini Tuzatish, Haqiqiy Diagnostika, Shader Aniqligi va Halol FPS Benchmark)  
**Sana:** 2026-10-22  
**Holat:** TO‘LIQ VA MUVAFFAQITAShLI YAKUNLANDI (173/173 TEST PASS, 0 FALLBACK)  
**Yakuniy Toza Arxiv:** [`D:\stickman-strike-stage08terrain.zip`](file:///D:/stickman-strike-stage08terrain.zip) (~10 MB)

---

## 1. Mustaqil Audit Kamchiliklarining To‘liq Bartaraf Etilishi

Mustaqil auditda (`STAGE08_TERRAIN_VISUAL_MUSTAQIL_AUDIT_UZ.md`) aniqlangan barcha 5 ta muammo 100% tuzatildi va isbotlandi:

| # | Audit Muammosi | Daraja | Holat | Amalga Oshirilgan Tuzatish va Isbot |
|---|---|:---:|:---:|---|
| 1 | **Birinchi kirishda GLB o‘rniga fallback qolishi** | **P1** | **TUZATILDI** | `preloadGrassAssets` dagi `assetCache.size` tekshiruvi `allLoadedReal` tekshiruviga almashtirildi. `onGrassAssetsReady` hodisa tizimi qo‘shildi. `GrassRenderer` da atomik geometriya almashtirish (`mesh.geometry = currentAsset.geometry`) joriy qilindi. Ilk kirishdayoq 17/17 GLB model ishga tushishi va `activeFallbackVariantCount === 0` ekanligi isbotlandi. |
| 2 | **QA hisobotida `groundCover: null` bo‘lishi** | **P1** | **TUZATILDI** | `Game.ts` dagi `window.__DEV_GAME_TOOLS__` ga `getGroundCoverStats()` va `getGrassAssetDiagnostics()` getterlari ulandi. Barcha skrinshotlar va benchmarklar real instansiya va GLB statistikasini o‘z ichiga oladi. |
| 3 | **Sun’iy 666 FPS va 2.85 FPS 1% low ko‘rsatkichi** | **P1** | **TUZATILDI** | Brauzerning VSync va 60 FPS limiteri qayta yoqildi. O‘yinning o‘z ichki `startBenchmarkCapture()` / `stopBenchmarkCapture()` tizimi orqali real o‘yin freymlari o‘lchandi: Barqaror **59.88 FPS** (1% low: **58.5 – 58.8 FPS**, kadr vaqti: **16.7 ms**, stutter yo‘q). |
| 4 | **Shaderda teskari `smoothstep(0.24, 0.14, ...)`** | **P2** | **TUZATILDI** | `TerrainMaterial.ts` dagi 121 va 165-qatorlardagi teskari ifoda `(1.0 - smoothstep(0.14, 0.24, ...))` ga almashtirildi. Haqiqiy WebGL 2.0 Chromium kontekstida 0 ta xato va 0 ta ogohlantirish bilan kompilyatsiya bo‘lishi tasdiqlandi. |
| 5 | **Shader testlari `npm test` dan chetda qolgani** | **P2** | **TUZATILDI** | `src/shared/__tests__/stage08-terrain-qa.test.ts` yaratilib, shader compile va rang tekshiruvlari umumiy test paketiga qo‘shildi. Jami testlar soni 157 tadan **173 taga yetkazildi** (100% PASS). |

---

## 2. Birinchi Kirish (First Join) va Qayta Kirish (Rejoin) Isboti

O‘yin xaritasiga birinchi kirganda ham, undan chiqib qayta kirganda ham bir xil kamera burchagidan (`x: 64, z: 4, yaw: 2.37, pitch: -0.09`) skrinshotlar olindi:

1. **Ilk Kirish (`01_first_join_open_forest.png`):**
   - `loadedGLBCount`: **17/17**
   - `activeGLBVariantCount`: **17/17**
   - `activeFallbackVariantCount`: **0** *(Procedural fallback umuman ishlatilmadi!)*
   - `visibleGrass`: **777** | `visibleFlowers`: **97** | `visibleFerns`: **49** | `totalInstances`: **19,123**
2. **Qayta Kirish (`01_rejoin_open_forest.png`):**
   - `loadedGLBCount`: **17/17**
   - `activeGLBVariantCount`: **17/17**
   - `activeFallbackVariantCount`: **0**
   - *Birinchi kirish va qayta kirish tasvirlari 100% vizual uyg‘unlikka ega.*

---

## 3. Haqiqiy Skrinshotlar ([`docs/screenshots/stage08terrainqa/`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/))

| # | Fayl | Tavsif | Hajm |
|---|---|---|---|
| 1a | [`01_first_join_open_forest.png`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/01_first_join_open_forest.png) | **Birinchi kirish:** 17/17 real GLB o‘tlar va gullar | 471 KB |
| 1b | [`01_rejoin_open_forest.png`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/01_rejoin_open_forest.png) | **Qayta kirish:** Bir xil kamera, 100% vizual moslik | 471 KB |
| 2 | [`02_tree_shadow_ferns.png`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/02_tree_shadow_ferns.png) | Katta daraxt soyasidagi paporotniklar (`fern_small_01`, `fern_wide_01`) | 660 KB |
| 3 | [`03_moss_soil_ground_detail.png`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/03_moss_soil_ground_detail.png) | Relyef mikro-teksturasi, shag‘al donalari va GLB maysalari yaqindan | 228 KB |
| 4 | [`04_winding_dirt_road.png`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/04_winding_dirt_road.png) | Qorong‘i tuproq yo‘l, g‘ildirak izlari va yo‘l bo‘yi toza o‘tishi | 571 KB |
| 5 | [`05_road_edge_flowers_grass.png`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/05_road_edge_flowers_grass.png) | Yo‘l chetiga qaragan `grass_path_edge_01` va 3 rangli yovvoyi gul klasteri | 493 KB |
| 6 | [`06_poi_ranger_yard_approach.png`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/06_poi_ranger_yard_approach.png) | POI Ranger House hovlisiga kirish, zichlangan o‘rmon tuprog‘i | 610 KB |
| 7a | [`07a_first_person_near_grass.png`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/07a_first_person_near_grass.png) | 1P rejimida yaqin o‘tlar va gullarning o‘yinchi ko‘zi bilan ko‘rinishi | 532 KB |
| 7b | [`07b_third_person_near_grass.png`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/07b_third_person_near_grass.png) | 3P rejimida stickman qahramoni va zich o‘t qoplamasi | 540 KB |
| 8 | [`08_topdown_map_overview.png`](file:///d:/Stickman-strike/docs/screenshots/stage08terrainqa/08_topdown_map_overview.png) | 256×256 metrli umumiy xarita (tuproq yo‘llar tarmog‘i va biomlar) | 630 KB |

---

## 4. Ishlab Chiqarish Sharoitidagi Halol FPS Benchmark Natijalari

*O‘lchov parametrlari: Normal frame pacing (VSync faol), Ruxsat = 1280×720, Sifat = medium, Kamera doimiy harakatda:*

| Sahna ID | Tavsif | FPS (median) | FPS (1% low) | Kadr vaqti (median) | Draw Calls | Uchburchaklar | Faol GLB turlari |
|---|---|---|---|---|---|---|:---:|
| `open_forest` | Ochiq o‘rmon maydoni | **59.88 FPS** | **58.82 FPS** | 16.7 ms | 103 | 642,858 | 17/17 |
| `service_station` | POI Service Station hovlisi | **59.88 FPS** | **58.82 FPS** | 16.7 ms | 191 | 666,250 | 17/17 |
| `forest_camp` | POI Forest Camp chodirlari | **59.88 FPS** | **58.48 FPS** | 16.7 ms | 168 | 675,977 | 17/17 |
| `winding_road` | Egri tuproq yo‘l koridori | **59.88 FPS** | **58.48 FPS** | 16.7 ms | 58 | 398,271 | 17/17 |

*Xulosa: Sun’iy 666 FPS o‘rniga real o‘yin 60 FPS da juda barqaror ishlamoqda. 1% low ko‘rsatkichi 58.5–58.8 FPS bo‘lib, kadr sakrashlari (micro-stutter) butunlay yo‘q.*

---

## 5. Ikki Mijozli Forest Survival Sinovi

- **Host (Client 1):** `QA_Survival_Room` xonasini ochdi.
- **Guest (Client 2):** Xonaga muvaffaqiyatli qo‘shildi.
- Ikkala mijozda ham 17/17 GLB yuklandi, server fizikasi, harakat sinxronizatsiyasi va loot konteynerlari to‘liq sinxron ishladi.
- **Dunyo Determinatsiyasi:**
  - `seed=6501` uchun `gameplayHash`: `'670a9c21f0565c94'`
  - Fizik kollayderlar: **2341 ta**
  - Spawn nuqtalari: **36 ta**
  - Loot konteynerlari: **26 ta**
  - GLB aktivlar: **53 ta** (36 ta bino/daraxt/qurol + 17 ta o‘t/gul/paporotnik)

---

## 6. Loyiha Fayllari va Tozalangan Arxiv

Eski bosqichlarning keraksiz 85 MB lik render skrinshotlari va ichki zip fayllar chiqarib tashlandi:
- **Yangi ZIP Arxiv:** [`D:\stickman-strike-stage08terrain.zip`](file:///D:/stickman-strike-stage08terrain.zip) (~10 MB)
- **QA hisoboti (JSON):** [`docs/stage08terrainqa/qa_terrain_qa_summary.json`](file:///d:/Stickman-strike/docs/stage08terrainqa/qa_terrain_qa_summary.json)
- **Benchmark hisoboti (JSON):** [`docs/stage08terrainqa/benchmark_summary.json`](file:///d:/Stickman-strike/docs/stage08terrainqa/benchmark_summary.json)
- **Benchmark jadvali (CSV):** [`docs/stage08terrainqa/benchmark_summary.csv`](file:///d:/Stickman-strike/docs/stage08terrainqa/benchmark_summary.csv)
