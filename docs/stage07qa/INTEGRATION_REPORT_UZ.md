# STICKMAN STRIKE — STAGE 07-QA (FOREST SURVIVAL STABILIZATION) INTEGRATSIYA HISOBOTI

**Sana:** 2026-10-22  
**Bosqich:** Stage 07-QA — Forest Survival Stabilization (P0/P1/P2 Audit Tuzatishlari)  
**Holat:** **100% BAJARILDI (`npm run typecheck` — `0` xato, `npm test` — `13` suite / `105/105 PASS`, `npm run build` — `PASS`, 3 mijozli Headless Chrome Smoke QA — `0` console/page/network xato)**

---

## 1. Sub-agentlar Taqsimoti va Fayl Egaligi

Vazifalar `GEMINI_STAGE_07_QA_SUBAGENTS_PROMPT_UZ.md` talabiga muvofiq qat'iy fayl egaligi asosida parallel sub-agentlarga bo'lib bajarildi va Asosiy Agent (Coordinator) tomonidan birlashtirildi:

| Agent | Rol va Ma'suliyat | Tegishli Fayllar |
| :--- | :--- | :--- |
| **Sub-agent A** | `Grenade / Explosion Batch Lifecycle` | [`src/server/combat/grenadeBatch.ts`](file:///d:/Stickman-strike/src/server/combat/grenadeBatch.ts) |
| **Sub-agent B** | `Round & Spawn Request Protocol & Validation` | [`src/shared/loot/contracts.ts`](file:///d:/Stickman-strike/src/shared/loot/contracts.ts), [`src/shared/loot/validation.ts`](file:///d:/Stickman-strike/src/shared/loot/validation.ts) |
| **Sub-agent C** | `Server Loot Context & Post-Elimination Idempotency` | [`src/server/loot/RoomLootAuthority.ts`](file:///d:/Stickman-strike/src/server/loot/RoomLootAuthority.ts) |
| **Sub-agent D** | `Equipped Weapon & Switch Cooldown Authority` | [`src/server/combat/weaponSwitchAuthority.ts`](file:///d:/Stickman-strike/src/server/combat/weaponSwitchAuthority.ts), [`src/server/combat/index.ts`](file:///d:/Stickman-strike/src/server/combat/index.ts) |
| **Asosiy Agent** | `Coordinator Integration (Room, Client Game, Existing Tests)` | [`src/server/room.ts`](file:///d:/Stickman-strike/src/server/room.ts), [`src/client/game/Game.ts`](file:///d:/Stickman-strike/src/client/game/Game.ts), [`src/shared/__tests__/stage06-loot.test.ts`](file:///d:/Stickman-strike/src/shared/__tests__/stage06-loot.test.ts), [`src/shared/__tests__/stage07-survival.test.ts`](file:///d:/Stickman-strike/src/shared/__tests__/stage07-survival.test.ts) |
| **Sub-agent E** | `Stage 07-QA Unit & Adversarial Test Suite` | [`src/shared/__tests__/stage07-qa.test.ts`](file:///d:/Stickman-strike/src/shared/__tests__/stage07-qa.test.ts) |
| **Sub-agent F** | `Multi-Client Browser Smoke QA & Screenshots` | [`scripts/qa-stage07-qa.mjs`](file:///d:/Stickman-strike/scripts/qa-stage07-qa.mjs), [`docs/stage07qa/smoke_qa.json`](file:///d:/Stickman-strike/docs/stage07qa/smoke_qa.json), `docs/screenshots/stage07qa/*.png` |

---

## 2. Mustaqil Auditda Aniqlangan 4 ta Muammoning Tuzatilishi

### 2.1. P0 — Granata portlashi raundni yakunlaganda server xatosi (`Room.updateGrenades`)
- **Muammo:** Oldingi `Room.updateGrenades()` bevosita `this.grenades` massivi ustida teskari siklda (`for (let i = this.grenades.length - 1; i >= 0; i--)`) yurgan. Bitta tickda ikki yoki undan ko'p granata bo'lib, birinchi portlagan granata oxirgi raqibni o'ldirganda `handleSurvivalRoundEnd()` `this.grenades = []` qilib massivni tozalagan va siklning keyingi qadami `g = undefined` bo'lib `TypeError: Cannot read properties of undefined (reading 'vel')` xatosini keltirib chiqargan. Shuningdek, bir tick ichida ikki granata ikki so'nggi ishtirokchini o'ldirishi kerak bo'lganda, birinchi portlashdan keyinoq g'olib e'lon qilinib qolishi mumkin edi.
- **Yechim:**
  - [`src/server/combat/grenadeBatch.ts`](file:///d:/Stickman-strike/src/server/combat/grenadeBatch.ts) modulida [`isValidGrenadeRecord`](file:///d:/Stickman-strike/src/server/combat/grenadeBatch.ts#L41-L71), [`stepAndPartitionGrenades`](file:///d:/Stickman-strike/src/server/combat/grenadeBatch.ts#L77-L102) va [`executeGrenadeTickBatch`](file:///d:/Stickman-strike/src/server/combat/grenadeBatch.ts#L110-L144) yaratildi.
  - Har bir tickda granatalar himoyalangan nusxa (`snapshot`) ustida fizik qadamdan o'tkazilib, `exploding` (`nowSec >= explodeAt`) va `remaining` (`nowSec < explodeAt`) guruhlariga ajratiladi.
  - [`Room.updateGrenades`](file:///d:/Stickman-strike/src/server/room.ts#L1030-L1053) butun `exploding` batch davomida `this.deferWinCheck = true` holatini ushlab turadi va barcha portlashlar zarari qo'llanib bo'lgach `onBatchComplete` ichida `this.checkWin()` ni **faqat bir marta** chaqiradi.
  - Natijada:
    1. Sikl davomida `this.grenades = []` bo'lsa ham hech qachon `TypeError` yuz bermaydi.
    2. Bitta tickda ikki alohida granata so'nggi ikki o'yinchini o'ldirsa, ikkala o'lim ham hisobga olinib `draw_mutual_elimination` (`ALL_ELIMINATED` durang) qayd etiladi; agar bitta o'yinchi tirik qolsa, `last_standing` g'olib bo'ladi.
    3. Raund tugagach qolgan (`remaining`) granatalar ham tozalanadi va keyingi raundga o'tib ketmaydi.

### 2.2. P1 — Eski raund yoki kontekstsiz (`roundId`/`spawnId` siz) loot so'rovlarini rad etish
- **Muammo:** Rasmiy mijoz (`Game.ts`) `container:open`, `loot:pickup`, `inventory:equip`, `inventory:useMedkit` so'rovlarida `roundId` va `spawnId` maydonlarini yubormagan, server esa ularni faqat mavjud bo'lgandagina tekshirgan.
- **Yechim:**
  - [`src/shared/loot/contracts.ts`](file:///d:/Stickman-strike/src/shared/loot/contracts.ts) va [`src/shared/loot/validation.ts`](file:///d:/Stickman-strike/src/shared/loot/validation.ts) ichida [`isValidPositiveInt`](file:///d:/Stickman-strike/src/shared/loot/validation.ts#L22-L24) va [`validateRequestRoundAndSpawnContext`](file:///d:/Stickman-strike/src/shared/loot/validation.ts#L29-L65) qo'shildi.
  - [`src/client/game/Game.ts`](file:///d:/Stickman-strike/src/client/game/Game.ts#L983-L1118) ichidagi `requestOpenContainer`, `requestPickupItem`, `requestEquipWeapon` va `requestUseMedkit` metodlari har doim `roundId: this.me.roundId, spawnId: this.me.spawnId` qiymatlarini yuboradi.
  - [`RoomLootAuthority.hasInvalidOrStaleContext`](file:///d:/Stickman-strike/src/server/loot/RoomLootAuthority.ts#L198-L216) survival/loot-enabled rejimlarda `roundId` va `spawnId` musbat butun son bo'lishini hamda joriy `this.roundId` va o'yinchining joriy `spawnId` qiymatiga aynan teng bo'lishini majburiy tekshiradi. Kontekstsiz (`undefined`/`null`), eski (`roundId < current`) yoki kelajakdagi soxta (`roundId > current`, `spawnId > current`) so'rovlar darhol `ok: false, code: 'INVALID_REQUEST'` bilan rad etiladi (`rejectedStaleRoundOrSpawn++`).

### 2.3. P1 — `shoot` xabari orqali `equip` va `switchTime` cooldownni chetlab o'tishni yopish
- **Muammo:** Oldingi `Room.onShoot()` metodida o'yinchi egalik qiladigan, lekin qo'liga olmagan qurolni `m.weapon` qilib yuborsa, server `p.weapon = m.weapon` deb o'zgartirib, `inventory:equip` va `switchTime` kutish vaqtini chetlab o'tib darhol o'q uzishga ruxsat bergan.
- **Yechim:**
  - [`src/server/combat/weaponSwitchAuthority.ts`](file:///d:/Stickman-strike/src/server/combat/weaponSwitchAuthority.ts) modulida [`resetServerWeaponSwitchState`](file:///d:/Stickman-strike/src/server/combat/weaponSwitchAuthority.ts#L31-L35), [`applyAuthoritativeWeaponSwitch`](file:///d:/Stickman-strike/src/server/combat/weaponSwitchAuthority.ts#L45-L68) va [`validateAuthoritativeShotWeapon`](file:///d:/Stickman-strike/src/server/combat/weaponSwitchAuthority.ts#L74-L108) yaratildi.
  - [`Room.onShoot`](file:///d:/Stickman-strike/src/server/room.ts#L565-L589) ichidan `p.weapon = m.weapon` mutatsiyasi butunlay olib tashlandi. Endi `m.weapon` serverdagi joriy faol `p.weapon` ga teng bo'lmasa, otish so'rovi `WEAPON_NOT_EQUIPPED` (`rejectedUnequippedWeaponShots++`) bilan rad etiladi va `p.weapon` hamda o'q-dori o'zgarmaydi.
  - Qurol `onEquipWeapon` yoki harakat paketi orqali almashtirilganda server `p.switchUntil = now + WEAPONS[w].switchTime * 0.75` cooldown o'rnatadi; cooldown tugamasdan yuborilgan `shoot` so'rovlari `SWITCH_COOLDOWN_ACTIVE` (`rejectedSwitchCooldownShots++`) bilan rad etiladi. Qurolsiz o'yinchi birinchi qurolni konteynerdan olganda (`fromAutoPickup: true`) esa darhol o'q uza oladi (`switchUntil = 0`).

### 2.4. P2 — Eliminatsiyadan keyin eski `requestId` qayta yuborilganda idempotent cache replay rad etilishi
- **Muammo:** `RoomLootAuthority` metodlarida idempotency keshi `player.alive` tekshiruvidan oldin o'qilgani sababli, raund davomida tirikligida konteyner ochgan yoki buyum olgan o'yinchi eliminatsiya bo'lgach (spectator holatida) eski `requestId` ni qayta yuborsa `ok: true, idempotentReplay: true` javobini olgan.
- **Yechim:**
  - [`RoomLootAuthority.ts`](file:///d:/Stickman-strike/src/server/loot/RoomLootAuthority.ts) ichida [`onPlayerDeath(playerId)`](file:///d:/Stickman-strike/src/server/loot/RoomLootAuthority.ts#L261-L263) qo'shildi va [`Room.kill`](file:///d:/Stickman-strike/src/server/room.ts#L1005-L1007) chaqirilganda o'lgan o'yinchining idempotency keshi darhol tozalanadi.
  - Bundan tashqari, `openContainer`, `pickupItem`, `equipWeapon` va `useMedkit` metodlarining barchasida `!player.alive` (`!alive`) tekshiruvi idempotency keshidan **oldin** bajariladi: o'lgan yoki spectator bo'lgan o'yinchi eski yoki yangi `requestId` yuborishidan qat'i nazar har doim `ok: false, code: 'PLAYER_DEAD'` javobini oladi.

---

## 3. Fast QA va Yangi Adversarial Testlar Natijalari

- **TypeScript (`npm run typecheck`):** `0` xato (`tsc --noEmit`).
- **Production Build (`npm run build`):** `PASS` (`849 ms`).
- **Unit & Adversarial Testlar (`npm test`):**
  - Jami test to'plamlari (suites): **13 ta** (oldingi 12 ta + yangi [`stage07-qa.test.ts`](file:///d:/Stickman-strike/src/shared/__tests__/stage07-qa.test.ts)).
  - Jami testlar: **105 ta (`105/105 PASS`, `0` fail, `2.11s`)**.
  - Mavjud 100 ta testning birortasi o'chirilmadi; [`stage06-loot.test.ts`](file:///d:/Stickman-strike/src/shared/__tests__/stage06-loot.test.ts) va [`stage07-survival.test.ts`](file:///d:/Stickman-strike/src/shared/__tests__/stage07-survival.test.ts) ichidagi loot/equip/medkit so'rovlari yangi majburiy `roundId` va `spawnId` kontraktiga moslashtirildi.

---

## 4. Multi-Client Live Browser Smoke QA Natijalari

[`scripts/qa-stage07-qa.mjs`](file:///d:/Stickman-strike/scripts/qa-stage07-qa.mjs) yordamida 3 ta haqiqiy Headless Chrome (`1280×720`, `DPR=1`) mijozlari o'rtasida jonli Socket.IO smoke-test o'tkazildi (natijalar [`docs/stage07qa/smoke_qa.json`](file:///d:/Stickman-strike/docs/stage07qa/smoke_qa.json) faylida):

- **P1 (Missing / Stale Context):** `Client 2` konteyner oldiga borib `roundId`/`spawnId` siz (`raw_no_context`) hamda eski `roundId: 99` (`raw_stale_round`) bilan `container:open` yuborganda server `ok: false, code: 'INVALID_REQUEST'` qaytardi; rasmiy `openContainerById` (`roundId: 1, spawnId: 2`) va `pickupLootItem` esa `ok: true` bilan ishladi.
- **P1 (`shoot` Without `equip`):** `Client 1` ikki qurol (`shotgun` va `pistol`) yig'ib, qo'lida `shotgun` turganda `shoot(pistol)` yuborganda server `equippedWeapon` ni `'shotgun'` holatida qoldirdi va `pistol` o'q-dorisi `12 -> 12` o'zgarishsiz qoldi. Rasmiy `equipInventoryWeapon('pistol')` + `switchTime` dan so'ng `pistol` faol bo'ldi.
- **P2 (Eliminated Spectator Replay):** `Client 1` `Client 2` ni yo'q qilgach (`aliveCount = 2/3`), `Client 2` spectator rejimida Round 1 dagi muvaffaqiyatli `c2_valid_open_r1` va `c2_valid_pick_r1` so'rovlarini qayta yuborganda server `ok: false, code: 'PLAYER_DEAD', idempotentReplay: false` qaytardi.
- **P0 (Grenade & Round 2 Transition):** `Client 1` granata portlatib va `Client 3` ni yo'q qilib Round 1 g'olibi bo'ldi (`last_standing`), so'ng Round 2 (`roundId = 2`) avtomatik boshlandi, barcha 3 mijoz qurolsiz holatga va 26 konteyner yopiq holatga qaytdi. Round 2 da Round 1 konteksti (`roundId: 1, spawnId: 1`) bilan yuborilgan `container:open` so'rovi `INVALID_REQUEST` bilan rad etildi.
- **5s Smoke FPS (`medium`, `1280×720`):** `fpsMedian = 200 FPS` (`5.0 ms`), `fpsMean = 111.85 FPS`, `drawCalls = 146`, `consoleErrors = 0`, `pageExceptions = 0`, `networkErrors = 0`.
