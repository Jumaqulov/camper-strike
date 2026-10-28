import type { Server, Socket } from 'socket.io';
import {
  CLASSIC_MAX_BOTS, GAME_MODE_NAMES_UZ, GRENADE_DAMAGE, GRENADE_FUSE, GRENADE_RADIUS, GRENADE_THROW_SPEED,
  GRENADES_PER_LIFE, MATCH_END_DURATION, MAX_HP, RESPAWN_TIME, ROOM_MAX_TOTAL_PLAYERS, SPAWN_PROTECTION,
  SURVIVAL_MAX_BOTS, TEAM_NAMES, TICK_RATE, isSurvivalMode, type Team,
} from '../shared/constants';
import { clamp, createSeededRng, isVec3, q3, spreadDir, vdist, vnorm, vsub, type Vec3 } from '../shared/math';
import {
  collidesAtWorld,
  isSpawnPointSafe,
  pointInsideBoxes,
  rayBox,
  raycastWorld,
  rayVsPlayer,
  type Body,
  type HitZone,
} from '../shared/physics';
import { getForestSquarePoiSites, type ForestSquarePoiId } from '../shared/structures/contracts';
import {
  CAMPFIRE_LOW_FUEL_SEC,
  CAMPFIRE_MAX_FUEL_SEC,
  CAMPFIRE_START_FUEL_SEC,
  CAMPFIRE_WOOD_FUEL_SEC,
  CAMP_INTERACT_RANGE_M,
  CAMP_SPAWN_RING_M,
  NIGHT_CAMPFIRE_COUNT,
  NIGHT_WOOD_PILE_COUNT,
  WOOD_CARRY_MAX,
  WOOD_PILE_GIVE,
  WOOD_PILE_RESPAWN_SEC,
  WOOD_PILE_GAP_M,
  WOOD_PILE_MAX_DIST_M,
  WOOD_PILE_MIN_DIST_M,
  WOLF_NIGHT_RESPAWN_SEC,
  isInsideLitCampfire,
  type CampActionAck,
  type CampfireEvent,
  type CampfireSnap,
  type FeedFireReq,
  type TakeWoodReq,
  type WoodPileSnap,
  NIGHT_DEFAULT_MINUTES,
  NIGHT_MAX_MINUTES,
  NIGHT_MIN_MINUTES,
  NIGHT_WAVES,
  NIGHT_WAVE_COUNT,
  WOLF_BITE_CONNECT_RANGE,
  WOLF_BITE_DAMAGE,
  WOLF_CORPSE_SEC,
  WOLF_HEIGHT,
  WOLF_MAX_HP,
  WOLF_MAX_PER_ROOM,
  WOLF_NAME_UZ,
  WOLF_RADIUS,
  WOLF_RESPAWN_SEC,
  WOLF_SPAWN_CLEARANCE,
  evaluateNightWave,
  isWolfThreatState,
  type NightSnap,
  type NightWave,
  type WolfBiteEvent,
  type WolfDeathEvent,
  type WolfHowlEvent,
  type WolfSnap,
} from '../shared/wolf';
import { WolfBrain, type ServerWolf } from './wolf';
import type {
  ChatMsg, ClientState, ContainerOpenAck, ContainerOpenReq, CreateRoomOpts, EquipWeaponAck, EquipWeaponReq,
  HitConfirm, HurtEvent, KillEvent, LootPickupAck, LootPickupReq, MatchState,
  PlayerInputBatchMsg, PlayerInputCmd, PlayerInventorySnap, PlayerSnap, ReadyAck, ReadyMsg,
  RoomInfo, RoomLootSnapshot, RosterEntry, ShootMsg, ShotEvent, Snapshot, SpawnEvent,
  SurvivalConfig, SurvivalPhase, SurvivalStateSnap, SurvivalWinReason, UseMedkitAck, UseMedkitReq, WelcomeMsg,
} from '../shared/protocol';
import { packGearState } from '../shared/protocol';
import { eyeHeightOf, hitboxScaleOf } from '../shared/stance';
import {
  ARMOR_DAMAGE_ABSORB,
  HELMET_HEADSHOT_ABSORB,
  LOOT_ERROR_MESSAGES_UZ,
  validateBulletDirectionsAgainstAim,
} from '../shared/loot';
import {
  KNIFE_BACKSTAB_DOT,
  KNIFE_BACKSTAB_MUL,
  damageAt,
  emptyAmmo,
  fullAmmo,
  isMeleeWeapon,
  isWeaponId,
  WEAPONS,
  type AmmoState,
  type WeaponDef,
  type WeaponId,
} from '../shared/weapons';
import {
  createWorldDefinition, CURRENT_WORLD_VERSION, DEFAULT_PUBLIC_LAYOUT_SEED, extractWorldMeta,
  sampleTerrainHeight, validateWorldCompatibility, type SpawnPointDef, type WorldDefinition, type WorldMeta,
} from '../shared/world';
import { BotBrain, pickBotName } from './bot';
import {
  applyAuthoritativeWeaponSwitch,
  executeGrenadeTickBatch,
  isValidGrenadeRecord,
  resetServerWeaponSwitchState,
  validateAuthoritativeShotWeapon,
  type ServerGrenadeRecord,
} from './combat';
import { RoomLootAuthority, type LootAuthorityStats } from './loot';
import { PlayerMovementAuthority, type MovementAuthorityStats } from './movementAuthority';
import { getNav, type NavGraph } from './navgraph';
import { SurvivalRoundController } from './survival';
import {
  ZONE_DAMAGE_INTERVAL_SEC,
  buildSurvivalZoneTimeline,
  evaluateSurvivalZone,
  isOutsideSurvivalZone,
  type SurvivalZoneSnap,
  type SurvivalZoneTimeline,
} from '../shared/survival';

export interface ServerPlayer extends Body {
  id: string;
  name: string;
  team: Team;
  isBot: boolean;
  socket: Socket | null;
  ready: boolean;
  yaw: number;
  pitch: number;
  scoped: boolean;
  stamina: number;
  staminaLocked: boolean;
  /** Zirh nimcha va kaska mustahkamligi (loot rejimi; 0 = yo'q). */
  armor: number;
  helmet: number;
  hp: number;
  alive: boolean;
  respawnAt: number;
  spawnId: number;
  spawnTime: number;
  weapon: WeaponId | null;
  switchUntil: number;
  ammo: AmmoState;
  reloadUntil: number;
  reloadWeapon: WeaponId | null;
  /** Klient hali ishlanmagan qurol almashtirish kirishi bilan birga yuborgan reload so'rovi (shu qurol uchun). */
  pendingReloadWeapon: WeaponId | null;
  pendingReloadUntil: number;
  lastShot: number;
  /** Otish tezligi nazorati (token bucket): to'plangan otish huquqi va oxirgi to'ldirish vaqti. */
  fireCredit: number;
  fireCreditAt: number;
  lastTeamSwitch: number;
  grenades: number;
  lastGrenade: number;
  kills: number;
  deaths: number;
  ping: number;
  /** wolf_night: qo'ldagi o'tin (0..WOOD_CARRY_MAX); tug'ilganda 0, o'lganda yo'qoladi. */
  wood: number;
  /** wolf_night: oxirgi lager amali (o'tin olish/tashlash) vaqti — spamga qarshi (0.3 s). */
  lastCampAction: number;
  /** Loot so'rovlari tezligi (faqat odamlar, token bucket): qolgan so'rovlar va oxirgi to'ldirish vaqti. */
  lootTokens: number;
  lootTokensAt: number;
  brain: BotBrain | null;
  authority: PlayerMovementAuthority;
}

/** Lager gulxani (server holati). Joy (`def`) xona uchun bir marta tanlanadi, o'tin/yonish har raundda tiklanadi. */
export interface ServerCampfire {
  id: string;
  /** Chat uchun nom: "Asosiy lager", "2-lager", "3-lager". */
  name: string;
  x: number;
  y: number;
  z: number;
  main: boolean;
  fuelSec: number;
  lit: boolean;
  /** 'low' hodisasi shu yonish davrida yuborilganmi (bir marta). */
  lowWarned: boolean;
}

/** O'tin g'arami (server holati). */
export interface ServerWoodPile {
  id: string;
  x: number;
  y: number;
  z: number;
  available: boolean;
  respawnAt: number;
}

/** Gulxanlar joylashuvi uchun POI afzalligi: asosiy — uylar guruhi hovlisi, keyin qoya, kemping, ... */
const CAMP_FIRE_POI_ORDER: readonly ForestSquarePoiId[] = [
  'poi_cabin_cluster',
  'poi_cliff_watch',
  'poi_forest_camp',
  'poi_lumber_mill',
  'poi_ranger_house',
  'poi_service_station',
];
const CAMP_FIRE_NAMES_UZ = ['Asosiy lager', '2-lager', '3-lager', '4-lager', '5-lager'];
/** Gulxanlar orasidagi eng kam masofa, g'aram–gulxan oralig'i va g'aramlar orasidagi eng kam masofa (m). */
const CAMP_FIRE_MIN_GAP_M = 60;
const CAMP_PILE_MIN_DIST_M = WOOD_PILE_MIN_DIST_M;
const CAMP_PILE_MAX_DIST_M = WOOD_PILE_MAX_DIST_M;
const CAMP_PILE_GAP_M = WOOD_PILE_GAP_M;
/** Gulxan atrofida kollayder bo'lmasligi kerak bo'lgan radius (devor ichida yonmasin). */
const CAMP_FIRE_CLEARANCE_M = 1.6;
/** Gulxan o'chganda shu masofadagi bo'rilar qorong'i lagerga keladi (m). */
const CAMP_FIRE_OUT_LURE_M = 40;
/** Bo'rilar yonib turgan gulxandan va o'yinchilardan kamida shuncha uzoqda tug'iladi (wolf_night, m). */
const NIGHT_WOLF_SPAWN_CLEARANCE_M = 45;
/** Botlar lager atrofida sayr qiladigan radius (m). */
const CAMP_ROAM_RADIUS_M = 10;

let roomSeq = 0;

type LootGateRejectCode = 'PLAYER_NOT_FOUND' | 'ROUND_NOT_ACTIVE' | 'RATE_LIMITED';

/**
 * Odamning loot so'rovlari (ochish/olish/qurollanish/aptechka) chegarasi: zaxira LOOT_REQ_BURST, sekundiga
 * LOOT_REQ_PER_SEC to'ladi. Odam bunchalik tez bosa olmaydi — faqat so'rov toshqinini to'xtatadi.
 * Botlar darvozadan o'tmaydi (botOpenContainer/botPickupItem), ularga ta'sir qilmaydi.
 */
const LOOT_REQ_BURST = 60;
const LOOT_REQ_PER_SEC = 30;

/** Xom so'rovdan satr maydonini o'qiydi; yo'q yoki satr bo'lmasa — ''. */
function readStringField(rawReq: unknown, key: string): string {
  const v = (rawReq as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === 'string' ? v : '';
}

export class Room {
  readonly id: string;
  readonly world: WorldDefinition;
  readonly nav: NavGraph;
  readonly isSurvival: boolean;
  /** "Tong otguncha" (wolf_night): survival hayot sikli + bo'ri to'lqinlari, zona yo'q, tong otganda hamma tirik g'olib. */
  readonly isNight: boolean;
  readonly lootEnabled: boolean;
  /** @deprecated Stage 06 qoldig'i — har doim `lootEnabled` bilan bir xil; protokol maydoni uchun saqlanadi. */
  get lootPreview(): boolean {
    return this.lootEnabled;
  }
  readonly loot: RoomLootAuthority;
  readonly survival: SurvivalRoundController | null;
  private secretLootSeed: number;
  private roundId = 1;
  readonly players = new Map<string, ServerPlayer>();
  phase: SurvivalPhase = 'playing';
  serverTick = 0;
  private manualTimeSec: number | null = null;
  private deferWinCheck = false;
  private rejectedWeaponShots = 0;
  private rejectedUnequippedWeaponShots = 0;
  private rejectedSwitchCooldownShots = 0;
  private rejectedFakeOriginShots = 0;
  private rejectedAimDirectionShots = 0;
  private grenades: ServerGrenadeRecord[] = [];
  private scores = { red: 0, blue: 0 };
  private matchEndsAt: number;
  private phaseEndsAt = 0;
  private winner = '';
  private winnerId: string | null = null;
  private timer: NodeJS.Timeout;
  private lastTick: number;
  private grenadeSeq = 0;
  private botSeq = 0;
  private rosterDirty = true;
  private nextRosterAt = 0;
  private nextMatchAt = 0;
  /** Forest Survival xavfsiz zona jadvali (raund boshida quriladi) va raund boshlangan vaqt. */
  private zoneTimeline: SurvivalZoneTimeline | null = null;
  private roundStartedAt = 0;
  private nextZoneDamageAt = 0;
  /** Bir tickda ko'pi bilan bitta bot mahalliy (0.8 m) yo'l hisoblaydi — tick vaqti sakramasin. */
  private localPathBudget = 1;

  takeLocalPathBudget(): boolean {
    if (this.localPathBudget <= 0) return false;
    this.localPathBudget--;
    return true;
  }
  private chatHistory: ChatMsg[] = [];
  /** Xonadan chiqib ketgan, lekin hali portlamagan granatasi bor o'yinchilar (granata zarar berishi uchun). */
  private departed = new Map<string, ServerPlayer>();
  /** Vahshiy bo'rilar (server boshqaradi; survivalda raund boshida paydo bo'ladi, klassikda doimiy). */
  readonly wolves = new Map<string, ServerWolf>();
  private wolfSeq = 0;
  /** Xona sozlamasidagi bo'rilar soni (chat buyruqlari bilan o'zgartiriladi; wolf_night da to'lqin belgilaydi). */
  private wolfCount: number;
  /** wolf_night: joriy to'lqin indeksi (0..NIGHT_WAVE_COUNT-1), raunddan tashqarida -1. */
  private nightWaveIdx = -1;
  /** wolf_night: lager gulxanlari va o'tin g'aramlari (joylar xona uchun deterministik; boshqa rejimlarda bo'sh). */
  readonly campfires = new Map<string, ServerCampfire>();
  readonly woodPiles = new Map<string, ServerWoodPile>();
  /** Gulxan atrofidagi (CAMP_ROAM_RADIUS_M) nav tugunlari keshi — botlar lager sayri uchun. */
  private campRoamCache = new Map<string, Vec3[]>();
  destroyed = false;

  constructor(readonly opts: CreateRoomOpts, private io: Server, private onEmpty: (room: Room) => void) {
    this.id = 'r' + ++roomSeq + Math.random().toString(36).slice(2, 6);
    this.isSurvival = isSurvivalMode(opts.mode);
    this.isNight = opts.mode === 'wolf_night';
    if (this.isSurvival && opts.mapId && opts.mapId !== 'forest_square') {
      throw new Error(`${GAME_MODE_NAMES_UZ[opts.mode]} rejimi faqat forest_square xaritasida yaratilishi mumkin`);
    }
    const mapId = this.isSurvival ? 'forest_square' : (opts.mapId ?? 'forest_square');
    this.world = createWorldDefinition({
      mapId,
      worldVersion: CURRENT_WORLD_VERSION,
      publicLayoutSeed: opts.publicLayoutSeed ?? DEFAULT_PUBLIC_LAYOUT_SEED,
    });
    this.nav = getNav(this.world);
    this.secretLootSeed = Math.floor(Math.random() * 0x7fffffff) + 1;
    this.lootEnabled = this.isSurvival || (Boolean(opts.lootPreview) && mapId === 'forest_square');
    this.loot = new RoomLootAuthority(this.world, this.secretLootSeed, this.id, this.lootEnabled, this.roundId);

    if (this.isSurvival) {
      this.phase = 'waiting';
      this.survival = new SurvivalRoundController(
        {
          getPlayers: () => this.players.values(),
          getPlayerById: (id) => this.players.get(id),
          onRoundStart: (roundId, contenderIds) => this.handleSurvivalRoundStart(roundId, contenderIds),
          onRoundEnd: (roundId, winnerId, winnerName, winReason) =>
            this.handleSurvivalRoundEnd(roundId, winnerId, winnerName, winReason),
          onPreRoundReset: (nextRoundId, nextPhase) =>
            this.handleSurvivalPreRoundReset(nextRoundId, nextPhase),
          onPhaseChanged: (phase, roundId) => {
            this.phase = phase;
            this.roundId = roundId;
            this.rosterDirty = true;
            this.sendMatch();
          },
          onSystemChat: (textUz) => this.systemChat(textUz),
        },
        this.isNight
          ? {
              // Tong otguncha: yakka o'yinchi ham o'ynaydi, tun = timeLimit daqiqa (3..20, berilmasa lobbidagi standart), zona yo'q,
              // raund oxirgi tirik qolganda tugamaydi — tong otganda barcha tirik ishtirokchilar g'olib
              minPlayersToStart: 1,
              countdownDurationSec: opts.countdownSec ?? 10,
              roundDurationSec: clamp(opts.timeLimit || NIGHT_DEFAULT_MINUTES, NIGHT_MIN_MINUTES, NIGHT_MAX_MINUTES) * 60,
              endedDisplayDurationSec: MATCH_END_DURATION,
              zoneEnabled: false,
              minHumansToStart: Math.max(1, Math.floor(opts.minHumans ?? 1)),
              sharedSurvival: true,
            }
          : {
              minPlayersToStart: 2,
              countdownDurationSec: opts.countdownSec ?? 10,
              roundDurationSec: Math.max(5, (opts.timeLimit || 3) * 60),
              endedDisplayDurationSec: MATCH_END_DURATION,
              zoneEnabled: true,
              minHumansToStart: Math.max(1, Math.floor(opts.minHumans ?? 1)),
            },
      );
    } else {
      this.phase = 'playing';
      this.survival = null;
    }

    this.matchEndsAt = this.now() + opts.timeLimit * 60;
    this.lastTick = this.now();
    // Botlar barcha rejimlarda (loot rejimida ham — loot AI bilan qurol yig'adi)
    const initialBots = opts.bots;
    for (let i = 0; i < initialBots; i++) this.addBot();
    // Bo'rilar: klassik rejimlarda darhol, survivalda raund boshida (handleSurvivalRoundStart);
    // wolf_night da sonni to'lqinlar belgilaydi (opts.wolves e'tiborga olinmaydi)
    this.wolfCount = this.isNight ? 0 : clamp(Math.floor(opts.wolves ?? 0), 0, WOLF_MAX_PER_ROOM);
    if (!this.isSurvival) this.syncWolvesToCount();
    // Tong otguncha: lager joylashuvi (gulxanlar + o'tin g'aramlari) xona uchun bir marta tanlanadi
    if (this.isNight) this.buildCampLayout();
    // Windows'da taymer aniqligi ~15.6 ms, shuning uchun tez-tez tekshirib, aniq 30 Hz ushlab turamiz
    const step = 1 / TICK_RATE;
    let nextTick = this.now();
    this.timer = setInterval(() => {
      if (this.manualTimeSec !== null) return;
      const t = this.now();
      if (t < nextTick) return;
      this.tick();
      nextTick += step;
      if (t - nextTick > step * 3) nextTick = t + step;
    }, 4);
  }

  now(): number {
    return this.manualTimeSec !== null ? this.manualTimeSec : performance.now() / 1000;
  }

  /** Deterministik testlar uchun vaqtni boshqariladigan tarzda oldinga surish. */
  advanceTimeForTest(dtSec: number, stepSec = 1 / TICK_RATE): void {
    if (this.manualTimeSec === null) {
      this.manualTimeSec = performance.now() / 1000;
    }
    let remaining = Math.max(0, dtSec);
    const step = Math.max(0.005, stepSec);
    while (remaining > 1e-6 && !this.destroyed) {
      const d = Math.min(remaining, step);
      this.manualTimeSec += d;
      this.tick();
      remaining -= d;
    }
  }

  setSurvivalConfigForTest(partial: Partial<SurvivalConfig>): void {
    if (this.survival) {
      this.survival.setConfig(partial, this.now());
      this.sendMatch();
    }
  }

  getSurvivalState(): SurvivalStateSnap | null {
    return this.survival ? this.survival.getStateSnap(this.now()) : null;
  }

  getRoundId(): number {
    return this.roundId;
  }

  get channel(): string {
    return 'room:' + this.id;
  }

  worldMeta(): WorldMeta {
    return extractWorldMeta(this.world);
  }

  /** Server ichidagi loot generatori uchun maxfiy seed (mijozlarga uzatilmaydi). */
  getSecretLootSeedForServer(): number {
    return this.secretLootSeed;
  }

  humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  botCount(): number {
    return this.players.size - this.humanCount();
  }

  info(): RoomInfo {
    return {
      id: this.id,
      name: this.opts.name,
      mode: this.opts.mode,
      players: this.humanCount(),
      bots: this.botCount(),
      maxPlayers: this.opts.maxPlayers,
      timeLimit: this.opts.timeLimit,
      scoreLimit: this.opts.scoreLimit,
      world: this.worldMeta(),
      lootPreview: this.lootPreview,
      lootEnabled: this.lootEnabled,
      roundId: this.roundId,
      phase: this.phase,
      minHumans: this.isSurvival ? this.survival?.getConfig().minHumansToStart ?? 1 : undefined,
      wolves: this.wolfCount,
    };
  }

  // ---------------- Bo'rilar ----------------

  /** Bo'ri shu o'yinchini ovlashi mumkinmi (tirik; survivalda faqat ishtirokchi). */
  isWolfPrey(p: ServerPlayer): boolean {
    if (!p.alive || !p.ready) return false;
    if (this.isSurvival && this.survival) return this.survival.isAliveContender(p.id);
    return true;
  }

  /** Xonadagi bo'rilar soni sozlamaga tenglashtiriladi (kam bo'lsa qo'shadi, ko'p bo'lsa olib tashlaydi). */
  private syncWolvesToCount(): void {
    while (this.wolves.size > this.wolfCount) {
      const last = [...this.wolves.keys()].pop();
      if (last === undefined) break;
      this.wolves.delete(last);
    }
    while (this.wolves.size < this.wolfCount) this.addWolf();
  }

  /**
   * Bo'rilar sonini o'zgartirish (chat buyrug'i / pauza menyusi). Survivalda keyingi raunddan kuchga kiradi.
   * wolf_night da sonni to'lqinlar boshqaradi — qo'lda o'zgartirilmaydi.
   */
  setWolfCount(n: number): number {
    if (this.isNight) return this.wolfCount;
    this.wolfCount = clamp(Math.floor(n), 0, WOLF_MAX_PER_ROOM);
    if (!this.isSurvival || this.phase === 'playing') this.syncWolvesToCount();
    return this.wolfCount;
  }

  getWolfCount(): number {
    return this.wolfCount;
  }

  /** O'yinchilardan uzoqdagi (≥ 35 m, iloji bo'lsa) nav tuguni — bo'ri paydo bo'ladigan joy. */
  private pickWolfSpawn(): Vec3 {
    const zone = this.getZoneSnap();
    // wolf_night: yonib turgan gulxanlardan va o'yinchilardan ≥ 45 m; boshqa rejimlarda o'yinchilardan ≥ 35 m
    const need = this.isNight ? NIGHT_WOLF_SPAWN_CLEARANCE_M : 35;
    let best: Vec3 | null = null;
    let bestD = -1;
    for (let i = 0; i < (this.isNight ? 40 : 24); i++) {
      const c = this.nav.randomPoint();
      if (zone && Math.hypot(c.x - zone.cx, c.z - zone.cz) > zone.radius * 0.9) continue;
      let minD = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        minD = Math.min(minD, Math.hypot(p.pos.x - c.x, p.pos.z - c.z));
      }
      if (this.isNight) {
        for (const f of this.campfires.values()) {
          if (!f.lit) continue;
          minD = Math.min(minD, Math.hypot(f.x - c.x, f.z - c.z));
        }
      }
      if (minD >= need) return c;
      if (minD > bestD) {
        bestD = minD;
        best = c;
      }
    }
    return best ?? this.nav.randomPoint();
  }

  /**
   * Sayr maqsadi: tasodifiy o'ljaning atrofida (14–40 m halqa) nav tuguni — bo'ri doim o'yinchilar
   * atrofida aylanib yuradi va oxir-oqibat hid/ko'rish masofasiga kiradi. O'lja bo'lmasa — xaritada tasodifiy.
   */
  pickWolfRoamGoal(w: ServerWolf): Vec3 {
    const prey = [...this.players.values()].filter((p) => this.isWolfPrey(p));
    const zone = this.getZoneSnap();
    const b = this.world.bounds;
    if (prey.length) {
      for (let i = 0; i < 10; i++) {
        const p = prey[Math.floor(Math.random() * prey.length)]!;
        const ang = Math.random() * Math.PI * 2;
        const dist = 14 + Math.random() * 26;
        const x = p.pos.x + Math.cos(ang) * dist;
        const z = p.pos.z + Math.sin(ang) * dist;
        if (x < b.minX + 2 || x > b.maxX - 2 || z < b.minZ + 2 || z > b.maxZ - 2) continue;
        if (zone && Math.hypot(x - zone.cx, z - zone.cz) > zone.radius) continue;
        const ni = this.nav.nearest({ x, y: p.pos.y, z });
        if (ni < 0) continue;
        const c = this.nav.center(ni);
        if (Math.hypot(c.x - w.pos.x, c.z - w.pos.z) < 6) continue;
        // Yonib turgan gulxan doirasi ichiga sayr maqsadi qo'yilmaydi (bo'ri olovdan qo'rqadi)
        if (this.litFireContaining(c.x, c.z, 2)) continue;
        return c;
      }
    }
    for (let i = 0; i < 8; i++) {
      const c = this.nav.randomPoint();
      if (zone && Math.hypot(c.x - zone.cx, c.z - zone.cz) > zone.radius) continue;
      if (this.litFireContaining(c.x, c.z, 2)) continue;
      if (Math.hypot(c.x - w.pos.x, c.z - w.pos.z) >= 6) return c;
    }
    return this.nav.randomPoint();
  }

  // ---------------- Lager: gulxanlar va o'tin (wolf_night) ----------------

  /** Nuqtani o'z ichiga olgan yonib turgan gulxan (radius + margin), bo'lmasa null. */
  litFireContaining(x: number, z: number, margin = 0): ServerCampfire | null {
    for (const f of this.campfires.values()) {
      if (isInsideLitCampfire(f, x, z, margin)) return f;
    }
    return null;
  }

  /** Nuqtaga eng yaqin yonib turgan gulxan (yo'q bo'lsa null). */
  nearestLitFire(x: number, z: number): ServerCampfire | null {
    let best: ServerCampfire | null = null;
    let bestD = Infinity;
    for (const f of this.campfires.values()) {
      if (!f.lit) continue;
      const d = Math.hypot(f.x - x, f.z - z);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  /** Asosiy lager gulxani (wolf_night; boshqa rejimlarda null). */
  mainCampfire(): ServerCampfire | null {
    for (const f of this.campfires.values()) if (f.main) return f;
    return this.campfires.values().next().value ?? null;
  }

  /**
   * Gulxan uchun nav tuguni: `center` atrofida (0, 2, 4, 6 m halqalar, 8 yo'nalish) sinab chiqiladi —
   * tugun sayr komponentida, `maxFromCenter` ichida va atrofida 1.6 m radiusda kollayder bo'lmasligi kerak
   * (devor/ustun ichida yonmasin). Topilmasa null.
   */
  private findFireNode(
    center: { x: number; z: number },
    maxFromCenter: number,
    roamSet: Set<number>,
    taken: Vec3[],
    minGap: number,
  ): Vec3 | null {
    const offsets: { dx: number; dz: number }[] = [{ dx: 0, dz: 0 }];
    for (const r of [2, 4, 6, 8]) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        offsets.push({ dx: Math.cos(a) * r, dz: Math.sin(a) * r });
      }
    }
    for (const o of offsets) {
      const x = center.x + o.dx;
      const z = center.z + o.dz;
      const ni = this.nav.nearest({ x, y: sampleTerrainHeight(this.world.terrain, x, z), z });
      if (ni < 0 || !roamSet.has(ni)) continue;
      const c = this.nav.center(ni);
      if (Math.hypot(c.x - center.x, c.z - center.z) > maxFromCenter) continue;
      if (taken.some((t) => Math.hypot(t.x - c.x, t.z - c.z) < minGap)) continue;
      // Gulxan atrofi bo'sh bo'lsin: 1.6 m radius, 1 m balandlik (past olov)
      if (collidesAtWorld(this.world, c.x, c.y + 0.05, c.z, CAMP_FIRE_CLEARANCE_M, 1.0)) continue;
      return c;
    }
    return null;
  }

  /**
   * Lager joylashuvi (deterministik, publicLayoutSeed bo'yicha): asosiy gulxan — uylar guruhi hovlisida,
   * yana ikkitasi boshqa POI'larda (≥ 60 m oraliq); o'tin g'aramlari eng yaqin gulxandan 25–55 m da,
   * bir-biridan va gulxanlardan ≥ 12 m, turli yo'nalishlarda. Nomzod topilmasa — tasodifiy (seedli) sayr
   * tugunlari, rejim hech qachon buzilmaydi.
   */
  private buildCampLayout(): void {
    this.campfires.clear();
    this.woodPiles.clear();
    this.campRoamCache.clear();
    const seed = this.world.publicLayoutSeed || DEFAULT_PUBLIC_LAYOUT_SEED;
    const rng = createSeededRng((seed ^ 0x0ca3f1) >>> 0 || 1);
    const nav = this.nav;
    const roam = nav.roamList.length ? nav.roamList : nav.validList;
    const roamSet = new Set(roam);
    const randomRoamNode = (): Vec3 => nav.center(roam[Math.floor(rng() * roam.length)]!);

    // 1) Gulxanlar
    const fires: Vec3[] = [];
    const sites = this.world.mapId === 'forest_square' ? getForestSquarePoiSites(seed) : [];
    const byId = new Map(sites.map((s) => [s.id, s] as const));
    for (const poiId of CAMP_FIRE_POI_ORDER) {
      if (fires.length >= NIGHT_CAMPFIRE_COUNT) break;
      const site = byId.get(poiId);
      if (!site) continue;
      const c = this.findFireNode(site.center, site.flatRadius, roamSet, fires, CAMP_FIRE_MIN_GAP_M);
      if (c) fires.push(c);
    }
    // Zaxira: POI'lar yetmasa — tasodifiy sayr tugunlari (≥ 60 m oraliq, keyin shart yumshatiladi)
    for (let gap = CAMP_FIRE_MIN_GAP_M; fires.length < NIGHT_CAMPFIRE_COUNT && gap >= 0; gap = gap >= 20 ? gap - 20 : -1) {
      for (let i = 0; i < 200 && fires.length < NIGHT_CAMPFIRE_COUNT; i++) {
        const c = randomRoamNode();
        if (fires.some((f) => Math.hypot(f.x - c.x, f.z - c.z) < gap)) continue;
        if (collidesAtWorld(this.world, c.x, c.y + 0.05, c.z, CAMP_FIRE_CLEARANCE_M, 1.0)) continue;
        fires.push(c);
      }
    }
    fires.forEach((c, i) => {
      const id = `fire:${i + 1}`;
      this.campfires.set(id, {
        id,
        name: CAMP_FIRE_NAMES_UZ[i] ?? `${i + 1}-lager`,
        x: q3(c.x),
        y: q3(c.y),
        z: q3(c.z),
        main: i === 0,
        fuelSec: CAMPFIRE_START_FUEL_SEC,
        lit: true,
        lowWarned: false,
      });
    });

    // 2) O'tin g'aramlari: har biri bitta gulxanga "biriktirilgan" yo'nalish sektorida qidiriladi
    const piles: Vec3[] = [];
    const nearestFireDist = (x: number, z: number) =>
      fires.reduce((m, f) => Math.min(m, Math.hypot(f.x - x, f.z - z)), Infinity);
    const pileOk = (c: Vec3, strict: boolean): boolean => {
      const df = nearestFireDist(c.x, c.z);
      if (strict && (df < CAMP_PILE_MIN_DIST_M || df > CAMP_PILE_MAX_DIST_M)) return false;
      if (df < CAMP_PILE_GAP_M) return false;
      if (piles.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < CAMP_PILE_GAP_M)) return false;
      return true;
    };
    if (fires.length) {
      const perFire = Math.ceil(NIGHT_WOOD_PILE_COUNT / fires.length);
      for (let i = 0; i < NIGHT_WOOD_PILE_COUNT; i++) {
        const f = fires[i % fires.length]!;
        const sector = Math.floor(i / fires.length);
        const baseAng = (sector / perFire) * Math.PI * 2 + rng() * 0.6;
        let found: Vec3 | null = null;
        for (let k = 0; k < 60 && !found; k++) {
          // Sektor atrofida ±, masofa 28–50 m
          const ang = baseAng + (k % 2 ? 1 : -1) * Math.floor(k / 2) * 0.35;
          const dist = CAMP_PILE_MIN_DIST_M + 2 + rng() * (CAMP_PILE_MAX_DIST_M - CAMP_PILE_MIN_DIST_M - 4);
          const x = f.x + Math.cos(ang) * dist;
          const z = f.z + Math.sin(ang) * dist;
          const b = this.world.bounds;
          if (x < b.minX + 3 || x > b.maxX - 3 || z < b.minZ + 3 || z > b.maxZ - 3) continue;
          const ni = nav.nearest({ x, y: sampleTerrainHeight(this.world.terrain, x, z), z });
          if (ni < 0 || !roamSet.has(ni)) continue;
          const c = nav.center(ni);
          if (!pileOk(c, true)) continue;
          found = c;
        }
        if (found) piles.push(found);
      }
    }
    // Zaxira: qat'iy shartlar bilan tasodifiy tugunlar, keyin faqat oraliq sharti bilan
    for (const strict of [true, false]) {
      for (let i = 0; i < 1500 && piles.length < NIGHT_WOOD_PILE_COUNT; i++) {
        const c = randomRoamNode();
        if (pileOk(c, strict)) piles.push(c);
      }
    }
    while (piles.length < NIGHT_WOOD_PILE_COUNT) piles.push(randomRoamNode());
    piles.forEach((c, i) => {
      const id = `pile:${i + 1}`;
      this.woodPiles.set(id, { id, x: q3(c.x), y: q3(c.y), z: q3(c.z), available: true, respawnAt: 0 });
    });
  }

  /** Raund boshi: gulxanlar to'liq boshlang'ich o'tin bilan yonadi, g'aramlar to'la, o'yinchilar o'tinsiz. */
  private resetCampForRound(): void {
    for (const f of this.campfires.values()) {
      f.fuelSec = CAMPFIRE_START_FUEL_SEC;
      f.lit = true;
      f.lowWarned = false;
    }
    for (const pl of this.woodPiles.values()) {
      pl.available = true;
      pl.respawnAt = 0;
    }
    this.campRoamCache.clear();
  }

  private emitCampfireEvent(f: ServerCampfire, kind: CampfireEvent['kind'], by?: ServerPlayer): void {
    const ev: CampfireEvent = { fireId: f.id, kind, fuelSec: Math.max(0, Math.round(f.fuelSec)) };
    if (by) {
      ev.by = by.id;
      ev.byName = by.name;
    }
    this.io.to(this.channel).emit('campfire', ev);
  }

  /** Har tick ('playing'): o'tin yonadi, "o'chmoqda" ogohlantirishi, o'chish (bo'rilar qorong'i lagerga keladi), g'aramlar to'ladi. */
  private updateCamp(dt: number, t: number): void {
    for (const f of this.campfires.values()) {
      if (!f.lit) continue;
      f.fuelSec = Math.max(0, f.fuelSec - dt);
      if (f.fuelSec <= 0) {
        f.lit = false;
        f.lowWarned = false;
        this.campRoamCache.clear();
        this.emitCampfireEvent(f, 'out');
        this.systemChat(`🌑 ${f.name} gulxani o'chdi! Bo'rilar qorong'ida yaqinlashadi — tezroq o'tin tashlang.`);
        for (const w of this.wolves.values()) {
          if (!w.alive) continue;
          if (Math.hypot(w.pos.x - f.x, w.pos.z - f.z) <= CAMP_FIRE_OUT_LURE_M) {
            w.brain.onFireOut({ x: f.x, y: f.y, z: f.z }, t);
          }
        }
      } else if (!f.lowWarned && f.fuelSec <= CAMPFIRE_LOW_FUEL_SEC) {
        f.lowWarned = true;
        this.emitCampfireEvent(f, 'low');
        this.systemChat(`⚠️ ${f.name} gulxani o'chmoqda — o'tin keltiring!`);
      }
    }
    for (const pl of this.woodPiles.values()) {
      if (!pl.available && t >= pl.respawnAt) pl.available = true;
    }
  }

  /** Lager amali uchun darvoza: rejim, raund fazasi, tirik ishtirokchi. */
  private campActionGate(p: ServerPlayer): CampActionAck | null {
    if (!this.isNight) return { ok: false, error: 'NOT_NIGHT', wood: p.wood };
    if (this.phase !== 'playing' || !p.alive || !p.ready || !this.survival?.canPlayerCombat(p.id)) {
      return { ok: false, error: 'ROUND_NOT_ACTIVE', wood: p.wood };
    }
    return null;
  }

  /** Oyoq nuqtalari orasidagi masofa (XZ) va balandlik farqi (≤ 2 m) bo'yicha yetib bo'ladimi. */
  private campInReach(p: ServerPlayer, o: { x: number; y: number; z: number }): boolean {
    return Math.hypot(o.x - p.pos.x, o.z - p.pos.z) <= CAMP_INTERACT_RANGE_M && Math.abs(o.y - p.pos.y) <= 2;
  }

  /** Spamga qarshi: bir o'yinchi 0.3 s da bitta lager amali (ack'da xato kodi yo'q — klient jim qoladi). */
  private campRateLimited(p: ServerPlayer): boolean {
    const t = this.now();
    if (t - p.lastCampAction < 0.3) return true;
    p.lastCampAction = t;
    return false;
  }

  /** O'tin g'aramidan o'tin olish (odam va bot uchun umumiy mantiq). */
  private takeWoodCore(p: ServerPlayer, pileId: string): CampActionAck {
    const gate = this.campActionGate(p);
    if (gate) return gate;
    const pile = this.woodPiles.get(pileId);
    if (!pile) return { ok: false, error: 'NOT_FOUND', wood: p.wood };
    if (!this.campInReach(p, pile)) return { ok: false, error: 'TOO_FAR', wood: p.wood };
    if (!pile.available) return { ok: false, error: 'PILE_EMPTY', wood: p.wood };
    if (p.wood >= WOOD_CARRY_MAX) return { ok: false, error: 'HANDS_FULL', wood: p.wood };
    if (this.campRateLimited(p)) return { ok: false, wood: p.wood };
    p.wood = Math.min(WOOD_CARRY_MAX, p.wood + WOOD_PILE_GIVE);
    pile.available = false;
    pile.respawnAt = this.now() + WOOD_PILE_RESPAWN_SEC;
    return { ok: true, wood: p.wood };
  }

  /**
   * Qo'ldagi o'tinni gulxanga tashlash (odam va bot uchun umumiy mantiq): faqat sig'adigan o'tinlar tashlanadi —
   * gulxanni to'ldirish uchun kerakli son (oxirgisi qisman ketishi mumkin), qolgani qo'lda qoladi.
   */
  private feedFireCore(p: ServerPlayer, fireId: string): CampActionAck {
    const gate = this.campActionGate(p);
    if (gate) return gate;
    const f = this.campfires.get(fireId);
    if (!f) return { ok: false, error: 'NOT_FOUND', wood: p.wood };
    if (!this.campInReach(p, f)) return { ok: false, error: 'TOO_FAR', wood: p.wood, fuelSec: Math.round(f.fuelSec) };
    if (p.wood <= 0) return { ok: false, error: 'NO_WOOD', wood: 0, fuelSec: Math.round(f.fuelSec) };
    if (f.lit && f.fuelSec >= CAMPFIRE_MAX_FUEL_SEC - 5) {
      return { ok: false, error: 'FIRE_FULL', wood: p.wood, fuelSec: Math.round(f.fuelSec) };
    }
    if (this.campRateLimited(p)) return { ok: false, wood: p.wood, fuelSec: Math.round(f.fuelSec) };
    const fits = Math.max(1, Math.ceil((CAMPFIRE_MAX_FUEL_SEC - f.fuelSec) / CAMPFIRE_WOOD_FUEL_SEC));
    const n = Math.min(p.wood, fits);
    p.wood -= n;
    const wasLit = f.lit;
    f.fuelSec = Math.min(CAMPFIRE_MAX_FUEL_SEC, f.fuelSec + CAMPFIRE_WOOD_FUEL_SEC * n);
    f.lit = true;
    f.lowWarned = f.fuelSec <= CAMPFIRE_LOW_FUEL_SEC;
    if (!wasLit) this.campRoamCache.clear();
    this.emitCampfireEvent(f, 'fed', p);
    this.systemChat(
      wasLit
        ? `🔥 ${p.name} gulxanga o'tin tashladi (${n})`
        : `🔥 ${p.name} ${f.name} gulxanini qayta yoqdi (${n} o'tin)`,
    );
    return { ok: true, wood: p.wood, fuelSec: Math.round(f.fuelSec) };
  }

  onTakeWood(id: string, rawReq: TakeWoodReq | unknown, ack?: (res: CampActionAck) => void): CampActionAck {
    const p = this.players.get(id);
    const pileId = readStringField(rawReq, 'pileId');
    const res: CampActionAck = !p || p.isBot
      ? { ok: false, error: 'NOT_FOUND', wood: 0 }
      : this.takeWoodCore(p, pileId);
    ack?.(res);
    return res;
  }

  onFeedFire(id: string, rawReq: FeedFireReq | unknown, ack?: (res: CampActionAck) => void): CampActionAck {
    const p = this.players.get(id);
    const fireId = readStringField(rawReq, 'fireId');
    const res: CampActionAck = !p || p.isBot
      ? { ok: false, error: 'NOT_FOUND', wood: 0 }
      : this.feedFireCore(p, fireId);
    ack?.(res);
    return res;
  }

  /** Bot o'tin oladi (odam bilan bir xil tekshiruvlar). */
  botTakeWood(p: ServerPlayer, pileId: string): CampActionAck {
    return this.takeWoodCore(p, pileId);
  }

  /** Bot gulxanga o'tin tashlaydi (odam bilan bir xil tekshiruvlar). */
  botFeedFire(p: ServerPlayer, fireId: string): CampActionAck {
    return this.feedFireCore(p, fireId);
  }

  /**
   * Botlar uchun lager sayr maqsadi: asosiy (yonib turgan) gulxan, bo'lmasa eng yaqin yonib turgan, bo'lmasa
   * asosiy gulxan atrofidagi (≤ 10 m) nav tugunlaridan tasodifiy biri. Lager yo'q bo'lsa — xaritada tasodifiy.
   */
  pickCampRoamGoal(p: ServerPlayer): Vec3 {
    const main = this.mainCampfire();
    const anchor = main && main.lit ? main : this.nearestLitFire(p.pos.x, p.pos.z) ?? main;
    if (!anchor) return this.nav.randomPoint();
    let nodes = this.campRoamCache.get(anchor.id);
    if (!nodes) {
      nodes = [];
      const list = this.nav.roamList.length ? this.nav.roamList : this.nav.validList;
      for (const i of list) {
        const c = this.nav.center(i);
        const d = Math.hypot(c.x - anchor.x, c.z - anchor.z);
        if (d <= CAMP_ROAM_RADIUS_M && d >= 1.5) nodes.push(c);
      }
      this.campRoamCache.set(anchor.id, nodes);
    }
    if (!nodes.length) return { x: anchor.x, y: anchor.y, z: anchor.z };
    return nodes[Math.floor(Math.random() * nodes.length)]!;
  }

  /** Gulxanlar snapshoti (asosiy birinchi). */
  private campfireSnaps(): CampfireSnap[] {
    const out: CampfireSnap[] = [];
    for (const f of this.campfires.values()) {
      out.push({
        id: f.id,
        x: f.x,
        y: f.y,
        z: f.z,
        fuelSec: Math.max(0, Math.round(f.fuelSec)),
        maxFuelSec: CAMPFIRE_MAX_FUEL_SEC,
        lit: f.lit,
        main: f.main,
      });
    }
    return out;
  }

  /** O'tin g'aramlari snapshoti. */
  private woodPileSnaps(t: number): WoodPileSnap[] {
    const out: WoodPileSnap[] = [];
    for (const pl of this.woodPiles.values()) {
      const s: WoodPileSnap = { id: pl.id, x: pl.x, y: pl.y, z: pl.z, available: pl.available };
      if (!pl.available) s.respawnInSec = Math.max(0, Math.ceil(pl.respawnAt - t));
      out.push(s);
    }
    return out;
  }

  /** Joriy to'lqin (wolf_night, raund davomida); boshqa hollarda null — ko'paytuvchilar 1. */
  private currentNightWave(): NightWave | null {
    if (!this.isNight || this.nightWaveIdx < 0) return null;
    return NIGHT_WAVES[Math.min(this.nightWaveIdx, NIGHT_WAVES.length - 1)] ?? null;
  }

  /** Yangi paydo bo'lgan/qayta tug'ilgan bo'riga joriy to'lqin ko'paytuvchilarini beradi (jon shu asosda). */
  private applyWaveStats(w: ServerWolf): void {
    const wave = this.currentNightWave();
    w.speedMul = wave ? wave.speedMul : 1;
    w.hpMul = wave ? wave.hpMul : 1;
    w.biteMul = wave ? wave.biteMul : 1;
    w.hp = Math.max(1, Math.round(WOLF_MAX_HP * w.hpMul));
  }

  addWolf(): ServerWolf | null {
    if (this.wolves.size >= WOLF_MAX_PER_ROOM) return null;
    const sp = this.pickWolfSpawn();
    const id = `wolf:${++this.wolfSeq}`;
    const w: ServerWolf = {
      id,
      coat: this.wolves.size % 5,
      pos: { x: sp.x, y: sp.y, z: sp.z },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
      hp: WOLF_MAX_HP,
      alive: true,
      yaw: Math.random() * Math.PI * 2,
      state: 'idle',
      targetId: null,
      diedAt: 0,
      respawnAt: Infinity,
      speedMul: 1,
      hpMul: 1,
      biteMul: 1,
      brain: null as unknown as WolfBrain,
    };
    this.applyWaveStats(w);
    w.brain = new WolfBrain(this, w);
    w.brain.onSpawn(this.now());
    this.wolves.set(id, w);
    return w;
  }

  private respawnWolf(w: ServerWolf): void {
    const sp = this.pickWolfSpawn();
    w.pos = { x: sp.x, y: sp.y, z: sp.z };
    w.vel = { x: 0, y: 0, z: 0 };
    w.onGround = true;
    // wolf_night: qayta tug'ilgan bo'ri joriy (kuchliroq) to'lqin ko'rsatkichlarini oladi
    this.applyWaveStats(w);
    w.alive = true;
    w.state = 'idle';
    w.targetId = null;
    w.diedAt = 0;
    w.respawnAt = Infinity;
    w.brain.onSpawn(this.now());
  }

  /** O'lgan bo'ri shu rejimda qayta tug'iladimi (klassik va wolf_night — ha; forest_survival — jasad o'chadi). */
  private wolvesRespawn(): boolean {
    return !this.isSurvival || this.isNight;
  }

  /** Bo'rilar AI, jasadlar va qayta paydo bo'lish — har tick. */
  private updateWolves(dt: number, t: number): void {
    for (const [id, w] of this.wolves) {
      if (w.alive) {
        w.brain.update(dt, t);
        continue;
      }
      if (t - w.diedAt < WOLF_CORPSE_SEC) continue;
      if (!this.wolvesRespawn()) {
        this.wolves.delete(id);
      } else if (t >= w.respawnAt && this.phase === 'playing') {
        this.respawnWolf(w);
      }
    }
  }

  /**
   * Botlar uchun: `maxDist` ichidagi eng yaqin tirik bo'ri. Shu o'yinchini ovlayotgan yoki
   * stalk/hunt/attack holatidagi bo'ri (tahdid) masofadan qat'i nazar oddiy sayr qilayotganidan ustun.
   */
  nearestWolfThreat(p: ServerPlayer, maxDist: number): ServerWolf | null {
    let best: ServerWolf | null = null;
    let bestThreat = false;
    let bestD = Infinity;
    for (const w of this.wolves.values()) {
      if (!w.alive) continue;
      const d = Math.hypot(w.pos.x - p.pos.x, w.pos.z - p.pos.z);
      if (d > maxDist) continue;
      const threat = w.targetId === p.id || isWolfThreatState(w.state);
      if (threat !== bestThreat ? threat : d < bestD) {
        best = w;
        bestThreat = threat;
        bestD = d;
      }
    }
    return best;
  }

  /** wolf_night: tun/to'lqin holati (faqat 'playing' fazasida), aks holda null. */
  getNightSnap(t: number = this.now()): NightSnap | null {
    if (!this.isNight || !this.survival) return null;
    const durationSec = this.survival.getConfig().roundDurationSec;
    if (this.phase !== 'playing' || this.nightWaveIdx < 0) {
      // Kutish/sanoq/yakun: o'yinchilar gulxan atrofida turadi — gulxan va g'aramlar ko'rinsin (to'lqin hali yo'q)
      if (this.phase === 'ended') return null;
      return {
        wave: 0,
        waveCount: NIGHT_WAVE_COUNT,
        wolvesAlive: 0,
        nextWaveInSec: 0,
        dawnInSec: Math.ceil(durationSec),
        fires: this.campfireSnaps(),
        piles: this.woodPileSnaps(t),
      };
    }
    const ev = evaluateNightWave(t - this.roundStartedAt, durationSec);
    let wolvesAlive = 0;
    for (const w of this.wolves.values()) if (w.alive) wolvesAlive++;
    return {
      wave: ev.wave.wave,
      waveCount: NIGHT_WAVE_COUNT,
      wolvesAlive,
      nextWaveInSec: Math.ceil(ev.nextWaveInSec),
      dawnInSec: Math.ceil(ev.dawnInSec),
      fires: this.campfireSnaps(),
      piles: this.woodPileSnaps(t),
    };
  }

  /**
   * wolf_night: har tick to'lqinni jadvaldan hisoblaydi; to'lqin o'zgarganda bo'rilar soni oshiriladi
   * (yangilari joriy to'lqin ko'paytuvchilari bilan; tirik eskilar o'zinikini saqlaydi).
   */
  private updateNightWaves(t: number): void {
    if (!this.isNight || !this.survival || this.phase !== 'playing') return;
    const ev = evaluateNightWave(t - this.roundStartedAt, this.survival.getConfig().roundDurationSec);
    const idx = ev.wave.wave - 1;
    if (idx === this.nightWaveIdx) return;
    this.nightWaveIdx = idx;
    this.wolfCount = clamp(ev.wave.wolves, 0, WOLF_MAX_PER_ROOM);
    this.syncWolvesToCount();
    if (idx > 0) this.systemChat(`🌙 ${ev.wave.wave}-to'lqin: bo'rilar ko'paydi va kuchaydi!`);
  }

  /** Bo'ri uvladi — klientlarga pozitsion ovoz uchun. */
  wolfHowl(w: ServerWolf): void {
    const ev: WolfHowlEvent = { id: w.id, x: q3(w.pos.x), y: q3(w.pos.y), z: q3(w.pos.z) };
    this.io.to(this.channel).emit('wolf:howl', ev);
  }

  /** Bo'ri tishladi (WolfBrain hujum klipining 0.30 s lahzasida chaqiradi). */
  wolfBite(w: ServerWolf, target: ServerPlayer | null): void {
    let hit = false;
    if (target && this.isWolfPrey(target) && this.phase === 'playing') {
      const dH = Math.hypot(target.pos.x - w.pos.x, target.pos.z - w.pos.z);
      const dy = Math.abs(target.pos.y - w.pos.y);
      if (dH <= WOLF_BITE_CONNECT_RANGE && dy < 1.4) {
        hit = true;
        const from = { x: w.pos.x, y: w.pos.y + 0.9, z: w.pos.z };
        // To'lqin ko'paytuvchisi (wolf_night); boshqa rejimlarda biteMul = 1
        this.damage(target, w, Math.max(1, Math.round(WOLF_BITE_DAMAGE * (w.biteMul || 1))), 'wolf', false, from);
      }
    }
    const ev: WolfBiteEvent = {
      id: w.id,
      target: target?.id ?? '',
      hit,
      x: q3(w.pos.x),
      y: q3(w.pos.y),
      z: q3(w.pos.z),
    };
    this.io.to(this.channel).emit('wolf:bite', ev);
  }

  /** O'q/granata bo'riga tegdi. */
  private damageWolf(w: ServerWolf, attacker: ServerPlayer, amount: number, from: Vec3): void {
    if (!w.alive || amount <= 0 || this.phase !== 'playing') return;
    w.hp -= amount;
    const dx = w.pos.x - from.x;
    const dz = w.pos.z - from.z;
    const dl = Math.hypot(dx, dz) || 1;
    const knock = clamp(amount / 40, 0.3, 3);
    w.vel.x += (dx / dl) * knock;
    w.vel.z += (dz / dl) * knock;
    const hc: HitConfirm = { target: w.id, damage: amount, headshot: false, kill: w.hp <= 0 };
    attacker.socket?.emit('hitConfirm', hc);
    w.brain.onDamaged(attacker, this.now());
    if (w.hp <= 0) this.killWolf(w, attacker);
  }

  private killWolf(w: ServerWolf, killer: ServerPlayer): void {
    w.alive = false;
    w.hp = 0;
    w.state = 'dead';
    w.targetId = null;
    w.diedAt = this.now();
    // Klassik va wolf_night (tun shafqatsiz): qayta tug'iladi; forest_survival: jasad o'chadi
    w.respawnAt = this.wolvesRespawn() ? w.diedAt + (this.isNight ? WOLF_NIGHT_RESPAWN_SEC : WOLF_RESPAWN_SEC) : Infinity;
    const ev: WolfDeathEvent = { id: w.id, killerId: killer.id, killerName: killer.name };
    this.io.to(this.channel).emit('wolf:death', ev);
    this.systemChat(`${killer.name} vahshiy bo'rini o'ldirdi!`);
  }

  /** Bo'ri xitboksi: gavda atrofidagi AABB (uzunligi 2 m bo'lgani uchun kengroq). */
  private rayVsWolf(origin: Vec3, dir: Vec3, w: ServerWolf, maxT: number): number | null {
    const r = WOLF_RADIUS + 0.25;
    const h = rayBox(
      origin,
      dir,
      { x: w.pos.x - r, y: w.pos.y, z: w.pos.z - r },
      { x: w.pos.x + r, y: w.pos.y + WOLF_HEIGHT, z: w.pos.z + r },
      maxT,
    );
    return h ? h.t : null;
  }

  isFull(): boolean {
    return this.humanCount() >= this.opts.maxPlayers;
  }

  isEnemy(a: ServerPlayer, b: ServerPlayer): boolean {
    if (a === b) return false;
    // Tong otguncha — hamkorlik: o'yinchilar bir-biriga zarar bermaydi (o'q, pichoq, granata, bot nishoni)
    if (this.isNight) return false;
    return this.opts.mode === 'ffa' || this.isSurvival || a.team !== b.team;
  }

  // ---------------- O'yinchilar ----------------

  private createPlayer(id: string, name: string, isBot: boolean, socket: Socket | null): ServerPlayer {
    const startUnarmed = this.lootEnabled;
    return {
      id, name, isBot, socket,
      team: this.pickTeam(),
      ready: isBot,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
      crouched: false,
      yaw: 0, pitch: 0,
      scoped: false,
      stamina: 1, staminaLocked: false,
      armor: 0, helmet: 0,
      hp: MAX_HP, alive: false,
      respawnAt: isBot ? 0 : Infinity,
      spawnId: 0, spawnTime: 0,
      weapon: startUnarmed ? null : 'rifle',
      ammo: startUnarmed ? emptyAmmo() : fullAmmo(),
      reloadUntil: 0, reloadWeapon: null, lastShot: 0,
      pendingReloadWeapon: null, pendingReloadUntil: 0,
      fireCredit: 2, fireCreditAt: 0, lastTeamSwitch: -99,
      switchUntil: 0,
      grenades: startUnarmed ? 0 : GRENADES_PER_LIFE,
      lastGrenade: 0,
      kills: 0, deaths: 0, ping: 0,
      wood: 0,
      lastCampAction: -99,
      lootTokens: LOOT_REQ_BURST,
      lootTokensAt: 0,
      brain: null,
      authority: new PlayerMovementAuthority(),
    };
  }

  private pickTeam(): Team {
    if (this.opts.mode === 'ffa' || this.isSurvival) return 'none';
    let red = 0;
    let blue = 0;
    for (const p of this.players.values()) {
      if (p.team === 'red') red++;
      else if (p.team === 'blue') blue++;
    }
    if (red === blue) return Math.random() < 0.5 ? 'red' : 'blue';
    return red < blue ? 'red' : 'blue';
  }

  addBot(): ServerPlayer {
    const taken = new Set([...this.players.values()].map((p) => p.name));
    const id = 'bot-' + this.id + '-' + ++this.botSeq;
    const p = this.createPlayer(id, pickBotName(taken), true, null);
    p.brain = new BotBrain(this, p);
    this.players.set(id, p);
    this.rosterDirty = true;
    return p;
  }

  removeBot(): boolean {
    let bots = [...this.players.values()].filter((p) => p.isBot);
    // Survival raundi davomida tirik ishtirokchi botni olib tashlash raundni "raqib chiqib ketdi" bilan
    // yakunlab yuborardi (bepul g'alaba) — raund paytida faqat halok bo'lgan / kuzatuvchi botlar olinadi
    const survival = this.survival;
    if (survival && survival.getPhase() === 'playing') bots = bots.filter((b) => !survival.isAliveContender(b.id));
    if (!bots.length) return false;
    // eng ko'p o'yinchisi bor jamoadan olib tashlash
    let victim = bots[bots.length - 1];
    if (this.opts.mode === 'tdm') {
      const red = [...this.players.values()].filter((p) => p.team === 'red').length;
      const blue = this.players.size - red;
      const big: Team = red >= blue ? 'red' : 'blue';
      victim = bots.find((b) => b.team === big) ?? victim;
    }
    this.players.delete(victim.id);
    this.loot.removePlayer(victim.id);
    // Olib tashlangan botning uchayotgan granatasi ham zarar beradi (removePlayer bilan bir xil)
    this.keepDepartedForGrenades(victim);
    this.survival?.onPlayerRemoved(victim.id, this.now());
    this.rosterDirty = true;
    if (this.isSurvival) this.sendMatch();
    return true;
  }

  private balanceBots() {
    if (this.opts.mode !== 'tdm') return;
    for (let guard = 0; guard < 20; guard++) {
      const list = [...this.players.values()];
      const red = list.filter((p) => p.team === 'red');
      const blue = list.filter((p) => p.team === 'blue');
      if (Math.abs(red.length - blue.length) <= 1) return;
      const big = red.length > blue.length ? red : blue;
      const bot = big.find((p) => p.isBot);
      if (!bot) return;
      bot.team = big === red ? 'blue' : 'red';
      bot.alive = false;
      bot.respawnAt = this.now() + 1;
      this.rosterDirty = true;
    }
  }

  addHuman(socket: Socket, name: string): WelcomeMsg {
    const p = this.createPlayer(socket.id, name, false, socket);
    this.players.set(socket.id, p);
    socket.join(this.channel);
    this.balanceBots();
    this.rosterDirty = true;
    return { you: socket.id, room: this.info(), world: this.worldMeta() };
  }

  /** Klient sahnani tayyorlab bo'lgach chaqiriladi va dunyo mosligini tekshiradi. */
  onReady(id: string, msg?: ReadyMsg, ack?: (res: ReadyAck) => void): ReadyAck {
    const p = this.players.get(id);
    const serverWorld = this.worldMeta();
    if (!p) {
      const res: ReadyAck = { ok: false, error: "O'yinchi xonada topilmadi", serverWorld };
      ack?.(res);
      return res;
    }
    if (p.ready) {
      const res: ReadyAck = { ok: true, serverWorld };
      ack?.(res);
      return res;
    }
    const compat = validateWorldCompatibility(serverWorld, msg?.world);
    if (!compat.ok) {
      const error = compat.reason ?? "Xarita versiyasi server bilan mos kelmadi";
      p.socket?.emit('worldMismatch', { error, expected: serverWorld, received: msg?.world });
      const res: ReadyAck = { ok: false, error, serverWorld };
      ack?.(res);
      this.removePlayer(id);
      return res;
    }
    p.ready = true;
    for (const m of this.chatHistory) p.socket?.emit('chat', m);
    if (this.isSurvival && this.survival) {
      const readyRes = this.survival.onPlayerReady(p.id, this.now());
      this.phase = this.survival.getPhase();
      if (readyRes.spawnInPreRound) {
        this.spawn(p);
      } else {
        // Mid-match joiner in forest_survival: spectator until next round
        const sp = this.pickSpawn(p);
        p.pos = { x: sp.x, y: sp.y, z: sp.z };
        p.vel = { x: 0, y: 0, z: 0 };
        p.onGround = true;
        p.yaw = sp.yaw;
        p.pitch = 0;
        p.scoped = false;
        p.hp = 0;
        p.alive = false;
        p.respawnAt = Infinity;
        p.weapon = null;
        p.ammo = emptyAmmo();
        p.grenades = 0;
        resetServerWeaponSwitchState(p);
        p.authority.clear();
        const invSnap = this.loot.resetPlayerForSpawn(p.id, p.spawnId);
        this.loot.onPlayerDeath(p.id);
        this.loot.applyInventoryToServerPlayer(p.id, p);
        p.socket?.emit('inventory:state', invSnap);
        p.socket?.emit('loot:snapshot', this.loot.getPublicLootSnapshot());
      }
      this.sendRoster();
      this.sendMatch();
      this.systemChat(
        readyRes.joinAsSpectator
          ? `${p.name} kuzatuvchi sifatida qo'shildi (keyingi raundda qatnashadi)`
          : `${p.name} ${GAME_MODE_NAMES_UZ[this.opts.mode]} xonasiga qo'shildi`,
      );
      const res: ReadyAck = { ok: true, serverWorld };
      ack?.(res);
      return res;
    }

    this.spawn(p);
    this.sendRoster();
    this.sendMatch();
    this.systemChat(`${p.name} o'yinga qo'shildi` + (p.team !== 'none' ? ` (${TEAM_NAMES[p.team]} jamoa)` : ''));
    const res: ReadyAck = { ok: true, serverWorld };
    ack?.(res);
    return res;
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.loot.removePlayer(id);
    p.socket?.leave(this.channel);
    this.keepDepartedForGrenades(p);
    this.rosterDirty = true;
    if (this.humanCount() === 0) {
      this.destroy();
      return;
    }
    this.systemChat(`${p.name} o'yindan chiqdi`);
    if (this.isSurvival && this.survival) {
      this.survival.onPlayerRemoved(id, this.now());
      this.phase = this.survival.getPhase();
      this.sendRoster();
      this.sendMatch();
    } else {
      this.balanceBots();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.timer);
    this.onEmpty(this);
  }

  // ---------------- Spawn ----------------

  /** Spawn nuqtalari umuman yo'q bo'lsa — dunyo chegaralari markazi (terrain balandligida); bir marta ogohlantiradi. */
  private fallbackSpawnWarned = false;

  private fallbackSpawn(p: ServerPlayer): SpawnPointDef {
    const b = this.world.bounds;
    const x = (b.minX + b.maxX) / 2;
    const z = (b.minZ + b.maxZ) / 2;
    const y = sampleTerrainHeight(this.world.terrain, x, z);
    if (!this.fallbackSpawnWarned) {
      this.fallbackSpawnWarned = true;
      console.warn(`[room ${this.id}] "${this.world.mapId}" xaritasida spawn nuqtasi yo'q — chegaralar markazi ishlatiladi`);
    }
    return { id: 'fallback_center', x, y, z, yaw: 0, team: p.team };
  }

  /**
   * wolf_night: asosiy gulxan atrofidagi halqa (CAMP_SPAWN_RING_M) — o'yinchi indeksiga ko'ra yoyilgan,
   * relyefga o'tqazilgan, kollayderga tegsa burchak/radius siljitiladi. Gulxanga qaragan holda tug'iladi.
   */
  private pickCampSpawn(p: ServerPlayer): SpawnPointDef | null {
    const main = this.mainCampfire();
    if (!main) return null;
    const ids = [...this.players.keys()];
    const idx = Math.max(0, ids.indexOf(p.id));
    const n = Math.max(1, ids.length);
    const base = (idx / n) * Math.PI * 2 + (this.world.publicLayoutSeed % 7) * 0.3;
    const others = [...this.players.values()].filter((o) => o !== p && o.alive);
    for (let k = 0; k < 24; k++) {
      // 0, +½ qadam, −½ qadam, ... burchak siljishi; 8 ta urinishdan keyin radius oshadi
      const ang = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * ((Math.PI * 2) / n) * 0.5;
      const r = CAMP_SPAWN_RING_M + Math.floor(k / 8) * 0.9;
      const x = main.x + Math.cos(ang) * r;
      const z = main.z + Math.sin(ang) * r;
      const y = sampleTerrainHeight(this.world.terrain, x, z);
      if (collidesAtWorld(this.world, x, y + 0.05, z)) continue;
      if (others.some((o) => Math.hypot(o.pos.x - x, o.pos.z - z) < 0.9)) continue;
      const yaw = Math.atan2(-(main.x - x), -(main.z - z));
      return { id: `camp:${idx}`, x: q3(x), y: q3(y), z: q3(z), yaw, team: p.team };
    }
    return { id: 'camp:center', x: main.x, y: main.y, z: main.z, yaw: 0, team: p.team };
  }

  private pickSpawn(p: ServerPlayer): SpawnPointDef {
    if (this.isNight) {
      const camp = this.pickCampSpawn(p);
      if (camp) return camp;
    }
    const all = this.world.spawnPoints;
    let cands = this.opts.mode === 'tdm' ? all.filter((s) => s.team === p.team) : all;
    // Jamoa spawnlari bo'lmasa — barcha spawnlar; ular ham bo'lmasa — xavfsiz markaz
    if (cands.length === 0) cands = all;
    if (cands.length === 0) return this.fallbackSpawn(p);
    const others = [...this.players.values()].filter((o) => o !== p && o.alive);
    const wolves = [...this.wolves.values()].filter((w) => w.alive);
    const scored = cands.map((s) => {
      let minEnemy = 999;
      let occupied = false;
      for (const o of others) {
        const d = Math.hypot(o.pos.x - s.x, o.pos.z - s.z);
        if (d < 1.5) occupied = true;
        if (this.isEnemy(p, o)) minEnemy = Math.min(minEnemy, d);
      }
      // Tirik bo'ri yonida tug'ilmaslik: yaqinlik darajasiga qarab jarima (28 m ichida kuchli)
      let wolfPenalty = 0;
      for (const w of wolves) {
        const d = Math.hypot(w.pos.x - s.x, w.pos.z - s.z);
        if (d < WOLF_SPAWN_CLEARANCE) wolfPenalty = Math.max(wolfPenalty, (WOLF_SPAWN_CLEARANCE - d) * 8);
      }
      const score = (occupied ? -1000 : 0) + Math.min(minEnemy, 60) - wolfPenalty + Math.random() * 10;
      return { s, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].s;
  }

  spawn(p: ServerPlayer): void {
    const sp = this.pickSpawn(p);
    p.pos = { x: sp.x, y: sp.y, z: sp.z };
    p.vel = { x: 0, y: 0, z: 0 };
    p.onGround = true;
    // Yangi hayot har doim tik turgan holatda boshlanadi
    p.crouched = false;
    // wolf_night: gulxanga qarab tug'iladi; FFA/survival — tasodifiy; TDM — spawn yo'nalishi
    p.yaw = this.isNight ? sp.yaw : this.opts.mode === 'ffa' || this.isSurvival ? Math.random() * Math.PI * 2 : sp.yaw;
    p.pitch = 0;
    p.scoped = false;
    p.stamina = 1;
    p.staminaLocked = false;
    p.armor = 0;
    p.helmet = 0;
    p.hp = MAX_HP;
    p.alive = true;
    p.wood = 0;
    p.respawnAt = Infinity;
    p.spawnId++;
    p.authority.resetForSpawn(p.spawnId);
    p.spawnTime = this.now();
    resetServerWeaponSwitchState(p);
    // O'lim paytida boshlangan reload yangi hayotga o'tmasin (aks holda shu qurol bilan otib bo'lmaydi)
    p.reloadWeapon = null;
    p.reloadUntil = 0;
    p.pendingReloadWeapon = null;
    p.fireCredit = 2;
    p.fireCreditAt = p.spawnTime;
    if (p.isBot) {
      if (this.lootEnabled) {
        // Loot rejimida bot ham qurolsiz boshlaydi va konteynerlardan yig'adi
        this.loot.resetPlayerForSpawn(p.id, p.spawnId);
        this.loot.applyInventoryToServerPlayer(p.id, p);
      } else {
        p.weapon = 'rifle';
        p.ammo = fullAmmo();
        p.grenades = GRENADES_PER_LIFE;
      }
      if (p.brain) p.brain.onSpawn();
    } else {
      const invSnap = this.loot.resetPlayerForSpawn(p.id, p.spawnId);
      this.loot.applyInventoryToServerPlayer(p.id, p);
      const ev: SpawnEvent = {
        spawnId: p.spawnId,
        roundId: this.roundId,
        x: p.pos.x,
        y: p.pos.y,
        z: p.pos.z,
        yaw: p.yaw,
        team: p.team,
        weapon: p.weapon,
        lootPreview: this.lootPreview,
        lootEnabled: this.lootEnabled,
      };
      p.socket?.emit('spawn', ev);
      p.socket?.emit('inventory:state', invSnap);
      p.socket?.emit('loot:snapshot', this.loot.getPublicLootSnapshot());
    }
  }

  // ---------------- Klient xabarlari ----------------

  onInput(id: string, rawMsg: PlayerInputCmd | PlayerInputBatchMsg | unknown): void {
    const p = this.players.get(id);
    if (!p || p.isBot || !p.alive || !p.ready) return;
    if (this.isSurvival && this.survival && !this.survival.canPlayerMove(id)) return;
    const res = p.authority.enqueueInputPacket(rawMsg, p.weapon);
    if (res.ping !== undefined && Number.isFinite(res.ping)) {
      p.ping = res.ping;
    }
  }

  onState(id: string, s: ClientState): void {
    const p = this.players.get(id);
    if (!p || p.isBot) return;
    p.authority.recordRejectedLegacyState();
    if (s && Number.isFinite(s.ping)) {
      p.ping = clamp(Math.round(s.ping), 0, 9999);
    }
  }

  getPlayerAuthorityStats(id: string): MovementAuthorityStats | null {
    const p = this.players.get(id);
    return p ? { ...p.authority.stats } : null;
  }

  getCombatSecurityStats(): {
    rejectedWeaponShots: number;
    rejectedUnequippedWeaponShots: number;
    rejectedSwitchCooldownShots: number;
    rejectedFakeOriginShots: number;
    rejectedAimDirectionShots: number;
    lootStats: LootAuthorityStats;
  } {
    return {
      rejectedWeaponShots: this.rejectedWeaponShots,
      rejectedUnequippedWeaponShots: this.rejectedUnequippedWeaponShots,
      rejectedSwitchCooldownShots: this.rejectedSwitchCooldownShots,
      rejectedFakeOriginShots: this.rejectedFakeOriginShots,
      rejectedAimDirectionShots: this.rejectedAimDirectionShots,
      lootStats: this.loot.getStats(),
    };
  }

  onShoot(id: string, m: ShootMsg): void {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase !== 'playing' || !m || !isWeaponId(m.weapon) || !Array.isArray(m.dirs)) return;
    if (this.isSurvival && this.survival && !this.survival.canPlayerCombat(id)) return;

    // 1. Server-authoritative weapon ownership, active equip, and switch-time check (Stage 05/06/07-QA)
    // NEVER mutate p.weapon inside onShoot!
    const weaponCheck = validateAuthoritativeShotWeapon(
      p,
      m.weapon,
      this.now(),
      (w) => (p.isBot ? true : this.loot.canPlayerUseWeapon(p.id, w)),
    );
    if (!weaponCheck.ok) {
      this.rejectedWeaponShots++;
      if (weaponCheck.reason === 'WEAPON_NOT_EQUIPPED') {
        this.rejectedUnequippedWeaponShots++;
      } else if (weaponCheck.reason === 'SWITCH_COOLDOWN_ACTIVE') {
        this.rejectedSwitchCooldownShots++;
      }
      return;
    }

    const def = WEAPONS[p.weapon!];
    // Avtoritativ ko'z balandligi o'tirish holatiga bog'liq (CROUCH_EYE_HEIGHT / EYE_HEIGHT)
    const eye = { x: p.pos.x, y: p.pos.y + eyeHeightOf(p), z: p.pos.z };

    // 2. Virtual bullet origin fix (Stage 05 Audit):
    // NEVER accept client-supplied m.origin for raycasting. Always use server's authoritative eye position.
    if (m.origin && isVec3(m.origin)) {
      const originDist = vdist(m.origin, eye);
      if (originDist > 0.25) {
        this.rejectedFakeOriginShots++;
      }
    }

    // 3. Bullet direction validation against authoritative yaw/pitch + weapon spread cone
    const lastQueued = p.authority.queue[p.authority.queue.length - 1];
    let dirCheck = validateBulletDirectionsAgainstAim(m.dirs, def, p.yaw, p.pitch);
    if (!dirCheck.ok && lastQueued) {
      dirCheck = validateBulletDirectionsAgainstAim(m.dirs, def, lastQueued.yaw, lastQueued.pitch);
    }
    if (!dirCheck.ok) {
      this.rejectedAimDirectionShots++;
      return;
    }

    const fired = this.fire(p, def, eye, dirCheck.sanitizedDirs, 0.75);
    if (fired && !p.isBot) {
      this.loot.syncPlayerFromServerPlayer(p.id, p);
    }
  }

  /** Bot o'q uzishi. Muvaffaqiyatli bo'lsa true. */
  botFire(p: ServerPlayer, extraSpread: number): boolean {
    if (!p.weapon) return false;
    const def = WEAPONS[p.weapon];
    const eye = { x: p.pos.x, y: p.pos.y + eyeHeightOf(p), z: p.pos.z };
    const aim = { x: -Math.sin(p.yaw) * Math.cos(p.pitch), y: Math.sin(p.pitch), z: -Math.cos(p.yaw) * Math.cos(p.pitch) };
    const moving = Math.hypot(p.vel.x, p.vel.z) > 1 ? def.moveSpread * 0.5 : 0;
    const base = (def.id === 'sniper' ? 0.002 : def.spread) + moving + extraSpread;
    const dirs: Vec3[] = [];
    for (let i = 0; i < def.pellets; i++) dirs.push(spreadDir(aim, def.pellets > 1 ? def.spread : base));
    if (def.pellets > 1 && extraSpread > 0) for (let i = 0; i < dirs.length; i++) dirs[i] = spreadDir(dirs[i], extraSpread * 0.5);
    const fired = this.fire(p, def, eye, dirs, 1);
    // Loot inventari ham joriy o'q sonini bilsin (bot o'lganda tushadigan qurol, botning loot ehtiyoji)
    if (fired && this.lootEnabled) this.loot.syncPlayerFromServerPlayer(p.id, p);
    return fired;
  }

  /** Pichoq zarbasi yelpig'ichi: avtoritativ yaw/pitch dan markaz, ±7° yon va 5° pastroq yo'nalishlar. */
  private meleeFan(p: ServerPlayer): Vec3[] {
    const out: Vec3[] = [];
    for (const [dy, dp] of [
      [0, 0],
      [0.12, 0],
      [-0.12, 0],
      [0, -0.09],
    ] as const) {
      const yaw = p.yaw + dy;
      const pitch = p.pitch + dp;
      const cp = Math.cos(pitch);
      out.push({ x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp });
    }
    return out;
  }

  private fire(p: ServerPlayer, def: WeaponDef, origin: Vec3, dirs: Vec3[], intervalTolerance: number): boolean {
    if (this.phase !== 'playing') return false;
    const t = this.now();
    if (p.reloadWeapon === def.id) return false;
    // Token bucket: otish huquqi 1/fireInterval tezlikda to'planadi, sig'imi 2.0 (insonlar) / 1.0 (botlar).
    // Shunday qilib o'rtacha tezlik hech qachon fireInterval dan oshmaydi (eski 0.75 tolerantlik 33%
    // tezroq otishga yo'l qo'yardi), tarmoq jitteri uchun esa bir otishlik zaxira bor.
    const cap = 1 + (1 - intervalTolerance) * 4;
    // Ikki intervaldan uzoq pauzadan keyin zaxira to'liq (pauza ustunlik bermaydi, testlar lastShot ni tiklaydi)
    if (t - p.lastShot > def.fireInterval * 2) {
      p.fireCredit = cap;
    } else {
      p.fireCredit = Math.min(cap, p.fireCredit + Math.max(0, t - p.fireCreditAt) / def.fireInterval);
    }
    p.fireCreditAt = t;
    if (p.fireCredit < 1 - 1e-6) return false;
    const melee = isMeleeWeapon(def.id);
    if (!melee) {
      const ammo = p.ammo[def.id];
      if (ammo.mag <= 0) return false;
      ammo.mag--;
    }
    p.fireCredit -= 1;
    p.lastShot = t;
    p.spawnTime = -99; // o'q uzgan zahoti spawn himoyasi tugaydi

    // Pichoq: nishon olish yo'nalishi atrofida yelpig'ich (markaz, ±7° yon, −5° past) — yaqin masofada tegizish oson;
    // faqat bitta (eng yaqin) nishonga bir marta zarar beriladi
    const castDirs = melee ? this.meleeFan(p) : dirs;
    const ends: Vec3[] = [];
    const dmg = new Map<ServerPlayer, { dmg: number; head: boolean }>();
    const wolfDmg = new Map<ServerWolf, number>();
    for (const d of castDirs) {
      const wall = raycastWorld(this.world, origin, d, def.range);
      let maxT = wall ? wall.t : def.range;
      let hitP: ServerPlayer | null = null;
      let hitW: ServerWolf | null = null;
      let zone: HitZone = 'torso';
      for (const o of this.players.values()) {
        if (!o.alive || !this.isEnemy(p, o)) continue;
        // O'tirgan qurbonning xitbokslari pastroq
        const h = rayVsPlayer(origin, d, o.pos, maxT, o.crouched === true);
        if (h) {
          maxT = h.t;
          hitP = o;
          zone = h.zone;
        }
      }
      for (const w of this.wolves.values()) {
        if (!w.alive) continue;
        const tw = this.rayVsWolf(origin, d, w, maxT);
        if (tw !== null) {
          maxT = tw;
          hitP = null;
          hitW = w;
        }
      }
      if (!melee || hitP || hitW || ends.length === 0) {
        ends.push({ x: q3(origin.x + d.x * maxT), y: q3(origin.y + d.y * maxT), z: q3(origin.z + d.z * maxT) });
      }
      if (hitW) {
        // Bo'rida bosh/oyoq zonasi yo'q — tana zarari; pichoq bir marta tegadi
        const amount = damageAt(def, maxT, 'torso');
        if (melee) {
          ends.length = 0;
          ends.push({ x: q3(origin.x + d.x * maxT), y: q3(origin.y + d.y * maxT), z: q3(origin.z + d.z * maxT) });
          wolfDmg.set(hitW, amount);
          break;
        }
        wolfDmg.set(hitW, (wolfDmg.get(hitW) ?? 0) + amount);
        continue;
      }
      if (hitP) {
        // Zarar tegish zonasiga qarab: bosh ×headMult, tana ×1, oyoq ×0.7
        let amount = damageAt(def, maxT, zone);
        if (melee) {
          // Orqadan zarba: qurbonning old yo'nalishi hujumchidan teskari tomonga qaragan bo'lsa
          const fx = -Math.sin(hitP.yaw);
          const fz = -Math.cos(hitP.yaw);
          const ax = p.pos.x - hitP.pos.x;
          const az = p.pos.z - hitP.pos.z;
          const al = Math.hypot(ax, az) || 1;
          if ((fx * ax + fz * az) / al < KNIFE_BACKSTAB_DOT) amount *= KNIFE_BACKSTAB_MUL;
          // Yelpig'ichdagi birinchi tegish — bitta zarba
          ends.length = 0;
          ends.push({ x: q3(origin.x + d.x * maxT), y: q3(origin.y + d.y * maxT), z: q3(origin.z + d.z * maxT) });
          dmg.set(hitP, { dmg: amount, head: zone === 'head' });
          break;
        }
        const cur = dmg.get(hitP) ?? { dmg: 0, head: false };
        cur.dmg += amount;
        cur.head = cur.head || zone === 'head';
        dmg.set(hitP, cur);
      }
    }
    const ev: ShotEvent = { shooter: p.id, weapon: def.id, origin, ends };
    if (p.socket) p.socket.to(this.channel).emit('shot', ev);
    else this.io.to(this.channel).emit('shot', ev);
    if (dmg.size > 0) {
      const prevDefer = this.deferWinCheck;
      this.deferWinCheck = true;
      try {
        for (const [target, info] of dmg) this.damage(target, p, Math.round(info.dmg), def.id, info.head, origin);
      } finally {
        this.deferWinCheck = prevDefer;
      }
      if (!this.deferWinCheck) this.checkWin();
    }
    for (const [w, amount] of wolfDmg) this.damageWolf(w, p, Math.round(amount), origin);
    // O'q ovozi bo'rilarni tortadi (pichoq jim)
    if (!melee) for (const w of this.wolves.values()) if (w.alive) w.brain.onNoise(origin, t, p);
    return true;
  }

  onReload(id: string, data?: { weapon?: unknown } | unknown): void {
    const p = this.players.get(id);
    if (!p) return;
    const reqWeapon = (data as { weapon?: unknown } | undefined)?.weapon;
    if (isWeaponId(reqWeapon) && reqWeapon !== p.weapon) {
      // Klient qurolni almashtirib darhol R bosgan: almashtirish kirishi hali navbatda (keyingi tickda ishlanadi).
      // Eski qurolni o'qlab qo'ymaslik uchun reload'ni almashtirish ishlangandan keyinga kechiktiramiz.
      const queue = p.authority.queue;
      const switchQueued = queue.some((c) => c.weapon === reqWeapon);
      if (switchQueued) {
        p.pendingReloadWeapon = reqWeapon;
        p.pendingReloadUntil = this.now() + 0.5;
      }
      return;
    }
    this.startReload(p);
  }

  /** Inson o'yinchining navbatdagi kirishlarini avtoritativ tarzda ishlaydi (qurol almashtirish + kechiktirilgan reload bilan). */
  private stepHumanAuthority(p: ServerPlayer, dt: number, rawDt: number, t: number): void {
    const prevW = p.weapon;
    p.authority.stepAuthoritativeTick(p, dt, this.world, (w) => this.loot.canPlayerUseWeapon(p.id, w), rawDt);
    if (p.weapon !== prevW) {
      const nextW = p.weapon;
      p.weapon = prevW;
      applyAuthoritativeWeaponSwitch(p, nextW, t, { fromAutoPickup: false });
      this.loot.syncPlayerFromServerPlayer(p.id, p);
    }
    if (p.pendingReloadWeapon) {
      if (p.weapon === p.pendingReloadWeapon) {
        p.pendingReloadWeapon = null;
        this.startReload(p);
      } else if (t >= p.pendingReloadUntil) {
        p.pendingReloadWeapon = null;
      }
    }
  }

  startReload(p: ServerPlayer): void {
    if (!p.alive || this.phase !== 'playing' || p.reloadWeapon || !p.weapon) return;
    if (this.isSurvival && this.survival && !this.survival.canPlayerCombat(p.id)) return;
    if (!p.isBot && !this.loot.canPlayerUseWeapon(p.id, p.weapon)) return;
    const def = WEAPONS[p.weapon];
    const a = p.ammo[p.weapon];
    if (a.mag >= def.magSize || a.reserve <= 0) return;
    p.reloadWeapon = p.weapon;
    p.reloadUntil = this.now() + def.reloadTime;
  }

  private finishReload(p: ServerPlayer): void {
    const w = p.reloadWeapon;
    if (!w) return;
    p.reloadWeapon = null;
    if (!p.isBot && !this.loot.canPlayerUseWeapon(p.id, w)) return;
    const a = p.ammo[w];
    const take = Math.min(WEAPONS[w].magSize - a.mag, a.reserve);
    a.mag += take;
    a.reserve -= take;
    p.socket?.emit('ammo', { weapon: w, mag: a.mag, reserve: a.reserve });
    // Botlar ham sinxronlanadi (inventardagi o'q eskirib qolmasin); inventar holati faqat odamga yuboriladi
    if (!p.isBot || this.lootEnabled) this.loot.syncPlayerFromServerPlayer(p.id, p);
    if (!p.isBot) {
      const invSnap = this.loot.getPlayerInventorySnap(p.id);
      if (invSnap) p.socket?.emit('inventory:state', invSnap);
    }
  }

  onGrenade(id: string, data: { dir: Vec3 }): void {
    const p = this.players.get(id);
    if (!p || !data || !isVec3(data.dir)) return;
    this.throwGrenade(p, vnorm(data.dir));
  }

  throwGrenade(p: ServerPlayer, dir: Vec3): void {
    const t = this.now();
    if (!p.alive || p.grenades <= 0 || t - p.lastGrenade < 0.8 || this.phase !== 'playing') return;
    if (this.isSurvival && this.survival && !this.survival.canPlayerCombat(p.id)) return;
    p.grenades--;
    p.lastGrenade = t;
    // Botlar ham sinxronlanadi — aks holda loot AI eski granata sonini ko'radi
    if (!p.isBot || this.lootEnabled) this.loot.syncPlayerFromServerPlayer(p.id, p);
    if (!p.isBot) {
      const invSnap = this.loot.getPlayerInventorySnap(p.id);
      if (invSnap) p.socket?.emit('inventory:state', invSnap);
    }
    const eye = { x: p.pos.x, y: p.pos.y + eyeHeightOf(p) - 0.1, z: p.pos.z };
    let pos = { x: eye.x + dir.x * 0.6, y: eye.y + dir.y * 0.6, z: eye.z + dir.z * 0.6 };
    if (pointInsideBoxes(this.world.colliders, pos)) pos = eye;
    this.grenades.push({
      id: ++this.grenadeSeq,
      owner: p.id,
      pos,
      vel: {
        x: dir.x * GRENADE_THROW_SPEED + p.vel.x * 0.5,
        y: dir.y * GRENADE_THROW_SPEED + 2 + Math.max(0, p.vel.y) * 0.5,
        z: dir.z * GRENADE_THROW_SPEED + p.vel.z * 0.5,
      },
      explodeAt: t + GRENADE_FUSE,
    });
  }

  // ---------------- Stage 06 & 07: Loot & Inventar ----------------

  /**
   * Loot so'rovlari uchun umumiy darvoza: o'yinchi topilmasa/bot/tayyor emas — PLAYER_NOT_FOUND,
   * so'rovlar juda tez kelsa — RATE_LIMITED, survivalda raund faol bo'lmasa (tirik o'yinchi uchun) — ROUND_NOT_ACTIVE.
   * Aks holda o'yinchini qaytaradi.
   */
  private lootRequestGate(
    id: string,
    rawReq: unknown,
  ): { p: ServerPlayer; code?: undefined } | { p: ServerPlayer | null; code: LootGateRejectCode; requestId: string } {
    const p = this.players.get(id);
    if (!p || p.isBot || !p.ready) {
      return { p: null, code: 'PLAYER_NOT_FOUND', requestId: readStringField(rawReq, 'requestId') };
    }
    const t = this.now();
    p.lootTokens = Math.min(LOOT_REQ_BURST, p.lootTokens + Math.max(0, t - p.lootTokensAt) * LOOT_REQ_PER_SEC);
    p.lootTokensAt = t;
    if (p.lootTokens < 1) {
      return { p, code: 'RATE_LIMITED', requestId: readStringField(rawReq, 'requestId') };
    }
    p.lootTokens -= 1;
    if (this.isSurvival && this.phase !== 'playing' && p.alive) {
      return { p, code: 'ROUND_NOT_ACTIVE', requestId: readStringField(rawReq, 'requestId') };
    }
    return { p };
  }

  /**
   * Buyum olish natijasini e'lon qiladi: konteynerdan olinsa — faqat shu konteyner (`container:state`),
   * yerdan olinsa (`res.container` yo'q) — groundItems o'zgargani uchun to'liq `loot:snapshot`.
   */
  private broadcastPickupResult(res: LootPickupAck): void {
    if (res.container) {
      this.io.to(this.channel).emit('container:state', res.container);
    } else {
      this.io.to(this.channel).emit('loot:snapshot', this.loot.getPublicLootSnapshot());
    }
  }

  onContainerOpen(id: string, rawReq: ContainerOpenReq | unknown, ack?: (res: ContainerOpenAck) => void): ContainerOpenAck {
    const gate = this.lootRequestGate(id, rawReq);
    if (gate.code) {
      const res: ContainerOpenAck = {
        ok: false,
        requestId: gate.requestId,
        containerId: readStringField(rawReq, 'containerId'),
        code: gate.code,
        message: LOOT_ERROR_MESSAGES_UZ[gate.code],
      };
      ack?.(res);
      return res;
    }
    const p = gate.p;
    this.loot.syncPlayerFromServerPlayer(p.id, p);
    const res = this.loot.openContainer(p, rawReq);
    if (res.ok && !res.idempotentReplay && res.container) {
      // Ochish faqat shu konteynerni o'zgartiradi — to'liq loot:snapshot shart emas
      this.io.to(this.channel).emit('container:state', res.container);
    }
    ack?.(res);
    return res;
  }

  onLootPickup(id: string, rawReq: LootPickupReq | unknown, ack?: (res: LootPickupAck) => void): LootPickupAck {
    const gate = this.lootRequestGate(id, rawReq);
    if (gate.code) {
      const res: LootPickupAck = {
        ok: false,
        requestId: gate.requestId,
        itemId: readStringField(rawReq, 'itemId'),
        code: gate.code,
        message: LOOT_ERROR_MESSAGES_UZ[gate.code],
      };
      ack?.(res);
      return res;
    }
    const p = gate.p;
    this.loot.syncPlayerFromServerPlayer(p.id, p);
    const prevWeapon = p.weapon;
    const res = this.loot.pickupItem(p, rawReq);
    if (res.ok && !res.idempotentReplay) {
      this.loot.applyInventoryToServerPlayer(p.id, p);
      if (prevWeapon === null && p.weapon !== null) {
        // applyInventoryToServerPlayer p.weapon ni allaqachon o'rnatgan; haqiqiy almashtirish bo'lishi uchun
        // avvalgi qurolni qaytarib, so'ng auto-pickup (cooldown'siz) almashtirishni qo'llaymiz.
        const pickedWeapon = p.weapon;
        p.weapon = prevWeapon;
        applyAuthoritativeWeaponSwitch(p, pickedWeapon, this.now(), { fromAutoPickup: true });
        // Klient ack olguncha yuborgan `weapon: null` kirishlari serverni qurolsiz holatga qaytarmasin
        p.authority.guardWeaponRevert(prevWeapon);
      }
      if (res.inventory) {
        p.socket?.emit('inventory:state', res.inventory);
      }
      if (p.weapon) {
        p.socket?.emit('ammo', { weapon: p.weapon, mag: p.ammo[p.weapon].mag, reserve: p.ammo[p.weapon].reserve });
      }
      this.broadcastPickupResult(res);
    }
    ack?.(res);
    return res;
  }

  onEquipWeapon(id: string, rawReq: EquipWeaponReq | unknown, ack?: (res: EquipWeaponAck) => void): EquipWeaponAck {
    const gate = this.lootRequestGate(id, rawReq);
    if (gate.code) {
      const res: EquipWeaponAck = {
        ok: false,
        requestId: gate.requestId,
        // PLAYER_NOT_FOUND: o'yinchi yo'q — null; ROUND_NOT_ACTIVE: joriy qurol
        equippedWeapon: gate.p ? gate.p.weapon : null,
        code: gate.code,
        message: LOOT_ERROR_MESSAGES_UZ[gate.code],
      };
      ack?.(res);
      return res;
    }
    const p = gate.p;
    this.loot.syncPlayerFromServerPlayer(p.id, p);
    const res = this.loot.equipWeapon(id, p.alive, rawReq);
    if (res.ok && !res.idempotentReplay) {
      const prevEquipped = p.weapon;
      if (applyAuthoritativeWeaponSwitch(p, res.equippedWeapon, this.now(), { fromAutoPickup: false })) {
        p.authority.guardWeaponRevert(prevEquipped);
      }
      if (res.inventory) {
        p.socket?.emit('inventory:state', res.inventory);
      }
    }
    ack?.(res);
    return res;
  }

  onUseMedkit(id: string, rawReq: UseMedkitReq | unknown, ack?: (res: UseMedkitAck) => void): UseMedkitAck {
    const gate = this.lootRequestGate(id, rawReq);
    if (gate.code) {
      const res: UseMedkitAck = {
        ok: false,
        requestId: gate.requestId,
        code: gate.code,
        message: LOOT_ERROR_MESSAGES_UZ[gate.code],
      };
      ack?.(res);
      return res;
    }
    const p = gate.p;
    this.loot.syncPlayerFromServerPlayer(p.id, p);
    const { ack: res, newHp } = this.loot.useMedkit({ id, alive: p.alive, hp: p.hp }, rawReq);
    if (res.ok && !res.idempotentReplay) {
      p.hp = newHp;
      if (res.inventory) {
        p.socket?.emit('inventory:state', res.inventory);
      }
    }
    ack?.(res);
    return res;
  }

  onRequestLootSync(
    id: string,
    ack?: (res: { loot: RoomLootSnapshot; inventory: PlayerInventorySnap | null }) => void,
  ): { loot: RoomLootSnapshot; inventory: PlayerInventorySnap | null } {
    const p = this.players.get(id);
    if (p && !p.isBot) {
      this.loot.syncPlayerFromServerPlayer(p.id, p);
    }
    const payload = {
      loot: this.loot.getPublicLootSnapshot(),
      inventory: this.loot.getPlayerInventorySnap(id),
    };
    ack?.(payload);
    return payload;
  }

  onChat(id: string, text: unknown): void {
    const p = this.players.get(id);
    if (!p || typeof text !== 'string') return;
    const clean = text.replace(/[<>]/g, '').trim().slice(0, 120);
    if (!clean) return;
    if (clean.startsWith('/')) {
      this.chatCommand(p, clean);
      return;
    }
    this.pushChat({ name: p.name, text: clean, team: p.team, system: false });
  }

  private chatCommand(p: ServerPlayer, cmd: string) {
    const c = cmd.toLowerCase();
    if (c === '/addbot') {
      const maxBots = this.isSurvival ? SURVIVAL_MAX_BOTS : CLASSIC_MAX_BOTS;
      if (this.players.size >= ROOM_MAX_TOTAL_PLAYERS || this.botCount() >= maxBots) return this.systemChat('Botlar soni maksimal');
      const b = this.addBot();
      this.balanceBots();
      this.systemChat(`${p.name} bot qo'shdi: ${b.name}`);
      if (this.isSurvival) this.sendMatch();
    } else if (c === '/removebot' || c === '/kickbot') {
      if (this.removeBot()) {
        this.balanceBots();
        this.systemChat(`${p.name} bitta botni olib tashladi`);
      } else if (this.botCount() > 0) {
        this.systemChat("Raund davomida tirik botni olib tashlab bo'lmaydi");
      }
    } else if (c === '/addwolf' || c === '/removewolf') {
      if (this.isNight) return this.systemChat("Tong otguncha rejimida bo'rilar to'lqinlar bilan keladi — son o'zgartirilmaydi");
      if (c === '/removewolf') {
        if (this.wolfCount <= 0) return this.systemChat("Xonada bo'ri yo'q");
        const n = this.setWolfCount(this.wolfCount - 1);
        return this.systemChat(`${p.name} bitta bo'rini olib tashladi (jami: ${n})`);
      }
      if (this.wolfCount >= WOLF_MAX_PER_ROOM) return this.systemChat(`Bo'rilar soni maksimal (${WOLF_MAX_PER_ROOM})`);
      const n = this.setWolfCount(this.wolfCount + 1);
      this.systemChat(`${p.name} vahshiy bo'ri qo'shdi (jami: ${n})${this.isSurvival && this.phase !== 'playing' ? ' — keyingi raunddan' : ''}`);
    } else {
      p.socket?.emit('chat', {
        name: '',
        text: 'Buyruqlar: /addbot, /removebot, /addwolf, /removewolf',
        team: 'none',
        system: true,
      } as ChatMsg);
    }
  }

  onSwitchTeam(id: string): void {
    const p = this.players.get(id);
    if (!p || this.opts.mode !== 'tdm') return;
    const t = this.now();
    // Spam / chat toshqini va respawn taymerini qisqartirish hiylasiga qarshi cheklov
    if (t - p.lastTeamSwitch < 2) return;
    p.lastTeamSwitch = t;
    p.team = p.team === 'red' ? 'blue' : 'red';
    if (p.alive) {
      // Tirik o'yinchi jamoa almashtirsa o'ladi va odatdagi respawn vaqtini kutadi (klientdagi taymer bilan mos)
      p.alive = false;
      p.scoped = false;
      p.authority.clear();
      p.respawnAt = t + RESPAWN_TIME;
    }
    // O'lik o'yinchi uchun respawnAt o'zgarmaydi — M bilan respawnni tezlashtirib bo'lmaydi
    this.rosterDirty = true;
    this.systemChat(`${p.name} ${TEAM_NAMES[p.team]} jamoaga o'tdi`);
    this.balanceBots();
  }

  // ---------------- Jang ----------------

  private damage(
    target: ServerPlayer,
    attacker: ServerPlayer | ServerWolf,
    amount: number,
    weapon: WeaponId | 'grenade' | 'wolf',
    headshot: boolean,
    from: Vec3,
  ) {
    if (!target.alive || amount <= 0 || this.phase !== 'playing') return;
    if (this.now() - target.spawnTime < SPAWN_PROTECTION) return;
    // Zirh/kaska: zararning bir qismini yutadi, mustahkamlik shuncha kamayadi (faqat loot rejimida bo'ladi)
    let absorbed = 0;
    if (headshot) {
      if (target.helmet > 0) {
        absorbed = Math.min(target.helmet, Math.round(amount * HELMET_HEADSHOT_ABSORB));
        target.helmet -= absorbed;
      }
    } else if (target.armor > 0) {
      absorbed = Math.min(target.armor, Math.round(amount * ARMOR_DAMAGE_ABSORB));
      target.armor -= absorbed;
    }
    if (absorbed > 0) {
      this.loot.syncPlayerFromServerPlayer(target.id, target);
      if (!target.isBot) {
        const invSnap = this.loot.getPlayerInventorySnap(target.id);
        if (invSnap) target.socket?.emit('inventory:state', invSnap);
      }
    }
    amount -= absorbed;
    if (amount <= 0) return;
    target.hp -= amount;

    // Fizik zarba turtkisi (qurol kuchiga qarab raqibni orqaga itarish)
    const dx = target.pos.x - from.x;
    const dz = target.pos.z - from.z;
    const distH = Math.hypot(dx, dz) || 1;
    const wMult = weapon === 'grenade' ? 2.6 : weapon === 'shotgun' ? 1.9 : weapon === 'sniper' ? 2.2 : weapon === 'wolf' ? 1.6 : 1.0;
    const knock = clamp((amount / 26) * wMult, 0.5, 9.5);
    target.vel.x += (dx / distH) * knock * 2.2;
    target.vel.z += (dz / distH) * knock * 2.2;
    if ((weapon === 'grenade' || weapon === 'shotgun' || weapon === 'sniper') && target.onGround) {
      target.vel.y = Math.max(target.vel.y, weapon === 'grenade' ? 5.2 : 2.6);
      target.onGround = false;
    }

    const hurt: HurtEvent = { attacker: attacker.id, damage: amount, from, headshot };
    target.socket?.emit('hurt', hurt);
    const attackerPlayer = 'brain' in attacker && 'socket' in attacker ? (attacker as ServerPlayer) : null;
    if (attackerPlayer && attackerPlayer !== target) {
      const hc: HitConfirm = { target: target.id, damage: amount, headshot, kill: target.hp <= 0 };
      attackerPlayer.socket?.emit('hitConfirm', hc);
    }
    if (attackerPlayer) target.brain?.onDamaged(attackerPlayer);
    if (target.hp <= 0) this.kill(target, attacker, weapon, headshot);
  }

  private kill(
    victim: ServerPlayer,
    killer: ServerPlayer | ServerWolf,
    weapon: WeaponId | 'grenade' | 'zone' | 'wolf',
    headshot: boolean,
  ) {
    victim.alive = false;
    victim.hp = 0;
    victim.scoped = false;
    // Halok bo'lgan o'yinchi snapshotlarda o'tirgan holda qolmasin (jasad pozasi o'lim animatsiyasidan)
    victim.crouched = false;
    victim.authority.clear();
    victim.deaths++;
    // Qo'ldagi o'tin o'lim bilan yo'qoladi (wolf_night)
    victim.wood = 0;
    resetServerWeaponSwitchState(victim);
    if (!victim.isBot || this.lootEnabled) {
      // Loot rejimida qo'ldagi qurol (joriy o'qlari bilan) yerga tushadi — g'olib uni olishi mumkin.
      // Avval inventarni o'yinchining haqiqiy holatidan yangilaymiz (botlarning o'q soni eskirgan bo'lishi mumkin)
      if (this.lootEnabled) this.loot.syncPlayerFromServerPlayer(victim.id, victim);
      const dropped = this.loot.dropWeaponOnDeath(victim.id, victim.weapon, victim.pos, victim.yaw);
      this.loot.onPlayerDeath(victim.id);
      // Klientdagi inventar paneli o'lgan o'yinchining eski yuklamasini ko'rsatib turmasin
      const invSnap = this.loot.getPlayerInventorySnap(victim.id);
      if (invSnap) victim.socket?.emit('inventory:state', invSnap);
      if (dropped) this.io.to(this.channel).emit('loot:snapshot', this.loot.getPublicLootSnapshot());
    }
    if (this.isSurvival && this.survival) {
      victim.respawnAt = Infinity;
      victim.weapon = null;
      this.survival.recordElimination(victim.id, killer.id, this.now(), this.deferWinCheck);
    } else {
      victim.respawnAt = this.now() + RESPAWN_TIME;
    }
    const killerPlayer = 'socket' in killer ? (killer as ServerPlayer) : null;
    if (killerPlayer) {
      if (killerPlayer !== victim) {
        killerPlayer.kills++;
        if (this.opts.mode === 'tdm' && (killerPlayer.team === 'red' || killerPlayer.team === 'blue')) {
          this.scores[killerPlayer.team]++;
        }
      } else if (weapon !== 'zone') {
        killerPlayer.kills = Math.max(0, killerPlayer.kills - 1);
      }
    }
    const ev: KillEvent = {
      killer: killer.id,
      killerName: killerPlayer ? killerPlayer.name : WOLF_NAME_UZ,
      killerTeam: killerPlayer ? killerPlayer.team : 'none',
      victim: victim.id, victimName: victim.name, victimTeam: victim.team,
      weapon, headshot,
    };
    this.io.to(this.channel).emit('kill', ev);
    this.rosterDirty = true;
    if (this.isSurvival) {
      this.sendMatch();
    }
    if (!this.deferWinCheck) {
      this.checkWin();
    }
  }

  // ---------------- Bot loot yordamchilari (server ichida, ack'siz) ----------------

  private botReqSeq = 0;

  /** Bot konteynerni ochadi (masofa/LOS tekshiruvi loot authority'da). */
  botOpenContainer(p: ServerPlayer, containerId: string): ContainerOpenAck {
    this.loot.syncPlayerFromServerPlayer(p.id, p);
    const res = this.loot.openContainer(p, {
      requestId: `bot:${p.id}:${++this.botReqSeq}`,
      containerId,
      roundId: this.roundId,
      spawnId: p.spawnId,
    });
    if (res.ok && !res.idempotentReplay && res.container) {
      this.io.to(this.channel).emit('container:state', res.container);
    }
    return res;
  }

  /** Bot konteynerdan (yoki yerdan, containerId=null) buyum oladi. */
  botPickupItem(p: ServerPlayer, containerId: string | null, itemId: string): LootPickupAck {
    this.loot.syncPlayerFromServerPlayer(p.id, p);
    const prevWeapon = p.weapon;
    const res = this.loot.pickupItem(p, {
      requestId: `bot:${p.id}:${++this.botReqSeq}`,
      containerId,
      itemId,
      roundId: this.roundId,
      spawnId: p.spawnId,
    });
    if (res.ok && !res.idempotentReplay) {
      this.loot.applyInventoryToServerPlayer(p.id, p);
      if (prevWeapon === null && p.weapon !== null) {
        const pickedWeapon = p.weapon;
        p.weapon = prevWeapon;
        applyAuthoritativeWeaponSwitch(p, pickedWeapon, this.now(), { fromAutoPickup: true });
      }
      this.broadcastPickupResult(res);
    }
    return res;
  }

  /** Bot aptechka ishlatadi. */
  botUseMedkit(p: ServerPlayer): boolean {
    this.loot.syncPlayerFromServerPlayer(p.id, p);
    const { ack, newHp } = this.loot.useMedkit(
      { id: p.id, alive: p.alive, hp: p.hp },
      { requestId: `bot:${p.id}:${++this.botReqSeq}`, roundId: this.roundId, spawnId: p.spawnId },
    );
    if (ack.ok && !ack.idempotentReplay) {
      p.hp = newHp;
      this.loot.applyInventoryToServerPlayer(p.id, p);
      return true;
    }
    return false;
  }

  /** Joriy xavfsiz zona holati (faqat survival 'playing' fazasida), aks holda null. */
  getZoneSnap(t: number = this.now()): SurvivalZoneSnap | null {
    if (!this.isSurvival || !this.zoneTimeline || this.phase !== 'playing') return null;
    return evaluateSurvivalZone(this.zoneTimeline, t - this.roundStartedAt);
  }

  /** Zonadan tashqaridagi tirik ishtirokchilarga davriy zarar (zirh yutmaydi, spawn himoyasi ta'sir qilmaydi). */
  private applyZoneDamage(t: number): void {
    if (!this.survival || !this.zoneTimeline || t < this.nextZoneDamageAt) return;
    // Kechikishdan keyin bir necha oraliq o'tib ketgan bo'lsa ham bitta porsiya qo'llanadi
    this.nextZoneDamageAt = Math.max(this.nextZoneDamageAt + ZONE_DAMAGE_INTERVAL_SEC, t + ZONE_DAMAGE_INTERVAL_SEC * 0.5);
    const zone = evaluateSurvivalZone(this.zoneTimeline, t - this.roundStartedAt);
    const amount = Math.max(1, Math.round(zone.dps * ZONE_DAMAGE_INTERVAL_SEC));
    const prevDefer = this.deferWinCheck;
    this.deferWinCheck = true;
    for (const p of this.players.values()) {
      if (!p.alive || !this.survival.isAliveContender(p.id)) continue;
      if (!isOutsideSurvivalZone(zone, p.pos.x, p.pos.z)) continue;
      if (this.phase !== 'playing') break;
      p.hp -= amount;
      const hurt: HurtEvent = {
        attacker: '',
        damage: amount,
        from: { x: zone.cx, y: p.pos.y, z: zone.cz },
        headshot: false,
      };
      p.socket?.emit('hurt', hurt);
      p.brain?.onZoneDamaged?.(zone.cx, zone.cz);
      if (p.hp <= 0) this.kill(p, p, 'zone', false);
    }
    this.deferWinCheck = prevDefer;
    if (!this.deferWinCheck) this.checkWin();
  }

  private updateGrenades(dt: number, t: number) {
    const prevDefer = this.deferWinCheck;
    this.deferWinCheck = true;
    try {
      executeGrenadeTickBatch({
        getGrenades: () => this.grenades,
        setGrenades: (next) => {
          this.grenades = next;
        },
        getPhase: () => this.phase,
        dt,
        nowSec: t,
        world: this.world,
        explodeOne: (g) => this.explode(g),
        onBatchComplete: () => {
          this.deferWinCheck = prevDefer;
          if (!this.deferWinCheck) {
            this.checkWin();
          }
        },
      });
    } finally {
      this.deferWinCheck = prevDefer;
      // Butun to'plam portlab bo'lgach (bir tickda bir egasining ikki granatasi ham zarar bersin) tozalaymiz
      this.pruneDeparted();
    }
  }

  /** Granatalarni tozalash (raund boshi/oxiri): chiqib ketganlar ro'yxati ham bo'shaydi — aks holda yozuvlar qolib ketardi. */
  private clearGrenades(): void {
    this.grenades = [];
    this.departed.clear();
  }

  /** Hali granatasi uchayotgan chiqib ketgan o'yinchini (odam yoki olib tashlangan bot) saqlab qo'yadi. */
  private keepDepartedForGrenades(p: ServerPlayer): void {
    if (!this.grenades.some((g) => g.owner === p.id)) return;
    p.socket = null;
    p.brain = null;
    this.departed.set(p.id, p);
  }

  /** Granatasi qolmagan chiqib ketganlarni unutadi. */
  private pruneDeparted(): void {
    if (this.departed.size === 0) return;
    for (const id of [...this.departed.keys()]) {
      if (!this.grenades.some((g) => g.owner === id)) this.departed.delete(id);
    }
  }

  /** Testlar uchun: granata egasi sifatida saqlanayotgan chiqib ketganlar soni. */
  getDepartedCountForTest(): number {
    return this.departed.size;
  }

  private explode(g: ServerGrenadeRecord) {
    if (!isValidGrenadeRecord(g)) return;
    this.io.to(this.channel).emit('explosion', { x: q3(g.pos.x), y: q3(g.pos.y), z: q3(g.pos.z) });
    // Xonadan chiqib ketgan o'yinchining granatasi ham zarar beradi (departed ro'yxatidan olinadi;
    // ro'yxat updateGrenades oxirida tozalanadi)
    const owner = this.players.get(g.owner) ?? this.departed.get(g.owner);
    if (!owner || this.phase !== 'playing') return;
    const origin = { x: g.pos.x, y: g.pos.y + 0.15, z: g.pos.z };
    const prevDefer = this.deferWinCheck;
    this.deferWinCheck = true;
    try {
      for (const o of this.players.values()) {
        if (!o.alive) continue;
        if (o !== owner && !this.isEnemy(owner, o)) continue;
        // Tana markazi (o'tirganda pastroq) — portlashdan ko'rinish shu nuqtagacha tekshiriladi
        const center = { x: o.pos.x, y: o.pos.y + 1.0 * hitboxScaleOf(o), z: o.pos.z };
        const d = vdist(origin, center);
        if (d > GRENADE_RADIUS) continue;
        const blocked = raycastWorld(this.world, origin, vnorm(vsub(center, origin)), d);
        if (blocked && d > 0.5) continue;
        const amount = Math.round(GRENADE_DAMAGE * (1 - d / GRENADE_RADIUS));
        this.damage(o, owner, amount, 'grenade', false, origin);
      }
      for (const w of this.wolves.values()) {
        if (!w.alive) continue;
        const center = { x: w.pos.x, y: w.pos.y + 0.6, z: w.pos.z };
        const d = vdist(origin, center);
        if (d > GRENADE_RADIUS) continue;
        const blocked = raycastWorld(this.world, origin, vnorm(vsub(center, origin)), d);
        if (blocked && d > 0.5) continue;
        this.damageWolf(w, owner, Math.round(GRENADE_DAMAGE * (1 - d / GRENADE_RADIUS)), origin);
      }
      for (const w of this.wolves.values()) if (w.alive) w.brain.onNoise(origin, this.now(), null);
    } finally {
      this.deferWinCheck = prevDefer;
    }
    if (!this.deferWinCheck) {
      this.checkWin();
    }
  }

  // ---------------- Match & Forest Survival Lifecycle ----------------

  private handleSurvivalRoundStart(roundId: number, contenderIds: string[]): void {
    if (!this.survival) return;
    this.roundId = roundId;
    this.phase = 'playing';
    this.winner = '';
    this.clearGrenades();
    this.scores = { red: 0, blue: 0 };
    this.matchEndsAt = this.survival.getPhaseEndsAt();
    this.phaseEndsAt = 0;
    const roundLootSeed = ((this.secretLootSeed + roundId * 104729) >>> 0) || 1;
    this.loot.resetForRound(roundId, roundLootSeed);
    // Xavfsiz zona: raundga xos deterministik jadval (klient faqat snapshot oladi)
    const b = this.world.bounds;
    const zoneSeed = ((this.secretLootSeed ^ 0x5a17) + roundId * 7919) >>> 0 || 1;
    const survCfg = this.survival.getConfig();
    this.zoneTimeline = survCfg.zoneEnabled
      ? buildSurvivalZoneTimeline(zoneSeed, survCfg.roundDurationSec, Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2)
      : null;
    this.roundStartedAt = this.now();
    this.nextZoneDamageAt = this.roundStartedAt + ZONE_DAMAGE_INTERVAL_SEC;

    // Tong otguncha: gulxanlar yonadi, g'aramlar to'la (o'yinchilar asosiy gulxan atrofida tug'iladi)
    if (this.isNight) this.resetCampForRound();

    const contenderSet = new Set(contenderIds);
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      resetServerWeaponSwitchState(p);
      p.scoped = false;
      if (contenderSet.has(p.id) && p.ready) {
        this.spawn(p);
      } else {
        p.alive = false;
        p.hp = 0;
        p.weapon = null;
        p.respawnAt = Infinity;
        p.authority.clear();
        if (p.ready) {
          const invSnap = this.loot.resetPlayerForSpawn(p.id, p.spawnId);
          this.loot.onPlayerDeath(p.id);
          p.socket?.emit('inventory:state', invSnap);
        }
      }
    }

    // Bo'rilar raund boshida o'yinchilardan uzoqda paydo bo'ladi
    this.wolves.clear();
    if (this.isNight) {
      // Tong otguncha: 1-to'lqin (NIGHT_WAVES[0]) — bo'rilar soni/kuchini jadval belgilaydi
      this.nightWaveIdx = -1;
      this.updateNightWaves(this.roundStartedAt);
    } else {
      this.syncWolvesToCount();
    }

    this.io.to(this.channel).emit('loot:snapshot', this.loot.getPublicLootSnapshot());
    this.rosterDirty = true;
    this.sendRoster();
    this.sendMatch();
    if (this.isNight) {
      this.systemChat(`🌙 ${roundId}-tun boshlandi — tong otguncha omon qoling! Qurol va buyumlarni konteynerlardan toping.`);
      this.systemChat(`1-to'lqin: o'rmonda ${this.wolves.size} ta vahshiy bo'ri bor, har to'lqinda ko'payadi va kuchayadi.`);
      this.systemChat(
        "🔥 Bo'rilar yonib turgan gulxanga yaqinlashmaydi. O'tin tugamasin — o'rmondagi o'tin g'aramlaridan olib kelib gulxanga tashlang!",
      );
      return;
    }
    this.systemChat(`Forest Survival — ${roundId}-raund boshlandi! Qurol va buyumlarni konteynerlardan toping.`);
    if (this.wolves.size > 0) {
      this.systemChat(`Ehtiyot bo'ling: o'rmonda ${this.wolves.size} ta vahshiy bo'ri bor!`);
    }
  }

  private handleSurvivalRoundEnd(
    roundId: number,
    winnerId: string | null,
    winnerName: string,
    winReason: SurvivalWinReason,
  ): void {
    void roundId;
    if (!this.survival) return;
    this.phase = 'ended';
    this.phaseEndsAt = this.survival.getPhaseEndsAt();
    this.clearGrenades();
    this.wolves.clear();
    this.nightWaveIdx = -1;
    const dawn = winReason === 'dawn';
    this.winner = winnerId ? (winnerName || winnerId) : dawn ? winnerName : 'draw';
    for (const p of this.players.values()) {
      resetServerWeaponSwitchState(p);
      p.scoped = false;
      p.authority.clear();
    }
    this.rosterDirty = true;
    this.sendRoster();
    this.sendMatch();
    if (dawn) {
      this.systemChat(`🌅 Tong otdi! Tunni o'tkazganlar: ${winnerName}`);
    } else if (winnerId) {
      this.systemChat(`Raund yakunlandi! G'olib: ${winnerName || winnerId}`);
    } else if (this.isNight) {
      this.systemChat("Tun hammani yutdi — tirik qolganlar yo'q. Bo'rilar g'olib!");
    } else {
      this.systemChat('Raund durang bilan yakunlandi!');
    }
  }

  private handleSurvivalPreRoundReset(
    roundId: number,
    nextPhase: 'waiting' | 'countdown',
  ): void {
    if (!this.survival) return;
    this.roundId = roundId;
    this.phase = nextPhase;
    this.phaseEndsAt = this.survival.getPhaseEndsAt();
    this.winner = '';
    this.clearGrenades();
    this.wolves.clear();
    this.nightWaveIdx = -1;
    // Tong otguncha: sanoq paytida ham gulxan/g'aramlar snapshotga chiqadi — o'tgan tunning o'chgan gulxanlari
    // va bo'sh g'aramlari ko'rinib qolmasin (raund boshida yana bir bor tiklanadi)
    if (this.isNight) this.resetCampForRound();
    const roundLootSeed = ((this.secretLootSeed + roundId * 104729) >>> 0) || 1;
    this.loot.resetForRound(roundId, roundLootSeed);
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.wood = 0;
      resetServerWeaponSwitchState(p);
      p.scoped = false;
      if (p.ready) {
        this.spawn(p);
      }
    }
    this.io.to(this.channel).emit('loot:snapshot', this.loot.getPublicLootSnapshot());
    this.rosterDirty = true;
    this.sendRoster();
    this.sendMatch();
  }

  private checkWin() {
    if (this.phase !== 'playing') return;
    if (this.isSurvival && this.survival) {
      const outcome = this.survival.checkOutcome(this.now());
      if (outcome) {
        this.phase = this.survival.getPhase();
        this.phaseEndsAt = this.survival.getPhaseEndsAt();
      }
      return;
    }
    const limit = this.opts.scoreLimit;
    if (this.opts.mode === 'tdm') {
      if (this.scores.red >= limit || this.scores.blue >= limit) this.endMatch();
    } else {
      for (const p of this.players.values()) if (p.kills >= limit) return this.endMatch();
    }
  }

  private endMatch() {
    this.phase = 'ended';
    this.phaseEndsAt = this.now() + MATCH_END_DURATION;
    this.clearGrenades();
    if (this.opts.mode === 'tdm') {
      const { red, blue } = this.scores;
      this.winner = red > blue ? 'red' : blue > red ? 'blue' : 'draw';
    } else {
      const top = [...this.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
      this.winner = top ? top.name : 'draw';
    }
    this.sendMatch();
    this.sendRoster();
  }

  private restartMatch() {
    this.phase = 'playing';
    this.winner = '';
    this.scores = { red: 0, blue: 0 };
    this.matchEndsAt = this.now() + this.opts.timeLimit * 60;
    // Loot rejimida (FFA/TDM + lootPreview) yangi raund uchun konteynerlarni qayta to'ldiramiz,
    // aks holda o'yinchilar qurolsiz qayta tug'iladi va konteynerlar bo'sh qoladi.
    if (this.lootEnabled) {
      this.roundId++;
      const roundLootSeed = ((this.secretLootSeed + this.roundId * 104729) >>> 0) || 1;
      this.loot.resetForRound(this.roundId, roundLootSeed);
    }
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      if (p.ready) this.spawn(p);
    }
    // Bo'rilar yangi raundda qaytadan, o'yinchilardan uzoqda paydo bo'ladi
    this.wolves.clear();
    this.syncWolvesToCount();
    if (this.lootEnabled) this.io.to(this.channel).emit('loot:snapshot', this.loot.getPublicLootSnapshot());
    this.rosterDirty = true;
    this.sendMatch();
    this.systemChat('Yangi raund boshlandi!');
  }

  // ---------------- Chat ----------------

  private pushChat(m: ChatMsg) {
    this.chatHistory.push(m);
    if (this.chatHistory.length > 20) this.chatHistory.shift();
    this.io.to(this.channel).emit('chat', m);
  }

  systemChat(text: string): void {
    this.pushChat({ name: '', text, team: 'none', system: true });
  }

  // ---------------- Tick ----------------

  private tick() {
    if (this.destroyed) return;
    const t = this.now();
    const rawDt = t - this.lastTick;
    // Haqiqiy o'tgan vaqtni ishlatamiz: kechikishdan keyingi yetib olish tick'lari (~4 ms oraliq)
    // har biriga 1/30 s berilsa, vaqt ikki marta sanalardi (botlar/granatalar tezlashardi).
    const dt = rawDt <= 0 ? 1 / TICK_RATE : Math.min(0.1, rawDt);
    // Yetib olish budjeti uchun haqiqiy kechikish (stall) ni ham saqlaymiz
    const rawElapsed = rawDt <= 0 ? dt : rawDt;
    this.lastTick = t;
    this.serverTick++;
    this.localPathBudget = 1;

    if (this.isSurvival && this.survival) {
      if (this.survival.getPhase() === 'playing') {
        for (const p of this.players.values()) {
          if (p.reloadWeapon && t >= p.reloadUntil) this.finishReload(p);
        }
      }
      for (const p of this.players.values()) {
        if (!p.isBot && p.alive && p.ready && this.survival.canPlayerMove(p.id)) {
          this.stepHumanAuthority(p, dt, rawElapsed, t);
        }
      }
      if (this.survival.getPhase() === 'playing') {
        // wolf_night: to'lqin jadvali (bo'rilar soni/kuchi) va lager (o'tin yonishi) — bo'ri AI dan oldin
        if (this.isNight) {
          this.updateNightWaves(t);
          this.updateCamp(dt, t);
        }
        for (const p of this.players.values()) if (p.brain && p.alive) p.brain.update(dt, t);
        this.updateGrenades(dt, t);
        this.applyZoneDamage(t);
      }
      const prevPhase = this.survival.getPhase();
      this.survival.tick(t);
      this.phase = this.survival.getPhase();
      this.phaseEndsAt = this.survival.getPhaseEndsAt();
      if (this.phase === 'playing') {
        this.matchEndsAt = this.survival.getPhaseEndsAt();
      }
      if (this.survival.getPhase() !== prevPhase) {
        this.rosterDirty = true;
        this.sendMatch();
      }
    } else if (this.phase === 'playing') {
      for (const p of this.players.values()) {
        if (p.reloadWeapon && t >= p.reloadUntil) this.finishReload(p);
        if (!p.alive && p.ready && t >= p.respawnAt) this.spawn(p);
      }
      for (const p of this.players.values()) {
        if (!p.isBot && p.alive && p.ready) this.stepHumanAuthority(p, dt, rawElapsed, t);
      }
      for (const p of this.players.values()) if (p.brain && p.alive) p.brain.update(dt, t);
      this.updateGrenades(dt, t);
      if (t >= this.matchEndsAt) this.endMatch();
    } else if (t >= this.phaseEndsAt) {
      this.restartMatch();
    } else {
      for (const p of this.players.values()) {
        if (!p.isBot && p.alive && p.ready) this.stepHumanAuthority(p, dt, rawElapsed, t);
      }
      for (const p of this.players.values()) if (p.brain && p.alive) p.brain.update(dt, t);
    }
    // Bo'rilar: AI faqat 'playing' fazasida yuradi (WolfBrain fazani tekshiradi), jasadlar har doim tozalanadi
    if (this.wolves.size > 0) this.updateWolves(dt, t);

    this.sendSnapshot(t);
    if (this.rosterDirty || t >= this.nextRosterAt) this.sendRoster();
    if (t >= this.nextMatchAt) this.sendMatch();
  }

  private sendSnapshot(t: number) {
    const players: PlayerSnap[] = [];
    for (const p of this.players.values()) {
      if (!p.ready) continue;
      const snapP: PlayerSnap = {
        id: p.id,
        x: q3(p.pos.x), y: q3(p.pos.y), z: q3(p.pos.z),
        vx: q3(p.vel.x), vy: q3(p.vel.y), vz: q3(p.vel.z),
        yaw: q3(p.yaw), pitch: q3(p.pitch),
        hp: Math.max(0, Math.round(p.hp)),
        alive: p.alive,
        weapon: p.weapon,
        onGround: p.onGround,
        reloading: !!p.reloadWeapon,
        spawnId: p.spawnId,
        lastProcessedInputSeq: p.isBot ? 0 : p.authority.lastProcessedSeq,
        stamina: q3(p.stamina),
        staminaLocked: p.staminaLocked,
        gear: packGearState({
          helmet: p.helmet > 0,
          armor: p.armor > 0,
          grenades: p.grenades,
          medkits: this.loot.getMedkitCount(p.id),
        }),
      };
      // O'tirish faqat true bo'lganda yuboriladi (tik turish — maydon yo'q, trafik tejaladi)
      if (p.crouched) snapP.crouched = true;
      // wolf_night: qo'ldagi o'tin faqat 0 dan katta bo'lsa
      if (p.wood > 0) snapP.wood = p.wood;
      if (this.isSurvival && this.survival) {
        snapP.survivalRole = this.survival.getPlayerRole(p.id);
        snapP.spectateTargetId = this.survival.getSpectateTarget(p.id);
      }
      players.push(snapP);
    }
    const snap: Snapshot = {
      t: q3(t),
      serverTick: this.serverTick,
      roundId: this.loot.getRoundId(),
      players,
      grenades: this.grenades.map((g) => ({ id: g.id, x: q3(g.pos.x), y: q3(g.pos.y), z: q3(g.pos.z) })),
    };
    if (this.wolves.size > 0) {
      const wolves: WolfSnap[] = [];
      for (const w of this.wolves.values()) {
        // Jasad WOLF_CORPSE_SEC dan keyin snapshotdan chiqadi (qayta tug'ilishni kutayotgan bo'ri ko'rinmaydi;
        // klient snapshotda yo'q bo'rini sahnadan olib tashlaydi, qayta tug'ilganda yangidan yaratadi)
        if (!w.alive && t - w.diedAt >= WOLF_CORPSE_SEC) continue;
        const ws: WolfSnap = {
          id: w.id,
          x: q3(w.pos.x), y: q3(w.pos.y), z: q3(w.pos.z),
          yaw: q3(w.yaw),
          hp: Math.max(0, Math.round(w.hp)),
          state: w.state,
          coat: w.coat,
        };
        if (w.targetId) ws.targetId = w.targetId;
        wolves.push(ws);
      }
      if (wolves.length) snap.wolves = wolves;
    }
    this.io.to(this.channel).volatile.emit('snap', snap);
  }

  private sendRoster() {
    this.rosterDirty = false;
    this.nextRosterAt = this.now() + 2;
    const list: RosterEntry[] = [...this.players.values()].map((p) => {
      const entry: RosterEntry = {
        id: p.id, name: p.name, team: p.team, isBot: p.isBot, kills: p.kills, deaths: p.deaths, ping: p.ping,
      };
      if (this.isSurvival && this.survival) {
        entry.survivalRole = this.survival.getPlayerRole(p.id);
        entry.alive = p.alive;
        entry.placement = this.survival.getPlacement(p.id);
      }
      return entry;
    });
    this.io.to(this.channel).emit('roster', list);
  }

  private sendMatch() {
    // 0.5 s: 1 s (33 ms tick kvantlanishi bilan ~1.03 s) oraliq ceil() bilan countdown soniyalarini sakratib yuborardi
    this.nextMatchAt = this.now() + 0.5;
    const t = this.now();
    if (this.isSurvival && this.survival) {
      const surv = this.survival.getStateSnap(t);
      this.phase = surv.phase;
      const m: MatchState = {
        phase: surv.phase,
        timeLeft: surv.timeLeft,
        scores: { ...this.scores },
        scoreLimit: this.opts.scoreLimit,
        mode: this.opts.mode,
        winner: this.winner,
        roundId: surv.roundId,
        aliveCount: surv.aliveCount,
        totalContenders: surv.totalContenders,
        readyCount: surv.readyCount,
        minPlayers: surv.minPlayers,
        winnerId: surv.winnerId,
        winReason: surv.winReason,
        survival: {
          ...surv,
          zone: this.getZoneSnap(t),
          // wolf_night: tun/to'lqin holati (forest_survival payloadi o'zgarmaydi)
          ...(this.isNight ? { night: this.getNightSnap(t) } : {}),
        },
      };
      this.io.to(this.channel).emit('match', m);
      return;
    }
    const m: MatchState = {
      phase: this.phase,
      timeLeft: Math.max(0, Math.round(this.phase === 'playing' ? this.matchEndsAt - t : this.phaseEndsAt - t)),
      scores: { ...this.scores },
      scoreLimit: this.opts.scoreLimit,
      mode: this.opts.mode,
      winner: this.winner,
    };
    this.io.to(this.channel).emit('match', m);
  }
}

/** Xarita spawnlarini tekshirish (dasturchilar uchun). */
export function validateMapSpawns(world: WorldDefinition): string[] {
  const bad: string[] = [];
  for (const s of world.spawnPoints) {
    if (!isSpawnPointSafe(world, s)) bad.push(`${s.team} (${s.x}, ${s.z})`);
  }
  return bad;
}
