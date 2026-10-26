import * as THREE from 'three';
import type { WeaponId } from '../../shared/weapons';
import { buildGun } from './GunModels';
import { radialTexture } from './Textures';

class ParticlePool {
  readonly points: THREE.Points;
  private count = 0;
  private pos: Float32Array;
  private col: Float32Array;
  private base: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;

  constructor(private max: number, size: number, blending: THREE.Blending, tex: THREE.Texture, private gravity: number, private fade: boolean) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.base = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({
      size, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending, sizeAttenuation: true, alphaTest: 0.01,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, c: THREE.Color, life: number) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.base.set([c.r, c.g, c.b], i * 3);
    this.col.set([c.r, c.g, c.b], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt: number, groundAt?: (x: number, z: number) => number) {
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.count;
        if (i !== last) {
          this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
          this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
          this.base.copyWithin(i * 3, last * 3, last * 3 + 3);
          this.col.copyWithin(i * 3, last * 3, last * 3 + 3);
          this.life[i] = this.life[last];
          this.maxLife[i] = this.maxLife[last];
        }
        i--;
        continue;
      }
      const j = i * 3;
      this.vel[j + 1] -= this.gravity * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      // Yer sathi relyefli xaritalarda (forest_square) y=0 emas — haqiqiy balandlikni olamiz
      const floorY = (groundAt ? groundAt(this.pos[j], this.pos[j + 2]) : 0) + 0.02;
      if (this.pos[j + 1] < floorY) {
        this.pos[j + 1] = floorY;
        this.vel[j] *= 0.5;
        this.vel[j + 1] *= -0.3;
        this.vel[j + 2] *= 0.5;
      }
      if (this.fade) {
        const k = this.life[i] / this.maxLife[i];
        this.col[j] = this.base[j] * k;
        this.col[j + 1] = this.base[j + 1] * k;
        this.col[j + 2] = this.base[j + 2] * k;
      }
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, this.count);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
}

interface Timed<T> {
  obj: T;
  life: number;
  max: number;
}

interface ShellCasing {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  life: number;
}

interface DroppedWeapon {
  group: THREE.Group;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  groundY: number;
  life: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();

/** Vizual va fizik effektlar: 3D uchuvchi gilzalar, qurol tutuni, o'q izlari, uchqunlar, qon, portlashlar. */
export class Effects {
  private sparks: ParticlePool;
  private blood: ParticlePool;
  private debris: ParticlePool;
  private tracers: Timed<THREE.Mesh>[] = [];
  private tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  private shells: ShellCasing[] = [];
  private droppedWeapons: DroppedWeapon[] = [];
  private brassShellGeo = new THREE.CylinderGeometry(0.0085, 0.0095, 0.042, 8);
  private shotgunShellGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.056, 8);
  private brassShellMat = new THREE.MeshStandardMaterial({ color: '#f2be42', metalness: 0.85, roughness: 0.22 });
  private shotgunShellMat = new THREE.MeshStandardMaterial({ color: '#e62e2e', roughness: 0.35 });
  private decals: THREE.Mesh[] = [];
  private decalIdx = 0;
  private decalGeo = new THREE.PlaneGeometry(0.11, 0.11);
  private decalMat: THREE.MeshBasicMaterial;
  private smokeTex: THREE.Texture;
  private smokes: Timed<THREE.Sprite>[] = [];
  private fireballs: Timed<THREE.Mesh>[] = [];
  private fireGeo = new THREE.SphereGeometry(1, 16, 12);
  private boomLight: THREE.PointLight;
  private boomT = 0;
  /** Xarita relyefi balandligi (x, z) → y. Berilmasa yer y=0 deb olinadi (dust_arena). */
  groundAt: ((x: number, z: number) => number) | null = null;

  constructor(private scene: THREE.Scene) {
    const dot = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
    this.sparks = new ParticlePool(600, 0.09, THREE.AdditiveBlending, dot, 9, true);
    this.blood = new ParticlePool(400, 0.1, THREE.NormalBlending, radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'), 9, false);
    this.debris = new ParticlePool(400, 0.07, THREE.NormalBlending, dot, 12, false);
    scene.add(this.sparks.points, this.blood.points, this.debris.points);

    this.decalMat = new THREE.MeshBasicMaterial({
      map: radialTexture('rgba(20,15,10,0.95)', 'rgba(20,15,10,0)'),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    for (let i = 0; i < 80; i++) {
      const m = new THREE.Mesh(this.decalGeo, this.decalMat);
      m.visible = false;
      scene.add(m);
      this.decals.push(m);
    }
    this.smokeTex = radialTexture('rgba(200,200,200,0.9)', 'rgba(200,200,200,0)', 128);
    this.boomLight = new THREE.PointLight('#ffaa55', 0, 30, 1.6);
    scene.add(this.boomLight);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color = '#ffe9a0', width = 0.015, life = 0.085): void {
    const len = from.distanceTo(to);
    if (len < 0.5) return;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const m = new THREE.Mesh(this.tracerGeo, mat);
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UP, tmpV.copy(to).sub(from).normalize());
    m.scale.set(width, len, width);
    this.scene.add(m);
    this.tracers.push({ obj: m, life, max: life });
  }

  /** Qurol turiga mos ballistik o'q izi (Sniper bug' chizig'i, Drobovik olovli sochmasi va h.k.) */
  weaponTracer(from: THREE.Vector3, to: THREE.Vector3, weapon: WeaponId): void {
    switch (weapon) {
      case 'sniper': {
        this.tracer(from, to, '#58ffe8', 0.026, 0.18);
        this.tracer(from, to, '#ffffff', 0.011, 0.14);
        // Snayper o'qi havoni yorib o'tganda qoladigan tutun halqalari
        const dist = Math.min(45, from.distanceTo(to));
        const steps = Math.min(6, Math.floor(dist / 6));
        for (let i = 1; i <= steps; i++) {
          const s = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: this.smokeTex, color: '#dceef2', transparent: true, depthWrite: false, opacity: 0.35 }),
          );
          s.position.copy(from).lerp(to, (i * 6) / Math.max(1, from.distanceTo(to)));
          s.scale.setScalar(0.32);
          s.userData.vy = 0.25;
          s.userData.grow = 1.4;
          this.scene.add(s);
          this.smokes.push({ obj: s, life: 0.65, max: 0.65 });
        }
        break;
      }
      case 'shotgun':
        this.tracer(from, to, '#ffb040', 0.014, 0.075);
        break;
      case 'pistol':
        this.tracer(from, to, '#ffe28a', 0.014, 0.08);
        break;
      case 'rifle':
      default:
        this.tracer(from, to, '#ffea94', 0.016, 0.085);
        break;
    }
  }

  /** Stvoldan chiqadigan porox tutuni va olov uchqunlari + 3D uchib tushadigan gilza fizikasi */
  muzzleBlast(muzzlePos: THREE.Vector3, ejectPos: THREE.Vector3, rightDir: THREE.Vector3, weapon: WeaponId): void {
    // 1. Stvol tutuni
    const puff = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.smokeTex, color: '#d8d2c5', transparent: true, depthWrite: false, opacity: 0.48 }),
    );
    puff.position.copy(muzzlePos);
    puff.scale.setScalar(weapon === 'shotgun' || weapon === 'sniper' ? 0.52 : 0.32);
    puff.userData.vy = 0.55;
    puff.userData.grow = 1.8;
    this.scene.add(puff);
    this.smokes.push({ obj: puff, life: 0.45, max: 0.45 });

    // 2. 3D Gilza otilib chiqishi va yerga urilib sakrash fizikasi
    const isShotgun = weapon === 'shotgun';
    const mesh = new THREE.Mesh(
      isShotgun ? this.shotgunShellGeo : this.brassShellGeo,
      isShotgun ? this.shotgunShellMat : this.brassShellMat,
    );
    mesh.position.copy(ejectPos);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    mesh.castShadow = true;
    this.scene.add(mesh);

    const speedR = 1.8 + Math.random() * 1.4;
    const vel = new THREE.Vector3(
      rightDir.x * speedR + (Math.random() - 0.5) * 0.6,
      1.6 + Math.random() * 1.1,
      rightDir.z * speedR + (Math.random() - 0.5) * 0.6,
    );
    const rotVel = new THREE.Vector3(
      (Math.random() - 0.5) * 28,
      (Math.random() - 0.5) * 28,
      (Math.random() - 0.5) * 28,
    );
    this.shells.push({ mesh, vel, rotVel, life: 3.2 });
    if (this.shells.length > 45) {
      const old = this.shells.shift()!;
      this.scene.remove(old.mesh);
    }
  }

  private disposeDroppedGroup(group: THREE.Object3D): void {
    this.scene.remove(group);
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (o.geometry && !o.geometry.userData?.sharedAsset) {
          o.geometry.dispose();
        }
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m && !m.userData?.sharedAsset) {
            m.dispose();
          }
        }
      }
    });
  }

  /** O'yinchi o'lganda qo'lidagi 3D qurolning otilib chiqib yerga tushishi (Weapon Drop Physics) */
  dropWeapon(playerPos: THREE.Vector3, yaw: number, weapon: WeaponId): void {
    const group = buildGun(weapon, '3p').group;
    group.scale.setScalar(1.32);
    const groundY = Math.max(0.05, playerPos.y + 0.05);
    group.position.set(
      playerPos.x - Math.sin(yaw) * 0.35,
      playerPos.y + 1.05,
      playerPos.z - Math.cos(yaw) * 0.35,
    );
    group.rotation.set(0.2, yaw, (Math.random() < 0.5 ? 1 : -1) * 0.3);
    this.scene.add(group);

    const side = (Math.random() - 0.5) * 2.2;
    const fwd = 1.6 + Math.random() * 1.6;
    const vel = new THREE.Vector3(
      -Math.sin(yaw) * fwd + Math.cos(yaw) * side,
      2.6 + Math.random() * 1.4,
      -Math.cos(yaw) * fwd - Math.sin(yaw) * side,
    );
    const rotVel = new THREE.Vector3(
      (Math.random() - 0.5) * 9,
      (Math.random() - 0.5) * 8,
      (Math.random() < 0.5 ? 1 : -1) * (6 + Math.random() * 5),
    );
    this.droppedWeapons.push({ group, vel, rotVel, groundY, life: 6.5 });
    if (this.droppedWeapons.length > 16) {
      const old = this.droppedWeapons.shift()!;
      this.disposeDroppedGroup(old.group);
    }
  }

  impact(p: THREE.Vector3, n: THREE.Vector3): void {
    for (let i = 0; i < 7; i++) {
      const v = new THREE.Vector3(n.x + (Math.random() - 0.5) * 1.4, n.y + (Math.random() - 0.5) * 1.4 + 0.3, n.z + (Math.random() - 0.5) * 1.4).multiplyScalar(2 + Math.random() * 3);
      this.sparks.spawn(p, v, tmpC.set('#ffd27a'), 0.2 + Math.random() * 0.2);
    }
    for (let i = 0; i < 5; i++) {
      const v = new THREE.Vector3(n.x + (Math.random() - 0.5), n.y + Math.random() * 0.8, n.z + (Math.random() - 0.5)).multiplyScalar(1.5 + Math.random() * 2);
      this.debris.spawn(p, v, tmpC.set('#8a7a60'), 0.5 + Math.random() * 0.4);
    }
    const d = this.decals[this.decalIdx];
    this.decalIdx = (this.decalIdx + 1) % this.decals.length;
    d.position.copy(p).addScaledVector(n, 0.012);
    d.lookAt(tmpV.copy(d.position).add(n));
    d.rotation.z = Math.random() * Math.PI;
    d.visible = true;
  }

  bloodHit(p: THREE.Vector3, big = false): void {
    const n = big ? 22 : 12;
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3);
      this.blood.spawn(p, v, tmpC.set(Math.random() < 0.5 ? '#a00000' : '#d01010'), 0.4 + Math.random() * 0.4);
    }
  }

  explosion(p: THREE.Vector3): void {
    const fire = new THREE.Mesh(
      this.fireGeo,
      new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    fire.position.copy(p);
    fire.scale.setScalar(0.3);
    this.scene.add(fire);
    this.fireballs.push({ obj: fire, life: 0.45, max: 0.45 });
    for (let i = 0; i < 90; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(4 + Math.random() * 14);
      this.sparks.spawn(p, v, tmpC.setHSL(0.08 + Math.random() * 0.05, 1, 0.55 + Math.random() * 0.2), 0.4 + Math.random() * 0.7);
    }
    for (let i = 0; i < 30; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).multiplyScalar(8);
      this.debris.spawn(p, v, tmpC.set('#3a3020'), 0.8 + Math.random() * 0.6);
    }
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, color: '#777064', transparent: true, depthWrite: false, opacity: 0.8 }));
      s.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 2.5, Math.random() * 1.5, (Math.random() - 0.5) * 2.5));
      s.scale.setScalar(1.5 + Math.random() * 1.5);
      s.userData.vy = 0.6 + Math.random() * 0.8;
      s.userData.grow = 1.2 + Math.random();
      this.scene.add(s);
      const life = 2 + Math.random() * 1.5;
      this.smokes.push({ obj: s, life, max: life });
    }
    this.boomLight.position.copy(p).add(new THREE.Vector3(0, 1, 0));
    this.boomLight.intensity = 60;
    this.boomT = 0.35;
  }

  update(dt: number): void {
    const groundAt = this.groundAt ?? undefined;
    this.sparks.update(dt, groundAt);
    this.blood.update(dt, groundAt);
    this.debris.update(dt, groundAt);

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.scene.remove(t.obj);
        (t.obj.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      } else {
        (t.obj.material as THREE.MeshBasicMaterial).opacity = 0.85 * (t.life / t.max);
      }
    }
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i];
      f.life -= dt;
      const k = 1 - f.life / f.max;
      f.obj.scale.setScalar(0.3 + k * 4.2);
      const m = f.obj.material as THREE.MeshBasicMaterial;
      m.opacity = Math.max(0, 1 - k);
      m.color.setHSL(0.1 - k * 0.08, 1, 0.6 - k * 0.3);
      if (f.life <= 0) {
        this.scene.remove(f.obj);
        m.dispose();
        this.fireballs.splice(i, 1);
      }
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.life -= dt;
      s.obj.position.y += s.obj.userData.vy * dt;
      s.obj.scale.multiplyScalar(1 + s.obj.userData.grow * dt * 0.3);
      s.obj.material.opacity = 0.75 * (s.life / s.max);
      if (s.life <= 0) {
        this.scene.remove(s.obj);
        s.obj.material.dispose();
        this.smokes.splice(i, 1);
      }
    }
    // 3D uchib chiqqan gilzalarning gravitatsiya va yerga urilib sakrash fizikasi
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i];
      sh.life -= dt;
      if (sh.life <= 0) {
        this.scene.remove(sh.mesh);
        this.shells.splice(i, 1);
        continue;
      }
      sh.vel.y -= 14.5 * dt;
      sh.mesh.position.addScaledVector(sh.vel, dt);
      sh.mesh.rotation.x += sh.rotVel.x * dt;
      sh.mesh.rotation.y += sh.rotVel.y * dt;
      sh.mesh.rotation.z += sh.rotVel.z * dt;
      const shellFloor = (groundAt ? groundAt(sh.mesh.position.x, sh.mesh.position.z) : 0) + 0.025;
      if (sh.mesh.position.y < shellFloor) {
        sh.mesh.position.y = shellFloor;
        sh.vel.y = -sh.vel.y * 0.42;
        sh.vel.x *= 0.62;
        sh.vel.z *= 0.62;
        sh.rotVel.multiplyScalar(0.55);
      }
    }
    // O'lganda yerga tushgan 3D qurollar fizikasi (gravitatsiya, sakrash va yonbosh yotib qolish)
    for (let i = this.droppedWeapons.length - 1; i >= 0; i--) {
      const dw = this.droppedWeapons[i];
      dw.life -= dt;
      if (dw.life <= 0) {
        this.disposeDroppedGroup(dw.group);
        this.droppedWeapons.splice(i, 1);
        continue;
      }
      dw.vel.y -= 15.5 * dt;
      dw.group.position.addScaledVector(dw.vel, dt);
      if (dw.group.position.y > dw.groundY + 0.02) {
        dw.group.rotation.x += dw.rotVel.x * dt;
        dw.group.rotation.y += dw.rotVel.y * dt;
        dw.group.rotation.z += dw.rotVel.z * dt;
      } else {
        dw.group.position.y = dw.groundY;
        if (Math.abs(dw.vel.y) > 0.8) {
          dw.vel.y = -dw.vel.y * 0.35;
          dw.vel.x *= 0.55;
          dw.vel.z *= 0.55;
          dw.rotVel.multiplyScalar(0.45);
        } else {
          dw.vel.set(0, 0, 0);
          const sideSign = dw.group.rotation.z >= 0 ? 1 : -1;
          dw.group.rotation.x = THREE.MathUtils.lerp(dw.group.rotation.x, 0, dt * 12);
          dw.group.rotation.z = THREE.MathUtils.lerp(dw.group.rotation.z, sideSign * (Math.PI / 2 - 0.08), dt * 12);
        }
      }
      if (dw.life < 0.8) {
        dw.group.scale.setScalar(1.36 * (dw.life / 0.8));
      }
    }
    if (this.boomT > 0) {
      this.boomT -= dt;
      this.boomLight.intensity = Math.max(0, (this.boomT / 0.35) * 60);
    }
  }

  dispose(): void {
    for (const t of this.tracers) (t.obj.material as THREE.Material).dispose();
    for (const f of this.fireballs) (f.obj.material as THREE.Material).dispose();
    for (const s of this.smokes) s.obj.material.dispose();
    for (const sh of this.shells) this.scene.remove(sh.mesh);
    for (const dw of this.droppedWeapons) this.disposeDroppedGroup(dw.group);
    this.sparks.points.geometry.dispose();
    (this.sparks.points.material as THREE.Material).dispose();
    this.blood.points.geometry.dispose();
    (this.blood.points.material as THREE.Material).dispose();
    this.debris.points.geometry.dispose();
    (this.debris.points.material as THREE.Material).dispose();
    this.tracerGeo.dispose();
    this.brassShellGeo.dispose();
    this.shotgunShellGeo.dispose();
    this.brassShellMat.dispose();
    this.shotgunShellMat.dispose();
    this.decalGeo.dispose();
    this.decalMat.dispose();
    this.fireGeo.dispose();
  }
}
