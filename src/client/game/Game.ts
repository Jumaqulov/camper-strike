import * as THREE from 'three';
import type { Socket } from 'socket.io-client';
import { EYE_HEIGHT, RESPAWN_TIME, WALK_SPEED, isSurvivalMode, type GameMode, type Team } from '../../shared/constants';
import { angleDiff, clamp, lerp, type Vec3 } from '../../shared/math';
import { MAX_INPUT_BATCH_SIZE } from '../../shared/netMovement';
import { computeCameraClearDistance, rayBox, raycastWorld, rayVsPlayer } from '../../shared/physics';
import {
  FLARE_ERROR_MESSAGES_UZ,
  NIGHT_REVIVE_RANGE_M,
  NIGHT_REVIVE_SEC,
  REVIVE_ERROR_MESSAGES_UZ,
  WOLF_HEIGHT,
  WOLF_NAME_UZ,
  WOLF_RADIUS,
  isWolfId,
  isWolfThreatState,
  wolfCoatTraits,
  type NightFlareEvent,
  type NightRevivedEvent,
  type NightSupplyDropEvent,
  type ReviveAck,
  type ReviveReq,
  type UseFlareAck,
  type WolfBiteEvent,
  type WolfHowlEvent,
  type WolfSnap,
  type WolfState,
} from '../../shared/wolf';
import { WolfModel, preloadWolfAssets, wolfAudioRangeMul, wolfHowlRevealsPosition, wolfWarningFor, type WolfWarning } from './wolf';
import {
  CAMP_ERROR_MESSAGES_UZ,
  CAMP_INTERACT_RANGE_M,
  CAMPFIRE_LOW_FUEL_SEC,
  TORCH_FUEL_COST_SEC,
  TORCH_WEAPON_MESSAGE_UZ,
  WOOD_CARRY_MAX,
  WOOD_HEAVY_MESSAGE_UZ,
  isTorchWeapon,
  woodBlocksSprint,
} from '../../shared/wolf/camp';
import {
  CampRenderer,
  FlareRenderer,
  SupplyDropRenderer,
  TorchLightPool,
  type CampFireView,
  type CampPileView,
  type TorchProp,
} from './night';
import { DawnTracker, dawnBlendFactor, dawnExposure } from './night/dawnLighting';
import { WolfDepartures, isDawnEnding } from './night/dawnEpilogue';
import {
  DEFAULT_CONTAINER_EXTRA_MARGIN_M,
  GROUND_ITEM_PICKUP_RADIUS_M,
  hasLineOfSightToContainer,
  isWithinInteractionDistance,
  LOOT_ERROR_MESSAGES_UZ,
} from '../../shared/loot';
import type {
  AmmoEvent, CampActionAck, CampfireEvent, ChatMsg, ContainerOpenAck, ContainerOpenReq, EquipWeaponAck, EquipWeaponReq,
  ExplosionEvent, FeedFireReq, HitConfirm, HurtEvent, KillEvent, LootPickupAck, LootPickupReq, MatchState, PlayerInputBatchMsg,
  PlayerInventorySnap, PlayerSnap, PublicContainerState, PublicLootItem, RosterEntry, RoomLootSnapshot, ShootMsg, ShotEvent,
  Snapshot, SpawnEvent, TakeTorchReq, TakeWoodReq, UseMedkitAck, UseMedkitReq, WelcomeMsg,
} from '../../shared/protocol';
import { unpackGearState } from '../../shared/protocol';
import { ALL_WEAPON_IDS, KNIFE, KNIFE_SLOT_KEY, WEAPONS, WEAPON_SLOTS, isMeleeWeapon, type WeaponId } from '../../shared/weapons';
import {
  createTechnicalTerrainFixture,
  createWorldDefinition,
  extractWorldMeta,
  sampleTerrainHeight,
  type WorldDefinition,
  type WorldMeta,
} from '../../shared/world';
import { saveSettings, type QualityLevel, type Settings } from '../settings';
import { wolfVoiceMood, type AudioSys } from './Audio';
import { Effects } from './Effects';
import { buildGrenadeModel, buildGun } from './GunModels';
import { esc, Hud, weaponBadgeHtml } from './Hud';
import { MiniMap, type MiniMapMarker } from './MiniMap';
import { ZoneWall } from './survival/ZoneWall';
import { createLootPrewarmGroup } from './loot/LootWorldRenderer';
import { createGearPrewarmGroup } from './character/CharacterGear';
import { interpolateSurvivalZone, isOutsideSurvivalZone, type SurvivalZoneSnap } from '../../shared/survival';
import { detectSurface } from './surface';
import { Input } from './Input';
import { LocalPlayer } from './LocalPlayer';
import { InventoryUI, LootUI, LootWorldRenderer } from './loot';
import {
  type FireIndicatorInput,
  type SpectatableTarget,
  type SpectatorCameraPose,
  SpectatorController,
  SurvivalUI,
  bearingToward,
  pickCampWarningFire,
} from './survival';
import { colorFor, Stickman } from './Stickman';
import { ViewModel } from './ViewModel';
import { computeFairThirdPersonCameraDist } from './ForestRenderer';
import { buildWorld, type WorldHandles } from './World';
import { CollisionDebugOverlay } from './debug/CollisionDebugOverlay';
import {
  installDevGameTools,
  type BenchCaptureState,
  type DevGameHooks,
  type DevSyntheticInput,
  type NetSimConfig,
} from './debug/DevGameTools';
import { TP_MAX_DIST_LOCAL, TP_SHOULDER_OFFSET, TP_SHOULDER_PAD } from './cameraConstants';
import { createBrowserGuard, type BrowserGuard } from './BrowserGuard';

/** Minimal shape of the ground-cover stats exposed (optionally) by the forest world handle (Stage 08-FIX, agent E). */
interface GroundCoverStatsLite {
  visibleGrass?: number;
  visibleFlowers?: number;
  visibleFerns?: number;
  visibleChunks?: number;
  totalInstances?: number;
  drawCalls?: number;
}
type WorldHandlesWithGroundCover = WorldHandles & {
  getGroundCoverStats?: () => GroundCoverStatsLite | null | undefined;
};

const INTERP_DELAY = 0.1;
const SEND_INTERVAL = 1 / 30;
/** Tong otguncha: uvlash belgisi mini-xaritada shuncha soniya so'nib boradi (HUD indikatori bilan bir xil). */
const HOWL_MARK_SEC = 3;
/** O'tirib yurganda qadam tovushi balandligi ko'paytuvchisi: lokal o'yinchi / masofaviy o'yinchilar. */
const CROUCH_STEP_VOLUME_LOCAL = 0.35;
const CROUCH_STEP_VOLUME_REMOTE = 0.3;
/** O'tirib yurganda qadamlar orasidagi vaqt, s (oddiy yurish — 0.44). */
const CROUCH_STEP_INTERVAL = 0.55;
/** wolf_night: yiqilgan o'yinchining kamera ko'z balandligi (oyoqdan, m) — yerda yotgan nigoh. */
const DOWNED_EYE_HEIGHT = 0.6;

interface Remote {
  id: string;
  name: string;
  team: Team;
  model: Stickman;
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  hp: number;
  weapon: WeaponId | null;
  alive: boolean;
  /** O'tirgan holat — yangiroq (bracketing) snapshot'dan; xitboks va model pozasi uchun. */
  crouched: boolean;
  /** wolf_night: yiqilgan (yotadi, ⛑ belgisi; [E] bilan turg'iziladi) va turg'izish jarayoni (0..1, bo'lmasa null). */
  downed: boolean;
  reviveK: number | null;
  speed: number;
  stepTimer: number;
  tagKey: string;
}

interface BufferedSnap {
  t: number;
  s: Snapshot;
  map: Map<string, PlayerSnap>;
  wolves: Map<string, WolfSnap> | null;
}

/** Klientdagi bo'ri (server snapshotlaridan interpolyatsiya qilinadi). */
interface WolfRemote {
  id: string;
  model: WolfModel;
  /** Rang varianti = bo'ri turi (`wolfCoatTraits`); o'zgarsa model qayta quriladi. */
  coat: number;
  pos: THREE.Vector3;
  yaw: number;
  state: WolfState;
  targetId: string | null;
  alive: boolean;
  speed: number;
  /** Irillash ovozi oxirgi marta chalingan vaqt (spam bo'lmasin). */
  growlAt: number;
  stepTimer: number;
}

const $ = (id: string) => document.getElementById(id)!;
const v3 = (v: Vec3) => new THREE.Vector3(v.x, v.y, v.z);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => void;

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private world: WorldHandles;
  private input: Input;
  /** Brauzer yorliqlaridan himoya: "chiqasizmi?" tasdig'i, ixtiyoriy to'liq ekran + Keyboard Lock. */
  private browserGuard!: BrowserGuard;
  private hud = new Hud();
  private fx: Effects;
  private vm: ViewModel;
  private me = new LocalPlayer();
  private myModel: Stickman;
  private thirdPerson = true;
  private myName: string;
  private remotes = new Map<string, Remote>();
  private wolves = new Map<string, WolfRemote>();
  private roster: RosterEntry[] = [];
  private snaps: BufferedSnap[] = [];
  private grenadeMeshes = new Map<number, THREE.Object3D>();
  private match: MatchState | null = null;
  private readonly myId: string;
  private readonly roomId: string;
  private readonly mode: GameMode;
  private readonly isSurvival: boolean;
  /** "Tong otguncha" (wolf_night): tun vizuallari, to'lqin ma'lumoti, tong/bo'rilar natija ekranlari. */
  private readonly isNight: boolean;
  worldDef: WorldDefinition;
  private raf = 0;
  private last = performance.now();
  private sendAcc = 0;
  private lastSentSeq = 0;
  private lastAuthoritativeSnap: PlayerSnap | null = null;
  private lastServerTick = 0;
  private netSim: NetSimConfig = { rttMs: 0, jitterMs: 0, dropRate: 0 };
  private netSimTimers: number[] = [];
  private devSyntheticInput: DevSyntheticInput | null = null;
  private ping = 0;
  private pingTimer = 0;
  private disposed = false;
  private chatOpen = false;
  private shake = 0;
  private recoilPitch = 0;
  private camY = EYE_HEIGHT;
  private deathAt = 0;
  private deathKiller = '';
  private stepTimer = 0;
  private fov: number;
  /** Q uchun oldingi qurol; qurolsiz boshlanganda (loot rejimi) null — aks holda Q "qurol yo'q" xatosini chiqaradi. */
  private prevWeapon: WeaponId | null = null;
  /** Jamoa almashtirish so'rovi yuborilgan vaqt (o'lim ekranida "o'ldirildi" o'rniga mos matn uchun). */
  private teamSwitchAt = -99;
  /** Lokal qurol almashtirish vaqti: eskirgan inventory:state qurolni orqaga qaytarmasligi uchun. */
  private lastLocalSwitchAt = -99;
  private maxDpr = 2;
  private miniMap: MiniMap | null = null;
  /** Survival xavfsiz zona: oxirgi server snapshoti, uning kelgan vaqti va dunyo devori. */
  private zoneSnap: SurvivalZoneSnap | null = null;
  private zoneSnapAt = 0;
  private zoneWall: ZoneWall | null = null;
  /** "Tong otguncha" lageri: gulxanlar/o'tin g'aramlari renderi (faqat tun rejimida). */
  private camp: CampRenderer | null = null;
  /** Tong otishi (tun rejimi): match yangilanishlari orasida silliqlangan daraja; tong xori bir marta chalinadi. */
  private dawn = new DawnTracker();
  private dawnChorusDone = false;
  /** Tong otgach snapshotdan chiqqan (o'rmonga qochgan) bo'rilar: birdan yo'qolmaydi — yugurib so'nadi. */
  private wolfDepartures = new WolfDepartures(
    (x, z) => sampleTerrainHeight(this.worldDef.terrain, x, z),
    (x, y, z, dx, dz, dist) => raycastWorld(this.worldDef, { x, y: y + 0.6, z }, { x: dx, y: 0, z: dz }, dist) !== null,
  );
  /** [E] nishoni — eng yaqin gulxan yoki o'tin g'arami (konteynerdan ustun, agar yaqinroq bo'lsa). */
  private campTarget: { kind: 'pile' | 'fire'; id: string } | null = null;
  /** Lager amali so'rovi yuborilgan, ack kutilmoqda (ikki marta bosilmasin). */
  private campBusy = false;
  /**
   * wolf_night mash'al: qo'ldagi mash'alning qolgan vaqti (serverdan, snapshot; ack bilan darhol yangilanadi),
   * [F] nishoni (yonib turgan gulxan — olish; mash'al bo'lsa — tashlash), yoritgich hovuzi va "og'ir yuk" toast vaqti.
   */
  private myTorchSec = 0;
  private myTorchAt = 0;
  private torchTarget: { kind: 'take'; fireId: string } | { kind: 'drop' } | null = null;
  private torchLights: TorchLightPool | null = null;
  private torchCrackleId = '';
  private heavyHintAt = -99;
  /**
   * wolf_night: signal raketalari (FlareRenderer — hodisa + NightSnap.flares) va yarim tungi yordam yuki
   * (SupplyDropRenderer — hodisa + NightSnap.supply); [X] so'rovi yuborilgan, ack kutilmoqda.
   */
  private flareFx: FlareRenderer | null = null;
  private supplyFx: SupplyDropRenderer | null = null;
  private flareBusy = false;
  /**
   * wolf_night yiqilgan holat (serverdan, snapshot): harakat/qurol/[E] yo'q, kamera pastda, banner.
   * `myDownedView` — kamera ko'z balandligi uchun silliqlangan 0..1.
   */
  private myDowned = false;
  private myBleedSec = 0;
  private myReviveK: number | null = null;
  private myDownedView = 0;
  /** [E] nishoni — turg'izish uchun yaqin yiqilgan sherik (gulxan/g'aram/konteynerdan ustun). */
  private reviveTarget: { id: string; name: string; reviveK: number | null } | null = null;
  private reviveBusy = false;
  /** Shader/tekstura isitish guruhi (bir necha kadr chiziladi, keyin olib tashlanadi) va kadr hisoblagichi. */
  private prewarmGroup: THREE.Group | null = null;
  private prewarmFrames = 0;
  /** Prewarm uchun qurilgan qurollar va zona devori — guruh olib tashlanganda bo'shatiladi (finishPrewarm). */
  private prewarmGuns: THREE.Object3D[] = [];
  private prewarmWall: ZoneWall | null = null;
  private frameNo = 0;
  /** Avtomatik sifat nazorati (kuchsiz GPU): kadr vaqti yig'indisi va ketma-ket "yomon" soniyalar. */
  private perfAccumMs = 0;
  private perfFrames = 0;
  private perfBadSec = 0;
  private perfGraceUntil = 0;
  private perfLowRes = false;
  private perfAutoDone = false;
  private readonly lootPreview: boolean;
  private lootUi: LootUI;
  private inventoryUi: InventoryUI;
  private lootWorld: LootWorldRenderer;
  private survivalUi: SurvivalUI;
  private spectator = new SpectatorController();
  private lastSpectatorPose: SpectatorCameraPose | null = null;
  /** wolf_night: so'nggi uvlashlar (mini-xarita belgilari, HOWL_MARK_SEC ichida o'chadi). */
  private howlMarks: { x: number; z: number; at: number }[] = [];
  private lootSnapshot: RoomLootSnapshot | null = null;
  private inventorySnap: PlayerInventorySnap | null = null;
  private lootReqSeq = 0;
  private lastPhase = 'playing';
  /** Survival `ended` fazasida server harakatni qabul qilmaydi — klient ham bashorat qilmasligi kerak. */
  private movementFrozen = false;
  private sbNext = 0;
  private sbShown = false;
  private netHandlers: [string, AnyFn][] = [];
  private domHandlers: [EventTarget, string, EventListener][] = [];
  private tmp = new THREE.Vector3();
  private devFrames = 0;
  private devElapsed = 0;
  private devFps = 0;
  private devFrameMs = 0;
  private lastRenderStats = {
    calls: 0,
    sceneCalls: 0,
    vmCalls: 0,
    triangles: 0,
    sceneTris: 0,
    vmTris: 0,
    geometries: 0,
    textures: 0,
  };
  /** Benchmark yozuvi (DEV asboblari boshqaradi, kadr sikli to'ldiradi). */
  private bench: BenchCaptureState = { capturing: false, startMs: 0, frameTimesMs: [], cullTimesMs: [], gpuTimesMs: [] };
  private uninstallDevTools: (() => void) | null = null;
  private gpuTimerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private pendingGpuQueries: WebGLQuery[] = [];
  private collisionDebug: CollisionDebugOverlay | null = null;

  constructor(
    private root: HTMLElement,
    private socket: Socket,
    welcome: WelcomeMsg,
    private audio: AudioSys,
    private settings: Settings,
    private onLeave: () => void,
  ) {
    this.myId = welcome.you;
    this.roomId = welcome.room.id;
    this.mode = welcome.room.mode;
    this.isSurvival = isSurvivalMode(this.mode);
    this.isNight = this.mode === 'wolf_night';
    this.lootPreview = this.isSurvival || Boolean(welcome.room.lootPreview);
    this.myName = settings.name;
    this.worldDef = createWorldDefinition({
      mapId: welcome.world.mapId,
      worldVersion: welcome.world.worldVersion,
      publicLayoutSeed: welcome.world.publicLayoutSeed,
    });
    this.me.setWorld(this.worldDef);
    this.me.setLootPreview(this.lootPreview);
    const aspect = window.innerWidth / window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Tunda ("Tong otguncha") ekspozitsiya pastroq — oy nuri va lampalar kontrasti saqlanadi
    this.renderer.toneMappingExposure = this.isNight ? 0.9 : 1.05;
    this.renderer.autoClear = false;
    root.appendChild(this.renderer.domElement);
    try {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      this.gpuTimerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
        TIME_ELAPSED_EXT: number;
        GPU_DISJOINT_EXT: number;
      } | null;
    } catch {
      this.gpuTimerExt = null;
    }

    this.fov = settings.fov;
    this.camera = new THREE.PerspectiveCamera(this.fov, aspect, 0.05, 1500);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.world = buildWorld(this.scene, this.worldDef, settings.quality, this.isNight ? 'night' : 'day');
    this.applyQualityRendererSettings(settings.quality);
    this.detectWeakGpu();
    this.fx = new Effects(this.scene);
    this.fx.groundAt = (x, z) => sampleTerrainHeight(this.worldDef.terrain, x, z);
    this.vm = new ViewModel(aspect);
    if (this.isNight) this.vm.setNight(true);
    this.myModel = new Stickman(colorFor('red', this.myId));
    const initialWeapon: WeaponId | null = this.lootPreview ? null : 'rifle';
    if (!this.lootPreview) this.prevWeapon = 'pistol';
    this.vm.setWeapon(initialWeapon);
    this.myModel.setWeapon(initialWeapon);
    this.myModel.setNameTag(this.myName, '#ffe082', false);
    this.scene.add(this.myModel.root);
    // Xonada bo'ri bo'lsa (Tong otguncha — to'lqinlar, room.wolves = 0) barcha rang variantlarini oldindan
    // yuklaymiz (birinchi bo'ri ko'ringanda zaxira ko'rinmasin)
    if (welcome.room.wolves || this.isNight) void preloadWolfAssets();

    this.lootWorld = new LootWorldRenderer(
      this.scene,
      this.worldDef,
      this.world.stage04a?.containers ?? null,
    );
    // Lager: PointLight'lar prewarm'dan OLDIN sahnada bo'lsin (yorug'lik soni o'zgarsa shaderlar qayta kompilyatsiya bo'ladi)
    if (this.isNight) {
      this.camp = new CampRenderer(this.scene);
      this.torchLights = new TorchLightPool(this.scene);
      // Raketa va yordam yuki yoritgichlari ham prewarm'dan oldin (yorug'lik soni o'zgarmasin)
      this.flareFx = new FlareRenderer(this.scene);
      this.supplyFx = new SupplyDropRenderer(this.scene);
    }
    this.lootUi = new LootUI({
      onOpenContainer: (containerId) => {
        void this.requestOpenContainer(containerId);
      },
      onPickupItem: (containerId, itemId) => {
        void this.requestPickupItem(containerId, itemId);
      },
      onClosePanel: () => {
        this.lootUi.setActiveContainer(null);
      },
    });
    this.inventoryUi = new InventoryUI({
      onSelectWeapon: (w) => {
        void this.requestEquipWeapon(w);
      },
      onUseMedkit: () => {
        void this.requestUseMedkit();
      },
      onUseFlare: () => {
        void this.requestUseFlare();
      },
    });
    this.inventoryUi.setVisible(this.lootPreview);
    // Tunda o'tin chipi boshidan ko'rinadi (0/3) — o'yinchi mexanikani darhol payqaydi
    if (this.isNight) this.inventoryUi.setWood(0);
    try {
      this.miniMap = new MiniMap(this.worldDef, $('minimap-wrap'));
    } catch (err) {
      console.warn('[MiniMap] yaratib bo‘lmadi:', err);
      this.miniMap = null;
    }
    this.survivalUi = new SurvivalUI({
      onCycleSpectatorTarget: (delta) => {
        this.spectator.cycleTarget(delta, this.getSpectatableTargets());
      },
      onToggleCameraPerspective: () => {
        this.thirdPerson = !this.thirdPerson;
      },
    });
    this.survivalUi.setMode(this.mode);
    this.survivalUi.setVisible(this.isSurvival);
    this.input = new Input(this.renderer.domElement);
    // root — butun hujjat: to'liq ekranda HUD, pauza menyusi va chat ham ko'rinsin
    this.browserGuard = createBrowserGuard({ input: this.input, root: document.documentElement, settings: this.settings });
    this.input.onLockChange = () => {
      if (!this.input.locked && this.chatOpen) this.closeChat();
      this.updatePauseMenu();
    };
    this.audio.setVolume(settings.volume);
    // Ambient fon: o'rmon xaritalarida faqat qushlar (shamol va barg shovqini foydalanuvchi so'rovi bilan olib tashlangan).
    // "Tong otguncha" tunida qushlar sayramaydi — ular tong otganda qaytadi (updateDawn)
    this.audio.startAmbient(this.isNight ? 'night' : 'forest');

    this.hud.reset();
    this.hud.show(true);
    this.hud.setLayout(this.isSurvival, this.lootPreview);
    this.startPrewarm();
    this.hud.setTeamBadge('none', this.mode);
    $('pause-room-name').textContent = welcome.room.name;
    $('top-bar').querySelectorAll('.score').forEach((e) => ((e as HTMLElement).className = 'score ' + e.id.replace('score-', '')));

    this.bindNet();
    this.bindDom();
    this.updatePauseMenu();
    this.pingTimer = window.setInterval(() => this.measurePing(), 2000);
    this.measurePing();
    if (import.meta.env.DEV) {
      // 08-FIX: F9 collision debug overlay (DEV only — never constructed in production builds)
      this.collisionDebug = new CollisionDebugOverlay(this.scene, document.body);
      // DEV asboblari (window.__DEV_GAME_TOOLS__) — alohida modul, Game faqat tor ko'prik beradi
      this.uninstallDevTools = installDevGameTools(this.devHooks());
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  getWorldMeta(): WorldMeta {
    return extractWorldMeta(this.worldDef);
  }

  /** DEV asboblari (debug/DevGameTools.ts) uchun tor ko'prik: faqat ularga kerakli ichki holat va amallar. */
  private devHooks(): DevGameHooks {
    return {
      getBrowserGuardState: () => this.browserGuard.diagnostics(),
      scene: this.scene,
      camera: this.camera,
      socket: this.socket,
      me: this.me,
      vm: this.vm,
      myModel: this.myModel,
      settings: this.settings,
      roomId: this.roomId,
      isSurvival: this.isSurvival,
      lootPreview: this.lootPreview,
      lootUi: this.lootUi,
      inventoryUi: this.inventoryUi,
      lootWorld: this.lootWorld,
      survivalUi: this.survivalUi,
      spectator: this.spectator,
      bench: this.bench,
      gpuTimerSupported: Boolean(this.gpuTimerExt),
      getWorld: () => this.world,
      getWorldDef: () => this.worldDef,
      getWorldMeta: () => this.getWorldMeta(),
      loadTechnicalTerrainFixture: () => {
        this.world.dispose();
        const techWorld = createTechnicalTerrainFixture();
        this.worldDef = techWorld;
        this.world = buildWorld(this.scene, techWorld, this.settings.quality, this.isNight ? 'night' : 'day');
        this.me.setWorld(techWorld);
        const sp = techWorld.spawnPoints[0];
        this.me.body.pos = { x: sp.x, y: sp.y, z: sp.z };
        this.me.body.vel = { x: 0, y: 0, z: 0 };
        this.me.body.onGround = true;
        this.me.yaw = sp.yaw;
        this.me.pitch = 0;
        this.camY = sp.y + EYE_HEIGHT;
        return extractWorldMeta(techWorld);
      },
      applyQuality: (q) => {
        this.settings.quality = q;
        saveSettings(this.settings);
        this.applyQualityRendererSettings(q);
        this.world.setQuality?.(q);
      },
      getRenderStats: () => this.lastRenderStats,
      pinDevOverlay: (fps, frameMs) => {
        this.devFps = fps;
        this.devFrameMs = frameMs;
        this.devFrames = 0;
        this.devElapsed = -5.0; // Hold pinned benchmark display for 5s while screenshot is captured
      },
      getThirdPerson: () => this.thirdPerson,
      setThirdPerson: (tp) => {
        this.thirdPerson = tp;
      },
      setPrevWeapon: (w) => {
        this.prevWeapon = w;
      },
      setCamY: (y) => {
        this.camY = y;
      },
      getPing: () => this.ping,
      getMatch: () => this.match,
      getLastAuthoritativeSnap: () => this.lastAuthoritativeSnap,
      getNetSim: () => this.netSim,
      setNetSim: (v) => {
        this.netSim = v;
      },
      setSyntheticInput: (v) => {
        this.devSyntheticInput = v;
      },
      getLootSnapshot: () => this.lootSnapshot,
      getInventorySnap: () => this.inventorySnap,
      getRemotes: () => this.remotes.values(),
      getWolves: () => this.wolves.values(),
      getCollisionDebug: () => this.collisionDebug,
      getSpectatableTargets: () => this.getSpectatableTargets(),
      sendInput: () => this.sendInput(),
      fireLocal: (t) => this.fireLocal(t),
      requestOpenContainer: (containerId, requestId) => this.requestOpenContainer(containerId, requestId),
      requestPickupItem: (containerId, itemId, requestId) => this.requestPickupItem(containerId, itemId, requestId),
      requestEquipWeapon: (weapon, requestId) => this.requestEquipWeapon(weapon, requestId),
      requestUseMedkit: (requestId) => this.requestUseMedkit(requestId),
      onLootSnapshot: (snap) => this.onLootSnapshot(snap),
      onInventoryState: (inv) => this.onInventoryState(inv),
    };
  }

  private getSpectatableTargets(): SpectatableTarget[] {
    const out: SpectatableTarget[] = [];
    const last = this.snaps[this.snaps.length - 1];
    for (const rem of this.remotes.values()) {
      const snapP = last?.map.get(rem.id);
      if (snapP?.survivalRole === 'spectator' || snapP?.survivalRole === 'eliminated') {
        continue;
      }
      out.push({
        id: rem.id,
        name: rem.name,
        pos: { x: rem.pos.x, y: rem.pos.y, z: rem.pos.z },
        yaw: rem.yaw,
        pitch: rem.pitch,
        hp: rem.hp,
        alive: rem.alive,
        weapon: rem.weapon,
        crouched: rem.crouched,
      });
    }
    return out;
  }

  private applyQualityRendererSettings(q: QualityLevel): void {
    const maxDpr = q === 'low' ? (this.perfLowRes ? 0.8 : 1.0) : q === 'medium' ? 1.5 : 2.0;
    this.maxDpr = maxDpr;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxDpr));
    // PCFSoftShadowMap three r186 da olib tashlangan (konsol ogohlantirishi bilan PCF ga tushardi)
    this.renderer.shadowMap.type = q === 'low' ? THREE.BasicShadowMap : THREE.PCFShadowMap;
    // Past sifatda soya xaritasi butunlay o'chadi — integratsiyalangan GPU larda eng katta tejamkorlik.
    const shadows = q !== 'low';
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      // Soya o'zgarganda materiallar qayta kompilyatsiya qilinishi kerak (USE_SHADOWMAP define)
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else m.needsUpdate = true;
      });
    }
  }

  /**
   * Kuchsiz GPU aniqlash: dasturiy renderer (SwiftShader/llvmpipe) bo'lsa darhol past sifat + 0.8 DPR.
   * Qolgan hollarda avtomatik nazorat (trackPerformance) real FPS bo'yicha qaror qiladi.
   */
  private detectWeakGpu(): void {
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      if (/swiftshader|llvmpipe|software|basic render|mesa offscreen/i.test(name)) {
        this.perfLowRes = true;
        this.perfAutoDone = true;
        this.settings.quality = 'low';
        this.applyQualityRendererSettings('low');
        this.world.setQuality?.('low');
        saveSettings(this.settings);
        const sel = document.getElementById('set-quality') as HTMLSelectElement | null;
        if (sel) sel.value = 'low';
      }
    } catch {
      /* e'tibor bermaymiz */
    }
  }

  /**
   * Avtomatik sifat: o'yin davomida o'rtacha kadr vaqti 4 soniya davomida 30 ms dan oshsa (<33 FPS),
   * sifat bir pog'ona pasaytiriladi (yuqori → o'rta → past → past + 0.8 DPR). Hech qachon oshirilmaydi,
   * foydalanuvchi sozlamasi saqlanadi. Sozlamalardagi "Avtomatik sifat" bilan o'chiriladi.
   */
  private trackPerformance(frameMs: number, nowMs: number): void {
    if (this.perfAutoDone || this.settings.autoQuality === false) return;
    if (this.perfGraceUntil === 0) this.perfGraceUntil = nowMs + 6000; // yuklanish/kompilyatsiya davri
    if (nowMs < this.perfGraceUntil || document.hidden || !this.input.locked) {
      this.perfAccumMs = 0;
      this.perfFrames = 0;
      return;
    }
    this.perfAccumMs += Math.min(frameMs, 250);
    this.perfFrames++;
    if (this.perfAccumMs < 1000) return;
    const avg = this.perfAccumMs / this.perfFrames;
    this.perfAccumMs = 0;
    this.perfFrames = 0;
    if (avg > 30) this.perfBadSec++;
    else this.perfBadSec = Math.max(0, this.perfBadSec - 1);
    if (this.perfBadSec < 4) return;
    this.perfBadSec = 0;
    this.perfGraceUntil = nowMs + 4000;

    const q = this.settings.quality;
    let next: QualityLevel | null = null;
    if (q === 'high') next = 'medium';
    else if (q === 'medium') next = 'low';
    else if (!this.perfLowRes) {
      this.perfLowRes = true;
      next = 'low';
      this.perfAutoDone = true;
    } else {
      this.perfAutoDone = true;
      return;
    }
    this.settings.quality = next;
    this.applyQualityRendererSettings(next);
    this.world.setQuality?.(next);
    saveSettings(this.settings);
    const sel = document.getElementById('set-quality') as HTMLSelectElement | null;
    if (sel) sel.value = next;
    const label = next === 'medium' ? "O'rta" : this.perfLowRes ? 'Past + kam piksel' : 'Past';
    this.hud.chat({
      name: '',
      team: 'none',
      system: true,
      text: `FPS past (${Math.round(1000 / avg)}): grafika sifati avtomatik "${label}" ga o'tkazildi (Sozlamalar → Avtomatik sifat)`,
    });
  }

  // ================= Tarmoq =================

  private on<T>(ev: string, fn: (d: T) => void) {
    this.socket.on(ev, fn as AnyFn);
    this.netHandlers.push([ev, fn as AnyFn]);
  }

  private bindNet() {
    this.on<Snapshot>('snap', (s) => this.onSnap(s));
    this.on<RosterEntry[]>('roster', (r) => this.onRoster(r));
    this.on<MatchState>('match', (m) => this.onMatch(m));
    this.on<SpawnEvent>('spawn', (e) => this.onSpawn(e));
    this.on<ShotEvent>('shot', (e) => this.onShot(e));
    this.on<HurtEvent>('hurt', (e) => this.onHurt(e));
    this.on<HitConfirm>('hitConfirm', (e) => {
      this.hud.hitmarker(e.headshot, e.kill);
      if (isMeleeWeapon(this.me.weapon)) this.audio.knifeHit();
      this.audio.hitmarker(e.headshot);
      if (e.kill) this.audio.killConfirm();
      if (isWolfId(e.target)) {
        const w = this.wolves.get(e.target);
        if (w) this.fx.bloodHit(w.pos.clone().add(new THREE.Vector3(0, 0.7, 0)), e.kill);
      }
    });
    this.on<WolfHowlEvent>('wolf:howl', (e) => this.onWolfHowl(e));
    this.on<WolfBiteEvent>('wolf:bite', (e) => {
      this.audio.wolfBite({ x: e.x, y: e.y + 0.9, z: e.z }, e.hit);
      if (!e.hit) return;
      const w = this.wolves.get(e.id);
      const mouth = w ? w.model.getMouthWorld(new THREE.Vector3()) : new THREE.Vector3(e.x, e.y + 0.9, e.z);
      this.fx.bloodHit(mouth, true);
      if (e.target === this.myId) this.shake = Math.max(this.shake, 0.6);
    });
    this.on<CampfireEvent>('campfire', (e) => this.onCampfireEvent(e));
    this.on<NightRevivedEvent>('night:revived', (e) => this.onRevived(e));
    this.on<NightSupplyDropEvent>('night:supplyDrop', (e) => this.onSupplyDrop(e));
    this.on<NightFlareEvent>('night:flare', (e) => this.onFlareEvent(e));
    this.on<KillEvent>('kill', (e) => this.onKill(e));
    this.on<ExplosionEvent>('explosion', (e) => this.onExplosion(e));
    this.on<AmmoEvent>('ammo', (e) => {
      this.me.ammo[e.weapon] = { mag: e.mag, reserve: e.reserve };
      if (this.inventorySnap) {
        this.inventorySnap.ammo[e.weapon] = { mag: e.mag, reserve: e.reserve };
        this.inventoryUi.updateInventory(this.inventorySnap);
      }
    });
    this.on<RoomLootSnapshot>('loot:snapshot', (s) => this.onLootSnapshot(s));
    this.on<PublicContainerState>('container:state', (c) => this.onContainerState(c));
    this.on<PlayerInventorySnap>('inventory:state', (inv) => this.onInventoryState(inv));
    this.on<ChatMsg>('chat', (m) => this.hud.chat(m));
  }

  private nextLootReqId(prefix: string): string {
    return `${prefix}_${this.myId}_r${this.me.roundId}_s${this.me.spawnId}_${++this.lootReqSeq}`;
  }

  private onLootSnapshot(s: RoomLootSnapshot) {
    if (this.lootSnapshot) {
      if (s.roundId < this.lootSnapshot.roundId) return;
      if (s.roundId === this.lootSnapshot.roundId && s.version < this.lootSnapshot.version) return;
      if (s.roundId !== this.lootSnapshot.roundId) {
        this.lootUi.clearPendingItems();
        this.lootUi.setActiveContainer(null);
      }
    }
    if (s.roundId > this.me.roundId) {
      this.me.roundId = s.roundId;
    }
    this.lootSnapshot = s;
    this.lootWorld.applyLootSnapshot(s);
    const activeId = this.lootUi.getActiveContainerId();
    if (activeId) {
      const updated = s.containers.find((c) => c.id === activeId) ?? null;
      this.lootUi.setActiveContainer(updated);
    }
    // Yordam yuki (runtime konteyner) ochilgani — mayoq so'nadi
    const supplyId = this.supplyFx?.getId();
    if (supplyId) {
      const sup = s.containers.find((c) => c.id === supplyId);
      if (sup) this.supplyFx!.setOpened(sup.opened);
    }
  }

  private onContainerState(c: PublicContainerState) {
    if (this.lootSnapshot) {
      const idx = this.lootSnapshot.containers.findIndex((x) => x.id === c.id);
      if (idx >= 0) {
        this.lootSnapshot.containers[idx] = c;
      } else {
        this.lootSnapshot.containers.push(c);
      }
      // Versiyani +1 qilmaymiz: ack va broadcast bir xil o'zgarishni ikki marta keltiradi, lokal hisoblagich
      // serverdan o'zib ketib keyingi loot:snapshot lar e'tiborsiz qolardi. Server versiyasi snapshot bilan keladi.
      this.lootSnapshot.version = Math.max(this.lootSnapshot.version, c.version);
      this.lootWorld.applyLootSnapshot(this.lootSnapshot);
    }
    if (this.lootUi.getActiveContainerId() === c.id) {
      this.lootUi.setActiveContainer(c);
    }
    if (this.supplyFx && this.supplyFx.getId() === c.id) this.supplyFx.setOpened(c.opened);
  }

  /** Yordam yuki tushdi (server broadcast): ovoz, 6 s banner, parashyut/mayoq animatsiyasi; chat serverdan keladi. */
  private onSupplyDrop(e: NightSupplyDropEvent): void {
    this.supplyFx?.onDrop(e, this.nowSec);
    this.audio.supplyDrop({ x: e.x, y: e.y + 2, z: e.z });
    this.hud.setNightBanner('📦 YORDAM YUKI TUSHDI — xaritaga qarang', 6000);
  }

  /** Signal raketasi otildi (server broadcast): vizual + ovoz; o'zimizniki bo'lsa inventar ack bilan yangilanadi. */
  private onFlareEvent(e: NightFlareEvent): void {
    this.flareFx?.onEvent(e, this.nowSec);
    this.audio.flareLaunch({ x: e.x, y: e.y + 1.5, z: e.z });
    if (e.byId !== this.myId) this.lootUi.showStatus(`🎇 ${e.byName} signal raketasini otdi`, 'info', 2200);
  }

  /** [X] — signal raketasini otish (wolf_night). Server 1 raketa sarflaydi, hamma uchun 'night:flare' yuboradi. */
  private requestUseFlare(): Promise<UseFlareAck | null> {
    if (!this.isNight || this.flareBusy) return Promise.resolve(null);
    const notPlaying = this.match?.phase !== 'playing';
    if (notPlaying || !this.me.alive || this.myDowned) return Promise.resolve(null);
    const have = this.inventorySnap?.flares ?? this.me.flares;
    if (have <= 0) {
      this.lootUi.showStatus(`🎇 ${FLARE_ERROR_MESSAGES_UZ.NO_FLARE} — konteynerlar va yordam yukida bo'ladi`, 'error', 2200);
      return Promise.resolve(null);
    }
    this.flareBusy = true;
    this.sendInput();
    return new Promise((resolve) => {
      this.socket.timeout(3000).emit('night:useFlare', {}, (err: Error | null, ack?: UseFlareAck) => {
        this.flareBusy = false;
        if (this.disposed) return resolve(null);
        if (err || !ack) {
          this.lootUi.showStatus("Server javob bermadi — qayta urinib ko'ring", 'error', 2200);
          return resolve(null);
        }
        if (!ack.ok) {
          if (ack.error) this.lootUi.showStatus(`🎇 ${FLARE_ERROR_MESSAGES_UZ[ack.error] ?? 'Xato'}`, 'error', 2200);
          return resolve(ack);
        }
        this.myModel.playInteract();
        this.me.flares = ack.flares;
        if (this.inventorySnap) {
          this.inventorySnap.flares = ack.flares;
          this.inventoryUi.updateInventory(this.inventorySnap);
        }
        this.lootUi.showStatus(`🎇 Signal raketasi otildi — bo'rilar 20 s qochadi (qoldi: ${ack.flares})`, 'success', 2400);
        resolve(ack);
      });
    });
  }

  private onInventoryState(inv: PlayerInventorySnap) {
    if (inv.playerId !== this.myId) return;
    // Stage 06 Audit Fix #2: Reject stale roundId / spawnId / inventoryVersion snapshots
    if (this.me.roundId > 0 && inv.roundId > 0 && inv.roundId < this.me.roundId) return;
    if (
      this.me.spawnId > 0 &&
      inv.spawnId > 0 &&
      inv.spawnId !== this.me.spawnId &&
      inv.roundId <= this.me.roundId
    ) {
      return;
    }
    if (
      this.inventorySnap &&
      inv.roundId === this.inventorySnap.roundId &&
      inv.spawnId === this.inventorySnap.spawnId &&
      inv.inventoryVersion < this.inventorySnap.inventoryVersion
    ) {
      return;
    }
    const prevWeapon = this.me.weapon;
    this.inventorySnap = inv;
    // Qurol endigina lokal almashtirilgan bo'lsa (ack hali kelmagan), serverning eski qurolni ko'rsatuvchi
    // oraliq inventory:state (reload tugashi, granata) qurolni orqaga "flicker" qilmasin.
    const recentLocalSwitch = performance.now() / 1000 - this.lastLocalSwitchAt < 0.6;
    const keepEquipped = recentLocalSwitch && inv.equippedWeapon !== this.me.weapon;
    this.me.applyInventorySnap(inv, undefined, keepEquipped);
    this.inventoryUi.setVisible(inv.lootPreview || this.lootPreview);
    this.inventoryUi.updateInventory(inv);
    this.vm.setWeapon(this.me.weapon);
    this.myModel.setWeapon(this.me.weapon);
    if (this.me.weapon && this.me.weapon !== prevWeapon) {
      this.prevWeapon = prevWeapon;
      this.vm.startSwitch(WEAPONS[this.me.weapon].switchTime);
    }
  }

  private isStaleAckContext(
    reqRoundId: number,
    reqSpawnId: number,
    ack?: { roundId?: number; spawnId?: number },
  ): boolean {
    if (reqRoundId > 0 && this.me.roundId > 0 && this.me.roundId !== reqRoundId) return true;
    if (reqSpawnId > 0 && this.me.spawnId > 0 && this.me.spawnId !== reqSpawnId) return true;
    if (ack?.roundId !== undefined && this.me.roundId > 0 && ack.roundId < this.me.roundId) return true;
    if (ack?.spawnId !== undefined && this.me.spawnId > 0 && ack.spawnId !== this.me.spawnId) return true;
    return false;
  }

  private requestOpenContainer(containerId: string, customReqId?: string): Promise<ContainerOpenAck> {
    const reqRoundId = this.me.roundId;
    const reqSpawnId = this.me.spawnId;
    const req: ContainerOpenReq = {
      requestId: customReqId ?? this.nextLootReqId('open'),
      containerId,
      roundId: reqRoundId,
      spawnId: reqSpawnId,
    };
    this.sendInput();
    return new Promise<ContainerOpenAck>((resolve) => {
      this.socket.emit('container:open', req, (ack: ContainerOpenAck) => {
        if (this.isStaleAckContext(reqRoundId, reqSpawnId, ack)) {
          resolve(ack);
          return;
        }
        if (ack?.container) {
          this.onContainerState(ack.container);
        }
        if (ack?.inventory) {
          this.onInventoryState(ack.inventory);
        }
        if (ack?.ok && ack.container) {
          this.myModel.playInteract();
          this.lootUi.setActiveContainer(ack.container);
          this.lootUi.showStatus(`${ack.container.labelUz} ochildi`, 'info', 2000);
        } else if (ack && !ack.ok) {
          this.lootUi.showStatus(ack.message ?? LOOT_ERROR_MESSAGES_UZ.INVALID_REQUEST, 'error', 2600);
        }
        resolve(ack);
      });
    });
  }

  private requestPickupItem(
    containerId: string | null,
    itemId: string,
    customReqId?: string,
  ): Promise<LootPickupAck> {
    const reqRoundId = this.me.roundId;
    const reqSpawnId = this.me.spawnId;
    const req: LootPickupReq = {
      requestId: customReqId ?? this.nextLootReqId('pickup'),
      containerId,
      itemId,
      roundId: reqRoundId,
      spawnId: reqSpawnId,
    };
    this.lootUi.markItemPending(itemId, true);
    this.sendInput();
    return new Promise<LootPickupAck>((resolve) => {
      this.socket.emit('loot:pickup', req, (ack: LootPickupAck) => {
        this.lootUi.markItemPending(itemId, false);
        if (this.isStaleAckContext(reqRoundId, reqSpawnId, ack)) {
          resolve(ack);
          return;
        }
        if (ack?.container) {
          this.onContainerState(ack.container);
        }
        if (ack?.inventory) {
          this.onInventoryState(ack.inventory);
        }
        if (ack?.ok && ack.pickedItem) {
          this.audio.switchWeapon();
          this.lootUi.showStatus(`${ack.pickedItem.nameUz} olindi!`, 'success', 2400);
        } else if (ack && !ack.ok) {
          this.lootUi.showStatus(ack.message ?? LOOT_ERROR_MESSAGES_UZ.INVALID_REQUEST, 'error', 2600);
        }
        resolve(ack);
      });
    });
  }

  private requestEquipWeapon(weapon: WeaponId | null, customReqId?: string): Promise<EquipWeaponAck> {
    const reqRoundId = this.me.roundId;
    const reqSpawnId = this.me.spawnId;
    const req: EquipWeaponReq = {
      requestId: customReqId ?? this.nextLootReqId('equip'),
      weapon,
      roundId: reqRoundId,
      spawnId: reqSpawnId,
    };
    return new Promise<EquipWeaponAck>((resolve) => {
      this.socket.emit('inventory:equip', req, (ack: EquipWeaponAck) => {
        if (this.isStaleAckContext(reqRoundId, reqSpawnId, ack)) {
          resolve(ack);
          return;
        }
        if (ack?.inventory) {
          this.onInventoryState(ack.inventory);
        }
        if (ack?.ok) {
          const prev = this.me.weapon;
          this.me.weapon = ack.equippedWeapon;
          if (this.me.weapon !== 'sniper') this.me.scoped = false;
          this.vm.setWeapon(this.me.weapon);
          this.myModel.setWeapon(this.me.weapon);
          if (this.me.weapon && this.me.weapon !== prev) {
            this.prevWeapon = prev;
            this.vm.startSwitch(WEAPONS[this.me.weapon].switchTime);
            this.audio.switchWeapon();
          }
        } else if (ack && !ack.ok) {
          this.lootUi.showStatus(ack.message ?? LOOT_ERROR_MESSAGES_UZ.WEAPON_NOT_OWNED, 'error', 2200);
        }
        resolve(ack);
      });
    });
  }

  private requestUseMedkit(customReqId?: string): Promise<UseMedkitAck> {
    const reqRoundId = this.me.roundId;
    const reqSpawnId = this.me.spawnId;
    const req: UseMedkitReq = {
      requestId: customReqId ?? this.nextLootReqId('medkit'),
      roundId: reqRoundId,
      spawnId: reqSpawnId,
    };
    return new Promise<UseMedkitAck>((resolve) => {
      this.socket.emit('inventory:useMedkit', req, (ack: UseMedkitAck) => {
        if (this.isStaleAckContext(reqRoundId, reqSpawnId, ack)) {
          resolve(ack);
          return;
        }
        if (ack?.inventory) {
          this.onInventoryState(ack.inventory);
        }
        if (ack?.ok) {
          if (ack.hp !== undefined) this.me.hp = ack.hp;
          this.lootUi.showStatus(`Aptechka ishlatildi (+45 HP, joriy: ${this.me.hp} HP)`, 'success', 2400);
        } else if (ack && !ack.ok) {
          this.lootUi.showStatus(ack.message ?? LOOT_ERROR_MESSAGES_UZ.NO_MEDKITS, 'error', 2200);
        }
        resolve(ack);
      });
    });
  }

  private measurePing() {
    const t0 = performance.now();
    this.socket.timeout(3000).emit('latency', t0, (err: Error | null) => {
      if (!err) this.ping = Math.round(performance.now() - t0);
    });
  }

  private onSnap(s: Snapshot) {
    if (this.netSim.dropRate > 0 && Math.random() < this.netSim.dropRate) {
      return;
    }
    if (this.netSim.rttMs > 0 || this.netSim.jitterMs > 0) {
      const delayMs = Math.max(
        0,
        this.netSim.rttMs * 0.5 + (Math.random() * 2 - 1) * this.netSim.jitterMs,
      );
      const tid = window.setTimeout(() => {
        if (!this.disposed) this.applySnap(s);
      }, delayMs);
      this.netSimTimers.push(tid);
      return;
    }
    this.applySnap(s);
  }

  private applySnap(s: Snapshot) {
    const map = new Map(s.players.map((p) => [p.id, p] as const));
    const wolves = s.wolves && s.wolves.length ? new Map(s.wolves.map((w) => [w.id, w] as const)) : null;
    this.snaps.push({ t: performance.now() / 1000, s, map, wolves });
    if (this.snaps.length > 40) this.snaps.shift();
    if (s.roundId !== undefined && s.roundId > this.me.roundId) {
      this.me.roundId = s.roundId;
    }
    const mine = map.get(this.myId);
    if (mine) {
      this.lastAuthoritativeSnap = mine;
      if (s.serverTick !== undefined) {
        this.lastServerTick = s.serverTick;
      }
      if (this.isNight) {
        this.setMyWood(mine.wood ?? 0);
        this.setMyTorch(mine.alive && !mine.downed ? mine.torchSec ?? 0 : 0);
        this.setMyDowned(mine.alive && mine.downed === true, mine.bleedSec ?? 0, mine.reviveK ?? null);
      }
      if (mine.spectateTargetId && !this.spectator.getTargetId()) {
        this.spectator.setTarget(mine.spectateTargetId);
      }
    }
    if (import.meta.env.DEV && window.__DEV_PLAYER_POSE_LOCK__) {
      this.me.alive = true;
      this.me.hp = 100;
      return;
    }
    if (mine) {
      this.me.hp = mine.hp;
      if (!mine.alive && this.me.alive) {
        this.die('');
      } else if (mine.alive && this.me.alive) {
        this.me.reconcile(mine, s.serverTick);
      }
    }
  }

  private onRoster(list: RosterEntry[]) {
    this.roster = list;
    // Pauza menyusidagi botlar/odamlar soni
    let bots = 0;
    for (const r of list) if (r.isBot) bots++;
    $('pause-bot-count').textContent = String(bots);
    $('pause-human-count').textContent = String(list.length - bots);
    const ids = new Set(list.map((r) => r.id));
    for (const r of list) {
      if (r.id === this.myId) {
        this.me.team = r.team;
        this.myName = r.name;
        this.hud.setTeamBadge(r.team, this.mode);
        const myCol = colorFor(r.team, r.id);
        this.vm.setArmColor(myCol);
        this.myModel.setColor(myCol);
        this.myModel.setNameTag(r.name, '#ffe082', false);
        continue;
      }
      let rem = this.remotes.get(r.id);
      if (!rem) {
        const model = new Stickman(colorFor(r.team, r.id));
        model.setWeapon(this.lootPreview ? null : 'rifle');
        model.root.visible = false;
        this.scene.add(model.root);
        rem = {
          id: r.id,
          name: r.name,
          team: r.team,
          model,
          pos: new THREE.Vector3(),
          yaw: 0,
          pitch: 0,
          hp: 100,
          weapon: this.lootPreview ? null : 'rifle',
          alive: false,
          crouched: false,
          downed: false,
          reviveK: null,
          speed: 0,
          stepTimer: 0,
          tagKey: '',
        };
        this.remotes.set(r.id, rem);
      }
      if (rem.team !== r.team) rem.model.setColor(colorFor(r.team, r.id));
      rem.team = r.team;
      rem.name = r.name;
    }
    for (const [id, rem] of this.remotes) {
      if (!ids.has(id)) {
        this.scene.remove(rem.model.root);
        rem.model.dispose();
        this.remotes.delete(id);
      }
    }
    // Ism yorliqlari faqat jamoadoshlar uchun; "Tong otguncha"da hamma ittifoqchi — barchaga do'stona rangda
    for (const rem of this.remotes.values()) {
      const show = this.isNight || (this.mode === 'tdm' && rem.team === this.me.team);
      const key = show ? rem.name + rem.team : '';
      if (key !== rem.tagKey) {
        rem.tagKey = key;
        const color = this.isNight ? '#a8e6a3' : rem.team === 'red' ? '#ff9a9a' : '#9ac2ff';
        rem.model.setNameTag(show ? rem.name : null, color);
      }
    }
  }

  private onMatch(m: MatchState) {
    this.match = m;
    if (this.isNight) {
      this.dawn.onMatch({
        phase: m.phase,
        winReason: m.winReason ?? m.survival?.winReason ?? null,
        dawnInSec: m.survival?.night?.dawnInSec ?? null,
      });
    }
    const zone = m.phase === 'playing' ? m.survival?.zone ?? null : null;
    if (zone !== this.zoneSnap) {
      this.zoneSnap = zone;
      this.zoneSnapAt = performance.now() / 1000;
    }
    // Lager (tun): gulxan/g'aram joylari va o'tin holati — kutish/sanoq va raund davomida keladi
    // (o'yinchilar sanoq paytida allaqachon gulxan atrofida turadi), yakunda null
    const night = this.camp ? m.survival?.night ?? null : null;
    if (this.camp && night && night.fires) {
      this.camp.sync(night.fires, night.piles ?? [], performance.now() / 1000);
      // Raketalar va yordam yuki — kech qo'shilgan/kuzatuvchi ham ko'rsin (hodisa kelmagan bo'lsa)
      this.flareFx?.sync(night.flares, this.nowSec);
      this.supplyFx?.sync(night.supply, this.nowSec);
    } else if (this.camp) {
      // Jonli holat yo'q (yakun) — gulxanlar natijalar ekranida o'z-o'zidan "yonib tugamasin"
      this.camp.freezeFuel(performance.now() / 1000);
    }
    // Raund/match tugaganda snayper pritseli ochiq qolmasin (handleWeapons bu fazada ishlamaydi)
    if (m.phase !== 'playing' && this.me.scoped) this.me.scoped = false;
    if (m.roundId !== undefined && m.roundId > this.me.roundId) {
      this.me.roundId = m.roundId;
    }
    const leader = this.roster.reduce((mx, r) => Math.max(mx, r.kills), 0);
    this.hud.setMatch(m, leader);
    if (this.isSurvival) {
      this.survivalUi.setVisible(true);
      this.hud.center(null);
      if (m.phase === 'ended' && this.lastPhase !== 'ended') {
        // Tong otganda g'oliblar ko'p (winnerIds); boshqa hollarda yagona g'olib
        const win = m.survival?.winnerIds?.length
          ? m.survival.winnerIds.includes(this.myId)
          : m.winnerId
            ? m.winnerId === this.myId
            : m.winner === this.myName;
        this.audio.roundEnd(win);
      }
      if (m.phase !== 'playing') {
        this.lootUi.setActiveContainer(null);
      }
      this.survivalUi.update(m.survival ?? null, this.myId, this.lastSpectatorPose, this.deathKiller);
      this.lastPhase = m.phase;
      return;
    }
    if (m.phase === 'ended') {
      let text: string;
      let cls = 'none';
      let win = false;
      if (m.winner === 'draw') text = 'DURRANG';
      else if (m.mode === 'tdm') {
        text = `${m.winner === 'red' ? 'QIZIL' : "KO'K"} JAMOA G'ALABA QOZONDI!`;
        cls = m.winner;
        win = m.winner === this.me.team;
      } else {
        text = `${esc(m.winner)} G'OLIB!`;
        win = m.winner === this.myName;
      }
      this.hud.center(`<span class="t-${cls}">${text}</span><small>Yangi raund ${m.timeLeft} soniyadan keyin boshlanadi</small>`);
      if (this.lastPhase !== 'ended') this.audio.roundEnd(win);
    } else if (this.lastPhase === 'ended') {
      this.hud.center(null);
    }
    this.lastPhase = m.phase;
  }

  private onSpawn(e: SpawnEvent) {
    if (import.meta.env.DEV && window.__DEV_PLAYER_POSE_LOCK__) {
      const lock = window.__DEV_PLAYER_POSE_LOCK__;
      this.me.alive = true;
      this.me.hp = 100;
      this.me.body.pos = { x: lock.x, y: lock.y, z: lock.z };
      this.me.body.vel = { x: 0, y: 0, z: 0 };
      this.me.yaw = lock.yaw;
      this.me.pitch = lock.pitch;
      this.camY = lock.y + EYE_HEIGHT;
      this.hud.death(false);
      return;
    }
    const t = performance.now() / 1000;
    this.me.spawn(e, t);
    this.deathKiller = '';
    this.setMyDowned(false, 0, null);
    this.spectator.setActive(false);
    this.lastSpectatorPose = null;
    this.lastSentSeq = 0;
    this.lastAuthoritativeSnap = {
      id: this.myId,
      x: e.x,
      y: e.y,
      z: e.z,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: e.yaw,
      pitch: 0,
      hp: 100,
      alive: true,
      weapon: this.me.weapon,
      onGround: true,
      reloading: false,
      spawnId: e.spawnId,
      lastProcessedInputSeq: 0,
    };
    this.camY = e.y + EYE_HEIGHT;
    this.hud.death(false);
    this.hud.scope(false);
    this.lootUi.clearPendingItems();
    this.lootUi.setActiveContainer(null);
    this.inventoryUi.setVisible(Boolean(e.lootPreview ?? this.lootPreview));
    // Yangi hayot — mash'alsiz (server ham torchUntil = 0 qiladi)
    this.setMyTorch(0);
    this.vm.setWeapon(this.me.weapon);
    this.myModel.setWeapon(this.me.weapon);
    if (this.me.weapon) {
      this.vm.startSwitch(0.45);
    }
    if (this.isSurvival && this.match?.survival) {
      this.survivalUi.update(this.match.survival, this.myId, null, '');
    }
  }

  private onShot(e: ShotEvent) {
    const rem = this.remotes.get(e.shooter);
    if (isMeleeWeapon(e.weapon)) {
      rem?.model.meleeSwing();
      this.audio.knifeSwing(e.origin);
      const end = e.ends[0];
      if (end) {
        const dist = Math.hypot(end.x - e.origin.x, end.y - e.origin.y, end.z - e.origin.z);
        if (dist < WEAPONS.knife.range - 0.05) this.fx.bloodHit(v3(end));
      }
      return;
    }
    // Masofaviy model hali qurolsiz bo'lsa (loot rejimida snapshot kechikishi) muzzle anchor'i ajratilgan —
    // bunda server bergan ko'z nuqtasidan foydalanamiz, aks holda trasser xarita markazidan chiqardi.
    const vis = rem && rem.model.root.visible && rem.model.hasWeapon();
    const from = vis ? rem.model.getMuzzleWorld(new THREE.Vector3()) : v3(e.origin);
    const ejectFrom = vis ? rem.model.getEjectWorld(new THREE.Vector3()) : from;
    const rightDir = vis
      ? new THREE.Vector3(Math.cos(rem.yaw), 0, -Math.sin(rem.yaw))
      : new THREE.Vector3(1, 0, 0);
    rem?.model.muzzleFlash();
    this.fx.muzzleBlast(from, ejectFrom, rightDir, e.weapon);
    this.audio.gunshot(e.weapon, e.origin);
    const def = WEAPONS[e.weapon];
    e.ends.forEach((end, i) => {
      if (def.pellets === 1 || i % 2 === 0) this.fx.weaponTracer(from, v3(end), e.weapon);
      this.impactAt(e.origin, end, def.range);
    });
  }

  private impactAt(origin: Vec3, end: Vec3, range: number) {
    const dx = end.x - origin.x;
    const dy = end.y - origin.y;
    const dz = end.z - origin.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.05) return;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    const hit = raycastWorld(this.worldDef, origin, dir, dist + 0.1);
    if (hit && Math.abs(hit.t - dist) < 0.1) this.fx.impact(v3(end), new THREE.Vector3(hit.nx, hit.ny, hit.nz));
    else if (dist < range - 0.5) this.fx.bloodHit(v3(end));
  }

  private onHurt(e: HurtEvent) {
    if (import.meta.env.DEV && window.__DEV_PLAYER_POSE_LOCK__) {
      return;
    }
    this.audio.hurt();
    const p = this.me.body.pos;
    // Server authoritative knockback arrives via Snapshot and reconciles smoothly
    const ang = Math.atan2(-(e.from.x - p.x), -(e.from.z - p.z));
    this.hud.damage(angleDiff(this.me.yaw, ang));
    this.shake = Math.max(this.shake, clamp(e.damage / 120, 0.18, 0.55));
  }

  private onKill(e: KillEvent) {
    // Bo'ri o'ldirsa — killfeed va o'lim ekranida bo'ri turi ("Tun soyasi", "To'da boshlig'i", ...)
    const wolfName = e.weapon === 'wolf' ? this.wolfKillerName(e) : null;
    this.hud.killfeed(e, this.myId, wolfName);
    const rem = this.remotes.get(e.victim);
    if (rem) {
      rem.model.triggerDeath(e.headshot, e.weapon);
      if (rem.model.root.visible) {
        this.fx.bloodHit(rem.pos.clone().add(new THREE.Vector3(0, 1.3, 0)), true);
        // Loot rejimida qurol haqiqiy yer buyumi sifatida tushadi (server), kosmetik uchish shart emas
        if (rem.weapon && !this.lootPreview) this.fx.dropWeapon(rem.pos, rem.yaw, rem.weapon);
      }
    }
    if (e.victim === this.myId) {
      if (import.meta.env.DEV && (window.__DEV_PLAYER_POSE_LOCK__ || window.__DEV_CAMERA_OVERRIDE__)) {
        return;
      }
      this.myModel.triggerDeath(e.headshot, e.weapon);
      if (this.me.weapon && !this.lootPreview) {
        this.fx.dropWeapon(
          new THREE.Vector3(this.me.body.pos.x, this.me.body.pos.y, this.me.body.pos.z),
          this.me.yaw,
          this.me.weapon,
        );
      }
      const html =
        e.weapon === 'zone'
          ? `Xavfsiz zonadan tashqarida qoldingiz ${weaponBadgeHtml('zone', false)}`
          : e.weapon === 'wolf'
          ? `${esc(wolfName ?? WOLF_NAME_UZ)} ${weaponBadgeHtml('wolf', false)} sizni g'ajib tashladi`
          : e.killer === e.victim
          ? `O'z granatangizdan halok bo'ldingiz ${weaponBadgeHtml('grenade', false)}`
          : `<span class="t-${e.killerTeam}">${esc(e.killerName)}</span> ${weaponBadgeHtml(e.weapon, e.headshot)} orqali sizni yo'q qildi`;
      this.die(html);
    }
  }

  private onExplosion(e: ExplosionEvent) {
    this.fx.explosion(v3(e));
    this.audio.explosion(e);
    const d = this.camera.position.distanceTo(this.tmp.set(e.x, e.y, e.z));
    this.shake = Math.max(this.shake, clamp(1 - d / 20, 0, 1) * 0.9);
  }

  private die(killerHtml: string) {
    if (import.meta.env.DEV && (window.__DEV_PLAYER_POSE_LOCK__ || window.__DEV_CAMERA_OVERRIDE__)) {
      this.me.alive = true;
      this.me.hp = 100;
      return;
    }
    if (!this.me.alive) {
      if (killerHtml) this.deathKiller = killerHtml;
      return;
    }
    this.me.alive = false;
    this.me.scoped = false;
    this.me.resetPrediction();
    this.lastSentSeq = 0;
    this.deathAt = performance.now() / 1000;
    // Jamoa almashtirish (M) natijasidagi "o'lim" — qotil yo'q, mos matn ko'rsatamiz
    const byTeamSwitch = !killerHtml && this.deathAt - this.teamSwitchAt < 3;
    this.deathKiller = byTeamSwitch ? '<span>Jamoa almashtirildi</span>' : killerHtml;
    this.vm.cancelReload();
    // O'lgan/kuzatuvchi o'yinchida eski yuklama ko'rinib turmasin; spawn'da qayta ko'rsatiladi
    this.inventoryUi.setVisible(false);
    this.setMyDowned(false, 0, null);
    this.setMyTorch(0);
  }

  /**
   * wolf_night: o'zimizning yiqilgan holatimiz (serverdan). Yiqilganda modelimiz yotadi, bashorat tozalanadi
   * (server harakatni rad etadi), qurol/lager prompti yopiladi; turg'izilganda tik turish qaytadi.
   */
  private setMyDowned(downed: boolean, bleedSec: number, reviveK: number | null): void {
    this.myBleedSec = bleedSec;
    this.myReviveK = reviveK;
    if (downed === this.myDowned) return;
    this.myDowned = downed;
    if (downed) {
      this.myModel.triggerDeath(false, 'wolf');
      this.me.scoped = false;
      this.vm.cancelReload();
      this.lootUi.setActiveContainer(null);
      this.campTarget = null;
      this.reviveTarget = null;
      this.lootUi.setCustomPrompt(null);
      this.audio.hurt();
    }
  }

  /** Sherik turg'izildi (server hodisasi): killfeed qatori va ovoz; o'zimiz bo'lsak — "turdingiz" xabari. */
  private onRevived(e: NightRevivedEvent): void {
    const mine = e.id === this.myId || e.byId === this.myId;
    this.hud.reviveFeed(e.byName, e.name, mine);
    this.audio.campfireFeed({ x: e.x, y: e.y + 1, z: e.z });
    if (e.id === this.myId) {
      this.lootUi.showStatus(`⛑ ${e.byName} sizni turg'izdi`, 'success', 2600);
    } else if (e.byId === this.myId) {
      this.lootUi.showStatus(`⛑ ${e.name}ni turg'izdingiz`, 'success', 2200);
      this.reviveBusy = false;
    }
  }

  private sendInput() {
    if (!this.me.alive || this.me.spawnId <= 0) return;
    if (import.meta.env.DEV && window.__DEV_PLAYER_POSE_LOCK__) return;

    const diag = this.me.prediction.getDiagnostics();
    const newCount = Math.max(0, diag.currentSeq - this.lastSentSeq);
    if (newCount === 0) return;

    const redundancyWindow = Math.min(MAX_INPUT_BATCH_SIZE, newCount + 3);
    const inputs = this.me.prediction.getBatchForSend(redundancyWindow);
    if (inputs.length === 0) return;

    this.lastSentSeq = inputs[inputs.length - 1].seq;
    const batch: PlayerInputBatchMsg = {
      spawnId: this.me.spawnId,
      inputs,
      ping: this.ping,
    };

    if (this.netSim.dropRate > 0 && Math.random() < this.netSim.dropRate) {
      return;
    }
    if (this.netSim.rttMs > 0 || this.netSim.jitterMs > 0) {
      const delayMs = Math.max(
        0,
        this.netSim.rttMs * 0.5 + (Math.random() * 2 - 1) * this.netSim.jitterMs,
      );
      const tid = window.setTimeout(() => {
        if (!this.disposed) this.socket.emit('input', batch);
      }, delayMs);
      this.netSimTimers.push(tid);
      return;
    }
    this.socket.emit('input', batch);
  }

  // ================= DOM =================

  private dom(t: EventTarget, type: string, fn: EventListener) {
    t.addEventListener(type, fn);
    this.domHandlers.push([t, type, fn]);
  }

  private bindDom() {
    this.dom(window, 'resize', () => this.onResize());
    this.dom($('btn-resume'), 'click', () => {
      this.audio.init();
      // Foydalanuvchi bosishi (transient activation) ichida: Keyboard Lock + to'liq ekran, keyin pointer lock
      this.browserGuard.beforeLock();
      this.input.lock();
    });
    this.dom($('btn-leave'), 'click', () => this.onLeave());
    // Pauza menyusidan bot qo'shish / olib tashlash (server chat buyruqlari orqali, barcha rejimlarda)
    this.dom($('btn-bot-add'), 'click', () => this.socket.emit('chat', '/addbot'));
    this.dom($('btn-bot-remove'), 'click', () => this.socket.emit('chat', '/removebot'));
    this.dom(this.renderer.domElement, 'click', () => {
      if (!this.input.locked) {
        this.browserGuard.beforeLock();
        this.input.lock();
      }
    });

    const sens = $('set-sens') as HTMLInputElement;
    const vol = $('set-vol') as HTMLInputElement;
    const fov = $('set-fov') as HTMLInputElement;
    sens.value = String(this.settings.sens);
    vol.value = String(this.settings.volume);
    fov.value = String(this.settings.fov);
    const labels = () => {
      $('val-sens').textContent = this.settings.sens.toFixed(2);
      $('val-vol').textContent = String(Math.round(this.settings.volume * 100));
      $('val-fov').textContent = String(this.settings.fov);
    };
    labels();
    this.dom(sens, 'input', () => {
      this.settings.sens = Number(sens.value);
      labels();
      saveSettings(this.settings);
    });
    this.dom(vol, 'input', () => {
      this.settings.volume = Number(vol.value);
      this.audio.setVolume(this.settings.volume);
      labels();
      saveSettings(this.settings);
    });
    this.dom(fov, 'input', () => {
      this.settings.fov = Number(fov.value);
      this.fov = this.settings.fov;
      labels();
      saveSettings(this.settings);
    });

    const qualityEl = document.getElementById('set-quality') as HTMLSelectElement | null;
    if (qualityEl) {
      qualityEl.value = this.settings.quality;
      this.dom(qualityEl, 'change', () => {
        const q = (qualityEl.value === 'low' || qualityEl.value === 'high' ? qualityEl.value : 'medium') as QualityLevel;
        this.settings.quality = q;
        this.perfLowRes = false;
        this.perfAutoDone = false;
        this.perfBadSec = 0;
        this.applyQualityRendererSettings(q);
        this.world.setQuality?.(q);
        saveSettings(this.settings);
      });
    }
    const autoQ = document.getElementById('set-auto-quality') as HTMLInputElement | null;
    if (autoQ) {
      autoQ.checked = this.settings.autoQuality !== false;
      this.dom(autoQ, 'change', () => {
        this.settings.autoQuality = autoQ.checked;
        this.perfBadSec = 0;
        saveSettings(this.settings);
      });
    }

    const chat = $('chat-input') as HTMLInputElement;
    this.dom(chat, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        const text = chat.value.trim();
        if (text) this.socket.emit('chat', text);
        this.closeChat();
      } else if (ev.key === 'Escape') {
        this.closeChat();
      }
    });
  }

  private updatePauseMenu() {
    $('pause-menu').classList.toggle('hidden', this.input.locked || this.chatOpen || this.disposed);
  }

  private openChat() {
    this.chatOpen = true;
    this.input.reset();
    this.hud.setChatOpen(true);
    const chat = $('chat-input') as HTMLInputElement;
    chat.value = '';
    setTimeout(() => chat.focus(), 0);
  }

  private closeChat() {
    this.chatOpen = false;
    this.hud.setChatOpen(false);
    ($('chat-input') as HTMLInputElement).blur();
    this.updatePauseMenu();
  }

  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Boshqa DPR li monitorga o'tganda / brauzer zoom'ida piksel nisbati ham yangilansin
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxDpr));
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vm.setAspect(w / h);
  }

  /**
   * O'yin o'rtasidagi "bir-bir qotish"larning asosiy manbai — birinchi marta ko'ringan material/tekstura uchun
   * shader kompilyatsiyasi va GPU ga yuklash (konteyner ochilganda qurol modeli, zona devori, 3-shaxs qurollari).
   * Hammasini o'yin boshida ko'rinmas joyda bir necha kadr chizib, oldindan isitamiz.
   */
  private startPrewarm(): void {
    try {
      const g = new THREE.Group();
      g.name = 'prewarm';
      if (this.lootPreview) g.add(createLootPrewarmGroup());
      const gear = createGearPrewarmGroup();
      gear.position.set(0, 0, 4);
      g.add(gear);
      let k = 0;
      for (const w of ALL_WEAPON_IDS) {
        for (const variant of ['3p', '1p'] as const) {
          const gun = buildGun(w, variant);
          gun.group.position.set(-3 - k * 1.2, 0, 0);
          k++;
          g.add(gun.group);
          this.prewarmGuns.push(gun.group);
        }
      }
      if (this.isSurvival) {
        const wall = new ZoneWall(this.scene);
        this.prewarmWall = wall;
        wall.update({ cx: 0, cz: 0, radius: 6 }, -400, true, 0);
        this.scene.remove(wall.root);
        g.add(wall.root);
      }
      g.position.set(0, -400, 0);
      g.traverse((o) => {
        o.frustumCulled = false;
      });
      this.scene.add(g);
      this.prewarmGroup = g;
      this.prewarmFrames = 0;
      this.renderer.compile(this.scene, this.camera);
    } catch (err) {
      console.warn('[prewarm] o\'tkazib yuborildi:', err);
      this.finishPrewarm();
    }
  }

  /**
   * Prewarm guruhini sahnadan olib, o'zi qurgan resurslarni bo'shatadi. Qurol materiallari umumiy (sharedAsset) va
   * ataylab dispose qilinmaydi — kompilyatsiya qilingan shaderlar keshda qolishi prewarm'ning maqsadi; procedural
   * qurol geometriyalari esa har nusxada alohida (GLB bo'laklari sharedAsset). Zona devori tashlanmaydi: haqiqiy
   * devor sifatida qayta ishlatiladi (materiali allaqachon kompilyatsiya qilingan), devor bor bo'lsa — dispose.
   */
  private finishPrewarm(): void {
    if (this.prewarmGroup) this.scene.remove(this.prewarmGroup);
    this.prewarmGroup = null;
    for (const gun of this.prewarmGuns) {
      gun.removeFromParent();
      gun.traverse((o) => {
        if (o instanceof THREE.Mesh && o.geometry && !o.geometry.userData?.sharedAsset) o.geometry.dispose();
      });
    }
    this.prewarmGuns = [];
    const wall = this.prewarmWall;
    this.prewarmWall = null;
    if (!wall) return;
    if (this.zoneWall || this.disposed) {
      wall.dispose();
      return;
    }
    wall.update(null, 0, false, 0);
    this.scene.add(wall.root);
    this.zoneWall = wall;
  }

  // ================= O'yin sikli =================

  private frame = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    const rawDtMs = Math.max(0.05, now - this.last);
    const rawDt = rawDtMs / 1000;
    const dt = Math.min(0.05, rawDt);
    this.last = now;
    this.frameNo++;
    if (this.prewarmGroup && ++this.prewarmFrames > 3) this.finishPrewarm();
    this.trackPerformance(rawDtMs, now);
    if (import.meta.env.DEV) {
      if (this.devElapsed < 0) {
        this.devElapsed = Math.min(0, this.devElapsed + rawDt);
        this.devFrames = 0;
      } else {
        this.devFrames++;
        this.devElapsed += rawDt;
        if (this.devElapsed >= 0.5) {
          this.devFps = Math.round(this.devFrames / this.devElapsed);
          this.devFrameMs = (this.devElapsed / this.devFrames) * 1000;
          this.devFrames = 0;
          this.devElapsed = 0;
        }
      }
      if (this.bench.capturing) {
        this.bench.frameTimesMs.push(rawDtMs);
      }
    }
    this.update(dt, now / 1000);
    this.render();
    this.input.endFrame();
  };

  private isEnemy(rem: Remote): boolean {
    // "Tong otguncha": hamma odam ittifoqchi (do'stona o't yo'q) — bashoratli qon faqat bo'rilarga
    if (this.isNight) return false;
    return this.mode === 'ffa' || isSurvivalMode(this.mode) || rem.team !== this.me.team;
  }

  private update(dt: number, t: number) {
    const inp = this.input;
    const me = this.me;
    const active = inp.locked && !this.chatOpen;

    if (import.meta.env.DEV && !this.chatOpen && inp.justPressed('F9')) {
      this.collisionDebug?.toggle();
    }

    if (active) {
      if (inp.justPressed('Enter') || inp.justPressed('KeyT')) this.openChat();
      // Jamoa almashtirish faqat tirik holatda (o'lik holatda respawn taymerini aylanib o'tishga yo'l qo'ymaslik uchun)
      if (inp.justPressed('KeyM') && this.mode === 'tdm' && me.alive && t - this.teamSwitchAt > 2) {
        this.teamSwitchAt = t;
        this.socket.emit('switchTeam');
      }
      if (inp.justPressed('KeyV')) this.thirdPerson = !this.thirdPerson;
      if (inp.justPressed('KeyN')) this.miniMap?.toggleWhole();
    }

    // Forest Survival: raund tugagach server kirishlarni rad etadi (canPlayerMove=false). Klient ham harakatni
    // to'xtatishi kerak, aks holda bashorat serverdan uzoqlashib "ko'rinmas devor" / rubber-band paydo bo'ladi.
    const frozen = me.alive && this.isSurvival && this.match?.phase === 'ended';
    if (frozen !== this.movementFrozen) {
      this.movementFrozen = frozen;
      if (frozen) me.prediction.clear();
    }

    if (me.alive && !frozen) {
      if (active) {
        const zoomK = me.scoped ? WEAPONS.sniper.zoomFov! / this.fov : 1;
        const k = 0.0022 * this.settings.sens * zoomK;
        me.yaw -= inp.mouseDX * k;
        me.pitch = clamp(me.pitch - inp.mouseDY * k, -1.55, 1.55);
      }
      if (import.meta.env.DEV && this.devSyntheticInput) {
        if (this.devSyntheticInput.yaw !== undefined) me.yaw = this.devSyntheticInput.yaw;
        if (this.devSyntheticInput.pitch !== undefined) me.pitch = this.devSyntheticInput.pitch;
      }
      const syn = import.meta.env.DEV ? this.devSyntheticInput : null;
      const fwd = syn ? syn.fwd : active ? Number(inp.down('KeyW')) - Number(inp.down('KeyS')) : 0;
      const right = syn ? syn.right : active ? Number(inp.down('KeyD')) - Number(inp.down('KeyA')) : 0;
      const jump = syn ? syn.jump : active && inp.down('Space');
      // Diqqat: `walk` aslida SPRINT (Shift) — protokol mosligi uchun maydon nomi `walk` qolgan (PlayerInputCmd.walk)
      const walk = syn ? syn.walk : active && (inp.down('ShiftLeft') || inp.down('ShiftRight'));
      // O'tirish: Alt (chap/o'ng) yoki C bosib turilganda; qo'yib yuborilganda server tepada joy bo'lsa turg'izadi
      const crouch = syn
        ? Boolean(syn.crouch)
        : active && (inp.down('AltLeft') || inp.down('AltRight') || inp.down('KeyC'));
      const wasGround = me.body.onGround;
      const vyBefore = me.body.vel.y;
      // Yiqilgan (wolf_night): WASD/sakrash/sprint/o'tirish yo'q — server ham shu kirishlarni nolga tenglashtiradi,
      // bashorat mos qoladi; faqat qarash (yaw/pitch) ishlaydi
      const downed = this.myDowned;
      if (jump && wasGround && !downed) this.audio.jump();
      // O'tinning og'irligi (wolf_night): to'la qo'l bilan Shift bosilsa — qisqa ishora (4 s da bir marta);
      // harakat qoidasi o'zi shared stepPlayerMovement da (sprint bloklanadi, stamina kamaymaydi)
      if (this.isNight && walk && fwd > 0 && !downed && woodBlocksSprint(me.wood) && t - this.heavyHintAt > 4) {
        this.heavyHintAt = t;
        this.inventoryUi.pulseWoodHeavy();
        this.lootUi.showStatus(`🪵 ${WOOD_HEAVY_MESSAGE_UZ}`, 'info', 1600);
      }
      if (!(import.meta.env.DEV && window.__DEV_PLAYER_POSE_LOCK__)) {
        if (downed) me.move(dt, 0, 0, false, false, false);
        else me.move(dt, fwd, right, jump, walk, crouch);
      }
      // Qurol mantiqi harakat kirishi yozilgandan KEYIN: otish paytida server joriy kadr yaw/pitch ini ko'rsin
      // (aks holda tez "flick" otishlar aim-cone tekshiruvidan o'tmay rad etiladi). Yiqilganda qurol/[E]/[H] yo'q.
      if (active && !downed) this.handleWeapons(t);
      if (!wasGround && me.body.onGround && vyBefore < -6) this.audio.land(Math.min(0.6, -vyBefore / 30));
      if (me.body.onGround && me.speedH() > 1.0) {
        this.stepTimer -= dt;
        if (this.stepTimer <= 0) {
          // Sprintda qadamlar tezroq va balandroq, yurishda sekinroq va yumshoqroq, o'tirib yurishda — juda past
          const crouched = Boolean(me.body.crouched);
          const sprinting = !crouched && me.speedH() > WALK_SPEED + 0.6;
          this.stepTimer = sprinting ? 0.30 : crouched ? CROUCH_STEP_INTERVAL : 0.44;
          const surf = detectSurface(this.worldDef, me.body.pos.x, me.body.pos.y, me.body.pos.z);
          this.audio.footstep(undefined, (sprinting ? 0.18 : 0.11) * (crouched ? CROUCH_STEP_VOLUME_LOCAL : 1), surf);
        }
      } else {
        this.stepTimer = 0.12;
      }
      me.updateTimers(dt, t);
      // Prujinali tepki (recoil) qaytarilishi: otish to'xtaganda pritsel sekin joyiga tushadi
      if (me.weapon) {
        const def = WEAPONS[me.weapon];
        if (this.recoilPitch > 0.0005 && t - me.lastShot > def.fireInterval * 1.1) {
          const rec = Math.min(this.recoilPitch, dt * (0.35 + this.recoilPitch * 3.8));
          me.pitch = clamp(me.pitch - rec, -1.55, 1.55);
          this.recoilPitch = Math.max(0, this.recoilPitch - rec);
        }
      }
    } else if (frozen && active && this.isNight && isDawnEnding(this.match?.survival)) {
      // Tong epilogi va natija ekrani: harakat qulf (server ham), lekin atrofga qarash mumkin — bo'rilar uvlab
      // qochayotganini kuzatish uchun (faqat lokal kamera; kirish yuborilmaydi)
      const k = 0.0022 * this.settings.sens;
      me.yaw -= inp.mouseDX * k;
      me.pitch = clamp(me.pitch - inp.mouseDY * k, -1.55, 1.55);
    } else if (this.isSurvival && active) {
      if (inp.justPressed('KeyA') || inp.justPressed('ArrowLeft') || inp.clicks[2]) {
        this.spectator.cycleTarget(-1, this.getSpectatableTargets());
      } else if (inp.justPressed('KeyD') || inp.justPressed('ArrowRight') || inp.clicks[0]) {
        this.spectator.cycleTarget(1, this.getSpectatableTargets());
      }
    }

    this.sendAcc += dt;
    if (this.sendAcc >= SEND_INTERVAL) {
      this.sendAcc %= SEND_INTERVAL;
      if (me.alive && !frozen) this.sendInput();
    }

    this.updateLootInteraction();
    this.updateCampInteraction();
    this.updateTorchInteraction();
    this.updateReviveInteraction();
    this.updateRemotes(dt, t);
    this.wolfDepartures.update(dt);
    this.fx.update(dt);
    // Konteyner qopqoq animatsiyalari lootWorld.update() ichida yangilanadi (bir kadrda bir marta).
    this.updateCamera(dt, t);
    this.updateDawn(dt);
    this.updateCamp(dt, t);
    if (import.meta.env.DEV && this.collisionDebug?.isEnabled()) {
      const snap = this.lastAuthoritativeSnap;
      this.collisionDebug.update(dt, this.worldDef, {
        alive: me.alive,
        predicted: me.body.pos,
        rendered: me.smoothedPos(),
        onGround: me.body.onGround,
        server: snap ? { x: snap.x, y: snap.y, z: snap.z } : null,
        ack: me.prediction.getLastAckComparison(),
      });
    }
    this.lootWorld.update(dt, {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
    });
    this.updateHud(t);
  }

  private updateLootInteraction() {
    if (
      !this.me.alive ||
      this.myDowned ||
      !this.lootSnapshot ||
      this.lootSnapshot.containers.length === 0 ||
      (this.isSurvival && this.match && this.match.phase !== 'playing')
    ) {
      this.lootUi.setTargetPrompt(null);
      if (this.isSurvival && this.match && this.match.phase !== 'playing') {
        this.lootUi.setActiveContainer(null);
      }
      this.lootWorld.setHighlightedTarget(null, null);
      return;
    }

    const pos = this.me.body.pos;
    const eye = this.me.eye();
    const aim = this.me.aimDir();

    // Auto-close open container panel if player moved out of interaction distance
    const activeId = this.lootUi.getActiveContainerId();
    if (activeId) {
      const activeCnt = this.lootSnapshot.containers.find((c) => c.id === activeId);
      if (!activeCnt) {
        this.lootUi.setActiveContainer(null);
      } else {
        const dCheck = isWithinInteractionDistance(
          pos,
          activeCnt.position,
          activeCnt.interactionRadius + DEFAULT_CONTAINER_EXTRA_MARGIN_M + 0.35,
        );
        if (!dCheck.ok) {
          this.lootUi.setActiveContainer(null);
        }
      }
    }

    let bestCnt: PublicContainerState | null = null;
    let bestScore = Infinity;
    let bestDistH = Infinity;

    for (const cnt of this.lootSnapshot.containers) {
      const dx = cnt.position.x - pos.x;
      const dz = cnt.position.z - pos.z;
      const distH = Math.hypot(dx, dz);
      if (distH > 4.6) continue;
      const dy = Math.abs((pos.y + 0.9) - (cnt.position.y + 0.45));
      if (dy > 2.6) continue;

      const toCntX = cnt.position.x - eye.x;
      const toCntY = cnt.position.y + 0.4 - eye.y;
      const toCntZ = cnt.position.z - eye.z;
      const len3 = Math.hypot(toCntX, toCntY, toCntZ) || 1;
      const dot = (toCntX * aim.x + toCntY * aim.y + toCntZ * aim.z) / len3;

      // Require looking roughly toward the container unless standing right next to it (< 1.85m)
      if (distH > 1.85 && dot < 0.35) continue;

      const score = distH - dot * 1.1;
      if (score < bestScore) {
        bestScore = score;
        bestCnt = cnt;
        bestDistH = distH;
      }
    }

    // Yerda yotgan buyumlar (o'lgan o'yinchi quroli): eng yaqini, konteynerdan yaqinroq bo'lsa ustun
    let bestGround: PublicLootItem | null = null;
    let bestGroundDist = Infinity;
    for (const gi of this.lootSnapshot.groundItems) {
      const dx = gi.position.x - pos.x;
      const dz = gi.position.z - pos.z;
      const distH = Math.hypot(dx, dz);
      if (distH > 4.0 || Math.abs(gi.position.y - pos.y) > 1.8) continue;
      const toX = gi.position.x - eye.x;
      const toY = gi.position.y + 0.15 - eye.y;
      const toZ = gi.position.z - eye.z;
      const len3 = Math.hypot(toX, toY, toZ) || 1;
      const dot = (toX * aim.x + toY * aim.y + toZ * aim.z) / len3;
      if (distH > 1.6 && dot < 0.3) continue;
      if (distH < bestGroundDist) {
        bestGroundDist = distH;
        bestGround = gi;
      }
    }
    if (bestGround && (!bestCnt || bestGroundDist < bestDistH)) {
      const canPick = bestGroundDist <= GROUND_ITEM_PICKUP_RADIUS_M;
      this.lootUi.setTargetPrompt({
        container: null,
        groundItem: bestGround,
        canInteract: canPick,
        distanceM: bestGroundDist,
        blockedReasonUz: canPick ? undefined : `Yaqinroq boring (${bestGroundDist.toFixed(1)} m)`,
      });
      this.lootWorld.setHighlightedTarget(null, canPick ? bestGround.id : null);
      return;
    }

    if (!bestCnt) {
      this.lootUi.setTargetPrompt(null);
      this.lootWorld.setHighlightedTarget(null, null);
      return;
    }

    const allowedRadius = bestCnt.interactionRadius + DEFAULT_CONTAINER_EXTRA_MARGIN_M;
    const distOk = isWithinInteractionDistance(pos, bestCnt.position, allowedRadius).ok;
    const losOk = distOk ? hasLineOfSightToContainer(this.worldDef, eye, bestCnt.position, bestCnt.id) : true;
    const canInteract = distOk && losOk;
    let blockedReasonUz: string | undefined;
    if (!distOk) {
      blockedReasonUz = `Yaqinroq boring (${bestDistH.toFixed(1)} m)`;
    } else if (!losOk) {
      blockedReasonUz = LOOT_ERROR_MESSAGES_UZ.LOS_BLOCKED;
    }

    this.lootUi.setTargetPrompt({
      container: bestCnt,
      canInteract,
      distanceM: bestDistH,
      blockedReasonUz,
    });
    const highlightItem = bestCnt.opened && bestCnt.items.length > 0 ? bestCnt.items[0].id : null;
    this.lootWorld.setHighlightedTarget(canInteract ? bestCnt.id : null, canInteract ? highlightItem : null);
    if (canInteract && bestCnt.opened && this.lootUi.getActiveContainerId() !== bestCnt.id) {
      this.lootUi.setActiveContainer(bestCnt);
    }
  }

  private handleWeapons(t: number) {
    const inp = this.input;
    const me = this.me;
    const notPlaying = this.isSurvival ? this.match?.phase !== 'playing' : this.match?.phase === 'ended';

    // Stage 06: [E] Konteynerni ochish / buyum olish; tunda yaqinroq gulxan/g'aram bo'lsa — lager amali
    if (inp.justPressed('KeyE') && !notPlaying) {
      if (this.reviveTarget) this.triggerRevive();
      else if (this.campTarget) this.triggerCampAction();
      else this.lootUi.triggerPrimaryInteract();
    }

    // wolf_night: [F] mash'al — yonib turgan gulxandan olish yoki qo'ldagini tashlash (E dan alohida tugma)
    if (inp.justPressed('KeyF') && !notPlaying && this.isNight) {
      this.triggerTorchAction();
    }

    // Stage 06: [H] Aptechka ishlatish
    if (inp.justPressed('KeyH') && !notPlaying) {
      void this.requestUseMedkit();
    }

    // wolf_night: [X] Signal raketasi — bo'rilarni 20 s qo'rqitadi
    if (inp.justPressed('KeyX') && !notPlaying && this.isNight) {
      void this.requestUseFlare();
    }

    // Stage 06: [0] Qurolni g'ilofga solish (qo'lni bo'shatish)
    if (inp.justPressed('Digit0') && !notPlaying && (this.lootPreview || this.inventorySnap?.lootPreview)) {
      const holstered = me.weapon;
      if (me.switchTo(null, t)) {
        // switchTo(null) dan keyin me.weapon doim null — Q ishlashi uchun avvalgi qurolni saqlaymiz
        if (holstered) this.prevWeapon = holstered;
        this.lastLocalSwitchAt = t;
        this.vm.setWeapon(null);
        this.myModel.setWeapon(null);
        void this.requestEquipWeapon(null);
      }
      return;
    }

    // Qurol almashtirish: 1-4 o'qotar, 5 pichoq (har doim mavjud), g'ildirak va Q
    let slot = -1;
    let pick: WeaponId | null = null;
    WEAPON_SLOTS.forEach((_w, i) => {
      if (inp.justPressed('Digit' + (i + 1))) slot = i;
    });
    // Stage 06: ochiq konteyner paneli ko'rsatilayotganda [1]-[4] tugmalari panelda yozilganidek buyumni oladi
    if (slot >= 0 && !notPlaying && this.lootUi.getActiveContainerId() && this.lootUi.triggerSlotPickup(slot)) {
      return;
    }
    if (slot >= 0) pick = WEAPON_SLOTS[slot];
    if (inp.justPressed('Digit' + KNIFE_SLOT_KEY)) pick = KNIFE;
    if (inp.wheel !== 0) {
      // G'ildirak mash'al bilan bloklangan qurollarni o'tkazib yuboradi
      const owned = ALL_WEAPON_IDS.filter((w) => me.ownsWeapon(w) && (this.myTorchSec <= 0 || isTorchWeapon(w)));
      if (owned.length > 0) {
        const curIdx = me.weapon ? owned.indexOf(me.weapon) : -1;
        pick = owned[(curIdx + Math.sign(inp.wheel) + owned.length) % owned.length];
      }
    }
    if (inp.justPressed('KeyQ') && this.prevWeapon && me.ownsWeapon(this.prevWeapon)) {
      pick = this.prevWeapon;
    }
    if (pick && !notPlaying) {
      const w = pick;
      if (!me.ownsWeapon(w)) {
        this.lootUi.showStatus(LOOT_ERROR_MESSAGES_UZ.WEAPON_NOT_OWNED, 'error', 2000);
      } else if (this.myTorchSec > 0 && !isTorchWeapon(w)) {
        // Mash'al qo'lda: faqat pichoq/to'pponcha (server ham rad etadi)
        this.lootUi.showStatus(`🔥 ${TORCH_WEAPON_MESSAGE_UZ}`, 'error', 2000);
      } else {
        const prev = me.weapon;
        if (me.switchTo(w, t)) {
          if (prev) this.prevWeapon = prev;
          this.lastLocalSwitchAt = t;
          this.vm.setWeapon(w);
          this.myModel.setWeapon(w);
          this.vm.startSwitch(WEAPONS[w].switchTime);
          this.audio.switchWeapon();
          void this.requestEquipWeapon(w);
        }
      }
    }

    // Granata (qurolsiz holatda ham granata bo'lsa otish mumkin)
    if (inp.justPressed('KeyG') && !notPlaying && me.grenades > 0 && t - me.lastGrenade > 0.8) {
      me.grenades--;
      me.lastGrenade = t;
      this.socket.emit('grenade', { dir: me.aimDir() });
      this.vm.throwGrenade();
      this.audio.throwGrenade();
    }

    // Agar o'yinchi qurolsiz bo'lsa (me.weapon === null), otish va qayta o'qlash bloklanadi
    if (!me.weapon) {
      if (inp.clicks[0] && !notPlaying) {
        this.lootUi.showStatus("Qo'lda qurol yo'q — konteynerni [E] bilan ochib qurol oling!", 'info', 2000);
      }
      return;
    }

    // Snayper pritseli
    if (inp.clicks[2] && !notPlaying && me.weapon === 'sniper' && !me.reloadWeapon && t >= me.switchUntil) {
      me.scoped = !me.scoped;
    }

    // Qayta o'qlash
    if (inp.justPressed('KeyR') && !notPlaying && me.startReload(t)) this.beginReloadFx();

    // O'q uzish (pichoq: o'q talab qilmaydi, ushlab turilsa ketma-ket zarba)
    const def = WEAPONS[me.weapon];
    const melee = isMeleeWeapon(me.weapon);
    const ammo = me.ammo[me.weapon] ?? { mag: 0, reserve: 0 };
    const trigger = def.auto ? inp.buttons[0] : inp.clicks[0];
    if (trigger && !notPlaying && me.canFire(t)) {
      if (melee || ammo.mag > 0) this.fireLocal(t);
      else if (inp.clicks[0]) {
        this.audio.empty();
        if (me.startReload(t)) this.beginReloadFx();
      }
    }
    if (!melee && ammo.mag === 0 && ammo.reserve > 0 && !notPlaying && !me.reloadWeapon && t - me.lastShot > 0.3 && t >= me.switchUntil) {
      if (me.startReload(t)) this.beginReloadFx();
    }
  }

  private beginReloadFx() {
    if (!this.me.weapon) return;
    const def = WEAPONS[this.me.weapon];
    // Avval navbatdagi kirishlarni (jumladan qurol almashtirishni) yuboramiz, so'ng qaysi qurol o'qlanayotganini aniq aytamiz —
    // aks holda server hali eski qurolni ushlab turgan bo'lib, noto'g'ri qurolni o'qlab qo'yadi.
    this.sendInput();
    this.socket.emit('reload', { weapon: this.me.weapon });
    this.vm.startReload(def.reloadTime);
    this.audio.reload(def.reloadTime);
  }

  private fireLocal(t: number) {
    const me = this.me;
    if (!me.weapon) return;
    const activeWeapon = me.weapon;
    const def = WEAPONS[activeWeapon];
    const dirs = me.fire(t);
    if (dirs.length === 0) return;
    const origin = me.eye();
    this.sendInput();
    const msg: ShootMsg = { weapon: activeWeapon, origin, dirs };
    this.socket.emit('shoot', msg);
    if (isMeleeWeapon(activeWeapon)) {
      // Pichoq zarbasi: hilpirash ovozi, 1-shaxs sanchish animatsiyasi, 3-shaxs qo'l siltash; trasser/olov yo'q
      this.audio.knifeSwing();
      this.vm.fire(0, true);
      this.myModel.meleeSwing();
      const d = dirs[0]!;
      let maxT = def.range;
      let hitPlayer = false;
      for (const rem of this.remotes.values()) {
        if (!rem.alive || !rem.model.root.visible || !this.isEnemy(rem)) continue;
        const h = rayVsPlayer(origin, d, rem.pos, maxT, rem.crouched);
        if (h) {
          maxT = h.t;
          hitPlayer = true;
        }
      }
      const tw = this.rayVsWolves(origin, d, maxT);
      if (tw !== null) {
        maxT = tw;
        hitPlayer = true;
      }
      if (hitPlayer) this.fx.bloodHit(new THREE.Vector3(origin.x + d.x * maxT, origin.y + d.y * maxT, origin.z + d.z * maxT));
      return;
    }
    this.audio.gunshot(activeWeapon);
    this.vm.fire(def.recoil);
    this.myModel.muzzleFlash();

    const kickP = def.recoil * (0.75 + Math.random() * 0.45);
    me.pitch = Math.min(1.55, me.pitch + kickP);
    this.recoilPitch = Math.min(0.32, this.recoilPitch + kickP * 0.68);
    me.yaw += (Math.random() - 0.5) * def.recoil * 0.55;
    this.shake = Math.max(this.shake, def.recoil * 2.4);

    this.camera.updateMatrixWorld();
    const useThird = this.thirdPerson && !me.scoped;
    const muzzleWorld = useThird
      ? this.myModel.getMuzzleWorld(new THREE.Vector3())
      : this.camera.localToWorld(this.vm.muzzleLocal(new THREE.Vector3()));
    const ejectWorld = useThird
      ? this.myModel.getEjectWorld(new THREE.Vector3())
      : this.camera.localToWorld(this.vm.ejectPortLocal(new THREE.Vector3()));
    const rightDir = new THREE.Vector3(Math.cos(me.yaw), 0, -Math.sin(me.yaw));
    this.fx.muzzleBlast(muzzleWorld, ejectWorld, rightDir, activeWeapon);

    dirs.forEach((d, i) => {
      const wall = raycastWorld(this.worldDef, origin, d, def.range);
      let maxT = wall ? wall.t : def.range;
      let hitPlayer = false;
      for (const rem of this.remotes.values()) {
        if (!rem.alive || !rem.model.root.visible || !this.isEnemy(rem)) continue;
        const h = rayVsPlayer(origin, d, rem.pos, maxT, rem.crouched);
        if (h) {
          maxT = h.t;
          hitPlayer = true;
        }
      }
      const tw = this.rayVsWolves(origin, d, maxT);
      if (tw !== null) {
        maxT = tw;
        hitPlayer = true;
      }
      const end = new THREE.Vector3(origin.x + d.x * maxT, origin.y + d.y * maxT, origin.z + d.z * maxT);
      if (hitPlayer) this.fx.bloodHit(end);
      else if (wall) this.fx.impact(end, new THREE.Vector3(wall.nx, wall.ny, wall.nz));
      if (def.pellets === 1 || i % 2 === 0) {
        this.fx.weaponTracer(me.scoped ? v3(origin).add(new THREE.Vector3(0, -0.1, 0)) : muzzleWorld, end, activeWeapon);
      }
    });
  }

  private updateRemotes(dt: number, t: number) {
    const renderT = t - INTERP_DELAY;
    let a: BufferedSnap | undefined;
    let b: BufferedSnap | undefined;
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      if (this.snaps[i].t <= renderT) {
        a = this.snaps[i];
        b = this.snaps[i + 1];
        break;
      }
    }
    if (!a) a = this.snaps[0];
    if (!a) return;
    const k = b ? clamp((renderT - a.t) / Math.max(1e-4, b.t - a.t), 0, 1) : 0;

    for (const rem of this.remotes.values()) {
      const pa = a.map.get(rem.id);
      const pb = b?.map.get(rem.id);
      if (!pa && !pb) {
        rem.model.root.visible = false;
        continue;
      }
      const p0 = pa ?? pb!;
      const p1 = pb ?? p0;
      const teleport = Math.hypot(p1.x - p0.x, p1.z - p0.z) > 5 || p0.alive !== p1.alive;
      const kk = teleport ? (k < 0.5 ? 0 : 1) : k;
      const src = kk < 0.5 ? p0 : p1;
      rem.pos.set(lerp(p0.x, p1.x, kk), lerp(p0.y, p1.y, kk), lerp(p0.z, p1.z, kk));
      rem.yaw = p0.yaw + angleDiff(p0.yaw, p1.yaw) * kk;
      rem.pitch = lerp(p0.pitch, p1.pitch, kk);
      rem.hp = src.hp;
      rem.weapon = src.weapon;
      rem.alive = src.alive;
      // O'tirish holati har doim yangiroq snapshot'dan (interpolyatsiya oralig'ida xitboks kechikmasin)
      rem.crouched = Boolean(p1.crouched);
      // Yiqilgan (wolf_night): yotgan poza (GLB'da yiqilish klipi yo'q — o'lim pozasi), ⛑ belgisi; tik turganda tiklanadi
      const downed = src.alive && p1.downed === true;
      const m = rem.model;
      if (downed && !rem.downed) m.triggerDeath(false, 'wolf');
      rem.downed = downed;
      rem.reviveK = downed ? p1.reviveK ?? null : null;
      rem.speed = Math.hypot(src.vx, src.vz);
      const distToCam = this.camera.position.distanceTo(rem.pos);
      const isHiddenSpectator = src.survivalRole === 'spectator' && !src.alive;
      m.root.visible = !isHiddenSpectator;
      m.root.position.copy(rem.pos);
      m.root.rotation.y = rem.yaw;
      m.setWeapon(src.weapon);
      m.setGear(unpackGearState(src.gear));
      m.setCrouch(rem.crouched && !downed);
      m.setDownedMarker(downed && !isHiddenSpectator);
      // wolf_night: qo'ldagi mash'al (yangiroq snapshot'dan; yiqilgan/o'lganda yo'q)
      if (this.isNight) m.setTorch(src.alive && !downed && (p1.torchSec ?? 0) > 0);
      const poseAlive = src.alive && !downed;
      m.update(dt, { speed: downed ? 0 : rem.speed, onGround: src.onGround, pitch: rem.pitch, alive: poseAlive, reloading: src.reloading });
      m.updateNameTagDistance(distToCam, poseAlive);
      if (poseAlive && src.onGround && rem.speed > 1.0) {
        rem.stepTimer -= dt;
        if (rem.stepTimer <= 0) {
          const sprinting = !rem.crouched && rem.speed > WALK_SPEED + 0.6;
          rem.stepTimer = sprinting ? 0.30 : rem.crouched ? CROUCH_STEP_INTERVAL : 0.44;
          const surf = detectSurface(this.worldDef, rem.pos.x, rem.pos.y, rem.pos.z);
          const vol = (sprinting ? 0.6 : 0.38) * (rem.crouched ? CROUCH_STEP_VOLUME_REMOTE : 1);
          this.audio.footstep({ x: rem.pos.x, y: rem.pos.y, z: rem.pos.z }, vol, surf);
        }
      }
    }

    this.updateWolves(a, b, k, dt, t);

    // Granatalar
    const ga = new Map(a.s.grenades.map((g) => [g.id, g] as const));
    const gb = b ? new Map(b.s.grenades.map((g) => [g.id, g] as const)) : ga;
    const seen = new Set<number>();
    for (const [id, g1] of gb) {
      const g0 = ga.get(id) ?? g1;
      seen.add(id);
      let mesh = this.grenadeMeshes.get(id);
      if (!mesh) {
        mesh = buildGrenadeModel();
        this.scene.add(mesh);
        this.grenadeMeshes.set(id, mesh);
      }
      mesh.position.set(lerp(g0.x, g1.x, k), lerp(g0.y, g1.y, k), lerp(g0.z, g1.z, k));
      mesh.rotation.x += dt * 9;
      mesh.rotation.z += dt * 5;
    }
    for (const [id, mesh] of this.grenadeMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        mesh.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            if (o.geometry && !o.geometry.userData?.sharedAsset) o.geometry.dispose();
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) if (m && !m.userData?.sharedAsset) m.dispose();
          }
        });
        this.grenadeMeshes.delete(id);
      }
    }
  }

  /** Bo'rilar: snapshotlar orasida interpolyatsiya, model/animatsiya, irillash va qadam ovozlari. */
  private updateWolves(a: BufferedSnap, b: BufferedSnap | undefined, k: number, dt: number, t: number): void {
    const wa = a.wolves;
    const wb = b ? b.wolves : wa;
    if (!wa && !wb) {
      if (this.wolves.size) this.removeWolvesExcept(null);
      return;
    }
    const seen = new Set<string>();
    const ids = new Set<string>([...(wa?.keys() ?? []), ...(wb?.keys() ?? [])]);
    for (const id of ids) {
      const s0 = wa?.get(id) ?? wb?.get(id);
      const s1 = wb?.get(id) ?? s0;
      if (!s0 || !s1) continue;
      seen.add(id);
      let w = this.wolves.get(id);
      const coat = s1.coat ?? s0.coat ?? 0;
      if (w && w.coat !== coat) {
        // Qayta tug'ilgan bo'ri boshqa turda — model (rang, masshtab) almashtiriladi
        this.scene.remove(w.model.root);
        w.model.dispose();
        w.model = new WolfModel(coat);
        w.coat = coat;
        this.scene.add(w.model.root);
      }
      if (!w) {
        const model = new WolfModel(coat);
        this.scene.add(model.root);
        w = {
          id,
          model,
          coat,
          pos: new THREE.Vector3(s0.x, s0.y, s0.z),
          yaw: s0.yaw,
          state: s0.state,
          targetId: s0.targetId ?? null,
          alive: s0.state !== 'dead',
          speed: 0,
          growlAt: -99,
          stepTimer: 0,
        };
        this.wolves.set(id, w);
      }
      const teleport = Math.hypot(s1.x - s0.x, s1.z - s0.z) > 6;
      const kk = teleport ? (k < 0.5 ? 0 : 1) : k;
      const src = kk < 0.5 ? s0 : s1;
      w.pos.set(lerp(s0.x, s1.x, kk), lerp(s0.y, s1.y, kk), lerp(s0.z, s1.z, kk));
      w.yaw = s0.yaw + angleDiff(s0.yaw, s1.yaw) * kk;
      // Tezlik: snapshotlar orasidagi siljishdan (bo'ri snapshotida vel yo'q)
      const dtSnap = b ? Math.max(1e-3, b.t - a.t) : 1 / 30;
      const snapSpeed = Math.hypot(s1.x - s0.x, s1.z - s0.z) / dtSnap;
      w.speed = teleport ? 0 : lerp(w.speed, snapSpeed, Math.min(1, dt * 12));
      const newState = s1.state;
      const scale = w.model.scale;
      const mouth = { x: w.pos.x, y: w.pos.y + 0.9 * scale, z: w.pos.z };
      // "Tun soyasi": ovozlari faqat yaqindan eshitiladi va ovga hurmasdan, sezdirmay tushadi
      const rangeMul = wolfAudioRangeMul(w.coat);
      const stealthy = rangeMul < 1;
      if (newState !== w.state) {
        const wasThreat = isWolfThreatState(w.state);
        if (newState === 'attack') {
          this.audio.wolfSnarl(mouth);
        } else if (newState === 'hunt' && !wasThreat) {
          // O'yinchini ko'rdi — hurib ovga tushadi (soya — faqat past irillash)
          w.growlAt = t;
          if (stealthy) this.audio.wolfGrowl(mouth, rangeMul);
          else this.audio.wolfBark(mouth);
        } else if ((newState === 'stalk' || newState === 'alert') && !wasThreat && t - w.growlAt > 1.2) {
          w.growlAt = t;
          this.audio.wolfGrowl(mouth, rangeMul);
        }
        w.state = newState;
      }
      w.targetId = src.targetId ?? null;
      w.alive = newState !== 'dead';
      const distToMe = Math.hypot(w.pos.x - this.me.body.pos.x, w.pos.z - this.me.body.pos.z);
      // Ov davomida 2.5–4 s da bir irillaydi (40 m ichida; soya — yaqinroqda), hushyor holatda sekinroq
      const threat = isWolfThreatState(w.state);
      if (w.alive && w.state !== 'attack' && distToMe < 40 * rangeMul) {
        const interval = threat ? 2.5 + Math.random() * 1.5 : w.state === 'alert' ? 5 : 0;
        if (interval > 0 && t - w.growlAt > interval) {
          w.growlAt = t;
          this.audio.wolfGrowl(mouth, rangeMul);
        }
      }
      // Doimiy ovoz: nafas (pishillash) va ovda uzluksiz irillash — pozitsiyasi har kadr yangilanadi
      this.audio.wolfVoice(w.id, mouth, wolfVoiceMood(w.state), w.speed, distToMe, w.alive, rangeMul);
      const m = w.model;
      m.root.position.copy(w.pos);
      m.root.rotation.y = w.yaw;
      // Kameragacha masofa: LOD (18/40 m), soya (40 m) va mikser qadami (70/110/160 m)
      m.update(dt, { state: w.state, speed: w.speed }, this.camera.position.distanceTo(w.pos));
      // Yugurgan bo'rining panja tovushi: og'ir, tez (chopganda zarbdor)
      if (w.alive && w.speed > 2.0) {
        w.stepTimer -= dt;
        if (w.stepTimer <= 0) {
          const gallop = w.speed > 5;
          w.stepTimer = gallop ? 0.16 : 0.3;
          const surf = detectSurface(this.worldDef, w.pos.x, w.pos.y, w.pos.z);
          // Yurganda yumshoq panjalar, chopganda sal og'irroq — lekin o'yinchi qadamidan baland emas
          // (soya panjalari nafasidek faqat yaqindan — rangeMul)
          this.audio.footstep({ x: w.pos.x, y: w.pos.y, z: w.pos.z }, gallop ? 0.3 : 0.14, surf, rangeMul);
        }
      }
    }
    this.removeWolvesExcept(seen);
  }

  private removeWolvesExcept(keep: Set<string> | null): void {
    // Tong otgach o'rmonga qochgan bo'ri (server uzoqlashganini o'chirdi) birdan yo'qolmaydi — yugurib so'nadi
    const dawnLeave = this.isNight && !this.disposed && isDawnEnding(this.match?.survival);
    for (const [id, w] of this.wolves) {
      if (keep && keep.has(id)) continue;
      this.audio.wolfVoiceRemove(id);
      this.wolves.delete(id);
      if (dawnLeave && w.alive && w.state === 'flee') {
        const model = w.model;
        this.wolfDepartures.add({
          root: model.root,
          yaw: w.yaw,
          speed: w.speed,
          animate: (dt) => model.update(dt, { state: 'flee', speed: w.speed }, this.camera.position.distanceTo(model.root.position)),
          finish: () => {
            this.scene.remove(model.root);
            model.dispose();
          },
        });
        continue;
      }
      this.scene.remove(w.model.root);
      w.model.dispose();
    }
  }

  /** Bo'ri o'q xitboksi (server bilan bir xil AABB) — bashoratli qon effekti uchun. */
  private rayVsWolves(origin: Vec3, d: Vec3, maxT: number): number | null {
    let best: number | null = null;
    for (const w of this.wolves.values()) {
      if (!w.alive) continue;
      // Xitboks tur masshtabi bilan kengayadi (to'da boshlig'i katta, chaqqon kichikroq)
      const sc = w.model.scale;
      const r = (WOLF_RADIUS + 0.25) * sc;
      const h = rayBox(
        origin,
        d,
        { x: w.pos.x - r, y: w.pos.y, z: w.pos.z - r },
        { x: w.pos.x + r, y: w.pos.y + WOLF_HEIGHT * sc, z: w.pos.z + r },
        best ?? maxT,
      );
      if (h) best = h.t;
    }
    return best;
  }

  // ================= Lager ("Tong otguncha") =================

  private setMyWood(wood: number): void {
    const w = Math.max(0, Math.min(WOOD_CARRY_MAX, Math.round(wood)));
    if (w === this.me.wood) return;
    this.me.wood = w;
    this.inventoryUi.setWood(this.isNight ? w : null);
  }

  /**
   * wolf_night: o'zimizdagi mash'al (serverdan: snapshot `torchSec` yoki ack). 0 — yo'q. Qolgan vaqt klientda
   * `myTorchAt` dan ekstrapolyatsiya qilinadi (pill har kadr). Yoqilganda/o'chganda 1P/3P ko'rinish, HUD slotlari.
   */
  private setMyTorch(torchSec: number): void {
    const s = Math.max(0, Math.round(torchSec));
    const had = this.myTorchSec > 0;
    this.myTorchSec = s;
    this.myTorchAt = this.nowSec;
    const has = s > 0;
    if (has === had) return;
    this.vm.setTorch(has);
    this.myModel.setTorch(has);
    this.inventoryUi.setTorch(has);
    this.hud.setTorchHeld(has);
    if (!has) {
      this.audio.campfireCrackleRemove(this.torchCrackleId);
      this.torchCrackleId = '';
      if (this.me.alive && !this.myDowned) this.lootUi.showStatus("🔥 Mash'al o'chdi", 'info', 1800);
    }
  }

  /** Qolgan mash'al vaqti (s) — oxirgi serverdan kelgan qiymatdan ekstrapolyatsiya. */
  private myTorchLeft(): number {
    if (this.myTorchSec <= 0) return 0;
    return Math.max(0, this.myTorchSec - (this.nowSec - this.myTorchAt));
  }

  /**
   * [F] nishoni (har kadr, updateCampInteraction dan keyin): mash'al bo'lsa — tashlash; yo'q bo'lsa va yaqinda
   * (CAMP_INTERACT_RANGE_M) yonib turgan gulxan bo'lsa — olish. Prompt matniga "[F] ..." qo'shiladi: gulxan
   * promptida o'tin bo'lsa "[E] Gulxanga o'tin tashlash · [F] Mash'al olish", o'tin bo'lmasa "[E] Mash'al olish"
   * (E ham mash'al oladi — triggerCampAction).
   */
  private updateTorchInteraction(): void {
    if (!this.isNight || !this.camp) {
      this.torchTarget = null;
      return;
    }
    const playing = !this.match || this.match.phase === 'playing';
    if (!this.me.alive || this.myDowned || !playing) {
      this.torchTarget = null;
      return;
    }
    if (this.myTorchSec > 0) {
      this.torchTarget = { kind: 'drop' };
      return;
    }
    const fireTarget = this.campTarget?.kind === 'fire' ? this.campTarget.id : null;
    if (!fireTarget) {
      this.torchTarget = null;
      return;
    }
    const fire = this.camp.getFires(this.nowSec).find((f) => f.id === fireTarget);
    this.torchTarget = fire && fire.lit ? { kind: 'take', fireId: fire.id } : null;
  }

  /** [F]: mash'al olish (yonib turgan gulxan nishonda) yoki tashlash (qo'lda bo'lsa). */
  private triggerTorchAction(): void {
    if (this.campBusy) return;
    const tgt = this.torchTarget;
    if (!tgt) {
      if (this.campTarget?.kind === 'fire') this.lootUi.showStatus(CAMP_ERROR_MESSAGES_UZ.FIRE_OUT, 'error', 2000);
      return;
    }
    if (tgt.kind === 'drop') void this.requestDropTorch();
    else void this.requestTakeTorch(tgt.fireId);
  }

  private requestTakeTorch(fireId: string): Promise<CampActionAck | null> {
    this.campBusy = true;
    this.sendInput();
    const req: TakeTorchReq = { fireId };
    return new Promise((resolve) => {
      this.socket.timeout(3000).emit('night:takeTorch', req, (err: Error | null, ack?: CampActionAck) => {
        if (this.disposed) return resolve(null);
        if (this.handleCampAck(ack, err) && ack) {
          this.myModel.playInteract();
          this.setMyTorch(ack.torchSec ?? 0);
          if (ack.fuelSec !== undefined) this.camp?.applyFireEvent(fireId, ack.fuelSec, true, this.nowSec);
          // Server qurolni pichoq/to'pponchaga o'tkazgan bo'lsa — lokal ham shunga o'tamiz
          this.applyServerWeaponSwitch(ack.weapon);
          const fire = this.camp?.getFires(this.nowSec).find((f) => f.id === fireId);
          this.audio.torchTake(fire ? { x: fire.x, y: fire.y + 0.8, z: fire.z } : undefined);
          this.lootUi.showStatus(`🔥 Mash'al olindi (${ack.torchSec ?? 0} s) — gulxan −${TORCH_FUEL_COST_SEC} s`, 'success', 2200);
        }
        resolve(ack ?? null);
      });
    });
  }

  private requestDropTorch(): Promise<CampActionAck | null> {
    this.campBusy = true;
    return new Promise((resolve) => {
      this.socket.timeout(3000).emit('night:dropTorch', {}, (err: Error | null, ack?: CampActionAck) => {
        if (this.disposed) return resolve(null);
        if (this.handleCampAck(ack, err)) {
          this.setMyTorch(0);
          this.lootUi.showStatus("🔥 Mash'al tashlandi", 'info', 1600);
        }
        resolve(ack ?? null);
      });
    });
  }

  /** Server ack'da qurolni almashtirgan (mash'al olinganda): lokal holat, 1P/3P model va HUD mos keladi. */
  private applyServerWeaponSwitch(weapon: string | null | undefined): void {
    if (weapon === undefined || weapon === this.me.weapon) return;
    const me = this.me;
    const w = weapon === null ? null : ALL_WEAPON_IDS.find((id) => id === weapon) ?? null;
    if (weapon !== null && !w) return;
    const prev = me.weapon;
    if (w !== null && !me.ownsWeapon(w)) return;
    if (!me.switchTo(w, this.nowSec)) return;
    if (prev) this.prevWeapon = prev;
    this.lastLocalSwitchAt = this.nowSec;
    this.vm.setWeapon(w);
    this.myModel.setWeapon(w);
    if (w) this.vm.startSwitch(WEAPONS[w].switchTime * 0.5);
    this.audio.switchWeapon();
  }

  private get nowSec(): number {
    return performance.now() / 1000;
  }

  /**
   * Lager hodisasi (server broadcast): ovoz va gulxan holatini darhol yangilash. Chat xabarini (o'tin tashladi /
   * o'chmoqda / o'chdi) server o'zi systemChat bilan yuboradi — bu yerda takrorlanmaydi; HUD banneri updateCampHud da.
   */
  private onCampfireEvent(e: CampfireEvent): void {
    if (!this.camp) return;
    const fire = this.camp.getFires(this.nowSec).find((f) => f.id === e.fireId) ?? null;
    const pos = fire ? { x: fire.x, y: fire.y + 0.6, z: fire.z } : undefined;
    if (e.kind === 'fed') {
      this.camp.applyFireEvent(e.fireId, e.fuelSec, true, this.nowSec);
      this.audio.campfireFeed(pos);
    } else if (e.kind === 'out') {
      this.camp.applyFireEvent(e.fireId, 0, false, this.nowSec);
      this.audio.campfireOut(pos);
    } else if (e.kind === 'low') {
      this.camp.applyFireEvent(e.fireId, e.fuelSec, true, this.nowSec);
    }
  }

  /** Lager prompti uchun gulxan holati qatori: "🔥 2:30" yoki "O'chgan". */
  private campStatusHtml(f: CampFireView): string {
    if (!f.lit) return `<span class="camp-status out">O'chgan</span>`;
    const total = Math.floor(f.fuelSec);
    const mm = Math.floor(total / 60);
    const ss = String(total % 60).padStart(2, '0');
    const low = f.fuelSec < CAMPFIRE_LOW_FUEL_SEC;
    return `<span class="camp-status${low ? ' low' : ''}">🔥 ${mm}:${ss}</span>`;
  }

  /**
   * [E] nishoni: CAMP_INTERACT_RANGE_M ichidagi eng yaqin (qaragan tomon ustun) bo'sh bo'lmagan o'tin g'arami yoki
   * gulxan. Konteyner/yerdagi buyum ham bo'lsa — lager obyekti yaqinroq bo'lganda ustun keladi.
   * updateLootInteraction() dan KEYIN chaqiriladi (uning promptini bekor qilishi mumkin).
   */
  private updateCampInteraction(): void {
    if (!this.camp || !this.camp.hasCamp()) return;
    const playing = !this.match || this.match.phase === 'playing';
    if (!this.me.alive || this.myDowned || !playing) {
      this.campTarget = null;
      this.lootUi.setCustomPrompt(null);
      return;
    }
    const pos = this.me.body.pos;
    const eye = this.me.eye();
    const aim = this.me.aimDir();
    const now = this.nowSec;

    // Nomzod bahosi: masofa minus "qarash" ulushi (qaragan tomondagi obyekt ustun); diapazondan tashqari — null
    const score = (x: number, y: number, z: number, aimY: number): { score: number; dist: number } | null => {
      const distH = Math.hypot(x - pos.x, z - pos.z);
      if (distH > CAMP_INTERACT_RANGE_M || Math.abs(y - pos.y) >= 2) return null;
      const tx = x - eye.x;
      const ty = y + aimY - eye.y;
      const tz = z - eye.z;
      const len = Math.hypot(tx, ty, tz) || 1;
      const dot = (tx * aim.x + ty * aim.y + tz * aim.z) / len;
      return { score: distH - dot, dist: distH };
    };
    let bestPile: CampPileView | null = null;
    let bestFire: CampFireView | null = null;
    let bestScore = Infinity;
    let bestDist = Infinity;
    for (const p of this.camp.getPiles()) {
      if (!p.available) continue;
      const s = score(p.x, p.y, p.z, 0.4);
      if (s && s.score < bestScore) {
        bestScore = s.score;
        bestDist = s.dist;
        bestPile = p;
      }
    }
    for (const f of this.camp.getFires(now)) {
      const s = score(f.x, f.y, f.z, 0.5);
      if (s && s.score < bestScore) {
        bestScore = s.score;
        bestDist = s.dist;
        bestFire = f;
        bestPile = null;
      }
    }
    const bestKind: 'pile' | 'fire' | null = bestFire ? 'fire' : bestPile ? 'pile' : null;
    if (!bestKind) {
      this.campTarget = null;
      this.lootUi.setCustomPrompt(null);
      return;
    }
    // Konteyner yaqinroq va u bilan muloqot mumkin bo'lsa — konteyner qoladi
    const lootDist = this.lootUi.getInteractableTargetDistance();
    if (lootDist !== null && lootDist < bestDist) {
      this.campTarget = null;
      this.lootUi.setCustomPrompt(null);
      return;
    }
    const wood = this.me.wood;
    if (bestKind === 'pile' && bestPile) {
      this.campTarget = { kind: 'pile', id: bestPile.id };
      if (wood >= WOOD_CARRY_MAX) {
        this.lootUi.setCustomPrompt({
          html: `<span>🪵 O'tin g'arami — qo'lingiz to'la (${wood}/${WOOD_CARRY_MAX})</span>`,
          text: `O'tin g'arami — qo'lingiz to'la (${wood}/${WOOD_CARRY_MAX})`,
          variantClass: 'empty',
        });
      } else {
        this.lootUi.setCustomPrompt({
          html: `<span class="key-pill">E</span><span>O'tin olish (${wood}/${WOOD_CARRY_MAX})</span>`,
          text: `[E] O'tin olish (${wood}/${WOOD_CARRY_MAX})`,
          variantClass: 'camp',
        });
      }
      return;
    }
    if (bestKind === 'fire' && bestFire) {
      this.campTarget = { kind: 'fire', id: bestFire.id };
      const status = this.campStatusHtml(bestFire);
      // Mash'al: yonib turgan gulxandan, qo'lda mash'al bo'lmasa. O'tin bo'lsa E — o'tin tashlash, F — mash'al;
      // o'tin bo'lmasa E ham mash'al oladi. Qo'lda mash'al bo'lsa F — tashlash.
      const torchHeld = this.myTorchSec > 0;
      const torchOffer = bestFire.lit && !torchHeld;
      const torchHtml = torchOffer
        ? ` <span class="prompt-sep">·</span> <span class="key-pill">F</span><span>Mash'al olish</span>`
        : torchHeld
          ? ` <span class="prompt-sep">·</span> <span class="key-pill">F</span><span>Mash'alni tashlash</span>`
          : '';
      const torchText = torchOffer ? ` · [F] Mash'al olish` : torchHeld ? ` · [F] Mash'alni tashlash` : '';
      if (wood > 0) {
        this.lootUi.setCustomPrompt({
          html: `<span class="key-pill">E</span><span>Gulxanga o'tin tashlash (${wood} ta)</span>${torchHtml}${status}`,
          text: `[E] Gulxanga o'tin tashlash (${wood} ta)${torchText}`,
          variantClass: 'camp',
        });
      } else if (torchOffer) {
        this.lootUi.setCustomPrompt({
          html: `<span class="key-pill">E</span><span>Mash'al olish</span>${status}`,
          text: `[E] Mash'al olish`,
          variantClass: 'camp',
        });
      } else {
        this.lootUi.setCustomPrompt({
          html: `<span class="key-pill">E</span><span>Gulxan — o'tin yo'q</span>${torchHtml}${status}`,
          text: `[E] Gulxan — o'tin yo'q${torchText}`,
          variantClass: 'empty',
        });
      }
    }
  }

  /**
   * [E] lager nishonida: g'aramdan o'tin olish yoki gulxanga tashlash (server ack bilan). O'tin bo'lmasa va gulxan
   * yonib tursa (mash'al yo'q) — E mash'al oladi.
   */
  private triggerCampAction(): void {
    const tgt = this.campTarget;
    if (!tgt || this.campBusy) return;
    if (tgt.kind === 'pile') {
      if (this.me.wood >= WOOD_CARRY_MAX) {
        this.lootUi.showStatus(CAMP_ERROR_MESSAGES_UZ.HANDS_FULL, 'error', 2000);
        return;
      }
      void this.requestTakeWood(tgt.id);
    } else {
      if (this.me.wood <= 0) {
        if (this.torchTarget?.kind === 'take' && this.torchTarget.fireId === tgt.id) {
          void this.requestTakeTorch(tgt.id);
          return;
        }
        this.lootUi.showStatus(CAMP_ERROR_MESSAGES_UZ.NO_WOOD, 'error', 2200);
        return;
      }
      void this.requestFeedFire(tgt.id);
    }
  }

  /** Umumiy ack ishlovi: o'tin sonini yangilash, xato toast'i. Qaytaradi — ok. */
  private handleCampAck(ack: CampActionAck | undefined, err: Error | null): boolean {
    this.campBusy = false;
    if (err || !ack) {
      this.lootUi.showStatus('Server javob bermadi — qayta urinib ko\'ring', 'error', 2200);
      return false;
    }
    if (typeof ack.wood === 'number') this.setMyWood(ack.wood);
    if (!ack.ok) {
      // Xato kodisiz rad etish — server spam-limiti (0.3 s): ataylab jim, "Xato" toast'i ko'rsatilmaydi
      if (!ack.error) return false;
      this.lootUi.showStatus(CAMP_ERROR_MESSAGES_UZ[ack.error] ?? 'Xato', 'error', 2400);
      return false;
    }
    return true;
  }

  private requestTakeWood(pileId: string): Promise<CampActionAck | null> {
    this.campBusy = true;
    this.sendInput();
    const req: TakeWoodReq = { pileId };
    return new Promise((resolve) => {
      this.socket.timeout(3000).emit('night:takeWood', req, (err: Error | null, ack?: CampActionAck) => {
        if (this.disposed) return resolve(null);
        if (this.handleCampAck(ack, err)) {
          this.myModel.playInteract();
          this.audio.switchWeapon();
          this.lootUi.showStatus(`🪵 O'tin olindi (${this.me.wood}/${WOOD_CARRY_MAX})`, 'success', 1800);
        }
        resolve(ack ?? null);
      });
    });
  }

  private requestFeedFire(fireId: string): Promise<CampActionAck | null> {
    this.campBusy = true;
    this.sendInput();
    const req: FeedFireReq = { fireId };
    return new Promise((resolve) => {
      this.socket.timeout(3000).emit('night:feedFire', req, (err: Error | null, ack?: CampActionAck) => {
        if (this.disposed) return resolve(null);
        if (this.handleCampAck(ack, err)) {
          this.myModel.playInteract();
          if (ack?.fuelSec !== undefined) {
            this.camp?.applyFireEvent(fireId, ack.fuelSec, true, this.nowSec);
            const total = Math.floor(ack.fuelSec);
            const mm = Math.floor(total / 60);
            const ss = String(total % 60).padStart(2, '0');
            this.lootUi.showStatus(`🔥 O'tin tashlandi — gulxan ${mm}:${ss}`, 'success', 2200);
          } else {
            this.lootUi.showStatus(`🔥 O'tin tashlandi`, 'success', 2000);
          }
        }
        resolve(ack ?? null);
      });
    });
  }

  /**
   * Yiqilgan sherikni turg'izish nishoni (wolf_night): NIGHT_REVIVE_RANGE_M ichidagi (|dy| ≤ 2) eng yaqin yiqilgan
   * ittifoqchi [E] nishoni bo'ladi — gulxan/g'aram/konteynerdan ustun. Prompt: "[E] Turg'izish (3 s)", jarayonda — foiz.
   */
  private updateReviveInteraction(): void {
    if (!this.isNight) return;
    const playing = !this.match || this.match.phase === 'playing';
    if (!this.me.alive || this.myDowned || !playing) {
      if (this.reviveTarget) {
        this.reviveTarget = null;
        this.lootUi.setCustomPrompt(null);
      }
      return;
    }
    const pos = this.me.body.pos;
    let best: Remote | null = null;
    let bestD = Infinity;
    for (const rem of this.remotes.values()) {
      if (!rem.downed || !rem.alive || !rem.model.root.visible) continue;
      const d = Math.hypot(rem.pos.x - pos.x, rem.pos.z - pos.z);
      if (d > NIGHT_REVIVE_RANGE_M || Math.abs(rem.pos.y - pos.y) > 2 || d >= bestD) continue;
      bestD = d;
      best = rem;
    }
    if (!best) {
      if (this.reviveTarget) {
        this.reviveTarget = null;
        // Shu kadrda updateCampInteraction gulxan/g'aram promptini qo'ygan bo'lsa — u qoladi
        if (!this.campTarget) this.lootUi.setCustomPrompt(null);
      }
      return;
    }
    // Turg'izish gulxan/g'aram va konteynerdan ustun
    this.campTarget = null;
    this.reviveTarget = { id: best.id, name: best.name, reviveK: best.reviveK };
    const k = best.reviveK;
    if (k !== null) {
      const pct = Math.round(k * 100);
      this.lootUi.setCustomPrompt({
        html: `<span class="key-pill">E</span><span>⛑ ${esc(best.name)} turg'izilmoqda… ${pct}%</span><span class="revive-bar"><i style="width:${pct}%"></i></span>`,
        text: `[E] ${best.name} turg'izilmoqda… ${pct}%`,
        variantClass: 'revive',
      });
    } else {
      this.lootUi.setCustomPrompt({
        html: `<span class="key-pill">E</span><span>⛑ Turg'izish (${NIGHT_REVIVE_SEC} s) — ${esc(best.name)}</span>`,
        text: `[E] Turg'izish (${NIGHT_REVIVE_SEC} s) — ${best.name}`,
        variantClass: 'revive',
      });
    }
  }

  /** [E] yiqilgan sherik yonida: turg'izish kanalini boshlash (server ack bilan; jarayon snapshotda keladi). */
  private triggerRevive(): void {
    const tgt = this.reviveTarget;
    if (!tgt || this.reviveBusy) return;
    void this.requestRevive(tgt.id);
  }

  private requestRevive(targetId: string): Promise<ReviveAck | null> {
    this.reviveBusy = true;
    this.sendInput();
    const req: ReviveReq = { targetId };
    return new Promise((resolve) => {
      this.socket.timeout(3000).emit('night:revive', req, (err: Error | null, ack?: ReviveAck) => {
        this.reviveBusy = false;
        if (this.disposed) return resolve(null);
        if (err || !ack) {
          this.lootUi.showStatus("Server javob bermadi — qayta urinib ko'ring", 'error', 2200);
          return resolve(null);
        }
        if (!ack.ok) {
          // Xato kodisiz rad etish — server spam-limiti (0.3 s): jim
          if (ack.error) this.lootUi.showStatus(REVIVE_ERROR_MESSAGES_UZ[ack.error] ?? 'Xato', 'error', 2200);
          return resolve(ack);
        }
        this.myModel.playInteract();
        this.lootUi.showStatus(`⛑ Turg'izilmoqda… yonida turing (${NIGHT_REVIVE_SEC} s)`, 'info', 1600);
        resolve(ack);
      });
    });
  }

  /** Har kadr: gulxan animatsiyasi (kamera pozitsiyasi bilan) va yaqin gulxanlarning chirsillashi. */
  private updateCamp(dt: number, t: number): void {
    const camp = this.camp;
    // Raketalar va yordam yuki lager bo'lmasa ham yangilanadi (raund boshida sync hali kelmagan bo'lishi mumkin)
    this.flareFx?.update(dt, t, this.camera.position);
    this.supplyFx?.update(dt, t, this.camera.position);
    if (!camp || !camp.hasCamp()) return;
    camp.update(dt, t, this.camera.position);
    const cam = this.camera.position;
    for (const f of camp.getFires(t)) {
      const dist = Math.hypot(f.x - cam.x, f.y - cam.y, f.z - cam.z);
      this.audio.campfireCrackle(f.id, { x: f.x, y: f.y + 0.5, z: f.z }, f.flame, dist, f.lit);
    }
    this.updateTorches(t);
  }

  /**
   * Mash'allar (3P modellardagi proplar): alanga lipillashi, eng yaqin 4 tasiga yoritgich (TorchLightPool) va
   * o'z mash'alimizning past chirsillashi (gulxan crackle ovozining kichik varianti, o'yinchi joyida).
   */
  private updateTorches(t: number): void {
    const torches: TorchProp[] = [];
    for (const rem of this.remotes.values()) {
      const tp = rem.model.getTorch();
      if (tp && rem.model.root.visible) torches.push(tp);
    }
    for (const tp of torches) tp.update(t);
    const mine = this.myModel.getTorch();
    if (mine) {
      if (this.myModel.root.visible) {
        mine.update(t);
      } else {
        // 1P: 3P modelimiz ko'rinmaydi (yoritgich uchun dunyo matritsasi baribir kerak) — mash'al yoritgichi
        // o'z o'rnimizda tursin, atrof yorishsin
        this.myModel.root.updateMatrixWorld(true);
      }
      torches.unshift(mine);
    }
    this.torchLights?.update(torches, this.camera.position, t);
    if (this.myTorchSec > 0 && this.me.alive) {
      if (!this.torchCrackleId) this.torchCrackleId = `torch:${this.myId}`;
      const p = this.me.body.pos;
      this.audio.campfireCrackle(this.torchCrackleId, { x: p.x, y: p.y + 1.3, z: p.z }, 0.3, 0.8, true);
    }
  }

  /** Yo'nalish indikatorlari uchun kuzatuvchi: tirik — o'yinchi, kuzatuvchi rejimida — kamera pozasi. */
  private viewPose(): { x: number; z: number; yaw: number } {
    const sp = !this.me.alive && this.isSurvival ? this.lastSpectatorPose : null;
    return sp ? { x: sp.x, z: sp.z, yaw: sp.yaw } : { x: this.me.body.pos.x, z: this.me.body.pos.z, yaw: this.me.yaw };
  }

  /**
   * Bo'ri uvladi (server broadcast): ovoz; tunda — ekran chetida uvlash tomoniga qizil 🐺 indikatori (3 s) va
   * mini-xaritada so'nib boradigan belgi. "Tun soyasi" joyini oshkor qilmaydi — uvlashi faqat eshitiladi.
   */
  private onWolfHowl(e: WolfHowlEvent): void {
    this.audio.wolfHowl({ x: e.x, y: e.y + 1, z: e.z });
    if (!this.isNight || this.match?.phase !== 'playing') return;
    if (!wolfHowlRevealsPosition(this.wolves.get(e.id)?.coat)) return;
    const v = this.viewPose();
    this.hud.howlIndicator(bearingToward(v, e, v.yaw));
    this.howlMarks.push({ x: e.x, z: e.z, at: this.nowSec });
    if (this.howlMarks.length > 8) this.howlMarks.splice(0, this.howlMarks.length - 8);
  }

  /** Mini-xarita uchun faol uvlash belgilari (HOWL_MARK_SEC ichida so'nadi); eskilar o'chiriladi. */
  private howlMarkers(t: number): MiniMapMarker[] {
    if (!this.howlMarks.length) return [];
    this.howlMarks = this.howlMarks.filter((h) => t - h.at < HOWL_MARK_SEC);
    return this.howlMarks.map((h) => ({
      x: h.x,
      z: h.z,
      team: 'none' as const,
      alive: true,
      kind: 'howl' as const,
      fade: clamp(1 - (t - h.at) / HOWL_MARK_SEC, 0, 1),
    }));
  }

  /** HUD: lager holati (pill + uchala gulxan indikatorlari qatori) va ogohlantirish banneri (eng yomon gulxan). */
  private updateCampHud(t: number): void {
    if (!this.camp) return;
    const playing = this.match?.phase === 'playing';
    const fires = playing && this.camp.hasCamp() ? this.camp.getFires(t) : [];
    const main = fires.find((f) => f.main) ?? null;
    // Qo'l to'la bo'lmasa — eng yaqin g'aramgacha masofa (o'tin topishga yo'l-yo'riq)
    const pileM =
      main && this.me.alive && this.me.wood < WOOD_CARRY_MAX
        ? this.camp.nearestAvailablePileDist(this.me.body.pos.x, this.me.body.pos.z)
        : null;
    const torchSec = this.me.alive && !this.myDowned ? this.myTorchLeft() : 0;
    const flareSec = this.flareFx?.maxLeftSec(t) ?? 0;
    const v = this.viewPose();
    const indicators: FireIndicatorInput[] = fires.map((f) => ({
      id: f.id,
      name: f.name,
      main: f.main,
      lit: f.lit,
      fuelSec: f.fuelSec,
      bearingRad: bearingToward(v, f, v.yaw),
      distM: Math.hypot(f.x - v.x, f.z - v.z),
    }));
    this.survivalUi.setCampStatus(
      main ? { fuelSec: main.fuelSec, lit: main.lit, pileM, torchSec, flareSec, fires: indicators } : null,
    );
    if (!main || !this.me.alive) {
      this.hud.setCampWarning('');
      return;
    }
    // O'chgan o'chayotgandan, asosiy boshqalardan ustun — banner shu gulxanni nomlaydi
    const worst = pickCampWarningFire(fires);
    this.hud.setCampWarning(worst ? worst.level : '', worst ? { name: worst.fire.name, main: worst.fire.main } : null);
  }

  /**
   * HUD: bo'ri xavfi darajasi (quvyapti / yaqinda) va quvayotgan bo'ri turi. Qochayotgan ('flee') bo'rilar
   * xavf emas; "Tun soyasi" kechroq (yaqinroqdan) seziladi — `wolfWarningFor`.
   */
  private wolfThreatLevel(): WolfWarning {
    if (!this.me.alive || this.wolves.size === 0) return { level: '', nameUz: null };
    const p = this.me.body.pos;
    const views = [...this.wolves.values()].map((w) => ({
      x: w.pos.x,
      z: w.pos.z,
      state: w.state,
      targetId: w.targetId,
      alive: w.alive,
      coat: w.coat,
    }));
    return wolfWarningFor(views, { x: p.x, z: p.z, alive: this.me.alive, yaw: this.me.yaw }, this.myId);
  }

  /** O'ldirgan bo'ri turi nomi: lokal bo'ri (coat) bo'yicha, bo'lmasa server bergan ism. */
  private wolfKillerName(e: KillEvent): string {
    const w = this.wolves.get(e.killer);
    if (w) return wolfCoatTraits(w.coat).nameUz;
    return e.killerName?.trim() ? e.killerName : WOLF_NAME_UZ;
  }

  /**
   * Tong otishi (faqat tun rejimi): silliqlangan daraja → dunyo yorug'ligi/osmon/tuman, ekspozitsiya va
   * 1P qo'l yoritgichlari. Tong otganda (yakun, winReason 'dawn') bir marta tong xori va kunduzgi qushlar;
   * yangi tun (sanoq) boshlanganda — yana qushsiz tun foni.
   */
  private updateDawn(dt: number): void {
    if (!this.isNight) return;
    const p = this.dawn.update(dt);
    this.world.setDawn?.(p);
    this.renderer.toneMappingExposure = dawnExposure(p);
    this.vm.setDawn(dawnBlendFactor(p));
    const m = this.match;
    const dawnWon = m?.phase === 'ended' && (m.winReason ?? m.survival?.winReason) === 'dawn';
    if (dawnWon && !this.dawnChorusDone) {
      this.dawnChorusDone = true;
      this.audio.dawnChorus();
      this.audio.startAmbient('forest');
    } else if (this.dawnChorusDone && m && m.phase !== 'ended') {
      this.dawnChorusDone = false;
      this.audio.startAmbient('night');
    }
  }

  /**
   * 08-FIX: 3P shoulder pivot. The 0.42 m right-shoulder offset is larger than the body radius, so
   * with the right shoulder against a wall the old pivot sat inside the wall and the camera could see
   * through it. Shorten the offset to keep the pivot clear (camera-only; never touches the body).
   */
  private computeShoulderPivot(headX: number, headY: number, headZ: number, rightX: number, rightZ: number): Vec3 {
    const head = { x: headX, y: headY, z: headZ };
    const hit = raycastWorld(this.worldDef, head, { x: rightX, y: 0, z: rightZ }, TP_SHOULDER_OFFSET + TP_SHOULDER_PAD);
    const offset = hit ? clamp(hit.t - TP_SHOULDER_PAD, 0, TP_SHOULDER_OFFSET) : TP_SHOULDER_OFFSET;
    return { x: headX + rightX * offset, y: headY, z: headZ + rightZ * offset };
  }

  /** 08-FIX: death "pull-back" camera, kept out of walls/terrain instead of flying through them. */
  private setClearedDeathCamPosition(
    cam: THREE.PerspectiveCamera,
    renderPos: Vec3,
    backX: number,
    backZ: number,
    e: number,
  ): void {
    // O'lim paytidagi (o'tirgan bo'lishi mumkin) ko'z balandligidan boshlanadi: kamera sakramaydi
    const pivot = { x: renderPos.x, y: renderPos.y + lerp(this.me.viewEyeHeight(), 1.65, e), z: renderPos.z };
    const len = Math.hypot(backX, backZ);
    const desired = len * e;
    if (len < 1e-6 || desired < 1e-3) {
      cam.position.set(pivot.x, pivot.y, pivot.z);
      return;
    }
    const dir = { x: backX / len, y: 0, z: backZ / len };
    const dist = computeCameraClearDistance(this.worldDef, pivot, dir, desired);
    cam.position.set(pivot.x + dir.x * dist, pivot.y, pivot.z + dir.z * dist);
  }

  private updateCamera(dt: number, t: number) {
    const me = this.me;
    const cam = this.camera;
    const scoped = me.alive && me.scoped;
    const useThird = (this.thirdPerson || !me.alive) && !scoped;
    const renderPos = me.smoothedPos();
    const myRole = this.lastAuthoritativeSnap?.survivalRole ?? null;
    const isMidJoinSpectator = this.isSurvival && myRole === 'spectator' && !me.alive;
    // Kamera ko'z balandligi: tik turish va o'tirish orasida ~0.12 s silliq o'tish (o'q chiqish nuqtasi darhol).
    // Yiqilganda (wolf_night) kamera ~0.6 m ga (yerda yotgan ko'z) ~0.35 s da tushadi.
    const downedTarget = this.myDowned && me.alive ? 1 : 0;
    const downedStep = Math.max(0, dt) / 0.35;
    this.myDownedView =
      this.myDownedView < downedTarget
        ? Math.min(downedTarget, this.myDownedView + downedStep)
        : Math.max(downedTarget, this.myDownedView - downedStep);
    const eyeH = lerp(me.updateViewCrouch(dt), DOWNED_EYE_HEIGHT, this.myDownedView);

    // O'zimizning 3D kemper modelimizni yangilash (yiqilganda — yotgan poza)
    this.myModel.root.visible = useThird && !isMidJoinSpectator;
    this.myModel.root.position.set(renderPos.x, renderPos.y, renderPos.z);
    this.myModel.root.rotation.y = me.yaw;
    this.myModel.setWeapon(me.weapon);
    this.myModel.setGear({ helmet: me.helmet > 0, armor: me.armor > 0, grenades: me.grenades, medkits: me.medkits });
    this.myModel.setCrouch(Boolean(me.body.crouched) && !this.myDowned);
    this.myModel.update(dt, {
      speed: this.myDowned ? 0 : me.speedH(),
      onGround: me.body.onGround,
      pitch: me.pitch,
      alive: me.alive && !this.myDowned,
      reloading: !!me.reloadWeapon,
    });

    // Reset proximity fade on remote models before spectator camera update
    for (const rem of this.remotes.values()) {
      rem.model.setCameraProximityFade(10);
    }

    if (me.alive) {
      this.spectator.setActive(false);
      this.lastSpectatorPose = null;
      const target = renderPos.y + eyeH;
      if (me.body.onGround && target > this.camY && target - this.camY < 0.7) this.camY = lerp(this.camY, target, Math.min(1, dt * 18));
      else this.camY = target;

      if (useThird) {
        // "RV There Yet?" uslubidagi yelka ustidan 3-shaxs kamerasi (devorlardan va pastki shoxlardan o'tib ketmaydi,
        // lekin hech qachon dunyodagi daraxt/buta coverini yashirmaydi)
        const rightX = Math.cos(me.yaw);
        const rightZ = -Math.sin(me.yaw);
        const fwdX = -Math.sin(me.yaw) * Math.cos(me.pitch);
        const fwdY = Math.sin(me.pitch);
        const fwdZ = -Math.cos(me.yaw) * Math.cos(me.pitch);

        const pivot = this.computeShoulderPivot(renderPos.x, this.camY + 0.18, renderPos.z, rightX, rightZ);
        const backDir = { x: -fwdX, y: -fwdY, z: -fwdZ };
        const maxDist = TP_MAX_DIST_LOCAL;
        const fairDist = computeFairThirdPersonCameraDist(this.worldDef, pivot, backDir, maxDist);
        // 08-FIX: camera-only clamp — keep the 3P camera (near plane) out of terrain and colliders.
        // This is purely visual; it never affects the authoritative body.
        const dist = computeCameraClearDistance(this.worldDef, pivot, backDir, fairDist);
        this.myModel.setCameraProximityFade(dist);

        cam.position.set(pivot.x + backDir.x * dist, pivot.y + backDir.y * dist, pivot.z + backDir.z * dist);
        cam.rotation.set(me.pitch, me.yaw, 0);
      } else {
        this.myModel.setCameraProximityFade(10);
        cam.position.set(renderPos.x, this.camY, renderPos.z);
        cam.rotation.set(me.pitch, me.yaw, 0);
      }
    } else if (this.isSurvival) {
      this.myModel.setCameraProximityFade(10);
      this.spectator.setActive(true);
      const specPose = this.spectator.updateCameraPose(
        dt,
        this.getSpectatableTargets(),
        this.worldDef,
        this.thirdPerson,
        renderPos,
      );
      this.lastSpectatorPose = specPose;
      if (this.deathAt > 0 && t - this.deathAt < 0.55) {
        const k = clamp((t - this.deathAt) / 0.55, 0, 1);
        const e = 1 - Math.pow(1 - k, 3);
        const backX = Math.sin(me.yaw) * 2.6;
        const backZ = Math.cos(me.yaw) * 2.6;
        this.setClearedDeathCamPosition(cam, renderPos, backX, backZ, e);
        cam.rotation.set(lerp(me.pitch, -0.35, e), me.yaw, 0);
      } else {
        cam.position.set(specPose.x, specPose.y, specPose.z);
        cam.rotation.set(specPose.pitch, specPose.yaw, 0);
        if (!specPose.thirdPerson && specPose.targetId) {
          const targetRem = this.remotes.get(specPose.targetId);
          targetRem?.model.setCameraProximityFade(0);
        }
      }
    } else {
      this.myModel.setCameraProximityFade(10);
      const k = clamp((t - this.deathAt) / 0.6, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);
      const backX = Math.sin(me.yaw) * 2.6;
      const backZ = Math.cos(me.yaw) * 2.6;
      this.setClearedDeathCamPosition(cam, renderPos, backX, backZ, e);
      cam.rotation.set(lerp(me.pitch, -0.35, e), me.yaw, 0);
    }
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 1.5);
      const s = this.shake * 0.06;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.rotation.z += (Math.random() - 0.5) * s * 0.5;
    }
    const targetFov = scoped ? WEAPONS.sniper.zoomFov! : this.fov;
    if (Math.abs(cam.fov - targetFov) > 0.01) {
      cam.fov = scoped ? targetFov : lerp(cam.fov, targetFov, Math.min(1, dt * 20));
      cam.updateProjectionMatrix();
    }
    if (import.meta.env.DEV) {
      const ov = window.__DEV_CAMERA_OVERRIDE__;
      if (ov) {
        cam.position.set(ov.x, ov.y, ov.z);
        cam.rotation.set(ov.pitch, ov.yaw, 0);
        if (!this.thirdPerson) this.myModel.root.visible = false;
      }
    }
    this.world.sky.position.copy(cam.position);
    cam.getWorldDirection(this.tmp);
    this.audio.updateListener(cam.position, this.tmp);

    const hasDevOv = import.meta.env.DEV && !!window.__DEV_CAMERA_OVERRIDE__;
    const cullTargetPos =
      !me.alive && this.isSurvival && this.lastSpectatorPose
        ? { x: this.lastSpectatorPose.x, y: this.lastSpectatorPose.y, z: this.lastSpectatorPose.z }
        : me.body.pos;
    const tCull0 = this.bench.capturing ? performance.now() : 0;
    this.world.update?.(cam, cullTargetPos, useThird && !hasDevOv);
    if (this.bench.capturing) {
      this.bench.cullTimesMs.push(performance.now() - tCull0);
    }
    this.vm.visible = me.alive && !scoped && !useThird && !hasDevOv;
    this.vm.update(dt, me.speedH(), me.body.onGround, this.input.mouseDX, this.input.mouseDY, me.viewCrouch);
  }

  /** Mini-xarita uchun joriy (interpolyatsiyalangan) va maqsad aylana. */
  private currentZoneForMinimap(t: number) {
    const z = this.zoneSnap!;
    const cur = interpolateSurvivalZone(z, t - this.zoneSnapAt);
    return { ...cur, targetCx: z.targetCx, targetCz: z.targetCz, targetRadius: z.targetRadius, shrinking: z.shrinking };
  }

  /** Zona devori, HUD ogohlantirishi (zonadan tashqarida) — har kadr. */
  private updateZone(t: number) {
    const z = this.zoneSnap;
    if (!z) {
      this.zoneWall?.update(null, 0, false, 0);
      this.hud.setZoneWarning(false, 0);
      return;
    }
    if (!this.zoneWall) this.zoneWall = new ZoneWall(this.scene);
    const cur = interpolateSurvivalZone(z, t - this.zoneSnapAt);
    const me = this.me;
    const groundY = sampleTerrainHeight(this.worldDef.terrain, cur.cx, cur.cz);
    this.zoneWall.update(cur, groundY, z.shrinking, 1 / 60);
    const outside = me.alive && isOutsideSurvivalZone(cur, me.body.pos.x, me.body.pos.z);
    this.hud.setZoneWarning(outside, z.dps);
  }

  private updateHud(t: number) {
    const me = this.me;
    this.hud.setHealth(me.alive ? me.hp : 0);
    this.hud.setStamina(me.alive ? me.stamina : 1, me.alive && me.staminaLocked);
    this.hud.setGear(me.alive ? me.armor : 0, me.alive ? me.helmet : 0);
    // Mini-xarita (canvas 2D, matnli) har kadr emas: o'rta sifatda har 2-, past sifatda har 3-kadrda
    if (this.miniMap && this.frameNo % (this.settings.quality === 'low' ? 3 : 2) === 0) {
      // Kuzatuvchi rejimida kamera pozitsiyasi, aks holda o'yinchi; TDM'da faqat jamoadoshlar ko'rinadi
      const sp = !me.alive && this.isSurvival ? this.lastSpectatorPose : null;
      const center = sp ? { x: sp.x, z: sp.z, yaw: sp.yaw } : { x: me.body.pos.x, z: me.body.pos.z, yaw: me.yaw };
      const allies: MiniMapMarker[] = [];
      if (this.mode === 'tdm' || this.isNight) {
        // TDM — jamoadoshlar; tunda hamma ittifoqchi (sariq belgi)
        for (const rem of this.remotes.values()) {
          if (!this.isNight && rem.team !== me.team) continue;
          if (this.isNight && !rem.alive) continue;
          allies.push({
            x: rem.pos.x,
            z: rem.pos.z,
            team: this.isNight ? 'none' : rem.team,
            alive: rem.alive,
            ...(this.isNight && rem.downed ? { downed: true } : {}),
          });
        }
      }
      // Tunda: so'nggi uvlashlar (so'nib boradigan qizil belgi)
      if (this.isNight) allies.push(...this.howlMarkers(t));
      const supplySnap = this.match?.survival?.night?.supply;
      const camp = this.camp?.hasCamp()
        ? {
            fires: this.camp.getFires(t),
            piles: this.camp.getPiles(),
            supply: supplySnap ? { x: supplySnap.x, z: supplySnap.z, opened: supplySnap.opened } : null,
          }
        : null;
      this.miniMap.update(center, allies, this.zoneSnap ? this.currentZoneForMinimap(t) : null, camp);
    }
    this.updateZone(t);
    const wolfWarn = this.wolfThreatLevel();
    // Yiqilganda bo'ri ogohlantirishi o'rniga yiqilish banneri (bo'ri yiqilganni ovlamaydi)
    this.hud.setWolfWarning(this.myDowned ? '' : wolfWarn.level, wolfWarn.nameUz);
    this.hud.setDowned(this.myDowned && me.alive ? { bleedSec: this.myBleedSec, reviveK: this.myReviveK } : null);
    this.updateCampHud(t);
    if (me.weapon) {
      const a = me.ammo[me.weapon];
      this.hud.setAmmo(me.weapon, a.mag, a.reserve, !!me.reloadWeapon, me.grenades, this.lootPreview ? me.ownedWeapons : undefined);
    } else {
      this.hud.setAmmo(null, 0, 0, false, me.grenades, this.lootPreview ? me.ownedWeapons : undefined);
    }
    const spreadPx = (me.currentSpread() * (window.innerHeight / 2)) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.hud.setCrosshair(4 + spreadPx, me.alive && !me.scoped);
    this.hud.scope(me.alive && me.scoped);
    const devPinned = import.meta.env.DEV && Boolean(window.__DEV_PLAYER_POSE_LOCK__ || window.__DEV_CAMERA_OVERRIDE__);
    if (this.isSurvival) {
      this.hud.death(false, '', 0);
      this.survivalUi.update(this.match?.survival ?? null, this.myId, this.lastSpectatorPose, this.deathKiller);
    } else if (!me.alive && this.deathAt > 0 && !devPinned) {
      this.hud.death(true, this.deathKiller, Math.max(0, RESPAWN_TIME - (t - this.deathAt)));
    } else if (devPinned) {
      this.hud.death(false, '', 0);
      this.hud.center(null);
    }
    const showSb =
      !devPinned &&
      ((this.input.locked && !this.chatOpen && this.input.down('Tab')) ||
        (!this.isSurvival && this.match?.phase === 'ended'));
    if (showSb) {
      if (t >= this.sbNext || !this.sbShown) {
        this.sbNext = t + 0.25;
        const last = this.snaps[this.snaps.length - 1];
        const alive = new Set<string>(last ? last.s.players.filter((p) => p.alive).map((p) => p.id) : []);
        this.hud.scoreboard(true, this.roster, this.mode, this.myId, this.match, alive);
        this.sbShown = true;
      }
    } else if (this.sbShown) {
      this.sbShown = false;
      this.hud.scoreboard(false, [], this.mode, this.myId, null, new Set());
    }
  }

  private render() {
    const r = this.renderer;
    const gl = this.bench.capturing && this.gpuTimerExt ? (r.getContext() as WebGL2RenderingContext) : null;
    let activeQuery: WebGLQuery | null = null;
    if (gl && this.gpuTimerExt) {
      // Collect any completed GPU queries from prior frames
      while (this.pendingGpuQueries.length > 0) {
        const q = this.pendingGpuQueries[0];
        const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE);
        const disjoint = gl.getParameter(this.gpuTimerExt.GPU_DISJOINT_EXT);
        if (!available) break;
        this.pendingGpuQueries.shift();
        if (!disjoint) {
          const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
          this.bench.gpuTimesMs.push(ns / 1e6);
        }
        gl.deleteQuery(q);
      }
      activeQuery = gl.createQuery();
      if (activeQuery) {
        gl.beginQuery(this.gpuTimerExt.TIME_ELAPSED_EXT, activeQuery);
      }
    }

    r.clear();
    r.render(this.scene, this.camera);
    const sceneCalls = r.info.render.calls;
    const sceneTris = r.info.render.triangles;
    let vmCalls = 0;
    let vmTris = 0;
    if (this.vm.visible) {
      r.clearDepth();
      r.render(this.vm.scene, this.vm.camera);
      vmCalls = r.info.render.calls;
      vmTris = r.info.render.triangles;
    }

    if (gl && this.gpuTimerExt && activeQuery) {
      gl.endQuery(this.gpuTimerExt.TIME_ELAPSED_EXT);
      this.pendingGpuQueries.push(activeQuery);
    }

    const calls = sceneCalls + vmCalls;
    const tris = sceneTris + vmTris;
    this.lastRenderStats.calls = calls;
    this.lastRenderStats.sceneCalls = sceneCalls;
    this.lastRenderStats.vmCalls = vmCalls;
    this.lastRenderStats.triangles = tris;
    this.lastRenderStats.sceneTris = sceneTris;
    this.lastRenderStats.vmTris = vmTris;
    this.lastRenderStats.geometries = r.info.memory.geometries;
    this.lastRenderStats.textures = r.info.memory.textures;

    if (import.meta.env.DEV) {
      const cp = this.camera.position;
      const cr = this.camera.rotation;
      const modeLabel = window.__DEV_CAMERA_OVERRIDE__ ? 'OVERVIEW' : this.thirdPerson ? '3P' : '1P';
      const gc = (this.world as WorldHandlesWithGroundCover).getGroundCoverStats?.();
      const gcLine = gc
        ? `\nGround: grass ${gc.visibleGrass ?? 0} | flowers ${gc.visibleFlowers ?? 0} | ferns ${gc.visibleFerns ?? 0} | chunks ${
            gc.visibleChunks ?? 0
          } | total ${gc.totalInstances ?? 0} | draw ${gc.drawCalls ?? 0}`
        : '';
      this.hud.setDevStats(
        `DEV | ${this.devFps} FPS (${this.devFrameMs.toFixed(1)} ms) | ${modeLabel}\n` +
          `Draw: ${calls} (scene ${sceneCalls} + vm ${vmCalls}) | Tris: ${tris}\n` +
          `Mem: geo ${r.info.memory.geometries} | tex ${r.info.memory.textures}\n` +
          `Cam: (${cp.x.toFixed(1)}, ${cp.y.toFixed(1)}, ${cp.z.toFixed(1)}) yaw=${cr.y.toFixed(2)} pitch=${cr.x.toFixed(2)}` +
          gcLine +
          (this.collisionDebug ? `\nF9: collision debug ${this.collisionDebug.isEnabled() ? 'ON' : 'off'}` : ''),
      );
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.pingTimer);
    for (const tid of this.netSimTimers) clearTimeout(tid);
    this.netSimTimers.length = 0;
    this.me.resetPrediction();
    for (const [ev, fn] of this.netHandlers) this.socket.off(ev, fn);
    for (const [t, type, fn] of this.domHandlers) t.removeEventListener(type, fn);
    this.input.dispose();
    this.browserGuard.dispose();
    this.zoneWall?.dispose();
    this.zoneWall = null;
    this.finishPrewarm();
    this.hud.setZoneWarning(false, 0);
    this.chatOpen = false;
    this.hud.setChatOpen(false);
    this.hud.reset();
    this.hud.scoreboard(false, [], this.mode, this.myId, null, new Set());
    this.hud.show(false);
    this.hud.setLayout(false, false);
    $('pause-menu').classList.add('hidden');
    this.hud.setWolfWarning('');
    this.hud.setCampWarning('');
    this.howlMarks = [];
    this.removeWolvesExcept(null);
    this.wolfDepartures.clear();
    this.audio.stopWolfVoices();
    this.audio.stopCampfireSounds();
    this.camp?.dispose();
    this.camp = null;
    this.torchLights?.dispose();
    this.torchLights = null;
    this.flareFx?.dispose();
    this.flareFx = null;
    this.supplyFx?.dispose();
    this.supplyFx = null;
    this.hud.clearNightBanner();
    for (const rem of this.remotes.values()) rem.model.dispose();
    for (const [, mesh] of this.grenadeMeshes) {
      this.scene.remove(mesh);
      mesh.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          if (o.geometry && !o.geometry.userData?.sharedAsset) o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) if (m && !m.userData?.sharedAsset) m.dispose();
        }
      });
    }
    this.grenadeMeshes.clear();
    this.spectator.reset();
    this.collisionDebug?.dispose();
    this.collisionDebug = null;
    this.survivalUi.dispose();
    this.audio.stopAmbient();
    this.miniMap?.dispose();
    this.miniMap = null;
    this.lootUi.dispose();
    this.inventoryUi.dispose();
    this.lootWorld.dispose();
    this.myModel.dispose();
    this.vm.dispose();
    this.fx.dispose();
    this.world.dispose();
    this.renderer.dispose();
    // WebGL kontekstini darhol bo'shatamiz — aks holda ko'p marta xonaga kirib-chiqqanda
    // "Too many active WebGL contexts" ogohlantirishi va eski kontekstlar GC ga qadar yashab qoladi
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.uninstallDevTools?.();
    this.uninstallDevTools = null;
  }
}
