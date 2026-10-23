import * as THREE from 'three';
import type { MaterialKind } from '../../shared/map';
import {
  buildTerrainMeshData,
  DEFAULT_WORLD,
  sampleTerrainHeight,
  type WorldDefinition,
} from '../../shared/world';
import type { QualityLevel } from '../settings';
import {
  buildForestSampleScene,
  type CullingProfileStats,
  type Stage04ASceneHandles,
} from './ForestRenderer';
import { createTextures, TEX_SCALE } from './Textures';
import type { GroundCoverStats } from './GroundCoverRenderer';

export type { CullingProfileStats, Stage04ASceneHandles, GroundCoverStats };

function scaleBoxUVs(geo: THREE.BoxGeometry, w: number, h: number, d: number, scale: number | null) {
  if (!scale) return;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  // yuzalar tartibi: +x, -x, +y, -y, +z, -z (har biri 4 ta uch)
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / scale, (uv.getY(i) * dims[f][1]) / scale);
    }
  }
  uv.needsUpdate = true;
}

export interface WorldHandles {
  sun: THREE.DirectionalLight;
  sky: THREE.Mesh;
  setQuality?: (q: QualityLevel) => void;
  update?: (
    camera?: THREE.Camera,
    focusPos?: { x: number; y: number; z: number },
    thirdPerson?: boolean,
  ) => void;
  getCullingProfile?: () => CullingProfileStats;
  resetCullingProfile?: () => void;
  /** STAGE 08-FIX: visual-only ground cover stats (only present on `forest_square`). */
  getGroundCoverStats?: () => GroundCoverStats;
  stage04a?: Stage04ASceneHandles;
  dispose: () => void;
}

/**
 * RV furgonning tashqi detallari (oynalar, g'ildiraklar, faralar, konditsioner, soyabon).
 * Asosiy kuzov MAP.boxes ('metal') orqali allaqachon to'qnashuv qutisi sifatida chizilgan.
 */
function decorateRV(group: THREE.Group, cx: number, cz: number, w: number, d: number, h: number, dirZ: 1 | -1) {
  const rv = new THREE.Group();
  rv.position.set(cx, 0, cz);
  if (dirZ < 0) rv.rotation.y = Math.PI;

  const glassMat = new THREE.MeshStandardMaterial({ color: '#1e3342', metalness: 0.75, roughness: 0.18 });
  const tireMat = new THREE.MeshStandardMaterial({ color: '#1b1d1f', roughness: 0.85 });
  const rimMat = new THREE.MeshStandardMaterial({ color: '#cfd4d8', metalness: 0.7, roughness: 0.3 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: '#d8dee3', metalness: 0.85, roughness: 0.2 });
  const lightMat = new THREE.MeshBasicMaterial({ color: '#fff3a8' });
  const tailMat = new THREE.MeshBasicMaterial({ color: '#ff3b2f' });
  const acMat = new THREE.MeshStandardMaterial({ color: '#ded8c8', roughness: 0.6 });
  const awningMat = new THREE.MeshStandardMaterial({ color: '#d96226', roughness: 0.7 });
  const bodyMat = new THREE.MeshStandardMaterial({ color: '#e8dec6', roughness: 0.55 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: '#d96226', roughness: 0.6 });

  // Yuqori "Over-cab" yotoq bo'lmasi va old kapot (haqiqiy "RV There Yet?" kemper shakli)
  const overCab = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.72, 1.35), bodyMat);
  overCab.position.set(0, h - 0.34, d / 2 + 0.35);
  overCab.castShadow = true;
  rv.add(overCab);

  const overStripe = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 0.16, 1.37), stripeMat);
  overStripe.position.set(0, h - 0.52, d / 2 + 0.35);
  rv.add(overStripe);

  const hood = new THREE.Mesh(new THREE.BoxGeometry(w * 0.88, 0.82, 0.75), bodyMat);
  hood.position.set(0, 0.86, d / 2 + 0.32);
  hood.castShadow = true;
  rv.add(hood);

  // Old lobovoy oyna (+Z tomon)
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(w * 0.84, 0.78, 0.1), glassMat);
  windshield.position.set(0, 1.68, d / 2 + 0.04);
  windshield.rotation.x = -0.18;
  rv.add(windshield);

  // Yon ko'zgular (Side mirrors)
  for (const sx of [-1, 1]) {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.28, 0.08), chromeMat);
    mirror.position.set(sx * (w / 2 + 0.14), 1.62, d / 2 - 0.15);
    rv.add(mirror);
  }

  // Yon oynalar
  for (const sx of [-1, 1]) {
    for (const oz of [-1.8, 0.2, 2.0]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.72, 1.15), glassMat);
      win.position.set(sx * (w / 2 + 0.01), 1.82, oz);
      rv.add(win);
    }
  }

  // Old radiator panjarasi va bamperlar
  const grille = new THREE.Mesh(new THREE.BoxGeometry(w * 0.68, 0.46, 0.1), chromeMat);
  grille.position.set(0, 0.85, d / 2 + 0.68);
  rv.add(grille);

  const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(w + 0.18, 0.24, 0.24), chromeMat);
  frontBumper.position.set(0, 0.42, d / 2 + 0.72);
  rv.add(frontBumper);

  const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(w + 0.18, 0.24, 0.24), chromeMat);
  rearBumper.position.set(0, 0.42, -d / 2 - 0.08);
  rv.add(rearBumper);

  // Old faralar va orqa chiroqlar
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 12), lightMat);
    hl.rotation.x = Math.PI / 2;
    hl.position.set(sx * (w * 0.34), 0.92, d / 2 + 0.70);
    rv.add(hl);

    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.08), tailMat);
    tl.position.set(sx * (w * 0.36), 0.85, -d / 2 - 0.02);
    rv.add(tl);
  }

  // 4 ta katta off-road g'ildirak + orqadagi zapaska va narvon
  const wheelGeo = new THREE.CylinderGeometry(0.54, 0.54, 0.38, 16);
  wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.27, 0.27, 0.40, 12);
  rimGeo.rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) {
    for (const wz of [-2.1, 2.2]) {
      const wheel = new THREE.Mesh(wheelGeo, tireMat);
      wheel.position.set(sx * (w / 2 - 0.01), 0.54, wz);
      wheel.castShadow = true;
      rv.add(wheel);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.position.copy(wheel.position);
      rv.add(rim);
    }
  }
  const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.28, 16), tireMat);
  spare.rotation.x = Math.PI / 2;
  spare.position.set(0.48, 1.35, -d / 2 - 0.12);
  rv.add(spare);

  // Orqadagi tomga chiqish narvoni (Ladder)
  for (const lx of [-0.65, -0.25]) {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.2, 8), chromeMat);
    rail.position.set(lx, 1.65, -d / 2 - 0.06);
    rv.add(rail);
  }
  for (let ry = 0.75; ry <= 2.55; ry += 0.36) {
    const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 8), chromeMat);
    rung.rotation.z = Math.PI / 2;
    rung.position.set(-0.45, ry, -d / 2 - 0.06);
    rv.add(rung);
  }

  // Tomdagi konditsioner bloki va quyosh paneli
  const ac = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.34, 1.35), acMat);
  ac.position.set(0, h + 0.17, -0.6);
  rv.add(ac);

  const rack = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 2.1), stripeMat);
  rack.position.set(0, h + 0.09, -2.2);
  rv.add(rack);

  // Yon tomondagi lager soyaboni (Awning + ustunlar)
  const awning = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.08, 4.1), awningMat);
  awning.position.set(w / 2 + 0.45, h - 0.24, -0.3);
  awning.rotation.z = -0.18;
  rv.add(awning);

  for (const pz of [-2.2, 1.6]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, h - 0.3, 8), chromeMat);
    pole.position.set(w / 2 + 0.85, (h - 0.3) / 2, pz);
    rv.add(pole);
  }

  // Qiyshayib ochilib qolgan RV eshigi ("Skeleton RV" halokat effekti)
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.75, 0.78), bodyMat);
  door.position.set(w / 2 + 0.28, 1.1, 1.05);
  door.rotation.y = 0.65;
  door.rotation.z = 0.08;
  door.castShadow = true;
  rv.add(door);

  // Old bamperdagi Lebyodka (Winch + po'lat tros g'altagi + tortilgan tros)
  const winchBox = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, 0.28), tireMat);
  winchBox.position.set(0, 0.54, d / 2 + 0.82);
  rv.add(winchBox);
  const winchDrum = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.38, 10), chromeMat);
  winchDrum.rotation.z = Math.PI / 2;
  winchDrum.position.set(0, 0.54, d / 2 + 0.88);
  rv.add(winchDrum);

  // Tortilgan Lebyodka po'lat trosi (Winch Cable) va sariq EpiPen
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 3.4, 6), chromeMat);
  cable.rotation.x = Math.PI / 2 + 0.14;
  cable.rotation.z = -0.22;
  cable.position.set(0.35, 0.32, d / 2 + 2.45);
  rv.add(cable);

  // Qizib ketgan RV kapotidan chiqayotgan tutun pufakchalari
  const smokeMat = new THREE.MeshStandardMaterial({ color: '#45484c', roughness: 1, transparent: true, opacity: 0.55 });
  for (let s = 0; s < 4; s++) {
    const puff = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18 + s * 0.09, 1), smokeMat);
    puff.position.set(-0.25 + (s % 2) * 0.14, 1.38 + s * 0.38, d / 2 + 0.35);
    rv.add(puff);
  }

  // Sariq-to'q sariq "EpiPen" shpritsi (RV There Yet? jonlantirish buyumi)
  const epiPen = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.26, 8),
    new THREE.MeshStandardMaterial({ color: '#f5b82e', roughness: 0.4 }),
  );
  epiPen.rotation.z = Math.PI / 2;
  epiPen.position.set(w / 2 + 0.55, 0.46, -0.75);
  rv.add(epiPen);

  // Soyabon ostidagi "RV There Yet?" tartibsizliklari: Yig'ma stul, Folga-Gril (Burgerlar bilan) va Pivo bankalari
  const chairMat = new THREE.MeshStandardMaterial({ color: '#2b7a78', roughness: 0.7 });
  const chairSeat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.55), chairMat);
  chairSeat.position.set(w / 2 + 0.6, 0.42, -0.8);
  chairSeat.rotation.y = 0.35;
  rv.add(chairSeat);
  const chairBack = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.58, 0.55), chairMat);
  chairBack.position.set(w / 2 + 0.82, 0.68, -0.88);
  chairBack.rotation.y = 0.35;
  chairBack.rotation.z = -0.2;
  rv.add(chairBack);

  // Bir martalik Folga-Gril + Pishayotgan Burger kotletlari
  const foilGrill = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.14, 0.36), chromeMat);
  foilGrill.position.set(w / 2 + 0.55, 0.07, 0.25);
  rv.add(foilGrill);
  const pattyMat = new THREE.MeshStandardMaterial({ color: '#612918', roughness: 0.85 });
  for (const bx of [-0.12, 0.12]) {
    const burger = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.04, 10), pattyMat);
    burger.position.set(w / 2 + 0.55 + bx, 0.16, 0.25);
    rv.add(burger);
  }

  // Sochilib yotgan "Cold One" ichimlik bankalari
  const canRed = new THREE.MeshStandardMaterial({ color: '#d9382e', metalness: 0.5, roughness: 0.35 });
  const canBlue = new THREE.MeshStandardMaterial({ color: '#2e77d9', metalness: 0.5, roughness: 0.35 });
  for (let c = 0; c < 5; c++) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.13, 8), c % 2 ? canRed : canBlue);
    can.position.set(w / 2 + 0.35 + (c * 0.17), 0.06, -1.5 + (c % 3) * 0.5);
    if (c % 2 === 0) can.rotation.z = Math.PI / 2;
    rv.add(can);
  }

  group.add(rv);
}

/** "RV There Yet?" R.I.P. Qabr toshi (Respawn Checkpoint Gravestone) */
function addGravestone(group: THREE.Group, x: number, z: number, yaw: number, epitaph: string) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const stoneMat = new THREE.MeshStandardMaterial({ color: '#788085', roughness: 0.92 });
  const dirtMat = new THREE.MeshStandardMaterial({ color: '#593e25', roughness: 0.98 });

  // Tuproq uyumi
  const mound = new THREE.Mesh(new THREE.SphereGeometry(0.65, 12, 8), dirtMat);
  mound.scale.set(1.1, 0.32, 1.5);
  mound.position.set(0, 0.05, 0.55);
  g.add(mound);

  // Qabr toshi
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.22, 0.36), stoneMat);
  base.position.y = 0.11;
  g.add(base);

  const slab = new THREE.Mesh(new THREE.BoxGeometry(0.78, 1.05, 0.22), stoneMat);
  slab.position.y = 0.68;
  slab.rotation.z = 0.05;
  slab.castShadow = true;
  g.add(slab);

  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.22, 12), stoneMat);
  top.rotation.x = Math.PI / 2;
  top.position.set(-0.02, 1.2, 0);
  g.add(top);

  // "R.I.P." yozuvi
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#788085';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#262a2c';
  ctx.font = 'bold 64px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('R.I.P.', 128, 105);
  ctx.font = 'bold 30px Segoe UI, sans-serif';
  ctx.fillText(epitaph, 128, 165);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.68), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }));
  plaque.position.set(-0.02, 0.82, 0.115);
  plaque.rotation.z = 0.05;
  g.add(plaque);

  group.add(g);
}

/** O'nqir-cho'nqir yog'och ko'prik taxtalari (Rickety Plank Bridge) */
function addPlankBridge(group: THREE.Group, cx: number, cz: number, lenX: number) {
  const plankMat = new THREE.MeshStandardMaterial({ color: '#6e4726', roughness: 0.92 });
  const mudMat = new THREE.MeshStandardMaterial({ color: '#3d2914', roughness: 0.65 });

  const mud = new THREE.Mesh(new THREE.PlaneGeometry(lenX + 1.5, 4.8), mudMat);
  mud.rotation.x = -Math.PI / 2;
  mud.position.set(cx, 0.015, cz);
  group.add(mud);

  const count = Math.floor(lenX / 0.65);
  for (let i = 0; i < count; i++) {
    if (i === Math.floor(count * 0.4)) continue; // tushib qolgan taxta!
    const px = cx - lenX / 2 + i * 0.65 + 0.32;
    const plank = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.06, 3.6), plankMat);
    plank.position.set(px, 0.035, cz + Math.sin(i * 1.7) * 0.08);
    plank.rotation.y = Math.sin(i * 2.3) * 0.06;
    plank.receiveShadow = true;
    group.add(plank);
  }
}

/** 3D qarag'ay daraxti (Pine Tree) yaratish */
function addPineTree(
  group: THREE.Group,
  x: number,
  y: number,
  z: number,
  scale: number,
  trunkMat: THREE.Material,
  leafMat1: THREE.Material,
  leafMat2: THREE.Material,
) {
  const tree = new THREE.Group();
  tree.position.set(x, y, z);
  tree.scale.setScalar(scale);

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.36, 2.4, 7), trunkMat);
  trunk.position.y = 1.2;
  trunk.castShadow = true;
  tree.add(trunk);

  const tiers: [number, number, number, THREE.Material][] = [
    [1.85, 3.2, 3.1, leafMat1],
    [1.45, 2.8, 4.9, leafMat2],
    [0.98, 2.3, 6.4, leafMat1],
  ];
  for (const [r, ch, cy, mat] of tiers) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, ch, 8), mat);
    cone.position.y = cy;
    cone.castShadow = true;
    cone.receiveShadow = true;
    tree.add(cone);
  }
  group.add(tree);
}

/** 3D Kulgili O'rmon Ayig'i ("RV There Yet?" bear hazard/mascots) */
function addBear(group: THREE.Group, x: number, y: number, z: number, yaw: number) {
  const bear = new THREE.Group();
  bear.position.set(x, y, z);
  bear.rotation.y = yaw;

  const furMat = new THREE.MeshStandardMaterial({ color: '#4a2e18', roughness: 0.85 });
  const snoutMat = new THREE.MeshStandardMaterial({ color: '#a67b52', roughness: 0.7 });
  const darkMat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.3 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.48, 0.75, 6, 10), furMat);
  torso.position.y = 1.05;
  torso.castShadow = true;
  bear.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 10), furMat);
  head.position.set(0, 1.78, 0.12);
  bear.add(head);

  const snout = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), snoutMat);
  snout.position.set(0, 1.72, 0.44);
  bear.add(snout);

  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 6), darkMat);
  nose.position.set(0, 1.78, 0.59);
  bear.add(nose);

  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), furMat);
    ear.position.set(sx * 0.28, 2.08, 0.08);
    bear.add(ear);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), darkMat);
    eye.position.set(sx * 0.14, 1.86, 0.44);
    bear.add(eye);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.45, 4, 8), furMat);
    leg.position.set(sx * 0.24, 0.35, 0);
    bear.add(leg);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.45, 4, 8), furMat);
    arm.position.set(sx * 0.52, 1.25, 0.2);
    arm.rotation.x = -0.7;
    arm.rotation.z = sx * -0.3;
    bear.add(arm);
  }
  group.add(bear);
}

/** Yo'l ko'rsatkichi taxtasi ("ROUTE 65", "BEWARE OF BEARS") */
function addRoadSign(group: THREE.Group, x: number, z: number, yaw: number, title: string, sub: string, bg = '#235c3a') {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const postMat = new THREE.MeshStandardMaterial({ color: '#5c3c20', roughness: 0.85 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 2.8, 8), postMat);
  post.position.y = 1.4;
  post.castShadow = true;
  g.add(post);

  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 256);
  ctx.strokeStyle = '#f2e8cf';
  ctx.lineWidth = 14;
  ctx.strokeRect(14, 14, 484, 228);
  ctx.fillStyle = '#fff8e7';
  ctx.font = 'bold 54px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, 256, 110);
  ctx.fillStyle = '#ffd15c';
  ctx.font = 'bold 36px Segoe UI, sans-serif';
  ctx.fillText(sub, 256, 185);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(2.5, 1.25, 0.1),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }),
  );
  board.position.set(0, 2.4, 0);
  board.castShadow = true;
  g.add(board);

  group.add(g);
}

/** Gulxan (Campfire) + yorug'lik */
function addCampfire(group: THREE.Group, x: number, z: number) {
  const cf = new THREE.Group();
  cf.position.set(x, 0.02, z);

  const logMat = new THREE.MeshStandardMaterial({ color: '#4d2e16', roughness: 0.9 });
  const stoneMat = new THREE.MeshStandardMaterial({ color: '#686e70', roughness: 0.9 });
  const fireMat = new THREE.MeshBasicMaterial({ color: '#ff7b1c' });
  const coreMat = new THREE.MeshBasicMaterial({ color: '#ffe055' });

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16, 0), stoneMat);
    st.position.set(Math.cos(a) * 0.52, 0.08, Math.sin(a) * 0.52);
    cf.add(st);
  }
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.85, 6), logMat);
    log.rotation.z = Math.PI / 2;
    log.rotation.y = (i * Math.PI) / 3;
    log.position.y = 0.08;
    cf.add(log);
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.65, 7), fireMat);
  flame.position.y = 0.34;
  cf.add(flame);
  const inner = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 6), coreMat);
  inner.position.y = 0.25;
  cf.add(inner);

  const light = new THREE.PointLight('#ff8c2e', 3.5, 14, 1.5);
  light.position.set(0, 0.8, 0);
  cf.add(light);

  group.add(cf);
}

export function buildWorld(
  scene: THREE.Scene,
  world: WorldDefinition = DEFAULT_WORLD,
  quality: QualityLevel = 'medium',
): WorldHandles {
  if (
    world.mapId === 'forest_sample' ||
    world.mapId === 'forest_assets_preview' ||
    world.mapId === 'forest_square'
  ) {
    return buildForestSampleScene(scene, world, quality);
  }
  const textures = createTextures();
  const mats = {} as Record<MaterialKind, THREE.MeshStandardMaterial>;
  for (const k of Object.keys(textures) as MaterialKind[]) {
    mats[k] = new THREE.MeshStandardMaterial({
      map: textures[k],
      roughness: k === 'metal' ? 0.42 : 0.9,
      metalness: k === 'metal' ? 0.25 : 0,
    });
  }

  const group = new THREE.Group();
  group.name = 'world';
  const logCapMat = new THREE.MeshStandardMaterial({ color: '#cfa36e', roughness: 0.85 });
  const cliffMat = new THREE.MeshStandardMaterial({ color: '#616a6e', roughness: 0.95 });

  // Heightfield Terrain Mesh (Stage 02B): uses the exact same triangle split as physics
  let terrainMat: THREE.MeshStandardMaterial | null = null;
  if (world.terrain.kind === 'heightfield') {
    const meshData = buildTerrainMeshData(world.terrain);
    const terrainGeo = new THREE.BufferGeometry();
    terrainGeo.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    terrainGeo.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(meshData.colors, 3));
    terrainGeo.setAttribute('uv', new THREE.BufferAttribute(meshData.uvs, 2));
    terrainGeo.setIndex(new THREE.BufferAttribute(meshData.indices, 1));

    terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.02,
      flatShading: false,
    });
    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.name = 'heightfield_terrain';
    terrainMesh.receiveShadow = true;
    terrainMesh.castShadow = true;
    group.add(terrainMesh);
  }

  for (const vis of world.visuals) {
    if (vis.batchMode !== 'static_box' || !vis.boxDims || !vis.material) continue;
    const w = vis.boxDims.x;
    const h = vis.boxDims.y;
    const d = vis.boxDims.z;
    const cx = vis.transform.position.x;
    const cy = vis.transform.position.y;
    const cz = vis.transform.position.z;
    const topY = cy + h / 2;
    const mat = vis.material;

    const geo = new THREE.BoxGeometry(w, h, d);
    scaleBoxUVs(geo, w, h, d, TEX_SCALE[mat]);
    const m = new THREE.Mesh(geo, mats[mat]);
    m.position.set(cx, cy, cz);
    m.receiveShadow = vis.receiveShadow;
    m.castShadow = vis.castShadow;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);

    // Yog'och devorlar ('wall') ustiga 3D dumaloq xoda (log) qoplamasi qo'shish
    if (mat === 'wall' && h >= 1.5 && (w >= 2 || d >= 2)) {
      const horizX = w >= d;
      const len = horizX ? w + 0.16 : d + 0.16;
      const rad = Math.min(0.28, (horizX ? d : w) * 0.55);
      const topLog = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 10), mats.wall);
      if (horizX) topLog.rotation.z = Math.PI / 2;
      else topLog.rotation.x = Math.PI / 2;
      topLog.position.set(cx, topY, cz);
      topLog.castShadow = true;
      group.add(topLog);

      // Xoda uchlaridagi kesim doiralari
      for (const s of [-1, 1]) {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.85, rad * 0.85, 0.04, 10), logCapMat);
        if (horizX) {
          cap.rotation.z = Math.PI / 2;
          cap.position.set(cx + s * (len / 2), topY, cz);
        } else {
          cap.rotation.x = Math.PI / 2;
          cap.position.set(cx, topY, cz + s * (len / 2));
        }
        group.add(cap);
      }
    }
  }

  const trunkMat = new THREE.MeshStandardMaterial({ color: '#54351c', roughness: 0.9 });
  const leafMat1 = new THREE.MeshStandardMaterial({ color: '#244d29', roughness: 0.85 });
  const leafMat2 = new THREE.MeshStandardMaterial({ color: '#2f6133', roughness: 0.85 });

  if (world.mapId === 'forest_technical') {
    // Decorate grounded pine tree on the technical terrain fixture
    const treeGroundY = sampleTerrainHeight(world.terrain, -10, 8);
    addPineTree(group, -10, treeGroundY, 8, 1.25, trunkMat, leafMat1, leafMat2);
  }

  if (world.mapId === 'dust_arena') {
    // Tashqi chegaradagi tekis beton devorlarni tabiiy 3D tog' qoyalari bilan bezash
    for (let i = 0; i < 48; i++) {
      const isZWall = i < 28;
      const side = i % 2 === 0 ? 1 : -1;
      const t = isZWall ? ((i / 28) - 0.5) * 96 : (((i - 28) / 20) - 0.5) * 66;
      const rx = isZWall ? t : side * 50.2;
      const rz = isZWall ? side * 35.2 : t;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(2.6 + (i % 3) * 0.9, 1), cliffMat);
      rock.scale.set(1.3, 2.2 + (i % 4) * 0.4, 1.1);
      rock.position.set(rx, 3.2 + (i % 3) * 0.8, rz);
      rock.rotation.set(i * 0.3, i * 0.7, 0);
      rock.receiveShadow = true;
      group.add(rock);
    }

    // Markaziy kulba ("ROUTE 65 RANGER LODGE & GAS") mo'risi, peshtoqi va benzin kolonkalari
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.4, 1.1), cliffMat);
    chimney.position.set(-4.2, 5.2, -3.2);
    chimney.castShadow = true;
    group.add(chimney);

    addRoadSign(group, 0, 4.9, 0, 'RANGER LODGE & GAS', 'ROUTE 65 · COFFEE & BAIT', '#4a2c14');
    addRoadSign(group, 0, -4.9, Math.PI, 'RANGER LODGE & GAS', 'LAST STOP BEFORE MT. YURBUTTSK', '#4a2c14');

    // 2 ta retro qizil benzin kolonkasi (Vintage Gas Pumps)
    const pumpRed = new THREE.MeshStandardMaterial({ color: '#c93026', roughness: 0.45 });
    const pumpWhite = new THREE.MeshStandardMaterial({ color: '#f5efe0', roughness: 0.4 });
    for (const px of [-8.2, 8.2]) {
      const pump = new THREE.Group();
      pump.position.set(px, 0, 2.2);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.65, 1.55, 0.48), pumpRed);
      body.position.y = 0.78;
      body.castShadow = true;
      pump.add(body);
      const dial = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.38, 0.52), pumpWhite);
      dial.position.y = 1.15;
      pump.add(dial);
      const globe = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), new THREE.MeshBasicMaterial({ color: '#ffe484' }));
      globe.position.y = 1.78;
      pump.add(globe);
      group.add(pump);
    }

    // Tuproq yo'l izlari (Off-road Route 65 trail)
    const roadMat = new THREE.MeshStandardMaterial({ color: '#7a5c3c', roughness: 0.98, polygonOffset: true, polygonOffsetFactor: -1 });
    for (const rz of [-22, 0, 22]) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(92, 4.2), roadMat);
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(0, 0.01, rz);
      strip.receiveShadow = true;
      group.add(strip);
    }

    // 4 ta "RV There Yet?" kemper furgonini detallar bilan bezash
    decorateRV(group, -27, 0, 2.7, 7.2, 2.8, 1);
    decorateRV(group, 27, 0, 2.7, 7.2, 2.8, -1);
    decorateRV(group, -22, -24, 2.7, 7.2, 2.8, 1);
    decorateRV(group, 22, 24, 2.7, 7.2, 2.8, -1);

    // Loyli yo'l ustidagi o'nqir-cho'nqir yog'och ko'priklar (Checkpoint 8 Plank Bridges)
    addPlankBridge(group, -15, 0, 8.5);
    addPlankBridge(group, 15, 0, 8.5);
    addPlankBridge(group, 0, 22, 10.5);
    addPlankBridge(group, 0, -22, 10.5);

    // "RV There Yet?" Respawn Qabr toshlari (Checkpoint Gravestones)
    addGravestone(group, -8.5, -4.2, 0.3, 'SHOFYOR BOBUR');
    addGravestone(group, 8.5, 4.2, Math.PI + 0.3, 'USTA VALI');
    addGravestone(group, -41, 10.5, 1.2, 'AYIQ YEDI');
    addGravestone(group, 41, -10.5, -1.9, 'JARLIKKA UCHDI');

    // Lager gulxanlari va yo'l belgilari
    addCampfire(group, -9.5, 0);
    addCampfire(group, 9.5, 0);
    addRoadSign(group, -38, 11, 0.4, 'ROUTE 65 ➔', 'MABUTTS VALLEY: 12 MI', '#1f5c38');
    addRoadSign(group, 38, -11, Math.PI + 0.4, '⬅ ROUTE 65', 'DIQQAT: AYIQLAR BOR!', '#7a2e1d');

    addBear(group, -45, 5, 30, 0.7);
    addBear(group, 45, 5, -30, -2.4);
    addPineTree(group, -45, 5, -30, 1.3, trunkMat, leafMat1, leafMat2);
    addPineTree(group, 45, 5, 30, 1.3, trunkMat, leafMat1, leafMat2);
  }

  // Maydon atrofidagi qalin qarag'ay o'rmoni (130+ daraxt)
  for (let i = 0; i < 135; i++) {
    const a = (i / 135) * Math.PI * 2 + (Math.sin(i * 19.7) * 0.04);
    const ring = i % 3;
    const r = 58 + ring * 18 + (Math.cos(i * 7.3) * 6);
    const tx = Math.cos(a) * r * 1.12;
    const tz = Math.sin(a) * r * 0.88;
    const sc = 1.15 + ((i * 37) % 10) * 0.14;
    addPineTree(group, tx, -0.4, tz, sc, trunkMat, leafMat1, leafMat2);
  }

  // Uzoqdagi qorli tog' cho'qqilari ("Mt. Yurbuttsk" / Wilderness Mountains)
  const rockMat = new THREE.MeshStandardMaterial({ color: '#5c666e', roughness: 0.95 });
  const snowMat = new THREE.MeshStandardMaterial({ color: '#eef5f8', roughness: 0.7 });
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const r = 145 + (i % 3) * 32;
    const h = 38 + (i % 5) * 14;
    const rad = 26 + (i % 4) * 8;
    const mx = Math.cos(a) * r * 1.15;
    const mz = Math.sin(a) * r * 0.95;

    const mt = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 7), rockMat);
    mt.position.set(mx, h / 2 - 2, mz);
    mt.rotation.y = i * 0.9;
    group.add(mt);

    const capH = h * 0.36;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.37, capH, 7), snowMat);
    cap.position.set(mx, h - capH / 2 - 1.8, mz);
    cap.rotation.y = mt.rotation.y;
    group.add(cap);
  }

  const outerGround = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({ color: '#39592a', roughness: 1 }),
  );
  outerGround.rotation.x = -Math.PI / 2;
  outerGround.position.y = world.terrain.kind === 'heightfield' ? -3.2 : -0.6;
  group.add(outerGround);
  scene.add(group);

  // "RV There Yet?" Golden-Hour Mabutts Valley yorug'ligi
  const hemi = new THREE.HemisphereLight('#ffe9c4', '#3f5930', 1.2);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffe6b0', 2.85);
  sun.position.set(42, 62, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -62;
  sc.right = 62;
  sc.top = 48;
  sc.bottom = -48;
  sc.near = 10;
  sc.far = 170;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  // Mabutts Valley Golden-Hour osmoni
  const sunDir = sun.position.clone().normalize();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color('#1f579c') },
      bottom: { value: new THREE.Color('#f0d8b4') },
      sunDir: { value: sunDir },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 bottom;
      uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y * 1.55 + 0.06, 0.0, 1.0);
        vec3 col = mix(bottom, top, pow(h, 0.75));
        float s = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.88, 0.62) * (pow(s, 800.0) * 4.2 + pow(s, 10.0) * 0.32);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  scene.fog = new THREE.Fog('#c8d9cc', 95, 340);

  return {
    sun,
    sky,
    dispose: () => {
      sun.shadow.map?.dispose();
      scene.remove(group);
      scene.remove(hemi);
      scene.remove(sun);
      scene.remove(sun.target);
      scene.remove(sky);
      sky.geometry.dispose();
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      terrainMat?.dispose();
      Object.values(mats).forEach((m) => m.dispose());
      Object.values(textures).forEach((t) => t.dispose());
      skyMat.dispose();
    },
  };
}
