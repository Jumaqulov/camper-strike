import type { GameMode, Team } from './constants';
import type { Vec3 } from './math';
import type { SurvivalPhase, SurvivalPlayerRole, SurvivalStateSnap, SurvivalWinReason } from './survival';
import type { WeaponId } from './weapons';
import type { MapId, WorldMeta } from './world';

// ---------- Lobby ----------
export interface RoomInfo {
  id: string;
  name: string;
  mode: GameMode;
  players: number;
  bots: number;
  maxPlayers: number;
  timeLimit: number; // daqiqa
  scoreLimit: number;
  world: WorldMeta;
  /** Stage 06 opt-in unarmed start + server-authoritative loot preview mode. */
  lootPreview?: boolean;
  /** Stage 07 authoritative flag indicating whether container looting is enabled in this room. */
  lootEnabled?: boolean;
  /** Current round ID (Stage 07+). */
  roundId?: number;
  /** Current room phase (Stage 07+). */
  phase?: SurvivalPhase;
  /** Survival: boshlash uchun kerakli odamlar soni. */
  minHumans?: number;
}

export interface CreateRoomOpts {
  name: string;
  mode: GameMode;
  bots: number;
  maxPlayers: number;
  timeLimit: number;
  scoreLimit: number;
  mapId?: MapId;
  publicLayoutSeed?: number;
  /** Stage 06 opt-in unarmed start + server-authoritative loot preview mode. */
  lootPreview?: boolean;
  /** Optional survival pre-round countdown duration override in seconds (Stage 07+). */
  countdownSec?: number;
  /** Survival: raund boshlanishi uchun kerakli tayyor odamlar soni (botlar hisobga olinmaydi), standart 1. */
  minHumans?: number;
}

export interface WelcomeMsg {
  you: string;
  room: RoomInfo;
  world: WorldMeta;
}

export interface ReadyMsg {
  world: WorldMeta;
}

export interface ReadyAck {
  ok: boolean;
  error?: string;
  serverWorld?: WorldMeta;
}

// ---------- Server -> Client ----------
export interface PlayerSnap {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  weapon: WeaponId | null;
  onGround: boolean;
  reloading: boolean;
  /** Current authoritative spawnId for this player (Stage 05+). */
  spawnId?: number;
  /** Highest input sequence number processed by the server for this spawnId (Stage 05+). */
  lastProcessedInputSeq?: number;
  /** Sprint chidamliligi 0..1 (avtoritativ; klient bashorati shu bilan sinxronlanadi). */
  stamina?: number;
  staminaLocked?: boolean;
  /** Survival roli (forest_survival rejimi, Stage 07+). */
  survivalRole?: SurvivalPlayerRole;
  spectateTargetId?: string | null;
  /** Modelda ko'rinadigan jihozlar (kaska, nimcha, granata/aptechka soni) — `packGearState` bit maydoni. */
  gear?: number;
}

export interface GearVisualState {
  helmet: boolean;
  armor: boolean;
  /** 0..3 */
  grenades: number;
  /** 0..3 */
  medkits: number;
}

/** Jihoz holatini 6 bitga joylaydi: bit0 kaska, bit1 nimcha, bit2-3 granata (0..3), bit4-5 aptechka (0..3). */
export function packGearState(g: GearVisualState): number {
  const gr = Math.max(0, Math.min(3, Math.round(g.grenades)));
  const md = Math.max(0, Math.min(3, Math.round(g.medkits)));
  return (g.helmet ? 1 : 0) | (g.armor ? 2 : 0) | (gr << 2) | (md << 4);
}

export function unpackGearState(v: number | undefined): GearVisualState {
  const n = v ?? 0;
  return { helmet: (n & 1) !== 0, armor: (n & 2) !== 0, grenades: (n >> 2) & 3, medkits: (n >> 4) & 3 };
}

export interface GrenadeSnap {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface Snapshot {
  t: number;
  /** Monotonically increasing authoritative server tick counter (Stage 05+). */
  serverTick?: number;
  /** Current round ID (Stage 07+). */
  roundId?: number;
  players: PlayerSnap[];
  grenades: GrenadeSnap[];
}

export interface InputAckEvent {
  spawnId: number;
  lastProcessedInputSeq: number;
  serverTick: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
}

export interface RosterEntry {
  id: string;
  name: string;
  team: Team;
  isBot: boolean;
  kills: number;
  deaths: number;
  ping: number;
  alive?: boolean;
  survivalRole?: SurvivalPlayerRole;
  placement?: number;
}

export interface MatchState {
  phase: SurvivalPhase;
  timeLeft: number;
  scores: { red: number; blue: number };
  scoreLimit: number;
  mode: GameMode;
  winner: string;
  winnerId?: string | null;
  roundId?: number;
  aliveCount?: number;
  totalContenders?: number;
  readyCount?: number;
  minPlayers?: number;
  winReason?: SurvivalWinReason;
  survival?: SurvivalStateSnap;
}

export interface ShotEvent {
  shooter: string;
  weapon: WeaponId;
  origin: Vec3;
  ends: Vec3[];
}

export interface HurtEvent {
  attacker: string;
  damage: number;
  from: Vec3;
  headshot: boolean;
}

export interface HitConfirm {
  target: string;
  damage: number;
  headshot: boolean;
  kill: boolean;
}

export interface KillEvent {
  killer: string;
  killerName: string;
  killerTeam: Team;
  victim: string;
  victimName: string;
  victimTeam: Team;
  /** 'zone' — xavfsiz zonadan tashqarida qolib halok bo'ldi (qotil = qurbon). */
  weapon: WeaponId | 'grenade' | 'zone';
  headshot: boolean;
}

export interface SpawnEvent {
  spawnId: number;
  roundId?: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  team: Team;
  /** Authoritative initial equipped weapon on spawn (`null` in Stage 06 lootPreview / Stage 07 forest_survival). */
  weapon?: WeaponId | null;
  /** Whether the room is running Stage 06 unarmed start + loot preview. */
  lootPreview?: boolean;
  /** Whether server-authoritative looting is enabled in this room (Stage 07+). */
  lootEnabled?: boolean;
}

export interface AmmoEvent {
  weapon: WeaponId;
  mag: number;
  reserve: number;
}

export interface ChatMsg {
  name: string;
  text: string;
  team: Team;
  system: boolean;
}

export interface ExplosionEvent {
  x: number;
  y: number;
  z: number;
}

// ---------- Client -> Server ----------
/**
 * Stage 05 input-only movement command sent from client to server.
 * Client never sends authoritative position or velocity; server simulates movement.
 */
export interface PlayerInputCmd {
  /** Monotonically increasing sequence number per spawn (1, 2, 3, ...). */
  seq: number;
  /** Must match current authoritative player spawnId on server. */
  spawnId: number;
  /** Step duration in seconds (clamped on server to [MIN_INPUT_DT, MAX_INPUT_DT]). */
  dt: number;
  /** Forward/backward intent in [-1, 1] (+1 = forward, -1 = backward). */
  moveForward: number;
  /** Right/left strafe intent in [-1, 1] (+1 = right, -1 = left). */
  moveRight: number;
  /** Jump key state. */
  jump: boolean;
  /** Shift modifier state = SPRINT (oldinga tez yugurish). Protokol mosligi uchun maydon nomi `walk` saqlangan. */
  walk: boolean;
  /** Sniper scope state (reduces move speed when weapon === 'sniper'). */
  scoped: boolean;
  /** Selected weapon slot (`null` when unarmed in Stage 06+). */
  weapon: WeaponId | null;
  /** View yaw in radians. */
  yaw: number;
  /** View pitch in radians (clamped to [-1.55, 1.55]). */
  pitch: number;
  /** Optional client timestamp (ms) for diagnostics only; never trusted for simulation. */
  clientTimeMs?: number;
}

/**
 * Batch of recent unacknowledged input commands for packet-loss resilience.
 */
export interface PlayerInputBatchMsg {
  spawnId: number;
  inputs: PlayerInputCmd[];
  ping?: number;
}

/**
 * @deprecated Legacy pre-Stage 05 client state packet.
 * Server rejects all position/velocity fields from ClientState in Stage 05+.
 */
export interface ClientState {
  spawnId: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
  weapon: WeaponId | null;
  ping: number;
}

export interface ShootMsg {
  weapon: WeaponId;
  origin: Vec3;
  dirs: Vec3[];
}

export type {
  AmmoType,
  ContainerOpenAck,
  ContainerOpenReq,
  ContainerStatus,
  EquipWeaponAck,
  EquipWeaponReq,
  InventoryEntrySnap,
  LootCatalogEntry,
  LootCatalogId,
  LootErrorCode,
  LootItemKind,
  LootPickupAck,
  LootPickupReq,
  PlayerInventorySnap,
  PublicContainerState,
  PublicLootItem,
  RoomLootSnapshot,
  UseMedkitAck,
  UseMedkitReq,
} from './loot';

export type {
  SurvivalConfig,
  SurvivalPhase,
  SurvivalPlayerRole,
  SurvivalPlayerStatusSnap,
  SurvivalRoundEvaluation,
  SurvivalStateSnap,
  SurvivalWinReason,
} from './survival';
