# Camper Strike 65 — Stage 08B-PRODUCTION-SMOKE yakuniy QA hisoboti

**Sana:** 2026-10-26 · **Repo:** `D:\Stickman-strike` (worktree `camper-buddy-rig-fixes-d8c9de`), HEAD `730c4e7` + ushbu bosqichning commit qilinmagan harness o‘zgarishlari
**Qurilma:** Intel Core i5-14400 (16 oqim), 32 GB RAM, **Intel UHD Graphics 730**, 2 × 1920×1080 @ 60 Hz, Windows 11 (26300), Chrome 155.0.8059.86
**Build:** `npm run build` → `dist/assets/index-K39zGHOx.js` (boshqa kompyuterdagi build bilan bir xil hash), 54 GLB, Camper Buddy GLB `a898d979…` 610 972 B.

## Yakuniy qaror

Pointer lock va fokus muammosi **hal qilindi**. TDM 2-mijoz, Camper Buddy holatlarining tarmoq orqali uzatilishi, console/network/WebGL/asset tekshiruvlari **PASS**. Ular ikki mustaqil real yugurishda, faqat fokus to‘g‘ri bo‘lgan intervallarda o‘lchangan (22/22 interval VALID).

FFA, Forest Survival, B mijozdagi Buddy vizuali va VSync benchmark **NOT_TESTED**. Bu qismlar sinovda bajarilgan, lekin saqlangan dalili yo‘q (3-bo‘limga qarang). Foydalanuvchi qarori bilan qo‘shimcha vizual sinov to‘xtatildi. **08C boshlanmagan.**

## 1. Natijalar jadvali

Manba: `runs/2026-10-26T06-19-35_tdm/prod_smoke.json` (R1) va `runs/2026-10-26T06-40-08_partial/prod_smoke.json` (R2).

| # | Talab | Tekshiruv | Holat | Dalil / qiymat |
|---|---|---|---|---|
| 1 | TDM — 2 real Chrome, bitta roomId | welcome, bitta roomId, gameplayHash, worldVersion | **PASS** | R1 `r1sjh6/r1sjh6`, R2 `r1auaa/r1auaa`; hash `670a9c21f0565c94`; worldVersion 2 |
| 1 | | Bir-birini ko‘rish (server snapshot) | **PASS** | R1, R2 |
| 1 | | Pointer lock (haqiqiy klik, foreground oyna) | **PASS** | A va B: 1-urinishda (R1, R2) |
| 1 | | Mouse look (haqiqiy mousemove) | **PASS** | 0.0022 rad/px |
| 1 | FFA — 2 real Chrome | roomId / hash / harakat / qurol | **NOT_TESTED** | Saqlangan dalil yo‘q (3-bo‘lim) |
| 2 | Forest Survival | konteyner, loot, inventory, equip, spectator, round reset | **NOT_TESTED** | Saqlangan dalil yo‘q (3-bo‘lim) |
| 3 | Camper Buddy — o‘z mijozida (A) | Idle / Walk / Run / Jump 3P skrinshotlari | **PASS** | `shots/prod_tdm_A_3p_{idle,walk,run,jump}.png` |
| 3 | | 4 qurol 1P + 3P skrinshotlari | **PASS** | `shots/prod_tdm_A_{1p,3p}_{rifle,pistol,shotgun,sniper}.png` |
| 3 | Camper Buddy — boshqa mijozga uzatilishi (B ma’lumoti) | Run ≈ 6.5 m/s | **PASS** | 6.05 m/s (R1, R2; p75, tezlanish bilan) |
| 3 | | Walk ≈ 3.0 m/s | **PASS** | 2.79 m/s (R1, R2) |
| 3 | | Jump (B’da A havoda) | **PASS** | R1, R2 |
| 3 | | 4 qurol (B snapshot’ida A quroli) | **PASS** | rifle/pistol/shotgun/sniper — R1, R2 |
| 3 | Camper Buddy — B ekranidagi vizual (render) | Idle/Walk/Run/Jump/4 qurol B skrinshotlari | **NOT_TESTED** | Saqlangan dalil yo‘q (3-bo‘lim) |
| 4 | VSync FPS — UHD 730, 1280×720, Medium | idle / move | **NOT_TESTED** | To‘liq o‘lchov saqlanmagan |
| 4 | VSync FPS — UHD 730, 1280×720, Low | idle / move | **NOT_TESTED** | Hech qachon yakunlanmagan |
| 5 | Console | console error / exception / Log error | **PASS** | A, B: 0 / 0 / 0 (R1, R2) |
| 5 | Network | HTTP ≥400 / failed | **PASS** | A, B: 0 (R1, R2); WebSocket `ws://127.0.0.1:3600/socket.io` |
| 5 | WebGL | context lost | **PASS** | 0 (R1, R2) |
| 5 | | GL xatolari | **PASS** | R2: 0 (R1 dagi FAIL — 4-bo‘limdagi tasniflash xatosi) |
| 5 | | Apparat renderer | **PASS** | `ANGLE (Intel, Intel(R) UHD Graphics 730 … D3D11)`, SwiftShader emas |
| 5 | | Three.js eskirish ogohlantirishi | INFO | `PCFSoftShadowMap has been removed. Using PCFShadowMap instead.` — oldindan bor, o‘yin kodiga tegilmadi |
| 5 | Asset | Camper Buddy GLB | **PASS** | HTTP 200, 610 972 B (uzatish 611 286 B) — A, B |
| 5 | | Barcha GLB | **PASS** | 54 ta alohida GLB, hammasi 200/304 (82–99 javob) |
| 5 | Production rejimi | dist bundle, `/@vite/client` 404, DEV hook’lar yo‘q | **PASS** | `__DEV_*` = undefined (A, B) |
| — | Gate’lar | `npm test` / `test:perf` / `typecheck` / `build` | **PASS** | 262/262; NavGraph cold 103.8 ms, warm median 86.0 ms; hammasi exit 0 (`logs/gates_2026-10-26/`) |

Hisob (talab darajasida): **PASS — TDM, Buddy (o‘z mijozi + tarmoq), console/network/WebGL/asset, gate’lar; NOT_TESTED — FFA, Survival, B’dagi Buddy vizuali, VSync Low/Medium; FAIL — yo‘q** (o‘yin xatosi topilmadi).

## 2. Pointer lock va fokus — nima tuzatildi

| Muammo | Sabab | Yechim |
|---|---|---|
| Pointer lock hech qachon olinmasdi (`WrongDocumentError`) | Chrome `about:blank` bilan ochilib, keyin CDP orqali navigatsiya qilingan. Brauzer fokusi manzil satrida qolgan, CDP klik esa uni sahifaga o‘tkazmaydi | Oynalar `--app=<URL>` rejimida ochiladi (manzil satri yo‘q). Lock 1 klikda, **62–115 ms** ichida |
| Bir vaqtda ikki oyna lock qila olmaydi | Windows faqat bitta oynaga fokus beradi. CDP focus emulation bilan lock butunlay rad etiladi (tajriba bilan tekshirildi) | Fokus ketma-ket o‘tkaziladi (handover). Har qadam faqat amal qilayotgan oyna fokusda bo‘lganda bajariladi |
| Fokus yo‘qolgan interval PASS bo‘lib ketishi mumkin edi | O‘yin `blur` va lock yo‘qolganda bosilgan tugmalarni tozalaydi va pauza oynasini ko‘rsatadi | **Focus guard** (`scripts/qa-lib/focus-guard.mts`): har interval boshida va oxirida OS foreground PID, `hasFocus`, `visibility`, pointer lock tekshiriladi. Ichida `blur/unlock/hidden/contextlost` hodisasi bo‘lsa interval **rad etiladi** va qayta urinib ko‘riladi. Hech bir urinish to‘g‘ri chiqmasa — **NOT_TESTED** |
| Sinov osilib qolardi | Oyna yopilganda CDP so‘rovlari abadiy kutardi | Har CDP so‘roviga 30 s timeout; yopilgan oyna kutilayotgan barcha so‘rovlarni rad etadi; unhandled rejection sinovni yiqitmaydi |
| Xonadan chiqib bo‘lmasdi | CDP orqali yuborilgan `Escape` Chrome’ning pointer lock’ini bo‘shatmaydi | OS darajasidagi haqiqiy Esc (`keybd_event`, faqat oyna foreground bo‘lganda) |
| Sinov oldingi natijalarni o‘chirib yuborardi | Har yugurishdan oldin bitta papka tozalangan | Endi har yugurish `runs/<UTC vaqt>/` papkasiga yoziladi va hech qachon o‘chirilmaydi |

Haqiqiy foydalanishda guard ishlaganini ko‘rsatgan holat: o‘chirilgan 1-to‘liq yugurishda foydalanuvchining Chrome (UzLink Web), Telegram, Windows Sozlamalari va explorer.exe fokusni **16 marta** olgan. Guard bu intervallarning barchasini rad etdi va `tdm.4weapons` PASS emas, **NOT_TESTED** bo‘ldi.

## 3. Saqlanmagan natijalar (ochiq tan olinadi)

Bugun to‘liq yugurishga 5 ta urinish bo‘ldi:
- **0-urinish:** Buddy qismi to‘liq PASS bo‘ldi, lekin FFA ga o‘tishda CDP Esc xatosi sabab to‘xtadi.
- **1-yugurish:** 85 PASS, 6 FAIL, 1 NOT_TESTED.
- **2-yugurish:** VSync’gacha deyarli hammasi PASS. VSync vaqtida Claude ilovasi fokusni oldi, so‘ng A oynasi yopildi.
- **3-yugurish:** oldingi jarayonlar portni band qilib qolgani uchun boshlanmadi.
- **4-yugurish = R2:** taxminan 40 s dan keyin A oynasi yopildi.

Har yangi yugurish o‘sha paytda bitta papkani tozalardi, shuning uchun 0-, 1- va 2-urinishlarning JSON, log va skrinshotlari **o‘chib ketdi**. Bu harness xatosi edi va tuzatildi (2-bo‘lim). Saqlangan dalili yo‘q bo‘lgani uchun quyidagilar bu hisobotda **NOT_TESTED**:
- FFA;
- Forest Survival (konteyner, loot, inventory, equip, holster→Q, spectator, round reset);
- B ekranidagi Buddy vizuali (Idle, Walk 2.79 m/s, Run 6.05 m/s, Jump, 4 qurol — 95–115 ms handover bilan olingan edi);
- VSync.

1-yugurishdan topilgan va tuzatilgan harness kamchiliklari (o‘yin xatosi emas):
- Spectator tekshiruvi server `spectateTargetId`’ni o‘qigan, aslida D tugmasi faqat mijoz kamerasini almashtiradi. Endi HUD’dagi “🎥 Kuzatilmoqda: …” matni o‘qiladi.
- E tugmasi o‘yinning “Ochish” prompti chiqmasdan bosilgan. Endi prompt kutiladi; to‘siq bo‘lsa o‘yin “Ko‘rish chizig‘i … yopilgan” deydi va bu INFO bo‘ladi.
- Buddy vizuali uchun A B ga yaqinlashishda o‘z snapshot’idagi eskirgan pozitsiyani ishlatgan (58–91 m masofada kadr FAIL bo‘lgan). Endi har mijozning o‘z server pozitsiyasi ishlatiladi; masofa 12 m dan oshsa qayta yaqinlashadi.

## 4. Kuzatuvlar

- **R1 dagi 2 ta `prod.webgl.noGlErrors` FAIL:** tasniflash regex’i juda keng edi va Three.js eskirish ogohlantirishini GL xatosi deb sanagan. Regex toraytirildi; R2 da GL xatosi 0, ogohlantirish alohida INFO. Raw JSON o‘zgartirilmagan.
- **Jismoniy kiritish:** R1 va R2 da 1 tadan intervalda foydalanuvchi sichqoncha/klaviatura harakati qayd etildi. Bu fokusni o‘g‘irlamagan (aks holda interval rad etilardi), shuning uchun ogohlantirish sifatida yozildi.
- **Ma’lum vizual masala (08B dan):** 1P da qo‘l va yeng eski qizil rangda (`prod_tdm_A_1p_*.png`). O‘yin kodiga tegilmadi.
- **Walk 2.79 m/s:** chegara 3.0 ± 0.5. Qiymat p75 bo‘yicha olingan va tezlanish fazasi ham kiradi.
- **Papka nomlari:** JSON ichidagi yo‘llar yugurish paytidagi nomlar bilan qolgan (`_debug/…` → `runs/2026-10-26T06-19-35_tdm/…`, `run_final/…` → `runs/2026-10-26T06-40-08_partial/…`). Raw loglar o‘zgartirilmadi.

## 5. Fayllar

| Fayl | Mazmuni |
|---|---|
| `qa_summary_2026-10-26.json` | Talab bo‘yicha holatlar va dalil yo‘llari |
| `runs/2026-10-26T06-19-35_tdm/` | R1: `prod_smoke.json`, 14 skrinshot, `logs/` (run log, stdout, server log, WS frame’lar, focus intervallari) |
| `runs/2026-10-26T06-40-08_partial/` | R2: xuddi shu tuzilma, R2 dagi console/network/WebGL/asset |
| `logs/gates_2026-10-26/` | `npm test`, `test:perf`, `typecheck`, `build` loglari va exit kodlari |
| `logs/baseline.txt`, `dist_check.txt`, `exit_codes.txt` | Oldingi kompyuterdagi (08B closeout) loglar, o‘zgartirilmagan |
| `scripts/prod-smoke-08b.mts` | Production smoke harness (fokus guard, handover, VSync 1280×720 Low/Medium) |
| `scripts/qa-lib/focus-guard.mts`, `os-focus-helper.ps1` | Fokus guard va Win32 yordamchisi |
| `scripts/create-stage08b-prod-smoke-zip.ps1` | Toza loyiha ZIP (git ko‘radigan fayllar; `node_modules`, `dist`, `*.zip` yo‘q) |

## 6. Qolgan sinovni yakunlash

Kompyuter taxminan 10 daqiqa bo‘sh bo‘lganda:

```
npm run build
npx tsx scripts/prod-smoke-08b.mts
```

Natija `docs/stage08b-prod-smoke/runs/<vaqt>/` papkasiga yoziladi. FFA, Survival, B’dagi Buddy vizuali va VSync Low/Medium (1280×720, haqiqiy oyna o‘lchami, 60 Hz, `logs/vsync_frametimes_ms.json` da har kadr vaqti) shu bitta yugurishda o‘lchanadi.

O‘yin kodi, server fizikasi, Camper Buddy modeli va animatsiyalari **o‘zgartirilmadi**. **08C boshlanmadi.**
