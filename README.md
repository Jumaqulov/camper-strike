# 🚐 RV Strike — Route 65: RV Valley (3D LAN Multiplayer Shooter)

**"RV There Yet?"** o'yini uslubidagi quvnoq, karikatura grafikali va boy fizikaga ega **3D LAN (lokal tarmoq) multiplayer shooter** o'yini. Do'stlaringiz bilan bir xil Wi-Fi / LAN tarmog'ida yoki aqlli botlarga qarshi **1-shaxs (FPS)** hamda **3-shaxs (TPS)** ko'rinishida jang qiling!

**Texnologiyalar:** `TypeScript` · `Three.js` (WebGL 3D grafika) · `Socket.IO` (real vaqtli tarmoq) · `Express` · `Vite` · `Web Audio API` (protsedural 3D tovushlar)

---

## ✨ Asosiy Imkoniyatlar

### 🏕️ 1. "Route 65: RV Valley" 3D Xaritasi va Muhiti
- **Mabutts Valley va Mt. Yurbuttsk manzarasi:** Quyosh botishi ("Golden Hour") yoritilishi, baland qoyali tog'lar, qarag'ay o'rmonlari, yog'och ko'priklar va shag'al yo'llar.
- **Lager va RV obyektlari:** 70-yillar uslubidagi Winnebago kemper-furgonlari, `"MABUTTS GAS & COLD BREW"` benzin shoxobchasi, yonib turgan gulxanlar (`Campfire`), piknik stollari va taktik pana joylar.

### 🤠 2. Olti Xil Kulgili 3D Sayohatchi-Kemper Personajlari
Har bir o'yinchi va bot o'ziga xos baqaloq **"Bean / Scout Camper"** qomatiga, jinsi kombinzonga va 6 xil kolleksion bosh kiyim hamda ko'zoynakka ega:
1. **Classic RV Trucker:** Baland *Trucker* kepkasi, qora quyosh ko'zoynagi va baroq mo'ylov.
2. **Wilderness Scout:** Sariq skaut kepkasi, bo'yinda qizil galstuk (*bandana*) va nishonlar taqilgan tasma.
3. **Propeller Beanie Goofball:** Tepasida **aylanib turadigan 3D parrakli (propeller)** shapka va qalin dumaloq ko'zoynak.
4. **Texas RV Cowboy:** Keng kovboy shlyapasi, ko'krakda oltin Sherif yulduzi va uzun mo'ylov.
5. **Backcountry Fisherman:** Baliqchi panama shlyapasi (*Bucket hat*), to'q sariq nimcha va tutab turgan sigaret.
6. **Mt. Yurbuttsk Winter Camper:** Oq bublikli (*Pom-Pom*) qishki shapka, peshonada chang'i ko'zoynagi va qalin soqol.

### 🔫 3. Silliq 3D Qurollar va Realistik Ballistika Fizikasi
Barcha qurollar `THREE.ExtrudeGeometry` (3D faskali silliq konturlar) va silindrik geometriya asosida qurilgan:
- **Avtomat (`Rifle`):** Egilgan "banana" magazin, kollimator (*red-dot*) nishoni, yog'och qundoq va harakatlanuvchi xrom zatvor.
- **To'pponcha (`Pistol`):** `.44 Magnum` 6-otishli xrom revolver — aylanuvchi baraban va yong'oq yog'ochli dasta.
- **Drobovik (`Shotgun`):** 12-kalibrli pompali ov miltig'i — yon tomonida qizil patronlar va tortiladigan yog'och pompa.
- **Snayper (`Sniper`):** Taktik ov miltig'i — zumrad linzali katta optik pritsel, yig'ilgan *bipod* oyoqchalari va harakatlanuvchi zatvor dastasi.
- **3D Ananas-Granata (`Grenade`):** Bo'rtma segmentli korpus, xavfsizlik dastasi va halqaga ega parchalovchi granata.

**Qurol fizikasi:**
- **3D Gilzalar (`ShellCasing`):** O'q uzilganda quroldan jez yoki qizil drobovik gilzalari aylanib otilib chiqadi va yerga urilib sakraydi.
- **Mexanik harakatlar:** Otganda zatvor, revolver barabani va drobovik pompasi ishlaydi; qayta o'qlaganda (`R`) magazin pastga tushib almashadi.
- **Ballistik trasserlar va tutun:** Snayper o'qidan havoda bug' chizig'i (`vapor trail`), drobovikdan olovli sochma izlar va stvol uchidan porox tutuni chiqadi.
- **Prujinali Tepki (`Recoil Recovery`) va Fizik Turtki (`Knockback`):** Otish to'xtaganda kamera pritseli silliq joyiga qaytadi; og'ir qurol yoki granata tekkanda raqibni fizik zarba bilan orqaga uchiradi.

### 💀 4. Qurol Tushishi (`Weapon Drop`) va 6 Xil Kreativ O'lim Animatsiyasi
- **Qurol qo'ldan tushishi:** O'yinchi o'lgan zahoti qo'lidagi 3D qurol havoga aylanib otilib chiqadi, yerga urilib sakraydi va jasad yonida qoladi.
- **Kontekstga mos yiqilishlar:**
  - *Boshga o'q tekkanda (`Headshot`):* Boshi keskin orqaga ketib, tanasi orqaga uchib yiqiladi.
  - *Granata / Drobovik zarbasida:* Havoga baland otilib, charxpalak (*cartwheel*) bo'lib aylanib tushadi.
  - *Oddiy jangda:* Oldinga yuztuban (*faceplant*) qulash, `270°` aylanib tiz cho'kib yonboshga yiqilish, chap yonboshga g'ujanak bo'lib qulash yoki oyoqlari shpagat ochilib yiqilish animatsiyalari.

### 🎯 5. 3D Vizual Killchat va Kamera Rejimlari
- **3D Killchat:** Killchatda ortiqcha yozuvlarsiz, `Three.js` orqali 3D burchak ostida render qilingan qurol tasvirlari va *Headshot* nishoni ko'rinadi.
- **1-shaxs / 3-shaxs Kamera (`V` tugmasi):** O'yin davomida `V` tugmasini bosib, yelka ustidan ko'rinadigan **3-shaxs (TPS)** va klassik **1-shaxs (FPS)** rejimlari o'rtasida erkin almashish mumkin.

---

## 🚀 Ishga Tushirish

**Talab:** [Node.js](https://nodejs.org) `^20.19.0 || >=22.12.0` (`package-lock.json` dagi Vite 8 `engines.node` talabi bo'yicha; Node 18 qo'llab-quvvatlanmaydi).

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

### 🛠️ Dasturlash (Dev) Rejimi

```bash
npm run dev
```

Express/Socket.IO serveri (`http://localhost:3000`) va Vite HMR dev serveri (`http://localhost:5173`) bir vaqtda ishga tushadi.

```bash
npm run typecheck   # TypeScript turlarini tekshirish
npm run build       # Production uchun dist/ papkasiga yig'ish
```

---

## 🎮 Boshqaruv Tugmalari

| Tugma | Amal |
|---|---|
| `W` `A` `S` `D` | Harakatlanish |
| `Sichqoncha` | Atrofga qarash / Nishonga olish |
| `Chap tugma (LMB)` | O'q uzish |
| `O'ng tugma (RMB)` | Snayper optik pritseli (`Zoom`) |
| `V` | **3-shaxs / 1-shaxs kamerasini almashtirish** |
| `Space` | Sakrash |
| `Shift` | Sekin (tovushsiz) yurish |
| `R` | Qayta o'qlash (`Reload`) |
| `1–4`, `G'ildirak`, `Q` | Qurol almashtirish (`Q` — oldingi qurol) |
| `G` | Granata uloqtirish |
| `Tab` | Hisob jadvali (`Scoreboard`) |
| `Enter` yoki `T` | Chat yozish |
| `M` | Jamoani almashtirish (`TDM` rejimida) |
| `Esc` | Pauza va sozlamalar menyusi |

**Chat buyruqlari:**
- `/addbot` — xonaga yangi bot qo'shish
- `/removebot` (yoki `/kickbot`) — bitta botni olib tashlash

---

## 📂 Loyiha Tuzilishi

```text
src/
  shared/                  # Klient va server uchun umumiy modullar
    constants.ts           # O'yin konstantalari (tezlik, fizika, vaqt)
    map.ts                 # "Route 65: RV Valley" xaritasi kolliziyalari va spawn nuqtalari
    math.ts                # Vektor va matematik funksiyalar
    physics.ts             # AABB kolliziya, raycast, xitbokslar va granata fizikasi
    protocol.ts            # Socket.IO tarmoq xabarlari interfeyslari
    weapons.ts             # Qurollar xususiyatlari (zarar, tezlik, magazin, tepki)
  server/                  # Node.js avtoritativ o'yin serveri
    index.ts               # Express + Socket.IO server va LAN IP aniqlash
    lobby.ts               # Xonalar ro'yxati va boshqaruvi
    room.ts                # O'yin sikli (30 Hz), zarar, fizik knockback, o'lim, match
    bot.ts                 # Muvozanatlangan Bot AI (ko'rish, nishon, reaksiya, harakat)
    navgraph.ts            # Botlar uchun A* navigatsiya grafigi
  client/                  # Three.js brauzer klienti
    main.ts                # Asosiy menyu va Lobby interfeysi
    settings.ts            # Sozlamalarni saqlash (sezgirlik, ovoz, FOV)
    style.css              # UI, HUD va 3D Killchat dizayni
    game/
      Game.ts              # Asosiy o'yin sikli, 1P/3P kamera, tarmoq interpolyatsiyasi
      World.ts             # 3D RV Valley dunyosi, tog'lar, kemperlar, daraxtlar
      Stickman.ts          # 6 xil "RV There Yet?" 3D kemper modellari va 6 xil o'lim animatsiyasi
      GunModels.ts         # 3D faskali qurol modellari va 3D WebGL ikonka generatori
      ViewModel.ts         # 1-shaxs qo'l va mexanik qurol animatsiyalari
      Effects.ts           # 3D gilzalar, tushgan qurollar fizikasi, trasserlar, qon va portlash
      Hud.ts               # HUD, 3D Killchat, hisob jadvali va pritsel
      Audio.ts             # Web Audio API orqali protsedural 3D ovoz effektlari
      Textures.ts          # Protsedural Canvas teksturalari
      Input.ts             # Klaviatura va Pointer Lock boshqaruvi
      LocalPlayer.ts       # Klient tomonidagi harakat va qurol taymerlari
```

---

## ⚙️ Tarmoq va Fizika Arxitekturasi

- **Klient harakati:** O'yinchining yurishi va sakrashi klientda darhol hisoblanadi (LAN tarmog'ida kechikishsiz silliq boshqaruv).
- **Avtoritativ jang:** O'q uzish (`raycast` + bosh/tana xitbokslari), zarar hisoblash, fizik zarba turtkisi (`knockback`), granata portlashi va o'lim to'liq server tomonidan tekshiriladi.
- **Silliq interpolyatsiya:** Server `30 Hz` chastotada `Snapshot` yuboradi; klient boshqa o'yinchilar va granatalarni `100 ms` bufer bilan silliq interpolyatsiya qiladi.
- **100% Mustaqil (Zero External Assets):** Barcha 3D modellar, teksturalar va tovush effektlari kod orqali protsedural tarzda yaratiladi — hech qanday tashqi `.glb` yoki `.mp3` fayllar talab qilinmaydi.
