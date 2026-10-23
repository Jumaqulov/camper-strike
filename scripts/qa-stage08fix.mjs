#!/usr/bin/env node
/**
 * STAGE 08-FIX — Collision, Terrain & Forest Ground Cover: Browser QA (agent F)
 *
 * Real Chrome (CDP) automation reusing the Stage 08A approach (`scripts/qa-stage08a.mjs`):
 *   - serves the app from `--root` with the Vite DEV server (DEV tools `window.__DEV_GAME_TOOLS__`,
 *     `__DEV_CAMERA_OVERRIDE__`, `__DEV_PLAYER_POSE_LOCK__` only exist in DEV builds) + the game server
 *     (`src/server/index.ts` via tsx, `PORT` env) on NON-default ports so it never collides with
 *     a developer's `npm run dev` (3000/5173). HMR + file watching are disabled so concurrent edits
 *     in the workspace cannot reload the page mid-run.
 *   - opens Chrome at 1280x720 (DPR 1), quality `medium`, `forest_square`, `publicLayoutSeed=6501`
 *   - identical camera poses for BEFORE/AFTER come from `docs/stage08fix/qa_camera_poses.json`
 *     (generated once from the pre-fix snapshot by `docs/stage08fix/qa_positions_helper.ts`).
 *
 * Phases:
 *   shots : 7 fixed angles (01 forest ground, 02 road edge, 03 flower glade, 04 tree roots/fern,
 *           05 cabin yard, 06 topdown, 06b low topdown) + capsule-walk collision probes using the
 *           shared client physics (`stepInput`, PLAYER_RADIUS 0.4 / HEIGHT 1.8, dt 1/60) with
 *           1P / 3P / fixed-camera screenshots at log, stump and rotated tent.
 *   smoke : 2 real Chrome clients in one TDM room (same seed): worldVersion/gameplayHash match,
 *           1P+3P walking/jumping with server-authority sync deltas, server-authoritative
 *           walks into the nearest hard-object probes, LOS helper.
 *   perf  : 4 scenes (open forest sweep, service station, forest camp, flower glade),
 *           `--warmup` + `--duration` x `--repeats`; deep re-run (10s + 30s x 3) on severe spikes.
 *   report: builds `docs/stage08fix/qa_summary.json` + comparison tables from the BEFORE/AFTER JSONs.
 *
 * Usage:
 *   node scripts/qa-stage08fix.mjs --root=<dir> --label=before|after --port=3100 [--vitePort=5273]
 *        --phase=shots|smoke|perf|all|report [--warmup=5 --duration=15 --repeats=2]
 *        [--deep=auto|on|off] [--strict] [--headful]
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const PORT = Number(args.port ?? 3100);
const VITE_PORT = Number(args.vitePort ?? PORT + 2173);
const DEBUG_PORT = Number(args.debugPort ?? PORT + 6200);
const WARMUP_SEC = Number(args.warmup ?? 5);
const DURATION_SEC = Number(args.duration ?? 15);
const REPEATS = Number(args.repeats ?? 2);
const DEEP = String(args.deep ?? 'auto');
const STRICT = args.strict === 'true';
const HEADFUL = args.headful === 'true';
const SEED = 6501;

const SHOT_DIR = path.join(WORKSPACE, 'docs', 'screenshots', 'stage08fix', LABEL);
const REPORT_DIR = path.join(WORKSPACE, 'docs', 'stage08fix');
const LOG_DIR = path.join(REPORT_DIR, 'logs');
const POSES_PATH = path.join(REPORT_DIR, 'qa_camera_poses.json');
for (const d of [SHOT_DIR, REPORT_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });

const log = (...m) => console.log(`[08FIX QA ${LABEL}]`, ...m);

// ---------------------------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------------------------
function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Google Chrome topilmadi (CHROME_PATH ni belgilang)');
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
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const r3 = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function lookAtCamera(eye, target) {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const horiz = Math.hypot(dx, dz) || 1e-6;
  return { x: r3(eye.x), y: r3(eye.y), z: r3(eye.z), yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, horiz) };
}
const yawToward = (x0, z0, x1, z1) => Math.atan2(-(x1 - x0), -(z1 - z0));

/** Parses ground-cover numbers out of the DEV overlay text (format may vary; best effort). */
function parseGroundCoverFromText(txt) {
  if (!txt) return null;
  const grab = (re) => {
    const m = txt.match(re);
    return m ? Number(m[1]) : null;
  };
  const out = {
    visibleGrass: grab(/grass[^0-9\n]*([0-9]+)/i),
    visibleFlowers: grab(/flower[s]?[^0-9\n]*([0-9]+)/i),
    visibleFerns: grab(/fern[s]?[^0-9\n]*([0-9]+)/i),
    visibleChunks: grab(/chunk[s]?[^0-9\n]*([0-9]+)/i),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

// ---------------------------------------------------------------------------------------------
// CDP session (same as 08A, trimmed)
// ---------------------------------------------------------------------------------------------
class CdpSession {
  constructor(wsUrl, label) {
    this.ws = new WebSocket(wsUrl);
    this.label = label;
    this.seq = 0;
    this.pending = new Map();
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
      } else if (msg.method === 'Runtime.consoleAPICalled') {
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
  async screenshot(filename) {
    await this.send('Page.bringToFront');
    await delay(150);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const outPath = path.join(SHOT_DIR, filename);
    fs.writeFileSync(outPath, buf);
    log(`  [screenshot] ${LABEL}/${filename} (${width}x${height}, ${buf.length} B)`);
    return { filename, path: `docs/screenshots/stage08fix/${LABEL}/${filename}`, width, height, bytes: buf.length };
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
    window.WebSocket = class extends OrigWebSocket {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string' && ev.data.startsWith('42[')) {
            try { const p = JSON.parse(ev.data.slice(2)); if (Array.isArray(p) && p[0] === 'snap') window.__LAST_SNAP__ = p[1]; } catch {}
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

const GC_STATS_EXPR = `(() => {
  const T = window.__DEV_GAME_TOOLS__;
  let gc = null; let gcFn = null;
  for (const k of ['getGroundCoverStats', 'getGroundCoverDiagnostics', 'getForestGroundCoverStats']) {
    if (typeof T?.[k] === 'function') { try { gc = T[k](); gcFn = k; } catch (e) { gc = { error: String(e) }; gcFn = k; } break; }
  }
  const el = document.getElementById('dev-stats');
  const devStatsText = el ? (el.innerText || el.textContent || '') : '';
  const perfMem = performance.memory;
  return {
    gc, gcFn, devStatsText,
    render: T?.getRenderStats?.() ?? null,
    programs: typeof window.__GET_WEBGL_PROGRAMS_COUNT__ === 'function' ? window.__GET_WEBGL_PROGRAMS_COUNT__() : null,
    heapUsedMB: perfMem ? Number((perfMem.usedJSHeapSize / 1048576).toFixed(2)) : null,
    toolKeys: T ? Object.keys(T) : [],
  };
})()`;

async function grabStats(cdp) {
  const s = await cdp.eval(GC_STATS_EXPR);
  s.gcParsed = s.gc && !s.gc.error ? s.gc : parseGroundCoverFromText(s.devStatsText);
  return s;
}

// ---------------------------------------------------------------------------------------------
// services
// ---------------------------------------------------------------------------------------------
const procs = { server: null, vite: null, chrome: null, userDataDir: null };

async function startServices() {
  if (await httpOk(`http://127.0.0.1:${PORT}/api/info`)) throw new Error(`Port ${PORT} already serves /api/info — choose another --port`);
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) throw new Error(`tsx not found at ${tsxCli} (node_modules junction missing?)`);
  const serverLog = fs.createWriteStream(path.join(LOG_DIR, `${LABEL}_server_${PORT}.log`));
  log(`Starting game server: node ${tsxCli} src/server/index.ts (cwd=${ROOT}, PORT=${PORT})`);
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
  log(`Starting Vite DEV server on ${VITE_PORT} (root=${ROOT}, hmr=false, watch=null, proxy → ${PORT})`);
  const cfg = {
    configFile: false,
    root: ROOT,
    cacheDir: path.join(os.tmpdir(), `stickman-qa08fix-vite-${LABEL}-${VITE_PORT}`),
    logLevel: 'warn',
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port: VITE_PORT,
      strictPort: true,
      hmr: false,
      watch: null,
      proxy: {
        '/socket.io': { target: `http://127.0.0.1:${PORT}`, ws: true },
        '/api': `http://127.0.0.1:${PORT}`,
      },
    },
  };
  procs.vite = await vite.createServer(cfg);
  await procs.vite.listen();
  await waitForHttp(`http://127.0.0.1:${VITE_PORT}/`, 60000);
  await waitForHttp(`http://127.0.0.1:${VITE_PORT}/api/info`, 30000);

  const chromePath = findChromePath();
  procs.userDataDir = path.join(os.tmpdir(), `stickman_qa08fix_${LABEL}_${Date.now()}`);
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
  if (procs.chrome?.pid) killTree(procs.chrome.pid);
  try {
    await procs.vite?.close();
  } catch {
    /* ignore */
  }
  if (procs.server?.pid) killTree(procs.server.pid);
  await delay(300);
  try {
    if (procs.userDataDir) fs.rmSync(procs.userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const APP_URL = () => `http://127.0.0.1:${VITE_PORT}/`;

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
  return cdp;
}

async function enterLobby(cdp, name) {
  await cdp.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`, 90000);
  await cdp.eval(`(() => { localStorage.removeItem('qa'); document.getElementById('name-input').value = ${JSON.stringify(name)}; document.getElementById('btn-enter').click(); })()`);
  await cdp.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`, 30000);
}

async function createTdmRoom(cdp, roomName) {
  await cdp.eval(`(() => {
    window.__CREATE_ROOM_OVERRIDES__ = { publicLayoutSeed: ${SEED} };
    const m = document.getElementById('room-mode'); m.value = 'tdm'; m.dispatchEvent(new Event('change', { bubbles: true }));
    const lp = document.getElementById('room-loot-preview'); if (lp) { lp.checked = false; lp.dispatchEvent(new Event('change', { bubbles: true })); }
    const map = document.getElementById('room-map'); if (map) map.value = 'forest_square';
    const b = document.getElementById('room-bots'); b.disabled = false; b.value = '0';
    document.getElementById('room-name').value = ${JSON.stringify(roomName)};
    document.getElementById('room-time').value = '30';
    const sc = document.getElementById('room-score'); sc.disabled = false; sc.value = '500';
    document.getElementById('btn-create').click();
  })()`);
  await cdp.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`, 90000);
}

async function joinRoomByName(cdp, roomName) {
  await cdp.eval(`document.getElementById('btn-refresh')?.click()`);
  await cdp.waitFor(`(() => {
    const items = Array.from(document.querySelectorAll('.room-item'));
    const it = items.find((el) => el.textContent?.includes(${JSON.stringify(roomName)}));
    const btn = it?.querySelector('[data-join]');
    if (!btn) { document.getElementById('btn-refresh')?.click(); return false; }
    btn.click(); return true;
  })()`, 30000);
  await cdp.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`, 90000);
}

const ASSETS_READY_EXPR = `(() => {
  const T = window.__DEV_GAME_TOOLS__; if (!T) return false;
  const okAll = (o) => Object.values(o || {}).every((d) => d.loaded && !d.failed && !d.isFallback);
  const w = okAll(T.getDiagnostics?.());
  const f = okAll(T.getForestDiagnostics?.());
  const s = T.getStage04ADiagnostics ? T.getStage04ADiagnostics().allLoaded : true;
  const o = T.getOutdoorDiagnostics ? (T.getOutdoorDiagnostics().allLoaded && T.getOutdoorDiagnostics().renderer?.allGlbLoaded !== false) : true;
  return w && f && s && o;
})()`;

async function prepClient(cdp) {
  await cdp.waitFor(ASSETS_READY_EXPR, 120000);
  await cdp.eval(`(() => {
    if (!document.getElementById('qa-08fix-hud')) {
      const st = document.createElement('style'); st.id = 'qa-08fix-hud';
      st.textContent = '#pause-menu, #center-msg, #scoreboard, #death-screen, #toast { display: none !important; } #dev-stats { display: block !important; } body.qa-clean #hud-health, body.qa-clean #hud-ammo, body.qa-clean #chat, body.qa-clean #team-badge, body.qa-clean #killfeed, body.qa-clean #top-bar, body.qa-clean #reload-hint { display: none !important; }';
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

function loadPoses() {
  if (!fs.existsSync(POSES_PATH)) throw new Error(`${POSES_PATH} missing — run: npx tsx docs/stage08fix/qa_positions_helper.ts <preFixRoot> 6501 docs/stage08fix/qa_camera_poses.json`);
  return JSON.parse(fs.readFileSync(POSES_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// capsule walk probes (shared client physics via DEV stepInput; same code as server authority)
// ---------------------------------------------------------------------------------------------
async function runProbeWalk(cdp, p) {
  const segs = p.segments ?? [{ to: p.end, maxSteps: p.maxSteps }];
  return cdp.eval(`(() => {
    const T = window.__DEV_GAME_TOOLS__;
    T.setSyntheticInput?.(null);
    window.__DEV_CAMERA_OVERRIDE__ = null;
    const segs = ${JSON.stringify(segs)};
    const start = ${JSON.stringify(p.start)};
    const yawTo = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z));
    let cur = T.setPlayerPos(start.x, start.z, yawTo(start, segs[0].to), start.yOverride);
    const startPose = { x: cur.x, y: cur.y, z: cur.z };
    const path = [[+cur.x.toFixed(3), +cur.y.toFixed(3), +cur.z.toFixed(3)]];
    let steps = 0;
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      if (si > 0) cur = T.setPlayerPos(cur.x, cur.z, yawTo(cur, seg.to), cur.y);
      const toX = seg.to.x;
      const toZ = seg.to.z;
      const vX = toX - cur.x;
      const vZ = toZ - cur.z;
      const vLen = Math.hypot(vX, vZ) || 1;
      const nX = vX / vLen;
      const nZ = vZ / vLen;
      let stuck = 0;
      for (let i = 0; i < seg.maxSteps; i++) {
        const prev = cur;
        cur = T.stepInput(1, 0, false, 1 / 60, 1);
        steps++;
        path.push([+cur.x.toFixed(3), +cur.y.toFixed(3), +cur.z.toFixed(3)]);
        const d = Math.hypot(toX - cur.x, toZ - cur.z);
        const past = (cur.x - toX) * nX + (cur.z - toZ) * nZ;
        if (d < 0.35 || past >= 0) break;
        if (Math.hypot(cur.x - prev.x, cur.z - prev.z) < 0.002) { if (++stuck > 20) break; } else stuck = 0;
      }
    }
    return { startPose, final: { x: cur.x, y: cur.y, z: cur.z, onGround: cur.onGround }, steps, path };
  })()`);
}

function classifyProbe(p, walk) {
  const s = walk.startPose;
  const f = walk.final;
  const ex = p.end.x - s.x;
  const ez = p.end.z - s.z;
  const total = Math.hypot(ex, ez) || 1;
  const dx = ex / total;
  const dz = ez / total;
  const prog = (q) => (q[0] - s.x) * dx + (q[2] - s.z) * dz;
  const cProg = (p.center.x - s.x) * dx + (p.center.z - s.z) * dz;
  const fProg = (f.x - s.x) * dx + (f.z - s.z) * dz;
  // rise above the straight start→final line (terrain-agnostic approximation)
  let maxRise = 0;
  for (const q of walk.path) {
    const t = clamp(prog(q) / Math.max(0.01, fProg), 0, 1);
    const base = s.y + (f.y - s.y) * t;
    maxRise = Math.max(maxRise, q[1] - base);
  }
  const distCenter = Math.hypot(f.x - p.center.x, f.z - p.center.z);
  const distEnd = Math.hypot(f.x - p.end.x, f.z - p.end.z);
  let outcome;
  let pass;
  if (p.id === 'tent_enter') {
    outcome = distCenter < 0.5 ? 'ENTERED_CENTER' : `BLOCKED_${r3(distCenter)}m_FROM_CENTER`;
    pass = distCenter < 0.5;
  } else if (p.id === 'tent_exit') {
    const exited = distEnd < 0.6 || fProg >= total - 0.5;
    outcome = exited ? 'EXITED' : `STUCK_${r3(distEnd)}m_FROM_EXIT`;
    pass = exited;
  } else if (p.id === 'tent_side_wall') {
    outcome = distCenter < 0.9 ? 'WALL_PASSED_BUG' : 'BLOCKED_BY_WALL';
    pass = distCenter >= 0.9;
  } else if (p.id === 'cabin_stairs_loft') {
    outcome = f.y >= 4.85 ? `CLIMBED_TO_${r3(f.y)}` : `NOT_CLIMBED_y${r3(f.y)}`;
    pass = f.y >= 4.85;
  } else {
    const crossed = fProg > cProg + 0.5;
    if (!crossed) outcome = `BLOCKED_${r3(cProg - fProg)}m_BEFORE_CENTER`;
    else outcome = maxRise >= 0.12 ? `STEPPED_OVER_rise${r3(maxRise)}` : 'WALK_THROUGH';
    // logs/stumps: stepping over is acceptable (STEP_HEIGHT 0.55), walking THROUGH is the bug
    pass = /^(fallen_log|tree_stump)$/.test(p.kind) ? outcome !== 'WALK_THROUGH' : !crossed;
  }
  return { outcome, pass, finalProgress: r3(fProg), centerProgress: r3(cProg), maxRise: r3(maxRise), distToCenter: r3(distCenter), distToEnd: r3(distEnd) };
}

// ---------------------------------------------------------------------------------------------
// PHASE: shots
// ---------------------------------------------------------------------------------------------
async function phaseShots(cdp, poses) {
  const shots = [];
  log(`Shots: ${poses.shots.length} fixed angles`);
  await cdp.eval(`(() => { window.__SET_RAF_CAP_FPS__?.(60); document.body.classList.add('qa-clean'); })()`);
  for (const s of poses.shots) {
    await cdp.eval(`(() => {
      const T = window.__DEV_GAME_TOOLS__;
      T.setSyntheticInput?.(null);
      T.setThirdPerson(false);
      T.setPlayerPos(${s.player.x}, ${s.player.z}, ${s.cam.yaw});
      window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(s.cam)};
    })()`);
    await delay(1800);
    const stats = await grabStats(cdp);
    const info = await cdp.screenshot(s.file);
    shots.push({ ...info, desc: s.desc, cam: s.cam, stats });
  }

  log('Collision probes (capsule walk via shared client physics, dt=1/60):');
  await cdp.eval(`document.body.classList.remove('qa-clean')`);
  const probes = [];
  for (const p of poses.probes) {
    const walk = await runProbeWalk(cdp, p);
    const cls = classifyProbe(p, walk);
    log(`  [probe] ${p.id.padEnd(18)} ${cls.pass ? 'PASS' : 'FAIL'}  ${cls.outcome}  final=(${r3(walk.final.x)}, ${r3(walk.final.y)}, ${r3(walk.final.z)}) steps=${walk.steps}`);
    const rec = { id: p.id, kind: p.kind, objectId: p.objectId, expect: p.expect, ...cls, start: walk.startPose, final: walk.final, steps: walk.steps, pathSample: walk.path.filter((_, i) => i % 6 === 0 || i === walk.path.length - 1) };
    probes.push(rec);

    const shotPrefix = { log_cross: '07_log', stump_cross: '08_stump', tent_enter: '09_tent' }[p.id];
    if (!shotPrefix) continue;
    const f = walk.final;
    const dC = Math.hypot(p.center.x - f.x, p.center.z - f.z);
    const yaw = p.id === 'tent_enter' || dC < 0.3 ? p.shotYaw : yawToward(f.x, f.z, p.center.x, p.center.z);
    rec.shots = [];
    // 1P
    await cdp.eval(`(() => { const T = window.__DEV_GAME_TOOLS__; window.__DEV_CAMERA_OVERRIDE__ = null; T.setThirdPerson(false); T.setPlayerPos(${f.x}, ${f.z}, ${yaw}, ${f.y}, -0.32); })()`);
    await delay(1100);
    rec.shots.push(await cdp.screenshot(`${shotPrefix}_1p.png`));
    // 3P
    await cdp.eval(`(() => { const T = window.__DEV_GAME_TOOLS__; window.__DEV_CAMERA_OVERRIDE__ = null; T.setThirdPerson(true); T.setPlayerPos(${f.x}, ${f.z}, ${yaw}, ${f.y}, -0.22); })()`);
    await delay(1100);
    rec.shots.push(await cdp.screenshot(`${shotPrefix}_3p.png`));
    // fixed camera (identical BEFORE/AFTER) showing body vs object
    if (p.fixedCam) {
      await cdp.eval(`(() => { window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(p.fixedCam)}; })()`);
      await delay(900);
      rec.shots.push(await cdp.screenshot(`${shotPrefix}_fixedcam.png`));
    }
    if (p.id === 'tent_enter') {
      // F9 collision debug overlay (DEV, Stage 08-FIX agent A). Inert on pre-fix builds.
      await cdp.eval(`(() => { window.__DEV_CAMERA_OVERRIDE__ = null; const T = window.__DEV_GAME_TOOLS__; T.setThirdPerson(true); T.setPlayerPos(${f.x}, ${f.z}, ${yaw}, ${f.y}, -0.22);
        const ev = (t) => new KeyboardEvent(t, { key: 'F9', code: 'F9', keyCode: 120, which: 120, bubbles: true, cancelable: true });
        document.dispatchEvent(ev('keydown')); document.dispatchEvent(ev('keyup')); })()`);
      await delay(900);
      rec.shots.push(await cdp.screenshot(`${shotPrefix}_3p_f9_debug.png`));
      await cdp.eval(`(() => { const ev = (t) => new KeyboardEvent(t, { key: 'F9', code: 'F9', keyCode: 120, which: 120, bubbles: true, cancelable: true });
        document.dispatchEvent(ev('keydown')); document.dispatchEvent(ev('keyup')); })()`);
    }
  }
  await cdp.eval(`(() => { window.__DEV_CAMERA_OVERRIDE__ = null; window.__DEV_GAME_TOOLS__.setThirdPerson(false); })()`);
  return { shots, probes };
}

// ---------------------------------------------------------------------------------------------
// PHASE: perf
// ---------------------------------------------------------------------------------------------
async function benchScene(cdp, scene, warmup, duration, repeats) {
  const runs = [];
  for (let rep = 1; rep <= repeats; rep++) {
    await cdp.send('Page.bringToFront');
    await cdp.eval(`(() => {
      const T = window.__DEV_GAME_TOOLS__;
      if (window.__QA_SWEEP__) { clearInterval(window.__QA_SWEEP__); window.__QA_SWEEP__ = null; }
      T.setSyntheticInput?.(null);
      T.setThirdPerson(false);
      T.setPlayerPos(${scene.player.x}, ${scene.player.z}, ${scene.cam.yaw});
      const base = ${JSON.stringify(scene.cam)};
      window.__DEV_CAMERA_OVERRIDE__ = Object.assign({}, base);
      const sw = ${JSON.stringify(scene.sweep ?? null)};
      if (sw) {
        const t0 = performance.now();
        window.__QA_SWEEP__ = setInterval(() => {
          const t = (performance.now() - t0) / 1000;
          window.__DEV_CAMERA_OVERRIDE__ = Object.assign({}, base, { yaw: base.yaw + sw.amplitude * Math.sin((2 * Math.PI * t) / sw.periodSec) });
        }, 8);
      }
    })()`);
    await delay(warmup * 1000);
    await cdp.eval(`window.__DEV_GAME_TOOLS__.startBenchmarkCapture()`);
    await delay(Math.max(1000, duration * 1000 - 400));
    const mid = await grabStats(cdp); // ground-cover + render stats sampled inside the window
    await delay(400);
    const res = await cdp.eval(`(() => { const r = window.__DEV_GAME_TOOLS__.stopBenchmarkCapture(); r.programs = window.__GET_WEBGL_PROGRAMS_COUNT__?.() ?? null; r.outdoor = window.__DEV_GAME_TOOLS__.getOutdoorDiagnostics?.().renderer ?? null; return r; })()`);
    await cdp.eval(`(() => { if (window.__QA_SWEEP__) { clearInterval(window.__QA_SWEEP__); window.__QA_SWEEP__ = null; } })()`);
    runs.push({ repeat: rep, ...res, groundCover: mid.gcParsed, gcFn: mid.gcFn, devStatsText: mid.devStatsText });
    log(`  [${scene.id} #${rep}] frames=${res.frames} p50=${res.fpsMedian} p10=${res.fpsP10} 1%low=${res.fps1PctLow} | FT p50=${res.frameTimeMedianMs} p95=${res.frameTimeP95Ms} p99=${res.frameTimeP99Ms} ms | draw=${res.render?.calls} tris=${res.render?.triangles} | heap=${res.heapUsedMB}MB | gc=${JSON.stringify(mid.gcParsed)}`);
  }
  const m = (k) => r3(median(runs.map((r) => r[k]).filter((v) => typeof v === 'number')));
  const last = runs[runs.length - 1];
  return {
    scene: scene.id,
    desc: scene.desc,
    warmupSeconds: warmup,
    measurementSeconds: duration,
    repeats,
    fpsMean: m('fpsMean'),
    fpsMedian: m('fpsMedian'),
    fpsP10: m('fpsP10'),
    fps1PctLow: m('fps1PctLow'),
    frameTimeMedianMs: m('frameTimeMedianMs'),
    frameTimeP95Ms: m('frameTimeP95Ms'),
    frameTimeP99Ms: m('frameTimeP99Ms'),
    cullCpuMedianMs: m('cullCpuMedianMs'),
    cullCpuP95Ms: m('cullCpuP95Ms'),
    gpuTimeMedianMs: m('gpuTimeMedianMs'),
    calls: last.render?.calls,
    triangles: last.render?.triangles,
    geometries: last.render?.geometries,
    textures: last.render?.textures,
    programs: last.programs,
    heapUsedMB: last.heapUsedMB,
    groundCover: last.groundCover,
    runs,
  };
}

async function phasePerf(cdp, poses) {
  log(`Perf: warmup=${WARMUP_SEC}s duration=${DURATION_SEC}s repeats=${REPEATS} deep=${DEEP}`);
  await cdp.eval(`(() => { window.__SET_RAF_CAP_FPS__?.(null); window.__DEV_GAME_TOOLS__.setQuality('medium'); })()`);
  await delay(500);
  const scenes = [];
  for (const sc of poses.benchScenes) {
    const r = await benchScene(cdp, sc, WARMUP_SEC, DURATION_SEC, REPEATS);
    const severe = r.fps1PctLow < 30 || r.frameTimeP99Ms > 4 * Math.max(1, r.frameTimeMedianMs);
    r.severeSpike = severe;
    if (DEEP === 'on' || (DEEP === 'auto' && severe)) {
      log(`  [${sc.id}] severe spike (1%low=${r.fps1PctLow}, p99=${r.frameTimeP99Ms}ms) → deep run 10s + 30s x 3`);
      r.deep = await benchScene(cdp, sc, 10, 30, 3);
    }
    scenes.push(r);
  }
  await cdp.eval(`(() => { window.__DEV_CAMERA_OVERRIDE__ = null; window.__SET_RAF_CAP_FPS__?.(60); })()`);
  return scenes;
}

function writePerfCsv(scenes, file) {
  const cols = ['scene', 'warmupSeconds', 'measurementSeconds', 'repeats', 'fpsMean', 'fpsMedian', 'fpsP10', 'fps1PctLow', 'frameTimeMedianMs', 'frameTimeP95Ms', 'frameTimeP99Ms', 'cullCpuMedianMs', 'cullCpuP95Ms', 'gpuTimeMedianMs', 'calls', 'triangles', 'geometries', 'textures', 'programs', 'heapUsedMB', 'visibleGrass', 'visibleFlowers', 'visibleFerns', 'severeSpike'];
  const rows = [cols.join(',')];
  const push = (r, tag) => rows.push(cols.map((c) => {
    if (c === 'scene') return r.scene + (tag ?? '');
    if (c.startsWith('visible')) return r.groundCover?.[c] ?? '';
    return r[c] ?? '';
  }).join(','));
  for (const s of scenes) {
    push(s);
    if (s.deep) push(s.deep, '_deep');
  }
  fs.writeFileSync(file, rows.join('\n') + '\n');
}

// ---------------------------------------------------------------------------------------------
// PHASE: smoke (2 clients)
// ---------------------------------------------------------------------------------------------
async function selfId(cdp) {
  return cdp.eval(`(() => {
    const d = window.__DEV_GAME_TOOLS__.getPredictionDiagnostics();
    const a = d.authoritativePos || d.predictedPos; const s = window.__LAST_SNAP__;
    if (!s || !a) return null; let best = null, bd = 1e9;
    for (const p of s.players) { const dd = Math.hypot(p.x - a.x, p.z - a.z); if (dd < bd) { bd = dd; best = p.id; } }
    return best;
  })()`);
}

async function snapPos(cdp, id) {
  return cdp.eval(`(() => { const s = window.__LAST_SNAP__; const p = s?.players?.find((q) => q.id === ${JSON.stringify(id)}); return p ? { x: p.x, y: p.y, z: p.z, t: s.t, tick: s.serverTick ?? null, onGround: p.onGround } : null; })()`);
}

async function startWander(cdp, seedPhase) {
  await cdp.eval(`(() => {
    const T = window.__DEV_GAME_TOOLS__;
    window.__DEV_CAMERA_OVERRIDE__ = null; T.clearPlayerPoseLock?.(); window.__DEV_PLAYER_POSE_LOCK__ = null;
    if (window.__QA_WANDER__) clearInterval(window.__QA_WANDER__);
    let t = ${seedPhase};
    window.__QA_WANDER__ = setInterval(() => {
      t += 0.05;
      T.setSyntheticInput({ fwd: 1, right: Math.sin(t * 0.9) * 0.5, jump: (Math.floor(t * 10) % 24) === 0, walk: false, yaw: ${seedPhase} + Math.sin(t * 0.25) * 1.4, pitch: -0.08 });
    }, 50);
  })()`);
}
async function stopWander(cdp) {
  await cdp.eval(`(() => { if (window.__QA_WANDER__) { clearInterval(window.__QA_WANDER__); window.__QA_WANDER__ = null; } window.__DEV_GAME_TOOLS__.setSyntheticInput(null); })()`);
}

/** server-authoritative waypoint walk (like 08A walkClientWaypoints) */
async function walkTo(cdp, target, maxMs = 40000, stopRadius = 0.6) {
  await cdp.eval(`(() => { window.__DEV_CAMERA_OVERRIDE__ = null; window.__DEV_PLAYER_POSE_LOCK__ = null; window.__DEV_GAME_TOOLS__.clearPlayerPoseLock?.(); })()`);
  const t0 = Date.now();
  let checkT = Date.now();
  let checkPos = null;
  let detours = 0;
  let pos = null;
  while (Date.now() - t0 < maxMs) {
    const d = await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
    pos = d.authoritativePos ?? d.predictedPos;
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= stopRadius) break;
    if (Date.now() - checkT > 300) {
      const moved = checkPos ? Math.hypot(pos.x - checkPos.x, pos.z - checkPos.z) : 1;
      checkPos = { ...pos };
      checkT = Date.now();
      if (moved < 0.4 && dist > stopRadius + 0.3) {
        detours++;
        const sign = detours % 2 ? 1 : -1;
        await cdp.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 1, right: ${sign * 0.5}, jump: true, walk: false, yaw: ${Math.atan2(-dx, -dz) + sign * 1.2}, pitch: -0.1 })`);
        await delay(380);
        continue;
      }
    }
    await cdp.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: ${dist < 1 ? 0.5 : 1}, right: 0, jump: false, walk: ${dist < 1.2}, yaw: ${Math.atan2(-dx, -dz)}, pitch: -0.1 })`);
    await delay(50);
  }
  await cdp.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
  await delay(300);
  const d = await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
  pos = d.authoritativePos ?? d.predictedPos;
  return { reached: Math.hypot(target.x - pos.x, target.z - pos.z) <= stopRadius + 0.4, pos, ms: Date.now() - t0, detours, divergenceM: d.divergenceM };
}

/** server-authoritative probe: walk straight along the probe direction with synthetic input */
async function serverProbe(cdp, p) {
  const segs = p.segments ?? [{ to: p.end, maxSteps: p.maxSteps }];
  const reach = await walkTo(cdp, p.start, 45000, 0.35);
  if (!reach.reached) return { id: p.id, reachedStart: false, approach: reach };
  const d0 = await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
  const startPose = d0.authoritativePos;
  const path = [[startPose.x, startPose.y, startPose.z]];
  for (const seg of segs) {
    const t0 = Date.now();
    const maxMs = (seg.maxSteps / 60) * 1000 + 600;
    while (Date.now() - t0 < maxMs) {
      const d = await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
      const a = d.authoritativePos ?? d.predictedPos;
      path.push([a.x, a.y, a.z]);
      if (Math.hypot(seg.to.x - a.x, seg.to.z - a.z) < 0.25) break;
      // keep the yaw fixed toward the segment target computed from the segment start (straight line)
      await cdp.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput({ fwd: 1, right: 0, jump: false, walk: false, yaw: ${yawToward(path[0][0], path[0][2], seg.to.x, seg.to.z)}, pitch: -0.1 })`);
      await delay(40);
    }
  }
  await cdp.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
  await delay(400);
  const d1 = await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
  const fin = d1.authoritativePos;
  const walk = { startPose, final: fin, path };
  return { id: p.id, reachedStart: true, approach: reach, ...classifyProbe(p, walk), final: fin, divergenceM: d1.divergenceM };
}

async function phaseSmoke(poses, versionInfo) {
  const roomName = `S08FIX_${LABEL}_${Date.now().toString().slice(-5)}`;
  const c1 = await openClient('Client1');
  const c2 = await openClient('Client2');
  await Promise.all([enterLobby(c1, 'QA_Alpha'), enterLobby(c2, 'QA_Bravo')]);
  await createTdmRoom(c1, roomName);
  await joinRoomByName(c2, roomName);
  await Promise.all([prepClient(c1), prepClient(c2)]);
  await c2.eval(`window.__SET_RAF_CAP_FPS__?.(30)`);
  const [m1, m2] = await Promise.all([c1.eval(`window.__DEV_GAME_TOOLS__.getWorldMeta()`), c2.eval(`window.__DEV_GAME_TOOLS__.getWorldMeta()`)]);
  const worldMatch = m1.mapId === m2.mapId && m1.worldVersion === m2.worldVersion && m1.gameplayHash === m2.gameplayHash && m1.publicLayoutSeed === SEED && m2.publicLayoutSeed === SEED;
  log(`  worldMeta C1=${m1.mapId} v${m1.worldVersion} ${m1.gameplayHash} seed=${m1.publicLayoutSeed} | C2=${m2.mapId} v${m2.worldVersion} ${m2.gameplayHash} → match=${worldMatch}`);
  await delay(1500);
  const id1 = await selfId(c1);
  const id2 = await selfId(c2);

  // movement sync: 1P then 3P wander with periodic jumps; compare C2's view of C1 with C1's own snapshot
  const syncSamples = [];
  for (const view of ['1P', '3P']) {
    await Promise.all([c1.eval(`window.__DEV_GAME_TOOLS__.setThirdPerson(${view === '3P'})`), c2.eval(`window.__DEV_GAME_TOOLS__.setThirdPerson(${view === '3P'})`)]);
    await Promise.all([startWander(c1, 0.3), startWander(c2, 2.1)]);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      await delay(400);
      const [a1, b1, a2, b2, d1, d2] = await Promise.all([snapPos(c1, id1), snapPos(c2, id1), snapPos(c2, id2), snapPos(c1, id2), c1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().divergenceM`), c2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().divergenceM`)]);
      if (a1 && b1 && a2 && b2) {
        syncSamples.push({
          view,
          c1SelfVsC2View: r3(Math.hypot(a1.x - b1.x, a1.y - b1.y, a1.z - b1.z)),
          c2SelfVsC1View: r3(Math.hypot(a2.x - b2.x, a2.y - b2.y, a2.z - b2.z)),
          tickDelta: a1.tick !== null && b1.tick !== null ? a1.tick - b1.tick : null,
          c1y: r3(a1.y),
          c2y: r3(a2.y),
          c1PredDivergence: d1,
          c2PredDivergence: d2,
        });
      }
    }
    await Promise.all([stopWander(c1), stopWander(c2)]);
    await c1.screenshot(`10_smoke_c1_${view.toLowerCase()}.png`);
    await c2.screenshot(`10_smoke_c2_${view.toLowerCase()}.png`);
  }
  await delay(600);
  // settled: both clients idle → must agree tightly
  const [s1a, s1b, s2a, s2b] = await Promise.all([snapPos(c1, id1), snapPos(c2, id1), snapPos(c2, id2), snapPos(c1, id2)]);
  const settled = {
    c1: s1a && s1b ? r3(Math.hypot(s1a.x - s1b.x, s1a.y - s1b.y, s1a.z - s1b.z)) : null,
    c2: s2a && s2b ? r3(Math.hypot(s2a.x - s2b.x, s2a.y - s2b.y, s2a.z - s2b.z)) : null,
  };
  const yRange = (k) => {
    const ys = syncSamples.map((s) => s[k]);
    return ys.length ? r3(Math.max(...ys) - Math.min(...ys)) : 0;
  };
  log(`  sync: samples=${syncSamples.length} max moving delta C1=${Math.max(0, ...syncSamples.map((s) => s.c1SelfVsC2View))} C2=${Math.max(0, ...syncSamples.map((s) => s.c2SelfVsC1View))} settled=${JSON.stringify(settled)}`);

  // server-authoritative walks to hard-object probes (nearest first) for each client
  const pickProbes = async (cdp, n, exclude) => {
    const d = await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
    const a = d.authoritativePos;
    const cands = poses.probes.filter((p) => !exclude.includes(p.id) && ['tent_enter', 'log_cross', 'stump_cross', 'rock_cross', 'cabin_wall', 'railing_cross', 'barrel_cross', 'cabin_stairs_loft'].includes(p.id));
    cands.sort((p, q) => Math.hypot(p.start.x - a.x, p.start.z - a.z) - Math.hypot(q.start.x - a.x, q.start.z - a.z));
    return cands.slice(0, n);
  };
  const serverProbes = [];
  const p1 = await pickProbes(c1, 2, []);
  const p2 = await pickProbes(c2, 2, p1.map((p) => p.id));
  const runList = async (cdp, list, who) => {
    for (const p of list) {
      await cdp.eval(`window.__DEV_GAME_TOOLS__.setThirdPerson(true)`);
      const r = await serverProbe(cdp, p);
      r.client = who;
      serverProbes.push(r);
      log(`  [server-probe ${who}] ${p.id} reachedStart=${r.reachedStart} ${r.outcome ?? ''} ${r.pass === undefined ? '' : r.pass ? 'PASS' : 'FAIL'}`);
      if (r.reachedStart) await cdp.screenshot(`11_server_probe_${who.toLowerCase()}_${p.id}.png`);
    }
  };
  await Promise.all([runList(c1, p1, 'C1'), runList(c2, p2, 'C2')]);

  // LOS helper between final positions + no soft-layer colliders (node side, ROOT world)
  const [f1, f2] = await Promise.all([snapPos(c1, id1), snapPos(c1, id2)]);
  let los = null;
  try {
    const helper = path.join(REPORT_DIR, 'qa_los_helper.ts');
    if (fs.existsSync(helper) && f1 && f2) {
      const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const out = spawnSync(process.execPath, [tsxCli, helper, ROOT, String(SEED), JSON.stringify({ a: f1, b: f2 })], { cwd: WORKSPACE, encoding: 'utf8', timeout: 120000 });
      los = out.status === 0 ? JSON.parse(out.stdout.trim().split('\n').pop()) : { error: (out.stderr || out.stdout).slice(-800), status: out.status };
    }
  } catch (e) {
    los = { error: String(e) };
  }

  const errors = {
    consoleErrors: [...c1.consoleErrors, ...c2.consoleErrors],
    pageExceptions: [...c1.pageExceptions, ...c2.pageExceptions],
    networkErrors: [...c1.networkErrors, ...c2.networkErrors],
  };
  c1.close();
  c2.close();
  const maxMoving = Math.max(0, ...syncSamples.map((s) => Math.max(s.c1SelfVsC2View, s.c2SelfVsC1View)));
  return {
    roomName,
    mode: 'tdm',
    worldMeta: { c1: m1, c2: m2, match: worldMatch },
    ids: { c1: id1, c2: id2 },
    sync: { samples: syncSamples, maxMovingDeltaM: r3(maxMoving), settledDeltaM: settled, c1JumpYRange: yRange('c1y'), c2JumpYRange: yRange('c2y') },
    serverProbes,
    los,
    errors,
    passed: worldMatch && settled.c1 !== null && settled.c1 < 0.05 && settled.c2 !== null && settled.c2 < 0.05 && errors.pageExceptions.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------
// PHASE: report (BEFORE/AFTER comparison json)
// ---------------------------------------------------------------------------------------------
function phaseReport() {
  const read = (n) => {
    const f = path.join(REPORT_DIR, n);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  const before = read('qa_before.json');
  const after = read('qa_after.json');
  const perfRows = [];
  for (const s of after?.perf ?? before?.perf ?? []) {
    const b = before?.perf?.find((x) => x.scene === s.scene) ?? null;
    const a = after?.perf?.find((x) => x.scene === s.scene) ?? null;
    perfRows.push({ scene: s.scene, before: b && pick(b), after: a && pick(a) });
  }
  function pick(r) {
    return { fpsMedian: r.fpsMedian, fpsP10: r.fpsP10, fps1PctLow: r.fps1PctLow, frameTimeP95Ms: r.frameTimeP95Ms, frameTimeP99Ms: r.frameTimeP99Ms, calls: r.calls, triangles: r.triangles, heapUsedMB: r.heapUsedMB, groundCover: r.groundCover, severeSpike: r.severeSpike, deep: r.deep ? { fpsMedian: r.deep.fpsMedian, fpsP10: r.deep.fpsP10, fps1PctLow: r.deep.fps1PctLow, frameTimeP95Ms: r.deep.frameTimeP95Ms, frameTimeP99Ms: r.deep.frameTimeP99Ms } : null };
  }
  const probeRows = (after?.probes ?? before?.probes ?? []).map((p) => ({
    id: p.id,
    before: before?.probes?.find((x) => x.id === p.id)?.outcome ?? null,
    beforePass: before?.probes?.find((x) => x.id === p.id)?.pass ?? null,
    after: after?.probes?.find((x) => x.id === p.id)?.outcome ?? null,
    afterPass: after?.probes?.find((x) => x.id === p.id)?.pass ?? null,
  }));
  const summary = {
    stage: 'STAGE 08-FIX — Collision, Terrain & Forest Ground Cover (QA, agent F)',
    generatedAt: new Date().toISOString(),
    before: before && { meta: before.meta, worldMeta: before.worldMeta, environment: before.environment },
    after: after && { meta: after.meta, worldMeta: after.worldMeta, environment: after.environment },
    shots: { before: before?.shots?.map((s) => ({ file: s.path, stats: s.stats?.gcParsed ?? null, render: s.stats?.render ?? null })), after: after?.shots?.map((s) => ({ file: s.path, stats: s.stats?.gcParsed ?? null, render: s.stats?.render ?? null })) },
    probes: probeRows,
    perf: perfRows,
    smoke: after?.smoke ?? null,
    smokeBefore: before?.smoke ?? null,
  };
  fs.writeFileSync(path.join(REPORT_DIR, 'qa_summary.json'), JSON.stringify(summary, null, 2));
  log(`wrote ${path.join(REPORT_DIR, 'qa_summary.json')}`);
  return summary;
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
async function main() {
  if (PHASE === 'report') {
    phaseReport();
    return 0;
  }
  const poses = loadPoses();
  const outFile = path.join(REPORT_DIR, `qa_${LABEL}.json`);
  const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
  const result = { ...prev };
  result.meta = {
    label: LABEL,
    root: ROOT,
    phaseRequested: PHASE,
    ports: { server: PORT, vite: VITE_PORT, chromeDebug: DEBUG_PORT },
    viewport: '1280x720',
    dpr: 1,
    quality: 'medium',
    seed: SEED,
    posesFile: path.relative(WORKSPACE, POSES_PATH),
    posesGeneratedFrom: poses.generatedFrom,
    timestamp: new Date().toISOString(),
    command: `node ${path.relative(WORKSPACE, fileURLToPath(import.meta.url))} ${process.argv.slice(2).join(' ')}`,
  };
  let exitCode = 0;
  let services;
  try {
    services = await startServices();
    const cpus = os.cpus();
    result.environment = {
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      cpuModel: cpus[0]?.model ?? 'unknown',
      cpuCores: cpus.length,
      totalRamGB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
      nodeVersion: process.version,
      chromeVersion: services.versionInfo.Browser,
      headless: !HEADFUL,
    };

    if (PHASE === 'shots' || PHASE === 'perf' || PHASE === 'all') {
      const cdp = await openClient('Client1');
      await enterLobby(cdp, 'QA_Shots');
      await createTdmRoom(cdp, `S08FIX_${LABEL}_shots_${Date.now().toString().slice(-4)}`);
      await prepClient(cdp);
      result.environment.gpu = await gpuInfo(cdp);
      result.worldMeta = await cdp.eval(`window.__DEV_GAME_TOOLS__.getWorldMeta()`);
      log(`worldMeta: ${JSON.stringify(result.worldMeta)}`);
      log(`gpu: ${JSON.stringify(result.environment.gpu)}`);
      if (result.worldMeta.publicLayoutSeed !== SEED || result.worldMeta.mapId !== 'forest_square') throw new Error(`wrong world: ${JSON.stringify(result.worldMeta)}`);
      if (PHASE === 'shots' || PHASE === 'all') {
        const r = await phaseShots(cdp, poses);
        result.shots = r.shots;
        result.probes = r.probes;
      }
      if (PHASE === 'perf' || PHASE === 'all') {
        result.perf = await phasePerf(cdp, poses);
        writePerfCsv(result.perf, path.join(REPORT_DIR, `qa_${LABEL}_perf.csv`));
      }
      result.errors = { consoleErrors: cdp.consoleErrors, consoleWarnings: cdp.consoleWarnings, pageExceptions: cdp.pageExceptions, networkErrors: cdp.networkErrors };
      cdp.close();
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${cdp.targetId}`).catch(() => {});
    }
    if (PHASE === 'smoke' || PHASE === 'all') {
      result.smoke = await phaseSmoke(poses, services.versionInfo);
    }
  } catch (e) {
    console.error(`[08FIX QA ${LABEL}] FAILED:`, e);
    result.fatalError = String(e?.stack ?? e);
    exitCode = 1;
  } finally {
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    log(`wrote ${outFile}`);
    await stopServices();
  }
  if (exitCode === 0 && STRICT) {
    const fails = [];
    for (const p of result.probes ?? []) if (!p.pass) fails.push(`probe ${p.id}: ${p.outcome}`);
    if (result.smoke && !result.smoke.passed) fails.push('smoke not passed');
    if ((result.errors?.pageExceptions?.length ?? 0) > 0) fails.push(`pageExceptions=${result.errors.pageExceptions.length}`);
    if (fails.length) {
      console.error(`[08FIX QA ${LABEL}] STRICT gate failures:\n  - ${fails.join('\n  - ')}`);
      exitCode = 3;
    }
  }
  return exitCode;
}

main().then((code) => process.exit(code));
