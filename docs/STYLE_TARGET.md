# Badiiy yo‘nalish va vizual maqsad (STYLE_TARGET)

> **Muhim eslatma:** Ushbu hujjat `01` bosqichda o‘rmon PvP (`forest_survival`) rejimi uchun me’yoriy vizual mo‘ljal sifatida tuzildi. Repozitoriyda tashqi referens o‘yinlarning (`RV There Yet?`, `ARC Raiders`) skrinshotlari yoki lokal grafik assetlari mavjud emas va ular bevosita ko‘rilgan deb da’vo qilinmaydi. Barcha talablar audit xulosalari, joriy `src/client/game/World.ts` / `Stickman.ts` / `Textures.ts` tahlili hamda original stilizatsiyalangan 3D dizayn tamoyillariga asoslanadi.

---

## 1. Umumiy badiiy kayfiyat va yorug‘lik

- **Iliq kunduzgi o‘rmon muhiti:** Quyosh nuri iliq kunduzgi / tushdan keyingi oltin-sarg‘ish ohangda (`DirectionalLight`), soyalar esa sovuqroq ko‘kimtir-yashil osmon nuri (`HemisphereLight`) bilan muvozanatlangan bo‘lishi kerak.
- **Atmosfera va chuqurlik:** Mavjud `ACESFilmicToneMapping`, `PCFSoftShadowMap` va masofaviy `Fog` saqlanadi, biroq uzoq masofadagi o‘rmon qatlamlari tuman bilan silliq uyg‘unlashib, o‘yin maydonining chegarasini tabiiy ko‘rsatishi shart.
- **Materiallar xarakteri:** Tabiiy mat va yarim-mat yuzalar (`roughness: 0.65–0.98`) ustuvor bo‘ladi — yog‘och po‘stlog‘i, qarag‘ay ignasi to‘shamasi, nam tuproq, xarsangtosh va eskirgan taxta. Metall detallar faqat zarur joylarda cheklangan miqdorda ishlatiladi.

---

## 2. Sahna chuqurligi: 4 majburiy vizual qatlam

Sahna bitta tekis pol ustiga qo‘yilgan qutilardan iborat bo‘lmasligi uchun kamida to‘rtta aniq o‘qiladigan qatlamdan tashkil topadi:

1. **Yer (Ground & Terrain) qatlami:**
   - Tabiiy past-balandlikka (heightfield relyefga) ega yer yuzasi.
   - Bir xil yashil to‘rtburchak o‘rniga: o‘tloq maydonlar, egri tuproq/shag‘al so‘qmoqlar, daraxtlar ostidagi jigarrang ignabarg to‘shamasi va qoyali/toshloq nishabliklar.
   - Bino osti va eshik oldi uchastkalari tabiiy ravishda tekislangan bo‘lishi kerak.

2. **O‘rmon tagi (Understory & Ground Cover) qatlami:**
   - Past bo‘yli butalar, paporotnik/maysa tupchalari, daraxt ildizlari atrofidagi bo‘rtmalar, to‘nkalar, ag‘darilgan xodalar va mayda-o‘rta toshlar.
   - Bu qatlam yo‘laklar, eshik o‘tish joylari va konteynerlar oldini to‘sib qo‘ymasligi (maxsus istisno niqoblari / mask bilan joylashtirilishi) shart.

3. **Asosiy daraxtlar va yirik qoyalar (Canopy & Midground) qatlami:**
   - O‘ynaladigan hudud (`bounds`) ichida joylashgan daraxt to‘plamlari (groves), siyrak o‘tish yo‘llari va kichik ochiq maydonchalar (clearings).
   - Kamida **3–5 xil original daraxt silueti**: baland va ingichka qarag‘ay, keng shoxli archa, egilgan yoki ikki tanali qarag‘ay, qisman qurigan/qari daraxt.
   - Qoyalar muntazam geometrik konuslar emas, balki yirik qirrali, qatlamli va nishablikka singdirilgan original shakllar bo‘ladi.

4. **Uzoq fon (Distant Backdrop & Boundary) qatlami:**
   - Xarita chegarasini tabiiy berkituvchi qalin tashqi o‘rmon devori, baland qoyali tizmalar va uzoq tog‘ siluetlari.
   - O‘yinchi xarita chetida ko‘rinmas cheksiz tekislikni emas, mantiqiy tabiiy to‘siqni ko‘rishi kerak.

---

## 3. Original binolar, tashlandiq joylar va konteynerlar

- **Original arxitektura:** O‘rmonchi uyi, kichik kulbalar, tashlandiq taxta ustaxonasi, eski servis binosi, lager va tosh xarobalar — barchasi original proporsiya va o‘ziga xos siluetga ega bo‘lishi kerak.
- **Ichiga kiriladigan (Enterable) tuzilma:** Binolar tashqaridan bezak quti (`solid AABB`) emas; ularning haqiqiy devor, pol, tom va ochiq eshik/deraza colliderlari bo‘ladi. Eshik kengligi va balandligi o‘yinchi (`PLAYER_RADIUS = 0.4`, `PLAYER_HEIGHT = 1.8`) hamda kamera sig‘ishiga mos bo‘ladi.
- **O‘qilishi oson (Readable) qidiruv nuqtalari:** Konteynerlar (qurol qutilari, o‘q-dori sandiqlari, lager shkaflari) bino ichida va tashlandiq joylarda atrofdagi dekor orasidan aniq ajralib turishi, `E` bilan ochish masofasida to‘siqsiz yondashish imkonini berishi lozim.

---

## 4. Qat’iy taqiqlangan (Qabul qilinmaydigan) yondashuvlar

Quyidagi holatlar vizual maqsadga zid hisoblanadi va qabul qilinmaydi:

1. **Plastik yaltiroqlik:** Haddan tashqari silliq (`roughness < 0.3`), neon yoki sun’iy yaltiraydigan barglar, tuproq va yog‘och materiallari.
2. **Faqat bir xil konus daraxtlar:** Hozirgi `addPineTree()` kabi 1 silindr + 3 simmetrik konusdan iborat bitta shablonni butun xaritaga bir xil nusxalab chiqish.
3. **Rang filtri yoki bezak bilan yashirilgan tekis arena:** Eski `100 × 70` koridorli arenani qoldirib, ustiga jigarrang/sariq post-processing filtr, yangi yozuvlar yoki yana bir nechta dekorativ RV/ayiq qo‘shish bilan cheklanish.
4. **O‘ynaladigan hudud tashqarisidagi soxta o‘rmon:** Hozirgi `World.ts` dagi kabi daraxtlarning 97% qismini `bounds` tashqarisidagi dekor halqasiga chiqarib, o‘yin maydonini yalang‘och qoldirish.
5. **Tashqi o‘yinlardan ko‘chirish va grafik zo‘ravonlik:** `RV There Yet?` yoki `ARC Raiders` dagi himoyalangan logotiplar, aniq brend nomlari, tayyor 3D modellar/teksturalarni ko‘chirish, shuningdek batafsil jarohat/qonli zo‘ravonlik tasvirlarini qo‘shish.
