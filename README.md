# Camper Strike 65 — 3D LAN Multiplayer FPS

**Mabutts Valley · Route 65** o'rmon vodiysida o'tadigan, karikatura uslubidagi **3D LAN (lokal tarmoq) multiplayer shooter**. Do'stlaringiz bilan bir xil Wi-Fi / LAN tarmog'ida yoki botlarga qarshi **1-shaxs (FPS)** va **3-shaxs (TPS)** ko'rinishida jang qiling: klassik jamoaviy jang, hamma-hammaga qarshi yoki toraygan zona ichida oxirgi tirik qolgan g'olib bo'ladigan **Forest Survival** raundlari.

**Texnologiyalar:** `TypeScript` · `Three.js` (WebGL 3D grafika, GLB modellar) · `Socket.IO` (real vaqtli tarmoq) · `Express` · `Vite` · `Web Audio API` (100% protsedural ovoz)

---

## O'yin rejimlari

| Rejim | Tavsif | Standart limit |
|---|---|---|
| `tdm` | Jamoaviy deathmatch (qizil vs ko'k), respawn bilan | 50 ochko |
| `ffa` | Hamma-hammaga qarshi (Free For All) | 25 o'ldirish |
| `forest_survival` | Oxirgi tirik qolgan g'olib (last-man-standing) raundlari `forest_square` xaritasida: hamma **qurolsiz** boshlaydi, loot konteynerlaridan qurol/o'q/zirh yig'adi, xavfsiz zona bosqichma-bosqich torayadi (zona tashqarisida **5 ta zarar bosqichi**), halok bo'lganlar kuzatuvchi (spectator) rejimiga o'tadi, raund tugagach yangi raund avtomatik boshlanadi | 1 raund g'olibi |

Forest Survival tafsilotlari:
- **Loot:** yog'och qutilar, metall shkaflar, asboblar qutilari (`E` bilan ochiladi); ichidan o'qotar qurollar (slot 1–4), o'q-dorilar, **zirh nimcha** va **kaska**, **aptechkalar** (`H`) va granatalar chiqadi.
- **`minHumans`:** xona sozlamasi — kamida shuncha odam tayyor bo'lmaguncha raund boshlanmaydi (faqat botlar raund boshlamaydi).
- **Kuzatuvchi rejimi:** halok bo'lgan o'yinchi tirik ishtirokchilarni kuzatadi; raund oxirida g'olib e'lon qilinadi.

## Xaritalar

| Xarita | Tavsif |
|---|---|
| `forest_square` (standart) | 256×256 m relyefli (heightfield) o'rmon vodiysi: 6 ta POI (o'rmonchi uyi, kemping uychalari, yog'och ombori, servis stansiyasi, lager, qoyadagi kuzatuv posti), yo'l tarmog'i, ~565 ta to'qnashuvli daraxt, toshlar, butalar va o't qoplami |
| `forest_sample` | Kichik o'rmon namunasi (bitta uycha, test/preview) |
| `forest_assets_preview` | Barcha GLB assetlarni ko'rib chiqish uchun ko'rgazma xaritasi |

> Eski "Dust Arena" xaritasi o'yindan va kod bazasidan butunlay olib tashlangan (`src/shared/map.ts`, tekis `flat` relyef turi va eski AABB harakat funksiyalari o'chirilgan); barcha xaritalar heightfield relyefli.

Dunyo `publicLayoutSeed` dan **deterministik** yaratiladi: server va klient bir xil relyef, binolar, kollayderlar va spawn nuqtalarini hisoblaydi; `gameplayHash` xonaga ulanishda solishtiriladi (mos kelmasa klient qabul qilinmaydi).

## Botlar

- Forest Survival: 0–8 bot (standart 3); klassik rejimlar (`tdm`/`ffa`): 0–16 bot (standart 4).
- Chat buyruqlari: `/addbot` — bot qo'shish, `/removebot` (yoki `/kickbot`) — bitta botni olib tashlash; pauza menyusida ham tugmalar bor.
- Botlar A* navigatsiya to'ri bilan yuradi, binolar ichiga kiradi va loot rejimida **o'zi konteyner ochib qurol yig'adi** (loot AI), zona torayganda markazga intiladi.

## Qurollar va jang

| Slot | Qurol | Izoh |
|---|---|---|
| `1` | Avtomat (`rifle`) | 30 o'qli magazin, tez otish |
| `2` | To'pponcha (`pistol`) | 12 o'q |
| `3` | Drobovik (`shotgun`) | sochma, yaqin masofa |
| `4` | Snayper (`sniper`) | `RMB` optik pritsel, 85 zarar |
| `5` | Jangovar pichoq (`knife`) | **har doim mavjud**, o'q talab qilmaydi; orqadan zarba ×2.2 (backstab) |
| `G` | Granata | har hayotda cheklangan soni, loot rejimida konteynerlardan |

- Loot rejimida (`forest_survival`) o'qotar qurollar faqat konteynerlardan topiladi; klassik rejimlarda to'liq arsenal bilan spawn bo'linadi.
- Zarar zonalari: **bosh / tana / oyoq** (har qurolda o'z koeffitsiyenti); zirh nimcha va kaska zararning bir qismini yutadi.

## Boshqaruv tugmalari

| Tugma | Amal |
|---|---|
| `W` `A` `S` `D` | Harakatlanish |
| `Sichqoncha` | Atrofga qarash / nishonga olish |
| `Chap tugma (LMB)` | O'q uzish / pichoq bilan urish |
| `O'ng tugma (RMB)` | Snayper optik pritseli (zoom) |
| `V` | 1-shaxs / 3-shaxs kamerasini almashtirish |
| `Space` | Sakrash |
| `Shift` | Sprint (chidamlilik — stamina bilan cheklangan) |
| `R` | Qayta o'qlash |
| `1–5`, `G'ildirak`, `Q` | Qurol almashtirish (`Q` — oldingi qurol) |
| `0` | Qurolni yig'ishtirish (holster; loot rejimida) |
| `E` | Konteynerni ochish / yerdagi buyumni olish |
| `H` | Aptechka ishlatish |
| `G` | Granata uloqtirish |
| `Tab` | Hisob jadvali (scoreboard) |
| `N` | Mini-xarita: radar ↔ butun xarita |
| `Enter` yoki `T` | Chat yozish |
| `M` | Jamoani almashtirish (`tdm` rejimida) |
| `Esc` | Pauza va sozlamalar menyusi |

---

## Ishga tushirish

**Talab:** [Node.js](https://nodejs.org) `^20.19.0 || >=22.12.0` (`package.json` → `engines`; Vite 8 talabi, Node 18 qo'llab-quvvatlanmaydi).

```bash
npm install      # paketlarni o'rnatish (birinchi marta)
npm start        # klientni build qiladi va serverni 3000-portda ishga tushiradi
```

Server ishga tushganda konsolda manzillar ko'rsatiladi:

```text
Shu kompyuterda:   http://localhost:3000
Lokal tarmoqda:    http://192.168.0.8:3000
```

- **Server kompyuterida:** brauzerda `http://localhost:3000` manzilini oching.
- **Boshqa kompyuterlarda (bir xil Wi-Fi / LAN):** `http://<server-IP>:3000` manzilini oching (bu manzil o'yin lobbisida ham ko'rinadi).

> **Windows Firewall eslatmasi:** Birinchi marta ishga tushirganda Windows "Node.js" uchun tarmoq ruxsatini so'rasa, **Private networks** katakchasini belgilab ruxsat bering.

### Dasturlash (Dev) rejimi

```bash
npm run dev
```

Express/Socket.IO serveri (`http://localhost:3000`) va Vite HMR dev serveri (`http://localhost:5173`) bir vaqtda ishga tushadi.

### npm skriptlari

| Skript | Vazifa |
|---|---|
| `npm run dev` | Server (`tsx watch`) + Vite dev server birga |
| `npm run build` | Klientni `dist/` ga production build qilish |
| `npm start` | Build + serverni ishga tushirish |
| `npm run serve` | Faqat serverni ishga tushirish (tayyor `dist/` bilan) |
| `npm run typecheck` | TypeScript turlarini tekshirish (`tsc --noEmit`) |
| `npm test` | Birlik/integratsiya testlari (`tsx --test`, shared/server/client) |
| `npm run test:perf` | Server tick va dunyo generatsiyasi performans testlari |
| `npm run validate:assets` | `public/models` dagi GLB assetlarni manifestlarga qarshi tekshirish (`tools/`) |

Brauzer orqali o'tkaziladigan QA harnesslari (`scripts/qa-stage*.mjs`) haqida — `scripts/README.md`.

---

## Arxitektura

- **Server-avtoritativ harakat:** klient o'z harakatini darhol bashorat qiladi (client prediction), server esa kirish buyruqlarini (`seq` bilan) qayta simulyatsiya qilib tasdiqlaydi; farq bo'lsa klient serverga moslashadi (reconciliation). Tezlik/`dt` chegaralari server tomonida tekshiriladi (anti-cheat).
- **Avtoritativ jang, loot va survival:** o'q uzish (raycast + bosh/tana/oyoq xitbokslari), zarar, zirh, granata portlashi, konteyner ochish/buyum olish (poyga holatlari — race-condition — serverda hal qilinadi), raund holati va zona torayishi faqat serverda hisoblanadi.
- **Tarmoq:** server `30 Hz` da snapshot yuboradi; klient boshqa o'yinchilar va granatalarni `100 ms` bufer bilan silliq interpolyatsiya qiladi.
- **Deterministik dunyo:** `src/shared` dagi dunyo generatori server va klientda bir xil ishlaydi (`publicLayoutSeed` → relyef, POI'lar, kollayderlar, spawnlar, `gameplayHash`); loot tarkibi esa faqat serverdagi maxfiy seed'dan yaratiladi.
- **Grafika:** 55 ta GLB model (`public/models`): binolar 8, personaj 1 (skinned "Camper Buddy" — yuklanmasa protsedural zaxira model), o'rmon 7, o't/gullar 17, interyer 6, loot 3, tashqi muhit 8, qurollar 5. Instanced rendering, kuchsiz GPU'lar uchun **adaptiv sifat** (FPS pasaysa sifat avtomatik tushadi).
- **Ovoz:** barcha tovushlar (otishma, qadamlar, zarba, portlash, UI) Web Audio API orqali **protsedural** yaratiladi — repoda birorta audio fayl yo'q.

---

## Loyiha tuzilishi

```text
src/
  shared/                       # Klient va server uchun umumiy, deterministik modullar
    constants.ts                # O'yin konstantalari (rejimlar, tick rate, HP, fizika, vaqtlar)
    math.ts                     # Vektor/burchak matematikasi, kvantlash (q3)
    physics.ts                  # AABB kollayderlar, raycast, xitbokslar, harakat va granata fizikasi
    netMovement.ts              # Harakat simulyatsiyasi (server va klient bashorati bir xil), sprint/stamina
    protocol.ts                 # Socket.IO xabarlari (lobby, snapshot, loot, survival, chat) interfeyslari
    weapons.ts                  # Qurollar jadvali (zarar, magazin, tepki, pichoq backstab)
    world.ts                    # WorldDefinition, xaritalar ro'yxati, seeded RNG, gameplayHash va moslik tekshiruvi
    terrain.ts                  # Heightfield relyef: balandlik namunalari, nishablik, mesh ma'lumotlari
    forestSquare*.ts            # forest_square xaritasi: relyef, yo'llar, o'simliklar, 36 spawn nuqtasi
    forestSample.ts             # forest_sample xaritasi va o'rmon generatori yordamchilari
    forestProps.ts, groundCover.ts, spatialIndex.ts   # Qattiq prop kollayderlar, o't qoplami, fazoviy indeks
    structures/                 # Modulli binolar: POI maketlari, devor/tom/zina manifestlari, layout builder
    outdoor/                    # Tashqi muhit obyektlari (belgi ustunlari, gulxan, bochka...) joylashuvi va kollayderlari
    loot/                       # Loot katalogi (qurol, o'q, zirh, kaska, aptechka), kontraktlar, LOS tekshiruvi
    survival/                   # Forest Survival: konfiguratsiya, raund holat mashinasi, zona torayishi
    __tests__/, __perf__/       # Birlik testlari va performans testlari (tsx --test)
  server/                       # Node.js avtoritativ o'yin serveri
    index.ts                    # Express + Socket.IO server, dist/ ni tarqatish, LAN IP aniqlash
    lobby.ts                    # Xonalar ro'yxati, xona yaratish parametrlari (rejim, xarita, botlar, limitlar)
    room.ts                     # O'yin sikli (30 Hz): harakat tasdiqlash, jang, zarar, o'lim, match holati
    movementAuthority.ts        # Kirish buyruqlari navbati, dt/tezlik chegaralari, qayta sinxronlash
    bot.ts, botLocalPath.ts     # Bot AI (ko'rish, nishon, otish, loot AI) va mahalliy yo'l topish
    navgraph.ts, minHeap.ts     # Botlar uchun yurish to'ri va A* yo'l topish
    combat/                     # Granata partiyasi va qurol almashtirish vaqtini server tomonida tekshirish
    loot/                       # Konteyner/buyum generatori (maxfiy seed) va xona loot avtoriteti
    survival/                   # Forest Survival raund kontrolleri (kutish → sanoq → o'yin → yakun)
  client/                       # Three.js brauzer klienti
    main.ts                     # Asosiy menyu, lobby, xona yaratish/ulanish, assetlarni oldindan yuklash
    settings.ts                 # Sozlamalar (ism, sezgirlik, ovoz, FOV, sifat) — localStorage
    style.css, menu/            # UI/HUD uslublari va kunduzgi kemping menyusi vizuallari
    game/
      Game.ts                   # Asosiy o'yin sikli, kamera (1P/3P), tarmoq interpolyatsiyasi, kirish qayta ishlash
      LocalPlayer.ts            # Lokal o'yinchi: harakat bashorati, qurol taymerlari
      ClientPrediction.ts       # Server bilan solishtirish (reconciliation) va silliq tuzatish
      World.ts                  # Dunyo sahnasi: relyef, binolar, o'rmon, obyektlar, kollayderlarni yig'ish
      ForestRenderer.ts, forestSquareSceneHelpers.ts, GroundCoverRenderer.ts, BoundaryFence.ts
                                # O'rmon, o't qoplami va xarita chegarasi render qilish
      Stickman.ts, ViewModel.ts # Boshqa o'yinchilar modeli (Camper Buddy / zaxira) va 1-shaxs qo'l-qurol
      GunModels.ts, WeaponAssetRegistry.ts   # GLB qurol modellari, protsedural zaxira va 3D ikonkalar
      Effects.ts, Textures.ts   # Gilzalar, trasserlar, portlash, qon; protsedural canvas teksturalar
      Hud.ts, MiniMap.ts        # HUD, killfeed, hisob jadvali, pritsel; radar / butun xarita
      Audio.ts, surface.ts      # Protsedural 3D ovozlar, yuza turiga qarab qadam tovushi
      Input.ts                  # Klaviatura va Pointer Lock boshqaruvi
      animation/, character/    # Camper Buddy skinned personaj: animator, lokomotsiya, qurol va jihoz biriktirish
      buildings/, interiors/, outdoor/, containers/, grass/, terrain/
                                # GLB asset registrlari va instanced renderlar (binolar, mebel, tashqi obyektlar,
                                # loot konteynerlari, 17 o't varianti, relyef materiali)
      loot/, survival/          # Loot UI (konteyner, inventar, yerdagi buyumlar) va survival UI (zona devori, kuzatuvchi)
      debug/                    # DEV-only kolliziya debug overlay (F9)
public/
  models/                       # 55 ta GLB: buildings/ characters/ forest/ grass/ interior/ loot/ outdoor/ weapons/
  ui/menu/                      # Menyu rasmlari
scripts/                        # Brauzer QA harnesslari, benchmark, asset yordamchilari (scripts/README.md)
tools/                          # GLB asset validatorlari (npm run validate:assets) va ularning manifestlari
```
