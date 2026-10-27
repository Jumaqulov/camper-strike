import { RUN_SPEED, WALK_SPEED } from '../shared/constants';
import { anglesFromDir, angleDiff, clamp, dirFromAngles, vcopy, vdist, vnorm, vsub, type Vec3 } from '../shared/math';
import { applyWorldMovement, collidesAtWorld, raycastWorld } from '../shared/physics';
import {
  DEFAULT_CONTAINER_EXTRA_MARGIN_M,
  GROUND_ITEM_PICKUP_RADIUS_M,
  hasLineOfSightToContainer,
  type PlayerInventorySnap,
  type PublicContainerState,
  type PublicLootItem,
} from '../shared/loot';
import { eyeHeightOf, hitboxScaleOf } from '../shared/stance';
import { sampleTerrainHeight } from '../shared/world';
import { WEAPONS, WEAPON_SLOTS, isMeleeWeapon, type WeaponId } from '../shared/weapons';
import { findLocalPath, standingHeights } from './botLocalPath';
import { applyAuthoritativeWeaponSwitch } from './combat/weaponSwitchAuthority';
import type { Room, ServerPlayer } from './room';

/** Bot uchun qurol afzalligi (loot rejimida eng yaxshisini qo'lga oladi). */
const BOT_WEAPON_PREFERENCE: WeaponId[] = ['rifle', 'sniper', 'shotgun', 'pistol', 'knife'];
/** Loot buyumlari ustuvorligi (konteyner ichidan olish tartibi). */
const LOOT_KIND_PRIORITY: Record<PublicLootItem['kind'], number> = {
  weapon: 0,
  ammo: 1,
  armor: 2,
  helmet: 3,
  medkit: 4,
  grenade: 5,
};

interface BotLootTarget {
  kind: 'container' | 'ground';
  id: string;
  pos: Vec3;
  /** Konteyner uchun interaktiv radius; yer buyumi uchun olish radiusi. */
  reach: number;
  /** Yo'l maqsadi (konteyner oldi) — `candidates[approachIdx]`. */
  approach: Vec3;
  /** Ko'rinish (LOS) tekshiruvidan o'tgan yondashuv nuqtalari; ochish muvaffaqiyatsiz bo'lsa keyingisi sinaladi. */
  candidates: Vec3[];
  approachIdx: number;
  /** Shu vaqtgacha yetib bormasa — tashlab yuboriladi. */
  deadline: number;
  /** Yondashuv nuqtasiga 1.6 m yaqinlashgan vaqt (aniq yetib bo'lmasa, biroz kutib shu yerdan urinamiz). */
  nearSince: number;
}

interface ZoneTargetCircle {
  cx: number;
  cz: number;
  r: number;
}

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
  /** Survival: zona markazi (zonadan tashqarida zarar olganda o'rnatiladi). */
  private zoneGoal: Vec3 | null = null;
  // --- Loot AI (lootEnabled xonalar) ---
  private lootTarget: BotLootTarget | null = null;
  private lootBlacklist = new Map<string, number>();
  private lootSkippedItems = new Set<string>();
  private nextLootThinkAt = 0;
  private nextLootActAt = 0;
  private lootTries = 0;
  private nextMedkitAt = 0;
  private zoneGoalPoint: Vec3 | null = null;
  private zoneGoalAt = -99;
  private lastGoalKey = '';
  /** Joriy yo'l mahalliy (0.8 m katak) — tugun yaqinlik chegarasi kichikroq. */
  private pathIsLocal = false;

  constructor(private room: Room, private me: ServerPlayer) {}

  onSpawn(): void {
    // Loot rejimida bot qurolsiz boshlaydi (inventar bo'sh) — tasodifiy qurol faqat klassik rejimda
    if (!this.room.lootEnabled) {
      // Botlarda almashtirish cooldown'i yo'q — fromAutoPickup switchUntil'ni 0 da qoldiradi
      applyAuthoritativeWeaponSwitch(this.me, pickBotWeapon(), this.room.now(), { fromAutoPickup: true });
    }
    this.path = [];
    this.pathIdx = 0;
    this.repathAt = 0;
    this.target = null;
    this.lastSeenPos = null;
    this.pendingAttacker = null;
    this.aimHeight = 0.85 + Math.random() * 0.25;
    this.burstLeft = 3 + Math.floor(Math.random() * 3);
    this.lootTarget = null;
    this.lootBlacklist.clear();
    this.lootSkippedItems.clear();
    this.nextLootThinkAt = 0;
    this.zoneGoal = null;
    this.zoneGoalPoint = null;
    this.lastGoalKey = '';
  }

  /** Xavfsiz zonadan tashqarida zarar oldi — zona markazi tomon yo'l oladi (survival). */
  onZoneDamaged(cx: number, cz: number): void {
    this.zoneGoal = { x: cx, y: this.me.pos.y, z: cz };
    this.zoneGoalPoint = null;
    this.repathAt = 0;
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
    // Botlar o'tirmaydi, lekin ko'z balandligi umumiy qoidadan olinadi
    return { x: this.me.pos.x, y: this.me.pos.y + eyeHeightOf(this.me), z: this.me.pos.z };
  }

  private canSee(o: ServerPlayer): boolean {
    const eye = this.eye();
    // O'tirgan nishonning ko'krak/bosh nuqtalari pastroq (xitboks koeffitsienti bilan)
    const s = hitboxScaleOf(o);
    for (const h of [1.3, 1.65]) {
      const p = { x: o.pos.x, y: o.pos.y + h * s, z: o.pos.z };
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
    const zt = this.zoneTarget();
    if (zt) {
      // Survival: faqat xavfsiz zona (maqsad aylana) ichidagi nuqtalar
      for (let i = 0; i < 12; i++) {
        const p = nav.randomPoint();
        if (Math.hypot(p.x - zt.cx, p.z - zt.cz) < zt.r - 3) return p;
      }
      return { x: zt.cx, y: this.me.pos.y, z: zt.cz };
    }
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

  // ---------------- Survival zona ----------------

  /** Maqsad (keyingi) aylana; butun xaritani qoplaydigan boshlang'ich zona uchun null. */
  private zoneTarget(): ZoneTargetCircle | null {
    const z = this.room.getZoneSnap();
    if (!z || z.targetRadius >= 150) return null;
    return { cx: z.targetCx, cz: z.targetCz, r: z.targetRadius };
  }

  /** Nuqta aylana ichida (chetidan `margin` m ichkarida) mi. */
  private insideCircle(p: Vec3, c: ZoneTargetCircle, margin: number): boolean {
    return Math.hypot(p.x - c.cx, p.z - c.cz) < c.r - margin;
  }

  /** Zona ichidagi tasodifiy nuqta (2 s kesh) — bot markazga to'planib qolmasin. */
  private pickZoneGoal(zt: ZoneTargetCircle, t: number): Vec3 {
    if (!this.zoneGoalPoint || t - this.zoneGoalAt > 2 || !this.insideCircle(this.zoneGoalPoint, zt, 1)) {
      const ang = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * Math.max(0, zt.r - 4) * 0.6;
      this.zoneGoalPoint = { x: zt.cx + Math.cos(ang) * d, y: this.me.pos.y, z: zt.cz + Math.sin(ang) * d };
      this.zoneGoalAt = t;
    }
    return this.zoneGoalPoint;
  }

  // ---------------- Loot AI ----------------

  private lootBlacklisted(id: string, t: number): boolean {
    const until = this.lootBlacklist.get(id);
    if (until === undefined) return false;
    if (t >= until) {
      this.lootBlacklist.delete(id);
      return false;
    }
    return true;
  }

  /** 2 — qurol/o'q yo'q (shoshilinch), 1 — jihoz/aptechka/o'q kerak, 0 — kerak emas. */
  private lootNeed(inv: PlayerInventorySnap | null): 0 | 1 | 2 {
    const me = this.me;
    if (!inv) return 0;
    const w = me.weapon;
    if (!w || inv.ownedWeapons.length === 0) return 2;
    // Pichoq bilan ham o'qotar qurol shoshilinch kerak
    const ammoTotal = isMeleeWeapon(w) ? 0 : me.ammo[w].mag + me.ammo[w].reserve;
    if (ammoTotal <= 0) return 2;
    if (
      inv.armor <= 0 ||
      inv.helmet <= 0 ||
      inv.medkits < 1 ||
      inv.grenades < 1 ||
      me.ammo[w].reserve < WEAPONS[w].magSize ||
      inv.ownedWeapons.length < 2
    ) {
      return 1;
    }
    return 0;
  }

  private wantsItem(it: PublicLootItem, inv: PlayerInventorySnap): boolean {
    if (this.lootSkippedItems.has(it.id)) return false;
    switch (it.kind) {
      case 'weapon': {
        const w = it.weaponId;
        if (!w) return false;
        if (inv.ownedWeapons.includes(w)) return false;
        return inv.ownedWeapons.length < inv.maxWeaponSlots;
      }
      case 'ammo': {
        const w = it.ammoWeapon;
        return !!w && inv.ownedWeapons.includes(w);
      }
      case 'medkit':
        return inv.medkits < inv.maxMedkits;
      case 'grenade':
        return inv.grenades < inv.maxGrenades;
      case 'armor':
        return inv.armor <= 0;
      case 'helmet':
        return inv.helmet <= 0;
      default:
        return false;
    }
  }

  /** Eng yaxshi egalik qilingan (o'qi bor) qurolni qo'lga oladi. */
  private equipBestWeapon(): void {
    const me = this.me;
    if (me.reloadWeapon) return;
    for (const w of BOT_WEAPON_PREFERENCE) {
      if (!this.room.loot.canPlayerUseWeapon(me.id, w)) continue;
      if (!isMeleeWeapon(w) && me.ammo[w].mag + me.ammo[w].reserve <= 0) continue;
      if (me.weapon !== w) {
        applyAuthoritativeWeaponSwitch(me, w, this.room.now(), { fromAutoPickup: true });
        this.room.loot.syncPlayerFromServerPlayer(me.id, me);
      }
      return;
    }
  }

  /**
   * Konteyner atrofidan ko'z balandligida LOS bo'lgan turish nuqtalari (oldi birinchi, keyin halqa).
   * Bo'sh ro'yxat — konteynerga yetib bo'lmaydi (devor ichida va h.k.).
   */
  private approachCandidates(c: PublicContainerState): Vec3[] {
    const world = this.room.world;
    const out: Vec3[] = [];
    const tryPos = (x: number, z: number, y: number) => {
      // O'yinchi kapsulasi shu nuqtada kollayderga tegmasin (ayvon ustuni, devor, konteynerning o'zi)
      if (collidesAtWorld(world, x, y + 0.05, z)) return;
      const eye: Vec3 = { x, y: y + eyeHeightOf(this.me), z };
      if (hasLineOfSightToContainer(world, eye, c.position, c.id)) out.push({ x, y, z });
    };
    // Konteyner kollayderidan tashqarida turish uchun radiuslar 1.1–1.6 m (interaktiv radius ichida)
    // Pol balandligi: konteyner asosi bilan bir sathda yoki undan 1.3 m gacha past (stol ustidagi quti)
    const tryColumn = (x: number, z: number) => {
      for (const hgt of standingHeights(world, x, z, c.position.y)) {
        const below = c.position.y - hgt;
        if (below < -0.25 || below > 1.3) continue;
        tryPos(x, z, hgt);
      }
    };
    const fx = c.position.x + Math.sin(c.yaw) * 1.1;
    const fz = c.position.z + Math.cos(c.yaw) * 1.1;
    tryColumn(fx, fz);
    for (let deg = 0; deg < 360 && out.length < 6; deg += 45) {
      const rad = (deg * Math.PI) / 180;
      for (const r of [1.15, 1.55]) {
        tryColumn(c.position.x + Math.cos(rad) * r, c.position.z + Math.sin(rad) * r);
        if (out.length >= 6) break;
      }
    }
    return out;
  }

  /** Yaqin-atrofdan foydali konteyner/yer buyumini tanlaydi. */
  private thinkLoot(t: number, zt: ZoneTargetCircle | null): void {
    if (this.lootTarget) return;
    const me = this.me;
    const inv = this.room.loot.getPlayerInventorySnap(me.id);
    const need = this.lootNeed(inv);
    if (need === 0 || !inv) return;
    const maxDist = need === 2 ? 160 : 45;
    const snap = this.room.loot.getPublicLootSnapshot();

    let best: BotLootTarget | null = null;
    let bestScore = Infinity;

    for (const g of snap.groundItems) {
      if (this.lootBlacklisted(g.id, t)) continue;
      if (need === 2 && g.kind !== 'weapon') continue;
      if (!this.wantsItem(g, inv)) continue;
      if (zt && !this.insideCircle(g.position, zt, 2)) continue;
      const d = Math.hypot(g.position.x - me.pos.x, g.position.z - me.pos.z);
      if (d > maxDist) continue;
      const score = d - (g.kind === 'weapon' ? 12 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = {
          kind: 'ground',
          id: g.id,
          pos: g.position,
          reach: GROUND_ITEM_PICKUP_RADIUS_M - 0.4,
          approach: { x: g.position.x, y: g.position.y, z: g.position.z },
          candidates: [{ x: g.position.x, y: g.position.y, z: g.position.z }],
          approachIdx: 0,
          deadline: t + 15 + d / 3,
          nearSince: -1,
        };
      }
    }

    for (const c of snap.containers) {
      if (this.lootBlacklisted(c.id, t)) continue;
      if (c.status === 'empty') continue;
      if (c.opened && !c.items.some((it) => this.wantsItem(it, inv))) continue;
      if (zt && !this.insideCircle(c.position, zt, 2)) continue;
      const d = Math.hypot(c.position.x - me.pos.x, c.position.z - me.pos.z);
      if (d > maxDist) continue;
      // Ochilmagan konteyner noma'lum — ozgina jarima, ochiq va kerakli buyumi bor konteyner afzal.
      // Qurolsiz bot qurol bo'lishi ehtimoli yuqori konteynerlarni (qurol shkafi, ta'minot qutisi) afzal ko'radi.
      let score = d + (c.opened ? 0 : 4);
      if (need === 2) {
        if (c.opened && c.items.some((it) => it.kind === 'weapon')) score -= 30;
        else if (c.kind === 'weapon_locker') score -= 18;
        else if (c.kind === 'supply_crate') score -= 8;
        else if (c.kind === 'ammo_box') score += 12;
      }
      if (score < bestScore) {
        const candidates = this.approachCandidates(c).sort(
          (a, b) => Math.hypot(a.x - me.pos.x, a.z - me.pos.z) - Math.hypot(b.x - me.pos.x, b.z - me.pos.z),
        );
        if (!candidates.length) {
          // Yetib bo'lmaydigan konteyner (LOS yo'q) — uzoq vaqt e'tiborga olmaymiz
          this.lootBlacklist.set(c.id, t + 120);
          continue;
        }
        bestScore = score;
        best = {
          kind: 'container',
          id: c.id,
          pos: c.position,
          reach: c.interactionRadius + DEFAULT_CONTAINER_EXTRA_MARGIN_M - 0.05,
          approach: candidates[0]!,
          candidates,
          approachIdx: 0,
          deadline: t + 20 + d / 3,
          nearSince: -1,
        };
      }
    }

    if (best) {
      this.lootTarget = best;
      this.lootTries = 0;
      this.lootSkippedItems.clear();
      this.repathAt = 0;
    }
  }

  /**
   * Loot maqsadi yonida: konteynerni ochadi / buyum oladi. Qaytaradi: bot joyida turib ishlayaptimi.
   * Yetib bormagan bo'lsa false (navigatsiya davom etadi).
   */
  private actLoot(t: number, dt: number): boolean {
    const tgt = this.lootTarget;
    if (!tgt) return false;
    const me = this.me;
    const dx = tgt.pos.x - me.pos.x;
    const dz = tgt.pos.z - me.pos.z;
    const d = Math.hypot(dx, dz);
    // Yondashuv nuqtasiga (LOS tekshirilgan) yetib kelganimizda yoki konteynerga juda yaqin bo'lganda harakat qilamiz
    const dApproach = Math.hypot(tgt.approach.x - me.pos.x, tgt.approach.z - me.pos.z);
    // Konteyner uchun yondashuv nuqtasining o'zi; 1.6 m ichida 1.2 s turib qolsa (to'siq) — shu yerdan urinamiz
    if (tgt.kind === 'container' && dApproach <= 1.6 && tgt.nearSince < 0) tgt.nearSince = t;
    if (tgt.kind === 'container' && dApproach > 1.6) tgt.nearSince = -1;
    const near =
      tgt.kind === 'ground'
        ? d <= tgt.reach
        : dApproach <= 0.7 || (tgt.nearSince >= 0 && t - tgt.nearSince > 1.2 && d <= tgt.reach);
    if (!near) {
      if (t > tgt.deadline) {
        this.lootBlacklist.set(tgt.id, t + 25);
        this.lootTarget = null;
      }
      return false;
    }
    // Konteynerga qaraymiz (odamga o'xshab)
    this.turnTowards(Math.atan2(-dx, -dz), -0.35, 5, dt);
    if (t < this.nextLootActAt) return true;
    this.nextLootActAt = t + 0.35 + Math.random() * 0.25;

    if (tgt.kind === 'ground') {
      const res = this.room.botPickupItem(me, null, tgt.id);
      this.lootBlacklist.set(tgt.id, t + (res.ok ? 5 : 20));
      this.lootTarget = null;
      if (res.ok) this.equipBestWeapon();
      return true;
    }

    const cnt = this.room.loot.getPublicContainerState(tgt.id);
    if (!cnt || cnt.status === 'empty') {
      this.lootBlacklist.set(tgt.id, t + 90);
      this.lootTarget = null;
      return false;
    }
    if (!cnt.opened) {
      const res = this.room.botOpenContainer(me, tgt.id);
      if (!res.ok) {
        this.lootTries++;
        // Shu nuqtadan ochib bo'lmadi (masofa/LOS) — keyingi yondashuv nuqtasiga o'tamiz
        if (tgt.approachIdx + 1 < tgt.candidates.length && this.lootTries <= 6) {
          tgt.approachIdx++;
          tgt.approach = tgt.candidates[tgt.approachIdx]!;
          tgt.deadline = t + 12;
          tgt.nearSince = -1;
          this.lastGoalKey = '';
          return false;
        }
        this.lootBlacklist.set(tgt.id, t + 30);
        this.lootTarget = null;
        return false;
      }
      return true;
    }
    const inv = this.room.loot.getPlayerInventorySnap(me.id);
    if (!inv) {
      this.lootTarget = null;
      return false;
    }
    const wanted = cnt.items
      .filter((it) => this.wantsItem(it, inv))
      .sort((a, b) => LOOT_KIND_PRIORITY[a.kind] - LOOT_KIND_PRIORITY[b.kind]);
    const item = wanted[0];
    if (!item) {
      // Bu konteynerdan kerakli hamma narsa olindi
      this.lootBlacklist.set(tgt.id, t + 90);
      this.lootTarget = null;
      return false;
    }
    const res = this.room.botPickupItem(me, tgt.id, item.id);
    if (res.ok) this.equipBestWeapon();
    else this.lootSkippedItems.add(item.id);
    return true;
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
    const lootMode = this.room.lootEnabled;
    const meleeNow = isMeleeWeapon(me.weapon);
    const canFight = !!me.weapon && (meleeNow || me.ammo[me.weapon].mag + me.ammo[me.weapon].reserve > 0);
    const zt = lootMode ? this.zoneTarget() : null;
    // Zona chetiga 2 m qolganda ham ichkariga yo'l olamiz
    const outsideZone = !!zt && !this.insideCircle(me.pos, zt, 2);

    if (visible && this.target && canFight) {
      // --- Jang ---
      const tgt = this.target;
      const eye = this.eye();
      const aimPt = {
        x: tgt.pos.x + tgt.vel.x * 0.03,
        // O'tirgan nishonga pastroq mo'ljal (xitbokslar shu nisbatda kichrayadi)
        y: tgt.pos.y + this.aimHeight * hitboxScaleOf(tgt),
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
      // Pichoq faqat 1.6 m ichida tegadi
      const inMeleeReach = !meleeNow || d < 1.65;
      if (inMeleeReach && t >= this.reactionUntil && t >= this.nextFireAt && err < tol + 0.06 && roughErr < 0.35) {
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
      if (activeWeapon !== 'sniper' && !meleeNow) {
        wishX = -fz * this.strafeDir * speed * 0.48;
        wishZ = fx * this.strafeDir * speed * 0.48;
      }
      if (meleeNow) {
        // Pichoq bilan nishonga yugurib boramiz (1.2 m gacha), ozgina yon siljish
        if (d > 1.2) {
          wishX += fx * speed;
          wishZ += fz * speed;
        }
        wishX += -fz * this.strafeDir * speed * 0.2;
        wishZ += fx * this.strafeDir * speed * 0.2;
      } else if (activeWeapon === 'shotgun' && d > 7) {
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

      // Loot rejimi: aptechka, loot maqsadi va zona
      let lootBusy = false;
      let goalOverride: Vec3 | null = null;
      let goalKey = '';
      if (lootMode) {
        if (me.hp < 55 && t >= this.nextMedkitAt) {
          this.nextMedkitAt = t + 4;
          if ((this.room.loot.getPlayerInventorySnap(me.id)?.medkits ?? 0) > 0) this.room.botUseMedkit(me);
        }
        if (t >= this.nextLootThinkAt) {
          this.nextLootThinkAt = t + 0.7 + Math.random() * 0.3;
          this.thinkLoot(t, zt);
        }
        if (this.lootTarget) {
          lootBusy = this.actLoot(t, dt);
          if (this.lootTarget && !lootBusy) {
            goalOverride = this.lootTarget.approach;
            goalKey = `loot:${this.lootTarget.id}`;
          }
        }
        if (zt && outsideZone) {
          // Zona hamma narsadan ustun: tashqarida qolish — o'lim
          goalOverride = this.pickZoneGoal(zt, t);
          goalKey = `zone:${Math.round(goalOverride.x)}:${Math.round(goalOverride.z)}`;
          lootBusy = false;
        }
      }

      if (goalKey !== this.lastGoalKey) {
        this.lastGoalKey = goalKey;
        this.repathAt = 0;
      }
      // Loot/zona maqsadida yo'l tugasa qayta hisoblamaymiz — to'g'ri yurish (pastda) maqsadga yetkazadi
      const wantsLocalPath =
        !!goalOverride && Math.hypot(goalOverride.x - me.pos.x, goalOverride.z - me.pos.z) < 12;
      if (wantsLocalPath && t >= this.repathAt && !this.room.takeLocalPathBudget()) {
        // Bu tickning yo'l byudjeti boshqa botga ketdi — keyingi tickda urinamiz (joriy yo'l saqlanadi)
        this.repathAt = t + 0.04;
      }
      if (t >= this.repathAt || (this.pathIdx >= this.path.length && !goalOverride)) {
        let goal: Vec3;
        const hunting = canFight && this.lastSeenPos && t - this.lastSeenAt < 8;
        if (goalOverride) {
          goal = goalOverride;
        } else if (hunting && this.lastSeenPos) {
          goal = this.lastSeenPos;
          if (vdist(goal, me.pos) < 2) {
            this.lastSeenPos = null;
            goal = this.pickRoamGoal();
          }
        } else {
          goal = this.pickRoamGoal();
        }
        this.pathIsLocal = false;
        if (wantsLocalPath) {
          // Yaqin maqsad (konteyner oldi / zona nuqtasi): mayda mahalliy yo'l — binolar ichi va zinalar
          this.path = findLocalPath(this.room.world, me.pos, goal);
          this.pathIsLocal = this.path.length > 0;
        } else {
          this.path = [];
        }
        if (!this.path.length) this.path = nav.findPath(me.pos, goal);
        if (goalOverride && this.path.length === 0 && this.lootTarget && goalKey.startsWith('loot:')) {
          // Yondashuv nuqtasiga yo'l yo'q — konteynerning o'ziga yaqin nav katagiga boramiz
          this.path = nav.findPath(me.pos, this.lootTarget.pos);
          if (this.path.length === 0) {
            this.lootBlacklist.set(this.lootTarget.id, t + 40);
            this.lootTarget = null;
          }
        } else if (goalOverride && this.path.length === 0 && goalKey.startsWith('zone:')) {
          this.zoneGoalPoint = null;
        }
        this.pathIdx = 0;
        this.repathAt = goalOverride ? t + 1.5 + Math.random() * 0.5 : t + 4 + Math.random() * 3;
        this.walkMode = !goalOverride && Math.random() < 0.15;
      }
      let lookYaw = me.yaw;
      if (lootBusy) {
        // Konteyner yonida turib ishlaymiz (actLoot qarashni boshqaradi)
        this.pathIdx = this.path.length;
      } else if (goalOverride && this.pathIdx >= this.path.length) {
        // Yo'l tugadi, lekin maqsad (konteyner oldi / zona nuqtasi) hali yetilmagan — to'g'ri yuramiz
        const dx = goalOverride.x - me.pos.x;
        const dz = goalOverride.z - me.pos.z;
        const dl = Math.hypot(dx, dz);
        if (dl > 0.3 && dl < 12) {
          wishX = (dx / dl) * speed;
          wishZ = (dz / dl) * speed;
          lookYaw = Math.atan2(-dx, -dz);
        }
      } else if (this.pathIdx < this.path.length) {
        const node = this.path[this.pathIdx];
        const dx = node.x - me.pos.x;
        const dz = node.z - me.pos.z;
        const dl = Math.hypot(dx, dz);
        const isLast = this.pathIdx === this.path.length - 1;
        if (dl < (this.pathIsLocal ? (isLast ? 0.35 : 0.5) : 0.8)) {
          this.pathIdx++;
        } else {
          const sp = this.walkMode ? WALK_SPEED : speed;
          wishX = (dx / dl) * sp;
          wishZ = (dz / dl) * sp;
          lookYaw = Math.atan2(-dx, -dz);
        }
      }
      if (this.lastSeenPos && t - this.lastSeenAt < 4 && canFight) {
        const d = vsub(this.lastSeenPos, me.pos);
        lookYaw = Math.atan2(-d.x, -d.z);
      }
      if (!lootBusy) this.turnTowards(lookYaw, 0, 4, dt);

      // Tiqilib qolishni aniqlash
      if (t >= this.stuckCheckAt) {
        const moved = Math.hypot(me.pos.x - this.stuckPos.x, me.pos.z - this.stuckPos.z);
        if (moved < 0.6 && (wishX || wishZ)) {
          jump = true;
          this.stuckCount++;
          this.repathAt = 0;
          if (this.stuckCount > 2) {
            this.lastSeenPos = null;
            if (this.lootTarget) {
              // Loot maqsadiga yetib bo'lmayapti — boshqasini tanlaymiz
              this.lootBlacklist.set(this.lootTarget.id, t + 40);
              this.lootTarget = null;
            }
            if (this.stuckCount > 4) {
              // Geometriyaga tiqilib qolgan: eng yaqin nav katagi markaziga (≤2.5 m) qaytaramiz
              const ni = nav.nearest(me.pos);
              if (ni >= 0) {
                const c = nav.center(ni);
                if (Math.hypot(c.x - me.pos.x, c.z - me.pos.z) < 2.5) {
                  me.pos = { x: c.x, y: Math.max(me.pos.y, c.y), z: c.z };
                  me.vel = { x: 0, y: 0, z: 0 };
                }
              }
              this.stuckCount = 0;
            }
          }
        } else {
          this.stuckCount = 0;
        }
        this.stuckPos = vcopy(me.pos);
        this.stuckCheckAt = t + 1.2;
      }

      // Granata otish
      if (canFight && this.lastSeenPos && t >= this.grenadeCheckAt && t - this.lastSeenAt > 0.8 && t - this.lastSeenAt < 4) {
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
    if (!me.reloadWeapon && me.weapon && !meleeNow) {
      if (ammo.mag === 0) {
        if (ammo.reserve > 0) this.room.startReload(me);
        else {
          const alt = WEAPON_SLOTS.find(
            (w) => (!lootMode || this.room.loot.canPlayerUseWeapon(me.id, w)) && me.ammo[w].mag + me.ammo[w].reserve > 0,
          );
          // O'q tugadi: boshqa o'qotar qurol bo'lmasa — pichoq
          applyAuthoritativeWeaponSwitch(me, alt ?? 'knife', this.room.now(), { fromAutoPickup: true });
          if (lootMode) this.room.loot.syncPlayerFromServerPlayer(me.id, me);
        }
      } else if (!visible && ammo.mag < WEAPONS[activeWeapon].magSize * 0.4 && ammo.reserve > 0) {
        this.room.startReload(me);
      }
    }
  }
}
