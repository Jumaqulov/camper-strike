# Camper Strike 65 — 08B-PRODUCTION-SMOKE: qolgan gate'lar hisoboti

**Sana:** 2026-10-26 · **Repo:** `D:\Stickman-strike`, `main` (`8e217b9` + ushbu bosqich)
**Qurilma:** Intel Core i5-14400, 32 GB RAM, **Intel UHD Graphics 730**, 2 × 1920×1080 @ 60 Hz, Windows 11, Chrome 155.0.8059.86
**Asos:** `CAMPER_STRIKE_65_STAGE08B_PROD_SMOKE_MUSTAQIL_AUDIT_UZ.md` va `CLAUDE_STAGE08B_REMAINING_PRODUCTION_GATES_UZ.md`. Oldingi R1/R2 dalillari saqlangan va o‘zgartirilmagan.

## Yakuniy qaror

**5 ta ochiq gate’dan:** FFA, Forest Survival, B’dagi Idle/Walk/Run/Jump render, VSync Medium va VSync Low — **PASS**. **B’dagi 4 qurol ko‘rinishi — FAIL (vizual):** B ekranida A qurolni tik yuqoriga tutib turibdi, A ning o‘z 3P ko‘rinishida esa qurol oldinga qaragan. Bu masofaviy aim-pose xatosi bo‘lishi mumkin. Kod tuzatilmadi, alohida tasdiqlash kerak.

**08B holati:** to‘liq yopish uchun 3b bandi va foydalanuvchining vizual qabuli qoladi. **08C boshlanmagan.**

## 1. Gate jadvali

| Gate | Talab | Holat | Dalil (`runs/…`) | Asosiy qiymatlar |
|---|---|---|---|---|
| — | `npm test` / `test:perf` / `typecheck` / `build` | **PASS** | `logs/gates_2026-10-26T07-00-20/` | 262/262; NavGraph cold 105.6 ms, warm median 90.9 ms; build `index-K39zGHOx.js`; hammasi exit 0 |
| 1 | FFA — 2 real Chrome, bitta xona | **PASS** | `2026-10-26T07-03-21`, `2026-10-26T07-20-35` | roomId mos, hash `670a9c21f0565c94`, worldVersion 2; pointer lock A+B; walk 2.79, run 6.05 m/s; qurol almashtirish (shotgun) B da ko‘rinadi; B kadrida A bor (yaw, pitch, LOS tekshirilgan — 2-run) |
| 2 | Forest Survival: konteyner → item → inventory → equip → spectator → round reset | **PASS** | `2026-10-26T07-03-21` | `metal_locker_01` E bilan ochildi (server ack); rifle + medkit olindi; inventory `owned=rifle, items=2, round=1`; equip rifle → 0 (holster) → Q (rifle qaytdi), B da ham; C o‘rtadan kirib `spectator`; D: ProdA → ProdB; timer → `ended`, roundId 1 → 2; loot va inventory reset |
| 3a | B ekranida A ning Camper Buddy render’i: Idle, Walk, Run, Jump | **PASS** | `2026-10-26T07-18-24` | Idle 0.00 m/s; Walk 2.79; Run 6.05 m/s; Jump `onGround=false`. Har kadrda A B kamerasida (bearing ≈0, pitch xatosi <0.25 rad), ko‘rish chizig‘i ochiq, handover 94–133 ms. Kadrlar ko‘z bilan tekshirildi |
| 3b | B ekranida A ning 4 quroli | **FAIL** | `2026-10-26T07-18-24` | Avtomatik tekshiruvlar PASS (model chizilgan, B tarmoq holatida to‘g‘ri qurol, kadrda, LOS ochiq). Lekin **ko‘z bilan:** orqadan ko‘ringan A qurolni tik yuqoriga tutgan. Taqqoslash uchun `prod_tdm_A_3p_shotgun.png` (A ning o‘zi, qurol oldinga) va `prod_buddy_remote_idle_try1.png` (A B ga qaragan, qurol normal) |
| 4 | VSync — UHD 730, 1280×720, Medium | **PASS** | `2026-10-26T07-08-21`, `2026-10-26T07-10-31` | quyidagi jadval |
| 5 | VSync — UHD 730, 1280×720, Low | **PASS** | o‘sha 2 run | quyidagi jadval |

## 2. VSync benchmark (haqiqiy oyna 1280×720, DPR 1, canvas 1280×720, 60 Hz, `ANGLE (Intel(R) UHD Graphics 730 … D3D11)`)

Har o‘lchov 20 s, fokusdagi oynada, pointer lock bilan. Frame-rate flag’lari yo‘q. Medium va Low o‘yin ichidagi pauza menyusidan haqiqiy input bilan tanlangan.

| Run | Rejim | FPS | Median | p95 | p99 | 1% low | >33 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| 07-08-21 | Medium idle | 60.0 | 16.70 ms | 16.8 | 16.8 | 59.5 | 0.00% |
| 07-08-21 | Medium move | 60.0 | 16.70 | 16.8 | 16.8 | 59.1 | 0.00% |
| 07-08-21 | Low idle | 60.0 | 16.70 | 16.8 | 16.8 | 59.4 | 0.00% |
| 07-08-21 | Low move | 60.0 | 16.70 | 16.8 | 16.8 | 59.2 | 0.00% |
| 07-10-31 | Medium idle | 60.0 | 16.70 | 16.8 | 16.8 | 56.7 | 0.08% |
| 07-10-31 | Medium move | **57.6** | 16.70 | 16.8 | 16.9 | **43.6** | 0.35% |
| 07-10-31 | Low idle | 60.0 | 16.70 | 16.8 | 16.9 | 59.1 | 0.00% |
| 07-10-31 | Low move | 60.0 | 16.70 | 16.8 | 16.8 | 59.3 | 0.00% |

**PASS mezoni:** fokus intervali to‘g‘ri, median 16.67 ms ± 5% (VSync’ga bog‘langan), FPS ≥ 57, >33 ms kadrlar < 1%.
- 07-10-31 Medium move chegaraga yaqin (57.6 fps, 1% low 43.6). Bu runda bitta interval Claude ilovasi fokusni olgani uchun rad etilgan va qayta o‘lchangan.
- Har kadr vaqti: `logs/vsync_frametimes_ms.json`.
- 07-08-21 runidagi 2 ta FAIL (B uchun asset/WebGL) harness xatosi edi: VSync rejimida B faqat lobby’da qolgan. Endi VSync-only rejimda B ochilmaydi, o‘yinga kirmagan mijoz uchun bu tekshiruvlar NOT_TESTED bo‘ladi (07-10-31: 0 FAIL).

## 3. Chrome oynasi yopilishi — diagnostika

Harness endi quyidagilarni yozib boradi:
- Chrome’ning o‘z logi (`chrome_debug_<A|B|C>.log`);
- Chrome jarayonining exit code’i;
- CDP `Inspector.detached` / `targetCrashed` sababi;
- yopilish paytidagi OS foreground PID;
- Crashpad hisobotlari;
- Windows Application Event Log (`windows_application_events.txt`).

- **`2026-10-26T07-20-35`:**
  - 07:26:45 da B → C → A taxminan 1 s oraliqda yopilgan.
  - Har birida `Inspector.detached: target_closed`, exit code **0** (normal yopilish).
  - Crashpad hisoboti 0, WER/Application Error yo‘q.
  - Foreground `explorer.exe`, jismoniy kiritish 0 ms oldin bo‘lgan.
  - **Xulosa:** oynalar qo‘lda yopilgan, crash emas. Shundan keyingi tekshiruvlar hisobga olinmaydi.
- **R2 (`2026-10-26T06-40-08_partial`):** u paytda diagnostika yo‘q edi, shuning uchun **sababi isbotlanmagan**. Taxmin bilan belgilanmadi.
- Chrome logidagi `ERROR` qatorlari: GCM registratsiyasi va updater pipe (vaqtinchalik profil xizmatlari). O‘yin yoki GPU bilan bog‘liq emas.

## 4. Qabul qilinmagan natijalar (ochiq)

| Run | Natija | Nega qabul qilinmadi |
|---|---|---|
| `2026-10-26T07-06-25` | buddy.remote.* — 8 PASS | B kamerasi osmonga qaragan (pitch nazorati yo‘q edi). Kadrlarda A **yo‘q**. Harness tuzatildi: yaw + pitch nishonga olish, `inView` pitch’ni ham tekshiradi |
| `2026-10-26T07-15-37` | buddy.remote.* — 8 PASS | Pitch to‘g‘ri, lekin qurol kadrlarida A va B orasida daraxt tanasi bor edi. Ko‘rish chizig‘i tekshiruvi qo‘shildi (`raycastWorld`, 3 ta nur), A to‘siq yo‘qolguncha yon tomonga suriladi |
| `2026-10-26T07-03-21` | `survival.remoteSeesLootedWeapon`, `ffa.B.view.shot` PASS | Pitch tuzatishidan oldin olingan. Hisobga olinmadi (gate 2 asosiy zanjiri bunga bog‘liq emas) |
| `2026-10-26T07-18-24` | `tdm.walk` FAIL 0.01 m/s | Skrinshotda A daraxt tanasiga taqalib turibdi (to‘g‘ri kolliziya). Sabab: harness’ning "open lane" tanlovi NavGraph orqali har yo‘nalishda 0 qaytargan. Endi `raycastWorld` ishlatiladi (keyingi runda “free≈25 m”). TDM walk boshqa runlarda PASS (2.79 m/s) |
| `2026-10-26T07-20-35` | `survival.spectatorCycle`, `nextRound`, `remoteSeesLootedWeapon` FAIL | Konteynerlarga yurish vaqtida 2 daqiqalik round tugagan. C kirganda round #3 countdown boshlangan va C participant bo‘lgan, spectator HUD yo‘qolgan. A B dan 187 m uzoqda qolgan. Keyin oynalar qo‘lda yopilgan. O‘yin xatosi isbotlanmagan |

## 5. Topilmalar (kod o‘zgartirilmadi)

1. **Masofaviy qurol pozasi (3b):** B ekranida orqadan ko‘rinadigan A qurolni tik yuqoriga tutgan; A ning o‘zida va A B ga qaraganida qurol normal. Ehtimoliy sabab: remote aim-pose / pitch xaritalash (`CharacterAimPose` / `CharacterWeaponMount`). Tasdiqlash uchun alohida tekshiruv kerak.
2. **1P qo‘l va yeng** hali eski qizil uslubda (08B dan ma’lum vizual qarz). Chap qo‘lning uzun qurolni tutishi ham 08B hisobotidagi ochiq masala.
3. **Survival countdown paneli** o‘rtadan qo‘shilishdan keyin “Tayyor: 3/2” ko‘rsatdi (tayyorlar soni ishtirokchilardan ko‘p). UI kuzatuvi.
4. **Three.js `PCFSoftShadowMap`** eskirish ogohlantirishi (INFO).

## 6. Harness o‘zgarishlari (faqat QA)

- Chrome yopilish diagnostikasi (3-bo‘lim).
- B kamerasi yaw + pitch bo‘yicha nishonga oladi. `inView` = bearing + pitch + masofa + `raycastWorld` LOS.
- A to‘siqni aylanib o‘tadi: ko‘rish chizig‘i ochilguncha haqiqiy A/D tugmalari bilan yon tomonga suriladi.
- "Open lane" tanlovi `raycastWorld` asosida.
- FFA: pointer lock, kalibrlash, walk tekshiruvi, B kadrining yaw/pitch/LOS tekshiruvi.
- VSync-only rejimida B ochilmaydi; o‘yinga kirmagan mijoz uchun asset/WebGL tekshiruvlari NOT_TESTED.
- Saqlanganlar: CDP timeout, focus guard, har run uchun alohida `runs/<UTC>/` papkasi.

## 7. Fayllar

- `qa_summary_remaining_gates_2026-10-26.json` — gate holatlari, qiymatlar, dalil yo‘llari, qabul qilinmaganlar.
- `runs/2026-10-26T07-03-21` … `runs/2026-10-26T07-20-35` — 7 ta yangi run: `prod_smoke.json`, `shots/`, `logs/` (run log, Chrome logi, WS frame’lar, focus intervallari, VSync frametime, Windows event).
- `logs/gates_2026-10-26T07-00-20/` — test, perf, typecheck, build loglari va exit code’lari.

O‘yin kodi, server fizikasi, Camper Buddy GLB va animatsiyalari **o‘zgartirilmadi**. **08C boshlanmadi.**
