# CAMPER STRIKE 65 — BOSQICH 08-TERRAIN-ART-POLISH

**Maqsad:** 08-TERRAIN-QA dan keyin yer, o‘rmon tagi va tuproq so‘qmoqlarini **ko‘zga yaqqol chiroyliroq** ko‘rsatish. Faqat GLB mavjudligini yoki instansiyalar sonini isbotlash yetarli emas: **birinchi kirishdagi 1P/3P o‘yin kadrlarida ham boy, tabiiy, original stilizatsiyalangan o‘rmon muhiti** sezilsin.

**So‘nggi asos:** `stickman-strike-stage08terrain.zip` (08-TERRAIN-QA versiyasi). Uni va mavjud `D:\Stickman-strike` reposini to‘liq tekshir. Ishni har doim joriy koddan boshlagin, eski fayllarni ko‘r-ko‘rona qayta yozma.

## 0. Qat’iy chegaralar

- Faqat **08-TERRAIN-ART-POLISH** ni bajar. `08B` animatsiyalar, `08C` HUD va boshqa bosqichlarga o‘tma.
- Forest Survival, loot, 26 konteyner, 36 spawn, 6 POI, oldingi 36 GLB + yangi 17 GLB (**53 ta**), multiplayer va Stage 07-QA/08-FIX collider tuzatishlarini saqla.
- Avvalgi `gameplayHash` / shared fizik dunyoni faqat bezak sabab o‘zgartirma. Yangi bezaklar **vizual-only** bo‘lsin. Server hitbox yoki harakat kollayderlarini yashirincha o‘zgartirma.
- Original vizual uslub, RV There Yet? dan aynan model/tekstura ko‘chirish yo‘q. Target — sifatli **stylized low/mid-poly**, fotorealistik emas.
- O‘yinchiga ko‘rinmaydigan masshtabdagi minglab element qo‘shib, hisobotda faqat son bilan maqtanma. **Yaqin kameradagi ko‘rinishni** asosiy natija deb ol.
- Birinchi kirish va qayta kirishda `17/17` haqiqiy o‘simlik GLB, `0` faol procedural fallback saqlansin.

## 1. Avval ART BASELINE va audit

Quyidagi mavjud kodlarni tekshir:

- `src/shared/forestSquareTerrain.ts` (`sampleForestSquareTerrainColor`)
- `src/client/game/terrain/TerrainMaterial.ts` (`createEnhancedTerrainMaterial`)
- `src/shared/groundCover.ts` (`GROUND_COVER_TARGET_TOTAL`, patch/cluster generatsiyasi)
- `src/client/game/grass/GrassVariantPlanner.ts`
- `src/client/game/grass/GrassRenderer.ts`
- `src/client/game/grass/GrassAssetRegistry.ts`
- `src/client/game/GroundCoverRenderer.ts` va `ForestRenderer.ts`
- `src/shared/forestSquareRoads.ts`

Joriy medium preset va `seed=6501` asosida, o‘yin ichidagi **bir xil kamera** koordinatalaridan kamida 8 ta `BEFORE` skrinshot ol: ochiq o‘tloq 1P/3P, daraxt soyasi, gul yalangligi, tuproq yo‘li, yo‘l cheti, POI hovlisi, yuqoridan xarita. Screenshotlarda debug overlay yoki HUD kadrni to‘liq to‘smasin. GLB diagnostikasini ham yoz.

Rasmlarda kuzatilgan muammolarni (bir xil yashil yirik poligonlar, o‘tning siyrakligi va kichik ko‘rinishi, yo‘llarning ba’zi joyda yo‘qolishi, sun’iy bir xil spacing, uzoqda qattiq o‘chib qolish) tekshir va sababini aniqlab hujjatlashtir.

## 2. MAJBURIY sub-agent parallel ish taqsimoti

Agar sub-agentlar mavjud bo‘lsa, bir vaqtda mustaqil ishlarni ularga ber. **Bir faylga ikki agent yozmasin.** Asosiy Gemini koordinatsiya, umumiy arxitektura, integratsiya va yakuniy tasdiq uchun javobgar.

| Agent | Egallaydigan fayllar (asosiy) | Natija |
|---|---|---|
| **A — Terrain Art** | `src/client/game/terrain/TerrainMaterial.ts`; zarur bo‘lsa alohida terrain vizual helper | Tuproq, mox, igna/barg to‘shamasi, tosh/shag‘al va rang o‘tishlari; yirik bir tusli poligonlarni sezilarli kamaytirish |
| **B — Soil Roads** | `src/shared/forestSquareTerrain.ts`dagi **rang sampler**, kerak bo‘lsa yangi `src/client/game/terrain/*RoadVisual*` | Egri-bugri **aniq ko‘rinadigan** tuproq yo‘l va tabiiy notekis chetlar; relyef heightfield/geometriya/fizika o‘zgarmasin |
| **C — Vegetation Art & Distribution** | `src/shared/groundCover.ts`, `src/client/game/grass/GrassVariantPlanner.ts` | 17 GLB o‘simliklarni turlicha bo‘y, rang, shamol/soya va biomga mos **tabiiy klaster**larda joylashtirish; kamida 3 xil zichlik zonasi |
| **D — Grass Rendering & Performance** | `src/client/game/grass/GrassRenderer.ts`, kerak bo‘lsa asset-material yordamchi fayli | Instancing, materialning ikki tomonlama ko‘rinish muammosi (tekshirib), kameradan masofaga LOD, culling, kadr barqarorligi |
| **E — Automated QA** | Yangi `src/shared/__tests__/stage08-terrain-art-polish.test.ts` va tegishli o‘ziga tegishli testlar | Regressiya va deterministik dekor testlari, gameplayHash, world init, yo‘l maski, GLB readiness, 1P/3P fairness |
| **F — Browser Visual/Perf QA** | Yangi `scripts/qa-stage08-terrain-art-polish.mjs`, `docs/stage08terrain-art-polish/*` | Bir xil kameradagi BEFORE/AFTER, ikki mijozli smoke, realistic FPS va xotira testi |

**Coordinator** `ForestRenderer.ts` va boshqa umumiy integratsiya fayllariga o‘zi tegadi. Har bir agent yakuniy natija, o‘zgargan fayllar va testlarini aniq bildiradi. Sub-agent mavjud bo‘lmasa, ishlatdim deb da’vo qilma.

## 3. Yer uchun art direction (asosiy ustuvorlik)

Hozirgi muammo: juda keng yashil tekislik, arang ko‘rinadigan vizual mikrotekstura va tabiiy tuproq qatlamlari yo‘qdek taassurot.

Quyidagi makro + mikro kombinatsiyani amalga oshir:

1. **Makro (3–25 m):** butun sahna bir rang bo‘lmasin; iliq zaytun-yashil o‘tloq, qoramtir nam mox, xira sarg‘ish quruq yer, jigarrang chirindi/pine-needle, kulrang toshli maydonlar. Biomga bog‘liq va silliq o‘tishlar. Bir xil takroriy checker shovqin emas.
2. **Mezo (0.5–3 m):** tabiiy mox yamoqlari, to‘kilgan igna/barg, tuproq ko‘rinadigan joylar, mayda shag‘al. Yirik bo‘sh yashil joylar sezilarli kamayishi kerak.
3. **Mikro (0.1–0.5 m):** yengil tuproq/shag‘al donadorligi, lekin aliasing/shimmering va kuchli kontrast hosil qilmasin.
4. Rang palitrasi tasdiqlangan kunduzgi **Daylight Camper** sahnasidagi iliq, tabiiy ranglarga yaqin bo‘lsin, ammo oddiy shader bilan nisbiy chiroyli low-poly uslub saqlansin.
5. Shader faqat har kadrga qimmat dinamik shovqin qatlamlarini qo‘shishdan iborat bo‘lmasin; oldin/so‘ng screenshotda haqiqiy ko‘rinadigan farq paydo bo‘lsin. Iloji boricha arzon world-space shader, yengil vertex color va qayta ishlatiladigan material ishlat.

## 4. So‘qmoqlar / tuproq yo‘llari

- `sampleForestSquareRoad()` va mavjud shader/vertex-color yo‘l tizimini saqla.
- Bir xil seed va kamerada yo‘llar o‘rmondan **aniq ajralib tursin**: tuproq jigarrang, quruq/qoramtir rang farqi, ayrim ingichka shag‘al va o‘rtadagi oyoq/g‘ildirak izlari.
- Yo‘l chekkalari tekis geometrik tasma emas, yengil notekis o‘tish bilan tuproq/mox/maysa zonasiga qo‘shilsin.
- Yo‘l markazidagi piyoda yurish hududi o‘tdan toza; yo‘l chetida egilgan past o‘tlar va siyrak gullar tabiiy ko‘rinsin.
- Faqat vizual rang va tekstura bilan ish ko‘r; terrain collider, step-height, road slope va server world geometry o‘zgarmasin.
- POI hovlisidagi tuproq bilan yo‘l orasida ko‘rinadigan, uzilmagan rang o‘tishi bo‘lsin.

## 5. O‘tlar, gullar va paporotniklar — sifatga yo‘naltirilgan joylashuv

- 17 GLB haqiqatan ishlasin; `getGrassAssetDiagnostics()`/`getGroundCoverStats()` orqali isbotla.
- Joriy `GROUND_COVER_TARGET_TOTAL ≈ 19200` ni avtomatik 2–3 barobarga oshirma. Avval **mavjud budjetni joyida qayta taqsimlash** va 1P/3P ko‘z darajasidagi ko‘rinishni yaxshila.
- 3 ta asosiy hudud: (1) zichroq o‘tloq / POI chetlari, (2) daraxt ostidagi siyrak o‘t + to‘kilgan igna/mox + paporotnik, (3) ochiq yalanglik yo‘l chetida past maysa/gul klasterlari. O‘yin davomida keraksiz gullar gilami bo‘lmasin.
- Ko‘rinadigan o‘tlarning eni, burilishi, umumiy silueti va material contrastini tekshir; kichik ingichka 3D model past masofada 1–2 piksel bo‘lsa, **siluetni sifatli ko‘rsatadigan klaster yoki o‘lcham sozlamasini** tanla. Sun’iy bir xil masshtab/oraliqdan qoch.
- `FrontSide` tufayli yupqa barglar boshqa burchakdan ko‘rinmay qolmayotganini 1P va 3P da ko‘r; kerakli modellardagina `DoubleSide` ishlatish mumkin, lekin ortiqcha overdrawni o‘lchab ko‘r.
- O‘t ≤0.45m, gul ≤0.35m, fern ≤0.60m PvP balandlik cheklovlari; binoning eshigi, spawn nuqtasi, konteyner interaction joyi, yo‘l markazi yopilmasin.
- Client camera masofasiga bog‘liq LOD boshqa o‘yinchining server colliderini, line-of-sight qoidalarini yoki gameplay hashni o‘zgartirmasin.
- Instance ranglari va yorug‘lik mosligi, yaqin/katta soya va pop-in tekshirilsin. Oddiy yer bilan kontrast doim juda keskin bo‘lmasin.

## 6. Performance mezonlari

- Intel UHD 730, WebGL 2.0, 1280×720, medium/low presetlarda tekshir. Realdagi uzluksiz brauzer FPSni o‘lcha, `--disable-frame-rate-limit`, `--disable-gpu-vsync` bilan sun’iy FPS oshirma.
- **60 FPS atrofida barqaror ishlash** maqsad; 1% low, p95/p99 frame time, draw calls, visible GLB instances, shader compile warning va GPU memory/qayta yuklash xatti-harakatini yoz.
- Eski baseline va yangi versiyani *aynan bir xil hardware, sifat, seed, kamera va o‘lchov metodikasi* bilan solishtir. FPS pasaygan bo‘lsa yashirma.
- 5s warmup + kamida 15s o‘lchov × 2 takror yetarli. Fast QA → integration QA → bitta aniq benchmark. Keraksiz qayta-qayta uzun benchmark yo‘q.
- 1P va 3P ochiq hududlar, yo‘l, POI hovlisi, daraxt soyasi, mobilga yaqin low sozlamada test.

## 7. Vizual qabul mezonlari — testlar bilan birga majburiy

- **BEFORE vs AFTER:** kamida 8 juft PNG, kamera koordinatalari, yaw/pitch/FOV va quality bir xil. 1280×720 va kamida 1 ta 1920×1080.
- 1P/3P da kamera yaqinidagi yer tabiiy maysa/mox/tuproq va o‘simliklardan iborat bo‘lsin. Ko‘p maydonning bir xil yashil rangligidan ko‘ra vizual ko‘rinadigan xilma-xillik kuzatilsin.
- Yo‘lning uzoqroq qismlarida ham yo‘nalish oson bilinishi kerak. Devor/eshiklar va o‘yinchini yashiradigan yangi bezak bo‘lmasin.
- Birinchi kirish va rejoin: 17/17 GLB, 0 fallback; xuddi shu scene deterministik bo‘lsin.
- `npm test`, `npm run typecheck`, `npm run build` haqiqiy bajarilsin. Ikki mijozli Survival, loot, inventory, spectator, collision/f9 smoke testlar regressiyasiz o‘tsin.
- **Rasm chindan yaxshilanmagan bo‘lsa, “100% visual PASS” deb e’lon qilma.** Texnik PASS va art-review holatini alohida yoz. Yakuniy vizual ma’qullash foydalanuvchiga tegishli.

## 8. Yakuniy hisobot va handoff

Taqdim et:

1. O‘zbekcha `docs/stage08terrain-art-polish/INTEGRATION_REPORT_UZ.md`.
2. O‘zgargan fayllar, sub-agentlar va har birining real vazifasi.
3. 8+ ta `before_after` rasm juftlari (real Chrome), yaqin 1P/3P va ground close-up.
4. GLB diagnostics va material/instance sonlari, `gameplayHash`, xavfsiz spawnlar, multiplayer natijalari.
5. Bir xil sinov sharoitida FPS va kadr vaqtining oldin/keyin jadvallari, 1% low.
6. Keraksiz `node_modules`, `dist`, `.git`, eski ZIPlarni chiqarib tashlagan yangilangan **toza loyiha ZIP**. Eski report/skrinshotlarni ham zaruratdan ortiq qadoqlama.
7. Qolgan vizual kamchiliklarni ochiq ro‘yxatla.

**Faqat 08-TERRAIN-ART-POLISH ni bajar. Keyingi bosqichga o‘tma.**
