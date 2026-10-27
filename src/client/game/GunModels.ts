import * as THREE from 'three';
import type { WeaponId } from '../../shared/weapons';
import {
  getCachedWeaponTemplate,
  hasWeaponAssetFailed,
  onWeaponAssetsReady,
  preloadWeaponAssets,
  type CachedWeaponTemplate,
  type MergedMeshSlice,
  type WeaponLodVariant,
} from './WeaponAssetRegistry';

// ============== Toza, Silliq 3D PBR Materiallar (Har xil xira teksturasiz, aniq 3D ko'rinish) ==============
const receiverDark = new THREE.MeshStandardMaterial({ color: '#2b313a', metalness: 0.65, roughness: 0.32 });
const receiverSteel = new THREE.MeshStandardMaterial({ color: '#525d6b', metalness: 0.72, roughness: 0.26 });
const barrelSteel = new THREE.MeshStandardMaterial({ color: '#7a8796', metalness: 0.80, roughness: 0.22 });
const chromeMat = new THREE.MeshStandardMaterial({ color: '#dce4ec', metalness: 0.90, roughness: 0.14 });
const brassMat = new THREE.MeshStandardMaterial({ color: '#e8b238', metalness: 0.82, roughness: 0.22 });
const walnutMat = new THREE.MeshStandardMaterial({ color: '#9c5424', metalness: 0.05, roughness: 0.52 });
const walnutDark = new THREE.MeshStandardMaterial({ color: '#6b3714', metalness: 0.05, roughness: 0.58 });
const polymerBlack = new THREE.MeshStandardMaterial({ color: '#1b1f24', metalness: 0.18, roughness: 0.68 });
const oliveChassis = new THREE.MeshStandardMaterial({ color: '#4f6339', metalness: 0.22, roughness: 0.48 });
const shellRed = new THREE.MeshStandardMaterial({ color: '#dc2626', metalness: 0.15, roughness: 0.35 });
const sightRed = new THREE.MeshStandardMaterial({
  color: '#ff3b3b',
  emissive: '#ff2020',
  emissiveIntensity: 1.2,
  roughness: 0.15,
});
const sightGreen = new THREE.MeshStandardMaterial({
  color: '#34f56c',
  emissive: '#18e050',
  emissiveIntensity: 1.1,
  roughness: 0.15,
});
const scopeLens = new THREE.MeshStandardMaterial({
  color: '#22ebd0',
  metalness: 0.92,
  roughness: 0.08,
  emissive: '#0d7a6b',
  emissiveIntensity: 0.85,
});
// Modul darajasidagi materiallar barcha procedural qurollar/granatalar/gilzalar o'rtasida umumiy —
// tushgan qurol yoki granata sahnadan olib tashlanganda dispose qilinmasligi kerak.
for (const m of [
  receiverDark, receiverSteel, barrelSteel, chromeMat, brassMat, walnutMat, walnutDark,
  polymerBlack, oliveChassis, shellRed, sightRed, sightGreen, scopeLens,
]) {
  m.userData.sharedAsset = true;
}

export interface GunModel {
  group: THREE.Group;
  muzzle: THREE.Vector3;     // stvol uchi (lokal)
  ejectPort: THREE.Vector3;  // gilza otilib chiqadigan joy (lokal)
  slide?: THREE.Object3D;    // o'q uzilganda harakatlanuvchi zatvor / pompa / baraban
  mag?: THREE.Object3D;      // qayta o'qlashda harakatlanuvchi magazin
  isGlb?: boolean;
}

/**
 * (z, y) tekisligidagi 2D konturdan silliq 3D faskali (beveled) shakl yasaydi.
 * Hech qanday qirralar chiqib qolmaydi va barcha burchaklar haqiqiy 3D yumaloqlangan bo'ladi.
 */
function profile3D(
  g: THREE.Object3D,
  pts: [number, number][],
  widthX: number,
  mat: THREE.Material,
  bevel = 0.006,
): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i][0], pts[i][1]);
  }
  shape.closePath();

  const depth = Math.max(0.004, widthX - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 8,
  });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.y = -Math.PI / 2;
  m.position.x = depth / 2;
  g.add(m);
  return m;
}

/** Z o'qi bo'ylab yotqizilgan silliq silindr (stvol, optika va trubkalar uchun) */
function cylZ(
  g: THREE.Object3D,
  rTop: number,
  rBot: number,
  len: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  seg = 16,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, seg), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

/** X o'qi bo'ylab ko'ndalang silindr (zatvor dastasi va baraban o'qlari uchun) */
function cylX(
  g: THREE.Object3D,
  r: number,
  len: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  seg = 12,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
  m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

function box(
  g: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

/** Procedural fallback qurol modeli: -Z tomonga qaragan, (0,0,0) — dasta atrofida. */
export function buildProceduralGun(w: WeaponId): GunModel {
  const g = new THREE.Group();
  let muzzle = new THREE.Vector3();
  let ejectPort = new THREE.Vector3(0.04, 0.025, -0.06);
  let slide: THREE.Object3D | undefined;
  let mag: THREE.Object3D | undefined;

  switch (w) {
    case 'rifle': {
      // ================== AVTOMAT (AK-uslubidagi Silliq 3D Taktik Avtomat) ==================
      // 1. Silliq faskali Metall Korpus (Receiver)
      profile3D(
        g,
        [
          [0.16, -0.032],
          [-0.24, -0.032],
          [-0.26, 0.015],
          [-0.22, 0.052],
          [0.12, 0.052],
          [0.16, 0.018],
        ],
        0.072,
        receiverDark,
        0.007,
      );
      // Ustki silliq qopqoq (Dust cover)
      profile3D(
        g,
        [
          [0.12, 0.020],
          [-0.18, 0.020],
          [-0.16, 0.060],
          [0.10, 0.060],
        ],
        0.064,
        receiverSteel,
        0.006,
      );

      // 2. Harakatlanuvchi Zatvor va Dastasi (Slide / Bolt Carrier)
      slide = new THREE.Group();
      box(slide, 0.066, 0.026, 0.11, chromeMat, 0.004, 0.030, -0.08);
      cylX(slide, 0.008, 0.036, chromeMat, 0.044, 0.030, -0.11);
      cylX(slide, 0.013, 0.018, brassMat, 0.060, 0.030, -0.11);
      g.add(slide);

      // 3. Yaxlit Silliq Yog'och Qundoq (Wooden Buttstock)
      profile3D(
        g,
        [
          [0.15, 0.022],
          [0.44, 0.012],
          [0.44, -0.105],
          [0.39, -0.105],
          [0.24, -0.042],
          [0.15, -0.030],
        ],
        0.058,
        walnutMat,
        0.007,
      );
      // Qundoq orqa rezina yostiqchasi (Buttpad)
      profile3D(
        g,
        [
          [0.435, 0.014],
          [0.462, 0.012],
          [0.462, -0.106],
          [0.435, -0.106],
        ],
        0.060,
        polymerBlack,
        0.005,
      );

      // 4. Ergonomik Dasta (Pistol Grip) va Tepki halqasi
      profile3D(
        g,
        [
          [0.11, -0.028],
          [0.04, -0.028],
          [0.08, -0.165],
          [0.15, -0.160],
        ],
        0.048,
        walnutDark,
        0.006,
      );
      profile3D(
        g,
        [
          [0.045, -0.028],
          [-0.035, -0.028],
          [-0.030, -0.068],
          [0.045, -0.068],
        ],
        0.016,
        receiverDark,
        0.002,
      );

      // 5. Yaxlit Silliq Egilgan Magazin (One-Piece Curved Banana Magazine — hech qayeri chiqib qolmaydi!)
      mag = new THREE.Group();
      profile3D(
        mag,
        [
          [-0.06, -0.025],
          [-0.15, -0.025],
          [-0.17, -0.11],
          [-0.21, -0.20],
          [-0.26, -0.265],
          [-0.18, -0.285],
          [-0.12, -0.20],
          [-0.08, -0.11],
        ],
        0.050,
        polymerBlack,
        0.005,
      );
      // Magazin pastki oltin tagligi
      profile3D(
        mag,
        [
          [-0.24, -0.250],
          [-0.265, -0.268],
          [-0.180, -0.290],
          [-0.162, -0.268],
        ],
        0.053,
        brassMat,
        0.003,
      );
      g.add(mag);

      // 6. Old Yog'och Tirsaklagich (Handguard)
      profile3D(
        g,
        [
          [-0.24, 0.042],
          [-0.50, 0.038],
          [-0.51, -0.022],
          [-0.48, -0.035],
          [-0.24, -0.032],
        ],
        0.068,
        walnutMat,
        0.007,
      );
      // Handguard ustki yog'och qoplamasi
      profile3D(
        g,
        [
          [-0.25, 0.058],
          [-0.48, 0.055],
          [-0.49, 0.035],
          [-0.25, 0.035],
        ],
        0.054,
        walnutDark,
        0.005,
      );

      // 7. Ustki Kollimator Pritsel (Clean Reflex Sight)
      box(g, 0.044, 0.014, 0.11, receiverDark, 0, 0.066, -0.04);
      box(g, 0.048, 0.038, 0.055, receiverDark, 0, 0.090, -0.04);
      box(g, 0.036, 0.028, 0.060, scopeLens, 0, 0.092, -0.04);
      const redDot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 8), sightRed);
      redDot.position.set(0, 0.092, -0.01);
      g.add(redDot);

      // 8. Silliq Stvol, Gaz Trubkasi, Old Nishon va Kompensator
      cylZ(g, 0.017, 0.019, 0.34, barrelSteel, 0, 0.015, -0.64, 16);
      cylZ(g, 0.013, 0.013, 0.16, receiverSteel, 0, 0.044, -0.55, 14);
      // Gaz bloki
      profile3D(
        g,
        [
          [-0.58, 0.052],
          [-0.63, 0.052],
          [-0.64, 0.005],
          [-0.58, 0.005],
        ],
        0.030,
        receiverDark,
        0.003,
      );
      // Old A-simon nishon (Front sight post)
      profile3D(
        g,
        [
          [-0.71, 0.010],
          [-0.76, 0.010],
          [-0.75, 0.078],
          [-0.73, 0.078],
        ],
        0.022,
        receiverDark,
        0.003,
      );
      const frontGlow = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 8, 8), sightGreen);
      frontGlow.position.set(0, 0.080, -0.74);
      g.add(frontGlow);

      // Stvol uchi kompensatori (Muzzle brake)
      cylZ(g, 0.024, 0.024, 0.065, receiverDark, 0, 0.015, -0.80, 16);
      cylZ(g, 0.025, 0.025, 0.012, chromeMat, 0, 0.015, -0.78, 16);

      muzzle = new THREE.Vector3(0, 0.015, -0.835);
      ejectPort = new THREE.Vector3(0.042, 0.030, -0.08);
      break;
    }

    case 'pistol': {
      // ================== TO'PPONCHA (Silliq 3D Xrom .44 Magnum Revolver) ==================
      // 1. Revolver Ramkasi (Frame) va Tepki halqasi
      profile3D(
        g,
        [
          [0.06, 0.045],
          [-0.08, 0.045],
          [-0.08, -0.012],
          [0.04, -0.012],
          [0.06, 0.010],
        ],
        0.042,
        receiverSteel,
        0.005,
      );
      profile3D(
        g,
        [
          [0.025, -0.010],
          [-0.038, -0.010],
          [-0.030, -0.048],
          [0.020, -0.048],
        ],
        0.016,
        receiverDark,
        0.002,
      );

      // 2. Ergonomik Yong'oq Yog'ochli Dasta (One-Piece Contoured Walnut Grip)
      profile3D(
        g,
        [
          [0.055, 0.012],
          [0.005, -0.012],
          [0.035, -0.148],
          [0.105, -0.140],
          [0.085, -0.025],
        ],
        0.048,
        walnutMat,
        0.007,
      );
      // Dasta oltin medalyoni
      cylX(g, 0.012, 0.052, brassMat, 0, -0.068, 0.048);

      // 3. Harakatlanuvchi Baraban va Yo'g'on Magnum Stvoli (Slide & Cylinder)
      slide = new THREE.Group();
      // 6-otishli silliq Baraban (Cylinder)
      cylZ(slide, 0.038, 0.038, 0.082, receiverDark, 0, 0.028, -0.015, 18);
      cylZ(slide, 0.039, 0.039, 0.010, brassMat, 0, 0.028, 0.022, 18);

      // Yaxlit Yo'g'on Magnum Stvoli (Shroud + Underlug + Vent Rib)
      profile3D(
        slide,
        [
          [-0.055, 0.068],
          [-0.245, 0.066],
          [-0.250, 0.016],
          [-0.220, 0.008],
          [-0.055, 0.008],
        ],
        0.044,
        chromeMat,
        0.006,
      );
      cylZ(slide, 0.020, 0.020, 0.21, barrelSteel, 0, 0.044, -0.155, 16);
      cylZ(slide, 0.013, 0.013, 0.02, polymerBlack, 0, 0.044, -0.255, 14);

      // Nishonlar va Oltin Kurakcha (Hammer)
      profile3D(
        slide,
        [
          [-0.21, 0.066],
          [-0.24, 0.066],
          [-0.23, 0.084],
        ],
        0.012,
        sightRed,
        0.001,
      );
      box(slide, 0.032, 0.014, 0.016, sightGreen, 0, 0.068, 0.042);
      profile3D(
        slide,
        [
          [0.055, 0.038],
          [0.088, 0.068],
          [0.072, 0.078],
          [0.045, 0.048],
        ],
        0.014,
        brassMat,
        0.002,
      );
      g.add(slide);

      muzzle = new THREE.Vector3(0, 0.044, -0.26);
      ejectPort = new THREE.Vector3(0.042, 0.035, -0.015);
      break;
    }

    case 'shotgun': {
      // ================== DROBOVIK (Silliq 3D 12-Kalibrli Pompali Ov Miltig'i) ==================
      // 1. Silliq faskali Po'lat Korpus (Receiver)
      profile3D(
        g,
        [
          [0.14, -0.034],
          [-0.15, -0.034],
          [-0.15, 0.048],
          [-0.12, 0.058],
          [0.10, 0.058],
          [0.14, 0.022],
        ],
        0.074,
        receiverSteel,
        0.008,
      );
      // Zatvor darchasi (Chrome bolt window)
      box(g, 0.078, 0.028, 0.095, chromeMat, 0.002, 0.022, -0.02);

      // Yon tomonda 4 ta chiroyli 12-kalibr qizil patronlar (Side saddle)
      box(g, 0.010, 0.048, 0.14, receiverDark, 0.040, 0.006, -0.01);
      for (let i = 0; i < 4; i++) {
        const sz = -0.058 + i * 0.034;
        const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.048, 12), shellRed);
        sh.position.set(0.046, 0.006, sz);
        g.add(sh);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.0105, 0.014, 12), brassMat);
        cap.position.set(0.046, 0.026, sz);
        g.add(cap);
      }

      // 2. Yaxlit Silliq Yong'oq Yog'ochli Qundoq va Yarim-Dasta (Continuous Hunting Stock & Grip)
      profile3D(
        g,
        [
          [0.13, 0.024],
          [0.22, -0.010],
          [0.45, -0.005],
          [0.45, -0.125],
          [0.40, -0.125],
          [0.22, -0.065],
          [0.15, -0.135],
          [0.09, -0.130],
          [0.11, -0.032],
        ],
        0.062,
        walnutMat,
        0.008,
      );
      // Rezina tepki yostiqchasi (Recoil pad)
      profile3D(
        g,
        [
          [0.445, -0.004],
          [0.475, -0.006],
          [0.475, -0.126],
          [0.445, -0.126],
        ],
        0.064,
        polymerBlack,
        0.005,
      );

      // 3. Qo'shaloq Stvol va Pastki Magazin Trubkasi (Heavy Barrel + Under-Tube)
      cylZ(g, 0.024, 0.025, 0.58, receiverDark, 0, 0.032, -0.43, 18);
      cylZ(g, 0.020, 0.020, 0.48, barrelSteel, 0, -0.014, -0.38, 16);
      cylZ(g, 0.022, 0.022, 0.025, brassMat, 0, -0.014, -0.62, 16);
      // Stvol va trubkani tutashtiruvchi xomut (Barrel clamp)
      profile3D(
        g,
        [
          [-0.53, 0.050],
          [-0.57, 0.050],
          [-0.57, -0.032],
          [-0.53, -0.032],
        ],
        0.052,
        receiverDark,
        0.004,
      );
      // Ustki nishon reykasi va yorqin nishon nuqtasi
      box(g, 0.018, 0.010, 0.56, receiverDark, 0, 0.058, -0.42);
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 10), sightRed);
      bead.position.set(0, 0.068, -0.69);
      g.add(bead);

      // 4. Harakatlanuvchi Qovurg'ali Yog'och Pompa (Animated Ribbed Pump Forend)
      slide = new THREE.Group();
      cylZ(slide, 0.038, 0.038, 0.22, walnutDark, 0, -0.016, -0.38, 16);
      for (let i = 0; i < 5; i++) {
        cylZ(slide, 0.041, 0.041, 0.018, walnutMat, 0, -0.016, -0.30 - i * 0.038, 16);
      }
      cylZ(slide, 0.039, 0.039, 0.018, brassMat, 0, -0.016, -0.27, 16);
      g.add(slide);

      muzzle = new THREE.Vector3(0, 0.032, -0.72);
      ejectPort = new THREE.Vector3(0.048, 0.024, -0.02);
      break;
    }

    case 'sniper': {
      // ================== SNAYPER (Silliq 3D Taktik Ovchi Snayper Miltig'i) ==================
      // 1. Yaxlit Silliq Taktik Shassi va Old Tirsaklagich (One-Piece Olive Chassis)
      profile3D(
        g,
        [
          [0.18, -0.036],
          [-0.42, -0.032],
          [-0.45, 0.016],
          [-0.40, 0.038],
          [0.14, 0.038],
          [0.18, 0.012],
        ],
        0.072,
        oliveChassis,
        0.008,
      );
      // Po'lat Ustki Receiver
      profile3D(
        g,
        [
          [0.12, 0.018],
          [-0.18, 0.018],
          [-0.16, 0.056],
          [0.10, 0.056],
        ],
        0.066,
        receiverSteel,
        0.006,
      );

      // 2. Yaxlit Snayper Qundog'i va Ergonomik Dastasi + Yonoq Yostiqchasi
      profile3D(
        g,
        [
          [0.17, 0.018],
          [0.52, 0.012],
          [0.52, -0.118],
          [0.46, -0.118],
          [0.24, -0.050],
          [0.17, -0.155],
          [0.10, -0.150],
          [0.12, -0.034],
        ],
        0.062,
        walnutMat,
        0.007,
      );
      // Yonoq yostiqchasi (Cheek riser) va rezina buttpad
      profile3D(
        g,
        [
          [0.25, 0.015],
          [0.44, 0.015],
          [0.42, 0.054],
          [0.27, 0.054],
        ],
        0.066,
        walnutDark,
        0.005,
      );
      profile3D(
        g,
        [
          [0.515, 0.014],
          [0.548, 0.012],
          [0.548, -0.120],
          [0.515, -0.120],
        ],
        0.066,
        polymerBlack,
        0.005,
      );

      // 3. Uzun Snayper Stvoli va Yirik Kompensator (Heavy Barrel + Muzzle Brake)
      cylZ(g, 0.020, 0.023, 0.56, barrelSteel, 0, 0.026, -0.66, 18);
      profile3D(
        g,
        [
          [-0.86, 0.050],
          [-0.95, 0.048],
          [-0.95, 0.004],
          [-0.86, 0.002],
        ],
        0.058,
        receiverDark,
        0.005,
      );

      // 4. Yig'ilgan Ikki Oyoqli Tirgak (Clean Folded Bipod)
      box(g, 0.076, 0.024, 0.036, receiverDark, 0, -0.040, -0.36);
      cylZ(g, 0.010, 0.010, 0.22, barrelSteel, -0.034, -0.052, -0.46, 10);
      cylZ(g, 0.010, 0.010, 0.22, barrelSteel, 0.034, -0.052, -0.46, 10);

      // 5. Katta 3D Optik Pritsel (Telescopic Hunting Scope with Glowing Lenses)
      box(g, 0.032, 0.052, 0.028, receiverDark, 0, 0.072, -0.10);
      box(g, 0.032, 0.052, 0.028, receiverDark, 0, 0.072, 0.06);
      cylZ(g, 0.030, 0.030, 0.34, receiverDark, 0, 0.114, -0.02, 18);
      cylZ(g, 0.042, 0.032, 0.10, receiverDark, 0, 0.114, -0.19, 18); // Front objective bell
      cylZ(g, 0.034, 0.038, 0.08, receiverDark, 0, 0.114, 0.15, 18);  // Rear eyepiece
      // Oltin barabanchalar (Turrets)
      const topTurret = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.026, 12), brassMat);
      topTurret.position.set(0, 0.152, -0.02);
      g.add(topTurret);
      cylX(g, 0.016, 0.026, brassMat, 0.038, 0.114, -0.02);
      // Yorqin 3D Zumrad Linzalar
      cylZ(g, 0.038, 0.038, 0.008, scopeLens, 0, 0.114, -0.238, 16);
      cylZ(g, 0.034, 0.034, 0.008, scopeLens, 0, 0.114, 0.188, 16);

      // 6. Harakatlanuvchi Zatvor va Sharsimon Dasta (Animated Bolt Handle)
      slide = new THREE.Group();
      cylZ(slide, 0.020, 0.020, 0.13, chromeMat, 0.006, 0.030, 0.03, 12);
      cylX(slide, 0.008, 0.058, chromeMat, 0.048, 0.026, 0.06);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.017, 12, 12), brassMat);
      knob.position.set(0.078, 0.026, 0.06);
      slide.add(knob);
      g.add(slide);

      // 7. Ajraluvchi Po'lat Magazin
      mag = new THREE.Group();
      profile3D(
        mag,
        [
          [0.01, -0.032],
          [-0.09, -0.032],
          [-0.10, -0.135],
          [0.00, -0.128],
        ],
        0.050,
        polymerBlack,
        0.004,
      );
      box(mag, 0.054, 0.016, 0.104, brassMat, 0, -0.134, -0.048);
      g.add(mag);

      muzzle = new THREE.Vector3(0, 0.026, -0.95);
      ejectPort = new THREE.Vector3(0.048, 0.030, 0.02);
      break;
    }
    case 'knife': {
      // ================== PICHOQ (GLB yuklanmaguncha oddiy zaxira: tig', gard, dasta) ==================
      const blade = box(g, 0.004, 0.034, 0.19, receiverSteel, 0, -0.002, -0.155);
      blade.name = 'blade';
      box(g, 0.028, 0.044, 0.012, receiverDark, 0, 0, -0.054);
      box(g, 0.026, 0.034, 0.11, walnutDark, 0, 0, 0.006);
      box(g, 0.028, 0.036, 0.008, receiverDark, 0, 0, 0.064);
      muzzle = new THREE.Vector3(0, 0.002, -0.25);
      ejectPort = new THREE.Vector3(0, 0, 0);
      break;
    }
  }

  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return { group: g, muzzle, ejectPort, slide, mag, isGlb: false };
}

function addSlicesToGroup(target: THREE.Group, slices: MergedMeshSlice[], castShadow = true): void {
  for (const s of slices) {
    const m = new THREE.Mesh(s.geometry, s.material);
    m.castShadow = castShadow;
    m.receiveShadow = true;
    target.add(m);
  }
}

function populateFromTemplate(
  tpl: CachedWeaponTemplate,
  variant: WeaponLodVariant,
  staticGroup: THREE.Group,
  slideAnchor: THREE.Group,
  slideGroup: THREE.Group,
  magAnchor: THREE.Group,
  magGroup: THREE.Group,
  muzzle: THREE.Vector3,
  ejectPort: THREE.Vector3,
): void {
  staticGroup.clear();
  slideGroup.clear();
  magGroup.clear();

  const lod = tpl.lod[variant];
  addSlicesToGroup(staticGroup, lod.staticSlices, true);
  addSlicesToGroup(slideGroup, lod.slideSlices, true);
  addSlicesToGroup(magGroup, lod.magSlices, true);

  slideAnchor.position.copy(tpl.slidePivot);
  slideGroup.position.set(0, 0, 0);
  slideGroup.rotation.set(0, 0, 0);

  magAnchor.position.copy(tpl.magPivot);
  magGroup.position.set(0, 0, 0);
  magGroup.rotation.set(0, 0, 0);

  muzzle.copy(tpl.muzzle);
  ejectPort.copy(tpl.ejectPort);
}

/**
 * Qurol modeli: GLB asset keshidan ('1p' to'liq tafsilotli yoki '3p' soddalashtirilgan LOD)
 * bir xil geometriya va materiallarni qayta ishlatib yaratadi.
 * Agar GLB hali yuklanmagan bo'lsa yoki yuklashda xato bersa, procedural modelga xavfsiz qaytadi.
 */
export function buildGun(w: WeaponId, variant: WeaponLodVariant = '1p'): GunModel {
  void preloadWeaponAssets();

  const root = new THREE.Group();
  root.name = `gun_${w}_${variant}`;

  const staticGroup = new THREE.Group();
  staticGroup.name = 'gun_static';
  root.add(staticGroup);

  const slideAnchor = new THREE.Group();
  slideAnchor.name = 'gun_slide_anchor';
  const slideGroup = new THREE.Group();
  slideGroup.name = 'gun_slide';
  slideAnchor.add(slideGroup);
  root.add(slideAnchor);

  const magAnchor = new THREE.Group();
  magAnchor.name = 'gun_mag_anchor';
  const magGroup = new THREE.Group();
  magGroup.name = 'gun_mag';
  magAnchor.add(magGroup);
  root.add(magAnchor);

  const muzzle = new THREE.Vector3();
  const ejectPort = new THREE.Vector3();

  const out: GunModel = {
    group: root,
    muzzle,
    ejectPort,
    slide: slideGroup,
    mag: magGroup,
    isGlb: false,
  };

  const tpl = getCachedWeaponTemplate(w);
  if (tpl) {
    populateFromTemplate(tpl, variant, staticGroup, slideAnchor, slideGroup, magAnchor, magGroup, muzzle, ejectPort);
    out.isGlb = true;
    return out;
  }

  // Fallback to procedural immediately; upgrade in-place when GLB cache completes
  const proc = buildProceduralGun(w);
  if (proc.slide) proc.group.remove(proc.slide);
  if (proc.mag) proc.group.remove(proc.mag);
  staticGroup.add(proc.group);
  if (proc.slide) slideGroup.add(proc.slide);
  if (proc.mag) magGroup.add(proc.mag);
  muzzle.copy(proc.muzzle);
  ejectPort.copy(proc.ejectPort);

  if (!hasWeaponAssetFailed(w)) {
    onWeaponAssetsReady(() => {
      const loadedTpl = getCachedWeaponTemplate(w);
      if (!loadedTpl) return;
      populateFromTemplate(
        loadedTpl,
        variant,
        staticGroup,
        slideAnchor,
        slideGroup,
        magAnchor,
        magGroup,
        muzzle,
        ejectPort,
      );
      out.isGlb = true;
    });
  }

  return out;
}

/** 3D Ananas-Granata modeli */
export function buildGrenadeModel(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.076, 16, 14), oliveChassis);
  body.scale.set(1, 1.24, 1);
  body.castShadow = true;
  g.add(body);

  for (const ry of [-0.042, 0, 0.042]) {
    const r = ry === 0 ? 0.080 : 0.070;
    const band = new THREE.Mesh(new THREE.TorusGeometry(r, 0.008, 8, 14), oliveChassis);
    band.rotation.x = Math.PI / 2;
    band.position.y = ry;
    g.add(band);
  }

  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.079, 0.079, 0.020, 16), brassMat);
  g.add(ring);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.032, 0.046, 12), barrelSteel);
  neck.position.y = 0.098;
  g.add(neck);

  const topCap = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.028, 0.018, 12), chromeMat);
  topCap.position.y = 0.120;
  g.add(topCap);

  const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.115, 0.026), chromeMat);
  spoon.position.set(0.048, 0.046, 0);
  spoon.rotation.z = -0.22;
  g.add(spoon);

  const pinRing = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.005, 8, 16), brassMat);
  pinRing.position.set(-0.034, 0.104, 0);
  g.add(pinRing);

  return g;
}

// ============== Killchat va HUD uchun Haqiqiy 3D Render Ikonka Generator ==============
let cachedIcons3D: Record<WeaponId | 'grenade', string> | null = null;
let iconsBuiltWithGlb = false;

onWeaponAssetsReady(() => {
  if (!iconsBuiltWithGlb) {
    cachedIcons3D = null;
  }
});

export function getWeaponIcons3D(): Record<WeaponId | 'grenade', string> {
  if (cachedIcons3D) return cachedIcons3D;
  const out = {} as Record<WeaponId | 'grenade', string>;
  try {
    const H = 108;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(2);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.45;

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#3b4a5e', 2.6));
    const keyLight = new THREE.DirectionalLight('#fff8eb', 4.2);
    keyLight.position.set(2.4, 3.6, 3.8);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight('#7dd3fc', 3.2);
    rimLight.position.set(-2.8, 2.6, -2.6);
    scene.add(rimLight);
    const bottomFill = new THREE.DirectionalLight('#fbbf24', 2.0);
    bottomFill.position.set(0.6, -2.8, 2.4);
    scene.add(bottomFill);

    const cam = new THREE.PerspectiveCamera(24, 1, 0.05, 20);
    const items: (WeaponId | 'grenade')[] = ['rifle', 'pistol', 'shotgun', 'sniper', 'knife', 'grenade'];

    for (const id of items) {
      const W = id === 'grenade' ? 124 : id === 'pistol' ? 196 : id === 'knife' ? 210 : 292;
      renderer.setSize(W, H);
      const aspect = W / H;
      cam.aspect = aspect;

      const pivot = new THREE.Group();
      const obj = id === 'grenade' ? buildGrenadeModel() : buildGun(id).group;
      pivot.add(obj);

      if (id === 'grenade') {
        pivot.rotation.set(0.30, -0.45, 0.12);
      } else {
        pivot.rotation.set(0.22, -Math.PI / 2 + 0.24, -0.04);
      }
      scene.add(pivot);
      pivot.updateMatrixWorld(true);

      const box3 = new THREE.Box3().setFromObject(pivot);
      const center = box3.getCenter(new THREE.Vector3());
      const size = box3.getSize(new THREE.Vector3());
      pivot.position.sub(center);
      pivot.updateMatrixWorld(true);

      const halfTan = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
      const distY = (size.y * 0.56) / halfTan + size.z * 0.52;
      const distX = (size.x * 0.53) / (halfTan * aspect) + size.z * 0.52;
      const dist = Math.max(distY, distX);

      cam.position.set(0, 0.01, dist);
      cam.lookAt(0, 0, 0);
      cam.updateProjectionMatrix();

      renderer.clear();
      renderer.render(scene, cam);

      const pw = W * 2;
      const ph = H * 2;
      const c2d = document.createElement('canvas');
      c2d.width = pw;
      c2d.height = ph;
      const ctx = c2d.getContext('2d')!;

      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 5;
      ctx.drawImage(renderer.domElement, 0, 0, pw, ph);
      ctx.restore();

      ctx.save();
      ctx.shadowColor = 'rgba(255, 245, 215, 0.45)';
      ctx.shadowBlur = 2.5;
      ctx.drawImage(renderer.domElement, 0, 0, pw, ph);
      ctx.restore();

      out[id] = c2d.toDataURL('image/png');
      scene.remove(pivot);
    }

    renderer.dispose();
    iconsBuiltWithGlb = Boolean(getCachedWeaponTemplate('rifle'));
    cachedIcons3D = out;
  } catch {
    cachedIcons3D = out;
  }
  return out;
}
