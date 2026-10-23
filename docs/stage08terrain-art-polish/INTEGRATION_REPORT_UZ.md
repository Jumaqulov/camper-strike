# CAMPER STRIKE 65 — BOSQICH 08-TERRAIN-SKIRT-OCCLUSION-FIX YAKUNIY HISOBOTI

**Bosqich:** STAGE 08-TERRAIN-SKIRT-OCCLUSION-FIX (Tashqi skirt tekisligining relyefni yopib qo‘yish render xatosini bartaraf etish, ochiq xalqali geometriya, halol 15s × 2 benchmark va haqiqiy ko‘rinishlar)  
**Sana:** 2026-10-23  
**Holat:** 100% TEXNIK VA VIZUAL AUDIT TUZATISHLARI BAJARILDI (Foydalanuvchi ko‘rib chiqishi va ma’qullashiga tayyor)  
**Qat’iy Chegara:** 08B (personaj animatsiyalari) yoki 08C (HUD) bosqichlariga mutlaqo o‘tilmadi.

---

## 1. Topilgan Asosiy Root Cause (Ildiz Sabab) va Bajarilgan Aniq Tuzatish

Mustaqil audit (`CAMPER_STRIKE_65_STAGE08_REVIEW_FIX_MUSTAQIL_AUDIT_UZ.md`) va ko‘rsatmalar (`GEMINI_STAGE08_TERRAIN_SKIRT_OCCLUSION_FIX_UZ.md`) tahlilida o‘ta muhim render-geometriya nuqsoni aniqlandi:

### 1.1. Muammoning Tub Sababi
`src/client/game/ForestRenderer.ts` faylidagi ufqni yopuvchi tashqi tekislik (`outerSkirt`):
```ts
const skirtSize = isForestSquare ? 1200 : 900;
const outerSkirt = new THREE.Mesh(new THREE.PlaneGeometry(skirtSize, skirtSize), outerSkirtMat);
outerSkirt.rotation.x = -Math.PI / 2;
outerSkirt.position.y = -0.02;
```
Bu `1200×1200 m` tekislik markazida teshigi yo‘q yaxlit bitta sirt bo‘lib, `256×256 m` o‘ynaladigan hudud ustini ham qoplagan edi!
Seed 6501 da xaritadagi 16,641 relyef nuqtasining **35.1% qismi (5,786 ta nuqta)** $y < -0.02$ m pastlikda joylashgan:
- **First Join `(64, 4)`:** relyef balandligi $-0.324$ m, skirt esa $-0.020$ m bo‘lib, relyefdan **0.304 m (30 sm!) balandda** turgan.
- **Road Edge `(-14, 58)`:** relyef balandligi $-0.141$ m, skirt **0.121 m balandda** turgan.
- **Meadow 1P/3P `(-14, 52)`:** relyef balandligi $-0.130$ m, skirt **0.110 m balandda** turgan.

Natijada, kamera ushbu pastliklarga qaraganida haqiqiy 3D relyef va uning ustidagi o‘simliklar/shader emas, balki ularni yopib turgan **tekis yashil `outerSkirt` tekisligi** renderlangan! Shuning uchun `01`, `05`, `07a`, `07b` kadrlarining pastki 25% qismida piksellar o‘zgarmay qolgan edi. `02`, `03`, `04`, `06` kadrlarining relyefi esa $y > -0.02$ m baland bo‘lgani uchun ular skirt ustiga chiqib, yaxshilanish ko‘ringan.

### 1.2. Kiritilgan Aniq Muhandislik Yechimi
1. `src/client/game/terrain/skirtGeometry.ts` yaratildi va `buildAnnularSkirtGeometry(innerHalf, outerHalf, y)` funksiyasi joriy qilindi:
   - Ichki o‘ynaladigan hudud `[-128, 128] × [-128, 128]` **100% BO‘SH / OCHIQ** qoldirildi (ichkarida birorta ham uchburchak yo‘q).
   - Tashqi xarita atrofi 4 ta to‘liq tutash to‘g‘ri to‘rtburchak strip (Shimol, Janub, G‘arb, Sharq) shaklida tuzildi (jami 16 vertex, 8 uchburchak).
   - Ichki qirra balandligi $y = 0.0$ qilib o‘rnatildi — bu xarita chegarasidagi heightfield balandligi ($y = 0.0$) bilan **baytma-bayt choksiz, yoriqsiz va jarliksiz** tutashadi.
2. `ForestRenderer.ts`da `isForestSquare` uchun ushbu xalqasimon geometriya ulandi; `forest_sample` (96×96m) uchun eski xatti-harakat daxlsiz saqlandi.
3. Server kollayderlari, fizika, spawnlar, konteynerlar va `gameplayHash`ga mutlaqo tegmasdan, sof render-qatlam xatosi tuzatildi.

---

## 2. Piksellar Bo‘yicha BEFORE va AFTER Taqqoslovi (Haqiqiy Chrome PNG Tahlili)

Skrinshotlar `scripts/compare-png.mjs` yordamida to‘liq pikselma-piksel taqqoslandi (1280×720, jami 921,600 piksel, lower 25% = 230,400 piksel):

| Kadr Fayli | Kamera Tavsifi | Jami O‘zgargan Piksellar (%) | O‘rtacha RGB Farqi (0–255) | Pastki 25% (Foreground) O‘zgargan Piksellar (%) | Pastki 25% O‘rtacha RGB Farqi |
|---|---|---:|---:|---:|---:|
| `01_first_join_open_forest.png` | Ochiq o‘rmon yalangligi (1P First Join) | **48.02%** (442,560 px) | **12.23** | **96.43%** (222,170 px) | **25.25** |
| `02_tree_shadow_ferns.png` | Qalin daraxt tagidagi paporotniklar | **58.25%** (536,837 px) | **13.04** | **100.00%** (230,400 px) | **26.13** |
| `03_moss_soil_ground_detail.png` | Yaqin tuproq va mox detallari (0.55m) | **72.12%** (664,654 px) | **9.78** | **71.50%** (164,735 px) | **7.54** |
| `04_winding_dirt_road.png` | Aylanma tuproq yo‘l va cheti | **46.08%** (424,670 px) | **7.64** | **99.96%** (230,306 px) | **14.74** |
| `05_road_edge_flowers_grass.png` | Janubiy yalanglik, yo‘l cheti gullar | **56.96%** (524,900 px) | **14.67** | **100.00%** (230,400 px) | **28.89** |
| `06_poi_ranger_yard_approach.png` | Ranger House hovlisi va yo‘l tutashuvi | **49.48%** (456,048 px) | **10.72** | **85.54%** (197,089 px) | **18.97** |
| `07a_first_person_near_grass.png` | 1P yaqin maysa va gullar | **52.73%** (485,944 px) | **11.75** | **95.75%** (220,609 px) | **21.04** |
| `07b_third_person_near_grass.png` | 3P personaj atrofi o‘simliklari | **55.86%** (514,849 px) | **11.31** | **99.20%** (228,556 px) | **19.55** |
| `08_topdown_map_overview.png` | 256×256 tepadan xarita ko‘rinishi | **26.78%** (246,799 px) | **5.03** | **44.80%** (103,211 px) | **8.91** |

> **Xulosa:** Oldingi auditda muammo bo‘lgan `01`, `05`, `07a`, `07b` kadrlarida pastki 25% (foreground) bo‘yicha o‘zgarish avval 0% bo‘lgan bo‘lsa, endi **95.75% dan 100.00% gacha** yetdi! O‘rtacha RGB farqi esa 0.0 dan **19.5 – 28.9 birlikka** ko‘tarildi. Tekis yashil qoplamaning olib tashlanishi o‘yinchi oyoqlari ostidagi barcha nam tuproq, mox, shag‘al va GLB maysalarni to‘liq ochib berdi.

---

## 3. Halol va Qat’iy Benchmark Natijalari (Intel UHD Graphics 730)

- **Qurilma:** `ANGLE (Intel, Intel(R) UHD Graphics 730 (0x0000A782) Direct3D11 vs_5_0 ps_5_0, D3D11)`
- **Grafik API:** WebGL 2.0 (OpenGL ES 3.0 Chromium)
- **Metodika:** 5 soniya kamera harakati bilan warmup + ketma-ket **15 soniyadan 2 ta to‘liq pass** (har bir sahnada jami ~37 soniya, 2,200+ kadr tahlili).
- **1% Low formulalari (Audit ko‘rsatmasiga binoan shaffof tushuntirish):**
  * `1% Low (Avg Slowest 1%)`: eng sekin 1% kadrlarning o‘rtacha kadr vaqtiga teskari tezlik ($1000 / \text{mean}(FT_{slowest1\%})$).
  * `1% Low (p99 Proxy)`: 99-persentil kadr vaqtiga asoslangan oniy tezlik ($1000 / FT_{p99}$).

| Sahna ID | Kadrlar (Jami / Pass) | Jami Vaqt | Median FPS | 1% Low (Avg) | 1% Low (p99) | Kadr Vaqti (Median / p95 / p99) | Draw Calls | Triangles | JS Heap (Used) |
|---|---|---|---|---|---|---|---|---|---|
| `bench_open_forest` | 2,235 / 1,118 | 37.3 s | **59.9** | **58.0** | **59.2** | 16.7 ms / 16.8 ms / 16.9 ms | 158 | 699,916 | 65.5 MB |
| `bench_dirt_road` | 2,221 / 1,111 | 37.0 s | **59.9** | **57.6** | **58.8** | 16.7 ms / 16.9 ms / 17.0 ms | 60 | 403,303 | 65.8 MB |
| `bench_tree_shadow` | 2,211 / 1,106 | 36.9 s | **59.9** | **51.8** | **55.5** | 16.7 ms / 16.8 ms / 18.1 ms | 144 | 709,199 | 67.7 MB |
| `bench_ranger_house` | 2,232 / 1,116 | 37.2 s | **59.9** | **58.9** | **59.2** | 16.7 ms / 16.8 ms / 16.9 ms | 108 | 624,755 | 67.0 MB |

> **Unumdorlik bahosi:** Skirt ostidagi barcha relyef fragmentlari va qo‘shimcha yaqin o‘simliklar renderlana boshlaganiga qaramay, barcha 4 ta asosiy sahnada barqaror **59.9 FPS** va silliq 16.7 ms frame pacing saqlab qolindi.

---

## 4. 1080p Go‘zallik Surati va Skrinshotlar

- `01_first_join_open_forest_1080p.png` (1920×1080):
  * Kamera: `x: 64, y: 1.35, z: 4, yaw: 2.37, pitch: -0.09` (First Join 1-shaxs nigohi).
  * Hajmi: **1,332.9 KB** (avval 913 KB bo‘lgan, chunki yashil tekislik o‘rniga boy va donador haqiqiy yer teksturasi kirdi).
  * Boshqa barcha 10 ta skrinshot `docs/screenshots/stage08terrain-art-polish/after/` papkasida yangilandi.

---

## 5. Multiplayer 2-Mijoz Sinovi (Halol Tekshiruv Doirasi)

- **Xona va Ulanish:**
  * Client 1 (`Survivor_Alpha`) yangi Forest Survival xonasini yaratdi (`roomId: 'r3cycl'`).
  * Client 2 (`Survivor_Bravo`) room-list orqali aynan shu xonani topib kirdi (`roomId: 'r3cycl'`).
  * `roomJoinAndMutualPresence`: **PASS** (Ikkala klientda ham `otherPlayerCount === 1` va bir-birini ko‘rish tasdiqlandi).
  * `gameplayHash`: ikkala klientda `670a9c21f0565c94` (100% mos).
  * `containersCount`: ikkala klientda `26` ta konteyner.
  * `activeGLBs`: ikkala klientda `17/17` faol, `0` ta fallback.
- **Audit ehtiyotkorligi bo‘yicha halol qayd:**
  * `atomicLootPickup`: **NOT_TESTED** (Mazkur render-skirt bosqichida qayta test qilinmadi, Stage 08 dagi holatida saqlangan).
  * `inventoryState`: **NOT_TESTED** (Stage 08 dagi holatida saqlangan).
  * `spectatorTransition`: **NOT_TESTED** (Stage 08 dagi holatida saqlangan).

---

## 6. Avtomatlashtirilgan Testlar va Invariantlar

1. `npm run typecheck`: **0 ta xato** (TypeScript strict check).
2. `npm run build`: **295 ms ichida muvaffaqiyatli**.
3. `npm test`: **186/186 PASS** (27 ta test to‘plami):
   - Yangi `src/shared/__tests__/stage08-skirt-occlusion.test.ts`: **4/4 PASS** (Reproduktsiya, 41x41 nuqtada skirt yo‘qligi, tashqi hitlar va choksiz ulanish).
   - `src/shared/__tests__/stage08-terrain-review-fix.test.ts`: **PASS**.
   - `src/shared/__tests__/stage08-terrain-art-polish.test.ts`: **PASS**.
   - `src/shared/__tests__/stage08-terrain-qa.test.ts`: **PASS**.
   - Qolgan barcha 23 ta test to‘plami: **PASS**.
4. Invariantlar: 53 ta GLB, 17/17 o‘simlik, 0 fallback, seed 6501 hash `670a9c21f0565c94`, 2,341 collider, 36 spawn, 26 container, yo‘l o‘qida 0 ta o‘simlik.

---

## 7. Xulosa va Keyingi Qadam

- **Xulosa:** Mustaqil auditda topilgan yirik P1 render-geometriya nuqsoni (tekis skirtning relyefni to‘sib qo‘yishi) ildizi bilan bartaraf etildi. Barcha 9 ta kamerada yer va o‘simliklarning haqiqiy vizual sifati to‘liq ochildi, halol 15s × 2 benchmark ma’lumotlari taqdim etildi.
- **Keyingi qadam:** Foydalanuvchi mazkur yangilangan natija va skrinshotlarni shaxsan ko‘rib chiqib ma’qullaganidan so‘ng, keyingi **08B (personaj animatsiyalari va kamera)** bosqichiga o‘tish mumkin.
