/**
 * Focus / pointer-lock guard for real-Chrome QA (Stage 08B-PRODUCTION-SMOKE).
 *
 * Why: Windows gives OS focus (and therefore pointer lock) to exactly ONE window. The game clears all
 * held keys on `window.blur` and on pointer-lock loss (Input.reset) and covers the screen with the pause
 * overlay, so any interval in which the acting window lost focus measures nothing real.
 *
 * What it does (observation + desktop focus only, never game state):
 *  - OsFocus: one persistent PowerShell process (os-focus-helper.ps1) that brings a Chrome window to the
 *    foreground and reports the OS foreground PID and GetLastInputInfo (physical/OS input only; CDP input
 *    does not touch it) — so user mouse/keyboard activity during an interval is detected too.
 *  - FOCUS_MONITOR_SRC: injected with Page.addScriptToEvaluateOnNewDocument; passive capture-phase
 *    listeners that log focus/blur/visibility/pointer-lock/WebGL-context events with timestamps.
 *  - an interval is VALID only if: OS foreground PID == client browser PID at start and end, page had
 *    focus + visible (+ pointer lock when required) at start and end, and no blur/hidden/unlock/
 *    contextlost event inside the interval. Physical OS input inside the interval is recorded as a
 *    warning (it cannot steal focus without producing a blur event, which already invalidates).
 *    Invalid intervals are retried; a check whose every attempt was invalid is NOT_TESTED, never PASS.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FOCUS_MONITOR_SRC = `(() => {
  if (window.__qaFocusMon) return;
  const log = []; window.__qaFocusMon = log;
  const rec = (type, extra) => log.push(Object.assign({ type, ts: Date.now(), focus: document.hasFocus(), vis: document.visibilityState, locked: Boolean(document.pointerLockElement) }, extra || {}));
  addEventListener('focus', () => rec('focus'), true);
  addEventListener('blur', (e) => { if (e.target === window) rec('blur'); }, true);
  document.addEventListener('visibilitychange', () => rec('visibility'), true);
  document.addEventListener('pointerlockchange', () => rec(document.pointerLockElement ? 'lock' : 'unlock'), true);
  document.addEventListener('pointerlockerror', () => rec('lockerror'), true);
  addEventListener('webglcontextlost', () => rec('webglcontextlost'), true);
  addEventListener('webglcontextrestored', () => rec('webglcontextrestored'), true);
})();`;

export interface OsState {
  fgPid: number;
  lastInput: number;
  tick: number;
}

export class OsFocus {
  private proc: ChildProcess | null = null;
  private buf = '';
  private waiters: ((line: string) => void)[] = [];
  /** OS input ticks we generated ourselves (ALT presses of the foreground trick) */
  private ownInput: { from: number; to: number }[] = [];

  async start() {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'os-focus-helper.ps1');
    this.proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const w = this.waiters.shift();
        if (w) w(line);
      }
    });
    const ready = await this.next(20000);
    if (ready !== 'READY') throw new Error(`os-focus-helper: ${ready}`);
  }
  private next(timeoutMs = 10000) {
    return new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error('os-focus-helper timeout')), timeoutMs);
      this.waiters.push((l) => {
        clearTimeout(t);
        res(l);
      });
    });
  }
  private async cmd(c: string) {
    const p = this.next();
    this.proc!.stdin!.write(c + '\n');
    return p;
  }
  async query(): Promise<OsState> {
    const [, fg, li, tick] = (await this.cmd('Q')).split(' ');
    return { fgPid: Number(fg), lastInput: Number(li), tick: Number(tick) };
  }
  async foreground(pid: number): Promise<{ ok: boolean; fgPid: number; ms: number }> {
    const t0 = Date.now();
    const before = await this.query();
    const r = (await this.cmd(`FG ${pid}`)).split(' ');
    const after = await this.query();
    this.ownInput.push({ from: before.tick, to: after.tick + 50 });
    if (r[0] !== 'OK') return { ok: false, fgPid: after.fgPid, ms: Date.now() - t0 };
    return { ok: after.fgPid === pid, fgPid: after.fgPid, ms: Date.now() - t0 };
  }
  /** OS-level key press into the foreground window; only valid when `pid` really is the foreground */
  async key(pid: number, vk: number): Promise<boolean> {
    const before = await this.query();
    if (before.fgPid !== pid) return false;
    const r = (await this.cmd(`KEY ${vk}`)).split(' ');
    const after = await this.query();
    this.ownInput.push({ from: before.tick, to: after.tick + 50 });
    return r[0] === 'OK' && Number(r[1]) === pid;
  }
  /** true if the last physical/OS input tick is newer than `sinceTick` and was not our own ALT press */
  foreignInputSince(sinceTick: number, now: OsState) {
    if (now.lastInput <= sinceTick) return false;
    return !this.ownInput.some((w) => now.lastInput >= w.from && now.lastInput <= w.to);
  }
  stop() {
    try {
      this.proc?.stdin?.end();
      this.proc?.kill();
    } catch {
      /* gone */
    }
  }
}

export interface FocusEvent {
  type: string;
  ts: number;
  focus: boolean;
  vis: string;
  locked: boolean;
}
export interface IntervalRecord {
  client: string;
  id: string;
  attempt: number;
  t0: number;
  t1: number;
  needLock: boolean;
  valid: boolean;
  reasons: string[];
  warnings: string[];
  events: FocusEvent[];
  start?: unknown;
  end?: unknown;
}

const BAD = new Set(['blur', 'unlock', 'webglcontextlost', 'lockerror']);

/** Judge an interval from page events + start/end page state + OS state. */
export function judgeInterval(
  rec: Omit<IntervalRecord, 'valid' | 'reasons' | 'warnings'>,
  pid: number,
  start: { page: { focus: boolean; vis: string; locked: boolean }; os: OsState },
  end: { page: { focus: boolean; vis: string; locked: boolean }; os: OsState },
  foreignInput: boolean,
): IntervalRecord {
  const reasons: string[] = [];
  if (start.os.fgPid !== pid) reasons.push(`os.foreground@start=${start.os.fgPid}≠${pid}`);
  if (end.os.fgPid !== pid) reasons.push(`os.foreground@end=${end.os.fgPid}≠${pid}`);
  for (const [k, s] of [['start', start.page], ['end', end.page]] as const) {
    if (!s.focus) reasons.push(`page.hasFocus@${k}=false`);
    if (s.vis !== 'visible') reasons.push(`page.visibility@${k}=${s.vis}`);
    if (rec.needLock && !s.locked) reasons.push(`pointerLock@${k}=false`);
  }
  for (const e of rec.events) {
    if (BAD.has(e.type) && (e.type !== 'unlock' || rec.needLock)) reasons.push(`event:${e.type}@+${e.ts - rec.t0}ms`);
    if (e.type === 'visibility' && e.vis !== 'visible') reasons.push(`event:hidden@+${e.ts - rec.t0}ms`);
  }
  const warnings = foreignInput ? ['physical OS input during interval (user mouse/keyboard)'] : [];
  return { ...rec, valid: reasons.length === 0, reasons, warnings, start, end };
}
