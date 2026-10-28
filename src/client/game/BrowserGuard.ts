import { saveSettings, type GameSettings } from '../settings';
import { isTextEntryTarget, type Input } from './Input';

/**
 * BrowserGuard — o'yin paytida brauzer / OT yorliqlaridan himoya.
 *
 * 1) "Saytdan chiqasizmi?" tasdig'i (beforeunload): o'yinchi faol o'ynayotganda (pointer lock yoki
 *    undan chiqqaniga < 1.5 s) Ctrl+W / Alt+Left / Alt+F4 / qayta yuklash tabni jim yopmaydi.
 * 2) Ixtiyoriy to'liq ekran + Keyboard Lock (settings.fullscreen): Chromium, faqat xavfsiz kontekst
 *    (localhost / HTTPS). Fullscreen-API to'liq ekranida GUARD_KEYS sahifaga yetkaziladi — Alt+Tab,
 *    Ctrl+W, Alt+D, Alt+E/F va h.k. brauzerga / OT ga yetmaydi. Esc ni ~2 s bosib turish — to'liq
 *    ekrandan (va pointer lockdan) chiqish; qisqa Esc — pauza menyusi (pastdagi Esc ishlovchisi).
 *
 * Alt/Ctrl + o'yin tugmalari va g'ildirakning preventDefault qismi Input.ts da.
 */

/**
 * Keyboard Lock ro'yxati. F4 va Meta (Win) tugmalari ATAYIN yo'q: foydalanuvchi har doim Alt+F4 /
 * Win bilan chiqa oladi; Esc ni bosib turish ham har doim to'liq ekrandan chiqaradi.
 */
export const GUARD_KEYS: readonly string[] = Object.freeze([
  'Escape',
  'Tab',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyR',
  'KeyT',
  'KeyG',
  'KeyH',
  'KeyV',
  'KeyM',
  'KeyN',
  'KeyC',
  'KeyF',
  'Space',
  'Digit0',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
]);

/** Pointer lock yo'qolgandan keyin ham "chiqish" tasdig'i shuncha ms faol qoladi (Alt+F4 avval fokusni oladi). */
export const LEAVE_GUARD_GRACE_MS = 1500;

export type KeyboardLockState = 'off' | 'unsupported' | 'pending' | 'locked' | 'failed';

export interface BrowserGuardDiagnostics {
  fullscreen: boolean;
  keyboardLock: KeyboardLockState;
  beforeUnloadArmed: boolean;
  secureContext: boolean;
}

export interface BrowserGuard {
  /** Foydalanuvchi harakati (click) ishlovchisidan SINXRON, `input.lock()` dan oldin chaqiriladi. */
  beforeLock(): void;
  dispose(): void;
  diagnostics(): BrowserGuardDiagnostics;
}

export interface BrowserGuardOptions {
  input: Pick<Input, 'locked' | 'lastUnlockAtMs'>;
  /** To'liq ekranga o'tadigan element (HUD va pauza menyusi ham ichida bo'lishi kerak — masalan documentElement). */
  root: HTMLElement;
  settings: GameSettings;
}

/** Keyboard Lock API (WICG) — lib.dom da hali yo'q. */
interface KeyboardLockApi {
  lock(keyCodes?: readonly string[]): Promise<void>;
  unlock(): void;
}

function keyboardApi(): KeyboardLockApi | null {
  if (typeof navigator === 'undefined') return null;
  const kb = (navigator as Navigator & { keyboard?: Partial<KeyboardLockApi> }).keyboard;
  return kb && typeof kb.lock === 'function' && typeof kb.unlock === 'function' ? (kb as KeyboardLockApi) : null;
}

function isSecure(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

const HINT_SUPPORTED = "To'liq ekrandan chiqish: Esc ni ~2 soniya bosib turing (qisqa Esc — pauza).";
const HINT_UNSUPPORTED =
  "To'liq tugma himoyasi (Alt+Tab, Ctrl+W) faqat localhost yoki HTTPS orqali (Chrome/Edge) ishlaydi. " +
  "Bu yerda tabni tasodifan yopishdan \"Saytdan chiqasizmi?\" tasdig'i himoya qiladi.";

export function createBrowserGuard(opts: BrowserGuardOptions): BrowserGuard {
  const { input, root, settings } = opts;
  const handlers: [EventTarget, string, EventListener][] = [];
  const on = (t: EventTarget, type: string, fn: EventListener) => {
    t.addEventListener(type, fn);
    handlers.push([t, type, fn]);
  };

  let disposed = false;
  let kbState: KeyboardLockState = 'off';
  /** Eskirgan lock() promise natijalarini e'tiborsiz qoldirish uchun. */
  let kbToken = 0;
  /** lock() to'liq ekran hali faol bo'lmagani uchun rad etildi — keyingi fullscreenchange da 1 marta qayta. */
  let retryOnFullscreen = false;
  /** requestFullscreen() chaqirildi va hali rad etilmadi. */
  let fsRequested = false;
  /** To'liq ekranga AYNAN biz kirdik (dispose da chiqamiz). */
  let ownFullscreen = false;

  const supported = () => keyboardApi() !== null && isSecure();
  const isArmed = () =>
    !disposed && (input.locked || performance.now() - input.lastUnlockAtMs < LEAVE_GUARD_GRACE_MS);

  const releaseKeyboard = () => {
    kbToken++;
    retryOnFullscreen = false;
    try {
      keyboardApi()?.unlock();
    } catch {
      /* e'tibor bermaymiz */
    }
    kbState = 'off';
  };

  const exitOwnFullscreen = () => {
    if (!document.fullscreenElement) return;
    try {
      const p = document.exitFullscreen() as Promise<void> | undefined;
      p?.catch?.(() => {
        /* e'tibor bermaymiz */
      });
    } catch {
      /* e'tibor bermaymiz */
    }
  };

  const requestKeyboardLock = (isRetry: boolean) => {
    const kb = keyboardApi();
    if (!kb || !isSecure()) {
      kbState = 'unsupported';
      return;
    }
    const token = ++kbToken;
    kbState = 'pending';
    const onRejected = () => {
      if (disposed || token !== kbToken) return;
      // To'liq ekran hali faol emas edi — unga kirilgach bir marta qayta urinamiz
      if (!isRetry && fsRequested) {
        if (document.fullscreenElement) requestKeyboardLock(true);
        else retryOnFullscreen = true;
        return;
      }
      kbState = 'failed';
    };
    try {
      kb.lock(GUARD_KEYS).then(() => {
        if (disposed || token !== kbToken) return;
        kbState = 'locked';
      }, onRejected);
    } catch {
      onRejected();
    }
  };

  const onFullscreenFailed = () => {
    fsRequested = false;
    if (disposed) return;
    // To'liq ekransiz Keyboard Lock ishlamaydi — qulfni bo'shatib, xatoni qayd etamiz
    releaseKeyboard();
    kbState = supported() ? 'failed' : 'unsupported';
  };

  const onFullscreenChange = () => {
    if (disposed) return;
    if (document.fullscreenElement) {
      if (fsRequested) ownFullscreen = true;
      if (retryOnFullscreen) {
        retryOnFullscreen = false;
        requestKeyboardLock(true);
      }
    } else {
      fsRequested = false;
      ownFullscreen = false;
      releaseKeyboard();
    }
  };

  // Keyboard Lock da Esc ham qulflangan: qisqa Esc pointer lockni o'zi bo'shatmaydi — pauza menyusi
  // ochilishi uchun o'zimiz chiqaramiz (to'liq ekran qoladi). Qulfsiz holatda ham zararsiz.
  const onKeyDown = (e: Event) => {
    const ev = e as KeyboardEvent;
    if (ev.code !== 'Escape' || isTextEntryTarget(ev.target)) return;
    if (document.pointerLockElement) document.exitPointerLock();
  };

  const onBeforeUnload = (e: Event) => {
    if (!isArmed()) return;
    const ev = e as BeforeUnloadEvent;
    ev.preventDefault();
    ev.returnValue = ''; // eski Chrome/Edge (< 119) uchun
  };

  on(document, 'keydown', onKeyDown);
  on(document, 'fullscreenchange', onFullscreenChange);
  on(window, 'beforeunload', onBeforeUnload);

  // Pauza menyusidagi "To'liq ekran" katakchasi + izoh
  const checkbox = document.getElementById('set-fullscreen') as HTMLInputElement | null;
  const hint = document.getElementById('set-fullscreen-hint') as HTMLElement | null;
  if (checkbox) {
    checkbox.checked = settings.fullscreen === true;
    on(checkbox, 'change', () => {
      settings.fullscreen = checkbox.checked;
      saveSettings(settings);
      if (!settings.fullscreen) {
        releaseKeyboard();
        exitOwnFullscreen();
      }
    });
  }
  if (hint) {
    const ok = supported();
    hint.textContent = ok ? HINT_SUPPORTED : HINT_UNSUPPORTED;
    hint.classList.toggle('warn', !ok);
  }

  return {
    beforeLock() {
      if (disposed || settings.fullscreen !== true) return;
      // Tartib muhim (transient activation): avval keyboard.lock(), keyin requestFullscreen() — sinxron
      if (!supported()) kbState = 'unsupported';
      else if (kbState !== 'locked' && kbState !== 'pending') requestKeyboardLock(false);
      if (document.fullscreenElement || typeof root.requestFullscreen !== 'function') return;
      fsRequested = true;
      try {
        const p = root.requestFullscreen({ navigationUI: 'hide' }) as Promise<void> | undefined;
        p?.then?.(
          () => {
            if (disposed) {
              exitOwnFullscreen(); // dispose so'rov tugashidan oldin bo'lgan
              return;
            }
            ownFullscreen = true;
          },
          onFullscreenFailed,
        );
      } catch {
        onFullscreenFailed();
      }
    },

    dispose() {
      if (disposed) return;
      for (const [t, type, fn] of handlers) t.removeEventListener(type, fn);
      handlers.length = 0;
      releaseKeyboard();
      if (ownFullscreen) exitOwnFullscreen();
      ownFullscreen = false;
      fsRequested = false;
      disposed = true;
    },

    diagnostics() {
      return {
        fullscreen: typeof document !== 'undefined' && !!document.fullscreenElement,
        keyboardLock: supported() ? kbState : 'unsupported',
        beforeUnloadArmed: isArmed(),
        secureContext: isSecure(),
      };
    },
  };
}
