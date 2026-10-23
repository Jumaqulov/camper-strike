# GRASS-ASSET-01 — Premium Stylized Forest Vegetation Pack

## 1. Umumiy qoidalar
- 17 ta GLB: 12 maysa, 3 gul, 2 paporotnik. glTF 2.0 binary, Three.js GLTFLoader bilan mos. Kamera, chiroq va animatsiya yo'q.
- 1 birlik = 1 metr, +Y yuqoriga. Origin — o'simlik tupining yer bilan tutashgan markazi (0,0,0). Ildizlar 1 sm yerga kiradi, shuning uchun qiyalikda havoda osilib qolmaydi.
- Har bir faylda bitta mesh va bitta umumiy material: **vegetation**.
- Balandliklar: maysa 0.15–0.55 m, gullar 0.18–0.45 m, paporotniklar 0.30–0.65 m. Har bir model aniq balandlikka keltirilgan va tekshiruvda bu chegaralar tasdiqlanadi.

## 2. Material sozlamalari (muhim)
```
name: vegetation
type: MeshStandardMaterial (glTF: pbrMetallicRoughness)
vertexColors: true (COLOR_0)
roughness: 0.92, metalness: 0
side: FrontSide  (glTF doubleSided: false)
transparent: false, alphaTest: yo'q, tekstura yo'q
```
Barglar ikki tomondan ko'rinadi, lekin bu material orqali emas, geometriya orqali hal qilingan: har bir uchburchak ikkala yo'nalishda ham bor. Ikkala tomonning normallari bir xil va yuqoriga og'dirilgan (yuza normali × 0.55 + Y). Natijada:
- barg orqasi qorayib ketmaydi, tup yumshoq va bir tekis yoritiladi;
- DoubleSide yoki alfa-shaffoflik kerak emas, overdraw minimal;
- uchburchaklar soniga ikkala tomon ham kiritilgan.

Materialni o'yinda DoubleSide qilib qo'ymang, aks holda yorug'lik buziladi.

## 3. Modellar va joylashtirish metadata
| Model | Balandlik (m) | Uchburchak | Biom | Zichlik (dona/m²) | Yorug'lik | Masshtab | Maks. qiyalik | Tuproq yo'l |
|---|---|---|---|---|---|---|---|---|---|
| grass_short_soft_01.glb | 0.170 | 60 | open meadow, clearing, path edge | 6–12 | sun/partial | 0.8–1.25 | 35° | Markazda ham (siyrak) | OK |
| grass_short_dense_01.glb | 0.150 | 84 | open meadow, clearing | 8–14 | sun | 0.85–1.2 | 30° | Faqat chetida | OK |
| grass_meadow_wide_01.glb | 0.340 | 90 | open meadow | 3–6 | sun | 0.8–1.3 | 25° | Yo'lda ishlatilmaydi | OK |
| grass_meadow_thin_01.glb | 0.300 | 96 | open meadow, woodland floor | 3–6 | sun/partial | 0.85–1.25 | 30° | Faqat chetida | OK |
| grass_tall_wild_01.glb | 0.520 | 90 | open meadow, clearing edge, fence line | 1–3 | sun | 0.85–1.15 | 25° | Yo'lda ishlatilmaydi | OK |
| grass_tall_seeded_01.glb | 0.540 | 102 | open meadow | 0.5–2 | sun | 0.9–1.1 | 20° | Yo'lda ishlatilmaydi | OK |
| grass_dry_straw_01.glb | 0.360 | 90 | dry meadow, service station, lumber mill, cliff top | 2–5 | sun | 0.8–1.2 | 35° | Faqat chetida | OK |
| grass_olive_tuft_01.glb | 0.260 | 84 | woodland floor, rocky slope, cliff edge | 1–3 | partial | 0.8–1.3 | 40° | Faqat chetida | OK |
| grass_shade_dark_01.glb | 0.240 | 70 | forest shade, under trees | 2–4 | shade | 0.85–1.25 | 30° | Yo'lda ishlatilmaydi | OK |
| grass_forest_sparse_01.glb | 0.220 | 60 | woodland floor, forest shade | 1–3 | shade/partial | 0.8–1.3 | 40° | Faqat chetida | OK |
| grass_path_edge_01.glb | 0.220 | 90 | path edge | 4–8 | sun/partial | 0.85–1.15 | 25° | Faqat chetida, yo'lga qaratib | OK |
| grass_wavy_broad_01.glb | 0.300 | 100 | forest shade, wet hollow, woodland floor | 1–3 | partial/shade | 0.85–1.2 | 25° | Yo'lda ishlatilmaydi | OK |
| flower_white_01.glb | 0.260 | 126 | open meadow, clearing | 0.3–1 | sun/partial | 0.85–1.15 | 25° | Yo'lda ishlatilmaydi | OK |
| flower_yellow_01.glb | 0.300 | 124 | open meadow, path edge | 0.3–1 | sun | 0.85–1.15 | 25° | Faqat chetida | OK |
| flower_purple_01.glb | 0.420 | 132 | open meadow, forest edge | 0.1–0.5 | sun/partial | 0.9–1.1 | 25° | Yo'lda ishlatilmaydi | OK |
| fern_small_01.glb | 0.340 | 140 | woodland floor, forest shade | 0.5–1.5 | shade | 0.8–1.25 | 40° | Yo'lda ishlatilmaydi | OK |
| fern_wide_01.glb | 0.600 | 210 | forest shade, under trees, stream bank | 0.2–0.8 | shade | 0.85–1.2 | 35° | Yo'lda ishlatilmaydi | OK |

grass_path_edge_01 yo'nalishga ega: modelning +X o'qini yo'l markaziga qarating (yaw ±25° tasodifiy), yo'l chetidan 0.3–0.9 m oraliqda joylashtiring. Qolgan barcha modellar Y o'qi atrofida tasodifiy aylantiriladi.

## 4. Unumdorlik bo'yicha tavsiyalar (Intel UHD 730 kabi GPU uchun)
- Har bir model uchun bitta THREE.InstancedMesh: `new THREE.InstancedMesh(mesh.geometry, mesh.material, count)`. 17 ta model = 17 ta draw call.
- castShadow = false (o'tlar soya tashlamasin), receiveShadow ixtiyoriy.
- Xaritani masalan 16 × 16 m bo'laklarga bo'ling va har bir bo'lak uchun alohida InstancedMesh qiling. Shunda frustum culling ishlaydi.
- cullDistance (manifestda) dan uzoqdagi bo'laklarni yashiring. Kalta maysa 25 m, baland o'tlar 45 m, paporotniklar 40–50 m.
- Shamol effekti kerak bo'lsa: balandlik normallashtirilgan, shuning uchun vertex shaderda tebranish kuchini position.y bilan ko'paytirish yetarli (ildiz qimirlamaydi).

## 5. Fayllar
- glb/*.glb — 17 ta model
- previews/*.png — 17 ta individual preview
- previews/scenes/*.png — o'rmon yalangligi, o'rmon tagi, so'qmoq chetlari
- grass_asset_manifest.json — o'lchamlar, bounding box, uchburchaklar, material, joylashtirish metadata va tekshiruv natijalari

## 6. Tekshiruv
Har bir GLB eksport qilindi, GLTFLoader bilan qayta yuklandi va quyidagilar tekshirildi: bitta mesh, vegetation materiali FrontSide holatida, COLOR_0 va normallar mavjud, uchburchaklar soni va o'lchamlar mos, origin to'g'ri, balandlik spetsifikatsiya ichida, kamera va chiroq yo'q. Biror shart bajarilmasa, model XATO deb belgilanadi.
