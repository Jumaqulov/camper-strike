import type { Server, Socket } from 'socket.io';
import {
  EYE_HEIGHT, GRENADE_DAMAGE, GRENADE_FUSE, GRENADE_RADIUS, GRENADE_THROW_SPEED, GRENADES_PER_LIFE, MATCH_END_DURATION,
  MAX_HP, RESPAWN_TIME, SPAWN_PROTECTION, TEAM_NAMES, TICK_RATE, type Team,
} from '../shared/constants';
import { clamp, isVec3, spreadDir, vdist, vnorm, vsub, type Vec3 } from '../shared/math';
import {
  isSpawnPointSafe,
  pointInsideBoxes,
  raycastWorld,
  rayVsPlayer,
  type Body,
  type HitZone,
} from '../shared/physics';
import type {
  ChatMsg, ClientState, ContainerOpenAck, ContainerOpenReq, CreateRoomOpts, EquipWeaponAck, EquipWeaponReq,
  HitConfirm, HurtEvent, InputAckEvent, KillEvent, LootPickupAck, LootPickupReq, MatchState,
  PlayerInputBatchMsg, PlayerInputCmd, PlayerInventorySnap, PlayerSnap, ReadyAck, ReadyMsg,
  RoomInfo, RoomLootSnapshot, RosterEntry, ShootMsg, ShotEvent, Snapshot, SpawnEvent,
  SurvivalConfig, SurvivalPhase, SurvivalStateSnap, UseMedkitAck, UseMedkitReq, WelcomeMsg,
} from '../shared/protocol';
import {
  ARMOR_DAMAGE_ABSORB,
  HELMET_HEADSHOT_ABSORB,
  LOOT_ERROR_MESSAGES_UZ,
  validateBulletDirectionsAgainstAim,
} from '../shared/loot';
import { damageAt, emptyAmmo, fullAmmo, isWeaponId, WEAPONS, type AmmoState, type WeaponDef, type WeaponId } from '../shared/weapons';
import {
  createWorldDefinition, CURRENT_WORLD_VERSION, DEFAULT_PUBLIC_LAYOUT_SEED, DEFAULT_WORLD, extractWorldMeta,
  validateWorldCompatibility, type WorldDefinition, type WorldMeta,
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
  brain: BotBrain | null;
  authority: PlayerMovementAuthority;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
let roomSeq = 0;

export class Room {
  readonly id: string;
  readonly world: WorldDefinition;
  readonly nav: NavGraph;
  readonly isSurvival: boolean;
  readonly lootEnabled: boolean;
  readonly lootPreview: boolean;
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
  private chatHistory: ChatMsg[] = [];
  /** Xonadan chiqib ketgan, lekin hali portlamagan granatasi bor o'yinchilar (granata zarar berishi uchun). */
  private departed = new Map<string, ServerPlayer>();
  destroyed = false;

  constructor(readonly opts: CreateRoomOpts, private io: Server, private onEmpty: (room: Room) => void) {
    this.id = 'r' + ++roomSeq + Math.random().toString(36).slice(2, 6);
    this.isSurvival = opts.mode === 'forest_survival';
    if (this.isSurvival && opts.mapId && opts.mapId !== 'forest_square') {
      throw new Error('Forest Survival rejimi faqat forest_square xaritasida yaratilishi mumkin');
    }
    const mapId = this.isSurvival ? 'forest_square' : (opts.mapId ?? 'dust_arena');
    this.world = createWorldDefinition({
      mapId,
      worldVersion: CURRENT_WORLD_VERSION,
      publicLayoutSeed: opts.publicLayoutSeed ?? DEFAULT_PUBLIC_LAYOUT_SEED,
    });
    this.nav = getNav(this.world);
    this.secretLootSeed = Math.floor(Math.random() * 0x7fffffff) + 1;
    this.lootEnabled = this.isSurvival || (Boolean(opts.lootPreview) && mapId === 'forest_square');
    this.lootPreview = this.lootEnabled;
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
        {
          minPlayersToStart: 2,
          countdownDurationSec: opts.countdownSec ?? 10,
          roundDurationSec: Math.max(5, (opts.timeLimit || 3) * 60),
          endedDisplayDurationSec: MATCH_END_DURATION,
          zoneEnabled: true,
        },
      );
    } else {
      this.phase = 'playing';
      this.survival = null;
    }

    this.matchEndsAt = this.now() + opts.timeLimit * 60;
    this.lastTick = this.now();
    // Survival'da botlar loot AI bilan ishtirok etadi; klassik loot ko'rish rejimida botlar yo'q
    const initialBots = this.lootEnabled && !this.isSurvival ? 0 : opts.bots;
    for (let i = 0; i < initialBots; i++) this.addBot();
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
    };
  }

  isFull(): boolean {
    return this.humanCount() >= this.opts.maxPlayers;
  }

  isEnemy(a: ServerPlayer, b: ServerPlayer): boolean {
    if (a === b) return false;
    return this.opts.mode === 'ffa' || this.opts.mode === 'forest_survival' || a.team !== b.team;
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
      brain: null,
      authority: new PlayerMovementAuthority(),
    };
  }

  private pickTeam(): Team {
    if (this.opts.mode === 'ffa' || this.opts.mode === 'forest_survival') return 'none';
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
    const bots = [...this.players.values()].filter((p) => p.isBot);
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
          : `${p.name} Forest Survival xonasiga qo'shildi`,
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
    if (this.grenades.some((g) => g.owner === id)) {
      p.socket = null;
      p.brain = null;
      this.departed.set(id, p);
    }
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

  private pickSpawn(p: ServerPlayer) {
    const cands = this.world.spawnPoints.filter((s) => (this.opts.mode === 'tdm' ? s.team === p.team : true));
    const others = [...this.players.values()].filter((o) => o !== p && o.alive);
    const scored = cands.map((s) => {
      let minEnemy = 999;
      let occupied = false;
      for (const o of others) {
        const d = Math.hypot(o.pos.x - s.x, o.pos.z - s.z);
        if (d < 1.5) occupied = true;
        if (this.isEnemy(p, o)) minEnemy = Math.min(minEnemy, d);
      }
      const score = (occupied ? -1000 : 0) + Math.min(minEnemy, 60) + Math.random() * 10;
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
    p.yaw = this.opts.mode === 'ffa' || this.opts.mode === 'forest_survival' ? Math.random() * Math.PI * 2 : sp.yaw;
    p.pitch = 0;
    p.scoped = false;
    p.stamina = 1;
    p.staminaLocked = false;
    p.armor = 0;
    p.helmet = 0;
    p.hp = MAX_HP;
    p.alive = true;
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
    const eye = { x: p.pos.x, y: p.pos.y + EYE_HEIGHT, z: p.pos.z };

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
    const eye = { x: p.pos.x, y: p.pos.y + EYE_HEIGHT, z: p.pos.z };
    const aim = { x: -Math.sin(p.yaw) * Math.cos(p.pitch), y: Math.sin(p.pitch), z: -Math.cos(p.yaw) * Math.cos(p.pitch) };
    const moving = Math.hypot(p.vel.x, p.vel.z) > 1 ? def.moveSpread * 0.5 : 0;
    const base = (def.id === 'sniper' ? 0.002 : def.spread) + moving + extraSpread;
    const dirs: Vec3[] = [];
    for (let i = 0; i < def.pellets; i++) dirs.push(spreadDir(aim, def.pellets > 1 ? def.spread : base));
    if (def.pellets > 1 && extraSpread > 0) for (let i = 0; i < dirs.length; i++) dirs[i] = spreadDir(dirs[i], extraSpread * 0.5);
    return this.fire(p, def, eye, dirs, 1);
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
    const ammo = p.ammo[def.id];
    if (ammo.mag <= 0) return false;
    ammo.mag--;
    p.fireCredit -= 1;
    p.lastShot = t;
    p.spawnTime = -99; // o'q uzgan zahoti spawn himoyasi tugaydi

    const ends: Vec3[] = [];
    const dmg = new Map<ServerPlayer, { dmg: number; head: boolean }>();
    for (const d of dirs) {
      const wall = raycastWorld(this.world, origin, d, def.range);
      let maxT = wall ? wall.t : def.range;
      let hitP: ServerPlayer | null = null;
      let zone: HitZone = 'torso';
      for (const o of this.players.values()) {
        if (!o.alive || !this.isEnemy(p, o)) continue;
        const h = rayVsPlayer(origin, d, o.pos, maxT);
        if (h) {
          maxT = h.t;
          hitP = o;
          zone = h.zone;
        }
      }
      ends.push({ x: r3(origin.x + d.x * maxT), y: r3(origin.y + d.y * maxT), z: r3(origin.z + d.z * maxT) });
      if (hitP) {
        // Zarar tegish zonasiga qarab: bosh ×headMult, tana ×1, oyoq ×0.7
        const amount = damageAt(def, maxT, zone);
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
    if (!p.isBot) {
      this.loot.syncPlayerFromServerPlayer(p.id, p);
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
    if (!p.isBot) {
      this.loot.syncPlayerFromServerPlayer(p.id, p);
      const invSnap = this.loot.getPlayerInventorySnap(p.id);
      if (invSnap) p.socket?.emit('inventory:state', invSnap);
    }
    const eye = { x: p.pos.x, y: p.pos.y + EYE_HEIGHT - 0.1, z: p.pos.z };
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

  onContainerOpen(id: string, rawReq: ContainerOpenReq | unknown, ack?: (res: ContainerOpenAck) => void): ContainerOpenAck {
    const p = this.players.get(id);
    if (!p || p.isBot || !p.ready) {
      const res: ContainerOpenAck = {
        ok: false,
        requestId: typeof (rawReq as { requestId?: unknown })?.requestId === 'string' ? (rawReq as { requestId: string }).requestId : '',
        containerId: typeof (rawReq as { containerId?: unknown })?.containerId === 'string' ? (rawReq as { containerId: string }).containerId : '',
        code: 'PLAYER_NOT_FOUND',
        message: LOOT_ERROR_MESSAGES_UZ.PLAYER_NOT_FOUND,
      };
      ack?.(res);
      return res;
    }
    if (this.isSurvival && this.phase !== 'playing' && p.alive) {
      const res: ContainerOpenAck = {
        ok: false,
        requestId: typeof (rawReq as { requestId?: unknown })?.requestId === 'string' ? (rawReq as { requestId: string }).requestId : '',
        containerId: typeof (rawReq as { containerId?: unknown })?.containerId === 'string' ? (rawReq as { containerId: string }).containerId : '',
        code: 'ROUND_NOT_ACTIVE',
        message: LOOT_ERROR_MESSAGES_UZ.ROUND_NOT_ACTIVE,
      };
      ack?.(res);
      return res;
    }
    this.loot.syncPlayerFromServerPlayer(p.id, p);
    const res = this.loot.openContainer(p, rawReq);
    if (res.ok && !res.idempotentReplay && res.container) {
      this.io.to(this.channel).emit('container:state', res.container);
      this.io.to(this.channel).emit('loot:snapshot', this.loot.getPublicLootSnapshot());
    }
    ack?.(res);
    return res;
  }

  onLootPickup(id: string, rawReq: LootPickupReq | unknown, ack?: (res: LootPickupAck) => void): LootPickupAck {
    const p = this.players.get(id);
    if (!p || p.isBot || !p.ready) {
      const res: LootPickupAck = {
        ok: false,
        requestId: typeof (rawReq as { requestId?: unknown })?.requestId === 'string' ? (rawReq as { requestId: string }).requestId : '',
        itemId: typeof (rawReq as { itemId?: unknown })?.itemId === 'string' ? (rawReq as { itemId: string }).itemId : '',
        code: 'PLAYER_NOT_FOUND',
        message: LOOT_ERROR_MESSAGES_UZ.PLAYER_NOT_FOUND,
      };
      ack?.(res);
      return res;
    }
    if (this.isSurvival && this.phase !== 'playing' && p.alive) {
      const res: LootPickupAck = {
        ok: false,
        requestId: typeof (rawReq as { requestId?: unknown })?.requestId === 'string' ? (rawReq as { requestId: string }).requestId : '',
        itemId: typeof (rawReq as { itemId?: unknown })?.itemId === 'string' ? (rawReq as { itemId: string }).itemId : '',
        code: 'ROUND_NOT_ACTIVE',
        message: LOOT_ERROR_MESSAGES_UZ.ROUND_NOT_ACTIVE,
      };
      ack?.(res);
      return res;
    }
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
      if (res.container) {
        this.io.to(this.channel).emit('container:state', res.container);
      }
      this.io.to(this.channel).emit('loot:snapshot', this.loot.getPublicLootSnapshot());
    }
    ack?.(res);
    return res;
  }

  onEquipWeapon(id: string, rawReq: EquipWeaponReq | unknown, ack?: (res: EquipWeaponAck) => void): EquipWeaponAck {
    const p = this.players.get(id);
    if (!p || p.isBot || !p.ready) {
      const res: EquipWeaponAck = {
        ok: false,
        requestId: typeof (rawReq as { requestId?: unknown })?.requestId === 'string' ? (rawReq as { requestId: string }).requestId : '',
        equippedWeapon: null,
        code: 'PLAYER_NOT_FOUND',
        message: LOOT_ERROR_MESSAGES_UZ.PLAYER_NOT_FOUND,
      };
      ack?.(res);
      return res;
    }
    if (this.isSurvival && this.phase !== 'playing' && p.alive) {
      const res: EquipWeaponAck = {
        ok: false,
        requestId: typeof (rawReq as { requestId?: unknown })?.requestId === 'string' ? (rawReq as { requestId: string }).requestId : '',
        equippedWeapon: p.weapon,
        code: 'ROUND_NOT_ACTIVE',
        message: LOOT_ERROR_MESSAGES_UZ.ROUND_NOT_ACTIVE,
      };
      ack?.(res);
      return res;
    }
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
    const p = this.players.get(id);
    if (!p || p.isBot || !p.ready) {
      const res: UseMedkitAck = {
        ok: false,
        requestId: typeof (rawReq as { requestId?: unknown })?.requestId === 'string' ? (rawReq as { requestId: string }).requestId : '',
        code: 'PLAYER_NOT_FOUND',
        message: LOOT_ERROR_MESSAGES_UZ.PLAYER_NOT_FOUND,
      };
      ack?.(res);
      return res;
    }
    if (this.isSurvival && this.phase !== 'playing' && p.alive) {
      const res: UseMedkitAck = {
        ok: false,
        requestId: typeof (rawReq as { requestId?: unknown })?.requestId === 'string' ? (rawReq as { requestId: string }).requestId : '',
        code: 'ROUND_NOT_ACTIVE',
        message: LOOT_ERROR_MESSAGES_UZ.ROUND_NOT_ACTIVE,
      };
      ack?.(res);
      return res;
    }
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
      if (this.lootEnabled && !this.isSurvival) {
        return this.systemChat("Loot ko'rish rejimida botlar o'chirilgan");
      }
      if (this.players.size >= 24) return this.systemChat('Botlar soni maksimal');
      const b = this.addBot();
      this.balanceBots();
      this.systemChat(`${p.name} bot qo'shdi: ${b.name}`);
      if (this.isSurvival) this.sendMatch();
    } else if (c === '/removebot' || c === '/kickbot') {
      if (this.lootEnabled && !this.isSurvival) {
        return this.systemChat("Loot ko'rish rejimida botlar o'chirilgan");
      }
      if (this.removeBot()) {
        this.balanceBots();
        this.systemChat(`${p.name} bitta botni olib tashladi`);
      }
    } else {
      p.socket?.emit('chat', { name: '', text: 'Buyruqlar: /addbot, /removebot', team: 'none', system: true } as ChatMsg);
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

  private damage(target: ServerPlayer, attacker: ServerPlayer, amount: number, weapon: WeaponId | 'grenade', headshot: boolean, from: Vec3) {
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
    const wMult = weapon === 'grenade' ? 2.6 : weapon === 'shotgun' ? 1.9 : weapon === 'sniper' ? 2.2 : 1.0;
    const knock = clamp((amount / 26) * wMult, 0.5, 9.5);
    target.vel.x += (dx / distH) * knock * 2.2;
    target.vel.z += (dz / distH) * knock * 2.2;
    if ((weapon === 'grenade' || weapon === 'shotgun' || weapon === 'sniper') && target.onGround) {
      target.vel.y = Math.max(target.vel.y, weapon === 'grenade' ? 5.2 : 2.6);
      target.onGround = false;
    }

    const hurt: HurtEvent = { attacker: attacker.id, damage: amount, from, headshot };
    target.socket?.emit('hurt', hurt);
    if (attacker !== target) {
      const hc: HitConfirm = { target: target.id, damage: amount, headshot, kill: target.hp <= 0 };
      attacker.socket?.emit('hitConfirm', hc);
    }
    target.brain?.onDamaged(attacker);
    if (target.hp <= 0) this.kill(target, attacker, weapon, headshot);
  }

  private kill(victim: ServerPlayer, killer: ServerPlayer, weapon: WeaponId | 'grenade' | 'zone', headshot: boolean) {
    victim.alive = false;
    victim.hp = 0;
    victim.scoped = false;
    victim.authority.clear();
    victim.deaths++;
    resetServerWeaponSwitchState(victim);
    if (!victim.isBot || this.lootEnabled) {
      // Loot rejimida qo'ldagi qurol (joriy o'qlari bilan) yerga tushadi — g'olib uni olishi mumkin
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
    if (killer !== victim) {
      killer.kills++;
      if (this.opts.mode === 'tdm' && (killer.team === 'red' || killer.team === 'blue')) this.scores[killer.team]++;
    } else if (weapon !== 'zone') {
      killer.kills = Math.max(0, killer.kills - 1);
    }
    const ev: KillEvent = {
      killer: killer.id, killerName: killer.name, killerTeam: killer.team,
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
      this.io.to(this.channel).emit('loot:snapshot', this.loot.getPublicLootSnapshot());
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
      if (res.container) {
        this.io.to(this.channel).emit('container:state', res.container);
      }
      this.io.to(this.channel).emit('loot:snapshot', this.loot.getPublicLootSnapshot());
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
    }
  }

  private explode(g: ServerGrenadeRecord) {
    if (!isValidGrenadeRecord(g)) return;
    this.io.to(this.channel).emit('explosion', { x: r3(g.pos.x), y: r3(g.pos.y), z: r3(g.pos.z) });
    // Xonadan chiqib ketgan o'yinchining granatasi ham zarar beradi (departed ro'yxatidan olinadi)
    const owner = this.players.get(g.owner) ?? this.departed.get(g.owner);
    if (this.departed.has(g.owner) && !this.grenades.some((o) => o !== g && o.owner === g.owner)) {
      this.departed.delete(g.owner);
    }
    if (!owner || this.phase !== 'playing') return;
    const origin = { x: g.pos.x, y: g.pos.y + 0.15, z: g.pos.z };
    const prevDefer = this.deferWinCheck;
    this.deferWinCheck = true;
    try {
      for (const o of this.players.values()) {
        if (!o.alive) continue;
        if (o !== owner && !this.isEnemy(owner, o)) continue;
        const center = { x: o.pos.x, y: o.pos.y + 1.0, z: o.pos.z };
        const d = vdist(origin, center);
        if (d > GRENADE_RADIUS) continue;
        const blocked = raycastWorld(this.world, origin, vnorm(vsub(center, origin)), d);
        if (blocked && d > 0.5) continue;
        const amount = Math.round(GRENADE_DAMAGE * (1 - d / GRENADE_RADIUS));
        this.damage(o, owner, amount, 'grenade', false, origin);
      }
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
    this.grenades = [];
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

    this.io.to(this.channel).emit('loot:snapshot', this.loot.getPublicLootSnapshot());
    this.rosterDirty = true;
    this.sendRoster();
    this.sendMatch();
    this.systemChat(`Forest Survival — ${roundId}-raund boshlandi! Qurol va buyumlarni konteynerlardan toping.`);
  }

  private handleSurvivalRoundEnd(
    roundId: number,
    winnerId: string | null,
    winnerName: string,
    _winReason: string,
  ): void {
    void roundId;
    if (!this.survival) return;
    this.phase = 'ended';
    this.phaseEndsAt = this.survival.getPhaseEndsAt();
    this.grenades = [];
    this.winner = winnerId ? (winnerName || winnerId) : 'draw';
    for (const p of this.players.values()) {
      resetServerWeaponSwitchState(p);
      p.scoped = false;
      p.authority.clear();
    }
    this.rosterDirty = true;
    this.sendRoster();
    this.sendMatch();
    if (winnerId) {
      this.systemChat(`Raund yakunlandi! G'olib: ${winnerName || winnerId}`);
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
    this.grenades = [];
    const roundLootSeed = ((this.secretLootSeed + roundId * 104729) >>> 0) || 1;
    this.loot.resetForRound(roundId, roundLootSeed);
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
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
    this.grenades = [];
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
        x: r3(p.pos.x), y: r3(p.pos.y), z: r3(p.pos.z),
        vx: r3(p.vel.x), vy: r3(p.vel.y), vz: r3(p.pos ? p.vel.z : 0),
        yaw: r3(p.yaw), pitch: r3(p.pitch),
        hp: Math.max(0, Math.round(p.hp)),
        alive: p.alive,
        weapon: p.weapon,
        onGround: p.onGround,
        reloading: !!p.reloadWeapon,
        spawnId: p.spawnId,
        lastProcessedInputSeq: p.isBot ? 0 : p.authority.lastProcessedSeq,
        stamina: r3(p.stamina),
        staminaLocked: p.staminaLocked,
      };
      if (this.isSurvival && this.survival) {
        snapP.survivalRole = this.survival.getPlayerRole(p.id);
        snapP.spectateTargetId = this.survival.getSpectateTarget(p.id);
      }
      players.push(snapP);
    }
    const snap: Snapshot = {
      t: r3(t),
      serverTick: this.serverTick,
      roundId: this.loot.getRoundId(),
      players,
      grenades: this.grenades.map((g) => ({ id: g.id, x: r3(g.pos.x), y: r3(g.pos.y), z: r3(g.pos.z) })),
    };
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
        survival: { ...surv, zone: this.getZoneSnap(t) },
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
export function validateMapSpawns(world: WorldDefinition = DEFAULT_WORLD): string[] {
  const bad: string[] = [];
  for (const s of world.spawnPoints) {
    if (!isSpawnPointSafe(world, s)) bad.push(`${s.team} (${s.x}, ${s.z})`);
  }
  return bad;
}
