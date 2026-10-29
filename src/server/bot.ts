import { RUN_SPEED, WALK_SPEED } from '../shared/constants';
import { anglesFromDir, angleDiff, clamp, dirFromAngles, vcopy, vdist, vnorm, vsub, type Vec3 } from '../shared/math';
import { applyWorldMovement, collidesAtWorld, raycastWorld } from '../shared/physics';
import {
  DEFAULT_CONTAINER_EXTRA_MARGIN_M,
  GROUND_ITEM_PICKUP_RADIUS_M,
  MAX_AMMO_RESERVE,
  hasLineOfSightToContainer,
  type PlayerInventorySnap,
  type PublicContainerState,
  type PublicLootItem,
} from '../shared/loot';
import { eyeHeightOf, hitboxScaleOf } from '../shared/stance';
import { sampleTerrainHeight } from '../shared/world';
import { WEAPONS, WEAPON_SLOTS, isMeleeWeapon, type WeaponId } from '../shared/weapons';
import {
  BOT_FLARE_COOLDOWN_SEC,
  BOT_FLARE_NO_FIRE_M,
  BOT_FLARE_WOLF_DIST_M,
  CAMPFIRE_LOW_FUEL_SEC,
  CAMPFIRE_MAX_FUEL_SEC,
  CAMPFIRE_RADIUS_M,
  CAMP_INTERACT_RANGE_M,
  NIGHT_REVIVE_RANGE_M,
  WOOD_CARRY_MAX,
  isWolfThreatState,
} from '../shared/wolf';
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
  flare: 6,
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

/**
 * wolf_night: botning lager vazifasi — g'aramdan o'tin olish, gulxanga tashlash, yiqilgan sherikni turg'izish
 * yoki (uzoq g'aramga chiqishdan oldin) gulxandan mash'al olish.
 */
interface BotCampTask {
  kind: 'take' | 'feed' | 'revive' | 'torch';
  /** G'aram / gulxan / yiqilgan sherik (o'yinchi) identifikatori. */
  id: string;
  /** G'aram / gulxan / sherik joyi. */
  pos: Vec3;
  /** Yo'l maqsadi: ob'ektdan biroz nari (ustiga chiqmaslik uchun). */
  approach: Vec3;
  deadline: number;
}

/** Bot o'tin g'aramini shu masofadan izlaydi (m). */
const BOT_WOOD_SEARCH_M = 45;
/** G'aram eng yaqin yonib turgan gulxandan shundan uzoq bo'lsa (m), bot avval mash'al oladi. */
const BOT_TORCH_PILE_DIST_M = 25;
/** Bot mash'alni faqat o'tini shundan ko'p (s) gulxandan oladi (lagerni kuchsizlantirmaslik uchun). */
const BOT_TORCH_MIN_FUEL_SEC = 30;
/** Bot yiqilgan sherigini shu masofadan (m) turg'izishga boradi — faqat yaqinda (BOT_REVIVE_WOLF_CLEAR_M) bo'ri tahdidi bo'lmasa. */
const BOT_REVIVE_SEARCH_M = 40;
const BOT_REVIVE_WOLF_CLEAR_M = 14;
/** Yordam yuki (wolf_night): qurolsiz/o'qsiz bot shu masofadan (m) uni ustuvor loot maqsadi qiladi. */
const BOT_SUPPLY_SEARCH_M = 80;
/** Bot o'tin olib kelishga faqat gulxan o'tini shu qiymatdan (s) kamayganda chiqadi. */
const BOT_FETCH_FUEL_SEC = 60;
/** Bo'ridan qochgan bot shu masofadagi (m) yonib turgan gulxanga yuguradi (wolf_night). */
const BOT_FLEE_TO_FIRE_M = 30;
/** Gulxan doirasida panalangan bot olov markazidan shuncha (m) nari turadi — o'tin tashlash masofasida. */
const BOT_FIRE_SHELTER_OFFSET_M = 1.5;

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
  /** Bo'ridan qochish maqsadi (nav tuguni) va u tanlangan vaqt. */
  private wolfFleeGoal: Vec3 | null = null;
  private wolfFleeGoalAt = -99;
  /** Signal raketasi (wolf_night): keyingi otish mumkin bo'lgan vaqt (BOT_FLARE_COOLDOWN_SEC). */
  private nextFlareAt = 0;
  // --- Lager AI (wolf_night): o'tin olib kelish, gulxanni boqish ---
  private campTask: BotCampTask | null = null;
  private campBlacklist = new Map<string, number>();
  private nextCampThinkAt = 0;
  private nextCampActAt = 0;

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
    this.zoneGoalPoint = null;
    this.lastGoalKey = '';
    this.campTask = null;
    this.campBlacklist.clear();
    this.nextCampThinkAt = 0;
  }

  /** wolf_night: bot yiqildi — vazifalar bekor, turg'izilgach yangidan o'ylaydi. */
  onDowned(): void {
    this.campTask = null;
    this.lootTarget = null;
    this.wolfFleeGoal = null;
    this.path = [];
    this.pathIdx = 0;
    this.repathAt = 0;
    this.lastGoalKey = '';
    this.nextCampThinkAt = 0;
  }

  /** Xavfsiz zonadan tashqarida zarar oldi — zona ichidagi nuqtani qayta tanlab, darhol yo'l izlaydi (survival). */
  onZoneDamaged(_cx: number, _cz: number): void {
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
    // Tong otguncha: botlar lagerdan (gulxandan ~10 m) uzoqlashmaydi
    if (this.room.isNight) return this.room.pickCampRoamGoal(this.me);
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

  /** Maqsad (keyingi) aylana; zona bo'lmasa null. */
  private zoneTarget(): ZoneTargetCircle | null {
    const z = this.room.getZoneSnap();
    if (!z) return null;
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

  private wantsItem(it: Readonly<PublicLootItem>, inv: PlayerInventorySnap): boolean {
    if (this.lootSkippedItems.has(it.id)) return false;
    switch (it.kind) {
      case 'weapon': {
        const w = it.weaponId;
        if (!w) return false;
        if (inv.ownedWeapons.includes(w)) {
          // Bor qurolning ikkinchi nusxasi — o'q manbai (o'qlari zaxiraga qo'shiladi): o'qi tugayotgan bo'lsa olamiz
          if (isMeleeWeapon(w)) return false;
          const a = inv.ammo[w];
          const carries = (it.initialMag ?? 0) + (it.initialReserve ?? WEAPONS[w].magSize) > 0;
          return carries && a.mag + a.reserve < WEAPONS[w].magSize && a.reserve < MAX_AMMO_RESERVE[w];
        }
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
      case 'flare':
        // Signal raketasi (wolf_night): bo'rilarga qarshi zaxira
        return this.room.isNight && inv.flares < inv.maxFlares;
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
  private approachCandidates(c: Pick<PublicContainerState, 'id' | 'yaw'> & { position: Readonly<Vec3> }): Vec3[] {
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

  /** Ochilgan konteyner buyumlaridan birortasi shartga mosmi (massiv yaratmasdan). */
  private anyItem(items: ReadonlyMap<string, Readonly<PublicLootItem>>, pred: (it: Readonly<PublicLootItem>) => boolean): boolean {
    for (const it of items.values()) if (pred(it)) return true;
    return false;
  }

  /** Yaqin-atrofdan foydali konteyner/yer buyumini tanlaydi. */
  private thinkLoot(t: number, zt: ZoneTargetCircle | null): void {
    if (this.lootTarget) return;
    const me = this.me;
    const inv = this.room.loot.getPlayerInventorySnap(me.id);
    const need = this.lootNeed(inv);
    if (need === 0 || !inv) return;
    const supply = this.room.isNight ? this.room.getSupplyDrop() : null;
    const maxDist = need === 2 ? 160 : 45;
    // Nusxasiz o'qish (to'liq snapshot har think'da klonlanmaydi); tanlangan maqsad uchun joylar nusxalanadi
    const view = this.room.loot.botLootView();

    let best: BotLootTarget | null = null;
    let bestScore = Infinity;

    for (const g of view.groundItems) {
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
          pos: { x: g.position.x, y: g.position.y, z: g.position.z },
          reach: GROUND_ITEM_PICKUP_RADIUS_M - 0.4,
          approach: { x: g.position.x, y: g.position.y, z: g.position.z },
          candidates: [{ x: g.position.x, y: g.position.y, z: g.position.z }],
          approachIdx: 0,
          deadline: t + 15 + d / 3,
          nearSince: -1,
        };
      }
    }

    for (const c of view.containers) {
      if (this.lootBlacklisted(c.id, t)) continue;
      if (c.status === 'empty') continue;
      if (c.opened && !this.anyItem(c.items, (it) => this.wantsItem(it, inv))) continue;
      if (zt && !this.insideCircle(c.position, zt, 2)) continue;
      const d = Math.hypot(c.position.x - me.pos.x, c.position.z - me.pos.z);
      // Yordam yuki (wolf_night) uzoqroqdan ham (BOT_SUPPLY_SEARCH_M) ko'rinadi; qolganlari avvalgidek
      const isSupply = !!supply && c.id === supply.id;
      if (d > maxDist && !(isSupply && d <= BOT_SUPPLY_SEARCH_M)) continue;
      // Ochilmagan konteyner noma'lum — ozgina jarima, ochiq va kerakli buyumi bor konteyner afzal.
      // Qurolsiz bot qurol bo'lishi ehtimoli yuqori konteynerlarni (qurol shkafi, ta'minot qutisi) afzal ko'radi.
      let score = d + (c.opened ? 0 : 4);
      if (need === 2) {
        if (c.opened && this.anyItem(c.items, (it) => it.kind === 'weapon')) score -= 30;
        else if (c.kind === 'weapon_locker') score -= 18;
        else if (c.kind === 'supply_crate') score -= 8;
        else if (c.kind === 'ammo_box') score += 12;
      }
      // wolf_night: yarim tungi yordam yuki (qurol + o'q + raketalar) — 80 m ichida, yaqinda bo'ri tahdidi
      // bo'lmasa — yuqori ustuvorlik (ayniqsa qurolsiz/o'qsiz botga)
      if (isSupply && d <= BOT_SUPPLY_SEARCH_M && this.room.nearestWolfThreat(me, BOT_REVIVE_WOLF_CLEAR_M) === null) {
        score -= need === 2 ? 60 : 30;
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
          pos: { x: c.position.x, y: c.position.y, z: c.position.z },
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

  // ---------------- Lager AI (wolf_night) ----------------

  private campBlacklisted(id: string, t: number): boolean {
    const until = this.campBlacklist.get(id);
    if (until === undefined) return false;
    if (t >= until) {
      this.campBlacklist.delete(id);
      return false;
    }
    return true;
  }

  /** Ob'ektga yondashuv nuqtasi: bot tomonidan `off` m nari (ustiga chiqmaslik uchun). */
  private campApproach(pos: Vec3, off: number): Vec3 {
    const me = this.me;
    const dx = me.pos.x - pos.x;
    const dz = me.pos.z - pos.z;
    const dl = Math.hypot(dx, dz) || 1;
    return { x: pos.x + (dx / dl) * off, y: pos.y, z: pos.z + (dz / dl) * off };
  }

  private setCampTask(kind: BotCampTask['kind'], id: string, pos: Vec3, t: number): void {
    const d = Math.hypot(pos.x - this.me.pos.x, pos.z - this.me.pos.z);
    this.campTask = {
      kind,
      id,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      approach: this.campApproach(pos, kind === 'feed' ? 1.4 : 1.1),
      deadline: t + 15 + d / 3,
    };
    this.lastGoalKey = '';
    this.repathAt = 0;
  }

  /**
   * Lager vazifasini tanlash (oddiy holat mashinasi):
   * 1) o'tin bor va gulxan o'chmoqda/o'chgan → tashlash (hamma narsadan ustun — lager o'chsa hamma o'ladi);
   * 2) qurolsiz bot avval qurol izlaydi (loot AI);
   * 3) qo'l to'la emas va 45 m ichida to'la g'aram bor → olish;
   * 4) o'tin bor → sig'adigan (eng kam o'tinli) gulxanga tashlash.
   * 0) Hammasidan oldin: 40 m ichida yiqilgan sherik bor va 14 m ichida bo'ri tahdidi yo'q → turg'izishga boradi.
   */
  private thinkCamp(t: number, lootNeed: 0 | 1 | 2): void {
    if (this.campTask) return;
    const room = this.room;
    const me = this.me;
    if (room.campfires.size === 0) return;
    const dist = (o: { x: number; z: number }) => Math.hypot(o.x - me.pos.x, o.z - me.pos.z);

    {
      let best: ServerPlayer | null = null;
      let bestD = Infinity;
      for (const o of room.players.values()) {
        if (o === me || !o.alive || !o.downed || !o.ready || this.campBlacklisted(`revive:${o.id}`, t)) continue;
        const d = dist(o.pos);
        if (d > BOT_REVIVE_SEARCH_M || d >= bestD) continue;
        bestD = d;
        best = o;
      }
      if (best && room.nearestWolfThreat(me, BOT_REVIVE_WOLF_CLEAR_M) === null) {
        this.setCampTask('revive', best.id, best.pos, t);
        return;
      }
    }

    if (me.wood > 0) {
      let best: { id: string; x: number; y: number; z: number } | null = null;
      let bestD = Infinity;
      for (const f of room.campfires.values()) {
        if (this.campBlacklisted(f.id, t)) continue;
        if (f.lit && f.fuelSec >= CAMPFIRE_LOW_FUEL_SEC) continue;
        const d = dist(f);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      if (best) {
        this.setCampTask('feed', best.id, best, t);
        return;
      }
    }
    if (lootNeed === 2) return;
    // Botlar o'tinni faqat biror gulxan haqiqatan kamayganda (yoki o'chganda) tashiydi —
    // o'tin tashish asosan odamlarning ishi, aks holda o'yin juda oson bo'lib qoladi
    let fireNeedsWood = false;
    for (const f of room.campfires.values()) {
      if (!f.lit || f.fuelSec < BOT_FETCH_FUEL_SEC) {
        fireNeedsWood = true;
        break;
      }
    }
    if (me.wood < WOOD_CARRY_MAX && fireNeedsWood) {
      let best: { id: string; x: number; y: number; z: number } | null = null;
      let bestD = Infinity;
      for (const pl of room.woodPiles.values()) {
        if (!pl.available || this.campBlacklisted(pl.id, t)) continue;
        const d = dist(pl);
        if (d > BOT_WOOD_SEARCH_M || d >= bestD) continue;
        bestD = d;
        best = pl;
      }
      if (best) {
        // Uzoq g'aram (eng yaqin yonib turgan gulxandan 25 m dan nari) — mash'alsiz chiqmaydi: avval yaqin
        // (yetib boriladigan) kuchli gulxandan mash'al oladi, keyin g'aramga yo'l oladi
        if (!room.hasTorch(me)) {
          const nearFire = room.nearestLitFire(best.x, best.z);
          const pileFar = !nearFire || Math.hypot(nearFire.x - best.x, nearFire.z - best.z) > BOT_TORCH_PILE_DIST_M;
          if (pileFar) {
            let torchFire: { id: string; x: number; y: number; z: number } | null = null;
            let torchD = Infinity;
            for (const f of room.campfires.values()) {
              if (!f.lit || f.fuelSec <= BOT_TORCH_MIN_FUEL_SEC || this.campBlacklisted(`torch:${f.id}`, t)) continue;
              const d = dist(f);
              if (d < torchD && d < BOT_WOOD_SEARCH_M) {
                torchD = d;
                torchFire = f;
              }
            }
            if (torchFire) {
              this.setCampTask('torch', torchFire.id, torchFire, t);
              return;
            }
          }
        }
        this.setCampTask('take', best.id, best, t);
        return;
      }
    }
    if (me.wood > 0) {
      let best: { id: string; x: number; y: number; z: number; fuelSec: number } | null = null;
      for (const f of room.campfires.values()) {
        if (this.campBlacklisted(f.id, t)) continue;
        if (f.lit && f.fuelSec >= CAMPFIRE_MAX_FUEL_SEC - 5) continue;
        if (dist(f) > 120) continue;
        if (!best || f.fuelSec < best.fuelSec) best = f;
      }
      if (best) this.setCampTask('feed', best.id, best, t);
    }
  }

  /**
   * Lager vazifasi yonida: o'tin oladi / gulxanga tashlaydi. Qaytaradi: bot joyida turib ishlayaptimi
   * (yetib bormagan bo'lsa false — navigatsiya davom etadi).
   */
  private actCamp(t: number, dt: number): boolean {
    const tgt = this.campTask;
    if (!tgt) return false;
    const me = this.me;
    const room = this.room;
    // Vazifa eskirdi: g'aramni boshqa birov oldi / gulxan to'ldi / sherik turg'izildi yoki o'ldi
    if (tgt.kind === 'revive') {
      const o = room.players.get(tgt.id);
      if (!o || !o.alive || !o.downed) {
        this.campBlacklist.set(`revive:${tgt.id}`, t + 3);
        this.campTask = null;
        return false;
      }
      tgt.pos = { x: o.pos.x, y: o.pos.y, z: o.pos.z };
      const dx = o.pos.x - me.pos.x;
      const dz = o.pos.z - me.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > NIGHT_REVIVE_RANGE_M - 0.6 || Math.abs(o.pos.y - me.pos.y) > 1.8) {
        if (t > tgt.deadline) {
          this.campBlacklist.set(`revive:${tgt.id}`, t + 15);
          this.campTask = null;
        }
        return false;
      }
      // Yonida turib kanalni ushlab turadi (so'rov idempotent; jarayon serverda o'sadi)
      this.turnTowards(Math.atan2(-dx, -dz), -0.5, 5, dt);
      if (t >= this.nextCampActAt) {
        this.nextCampActAt = t + 0.4 + Math.random() * 0.2;
        const res = room.botRevive(me, tgt.id);
        if (!res.ok && res.error !== undefined && res.error !== 'TOO_FAR') {
          this.campBlacklist.set(`revive:${tgt.id}`, t + 6);
          this.campTask = null;
        }
      }
      return true;
    }
    // Qora ro'yxat kaliti: mash'al vazifasi gulxanning o'tin tashlash kalitiga aralashmasin
    const blKey = tgt.kind === 'torch' ? `torch:${tgt.id}` : tgt.id;
    if (tgt.kind === 'take') {
      const pl = room.woodPiles.get(tgt.id);
      if (!pl || !pl.available || me.wood >= WOOD_CARRY_MAX) {
        this.campTask = null;
        return false;
      }
    } else if (tgt.kind === 'torch') {
      const f = room.campfires.get(tgt.id);
      if (!f || !f.lit || f.fuelSec <= BOT_TORCH_MIN_FUEL_SEC || room.hasTorch(me)) {
        this.campTask = null;
        return false;
      }
    } else {
      const f = room.campfires.get(tgt.id);
      if (!f || me.wood <= 0 || (f.lit && f.fuelSec >= CAMPFIRE_MAX_FUEL_SEC - 5)) {
        this.campTask = null;
        return false;
      }
    }
    const dx = tgt.pos.x - me.pos.x;
    const dz = tgt.pos.z - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > CAMP_INTERACT_RANGE_M - 0.4 || Math.abs(tgt.pos.y - me.pos.y) > 1.8) {
      if (t > tgt.deadline) {
        this.campBlacklist.set(blKey, t + 20);
        this.campTask = null;
      }
      return false;
    }
    this.turnTowards(Math.atan2(-dx, -dz), -0.3, 5, dt);
    if (t < this.nextCampActAt) return true;
    this.nextCampActAt = t + 0.4 + Math.random() * 0.2;
    const res =
      tgt.kind === 'take'
        ? room.botTakeWood(me, tgt.id)
        : tgt.kind === 'torch'
          ? room.botTakeTorch(me, tgt.id)
          : room.botFeedFire(me, tgt.id);
    if (!res.ok && res.error === undefined) return true; // tezlik cheklovi — keyingi urinish
    // Mash'al olingach shu gulxan qora ro'yxatga tushmaydi (keyingi think g'aramni tanlaydi); xato — 20 s
    if (tgt.kind === 'torch') {
      if (!res.ok) this.campBlacklist.set(blKey, t + 20);
    } else {
      this.campBlacklist.set(blKey, t + (res.ok ? 3 : 20));
    }
    this.campTask = null;
    return true;
  }

  // ---------------- Bo'rilar ----------------

  /**
   * Yaqin bo'ri tahdidi: o'qotar qurol va o'q bo'lsa, bo'rini ko'rsa — unga qarab otadi (6 m dan yaqin kelsa
   * orqaga tisariladi); aks holda bo'ridan teskari tomonga (~14 m, nav tuguniga) yugurib qochadi.
   * Qaytaradi: 'fight' / 'flee' (harakat qo'llandi, shu tick uchun boshqa mantiq kerak emas) yoki null (tahdid yo'q).
   */
  private handleWolfThreat(dt: number, t: number): 'fight' | 'flee' | null {
    const me = this.me;
    if (this.room.wolves.size === 0) {
      this.wolfFleeGoal = null;
      return null;
    }
    const w = this.room.nearestWolfThreat(me, 22);
    if (!w) {
      this.wolfFleeGoal = null;
      return null;
    }
    const dx = w.pos.x - me.pos.x;
    const dz = w.pos.z - me.pos.z;
    const dH = Math.hypot(dx, dz) || 1e-3;
    const hunting = w.targetId === me.id || isWolfThreatState(w.state);
    if (!hunting && dH > 10) {
      // Uzoqda sayr qilayotgan bo'ri — o'z ishimizda davom etamiz
      this.wolfFleeGoal = null;
      return null;
    }

    const weapon = me.weapon;
    const ranged = !!weapon && !isMeleeWeapon(weapon) && me.ammo[weapon].mag + me.ammo[weapon].reserve > 0;
    const eye = this.eye();
    const center = { x: w.pos.x, y: w.pos.y + 0.6, z: w.pos.z };
    const toW = vsub(center, eye);
    const dist = vdist(eye, center);
    const canSee = ranged && dist > 1e-3 && !raycastWorld(this.room.world, eye, vnorm(toW), dist);

    let wishX = 0;
    let wishZ = 0;
    if (canSee && weapon) {
      const def = WEAPONS[weapon];
      const { yaw, pitch } = anglesFromDir(toW);
      // Bo'ri tez — o'yinchiga qaraganda shoshilinchroq buriladi
      this.turnTowards(yaw, pitch, 5 + this.skill * 3, dt);
      const err = Math.abs(angleDiff(me.yaw, yaw)) + Math.abs(me.pitch - pitch);
      if (err < 0.12 && t >= this.nextFireAt && me.ammo[weapon].mag > 0) {
        const extraSpread = 0.02 + (1 - this.skill) * 0.04;
        if (this.room.botFire(me, extraSpread)) {
          this.nextFireAt = t + def.fireInterval + (def.auto ? 0.03 : 0.2 + Math.random() * 0.2);
        }
      }
      if (dH < 6) {
        // Juda yaqin — otishda davom etib orqaga tisarilamiz
        const sp = RUN_SPEED * def.speedMul * 0.7;
        wishX = -(dx / dH) * sp;
        wishZ = -(dz / dH) * sp;
      }
      this.wolfFleeGoal = null;
      this.repathAt = 0;
      applyWorldMovement(me, wishX, wishZ, false, dt, this.room.world);
      return 'fight';
    }

    const speed = RUN_SPEED * (weapon ? WEAPONS[weapon].speedMul : 1);
    // wolf_night: bo'ri ovlab yaqinlashdi (≤ 6 m), yaqinda yonib turgan gulxan yo'q, mash'al yo'q — signal
    // raketasi bo'lsa otamiz (30 s da bir marta); raketa otilgach bo'rilar qochadi, keyingi tick odatdagidek
    if (this.room.isNight && hunting && dH <= BOT_FLARE_WOLF_DIST_M && t >= this.nextFlareAt && !this.room.hasTorch(me)) {
      const fire = this.room.nearestLitFire(me.pos.x, me.pos.z);
      const fireNear = !!fire && Math.hypot(fire.x - me.pos.x, fire.z - me.pos.z) <= BOT_FLARE_NO_FIRE_M;
      if (!fireNear && this.room.loot.getFlareCount(me.id) > 0) {
        this.nextFlareAt = t + BOT_FLARE_COOLDOWN_SEC;
        if (this.room.botUseFlare(me).ok) {
          applyWorldMovement(me, 0, 0, false, dt, this.room.world);
          return 'flee';
        }
      }
    }
    // Yonib turgan gulxan doirasidamiz (wolf_night): bo'ri olovga kirmaydi va tishlamaydi — doiradan chiqib
    // qochmaymiz, gulxanning bo'riga teskari tomonida kutamiz
    const shelter = this.room.litFireContaining(me.pos.x, me.pos.z, 0);
    if (shelter) {
      this.shelterAtFire(shelter, w.pos, speed, dt, t);
      return 'flee';
    }

    // Qochish: bo'ridan teskari yo'nalishda ~14 m — yo'li bor nav tuguniga, yo'l bo'ylab yugurib
    // (yaqinda yonib turgan gulxan bo'lsa — o'sha tomonga, pickWolfFleeGoal)
    if (
      !this.wolfFleeGoal ||
      t - this.wolfFleeGoalAt > 1.5 ||
      Math.hypot(this.wolfFleeGoal.x - me.pos.x, this.wolfFleeGoal.z - me.pos.z) < 1.5
    ) {
      const pick = this.pickWolfFleeGoal(w.pos, dH);
      this.wolfFleeGoal = pick.goal;
      this.wolfFleeGoalAt = t;
      this.path = pick.path;
      this.pathIdx = 0;
      // Birinchi tugun o'z katagimiz markazi bo'lsa (orqada qolgan) — undan o'tib ketamiz
      if (this.path.length > 1) {
        const n0 = this.path[0]!;
        if (Math.hypot(n0.x - me.pos.x, n0.z - me.pos.z) < 2.5) this.pathIdx = 1;
      }
      this.pathIsLocal = false;
      this.repathAt = 0;
      this.lastGoalKey = 'wolf:flee';
    }
    let goal = this.wolfFleeGoal;
    if (this.pathIdx < this.path.length) {
      const node = this.path[this.pathIdx]!;
      if (Math.hypot(node.x - me.pos.x, node.z - me.pos.z) < 0.8) this.pathIdx++;
      if (this.pathIdx < this.path.length) goal = this.path[this.pathIdx]!;
    }
    const gx = goal.x - me.pos.x;
    const gz = goal.z - me.pos.z;
    const gl = Math.hypot(gx, gz);
    let jump = false;
    if (gl > 0.3) {
      wishX = (gx / gl) * speed;
      wishZ = (gz / gl) * speed;
      this.turnTowards(Math.atan2(-gx, -gz), 0, 6, dt);
      // Tiqilib qolsa sakraydi
      if (me.onGround && Math.hypot(me.vel.x, me.vel.z) < 0.3 && t - this.wolfFleeGoalAt > 0.4) jump = true;
    }
    applyWorldMovement(me, wishX, wishZ, jump, dt, this.room.world);
    return 'flee';
  }

  /**
   * Gulxan doirasida bo'ridan panalanish: olov markazidan bo'riga teskari tomonda BOT_FIRE_SHELTER_OFFSET_M
   * dagi nuqtada turadi (doira ichida qoladi), bo'riga qaraydi; qo'lda o'tin bo'lsa shu yerdan tashlaydi.
   */
  private shelterAtFire(fire: { id: string; x: number; z: number }, wolfPos: Vec3, speed: number, dt: number, t: number): void {
    const me = this.me;
    this.wolfFleeGoal = null;
    this.path = [];
    this.pathIdx = 0;
    this.repathAt = 0;
    this.lastGoalKey = 'wolf:shelter';
    const al = Math.hypot(fire.x - wolfPos.x, fire.z - wolfPos.z) || 1;
    const hx = fire.x + ((fire.x - wolfPos.x) / al) * BOT_FIRE_SHELTER_OFFSET_M;
    const hz = fire.z + ((fire.z - wolfPos.z) / al) * BOT_FIRE_SHELTER_OFFSET_M;
    const gx = hx - me.pos.x;
    const gz = hz - me.pos.z;
    const gl = Math.hypot(gx, gz);
    let wishX = 0;
    let wishZ = 0;
    if (gl > 0.6) {
      wishX = (gx / gl) * speed * 0.7;
      wishZ = (gz / gl) * speed * 0.7;
      this.turnTowards(Math.atan2(-gx, -gz), 0, 6, dt);
    } else {
      this.turnTowards(Math.atan2(-(wolfPos.x - me.pos.x), -(wolfPos.z - me.pos.z)), 0, 4, dt);
    }
    if (me.wood > 0 && t >= this.nextCampActAt && Math.hypot(fire.x - me.pos.x, fire.z - me.pos.z) <= CAMP_INTERACT_RANGE_M - 0.3) {
      // To'la gulxan FIRE_FULL bilan rad etiladi — o'tin qo'lda qoladi
      this.nextCampActAt = t + 0.5;
      this.room.botFeedFire(me, fire.id);
    }
    applyWorldMovement(me, wishX, wishZ, false, dt, this.room.world);
  }

  /**
   * Qochish maqsadi: wolf_night da BOT_FLEE_TO_FIRE_M ichida yonib turgan gulxan bo'lsa va bo'ri yo'lni
   * to'smasa — gulxan markazidagi nav tuguni (doiraga kirgach shelterAtFire). Aks holda bo'ridan teskari
   * yo'nalish atrofida (0°, ±30°, ±60°, ±95°, ±130°) ~14 m dagi nav tugunlari sinab chiqiladi — bo'ridan
   * kamida 4 m uzoqlashtiradigan va yo'li bor birinchisi olinadi (to'g'ri qochish devorga olib borsa, yon
   * tomonga o'tiladi). Topilmasa — xom teskari nuqta, yo'lsiz.
   */
  private pickWolfFleeGoal(wolfPos: Vec3, dH: number): { goal: Vec3; path: Vec3[] } {
    const me = this.me;
    const nav = this.room.nav;
    const ax = (me.pos.x - wolfPos.x) / dH;
    const az = (me.pos.z - wolfPos.z) / dH;
    const fire = this.room.nearestLitFire(me.pos.x, me.pos.z);
    if (fire) {
      const fdx = fire.x - me.pos.x;
      const fdz = fire.z - me.pos.z;
      const fd = Math.hypot(fdx, fdz) || 1e-3;
      // (ax, az) — bo'ridan bizga: bo'ri gulxan tomonida va uning narigi chetidan oldinda bo'lsa, yo'l to'silgan
      const wolfAhead = -(fdx * ax + fdz * az) / fd;
      const wolfInWay = wolfAhead > 0.5 && dH < fd + CAMPFIRE_RADIUS_M;
      if (fd <= BOT_FLEE_TO_FIRE_M && !wolfInWay) {
        const ni = nav.nearest({ x: fire.x, y: fire.y, z: fire.z });
        if (ni >= 0) {
          const c = nav.center(ni);
          const path = nav.findPath(me.pos, c);
          if (path.length) return { goal: c, path };
        }
      }
    }
    let best: { goal: Vec3; path: Vec3[]; score: number } | null = null;
    for (const deg of [0, 30, -30, 60, -60, 95, -95, 130, -130]) {
      const a = (deg * Math.PI) / 180;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const dx = ax * cs - az * sn;
      const dz = ax * sn + az * cs;
      const raw = { x: me.pos.x + dx * 14, y: me.pos.y, z: me.pos.z + dz * 14 };
      const ni = nav.nearest(raw);
      if (ni < 0) continue;
      const c = nav.center(ni);
      const gain = Math.hypot(c.x - wolfPos.x, c.z - wolfPos.z) - dH;
      if (gain < 4) continue;
      const path = nav.findPath(me.pos, c);
      if (!path.length) continue;
      let len = 0;
      let prev: Vec3 = me.pos;
      for (const n of path) {
        len += Math.hypot(n.x - prev.x, n.z - prev.z);
        prev = n;
      }
      const score = gain - Math.max(0, len - 16) * 0.5 - Math.abs(deg) * 0.03;
      if (!best || score > best.score) best = { goal: c, path, score };
      // To'g'ri (yoki unga yaqin) yo'nalish yaxshi ishlayapti — qidiruvni to'xtatamiz
      if (gain >= 9 && len <= 20) break;
    }
    if (best) return { goal: best.goal, path: best.path };
    return { goal: { x: me.pos.x + ax * 14, y: me.pos.y, z: me.pos.z + az * 14 }, path: [] };
  }

  /** O'q-dorilar: bo'sh magazin — qayta yuklash yoki boshqa qurolga/pichoqqa o'tish; tinch paytda to'ldirish. */
  private manageAmmo(visible: boolean): void {
    const me = this.me;
    const activeWeapon: WeaponId = me.weapon ?? 'rifle';
    const meleeNow = isMeleeWeapon(me.weapon);
    const lootMode = this.room.lootEnabled;
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

  update(dt: number, t: number): void {
    const me = this.me;
    if (!me.alive) return;
    // Yiqilgan bot (wolf_night) o'ylamaydi va yurmaydi — faqat gravitatsiya; sherigi turg'izguncha yotadi
    if (this.room.phase !== 'playing' || me.downed) {
      applyWorldMovement(me, 0, 0, false, dt, this.room.world);
      return;
    }

    // --- Bo'ri tahdidi: otish yoki qochish (o'yinchi-jang va loot mantiqidan ustun) ---
    const wolfAction = this.handleWolfThreat(dt, t);
    if (wolfAction !== null) {
      this.manageAmmo(wolfAction === 'fight');
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
        // Tong otguncha: lager vazifasi (o'tin / gulxan) loot'dan ustun (qurolsiz bot bundan mustasno)
        if (this.room.isNight) {
          if (t >= this.nextCampThinkAt) {
            this.nextCampThinkAt = t + 0.6 + Math.random() * 0.3;
            this.thinkCamp(t, this.lootNeed(this.room.loot.getPlayerInventorySnap(me.id)));
          }
          if (this.campTask) {
            lootBusy = this.actCamp(t, dt);
            if (this.campTask && !lootBusy) {
              goalOverride = this.campTask.approach;
              goalKey = `camp:${this.campTask.kind}:${this.campTask.id}`;
            }
          }
        }
        if (!this.campTask) {
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
    this.manageAmmo(visible);
  }
}
