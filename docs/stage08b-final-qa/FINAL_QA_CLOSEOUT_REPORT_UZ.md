# Camper Strike 65 — Stage 08B-FINAL-QA-CLOSEOUT hisoboti

**Sana:** 2026-10-25 · **Repo:** `C:\Users\user\Desktop\Games\camper-strike` · **HEAD:** `0c3b8ba` (+ ushbu bosqichning commit qilinmagan o‘zgarishlari)
**Qurilma:** ASUS TUF Gaming A15 — AMD Ryzen 7 6800H (Radeon 680M iGPU) + NVIDIA GeForce RTX 3050 Ti Laptop, 144 Hz displey, Chrome 156.
**Yakuniy qaror:** 08B texnik jihatdan yopildi (testlar 0 exit, 2-client 53 PASS). Vizual qabul — foydalanuvchida. **08C boshlanmagan.**

## Umumiy jadval

| Gate | Natija |
|---|---|
| 1. Kanonik baza | **PASS** (izoh bilan: terrain ZIP shu kompyuterda yo‘q) |
| 2. `npm test` / typecheck / build | **PASS** — barchasi exit 0; NavGraph vaqt testi perf-gate’ga ajratildi va PASS |
| 3. Yakuniy buildda 2-client QA | **PASS** — 53 PASS / 0 FAIL / 2 INFO |
| 4. Performance — RTX 3050 Ti uncapped | **PASS** (oldin/keyin teng) |
| 4. Performance — Radeon 680M iGPU | **PASS** (ma’lumot uchun, shovqinli) |
| 4. Performance — real VSync (60/144 Hz) | **QISMAN**: BEFORE/low 144 Hz o‘lchandi; FINAL VSync — **NOT_TESTED** (pastga qarang) |
| 4. Performance — 2 ta to‘liq tezlikdagi mijoz | **NOT_COMPARABLE** (stress artefakt, BEFORE yo‘q) |
| 4. Intel UHD Graphics 730 | **NOT_TESTED** — bu kompyuterda bunday GPU yo‘q |
| 5. Qolgan vizual masalalar | Dalillar olindi, scope tavsiflandi — **foydalanuvchi qarori** |

## 1. Kanonik baza
- `D:\Stickman-strike` bu kompyuterda mavjud emas (faqat C: disk). Faol va yagona repo: `C:\Users\user\Desktop\Games\camper-strike`.
- `stickman-strike-stage08terrain-skirt-fix.zip` bu kompyuterda topilmadi — ZIP bilan bevosita taqqoslash **NOT_VERIFIED**. Uning git ekvivalenti — `7c6ea73` (Stage 08-TERRAIN-SKIRT-OCCLUSION-FIX).
- Git tarixi:
  | Commit | Sana | Mazmun |
  |---|---|---|
  | `7c6ea73` | 2026-10-23 17:10 | Stage 08-TERRAIN-SKIRT-OCCLUSION-FIX (+ `.gitignore` shu commitda yaratilgan) |
  | `dc31c8c` | 2026-10-23 17:59 | **Alohida repo-audit tuzatishi** (08B emas) |
  | `0c3b8ba` | 2026-10-24 23:21 | Stage 08B-CHAR-INTEGRATION |
- Audit topgan `room.ts` / `Game.ts` semantik o‘zgarishlari **`dc31c8c`dan** keladi (diff tekshirildi):
  - `room.ts` `resetMatch`: loot rejimida `roundId++` va `loot.resetForRound(...)` + `loot:snapshot` (restartdan keyin konteynerlar bo‘sh qolardi).
  - `room.ts` tick: `rawDt < 0.005 ? 1/TICK_RATE` → `rawDt <= 0 ? 1/TICK_RATE` (catch-up tick’larda vaqt ikki marta sanalardi).
  - `Game.ts`: takroriy `updateDampedAnimations` olib tashlandi (qopqoqlar 2× tez ochilardi); holster’da `prevWeapon` saqlanadi (Q ishlashi uchun).
  - `package.json`: terrain testlari `npm test`ga qo‘shilgan; `repo-audit-fixes.test.ts` qo‘shilgan.
- 08B (`dc31c8c..0c3b8ba`) `src/server`ga **umuman tegmagan**; `src/shared`da faqat bitta test fayli (53-GLB guard). `Game.ts`da 08B faqat `getCharacterDiagnostics` DEV hook va `playInteract()` qo‘shgan.
- **Tuzatish:** 08B hisobotidagi “server o‘zgarmagan” iborasi `dc31c8c`ga nisbatan to‘g‘ri edi; terrain ZIPga nisbatan esa server `dc31c8c` tufayli farq qiladi. Hech narsa revert qilinmadi.

## 2. Testlar (haqiqiy exit kodlar, loglar `qa_logs/gates/`)
| Buyruq | Exit | Natija |
|---|---|---|
| `npm test` | **0** | 262 / 262 pass |
| `npm run test:perf` (yangi) | **0** | NavGraph cold 174.1 ms, warm median 150.9 ms (< 250 ms) |
| `npm run typecheck` | **0** | — |
| `npm run build` | **0** | — |

**NavGraph `< 250 ms` reproduksiyasi** (o‘zgartirishdan oldin):
| Rejim | Natija | O‘lchangan vaqt |
|---|---|---|
| To‘liq `npm test` (parallel, 16 yadro) ×3 | 3/3 FAIL | 342.8 / 367.7 / 327.4 ms |
| Faqat `forest-square-04b.test.ts` ×3 | 3/3 PASS | < 250 ms |
| To‘liq suite `--test-concurrency=1` | 262/262 PASS | < 250 ms |
| Alohida skript (cold / warm median) ×3 | — | 183–192 / 149–170 ms |

Sabab — parallel test fayllarining CPU raqobati; NavGraph kodi (08B tegmagan) emas.
**Tuzatish (chegarani ko‘tarmasdan):** vaqt tekshiruvi `src/shared/__perf__/navgraph-build.perf.test.ts`ga ko‘chirildi (`npm run test:perf`, serial, cold + 5 warm build median, chegara o‘sha **250 ms**). Funksional testda NavGraph qurish, 64×64 grid, yo‘l topish tekshiruvlari qoldi; vaqt faqat `diagnostic` sifatida yoziladi. 08B testlari hech biri skip qilinmagan. `test:perf` 4 marta ishga tushirildi — 4/4 PASS (cold 174–206 ms).

## 3. Yakuniy buildda real Chrome QA (skeleton-sharing tuzatishi bilan)
`docs/stage08b-final-qa/qa_multi_final.json` — **53 PASS / 0 FAIL / 2 INFO**. Haqiqatan sinalgan:
- **TDM (2 mijoz, bitta roomId):** o‘zaro ko‘rish, gameplayHash `670a9c21f0565c94`, worldVersion 2, roomId mos; 4 qurol equip sinxroni; B’da A uchun Idle / Walk / Run / JumpAir; masofaviy tezlik ≈3.0 va ≈6.5 m/s.
- **Instansiya mustaqilligi (brauzerda):** har ikki mijozda skeleton, Hips suyagi va team material UUID’lari barcha modellarda takrorlanmas; team rangi jamoaga mos (#e03a30 / #2e75e8) — rejoin’dan keyin ham.
- **5× rejoin:** ulanish barqaror, `liveInstances` barqaror, heap o‘sishi < 15 MB.
- **FFA smoke:** PASS.
- **Forest Survival:** konteynerga borish → ochish → buyum olish → qurol equip → B qurolni ko‘radi → spectator cycle → round reset: PASS. Mahalliy Interact holati PASS.
- **Konsol / tarmoq:** `noConsoleErrors`, `noNetworkErrors`, `noPageExceptions` — PASS (yagona ogohlantirish: Three.js `PCFSoftShadowMap` deprecation — oldindan mavjud).
- **INFO ×2:** Interact masofaviy modelda ko‘rinmaydi (tarmoq eventi yo‘q) — ma’lum cheklov.
- **Skrinshot/video:** 84 ta rasm (`qa_shots/`), 5 ta video (`qa_videos/final_{walk,run}_{3p,side}.webm`, `final_remote_run.webm`), 4 qurol close-up, 1P × 4 qurol, 3P idle/run/jump.
- **Eslatma:** lokal walk/run videolari DEV synthetic input + tarmoq “mute” bilan olingan (aniq tezlik uchun) — ular tarmoq regressiyasi dalili emas; tarmoq dalili — yuqoridagi 2-client natijalar.

## 4. Performance
**4a. RTX 3050 Ti — uncapped diagnostika** (`--disable-gpu-vsync --disable-frame-rate-limit`, headless, 1280×720, fixed camera, warmup 5 s + 20 s × 2; B 2 fps’ga cheklangan). Bu **nisbiy render xarajati**, real o‘yinchi FPS emas.

| Sifat / sahna | BEFORE fps · 1% low · p99 | FINAL fps · 1% low · p99 | Draw (B→F) | Tris (B→F) |
|---|---|---|---|---|
| low / lane + B | 598 · 123 · 21.2 ms | 608 · 366 · 2.5 ms | 147 → 97 | 449k → 477k |
| low / open_forest | 564 · 337 · 3.3 | 594 · 268 · 3.4 | 180 → 143 | 470k → 491k |
| low / service_station | 599 · 365 · 2.6 | 669 · 401 · 2.7 | 173 → 149 | 439k → 453k |
| low / forest_camp | 560 · 360 · 2.6 | 647 · 367 · 2.6 | 171 → 146 | 448k → 472k |
| low / flower_glade | 676 · 420 · 2.2 | 573 · 345 · 2.8 | 137 → 126 | 451k → 479k |
| medium / lane + B | 510 · 336 · 3.5 | 492 · 329 · 2.9 | 213 → 163 | 726k → 754k |
| medium / open_forest | 492 · 274 · 3.3 | 575 · 268 · 3.3 | 199 → 162 | 721k → 742k |
| medium / service_station | 480 · 296 · 3.2 | 514 · 250 · 3.6 | 202 → 178 | 693k → 707k |
| medium / forest_camp | 481 · 300 · 3.1 | 449 · 290 · 3.3 | 212 → 187 | 700k → 724k |
| medium / flower_glade | 552 · 342 · 3.4 | 503 · 342 · 3.0 | 173 → 162 | 701k → 728k |

Xulosa: farqlar shovqin chegarasida (ba’zi sahnada ±10–15% ikki tomonga); FINAL’da hech bir sahnada 16.7 ms dan oshgan kadrlar 0.01% dan ko‘p emas (BEFORE low/lane’da 1.6% edi); draw call har sahnada kamaygan, uchburchak +14–28k (2 ta Buddy). Eng og‘ir sahna: medium / forest_camp va service_station (~450–515 fps).

**4b. AMD Radeon 680M iGPU** (`--force_low_power_gpu`, WebGL: `ANGLE (AMD, AMD Radeon(TM) Graphics ...)`), medium / lane + B, uncapped:
| | fps | 1% low | p95 / p99 | > 16.7 ms |
|---|---|---|---|---|
| BEFORE | 284 | 98 | 5.7 / 23.9 ms | 3.0% |
| FINAL | 273 | 61 | 5.3 / 15.2 ms | 0.84% |
Bitta sahna, ikki takror — iGPU umumiy xotira tufayli shovqinli; regressiya belgisi yo‘q, lekin bu Intel UHD 730 o‘rnini bosmaydi.

**4c. Real VSync tajribasi.**
- Headful (ko‘rinadigan oyna), BEFORE / low, 5 sahna: **144 fps barqaror** (displey 144 Hz), 1% low 122–141, p99 7.1 ms, > 33.3 ms kadr 0% (`qa_logs/perf_chain1.log`).
- FINAL VSync: **NOT_TESTED**. Ikki urinish yaroqsiz chiqdi: (1) headless VSync rejimida Chrome displeysiz ~13 fps / 69 ms GPU vaqtga tushadi; (2) keyingi headful urinishda oyna yashirin/ekran qulflangan bo‘lgani uchun BEFORE ham ~13 fps ko‘rsatdi. Bu ma’lumotlar natija sifatida ishlatilmadi — `qa_invalid_headless_vsync/` va `qa_logs/perf_chain3_aborted.log`da saqlangan.
- Hisoblangan (o‘lchanmagan) baho: FINAL uncapped p99 ≤ 3.6 ms ≪ 16.7 ms (60 Hz) va 6.9 ms (144 Hz) — VSync byudjeti katta zaxira bilan bajariladi. Bu **xulosa**, o‘lchov emas.
- 60 Hz displeyda alohida o‘lchanmagan (displey 144 Hz).

**4d. Ikki to‘liq tezlikdagi mijoz (bFullRate)**, FINAL, medium / lane: run#1 9 fps (1% low 0.8, p99 853 ms), run#2 158 fps (1% low 4.4, p99 147 ms). Ikki uncapped WebGL tab bitta Chrome GPU jarayonida raqobatlashgan stress artefakti; BEFORE uchun o‘lchanmagan → **NOT_COMPARABLE**, 08B regressiyasi deb talqin qilinmaydi. Haqiqiy ikki-kompyuter sinovi talab etiladi.

**4e. Intel UHD Graphics 730:** **NOT_TESTED** — ASUS TUF A15da bunday GPU yo‘q. Skript tayyor: o‘sha kompyuterda `node scripts/qa-stage08b-char.mjs --phase=perf --label=final --perfMode=vsync --headful --quality=low,medium --out=docs/stage08b-final-qa` (+ BEFORE uchun `--root=<dc31c8c nusxasi>`).

## 5. Qolgan vizual masalalar (faqat tavsif, kod qo‘shilmadi)
| Masala | Dalil | Xavf | Minimal scope (foydalanuvchi tanlaydi) |
|---|---|---|---|
| 1P eski qizil qo‘l/yeng | `qa_shots/final_1p_red_{rifle,pistol,shotgun,sniper}.png` | 1P va 3P uslubi mos emas | `ViewModel.ts`da qo‘l materialini Buddy rangiga moslash (rang + yeng) — 1 fayl, GLB’siz |
| Uzun qurolda chap qo‘l stvol ostida emas | `qa_shots/final_grip_{rifle,shotgun,sniper}_{leftside,threequarter_front}.png` | Close-up’da ko‘zga tashlanadi | (a) 3P qurol masshtabini 1.32 → ~1.0 ga tushirish yoki (b) chap qo‘lni magazin o‘rniga cho‘zilgan tutish pozasi — `CharacterWeaponMount`/`CharacterAimPose` doirasida; runtime IK talab qilmaydi |
| Interact masofaviy o‘yinchida yo‘q | `final_interact_remote_view_from_B.png` (B’da A Idle), QA INFO ×2 | Faqat kosmetik | Server `container:open` muvaffaqiyatida yengil `player:interact` broadcast + remote `playInteract()` — protokol o‘zgarishi, alohida bosqich |
| Run’da oyoq kapsuladan chiqadi | `final_capsule_run_side_*.png/jpg` (F9 overlay) | Tor joyda oyoq devorga biroz kiradi; gameplay’ga ta’sir yo‘q (server kapsula r=0.4 o‘zgarmagan) | Kollayderni kengaytirmaslik (talab); kerak bo‘lsa faqat vizual: tor joyda yugurish klipini qisqartirish |
| Lokal Interact skrinshotida loot paneli personajni yopadi | `final_interact_local_A_3p.png` | Faqat dalil sifati | Lokal holat JSON’da `Interact` deb tasdiqlangan |

## 6. O‘zgargan fayllar (ushbu bosqich, commit qilinmagan)
| Fayl | O‘zgarish |
|---|---|
| `src/shared/__tests__/forest-square-04b.test.ts` | NavGraph vaqt assert’i olib tashlandi → `diagnostic`; funksional tekshiruvlar saqlandi |
| `src/shared/__perf__/navgraph-build.perf.test.ts` (yangi) | Serial perf-gate: cold + warm median < 250 ms |
| `package.json` | `test:perf` skripti |
| `src/client/game/Stickman.ts` | DEV diagnostikaga `skeletonUuid`, `hipsBoneUuid`, `teamMaterialUuid`, `teamColorHex` |
| `scripts/qa-stage08b-char.mjs` | Konsol/tarmoq xato yig‘ish, UUID mustaqillik tekshiruvi, perf rejimlari (uncapped/vsync, low/medium, 5 sahna, bFullRate, iGPU), gate-5 kadrlar |
| `docs/stage08b-final-qa/` (yangi) | Ushbu hisobot, QA JSON’lar, loglar; rasm/videolar faqat ZIPda (git’ga qo‘shilmaydi) |

Sub-agentlar: Agent E (QA harness kengaytmasi, shots/video) — sessiya uzilishida to‘xtadi; qolgan multi/perf run’lari va barcha gate’lar koordinator (Claude) tomonidan bajarildi.

**Faqat 08B-FINAL-QA-CLOSEOUT. STOP — 08C boshlanmagan.**
