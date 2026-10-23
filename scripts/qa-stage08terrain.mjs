#!/usr/bin/env node
/**
 * STAGE 08-TERRAIN-VISUAL — Browser QA, Screenshots & Performance Benchmarking (Sub-agent F)
 *
 * Real Chrome (CDP) headless automation:
 * - Starts game server on PORT=3200 and Vite DEV server on PORT=5373
 * - Spawns Chrome at 1280x720 (DPR 1), quality medium, forest_square, seed=6501
 * - Captures high-resolution PNGs at the 8 required camera angles into docs/screenshots/stage08terrain/:
 *   1. 01_forest_clearing_eye_level.png
 *   2. 02_tree_shadow_ferns.png
 *   3. 03_moss_soil_ground_detail.png
 *   4. 04_winding_dirt_road_intersection.png
 *   5. 05_road_edge_flowers_grass.png
 *   6. 06_poi_ranger_yard_approach.png
 *   7a. 07a_first_person_near_grass.png
 *   7b. 07b_third_person_near_grass.png
 *   8. 08_topdown_map_overview.png
 * - Benchmarks 4 representative scenes for FPS (median, 1% low), frame times, draw calls, triangles, memory
 * - Generates docs/stage08terrain/benchmark_summary.json, benchmark_summary.csv, qa_terrain_summary.json
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.join(WORKSPACE, 'docs', 'stage08terrain');
const SHOT_DIR = path.join(WORKSPACE, 'docs', 'screenshots', 'stage08terrain');
const LOG_DIR = path.join(REPORT_DIR, 'logs');

for (const d of [REPORT_DIR, SHOT_DIR, LOG_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const SERVER_PORT = 3200;
const VITE_PORT = 5373;
const CHROME_DEBUG_PORT = 9400;
const SEED = 6501;

const log = (...m) => console.log('[08-TERRAIN QA]', ...m);

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* ignore */
  }
}

function findChrome() {
  const list = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const p of list) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome browser topilmadi');
}

async function waitForHttp(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch {
      await delay(250);
    }
  }
  return false;
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const percentile = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const r3 = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);

class CdpSession {
  constructor(wsUrl, label) {
    this.ws = new WebSocket(wsUrl);
    this.label = label;
    this.seq = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageExceptions = [];
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
          this.consoleErrors.push({ client: this.label, text: text.slice(0, 600) });
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const details = JSON.stringify(msg.params?.exceptionDetails ?? 'exception').slice(0, 800);
        this.pageExceptions.push({ client: this.label, details });
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
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`Eval error (${this.label}): ${JSON.stringify(res.exceptionDetails).slice(0, 1200)}`);
    }
    return res.result?.value;
  }
  async waitFor(expr, timeoutMs = 30000) {
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = await this.eval(expr);
        if (v) return v;
      } catch (e) {
        lastErr = e;
      }
      await delay(150);
    }
    throw new Error(`Timed out on ${this.label}: ${expr.slice(0, 200)} ${lastErr ? `(${lastErr.message})` : ''}`);
  }
  async screenshot(filename) {
    await this.send('Page.bringToFront');
    await delay(200);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const outPath = path.join(SHOT_DIR, filename);
    fs.writeFileSync(outPath, buf);
    log(`  [screenshot] ${filename} (${width}x${height}, ${(buf.length / 1024).toFixed(1)} KB)`);
    return { filename, path: `docs/screenshots/stage08terrain/${filename}`, width, height, bytes: buf.length };
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const PAGE_INIT_HOOK = `
  (() => {
    const progMap = new WeakMap();
    const origCreate = WebGL2RenderingContext.prototype.createProgram;
    const origDelete = WebGL2RenderingContext.prototype.deleteProgram;
    WebGL2RenderingContext.prototype.createProgram = function(...a) {
      progMap.set(this, (progMap.get(this) || 0) + 1);
      return origCreate.apply(this, a);
    };
    WebGL2RenderingContext.prototype.deleteProgram = function(...a) {
      progMap.set(this, Math.max(0, (progMap.get(this) || 0) - 1));
      return origDelete.apply(this, a);
    };
    window.__GET_WEBGL_PROGRAMS_COUNT__ = () => {
      const c = document.querySelector('canvas');
      const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
      return gl ? (progMap.get(gl) || 0) : 0;
    };
    const OrigWebSocket = window.WebSocket;
    window.__LAST_SNAP__ = null;
    window.__CREATE_ROOM_OVERRIDES__ = null;
    window.WebSocket = class extends OrigWebSocket {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string' && ev.data.startsWith('42[')) {
            try {
              const p = JSON.parse(ev.data.slice(2));
              if (Array.isArray(p) && p[0] === 'snap') window.__LAST_SNAP__ = p[1];
            } catch {}
          }
        });
      }
      send(data) {
        if (typeof data === 'string' && data.startsWith('42')) {
          const i = data.indexOf('[');
          if (i > 1) {
            const prefix = data.slice(0, i);
            try {
              const arr = JSON.parse(data.slice(i));
              if (Array.isArray(arr) && arr[0] === 'createRoom' && window.__CREATE_ROOM_OVERRIDES__) {
                const merged = Object.assign({}, arr[1] || {}, window.__CREATE_ROOM_OVERRIDES__);
                window.__CREATE_ROOM_OVERRIDES__ = null;
                return super.send(prefix + JSON.stringify(['createRoom', merged].concat(arr.slice(2))));
              }
            } catch {}
          }
        }
        return super.send(data);
      }
    };
  })();
`;

const STATS_EXPR = `(() => {
  const T = window.__DEV_GAME_TOOLS__;
  let gc = null;
  for (const k of ['getGroundCoverStats', 'getGroundCoverDiagnostics', 'getForestGroundCoverStats']) {
    if (typeof T?.[k] === 'function') {
      try { gc = T[k](); } catch (e) { gc = { error: String(e) }; }
      break;
    }
  }
  const el = document.getElementById('dev-stats');
  const devStatsText = el ? (el.innerText || el.textContent || '') : '';
  const perfMem = performance.memory;
  return {
    gc,
    devStatsText,
    render: T?.getRenderStats?.() ?? null,
    programs: typeof window.__GET_WEBGL_PROGRAMS_COUNT__ === 'function' ? window.__GET_WEBGL_PROGRAMS_COUNT__() : null,
    heapUsedMB: perfMem ? Number((perfMem.usedJSHeapSize / 1048576).toFixed(2)) : null,
  };
})()`;

const procs = { server: null, vite: null, chrome: null, userDataDir: null };

async function startServices() {
  const tsxCli = path.join(WORKSPACE, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const serverLog = fs.createWriteStream(path.join(LOG_DIR, `server_${SERVER_PORT}.log`));
  log(`Starting game server (PORT=${SERVER_PORT})...`);
  procs.server = spawn(process.execPath, [tsxCli, 'src/server/index.ts'], {
    cwd: WORKSPACE,
    env: { ...process.env, PORT: String(SERVER_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.server.stdout.pipe(serverLog);
  procs.server.stderr.pipe(serverLog);

  const serverReady = await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/api/info`, 60000);
  if (!serverReady) throw new Error('Game server failed to start within 60s');
  log('Game server ready.');

  const viteEntry = path.join(WORKSPACE, 'node_modules', 'vite', 'dist', 'node', 'index.js');
  const vite = await import(pathToFileURL(viteEntry).href);
  log(`Starting Vite DEV server on PORT=${VITE_PORT}...`);
  const cfg = {
    configFile: false,
    root: WORKSPACE,
    cacheDir: path.join(os.tmpdir(), `stickman-qa08terrain-vite-${VITE_PORT}`),
    logLevel: 'warn',
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port: VITE_PORT,
      strictPort: true,
      hmr: false,
      watch: null,
      proxy: {
        '/socket.io': { target: `http://127.0.0.1:${SERVER_PORT}`, ws: true },
        '/api': `http://127.0.0.1:${SERVER_PORT}`,
      },
    },
  };
  procs.vite = await vite.createServer(cfg);
  await procs.vite.listen();
  await waitForHttp(`http://127.0.0.1:${VITE_PORT}/`, 60000);
  log('Vite server ready.');

  const chromePath = findChrome();
  procs.userDataDir = path.join(os.tmpdir(), `stickman_qa08terrain_${Date.now()}`);
  fs.mkdirSync(procs.userDataDir, { recursive: true });
  const chromeArgs = [
    '--headless=new',
    `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
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
    `--user-data-dir=${procs.userDataDir}`,
    'about:blank',
  ];
  log('Starting Chrome headless...');
  procs.chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });
  await waitForHttp(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`, 30000);
  log('Chrome headless CDP ready.');
}

async function stopServices() {
  log('Cleaning up processes...');
  if (procs.chrome?.pid) killTree(procs.chrome.pid);
  try {
    await procs.vite?.close();
  } catch {}
  if (procs.server?.pid) killTree(procs.server.pid);
  await delay(300);
  try {
    if (procs.userDataDir) fs.rmSync(procs.userDataDir, { recursive: true, force: true });
  } catch {}
  log('All processes terminated.');
}

async function openClient(label) {
  const res = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  const cdp = new CdpSession(target.webSocketDebuggerUrl, label);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_INIT_HOOK });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/` });
  cdp.targetId = target.id;
  return cdp;
}

// ---------------------------------------------------------------------------------------------
// BENCHMARKING FUNCTION
// ---------------------------------------------------------------------------------------------
async function runSceneBenchmark(cdp, scene, warmupSec = 3, durationSec = 10, repeats = 2) {
  log(`  [bench] ${scene.id} (${scene.desc}): warmup=${warmupSec}s duration=${durationSec}s x${repeats}...`);

  await cdp.eval(`(() => {
    const T = window.__DEV_GAME_TOOLS__;
    T.setSyntheticInput?.(null);
    T.setThirdPerson(false);
    T.setPlayerPos(${scene.player.x}, ${scene.player.z}, ${scene.cam.yaw});
    window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(scene.cam)};
  })()`);

  const repeatResults = [];

  for (let rep = 0; rep < repeats; rep++) {
    // Warmup
    await delay(warmupSec * 1000);

    // Measurement via requestAnimationFrame deltas
    const measurement = await cdp.eval(`new Promise((resolve) => {
      const times = [];
      let last = performance.now();
      const tEnd = last + ${durationSec * 1000};
      function tick(now) {
        times.push(now - last);
        last = now;
        if (now < tEnd) {
          requestAnimationFrame(tick);
        } else {
          resolve(times);
        }
      }
      requestAnimationFrame(tick);
    })`);

    const frameDeltas = measurement.filter((dt) => dt > 0.5 && dt < 500); // Filter anomalies
    const fpsList = frameDeltas.map((dt) => 1000 / dt);
    const fpsMean = fpsList.reduce((a, b) => a + b, 0) / (fpsList.length || 1);
    const fpsMed = median(fpsList);
    const fpsP10 = percentile(fpsList, 0.1);
    const fps1Pct = percentile(fpsList, 0.01);
    const ftMed = median(frameDeltas);
    const ftP95 = percentile(frameDeltas, 0.95);
    const ftP99 = percentile(frameDeltas, 0.99);

    const stats = await cdp.eval(STATS_EXPR);

    repeatResults.push({
      fpsMean: r3(fpsMean),
      fpsMedian: r3(fpsMed),
      fpsP10: r3(fpsP10),
      fps1PctLow: r3(fps1Pct),
      frameTimeMedianMs: r3(ftMed),
      frameTimeP95Ms: r3(ftP95),
      frameTimeP99Ms: r3(ftP99),
      stats,
    });
  }

  // Aggregate over repeats
  const bestMed = median(repeatResults.map((r) => r.fpsMedian));
  const best1Pct = median(repeatResults.map((r) => r.fps1PctLow));
  const avgFtMed = median(repeatResults.map((r) => r.frameTimeMedianMs));
  const avgFtP95 = median(repeatResults.map((r) => r.frameTimeP95Ms));
  const avgFtP99 = median(repeatResults.map((r) => r.frameTimeP99Ms));
  const lastStats = repeatResults[repeatResults.length - 1].stats;

  const result = {
    id: scene.id,
    desc: scene.desc,
    fpsMedian: bestMed,
    fps1PctLow: best1Pct,
    frameTimeMedianMs: avgFtMed,
    frameTimeP95Ms: avgFtP95,
    frameTimeP99Ms: avgFtP99,
    drawCalls: lastStats?.render?.calls ?? 0,
    triangles: lastStats?.render?.triangles ?? 0,
    programs: lastStats?.programs ?? 0,
    heapUsedMB: lastStats?.heapUsedMB ?? 0,
    groundCover: lastStats?.gc ?? null,
  };

  log(`    -> FPS: ${bestMed} (1% low: ${best1Pct}), Calls: ${result.drawCalls}, Tris: ${result.triangles}, Heap: ${result.heapUsedMB} MB`);
  return result;
}

// ---------------------------------------------------------------------------------------------
// MAIN QA RUNNER
// ---------------------------------------------------------------------------------------------
async function main() {
  let cdp = null;
  try {
    await startServices();
    cdp = await openClient('qa_client');

    log('Waiting for connection and entering lobby...');
    await cdp.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`, 90000);
    await cdp.eval(`(() => {
      localStorage.removeItem('qa');
      const ni = document.getElementById('name-input');
      if (ni) ni.value = 'TerrainQA';
      document.getElementById('btn-enter')?.click();
    })()`);
    await cdp.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`, 30000);

    log('Creating TDM room with forest_square and seed=6501...');
    await cdp.eval(`(() => {
      window.__CREATE_ROOM_OVERRIDES__ = { publicLayoutSeed: ${SEED} };
      const m = document.getElementById('room-mode');
      if (m) { m.value = 'tdm'; m.dispatchEvent(new Event('change', { bubbles: true })); }
      const lp = document.getElementById('room-loot-preview');
      if (lp) { lp.checked = false; lp.dispatchEvent(new Event('change', { bubbles: true })); }
      const map = document.getElementById('room-map');
      if (map) map.value = 'forest_square';
      const b = document.getElementById('room-bots');
      if (b) { b.disabled = false; b.value = '0'; }
      const rn = document.getElementById('room-name');
      if (rn) rn.value = 'TerrainQA_Room';
      const rt = document.getElementById('room-time');
      if (rt) rt.value = '30';
      const sc = document.getElementById('room-score');
      if (sc) { sc.disabled = false; sc.value = '500'; }
      document.getElementById('btn-create')?.click();
    })()`);

    log('Waiting for game tools and scene to load...');
    await cdp.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`, 90000);

    // Wait for all assets (forest, buildings, outdoor, grass) to be ready
    await cdp.waitFor(`(() => {
      const T = window.__DEV_GAME_TOOLS__;
      if (!T) return false;
      const okAll = (o) => Object.values(o || {}).every((d) => d.loaded && !d.failed && !d.isFallback);
      return okAll(T.getDiagnostics?.()) && okAll(T.getForestDiagnostics?.());
    })()`, 120000);

    // Prepare clean HUD for screenshots
    await cdp.eval(`(() => {
      if (!document.getElementById('qa-terrain-hud')) {
        const st = document.createElement('style');
        st.id = 'qa-terrain-hud';
        st.textContent = '#pause-menu, #center-msg, #scoreboard, #death-screen, #toast { display: none !important; } #dev-stats { display: block !important; } body.qa-clean #hud-health, body.qa-clean #hud-ammo, body.qa-clean #chat, body.qa-clean #team-badge, body.qa-clean #killfeed, body.qa-clean #top-bar, body.qa-clean #reload-hint, body.qa-clean #crosshair { display: none !important; }';
        document.head.appendChild(st);
      }
      window.__DEV_GAME_TOOLS__.setQuality('medium');
    })()`);
    await delay(1000);

    // -----------------------------------------------------------------------------------------
    // CAPTURE 8 REQUIRED CAMERA ANGLES
    // -----------------------------------------------------------------------------------------
    log('Capturing 8 required high-resolution camera angles...');
    await cdp.eval(`document.body.classList.add('qa-clean')`);

    const shots = [
      {
        file: '01_forest_clearing_eye_level.png',
        desc: 'Open forest clearing (eye level: 64, 4) looking across glade with lush GLB grass & wildflowers',
        player: { x: 64, z: 4 },
        cam: { x: 64, y: 1.35, z: 4, yaw: 2.37, pitch: -0.09 },
        thirdPerson: false,
      },
      {
        file: '02_tree_shadow_ferns.png',
        desc: 'Tree shadow ferns at tree base (92.1, -31.6) showing shade-adapted ferns nestled under canopy',
        player: { x: 92.1, z: -31.6 },
        cam: { x: 92.1, y: 4.6, z: -31.6, yaw: 2.24, pitch: -0.35 },
        thirdPerson: false,
      },
      {
        file: '03_moss_soil_ground_detail.png',
        desc: 'Close ground shot showing micro-texture soil grain, gravel, velvet moss, and stylized grass tufts',
        player: { x: 30, z: 25 },
        cam: { x: 30, y: 0.55, z: 25, yaw: 0.8, pitch: -0.65 },
        thirdPerson: false,
      },
      {
        file: '04_winding_dirt_road_intersection.png',
        desc: 'Winding dirt road & shoulder transition (3.05, -87.5) showing dark earthy soil and tire rut depression tinting',
        player: { x: 3.05, z: -87.5 },
        cam: { x: 3.05, y: 4.58, z: -87.5, yaw: -0.16, pitch: -0.12 },
        thirdPerson: false,
      },
      {
        file: '05_road_edge_flowers_grass.png',
        desc: 'Road edge grass & 3 flower colors in south glade (-14, 58) showing oriented path-edge grass and white/yellow/purple clusters',
        player: { x: -14, z: 58 },
        cam: { x: -14, y: 1.6, z: 58, yaw: 0.0, pitch: -0.15 },
        thirdPerson: false,
      },
      {
        file: '06_poi_ranger_yard_approach.png',
        desc: 'POI Ranger House yard & approach (-71, -48) showing compacted woodland soil apron and building integration',
        player: { x: -71, z: -48 },
        cam: { x: -71, y: 3.2, z: -48, yaw: 3.14, pitch: -0.2 },
        thirdPerson: false,
      },
      {
        file: '07a_first_person_near_grass.png',
        desc: '1P camera view of near grass standing in lush meadow glade',
        player: { x: -14, z: 52 },
        cam: { x: -14, y: 1.6, z: 52, yaw: 0.6, pitch: -0.12 },
        thirdPerson: false,
      },
      {
        file: '07b_third_person_near_grass.png',
        desc: '3P camera view of near grass showing stickman character standing amidst dense stylized grass',
        player: { x: -14, z: 52 },
        cam: { x: -14, y: 2.2, z: 55, yaw: 0.0, pitch: -0.18 },
        thirdPerson: true,
      },
      {
        file: '08_topdown_map_overview.png',
        desc: 'Top-down map overview (256x256) showing complete winding dirt road network, POI clearings, and biomes',
        player: { x: 0, z: -10 },
        cam: { x: 0, y: 185, z: 80, yaw: 0, pitch: -1.03 },
        thirdPerson: false,
      },
    ];

    const capturedShots = [];

    for (const s of shots) {
      await cdp.eval(`(() => {
        const T = window.__DEV_GAME_TOOLS__;
        T.setSyntheticInput?.(null);
        T.setThirdPerson(${s.thirdPerson});
        T.setPlayerPos(${s.player.x}, ${s.player.z}, ${s.cam.yaw});
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(s.cam)};
      })()`);
      await delay(1500);
      const info = await cdp.screenshot(s.file);
      const stats = await cdp.eval(STATS_EXPR);
      capturedShots.push({
        ...info,
        desc: s.desc,
        cam: s.cam,
        stats,
      });
    }

    // -----------------------------------------------------------------------------------------
    // PERFORMANCE BENCHMARKING
    // -----------------------------------------------------------------------------------------
    log('Running performance benchmarks across 4 representative scenes...');
    const benchScenes = [
      {
        id: 'open_forest',
        desc: 'Open forest clearing (eye-level 64, 4)',
        player: { x: 64, z: 4 },
        cam: { x: 64, y: 1.35, z: 4, yaw: 2.37, pitch: -0.09 },
      },
      {
        id: 'service_station',
        desc: 'POI Service Station yard (20.8, -4.4)',
        player: { x: 20.8, z: -4.4 },
        cam: { x: 22.4, y: 3.04, z: -0.6, yaw: 0.64, pitch: -0.15 },
      },
      {
        id: 'forest_camp',
        desc: 'POI Forest Camp tents & clearing (-58.6, 72.2)',
        player: { x: -58.6, z: 72.2 },
        cam: { x: -60.8, y: 2.95, z: 74.8, yaw: -0.64, pitch: -0.16 },
      },
      {
        id: 'winding_road',
        desc: 'Winding road corridor & shoulder (3.05, -87.5)',
        player: { x: 3.05, z: -87.5 },
        cam: { x: 3.05, y: 4.58, z: -87.5, yaw: -0.16, pitch: -0.12 },
      },
    ];

    const benchmarkResults = [];
    for (const sc of benchScenes) {
      const res = await runSceneBenchmark(cdp, sc, 3, 10, 2);
      benchmarkResults.push(res);
    }

    // Reset camera override
    await cdp.eval(`(() => {
      window.__DEV_CAMERA_OVERRIDE__ = null;
      document.body.classList.remove('qa-clean');
    })()`);

    // -----------------------------------------------------------------------------------------
    // WRITE REPORTS & SUMMARY
    // -----------------------------------------------------------------------------------------
    const summary = {
      stage: '08-TERRAIN-VISUAL',
      testedAt: new Date().toISOString(),
      seed: SEED,
      quality: 'medium',
      resolution: '1280x720',
      screenshots: capturedShots.map((s) => ({
        file: s.filename,
        desc: s.desc,
        path: s.path,
        width: s.width,
        height: s.height,
        bytes: s.bytes,
        drawCalls: s.stats?.render?.calls ?? null,
        triangles: s.stats?.render?.triangles ?? null,
        groundCover: s.stats?.gc ?? null,
      })),
      benchmarks: benchmarkResults,
    };

    fs.writeFileSync(
      path.join(REPORT_DIR, 'qa_terrain_summary.json'),
      JSON.stringify(summary, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(REPORT_DIR, 'benchmark_summary.json'),
      JSON.stringify(benchmarkResults, null, 2),
      'utf8',
    );

    // CSV format
    const csvHeaders = ['scene_id', 'description', 'fps_median', 'fps_1pct_low', 'frametime_median_ms', 'frametime_p95_ms', 'frametime_p99_ms', 'draw_calls', 'triangles', 'heap_mb'];
    const csvRows = benchmarkResults.map((r) => [
      r.id,
      `"${r.desc}"`,
      r.fpsMedian,
      r.fps1PctLow,
      r.frameTimeMedianMs,
      r.frameTimeP95Ms,
      r.frameTimeP99Ms,
      r.drawCalls,
      r.triangles,
      r.heapUsedMB,
    ]);
    const csvContent = [csvHeaders.join(','), ...csvRows.map((row) => row.join(','))].join('\n');
    fs.writeFileSync(path.join(REPORT_DIR, 'benchmark_summary.csv'), csvContent, 'utf8');

    log('Successfully generated QA screenshots and benchmark reports!');
    console.log(JSON.stringify(summary, null, 2));

  } catch (err) {
    console.error('[08-TERRAIN QA] Fatal error:', err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    await stopServices();
  }
}

main();
