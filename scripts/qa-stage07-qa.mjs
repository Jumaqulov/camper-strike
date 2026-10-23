#!/usr/bin/env node
/**
 * BOSQICH 07-QA — Forest Survival Stabilization (Fast Multi-Client Live Browser Smoke QA)
 *
 * Verifies:
 *   1. 3-Client `forest_survival` Room (`seed=6501`) where all 3 clients join before countdown
 *      ends and spawn unarmed in Round 1 (`playing`, `roundId = 1`, `aliveCount = 3`, `totalContenders = 3`).
 *   2. Live P1 Check (Missing/Stale `roundId`/`spawnId`):
 *      - Raw `container:open` without `roundId`/`spawnId` -> `ok: false, code: 'INVALID_REQUEST'`
 *      - Raw `container:open` with stale `roundId: 99, spawnId: 1` -> `ok: false, code: 'INVALID_REQUEST'`
 *      - Valid `openContainerById` and `pickupLootItem` -> `ok: true`
 *   3. Live P1 Check (`shoot` Weapon Equip & Switch Cooldown):
 *      - Client 1 loots 2 weapons (`W1` equipped, `W2` in inventory)
 *      - Sending raw `shoot` packet with unequipped `W2` does NOT mutate `equippedWeapon` (`W1`)
 *        and does NOT decrement `W2` magazine ammo
 *      - Calling `equipInventoryWeapon(W2)` and waiting `switchTime` (`500ms`) equips `W2`
 *   4. Live P2 Check (Eliminated Spectator Replay of Old `requestId`):
 *      - Client 1 eliminates Client 2 (`aliveCount = 2`, Round 1 stays `playing`, Client 2 enters spectator mode)
 *      - Eliminated Client 2 replays `'c2_valid_open_r1'` and `'c2_valid_pick_r1'`
 *      - Both ACKs return `ok: false, code: 'PLAYER_DEAD'` and `!ack.idempotentReplay`
 *   5. Live P0 Check (Grenade Explosion / Round End & Transition to Round 2):
 *      - Live grenade detonation + Client 3 elimination -> Client 1 wins Round 1 (`phase = 'ended'`)
 *      - Automatic transition to Round 2 (`roundId = 2`, `phase = 'playing'`)
 *      - All 3 clients reset to unarmed (`equippedWeapon = null`, `ownedWeapons.length = 0`) and all 26 containers closed
 *      - Client 2 emits raw `container:open` with Round 1's old context (`roundId: 1, spawnId: 1`) -> `ok: false, code: 'INVALID_REQUEST'`
 *      - Quick 5-second smoke FPS capture in `medium` quality
 *   6. Zero console errors, zero uncaught page exceptions, and zero failed network requests across all 3 clients.
 *
 * Outputs:
 *   - `docs/stage07qa/smoke_qa.json`
 *   - `docs/screenshots/stage07qa/01_round1_3clients_unarmed_start.png`
 *   - `docs/screenshots/stage07qa/02_eliminated_spectator_replay_blocked.png`
 *   - `docs/screenshots/stage07qa/03_round1_winner_and_clean_end.png`
 *   - `docs/screenshots/stage07qa/04_round2_fresh_reset_and_smoke_fps.png`
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT_DIR = process.cwd();
const SCREENSHOT_DIR = path.join(ROOT_DIR, 'docs', 'screenshots', 'stage07qa');
const REPORT_DIR = path.join(ROOT_DIR, 'docs', 'stage07qa');
const REPORT_JSON_PATH = path.join(REPORT_DIR, 'smoke_qa.json');

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
    window.__NEXT_OPEN_PAYLOAD_OVERRIDE__ = null;
    window.__CREATE_ROOM_OVERRIDES__ = null;
    window.__EXPLOSION_EVENTS__ = [];

    window.WebSocket = class extends OrigWebSocket {
      constructor(...args) {
        super(...args);
        window.__GAME_WS__ = this;
        this.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string' && ev.data.startsWith('42[')) {
            try {
              const parsed = JSON.parse(ev.data.slice(2));
              if (Array.isArray(parsed)) {
                if (parsed[0] === 'snap') {
                  window.__LAST_SNAP__ = parsed[1];
                } else if (parsed[0] === 'explosion') {
                  window.__EXPLOSION_EVENTS__.push(parsed[1]);
                }
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
              if (Array.isArray(arr) && arr[0] === 'container:open' && window.__NEXT_OPEN_PAYLOAD_OVERRIDE__) {
                const overridePayload = window.__NEXT_OPEN_PAYLOAD_OVERRIDE__;
                window.__NEXT_OPEN_PAYLOAD_OVERRIDE__ = null;
                return super.send(prefix + JSON.stringify(['container:open', overridePayload]));
              }
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

    window.__EMIT_RAW_CONTAINER_OPEN__ = (rawPayload) => {
      window.__NEXT_OPEN_PAYLOAD_OVERRIDE__ = rawPayload;
      return window.__DEV_GAME_TOOLS__.openContainerById(
        rawPayload.containerId || 'poi:poi_ranger_house:cnt_3:wooden_loot_crate_01',
        rawPayload.requestId || 'raw_req',
      );
    };

    window.__EMIT_RAW_GRENADE_THROW__ = (dir) => {
      if (window.__GAME_WS__ && window.__GAME_WS__.readyState === 1) {
        window.__GAME_WS__.send('42' + JSON.stringify(['grenade', { dir }]));
        return true;
      }
      return false;
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
        const surv = window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics();
        return {
          hp: p ? p.hp : 100,
          alive: p ? p.alive : true,
          myRole: surv.survivalUi.myRole,
        };
      })()`),
    ]);

    if (!tgtSnapState.alive || tgtSnapState.hp <= 0 || tgtSnapState.myRole === 'eliminated') {
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
      if (!document.getElementById('qa-stage07qa-clean-hud')) {
        const st = document.createElement('style');
        st.id = 'qa-stage07qa-clean-hud';
        st.textContent = '#pause-menu, #center-msg, #scoreboard, #death-screen, #toast { display: none !important; } #dev-stats { display: block !important; }';
        document.head.appendChild(st);
      }
      window.__DEV_GAME_TOOLS__?.setQuality('medium');
    })()
  `);
}

async function main() {
  const chromePath = findChromePath();
  const debugPort = 9257;
  const roomName = `Stage07QA_Smoke_${Date.now().toString().slice(-4)}`;
  console.log('[Stage 07-QA] Starting Fast 3-Client Live Browser Smoke QA...');

  let serverProc = null;
  const serverAlreadyRunning = await isHttpReady('http://localhost:5173/api/info', 1500);
  if (!serverAlreadyRunning) {
    console.log('[Stage 07-QA] Starting dev server (`npm run dev`)...');
    serverProc = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
      cwd: ROOT_DIR,
      stdio: 'pipe',
    });
  } else {
    console.log('[Stage 07-QA] Reusing active dev server on http://localhost:5173');
  }

  const userDataDir = path.join(os.tmpdir(), `stickman_qa_stage07qa_${Date.now()}`);
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

    // Open Client 2 and Client 3 tabs right away so all 3 clients enter the Lobby before room creation
    const [{ cdp: cdp2, targetId: pageTarget2Id }, { cdp: cdp3, targetId: pageTarget3Id }] = await Promise.all([
      openNewClientTab(debugPort, 'Client2'),
      openNewClientTab(debugPort, 'Client3'),
    ]);

    const screenshots = [];

    // =========================================================================
    // STEP 1: All 3 Clients enter Lobby; Client 1 creates `forest_survival` (seed=6501),
    //         Client 2 & Client 3 join during countdown -> All 3 spawn unarmed in Round 1!
    // =========================================================================
    console.log('\n[Stage 07-QA] Step 1: Connecting Client 1, Client 2 & Client 3 to Lobby...');
    await Promise.all([
      cdp1.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`),
      cdp2.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`),
      cdp3.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`),
    ]);

    await Promise.all([
      cdp1.eval(`(() => { document.getElementById('name-input').value = 'Ranger_Alpha'; document.getElementById('btn-enter').click(); })()`),
      cdp2.eval(`(() => { document.getElementById('name-input').value = 'Scout_Bravo'; document.getElementById('btn-enter').click(); })()`),
      cdp3.eval(`(() => { document.getElementById('name-input').value = 'Sniper_Charlie'; document.getElementById('btn-enter').click(); })()`),
    ]);

    await Promise.all([
      cdp1.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`),
      cdp2.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`),
      cdp3.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`),
    ]);

    console.log(`  [room-create] Client 1 creating forest_survival room '${roomName}' (seed=6501, countdownSec=5)...`);
    await cdp1.eval(`
      (() => {
        window.__CREATE_ROOM_OVERRIDES__ = { publicLayoutSeed: 6501, countdownSec: 5 };
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

    // Refresh room list on Client 2 & Client 3 and join simultaneously before countdown ends
    console.log('  [room-join] Client 2 & Client 3 joining before countdown finishes...');
    await Promise.all([
      cdp2.eval(`document.getElementById('btn-refresh')?.click()`),
      cdp3.eval(`document.getElementById('btn-refresh')?.click()`),
    ]);

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
    await Promise.all([cdp2.waitFor(joinScript), cdp3.waitFor(joinScript)]);
    await Promise.all([
      cdp2.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`),
      cdp3.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`),
    ]);

    await Promise.all([injectCleanHudStyles(cdp1), injectCleanHudStyles(cdp2), injectCleanHudStyles(cdp3)]);

    // Ensure all 3D assets are loaded on Client 1
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

    // Wait for Round 1 (`playing`, `roundId === 1`) to start on all 3 clients
    console.log('  [round-1] Waiting for countdown to finish and Round 1 (`playing`, `roundId=1`, `3/3 contenders`) to start...');
    await Promise.all([
      cdp1.waitFor(
        `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 1`,
        20000,
      ),
      cdp2.waitFor(
        `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 1`,
        20000,
      ),
      cdp3.waitFor(
        `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 1`,
        20000,
      ),
    ]);
    await delay(250);

    const [r1C1Surv, r1C2Surv, r1C3Surv, r1C1Loot, r1C2Loot, r1C3Loot] = await Promise.all([
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`),
      cdp2.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`),
      cdp3.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`),
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`),
      cdp2.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`),
      cdp3.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`),
    ]);

    const r1AllClosed = r1C1Loot.lootSnapshot.containers.every(
      (c) => !c.opened && c.status === 'closed' && c.items.length === 0 && c.itemCount === -1,
    );

    if (
      r1C1Surv.match?.phase !== 'playing' ||
      r1C1Surv.match?.roundId !== 1 ||
      r1C1Surv.match?.aliveCount !== 3 ||
      r1C1Surv.match?.totalContenders !== 3 ||
      r1C1Surv.survivalUi.myRole !== 'contender' ||
      r1C2Surv.survivalUi.myRole !== 'contender' ||
      r1C3Surv.survivalUi.myRole !== 'contender' ||
      r1C1Loot.inventorySnap?.equippedWeapon !== null ||
      r1C2Loot.inventorySnap?.equippedWeapon !== null ||
      r1C3Loot.inventorySnap?.equippedWeapon !== null ||
      r1C1Loot.inventorySnap?.ownedWeapons?.length !== 0 ||
      r1C2Loot.inventorySnap?.ownedWeapons?.length !== 0 ||
      r1C3Loot.inventorySnap?.ownedWeapons?.length !== 0 ||
      !r1AllClosed
    ) {
      throw new Error(
        `Round 1 3-client unarmed start verification failed: ${JSON.stringify({
          r1C1Surv,
          r1C2Surv,
          r1C3Surv,
          c1Inv: r1C1Loot.inventorySnap,
          c2Inv: r1C2Loot.inventorySnap,
          c3Inv: r1C3Loot.inventorySnap,
          r1AllClosed,
        })}`,
      );
    }
    console.log(
      `  [verified] Round 1 started with 3 contenders: roundId=1, aliveCount=3/3, all 3 clients unarmed (equippedWeapon=null), all 26 containers closed.`,
    );

    // Orient Client 1 nicely and capture Screenshot 01: `01_round1_3clients_unarmed_start.png`
    const c1R1SpawnPos = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    const r1SpawnYaw = Math.atan2(c1R1SpawnPos.x, c1R1SpawnPos.z);
    await cdp1.eval(`
      (() => {
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__DEV_GAME_TOOLS__.setSyntheticInput({
          fwd: 0, right: 0, jump: false, walk: false,
          yaw: ${r1SpawnYaw.toFixed(4)}, pitch: -0.08
        });
      })()
    `);
    await delay(200);
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.setSyntheticInput(null)`);
    await delay(180);

    screenshots.push(await cdp1.screenshot('01_round1_3clients_unarmed_start.png'));

    // =========================================================================
    // STEP 2: Walk all 3 clients to `poi_ranger_house` in parallel:
    //         - Client 2 -> `cnt_3` (courtyard crate) for Live P1 Missing/Stale Context check
    //         - Client 1 -> `poi_ranger_house` cabin interior (`cnt_2`, `cnt_1`, `cnt_0`) for 2-weapon loot
    //         - Client 3 -> `poi_ranger_house` courtyard for combat & round end
    // =========================================================================
    console.log('\n[Stage 07-QA] Step 2: Walking Client 1, Client 2 & Client 3 to `poi_ranger_house`...');
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

    const [c2R1SpawnPos, c3R1SpawnPos] = await Promise.all([
      cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos`),
      cdp3.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos`),
    ]);

    await Promise.all([
      walkClientWaypoints(
        cdp1,
        'R1_Client1->cabinInterior',
        [
          ...buildRouteToRangerHouseCourtyard(c1R1SpawnPos, poiSites),
          { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 5.6).toFixed(2)), radius: 0.45 },
          { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 0.3).toFixed(2)), radius: 0.42 },
          { x: Number((c1Site.x + 0.65).toFixed(2)), z: Number((c1Site.z - 0.1).toFixed(2)), radius: 0.34 },
        ],
        { x: cnt1StateInit.position.x, y: cnt1StateInit.position.y + 0.8, z: cnt1StateInit.position.z },
      ),
      walkClientWaypoints(
        cdp2,
        'R1_Client2->cnt3',
        [
          ...buildRouteToRangerHouseCourtyard(c2R1SpawnPos, poiSites),
          {
            x: Number((cnt3StateInit.position.x - 0.15).toFixed(2)),
            z: Number((cnt3StateInit.position.z + 1.35).toFixed(2)),
            radius: 0.34,
          },
        ],
        { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 0.95, z: cnt3StateInit.position.z },
      ),
      walkClientWaypoints(
        cdp3,
        'R1_Client3->yard',
        [
          ...buildRouteToRangerHouseCourtyard(c3R1SpawnPos, poiSites),
          {
            x: Number((cnt3StateInit.position.x + 2.65).toFixed(2)),
            z: Number((cnt3StateInit.position.z + 3.25).toFixed(2)),
            radius: 0.45,
          },
        ],
        { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 0.9, z: cnt3StateInit.position.z },
      ),
    ]);

    // =========================================================================
    // Live P1 Check #1: Missing / Stale `roundId` & `spawnId` Rejection on Client 2
    // =========================================================================
    console.log('\n[Stage 07-QA] Step 2A (Live P1 Check): Verifying missing & stale `roundId`/`spawnId` rejection on Client 2...');
    const rawNoContextAck = await cdp2.eval(`
      window.__EMIT_RAW_CONTAINER_OPEN__({
        requestId: 'raw_no_context',
        containerId: '${cnt3Id}'
      })
    `);
    const rawStaleRoundAck = await cdp2.eval(`
      window.__EMIT_RAW_CONTAINER_OPEN__({
        requestId: 'raw_stale_round',
        containerId: '${cnt3Id}',
        roundId: 99,
        spawnId: 1
      })
    `);

    if (
      rawNoContextAck?.ok !== false ||
      rawNoContextAck?.code !== 'INVALID_REQUEST' ||
      rawStaleRoundAck?.ok !== false ||
      rawStaleRoundAck?.code !== 'INVALID_REQUEST'
    ) {
      throw new Error(
        `Live P1 check (missing/stale roundId/spawnId) failed: ${JSON.stringify({ rawNoContextAck, rawStaleRoundAck })}`,
      );
    }

    // Now have Client 2 call official `openContainerById(cnt3Id, 'c2_valid_open_r1')` and `pickupLootItem(cnt3Id, item0.id, 'c2_valid_pick_r1')`
    const c2ValidOpenR1Ack = await cdp2.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 'c2_valid_open_r1')`,
    );
    if (!c2ValidOpenR1Ack?.ok || !c2ValidOpenR1Ack.container?.opened || !c2ValidOpenR1Ack.container.items?.length) {
      throw new Error(`Client 2 valid openContainerById failed: ${JSON.stringify(c2ValidOpenR1Ack)}`);
    }
    const c2Item0 = c2ValidOpenR1Ack.container.items[0];
    const c2ValidPickR1Ack = await cdp2.eval(
      `window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${c2Item0.id}', 'c2_valid_pick_r1')`,
    );
    if (!c2ValidPickR1Ack?.ok || c2ValidPickR1Ack.pickedItem?.id !== c2Item0.id) {
      throw new Error(`Client 2 valid pickupLootItem failed: ${JSON.stringify(c2ValidPickR1Ack)}`);
    }
    console.log(
      `  [verified] Live P1 Context Guard: raw_no_context -> '${rawNoContextAck.code}', raw_stale_round -> '${rawStaleRoundAck.code}', c2_valid_open_r1 -> ok=true, c2_valid_pick_r1 (${c2Item0.catalogId}) -> ok=true.`,
    );

    // Step Client 2 back 2.2m in the courtyard so its container panel closes cleanly before PvP elimination
    await walkClientWaypoints(
      cdp2,
      'R1_Client2->yardCombatSpot',
      [
        {
          x: Number((cnt3StateInit.position.x + 2.4).toFixed(2)),
          z: Number((cnt3StateInit.position.z + 1.8).toFixed(2)),
          radius: 0.4,
        },
      ],
      { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 1.0, z: cnt3StateInit.position.z },
    );

    // =========================================================================
    // Live P1 Check #2: `shoot` Weapon Equip & Switch Cooldown Validation on Client 1
    // =========================================================================
    console.log('\n[Stage 07-QA] Step 2B (Live P1 Check): Verifying `shoot` weapon equip & switchTime enforcement on Client 1...');
    for (const cid of [cnt2Id, cnt1Id, cnt0Id]) {
      const ack = await cdp1.eval(`window.__DEV_GAME_TOOLS__.openContainerById('${cid}', 'c1_open_${cid}')`);
      if (ack?.ok && ack.container?.items) {
        for (const it of ack.container.items) {
          await cdp1.eval(`window.__DEV_GAME_TOOLS__.pickupLootItem('${cid}', '${it.id}', 'c1_pick_${it.id}')`);
        }
      }
    }

    const c1LootAfterInterior = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`);
    let c1InvSnap = c1LootAfterInterior.inventorySnap;
    if (!c1InvSnap || c1InvSnap.ownedWeapons.length < 2) {
      throw new Error(`Expected Client 1 to own at least 2 weapons after looting cabin, got: ${JSON.stringify(c1InvSnap)}`);
    }

    if (!c1InvSnap.equippedWeapon) {
      const equipW1Ack = await cdp1.eval(
        `window.__DEV_GAME_TOOLS__.equipInventoryWeapon('${c1InvSnap.ownedWeapons[0]}', 'c1_equip_w1_init')`,
      );
      if (!equipW1Ack?.ok) {
        throw new Error(`Initial equipInventoryWeapon(W1) failed: ${JSON.stringify(equipW1Ack)}`);
      }
      await delay(520);
      c1InvSnap = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`)).inventorySnap;
    }

    const w1 = c1InvSnap.equippedWeapon;
    const w2 = c1InvSnap.ownedWeapons.find((w) => w !== w1);
    const w2MagBefore = c1InvSnap.ammo[w2].mag;

    // Send raw `shoot` packet claiming unequipped `w2` without equipping `w2`
    await cdp1.eval(`
      (() => {
        const tr = window.__DEV_GAME_TOOLS__.getPlayerTransform();
        const eye = { x: tr.x, y: tr.y + 1.62, z: tr.z };
        const aim = { x: -Math.sin(tr.yaw), y: 0, z: -Math.cos(tr.yaw) };
        window.__DEV_GAME_TOOLS__.sendRawShootPacketForAdversarialTest({
          weapon: '${w2}',
          origin: eye,
          dirs: [aim]
        });
      })()
    `);
    await delay(160);
    const syncAfterFakeW2Shot = await cdp1.eval(`window.__DEV_GAME_TOOLS__.requestLootSync()`);
    const equippedAfterFakeShot = syncAfterFakeW2Shot.inventory?.equippedWeapon;
    const w2MagAfterFakeShot = syncAfterFakeW2Shot.inventory?.ammo?.[w2]?.mag;

    if (equippedAfterFakeShot !== w1 || w2MagAfterFakeShot !== w2MagBefore) {
      throw new Error(
        `Unequipped weapon shoot test failed: expected equipped='${w1}' & mag=${w2MagBefore}, got equipped='${equippedAfterFakeShot}' & mag=${w2MagAfterFakeShot}`,
      );
    }

    // Now officially equip `w2` and wait for `switchTime` (500ms)
    const equipW2Ack = await cdp1.eval(
      `window.__DEV_GAME_TOOLS__.equipInventoryWeapon('${w2}', 'c1_equip_w2')`,
    );
    await delay(520);
    const invAfterSwitch = (await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics()`)).inventorySnap;
    if (!equipW2Ack?.ok || invAfterSwitch?.equippedWeapon !== w2) {
      throw new Error(`equipInventoryWeapon(${w2}) failed: ${JSON.stringify({ equipW2Ack, invAfterSwitch })}`);
    }
    console.log(
      `  [verified] Live P1 Shoot/Equip Guard: unequipped shoot(${w2}) rejected (equipped remained '${w1}', ${w2} mag stayed ${w2MagAfterFakeShot}); equipInventoryWeapon('${w2}') + 520ms switchTime -> equippedWeapon='${invAfterSwitch.equippedWeapon}'.`,
    );

    // Ensure a multi-shot weapon (`rifle` or `pistol`) is equipped on Client 1 for fast PvP elimination
    const combatWeapon = invAfterSwitch.ownedWeapons.includes('rifle')
      ? 'rifle'
      : invAfterSwitch.ownedWeapons.includes('pistol')
        ? 'pistol'
        : invAfterSwitch.equippedWeapon;
    if (combatWeapon && invAfterSwitch.equippedWeapon !== combatWeapon) {
      await cdp1.eval(`window.__DEV_GAME_TOOLS__.equipInventoryWeapon('${combatWeapon}', 'c1_equip_combat')`);
      await delay(520);
    }

    // =========================================================================
    // STEP 3 (Live P2 Check): Eliminate Client 2 while Client 3 is alive (Round 1 continues in `playing`),
    //                         then replay `'c2_valid_open_r1'` & `'c2_valid_pick_r1'` from eliminated Client 2!
    // =========================================================================
    console.log('\n[Stage 07-QA] Step 3 (Live P2 Check): Eliminating Client 2 & verifying spectator replay of old requestId is blocked...');
    const c2YardPos = (await cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    await walkClientWaypoints(
      cdp1,
      'R1_Client1->courtyardCombat',
      [
        { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 0.3).toFixed(2)), radius: 0.45 },
        { x: Number((c1Site.x - 1.85).toFixed(2)), z: Number((c1Site.z + 6.2).toFixed(2)), radius: 0.45 },
        { x: Number((c2YardPos.x - 2.8).toFixed(2)), z: Number((c2YardPos.z + 0.8).toFixed(2)), radius: 0.38 },
      ],
      { x: c2YardPos.x, y: c2YardPos.y + 1.2, z: c2YardPos.z },
    );

    const killC2Res = await shootTargetAuthoritatively(cdp1, cdp2, {
      stopAfterFirstHit: false,
      aimHead: true,
      maxShots: 16,
    });
    await delay(650);

    const c2ElimSurv = await cdp2.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);
    if (
      c2ElimSurv.match?.phase !== 'playing' ||
      c2ElimSurv.match?.aliveCount !== 2 ||
      c2ElimSurv.match?.totalContenders !== 3 ||
      c2ElimSurv.survivalUi.myRole !== 'eliminated' ||
      !c2ElimSurv.spectator.active
    ) {
      throw new Error(`Expected Client 2 eliminated while Round 1 stays 'playing' (2/3 alive): ${JSON.stringify(c2ElimSurv)}`);
    }

    // Replay `'c2_valid_open_r1'` and `'c2_valid_pick_r1'` on eliminated Client 2
    const replayOpenDeadAck = await cdp2.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 'c2_valid_open_r1')`,
    );
    const replayPickDeadAck = await cdp2.eval(
      `window.__DEV_GAME_TOOLS__.pickupLootItem('${cnt3Id}', '${c2Item0.id}', 'c2_valid_pick_r1')`,
    );

    if (
      replayOpenDeadAck?.ok !== false ||
      replayOpenDeadAck?.code !== 'PLAYER_DEAD' ||
      Boolean(replayOpenDeadAck?.idempotentReplay) !== false ||
      replayPickDeadAck?.ok !== false ||
      replayPickDeadAck?.code !== 'PLAYER_DEAD' ||
      Boolean(replayPickDeadAck?.idempotentReplay) !== false
    ) {
      throw new Error(
        `Live P2 check (eliminated spectator replay of old requestId) failed: ${JSON.stringify({
          replayOpenDeadAck,
          replayPickDeadAck,
        })}`,
      );
    }
    console.log(
      `  [verified] Live P2 Spectator Replay Guard: replayOpenDeadAck -> ok=${replayOpenDeadAck.ok}, code='${replayOpenDeadAck.code}', idempotentReplay=${Boolean(replayOpenDeadAck.idempotentReplay)} | replayPickDeadAck -> ok=${replayPickDeadAck.ok}, code='${replayPickDeadAck.code}', idempotentReplay=${Boolean(replayPickDeadAck.idempotentReplay)}.`,
    );

    // Capture Screenshot 02 on Client 2: `02_eliminated_spectator_replay_blocked.png`
    screenshots.push(await cdp2.screenshot('02_eliminated_spectator_replay_blocked.png'));

    // =========================================================================
    // STEP 4 (Live P0 Check): Grenade Detonation + Eliminate Client 3 -> Round 1 Winner Overlay
    //                         -> Auto-Transition to Round 2 -> Stale Round 1 Context Rejected
    // =========================================================================
    console.log('\n[Stage 07-QA] Step 4 (Live P0 Check): Eliminating Client 3 & verifying Round 1 -> Round 2 transition...');
    const [c1BeforeC3Pos, c3YardPos, c1GrenadeCount] = await Promise.all([
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos`),
      cdp3.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics().authoritativePos`),
      cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics().inventorySnap?.grenades ?? 0`),
    ]);

    let explosionCountR1 = 0;
    if (c1GrenadeCount > 0) {
      const gDir = lookAtCamera(
        { x: c1BeforeC3Pos.x, y: c1BeforeC3Pos.y + 1.5, z: c1BeforeC3Pos.z },
        { x: c3YardPos.x, y: c3YardPos.y + 0.8, z: c3YardPos.z },
      );
      const throwVec = {
        x: Number((-Math.sin(gDir.yaw) * Math.cos(gDir.pitch)).toFixed(4)),
        y: Number(Math.max(0.15, Math.sin(gDir.pitch)).toFixed(4)),
        z: Number((-Math.cos(gDir.yaw) * Math.cos(gDir.pitch)).toFixed(4)),
      };
      await cdp1.eval(`window.__EMIT_RAW_GRENADE_THROW__(${JSON.stringify(throwVec)})`);
      await cdp1.waitFor(`window.__EXPLOSION_EVENTS__.length >= 1`, 5000);
      explosionCountR1 = await cdp1.eval(`window.__EXPLOSION_EVENTS__.length`);
      console.log(`  [verified] Live grenade explosion processed cleanly (explosionCount=${explosionCountR1}).`);
    }

    // Eliminate Client 3 so Client 1 wins Round 1
    const killC3Res = await shootTargetAuthoritatively(cdp1, cdp3, {
      stopAfterFirstHit: false,
      aimHead: true,
      maxShots: 16,
    });
    await cdp1.waitFor(`window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'ended'`, 8000);
    await delay(250);

    const client1Id = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getLootDiagnostics().inventorySnap?.playerId`);
    const r1EndSurv = await cdp1.eval(`window.__DEV_GAME_TOOLS__.getSurvivalDiagnostics()`);
    if (
      r1EndSurv.match?.phase !== 'ended' ||
      r1EndSurv.match?.winnerId !== client1Id ||
      !r1EndSurv.survivalUi.winnerOverlayVisible
    ) {
      throw new Error(`Round 1 winner verification failed: ${JSON.stringify(r1EndSurv)}`);
    }
    console.log(
      `  [verified] Client 1 won Round 1: phase='${r1EndSurv.match.phase}', winnerId='${r1EndSurv.match.winnerId}', winReason='${r1EndSurv.match.winReason}', killC2Shots=${killC2Res.shotsFired}, killC3Shots=${killC3Res.shotsFired}.`,
    );

    // Capture Screenshot 03 on Client 1: `03_round1_winner_and_clean_end.png`
    screenshots.push(await cdp1.screenshot('03_round1_winner_and_clean_end.png'));

    // Wait for Round 2 (`roundId === 2`, `phase === 'playing'`) to start automatically
    console.log('  [round-2] Waiting for Round 2 (`roundId === 2`, `phase === "playing"`) automatic reset...');
    await Promise.all([
      cdp1.waitFor(
        `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 2`,
        25000,
      ),
      cdp2.waitFor(
        `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 2`,
        25000,
      ),
      cdp3.waitFor(
        `window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.phase === 'playing' && window.__DEV_GAME_TOOLS__?.getSurvivalDiagnostics()?.match?.roundId === 2`,
        25000,
      ),
    ]);
    await delay(250);

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
      r2C1Surv.match?.phase !== 'playing' ||
      r2C1Surv.match?.aliveCount !== 3 ||
      r2C1Surv.match?.totalContenders !== 3 ||
      r2C1Surv.survivalUi.myRole !== 'contender' ||
      r2C2Surv.survivalUi.myRole !== 'contender' ||
      r2C3Surv.survivalUi.myRole !== 'contender' ||
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
      `  [verified] Round 2 fresh reset: roundId=2, aliveCount=3/3, all 3 clients unarmed, all 26 containers closed.`,
    );

    // In Round 2: Walk Client 2 to `cnt_3` (`nearCnt.id`) first, verify stale Round 1 context is rejected,
    // and then run the 5-second smoke FPS capture on Client 1 right before Screenshot 04!
    console.log('  [round-2-checks] Walking Client 2 to `cnt_3` in Round 2 to test stale Round 1 context rejection...');
    const c2R2SpawnPos = (await cdp2.eval(`window.__DEV_GAME_TOOLS__.getPredictionDiagnostics()`)).authoritativePos;
    await walkClientWaypoints(
      cdp2,
      'R2_Client2->cnt3',
      [
        ...buildRouteToRangerHouseCourtyard(c2R2SpawnPos, poiSites),
        {
          x: Number((cnt3StateInit.position.x - 0.15).toFixed(2)),
          z: Number((cnt3StateInit.position.z + 1.35).toFixed(2)),
          radius: 0.34,
        },
      ],
      { x: cnt3StateInit.position.x, y: cnt3StateInit.position.y + 0.95, z: cnt3StateInit.position.z },
    );

    // Have Client 2 emit raw `'container:open'` with Round 1's old context (`{ requestId: 'stale_from_r1', containerId: nearCnt.id, roundId: 1, spawnId: 1 }`)
    const staleFromR1Ack = await cdp2.eval(`
      window.__EMIT_RAW_CONTAINER_OPEN__({
        requestId: 'stale_from_r1',
        containerId: '${cnt3Id}',
        roundId: 1,
        spawnId: 1
      })
    `);
    if (staleFromR1Ack?.ok !== false || staleFromR1Ack?.code !== 'INVALID_REQUEST') {
      throw new Error(`Expected stale_from_r1 in Round 2 to be rejected with INVALID_REQUEST, got: ${JSON.stringify(staleFromR1Ack)}`);
    }
    console.log(
      `  [verified] Round 2 Stale Context Guard: stale_from_r1 (roundId=1, spawnId=1) rejected with ok=${staleFromR1Ack.ok}, code='${staleFromR1Ack.code}'.`,
    );

    // Now run 5-second smoke FPS capture on Client 1 in `medium` quality and immediately capture Screenshot 04
    console.log('  [smoke-fps] Running 5-second smoke FPS capture on Client 1 (`medium` quality)...');
    await cdp2.eval(`window.__SET_RAF_CAP_FPS__?.(15)`);
    await cdp3.eval(`window.__SET_RAF_CAP_FPS__?.(15)`);
    await cdp1.send('Page.bringToFront');
    await cdp1.eval(`
      (() => {
        window.__DEV_CAMERA_OVERRIDE__ = null;
        window.__DEV_PLAYER_POSE_LOCK__ = null;
        window.__DEV_GAME_TOOLS__.clearPlayerPoseLock();
        window.__DEV_GAME_TOOLS__.setQuality('medium');
        window.__DEV_GAME_TOOLS__.setThirdPerson(true);
        window.__SET_RAF_CAP_FPS__?.(null);
        let tStep = 0;
        window.__SMOKE_MOVE_TIMER__ = setInterval(() => {
          tStep += 0.05;
          window.__DEV_GAME_TOOLS__?.setSyntheticInput({
            fwd: Math.cos(tStep * 0.4) >= -0.2 ? 1 : -1,
            right: Math.sin(tStep * 0.8) * 0.6,
            jump: false,
            walk: false,
            yaw: Math.sin(tStep * 0.35) * 1.0,
            pitch: -0.06,
          });
        }, 50);
      })()
    `);
    await delay(500);
    await cdp1.eval(`window.__DEV_GAME_TOOLS__.startBenchmarkCapture()`);
    await delay(5000);
    const smokeFpsMetrics = await cdp1.eval(`
      (() => {
        if (window.__SMOKE_MOVE_TIMER__) {
          clearInterval(window.__SMOKE_MOVE_TIMER__);
          window.__SMOKE_MOVE_TIMER__ = null;
        }
        window.__DEV_GAME_TOOLS__?.setSyntheticInput(null);
        const r = window.__DEV_GAME_TOOLS__.stopBenchmarkCapture();
        r.programs = typeof window.__GET_WEBGL_PROGRAMS_COUNT__ === 'function'
          ? window.__GET_WEBGL_PROGRAMS_COUNT__()
          : 0;
        return r;
      })()
    `);

    console.log(
      `  [smoke-fps] medium 5s: frames=${smokeFpsMetrics.frames} | avgFps=${smokeFpsMetrics.fpsMean} p50Fps=${smokeFpsMetrics.fpsMedian} 1%low=${smokeFpsMetrics.fps1PctLow} | FT p50=${smokeFpsMetrics.frameTimeMedianMs}ms p95=${smokeFpsMetrics.frameTimeP95Ms}ms | Draw=${smokeFpsMetrics.render.calls} Tris=${smokeFpsMetrics.render.triangles}`,
    );

    // Capture Screenshot 04 on Client 1: `04_round2_fresh_reset_and_smoke_fps.png`
    screenshots.push(await cdp1.screenshot('04_round2_fresh_reset_and_smoke_fps.png'));

    // Also verify Client 2 CAN open `cnt_3` in Round 2 when using Round 2's valid context
    const c2ValidOpenR2Ack = await cdp2.eval(
      `window.__DEV_GAME_TOOLS__.openContainerById('${cnt3Id}', 'c2_valid_open_r2')`,
    );
    if (!c2ValidOpenR2Ack?.ok || c2ValidOpenR2Ack.roundId !== 2) {
      throw new Error(`Expected valid openContainerById in Round 2 to succeed, got: ${JSON.stringify(c2ValidOpenR2Ack)}`);
    }

    // =========================================================================
    // STEP 5: Verify Zero Console / Page / Network Errors & Write Report
    // =========================================================================
    const allConsoleErrors = [...cdp1.consoleErrors, ...cdp2.consoleErrors, ...cdp3.consoleErrors];
    const allPageExceptions = [...cdp1.pageExceptions, ...cdp2.pageExceptions, ...cdp3.pageExceptions];
    const allNetworkErrors = [...cdp1.networkErrors, ...cdp2.networkErrors, ...cdp3.networkErrors];

    cdp2.close();
    cdp3.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${pageTarget2Id}`).catch(() => {});
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${pageTarget3Id}`).catch(() => {});

    const smokeReport = {
      stage: 'BOSQICH 07-QA — Forest Survival Stabilization (Multi-Client Browser Smoke QA)',
      timestamp: new Date().toISOString(),
      environment: {
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        nodeVersion: process.version,
        chromeVersion: versionInfo.Browser,
        viewport: '1280x720',
        devicePixelRatio: 1,
      },
      world: {
        mapId: client1Meta.mapId,
        worldVersion: client1Meta.worldVersion,
        publicLayoutSeed: client1Meta.publicLayoutSeed,
        gameplayHash: client1Meta.gameplayHash,
      },
      checks: {
        round1ThreeClientUnarmedStart: {
          roundId: r1C1Surv.match.roundId,
          phase: r1C1Surv.match.phase,
          aliveCount: r1C1Surv.match.aliveCount,
          totalContenders: r1C1Surv.match.totalContenders,
          allThreeUnarmed:
            r1C1Loot.inventorySnap.equippedWeapon === null &&
            r1C2Loot.inventorySnap.equippedWeapon === null &&
            r1C3Loot.inventorySnap.equippedWeapon === null,
          all26ContainersClosed: r1AllClosed,
          passed: true,
        },
        p1MissingAndStaleContextGuard: {
          containerId: cnt3Id,
          rawNoContextAck: {
            ok: rawNoContextAck.ok,
            code: rawNoContextAck.code,
            roundId: rawNoContextAck.roundId,
            spawnId: rawNoContextAck.spawnId,
          },
          rawStaleRoundAck: {
            ok: rawStaleRoundAck.ok,
            code: rawStaleRoundAck.code,
            roundId: rawStaleRoundAck.roundId,
            spawnId: rawStaleRoundAck.spawnId,
          },
          validOpenR1Ack: {
            ok: c2ValidOpenR1Ack.ok,
            roundId: c2ValidOpenR1Ack.roundId,
            spawnId: c2ValidOpenR1Ack.spawnId,
          },
          validPickR1Ack: {
            ok: c2ValidPickR1Ack.ok,
            pickedCatalogId: c2Item0.catalogId,
          },
          passed: true,
        },
        p1ShootWeaponEquipAndSwitchCooldown: {
          initialEquippedWeapon: w1,
          unequippedOwnedWeapon: w2,
          w2MagBeforeFakeShot: w2MagBefore,
          w2MagAfterFakeShot: w2MagAfterFakeShot,
          equippedWeaponAfterFakeShot: equippedAfterFakeShot,
          equippedWeaponAfterValidEquipAndSwitchWait: invAfterSwitch.equippedWeapon,
          passed: true,
        },
        p2EliminatedSpectatorReplayGuard: {
          client2EliminatedRole: c2ElimSurv.survivalUi.myRole,
          round1PhaseDuringReplay: c2ElimSurv.match.phase,
          aliveCountDuringReplay: c2ElimSurv.match.aliveCount,
          replayOpenDeadAck: {
            ok: replayOpenDeadAck.ok,
            code: replayOpenDeadAck.code,
            idempotentReplay: Boolean(replayOpenDeadAck.idempotentReplay),
          },
          replayPickDeadAck: {
            ok: replayPickDeadAck.ok,
            code: replayPickDeadAck.code,
            idempotentReplay: Boolean(replayPickDeadAck.idempotentReplay),
          },
          passed: true,
        },
        p0GrenadeBatchAndRound2Reset: {
          grenadeExplosionsProcessedInRound1: explosionCountR1,
          round1WinnerId: r1EndSurv.match.winnerId,
          round1WinReason: r1EndSurv.match.winReason,
          round2StartedAutomatically: r2C1Surv.match.roundId === 2 && r2C1Surv.match.phase === 'playing',
          round2AliveCount: r2C1Surv.match.aliveCount,
          round2TotalContenders: r2C1Surv.match.totalContenders,
          round2AllThreeUnarmed:
            r2C1Loot.inventorySnap.equippedWeapon === null &&
            r2C2Loot.inventorySnap.equippedWeapon === null &&
            r2C3Loot.inventorySnap.equippedWeapon === null,
          round2All26ContainersClosed: r2AllClosed,
          staleFromR1InRound2Ack: {
            ok: staleFromR1Ack.ok,
            code: staleFromR1Ack.code,
            roundId: staleFromR1Ack.roundId,
            spawnId: staleFromR1Ack.spawnId,
          },
          validOpenInRound2Ack: {
            ok: c2ValidOpenR2Ack.ok,
            roundId: c2ValidOpenR2Ack.roundId,
            spawnId: c2ValidOpenR2Ack.spawnId,
          },
          passed: true,
        },
      },
      smokeFpsMetrics: {
        quality: 'medium',
        durationSec: 5,
        frames: smokeFpsMetrics.frames,
        fpsMean: smokeFpsMetrics.fpsMean,
        fpsMedian: smokeFpsMetrics.fpsMedian,
        fpsP10: smokeFpsMetrics.fpsP10,
        fps1PctLow: smokeFpsMetrics.fps1PctLow,
        frameTimeMedianMs: smokeFpsMetrics.frameTimeMedianMs,
        frameTimeP95Ms: smokeFpsMetrics.frameTimeP95Ms,
        frameTimeP99Ms: smokeFpsMetrics.frameTimeP99Ms,
        cullCpuMedianMs: smokeFpsMetrics.cullCpuMedianMs,
        cullCpuP95Ms: smokeFpsMetrics.cullCpuP95Ms,
        render: smokeFpsMetrics.render,
        programs: smokeFpsMetrics.programs,
        heapUsedMB: smokeFpsMetrics.heapUsedMB,
      },
      screenshots: screenshots.map((s) => ({
        filename: s.filename,
        width: s.width,
        height: s.height,
        bytes: s.bytes,
        path: `docs/screenshots/stage07qa/${s.filename}`,
      })),
      errors: {
        consoleErrorsCount: allConsoleErrors.length,
        pageExceptionsCount: allPageExceptions.length,
        networkErrorsCount: allNetworkErrors.length,
        consoleErrors: allConsoleErrors,
        pageExceptions: allPageExceptions,
        networkErrors: allNetworkErrors,
      },
    };

    fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(smokeReport, null, 2));
    console.log(`\n[Stage 07-QA] Smoke QA report saved to ${REPORT_JSON_PATH}`);

    if (allConsoleErrors.length > 0 || allPageExceptions.length > 0 || allNetworkErrors.length > 0) {
      throw new Error(
        `Zero-error assertion failed: consoleErrors=${allConsoleErrors.length}, pageExceptions=${allPageExceptions.length}, networkErrors=${allNetworkErrors.length}`,
      );
    }

    console.log('[Stage 07-QA] ALL LIVE MULTI-CLIENT SMOKE QA CHECKS PASSED WITH ZERO ERRORS!');
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
  console.error('[Stage 07-QA] FAILED:', err);
  process.exit(1);
});
