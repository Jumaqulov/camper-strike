# BOSQICH 04B — Forest Square 256×256: Katta O‘rmon, 6 POI va Masshtablanuvchi Arxitektura Hisoboti

**Bosqich:** `BOSQICH 04B — Forest Square (256×256 m, 6 POI, Multi-Site Rotated Modular Structures & Scalability)`  
**Sana:** 2026-10-21  
**Holati:** ✅ **100% BAJARILDI (`66/66` unit/integration test PASS, `0` TypeScript xato, `28/28` GLB aktiv, 2-mijozli multiplayer va multi-seed sinovlari PASS)**

---

## 1. Sub-agentlar Taqsimoti va Qat’iy Fayl Egaligi

Bosqich 04B talablari asosida barcha mustaqil vazifalar 6 ta ixtisoslashgan sub-agent o‘rtasida qat’iy fayl egaligi (`exclusive file ownership`) bilan parallel ravishda bajarildi va asosiy agent (Coordinator) tomonidan yagona tizimga birlashtirildi:

| Agent | Rol | Tegishli Fayllar (Exclusive Ownership) | Asosiy Natija |
| :--- | :--- | :--- | :--- |
| **Coordinator (Asosiy Agent)** | Arxitektura, Kontraktlar va Integratsiya | `src/shared/structures/contracts.ts`, `src/shared/structures/index.ts`, `src/shared/forestSquare.ts`, `src/shared/world.ts`, `src/client/game/World.ts`, `src/client/game/ForestRenderer.ts`, `src/client/main.ts`, `index.html` | `forest_square` eski Dust Arena fallbackidan haqiqiy `256×256 m` o‘rmon dunyosiga o‘tkazildi, lobbyda asosiy xarita sifatida yoqildi |
| **Sub-agent A** | World Terrain & Roads (`256×256`) | `src/shared/forestSquareRoads.ts`, `src/shared/forestSquareTerrain.ts` | `129×129` (`cellSize = 2m`) heightfield relyef, 7 ta Catmull-Rom yo‘l polilinlari (`main_road` + 6 ta shoxobcha/halqa), 6 ta POI tekislangan maydonchasi (`flatRadius` + `blendRadius`), 2 ta tik qoya to‘siq (`> 65°`) |
| **Sub-agent B** | POI & Modular Structures (`6 POIs`) | `src/shared/structures/multiSiteLayout.ts`, `src/shared/structures/forestSquarePOIs.ts` | 6 ta qidiriladigan POI, 4 xil bino planshemasi (`cabin_8x4`, `room_4x4`, `warehouse_8x4`, `watchpost_4x4`), `0°/90°/180°/270°` yaw rotatsiyasi, 9 ta bino, 59 ta mebel, 26 ta konteyner, `assertUniqueLayoutIds` |
| **Sub-agent C** | Vegetation, Props & Safe Spawns | `src/shared/forestSquareVegetation.ts`, `src/shared/forestSquareSpawns.ts` | `565` ta GLB daraxt (`5` tur), `95` ta moxli tosh (`forest_rock_01.glb`), `220` ta buta (`forest_bush_01.glb`), `1,235` ta undergrowth, `36` ta xavfsiz spawn (`12 red`, `12 blue`, `12 none`) |
| **Sub-agent D** | Rendering Scalability (`256×256`) | `src/client/game/ForestSquareRenderer.ts` | `buildMergedStaticBoxMeshes` (rotatsiya bilan), `createPoiScalabilityCuller` (zero-allocation ichki mebel/konteyner/eshik/chiroq frustum & shadow culling), `createPlayerFollowingSunShadow` (4m kvantlangan quyosh soyasi) |
| **Sub-agent E** | Test & Navigation QA | `src/server/navgraph.ts`, `src/shared/__tests__/forest-square-04b.test.ts` | `NavGraph` spatial index (`collidesAtWorld`) va moslashuvchan katak (`cell = 4`) bilan `< 90 ms` ga tezlashtirildi; 6 ta keng qamrovli 04B test bloki yozildi (`66/66` jami test PASS) |
| **Sub-agent F** | Browser QA, Screenshots & Benchmark | `scripts/qa-stage04b.mjs`, `docs/screenshots/stage04b/*.png`, `docs/stage04b/benchmark.json`, `docs/stage04b/benchmark.csv` | 12 ta `1280×720` WebGL skrinshot, 2-mijozli va multi-seed multiplayer sinovi, 3-martalik (`low/medium/high`) FPS benchmark va 10× room reload xotira tekshiruvi (`leakDetected: false`) |

---

## 2. 04A QA Kamchiliklarining To‘liq Bartaraf Etilishi

`STICKMAN_STAGE_04A_QA_UZ.md` hujjatida qayd etilgan barcha arxitektura masalalari 04B da hal qilindi:

1. **`forest_square` endi Dust Arena emas:** `src/shared/world.ts` dagi `createWorldDefinition({ mapId: 'forest_square' })` endi eski `buildDustArena()` ga qaytmaydi, balki `createForestSquareWorld()` orqali haqiqiy `256×256 m` (`[-128, 128] × [-128, 128]`) deterministik o‘rmon dunyosini (`gameplayHash: c4064b17f166cd42` for `seed = 6501`) yaratadi.
2. **Hardcoded bitta bino o‘rniga generic `MultiSiteStructureLayout` va `0° / 90° / 180° / 270°` rotatsiya:** `src/shared/structures/multiSiteLayout.ts` ichida `rotatePointAroundPivot`, `rotateBuildingPrefab`, `rotateFurniturePlacements`, `rotateContainerPlacements` va `compileMultiSiteBuildingColliders` yozildi. Bino modullari, ayvon pog‘onalari (`porchSteps`), mebellar, konteynerlar hamda ularning segmentlangan colliderlari va `worldAnchors` nuqtalari istalgan `origin` va `yaw` burchakka 100% sinxron aylanadi.
3. **100% Unikal Namespaced IDlar:** Barcha 6 ta POI obyektlari `poi:<poiId>:bld:<idx>`, `poi:<poiId>:cnt_<idx>:<assetId>` va `poi:<poiId>:furn_<idx>:<assetId>` formatida nomlandi va `assertUniqueLayoutIds(layout)` orqali har bir `buildings`, `buildingModules`, `porchSteps`, `interiors`, `containers`, `colliders`, `visuals`, `worldAnchors`, `locations`, `containerLocations` kolleksiyasida takroriy ID yo‘qligi kafolatlandi.
4. **Masshtablanuvchi Render va Culling (`ForestSquareRenderer.ts`):**
   - `createPoiScalabilityCuller`: uzoqdagi POI binolari ichidagi mebellar, konteynerlar, eshiklar va `PointLight` chiroqlarini masofa va frustum bo‘yicha zero-allocation tarzda boshqaradi hamda uzoqdagi mebel/konteynerlarning `castShadow` xossasini o‘chiradi.
   - `createPlayerFollowingSunShadow`: `256×256 m` xaritada quyosh soyasi kamerasini o‘yinchi atrofida **4 metrli kvantlangan qadam** bilan kuzatib boradi (`shadow swimming` miltillashisiz).

---

## 3. 256×256 O‘rmon Xaritasi, Yo‘l Tarmog‘i va 6 ta POI Tafsiloti (`seed = 6501`)

- **Xarita chegaralari (`bounds`):** `minX: -128, maxX: 128, minZ: -128, maxZ: 128, minY: -8, maxY: 42` (`256 × 256 m`)
- **Relyef (`HeightfieldTerrainDescriptor`):** `129 × 129 = 16,641` balandlik nuqtasi (`cellSize = 2m`), balandlik diapazoni `-2.68 m .. +10.20 m`, tabiiy tepaliklar, moxli pastliklar, POI tekis maydonchalari (`flatRadius` + `smoothstep` radial blend) va chekka hududlarda 2 ta tik qoya (`> 65°`).
- **Yo‘l tarmog‘i (`forestSquareRoads.ts`):** `main_road` (janubdan shimolga burama asosiy yo‘l) + 6 ta shoxobcha/halqa yo‘l (`branch_nw_ranger`, `branch_ne_cluster`, `branch_w_lumber`, `trail_w_loop`, `branch_sw_camp`, `branch_se_cliff`) barcha 6 ta POI hovlisiga ravon (`slope <= 15.7°`) tutashadi.
- **Vegetatsiya va toshlar (`forestSquareVegetation.ts`):**
  - `565` ta GLB daraxt (`pine_tree_01`, `spruce_tree_01`, `leaning_pine_01`, `ancient_tree_01`, `birch_tree_01`) + `72` ta ufq vista daraxti (`jami 637` ta daraxt instansi),
  - `95` ta moxli xarsangtosh (`forest_rock_01.glb`),
  - `220` ta o‘rmon butasi (`forest_bush_01.glb`),
  - `1,235` ta undergrowth detal (`80` xoda, `75` to‘nka, `280` paporotnik, `420` maysa, `200` mayda tosh, `180` xazon qatlami).
- **Spawn nuqtalari (`forestSquareSpawns.ts`):** Jami `36` ta (`12` ta `'red'`, `12` ta `'blue'`, `12` ta `'none'`), barchasi `isSpawnPointSafe` va `validateMapSpawns` tekshiruvlaridan 100% o‘tgan.

### 6 ta Qidiriladigan POI Jadvali (`seed = 6501`):

| # | POI ID | Nomi va Turi (`LocationKind`) | Markaz `(x, z)` va `floorY` | Kiriladigan Binolar va Rotatsiya (`yaw`) | Mebellar (`59` ta) | Konteynerlar (`26` ta) va Tashqi Proplar |
| :-: | :--- | :--- | :---: | :--- | :-: | :--- |
| **1** | `poi_ranger_house` | **O‘rmonchi Uyi** (`ranger_house`) | `(-70.8, -64.4)`, `floorY = 1.48 m` | `1× cabin_8x4` (`yaw = 0°`, 2-qavat loft va `wood_stairs_01` bilan) | `6` ta | **4 ta:** `2× crate`, `1× locker`, `1× toolbox` + o‘tin g‘arami |
| **2** | `poi_cabin_cluster` | **Uylar Guruhi** (`cabin_cluster`) | `(66.3, -63.1)`, `floorY = 2.03 m` | `1× cabin_8x4` (`0°`), `1× room_4x4` (`+90°`), `1× room_4x4` (`-90°`) | `20` ta | **6 ta:** `2× crate`, `2× locker`, `2× toolbox` + hovli skameykasi |
| **3** | `poi_lumber_mill` | **Yog‘och Tilish Maydoni** (`lumber_mill`) | `(-73.9, 13.7)`, `floorY = 1.05 m` | `1× warehouse_8x4` (`+90°`, ikki eshikli ustaxona ombori) | `6` ta | **4 ta:** `2× crate`, `1× locker`, `1× toolbox` + taxta/g‘o‘la uyumlar va arralash dastgohi |
| **4** | `poi_service_station` | **Eski Servis va Ombor** (`service_station`) | `(19.7, -8.3)`, `floorY = 0.75 m` | `1× warehouse_8x4` (`180°`), `1× room_4x4` (`0°` dispetcher xonasi) | `12` ta | **5 ta:** `1× crate`, `2× locker`, `2× toolbox` + yonilg‘i baki va servis rampasi |
| **5** | `poi_forest_camp` | **O‘rmon Kempingi** (`camp`) | `(-56.9, 71.1)`, `floorY = 0.66 m` | `1× room_4x4` (`180°` kemping uychasi) | `10` ta | **4 ta:** `2× crate`, `1× locker`, `1× toolbox` + ekspeditsiya furgoni silueti, 2 ta soyabon, gulxan va piknik stoli |
| **6** | `poi_cliff_watch` | **Qoya Kuzatuv va Xaroba** (`stone_ruins`) | `(64.6, 65.8)`, `floorY = 2.58 m` | `1× watchpost_4x4` (`0°`, tashqi `wood_stairs_01` bilan `y = 5.58 m` 2-qavat palubali) | `5` ta | **3 ta:** `1× crate` (2-qavatda), `1× locker`, `1× toolbox` + tosh xaroba devorlari |

---

## 4. Haqiqiy WebGL Skrinshotlar (`docs/screenshots/stage04b/`)

Barcha 12 ta skrinshot `scripts/qa-stage04b.mjs` orqali real Chrome WebGL (`1280×720`) sahnasidan olindi:
1. `docs/screenshots/stage04b/01_topdown_256x256_6_pois.png` — Yuqoridan 256×256 o‘rmon, yo‘l tarmog‘i va barcha 6 ta POI ko‘rinishi.
2. `docs/screenshots/stage04b/02_road_network_and_crossroads.png` — Markaziy o‘rmon chorrahasi va `poi_service_station` ko‘rinishi.
3. `docs/screenshots/stage04b/03_poi1_ranger_house_ext_int.png` — POI 1 (`poi_ranger_house`) 8×4 loftli kulba, o‘tin g‘arami va hovli konteyneri.
4. `docs/screenshots/stage04b/04_poi2_cabin_cluster_3_buildings.png` — POI 2 (`poi_cabin_cluster`) hovlisidagi 3 ta kiriladigan bino (`0°`, `+90°`, `-90°`).
5. `docs/screenshots/stage04b/05_poi2_rotated_interior_furniture.png` — POI 2 dagi `+90°` aylantirilgan `4×4` uy ichki mebellari va konteynerlari.
6. `docs/screenshots/stage04b/06_poi3_lumber_mill_yard.png` — POI 3 (`poi_lumber_mill`) `+90°` aylantirilgan ustaxona ombori va taxta/g‘o‘la maydoni.
7. `docs/screenshots/stage04b/07_poi4_service_station_depot.png` — POI 4 (`poi_service_station`) `180°` aylantirilgan servis ombori, dispetcher xonasi, yonilg‘i baki va servis rampasi.
8. `docs/screenshots/stage04b/08_poi5_forest_camp_clearing.png` — POI 5 (`poi_forest_camp`) kemping uychasi, ekspeditsiya furgoni, soyabonlar va gulxan maydoni.
9. `docs/screenshots/stage04b/09_poi6_cliff_watch_ruins_2nd_floor.png` — POI 6 (`poi_cliff_watch`) 2-qavatli kuzatuv minorasi, tashqi zinapoya va 2-qavatdagi o‘yinchi.
10. `docs/screenshots/stage04b/10_forest_cover_1p.png` — 1P rejimda GLB avtomat bilan o‘rmon yo‘li va POI ko‘rinishi.
11. `docs/screenshots/stage04b/11_forest_cover_3p.png` — 3P rejimda bino ichida zinapoya, loft va mebellar ko‘rinishi.
12. `docs/screenshots/stage04b/12_two_clients_poi_encounter.png` — 2 ta mijoz (`Client 1` va `Client 2`) `poi_cabin_cluster` hovlisida yuzma-yuz.

---

## 5. Performance Benchmark (`low` / `medium` / `high`, 3 Takror Median) va Xotira Sinovi

To‘liq raqamlar `docs/stage04b/benchmark.json` va `docs/stage04b/benchmark.csv` fayllarida saqlangan (`1280×720`, `4` ta bot bilan `forest_square` sahnasida, 3 marta takrorlangan median ko‘rsatkichlar):

| Sifat (`Quality`) | Sahna (`Scene`) | `avgFps` | `p50Fps` | `p10Fps` | `avgFrameTimeMs` | `Draw Calls` | `Triangles` | `Geometries` / `Textures` |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Low** | `topdown_overview` | **78.0** | 370.4 | 27.5 | 12.82 ms | 477 | 1,088,794 | 131 / 12 |
| **Low** | `poi_cabin_cluster` | **133.1** | 204.1 | 97.1 | 7.51 ms | 145 | 381,606 | 131 / 12 |
| **Low** | `poi_lumber_mill` | **157.1** | 384.6 | 113.6 | 6.37 ms | 94 | 367,896 | 131 / 12 |
| **Low** | `poi_service_station` | **153.9** | 217.4 | 103.1 | 6.50 ms | 170 | 394,036 | 123 / 12 |
| **Low** | `forest_combat_1p` | **151.0** | 357.1 | 108.7 | 6.63 ms | 261 | 448,476 | 147 / 13 |
| **Medium** | `topdown_overview` | **66.4** | 285.7 | 19.4 | 15.07 ms | 509 | 1,324,582 | 155 / 13 |
| **Medium** | `poi_cabin_cluster` | **94.6** | 126.6 | 63.7 | 10.58 ms | 225 | 452,534 | 156 / 13 |
| **Medium** | `poi_lumber_mill` | **102.1** | 178.6 | 101.0 | 9.79 ms | 130 | 443,401 | 156 / 13 |
| **Medium** | `poi_service_station` | **97.8** | 137.0 | 71.4 | 10.23 ms | 288 | 574,967 | 156 / 13 |
| **Medium** | `forest_combat_1p` | **95.9** | 129.9 | 66.2 | 10.43 ms | 297 | 612,543 | 156 / 13 |
| **High** | `topdown_overview` | **65.6** | 263.2 | 27.6 | 15.25 ms | 575 | 1,542,514 | 164 / 13 |
| **High** | `poi_cabin_cluster` | **79.3** | 128.2 | 59.9 | 12.61 ms | 214 | 459,320 | 158 / 13 |
| **High** | `poi_lumber_mill` | **87.7** | 333.3 | 92.6 | 11.40 ms | 173 | 497,648 | 158 / 13 |
| **High** | `poi_service_station` | **89.2** | 117.7 | 63.7 | 11.22 ms | 373 | 703,748 | 164 / 13 |
| **High** | `forest_combat_1p` | **73.3** | 114.9 | 55.3 | 13.64 ms | 317 | 710,964 | 164 / 13 |

### 10× Ketma-ket Xonaga Kirib-Chiqish (Memory Leak Test):
- **1-sikldan 10-siklgacha (`forest_square`):**
  - `renderer.info.memory.geometries`: `88 -> 88` (`geometryDelta = 0`)
  - `renderer.info.memory.textures`: `9 -> 9` (`textureDelta = 0`)
  - `renderer.info.programs`: `11 -> 11` (`programDelta = 0`)
  - `leakDetected`: **`false`** (barcha dinamik geometriyalar va materiallar `dispose()` da to‘liq tozalanadi, keshlangan 28 ta GLB esa xavfsiz saqlanadi).
