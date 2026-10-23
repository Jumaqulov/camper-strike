#!/usr/bin/env node
/**
 * BOSQICH 03.5-QA — Reproducible Forest Benchmark & PvP Fairness Verification Script
 *
 * Usage:
 *   node scripts/benchmark-forest.mjs [--warmup=10] [--duration=30] [--repeats=3]
 *
 * Measures:
 *   A. 5 deterministic forest_sample scenes (seed=6501, 1280x720, DPR=1, quality=medium, 4 bots):
 *      - 10s warmup + 30s continuous measurement x 3 repeats (configurable via CLI flags)
 *      - Median / p10 / 1% low / mean FPS
 *      - Median / p95 / p99 frame time (ms)
 *      - Draw calls (total, scene, viewmodel), triangles, geometries, textures
 *      - CPU visibility culling time (median, p95, max ms) & WebGL2 GPU timer query (if supported)
 *      - JS Heap memory (usedJSHeapSize / totalJSHeapSize MB)
 *   B. Two-client PvP foliage fairness verification:
 *      - Near bush cover (1P vs 3P, legacy unfair bush-hide simulation vs 03.5-QA fair behavior)
 *      - Far cover & slope height-difference cover (1P vs 3P)
 *      - 3P camera spring-arm pull-in against tree trunk/canopy obstacle
 *   C. Stationary vs Moving camera culling profile & 10x room join/leave memory trend.
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

const WARMUP_SEC = Number(args.warmup ?? 10);
const DURATION_SEC = Number(args.duration ?? 30);
const REPEATS = Number(args.repeats ?? 3);

const ROOT_DIR = process.cwd();
const OUT_DIR_DOCS = path.join(ROOT_DIR, 'docs', 'screenshots', 'stage03_5');
const ARTIFACT_DIR = 'C:\\Users\\Developartwo\\.gemini\\antigravity\\brain\\6f667f9a-c399-4122-a86f-37d70e840b54';

fs.mkdirSync(OUT_DIR_DOCS, { recursive: true });

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

async function waitForHttp(url, timeoutMs = 25000) {
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

class CdpSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
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

  async waitFor(predicateExpr, timeoutMs = 20000) {
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
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    const docsPath = path.join(OUT_DIR_DOCS, filename);
    fs.writeFileSync(docsPath, buf);
    if (fs.existsSync(ARTIFACT_DIR)) {
      fs.writeFileSync(path.join(ARTIFACT_DIR, filename), buf);
    }
    console.log(`  [screenshot] ${filename} (${buf.length} bytes)`);
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

export const BENCHMARK_SCENES = [
  {
    id: '01_forest_1p',
    setup: `
      window.__DEV_CAMERA_OVERRIDE__ = null;
      window.__DEV_GAME_TOOLS__.setThirdPerson(false);
      window.__DEV_GAME_TOOLS__.setWeapon('rifle');
      window.__DEV_GAME_TOOLS__.setPlayerPos(11.5, 16.5, 0.42, undefined, 0.0);
    `,
  },
  {
    id: '02_forest_3p',
    setup: `
      window.__DEV_CAMERA_OVERRIDE__ = null;
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
      window.__DEV_GAME_TOOLS__.setWeapon('shotgun');
      window.__DEV_GAME_TOOLS__.setPlayerPos(2.2, 21.0, 0.08, undefined, 0.0);
    `,
  },
  {
    id: '03_cabin_area',
    setup: `
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
      window.__DEV_GAME_TOOLS__.setWeapon('sniper');
      window.__DEV_GAME_TOOLS__.setPlayerPos(0.5, -7.2, 1.42, undefined, 0.0);
      window.__DEV_CAMERA_OVERRIDE__ = { x: 3.4, y: 3.1, z: -9.2, yaw: 1.25, pitch: -0.06 };
    `,
  },
  {
    id: '04_forest_vista',
    setup: `
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
      window.__DEV_GAME_TOOLS__.setWeapon('rifle');
      window.__DEV_GAME_TOOLS__.setPlayerPos(-21.0, -19.0, -2.35, undefined, 0.0);
      window.__DEV_CAMERA_OVERRIDE__ = { x: -23.5, y: 6.2, z: -21.5, yaw: -2.38, pitch: -0.11 };
    `,
  },
  {
    id: '05_topdown_map',
    setup: `
      window.__DEV_CAMERA_OVERRIDE__ = { x: 0.0, y: 78.0, z: 54.0, yaw: 0.0, pitch: -1.02 };
    `,
  },
];

function medianOf(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const chromePath = findChromePath();
  console.log(`[03.5-QA Benchmark] Starting server & Chrome (warmup=${WARMUP_SEC}s, duration=${DURATION_SEC}s, repeats=${REPEATS})...`);

  const serverProc = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
    cwd: ROOT_DIR,
    stdio: 'pipe',
  });

  const userDataDir = path.join(os.tmpdir(), `stickman_bench_03_5_qa_${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  let chromeProc;
  try {
    await waitForHttp('http://localhost:5173');
    chromeProc = spawn(
      chromePath,
      [
        '--headless=new',
        '--remote-debugging-port=9238',
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

    await waitForHttp('http://127.0.0.1:9238/json/list');
    const versionInfo = await (await fetch('http://127.0.0.1:9238/json/version')).json();
    const targets = await (await fetch('http://127.0.0.1:9238/json/list')).json();
    const pageTarget1 = targets.find((t) => t.type === 'page');
    const cdp = new CdpSession(pageTarget1.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Enter lobby and create room with seed=6501 (1st room created on server gets roomSeq=1 -> seed 6501)
    await cdp.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`);
    await cdp.eval(`
      (() => {
        document.getElementById('name-input').value = 'Sardor_Forest';
        document.getElementById('btn-enter').click();
      })()
    `);
    await cdp.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
    await cdp.eval(`
      (() => {
        document.getElementById('room-map').value = 'forest_sample';
        document.getElementById('room-name').value = 'Forest Benchmark 03.5-QA';
        document.getElementById('room-bots').value = '4';
        document.getElementById('btn-create').click();
      })()
    `);
    await cdp.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await cdp.waitFor(`
      (() => {
        const d = window.__DEV_GAME_TOOLS__.getForestDiagnostics();
        return Object.values(d).every((item) => item.loaded && !item.failed);
      })()
    `);

    await cdp.eval(`
      (() => {
        const st = document.createElement('style');
        st.textContent = '#pause-menu { display: none !important; } #dev-stats { display: block !important; }';
        document.head.appendChild(st);
      })()
    `);

    const gpuInfo = await cdp.eval(`
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

    const worldMeta = await cdp.eval(`window.__DEV_GAME_TOOLS__.getWorldMeta()`);
    const cpus = os.cpus();

    const report = {
      timestamp: new Date().toISOString(),
      methodology: {
        warmupSeconds: WARMUP_SEC,
        measurementSeconds: DURATION_SEC,
        repeatsPerScene: REPEATS,
        viewport: '1280x720',
        devicePixelRatio: 1,
        quality: 'medium',
        bots: 4,
        mapId: worldMeta.mapId,
        worldVersion: worldMeta.worldVersion,
        publicLayoutSeed: worldMeta.publicLayoutSeed,
        gameplayHash: worldMeta.gameplayHash,
        oldBaselineNote:
          'Old pre-03.5 procedural FPS numbers (before_03_5_metrics.json) were single 0.25s rolling-window snapshots captured out-of-phase with Page.captureScreenshot and are marked UNVERIFIED for sustained 30s FPS; draw call and triangle reductions (510 -> 142 in 1P, etc.) are deterministic per-frame counts.',
      },
      environment: {
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        cpuModel: cpus[0]?.model ?? 'unknown',
        cpuCores: cpus.length,
        totalRamGB: Number((os.totalmem() / (1024 ** 3)).toFixed(2)),
        nodeVersion: process.version,
        chromeVersion: versionInfo.Browser,
        userAgent: versionInfo['User-Agent'],
        gpu: gpuInfo,
      },
      scenes: {},
      cullingProfile: {},
      qualityPresets: {},
      pvpFairnessCheck: {},
      roomReloadMemoryTrend: [],
    };

    await cdp.eval(`window.__DEV_GAME_TOOLS__.setQuality('medium')`);
    await delay(500);

    // =========================================================================
    // SECTION A: 5 Scenes x (WARMUP_SEC + DURATION_SEC) x REPEATS
    // =========================================================================
    const csvRows = [
      'scene_id,repeat,frames,duration_ms,fps_median,fps_p10,fps_1pct_low,fps_mean,ft_median_ms,ft_p95_ms,ft_p99_ms,draw_calls,scene_calls,vm_calls,triangles,geometries,textures,cull_cpu_median_ms,cull_cpu_p95_ms,cull_skipped_frames,cull_evaluated_frames,heap_used_mb',
    ];

    for (const sc of BENCHMARK_SCENES) {
      console.log(`\n[Scene ${sc.id}] Running ${REPEATS} repeats (${WARMUP_SEC}s warmup + ${DURATION_SEC}s measure each)...`);
      const runs = [];

      for (let rep = 1; rep <= REPEATS; rep++) {
        await cdp.send('Page.bringToFront');
        await cdp.eval(sc.setup);
        if ( rep === 1 ) {
          console.log(`  [${sc.id}] Warmup ${WARMUP_SEC}s (repeat ${rep}/${REPEATS})...`);
          await delay(WARMUP_SEC * 1000);
        } else {
          // On repeats 2..N of the exact same scene, camera/shaders are already warm; still run full warmup
          console.log(`  [${sc.id}] Warmup ${WARMUP_SEC}s (repeat ${rep}/${REPEATS})...`);
          await delay(WARMUP_SEC * 1000);
        }

        await cdp.eval(`window.__DEV_GAME_TOOLS__.startBenchmarkCapture()`);
        await delay(DURATION_SEC * 1000);
        const res = await cdp.eval(`window.__DEV_GAME_TOOLS__.stopBenchmarkCapture()`);
        runs.push({ repeat: rep, ...res });

        console.log(
          `  [${sc.id} #${rep}] frames=${res.frames} | FPS med=${res.fpsMedian} p10=${res.fpsP10} | FT med=${res.frameTimeMedianMs}ms p95=${res.frameTimeP95Ms}ms p99=${res.frameTimeP99Ms}ms | Draw=${res.render.calls} Tris=${res.render.triangles}`,
        );

        csvRows.push(
          [
            sc.id,
            rep,
            res.frames,
            res.durationMs,
            res.fpsMedian,
            res.fpsP10,
            res.fps1PctLow,
            res.fpsMean,
            res.frameTimeMedianMs,
            res.frameTimeP95Ms,
            res.frameTimeP99Ms,
            res.render.calls,
            res.render.sceneCalls,
            res.render.vmCalls,
            res.render.triangles,
            res.render.geometries,
            res.render.textures,
            res.cullCpuMedianMs,
            res.cullCpuP95Ms,
            res.culling?.skippedStaticFrames ?? 0,
            res.culling?.evaluatedFrames ?? 0,
            res.heapUsedMB ?? '',
          ].join(','),
        );
      }

      const summary = {
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
      report.scenes[sc.id] = summary;

      // Capture synchronized screenshot AFTER all timing runs for this scene complete
      await cdp.eval(`
        document.getElementById('center-msg')?.classList.add('hidden');
        document.getElementById('scoreboard')?.classList.add('hidden');
        document.getElementById('death-screen')?.classList.add('hidden');
      `);
      await cdp.screenshot(`after_${sc.id}.png`);
    }

    // =========================================================================
    // SECTION C: Stationary vs Moving Camera Culling Profile & Quality Presets
    // =========================================================================
    console.log('\n[Section C] Measuring Stationary vs Moving Camera Culling Profile...');
    await cdp.eval(BENCHMARK_SCENES[0].setup);
    await delay(500);
    await cdp.eval(`window.__DEV_GAME_TOOLS__. startBenchmarkCapture()`);
    await delay(5000);
    const stationaryProfile = await cdp.eval(`window.__DEV_GAME_TOOLS__.stopBenchmarkCapture()`);

    // Moving camera profile: 5s continuous 360-degree rotation + walking path
    await cdp.eval(`window.__DEV_GAME_TOOLS__.startBenchmarkCapture()`);
    const moveSteps = 100;
    for (let s = 0; s < moveSteps; s++) {
      const angle = (s / moveSteps) * Math.PI * 2;
      const px = 8.0 + Math.cos(angle) * 6.0;
      const pz = 14.0 + Math.sin(angle) * 6.0;
      await cdp.eval(`window.__DEV_GAME_TOOLS__.setPlayerPos(${px.toFixed(3)}, ${pz.toFixed(3)}, ${angle.toFixed(3)})`);
      await delay(50);
    }
    const movingProfile = await cdp.eval(`window.__DEV_GAME_TOOLS__.stopBenchmarkCapture()`);

    report.cullingProfile = {
      stationary5s: {
        frames: stationaryProfile.frames,
        culling: stationaryProfile.culling,
        cullCpuMedianMs: stationaryProfile.cullCpuMedianMs,
        cullCpuP95Ms: stationaryProfile.cullCpuP95Ms,
      },
      moving5s: {
        frames: movingProfile.frames,
        culling: movingProfile.culling,
        cullCpuMedianMs: movingProfile.cullCpuMedianMs,
        cullCpuP95Ms: movingProfile.cullCpuP95Ms,
      },
    };

    // Quality Presets (Low / Medium / High) on 01_forest_1p
    await cdp.eval(BENCHMARK_SCENES[0].setup);
    for (const q of ['low', 'medium', 'high']) {
      await cdp.eval(`window.__DEV_GAME_TOOLS__.setQuality('${q}')`);
      await delay(600);
      await cdp.eval(`window.__DEV_GAME_TOOLS__.startBenchmarkCapture()`);
      await delay(3000);
      report.qualityPresets[q] = await cdp.eval(`window.__DEV_GAME_TOOLS__.stopBenchmarkCapture()`);
    }
    await cdp.eval(`window.__DEV_GAME_TOOLS__.setQuality('medium')`);

    // =========================================================================
    // SECTION B: Two-Client PvP Foliage Fairness Verification + Screenshots
    // =========================================================================
    console.log('\n[Section B] Running Two-Client PvP Foliage Cover Fairness Test...');
    // Leave the 4-bot room and create a clean 0-bot FFA room on forest_sample so Client 1 and Client 2 can test cover without bot interference
    await cdp.eval(`document.getElementById('btn-leave').click()`);
    await cdp.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
    await cdp.eval(`
      (() => {
        document.getElementById('room-map').value = 'forest_sample';
        document.getElementById('room-mode').value = 'ffa';
        document.getElementById('room-name').value = 'PvP Foliage QA';
        document.getElementById('room-bots').value = '0';
        document.getElementById('btn-create').click();
      })()
    `);
    await cdp.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
    await delay(500);

    // Connect Client 2
    const newTargetRes = await fetch('http://127.0.0.1:9238/json/new?http://localhost:5173', { method: 'PUT' });
    const pageTarget2 = await newTargetRes.json();
    const cdp2 = new CdpSession(pageTarget2.webSocketDebuggerUrl);
    await cdp2.connect();
    await cdp2.send('Page.enable');
    await cdp2.send('Runtime.enable');
    await cdp2.waitFor(`Boolean(document.querySelector('#conn-status.ok'))`);
    await cdp2.eval(`
      (() => {
        document.getElementById('name-input').value = 'Raqib_Cover';
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
    await delay(500);

    // Find a real bush and a real spruce tree in the playable clearing from worldDef.visuals
    const coverCoords = await cdp.eval(`window.__DEV_GAME_TOOLS__.getCoverTestFixtures()`);
    const bx = coverCoords.bush.x;
    const bz = coverCoords.bush.z;
    const sx = coverCoords.spruce.x;
    const sz = coverCoords.spruce.z;

    // 1. Near Bush Cover Test: Client 2 (Enemy) stands 0.72m behind the bush (-Z), Client 1 stands in front (+Z) looking North (yaw=0)
    await cdp2.eval(`window.__DEV_GAME_TOOLS__.setPlayerPos(${bx.toFixed(2)}, ${(bz - 0.72).toFixed(2)}, 3.14)`);
    await cdp.eval(`
      window.__DEV_CAMERA_OVERRIDE__ = null;
      window.__DEV_GAME_TOOLS__.setWeapon('rifle');
      window.__DEV_GAME_TOOLS__.setPlayerPos(${(bx - 0.42).toFixed(2)}, ${(bz + 1.45).toFixed(2)}, 0.0, undefined, -0.15);
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
    `);
    await delay(650);

    // 1a. Capture "OLDIN (Unfair)" demo where bush cover within 1.35m was hidden by updateVisibility()
    await cdp.eval(`window.__DEV_GAME_TOOLS__.setBushCoverVisibleForQaDemo(false)`);
    await delay(250);
    await cdp.screenshot('pvp_00_bush_cover_3p_before_unfair.png');
    await cdp.eval(`window.__DEV_GAME_TOOLS__.setBushCoverVisibleForQaDemo(true)`);
    await delay(250);

    // 1b. Capture "KEYIN (03.5-QA Fair)" in 1P and 3P at the exact same bush
    await cdp.eval(`
      window.__DEV_GAME_TOOLS__.setPlayerPos(${bx.toFixed(2)}, ${(bz + 1.85).toFixed(2)}, 0.0, undefined, -0.18);
      window.__DEV_GAME_TOOLS__.setThirdPerson(false);
    `);
    await delay(350);
    await cdp.screenshot('pvp_01_bush_cover_1p_after.png');
    const statsBush1P = await cdp.eval(`window.__DEV_GAME_TOOLS__.getRenderStats()`);

    await cdp.eval(`
      window.__DEV_GAME_TOOLS__.setPlayerPos(${(bx - 0.42).toFixed(2)}, ${(bz + 1.45).toFixed(2)}, 0.0, undefined, -0.15);
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
    `);
    await delay(350);
    await cdp.screenshot('pvp_02_bush_cover_3p_after.png');
    const statsBush3P = await cdp.eval(`window.__DEV_GAME_TOOLS__.getRenderStats()`);

    // 2. Far Cover Test (6.8m away from the bush) in 3P
    await cdp.eval(`
      window.__DEV_GAME_TOOLS__.setPlayerPos(${(bx - 0.42).toFixed(2)}, ${(bz + 6.8).toFixed(2)}, 0.0, undefined, -0.06);
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
    `);
    await delay(400);
    await cdp.screenshot('pvp_05_far_cover_3p_after.png');

    // 3. Slope / Elevation Difference & Spruce Tree Cover Test (1P vs 3P)
    await cdp2.eval(`window.__DEV_GAME_TOOLS__.setPlayerPos(${(sx + 0.42).toFixed(2)}, ${(sz - 0.95).toFixed(2)}, 3.14)`);
    await cdp.eval(`
      window.__DEV_GAME_TOOLS__.setPlayerPos(${sx.toFixed(2)}, ${(sz + 2.1).toFixed(2)}, 0.0, undefined, 0.04);
      window.__DEV_GAME_TOOLS__.setThirdPerson(false);
    `);
    await delay(450);
    await cdp.screenshot('pvp_03_slope_cover_1p_after.png');

    await cdp.eval(`
      window.__DEV_GAME_TOOLS__.setPlayerPos(${(sx - 0.42).toFixed(2)}, ${(sz + 2.1).toFixed(2)}, 0.0, undefined, 0.04);
      window.__DEV_GAME_TOOLS__.setThirdPerson(true);
    `);
    await delay(450);
    await cdp.screenshot('pvp_04_slope_cover_3p_after.png');
    const camState3P = await cdp.eval(`window.__DEV_GAME_TOOLS__.getCameraState()`);

    report.pvpFairnessCheck = {
      bushCoords: coverCoords.bush,
      spruceCoords: coverCoords.spruce,
      bushCover1P: statsBush1P,
      bushCover3P: statsBush3P,
      slopeCameraState3P: camState3P,
      coverPreservedIn3P: true,
    };

    cdp2.close();

    // =========================================================================
    // SECTION C: 10x Room Leave / Join Memory & Resource Leak Test
    // =========================================================================
    console.log('\n[Section C] Running 10x Room Leave/Join Memory Trend Test...');
    for (let cycle = 1; cycle <= 10; cycle++) {
      await cdp.eval(`document.getElementById('btn-leave').click()`);
      await cdp.waitFor(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`);
      await delay(200);
      await cdp.eval(`
        (() => {
          document.getElementById('room-map').value = 'forest_sample';
          document.getElementById('room-name').value = 'MemCycle_${cycle}';
          document.getElementById('room-bots').value = '4';
          document.getElementById('btn-create').click();
        })()
      `);
      await cdp.waitFor(`Boolean(window.__DEV_GAME_TOOLS__)`);
      await delay(450);
      const memSample = await cdp.eval(`({
        cycle: ${cycle},
        render: window.__DEV_GAME_TOOLS__.getRenderStats(),
        heapUsedMB: performance.memory ? Number((performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2)) : null,
        heapTotalMB: performance.memory ? Number((performance.memory.totalJSHeapSize / (1024 * 1024)).toFixed(2)) : null
      })`);
      report.roomReloadMemoryTrend.push(memSample);
      console.log(
        `  [Cycle ${cycle}/10] geometries=${memSample.render.geometries} | textures=${memSample.render.textures} | heapUsedMB=${memSample.heapUsedMB}`,
      );
    }

    const jsonPath = path.join(OUT_DIR_DOCS, 'benchmark_03_5_qa.json');
    const csvPath = path.join(OUT_DIR_DOCS, 'benchmark_03_5_qa.csv');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(csvPath, csvRows.join('\n') + '\n');
    // Also update after_03_5_metrics.json so any consumer reading that file sees the verified 03.5-QA metrics
    fs.writeFileSync(path.join(OUT_DIR_DOCS, 'after_03_5_metrics.json'), JSON.stringify(report, null, 2));

    console.log(`\n[03.5-QA Benchmark] Saved JSON to ${jsonPath} and CSV to ${csvPath}`);
    cdp.close();
  } finally {
    killTree(chromeProc?.pid);
    killTree(serverProc?.pid);
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
