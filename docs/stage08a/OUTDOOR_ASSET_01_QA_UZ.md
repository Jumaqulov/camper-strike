# BOSQICH 08A — `OUTDOOR-ASSET-01` 3D Tashqi Muhit Assetlari Binar QA Hisoboti

Ushbu hujjat **BOSQICH 08A (`OUTDOOR-ASSET-01` GLB Integration & QA)** doirasida `public/models/outdoor/` katalogiga joylashtirilgan **8 ta yangi `.glb` model** (`OUT-001` .. `OUT-008`), ularning rasmiy manifesti (`docs/stage08a/outdoor_asset_manifest.json`) hamda loyihadagi jami **36 ta `.glb` fayldan iborat to‘liq 3D assetlar inventarini** binar darajada tekshirish natijalarini o‘z ichiga oladi.

Avtomatlashtirilgan binar tekshiruv vositasi:
- **Validator skripti:** `tools/outdoor-validation/validateOutdoorAssets.mjs`
- **Generatsiya qilingan QA hisoboti (JSON):** `docs/stage08a/assets_qa.json`
- **Manba manifest:** `docs/stage08a/outdoor_asset_manifest.json`
- **Ishga tushirish buyrug‘i:** `node tools/outdoor-validation/validateOutdoorAssets.mjs`

---

## 1. Umumiy QA Xulosasi va Yig‘ma Ko‘rsatkichlar

| Ko‘rsatkich | Qiymat | Holat |
|---|---:|---|
| **Tekshirilgan `OUTDOOR-ASSET-01` GLB fayllari** | **8 ta** (`OUT-001` .. `OUT-008`) | **8 / 8 PASS** |
| **Jami tashqi muhit GLB hajmi (bayt)** | **702,280 B** (`685.82 KB`) | **100% mos (`bytesMatch: true`)** |
| **Jami uchburchaklar soni (`triangles`)** | **6,326 ta** | **100% mos (`trianglesMatch: true`)** |
| **Jami glTF vertex oqimi (`POSITION` count)** | **18,978 ta** (`6,326 × 3`) | **100% mos (`verticesMatch: true`)** |
| **Jami noyob geometrik vertexlar (`uniqueVertices`)** | **3,507 ta** | **Tasdiqlandi** |
| **Jami mesh primitivlari (`meshes`)** | **16 ta** | **100% mos (`meshNamesMatch: true`)** |
| **Maxsus anchor node'lar (`anchorNodes`)** | **7 ta** (`6` matn + `1` olov) | **100% mos (`anchorsValid: true`)** |
| **Vertex atributlari (`POSITION`, `NORMAL`, `COLOR_0`)** | **16 / 16 primitivda mavjud** (`VEC3:FLOAT`) | **100% PASS** |
| **Ichki kamera, chiroq, animatsiya, skin va teksturalar** | **`0` kamera, `0` chiroq, `0` animatsiya, `0` skin, `0` tekstura** | **100% Toza (`noCamerasLightsAnimationsSkins: true`)** |
| **Avvalgi bosqichlar GLB fayllari (`forest`, `weapons`, `buildings`, `interior`, `loot`)** | **28 ta** | **28 / 28 PASS** |
| **Loyiha bo‘yicha jami GLB fayllar inventari** | **36 ta** (`28 + 8`) | **36 / 36 PASS (`allPassed: true`)** |

### Binar darajada tasdiqlangan texnik talablar:
1. **glTF 2.0 Binar Header va Chunk tuzilishi:** Barcha 8 ta modelda 12-baytli sarlavha (`magic = 0x46546C67` / `"glTF"`, `version = 2`, `totalLength === fileSizeBytes`), birinchi `JSON` chunk (`0x4E4F534A`) va ikkinchi `BIN\0` chunk (`0x004E4942`) baytma-bayt tekshirildi va manifestdagi `verification.glbBytes` qiymati bilan 100% ustma-ust tushdi.
2. **Vertex atributlari va Accessor `min`/`max` haqqoniyligi:** Barcha 16 ta mesh primitivida `POSITION` (`VEC3:FLOAT`), `NORMAL` (`VEC3:FLOAT`) va vertex ranglari `COLOR_0` (`VEC3:FLOAT`) mavjud. Har bir accessorning JSON dagi `min`/`max` chegaralari `BIN` buferdagi haqiqiy 32-bit float qiymatlardan hisoblangan minimum va maksimumlar bilan `1e-4` aniqlikda to‘liq mos keldi (`accessorMinMaxMatch: true`).
3. **Ortiqcha obyektlardan xolilik:** Hech bir GLB faylda eksportdan qolib ketgan `cameras`, `lights` (`KHR_lights_punctual`), `animations`, `skins`, `textures` yoki `images` yo‘q (`0`). Barcha modellar sof vertex-color (`COLOR_0`) va PBR materiallar asosida ishlaydi.

---

## 2. Barcha 8 ta `OUTDOOR-ASSET-01` GLB Modelining Yig‘ma Jadvali

| Kod | Asset Nomi (`assetId`) | Public URL | Hajmi (Bayt) | O‘lcham `X × Y × Z` (m) | Bounds Min `[x, y, z]` | Bounds Max `[x, y, z]` | Yerga Kirish (`minY`) | Tris | Verts (glTF / Unique) | Materiallar (GLB $\rightarrow$ Runtime) | Meshlar Soni | Anchor Node'lar | Holat |
|---|---|---|---:|---|---|---|---:|---:|---:|---|---:|---:|---|
| `OUT-001` | `wooden_signpost_01` | `/models/outdoor/wooden_signpost_01.glb` | 66,664 | `1.345 × 2.120 × 0.811` | `[-0.623, -0.05, -0.562]` | `[0.722, 2.07, 0.249]` | `-0.050 m` | 586 | `1,758` / `323` | `wood`, `rock` (`stone`) | 2 | 6 (`sign_1..3_text_*`) | **PASS** |
| `OUT-002` | `lumber_stack_01` | `/models/outdoor/lumber_stack_01.glb` | 75,640 | `2.269 × 1.106 × 1.390` | `[-1.129, -0.103, -0.695]` | `[1.14, 1.003, 0.695]` | `-0.103 m` | 688 | `2,064` / `372` | `wood` | 1 | 0 | **PASS** |
| `OUT-003` | `sawhorse_01` | `/models/outdoor/sawhorse_01.glb` | 54,024 | `1.558 × 1.028 × 0.833` | `[-0.779, -0.011, -0.418]` | `[0.779, 1.016, 0.415]` | `-0.011 m` | 480 | `1,440` / `282` | `wood`, `iron` | 2 | 0 | **PASS** |
| `OUT-004` | `old_fuel_pump_01` | `/models/outdoor/old_fuel_pump_01.glb` | 166,236 | `0.740 × 1.600 × 0.600` | `[-0.35, 0, -0.3]` | `[0.39, 1.6, 0.3]` | `0.000 m` | 1,510 | `4,530` / `814` | `painted_metal`, `iron`, `rock` (`stone`) | 3 | 0 | **PASS** |
| `OUT-005` | `rusty_barrel_01` | `/models/outdoor/rusty_barrel_01.glb` | 99,760 | `0.596 × 0.895 × 0.581` | `[-0.298, 0, -0.291]` | `[0.298, 0.895, 0.291]` | `0.000 m` | 912 | `2,736` / `494` | `painted_metal` | 1 | 0 | **PASS** |
| `OUT-006` | `forest_tent_01` | `/models/outdoor/forest_tent_01.glb` | 58,760 | `2.193 × 1.678 × 2.615` | `[-1.097, -0.048, -1.332]` | `[1.097, 1.63, 1.283]` | `-0.048 m` | 524 | `1,572` / `338` | `fabric`, `wood` | 2 | 0 | **PASS** |
| `OUT-007` | `campfire_pit_01` | `/models/outdoor/campfire_pit_01.glb` | 160,364 | `1.368 × 0.405 × 1.371` | `[-0.683, -0.02, -0.683]` | `[0.685, 0.385, 0.689]` | `-0.020 m` | 1,462 | `4,386` / `784` | `rock` (`stone`), `wood` | 2 | 1 (`fire_anchor`) | **PASS** |
| `OUT-008` | `wooden_railing_01` | `/models/outdoor/wooden_railing_01.glb` | 20,832 | `3.060 × 1.350 × 0.161` | `[-1.56, -0.15, -0.06]` | `[1.5, 1.2, 0.101]` | `-0.150 m` | 164 | `492` / `100` | `wood`, `iron` | 3 | 0 | **PASS** |
| **JAMI** | **8 ta model** | — | **702,280 B** | — | — | — | — | **6,326** | **18,978 / 3,507** | **5 xil PBR material** | **16** | **7** | **100% PASS** |

---

## 3. 16 ta Mesh Primitivining Detallangan Geometriya Jadvali

Har bir model ichidagi mesh node'lari `outdoor_asset_manifest.json` bilan nomma-nom va tartib bo‘yicha tekshirildi:

| # | Model (`assetId`) | Mesh Node Nomi (`nodeName`) | Material | Tris | glTF Verts | Unique Verts | Mesh Bounds Min `[x, y, z]` | Mesh Bounds Max `[x, y, z]` | Mesh O‘lchami `X × Y × Z` (m) | `POSITION` / `NORMAL` / `COLOR_0` |
|---:|---|---|---|---:|---:|---:|---|---|---|---|
| 1 | `wooden_signpost_01` | `wooden_signpost_01_wood` | `wood` | 266 | 798 | 155 | `[-0.623, -0.05, -0.562]` | `[0.722, 2.07, 0.208]` | `1.345 × 2.120 × 0.770` | `true` / `true` / `true` |
| 2 | `wooden_signpost_01` | `wooden_signpost_01_rocks` | `rock` | 320 | 960 | 168 | `[-0.285, -0.02, -0.25]` | `[0.29, 0.156, 0.249]` | `0.575 × 0.176 × 0.499` | `true` / `true` / `true` |
| 3 | `lumber_stack_01` | `lumber_stack_01_wood` | `wood` | 688 | 2,064 | 372 | `[-1.129, -0.103, -0.695]` | `[1.14, 1.003, 0.695]` | `2.269 × 1.106 × 1.390` | `true` / `true` / `true` |
| 4 | `sawhorse_01` | `sawhorse_01_wood` | `wood` | 240 | 720 | 138 | `[-0.779, -0.011, -0.418]` | `[0.779, 1.016, 0.415]` | `1.558 × 1.028 × 0.833` | `true` / `true` / `true` |
| 5 | `sawhorse_01` | `sawhorse_01_metal` | `iron` | 240 | 720 | 144 | `[-0.681, 0.089, -0.401]` | `[0.681, 0.65, 0.401]` | `1.362 × 0.561 × 0.803` | `true` / `true` / `true` |
| 6 | `old_fuel_pump_01` | `old_fuel_pump_01_body` | `painted_metal` | 1,230 | 3,690 | 654 | `[-0.27, 0.08, -0.2]` | `[0.39, 1.6, 0.2]` | `0.660 × 1.520 × 0.400` | `true` / `true` / `true` |
| 7 | `old_fuel_pump_01` | `old_fuel_pump_01_metal` | `iron` | 164 | 492 | 100 | `[-0.2, 0.84, -0.04]` | `[0.335, 1.16, 0.2]` | `0.535 × 0.320 × 0.240` | `true` / `true` / `true` |
| 8 | `old_fuel_pump_01` | `old_fuel_pump_01_base` | `rock` | 116 | 348 | 60 | `[-0.35, 0, -0.3]` | `[0.35, 0.08, 0.3]` | `0.700 × 0.080 × 0.600` | `true` / `true` / `true` |
| 9 | `rusty_barrel_01` | `rusty_barrel_01_body` | `painted_metal` | 912 | 2,736 | 494 | `[-0.298, 0, -0.291]` | `[0.298, 0.895, 0.291]` | `0.596 × 0.895 × 0.581` | `true` / `true` / `true` |
| 10 | `forest_tent_01` | `forest_tent_01_fabric` | `fabric` | 360 | 1,080 | 238 | `[-1.02, 0, -1.326]` | `[1.02, 1.6, 1.276]` | `2.040 × 1.600 × 2.602` | `true` / `true` / `true` |
| 11 | `forest_tent_01` | `forest_tent_01_poles` | `wood` | 164 | 492 | 100 | `[-1.097, -0.048, -1.332]` | `[1.097, 1.63, 1.283]` | `2.193 × 1.678 × 2.615` | `true` / `true` / `true` |
| 12 | `campfire_pit_01` | `campfire_pit_01_stones` | `rock` | 1,174 | 3,522 | 628 | `[-0.683, -0.02, -0.683]` | `[0.685, 0.24, 0.689]` | `1.368 × 0.260 × 1.371` | `true` / `true` / `true` |
| 13 | `campfire_pit_01` | `campfire_pit_01_logs` | `wood` | 288 | 864 | 156 | `[-0.291, 0.007, -0.281]` | `[0.292, 0.385, 0.281]` | `0.583 × 0.378 × 0.561` | `true` / `true` / `true` |
| 14 | `wooden_railing_01` | `wooden_railing_01_body` | `wood` | 72 | 216 | 44 | `[-1.5, -0.15, -0.06]` | `[1.5, 1.2, 0.095]` | `3.000 × 1.350 × 0.155` | `true` / `true` / `true` |
| 15 | `wooden_railing_01` | `railing_post_start` | `wood` | 12 | 36 | 8 | `[-1.56, -0.15, -0.06]` | `[-1.44, 1.13, 0.06]` | `0.120 × 1.280 × 0.120` | `true` / `true` / `true` |
| 16 | `wooden_railing_01` | `wooden_railing_01_metal` | `iron` | 80 | 240 | 48 | `[-0.041, 0.349, 0.095]` | `[0.041, 0.781, 0.101]` | `0.082 × 0.432 × 0.006` | `true` / `true` / `true` |

---

## 4. PBR Materiallar Katalogi va Parametrlari

`OUTDOOR-ASSET-01` to‘plamida jami **5 xil PBR material** ishlatilgan bo‘lib, barcha modellarda `metallicFactor` va `roughnessFactor` qiymatlari o‘zaro 100% bir xil:

| GLB Material Nomi | Runtime Alias (`contracts.ts`) | `metallicFactor` | `roughnessFactor` | `doubleSided` | Ishlatilgan Modellar (`assetId`) |
|---|---|---:|---:|---|---|
| `wood` | `wood` | `0.00` | `0.88` | `false` | `wooden_signpost_01`, `lumber_stack_01`, `sawhorse_01`, `forest_tent_01`, `campfire_pit_01`, `wooden_railing_01` |
| `rock` | `stone` | `0.00` | `0.93` | `false` | `wooden_signpost_01`, `old_fuel_pump_01`, `campfire_pit_01` |
| `iron` | `iron` | `0.45` | `0.60` | `false` | `sawhorse_01`, `old_fuel_pump_01`, `wooden_railing_01` |
| `painted_metal` | `painted_metal` | `0.25` | `0.72` | `false` | `old_fuel_pump_01`, `rusty_barrel_01` |
| `fabric` | `fabric` | `0.00` | `0.97` | `false` | `forest_tent_01` |

> [!NOTE]
> **Material nomlanishi (`rock` $\leftrightarrow$ `stone`):** GLB fayllar va `outdoor_asset_manifest.json` ichida tosh/beton materiali `"rock"` deb nomlangan, TypeScript kontraktlarida (`OutdoorMaterialName`) esa `"stone"` sifatida yuritiladi. Validator har ikkala nomlanishni va ularning PBR koeffitsiyentlarini (`roughness: 0.93`, `metalness: 0.0`) avtomatik ravishda tasdiqlaydi.

---

## 5. Maxsus Anchor Node'lar va Muhandislik QA Tahlili

### 5.1. `wooden_signpost_01.glb` (`OUT-001`) — 6 ta Yo‘l Ko‘rsatkich Matn Anchorlari
`wooden_signpost_01.glb` ichida 3 ta ko‘rsatkich taxtachasining old va orqa yuzalari uchun jami **6 ta bo‘sh anchor node** (`node.matrix` 4×4 ustun-ustuvor matritsa ko‘rinishida) joylashtirilgan. Node'ning lokal `+X` o‘qi matn yozuv yo‘nalishini, `+Z` o‘qi esa o‘quvchiga qaragan normalni ifodalaydi:

| Anchor Node Nomi | Taxtacha | Tomoni | Lokal Pozitsiya `[x, y, z]` (m) | Lokal Quaternion `[x, y, z, w]` | Matn Maydoni (`width × height`) | Manifest Mosligi |
|---|---:|---|---|---|---|---|
| `sign_1_text_front` | 1 (yuqori) | Old (`front`) | `[0.340, 1.720, -0.004]` | `[0, 0.125, 0, 0.992]` | `0.50 × 0.12 m` | **PASS** |
| `sign_1_text_back` | 1 (yuqori) | Orqa (`back`) | `[0.330, 1.720, -0.043]` | `[0, 0.992, 0, -0.125]` | `0.50 × 0.12 m` | **PASS** |
| `sign_2_text_front` | 2 (o‘rta) | Old (`front`) | `[-0.298, 1.500, 0.039]` | `[0, 0.980, 0, -0.199]` | `0.42 × 0.12 m` | **PASS** |
| `sign_2_text_back` | 2 (o‘rta) | Orqa (`back`) | `[-0.283, 1.500, 0.076]` | `[0, 0.199, 0, 0.980]` | `0.42 × 0.12 m` | **PASS** |
| `sign_3_text_front` | 3 (pastki) | Old (`front`) | `[0.135, 1.280, -0.236]` | `[0, 0.625, 0, 0.781]` | `0.36 × 0.12 m` | **PASS** |
| `sign_3_text_back` | 3 (pastki) | Orqa (`back`) | `[0.096, 1.280, -0.245]` | `[0, -0.781, 0, 0.625]` | `0.36 × 0.12 m` | **PASS** |

- **Collider arxitekturasi:** Faqatgina markaziy ustun uchun `[0, 1.0, 0]` markazli `0.14 × 2.00 × 0.14 m` box collider berilgan; yuqoridagi taxtachalar o‘yinchi harakatiga xalaqit bermaydi.

### 5.2. `campfire_pit_01.glb` (`OUT-007`) — `fire_anchor` Olov va Yorug‘lik Nuqtasi
- **Anchor Node:** `fire_anchor` node'i `node.matrix` orqali lokal **`[0, 0.15, 0]`** koordinatada va `[0, 0, 0, 1]` ayniy quaternion bilan joylashgan (`positionMatch: true`, `quaternionMatch: true`).
- **Qo‘llanilishi:** Runtime'da gulxan olovi (low-poly flame mesh), tutun zarralari va nuqtaviy yorug‘lik (`PointLight`) aynan shu `fire_anchor` (`y = 0.15 m`) tuguniga biriktiriladi.
- **Colliderlar:**
  1. Tosh halqa uchun pastki jismoniy to‘siq: `cylinder` (`center: [0, 0.10, 0]`, `radius: 0.60 m`, `height: 0.20 m`).
  2. Issiqlik / olov trigger zonasi: `cylinder` (`center: [0, 0.25, 0]`, `radius: 0.35 m`, `height: 0.50 m`).

### 5.3. `wooden_railing_01.glb` (`OUT-008`) — `3.0 m` Modulli Zanjir va `railing_post_start`
- **Modulli qadam (`3.0 m`):** `wooden_railing_01_body` meshi `x ∈ [-1.500, +1.500] m` (`spanX = 3.000 m`) oralig‘ini egallaydi va o‘ng uchida (`x = +1.50 m`) oxirgi ustunga ega.
- **Alohida boshlang‘ich ustun (`railing_post_start`):** Chap uchdagi ustun (`x ∈ [-1.560, -1.440] m`, markazi `x = -1.500 m`, o‘lchami `0.12 × 1.28 × 0.12 m`, 12 uchburchak) alohida mesh sifatida ajratilgan.
- **Uzluksiz ulash qoidasi:** Bir nechta panjara ketma-ket `3.0 m` qadam bilan ulanganda, 1-segmentdan keyingi barcha segmentlarda `railing_post_start` meshini yashirish (`hideStartPost: true`) orqali qo‘shaloq ustunlar ustma-ust tushishi (z-fighting) to‘liq bartaraf etiladi.

### 5.4. `forest_tent_01.glb` (`OUT-006`) — Ichiga Engashib Kiriladigan Chodir
- **Geometriya:** Tizmasi `Z` o‘qi bo‘ylab yo‘nalgan (`2.193 × 1.678 × 2.615 m`), kirish qismi `+Z` tomonda ochiq.
- **Colliderlar:** Chap qiyalik (`rotation.z = -0.588 rad`), o‘ng qiyalik (`rotation.z = +0.588 rad`) va orqa `-Z` devor (`z = -1.20 m`) alohida 3 ta quti collider bilan berilgan bo‘lib, chodir ichida `1.40 × 2.30 m` maydon va `1.55 m` balandlikdagi bo‘shliq o‘yinchining engashib (`crouch`) kirishi hamda yashirinishi uchun ochiq.

---

## 6. Loyiha Bo‘yicha To‘liq 36 ta GLB Fayl Inventari

Stage 08A yakunida `public/models/` ostidagi barcha **6 ta katalog** bo‘yicha jami **36 ta `.glb` fayl** mavjudligi va har birining glTF 2.0 binar sarlavhasi yaroqli ekanligi tasdiqlandi:

| Katalog (`public/models/...`) | To‘plam (Asset Pack) | Kutilgan Soni | Tasdiqlangan Soni | Fayllar Ro‘yxati | Jami Hajmi (Bayt) | Holat |
|---|---|---:|---:|---|---:|---|
| `public/models/forest/` | `FOREST-ASSET-01` | 7 | **7** | `birch_tree_01.glb`, `dead_tree_01.glb`, `forest_bush_01.glb`, `forest_rock_01.glb`, `pine_tree_01.glb`, `pine_tree_02.glb`, `spruce_tree_01.glb` | 534,356 B | **7 / 7 PASS** |
| `public/models/weapons/` | `WEAPON-ASSET-01` | 4 | **4** | `ak47.glb`, `awp.glb`, `pistol.glb`, `shotgun.glb` | 2,987,728 B | **4 / 4 PASS** |
| `public/models/buildings/` | `BUILDING-ASSET-01` | 8 | **8** | `wood_door_01.glb`, `wood_floor_01.glb`, `wood_roof_gable_01.glb`, `wood_roof_slope_01.glb`, `wood_stairs_01.glb`, `wood_wall_01.glb`, `wood_wall_door_01.glb`, `wood_wall_window_01.glb` | 860,192 B | **8 / 8 PASS** |
| `public/models/interior/` | `INTERIOR-ASSET-01` | 6 | **6** | `kitchen_cabinet_01.glb`, `old_bed_01.glb`, `old_sofa_01.glb`, `wooden_chair_01.glb`, `wooden_shelf_01.glb`, `wooden_table_01.glb` | 403,192 B | **6 / 6 PASS** |
| `public/models/loot/` | `LOOT-ASSET-01` | 3 | **3** | `metal_locker_01.glb`, `old_toolbox_01.glb`, `wooden_loot_crate_01.glb` | 387,000 B | **3 / 3 PASS** |
| `public/models/outdoor/` | `OUTDOOR-ASSET-01` | 8 | **8** | `wooden_signpost_01.glb`, `lumber_stack_01.glb`, `sawhorse_01.glb`, `old_fuel_pump_01.glb`, `rusty_barrel_01.glb`, `forest_tent_01.glb`, `campfire_pit_01.glb`, `wooden_railing_01.glb` | 702,280 B | **8 / 8 PASS** |
| **JAMI** | **6 ta to‘plam** | **36** | **36** | **Barcha 36 ta `.glb` fayl mavjud va binar validatsiyadan o‘tdi** | **5,874,748 B (`5.60 MB`)** | **36 / 36 PASS** |
