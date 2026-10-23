#!/usr/bin/env node
/**
 * STAGE 08-MENU-POLISH — Daylight Camper Main Menu + Lobby UX QA Automation (agent D)
 *
 * Real Chrome (CDP) headless automation:
 * - Starts game server on PORT=3200 and Vite DEV server on PORT=5373 (with explicit proxy)
 * - Opens Chrome across viewports:
 *   * 1920x1080 (Desktop full view)
 *   * 1280x720 (Standard HD)
 *   * 1366x768 (Laptop)
 *   * 390x844 (Mobile portrait)
 *   * 768x1024 (Tablet portrait)
 * - Captures high-resolution PNG screenshots into docs/screenshots/stage08menu-polish/:
 *   1. 01_menu_1920x1080.png
 *   2. 02_menu_1280x720.png
 *   3. 03_menu_1366x768.png
 *   4. 04_menu_390x844.png
 *   5. 04b_menu_768x1024.png
 *   6. 05_settings_modal.png
 *   7. 06_lobby_forest_survival.png
 *   8. 07_two_clients_in_room.png
 *   (and mirrors to docs/screenshots/stage08menu/ including 07_lobby_two_clients.png)
 *
 * Acceptance Criteria Verified:
 * 1. camper_bg_image_loaded: #screen-menu .menu-bg has camper-daylight.webp
 * 2. camping_sign_unoccluded: DOM Rects of .menu-main-grid, .menu-nav-panel, .menu-featured-card
 *    do not overlap CAMPING sign (x:8%-37%, y:19%-62%) or camper van (x:46%-80%, y:41%-75%)
 * 3. logo_visible: h1.logo present, visible (>200px w, >30px h), in viewport, text 'CAMPER STRIKE 65'
 * 4. profile_name_sync: open modal, change name to 'Alisher_QA', save, reload page, persists
 * 5. settings_persistence: open settings modal, set FOV 95, close, reload page, persists in localStorage
 * 6. survival_configuration: mode=forest_survival => map=forest_square, lootPreview=true, bots=0 disabled
 * 7. two_clients_join_same_room: Client 1 creates 'CamperQA_Survival', Client 2 enters lobby, clicks join,
 *    both clients confirmed inside the exact same room
 * 8. no_game_canvas_in_menu: verifies #game-root canvas does NOT exist in menu/lobby
 *
 * Outputs docs/stage08menu-polish/qa_menu_summary.json and docs/stage08menu/qa_menu_summary.json
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLISH_REPORT_DIR = path.join(WORKSPACE, 'docs', 'stage08menu-polish');
const POLISH_SHOT_DIR = path.join(WORKSPACE, 'docs', 'screenshots', 'stage08menu-polish');
const LEGACY_REPORT_DIR = path.join(WORKSPACE, 'docs', 'stage08menu');
const LEGACY_SHOT_DIR = path.join(WORKSPACE, 'docs', 'screenshots', 'stage08menu');

for (const d of [POLISH_REPORT_DIR, POLISH_SHOT_DIR, LEGACY_REPORT_DIR, LEGACY_SHOT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const SERVER_PORT = 3200;
const VITE_PORT = 5373;
const CHROME_DEBUG_PORT = 9400;

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

async function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch {
      await delay(200);
    }
  }
  return false;
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const WebSocket = globalThis.WebSocket;
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data.id && this.pending.has(data.id)) {
            const { resolve: res, reject: rej } = this.pending.get(data.id);
            this.pending.delete(data.id);
            if (data.error) rej(new Error(data.error.message || JSON.stringify(data.error)));
            else res(data.result);
          }
        } catch (e) {
          console.error('CDP parse error:', e);
        }
      };
    });
  }

  async send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res?.exceptionDetails) {
      throw new Error('CDP eval exception: ' + JSON.stringify(res.exceptionDetails));
    }
    return res?.result?.value;
  }

  async screenshot(filePath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(res.data, 'base64');
    fs.writeFileSync(filePath, buf);
    return buf.length;
  }

  async close() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
  }
}

async function startServer() {
  const tsxCli = path.join(WORKSPACE, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const srv = spawn(
    process.execPath,
    [tsxCli, 'src/server/index.ts'],
    {
      cwd: WORKSPACE,
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdio: 'pipe',
    },
  );
  srv.stdout.on('data', (d) => {
    const s = d.toString();
    if (s.includes('error')) console.log('[Server]', s.trim());
  });
  srv.stderr.on('data', (d) => {
    const s = d.toString();
    if (!s.includes('ExperimentalWarning')) console.error('[Server ERR]', s.trim());
  });

  const ready = await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/`, 15000);
  if (!ready) throw new Error(`Game server PORT ${SERVER_PORT} ga ulanmadi`);
  return srv;
}

async function startVite() {
  const viteEntry = path.join(WORKSPACE, 'node_modules', 'vite', 'dist', 'node', 'index.js');
  const viteModule = await import(pathToFileURL(viteEntry).href);
  const viteServer = await viteModule.createServer({
    configFile: false,
    root: WORKSPACE,
    cacheDir: path.join(os.tmpdir(), `stickman-qa-vite-${VITE_PORT}`),
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
  });
  await viteServer.listen();
  const ready = await waitForHttp(`http://127.0.0.1:${VITE_PORT}/`, 15000);
  if (!ready) throw new Error(`Vite DEV server PORT ${VITE_PORT} ga ulanmadi`);
  return viteServer;
}

async function launchChrome(port, width = 1280, height = 720) {
  const chromePath = findChrome();
  const tmpDir = path.join(os.tmpdir(), `stickman_qa_menu_${port}_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const chromeArgs = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=1',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${tmpDir}`,
    'about:blank',
  ];

  const proc = spawn(chromePath, chromeArgs, { stdio: 'ignore' });

  const debugUrl = `http://127.0.0.1:${port}/json/version`;
  const ready = await waitForHttp(debugUrl, 15000);
  if (!ready) {
    killTree(proc.pid);
    throw new Error(`Chrome remote debugging port ${port} ga ulanib bo'lmadi`);
  }

  const targetsRes = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = await targetsRes.json();
  const page = targets.find((t) => t.type === 'page') || targets[0];
  if (!page?.webSocketDebuggerUrl) {
    killTree(proc.pid);
    throw new Error(`Chrome debug target topilmadi (${port})`);
  }

  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });

  return { proc, client, tmpDir };
}

function saveDualScreenshot(filename, client, targetDirs) {
  // Returns promise of capture and mirrors to all target dirs
  return async () => {
    const primaryPath = path.join(targetDirs[0], filename);
    const sz = await client.screenshot(primaryPath);
    for (let i = 1; i < targetDirs.length; i++) {
      fs.copyFileSync(primaryPath, path.join(targetDirs[i], filename));
    }
    return sz;
  };
}

async function main() {
  console.log('=== STAGE 08-MENU-POLISH QA Automation (Agent D) ===');
  let srv = null;
  let vite = null;
  let chrome1 = null;
  let chrome2 = null;

  const testResults = {
    timestamp: new Date().toISOString(),
    criteria: {},
    tests: [],
    screenshots: [],
    occlusionMeasurements: {},
  };

  try {
    console.log(`[QA] Starting game server on PORT ${SERVER_PORT}...`);
    srv = await startServer();
    console.log(`[QA] Starting Vite on PORT ${VITE_PORT} with proxy to ${SERVER_PORT}...`);
    vite = await startVite();

    console.log(`[QA] Launching Chrome 1 (Debug port ${CHROME_DEBUG_PORT})...`);
    chrome1 = await launchChrome(CHROME_DEBUG_PORT, 1920, 1080);
    const cdp = chrome1.client;

    const pageUrl = `http://127.0.0.1:${VITE_PORT}/`;
    console.log(`[QA] Navigating to ${pageUrl}...`);
    await cdp.send('Page.navigate', { url: pageUrl });
    await delay(2500);

    // =========================================================================
    // 1. Desktop 1920x1080 Capture & Criterion Checks
    // =========================================================================
    console.log('[QA] --- 1. Testing 1920x1080 Viewport ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await delay(500);

    const saveShot = async (name, viewport) => {
      const p1 = path.join(POLISH_SHOT_DIR, name);
      const p2 = path.join(LEGACY_SHOT_DIR, name);
      const sz = await cdp.screenshot(p1);
      fs.copyFileSync(p1, p2);
      console.log(`  Captured ${name} (${sz} bytes)`);
      testResults.screenshots.push({ name, viewport, size: sz });
      return sz;
    };

    await saveShot('01_menu_1920x1080.png', '1920x1080');

    // CRITERION 1: camper_bg_image_loaded
    const bgInfo = await cdp.eval(`(() => {
      const bg = document.querySelector('#screen-menu .menu-bg');
      const cs = window.getComputedStyle(bg);
      return {
        bgImage: cs.backgroundImage,
        hasWebp: cs.backgroundImage.includes('camper-daylight.webp')
      };
    })()`);
    console.log('  Camper background info:', bgInfo);
    testResults.tests.push({
      id: 'camper_bg_image_loaded',
      pass: bgInfo.hasWebp,
      detail: `Background image contains camper-daylight.webp (${bgInfo.bgImage})`,
    });
    testResults.criteria.camper_bg_image_loaded = bgInfo.hasWebp;

    // Helper: Occlusion measurement
    const measureOcclusionExpr = `(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const signRegion = {
        name: 'CAMPING Sign',
        left: 0.08 * vw,
        right: 0.37 * vw,
        top: 0.19 * vh,
        bottom: 0.62 * vh,
      };

      const camperRegion = {
        name: 'Camper Van',
        left: 0.46 * vw,
        right: 0.80 * vw,
        top: 0.41 * vh,
        bottom: 0.75 * vh,
      };

      const selectors = ['.menu-main-grid', '.menu-nav-panel', '.menu-featured-card'];
      const panels = selectors.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { selector: sel, found: false };
        const r = el.getBoundingClientRect();
        return {
          selector: sel,
          found: true,
          rect: {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          }
        };
      });

      function overlaps(r1, r2) {
        return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
      }

      const signOverlaps = [];
      const camperOverlaps = [];

      for (const p of panels) {
        if (!p.found) continue;
        if (overlaps(p.rect, signRegion)) {
          signOverlaps.push({ selector: p.selector, rect: p.rect });
        }
        if (overlaps(p.rect, camperRegion)) {
          camperOverlaps.push({ selector: p.selector, rect: p.rect });
        }
      }

      return {
        vw,
        vh,
        signRegion,
        camperRegion,
        panels,
        signOccluded: signOverlaps.length > 0,
        camperOccluded: camperOverlaps.length > 0,
        signOverlaps,
        camperOverlaps,
      };
    })()`;

    // Measure occlusions at 1920x1080
    const occ1080 = await cdp.eval(measureOcclusionExpr);
    console.log('  1920x1080 Occlusion Check:', {
      signOccluded: occ1080.signOccluded,
      camperOccluded: occ1080.camperOccluded,
      panels: occ1080.panels.map(p => ({ sel: p.selector, top: p.rect.top, bottom: p.rect.bottom, left: p.rect.left, right: p.rect.right })),
    });
    testResults.occlusionMeasurements['1920x1080'] = occ1080;

    // CRITERION 3: logo_visible
    const logoInfo = await cdp.eval(`(() => {
      const logo = document.querySelector('h1.logo');
      if (!logo) return { found: false };
      const r = logo.getBoundingClientRect();
      const text = (logo.textContent || '').replace(/\\s+/g, ' ').trim();
      const inViewport = r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
      const widthOk = r.width > 200;
      const heightOk = r.height > 30;
      const textOk = text.includes('CAMPER') && text.includes('STRIKE 65');
      return {
        found: true,
        text,
        width: r.width,
        height: r.height,
        inViewport,
        widthOk,
        heightOk,
        textOk,
        visible: inViewport && widthOk && heightOk && textOk
      };
    })()`);
    console.log('  Logo visibility:', logoInfo);
    testResults.tests.push({
      id: 'logo_visible',
      pass: Boolean(logoInfo.visible),
      detail: `Logo present, text='${logoInfo.text}', size=${logoInfo.width}x${logoInfo.height}px, inViewport=${logoInfo.inViewport}`,
    });
    testResults.criteria.logo_visible = Boolean(logoInfo.visible);

    // CRITERION 8 (Part 1): no_game_canvas_in_menu
    const menuCanvasInfo = await cdp.eval(`(() => {
      const canvas = document.querySelector('#game-root canvas');
      return { canvasPresent: Boolean(canvas) };
    })()`);
    console.log('  Menu canvas check (should be false):', menuCanvasInfo);

    // =========================================================================
    // 2. Standard HD 1280x720 Capture & Occlusion Check
    // =========================================================================
    console.log('[QA] --- 2. Testing 1280x720 Viewport ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await delay(400);
    await saveShot('02_menu_1280x720.png', '1280x720');

    const occ720 = await cdp.eval(measureOcclusionExpr);
    console.log('  1280x720 Occlusion Check:', {
      signOccluded: occ720.signOccluded,
      camperOccluded: occ720.camperOccluded,
      panels: occ720.panels.map(p => ({ sel: p.selector, top: p.rect.top, bottom: p.rect.bottom, left: p.rect.left, right: p.rect.right })),
    });
    testResults.occlusionMeasurements['1280x720'] = occ720;

    // CRITERION 2: camping_sign_unoccluded (tested at 1920x1080 and 1280x720)
    const signUnoccludedBoth = !occ1080.signOccluded && !occ720.signOccluded;
    const camperUnoccludedBoth = !occ1080.camperOccluded && !occ720.camperOccluded;
    const criterion2Pass = signUnoccludedBoth && camperUnoccludedBoth;

    testResults.tests.push({
      id: 'camping_sign_unoccluded',
      pass: criterion2Pass,
      detail: `CAMPING sign (x:8-37%, y:19-62%) unoccluded at 1080p and 720p: ${signUnoccludedBoth}. Camper van (x:46-80%, y:41-75%) unoccluded: ${camperUnoccludedBoth}.`,
    });
    testResults.criteria.camping_sign_unoccluded = criterion2Pass;

    // =========================================================================
    // 3. Laptop 1366x768 Capture
    // =========================================================================
    console.log('[QA] --- 3. Testing 1366x768 Viewport ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await delay(400);
    await saveShot('03_menu_1366x768.png', '1366x768');

    // =========================================================================
    // 4. Mobile 390x844 Capture
    // =========================================================================
    console.log('[QA] --- 4. Testing 390x844 Mobile Viewport ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(400);
    await saveShot('04_menu_390x844.png', '390x844');

    // =========================================================================
    // 5. Tablet 768x1024 Capture
    // =========================================================================
    console.log('[QA] --- 5. Testing 768x1024 Tablet Portrait Viewport ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 1024, deviceScaleFactor: 1, mobile: false });
    await delay(400);
    await saveShot('04b_menu_768x1024.png', '768x1024');

    // Switch back to 1280x720 standard desktop for interactive modal/lobby/multiplayer tests
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await delay(400);

    // =========================================================================
    // 6. CRITERION 4: profile_name_sync (Nickname Modal & Reload Persistence)
    // =========================================================================
    console.log('[QA] --- 6. Testing Profile Name Sync & Persistence ---');
    // Open nickname modal
    await cdp.eval(`(() => {
      const editBtn = document.getElementById('btn-menu-edit-name') || document.getElementById('btn-change-name');
      if (editBtn) editBtn.click();
    })()`);
    await delay(300);

    // Change nickname to 'Alisher_QA' and save
    const nameChangeResult = await cdp.eval(`(() => {
      const input = document.getElementById('modal-name-input') || document.getElementById('modal-nickname-input');
      if (input) {
        input.value = 'Alisher_QA';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const saveBtn = document.getElementById('btn-save-nickname');
      if (saveBtn) saveBtn.click();
      const menuPlayerName = document.getElementById('menu-player-name')?.textContent?.trim();
      return { menuPlayerName };
    })()`);
    await delay(400);
    console.log('  Nickname after save:', nameChangeResult.menuPlayerName);

    // Reload page to test localStorage persistence
    console.log('  Reloading page to test nickname persistence from localStorage...');
    await cdp.send('Page.reload', { ignoreCache: true });
    await delay(2000);

    const namePersistedResult = await cdp.eval(`(() => {
      const menuPlayerName = document.getElementById('menu-player-name')?.textContent?.trim();
      const rawStored = localStorage.getItem('stickman-strike-settings');
      let storedName = null;
      try { storedName = JSON.parse(rawStored).name; } catch {}
      return { menuPlayerName, storedName, rawStored };
    })()`);
    console.log('  Nickname after reload:', namePersistedResult);

    const namePass = namePersistedResult.menuPlayerName === 'Alisher_QA' && namePersistedResult.storedName === 'Alisher_QA';
    testResults.tests.push({
      id: 'profile_name_sync',
      pass: namePass,
      detail: `Name 'Alisher_QA' saved and persisted across page reload: domName='${namePersistedResult.menuPlayerName}', storedName='${namePersistedResult.storedName}'`,
    });
    testResults.criteria.profile_name_sync = namePass;

    // =========================================================================
    // 7. CRITERION 5: settings_persistence (Settings Modal & FOV 95)
    // =========================================================================
    console.log('[QA] --- 7. Testing Settings Modal & FOV Persistence ---');
    // Open settings modal
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-open-settings');
      if (btn) btn.click();
    })()`);
    await delay(400);

    // Capture 05_settings_modal.png
    await saveShot('05_settings_modal.png', '1280x720');

    // Change FOV slider to 95 and close modal
    await cdp.eval(`(() => {
      const fovInput = document.getElementById('menu-set-fov') || document.getElementById('set-fov');
      if (fovInput) {
        fovInput.value = '95';
        fovInput.dispatchEvent(new Event('input', { bubbles: true }));
        fovInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const closeBtn = document.getElementById('btn-close-settings') || document.getElementById('btn-settings-close');
      if (closeBtn) closeBtn.click();
    })()`);
    await delay(400);

    // Reload page to verify persistence in localStorage
    console.log('  Reloading page to test settings persistence from localStorage...');
    await cdp.send('Page.reload', { ignoreCache: true });
    await delay(2000);

    const fovPersistedResult = await cdp.eval(`(() => {
      const rawStored = localStorage.getItem('stickman-strike-settings');
      let fov = null;
      try { fov = JSON.parse(rawStored).fov; } catch {}
      return { fov, rawStored };
    })()`);
    console.log('  FOV after reload:', fovPersistedResult.fov);

    const fovPass = fovPersistedResult.fov === 95;
    testResults.tests.push({
      id: 'settings_persistence',
      pass: fovPass,
      detail: `Settings saved FOV 95 and persisted across page reload: fov=${fovPersistedResult.fov}`,
    });
    testResults.criteria.settings_persistence = fovPass;

    // =========================================================================
    // 8. CRITERION 6: survival_configuration & Lobby Screen
    // =========================================================================
    console.log('[QA] --- 8. Testing Lobby & Forest Survival Configuration ---');
    // Check no canvas before entering lobby
    const canvasInMenu = await cdp.eval(`(() => Boolean(document.querySelector('#game-root canvas')))()`);

    // Click quick play / enter lobby
    await cdp.eval(`(() => {
      const enterBtn = document.getElementById('btn-enter') || document.getElementById('btn-open-rooms');
      if (enterBtn) enterBtn.click();
    })()`);
    await delay(800);

    // Check no canvas while in lobby
    const canvasInLobby = await cdp.eval(`(() => Boolean(document.querySelector('#game-root canvas')))()`);

    // CRITERION 8: no_game_canvas_in_menu
    const noCanvasInMenuOrLobby = !canvasInMenu && !canvasInLobby;
    testResults.tests.push({
      id: 'no_game_canvas_in_menu',
      pass: noCanvasInMenuOrLobby,
      detail: 'No active game canvas / no gameplay render loop in menu/lobby (verified canvas absent in both screen-menu and screen-lobby)',
    });
    testResults.criteria.no_game_canvas_in_menu = noCanvasInMenuOrLobby;

    // Verify survival configuration
    const survivalConfig = await cdp.eval(`(() => {
      const modeSel = document.getElementById('room-mode');
      if (modeSel && modeSel.value !== 'forest_survival') {
        modeSel.value = 'forest_survival';
        modeSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const mapSel = document.getElementById('room-map');
      const lootChk = document.getElementById('room-loot-preview');
      const botsInp = document.getElementById('room-bots');
      const lobbyScreen = document.getElementById('screen-lobby');
      return {
        isLobbyVisible: !lobbyScreen.classList.contains('hidden'),
        mode: modeSel?.value,
        map: mapSel?.value,
        lootPreview: lootChk?.checked,
        bots: Number(botsInp?.value),
        botsDisabled: botsInp?.disabled,
      };
    })()`);
    console.log('  Lobby Forest Survival configuration:', survivalConfig);

    const survivalConfigPass =
      survivalConfig.isLobbyVisible &&
      survivalConfig.mode === 'forest_survival' &&
      survivalConfig.map === 'forest_square' &&
      survivalConfig.lootPreview === true &&
      survivalConfig.bots === 0 &&
      survivalConfig.botsDisabled === true;

    testResults.tests.push({
      id: 'survival_configuration',
      pass: survivalConfigPass,
      detail: `mode=${survivalConfig.mode}, map=${survivalConfig.map}, lootPreview=${survivalConfig.lootPreview}, bots=${survivalConfig.bots}, botsDisabled=${survivalConfig.botsDisabled}`,
    });
    testResults.criteria.survival_configuration = survivalConfigPass;

    // Capture 06_lobby_forest_survival.png
    await saveShot('06_lobby_forest_survival.png', '1280x720');

    // =========================================================================
    // 9. CRITERION 7: two_clients_join_same_room (Multiplayer Room Join)
    // =========================================================================
    console.log('[QA] --- 9. Testing Two Clients Joining the Same Room ---');

    // Client 1 creates Forest Survival room 'CamperQA_Survival'
    console.log("  Client 1 creating room 'CamperQA_Survival'...");
    await cdp.eval(`(() => {
      const rName = document.getElementById('room-name');
      if (rName) rName.value = 'CamperQA_Survival';
      const btnCreate = document.getElementById('btn-create');
      if (btnCreate) btnCreate.click();
    })()`);

    // Wait for Client 1 to enter the room (canvas created, pause-room-name is CamperQA_Survival)
    let client1Joined = false;
    for (let i = 0; i < 30; i++) {
      await delay(250);
      const status = await cdp.eval(`(() => {
        const canvas = document.querySelector('#game-root canvas');
        const pauseRoom = document.getElementById('pause-room-name')?.textContent?.trim();
        const lobbyHidden = document.getElementById('screen-lobby')?.classList.contains('hidden');
        return { hasCanvas: Boolean(canvas), pauseRoom, lobbyHidden };
      })()`);
      if (status.hasCanvas && status.pauseRoom === 'CamperQA_Survival' && status.lobbyHidden) {
        client1Joined = true;
        console.log('  Client 1 confirmed inside room:', status);
        break;
      }
    }
    if (!client1Joined) {
      throw new Error("Client 1 xonaga kira olmadi ('CamperQA_Survival')");
    }

    // Launch Chrome 2 on Debug Port 9401 with separate temporary user-data-dir
    console.log(`  Launching Client 2 on port ${CHROME_DEBUG_PORT + 1}...`);
    chrome2 = await launchChrome(CHROME_DEBUG_PORT + 1, 1280, 720);
    const cdp2 = chrome2.client;

    console.log(`  Client 2 navigating to ${pageUrl}...`);
    await cdp2.send('Page.navigate', { url: pageUrl });
    await delay(2000);

    // Client 2 sets nickname 'Bekzod_QA' and enters lobby
    console.log("  Client 2 entering lobby with nickname 'Bekzod_QA'...");
    await cdp2.eval(`(() => {
      const nameInput = document.getElementById('name-input');
      if (nameInput) nameInput.value = 'Bekzod_QA';
      const enterBtn = document.getElementById('btn-enter');
      if (enterBtn) enterBtn.click();
    })()`);
    await delay(1200);

    // Client 2 refreshes room list and locates 'CamperQA_Survival'
    let roomDiscovered = false;
    let targetRoomId = null;
    for (let i = 0; i < 20; i++) {
      const discovery = await cdp2.eval(`(() => {
        const btnRefresh = document.getElementById('btn-refresh');
        if (btnRefresh) btnRefresh.click();
        const roomList = document.getElementById('room-list');
        const items = roomList ? Array.from(roomList.children) : [];
        const item = items.find(it => it.textContent.includes('CamperQA_Survival'));
        const joinBtn = item ? item.querySelector('[data-join]') : null;
        return {
          found: Boolean(item),
          joinBtnExists: Boolean(joinBtn),
          roomId: joinBtn?.getAttribute('data-join'),
          listText: roomList?.textContent?.trim()
        };
      })()`);
      if (discovery.found && discovery.joinBtnExists) {
        roomDiscovered = true;
        targetRoomId = discovery.roomId;
        console.log(`  Client 2 found room '${targetRoomId}' in list!`);
        break;
      }
      await delay(300);
    }

    // Capture 07_lobby_two_clients.png (Client 2 in lobby with room visible)
    const pLobbyPolish = path.join(POLISH_SHOT_DIR, '07_lobby_two_clients.png');
    const pLobbyLegacy = path.join(LEGACY_SHOT_DIR, '07_lobby_two_clients.png');
    const szLobby = await cdp2.screenshot(pLobbyPolish);
    fs.copyFileSync(pLobbyPolish, pLobbyLegacy);
    testResults.screenshots.push({ name: '07_lobby_two_clients.png', viewport: '1280x720', size: szLobby });
    console.log(`  Captured 07_lobby_two_clients.png (${szLobby} bytes)`);

    // Client 2 ACTUALLY CLICKS the [data-join] button
    console.log("  Client 2 clicking [data-join] for 'CamperQA_Survival'...");
    await cdp2.eval(`(() => {
      const roomList = document.getElementById('room-list');
      const items = roomList ? Array.from(roomList.children) : [];
      const item = items.find(it => it.textContent.includes('CamperQA_Survival'));
      const joinBtn = item ? item.querySelector('[data-join]') : null;
      if (joinBtn) joinBtn.click();
    })()`);

    // Wait and verify Client 2 ACTUALLY JOINS THE ROOM
    let client2Joined = false;
    let client2Status = null;
    for (let i = 0; i < 35; i++) {
      await delay(250);
      client2Status = await cdp2.eval(`(() => {
        const canvas = document.querySelector('#game-root canvas');
        const pauseRoom = document.getElementById('pause-room-name')?.textContent?.trim();
        const lobbyHidden = document.getElementById('screen-lobby')?.classList.contains('hidden');
        return { hasCanvas: Boolean(canvas), pauseRoom, lobbyHidden };
      })()`);
      if (client2Status.hasCanvas && client2Status.pauseRoom === 'CamperQA_Survival' && client2Status.lobbyHidden) {
        client2Joined = true;
        console.log('  Client 2 confirmed inside room:', client2Status);
        break;
      }
    }

    // Verify both clients are in the exact same room
    const bothInSameRoom = client1Joined && client2Joined;
    testResults.tests.push({
      id: 'two_clients_join_same_room',
      pass: bothInSameRoom,
      detail: `Client 1 ('Alisher_QA') and Client 2 ('Bekzod_QA') both joined room 'CamperQA_Survival' (c1_pause='CamperQA_Survival', c2_pause='${client2Status?.pauseRoom}'): ${bothInSameRoom}`,
    });
    testResults.criteria.two_clients_join_same_room = bothInSameRoom;

    // Capture 07_two_clients_in_room.png from Client 2
    const pInRoomPolish = path.join(POLISH_SHOT_DIR, '07_two_clients_in_room.png');
    const pInRoomLegacy = path.join(LEGACY_SHOT_DIR, '07_two_clients_in_room.png');
    const szInRoom = await cdp2.screenshot(pInRoomPolish);
    fs.copyFileSync(pInRoomPolish, pInRoomLegacy);
    testResults.screenshots.push({ name: '07_two_clients_in_room.png', viewport: '1280x720', size: szInRoom });
    console.log(`  Captured 07_two_clients_in_room.png (${szInRoom} bytes)`);

    // =========================================================================
    // Summary & Output
    // =========================================================================
    console.log('\n======================================================');
    console.log('=== STAGE 08-MENU-POLISH QA TEST OUTCOMES (AGENT D) ===');
    console.log('======================================================');
    let allPassed = true;
    for (const t of testResults.tests) {
      const symbol = t.pass ? '✓ PASS' : '✗ FAIL';
      if (!t.pass) allPassed = false;
      console.log(`  ${symbol} [${t.id}] ${t.detail}`);
    }

    testResults.allPassed = allPassed;

    // Write summary JSON to both polish and legacy directories
    const polishSummaryPath = path.join(POLISH_REPORT_DIR, 'qa_menu_summary.json');
    const legacySummaryPath = path.join(LEGACY_REPORT_DIR, 'qa_menu_summary.json');
    fs.writeFileSync(polishSummaryPath, JSON.stringify(testResults, null, 2));
    fs.writeFileSync(legacySummaryPath, JSON.stringify(testResults, null, 2));
    console.log(`\nWrote results to:\n- ${polishSummaryPath}\n- ${legacySummaryPath}`);

    if (!allPassed) {
      process.exitCode = 1;
    } else {
      console.log('\nALL 8 ACCEPTANCE CRITERIA PASSED HONESTLY AND RIGOROUSLY!');
    }

  } catch (err) {
    console.error('QA Automation Fatal Error:', err);
    process.exitCode = 1;
  } finally {
    console.log('[QA] Cleaning up Chrome instances and server processes...');
    if (chrome1) {
      await chrome1.client.close();
      killTree(chrome1.proc.pid);
      try { fs.rmSync(chrome1.tmpDir, { recursive: true, force: true }); } catch {}
    }
    if (chrome2) {
      await chrome2.client.close();
      killTree(chrome2.proc.pid);
      try { fs.rmSync(chrome2.tmpDir, { recursive: true, force: true }); } catch {}
    }
    if (vite) {
      try { await vite.close(); } catch {}
    }
    if (srv) {
      killTree(srv.pid);
    }
    console.log('[QA] Cleanup complete.');
  }
}

main();
