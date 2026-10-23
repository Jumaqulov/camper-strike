#!/usr/bin/env node
/**
 * BOSQICH 08A — OUTDOOR-ASSET-01 Tashqi Muhit 3D Modellarini (`wooden_signpost_01`,
 * `lumber_stack_01`, `sawhorse_01`, `old_fuel_pump_01`, `rusty_barrel_01`, `forest_tent_01`,
 * `campfire_pit_01`, `wooden_railing_01`) O'yin Dunyosiga Integratsiya Qilish
 *
 * Browser QA Automation, 2-Client `forest_survival` Live Verification (36 GLB Assets,
 * 42 Outdoor Placements, 15 Instanced Batches, 8 Uzbek Signposts, 3 Campfire Effects),
 * 9 Real WebGL Screenshots (1280x720 PNG) & Performance Benchmark Script
 *
 * Usage:
 *   node scripts/qa-stage08a.mjs [--warmup=5] [--duration=15] [--repeats=2]
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

const WARMUP_SEC = Number(args.warmup ?? 5);
const DURATION_SEC = Number(args.duration ?? 15);
const REPEATS = Number(args.repeats ?? 2);

const ROOT_DIR = process.cwd();
const SCREENSHOT_DIR = path.join(ROOT_DIR, 'docs', 'screenshots', 'stage08a');
const REPORT_DIR = path.join(ROOT_DIR, 'docs', 'stage08a');
const SUMMARY_JSON_PATH = path.join(REPORT_DIR, 'qa_summary.json');
const BENCHMARK_CSV_PATH = path.join(REPORT_DIR, 'qa_benchmark.csv');
const PARENT_ARTIFACT_DIR =
  'C:\\Users\\Developartwo\\.gemini\\antigravity\\brain\\d6f310b6-6eb8-49c8-82ec-df06c5e06168';

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

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
  constructor(wsUrl, label) {
    this.ws = new WebSocket(wsUrl);
    this.label = label;
    this.seq = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageExceptions = [];
    this.networkErrors = [];
    this.outdoorGlbResponses = [];
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
          this.consoleErrors.push({ client: this.label, text });
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const details = JSON.stringify(msg.params?.exceptionDetails ?? 'exception');
        this.pageExceptions.push({ client: this.label, details });
        this.consoleErrors.push({ client: this.label, text: details });
      } else if (msg.method === 'Network.responseReceived') {
        const status = msg.params?.response?.status ?? 200;
        const url = msg.params?.response?.url ?? '';
        if (url.includes('/models/outdoor/')) {
          this.outdoorGlbResponses.push({ client: this.label, status, url });
        }
        if (status >= 400) {
          this.networkErrors.push({ client: this.label, status, url });
        }
      } else if (msg.method === 'Network.loadingFailed') {
        const errText = msg.params?.errorText ?? '';
        if (errText && errText !== 'net::ERR_ABORTED') {
          this.networkErrors.push({ client: this.label, status: 'FAILED', errorText: errText });
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
      throw new Error(`Eval error (${this.label}): ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async waitFor(predicateExpr, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const val = await this.eval(predicateExpr);
      if (val) return val;
      await delay(120);
    }
    throw new Error(`Timed out waiting on ${this.label} for: ${predicateExpr}`);
  }

  async screenshot(filename) {
    await this.send('Page.bringToFront');
    await delay(160);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const outPath = path.join(SCREENSHOT_DIR, filename);
    fs.writeFileSync(outPath, buf);
    if (fs.existsSync(PARENT_ARTIFACT_DIR)) {
      fs.copyFileSync(outPath, path.join(PARENT_ARTIFACT_DIR, filename));
    }
    console.log(`  [screenshot] ${filename} (${width}x${height}, ${buf.length} bytes)`);
    return {
      filename,
      bytes: buf.length,
      width,
      height,
      path: `docs/screenshots/stage08a/${filename}`,
    };
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
    window.__GAME_WS__ = null;
    window.__CREATE_ROOM_OVERRIDES__ = null;

    window.WebSocket = class extends OrigWebSocket {
      constructor(...args) {
        super(...args);
        window.__GAME_WS__ = this;
        this.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string' && ev.data.startsWith('42[')) {
            try {
              const parsed = JSON.parse(ev.data.slice(2));
              if (Array.isArray(parsed) && parsed[0] === 'snap') {
                window.__LAST_SNAP__ = parsed[1];
              }
            } catch {
              // ignore malformed frame
            }
          }
        });
      }

      send(data) {
        if (typeof data === 'string' && data.startsWith('42')) {
          const bracketIdx = data.indexOf('[');
          if (bracketIdx > 2) {
            const prefix = data.slice(0, bracketIdx);
            try {
              const arr = JSON.parse(data.slice(bracketIdx));
              if (Array.isArray(arr) && arr[0] === 'createRoom' && window.__CREATE_ROOM_OVERRIDES__) {
                const merged = Object.assign({}, arr[1] || {}, window.__CREATE_ROOM_OVERRIDES__);
                window.__CREATE_ROOM_OVERRIDES__ = null;
                return super.send(prefix + JSON.stringify(['createRoom', merged]));
              }
            } catch {
              // ignore non-JSON frame
            }
          }
        }
        return super.send(data);
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

function buildRouteToRangerHouseCourtyard(startPos, poiSites) {
  const c1 = poiSites.poi_ranger_house.center;
  const target = { x: Number((c1.x + 2.2).toFixed(2)), z: Number((c1.z + 9.2).toFixed(2)), radius: 1.4 };
  const waypoints = [];

  for (const site of Object.values(poiSites)) {
    if (site.id === 'poi_ranger_house') continue;
    const d = Math.hypot(startPos.x - site.center.x, startPos.z - site.center.z);
    if (d < 19) {
      waypoints.push({
        x: Number(site.roadAnchor.x.toFixed(2)),
        z: Number(site.roadAnchor.z.toFixed(2)),
        radius: 2.0,
      });
      break;
    }
  }

  const last = waypoints[waypoints.length - 1] ?? startPos;
  if (last.x > -46 || last.z > -36) {
    if (Math.abs(last.x - -34) > 8 && last.z > -44) {
      waypoints.push({
        x: -34,
        z: Number(clamp(last.z, -50, 58).toFixed(2)),
        radius: 2.2,
      });
    }
    waypoints.push({ x: -34, z: -54, radius: 2.2 });
  } else if (last.z < c1.z + 2.5) {
    if (last.x < c1.x) {
      waypoints.push({ x: Number((c1.x - 9.5).toFixed(2)), z: Number((c1.z + 7.5).toFixed(2)), radius: 1.8 });
    } else {
      waypoints.push({ x: Number((c1.x + 8.5).toFixed(2)), z: Number((c1.z - 5.5).toFixed(2)), radius: 1.8 });
    }
  }

  waypoints.push(target);
  return waypoints;
}

async function walkClientWaypoints(cdp, label, waypoints, lookTarget = null, maxSegmentMs = 28000) {
  await cdp.eval(`
    window.__DEV_CAMERA_OVERRIDE__ = null;
    window.__DEV_PLAYER_POSE_LOCK__ = null;
    window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
  `);

  for (let wIdx = 0; wIdx < waypoints.length; wIdx++) {
    const wp = waypoints[wIdx];
    const stopRadius = wp.radius ?? 0.55;
    const isFinal = wIdx === waypoints.length - 1;
    const segStart = Date.now();
    let checkTime = Date.now();
    let checkPos = (await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    let detourCount = 0;

    while (Date.now() - segStart < maxSegmentMs) {
      const diag = await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
      const pos = diag.authoritativePos ?? diag.predictedPos;
      const dx = wp.x - pos.x;
      const dz = wp.z - pos.z;
      const dist = Math.hypot(dx, dz);

      if (dist <= stopRadius) {
        break;
      }

      const now = Date.now();
      if (now - checkTime >= 260) {
        const moved = checkPos ? Math.hypot(pos.x - checkPos.x, pos.z - checkPos.z) : 1;
        checkPos = { x: pos.x, y: pos.y, z: pos.z };
        checkTime = now;

        if (moved < 0.42 && dist > stopRadius + 0.25) {
          detourCount++;
          const sign = detourCount % 2 === 1 ? 1 : -1;
          const baseYaw = Math.atan2(-dx, -dz);
          const detourYaw = baseYaw + sign * 1.18;
          await cdp.eval(`
            window.__DEV_GAME_TOOLS__.setSyntheticInput({
              fwd: 1,
              right: ${(sign * 0.45).toFixed(2)},
              jump: true,
              walk: false,
              yaw: ${detourYaw.toFixed(4)},
              pitch: -0.1
            })
          `);
          await delay(360);
          continue;
        }
      }

      const yaw = Math.atan2(-dx, -dz);
      const slowDown = isFinal && dist < 1.35;
      const fwd = isFinal && dist < 0.85 ? clamp(dist / 0.85, 0.35, 1) : 1;
      await cdp.eval(`
        window.__DEV_GAME_TOOLS__.setSyntheticInput({
          fwd: ${fwd.toFixed(3)},
          right: 0,
          jump: false,
          walk: ${slowDown ? 'true' : 'false'},
          yaw: ${yaw.toFixed(4)},
          pitch: -0.12
        })
      `);
      await delay(48);
    }
  }

  const finalDiag0 = await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
  const finalPos0 = finalDiag0.authoritativePos ?? finalDiag0.predictedPos;
  let finalYaw = 0;
  let finalPitch = -0.12;
  if (lookTarget) {
    const eye = { x: finalPos0.x, y: finalPos0.y + 1.62, z: finalPos0.z };
    const cam = lookAtCamera(eye, lookTarget);
    finalYaw = cam.yaw;
    finalPitch = clamp(cam.pitch, -0.65, 0.45);
  }

  await cdp.eval(`
    window.__DEV_GAME_TOOLS__.setSyntheticInput({
      fwd: 0,
      right: 0,
      jump: false,
      walk: false,
      yaw: ${finalYaw.toFixed(4)},
      pitch: ${finalPitch.toFixed(4)}
    })
  `);
  await delay(180);
  await cdp.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
  await delay(180);

  const settledDiag = await cdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`);
  const lastWp = waypoints[waypoints.length - 1];
  const finalDist = Math.hypot(
    settledDiag.authoritativePos.x - lastWp.x,
    settledDiag.authoritativePos.z - lastWp.z,
  );
  console.log(
    `  [walk ${label}] authPos=(${settledDiag.authoritativePos.x.toFixed(2)}, ${settledDiag.authoritativePos.y.toFixed(2)}, ${settledDiag.authoritativePos.z.toFixed(2)}) distToTarget=${finalDist.toFixed(2)}m divergence=${settledDiag.divergenceM}m`,
  );
  return { diag: settledDiag, finalYaw, finalPitch };
}

async function openNewClientTab(debugPort, label, url = 'http://localhost:5173') {
  const newTargetRes = await fetch(`http://127.0.0.1:${debugPort}/json/new?${url}`, {
    method: 'PUT',
  });
  const pageTarget = await newTargetRes.json();
  const cdp = new CdpSession(pageTarget.webSocketDebuggerUrl, label);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_INIT_HOOK_SOURCE });
  await cdp.send('Page.reload');
  return { cdp, targetId: pageTarget.id };
}

async function injectCleanHudStyles(cdp) {
  await cdp.eval(`
    (() => {
      if (!document.getElementById('qa-stage08a-clean-hud')) {
        const st = document.createElement('style');
        st.id = 'qa-stage08a-clean-hud';
        st.textContent = '#pause-menu, #center-msg, #scoreboard, #death-screen, #toast { display: none !important; } #dev-stats { display: block !important; }';
        document.head.appendChild(st);
      }
      window.__DEV_GAME_TOOLS__?.setQuality('medium');
    })()
  `);
}

async function main() {
  const chromePath = findChromePath();
  const debugPort = 9258;
  const roomName = `Stage08A_Outdoor_${Date.now().toString().slice(-4)}`;
  console.log(
    `[Stage 08A QA] Starting OUTDOOR-ASSET-01 Browser QA, 9 Screenshots & Performance Benchmark (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS})...`,
  );

  let serverProc = null;
  const serverAlreadyRunning = await isHttpReady('http://localhost:5173/api/info', 1500);
  if (!serverAlreadyRunning) {
    console.log('[Stage 08A QA] Starting dev server (`npm run dev`)...');
    serverProc = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
      cwd: ROOT_DIR,
      stdio: 'pipe',
    });
  } else {
    console.log('[Stage 08A QA] Reusing active dev server on http://localhost:5173');
  }

  const userDataDir = path.join(os.tmpdir(), `stickman_qa_stage08a_${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  let chromeProc = null;
  try {
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

    const cdp1 = new CdpSession(pageTarget1.webSocketDebuggerUrl, 'Client1');
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

    const { cdp: cdp2, targetId: pageTarget2Id } = await openNewClientTab(debugPort, 'Client2');

    // =========================================================================
    // STEP 1: Launch 2 Clients in `forest_survival` Room on `forest_square` (`seed=6501`)
    //         and Verify All 36 GLB Assets + 42 Outdoor Placements
    // =========================================================================
    console.log('\n[Stage 08A QA] Step 1: Connecting Client 1 & Client 2 to Lobby...');
    await Promise.all([
      cdp1.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`),
      cdp2.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`),
    ]);

    await Promise.all([
      cdp1.eval(
        `(() => { document.getElementById('name-input').value = 'Ranger_Alpha'; document.getElementById('btn-enter').click(); })()`,
      ),
      cdp2.eval(
        `(() => { document.getElementById('name-input').value = 'Scout_Bravo'; document.getElementById('btn-enter').click(); })()`,
      ),
    ]);

    await Promise.all([
      cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`),
      cdp2.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`),
    ]);

    console.log(
      `  [room-create] Client 1 creating forest_survival room '${roomName}' (mapId='forest_square', seed=6501, countdownSec=4)...`,
    );
    await cdp1.eval(`
      (() => {
        window.__CREATE_ROOM_OVERRIDES__ = { publicLayoutSeed: 6501, countdownSec: 4 };
        const modeEl = document.getElementById('room-mode');
        modeEl.value = 'forest_survival';
        modeEl.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('room-name').value = '${roomName}';
        document.getElementById('room-time').value = '30';
        document.getElementById('btn-create').click();
      })()
    `);

    await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().match?.phase === 'waiting'`);

    console.log('  [room-join] Client 2 joining before countdown finishes...');
    await cdp2.eval(`document.getElementById('btn-refresh')?.click()`);
    const joinScript = `
      (() => {
        const items = Array.from(document.querySelectorAll('.room-item'));
        const matchItem = items.find((el) => el.textContent?.includes('${roomName}'));
        const btn = matchItem?.querySelector('[data-join]');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `;
    await cdp2.waitFor(joinScript);
    await cdp2.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);

    await Promise.all([injectCleanHudStyles(cdp1), injectCleanHudStyles(cdp2)]);

    // Wait for all 36 GLB assets (4 weapon + 7 forest + 17 stage04a + 8 outdoor) to finish loading on both clients
    const waitAll36GlbsExpr = `
      (() => {
        const w = window.__DEV_GAME_TOOLS__.getDiagnostics();
        const f = window.__DEV_GAME_TOOLS__.getForestDiagnostics();
        const s = window.__DEV_GAME_TOOLS__.getStage04ADiagnostics();
        const o = window.__DEV_GAME_TOOLS__.getOutdoorDiagnostics();
        const wOk = Object.values(w).every((d) => d.loaded && !d.failed && !d.isFallback);
        const fOk = Object.values(f).every((d) => d.loaded && !d.failed && !d.isFallback);
        const oOk = o.allLoaded && o.renderer?.allGlbLoaded === true;
        return wOk && fOk && s.allLoaded && oOk;
      })()
    `;
    await Promise.all([cdp1.waitFor(waitAll36GlbsExpr, 25000), cdp2.waitFor(waitAll36GlbsExpr, 25000)]);

    // Wait for Round 1 (`playing`, `roundId === 1`) to start on both clients
    console.log('  [round-1] Waiting for countdown to finish and Round 1 (`playing`, `roundId=1`) to start...');
    await Promise.all([
      cdp1.waitFor(
        `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 1`,
        20000,
      ),
      cdp2.waitFor(
        `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 1`,
        20000,
      ),
    ]);
    await delay(250);

    const [
      c1WorldMeta,
      c2WorldMeta,
      c1WeaponDiag,
      c1ForestDiag,
      c1Stage04ADiag,
      c1OutdoorDiag,
      c2OutdoorDiag,
    ] = await Promise.all([
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getWorldMeta()`),
      cdp2.eval(`window.__DEV_GAME_TOOLS__.getWorldMeta()`),
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getDiagnostics()`),
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getForestDiagnostics()`),
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics()`),
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getOutdoorDiagnostics()`),
      cdp2.eval(`window.__DEV_GAME_TOOLS__.getOutdoorDiagnostics()`),
    ]);

    const weaponCount = Object.keys(c1WeaponDiag).length;
    const forestCount = Object.keys(c1ForestDiag).length;
    const buildingCount = Object.keys(c1Stage04ADiag.buildings).length;
    const interiorCount = Object.keys(c1Stage04ADiag.interiors).length;
    const containerCount = Object.keys(c1Stage04ADiag.containers).length;
    const outdoorCount = Object.keys(c1OutdoorDiag.assets).length;
    const totalGlbCount =
      weaponCount + forestCount + buildingCount + interiorCount + containerCount + outdoorCount;

    if (
      c1WorldMeta.mapId !== 'forest_square' ||
      c1WorldMeta.publicLayoutSeed !== 6501 ||
      c1WorldMeta.gameplayHash !== c2WorldMeta.gameplayHash ||
      totalGlbCount !== 36 ||
      !c1OutdoorDiag.allLoaded ||
      !c2OutdoorDiag.allLoaded ||
      c1OutdoorDiag.renderer?.totalPlacements !== 42 ||
      c1OutdoorDiag.renderer?.instancedBatchCount > 16 ||
      c1OutdoorDiag.renderer?.signpostOverlayCount !== 8 ||
      c1OutdoorDiag.renderer?.campfireEffectCount !== 3
    ) {
      throw new Error(
        `Stage 08A asset/renderer verification failed: ${JSON.stringify({
          c1WorldMeta,
          c2WorldMeta,
          totalGlbCount,
          c1OutdoorDiag,
          c2OutdoorDiag,
        })}`,
      );
    }

    console.log(
      `  [verified] WorldMeta: mapId='${c1WorldMeta.mapId}', seed=${c1WorldMeta.publicLayoutSeed}, gameplayHash='${c1WorldMeta.gameplayHash}' (Client 1 === Client 2)`,
    );
    console.log(
      `  [verified] All ${totalGlbCount} GLB assets loaded without fallback (${weaponCount} weapon + ${forestCount} forest + ${buildingCount} building + ${interiorCount} interior + ${containerCount} container + ${outdoorCount} outdoor)!`,
    );
    console.log(
      `  [verified] OutdoorRenderer: totalPlacements=${c1OutdoorDiag.renderer.totalPlacements}, instancedBatchCount=${c1OutdoorDiag.renderer.instancedBatchCount} (<=16), signpostOverlayCount=${c1OutdoorDiag.renderer.signpostOverlayCount}, campfireEffectCount=${c1OutdoorDiag.renderer.campfireEffectCount}.`,
    );

    // =========================================================================
    // STEP 2: Live Container Loot & Gameplay Smoke Test + Screenshot 09
    //         (Walk Client 1 & Client 2 to `poi_ranger_house`, open container,
    //          pick up weapon, verify equippedWeapon !== null, capture Shot 09)
    // =========================================================================
    console.log(
      '\n[Stage 08A QA] Step 2: Running Live Container Loot & Gameplay Smoke Test at `poi_ranger_house`...',
    );
    const poiSites = getForestSquarePoiSitesForSeed(c1WorldMeta.publicLayoutSeed);
    const c1Site = poiSites.poi_ranger_house.center;
    const cnt3Id = 'poi:poi_ranger_house:cnt_3:wooden_loot_crate_01';
    const cnt1Id = 'poi:poi_ranger_house:cnt_1:metal_locker_01';

    const r1LootInit = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    const cnt3StateInit = r1LootInit.lootSnapshot.containers.find((c) => c.id === cnt3Id);
    if (!cnt3StateInit) {
      throw new Error(`Container ${cnt3Id} not found in lootSnapshot`);
    }

    const [c1SpawnPos, c2SpawnPos] = await Promise.all([
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos`),
      cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos`),
    ]);

    await Promise.all([
      walkClientWaypoints(
        cdp1,
        'Client1->rangerYardCnt3',
        [
          ...buildRouteToRangerHouseCourtyard(c1SpawnPos, poiSites),
          {
            x: Number((cnt3StateInit.position.x - 0.15).toFixed(2)),
            z: Number((cnt3StateInit.position.z + 1.35).toFixed(2)),
            radius: 0.36,
          },
        ],
        { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 0.95, z: cnt3StateInit.position.z },
      ),
      walkClientWaypoints(
        cdp2,
        'Client2->rangerYardGuard',
        [
          ...buildRouteToRangerHouseCourtyard(c2SpawnPos, poiSites),
          {
            x: Number((c1Site.x + 1.4).toFixed(2)),
            z: Number((c1Site.z + 5.8).toFixed(2)),
            radius: 0.42,
          },
        ],
        { x: cnt3StateInit.position.x + 1.2, y: cnt3StateInit.position.y + 1.0, z: cnt3StateInit.position.z },
      ),
    ]);

    const openCnt3Ack = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 'stage08a_c1_open_cnt3')`,
    );
    if (!openCnt3Ack?.ok || !openCnt3Ack.container?.opened || !openCnt3Ack.container.items?.length) {
      throw new Error(`openContainerById(${cnt3Id}) failed: ${JSON.stringify(openCnt3Ack)}`);
    }

    const pickedItems = [];
    const weaponItem =
      openCnt3Ack.container.items.find((it) => it.kind === 'weapon') ?? openCnt3Ack.container.items[0];
    if (weaponItem) {
      const pickAck = await cdp1.eval(
        `window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${weaponItem.id}', 'stage08a_c1_pick_${weaponItem.id}')`,
      );
      if (pickAck?.ok && pickAck.pickedItem) {
        pickedItems.push(pickAck.pickedItem);
      }
    }

    let c1LootAfterPick = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    if (!c1LootAfterPick.inventorySnap?.equippedWeapon && c1LootAfterPick.inventorySnap?.ownedWeapons?.length) {
      await cdp1.eval(
        `window.__DEV_GAME_TOOLS__.equipInventoryWeapon('${c1LootAfterPick.inventorySnap.ownedWeapons[0]}', 'stage08a_c1_equip')`,
      );
      await delay(520);
      c1LootAfterPick = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    }
    if (!c1LootAfterPick.inventorySnap?.equippedWeapon) {
      throw new Error(
        `Expected Client 1 equippedWeapon !== null after looting ${cnt3Id}, got: ${JSON.stringify(c1LootAfterPick.inventorySnap)}`,
      );
    }

    console.log(
      `  [verified] Live Container Loot Smoke Test: opened '${cnt3Id}', picked [${pickedItems.map((i) => i.catalogId).join(', ')}], equippedWeapon='${c1LootAfterPick.inventorySnap.equippedWeapon}'.`,
    );

    // Uncap Client 1 RAF so DEV overlay and benchmarks run at full uncapped WebGL frame rate;
    // cap Client 2 RAF to 15 FPS so background tab does not contend for GPU
    await cdp1.eval(`window.__SET_RAF_CAP_FPS__?.(null)`);
    await cdp2.eval(`window.__SET_RAF_CAP_FPS__?.(15)`);
    await cdp1.send('Page.bringToFront');

    // Frame Screenshot 09 (`09_survival_loot_and_combat_with_outdoor_props.png`) showing live 2-client
    // `forest_survival` gameplay with opened container + 3D loot item, equipped weapon, and outdoor GLB props
    const cam09 = lookAtCamera(
      { x: c1Site.x - 6.8, y: cnt3StateInit.position.y + 2.55, z: c1Site.z + 8.0 },
      { x: c1Site.x + 1.8, y: cnt3StateInit.position.y + 1.0, z: c1Site.z + 0.8 },
    );
    await cdp1.eval(`
      (() => {
        document.getElementById('loot-panel-close')?.click();
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam09)};
      })()
    `);
    await delay(550);
    const shot09Info = await cdp1.screenshot('09_survival_loot_and_combat_with_outdoor_props.png');

    // =========================================================================
    // STEP 3: Capture Screenshots 01..08 Across All 6 POIs & Central Crossroads
    // =========================================================================
    console.log('\n[Stage 08A QA] Step 3: Capturing 8 deterministic POI & Crossroads screenshots...');
    const screenshots = [];

    const captureWithSetup = async (filename, setupJs, waitMs = 500) => {
      await cdp1.eval(setupJs);
      await delay(waitMs);
      const info = await cdp1.screenshot(filename);
      screenshots.push(info);
    };

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

    // 1. `01_topdown_256x256_stage08a_overview.png` — Top-down overview of `forest_square` (256x256m, 6 POIs + crossroads + 42 outdoor GLBs)
    const cam01 = lookAtCamera({ x: 0, y: 175, z: 95 }, { x: 0, y: 0, z: -10 });
    await captureWithSetup(
      '01_topdown_256x256_stage08a_overview.png',
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

    // 2. `02_crossroads_wooden_signpost_uz.png` — Close-up / 3P view at `loc_sq_central_crossroads`
    //    showing `wooden_signpost_01.glb` (`crossroads:out_0:wooden_signpost_01` at (-12.735, 3.348), yaw=0.4)
    //    with Uzbek directional text boards (`MARKAZIY CHORRAHA`, `ARRAKORLIK 65m`, `O'RMONCHI 85m`, `KEMPER LAGERI 80m`)
    const signX = -12.735;
    const signZ = 3.348;
    const crSignPos = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.setPlayerPos(${signX}, ${signZ}, 0)`,
    );
    const crSignY = Number(crSignPos.y.toFixed(3));
    const signYaw = 0.4;
    const fwdX = Math.sin(signYaw);
    const fwdZ = Math.cos(signYaw);
    const rightX = Math.cos(signYaw);
    const rightZ = -Math.sin(signYaw);
    const cam02 = lookAtCamera(
      {
        x: signX + fwdX * 2.55 + rightX * 0.25,
        y: crSignY + 1.55,
        z: signZ + fwdZ * 2.55 + rightZ * 0.25,
      },
      {
        x: signX - rightX * 0.25,
        y: crSignY + 1.18,
        z: signZ - rightZ * 0.25,
      },
    );
    await captureWithSetup(
      '02_crossroads_wooden_signpost_uz.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${(signX - rightX * 1.25 - fwdX * 0.35).toFixed(2)}, ${(signZ - rightZ * 1.25 - fwdZ * 0.35).toFixed(2)}, ${(signYaw - 0.45).toFixed(4)});
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam02)};
      `,
      550,
    );

    // 3. `03_poi1_ranger_house_railing_and_lumber.png` — `poi_ranger_house` showing `wooden_signpost_01`,
    //    `wooden_railing_01` terrace railings, `lumber_stack_01`, and `rusty_barrel_01`
    const cam03 = lookAtCamera(
      { x: p1.center.x - 8.4, y: p1.terrainY + 2.65, z: p1.center.z + 8.2 },
      { x: p1.center.x + 0.6, y: p1.terrainY + 1.05, z: p1.center.z - 0.6 },
    );
    await captureWithSetup(
      '03_poi1_ranger_house_railing_and_lumber.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${(p1.center.x - 3.6).toFixed(2)}, ${(p1.center.z + 3.8).toFixed(2)}, 2.55);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam03)};
      `,
      550,
    );

    // 4. `04_poi2_cabin_cluster_courtyard_campfire.png` — `poi_cabin_cluster` central courtyard showing
    //    `campfire_pit_01` (with stylized low-poly flame), `wooden_railing_01`, `rusty_barrel_01`, and rotated cabins
    const cam04 = lookAtCamera(
      { x: p2.center.x + 1.4, y: p2.terrainY + 2.45, z: p2.center.z + 7.6 },
      { x: p2.center.x + 0.4, y: p2.terrainY + 0.95, z: p2.center.z - 3.0 },
    );
    await captureWithSetup(
      '04_poi2_cabin_cluster_courtyard_campfire.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${(p2.center.x - 1.2).toFixed(2)}, ${(p2.center.z + 2.2).toFixed(2)}, 2.85);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam04)};
      `,
      550,
    );

    // 5. `05_poi3_lumber_mill_stacks_and_sawhorses.png` — `poi_lumber_mill` timber yard showing
    //    3 `lumber_stack_01`, 3 `sawhorse_01`, upright & tipped `rusty_barrel_01`, and `wooden_signpost_01`
    const cam05 = lookAtCamera(
      { x: p3.center.x + 10.6, y: p3.terrainY + 3.15, z: p3.center.z + 8.8 },
      { x: p3.center.x + 2.2, y: p3.terrainY + 0.85, z: p3.center.z - 2.6 },
    );
    await captureWithSetup(
      '05_poi3_lumber_mill_stacks_and_sawhorses.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('shotgun');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${(p3.center.x + 3.2).toFixed(2)}, ${(p3.center.z + 2.2).toFixed(2)}, -2.45);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam05)};
      `,
      550,
    );

    // 6. `06_poi4_service_station_fuel_pumps_and_barrels.png` — `poi_service_station` forecourt showing
    //    the 2 vintage red-and-cream `old_fuel_pump_01` GLB pumps on the concrete island, 4 `rusty_barrel_01` (upright & tipped), and `sawhorse_01`
    const cam06 = lookAtCamera(
      { x: p4.center.x + 2.4, y: p4.terrainY + 2.45, z: p4.center.z + 7.4 },
      { x: p4.center.x - 3.6, y: p4.terrainY + 0.95, z: p4.center.z - 0.6 },
    );
    await captureWithSetup(
      '06_poi4_service_station_fuel_pumps_and_barrels.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('rifle');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${(p4.center.x - 3.8).toFixed(2)}, ${(p4.center.z + 1.8).toFixed(2)}, 2.45);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam06)};
      `,
      550,
    );

    // 7. `07_poi5_forest_camp_tents_and_campfire.png` — `poi_forest_camp` showing the 2 green A-frame
    //    `forest_tent_01` GLB tents (with open `+Z` entrance), central `campfire_pit_01`, `lumber_stack_01`, and `rusty_barrel_01`
    const cam07 = lookAtCamera(
      { x: p5.center.x - 3.8, y: p5.terrainY + 2.45, z: p5.center.z + 3.8 },
      { x: p5.center.x + 1.8, y: p5.terrainY + 0.95, z: p5.center.z - 3.8 },
    );
    await captureWithSetup(
      '07_poi5_forest_camp_tents_and_campfire.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('sniper');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${(p5.center.x - 1.4).toFixed(2)}, ${(p5.center.z - 1.8).toFixed(2)}, 2.55);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam07)};
      `,
      550,
    );

    // 8. `08_poi6_cliff_watch_chained_railings_and_fire.png` — `poi_cliff_watch` showing the chained
    //    `wooden_railing_01` cliff-edge barriers, `campfire_pit_01`, `wooden_signpost_01`, and 2-story watchpost
    const cam08 = lookAtCamera(
      { x: p6.center.x - 6.2, y: p6.terrainY + 3.05, z: p6.center.z + 10.8 },
      { x: p6.center.x - 1.2, y: p6.terrainY + 1.35, z: p6.center.z + 0.6 },
    );
    await captureWithSetup(
      '08_poi6_cliff_watch_chained_railings_and_fire.png',
      `
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setWeapon('sniper');
        window.__DEV_GAME_TOOLS__.setPlayerPos(${(p6.center.x + 1.4).toFixed(2)}, ${(p6.center.z + 3.2).toFixed(2)}, -2.55);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam08)};
      `,
      550,
    );

    // Append Screenshot 09 in canonical order 01..09
    screenshots.push(shot09Info);

    // =========================================================================
    // STEP 4: Concise Performance Benchmark (`warmup=5s, duration=15s, repeats=2`)
    //         Across 4 Key Stage 08A Scenes in `medium` Quality
    // =========================================================================
    console.log(
      `\n[Stage 08A QA] Step 4: Running performance benchmark (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS}) across 4 scenes...`,
    );

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

    const benchmarkScenes = {};
    const csvRows = [];

    const runSceneBenchmark = async (quality, sceneId, description, setupFn, teardownFn) => {
      await cdp1.eval(`window.__DEV_GAME_TOOLS__.setQuality('${quality}')`);
      await delay(250);
      const runs = [];
      for (let rep = 1; rep <= REPEATS; rep++) {
        await cdp1.send('Page.bringToFront');
        await setupFn(rep);
        await delay(WARMUP_SEC * 1000);
        await cdp1.eval(`window.__DEV_GAME_TOOLS__.startBenchmarkCapture()`);
        await delay(DURATION_SEC * 1000);
        const res = await cdp1.eval(`
          (() => {
            const r = window.__DEV_GAME_TOOLS__.stopBenchmarkCapture();
            r.programs = typeof window.__GET_WEBGL_PROGRAMS_COUNT__ === 'function'
              ? window.__GET_WEBGL_PROGRAMS_COUNT__()
              : 0;
            r.outdoor = window.__DEV_GAME_TOOLS__.getOutdoorDiagnostics().renderer;
            return r;
          })()
        `);
        if (teardownFn) {
          await teardownFn();
        }
        runs.push({ repeat: rep, ...res });
        console.log(
          `  [${quality} | ${sceneId} #${rep}] frames=${res.frames} | avgFps=${res.fpsMean} p50Fps=${res.fpsMedian} 1%low=${res.fps1PctLow} | FT p50=${res.frameTimeMedianMs}ms p95=${res.frameTimeP95Ms}ms p99=${res.frameTimeP99Ms}ms | Draw=${res.render.calls} Tris=${res.render.triangles} | OutdoorVis=${res.outdoor?.visiblePlacements}/${res.outdoor?.totalPlacements}`,
        );
      }

      const fpsMean = Number(medianOf(runs.map((r) => r.fpsMean)).toFixed(2));
      const fpsMedian = Number(medianOf(runs.map((r) => r.fpsMedian)).toFixed(2));
      const fpsP10 = Number(medianOf(runs.map((r) => r.fpsP10)).toFixed(2));
      const fps1PctLow = Number(medianOf(runs.map((r) => r.fps1PctLow)).toFixed(2));
      const frameTimeMedianMs = Number(medianOf(runs.map((r) => r.frameTimeMedianMs)).toFixed(3));
      const frameTimeP95Ms = Number(medianOf(runs.map((r) => r.frameTimeP95Ms)).toFixed(3));
      const frameTimeP99Ms = Number(medianOf(runs.map((r) => r.frameTimeP99Ms)).toFixed(3));
      const cullCpuMedianMs = Number(medianOf(runs.map((r) => r.cullCpuMedianMs)).toFixed(4));
      const cullCpuP95Ms = Number(medianOf(runs.map((r) => r.cullCpuP95Ms)).toFixed(4));
      const lastRun = runs[runs.length - 1];

      const summary = {
        quality,
        scene: sceneId,
        description,
        warmupSeconds: WARMUP_SEC,
        measurementSeconds: DURATION_SEC,
        repeats: REPEATS,
        fpsMean,
        fpsMedian,
        fpsP10,
        fps1PctLow,
        frameTimeMedianMs,
        frameTimeP95Ms,
        frameTimeP99Ms,
        cullCpuMedianMs,
        cullCpuP95Ms,
        calls: lastRun.render.calls,
        sceneCalls: lastRun.render.sceneCalls,
        vmCalls: lastRun.render.vmCalls,
        triangles: lastRun.render.triangles,
        geometries: lastRun.render.geometries,
        textures: lastRun.render.textures,
        programs: lastRun.programs,
        outdoorRenderer: lastRun.outdoor,
        cullingProfile: lastRun.culling,
        heapUsedMB: lastRun.heapUsedMB,
        runs,
      };

      benchmarkScenes[sceneId] = summary;
      csvRows.push(summary);
    };

    // Scene 1: `open_forest_movement`
    await runSceneBenchmark(
      'medium',
      'open_forest_movement',
      'Active authoritative movement & camera sweep across central forest roads & signposts',
      async () => {
        await cdp1.eval(`
          (() => {
            if (window.__BENCH_MOVE_TIMER__) clearInterval(window.__BENCH_MOVE_TIMER__);
            window.__DEV_CAMERA_OVERRIDE__ = null;
            window.__DEV_PLAYER_POSE_LOCK__ = null;
            window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
            window.__DEV_GAME_TOOLS__.setThirdPerson(true);
            let tStep = 0;
            window.__BENCH_MOVE_TIMER__ = setInterval(() => {
              tStep += 0.05;
              window.__DEV_GAME_TOOLS__?.setSyntheticInput({
                fwd: Math.cos(tStep * 0.4) >= -0.2 ? 1 : -1,
                right: Math.sin(tStep * 0.8) * 0.65,
                jump: false,
                walk: false,
                yaw: Math.sin(tStep * 0.35) * 1.1,
                pitch: -0.06,
              });
            }, 50);
          })()
        `);
      },
      async () => {
        await cdp1.eval(`
          (() => {
            if (window.__BENCH_MOVE_TIMER__) {
              clearInterval(window.__BENCH_MOVE_TIMER__);
              window.__BENCH_MOVE_TIMER__ = null;
            }
            window.__DEV_GAME_TOOLS__?.setSyntheticInput(null);
          })()
        `);
      },
    );

    // Scene 2: `poi_lumber_mill_outdoor`
    await runSceneBenchmark(
      'medium',
      'poi_lumber_mill_outdoor',
      'POI 3 (Arrakorlik) outdoor timber yard with 3 lumber_stack_01, 3 sawhorse_01, 2 rusty_barrel_01 & wooden_signpost_01',
      async () => {
        await cdp1.eval(`
          (() => {
            window.__DEV_GAME_TOOLS__.setSyntheticInput(null);
            window.__DEV_GAME_TOOLS__.setThirdPerson(true);
            window.__DEV_GAME_TOOLS__.setPlayerPos(${(p3.center.x + 3.2).toFixed(2)}, ${(p3.center.z + 2.2).toFixed(2)}, -2.45);
            window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam05)};
          })()
        `);
      },
      null,
    );

    // Scene 3: `poi_service_station_outdoor`
    await runSceneBenchmark(
      'medium',
      'poi_service_station_outdoor',
      'POI 4 (Avto Servis) forecourt with 2 old_fuel_pump_01 on island, 4 rusty_barrel_01, sawhorse_01 & wooden_signpost_01',
      async () => {
        await cdp1.eval(`
          (() => {
            window.__DEV_GAME_TOOLS__.setSyntheticInput(null);
            window.__DEV_GAME_TOOLS__.setThirdPerson(true);
            window.__DEV_GAME_TOOLS__.setPlayerPos(${(p4.center.x + 0.8).toFixed(2)}, ${(p4.center.z + 3.6).toFixed(2)}, -1.85);
            window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam06)};
          })()
        `);
      },
      null,
    );

    // Scene 4: `poi_forest_camp_outdoor`
    await runSceneBenchmark(
      'medium',
      'poi_forest_camp_outdoor',
      'POI 5 (Kemper Lageri) clearing with 2 forest_tent_01, lit campfire_pit_01, lumber_stack_01, rusty_barrel_01 & wooden_signpost_01',
      async () => {
        await cdp1.eval(`
          (() => {
            window.__DEV_GAME_TOOLS__.setSyntheticInput(null);
            window.__DEV_GAME_TOOLS__.setThirdPerson(true);
            window.__DEV_GAME_TOOLS__.setPlayerPos(${(p5.center.x - 1.6).toFixed(2)}, ${(p5.center.z + 1.2).toFixed(2)}, 2.95);
            window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam07)};
          })()
        `);
      },
      null,
    );

    // Close Client 2 before the 5x room reload memory/disposal check
    const cdp2ConsoleErrors = [...cdp2.consoleErrors];
    const cdp2PageExceptions = [...cdp2.pageExceptions];
    const cdp2NetworkErrors = [...cdp2.networkErrors];
    cdp2.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${pageTarget2Id}`).catch(() => {});
    await cdp1.send('Page.bringToFront');

    // =========================================================================
    // STEP 5: 5x Consecutive `forest_survival` Room Reload Memory & Disposal Check
    // =========================================================================
    console.log(
      '\n[Stage 08A QA] Step 5: Running 5x consecutive `forest_survival` room reload memory & GPU resource disposal check...',
    );
    const roomReloadMemoryTrend = [];

    for (let cycle = 1; cycle <= 5; cycle++) {
      await cdp1.eval(`document.getElementById('btn-leave').click()`);
      await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
      await delay(180);
      await cdp1.eval(`
        (() => {
          window.__CREATE_ROOM_OVERRIDES__ = { publicLayoutSeed: 6501 };
          const modeEl = document.getElementById('room-mode');
          modeEl.value = 'forest_survival';
          modeEl.dispatchEvent(new Event('change', { bubbles: true }));
          document.getElementById('room-name').value = 'Stage08A_MemCycle_${cycle}';
          document.getElementById('btn-create').click();
        })()
      `);
      await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
      await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics().allLoaded === true`);
      await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getOutdoorDiagnostics().allLoaded === true`);
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
        outdoor: window.__DEV_GAME_TOOLS__.getOutdoorDiagnostics().renderer,
        programs: typeof window.__GET_WEBGL_PROGRAMS_COUNT__ === 'function' ? window.__GET_WEBGL_PROGRAMS_COUNT__() : 0,
        heapUsedMB: performance.memory ? Number((performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2)) : null,
        heapTotalMB: performance.memory ? Number((performance.memory.totalJSHeapSize / (1024 * 1024)).toFixed(2)) : null
      })`);
      roomReloadMemoryTrend.push(memSample);
      console.log(
        `  [Cycle ${cycle}/5] geometries=${memSample.render.geometries} | textures=${memSample.render.textures} | programs=${memSample.programs} | outdoorBatches=${memSample.outdoor?.instancedBatchCount} | heapUsedMB=${memSample.heapUsedMB}`,
      );
    }

    const firstCycle = roomReloadMemoryTrend[0];
    const steadyCycle = roomReloadMemoryTrend[1] ?? firstCycle;
    const lastCycle = roomReloadMemoryTrend[roomReloadMemoryTrend.length - 1];
    const geometryDelta = lastCycle.render.geometries - steadyCycle.render.geometries;
    const textureDelta = lastCycle.render.textures - steadyCycle.render.textures;
    const programDelta = lastCycle.programs - steadyCycle.programs;
    const heapDeltaMB =
      lastCycle.heapUsedMB !== null && steadyCycle.heapUsedMB !== null
        ? Number((lastCycle.heapUsedMB - steadyCycle.heapUsedMB).toFixed(2))
        : 0;
    const leakDetected = geometryDelta > 2 || textureDelta > 2 || heapDeltaMB > 35;

    const allConsoleErrors = [...cdp1.consoleErrors, ...cdp2ConsoleErrors];
    const allPageExceptions = [...cdp1.pageExceptions, ...cdp2PageExceptions];
    const allNetworkErrors = [...cdp1.networkErrors, ...cdp2NetworkErrors];

    // Load Stage 07-QA baseline metrics for direct comparison
    let stage07QaBaseline = null;
    try {
      const s07QaPath = path.join(ROOT_DIR, 'docs', 'stage07qa', 'smoke_qa.json');
      if (fs.existsSync(s07QaPath)) {
        const s07QaRaw = JSON.parse(fs.readFileSync(s07QaPath, 'utf-8'));
        stage07QaBaseline = s07QaRaw.smokeFpsMetrics ?? null;
      }
    } catch {
      // ignore
    }

    const cpus = os.cpus();
    const qaSummary = {
      stage:
        "BOSQICH 08A — OUTDOOR-ASSET-01 Tashqi Muhit 3D Modellarini O'yin Dunyosiga Integratsiya Qilish",
      timestamp: new Date().toISOString(),
      methodology: {
        warmupSeconds: WARMUP_SEC,
        measurementSeconds: DURATION_SEC,
        repeatsPerScene: REPEATS,
        viewport: '1280x720',
        devicePixelRatio: 1,
        quality: 'medium',
        scenes: [
          'open_forest_movement',
          'poi_lumber_mill_outdoor',
          'poi_service_station_outdoor',
          'poi_forest_camp_outdoor',
        ],
        mode: 'forest_survival',
        mapId: c1WorldMeta.mapId,
        worldVersion: c1WorldMeta.worldVersion,
        publicLayoutSeed: c1WorldMeta.publicLayoutSeed,
        gameplayHash: c1WorldMeta.gameplayHash,
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
          client1GameplayHash: c1WorldMeta.gameplayHash,
          client2GameplayHash: c2WorldMeta.gameplayHash,
          gameplayHashMatch: c1WorldMeta.gameplayHash === c2WorldMeta.gameplayHash,
        },
        glbAssets36: {
          totalExpected: 36,
          totalLoaded: totalGlbCount,
          weaponAssetsLoaded: weaponCount,
          forestAssetsLoaded: forestCount,
          buildingAssetsLoaded: buildingCount,
          interiorAssetsLoaded: interiorCount,
          containerAssetsLoaded: containerCount,
          outdoorAssetsLoaded: outdoorCount,
          allStage04ALoaded: c1Stage04ADiag.allLoaded,
          allOutdoorLoadedClient1: c1OutdoorDiag.allLoaded,
          allOutdoorLoadedClient2: c2OutdoorDiag.allLoaded,
          outdoorAssets: c1OutdoorDiag.assets,
        },
        outdoorRenderer: c1OutdoorDiag.renderer,
        liveContainerLootSmokeTest: {
          containerId: cnt3Id,
          openOk: openCnt3Ack.ok,
          pickedCatalogIds: pickedItems.map((i) => i.catalogId),
          equippedWeaponAfterPickup: c1LootAfterPick.inventorySnap.equippedWeapon,
          passed: Boolean(c1LootAfterPick.inventorySnap.equippedWeapon),
        },
        memoryTest5xReload: {
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
          programDelta,
          initialHeapUsedMB: steadyCycle.heapUsedMB,
          finalHeapUsedMB: lastCycle.heapUsedMB,
          heapDeltaMB,
          leakDetected,
        },
        errors: {
          consoleErrorsCount: allConsoleErrors.length,
          pageExceptionsCount: allPageExceptions.length,
          networkErrorsCount: allNetworkErrors.length,
          consoleErrors: allConsoleErrors,
          pageExceptions: allPageExceptions,
          networkErrors: allNetworkErrors,
        },
      },
      stage07QaBaseline,
      scenes: benchmarkScenes,
      screenshots,
    };

    fs.writeFileSync(SUMMARY_JSON_PATH, JSON.stringify(qaSummary, null, 2));
    console.log(`\n[Stage 08A QA] Saved QA summary JSON to ${SUMMARY_JSON_PATH}`);

    const csvHeader = [
      'quality',
      'scene',
      'warmupSeconds',
      'measurementSeconds',
      'repeats',
      'fpsMean',
      'fpsMedian',
      'fpsP10',
      'fps1PctLow',
      'frameTimeMedianMs',
      'frameTimeP95Ms',
      'frameTimeP99Ms',
      'calls',
      'sceneCalls',
      'vmCalls',
      'triangles',
      'geometries',
      'textures',
      'programs',
      'outdoorVisiblePlacements',
      'outdoorInstancedBatches',
      'outdoorActiveDrawCalls',
      'cullCpuMedianMs',
      'cullCpuP95Ms',
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
          row.fpsMean,
          row.fpsMedian,
          row.fpsP10,
          row.fps1PctLow,
          row.frameTimeMedianMs,
          row.frameTimeP95Ms,
          row.frameTimeP99Ms,
          row.calls,
          row.sceneCalls,
          row.vmCalls,
          row.triangles,
          row.geometries,
          row.textures,
          row.programs,
          row.outdoorRenderer?.visiblePlacements ?? 0,
          row.outdoorRenderer?.instancedBatchCount ?? 0,
          row.outdoorRenderer?.activeDrawCalls ?? 0,
          row.cullCpuMedianMs,
          row.cullCpuP95Ms,
          row.heapUsedMB ?? '',
        ].join(','),
      ),
    ];

    fs.writeFileSync(BENCHMARK_CSV_PATH, csvLines.join('\n') + '\n');
    console.log(`[Stage 08A QA] Saved benchmark CSV to ${BENCHMARK_CSV_PATH}`);

    if (
      allConsoleErrors.length > 0 ||
      allPageExceptions.length > 0 ||
      allNetworkErrors.length > 0 ||
      leakDetected
    ) {
      throw new Error(
        `QA gate failed: consoleErrors=${allConsoleErrors.length}, pageExceptions=${allPageExceptions.length}, networkErrors=${allNetworkErrors.length}, leakDetected=${leakDetected}`,
      );
    }

    console.log('[Stage 08A QA] ALL STAGE 08A BROWSER QA CHECKS, 9 SCREENSHOTS & BENCHMARKS PASSED!');
    cdp1.close();
  } finally {
    if (chromeProc?.pid) killTree(chromeProc.pid);
    if (serverProc?.pid) killTree(serverProc.pid);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

main().catch((err) => {
  console.error('[Stage 08A QA] FAILED:', err);
  process.exit(1);
});
