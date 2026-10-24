# Camper Strike 65 — Stage 08B-CHAR-INTEGRATION hisoboti (Camper Buddy Balanced)

**Sana:** 2026-10-24 · **Baza:** `dc31c8c` (main) · **Repo:** `C:\Users\user\Desktop\Games\camper-strike`
(`D:\Stickman-strike` bu kompyuterda mavjud emas — faqat C: disk bor; faol repo shu.)
**Holat:** 08B doirasidagi integratsiya bajarildi. Yakuniy vizual PASS — **foydalanuvchi qarori** (skrinshot/videolarni ko‘ring). 08C boshlanmagan.

## 1. Asset
- `public/models/characters/camper_buddy_balanced_rigged.glb` — 610 972 bayt, SHA-256 `a898d979d5449a06da66e1b7208cb3a9571d8eed0d3dcbbf77842b3acf9be379` (handoff bilan bir xil).
- Brauzerda yuklangan: 7/7 klip, 22 joint, 4 socket, 2 SkinnedMesh, 11 468 uchburchak, validation `ok`, console/WebGL xatosi yo‘q (QA `noPageExceptions` PASS).

## 2. Arxitektura (o‘zgargan / yangi fayllar)
| Fayl | Egasi | Nima |
|---|---|---|
| `src/client/game/character/CharacterAssetRegistry.ts` (yangi) | Agent A | GLBni bir marta yuklash, validatsiya, `SkeletonUtils.clone` bilan instansiya (o‘z skeleti, o‘z team materiali), diagnostika, dispose |
| `src/client/game/animation/locomotionState.ts`, `CamperBuddyAnimator.ts` (yangi) | Agent B | Idle/Walk/Run/JumpStart/JumpAir/Land/Interact state machine, hysteresis, `AnimationMixer` blend (umumiy vazn har kadr = 1) |
| `src/client/game/character/CharacterAimPose.ts`, `CharacterWeaponMount.ts`, `CharacterMaterials.ts` (yangi) | Agent C | Upper-body override (oflayn bake qilingan qo‘l pozalari, runtime IK yo‘q), qurolni `Hand_R_Grip`ga o‘rnatish, team rang |
| `src/client/game/character/__tests__/*`, `src/client/game/animation/__tests__/*` (yangi) | Agent D | 64 ta unit/adversarial test |
| `scripts/qa-stage08b-char.mjs`, `docs/stage08b-char/qa_lane_helper.ts` (yangi) | Agent E | Real Chrome (CDP) QA: shots / video / 2-client / perf |
| `src/client/game/Stickman.ts` | Koordinator | Adapter: GLB tayyor bo‘lsa procedural tana yashiriladi va Buddy ishlatiladi; aks holda procedural fallback. Public API o‘zgarmadi |
| `src/client/game/Game.ts` | Koordinator | Konteyner ochilganda `playInteract()`; DEV `getCharacterDiagnostics()` |
| `package.json` | Koordinator | `npm test`ga yangi test papkalari qo‘shildi |
| `src/shared/__tests__/stage08-terrain-review-fix.test.ts` | Koordinator | "53 GLB" tekshiruvi endi `characters/`dan tashqari 53 ta + personaj 1 ta deb tekshiradi (53 ta mavjud GLB himoyasi saqlandi) |
| `docs/stage08b-char/CONTRACTS.md` | Koordinator | Modul kontraktlari va fayl egaligi |

Server, `src/shared` fizika, kollayderlar, spawn, loot va tarmoq kodiga **tegilmadi** (test bilan tasdiqlangan: `src/shared` / `src/server` yangi modullarni import qilmaydi).

## 3. Asosiy qarorlar
- **Qurol:** upper-body override. Locomotion klipi oyoq/hips’ni boshqaradi; Spine/Chest/Neck pitchni oladi, ikkala qo‘l oflayn hisoblangan "rifle ready" / pistol pozasiga o‘tadi. Qurol `Hand_R_Grip` socketiga ulanadi va har kadr aim yo‘nalishiga (yaw + pitch) aniq moslanadi (xato 0.000°, grip xatosi < 1 mm). Recoil/reload procedural (avvalgidek).
- **O‘lim:** GLBda death klipi yo‘q — animator muzlatiladi va mavjud 6 xil procedural yiqilish butun personajga (oyoq ostidagi pivot) qo‘llanadi.
- **Tezlik:** Walk `timeScale = speed/3.005` (0.55–1.6), Run `speed/6.498` (0.7–1.35); 3.0 m/s da Walk 0.998×, 6.5 m/s da Run 1.000×. Hysteresis: Idle→Walk > 0.7, Walk→Idle < 0.4, Walk→Run > 4.9, Run→Walk < 4.3 m/s, 0.15 s dwell; tezlik 0.12 s silliqlanadi; 0.08 s "coyote" filtr — zinapoyada sakrash yo‘q.
- **1P/3P:** 1P’da mahalliy tana ko‘rinmaydi (`visible=false` tasdiqlandi); 3P proximity fade — Head suyagi yig‘iladi / butun pivot yashiriladi.
- **Rang:** faqat har bir o‘yinchining `buddy_team_color` klonini o‘zgartiradi; umumiy `buddy_main` hech qachon o‘zgarmaydi.
- **Perf tuzatish (QA davomida topildi):** SkeletonUtils.clone har primitivga alohida Skeleton berardi → ikkalasi bitta Skeleton’ga bog‘landi (bone matritsalar kadrda 1 marta). Regressiya testi qo‘shildi.

## 4. Testlar (haqiqiy exit kodlar)
| Buyruq | Natija |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run build` | **exit 0** |
| `npm test` | **exit 1** — 262 test, 261 pass, 1 fail |

Yagona fail: `forest-square-04b` → "NavGraph < 250 ms" (to‘liq suite ichida 378 ms). Bu **08B’dan oldin ham** bor edi (baseline: 507 ms / 268 ms), alohida ishga tushirilganda o‘tadi (6/6). Mashina yuklamasiga bog‘liq vaqt testi, 08B kodi NavGraph’ga tegmaydi.

Yangi testlar (64): GLB yaxlitligi (SHA/hajm/7 klip/22 joint/4 socket/in-place), klon xavfsizligi (6 instansiya, suyak/material ajratilgan), dispose/leak (50 sikl → liveInstances 0, mixer kesh 0), xato/fallback holatlari, state machine fuzz (20k kadr, NaN/Infinity/dt), aim pose (0 alloc, akkumulyatsiya yo‘q), weapon mount (4 qurol × 4 yaw × pitch −0.6..0.6), Stickman hayot sikli (o‘lim/tirilish/rang/dispose), invariant: `gameplayHash=670a9c21f0565c94`, worldVersion 2, 36 spawn.

## 5. Brauzer QA (real Chrome 156, 1280×720, medium, forest_square seed 6501)
**2-mijozli (bitta roomId):** AFTER **34 PASS / 0 FAIL / 1 INFO** (BEFORE: 26 PASS / 8 SKIP — hook yo‘q edi).
- TDM: o‘zaro ko‘rish, gameplayHash/worldVersion/roomId mos, 4 qurol equip sinxroni, B’da A uchun Idle/Walk/Run/JumpAir holatlari, ~3.0 va ~6.5 m/s.
- 5× rejoin: `liveInstances` har safar 1↔2, oqish yo‘q; heap 65–66 MB oralig‘ida.
- FFA smoke: PASS.
- Forest Survival: konteynerga borish → ochish → buyum olish → qurol equip → B qurolni ko‘radi → spectator cycle → round reset: hammasi PASS.
- INFO: Interact animatsiyasi faqat mahalliy o‘yinchida (serverda "interact" eventi yo‘q; remote’da ko‘rinmaydi — dizayn bo‘yicha).

**FPS benchmark** (bir xil kamera/seed/preset, warmup 5 s, 20 s × 2, B ko‘rinib turadi). GPU (verbatim): `ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0) Direct3D11 vs_5_0 ps_5_0, D3D11)`, CPU AMD Ryzen 7 6800H. **Intel UHD Graphics 730’da sinov o‘tkazilmagan.**

| Ketma-ket (bir xil sharoit) | FPS median | 1% low | p95 / p99 ms | Draw calls | Tris | Heap |
|---|---:|---:|---:|---:|---:|---:|
| BEFORE (procedural) | 588–625 | 287–330 | 2.3–2.6 / 2.8–3.1 | 213 | 726 207 | 72–79 MB |
| AFTER (Camper Buddy) | 588 | 314–318 | 2.4–2.5 / 2.8–3.0 | **163** | 754 095 | 76–82 MB |

Xulosa: FPS amalda teng (shovqin chegarasida), draw call −50, uchburchak +27.9k. Ilk o‘lchovlar (BEFORE 454 / AFTER 400) mashina boshqa yuk ostida bo‘lganda olingan — ular yaroqsiz deb hisoblanib, ketma-ket qayta o‘lchandi; barcha JSON’lar `qa_perf_*.json`da.

## 6. Dalillar (`docs/stage08b-char/`)
- `qa_shots/` — `before_*` va `after_*`: 3P idle/run/jump, 1P × 4 qurol, close-up front/side/back × (unarmed + 4 qurol), remote front/side/far, perf sahnasi.
- `qa_videos/` — `walk_3p`, `run_3p`, `walk_side`, `run_side`, `remote_run` (30 fps VP8 webm), before/after.
- `qa_multi_*.json`, `qa_perf_*.json`, `qa_shots_*.json`, `qa_videos_*.json`.
- Eslatma: AFTER skrinshot/video/multi skeleton-ulashish tuzatishidan **oldin** olingan; bu tuzatish vizualni o‘zgartirmaydi (faqat bir xil suyaklar ikki marta hisoblanishi olib tashlandi), perf undan keyin qayta o‘lchandi.

## 7. Real sub-agentlar
| Agent | Vazifa | Natija |
|---|---|---|
| A | Asset registry | ✓ (scratch verify "ALL OK") |
| B | Animatsiya state machine | ✓ (20/20 tekshiruv) |
| C | Aim pose / weapon mount / material | ✓ (aim xato 0.000°) |
| D | Unit/adversarial testlar | ✓ (63 + 1 koordinator testi) |
| E | Brauzer QA va benchmark | ✓ (harness + BEFORE baseline) |
Koordinator (Claude, Opus 5.5) — Gemini emas; integratsion fayllar (`Stickman.ts`, `Game.ts`, `package.json`) faqat koordinatorda.

## 8. Qoldiq risklar / ma’lum cheklovlar
1. **Chap qo‘l stvol ostida emas** — qo‘llar kalta (1.32× qurol bilan maksimal yetish z≈−0.57 m), chap qo‘l magazin atrofida turadi.
2. Uzun qurollar qo‘ndog‘i o‘ng yelkadan o‘tadi (avvalgi procedural modeldagidek); chap yelka ko‘krakka biroz kiradi.
3. Ekstremal pitch (±1.55 rad) da o‘ng qo‘l qoringa ~8 sm kiradi; ±1.0 gacha toza.
4. Sakrash cho‘qqisida holat hali `JumpStart` (klip 0.4 s, cho‘qqi ~0.35 s) — keyin JumpAir.
5. Run’da vizual oyoq radiusi 0.595 m > server kapsulasi 0.4 m — server kollayderi **o‘zgartirilmagan** (talab bo‘yicha); tor joylarda oyoq devorga biroz kirishi mumkin.
6. 1P viewmodel qo‘llari o‘zgarmagan (eski qizil yeng) — 08B doirasidan tashqari.
7. Remote o‘yinchida Interact ko‘rinmaydi (tarmoq eventi yo‘q, protokol o‘zgartirilmadi).
8. `npm test`dagi NavGraph vaqt testi beqaror (oldindan mavjud).
9. Intel UHD 730’da FPS o‘lchanmagan.

**Faqat 08B. STOP — 08C boshlanmagan.**
