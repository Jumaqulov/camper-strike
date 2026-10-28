# scripts/ — QA harnesslari va yordamchi skriptlar

Bu papkadagi skriptlar `npm test` ga kirmaydi: ular bosqichma-bosqich (stage) ishlab chiqish davomida
yozilgan brauzer QA harnesslari, benchmarklar va asset yordamchilari. Ko'pchiligi haqiqiy
Chrome va tashqi dasturlarga muhtoj, shuning uchun ularni qo'lda ishga tushirasiz.

## Talablar (qa-stage*.mjs, benchmark-forest.mjs, prod-smoke-08b.mts)

- **Haqiqiy Chrome** — skriptlar Chrome'ni CDP (DevTools protokoli) orqali boshqaradi. Chrome yo'li
  `CHROME_PATH` muhit o'zgaruvchisi orqali beriladi (berilmasa standart Windows o'rnatish yo'llari
  sinab ko'riladi):
  ```powershell
  $env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
  node scripts/qa-stage08fix.mjs
  ```
- **ffmpeg** — ekran yozuvlarini (`.webm`/`.mp4`) yig'ish va kadrlarni solishtirish uchun `PATH` da bo'lishi kerak.
- Skriptlar o'zlari **alohida portlarda** o'yin serveri (`tsx src/server/index.ts`) va Vite dev serverini
  ishga tushiradi (3000/5173 bilan to'qnashmaydi) va ishi tugagach ularni to'xtatadi.
- Natijalar (`qa_*.json`, skrinshotlar, videolar) `docs/<stage>/...` ichiga yoziladi. Rasm/video fayllar
  `.gitignore` da (`docs/**/*.png`, `*.webm`, `qa_shots/`, `qa_videos/`) — ular hech qachon commitga kirmaydi.

## Skriptlar ro'yxati

| Skript | Nima qiladi |
|---|---|
| `benchmark-forest.mjs` | Bosqich 03.5 — takrorlanuvchan o'rmon benchmark'i va PvP adolat tekshiruvi (`--warmup`, `--duration`, `--repeats`) |
| `qa-stage04a.mjs` | Bosqich 04A — bino/loot/interyer GLB assetlari: WebGL skrinshotlar va benchmark |
| `qa-stage04b.mjs` | Bosqich 04B — `forest_square` (256×256 m, 6 POI, yo'llar) brauzer QA |
| `qa-stage05.mjs` | Bosqich 05 — server-avtoritativ harakat, bashorat/reconciliation, 2 klient sinxron, kechikish/paket yo'qolishi |
| `qa-stage06.mjs` | Bosqich 06 — qurolsiz boshlash, loot qutilari, inventar; 2 klient loot sinxron va race-condition QA |
| `qa-stage07.mjs` | Bosqich 07 — Forest Survival to'liq sikli (kutish → sanoq → o'yin → kuzatuvchi → g'olib → yangi raund) |
| `qa-stage07-qa.mjs` | Bosqich 07-QA — 3 klientli tezkor survival smoke test |
| `qa-stage08a.mjs` | Bosqich 08A — OUTDOOR-ASSET-01 tashqi muhit modellari integratsiyasi (2 klient, instanced batchlar, belgi ustunlari) |
| `qa-stage08fix.mjs` | Stage 08-FIX — kolliziya, relyef va o't qoplami QA (DEV tools, kamera override) |
| `qa-stage08menu.mjs` | Stage 08-MENU-POLISH — kunduzgi kemping menyusi va lobby UX (bir nechta viewport) |
| `qa-stage08terrain.mjs` | Stage 08-TERRAIN-VISUAL — relyef vizuali: 8 kamera burchagidan skrinshot va benchmark |
| `qa-stage08terrain-qa.mjs` | Stage 08-TERRAIN-QA — 17/17 GLB o't modeli yuklanishi, first-join vs rejoin solishtirish, halol benchmark |
| `qa-stage08-terrain-art-polish.mjs` | Stage 08-TERRAIN-ART-POLISH — bir xil kameradan aniq skrinshot solishtirish va benchmark |
| `qa-stage08b-char.mjs` | Stage 08B-CHAR — Camper Buddy skinned personaj: animatsiya, qurol biriktirish, ko'p klient QA |
| `prod-smoke-08b.mts` | Stage 08B — **production** `dist/` bundle bilan haqiqiy (headful) Chrome, faqat haqiqiy kirish; `qa-lib/` fokus yordamchilaridan foydalanadi |
| `qa-lib/focus-guard.mts`, `qa-lib/os-focus-helper.ps1` | prod-smoke uchun Windows fokus / pointer-lock qo'riqchisi (Win32 yordamchi) |
| `stage08fix-baseline.ts` | Deterministik dunyo bazasi (gameplayHash, kollayder soni, chodir kapsula problari): `npx tsx scripts/stage08fix-baseline.ts [seed ...]` |
| `compare-png.mjs` | Tashqi kutubxonasiz PNG dekoder va ikki skrinshotni piksel bo'yicha solishtirish |
| `generate-knife-glb.mjs` | `public/models/weapons/knife.glb` ni sof Node bilan generatsiya qiladi (`node scripts/generate-knife-glb.mjs`) |
| `extract-grass-assets.mjs` | GRASS-ASSET-01 zip paketini `public/models/grass/` ga ochadi: `node scripts/extract-grass-assets.mjs <zip>` |
| `create-zip.ps1` | Loyihani (node_modules, dist, .git siz) zip ga yig'adi: `powershell -File scripts/create-zip.ps1 [-ZipPath ...]` |

## Eslatmalar

- `qa-stage05.mjs` va `qa-stage06.mjs` `forest_square` + `publicLayoutSeed=6501` uchun `gameplayHash`
  qiymatini **`b9f85b7f2fe01575`** deb tekshiradi (joriy dunyo versiyasi; `src/shared/__tests__/stage08-terrain-art-polish.test.ts`
  bilan bir xil). Dunyo generatori gameplay'ga ta'sir qiladigan tarzda o'zgarsa, bu konstantani ham yangilang.
- qa-stage* harnesslari o'z bosqichi holatiga mo'ljallangan "tarixiy" skriptlar: keyingi bosqichlardagi
  o'zgarishlar (masalan, yangi assetlar soni) ularning ayrim tekshiruvlarini eskirtirgan bo'lishi mumkin.
  Ular qayta yozilmagan — kerak bo'lsa faqat tegishli bosqich uchun ishlating.
- GLB asset validatorlari `tools/` papkasida: `npm run validate:assets`.
