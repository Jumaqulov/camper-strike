# BOSQICH 04A — 3D Assetlar va Manifestlar Binar QA Hisoboti

Ushbu hujjat **BOSQICH 04A (Assets QA)** doirasida `BUILDING-ASSET-01` (8 ta GLB), `LOOT-ASSET-01` (3 ta GLB) va `INTERIOR-ASSET-01` (6 ta GLB) to‘plamlaridagi jami **17 ta `.glb` model**, ularning xomaki manifestlari (`*.json`), qo‘llanmalari (`README.md`) va namuna joylashuv fayllarini (`examples/*.json`) binar darajada tekshirish hamda normallashtirish natijalarini o‘z ichiga oladi.

Avtomatlashtirilgan binar tekshiruv skripti:
- **Skript:** `tools/asset-validation/validate-stage04a-assets.mjs`
- **Generatsiya qilingan normallashtirilgan manifest:** `docs/stage04a/assets_manifest_normalized.json`
- **Ishga tushirish buyrug‘i:** `node tools/asset-validation/validate-stage04a-assets.mjs`

---

## 1. Umumiy QA Xulosasi va Yig‘ma Ko‘rsatkichlar

| Ko‘rsatkich | BUILDING-ASSET-01 | LOOT-ASSET-01 | INTERIOR-ASSET-01 | JAMI (17 ta GLB) |
|---|---:|---:|---:|---:|
| **GLB fayllar soni** | 8 ta | 3 ta | 6 ta | **17 ta** |
| **Jami fayl hajmi (bayt)** | 860,192 B (840.0 KB) | 387,000 B (377.9 KB) | 403,192 B (393.7 KB) | **1,650,384 B (1.57 MB)** |
| **Jami uchburchaklar (triangles)** | 7,824 | 3,472 | 3,612 | **14,908** |
| **Jami vertexlar (vertices)** | 23,472 | 10,416 | 10,836 | **44,724** |
| **Statik mesh node'lar** | 12 ta | 6 ta | 8 ta | **26 ta** |
| **Harakatlanuvchi pivot node'lar** | 1 ta (`wood_door_01`) | 3 ta (barcha 3 modelda) | 2 ta (`kitchen_cabinet_01`) | **6 ta** |
| **Harakatlanuvchi mesh node'lar** | 2 ta | 6 ta | 4 ta | **12 ta** |
| **Buyum qo‘yish yuzalari (`placeableSurfaces`)** | 1 ta (`wood_floor_01`) | 0 ta (ichki `interiorVolume` bor) | 12 ta | **13 ta** |
| **Buyum anchor nuqtalari (`itemAnchors`)** | 0 ta | 0 ta | 30 ta | **30 ta** |
| **Binar glTF 2.0 validatsiyasi** | **100% PASS** | **100% PASS** | **100% PASS** | **17 / 17 PASS** |

### Binar darajada tasdiqlangan texnik talablar:
1. **glTF 2.0 Header va Chunk butunligi:** Barcha 17 ta faylda `magic = 0x46546C67` (`"glTF"`), `version = 2`, `totalLength === fileSizeBytes`, birinchi chunk `JSON` (`0x4E4F534A`) va ikkinchi chunk `BIN\0` (`0x004E4942`) ekanligi baytma-bayt tasdiqlandi.
2. **Xomaki (`docs/assets/raw/...`) va ommaviy (`public/models/...`) fayllar mosligi:** Har bir faylning `SHA-256` xesh qiymati xomaki manba bilan **100% bir xil** (`rawGlbIdentical: true`).
3. **Vertex atributlari va Accessor `min`/`max` aniqligi:** Barcha 38 ta mesh primitivida `POSITION` (`VEC3:FLOAT`), `NORMAL` (`VEC3:FLOAT`) va `COLOR_0` (`VEC3:FLOAT`) atributlari mavjud. Har bir accessorning JSON dagi `min`/`max` chegaralari `BIN` buferdagi haqiqiy float qiymatlardan hisoblangan minimum va maksimumlar bilan `1e-4` aniqlikda to‘liq ustma-ust tushdi (`accessorMinMaxMatch: true`).
4. **Kamera, chiroq va tashqi teksturalar yo‘qligi:** Hech bir GLB faylda `cameras`, `lights` (`KHR_lights_punctual`), `textures` yoki `images` mavjud emas (`noCamerasOrLights: true`, `noExternalTextures: true`). Barcha ranglar vertex color (`COLOR_0`) orqali berilgan.
5. **Umumiy PBR materiallar (5 xil):**
   - `wood`: `metallicFactor = 0.0`, `roughnessFactor = 0.88`
   - `roof`: `metallicFactor = 0.0`, `roughnessFactor = 0.92`
   - `iron`: `metallicFactor = 0.45`, `roughnessFactor = 0.60`
   - `painted_metal`: `metallicFactor = 0.25`, `roughnessFactor = 0.72`
   - `fabric`: `metallicFactor = 0.0`, `roughnessFactor = 0.97`

---

## 2. Barcha 17 ta GLB Modelning Yagona Jadvali

| # | Asset ID | To‘plam (Pack) | Public URL | Hajmi (Bayt) | O‘lcham X×Y×Z (m) | Bounds Min `[x, y, z]` | Bounds Max `[x, y, z]` | Tris | Verts | Materiallar | Statik Meshlar | Pivotlar | Holat |
|---|---|---|---|---:|---|---|---|---:|---:|---|---|---|---|
| 1 | `wood_wall_01` | `BUILDING-ASSET-01` | `/models/buildings/wood_wall_01.glb` | 93,624 | `4.12 × 3.20 × 0.24` | `[-2.12, -0.2, -0.12]` | `[2, 3, 0.12]` | 848 | 2,544 | `wood` | `wood_wall_01_body`, `corner_post` | — | **PASS** |
| 2 | `wood_wall_window_01` | `BUILDING-ASSET-01` | `/models/buildings/wood_wall_window_01.glb` | 159,408 | `4.12 × 3.20 × 0.36` | `[-2.12, -0.2, -0.13]` | `[2, 3, 0.23]` | 1,448 | 4,344 | `wood`, `iron` | `wood_wall_window_01_body`, `corner_post`, `wood_wall_window_01_iron` | — | **PASS** |
| 3 | `wood_wall_door_01` | `BUILDING-ASSET-01` | `/models/buildings/wood_wall_door_01.glb` | 130,360 | `4.12 × 3.20 × 0.272` | `[-2.12, -0.2, -0.13]` | `[2, 3, 0.142]` | 1,188 | 3,564 | `wood` | `wood_wall_door_01_body`, `corner_post` | — | **PASS** |
| 4 | `wood_floor_01` | `BUILDING-ASSET-01` | `/models/buildings/wood_floor_01.glb` | 72,448 | `4.00 × 0.202 × 4.00` | `[-2, -0.2, -2]` | `[2, 0.002, 2]` | 660 | 1,980 | `wood` | `wood_floor_01_body` | — | **PASS** |
| 5 | `wood_roof_slope_01` | `BUILDING-ASSET-01` | `/models/buildings/wood_roof_slope_01.glb` | 170,672 | `4.00 × 2.089 × 2.53` | `[-2, -0.45, -0.084]` | `[2, 1.639, 2.446]` | 1,560 | 4,680 | `wood`, `roof` | `wood_roof_slope_01_frame`, `wood_roof_slope_01_shingles` | — | **PASS** |
| 6 | `wood_roof_gable_01` | `BUILDING-ASSET-01` | `/models/buildings/wood_roof_gable_01.glb` | 97,580 | `4.82 × 2.145 × 0.24` | `[-2.41, -0.463, -0.08]` | `[2.41, 1.683, 0.16]` | 892 | 2,676 | `wood` | `wood_roof_gable_01_body` | — | **PASS** |
| 7 | `wood_door_01` | `BUILDING-ASSET-01` | `/models/buildings/wood_door_01.glb` | 45,456 | `1.787 × 2.35 × 0.14` | `[-0.91, 0.035, -0.07]` | `[0.877, 2.385, 0.07]` | 400 | 1,200 | `wood`, `iron` | *(yo‘q — barchasi pivot ichida)* | `door_pivot` | **PASS** |
| 8 | `wood_stairs_01` | `BUILDING-ASSET-01` | `/models/buildings/wood_stairs_01.glb` | 90,644 | `1.33 × 4.006 × 4.036` | `[-0.66, -0.006, -4.006]` | `[0.67, 4, 0.03]` | 828 | 2,484 | `wood` | `wood_stairs_01_body` | — | **PASS** |
| 9 | `wooden_loot_crate_01` | `LOOT-ASSET-01` | `/models/loot/wooden_loot_crate_01.glb` | 127,128 | `1.005 × 0.606 × 0.646` | `[-0.502, 0, -0.317]` | `[0.502, 0.606, 0.328]` | 1,140 | 3,420 | `wood`, `iron` | `crate_body`, `crate_body_metal` | `lid_pivot` | **PASS** |
| 10 | `metal_locker_01` | `LOOT-ASSET-01` | `/models/loot/metal_locker_01.glb` | 155,848 | `0.91 × 1.80 × 0.56` | `[-0.455, 0, -0.255]` | `[0.455, 1.8, 0.305]` | 1,406 | 4,218 | `painted_metal`, `iron` | `locker_body`, `locker_body_metal` | `door_pivot` | **PASS** |
| 11 | `old_toolbox_01` | `LOOT-ASSET-01` | `/models/loot/old_toolbox_01.glb` | 104,024 | `0.607 × 0.30 × 0.319` | `[-0.303, 0, -0.157]` | `[0.303, 0.3, 0.162]` | 926 | 2,778 | `painted_metal`, `iron` | `toolbox_body`, `toolbox_body_metal` | `lid_pivot` | **PASS** |
| 12 | `wooden_table_01` | `INTERIOR-ASSET-01` | `/models/interior/wooden_table_01.glb` | 32,320 | `1.408 × 0.75 × 0.796` | `[-0.704, 0, -0.398]` | `[0.705, 0.75, 0.398]` | 288 | 864 | `wood` | `wooden_table_01_body` | — | **PASS** |
| 13 | `wooden_chair_01` | `INTERIOR-ASSET-01` | `/models/interior/wooden_chair_01.glb` | 44,872 | `0.46 × 0.899 × 0.524` | `[-0.23, -0.002, -0.297]` | `[0.23, 0.897, 0.227]` | 404 | 1,212 | `wood` | `wooden_chair_01_body` | — | **PASS** |
| 14 | `wooden_shelf_01` | `INTERIOR-ASSET-01` | `/models/interior/wooden_shelf_01.glb` | 48,328 | `1.04 × 1.803 × 0.42` | `[-0.52, -0.003, -0.21]` | `[0.52, 1.8, 0.21]` | 436 | 1,308 | `wood` | `wooden_shelf_01_body` | — | **PASS** |
| 15 | `old_bed_01` | `INTERIOR-ASSET-01` | `/models/interior/old_bed_01.glb` | 92,664 | `2.02 × 0.65 × 0.97` | `[-1.01, 0, -0.485]` | `[1.01, 0.65, 0.485]` | 838 | 2,514 | `wood`, `fabric` | `old_bed_01_frame`, `old_bed_01_fabric` | — | **PASS** |
| 16 | `old_sofa_01` | `INTERIOR-ASSET-01` | `/models/interior/old_sofa_01.glb` | 105,692 | `1.70 × 0.902 × 0.80` | `[-0.85, 0, -0.4]` | `[0.85, 0.902, 0.4]` | 958 | 2,874 | `wood`, `fabric` | `old_sofa_01_legs`, `old_sofa_01_fabric` | — | **PASS** |
| 17 | `kitchen_cabinet_01` | `INTERIOR-ASSET-01` | `/models/interior/kitchen_cabinet_01.glb` | 79,316 | `1.24 × 0.903 × 0.575` | `[-0.62, -0.003, -0.278]` | `[0.62, 0.9, 0.297]` | 688 | 2,064 | `wood`, `iron` | `kitchen_cabinet_01_body` | `door_left_pivot`, `door_right_pivot` | **PASS** |

---

## 3. Pivot Node'lar, glTF `node.matrix` Xususiyati va Ochilish Burchaklari Tahlili

### 3.1. Binar glTF `node.matrix` muhim eslatmasi
Binar tahlil davomida aniqlandiki, barcha 5 ta harakatlanuvchi modelda (`wood_door_01`, `wooden_loot_crate_01`, `metal_locker_01`, `old_toolbox_01`, `kitchen_cabinet_01`) pivot node'larining lokal siljishi (`translation`) glTF JSON ichida `node.translation` maydonida emas, balki 16 elementli ustun-ustuvor (`column-major`) **`node.matrix`** massivining `12, 13, 14`-indekslarida (`[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]`) saqlangan:
- **Three.js `GLTFLoader` bilan moslik:** `GLTFLoader` `node.matrix` ni yuklaganda avtomatik ravishda `matrix.decompose(object.position, object.quaternion, object.scale)` chaqiradi, shuning uchun runtime'da `pivot.position` to‘g‘ridan-to‘g‘ri `(tx, ty, tz)` ga teng bo‘ladi va `pivot.rotation[axis] = angle` kutilganidek ilgak chizig‘i atrofida aylanadi.
- **Binar parserlar uchun talab:** Maxsus binar parser yoki server-side validator yozilganda faqat `node.translation` ga emas, balki `node.matrix[12..14]` ga ham qarash shart (`validate-stage04a-assets.mjs` da `extractNodeTranslation()` funksiyasi aynan shunday ishlaydi).

### 3.2. Barcha 6 ta Pivotning Burchak va Siljish Jadvali

| Model (`assetId`) | Pivot Node nomi | Lokal Pozitsiya `[x, y, z]` (m) | Aylanish O‘qi | Yopiq (rad) | Ochiq (rad) | Ochiq (gradus) | Harakatlanuvchi Meshlar | `Box3` Markaz Siljishi | Ochilish Yo‘nalishi va Ishora Qoidasi |
|---|---|---|---|---:|---:|---:|---|---:|---|
| `wood_door_01` | `door_pivot` | `[-0.88, 0, 0]` | `y` | `0` | **`+1.45`** | `+83.08°` | `door_leaf`, `door_hardware` | `1.149 m` | **Musbat (+Y):** Eshik chap ilgak chizig‘i atrofida uy ichkarisiga (`-Z` tomonga) ochiladi. *(Namuna xonada `1.35 rad` ham ishlatilgan).* |
| `wooden_loot_crate_01` | `lid_pivot` | `[0, 0.46, -0.3]` | `x` | `0` | **`-1.92`** | `-110.0°` | `crate_lid`, `crate_lid_metal` | `0.493 m` | **Manfiy (-X):** Qopqoq orqa ilgak chizig‘i atrofida yuqoriga va orqaga (`-Z`) ochiladi. |
| `metal_locker_01` | `door_pivot` | `[-0.43, 0, 0.25]` | `y` | `0` | **`-1.75`** | `-100.0°` | `locker_door`, `locker_door_hardware` | `0.646 m` | **Manfiy (-Y):** Eshik chap ilgak chizig‘i atrofida tashqariga (`+Z`) va chapga ochiladi. |
| `old_toolbox_01` | `lid_pivot` | `[0, 0.2, -0.15]` | `x` | `0` | **`-1.92`** | `-110.0°` | `toolbox_lid`, `toolbox_lid_metal` | `0.261 m` | **Manfiy (-X):** Qopqoq orqa ilgak chizig‘i atrofida yuqoriga va orqaga (`-Z`) ochiladi. |
| `kitchen_cabinet_01` | `door_left_pivot` | `[-0.585, 0, 0.255]` | `y` | `0` | **`-1.75`** | `-100.0°` | `door_left`, `door_left_hardware` | `0.429 m` | **Manfiy (-Y):** Chap eshik chap ilgak chizig‘i atrofida tashqariga (`+Z`) va chapga ochiladi. |
| `kitchen_cabinet_01` | `door_right_pivot` | `[0.585, 0, 0.255]` | `y` | `0` | **`+1.75`** | `+100.0°` | `door_right`, `door_right_hardware` | `0.429 m` | **Musbat (+Y):** O‘ng eshik o‘ng ilgak chizig‘i atrofida tashqariga (`+Z`) va o‘ngga ochiladi. |

> [!WARNING]
> **Pivot burchak ishoralari haqida ogohlantirish:**
> - `wood_door_01` (`+1.45 rad`) va `kitchen_cabinet_01` ning `door_right_pivot` (`+1.75 rad`) eshiklari **musbat** burchakda ochiladi.
> - `LOOT-ASSET-01` dagi barcha 3 konteyner (`-1.92`, `-1.75`, `-1.92 rad`) hamda `kitchen_cabinet_01` ning `door_left_pivot` (`-1.75 rad`) eshigi **manfiy** burchakda ochiladi.
> - Agar ishora teskari berilsa, eshik yoki qopqoq korpusning ichiga kirib ketadi (clipping). Har doim `assets_manifest_normalized.json` ichidagi `openAngleRad` qiymatidan foydalanish shart.

---

## 4. Maxsus Muhandislik QA Tahlillari

### 4.1. `wood_stairs_01` — 3.0 m Ko‘tarilish (`Rise`) va 4.0 m Panjara (`Perila`) Tahlili

`BUILDING-ASSET-01/README.md` jadvalida `wood_stairs_01.glb` o‘lchami `1.33 × 4.01 × 4.04 m` (`boundsMin: [-0.66, -0.006, -4.006]`, `boundsMax: [0.67, 4.00, 0.03]`) deb ko‘rsatilgan bo‘lsa-da, devor balandligi va 2-qavat poli sathi **`y = 3.0 m`** ga teng. Binar vertex tahlili orqali ushbu `1.0 m` farqning aniq geometrik sababi tasdiqlandi:

1. **Pog‘onalar va yurish sathi (`y = 0.00 -> 3.00 m`):**
   - Zinapoya `+Z` (`z = 0`, 1-pog‘ona old cheti) dan `-Z` (`z = -4.0 m`) tomonga ko‘tariladi.
   - Jami **15 ta pog‘ona** × `0.20 m` balandlik = **`3.00 m` vertikal ko‘tarilish**; gorizontal uzunligi **`4.00 m`**; har bir pog‘ona chuqurligi `0.267 m`, sof yurish eni `1.20 m`.
   - Binar vertex tekshiruvida `x < 0.45 m` (barcha pog‘onalar va chap/o‘rta kosour taxtalari) bo‘yicha eng baland vertex koordinatasi **`y = 3.006 m`** ekanligi aniqlandi.
2. **Panjara / Perila (`y = 3.00 -> 4.00 m`):**
   - Modeldagi jami `2,484` ta vertexdan `y > 3.01 m` bo‘lgan **99 ta vertex** faqatgina **`x ∈ [0.590, 0.670] m`**, **`y ∈ [3.012, 4.000] m`** va **`z ∈ [-3.921, -3.105] m`** oralig‘ida joylashgan.
   - Bu qism zinapoyaning `+X` chetidagi `1.0 m` balandlikdagi himoya panjarasi (perila tutqichi va yuqori ustuni) bo‘lib, 2-qavat (`y = 3.0 m`) ustida `y = 4.0 m` gacha chiqadi.
3. **Fizika va Collider xulosasi:**
   - Zinapoyaning `boundsMax.y = 4.0 m` qiymatini zinapoya ko‘tarilish balandligi deb olib bo‘lmaydi!
   - Yurish uchun qiya rampa collideri: `center: [0, 1.5, -2.0]`, `size: [1.2, 0.1, 5.0]`, `rotation.x = +0.6435 rad` (`36.87°`, chunki $\sqrt{3^2 + 4^2} = 5.0\text{ m}$ va $\arctan(3/4) = 0.6435\text{ rad}$).
   - `+X` tomondan o‘yinchi tushib ketmasligi uchun qo‘shimcha panjara collideri (`handrail_guard_plus_x`): `center: [0.63, 2.0, -2.0]`, `size: [0.08, 1.0, 5.0]`, `rotation.x = +0.6435 rad`.

---

### 4.2. `old_bed_01` — `under_bed` Yashirin Loot Anchori va Collider To‘qnashuvi Masalasi

`INTERIOR-ASSET-01/interior_asset_manifest.json` faylida `old_bed_01` modeli uchun 2 ta buyum anchor nuqtasi berilgan:
- `mattress`: `position: [-0.2, 0.46, 0]`, `up: [0, 1, 0]` (matras ustida)
- `under_bed`: `position: [0, 0, 0]`, `up: [0, 1, 0]`, `note: "Karavot ostida 0.20 m bo'shliq, yashirin loot uchun"`

#### Binar Geometriya vs. Manifest Collider Tahlili:
1. **Vizual 3D meshda bo‘shliq mavjud:**
   - `old_bed_01_frame` meshidagi `1,344` ta vertex tahlil qilinganda, `y < 0.195 m` bo‘lgan atigi **72 ta vertex** mavjud bo‘lib, ularning barchasi `|x| >= 0.930 m` va `|z| >= 0.405 m` burchaklarda (karavotning 4 ta oyoq ustunida) joylashgan.
   - Karavotning markaziy qismida (`|x| < 0.930 m`, `|z| < 0.405 m`) `y ∈ [0.00, 0.20] m` oralig‘ida hech qanday geometriya yo‘q — ya'ni vizual jihatdan karavot ostida haqiqatan **`0.20 m` bo‘shliq** bor.
2. **Standart Colliderdagi muammo (`occludedByDefaultCollider: true`):**
   - Xomaki manifestdagi `colliders.boxes[0]` (`frame_mattress`) quyidagicha berilgan:
     - `center: [0, 0.23, 0]`, `size: [2.0, 0.46, 0.95]` $\Rightarrow$ bu quti vertikal ravishda **`y ∈ [0.00, 0.46] m`** oralig‘ini to‘liq egallaydi!
   - Xuddi shuningdek, `colliders.simple` (`center: [0, 0.325, 0]`, `size: [2.0, 0.65, 0.95]`) ham **`y ∈ [0.00, 0.65] m`** oralig‘ini yopadi.
   - Oqibatda `under_bed` (`[0, 0, 0]`) nuqtasi va u yerga qo‘yiladigan har qanday yashirin buyum (`y ∈ [0.00, 0.15] m`) `frame_mattress` AABB colliderining **qoq ichida (tagida)** ko‘milib qoladi. Agar server yoki klient buyumni olishda (Stage 06 LOS / raycast) `frame_mattress` AABB ni to‘siq sifatida tekshirsa, nur karavotning yon qirrasidan (`z = ±0.475 m`) o‘ta olmaydi va `under_bed` dagi buyumni olib bo‘lmaydi!
3. **Muhandislik yechimi (`assets_manifest_normalized.json` ga kiritildi):**
   - Normallashtirilgan manifestda `old_bed_01.colliders.underBedClearanceAdjustedBoxes` maydoni qo‘shildi:
     - `frame_mattress_raised`: `center: [0, 0.33, 0]`, `size: [2.0, 0.26, 0.95]` ($\Rightarrow$ **`y ∈ [0.20, 0.46] m`**).
     - `headboard`: `center: [0.965, 0.555, 0]`, `size: [0.09, 0.19, 0.95]` ($\Rightarrow$ **`y ∈ [0.46, 0.65] m`**).
   - Ushbu `frame_mattress_raised` collideri o‘yinchining karavot ustidan/ichidan o‘tib ketishini to‘liq bloklaydi (`y = 0.20..0.46 m`), shu bilan birga pol ustidagi `y ∈ [0.00, 0.20] m` bo‘shliqni `under_bed` (`[0, 0, 0]`) dagi yashirin loot ko‘rinishi (LOS raycast) uchun ochiq qoldiradi.

---

### 4.3. `kitchen_cabinet_01` — Ikki Eshikli Pivot va Ichki/Tashqi Anchorlar Tahlili

`kitchen_cabinet_01.glb` — barcha 17 ta model ichida **ikkita mustaqil harakatlanuvchi pivotga** hamda **ham tashqi, ham ichki buyum anchorlariga** ega bo‘lgan yagona modeldir.

#### 1. Ikki eshikli pivot arxitekturasi va hujjat farqi:
- **Node ierarxiyasi:**
  - `kitchen_cabinet_01` (root)
    - `kitchen_cabinet_01_body` (statik mesh · `wood`, 356 tris)
    - `door_left_pivot` (pivot node · `[-0.585, 0, 0.255]`, `axis: "y"`, `openAngleRad: -1.75`)
      - `door_left` (mesh · `wood`)
      - `door_left_hardware` (mesh · `iron`)
    - `door_right_pivot` (pivot node · `[0.585, 0, 0.255]`, `axis: "y"`, `openAngleRad: +1.75`)
      - `door_right` (mesh · `wood`)
      - `door_right_hardware` (mesh · `iron`)
- **Hujjat yaxlitlash eslatmasi:** `INTERIOR-ASSET-01/README.md` ning 4-bo‘limida pivot pozitsiyalari `(-0.58, 0.00, 0.26)` va `(0.58, 0.00, 0.26)` ko‘rinishida 2 xonagacha yaxlitlab yozilgan. GLB binar `node.matrix` va `interior_asset_manifest.json` dagi haqiqiy aniq qiymatlar: **`[-0.585, 0, 0.255]`** va **`[0.585, 0, 0.255]`**.
- **Simmetrik qarama-qarshi aylanish:**
  - Chap eshik (`door_left_pivot`): `0 rad` $\rightarrow$ **`-1.75 rad` (`-100°`)**, pivot-local collider: `center: [0.285, 0.47, 0]`, `size: [0.57, 0.72, 0.02]`.
  - O‘ng eshik (`door_right_pivot`): `0 rad` $\rightarrow$ **`+1.75 rad` (`+100°`)**, pivot-local collider: `center: [-0.285, 0.47, 0]`, `size: [0.57, 0.72, 0.02]`.
  - Har ikkala eshik ochilganda ularning `Box3` markazi aynan **`0.429 m`** ga siljiydi va shkafning old tomoni (`+Z`) to‘liq ochiladi.

#### 2. Yuzalar (`placeableSurfaces`) va 7 ta Anchor (`itemAnchors`) taqsimoti:

| Tur | Yuza / Anchor nomi | Lokal Koordinata `[x, y, z]` / O‘lcham | Balandlik (`y`) | Eshik ochiqligi sharti (`requiresOpenDoors`) | `body` AABB ichida (`enclosedByBodyCollider`) |
|---|---|---|---|---|---|
| **Surface** | `countertop` | `center: [0, 0.9, 0]`, `size: [1.2, 0.52]` | `0.900 m` | `false` (har doim ochiq) | `false` (ustki sirtda) |
| **Surface** | `inside_bottom` | `center: [0, 0.1, -0.02]`, `size: [1.14, 0.46]` | `0.100 m` | **`true`** (eshiklar ochiq bo‘lganda) | **`true`** |
| **Surface** | `inside_shelf` | `center: [0, 0.479, -0.04]`, `size: [1.14, 0.42]` | `0.479 m` | **`true`** (eshiklar ochiq bo‘lganda) | **`true`** |
| **Anchor (Tashqi)** | `countertop_1` | `[-0.4, 0.9, 0]` | `0.900 m` | `false` | `false` |
| **Anchor (Tashqi)** | `countertop_2` | `[0, 0.9, 0]` | `0.900 m` | `false` | `false` |
| **Anchor (Tashqi)** | `countertop_3` | `[0.4, 0.9, 0]` | `0.900 m` | `false` | `false` |
| **Anchor (Ichki)** | `inside_bottom_1` | `[-0.29, 0.1, -0.03]` | `0.100 m` | **`true`** | **`true`** |
| **Anchor (Ichki)** | `inside_bottom_2` | `[0.29, 0.1, -0.03]` | `0.100 m` | **`true`** | **`true`** |
| **Anchor (Ichki)** | `inside_shelf_1` | `[-0.29, 0.479, -0.03]` | `0.479 m` | **`true`** | **`true`** |
| **Anchor (Ichki)** | `inside_shelf_2` | `[0.29, 0.479, -0.03]` | `0.479 m` | **`true`** | **`true`** |

#### 3. Ichki anchorlar va `body` collider o‘zaro ta'siri:
- `kitchen_cabinet_01` ning asosiy `body` collideri `center: [0, 0.45, 0]`, `size: [1.2, 0.9, 0.55]` (`x ∈ [-0.60, 0.60]`, `y ∈ [0.00, 0.90]`, `z ∈ [-0.275, 0.275]`) yaxlit quti sifatida berilgan.
- Barcha 4 ta ichki anchor (`inside_bottom_1..2`, `inside_shelf_1..2`) `z = -0.03 m` da, ya'ni **`body` AABB colliderining ichida** joylashgan.
- **Integratsiya qoidasi:**
  1. Eshiklar yopiq holatda (`isOpen === false`) `inside_*` anchorlardagi buyumlar olinmasligi kerak (`requiresOpenDoors: true`).
  2. Eshiklar ochiq holatda (`isOpen === true`) o‘yinchi `inside_*` anchorlardagi buyumni olishi uchun LOS (ko‘rinish chizig‘i) raycasti `kitchen_cabinet_01` ning `body` AABB qutisini ichki anchorlar uchun bloklovchi to‘siq sifatida hisoblamasligi zarur.

---

## 5. Grid, Uy Yig‘ish va Mebel Joylashtirish Mosligi (`BUILDING` + `INTERIOR` + `LOOT`)

1. **4.0 m Grid va 3.0 m Qavat Balandligi:**
   - Pol katagi (`wood_floor_01`) `4.0 × 4.0 m`, ustki yuzasi `y = 0.0 m` (`y ∈ [-0.2, 0.0]`).
   - Devorlar (`wood_wall_01`, `wood_wall_window_01`, `wood_wall_door_01`) `x ∈ [-2.0, 2.0]`, balandligi `y ∈ [0.0, 3.0] m` (pastki etak taxtasi `y = -0.2 m` gacha tushib pol qirrasini yopadi).
   - Har bir devorning `x = -2.0` uchida `corner_post` (`0.24 × 0.24 m`) mavjud. Yopiq perimetr bo‘ylab soat miliga teskari / ketma-ket `a -> b` tartibda qo‘yilganda har bir burchak tugunida bitta ustun hosil bo‘ladi.
2. **Bo‘shliqlar (Openings):**
   - **Eshik bo‘shlig‘i (`wood_wall_door_01`):** `x ∈ [-0.9, 0.9] m`, `y ∈ [0.0, 2.4] m` (`1.8 × 2.4 m`), ostona `y = 0.03 m`. Eshik (`wood_door_01`) ichkariga (`-Z`) `1.76 m` radiusli chorak doira bo‘ylab ochiladi — bu sohaga mebel yoki loot konteyner qo‘yilmasligi kerak.
   - **Deraza bo‘shlig‘i (`wood_wall_window_01`):** `x ∈ [-0.6, 0.6] m`, `y ∈ [1.0, 2.0] m` (`1.2 × 1.0 m`, oynasiz ochiq). Deraza tokchasi `y = 1.0 m` da bo‘lgani uchun uning ostiga `old_sofa_01` (`0.902 m`), `kitchen_cabinet_01` (`0.903 m`), `wooden_table_01` (`0.75 m`) va `old_bed_01` (`0.65 m`) bemalol sig‘adi.
3. **Devor plintusi va mebel oraliq masofasi:**
   - Devor qalinligi o‘qdan `±0.10 m`, plintus esa `0.115 m` chiqib turadi. Mebel yoki shkafni devorga taqab qo‘yishda uning orqa (`-Z`) chegarasi devor grid chizig‘idan kamida **`0.135 m`** ichkarida bo‘lishi kerak.
4. **Namuna sxemalar tekshiruvi:**
   - `sample_cabin_layout.json` (`8 × 4 m` namuna uy): 17 ta modul (3 ta pol, 6 ta devor, 1 ta eshik, 2 ta fronton `gable`, 4 ta tom qiyaligi `slope`, 1 ta zinapoya `wood_stairs_01`) — barcha modul nomlari `BUILDING-ASSET-01` bilan to‘liq mos.
   - `sample_room_layout.json` (`4 × 4 m` jihozlangan xona): 6 ta bino moduli + 7 ta mebel (`wooden_shelf_01`, `old_bed_01`, `old_sofa_01`, `kitchen_cabinet_01`, `wooden_table_01`, 2 ta `wooden_chair_01`), o‘yinchi yurish yo‘lagi `x ∈ [0.95, 2.45]`, `z ∈ [1.10, 3.87]` ochiq.
