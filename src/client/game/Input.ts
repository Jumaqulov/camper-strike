/** Brauzer/OT yorliqlarini uyg'otishi mumkin bo'lgan modifikator tugmalar (o'yin paytida bloklanadi). */
const MODIFIER_CODES = new Set(['AltLeft', 'AltRight', 'ControlLeft', 'ControlRight']);

/**
 * O'yin paytida (pointer lock faol) brauzerning standart amalini to'xtatish kerakmi?
 * Tab/Space/Slash — sahifa fokusi / skroll / Firefox tezkor qidiruvi; Alt/Ctrl kombinatsiyalari —
 * manzil satri (Alt+D), menyular (Alt+E/F, Firefox Alt+S/V/T/H), dialoglar (Ctrl+S/D/F/R/P/G/H),
 * orqaga o'tish (Alt+Left) va h.k. Ctrl+W / Ctrl+T / Ctrl+N / Alt+Tab ni preventDefault to'xtata olmaydi
 * (ular uchun BrowserGuard: to'liq ekran + Keyboard Lock va "Saytdan chiqasizmi?" tasdig'i).
 */
export function shouldBlockGameKey(ev: Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey'>): boolean {
  return (
    ev.code === 'Tab' ||
    ev.code === 'Space' ||
    ev.code === 'Slash' ||
    ev.altKey ||
    ev.ctrlKey ||
    MODIFIER_CODES.has(ev.code)
  );
}

function isTextInputTarget(t: EventTarget | null): boolean {
  return typeof HTMLInputElement !== 'undefined' && t instanceof HTMLInputElement;
}

/** Klaviatura + sichqoncha (pointer lock) boshqaruvi. */
export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  buttons = [false, false, false];
  clicks = [false, false, false];
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  private handlers: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [];
  /** performance.now() — pointer lock oxirgi marta yo'qolgan payt (BrowserGuard "chiqish" tasdig'i uchun). */
  private unlockAtMs = Number.NEGATIVE_INFINITY;

  constructor(private target: HTMLElement) {
    this.on(document, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      // chat inputi o'z tugmalarini o'zi boshqaradi
      if (isTextInputTarget(ev.target)) return;
      if (this.locked && shouldBlockGameKey(ev)) ev.preventDefault();
      if (!this.keys.has(ev.code)) this.pressed.add(ev.code);
      this.keys.add(ev.code);
    });
    this.on(document, 'keyup', (e) => {
      const ev = e as KeyboardEvent;
      // Firefox: yolg'iz Alt qo'yib yuborilganda menyu satri ochilmasin
      if (this.locked && !isTextInputTarget(ev.target) && (ev.code === 'AltLeft' || ev.code === 'AltRight')) {
        ev.preventDefault();
      }
      this.keys.delete(ev.code);
    });
    this.on(document, 'mousemove', (e) => {
      if (!this.locked) return;
      const ev = e as MouseEvent;
      // ba'zi brauzerlardagi keskin sakrashlarni filtrlash
      if (Math.abs(ev.movementX) > 400 || Math.abs(ev.movementY) > 400) return;
      this.mouseDX += ev.movementX;
      this.mouseDY += ev.movementY;
    });
    this.on(document, 'mousedown', (e) => {
      if (!this.locked) return;
      const b = (e as MouseEvent).button;
      if (b < 3) {
        this.buttons[b] = true;
        this.clicks[b] = true;
      }
    });
    this.on(document, 'mouseup', (e) => {
      const b = (e as MouseEvent).button;
      if (b < 3) this.buttons[b] = false;
    });
    // passive: false — o'yin paytida g'ildirak sahifani skroll qilmasin, Ctrl+g'ildirak masshtabni,
    // Alt/Shift+g'ildirak tarixni o'zgartirmasin (faqat qurol almashtirish)
    this.on(document, 'wheel', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.wheel += Math.sign((e as WheelEvent).deltaY);
    }, { passive: false });
    this.on(document, 'contextmenu', (e) => e.preventDefault());
    this.on(document, 'pointerlockchange', () => {
      const wasLocked = this.locked;
      this.locked = document.pointerLockElement === this.target;
      if (wasLocked && !this.locked) this.unlockAtMs = performance.now();
      if (!this.locked) this.reset();
      this.onLockChange?.(this.locked);
    });
    this.on(window, 'blur', () => this.reset());
  }

  /** performance.now() — oxirgi locked → unlocked o'tish payti (hali bo'lmagan bo'lsa −∞). */
  get lastUnlockAtMs(): number {
    return this.unlockAtMs;
  }

  private on(t: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) {
    t.addEventListener(type, fn, opts);
    this.handlers.push([t, type, fn, opts]);
  }

  lock(): void {
    try {
      const p = this.target.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {
        /* brauzer rad etdi — foydalanuvchi qayta bosadi */
      });
    } catch {
      /* e'tibor bermaymiz */
    }
  }

  unlock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  justPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  endFrame(): void {
    this.pressed.clear();
    this.clicks = [false, false, false];
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }

  reset(): void {
    this.keys.clear();
    this.buttons = [false, false, false];
  }

  dispose(): void {
    for (const [t, type, fn, opts] of this.handlers) t.removeEventListener(type, fn, opts);
    this.handlers = [];
    this.unlock();
  }
}
