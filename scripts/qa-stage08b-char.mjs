#!/usr/bin/env node
/**
 * STAGE 08B-CHAR-INTEGRATION — Camper Buddy skinned character: real-Chrome browser QA (agent E)
 *
 * Same harness as `scripts/qa-stage08fix.mjs` / `scripts/qa-stage08a.mjs` / `scripts/benchmark-forest.mjs`:
 *   - Vite DEV server (DEV tools `window.__DEV_GAME_TOOLS__`, `__DEV_CAMERA_OVERRIDE__`) + game server
 *     (`src/server/index.ts` via tsx, `PORT` env) served from `--root`, on NON-default ports, HMR + watch off.
 *   - Chrome (CDP) 1280x720 DPR 1, quality `medium`, `forest_square`, `publicLayoutSeed=6501`.
 *   - Geometry (straight run lanes, nav paths to loot containers) comes from the SHARED movement code / server
 *     NavGraph via the long-lived helper `docs/stage08b-char/qa_lane_helper.ts` (tsx, built from `--root`).
 *   - Character diagnostics come from `__DEV_GAME_TOOLS__.getCharacterDiagnostics()` (08B hook). On builds
 *     without the hook (BEFORE baseline) every character-diag field is recorded as `null` and the dependent
 *     checks are reported as `SKIP` (never as PASS).
 *
 * Phases (`--phase=shots|video|multi|perf|all`):
 *   shots : remote-player view from client B, then (client A offline-local) 3P idle / 3P run / 3P jump, 1P per weapon,
 *           close-ups front/side/back @2.2 m, h 1.0 m for unarmed + 4 weapons  → qa_shots/<label>_*.png
 *   video : CDP Page.startScreencast → constant 30 fps VP8 webm (ffmpeg): remote_run (B watches A run, server
 *           authoritative), walk_3p, run_3p, walk_side, run_side                   → qa_videos/<label>_*.webm
 *   multi : 2 clients same room: visibility, gameplayHash/worldVersion, weapon equip sync, remote anim states,
 *           rejoin x5 leak check (heap + asset.liveInstances), FFA smoke, Forest Survival loot→equip, spectator
 *                                                                                    → qa_multi_<label>.json
 *   perf  : fixed camera, local player + client B visible, warmup + capture x repeats → qa_perf_<label>.json
 *
 * Usage:
 *   node scripts/qa-stage08b-char.mjs --phase=shots|video|multi|perf|all --label=before|after
 *        [--out=docs/stage08b-char] [--root=<checkout>] [--port=3300] [--vitePort=5473] [--debugPort=9500]
 *        [--warmup=5] [--duration=20] [--repeats=2] [--clipSec=6] [--rejoins=5] [--multiParts=tdm,ffa,survival] [--headful]
 *   (--phase also accepts a comma list, e.g. --phase=shots,video)
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, ...rest] = arg.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : 'true'];
  }),
);

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(args.root ?? WORKSPACE);
const LABEL = String(args.label ?? 'after');
const PHASE = String(args.phase ?? 'all');
const OUT_DIR = path.resolve(WORKSPACE, String(args.out ?? 'docs/stage08b-char'));
const PORT = Number(args.port ?? 3300);
const VITE_PORT = Number(args.vitePort ?? 5473);
const DEBUG_PORT = Number(args.debugPort ?? PORT + 6200);
const WARMUP_SEC = Number(args.warmup ?? 5);
const DURATION_SEC = Number(args.duration ?? 20);
const REPEATS = Number(args.repeats ?? 2);
const CLIP_SEC = Number(args.clipSec ?? 6);
const REJOINS = Number(args.rejoins ?? 5);
const HEADFUL = args.headful === 'true';
const SEED = 6501;
const EXPECTED_HASH = '670a9c21f0565c94';
const EXPECTED_WORLD_VERSION = 2;
const WEAPONS = ['rifle', 'pistol', 'shotgun', 'sniper'];
const VIDEO_FPS = 30;

const SHOT_DIR = path.join(OUT_DIR, 'qa_shots');
const VIDEO_DIR = path.join(OUT_DIR, 'qa_videos');
const LOG_DIR = path.join(OUT_DIR, 'qa_logs');
for (const d of [OUT_DIR, SHOT_DIR, VIDEO_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });
const rel = (p) => path.relative(WORKSPACE, p).split(path.sep).join('/');

const log = (...m) => console.log(`[08B-CHAR QA ${LABEL}]`, ...m);

// ---------------------------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------------------------
function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Google Chrome not found (set CHROME_PATH)');
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const pwRoot = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const searchDirs = [path.join(pwRoot, 'ffmpeg-1011')];
  try {
    for (const d of fs.readdirSync(pwRoot)) if (d.startsWith('ffmpeg')) searchDirs.push(path.join(pwRoot, d));
  } catch {
    /* ignore */
  }
  for (const d of searchDirs) {
    try {
      for (const f of fs.readdirSync(d)) if (/^ffmpeg.*\.exe$/i.test(f) || f === 'ffmpeg') return path.join(d, f);
    } catch {
      /* ignore */
    }
  }
  try {
    const w = execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)[0]
      .trim();
    if (w) return w;
  } catch {
    /* ignore */
  }
  return null;
}

async function httpOk(url) {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}
async function waitForHttp(url, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await httpOk(url)) return true;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
}
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const r3 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);
const mode = (arr) => {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) ?? 0) + 1);
  let best = null;
  let bc = -1;
  for (const [k, c] of m)
    if (c > bc) {
      best = k;
      bc = c;
    }
  return best;
};
const fwdOf = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const rightOf = (yaw) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });
function lookAtCamera(eye, target) {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const horiz = Math.hypot(dx, dz) || 1e-6;
  return { x: r3(eye.x), y: r3(eye.y), z: r3(eye.z), yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, horiz) };
}

// ---------------------------------------------------------------------------------------------
// CDP session (08FIX style + event listeners for screencast)
// ---------------------------------------------------------------------------------------------
class CdpSession {
  constructor(wsUrl, label) {
    this.ws = new WebSocket(wsUrl);
    this.label = label;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.consoleErrors = [];
    this.consoleWarnings = 0;
    this.pageExceptions = [];
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
        return;
      }
      const ls = msg.method && this.listeners.get(msg.method);
      if (ls) for (const fn of ls) fn(msg.params);
      if (msg.method === 'Runtime.consoleAPICalled') {
        if (msg.params?.type === 'error') {
          const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
          this.consoleErrors.push({ client: this.label, text: text.slice(0, 600) });
        } else if (msg.params?.type === 'warning') this.consoleWarnings++;
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const details = JSON.stringify(msg.params?.exceptionDetails ?? 'exception').slice(0, 800);
        this.pageExceptions.push({ client: this.label, details });
      } else if (msg.method === 'Network.responseReceived') {
        const status = msg.params?.response?.status ?? 200;
        const url = msg.params?.response?.url ?? '';
        if (status >= 400) this.networkErrors.push({ client: this.label, status, url });
      } else if (msg.method === 'Network.loadingFailed') {
        const errText = msg.params?.errorText ?? '';
        if (errText && errText !== 'net::ERR_ABORTED') this.networkErrors.push({ client: this.label, status: 'FAILED', errorText: errText });
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }
  off(method, fn) {
    this.listeners.get(method)?.delete(fn);
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
    if (res.exceptionDetails) throw new Error(`Eval error (${this.label}): ${JSON.stringify(res.exceptionDetails).slice(0, 1200)}`);
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
    throw new Error(`Timed out on ${this.label}: ${expr.slice(0, 200)} ${lastErr ? `(last error: ${lastErr.message.slice(0, 200)})` : ''}`);
  }
  async screenshot(name) {
    await this.send('Page.bringToFront');
    await delay(120);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const filename = `${LABEL}_${name}.png`;
    const outPath = path.join(SHOT_DIR, filename);
    fs.writeFileSync(outPath, buf);
    log(`  [shot] ${filename} (${width}x${height}, ${buf.length} B)`);
    return { file: rel(outPath), width, height, bytes: buf.length };
  }
  errorsSummary() {
    return { consoleErrors: this.consoleErrors, consoleWarnings: this.consoleWarnings, pageExceptions: this.pageExceptions, networkErrors: this.networkErrors };
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const PAGE_INIT_HOOK_SOURCE = `
  (() => {
    const progMap = new WeakMap();
    const origCreate = WebGL2RenderingContext.prototype.createProgram;
    const origDelete = WebGL2RenderingContext.prototype.deleteProgram;
    WebGL2RenderingContext.prototype.createProgram = function(...a) { progMap.set(this, (progMap.get(this) || 0) + 1); return origCreate.apply(this, a); };
    WebGL2RenderingContext.prototype.deleteProgram = function(...a) { progMap.set(this, Math.max(0, (progMap.get(this) || 0) - 1)); return origDelete.apply(this, a); };
    window.__GET_WEBGL_PROGRAMS_COUNT__ = () => {
      const c = document.querySelector('canvas');
      const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
      return gl ? (progMap.get(gl) || 0) : 0;
    };
    const OrigWebSocket = window.WebSocket;
    window.__LAST_SNAP__ = null;
    window.__CREATE_ROOM_OVERRIDES__ = null;
    // QA offline-local mute: drops incoming 'snap' and outgoing 'input' socket.io frames at the WebSocket level
    // (engine.io assigns ws.onmessage; heartbeats and every other event still flow, so the socket stays connected)
    window.__QA_NET_MUTE__ = false;
    window.__QA_NET_MUTE_STATS__ = { droppedSnaps: 0, droppedInputs: 0 };
    const onmsgDesc = Object.getOwnPropertyDescriptor(OrigWebSocket.prototype, 'onmessage');
    window.WebSocket = class extends OrigWebSocket {
      get onmessage() { return onmsgDesc.get.call(this); }
      set onmessage(fn) {
        onmsgDesc.set.call(this, typeof fn !== 'function' ? fn : (ev) => {
          if (window.__QA_NET_MUTE__ && typeof ev.data === 'string' && ev.data.startsWith('42["snap"')) { window.__QA_NET_MUTE_STATS__.droppedSnaps++; return; }
          return fn.call(this, ev);
        });
      }
      constructor(...a) {
        super(...a);
        (window.__QA_WS__ = window.__QA_WS__ || []).push(this);
        this.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string' && ev.data.startsWith('42[')) {
            try { const p = JSON.parse(ev.data.slice(2)); if (Array.isArray(p) && p[0] === 'snap') window.__LAST_SNAP__ = p[1]; } catch {}
          }
        });
      }
      send(data) {
        if (window.__QA_NET_MUTE__ && typeof data === 'string' && data.startsWith('42') && data.startsWith('["input"', data.indexOf('['))) { window.__QA_NET_MUTE_STATS__.droppedInputs++; return; }
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
    const origRAF = window.requestAnimationFrame.bind(window);
    let rafCapFps = 60;
    window.__SET_RAF_CAP_FPS__ = (fps) => { rafCapFps = fps && fps > 0 ? Number(fps) : null; };
    window.requestAnimationFrame = (cb) => {
      if (!rafCapFps) return origRAF(cb);
      const intervalMs = Math.max(4, Math.floor(1000 / rafCapFps));
      return window.setTimeout(() => origRAF(cb), intervalMs);
    };
  })();
`;

// ---------------------------------------------------------------------------------------------
// services
// ---------------------------------------------------------------------------------------------
const procs = { server: null, vite: null, chrome: null, userDataDir: null, helper: null };

async function startServices() {
  if (await httpOk(`http://127.0.0.1:${PORT}/api/info`)) throw new Error(`Port ${PORT} already serves /api/info — choose another --port`);
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) throw new Error(`tsx not found at ${tsxCli} (node_modules missing in --root? create a junction)`);
  const serverLog = fs.createWriteStream(path.join(LOG_DIR, `${LABEL}_server_${PORT}.log`));
  log(`Starting game server: tsx src/server/index.ts (cwd=${ROOT}, PORT=${PORT})`);
  procs.server = spawn(process.execPath, [tsxCli, 'src/server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.server.stdout.pipe(serverLog);
  procs.server.stderr.pipe(serverLog);
  await waitForHttp(`http://127.0.0.1:${PORT}/api/info`, 90000);

  const viteEntry = path.join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js');
  const vite = await import(pathToFileURL(viteEntry).href);
  let nmReal = path.join(ROOT, 'node_modules');
  try {
    nmReal = fs.realpathSync(nmReal);
  } catch {
    /* ignore */
  }
  log(`Starting Vite DEV server on ${VITE_PORT} (root=${ROOT}, hmr=false, watch=null, proxy → ${PORT})`);
  procs.vite = await vite.createServer({
    configFile: false,
    root: ROOT,
    cacheDir: path.join(os.tmpdir(), `camper-qa08b-vite-${LABEL}-${VITE_PORT}`),
    logLevel: 'warn',
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port: VITE_PORT,
      strictPort: true,
      hmr: false,
      watch: null,
      fs: { allow: [ROOT, nmReal] },
      proxy: {
        '/socket.io': { target: `http://127.0.0.1:${PORT}`, ws: true },
        '/api': `http://127.0.0.1:${PORT}`,
      },
    },
  });
  await procs.vite.listen();
  await waitForHttp(`http://127.0.0.1:${VITE_PORT}/`, 60000);
  await waitForHttp(`http://127.0.0.1:${VITE_PORT}/api/info`, 30000);

  const chromePath = findChromePath();
  procs.userDataDir = path.join(os.tmpdir(), `camper_qa08b_${LABEL}_${Date.now()}`);
  fs.mkdirSync(procs.userDataDir, { recursive: true });
  const chromeArgs = [
    ...(HEADFUL ? [] : ['--headless=new']),
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--window-size=1280,720',
    '--force-device-scale-factor=1',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--enable-precise-memory-info',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${procs.userDataDir}`,
    'about:blank',
  ];
  procs.chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });
  await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 30000);
  const versionInfo = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  return { versionInfo, chromeArgs };
}

async function stopServices() {
  try {
    procs.helper?.proc?.stdin?.end();
  } catch {
    /* ignore */
  }
  if (procs.helper?.proc?.pid) killTree(procs.helper.proc.pid);
  if (procs.chrome?.pid) killTree(procs.chrome.pid);
  try {
    await procs.vite?.close();
  } catch {
    /* ignore */
  }
  if (procs.server?.pid) killTree(procs.server.pid);
  await delay(400);
  try {
    if (procs.userDataDir) fs.rmSync(procs.userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------
// geometry helper (tsx child, JSON lines)
// ---------------------------------------------------------------------------------------------
async function startHelper() {
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const helperPath = path.join(WORKSPACE, 'docs', 'stage08b-char', 'qa_lane_helper.ts');
  const proc = spawn(process.execPath, [tsxCli, helperPath, ROOT, String(SEED)], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const rlh = readline.createInterface({ input: proc.stdout });
  const waiters = new Map();
  let ready;
  const readyP = new Promise((res) => (ready = res));
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += String(d)).slice(-4000));
  rlh.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.ready) return ready(msg);
    const w = waiters.get(msg.id);
    if (w) {
      waiters.delete(msg.id);
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new Error(msg.error));
    }
  });
  proc.on('exit', (code) => {
    for (const w of waiters.values()) w.reject(new Error(`helper exited (${code}): ${stderr.slice(-800)}`));
    waiters.clear();
  });
  let nextId = 1;
  const call = (cmd, payload = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiters.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n');
    });
  const meta = await Promise.race([
    readyP,
    delay(120000).then(() => {
      throw new Error(`helper not ready: ${stderr.slice(-800)}`);
    }),
  ]);
  log(`geometry helper ready: hash=${meta.gameplayHash} v${meta.worldVersion}`);
  procs.helper = { proc, call, meta };
  return procs.helper;
}
let laneCache = null;
async function getLane() {
  if (!laneCache) {
    laneCache = await procs.helper.call('bestLane', { minLen: 46 });
    log(
      `best lane: start=(${laneCache.start.x}, ${laneCache.start.z}) yaw=${laneCache.yaw} len=${laneCache.len} side=${laneCache.side} sideClear=${laneCache.sideClearRatio} closeupClear=${laneCache.closeupClear}`,
    );
  }
  return laneCache;
}

// ---------------------------------------------------------------------------------------------
// clients
// ---------------------------------------------------------------------------------------------
const APP_URL = () => `http://127.0.0.1:${VITE_PORT}/`;
const openTargets = new Set();
const openSessions = new Set();

async function openClient(label) {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  const cdp = new CdpSession(target.webSocketDebuggerUrl, label);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_INIT_HOOK_SOURCE });
  await cdp.send('Page.navigate', { url: APP_URL() });
  cdp.targetId = target.id;
  openTargets.add(target.id);
  openSessions.add(cdp);
  return cdp;
}
async function closeClient(cdp) {
  if (!cdp) return;
  cdp.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${cdp.targetId}`).catch(() => {});
  openTargets.delete(cdp.targetId);
  openSessions.delete(cdp);
}
async function renavigate(cdp) {
  await cdp.send('Page.navigate', { url: APP_URL() });
  await delay(500);
}

async function enterLobby(cdp, name) {
  await cdp.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`, 90000);
  await cdp.eval(
    `(() => { localStorage.removeItem('qa'); document.getElementById('name-input').value = ${JSON.stringify(name)}; document.getElementById('btn-enter').click(); })()`,
  );
  await cdp.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`, 30000);
}

async function createRoom(cdp, roomName, gameMode = 'tdm', extraOverrides = {}) {
  await cdp.eval(`(() => {
    window.__CREATE_ROOM_OVERRIDES__ = Object.assign({ publicLayoutSeed: ${SEED} }, ${JSON.stringify(extraOverrides)});
    const m = document.getElementById('room-mode'); m.value = ${JSON.stringify(gameMode)}; m.dispatchEvent(new Event('change', { bubbles: true }));
    const lp = document.getElementById('room-loot-preview'); if (lp && ${JSON.stringify(gameMode)} !== 'forest_survival') { lp.checked = false; lp.dispatchEvent(new Event('change', { bubbles: true })); }
    const map = document.getElementById('room-map'); if (map && !map.disabled) { map.value = 'forest_square'; map.dispatchEvent(new Event('change', { bubbles: true })); }
    const b = document.getElementById('room-bots'); if (b) { b.disabled = false; b.value = '0'; }
    document.getElementById('room-name').value = ${JSON.stringify(roomName)};
    const tm = document.getElementById('room-time'); if (tm) tm.value = '30';
    const sc = document.getElementById('room-score'); if (sc) { sc.disabled = false; sc.value = '500'; }
    document.getElementById('btn-create').click();
  })()`);
  await cdp.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`, 90000);
}

async function joinRoomByName(cdp, roomName) {
  await cdp.eval(`document.getElementById('btn-refresh')?.click()`);
  await cdp.waitFor(
    `(() => {
    const items = Array.from(document.querySelectorAll('.room-item'));
    const it = items.find((el) => el.textContent?.includes(${JSON.stringify(roomName)}));
    const btn = it?.querySelector('[data-join]');
    if (!btn) { document.getElementById('btn-refresh')?.click(); return false; }
    btn.click(); return true;
  })()`,
    30000,
  );
  await cdp.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`, 90000);
}

const ASSETS_READY_EXPR = `(() => {
  const T = window.__DEV_GAME_TOOLS__; if (!T) return false;
  const okAll = (o) => Object.values(o || {}).every((d) => d.loaded && !d.failed && !d.isFallback);
  const w = okAll(T.getDiagnostics?.());
  const f = okAll(T.getForestDiagnostics?.());
  const s = T.getStage04ADiagnostics ? T.getStage04ADiagnostics().allLoaded : true;
  const o = T.getOutdoorDiagnostics ? (T.getOutdoorDiagnostics().allLoaded && T.getOutdoorDiagnostics().renderer?.allGlbLoaded !== false) : true;
  const c = T.getCharacterDiagnostics ? ['ready', 'failed'].includes(T.getCharacterDiagnostics().asset?.state) : true;
  return w && f && s && o && c;
})()`;

async function prepClient(cdp) {
  await cdp.waitFor(ASSETS_READY_EXPR, 120000);
  await cdp.eval(`(() => {
    if (!document.getElementById('qa-08b-hud')) {
      const st = document.createElement('style'); st.id = 'qa-08b-hud';
      st.textContent = '#pause-menu, #center-msg, #scoreboard, #death-screen, #toast { display: none !important; } body.qa-clean #hud-health, body.qa-clean #hud-ammo, body.qa-clean #chat, body.qa-clean #team-badge, body.qa-clean #killfeed, body.qa-clean #top-bar, body.qa-clean #reload-hint, body.qa-clean #dev-stats { display: none !important; } body.qa-nocross #crosshair { display: none !important; }';
      document.head.appendChild(st);
    }
    window.__DEV_GAME_TOOLS__.setQuality('medium');
  })()`);
  await delay(400);
}

async function gpuInfo(cdp) {
  return cdp.eval(`(() => {
    const c = document.querySelector('canvas');
    const gl = c?.getContext('webgl2') || c?.getContext('webgl');
    if (!gl) return { vendor: 'unknown', renderer: 'unknown' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION) };
  })()`);
}

const CHAR_DIAG_EXPR = `(() => { const T = window.__DEV_GAME_TOOLS__; if (!T || typeof T.getCharacterDiagnostics !== 'function') return null; try { return T.getCharacterDiagnostics(); } catch (e) { return { error: String(e) }; } })()`;
const charDiag = (cdp) => cdp.eval(CHAR_DIAG_EXPR);
const hasCharHook = (cdp) => cdp.eval(`typeof window.__DEV_GAME_TOOLS__?.getCharacterDiagnostics === 'function'`);
const slimLocal = (d) =>
  d && !d.error
    ? {
        mode: d.local?.mode ?? null,
        visible: d.local?.visible ?? null,
        state: d.local?.state ?? null,
        timeScale: r3(d.local?.timeScale),
        weapon: d.local?.weapon ?? null,
        muzzleWorld: d.local?.muzzleWorld ?? null,
        gripWorld: d.local?.gripWorld ?? null,
        weights: d.local?.weights ?? null,
        asset: d.asset
          ? {
              state: d.asset.state,
              liveInstances: d.asset.liveInstances,
              createdInstances: d.asset.createdInstances,
              disposedInstances: d.asset.disposedInstances,
              loadMs: d.asset.loadMs,
              error: d.asset.error,
            }
          : null,
      }
    : (d ?? null);
const remoteDiag = async (cdp, id) => {
  const d = await charDiag(cdp);
  if (!d || d.error) return d ?? null;
  return d.remotes?.find((r) => r.id === id) ?? { missing: true };
};

async function worldInfo(cdp) {
  return cdp.eval(
    `(() => { const T = window.__DEV_GAME_TOOLS__; return { meta: T.getWorldMeta?.() ?? null, gameplayHash: T.getGameplayHash?.() ?? T.getWorldMeta?.()?.gameplayHash ?? null, worldVersion: T.getWorldVersion?.() ?? T.getWorldMeta?.()?.worldVersion ?? null, roomId: T.getRoomId?.() ?? null }; })()`,
  );
}
const otherPlayers = (cdp) => cdp.eval(`window.__DEV_GAME_TOOLS__?.getOtherPlayers?.() ?? null`);
async function idByName(cdp, name, timeoutMs = 20000) {
  return cdp.waitFor(
    `(() => { const o = window.__DEV_GAME_TOOLS__?.getOtherPlayers?.() ?? []; return o.find((p) => p.name === ${JSON.stringify(name)})?.id ?? false; })()`,
    timeoutMs,
  );
}
async function authPos(cdp) {
  const d = await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
  return d.authoritativePos ?? d.predictedPos;
}
const transform = (cdp) => cdp.eval(`window.__DEV_GAME_TOOLS__.getPlayerTransform()`);
async function heapAfterGc(cdp) {
  try {
    await cdp.send('HeapProfiler.collectGarbage');
  } catch {
    /* ignore */
  }
  await delay(300);
  return cdp.eval(
    `(() => { const m = performance.memory; return m ? { usedMB: Number((m.usedJSHeapSize / 1048576).toFixed(2)), totalMB: Number((m.totalJSHeapSize / 1048576).toFixed(2)) } : null; })()`,
  );
}

/** page-side waypoint driver (server-authoritative movement through synthetic input; no teleports) */
async function startDriver(cdp, waypoints, { walk = false, arriveR = 0.9 } = {}) {
  await cdp.eval(`(() => {
    const T = window.__DEV_GAME_TOOLS__;
    if (window.__QA_DRIVER__) clearInterval(window.__QA_DRIVER__.timer);
    window.__DEV_CAMERA_OVERRIDE__ = window.__DEV_CAMERA_OVERRIDE__ ?? null;
    window.__DEV_PLAYER_POSE_LOCK__ = null; T.clearPlayerPoseLock?.();
    const st = { wps: ${JSON.stringify(waypoints)}, i: 0, walk: ${walk}, done: false, last: null, stuckMs: 0, detour: 0, t0: performance.now() };
    st.timer = setInterval(() => {
      const p = T.getPredictionDiagnostics().predictedPos;
      while (st.i < st.wps.length) {
        const w = st.wps[st.i];
        const prev = st.i > 0 ? st.wps[st.i - 1] : null;
        let passed = false;
        if (prev) { const sx = w.x - prev.x, sz = w.z - prev.z; passed = (p.x - w.x) * sx + (p.z - w.z) * sz > 0; }
        if (Math.hypot(w.x - p.x, w.z - p.z) < ${arriveR} || passed) st.i++; else break;
      }
      if (st.i >= st.wps.length) { st.done = true; T.setSyntheticInput({ fwd: 0, right: 0, jump: false, walk: st.walk, pitch: -0.05 }); return; }
      const w = st.wps[st.i];
      if (st.last) { const mv = Math.hypot(p.x - st.last.x, p.z - st.last.z); st.stuckMs = mv < 0.02 ? st.stuckMs + 33 : 0; }
      st.last = { x: p.x, z: p.z };
      let yaw = Math.atan2(-(w.x - p.x), -(w.z - p.z));
      let jump = false;
      if (st.stuckMs > 500) { st.detour++; yaw += (st.detour % 2 ? 1 : -1) * 1.1; jump = true; if (st.stuckMs > 900) st.stuckMs = 0; }
      T.setSyntheticInput({ fwd: 1, right: 0, jump, walk: st.walk, yaw, pitch: -0.05 });
    }, 33);
    window.__QA_DRIVER__ = st;
  })()`);
}
async function setDriverWalk(cdp, walk) {
  await cdp.eval(`(() => { if (window.__QA_DRIVER__) window.__QA_DRIVER__.walk = ${walk}; })()`);
}
async function stopDriver(cdp) {
  await cdp.eval(
    `(() => { if (window.__QA_DRIVER__) { clearInterval(window.__QA_DRIVER__.timer); window.__QA_DRIVER__ = null; } window.__DEV_GAME_TOOLS__?.setSyntheticInput(null); })()`,
  );
}
const driverState = (cdp) =>
  cdp.eval(`(() => { const s = window.__QA_DRIVER__; return s ? { i: s.i, n: s.wps.length, done: s.done, detours: s.detour } : null; })()`);

async function driveTo(cdp, waypoints, { walk = false, timeoutMs = 60000, arriveR = 0.7 } = {}) {
  await startDriver(cdp, waypoints, { walk, arriveR });
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < timeoutMs) {
    st = await driverState(cdp);
    if (!st || st.done) break;
    await delay(200);
  }
  await stopDriver(cdp);
  await delay(400);
  const p = await authPos(cdp);
  const last = waypoints[waypoints.length - 1];
  return { reached: Boolean(last) && Math.hypot(p.x - last.x, p.z - last.z) < arriveR + 0.6, pos: p, ms: Date.now() - t0, driver: st };
}

/**
 * offline-local mode for the single-client local-character phases: the init hook drops every incoming 'snap'
 * and outgoing 'input' frame (DEV netSim alone is clamped to dropRate 0.95, which still reconciles), so the
 * local player can be teleported to the deterministic lane and run there with pure client-side prediction.
 * Never used on a client that later needs server-authoritative movement.
 */
async function goOfflineLocal(cdp) {
  await cdp.eval(`(() => { const T = window.__DEV_GAME_TOOLS__; T.setSyntheticInput(null); window.__QA_NET_MUTE__ = true; })()`);
  await delay(300);
  const st = await cdp.eval(`window.__QA_NET_MUTE_STATS__`);
  if (!st || st.droppedSnaps === 0) throw new Error(`offline-local mute not effective (stats=${JSON.stringify(st)})`);
}

// ---------------------------------------------------------------------------------------------
// video: CDP screencast → constant-fps VP8 webm
// ---------------------------------------------------------------------------------------------
const FFMPEG = findFfmpeg();

async function encodeFrames(frames, durationSec, outPath) {
  if (!FFMPEG) return { error: 'ffmpeg not found' };
  if (!frames.length) return { error: 'no frames' };
  frames.sort((a, b) => a.ts - b.ts);
  const t0 = frames[0].ts;
  const n = Math.round(durationSec * VIDEO_FPS);
  const seq = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k / VIDEO_FPS;
    while (j + 1 < frames.length && frames[j + 1].ts <= t + 1e-4) j++;
    seq.push(j);
  }
  const used = new Set(seq);
  const proc = spawn(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(VIDEO_FPS),
      '-c:v',
      'mjpeg',
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'vp8',
      '-b:v',
      '3M',
      '-crf',
      '8',
      '-qmin',
      '0',
      '-qmax',
      '40',
      '-deadline',
      'good',
      '-cpu-used',
      '4',
      '-pix_fmt',
      'yuv420p',
      '-y',
      outPath,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let errText = '';
  proc.stderr.on('data', (d) => (errText += String(d)));
  const done = new Promise((res) => proc.on('close', (code) => res(code)));
  for (const idx of seq) {
    if (!proc.stdin.write(frames[idx].buf)) await new Promise((r) => proc.stdin.once('drain', r));
  }
  proc.stdin.end();
  const code = await done;
  const intervals = [];
  for (let i = 1; i < frames.length; i++) intervals.push((frames[i].ts - frames[i - 1].ts) * 1000);
  return {
    file: rel(outPath),
    exitCode: code,
    ffmpegError: errText.slice(-600) || null,
    bytes: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0,
    outFrames: n,
    outFps: VIDEO_FPS,
    capturedFrames: frames.length,
    capturedSpanSec: r3(frames[frames.length - 1].ts - t0),
    captureFps: r3(frames.length / Math.max(1e-3, frames[frames.length - 1].ts - t0)),
    uniqueFramesUsed: used.size,
    duplicatedOutFrames: n - used.size,
    droppedCapturedFrames: frames.filter((f) => f.ts - t0 <= durationSec).length - used.size,
    captureIntervalMs: { median: r3(median(intervals)), max: r3(intervals.length ? Math.max(...intervals) : null) },
  };
}

async function recordClip(cdp, name, durationSec, sampler = null) {
  const frames = [];
  const handler = (p) => {
    frames.push({ ts: p.metadata?.timestamp ?? Date.now() / 1000, buf: Buffer.from(p.data, 'base64') });
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  };
  await cdp.send('Page.bringToFront');
  cdp.on('Page.screencastFrame', handler);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < durationSec * 1000 + 250) {
    if (sampler) {
      try {
        samples.push({ tMs: Date.now() - t0, ...(await sampler()) });
      } catch (e) {
        samples.push({ tMs: Date.now() - t0, error: String(e).slice(0, 200) });
      }
    }
    await delay(sampler ? 400 : 200);
  }
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', handler);
  await delay(150);
  const outPath = path.join(VIDEO_DIR, `${LABEL}_${name}.webm`);
  const enc = await encodeFrames(frames, durationSec, outPath);
  log(
    `  [video] ${LABEL}_${name}.webm captured=${enc.capturedFrames} (${enc.captureFps} fps) → ${enc.outFrames} @${VIDEO_FPS} fps, dup=${enc.duplicatedOutFrames}, ${enc.bytes} B ${enc.error ?? enc.ffmpegError ?? ''}`,
  );
  return { name, ...enc, samples };
}

// ---------------------------------------------------------------------------------------------
// shared room setup
// ---------------------------------------------------------------------------------------------
async function setupPair(tag, gameMode = 'tdm', overrides = {}) {
  const roomName = `Q8B_${tag}_${LABEL.slice(0, 6)}_${Date.now().toString().slice(-4)}`; // room-name input is length-limited
  const A = await openClient('A');
  const B = await openClient('B');
  await Promise.all([enterLobby(A, 'QA_Alpha'), enterLobby(B, 'QA_Bravo')]);
  await createRoom(A, roomName, gameMode, overrides);
  await joinRoomByName(B, roomName);
  await Promise.all([prepClient(A), prepClient(B)]);
  const idA = await idByName(B, 'QA_Alpha');
  const idB = await idByName(A, 'QA_Bravo');
  return { A, B, roomName, idA, idB };
}
async function setupSingle(tag) {
  const roomName = `Q8B_${tag}_${LABEL.slice(0, 6)}_${Date.now().toString().slice(-4)}`; // room-name input is length-limited
  const A = await openClient('A');
  await enterLobby(A, 'QA_Alpha');
  await createRoom(A, roomName, 'tdm');
  await prepClient(A);
  return { A, roomName };
}
async function joinB(roomName) {
  const B = await openClient('B');
  await enterLobby(B, 'QA_Bravo');
  await joinRoomByName(B, roomName);
  await prepClient(B);
  return B;
}

// ---------------------------------------------------------------------------------------------
// PHASE: shots
// ---------------------------------------------------------------------------------------------
async function phaseShots() {
  const out = { shots: [], notes: [] };
  const { A, roomName } = await setupSingle('shots');
  out.roomName = roomName;
  out.gpu = await gpuInfo(A);
  out.world = await worldInfo(A);
  out.charHook = await hasCharHook(A);
  if (!out.charHook) out.notes.push('getCharacterDiagnostics() hook absent on this build → all character diag fields recorded as null.');
  await A.eval(
    `(() => { window.__SET_RAF_CAP_FPS__?.(60); document.body.classList.add('qa-clean'); const T = window.__DEV_GAME_TOOLS__; T.setThirdPerson(true); T.setWeapon('rifle'); })()`,
  );

  // --- remote view from client B (A idle at its server-authoritative spawn) ---
  const B = await joinB(roomName);
  const idA = await idByName(B, 'QA_Alpha');
  await B.eval(`(() => { window.__SET_RAF_CAP_FPS__?.(60); document.body.classList.add('qa-clean', 'qa-nocross'); })()`);
  await A.eval(`window.__SET_RAF_CAP_FPS__?.(20)`);
  await delay(1500);
  const aPos = await authPos(A);
  const aYaw = (await transform(A)).yaw;
  const f = fwdOf(aYaw);
  const r = rightOf(aYaw);
  const chest = { x: aPos.x, y: aPos.y + 1.0, z: aPos.z };
  const remoteViews = [
    { name: 'remote_front', eye: { x: aPos.x + f.x * 3.2, y: aPos.y + 1.35, z: aPos.z + f.z * 3.2 } },
    { name: 'remote_side', eye: { x: aPos.x + r.x * 3.2, y: aPos.y + 1.35, z: aPos.z + r.z * 3.2 } },
    { name: 'remote_far', eye: { x: aPos.x + f.x * 7 + r.x * 3, y: aPos.y + 2.2, z: aPos.z + f.z * 7 + r.z * 3 } },
  ];
  for (const v of remoteViews) {
    await B.eval(`window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(lookAtCamera(v.eye, chest))}`);
    await delay(1200);
    const info = await B.screenshot(v.name);
    out.shots.push({
      ...info,
      kind: 'remote',
      view: v.name,
      remoteId: idA,
      remoteDiag: await remoteDiag(B, idA),
      remoteSeenByB: (await otherPlayers(B))?.find((p) => p.id === idA) ?? null,
    });
  }
  out.notes.push(
    `remote shots: client B camera override framing client A at its server position (${r3(aPos.x)}, ${r3(aPos.z)}) — spawn position varies per run.`,
  );
  await closeClient(B);

  // --- local character (client A offline-local so it can be teleported to the deterministic lane) ---
  const lane = await getLane();
  out.lane = lane;
  await goOfflineLocal(A);
  await A.eval(`window.__SET_RAF_CAP_FPS__?.(60)`);
  const S = lane.start;
  const yaw = lane.yaw;
  const place = async (weapon, tp = true) => {
    await A.eval(
      `(() => { const T = window.__DEV_GAME_TOOLS__; T.setSyntheticInput(null); window.__DEV_CAMERA_OVERRIDE__ = null; T.setThirdPerson(${tp}); T.setWeapon(${JSON.stringify(weapon)}); T.setPlayerPos(${S.x}, ${S.z}, ${yaw}, undefined, 0); })()`,
    );
  };

  // 3P idle (default camera)
  await place('rifle');
  await delay(1800);
  out.shots.push({ ...(await A.screenshot('3p_idle')), kind: '3p_idle', weapon: 'rifle', diag: slimLocal(await charDiag(A)), transform: await transform(A) });

  // 3P running (synthetic run along lane)
  await place('rifle');
  await delay(300);
  await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 1, right: 0, jump: false, walk: false, yaw: ${yaw}, pitch: -0.05 })`);
  await delay(1000);
  const tr0 = await transform(A);
  const tt0 = Date.now();
  await delay(400);
  const runShot = await A.screenshot('3p_run');
  const tr1 = await transform(A);
  const runSpeed = Math.hypot(tr1.x - tr0.x, tr1.z - tr0.z) / ((Date.now() - tt0) / 1000);
  out.shots.push({ ...runShot, kind: '3p_run', weapon: 'rifle', measuredSpeedMps: r3(runSpeed), diag: slimLocal(await charDiag(A)) });
  await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);

  // 3P jumping (standing jump, captured near apex)
  await place('rifle');
  await delay(900);
  const y0 = (await transform(A)).y;
  await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 0, right: 0, jump: true, walk: false, yaw: ${yaw}, pitch: -0.05 })`);
  let apexY = y0;
  const tj = Date.now();
  let prevY = y0;
  while (Date.now() - tj < 2000) {
    const t = await transform(A);
    if (t.y > apexY) apexY = t.y;
    if (!t.onGround && t.y > y0 + 0.4 && t.y <= prevY) break; // started descending near apex
    prevY = t.y;
    await delay(16);
  }
  await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 0, right: 0, jump: false, walk: false, yaw: ${yaw}, pitch: -0.05 })`);
  const jumpDiag = slimLocal(await charDiag(A));
  const jt = await transform(A);
  const jumpShot = await A.screenshot('3p_jump');
  out.shots.push({
    ...jumpShot,
    kind: '3p_jump',
    weapon: 'rifle',
    heightAboveGroundAtDiag: r3(jt.y - y0),
    onGroundAtDiag: jt.onGround,
    apexY: r3(apexY - y0),
    diag: jumpDiag,
    note: 'screenshot taken right after diag sample (~150 ms later); airtime ~0.7 s',
  });
  await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
  await delay(800);

  // 3P jumping seen from a FIXED side camera (shows the airborne pose + height above ground)
  await place('rifle');
  {
    const rtj = rightOf(yaw);
    const eyeJ = { x: S.x + rtj.x * 3.6, y: S.y + 1.3, z: S.z + rtj.z * 3.6 };
    await A.eval(
      `(() => { window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(lookAtCamera(eyeJ, { x: S.x, y: S.y + 1.4, z: S.z }))}; document.body.classList.add('qa-nocross'); })()`,
    );
  }
  await delay(1000);
  await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 0, right: 0, jump: true, walk: false, yaw: ${yaw}, pitch: -0.05 })`);
  {
    const tj2 = Date.now();
    let py = y0;
    while (Date.now() - tj2 < 2000) {
      const t = await transform(A);
      if (!t.onGround && t.y > y0 + 0.4 && t.y <= py) break;
      py = t.y;
      await delay(16);
    }
  }
  await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 0, right: 0, jump: false, walk: false, yaw: ${yaw}, pitch: -0.05 })`);
  const jsDiag = slimLocal(await charDiag(A));
  const jsT = await transform(A);
  out.shots.push({
    ...(await A.screenshot('3p_jump_sidecam')),
    kind: '3p_jump_sidecam',
    weapon: 'rifle',
    heightAboveGroundAtDiag: r3(jsT.y - y0),
    onGroundAtDiag: jsT.onGround,
    diag: jsDiag,
  });
  await A.eval(
    `(() => { window.__DEV_GAME_TOOLS__.setSyntheticInput(null); window.__DEV_CAMERA_OVERRIDE__ = null; document.body.classList.remove('qa-nocross'); })()`,
  );
  await delay(800);

  // 1P view per weapon
  for (const w of WEAPONS) {
    await place(w, false);
    await delay(1300);
    out.shots.push({
      ...(await A.screenshot(`1p_${w}`)),
      kind: '1p',
      weapon: w,
      camera: await A.eval(`window.__DEV_GAME_TOOLS__.getCameraState()`),
      diag: slimLocal(await charDiag(A)),
    });
  }

  // close-ups front/side/back @ 2.2 m, camera height 1.0 m, per weapon (+ unarmed)
  const fw = fwdOf(yaw);
  const rt = rightOf(yaw);
  const tgt = { x: S.x, y: S.y + 1.0, z: S.z };
  const views = {
    front: { x: S.x + fw.x * 2.2, y: S.y + 1.0, z: S.z + fw.z * 2.2 },
    side: { x: S.x + rt.x * 2.2, y: S.y + 1.0, z: S.z + rt.z * 2.2 },
    back: { x: S.x - fw.x * 2.2, y: S.y + 1.0, z: S.z - fw.z * 2.2 },
  };
  await A.eval(`document.body.classList.add('qa-nocross')`);
  for (const w of [null, ...WEAPONS]) {
    await place(w, true);
    await delay(1400);
    for (const [vn, eye] of Object.entries(views)) {
      const cam = lookAtCamera(eye, tgt);
      cam.pitch = 0; // camera at 1.0 m looking level at 1.0 m
      await A.eval(`window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam)}`);
      await delay(700);
      out.shots.push({
        ...(await A.screenshot(`closeup_${w ?? 'unarmed'}_${vn}`)),
        kind: 'closeup',
        weapon: w,
        view: vn,
        cam,
        diag: slimLocal(await charDiag(A)),
      });
    }
  }
  await A.eval(`(() => { window.__DEV_CAMERA_OVERRIDE__ = null; })()`);
  out.errors = A.errorsSummary();
  await closeClient(A);
  return out;
}

// ---------------------------------------------------------------------------------------------
// PHASE: video
// ---------------------------------------------------------------------------------------------
async function phaseVideo() {
  const out = { ffmpeg: FFMPEG, clips: [], notes: [] };
  if (!FFMPEG) out.notes.push('ffmpeg not found — frames captured but not encoded');
  const { A, roomName } = await setupSingle('video');
  out.roomName = roomName;
  out.charHook = await hasCharHook(A);
  await A.eval(
    `(() => { document.body.classList.add('qa-clean', 'qa-nocross'); const T = window.__DEV_GAME_TOOLS__; T.setThirdPerson(true); T.setWeapon('pistol'); window.__SET_RAF_CAP_FPS__?.(30); })()`,
  );

  // --- remote_run: B watches A run (server-authoritative, A drives a helper-planned clear route) ---
  const B = await joinB(roomName);
  const idA = await idByName(B, 'QA_Alpha');
  await B.eval(`(() => { document.body.classList.add('qa-clean', 'qa-nocross'); window.__SET_RAF_CAP_FPS__?.(60); })()`);
  await delay(1200);
  const from = await authPos(A);
  const route = await procs.helper.call('runRoute', { from: { x: from.x, z: from.z }, length: 6.5 * (CLIP_SEC + 2.5), maxSegments: 6 });
  out.remoteRoute = route;
  await B.eval(`(() => {
    const T = window.__DEV_GAME_TOOLS__;
    if (window.__QA_FOLLOW__) clearInterval(window.__QA_FOLLOW__);
    let dir = null; let prev = null;
    window.__QA_FOLLOW__ = setInterval(() => {
      const o = (T.getOtherPlayers?.() ?? []).find((p) => p.id === ${JSON.stringify(idA)}); if (!o) return;
      const p = o.pos;
      if (prev) { const vx = p.x - prev.x, vz = p.z - prev.z, l = Math.hypot(vx, vz); if (l > 0.01) { const nx = vx / l, nz = vz / l; dir = dir ? { x: dir.x * 0.85 + nx * 0.15, z: dir.z * 0.85 + nz * 0.15 } : { x: nx, z: nz }; } }
      prev = { x: p.x, z: p.z };
      const d = dir ? (() => { const l = Math.hypot(dir.x, dir.z) || 1; return { x: dir.x / l, z: dir.z / l }; })() : { x: 0, z: -1 };
      const side = { x: -d.z, z: d.x };
      const eye = { x: p.x + side.x * 5.0 - d.x * 1.5, y: p.y + 1.5, z: p.z + side.z * 5.0 - d.z * 1.5 };
      const t = { x: p.x, y: p.y + 0.95, z: p.z };
      const dx = t.x - eye.x, dy = t.y - eye.y, dz = t.z - eye.z;
      window.__DEV_CAMERA_OVERRIDE__ = { x: eye.x, y: eye.y, z: eye.z, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
    }, 8);
  })()`);
  await startDriver(A, route.waypoints, { walk: false });
  await delay(1200);
  const remoteSampler = async () => {
    const [o, d] = await Promise.all([otherPlayers(B), remoteDiag(B, idA)]);
    const snapV = await B.eval(
      `(() => { const p = window.__LAST_SNAP__?.players?.find((q) => q.id === ${JSON.stringify(idA)}); return p ? Math.hypot(p.vx, p.vz) : null; })()`,
    );
    return { remotePos: o?.find((p) => p.id === idA)?.pos ?? null, snapSpeed: r3(snapV), state: d?.state ?? null, timeScale: r3(d?.timeScale) };
  };
  const remoteClip = await recordClip(B, 'remote_run', CLIP_SEC, remoteSampler);
  remoteClip.driver = await driverState(A);
  await stopDriver(A);
  await B.eval(`(() => { if (window.__QA_FOLLOW__) clearInterval(window.__QA_FOLLOW__); window.__DEV_CAMERA_OVERRIDE__ = null; })()`);
  remoteClip.stateMode = mode(remoteClip.samples.map((s) => s.state));
  remoteClip.snapSpeedMedian = r3(median(remoteClip.samples.map((s) => s.snapSpeed).filter((v) => typeof v === 'number')));
  out.clips.push(remoteClip);
  out.errorsB = B.errorsSummary();
  await closeClient(B);

  // --- local clips (A offline-local, deterministic lane) ---
  const lane = await getLane();
  out.lane = lane;
  await goOfflineLocal(A);
  await A.eval(`window.__SET_RAF_CAP_FPS__?.(60)`);
  const S = lane.start;
  const yaw = lane.yaw;
  const fw = fwdOf(yaw);
  const rt = rightOf(yaw);
  for (const gait of ['walk', 'run']) {
    for (const cam of ['3p', 'side']) {
      await A.eval(
        `(() => { const T = window.__DEV_GAME_TOOLS__; if (window.__QA_SIDECAM__) { clearInterval(window.__QA_SIDECAM__); window.__QA_SIDECAM__ = null; } T.setSyntheticInput(null); window.__DEV_CAMERA_OVERRIDE__ = null; T.setThirdPerson(true); T.setWeapon('pistol'); T.setPlayerPos(${S.x}, ${S.z}, ${yaw}, undefined, 0); })()`,
      );
      await delay(900);
      if (cam === 'side') {
        const side = lane.side ?? 1;
        await A.eval(`(() => {
          const T = window.__DEV_GAME_TOOLS__;
          const loop = () => {
            const p = T.getPlayerTransform();
            const eye = { x: p.x + ${rt.x * 4.2} * ${side} + ${fw.x * 0.6}, y: p.y + 1.15, z: p.z + ${rt.z * 4.2} * ${side} + ${fw.z * 0.6} };
            const dx = p.x - eye.x, dy = p.y + 0.95 - eye.y, dz = p.z - eye.z;
            window.__DEV_CAMERA_OVERRIDE__ = { x: eye.x, y: eye.y, z: eye.z, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
          };
          loop();
          window.__QA_SIDECAM__ = setInterval(loop, 4);
        })()`);
      }
      await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 1, right: 0, jump: false, walk: ${gait === 'walk'}, yaw: ${yaw}, pitch: -0.05 })`);
      await delay(700);
      const startT = await transform(A);
      const startMs = Date.now();
      const clip = await recordClip(A, `${gait}_${cam}`, CLIP_SEC, async () => {
        const d = await charDiag(A);
        const t = await transform(A);
        return { pos: { x: r3(t.x), y: r3(t.y), z: r3(t.z) }, onGround: t.onGround, state: d?.local?.state ?? null, timeScale: r3(d?.local?.timeScale) };
      });
      const ps = clip.samples.filter((q) => q.pos);
      clip.measuredSpeedMps =
        ps.length > 1
          ? r3(Math.hypot(ps[ps.length - 1].pos.x - ps[0].pos.x, ps[ps.length - 1].pos.z - ps[0].pos.z) / ((ps[ps.length - 1].tMs - ps[0].tMs) / 1000))
          : null;
      clip.startPos = { x: r3(startT.x), z: r3(startT.z) };
      void startMs;
      clip.expectedSpeedMps = gait === 'walk' ? 3.0 : 6.5;
      clip.stateMode = mode(clip.samples.map((s) => s.state));
      clip.weapon = 'pistol';
      out.clips.push(clip);
      await A.eval(
        `(() => { if (window.__QA_SIDECAM__) { clearInterval(window.__QA_SIDECAM__); window.__QA_SIDECAM__ = null; } window.__DEV_GAME_TOOLS__.setSyntheticInput(null); window.__DEV_CAMERA_OVERRIDE__ = null; })()`,
      );
    }
  }
  out.notes.push(
    'Local clips use pistol (speedMul 1.0 → 3.0/6.5 m/s); client A runs offline-local (DEV netSim dropRate=1) on the helper lane so placement is identical BEFORE/AFTER. remote_run is server-authoritative (A in a separate pre-offline window, route from its spawn) and its framing depends on the spawn.',
  );
  out.errorsA = A.errorsSummary();
  await closeClient(A);
  return out;
}

// ---------------------------------------------------------------------------------------------
// PHASE: multi
// ---------------------------------------------------------------------------------------------
function check(list, id, status, details = {}, note = undefined) {
  const c = { id, status, ...(note ? { note } : {}), details };
  list.push(c);
  log(`  [check] ${id.padEnd(34)} ${status}${note ? `  — ${note}` : ''}`);
  return c;
}

async function worldChecks(checks, prefix, A, B, idA, idB) {
  const [wa, wb, oa, ob] = await Promise.all([worldInfo(A), worldInfo(B), otherPlayers(A), otherPlayers(B)]);
  const see = Boolean(oa?.some((p) => p.id === idB) && ob?.some((p) => p.id === idA));
  check(checks, `${prefix}.seeEachOther`, see ? 'PASS' : 'FAIL', { aSees: oa, bSees: ob });
  const hashOk = wa.gameplayHash === EXPECTED_HASH && wb.gameplayHash === EXPECTED_HASH;
  const verOk = wa.worldVersion === EXPECTED_WORLD_VERSION && wb.worldVersion === EXPECTED_WORLD_VERSION;
  check(checks, `${prefix}.gameplayHash`, hashOk ? 'PASS' : 'FAIL', { a: wa.gameplayHash, b: wb.gameplayHash, expected: EXPECTED_HASH });
  check(checks, `${prefix}.worldVersion`, verOk ? 'PASS' : 'FAIL', { a: wa.worldVersion, b: wb.worldVersion, expected: EXPECTED_WORLD_VERSION });
  check(checks, `${prefix}.sameRoomId`, wa.roomId && wa.roomId === wb.roomId ? 'PASS' : 'FAIL', { a: wa.roomId, b: wb.roomId });
  const [da, db] = await Promise.all([charDiag(A), charDiag(B)]);
  if (!da || !db) check(checks, `${prefix}.characterModels`, 'SKIP', { a: da, b: db }, 'getCharacterDiagnostics() hook absent');
  else {
    const remoteOnB = db.remotes?.find((r) => r.id === idA);
    const remoteOnA = da.remotes?.find((r) => r.id === idB);
    const ok =
      da.asset?.state === 'ready' &&
      db.asset?.state === 'ready' &&
      da.local?.mode === 'buddy' &&
      db.local?.mode === 'buddy' &&
      remoteOnB?.mode === 'buddy' &&
      remoteOnA?.mode === 'buddy';
    check(checks, `${prefix}.characterModels`, ok ? 'PASS' : 'FAIL', {
      a: { asset: slimLocal(da).asset, local: da.local?.mode, remote: remoteOnA?.mode },
      b: { asset: slimLocal(db).asset, local: db.local?.mode, remote: remoteOnB?.mode },
    });
  }
  return { a: wa, b: wb };
}

async function sampleRemoteStates(B, idA, ms, every = 100) {
  const states = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const [d, s] = await Promise.all([
      remoteDiag(B, idA),
      B.eval(
        `(() => { const p = window.__LAST_SNAP__?.players?.find((q) => q.id === ${JSON.stringify(idA)}); return p ? { v: Math.hypot(p.vx, p.vz), y: p.y, onGround: p.onGround } : null; })()`,
      ),
    ]);
    states.push({
      tMs: Date.now() - t0,
      state: d?.state ?? null,
      timeScale: r3(d?.timeScale),
      weapon: d?.weapon ?? null,
      snapSpeed: r3(s?.v),
      snapOnGround: s?.onGround ?? null,
    });
    await delay(every);
  }
  return states;
}

async function phaseMulti() {
  const out = { checks: [], notes: [] };
  const checks = out.checks;

  const parts = new Set(String(args.multiParts ?? 'tdm,ffa,survival').split(','));
  out.parts = [...parts];
  let A, B, roomName, idA, idB;
  // ======================= TDM =======================
  if (parts.has('tdm')) {
    log('multi: TDM pair');
    ({ A, B, roomName, idA, idB } = await setupPair('tdm', 'tdm'));
    out.tdm = { roomName, idA, idB };
    await Promise.all([A.eval(`window.__SET_RAF_CAP_FPS__?.(30)`), B.eval(`window.__SET_RAF_CAP_FPS__?.(30)`)]);
    out.charHook = await hasCharHook(A);
    if (!out.charHook)
      out.notes.push('getCharacterDiagnostics() hook absent → character-state checks are SKIP (not PASS); weapon sync still checked via getOtherPlayers().');
    await delay(1500);
    out.tdm.world = await worldChecks(checks, 'tdm', A, B, idA, idB);

    // weapon equip consistency (A equips via DEV setWeapon → input cmd weapon → server snapshot → B)
    const weaponRows = [];
    const curW = (await otherPlayers(B))?.find((p) => p.id === idA)?.weapon ?? null;
    const weaponOrder = [...WEAPONS.filter((w) => w !== curW), ...WEAPONS.filter((w) => w === curW)]; // first equip always changes
    for (const w of weaponOrder) {
      await A.eval(`window.__DEV_GAME_TOOLS__.setWeapon(${JSON.stringify(w)})`);
      let seen = null;
      let diagW = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        seen = (await otherPlayers(B))?.find((p) => p.id === idA)?.weapon ?? null;
        const d = await remoteDiag(B, idA);
        diagW = d && !d.missing ? (d.weapon ?? null) : null;
        if (seen === w && (!out.charHook || diagW === w)) break;
        await delay(150);
      }
      weaponRows.push({ weapon: w, bSeesWeapon: seen, bModelWeapon: out.charHook ? diagW : null, ms: Date.now() - t0 });
    }
    const weaponOk = weaponRows.every((r) => r.bSeesWeapon === r.weapon && (!out.charHook || r.bModelWeapon === r.weapon));
    check(checks, 'tdm.weaponEquipSync', weaponOk ? 'PASS' : 'FAIL', { rows: weaponRows });
    await A.eval(`window.__DEV_GAME_TOOLS__.setWeapon('pistol')`);

    // remote animation states on B while A idles / walks / runs / jumps (server-authoritative movement;
    // every gait gets a fresh helper-planned clear route from A's current server position)
    const animWindow = async (walkGait, ms) => {
      const attempts = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const from = await authPos(A);
        const speed = walkGait ? 3.0 : 6.5;
        const route = await procs.helper.call('runRoute', { from: { x: from.x, z: from.z }, length: speed * (ms / 1000 + 1.6) + 6, maxSegments: 6, walk: walkGait });
        await startDriver(A, route.waypoints, { walk: walkGait });
        await delay(900);
        const samples = await sampleRemoteStates(B, idA, ms);
        const drv = await driverState(A);
        const end = await authPos(A);
        const pred = await A.eval(
          `(() => { const d = window.__DEV_GAME_TOOLS__.getPredictionDiagnostics(); return { divergenceM: d.divergenceM, predictedPos: d.predictedPos, authoritativePos: d.authoritativePos, pendingInputs: d.pendingInputs, reconcileCount: d.reconcileCount }; })()`,
        );
        await stopDriver(A);
        await delay(900);
        const med = median(samples.map((q) => q.snapSpeed).filter((v) => v != null)) ?? 0;
        attempts.push({ attempt, samples, meta: { route, driverAtEnd: drv, from: { x: r3(from.x), z: r3(from.z) }, end: { x: r3(end.x), z: r3(end.z) }, predictionAtEnd: pred, snapSpeedMedian: r3(med) } });
        if (Math.abs(med - speed) < 0.5) break; // movement window valid; otherwise re-plan once (blocked route / stall) and record both
      }
      const last = attempts[attempts.length - 1];
      return { samples: last.samples, meta: { attempts: attempts.map((a) => ({ attempt: a.attempt, ...a.meta, ...(a === last ? {} : { samples: a.samples }) })) } };
    };
    const idle = await sampleRemoteStates(B, idA, 1500);
    const walkW = await animWindow(true, 2000);
    const runW = await animWindow(false, 2000);
    const walk = walkW.samples;
    const run = runW.samples;
    out.tdm.animRoutes = { walk: walkW.meta, run: runW.meta };
    await delay(600);
    await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 0, right: 0, jump: true, walk: false, pitch: -0.05 })`);
    await delay(120);
    await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 0, right: 0, jump: false, walk: false, pitch: -0.05 })`);
    const jump = await sampleRemoteStates(B, idA, 1800, 50);
    await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
    const anim = { idle, walk, run, jump };
    out.tdm.remoteAnim = anim;
    const summary = {
      idle: { mode: mode(idle.map((s) => s.state)), snapSpeedMedian: r3(median(idle.map((s) => s.snapSpeed).filter((v) => v != null))) },
      walk: {
        mode: mode(walk.map((s) => s.state)),
        snapSpeedMedian: r3(median(walk.map((s) => s.snapSpeed).filter((v) => v != null))),
        timeScaleMedian: r3(median(walk.map((s) => s.timeScale).filter((v) => v != null))),
      },
      run: {
        mode: mode(run.map((s) => s.state)),
        snapSpeedMedian: r3(median(run.map((s) => s.snapSpeed).filter((v) => v != null))),
        timeScaleMedian: r3(median(run.map((s) => s.timeScale).filter((v) => v != null))),
      },
      jump: { states: [...new Set(jump.map((s) => s.state))], airborneSamples: jump.filter((s) => s.snapOnGround === false).length },
    };
    out.tdm.remoteAnimSummary = summary;
    if (!out.charHook) {
      check(checks, 'tdm.remoteAnim.Idle', 'SKIP', summary.idle, 'hook absent');
      check(checks, 'tdm.remoteAnim.Walk', 'SKIP', summary.walk, 'hook absent');
      check(checks, 'tdm.remoteAnim.Run', 'SKIP', summary.run, 'hook absent');
      check(checks, 'tdm.remoteAnim.JumpAir', 'SKIP', summary.jump, 'hook absent');
    } else {
      check(checks, 'tdm.remoteAnim.Idle', summary.idle.mode === 'Idle' ? 'PASS' : 'FAIL', summary.idle);
      check(checks, 'tdm.remoteAnim.Walk', summary.walk.mode === 'Walk' ? 'PASS' : 'FAIL', summary.walk);
      check(checks, 'tdm.remoteAnim.Run', summary.run.mode === 'Run' ? 'PASS' : 'FAIL', summary.run);
      check(
        checks,
        'tdm.remoteAnim.JumpAir',
        summary.jump.states.includes('JumpAir') ? 'PASS' : summary.jump.airborneSamples === 0 ? 'FAIL' : 'FAIL',
        summary.jump,
        summary.jump.airborneSamples === 0 ? 'A never became airborne in snapshots' : undefined,
      );
    }
    check(checks, 'tdm.remoteSpeed.walk≈3.0', Math.abs((summary.walk.snapSpeedMedian ?? 0) - 3.0) < 0.5 ? 'PASS' : 'FAIL', {
      snapSpeedMedian: summary.walk.snapSpeedMedian,
      weapon: 'pistol',
    });
    check(checks, 'tdm.remoteSpeed.run≈6.5', Math.abs((summary.run.snapSpeedMedian ?? 0) - 6.5) < 0.7 ? 'PASS' : 'FAIL', {
      snapSpeedMedian: summary.run.snapSpeedMedian,
      weapon: 'pistol',
    });

    // rejoin x N (B disconnects + reconnects; A is the leak observer)
    const rejoin = { iterations: [] };
    const aDiag0 = slimLocal(await charDiag(A));
    rejoin.baseline = {
      heap: await heapAfterGc(A),
      asset: aDiag0?.asset ?? null,
      programs: await A.eval(`window.__GET_WEBGL_PROGRAMS_COUNT__?.() ?? null`),
      render: await A.eval(`window.__DEV_GAME_TOOLS__.getRenderStats()`),
    };
    for (let i = 1; i <= REJOINS; i++) {
      // clean client-side close first (an abrupt page unload through the Vite ws proxy sometimes leaves the
      // server waiting for the engine.io ping timeout), then unload the page
      await B.eval(`(() => { for (const ws of window.__QA_WS__ || []) { try { ws.close(1000); } catch {} } })()`).catch(() => {});
      const tLeave = Date.now();
      await B.send('Page.navigate', { url: 'about:blank' });
      let leftOk = true;
      try {
        await A.waitFor(`(window.__DEV_GAME_TOOLS__.getOtherPlayers?.() ?? []).length === 0`, 30000);
      } catch {
        leftOk = false;
      }
      const leaveDetectMs = Date.now() - tLeave;
      await delay(500);
      const afterLeave = {
        heap: await heapAfterGc(A),
        asset: slimLocal(await charDiag(A))?.asset ?? null,
        others: (await otherPlayers(A))?.length ?? null,
        programs: await A.eval(`window.__GET_WEBGL_PROGRAMS_COUNT__?.() ?? null`),
        geometries: (await A.eval(`window.__DEV_GAME_TOOLS__.getRenderStats()`))?.geometries ?? null,
      };
      await renavigate(B);
      await enterLobby(B, 'QA_Bravo');
      await joinRoomByName(B, roomName);
      await prepClient(B);
      await B.eval(`window.__SET_RAF_CAP_FPS__?.(30)`);
      idB = await idByName(A, 'QA_Bravo');
      await delay(800);
      const afterJoin = {
        asset: slimLocal(await charDiag(A))?.asset ?? null,
        others: (await otherPlayers(A))?.length ?? null,
        bSeesA: Boolean((await otherPlayers(B))?.some((p) => p.name === 'QA_Alpha')),
        bAsset: slimLocal(await charDiag(B))?.asset ?? null,
      };
      rejoin.iterations.push({ i, leftOk, leaveDetectMs, afterLeave, afterJoin, newIdB: idB });
      log(
        `  [rejoin ${i}] left=${leftOk} heapA=${afterLeave.heap?.usedMB}MB liveInstances(afterLeave)=${afterLeave.asset?.liveInstances ?? 'n/a'} (afterJoin)=${afterJoin.asset?.liveInstances ?? 'n/a'} programs=${afterLeave.programs} geoms=${afterLeave.geometries}`,
      );
    }
    idA = await idByName(B, 'QA_Alpha');
    const its = rejoin.iterations;
    const heapGrowth = its.length ? r3(its[its.length - 1].afterLeave.heap.usedMB - its[0].afterLeave.heap.usedMB) : null;
    rejoin.heapGrowthMB_firstToLastLeave = heapGrowth;
    rejoin.geometryGrowth_firstToLastLeave = its.length ? its[its.length - 1].afterLeave.geometries - its[0].afterLeave.geometries : null;
    rejoin.programGrowth_firstToLastLeave = its.length ? its[its.length - 1].afterLeave.programs - its[0].afterLeave.programs : null;
    const allRejoined = its.every((x) => x.leftOk && x.afterJoin.others === 1 && x.afterJoin.bSeesA);
    check(checks, 'tdm.rejoinX' + REJOINS + '.connectivity', allRejoined ? 'PASS' : 'FAIL', {
      iterations: its.map((x) => ({ i: x.i, leftOk: x.leftOk, othersAfterJoin: x.afterJoin.others, bSeesA: x.afterJoin.bSeesA })),
    });
    if (!out.charHook) check(checks, 'tdm.rejoin.liveInstancesStable', 'SKIP', {}, 'hook absent');
    else {
      const leaves = its.map((x) => x.afterLeave.asset?.liveInstances);
      const joins = its.map((x) => x.afterJoin.asset?.liveInstances);
      const stable = leaves.every((v) => v === leaves[0]) && joins.every((v) => v === joins[0]) && joins[0] === leaves[0] + 1;
      check(checks, 'tdm.rejoin.liveInstancesStable', stable ? 'PASS' : 'FAIL', {
        afterLeave: leaves,
        afterJoin: joins,
        baseline: rejoin.baseline.asset?.liveInstances,
      });
    }
    check(checks, 'tdm.rejoin.heapGrowth<15MB', heapGrowth !== null && heapGrowth < 15 ? 'PASS' : 'FAIL', {
      heapGrowthMB: heapGrowth,
      geometryGrowth: rejoin.geometryGrowth_firstToLastLeave,
      programGrowth: rejoin.programGrowth_firstToLastLeave,
    });
    out.tdm.rejoin = rejoin;
    out.tdm.errors = { A: A.errorsSummary(), B: B.errorsSummary() };
    check(checks, 'tdm.noPageExceptions', A.pageExceptions.length + B.pageExceptions.length === 0 ? 'PASS' : 'FAIL', {
      A: A.pageExceptions.slice(0, 5),
      B: B.pageExceptions.slice(0, 5),
    });
    await closeClient(A);
    await closeClient(B);
  }
  // ======================= FFA smoke =======================
  if (parts.has('ffa')) {
    log('multi: FFA pair');
    ({ A, B, roomName, idA, idB } = await setupPair('ffa', 'ffa'));
    await delay(1200);
    out.ffa = { roomName, idA, idB, world: await worldChecks(checks, 'ffa', A, B, idA, idB) };
    out.ffa.errors = { A: A.errorsSummary(), B: B.errorsSummary() };
    check(checks, 'ffa.noPageExceptions', A.pageExceptions.length + B.pageExceptions.length === 0 ? 'PASS' : 'FAIL', {
      A: A.pageExceptions.slice(0, 5),
      B: B.pageExceptions.slice(0, 5),
    });
    await closeClient(A);
    await closeClient(B);
  }
  // ======================= Forest Survival =======================
  if (parts.has('survival')) {
    log('multi: Forest Survival pair');
    ({ A, B, roomName, idA, idB } = await setupPair('surv', 'forest_survival', { countdownSec: 4 }));
    out.survival = { roomName, idA, idB };
    out.charHook = await hasCharHook(A);
    await Promise.all([A.eval(`window.__SET_RAF_CAP_FPS__?.(30)`), B.eval(`window.__SET_RAF_CAP_FPS__?.(30)`)]);
    try {
      await Promise.all([
        A.waitFor(`window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing'`, 40000),
        B.waitFor(`window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing'`, 40000),
      ]);
    } catch (e) {
      out.notes.push(`survival round did not reach 'playing': ${String(e).slice(0, 200)}`);
    }
    const roundId0 = await A.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().match?.roundId ?? null`);
    out.survival.roundIdStart = roundId0;
    out.survival.world = await worldChecks(checks, 'survival', A, B, idA, idB);

    // container → pickup → equip
    const loot = await A.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    const containers = (loot.lootSnapshot?.containers ?? [])
      .filter((c) => !c.opened)
      .map((c) => ({ id: c.id, position: c.position, interactionRadius: c.interactionRadius }));
    let lootFlow = { opened: null, picked: null, equipped: null, attempts: [] };
    out.survival.containerCandidates = [];
    const tried = new Set();
    for (let attempt = 0; attempt < 5 && !lootFlow.equipped; attempt++) {
      // re-plan from A's current server position every attempt (containers it already tried are excluded)
      const aNowL = await authPos(A);
      const appr = await procs.helper.call('containerApproach', { from: { x: aNowL.x, z: aNowL.z }, containers: containers.filter((c) => !tried.has(c.id)) });
      out.survival.containerCandidates.push(appr.candidates.map((c) => ({ id: c.id, pathLen: c.pathLen, approach: c.approach })));
      const cand = appr.candidates[0];
      if (!cand) break;
      tried.add(cand.id);
      const drive = await driveTo(A, cand.waypoints, { walk: false, timeoutMs: Math.max(25000, (cand.pathLen / 5) * 1000 + 10000), arriveR: 0.45 });
      await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 0, right: 0, jump: false, walk: false, yaw: ${cand.faceYaw}, pitch: -0.3 })`);
      await delay(300);
      const ack = await A.eval(`window.__DEV_GAME_TOOLS__.openContainerById(${JSON.stringify(cand.id)}, 'qa08b_open_' + Date.now())`);
      const bDuringOpen = await sampleRemoteStates(B, idA, 900, 150);
      const att = {
        id: cand.id,
        drive: { reached: drive.reached, ms: drive.ms, pos: drive.pos },
        openOk: Boolean(ack?.ok),
        openCode: ack?.code ?? null,
        items: (ack?.container?.items ?? []).map((it) => ({ id: it.id, kind: it.kind, catalogId: it.catalogId, weaponId: it.weaponId ?? null })),
        remoteStatesDuringOpen: [...new Set(bDuringOpen.map((s) => s.state))],
      };
      lootFlow.attempts.push(att);
      log(`  [loot] ${cand.id} reached=${drive.reached} open=${att.openOk} ${att.openCode ?? ''} items=${att.items.map((i) => i.kind).join(',')}`);
      if (!ack?.ok) continue;
      lootFlow.opened = cand.id;
      const item = ack.container.items.find((it) => it.kind === 'weapon') ?? ack.container.items[0];
      if (item) {
        const pick = await A.eval(
          `window.__DEV_GAME_TOOLS__.pickupLootItem(${JSON.stringify(cand.id)}, ${JSON.stringify(item.id)}, 'qa08b_pick_' + Date.now())`,
        );
        att.pickOk = Boolean(pick?.ok);
        att.pickCode = pick?.code ?? null;
        if (pick?.ok) lootFlow.picked = { container: cand.id, item: item.catalogId, kind: item.kind };
      }
      let inv = (await A.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`)).inventorySnap;
      if (!inv?.equippedWeapon && inv?.ownedWeapons?.length) {
        const eq = await A.eval(`window.__DEV_GAME_TOOLS__.equipInventoryWeapon(${JSON.stringify(inv.ownedWeapons[0])}, 'qa08b_equip_' + Date.now())`);
        att.equipOk = Boolean(eq?.ok);
        await delay(600);
        inv = (await A.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`)).inventorySnap;
      }
      if (inv?.equippedWeapon) {
        lootFlow.equipped = inv.equippedWeapon;
        break;
      }
    }
    if (lootFlow.equipped) {
      let seen = null;
      let diagW = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        seen = (await otherPlayers(B))?.find((p) => p.id === idA)?.weapon ?? null;
        const d = await remoteDiag(B, idA);
        diagW = d && !d.missing ? (d.weapon ?? null) : null;
        if (seen === lootFlow.equipped && (!out.charHook || diagW === lootFlow.equipped)) break;
        await delay(150);
      }
      lootFlow.bSeesWeapon = seen;
      lootFlow.bModelWeapon = out.charHook ? diagW : null;
      lootFlow.aLocalModelWeapon = slimLocal(await charDiag(A))?.weapon ?? null;
    }
    out.survival.lootFlow = lootFlow;
    check(checks, 'survival.openContainer', lootFlow.opened ? 'PASS' : 'FAIL', {
      attempts: lootFlow.attempts.map((a) => ({ id: a.id, reached: a.drive.reached, openOk: a.openOk, code: a.openCode })),
    });
    check(checks, 'survival.pickupItem', lootFlow.picked ? 'PASS' : 'FAIL', lootFlow.picked ?? {});
    check(
      checks,
      'survival.equipWeapon',
      lootFlow.equipped ? 'PASS' : 'FAIL',
      { equipped: lootFlow.equipped },
      lootFlow.opened && !lootFlow.equipped ? 'opened containers held no weapon' : undefined,
    );
    if (lootFlow.equipped) {
      const ok = lootFlow.bSeesWeapon === lootFlow.equipped && (!out.charHook || lootFlow.bModelWeapon === lootFlow.equipped);
      check(checks, 'survival.remoteSeesLootedWeapon', ok ? 'PASS' : 'FAIL', {
        bSees: lootFlow.bSeesWeapon,
        bModel: lootFlow.bModelWeapon,
        equipped: lootFlow.equipped,
      });
    }
    if (out.charHook) {
      const seenInteract = lootFlow.attempts.some((a) => a.openOk && a.remoteStatesDuringOpen.includes('Interact'));
      check(
        checks,
        'survival.remoteInteractAnim(info)',
        seenInteract ? 'PASS' : 'INFO',
        { statesDuringOpen: lootFlow.attempts.map((a) => a.remoteStatesDuringOpen) },
        seenInteract ? undefined : 'Interact not observed on the REMOTE model (may be local-only by design) — informational',
      );
    }

    // spectator: B walks to A, A shoots B (needs looted weapon + LOS), B cycles spectator target
    const spect = { attempted: false };
    if (lootFlow.equipped) {
      spect.attempted = true;
      const aNow = await authPos(A);
      const bNow = await authPos(B);
      const yawAB = Math.atan2(-(bNow.x - aNow.x), -(bNow.z - aNow.z));
      const goal = { x: aNow.x - Math.sin(yawAB) * 4, z: aNow.z - Math.cos(yawAB) * 4 };
      const np = await procs.helper.call('navPath', { from: { x: bNow.x, z: bNow.z }, to: goal });
      spect.bPathLen = np.len;
      const bDrive = np.ok
        ? await driveTo(B, np.waypoints, { walk: false, timeoutMs: Math.max(30000, (np.len / 5) * 1000 + 15000), arriveR: 1.0 })
        : { reached: false };
      spect.bReached = bDrive.reached;
      let eliminated = false;
      let shots = 0;
      for (let s = 0; s < 40 && !eliminated; s++) {
        const [ap, bp] = await Promise.all([authPos(A), authPos(B)]);
        const aim = lookAtCamera({ x: ap.x, y: ap.y + 1.62, z: ap.z }, { x: bp.x, y: bp.y + 1.05, z: bp.z });
        await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 0, right: 0, jump: false, walk: false, yaw: ${aim.yaw}, pitch: ${aim.pitch} })`);
        await delay(90);
        let fired = false;
        const tf = Date.now();
        while (Date.now() - tf < 1500 && !fired) {
          fired = await A.eval(`window.__DEV_GAME_TOOLS__.triggerFire()`);
          if (!fired) await delay(50);
        }
        if (fired) shots++;
        else await A.eval(`window.__DEV_GAME_TOOLS__.triggerReloadAnim?.()`);
        await delay(160);
        const st = await B.eval(
          `(() => { const s = window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics(); const me = window.__LAST_SNAP__?.players?.find((p) => p.id === ${JSON.stringify(idB)}); return { role: s.survivalUi?.myRole ?? null, alive: me ? me.alive : null, hp: me ? me.hp : null, phase: s.match?.phase ?? null }; })()`,
        );
        if (st.alive === false || st.role === 'eliminated' || st.role === 'spectator') eliminated = true;
        spect.lastTargetState = st;
      }
      await A.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
      spect.shotsFired = shots;
      spect.eliminated = eliminated;
      if (eliminated) {
        await delay(1200);
        spect.diagBefore = await B.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().spectator`);
        spect.cycleNext = await B.eval(`window.__DEV_GAME_TOOLS__.cycleSpectatorTarget(1)`);
        spect.cyclePrev = await B.eval(`window.__DEV_GAME_TOOLS__.cycleSpectatorTarget(-1)`);
        spect.diagAfter = await B.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().spectator`);
        spect.matchPhase = await B.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().match?.phase ?? null`);
        spect.aRemoteOnB = await remoteDiag(B, idA);
      }
    }
    out.survival.spectator = spect;
    if (!spect.attempted) check(checks, 'survival.spectatorCycle', 'NOT_ACHIEVED', spect, 'no looted weapon → could not eliminate client B');
    else if (!spect.eliminated)
      check(
        checks,
        'survival.spectatorCycle',
        'NOT_ACHIEVED',
        { bReached: spect.bReached, shotsFired: spect.shotsFired, last: spect.lastTargetState },
        'client B was not eliminated (LOS/ammo/range)',
      );
    else
      check(
        checks,
        'survival.spectatorCycle',
        spect.cycleNext === idA || spect.cyclePrev === idA ? 'PASS' : 'FAIL',
        { cycleNext: spect.cycleNext, cyclePrev: spect.cyclePrev, expected: idA, matchPhase: spect.matchPhase },
        spect.cycleNext === null ? 'with 2 players the round ends when B dies → may leave nothing to spectate' : undefined,
      );

    // round reset: wait for the next round (2-player round ends after B's elimination)
    const rr = { roundIdStart: roundId0 };
    try {
      await A.waitFor(
        `(window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().match?.roundId ?? 0) > ${roundId0 ?? 0} && window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().match?.phase === 'playing'`,
        spect.eliminated ? 45000 : 3000,
      );
      rr.nextRound = await A.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().match?.roundId`);
      await delay(1500);
      rr.afterReset = {
        A: slimLocal(await charDiag(A)),
        BremoteA: await remoteDiag(B, idA),
        aSeesB: (await otherPlayers(A))?.some((p) => p.id === idB) ?? null,
      };
    } catch {
      rr.nextRound = null;
    }
    out.survival.roundReset = rr;
    check(
      checks,
      'survival.roundReset',
      rr.nextRound
        ? out.charHook
          ? rr.afterReset.A?.mode === 'buddy' && rr.afterReset.BremoteA?.mode === 'buddy'
            ? 'PASS'
            : 'FAIL'
          : 'PASS'
        : 'NOT_ACHIEVED',
      rr,
      rr.nextRound ? undefined : 'next round did not start within the wait window',
    );
    out.survival.errors = { A: A.errorsSummary(), B: B.errorsSummary() };
    check(checks, 'survival.noPageExceptions', A.pageExceptions.length + B.pageExceptions.length === 0 ? 'PASS' : 'FAIL', {
      A: A.pageExceptions.slice(0, 5),
      B: B.pageExceptions.slice(0, 5),
    });
    await closeClient(A);
    await closeClient(B);
  }

  out.summary = {
    pass: checks.filter((c) => c.status === 'PASS').length,
    fail: checks.filter((c) => c.status === 'FAIL').length,
    skip: checks.filter((c) => c.status === 'SKIP').length,
    notAchieved: checks.filter((c) => c.status === 'NOT_ACHIEVED').length,
    info: checks.filter((c) => c.status === 'INFO').length,
  };
  return out;
}

// ---------------------------------------------------------------------------------------------
// PHASE: perf
// ---------------------------------------------------------------------------------------------
async function phasePerf() {
  const out = { notes: [] };
  const lane = await getLane();
  out.lane = lane;
  const S = lane.start;
  const fw = fwdOf(lane.yaw);
  const rt = rightOf(lane.yaw);
  const { A, B, roomName, idA, idB } = await setupPair('perf', 'tdm');
  out.roomName = roomName;
  out.gpu = await gpuInfo(A);
  out.gpuRendererVerbatim = out.gpu?.renderer ?? null;
  out.world = await worldInfo(A);
  out.charHook = await hasCharHook(A);
  await B.eval(`(() => { window.__SET_RAF_CAP_FPS__?.(30); window.__DEV_GAME_TOOLS__.setWeapon('rifle'); })()`);
  // B walks (server-authoritative) to a fixed spot beside the lane start so the scene is the same every run
  const bGoal = { x: r3(S.x + rt.x * 2.4 + fw.x * 1.5), z: r3(S.z + rt.z * 2.4 + fw.z * 1.5) };
  const bFrom = await authPos(B);
  const np = await procs.helper.call('navPath', { from: { x: bFrom.x, z: bFrom.z }, to: bGoal });
  const bDrive = np.ok
    ? await driveTo(B, np.waypoints, { walk: false, timeoutMs: Math.max(40000, (np.len / 5.5) * 1000 + 20000), arriveR: 0.6 })
    : { reached: false };
  out.clientB = { goal: bGoal, pathLen: np.len, reached: bDrive.reached, pos: bDrive.pos ?? (await authPos(B)), ms: bDrive.ms };
  if (!bDrive.reached)
    out.notes.push(
      `client B did not reach the fixed perf spot (ended at ${JSON.stringify(out.clientB.pos)}); scene still captured with B wherever it is (non-deterministic).`,
    );
  // B stays connected (server keeps its idle position, A renders it from snapshots) but renders at 2 fps so its
  // tab does not steal GPU/CPU time from A inside the same Chrome process during the capture
  await B.eval(`window.__SET_RAF_CAP_FPS__?.(2)`);
  out.clientBRafCapFps = 2;
  // A: pose-locked at the lane start, 3P, fixed camera showing A (and B beside it)
  const eye = { x: S.x - fw.x * 6.5 + rt.x * 2.0, y: S.y + 2.1, z: S.z - fw.z * 6.5 + rt.z * 2.0 };
  const cam = lookAtCamera(eye, { x: S.x + rt.x * 1.2, y: S.y + 1.0, z: S.z + rt.z * 1.2 });
  out.camera = cam;
  await A.eval(
    `(() => { const T = window.__DEV_GAME_TOOLS__; window.__SET_RAF_CAP_FPS__?.(null); T.setQuality('medium'); T.setThirdPerson(true); T.setWeapon('rifle'); T.setPlayerPos(${S.x}, ${S.z}, ${lane.yaw}, undefined, 0); window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam)}; document.body.classList.add('qa-clean', 'qa-nocross'); })()`,
  );
  await A.send('Page.bringToFront');
  await delay(1500);
  out.sceneShot = await A.screenshot('perf_scene');
  out.bVisibleOnA = await remoteDiag(A, idB);
  out.charDiagA = slimLocal(await charDiag(A));
  const runs = [];
  for (let rep = 1; rep <= REPEATS; rep++) {
    await A.send('Page.bringToFront');
    await delay(WARMUP_SEC * 1000);
    await A.eval(`window.__DEV_GAME_TOOLS__.startBenchmarkCapture()`);
    await delay(DURATION_SEC * 1000);
    const res = await A.eval(
      `(() => { const r = window.__DEV_GAME_TOOLS__.stopBenchmarkCapture(); r.programs = window.__GET_WEBGL_PROGRAMS_COUNT__?.() ?? null; return r; })()`,
    );
    delete res.culling;
    runs.push({ repeat: rep, ...res });
    log(
      `  [perf #${rep}] frames=${res.frames} fps p50=${res.fpsMedian} 1%low=${res.fps1PctLow} | FT p50=${res.frameTimeMedianMs} p95=${res.frameTimeP95Ms} p99=${res.frameTimeP99Ms} ms | draw=${res.render?.calls} tris=${res.render?.triangles} | heap=${res.heapUsedMB}MB`,
    );
  }
  const m = (k) => r3(median(runs.map((r) => r[k]).filter((v) => typeof v === 'number')));
  const last = runs[runs.length - 1];
  out.result = {
    warmupSeconds: WARMUP_SEC,
    captureSeconds: DURATION_SEC,
    repeats: REPEATS,
    fpsMedian: m('fpsMedian'),
    fpsMean: m('fpsMean'),
    fps1PctLow: m('fps1PctLow'),
    frameTimeMedianMs: m('frameTimeMedianMs'),
    frameTimeP95Ms: m('frameTimeP95Ms'),
    frameTimeP99Ms: m('frameTimeP99Ms'),
    gpuTimeMedianMs: m('gpuTimeMedianMs'),
    drawCalls: last?.render?.calls ?? null,
    sceneCalls: last?.render?.sceneCalls ?? null,
    triangles: last?.render?.triangles ?? null,
    geometries: last?.render?.geometries ?? null,
    textures: last?.render?.textures ?? null,
    programs: last?.programs ?? null,
    heapUsedMB: last?.heapUsedMB ?? null,
    heapTotalMB: last?.heapTotalMB ?? null,
  };
  out.runs = runs;
  out.errors = { A: A.errorsSummary(), B: B.errorsSummary() };
  await A.eval(`window.__DEV_CAMERA_OVERRIDE__ = null`);
  await closeClient(A);
  await closeClient(B);
  void idA;
  return out;
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
async function main() {
  const phases = PHASE === 'all' ? ['shots', 'video', 'multi', 'perf'] : PHASE.split(',');
  for (const p of phases) if (!['shots', 'video', 'multi', 'perf'].includes(p)) throw new Error(`unknown phase ${p}`);
  const meta = {
    label: LABEL,
    root: ROOT,
    phases,
    ports: { server: PORT, vite: VITE_PORT, chromeDebug: DEBUG_PORT },
    viewport: '1280x720',
    dpr: 1,
    quality: 'medium',
    map: 'forest_square',
    seed: SEED,
    timestamp: new Date().toISOString(),
    command: `node ${rel(fileURLToPath(import.meta.url))} ${process.argv.slice(2).join(' ')}`,
  };
  try {
    meta.gitHead = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    meta.gitDirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .filter(Boolean).length;
  } catch {
    meta.gitHead = null;
  }
  let exitCode = 0;
  const results = {};
  try {
    const services = await startServices();
    const cpus = os.cpus();
    meta.environment = {
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      cpuModel: cpus[0]?.model ?? 'unknown',
      cpuCores: cpus.length,
      totalRamGB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
      nodeVersion: process.version,
      chromeVersion: services.versionInfo.Browser,
      headless: !HEADFUL,
      ffmpeg: FFMPEG,
    };
    await startHelper();
    meta.helperWorld = procs.helper.meta;
    for (const p of phases) {
      log(`===== phase ${p} =====`);
      const t0 = Date.now();
      try {
        if (p === 'shots') results.shots = await phaseShots();
        if (p === 'video') results.video = await phaseVideo();
        if (p === 'multi') results.multi = await phaseMulti();
        if (p === 'perf') results.perf = await phasePerf();
        results[p].durationSec = r3((Date.now() - t0) / 1000);
      } catch (e) {
        console.error(`[08B-CHAR QA ${LABEL}] phase ${p} FAILED:`, e);
        results[p] = {
          ...(results[p] ?? {}),
          fatalError: String(e?.stack ?? e),
          openClientErrors: [...openSessions].map((c) => ({ client: c.label, ...c.errorsSummary() })),
        };
        exitCode = 1;
        for (const c of [...openSessions]) {
          try {
            const shot = await c.screenshot(`fatal_${p}_${c.label}`);
            results[p].openClientErrors.find((x) => x.client === c.label).screenshot = shot.file;
          } catch {
            /* ignore */
          }
          c.close();
          openSessions.delete(c);
        }
        for (const id of [...openTargets]) {
          await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${id}`).catch(() => {});
          openTargets.delete(id);
        }
      }
      const file = { shots: `qa_shots_${LABEL}.json`, video: `qa_videos_${LABEL}.json`, multi: `qa_multi_${LABEL}.json`, perf: `qa_perf_${LABEL}.json` }[p];
      fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify({ meta, lane: laneCache, ...results[p] }, null, 2));
      log(`wrote ${rel(path.join(OUT_DIR, file))}`);
    }
  } catch (e) {
    console.error(`[08B-CHAR QA ${LABEL}] FAILED:`, e);
    fs.writeFileSync(path.join(OUT_DIR, `qa_fatal_${LABEL}.json`), JSON.stringify({ meta, fatalError: String(e?.stack ?? e) }, null, 2));
    exitCode = 1;
  } finally {
    await stopServices();
  }
  return exitCode;
}

main().then((code) => process.exit(code));
