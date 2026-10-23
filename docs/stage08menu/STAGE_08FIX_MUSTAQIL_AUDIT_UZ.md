# Camper Strike 65 — Stage 08-FIX mustaqil audit

**Tekshirilgan paket:** `stickman-strike-stage08fix.zip` (2026-10-22)

## Qaror

**08-FIX texnik jihatdan qabul qilinadi.** Oldingi tasdiqlangan qattiq prop colliderlari, aylantirilgan chodir va relyef harakati uchun yangi kod hamda testlar kiritilgan. Ground cover generatori ishlaydi. Biroq kadr vaqtidagi qisqa sakrashlar va ko‘rinish zichligi keyingi visual/performance polish uchun ochiq qoladi.

## Mustaqil isbotlar

- ZIP arxivi: **389 fayl**, CRC tekshiruvi xatosiz; barcha kerakli `src`, `public`, `docs`, `scripts` mavjud.
- `src/shared/forestProps.ts`, `src/shared/groundCover.ts`, `src/client/game/GroundCoverRenderer.ts`, `src/client/game/debug/CollisionDebugOverlay.ts` va tegishli fizik/outdoor o‘zgarishlari mavjud.
- Global TypeScript parser yordamida **108 ta TypeScript fayli**: sintaktik xato **0**. Bu to‘liq typecheck emas.
- Alohida TypeScript transpilation + Node test runner orqali **Stage 08-FIX 37/37 test PASS** (4 test suite: fizika, chodir, log/to‘nka, ground cover).
- Shuningdek 6 ta eski test suite qayta ishga tushirildi: 4 + 5 + 11 + 8 + 5 + 6 = **39/39 PASS** (arena, eski fizika, Stage 05 harakat, Stage 06 loot, Stage 07-QA va world model).
- **Jami mustaqil bajarilgan 76/76 test PASS.** Gemini hisobotidagi **152/152** testlarning hammasi mahalliy muhitda qayta bajarilmagan.
- Oddiy `npm test` bu muhitda bajarilmadi (`tsx` paket o‘rnatilmagan); `npm run typecheck` `@types/node`, `vite/client` bog‘liqliklari yo‘qligi sabab to‘xtadi. Bu loyiha kodidagi xato ekanini anglatmaydi. Vite production build ham mustaqil qayta bajarilmadi.

## Mustaqil hisoblash (seed 6501)

`createForestSquareWorld({publicLayoutSeed:6501})` va `buildForestSquareGroundCover(world)` alohida ishga tushirildi:

| Ko‘rsatkich | Haqiqatan hisoblangan |
|---|---:|
| `worldVersion` | `2` |
| `gameplayHash` | `670a9c21f0565c94` |
| Collision qutilari | `2341` |
| Visual descriptorlar | `2466` |
| Spawn | `36` |
| Loot konteynerlari | `26` |
| Ground cover instansiyalar | `19123` |
| Maysa (ikki tur) | `16238` |
| Mayda paporotniklar | `1348` |
| Oq/sariq/binafsha gullar | `506 / 538 / 493` (jami `1537`) |
| Ground cover chunklari | `256` |

## Nima yaxshi, nima qolgan?

**Yaxshi:** 79 ta yiqilgan yog‘och va 75 ta to‘nka endi fizik tekshiruvlar bilan qamrab olingan; 2 ta burilgan chodir uchun ichki yo‘lni to‘sib qo‘ygan AABB xatosi bartaraf etilgan; maysa, gul, fern uchun deterministic instance-based rendering bor. Game client `GroundCoverRenderer`ni chaqiradi, quality presetga mos ishlatadi va dispose qiladi.

**Ehtiyot nuqtalar:**

1. Skrinshotlardan o‘rmon yeridagi yangilik ko‘rinadi, ammo katta ochiq joylar **hali siyrak** ko‘rinadi. Yaqin masofadagi model hajmi, rang kontrasti, guruhlangan joylashuv va yer materiallari kelgusida polish talab qiladi.
2. Gemini `qa_summary.json` benchmarkida 1% low FPS taxminan **25–43 FPS** oralig‘ida; ayrim frametime sakrashlari hali bor. Median FPS yaxshi bo‘lishi mumkin, ammo 60 FPS har doim barqaror deb aytilmaydi.
3. F9 collision overlay va ikki Chrome mijozli multiplayer haqida hisobot / QA JSON mavjud. Bu muhitda brauzer + GPU sinovi mustaqil qayta bajarilmadi.
4. `worldVersion=2` va yangi hash sabab server va mijoz bir xil Stage 08-FIX versiyasidan ishlashi shart. Eski buildni yangi serverga qo‘shmang.
5. Bitta snapshot va mavjud testlar barcha kelajakdagi collider xatolari imkonsizligini kafolatlamaydi; o‘yinchining qo‘lda walkthrough sinovi foydali.

## Natija va keyingi bosqich

**08-FIX qabul qilindi.** Keyingi rejalashtirilgan vazifa — foydalanuvchi tasdiqlagan **Daylight Camper Main Menu** (rasm fonida HTML/CSS), faqat kirish/lobby UI. O‘yin fizika/loot/survival/server kodini bu bosqichda o‘zgartirmaslik. `GEMINI_STAGE_08_MENU_DAYLIGHT_SUBAGENTS_UZ.md` faylidagi sub-agentli va Fast QA talablari bilan bajarish.
