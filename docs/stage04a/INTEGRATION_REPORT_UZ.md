# BOSQICH 04A — 17 ta GLB Integratsiyasi (Binolar, Interyer Mebellari va Loot Konteynerlari) Hisoboti

**Bosqich:** `BOSQICH 04A` (Faqat 04A; `04B` va `06` boshlanmadi)  
**Xarita identifikatori:** `forest_assets_preview` (`seed = 6501`, `worldVersion = 1`, `gameplayHash = 7f36e84b1b9c12e2`)  
**Holat:** `100% YAKUNLANDI (PASS)`

---

## 1. Sub-agentlar Orkestratsiyasi va Fayl Egaligi (Parallel Execution)

Ish `GEMINI_STAGE_04A_SUBAGENTS_PROMPT_UZ.md` talabiga muvofiq 6 ta ixtisoslashgan sub-agent va asosiy koordinator agent o‘rtasida qat’iy fayl chegaralari bilan taqsimlandi:

| Agent | Rol va Mas'uliyat | Eksklyuziv Fayl Egaligi | Natija |
| :--- | :--- | :--- | :--- |
| **Asosiy Agent** | Arxitektura, `contracts.ts`, `Stage04ASharedMaterials.ts`, `world.ts`, `forestSample.ts`, `ForestRenderer.ts`, `World.ts`, `Game.ts`, `main.ts`, `index.html`, yakuniy integratsiya | Umumiy kirish fayllari | `PASS` |
| **Sub-agent A** | 17 ta GLB binar/glTF 2.0 tekshiruvi, normallashtirilgan manifest va QA hisoboti | `tools/asset-validation/validate-stage04a-assets.mjs`, `docs/stage04a/assets_manifest_normalized.json`, `docs/assets/STAGE04A_ASSET_QA_REPORT_UZ.md` | `17/17 PASS` |
| **Sub-agent B** | 8 ta bino GLB kesh reestri, `placeWall()`, statik material batching va `wood_door_01` pivot boshqaruvi | `src/client/game/buildings/BuildingAssetRegistry.ts`, `ModularBuildingRenderer.ts`, `index.ts` | `PASS` |
| **Sub-agent C** | 6 ta mebel GLB kesh reestri, `kitchen_cabinet_01` ikki eshikli pivot (`-1.75 / +1.75 rad`) va anchor vizualizatsiyasi | `src/client/game/interiors/InteriorAssetRegistry.ts`, `InteriorRenderer.ts`, `index.ts` | `PASS` |
| **Sub-agent D** | 3 ta loot konteyner GLB kesh reestri va `lid_pivot` / `door_pivot` visual-only animatsiyasi | `src/client/game/containers/ContainerAssetRegistry.ts`, `ContainerRenderer.ts`, `index.ts` | `PASS` |
| **Sub-agent E** | Pure-TS (Three.js siz) segmentlangan kollayderlar, 8×4 kulba + 4×4 xona layout generatori va unit testlar | `src/shared/structures/manifests.ts`, `layoutBuilder.ts`, `index.ts`, `src/shared/__tests__/stage04a-structures.test.ts` | `60/60 PASS` |
| **Sub-agent F** | Headless Chrome WebGL 2-client QA, 14 ta skrinshot va benchmark | `scripts/qa-stage04a.mjs`, `docs/screenshots/stage04a/*.png`, `docs/stage04a/benchmark.json` | `PASS` |

---

## 2. 17 ta GLB Assetlar Validatsiyasi va Muhandislik Yechimlari

`node tools/asset-validation/validate-stage04a-assets.mjs` skripti barcha **17 ta GLB** modelni (`1,028,396 bayt`, `13,862` uchburchak) binar darajada tekshirdi:

1. **Umumiy Material Deduplikatsiyasi (`Stage04ASharedMaterials.ts`):**
   - Uchala paket (`BUILDING-ASSET-01`, `INTERIOR-ASSET-01`, `LOOT-ASSET-01`) bo‘yicha 5 ta umumiy `MeshStandardMaterial` singleton (`wood`, `roof`, `iron`, `fabric`, `painted_metal`) `vertexColors: true` va `userData.sharedAsset = true` bilan birlashtirildi.
2. **Modulli Binolar (`8` ta GLB — `public/models/buildings/`):**
   - `placeWall(obj, ax, az, bx, bz, y)` formulasi (`position = ((ax+bx)/2, y, (az+bz)/2)`, `rotation.y = Math.atan2(-(bz-az), bx-ax)`) asosida:
     - **`cabin_8x4` (`origin = (-11, 0.96, -8)`):** 17 ta moduldan iborat 2-qavatli loftli kulba (2 ta 1-qavat pol, 1 ta `y = 3.96m` loft pol, 3 ta derazali devor, 1 ta eshikli devor, 2 ta yaxlit devor, `wood_door_01` ochiq `1.38 rad` holatda, 2 ta gable, 4 ta roof slope va 15 pog‘onali `wood_stairs_01` + kirish ostona pog‘onalari).
     - **`room_4x4` (`origin = (-14, 0.96, 2)`):** 10 ta moduldan iborat 4×4 m jihozlangan sinov xonasi (`wood_door_01` `1.35 rad` ochiq holatda).
   - Eshik (`1.8 × 2.4 m`) va deraza (`1.2 × 1.0 m`) teshiklari segmentlangan AABB kollayderlar orqali ochiq qoldirildi (`raycastWorld` deraza va ochiq eshikdan bemalol o‘tadi).
3. **Interyer Mebellari (`6` ta GLB — `public/models/interior/`):**
   - **`old_bed_01`:** `under_bed` (`[0, 0, 0]`, `y ∈ [0, 0.20m]`) anchorini yopib qo‘ymaslik uchun yaxlit `frame_mattress` o‘rniga `mattress_top` (`y ∈ [0.20, 0.46m]`), `headboard` va 4 ta burchak oyoq ustunlariga (`bed_leg_*`) ajratildi (`pointInsideBoxes === false`).
   - **`kitchen_cabinet_01`:** Ichki `inside_bottom_*` (`y = 0.10m`) va `inside_shelf_*` (`y = 0.479m`) anchorlarini saqlash uchun 6 ta ichi bo‘sh korpus paneli + `door_left_pivot` (`[-0.585, 0, 0.255]`, `-1.75 rad`) va `door_right_pivot` (`[0.585, 0, 0.255]`, `+1.75 rad`) eshik kollayderlariga ajratildi. Eshiklar to‘liq ochilganda ham 4×4 xona markaziy yo‘lagi (`PLAYER_RADIUS = 0.38`) ochiq qoladi.
4. **Loot Konteynerlari (`3` ta GLB — `public/models/loot/`, faqat vizual va kollayder tayyorgarligi):**
   - `wooden_loot_crate_01` (`lid_pivot`, `X` o‘qi, `-1.92 rad`), `metal_locker_01` (`door_pivot`, `Y` o‘qi, `-1.75 rad`) va `old_toolbox_01` (`lid_pivot`, `X` o‘qi, `-1.92 rad`) uchun `simpleClosed` o‘rniga ichi bo‘sh `shellSegments` va harakatlanuvchi qopqoq/eshik kollayderi ishlatildi.

---

## 3. Benchmark va Texnik Ko‘rsatkichlar (`1280×720`, `quality = medium`, 4 bot)

Manba: `docs/stage04a/benchmark.json` (Intel Core i5-14400, Intel UHD Graphics 730 WebGL 2.0, `forest_assets_preview`, `seed = 6501`):

| Sahna | Median FPS | p10 FPS | 1% Low FPS | Median Frame (ms) | GPU Median (ms) | Draw Calls (Scene + VM) | Triangles | Geometries / Textures | JS Heap (MB) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `01_cabin_8x4_exterior` | **138.89** | 70.92 | 31.95 | 7.40 | 6.94 | 217 (217 + 0) | 227,756 | 146 / 8 | 43.22 |
| `02_cabin_8x4_interior_1p` | **101.01** | 52.63 | 22.47 | 10.00 | 9.46 | 299 (285 + 14) | 273,047 | 162 / 9 | 43.91 |
| `03_cabin_8x4_interior_3p` | **112.36** | 56.18 | 24.51 | 9.00 | 8.57 | 252 (252 + 0) | 264,796 | 162 / 9 | 46.37 |
| `04_room_4x4_interior` | **120.48** | 60.98 | 26.67 | 8.30 | 7.84 | 269 (269 + 0) | 271,504 | 155 / 9 | 54.26 |
| `05_topdown_stage04a_compound` | **91.74** | 45.05 | 19.01 | 11.20 | 10.96 | 408 (408 + 0) | 554,471 | 152 / 9 | 43.71 |

- **2-Client Multiplayer Sync:** `Client 1` va `Client 2` `forest_assets_preview` xonasida aynan bir xil `gameplayHash = 7f36e84b1b9c12e2` bilan sinxronlashdi (`gameplayHashMatch: true`).
- **28/28 GLB Yuklanishi:** `4` qurol + `7` o‘rmon + `8` bino + `6` mebel + `3` konteyner = **28 ta GLB** xatosiz (`consoleErrors = 0`, `networkErrors = 0`, `isFallback = false`) yuklandi.
- **10x Xonaga Qayta Kirib-Chiqish Xotira Testi:** 10 sikl davomida `geometries` (`106 -> 89`) va `textures` (`5 -> 5`) o‘smadi, `sharedAsset` keshlari buzilmadi.

---

## 4. Skrinshotlar Ro‘yxati (`docs/screenshots/stage04a/`)

1. `01_cabin_8x4_exterior.png` — `8×4` modul kulbaning tashqi ko‘rinishi
2. `02_room_4x4_exterior.png` — `4×4` sinov xonasi va orqa fonda `8×4` kulba
3. `03_cabin_8x4_interior_stairs_loft.png` — `8×4` kulba ichki ko‘rinishi (`wood_stairs_01`, `y=3.0m` loft, mebellar va konteynerlar)
4. `04_room_4x4_interior_furniture.png` — `4×4` xona ichki ko‘rinishi (barcha 6 mebel va 3 konteyner)
5. `05_door_closed_demo.png` — `wood_door_01` yopiq holatda (`0 rad`)
6. `06_door_open_demo.png` — `wood_door_01` ochiq holatda (`1.38 rad`)
7. `07_cabinet_closed_demo.png` — `kitchen_cabinet_01` yopiq holatda (`0`)
8. `08_cabinet_open_demo.png` — `kitchen_cabinet_01` ochiq holatda (`-1.75 / +1.75 rad` + anchor sferalari)
9. `09_containers_closed_demo.png` — 3 ta loot konteyner yopiq holatda (`0`)
10. `10_containers_open_demo.png` — 3 ta loot konteyner ochiq holatda (`1.0` + ichki anchor sferalari)
11. `11_inside_building_1p.png` — Bino ichida `1P` ko‘rinishi (GLB viewmodel qurol bilan)
12. `12_inside_building_3p.png` — Bino ichida `3P` ko‘rinishi (devor oldida xavfsiz qisqargan kamera)
13. `13_loft_second_floor_3p.png` — `wood_stairs_01` orqali chiqilgan 2-qavat loft (`y = 3.96m`) ustida `3P` o‘yinchi
14. `14_topdown_stage04a_compound.png` — Yuqoridan `8×4` kulba va `4×4` xona majmuasi ko‘rinishi
