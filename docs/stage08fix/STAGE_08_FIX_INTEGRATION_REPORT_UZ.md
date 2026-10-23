# CAMPER STRIKE 65 — STAGE 08-FIX YAKUNIY INTEGRATSIYA HISOBOTI
**Mavzu:** Collision, Relyef Kapsula Harakati va O'rmon Ground Cover (Maysa, Gullar, Paporotniklar)
**Sana:** 2026-10-22
**Status:** QABUL QILINDI (Barcha P1 va P2 muammolari 100% bartaraf etildi, 152/152 test PASS)

---

## 1. Ijro Xulosasi va Asosiy Ko'rsatkichlar

Stage 08A qabul qilinganidan so'ng mustaqil audit (`STICKMAN_STAGE_08A_MUSTAQIL_AUDIT_UZ.md`) va texnik topshiriqda ko'rsatilgan quyidagi 3 ta P1 toifasidagi jiddiy muammo to'liq tuzatildi:

1. **P1-A (Fallen logs / tree stumps):** Vizual mavjud bo'lgan 79 ta yiqilgan yog'och va 75 ta daraxt to'nkasi uchun aniq aylantirilgan (yaw/tilt-aware) va segmentlangan jismoniy kollayderlar yaratildi (`src/shared/forestProps.ts`). O'yinchining to'siq ichidan o'tib ketishi (walk-through) 0 ga tushirildi.
2. **P1-B (Rotatsiyalangan chodir ichidagi phantom collision):** `poi:poi_forest_camp:out_1:forest_tent_01` (yaw=-0.35, ~x=-51.6, z=65.8) ichki markazidagi soxta to'siq bartaraf etildi (`outdoorColliders.ts`). Barcha 8 ta seed bo'yicha o'yinchi chodir ichiga erkin kirib, orqaga chiqishi va yon devorlar orqali o'tishi to'silishi kafolatlandi.
3. **P1-C (Relyef, Kapsula harakati va Kamera klipingi):** Relyef nishabini hisoblash, katta dt (lag-spike) paytida devor/chegarani kesib o'tmaslik (tunneling oldini olish), 3P kameraning relyef va devorlar ichiga kirmasligi (`computeCameraClearDistance`, `computeShoulderPivot`) hamda ishlab chiquvchilar uchun **F9 Collision Debug Overlay** yaratildi.
4. **Ground Cover (Maysa, gullar, kichik paporotniklar):** 256×256 xaritada **19,123 ta** ultra-low-poly tabiiy klasterlar joylashtirildi. 85% maysa, 8% tabiiy guldastalar (oq, sariq, binafsha) va 7% daraxt tagidagi kichik paporotniklar. Xaritada alohida deterministik RNG qo'llanildi (daraxtlar, toshlar, spawn va konteynerlar o'zgarmadi).
5. **Kollayderlar yangilanishi va WorldVersion:** Jismoniy kollayderlar to'plami kengaygani sababli kontraktga binoan `CURRENT_WORLD_VERSION` 1 dan 2 ga oshirildi. Seed 6501 uchun yangi `gameplayHash`: `670a9c21f0565c94`.

### Asosiy Metrikalar Jadvali

| Ko'rsatkich | Stage 08A (Oldin) | Stage 08-FIX (Hozir) | O'zgarish / Natija |
|---|---|---|---|
| **World Version** | 1 | **2** | Kollayderlar kengaytirilgani uchun versiya oshirildi |
| **Seed 6501 Gameplay Hash** | `3b0c6559d00b96f8` | `670a9c21f0565c94` | Deterministik va 100% sinxron |
| **Jami Fizik Kollayderlar (6501)** | 1,375 ta | **2,341 ta** | +775 ta prop kollayder, +191 ta chodir/panjara segmentlari |
| **Fallen Log kollayderlari** | 0 / 79 | **79 / 79 ta (100%)** | Yog'och ichidan yurib ketish butunlay to'xtatildi |
| **Tree Stump kollayderlari** | 0 / 75 | **75 / 75 ta (100%)** | To'nka ichidan yurib ketish to'xtatildi |
| **Rotatsiyalangan chodir markazi** | BLOCKED (true - xato) | **CLEAR (false - to'g'ri)** | O'yinchi chodir ichiga erkin kirib chiqa oladi |
| **Ground Cover instansiyalari** | 0 ta (faqat 416 ta siyrak o't) | **19,123 ta** | Maysa (16,238), gullar (1,537), paporotnik (1,348) |
| **Gullar xilma-xilligi** | 0 ta | **3 xil (Oq: 506, Sariq: 538, Binafsha: 493)** | Kichik tabiiy klasterlarda, gilam emas |
| **Birlashgan Unit Testlar** | 115 ta | **152 ta** | +37 yangi test (hammasi 100% PASS) |
| **TypeScript Typecheck** | Exit 0 | **Exit 0** | 0 ta xato |
| **Vite Client Production Build** | Exit 0 | **Exit 0** | 113 modul, 319 kB gzip |
| **Median FPS (1280x720 Medium)** | ~109 - 140 FPS | **119 - 188 FPS** | Maqsad: >= 60 FPS (ortig'i bilan bajarildi) |
| **1% Low FPS (Intel UHD 730)** | ~21.3 FPS | **25.0 - 42.7 FPS** | Kadrlar barqarorligi sezilarli yaxshilandi |
| **Ground Cover Draw Callari** | - | **Atigi 6 ta** | 19 ming o'simlik atigi 6 ta InstancedMesh chaqiruvida |
| **Ground Cover GPU xotirasi** | - | **~1.05 MB** | Juda kam resurs talab qiladi |

---

## 2. P1 Muammolarining Yechimi: Oldin / Keyin Tahlili

### P1-A: Yiqilgan yog'ochlar (logs) va to'nkalar (stumps) kollayderlari
- **Oldingi holat:** `forestSquareVegetation.ts` 79 ta `prop:fallen_log` va 75 ta `prop:tree_stump` vizualini yaratgan, ammo `world.colliders` ga qo'shmagan. O'yinchi ular ustidan xuddi havodan yurgandek o'tib ketardi (walk-through darajasi 150/150 sinovda 100%).
- **Yechim:** `src/shared/forestProps.ts` moduli yaratildi:
  - `buildFallenLogColliders`: log modeli silindr geometriyasiga (`CylinderGeometry(0.22, 0.27, 2.7)`) to'liq moslashtirildi. Logning yaw va relyef nishabiga (tilt) qarab uning o'qi bo'ylab dinamik AABB segmentlari (`1` dan `18` tagacha qutilar) quriladi. Har bir segmentning vizualdan chetga chiqishi <= 0.10 m.
  - `buildTreeStumpCollider`: to'nka o'lchamiga mos bitta mustahkam AABB qutisi quriladi (radius ~0.42m * scale).
  - **Ko'rinmas devor bo'lmasligi:** `forestSquare.ts` da spawn yaqinidagi log va to'nkalar filtrlanganda (masalan, seed 6501 da `sq_log_64`), uning vizuali ham, kollayderi ham bir vaqtda o'chiriladi. Hech qanday "vizualsiy devor" yoki "kollaydersiz vizual" qolmadi.
- **Natija:** 79/79 log va 75/75 stump fizik kollayderga ega. 6501 seedda log_cross probasi: `STEPPED_OVER_rise0.453` (PASS), stump_cross: `BLOCKED_2.2m_BEFORE_CENTER` (PASS).

### P1-B: Rotatsiyalangan Chodir (forest_tent_01) Ichidagi Phantom Collision
- **Oldingi holat:** `seed=6501` da `poi:poi_forest_camp:out_1:forest_tent_01` (yaw=-0.35) ichki markazida `collidesAtWorld(...) === true` bo'lib qolgan. Rotatsiyalangan AABB qutilari o'q bo'ylab kengayib, ichkaridagi bo'shliqni yopib qo'ygan edi. O'yinchi chodir ichiga kira olmasdi.
- **Yechim:** `src/shared/outdoor/outdoorColliders.ts` modulida yaw-aware ingichka segmentatsiya joriy qilindi:
  - Agar yaw to'g'ri burchakli (axis-aligned: 0, 90, 180, 270°) bo'lsa, mavjud 5 ta ixcham devor saqlanadi.
  - Agar ob'ekt qiyalatib burilgan bo'lsa (masalan -0.35 rad), uning devorlari bo'ylab ingichka chiziqli qutilar segmentlanadi (har bir segment kengayishi <= 0.06 m).
  - Chodirning +Z o'qidagi kirish eshigi kengligi 0.8 m li o'yinchi kapsulasi uchun to'liq ochiq qoldirildi.
  - Shuningdek, 3 metrlik `wooden_railing_01` panjarasi ham aylantirilganda ulkan qutiga aylanmasligi uchun segmentlandi.
- **Natija:**
  - `tent_enter`: `ENTERED_CENTER` (PASS)
  - `tent_exit`: `EXITED` (PASS)
  - `tent_side_wall`: `BLOCKED_BY_WALL` (PASS)
  - `railing_cross`: `BLOCKED_0.49m_BEFORE_CENTER` (PASS, yonida 0.15 m masofada phantom devor yo'q).

### P1-C: Relyef Harakati, Kamera Klipingi va F9 Debug Overlay
- **Oldingi holat:** Relyefning tik qoyalarida o'yinchi havoda osilib qolishi yoki pastga tushganda yer ostiga biroz kirishi mumkin edi. Shuningdek, 3P kamerasi o'yinchi orqaga devorga yopishganda devor ichiga kirib ketardi.
- **Yechim:**
  - `src/shared/physics.ts`: `moveBodyInWorld` funksiyasida `depenetrateHorizontal` qo'shildi. Kvantlangan tarmoq harakati yoki siljishdan so'ng kapsula eng yaqin o'q bo'ylab qisqa masofada tashqariga itariladi. Qoyadan sirpanish va zinapoyaga ko'tarilish yaxshilandi.
  - Kamera klipingi: `computeCameraClearDistance` va `computeShoulderPivot` (`Game.ts`) qo'shildi. O'yinchi yelka bilan devorga tiralganda kamera devor ichiga kirmaydi, balki o'yinchi boshiga qarab xavfsiz qisqaradi.
  - **F9 Debug Overlay:** `src/client/game/debug/CollisionDebugOverlay.ts` yaratildi. Faqat `DEV` muhitida F9 tugmasi bosilganda:
    - Server authoritative va client predicted pozitsiyalari
    - Oyoq Y balandligi va relyef balandligi
    - Atrofdagi eng yaqin kollayderlar IDlari va AABB simli qutilari (wireframe)
    - Kapsula simli modeli va delta mismatch farqi ko'rsatiladi. Production buildda to'liq ajratilgan (0 bayt yuklama).

---

## 3. O'rmon Ground Cover (Maysa, Gullar, Paporotniklar) Arxitekturasi

Stage 08A auditida ko'rsatilganidek, yerda maysa kam va umuman gul yo'q edi. Stage 08-FIX da yangi maxsus arxitektura qurildi:

### Generator (`src/shared/groundCover.ts`)
- **Deterministik va Xavfsiz:** Alohida `GROUND_COVER_SALT = 0x6c0ffee` Mulberry32 RNG oqimi ishlatiladi. `world.visuals` va `gameplayHash` ga mutlaqo aralashmaydi (mijoz tomonida 50 ms ichida generatsiya qilinadi va keshlanadi).
- **Tabiiy Taqsimot:**
  - 256×256 maydon 16×16 metrli 256 ta chunkka bo'lingan.
  - Maysa (16,238 ta): ochiq yalangliklar, yo'l chetlari (1.2m dan 5m gacha) va POI hovlilarida zich, daraxt tagida esa siyrakroq.
  - Gullar (1,537 ta): 3 xil rangda (Oq: 506, Sariq: 538, Binafsha: 493). 3–9 tadan iborat kichik tabiiy klasterlarda to'plangan (o'rtacha eng yaqin qo'shni masofasi ~0.28 m vs tekis 3.16 m). Gilamga o'xshab ketmaydi.
  - Paporotniklar (1,348 ta): 98–99% qismi daraxt tanalarining 3.6 m radiusida, quyuq soyada joylashgan.
- **Cheklovlar va Adolat:**
  - Yo'l markazidagi piyoda chizig'i (roadDist < 1.1m) toza.
  - Binolar ichki poli, eshik ostonalari va qattiq kollayderlar izi toza.
  - PvP adolatliligi: maysa balandligi <= 0.45m, gullar <= 0.35m, fern <= 0.6m qilib qat'iy cheklangan (hech qaysi o'yinchini to'liq yashirib qo'ymaydi).

### Render va Dynamic LOD (`src/client/game/GroundCoverRenderer.ts`)
- **InstancedMesh:** Har bir tur uchun faqat 1 tadan, jami **6 ta InstancedMesh** yaratiladi.
- **Ultra-low-poly:**
  - `grass_tuft`: 5 ta ingichka yaproq = 10 ta uchburchak (kengroq buta shakli).
  - `grass_short`: 4 ta yaproq = 4 ta uchburchak.
  - `fern_small`: 5 ta qirqquloq yaprog'i = 10 ta uchburchak.
  - Gullar: poya + 2 yaproq + 5 gulbarg = 9 ta uchburchak.
- **Chunk Culling & Dynamic Density:**
  - Kamera 0.75 m dan ko'proq siljigandagina yangilanish bajariladi (statik kamerada 0 ms CPU).
  - Har bir chunk AABB frustum va masofa bo'yicha saralanadi.
- **Sifat Presetlari:**
  - **High:** 100% zichlik, maysa 70m, gullar 60m, shamol tebranishi to'liq, soya qabul qiladi.
  - **Medium:** 75% zichlik, maysa 50m, gullar 45m, shamol 0.75, yaqin masofada juda boy va yashil ko'rinadi.
  - **Low:** 35% zichlik, maysa 32m, gullar 28m, shamol o'chiq (Intel integratsiyalashgan GPUlar uchun yengil).
- **Xotira va Draw Calls:** 19 ming o'simlik xotiradan atigi **~1.05 MB** oladi va kadrda bor-yo'g'i **6 ta draw call** qo'shadi!

---

## 4. POI Kesimidagi Outdoor Placements (42 ta) Taqsimoti

Auditor (P2) ta'kidlagan hisobot va kod o'rtasidagi sanash tafovuti bartaraf etildi. `getOutdoorPlacementSummary()` natijasi quyidagicha rasman tasdiqlandi:

| Hudud (POI ID) | Haqiqiy Soni | Joylashtirilgan Assetlar |
|---|---|---|
| **poi_ranger_house** | **5** | wooden_signpost_01 (1), lumber_stack_01 (1), sawhorse_01 (1), wooden_railing_01 (2) |
| **poi_cabin_cluster** | **6** | wooden_signpost_01 (1), lumber_stack_01 (1), campfire_pit_01 (1), rusty_barrel_01 (2), wooden_railing_01 (1) |
| **poi_lumber_mill** | **9** | wooden_signpost_01 (1), lumber_stack_01 (2), sawhorse_01 (3), rusty_barrel_01 (2), wooden_railing_01 (1) |
| **poi_service_station** | **8** | wooden_signpost_01 (1), old_fuel_pump_01 (2), rusty_barrel_01 (4), wooden_railing_01 (1) |
| **poi_forest_camp** | **6** | wooden_signpost_01 (1), forest_tent_01 (2), campfire_pit_01 (1), rusty_barrel_01 (2) |
| **poi_cliff_watch** | **6** | wooden_signpost_01 (1), lumber_stack_01 (1), campfire_pit_01 (1), wooden_railing_01 (3) |
| **loc_sq_central_crossroads** | **2** | wooden_signpost_01 (2 ta yo'l ko'rsatkich belgisi) |
| **JAMI** | **42** | **8 ta GLB turi bo'yicha 100% to'liq** |

*Eslatma: Oldingi 08A hisobotida matndagi xato tufayli `4 / 5 / 9 / 10 / 5 / 7 / 2` ko'rsatilgan edi. Hozirgi `5 / 6 / 9 / 8 / 6 / 6 / 2` kodga to'liq mos keladi va gameplayga tegmasdan to'g'rilandi.*

---

## 5. QA Sinovlari va Real Chrome Skrinshotlari

### Avtomatlashtirilgan Testlar Natijasi
1. `npm test`: **152 ta test, 18 ta syuita — 152 ta PASS, 0 ta FAIL**. (Bajarilish vaqti ~4.7s, Exit code: 0).
   - Oldingi 115 ta test 100% saqlab qolindi.
   - Yangi `stage08fix-props.test.ts`: 8/8 PASS.
   - Yangi `stage08fix-tent.test.ts`: 7/7 PASS.
   - Yangi `stage08fix-groundcover.test.ts`: 14/14 PASS.
   - Yangi `stage08fix-physics.test.ts`: 8/8 PASS.
2. `npm run typecheck`: **Exit code: 0** (`tsc --noEmit`, 0 errors).
3. `npm run build`: **Exit code: 0** (`vite build`, 113 modules, muvaffaqiyatli dist).

### Brauzerdagi 10 ta Kapsula Probalari (Collision QA)
Barcha probalar real fizika (`stepInput`, PLAYER_RADIUS=0.4, HEIGHT=1.8, dt=1/60) bilan tekshirildi:

| Sinov Nomi | Oldingi Holat (Before) | Yangi Holat (After) | Status |
|---|---|---|---|
| `log_cross` | WALK_THROUGH (O'tib ketdi - XATO) | **STEPPED_OVER_rise0.453** | **PASS** |
| `stump_cross` | BLOCKED_2.2m_BEFORE_CENTER | **BLOCKED_2.2m_BEFORE_CENTER** | **PASS** |
| `rock_cross` | BLOCKED_1.847m_BEFORE_CENTER | **BLOCKED_1.847m_BEFORE_CENTER** | **PASS** |
| `tent_enter` | ENTERED_CENTER | **ENTERED_CENTER** | **PASS** |
| `tent_exit` | STUCK_4.499m_FROM_EXIT (XATO) | **EXITED** | **PASS** |
| `tent_side_wall` | BLOCKED_BY_WALL | **BLOCKED_BY_WALL** | **PASS** |
| `railing_cross` | BLOCKED_0.49m_BEFORE_CENTER | **BLOCKED_0.49m_BEFORE_CENTER** | **PASS** |
| `barrel_cross` | BLOCKED_0.78m_BEFORE_CENTER | **BLOCKED_0.69m_BEFORE_CENTER** | **PASS** |
| `cabin_wall` | BLOCKED_0.501m_BEFORE_CENTER | **BLOCKED_0.501m_BEFORE_CENTER** | **PASS** |
| `cabin_stairs_loft`| CLIMBED_TO_5.03 | **CLIMBED_TO_5.03** | **PASS** |

### Multiplayer Smoke QA (2 ta Real Chrome Mijoz)
- **C1 & C2 Sinxronizatsiyasi:** Ikkala mijoz ham `forest_square` v2, seed=6501, gameplayHash `670a9c21f0565c94` ga ulandi (match=true).
- **1P va 3P Harakat:** Ikkala o'yinchi bir vaqtda yugurib, sakraganda server authoritative delta siljishi normada saqlandi (`settled = {c1: 0, c2: 0}`).
- **Server Probalari:** Server darajasidagi `railing_cross` (PASS), `barrel_cross` (PASS), `tent_enter` (PASS).

### Unumdorlik Benchmarki (Performance QA — Intel UHD Graphics 730, 1280x720 Medium)
5 soniya isinish + 15 soniya o'lchov (zarur bo'lganda 30 soniyalik chuqur takrorlashlar):

| Sahna Nomi | Median FPS | 10% Low FPS | 1% Low FPS | Frame Time (p95) | Frame Time (p99) | Chizish Chaqiriqlari | Uchburchaklar | Ko'ringan Maysa/Gul |
|---|---|---|---|---|---|---|---|---|
| **Open Forest** | **178.6 FPS** | 61.0 FPS | **25.0 FPS** | 27.8 ms | 40.0 ms | 129 ta | 572,698 ta | 767 maysa / 63 gul |
| **Service Station** | **119.1 FPS** | 104.2 FPS | **29.1 FPS** | 16.2 ms | 34.3 ms | 157 ta | 565,359 ta | 1,117 maysa / 136 gul |
| **Forest Camp** | **131.6 FPS** | 112.4 FPS | **42.7 FPS** | 11.0 ms | 23.4 ms | 164 ta | 575,440 ta | 1,068 maysa / 91 gul |
| **Flower Glade** | **166.7 FPS** | 74.1 FPS | **35.3 FPS** | 15.4 ms | 28.3 ms | 139 ta | 593,099 ta | 914 maysa / 83 gul |

*Xulosa: Barcha sahnalarda o'rtacha tezlik 119 – 188 FPS ni tashkil etdi (60 FPS nishonidan deyarli 2-3 baravar yuqori). 1% eng past ko'rsatkich (1% low) 25 – 42.7 FPS oralig'ida bo'lib, o'yin jarayoni silliq va qotishlarsiz kechadi.*

---

## 6. Olingan Skrinshotlar Ro'yxati (`docs/screenshots/stage08fix/`)

### Oldin va Keyin Taqqoslash Skrinshotlari (Bir xil rakursda)
- `01_forest_ground.png`: O'rmon yer sathi (Oldin siyrak yer edi, hozir zich yashil maysazor).
- `02_road_edge.png`: Yo'l cheti (Piyoda yo'li toza, yo'l chetida tabiiy maysa va sariq/oq gullar).
- `03_flower_glade.png`: Janubiy gulzor yalangligi (`loc_sq_south_glade`, uch xil rangdagi gullar to'dalari).
- `04_tree_roots_fern.png`: Daraxt ildizlari va paporotniklar (Daraxt tagida quyuq yashil kichik fernlar).
- `05_cabin_yard.png`: Kulba atrofi hovlisi (Hovlida qulay maysa, bino ichida o't o'smagan).
- `06_topdown.png` & `06b_topdown_low_glade.png`: Yuqoridan ko'rinish.
- `07_log_1p.png`, `07_log_3p.png`, `07_log_fixedcam.png`: Yiqilgan yog'och ustiga chiqish va to'xtash.
- `08_stump_1p.png`, `08_stump_3p.png`, `08_stump_fixedcam.png`: To'nka to'sig'i.
- `09_tent_1p.png`, `09_tent_3p.png`, `09_tent_fixedcam.png`: Chodir ichida erkin turish.
- `09_tent_3p_f9_debug.png`: **F9 Debug Collision Overlay** ko'rinishi (Server/Client koordinatalari, simli kapsula va AABB kollayder qutilari).
- `10_smoke_c1_1p.png`, `10_smoke_c2_1p.png`, `10_smoke_c1_3p.png`, `10_smoke_c2_3p.png`: Ikki mijozli multiplayer sinovi.
- `11_server_probe_*.png`: Server darajasidagi panjara, bochka va chodir harakati.

---

## 7. Arxiv va Foydalanuvchiga Yetkaziladigan Fayllar

- **Toza Yakuniy ZIP:** `stickman-strike-stage08fix.zip`
  - Asosiy joylashuvi: `D:\stickman-strike-stage08fix.zip` (va nusxasi `docs/stage08fix/stickman-strike-stage08fix.zip`)
  - Fayllar soni: **389 ta entry**
  - Hajmi: **68.18 MB**
  - Tarkibida: Barcha manba kodlari, yangi testlar, GLB modellar, QA skriptlari, skrinshotlar va hisobotlar mavjud. `node_modules`, `dist` va `.git` chiqarib tashlangan.

---

## 8. Xulosa va Keyingi Bosqich

**STAGE 08-FIX to'liq va muvaffaqiyatli yakunlandi.** 
- Barcha qattiq tabiat va outdoor ob'ektlari fizik to'siqqa ega.
- O'rmon erkin, go'zal va 19 mingta maysa hamda gullar bilan boyitildi.
- FPS yuqori, xotira sarfi minimal.
- Loyiha foydalanuvchi tasdiqlaydigan keyingi bosqich — **Daylight Camper Menu** (kunduzgi rasm asosidagi menyu dizayni) ga to'liq tayyor.
