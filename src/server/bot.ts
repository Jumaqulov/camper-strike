import { EYE_HEIGHT, RUN_SPEED, WALK_SPEED } from '../shared/constants';
import { anglesFromDir, angleDiff, clamp, dirFromAngles, vcopy, vdist, vnorm, vsub, type Vec3 } from '../shared/math';
import { applyWorldMovement, raycastWorld } from '../shared/physics';
import { WEAPONS, WEAPON_SLOTS, type WeaponId } from '../shared/weapons';
import type { Room, ServerPlayer } from './room';

const BOT_NAMES = [
  'Amaki Bobur',
  'Shofer Vali',
  "Usta Qo'chqor",
  'Sayohatchi Ali',
  'Ovchi Rustam',
  'Oshpaz Jasur',
  'Baliqchi Timur',
  'Mexanik Sardor',
  'Kemper Dilshod',
  "Tog'a Bekzod",
  'Choyxonachi Umid',
  'Dehqon Farrux',
  'Qorovul Otabek',
  'Bog\'bon Javohir',
  'Turist Sherzod',
  'Sartarosh Nodir',
  'Novvoy Akmal',
  'Dam oluvchi Aziz',
  'Cho\'pon Islom',
  'Pensiya Kamol',
];

export function pickBotName(taken: Set<string>): string {
  const free = BOT_NAMES.filter((n) => !taken.has('BOT ' + n));
  const base = free.length ? free[Math.floor(Math.random() * free.length)] : BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + Math.floor(Math.random() * 99);
  return 'BOT ' + base;
}

function pickBotWeapon(): WeaponId {
  const r = Math.random();
  if (r < 0.45) return 'rifle';
  if (r < 0.68) return 'shotgun';
  if (r < 0.80) return 'sniper';
  return 'pistol';
}

/** Server tomonidagi oddiy bot sun'iy intellekti. */
export class BotBrain {
  private skill = 0.15 + Math.random() * 0.30;
  private aimHeight = 0.95;
  private path: Vec3[] = [];
  private pathIdx = 0;
  private repathAt = 0;
  private target: ServerPlayer | null = null;
  private lastSeenPos: Vec3 | null = null;
  private lastSeenAt = -99;
  private reactionUntil = 0;
  private nextScan = 0;
  private strafeDir = 1;
  private strafeUntil = 0;
  private aimOffYaw = 0;
  private aimOffPitch = 0;
  private wobblePhase = Math.random() * Math.PI * 2;
  private burstLeft = 4;
  private nextFireAt = 0;
  private stuckCheckAt = 0;
  private stuckPos: Vec3 = { x: 0, y: 0, z: 0 };
  private stuckCount = 0;
  private lastDamagedAt = -99;
  private pendingAttacker: ServerPlayer | null = null;
  private reactDamageAt = 0;
  private grenadeCheckAt = 0;
  private walkMode = false;

  constructor(private room: Room, private me: ServerPlayer) {}

  onSpawn(): void {
    this.me.weapon = pickBotWeapon();
    this.path = [];
    this.pathIdx = 0;
    this.repathAt = 0;
    this.target = null;
    this.lastSeenPos = null;
    this.pendingAttacker = null;
    this.aimHeight = 0.85 + Math.random() * 0.25;
    this.burstLeft = 3 + Math.floor(Math.random() * 3);
  }

  onDamaged(attacker: ServerPlayer): void {
    const t = this.room.now();
    this.lastDamagedAt = t;
    if (!this.room.isEnemy(this.me, attacker)) return;
    if (!this.target || t - this.lastSeenAt > 0.5) {
      const yawTo = Math.atan2(-(attacker.pos.x - this.me.pos.x), -(attacker.pos.z - this.me.pos.z));
      const inFov = Math.abs(angleDiff(this.me.yaw, yawTo)) < 1.25;
      if (inFov) {
        this.target = attacker;
        this.lastSeenPos = vcopy(attacker.pos);
        this.lastSeenAt = t - 0.4;
      } else {
        this.pendingAttacker = attacker;
        this.reactDamageAt = t + 0.6;
      }
    }
  }

  private eye(): Vec3 {
    return { x: this.me.pos.x, y: this.me.pos.y + EYE_HEIGHT, z: this.me.pos.z };
  }

  private canSee(o: ServerPlayer): boolean {
    const eye = this.eye();
    for (const h of [1.3, 1.65]) {
      const p = { x: o.pos.x, y: o.pos.y + h, z: o.pos.z };
      const d = vdist(eye, p);
      const dir = vnorm(vsub(p, eye));
      const hit = raycastWorld(this.room.world, eye, dir, d);
      if (!hit) return true;
    }
    return false;
  }

  private findVisibleEnemy(t: number): ServerPlayer | null {
    let best: ServerPlayer | null = null;
    let bestD = Infinity;
    const sinceDmg = t - this.lastDamagedAt;
    const alertRear = sinceDmg >= 0.6 && sinceDmg <= 2.2;
    for (const o of this.room.players.values()) {
      if (o === this.me || !o.alive || !this.room.isEnemy(this.me, o)) continue;
      const d = vdist(this.me.pos, o.pos);
      if (d > 80 || d >= bestD) continue;
      const yawTo = Math.atan2(-(o.pos.x - this.me.pos.x), -(o.pos.z - this.me.pos.z));
      const inFov = Math.abs(angleDiff(this.me.yaw, yawTo)) < 1.25;
      if (!inFov && !alertRear) continue;
      if (!this.canSee(o)) continue;
      best = o;
      bestD = d;
    }
    return best;
  }

  private pickRoamGoal(): Vec3 {
    const nav = this.room.nav;
    if (this.room.opts.mode === 'tdm' && Math.random() < 0.55) {
      const enemyTeam = this.me.team === 'red' ? 'blue' : 'red';
      const sp = this.room.world.spawnPoints.filter((s) => s.team === enemyTeam);
      const s = sp[Math.floor(Math.random() * sp.length)];
      return { x: s.x, y: s.y, z: s.z };
    }
    return nav.randomPoint();
  }

  private turnTowards(yaw: number, pitch: number, rate: number, dt: number) {
    const me = this.me;
    const turn = rate * dt;
    me.yaw += clamp(angleDiff(me.yaw, yaw), -turn, turn);
    me.pitch += clamp(pitch - me.pitch, -turn, turn);
  }

  update(dt: number, t: number): void {
    const me = this.me;
    if (!me.alive) return;
    if (this.room.phase !== 'playing') {
      applyWorldMovement(me, 0, 0, false, dt, this.room.world);
      return;
    }

    if (this.pendingAttacker && t >= this.reactDamageAt) {
      if (this.pendingAttacker.alive && (!this.target || t - this.lastSeenAt > 0.5)) {
        this.lastSeenPos = vcopy(this.pendingAttacker.pos);
        this.lastSeenAt = t - 0.4;
      }
      this.pendingAttacker = null;
    }

    // --- Ko'rish ---
    if (t >= this.nextScan) {
      this.nextScan = t + 0.14 + Math.random() * 0.10;
      const vis = this.findVisibleEnemy(t);
      if (vis) {
        if (vis !== this.target || t - this.lastSeenAt > 1.0) {
          this.reactionUntil = t + 0.75 + Math.random() * 0.55;
          const err = 1.2 - this.skill;
          this.aimOffYaw = (Math.random() - 0.5) * 0.36 * err;
          this.aimOffPitch = (Math.random() - 0.5) * 0.22 * err;
          this.burstLeft = 3 + Math.floor(Math.random() * 3);
        }
        this.target = vis;
        this.lastSeenPos = vcopy(vis.pos);
        this.lastSeenAt = t;
      } else if (this.target && (!this.target.alive || t - this.lastSeenAt > 6)) {
        this.target = null;
      }
    }
    const visible = !!this.target && this.target.alive && t - this.lastSeenAt < 0.35;

    let wishX = 0;
    let wishZ = 0;
    let jump = false;
    const activeWeapon: WeaponId = me.weapon ?? 'rifle';
    const def = WEAPONS[activeWeapon];
    const speed = RUN_SPEED * def.speedMul;

    if (visible && this.target) {
      // --- Jang ---
      const tgt = this.target;
      const eye = this.eye();
      const aimPt = {
        x: tgt.pos.x + tgt.vel.x * 0.03,
        y: tgt.pos.y + this.aimHeight,
        z: tgt.pos.z + tgt.vel.z * 0.03,
      };
      const { yaw, pitch } = anglesFromDir(vsub(aimPt, eye));
      const decay = Math.exp(-dt * (0.9 + this.skill * 0.9));
      this.aimOffYaw *= decay;
      this.aimOffPitch *= decay;
      const wobbleAmp = 0.06 + (1 - this.skill) * 0.04;
      const wobbleYaw = Math.sin(t * 2.7 + this.wobblePhase) * wobbleAmp;
      const wobblePitch = Math.cos(t * 2.1 + this.wobblePhase * 1.3) * (wobbleAmp * 0.65);
      const aimYaw = yaw + this.aimOffYaw + wobbleYaw;
      const aimPitch = pitch + this.aimOffPitch + wobblePitch;
      this.turnTowards(aimYaw, aimPitch, 1.8 + this.skill * 2.2, dt);
      const err = Math.abs(angleDiff(me.yaw, aimYaw)) + Math.abs(me.pitch - aimPitch);
      const roughErr = Math.abs(angleDiff(me.yaw, yaw));
      const d = vdist(me.pos, tgt.pos);
      const tol = Math.max(0.05, 0.6 / Math.max(d, 1)) + (1 - this.skill) * 0.07;
      if (t >= this.reactionUntil && t >= this.nextFireAt && err < tol + 0.06 && roughErr < 0.35) {
        const extraSpread = 0.055 + (1 - this.skill) * 0.065;
        if (this.room.botFire(me, extraSpread)) {
          let extra: number;
          if (def.auto) {
            this.burstLeft--;
            if (this.burstLeft <= 0) {
              this.burstLeft = 3 + Math.floor(Math.random() * 3);
              extra = 0.45 + Math.random() * 0.55;
            } else {
              extra = 0.04 + Math.random() * 0.06;
            }
          } else {
            extra = 0.45 + Math.random() * 0.6;
          }
          this.nextFireAt = t + def.fireInterval + extra;
        }
      }
      // Jangovar harakat: yonga qochish (sekinroq, oddiy o'yinchidek)
      const dx = tgt.pos.x - me.pos.x;
      const dz = tgt.pos.z - me.pos.z;
      const dl = Math.hypot(dx, dz) || 1;
      const fx = dx / dl;
      const fz = dz / dl;
      if (t >= this.strafeUntil) {
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        this.strafeUntil = t + 0.6 + Math.random() * 1.2;
      }
      if (activeWeapon !== 'sniper') {
        wishX = -fz * this.strafeDir * speed * 0.48;
        wishZ = fx * this.strafeDir * speed * 0.48;
      }
      if (activeWeapon === 'shotgun' && d > 7) {
        wishX += fx * speed * 0.7;
        wishZ += fz * speed * 0.7;
      } else if (d < 4) {
        wishX -= fx * speed * 0.45;
        wishZ -= fz * speed * 0.45;
      }
      const wl = Math.hypot(wishX, wishZ);
      if (wl > speed) {
        wishX = (wishX / wl) * speed;
        wishZ = (wishZ / wl) * speed;
      }
      if (me.onGround && wl > 0.1 && Math.hypot(me.vel.x, me.vel.z) < 0.3) this.strafeDir *= -1;
      if (Math.random() < 0.004) jump = true;
      this.repathAt = 0; // jangdan keyin yangi yo'l
    } else {
      // --- Navigatsiya ---
      const nav = this.room.nav;
      if (t >= this.repathAt || this.pathIdx >= this.path.length) {
        let goal: Vec3;
        const hunting = this.lastSeenPos && t - this.lastSeenAt < 8;
        if (hunting && this.lastSeenPos) {
          goal = this.lastSeenPos;
          if (vdist(goal, me.pos) < 2) {
            this.lastSeenPos = null;
            goal = this.pickRoamGoal();
          }
        } else {
          goal = this.pickRoamGoal();
        }
        this.path = nav.findPath(me.pos, goal);
        this.pathIdx = 0;
        this.repathAt = t + 4 + Math.random() * 3;
        this.walkMode = Math.random() < 0.15;
      }
      let lookYaw = me.yaw;
      if (this.pathIdx < this.path.length) {
        const node = this.path[this.pathIdx];
        const dx = node.x - me.pos.x;
        const dz = node.z - me.pos.z;
        const dl = Math.hypot(dx, dz);
        if (dl < 0.8) {
          this.pathIdx++;
        } else {
          const sp = this.walkMode ? WALK_SPEED : speed;
          wishX = (dx / dl) * sp;
          wishZ = (dz / dl) * sp;
          lookYaw = Math.atan2(-dx, -dz);
        }
      }
      if (this.lastSeenPos && t - this.lastSeenAt < 4) {
        const d = vsub(this.lastSeenPos, me.pos);
        lookYaw = Math.atan2(-d.x, -d.z);
      }
      this.turnTowards(lookYaw, 0, 4, dt);

      // Tiqilib qolishni aniqlash
      if (t >= this.stuckCheckAt) {
        const moved = Math.hypot(me.pos.x - this.stuckPos.x, me.pos.z - this.stuckPos.z);
        if (moved < 0.6 && (wishX || wishZ)) {
          jump = true;
          this.stuckCount++;
          this.repathAt = 0;
          if (this.stuckCount > 2) {
            this.lastSeenPos = null;
            this.stuckCount = 0;
          }
        } else {
          this.stuckCount = 0;
        }
        this.stuckPos = vcopy(me.pos);
        this.stuckCheckAt = t + 1.2;
      }

      // Granata otish
      if (this.lastSeenPos && t >= this.grenadeCheckAt && t - this.lastSeenAt > 0.8 && t - this.lastSeenAt < 4) {
        this.grenadeCheckAt = t + 2;
        const d = vdist(me.pos, this.lastSeenPos);
        if (me.grenades > 0 && Math.random() < 0.3 && d > 8 && d < 28) {
          const dd = vsub(this.lastSeenPos, me.pos);
          const yaw = Math.atan2(-dd.x, -dd.z);
          this.room.throwGrenade(me, dirFromAngles(yaw, 0.22 + d * 0.007));
        }
      }
    }

    applyWorldMovement(me, wishX, wishZ, jump, dt, this.room.world);

    // --- O'q-dorilar ---
    const ammo = me.ammo[activeWeapon];
    if (!me.reloadWeapon) {
      if (ammo.mag === 0) {
        if (ammo.reserve > 0) this.room.startReload(me);
        else {
          const alt = WEAPON_SLOTS.find((w) => me.ammo[w].mag + me.ammo[w].reserve > 0);
          if (alt) me.weapon = alt;
        }
      } else if (!visible && ammo.mag < WEAPONS[activeWeapon].magSize * 0.4 && ammo.reserve > 0) {
        this.room.startReload(me);
      }
    }
  }
}
