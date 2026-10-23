# STAGE 08-MENU — Daylight Camper Main Menu + Lobby UX (sub-agentlar bilan)

## STATUS, KIRISH MATERIALLARI

Bu topshiriqni faqat Stage **08-FIX** yakunlangan va qabul qilingan loyihada bajar. Stage 08-FIX kodi: Forest Square `worldVersion=2`, seed `6501` uchun `gameplayHash=670a9c21f0565c94`. Eski Stage 08A versiyasini qaytarma.

Foydalanuvchi ma’qullagan kunduzgi kemper rasmi bu paketda quyidagi joyda berilgan:
`public/ui/menu/camper-daylight.webp` (optimallashtirilgan WebP, taxminan 293 KB).

**Birinchi qadaming**: bu faylni och, o‘lchamini va uni URL orqali yuklash mumkinligini tekshir. Fayl haqiqatan mavjud bo‘lmasa, eski gradientga xavfsiz fallback bilan ishlashni davom ettir; noma’lum faylni bor deb ko‘rsatma va internetdan tasodifiy boshqa rasm olma.

Asosiy yo‘nalish: kunduzgi, original retro kemper; katta sariq `CAMPING` belgisi chap tomonda, kemper o‘ngda, ortda o‘rmon, tog‘lar va kichik gulxan. Yuqori sifatli, lekin GPU uchun yengil professional o‘yin menyusi. **Bu bosqichda real-time 3D menu yaratma.** Bitta statik WebP + HTML/CSS overlay yetarli.

## 1. AVVAL KODNI O‘RGAN

- `index.html` — `#screen-menu`, `#screen-lobby`, `#screen-menu .menu-bg`, `#name-input`, `#btn-enter`, `#conn-status`, `#room-map`, `#room-mode`, `#btn-create`, `#room-list`, boshqa mavjud IDlar.
- `src/client/style.css` — `.screen`, `.menu-bg`, `.menu-panel`, `.lobby`, `.create-panel`, `.room-item` va boshqa komponentlar.
- `src/client/main.ts` — `show`, `enter`, `hello`, `renderRooms`, `joinRoom`, `startGame`, `leaveGame` va Socket.IO hodisalari.
- `src/client/settings.ts` — foydalanuvchi `name` qiymati allaqachon `localStorage` orqali saqlanadi. Ikkilamchi storage yaratma.
- `src/shared/protocol.ts`, `src/server/lobby.ts` — backend qo‘llab-quvvatlaydigan rejimlar, dunyo tanlash va room oqimi.

**Server protokoli, Forest Survival, qurolsiz start, loot, combat, camera, worldVersion, GLB modellari yoki terrain/kollayderlarga tegma.** UI va mavjud Socket.IO wiring saqlansin.

## 2. TASDIQLANGAN SAHNA / KOMPOZITSIYA

- Tasdiqlangan rasm `#screen-menu` va `#screen-lobby` fonida sifatli `background-image` sifatida ishlatilsin.
- Sariq camping belgisini, gulxan va kemper siluetini katta qora panellar bilan yopma. Birinchi ekranda rasm ustuvor bo‘lsin.
- Matn o‘qilishi uchun faqat kerakli joyda nozik gradient yoki lokal xira yarimshaffof panel qo‘llanilsin. Original quyoshli ranglarni o‘chirma.
- `background-size:cover` cropini 1280×720, 1366×768, 1920×1080 va tor ekranlarda tekshir; fokusni mos `background-position` bilan sozla. Juda tor ekranda alternative positioning ruxsat.
- Oq/iliq sariq matn, yog‘och-jigarrang va to‘q yashil aksent; sodda tipografiya, sezilarli hover/focus va nazokatli mikroanimatsiya.
- `prefers-reduced-motion` bilan animatsiyalar o‘chiriladi.
- HTML/CSS asosida; uchinchi tomon UI kutubxonasini sababsiz qo‘shma.

## 3. FOYDALANUVCHI YO‘LI

### A. Asosiy o‘yin menyusi

Katta `CAMPER STRIKE 65` logotipi va o‘yinchiga mo‘ljallangan aniq tugmalar:

1. **O‘YNASH** — asosiy CTA; o‘yinchi ismi saqlangan bo‘lsa uni qayta majburan kiritma; nickname kerak bo‘lsa ixcham input ko‘rsat.
2. **XONALAR** — mavjud server xona ro‘yxatiga o‘tadi.
3. **SOZLAMALAR** — hozirgi real sozlamalarni ko‘rsatish (sensitivity, volume, FOV, quality), ishlamaydigan dekorativ tugma yaratma.
4. Server holati — Socket.IO `connect`, `disconnect`, `connect_error` ga asoslangan. Server yo‘q bo‘lsa xato tushunarli ko‘rsatiladi va ishlamaydigan “KIRISH”ni success sifatida ko‘rsatma.

Asosiy menyuda login formasi emas, o‘yinning atmosferasi ustuvor; nickname profil burchagida va **O‘ZGARTIRISH** orqali tahrirlanishi mumkin.

### B. Ekspeditsiya / rejim tanlash

- `Forest Survival` — vizual asosiy tavsiya. 256×256 o‘rmon, 6 POI, qurolsiz start va konteyner qidirish haqida 2–3 qisqa fakt.
- `Jamoaviy TDM`, `Hamma hammaga qarshi FFA` — qo‘shimcha rejimlar sifatida mavjud.
- Forest Square normal xarita; `forest_assets_preview`, `forest_sample`, `dust_arena` ni **Boshqa xaritalar** ichida saqla, o‘chirib yuborma.
- Xona yaratish opsiyalaridan eng muhimi: `room name`, rejim, xona turi/maxPlayers. Time/score/bots kabi ikkilamchi sozlamalar **Qo‘shimcha sozlamalar** ichida, ammo saqlangan va ishlaydi.
- Forest Survival rejimida botlar 0 va `lootPreview=true` majburiy — mavjud kod/sanitizeOpts bilan aynan mos tursin; backendga yangi matchmaking endpointini ixtiro qilma.

### C. Xonalar ekrani

- Serverdan keladigan `roomList` / `listRooms` ro‘yxati haqiqiy; har xonada rejim, xarita, odam soni, gameplay fazasi (mavjud bo‘lsa), qo‘shilish holati.
- `Hozircha xonalar yo‘q` holati tushunarli, `YANGI XONA` CTA mavjud.
- `createRoom`, `joinRoom`, `ready`, `worldMismatch`, `leaveRoom` oqimlarini saqla; hech qanday soxta server holatini ko‘rsatma.
- Raqam/tanlov inputlarini validatsiya qil va foydalanuvchiga xatoni o‘zbek tilida tushunarli ko‘rsat.
- O‘yin tugab lobbiga qaytilganda WebP fondagi menyu joyida, event listenerlar dublikat bo‘lib qolmasin.

### D. Kirish animatsiyasi

- Qisqa, 150–300 ms fade/transition yetarli. `Skip` yoki reduced-motion qoidasi bor; majburiy uzoq intro yo‘q.
- O‘yin 3D canvas resurslari menyu ochiqligida ishlamaydigan bo‘lsin; bir nechta WebGL kontekst ochma.

## 4. SUB-AGENTLAR — MAJBURIY PARALLEL ISH

Agent muhiti ruxsat bersa bir-biriga bog‘liq bo‘lmagan ishlarni parallel sub-agentlarga ber. Foydalanilmagan sub-agentlarni ishlagan deb ko‘rsatma.

| Vazifa | Fayl egaligi |
| --- | --- |
| **A — Art & Responsive CSS** | `src/client/menu/MenuVisuals.css` yoki alohida scoped CSS fayl, asset path review, media queries; `main.ts` va `index.html`ga tegmasin |
| **B — HTML Markup / Information Architecture** | `index.html`; mavjud DOM IDlarni saqlasin yoki aniq mapping hujjat qilsin |
| **C — Flow & Socket.IO Wiring** | `src/client/main.ts`, kerak bo‘lsa `src/client/settings.ts`; backend o‘zgarmasin |
| **D — UI QA Automation** | `scripts/qa-stage08menu.mjs`, `docs/stage08menu/*`, skrinshotlar, kontrast/accessibility tekshiruvlari |
| **Coordinator** | umumiy interfeys va fayllar orasidagi integratsiya, `src/client/style.css` importlari, haqiqiy testlar, final diff/review |

Ikki agent bir vaqtning o‘zida bir xil faylni tahrirlamasin. D agent browser sinovini A/B/C integratsiyasi tugagandan so‘ng boshlasin. Boshqa agentning natijasiga tayanadigan ishlar majburan parallel ketmasin.

## 5. QABUL QILISH TALABLARI VA QA TEZLATISH

**Fast QA** (har kichik yakuniy o‘zgarishda): `npm run typecheck`, tegishli UI smoke tests, `npm run build`. Hamma testni qayta-qayta uzluksiz benchmark qilma.

**Integration QA** (kod birlashtirilgandan keyin):
- `npm test` — oldingi **152 ta test** regressiyasiz o‘tsin; yangi UI testlar bilan ko‘payishi mumkin.
- Chrome desktop: 1280×720, 1366×768, 1920×1080; mobil-ishchi viewport: 390×844.
- Ismni saqlash va qayta ochish; server online/offline/reconnect; xonalar bo‘sh; `Forest Survival` yaratish va 2-client join; eski TDM/FFA roomga kirish va qaytish.
- World compatibility, `forest_square worldVersion=2`, `gameplayHash` mantiqini buzma. Gameplay kodni faqat GUI deb o‘zgartirma.
- Har tugma haqiqatan ishlasin; drop-down va modal fokus hamda klaviatura orqali boshqarilsin.
- Real brauzer skrinshotlar (kamida 5 ta): asosiy menyu 1920×1080 va 1280×720, Forest Survival tanlash, xonalar ekran, 390×844. Tasdiqlangan rasmning CAMPING belgisi va kemperini yopmaganini ko‘rsat.

**Performance QA** (kerak bo‘lsa): menyu ochiq paytda GPU/WebGL render yukining ortmaganini va image preload vaqtini ko‘rsat. Buning uchun besh sahnada uch martadan 30s FPS o‘lchash shart emas. Bajarilmagan sinovni PASS deb yozma.

## 6. NATIJA VA TO‘XTASH

Yakuniy hisobotni **o‘zbek tilida** ber: o‘zgargan fayllar, haqiqiy sub-agent taqsimoti, screenshotlar, mavjud gameplay testlari, typecheck/build, xatolar va qolgan cheklovlar. Original rasm fon sifatida qo‘llanganini va lokal asset manzili ishlashini tasdiqla. ZIP arxiv tayyorla (`node_modules` va `dist` yo‘q).

**Faqat STAGE 08-MENU** ni bajar. 08B personaj animatsiyasi, 08C HUD polish, yangi server rejimi yoki xarita dizaynini boshlama. Foydalanuvchi dizaynni ko‘rib tasdiqlagach keyingi ish belgilanadi.
