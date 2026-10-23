# BUILDING-ASSET-01 — Modulli yog'och uy to'plami

## 1. Umumiy qoidalar
- Format: glTF 2.0 binary (.glb), Three.js GLTFLoader bilan mos. Kamera va chiroq yo'q.
- 1 birlik = 1 metr, +Y yuqoriga.
- Grid qadami 4 m. Grid tugunlari 4 ga karrali (x, z) nuqtalarda: (0,0), (4,0), (8,4) ...
- Pol sathi y = 0 (pol taxtalarining ustki yuzasi). Devor balandligi 3.0 m. Ikkinchi qavat / cherdak poli y = 3.0 da.
- Devor o'qi grid chizig'i ustida, devor qalinligi 0.2 m (o'qdan ±0.1). Bo'rtib chiqqan detallar (romlar, tokcha, darcha qopqog'i) ±0.25 m gacha.
- Umumiy materiallar: wood, roof, iron. Ranglar vertex color (COLOR_0), teksturalar yo'q.

## 2. Modullar
| Fayl | O'lcham (X × Y × Z) | Bounding box (lokal) | Uchburchak | Materiallar |
|---|---|---|---|---|
| wood_wall_01.glb | 4.12 × 3.20 × 0.24 m | x[-2.12, 2.00] y[-0.20, 3.00] z[-0.12, 0.12] | 848 | 1 (wood) |
| wood_wall_window_01.glb | 4.12 × 3.20 × 0.36 m | x[-2.12, 2.00] y[-0.20, 3.00] z[-0.13, 0.23] | 1448 | 2 (wood, iron) |
| wood_wall_door_01.glb | 4.12 × 3.20 × 0.27 m | x[-2.12, 2.00] y[-0.20, 3.00] z[-0.13, 0.14] | 1188 | 1 (wood) |
| wood_floor_01.glb | 4.00 × 0.20 × 4.00 m | x[-2.00, 2.00] y[-0.20, 0.00] z[-2.00, 2.00] | 660 | 1 (wood) |
| wood_roof_slope_01.glb | 4.00 × 2.09 × 2.53 m | x[-2.00, 2.00] y[-0.45, 1.64] z[-0.08, 2.45] | 1560 | 2 (wood, roof) |
| wood_roof_gable_01.glb | 4.82 × 2.15 × 0.24 m | x[-2.41, 2.41] y[-0.46, 1.68] z[-0.08, 0.16] | 892 | 1 (wood) |
| wood_door_01.glb | 1.79 × 2.35 × 0.14 m | x[-0.91, 0.88] y[0.04, 2.38] z[-0.07, 0.07] | 400 | 2 (wood, iron) |
| wood_stairs_01.glb | 1.33 × 4.01 × 4.04 m | x[-0.66, 0.67] y[-0.01, 4.00] z[-4.01, 0.03] | 828 | 1 (wood) |

## 3. Origin va o'qlar
- **wood_wall_01 / wood_wall_window_01 / wood_wall_door_01** — origin: devor o'qidagi pastki markaz, pol sathida (y=0). Devor X bo'ylab x ∈ [-2, 2]. Tashqi yuza +Z, ichki yuza -Z. `corner_post` (0.24 × 0.24, y ∈ [-0.2, 3.0]) x = -2 uchida. Pastki etak taxtasi y = -0.2 gacha tushib, pol chetini yopadi.
- **wood_floor_01** — origin: katak markazi, ustki yuza y = 0. x, z ∈ [-2, 2], y ∈ [-0.2, 0].
- **wood_roof_slope_01** — origin: tizma (ridge) chizig'i ostidagi, devor tepasi balandligidagi nuqta. Tizma X bo'ylab, (y = 1.5, z = 0). Qiyalik +Z tomonga tushadi: z = 2 da y = 0 (devor o'qi ustida), osilma z = 2.4, y = -0.3 gacha. Qiyalik 36.87° (1.5 : 2). Bitta bo'lak = 4 m uzunlik × 2 m yarim kenglik.
- **wood_roof_gable_01** — devor bilan bir xil konvensiya (x ∈ [-2, 2], tashqi +Z). Ostidagi devor bilan bir xil a→b joylashuv, faqat y = 3.0. Cho'qqi (0, 1.5, 0).
- **wood_door_01** — root origini eshikli devor origini bilan bir xil: ikkalasiga aynan bir xil position va rotation bering.
- **wood_stairs_01** — origin: birinchi pog'ona old chetining markazi, y = 0. Zinapoya -Z tomonga ko'tariladi: 15 pog'ona × 0.20 m = 3.0 m, gorizontal uzunligi 4.0 m, pog'ona chuqurligi 0.267 m, eni 1.2 m. Perila +X tomonda.

## 4. Node ierarxiyasi
```
- wood_wall_01 (node)
  - wood_wall_01_body (mesh · wood)
  - corner_post (mesh · wood)

- wood_wall_window_01 (node)
  - wood_wall_window_01_body (mesh · wood)
  - corner_post (mesh · wood)
  - wood_wall_window_01_iron (mesh · iron)

- wood_wall_door_01 (node)
  - wood_wall_door_01_body (mesh · wood)
  - corner_post (mesh · wood)

- wood_floor_01 (node)
  - wood_floor_01_body (mesh · wood)

- wood_roof_slope_01 (node)
  - wood_roof_slope_01_frame (mesh · wood)
  - wood_roof_slope_01_shingles (mesh · roof)

- wood_roof_gable_01 (node)
  - wood_roof_gable_01_body (mesh · wood)

- wood_door_01 (node)
  - door_pivot (node, position (-0.88, 0.00, 0.00))
    - door_leaf (mesh · wood)
    - door_hardware (mesh · iron)

- wood_stairs_01 (node)
  - wood_stairs_01_body (mesh · wood)
```
Eshik ochish: `door.getObjectByName('door_pivot').rotation.y = 1.45` (musbat burchak — ichkariga, ya'ni -Z tomonga). Yopiq holat: 0.

## 5. Bo'shliqlar va colliderlar (modul lokal koordinatalarida)
- Deraza bo'shlig'i: x ∈ [-0.6, 0.6], y ∈ [1.0, 2.0] — 1.2 × 1.0 m, ochiq (oyna yo'q).
- Eshik bo'shlig'i: x ∈ [-0.9, 0.9], y ∈ [0, 2.4] — 1.8 × 2.4 m. Ostona y = 0.03 gacha.
- wood_wall_01: 1 box — center (0, 1.5, 0), size (4, 3, 0.2).
- wood_wall_window_01: 4 box — chap (-1.3, 1.5, 0) / (1.4, 3, 0.2); o'ng (1.3, 1.5, 0) / (1.4, 3, 0.2); past (0, 0.5, 0) / (1.2, 1.0, 0.2); tepa (0, 2.5, 0) / (1.2, 1.0, 0.2).
- wood_wall_door_01: 3 box — chap (-1.45, 1.5, 0) / (1.1, 3, 0.2); o'ng (1.45, 1.5, 0) / (1.1, 3, 0.2); tepa (0, 2.7, 0) / (1.8, 0.6, 0.2).
- wood_door_01: door_pivot ichida 1 box — center (0.88, 1.21, 0), size (1.76, 2.35, 0.06). Pivot bilan birga aylanadi.
- wood_floor_01: 1 box — center (0, -0.1, 0), size (4, 0.2, 4).
- wood_roof_slope_01: 1 box — center (0, 0.75, 1.0), size (4, 0.1, 2.5), rotation.x = +0.6435.
- wood_roof_gable_01: uchburchakli prizma (-2,0) (2,0) (0,1.5), qalinligi 0.2 (yoki convex hull).
- wood_stairs_01: rampa — center (0, 1.5, -2), size (1.2, 0.1, 5.0), rotation.x = +0.6435.

## 6. Yig'ish
```ts
const WALL_H = 3;
// a -> b tugunlar orasiga devor. corner_post a tugunida bo'ladi.
// Tashqi yuza (+Z) harakat yo'nalishiga nisbatan O'NG tomonda.
function placeWall(o: THREE.Object3D, ax: number, az: number, bx: number, bz: number, y = 0) {
  o.position.set((ax + bx) / 2, y, (az + bz) / 2);
  o.rotation.y = Math.atan2(-(bz - az), bx - ax);
}
// To'rtburchak uyni yuqoridan qaraganda shu tartibda aylanib chiqing:
// (x0,z0) -> (x0,z1) -> (x1,z1) -> (x1,z0) -> (x0,z0); har bir 4 m qadam = bitta devor.
// Pol: har bir katak markaziga (cx, 0, cz).
// Tom (tizma X bo'ylab, uy eni 4 m, z0..z0+4): har bir 4 m uchun 2 bo'lak:
//   roof.position.set(cx, WALL_H, z0 + 2); roof.rotation.y = 0;       // +Z tomoni
//   roof.position.set(cx, WALL_H, z0 + 2); roof.rotation.y = Math.PI; // -Z tomoni
// Uchburchak: shu chetdagi devor bilan bir xil a -> b, y = WALL_H.
// Eshik: door.position.copy(doorWall.position); door.rotation.copy(doorWall.rotation);
```
- Har bir tugunda faqat bitta `corner_post` bo'lishi kerak. Yopiq perimetrda yuqoridagi tartib buni avtomatik ta'minlaydi. Ichki to'siq devor mavjud ustunli tugundan boshlansa: `wall.getObjectByName('corner_post').visible = false`. Devorning ochiq qolgan (+X) uchiga boshqa devordan `corner_post` nusxasini qo'ying.
- 4 × 4 kulba: 1 pol, 4 devor, 2 tom bo'lagi, 2 uchburchak.
- 8 × 4 uy: 2 pol, 6 devor, 4 tom bo'lagi, 2 uchburchak (namuna uy).
- 8 × 8 bino: 4 pol, 8 devor. Tom ikki parallel tizma bilan (z = 2 va z = 6): 8 tom bo'lagi, 4 uchburchak. O'rtadagi ariqcha (valley) ustida osilmalar bir-biri bilan kesishadi — bu normal holat.

## 7. Namuna uy
examples/sample_cabin_layout.json — namuna uydagi har bir modulning fayli, position va rotationY qiymatlari.
