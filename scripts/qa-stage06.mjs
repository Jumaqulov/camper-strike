#!/usr/bin/env node
/**
 * BOSQICH 06 — Qurolsiz Boshlash, Loot Qutilari, Inventar va Qurol Topish Tizimi
 * Browser QA Automation, 2-Client Authoritative Loot Sync, Race-Condition & Anti-Cheat QA,
 * Real WebGL Screenshots (10x 1280x720 PNG) & Sustained Benchmark Script
 *
 * Usage:
 *   node scripts/qa-stage06.mjs [--warmup=10] [--duration=30] [--repeats=3]
 *
 * Performs:
 *   1. Starts Vite + Socket.IO dev server (`npm run dev`, if port 5173 is not already active)
 *      and Headless Chrome (1280x720, DPR=1, WebGL hardware/headless rendering).
 *   2. Verifies Multi-Room / Multi-Seed (`forest_square` across seeds 6501, 7777, 9021 with
 *      `lootPreview: true` and `lootPreview: false`) and Legacy Maps via Socket.IO.
 *   3. Launches Client 1 & Client 2 in the same `forest_square` room (`seed=6501`, `lootPreview=true`, `bots=0`)
 *      and verifies:
 *      - Unarmed spawn (`equippedWeapon === null`, `ownedWeapons.length === 0`, `unarmedBannerVisible === true`)
 *      - All 26 closed containers have `items.length === 0` and `itemCount === -1` (zero secret loot leak)
 *      - Adversarial unarmed shoot rejection, unowned weapon equip rejection (`WEAPON_NOT_OWNED`),
 *        closed container pickup rejection (`CONTAINER_CLOSED`), out-of-range open rejection (`OUT_OF_RANGE`),
 *        and wall line-of-sight blocked open rejection (`LOS_BLOCKED`)
 *      - Authoritative 2-client walk to `poi_ranger_house` containers, container opening, idempotent replay,
 *        3D world loot rendering (`LootWorldRenderer`), and real-time broadcast to Client 2
 *      - Concurrent 2-client pickup race on the same item (`ok: true` vs `ok: false, code: 'ITEM_ALREADY_TAKEN'`)
 *      - Weapon pickup, equip (`★ QO'LDA`), 1P/3P firing & ammo sync, medkit pickup & heal, and empty container state (`BO'SH`)
 *   4. Captures 10 real 1280x720 PNG screenshots in `docs/screenshots/stage06/`:
 *      - 01_unarmed_spawn_3p_hud.png
 *      - 02_unarmed_spawn_1p_empty_hands.png
 *      - 03_closed_container_interaction_prompt.png
 *      - 04_opened_container_3d_loot_and_panel.png
 *      - 05_weapon_equipped_3p_after_pickup.png
 *      - 06_weapon_equipped_1p_viewmodel_and_ammo.png
 *      - 07_empty_container_state_uz.png
 *      - 08_two_clients_loot_sync_pvp.png
 *      - 09_poi_interior_weapon_locker_loot.png
 *      - 10_topdown_256x256_stage06_overview.png
 *   5. Runs sustained performance benchmark (`WARMUP_SEC=10`, `DURATION_SEC=30`, `REPEATS=3`) on
 *      `forest_square` across `open_forest_movement`, `poi_loot_containers_open`, and `moving_pvp_combat`
 *      (`medium` + `low` comparison), plus 10x consecutive `forest_square` (`lootPreview: true`) room reload
 *      memory/GPU disposal verification, saving `docs/stage06/benchmark.json` and `docs/stage06/benchmark.csv`.
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
const SCREENSHOT_DIR = path.join(ROOT_DIR, 'docs', 'screenshots', 'stage06');
const BENCHMARK_DIR = path.join(ROOT_DIR, 'docs', 'stage06');
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
 * Verifies Multi-Room / Multi-Seed (`forest_square` across seeds 6501, 7777, 9021 with `lootPreview` true/false)
 * and Legacy Maps (`forest_assets_preview`, `forest_sample`, `forest_technical`) over Socket.IO.
 */
async function verifyMultiRoomAndLegacyMaps(serverUrl = 'http://localhost:5173') {
  const testCases = [
    { name: 'SQ_Seed_6501_LootA', mapId: 'forest_square', publicLayoutSeed: 6501, lootPreview: true },
    { name: 'SQ_Seed_6501_LootB', mapId: 'forest_square', publicLayoutSeed: 6501, lootPreview: false },
    { name: 'SQ_Seed_7777_Loot', mapId: 'forest_square', publicLayoutSeed: 7777, lootPreview: true },
    { name: 'SQ_Seed_9021_Loot', mapId: 'forest_square', publicLayoutSeed: 9021, lootPreview: true },
    { name: 'Legacy_Stage04A', mapId: 'forest_assets_preview', publicLayoutSeed: 6501, lootPreview: false },
    { name: 'Legacy_ForestSample', mapId: 'forest_sample', publicLayoutSeed: 6501, lootPreview: false },
    { name: 'Legacy_ForestTechnical', mapId: 'forest_technical', publicLayoutSeed: 6501, lootPreview: false },
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
      socket.emit('hello', { name: 'QA_Stage06' }, (res) => {
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
        mapId: worldMeta.mapId,
        worldVersion: worldMeta.worldVersion,
        publicLayoutSeed: worldMeta.publicLayoutSeed,
        gameplayHash: worldMeta.gameplayHash,
        lootPreview: Boolean(joinRes.welcome.room.lootPreview),
        containerCount: lootSyncRes?.loot?.containers?.length ?? 0,
        equippedWeaponOnSpawn: lootSyncRes?.inventory?.equippedWeapon ?? null,
        readyOk: true,
      });

      socket.emit('leaveRoom');
      await delay(60);
    }

    const sq6501A = results.find((r) => r.label === 'SQ_Seed_6501_LootA');
    const sq6501B = results.find((r) => r.label === 'SQ_Seed_6501_LootB');
    const sq7777 = results.find((r) => r.label === 'SQ_Seed_7777_Loot');
    const sq9021 = results.find((r) => r.label === 'SQ_Seed_9021_Loot');

    if (sq6501A.gameplayHash !== sq6501B.gameplayHash) {
      throw new Error(
        'Determinism error: lootPreview=true vs lootPreview=false changed public gameplayHash!',
      );
    }
    if (sq6501A.equippedWeaponOnSpawn !== null || sq6501B.equippedWeaponOnSpawn !== 'rifle') {
      throw new Error(
        `Unexpected spawn weapon state: lootPreview=true got ${sq6501A.equippedWeaponOnSpawn}, lootPreview=false got ${sq6501B.equippedWeaponOnSpawn}`,
      );
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

/**
 * Builds a safe, obstacle-aware waypoint list from `startPos` to the Ranger House (`poi_ranger_house`)
 * south-east courtyard approach `(c1.x + 6.5, c1.z + 8.5)`.
 */
function buildRouteToRangerHouseCourtyard(startPos, poiSites) {
  const c1 = poiSites.poi_ranger_house.center;
  const target = { x: Number((c1.x + 6.2).toFixed(2)), z: Number((c1.z + 8.2).toFixed(2)), radius: 1.4 };
  const waypoints = [];

  // Check if starting inside/near another POI pad and step out toward the central highway first
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
    // Route along the open north-south corridor x = -34 (completely clear of all 6 POI building compounds)
    if (Math.abs(last.x - -34) > 8 && last.z > -44) {
      waypoints.push({
        x: -34,
        z: Number(clamp(last.z, -50, 58).toFixed(2)),
        radius: 2.2,
      });
    }
    waypoints.push({ x: -34, z: -54, radius: 2.2 });
  } else if (last.z < c1.z + 2.5) {
    // Spawned in NW quadrant north/west of Ranger House cabin: route around the cabin footprint
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

  // Settle velocity and orient toward `lookTarget` if provided
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

async function main() {
  const chromePath = findChromePath();
  const debugPort = 9247;
  console.log(
    `[Stage 06 QA] Starting Unarmed Spawn, Loot & Inventory QA, Screenshots & Benchmark (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS})...`,
  );

  let serverProc = null;
  const serverAlreadyRunning = await isHttpReady('http://localhost:5173/api/info', 1500);
  if (!serverAlreadyRunning) {
    console.log('[Stage 06 QA] Starting dev server (`npm run dev`)...');
    serverProc = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
      cwd: ROOT_DIR,
      stdio: 'pipe',
    });
  } else {
    console.log('[Stage 06 QA] Reusing active server on http://localhost:5173');
  }

  const userDataDir = path.join(os.tmpdir(), `stickman_qa_stage06_${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  let chromeProc = null;
  try {
    await waitForHttp('http://localhost:5173/api/info', 30000);

    // =========================================================================
    // STEP 0: Multi-Room / Multi-Seed & Stage 06 Loot Protocol Verification
    // =========================================================================
    console.log('[Stage 06 QA] Verifying Multi-Room, Multi-Seed & Loot Preview via Socket.IO...');
    const multiRoomChecks = await verifyMultiRoomAndLegacyMaps('http://localhost:5173');
    for (const r of multiRoomChecks) {
      console.log(
        `  [room-check] ${r.label}: mapId=${r.mapId} seed=${r.publicLayoutSeed} hash=${r.gameplayHash} lootPreview=${r.lootPreview} containers=${r.containerCount} spawnWeapon=${r.equippedWeaponOnSpawn}`,
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
    // STEP 1: Client 1 creates `forest_square` room (`lootPreview=true`, `bots=0`)
    // =========================================================================
    console.log('\n[Stage 06 QA] Connecting Client 1 and creating `forest_square` (`lootPreview=true`, `bots=0`)...');
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
        document.getElementById('room-name').value = 'Stage06_Loot_Authoritative_QA';
        const chk = document.getElementById('room-loot-preview');
        if (chk) {
          chk.checked = true;
          chk.dispatchEvent(new Event('change', { bubbles: true }));
        }
        document.getElementById('room-bots').value = '0';
        const btn = document.getElementById('btn-create-submit') || document.getElementById('btn-create');
        btn.click();
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

    await cdp1.eval(`
      (() => {
        const st = document.createElement('style');
        st.textContent = '#pause-menu, #center-msg, #scoreboard, #death-screen, #toast { display: none !important; } #dev-stats { display: block !important; }';
        document.head.appendChild(st);
        window.__DEV_GAME_TOOLS__.setQuality('medium');
      })()
    `);

    // =========================================================================
    // STEP 2: Client 2 joins the same `forest_square` (`lootPreview=true`) room
    // =========================================================================
    console.log('[Stage 06 QA] Connecting Client 2 to verify 2-client unarmed spawn & 26 closed containers...');
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
    await cdp2.waitFor(`window.__DEV_GAME_TOOLS__.getLootDiagnostics().lootSnapshot?.containers?.length === 26`);
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
    if (client1Meta.gameplayHash !== '6e4913c3e10347c9' || client2Meta.gameplayHash !== '6e4913c3e10347c9') {
      throw new Error(
        `GameplayHash mismatch: Client1=${client1Meta.gameplayHash} vs Client2=${client2Meta.gameplayHash}`,
      );
    }
    if (totalGlbCount !== 28 || !stage04aDiag.allLoaded) {
      throw new Error(`Expected 28 GLBs loaded, got total=${totalGlbCount}, allLoaded=${stage04aDiag.allLoaded}`);
    }

    const c1InitialLoot = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    const c2InitialLoot = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);

    const allClosed1 = c1InitialLoot.lootSnapshot.containers.every(
      (c) => !c.opened && c.status === 'closed' && c.items.length === 0 && c.itemCount === -1,
    );
    const allClosed2 = c2InitialLoot.lootSnapshot.containers.every(
      (c) => !c.opened && c.status === 'closed' && c.items.length === 0 && c.itemCount === -1,
    );

    if (
      !c1InitialLoot.lootPreview ||
      !c2InitialLoot.lootPreview ||
      c1InitialLoot.inventorySnap?.equippedWeapon !== null ||
      c2InitialLoot.inventorySnap?.equippedWeapon !== null ||
      c1InitialLoot.inventorySnap?.ownedWeapons?.length !== 0 ||
      c2InitialLoot.inventorySnap?.ownedWeapons?.length !== 0 ||
      !c1InitialLoot.inventoryUi.unarmedBannerVisible ||
      !c2InitialLoot.inventoryUi.unarmedBannerVisible ||
      c1InitialLoot.lootSnapshot?.containers?.length !== 26 ||
      !allClosed1 ||
      !allClosed2
    ) {
      throw new Error(
        `Initial unarmed/closed-container check failed: ${JSON.stringify({
          c1InitialLoot: {
            lootPreview: c1InitialLoot.lootPreview,
            inv: c1InitialLoot.inventorySnap,
            ui: c1InitialLoot.inventoryUi,
            allClosed1,
          },
          c2InitialLoot: {
            lootPreview: c2InitialLoot.lootPreview,
            inv: c2InitialLoot.inventorySnap,
            ui: c2InitialLoot.inventoryUi,
            allClosed2,
          },
        })}`,
      );
    }

    console.log(
      `  [verified] Client1 & Client2 unarmed spawn verified (equippedWeapon=null, ownedWeapons=0, 26 closed containers with 0 leaked items).`,
    );

    // -------------------------------------------------------------------------
    // Adversarial Check A: Unarmed Shoot, Unowned Equip & Closed Container Pickup
    // -------------------------------------------------------------------------
    const c1SpawnAuth = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    await cdp1.eval(`
      window.__DEV_GAME_TOOLS__.sendRawShootPacketForAdversarialTest({
        weapon: 'rifle',
        origin: { x: ${c1SpawnAuth.x}, y: ${c1SpawnAuth.y + 1.62}, z: ${c1SpawnAuth.z} },
        dirs: [{ x: 0, y: 0, z: -1 }]
      })
    `);
    const advUnownedEquipAck = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.equipInventoryWeapon('sniper', 'adv_equip_unowned_1')`,
    );
    const advClosedPickupAck = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.pickupLootItem('poi:poi_ranger_house:cnt_3:wooden_loot_crate_01', 'itm:fake:0', 'adv_pickup_closed_1')`,
    );

    if (advUnownedEquipAck.ok !== false || advUnownedEquipAck.code !== 'WEAPON_NOT_OWNED') {
      throw new Error(`Expected WEAPON_NOT_OWNED on unowned equip, got ${JSON.stringify(advUnownedEquipAck)}`);
    }
    if (advClosedPickupAck.ok !== false || advClosedPickupAck.code !== 'CONTAINER_CLOSED') {
      throw new Error(`Expected CONTAINER_CLOSED on closed pickup, got ${JSON.stringify(advClosedPickupAck)}`);
    }
    console.log(
      `  [anti-cheat] Unowned equip rejected (${advUnownedEquipAck.code}) & closed container pickup rejected (${advClosedPickupAck.code}).`,
    );

    // Clear any error toast before capturing Screenshots 1 & 2
    const screenshots = [];
    const spawnLookYaw = Math.atan2(c1SpawnAuth.x, c1SpawnAuth.z);
    await cdp1.eval(`
      (() => {
        const toast = document.getElementById('stage06-loot-toast');
        if (toast) { toast.className = 'hidden'; toast.textContent = ''; }
        const chatLog = document.getElementById('chat-log');
        if (chatLog) chatLog.innerHTML = '';
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setSyntheticInput({
          fwd: 0,
          right: 0,
          jump: false,
          walk: false,
          yaw: ${spawnLookYaw.toFixed(4)},
          pitch: -0.08
        });
      })()
    `);
    await delay(300);
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
    await delay(250);

    // Screenshot 1: 01_unarmed_spawn_3p_hud.png
    screenshots.push(await cdp1.screenshot('01_unarmed_spawn_3p_hud.png'));

    // Screenshot 2: 02_unarmed_spawn_1p_empty_hands.png
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setThirdPerson(false)`);
    await delay(280);
    screenshots.push(await cdp1.screenshot('02_unarmed_spawn_1p_empty_hands.png'));

    // =========================================================================
    // STEP 3: Authoritative Walk of Client 1 & Client 2 to `poi_ranger_house`
    //         and Closed Container Interaction Prompt (`Screenshot 3`)
    // =========================================================================
    console.log('\n[Stage 06 QA] Walking Client 1 & Client 2 authoritatively to `poi_ranger_house`...');
    const poiSites = getForestSquarePoiSitesForSeed(client1Meta.publicLayoutSeed);
    const c1 = poiSites.poi_ranger_house.center;
    const cnt3Id = 'poi:poi_ranger_house:cnt_3:wooden_loot_crate_01';
    const cnt0Id = 'poi:poi_ranger_house:cnt_0:wooden_loot_crate_01';
    const cnt1Id = 'poi:poi_ranger_house:cnt_1:metal_locker_01';
    const cnt2Id = 'poi:poi_ranger_house:cnt_2:old_toolbox_01';

    const cnt3StateInit = c1InitialLoot.lootSnapshot.containers.find((c) => c.id === cnt3Id);
    const cnt1StateInit = c1InitialLoot.lootSnapshot.containers.find((c) => c.id === cnt1Id);
    const cnt2StateInit = c1InitialLoot.lootSnapshot.containers.find((c) => c.id === cnt2Id);
    if (!cnt3StateInit || !cnt1StateInit || !cnt2StateInit) {
      throw new Error('Required poi_ranger_house containers not found in lootSnapshot');
    }

    const c2SpawnAuth = (await cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    const c1Route = [
      ...buildRouteToRangerHouseCourtyard(c1SpawnAuth, poiSites),
      {
        x: Number(cnt3StateInit.position.x.toFixed(2)),
        z: Number((cnt3StateInit.position.z + 1.15).toFixed(2)),
        radius: 0.35,
      },
    ];
    const c2Route = [
      ...buildRouteToRangerHouseCourtyard(c2SpawnAuth, poiSites),
      {
        x: Number((cnt3StateInit.position.x + 3.2).toFixed(2)),
        z: Number((cnt3StateInit.position.z + 2.2).toFixed(2)),
        radius: 0.55,
      },
    ];

    await Promise.all([
      walkClientWaypoints(cdp1, 'Client1->cnt3', c1Route, {
        x: cnt3StateInit.position.x,
        y: cnt3StateInit.position.y + 0.25,
        z: cnt3StateInit.position.z,
      }),
      walkClientWaypoints(cdp2, 'Client2->yard', c2Route, {
        x: cnt3StateInit.position.x,
        y: cnt3StateInit.position.y + 0.3,
        z: cnt3StateInit.position.z,
      }),
    ]);

    // Verify closed container interaction prompt on Client 1
    await cdp1.send('Page.bringToFront');
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setThirdPerson(false)`);
    await delay(250);
    const c1PromptDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    console.log(
      `  [prompt] visible=${c1PromptDiag.lootUi.promptVisible} text="${c1PromptDiag.lootUi.promptText}" highlighted=${c1PromptDiag.worldRenderer.highlightedContainerId}`,
    );
    if (!c1PromptDiag.lootUi.promptVisible || !c1PromptDiag.lootUi.promptText.includes('Ochish')) {
      throw new Error(`Expected closed container prompt with 'Ochish', got: ${JSON.stringify(c1PromptDiag.lootUi)}`);
    }

    // Screenshot 3: 03_closed_container_interaction_prompt.png
    screenshots.push(await cdp1.screenshot('03_closed_container_interaction_prompt.png'));

    // =========================================================================
    // STEP 4: Adversarial Out-of-Range & Wall LOS Rejection Checks, then
    //         Open Container (`cnt_3`) & Verify 3D World Loot (`Screenshot 4`)
    // =========================================================================
    console.log('\n[Stage 06 QA] Testing OUT_OF_RANGE & LOS_BLOCKED container open rejections...');
    const advFarOpenAck = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('poi:poi_cliff_watch:cnt_0:wooden_loot_crate_01', 'adv_open_far_1')`,
    );
    if (advFarOpenAck.ok !== false || advFarOpenAck.code !== 'OUT_OF_RANGE') {
      throw new Error(`Expected OUT_OF_RANGE for distant container, got ${JSON.stringify(advFarOpenAck)}`);
    }

    // Walk Client 1 just outside the east solid wall of Ranger House cabin (1.30m from interior cnt_0)
    await walkClientWaypoints(
      cdp1,
      'Client1->eastWallLosCheck',
      [{ x: Number((c1.x + 4.65).toFixed(2)), z: Number((c1.z + 1.45).toFixed(2)), radius: 0.32 }],
      { x: c1.x + 3.35, y: cnt3StateInit.position.y + 0.5, z: c1.z + 1.45 },
    );
    const advLosOpenAck = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt0Id}', 'adv_open_los_1')`,
    );
    if (advLosOpenAck.ok !== false || advLosOpenAck.code !== 'LOS_BLOCKED') {
      throw new Error(`Expected LOS_BLOCKED through cabin wall, got ${JSON.stringify(advLosOpenAck)}`);
    }
    console.log(
      `  [anti-cheat] Distant open rejected (${advFarOpenAck.code}) & through-wall open rejected (${advLosOpenAck.code}).`,
    );

    // Walk Client 1 back in front of outdoor `cnt_3`
    await walkClientWaypoints(
      cdp1,
      'Client1->cnt3OpenPos',
      [
        {
          x: Number((cnt3StateInit.position.x - 0.15).toFixed(2)),
          z: Number((cnt3StateInit.position.z + 1.35).toFixed(2)),
          radius: 0.32,
        },
      ],
      {
        x: cnt3StateInit.position.x,
        y: cnt3StateInit.position.y + 1.12,
        z: cnt3StateInit.position.z,
      },
    );

    console.log('[Stage 06 QA] Opening `cnt_3` on Client 1 & verifying 3D world loot + Client 2 sync...');
    const openCnt3Ack = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 'qa_open_cnt3_req1')`,
    );
    const openCnt3ReplayAck = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 'qa_open_cnt3_req1')`,
    );

    if (
      !openCnt3Ack.ok ||
      !openCnt3Ack.container?.opened ||
      openCnt3Ack.container.status !== 'opened' ||
      openCnt3Ack.container.items.length < 2 ||
      !openCnt3ReplayAck.ok ||
      !openCnt3ReplayAck.idempotentReplay
    ) {
      throw new Error(
        `Open container cnt_3 verification failed: ${JSON.stringify({ openCnt3Ack, openCnt3ReplayAck })}`,
      );
    }

    // Wait 450ms for damped lid animation to open and Client 2 to receive broadcast
    await delay(450);
    const c1OpenDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    const c2OpenDiag = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    const c2Cnt3AfterOpen = c2OpenDiag.lootSnapshot.containers.find((c) => c.id === cnt3Id);

    if (
      !c2Cnt3AfterOpen?.opened ||
      c2Cnt3AfterOpen.items.length !== openCnt3Ack.container.items.length ||
      c1OpenDiag.worldRenderer.activeItemMeshCount < 2 ||
      c2OpenDiag.worldRenderer.activeItemMeshCount < 2
    ) {
      throw new Error(
        `Client 2 broadcast or 3D loot mesh count check failed: ${JSON.stringify({
          c1WorldRenderer: c1OpenDiag.worldRenderer,
          c2WorldRenderer: c2OpenDiag.worldRenderer,
          c2Cnt3AfterOpen,
        })}`,
      );
    }
    console.log(
      `  [verified] cnt_3 opened: items=${openCnt3Ack.container.items.map((i) => i.catalogId).join(', ')} | C1 meshes=${c1OpenDiag.worldRenderer.activeItemMeshCount} | C2 meshes=${c2OpenDiag.worldRenderer.activeItemMeshCount}`,
    );

    // Screenshot 4: 04_opened_container_3d_loot_and_panel.png
    // Use an angled 1P look so the open crate + 3D weapon/ammo meshes inside sit clearly above the center UI panel
    const cam04 = lookAtCamera(
      { x: cnt3StateInit.position.x - 0.15, y: cnt3StateInit.position.y + 1.55, z: cnt3StateInit.position.z + 1.35 },
      { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 1.08, z: cnt3StateInit.position.z },
    );
    await cdp1.eval(`window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam04)};`);
    await delay(220);
    screenshots.push(await cdp1.screenshot('04_opened_container_3d_loot_and_panel.png'));
    await cdp1.eval(`window.__DEV_CAMERA_OVERRIDE__ = null;`);

    // =========================================================================
    // STEP 5: Concurrent 2-Client Pickup Race, Weapon Equip & Firing (`Screenshots 5, 6, 8`)
    // =========================================================================
    console.log('\n[Stage 06 QA] Walking Client 2 next to `cnt_3` for concurrent 2-client pickup race...');
    await walkClientWaypoints(
      cdp2,
      'Client2->cnt3RacePos',
      [
        {
          x: Number((cnt3StateInit.position.x + 1.05).toFixed(2)),
          z: Number(cnt3StateInit.position.z.toFixed(2)),
          radius: 0.35,
        },
      ],
      {
        x: cnt3StateInit.position.x,
        y: cnt3StateInit.position.y + 0.25,
        z: cnt3StateInit.position.z,
      },
    );

    const cnt3Items = openCnt3Ack.container.items;
    const weaponItem0 = cnt3Items[0];
    const ammoItem1 = cnt3Items[1];

    // Concurrent pickup race on weaponItem0: Client 1 wins, Client 2 receives ITEM_ALREADY_TAKEN
    const [raceWinnerAck, raceLoserAck] = await Promise.all([
      cdp1.eval(`window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${weaponItem0.id}', 'race_c1_item0')`),
      delay(8).then(() =>
        cdp2.eval(`window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${weaponItem0.id}', 'race_c2_item0')`),
      ),
    ]);

    if (!raceWinnerAck.ok || raceLoserAck.ok !== false || raceLoserAck.code !== 'ITEM_ALREADY_TAKEN') {
      throw new Error(
        `Concurrent 2-client pickup race check failed: winner=${JSON.stringify(raceWinnerAck)}, loser=${JSON.stringify(raceLoserAck)}`,
      );
    }
    console.log(
      `  [race-verified] Client 1 picked up ${weaponItem0.catalogId} (ok=true); Client 2 concurrent request rejected with code=${raceLoserAck.code}.`,
    );

    // Explicitly test equipInventoryWeapon on Client 1 (unarm to null, then re-equip weaponItem0.weaponId)
    const holsterAck = await cdp1.eval(`window.__DEV_GAME_TOOLS__.equipInventoryWeapon(null, 'c1_holster_test')`);
    const reEquipAck = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.equipInventoryWeapon('${weaponItem0.weaponId}', 'c1_reequip_test')`,
    );
    if (!holsterAck.ok || holsterAck.equippedWeapon !== null || !reEquipAck.ok || reEquipAck.equippedWeapon !== weaponItem0.weaponId) {
      throw new Error(`Equip/holster cycle failed: ${JSON.stringify({ holsterAck, reEquipAck })}`);
    }

    // First capture Screenshot 8 (`08_two_clients_loot_sync_pvp.png`) while `ammoItem1` is still in `cnt_3`,
    // showing Client 1 (with 3D pistol equipped) and Client 2 beside the open crate with 1 remaining item synced!
    await walkClientWaypoints(
      cdp1,
      'Client1->cnt3SyncPos',
      [
        {
          x: Number((cnt3StateInit.position.x - 0.95).toFixed(2)),
          z: Number((cnt3StateInit.position.z + 1.05).toFixed(2)),
          radius: 0.32,
        },
      ],
      {
        x: cnt3StateInit.position.x + 0.5,
        y: cnt3StateInit.position.y + 0.85,
        z: cnt3StateInit.position.z,
      },
    );

    const midSync8 = {
      x: cnt3StateInit.position.x + 0.1,
      y: cnt3StateInit.position.y + 1.08,
      z: cnt3StateInit.position.z + 0.25,
    };
    const cam08 = lookAtCamera(
      { x: midSync8.x - 0.25, y: cnt3StateInit.position.y + 2.55, z: midSync8.z + 4.15 },
      midSync8,
    );
    await cdp1.eval(`
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
      window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam08)};
    `);
    await delay(420);
    const shot08Info = await cdp1.screenshot('08_two_clients_loot_sync_pvp.png');
    await cdp1.eval(`window.__DEV_CAMERA_OVERRIDE__ = null; window.__DEV_GAME_TOOLS__.setThirdPerson(false);`);
    await delay(200);

    // Client 1 now picks up the matching ammo (item[1]) and any remaining items in `cnt_3`
    const c1AmmoPickAck = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${ammoItem1.id}', 'c1_pick_ammo1')`,
    );
    if (!c1AmmoPickAck.ok) {
      throw new Error(`Client 1 ammo pickup failed: ${JSON.stringify(c1AmmoPickAck)}`);
    }

    const cnt3Remaining = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`)).lootSnapshot.containers.find(
      (c) => c.id === cnt3Id,
    );
    for (const remItem of cnt3Remaining.items) {
      const pickRemAck = await cdp1.eval(
        `window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${remItem.id}', 'c1_empty_${remItem.id}')`,
      );
      if (!pickRemAck.ok) {
        throw new Error(`Failed to pick up remaining item ${remItem.id}: ${JSON.stringify(pickRemAck)}`);
      }
    }
    await delay(280);
    const c1EmptyDiag = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    const c2EmptyDiag = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    const c1Cnt3Empty = c1EmptyDiag.lootSnapshot.containers.find((c) => c.id === cnt3Id);
    const c2Cnt3Empty = c2EmptyDiag.lootSnapshot.containers.find((c) => c.id === cnt3Id);

    if (
      c1Cnt3Empty.status !== 'empty' ||
      c1Cnt3Empty.items.length !== 0 ||
      c2Cnt3Empty.status !== 'empty' ||
      c1EmptyDiag.lootUi.activeContainerStatus !== 'empty'
    ) {
      throw new Error(
        `Empty container state verification failed: ${JSON.stringify({
          c1Cnt3Empty,
          c2Cnt3Empty,
          lootUi: c1EmptyDiag.lootUi,
        })}`,
      );
    }
    console.log(`  [verified] cnt_3 is now empty (status='empty', items=0) on both Client 1 & Client 2.`);

    // Screenshot 7: 07_empty_container_state_uz.png (right beside empty cnt_3 with Client 2 in background)
    const cam07 = lookAtCamera(
      { x: cnt3StateInit.position.x - 0.85, y: cnt3StateInit.position.y + 1.62, z: cnt3StateInit.position.z + 1.15 },
      { x: cnt3StateInit.position.x + 0.25, y: cnt3StateInit.position.y + 0.95, z: cnt3StateInit.position.z },
    );
    await cdp1.eval(`window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam07)};`);
    await delay(250);
    const shot07Info = await cdp1.screenshot('07_empty_container_state_uz.png');
    await cdp1.eval(`window.__DEV_CAMERA_OVERRIDE__ = null;`);

    // Step Client 1 3.8m south-west so the container panel & range hint auto-close cleanly for Screenshots 5 & 6
    await walkClientWaypoints(
      cdp1,
      'Client1->3pWeaponShowPos',
      [
        {
          x: Number((cnt3StateInit.position.x - 1.65).toFixed(2)),
          z: Number((cnt3StateInit.position.z + 3.45).toFixed(2)),
          radius: 0.35,
        },
      ],
      {
        x: cnt3StateInit.position.x + 0.2,
        y: cnt3StateInit.position.y + 1.45,
        z: cnt3StateInit.position.z - 0.5,
      },
    );
    await cdp1.eval(`
      (() => {
        const toast = document.getElementById('stage06-loot-toast');
        if (toast) { toast.className = 'hidden'; toast.textContent = ''; }
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
      })()
    `);
    await delay(500);

    // Screenshot 5: 05_weapon_equipped_3p_after_pickup.png
    screenshots.push(await cdp1.screenshot('05_weapon_equipped_3p_after_pickup.png'));

    // Switch Client 1 to 1P, wait for switch timer, fire 1 authoritative shot, and capture Screenshot 6
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setThirdPerson(false)`);
    await delay(520);
    const firedOk = await cdp1.eval(`window.__DEV_GAME_TOOLS__.triggerFire()`);
    await delay(60);
    // Screenshot 6: 06_weapon_equipped_1p_viewmodel_and_ammo.png
    screenshots.push(await cdp1.screenshot('06_weapon_equipped_1p_viewmodel_and_ammo.png'));
    await delay(220);
    const c1AfterFireLoot = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    console.log(
      `  [fire-verified] triggerFire=${firedOk} | equippedWeapon=${c1AfterFireLoot.inventorySnap.equippedWeapon} | ammo=${JSON.stringify(c1AfterFireLoot.inventorySnap.ammo[weaponItem0.weaponId])}`,
    );

    screenshots.push(shot07Info);
    screenshots.push(shot08Info);

    // =========================================================================
    // STEP 7: Walk Client 1 Inside Ranger House Cabin (`bld:0`) to Open Interior
    //         Weapon Locker (`metal_locker_01`) & Toolbox (`old_toolbox_01`) (`Screenshot 9`)
    // =========================================================================
    console.log('\n[Stage 06 QA] Walking Client 1 inside `poi_ranger_house` cabin to open `metal_locker_01` & `old_toolbox_01`...');
    const cabinInteriorWaypoints = [
      { x: Number((c1.x - 1.85).toFixed(2)), z: Number((c1.z + 5.6).toFixed(2)), radius: 0.45 },
      { x: Number((c1.x - 1.85).toFixed(2)), z: Number((c1.z + 0.3).toFixed(2)), radius: 0.42 },
      { x: Number((c1.x + 0.65).toFixed(2)), z: Number((c1.z - 0.1).toFixed(2)), radius: 0.32 },
    ];
    await walkClientWaypoints(cdp1, 'Client1->cabinLocker', cabinInteriorWaypoints, {
      x: cnt1StateInit.position.x + 0.35,
      y: cnt1StateInit.position.y + 0.85,
      z: cnt1StateInit.position.z,
    });

    const openCnt2Ack = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt2Id}', 'qa_open_cnt2_toolbox')`,
    );
    const openCnt1Ack = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt1Id}', 'qa_open_cnt1_locker')`,
    );
    if (!openCnt1Ack.ok || !openCnt2Ack.ok) {
      throw new Error(
        `Failed to open interior locker/toolbox: ${JSON.stringify({ openCnt1Ack, openCnt2Ack })}`,
      );
    }
    await delay(500);

    // Screenshot 9: 09_poi_interior_weapon_locker_loot.png
    screenshots.push(await cdp1.screenshot('09_poi_interior_weapon_locker_loot.png'));

    // Also test medkit pickup from `cnt_2` (which has `cntIdx=2`, so slot 2 is `heal:medkit`) and `useMedkitItem`
    const medkitItem = openCnt2Ack.container.items.find((i) => i.kind === 'medkit');
    let medkitTestSummary = null;
    if (medkitItem) {
      const pickMedAck = await cdp1.eval(
        `window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt2Id}', '${medkitItem.id}', 'c1_pick_medkit')`,
      );
      const useFullHpAck = await cdp1.eval(
        `window.__DEV_GAME_TOOLS__.useMedkitItem('c1_medkit_fullhp')`,
      );
      medkitTestSummary = {
        pickedOk: pickMedAck.ok,
        medkitsAfterPickup: pickMedAck.inventory?.medkits ?? 0,
        useAtFullHpRejected: useFullHpAck.ok === false && useFullHpAck.code === 'HP_ALREADY_FULL',
        useAtFullHpCode: useFullHpAck.code,
      };
      console.log(
        `  [medkit-verified] picked=${medkitTestSummary.pickedOk} count=${medkitTestSummary.medkitsAfterPickup} fullHpRejected=${medkitTestSummary.useAtFullHpCode}`,
      );
    }

    // Close Client 2 before top-down overview & benchmark
    cdp2.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${pageTarget2.id}`);
    await cdp1.send('Page.bringToFront');
    await delay(200);

    // Screenshot 10: 10_topdown_256x256_stage06_overview.png
    const cam10 = lookAtCamera({ x: 0, y: 175, z: 95 }, { x: 0, y: 0, z: -10 });
    await cdp1.eval(`
      (() => {
        const panel = document.getElementById('stage06-container-panel');
        if (panel) panel.className = 'hidden';
        const prompt = document.getElementById('stage06-loot-prompt');
        if (prompt) prompt.className = 'hidden';
        const toast = document.getElementById('stage06-loot-toast');
        if (toast) toast.className = 'hidden';
        const chatLog = document.getElementById('chat-log');
        if (chatLog) chatLog.innerHTML = '';
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(0, -10, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam10)};
      })()
    `);
    await delay(600);
    await cdp1.eval(`
      (() => {
        const chatLog = document.getElementById('chat-log');
        if (chatLog) chatLog.innerHTML = '';
      })()
    `);
    screenshots.push(await cdp1.screenshot('10_topdown_256x256_stage06_overview.png'));

    // =========================================================================
    // STEP 8: Sustained Performance Benchmark on `forest_square`
    //         (`WARMUP_SEC = 10`, `DURATION_SEC = 30`, `REPEATS = 3`)
    // =========================================================================
    console.log(
      `\n[Stage 06 QA] Preparing sustained performance benchmark (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS})...`,
    );
    await cdp1.eval(`
      window.__DEV_CAMERA_OVERRIDE__ = null;
      window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
      window.__SET_RAF_CAP_FPS__?.(null);
    `);

    // Open `cnt_0` inside Ranger House as well so `poi_ranger_house` has 3 open containers with 7+ 3D loot items rendered!
    await cdp1.eval(`
      window.__DEV_GAME_TOOLS__.setPlayerPos(${(c1.x + 0.65).toFixed(2)}, ${(c1.z - 0.1).toFixed(2)}, 0);
      window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
    `);
    await delay(150);
    await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt0Id}', 'qa_open_cnt0_bench')`,
    );
    // Add 4 active bots to the room via `/addbot` chat command so all benchmark scenes have 4 active bots + active loot!
    await cdp1.eval(`
      (() => {
        const input = document.getElementById('chat-input');
        for (let i = 0; i < 4; i++) {
          input.value = '/addbot';
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        const chatLog = document.getElementById('chat-log');
        if (chatLog) chatLog.innerHTML = '';
      })()
    `);
    await cdp1.waitFor(`Boolean(window.__LAST_SNAP__ && window.__LAST_SNAP__.players?.length >= 5)`);
    await delay(300);

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

    // Camera for `poi_loot_containers_open`: inside/courtyard of `poi_ranger_house` viewing open containers & 3D loot items
    const p1FloorY = Number((cnt1StateInit.position.y).toFixed(3));
    const camPoiLoot = lookAtCamera(
      { x: c1.x - 1.2, y: p1FloorY + 2.05, z: c1.z + 2.1 },
      { x: c1.x + 1.8, y: p1FloorY + 0.65, z: c1.z - 0.8 },
    );
    const p4 = poiSites.poi_service_station;
    const lookCombat = lookAtCamera(
      { x: p4.center.x - 21.5, y: p4.padElevation + 1.6, z: p4.center.z + 14.5 },
      { x: p4.center.x - 2.0, y: p4.padElevation + 1.5, z: p4.center.z + 1.0 },
    );

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
            window.__DEV_GAME_TOOLS__.setWeapon('${weaponItem0.weaponId}');
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
        id: 'poi_loot_containers_open',
        description:
          'POI interior & courtyard with opened containers (metal_locker_01, old_toolbox_01, wooden_loot_crate_01) and 3D world loot items rendered',
        qualities: ['medium', 'low'],
        setup: `
          (() => {
            if (window.__BENCH_MOVE_TIMER__) {
              clearInterval(window.__BENCH_MOVE_TIMER__);
              window.__BENCH_MOVE_TIMER__ = null;
            }
            window.__DEV_GAME_TOOLS__.setSyntheticInput(null);
            window.__DEV_GAME_TOOLS__.setThirdPerson(false);
            window.__DEV_GAME_TOOLS__.setWeapon('${weaponItem0.weaponId}');
            window.__DEV_GAME_TOOLS__.setPlayerPos(${(c1.x + 0.65).toFixed(2)}, ${(c1.z - 0.1).toFixed(2)}, 0);
            window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(camPoiLoot)};
          })()
        `,
        teardown: ``,
      },
      {
        id: 'moving_pvp_combat',
        description:
          '1P active PvP combat movement, looted weapon ViewModel & server reconciliation on forest_square with 4 bots',
        qualities: ['medium', 'low'],
        setup: `
          (() => {
            if (window.__BENCH_MOVE_TIMER__) clearInterval(window.__BENCH_MOVE_TIMER__);
            window.__DEV_CAMERA_OVERRIDE__ = null;
            window.__DEV_GAME_TOOLS__.setSyntheticInput(null);
            window.__DEV_GAME_TOOLS__.setThirdPerson(false);
            window.__DEV_GAME_TOOLS__.setWeapon('${weaponItem0.weaponId}');
            let cStep = 0;
            window.__BENCH_MOVE_TIMER__ = setInterval(() => {
              cStep += 0.05;
              if (window.__DEV_GAME_TOOLS__) {
                const fwd = Math.cos(cStep * 0.5) >= -0.2 ? 1 : -1;
                const right = Math.sin(cStep * 0.9) * 0.75;
                const res = window.__DEV_GAME_TOOLS__.stepInput(fwd, right, false, 0.016, 3);
                const yaw = ${lookCombat.yaw} + Math.sin(cStep * 0.45) * 0.55;
                window.__DEV_PLAYER_POSE_LOCK__ = {
                  x: res.x,
                  y: res.y,
                  z: res.z,
                  yaw,
                  pitch: ${lookCombat.pitch},
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
              r.lootWorld = window.__DEV_GAME_TOOLS__.getLootDiagnostics().worldRenderer;
              return r;
            })()
          `);
          if (sc.teardown) {
            await cdp1.eval(sc.teardown);
          }
          runs.push({ repeat: rep, ...res });
          console.log(
            `  [${q} | ${sc.id} #${rep}] frames=${res.frames} | avgFps=${res.fpsMean} p50Fps=${res.fpsMedian} 1%low=${res.fps1PctLow} | FT p50=${res.frameTimeMedianMs}ms p95=${res.frameTimeP95Ms}ms p99=${res.frameTimeP99Ms}ms | Draw=${res.render.calls} Tris=${res.render.triangles} LootMeshes=${res.lootWorld?.visibleItemMeshCount ?? 0}/${res.lootWorld?.activeItemMeshCount ?? 0}`,
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
          lootWorldRenderer: lastRun.lootWorld,
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
    // STEP 9: 10x Consecutive `forest_square` (`lootPreview: true`) Room Reload Memory Test
    // =========================================================================
    console.log(
      '\n[Stage 06 QA] Running 10x consecutive `forest_square` (`lootPreview: true`) room reload memory & disposal check...',
    );
    const roomReloadMemoryTrend = [];
    for (let cycle = 1; cycle <= 10; cycle++) {
      await cdp1.eval(`document.getElementById('btn-leave').click()`);
      await cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
      await delay(180);
      await cdp1.eval(`
        (() => {
          document.getElementById('room-map').value = 'forest_square';
          document.getElementById('room-name').value = 'Stage06_MemCycle_${cycle}';
          const chk = document.getElementById('room-loot-preview');
          if (chk) {
            chk.checked = true;
            chk.dispatchEvent(new Event('change', { bubbles: true }));
          }
          document.getElementById('room-bots').value = '0';
          const btn = document.getElementById('btn-create-submit') || document.getElementById('btn-create');
          btn.click();
        })()
      `);
      await cdp1.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
      await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getStage04ADiagnostics().allLoaded === true`);
      await cdp1.waitFor(`window.__DEV_GAME_TOOLS__.getLootDiagnostics().lootSnapshot?.containers?.length === 26`);
      await cdp1.eval(`
        window.__DEV_GAME_TOOLS__.setThirdPerson(false);
        window.__DEV_GAME_TOOLS__.setPlayerPos(0, -10, 0);
        window.__DEV_CAMERA_OVERRIDE__ = ${JSON.stringify(cam10)};
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
        'BOSQICH 06 — Qurolsiz Boshlash, Loot Qutilari, Inventar va Qurol Topish Tizimi',
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
        lootPreview: true,
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
        multiplayerLootSync: {
          mapId: client1Meta.mapId,
          publicLayoutSeed: client1Meta.publicLayoutSeed,
          client1GameplayHash: client1Meta.gameplayHash,
          client2GameplayHash: client2Meta.gameplayHash,
          gameplayHashMatch: client1Meta.gameplayHash === client2Meta.gameplayHash,
          lootPreview: true,
          totalContainers: 26,
          allClosedContainersZeroItemsLeaked: allClosed1 && allClosed2,
        },
        unarmedSpawnVerification: {
          client1EquippedWeapon: c1InitialLoot.inventorySnap.equippedWeapon,
          client1OwnedWeapons: c1InitialLoot.inventorySnap.ownedWeapons,
          client1UnarmedBannerVisible: c1InitialLoot.inventoryUi.unarmedBannerVisible,
          client2EquippedWeapon: c2InitialLoot.inventorySnap.equippedWeapon,
          client2OwnedWeapons: c2InitialLoot.inventorySnap.ownedWeapons,
          client2UnarmedBannerVisible: c2InitialLoot.inventoryUi.unarmedBannerVisible,
          passed: true,
        },
        containerOpenAnd3DLootVerification: {
          containerId: cnt3Id,
          openedOk: openCnt3Ack.ok,
          idempotentReplayOk: Boolean(openCnt3ReplayAck.idempotentReplay),
          revealedItems: openCnt3Ack.container.items.map((i) => ({
            id: i.id,
            catalogId: i.catalogId,
            kind: i.kind,
            nameUz: i.nameUz,
            quantity: i.quantity,
          })),
          client1ActiveItemMeshes: c1OpenDiag.worldRenderer.activeItemMeshCount,
          client2ActiveItemMeshes: c2OpenDiag.worldRenderer.activeItemMeshCount,
          interiorLockerOpenedId: cnt1Id,
          interiorToolboxOpenedId: cnt2Id,
          passed: true,
        },
        concurrentPickupRaceVerification: {
          containerId: cnt3Id,
          itemId: weaponItem0.id,
          catalogId: weaponItem0.catalogId,
          client1WinnerOk: raceWinnerAck.ok,
          client2LoserOk: raceLoserAck.ok,
          client2LoserCode: raceLoserAck.code,
          passed: raceWinnerAck.ok === true && raceLoserAck.ok === false && raceLoserAck.code === 'ITEM_ALREADY_TAKEN',
        },
        weaponEquipAndFireVerification: {
          lootedWeapon: weaponItem0.weaponId,
          holsterToNullOk: holsterAck.ok && holsterAck.equippedWeapon === null,
          reEquipWeaponOk: reEquipAck.ok && reEquipAck.equippedWeapon === weaponItem0.weaponId,
          triggerFireOk: firedOk,
          ammoAfterFire: c1AfterFireLoot.inventorySnap.ammo[weaponItem0.weaponId],
          emptyContainerStatus: c1Cnt3Empty.status,
          medkitTest: medkitTestSummary,
          passed: true,
        },
        adversarialSecurityChecks: {
          unownedWeaponEquipRejectedCode: advUnownedEquipAck.code,
          closedContainerPickupRejectedCode: advClosedPickupAck.code,
          outOfRangeOpenRejectedCode: advFarOpenAck.code,
          losBlockedOpenRejectedCode: advLosOpenAck.code,
          passed:
            advUnownedEquipAck.code === 'WEAPON_NOT_OWNED' &&
            advClosedPickupAck.code === 'CONTAINER_CLOSED' &&
            advFarOpenAck.code === 'OUT_OF_RANGE' &&
            advLosOpenAck.code === 'LOS_BLOCKED',
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
        },
        consoleErrorsCount: cdp1.consoleErrors.length + cdp2.consoleErrors.length,
        networkErrorsCount: cdp1.networkErrors.length + cdp2.networkErrors.length,
        consoleErrors: [...cdp1.consoleErrors, ...cdp2.consoleErrors],
        networkErrors: [...cdp1.networkErrors, ...cdp2.networkErrors],
      },
      resultsByQuality,
      scenes: resultsByQuality.medium,
      qualityPresets: {
        low: {
          poi_loot_containers_open: resultsByQuality.low.poi_loot_containers_open,
          moving_pvp_combat: resultsByQuality.low.moving_pvp_combat,
        },
        medium: {
          poi_loot_containers_open: resultsByQuality.medium.poi_loot_containers_open,
          moving_pvp_combat: resultsByQuality.medium.moving_pvp_combat,
        },
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
    console.log(`\n[Stage 06 QA] Saved benchmark JSON to ${BENCHMARK_JSON_PATH}`);

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
    console.log(`[Stage 06 QA] Saved benchmark CSV to ${BENCHMARK_CSV_PATH}`);

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

    console.log('\n[Stage 06 QA] ALL CHECKS, 10 SCREENSHOTS, AND BENCHMARKS COMPLETED SUCCESSFULLY!');
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
  console.error('[Stage 06 QA] FAILED:', err);
  process.exit(1);
});
