#!/usr/bin/env node
/**
 * BOSQICH 07 — Forest Survival (Oxirgi Tirik Qolgan) O'yin Sikli, Kuzatuvchi Rejimi va Yakuniy Raund Tizimi
 * Browser QA Automation, Multi-Client Survival Lifecycle (Waiting -> Countdown -> Playing -> Elimination ->
 * Spectator -> Winner Overlay -> Round 2 & Round 3 Auto-Reset), Stage 06 Audit Fix #1 Live Verification,
 * Real WebGL Screenshots (12x 1280x720 PNG) & Sustained Benchmark Script
 *
 * Usage:
 *   node scripts/qa-stage07.mjs [--warmup=10] [--duration=30] [--repeats=3]
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
const SCREENSHOT_DIR = path.join(ROOT_DIR, 'docs', 'screenshots', 'stage07');
const BENCHMARK_DIR = path.join(ROOT_DIR, 'docs', 'stage07');
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

  async waitFor(predicateExpr, timeoutMs = 30000) {
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
 * Verifies Stage 07 `forest_survival` mode across seeds 6501, 7777, 9021,
 * invalid map rejection (`forest_survival` on `forest_sample`), and classic modes over Socket.IO.
 */
async function verifyStage07ProtocolAndModes(serverUrl = 'http://localhost:5173') {
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
      socket.emit('hello', { name: 'QA_Stage07_Proto' }, (res) => {
        if (res?.ok) resolve(res);
        else reject(new Error('Socket hello failed'));
      });
    });

    // 1. Verify creating forest_survival on non-forest_square map is rejected
    const invalidMapRes = await new Promise((resolve) => {
      socket.emit(
        'createRoom',
        {
          name: 'Invalid_Survival_Sample',
          mode: 'forest_survival',
          mapId: 'forest_sample',
        },
        resolve,
      );
    });
    if (invalidMapRes?.ok !== false) {
      throw new Error(`Expected forest_survival on forest_sample to be rejected, got: ${JSON.stringify(invalidMapRes)}`);
    }

    const testCases = [
      { name: 'Surv_Seed_6501', mode: 'forest_survival', mapId: 'forest_square', publicLayoutSeed: 6501, lootPreview: true },
      { name: 'Surv_Seed_7777', mode: 'forest_survival', mapId: 'forest_square', publicLayoutSeed: 7777, lootPreview: true },
      { name: 'Surv_Seed_9021', mode: 'forest_survival', mapId: 'forest_square', publicLayoutSeed: 9021, lootPreview: true },
      { name: 'Classic_FFA_Forest', mode: 'ffa', mapId: 'forest_square', publicLayoutSeed: 6501, lootPreview: false },
      { name: 'Classic_TDM_Technical', mode: 'tdm', mapId: 'forest_technical', publicLayoutSeed: 6501, lootPreview: false },
    ];

    const results = [];
    for (const tc of testCases) {
      const createRes = await new Promise((resolve) => {
        socket.emit(
          'createRoom',
          {
            name: tc.name,
            mode: tc.mode,
            bots: 2,
            maxPlayers: 8,
            timeLimit: 5,
            scoreLimit: 25,
            mapId: tc.mapId,
            publicLayoutSeed: tc.publicLayoutSeed,
            lootPreview: tc.lootPreview,
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
      const roomInfo = joinRes.welcome.room;
      const readyRes = await new Promise((resolve) => {
        socket.emit('ready', { world: worldMeta }, resolve);
      });
      if (!readyRes?.ok) {
        throw new Error(`Ready check failed for ${tc.name}: ${JSON.stringify(readyRes)}`);
      }

      const lootSyncRes = await new Promise((resolve) => {
        socket.emit('loot:sync', {}, resolve);
      });

      results.push({
        label: tc.name,
        roomId: createRes.roomId,
        mode: roomInfo.mode,
        phase: roomInfo.phase,
        bots: roomInfo.bots,
        mapId: worldMeta.mapId,
        publicLayoutSeed: worldMeta.publicLayoutSeed,
        gameplayHash: worldMeta.gameplayHash,
        lootEnabled: Boolean(roomInfo.lootEnabled),
        containerCount: lootSyncRes?.loot?.containers?.length ?? 0,
        equippedWeaponOnSpawn: lootSyncRes?.inventory?.equippedWeapon ?? null,
      });

      socket.emit('leaveRoom');
      await delay(60);
    }

    const s6501 = results.find((r) => r.label === 'Surv_Seed_6501');
    const cFfa = results.find((r) => r.label === 'Classic_FFA_Forest');
    if (
      s6501.mode !== 'forest_survival' ||
      s6501.phase !== 'waiting' ||
      s6501.bots !== 0 ||
      !s6501.lootEnabled ||
      s6501.containerCount !== 26 ||
      s6501.equippedWeaponOnSpawn !== null
    ) {
      throw new Error(`Unexpected forest_survival room state: ${JSON.stringify(s6501)}`);
    }
    if (cFfa.gameplayHash !== s6501.gameplayHash || cFfa.equippedWeaponOnSpawn !== 'rifle') {
      throw new Error(`Unexpected classic FFA state vs forest_survival: ${JSON.stringify({ s6501, cFfa })}`);
    }

    return {
      invalidMapRejected: true,
      invalidMapError: invalidMapRes.error,
      rooms: results,
    };
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

/**
 * Builds a safe, obstacle-aware waypoint list from `startPos` to the Ranger House (`poi_ranger_house`)
 * south-east courtyard approach `(c1.x + 6.2, c1.z + 8.2)`.
 */
function buildRouteToRangerHouseCourtyard(startPos, poiSites) {
  const c1 = poiSites.poi_ranger_house.center;
  const target = { x: Number((c1.x + 6.2).toFixed(2)), z: Number((c1.z + 8.2).toFixed(2)), radius: 1.4 };
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

/**
 * Walks a client authoritatively through `waypoints` using `setSyntheticInput`
 * (with automatic tree/rock sidestepping if velocity stalls) and then faces `lookTarget`.
 */
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

/**
 * Aims `attackerCdp` directly at `targetCdp`'s current authoritative position before each shot
 * and fires until either the first hit lands (`stopAfterFirstHit=true`) or `targetCdp` is eliminated.
 */
async function shootTargetAuthoritatively(
  attackerCdp,
  targetCdp,
  { stopAfterFirstHit = false, aimHead = false, maxShots = 18 } = {},
) {
  await attackerCdp.eval(`
    window.__DEV_CAMERA_OVERRIDE__ = null;
    window.__DEV_PLAYER_POSE_LOCK__ = null;
    window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
  `);
  await targetCdp.eval(`
    window.__DEV_CAMERA_OVERRIDE__ = null;
    window.__DEV_PLAYER_POSE_LOCK__ = null;
    window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
  `);

  const targetId = await targetCdp.eval(
    `window.__DEV_GAME_TOOLS__.getLootDiagnostics().inventorySnap?.playerId`,
  );

  for (let shot = 1; shot <= maxShots; shot++) {
    const [attDiag, tgtDiag, tgtSnapState] = await Promise.all([
      attackerCdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`),
      targetCdp.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`),
      targetCdp.eval(`(() => {
        const myId = window.__DEV_GAME_TOOLS__.getLootDiagnostics().inventorySnap?.playerId;
        const p = window.__LAST_SNAP__?.players?.find((x) => x.id === myId);
        return { hp: p ? p.hp : 100, alive: p ? p.alive : true };
      })()`),
    ]);

    if (!tgtSnapState.alive || tgtSnapState.hp <= 0) {
      return { eliminated: true, hp: 0, shotsFired: shot - 1 };
    }

    const attPos = attDiag.authoritativePos ?? attDiag.predictedPos;
    const tgtPos = tgtDiag.authoritativePos ?? tgtDiag.predictedPos;
    const aimY = tgtPos.y + (aimHead ? 1.54 : 1.02);
    const aimCam = lookAtCamera(
      { x: attPos.x, y: attPos.y + 1.62, z: attPos.z },
      { x: tgtPos.x, y: aimY, z: tgtPos.z },
    );

    await attackerCdp.eval(`
      window.__DEV_GAME_TOOLS__.setSyntheticInput({
        fwd: 0,
        right: 0,
        jump: false,
        walk: false,
        yaw: ${aimCam.yaw.toFixed(4)},
        pitch: ${aimCam.pitch.toFixed(4)}
      })
    `);
    await delay(85);

    let fired = false;
    const fireWaitStart = Date.now();
    while (Date.now() - fireWaitStart < 1600) {
      fired = await attackerCdp.eval(`window.__DEV_GAME_TOOLS__.triggerFire()`);
      if (fired) break;
      await delay(45);
    }
    await attackerCdp.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
    await delay(140);

    const afterState = await targetCdp.eval(`(() => {
      const p = window.__LAST_SNAP__?.players?.find((x) => x.id === '${targetId}');
      const surv = window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics();
      return {
        hp: p ? p.hp : null,
        alive: p ? p.alive : null,
        myRole: surv.survivalUi.myRole,
        phase: surv.match?.phase ?? null,
      };
    })()`);

    if (
      afterState.alive === false ||
      (afterState.hp !== null && afterState.hp <= 0) ||
      afterState.myRole === 'eliminated'
    ) {
      return { eliminated: true, hp: 0, shotsFired: shot };
    }

    if (stopAfterFirstHit && afterState.hp !== null && afterState.hp < tgtSnapState.hp) {
      return { eliminated: false, hp: afterState.hp, shotsFired: shot };
    }
  }

  throw new Error(`Target (${targetId}) was not damaged/eliminated after ${maxShots} shots`);
}

async function openNewClientTab(debugPort, url = 'http://localhost:5173') {
  const newTargetRes = await fetch(`http://127.0.0.1:${debugPort}/json/new?${url}`, {
    method: 'PUT',
  });
  const pageTarget = await newTargetRes.json();
  const cdp = new CdpSession(pageTarget.webSocketDebuggerUrl);
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
      if (!document.getElementById('qa-stage07-clean-hud')) {
        const st = document.createElement('style');
        st.id = 'qa-stage07-clean-hud';
        st.textContent = '#pause-menu, #center-msg, #scoreboard, #death-screen, #toast { display: none !important; } #dev-stats { display: block !important; }';
        document.head.appendChild(st);
      }
      window.__DEV_GAME_TOOLS__?.setQuality('medium');
    })()
  `);
}

async function main() {
  const chromePath = findChromePath();
  const debugPort = 9248;
  console.log(
    `[Stage 07 QA] Starting Forest Survival, Spectator & Round Reset QA, 12 Screenshots & Benchmark (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS})...`,
  );

  let serverProc = null;
  const serverAlreadyRunning = await isHttpReady('http://localhost:5173/api/info', 1500);
  if (!serverAlreadyRunning) {
    console.log('[Stage 07 QA] Starting dev server (`npm run dev`)...');
    serverProc = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
      cwd: ROOT_DIR,
      stdio: 'pipe',
    });
  } else {
    console.log('[Stage 07 QA] Reusing active server on http://localhost:5173');
  }

  const userDataDir = path.join(os.tmpdir(), `stickman_qa_stage07_${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  let chromeProc = null;
  try {
    await waitForHttp('http://localhost:5173/api/info', 30000);

    // =========================================================================
    // STEP 0: Protocol & Mode Isolation Verification over Socket.IO
    // =========================================================================
    console.log('[Stage 07 QA] Verifying Stage 07 Protocol, Multi-Seed & Mode Isolation via Socket.IO...');
    const protoChecks = await verifyStage07ProtocolAndModes('http://localhost:5173');
    for (const r of protoChecks.rooms) {
      console.log(
        `  [proto-check] ${r.label}: mode=${r.mode} phase=${r.phase} map=${r.mapId} seed=${r.publicLayoutSeed} bots=${r.bots} loot=${r.lootEnabled} containers=${r.containerCount} spawnWeapon=${r.equippedWeaponOnSpawn}`,
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

    const screenshots = [];

    // =========================================================================
    // STEP 1: Lobby UI Check (`Screenshot 1`) & Stage 06 Audit Fix #1 Check
    // =========================================================================
    console.log('\n[Stage 07 QA] Step 1: Verifying Lobby UI (`forest_survival`) & Stage 06 Audit Fix #1...');
    await cdp1.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`);
    await cdp1.eval(`
      (() => {
        document.getElementById('name-input').value = 'Ranger_Alpha';
        document.getElementById('btn-enter').click();
      })()
    `);
    await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);

    // Create a temporary preview `forest_survival` room from a helper socket so the Lobby room list
    // also displays the `SURVIVAL` badge and `Oxirgi tirik qolgan · Qurolsiz boshlash` metadata in Screenshot 1
    const lobbyPreviewSock = createSocketClient('http://localhost:5173', {
      transports: ['websocket'],
      forceNew: true,
    });
    await new Promise((resolve) => lobbyPreviewSock.once('connect', resolve));
    await new Promise((resolve) => lobbyPreviewSock.emit('hello', { name: 'Forest_Host' }, resolve));
    const previewRoomRes = await new Promise((resolve) =>
      lobbyPreviewSock.emit(
        'createRoom',
        {
          name: "O'rmon Survival #1 (256x256)",
          mode: 'forest_survival',
          mapId: 'forest_square',
          maxPlayers: 8,
          timeLimit: 5,
        },
        resolve,
      ),
    );
    await new Promise((resolve) =>
      lobbyPreviewSock.emit('joinRoom', { roomId: previewRoomRes.roomId }, resolve),
    );
    await delay(250);

    // Select `forest_survival` in `#room-mode` on Client 1 and verify locked fields
    const lobbyUiState = await cdp1.eval(`
      (() => {
        const modeEl = document.getElementById('room-mode');
        const mapEl = document.getElementById('room-map');
        const botsEl = document.getElementById('room-bots');
        const scoreEl = document.getElementById('room-score');
        const lootChk = document.getElementById('room-loot-preview');
        const nameEl = document.getElementById('room-name');
        nameEl.value = 'Forest Survival — Oxirgi Tirik Qolgan';
        modeEl.value = 'forest_survival';
        modeEl.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('btn-refresh')?.click();
        return {
          modeValue: modeEl.value,
          mapValue: mapEl.value,
          botsValue: botsEl.value,
          botsDisabled: botsEl.disabled,
          scoreValue: scoreEl.value,
          scoreDisabled: scoreEl.disabled,
          lootChecked: Boolean(lootChk?.checked),
          lootDisabled: Boolean(lootChk?.disabled),
        };
      })()
    `);
    await delay(250);

    if (
      lobbyUiState.modeValue !== 'forest_survival' ||
      lobbyUiState.mapValue !== 'forest_square' ||
      lobbyUiState.botsValue !== '0' ||
      !lobbyUiState.botsDisabled ||
      lobbyUiState.scoreValue !== '1' ||
      !lobbyUiState.scoreDisabled ||
      !lobbyUiState.lootChecked ||
      !lobbyUiState.lootDisabled
    ) {
      throw new Error(`Lobby UI forest_survival lock check failed: ${JSON.stringify(lobbyUiState)}`);
    }
    console.log(`  [verified] Lobby UI locks map='forest_square', bots='0' (disabled), score='1' (disabled), lootPreview=true.`);

    // Screenshot 1: 01_lobby_forest_survival_mode_select.png
    screenshots.push(await cdp1.screenshot('01_lobby_forest_survival_mode_select.png'));

    lobbyPreviewSock.emit('leaveRoom');
    lobbyPreviewSock.disconnect();
    await delay(150);

    // Live Browser Check for Stage 06 Audit Fix #1:
    // Create a classic FFA room on `forest_square` with `lootPreview: false` and verify `NOT_IN_LOOT_MODE`
    console.log('  [audit-fix-1] Creating classic FFA (`lootPreview: false`) room on `forest_square` to test `NOT_IN_LOOT_MODE`...');
    await cdp1.eval(`
      (() => {
        const modeEl = document.getElementById('room-mode');
        const mapEl = document.getElementById('room-map');
        const lootChk = document.getElementById('room-loot-preview');
        const botsEl = document.getElementById('room-bots');
        modeEl.value = 'ffa';
        modeEl.dispatchEvent(new Event('change', { bubbles: true }));
        mapEl.value = 'forest_square';
        if (lootChk) {
          lootChk.checked = false;
          lootChk.dispatchEvent(new Event('change', { bubbles: true }));
        }
        botsEl.value = '0';
        document.getElementById('room-name').value = 'Stage06_AuditFix1_ClassicFFA';
        document.getElementById('btn-create').click();
      })()
    `);
    await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos)`);
    await delay(200);

    const auditFix1Checks = await cdp1.eval(`
      (async () => {
        const openAck1 = await window.__DEV_GAME_TOOLS__.openContainerById('poi:poi_ranger_house:cnt:crate_0', 'audit1_open_a');
        const openAck2 = await window.__DEV_GAME_TOOLS__.openContainerById('poi:poi_ranger_house:cnt_0:wooden_loot_crate_01', 'audit1_open_b');
        const pickupAck = await window.__DEV_GAME_TOOLS__.pickupLootItem('poi:poi_ranger_house:cnt_0:wooden_loot_crate_01', 'itm:0', 'audit1_pick');
        const equipAck = await window.__DEV_GAME_TOOLS__.equipInventoryWeapon(null, 'audit1_equip');
        const medkitAck = await window.__DEV_GAME_TOOLS__.useMedkitItem('audit1_medkit');
        const lootDiag = window.__DEV_GAME_TOOLS__.getLootDiagnostics();
        return {
          lootPreview: lootDiag.lootPreview,
          equippedWeapon: lootDiag.inventorySnap?.equippedWeapon ?? 'rifle',
          openAck1,
          openAck2,
          pickupAck,
          equipAck,
          medkitAck,
        };
      })()
    `);

    if (
      auditFix1Checks.lootPreview !== false ||
      auditFix1Checks.openAck1.ok !== false ||
      auditFix1Checks.openAck1.code !== 'NOT_IN_LOOT_MODE' ||
      auditFix1Checks.openAck2.ok !== false ||
      auditFix1Checks.openAck2.code !== 'NOT_IN_LOOT_MODE' ||
      auditFix1Checks.pickupAck.ok !== false ||
      auditFix1Checks.pickupAck.code !== 'NOT_IN_LOOT_MODE' ||
      auditFix1Checks.equipAck.ok !== false ||
      auditFix1Checks.equipAck.code !== 'NOT_IN_LOOT_MODE' ||
      auditFix1Checks.medkitAck.ok !== false ||
      auditFix1Checks.medkitAck.code !== 'NOT_IN_LOOT_MODE'
    ) {
      throw new Error(`Stage 06 Audit Fix #1 check failed: ${JSON.stringify(auditFix1Checks)}`);
    }
    console.log(
      `  [verified] Stage 06 Audit Fix #1 live check passed: open/pickup/equip/medkit in classic FFA rejected with code='NOT_IN_LOOT_MODE'.`,
    );

    // Leave classic FFA room back to Lobby
    await cdp1.eval(`document.getElementById('btn-leave').click()`);
    await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
    await delay(200);

    // =========================================================================
    // STEP 2: Client 1 creates `forest_survival` room -> Waiting Phase (`1/2 Tayyor`) (`Screenshot 2`)
    // =========================================================================
    console.log('\n[Stage 07 QA] Step 2: Client 1 creating `forest_survival` room & verifying `waiting` phase (1/2 Tayyor)...');
    await cdp1.eval(`
      (() => {
        const modeEl = document.getElementById('room-mode');
        modeEl.value = 'forest_survival';
        modeEl.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('room-name').value = 'Stage07_Forest_Survival_QA';
        document.getElementById('room-time').value = '30';
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
    await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getLootDiagnostics().lootSnapshot?.containers?.length === 26`);
    await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().match?.phase === 'waiting'`);
    await injectCleanHudStyles(cdp1);

    const waitingDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);
    if (
      !waitingDiag.isSurvival ||
      waitingDiag.match?.phase !== 'waiting' ||
      waitingDiag.match?.readyCount !== 1 ||
      waitingDiag.match?.minPlayers !== 2 ||
      !waitingDiag.survivalUi.visible
    ) {
      throw new Error(`Waiting phase verification failed: ${JSON.stringify(waitingDiag)}`);
    }

    // Verify pre-round container interaction is blocked (`ROUND_NOT_ACTIVE`) during `waiting`
    const waitingOpenAck = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('poi:poi_ranger_house:cnt_3:wooden_loot_crate_01', 'wait_open_guard_1')`,
    );
    if (waitingOpenAck.ok !== false || waitingOpenAck.code !== 'ROUND_NOT_ACTIVE') {
      throw new Error(`Expected ROUND_NOT_ACTIVE during waiting phase, got ${JSON.stringify(waitingOpenAck)}`);
    }
    console.log(
      `  [verified] Waiting phase active (readyCount=1/2, phase='waiting', pre-round open rejected with code='${waitingOpenAck.code}').`,
    );

    // Orient Client 1 nicely for Screenshot 2
    const c1WaitPos = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    const waitYaw = Math.atan2(c1WaitPos.x, c1WaitPos.z);
    await cdp1.eval(`
      (() => {
        const toast = document.getElementById('stage06-loot-toast');
        if (toast) { toast.className = 'hidden'; toast.textContent = ''; }
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setSyntheticInput({
          fwd: 0, right: 0, jump: false, walk: false,
          yaw: ${waitYaw.toFixed(4)}, pitch: -0.08
        });
      })()
    `);
    await delay(220);
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
    await delay(180);

    // Screenshot 2: 02_waiting_for_players_1of2_uz.png
    screenshots.push(await cdp1.screenshot('02_waiting_for_players_1of2_uz.png'));

    // =========================================================================
    // STEP 3: Client 2 joins -> Countdown Phase (`2/2 Tayyor`) (`Screenshot 3`)
    // =========================================================================
    console.log('\n[Stage 07 QA] Step 3: Connecting Client 2 (`Scout_Bravo`) to trigger 2/2 Countdown...');
    const { cdp: cdp2, targetId: pageTarget2Id } = await openNewClientTab(debugPort);
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
        const items = Array.from(document.querySelectorAll('.room-item'));
        const matchItem = items.find((el) => el.textContent?.includes('Stage07_Forest_Survival_QA'));
        const btn = matchItem?.querySelector('[data-join]') || document.querySelector('[data-join]:last-of-type');
        btn.click();
      })()
    `);
    await cdp2.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await injectCleanHudStyles(cdp2);

    // Wait for `match.phase === 'countdown'` on Client 1
    await cdp1.waitFor(`
      (() => {
        const s = window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics();
        return s?.match?.phase === 'countdown' && s?.match?.readyCount === 2 && s?.match?.timeLeft > 0;
      })()
    `);
    const countdownDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);
    console.log(
      `  [verified] Countdown phase active: phase=${countdownDiag.match.phase} readyCount=${countdownDiag.match.readyCount}/${countdownDiag.match.minPlayers} timeLeft=${countdownDiag.match.timeLeft}s`,
    );

    // Screenshot 3: 03_countdown_2of2_preround_uz.png
    screenshots.push(await cdp1.screenshot('03_countdown_2of2_preround_uz.png'));

    // =========================================================================
    // STEP 4: Round 1 Start — Unarmed Spawn (3P & 1P) (`Screenshots 4 & 5`)
    // =========================================================================
    console.log('\n[Stage 07 QA] Step 4: Waiting for countdown to finish & Round 1 (`playing`) to start...');
    await cdp1.waitFor(
      `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 1`,
      20000,
    );
    await cdp2.waitFor(
      `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && Boolean(window.__DEV_GAME_TOOLS__?.getPredictionDiagnostics()?.authoritativePos)`,
      20000,
    );
    await delay(250);

    const roundTransitionMemoryTrend = [];
    const recordRoundMemorySample = async (roundNumber) => {
      await cdp1.send('HeapProfiler.collectGarbage').catch(() => {});
      await delay(60);
      const sample = await cdp1.eval(`({
        roundId: ${roundNumber},
        render: window.__DEV_GAME_TOOLS__.getRenderStats(),
        programs: typeof window.__GET_WEBGL_PROGRAMS_COUNT__ === 'function' ? window.__GET_WEBGL_PROGRAMS_COUNT__() : 0,
        heapUsedMB: performance.memory ? Number((performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2)) : null,
      })`);
      roundTransitionMemoryTrend.push(sample);
      console.log(
        `  [round-${roundNumber}-mem] geo=${sample.render.geometries} tex=${sample.render.textures} prog=${sample.programs} heap=${sample.heapUsedMB}MB`,
      );
    };
    await recordRoundMemorySample(1);

    const r1C1Surv = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);
    const r1C2Surv = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);
    const r1C1Loot = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    const r1C2Loot = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);

    const r1AllClosed1 = r1C1Loot.lootSnapshot.containers.every(
      (c) => !c.opened && c.status === 'closed' && c.items.length === 0 && c.itemCount === -1,
    );
    const r1AllClosed2 = r1C2Loot.lootSnapshot.containers.every(
      (c) => !c.opened && c.status === 'closed' && c.items.length === 0 && c.itemCount === -1,
    );

    if (
      r1C1Surv.match?.roundId !== 1 ||
      r1C1Surv.match?.aliveCount !== 2 ||
      r1C1Surv.match?.totalContenders !== 2 ||
      r1C1Surv.survivalUi.myRole !== 'contender' ||
      r1C2Surv.survivalUi.myRole !== 'contender' ||
      r1C1Loot.inventorySnap?.equippedWeapon !== null ||
      r1C2Loot.inventorySnap?.equippedWeapon !== null ||
      r1C1Loot.inventorySnap?.ownedWeapons?.length !== 0 ||
      r1C2Loot.inventorySnap?.ownedWeapons?.length !== 0 ||
      !r1C1Loot.inventoryUi.unarmedBannerVisible ||
      !r1C2Loot.inventoryUi.unarmedBannerVisible ||
      !r1AllClosed1 ||
      !r1AllClosed2
    ) {
      throw new Error(
        `Round 1 unarmed start verification failed: ${JSON.stringify({
          r1C1Surv,
          r1C2Surv,
          c1Inv: r1C1Loot.inventorySnap,
          c2Inv: r1C2Loot.inventorySnap,
          r1AllClosed1,
          r1AllClosed2,
        })}`,
      );
    }
    console.log(
      `  [verified] Round 1 started: roundId=1, aliveCount=2/2, both contenders unarmed (equippedWeapon=null), all 26 containers closed.`,
    );

    const c1R1SpawnPos = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    const r1SpawnYaw = Math.atan2(c1R1SpawnPos.x, c1R1SpawnPos.z);
    await cdp1.eval(`
      (() => {
        const chatLog = document.getElementById('chat-log');
        if (chatLog) chatLog.innerHTML = '';
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setSyntheticInput({
          fwd: 0, right: 0, jump: false, walk: false,
          yaw: ${r1SpawnYaw.toFixed(4)}, pitch: -0.08
        });
      })()
    `);
    await delay(220);
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
    await delay(200);

    // Screenshot 4: 04_round1_unarmed_start_3p_hud.png
    screenshots.push(await cdp1.screenshot('04_round1_unarmed_start_3p_hud.png'));

    // Switch to 1P and capture Screenshot 5: 05_round1_unarmed_start_1p_empty_hands.png
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setThirdPerson(false)`);
    await delay(280);
    screenshots.push(await cdp1.screenshot('05_round1_unarmed_start_1p_empty_hands.png'));
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setThirdPerson(true)`);

    // =========================================================================
    // STEP 5: Looting & Equipping in Round 1 (`Screenshots 6 & 7`)
    // =========================================================================
    console.log('\n[Stage 07 QA] Step 5: Walking Client 1 & Client 2 to `poi_ranger_house` for container opening & looting...');
    const client1Meta = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getWorldMeta()`);
    const poiSites = getForestSquarePoiSitesForSeed(client1Meta.publicLayoutSeed);
    const c1Site = poiSites.poi_ranger_house.center;
    const cnt3Id = 'poi:poi_ranger_house:cnt_3:wooden_loot_crate_01';
    const cnt0Id = 'poi:poi_ranger_house:cnt_0:wooden_loot_crate_01';
    const cnt1Id = 'poi:poi_ranger_house:cnt_1:metal_locker_01';
    const cnt2Id = 'poi:poi_ranger_house:cnt_2:old_toolbox_01';

    const cnt3StateInit = r1C1Loot.lootSnapshot.containers.find((c) => c.id === cnt3Id);
    const cnt1StateInit = r1C1Loot.lootSnapshot.containers.find((c) => c.id === cnt1Id);
    if (!cnt3StateInit || !cnt1StateInit) {
      throw new Error('Required poi_ranger_house containers not found in lootSnapshot');
    }

    const c2R1SpawnPos = (await cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    const c1RouteR1 = [
      ...buildRouteToRangerHouseCourtyard(c1R1SpawnPos, poiSites),
      {
        x: Number((cnt3StateInit.position.x - 0.15).toFixed(2)),
        z: Number((cnt3StateInit.position.z + 1.35).toFixed(2)),
        radius: 0.34,
      },
    ];
    const c2RouteR1 = [
      ...buildRouteToRangerHouseCourtyard(c2R1SpawnPos, poiSites),
      {
        x: Number((cnt3StateInit.position.x + 2.85).toFixed(2)),
        z: Number((cnt3StateInit.position.z + 1.85).toFixed(2)),
        radius: 0.45,
      },
    ];

    await Promise.all([
      walkClientWaypoints(cdp1, 'R1_Client1->cnt3', c1RouteR1, {
        x: cnt3StateInit.position.x,
        y: cnt3StateInit.position.y + 1.05,
        z: cnt3StateInit.position.z,
      }),
      walkClientWaypoints(cdp2, 'R1_Client2->yard', c2RouteR1, {
        x: cnt3StateInit.position.x,
        y: cnt3StateInit.position.y + 0.9,
        z: cnt3StateInit.position.z,
      }),
    ]);

    const openCnt3Ack = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 's07_r1_open_cnt3')`,
    );
    if (!openCnt3Ack.ok || !openCnt3Ack.container?.opened || openCnt3Ack.container.items.length < 2) {
      throw new Error(`Failed to open cnt_3 in Round 1: ${JSON.stringify(openCnt3Ack)}`);
    }
    await delay(450);

    const c1OpenDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    console.log(
      `  [verified] cnt_3 opened in Round 1: items=${openCnt3Ack.container.items.map((i) => i.catalogId).join(', ')} | 3D meshes=${c1OpenDiag.worldRenderer.activeItemMeshCount} | panelVisible=${c1OpenDiag.lootUi.panelVisible}`,
    );

    // Screenshot 6: 06_container_open_and_loot_panel.png
    const cam06 = lookAtCamera(
      { x: cnt3StateInit.position.x - 0.15, y: cnt3StateInit.position.y + 1.55, z: cnt3StateInit.position.z + 1.35 },
      { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 1.08, z: cnt3StateInit.position.z },
    );
    await cdp1.eval(`
      window.__DEV_GAME_TOOLS__.setThirdPerson(false);
      window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam06)};
    `);
    await delay(220);
    screenshots.push(await cdp1.screenshot('06_container_open_and_loot_panel.png'));
    await cdp1.eval(`window.__DEV_CAMERA_OVERRIDE__ = null;`);

    // Pick up weapon + ammo from `cnt_3`
    const cnt3WeaponItem = openCnt3Ack.container.items.find((i) => i.kind === 'weapon') ?? openCnt3Ack.container.items[0];
    const cnt3AmmoItem = openCnt3Ack.container.items.find((i) => i.kind === 'ammo') ?? openCnt3Ack.container.items[1];
    const pickWepAck = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${cnt3WeaponItem.id}', 's07_r1_pick_wep')`,
    );
    const pickAmmoAck = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${cnt3AmmoItem.id}', 's07_r1_pick_ammo')`,
    );
    if (!pickWepAck.ok || !pickAmmoAck.ok) {
      throw new Error(`Round 1 weapon/ammo pickup failed: ${JSON.stringify({ pickWepAck, pickAmmoAck })}`);
    }

    // Step Client 1 back in the courtyard in 3P so the container panel closes cleanly for Screenshot 7
    await walkClientWaypoints(
      cdp1,
      'R1_Client1->3pWeaponShow',
      [
        {
          x: Number((cnt3StateInit.position.x - 1.55).toFixed(2)),
          z: Number((cnt3StateInit.position.z + 3.45).toFixed(2)),
          radius: 0.35,
        },
      ],
      {
        x: cnt3StateInit.position.x + 1.2,
        y: cnt3StateInit.position.y + 1.35,
        z: cnt3StateInit.position.z + 1.2,
      },
    );
    await cdp1.eval(`
      (() => {
        const toast = document.getElementById('stage06-loot-toast');
        if (toast) { toast.className = 'hidden'; toast.textContent = ''; }
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
      })()
    `);
    await delay(480);

    const c1AfterPickLoot = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    const equippedWepR1 = c1AfterPickLoot.inventorySnap?.equippedWeapon;
    if (!equippedWepR1 || (c1AfterPickLoot.inventorySnap?.ammo?.[equippedWepR1]?.mag ?? 0) <= 0) {
      throw new Error(`Expected auto-equipped weapon with mag > 0, got ${JSON.stringify(c1AfterPickLoot.inventorySnap)}`);
    }
    console.log(
      `  [verified] Weapon auto-equipped after pickup: equippedWeapon=${equippedWepR1}, ammo=${JSON.stringify(c1AfterPickLoot.inventorySnap.ammo[equippedWepR1])}`,
    );

    // Screenshot 7: 07_weapon_equipped_after_pickup_3p.png
    screenshots.push(await cdp1.screenshot('07_weapon_equipped_after_pickup_3p.png'));

    // Ensure Client 1 also opens cabin containers (`cnt_2`, `cnt_1`, `cnt_0`) and equips `rifle` or `pistol`
    // so Shot 1 in PvP combat deals 26-30 damage (leaving Client 2 alive for Screenshot 8!)
    console.log('  [loot-cabin] Opening interior containers (`cnt_2`, `cnt_1`, `cnt_0`) & ensuring multi-shot weapon (`rifle`/`pistol`) is equipped...');
    await walkClientWaypoints(
      cdp1,
      'R1_Client1->cabinInterior',
      [
        { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 5.6).toFixed(2)), radius: 0.45 },
        { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 0.3).toFixed(2)), radius: 0.42 },
        { x: Number((c1Site.x + 0.65).toFixed(2)), z: Number((c1Site.z - 0.1).toFixed(2)), radius: 0.34 },
      ],
      { x: cnt1StateInit.position.x, y: cnt1StateInit.position.y + 0.8, z: cnt1StateInit.position.z },
    );

    for (const cid of [cnt2Id, cnt1Id, cnt0Id]) {
      const ack = await cdp1.eval(`window.__DEV_GAME_TOOLS__.openContainerById('${cid}', 's07_r1_open_${cid}')`);
      if (ack?.ok && ack.container?.items) {
        const wep = ack.container.items.find(
          (i) => i.kind === 'weapon' && (i.weaponId === 'rifle' || i.weaponId === 'pistol'),
        );
        const ammo = ack.container.items.find((i) => i.kind === 'ammo');
        if (wep) {
          await cdp1.eval(`window.__DEV_GAME_TOOLS__.pickupLootItem('${cid}', '${wep.id}', 's07_r1_pick_${wep.id}')`);
          if (ammo) {
            await cdp1.eval(`window.__DEV_GAME_TOOLS__.pickupLootItem('${cid}', '${ammo.id}', 's07_r1_pick_${ammo.id}')`);
          }
        }
      }
    }

    const c1InvAfterCabin = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`)).inventorySnap;
    const preferredCombatWeapon = c1InvAfterCabin.ownedWeapons.includes('rifle')
      ? 'rifle'
      : c1InvAfterCabin.ownedWeapons.includes('pistol')
        ? 'pistol'
        : c1InvAfterCabin.equippedWeapon;
    if (preferredCombatWeapon && c1InvAfterCabin.equippedWeapon !== preferredCombatWeapon) {
      await cdp1.eval(
        `window.__DEV_GAME_TOOLS__.equipInventoryWeapon('${preferredCombatWeapon}', 's07_r1_equip_combat')`,
      );
    }

    // Walk Client 1 back out to the courtyard facing Client 2 (~4.2m apart)
    const c2YardPos = (await cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    await walkClientWaypoints(
      cdp1,
      'R1_Client1->combatPos',
      [
        { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 0.3).toFixed(2)), radius: 0.45 },
        { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 6.2).toFixed(2)), radius: 0.45 },
        { x: Number((c2YardPos.x - 3.8).toFixed(2)), z: Number((c2YardPos.z + 1.1).toFixed(2)), radius: 0.35 },
      ],
      { x: c2YardPos.x, y: c2YardPos.y + 1.2, z: c2YardPos.z },
    );

    // Orient Client 2 toward Client 1 as well
    const c1CombatPos = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    const c2LookC1 = lookAtCamera(
      { x: c2YardPos.x, y: c2YardPos.y + 1.62, z: c2YardPos.z },
      { x: c1CombatPos.x, y: c1CombatPos.y + 1.2, z: c1CombatPos.z },
    );
    await cdp2.eval(`
      window.__DEV_GAME_TOOLS__.setSyntheticInput({
        fwd: 0, right: 0, jump: false, walk: false,
        yaw: ${c2LookC1.yaw.toFixed(4)}, pitch: ${c2LookC1.pitch.toFixed(4)}
      })
    `);
    await delay(120);
    await cdp2.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);

    // =========================================================================
    // STEP 6: Mid-Round 3rd Client Join -> Spectator Mode (`Screenshot 10`)
    // =========================================================================
    console.log('\n[Stage 07 QA] Step 6: Connecting Client 3 (`Spec_Charlie`) mid-round to verify Spectator Mode...');
    const { cdp: cdp3, targetId: pageTarget3Id } = await openNewClientTab(debugPort);
    await cdp3.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`);
    await cdp3.eval(`
      (() => {
        document.getElementById('name-input').value = 'Spec_Charlie';
        document.getElementById('btn-enter').click();
      })()
    `);
    await cdp3.waitFor(`Boolean(document.querySelector('[data-join]'))`);
    await cdp3.eval(`
      (() => {
        const items = Array.from(document.querySelectorAll('.room-item'));
        const matchItem = items.find((el) => el.textContent?.includes('Stage07_Forest_Survival_QA'));
        const btn = matchItem?.querySelector('[data-join]') || document.querySelector('[data-join]:last-of-type');
        btn.click();
      })()
    `);
    await cdp3.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await cdp3.waitFor(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics().allLoaded === true`);
    await cdp3.waitFor(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().match?.phase === 'playing'`);
    await cdp3.waitFor(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().spectator.availableTargetIds.length === 2`);
    await injectCleanHudStyles(cdp3);
    await delay(300);

    const client1Id = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics().inventorySnap?.playerId`);
    const client2Id = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics().inventorySnap?.playerId`);
    const c3MidJoinDiag = await cdp3.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);

    if (
      c3MidJoinDiag.survivalUi.myRole !== 'spectator' ||
      !c3MidJoinDiag.survivalUi.spectatorBannerVisible ||
      !c3MidJoinDiag.spectator.active ||
      c3MidJoinDiag.spectator.mode !== 'follow' ||
      c3MidJoinDiag.match?.aliveCount !== 2 ||
      c3MidJoinDiag.match?.totalContenders !== 2
    ) {
      throw new Error(`Client 3 mid-round spectator check failed: ${JSON.stringify(c3MidJoinDiag)}`);
    }

    // Verify `cycleSpectatorTarget(+1)` and `cycleSpectatorTarget(-1)` on Client 3
    const c3TargetBefore = c3MidJoinDiag.spectator.targetId;
    const c3TargetNext = await cdp3.eval(`window.__DEV_GAME_TOOLS__.cycleSpectatorTarget(1)`);
    const c3TargetPrev = await cdp3.eval(`window.__DEV_GAME_TOOLS__.cycleSpectatorTarget(-1)`);
    if (!c3TargetNext || c3TargetNext === c3TargetBefore || c3TargetPrev !== c3TargetBefore) {
      throw new Error(
        `Spectator target cycling failed: before=${c3TargetBefore}, next=${c3TargetNext}, prev=${c3TargetPrev}`,
      );
    }

    // Verify mid-round spectator cannot open containers (`PLAYER_DEAD`)
    const specOpenAck = await cdp3.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 'spec_open_guard_1')`,
    );
    if (specOpenAck.ok !== false || specOpenAck.code !== 'PLAYER_DEAD') {
      throw new Error(`Expected PLAYER_DEAD when spectator tries to open container, got ${JSON.stringify(specOpenAck)}`);
    }
    console.log(
      `  [verified] Client 3 joined mid-round as spectator (myRole='spectator', aliveCount=2/2 unchanged, cycleTarget=${c3TargetBefore}->${c3TargetNext}->${c3TargetPrev}, openContainer rejected with '${specOpenAck.code}').`,
    );

    // Pin Client 3 to Client 1 in 1P spectator view (`setThirdPerson(false)`) and capture Screenshot 10
    await cdp3.eval(`
      (() => {
        const toast = document.getElementById('stage06-loot-toast');
        if (toast) { toast.className = 'hidden'; toast.textContent = ''; }
        window.__DEV_GAME_TOOLS__.setSpectatorTarget('${client1Id}');
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
      })()
    `);
    await delay(320);
    const shot10Info = await cdp3.screenshot('10_midjoin_spectator_mode_1p.png');
    await cdp3.eval(`window.__DEV_GAME_TOOLS__.setThirdPerson(true)`);

    // =========================================================================
    // STEP 7: PvP Combat (`Screenshot 8`), Elimination (No 3s Respawn!),
    //         Spectator Follow (`Screenshot 9`), & Winner Overlay (`Screenshot 11`)
    // =========================================================================
    console.log('\n[Stage 07 QA] Step 7: Executing PvP combat, elimination, spectator follow & winner overlay...');
    await cdp1.send('Page.bringToFront');
    await cdp1.eval(`
      (() => {
        const toast = document.getElementById('stage06-loot-toast');
        if (toast) { toast.className = 'hidden'; toast.textContent = ''; }
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
      })()
    `);
    await delay(200);

    // Fire 1 body shot at Client 2 so Client 2 takes damage (0 < hp < 100) while still alive
    const firstHitRes = await shootTargetAuthoritatively(cdp1, cdp2, {
      stopAfterFirstHit: true,
      aimHead: false,
      maxShots: 6,
    });
    console.log(
      `  [combat] Client 1 hit Client 2: shots=${firstHitRes.shotsFired}, Client 2 HP=${firstHitRes.hp}, eliminated=${firstHitRes.eliminated}`,
    );

    // Trigger a visible muzzle flash/tracer shot right before Screenshot 8
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.triggerFireAnim()`);
    // Screenshot 8: 08_pvp_combat_elimination_in_progress.png
    const shot08Info = await cdp1.screenshot('08_pvp_combat_elimination_in_progress.png');

    // Now eliminate Client 2 completely
    const killResR1 = await shootTargetAuthoritatively(cdp1, cdp2, {
      stopAfterFirstHit: false,
      aimHead: true,
      maxShots: 14,
    });
    const c2DeathTimestampR1 = Date.now();
    console.log(`  [eliminated] Client 2 eliminated in Round 1 (additional shots=${killResR1.shotsFired}).`);

    // Wait 700ms so Client 2's 0.55s death camera pull-back transitions into 3P follow spectator camera on Client 1
    await delay(700);

    const c2ElimDiag = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);
    const c1WinDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);

    if (
      c2ElimDiag.survivalUi.myRole !== 'eliminated' ||
      !c2ElimDiag.survivalUi.spectatorBannerVisible ||
      !c2ElimDiag.spectator.active ||
      c2ElimDiag.spectator.mode !== 'follow' ||
      c2ElimDiag.spectator.targetId !== client1Id
    ) {
      throw new Error(`Client 2 eliminated spectator check failed: ${JSON.stringify(c2ElimDiag)}`);
    }

    if (
      c1WinDiag.match?.phase !== 'ended' ||
      c1WinDiag.match?.winnerId !== client1Id ||
      (c1WinDiag.match?.winReason !== 'last_standing' && c1WinDiag.match?.winReason !== 'last_man_standing') ||
      !c1WinDiag.survivalUi.winnerOverlayVisible
    ) {
      throw new Error(`Client 1 winner overlay check failed: ${JSON.stringify(c1WinDiag)}`);
    }
    console.log(
      `  [verified] Client 2 in eliminated spectator follow mode (targetId=${c2ElimDiag.spectator.targetId}); Client 1 won Round 1 (winnerId=${c1WinDiag.match.winnerId}, winReason='${c1WinDiag.match.winReason}').`,
    );

    // Screenshot 9 on Client 2: 09_eliminated_spectator_mode_follow_3p.png
    // Temporarily hide #stage07-winner-overlay during Screenshot 9 on Client 2 so the 3P followed contender
    // in the center of the viewport + the bottom #stage07-spectator-panel are 100% unobstructed
    await cdp2.eval(`
      (() => {
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        const winEl = document.getElementById('stage07-winner-overlay');
        if (winEl) winEl.style.display = 'none';
      })()
    `);
    await delay(150);
    const shot09Info = await cdp2.screenshot('09_eliminated_spectator_mode_follow_3p.png');
    await cdp2.eval(`
      (() => {
        const winEl = document.getElementById('stage07-winner-overlay');
        if (winEl) winEl.style.display = '';
      })()
    `);

    // Screenshot 11 on Client 1 (winner): 11_winner_overlay_round_end_uz.png
    await cdp1.send('Page.bringToFront');
    await delay(150);
    const shot11Info = await cdp1.screenshot('11_winner_overlay_round_end_uz.png');

    screenshots.push(shot08Info, shot09Info, shot10Info, shot11Info);

    // Wait until 3.5s after Client 2's death in Round 1 and verify Client 2 did NOT respawn after 3.0s
    const elapsedSinceR1Death = Date.now() - c2DeathTimestampR1;
    if (elapsedSinceR1Death < 3550) {
      await delay(3550 - elapsedSinceR1Death);
    }
    const c2NoRespawnR1 = await cdp2.eval(`(() => {
      const myId = window.__DEV_GAME_TOOLS__.getLootDiagnostics().inventorySnap?.playerId;
      const p = window.__LAST_SNAP__?.players?.find((x) => x.id === myId);
      const surv = window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics();
      return { alive: p ? p.alive : false, myRole: surv.survivalUi.myRole, specActive: surv.spectator.active };
    })()`);
    if (c2NoRespawnR1.alive !== false || c2NoRespawnR1.myRole !== 'eliminated') {
      throw new Error(`Client 2 unexpectedly respawned after 3.5s in Round 1: ${JSON.stringify(c2NoRespawnR1)}`);
    }
    console.log(
      `  [verified] No 3s auto-respawn check #1 passed (3.5s after death: alive=${c2NoRespawnR1.alive}, myRole='${c2NoRespawnR1.myRole}').`,
    );

    // =========================================================================
    // STEP 8: Round 2 Automatic Reset & Fresh Unarmed Spawn (`Screenshot 12`)
    //         + In-Play Elimination No-Respawn Check + Round 3 Transition
    // =========================================================================
    console.log('\n[Stage 07 QA] Step 8: Waiting for `ended` + `countdown` to transition into Round 2 (`roundId === 2`)...');
    await cdp1.waitFor(
      `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 2`,
      30000,
    );
    await cdp2.waitFor(
      `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 2`,
      15000,
    );
    await cdp3.waitFor(
      `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 2`,
      15000,
    );
    await delay(300);
    await recordRoundMemorySample(2);

    const [r2C1Surv, r2C2Surv, r2C3Surv, r2C1Loot, r2C2Loot, r2C3Loot] = await Promise.all([
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`),
      cdp2.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`),
      cdp3.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`),
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`),
      cdp2.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`),
      cdp3.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`),
    ]);

    const r2AllClosed = r2C1Loot.lootSnapshot.containers.every(
      (c) => !c.opened && c.status === 'closed' && c.items.length === 0 && c.itemCount === -1,
    );

    if (
      r2C1Surv.match?.roundId !== 2 ||
      r2C1Surv.match?.aliveCount !== 3 ||
      r2C1Surv.match?.totalContenders !== 3 ||
      r2C1Surv.survivalUi.myRole !== 'contender' ||
      r2C2Surv.survivalUi.myRole !== 'contender' ||
      r2C3Surv.survivalUi.myRole !== 'contender' ||
      r2C1Surv.spectator.active !== false ||
      r2C2Surv.spectator.active !== false ||
      r2C3Surv.spectator.active !== false ||
      r2C1Loot.inventorySnap?.equippedWeapon !== null ||
      r2C2Loot.inventorySnap?.equippedWeapon !== null ||
      r2C3Loot.inventorySnap?.equippedWeapon !== null ||
      r2C1Loot.inventorySnap?.ownedWeapons?.length !== 0 ||
      r2C2Loot.inventorySnap?.ownedWeapons?.length !== 0 ||
      r2C3Loot.inventorySnap?.ownedWeapons?.length !== 0 ||
      !r2AllClosed
    ) {
      throw new Error(
        `Round 2 reset verification failed: ${JSON.stringify({
          r2C1Surv,
          r2C2Surv,
          r2C3Surv,
          c1Inv: r2C1Loot.inventorySnap,
          c2Inv: r2C2Loot.inventorySnap,
          c3Inv: r2C3Loot.inventorySnap,
          r2AllClosed,
        })}`,
      );
    }
    console.log(
      `  [verified] Round 2 auto-reset complete: roundId=2, aliveCount=3/3 (including former mid-join spectator Client 3!), all 3 clients unarmed, all 26 containers reset to closed.`,
    );

    // Orient Client 1 in 3P for Screenshot 12: 12_round2_reset_fresh_unarmed_spawn.png
    const c1R2SpawnPos = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    const r2SpawnYaw = Math.atan2(c1R2SpawnPos.x, c1R2SpawnPos.z);
    await cdp1.eval(`
      (() => {
        const toast = document.getElementById('stage06-loot-toast');
        if (toast) { toast.className = 'hidden'; toast.textContent = ''; }
        const chatLog = document.getElementById('chat-log');
        if (chatLog) chatLog.innerHTML = '';
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setSyntheticInput({
          fwd: 0, right: 0, jump: false, walk: false,
          yaw: ${r2SpawnYaw.toFixed(4)}, pitch: -0.08
        });
      })()
    `);
    await delay(220);
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
    await delay(200);

    // Screenshot 12: 12_round2_reset_fresh_unarmed_spawn.png
    screenshots.push(await cdp1.screenshot('12_round2_reset_fresh_unarmed_spawn.png'));

    // Now in Round 2 (3 contenders), walk all 3 clients in parallel to `poi_ranger_house` courtyard,
    // eliminate Client 2 while `match.phase === 'playing'` (2/3 alive), verify Client 2 does NOT respawn after 3.5s
    // during active play, then eliminate Client 3 to finish Round 2 and verify Round 3 (`roundId === 3`) starts cleanly!
    console.log('\n[Stage 07 QA] Step 8B: Walking all 3 contenders to `poi_ranger_house` in Round 2 to test in-play elimination & Round 3 transition...');
    const [c2R2SpawnPos, c3R2SpawnPos] = await Promise.all([
      cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos`),
      cdp3.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos`),
    ]);

    await Promise.all([
      walkClientWaypoints(
        cdp1,
        'R2_Client1->cnt3',
        [
          ...buildRouteToRangerHouseCourtyard(c1R2SpawnPos, poiSites),
          {
            x: Number((cnt3StateInit.position.x - 0.15).toFixed(2)),
            z: Number((cnt3StateInit.position.z + 1.35).toFixed(2)),
            radius: 0.35,
          },
        ],
        { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 0.9, z: cnt3StateInit.position.z },
      ),
      walkClientWaypoints(
        cdp2,
        'R2_Client2->yard',
        [
          ...buildRouteToRangerHouseCourtyard(c2R2SpawnPos, poiSites),
          {
            x: Number((cnt3StateInit.position.x + 2.6).toFixed(2)),
            z: Number((cnt3StateInit.position.z + 1.5).toFixed(2)),
            radius: 0.45,
          },
        ],
        { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 0.9, z: cnt3StateInit.position.z },
      ),
      walkClientWaypoints(
        cdp3,
        'R2_Client3->yard',
        [
          ...buildRouteToRangerHouseCourtyard(c3R2SpawnPos, poiSites),
          {
            x: Number((cnt3StateInit.position.x + 2.6).toFixed(2)),
            z: Number((cnt3StateInit.position.z + 3.4).toFixed(2)),
            radius: 0.45,
          },
        ],
        { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 0.9, z: cnt3StateInit.position.z },
      ),
    ]);

    const r2OpenCnt3 = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 's07_r2_open_cnt3')`,
    );
    const r2WepItem = r2OpenCnt3.container.items.find((i) => i.kind === 'weapon') ?? r2OpenCnt3.container.items[0];
    const r2AmmoItem = r2OpenCnt3.container.items.find((i) => i.kind === 'ammo') ?? r2OpenCnt3.container.items[1];
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${r2WepItem.id}', 's07_r2_pick_wep')`);
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${r2AmmoItem.id}', 's07_r2_pick_ammo')`);
    await delay(550);

    // Eliminate Client 2 in Round 2 while Client 3 remains alive (`aliveCount === 2/3`, `phase === 'playing'`)
    await shootTargetAuthoritatively(cdp1, cdp2, { stopAfterFirstHit: false, aimHead: true, maxShots: 16 });
    const c2DeathTimeR2 = Date.now();
    await delay(3550);

    const c2InPlayNoRespawn = await cdp2.eval(`(() => {
      const myId = window.__DEV_GAME_TOOLS__.getLootDiagnostics().inventorySnap?.playerId;
      const p = window.__LAST_SNAP__?.players?.find((x) => x.id === myId);
      const surv = window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics();
      return {
        alive: p ? p.alive : false,
        phase: surv.match?.phase,
        aliveCount: surv.match?.aliveCount,
        totalContenders: surv.match?.totalContenders,
        myRole: surv.survivalUi.myRole,
        specActive: surv.spectator.active,
        specMode: surv.spectator.mode,
      };
    })()`);

    if (
      c2InPlayNoRespawn.alive !== false ||
      c2InPlayNoRespawn.phase !== 'playing' ||
      c2InPlayNoRespawn.aliveCount !== 2 ||
      c2InPlayNoRespawn.totalContenders !== 3 ||
      c2InPlayNoRespawn.myRole !== 'eliminated' ||
      !c2InPlayNoRespawn.specActive
    ) {
      throw new Error(
        `In-play elimination no-respawn check (2/3 alive) failed after ${Date.now() - c2DeathTimeR2}ms: ${JSON.stringify(c2InPlayNoRespawn)}`,
      );
    }
    console.log(
      `  [verified] In-play no-respawn check #2 passed (3.55s after death during active 'playing' phase with 2/3 alive: alive=false, myRole='eliminated', specActive=true).`,
    );

    // Now eliminate Client 3 to finish Round 2 and trigger Round 3
    await shootTargetAuthoritatively(cdp1, cdp3, { stopAfterFirstHit: false, aimHead: true, maxShots: 16 });
    await cdp1.waitFor(`window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'ended'`, 10000);
    console.log('  [round-2-ended] Client 3 eliminated; Round 2 ended. Waiting for Round 3 (`roundId === 3`)...');

    await cdp1.waitFor(
      `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 3`,
      30000,
    );
    await cdp2.waitFor(
      `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 3`,
      15000,
    );
    await cdp3.waitFor(
      `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 3`,
      15000,
    );
    await delay(300);
    await recordRoundMemorySample(3);

    const r3C1Surv = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);
    const r3C1Loot = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    const r3AllClosed = r3C1Loot.lootSnapshot.containers.every(
      (c) => !c.opened && c.status === 'closed' && c.items.length === 0 && c.itemCount === -1,
    );
    if (
      r3C1Surv.match?.roundId !== 3 ||
      r3C1Surv.match?.aliveCount !== 3 ||
      r3C1Surv.match?.totalContenders !== 3 ||
      r3C1Loot.inventorySnap?.equippedWeapon !== null ||
      !r3AllClosed
    ) {
      throw new Error(`Round 3 reset check failed: ${JSON.stringify({ r3C1Surv, r3AllClosed })}`);
    }
    console.log(
      `  [verified] Round 3 started cleanly (3 consecutive survival rounds verified: roundId=3, aliveCount=3/3, unarmed=true, allClosed=true)!`,
    );

    // =========================================================================
    // STEP 9: Sustained Performance Benchmark in `forest_survival`
    //         (`WARMUP_SEC = 10`, `DURATION_SEC = 30`, `REPEATS = 3`)
    // =========================================================================
    console.log(
      `\n[Stage 07 QA] Step 9: Running sustained performance benchmark (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS})...`,
    );

    // Cap background tabs (cdp2, cdp3) to 15 FPS so they don't contend for GPU with cdp1
    await cdp2.eval(`window.__SET_RAF_CAP_FPS__?.(15)`);
    await cdp3.eval(`window.__SET_RAF_CAP_FPS__?.(15)`);
    await cdp1.eval(`
      window.__DEV_CAMERA_OVERRIDE__ = null;
      window.__DEV_PLAYER_POSE_LOCK__ = null;
      window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
      window.__SET_RAF_CAP_FPS__?.(null);
    `);

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

    const resultsByQuality = { medium: {}, low: {} };
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
            r.prediction = window.__DEV_GAME_TOOLS__.getPredictionDiagnostics();
            r.lootWorld = window.__DEV_GAME_TOOLS__.getLootDiagnostics().worldRenderer;
            r.survival = window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics();
            return r;
          })()
        `);
        if (teardownFn) {
          await teardownFn();
        }
        runs.push({ repeat: rep, ...res });
        console.log(
          `  [${quality} | ${sceneId} #${rep}] frames=${res.frames} | avgFps=${res.fpsMean} p50Fps=${res.fpsMedian} 1%low=${res.fps1PctLow} | FT p50=${res.frameTimeMedianMs}ms p95=${res.frameTimeP95Ms}ms p99=${res.frameTimeP99Ms}ms | Draw=${res.render.calls} Tris=${res.render.triangles}`,
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
        quality,
        scene: sceneId,
        description,
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
        lootWorldRenderer: lastRun.lootWorld,
        cullingProfile: lastRun.culling,
        heapUsedMB: lastRun.heapUsedMB,
        predictionDiagnostics: lastRun.prediction,
        survivalRole: lastRun.survival?.survivalUi?.myRole ?? null,
        runs,
      };

      resultsByQuality[quality][sceneId] = summary;
      csvRows.push(summary);
    };

    // -------------------------------------------------------------------------
    // Scene 1: `survival_spawn_and_loot` (`medium`)
    // Active unarmed movement from spawn toward POI container in `forest_survival`
    // -------------------------------------------------------------------------
    console.log('\n[Benchmark Scene 1/4: survival_spawn_and_loot (medium)]');
    await runSceneBenchmark(
      'medium',
      'survival_spawn_and_loot',
      'Active unarmed movement from spawn toward POI container in forest_survival',
      async () => {
        await cdp1.eval(`
          (() => {
            if (window.__BENCH_MOVE_TIMER__) clearInterval(window.__BENCH_MOVE_TIMER__);
            window.__DEV_CAMERA_OVERRIDE__ = null;
            window.__DEV_PLAYER_POSE_LOCK__ = null;
            window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
            window.__DEV_GAME_TOOLS__.setThirdPerson(true);
            window.__DEV_GAME_TOOLS__.setWeapon(null);
            let tStep = 0;
            window.__BENCH_MOVE_TIMER__ = setInterval(() => {
              tStep += 0.05;
              if (window.__DEV_GAME_TOOLS__) {
                const fwd = Math.cos(tStep * 0.4) >= -0.2 ? 1 : -1;
                const right = Math.sin(tStep * 0.8) * 0.65;
                const yaw = Math.sin(tStep * 0.35) * 1.1;
                window.__DEV_GAME_TOOLS__.setSyntheticInput({
                  fwd,
                  right,
                  jump: false,
                  walk: false,
                  yaw,
                  pitch: -0.06,
                });
              }
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
            window.__DEV_PLAYER_POSE_LOCK__ = null;
            window.__DEV_GAME_TOOLS__?.clearPlayerPoseLock();
          })()
        `);
      },
    );

    // Walk Client 1 & Client 2 to `poi_ranger_house` in Round 3 and open all 4 containers for Scene 2 & Scene 3
    console.log('\n[Benchmark Setup] Walking Client 1 & Client 2 to `poi_ranger_house` and opening containers...');
    await cdp2.eval(`window.__SET_RAF_CAP_FPS__?.(null)`);
    const [c1R3Pos, c2R3Pos] = await Promise.all([
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos`),
      cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos`),
    ]);
    await Promise.all([
      walkClientWaypoints(
        cdp1,
        'R3_Client1->cabin',
        [
          ...buildRouteToRangerHouseCourtyard(c1R3Pos, poiSites),
          { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 5.6).toFixed(2)), radius: 0.45 },
          { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 0.3).toFixed(2)), radius: 0.42 },
          { x: Number((c1Site.x + 0.65).toFixed(2)), z: Number((c1Site.z - 0.1).toFixed(2)), radius: 0.34 },
        ],
        { x: cnt1StateInit.position.x, y: cnt1StateInit.position.y + 0.8, z: cnt1StateInit.position.z },
      ),
      walkClientWaypoints(
        cdp2,
        'R3_Client2->cnt3',
        [
          ...buildRouteToRangerHouseCourtyard(c2R3Pos, poiSites),
          {
            x: Number((cnt3StateInit.position.x - 0.15).toFixed(2)),
            z: Number((cnt3StateInit.position.z + 1.35).toFixed(2)),
            radius: 0.35,
          },
        ],
        { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 0.9, z: cnt3StateInit.position.z },
      ),
    ]);

    await cdp1.eval(`window.__DEV_GAME_TOOLS__.openContainerById('${cnt0Id}', 'r3_bench_open0')`);
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.openContainerById('${cnt1Id}', 'r3_bench_open1')`);
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.openContainerById('${cnt2Id}', 'r3_bench_open2')`);
    const r3Cnt3Open = await cdp2.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 'r3_bench_open3')`,
    );
    await cdp2.eval(`window.__SET_RAF_CAP_FPS__?.(15)`);
    await delay(400);

    // -------------------------------------------------------------------------
    // Scene 2: `poi_container_interaction` (`medium`)
    // Inside/courtyard of POI with opened containers and 3D loot items rendered
    // -------------------------------------------------------------------------
    console.log('\n[Benchmark Scene 2/4: poi_container_interaction (medium)]');
    const p1FloorY = Number(cnt1StateInit.position.y.toFixed(3));
    const camPoiLoot = lookAtCamera(
      { x: c1Site.x - 1.2, y: p1FloorY + 2.05, z: c1Site.z + 2.1 },
      { x: c1Site.x + 1.8, y: p1FloorY + 0.65, z: c1Site.z - 0.8 },
    );

    await runSceneBenchmark(
      'medium',
      'poi_container_interaction',
      'Inside/courtyard of POI with opened containers and 3D loot items rendered in forest_survival',
      async () => {
        await cdp1.eval(`
          (() => {
            if (window.__BENCH_MOVE_TIMER__) {
              clearInterval(window.__BENCH_MOVE_TIMER__);
              window.__BENCH_MOVE_TIMER__ = null;
            }
            window.__DEV_GAME_TOOLS__.setSyntheticInput(null);
            window.__DEV_GAME_TOOLS__.setThirdPerson(false);
            window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(camPoiLoot)};
          })()
        `);
      },
      async () => {
        await cdp1.eval(`
          window.__DEV_CAMERA_OVERRIDE__ = null;
          window.__DEV_PLAYER_POSE_LOCK__ = null;
          window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
        `);
      },
    );

    // -------------------------------------------------------------------------
    // Scene 3: `final_1v1_combat` (`medium` and `low`)
    // Active 1v1 combat movement & gunfire between 2 players in `forest_survival`
    // -------------------------------------------------------------------------
    console.log('\n[Benchmark Scene 3/4: final_1v1_combat (medium & low)]');
    // Equip weapons on Client 1 (from cnt_1) and Client 2 (from cnt_3) and step Client 1 into the courtyard
    const r3C1LootSnap = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`)).lootSnapshot;
    const r3Cnt1Items = r3C1LootSnap.containers.find((c) => c.id === cnt1Id)?.items ?? [];
    for (const it of r3Cnt1Items) {
      await cdp1.eval(`window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt1Id}', '${it.id}', 'r3_c1_pick_${it.id}')`);
    }
    const r3Cnt3Items = r3Cnt3Open.container?.items ?? [];
    for (const it of r3Cnt3Items) {
      await cdp2.eval(`window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${it.id}', 'r3_c2_pick_${it.id}')`);
    }

    await walkClientWaypoints(
      cdp1,
      'R3_Client1->yardCombat',
      [
        { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 0.3).toFixed(2)), radius: 0.45 },
        { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 6.5).toFixed(2)), radius: 0.45 },
        { x: Number((cnt3StateInit.position.x - 3.6).toFixed(2)), z: Number((cnt3StateInit.position.z + 2.4).toFixed(2)), radius: 0.4 },
      ],
      { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 1.2, z: cnt3StateInit.position.z + 1.35 },
    );

    for (const q of ['medium', 'low']) {
      await runSceneBenchmark(
        q,
        'final_1v1_combat',
        'Active 1v1 combat movement & gunfire between 2 players in forest_survival',
        async () => {
          // Have Client 2 strafe in front of Client 1 without hitting Client 1
          await cdp2.eval(`
            (() => {
              if (window.__BENCH_C2_TIMER__) clearInterval(window.__BENCH_C2_TIMER__);
              let s = 0;
              window.__BENCH_C2_TIMER__ = setInterval(() => {
                s += 0.06;
                window.__DEV_GAME_TOOLS__?.setSyntheticInput({
                  fwd: Math.sin(s * 0.7) * 0.6,
                  right: Math.cos(s * 0.9) * 0.85,
                  jump: false,
                  walk: false,
                  yaw: -1.4 + Math.sin(s * 0.5) * 0.35,
                  pitch: -0.05,
                });
              }, 50);
            })()
          `);
          await cdp1.eval(`
            (() => {
              if (window.__BENCH_MOVE_TIMER__) clearInterval(window.__BENCH_MOVE_TIMER__);
              window.__DEV_CAMERA_OVERRIDE__ = null;
              window.__DEV_PLAYER_POSE_LOCK__ = null;
              window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
              window.__DEV_GAME_TOOLS__.setThirdPerson(false);
              let cStep = 0;
              window.__BENCH_MOVE_TIMER__ = setInterval(() => {
                cStep += 0.05;
                if (window.__DEV_GAME_TOOLS__) {
                  const fwd = Math.cos(cStep * 0.6) * 0.75;
                  const right = Math.sin(cStep * 0.9) * 0.85;
                  const yaw = 1.35 + Math.sin(cStep * 0.45) * 0.45;
                  window.__DEV_GAME_TOOLS__.setSyntheticInput({
                    fwd,
                    right,
                    jump: false,
                    walk: false,
                    yaw,
                    pitch: -0.06,
                  });
                  if (Math.floor(cStep * 20) % 12 === 0) {
                    window.__DEV_GAME_TOOLS__.triggerFireAnim();
                  }
                }
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
              window.__DEV_PLAYER_POSE_LOCK__ = null;
              window.__DEV_GAME_TOOLS__?.clearPlayerPoseLock();
            })()
          `);
          await cdp2.eval(`
            (() => {
              if (window.__BENCH_C2_TIMER__) {
                clearInterval(window.__BENCH_C2_TIMER__);
                window.__BENCH_C2_TIMER__ = null;
              }
              window.__DEV_GAME_TOOLS__?.setSyntheticInput(null);
            })()
          `);
        },
      );
    }

    // -------------------------------------------------------------------------
    // Scene 4: `spectator_camera` (`medium` and `low`)
    // Eliminated/spectator camera following an active moving contender in `forest_survival`
    // -------------------------------------------------------------------------
    console.log('\n[Benchmark Scene 4/4: spectator_camera (medium & low)]');
    // Uncap cdp2 RAF, ensure Client 2 has a weapon equipped from cnt_3, bring Client 1 & Client 2
    // to exact 3.0m clear LOS in the courtyard, and have Client 2 eliminate Client 1!
    await cdp2.eval(`window.__SET_RAF_CAP_FPS__?.(null)`);
    await walkClientWaypoints(
      cdp2,
      'R3_Client2->cnt3EnsureWeapon',
      [
        {
          x: Number((cnt3StateInit.position.x - 0.15).toFixed(2)),
          z: Number((cnt3StateInit.position.z + 1.35).toFixed(2)),
          radius: 0.35,
        },
      ],
      { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 0.9, z: cnt3StateInit.position.z },
    );
    const c2EnsureOpen = await cdp2.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 'r3_c2_ensure_open3')`,
    );
    for (const it of c2EnsureOpen?.container?.items ?? []) {
      await cdp2.eval(`window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${it.id}', 'r3_c2_ensure_pick_${it.id}')`);
    }
    await delay(600);

    await Promise.all([
      walkClientWaypoints(
        cdp1,
        'R3_Client1->specElimPos',
        [
          {
            x: Number((cnt3StateInit.position.x - 1.5).toFixed(2)),
            z: Number((cnt3StateInit.position.z + 2.2).toFixed(2)),
            radius: 0.4,
          },
        ],
        { x: cnt3StateInit.position.x + 1.5, y: cnt3StateInit.position.y + 1.1, z: cnt3StateInit.position.z + 2.2 },
      ),
      walkClientWaypoints(
        cdp2,
        'R3_Client2->specElimPos',
        [
          {
            x: Number((cnt3StateInit.position.x + 1.5).toFixed(2)),
            z: Number((cnt3StateInit.position.z + 2.2).toFixed(2)),
            radius: 0.4,
          },
        ],
        { x: cnt3StateInit.position.x - 1.5, y: cnt3StateInit.position.y + 1.1, z: cnt3StateInit.position.z + 2.2 },
      ),
    ]);
    await shootTargetAuthoritatively(cdp2, cdp1, { stopAfterFirstHit: false, aimHead: true, maxShots: 18 });
    await cdp2.eval(`window.__SET_RAF_CAP_FPS__?.(30)`);
    await delay(750);

    const c1SpecBenchDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);
    if (
      c1SpecBenchDiag.survivalUi.myRole !== 'eliminated' ||
      !c1SpecBenchDiag.spectator.active ||
      c1SpecBenchDiag.match?.phase !== 'playing'
    ) {
      throw new Error(`Expected Client 1 in active eliminated spectator state for Scene 4: ${JSON.stringify(c1SpecBenchDiag)}`);
    }
    await cdp1.eval(`
      window.__DEV_GAME_TOOLS__.setSpectatorTarget('${client2Id}');
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
    `);

    for (const q of ['medium', 'low']) {
      await runSceneBenchmark(
        q,
        'spectator_camera',
        'Eliminated/spectator camera following an active moving contender in forest_survival',
        async () => {
          await cdp1.eval(`
            window.__DEV_CAMERA_OVERRIDE__ = null;
            window.__DEV_PLAYER_POSE_LOCK__ = null;
            window.__DEV_GAME_TOOLS__.setSpectatorTarget('${client2Id}');
            window.__DEV_GAME_TOOLS__.setThirdPerson(true);
          `);
          await cdp2.eval(`
            (() => {
              if (window.__BENCH_C2_TIMER__) clearInterval(window.__BENCH_C2_TIMER__);
              let s = 0;
              window.__BENCH_C2_TIMER__ = setInterval(() => {
                s += 0.05;
                window.__DEV_GAME_TOOLS__?.setSyntheticInput({
                  fwd: Math.cos(s * 0.4) >= -0.2 ? 1 : -1,
                  right: Math.sin(s * 0.75) * 0.65,
                  jump: false,
                  walk: false,
                  yaw: Math.sin(s * 0.35) * 1.15,
                  pitch: -0.08,
                });
              }, 50);
            })()
          `);
        },
        async () => {
          await cdp2.eval(`
            (() => {
              if (window.__BENCH_C2_TIMER__) {
                clearInterval(window.__BENCH_C2_TIMER__);
                window.__BENCH_C2_TIMER__ = null;
              }
              window.__DEV_GAME_TOOLS__?.setSyntheticInput(null);
            })()
          `);
        },
      );
    }

    // Close Client 2 & Client 3 tabs before the 10x room reload memory test
    const cdp2ConsoleErrors = [...cdp2.consoleErrors];
    const cdp3ConsoleErrors = [...cdp3.consoleErrors];
    const cdp2NetworkErrors = [...cdp2.networkErrors];
    const cdp3NetworkErrors = [...cdp3.networkErrors];
    cdp2.close();
    cdp3.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${pageTarget2Id}`).catch(() => {});
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${pageTarget3Id}`).catch(() => {});
    await cdp1.send('Page.bringToFront');
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setQuality('medium')`);
    await delay(250);

    // =========================================================================
    // STEP 10: 10x Consecutive `forest_survival` Room Reload Memory & GPU Check
    // =========================================================================
    console.log(
      '\n[Stage 07 QA] Step 10: Running 10x consecutive `forest_survival` room reload memory & GPU resource disposal check...',
    );
    const camOverview = lookAtCamera({ x: 0, y: 175, z: 95 }, { x: 0, y: 0, z: -10 });
    const roomReloadMemoryTrend = [];

    for (let cycle = 1; cycle <= 10; cycle++) {
      await cdp1.eval(`document.getElementById('btn-leave').click()`);
      await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
      await delay(180);
      await cdp1.eval(`
        (() => {
          const modeEl = document.getElementById('room-mode');
          modeEl.value = 'forest_survival';
          modeEl.dispatchEvent(new Event('change', { bubbles: true }));
          document.getElementById('room-name').value = 'Stage07_MemCycle_${cycle}';
          document.getElementById('btn-create').click();
        })()
      `);
      await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
      await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics().allLoaded === true`);
      await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getLootDiagnostics().lootSnapshot?.containers?.length === 26`);
      await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics().isSurvival === true`);
      await cdp1.eval(`
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(0, -10, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(camOverview)};
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
    const programDelta = lastCycle.programs - steadyCycle.programs;
    const heapDeltaMB =
      lastCycle.heapUsedMB !== null && steadyCycle.heapUsedMB !== null
        ? Number((lastCycle.heapUsedMB - steadyCycle.heapUsedMB).toFixed(2))
        : 0;
    const leakDetected = geometryDelta > 4 || textureDelta > 4 || heapDeltaMB > 45;

    const allConsoleErrors = [...cdp1.consoleErrors, ...cdp2ConsoleErrors, ...cdp3ConsoleErrors];
    const allNetworkErrors = [...cdp1.networkErrors, ...cdp2NetworkErrors, ...cdp3NetworkErrors];

    const cpus = os.cpus();
    const benchmarkReport = {
      stage:
        "BOSQICH 07 — Forest Survival (Oxirgi Tirik Qolgan) O'yin Sikli, Kuzatuvchi Rejimi va Yakuniy Raund Tizimi",
      timestamp: new Date().toISOString(),
      methodology: {
        warmupSeconds: WARMUP_SEC,
        measurementSeconds: DURATION_SEC,
        repeatsPerScene: REPEATS,
        viewport: '1280x720',
        devicePixelRatio: 1,
        qualities: ['medium', 'low'],
        scenes: [
          'survival_spawn_and_loot',
          'poi_container_interaction',
          'final_1v1_combat',
          'spectator_camera',
        ],
        mode: 'forest_survival',
        bots: 0,
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
        lobbyUiAndStage06AuditFix1: {
          lobbyModeSelectLocks: lobbyUiState,
          classicFfaNotInLootMode: {
            openCode: auditFix1Checks.openAck1.code,
            pickupCode: auditFix1Checks.pickupAck.code,
            equipCode: auditFix1Checks.equipAck.code,
            medkitCode: auditFix1Checks.medkitAck.code,
          },
          passed: true,
        },
        waitingAndCountdownLifecycle: {
          waitingPhase: waitingDiag.match?.phase,
          waitingReadyCount: waitingDiag.match?.readyCount,
          waitingMinPlayers: waitingDiag.match?.minPlayers,
          preRoundContainerGuardCode: waitingOpenAck.code,
          countdownPhase: countdownDiag.match?.phase,
          countdownReadyCount: countdownDiag.match?.readyCount,
          countdownTimeLeftSec: countdownDiag.match?.timeLeft,
          passed: true,
        },
        round1UnarmedAndLootVerification: {
          roundId: 1,
          aliveCount: 2,
          totalContenders: 2,
          client1UnarmedOnStart: r1C1Loot.inventorySnap?.equippedWeapon === null,
          client2UnarmedOnStart: r1C2Loot.inventorySnap?.equippedWeapon === null,
          all26ContainersClosedOnStart: r1AllClosed1 && r1AllClosed2,
          openedContainerId: cnt3Id,
          equippedWeaponAfterPickup: equippedWepR1,
          passed: true,
        },
        midRoundSpectatorJoinVerification: {
          client3Role: c3MidJoinDiag.survivalUi.myRole,
          spectatorBannerVisible: c3MidJoinDiag.survivalUi.spectatorBannerVisible,
          spectatorActive: c3MidJoinDiag.spectator.active,
          spectatorMode: c3MidJoinDiag.spectator.mode,
          aliveCountUnchanged: c3MidJoinDiag.match?.aliveCount === 2,
          totalContendersUnchanged: c3MidJoinDiag.match?.totalContenders === 2,
          cycleSpectatorTargetVerified: true,
          spectatorOpenContainerRejectedCode: specOpenAck.code,
          passed: true,
        },
        eliminationNoRespawnAndWinnerVerification: {
          firstHitClient2Hp: firstHitRes.hp,
          client2EliminatedRole: c2ElimDiag.survivalUi.myRole,
          client2SpectatingTargetId: c2ElimDiag.spectator.targetId,
          noRespawnAfter3500MsInRound1: c2NoRespawnR1.alive === false,
          noRespawnAfter3500MsInActivePlayRound2: c2InPlayNoRespawn.alive === false && c2InPlayNoRespawn.phase === 'playing',
          round1WinnerId: c1WinDiag.match?.winnerId,
          round1WinReason: c1WinDiag.match?.winReason,
          winnerOverlayVisible: c1WinDiag.survivalUi.winnerOverlayVisible,
          passed: true,
        },
        multiRoundResetVerification: {
          round2StartedCleanly: r2C1Surv.match?.roundId === 2 && r2C1Surv.match?.aliveCount === 3 && r2C1Surv.match?.totalContenders === 3,
          formerMidJoinSpectatorPromotedToContender: r2C3Surv.survivalUi.myRole === 'contender',
          round2AllUnarmed: true,
          round2All26ContainersClosed: r2AllClosed,
          round3StartedCleanly: r3C1Surv.match?.roundId === 3 && r3C1Surv.match?.aliveCount === 3,
          round3All26ContainersClosed: r3AllClosed,
          roundTransitionMemoryTrend,
          passed: true,
        },
        protocolAndModeIsolation: protoChecks,
        consoleErrorsCount: allConsoleErrors.length,
        networkErrorsCount: allNetworkErrors.length,
        consoleErrors: allConsoleErrors,
        networkErrors: allNetworkErrors,
      },
      resultsByQuality,
      scenes: resultsByQuality.medium,
      qualityPresets: {
        low: {
          final_1v1_combat: resultsByQuality.low.final_1v1_combat,
          spectator_camera: resultsByQuality.low.spectator_camera,
        },
        medium: {
          final_1v1_combat: resultsByQuality.medium.final_1v1_combat,
          spectator_camera: resultsByQuality.medium.spectator_camera,
        },
      },
      memoryTest10xReload: {
        cycles: roomReloadMemoryTrend,
        roundTransitionMemoryTrend,
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
      roomReloadMemoryTrend,
      screenshots: screenshots
        .slice()
        .sort((a, b) => a.filename.localeCompare(b.filename))
        .map((s) => ({
          filename: s.filename,
          bytes: s.bytes,
          width: s.width,
          height: s.height,
        })),
    };

    fs.writeFileSync(BENCHMARK_JSON_PATH, JSON.stringify(benchmarkReport, null, 2));
    console.log(`\n[Stage 07 QA] Saved benchmark JSON to ${BENCHMARK_JSON_PATH}`);

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
      'activeLootMeshes',
      'visibleLootMeshes',
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
          row.lootWorldRenderer?.activeItemMeshCount ?? 0,
          row.lootWorldRenderer?.visibleItemMeshCount ?? 0,
          row.cullingProfile?.avgCpuMs ?? 0,
          row.cullingProfile?.p95CpuMs ?? 0,
          row.cullingProfile?.evaluatedFrames ?? 0,
          row.cullingProfile?.skippedStaticFrames ?? 0,
          row.heapUsedMB ?? '',
        ].join(','),
      ),
    ];

    fs.writeFileSync(BENCHMARK_CSV_PATH, csvLines.join('\n') + '\n');
    console.log(`[Stage 07 QA] Saved benchmark CSV to ${BENCHMARK_CSV_PATH}`);

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

    console.log('\n[Stage 07 QA] ALL CHECKS, 12 SCREENSHOTS, AND SUSTAINED BENCHMARKS COMPLETED SUCCESSFULLY!');
    cdp1.close();
  } finally {
    if (chromeProc) killTree(chromeProc.pid);
    if (serverProc) killTree(serverProc.pid);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('[Stage 07 QA] FAILED:', err);
  process.exit(1);
});
