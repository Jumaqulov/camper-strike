import * as THREE from 'three';
import { RUN_SPEED } from '../../shared/constants';
import { WEAPONS, type WeaponId } from '../../shared/weapons';
import { buildGrenadeModel, buildGun, type GunModel } from './GunModels';
import { getFlannelTexture, skinMat } from './ViewModelMaterials';
import { flashTexture } from './Textures';
import { onWeaponAssetsReady } from './WeaponAssetRegistry';

const HOLD: Record<WeaponId, THREE.Vector3> = {
  rifle: new THREE.Vector3(0.20, -0.135, -0.36),
  pistol: new THREE.Vector3(0.17, -0.125, -0.34),
  shotgun: new THREE.Vector3(0.20, -0.135, -0.37),
  sniper: new THREE.Vector3(0.20, -0.155, -0.38),
  // Pichoq: pastki o'ngda, ko'krak balandligida — musht dastada, tig' markazga qiya
  knife: new THREE.Vector3(0.19, -0.17, -0.3),
};

/** Pichoq guruhining holder ichidagi tabiiy tutish burilishi: uchi yuqoriga-oldinga va biroz markaz tomon, tig' ichkariga qiya. */
const KNIFE_POSE = new THREE.Euler(0.3, 0.25, 0.35, 'YXZ');

const watchBandMat = new THREE.MeshStandardMaterial({ color: '#382919', roughness: 0.7 });

/** 1P yoritgich ranglari: tun (oy nuri) va tong (iliq shafaq). */
const VM_NIGHT = {
  hemi: new THREE.Color('#b8c4e6'),
  hemiGround: new THREE.Color('#2a3040'),
  key: new THREE.Color('#aebfff'),
  rim: new THREE.Color('#6f8fd6'),
};
const VM_DAWN = {
  hemi: new THREE.Color('#f3d9cc'),
  hemiGround: new THREE.Color('#4a4032'),
  key: new THREE.Color('#ffd3aa'),
  rim: new THREE.Color('#d79cbc'),
};

/** Birinchi shaxs ko'rinishidagi qurol + kemperning flanel yengli qo'llari va barmoqlari. */
export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private holder = new THREE.Group();
  private guns = {} as Record<WeaponId, GunModel>;
  private sleeveMat: THREE.MeshStandardMaterial;
  private flash: THREE.Mesh;
  private flashLight: THREE.PointLight;
  private flashT = 0;
  private weapon: WeaponId = 'rifle';
  private bob = 0;
  private kick = 0;
  private kickRoll = 0;
  private actionT = 0;
  private swayX = 0;
  private swayY = 0;
  private switchT = 0;
  private switchDur = 0.4;
  private reloadT = 0;
  private reloadDur = 0;
  private throwT = 0;
  /** Pichoq sanchish animatsiyasi vaqti (0 = yo'q). */
  private stabT = 0;
  private grenade: THREE.Group;
  private unarmed = false;
  private ownedGeometries: THREE.BufferGeometry[] = [];
  private unsubWeaponReady: (() => void) | null = null;
  /** 1P qo'l/qurol yoritgichlari — tun rejimida pasaytiriladi va ko'kimtir tuslanadi. */
  private readonly hemi: THREE.HemisphereLight;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  /** Tun rejimi va joriy tong omili (-1 — hali qo'llanmagan). */
  private night = false;
  private dawnF = -1;
  visible = true;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.01, 10);
    this.scene.add(this.camera);
    this.camera.add(this.holder);
    this.hemi = new THREE.HemisphereLight('#ffffff', '#6b5a40', 1.9);
    this.scene.add(this.hemi);
    this.keyLight = new THREE.DirectionalLight('#fff1d6', 2.8);
    this.keyLight.position.set(1.4, 2.4, 1.5);
    this.scene.add(this.keyLight);
    this.rimLight = new THREE.DirectionalLight('#7dd3fc', 1.8);
    this.rimLight.position.set(-1.8, 1.5, -1.2);
    this.scene.add(this.rimLight);

    this.sleeveMat = new THREE.MeshStandardMaterial({ map: getFlannelTexture('#d9382e'), roughness: 0.72 });
    for (const w of Object.keys(WEAPONS) as WeaponId[]) {
      const g = buildGun(w, '1p');
      g.group.visible = false;
      if (w === 'knife') g.group.setRotationFromEuler(KNIFE_POSE);
      this.addCamperArms(g, w);
      this.holder.add(g.group);
      this.guns[w] = g;
    }

    const flashGeo = new THREE.PlaneGeometry(0.32, 0.32);
    this.ownedGeometries.push(flashGeo);
    this.flash = new THREE.Mesh(
      flashGeo,
      new THREE.MeshBasicMaterial({ map: flashTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    );
    this.flash.visible = false;
    this.holder.add(this.flash);
    this.flashLight = new THREE.PointLight('#ffc060', 0, 3.2, 2);
    this.holder.add(this.flashLight);

    this.grenade = buildGrenadeModel();
    this.grenade.scale.setScalar(0.75);
    this.grenade.visible = false;
    this.camera.add(this.grenade);

    this.setWeapon('rifle');
    this.unsubWeaponReady = onWeaponAssetsReady(() => {
      const g = this.guns[this.weapon];
      if (!g) return;
      this.flash.position.copy(g.muzzle).add(new THREE.Vector3(0, 0, -0.05));
      this.flashLight.position.copy(g.muzzle);
    });
  }

  private addCamperArms(g: GunModel, w: WeaponId) {
    const ownGeo = <T extends THREE.BufferGeometry>(geo: T): T => {
      this.ownedGeometries.push(geo);
      return geo;
    };
    const buildArm = (grip: THREE.Vector3, shoulder: THREE.Vector3, isLeft: boolean) => {
      const wrist = grip.clone().lerp(shoulder, 0.14);
      const elbow = grip.clone().lerp(shoulder, 0.52);

      // 1. Dumaloq silliq multfilm kaft va bosh barmoq (hech qanday qirrali qutilar chiqib qolmaydi)
      const palm = new THREE.Mesh(ownGeo(new THREE.SphereGeometry(0.044, 14, 12)), skinMat);
      palm.scale.set(0.95, 1.05, 1.25);
      palm.position.copy(grip).add(new THREE.Vector3(isLeft ? -0.014 : 0.014, -0.008, 0.012));
      g.group.add(palm);

      const thumb = new THREE.Mesh(ownGeo(new THREE.CapsuleGeometry(0.014, 0.032, 6, 10)), skinMat);
      thumb.position.copy(grip).add(new THREE.Vector3(isLeft ? -0.024 : 0.024, 0.022, 0.0));
      thumb.rotation.set(0.35, 0, isLeft ? -0.45 : 0.45);
      g.group.add(thumb);

      // 2. Silliq bilak (Forearm)
      const dirFore = elbow.clone().sub(wrist);
      const forearm = new THREE.Mesh(ownGeo(new THREE.CylinderGeometry(0.048, 0.040, dirFore.length(), 14)), skinMat);
      forearm.position.copy(wrist).addScaledVector(dirFore, 0.5);
      forearm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirFore.clone().normalize());
      g.group.add(forearm);

      if (isLeft) {
        const watchPos = wrist.clone().lerp(elbow, 0.28);
        const band = new THREE.Mesh(ownGeo(new THREE.CylinderGeometry(0.045, 0.045, 0.024, 14)), watchBandMat);
        band.position.copy(watchPos);
        band.quaternion.copy(forearm.quaternion);
        g.group.add(band);
      }

      // 3. Ko'ylak yengi (Smooth Rolled Cuff + Sleeve)
      const cuff = new THREE.Mesh(ownGeo(new THREE.CylinderGeometry(0.064, 0.062, 0.045, 14)), this.sleeveMat);
      cuff.position.copy(elbow);
      cuff.quaternion.copy(forearm.quaternion);
      g.group.add(cuff);

      const dirSleeve = shoulder.clone().sub(elbow);
      const sleeve = new THREE.Mesh(ownGeo(new THREE.CylinderGeometry(0.066, 0.058, dirSleeve.length(), 14)), this.sleeveMat);
      sleeve.position.copy(elbow).addScaledVector(dirSleeve, 0.5);
      sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirSleeve.clone().normalize());
      g.group.add(sleeve);
    };

    if (w === 'knife') {
      // Pichoq: musht dastaning o'rtasini o'raydi; yelka ekranning pastki o'ng burchagidan keladi.
      // Pichoq guruhi burilgan (KNIFE_POSE), shuning uchun yelka siljishi holder fazosida berilib,
      // guruh fazosiga teskari burish bilan o'tkaziladi — qo'l burilishdan qat'i nazar pastga-o'ngga ketadi.
      const grip = new THREE.Vector3(0, -0.012, -0.004);
      const inv = g.group.quaternion.clone().invert();
      const shoulder = grip.clone().add(new THREE.Vector3(0.08, -0.32, 0.3).applyQuaternion(inv));
      buildArm(grip, shoulder, false);
      return;
    }

    // O'ng qo'l: dastadan pastga-orqaga
    const gripR =
      w === 'pistol'
        ? new THREE.Vector3(0, -0.045, 0.025)
        : w === 'shotgun'
          ? new THREE.Vector3(0, -0.038, 0.095)
          : new THREE.Vector3(0, -0.048, 0.065);
    buildArm(gripR, gripR.clone().add(new THREE.Vector3(0.08, -0.22, 0.34)), false);
    // Chap qo'l: old tirsaklagich / pompa qismidan
    const gripL =
      w === 'pistol'
        ? new THREE.Vector3(-0.012, -0.052, 0.01)
        : w === 'sniper'
          ? new THREE.Vector3(0, 0.005, -0.31)
          : w === 'shotgun'
            ? new THREE.Vector3(0, 0.015, -0.35)
            : new THREE.Vector3(0, 0.015, -0.32);
    buildArm(gripL, gripL.clone().add(new THREE.Vector3(-0.24, -0.2, 0.32)), true);
  }

  /**
   * Tun rejimi ("Tong otguncha"): qo'l/qurol yoritgichlari ~45% ga tushadi va oy nuriga mos ko'kimtir
   * tus oladi — aks holda 1P qurol tun dunyosi ustida kunduzdek yorug' ko'rinardi.
   */
  setNight(on: boolean): void {
    this.night = on;
    this.dawnF = -1;
    if (on) {
      this.setDawn(0);
    } else {
      this.hemi.color.set('#ffffff');
      this.hemi.groundColor.set('#6b5a40');
      this.hemi.intensity = 1.9;
      this.keyLight.color.set('#fff1d6');
      this.keyLight.intensity = 2.8;
      this.rimLight.color.set('#7dd3fc');
      this.rimLight.intensity = 1.8;
    }
  }

  /**
   * Tong otishi (faqat tun rejimida): `f` — `dawnBlendFactor` (0 tun .. 1 tong). Pasaytirilgan tungi
   * yoritgichlar ~45% → ~80% ga ko'tariladi va ko'kimtir oy tusidan iliq shafaq tusiga o'tadi.
   */
  setDawn(f: number): void {
    if (!this.night) return;
    const k = Math.min(1, Math.max(0, f));
    if (Math.abs(k - this.dawnF) < 1e-4) return;
    this.dawnF = k;
    const mul = THREE.MathUtils.lerp(0.45, 0.8, k);
    this.hemi.color.copy(VM_NIGHT.hemi).lerp(VM_DAWN.hemi, k);
    this.hemi.groundColor.copy(VM_NIGHT.hemiGround).lerp(VM_DAWN.hemiGround, k);
    this.hemi.intensity = 1.9 * mul;
    this.keyLight.color.copy(VM_NIGHT.key).lerp(VM_DAWN.key, k);
    this.keyLight.intensity = 2.8 * mul;
    this.rimLight.color.copy(VM_NIGHT.rim).lerp(VM_DAWN.rim, k);
    this.rimLight.intensity = 1.8 * mul;
  }

  setArmColor(c: THREE.ColorRepresentation): void {
    const hex = '#' + new THREE.Color(c).getHexString();
    this.sleeveMat.map = getFlannelTexture(hex);
    this.sleeveMat.needsUpdate = true;
  }

  setWeapon(w: WeaponId | null): void {
    this.guns[this.weapon].group.visible = false;
    if (!w) {
      this.unarmed = true;
      this.reloadT = 0;
      return;
    }
    this.unarmed = false;
    this.weapon = w;
    const g = this.guns[w];
    g.group.visible = true;
    this.flash.position.copy(g.muzzle).add(new THREE.Vector3(0, 0, -0.05));
    this.flashLight.position.copy(g.muzzle);
    this.reloadT = 0;
  }

  startSwitch(duration: number): void {
    this.switchT = duration;
    this.switchDur = duration;
  }

  startReload(duration: number): void {
    this.reloadT = duration;
    this.reloadDur = duration;
  }

  cancelReload(): void {
    this.reloadT = 0;
  }

  fire(recoil: number, melee = false): void {
    if (melee) {
      this.stabT = 0.001;
      return;
    }
    this.kick = Math.min(1.6, this.kick + 0.68 + recoil * 9);
    this.kickRoll = (Math.random() - 0.5) * (0.12 + recoil * 1.8);
    this.actionT = 0.001; // Zatvor / pompa siklini boshlash
    this.flashT = 0.048;
    this.flash.visible = true;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.85 + Math.random() * 0.55);
    this.flashLight.intensity = 6.5;
  }

  throwGrenade(): void {
    this.throwT = 0.5;
  }

  /** Qurol og'zining kamera lokal koordinatasi. */
  muzzleLocal(out: THREE.Vector3): THREE.Vector3 {
    const g = this.guns[this.weapon];
    out.copy(g.muzzle).applyMatrix4(g.group.matrix);
    return out.applyMatrix4(this.holder.matrix);
  }

  /** Gilza otilib chiqadigan darcha (Ejection Port) kamera lokal koordinatasi. */
  ejectPortLocal(out: THREE.Vector3): THREE.Vector3 {
    const g = this.guns[this.weapon];
    out.copy(g.ejectPort).applyMatrix4(g.group.matrix);
    return out.applyMatrix4(this.holder.matrix);
  }

  setAspect(a: number): void {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  /** `crouch` — silliqlangan o'tirish ulushi 0..1: o'tirganda qurol chayqalishi kamayadi. */
  update(dt: number, speed: number, onGround: boolean, mouseDX: number, mouseDY: number, crouch = 0): void {
    const hold = HOLD[this.weapon];
    const g = this.guns[this.weapon];
    const crouchK = 1 - 0.45 * THREE.MathUtils.clamp(Number.isFinite(crouch) ? crouch : 0, 0, 1);
    const amp = onGround ? Math.min(1, speed / RUN_SPEED) * crouchK : 0;
    this.bob += dt * (4 + speed * 1.4) * (amp > 0.05 ? 1 : 0);
    this.kick *= Math.exp(-dt * 12);
    this.kickRoll *= Math.exp(-dt * 14);
    this.swayX = THREE.MathUtils.lerp(this.swayX, THREE.MathUtils.clamp(-mouseDX * 0.0009, -0.04, 0.04), dt * 10);
    this.swayY = THREE.MathUtils.lerp(this.swayY, THREE.MathUtils.clamp(mouseDY * 0.0009, -0.04, 0.04), dt * 10);

    let y = hold.y + Math.abs(Math.cos(this.bob)) * 0.012 * amp - 0.006 * amp + this.swayY + this.kick * 0.014;
    const x = hold.x + Math.sin(this.bob) * 0.012 * amp + this.swayX;
    let z = Math.min(hold.z + 0.055, hold.z + this.kick * 0.055);
    let rx = this.kick * 0.16;
    let rz = this.kickRoll;

    // Mexanik qurol qismlari fizikasi (Zatvor, Drobovik pompasi, Snayper zatvori)
    if (this.actionT > 0) {
      this.actionT += dt;
      if (g.slide) {
        if (this.weapon === 'shotgun') {
          // O'q uzilgandan keyin pompani tortib-itarish (0.12s..0.52s)
          const p = THREE.MathUtils.clamp((this.actionT - 0.12) / 0.4, 0, 1);
          const pump = Math.sin(p * Math.PI);
          g.slide.position.z = pump * 0.095;
          rx += pump * 0.08;
        } else if (this.weapon === 'sniper') {
          // Snayper zatvorini ko'tarib orqaga tortish (0.16s..0.78s)
          const p = THREE.MathUtils.clamp((this.actionT - 0.16) / 0.62, 0, 1);
          const cycle = Math.sin(p * Math.PI);
          g.slide.position.z = cycle * 0.085;
          g.slide.rotation.z = -cycle * 0.55;
          rz -= cycle * 0.12;
        } else {
          // Avtomat va to'pponcha zatvori (Blowback)
          g.slide.position.z = Math.max(0, 1 - this.actionT * 14) * 0.065;
        }
      }
      if (this.actionT > 0.85) {
        this.actionT = 0;
        if (g.slide) {
          g.slide.position.z = 0;
          g.slide.rotation.z = 0;
        }
      }
    }

    if (this.stabT > 0) {
      // Sanchish: oldinga tez siltash (0.32 s), uchi biroz pastga, bilak burilishi bilan
      this.stabT += dt;
      const p = Math.min(1, this.stabT / 0.32);
      const s = Math.sin(p * Math.PI);
      const lunge = Math.sin(Math.min(1, p * 1.6) * Math.PI);
      z -= lunge * 0.17;
      y += s * 0.03;
      rx -= s * 0.5;
      rz += s * 0.3;
      if (p >= 1) this.stabT = 0;
    }
    if (this.switchT > 0) {
      this.switchT = Math.max(0, this.switchT - dt);
      const k = this.switchT / this.switchDur;
      y -= k * k * 0.35;
      rx -= k * 0.6;
    }
    if (this.reloadT > 0) {
      this.reloadT = Math.max(0, this.reloadT - dt);
      const p = 1 - this.reloadT / this.reloadDur;
      const s = Math.sin(Math.PI * Math.min(1, p * 1.1));
      y -= s * 0.12;
      rz += s * 0.7;
      rx -= s * 0.25;
      if (g.mag) {
        const magDrop = Math.sin(Math.PI * THREE.MathUtils.clamp((p - 0.1) / 0.75, 0, 1));
        g.mag.position.y = -magDrop * 0.16;
        g.mag.rotation.x = magDrop * 0.25;
      }
    } else if (g.mag) {
      g.mag.position.y = 0;
      g.mag.rotation.x = 0;
    }
    if (this.throwT > 0) {
      this.throwT = Math.max(0, this.throwT - dt);
      const p = 1 - this.throwT / 0.5;
      const s = Math.sin(Math.PI * p);
      y -= s * 0.3;
      this.grenade.visible = p < 0.55;
      this.grenade.position.set(-0.15 + p * 0.1, -0.2 + s * 0.15, -0.4 - p * 0.3);
      this.grenade.rotation.x = p * 5;
    } else {
      this.grenade.visible = false;
    }

    const ry = 0.095 + this.swayX * 0.45;
    this.holder.position.set(x, y, z);
    this.holder.rotation.set(rx + 0.03, ry, rz);
    this.holder.visible = this.visible && !this.unarmed;
    this.holder.updateMatrix();

    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
      }
    }
  }

  dispose(): void {
    this.unsubWeaponReady?.();
    this.unsubWeaponReady = null;
    for (const g of this.ownedGeometries) {
      g.dispose();
    }
    this.ownedGeometries.length = 0;
    const flashMat = this.flash.material as THREE.MeshBasicMaterial;
    flashMat.map?.dispose();
    flashMat.dispose();
    this.sleeveMat.dispose();
  }
}
