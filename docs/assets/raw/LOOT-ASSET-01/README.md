# LOOT-ASSET-01 — Ochiladigan loot konteynerlari

## 1. Umumiy qoidalar
- Format: glTF 2.0 binary (.glb), Three.js GLTFLoader bilan mos. Kamera va chiroq yo'q.
- 1 birlik = 1 metr, +Y yuqoriga. Origin har bir modelning pastki markazida (y = 0 — yer yuzasi).
- Old tomon +Z. Konteynerni o'yinchiga qaratish uchun root'ni Y o'qi atrofida aylantiring.
- Umumiy materiallar: wood, iron, painted_metal (BUILDING-ASSET-01 dagi wood va iron bilan bir xil nom va uslub). Ranglar vertex color (COLOR_0), teksturalar yo'q.
- Har bir modelda statik korpus root'ning bevosita farzandi, harakatlanuvchi qism esa alohida pivot node ichida. Ichida buyum yo'q.

## 2. Modellar
| Fayl | O'lcham (X × Y × Z) | Uchburchak | Materiallar | GLB hajmi |
|---|---|---|---|---|
| wooden_loot_crate_01.glb | 1.00 × 0.61 × 0.65 m | 1140 | wood, iron | 124 KB |
| metal_locker_01.glb | 0.91 × 1.80 × 0.56 m | 1406 | painted_metal, iron | 152 KB |
| old_toolbox_01.glb | 0.61 × 0.30 × 0.32 m | 926 | painted_metal, iron | 102 KB |

## 3. Pivotlar va ochilish burchaklari
| Model | Node | Position (model-local) | O'q | Yopiq | Ochiq | Yo'nalish |
|---|---|---|---|---|---|---|
| wooden_loot_crate_01 | lid_pivot | (0, 0.46, -0.3) | X | 0 | -1.92 rad (-110°) | Qopqoq orqa ilgak chizig'i atrofida yuqoriga va orqaga ochiladi |
| metal_locker_01 | door_pivot | (-0.43, 0, 0.25) | Y | 0 | -1.75 rad (-100°) | Eshik chap ilgak chizig'i atrofida tashqariga (+Z) va chapga ochiladi |
| old_toolbox_01 | lid_pivot | (0, 0.2, -0.15) | X | 0 | -1.92 rad (-110°) | Qopqoq orqa ilgak chizig'i atrofida yuqoriga va orqaga ochiladi |

Burchaklar manfiy: qopqoqlar uchun rotation.x manfiy bo'lsa qopqoq orqaga ochiladi, shkaf uchun rotation.y manfiy bo'lsa eshik tashqariga ochiladi. Musbat qiymat bersangiz qism korpus ichiga kirib ketadi.

## 4. Node ierarxiyasi
```
- wooden_loot_crate_01 (node)
  - crate_body (mesh · wood)
  - crate_body_metal (mesh · iron)
  - lid_pivot (node · position (0.00, 0.46, -0.30))
    - crate_lid (mesh · wood)
    - crate_lid_metal (mesh · iron)

- metal_locker_01 (node)
  - locker_body (mesh · painted_metal)
  - locker_body_metal (mesh · iron)
  - door_pivot (node · position (-0.43, 0.00, 0.25))
    - locker_door (mesh · painted_metal)
    - locker_door_hardware (mesh · iron)

- old_toolbox_01 (node)
  - toolbox_body (mesh · painted_metal)
  - toolbox_body_metal (mesh · iron)
  - lid_pivot (node · position (0.00, 0.20, -0.15))
    - toolbox_lid (mesh · painted_metal)
    - toolbox_lid_metal (mesh · iron)
```

## 5. Tavsiya etilgan colliderlar
| Model | Statik korpus (model-local) | Harakatlanuvchi qism |
|---|---|---|
| wooden_loot_crate_01 | center (0, 0.23, 0), size (0.9, 0.46, 0.6) | lid_pivot ichida: center (0, 0.07, 0.3), size (0.9, 0.14, 0.6) |
| metal_locker_01 | center (0, 0.9, 0), size (0.9, 1.8, 0.5) | door_pivot ichida: center (0.43, 0.925, 0.0145), size (0.85, 1.69, 0.03) |
| old_toolbox_01 | center (0, 0.1, 0), size (0.6, 0.2, 0.3) | lid_pivot ichida: center (0, 0.05, 0.15), size (0.6, 0.1, 0.3) |

Oddiy variant: yopiq holat uchun butun model bounding box'ini bitta statik collider qiling, qopqoq yoki eshik uchun collider shart emas. loot_asset_manifest.json ichida simpleClosed nomi bilan berilgan.

## 6. Interaksiya hajmi va ichki bo'shliq
| Model | Interaksiya sferasi markazi | Radius | Ichki bo'shliq (loot joylash uchun) |
|---|---|---|---|
| wooden_loot_crate_01 | (0, 0.303, 0.005) | 1.87 m | center (0, 0.265, 0), size (0.82, 0.39, 0.52). Pol yuzasi y = 0.07 |
| metal_locker_01 | (0, 0.9, 0.025) | 2.247 m | center (0, 0.925, -0.01), size (0.84, 1.57, 0.44). Javon yuzalari y = 0.09 (pol), 0.5575, 1.0075, 1.4575 |
| old_toolbox_01 | (0, 0.15, 0.002) | 1.574 m | center (0, 0.11, 0.065), size (0.56, 0.17, 0.14). Old bo'lim; orqada ichki tokcha: center (0, 0.172, -0.07), size (0.56, 0.035, 0.12) |

Radius = bounding box yarim diagonali + 1.2 m. Muqobil qoida: o'yinchi kamerasidan konteyner bounding box'igacha masofa 1.5 m dan oshmasin.

## 7. Tekshiruv natijalari
Har bir GLB eksport qilindi, GLTFLoader bilan qayta yuklandi, pivot ochiq burchakka aylantirildi va natija o'lchandi.

| Model | Natija | Pivot topildi | Mesh (statik / harakatlanuvchi) | Harakat masofasi | Korpus o'zgarmadi | Kamera / chiroq yo'q | Vertex color |
|---|---|---|---|---|---|---|---|
| wooden_loot_crate_01 | OK | true | 2 / 2 | 0.493 m | true | true | true |
| metal_locker_01 | OK | true | 2 / 2 | 0.646 m | true | true | true |
| old_toolbox_01 | OK | true | 2 / 2 | 0.261 m | true | true | true |

## 8. Three.js'da ishlatish
```ts
const m = manifest.models.find(x => x.name === 'metal_locker_01')!;
const pivot = gltf.scene.getObjectByName(m.movingNode.name)!;
const axis = m.movingNode.axis as 'x' | 'y' | 'z';
// har kadrda:
const target = isOpen ? m.movingNode.openAngleRad : 0;
pivot.rotation[axis] = THREE.MathUtils.damp(pivot.rotation[axis], target, 10, dt);
```
Server faqat isOpen holatini yuboradi, animatsiya har bir klientda shu kod bilan ijro etiladi.
