# CAMPER STRIKE 65 — STAGE 08-TERRAIN-VISUAL mustaqil audit

**Sana:** 2026-10-22  
**Manba:** foydalanuvchi yuborgan `stickman-strike-stage08terrain.zip` va Gemini hisoboti  
**Xulosa:** shartli qabul — terrain yo‘li va GLB fayllar integratsiyasi mavjud; **birinchi kirishda GLB o‘tlar procedural fallbackda qolishi mumkin**. Bu tuzatilmasdan to‘liq vizual qabul qilinmaydi.

## 1. Mustaqil tekshiruvlar

- Arxiv yaxlit: `ZipFile.testzip()` xato bermadi; **482 ta fayl yozuvi** mavjud.
- Siz yuborgan ZIPning haqiqiy hajmi: **94,181,453 bayt (taxminan 94.2 MB / 89.8 MiB)**. Hisobotdagi **316.8 MB** bilan nomuvofiq; qaysi yig‘ilish ekani aniq tekshirilsin.
- `public/models` ichida jami **53 ta GLB**; ulardan **17 tasi `public/models/grass/`** ichida. 53/53 fayl GLB 2.0 sarlavha/hajm tekshiruvidan o‘tdi. O‘t GLBlari hajmi jami **211,640 bayt**.
- Avvalgi Stage 08-MENU-POLISH ZIP bilan solishtirganda mavjud `src` fayllaridan faqat `ForestRenderer.ts`, `GroundCoverRenderer.ts` va `forestSquareTerrain.ts` o‘zgargan, grass/shader/planner va tegishli test modullari yangi qo‘shilgan. Server/loot/survival manba fayllari o‘zgarmagan.
- Yangi `stage08-terrain-visual.test.ts` sinovlarini TypeScript yordamida JSga kompilyatsiya qilib ishga tushirdim: **5/5 PASS**. Bunda Node tiplari o‘rnatilmagani sabab `tsc` tip tekshiruvining o‘zi to‘liq PASS emas; alohida bajarilgan JS testlari muvaffaqiyatli. Gemini hisobotidagi **157/157** umumiy testni bu muhitda mustaqil qayta bajarmadim.
- Haqiqiy generatorning `seed=6501` natijasi: `gameplayHash = 670a9c21f0565c94`, relyef 256×256 m, **2341 collider**, **36 spawn**, **26 loot konteyneri**. Shu seed uchun oldingi xesh saqlangan.

## 2. P1 — Birinchi kirishda haqiqiy GLB geometriyasi ishlatilmasligi

**Kod:**
- `src/client/game/ForestRenderer.ts` 718–720: `void preloadGrassAssets();` — asinxron yuklanish natijasi kutilmaydi.
- Shu fayl 1332–1337: `createGroundCoverRenderer(...)` darhol sinxron quriladi.
- `src/client/game/grass/GrassRenderer.ts` taxm. 190–195: `getGrassAsset(variantId)` chaqiriladi, qaytgan `asset.geometry` bevosita `InstancedMesh`ga beriladi.
- `src/client/game/grass/GrassAssetRegistry.ts` 543–561: asset hali yuklanmagan bo‘lsa procedural fallback yaratilib cachega joylanadi.
- Xuddi shu registrning 521–529 satrlarida haqiqiy GLBlar keyinroq cachega yoziladi. **Oldin qurilgan `InstancedMesh.geometry` o‘zgartirilmaydi.**

**Oqibat:** birinchi `forest_square` kirishida procedural modellar chizilishi; GLB yuklangach ham sahnada qolib ketishi; qayta kirganda ko‘rinish o‘zgarishi mumkin. 17/17 fayl mavjudligi GLB real render bo‘layotganiga dalil emas.

**Tuzatish talabi:** birinchi kirishda ham yuklanish tugagach GLB batchlarini xavfsiz rebuild/swap qilish yoki birinchi renderdan oldin asinxron preloadni kutish. Fallback faqat xatoli/mavjud bo‘lmagan model uchun. `dispose` va umumiy cache ownership xavfsiz bo‘lsin. Diagnostika: **loadedGLBs**, **activeGLBVariantCount**, **activeFallbackVariantCount**, **activeInstanceCount**; renderda amalda ishlayotgan geometriya manbasi tekshirilsin.

## 3. P1 — QA real GLB ishlayotganini umuman o‘lchamagan

`docs/stage08terrain/qa_terrain_summary.json` ning **hamma 9 skrinshoti** va **4 benchmarki** ichida `groundCover: null`. Sababi `scripts/qa-stage08terrain.mjs` funksiyalarni `window.__DEV_GAME_TOOLS__` dan qidiradi, ammo `Game.ts` ushbu getterni e’lon/eksport qilmaydi (diagnostika hozir faqat DEV HUD matnida mavjud).

**Talab:** `getGroundCoverStats()` va `getActiveGrassAssetDiagnostics()` DEV hook orqali berilsin; 1P, 3P, birinchi kirish, takror kirish, `low/medium/high` sifatlarda fallback/GLB/visible instance sonlari real CDP test bilan yozilsin. `groundCover: null` QA PASS hisoblanmasin.

## 4. P1 — FPS raqamlari yakuniy barqarorlikni ko‘rsatmaydi

`qa-stage08terrain.mjs` Chrome'ni `--disable-frame-rate-limit` va `--disable-gpu-vsync` bilan ishga tushiradi, `requestAnimationFrame` delta orqali hisoblaydi. Hisobotda yuqori `median FPS` keltirilgan, ammo asosiy ma’lumotlarning muhim qismi quyidagicha:

| Sahna | Median FPS | 1% low FPS | P99 frame ms |
|---|---:|---:|---:|
| Ochiq o‘rmon | 666.7 | **2.85** | **351.5** |
| Servis | 555.6 | **2.73** | **366.5** |
| O‘rmon lageri | 454.5 | **3.35** | **298.7** |
| Yo‘l | 476.2 | 161.3 | 8.1 |

**Talab:** ishlab chiqarishga yaqin Chrome sharoitida, frame-rate limiter/VSync o‘chirilmagan holda, **kamera harakati va real gameplay bilan** test. QA vositasi o‘zining qo‘shimcha `requestAnimationFrame` dövrini emas, haqiqiy o‘yin frame vaqtlarini (`startBenchmarkCapture/stopBenchmarkCapture`) o‘lchasin. 1% low, P95/P99 va stutter sabablarini keltirsin. Sharoit va konfiguratsiya barqaror bo‘lsin.

## 5. P2 — Shaderda aniqlik uchun to‘g‘rilanishi kerak bo‘lgan ifoda

`src/client/game/terrain/TerrainMaterial.ts` da ikki joyda `smoothstep(0.24, 0.14, ...)` ishlatilgan. GLSL `smoothstep(edge0, edge1, x)` uchun `edge0 >= edge1` bo‘lsa natija **aniqlanmagan**. Buni `1.0 - smoothstep(0.14, 0.24, ...)` tarzida almashtirib, haqiqiy WebGL2 shader compile/render sinovi bilan tekshirish tavsiya qilinadi.

## 6. P2 — Ayrim yangi shader testlari npm test ichida ishlamayapti

`package.json` da `npm test` faqat `src/shared/__tests__/*.test.ts` fayllarini ishlatadi. Yangi `src/client/game/terrain/__tests__/terrain.test.ts` esa **bu globdan tashqarida**, shu sabab uning shader (`onBeforeCompile`) tekshiruvlari 157 ta regressiya testiga kirmaydi. Uni umumiy test skriptiga qo‘shish yoki shared test katalogi orqali bajarish, WebGL shader compile sinovini qo‘shish kerak.

## 7. Vizual baho

- **Ijobiy:** so‘qmoq ranglari eski bir xil yashil relyefga qaraganda ancha ajralib turadi; yo‘l va mox/soil mikrodetal kodi mavjud; GLB fayllar keltirilgan.
- **Kamchilik:** 9 ta skrinshotning bir qanchasida katta maydonlar hanuz bir tekis yashil ko‘rinadi; yaqin maysalar/gullar o‘rmonning umumiy hajmiga mos ravishda yetarli sezilmaydi. Yuqoridagi P1 GLB yuklanish xatosi buni izohlashi mumkin.
- **Shart:** avval haqiqiy GLB ishlashini tuzatish; keyin bir xil kamerada oldin/keyin, o‘t zichligi, rang, balandlik, guruhlanish va so‘qmoq chetlarini did bilan sozlash. Faqat instansiya sonini oshirish shart emas.

## 8. Qabul mezonlari

- [ ] **Birinchi kirishda** barcha 17 variant real GLB geometriyasini ishlatadi; CDN/asset xatosi bo‘lsa fallback aniq qayd etiladi.
- [ ] GLB yuklangach faol meshlar qayta quriladi/almashtiriladi; boshqa xona bilan umumiy resurslar buzilmaydi.
- [ ] DEV/QA da `groundCover` diagnostikasi `null` emas, real variant va instance sonini ko‘rsatadi.
- [ ] Terrain shader WebGL2 da xatosiz; teskari `smoothstep` tuzatilgan.
- [ ] Bitta kamera koordinatasida birinchi kirish + qayta kirish ko‘rinishi mos; 1P/3P screenshotlar solishtiriladi.
- [ ] Real brauzer performance testi 1% low va P99 bilan keltiriladi; sun’iy “666 FPS” o‘yin optimizatsiyasi deb taqdim etilmaydi.
- [ ] 157 mavjud regression testi, typecheck, build va ikki mijozli survival smoke-test muvaffaqiyatli.
- [ ] Faqat vizual komponent o‘zgarsin; world hash `670a9c21f0565c94`, 36 spawn, 26 konteyner, 2341 collider, 36+17 GLB asset saqlansin.

**Hukm:** 08-TERRAIN-VISUAL kod poydevori mavjud, lekin **GLBning birinchi kirishda real renderlanishi isbotlanmagani va QA FPS metodikasi noto‘g‘riligi sabab shartli qabul**. Kichik `08-TERRAIN-QA` bosqichi tavsiya etiladi. Uning yakunidan keyin foydalanuvchi o‘zi localhostda o‘ynab vizualni ma’qullashi kerak.
