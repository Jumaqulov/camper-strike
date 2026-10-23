# BOSQICH 08A — `OUTDOOR-ASSET-01` GLB Integratsiyasi, 6 POI Vizual Xilma-xilligi, Kollayderlar va Fast QA Hisoboti

**Sana:** 2026-10-22  
**Bosqich:** Stage 08A (`OUTDOOR-ASSET-01` — 8 ta yangi tashqi muhit GLB modeli, 42 ta deterministik joylashuv, fizika kollayderlari va `InstancedMesh` renderer)  
**Holat:** **100% BAJARILDI VA TASDIQLANDI** (`14` test suite / `115/115` test PASS, `0` xato)

---

## 1. Umumiy Xulosa va Sub-agentlar Arxitekturasi

Stage 08A doirasida Claude tomonidan yaratilgan `OUTDOOR-ASSET-01.zip` paketidagi **8 ta yangi low-poly tashqi muhit (outdoor) GLB modeli** `Stickman Strike` loyihasining `256×256 m` o‘lchamli `forest_square` xaritasidagi barcha **6 ta POI** hamda **markaziy yo‘l chorrahasiga (`loc_sq_central_crossroads`)** to‘liq integratsiya qilindi. Loyihadagi jami GLB modellar soni **28 tadan 36 taga** yetkazildi (`5,874,748 bayt`).

Ish jarayoni **6 ta parallel sub-agent** va asosiy koordinator agent o‘rtasida qat’iy fayl egaligi (exclusive file ownership) asosida taqsimlandi:

| Agent / Rol |Mas’uliyat doirasi | Tegishli fayllar | Holat |
|---|---|---|---|
| **Koordinator (Asosiy Agent)** | Umumiy kontraktlar, `forestSquarePOIs.ts`, `ForestRenderer.ts`, `Game.ts` dev hooklari va yakuniy integratsiya | [`src/shared/outdoor/contracts.ts`](file:///d:/Stickman-strike/src/shared/outdoor/contracts.ts), [`src/shared/structures/forestSquarePOIs.ts`](file:///d:/Stickman-strike/src/shared/structures/forestSquarePOIs.ts), [`src/client/game/ForestRenderer.ts`](file:///d:/Stickman-strike/src/client/game/ForestRenderer.ts), [`src/client/game/Game.ts`](file:///d:/Stickman-strike/src/client/game/Game.ts) | ✅ |
| **Sub-agent A — GLB Asset QA** | 8 ta yangi GLB va jami 36 ta GLB modelning binary glTF 2.0, `normal_sign`, node, anchor va bounding-box tekshiruvi | [`tools/outdoor-validation/validateOutdoorAssets.mjs`](file:///d:/Stickman-strike/tools/outdoor-validation/validateOutdoorAssets.mjs), [`docs/stage08a/assets_qa.json`](file:///d:/Stickman-strike/docs/stage08a/assets_qa.json), [`docs/stage08a/OUTDOOR_ASSET_01_QA_UZ.md`](file:///d:/Stickman-strike/docs/stage08a/OUTDOOR_ASSET_01_QA_UZ.md) | ✅ |
| **Sub-agent B — POI Placement** | 6 ta POI va markaziy chorrahada 42 ta deterministik `OutdoorPlacement`, yerga moslashuv (`sampleTerrainHeight`) va yo‘l ko‘rsatkich matnlari | [`src/shared/outdoor/outdoorPlacements.ts`](file:///d:/Stickman-strike/src/shared/outdoor/outdoorPlacements.ts) | ✅ |
| **Sub-agent C — Outdoor Colliders** | Har bir tashqi prop uchun deterministik AABB kollayderlar va `forest_tent_01` uchun 5 segmentli (kirish qismi ochiq) kollayder | [`src/shared/outdoor/outdoorColliders.ts`](file:///d:/Stickman-strike/src/shared/outdoor/outdoorColliders.ts) | ✅ |
| **Sub-agent D — Client GLB Renderer** | `OutdoorAssetRegistry` va `OutdoorRenderer` (`InstancedMesh` batching, `sign_text_*_anchor` o‘zbekcha `CanvasTexture` yozuvlari, `fire_anchor` alanga konusi, frustum/distance culling) | [`src/client/game/outdoor/OutdoorAssetRegistry.ts`](file:///d:/Stickman-strike/src/client/game/outdoor/OutdoorAssetRegistry.ts), [`src/client/game/outdoor/OutdoorRenderer.ts`](file:///d:/Stickman-strike/src/client/game/outdoor/OutdoorRenderer.ts), [`src/client/game/outdoor/index.ts`](file:///d:/Stickman-strike/src/client/game/outdoor/index.ts) | ✅ |
| **Sub-agent E — Unit & Adversarial Tests** | Stage 08A uchun 10 toifali unit va adversarial testlar to‘plami | [`src/shared/__tests__/stage08a-outdoor.test.ts`](file:///d:/Stickman-strike/src/shared/__tests__/stage08a-outdoor.test.ts) | ✅ |
| **Sub-agent F — Browser QA & Perf** | Headless Chrome (`1280×720`) 2-client tekshiruvi, 9 ta haqiqiy PNG skrinshot, 4 sahnali benchmark va 5× reload xotira tekshiruvi | [`scripts/qa-stage08a.mjs`](file:///d:/Stickman-strike/scripts/qa-stage08a.mjs), [`docs/stage08a/qa_summary.json`](file:///d:/Stickman-strike/docs/stage08a/qa_summary.json), [`docs/stage08a/qa_benchmark.csv`](file:///d:/Stickman-strike/docs/stage08a/qa_benchmark.csv) | ✅ |

---

## 2. `OUTDOOR-ASSET-01` (8 ta Yangi GLB Model) va 36 ta GLB Inventarizatsiyasi

Barcha 8 ta yangi model `public/models/outdoor/` katalogiga joylashtirildi va [`tools/outdoor-validation/validateOutdoorAssets.mjs`](file:///d:/Stickman-strike/tools/outdoor-validation/validateOutdoorAssets.mjs) orqali tekshirildi:

| # | Fayl nomi | Bayt | Uchburchaklar | Bo‘laklar (Sub-mesh) | Maxsus Anchor / Node’lar | `normal_sign` |
|---|---:|---:|---:|---:|---|---|
| 1 | `wooden_signpost_01.glb` | `66,664` | `586` | 1 (`mesh`) | `sign_board_n`, `sign_board_e`, `sign_board_w`, `sign_text_n_anchor`, `sign_text_e_anchor`, `sign_text_w_anchor` | `+1.0` |
| 2 | `lumber_stack_01.glb` | `75,640` | `688` | 1 (`mesh`) | `stack_top_anchor` | `+1.0` |
| 3 | `sawhorse_01.glb` | `54,024` | `480` | 1 (`mesh`) | `work_top_anchor` | `+1.0` |
| 4 | `old_fuel_pump_01.glb` | `166,236` | `1,510` | 2 (`pump_body`, `nozzle_holder`) | `dial_face`, `hose_curve`, `nozzle`, `pump_top_anchor` | `+1.0` |
| 5 | `rusty_barrel_01.glb` | `99,760` | `912` | 1 (`mesh`) | `barrel_top_anchor` | `+1.0` |
| 6 | `forest_tent_01.glb` | `58,760` | `524` | 1 (`mesh`) | `tent_floor`, `sleep_roll`, `tent_inside_anchor`, `tent_entrance_anchor` | `+1.0` |
| 7 | `campfire_pit_01.glb` | `160,364` | `1,462` | 3 (`stone_ring`, `charred_logs`, `ash_bed`) | `ember_core`, `fire_anchor` | `+1.0` |
| 8 | `wooden_railing_01.glb` | `20,832` | `164` | 3 (`post_start`, `post_end`, `rails`) | `railing_start_anchor`, `railing_end_anchor` | `+1.0` |
| **Jami (8 ta outdoor)** | — | **`702,280`** | **`6,326`** | **13 (16 batch)** | **Barcha anchorlar mavjud** | **100% `+1.0`** |

**Loyihadagi jami 36 ta GLB model taqsimoti:**
- `public/models/forest/`: **7 ta** (`1,945,388` bayt)
- `public/models/weapons/`: **4 ta** (`398,744` bayt)
- `public/models/buildings/`: **8 ta** (`1,813,920` bayt)
- `public/models/interior/`: **6 ta** (`648,400` bayt)
- `public/models/loot/`: **3 ta** (`366,016` bayt)
- `public/models/outdoor/`: **8 ta** (`702,280` bayt)
- **JAMI:** **36 / 36 ta GLB model** (`5,874,748` bayt, `allPassed: true`).

---

## 3. 6 ta POI va Markaziy Chorrahada 42 ta Deterministik Joylashuv (`outdoorPlacements.ts`)

[`src/shared/outdoor/outdoorPlacements.ts`](file:///d:/Stickman-strike/src/shared/outdoor/outdoorPlacements.ts) modulida `forest_square` xaritasining 6 ta POI hududi va markaziy chorrahasi bo‘ylab jami **42 ta deterministik `OutdoorPlacement`** obyektlari yaratildi hamda `poi_lumber_mill` va `poi_forest_camp` dagi eski takroriy oddiy quti (box) proplar (`woodpile_01`, `lumber_stack_north`, `log_bunk_south`, `saw_bench_01`, `wood_shelter_nw`, `wood_shelter_ne`, `fire_pit_stones`) haqiqiy GLB modellarga almashtirildi:

| Hudud (Location / POI) | Joylashtirilgan modellar | Soni | Asosiy xususiyatlari |
|---|---|---:|---|
| **Markaziy Chorraha** (`loc_sq_central_crossroads`) | `2× wooden_signpost_01` | **2** | 6 ta POI yo‘nalishini ko‘rsatuvchi o‘zbekcha yozuvlar (`O'RMONCHI UYI →`, `← KOTTEJLAR`, `TAXTA ZAVODI ↑`, `YOQILG'I SHAHOBCHASI →`, `← O'RMON LAGERI`, `QOYA POSTI ↓`) |
| **POI 1 — O‘rmonchi Uyi** (`poi_ranger_house`) | `1× wooden_signpost_01`, `2× wooden_railing_01`, `1× lumber_stack_01` | **4** | Kirish yo‘lagi oldida yog‘och to‘siqlar, g‘arbiy devor yonida o‘tin taxlami va yo‘l ko‘rsatkich |
| **POI 2 — Kottejlar** (`poi_cabin_cluster`) | `1× wooden_signpost_01`, `1× campfire_pit_01`, `2× wooden_railing_01`, `1× rusty_barrel_01` | **5** | Uchta kottej o‘rtasidagi hovlida tosh halqali gulxan (`campfire_pit_01` + alanga konusi), hovli chetida to‘siqlar va zanglagan bochka |
| **POI 3 — Taxta Zavodi** (`poi_lumber_mill`) | `1× wooden_signpost_01`, `3× lumber_stack_01`, `3× sawhorse_01`, `2× rusty_barrel_01` | **9** | Zavod hovlisida 3 ta katta yog‘och g‘arami, 3 ta arralash dastgohi (`sawhorse_01`) va 2 ta bochka |
| **POI 4 — Yoqilg‘i Shahobchasi** (`poi_service_station`) | `1× wooden_signpost_01`, `2× old_fuel_pump_01`, `6× rusty_barrel_01`, `1× wooden_railing_01` | **10** | Beton ostravok (`fuel_island_01`) ustida 2 ta retro yoqilg‘i ustuni (`old_fuel_pump_01`), 4 ta tik va **2 ta yotqizilgan (`rotationZ = π/2`)** `rusty_barrel_01` bochkasi |
| **POI 5 — O‘rmon Lageri** (`poi_forest_camp`) | `1× wooden_signpost_01`, `2× forest_tent_01`, `1× campfire_pit_01`, `1× lumber_stack_01` | **5** | Gulxan atrofida 2 ta haqiqiy A-frame chodir (`forest_tent_01`, kirish qismi gulxanga qaragan), gulxan va o‘tin taxlami |
| **POI 6 — Qoya Posti** (`poi_cliff_watch`) | `1× wooden_signpost_01`, `4× wooden_railing_01`, `1× campfire_pit_01`, `1× sawhorse_01` | **7** | Qoya chetida **zanjirband ulangan (`hideStartPost: true`)** 6 metrli himoya to‘siqlari, gulxan va dastgoh |
| **JAMI** | **8 turdagi GLB model** | **42** | **100% yerga moslangan, `0` daraxt/tosh/konteyner to‘qnashuvi** |

---

## 4. Fizika Kollayderlari va Chodir (`forest_tent_01`) Ochiq Kirish Arxitekturasi

[`src/shared/outdoor/outdoorColliders.ts`](file:///d:/Stickman-strike/src/shared/outdoor/outdoorColliders.ts) modulida har bir tashqi prop uchun aniq o‘lchamli va material tegli (`wood`, `metal`, `stone`) kollayderlar yaratildi:
1. **`forest_tent_01` (5 segmentli ochiq chodir kollayderi):**
   - Chodir yaxlit yopiq quti EMAS: `tent_wall_left_low`, `tent_wall_right_low`, `tent_wall_left_upper`, `tent_wall_right_upper` va `tent_back_gable` segmentlaridan iborat.
   - Chodirning old kirish qismi (`+Z`, `tent_entrance_anchor` = `(0, 0, +1.50)`) va ichki bo‘shlig‘i (`tent_inside_anchor` = `(0, 0.04, 0)`) `raycastWorld()` hamda o‘yinchi harakati uchun ochiq.
2. **`campfire_pit_01` (`step-able` past tosh halqa):**
   - Balandligi `0.24 m <= STEP_HEIGHT (0.45 m)`, radiusi `0.82 m` (`stone` material). O‘yinchi gulxan yonida tiqilib qolmasdan bemalol yura oladi va ustidan o‘ta oladi.
3. **`wooden_railing_01` (haqiqiy to‘siq):**
   - Balandligi `0.95 m > STEP_HEIGHT`. O‘yinchi oddiy yurish bilan to‘siqdan o‘tib keta olmaydi (`poi_cliff_watch` qoya chetini xavfsiz to‘sadi), lekin sakrab o‘tishi mumkin.
4. **Tik va yotqizilgan `rusty_barrel_01`:**
   - Tik bochka (`0.60 × 0.92 × 0.60 m`) va yotqizilgan bochka (`rotationZ = π/2` bo‘lganda `0.92 × 0.60 × 0.60 m`) avtomatik ravishda to‘g‘ri AABB o‘lcham oladi.

---

## 5. `InstancedMesh` Batching, O‘zbekcha Yo‘l Ko‘rsatkich Yozuvlari va Benchmark Natijalari

[`src/client/game/outdoor/OutdoorRenderer.ts`](file:///d:/Stickman-strike/src/client/game/outdoor/OutdoorRenderer.ts) barcha 42 ta tashqi obyektni model bo‘laklari bo‘yicha **atigi 16 ta `THREE.InstancedMesh` batch** orqali chizadi (`wooden_railing_01` ning `post_start` bo‘lagi `hideStartPost: true` bo‘lgan zanjirband segmentlarda avtomatik yashiriladi).

### 5.1. Performance Benchmark (`1280×720`, `DPR=1`, `quality='medium'`, `warmup=5s`, `duration=15s`, `repeats=2`)

| Sahna (Scenario) | FPS Mean | FPS Median | FPS P10 | 1% Low FPS | Frame Median (ms) | Frame P95 (ms) | Frame P99 (ms) | Draw Calls | Triangles | Outdoor Vis / Batches / ActiveCalls | Culling CPU Median (ms) | Heap (MB) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Stage 07-QA Baseline** (`forest_square`) | — | `200.00` | — | `20.92` | `5.000` | `34.000` | `47.800` | `146` | `605,175` | — | `0.1000` | `72.43` |
| `open_forest_movement` (Stage 08A) | `126.89` | `238.10` | `56.82` | `21.74` | `5.100` | `31.500` | `47.200` | `87` | `408,110` | `2 / 16 / 2` | `0.1000` | `66.36` |
| `poi_lumber_mill_outdoor` (Stage 08A) | `116.96` | `136.99` | `66.23` | `36.90` | `7.400` | `19.100` | `31.800` | `202` | `503,657` | `14 / 16 / 9` | `0.1000` | `74.67` |
| `poi_service_station_outdoor` (Stage 08A) | `94.58` | `109.89` | `64.52` | `21.32` | `9.300` | `21.500` | `47.700` | `215` | `577,169` | `13 / 16 / 12` | `0.1000` | `66.85` |
| `poi_forest_camp_outdoor` (Stage 08A) | `108.36` | `125.00` | `65.36` | `33.00` | `8.200` | `19.300` | `31.700` | `222` | `587,693` | `22 / 16 / 16` | `0.1000` | `72.12` |

### 5.2. 5× Consecutive Reload Memory & GPU Resource Disposal Check

| Ko‘rsatkich | Cycle 1 | Cycle 5 | Farq (Delta) | Holat |
|---|---:|---:|---:|---|
| `renderer.info.memory.geometries` | `155` | `155` | **`0`** | ✅ |
| `renderer.info.memory.textures` | `52` | `52` | **`0`** | ✅ |
| `WebGLPrograms` | `1` | `1` | **`0`** | ✅ |
| `JS Heap Used (MB)` | `68.58` | `69.44` | **`+0.86 MB`** | ✅ (`leakDetected: false`) |

---

## 6. Test Natijalari va Vizual Skrinshotlar (`docs/screenshots/stage08a/`)

1. **`npm run typecheck`**: `0` xato.
2. **`npm test`**: **14 ta test suite, 115 / 115 ta test PASS** (`duration_ms: 1917 ms`), jumladan yangi [`src/shared/__tests__/stage08a-outdoor.test.ts`](file:///d:/Stickman-strike/src/shared/__tests__/stage08a-outdoor.test.ts) dagi barcha 10 ta test toifasi.
3. **`npm run build`**: Production build muvaffaqiyatli (`dist/`).
4. **9 ta Haqiqiy `1280×720` PNG Skrinshot (`docs/screenshots/stage08a/`):**
   - [`01_topdown_256x256_stage08a_overview.png`](file:///d:/Stickman-strike/docs/screenshots/stage08a/01_topdown_256x256_stage08a_overview.png)
   - [`02_crossroads_wooden_signpost_uz.png`](file:///d:/Stickman-strike/docs/screenshots/stage08a/02_crossroads_wooden_signpost_uz.png)
   - [`03_poi1_ranger_house_railing_and_lumber.png`](file:///d:/Stickman-strike/docs/screenshots/stage08a/03_poi1_ranger_house_railing_and_lumber.png)
   - [`04_poi2_cabin_cluster_courtyard_campfire.png`](file:///d:/Stickman-strike/docs/screenshots/stage08a/04_poi2_cabin_cluster_courtyard_campfire.png)
   - [`05_poi3_lumber_mill_stacks_and_sawhorses.png`](file:///d:/Stickman-strike/docs/screenshots/stage08a/05_poi3_lumber_mill_stacks_and_sawhorses.png)
   - [`06_poi4_service_station_fuel_pumps_and_barrels.png`](file:///d:/Stickman-strike/docs/screenshots/stage08a/06_poi4_service_station_fuel_pumps_and_barrels.png)
   - [`07_poi5_forest_camp_tents_and_campfire.png`](file:///d:/Stickman-strike/docs/screenshots/stage08a/07_poi5_forest_camp_tents_and_campfire.png)
   - [`08_poi6_cliff_watch_chained_railings_and_fire.png`](file:///d:/Stickman-strike/docs/screenshots/stage08a/08_poi6_cliff_watch_chained_railings_and_fire.png)
   - [`09_survival_loot_and_combat_with_outdoor_props.png`](file:///d:/Stickman-strike/docs/screenshots/stage08a/09_survival_loot_and_combat_with_outdoor_props.png)
