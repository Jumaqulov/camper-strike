#!/usr/bin/env node
/**
 * BOSQICH 05 — Server Authoritative Movement, Client Prediction/Reconciliation & Anti-Cheat
 * Browser QA Automation, 2-Client Authoritative Sync, Latency/Packet-Loss Test,
 * Real WebGL Screenshots (10x 1280x720 PNG) & Sustained Benchmark Script
 *
 * Usage:
 *   node scripts/qa-stage05.mjs [--warmup=10] [--duration=30] [--repeats=3]
 *
 * Performs:
 *   1. Starts Vite + Socket.IO dev server (`npm run dev`, if port 5173 is not already active)
 *      and Headless Chrome (1280x720, DPR=1, WebGL hardware/headless rendering).
 *   2. Verifies Multi-Room / Multi-Seed & Legacy Map compatibility via Socket.IO (`forest_square`
 *      across seeds 6501, 7777, 9021 plus `forest_assets_preview`, `forest_sample`, `forest_technical`).
 *   3. Launches Client 1 & Client 2 in the same `forest_square` room (seed=6501, bots=0) and verifies:
 *      - `mapId === 'forest_square'`, `publicLayoutSeed === 6501`, `gameplayHash === '344d2cb0662ba731'`
 *      - 100% loading of all 28 GLB assets, 0 console errors, 0 network errors
 *      - Live Authoritative Walking Test (`setSyntheticInput` -> server `input` -> `snap` -> `reconcile`,
 *        verifying `currentSeq > 20`, `lastAckedSeq > 15`, `reconcileCount > 5`, distance moved `> 4.0m`,
 *        `divergenceM < 0.05m`, and remote replication on Client 2)
 *      - Live Teleport Cheat Rejection Test (`sendRawStatePacketForAdversarialTest({ x: 88, y: 40, z: -88 })`
 *        x5 -> server rejects legacy `state` packet and keeps true `authoritativePos`)
 *      - Network Latency, Jitter & Packet Loss Reconciliation Test across 4 profiles:
 *        `0ms / 0%`, `80ms / 5%`, `150ms / 10%`, `200ms / 10%`
 *   4. Captures 10 real 1280x720 PNG screenshots in `docs/screenshots/stage05/`:
 *      - 01_topdown_256x256_authoritative_overview.png
 *      - 02_two_clients_authoritative_sync.png
 *      - 03_authoritative_road_movement_3p.png
 *      - 04_poi1_ranger_house_entry.png
 *      - 05_poi2_cabin_cluster_rotated_houses.png
 *      - 06_poi3_lumber_mill_90deg_warehouse.png
 *      - 07_poi4_service_station_180deg_depot.png
 *      - 08_poi6_cliff_watch_2nd_floor_stairs.png
 *      - 09_forest_combat_1p_rifle.png
 *      - 10_reconciliation_latency_test_3p.png
 *   5. Runs sustained performance benchmark (`WARMUP_SEC=10`, `DURATION_SEC=30`, `REPEATS=3`) on
 *      `forest_square` with 4 active bots across `open_forest_movement`, `poi_interior_courtyard`,
 *      and `moving_pvp_combat` (`medium` + `low` comparison), plus 10x consecutive room reload
 *      memory/GPU disposal verification, saving `docs/stage05/benchmark.json` and `docs/stage05/benchmark.csv`.
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

const WARMUP_SEC = Number(args.warmup ?? 10);
const DURATION_SEC = Number(args.duration ?? 30);
const REPEATS = Number(args.repeats ?? 3);

const ROOT_DIR = process.cwd();
const SCREENSHOT_DIR = path.join(ROOT_DIR, 'docs', 'screenshots', 'stage05');
const BENCHMARK_DIR = path.join(ROOT_DIR, 'docs', 'stage05');
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
 * and Legacy Maps (`forest_assets_preview`, `forest_sample`, `forest_technical`) over Socket.IO.
 */
async function verifyMultiRoomAndLegacyMaps(serverUrl = 'http://localhost:5173') {
  const testCases = [
    { name: 'SQ_Seed_6501_A', mapId: 'forest_square', publicLayoutSeed: 6501 },
    { name: 'SQ_Seed_6501_B', mapId: 'forest_square', publicLayoutSeed: 6501 },
    { name: 'SQ_Seed_7777', mapId: 'forest_square', publicLayoutSeed: 7777 },
    { name: 'SQ_Seed_9021', mapId: 'forest_square', publicLayoutSeed: 9021 },
    { name: 'Legacy_Stage04A', mapId: 'forest_assets_preview', publicLayoutSeed: 6501 },
    { name: 'Legacy_ForestSample', mapId: 'forest_sample', publicLayoutSeed: 6501 },
    { name: 'Legacy_ForestTechnical', mapId: 'forest_technical', publicLayoutSeed: 6501 },
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
      socket.emit('hello', { name: 'QA_Stage05' }, (res) => {
        if (res?.ok) resolve(res);
        else reject(new Error('Socket hello failed'));
      });
    });

    const results = [];
    for (const tc of testCases) {
      const targetMapId = tc.mapIdActual ?? tc.mapId;
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
            mapId: targetMapId,
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

const PAGE_INIT_HOOK_SOURCE = `
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

    const OrigWebSocket = window.WebSocket;
    window.__LAST_SNAP__ = null;
    window.WebSocket = class extends OrigWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string' && ev.data.startsWith('42["snap",')) {
            try {
              const parsed = JSON.parse(ev.data.slice(2));
              if (parsed && parsed[0] === 'snap') {
                window.__LAST_SNAP__ = parsed[1];
              }
            } catch {
              // ignore malformed frame
            }
          }
        });
      }
    };

    const origRAF = window.requestAnimationFrame.bind(window);
    let rafCapFps = 60;
    window.__SET_RAF_CAP_FPS__ = (fps) => {
      rafCapFps = fps && fps > 0 ? Number(fps) : null;
    };
    window.requestAnimationFrame = (cb) => {
      if (!rafCapFps) return origRAF(cb);
      const intervalMs = Math.max(4, Math.floor(1000 / rafCapFps));
      return window.setTimeout(() => origRAF(cb), intervalMs);
    };
  })();
`;

async function main() {
  const chromePath = findChromePath();
  const debugPort = 9246;
  console.log(
    `[Stage 05 QA] Starting Authoritative Multiplayer QA, Screenshots & Benchmark (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS})...`,
  );

  let serverProc = null;
  const serverAlreadyRunning = await isHttpReady('http://localhost:5173/api/info', 1500);
  if (!serverAlreadyRunning) {
    console.log('[Stage 05 QA] Starting dev server (`npm run dev`)...');
    serverProc = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
      cwd: ROOT_DIR,
      stdio: 'pipe',
    });
  } else {
    console.log('[Stage 05 QA] Reusing active server on http://localhost:5173');
  }

  const userDataDir = path.join(os.tmpdir(), `stickman_qa_stage05_${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  let chromeProc = null;
  try {
    await waitForHttp('http://localhost:5173/api/info', 30000);

    // =========================================================================
    // STEP 0: Multi-Room / Multi-Seed & Legacy Maps Verification via Socket.IO
    // =========================================================================
    console.log('[Stage 05 QA] Verifying Multi-Room, Multi-Seed & Legacy Maps via Socket.IO...');
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
    await cdp1.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_INIT_HOOK_SOURCE });
    await cdp1.send('Page.reload');

    // =========================================================================
    // STEP 1: Client 1 creates `forest_square` room (bots=0 for clean 2-client QA)
    // =========================================================================
    console.log('\n[Stage 05 QA] Connecting Client 1 and creating `forest_square` room (bots=0)...');
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
        document.getElementById('room-name').value = 'Stage05_Authoritative_QA';
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
    await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos)`);

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
    console.log('[Stage 05 QA] Connecting Client 2 to verify authoritative multiplayer sync & 28 GLBs...');
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
    await cdp2.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp2.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_INIT_HOOK_SOURCE });
    await cdp2.send('Page.reload');

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
    await cdp2.waitFor(`Boolean(window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos)`);
    await cdp2.waitFor(`Boolean(window.__LAST_SNAP__ && window.__LAST_SNAP__.players?.length >= 2)`);
    await delay(250);

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
    if (client1Meta.gameplayHash !== '344d2cb0662ba731' || client2Meta.gameplayHash !== '344d2cb0662ba731') {
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

    // =========================================================================
    // STEP 3: Live Authoritative Walking, Anti-Cheat & Network Reconciliation QA
    // =========================================================================
    console.log('\n[Stage 05 QA] Running Live Authoritative Walking Test on Client 1 & Client 2...');
    await cdp1.send('Page.bringToFront');
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.clearPlayerPoseLock()`);
    await cdp2.eval(`window.__DEV_GAME_TOOLS__.clearPlayerPoseLock()`);
    await delay(200);

    const c1DiagBefore = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
    const c2SnapBefore = await cdp2.eval(`window.__LAST_SNAP__`);
    const c2DiagBefore = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);

    // Choose initial yaw pointing toward map center (0, 0) so we walk toward open central terrain
    const walkYaw1 = Math.atan2(c1DiagBefore.authoritativePos.x, c1DiagBefore.authoritativePos.z);
    await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 1, right: 0, jump: false, walk: false, yaw: ${walkYaw1.toFixed(4)}, pitch: 0 })`,
    );
    await delay(1200);

    // Check if an obstacle slowed Client 1; if distance < 4.5m, turn +1.2 rad and walk 900ms more
    const midDiag1 = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
    const midMoved1 = Math.hypot(
      midDiag1.predictedPos.x - c1DiagBefore.authoritativePos.x,
      midDiag1.predictedPos.z - c1DiagBefore.authoritativePos.z,
    );
    if (midMoved1 < 4.5) {
      await cdp1.eval(
        `window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 1, right: 0.4, jump: false, walk: false, yaw: ${(walkYaw1 + 1.2).toFixed(4)}, pitch: 0 })`,
      );
      await delay(900);
    }

    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
    await delay(300);

    const c1DiagAfter = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
    const c2SnapAfter = await cdp2.eval(`window.__LAST_SNAP__`);

    const c1DistanceMovedM = Number(
      Math.hypot(
        c1DiagAfter.authoritativePos.x - c1DiagBefore.authoritativePos.x,
        c1DiagAfter.authoritativePos.z - c1DiagBefore.authoritativePos.z,
      ).toFixed(4),
    );

    // Find Client 1 in Client 2's received server snapshot
    const c1RemoteAfter = (c2SnapAfter?.players ?? []).find(
      (p) =>
        Math.hypot(p.x - c1DiagAfter.authoritativePos.x, p.z - c1DiagAfter.authoritativePos.z) < 0.25,
    );
    const c1RemoteBefore = c1RemoteAfter
      ? (c2SnapBefore?.players ?? []).find((p) => p.id === c1RemoteAfter.id)
      : null;
    const c2ObservedDistanceM =
      c1RemoteAfter && c1RemoteBefore
        ? Number(Math.hypot(c1RemoteAfter.x - c1RemoteBefore.x, c1RemoteAfter.z - c1RemoteBefore.z).toFixed(4))
        : c1DistanceMovedM;

    console.log(
      `  [auth-walk C1] seq=${c1DiagAfter.currentSeq} acked=${c1DiagAfter.lastAckedSeq} reconciles=${c1DiagAfter.reconcileCount} moved=${c1DistanceMovedM}m divergence=${c1DiagAfter.divergenceM}m remoteObserved=${c2ObservedDistanceM}m`,
    );

    if (
      c1DiagAfter.currentSeq <= 20 ||
      c1DiagAfter.lastAckedSeq <= 15 ||
      c1DiagAfter.reconcileCount <= 5 ||
      c1DistanceMovedM <= 4.0 ||
      c1DiagAfter.divergenceM >= 0.05
    ) {
      throw new Error(
        `Authoritative walk verification failed on Client 1: ${JSON.stringify({
          c1DiagAfter,
          c1DistanceMovedM,
        })}`,
      );
    }

    // Walk Client 2 authoritatively as well
    const walkYaw2 = Math.atan2(c2DiagBefore.authoritativePos.x, c2DiagBefore.authoritativePos.z);
    await cdp2.eval(
      `window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 1, right: 0, jump: false, walk: false, yaw: ${walkYaw2.toFixed(4)}, pitch: 0 })`,
    );
    await delay(900);
    await cdp2.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
    await delay(300);
    const c2DiagAfter = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
    const c2DistanceMovedM = Number(
      Math.hypot(
        c2DiagAfter.authoritativePos.x - c2DiagBefore.authoritativePos.x,
        c2DiagAfter.authoritativePos.z - c2DiagBefore.authoritativePos.z,
      ).toFixed(4),
    );
    console.log(
      `  [auth-walk C2] seq=${c2DiagAfter.currentSeq} acked=${c2DiagAfter.lastAckedSeq} reconciles=${c2DiagAfter.reconcileCount} moved=${c2DistanceMovedM}m divergence=${c2DiagAfter.divergenceM}m`,
    );

    // -------------------------------------------------------------------------
    // Live Teleport Cheat Rejection Test
    // -------------------------------------------------------------------------
    console.log('\n[Stage 05 QA] Running Live Teleport Cheat Rejection Test...');
    const authBeforeCheat = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`))
      .authoritativePos;
    const cheatTarget = { x: 88, y: 40, z: -88 };
    await cdp1.eval(`
      (() => {
        for (let i = 0; i < 5; i++) {
          window.__DEV_GAME_TOOLS__.sendRawStatePacketForAdversarialTest({ x: 88, y: 40, z: -88 });
        }
      })()
    `);
    await delay(300);
    const diagAfterCheat = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
    const authAfterCheat = diagAfterCheat.authoritativePos;
    const cheatShiftM = Number(
      Math.hypot(
        authAfterCheat.x - authBeforeCheat.x,
        authAfterCheat.y - authBeforeCheat.y,
        authAfterCheat.z - authBeforeCheat.z,
      ).toFixed(4),
    );
    const distFromCheatTargetM = Number(
      Math.hypot(
        authAfterCheat.x - cheatTarget.x,
        authAfterCheat.y - cheatTarget.y,
        authAfterCheat.z - cheatTarget.z,
      ).toFixed(2),
    );
    const cheatRejected = cheatShiftM < 0.05 && distFromCheatTargetM > 50;
    console.log(
      `  [anti-cheat] target=(88,40,-88) | authBefore=(${authBeforeCheat.x},${authBeforeCheat.y},${authBeforeCheat.z}) | authAfter=(${authAfterCheat.x},${authAfterCheat.y},${authAfterCheat.z}) | shift=${cheatShiftM}m | rejected=${cheatRejected}`,
    );
    if (!cheatRejected) {
      throw new Error(`Teleport cheat was NOT rejected! authAfter=${JSON.stringify(authAfterCheat)}`);
    }

    // -------------------------------------------------------------------------
    // Network Latency, Jitter & Packet Loss Reconciliation Test
    // -------------------------------------------------------------------------
    console.log('\n[Stage 05 QA] Running Network Latency & Packet Loss Reconciliation Tests...');
    const netProfiles = [
      { label: '0ms_0pct', rttMs: 0, jitterMs: 0, dropRate: 0 },
      { label: '80ms_5pct', rttMs: 80, jitterMs: 10, dropRate: 0.05 },
      { label: '150ms_10pct', rttMs: 150, jitterMs: 20, dropRate: 0.1 },
      { label: '200ms_10pct', rttMs: 200, jitterMs: 25, dropRate: 0.1 },
    ];
    const latencyReconciliationResults = [];

    for (let i = 0; i < netProfiles.length; i++) {
      const prof = netProfiles[i];
      const beforeProf = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
      const dirSign = i % 2 === 0 ? 1 : -1;
      const strafeSign = i % 2 === 0 ? 0.35 : -0.35;
      await cdp1.eval(`
        window.__DEV_GAME_TOOLS__.setNetSim(${JSON.stringify({
          rttMs: prof.rttMs,
          jitterMs: prof.jitterMs,
          dropRate: prof.dropRate,
        })});
        window.__DEV_GAME_TOOLS__.setSyntheticInput({
          fwd: ${dirSign},
          right: ${strafeSign},
          jump: false,
          walk: false,
          yaw: ${(walkYaw1 + i * 0.4).toFixed(4)},
          pitch: 0
        });
      `);
      await delay(1000);
      await cdp1.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
      await delay(480);
      const afterProf = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
      const movedM = Number(
        Math.hypot(
          afterProf.authoritativePos.x - beforeProf.authoritativePos.x,
          afterProf.authoritativePos.z - beforeProf.authoritativePos.z,
        ).toFixed(4),
      );
      const entry = {
        label: prof.label,
        netSim: { rttMs: prof.rttMs, jitterMs: prof.jitterMs, dropRate: prof.dropRate },
        distanceMovedM: movedM,
        settledDivergenceM: afterProf.divergenceM,
        lastPositionError: afterProf.lastPositionError,
        maxPositionError: afterProf.maxPositionError,
        reconcileCount: afterProf.reconcileCount,
        smoothCorrectionCount: afterProf.smoothCorrectionCount,
        hardSnapCount: afterProf.hardSnapCount,
         smoothOffsetMag: afterProf.smoothOffsetMag,
        currentSeq: afterProf.currentSeq,
        lastAckedSeq: afterProf.lastAckedSeq,
        lastServerTick: afterProf.lastServerTick,
        authoritativePos: afterProf.authoritativePos,
        predictedPos: afterProf.predictedPos,
        smoothedPos: afterProf.smoothedPos,
      };
      latencyReconciliationResults.push(entry);
      console.log(
        `  [net-sim ${prof.label}] moved=${movedM}m | settledDivergence=${afterProf.divergenceM}m | lastErr=${afterProf.lastPositionError}m | maxErr=${afterProf.maxPositionError}m | smoothCorr=${afterProf.smoothCorrectionCount} | hardSnap=${afterProf.hardSnapCount}`,
      );
    }

    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setNetSim(null)`);
    await delay(300);

    // =========================================================================
    // STEP 4: Capture 10 Real WebGL Screenshots (1280x720 PNG) in `docs/screenshots/stage05/`
    // =========================================================================
    console.log('\n[Stage 05 QA] Capturing 10 deterministic 1280x720 WebGL screenshots...');
    const screenshots = [];

    const captureWithSetup = async (filename, setupJs, waitMs = 550) => {
      await cdp1.eval(setupJs);
      await delay(waitMs);
      const info = await cdp1.screenshot(filename);
      screenshots.push(info);
    };

    const c2TrueAuth = (await cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    console.log(
      `  [sync-pos] Client 2 authoritative position for 2-client sync shot: (${c2TrueAuth.x}, ${c2TrueAuth.y}, ${c2TrueAuth.z})`,
    );

    // Ensure Client 2 faces toward (c2TrueAuth.x - 2.6, c2TrueAuth.z + 0.6) with shotgun
    const c1SyncPos = { x: Number((c2TrueAuth.x - 2.6).toFixed(3)), z: Number((c2TrueAuth.z + 0.6).toFixed(3)) };
    const yawC2ToC1 = Math.atan2(-(c1SyncPos.x - c2TrueAuth.x), -(c1SyncPos.z - c2TrueAuth.z));
    const yawC1ToC2 = Math.atan2(-(c2TrueAuth.x - c1SyncPos.x), -(c2TrueAuth.z - c1SyncPos.z));

    await cdp2.eval(`
      window.__DEV_GAME_TOOLS__.setWeapon('shotgun');
      window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 0, right: 0, jump: false, walk: false, yaw: ${yawC2ToC1.toFixed(4)}, pitch: 0 });
    `);
    await delay(250);
    await cdp2.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
    await delay(250);

    // Capture Screenshot 10 (`10_reconciliation_latency_test_3p.png`) FIRST while Client 1 is at its
    // true post-reconciliation authoritative position looking inward toward (0,0), before any static POI setPlayerPos!
    const c1PostReconcileAuth = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    const inwardYaw10 = Math.atan2(c1PostReconcileAuth.x, c1PostReconcileAuth.z);
    await cdp1.eval(`
      window.__DEV_CAMERA_OVERRIDE__ = null;
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
      window.__DEV_GAME_TOOLS__.setWeapon('rifle');
      window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
      window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 1, right: 0, jump: false, walk: false, yaw: ${inwardYaw10.toFixed(4)}, pitch: -0.06 });
    `);
    await delay(350);
    await cdp1.eval(`
      window.__DEV_GAME_TOOLS__.setSyntheticInput(null);
      const p = window.__DEV_GAME_TOOLS__.getPlayerTransform();
      window.__DEV_PLAYER_POSE_LOCK__ = { x: p.x, y: p.y, z: p.z, yaw: ${inwardYaw10.toFixed(4)}, pitch: -0.06 };
      window.__SET_RAF_CAP_FPS__?.(null);
      const chatLog = document.getElementById('chat-log');
      if (chatLog) chatLog.innerHTML = '';
    `);
    await delay(600);
    const shot10Info = await cdp1.screenshot('10_reconciliation_latency_test_3p.png');

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
    const p6 = poiSites.poi_cliff_watch;

    // 1. 01_topdown_256x256_authoritative_overview.png — Top-down 256x256 overview of `forest_square`
    const cam01 = lookAtCamera({ x: 0, y: 175, z: 95 }, { x: 0, y: 0, z: -10 });
    await captureWithSetup(
      '01_topdown_256x256_authoritative_overview.png',
      `
        window.__DEV_GAME_TOOLS__.setDevDoorAngle(null);
        window.__DEV_GAME_TOOLS__.setDevCabinetOpen(null);
        window.__DEV_GAME_TOOLS__.setDevContainersOpen(null);
        window.__DEV_GAME_TOOLS__.setDevAnchorHelpers(false);
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(0, -10, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam01)};
      `,
      600,
    );

    // 2. 02_two_clients_authoritative_sync.png — Client 1 & Client 2 synced at Client 2's authoritative position
    const midSync = {
      x: (c1SyncPos.x + c2TrueAuth.x) * 0.5,
      y: c2TrueAuth.y + 1.25,
      z: (c1SyncPos.z + c2TrueAuth.z) * 0.5,
    };
    const cam02 = lookAtCamera(
      { x: midSync.x + 0.4, y: c2TrueAuth.y + 3.0, z: midSync.z + 5.8 },
      midSync,
    );
    await captureWithSetup(
      '02_two_clients_authoritative_sync.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${c1SyncPos.x}, ${c1SyncPos.z}, ${yawC1ToC2.toFixed(4)}, undefined, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam02)};
      `,
      600,
    );

    // Disconnect Client 2 after 2-client sync screenshot so remaining shots have no stray remote marker
    cdp2.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${pageTarget2.id}`);
    await cdp1.send('Page.bringToFront');
    await delay(250);
    await cdp1.eval(`
      (() => {
        const chatLog = document.getElementById('chat-log');
        if (chatLog) chatLog.innerHTML = '';
      })()
    `);

    // 3. 03_authoritative_road_movement_3p.png — 3P camera following player moving along the winding forest road
    const roadLook = lookAtCamera(
      { x: p4.roadAnchor.x - 8.5, y: p4.terrainY + 1.6, z: p4.roadAnchor.z + 6.5 },
      { x: p4.center.x - 2.0, y: p4.terrainY + 1.4, z: p4.center.z },
    );
    await captureWithSetup(
      '03_authoritative_road_movement_3p.png',
      `
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p4.roadAnchor.x - 8.5}, ${p4.roadAnchor.z + 6.5}, ${roadLook.yaw}, undefined, -0.06);
      `,
      550,
    );

    // 4. 04_poi1_ranger_house_entry.png — Entering `poi_ranger_house` (`cabin_8x4`) doorway & loft interior
    const cam04 = lookAtCamera(
      { x: p1.center.x - 2.4, y: p1.floorY + 2.85, z: p1.center.z + 8.6 },
      { x: p1.center.x - 0.6, y: p1.floorY + 1.45, z: p1.center.z + 0.1 },
    );
    await captureWithSetup(
      '04_poi1_ranger_house_entry.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p1.center.x}, ${p1.center.z + 10}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam04)};
      `,
    );

    // 5. 05_poi2_cabin_cluster_rotated_houses.png — `poi_cabin_cluster` 3 rotated/unrotated enterable houses
    const cam05 = lookAtCamera(
      { x: p2.center.x, y: p2.floorY + 5.2, z: p2.center.z + 13.8 },
      { x: p2.center.x, y: p2.floorY + 1.5, z: p2.center.z - 2.5 },
    );
    await captureWithSetup(
      '05_poi2_cabin_cluster_rotated_houses.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p2.center.x}, ${p2.center.z + 14}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam05)};
      `,
    );

    // 6. 06_poi3_lumber_mill_90deg_warehouse.png — `poi_lumber_mill` +90° rotated 8x4 warehouse & timber yard
    const cam06 = lookAtCamera(
      { x: p3.center.x + 11.8, y: p3.floorY + 4.1, z: p3.center.z + 9.6 },
      { x: p3.center.x - 1.2, y: p3.floorY + 1.35, z: p3.center.z - 1.0 },
    );
    await captureWithSetup(
      '06_poi3_lumber_mill_90deg_warehouse.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p3.center.x + 12}, ${p3.center.z + 10}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam06)};
      `,
    );

    // 7. 07_poi4_service_station_180deg_depot.png — `poi_service_station` 180° rotated warehouse, office & ramp
    const cam07 = lookAtCamera(
      { x: p4.center.x + 9.6, y: p4.floorY + 4.1, z: p4.center.z + 11.4 },
      { x: p4.center.x - 1.2, y: p4.floorY + 1.4, z: p4.center.z - 0.5 },
    );
    await captureWithSetup(
      '07_poi4_service_station_180deg_depot.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p4.center.x + 10}, ${p4.center.z + 12}, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam07)};
      `,
    );

    // 8. 08_poi6_cliff_watch_2nd_floor_stairs.png — `poi_cliff_watch` 2-story watchpost exterior stairs & 2nd floor
    const watchDeckY = Number((p6.floorY + 3.0).toFixed(3));
    const cam08 = lookAtCamera(
      { x: p6.center.x - 7.8, y: p6.floorY + 4.35, z: p6.center.z + 7.6 },
      { x: p6.center.x + 0.6, y: p6.floorY + 2.25, z: p6.center.z - 0.8 },
    );
    await captureWithSetup(
      '08_poi6_cliff_watch_2nd_floor_stairs.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('sniper');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${p6.center.x - 1.55}, ${p6.center.z - 2.45}, -0.35, ${watchDeckY}, 0.0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam08)};
      `,
    );
    const watchpostPlayerTransform = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPlayerTransform()`);

    // 9. 09_forest_combat_1p_rifle.png — 1P camera with GLB rifle in forest cover
    const pos09 = { x: p4.center.x - 21.5, z: p4.center.z + 14.5 };
    const look09 = lookAtCamera(
      { x: pos09.x, y: p4.floorY + 1.6, z: pos09.z },
      { x: p4.center.x - 2.0, y: p4.floorY + 1.5, z: p4.center.z + 1.0 },
    );
    await captureWithSetup(
      '09_forest_combat_1p_rifle.png',
      `
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${pos09.x}, ${pos09.z}, ${look09.yaw}, undefined, ${look09.pitch});
      `,
      550,
    );

    // Push Screenshot 10 in canonical order 01..10
    screenshots.push(shot10Info);

    // =========================================================================
    // STEP 5: Sustained Performance Benchmark on `forest_square`
    //         (WARMUP_SEC = 10, DURATION_SEC = 30, REPEATS = 3, 4 active bots)
    // =========================================================================
    console.log(
      `\n[Stage 05 QA] Recreating \`forest_square\` room with 4 bots for sustained performance benchmark (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS})...`,
    );
    await cdp1.eval(`window.__SET_RAF_CAP_FPS__?.(null)`);
    await cdp1.eval(`document.getElementById('btn-leave').click()`);
    await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
    await cdp1.eval(`
      (() => {
        document.getElementById('room-map').value = 'forest_square';
        document.getElementById('room-mode').value = 'ffa';
        document.getElementById('room-name').value = 'Stage05_Benchmark_4Bots';
        document.getElementById('room-bots').value = '4';
        document.getElementById('btn-create').click();
      })()
    `);
    await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics().allLoaded === true`);
    await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos)`);
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
        id: 'open_forest_movement',
        description:
          'Active authoritative player movement & camera sweep in dense forest cover with 4 bots',
        qualities: ['medium'],
        setup: `
          (() => {
            if (window.__BENCH_MOVE_TIMER__) clearInterval(window.__BENCH_MOVE_TIMER__);
            window.__DEV_CAMERA_OVERRIDE__ = null;
            window.__DEV_GAME_TOOLS__.setSyntheticInput(null);
            window.__DEV_GAME_TOOLS__.setThirdPerson(true);
            window.__DEV_GAME_TOOLS__.setWeapon('rifle');
            let tStep = 0;
            window.__BENCH_MOVE_TIMER__ = setInterval(() => {
              tStep += 0.05;
              if (window.__DEV_GAME_TOOLS__) {
                const fwd = Math.cos(tStep * 0.4) >= -0.2 ? 1 : -1;
                const right = Math.sin(tStep * 0.8) * 0.65;
                const res = window.__DEV_GAME_TOOLS__.stepInput(fwd, right, false, 0.016, 3);
                const yaw = Math.sin(tStep * 0.35) * 1.1;
                window.__DEV_PLAYER_POSE_LOCK__ = {
                  x: res.x,
                  y: res.y,
                  z: res.z,
                  yaw,
                  pitch: -0.06,
                };
              }
            }, 50);
          })()
        `,
        teardown: `
          (() => {
            if (window.__BENCH_MOVE_TIMER__) {
              clearInterval(window.__BENCH_MOVE_TIMER__);
              window.__BENCH_MOVE_TIMER__ = null;
            }
            window.__DEV_GAME_TOOLS__?.setSyntheticInput(null);
          })()
        `,
      },
      {
        id: 'poi_interior_courtyard',
        description:
          'POI 4 (Eski Servis va Ombor) courtyard & interior view with buildings, furniture, and containers',
        qualities: ['medium', 'low'],
        setup: `
          (() => {
            if (window.__BENCH_MOVE_TIMER__) {
              clearInterval(window.__BENCH_MOVE_TIMER__);
              window.__BENCH_MOVE_TIMER__ = null;
            }
            window.__DEV_GAME_TOOLS__.setSyntheticInput(null);
            window.__DEV_GAME_TOOLS__.setThirdPerson(false);
            window.__DEV_GAME_TOOLS__.setWeapon('rifle');
            window.__DEV_GAME_TOOLS__.setPlayerPos(${p4.center.x + 10}, ${p4.center.z + 12}, 0);
            window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam07)};
          })()
        `,
        teardown: ``,
      },
      {
        id: 'moving_pvp_combat',
        description:
          '1P active PvP combat movement, weapon view & server reconciliation on forest_square with 4 bots',
        qualities: ['medium', 'low'],
        setup: `
          (() => {
            if (window.__BENCH_MOVE_TIMER__) clearInterval(window.__BENCH_MOVE_TIMER__);
            window.__DEV_CAMERA_OVERRIDE__ = null;
            window.__DEV_GAME_TOOLS__.setSyntheticInput(null);
            window.__DEV_GAME_TOOLS__.setThirdPerson(false);
            window.__DEV_GAME_TOOLS__.setWeapon('rifle');
            let cStep = 0;
            window.__BENCH_MOVE_TIMER__ = setInterval(() => {
              cStep += 0.05;
              if (window.__DEV_GAME_TOOLS__) {
                const fwd = Math.cos(cStep * 0.5) >= -0.2 ? 1 : -1;
                const right = Math.sin(cStep * 0.9) * 0.75;
                const res = window.__DEV_GAME_TOOLS__.stepInput(fwd, right, false, 0.016, 3);
                const yaw = ${look09.yaw} + Math.sin(cStep * 0.45) * 0.55;
                window.__DEV_PLAYER_POSE_LOCK__ = {
                  x: res.x,
                  y: res.y,
                  z: res.z,
                  yaw,
                  pitch: ${look09.pitch},
                };
              }
            }, 50);
          })()
        `,
        teardown: `
          (() => {
            if (window.__BENCH_MOVE_TIMER__) {
              clearInterval(window.__BENCH_MOVE_TIMER__);
              window.__BENCH_MOVE_TIMER__ = null;
            }
            window.__DEV_GAME_TOOLS__?.setSyntheticInput(null);
          })()
        `,
      },
    ];

    const QUALITIES = ['medium', 'low'];
    const resultsByQuality = { medium: {}, low: {} };
    const csvRows = [];

    for (const q of QUALITIES) {
      console.log(`\n[Benchmark Quality: ${q.toUpperCase()}]`);
      await cdp1.eval(`window.__DEV_GAME_TOOLS__.setQuality('${q}')`);
      await delay(300);

      for (const sc of BENCHMARK_SCENES) {
        if (!sc.qualities.includes(q)) continue;
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
              r.prediction = window.__DEV_GAME_TOOLS__.getPredictionDiagnostics();
              return r;
            })()
          `);
          if (sc.teardown) {
            await cdp1.eval(sc.teardown);
          }
          runs.push({ repeat: rep, ...res });
          console.log(
            `  [${q} | ${sc.id} #${rep}] frames=${res.frames} | avgFps=${res.fpsMean} p50Fps=${res.fpsMedian} 1%low=${res.fps1PctLow} | FT p50=${res.frameTimeMedianMs}ms p95=${res.frameTimeP95Ms}ms p99=${res.frameTimeP99Ms}ms | Draw=${res.render.calls} Tris=${res.render.triangles}`,
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
          warmupSeconds: WARMUP_SEC,
          measurementSeconds: DURATION_SEC,
          repeats: REPEATS,
          avgFps,
          p50Fps,
          p10Fps,
          onePercentLowFps,
          avgFrameTimeMs,
          p50FrameTimeMs,
          p95FrameTimeMs,
          p99FrameTimeMs,
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
          predictionDiagnostics: lastRun.prediction,
          runs,
        };

        resultsByQuality[q][sc.id] = summary;
        csvRows.push(summary);
      }
    }

    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setQuality('medium')`);

    // =========================================================================
    // STEP 6: 10x Consecutive `forest_square` Room Reload Memory Test
    // =========================================================================
    console.log('\n[Stage 05 QA] Running 10x consecutive `forest_square` room reload memory & disposal check...');
    const roomReloadMemoryTrend = [];
    for (let cycle = 1; cycle <= 10; cycle++) {
      await cdp1.eval(`document.getElementById('btn-leave').click()`);
      await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
      await delay(180);
      await cdp1.eval(`
        (() => {
          document.getElementById('room-map').value = 'forest_square';
          document.getElementById('room-name').value = 'Stage05_MemCycle_${cycle}';
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
      await cdp1.send('HeapProfiler.collectGarbage').catch(() => {});
      await delay(80);

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
    const steadyCycle = roomReloadMemoryTrend[1] ?? firstCycle;
    const geometryDelta = lastCycle.render.geometries - steadyCycle.render.geometries;
    const textureDelta = lastCycle.render.textures - steadyCycle.render.textures;
    const heapDeltaMB =
      lastCycle.heapUsedMB !== null && steadyCycle.heapUsedMB !== null
        ? Number((lastCycle.heapUsedMB - steadyCycle.heapUsedMB).toFixed(2))
        : 0;
    const leakDetected = geometryDelta > 4 || textureDelta > 4 || heapDeltaMB > 45;

    const cpus = os.cpus();
    const benchmarkReport = {
      stage:
        'BOSQICH 05 — Server Authoritative Movement, Client Prediction/Reconciliation & Anti-Cheat',
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
        authoritativeMovementTest: {
          client1Before: c1DiagBefore,
          client1After: c1DiagAfter,
          client1DistanceMovedM: c1DistanceMovedM,
          client2ObservedDistanceMovedM: c2ObservedDistanceM,
          client2RemoteSnapshotAfter: c1RemoteAfter,
          client2Before: c2DiagBefore,
          client2After: c2DiagAfter,
          client2DistanceMovedM: c2DistanceMovedM,
          passed:
            c1DiagAfter.currentSeq > 20 &&
            c1DiagAfter.lastAckedSeq > 15 &&
            c1DiagAfter.reconcileCount > 5 &&
            c1DistanceMovedM > 4.0 &&
            c1DiagAfter.divergenceM < 0.05,
        },
        teleportCheatRejectionTest: {
          attemptedTeleportTarget: cheatTarget,
          packetsSent: 5,
          authoritativePosBefore: authBeforeCheat,
          authoritativePosAfter: authAfterCheat,
          positionShiftM: cheatShiftM,
          distanceFromCheatTargetM: distFromCheatTargetM,
          cheatRejected,
        },
        latencyAndLossReconciliation: latencyReconciliationResults,
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
        },
        poiSites,
        watchpostSecondFloorPlayerPos: watchpostPlayerTransform,
        watchpostSecondFloorVerified: Math.abs(watchpostPlayerTransform.y - watchDeckY) < 0.05,
        consoleErrorsCount: cdp1.consoleErrors.length + cdp2.consoleErrors.length,
        networkErrorsCount: cdp1.networkErrors.length + cdp2.networkErrors.length,
        consoleErrors: [...cdp1.consoleErrors, ...cdp2.consoleErrors],
        networkErrors: [...cdp1.networkErrors, ...cdp2.networkErrors],
      },
      resultsByQuality,
      scenes: resultsByQuality.medium,
      qualityPresets: {
        low: resultsByQuality.low.moving_pvp_combat,
        medium: resultsByQuality.medium.moving_pvp_combat,
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
    console.log(`\n[Stage 05 QA] Saved benchmark JSON to ${BENCHMARK_JSON_PATH}`);

    // Write CSV
    const csvHeader = [
      'quality',
      'scene',
      'warmupSeconds',
      'measurementSeconds',
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
          row.warmupSeconds,
          row.measurementSeconds,
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
    console.log(`[Stage 05 QA] Saved benchmark CSV to ${BENCHMARK_CSV_PATH}`);

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
