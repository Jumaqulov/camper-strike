import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Input, isTextEntryTarget } from '../Input';
import { createBrowserGuard, GUARD_KEYS, LEAVE_GUARD_GRACE_MS } from '../BrowserGuard';
import { loadSettings, saveSettings, type GameSettings } from '../../settings';

// Brauzer yorliqlari himoyasi (Input + BrowserGuard) — Node, minimal DOM stublari.
// Har bir test uchun yangi document / window / navigator / performance / localStorage o'rnatiladi.

type Listener = (ev: unknown) => void;

class FakeTarget {
  readonly listeners = new Map<string, { fn: Listener; opts?: AddEventListenerOptions }[]>();
  addEventListener(type: string, fn: Listener, opts?: AddEventListenerOptions): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push({ fn, opts });
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      arr.filter((l) => l.fn !== fn),
    );
  }
  dispatch(type: string, ev: unknown): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l.fn(ev);
  }
  count(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
  total(): number {
    let n = 0;
    for (const arr of this.listeners.values()) n += arr.length;
    return n;
  }
}

class FakeInputElement extends FakeTarget {
  checked = false;
}

class FakeEvent {
  defaultPrevented = false;
  returnValue: unknown = undefined;
  constructor(init: Record<string, unknown> = {}) {
    Object.assign(this, init);
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

interface FakeKeyboard {
  calls: string[][];
  unlocks: number;
  rejectNext: number;
  lock(keys?: readonly string[]): Promise<void>;
  unlock(): void;
}

function makeKeyboard(log: string[]): FakeKeyboard {
  const kb: FakeKeyboard = {
    calls: [],
    unlocks: 0,
    rejectNext: 0,
    lock(keys) {
      log.push('keyboard.lock');
      kb.calls.push([...(keys ?? [])]);
      if (kb.rejectNext > 0) {
        kb.rejectNext--;
        return Promise.reject(new Error('not fullscreen'));
      }
      return Promise.resolve();
    },
    unlock() {
      log.push('keyboard.unlock');
      kb.unlocks++;
    },
  };
  return kb;
}

interface Env {
  doc: FakeTarget & {
    pointerLockElement: unknown;
    fullscreenElement: unknown;
    exitPointerLock(): void;
    exitFullscreen(): Promise<void>;
    getElementById(id: string): unknown;
  };
  win: FakeTarget & { isSecureContext: boolean };
  canvas: FakeTarget & { requestPointerLock(): Promise<void> };
  root: FakeTarget & { requestFullscreen(opts?: unknown): Promise<void> };
  checkbox: FakeInputElement;
  hint: { textContent: string; classes: Set<string>; classList: { toggle(c: string, force?: boolean): void } };
  log: string[];
  storage: Map<string, string>;
  now: { t: number };
  setKeyboard(kb: FakeKeyboard | undefined): void;
  setLocked(locked: boolean): void;
  enterFullscreen(): void;
  leaveFullscreen(): void;
}

let env: Env;
const restorers: (() => void)[] = [];

function setGlobal(name: string, value: unknown): void {
  const prev = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  restorers.push(() => {
    if (prev) Object.defineProperty(globalThis, name, prev);
    else delete (globalThis as Record<string, unknown>)[name];
  });
}

function installEnv(): Env {
  const log: string[] = [];
  const storage = new Map<string, string>();
  const now = { t: 10_000 };
  const doc = Object.assign(new FakeTarget(), {
    pointerLockElement: null as unknown,
    fullscreenElement: null as unknown,
    exitPointerLock() {
      log.push('exitPointerLock');
      if (doc.pointerLockElement) {
        doc.pointerLockElement = null;
        doc.dispatch('pointerlockchange', new FakeEvent());
      }
    },
    exitFullscreen() {
      log.push('exitFullscreen');
      e.leaveFullscreen();
      return Promise.resolve();
    },
    getElementById(id: string): unknown {
      if (id === 'set-fullscreen') return checkbox;
      if (id === 'set-fullscreen-hint') return hint;
      return null;
    },
  });
  const win = Object.assign(new FakeTarget(), { isSecureContext: true });
  const canvas = Object.assign(new FakeTarget(), {
    requestPointerLock() {
      log.push('requestPointerLock');
      doc.pointerLockElement = canvas;
      doc.dispatch('pointerlockchange', new FakeEvent());
      return Promise.resolve();
    },
  });
  const root = Object.assign(new FakeTarget(), {
    requestFullscreen(_opts?: unknown) {
      log.push('requestFullscreen');
      return Promise.resolve().then(() => e.enterFullscreen());
    },
  });
  const checkbox = new FakeInputElement();
  const classes = new Set<string>();
  const hint = {
    textContent: '',
    classes,
    classList: {
      toggle(c: string, force?: boolean) {
        if (force ?? !classes.has(c)) classes.add(c);
        else classes.delete(c);
      },
    },
  };
  const nav: { keyboard?: FakeKeyboard } = {};

  setGlobal('document', doc);
  setGlobal('window', win);
  setGlobal('navigator', nav);
  setGlobal('HTMLInputElement', FakeInputElement);
  setGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  });
  setGlobal('performance', { now: () => now.t });

  const e: Env = {
    doc,
    win,
    canvas,
    root,
    checkbox,
    hint,
    log,
    storage,
    now,
    setKeyboard(kb) {
      nav.keyboard = kb;
    },
    setLocked(locked) {
      if (locked) void canvas.requestPointerLock();
      else doc.exitPointerLock();
    },
    enterFullscreen() {
      if (doc.fullscreenElement) return;
      doc.fullscreenElement = root;
      doc.dispatch('fullscreenchange', new FakeEvent());
    },
    leaveFullscreen() {
      if (!doc.fullscreenElement) return;
      doc.fullscreenElement = null;
      doc.dispatch('fullscreenchange', new FakeEvent());
    },
  };
  return e;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makeInput(): Input {
  return new Input(env.canvas as unknown as HTMLElement);
}

function makeSettings(over: Partial<GameSettings> = {}): GameSettings {
  return { name: 'Test', sens: 1, volume: 0.5, fov: 80, quality: 'medium', autoQuality: true, fullscreen: false, ...over };
}

function key(type: 'keydown' | 'keyup', init: Record<string, unknown>): FakeEvent {
  const ev = new FakeEvent({ altKey: false, ctrlKey: false, target: env.doc, ...init });
  env.doc.dispatch(type, ev);
  return ev;
}

beforeEach(() => {
  env = installEnv();
});

afterEach(() => {
  while (restorers.length) restorers.pop()!();
});

describe('Input — o\'yin paytida brauzer yorliqlarini bloklash', () => {
  it('Alt/Ctrl kombinatsiyalari faqat pointer lock paytida preventDefault qilinadi', () => {
    const input = makeInput();
    assert.equal(key('keydown', { code: 'KeyD', altKey: true }).defaultPrevented, false, 'unlocked: brauzerga tegmaymiz');
    env.setLocked(true);
    assert.equal(input.locked, true);
    assert.equal(key('keydown', { code: 'KeyD', altKey: true }).defaultPrevented, true, 'Alt+D');
    assert.equal(key('keydown', { code: 'KeyS', ctrlKey: true }).defaultPrevented, true, 'Ctrl+S');
    assert.equal(key('keydown', { code: 'AltLeft', altKey: true }).defaultPrevented, true, 'yolg\'iz Alt');
    assert.equal(key('keydown', { code: 'ControlRight' }).defaultPrevented, true, 'yolg\'iz Ctrl');
    assert.equal(key('keydown', { code: 'Tab' }).defaultPrevented, true, 'Tab (oldingi xatti-harakat)');
    assert.equal(key('keydown', { code: 'KeyW' }).defaultPrevented, false, 'oddiy W bloklanmaydi');
    assert.equal(input.down('KeyD'), true, 'tugma o\'yinga baribir yetadi');
    input.dispose();
  });

  it('chat inputidagi tugmalarga tegmaydi', () => {
    const input = makeInput();
    env.setLocked(true);
    const ev = key('keydown', { code: 'KeyA', altKey: true, target: new FakeInputElement() });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(input.down('KeyA'), false);
    input.dispose();
  });

  it('textarea va contenteditable ham matn kiritish joyi: tugmalarga tegmaydi', () => {
    class FakeTextAreaElement extends FakeTarget {}
    setGlobal('HTMLTextAreaElement', FakeTextAreaElement);
    const editable = Object.assign(new FakeTarget(), { isContentEditable: true });
    assert.equal(isTextEntryTarget(new FakeInputElement() as unknown as EventTarget), true);
    assert.equal(isTextEntryTarget(new FakeTextAreaElement() as unknown as EventTarget), true);
    assert.equal(isTextEntryTarget(editable as unknown as EventTarget), true);
    assert.equal(isTextEntryTarget(env.doc as unknown as EventTarget), false, 'oddiy element emas');
    assert.equal(isTextEntryTarget(null), false);

    const input = makeInput();
    env.setLocked(true);
    for (const target of [new FakeTextAreaElement(), editable]) {
      assert.equal(key('keydown', { code: 'KeyD', altKey: true, target }).defaultPrevented, false);
      assert.equal(key('keyup', { code: 'AltLeft', target }).defaultPrevented, false);
    }
    assert.equal(input.down('KeyD'), false, 'o\'yinga yetmaydi');
    input.dispose();
  });

  it('Alt keyup (Firefox menyu satri) faqat lock paytida bloklanadi', () => {
    const input = makeInput();
    assert.equal(key('keyup', { code: 'AltLeft' }).defaultPrevented, false);
    env.setLocked(true);
    assert.equal(key('keyup', { code: 'AltLeft' }).defaultPrevented, true);
    assert.equal(key('keyup', { code: 'AltRight' }).defaultPrevented, true);
    assert.equal(key('keyup', { code: 'KeyW' }).defaultPrevented, false);
    input.dispose();
  });

  it('g\'ildirak: passive emas, faqat lock paytida bloklanadi va qurol g\'ildiragi yig\'iladi', () => {
    const input = makeInput();
    const wheelListeners = env.doc.listeners.get('wheel') ?? [];
    assert.equal(wheelListeners.length, 1);
    assert.equal(wheelListeners[0].opts?.passive, false);
    const w1 = new FakeEvent({ deltaY: 120, ctrlKey: true });
    env.doc.dispatch('wheel', w1);
    assert.equal(w1.defaultPrevented, false, 'pauzada sahifa odatdagidek');
    assert.equal(input.wheel, 0);
    env.setLocked(true);
    const w2 = new FakeEvent({ deltaY: 120, ctrlKey: true });
    env.doc.dispatch('wheel', w2);
    assert.equal(w2.defaultPrevented, true);
    assert.equal(input.wheel, 1);
    input.dispose();
  });

  it('lastUnlockAtMs locked → unlocked o\'tishida yoziladi', () => {
    const input = makeInput();
    assert.equal(input.lastUnlockAtMs, Number.NEGATIVE_INFINITY);
    env.setLocked(true);
    env.now.t = 12_345;
    env.setLocked(false);
    assert.equal(input.lastUnlockAtMs, 12_345);
    input.dispose();
  });
});

describe('BrowserGuard', () => {
  it('beforeunload faqat o\'ynayotganda va unlockdan keyin 1.5 s ichida qurollangan', () => {
    const input = makeInput();
    const guard = createBrowserGuard({ input, root: env.root as unknown as HTMLElement, settings: makeSettings() });
    const fire = () => {
      const ev = new FakeEvent();
      env.win.dispatch('beforeunload', ev);
      return ev;
    };
    assert.equal(fire().defaultPrevented, false, 'hali o\'ynamagan');
    assert.equal(guard.diagnostics().beforeUnloadArmed, false);

    env.setLocked(true);
    const armed = fire();
    assert.equal(armed.defaultPrevented, true);
    assert.equal(armed.returnValue, '');
    assert.equal(guard.diagnostics().beforeUnloadArmed, true);

    env.now.t = 20_000;
    env.setLocked(false);
    env.now.t = 20_000 + LEAVE_GUARD_GRACE_MS - 1;
    assert.equal(fire().defaultPrevented, true, 'Alt+F4 avval pointer lockni olib qo\'yadi');
    env.now.t = 20_000 + LEAVE_GUARD_GRACE_MS + 1;
    assert.equal(fire().defaultPrevented, false, 'pauza menyusida tasdiq yo\'q');
    assert.equal(guard.diagnostics().beforeUnloadArmed, false);
    guard.dispose();
    input.dispose();
  });

  it('beforeLock: settings.fullscreen bo\'lsa avval keyboard.lock(GUARD_KEYS), keyin requestFullscreen', async () => {
    const kb = makeKeyboard(env.log);
    env.setKeyboard(kb);
    const input = makeInput();
    const settings = makeSettings({ fullscreen: false });
    const guard = createBrowserGuard({ input, root: env.root as unknown as HTMLElement, settings });

    guard.beforeLock();
    assert.equal(kb.calls.length, 0, 'sozlama o\'chiq — hech narsa');
    assert.ok(!env.log.includes('requestFullscreen'));
    assert.equal(guard.diagnostics().keyboardLock, 'off');

    settings.fullscreen = true;
    guard.beforeLock();
    input.lock();
    assert.deepEqual(env.log.slice(0, 3), ['keyboard.lock', 'requestFullscreen', 'requestPointerLock']);
    assert.deepEqual(kb.calls[0], [...GUARD_KEYS]);
    assert.ok(!GUARD_KEYS.includes('F4') && !GUARD_KEYS.includes('MetaLeft') && !GUARD_KEYS.includes('MetaRight'));
    assert.equal(guard.diagnostics().keyboardLock, 'pending');
    await flush();
    assert.deepEqual(guard.diagnostics(), {
      fullscreen: true,
      keyboardLock: 'locked',
      beforeUnloadArmed: true,
      secureContext: true,
    });

    // To'liq ekranda qayta beforeLock (pauzadan qaytish) — qayta so'rov yo'q
    guard.beforeLock();
    assert.equal(kb.calls.length, 1);
    assert.equal(env.log.filter((l) => l === 'requestFullscreen').length, 1);

    // Matn maydonidagi (contenteditable) Esc pointer lockni bo'shatmaydi
    key('keydown', { code: 'Escape', target: Object.assign(new FakeTarget(), { isContentEditable: true }) });
    assert.equal(input.locked, true);

    // Qisqa Esc (Keyboard Lock ostida sahifaga yetadi) → pointer lock bo'shaydi, to'liq ekran qoladi
    key('keydown', { code: 'Escape' });
    assert.equal(input.locked, false);
    assert.equal(guard.diagnostics().fullscreen, true);

    // Esc ni bosib turish → brauzer to'liq ekrandan chiqaradi → klaviatura qulfi bo'shatiladi
    env.leaveFullscreen();
    assert.equal(kb.unlocks, 1);
    assert.equal(guard.diagnostics().keyboardLock, 'off');
    guard.dispose();
    input.dispose();
  });

  it('lock() to\'liq ekran yo\'qligi uchun rad etilsa — fullscreenchange da bir marta qayta urinadi', async () => {
    const kb = makeKeyboard(env.log);
    kb.rejectNext = 1;
    env.setKeyboard(kb);
    // to'liq ekran keyinroq (makrotask) faollashadi
    env.root.requestFullscreen = () => {
      env.log.push('requestFullscreen');
      return new Promise<void>((r) => setTimeout(() => (env.enterFullscreen(), r()), 5));
    };
    const input = makeInput();
    const guard = createBrowserGuard({
      input,
      root: env.root as unknown as HTMLElement,
      settings: makeSettings({ fullscreen: true }),
    });
    guard.beforeLock();
    await flush();
    assert.equal(guard.diagnostics().keyboardLock, 'pending');
    await new Promise<void>((r) => setTimeout(r, 15));
    assert.equal(kb.calls.length, 2);
    assert.equal(guard.diagnostics().keyboardLock, 'locked');
    guard.dispose();
    input.dispose();
  });

  it('navigator.keyboard yo\'q (LAN http) — unsupported, to\'liq ekran baribir so\'raladi, izoh ogohlantiradi', async () => {
    env.setKeyboard(undefined);
    env.win.isSecureContext = false;
    const input = makeInput();
    const guard = createBrowserGuard({
      input,
      root: env.root as unknown as HTMLElement,
      settings: makeSettings({ fullscreen: true }),
    });
    assert.equal(env.hint.classes.has('warn'), true);
    assert.match(env.hint.textContent, /localhost yoki HTTPS/);
    assert.doesNotThrow(() => guard.beforeLock());
    assert.ok(env.log.includes('requestFullscreen'));
    const d = guard.diagnostics();
    assert.equal(d.keyboardLock, 'unsupported');
    assert.equal(d.secureContext, false);
    await flush();
    guard.dispose();
    input.dispose();
  });

  it('pauza menyusi katakchasi: sozlamani saqlaydi, o\'chirilganda to\'liq ekrandan chiqadi', async () => {
    const kb = makeKeyboard(env.log);
    env.setKeyboard(kb);
    const input = makeInput();
    const settings = makeSettings({ fullscreen: false });
    const guard = createBrowserGuard({ input, root: env.root as unknown as HTMLElement, settings });
    assert.equal(env.checkbox.checked, false);
    assert.equal(env.hint.classes.has('warn'), false);

    env.checkbox.checked = true;
    env.checkbox.dispatch('change', new FakeEvent());
    assert.equal(settings.fullscreen, true);
    assert.equal(loadSettings().fullscreen, true, 'localStorage ga yozildi');

    guard.beforeLock();
    await flush();
    assert.equal(guard.diagnostics().fullscreen, true);

    env.checkbox.checked = false;
    env.checkbox.dispatch('change', new FakeEvent());
    assert.equal(settings.fullscreen, false);
    assert.ok(env.log.includes('exitFullscreen'));
    assert.ok(kb.unlocks >= 1);
    assert.equal(guard.diagnostics().fullscreen, false);
    assert.equal(loadSettings().fullscreen, false);
    guard.dispose();
    input.dispose();
  });

  it('dispose barcha tinglovchilarni olib tashlaydi, qulfni bo\'shatadi va o\'zi kirgan to\'liq ekrandan chiqadi', async () => {
    const kb = makeKeyboard(env.log);
    env.setKeyboard(kb);
    const docBefore = env.doc.total();
    const winBefore = env.win.total();
    const guard = createBrowserGuard({
      input: { locked: true, lastUnlockAtMs: Number.NEGATIVE_INFINITY },
      root: env.root as unknown as HTMLElement,
      settings: makeSettings({ fullscreen: true }),
    });
    assert.ok(env.doc.total() > docBefore);
    assert.equal(env.win.count('beforeunload'), 1);
    assert.equal(env.checkbox.count('change'), 1);
    guard.beforeLock();
    await flush();
    assert.equal(guard.diagnostics().fullscreen, true);

    guard.dispose();
    assert.equal(env.doc.total(), docBefore);
    assert.equal(env.win.total(), winBefore);
    assert.equal(env.checkbox.count('change'), 0);
    assert.ok(kb.unlocks >= 1);
    assert.ok(env.log.includes('exitFullscreen'));
    assert.equal(guard.diagnostics().beforeUnloadArmed, false);
    const ev = new FakeEvent();
    env.win.dispatch('beforeunload', ev);
    assert.equal(ev.defaultPrevented, false);
  });
});

describe('settings.fullscreen', () => {
  it('standart false, saqlanadi va noto\'g\'ri qiymat false ga qaytadi', () => {
    assert.equal(loadSettings().fullscreen, false);
    saveSettings(makeSettings({ fullscreen: true }));
    assert.equal(loadSettings().fullscreen, true);
    env.storage.set('stickman-strike-settings', JSON.stringify({ name: 'X', sensitivity: 2, fullscreen: 'yes' }));
    const s = loadSettings();
    assert.equal(s.fullscreen, false);
    assert.equal(s.sens, 2, 'eski `sensitivity` hali o\'qiladi');
  });
});
