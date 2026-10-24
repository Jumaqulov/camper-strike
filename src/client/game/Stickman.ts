import * as THREE from 'three';
import { RUN_SPEED } from '../../shared/constants';
import type { WeaponId } from '../../shared/weapons';
import { buildGun, type GunModel } from './GunModels';
import { flashTexture } from './Textures';
import { onWeaponAssetsReady } from './WeaponAssetRegistry';
import { CamperBuddyAnimator } from './animation/CamperBuddyAnimator';
import { applyUpperBodyAimPose } from './character/CharacterAimPose';
import {
  instantiateCamperBuddy,
  onCharacterAssetReady,
  preloadCharacterAssets,
  type CamperBuddyInstance,
} from './character/CharacterAssetRegistry';
import { applyTeamColor } from './character/CharacterMaterials';
import { CharacterWeaponMount } from './character/CharacterWeaponMount';

const geoCache = new Map<string, THREE.BufferGeometry>();
function capsule(len: number, r: number): THREE.BufferGeometry {
  const key = `cap:${len}:${r}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.CapsuleGeometry(r, len, 6, 10);
    geoCache.set(key, g);
  }
  return g;
}
function boxGeo(w: number, h: number, d: number): THREE.BufferGeometry {
  const key = `box:${w}:${h}:${d}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    geoCache.set(key, g);
  }
  return g;
}
function cylGeo(rt: number, rb: number, h: number, seg = 10): THREE.BufferGeometry {
  const key = `cyl:${rt}:${rb}:${h}:${seg}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(rt, rb, h, seg);
    geoCache.set(key, g);
  }
  return g;
}
function sphereGeo(r: number, ws = 12, hs = 9): THREE.BufferGeometry {
  const key = `sph:${r}:${ws}:${hs}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.SphereGeometry(r, Math.min(ws, 12), Math.min(hs, 9));
    geoCache.set(key, g);
  }
  return g;
}
function torusGeo(r: number, tube: number, rs = 6, ts = 12): THREE.BufferGeometry {
  const key = `tor:${r}:${tube}:${rs}:${ts}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.TorusGeometry(r, tube, Math.min(rs, 6), Math.min(ts, 12));
    geoCache.set(key, g);
  }
  return g;
}

/** ViewModel bilan moslik uchun silliq mato teksturasi */
const shirtTexCache = new Map<string, THREE.CanvasTexture>();
export function getFlannelTexture(hexColor: string): THREE.CanvasTexture {
  let tex = shirtTexCache.get(hexColor);
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const base = new THREE.Color(hexColor);
  const dark = base.clone().multiplyScalar(0.82);
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, `#${base.getHexString()}`);
  grad.addColorStop(1, `#${dark.getHexString()}`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  shirtTexCache.set(hexColor, tex);
  return tex;
}

// ============== "RV There Yet?" Chubby Bean/Scout Camper Materiallari ==============
export const skinMat = new THREE.MeshStandardMaterial({ color: '#ffcaa3', roughness: 0.42 });
const cheekMat = new THREE.MeshStandardMaterial({ color: '#f5826e', roughness: 0.44 });
const noseMat = new THREE.MeshStandardMaterial({ color: '#ef6654', roughness: 0.38 });
const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.12 });
const pupilMat = new THREE.MeshStandardMaterial({ color: '#12151a', roughness: 0.08 });
const mouthInsideMat = new THREE.MeshStandardMaterial({ color: '#451418', roughness: 0.8 });
const teethMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.2 });
const tongueMat = new THREE.MeshStandardMaterial({ color: '#ec6072', roughness: 0.45 });

const denimMat = new THREE.MeshStandardMaterial({ color: '#2b5b8c', roughness: 0.62 });
const denimDarkMat = new THREE.MeshStandardMaterial({ color: '#1e4269', roughness: 0.65 });
const scoutSashMat = new THREE.MeshStandardMaterial({ color: '#6e4522', roughness: 0.62 });
const bandanaRedMat = new THREE.MeshStandardMaterial({ color: '#e6392e', roughness: 0.48 });
const lifeVestOrangeMat = new THREE.MeshStandardMaterial({ color: '#f26a1b', roughness: 0.52 });
const oliveHatMat = new THREE.MeshStandardMaterial({ color: '#566b3c', roughness: 0.62 });
const cowboyBrownMat = new THREE.MeshStandardMaterial({ color: '#7a441f', roughness: 0.55 });
const leatherBandMat = new THREE.MeshStandardMaterial({ color: '#3b1e0c', roughness: 0.48 });
const yellowCapMat = new THREE.MeshStandardMaterial({ color: '#f5be2e', roughness: 0.45 });
const whiteFoamMat = new THREE.MeshStandardMaterial({ color: '#f7f7f2', roughness: 0.5 });
const brassMat = new THREE.MeshStandardMaterial({ color: '#f5c23b', metalness: 0.78, roughness: 0.22 });
const bootMat = new THREE.MeshStandardMaterial({ color: '#4f2c16', roughness: 0.58 });
const soleMat = new THREE.MeshStandardMaterial({ color: '#1c1815', roughness: 0.85 });
const sockMat = new THREE.MeshStandardMaterial({ color: '#f7f4eb', roughness: 0.65 });

const beardBrownMat = new THREE.MeshStandardMaterial({ color: '#4a2912', roughness: 0.78 });
const beardWalrusMat = new THREE.MeshStandardMaterial({ color: '#7a421b', roughness: 0.78 });
const beardDarkMat = new THREE.MeshStandardMaterial({ color: '#241c18', roughness: 0.8 });
const shadesDarkMat = new THREE.MeshStandardMaterial({ color: '#121820', metalness: 0.88, roughness: 0.12 });
const goggleLensMat = new THREE.MeshStandardMaterial({
  color: '#38bdf8',
  metalness: 0.9,
  roughness: 0.1,
  emissive: '#0284c7',
  emissiveIntensity: 0.4,
});
const emberMat = new THREE.MeshStandardMaterial({
  color: '#ff4800',
  emissive: '#ff3300',
  emissiveIntensity: 1.1,
  roughness: 0.25,
});
const sharedStickmanVertexMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.56,
  metalness: 0.04,
});

let flashTex: THREE.Texture | null = null;

export interface StickmanState {
  speed: number;
  onGround: boolean;
  pitch: number;
  alive: boolean;
  reloading: boolean;
}

/** 08B: DEV diagnostics of one character model (Camper Buddy GLB or the procedural fallback). */
export interface CharacterModelDiag {
  mode: 'buddy' | 'procedural';
  visible: boolean;
  state: string | null;
  weights: Record<string, number>;
  timeScale: number;
  weapon: string | null;
  muzzleWorld: { x: number; y: number; z: number };
  gripWorld: { x: number; y: number; z: number } | null;
}

/** 08B: Camper Buddy GLB visual + its animator / weapon mount (one per Stickman, never shared). */
interface BuddyRig {
  inst: CamperBuddyInstance;
  /** Death/fall transforms are applied here so the clip-driven skeleton stays untouched. */
  pivot: THREE.Group;
  anim: CamperBuddyAnimator;
  mount: CharacterWeaponMount;
  head: THREE.Bone | null;
}

/**
 * "RV There Yet?" (Nuggets Entertainment) uslubidagi baqaloq, silliq "Bean / Russell Scout"
 * karikatura sayohatchilari va 6 xil kreativ yiqilish (o'lim) animatsiyalari!
 */
export class Stickman {
  private static spawnCounter = 0;
  private static deathCounter = 0;

  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private hips = new THREE.Group();
  private bellyGroup = new THREE.Group();
  private chest = new THREE.Group();
  private headGroup = new THREE.Group();
  private pupilL: THREE.Mesh;
  private pupilR: THREE.Mesh;
  private eyeWhiteL: THREE.Mesh;
  private eyeWhiteR: THREE.Mesh;
  private lidL: THREE.Mesh;
  private lidR: THREE.Mesh;
  private browL: THREE.Mesh;
  private browR: THREE.Mesh;
  private jawGroup = new THREE.Group();
  private propeller = new THREE.Group();

  private torsoArchetypes: THREE.Group[] = [];
  private headArchetypes: THREE.Group[] = [];
  private archetype = 0;

  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private kneeL = new THREE.Group();
  private kneeR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private elbowL = new THREE.Group();
  private elbowR = new THREE.Group();
  private gunHolder = new THREE.Group();
  private muzzle = new THREE.Object3D();
  private ejectPort = new THREE.Object3D();
  private gunModel: GunModel | null = null;
  private gunSlide?: THREE.Object3D;
  private gunMag?: THREE.Object3D;
  private unsubWeaponReady: (() => void) | null = null;
  private recoilKick = 0;
  private reloadAnimT = 0;
  private shirtMat: THREE.MeshStandardMaterial;
  private hatMat: THREE.MeshStandardMaterial;
  private flash: THREE.Sprite;
  private flashT = 0;
  private phase = 0;
  private idleT = Math.random() * 10;
  private deathT = 0;
  private deathStyle = 0; // 0: headshot backflip, 1: faceplant, 2: spin-kneel-side, 3: blast cartwheel, 4: left crumple, 5: splits
  private wasAlive = true;
  private weapon: WeaponId | null = null;
  private nameTag: THREE.Sprite | null = null;
  private ownedGeometries: THREE.BufferGeometry[] = [];
  private teamHex: string;
  private buddy: BuddyRig | null = null;
  private unsubCharacterReady: (() => void) | null = null;
  private disposed = false;
  private buddyReloadTilt = 0;

  constructor(color: THREE.ColorRepresentation) {
    const hex = '#' + new THREE.Color(color).getHexString();
    this.teamHex = hex;
    this.shirtMat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55 });
    this.hatMat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.45 });

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material = this.shirtMat, castsShadow = false) => {
      const x = new THREE.Mesh(g, m);
      x.castShadow = castsShadow;
      x.receiveShadow = true;
      return x;
    };

    this.root.add(this.body);
    this.body.add(this.hips);
    this.hips.position.y = 0.76;

    // ==================== 1. "RV THERE YET?" DUMALOQ BEAN/NOKSIMON GAVDA (Overalls & Belly) ====================
    // Silliq dumaloq tos qismi (kombinzon shimi)
    const pelvis = mesh(sphereGeo(0.26, 18, 14), denimMat);
    pelvis.scale.set(1.12, 0.82, 0.98);
    pelvis.position.set(0, 0.02, 0);
    this.hips.add(pelvis);

    // Katta yumaloq qorin (Bean body)
    this.bellyGroup.position.set(0, 0.22, -0.02);
    this.hips.add(this.bellyGroup);

    const bellyBase = mesh(sphereGeo(0.285, 20, 16), this.shirtMat, true);
    bellyBase.scale.set(1.10, 1.05, 1.02);
    this.bellyGroup.add(bellyBase);

    // Klassik Jinsi Kombinzon old fartugi (Denim Overalls Bib + Pocket + Brass Buttons)
    const overallBib = mesh(sphereGeo(0.289, 18, 14), denimMat);
    overallBib.scale.set(1.06, 0.92, 0.96);
    overallBib.position.set(0, -0.03, -0.02);
    this.bellyGroup.add(overallBib);

    const bibPocket = mesh(boxGeo(0.18, 0.14, 0.04), denimDarkMat);
    bibPocket.position.set(0, 0.02, -0.275);
    this.bellyGroup.add(bibPocket);

    // Ko'krak va Yelka guruhi
    this.chest.position.y = 0.40;
    this.hips.add(this.chest);

    const upperBean = mesh(sphereGeo(0.255, 18, 14), this.shirtMat, true);
    upperBean.scale.set(1.16, 0.92, 0.92);
    upperBean.position.set(0, -0.02, 0);
    this.chest.add(upperBean);

    // Kombinzon yelka tasmalari (Overall Straps) va oltin tugmalar
    for (const sx of [-1, 1]) {
      const strap = mesh(torusGeo(0.19, 0.032, 8, 16), denimMat);
      strap.rotation.y = Math.PI / 2;
      strap.scale.set(1.15, 1.2, 0.8);
      strap.position.set(sx * 0.12, 0.01, 0);
      this.chest.add(strap);

      const btn = mesh(cylGeo(0.026, 0.026, 0.018, 12), brassMat);
      btn.rotation.x = Math.PI / 2;
      btn.position.set(sx * 0.12, -0.04, -0.235);
      this.chest.add(btn);
    }

    // Orqa tomonda ixcham yumaloq Kemper Spalnigi (Compact Rolled Sleeping Bag — tanani to'sib qo'ymaydi!)
    const bedroll = mesh(cylGeo(0.085, 0.085, 0.36, 14), lifeVestOrangeMat);
    bedroll.rotation.z = Math.PI / 2;
    bedroll.position.set(0, -0.10, 0.25);
    this.chest.add(bedroll);
    for (const sx of [-1, 1]) {
      const rollStrap = mesh(cylGeo(0.089, 0.089, 0.028, 12), leatherBandMat);
      rollStrap.rotation.z = Math.PI / 2;
      rollStrap.position.set(sx * 0.10, -0.10, 0.25);
      this.chest.add(rollStrap);
    }

    // ==================== 2. "RV THERE YET?" KATTA DUMALOQ BOSH VA IFODALI YUZ ====================
    this.headGroup.position.set(0, 0.33, -0.01);
    this.headGroup.scale.setScalar(1.32);
    this.chest.add(this.headGroup);

    // Keng dumaloq "Russell / RV Guy" bosh shakli
    const headSphere = mesh(sphereGeo(0.205, 22, 18), skinMat, true);
    headSphere.scale.set(1.15, 0.96, 1.02);
    headSphere.position.set(0, 0.02, 0);
    this.headGroup.add(headSphere);

    // Do'mboq qizil yonoqlar va dumaloq quloqlar
    for (const sx of [-1, 1]) {
      const cheek = mesh(sphereGeo(0.082, 14, 12), cheekMat);
      cheek.scale.set(1.15, 0.9, 0.85);
      cheek.position.set(sx * 0.135, -0.025, -0.135);
      this.headGroup.add(cheek);

      const ear = mesh(sphereGeo(0.055, 12, 10), skinMat);
      ear.scale.set(0.55, 1.1, 0.9);
      ear.position.set(sx * 0.225, 0.01, -0.01);
      this.headGroup.add(ear);
    }

    // Katta yonma-yon Oq Karikatura Ko'zlari + Yaltiroq Qorachiqlar
    this.eyeWhiteL = mesh(sphereGeo(0.062, 16, 14), eyeWhiteMat);
    this.eyeWhiteL.scale.set(1.05, 1.18, 0.72);
    this.eyeWhiteL.position.set(-0.068, 0.042, -0.175);

    this.eyeWhiteR = mesh(sphereGeo(0.062, 16, 14), eyeWhiteMat);
    this.eyeWhiteR.scale.set(1.05, 1.18, 0.72);
    this.eyeWhiteR.position.set(0.068, 0.042, -0.175);
    this.headGroup.add(this.eyeWhiteL, this.eyeWhiteR);

    this.pupilL = mesh(sphereGeo(0.030, 12, 10), pupilMat);
    this.pupilL.position.set(-0.066, 0.042, -0.215);
    this.pupilR = mesh(sphereGeo(0.030, 12, 10), pupilMat);
    this.pupilR.position.set(0.066, 0.042, -0.215);
    this.headGroup.add(this.pupilL, this.pupilR);

    // Ko'z qovoqlari va qalin ifodali qoshlar
    this.lidL = mesh(boxGeo(0.11, 0.026, 0.045), skinMat);
    this.lidL.position.set(-0.068, 0.092, -0.19);
    this.lidR = mesh(boxGeo(0.11, 0.026, 0.045), skinMat);
    this.lidR.position.set(0.068, 0.092, -0.19);
    this.headGroup.add(this.lidL, this.lidR);

    this.browL = mesh(capsule(0.065, 0.018), beardBrownMat);
    this.browL.rotation.z = Math.PI / 2 + 0.14;
    this.browL.position.set(-0.072, 0.115, -0.192);
    this.browR = mesh(capsule(0.065, 0.018), beardBrownMat);
    this.browR.rotation.z = Math.PI / 2 - 0.14;
    this.browR.position.set(0.072, 0.115, -0.192);
    this.headGroup.add(this.browL, this.browR);

    // Katta dumaloq kulgili "Kartoshka Burun"
    const nose = mesh(sphereGeo(0.056, 14, 12), noseMat);
    nose.scale.set(1.18, 0.95, 1.05);
    nose.position.set(0, 0.002, -0.228);
    this.headGroup.add(nose);

    // Harakatlanuvchi Og'iz va Jag'
    this.jawGroup.position.set(0, -0.058, -0.02);
    this.headGroup.add(this.jawGroup);

    const mouthHole = mesh(sphereGeo(0.068, 12, 10), mouthInsideMat);
    mouthHole.scale.set(1.25, 0.65, 0.55);
    mouthHole.position.set(0, -0.008, -0.175);
    this.jawGroup.add(mouthHole);

    const teeth = mesh(boxGeo(0.075, 0.026, 0.022), teethMat);
    teeth.position.set(0, -0.048, -0.192);
    this.headGroup.add(teeth);

    const tongue = mesh(sphereGeo(0.036, 10, 8), tongueMat);
    tongue.scale.set(1.2, 0.5, 0.9);
    tongue.position.set(0, -0.026, -0.180);
    this.jawGroup.add(tongue);

    // ==================== 3. OLTI XIL "RV THERE YET?" SHLYAPA, KO'ZOYNAK VA KIYIM ARXETIPLARI ====================
    this.buildSixArchetypes(mesh);

    // ==================== 4. DUMALOQ QO'LLAR VA QO'LQOPSIMON KAFTLAR ====================
    for (const [arm, elbow, sx] of [
      [this.armR, this.elbowR, 1],
      [this.armL, this.elbowL, -1],
    ] as const) {
      arm.position.set(sx * 0.27, 0.04, 0);
      this.chest.add(arm);

      const upperArm = mesh(capsule(0.16, 0.082), this.shirtMat);
      upperArm.position.y = -0.11;
      arm.add(upperArm);

      elbow.position.y = -0.22;
      arm.add(elbow);

      const forearm = mesh(capsule(0.16, 0.070), skinMat);
      forearm.position.y = -0.11;
      elbow.add(forearm);

      // Dumaloq multfilm kaft (Mitten hand)
      const hand = mesh(sphereGeo(0.078, 12, 10), skinMat);
      hand.scale.set(0.95, 1.1, 0.95);
      hand.position.set(0, -0.23, 0);
      elbow.add(hand);
    }
    this.armR.rotation.set(1.18, -0.12, -0.18);
    this.elbowR.rotation.x = 0.45;
    this.armL.rotation.set(1.24, 0.28, 0.44);
    this.elbowL.rotation.x = 0.40;

    // ==================== 5. KALTA BAQALOQ OYOQLAR VA TOG' ETIKLARI ====================
    for (const [leg, knee, sx] of [
      [this.legR, this.kneeR, 1],
      [this.legL, this.kneeL, -1],
    ] as const) {
      leg.position.set(sx * 0.135, -0.04, 0);
      this.hips.add(leg);

      const thigh = mesh(capsule(0.18, 0.112), denimMat);
      thigh.position.y = -0.14;
      leg.add(thigh);

      knee.position.y = -0.28;
      leg.add(knee);

      const sock = mesh(cylGeo(0.088, 0.082, 0.18, 12), sockMat);
      sock.position.y = -0.10;
      knee.add(sock);

      const sockStripe = mesh(cylGeo(0.090, 0.090, 0.028, 12), bandanaRedMat);
      sockStripe.position.y = -0.05;
      knee.add(sockStripe);

      // Dumaloq tog' etiklari (Chunky Rounded Hiking Boots)
      const boot = mesh(capsule(0.14, 0.095), bootMat);
      boot.rotation.x = Math.PI / 2;
      boot.scale.set(1.05, 1.0, 0.85);
      boot.position.set(0, -0.23, -0.045);
      knee.add(boot);

      const sole = mesh(boxGeo(0.19, 0.04, 0.29), soleMat);
      sole.position.set(0, -0.30, -0.045);
      knee.add(sole);
    }

    // Qurol ushlagich — qo'llar o'rtasida aniq va tabiiy ushlab turiladi
    this.gunHolder.position.set(0.08, -0.02, -0.44);
    this.chest.add(this.gunHolder);
    flashTex ??= flashTexture();
    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.flash.scale.setScalar(0.65);
    this.flash.visible = false;

    this.mergeStaticBoneMeshes();
    this.setArchetype(Stickman.spawnCounter++ % 6);

    // 08B: Camper Buddy GLB replaces the procedural body once loaded; until then (or on failure) the
    // procedural camper stays visible, so the game never waits on the character asset.
    void preloadCharacterAssets();
    this.unsubCharacterReady = onCharacterAssetReady(() => this.attachBuddy());
  }

  /** 08B: swaps the procedural body for a Camper Buddy instance (own skeleton, own team material). */
  private attachBuddy(): void {
    if (this.buddy || this.disposed) return;
    const inst = instantiateCamperBuddy();
    if (!inst) return;
    const socket = inst.sockets.get('Hand_R_Grip');
    if (!socket) {
      inst.dispose();
      return;
    }
    const pivot = new THREE.Group();
    pivot.name = 'camper_buddy_pivot';
    pivot.add(inst.root);
    this.root.add(pivot);
    const anim = new CamperBuddyAnimator(inst.root, inst.clips);
    const mount = new CharacterWeaponMount(socket, inst.root);
    this.buddy = { inst, pivot, anim, mount, head: inst.bones.get('Head') ?? null };
    applyTeamColor(inst, this.teamHex);
    this.body.visible = false;
    // Re-mount the current weapon into the hand socket.
    const w = this.weapon;
    this.weapon = null;
    this.gunModel = null;
    this.setWeapon(w);
  }

  /** Where the 3P gun, muzzle, eject port and flash live: the hand socket mount, or the chest holder. */
  private gunParent(): THREE.Group {
    return this.buddy ? this.buddy.mount.holder : this.gunHolder;
  }

  /** 08B: true while the Camper Buddy GLB (not the procedural fallback) renders this player. */
  usesCharacterAsset(): boolean {
    return this.buddy !== null;
  }

  /** 08B: one-shot Interact clip (container open). No-op on the procedural fallback. */
  playInteract(): void {
    this.buddy?.anim.playInteract();
  }

  getCharacterDiagnostics(): CharacterModelDiag {
    const muzzle = this.muzzle.getWorldPosition(new THREE.Vector3());
    const b = this.buddy;
    let gripWorld: CharacterModelDiag['gripWorld'] = null;
    if (b) {
      const g = b.mount.holder.parent?.getWorldPosition(new THREE.Vector3());
      if (g) gripWorld = { x: g.x, y: g.y, z: g.z };
    }
    const d = b?.anim.getDiagnostics();
    return {
      mode: b ? 'buddy' : 'procedural',
      visible: this.root.visible,
      state: d?.state ?? null,
      weights: d?.weights ?? {},
      timeScale: d?.timeScale ?? 1,
      weapon: this.weapon,
      muzzleWorld: { x: muzzle.x, y: muzzle.y, z: muzzle.z },
      gripWorld,
    };
  }

  /**
   * Merges static non-team-colored sibling meshes within each rigid bone group
   * into a single vertex-colored Mesh to reduce per-character draw calls by ~65%.
   */
  private mergeStaticBoneMeshes(): void {
    const dynamicMeshes = new Set<THREE.Object3D>([
      this.pupilL,
      this.pupilR,
      this.eyeWhiteL,
      this.eyeWhiteR,
      this.lidL,
      this.lidR,
      this.browL,
      this.browR,
    ]);

    const boneGroups: THREE.Group[] = [
      this.hips,
      this.bellyGroup,
      this.chest,
      this.headGroup,
      this.jawGroup,
      this.propeller,
      this.elbowL,
      this.elbowR,
      this.kneeL,
      this.kneeR,
      ...this.torsoArchetypes,
      ...this.headArchetypes,
    ];

    for (const grp of boneGroups) {
      const mergeable: THREE.Mesh[] = [];
      for (const child of grp.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        if (dynamicMeshes.has(child)) continue;
        if (
          child.material === this.shirtMat ||
          child.material === this.hatMat ||
          child.material === goggleLensMat ||
          child.material === emberMat
        ) {
          continue;
        }
        mergeable.push(child);
      }
      if (mergeable.length < 2) continue;

      let totalVerts = 0;
      let castsShadow = false;
      const bakedParts: { geo: THREE.BufferGeometry; color: THREE.Color }[] = [];

      for (const m of mergeable) {
        m.updateMatrix();
        const ni = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        ni.applyMatrix4(m.matrix);
        if (!ni.getAttribute('normal')) ni.computeVertexNormals();
        totalVerts += ni.getAttribute('position').count;
        if (m.castShadow) castsShadow = true;
        const stdMat = m.material as THREE.MeshStandardMaterial;
        bakedParts.push({ geo: ni, color: stdMat.color ? stdMat.color.clone() : new THREE.Color('#ffffff') });
      }

      const positions = new Float32Array(totalVerts * 3);
      const normals = new Float32Array(totalVerts * 3);
      const colors = new Float32Array(totalVerts * 3);
      let offset = 0;

      for (const part of bakedParts) {
        const pos = part.geo.getAttribute('position');
        const norm = part.geo.getAttribute('normal');
        const count = pos.count;
        for (let i = 0; i < count; i++) {
          const dst = (offset + i) * 3;
          positions[dst] = pos.getX(i);
          positions[dst + 1] = pos.getY(i);
          positions[dst + 2] = pos.getZ(i);
          normals[dst] = norm ? norm.getX(i) : 0;
          normals[dst + 1] = norm ? norm.getY(i) : 1;
          normals[dst + 2] = norm ? norm.getZ(i) : 0;
          colors[dst] = part.color.r;
          colors[dst + 1] = part.color.g;
          colors[dst + 2] = part.color.b;
        }
        offset += count;
        part.geo.dispose();
      }

      const mergedGeo = new THREE.BufferGeometry();
      mergedGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      mergedGeo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      mergedGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      mergedGeo.computeBoundingSphere();
      this.ownedGeometries.push(mergedGeo);

      for (const m of mergeable) {
        grp.remove(m);
      }

      const mergedMesh = new THREE.Mesh(mergedGeo, sharedStickmanVertexMat);
      mergedMesh.castShadow = castsShadow;
      mergedMesh.receiveShadow = true;
      grp.add(mergedMesh);
    }
  }

  private buildSixArchetypes(mesh: (g: THREE.BufferGeometry, m?: THREE.Material) => THREE.Mesh): void {
    for (let i = 0; i < 6; i++) {
      const tg = new THREE.Group();
      const hg = new THREE.Group();
      this.chest.add(tg);
      this.headGroup.add(hg);
      this.torsoArchetypes.push(tg);
      this.headArchetypes.push(hg);
    }

    // =========================================================================
    // 0: KLASSIK "RV TRUCKER" (Baland Trucker Kepka + Qora Ko'zoynak + Katta Mo'ylov)
    // =========================================================================
    {
      const hg = this.headArchetypes[0];
      const crown = mesh(sphereGeo(0.212, 16, 12), this.hatMat);
      crown.scale.set(1.14, 0.88, 1.05);
      crown.position.set(0, 0.11, 0.01);
      const foamFront = mesh(boxGeo(0.24, 0.13, 0.06), whiteFoamMat);
      foamFront.position.set(0, 0.14, -0.175);
      foamFront.rotation.x = -0.15;
      const patch = mesh(boxGeo(0.12, 0.055, 0.02), bandanaRedMat);
      patch.position.set(0, 0.145, -0.205);
      patch.rotation.x = -0.15;
      const visor = mesh(cylGeo(0.19, 0.19, 0.024, 16), this.hatMat);
      visor.scale.set(1.05, 1, 0.82);
      visor.position.set(0, 0.085, -0.22);
      visor.rotation.x = 0.12;
      hg.add(crown, foamFront, patch, visor);

      // Qora quyosh ko'zoynagi va baroq mo'ylov
      const shadesBar = mesh(boxGeo(0.32, 0.022, 0.03), shadesDarkMat);
      shadesBar.position.set(0, 0.062, -0.225);
      hg.add(shadesBar);
      for (const sx of [-1, 1]) {
        const lens = mesh(boxGeo(0.115, 0.068, 0.026), shadesDarkMat);
        lens.position.set(sx * 0.078, 0.044, -0.225);
        hg.add(lens);
      }
      for (const sx of [-1, 1]) {
        const stache = mesh(capsule(0.08, 0.028), beardBrownMat);
        stache.rotation.z = Math.PI / 2 + sx * 0.32;
        stache.position.set(sx * 0.055, -0.035, -0.218);
        hg.add(stache);
      }
    }

    // =========================================================================
    // 1: WILDERNESS SCOUT ("Up" Russell / RV Scout — Sariq Skaut Kepka + Qizil Galstuk + Nishonli Lenta)
    // =========================================================================
    {
      const tg = this.torsoArchetypes[1];
      const hg = this.headArchetypes[1];

      // Bo'yindagi qizil skaut galstugi (Neckerchief bandana) + oltin halqa
      const bandana = mesh(torusGeo(0.17, 0.042, 8, 16), bandanaRedMat);
      bandana.rotation.x = Math.PI / 2 + 0.15;
      bandana.position.set(0, 0.14, -0.02);
      const tail = mesh(cylGeo(0.05, 0.01, 0.14, 8), bandanaRedMat);
      tail.position.set(0, 0.06, -0.22);
      const woggle = mesh(cylGeo(0.026, 0.026, 0.025, 10), brassMat);
      woggle.position.set(0, 0.10, -0.21);
      // Skaut nishonlari taqilgan ko'ndalang tasma (Merit Badge Sash)
      const sash = mesh(torusGeo(0.285, 0.036, 8, 18), scoutSashMat);
      sash.rotation.y = 0.45;
      sash.rotation.x = 0.75;
      sash.position.set(0, -0.10, -0.02);
      tg.add(bandana, tail, woggle, sash);

      // Sariq skaut kepkasi
      const cap = mesh(sphereGeo(0.21, 16, 12), yellowCapMat);
      cap.scale.set(1.14, 0.82, 1.04);
      cap.position.set(0, 0.11, 0);
      const bill = mesh(cylGeo(0.18, 0.18, 0.022, 16), yellowCapMat);
      bill.scale.set(1.0, 1, 0.78);
      bill.position.set(0, 0.085, -0.21);
      hg.add(cap, bill);
    }

    // =========================================================================
    // 2: PROPELLERLI SHAPKALI QUвноQ KEMPER (Spinning Propeller Beanie + Dumaloq Ko'zoynak)
    // =========================================================================
    {
      const hg = this.headArchetypes[2];
      const beanie = mesh(sphereGeo(0.212, 16, 12), yellowCapMat);
      beanie.scale.set(1.15, 0.84, 1.04);
      beanie.position.set(0, 0.105, 0);
      const stripe = mesh(cylGeo(0.235, 0.238, 0.045, 16), bandanaRedMat);
      stripe.position.set(0, 0.09, 0);
      const stem = mesh(cylGeo(0.015, 0.015, 0.06, 8), brassMat);
      stem.position.set(0, 0.26, 0);
      hg.add(beanie, stripe, stem);

      // Aylanadigan 3D Parrak (Propeller)
      this.propeller.position.set(0, 0.285, 0);
      const blade = mesh(boxGeo(0.26, 0.012, 0.036), bandanaRedMat);
      const hub = mesh(sphereGeo(0.024, 8, 8), brassMat);
      this.propeller.add(blade, hub);
      hg.add(this.propeller);

      // Qalin dumaloq ko'zoynaklar
      for (const sx of [-1, 1]) {
        const rim = mesh(torusGeo(0.068, 0.014, 8, 16), shadesDarkMat);
        rim.position.set(sx * 0.072, 0.042, -0.215);
        hg.add(rim);
      }
    }

    // =========================================================================
    // 3: KOVBOY KEMPER (Keng Kovboy Shlyapasi + Oltin Sherif Yulduzi + Uzun Mo'ylov)
    // =========================================================================
    {
      const tg = this.torsoArchetypes[3];
      const hg = this.headArchetypes[3];

      // Ko'krakda oltin Sherif yulduzi
      const star = mesh(cylGeo(0.048, 0.048, 0.015, 6), brassMat);
      star.rotation.x = Math.PI / 2;
      star.position.set(-0.10, 0.04, -0.245);
      tg.add(star);

      // Keng Kovboy Shlyapasi
      const brim = mesh(cylGeo(0.36, 0.36, 0.022, 20), cowboyBrownMat);
      brim.scale.set(1.08, 1, 0.95);
      brim.position.set(0, 0.10, 0);
      const crown = mesh(cylGeo(0.17, 0.20, 0.17, 16), cowboyBrownMat);
      crown.position.set(0, 0.18, 0);
      const band = mesh(cylGeo(0.202, 0.204, 0.032, 16), leatherBandMat);
      band.position.set(0, 0.115, 0);
      hg.add(brim, crown, band);

      // Osilgan katta kovboy mo'ylovi
      for (const sx of [-1, 1]) {
        const walrus = mesh(capsule(0.09, 0.032), beardWalrusMat);
        walrus.rotation.z = Math.PI / 2 - sx * 0.42;
        walrus.position.set(sx * 0.058, -0.042, -0.215);
        hg.add(walrus);
      }
    }

    // =========================================================================
    // 4: BALIQCHI / REYNJER KEMPER (Panarama Bucket Shlyapa + To'q Sariq Nimcha + Sigara)
    // =========================================================================
    {
      const tg = this.torsoArchetypes[4];
      const hg = this.headArchetypes[4];

      // To'q sariq qutqaruv / baliqchi nimchasi
      const vest = mesh(sphereGeo(0.268, 16, 12), lifeVestOrangeMat);
      vest.scale.set(1.16, 0.88, 0.94);
      vest.position.set(0, -0.02, 0);
      tg.add(vest);

      // Baliqchi panama shlyapasi (Bucket Hat)
      const brim = mesh(cylGeo(0.29, 0.33, 0.045, 18), oliveHatMat);
      brim.position.set(0, 0.10, 0);
      const top = mesh(cylGeo(0.19, 0.21, 0.13, 16), oliveHatMat);
      top.position.set(0, 0.16, 0);
      const band = mesh(cylGeo(0.212, 0.212, 0.025, 16), bandanaRedMat);
      band.position.set(0, 0.115, 0);
      // Og'zida tutab turgan sigaret/sigara
      const cig = mesh(cylGeo(0.012, 0.012, 0.09, 8), whiteFoamMat);
      cig.rotation.x = Math.PI / 2 + 0.15;
      cig.rotation.z = -0.25;
      cig.position.set(0.045, -0.055, -0.235);
      const ember = mesh(sphereGeo(0.014, 8, 8), emberMat);
      ember.position.set(0.058, -0.062, -0.278);
      hg.add(brim, top, band, cig, ember);
    }

    // =========================================================================
    // 5: TOG' CHANG'ICHI KEMPER (Bublikli Qishki Shapka + Chang'i Ko'zoynagi + Qalin Soqol)
    // =========================================================================
    {
      const hg = this.headArchetypes[5];

      // Qishki to'qima shapka (Beanie) + Oq Pom-Pom
      const cuff = mesh(cylGeo(0.232, 0.232, 0.065, 16), this.hatMat);
      cuff.position.set(0, 0.10, 0);
      const dome = mesh(sphereGeo(0.215, 16, 12), this.hatMat);
      dome.scale.set(1.08, 0.95, 1.02);
      dome.position.set(0, 0.14, 0);
      const pom = mesh(sphereGeo(0.055, 12, 10), whiteFoamMat);
      pom.position.set(0, 0.32, 0);

      // Peshonada katta ko'k Chang'i Ko'zoynagi (Ski Goggles)
      const goggleFrame = mesh(boxGeo(0.27, 0.085, 0.045), shadesDarkMat);
      goggleFrame.position.set(0, 0.135, -0.205);
      const goggleGlass = mesh(boxGeo(0.24, 0.065, 0.050), goggleLensMat);
      goggleGlass.position.set(0, 0.135, -0.205);

      // Qalin dumaloq soqol
      const beard = mesh(sphereGeo(0.185, 14, 12), beardDarkMat);
      beard.scale.set(1.18, 0.85, 0.95);
      beard.position.set(0, -0.065, -0.065);
      hg.add(cuff, dome, pom, goggleFrame, goggleGlass, beard);
    }
  }

  /** Personaj arxetipini (0..5) almashtiradi */
  setArchetype(index: number): void {
    this.archetype = ((index % 6) + 6) % 6;
    for (let i = 0; i < 6; i++) {
      const vis = i === this.archetype;
      this.torsoArchetypes[i].visible = vis;
      this.headArchetypes[i].visible = vis;
    }
  }

  /** ID yoki nom xeshiga qarab arxetip tayinlaydi */
  setArchetypeFromId(id: string): void {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    this.setArchetype(Math.abs(hash) % 6);
  }

  /**
   * O'lim holatiga qarab kreativ yiqilish animatsiyasini tanlaydi:
   * - Boshiga o'q tegsa (headshot): 0 (boshi orqaga ketib, orqaga uchib yiqilish)
   * - Granata yoki Drobovik: 3 (havoda charxpalak / salto bo'lib uchib ketish)
   * - Boshqa holatlarda: 1 (oldinga faceplant), 2 (aylanib tiz cho'kib yonboshga qulash),
   *   4 (chap yonboshga g'ujanak bo'lib yiqilish), 5 (oyoqlari shpagat ketib yuztuban qulash)
   */
  triggerDeath(headshot: boolean, weapon?: WeaponId | 'grenade'): void {
    this.deathT = 0.001;
    if (headshot) {
      this.deathStyle = 0;
    } else if (weapon === 'grenade' || weapon === 'shotgun') {
      this.deathStyle = 3;
    } else {
      const styles = [1, 2, 4, 5];
      this.deathStyle = styles[Stickman.deathCounter++ % styles.length];
    }
  }

  setColor(color: THREE.ColorRepresentation): void {
    const hex = '#' + new THREE.Color(color).getHexString();
    this.teamHex = hex;
    this.shirtMat.color.set(hex);
    this.hatMat.color.set(hex);
    if (this.buddy) applyTeamColor(this.buddy.inst, hex);
  }

  setWeapon(w: WeaponId | null): void {
    if (this.weapon === w && (w === null || this.gunModel !== null)) return;
    this.weapon = w;
    this.unsubWeaponReady?.();
    this.unsubWeaponReady = null;
    this.gunHolder.clear();
    const holder = this.gunParent();
    holder.clear();
    this.buddy?.mount.setWeapon(w);
    if (!w) {
      this.gunModel = null;
      this.gunSlide = undefined;
      this.gunMag = undefined;
      holder.visible = false;
      return;
    }
    holder.visible = true;
    this.armR.rotation.set(1.18, -0.12, -0.18);
    this.elbowR.rotation.x = 0.45;
    this.armL.rotation.set(1.24, 0.28, 0.44);
    this.elbowL.rotation.x = 0.40;
    const gun = buildGun(w, '3p');
    this.gunModel = gun;
    const scale3P = 1.32;
    gun.group.scale.setScalar(scale3P);
    holder.add(gun.group);
    this.gunSlide = gun.slide;
    this.gunMag = gun.mag;
    const syncAnchors = () => {
      gun.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = false;
      });
      this.muzzle.position.copy(gun.muzzle).multiplyScalar(scale3P);
      this.ejectPort.position.copy(gun.ejectPort).multiplyScalar(scale3P);
      this.flash.position.copy(this.muzzle.position);
    };
    syncAnchors();
    holder.add(this.muzzle);
    holder.add(this.ejectPort);
    holder.add(this.flash);
    this.unsubWeaponReady = onWeaponAssetsReady(() => syncAnchors());
  }

  setNameTag(name: string | null, color = '#ffffff', showSprite = true): void {
    if (this.nameTag) {
      this.root.remove(this.nameTag);
      (this.nameTag.material as THREE.SpriteMaterial).map?.dispose();
      this.nameTag.material.dispose();
      this.nameTag = null;
    }
    if (!name) return;
    this.setArchetypeFromId(name);
    if (!showSprite) return;

    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const g = c.getContext('2d')!;
    g.font = 'bold 28px Segoe UI, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(0,0,0,0.82)';
    g.strokeText(name, 128, 32);
    g.fillStyle = color;
    g.fillText(name, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    s.scale.set(1.12, 0.28, 1);
    s.position.y = 2.18;
    s.renderOrder = 10;
    this.root.add(s);
    this.nameTag = s;
  }

  updateNameTagDistance(distToCamera: number, alive = true): void {
    if (!this.nameTag) return;
    if (!alive || distToCamera > 36 || distToCamera < 0.9) {
      this.nameTag.visible = false;
      return;
    }
    this.nameTag.visible = true;
    const fade = 1 - THREE.MathUtils.smoothstep(distToCamera, 22, 36);
    const mat = this.nameTag.material as THREE.SpriteMaterial;
    mat.opacity = fade * 0.92;
    const sc = THREE.MathUtils.clamp(0.82 + distToCamera * 0.014, 0.85, 1.28);
    this.nameTag.scale.set(1.12 * sc, 0.28 * sc, 1);
  }

  muzzleFlash(): void {
    this.flashT = 0.055;
    this.flash.visible = true;
    this.flash.material.rotation = Math.random() * Math.PI;
    this.recoilKick = 1.0;
  }

  getMuzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  getEjectWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.ejectPort.getWorldPosition(out);
  }

  update(dt: number, s: StickmanState): void {
    this.idleT += dt;
    this.propeller.rotation.y += dt * (4 + s.speed * 2.5);
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.flash.visible = false;
    }
    if (this.nameTag) this.nameTag.visible = s.alive;

    // ==================== O'LIM HOLATI: Qurol qo'ldan tushadi va 6 xil kreativ yiqilish! ====================
    if (!s.alive) {
      if (this.wasAlive && this.deathT === 0) {
        const styles = [1, 2, 4, 5];
        this.deathStyle = styles[Stickman.deathCounter++ % styles.length];
      }
      this.wasAlive = false;
      // O'lgan zahoti qo'lidagi qurol yo'qoladi (chunki qurol fizik tarzda yerga tushib ketadi!)
      this.gunHolder.visible = false;
      this.gunParent().visible = false;
      this.flash.visible = false;
      this.buddy?.anim.freeze();

      this.deathT = Math.min(1, this.deathT + dt * 2.2);
      const t = this.deathT;
      const k = 1 - Math.pow(1 - t, 3);
      this.chest.rotation.set(0, 0, 0);
      this.hips.rotation.set(0, 0, 0);
      this.hips.position.y = 0.76;
      this.pupilL.position.set(-0.042, 0.055, -0.215);
      this.pupilR.position.set(0.042, 0.025, -0.215);
      this.jawGroup.rotation.x = k * 0.35;

      switch (this.deathStyle) {
        case 0: {
          // 0: HEADSHOT BACKFLIP — Boshiga o'q tekkanda boshi keskin orqaga ketib, orqaga uchib tushadi!
          const hop = Math.sin(t * Math.PI) * 0.65;
          this.body.position.set(0, hop - k * 0.42, k * 0.55);
          this.body.rotation.set(k * Math.PI * 0.48, k * 0.25, Math.sin(k * Math.PI) * 0.18);
          this.headGroup.rotation.set(k * 0.55, k * 0.45, -k * 0.35);
          this.armL.rotation.set(-2.2 * k, 0, 0.9 * k);
          this.armR.rotation.set(-2.4 * k, 0, -0.95 * k);
          this.legL.rotation.set(-0.75 * k, 0, 0.35 * k);
          this.legR.rotation.set(0.25 * k, 0, -0.40 * k);
          this.kneeL.rotation.x = -0.6 * k;
          this.kneeR.rotation.x = -0.2 * k;
          break;
        }
        case 1: {
          // 1: FACEPLANT FORWARD — Oldinga qoqilib, yuzi va qorni bilan yerga ("faceplant") yiqiladi!
          const stumble = Math.sin(t * Math.PI) * 0.28;
          this.body.position.set(0, stumble - k * 0.46, -k * 0.48);
          this.body.rotation.set(-k * Math.PI * 0.48, 0, 0);
          this.headGroup.rotation.set(-k * 0.25, k * 0.55, 0);
          // Qo'llar qurbaqadek ikki tomonga yozilib qoladi
          this.armL.rotation.set(-0.4 * k, 0, 1.35 * k);
          this.armR.rotation.set(-0.4 * k, 0, -1.35 * k);
          this.elbowL.rotation.x = 0.8 * k;
          this.elbowR.rotation.x = 0.8 * k;
          this.legL.rotation.set(0.35 * k, 0, 0.32 * k);
          this.legR.rotation.set(0.15 * k, 0, -0.35 * k);
          this.kneeL.rotation.x = -0.75 * k;
          this.kneeR.rotation.x = -0.35 * k;
          break;
        }
        case 2: {
          // 2: DRAMATIC SPIN & SIDE COLLAPSE — 270 gradusga aylanib, tiz cho'kib, o'ng yonboshga qulaydi!
          const kneelPhase = Math.min(1, t * 2.0);
          const fallPhase = Math.max(0, (t - 0.35) / 0.65);
          const fk = 1 - Math.pow(1 - fallPhase, 2);
          this.body.rotation.y = k * Math.PI * 1.35;
          this.body.rotation.z = -fk * Math.PI * 0.47;
          this.body.rotation.x = -kneelPhase * 0.22;
          this.body.position.set(fk * 0.32, -kneelPhase * 0.22 - fk * 0.24, 0);
          this.armR.rotation.set(0.6, 0, -0.5 * k);
          this.armL.rotation.set(-1.5 * fk, 0, 1.1 * fk);
          this.legL.rotation.x = 0.65 * kneelPhase;
          this.legR.rotation.x = 0.45 * kneelPhase;
          this.kneeL.rotation.x = -1.45 * kneelPhase;
          this.kneeR.rotation.x = -1.25 * kneelPhase;
          break;
        }
        case 3: {
          // 3: EXPLOSION / SHOTGUN CARTWHEEL — Havoga baland uchib, charxpalak aylanib qorintuban tushadi!
          const arc = Math.sin(t * Math.PI) * 1.25;
          this.body.position.set(k * 0.35, arc - k * 0.45, k * 0.45);
          this.body.rotation.set(-k * Math.PI * 1.48, k * 1.2, k * Math.PI * 0.22);
          const flail = Math.sin(t * 22) * (1 - t) * 0.6;
          this.armL.rotation.set(-2.4 * k + flail, 0, 1.2 * k);
          this.armR.rotation.set(-2.1 * k - flail, 0, -1.2 * k);
          this.legL.rotation.set(-0.6 * k - flail, 0, 0.45 * k);
          this.legR.rotation.set(0.5 * k + flail, 0, -0.45 * k);
          break;
        }
        case 4: {
          // 4: LEFT SIDE CRUMPLE & TWITCH — Chap yonboshiga g'ujanak bo'lib qulaydi va oyog'i qimirlaydi!
          const twitch = Math.sin(t * 28) * (1 - t * 0.7) * 0.25;
          this.body.position.set(-k * 0.35, -k * 0.45, 0);
          this.body.rotation.set(-k * 0.35, -k * 0.4, k * Math.PI * 0.47);
          this.headGroup.rotation.z = k * 0.35;
          this.armL.rotation.set(0.8 * k, 0, 0.4 * k);
          this.armR.rotation.set(-1.1 * k, 0, -0.8 * k);
          this.legL.rotation.set(0.85 * k, 0, 0.15);
          this.legR.rotation.set(0.45 * k + twitch, 0, -0.25);
          this.kneeL.rotation.x = -1.1 * k;
          this.kneeR.rotation.x = -0.8 * k + twitch;
          break;
        }
        case 5:
        default: {
          // 5: STUMBLE SPLITS — Oyoqlari ikki tomonga shpagat bo'lib ochilib, oldinga yuztuban qulaydi!
          this.body.position.set(0, -k * 0.48, -k * 0.35);
          this.body.rotation.set(-k * Math.PI * 0.44, k * 0.2, 0);
          this.headGroup.rotation.y = -k * 0.6;
          this.armL.rotation.set(-1.8 * k, 0, 0.85 * k);
          this.armR.rotation.set(-1.6 * k, 0, -0.95 * k);
          this.legL.rotation.set(0.2 * k, 0, 1.15 * k);
          this.legR.rotation.set(-0.2 * k, 0, -1.15 * k);
          this.kneeL.rotation.x = -0.2 * k;
          this.kneeR.rotation.x = -0.2 * k;
          break;
        }
      }
      // 08B: the GLB has no death clip — the frozen Camper Buddy follows the same procedural fall
      // (whole-body transform about the feet), the fallback agreed for this stage.
      if (this.buddy) {
        this.buddy.pivot.position.copy(this.body.position);
        this.buddy.pivot.rotation.copy(this.body.rotation);
      }
      return;
    }

    // Tirilganda barcha suyak va qurol holatini tiklash
    if (!this.wasAlive || this.deathT > 0) {
      this.wasAlive = true;
      this.deathT = 0;
      this.gunHolder.visible = this.weapon !== null;
      this.body.rotation.set(0, 0, 0);
      this.body.position.set(0, 0, 0);
      this.armL.rotation.set(1.24, 0.28, 0.44);
      this.armR.rotation.set(1.18, -0.12, -0.18);
      this.elbowL.rotation.x = 0.40;
      this.elbowR.rotation.x = 0.45;
      this.legL.rotation.set(0, 0, 0);
      this.legR.rotation.set(0, 0, 0);
      this.headGroup.rotation.set(0, 0, 0);
      this.jawGroup.rotation.set(0, 0, 0);
      if (this.buddy) {
        this.buddy.pivot.position.set(0, 0, 0);
        this.buddy.pivot.rotation.set(0, 0, 0);
        this.buddy.pivot.visible = true;
        this.buddy.anim.resetToIdle();
        this.gunParent().visible = this.weapon !== null;
      }
    }

    if (this.buddy) {
      this.updateBuddy(dt, s, this.buddy);
      return;
    }

    const amp = Math.min(1, s.speed / RUN_SPEED);
    if (s.onGround) this.phase += dt * s.speed * 2.6;
    const sw = Math.sin(this.phase);
    const cw = Math.cos(this.phase);
    const doubleSw = Math.sin(this.phase * 2);

    if (!s.onGround) {
      this.legL.rotation.x = THREE.MathUtils.lerp(this.legL.rotation.x, 0.72, dt * 10);
      this.legR.rotation.x = THREE.MathUtils.lerp(this.legR.rotation.x, -0.35, dt * 10);
      this.kneeL.rotation.x = THREE.MathUtils.lerp(this.kneeL.rotation.x, -0.95, dt * 10);
      this.kneeR.rotation.x = THREE.MathUtils.lerp(this.kneeR.rotation.x, -0.45, dt * 10);
    } else {
      this.legL.rotation.x = sw * 0.78 * amp;
      this.legR.rotation.x = -sw * 0.78 * amp;
      this.kneeL.rotation.x = -Math.max(0, -cw) * 0.95 * amp - 0.05;
      this.kneeR.rotation.x = -Math.max(0, cw) * 0.95 * amp - 0.05;
    }

    // "RV There Yet?" kemperining kulgili baqaloq chayqalib ("waddle") yugurishi
    this.hips.position.y = 0.76 - Math.abs(cw) * 0.06 * amp;
    this.hips.rotation.y = sw * 0.16 * amp;
    this.hips.rotation.z = sw * 0.09 * amp;
    this.chest.rotation.y = -sw * 0.16 * amp;
    this.chest.rotation.x = s.pitch * 0.85;

    // Dumaloq qorinning nafas olishi va likillashi
    const breath = Math.sin(this.idleT * 3.2) * 0.022;
    const jiggle = doubleSw * 0.065 * amp + breath;
    this.bellyGroup.position.y = 0.22 + doubleSw * 0.028 * amp;
    this.bellyGroup.scale.set(1 + jiggle, 1 - jiggle * 0.6, 1 + jiggle * 0.9);

    // Bosh va ko'z harakatlari
    this.headGroup.rotation.z = -sw * 0.10 * amp + Math.sin(this.idleT * 1.7) * 0.025;
    this.headGroup.rotation.y = sw * 0.08 * amp;
    this.jawGroup.rotation.x = Math.max(0, doubleSw) * 0.18 * amp + Math.max(0, Math.sin(this.idleT * 2.5)) * 0.03;

    const lookX = Math.sin(this.idleT * 2.1) * 0.010 + sw * 0.010 * amp;
    const lookY = Math.cos(this.idleT * 3.4) * 0.005 + doubleSw * 0.006 * amp;
    this.pupilL.position.set(-0.066 + lookX, 0.042 + lookY, -0.215);
    this.pupilR.position.set(0.066 + lookX, 0.042 - lookY * 0.5, -0.215);

    const blink = Math.sin(this.idleT * 3.8) > 0.97 ? 2.4 : 1.0;
    this.lidL.scale.y = blink;
    this.lidR.scale.y = blink;
    this.browL.position.y = 0.115 + Math.abs(sw) * 0.014 * amp;
    this.browR.position.y = 0.115 + Math.abs(cw) * 0.014 * amp;

    // Qayta o'qlash va o'q uzish tepkisi
    this.recoilKick *= Math.exp(-dt * 14);
    if (s.reloading) this.reloadAnimT += dt * 4.5;
    else this.reloadAnimT = 0;

    if (!this.weapon) {
      // Qurolsiz holat (kelajakdagi unarmed start uchun tabiiy qo'l harakati)
      this.gunHolder.visible = false;
      this.armL.rotation.set(sw * 0.45 * amp, 0.08, 0.14);
      this.armR.rotation.set(-sw * 0.45 * amp, -0.08, -0.14);
      this.elbowL.rotation.x = 0.25;
      this.elbowR.rotation.x = 0.25;
      return;
    }

    if (this.gunSlide) {
      this.gunSlide.position.z = this.recoilKick * 0.065;
      this.gunSlide.rotation.z = this.weapon === 'sniper' ? -this.recoilKick * 0.45 : 0;
    }
    if (this.gunMag) {
      const magDrop = s.reloading ? Math.max(0, Math.sin(this.reloadAnimT)) * 0.14 : 0;
      this.gunMag.position.y = -magDrop;
    }

    const reloadTilt = s.reloading ? -0.50 : 0;
    const targetGunRotX = reloadTilt + this.recoilKick * 0.26;
    this.gunHolder.rotation.x = THREE.MathUtils.lerp(this.gunHolder.rotation.x, targetGunRotX, dt * 14);
    this.gunHolder.rotation.y = 0;
    this.gunHolder.position.set(0.08, -0.02 + this.recoilKick * 0.02, -0.44 + this.recoilKick * 0.075);
    this.armR.rotation.x = 1.18 + this.gunHolder.rotation.x * 0.65;
    this.armL.rotation.x = 1.24 + this.gunHolder.rotation.x * 1.10;
  }

  /**
   * 08B alive update for the Camper Buddy GLB: baked clips (mixer) → upper-body aim override →
   * gun solved onto the Hand_R_Grip socket. Recoil/reload feel mirrors the procedural branch above.
   */
  private updateBuddy(dt: number, s: StickmanState, b: BuddyRig): void {
    b.anim.update(dt, { speed: s.speed, onGround: s.onGround, alive: true });

    this.recoilKick *= Math.exp(-dt * 14);
    if (s.reloading) this.reloadAnimT += dt * 4.5;
    else this.reloadAnimT = 0;
    const armed = this.weapon !== null;
    const reloadT = s.reloading ? (this.reloadAnimT / (Math.PI * 2)) % 1 : 0;
    applyUpperBodyAimPose(b.inst.bones, {
      weight: 1,
      pitch: s.pitch,
      armed,
      reloadT,
      weapon: this.weapon ?? undefined,
    });

    if (!armed) {
      b.mount.holder.visible = false;
      return;
    }
    b.mount.holder.visible = true;
    if (this.gunSlide) {
      this.gunSlide.position.z = this.recoilKick * 0.065;
      this.gunSlide.rotation.z = this.weapon === 'sniper' ? -this.recoilKick * 0.45 : 0;
    }
    if (this.gunMag) {
      const magDrop = s.reloading ? Math.max(0, Math.sin(this.reloadAnimT)) * 0.14 : 0;
      this.gunMag.position.y = -magDrop;
    }
    // Smoothed like the procedural gunHolder tilt so reload in/out never snaps.
    const reloadTarget = s.reloading ? -0.5 : 0;
    this.buddyReloadTilt = THREE.MathUtils.lerp(this.buddyReloadTilt, reloadTarget, Math.min(1, dt * 14));
    // The mount solves against world matrices: refresh them after the clip + aim pose writes.
    this.root.updateMatrixWorld(true);
    b.mount.update(s.pitch, this.recoilKick, this.buddyReloadTilt);
  }

  /**
   * Local-player-only proximity visibility helper for 3P camera:
   * when the 3P spring-arm pulls in very close to the local player's head/back due to a solid wall
   * or low branch behind the player, hide only the local player's own head/torso so it never blocks
   * the crosshair, without ever hiding world foliage or remote enemies.
   */
  setCameraProximityFade(cameraDist: number): void {
    const showFull = cameraDist >= 0.78;
    const showBody = cameraDist >= 0.48;
    if (this.buddy) {
      // One skinned mesh: hide the head by collapsing the Head bone (no clip animates scale).
      this.buddy.head?.scale.setScalar(showFull ? 1 : 0.0001);
      this.buddy.pivot.visible = showBody;
      return;
    }
    this.headGroup.visible = showFull;
    this.body.visible = showBody;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubCharacterReady?.();
    this.unsubCharacterReady = null;
    if (this.buddy) {
      this.buddy.anim.dispose();
      this.buddy.pivot.removeFromParent();
      this.buddy.inst.dispose();
      this.buddy = null;
    }
    this.unsubWeaponReady?.();
    this.unsubWeaponReady = null;
    this.setNameTag(null);
    for (const g of this.ownedGeometries) {
      g.dispose();
    }
    this.ownedGeometries.length = 0;
    this.shirtMat.dispose();
    this.hatMat.dispose();
    this.flash.material.dispose();
  }
}

export const TEAM_COLORS = { red: '#e03a30', blue: '#2e75e8' } as const;
const FFA_PALETTE = ['#e03a30', '#2e75e8', '#38a84c', '#e69224', '#8e44cc', '#1eb0b0', '#d44888', '#78828c', '#dec030', '#3b5c85'];

export function colorFor(team: string, id: string): string {
  if (team === 'red') return TEAM_COLORS.red;
  if (team === 'blue') return TEAM_COLORS.blue;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return FFA_PALETTE[Math.abs(h) % FFA_PALETTE.length];
}
