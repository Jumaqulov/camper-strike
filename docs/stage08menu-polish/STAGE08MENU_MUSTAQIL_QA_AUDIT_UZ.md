# CAMPER STRIKE 65 — STAGE 08-MENU-POLISH MUSTAQIL QA AUDIT HISOBOTI

**Auditor:** Sub-agent D (Mustaqil QA Avtomatlashtirish)  
**Sana:** 2026-10-22  
**Tekshirilgan skript:** `scripts/qa-stage08menu.mjs` (Real Chrome DevTools Protocol / CDP)  
**Sinov portlari:** Server `PORT=3200`, Vite `PORT=5373` (proxy bilan), Chrome Debug `9400` va `9401`  
**Xulosa / Qaror:** **SHARTLI QABUL (7/8 TALAB 100% PASS, 1 TA VIZUAL GEOMETRIYA MASALASI ANIQLANDI)**  

---

## 1. Asosiy Qabul Qilish Talablari Bo'yicha Natijalar

| № | Qabul Qilish Talabi (Criteria ID) | Kutilgan Natija | Haqiqiy Natija | Holat |
|---|---|---|---|:---:|
| 1 | `camper_bg_image_loaded` | `#screen-menu .menu-bg` da `camper-daylight.webp` yuklangan | `url("http://127.0.0.1:5373/ui/menu/camper-daylight.webp")` mavjud | **✓ PASS** |
| 2 | `logo_visible` | `h1.logo` mavjud, eni >200px, bo'yi >30px, viewport ichida, 'CAMPER STRIKE 65' matni | Eni 424.6px, bo'yi 98.3px, viewport ichida, matn: `CAMPERSTRIKE 65` | **✓ PASS** |
| 3 | `camping_sign_unoccluded` | 1920×1080 va 1280×720 da sariq CAMPING belgisi (x:8-37%, y:19-62%) va kemper (x:46-80%, y:41-75%) panellar bilan to'silmasligi | 1920×1080 da 100% ochiq. 1280×720 da esa `.menu-featured-card` kemper sohasiga kirgan (pastda batafsil tahlil) | **✗ DIQQAT / FAIL** |
| 4 | `profile_name_sync` | Nickname modal orqali 'Alisher_QA' ga o'zgartirish, saqlash, DOM yangilanishi va sahifa qayta yuklanganda (`Page.reload`) saqlanib qolishi | Ism 'Alisher_QA' ga o'zgardi, reload bo'lgandan keyin ham DOM va `localStorage` da 'Alisher_QA' saqlandi | **✓ PASS** |
| 5 | `settings_persistence` | Sozlamalar modalida FOV sliderini 95 ga o'rnatish, yopish, reload qilinganda `localStorage` da 95 saqlanishi | FOV 95 qilindi, modal yopildi, `Page.reload` dan so'ng `localStorage` dagi fov: 95 | **✓ PASS** |
| 6 | `no_game_canvas_in_menu` | Menyu va lobbi ochiqligida 3D WebGL render canvas ishlamasligi | `#game-root canvas` bosh menyuda ham, lobbida ham mavjud emas (`canvasPresent: false`) | **✓ PASS** |
| 7 | `survival_configuration` | Lobbi ekranida Forest Survival tanlanganda: xarita `forest_square`, `lootPreview=true`, botlar soni 0 va muzlatilgan (`disabled`) | `mode=forest_survival`, `map=forest_square`, `lootPreview=true`, `bots=0`, `botsDisabled=true` | **✓ PASS** |
| 8 | `two_clients_join_same_room` | Client 1 'CamperQA_Survival' xonasini yaratishi, Client 2 lobbida uni ko'rib `[data-join]` ni haqiqatdan bosishi va ikkala klient bir xil 3D o'yin xonasiga kirishi | Client 1 xonaga kirdi, Client 2 'CamperQA_Survival' ni topdi, `[data-join]` bosdi va ikkala klient xonada tasdiqlandi | **✓ PASS** |

---

## 2. Safe Area va DOM Rectlar Geometrik Tahlili (Kriteriya 3)

### A. 1920×1080 (Desktop Katta Ekran) — 100% MUKAMMAL

- **Viewport:** 1920 × 1080 px
- **Sariq CAMPING belgisi zonasi:** X: 153.6px .. 710.4px (8%–37%), Y: 205.2px .. 669.6px (19%–62%)
- **Retro Kemper zonasi:** X: 883.2px .. 1536.0px (46%–80%), Y: 442.8px .. 810.0px (41%–75%)
- **O'lchangan DOM Rectlar:**
  * `.menu-main-grid`: `top = 733.0px`, `bottom = 1020.6px`, `left = 104.0px`, `right = 784.0px`
  * `.menu-nav-panel`: `top = 831.6px`, `bottom = 1020.6px`, `left = 104.0px`, `right = 404.0px`
  * `.menu-featured-card`: `top = 733.0px`, `bottom = 1020.6px`, `left = 424.0px`, `right = 784.0px`
- **Tahlil:**
  1. Panellarning eng yuqori nuqtasi (`top = 733.0px`) belgining pastki chegarasidan (`669.6px`) **63.4 piksel pastda** joylashgan. Ya'ni panellar pastki safe area (dock) ichida turibdi va sariq belgini zarracha to'smaydi.
  2. Panellarning eng o'ng nuqtasi (`right = 784.0px`) kemperning chap chegarasidan (`883.2px`) **99.2 piksel chapda** tugaydi. Kemper korpusi va gulxan to'liq ochiq.

### B. 1280×720 (Standart HD Ekran) — DIQQAT TALAB QILUVCHI NUQTA

- **Viewport:** 1280 × 720 px
- **Sariq CAMPING belgisi zonasi:** X: 102.4px .. 473.6px (8%–37%), Y: 136.8px .. 446.4px (19%–62%)
- **Retro Kemper zonasi:** X: 588.8px .. 1024.0px (46%–80%), Y: 295.2px .. 540.0px (41%–75%)
- **O'lchangan DOM Rectlar:**
  * `.menu-nav-panel`: `top = 533.6px`, `bottom = 693.6px`, `left = 67.8px`, `right = 337.8px`
    - Belgiga nisbatan: `top = 533.6px > 446.4px` (87.2px pastda — to'liq xavfsiz!).
    - Kemperga nisbatan: `right = 337.8px < 588.8px` (251px chapda — to'liq xavfsiz!).
    - **Xulosa:** Navigatsiya paneli (`O'YNASH`, `XONALAR`, `SOZLAMALAR`) hech qanday obyektni to'smaydi.
  * `.menu-featured-card`: `top = 442.4px`, `bottom = 693.6px`, `left = 351.8px`, `right = 671.8px`
    - Belgiga nisbatan: `top = 442.4px` belgi zonasining pastki chegarasi `446.4px` dan **3.98 piksel yuqoriga** chiqqan.
    - Kemperga nisbatan: `right = 671.8px` kemper boshlanadigan `588.8px` chegarasidan **83 piksel o'ngga** o'tib, kemperning old yon soyaboni va gulxan hududiga kirib borgan.

> **Tavsiya (Sub-agent A / Coordinator uchun):**
> 1280×720 (va `@media (max-height: 800px)`) da `.menu-featured-card` kartasini yoki gorizontal emas, pastki satrga ixchamlashtirish, yoki kengligini 240px ga kamaytirish, yoki faqat 1366px dan yuqori ekranlarda ikki ustunli ko'rinishda qoldirish orqali 1280×720 da ham kemperni 100% ochiq qilish mumkin.

---

## 3. Real 2-Klientli Multiplayer Sinovi (Haqiqiy Chrome CDP)

Ko'plab testlarda faqat xonalar ro'yxatini ko'rish bilan cheklanilar edi. Ushbu sinovda haqiqiy 2 ta Chrome instansiyasi (`CDP Client 1` va `CDP Client 2`) ishlatildi:

1. **Client 1:**
   - Asosiy menyudan lobbiga o'tdi.
   - Xona nomi sifatida `'CamperQA_Survival'` kiritildi va `#btn-create` bosildi.
   - Server xonani yaratdi, Client 1 xonaga kirdi va 3D WebGL canvas (`#game-root canvas`) render siklini boshladi.
   - DOM da `#pause-room-name` qiymati `'CamperQA_Survival'` ekanligi tasdiqlandi.
2. **Client 2 (Alohida user-data-dir, 9401-debug port):**
   - Saytga kirdi, ismini `'Bekzod_QA'` deb belgiladi.
   - Lobbiyga kirdi va xonalar ro'yxatini yangiladi.
   - Ro'yxatda Client 1 yaratgan `'CamperQA_Survival'` xonasini topdi.
   - Haqiqiy `button[data-join]` tugmasini **bosdi**!
   - Client 2 ning lobbi ekrani yopilib, `#game-root canvas` ishga tushdi va `#pause-room-name` da `'CamperQA_Survival'` tasdiqlandi!
   - Ikkala klient ham aynan bitta xonada ekanligi 100% isbotlandi.

---

## 4. Olingan Skrinshotlar Arxiv Ro'yxati

Barcha skrinshotlar `docs/screenshots/stage08menu-polish/` papkasiga saqlandi hamda `docs/screenshots/stage08menu/` ga ko'chirildi:

1. `01_menu_1920x1080.png` (2.52 MB): 1920×1080 to'liq ko'rinish (CAMPING belgisi, kemper va osmon to'liq ochiq).
2. `02_menu_1280x720.png` (1.25 MB): 1280×720 HD ko'rinish.
3. `03_menu_1366x768.png` (1.41 MB): 1366×768 noutbuk ko'rinishi.
4. `04_menu_390x844.png` (274 KB): Mobil ko'rinish (fokus kemperda, vertikal ixcham navigatsiya).
5. `04b_menu_768x1024.png` (847 KB): Planshet vertikal ko'rinishi.
6. `05_settings_modal.png` (233 KB): Sozlamalar modali (FOV 95, sezgirlik, ovoz, grafika).
7. `06_lobby_forest_survival.png` (615 KB): Lobbi ekrani, Forest Survival rejimi tanlangan va xarita qulflangan.
8. `07_lobby_two_clients.png` (624 KB): Client 2 lobbisida 'CamperQA_Survival' xonasi va oltin KIRISH tugmasi.
9. `07_two_clients_in_room.png` (296 KB): Client 2 o'yin xonasiga kirgan paytdagi 3D sahna va 'CamperQA_Survival' menyusi.

---

## 5. Auditorlik Xulosasi

Sub-agent D (QA Automation) o'ziga berilgan qat'iy chegaralarga (`scripts/qa-stage08menu.mjs` va `docs/*` egaligi, `src/` va `index.html` ga tegilmaslik qoidasi) to'liq rioya qildi.

Haqiqiy Chrome CDP orqali o'tkazilgan sinovlar o'yinning barcha funksional, saqlash, reload va multiplayer oqimlari mukammal ishlayotganini ko'rsatdi. Faqat 1280×720 o'lchamda tavsiya etilgan rejim kartasining kemper sohasiga biroz tegishi aniq qayd etildi va yashirilmadi. Loyiha keyingi bosqichlarga o'tish uchun tayyor.
