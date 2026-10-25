#!/usr/bin/env -S npx tsx
/**
 * STAGE 08B-PRODUCTION-SMOKE — real Vite production bundle, real Chrome, real input only.
 *
 * - Serves the already-built `dist/` with `npm run serve` (Express + Socket.IO on ONE port).
 *   No Vite dev server, no HMR, no DEV build.
 * - Opens up to 3 visible (headful) Chrome windows, each with a fresh temporary profile.
 * - Game control is ONLY real browser input sent through CDP `Input.dispatchMouseEvent` /
 *   `Input.dispatchKeyEvent` / `Input.insertText` (trusted events, same path as a physical
 *   mouse/keyboard). No `window.__DEV_*` hooks, no client state injection, no network muting.
 * - Observation is passive: DOM reads (rects/text/classes), WebSocket frames
 *   (`Network.webSocketFrameReceived/Sent`), console/exception/network events, screenshots,
 *   screencast video.
 * - Routing to loot containers is computed OFFLINE in this Node process from the shared world
 *   definition + server NavGraph (same seed the room reports) and executed with W + mouse-look.
 *
 * Usage: npx tsx scripts/prod-smoke-08b.mts [--port=3600] [--out=docs/stage08b-prod-smoke]
 *        [--parts=tdm,ffa,survival,vsync] [--vsyncSec=20]
 */
import { execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorldDefinition } from '../src/shared/world';
import { NavGraph } from '../src/server/navgraph';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...r] = a.replace(/^--/, '').split('=');
    return [k, r.length ? r.join('=') : 'true'];
  }),
);
const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(args.port ?? 3600);
const OUT = path.resolve(WORKSPACE, String(args.out ?? 'docs/stage08b-prod-smoke'));
const PARTS = new Set(String(args.parts ?? 'tdm,ffa,survival,vsync').split(','));
const VSYNC_SEC = Number(args.vsyncSec ?? 20);
const SHOTS = path.join(OUT, 'shots');
const VIDEOS = path.join(OUT, 'videos');
const LOGS = path.join(OUT, 'logs');
for (const d of [SHOTS, VIDEOS, LOGS]) fs.mkdirSync(d, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_LOG = fs.createWriteStream(path.join(LOGS, 'prod_smoke_run.log'));
const log = (...a: unknown[]) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  RUN_LOG.write(line + '\n');
};
const rel = (p: string) => path.relative(WORKSPACE, p).replace(/\\/g, '/');

type Status = 'PASS' | 'FAIL' | 'NOT_TESTED' | 'INFO';
const checks: { id: string; status: Status; note?: string; details?: unknown }[] = [];
function check(id: string, status: Status, note?: string, details?: unknown) {
  checks.push({ id, status, note, details });
  log(`  [check] ${id.padEnd(46)} ${status}${note ? ' — ' + note : ''}`);
}
const ok = (c: boolean): Status => (c ? 'PASS' : 'FAIL');

// ------------------------------------------------------------------------------------------
// processes
// ------------------------------------------------------------------------------------------
const procs: ChildProcess[] = [];
const tmpDirs: string[] = [];
function killTree(pid?: number) {
  if (!pid) return;
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}
async function httpGet(url: string) {
  try {
    const r = await fetch(url);
    return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() };
  } catch (e) {
    return { status: 0, type: '', body: String(e) };
  }
}
async function startProdServer() {
  if ((await httpGet(`${BASE}/api/info`)).status) throw new Error(`port ${PORT} busy`);
  const out = fs.createWriteStream(path.join(LOGS, `server_npm_run_serve_${PORT}.log`));
  const p = spawn('npm run serve', { cwd: WORKSPACE, shell: true, env: { ...process.env, PORT: String(PORT) } });
  p.stdout?.pipe(out);
  p.stderr?.pipe(out);
  procs.push(p);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await httpGet(`${BASE}/api/info`)).status === 200) return p;
    await delay(300);
  }
  throw new Error('npm run serve did not come up');
}

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
interface Client {
  label: string;
  cdp: Cdp;
  proc: ChildProcess;
  frames: { dir: 'in' | 'out'; t: number; ev: string; data: unknown; ackId?: number }[];
  wsUrls: string[];
  lastSnap: any;
  lastLoot: any;
  roster: any[];
  match: any;
  myId: string | null;
  welcome: any;
  read<T = any>(expr: string): Promise<T>;
}

class Cdp {
  ws: WebSocket;
  seq = 0;
  pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  listeners = new Map<string, Set<(p: any) => void>>();
  consoleErrors: unknown[] = [];
  warnings = new Map<string, number>();
  exceptions: unknown[] = [];
  logErrors: unknown[] = [];
  netErrors: unknown[] = [];
  netAborted: unknown[] = [];
  glbLoads: { url: string; status: number; bytes?: number }[] = [];
  reqUrl = new Map<string, string>();
  constructor(url: string, public label: string) {
    this.ws = new WebSocket(url);
  }
  async connect() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(JSON.stringify(m.error)));
        else p.res(m.result);
        return;
      }
      const p = m.params ?? {};
      for (const fn of this.listeners.get(m.method) ?? []) fn(p);
      const at = new Date().toISOString();
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 500);
        if (p.type === 'error' || p.type === 'assert') this.consoleErrors.push({ at, text });
        else if (p.type === 'warning') this.warnings.set(text.slice(0, 160), (this.warnings.get(text.slice(0, 160)) ?? 0) + 1);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.exceptions.push({ at, text: String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 600) });
      } else if (m.method === 'Log.entryAdded' && p.entry?.level === 'error') {
        this.logErrors.push({ at, source: p.entry.source, text: String(p.entry.text).slice(0, 400), url: p.entry.url });
      } else if (m.method === 'Network.requestWillBeSent') {
        this.reqUrl.set(p.requestId, p.request?.url ?? '');
      } else if (m.method === 'Network.responseReceived') {
        const url = p.response?.url ?? '';
        const status = p.response?.status ?? 0;
        if (status >= 400) this.netErrors.push({ at, status, url });
        if (/\.glb(\?|$)/i.test(url)) this.glbLoads.push({ url: url.replace(BASE, ''), status });
      } else if (m.method === 'Network.loadingFailed') {
        const rec = { at, url: this.reqUrl.get(p.requestId), errorText: p.errorText, canceled: p.canceled };
        if (p.canceled || p.errorText === 'net::ERR_ABORTED') this.netAborted.push(rec);
        else this.netErrors.push(rec);
      }
    });
  }
  on(method: string, fn: (p: any) => void) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(fn);
    return () => this.listeners.get(method)!.delete(fn);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Read-only DOM query (no game state is written). */
  async read<T = any>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`read error (${this.label}): ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result?.value as T;
  }
  async waitRead(expr: string, timeoutMs = 30000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = await this.read(expr);
        if (v) return v;
      } catch {
        /* page navigating */
      }
      await delay(200);
    }
    throw new Error(`${this.label}: timed out waiting for ${label.slice(0, 160)}`);
  }
}

async function openChrome(label: string, debugPort: number, x: number, y: number): Promise<Client> {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), `cs65-prod-${label}-`));
  tmpDirs.push(userDir);
  const proc = spawn(
    CHROME,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      `--window-position=${x},${y}`,
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  procs.push(proc);
  let target: any = null;
  const t0 = Date.now();
  while (!target && Date.now() - t0 < 30000) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as any[];
      target = list.find((t) => t.type === 'page');
    } catch {
      /* not up yet */
    }
    if (!target) await delay(300);
  }
  if (!target) throw new Error(`${label}: chrome target not found`);
  const cdp = new Cdp(target.webSocketDebuggerUrl, label);
  await cdp.connect();
  for (const d of ['Page', 'Runtime', 'Network', 'Log']) await cdp.send(`${d}.enable`);
  const c: Client = {
    label, cdp, proc, frames: [], wsUrls: [], lastSnap: null, lastLoot: null, roster: [], match: null, myId: null, welcome: null,
    read: (expr) => cdp.read(expr),
  };
  cdp.on('Network.webSocketCreated', (p) => c.wsUrls.push(p.url));
  const parse = (dir: 'in' | 'out', payload: string) => {
    if (typeof payload !== 'string') return;
    const m = /^4([23])(\d*)(\[.*)$/s.exec(payload);
    if (!m) return;
    let arr: any;
    try {
      arr = JSON.parse(m[3]);
    } catch {
      return;
    }
    const isAck = m[1] === '3';
    const ev = isAck ? `ack#${m[2]}` : String(arr[0]);
    const data = isAck ? arr[0] : arr[1];
    if (ev === 'snap') c.lastSnap = data;
    else if (ev === 'loot:snapshot') c.lastLoot = data;
    else if (ev === 'roster') c.roster = data;
    else if (ev === 'match') c.match = data;
    if (isAck && data?.welcome) {
      c.welcome = data.welcome;
      c.myId = data.welcome.you;
    }
    if (ev !== 'snap' && ev !== 'input' && ev !== 'state') c.frames.push({ dir, t: Date.now(), ev, data: JSON.stringify(data ?? null).slice(0, 2000) });
    else if (c.frames.filter((f) => f.ev === ev).length < 3) c.frames.push({ dir, t: Date.now(), ev, data: '(sample)' });
  };
  cdp.on('Network.webSocketFrameReceived', (p) => parse('in', p.response?.payloadData));
  cdp.on('Network.webSocketFrameSent', (p) => parse('out', p.response?.payloadData));
  return c;
}

// ------------------------------------------------------------------------------------------
// real input
// ------------------------------------------------------------------------------------------
const KEYS: Record<string, { key: string; vk: number; text?: string }> = {
  KeyW: { key: 'w', vk: 87, text: 'w' },
  KeyA: { key: 'a', vk: 65, text: 'a' },
  KeyS: { key: 's', vk: 83, text: 's' },
  KeyD: { key: 'd', vk: 68, text: 'd' },
  KeyE: { key: 'e', vk: 69, text: 'e' },
  KeyV: { key: 'v', vk: 86, text: 'v' },
  KeyR: { key: 'r', vk: 82, text: 'r' },
  Space: { key: ' ', vk: 32, text: ' ' },
  ShiftLeft: { key: 'Shift', vk: 16 },
  Escape: { key: 'Escape', vk: 27 },
  Enter: { key: 'Enter', vk: 13, text: '\r' },
  Backspace: { key: 'Backspace', vk: 8 },
  Digit0: { key: '0', vk: 48, text: '0' },
  Digit1: { key: '1', vk: 49, text: '1' },
  Digit2: { key: '2', vk: 50, text: '2' },
  Digit3: { key: '3', vk: 51, text: '3' },
  Digit4: { key: '4', vk: 52, text: '4' },
};
async function keyDown(c: Client, code: string, modifiers = 0) {
  const k = KEYS[code];
  await c.cdp.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', code, key: k.key, windowsVirtualKeyCode: k.vk, text: k.text, modifiers });
}
async function keyUp(c: Client, code: string, modifiers = 0) {
  const k = KEYS[code];
  await c.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k.key, windowsVirtualKeyCode: k.vk, modifiers });
}
async function tap(c: Client, code: string, holdMs = 60) {
  await keyDown(c, code);
  await delay(holdMs);
  await keyUp(c, code);
}
let mouse = new Map<string, { x: number; y: number }>();
async function click(c: Client, x: number, y: number, button: 'left' | 'right' = 'left') {
  await c.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await delay(40);
  await c.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
  mouse.set(c.label, { x, y });
}
async function rectOf(c: Client, sel: string) {
  return c.read<{ x: number; y: number; w: number; h: number; vis: boolean } | null>(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, vis: r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' };
  })()`);
}
async function clickSel(c: Client, sel: string, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await rectOf(c, sel).catch(() => null);
    if (r?.vis) {
      await click(c, Math.round(r.x), Math.round(r.y));
      return;
    }
    await delay(200);
  }
  throw new Error(`${c.label}: element not clickable: ${sel}`);
}
async function typeInto(c: Client, sel: string, text: string) {
  await clickSel(c, sel);
  await c.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 2 });
  await c.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 2 });
  await tap(c, 'Backspace', 20);
  await c.cdp.send('Input.insertText', { text });
}
/** Pointer-locked mouse look: successive mouseMoved events; Chrome derives movementX from the delta. */
async function look(c: Client, dx: number, dy = 0) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 40));
  let p = mouse.get(c.label) ?? { x: 640, y: 360 };
  for (let i = 0; i < steps; i++) {
    p = { x: p.x + dx / steps, y: p.y + dy / steps };
    await c.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await delay(16);
  }
  // re-centre without generating movement: pointer lock ignores absolute position, only deltas matter
  mouse.set(c.label, p);
}

// ------------------------------------------------------------------------------------------
// evidence
// ------------------------------------------------------------------------------------------
async function shot(c: Client, name: string) {
  const { data } = await c.cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, `prod_${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  log(`  [shot] ${rel(file)}`);
  return rel(file);
}
const FFMPEG = (() => {
  const root = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  try {
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('ffmpeg'))) {
      for (const f of fs.readdirSync(path.join(root, d))) if (/^ffmpeg.*\.exe$/i.test(f)) return path.join(root, d, f);
    }
  } catch {
    /* none */
  }
  return null;
})();
const VIDEO = args.video === 'true';
async function record(c: Client, name: string, seconds: number, during: () => Promise<void>) {
  if (!VIDEO) {
    // video evidence is opt-in (--video); screenshots are the default evidence
    await during();
    return null;
  }
  const frames: { t: number; data: string }[] = [];
  const off = c.cdp.on('Page.screencastFrame', async (p) => {
    frames.push({ t: p.metadata?.timestamp ?? Date.now() / 1000, data: p.data });
    c.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });
  await c.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
  const t0 = Date.now();
  await Promise.all([during(), delay(seconds * 1000)]);
  await c.cdp.send('Page.stopScreencast');
  off();
  const dur = (Date.now() - t0) / 1000;
  if (!FFMPEG || frames.length < 5) {
    log(`  [video] ${name}: ${frames.length} frames, ffmpeg=${Boolean(FFMPEG)} — skipped`);
    return null;
  }
  // constant 30 fps by timestamp resampling, piped as MJPEG (the Playwright ffmpeg build has image2pipe only)
  const fps = 30;
  const n = Math.max(1, Math.round(dur * fps));
  const base = frames[0].t;
  const seq: Buffer[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const tt = base + i / fps;
    while (j + 1 < frames.length && frames[j + 1].t <= tt) j++;
    seq.push(Buffer.from(frames[j].data, 'base64'));
  }
  const out = path.join(VIDEOS, `prod_${name}.webm`);
  const enc = spawnSync(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0', '-an', '-c:v', 'vp8', '-b:v', '3M', '-pix_fmt', 'yuv420p', '-y', out],
    { input: Buffer.concat(seq), maxBuffer: 1 << 30 },
  );
  if (enc.status !== 0) {
    log(`  [video] ${name}: ffmpeg failed: ${String(enc.stderr).slice(0, 300)}`);
    return null;
  }
  log(`  [video] ${rel(out)} (${frames.length} src frames, ${dur.toFixed(1)} s)`);
  return rel(out);
}

// ------------------------------------------------------------------------------------------
// game helpers (UI flow)
// ------------------------------------------------------------------------------------------
async function enterLobby(c: Client, name: string) {
  await c.cdp.send('Page.navigate', { url: `${BASE}/` });
  await c.cdp.waitRead(`document.querySelector('#conn-status')?.classList.contains('ok')`, 60000, 'conn ok');
  // nickname via the profile chip → "Ismni o'zgartirish" modal → Saqlash (real clicks + typing)
  const modalOpen = () => c.read<boolean>(`!document.getElementById('modal-nickname')?.classList.contains('hidden')`);
  if (!(await modalOpen())) await clickSel(c, '#btn-menu-edit-name');
  await c.cdp.waitRead(`!document.getElementById('modal-nickname')?.classList.contains('hidden')`, 5000, 'nickname modal');
  await typeInto(c, '#modal-name-input', name);
  await clickSel(c, '#btn-save-nickname');
  await c.cdp.waitRead(`document.getElementById('modal-nickname')?.classList.contains('hidden')`, 5000, 'nickname modal closed');
  await clickSel(c, '#btn-enter');
  await c.cdp.waitRead(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`, 30000, 'lobby');
}
async function selectOption(c: Client, sel: string, value: string) {
  // keyboard selection on a focused <select>: Home, then ArrowDown until the value matches (real key events)
  await clickSel(c, sel);
  await delay(150);
  await tap(c, 'Escape');
  for (let i = 0; i < 12; i++) {
    const v = await c.read<string>(`document.querySelector(${JSON.stringify(sel)}).value`);
    if (v === value) return;
    await c.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await c.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await delay(80);
  }
  throw new Error(`${c.label}: could not select ${value} in ${sel}`);
}
async function createRoom(c: Client, roomName: string, mode: 'tdm' | 'ffa' | 'forest_survival', timeMin: number) {
  await clickSel(c, `.mode-card[data-mode="${mode}"]`).catch(() => undefined);
  await selectOption(c, '#room-mode', mode);
  await typeInto(c, '#room-name', roomName);
  if (mode !== 'forest_survival') {
    const lp = await c.read<boolean>(`document.getElementById('room-loot-preview').checked`);
    if (lp) await clickSel(c, '#room-loot-preview');
    const mapDisabled = await c.read<boolean>(`document.getElementById('room-map').disabled`);
    if (!mapDisabled) await selectOption(c, '#room-map', 'forest_square');
  }
  const open = await c.read<boolean>(`document.getElementById('advanced-settings-accordion').open`);
  if (!open) await clickSel(c, '#advanced-settings-accordion summary');
  const botsDisabled = await c.read<boolean>(`document.getElementById('room-bots').disabled`);
  if (!botsDisabled) await typeInto(c, '#room-bots', '0');
  await typeInto(c, '#room-time', String(timeMin));
  await clickSel(c, '#btn-create');
  await c.cdp.waitRead(`document.getElementById('screen-lobby')?.classList.contains('hidden') && Boolean(document.querySelector('canvas'))`, 60000, 'in game');
}
async function joinRoom(c: Client, roomName: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await clickSel(c, '#btn-refresh');
    await delay(500);
    const has = await c.read<boolean>(`Array.from(document.querySelectorAll('.room-item')).some((el) => el.textContent.includes(${JSON.stringify(roomName)}) && el.querySelector('[data-join]:not([disabled])'))`);
    if (has) {
      const r = await c.read<{ x: number; y: number }>(`(() => { const it = Array.from(document.querySelectorAll('.room-item')).find((el) => el.textContent.includes(${JSON.stringify(roomName)})); const b = it.querySelector('[data-join]'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await click(c, Math.round(r.x), Math.round(r.y));
      await c.cdp.waitRead(`document.getElementById('screen-lobby')?.classList.contains('hidden') && Boolean(document.querySelector('canvas'))`, 60000, 'in game');
      return;
    }
  }
  throw new Error(`${c.label}: room ${roomName} not listed`);
}
/**
 * Pointer lock is only granted to the OS-focused window: bring this client's Chrome window to the
 * foreground (Win32 SetForegroundWindow with the ALT-key unlock trick). Desktop focus only — no game state.
 */
const FOCUS_PS = path.join(os.tmpdir(), 'cs65-focus-window.ps1');
fs.writeFileSync(
  FOCUS_PS,
  `param([int]$ProcId)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
 [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); }
"@
$h = (Get-Process -Id $ProcId).MainWindowHandle
if ($h -eq 0) { exit 2 }
[W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::ShowWindow($h, 9) | Out-Null; $ok = [W]::SetForegroundWindow($h); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
if ($ok) { exit 0 } else { exit 1 }
`,
);
async function focusWindow(c: Client) {
  await c.cdp.send('Page.bringToFront').catch(() => undefined);
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${FOCUS_PS}" -ProcId ${c.proc.pid}`, { stdio: 'ignore', timeout: 15000 });
  } catch {
    /* focus may be refused by Windows; lockPointer reports the outcome */
  }
  await delay(400);
  return c.read<boolean>('document.hasFocus()');
}
async function lockPointer(c: Client) {
  for (let i = 0; i < 8; i++) {
    const locked = await c.read<boolean>(`Boolean(document.pointerLockElement)`);
    if (locked) return true;
    const focused = await focusWindow(c);
    if (i > 0) log(`  lock retry ${c.label} #${i}: hasFocus=${focused}`);
    const resume = await rectOf(c, '#btn-resume').catch(() => null);
    if (resume?.vis) await click(c, Math.round(resume.x), Math.round(resume.y));
    else await click(c, 640, 400);
    await delay(500);
  }
  return c.read<boolean>(`Boolean(document.pointerLockElement)`);
}
async function leaveRoom(c: Client) {
  await tap(c, 'Escape');
  await delay(400);
  await clickSel(c, '#btn-leave');
  await c.cdp.waitRead(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`, 20000, 'back to lobby');
}
const me = (c: Client) => c.lastSnap?.players?.find((p: any) => p.id === c.myId) ?? null;
const other = (c: Client, id: string | null) => c.lastSnap?.players?.find((p: any) => p.id === id) ?? null;
const speedOf = (p: any) => (p ? Math.hypot(p.vx, p.vz) : 0);
async function sampleSpeed(observer: Client, id: string | null, ms: number) {
  const s: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = other(observer, id);
    if (p?.alive && p.onGround) s.push(speedOf(p));
    await delay(100);
  }
  s.sort((a, b) => a - b);
  // p75: robust to the accel ramp and to a brief brush against a tree/rock on a random spawn heading
  return s.length ? s[Math.floor(s.length * 0.75)] : null;
}
/** Turn A toward the longest clear straight lane (offline world physics) so speed samples are not obstacle-limited. */
async function faceOpenLane(c: Client) {
  const p = me(c);
  if (!p || !radPerPx) return;
  let best = { yaw: p.yaw, free: -1 };
  for (let k = 0; k < 24; k++) {
    const yaw = (k / 24) * Math.PI * 2 - Math.PI;
    const path0 = nav.findPath({ x: p.x, y: p.y, z: p.z }, { x: p.x - Math.sin(yaw) * 25, y: p.y, z: p.z - Math.cos(yaw) * 25 });
    // straightness = how close the nav path stays to the straight line
    const straight = path0.length >= 2 && path0.every((q) => Math.abs((q.x - p.x) * Math.cos(yaw) - (q.z - p.z) * -Math.sin(yaw)) < 1.5);
    const free = straight ? Math.hypot(path0[path0.length - 1].x - p.x, path0[path0.length - 1].z - p.z) : 0;
    if (free > best.free) best = { yaw, free };
  }
  await faceYaw(c, best.yaw);
  log(`  open lane yaw=${best.yaw.toFixed(2)} free≈${best.free.toFixed(1)} m`);
}
async function waitAssets(c: Client) {
  // passive: all GLB responses seen and no loading overlay
  await c.cdp.waitRead(`!document.getElementById('loading')?.offsetParent`, 60000, 'loading overlay gone').catch(() => undefined);
  await delay(2500);
}
async function worldChecks(prefix: string, A: Client, B: Client) {
  const wa = A.welcome?.world;
  const wb = B.welcome?.world;
  check(`${prefix}.welcome.received`, ok(Boolean(wa && wb)), undefined, { A: wa, B: wb });
  check(`${prefix}.sameRoomId`, ok(Boolean(A.welcome?.room?.id) && A.welcome?.room?.id === B.welcome?.room?.id), `${A.welcome?.room?.id} / ${B.welcome?.room?.id}`);
  check(`${prefix}.gameplayHash`, ok(wa?.gameplayHash === '670a9c21f0565c94' && wb?.gameplayHash === wa?.gameplayHash), `${wa?.gameplayHash} / ${wb?.gameplayHash}`);
  check(`${prefix}.worldVersion`, ok(wa?.worldVersion === 2 && wb?.worldVersion === 2), `${wa?.worldVersion} / ${wb?.worldVersion}`);
  const seen = await B.cdp
    .waitRead('true', 1)
    .then(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        if (other(B, A.myId) && other(A, B.myId)) return true;
        await delay(200);
      }
      return false;
    });
  check(`${prefix}.seeEachOther(snapshots)`, ok(seen));
}
async function devHooksAbsent(c: Client) {
  const r = await c.read<Record<string, string>>(`({ tools: typeof window.__DEV_GAME_TOOLS__, cam: typeof window.__DEV_CAMERA_OVERRIDE__, lock: typeof window.__DEV_PLAYER_POSE_LOCK__, devStats: String(Boolean(document.getElementById('dev-stats')?.offsetParent)) })`);
  return r;
}

// ------------------------------------------------------------------------------------------
// steering (offline route from shared world + NavGraph; executed with W + mouse look)
// ------------------------------------------------------------------------------------------
const world = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 });
const nav = new NavGraph(world);
let radPerPx: number | null = null;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
async function calibrateLook(c: Client) {
  const y0 = me(c)?.yaw;
  await look(c, 200);
  await delay(500);
  const y1 = me(c)?.yaw;
  // default sensitivity ≈ 0.0022 rad/px; anything far below means the lock dropped mid-move
  if (typeof y0 === 'number' && typeof y1 === 'number' && Math.abs(wrap(y1 - y0)) > 0.1) radPerPx = wrap(y1 - y0) / 200;
  log(`  look calibration: ${radPerPx} rad/px (yaw ${y0} → ${y1})`);
  return radPerPx;
}
async function faceYaw(c: Client, target: number) {
  for (let i = 0; i < 4; i++) {
    const y = me(c)?.yaw;
    if (typeof y !== 'number' || !radPerPx) return;
    const d = wrap(target - y);
    if (Math.abs(d) < 0.06) return;
    await look(c, d / radPerPx);
    await delay(250);
  }
}
const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
async function driveTo(c: Client, goal: { x: number; y: number; z: number }, arriveR: number, timeoutMs = 60000) {
  const p0 = me(c);
  const path0 = nav.findPath({ x: p0.x, y: p0.y, z: p0.z }, goal);
  const wps = path0.length ? path0.slice(1) : [goal];
  wps.push(goal);
  const t0 = Date.now();
  let wi = 0;
  let lastPos = { x: p0.x, z: p0.z, t: Date.now() };
  await keyDown(c, 'KeyW');
  try {
    while (Date.now() - t0 < timeoutMs) {
      const p = me(c);
      if (!p) break;
      if (Math.hypot(goal.x - p.x, goal.z - p.z) <= arriveR) return true;
      while (wi < wps.length - 1 && Math.hypot(wps[wi].x - p.x, wps[wi].z - p.z) < 1.2) wi++;
      const want = yawTo(p, wps[wi]);
      if (Math.abs(wrap(want - p.yaw)) > 0.12) await look(c, wrap(want - p.yaw) / (radPerPx ?? 0.002));
      if (Date.now() - lastPos.t > 1500) {
        if (Math.hypot(p.x - lastPos.x, p.z - lastPos.z) < 0.4) {
          // stuck: hop + small strafe
          await tap(c, 'Space', 80);
          await keyDown(c, 'KeyD');
          await delay(350);
          await keyUp(c, 'KeyD');
        }
        lastPos = { x: p.x, z: p.z, t: Date.now() };
      }
      await delay(120);
    }
    return false;
  } finally {
    await keyUp(c, 'KeyW');
  }
}

// ------------------------------------------------------------------------------------------
// parts
// ------------------------------------------------------------------------------------------
const evidence: Record<string, unknown> = {};

async function partTdm(A: Client, B: Client) {
  log('== TDM (2 clients) ==');
  await enterLobby(A, 'ProdA');
  await enterLobby(B, 'ProdB');
  await createRoom(A, 'prod-tdm', 'tdm', 10);
  await joinRoom(B, 'prod-tdm');
  await waitAssets(A);
  await waitAssets(B);
  await worldChecks('tdm', A, B);
  check('tdm.devHooksAbsent.A', 'INFO', JSON.stringify(await devHooksAbsent(A)));
  // only one OS window can hold pointer lock: B first (turn to face A), then A keeps it for movement
  const lockB = await lockPointer(B);
  await calibrateLook(B);
  await delay(500);
  const a0 = other(B, A.myId);
  const b0 = me(B);
  if (a0 && b0) await faceYaw(B, yawTo(b0, a0));
  const lockA = await lockPointer(A);
  check('tdm.pointerLock(real click, focused window)', ok(lockA && lockB), `A=${lockA} B=${lockB}`);
  check('tdm.mouseLook(real mousemove)', ok(radPerPx !== null), `rad/px=${radPerPx}`);
  evidence.tdm_idle_3p = await shot(A, 'tdm_A_3p_idle');
  evidence.tdm_remote_idle = await shot(B, 'tdm_B_sees_A_idle');
  if (!radPerPx) await calibrateLook(A);
  await faceOpenLane(A);
  // run (W) — measured from B's snapshots of A (server-authoritative)
  await keyDown(A, 'KeyW');
  await delay(800);
  evidence.tdm_run_3p = await shot(A, 'tdm_A_3p_run');
  const runSpeed = await sampleSpeed(B, A.myId, 1500);
  await keyUp(A, 'KeyW');
  check('tdm.run≈6.5 m/s (B sees A, server snap)', ok(runSpeed !== null && Math.abs(runSpeed - 6.5) < 0.6), `${runSpeed?.toFixed(2)} m/s`);
  // walk (Shift+W)
  await keyDown(A, 'ShiftLeft');
  await keyDown(A, 'KeyW', 8);
  await delay(800);
  evidence.tdm_walk_3p = await shot(A, 'tdm_A_3p_walk');
  const walkSpeed = await sampleSpeed(B, A.myId, 1500);
  await keyUp(A, 'KeyW', 8);
  await keyUp(A, 'ShiftLeft');
  check('tdm.walk≈3.0 m/s (B sees A, server snap)', ok(walkSpeed !== null && Math.abs(walkSpeed - 3.0) < 0.5), `${walkSpeed?.toFixed(2)} m/s`);
  // jump
  await keyDown(A, 'KeyW');
  await tap(A, 'Space', 80);
  await delay(250);
  const airborne = other(B, A.myId)?.onGround === false;
  evidence.tdm_jump_3p = await shot(A, 'tdm_A_3p_jump');
  await keyUp(A, 'KeyW');
  check('tdm.jump (B sees A airborne)', ok(airborne));
  // 1P (V)
  await delay(600);
  await tap(A, 'KeyV');
  await delay(500);
  evidence.tdm_1p_idle = await shot(A, 'tdm_A_1p_idle');
  await keyDown(A, 'KeyW');
  await delay(700);
  evidence.tdm_1p_run = await shot(A, 'tdm_A_1p_run');
  await keyUp(A, 'KeyW');
  await keyDown(A, 'ShiftLeft');
  await keyDown(A, 'KeyW', 8);
  await delay(700);
  evidence.tdm_1p_walk = await shot(A, 'tdm_A_1p_walk');
  await keyUp(A, 'KeyW', 8);
  await keyUp(A, 'ShiftLeft');
  await tap(A, 'KeyV');
  await delay(400);
  // 4 weapons (number keys) — B must see each in A's server snapshot
  const weaponKeys: [string, string][] = [['Digit1', 'rifle'], ['Digit2', 'pistol'], ['Digit3', 'shotgun'], ['Digit4', 'sniper']];
  const seenW: Record<string, unknown> = {};
  for (const [k, w] of weaponKeys) {
    await tap(A, k);
    await delay(900);
    seenW[w] = other(B, A.myId)?.weapon ?? null;
    evidence[`tdm_weapon_${w}_3p`] = await shot(A, `tdm_A_3p_${w}`);
    evidence[`tdm_weapon_${w}_remote`] = await shot(B, `tdm_B_sees_A_${w}`);
    await tap(A, 'KeyV');
    await delay(400);
    evidence[`tdm_weapon_${w}_1p`] = await shot(A, `tdm_A_1p_${w}`);
    await tap(A, 'KeyV');
    await delay(300);
  }
  check('tdm.4weapons (B sees A weapon via snap)', ok(weaponKeys.every(([, w]) => seenW[w] === w)), JSON.stringify(seenW));
  await tap(A, 'Digit1');
  // videos: A 3P run/walk loop and B watching A
  evidence.tdm_video_3p = await record(A, 'tdm_A_3p_walk_run', 8, async () => {
    await keyDown(A, 'ShiftLeft');
    await keyDown(A, 'KeyW', 8);
    await delay(3500);
    await keyUp(A, 'ShiftLeft');
    await delay(3500);
    await keyUp(A, 'KeyW');
  });
  await lockPointer(B);
  const a1 = other(B, A.myId);
  const b1 = me(B);
  if (a1 && b1) await faceYaw(B, yawTo(b1, a1));
  await lockPointer(A);
  evidence.tdm_video_remote = await record(B, 'tdm_B_watches_A_run', 6, async () => {
    await keyDown(A, 'KeyS');
    await delay(2500);
    await keyUp(A, 'KeyS');
    await keyDown(A, 'KeyW');
    await delay(2500);
    await keyUp(A, 'KeyW');
  });
  await leaveRoom(A).catch((e) => log('leave A', String(e)));
  await leaveRoom(B).catch((e) => log('leave B', String(e)));
}

async function partFfa(A: Client, B: Client) {
  log('== FFA (2 clients) ==');
  A.welcome = null;
  B.welcome = null;
  await createRoom(A, 'prod-ffa', 'ffa', 10);
  await joinRoom(B, 'prod-ffa');
  await waitAssets(A);
  await waitAssets(B);
  await worldChecks('ffa', A, B);
  evidence.ffa_A = await shot(A, 'ffa_A');
  evidence.ffa_B = await shot(B, 'ffa_B');
  await leaveRoom(A).catch((e) => log('leave A', String(e)));
  await leaveRoom(B).catch((e) => log('leave B', String(e)));
}

async function partSurvival(A: Client, B: Client, C: Client) {
  log('== Forest Survival (A,B contenders + C mid-round spectator) ==');
  A.welcome = null;
  B.welcome = null;
  await createRoom(A, 'prod-surv', 'forest_survival', 2);
  await joinRoom(B, 'prod-surv');
  await waitAssets(A);
  await waitAssets(B);
  await worldChecks('survival', A, B);
  await lockPointer(A);
  // countdown → playing
  const playing = await A.cdp
    .waitRead('true', 1)
    .then(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 40000) {
        if (A.match?.phase === 'playing' || A.match?.survival?.phase === 'playing') return true;
        await delay(300);
      }
      return false;
    });
  check('survival.countdown→playing', ok(playing), JSON.stringify(A.match ?? null).slice(0, 200));
  check('survival.lootSnapshot.sameRoom', ok(A.lastLoot?.roomId && A.lastLoot.roomId === B.lastLoot?.roomId), `${A.lastLoot?.roomId} / ${B.lastLoot?.roomId}`);
  if (!radPerPx) await calibrateLook(A);
  // nearest containers by nav distance; try up to 4 until a weapon is found
  const tried = new Set<string>();
  let equipped: string | null = null;
  for (let attempt = 0; attempt < 4 && !equipped; attempt++) {
    const p = me(A);
    const cands = (A.lastLoot?.containers ?? [])
      .filter((cn: any) => !tried.has(cn.id) && cn.status !== 'empty')
      .map((cn: any) => ({ cn, d: Math.hypot(cn.position.x - p.x, cn.position.z - p.z) }))
      .sort((a: any, b: any) => a.d - b.d);
    if (!cands.length) break;
    const target = cands[0].cn;
    tried.add(target.id);
    log(`  → container ${target.id} at ${target.position.x.toFixed(1)},${target.position.z.toFixed(1)} (${cands[0].d.toFixed(1)} m)`);
    const arrived = await driveTo(A, target.position, Math.max(0.8, target.interactionRadius - 0.3), 70000);
    check(`survival.reachContainer#${attempt + 1}`, arrived ? 'PASS' : 'INFO', target.id);
    if (!arrived) continue;
    const q = me(A);
    await faceYaw(A, yawTo(q, target.position));
    await look(A, 0, 60); // look slightly down at the box
    await delay(300);
    await tap(A, 'KeyE');
    const opened = await A.cdp
      .waitRead('true', 1)
      .then(async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 5000) {
          const cs = A.lastLoot?.containers?.find((x: any) => x.id === target.id);
          const fr = A.frames.findLast?.((f) => f.ev === 'container:state' && String(f.data).includes(target.id));
          if (cs?.opened || (fr && String(fr.data).includes('"opened":true'))) return true;
          await delay(200);
        }
        return false;
      });
    evidence[`survival_open_${attempt + 1}`] = await shot(A, `survival_A_container_open_${attempt + 1}`);
    if (!opened) continue;
    check('survival.openContainer(E key)', 'PASS', target.id);
    // read the loot panel (DOM) and take a weapon row with its shown key
    const rows = await A.read<{ text: string; key: string }[]>(`Array.from(document.querySelectorAll('[class*="loot"] [class*="item"], [class*="loot"] li')).map((el) => ({ text: el.textContent.trim().slice(0, 120), key: (el.textContent.match(/\\[(E|\\d)\\]/) || [])[1] || '' })).filter((r) => r.text)`);
    log('  loot rows:', rows);
    const contState = A.frames.filter((f) => f.ev === 'container:state' || f.ev.startsWith('ack#')).map((f) => String(f.data)).reverse().find((d) => d.includes(target.id) && d.includes('"items"'));
    const hasWeapon = contState ? /"kind":"weapon"/.test(contState) : false;
    let invBefore = A.frames.filter((f) => f.ev === 'inventory:state').length;
    // take every item (E / 1 / 2 / 3 keys as shown in the panel), weapons included
    for (const k of ['KeyE', 'Digit1', 'Digit2', 'Digit3']) {
      await tap(A, k);
      await delay(500);
    }
    const inv = A.frames.filter((f) => f.ev === 'inventory:state').slice(invBefore).map((f) => String(f.data)).pop() ?? '';
    const gotWeapon = /"weaponId":"(rifle|pistol|shotgun|sniper)"/.exec(inv)?.[1] ?? null;
    check(`survival.pickupItems#${attempt + 1}`, inv ? 'PASS' : 'INFO', `containerHadWeapon=${hasWeapon} gotWeapon=${gotWeapon}`);
    if (!gotWeapon) continue;
    // close panel, equip via the inventory slot key
    await tap(A, 'Escape');
    await delay(300);
    await lockPointer(A);
    const slotKey = ({ rifle: 'Digit1', pistol: 'Digit2', shotgun: 'Digit3', sniper: 'Digit4' } as Record<string, string>)[gotWeapon];
    await tap(A, slotKey);
    await delay(1000);
    const mine = me(A)?.weapon ?? null;
    const remote = other(B, A.myId)?.weapon ?? null;
    check('survival.equipWeapon(slot key)', ok(mine === gotWeapon), `server snap weapon=${mine}`);
    check('survival.remoteSeesLootedWeapon(B snap)', ok(remote === gotWeapon), `B sees ${remote}`);
    evidence.survival_equipped_A = await shot(A, `survival_A_equipped_${gotWeapon}`);
    await lockPointer(B);
    const a2 = other(B, A.myId);
    const b2 = me(B);
    if (a2 && b2) await faceYaw(B, yawTo(b2, a2));
    evidence.survival_B_sees_A = await shot(B, `survival_B_sees_A_${gotWeapon}`);
    equipped = gotWeapon;
  }
  if (!equipped) check('survival.equipWeapon(slot key)', 'FAIL', `no weapon obtained from ${[...tried].join(',')}`);
  // C joins mid-round → spectator
  C.welcome = null;
  await enterLobby(C, 'ProdC');
  await joinRoom(C, 'prod-surv');
  await waitAssets(C);
  await delay(1500);
  const cRole = other(C, C.myId)?.survivalRole ?? other(C, C.myId)?.role ?? null;
  check('survival.midJoin→spectator (server role)', ok(cRole === 'spectator'), String(cRole));
  check('survival.C.sameRoomId', ok(C.welcome?.room?.id === A.welcome?.room?.id), `${C.welcome?.room?.id}`);
  await lockPointer(C);
  evidence.survival_spectator_1 = await shot(C, 'survival_C_spectator_view_1');
  await tap(C, 'KeyD');
  await delay(800);
  evidence.survival_spectator_2 = await shot(C, 'survival_C_spectator_view_2_cycled');
  // wait for timer end → ended → next round
  const r0 = A.lastSnap?.roundId ?? A.match?.roundId;
  log(`  waiting for round ${r0} to end by timer…`);
  const next = await (async () => {
    const t0 = Date.now();
    let sawEnded = false;
    while (Date.now() - t0 < 200000) {
      const ph = A.match?.phase ?? A.match?.survival?.phase;
      if (ph === 'ended') sawEnded = true;
      const r = A.lastSnap?.roundId ?? A.match?.roundId;
      if (sawEnded && r !== undefined && r0 !== undefined && r > r0) return { sawEnded, r };
      await delay(500);
    }
    return { sawEnded, r: A.lastSnap?.roundId };
  })();
  check('survival.roundEnded(timer)', ok(next.sawEnded));
  check('survival.nextRound(roundId++)', ok(r0 !== undefined && next.r > r0), `${r0} → ${next.r}`);
  await delay(1500);
  const cRole2 = other(C, C.myId)?.survivalRole ?? other(C, C.myId)?.role ?? null;
  check('survival.nextRound.spectatorRejoins', ok(cRole2 !== 'spectator'), String(cRole2));
  evidence.survival_next_round = await shot(A, 'survival_A_next_round');
}

async function partVsync(A: Client) {
  log('== VSync profiling (visible window, no frame-rate flags) ==');
  A.welcome = null;
  await createRoom(A, 'prod-vsync', 'tdm', 10);
  await waitAssets(A);
  await lockPointer(A);
  const vis = await A.read<{ state: string; hidden: boolean; focus: boolean; w: number; h: number; dpr: number }>(`({ state: document.visibilityState, hidden: document.hidden, focus: document.hasFocus(), w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
  // passive rAF cadence probe (reads only, no game state)
  const res = await A.read(`new Promise((resolve) => {
    const ts = []; const t0 = performance.now();
    const step = (t) => { ts.push(t); if (t - t0 < ${VSYNC_SEC * 1000}) requestAnimationFrame(step); else {
      const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
      const s = [...d].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      const fpsArr = d.map((x) => 1000 / x).sort((a, b) => a - b); const low = fpsArr.slice(0, Math.max(1, Math.floor(fpsArr.length * 0.01)));
      resolve({ frames: d.length, seconds: (t - t0) / 1000, achievedFps: d.length / ((t - t0) / 1000), medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: s[s.length - 1],
        onePctLowFps: low.reduce((a, b) => a + b, 0) / low.length, over16_7: d.filter((x) => x > 16.7).length / d.length * 100, over33_3: d.filter((x) => x > 33.3).length / d.length * 100 });
    } };
    requestAnimationFrame(step);
  })`);
  evidence.vsync_scene = await shot(A, 'vsync_scene_A');
  const gpu = await A.read<string>(`(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; })()`);
  return { visibility: vis, gpu, quality: 'default (game settings, fresh profile)', ...res };
}

// ------------------------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  const result: Record<string, unknown> = { meta: { startedAt: new Date().toISOString(), port: PORT, parts: [...PARTS], chrome: CHROME, mode: 'production dist via npm run serve', input: 'CDP Input.dispatchMouseEvent/dispatchKeyEvent/insertText (trusted) only' } };
  let A: Client | null = null;
  let B: Client | null = null;
  let C: Client | null = null;
  try {
    const server = await startProdServer();
    const info = await httpGet(`${BASE}/api/info`);
    const index = await httpGet(`${BASE}/`);
    const glb = await fetch(`${BASE}/models/characters/camper_buddy_balanced_rigged.glb`);
    const viteClient = await httpGet(`${BASE}/@vite/client`);
    result.server = { pid: server.pid, apiInfo: { status: info.status, body: info.body.slice(0, 200) }, index: { status: index.status, type: index.type, hasBundle: /assets\/index-[\w-]+\.js/.test(index.body), devHmr: /@vite\/client/.test(index.body) }, glbStatus: glb.status, glbBytes: Number(glb.headers.get('content-length')), viteClientStatus: viteClient.status };
    check('prod.apiInfo(same port)', ok(info.status === 200), info.body.slice(0, 120));
    check('prod.index.html(dist bundle, no @vite/client)', ok(index.status === 200 && /assets\/index-[\w-]+\.js/.test(index.body) && !/@vite\/client/.test(index.body)));
    check('prod.characterGlb.served', ok(glb.status === 200 && Number(glb.headers.get('content-length')) === 610972), `${glb.status} ${glb.headers.get('content-length')} B`);
    check('prod.noViteDevEndpoint', ok(viteClient.status !== 200 || !/import\.meta\.hot|createHotContext/.test(viteClient.body)), `/@vite/client → ${viteClient.status}`);

    A = await openChrome('A', 9600, 0, 0);
    B = await openChrome('B', 9601, 640, 40);
    if (PARTS.has('tdm')) await partTdm(A, B);
    else {
      await enterLobby(A, 'ProdA');
      await enterLobby(B, 'ProdB');
    }
    if (PARTS.has('ffa')) await partFfa(A, B);
    if (PARTS.has('survival')) {
      C = await openChrome('C', 9602, 320, 80);
      await partSurvival(A, B, C);
      await leaveRoom(A).catch(() => undefined);
    }
    if (PARTS.has('vsync')) {
      if (C) await C.cdp.send('Page.navigate', { url: 'about:blank' });
      await B.cdp.send('Page.navigate', { url: 'about:blank' });
      await A.cdp.send('Page.bringToFront');
      result.vsync = await partVsync(A);
      log('  vsync:', result.vsync);
    }
    for (const c of [A, B, C].filter(Boolean) as Client[]) {
      const h = await devHooksAbsent(c).catch(() => null);
      check(`prod.devHooksAbsent.${c.label}`, ok(Boolean(h && h.tools === 'undefined' && h.cam === 'undefined' && h.lock === 'undefined')), JSON.stringify(h));
    }
  } catch (e) {
    result.fatal = String((e as Error).stack ?? e);
    log('FATAL', result.fatal);
    check('prod.run.completed', 'FAIL', String(e).slice(0, 200));
  } finally {
    const clients = [A, B, C].filter(Boolean) as Client[];
    result.clients = clients.map((c) => ({
      label: c.label,
      myId: c.myId,
      roomId: c.welcome?.room?.id ?? null,
      wsUrls: c.wsUrls,
      glbLoads: c.cdp.glbLoads,
      consoleErrors: c.cdp.consoleErrors,
      warnings: [...c.cdp.warnings.entries()].map(([text, n]) => ({ text, n })),
      exceptions: c.cdp.exceptions,
      logErrors: c.cdp.logErrors,
      networkErrors: c.cdp.netErrors,
      networkAborted: c.cdp.netAborted.length,
      wsEvents: Object.fromEntries(
        Object.entries(c.frames.reduce((m: Record<string, number>, f) => ((m[`${f.dir}:${f.ev.startsWith('ack#') ? 'ack' : f.ev}`] = (m[`${f.dir}:${f.ev.startsWith('ack#') ? 'ack' : f.ev}`] ?? 0) + 1), m), {})),
      ),
    }));
    for (const c of clients) {
      fs.writeFileSync(path.join(LOGS, `ws_frames_${c.label}.json`), JSON.stringify(c.frames, null, 1));
      check(`prod.noConsoleErrors.${c.label}`, ok(c.cdp.consoleErrors.length === 0 && c.cdp.exceptions.length === 0), `${c.cdp.consoleErrors.length} console, ${c.cdp.exceptions.length} exceptions`);
      check(`prod.noNetworkErrors(404 etc).${c.label}`, ok(c.cdp.netErrors.length === 0), `${c.cdp.netErrors.length}`);
      check(`prod.websocket.${c.label}`, ok(c.wsUrls.some((u) => u.startsWith(`ws://127.0.0.1:${PORT}/socket.io`))), c.wsUrls[0] ?? 'none');
      const buddy = c.cdp.glbLoads.find((g) => g.url.includes('camper_buddy_balanced_rigged.glb'));
      check(`prod.glb.camperBuddy.${c.label}`, ok(buddy?.status === 200), JSON.stringify(buddy ?? null));
      check(`prod.glb.allOk.${c.label}`, ok(c.cdp.glbLoads.length > 0 && c.cdp.glbLoads.every((g) => g.status === 200 || g.status === 304)), `${c.cdp.glbLoads.length} GLB responses`);
    }
    result.checks = checks;
    result.evidence = evidence;
    const sum: Record<string, number> = {};
    for (const c of checks) sum[c.status] = (sum[c.status] ?? 0) + 1;
    result.summary = sum;
    result.durationSec = Math.round((Date.now() - t0) / 1000);
    fs.writeFileSync(path.join(OUT, 'prod_smoke.json'), JSON.stringify(result, null, 2));
    log('SUMMARY', sum);
    for (const c of clients) c.cdp.ws.close();
    for (const p of procs) killTree(p.pid);
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    RUN_LOG.end();
  }
}
main();
