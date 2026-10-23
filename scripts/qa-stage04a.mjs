#!/usr/bin/env node
/**
 * BOSQICH 04A — QA Automation, Real WebGL Screenshots & Benchmark Script
 *
 * Usage:
 *   node scripts/qa-stage04a.mjs [--warmup=2] [--duration=5] [--repeats=2]
 *
 * Performs:
 *   1. Starts Vite + Socket.IO dev server (`npm run dev`, if port 5173 is not already active)
 *      and Headless Chrome (1280x720, DPR=1, WebGL hardware/headless rendering).
 *   2. Verifies 2-client (`Client 1` + `Client 2`) room creation & join on `forest_assets_preview`,
 *      confirming identical `gameplayHash`, 0 console errors, 0 HTTP 404/network errors,
 *      and 100% loading of all 28 GLB assets (4 weapon + 7 forest + 8 building + 6 interior + 3 container).
 *   3. Captures 14 deterministic 1280x720 PNG screenshots in `docs/screenshots/stage04a/`:
 *      - 01_cabin_8x4_exterior.png
 *      - 02_room_4x4_exterior.png
 *      - 03_cabin_8x4_interior_stairs_loft.png
 *      - 04_room_4x4_interior_furniture.png
 *      - 05_door_closed_demo.png
 *      - 06_door_open_demo.png
 *      - 07_cabinet_closed_demo.png
 *      - 08_cabinet_open_demo.png
 *      - 09_containers_closed_demo.png
 *      - 10_containers_open_demo.png
 *      - 11_inside_building_1p.png
 *      - 12_inside_building_3p.png
 *      - 13_loft_second_floor_3p.png
 *      - 14_topdown_stage04a_compound.png
 *   4. Runs Stage 04A performance benchmark across representative scenes (`quality='medium'`, 1280x720)
 *      plus a 10x consecutive room join/leave memory & resource leak verification, saving results to
 *      `docs/stage04a/benchmark.json`.
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

const WARMUP_SEC = Number(args.warmup ?? 2);
const DURATION_SEC = Number(args.duration ?? 5);
const REPEATS = Number(args.repeats ?? 2);

const ROOT_DIR = process.cwd();
const SCREENSHOT_DIR = path.join(ROOT_DIR, 'docs', 'screenshots', 'stage04a');
const BENCHMARK_DIR = path.join(ROOT_DIR, 'docs', 'stage04a');
const BENCHMARK_JSON_PATH = path.join(BENCHMARK_DIR, 'benchmark.json');

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(BENCHMARK_DIR, { recursive: true });

function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Google Chrome executable topilmadi. CHROME_PATH muhit o‘zgaruvchisini belgilang.');
}

async function isHttpReady(url, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await delay(150);
  }
  return false;
}

async function waitForHttp(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/**
 * Computes Three.js YXZ camera `{ x, y, z, yaw, pitch }` looking from `eye` toward `target`.
 * Recall Three.js forward vector: `(-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))`.
 */
function lookAtCamera(eye, target) {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const horiz = Math.hypot(dx, dz) || 1e-6;
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, horiz);
  return {
    x: Number(eye.x.toFixed(3)),
    y: Number(eye.y.toFixed(3)),
    z: Number(eye.z.toFixed(3)),
    yaw: Number(yaw.toFixed(4)),
    pitch: Number(pitch.toFixed(4)),
  };
}

function medianOf(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

class CdpSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.networkErrors = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        if (msg.params?.type === 'error') {
          const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
          this.consoleErrors.push(text);
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(JSON.stringify(msg.params?.exceptionDetails ?? 'exception'));
      } else if (msg.method === 'Network.responseReceived') {
        const status = msg.params?.response?.status ?? 200;
        const url = msg.params?.response?.url ?? '';
        if (status >= 400) {
          this.networkErrors.push({ status, url });
        }
      } else if (msg.method === 'Network.loadingFailed') {
        const errText = msg.params?.errorText ?? '';
        if (errText && errText !== 'net::ERR_ABORTED') {
          this.networkErrors.push({ status: 'FAILED', errorText: errText });
        }
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async waitFor(predicateExpr, timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const val = await this.eval(predicateExpr);
      if (val) return val;
      await delay(150);
    }
    throw new Error(`Timed out waiting for: ${predicateExpr}`);
  }

  async screenshot(filename) {
    await this.send('Page.bringToFront');
    await delay(120);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    const outPath = path.join(SCREENSHOT_DIR, filename);
    fs.writeFileSync(outPath, buf);
    console.log(`  [screenshot] ${filename} (${buf.length} bytes)`);
    return { filename, bytes: buf.length, path: outPath };
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // ignore
  }
}

const BENCHMARK_SCENES = [
  {
    id: '01_cabin_8x4_exterior',
    description: '8x4 loft cabin exterior view from south-east courtyard',
    setup: `
      window.__DEV_GAME_TOOLS__.setDevDoorAngle(null);
      window.__DEV_GAME_TOOLS__.setDevCabinetOpen(null);
      window.__DEV_GAME_TOOLS__.setDevContainersOpen(null);
      window.__DEV_GAME_TOOLS__.setDevAnchorHelpers(false);
      window.__DEV_GAME_TOOLS__.setThirdPerson(false);
      window.__DEV_GAME_TOOLS__.setWeapon('rifle');
      window.__DEV_GAME_TOOLS__.setPlayerPos(8.0, 12.0, 0.0, undefined, 0.0);
      window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(
        lookAtCamera({ x: -3.5, y: 2.7, z: 0.5 }, { x: -7.0, y: 2.2, z: -6.0 }),
      )};
    `,
  },
  {
    id: '02_cabin_8x4_interior_1p',
    description: '1P inside 8x4 cabin looking at stairs, loft, furniture, and containers',
    setup: `
      window.__DEV_CAMERA_OVERRIDE__ = null;
      window.__DEV_GAME_TOOLS__.setThirdPerson(false);
      window.__DEV_GAME_TOOLS__.setWeapon('rifle');
      window.__DEV_GAME_TOOLS__.setPlayerPos(-9.2, -5.2, -1.12, 0.96, -0.05);
    `,
  },
  {
    id: '03_cabin_8x4_interior_3p',
    description: '3P inside 8x4 cabin with wall-safe pulled-in camera and stickman',
    setup: `
      window.__DEV_CAMERA_OVERRIDE__ = null;
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
      window.__DEV_GAME_TOOLS__.setWeapon('rifle');
      window.__DEV_GAME_TOOLS__.setPlayerPos(-8.5, -5.4, -1.08, 0.96, -0.08);
    `,
  },
  {
    id: '04_room_4x4_interior',
    description: 'Furnished 4x4 room interior with all 6 furniture types and 3 containers',
    setup: `
      window.__DEV_GAME_TOOLS__.setThirdPerson(false);
      window.__DEV_GAME_TOOLS__.setPlayerPos(8.0, 12.0, 0.0, undefined, 0.0);
      window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(
        lookAtCamera({ x: -12.0, y: 3.15, z: 5.82 }, { x: -12.0, y: 1.35, z: 3.25 }),
      )};
    `,
  },
  {
    id: '05_topdown_stage04a_compound',
    description: 'Top-down compound view of cabin_8x4 and room_4x4 in 96x96 forest',
    setup: `
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
      window.__DEV_GAME_TOOLS__.setPlayerPos(-8.5, -1.2, 0.0, undefined, 0.0);
      window.__DEV_CAMERA_OVERRIDE__ = { x: -9, y: 38, z: 14, yaw: 0, pitch: -1.18 };
    `,
  },
];

async function main() {
  const chromePath = findChromePath();
  const debugPort = 9244;
  console.log(
    `[Stage 04A QA] Starting QA, Screenshots & Benchmark (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS})...`,
  );

  let serverProc = null;
  const serverAlreadyRunning = await isHttpReady('http://localhost:5173/api/info', 1500);
  if (!serverAlreadyRunning) {
    console.log('[Stage 04A QA] Starting dev server (`npm run dev`)...');
    serverProc = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
      cwd: ROOT_DIR,
      stdio: 'pipe',
    });
  } else {
    console.log('[Stage 04A QA] Reusing active server on http://localhost:5173');
  }

  const userDataDir = path.join(os.tmpdir(), `stickman_qa_stage04a_${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  let chromeProc = null;
  try {
    // Wait for both Vite (5173) and backend API proxy (/api/info -> 3000) to be ready before launching Chrome
    await waitForHttp('http://localhost:5173/api/info', 30000);

    chromeProc = spawn(
      chromePath,
      [
        '--headless=new',
        `--remote-debugging-port=${debugPort}`,
        '--window-size=1280,720',
        '--force-device-scale-factor=1',
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--enable-precise-memory-info',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
        'http://localhost:5173',
      ],
      { stdio: 'pipe' },
    );

    await waitForHttp(`http://127.0.0.1:${debugPort}/json/list`, 20000);
    const versionInfo = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const pageTarget1 = targets.find((t) => t.type === 'page');
    if (!pageTarget1) throw new Error('Chrome page target topilmadi');

    const cdp1 = new CdpSession(pageTarget1.webSocketDebuggerUrl);
    await cdp1.connect();
    await cdp1.send('Page.enable');
    await cdp1.send('Runtime.enable');
    await cdp1.send('Network.enable');
    await cdp1.send('Page.bringToFront');
    await cdp1.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp1.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // =========================================================================
    // STEP 1: Client 1 creates `forest_assets_preview` room (0 bots for clean QA)
    // =========================================================================
    console.log('[Stage 04A QA] Connecting Client 1 and creating `forest_assets_preview` room...');
    await cdp1.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`);
    await cdp1.eval(`
      (() => {
        document.getElementById('name-input').value = 'QA_Stage04A_1';
        document.getElementById('btn-enter').click();
      })()
    `);
    await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
    await cdp1.eval(`
      (() => {
        document.getElementById('room-map').value = 'forest_assets_preview';
        document.getElementById('room-mode').value = 'ffa';
        document.getElementById('room-name').value = 'Stage04A_Preview_QA';
        document.getElementById('room-bots').value = '0';
        document.getElementById('btn-create').click();
      })()
    `);

    await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await cdp1.waitFor(`
      (() => {
        const w = window.__DEV_GAME_TOOLS__.getDiagnostics();
        const f = window.__DEV_GAME_TOOLS__.getForestDiagnostics();
        const s = window.__DEV_GAME_TOOLS__.getStage04ADiagnostics();
        const wOk = Object.values(w).every((d) => d.loaded && !d.failed);
        const fOk = Object.values(f).every((d) => d.loaded && !d.failed);
        return wOk && fOk && s.allLoaded;
      })()
    `);

    // Hide pause overlay and show dev-stats cleanly
    await cdp1.eval(`
      (() => {
        const st = document.createElement('style');
        st.textContent = '#pause-menu, #center-msg, #scoreboard, #death-screen { display: none !important; } #dev-stats { display: block !important; }';
        document.head.appendChild(st);
        window.__DEV_GAME_TOOLS__.setQuality('medium');
      })()
    `);

    // =========================================================================
    // STEP 2: Client 2 joins the same `forest_assets_preview` room & verifies sync
    // =========================================================================
    console.log('[Stage 04A QA] Connecting Client 2 to verify multiplayer gameplayHash & 28 GLBs...');
    const newTargetRes = await fetch(`http://127.0.0.1:${debugPort}/json/new?http://localhost:5173`, {
      method: 'PUT',
    });
    const pageTarget2 = await newTargetRes.json();
    const cdp2 = new CdpSession(pageTarget2.webSocketDebuggerUrl);
    await cdp2.connect();
    await cdp2.send('Page.enable');
    await cdp2.send('Runtime.enable');
    await cdp2.send('Network.enable');
    await cdp2.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`);
    await cdp2.eval(`
      (() => {
        document.getElementById('name-input').value = 'QA_Stage04A_2';
        document.getElementById('btn-enter').click();
      })()
    `);
    await cdp2.waitFor(`Boolean(document.querySelector('[data-join]'))`);
    await cdp2.eval(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('[data-join]'));
        buttons[buttons.length - 1].click();
      })()
    `);
    await cdp2.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await cdp2.waitFor(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics().allLoaded === true`);

    const client1Meta = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getWorldMeta()`);
    const client2Meta = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getWorldMeta()`);
    const weaponDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getDiagnostics()`);
    const forestDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getForestDiagnostics()`);
    const stage04aDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics()`);

    const weaponCount = Object.keys(weaponDiag).length;
    const forestCount = Object.keys(forestDiag).length;
    const buildingCount = Object.keys(stage04aDiag.buildings).length;
    const interiorCount = Object.keys(stage04aDiag.interiors).length;
    const containerCount = Object.keys(stage04aDiag.containers).length;
    const totalGlbCount = weaponCount + forestCount + buildingCount + interiorCount + containerCount;

    if (client1Meta.gameplayHash !== client2Meta.gameplayHash) {
      throw new Error(
        `GameplayHash mismatch: Client1=${client1Meta.gameplayHash} vs Client2=${client2Meta.gameplayHash}`,
      );
    }
    if (totalGlbCount !== 28 || !stage04aDiag.allLoaded) {
      throw new Error(`Expected 28 GLBs loaded, got total=${totalGlbCount}, allLoaded=${stage04aDiag.allLoaded}`);
    }
    console.log(
      `  [verified] Client1 & Client2 gameplayHash=${client1Meta.gameplayHash} (mapId=${client1Meta.mapId}, seed=${client1Meta.publicLayoutSeed})`,
    );
    console.log(
      `  [verified] All ${totalGlbCount} GLB assets loaded (${weaponCount} weapon + ${forestCount} forest + ${buildingCount} building + ${interiorCount} interior + ${containerCount} container), 0 fallbacks.`,
    );

    // Park Client 2 inside the cabin loft or yard for visual/multiplayer presence, then disconnect Client 2 after verification
    await cdp2.eval(`window.__DEV_GAME_TOOLS__.setPlayerPos(15.0, 15.0, 0.0)`);
    cdp2.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${pageTarget2.id}`);

    // Bring Client 1 to front for all screenshots & benchmarks
    await cdp1.send('Page.bringToFront');
    await delay(300);

    // =========================================================================
    // STEP 3: Capture 14 Real WebGL Screenshots (1280x720 PNG)
    // =========================================================================
    console.log('\n[Stage 04A QA] Capturing 14 deterministic WebGL screenshots...');
    const screenshots = [];

    const captureWithSetup = async (filename, setupJs, waitMs = 350) => {
      await cdp1.eval(setupJs);
      await delay(waitMs);
      const info = await cdp1.screenshot(filename);
      screenshots.push(info);
    };

    // 1. 01_cabin_8x4_exterior.png — SE view (-3.5, 2.7, 0.5) -> (-7, 2.2, -6)
    const cam01 = lookAtCamera({ x: -3.5, y: 2.7, z: 0.5 }, { x: -7.0, y: 2.2, z: -6.0 });
    await captureWithSetup(
      '01_cabin_8x4_exterior.png',
      `
        window.__DEV_GAME_TOOLS__.setDevDoorAngle(null);
        window.__DEV_GAME_TOOLS__.setDevCabinetOpen(null);
        window.__DEV_GAME_TOOLS__.setDevContainersOpen(null);
        window.__DEV_GAME_TOOLS__.setDevAnchorHelpers(false);
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(10.0, 10.0, 0.0, undefined, 0.0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam01)};
      `,
    );

    // 2. 02_room_4x4_exterior.png — (-8.5, 2.5, 10.2) -> (-12, 2.0, 4)
    const cam02 = lookAtCamera({ x: -8.5, y: 2.5, z: 10.2 }, { x: -12.0, y: 2.0, z: 4.0 });
    await captureWithSetup(
      '02_room_4x4_exterior.png',
      `
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam02)};
      `,
    );

    // 3. 03_cabin_8x4_interior_stairs_loft.png — inside cabin_8x4 showing wood_stairs_01, y=3.96 loft, furniture & containers
    const cam03 = lookAtCamera({ x: -9.55, y: 2.55, z: -4.95 }, { x: -5.4, y: 2.15, z: -6.2 });
    await captureWithSetup(
      '03_cabin_8x4_interior_stairs_loft.png',
      `
        window.__DEV_GAME_TOOLS__.setDevDoorAngle(0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam03)};
      `,
    );

    // 4. 04_room_4x4_interior_furniture.png — inside room_4x4 showing bed, sofa, cabinet, table, chairs, shelf, and 3 containers
    const cam04 = lookAtCamera({ x: -11.85, y: 3.05, z: 5.72 }, { x: -12.15, y: 1.3, z: 3.35 });
    await captureWithSetup(
      '04_room_4x4_interior_furniture.png',
      `
        window.__DEV_GAME_TOOLS__.setDevDoorAngle(0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam04)};
      `,
    );

    // 5 & 6. 05_door_closed_demo.png and 06_door_open_demo.png — wood_door_01 at (-9, 0.96, -4)
    const camDoor = lookAtCamera({ x: -8.35, y: 2.2, z: -1.35 }, { x: -9.05, y: 1.95, z: -4.15 });
    await captureWithSetup(
      '05_door_closed_demo.png',
      `
        window.__DEV_GAME_TOOLS__.setDevDoorAngle(0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(camDoor)};
      `,
    );
    await captureWithSetup(
      '06_door_open_demo.png',
      `
        window.__DEV_GAME_TOOLS__.setDevDoorAngle(1.38);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(camDoor)};
      `,
    );
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setDevDoorAngle(null)`);

    // 7 & 8. 07_cabinet_closed_demo.png and 08_cabinet_open_demo.png — kitchen_cabinet_01 at (-3.45, 0.96, -6.75) in cabin_8x4
    const camCabinet = lookAtCamera({ x: -5.15, y: 2.05, z: -6.15 }, { x: -3.45, y: 1.42, z: -6.75 });
    await captureWithSetup(
      '07_cabinet_closed_demo.png',
      `
        window.__DEV_GAME_TOOLS__.setDevCabinetOpen(0);
        window.__DEV_GAME_TOOLS__.setDevAnchorHelpers(false);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(camCabinet)};
      `,
    );
    await captureWithSetup(
      '08_cabinet_open_demo.png',
      `
        window.__DEV_GAME_TOOLS__.setDevCabinetOpen(1);
        window.__DEV_GAME_TOOLS__.setDevAnchorHelpers(true);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(camCabinet)};
      `,
    );
    await cdp1.eval(`
      window.__DEV_GAME_TOOLS__.setDevCabinetOpen(null);
      window.__DEV_GAME_TOOLS__.setDevAnchorHelpers(false);
    `);

    // 9 & 10. 09_containers_closed_demo.png and 10_containers_open_demo.png — all 3 containers in room_4x4
    // (metal_locker_01 at (-12.5, 0.96, 2.38), old_toolbox_01 at (-10.54, 1.71, 4.0), wooden_loot_crate_01 at (-10.58, 0.96, 5.55))
    const camContainers = lookAtCamera({ x: -13.55, y: 2.55, z: 4.95 }, { x: -11.35, y: 1.32, z: 3.75 });
    await captureWithSetup(
      '09_containers_closed_demo.png',
      `
        window.__DEV_GAME_TOOLS__.setDevDoorAngle(0);
        window.__DEV_GAME_TOOLS__.setDevContainersOpen(0, undefined, false);
        window.__DEV_GAME_TOOLS__.setDevAnchorHelpers(false);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(camContainers)};
      `,
    );
    await captureWithSetup(
      '10_containers_open_demo.png',
      `
        window.__DEV_GAME_TOOLS__.setDevDoorAngle(0);
        window.__DEV_GAME_TOOLS__.setDevContainersOpen(1, undefined, false);
        window.__DEV_GAME_TOOLS__.setDevAnchorHelpers(true);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(camContainers)};
      `,
    );
    await cdp1.eval(`
      window.__DEV_GAME_TOOLS__.setDevDoorAngle(null);
      window.__DEV_GAME_TOOLS__.setDevContainersOpen(null);
      window.__DEV_GAME_TOOLS__.setDevAnchorHelpers(false);
    `);

    // 11. 11_inside_building_1p.png — Player in 1P inside cabin_8x4 with weapon viewmodel
    await captureWithSetup(
      '11_inside_building_1p.png',
      `
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(-9.2, -5.2, -1.12, 0.96, -0.05);
      `,
      400,
    );

    // 12. 12_inside_building_3p.png — Player in 3P inside cabin_8x4 with wall-safe pulled-in camera
    await captureWithSetup(
      '12_inside_building_3p.png',
      `
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(-8.5, -5.4, -1.08, 0.96, -0.08);
      `,
      400,
    );
    const camInside3P = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getCameraState()`);

    // 13. 13_loft_second_floor_3p.png — Player in 3P standing on 2nd-floor loft (y = 3.96m)
    const camLoft3P = lookAtCamera({ x: -8.2, y: 4.65, z: -6.0 }, { x: -5.5, y: 4.4, z: -5.8 });
    await captureWithSetup(
      '13_loft_second_floor_3p.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('sniper');
        window.__DEV_GAME_TOOLS__.setPlayerPos(-6.1, -5.95, 1.35, 3.96, 0.0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(camLoft3P)};
      `,
      400,
    );
    const loftPlayerTransform = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPlayerTransform()`);

    // 14. 14_topdown_stage04a_compound.png — Top-down view at (x: -9, y: 38, z: 14, yaw: 0, pitch: -1.18)
    await captureWithSetup(
      '14_topdown_stage04a_compound.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setPlayerPos(-8.5, -1.2, 0.0, undefined, 0.0);
        window.__DEV_CAMERA_OVERRIDE__ = { x: -9, y: 38, z: 14, yaw: 0, pitch: -1.18 };
      `,
      400,
    );

    // =========================================================================
    // STEP 4: Benchmark on `forest_assets_preview` (4 bots, 1280x720, medium)
    // =========================================================================
    console.log('\n[Stage 04A QA] Recreating room with 4 bots for sustained performance benchmark...');
    await cdp1.eval(`document.getElementById('btn-leave').click()`);
    await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
    await cdp1.eval(`
      (() => {
        document.getElementById('room-map').value = 'forest_assets_preview';
        document.getElementById('room-mode').value = 'ffa';
        document.getElementById('room-name').value = 'Stage04A_Benchmark_4Bots';
        document.getElementById('room-bots').value = '4';
        document.getElementById('btn-create').click();
      })()
    `);
    await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics().allLoaded === true`);
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setQuality('medium')`);
    await delay(400);

    const gpuInfo = await cdp1.eval(`
      (() => {
        const c = document.querySelector('canvas');
        const gl = c?.getContext('webgl2') || c?.getContext('webgl');
        if (!gl) return { vendor: 'unknown', renderer: 'unknown' };
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          version: gl.getParameter(gl.VERSION),
        };
      })()
    `);

    const cpus = os.cpus();
    const benchmarkReport = {
      stage: 'BOSQICH 04A — Buildings, Interiors & Loot Containers',
      timestamp: new Date().toISOString(),
      methodology: {
        warmupSeconds: WARMUP_SEC,
        measurementSeconds: DURATION_SEC,
        repeatsPerScene: REPEATS,
        viewport: '1280x720',
        devicePixelRatio: 1,
        quality: 'medium',
        bots: 4,
        mapId: client1Meta.mapId,
        worldVersion: client1Meta.worldVersion,
        publicLayoutSeed: client1Meta.publicLayoutSeed,
        gameplayHash: client1Meta.gameplayHash,
      },
      environment: {
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        cpuModel: cpus[0]?.model ?? 'unknown',
        cpuCores: cpus.length,
        totalRamGB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
        nodeVersion: process.version,
        chromeVersion: versionInfo.Browser,
        userAgent: versionInfo['User-Agent'],
        gpu: gpuInfo,
      },
      verification: {
        multiplayerSync: {
          client1GameplayHash: client1Meta.gameplayHash,
          client2GameplayHash: client2Meta.gameplayHash,
          gameplayHashMatch: client1Meta.gameplayHash === client2Meta.gameplayHash,
        },
        glbAssets: {
          totalExpected: 28,
          totalLoaded: totalGlbCount,
          weaponAssetsLoaded: weaponCount,
          forestAssetsLoaded: forestCount,
          buildingAssetsLoaded: buildingCount,
          interiorAssetsLoaded: interiorCount,
          containerAssetsLoaded: containerCount,
          allStage04ALoadedWithoutFallback: stage04aDiag.allLoaded,
          buildings: stage04aDiag.buildings,
          interiors: stage04aDiag.interiors,
          containers: stage04aDiag.containers,
        },
        indoorGameplayChecks: {
          cameraInside3P: camInside3P,
          cameraStayedInsideCabinWalls:
            camInside3P.x >= -11.0 &&
            camInside3P.x <= -3.0 &&
            camInside3P.z >= -8.0 &&
            camInside3P.z <= -4.0,
          loftSecondFloorPlayerPos: loftPlayerTransform,
          loftElevationVerified: Math.abs(loftPlayerTransform.y - 3.96) < 0.05,
        },
        consoleErrorsCount: cdp1.consoleErrors.length + cdp2.consoleErrors.length,
        networkErrorsCount: cdp1.networkErrors.length + cdp2.networkErrors.length,
      },
      scenes: {},
      qualityPresets: {},
      roomReloadMemoryTrend: [],
      screenshots: screenshots.map((s) => ({
        filename: s.filename,
        bytes: s.bytes,
      })),
    };

    for (const sc of BENCHMARK_SCENES) {
      console.log(
        `\n[Benchmark Scene ${sc.id}] Running ${REPEATS} repeats (${WARMUP_SEC}s warmup + ${DURATION_SEC}s measure)...`,
      );
      const runs = [];
      for (let rep = 1; rep <= REPEATS; rep++) {
        await cdp1.send('Page.bringToFront');
        await cdp1.eval(sc.setup);
        await delay(WARMUP_SEC * 1000);
        await cdp1.eval(`window.__DEV_GAME_TOOLS__.startBenchmarkCapture()`);
        await delay(DURATION_SEC * 1000);
        const res = await cdp1.eval(`window.__DEV_GAME_TOOLS__.stopBenchmarkCapture()`);
        runs.push({ repeat: rep, ...res });
        console.log(
          `  [${sc.id} #${rep}] frames=${res.frames} | FPS med=${res.fpsMedian} p10=${res.fpsP10} 1%low=${res.fps1PctLow} | FT med=${res.frameTimeMedianMs}ms p95=${res.frameTimeP95Ms}ms | Draw=${res.render.calls} Tris=${res.render.triangles}`,
        );
      }

      benchmarkReport.scenes[sc.id] = {
        description: sc.description,
        fpsMedian: Number(medianOf(runs.map((r) => r.fpsMedian)).toFixed(2)),
        fpsP10: Number(medianOf(runs.map((r) => r.fpsP10)).toFixed(2)),
        fps1PctLow: Number(medianOf(runs.map((r) => r.fps1PctLow)).toFixed(2)),
        fpsMean: Number(medianOf(runs.map((r) => r.fpsMean)).toFixed(2)),
        frameTimeMedianMs: Number(medianOf(runs.map((r) => r.frameTimeMedianMs)).toFixed(3)),
        frameTimeP95Ms: Number(medianOf(runs.map((r) => r.frameTimeP95Ms)).toFixed(3)),
        frameTimeP99Ms: Number(medianOf(runs.map((r) => r.frameTimeP99Ms)).toFixed(3)),
        cullCpuMedianMs: Number(medianOf(runs.map((r) => r.cullCpuMedianMs)).toFixed(4)),
        cullCpuP95Ms: Number(medianOf(runs.map((r) => r.cullCpuP95Ms)).toFixed(4)),
        drawCalls: runs[runs.length - 1].render.calls,
        sceneCalls: runs[runs.length - 1].render.sceneCalls,
        vmCalls: runs[runs.length - 1].render.vmCalls,
        triangles: runs[runs.length - 1].render.triangles,
        geometries: runs[runs.length - 1].render.geometries,
        textures: runs[runs.length - 1].render.textures,
        heapUsedMB: runs[runs.length - 1].heapUsedMB,
        runs,
      };
    }

    // Quality Presets (low / medium / high) on 01_cabin_8x4_exterior
    console.log('\n[Stage 04A QA] Measuring Quality Presets (low / medium / high)...');
    await cdp1.eval(BENCHMARK_SCENES[0].setup);
    for (const q of ['low', 'medium', 'high']) {
      await cdp1.eval(`window.__DEV_GAME_TOOLS__.setQuality('${q}')`);
      await delay(500);
      await cdp1.eval(`window.__DEV_GAME_TOOLS__.startBenchmarkCapture()`);
      await delay(2500);
      benchmarkReport.qualityPresets[q] = await cdp1.eval(
        `window.__DEV_GAME_TOOLS__.stopBenchmarkCapture()`,
      );
    }
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setQuality('medium')`);

    // =========================================================================
    // STEP 5: 10x Consecutive Room Join / Leave Memory & Resource Leak Check
    // =========================================================================
    console.log('\n[Stage 04A QA] Running 10x consecutive room join/leave memory & disposal check...');
    for (let cycle = 1; cycle <= 10; cycle++) {
      await cdp1.eval(`document.getElementById('btn-leave').click()`);
      await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
      await delay(180);
      await cdp1.eval(`
        (() => {
          document.getElementById('room-map').value = 'forest_assets_preview';
          document.getElementById('room-name').value = 'Stage04A_MemCycle_${cycle}';
          document.getElementById('room-bots').value = '4';
          document.getElementById('btn-create').click();
        })()
      `);
      await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
      await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics().allLoaded === true`);
      await delay(350);

      const memSample = await cdp1.eval(`({
        cycle: ${cycle},
        render: window.__DEV_GAME_TOOLS__.getRenderStats(),
        heapUsedMB: performance.memory ? Number((performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2)) : null,
        heapTotalMB: performance.memory ? Number((performance.memory.totalJSHeapSize / (1024 * 1024)).toFixed(2)) : null
      })`);
      benchmarkReport.roomReloadMemoryTrend.push(memSample);
      console.log(
        `  [Cycle ${cycle}/10] geometries=${memSample.render.geometries} | textures=${memSample.render.textures} | heapUsedMB=${memSample.heapUsedMB}`,
      );
    }

    benchmarkReport.verification.consoleErrorsCount =
      cdp1.consoleErrors.length + cdp2.consoleErrors.length;
    benchmarkReport.verification.networkErrorsCount =
      cdp1.networkErrors.length + cdp2.networkErrors.length;
    benchmarkReport.verification.consoleErrors = [...cdp1.consoleErrors, ...cdp2.consoleErrors];
    benchmarkReport.verification.networkErrors = [...cdp1.networkErrors, ...cdp2.networkErrors];

    fs.writeFileSync(BENCHMARK_JSON_PATH, JSON.stringify(benchmarkReport, null, 2));
    console.log(`\n[Stage 04A QA] Saved benchmark report to ${BENCHMARK_JSON_PATH}`);

    if (benchmarkReport.verification.consoleErrorsCount > 0) {
      throw new Error(`Console errors detected: ${JSON.stringify(benchmarkReport.verification.consoleErrors)}`);
    }
    if (benchmarkReport.verification.networkErrorsCount > 0) {
      throw new Error(`Network errors detected: ${JSON.stringify(benchmarkReport.verification.networkErrors)}`);
    }

    cdp1.close();
  } finally {
    killTree(chromeProc?.pid);
    if (serverProc) {
      killTree(serverProc.pid);
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
