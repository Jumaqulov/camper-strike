import * as THREE from 'three';
import type { Socket } from 'socket.io-client';
import { EYE_HEIGHT, RESPAWN_TIME, WALK_SPEED, type GameMode, type Team } from '../../shared/constants';
import { angleDiff, clamp, lerp, type Vec3 } from '../../shared/math';
import { MAX_INPUT_BATCH_SIZE } from '../../shared/netMovement';
import { computeCameraClearDistance, raycastWorld, rayVsPlayer } from '../../shared/physics';
import {
  DEFAULT_CONTAINER_EXTRA_MARGIN_M,
  GROUND_ITEM_PICKUP_RADIUS_M,
  hasLineOfSightToContainer,
  isWithinInteractionDistance,
  LOOT_ERROR_MESSAGES_UZ,
} from '../../shared/loot';
import type {
  AmmoEvent, ChatMsg, ClientState, ContainerOpenAck, ContainerOpenReq, EquipWeaponAck, EquipWeaponReq,
  ExplosionEvent, HitConfirm, HurtEvent, KillEvent, LootPickupAck, LootPickupReq, MatchState, PlayerInputBatchMsg,
  PlayerInventorySnap, PlayerSnap, PublicContainerState, PublicLootItem, RosterEntry, RoomLootSnapshot, ShootMsg, ShotEvent,
  Snapshot, SpawnEvent, UseMedkitAck, UseMedkitReq, WelcomeMsg,
} from '../../shared/protocol';
import { WEAPONS, WEAPON_SLOTS, type WeaponId } from '../../shared/weapons';
import {
  createTechnicalTerrainFixture,
  createWorldDefinition,
  extractWorldMeta,
  sampleTerrainHeight,
  type WorldDefinition,
  type WorldMeta,
} from '../../shared/world';
import { saveSettings, type QualityLevel, type Settings } from '../settings';
import type { AudioSys } from './Audio';
import type { PredictionDiagnostics } from './ClientPrediction';
import { Effects } from './Effects';
import { buildGrenadeModel, buildGun } from './GunModels';
import { esc, Hud, weaponBadgeHtml } from './Hud';
import { MiniMap, type MiniMapMarker } from './MiniMap';
import { ZoneWall } from './survival/ZoneWall';
import { createLootPrewarmGroup } from './loot/LootWorldRenderer';
import { interpolateSurvivalZone, isOutsideSurvivalZone, type SurvivalZoneSnap } from '../../shared/survival';
import { detectSurface } from './surface';
import { Input } from './Input';
import { LocalPlayer } from './LocalPlayer';
import {
  InventoryUI,
  LootUI,
  LootWorldRenderer,
  type InventoryUIDiagnostics,
  type LootUIDiagnostics,
  type LootWorldRendererDiagnostics,
} from './loot';
import {
  type SpectatableTarget,
  type SpectatorCameraPose,
  SpectatorController,
  type SpectatorDiagnostics,
  SurvivalUI,
  type SurvivalUIDiagnostics,
} from './survival';
import { colorFor, Stickman, type CharacterModelDiag } from './Stickman';
import { getCharacterAssetDiagnostics } from './character/CharacterAssetRegistry';
import { ViewModel } from './ViewModel';
import { getBuildingAssetDiagnostics } from './buildings';
import { getContainerAssetDiagnostics } from './containers';
import { getForestAssetDiagnostics } from './ForestAssetRegistry';
import { computeFairThirdPersonCameraDist, type CullingProfileStats } from './ForestRenderer';
import { getInteriorAssetDiagnostics } from './interiors';
import {
  getOutdoorAssetDiagnostics,
  type OutdoorAssetDiagnosticEntry,
  type OutdoorRendererDiagnostics,
} from './outdoor';
import { getWeaponAssetDiagnostics } from './WeaponAssetRegistry';
import { getGrassAssetDiagnostics, type GrassAssetDiagnostics } from './grass/GrassAssetRegistry';
import type { GroundCoverStats } from './GroundCoverRenderer';
import { buildWorld, type WorldHandles } from './World';
import { CollisionDebugOverlay, type CollisionDebugInfo } from './debug/CollisionDebugOverlay';

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

/** 3P shoulder offset (m) and the clearance kept between the shoulder pivot and walls. */
const TP_SHOULDER_OFFSET = 0.42;
const TP_SHOULDER_PAD = 0.15;

const INTERP_DELAY = 0.1;
const SEND_INTERVAL = 1 / 30;

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
  speed: number;
  stepTimer: number;
  tagKey: string;
}

interface BufferedSnap {
  t: number;
  s: Snapshot;
  map: Map<string, PlayerSnap>;
}

export interface DevCameraOverride {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface DevPlayerPoseLock {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

declare global {
  interface Window {
    __DEV_CAMERA_OVERRIDE__?: DevCameraOverride | null;
    __DEV_PLAYER_POSE_LOCK__?: DevPlayerPoseLock | null;
    __DEV_GAME_TOOLS__?: {
      setWeapon: (w: WeaponId | null) => void;
      setThirdPerson: (tp: boolean) => void;
      triggerFireAnim: () => void;
      triggerReloadAnim: () => void;
      getPlayerTransform: () => { x: number; y: number; z: number; yaw: number; onGround: boolean };
      getDiagnostics: () => ReturnType<typeof getWeaponAssetDiagnostics>;
      getForestDiagnostics: () => ReturnType<typeof getForestAssetDiagnostics>;
      getWorldMeta: () => WorldMeta;
      loadTechnicalTerrainFixture: () => WorldMeta;
      setQuality: (q: QualityLevel) => void;
      getRenderStats: () => {
        calls: number;
        sceneCalls: number;
        vmCalls: number;
        triangles: number;
        sceneTris: number;
        vmTris: number;
        geometries: number;
        textures: number;
      };
      getCullingProfile: () => CullingProfileStats | null;
      resetCullingProfile: () => void;
      startBenchmarkCapture: () => void;
      stopBenchmarkCapture: () => {
        frames: number;
        durationMs: number;
        fpsMean: number;
        fpsMedian: number;
        fpsP10: number;
        fps1PctLow: number;
        frameTimeMedianMs: number;
        frameTimeP95Ms: number;
        frameTimeP99Ms: number;
        cullCpuMedianMs: number;
        cullCpuP95Ms: number;
        cullCpuMaxMs: number;
        gpuTimerSupported: boolean;
        gpuTimeMedianMs: number | null;
        gpuTimeP95Ms: number | null;
        render: {
          calls: number;
          sceneCalls: number;
          vmCalls: number;
          triangles: number;
          sceneTris: number;
          vmTris: number;
          geometries: number;
          textures: number;
        };
        culling: CullingProfileStats | null;
        heapUsedMB: number | null;
        heapTotalMB: number | null;
      };
      setPlayerPos: (x: number, z: number, yaw?: number, yOverride?: number, pitch?: number) => {
        x: number;
        y: number;
        z: number;
        yaw: number;
        pitch: number;
        onGround: boolean;
      };
      getCameraState: () => { x: number; y: number; z: number; yaw: number; pitch: number; thirdPerson: boolean };
      getCoverTestFixtures: () => {
        bush: { x: number; y: number; z: number };
        spruce: { x: number; y: number; z: number };
      };
      setBushCoverVisibleForQaDemo: (visible: boolean) => void;
      getStage04ADiagnostics: () => {
        buildings: ReturnType<typeof getBuildingAssetDiagnostics>;
        interiors: ReturnType<typeof getInteriorAssetDiagnostics>;
        containers: ReturnType<typeof getContainerAssetDiagnostics>;
        allLoaded: boolean;
      };
      setDevDoorAngle: (angleRad: number | null, targetId?: string) => void;
      setDevCabinetOpen: (openFraction: number | null) => void;
      setDevContainersOpen: (
        openFraction: number | null,
        containerId?: string,
        damped?: boolean,
      ) => void;
      setDevAnchorHelpers: (visible: boolean) => void;
      stepInput: (
        fwd: number,
        right: number,
        jump: boolean,
        dt: number,
        steps: number,
      ) => { x: number; y: number; z: number; yaw: number; onGround: boolean };
      getPredictionDiagnostics: () => PredictionDiagnostics & {
        authoritativePos: Vec3 | null;
        predictedPos: Vec3;
        smoothedPos: Vec3;
        divergenceM: number;
        netSim: { rttMs: number; jitterMs: number; dropRate: number };
      };
      setNetSim: (opts: { rttMs?: number; jitterMs?: number; dropRate?: number } | null) => void;
      sendRawStatePacketForAdversarialTest: (state: Partial<ClientState>) => void;
      setSyntheticInput: (
        input: {
          fwd?: number;
          right?: number;
          jump?: boolean;
          walk?: boolean;
          yaw?: number;
          pitch?: number;
        } | null,
      ) => void;
      clearPlayerPoseLock: () => void;
      triggerFire: () => boolean;
      getLootDiagnostics: () => {
        lootPreview: boolean;
        lootSnapshot: RoomLootSnapshot | null;
        inventorySnap: PlayerInventorySnap | null;
        lootUi: LootUIDiagnostics;
        inventoryUi: InventoryUIDiagnostics;
        worldRenderer: LootWorldRendererDiagnostics;
      };
      openContainerById: (containerId: string, requestId?: string) => Promise<ContainerOpenAck>;
      pickupLootItem: (
        containerId: string | null,
        itemId: string,
        requestId?: string,
      ) => Promise<LootPickupAck>;
      equipInventoryWeapon: (weapon: WeaponId | null, requestId?: string) => Promise<EquipWeaponAck>;
      useMedkitItem: (requestId?: string) => Promise<UseMedkitAck>;
      requestLootSync: () => Promise<{ loot: RoomLootSnapshot; inventory: PlayerInventorySnap | null }>;
      sendRawShootPacketForAdversarialTest: (msg: ShootMsg) => void;
      getSurvivalDiagnostics: () => {
        isSurvival: boolean;
        match: MatchState | null;
        survivalUi: SurvivalUIDiagnostics;
        spectator: SpectatorDiagnostics;
      };
      cycleSpectatorTarget: (delta: number) => string | null;
      setSpectatorTarget: (targetId: string | null) => void;
      getOutdoorDiagnostics: () => {
        assets: Record<string, OutdoorAssetDiagnosticEntry>;
        renderer: OutdoorRendererDiagnostics | null;
        allLoaded: boolean;
      };
      /** 08-FIX: toggle the F9 collision debug overlay (returns new state). */
      toggleCollisionDebug?: (on?: boolean) => boolean;
      /** 08-FIX: last computed collision debug info (null when the overlay is off). */
      getCollisionDebugInfo?: () => CollisionDebugInfo | null;
      /** 08-TERRAIN-QA: Ground cover rendering stats (instances, draw calls, triangles). */
      getGroundCoverStats?: () => GroundCoverStats | null;
      /** 08-TERRAIN-QA: GLB grass asset cache & fallback diagnostics. */
      getGrassAssetDiagnostics?: () => GrassAssetDiagnostics;
      getGameplayHash?: () => string;
      getWorldVersion?: () => number;
      getRoomId?: () => string;
      getOtherPlayerCount?: () => number;
      getOtherPlayers?: () => Array<{ id: string; name: string; pos: Vec3; weapon: WeaponId | null }>;
      getContainersCount?: () => number;
      /** 08B: Camper Buddy asset + per-model animator/weapon-mount diagnostics. */
      getCharacterDiagnostics?: () => {
        asset: ReturnType<typeof getCharacterAssetDiagnostics>;
        local: CharacterModelDiag;
        remotes: Array<{ id: string } & CharacterModelDiag>;
      };
    } | null;
  }
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
  private hud = new Hud();
  private fx: Effects;
  private vm: ViewModel;
  private me = new LocalPlayer();
  private myModel: Stickman;
  private thirdPerson = true;
  private myName: string;
  private remotes = new Map<string, Remote>();
  private roster: RosterEntry[] = [];
  private snaps: BufferedSnap[] = [];
  private grenadeMeshes = new Map<number, THREE.Object3D>();
  private match: MatchState | null = null;
  private readonly myId: string;
  private readonly roomId: string;
  private readonly mode: GameMode;
  private readonly isSurvival: boolean;
  worldDef: WorldDefinition;
  private raf = 0;
  private last = performance.now();
  private sendAcc = 0;
  private lastSentSeq = 0;
  private lastAuthoritativeSnap: PlayerSnap | null = null;
  private lastServerTick = 0;
  private netSim = { rttMs: 0, jitterMs: 0, dropRate: 0 };
  private netSimTimers: number[] = [];
  private devSyntheticInput: {
    fwd: number;
    right: number;
    jump: boolean;
    walk: boolean;
    yaw?: number;
    pitch?: number;
  } | null = null;
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
  /** Shader/tekstura isitish guruhi (bir necha kadr chiziladi, keyin olib tashlanadi) va kadr hisoblagichi. */
  private prewarmGroup: THREE.Group | null = null;
  private prewarmFrames = 0;
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
  private benchCapturing = false;
  private benchStartMs = 0;
  private benchFrameTimesMs: number[] = [];
  private benchCullTimesMs: number[] = [];
  private benchGpuTimesMs: number[] = [];
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
    this.isSurvival = this.mode === 'forest_survival';
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
    this.renderer.toneMappingExposure = 1.05;
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

    this.world = buildWorld(this.scene, this.worldDef, settings.quality);
    this.applyQualityRendererSettings(settings.quality);
    this.detectWeakGpu();
    this.fx = new Effects(this.scene);
    this.fx.groundAt = (x, z) => sampleTerrainHeight(this.worldDef.terrain, x, z);
    this.vm = new ViewModel(aspect);
    this.myModel = new Stickman(colorFor('red', this.myId));
    const initialWeapon: WeaponId | null = this.lootPreview ? null : 'rifle';
    if (!this.lootPreview) this.prevWeapon = 'pistol';
    this.vm.setWeapon(initialWeapon);
    this.myModel.setWeapon(initialWeapon);
    this.myModel.setNameTag(this.myName, '#ffe082', false);
    this.scene.add(this.myModel.root);

    this.lootWorld = new LootWorldRenderer(
      this.scene,
      this.worldDef,
      this.world.stage04a?.containers ?? null,
    );
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
    });
    this.inventoryUi.setVisible(this.lootPreview);
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
    this.survivalUi.setVisible(this.isSurvival);
    this.input = new Input(this.renderer.domElement);
    this.input.onLockChange = () => {
      if (!this.input.locked && this.chatOpen) this.closeChat();
      this.updatePauseMenu();
    };
    this.audio.setVolume(settings.volume);
    // Ambient fon: o'rmon xaritalarida faqat qushlar (shamol va barg shovqini foydalanuvchi so'rovi bilan olib tashlangan)
    this.audio.startAmbient(this.worldDef.terrain.kind === 'heightfield' ? 'forest' : 'arena');

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
      window.__DEV_GAME_TOOLS__ = {
        setWeapon: (w: WeaponId | null) => {
          this.me.weapon = w;
          this.prevWeapon = w;
          this.vm.setWeapon(w);
          this.myModel.setWeapon(w);
        },
        setThirdPerson: (tp: boolean) => {
          this.thirdPerson = tp;
        },
        triggerFireAnim: () => {
          if (!this.me.weapon) return;
          this.vm.fire(WEAPONS[this.me.weapon].recoil);
          this.myModel.muzzleFlash();
        },
        triggerReloadAnim: () => {
          if (!this.me.weapon) return;
          this.vm.startReload(WEAPONS[this.me.weapon].reloadTime);
        },
        getPlayerTransform: () => ({
          x: this.me.body.pos.x,
          y: this.me.body.pos.y,
          z: this.me.body.pos.z,
          yaw: this.me.yaw,
          onGround: this.me.body.onGround,
        }),
        getDiagnostics: () => getWeaponAssetDiagnostics(),
        getForestDiagnostics: () => getForestAssetDiagnostics(),
        getWorldMeta: () => this.getWorldMeta(),
        loadTechnicalTerrainFixture: () => {
          this.world.dispose();
          const techWorld = createTechnicalTerrainFixture();
          this.worldDef = techWorld;
          this.world = buildWorld(this.scene, techWorld, this.settings.quality);
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
        setQuality: (q: QualityLevel) => {
          this.settings.quality = q;
          saveSettings(this.settings);
          this.applyQualityRendererSettings(q);
          this.world.setQuality?.(q);
        },
        getRenderStats: () => ({ ...this.lastRenderStats }),
        getCullingProfile: () => this.world.getCullingProfile?.() ?? null,
        resetCullingProfile: () => this.world.resetCullingProfile?.(),
        startBenchmarkCapture: () => {
          this.world.resetCullingProfile?.();
          this.benchFrameTimesMs.length = 0;
          this.benchCullTimesMs.length = 0;
          this.benchGpuTimesMs.length = 0;
          this.benchStartMs = performance.now();
          this.benchCapturing = true;
        },
        stopBenchmarkCapture: () => {
          this.benchCapturing = false;
          const durationMs = Math.max(1, performance.now() - this.benchStartMs);
          const ft = [...this.benchFrameTimesMs].sort((a, b) => a - b);
          const n = ft.length;
          const pct = (arr: number[], q: number) =>
            arr.length === 0 ? 0 : arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * q)))];

          const frameTimeMedianMs = pct(ft, 0.5);
          const frameTimeP95Ms = pct(ft, 0.95);
          const frameTimeP99Ms = pct(ft, 0.99);
          const fpsMean = n > 0 ? (n * 1000) / durationMs : 0;
          const fpsMedian = frameTimeMedianMs > 0 ? 1000 / frameTimeMedianMs : 0;
          // p10 FPS corresponds to p90 frame time; 1% low FPS can be reported both as p99 proxy and as mean of slowest 1% frames
          const ftP90 = pct(ft, 0.9);
          const fpsP10 = ftP90 > 0 ? 1000 / ftP90 : 0;
          const fps1PctLowP99 = frameTimeP99Ms > 0 ? 1000 / frameTimeP99Ms : 0;
          const slow1PctCount = Math.max(1, Math.floor(n * 0.01));
          const slowestSlice = ft.slice(n - slow1PctCount);
          const slow1PctMeanFt = slowestSlice.reduce((sum, v) => sum + v, 0) / slow1PctCount;
          const fps1PctLowAvg = slow1PctMeanFt > 0 ? 1000 / slow1PctMeanFt : 0;

          const ct = [...this.benchCullTimesMs].sort((a, b) => a - b);
          const gt = [...this.benchGpuTimesMs].sort((a, b) => a - b);
          const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;

          // Pin the measured sustained median FPS / frame-time into the DEV overlay so screenshots
          // captured immediately after stopBenchmarkCapture() display the exact sustained benchmark numbers
          if (fpsMedian > 0) {
            this.devFps = Math.round(fpsMedian);
            this.devFrameMs = frameTimeMedianMs;
            this.devFrames = 0;
            this.devElapsed = -5.0; // Hold pinned benchmark display for 5s while screenshot is captured
          }

          return {
            frames: n,
            durationMs: Number(durationMs.toFixed(1)),
            fpsMean: Number(fpsMean.toFixed(2)),
            fpsMedian: Number(fpsMedian.toFixed(2)),
            fpsP10: Number(fpsP10.toFixed(2)),
            fps1PctLow: Number(fps1PctLowAvg.toFixed(2)),
            fps1PctLowP99: Number(fps1PctLowP99.toFixed(2)),
            frameTimeMedianMs: Number(frameTimeMedianMs.toFixed(3)),
            frameTimeP95Ms: Number(frameTimeP95Ms.toFixed(3)),
            frameTimeP99Ms: Number(frameTimeP99Ms.toFixed(3)),
            cullCpuMedianMs: Number(pct(ct, 0.5).toFixed(4)),
            cullCpuP95Ms: Number(pct(ct, 0.95).toFixed(4)),
            cullCpuMaxMs: Number(pct(ct, 1.0).toFixed(4)),
            gpuTimerSupported: Boolean(this.gpuTimerExt),
            gpuTimeMedianMs: gt.length > 0 ? Number(pct(gt, 0.5).toFixed(3)) : null,
            gpuTimeP95Ms: gt.length > 0 ? Number(pct(gt, 0.95).toFixed(3)) : null,
            render: { ...this.lastRenderStats },
            culling: this.world.getCullingProfile?.() ?? null,
            heapUsedMB: perfMem ? Number((perfMem.usedJSHeapSize / (1024 * 1024)).toFixed(2)) : null,
            heapTotalMB: perfMem ? Number((perfMem.totalJSHeapSize / (1024 * 1024)).toFixed(2)) : null,
          };
        },
        setPlayerPos: (x: number, z: number, yaw = this.me.yaw, yOverride?: number, pitch = 0) => {
          const y = yOverride ?? sampleTerrainHeight(this.worldDef.terrain, x, z);
          this.me.alive = true;
          this.me.hp = 100;
          this.me.body.pos = { x, y, z };
          this.me.body.vel = { x: 0, y: 0, z: 0 };
          this.me.body.onGround = true;
          this.me.yaw = yaw;
          this.me.pitch = pitch;
          this.camY = y + EYE_HEIGHT;
          this.me.resetPrediction();
          window.__DEV_PLAYER_POSE_LOCK__ = { x, y, z, yaw, pitch };
          return {
            x: this.me.body.pos.x,
            y: this.me.body.pos.y,
            z: this.me.body.pos.z,
            yaw: this.me.yaw,
            pitch: this.me.pitch,
            onGround: this.me.body.onGround,
          };
        },
        getCameraState: () => ({
          x: this.camera.position.x,
          y: this.camera.position.y,
          z: this.camera.position.z,
          yaw: this.camera.rotation.y,
          pitch: this.camera.rotation.x,
          thirdPerson: this.thirdPerson,
        }),
        getCoverTestFixtures: () => {
          const allBushes = this.worldDef.visuals.filter((v) => v.batchKey === 'foliage:bush');
          const trees = this.worldDef.visuals.filter((v) => v.category === 'tree');
          // Pick the largest bush visible in all quality presets (strideHash < 35) that has a clear
          // sightline corridor from (bx, bz - 1.4) to (bx, bz + 9.0) so no tree trunk blocks 1P/3P camera
          let chosenBush = allBushes[0]?.transform.position ?? { x: 8.5, y: 0, z: 13.5 };
          let bestScale = -1;
          for (let i = 0; i < allBushes.length; i++) {
            const strideHash = (i * 41 + 7) % 100;
            if (strideHash >= 35) continue;
            const b = allBushes[i];
            const bx = b.transform.position.x;
            const bz = b.transform.position.z;
            if (Math.hypot(bx, bz) < 8 || Math.hypot(bx, bz) > 36) continue;
            const corridorBlocked = trees.some((t) => {
              const tx = t.transform.position.x;
              const tz = t.transform.position.z;
              return Math.abs(tx - bx) < 1.35 && tz >= bz - 1.4 && tz <= bz + 9.2;
            });
            if (!corridorBlocked && b.transform.scale.x > bestScale) {
              bestScale = b.transform.scale.x;
              chosenBush = b.transform.position;
            }
          }

          const spruces = this.worldDef.visuals.filter((v) => {
            if (v.batchKey !== 'tree:spruce_broad') return false;
            const sx = v.transform.position.x;
            const sz = v.transform.position.z;
            if (Math.hypot(sx, sz) < 12 || Math.hypot(sx, sz) > 32) return false;
            const otherTreeBehind = trees.some(
              (t) =>
                t !== v &&
                Math.abs(t.transform.position.x - sx) < 1.5 &&
                t.transform.position.z >= sz - 1.5 &&
                t.transform.position.z <= sz + 5.0,
            );
            return !otherTreeBehind;
          });
          const s = spruces[0]?.transform.position ?? { x: -14.0, y: 0, z: 16.0 };
          return {
            bush: { x: chosenBush.x, y: chosenBush.y, z: chosenBush.z },
            spruce: { x: s.x, y: s.y, z: s.z },
          };
        },
        setBushCoverVisibleForQaDemo: (visible: boolean) => {
          const b1 = this.scene.getObjectByName('inst_foliage:bush');
          const b2 = this.scene.getObjectByName('inst_foliage:bush_bark');
          if (b1) b1.visible = visible;
          if (b2) b2.visible = visible;
        },
        getStage04ADiagnostics: () => {
          const buildings = getBuildingAssetDiagnostics();
          const interiors = getInteriorAssetDiagnostics();
          const containers = getContainerAssetDiagnostics();
          const allLoaded =
            Object.values(buildings).every((d) => d.loaded && !d.failed && !d.isFallback) &&
            Object.values(interiors).every((d) => d.loaded && !d.failed && !d.isFallback) &&
            Object.values(containers).every((d) => d.loaded && !d.failed && !d.isFallback);
          return {
            buildings,
            interiors,
            containers,
            allLoaded,
          };
        },
        setDevDoorAngle: (angleRad: number | null, targetId?: string) => {
          this.world.stage04a?.buildings.setDevDoorDemoAngle(angleRad, targetId);
        },
        setDevCabinetOpen: (openFraction: number | null) => {
          this.world.stage04a?.interiors.setDevCabinetOpenFraction(openFraction);
        },
        setDevContainersOpen: (
          openFraction: number | null,
          containerId?: string,
          damped = false,
        ) => {
          this.world.stage04a?.containers.setDevContainersOpenFraction(
            openFraction,
            containerId,
            damped,
          );
        },
        setDevAnchorHelpers: (visible: boolean) => {
          this.world.stage04a?.interiors.setAnchorHelpersVisible(visible);
          this.world.stage04a?.containers.setAnchorHelpersVisible(visible);
        },
        stepInput: (fwd: number, right: number, jump: boolean, dt: number, steps: number) => {
          window.__DEV_PLAYER_POSE_LOCK__ = null;
          for (let i = 0; i < steps; i++) {
            this.me.move(dt, fwd, right, i === 0 ? jump : false, false);
            this.sendInput();
          }
          this.camY = this.me.body.pos.y + EYE_HEIGHT;
          return {
            x: this.me.body.pos.x,
            y: this.me.body.pos.y,
            z: this.me.body.pos.z,
            yaw: this.me.yaw,
            onGround: this.me.body.onGround,
          };
        },
        getPredictionDiagnostics: () => {
          const diag = this.me.prediction.getDiagnostics();
          const pred = {
            x: Number(this.me.body.pos.x.toFixed(4)),
            y: Number(this.me.body.pos.y.toFixed(4)),
            z: Number(this.me.body.pos.z.toFixed(4)),
          };
          const smoothedRaw = this.me.smoothedPos();
          const smoothed = {
            x: Number(smoothedRaw.x.toFixed(4)),
            y: Number(smoothedRaw.y.toFixed(4)),
            z: Number(smoothedRaw.z.toFixed(4)),
          };
          const auth = this.lastAuthoritativeSnap
            ? {
                x: Number(this.lastAuthoritativeSnap.x.toFixed(4)),
                y: Number(this.lastAuthoritativeSnap.y.toFixed(4)),
                z: Number(this.lastAuthoritativeSnap.z.toFixed(4)),
              }
            : null;
          const divergenceM = auth
            ? Number(Math.hypot(pred.x - auth.x, pred.y - auth.y, pred.z - auth.z).toFixed(4))
            : 0;
          return {
            ...diag,
            authoritativePos: auth,
            predictedPos: pred,
            smoothedPos: smoothed,
            divergenceM,
            netSim: { ...this.netSim },
          };
        },
        setNetSim: (opts) => {
          if (!opts) {
            this.netSim = { rttMs: 0, jitterMs: 0, dropRate: 0 };
            return;
          }
          this.netSim = {
            rttMs: Math.max(0, Number(opts.rttMs ?? 0)),
            jitterMs: Math.max(0, Number(opts.jitterMs ?? 0)),
            dropRate: clamp(Number(opts.dropRate ?? 0), 0, 0.95),
          };
        },
        sendRawStatePacketForAdversarialTest: (state) => {
          const payload: ClientState = {
            spawnId: state.spawnId ?? this.me.spawnId,
            x: state.x ?? this.me.body.pos.x,
            y: state.y ?? this.me.body.pos.y,
            z: state.z ?? this.me.body.pos.z,
            vx: state.vx ?? 0,
            vy: state.vy ?? 0,
            vz: state.vz ?? 0,
            yaw: state.yaw ?? this.me.yaw,
            pitch: state.pitch ?? this.me.pitch,
            onGround: state.onGround ?? true,
            weapon: state.weapon ?? this.me.weapon,
            ping: state.ping ?? this.ping,
          };
          this.socket.emit('state', payload);
        },
        setSyntheticInput: (input) => {
          if (!input) {
            this.devSyntheticInput = null;
            return;
          }
          window.__DEV_PLAYER_POSE_LOCK__ = null;
          this.devSyntheticInput = {
            fwd: clamp(Number(input.fwd ?? 0), -1, 1),
            right: clamp(Number(input.right ?? 0), -1, 1),
            jump: Boolean(input.jump),
            walk: Boolean(input.walk),
            ...(input.yaw !== undefined && Number.isFinite(input.yaw) ? { yaw: Number(input.yaw) } : {}),
            ...(input.pitch !== undefined && Number.isFinite(input.pitch)
              ? { pitch: clamp(Number(input.pitch), -1.55, 1.55) }
              : {}),
          };
        },
        clearPlayerPoseLock: () => {
          window.__DEV_PLAYER_POSE_LOCK__ = null;
        },
        triggerFire: () => {
          const t = performance.now() / 1000;
          if (!this.me.alive || !this.me.weapon || !this.me.canFire(t)) return false;
          const ammo = this.me.ammo[this.me.weapon];
          if (ammo.mag <= 0) return false;
          this.fireLocal(t);
          return true;
        },
        getLootDiagnostics: () => ({
          lootPreview: this.lootPreview,
          lootSnapshot: this.lootSnapshot,
          inventorySnap: this.inventorySnap,
          lootUi: this.lootUi.getDiagnostics(),
          inventoryUi: this.inventoryUi.getDiagnostics(),
          worldRenderer: this.lootWorld.getDiagnostics(),
        }),
        openContainerById: (containerId: string, requestId?: string) =>
          this.requestOpenContainer(containerId, requestId),
        pickupLootItem: (containerId: string | null, itemId: string, requestId?: string) =>
          this.requestPickupItem(containerId, itemId, requestId),
        equipInventoryWeapon: (weapon: WeaponId | null, requestId?: string) =>
          this.requestEquipWeapon(weapon, requestId),
        useMedkitItem: (requestId?: string) => this.requestUseMedkit(requestId),
        requestLootSync: () =>
          new Promise<{ loot: RoomLootSnapshot; inventory: PlayerInventorySnap | null }>((resolve) => {
            this.socket.emit(
              'loot:sync',
              {},
              (res: { loot: RoomLootSnapshot; inventory: PlayerInventorySnap | null }) => {
                if (res?.loot) this.onLootSnapshot(res.loot);
                if (res?.inventory) this.onInventoryState(res.inventory);
                resolve(res);
              },
            );
          }),
        sendRawShootPacketForAdversarialTest: (msg: ShootMsg) => {
          this.socket.emit('shoot', msg);
        },
        getSurvivalDiagnostics: () => ({
          isSurvival: this.isSurvival,
          match: this.match,
          survivalUi: this.survivalUi.getDiagnostics(),
          spectator: this.spectator.getDiagnostics(this.getSpectatableTargets()),
        }),
        cycleSpectatorTarget: (delta: number) => {
          const chosen = this.spectator.cycleTarget(delta, this.getSpectatableTargets());
          return chosen ? chosen.id : null;
        },
        setSpectatorTarget: (targetId: string | null) => {
          this.spectator.setTarget(targetId);
        },
        getOutdoorDiagnostics: () => {
          const assets = getOutdoorAssetDiagnostics();
          const renderer = this.world.stage04a?.outdoor?.getDiagnostics() ?? null;
          const allLoaded = Object.values(assets).every((d) => d.loaded && !d.failed && !d.isFallback);
          return {
            assets,
            renderer,
            allLoaded,
          };
        },
        toggleCollisionDebug: (on?: boolean) => {
          const dbg = this.collisionDebug;
          if (!dbg) return false;
          dbg.setEnabled(on === undefined ? !dbg.isEnabled() : on);
          return dbg.isEnabled();
        },
        getCollisionDebugInfo: () => this.collisionDebug?.getLastInfo() ?? null,
        getGroundCoverStats: () => this.world.getGroundCoverStats?.() ?? null,
        getGrassAssetDiagnostics: () => getGrassAssetDiagnostics(),
        getGameplayHash: () => this.worldDef.gameplayHash,
        getWorldVersion: () => this.worldDef.worldVersion,
        getRoomId: () => this.roomId,
        getOtherPlayerCount: () => this.remotes.size,
        getOtherPlayers: () =>
          Array.from(this.remotes.values()).map((r) => ({
            id: r.id,
            name: r.name,
            pos: { x: r.pos.x, y: r.pos.y, z: r.pos.z },
            weapon: r.weapon,
          })),
        getContainersCount: () => this.lootSnapshot?.containers.length ?? 0,
        getCharacterDiagnostics: () => ({
          asset: getCharacterAssetDiagnostics(),
          local: this.myModel.getCharacterDiagnostics(),
          remotes: Array.from(this.remotes.values()).map((r) => ({
            id: r.id,
            ...r.model.getCharacterDiagnostics(),
          })),
        }),
      };
      // 08-FIX: F9 collision debug overlay (DEV only — never constructed in production builds)
      this.collisionDebug = new CollisionDebugOverlay(this.scene, document.body);
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  getWorldMeta(): WorldMeta {
    return extractWorldMeta(this.worldDef);
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
      this.audio.hitmarker(e.headshot);
      if (e.kill) this.audio.killConfirm();
    });
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
    this.snaps.push({ t: performance.now() / 1000, s, map });
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
        model.setArchetypeFromId(r.name);
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
          speed: 0,
          stepTimer: 0,
          tagKey: '',
        };
        this.remotes.set(r.id, rem);
      }
      if (rem.team !== r.team) rem.model.setColor(colorFor(r.team, r.id));
      rem.model.setArchetypeFromId(r.name);
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
    // Ism yorliqlari faqat jamoadoshlar uchun
    for (const rem of this.remotes.values()) {
      const show = this.mode === 'tdm' && rem.team === this.me.team;
      const key = show ? rem.name + rem.team : '';
      if (key !== rem.tagKey) {
        rem.tagKey = key;
        rem.model.setNameTag(show ? rem.name : null, rem.team === 'red' ? '#ff9a9a' : '#9ac2ff');
      }
    }
  }

  private onMatch(m: MatchState) {
    this.match = m;
    const zone = m.phase === 'playing' ? m.survival?.zone ?? null : null;
    if (zone !== this.zoneSnap) {
      this.zoneSnap = zone;
      this.zoneSnapAt = performance.now() / 1000;
    }
    // Raund/match tugaganda snayper pritseli ochiq qolmasin (handleWeapons bu fazada ishlamaydi)
    if (m.phase !== 'playing' && this.me.scoped) this.me.scoped = false;
    if (m.roundId !== undefined && m.roundId > this.me.roundId) {
      this.me.roundId = m.roundId;
    }
    const leader = this.roster.reduce((mx, r) => Math.max(mx, r.kills), 0);
    this.hud.setMatch(m, this.me.team, leader);
    if (this.isSurvival) {
      this.survivalUi.setVisible(true);
      this.hud.center(null);
      if (m.phase === 'ended' && this.lastPhase !== 'ended') {
        const win = m.winnerId ? m.winnerId === this.myId : m.winner === this.myName;
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
    this.hud.killfeed(e, this.myId);
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
      this.input.lock();
    });
    this.dom($('btn-leave'), 'click', () => this.onLeave());
    this.dom(this.renderer.domElement, 'click', () => {
      if (!this.input.locked) this.input.lock();
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
      let k = 0;
      for (const w of WEAPON_SLOTS) {
        for (const variant of ['3p', '1p'] as const) {
          const gun = buildGun(w, variant);
          gun.group.position.set(-3 - k * 1.2, 0, 0);
          k++;
          g.add(gun.group);
        }
      }
      if (this.isSurvival) {
        const wall = new ZoneWall(this.scene);
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
      if (this.prewarmGroup) this.scene.remove(this.prewarmGroup);
      this.prewarmGroup = null;
    }
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
    if (this.prewarmGroup && ++this.prewarmFrames > 3) {
      this.scene.remove(this.prewarmGroup);
      this.prewarmGroup = null;
    }
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
      if (this.benchCapturing) {
        this.benchFrameTimesMs.push(rawDtMs);
      }
    }
    this.update(dt, now / 1000);
    this.render();
    this.input.endFrame();
  };

  private isEnemy(rem: Remote): boolean {
    return this.mode === 'ffa' || this.mode === 'forest_survival' || rem.team !== this.me.team;
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
      const walk = syn ? syn.walk : active && (inp.down('ShiftLeft') || inp.down('ShiftRight'));
      const wasGround = me.body.onGround;
      const vyBefore = me.body.vel.y;
      if (jump && wasGround) this.audio.jump();
      if (!(import.meta.env.DEV && window.__DEV_PLAYER_POSE_LOCK__)) {
        me.move(dt, fwd, right, jump, walk);
      }
      // Qurol mantiqi harakat kirishi yozilgandan KEYIN: otish paytida server joriy kadr yaw/pitch ini ko'rsin
      // (aks holda tez "flick" otishlar aim-cone tekshiruvidan o'tmay rad etiladi).
      if (active) this.handleWeapons(t);
      if (!wasGround && me.body.onGround && vyBefore < -6) this.audio.land(Math.min(0.6, -vyBefore / 30));
      if (me.body.onGround && me.speedH() > 1.0) {
        this.stepTimer -= dt;
        if (this.stepTimer <= 0) {
          // Sprintda qadamlar tezroq va balandroq, yurishda sekinroq va yumshoqroq
          const sprinting = me.speedH() > WALK_SPEED + 0.6;
          this.stepTimer = sprinting ? 0.30 : 0.44;
          const surf = detectSurface(this.worldDef, me.body.pos.x, me.body.pos.y, me.body.pos.z);
          this.audio.footstep(undefined, sprinting ? 0.18 : 0.11, surf);
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
    this.updateRemotes(dt, t);
    this.fx.update(dt);
    // Konteyner qopqoq animatsiyalari lootWorld.update() ichida yangilanadi (bir kadrda bir marta).
    this.updateCamera(dt, t);
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

    // Stage 06: [E] Konteynerni ochish / buyum olish
    if (inp.justPressed('KeyE') && !notPlaying) {
      this.lootUi.triggerPrimaryInteract();
    }

    // Stage 06: [H] Aptechka ishlatish
    if (inp.justPressed('KeyH') && !notPlaying) {
      void this.requestUseMedkit();
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

    // Qurol almashtirish
    let slot = -1;
    WEAPON_SLOTS.forEach((_w, i) => {
      if (inp.justPressed('Digit' + (i + 1))) slot = i;
    });
    // Stage 06: ochiq konteyner paneli ko'rsatilayotganda [1]-[4] tugmalari panelda yozilganidek buyumni oladi
    if (slot >= 0 && !notPlaying && this.lootUi.getActiveContainerId() && this.lootUi.triggerSlotPickup(slot)) {
      return;
    }
    if (inp.wheel !== 0) {
      const owned = WEAPON_SLOTS.filter((w) => me.ownsWeapon(w));
      if (owned.length > 0) {
        const curIdx = me.weapon ? owned.indexOf(me.weapon) : -1;
        const nextW = owned[(curIdx + Math.sign(inp.wheel) + owned.length) % owned.length];
        slot = WEAPON_SLOTS.indexOf(nextW);
      }
    }
    if (inp.justPressed('KeyQ') && this.prevWeapon && me.ownsWeapon(this.prevWeapon)) {
      slot = WEAPON_SLOTS.indexOf(this.prevWeapon);
    }
    if (slot >= 0 && !notPlaying) {
      const w = WEAPON_SLOTS[slot];
      if (!me.ownsWeapon(w)) {
        this.lootUi.showStatus(LOOT_ERROR_MESSAGES_UZ.WEAPON_NOT_OWNED, 'error', 2000);
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

    // O'q uzish
    const def = WEAPONS[me.weapon];
    const ammo = me.ammo[me.weapon];
    const trigger = def.auto ? inp.buttons[0] : inp.clicks[0];
    if (trigger && !notPlaying && me.canFire(t)) {
      if (ammo.mag > 0) this.fireLocal(t);
      else if (inp.clicks[0]) {
        this.audio.empty();
        if (me.startReload(t)) this.beginReloadFx();
      }
    }
    if (ammo.mag === 0 && ammo.reserve > 0 && !notPlaying && !me.reloadWeapon && t - me.lastShot > 0.3 && t >= me.switchUntil) {
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
        const h = rayVsPlayer(origin, d, rem.pos, maxT);
        if (h) {
          maxT = h.t;
          hitPlayer = true;
        }
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
      rem.speed = Math.hypot(src.vx, src.vz);
      const m = rem.model;
      const distToCam = this.camera.position.distanceTo(rem.pos);
      const isHiddenSpectator = src.survivalRole === 'spectator' && !src.alive;
      m.root.visible = !isHiddenSpectator;
      m.root.position.copy(rem.pos);
      m.root.rotation.y = rem.yaw;
      m.setWeapon(src.weapon);
      m.update(dt, { speed: rem.speed, onGround: src.onGround, pitch: rem.pitch, alive: src.alive, reloading: src.reloading });
      m.updateNameTagDistance(distToCam, src.alive);
      if (src.alive && src.onGround && rem.speed > 1.0) {
        rem.stepTimer -= dt;
        if (rem.stepTimer <= 0) {
          const sprinting = rem.speed > WALK_SPEED + 0.6;
          rem.stepTimer = sprinting ? 0.30 : 0.44;
          const surf = detectSurface(this.worldDef, rem.pos.x, rem.pos.y, rem.pos.z);
          this.audio.footstep({ x: rem.pos.x, y: rem.pos.y, z: rem.pos.z }, sprinting ? 0.6 : 0.38, surf);
        }
      }
    }

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
    const pivot = { x: renderPos.x, y: renderPos.y + lerp(EYE_HEIGHT, 1.65, e), z: renderPos.z };
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

    // O'zimizning 3D kemper modelimizni yangilash
    this.myModel.root.visible = useThird && !isMidJoinSpectator;
    this.myModel.root.position.set(renderPos.x, renderPos.y, renderPos.z);
    this.myModel.root.rotation.y = me.yaw;
    this.myModel.setWeapon(me.weapon);
    this.myModel.update(dt, {
      speed: me.speedH(),
      onGround: me.body.onGround,
      pitch: me.pitch,
      alive: me.alive,
      reloading: !!me.reloadWeapon,
    });

    // Reset proximity fade on remote models before spectator camera update
    for (const rem of this.remotes.values()) {
      rem.model.setCameraProximityFade(10);
    }

    if (me.alive) {
      this.spectator.setActive(false);
      this.lastSpectatorPose = null;
      const target = renderPos.y + EYE_HEIGHT;
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
        const maxDist = 2.35;
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
        me.yaw,
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
    const tCull0 = this.benchCapturing ? performance.now() : 0;
    this.world.update?.(cam, cullTargetPos, useThird && !hasDevOv);
    if (this.benchCapturing) {
      this.benchCullTimesMs.push(performance.now() - tCull0);
    }
    this.vm.visible = me.alive && !scoped && !useThird && !hasDevOv;
    this.vm.update(dt, me.speedH(), me.body.onGround, this.input.mouseDX, this.input.mouseDY);
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
      if (this.mode === 'tdm') {
        for (const rem of this.remotes.values()) {
          if (rem.team !== me.team) continue;
          allies.push({ x: rem.pos.x, z: rem.pos.z, team: rem.team, alive: rem.alive });
        }
      }
      this.miniMap.update(center, allies, this.zoneSnap ? this.currentZoneForMinimap(t) : null);
    }
    this.updateZone(t);
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
    const gl = this.benchCapturing && this.gpuTimerExt ? (r.getContext() as WebGL2RenderingContext) : null;
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
          this.benchGpuTimesMs.push(ns / 1e6);
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
    this.zoneWall?.dispose();
    this.zoneWall = null;
    this.hud.setZoneWarning(false, 0);
    this.chatOpen = false;
    this.hud.setChatOpen(false);
    this.hud.reset();
    this.hud.scoreboard(false, [], this.mode, this.myId, null, new Set());
    this.hud.show(false);
    this.hud.setLayout(false, false);
    $('pause-menu').classList.add('hidden');
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
    if (import.meta.env.DEV) {
      window.__DEV_GAME_TOOLS__ = null;
      window.__DEV_PLAYER_POSE_LOCK__ = null;
    }
  }
}
