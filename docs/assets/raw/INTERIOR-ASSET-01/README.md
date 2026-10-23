# INTERIOR-ASSET-01 — Abandoned Forest Cabin Furniture Pack

## 1. Umumiy qoidalar
- Format: glTF 2.0 binary (.glb), Three.js GLTFLoader bilan mos. Kamera va chiroq yo'q.
- 1 birlik = 1 metr, +Y yuqoriga. Origin har bir modelning pastki markazida (y = 0 — pol sathi, BUILDING-ASSET-01 bilan bir xil).
- Old tomon +Z: stulda o'tirgan odam, divan, javon va shkaf eshiklari +Z ga qaraydi. Devorga qo'yish uchun orqa tomon (-Z) devorga qaratiladi.
- Umumiy materiallar: wood, iron (avvalgi to'plamlar bilan bir xil nom), fabric (yangi, mat mato). Ranglar vertex color (COLOR_0), teksturalar yo'q.
- Mebellar ichida buyum modellari yo'q. Buyumlar itemAnchors va placeableSurfaces orqali joylashtiriladi.

## 2. Modellar
| Fayl | O'lcham (X × Y × Z) | Uchburchak | Materiallar | GLB hajmi |
|---|---|---|---|---|
| wooden_table_01.glb | 1.41 × 0.75 × 0.80 m | 288 | 1 (wood) | 32 KB |
| wooden_chair_01.glb | 0.46 × 0.90 × 0.52 m | 404 | 1 (wood) | 44 KB |
| wooden_shelf_01.glb | 1.04 × 1.80 × 0.42 m | 436 | 1 (wood) | 47 KB |
| old_bed_01.glb | 2.02 × 0.65 × 0.97 m | 838 | 2 (wood, fabric) | 90 KB |
| old_sofa_01.glb | 1.70 × 0.90 × 0.80 m | 958 | 2 (wood, fabric) | 103 KB |
| kitchen_cabinet_01.glb | 1.24 × 0.90 × 0.57 m | 688 | 2 (wood, iron) | 77 KB |

## 3. Pivotlar (faqat kitchen_cabinet_01)
| Node | Position (model-local) | O'q | Yopiq | Ochiq | Yo'nalish |
|---|---|---|---|---|---|
| door_left_pivot | (-0.585, 0, 0.255) | Y | 0 | -1.75 rad (-100°) | Chap eshik chap ilgak chizig'i atrofida tashqariga (+Z) ochiladi |
| door_right_pivot | (0.585, 0, 0.255) | Y | 0 | 1.75 rad (100°) | O'ng eshik o'ng ilgak chizig'i atrofida tashqariga (+Z) ochiladi |

Belgilarga e'tibor bering: chap eshik manfiy, o'ng eshik musbat burchakda ochiladi. Teskari belgi berilsa, eshik korpus ichiga kirib ketadi.

## 4. Node ierarxiyasi
```
- wooden_table_01 (root)
  - wooden_table_01_body (mesh · wood)

- wooden_chair_01 (root)
  - wooden_chair_01_body (mesh · wood)

- wooden_shelf_01 (root)
  - wooden_shelf_01_body (mesh · wood)

- old_bed_01 (root)
  - old_bed_01_frame (mesh · wood)
  - old_bed_01_fabric (mesh · fabric)

- old_sofa_01 (root)
  - old_sofa_01_legs (mesh · wood)
  - old_sofa_01_fabric (mesh · fabric)

- kitchen_cabinet_01 (root)
  - kitchen_cabinet_01_body (mesh · wood)
  - door_left_pivot (node · position (-0.58, 0.00, 0.26))
    - door_left (mesh · wood)
    - door_left_hardware (mesh · iron)
  - door_right_pivot (node · position (0.58, 0.00, 0.26))
    - door_right (mesh · wood)
    - door_right_hardware (mesh · iron)
```

## 5. Tavsiya etilgan colliderlar (model-local)
| Model | Box'lar |
|---|---|
| wooden_table_01 | tabletop: center (0, 0.73, 0), size (1.4, 0.04, 0.8)<br>legs_block: center (0, 0.355, 0), size (1.31, 0.71, 0.71) |
| wooden_chair_01 | seat: center (0, 0.235, 0), size (0.46, 0.47, 0.46)<br>backrest: center (0, 0.68, -0.25), size (0.46, 0.44, 0.06) |
| wooden_shelf_01 | body: center (0, 0.9, 0), size (1, 1.8, 0.4) |
| old_bed_01 | frame_mattress: center (0, 0.23, 0), size (2, 0.46, 0.95)<br>headboard: center (0.965, 0.555, 0), size (0.09, 0.19, 0.95) |
| old_sofa_01 | seat: center (0, 0.25, 0.01), size (1.7, 0.5, 0.78)<br>back: center (0, 0.62, -0.31), size (1.7, 0.52, 0.18) |
| kitchen_cabinet_01 | body: center (0, 0.45, 0), size (1.2, 0.9, 0.55) |

Har bir model uchun bitta "simple" box ham manifestda bor. Shkaf eshiklarining colliderlari pivot-local koordinatada berilgan va pivot bilan birga aylanadi.

## 6. Buyum qo'yish yuzalari va anchor nuqtalari
| Model | Yuzalar (ustki sath balandligi) | Anchor soni |
|---|---|---|
| wooden_table_01 | tabletop y = 0.75 | 6 |
| wooden_chair_01 | seat y = 0.47 | 1 |
| wooden_shelf_01 | shelf_1 y = 0.12 (bo'sh balandlik 0.415 m)<br>shelf_2 y = 0.56 (bo'sh balandlik 0.415 m)<br>shelf_3 y = 1 (bo'sh balandlik 0.415 m)<br>shelf_4 y = 1.44 (bo'sh balandlik 0.33 m)<br>top y = 1.8 | 12 |
| old_bed_01 | mattress y = 0.46 — Yumshoq yuza | 2 |
| old_sofa_01 | seat y = 0.5 — Yumshoq yuza | 2 |
| kitchen_cabinet_01 | countertop y = 0.9<br>inside_bottom y = 0.1 — Eshiklar ochiq bo'lganda<br>inside_shelf y = 0.479 — Eshiklar ochiq bo'lganda | 7 |

Anchor koordinatalari model-local. Dunyo koordinatasiga o'tkazish:
```ts
const p = new THREE.Vector3(...anchor.position).applyMatrix4(furniture.matrixWorld);
```
Divanda qo'shimcha "cover" ma'lumoti bor: orqa balandligi 0.88 m, yashirinish nuqtasi model-local (0, 0, -0.7).

## 7. BUILDING-ASSET-01 bilan moslik
- Barcha mebellar 4 × 4 m katakka sig'adi. Eng uzun model — karavot (2.0 m).
- Devor ichki yuzasi grid chizig'idan 0.1 m, plintus 0.115 m ichkarida. Mebelni devorga taqab qo'yishda orqa tomonini grid chizig'idan kamida 0.135 m uzoqlikka qo'ying.
- Eshik bo'shlig'i 1.8 m, eshik ichkariga ochiladi va radiusi 1.76 m chorak doirani egallaydi. Bu hududga mebel qo'ymang.
- Deraza tokchasi y = 1.0 da. Divan (0.88 m) va shkaf (0.90 m) deraza ostiga sig'adi.

## 8. Namuna xona
examples/sample_room_layout.json — har bir obyektning fayli, position va rotationY qiymati (dunyo koordinatasi, xona katagi x, z ∈ [0, 4]). Preview'da tom ko'rinish uchun olib tashlangan. O'yinchi uchun bo'sh yo'lak: x 0.95–2.45, z 1.1–3.87.

## 9. Tekshiruv natijalari
Har bir GLB eksport qilindi, GLTFLoader bilan qayta yuklandi va quyidagilar solishtirildi.

| Model | Natija | Uchburchaklar | Materiallar | O'lchamlar | Origin | Vertex color | Kamera / chiroq yo'q | Pivotlar |
|---|---|---|---|---|---|---|---|---|
| wooden_table_01 | OK | true | true | true | true | true | true | — |
| wooden_chair_01 | OK | true | true | true | true | true | true | — |
| wooden_shelf_01 | OK | true | true | true | true | true | true | — |
| old_bed_01 | OK | true | true | true | true | true | true | — |
| old_sofa_01 | OK | true | true | true | true | true | true | — |
| kitchen_cabinet_01 | OK | true | true | true | true | true | true | door_left_pivot: OK (0.429 m)<br>door_right_pivot: OK (0.429 m) |
