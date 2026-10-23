#!/usr/bin/env node
/**
 * BOSQICH 04B — `forest_square` (256×256 m, 6 POIs, Winding Roads)
 * Browser QA Automation, Real WebGL Screenshots & Benchmark Script
 *
 * Usage:
 *   node scripts/qa-stage04b.mjs [--warmup=0.6] [--duration=1.5] [--repeats=3]
 *
 * Performs:
 *   1. Starts Vite + Socket.IO dev server (`npm run dev`, if port 5173 is not already active)
 *      and Headless Chrome (1280x720, DPR=1, WebGL hardware/headless rendering).
 *   2. Verifies 2-client (`Client 1` + `Client 2`) room creation & join on `forest_square` (seed=6501, bots=0),
 *      confirming `mapId === 'forest_square'`, identical `gameplayHash`, 0 console errors, 0 HTTP/network errors,
 *      and 100% loading of all 28 GLB assets (4 weapon + 7 forest + 8 building + 6 interior + 3 container).
 *   3. Verifies Multi-Room / Multi-Seed & Legacy Map compatibility via Socket.IO (`forest_square` across seeds
 *      6501, 7777, 9021 plus `forest_assets_preview`, `forest_sample`, `dust_arena`).
 *   4. Captures 12 deterministic 1280x720 PNG screenshots in `docs/screenshots/stage04b/`:
 *      - 01_topdown_256x256_6_pois.png
 *      - 02_road_network_and_crossroads.png
 *      - 03_poi1_ranger_house_ext_int.png
 *      - 04_poi2_cabin_cluster_3_buildings.png
 *      - 05_poi2_rotated_interior_furniture.png
 *      - 06_poi3_lumber_mill_yard.png
 *      - 07_poi4_service_station_depot.png
 *      - 08_poi5_forest_camp_clearing.png
 *      - 09_poi6_cliff_watch_ruins_2nd_floor.png
 *      - 10_forest_cover_1p.png
 *      - 11_forest_cover_3p.png
 *      - 12_two_clients_poi_encounter.png
 *   5. Runs Stage 04B performance benchmark across 3 quality modes (`low`, `medium`, `high`),
 *      5 representative scenes (`topdown_overview`, `poi_cabin_cluster`, `poi_lumber_mill`,
 *      `poi_service_station`, `forest_combat_1p`) with 3 repeats each (median aggregation),
 *      plus a 10x consecutive `forest_square` room join/leave memory & resource leak verification,
 *      saving results to `docs/stage04b/benchmark.json` and `docs/stage04b/benchmark.csv`.
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { io as createSocketClient } from 'socket.io-client';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

const WARMUP_SEC = Number(args.warmup ?? 0.6);
const DURATION_SEC = Number(args.duration ?? 1.5);
const REPEATS = Number(args.repeats ?? 3);

const ROOT_DIR = process.cwd();
const SCREENSHOT_DIR = path.join(ROOT_DIR, 'docs', 'screenshots', 'stage04b');
const BENCHMARK_DIR = path.join(ROOT_DIR, 'docs', 'stage04b');
const BENCHMARK_JSON_PATH = path.join(BENCHMARK_DIR, 'benchmark.json');
const BENCHMARK_CSV_PATH = path.join(BENCHMARK_DIR, 'benchmark.csv');

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

/**
 * Exact mirror of `getForestSquarePoiSites(seed)` from `src/shared/structures/contracts.ts`.
 */
function seedOffsetPair(seed, salt, maxShift) {
  let h1 = Math.imul(seed ^ (salt * 374761393), 668265263);
  h1 = (h1 ^ (h1 >>> 13)) * 1274126177;
  const u = ((h1 ^ (h1 >>> 16)) >>> 0) / 4294967296;

  let h2 = Math.imul(seed ^ (salt * 1442695041 + 97), 374761393);
  h2 = (h2 ^ (h2 >>> 13)) * 1274126177;
  const v = ((h2 ^ (h2 >>> 16)) >>> 0) / 4294967296;

  const dx = Math.round((u * 2 - 1) * maxShift);
  const dz = Math.round((v * 2 - 1) * maxShift);
  return { dx, dz };
}

function getForestSquarePoiSitesForSeed(seed = 6501) {
  const q3 = (n) => Math.round(n * 1000) / 1000;
  const s1 = seedOffsetPair(seed, 101, 4);
  const s2 = seedOffsetPair(seed, 202, 4);
  const s3 = seedOffsetPair(seed, 303, 4);
  const s4 = seedOffsetPair(seed, 404, 3);
  const s5 = seedOffsetPair(seed, 505, 4);
  const s6 = seedOffsetPair(seed, 606, 4);

  const c1 = { x: -68 + s1.dx, z: -64 + s1.dz };
  const c2 = { x: 64 + s2.dx, z: -62 + s2.dz };
  const c3 = { x: -74 + s3.dx, z: 14 + s3.dz };
  const c4 = { x: 18 + s4.dx, z: -8 + s4.dz };
  const c5 = { x: -58 + s5.dx, z: 70 + s5.dz };
  const c6 = { x: 66 + s6.dx, z: 66 + s6.dz };

  return {
    poi_ranger_house: {
      id: 'poi_ranger_house',
      center: c1,
      padElevation: q3(1.4 + ((seed % 5) - 2) * 0.08),
      roadAnchor: { x: c1.x + 2, z: c1.z + 10 },
    },
    poi_cabin_cluster: {
      id: 'poi_cabin_cluster',
      center: c2,
      padElevation: q3(1.75 + ((seed % 7) - 3) * 0.06),
      roadAnchor: { x: c2.x - 12, z: c2.z + 6 },
    },
    poi_lumber_mill: {
      id: 'poi_lumber_mill',
      center: c3,
      padElevation: q3(0.95 + ((seed % 5) - 2) * 0.06),
      roadAnchor: { x: c3.x + 12, z: c3.z },
    },
    poi_service_station: {
      id: 'poi_service_station',
      center: c4,
      padElevation: q3(0.65 + ((seed % 3) - 1) * 0.06),
      roadAnchor: { x: c4.x - 12, z: c4.z },
    },
    poi_forest_camp: {
      id: 'poi_forest_camp',
      center: c5,
      padElevation: q3(0.55 + ((seed % 5) - 2) * 0.05),
      roadAnchor: { x: c5.x + 11, z: c5.z - 6 },
    },
    poi_cliff_watch: {
      id: 'poi_cliff_watch',
      center: c6,
      padElevation: q3(2.5 + ((seed % 5) - 2) * 0.08),
      roadAnchor: { x: c6.x - 11, z: c6.z - 6 },
    },
  };
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
    await delay(140);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    // Verify PNG header and dimensions (IHDR chunk at bytes 16..24)
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const outPath = path.join(SCREENSHOT_DIR, filename);
    fs.writeFileSync(outPath, buf);
    console.log(`  [screenshot] ${filename} (${width}x${height}, ${buf.length} bytes)`);
    return { filename, bytes: buf.length, width, height, path: outPath };
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

/**
 * Verifies Multi-Room / Multi-Seed (`forest_square` across seeds 6501, 7777, 9021)
 * and Legacy Maps (`forest_assets_preview`, `forest_sample`, `dust_arena`) over Socket.IO.
 */
async function verifyMultiRoomAndLegacyMaps(serverUrl = 'http://localhost:5173') {
  const testCases = [
    { name: 'SQ_Seed_6501_A', mapId: 'forest_square', publicLayoutSeed: 6501 },
    { name: 'SQ_Seed_6501_B', mapId: 'forest_square', publicLayoutSeed: 6501 },
    { name: 'SQ_Seed_7777', mapId: 'forest_square', publicLayoutSeed: 7777 },
    { name: 'SQ_Seed_9021', mapId: 'forest_square', publicLayoutSeed: 9021 },
    { name: 'Legacy_Stage04A', mapId: 'forest_assets_preview', publicLayoutSeed: 6501 },
    { name: 'Legacy_ForestSample', mapId: 'forest_sample', publicLayoutSeed: 6501 },
    { name: 'Legacy_DustArena', mapId: 'dust_arena', publicLayoutSeed: 6501 },
  ];

  const socket = createSocketClient(serverUrl, {
    transports: ['websocket'],
    forceNew: true,
  });

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Socket.IO connect timeout')), 10000);
      socket.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
      socket.once('connect_error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    await new Promise((resolve, reject) => {
      socket.emit('hello', { name: 'QA_MultiRoom' }, (res) => {
        if (res?.ok) resolve(res);
        else reject(new Error('Socket hello failed'));
      });
    });

    const results = [];
    for (const tc of testCases) {
      const createRes = await new Promise((resolve) => {
        socket.emit(
          'createRoom',
          {
            name: tc.name,
            mode: 'ffa',
            bots: 0,
            maxPlayers: 8,
            timeLimit: 10,
            scoreLimit: 25,
            mapId: tc.mapId,
            publicLayoutSeed: tc.publicLayoutSeed,
          },
          resolve,
        );
      });
      if (!createRes?.ok || !createRes.roomId) {
        throw new Error(`Failed to create room ${tc.name}: ${JSON.stringify(createRes)}`);
      }

      const joinRes = await new Promise((resolve) => {
        socket.emit('joinRoom', { roomId: createRes.roomId }, resolve);
      });
      if (!joinRes?.ok || !joinRes.welcome) {
        throw new Error(`Failed to join room ${tc.name}: ${JSON.stringify(joinRes)}`);
      }

      const worldMeta = joinRes.welcome.world;
      const readyRes = await new Promise((resolve) => {
        socket.emit('ready', { world: worldMeta }, resolve);
      });
      if (!readyRes?.ok) {
        throw new Error(`Ready check failed for ${tc.name}: ${JSON.stringify(readyRes)}`);
      }

      results.push({
        label: tc.name,
        roomId: createRes.roomId,
        mapId: worldMeta.mapId,
        worldVersion: worldMeta.worldVersion,
        publicLayoutSeed: worldMeta.publicLayoutSeed,
        gameplayHash: worldMeta.gameplayHash,
        readyOk: true,
      });

      socket.emit('leaveRoom');
      await delay(60);
    }

    // Verify deterministic hashes for same seed vs distinct seeds
    const sq6501A = results.find((r) => r.label === 'SQ_Seed_6501_A');
    const sq6501B = results.find((r) => r.label === 'SQ_Seed_6501_B');
    const sq7777 = results.find((r) => r.label === 'SQ_Seed_7777');
    const sq9021 = results.find((r) => r.label === 'SQ_Seed_9021');

    if (sq6501A.gameplayHash !== sq6501B.gameplayHash) {
      throw new Error('Determinism error: two rooms with seed=6501 produced different gameplayHashes');
    }
    if (
      sq6501A.gameplayHash === sq7777.gameplayHash ||
      sq6501A.gameplayHash === sq9021.gameplayHash ||
      sq7777.gameplayHash === sq9021.gameplayHash
    ) {
      throw new Error('Seed variation error: distinct seeds produced identical gameplayHashes');
    }

    return results;
  } finally {
    socket.disconnect();
  }
}

async function main() {
  const chromePath = findChromePath();
  const debugPort = 9245;
  console.log(
    `[Stage 04B QA] Starting QA, Screenshots & Benchmark (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS})...`,
  );

  let serverProc = null;
  const serverAlreadyRunning = await isHttpReady('http://localhost:5173/api/info', 1500);
  if (!serverAlreadyRunning) {
    console.log('[Stage 04B QA] Starting dev server (`npm run dev`)...');
    serverProc = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
      cwd: ROOT_DIR,
      stdio: 'pipe',
    });
  } else {
    console.log('[Stage 04B QA] Reusing active server on http://localhost:5173');
  }

  const userDataDir = path.join(os.tmpdir(), `stickman_qa_stage04b_${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  let chromeProc = null;
  try {
    await waitForHttp('http://localhost:5173/api/info', 30000);

    // =========================================================================
    // STEP 0: Multi-Room / Multi-Seed & Legacy Maps Verification via Socket.IO
    // =========================================================================
    console.log('[Stage 04B QA] Verifying Multi-Room, Multi-Seed & Legacy Maps via Socket.IO...');
    const multiRoomChecks = await verifyMultiRoomAndLegacyMaps('http://localhost:5173');
    for (const r of multiRoomChecks) {
      console.log(
        `  [room-check] ${r.label}: mapId=${r.mapId} seed=${r.publicLayoutSeed} hash=${r.gameplayHash} readyOk=${r.readyOk}`,
      );
    }

    // =========================================================================
    // Launch Headless Chrome (1280x720, DPR=1)
    // =========================================================================
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

    // Track live WebGL shader programs per active WebGL2RenderingContext non-invasively
    await cdp1.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          const progMap = new WeakMap();
          const origCreate = WebGL2RenderingContext.prototype.createProgram;
          const origDelete = WebGL2RenderingContext.prototype.deleteProgram;
          WebGL2RenderingContext.prototype.createProgram = function(...args) {
            progMap.set(this, (progMap.get(this) || 0) + 1);
            return origCreate.apply(this, args);
          };
          WebGL2RenderingContext.prototype.deleteProgram = function(...args) {
            progMap.set(this, Math.max(0, (progMap.get(this) || 0) - 1));
            return origDelete.apply(this, args);
          };
          window.__GET_WEBGL_PROGRAMS_COUNT__ = () => {
            const c = document.querySelector('canvas');
            const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
            return gl ? (progMap.get(gl) || 0) : 0;
          };
        })();
      `,
    });
    await cdp1.send('Page.reload');

    // =========================================================================
    // STEP 1: Client 1 creates `forest_square` room (0 bots for clean QA)
    // =========================================================================
    console.log('\n[Stage 04B QA] Connecting Client 1 and creating `forest_square` room (bots=0)...');
    await cdp1.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`);
    await cdp1.eval(`
      (() => {
        document.getElementById('name-input').value = 'Ranger_Alpha';
        document.getElementById('btn-enter').click();
      })()
    `);
    await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
    await cdp1.eval(`
      (() => {
        document.getElementById('room-map').value = 'forest_square';
        document.getElementById('room-mode').value = 'ffa';
        document.getElementById('room-name').value = 'Stage04B_ForestSquare_QA';
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
    // Wait for initial server spawn event so spawnId === 1
    await delay(350);

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
    // STEP 2: Client 2 joins the same `forest_square` room & verifies sync
    // =========================================================================
    console.log('[Stage 04B QA] Connecting Client 2 to verify multiplayer gameplayHash & 28 GLBs...');
    const newTargetRes = await fetch(`http://127.0.0.1:${debugPort}/json/new?http://localhost:5173`, {
      method: 'PUT',
    });
    const pageTarget2 = await newTargetRes.json();
    const cdp2 = new CdpSession(pageTarget2.webSocketDebuggerUrl);
    await cdp2.connect();
    await cdp2.send('Page.enable');
    await cdp2.send('Runtime.enable');
    await cdp2.send('Network.enable');
    await cdp2.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp2.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`);
    await cdp2.eval(`
      (() => {
        document.getElementById('name-input').value = 'Scout_Bravo';
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
    await delay(400); // Ensure Client 2 has received initial `spawn` event from server

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

    if (client1Meta.mapId !== 'forest_square' || client2Meta.mapId !== 'forest_square') {
      throw new Error(`Expected mapId='forest_square', got Client1=${client1Meta.mapId}, Client2=${client2Meta.mapId}`);
    }
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

    // Park Client 2 at far corner (-118, -118) while taking Screenshots 1..11
    await cdp2.eval(`window.__DEV_GAME_TOOLS__.setPlayerPos(-118, -118, 0)`);
    await delay(100);
    await cdp2.eval(`window.__DEV_GAME_TOOLS__.setPlayerPos(-118, -118, 0)`);

    // Bring Client 1 to front and resolve exact terrain heights / floorY for all 6 POIs
    await cdp1.send('Page.bringToFront');
    await delay(250);

    const poiSites = getForestSquarePoiSitesForSeed(client1Meta.publicLayoutSeed);
    for (const key of Object.keys(poiSites)) {
      const site = poiSites[key];
      const pos = await cdp1.eval(
        `window.__DEV_GAME_TOOLS__.setPlayerPos(${site.center.x}, ${site.center.z}, 0)`,
      );
      site.terrainY = Number(pos.y.toFixed(3));
      site.floorY = Number((pos.y + 0.16).toFixed(3));
      console.log(
        `  [poi] ${site.id}: center=(${site.center.x}, ${site.center.z}) terrainY=${site.terrainY}m floorY=${site.floorY}m`,
      );
    }

    const p1 = poiSites.poi_ranger_house;
    const p2 = poiSites.poi_cabin_cluster;
    const p3 = poiSites.poi_lumber_mill;
    const p4 = poiSites.poi_service_station;
    const p5 = poiSites.poi_forest_camp;
    const p6 = poiSites.poi_cliff_watch;

    // =========================================================================
    // STEP 3: Capture 12 Real WebGL Screenshots (1280x720 PNG)
    // =========================================================================
    console.log('\n[Stage 04B QA] Capturing 12 deterministic 1280x720 WebGL screenshots...');
    const screenshots = [];

    const captureWithSetup = async (filename, setupJs, waitMs = 420) => {
      await cdp1.eval(setupJs);
      await delay(waitMs);
      const info = await cdp1.screenshot(filename);
      screenshots.push(info);
    };

    // 1. 01_topdown_256x256_6_pois.png — Top-down (x: 0, y: 175, z: 95) -> (0, 0, -10)
    const cam01 = lookAtCamera({ x: 0, y: 175, z: 95 }, { x: 0, y: 0, z: -10 });
    await captureWithSetup(
      '01_topdown_256x256_6_pois.png',
      `
        window.__DEV_GAME_TOOLS__.setDevDoorAngle(null);
        window.__DEV_GAME_TOOLS__.setDevCabinetOpen(null);
        window.__DEV_GAME_TOOLS__.setDevContainersOpen(null);
        window.__DEV_GAME_TOOLS__.setDevAnchorHelpers(false);
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(0, -10, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam01)};
      `,
      500,
    );

    // 2. 02_road_network_and_crossroads.png — Central forest crossroads (p4.roadAnchor) & road into poi_service_station
    const cam02 = lookAtCamera(
      { x: p4.roadAnchor.x - 14, y: p4.floorY + 12.5, z: p4.roadAnchor.z + 20 },
      { x: p4.center.x - 1, y: p4.floorY + 1.2, z: p4.center.z - 2 },
    );
    await captureWithSetup(
      '02_road_network_and_crossroads.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p4.roadAnchor.x}, ${p4.roadAnchor.z}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam02)};
      `,
    );

    // 3. 03_poi1_ranger_house_ext_int.png — POI 1 (`poi_ranger_house`) 8x4 loft cabin, firewood stack (-5.8, -0.4), yard crate (+3.2, +3.4)
    const cam03 = lookAtCamera(
      { x: p1.center.x - 2.4, y: p1.floorY + 2.85, z: p1.center.z + 8.6 },
      { x: p1.center.x - 0.6, y: p1.floorY + 1.45, z: p1.center.z + 0.1 },
    );
    await captureWithSetup(
      '03_poi1_ranger_house_ext_int.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p1.center.x}, ${p1.center.z + 10}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam03)};
      `,
    );

    // 4. 04_poi2_cabin_cluster_3_buildings.png — POI 2 (`poi_cabin_cluster`) 3 buildings (0° N cabin, +90° W house, -90° E house)
    const cam04 = lookAtCamera(
      { x: p2.center.x, y: p2.floorY + 5.2, z: p2.center.z + 13.8 },
      { x: p2.center.x, y: p2.floorY + 1.5, z: p2.center.z - 2.5 },
    );
    await captureWithSetup(
      '04_poi2_cabin_cluster_3_buildings.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p2.center.x}, ${p2.center.z + 14}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam04)};
      `,
    );

    // 5. 05_poi2_rotated_interior_furniture.png — Inside +90° rotated 4x4 west house in `poi_cabin_cluster`
    // West house spans x in [p2.center.x - 10, p2.center.x - 6], z in [p2.center.z + 1, p2.center.z + 5]
    const cam05 = lookAtCamera(
      { x: p2.center.x - 6.32, y: p2.floorY + 2.55, z: p2.center.z + 3.85 },
      { x: p2.center.x - 8.65, y: p2.floorY + 1.0, z: p2.center.z + 2.35 },
    );
    await captureWithSetup(
      '05_poi2_rotated_interior_furniture.png',
      `
        window.__DEV_GAME_TOOLS__.setDevDoorAngle(0);
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p2.center.x - 5.0}, ${p2.center.z + 3.0}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam05)};
      `,
    );
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setDevDoorAngle(null)`);

    // 6. 06_poi3_lumber_mill_yard.png — POI 3 (`poi_lumber_mill`) +90° rotated 8x4 warehouse + outdoor timber/log stacks & sorting table
    const cam06 = lookAtCamera(
      { x: p3.center.x + 11.8, y: p3.floorY + 4.1, z: p3.center.z + 9.6 },
      { x: p3.center.x - 1.2, y: p3.floorY + 1.35, z: p3.center.z - 1.0 },
    );
    await captureWithSetup(
      '06_poi3_lumber_mill_yard.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p3.center.x + 12}, ${p3.center.z + 10}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam06)};
      `,
    );

    // 7. 07_poi4_service_station_depot.png — POI 4 (`poi_service_station`) 180° rotated 8x4 warehouse, 4x4 office, fuel tank & service ramp
    const cam07 = lookAtCamera(
      { x: p4.center.x + 9.6, y: p4.floorY + 4.1, z: p4.center.z + 11.4 },
      { x: p4.center.x - 1.2, y: p4.floorY + 1.4, z: p4.center.z - 0.5 },
    );
    await captureWithSetup(
      '07_poi4_service_station_depot.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p4.center.x + 10}, ${p4.center.z + 12}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam07)};
      `,
    );

    // 8. 08_poi5_forest_camp_clearing.png — POI 5 (`poi_forest_camp`) 180° rotated 4x4 lodge, expedition van, 2 canopies, campfire & picnic table
    const cam08 = lookAtCamera(
      { x: p5.center.x - 2.8, y: p5.floorY + 4.2, z: p5.center.z - 11.4 },
      { x: p5.center.x - 0.3, y: p5.floorY + 1.25, z: p5.center.z + 2.2 },
    );
    await captureWithSetup(
      '08_poi5_forest_camp_clearing.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p5.center.x - 3}, ${p5.center.z - 12}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam08)};
      `,
    );

    // 9. 09_poi6_cliff_watch_ruins_2nd_floor.png — POI 6 (`poi_cliff_watch`) 2-story watchpost_4x4, exterior west stairs, 2nd floor deck & stone ruins
    const watchDeckY = Number((p6.floorY + 3.0).toFixed(3));
    const cam09 = lookAtCamera(
      { x: p6.center.x - 7.8, y: p6.floorY + 4.35, z: p6.center.z + 7.6 },
      { x: p6.center.x + 0.6, y: p6.floorY + 2.25, z: p6.center.z - 0.8 },
    );
    await captureWithSetup(
      '09_poi6_cliff_watch_ruins_2nd_floor.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('sniper');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p6.center.x - 1.55}, ${p6.center.z - 2.45}, -0.35, ${watchDeckY}, 0.0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam09)};
      `,
    );
    const watchpostPlayerTransform = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPlayerTransform()`);

    // 10. 10_forest_cover_1p.png — 1P camera with GLB weapon looking from forest cover (trees, rocks, bushes) toward POI
    const pos10 = { x: p4.center.x - 21.5, z: p4.center.z + 14.5 };
    const look10 = lookAtCamera(
      { x: pos10.x, y: p4.floorY + 1.6, z: pos10.z },
      { x: p4.center.x - 2.0, y: p4.floorY + 1.5, z: p4.center.z + 1.0 },
    );
    await captureWithSetup(
      '10_forest_cover_1p.png',
      `
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${pos10.x}, ${pos10.z}, ${look10.yaw}, undefined, ${look10.pitch});
      `,
      450,
    );

    // 11. 11_forest_cover_3p.png — 3P camera inside POI building (`poi_ranger_house` 8x4 cabin) with wall-safe pulled-in camera
    // Cabin spans x in [p1.center.x - 4, p1.center.x + 4], z in [p1.center.z - 2, p1.center.z + 2]
    await captureWithSetup(
      '11_forest_cover_3p.png',
      `
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p1.center.x - 1.5}, ${p1.center.z + 0.6}, -1.08, ${p1.floorY}, -0.08);
      `,
      450,
    );
    const camInside3P = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getCameraState()`);

    // 12. 12_two_clients_poi_encounter.png — Client 1 & Client 2 face-to-face in `poi_cabin_cluster` courtyard
    const c1Pos = { x: p2.center.x - 2.2, z: p2.center.z + 0.4, yaw: -Math.PI / 2 };
    const c2Pos = { x: p2.center.x + 2.2, z: p2.center.z + 0.4, yaw: Math.PI / 2 };
    const cam12 = lookAtCamera(
      { x: p2.center.x, y: p2.floorY + 3.1, z: p2.center.z + 7.2 },
      { x: p2.center.x, y: p2.floorY + 1.25, z: p2.center.z - 1.8 },
    );

    // Update Client 2 position and broadcast multiple times so Client 1 interpolation buffer locks onto it
    for (let i = 0; i < 4; i++) {
      await cdp2.eval(`
        window.__DEV_GAME_TOOLS__.setWeapon('shotgun');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${c2Pos.x}, ${c2Pos.z}, ${c2Pos.yaw}, ${p2.terrainY}, 0);
      `);
      await delay(90);
    }

    await captureWithSetup(
      '12_two_clients_poi_encounter.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${c1Pos.x}, ${c1Pos.z}, ${c1Pos.yaw}, ${p2.terrainY}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam12)};
      `,
      500,
    );

    // Disconnect Client 2 after Screenshot 12
    cdp2.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${pageTarget2.id}`);
    await cdp1.send('Page.bringToFront');
    await delay(250);

    // =========================================================================
    // STEP 4: Benchmark on `forest_square` across `low`, `medium`, `high`
    //         (REPEATS = 3 per scene, 5 scenes, 4 bots)
    // =========================================================================
    console.log('\n[Stage 04B QA] Recreating `forest_square` room with 4 bots for sustained performance benchmark...');
    await cdp1.eval(`document.getElementById('btn-leave').click()`);
    await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
    await cdp1.eval(`
      (() => {
        document.getElementById('room-map').value = 'forest_square';
        document.getElementById('room-mode').value = 'ffa';
        document.getElementById('room-name').value = 'Stage04B_Benchmark_4Bots';
        document.getElementById('room-bots').value = '4';
        document.getElementById('btn-create').click();
      })()
    `);
    await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics().allLoaded === true`);
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

    const BENCHMARK_SCENES = [
      {
        id: 'topdown_overview',
        description: 'Top-down 256x256 forest overview showing all 6 POIs and road network',
        setup: `
          window.__DEV_GAME_TOOLS__.setThirdPerson(false);
          window.__DEV_GAME_TOOLS__.setWeapon('rifle');
          window.__DEV_GAME_TOOLS__.setPlayerPos(0, -10, 0);
          window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam01)};
        `,
      },
      {
        id: 'poi_cabin_cluster',
        description: 'POI 2 (Uylar Guruhi) courtyard view with 3 rotated/unrotated enterable buildings',
        setup: `
          window.__DEV_GAME_TOOLS__.setThirdPerson(false);
          window.__DEV_GAME_TOOLS__.setWeapon('rifle');
          window.__DEV_GAME_TOOLS__.setPlayerPos(${p2.center.x}, ${p2.center.z + 14}, 0);
          window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam04)};
        `,
      },
      {
        id: 'poi_lumber_mill',
        description: 'POI 3 (Yog‘och Tilish Maydoni) 90° rotated 8x4 warehouse and timber yard',
        setup: `
          window.__DEV_GAME_TOOLS__.setThirdPerson(false);
          window.__DEV_GAME_TOOLS__.setWeapon('rifle');
          window.__DEV_GAME_TOOLS__.setPlayerPos(${p3.center.x + 12}, ${p3.center.z + 10}, 0);
          window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam06)};
        `,
      },
      {
        id: 'poi_service_station',
        description: 'POI 4 (Eski Servis va Ombor) 180° rotated 8x4 warehouse, 4x4 office, fuel tank & ramp',
        setup: `
          window.__DEV_GAME_TOOLS__.setThirdPerson(false);
          window.__DEV_GAME_TOOLS__.setWeapon('rifle');
          window.__DEV_GAME_TOOLS__.setPlayerPos(${p4.center.x + 10}, ${p4.center.z + 12}, 0);
          window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam07)};
        `,
      },
      {
        id: 'forest_combat_1p',
        description: '1P combat view with GLB rifle looking through dense forest cover toward POI',
        setup: `
          window.__DEV_CAMERA_OVERRIDE__ = null;
          window.__DEV_GAME_TOOLS__.setThirdPerson(false);
          window.__DEV_GAME_TOOLS__.setWeapon('rifle');
          window.__DEV_GAME_TOOLS__.setPlayerPos(${pos10.x}, ${pos10.z}, ${look10.yaw}, undefined, ${look10.pitch});
        `,
      },
    ];

    const QUALITIES = ['low', 'medium', 'high'];
    const resultsByQuality = {};
    const csvRows = [];

    for (const q of QUALITIES) {
      console.log(`\n[Benchmark Quality: ${q.toUpperCase()}]`);
      await cdp1.eval(`window.__DEV_GAME_TOOLS__.setQuality('${q}')`);
      await delay(300);
      resultsByQuality[q] = {};

      for (const sc of BENCHMARK_SCENES) {
        const runs = [];
        for (let rep = 1; rep <= REPEATS; rep++) {
          await cdp1.send('Page.bringToFront');
          await cdp1.eval(sc.setup);
          await delay(WARMUP_SEC * 1000);
          await cdp1.eval(`window.__DEV_GAME_TOOLS__.startBenchmarkCapture()`);
          await delay(DURATION_SEC * 1000);
          const res = await cdp1.eval(`
            (() => {
              const r = window.__DEV_GAME_TOOLS__.stopBenchmarkCapture();
              r.programs = typeof window.__GET_WEBGL_PROGRAMS_COUNT__ === 'function'
                ? window.__GET_WEBGL_PROGRAMS_COUNT__()
                : 0;
              return r;
            })()
          `);
          runs.push({ repeat: rep, ...res });
          console.log(
            `  [${q} | ${sc.id} #${rep}] frames=${res.frames} | avgFps=${res.fpsMean} p50Fps=${res.fpsMedian} 1%low=${res.fps1PctLow} | FT p50=${res.frameTimeMedianMs}ms p95=${res.frameTimeP95Ms}ms | Draw=${res.render.calls} Tris=${res.render.triangles}`,
          );
        }

        const avgFps = Number(medianOf(runs.map((r) => r.fpsMean)).toFixed(2));
        const p50Fps = Number(medianOf(runs.map((r) => r.fpsMedian)).toFixed(2));
        const p10Fps = Number(medianOf(runs.map((r) => r.fpsP10)).toFixed(2));
        const onePercentLowFps = Number(medianOf(runs.map((r) => r.fps1PctLow)).toFixed(2));
        const avgFrameTimeMs = Number((1000 / Math.max(0.01, avgFps)).toFixed(3));
        const p50FrameTimeMs = Number(medianOf(runs.map((r) => r.frameTimeMedianMs)).toFixed(3));
        const p95FrameTimeMs = Number(medianOf(runs.map((r) => r.frameTimeP95Ms)).toFixed(3));
        const p99FrameTimeMs = Number(medianOf(runs.map((r) => r.frameTimeP99Ms)).toFixed(3));
        const cullCpuMedianMs = Number(medianOf(runs.map((r) => r.cullCpuMedianMs)).toFixed(4));
        const cullCpuP95Ms = Number(medianOf(runs.map((r) => r.cullCpuP95Ms)).toFixed(4));
        const lastRun = runs[runs.length - 1];

        const summary = {
          quality: q,
          scene: sc.id,
          description: sc.description,
          repeats: REPEATS,
          avgFps,
          p50Fps,
          p10Fps,
          onePercentLowFps,
          avgFrameTimeMs,
          p50FrameTimeMs,
          p95FrameTimeMs,
          p99FrameTimeMs,
          // Compatibility aliases
          fpsMean: avgFps,
          fpsMedian: p50Fps,
          fpsP10: p10Fps,
          fps1PctLow: onePercentLowFps,
          frameTimeMedianMs: p50FrameTimeMs,
          frameTimeP95Ms: p95FrameTimeMs,
          frameTimeP99Ms: p99FrameTimeMs,
          cullCpuMedianMs,
          cullCpuP95Ms,
          drawCalls: lastRun.render.calls,
          sceneCalls: lastRun.render.sceneCalls,
          vmCalls: lastRun.render.vmCalls,
          triangles: lastRun.render.triangles,
          geometries: lastRun.render.geometries,
          textures: lastRun.render.textures,
          programs: lastRun.programs,
          cullingProfile: lastRun.culling,
          heapUsedMB: lastRun.heapUsedMB,
          runs,
        };

        resultsByQuality[q][sc.id] = summary;
        csvRows.push(summary);
      }
    }

    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setQuality('medium')`);

    // =========================================================================
    // STEP 5: 10x Consecutive `forest_square` Room Reload Memory Test
    // =========================================================================
    console.log('\n[Stage 04B QA] Running 10x consecutive `forest_square` room reload memory & disposal check...');
    const roomReloadMemoryTrend = [];
    for (let cycle = 1; cycle <= 10; cycle++) {
      await cdp1.eval(`document.getElementById('btn-leave').click()`);
      await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
      await delay(180);
      await cdp1.eval(`
        (() => {
          document.getElementById('room-map').value = 'forest_square';
          document.getElementById('room-name').value = 'Stage04B_MemCycle_${cycle}';
          document.getElementById('room-bots').value = '0';
          document.getElementById('btn-create').click();
        })()
      `);
      await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
      await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics().allLoaded === true`);
      await cdp1.eval(`
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(0, -10, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam01)};
      `);
      await delay(350);

      const memSample = await cdp1.eval(`({
        cycle: ${cycle},
        render: window.__DEV_GAME_TOOLS__.getRenderStats(),
        programs: typeof window.__GET_WEBGL_PROGRAMS_COUNT__ === 'function' ? window.__GET_WEBGL_PROGRAMS_COUNT__() : 0,
        heapUsedMB: performance.memory ? Number((performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2)) : null,
        heapTotalMB: performance.memory ? Number((performance.memory.totalJSHeapSize / (1024 * 1024)).toFixed(2)) : null
      })`);
      roomReloadMemoryTrend.push(memSample);
      console.log(
        `  [Cycle ${cycle}/10] geometries=${memSample.render.geometries} | textures=${memSample.render.textures} | programs=${memSample.programs} | heapUsedMB=${memSample.heapUsedMB}`,
      );
    }

    const firstCycle = roomReloadMemoryTrend[0];
    const lastCycle = roomReloadMemoryTrend[roomReloadMemoryTrend.length - 1];
    // Compare steady-state cycle 2 vs cycle 10 for geometries/textures/heap
    const steadyCycle = roomReloadMemoryTrend[1] ?? firstCycle;
    const geometryDelta = lastCycle.render.geometries - steadyCycle.render.geometries;
    const textureDelta = lastCycle.render.textures - steadyCycle.render.textures;
    const heapDeltaMB =
      lastCycle.heapUsedMB !== null && steadyCycle.heapUsedMB !== null
        ? Number((lastCycle.heapUsedMB - steadyCycle.heapUsedMB).toFixed(2))
        : 0;
    const leakDetected = geometryDelta > 4 || textureDelta > 4 || heapDeltaMB > 35;

    const cpus = os.cpus();
    const benchmarkReport = {
      stage: 'BOSQICH 04B — 256x256 Forest Square, 6 POIs, Road Network & Scalability',
      timestamp: new Date().toISOString(),
      methodology: {
        warmupSeconds: WARMUP_SEC,
        measurementSeconds: DURATION_SEC,
        repeatsPerScene: REPEATS,
        viewport: '1280x720',
        devicePixelRatio: 1,
        qualities: QUALITIES,
        scenes: BENCHMARK_SCENES.map((s) => s.id),
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
          mapId: client1Meta.mapId,
          publicLayoutSeed: client1Meta.publicLayoutSeed,
          client1GameplayHash: client1Meta.gameplayHash,
          client2GameplayHash: client2Meta.gameplayHash,
          gameplayHashMatch: client1Meta.gameplayHash === client2Meta.gameplayHash,
        },
        multiRoomAndLegacyMaps: multiRoomChecks,
        glbAssets: {
          totalExpected: 28,
          totalLoaded: totalGlbCount,
          weaponAssetsLoaded: weaponCount,
          forestAssetsLoaded: forestCount,
          buildingAssetsLoaded: buildingCount,
          interiorAssetsLoaded: interiorCount,
          containerAssetsLoaded: containerCount,
          allLoaded: stage04aDiag.allLoaded,
          buildings: stage04aDiag.buildings,
          interiors: stage04aDiag.interiors,
          containers: stage04aDiag.containers,
        },
        poiSites: poiSites,
        indoorAndVerticalGameplayChecks: {
          cameraInside3P: camInside3P,
          cameraStayedInsideRangerCabinWalls:
            camInside3P.x >= p1.center.x - 4.0 &&
            camInside3P.x <= p1.center.x + 4.0 &&
            camInside3P.z >= p1.center.z - 2.0 &&
            camInside3P.z <= p1.center.z + 2.0,
          watchpostSecondFloorPlayerPos: watchpostPlayerTransform,
          watchpostSecondFloorVerified: Math.abs(watchpostPlayerTransform.y - watchDeckY) < 0.05,
        },
        consoleErrorsCount: cdp1.consoleErrors.length + cdp2.consoleErrors.length,
        networkErrorsCount: cdp1.networkErrors.length + cdp2.networkErrors.length,
        consoleErrors: [...cdp1.consoleErrors, ...cdp2.consoleErrors],
        networkErrors: [...cdp1.networkErrors, ...cdp2.networkErrors],
      },
      resultsByQuality,
      scenes: resultsByQuality.medium,
      qualityPresets: {
        low: resultsByQuality.low.poi_service_station,
        medium: resultsByQuality.medium.poi_service_station,
        high: resultsByQuality.high.poi_service_station,
      },
      memoryTest10xReload: {
        cycles: roomReloadMemoryTrend,
        steadyBaselineCycle: steadyCycle.cycle,
        initialGeometries: steadyCycle.render.geometries,
        finalGeometries: lastCycle.render.geometries,
        geometryDelta,
        initialTextures: steadyCycle.render.textures,
        finalTextures: lastCycle.render.textures,
        textureDelta,
        initialPrograms: steadyCycle.programs,
        finalPrograms: lastCycle.programs,
        programDelta: lastCycle.programs - steadyCycle.programs,
        initialHeapUsedMB: steadyCycle.heapUsedMB,
        finalHeapUsedMB: lastCycle.heapUsedMB,
        heapDeltaMB,
        leakDetected,
      },
      roomReloadMemoryTrend,
      screenshots: screenshots.map((s) => ({
        filename: s.filename,
        bytes: s.bytes,
        width: s.width,
        height: s.height,
      })),
    };

    fs.writeFileSync(BENCHMARK_JSON_PATH, JSON.stringify(benchmarkReport, null, 2));
    console.log(`\n[Stage 04B QA] Saved benchmark JSON to ${BENCHMARK_JSON_PATH}`);

    // Write CSV
    const csvHeader = [
      'quality',
      'scene',
      'repeats',
      'avgFps',
      'p50Fps',
      'p10Fps',
      'onePercentLowFps',
      'avgFrameTimeMs',
      'p50FrameTimeMs',
      'p95FrameTimeMs',
      'p99FrameTimeMs',
      'drawCalls',
      'sceneCalls',
      'vmCalls',
      'triangles',
      'geometries',
      'textures',
      'programs',
      'cullAvgCpuMs',
      'cullP95CpuMs',
      'cullEvaluatedFrames',
      'cullSkippedStaticFrames',
      'heapUsedMB',
    ].join(',');

    const csvLines = [
      csvHeader,
      ...csvRows.map((row) =>
        [
          row.quality,
          row.scene,
          row.repeats,
          row.avgFps,
          row.p50Fps,
          row.p10Fps,
          row.onePercentLowFps,
          row.avgFrameTimeMs,
          row.p50FrameTimeMs,
          row.p95FrameTimeMs,
          row.p99FrameTimeMs,
          row.drawCalls,
          row.sceneCalls,
          row.vmCalls,
          row.triangles,
          row.geometries,
          row.textures,
          row.programs,
          row.cullingProfile?.avgCpuMs ?? 0,
          row.cullingProfile?.p95CpuMs ?? 0,
          row.cullingProfile?.evaluatedFrames ?? 0,
          row.cullingProfile?.skippedStaticFrames ?? 0,
          row.heapUsedMB ?? '',
        ].join(','),
      ),
    ];

    fs.writeFileSync(BENCHMARK_CSV_PATH, csvLines.join('\n') + '\n');
    console.log(`[Stage 04B QA] Saved benchmark CSV to ${BENCHMARK_CSV_PATH}`);

    if (benchmarkReport.verification.consoleErrorsCount > 0) {
      throw new Error(`Console errors detected: ${JSON.stringify(benchmarkReport.verification.consoleErrors)}`);
    }
    if (benchmarkReport.verification.networkErrorsCount > 0) {
      throw new Error(`Network errors detected: ${JSON.stringify(benchmarkReport.verification.networkErrors)}`);
    }
    if (leakDetected) {
      throw new Error(
        `Memory/resource leak detected in 10x reload: geoDelta=${geometryDelta}, texDelta=${textureDelta}, heapDeltaMB=${heapDeltaMB}`,
      );
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
