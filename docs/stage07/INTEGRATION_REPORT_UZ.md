# BOSQICH 07 (STAGE 07) — FOREST SURVIVAL REJIMI VA STAGE 06 AUDIT TUZATISHLARI INTEGRATSIYA HISOBOTI

## 1. Bajarilgan ishlar umumiy tavsifi

Ushbu bosqichda **Stage 06 mustaqil kod auditi** davomida aniqlangan 2 ta muhim xavfsizlik/to‘liqlik kamchiligi birinchi navbatda bartaraf etildi hamda **Stage 07 — Forest Survival (`forest_survival`)** o‘yin rejimi server-authoritative arxitektura asosida to‘liq qurildi:

1. **Stage 06 Audit Tuzatishi #1 (`NOT_IN_LOOT_MODE` darvozasi):**
   - [`RoomLootAuthority`](file:///d:/Stickman-strike/src/server/loot/RoomLootAuthority.ts) ichiga qat’iy `this.lootEnabled` tekshiruvi qo‘shildi.
   - Klassik `tdm` va `ffa` (`lootPreview: false`, `lootEnabled: false`) rejimlarida `container:open`, `loot:pickup`, `inventory:useMedkit` hamda `inventory:equip(null)` (qurolsiz holatga o‘tish) so‘rovlari server tomonidan `ok: false, code: 'NOT_IN_LOOT_MODE'` bilan rad etiladi (`stats.rejectedNotInLootMode` hisoblagichi bilan).
   - Klassik rejimda o‘yinchining mavjud 4 ta qurolini (`rifle`, `pistol`, `shotgun`, `sniper`) almashtirishi (`equipWeapon`) odatdagidek ishlaydi.

2. **Stage 06 Audit Tuzatishi #2 (`roundId` + `spawnId` bo‘yicha idempotency va eskirgan ACK himoyasi):**
   - [`RoomLootAuthority`](file:///d:/Stickman-strike/src/server/loot/RoomLootAuthority.ts) idempotency keshi kalitlari `${playerId}:r${this.roundId}:s${player.spawnId}:${action}:${requestId}` formatiga o‘tkazildi.
   - O‘yinchi qayta tug‘ilganda (`resetPlayerForSpawn`), xonadan chiqqanda (`removePlayer`) yoki yangi raund boshlanganda (`resetForRound`) eski idempotency yozuvlari tozalanadi.
   - Konteyner ichidagi har bir buyum identifikatori raundga bog‘landi: `itm:${roomId}:r${roundId}:c${cntIdx}:${slotIdx}`.
   - Mijoz tomonida [`LocalPlayer.applyInventorySnap`](file:///d:/Stickman-strike/src/client/game/LocalPlayer.ts) va [`Game.isStaleAckContext`](file:///d:/Stickman-strike/src/client/game/Game.ts) orqali eski `roundId`, eski `spawnId` yoki kichik `inventoryVersion` qiymatiga ega kechikib kelgan ACK/snapshotlar inkor etiladi.

3. **Stage 07 — Server-Authoritative Forest Survival (`forest_survival`) rejimi:**
   - Faqat `256×256` o‘lchamli `forest_square` (6 ta POI, 26 ta konteyner, 28 ta GLB model) xaritasida ishlaydi (`dust_arena` rad etiladi, botlar `0`, `/addbot` va `switchTeam` bloklangan).
   - To‘liq 4 fazali raund davriyligi ([`SurvivalRoundController`](file:///d:/Stickman-strike/src/server/survival/SurvivalRoundController.ts)):
     - **`waiting`**: Kamida 2 ta tayyor inson o‘yinchisi yig‘ilguncha kutish (`Tayyor: 1/2`). Raund boshlanmaydi, g‘olib e’lon qilinmaydi, konteyner ochish `ROUND_NOT_ACTIVE` bilan rad etiladi.
     - **`countdown`**: 2+ o‘yinchi tayyor bo‘lganda `10s` taymer boshlanadi; agar o‘yinchi chiqib ketib tayyorlar soni `< 2` bo‘lib qolsa, taymer bekor qilinib `waiting` holatiga qaytadi.
     - **`playing`**: Barcha ishtirokchilar (`contender`) `forest_square` bo‘ylab xavfsiz spawn nuqtalarida **qurolsiz** (`weapon = null`, `ammo = 0`, `grenades = 0`, `medkits = 0`) paydo bo‘ladi. 26 ta konteyner yangi maxfiy `secretLootSeed` bilan yopiq (`closed`) holatda yaratiladi.
     - **Eliminatsiya va Tomoshabin (Spectator) rejimi**: Halok bo‘lgan ishtirokchi **qayta tirilmaydi** (`respawnAt = Infinity`, 3 soniyalik auto-respawn o‘chirilgan), darhol `eliminated` roliga o‘tadi va tirik qolgan ishtirokchilarni 1P/3P kamerada (`[A]` / `[D]` va `[V]`) kuzatadi ([`SpectatorController`](file:///d:/Stickman-strike/src/client/game/survival/SpectatorController.ts)). O‘yin davom etayotgan paytda (`playing` yoki `ended`) xonaga kirgan yangi o‘yinchi joriy raundda `spectator` bo‘lib turadi va keyingi raunddan boshlab ishtirokchiga aylanadi.
     - **`ended` (G‘olib yoki Durang)**:
       - Faqat 1 ta tirik ishtirokchi qolganda (`last_standing`) yoki raqib chiqib ketganda (`opponent_disconnected`) o‘sha o‘yinchi g‘olib deb e’lon qilinadi.
       - Oxirgi 2 ishtirokchi bir vaqtda (masalan, granata portlashida) halok bo‘lsa (`draw_mutual_elimination`) yoki raund vaqti tugaganda `>= 2` o‘yinchi tirik bo‘lsa (`draw_timeout`), natija **DURRANG (`draw`)** bo‘ladi — vaqt tugaganda kill soni bo‘yicha g‘alaba berilmaydi!
       - `ended` fazasi tugagach, `roundId` oshadi (`1 -> 2 -> 3`), yangi `secretLootSeed` bilan barcha 26 ta konteyner va inventarlar to‘liq tiklanib keyingi raund boshlanadi.

---

## 2. Parallel Sub-agentlar va Fayl Egaligi (File Ownership)

Vazifalar 6 ta ixtisoslashgan sub-agent o‘rtasida qat’iy fayl chegaralari bilan parallel taqsimlandi:

| Sub-agent | Rol | Tegishli fayllar | Holat |
|---|---|---|---|
| **Sub-agent A** | Match State & Shared Survival Contracts | [`src/shared/survival/contracts.ts`](file:///d:/Stickman-strike/src/shared/survival/contracts.ts), [`src/shared/survival/stateMachine.ts`](file:///d:/Stickman-strike/src/shared/survival/stateMachine.ts), [`src/shared/survival/index.ts`](file:///d:/Stickman-strike/src/shared/survival/index.ts) | Yakunlandi |
| **Sub-agent B** | Server Survival Round Controller | [`src/server/survival/SurvivalRoundController.ts`](file:///d:/Stickman-strike/src/server/survival/SurvivalRoundController.ts), [`src/server/survival/index.ts`](file:///d:/Stickman-strike/src/server/survival/index.ts) | Yakunlandi |
| **Sub-agent C** | Stage 06 Audit Fixes & Round Loot Reset | [`src/shared/loot/contracts.ts`](file:///d:/Stickman-strike/src/shared/loot/contracts.ts), [`src/shared/loot/catalog.ts`](file:///d:/Stickman-strike/src/shared/loot/catalog.ts), [`src/server/loot/lootGenerator.ts`](file:///d:/Stickman-strike/src/server/loot/lootGenerator.ts), [`src/server/loot/RoomLootAuthority.ts`](file:///d:/Stickman-strike/src/server/loot/RoomLootAuthority.ts) | Yakunlandi |
| **Sub-agent D** | Client Spectator Camera & Survival HUD | [`src/client/game/survival/SpectatorController.ts`](file:///d:/Stickman-strike/src/client/game/survival/SpectatorController.ts), [`src/client/game/survival/SurvivalUI.ts`](file:///d:/Stickman-strike/src/client/game/survival/SurvivalUI.ts), [`src/client/game/survival/index.ts`](file:///d:/Stickman-strike/src/client/game/survival/index.ts) | Yakunlandi |
| **Sub-agent E** | Adversarial & Unit/Integration Tests | [`src/shared/__tests__/stage07-survival.test.ts`](file:///d:/Stickman-strike/src/shared/__tests__/stage07-survival.test.ts) | Yakunlandi (15/15 PASS) |
| **Sub-agent F** | Multi-Client Browser QA, 12 Screenshots & FPS Benchmark | [`scripts/qa-stage07.mjs`](file:///d:/Stickman-strike/scripts/qa-stage07.mjs), [`docs/stage07/benchmark.json`](file:///d:/Stickman-strike/docs/stage07/benchmark.json), [`docs/stage07/benchmark.csv`](file:///d:/Stickman-strike/docs/stage07/benchmark.csv), `docs/screenshots/stage07/*.png` | Yakunlandi (12 PNG, 0 xato) |
| **Asosiy Agent** | Arxitektura, Umumiy Protokol va Integratsiya | [`src/shared/constants.ts`](file:///d:/Stickman-strike/src/shared/constants.ts), [`src/shared/protocol.ts`](file:///d:/Stickman-strike/src/shared/protocol.ts), [`src/server/lobby.ts`](file:///d:/Stickman-strike/src/server/lobby.ts), [`src/server/room.ts`](file:///d:/Stickman-strike/src/server/room.ts), [`src/client/main.ts`](file:///d:/Stickman-strike/src/client/main.ts), [`src/client/game/LocalPlayer.ts`](file:///d:/Stickman-strike/src/client/game/LocalPlayer.ts), [`src/client/game/Hud.ts`](file:///d:/Stickman-strike/src/client/game/Hud.ts), [`src/client/game/Game.ts`](file:///d:/Stickman-strike/src/client/game/Game.ts), [`index.html`](file:///d:/Stickman-strike/index.html), [`src/client/style.css`](file:///d:/Stickman-strike/src/client/style.css) | Yakunlandi |

---

## 3. Avtomatlashtirilgan Testlar (`100/100 PASS`)

- `npm run typecheck` — **0 xato** (`tsc --noEmit`).
- `npm test` — **12 ta test to‘plami, jami 100 ta test: 100 PASS, 0 FAIL**.
- [`src/shared/__tests__/stage07-survival.test.ts`](file:///d:/Stickman-strike/src/shared/__tests__/stage07-survival.test.ts) ichidagi 15 ta majburiy test ssenariysi:
  1. Klassik TDM/FFA (`lootPreview: false`) rejimida `openContainer`, `pickupItem`, `useMedkit`, `equipWeapon(null)` amallarining `NOT_IN_LOOT_MODE` bilan rad etilishi.
  2. `roundId` va `spawnId` o‘zgarganda eski `requestId` javoblarining qayta qo‘llanmasligi hamda `LocalPlayer.applyInventorySnap` da eskirgan snapshotlarning rad etilishi.
  3. `forest_survival` rejimining faqat `forest_square` xaritasida ishlashi (`dust_arena` rad etilishi), `0` bot va `switchTeam` bloklanishi.
  4. Kamida 2 ta o‘yinchi sharti (`1/2 Tayyor` holatda `waiting` fazasida kutish va `ROUND_NOT_ACTIVE` himoyasi).
  5. 2-o‘yinchi tayyor bo‘lganda `countdown` boshlanishi va o‘yinchi chiqib ketsa `waiting` holatiga qaytishi.
  6. Raund boshlanganda (`playing`) barcha ishtirokchilarning qurolsiz (`weapon === null`) paydo bo‘lishi va 26 ta konteynerning yopiq (`closed`) bo‘lishi.
  7. O‘yinchi o‘ldirilganda 3 soniyadan keyin ham (`6.0s` sinovda) qayta tirilmasligi va `eliminated` roliga o‘tishi.
  8. Safdan chiqqan (`eliminated`) o‘yinchining harakat, otishma, qayta o‘qlash, granata va konteyner/inventar amallarining server tomonidan bloklanishi (`PLAYER_DEAD`).
  9. Raund davomida (`playing`) qo‘shilgan 3-o‘yinchining `spectator` bo‘lib kirishi va joriy raund hisobiga ta’sir qilmasligi.
  10. Oxirgi tirik qolgan ishtirokchining g‘olib bo‘lishi (`last_standing`) va g‘olib faqat 1 marta e’lon qilinishi (`roundDeclareCount === 1`).
  11. Oxirgi 2 ishtirokchi bir vaqtda granatadan halok bo‘lganda (`0 alive`) natija `draw_mutual_elimination` (`winnerId === null`, `winner === 'draw'`) bo‘lishi.
  12. Raund vaqtida raqib ulanishni uzganda qolgan tirik ishtirokchining g‘olib bo‘lishi (`opponent_disconnected`).
  13. Raund vaqti tugaganda `>= 2` o‘yinchi tirik bo‘lsa, kill sonidan qat’i nazar (`p1.kills = 1`, `p2.kills = 0`) natija `draw_timeout` bo‘lishi.
  14. Ketma-ket 3 ta raund (`roundId = 1 -> 2 -> 3`) davomida barcha 26 ta konteyner, `secretLootSeed`, o‘yinchi inventarlari va tomoshabinlarning yangi raundda to‘liq tiklanishi.
  15. [`SpectatorController`](file:///d:/Stickman-strike/src/client/game/survival/SpectatorController.ts) nishon almashtirish (`cycleTarget`), nishon o‘lganda avtomatik keyingi tirik o‘yinchiga o‘tish va `overview` kameraga qaytish mantiqi.

---

## 4. Haqiqiy Brauzer Sinovlari va 12 ta Skrinshot (`1280×720`, `DPR=1`)

[`scripts/qa-stage07.mjs`](file:///d:/Stickman-strike/scripts/qa-stage07.mjs) orqali 3 ta parallel Headless Chromium mijozida (`Survival_Alpha`, `Scout_Bravo`, `Spec_Charlie`) barcha fazalar tekshirildi (`0` console error, `0` page error, `0` network error):

| # | Skrinshot fayli | O‘lchami | Hajmi | Tavsifi |
|---|---|---|---|---|
| 01 | [`01_lobby_forest_survival_mode_select.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/01_lobby_forest_survival_mode_select.png) | `1280×720` | `258,973 B` | Lobbida `Forest Survival` tanlanganda xarita (`forest_square`) va botlar (`0`) qulflanishi |
| 02 | [`02_waiting_for_players_1of2_uz.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/02_waiting_for_players_1of2_uz.png) | `1280×720` | `585,848 B` | `waiting` fazasi (`Tayyor: 1/2`, o‘yinchilar kutilmoqda banneri) |
| 03 | [`03_countdown_2of2_preround_uz.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/03_countdown_2of2_preround_uz.png) | `1280×720` | `591,486 B` | `countdown` fazasi (`Tayyor: 2/2`, `Raund boshlanishiga: 10 soniya`) |
| 04 | [`04_round1_unarmed_start_3p_hud.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/04_round1_unarmed_start_3p_hud.png) | `1280×720` | `507,080 B` | 1-raund boshlanishi (`Tirik: 2/2`), 3P qurolsiz holat va survival HUD |
| 05 | [`05_round1_unarmed_start_1p_empty_hands.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/05_round1_unarmed_start_1p_empty_hands.png) | `1280×720` | `506,626 B` | 1-raund boshlanishi, 1P kamerada bo‘sh qo‘l holati |
| 06 | [`06_container_open_and_loot_panel.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/06_container_open_and_loot_panel.png) | `1280×720` | `501,386 B` | POI konteyneri ochilishi, 3D buyumlar va `#stage06-container-panel` |
| 07 | [`07_weapon_equipped_after_pickup_3p.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/07_weapon_equipped_after_pickup_3p.png) | `1280×720` | `531,515 B` | Konteynerdan qurol va patron olingach 3P ko‘rinishda jihozlanishi |
| 08 | [`08_pvp_combat_elimination_in_progress.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/08_pvp_combat_elimination_in_progress.png) | `1280×720` | `566,603 B` | 2 mijoz o‘rtasida jonli PvP otishma |
| 09 | [`09_eliminated_spectator_mode_follow_3p.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/09_eliminated_spectator_mode_follow_3p.png) | `1280×720` | `568,672 B` | Safdan chiqqan (`#2-o'rin`) o‘yinchida Kuzatuvchi rejimi (3P follow kamera) |
| 10 | [`10_midjoin_spectator_mode_1p.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/10_midjoin_spectator_mode_1p.png) | `1280×720` | `594,552 B` | Raund o‘rtasida qo‘shilgan 3-mijoz (`Spec_Charlie`) Kuzatuvchi rejimi (1P kamera) |
| 11 | [`11_winner_overlay_round_end_uz.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/11_winner_overlay_round_end_uz.png) | `1280×720` | `529,040 B` | Raund yakuni g‘olib oynasi (`🏆 G'ALABA! SIZ OXIRGI TIRIK QOLGAN O'YINCHISIZ!`) |
| 12 | [`12_round2_reset_fresh_unarmed_spawn.png`](file:///d:/Stickman-strike/docs/screenshots/stage07/12_round2_reset_fresh_unarmed_spawn.png) | `1280×720` | `584,653 B` | 2-raund (`RAUND #2 · Tirik: 3/3`) avtomatik tiklanishi va 3 ishtirokchining qurolsiz spawn bo‘lishi |

---

## 5. Barqaror FPS Benchmark (`10s Warmup + 30s Measurement × 3 Repeats`)

- **Qurilma / GPU**: `ANGLE (Intel, Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0, D3D11)`
- **O‘lcham**: `1280×720` (`DPR = 1.0`)
- **To‘liq ma’lumotlar**: [`docs/stage07/benchmark.json`](file:///d:/Stickman-strike/docs/stage07/benchmark.json) va [`docs/stage07/benchmark.csv`](file:///d:/Stickman-strike/docs/stage07/benchmark.csv)

| Sahna | Sifat | O‘rtacha FPS | Median (P50) FPS | P10 FPS | 1% Low FPS | Frame P50 (ms) | Frame P95 (ms) | Frame P99 (ms) | Draw Calls | Triangles | Geometries | Textures | Culling Avg / P95 (ms) | Heap Start -> End (MB) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `survival_spawn_and_loot` | `medium` | **176.12** | 256.41 | 103.09 | 33.44 | 3.9 | 14.0 | 29.9 | 95 | 252,238 | 82 | 12 | 0.0517 / 0.1000 | 53.68 -> 55.29 |
| `poi_container_interaction` | `medium` | **87.64** | 98.04 | 64.94 | 27.93 | 10.2 | 19.9 | 35.8 | 162 | 459,554 | 82 | 12 | 0.0569 / 0.1000 | 59.35 -> 58.65 |
| `final_1v1_combat` | `medium` | **150.31** | 178.57 | 121.95 | 37.88 | 5.6 | 12.2 | 26.4 | 47 | 360,268 | 132 | 15 | 0.0893 / 0.2000 | 58.67 -> 60.41 |
| `final_1v1_combat` | `low` | **146.51** | 149.25 | 136.99 | 104.17 | 6.7 | 8.0 | 9.6 | 44 | 339,096 | 132 | 13 | 0.0752 / 0.1000 | 59.68 -> 62.66 |
| `spectator_camera` | `medium` | **105.61** | 108.70 | 90.09 | 70.42 | 9.2 | 12.2 | 14.2 | 106 | 280,912 | 131 | 11 | 0.0478 / 0.1000 | 59.45 -> 60.87 |
| `spectator_camera` | `low` | **104.00** | 105.26 | 98.04 | 79.37 | 9.5 | 10.8 | 12.6 | 101 | 221,852 | 131 | 9 | 0.0432 / 0.1000 | 59.65 -> 60.48 |

### Xotira va GPU Resurslari Barqarorligi
- **Ketma-ket 3 ta survival raund (`Round 1 -> Round 2 -> Round 3`)**:
  - `Round 2 -> Round 3`: `geometries: 152 -> 153`, `textures: 12 -> 12`, `programs: 28 -> 28`, `heapUsedMB: 58.03 MB -> 57.94 MB`.
- **10 marta ketma-ket `forest_survival` xonasiga qayta kirish-chiqish (`Cycle 2 -> Cycle 10`)**:
  - `geometriesDelta = 0` (`82 -> 82`)
  - `texturesDelta = 0` (`9 -> 9`)
  - `programsDelta = 0` (`11 -> 11`)
  - `heapDeltaMB = +2.68 MB` (`56.09 MB -> 58.77 MB`), `leakDetected = false`.
