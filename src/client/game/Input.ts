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

  constructor(private target: HTMLElement) {
    this.on(document, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.target instanceof HTMLInputElement) return;
      if (this.locked && (ev.code === 'Tab' || ev.code === 'Space' || ev.code === 'Slash')) ev.preventDefault();
      if (!this.keys.has(ev.code)) this.pressed.add(ev.code);
      this.keys.add(ev.code);
    });
    this.on(document, 'keyup', (e) => {
      this.keys.delete((e as KeyboardEvent).code);
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
    this.on(document, 'wheel', (e) => {
      if (!this.locked) return;
      this.wheel += Math.sign((e as WheelEvent).deltaY);
    }, { passive: true });
    this.on(document, 'contextmenu', (e) => e.preventDefault());
    this.on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) this.reset();
      this.onLockChange?.(this.locked);
    });
    this.on(window, 'blur', () => this.reset());
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
