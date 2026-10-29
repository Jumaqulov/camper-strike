"Tong otguncha" rejimi uchun 13 ta yaxshilanish taklif qilaman, to'rt guruhga bo'ldim. Ular rejimning hozirgi kodiga tayanadi; kodga hali hech narsa qo'shilmadi.

**Hozir eng ko'p sezilayotgan kamchiliklar:**
- **Bo'rilar soni:** to'lqinlarda o'yinchilar sonidan qat'i nazar har doim 2, 3, 4 va 6 ta bo'ri keladi. Bitta odam va 2 ta bot uchun bu og'ir, 8 kishi uchun esa juda oson.
- **Halok bo'lgan o'yinchi:** u tun oxirigacha, ya'ni 8 daqiqagacha, faqat tomosha qilib o'tiradi.
- **Bo'ri ranglari:** 5 xil rang bor, lekin ular faqat ko'rinishni o'zgartiradi, bo'rining xatti-harakati bir xil.
- **Natija:** tun oxirida faqat "tong otdi" yoki "bo'rilar yutdi" deb ko'rsatiladi, kim qanday o'ynagani ko'rinmaydi.

### 1. Kam ish talab qiladi, ta'siri katta (tavsiya etaman)
1. **Qiyinlik va o'yinchi soni.** Lobbiga Oson / O'rta / Qiyin tanlovi qo'shiladi. To'lqindagi bo'rilar soni tirik ishtirokchilar soniga qarab hisoblanadi. *Ish: kichik.*
2. **Ranglar bo'yicha bo'ri turlari.** Modellar allaqachon tayyor:
   - oq bo'ri — to'da boshlig'i: kattaroq, joni ko'proq, uvlaganda to'dani tezlashtiradi;
   - qora bo'ri — qorong'ida yaxshi yashirinadi, nafasi past eshitiladi;
   - qizil bo'ri — tez, lekin tez o'ladi.

   *Ish: kichik-o'rta.*
3. **Tong otishi.** Oxirgi 60 soniyada osmon asta yorishadi. Tong otganda bo'rilar uvlab o'rmonga qochib ketadi, raund esa hozirgidek birdan to'xtab qolmaydi. *Ish: kichik-o'rta.*
4. **Shaxsiy statistika va MVP.** Natija taxtasida har bir o'yinchi uchun o'ldirilgan bo'rilar, keltirilgan o'tin va gulxanni o'chirmay saqlab turgan vaqt ko'rsatiladi. "Eng yaxshi o'tinchi" va "Bo'ri ovchisi" kabi unvonlar beriladi. *Ish: kichik-o'rta.*

### 2. Taktikani chuqurlashtirish
5. **Qayta tirilish.** Halok bo'lganlar keyingi to'lqin boshida asosiy gulxan yonida qaytadi, lekin faqat gulxan yonib tursa. Bu gulxanni o'chirmaslikka yana bir sabab bo'ladi. *Ish: o'rta.*
6. **Mash'al.** Gulxandan `E` bilan mash'al olinadi va u 40 soniya yonadi. Mash'al bilan uzoqdagi o'tin uyumiga borish xavfsizroq bo'ladi:
   - bo'rilar 4 metrdan yaqin kelmaydi;
   - qo'lda faqat pichoq yoki to'pponcha ishlatish mumkin.

   *Ish: o'rta.*
7. **O'tinning og'irligi.** 3 ta o'tin ko'targan o'yinchi sprint qila olmaydi. Shunda "hammasini bir yo'la olib ketamanmi yoki tezroq qaytamanmi" degan tanlov paydo bo'ladi. *Ish: kichik.*
8. **To'da taktikasi.** Bo'rilar yolg'iz qolgan yoki gulxandan uzoqlashgan o'yinchini nishonga oladi. Bittasi chalg'itsa, qolganlari orqadan aylanib keladi. Bu jamoa bo'lib o'ynashga undaydi. *Ish: katta.*
9. **Yiqilib qolish.** O'yinchi darhol o'lmaydi, 30 soniya yerda yotadi va sherigi `E` bilan uni turg'iza oladi. Bu 5-bandga muqobil bo'lishi ham mumkin. *Ish: katta.*

### 3. Tun davomidagi voqealar
10. **Yarim tunda yordam yuki.** Xaritaning tasodifiy joyiga qurol va o'q tushadi. Unga yetib borish xavfli, lekin arziydi. Loot tizimi tayyor, shuning uchun bu oson qo'shiladi. *Ish: o'rta.*
11. **Signal raketasi.** Kam uchraydigan loot buyumi. Osmonga otilganda 20 soniya davomida hamma bo'rilarni qo'rqitib turadi. *Ish: o'rta.*

### 4. Interfeys va atmosfera
12. **Natija yulduzlari.** Raund oxirida 3 tagacha yulduz beriladi: hamma tirik qoldi, asosiy gulxan bir marta ham o'chmadi, to'lqin boshlig'i o'ldirildi. *Ish: kichik.*
13. **HUD.** Uchala gulxan uchun kichik o'tin indikatorlari chiqadi, hozir faqat asosiy gulxanniki ko'rinadi. Bo'ri qaysi tomonda uvlagani ham ko'rsatiladi. *Ish: kichik.*

**Yo'l-yo'lakay tuzatsa bo'ladigan ikki narsa:**
- Bo'ri ikki holatda hali ham tebranib qoladi: nishon gulxan chetidagi 1 metrlik halqada turganda va yo'li yonib turgan gulxan doirasini kesib o'tganda.
- Bo'ri modeli 11 700 ta uchburchakdan iborat. 6 ta bo'ri bir vaqtda chiqqanda kuchsizroq kompyuterlar uchun LOD qo'shish kerak bo'ladi.

**Tavsiyam:** avval 1–4-bandlarni qilaylik. Ularning hammasi kichik yoki o'rta ish, lekin birgalikda rejimni sezilarli yangilaydi. Keyin 5- va 6-bandlarga o'tamiz, chunki ular o'yinni eng ko'p o'zgartiradi.
---

## Holat (2026-10-29)

Barcha 13 band va ikkala yo'l-yo'lakay tuzatish bajarildi.

| Band | Commit |
|---|---|
| 1–4 (qiyinlik, bo'ri turlari, tong, statistika/MVP) | e56e632, ba71303, 6c7e4e6 |
| 5 Qayta tirilish + 9 Yiqilib qolish / turg'izish | 5236a07 |
| 6 Mash'al + 7 O'tinning og'irligi | 0b62c8d |
| 8 To'da taktikasi | 085d9f9 |
| 10 Yordam yuki + 11 Signal raketasi | ba28646 |
| 12 Natija yulduzlari + 13 HUD (3 gulxan, uvlash yo'nalishi) | 3fca8c2 |
| Bo'ri tebranishi + bo'ri LOD | ba19209 |

Yangi tugmalar: `E` turg'izish (yiqilgan sherik yonida), `F` mash'al olish/tashlash, `X` signal raketasi.
