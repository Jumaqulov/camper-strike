import type * as THREE from 'three';
import type { Socket } from 'socket.io-client';
import { EYE_HEIGHT } from '../../../shared/constants';
import { clamp, type Vec3 } from '../../../shared/math';
import type {
  ClientState,
  ContainerOpenAck,
  EquipWeaponAck,
  LootPickupAck,
  MatchState,
  PlayerInventorySnap,
  PlayerSnap,
  RoomLootSnapshot,
  ShootMsg,
  UseMedkitAck,
} from '../../../shared/protocol';
import { WEAPONS, type WeaponId } from '../../../shared/weapons';
import { sampleTerrainHeight, type WorldDefinition, type WorldMeta } from '../../../shared/world';
import type { QualityLevel, Settings } from '../../settings';
import type { PredictionDiagnostics } from '../ClientPrediction';
import type { LocalPlayer } from '../LocalPlayer';
import type { ViewModel } from '../ViewModel';
import type { CharacterModelDiag, Stickman } from '../Stickman';
import { getCharacterAssetDiagnostics } from '../character/CharacterAssetRegistry';
import type {
  InventoryUI,
  InventoryUIDiagnostics,
  LootUI,
  LootUIDiagnostics,
  LootWorldRenderer,
  LootWorldRendererDiagnostics,
} from '../loot';
import type {
  SpectatableTarget,
  SpectatorController,
  SpectatorDiagnostics,
  SurvivalUI,
  SurvivalUIDiagnostics,
} from '../survival';
import { getBuildingAssetDiagnostics } from '../buildings';
import { getContainerAssetDiagnostics } from '../containers';
import { getForestAssetDiagnostics } from '../ForestAssetRegistry';
import type { CullingProfileStats } from '../ForestRenderer';
import { getInteriorAssetDiagnostics } from '../interiors';
import {
  getOutdoorAssetDiagnostics,
  type OutdoorAssetDiagnosticEntry,
  type OutdoorRendererDiagnostics,
} from '../outdoor';
import { getWeaponAssetDiagnostics } from '../WeaponAssetRegistry';
import { getGrassAssetDiagnostics, type GrassAssetDiagnostics } from '../grass/GrassAssetRegistry';
import type { GroundCoverStats } from '../GroundCoverRenderer';
import type { WorldHandles } from '../World';
import type { CollisionDebugInfo, CollisionDebugOverlay } from './CollisionDebugOverlay';

/**
 * DEV-only o'yin asboblari (`window.__DEV_GAME_TOOLS__`): QA skriptlari (scripts/qa-*.mjs) benchmark,
 * tarmoq simulyatsiyasi, sintetik kirish, poza qulfi, loot/survival diagnostikasi uchun shu obyektni
 * ishlatadi. `Game` o'z ichki holatini tor `DevGameHooks` interfeysi orqali beradi — bu modul Game'ning
 * boshqa qismlariga tegmaydi. Faqat `import.meta.env.DEV` rejimida o'rnatiladi (Game shuni kafolatlaydi).
 */

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

/** Tarmoq simulyatsiyasi: RTT, jitter va paket yo'qotish ulushi (0..0.95). */
export interface NetSimConfig {
  rttMs: number;
  jitterMs: number;
  dropRate: number;
}

/** QA skriptlari uchun sintetik kirish (klaviatura/sichqoncha o'rniga). */
export interface DevSyntheticInput {
  fwd: number;
  right: number;
  jump: boolean;
  walk: boolean;
  yaw?: number;
  pitch?: number;
}

/** Benchmark yozuvi: Game kadr sikli shu massivlarni to'ldiradi, asboblar esa statistikani hisoblaydi. */
export interface BenchCaptureState {
  capturing: boolean;
  startMs: number;
  frameTimesMs: number[];
  cullTimesMs: number[];
  gpuTimesMs: number[];
}

export interface DevRenderStats {
  calls: number;
  sceneCalls: number;
  vmCalls: number;
  triangles: number;
  sceneTris: number;
  vmTris: number;
  geometries: number;
  textures: number;
}

/** Masofaviy o'yinchining asboblarga kerak bo'lgan qismi (Game'dagi `Remote` bilan strukturaviy mos). */
export interface DevRemoteView {
  id: string;
  name: string;
  pos: { x: number; y: number; z: number };
  weapon: WeaponId | null;
  model: Stickman;
}

/** Game asboblarga beradigan tor interfeys: faqat kerakli obyektlar, getter/setter'lar va amallar. */
export interface DevGameHooks {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly socket: Socket;
  readonly me: LocalPlayer;
  readonly vm: ViewModel;
  readonly myModel: Stickman;
  readonly settings: Settings;
  readonly roomId: string;
  readonly isSurvival: boolean;
  readonly lootPreview: boolean;
  readonly lootUi: LootUI;
  readonly inventoryUi: InventoryUI;
  readonly lootWorld: LootWorldRenderer;
  readonly survivalUi: SurvivalUI;
  readonly spectator: SpectatorController;
  readonly bench: BenchCaptureState;
  readonly gpuTimerSupported: boolean;
  getWorld(): WorldHandles;
  getWorldDef(): WorldDefinition;
  getWorldMeta(): WorldMeta;
  /** Texnik relyef fixture'ini yuklaydi (dunyo, o'yinchi va kamera qayta joylanadi). */
  loadTechnicalTerrainFixture(): WorldMeta;
  /** Sifat darajasini saqlaydi va renderer/dunyoga qo'llaydi. */
  applyQuality(q: QualityLevel): void;
  getRenderStats(): DevRenderStats;
  /** DEV overlay'dagi FPS ko'rsatkichini benchmark natijasiga qotiradi (skrinshot uchun ~5 s). */
  pinDevOverlay(fps: number, frameMs: number): void;
  getThirdPerson(): boolean;
  setThirdPerson(tp: boolean): void;
  setPrevWeapon(w: WeaponId | null): void;
  setCamY(y: number): void;
  getPing(): number;
  getMatch(): MatchState | null;
  getLastAuthoritativeSnap(): PlayerSnap | null;
  getNetSim(): NetSimConfig;
  setNetSim(v: NetSimConfig): void;
  setSyntheticInput(v: DevSyntheticInput | null): void;
  getLootSnapshot(): RoomLootSnapshot | null;
  getInventorySnap(): PlayerInventorySnap | null;
  getRemotes(): Iterable<DevRemoteView>;
  getCollisionDebug(): CollisionDebugOverlay | null;
  getSpectatableTargets(): SpectatableTarget[];
  sendInput(): void;
  fireLocal(t: number): void;
  requestOpenContainer(containerId: string, requestId?: string): Promise<ContainerOpenAck>;
  requestPickupItem(containerId: string | null, itemId: string, requestId?: string): Promise<LootPickupAck>;
  requestEquipWeapon(weapon: WeaponId | null, requestId?: string): Promise<EquipWeaponAck>;
  requestUseMedkit(requestId?: string): Promise<UseMedkitAck>;
  onLootSnapshot(s: RoomLootSnapshot): void;
  onInventoryState(inv: PlayerInventorySnap): void;
}

export interface DevGameTools {
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
  getRenderStats: () => DevRenderStats;
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
    render: DevRenderStats;
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
  setDevContainersOpen: (openFraction: number | null, containerId?: string, damped?: boolean) => void;
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
    netSim: NetSimConfig;
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
  pickupLootItem: (containerId: string | null, itemId: string, requestId?: string) => Promise<LootPickupAck>;
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
}

declare global {
  interface Window {
    __DEV_CAMERA_OVERRIDE__?: DevCameraOverride | null;
    __DEV_PLAYER_POSE_LOCK__?: DevPlayerPoseLock | null;
    __DEV_GAME_TOOLS__?: DevGameTools | null;
  }
}

/**
 * `window.__DEV_GAME_TOOLS__` ni o'rnatadi; qaytarilgan funksiya uni (va poza qulfini) olib tashlaydi.
 * Obyektning ommaviy shakli o'zgarmaydi — QA skriptlari unga tayanadi.
 */
export function installDevGameTools(h: DevGameHooks): () => void {
  const me = h.me;
  const tools: DevGameTools = {
    setWeapon: (w: WeaponId | null) => {
      me.weapon = w;
      h.setPrevWeapon(w);
      h.vm.setWeapon(w);
      h.myModel.setWeapon(w);
    },
    setThirdPerson: (tp: boolean) => {
      h.setThirdPerson(tp);
    },
    triggerFireAnim: () => {
      if (!me.weapon) return;
      h.vm.fire(WEAPONS[me.weapon].recoil);
      h.myModel.muzzleFlash();
    },
    triggerReloadAnim: () => {
      if (!me.weapon) return;
      h.vm.startReload(WEAPONS[me.weapon].reloadTime);
    },
    getPlayerTransform: () => ({
      x: me.body.pos.x,
      y: me.body.pos.y,
      z: me.body.pos.z,
      yaw: me.yaw,
      onGround: me.body.onGround,
    }),
    getDiagnostics: () => getWeaponAssetDiagnostics(),
    getForestDiagnostics: () => getForestAssetDiagnostics(),
    getWorldMeta: () => h.getWorldMeta(),
    loadTechnicalTerrainFixture: () => h.loadTechnicalTerrainFixture(),
    setQuality: (q: QualityLevel) => {
      h.applyQuality(q);
    },
    getRenderStats: () => ({ ...h.getRenderStats() }),
    getCullingProfile: () => h.getWorld().getCullingProfile?.() ?? null,
    resetCullingProfile: () => h.getWorld().resetCullingProfile?.(),
    startBenchmarkCapture: () => {
      h.getWorld().resetCullingProfile?.();
      const b = h.bench;
      b.frameTimesMs.length = 0;
      b.cullTimesMs.length = 0;
      b.gpuTimesMs.length = 0;
      b.startMs = performance.now();
      b.capturing = true;
    },
    stopBenchmarkCapture: () => {
      const b = h.bench;
      b.capturing = false;
      const durationMs = Math.max(1, performance.now() - b.startMs);
      const ft = [...b.frameTimesMs].sort((a, c) => a - c);
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

      const ct = [...b.cullTimesMs].sort((a, c) => a - c);
      const gt = [...b.gpuTimesMs].sort((a, c) => a - c);
      const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;

      // Pin the measured sustained median FPS / frame-time into the DEV overlay so screenshots
      // captured immediately after stopBenchmarkCapture() display the exact sustained benchmark numbers
      if (fpsMedian > 0) {
        h.pinDevOverlay(Math.round(fpsMedian), frameTimeMedianMs);
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
        gpuTimerSupported: h.gpuTimerSupported,
        gpuTimeMedianMs: gt.length > 0 ? Number(pct(gt, 0.5).toFixed(3)) : null,
        gpuTimeP95Ms: gt.length > 0 ? Number(pct(gt, 0.95).toFixed(3)) : null,
        render: { ...h.getRenderStats() },
        culling: h.getWorld().getCullingProfile?.() ?? null,
        heapUsedMB: perfMem ? Number((perfMem.usedJSHeapSize / (1024 * 1024)).toFixed(2)) : null,
        heapTotalMB: perfMem ? Number((perfMem.totalJSHeapSize / (1024 * 1024)).toFixed(2)) : null,
      };
    },
    setPlayerPos: (x: number, z: number, yaw = me.yaw, yOverride?: number, pitch = 0) => {
      const y = yOverride ?? sampleTerrainHeight(h.getWorldDef().terrain, x, z);
      me.alive = true;
      me.hp = 100;
      me.body.pos = { x, y, z };
      me.body.vel = { x: 0, y: 0, z: 0 };
      me.body.onGround = true;
      me.yaw = yaw;
      me.pitch = pitch;
      h.setCamY(y + EYE_HEIGHT);
      me.resetPrediction();
      window.__DEV_PLAYER_POSE_LOCK__ = { x, y, z, yaw, pitch };
      return {
        x: me.body.pos.x,
        y: me.body.pos.y,
        z: me.body.pos.z,
        yaw: me.yaw,
        pitch: me.pitch,
        onGround: me.body.onGround,
      };
    },
    getCameraState: () => ({
      x: h.camera.position.x,
      y: h.camera.position.y,
      z: h.camera.position.z,
      yaw: h.camera.rotation.y,
      pitch: h.camera.rotation.x,
      thirdPerson: h.getThirdPerson(),
    }),
    getCoverTestFixtures: () => {
      const worldDef = h.getWorldDef();
      const allBushes = worldDef.visuals.filter((v) => v.batchKey === 'foliage:bush');
      const trees = worldDef.visuals.filter((v) => v.category === 'tree');
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

      const spruces = worldDef.visuals.filter((v) => {
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
      const b1 = h.scene.getObjectByName('inst_foliage:bush');
      const b2 = h.scene.getObjectByName('inst_foliage:bush_bark');
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
      h.getWorld().stage04a?.buildings.setDevDoorDemoAngle(angleRad, targetId);
    },
    setDevCabinetOpen: (openFraction: number | null) => {
      h.getWorld().stage04a?.interiors.setDevCabinetOpenFraction(openFraction);
    },
    setDevContainersOpen: (openFraction: number | null, containerId?: string, damped = false) => {
      h.getWorld().stage04a?.containers.setDevContainersOpenFraction(openFraction, containerId, damped);
    },
    setDevAnchorHelpers: (visible: boolean) => {
      h.getWorld().stage04a?.interiors.setAnchorHelpersVisible(visible);
      h.getWorld().stage04a?.containers.setAnchorHelpersVisible(visible);
    },
    stepInput: (fwd: number, right: number, jump: boolean, dt: number, steps: number) => {
      window.__DEV_PLAYER_POSE_LOCK__ = null;
      for (let i = 0; i < steps; i++) {
        me.move(dt, fwd, right, i === 0 ? jump : false, false);
        h.sendInput();
      }
      h.setCamY(me.body.pos.y + EYE_HEIGHT);
      return {
        x: me.body.pos.x,
        y: me.body.pos.y,
        z: me.body.pos.z,
        yaw: me.yaw,
        onGround: me.body.onGround,
      };
    },
    getPredictionDiagnostics: () => {
      const diag = me.prediction.getDiagnostics();
      const pred = {
        x: Number(me.body.pos.x.toFixed(4)),
        y: Number(me.body.pos.y.toFixed(4)),
        z: Number(me.body.pos.z.toFixed(4)),
      };
      const smoothedRaw = me.smoothedPos();
      const smoothed = {
        x: Number(smoothedRaw.x.toFixed(4)),
        y: Number(smoothedRaw.y.toFixed(4)),
        z: Number(smoothedRaw.z.toFixed(4)),
      };
      const lastAuth = h.getLastAuthoritativeSnap();
      const auth = lastAuth
        ? {
            x: Number(lastAuth.x.toFixed(4)),
            y: Number(lastAuth.y.toFixed(4)),
            z: Number(lastAuth.z.toFixed(4)),
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
        netSim: { ...h.getNetSim() },
      };
    },
    setNetSim: (opts) => {
      if (!opts) {
        h.setNetSim({ rttMs: 0, jitterMs: 0, dropRate: 0 });
        return;
      }
      h.setNetSim({
        rttMs: Math.max(0, Number(opts.rttMs ?? 0)),
        jitterMs: Math.max(0, Number(opts.jitterMs ?? 0)),
        dropRate: clamp(Number(opts.dropRate ?? 0), 0, 0.95),
      });
    },
    sendRawStatePacketForAdversarialTest: (state) => {
      const payload: ClientState = {
        spawnId: state.spawnId ?? me.spawnId,
        x: state.x ?? me.body.pos.x,
        y: state.y ?? me.body.pos.y,
        z: state.z ?? me.body.pos.z,
        vx: state.vx ?? 0,
        vy: state.vy ?? 0,
        vz: state.vz ?? 0,
        yaw: state.yaw ?? me.yaw,
        pitch: state.pitch ?? me.pitch,
        onGround: state.onGround ?? true,
        weapon: state.weapon ?? me.weapon,
        ping: state.ping ?? h.getPing(),
      };
      h.socket.emit('state', payload);
    },
    setSyntheticInput: (input) => {
      if (!input) {
        h.setSyntheticInput(null);
        return;
      }
      window.__DEV_PLAYER_POSE_LOCK__ = null;
      h.setSyntheticInput({
        fwd: clamp(Number(input.fwd ?? 0), -1, 1),
        right: clamp(Number(input.right ?? 0), -1, 1),
        jump: Boolean(input.jump),
        walk: Boolean(input.walk),
        ...(input.yaw !== undefined && Number.isFinite(input.yaw) ? { yaw: Number(input.yaw) } : {}),
        ...(input.pitch !== undefined && Number.isFinite(input.pitch)
          ? { pitch: clamp(Number(input.pitch), -1.55, 1.55) }
          : {}),
      });
    },
    clearPlayerPoseLock: () => {
      window.__DEV_PLAYER_POSE_LOCK__ = null;
    },
    triggerFire: () => {
      const t = performance.now() / 1000;
      if (!me.alive || !me.weapon || !me.canFire(t)) return false;
      const ammo = me.ammo[me.weapon];
      if (ammo.mag <= 0) return false;
      h.fireLocal(t);
      return true;
    },
    getLootDiagnostics: () => ({
      lootPreview: h.lootPreview,
      lootSnapshot: h.getLootSnapshot(),
      inventorySnap: h.getInventorySnap(),
      lootUi: h.lootUi.getDiagnostics(),
      inventoryUi: h.inventoryUi.getDiagnostics(),
      worldRenderer: h.lootWorld.getDiagnostics(),
    }),
    openContainerById: (containerId: string, requestId?: string) => h.requestOpenContainer(containerId, requestId),
    pickupLootItem: (containerId: string | null, itemId: string, requestId?: string) =>
      h.requestPickupItem(containerId, itemId, requestId),
    equipInventoryWeapon: (weapon: WeaponId | null, requestId?: string) => h.requestEquipWeapon(weapon, requestId),
    useMedkitItem: (requestId?: string) => h.requestUseMedkit(requestId),
    requestLootSync: () =>
      new Promise<{ loot: RoomLootSnapshot; inventory: PlayerInventorySnap | null }>((resolve) => {
        h.socket.emit(
          'loot:sync',
          {},
          (res: { loot: RoomLootSnapshot; inventory: PlayerInventorySnap | null }) => {
            if (res?.loot) h.onLootSnapshot(res.loot);
            if (res?.inventory) h.onInventoryState(res.inventory);
            resolve(res);
          },
        );
      }),
    sendRawShootPacketForAdversarialTest: (msg: ShootMsg) => {
      h.socket.emit('shoot', msg);
    },
    getSurvivalDiagnostics: () => ({
      isSurvival: h.isSurvival,
      match: h.getMatch(),
      survivalUi: h.survivalUi.getDiagnostics(),
      spectator: h.spectator.getDiagnostics(h.getSpectatableTargets()),
    }),
    cycleSpectatorTarget: (delta: number) => {
      const chosen = h.spectator.cycleTarget(delta, h.getSpectatableTargets());
      return chosen ? chosen.id : null;
    },
    setSpectatorTarget: (targetId: string | null) => {
      h.spectator.setTarget(targetId);
    },
    getOutdoorDiagnostics: () => {
      const assets = getOutdoorAssetDiagnostics();
      const renderer = h.getWorld().stage04a?.outdoor?.getDiagnostics() ?? null;
      const allLoaded = Object.values(assets).every((d) => d.loaded && !d.failed && !d.isFallback);
      return {
        assets,
        renderer,
        allLoaded,
      };
    },
    toggleCollisionDebug: (on?: boolean) => {
      const dbg = h.getCollisionDebug();
      if (!dbg) return false;
      dbg.setEnabled(on === undefined ? !dbg.isEnabled() : on);
      return dbg.isEnabled();
    },
    getCollisionDebugInfo: () => h.getCollisionDebug()?.getLastInfo() ?? null,
    getGroundCoverStats: () => h.getWorld().getGroundCoverStats?.() ?? null,
    getGrassAssetDiagnostics: () => getGrassAssetDiagnostics(),
    getGameplayHash: () => h.getWorldDef().gameplayHash,
    getWorldVersion: () => h.getWorldDef().worldVersion,
    getRoomId: () => h.roomId,
    getOtherPlayerCount: () => Array.from(h.getRemotes()).length,
    getOtherPlayers: () =>
      Array.from(h.getRemotes()).map((r) => ({
        id: r.id,
        name: r.name,
        pos: { x: r.pos.x, y: r.pos.y, z: r.pos.z },
        weapon: r.weapon,
      })),
    getContainersCount: () => h.getLootSnapshot()?.containers.length ?? 0,
    getCharacterDiagnostics: () => ({
      asset: getCharacterAssetDiagnostics(),
      local: h.myModel.getCharacterDiagnostics(),
      remotes: Array.from(h.getRemotes()).map((r) => ({
        id: r.id,
        ...r.model.getCharacterDiagnostics(),
      })),
    }),
  };
  window.__DEV_GAME_TOOLS__ = tools;
  return () => {
    window.__DEV_GAME_TOOLS__ = null;
    window.__DEV_PLAYER_POSE_LOCK__ = null;
  };
}
