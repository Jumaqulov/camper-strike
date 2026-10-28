#!/usr/bin/env -S npx tsx
/**
 * STAGE 08B-PRODUCTION-SMOKE — real Vite production bundle, real Chrome, real input only.
 *
 * - Serves the already-built `dist/` with `npm run serve` (Express + Socket.IO on ONE port).
 *   No Vite dev server, no HMR, no DEV build.
 * - Opens up to 3 visible (headful) Chrome windows in `--app=` mode, each with a fresh temporary profile.
 *   App mode matters: a normal window started on about:blank keeps browser focus in the omnibox, and
 *   CDP clicks never move it into the page, so every requestPointerLock() fails with WrongDocumentError.
 * - Game control is ONLY real browser input sent through CDP `Input.dispatchMouseEvent` /
 *   `Input.dispatchKeyEvent` / `Input.insertText` (trusted events, same path as a physical
 *   mouse/keyboard). No `window.__DEV_*` hooks, no client state injection, no network muting.
 * - Focus guard (scripts/qa-lib/focus-guard.mts): Windows gives OS focus + pointer lock to ONE window.
 *   Every input-driven step runs inside a guarded interval on the acting client; an interval in which
 *   that window lost OS foreground / page focus / visibility / pointer lock is REJECTED and retried.
 *   A check with no valid interval is NOT_TESTED — never PASS.
 * - "B sees A" visuals use a focus HANDOVER: A starts the action inside its own valid interval, the OS
 *   foreground moves to B (~60–110 ms to pointer lock), B is captured inside B's own valid interval,
 *   and the frame is accepted only if B's network data for A at render time (capture − 100 ms interp)
 *   still shows the expected state (run speed / walk speed / airborne / weapon / idle).
 * - Observation is passive: DOM reads, WebSocket frames, console/exception/network events, a passive
 *   focus/pointer-lock/WebGL-context event monitor, screenshots.
 * - Routing to loot containers is computed OFFLINE in this Node process from the shared world
 *   definition + server NavGraph (same seed the room reports) and executed with W + mouse-look.
 *
 * Usage: npx tsx scripts/prod-smoke-08b.mts [--port=3600] [--out=docs/stage08b-prod-smoke/runs]  (→ <out>/<UTC timestamp>/)
 *        [--parts=tdm,buddy,ffa,survival,vsync] [--vsyncSec=20] [--attempts=3]
 */
import { execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorldDefinition } from '../src/shared/world';
import { NavGraph } from '../src/server/navgraph';
import { raycastWorld } from '../src/shared/physics';
import { FOCUS_MONITOR_SRC, OsFocus, judgeInterval, type IntervalRecord } from './qa-lib/focus-guard.mts';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...r] = a.replace(/^--/, '').split('=');
    return [k, r.length ? r.join('=') : 'true'];
  }),
);
const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(args.port ?? 3600);
// every run gets its own folder: a new run must never delete or overwrite the evidence of an earlier one
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(WORKSPACE, String(args.out ?? 'docs/stage08b-prod-smoke/runs'), RUN_STAMP);
const PARTS = new Set(String(args.parts ?? 'tdm,buddy,ffa,survival,vsync').split(','));
const VSYNC_SEC = Number(args.vsyncSec ?? 20);
const ATTEMPTS = Number(args.attempts ?? 3);
const SHOTS = path.join(OUT, 'shots');
const LOGS = path.join(OUT, 'logs');
for (const d of [SHOTS, LOGS]) fs.mkdirSync(d, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_LOG = fs.createWriteStream(path.join(LOGS, 'prod_smoke_run.log'));
const log = (...a: unknown[]) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  RUN_LOG.write(line + '\n');
};
const rel = (p: string) => path.relative(WORKSPACE, p).replace(/\\/g, '/');

type Status = 'PASS' | 'FAIL' | 'NOT_TESTED' | 'INFO';
const checks: { id: string; status: Status; note?: string; details?: unknown }[] = [];
function check(id: string, status: Status, note?: string, details?: unknown) {
  checks.push({ id, status, note, details });
  log(`  [check] ${id.padEnd(48)} ${status}${note ? ' — ' + note : ''}`);
}
const ok = (c: boolean): Status => (c ? 'PASS' : 'FAIL');

// ------------------------------------------------------------------------------------------
// processes
// ------------------------------------------------------------------------------------------
const procs: ChildProcess[] = [];
const tmpDirs: string[] = [];
const chromeProcs: { label: string; userDir: string; pid?: number }[] = [];
const chromeExits: Record<string, unknown>[] = [];
let shuttingDown = false;
const closedOnPurpose = new Set<string>();
const RUN_START = new Date();
/** keep Chrome's own evidence (debug log, Crashpad reports) + Windows Application events before temp profiles are removed */
function collectChromeEvidence() {
  const out: Record<string, unknown> = { exits: chromeExits, profiles: [] as unknown[] };
  for (const c of chromeProcs) {
    const rec: Record<string, unknown> = { label: c.label, pid: c.pid };
    const dbg = path.join(c.userDir, 'chrome_debug.log');
    if (fs.existsSync(dbg)) {
      const dst = path.join(LOGS, `chrome_debug_${c.label}.log`);
      fs.copyFileSync(dbg, dst);
      rec.chromeDebugLog = rel(dst);
      rec.chromeDebugLogErrors = fs.readFileSync(dbg, 'utf8').split(/\r?\n/).filter((l) => /:ERROR:|:FATAL:|crash/i.test(l)).slice(-40);
    }
    const reports = path.join(c.userDir, 'Crashpad', 'reports');
    const dumps = fs.existsSync(reports) ? fs.readdirSync(reports) : [];
    rec.crashpadReports = dumps;
    for (const d of dumps) {
      fs.mkdirSync(path.join(LOGS, 'crashpad'), { recursive: true });
      fs.copyFileSync(path.join(reports, d), path.join(LOGS, 'crashpad', `${c.label}_${d}`));
    }
    (out.profiles as unknown[]).push(rec);
  }
  try {
    const ps = `Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=[datetime]'${RUN_START.toISOString()}'} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'chrome' -or $_.ProviderName -match 'Application Error|Windows Error Reporting' } | Select-Object TimeCreated, Id, ProviderName, LevelDisplayName, Message | Format-List | Out-String -Width 220`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60000 });
    const txt = (r.stdout || '').trim();
    fs.writeFileSync(path.join(LOGS, 'windows_application_events.txt'), txt || '(no Application events matching chrome / Application Error / WER since run start)\n');
    out.windowsApplicationEvents = txt ? txt.split(/\r?\n\r?\n/).filter(Boolean).length : 0;
  } catch (e) {
    out.windowsApplicationEvents = `query failed: ${String(e).slice(0, 120)}`;
  }
  return out;
}
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

const osf = new OsFocus();
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
interface SnapRec {
  t: number;
  players: any[];
}
interface Client {
  label: string;
  port: number;
  cdp: Cdp;
  proc: ChildProcess;
  frames: { dir: 'in' | 'out'; t: number; ev: string; data: unknown; ackId?: number }[];
  wsUrls: string[];
  lastSnap: any;
  snapHist: SnapRec[];
  lastLoot: any;
  inventory: any;
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
  glbLoads: { url: string; status: number; bytes?: number; fromCache?: boolean }[] = [];
  reqUrl = new Map<string, string>();
  constructor(url: string, public label: string) {
    this.ws = new WebSocket(url);
  }
  async connect() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      const at = Date.now();
      this.lifecycle.push({ type: 'cdp-ws-close', at: new Date(at).toISOString() });
      osf.query().then((q) => this.lifecycle.push({ type: 'os-at-close', fgPid: q.fgPid, msAfterClose: Date.now() - at, idleMs: q.tick - q.lastInput })).catch(() => undefined);
      for (const p of this.pending.values()) p.rej(new Error(`${this.label}: CDP connection closed (window closed?)`));
      this.pending.clear();
      log(`  !! ${this.label}: CDP connection closed`);
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
      if (m.method === 'Inspector.detached' || m.method === 'Inspector.targetCrashed' || m.method === 'Inspector.targetReloadedAfterCrash') {
        this.lifecycle.push({ type: m.method, at, reason: p.reason ?? null });
        log(`  !! ${this.label}: ${m.method} ${p.reason ?? ''}`);
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 500);
        if (p.type === 'error' || p.type === 'assert') this.consoleErrors.push({ at, text });
        else if (p.type === 'warning') this.warnings.set(text.slice(0, 160), (this.warnings.get(text.slice(0, 160)) ?? 0) + 1);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.exceptions.push({ at, text: String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 600) });
      } else if (m.method === 'Log.entryAdded') {
        if (p.entry?.level === 'error') this.logErrors.push({ at, source: p.entry.source, text: String(p.entry.text).slice(0, 400), url: p.entry.url });
        else if (p.entry?.level === 'warning') {
          const k = `[log:${p.entry.source}] ${String(p.entry.text).slice(0, 140)}`;
          this.warnings.set(k, (this.warnings.get(k) ?? 0) + 1);
        }
      } else if (m.method === 'Network.requestWillBeSent') {
        this.reqUrl.set(p.requestId, p.request?.url ?? '');
      } else if (m.method === 'Network.responseReceived') {
        const url = p.response?.url ?? '';
        const status = p.response?.status ?? 0;
        if (status >= 400) this.netErrors.push({ at, status, url });
        if (/\.glb(\?|$)/i.test(url)) this.glbLoads.push({ url: url.replace(BASE, ''), status, fromCache: Boolean(p.response?.fromDiskCache || p.response?.fromServiceWorker) });
      } else if (m.method === 'Network.loadingFinished') {
        const url = this.reqUrl.get(p.requestId) ?? '';
        if (/\.glb(\?|$)/i.test(url)) {
          const g = [...this.glbLoads].reverse().find((x) => x.url === url.replace(BASE, '') && x.bytes === undefined);
          if (g) g.bytes = p.encodedDataLength;
        }
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
  closed = false;
  /** browser/target lifecycle evidence: why a window disappeared (Inspector reason, close time, OS foreground) */
  lifecycle: Record<string, unknown>[] = [];
  /** every CDP call has a deadline: a closed window or a stuck renderer must fail the step, not hang the run */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`${this.label}: CDP closed (${method})`));
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${this.label}: CDP timeout ${timeoutMs} ms (${method})`));
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => {
          clearTimeout(t);
          res(v);
        },
        rej: (e) => {
          clearTimeout(t);
          rej(e);
        },
      });
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
      // Chrome's own log (kept with the run) to diagnose a disappearing window
      '--enable-logging',
      '--v=0',
      `--log-file=${path.join(userDir, 'chrome_debug.log')}`,
      `--window-position=${x},${y}`,
      '--window-size=1280,800',
      // app window: no omnibox, so browser focus lands in the page and pointer lock can be granted
      `--app=${BASE}/`,
    ],
    { stdio: 'ignore' },
  );
  procs.push(proc);
  chromeProcs.push({ label, userDir, pid: proc.pid });
  proc.on('exit', (code, signal) => {
    const expected = shuttingDown || closedOnPurpose.has(label);
    const rec = { label, pid: proc.pid, code, signal, at: new Date().toISOString(), expected };
    chromeExits.push(rec);
    log(`  !! Chrome ${label} process exit code=${code} signal=${signal}${expected ? ' (closed by harness)' : ' UNEXPECTED'}`);
  });
  let target: any = null;
  const t0 = Date.now();
  while (!target && Date.now() - t0 < 30000) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as any[];
      target = list.find((t) => t.type === 'page' && String(t.url).startsWith(BASE));
    } catch {
      /* not up yet */
    }
    if (!target) await delay(300);
  }
  if (!target) throw new Error(`${label}: chrome target not found`);
  const cdp = new Cdp(target.webSocketDebuggerUrl, label);
  await cdp.connect();
  for (const d of ['Page', 'Runtime', 'Network', 'Log', 'Inspector']) await cdp.send(`${d}.enable`);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FOCUS_MONITOR_SRC });
  const c: Client = {
    label, port: debugPort, cdp, proc, frames: [], wsUrls: [], lastSnap: null, snapHist: [], lastLoot: null, inventory: null, roster: [], match: null, myId: null, welcome: null,
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
    if (ev === 'snap') {
      c.lastSnap = data;
      c.snapHist.push({ t: Date.now(), players: data?.players ?? [] });
      if (c.snapHist.length > 400) c.snapHist.shift();
    } else if (ev === 'loot:snapshot') c.lastLoot = data;
    else if (ev === 'inventory:state') c.inventory = data;
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
  liveClients.push(c);
  return c;
}
function closeClient(c: Client) {
  closedOnPurpose.add(c.label);
  snapshotClient(c);
  liveClients.splice(liveClients.indexOf(c), 1);
  c.cdp.ws.close();
  killTree(c.proc.pid);
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
  KeyQ: { key: 'q', vk: 81, text: 'q' },
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
const mouse = new Map<string, { x: number; y: number }>();
async function click(c: Client, x: number, y: number, button: 'left' | 'right' = 'left') {
  await c.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await delay(30);
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
/**
 * Pointer-locked mouse look: successive mouseMoved events; Chrome derives movementX from the delta.
 * The virtual cursor is re-centred with a single >400 px jump, which the game's Input filter discards.
 */
async function look(c: Client, dx: number, dy = 0) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 40));
  let p = mouse.get(c.label) ?? { x: 640, y: 400 };
  for (let i = 0; i < steps; i++) {
    if (Math.abs(p.x - 640) > 450 || Math.abs(p.y - 400) > 450) {
      p = { x: 640, y: 400 };
      await c.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await delay(16);
    }
    p = { x: p.x + dx / steps, y: p.y + dy / steps };
    await c.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await delay(16);
  }
  mouse.set(c.label, p);
}

// ------------------------------------------------------------------------------------------
// focus guard
// ------------------------------------------------------------------------------------------
const intervals: IntervalRecord[] = [];
interface PageState {
  focus: boolean;
  vis: string;
  locked: boolean;
  paused: boolean;
}
const pageState = (c: Client) =>
  c.read<PageState>(`({ focus: document.hasFocus(), vis: document.visibilityState, locked: Boolean(document.pointerLockElement), paused: Boolean(document.getElementById('pause-menu') && !document.getElementById('pause-menu').classList.contains('hidden')) })`);

/** OS-foreground the window and (if needed) take pointer lock with a real click. */
async function acquire(c: Client, needLock: boolean) {
  for (let i = 0; i < 4; i++) {
    const fg = await osf.foreground(c.proc.pid!);
    if (!fg.ok) {
      log(`  focus ${c.label}: SetForegroundWindow refused (fg=${fg.fgPid})`);
      await delay(300);
      continue;
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 2500) {
      const s = await pageState(c);
      if (s.focus && s.vis === 'visible' && (!needLock || s.locked)) return true;
      if (needLock && !s.locked) {
        const resume = s.paused ? await rectOf(c, '#btn-resume').catch(() => null) : null;
        if (resume?.vis) await click(c, Math.round(resume.x), Math.round(resume.y));
        else await click(c, 640, 400);
      }
      await delay(needLock ? 60 : 100);
    }
  }
  return false;
}

async function judge(c: Client, id: string, attempt: number, needLock: boolean, t0: number, s0: { page: PageState; os: any }, extraReasons: string[] = []) {
  const t1 = Date.now();
  const s1 = { page: await pageState(c), os: await osf.query() };
  const events = await c.read(`(window.__qaFocusMon || []).filter((e) => e.ts >= ${t0} && e.ts <= ${t1})`).catch(() => []);
  const rec = judgeInterval({ client: c.label, id, attempt, t0, t1, needLock, events }, c.proc.pid!, s0, s1, osf.foreignInputSince(s0.os.lastInput, s1.os));
  if (extraReasons.length) {
    rec.reasons.push(...extraReasons);
    rec.valid = false;
  }
  intervals.push(rec);
  log(`  [focus] ${c.label} ${id} #${attempt} ${rec.valid ? 'VALID' : 'REJECTED ' + rec.reasons.join('; ')}${rec.warnings.length ? ' (warn: ' + rec.warnings.join('; ') + ')' : ''} ${t1 - t0} ms`);
  return rec;
}

interface Guarded<T> {
  valid: boolean;
  value: T | undefined;
  attempts: number;
  rejected: string[];
}
/**
 * Run `fn` inside a focus-guarded interval of client `c`. Rejected intervals are retried; an error thrown
 * inside a VALID interval is a real failure and propagates.
 */
async function guarded<T>(c: Client, id: string, fn: () => Promise<T>, o: { needLock?: boolean; attempts?: number } = {}): Promise<Guarded<T>> {
  const needLock = o.needLock ?? true;
  const n = o.attempts ?? ATTEMPTS;
  const rejected: string[] = [];
  for (let a = 1; a <= n; a++) {
    const got = await acquire(c, needLock);
    const s0 = { page: await pageState(c), os: await osf.query() };
    const t0 = Date.now();
    let value: T | undefined;
    let err: unknown = null;
    if (got) {
      try {
        value = await fn();
      } catch (e) {
        err = e;
      }
    }
    const rec = await judge(c, id, a, needLock, t0, s0, got ? [] : ['acquire failed (foreground/pointer lock not obtained)']);
    if (rec.valid) {
      if (err) throw err;
      return { valid: true, value, attempts: a, rejected };
    }
    rejected.push(rec.reasons.join('; '));
    if (err) log(`  (error inside rejected interval ignored: ${String(err).slice(0, 160)})`);
  }
  return { valid: false, value: undefined, attempts: n, rejected };
}
function gcheck(id: string, g: Guarded<unknown>, pass: boolean, note?: string, details?: unknown) {
  if (!g.valid) check(id, 'NOT_TESTED', `fokus intervali ${g.attempts} marta rad etildi: ${g.rejected.at(-1) ?? '?'}`, details);
  else check(id, ok(pass), note, details);
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
  // keyboard selection on a focused <select>: open, Escape, then ArrowDown/Up until the value matches (real key events)
  await clickSel(c, sel);
  await delay(150);
  await tap(c, 'Escape');
  const opts = await c.read<string[]>(`Array.from(document.querySelector(${JSON.stringify(sel)}).options).map((o) => o.value)`);
  for (let i = 0; i < 12; i++) {
    const v = await c.read<string>(`document.querySelector(${JSON.stringify(sel)}).value`);
    if (v === value) return;
    const up = opts.indexOf(value) < opts.indexOf(v);
    const key = up ? { code: 'ArrowUp', vk: 38 } : { code: 'ArrowDown', vk: 40 };
    await c.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: key.code, key: key.code, windowsVirtualKeyCode: key.vk });
    await c.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: key.code, key: key.code, windowsVirtualKeyCode: key.vk });
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
/** release pointer lock like a player: a real OS-level Esc (a CDP Escape never reaches Chrome's lock handler) */
async function osEscape(c: Client) {
  for (let i = 0; i < 3; i++) {
    if (!(await c.read<boolean>('Boolean(document.pointerLockElement)'))) return true;
    await osf.foreground(c.proc.pid!);
    await osf.key(c.proc.pid!, 0x1b);
    await delay(400);
  }
  return !(await c.read<boolean>('Boolean(document.pointerLockElement)'));
}
async function leaveRoom(c: Client) {
  await acquire(c, false);
  await osEscape(c);
  await delay(300);
  await clickSel(c, '#btn-leave');
  await c.cdp.waitRead(`!document.getElementById('screen-lobby')?.classList.contains('hidden')`, 20000, 'back to lobby');
}
const me = (c: Client) => c.lastSnap?.players?.find((p: any) => p.id === c.myId) ?? null;
const other = (c: Client, id: string | null) => c.lastSnap?.players?.find((p: any) => p.id === id) ?? null;
const speedOf = (p: any) => (p ? Math.hypot(p.vx, p.vz) : 0);
/** state of player `id` as received by `c` at wall time `t` (nearest snapshot at or before t) */
function snapAt(c: Client, id: string | null, t: number) {
  let best: SnapRec | null = null;
  for (const s of c.snapHist) if (s.t <= t) best = s;
  return best?.players.find((p) => p.id === id) ?? null;
}
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
async function waitAssets(c: Client) {
  // passive: loading overlay gone
  await c.cdp.waitRead(`!document.getElementById('loading')?.offsetParent`, 60000, 'loading overlay gone').catch(() => undefined);
  await delay(2500);
}
async function waitSeen(A: Client, B: Client, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (other(B, A.myId) && other(A, B.myId)) return true;
    await delay(200);
  }
  return false;
}
async function worldChecks(prefix: string, A: Client, B: Client) {
  const wa = A.welcome?.world;
  const wb = B.welcome?.world;
  check(`${prefix}.welcome.received`, ok(Boolean(wa && wb)), undefined, { A: wa, B: wb });
  check(`${prefix}.sameRoomId`, ok(Boolean(A.welcome?.room?.id) && A.welcome?.room?.id === B.welcome?.room?.id), `${A.welcome?.room?.id} / ${B.welcome?.room?.id}`);
  check(`${prefix}.gameplayHash`, ok(wa?.gameplayHash === 'a746d9f39e5ba0b2' && wb?.gameplayHash === wa?.gameplayHash), `${wa?.gameplayHash} / ${wb?.gameplayHash}`);
  check(`${prefix}.worldVersion`, ok(wa?.worldVersion === 2 && wb?.worldVersion === 2), `${wa?.worldVersion} / ${wb?.worldVersion}`);
  const seen = await waitSeen(A, B);
  check(`${prefix}.seeEachOther(snapshots)`, ok(seen), seen ? undefined : `A snaps=${A.snapHist.length} players=${JSON.stringify(A.lastSnap?.players?.map((p: any) => p.id))} B snaps=${B.snapHist.length} players=${JSON.stringify(B.lastSnap?.players?.map((p: any) => p.id))} ids A=${A.myId} B=${B.myId}`);
}
async function devHooks(c: Client) {
  return c.read<Record<string, string>>(`({ tools: typeof window.__DEV_GAME_TOOLS__, cam: typeof window.__DEV_CAMERA_OVERRIDE__, lock: typeof window.__DEV_PLAYER_POSE_LOCK__, devStats: String(Boolean(document.getElementById('dev-stats')?.offsetParent)) })`);
}

// ------------------------------------------------------------------------------------------
// steering (offline route from shared world + NavGraph; executed with W + mouse look)
// ------------------------------------------------------------------------------------------
const world = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 });
const nav = new NavGraph(world);
let radPerPx: number | null = null;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
async function calibrateLook(c: Client) {
  const y0 = me(c)?.yaw;
  await look(c, 200);
  await delay(500);
  const y1 = me(c)?.yaw;
  // default sensitivity ≈ 0.0022 rad/px; anything far below means the lock dropped mid-move
  if (typeof y0 === 'number' && typeof y1 === 'number' && Math.abs(wrap(y1 - y0)) > 0.1) radPerPx = wrap(y1 - y0) / 200;
  log(`  look calibration ${c.label}: ${radPerPx} rad/px (yaw ${y0} → ${y1})`);
  return radPerPx;
}
async function faceYaw(c: Client, target: number) {
  for (let i = 0; i < 5; i++) {
    const y = me(c)?.yaw;
    if (typeof y !== 'number' || !radPerPx) return false;
    const d = wrap(target - y);
    if (Math.abs(d) < 0.05) return true;
    await look(c, d / radPerPx);
    await delay(250);
  }
  return Math.abs(wrap(target - (me(c)?.yaw ?? 0))) < 0.08;
}
/** free straight distance along `yaw` from p: shared world raycast at knee and chest height (capsule edges too) */
function laneFree(p: { x: number; y: number; z: number }, yaw: number, len = 14) {
  const dir = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
  const side = { x: -dir.z, z: dir.x };
  let free = len;
  for (const h of [0.4, 1.2]) for (const o of [-0.35, 0, 0.35]) {
    const hit = raycastWorld(world, { x: p.x + side.x * o, y: p.y + h, z: p.z + side.z * o }, dir, len);
    if (hit) free = Math.min(free, hit.t);
  }
  return free;
}
/** previous NavGraph-based lane test (kept for reference; it returned 0 for every heading on forest_square) */
function laneFreeNav(p: { x: number; y: number; z: number }, yaw: number, len = 14) {
  const path0 = nav.findPath({ x: p.x, y: p.y, z: p.z }, { x: p.x - Math.sin(yaw) * len, y: p.y, z: p.z - Math.cos(yaw) * len });
  const straight = path0.length >= 2 && path0.every((q: { x: number; z: number }) => Math.abs((q.x - p.x) * Math.cos(yaw) - (q.z - p.z) * -Math.sin(yaw)) < 1.2);
  return straight ? Math.hypot(path0[path0.length - 1].x - p.x, path0[path0.length - 1].z - p.z) : 0;
}
async function faceOpenLane(c: Client) {
  const p = me(c);
  if (!p || !radPerPx) return;
  let best = { yaw: p.yaw, free: -1 };
  for (let k = 0; k < 24; k++) {
    const yaw = (k / 24) * Math.PI * 2 - Math.PI;
    const free = laneFree(p, yaw, 25);
    if (free > best.free) best = { yaw, free };
  }
  await faceYaw(c, best.yaw);
  log(`  open lane ${c.label} yaw=${best.yaw.toFixed(2)} free≈${best.free.toFixed(1)} m`);
}
async function driveTo(c: Client, goal: { x: number; y: number; z: number }, arriveR: number, timeoutMs = 60000) {
  const p0 = me(c);
  const path0 = nav.findPath({ x: p0.x, y: p0.y, z: p0.z }, goal);
  const wps = path0.length ? path0.slice(1) : [goal];
  wps.push(goal);
  const t0 = Date.now();
  let wi = 0;
  let lastPos = { x: p0.x, z: p0.z, t: Date.now() };
  await keyDown(c, 'KeyW');
  let lastFocusCheck = 0;
  try {
    while (Date.now() - t0 < timeoutMs) {
      if (Date.now() - lastFocusCheck > 700) {
        lastFocusCheck = Date.now();
        const st = await pageState(c);
        if (!st.focus || !st.locked) throw new Error(`${c.label}: focus/pointer lock lost while driving`);
      }
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
// focus handover capture: actor acts in its own valid interval, observer is captured in its own
// ------------------------------------------------------------------------------------------
const INTERP_DELAY_MS = 100; // Game.ts INTERP_DELAY = 0.1 s
const evidence: Record<string, unknown> = {};
const handovers: unknown[] = [];
interface HandoverSpec {
  id: string;
  /** starts the action on the actor (keys may stay held); returns a release function */
  act: () => Promise<() => Promise<void>>;
  /** expected actor state as rendered by the observer */
  expect: (p: any) => boolean;
  describe: (p: any) => string;
}
/** pitch (rad, + = up; Game.ts: pitch -= mouseDY*k, same k as yaw) from B's eye to the middle of A's body */
const EYE_HEIGHT = 1.62;
const BODY_MID = 0.9;
function wantPitch(b: { x: number; y: number; z: number }, a: { x: number; y: number; z: number }) {
  return Math.atan2(a.y + BODY_MID - (b.y + EYE_HEIGHT), Math.max(0.5, Math.hypot(a.x - b.x, a.z - b.z)));
}
async function facePitch(c: Client, target: number) {
  for (let i = 0; i < 5; i++) {
    const p = me(c)?.pitch;
    if (typeof p !== 'number' || !radPerPx) return false;
    const d = target - p;
    if (Math.abs(d) < 0.04) return true;
    // Δpitch per +1 px of mouse Y equals Δyaw per +1 px of mouse X (both −k), i.e. radPerPx
    await look(c, 0, d / radPerPx);
    await delay(250);
  }
  return Math.abs(target - (me(c)?.pitch ?? 9)) < 0.06;
}
/** aim the observer camera at the actor: yaw AND pitch (a frame that looks at the sky shows nothing) */
async function aimAt(observer: Client, actor: Client) {
  const a = other(observer, actor.myId);
  const b = me(observer);
  if (!a || !b) return false;
  const yawOk = await faceYaw(observer, yawTo(b, a));
  const pitchOk = await facePitch(observer, wantPitch(b, a));
  return yawOk && pitchOk;
}
/** clear line of sight from B's eye to A's legs/chest/head, using the shared world raycast (same as server LOS) */
function losClear(b: { x: number; y: number; z: number }, a: { x: number; y: number; z: number }) {
  const eye = { x: b.x, y: b.y + EYE_HEIGHT, z: b.z };
  for (const h of [0.5, 1.0, 1.5]) {
    const d = { x: a.x - eye.x, y: a.y + h - eye.y, z: a.z - eye.z };
    const L = Math.hypot(d.x, d.y, d.z);
    if (L < 0.5) continue;
    if (raycastWorld(world, eye, { x: d.x / L, y: d.y / L, z: d.z / L }, L - 0.3)) return false;
  }
  return true;
}
function inView(observer: Client, actorId: string | null, t: number) {
  const a = snapAt(observer, actorId, t);
  const b = snapAt(observer, observer.myId, t);
  if (!a || !b) return { ok: false, bearing: null as number | null, pitchErr: null as number | null, dist: null as number | null, los: false };
  const bearing = wrap(yawTo(b, a) - b.yaw);
  const pitchErr = (b.pitch ?? 0) - wantPitch(b, a);
  const dist = Math.hypot(a.x - b.x, a.z - b.z);
  const los = losClear(b, a);
  return { ok: Math.abs(bearing) < 0.6 && Math.abs(pitchErr) < 0.25 && dist < 45 && los, bearing, pitchErr, dist, los };
}
async function handoverCapture(actor: Client, observer: Client, spec: HandoverSpec) {
  const tries: unknown[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const aim = await guarded(observer, `${spec.id}.aim`, () => aimAt(observer, actor), { attempts: 2 });
    let release: (() => Promise<void>) | null = null;
    const act = await guarded(actor, `${spec.id}.act`, async () => {
      release = await spec.act();
      return true;
    }, { attempts: 2 });
    // handover: OS foreground → observer, real click → pointer lock, capture
    const tH = Date.now();
    const fg = await osf.foreground(observer.proc.pid!);
    let locked = false;
    const tl0 = Date.now();
    while (Date.now() - tl0 < 1500) {
      const s = await pageState(observer);
      if (s.locked && s.focus) {
        locked = true;
        break;
      }
      const resume = s.paused ? await rectOf(observer, '#btn-resume').catch(() => null) : null;
      if (resume?.vis) await click(observer, Math.round(resume.x), Math.round(resume.y));
      else await click(observer, 640, 400);
      await delay(25);
    }
    const tL = Date.now();
    const s0 = { page: await pageState(observer), os: await osf.query() };
    const tShot = Date.now();
    const file = await shot(observer, `${spec.id}_try${attempt}`);
    const obs = await judge(observer, `${spec.id}.capture`, attempt, true, tL, s0, fg.ok && locked ? [] : ['handover: observer not foreground/locked']);
    if (release) await (release as () => Promise<void>)();
    const renderT = tShot - INTERP_DELAY_MS;
    const st = snapAt(observer, actor.myId, renderT);
    const view = inView(observer, actor.myId, tShot);
    const stateOk = Boolean(st && spec.expect(st));
    const rec = {
      id: spec.id, attempt, shot: file, handoverToLockMs: tL - tH, aimValid: aim.valid, aimed: aim.value, actorIntervalValid: act.valid,
      observerIntervalValid: obs.valid, observerReasons: obs.reasons, pauseOverlayAtCapture: s0.page.paused,
      actorStateAtRender: st ? { speed: +speedOf(st).toFixed(2), onGround: st.onGround, weapon: st.weapon, vy: st.vy } : null, stateOk, view,
    };
    tries.push(rec);
    handovers.push(rec);
    log(`  [handover] ${spec.id} #${attempt} lock=${tL - tH}ms actor=${act.valid} observer=${obs.valid} state=${st ? spec.describe(st) : 'none'} ok=${stateOk} view=${JSON.stringify(view)}`);
    if (act.valid && obs.valid && stateOk && view.ok && !s0.page.paused) {
      evidence[spec.id] = file;
      return { status: 'PASS' as Status, note: `${spec.describe(st)}; bearing ${view.bearing?.toFixed(2)} rad, ${view.dist?.toFixed(1)} m; handover ${tL - tH} ms`, tries };
    }
    await delay(500);
  }
  const last: any = tries.at(-1);
  const focusBad = tries.every((t: any) => !t.actorIntervalValid || !t.observerIntervalValid);
  return {
    status: (focusBad ? 'NOT_TESTED' : 'FAIL') as Status,
    note: focusBad ? 'har bir urinishda fokus intervali rad etildi' : `kutilgan holat/ko‘rinish olinmadi: ${JSON.stringify(last?.actorStateAtRender)} view=${JSON.stringify(last?.view)}`,
    tries,
  };
}

// ------------------------------------------------------------------------------------------
// parts
// ------------------------------------------------------------------------------------------
async function setThirdPerson(c: Client, want: boolean) {
  // the game starts in 3P; V toggles. Tracked here because the camera mode is not in the DOM.
  const cur = (camMode.get(c.label) ?? true) as boolean;
  if (cur !== want) {
    await tap(c, 'KeyV');
    await delay(350);
    camMode.set(c.label, want);
  }
}
const camMode = new Map<string, boolean>();

async function partTdm(A: Client, B: Client) {
  log('== TDM (2 clients) ==');
  await guarded(A, 'tdm.lobbyA', () => enterLobby(A, 'ProdA'), { needLock: false });
  await guarded(B, 'tdm.lobbyB', () => enterLobby(B, 'ProdB'), { needLock: false });
  await guarded(A, 'tdm.create', () => createRoom(A, 'prod-tdm', 'tdm', 10), { needLock: false });
  await guarded(B, 'tdm.join', () => joinRoom(B, 'prod-tdm'), { needLock: false });
  await waitAssets(A);
  await waitAssets(B);
  await worldChecks('tdm', A, B);
  check('tdm.devHooksAbsent.A', 'INFO', JSON.stringify(await devHooks(A)));
  // B: lock + calibrate mouse look + 1P (observer camera must not be blocked by its own body)
  const gB = await guarded(B, 'tdm.B.lock+calibrate', async () => {
    const r = await calibrateLook(B);
    await setThirdPerson(B, false);
    return r;
  });
  const gA = await guarded(A, 'tdm.A.lock', async () => {
    if (!radPerPx) await calibrateLook(A);
    return true;
  });
  gcheck('tdm.pointerLock(real click, foreground window)', { ...gA, valid: gA.valid && gB.valid, attempts: Math.max(gA.attempts, gB.attempts), rejected: [...gA.rejected, ...gB.rejected] }, true, `A=${gA.attempts} urinish, B=${gB.attempts} urinish`);
  gcheck('tdm.mouseLook(real mousemove)', gB, radPerPx !== null, `rad/px=${radPerPx}`);

  // movement — A acts inside its own focused interval, B measures A from server snapshots (B needs no focus)
  const run = await guarded(A, 'tdm.run', async () => {
    await faceOpenLane(A);
    await keyDown(A, 'KeyW');
    try {
      await delay(800);
      evidence.tdm_A_3p_run = await shot(A, 'tdm_A_3p_run');
      return await sampleSpeed(B, A.myId, 1500);
    } finally {
      await keyUp(A, 'KeyW');
    }
  });
  gcheck('tdm.run≈6.5 m/s (B sees A, server snap)', run, run.value != null && Math.abs(run.value - 6.5) < 0.6, `${run.value?.toFixed(2)} m/s`);
  const walk = await guarded(A, 'tdm.walk', async () => {
    await faceOpenLane(A);
    await keyDown(A, 'ShiftLeft');
    await keyDown(A, 'KeyW', 8);
    try {
      await delay(800);
      evidence.tdm_A_3p_walk = await shot(A, 'tdm_A_3p_walk');
      return await sampleSpeed(B, A.myId, 1500);
    } finally {
      await keyUp(A, 'KeyW', 8);
      await keyUp(A, 'ShiftLeft');
    }
  });
  gcheck('tdm.walk≈3.0 m/s (B sees A, server snap)', walk, walk.value != null && Math.abs(walk.value - 3.0) < 0.5, `${walk.value?.toFixed(2)} m/s`);
  const jump = await guarded(A, 'tdm.jump', async () => {
    await delay(400);
    await tap(A, 'Space', 80);
    let air = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 600) {
      if (other(B, A.myId)?.onGround === false) air = true;
      await delay(30);
    }
    evidence.tdm_A_3p_jump = await shot(A, 'tdm_A_3p_jump');
    await delay(500);
    return air;
  });
  gcheck('tdm.jump (B sees A airborne)', jump, jump.value === true);
  // own 1P / 3P evidence
  const own = await guarded(A, 'tdm.A.1p3p', async () => {
    await facePitch(A, -0.08);
    evidence.tdm_A_3p_idle = await shot(A, 'tdm_A_3p_idle');
    await setThirdPerson(A, false);
    evidence.tdm_A_1p_idle = await shot(A, 'tdm_A_1p_idle');
    await keyDown(A, 'KeyW');
    await delay(600);
    evidence.tdm_A_1p_run = await shot(A, 'tdm_A_1p_run');
    await keyUp(A, 'KeyW');
    await setThirdPerson(A, true);
    return true;
  });
  gcheck('tdm.A.ownView.1p3p.shots', own, true);
  // 4 weapons — B must see each in A's server snapshot (A focused while switching)
  const weaponKeys: [string, string][] = [['Digit1', 'rifle'], ['Digit2', 'pistol'], ['Digit3', 'shotgun'], ['Digit4', 'sniper']];
  const seenW: Record<string, unknown> = {};
  const wg = await guarded(A, 'tdm.weapons', async () => {
    await facePitch(A, -0.08);
    for (const [k, w] of weaponKeys) {
      await tap(A, k);
      await delay(900);
      seenW[w] = other(B, A.myId)?.weapon ?? null;
      evidence[`tdm_A_3p_${w}`] = await shot(A, `tdm_A_3p_${w}`);
      await setThirdPerson(A, false);
      evidence[`tdm_A_1p_${w}`] = await shot(A, `tdm_A_1p_${w}`);
      await setThirdPerson(A, true);
    }
    await tap(A, 'Digit1');
    await delay(600);
    return true;
  });
  gcheck('tdm.4weapons (B sees A weapon via snap)', wg, weaponKeys.every(([, w]) => seenW[w] === w), JSON.stringify(seenW));
}

/** distance between two clients from their OWN authoritative snapshot entries */
function selfDist(A: Client, B: Client) {
  const a = me(A);
  const b = me(B);
  return a && b ? Math.hypot(a.x - b.x, a.z - b.z) : null;
}
/** A drives (focus-guarded) to within 8 m of B's own server position */
async function ensureClose(A: Client, B: Client, id: string) {
  return guarded(A, id, async () => {
    for (let leg = 0; leg < 3; leg++) {
      const b = me(B);
      if (!b) return false;
      if ((selfDist(A, B) ?? 99) <= 8.5) break;
      await driveTo(A, { x: b.x, y: b.y, z: b.z }, 7, 30000);
    }
    // a tree trunk between B and A hides the model: sidestep (real A/D keys) until the line of sight is clear
    for (let k = 0; k < 8 && me(A) && me(B) && !losClear(me(B), me(A)); k++) {
      const key = k % 4 < 2 ? 'KeyD' : 'KeyA';
      await keyDown(A, key);
      await delay(k % 2 ? 450 : 300);
      await keyUp(A, key);
      await delay(250);
    }
    const ok = (selfDist(A, B) ?? 99) <= 9.5 && losClear(me(B), me(A));
    log(`  ensureClose ${id}: dist=${selfDist(A, B)?.toFixed(1)} los=${me(A) && me(B) ? losClear(me(B), me(A)) : null}`);
    return ok;
  });
}
async function partBuddyRemote(A: Client, B: Client) {
  log('== Camper Buddy — what B renders for A (focus handover) ==');
  // bring A within ~8 m of B so the model is large in B's frame
  const close = await ensureClose(A, B, 'buddy.approachB');
  await guarded(A, 'buddy.levelPitch', () => facePitch(A, -0.05), { attempts: 2 });
  check('buddy.approach(A→B ≤8 m)', close.valid ? (close.value ? 'PASS' : 'INFO') : 'NOT_TESTED', close.valid ? `${selfDist(A, B)?.toFixed(1)} m` : 'fokus intervali rad etildi');
  const dirForRun = () => {
    const a = me(A);
    const b = other(A, B.myId);
    if (!a || !b) return null;
    const toward = yawTo(a, b);
    const away = wrap(toward + Math.PI);
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    // run toward B only from far enough to not collide; else away (radial lane keeps A at the same bearing for B)
    const opts = d > 9 ? [toward, away] : [away, toward];
    return opts.find((y) => laneFree(a, y, 8) > 5) ?? opts[0];
  };
  const moving = (code: 'run' | 'walk') => async () => {
    const y = dirForRun();
    if (y !== null) await faceYaw(A, y);
    if (code === 'walk') await keyDown(A, 'ShiftLeft');
    await keyDown(A, 'KeyW', code === 'walk' ? 8 : 0);
    await delay(900);
    return async () => {
      await keyUp(A, 'KeyW', code === 'walk' ? 8 : 0);
      if (code === 'walk') await keyUp(A, 'ShiftLeft');
    };
  };
  const specs: HandoverSpec[] = [
    { id: 'buddy_remote_idle', act: async () => { await delay(1200); return async () => {}; }, expect: (p) => p.onGround && speedOf(p) < 0.3, describe: (p) => `speed ${speedOf(p).toFixed(2)} onGround=${p.onGround}` },
    { id: 'buddy_remote_walk', act: moving('walk'), expect: (p) => p.onGround && speedOf(p) > 2.4 && speedOf(p) < 3.6, describe: (p) => `speed ${speedOf(p).toFixed(2)} onGround=${p.onGround}` },
    { id: 'buddy_remote_run', act: moving('run'), expect: (p) => p.onGround && speedOf(p) > 5.5, describe: (p) => `speed ${speedOf(p).toFixed(2)} onGround=${p.onGround}` },
    { id: 'buddy_remote_jump', act: async () => { await keyDown(A, 'Space'); await delay(140); return async () => keyUp(A, 'Space'); }, expect: (p) => p.onGround === false, describe: (p) => `onGround=${p.onGround} vy=${(p.vy ?? 0).toFixed(2)}` },
  ];
  for (const [k, w] of [['Digit1', 'rifle'], ['Digit2', 'pistol'], ['Digit3', 'shotgun'], ['Digit4', 'sniper']] as const) {
    specs.push({ id: `buddy_remote_${w}`, act: async () => { await tap(A, k); await delay(1100); return async () => {}; }, expect: (p) => p.weapon === w && p.onGround && speedOf(p) < 0.3, describe: (p) => `weapon=${p.weapon} speed ${speedOf(p).toFixed(2)}` });
  }
  for (const s of specs) {
    if ((selfDist(A, B) ?? 99) > 12 || !(me(A) && me(B) && losClear(me(B), me(A)))) await ensureClose(A, B, `${s.id}.approach`);
    const r = await handoverCapture(A, B, s);
    check(`buddy.remote.${s.id.replace('buddy_remote_', '')} (B renders A)`, r.status, r.note);
    if (s.id === 'buddy_remote_run' || s.id === 'buddy_remote_walk') {
      // walk back toward B so the next capture is close again
      await ensureClose(A, B, `${s.id}.return`);
    }
  }
  await guarded(A, 'buddy.resetWeapon', async () => tap(A, 'Digit1'), { attempts: 1 });
}

async function partFfa(A: Client, B: Client) {
  log('== FFA (2 clients) ==');
  A.welcome = null;
  B.welcome = null;
  await guarded(A, 'ffa.create', () => createRoom(A, 'prod-ffa', 'ffa', 10), { needLock: false });
  await guarded(B, 'ffa.join', () => joinRoom(B, 'prod-ffa'), { needLock: false });
  await waitAssets(A);
  await waitAssets(B);
  await worldChecks('ffa', A, B);
  const lockB = await guarded(B, 'ffa.B.lock', async () => {
    if (!radPerPx) await calibrateLook(B);
    await setThirdPerson(B, false);
    return true;
  });
  const lockA = await guarded(A, 'ffa.A.lock', async () => {
    if (!radPerPx) await calibrateLook(A);
    return true;
  });
  gcheck('ffa.pointerLock(A,B)', { ...lockA, valid: lockA.valid && lockB.valid, rejected: [...lockA.rejected, ...lockB.rejected] }, true, `rad/px=${radPerPx}`);
  const walk = await guarded(A, 'ffa.walk', async () => {
    await faceOpenLane(A);
    await keyDown(A, 'ShiftLeft');
    await keyDown(A, 'KeyW', 8);
    try {
      await delay(800);
      return await sampleSpeed(B, A.myId, 1500);
    } finally {
      await keyUp(A, 'KeyW', 8);
      await keyUp(A, 'ShiftLeft');
    }
  });
  gcheck('ffa.walk≈3.0 m/s (B sees A, server snap)', walk, walk.value != null && Math.abs(walk.value - 3.0) < 0.5, `${walk.value?.toFixed(2)} m/s`);
  const run = await guarded(A, 'ffa.run', async () => {
    await faceOpenLane(A);
    await keyDown(A, 'KeyW');
    try {
      await delay(800);
      return await sampleSpeed(B, A.myId, 1500);
    } finally {
      await keyUp(A, 'KeyW');
    }
  });
  gcheck('ffa.run≈6.5 m/s (B sees A, server snap)', run, run.value != null && Math.abs(run.value - 6.5) < 0.6, `${run.value?.toFixed(2)} m/s`);
  const wsw = await guarded(A, 'ffa.weaponSwitch', async () => {
    await tap(A, 'Digit3');
    await delay(900);
    const w = other(B, A.myId)?.weapon ?? null;
    evidence.ffa_A = await shot(A, 'ffa_A_shotgun');
    await tap(A, 'Digit1');
    await delay(500);
    return w;
  });
  gcheck('ffa.weaponSwitch (B sees A shotgun)', wsw, wsw.value === 'shotgun', String(wsw.value));
  await ensureClose(A, B, 'ffa.approachB');
  const bShot = await guarded(B, 'ffa.B.view', async () => {
    const aimed = await aimAt(B, A);
    await delay(300);
    const t = Date.now();
    evidence.ffa_B = await shot(B, 'ffa_B_sees_A');
    return { aimed, view: inView(B, A.myId, t) };
  });
  gcheck('ffa.B.view (A in B frame: yaw+pitch)', bShot, Boolean(bShot.value?.aimed && bShot.value?.view.ok), JSON.stringify(bShot.value?.view));
  await leaveRoom(A).catch((e) => log('leave A', String(e)));
  await leaveRoom(B).catch((e) => log('leave B', String(e)));
}

async function partSurvival(A: Client, B: Client, C: Client) {
  log('== Forest Survival (A,B contenders + C mid-round spectator) ==');
  A.welcome = null;
  B.welcome = null;
  await guarded(A, 'surv.create', () => createRoom(A, 'prod-surv', 'forest_survival', 2), { needLock: false });
  await guarded(B, 'surv.join', () => joinRoom(B, 'prod-surv'), { needLock: false });
  await waitAssets(A);
  await waitAssets(B);
  await worldChecks('survival', A, B);
  const t0p = Date.now();
  let playing = false;
  while (Date.now() - t0p < 40000) {
    if (A.match?.phase === 'playing') {
      playing = true;
      break;
    }
    await delay(300);
  }
  check('survival.countdown→playing', ok(playing), JSON.stringify(A.match ?? null).slice(0, 200));
  check('survival.lootSnapshot.sameRoom', ok(Boolean(A.lastLoot?.roomId) && A.lastLoot.roomId === B.lastLoot?.roomId), `${A.lastLoot?.roomId} / ${B.lastLoot?.roomId}`);
  const roundAtStart = A.lastLoot?.roundId;
  if (!radPerPx) await guarded(A, 'surv.calibrate', () => calibrateLook(A));
  const tried = new Set<string>();
  let equipped: string | null = null;
  let opened = false;
  let picked = false;
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
    const reach = await guarded(A, `surv.reach#${attempt + 1}`, () => driveTo(A, target.position, Math.max(0.8, target.interactionRadius - 0.3), 70000));
    check(`survival.reachContainer#${attempt + 1}`, reach.valid ? (reach.value ? 'PASS' : 'INFO') : 'NOT_TESTED', target.id);
    if (!reach.valid || !reach.value) continue;
    const open = await guarded(A, `surv.open#${attempt + 1}`, async () => {
      await faceYaw(A, yawTo(me(A), target.position));
      // sweep the view down until the game shows its own "[E] … — Ochish" prompt (real player behaviour)
      let prompt = '';
      for (let k = 0; k < 6 && !/Ochish/.test(prompt); k++) {
        await look(A, 0, 25);
        await delay(250);
        prompt = await A.read<string>(`(() => { const p = document.getElementById('stage06-loot-prompt'); return p && !p.classList.contains('hidden') ? p.textContent : ''; })()`);
      }
      if (!/Ochish/.test(prompt)) return { opened: null as string | null, prompt };
      const outBefore = A.frames.length;
      await tap(A, 'KeyE');
      const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        const ack = A.frames.slice(outBefore).find((f) => f.ev.startsWith('ack#') && String(f.data).includes('"ok":true') && String(f.data).includes('"container":{'));
        if (ack) {
          const id = /"containerId":"([^"]+)"/.exec(String(ack.data))?.[1] ?? null;
          evidence[`survival_open_${attempt + 1}`] = await shot(A, `survival_A_container_open_${attempt + 1}`);
          return { opened: id, prompt };
        }
        await delay(200);
      }
      return { opened: null as string | null, prompt };
    });
    const openedId = open.value?.opened ?? null;
    check(`survival.openContainer(E)#${attempt + 1}`, open.valid ? (openedId ? 'PASS' : 'INFO') : 'NOT_TESTED', openedId ? `${openedId} (prompt: ${open.value?.prompt?.trim().slice(0, 60)})` : `prompt yo‘q yoki ochilmadi: ${open.value?.prompt ?? ''}`);
    await look(A, 0, -150);
    if (!openedId) continue;
    target.id = openedId;
    opened = true;
    // take every item with E (primary interact = first available item), watch inventory:state
    const take = await guarded(A, `surv.pickup#${attempt + 1}`, async () => {
      const before = JSON.stringify(A.inventory ?? null);
      const invVersions: number[] = [];
      for (let i = 0; i < 4; i++) {
        await tap(A, 'KeyE');
        await delay(600);
        if (A.inventory?.inventoryVersion !== undefined) invVersions.push(A.inventory.inventoryVersion);
      }
      evidence[`survival_pickup_${attempt + 1}`] = await shot(A, `survival_A_after_pickup_${attempt + 1}`);
      return { changed: JSON.stringify(A.inventory ?? null) !== before, inv: A.inventory, invVersions };
    });
    const inv = take.value?.inv;
    gcheck(`survival.pickupItems(E)#${attempt + 1}`, take, Boolean(take.value?.changed), `owned=${JSON.stringify(inv?.ownedWeapons)} items=${(inv?.items ?? []).map((i: any) => i.catalogId).join(',')}`);
    if (take.value?.changed) picked = true;
    const gotWeapon: string | null = inv?.ownedWeapons?.[0] ?? null;
    if (!gotWeapon) continue;
    check('survival.inventory(server inventory:state)', ok(Array.isArray(inv.ownedWeapons) && inv.ownedWeapons.includes(gotWeapon) && inv.roundId === A.lastLoot?.roundId), `owned=${inv.ownedWeapons.join(',')} items=${inv.items?.length} round=${inv.roundId}`, inv);
    // equip (slot key) → holster (0) → Q (previous weapon): all seen by B in A's server snapshot
    const sw = await guarded(A, 'surv.weaponSwitch', async () => {
      const slotKey = ({ rifle: 'Digit1', pistol: 'Digit2', shotgun: 'Digit3', sniper: 'Digit4' } as Record<string, string>)[gotWeapon];
      await tap(A, slotKey);
      await delay(1000);
      const equipA = me(A)?.weapon ?? null;
      const equipB = other(B, A.myId)?.weapon ?? null;
      evidence.survival_equipped_A = await shot(A, `survival_A_equipped_${gotWeapon}`);
      await tap(A, 'Digit0');
      await delay(900);
      const holsterB = other(B, A.myId)?.weapon ?? null;
      await tap(A, 'KeyQ');
      await delay(900);
      const qB = other(B, A.myId)?.weapon ?? null;
      return { equipA, equipB, holsterB, qB };
    });
    gcheck('survival.equipWeapon(slot key)', sw, sw.value?.equipA === gotWeapon && sw.value?.equipB === gotWeapon, JSON.stringify(sw.value));
    gcheck('survival.weaponSwitch(0 holster → Q back)', sw, sw.value?.holsterB === null && sw.value?.qB === gotWeapon, JSON.stringify(sw.value));
    await ensureClose(A, B, 'surv.approachB');
    await guarded(A, 'surv.levelPitch', () => facePitch(A, -0.05), { attempts: 2 });
    const bv = await handoverCapture(A, B, {
      id: `survival_B_sees_A_${gotWeapon}`,
      act: async () => { await delay(600); return async () => {}; },
      expect: (p) => p.weapon === gotWeapon,
      describe: (p) => `weapon=${p.weapon}`,
    });
    check('survival.remoteSeesLootedWeapon(B render)', bv.status, bv.note);
    equipped = gotWeapon;
  }
  check('survival.openContainer(E) — umumiy', ok(opened), opened ? undefined : `no container opened (${[...tried].join(',')})`);
  check('survival.pickupItems(E) — umumiy', ok(picked), picked ? undefined : 'nothing picked up');
  if (!equipped) check('survival.equipWeapon(slot key)', 'FAIL', `no weapon obtained from ${[...tried].join(',')}`);
  // C joins mid-round → spectator
  C.welcome = null;
  await guarded(C, 'surv.C.lobby', () => enterLobby(C, 'ProdC'), { needLock: false });
  await guarded(C, 'surv.C.join', () => joinRoom(C, 'prod-surv'), { needLock: false });
  await waitAssets(C);
  await delay(1500);
  const cRole = me(C)?.survivalRole ?? me(C)?.role ?? null;
  check('survival.midJoin→spectator (server role)', ok(cRole === 'spectator'), String(cRole));
  check('survival.C.sameRoomId', ok(C.welcome?.room?.id === A.welcome?.room?.id), `${C.welcome?.room?.id}`);
  const specText = () => C.read<string | null>(`(() => { const el = Array.from(document.querySelectorAll('div,span,p')).find((e) => e.children.length === 0 && /Kuzatilmoqda:/.test(e.textContent || '') && e.offsetParent); return el ? el.textContent.trim() : null; })()`);
  const spec = await guarded(C, 'surv.C.spectate', async () => {
    const t1 = await specText();
    evidence.survival_spectator_1 = await shot(C, 'survival_C_spectator_view_1');
    await tap(C, 'KeyD');
    await delay(900);
    const t2 = await specText();
    evidence.survival_spectator_2 = await shot(C, 'survival_C_spectator_view_2_cycled');
    return { t1, t2 };
  });
  gcheck('survival.spectatorCycle(D key)', spec, Boolean(spec.value?.t1) && Boolean(spec.value?.t2) && spec.value?.t1 !== spec.value?.t2, JSON.stringify(spec.value));
  // wait for timer end → ended → next round (no input needed: server timer)
  const r0 = A.lastSnap?.roundId ?? A.match?.roundId;
  log(`  waiting for round ${r0} to end by timer…`);
  let sawEnded = false;
  let r1 = r0;
  const tw = Date.now();
  while (Date.now() - tw < 200000) {
    if (A.match?.phase === 'ended') sawEnded = true;
    r1 = A.lastSnap?.roundId ?? A.match?.roundId;
    if (sawEnded && r1 !== undefined && r0 !== undefined && r1 > r0) break;
    await delay(500);
  }
  check('survival.roundEnded(timer)', ok(sawEnded));
  check('survival.nextRound(roundId++)', ok(r0 !== undefined && r1 > r0), `${r0} → ${r1}`);
  await delay(2500);
  const cRole2 = me(C)?.survivalRole ?? me(C)?.role ?? null;
  check('survival.nextRound.spectatorBecomesContender', ok(cRole2 !== null && cRole2 !== 'spectator'), String(cRole2));
  const loot2 = A.lastLoot;
  check('survival.nextRound.lootReset', ok(loot2?.roundId !== roundAtStart && (loot2?.containers ?? []).every((c: any) => !c.opened)), `loot round ${roundAtStart} → ${loot2?.roundId}, opened=${(loot2?.containers ?? []).filter((c: any) => c.opened).length}`);
  check('survival.nextRound.inventoryReset', ok(!A.inventory || A.inventory.roundId !== roundAtStart ? (A.inventory?.ownedWeapons ?? []).length === 0 : false), JSON.stringify({ round: A.inventory?.roundId, owned: A.inventory?.ownedWeapons }));
  const ns = await guarded(A, 'surv.nextRound.shot', async () => {
    evidence.survival_next_round = await shot(A, 'survival_A_next_round');
    return true;
  }, { needLock: false });
  gcheck('survival.nextRound.shot', ns, true);
}

const RAF_PROBE = (sec: number) => `new Promise((resolve) => {
  const ts = []; const t0 = performance.now();
  const step = (t) => { ts.push(t); if (t - t0 < ${sec * 1000}) requestAnimationFrame(step); else {
    const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
    const s = [...d].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const fpsArr = d.map((x) => 1000 / x).sort((a, b) => a - b); const low = fpsArr.slice(0, Math.max(1, Math.floor(fpsArr.length * 0.01)));
    resolve({ frames: d.length, seconds: (t - t0) / 1000, achievedFps: d.length / ((t - t0) / 1000), medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: s[s.length - 1],
      onePctLowFps: low.reduce((a, b) => a + b, 0) / low.length, over25pct: d.filter((x) => x > 25).length / d.length * 100, over33_3pct: d.filter((x) => x > 33.3).length / d.length * 100,
      deltasMs: d.map((x) => Math.round(x * 100) / 100) });
  } };
  requestAnimationFrame(step);
})`;

async function partVsync(A: Client) {
  log('== VSync FPS (focused visible window, no frame-rate flags) ==');
  A.welcome = null;
  await guarded(A, 'vsync.create', () => createRoom(A, 'prod-vsync', 'tdm', 10), { needLock: false });
  await waitAssets(A);
  const refresh = Number(execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | Select-Object -First 1).CurrentRefreshRate"').toString().trim());
  const period = 1000 / refresh;
  const gpu = await A.read<string>(`(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; })()`);
  // real window resize so the page viewport is exactly 1280×720 CSS px (no device-metrics emulation)
  // Browser.* is served on the browser-level endpoint; the page session may refuse it
  const bver = (await (await fetch(`http://127.0.0.1:${A.port}/json/version`)).json()) as any;
  const bcdp = new Cdp(bver.webSocketDebuggerUrl, 'A-browser');
  await bcdp.connect();
  const tlist = (await (await fetch(`http://127.0.0.1:${A.port}/json/list`)).json()) as any[];
  const pageTarget = tlist.find((t) => t.type === 'page' && String(t.url).startsWith(BASE));
  const { windowId } = await bcdp.send('Browser.getWindowForTarget', { targetId: pageTarget.id });
  for (let i = 0; i < 3; i++) {
    const m = await A.read<{ iw: number; ih: number; ow: number; oh: number }>(`({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight })`);
    if (m.iw === 1280 && m.ih === 720) break;
    await bcdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', left: 0, top: 0, width: 1280 + (m.ow - m.iw), height: 720 + (m.oh - m.ih) } });
    await delay(800);
  }
  const env = await A.read<{ w: number; h: number; dpr: number; screen: number[]; canvas: number[] | null }>(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, screen: [screen.width, screen.height], canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })() })`);
  bcdp.ws.close();
  const viewportOk = env.w === 1280 && env.h === 720;
  check('vsync.viewport 1280×720', ok(viewportOk), `inner ${env.w}×${env.h}, dpr ${env.dpr}, canvas ${env.canvas?.join('×')}`);
  const results: Record<string, unknown> = { displayRefreshHz: refresh, gpu, env, viewportOk, flags: 'no --disable-gpu-vsync / --disable-frame-rate-limit', sec: VSYNC_SEC };
  if (!radPerPx) await guarded(A, 'vsync.calibrate', () => calibrateLook(A));
  const frametimes: Record<string, number[]> = {};
  for (const quality of ['medium', 'low']) {
    // in-game settings: Escape → pause menu → quality select (keyboard) → back to the game (real input)
    const sq = await guarded(A, `vsync.setQuality.${quality}`, async () => {
      await osEscape(A);
      await delay(500);
      await selectOption(A, '#set-quality', quality);
      await delay(800);
      return A.read<string>(`document.getElementById('set-quality').value`);
    }, { needLock: false });
    check(`vsync.quality=${quality} (pause menu)`, sq.valid ? ok(sq.value === quality) : 'NOT_TESTED', String(sq.value));
    for (const scene of ['idle', 'move']) {
      const g = await guarded(A, `vsync.${quality}.${scene}`, async () => {
        if (scene === 'move') await faceOpenLane(A);
        const probe = A.read(RAF_PROBE(VSYNC_SEC));
        probe.catch(() => undefined); // a closed window must fail this interval, not crash the run
        if (scene === 'move') {
          // gameplay-like load: run + continuous mouse look for the whole probe window
          await keyDown(A, 'KeyW');
          const tEnd = Date.now() + VSYNC_SEC * 1000;
          let dir = 1;
          while (Date.now() < tEnd) {
            await look(A, 60 * dir);
            await delay(150);
            if (Math.random() < 0.15) dir = -dir;
          }
          await keyUp(A, 'KeyW');
        }
        const r: any = await probe;
        evidence[`vsync_${quality}_${scene}`] = await shot(A, `vsync_${quality}_${scene}`);
        return r;
      }, { attempts: 2 });
      const r: any = g.value;
      if (r?.deltasMs) {
        frametimes[`${quality}_${scene}`] = r.deltasMs;
        delete r.deltasMs;
      }
      const vsyncLocked = r ? Math.abs(r.medianMs - period) / period < 0.05 : false;
      const pass = r ? viewportOk && vsyncLocked && r.achievedFps >= refresh * 0.95 && r.over33_3pct < 1 : false;
      results[`${quality}_${scene}`] = { valid: g.valid, attempts: g.attempts, rejected: g.rejected, vsyncLocked, ...(r ?? {}) };
      gcheck(`vsync.${quality}.${scene} (1280×720, ${refresh} Hz, focused)`, g, pass,
        r ? `${r.achievedFps.toFixed(1)} fps, median ${r.medianMs.toFixed(2)} ms, p99 ${r.p99Ms.toFixed(1)} ms, 1% low ${r.onePctLowFps.toFixed(1)}, >33ms ${r.over33_3pct.toFixed(2)}%` : undefined);
    }
  }
  fs.writeFileSync(path.join(LOGS, 'vsync_frametimes_ms.json'), JSON.stringify(frametimes));
  return results;
}

// ------------------------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  const result: Record<string, unknown> = {
    meta: {
      startedAt: new Date().toISOString(), port: PORT, parts: [...PARTS], attempts: ATTEMPTS, chrome: CHROME, mode: 'production dist via npm run serve',
      input: 'CDP Input.dispatchMouseEvent/dispatchKeyEvent/insertText (trusted) only',
      focusPolicy: 'OS foreground + page focus/visibility/pointer lock verified per interval; rejected intervals retried; never PASS without a valid interval',
      host: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}` },
    },
  };
  let A: Client | null = null;
  let B: Client | null = null;
  let C: Client | null = null;
  try {
    void pollPageInfo();
    await osf.start();
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

    // A on the primary display, B (and later C) on the secondary display: no occlusion between clients
    A = await openChrome('A', 9600, 0, 0);
    // a VSync-only run needs exactly one client (no second GPU consumer)
    const needB = [...PARTS].some((p) => p !== 'vsync');
    if (needB) B = await openChrome('B', 9601, 1920, 0);
    if (PARTS.has('tdm')) await partTdm(A, B!);
    else {
      await guarded(A, 'lobbyA', () => enterLobby(A!, 'ProdA'), { needLock: false });
      if (B) await guarded(B, 'lobbyB', () => enterLobby(B!, 'ProdB'), { needLock: false });
    }
    if (PARTS.has('buddy')) await partBuddyRemote(A, B!);
    if (PARTS.has('tdm') || PARTS.has('buddy')) {
      await leaveRoom(A).catch((e) => log('leave A', String(e)));
      await leaveRoom(B!).catch((e) => log('leave B', String(e)));
    }
    if (PARTS.has('ffa')) await partFfa(A, B!);
    if (PARTS.has('survival')) {
      C = await openChrome('C', 9602, 2240, 80);
      await partSurvival(A, B!, C);
      await leaveRoom(A).catch(() => undefined);
    }
    for (const c of [A, B, C].filter(Boolean) as Client[]) {
      const h = await devHooks(c).catch(() => null);
      check(`prod.devHooksAbsent.${c.label}`, ok(Boolean(h && h.tools === 'undefined' && h.cam === 'undefined' && h.lock === 'undefined')), JSON.stringify(h));
    }
    if (PARTS.has('vsync')) {
      // only A stays open: no second GPU client, nothing covering A
      await delay(2500); // let the poller record final WebGL info
      for (const c of [B, C].filter(Boolean) as Client[]) closeClient(c);
      B = null;
      C = null;
      result.vsync = await partVsync(A);
    }
  } catch (e) {
    result.fatal = String((e as Error).stack ?? e);
    log('FATAL', result.fatal);
    check('prod.run.completed', 'FAIL', String(e).slice(0, 200));
  } finally {
    polling = false;
    const clients = [A, B, C].filter(Boolean) as Client[];
    for (const c of clients) snapshotClient(c);
    result.clients = [...clientSummaries.values()];
    for (const s of clientSummaries.values()) {
      const L = s.label;
      check(`prod.noConsoleErrors.${L}`, ok(s.consoleErrors.length === 0 && s.exceptions.length === 0 && s.logErrors.length === 0), `${s.consoleErrors.length} console, ${s.exceptions.length} exceptions, ${s.logErrors.length} log errors`);
      check(`prod.noNetworkErrors.${L}`, ok(s.networkErrors.length === 0), `${s.networkErrors.length}`);
      if (!s.roomId) {
        check(`prod.inGameChecks.${L}`, 'NOT_TESTED', 'mijoz o‘yin xonasiga kirmagan (faqat lobby) — asset/WebGL tekshiruvlari qo‘llanilmaydi');
        continue;
      }
      check(`prod.websocket.${L}`, ok(s.wsUrls.some((u: string) => u.startsWith(`ws://127.0.0.1:${PORT}/socket.io`))), s.wsUrls[0] ?? 'none');
      const buddy = s.glbLoads.filter((g: any) => g.url.includes('camper_buddy_balanced_rigged.glb'));
      check(`prod.asset.camperBuddyGlb.${L}`, ok(buddy.length > 0 && buddy.every((g: any) => g.status === 200 || g.status === 304)), JSON.stringify(buddy));
      const distinct = new Set(s.glbLoads.map((g: any) => g.url)).size;
      check(`prod.asset.allGlbOk.${L}`, ok(s.glbLoads.length > 0 && s.glbLoads.every((g: any) => g.status === 200 || g.status === 304)), `${s.glbLoads.length} responses, ${distinct} distinct GLB`);
      check(`prod.webgl.noContextLost.${L}`, ok(s.webgl.contextLost === 0), `contextlost=${s.webgl.contextLost}`);
      check(`prod.webgl.noGlErrors.${L}`, ok(s.webgl.glWarnings.length === 0), `${s.webgl.glWarnings.length} GL warnings`, s.webgl.glWarnings);
      check(`prod.webgl.threeDeprecationWarnings.${L}`, 'INFO', s.webgl.threeDeprecations.map((w: any) => `${w.text} ×${w.n}`).join(' | ') || 'none');
      check(`prod.webgl.hardwareRenderer.${L}`, ok(Boolean(s.webgl.renderer) && !/swiftshader|llvmpipe|software/i.test(s.webgl.renderer)), s.webgl.renderer ?? 'unknown');
    }
    result.checks = checks;
    result.evidence = evidence;
    result.handovers = handovers;
    result.focus = {
      intervals: intervals.length,
      valid: intervals.filter((i) => i.valid).length,
      rejected: intervals.filter((i) => !i.valid).map((i) => ({ client: i.client, id: i.id, attempt: i.attempt, reasons: i.reasons })),
      withPhysicalInputWarning: intervals.filter((i) => i.warnings.length).length,
    };
    fs.writeFileSync(path.join(LOGS, 'focus_intervals.json'), JSON.stringify(intervals, null, 1));
    const sum: Record<string, number> = {};
    for (const c of checks) sum[c.status] = (sum[c.status] ?? 0) + 1;
    result.summary = sum;
    result.durationSec = Math.round((Date.now() - t0) / 1000);
    fs.writeFileSync(path.join(OUT, 'prod_smoke.json'), JSON.stringify(result, null, 2));
    log('SUMMARY', sum, `focus intervals valid ${(result.focus as any).valid}/${intervals.length}`);
    shuttingDown = true;
    for (const c of clients) c.cdp.ws.close();
    for (const p of procs) killTree(p.pid);
    await delay(1200);
    result.chromeDiagnostics = collectChromeEvidence();
    result.cdpLifecycle = Object.fromEntries([...clientSummaries.values()].map((s: any) => [s.label, s.lifecycle]));
    fs.writeFileSync(path.join(OUT, 'prod_smoke.json'), JSON.stringify(result, null, 2));
    osf.stop();
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    RUN_LOG.end();
  }
}

const clientSummaries = new Map<string, any>();
/** Freeze a client's passive observation (before its window is closed). Called sync-safe; WebGL info read lazily. */
function snapshotClient(c: Client) {
  // real GL/driver problems vs. three.js API deprecation notices (reported separately as INFO)
  const glWarn = [...c.cdp.warnings.entries()].filter(([t]) => /GL_INVALID|GL_OUT_OF_MEMORY|WebGL: |CONTEXT_LOST|GPU stall|Program Info Log|shader (compile|link)|THREE.WebGLProgram/i.test(t)).map(([text, n]) => ({ text, n }));
  const threeDeprecations = [...c.cdp.warnings.entries()].filter(([t]) => /^THREE./.test(t) && !/THREE.WebGLProgram/.test(t)).map(([text, n]) => ({ text, n }));
  const prev = clientSummaries.get(c.label);
  clientSummaries.set(c.label, {
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
    lifecycle: c.cdp.lifecycle,
    webgl: { renderer: prev?.webgl?.renderer ?? webglRenderer.get(c.label) ?? null, contextLost: (focusEvents.get(c.label) ?? []).filter((e) => e.type === 'webglcontextlost').length, glWarnings: glWarn, threeDeprecations },
    wsEvents: Object.fromEntries(
      Object.entries(c.frames.reduce((m: Record<string, number>, f) => ((m[`${f.dir}:${f.ev.startsWith('ack#') ? 'ack' : f.ev}`] = (m[`${f.dir}:${f.ev.startsWith('ack#') ? 'ack' : f.ev}`] ?? 0) + 1), m), {})),
    ),
  });
  fs.writeFileSync(path.join(LOGS, `ws_frames_${c.label}.json`), JSON.stringify(c.frames, null, 1));
}
const webglRenderer = new Map<string, string>();
const focusEvents = new Map<string, { type: string }[]>();
/** poll passive page info (renderer string + monitor events) so it survives page navigations */
const liveClients: Client[] = [];
let polling = true;
async function pollPageInfo() {
  while (polling) {
    for (const c of liveClients) {
      try {
        const r = await c.read<{ renderer: string | null; ev: { type: string; ts: number }[] }>(`({ renderer: (() => { const cv = document.querySelector('canvas'); const gl = cv && (cv.getContext('webgl2') || cv.getContext('webgl')); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; })(), ev: (window.__qaFocusMon || []).filter((e) => e.type.startsWith('webgl')) })`);
        if (r?.renderer) webglRenderer.set(c.label, r.renderer);
        if (r?.ev?.length) {
          const seen = focusEvents.get(c.label) ?? [];
          for (const e of r.ev) if (!seen.some((s: any) => s.ts === e.ts && s.type === e.type)) seen.push(e);
          focusEvents.set(c.label, seen);
        }
      } catch {
        /* closed or navigating */
      }
    }
    await delay(2000);
  }
}
// a closed window rejects every pending CDP call; never let one of those kill the run before the JSON is written
process.on('unhandledRejection', (e) => log('  (unhandled rejection ignored)', String(e).slice(0, 200)));
main();
