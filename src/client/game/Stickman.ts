import * as THREE from 'three';
import type { WeaponId } from '../../shared/weapons';
import { buildGun, type GunModel } from './GunModels';
import { flashTexture } from './Textures';
import { onWeaponAssetsReady } from './WeaponAssetRegistry';
import { CamperBuddyAnimator } from './animation/CamperBuddyAnimator';
import { applyUpperBodyAimPose } from './character/CharacterAimPose';
import { applyCrouchPose } from './character/CharacterCrouchPose';
import {
  instantiateCamperBuddy,
  isCharacterAssetReady,
  onCharacterAssetReady,
  preloadCharacterAssets,
  type CamperBuddyInstance,
} from './character/CharacterAssetRegistry';
import { CharacterGearRig, type CharacterGearState } from './character/CharacterGear';
import { applyTeamColor } from './character/CharacterMaterials';
import { CharacterWeaponMount, GUN_SCALE_3P } from './character/CharacterWeaponMount';

let flashTex: THREE.Texture | null = null;

/** Model pozasining tik turish ↔ o'tirish o'tish vaqti, s (chiziqli ulush + smoothstep). */
export const CROUCH_POSE_BLEND_TIME = 0.14;
/** O'limda o'tirish pozasi shu vaqt ichida bo'shatiladi (yiqilish animatsiyalari tik tanaga sozlangan), s. */
export const CROUCH_DEATH_RELEASE_TIME = 0.12;
/** Ism yorlig'ining o'tirgandagi pasayishi, m. */
const CROUCH_NAME_TAG_DROP = 0.5;
/** Ism yorlig'ining tik turgandagi balandligi, m. */
const NAME_TAG_Y = 2.18;

const crouchEase = (k: number): number => {
  const x = k < 0 ? 0 : k > 1 ? 1 : k;
  return x * x * (3 - 2 * x);
};

export interface StickmanState {
  speed: number;
  onGround: boolean;
  pitch: number;
  alive: boolean;
  reloading: boolean;
}

/**
 * 08B: DEV diagnostics of one character model. `mode` is 'pending' while the Camper Buddy GLB is
 * still loading (the model renders nothing) and 'buddy' once the instance is attached.
 */
export interface CharacterModelDiag {
  mode: 'buddy' | 'pending';
  visible: boolean;
  state: string | null;
  weights: Record<string, number>;
  timeScale: number;
  weapon: string | null;
  muzzleWorld: { x: number; y: number; z: number };
  gripWorld: { x: number; y: number; z: number } | null;
  /** uuids proving per-instance independence (null while pending). */
  skeletonUuid: string | null;
  hipsBoneUuid: string | null;
  teamMaterialUuid: string | null;
  teamColorHex: string | null;
  /** Silliqlangan o'tirish ulushi 0..1 (0 — tik turibdi). */
  crouch: number;
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
 * Uchinchi shaxs o'yinchi modeli: Camper Buddy GLB (skelet + animator + qo'l socket'idagi qurol).
 * GLB hali yuklanmagan bo'lsa model hech narsa chizmaydi (`root` bo'sh) — qurol/jihoz so'rovlari
 * saqlanadi va asset kelganda `attachBuddy()` ularni qo'llaydi. O'limda GLB'da yiqilish klipi yo'q,
 * shuning uchun muzlatilgan skelet 6 xil kreativ yiqilish (pivot transformi) bilan quladi.
 */
export class Stickman {
  private static deathCounter = 0;

  readonly root = new THREE.Group();
  private muzzle = new THREE.Object3D();
  private ejectPort = new THREE.Object3D();
  private gunModel: GunModel | null = null;
  private gunSlide?: THREE.Object3D;
  private gunMag?: THREE.Object3D;
  private unsubWeaponReady: (() => void) | null = null;
  private recoilKick = 0;
  private reloadAnimT = 0;
  private flash: THREE.Sprite;
  private flashT = 0;
  private deathT = 0;
  private deathStyle = 0; // 0: headshot backflip, 1: faceplant, 2: spin-kneel-side, 3: blast cartwheel, 4: left crumple, 5: splits
  private wasAlive = true;
  private weapon: WeaponId | null = null;
  private nameTag: THREE.Sprite | null = null;
  /** wolf_night: yiqilgan ittifoqchi belgisi (⛑, qizil, pulsatsiya) — ism yorlig'i o'rniga, yotgan tana ustida. */
  private downedMarker: THREE.Sprite | null = null;
  private downedPulse = 0;
  private teamHex: string;
  private buddy: BuddyRig | null = null;
  /** Kaska / nimcha / granata / aptechka osmalari (bosh, ko'krak, kamar). */
  private readonly gear = new CharacterGearRig();
  private unsubCharacterReady: (() => void) | null = null;
  private disposed = false;
  private buddyReloadTilt = 0;
  /** `setCrouch()` dan: o'yinchi (avtoritativ / bashorat) o'tirganmi. */
  private crouchTarget = false;
  /** Chiziqli o'tirish ulushi 0..1 (`CROUCH_POSE_BLEND_TIME` ichida); pozaga smoothstep bilan beriladi. */
  private crouchAmount = 0;

  constructor(color: THREE.ColorRepresentation) {
    this.teamHex = '#' + new THREE.Color(color).getHexString();

    flashTex ??= flashTexture();
    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.flash.scale.setScalar(0.65);
    this.flash.visible = false;
    this.parkAnchors();

    // 08B: Camper Buddy GLB tayyor bo'lsa darhol ulanadi; aks holda (yuklanmoqda / qayta urinish)
    // model bo'sh qoladi va asset kelganda ulanadi. Zaxira tana yo'q — o'yinchilar faqat GLB bilan chiziladi.
    void preloadCharacterAssets();
    if (isCharacterAssetReady()) this.attachBuddy();
    if (!this.buddy) this.unsubCharacterReady = onCharacterAssetReady(() => this.attachBuddy());
  }

  /**
   * Qurol mount'i yo'q paytda (GLB kutilmoqda yoki qurolsiz) muzzle/eject/flash anchorlari `root`
   * ostida ko'krak balandligida turadi — `getMuzzleWorld()` hech qachon xarita markazini qaytarmaydi.
   */
  private parkAnchors(): void {
    this.muzzle.position.set(0.1, 1.35, -0.5);
    this.ejectPort.position.copy(this.muzzle.position);
    this.flash.position.copy(this.muzzle.position);
    this.root.add(this.muzzle, this.ejectPort, this.flash);
  }

  /** 08B: attaches a Camper Buddy instance (own skeleton, own team material) and applies pending weapon/gear. */
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
    // Jihoz holati (`setGear`) rig ichida saqlanib turadi — ulanishda darhol suyaklarga chiqadi.
    this.gear.attach(
      inst.bones.get('Head') ?? null,
      inst.bones.get('Chest') ?? inst.bones.get('Spine') ?? null,
      inst.bones.get('Hips') ?? null,
    );
    // Kutib turgan qurol so'rovi qo'l socket'iga o'rnatiladi.
    this.mountWeapon(this.buddy);
  }

  /** Where the 3P gun, muzzle, eject port and flash live: the hand socket mount (null while pending). */
  private gunParent(): THREE.Group | null {
    return this.buddy ? this.buddy.mount.holder : null;
  }

  /** 08B: true once the Camper Buddy GLB renders this player (false while the asset is pending). */
  usesCharacterAsset(): boolean {
    return this.buddy !== null;
  }

  /** 08B: one-shot Interact clip (container open). No-op while the asset is pending. */
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
      mode: b ? 'buddy' : 'pending',
      visible: this.root.visible,
      state: d?.state ?? null,
      weights: d?.weights ?? {},
      timeScale: d?.timeScale ?? 1,
      weapon: this.weapon,
      muzzleWorld: { x: muzzle.x, y: muzzle.y, z: muzzle.z },
      gripWorld,
      skeletonUuid: b?.inst.skinnedMeshes[0]?.skeleton.uuid ?? null,
      hipsBoneUuid: b?.inst.bones.get('Hips')?.uuid ?? null,
      teamMaterialUuid: b?.inst.teamMaterial.uuid ?? null,
      teamColorHex: b ? '#' + b.inst.teamMaterial.color.getHexString() : null,
      crouch: this.crouchAmount,
    };
  }

  /**
   * O'tirish holati (lokal o'yinchi — bashorat, masofaviy — snapshot). Poza `update()` ichida
   * `CROUCH_POSE_BLEND_TIME` davomida silliq o'tadi; o'limda bo'shatiladi, tirilganda 0 dan boshlanadi.
   */
  setCrouch(crouched: boolean): void {
    this.crouchTarget = crouched;
  }

  /** Joriy (chiziqli) o'tirish ulushi 0..1 — testlar/diagnostika uchun. */
  getCrouchAmount(): number {
    return this.crouchAmount;
  }

  /** O'limda: o'tirish pozasi tez bo'shatiladi (muzlagan mixer ustida idempotent qayta qo'llanadi). */
  private releaseCrouchOnDeath(dt: number): void {
    this.crouchTarget = false;
    if (this.crouchAmount <= 0) return;
    this.crouchAmount = Math.max(0, this.crouchAmount - Math.max(0, dt) / CROUCH_DEATH_RELEASE_TIME);
    if (this.buddy) applyCrouchPose(this.buddy.inst.bones, crouchEase(this.crouchAmount));
  }

  /**
   * O'lim holatiga qarab kreativ yiqilish animatsiyasini tanlaydi:
   * - Boshiga o'q tegsa (headshot): 0 (boshi orqaga ketib, orqaga uchib yiqilish)
   * - Granata yoki Drobovik: 3 (havoda charxpalak / salto bo'lib uchib ketish)
   * - Boshqa holatlarda: 1 (oldinga faceplant), 2 (aylanib tiz cho'kib yonboshga qulash),
   *   4 (chap yonboshga g'ujanak bo'lib yiqilish), 5 (oyoqlari shpagat ketib yuztuban qulash)
   */
  triggerDeath(headshot: boolean, weapon?: WeaponId | 'grenade' | 'zone' | 'wolf'): void {
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
    if (this.buddy) applyTeamColor(this.buddy.inst, hex);
  }

  /** Qurolni tanlaydi; GLB hali yo'q bo'lsa so'rov saqlanadi va `attachBuddy()` da o'rnatiladi. */
  setWeapon(w: WeaponId | null): void {
    if (this.weapon === w && (w === null || this.gunModel !== null)) return;
    this.weapon = w;
    if (this.buddy) this.mountWeapon(this.buddy);
  }

  /** Joriy qurol modelini (yoki hech narsani) qo'l socket'idagi mount'ga o'rnatadi. */
  private mountWeapon(b: BuddyRig): void {
    this.unsubWeaponReady?.();
    this.unsubWeaponReady = null;
    const holder = b.mount.holder;
    holder.clear();
    const w = this.weapon;
    b.mount.setWeapon(w);
    if (!w) {
      this.gunModel = null;
      this.gunSlide = undefined;
      this.gunMag = undefined;
      holder.visible = false;
      this.parkAnchors();
      return;
    }
    holder.visible = true;
    const gun = buildGun(w, '3p');
    this.gunModel = gun;
    gun.group.scale.setScalar(GUN_SCALE_3P);
    holder.add(gun.group);
    this.gunSlide = gun.slide;
    this.gunMag = gun.mag;
    const syncAnchors = () => {
      gun.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = false;
      });
      this.muzzle.position.copy(gun.muzzle).multiplyScalar(GUN_SCALE_3P);
      this.ejectPort.position.copy(gun.ejectPort).multiplyScalar(GUN_SCALE_3P);
      this.flash.position.copy(this.muzzle.position);
    };
    syncAnchors();
    holder.add(this.muzzle, this.ejectPort, this.flash);
    this.unsubWeaponReady = onWeaponAssetsReady(() => syncAnchors());
  }

  setNameTag(name: string | null, color = '#ffffff', showSprite = true): void {
    if (this.nameTag) {
      this.root.remove(this.nameTag);
      (this.nameTag.material as THREE.SpriteMaterial).map?.dispose();
      this.nameTag.material.dispose();
      this.nameTag = null;
    }
    if (!name || !showSprite) return;

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
    s.position.y = NAME_TAG_Y;
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

  /**
   * Yiqilgan ittifoqchi belgisi (wolf_night): ⛑ qizil doirada, yotgan tana ustida pulsatsiya qiladi; har qadamda
   * ko'rinadi (masofa chegarasi yo'q — sherik uni uzoqdan topishi kerak). `null`/false — olib tashlanadi.
   */
  setDownedMarker(show: boolean): void {
    if (!show) {
      if (this.downedMarker) {
        this.root.remove(this.downedMarker);
        (this.downedMarker.material as THREE.SpriteMaterial).map?.dispose();
        this.downedMarker.material.dispose();
        this.downedMarker = null;
      }
      return;
    }
    if (this.downedMarker) return;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const g = c.getContext('2d')!;
    g.beginPath();
    g.arc(64, 64, 56, 0, Math.PI * 2);
    g.fillStyle = 'rgba(150, 18, 18, 0.92)';
    g.fill();
    g.lineWidth = 7;
    g.strokeStyle = '#ffd6d6';
    g.stroke();
    g.font = 'bold 72px Segoe UI Emoji, Segoe UI Symbol, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText('⛑', 64, 70);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    s.scale.set(0.55, 0.55, 1);
    s.position.y = 1.35;
    s.renderOrder = 11;
    this.root.add(s);
    this.downedMarker = s;
    this.downedPulse = 0;
  }

  /** Pichoq zarbasi: olovsiz, qo'l siltash. */
  meleeSwing(): void {
    this.recoilKick = 1.0;
  }

  muzzleFlash(): void {
    this.flashT = 0.055;
    this.flash.visible = true;
    this.flash.material.rotation = Math.random() * Math.PI;
    this.recoilKick = 1.0;
  }

  /** Qo'lida qurol modeli bormi (muzzle/eject anchorlari mount'ga ulanganmi). */
  hasWeapon(): boolean {
    return this.weapon !== null && this.gunModel !== null;
  }

  getMuzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  getEjectWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.ejectPort.getWorldPosition(out);
  }

  /** Modelda ko'rinadigan jihozlar: kaska, zirh nimcha, kamardagi granatalar va aptechkalar. */
  setGear(g: CharacterGearState): void {
    this.gear.setState(g);
  }

  update(dt: number, s: StickmanState): void {
    this.gear.update();
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.flash.visible = false;
    }
    if (this.nameTag) {
      this.nameTag.visible = s.alive;
      this.nameTag.position.y = NAME_TAG_Y - CROUCH_NAME_TAG_DROP * crouchEase(this.crouchAmount);
    }
    if (this.downedMarker) {
      // Yiqilgan belgisi: 0.9 s davrli pulsatsiya (o'lcham va shaffoflik)
      this.downedPulse += dt;
      const k = 0.5 + 0.5 * Math.sin(this.downedPulse * 7);
      const sc = 0.5 + 0.14 * k;
      this.downedMarker.scale.set(sc, sc, 1);
      (this.downedMarker.material as THREE.SpriteMaterial).opacity = 0.7 + 0.3 * k;
      this.downedMarker.position.y = 1.3 + 0.08 * k;
    }

    // ==================== O'LIM HOLATI: Qurol qo'ldan tushadi va 6 xil kreativ yiqilish! ====================
    if (!s.alive) {
      if (this.wasAlive && this.deathT === 0) {
        const styles = [1, 2, 4, 5];
        this.deathStyle = styles[Stickman.deathCounter++ % styles.length];
      }
      this.wasAlive = false;
      // O'lgan zahoti qo'lidagi qurol yo'qoladi (chunki qurol fizik tarzda yerga tushib ketadi!)
      const holder = this.gunParent();
      if (holder) holder.visible = false;
      this.flash.visible = false;
      this.buddy?.anim.freeze();
      this.releaseCrouchOnDeath(dt);

      this.deathT = Math.min(1, this.deathT + dt * 2.2);
      const t = this.deathT;
      const k = 1 - Math.pow(1 - t, 3);
      // 08B: the GLB has no death clip — the frozen Camper Buddy follows a whole-body fall
      // (transform about the feet) applied to the pivot above the clip-driven skeleton.
      if (this.buddy) this.applyDeathFall(this.buddy.pivot, t, k);
      return;
    }

    // Tirilganda pivot, animator va qurol holatini tiklash
    if (!this.wasAlive || this.deathT > 0) {
      this.wasAlive = true;
      this.deathT = 0;
      // O'tirish har doim tik holatdan boshlanadi (GLB suyaklarini resetToIdle qayta yozadi)
      this.crouchAmount = 0;
      if (this.buddy) {
        this.buddy.pivot.position.set(0, 0, 0);
        this.buddy.pivot.rotation.set(0, 0, 0);
        this.buddy.pivot.visible = true;
        this.buddy.anim.resetToIdle();
        this.buddy.mount.holder.visible = this.weapon !== null;
      }
    }

    // O'tirish ulushi: chiziqli, CROUCH_POSE_BLEND_TIME ichida
    const crouchStep = Math.max(0, dt) / CROUCH_POSE_BLEND_TIME;
    this.crouchAmount = this.crouchTarget
      ? Math.min(1, this.crouchAmount + crouchStep)
      : Math.max(0, this.crouchAmount - crouchStep);

    if (this.buddy) this.updateBuddy(dt, s, this.buddy);
  }

  /**
   * Yiqilish pozasi (`deathStyle`): butun tana transformi oyoq tagi atrofida. `t` — o'lim vaqti 0..1,
   * `k` — kubik ease-out ulushi.
   */
  private applyDeathFall(pivot: THREE.Group, t: number, k: number): void {
    switch (this.deathStyle) {
      case 0: {
        // 0: HEADSHOT BACKFLIP — Boshiga o'q tekkanda boshi keskin orqaga ketib, orqaga uchib tushadi!
        const hop = Math.sin(t * Math.PI) * 0.65;
        pivot.position.set(0, hop - k * 0.42, k * 0.55);
        pivot.rotation.set(k * Math.PI * 0.48, k * 0.25, Math.sin(k * Math.PI) * 0.18);
        break;
      }
      case 1: {
        // 1: FACEPLANT FORWARD — Oldinga qoqilib, yuzi va qorni bilan yerga ("faceplant") yiqiladi!
        const stumble = Math.sin(t * Math.PI) * 0.28;
        pivot.position.set(0, stumble - k * 0.46, -k * 0.48);
        pivot.rotation.set(-k * Math.PI * 0.48, 0, 0);
        break;
      }
      case 2: {
        // 2: DRAMATIC SPIN & SIDE COLLAPSE — 270 gradusga aylanib, tiz cho'kib, o'ng yonboshga qulaydi!
        const kneelPhase = Math.min(1, t * 2.0);
        const fallPhase = Math.max(0, (t - 0.35) / 0.65);
        const fk = 1 - Math.pow(1 - fallPhase, 2);
        pivot.rotation.set(-kneelPhase * 0.22, k * Math.PI * 1.35, -fk * Math.PI * 0.47);
        pivot.position.set(fk * 0.32, -kneelPhase * 0.22 - fk * 0.24, 0);
        break;
      }
      case 3: {
        // 3: EXPLOSION / SHOTGUN CARTWHEEL — Havoga baland uchib, charxpalak aylanib qorintuban tushadi!
        const arc = Math.sin(t * Math.PI) * 1.25;
        pivot.position.set(k * 0.35, arc - k * 0.45, k * 0.45);
        pivot.rotation.set(-k * Math.PI * 1.48, k * 1.2, k * Math.PI * 0.22);
        break;
      }
      case 4: {
        // 4: LEFT SIDE CRUMPLE — Chap yonboshiga g'ujanak bo'lib qulaydi!
        pivot.position.set(-k * 0.35, -k * 0.45, 0);
        pivot.rotation.set(-k * 0.35, -k * 0.4, k * Math.PI * 0.47);
        break;
      }
      case 5:
      default: {
        // 5: STUMBLE SPLITS — Oldinga yuztuban qulaydi!
        pivot.position.set(0, -k * 0.48, -k * 0.35);
        pivot.rotation.set(-k * Math.PI * 0.44, k * 0.2, 0);
        break;
      }
    }
  }

  /**
   * 08B alive update for the Camper Buddy GLB: baked clips (mixer) → crouch pose → upper-body aim
   * override → gun solved onto the Hand_R_Grip socket.
   */
  private updateBuddy(dt: number, s: StickmanState, b: BuddyRig): void {
    b.anim.update(dt, { speed: s.speed, onGround: s.onGround, alive: true, crouched: this.crouchAmount > 0.5 });
    // O'tirish pozasi: mixer'dan keyin, aim pozasidan OLDIN — aim tanani egilgan tosga nisbatan
    // stabillaydi, qurol/bosh nishonda qoladi (CharacterCrouchPose izohi). Amount 0 da ham chaqiriladi.
    applyCrouchPose(b.inst.bones, crouchEase(this.crouchAmount));

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
    // Qayta o'qlash qiyaligi silliqlanadi — kirish/chiqish hech qachon sakramaydi.
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
   * the crosshair, without ever hiding world foliage or remote enemies. No-op while pending.
   */
  setCameraProximityFade(cameraDist: number): void {
    if (!this.buddy) return;
    const showFull = cameraDist >= 0.78;
    const showBody = cameraDist >= 0.48;
    // One skinned mesh: hide the head by collapsing the Head bone (no clip animates scale).
    this.buddy.head?.scale.setScalar(showFull ? 1 : 0.0001);
    this.buddy.pivot.visible = showBody;
  }

  dispose(): void {
    this.disposed = true;
    this.gear.dispose();
    this.setDownedMarker(false);
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
