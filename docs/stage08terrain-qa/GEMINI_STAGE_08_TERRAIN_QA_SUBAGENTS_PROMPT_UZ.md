# CAMPER STRIKE 65 — STAGE 08-TERRAIN-QA: GLB grass first-load bug, true renderer diagnostics, path shader & honest FPS

**Faqat shu bosqichni bajar.** Stage 08B personaj animatsiyalari yoki boshqa katta feature yaratma.

## 0. Asos

- Joriy versiya: `stickman-strike-stage08terrain.zip` / hozirgi `D:\Stickman-strike` repo.
- Auditni to‘liq o‘qi: `STAGE08_TERRAIN_VISUAL_MUSTAQIL_AUDIT_UZ.md`.
- Asosiy aniqlangan xato: `ForestRenderer.ts` `void preloadGrassAssets()` ni kutmaydi, `createGrassRenderer()` esa cache bo‘shligida fallback geometriya bilan `InstancedMesh` quradi. GLBlar keyin yuklanganda mavjud meshlar avtomatik almashtirilmaydi.
- Barcha 9 skrinshot va benchmarklarda `groundCover: null` bo‘lgan, so‘ng 666.7 median FPS hisoboti berilgan, ammo 1% low 2.85 FPS va P99 351.5 ms.
- So‘qmoqlar yaxshilangan, lekin yerning katta bo‘sh-yashil joylari hanuz ko‘rinmoqda. **Avval GLB xatosini tuzat, keyin vizualni sozla.**

## 1. Majburiy parallel sub-agent rejimi

Muhit sub-agentlarni qo‘llasa, kamida 4 ta mustaqil ish paketini parallel yurit, ammo fayl egaligini qat’iy ajrat:

- **Agent A: GLB lifecycle va render** — `src/client/game/grass/GrassAssetRegistry.ts`, `GrassRenderer.ts`, zarur bo‘lsa `GroundCoverRenderer.ts`. Real GLB geometriyalari birinchi kirishdayoq renderlanishi uchun preload barrier yoki GLB kelganda atomik geometry swap/rebuild. Yangi mesh qayta tuzilganida general shared cache dispose qilinmasin. Partial model failure fallback saqlansin.
- **Agent B: Terrain shader va vizual farqlilik** — `src/client/game/terrain/TerrainMaterial.ts`, zarur bo‘lsa `src/shared/forestSquareTerrain.ts`. `smoothstep(0.24, 0.14, ...)` ni belgilangan GLSL tartibiga mos tuzat. Relyefni sun’iy shovqinga to‘ldirma: POI hovli, o‘rmon tagi, mox, tuproq va yo‘l farqi aniq ko‘rinsin. Shared gameplay balandligi yoki colliderga tegma.
- **Agent C: mustaqil regressiya testlari** — `src/shared/__tests__/stage08-terrain-qa.test.ts` hamda kerak bo‘lsa alohida client test fayli. Birinchi kirishda fallback tuzog‘ini va real asset transition ni mock loader bilan tekshir, GLBlar o‘rnatilgan geometriyaga bog‘langanini isbotla; shade/grass categoriyalar balandligi va deterministik input testlarini saqla.
- **Agent D: brauzer QA va benchmark** — `scripts/qa-stage08terrain-qa.mjs`, `docs/stage08terrainqa/*`, `docs/screenshots/stage08terrainqa/*`. Agent A/C integratsiyasi tugagandan so‘ng 1P/3P first-join/rejoin skrinshotlar, diagnostika va real FPS o‘lchovini bajaradi.
- **Coordinator:** `ForestRenderer.ts` va `Game.ts` integratsiyasi, DEV hook API, turli agentlar natijasini birlashtirish, eski kodga regressiya yo‘qligini tekshirish. Bir vaqtda bitta faylni ikki agent tahrirlamasin.

## 2. GLB birinchi yuklanish muammosi — majburiy fix

Real `forest_square` xaritasiga **birinchi marta kirganda**, 17 ta GRASS-ASSET-01 geometriyasi yuklangandan keyin to‘g‘ri ko‘rinishi shart. `getGrassAsset` tomonidan qaytarilgan fallback `InstancedMesh`da abadiy qolib ketmasin.

Oqilona yechimlardan birini tanla:
- `await preloadGrassAssets()` tugaganidan so‘ng renderer yaratish (o‘yin UI qotib qolmasligi, xatoda fallback), yoki
- dastlab fallback yaratib, GLB ready bo‘lganda renderer geometriyalarini **xavfsiz atomik almashtirish** va foydalanuvchi xona ichida bo‘lsa ham qayta chizish.

Registry bilan scene ownership aniq bo‘lsin; `assetCache` ichidagi yangi assetlar scene meshlariga haqiqatan bog‘lansin. `getGrassAsset()` fallback cache to‘ldirgan holat preloadni erta o‘chirib qo‘ymasligi kerak. `dispose` umumiy GLB va materialni buzmasin.

## 3. Verifikatsiyalanadigan DEV diagnostika

`window.__DEV_GAME_TOOLS__` ichiga diagnostika getterlar qo‘sh (faqat development):

`getGroundCoverStats()` → real `visibleGrass`, `visibleFlowers`, `visibleFerns`, `visibleChunks`, `drawCalls`, `visibleTriangles`, `uploads`.

`getGrassAssetDiagnostics()` → `loadedGLBCount`, `failedGLBCount`, `activeGLBVariantCount`, `activeFallbackVariantCount`, `totalActiveInstances`, hozirgi quality, har bir variantning real `isFallback` holati.

**Faqat 17 GLB fayl mavjudligi yoki cache ready bo‘lgani PASS emas.** Faol `InstancedMesh.geometry` qayerdan kelgani tasdiqlansin. QA natijasida `groundCover: null` bo‘lishiga ruxsat berilmasin.

## 4. Haqiqiy render va o‘yin sifati

- Birinchi kirish 1P ko‘rinishi va shu joyga qayta kirish 1P ko‘rinishi taqqoslansin; procedural → GLB farqi bo‘lmasin.
- 3P, yo‘l cheti, daraxt soyasi, gullar, ochiq meadow uchun **bir xil kameradan oldin/keyin** PNG oling.
- Qo‘shimcha o‘tlar qo‘shishga shoshilma. GLB bilan ishlayotgan mavjud 19,123 ta cover instance qanday ko‘rinishini ko‘r, keyin faqat zarur biomlarda masshtab, rang va klasterlashni o‘zgartir. Past qismidagi yo‘l markazi ochiq qolsin. PvP uchun past balandlik chegaralarini saqla.
- Yo‘l tuproq ekanligi o‘yinchi balandligidan aniq bilinishi, daraxt soyasidagi yer butunlay bir xil yashil bo‘lmasligi kerak. VRAM va frametime ko‘rsatkichlarini oshirib yuborma.

## 5. Benchmarkni to‘g‘rilash

Avvalgi QA Chrome bilan `--disable-gpu-vsync` va `--disable-frame-rate-limit` ishlatgan va alohida rAF observer orqali 666 FPS ko‘rsatgan. Buni production gameplay FPS deb nomlama.

- Chrome normal frame pacing rejimida ishlasin (VSync/frame-limit flagsni majburan o‘chirma).
- O‘yinning mavjud `startBenchmarkCapture()` / `stopBenchmarkCapture()` APIlaridan foydalan; benchmark real game render framelariga bog‘langan bo‘lsin.
- Kamida bir necha asosiy sahnada kamera aylanishi va yurish bilan FPS, 1% low, P95/P99 frame time, draw calls, triangles, groundcover diagnosticsni yoz.
- Ilk fast smoke QA qisqa; **yakuniy benchmarkni faqat bir marta** barqaror koddan keyin bajar. O‘lchov qurilmasi, quality, render scale, ekrani va ishlatilgan flagsni aniq qayd et.
- Agar 1% low pasaysa, nima sabab bo‘lganini ochiq yoz; natijalarni uydirma yoki faqat eng yuqori median bilan cheklanma.

## 6. Testlar va regres­siya

- `npm run typecheck`, `npm test`, `npm run build`. `src/client/game/terrain/__tests__/terrain.test.ts` mavjud `npm test` globidan tashqarida: uni ham test komandasi haqiqatan ishlatadigan qilib sozla yoki tegishli shared test katalogiga ko‘chir. WebGL2 shader compile sinovi bilan mustahkamla.
- Oldingi 157 test saqlansin, kerakli yangi testlar qo‘shilsin.
- `seed 6501` uchun `gameplayHash='670a9c21f0565c94'`, 36 spawn, 26 konteyner, 2341 collider o‘zgarmasin.
- Avvalgi 36 GLB + 17 grass GLB jami 53 ta model saqlansin.
- 2-client `forest_survival` smoke test: start, loot, equip, movement va round reset regressiyasi yo‘q.
- Fallback xato bo‘lsa, kamida bitta GLBni sun’iy muvaffaqiyatsiz yuklash testida qolgan 16 variant normal ko‘rinsin.

## 7. Qabul qilish uchun majburiy natijalar

1. Haqiqiy birinchi kirishda 17/17 GLB faol, `activeFallbackVariantCount = 0` (barcha GLB muvaffaqiyatli yuklangan holda).
2. Debug va QA `groundCover` real ko‘rsatkichlarini qaytaradi, `null` emas.
3. Birinchi kirish va qayta kirish skrinshotlari **bir xil kameradan** olingan, farq hujjatlashtirilgan.
4. O‘rmon yerining ko‘rinishi foydalanuvchi yuborgan eski skrinshotga nisbatan aniq yaxshilangan. Yo‘l, ochiq maydon va daraxt soyasi kamida uch xil rang/material hissini berishi kerak.
5. Server-authoritative multiplayer va 07-QA xavfsizlik tuzatishlari saqlanadi.
6. Tests/build muvaffaqiyatli; haqiqiy FPS, 1% low, p99 asosida hisobot; ZIP va sahna screenshotlari.

Yakunida qisqa o‘zbekcha hisobot, yangilangan kod ZIPi, haqiqiy skrinshotlar va diagnostika JSONni topshir. **08B yoki 08C ni boshlama.**
