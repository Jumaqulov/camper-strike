import type { WeaponId } from '../../shared/weapons';
import type { SurfaceKind } from './surface';

interface P3 {
  x: number;
  y: number;
  z: number;
}

export type AmbientProfile = 'forest' | 'arena';

/** Masofaviy otishma: shu masofadan boshlab past chastota filtri va aks-sado qo'shiladi (m). */
const DISTANT_SHOT_FROM = 22;
const DISTANT_SHOT_FULL = 150;

/**
 * Barcha ovozlar WebAudio yordamida protsedural tarzda yaratiladi (tashqi fayllar kerak emas).
 * 3D pozitsion ovoz uchun HRTF PannerNode ishlatiladi.
 */
export class AudioSys {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private vol = 0.7;
  private listenerPos: P3 = { x: 0, y: 0, z: 0 };
  private ambientProfile: AmbientProfile | null = null;
  private ambient: { gain: GainNode; nodes: AudioNode[]; timers: number[] } | null = null;

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      if (this.ambientProfile && !this.ambient) this.buildAmbient();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.vol;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    if (this.ambientProfile) this.buildAmbient();
  }

  // ---------------- Ambient qatlam: shamol, barglar shitirlashi, qushlar ----------------

  /** Ambient fonni yoqadi (kontekst hali yo'q bo'lsa, init() dan keyin avtomatik boshlanadi). */
  startAmbient(profile: AmbientProfile): void {
    if (this.ambientProfile === profile && this.ambient) return;
    this.stopAmbient();
    this.ambientProfile = profile;
    if (this.ctx) this.buildAmbient();
  }

  stopAmbient(): void {
    this.ambientProfile = null;
    const a = this.ambient;
    if (!a) return;
    this.ambient = null;
    for (const t of a.timers) clearTimeout(t);
    const now = this.ctx?.currentTime ?? 0;
    try {
      a.gain.gain.setTargetAtTime(0.0001, now, 0.4);
    } catch {
      /* e'tibor bermaymiz */
    }
    setTimeout(() => {
      for (const n of a.nodes) {
        try {
          if (n instanceof AudioScheduledSourceNode) n.stop();
          n.disconnect();
        } catch {
          /* e'tibor bermaymiz */
        }
      }
      try {
        a.gain.disconnect();
      } catch {
        /* e'tibor bermaymiz */
      }
    }, 1200);
  }

  private buildAmbient(): void {
    const c = this.ctx;
    const profile = this.ambientProfile;
    if (!c || !profile || this.ambient) return;
    const forest = profile === 'forest';
    const nodes: AudioNode[] = [];
    const timers: number[] = [];
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(forest ? 1 : 0.7, c.currentTime + 2.5);
    gain.connect(this.master);

    const schedule = (fn: () => void, minMs: number, maxMs: number) => {
      const id = window.setTimeout(() => {
        if (this.ambient?.timers !== timers) return;
        fn();
        schedule(fn, minMs, maxMs);
      }, minMs + Math.random() * (maxMs - minMs));
      timers.push(id);
    };

    if (forest) {
      // 3. Qushlar: tasodifiy joydan, tasodifiy oraliqda chirqillash; vaqti-vaqti bilan uzoqdan qizilishton
      schedule(() => this.birdChirp(gain), 1500, 6500);
      schedule(() => this.woodpecker(gain), 18000, 45000);
    }

    this.ambient = { gain, nodes, timers };
  }

  /** Tinglovchi atrofidagi tasodifiy nuqta (uzoqlik va balandlik bilan). */
  private randomAround(minD: number, maxD: number, height: number): P3 {
    const a = Math.random() * Math.PI * 2;
    const d = minD + Math.random() * (maxD - minD);
    const l = this.listenerPos;
    return { x: l.x + Math.cos(a) * d, y: l.y + height, z: l.z + Math.sin(a) * d };
  }

  private birdChirp(out: AudioNode): void {
    const c = this.ctx;
    if (!c) return;
    const d = this.spatial(this.randomAround(10, 34, 4 + Math.random() * 6), out, 6);
    const t = c.currentTime;
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2100 + Math.random() * 1900;
    const gap = 0.08 + Math.random() * 0.07;
    for (let i = 0; i < notes; i++) {
      const f0 = base * (0.9 + Math.random() * 0.25);
      const f1 = f0 * (0.65 + Math.random() * 0.7);
      this.tone(d, t + i * gap, 'sine', f0, f1, 0.045 + Math.random() * 0.06, 0.05 + Math.random() * 0.035);
    }
  }

  private woodpecker(out: AudioNode): void {
    const c = this.ctx;
    if (!c) return;
    const d = this.spatial(this.randomAround(25, 55, 5), out, 6);
    const t = c.currentTime;
    const n = 6 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      this.noise(d, t + i * 0.07, 0.025, 'bandpass', 1400, 1100, 2.5, 0.09, 0.002);
    }
  }

  /** Pozitsion panner, ixtiyoriy chiqish tuguniga (ambient gain) ulanadi. */
  private spatial(pos: P3, out: AudioNode, refDistance = 4): AudioNode {
    const c = this.ctx!;
    const p = c.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.maxDistance = 250;
    p.rolloffFactor = 1.1;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    p.connect(out);
    return p;
  }

  setVolume(v: number): void {
    this.vol = v;
    if (this.ctx) this.master.gain.value = v;
  }

  updateListener(pos: P3, fwd: P3): void {
    const c = this.ctx;
    if (!c) return;
    this.listenerPos = { x: pos.x, y: pos.y, z: pos.z };
    const l = c.listener;
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x;
      l.forwardY.value = fwd.y;
      l.forwardZ.value = fwd.z;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  /**
   * Chiqish tuguni: pozitsiyasiz — master, pozitsiyali — bir martalik panner. Panner `ttlSec` dan keyin
   * master'dan uziladi (aks holda har otish/qadam uchun yaratilgan tugunlar grafda abadiy qoladi);
   * uzunroq ovozlar kattaroq ttl bersin. Doimiy (ambient) manbalar buni ishlatmaydi — ular `spatial()` da.
   */
  private dest(pos?: P3, ttlSec = 4): AudioNode | null {
    const c = this.ctx;
    if (!c) return null;
    if (!pos) return this.master;
    const p = c.createPanner();
    // Har bir otish/qadam uchun yangi panner yaratiladi; HRTF konvolyutsiyasi katta janglarda juda qimmat
    // (sekundiga o'nlab tugun) — equalpower deyarli bir xil fazoviy his beradi va CPU ni band qilmaydi.
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.maxDistance = 250;
    p.rolloffFactor = 1.1;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    p.connect(this.master);
    window.setTimeout(() => {
      try {
        p.disconnect();
      } catch {
        /* e'tibor bermaymiz */
      }
    }, Math.max(0.5, ttlSec) * 1000);
    return p;
  }

  private noise(d: AudioNode, t0: number, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, gain: number, attack = 0.004) {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(d);
    // Shovqin buferi 2 s: boshlanish ofseti shunday tanlanadiki, tovush davomiyligi (dur) buferga sig'sin,
    // aks holda uzun dumli ovozlar (portlash, snayper) bufer tugashi bilan kesilib qolardi.
    const maxOffset = Math.max(0, src.buffer!.duration - dur - 0.05);
    src.start(t0, Math.random() * maxOffset);
    src.stop(t0 + dur + 0.05);
  }

  private tone(d: AudioNode, t0: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number) {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(d);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /**
   * Otishma uchun chiqish zanjiri. Yaqin otishma — oddiy panner. Uzoq otishma (> 22 m):
   * yuqori chastotalar so'nadi (lowpass), ikkita aks-sado (o'rmon echo) va past "gumburlash" dumi qo'shiladi —
   * o'yinchi raqib qanchalik uzoqdaligini ovozdan biladi.
   */
  private shotDest(pos?: P3): { d: AudioNode; dist: number; k: number } | null {
    const c = this.ctx;
    if (!c) return null;
    if (!pos) return { d: this.master, dist: 0, k: 0 };
    const dist = Math.hypot(pos.x - this.listenerPos.x, pos.y - this.listenerPos.y, pos.z - this.listenerPos.z);
    const panner = this.dest(pos)!;
    if (dist < DISTANT_SHOT_FROM) return { d: panner, dist, k: 0 };
    const k = Math.min(1, (dist - DISTANT_SHOT_FROM) / (DISTANT_SHOT_FULL - DISTANT_SHOT_FROM));
    const entry = c.createGain();
    entry.gain.value = 1 - 0.2 * k;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5200 - 4500 * k;
    lp.Q.value = 0.5;
    entry.connect(lp).connect(panner);
    // Aks-sado: ikki tap, uzoqlashgan sari kechroq va nisbatan kuchliroq
    const echoNodes: AudioNode[] = [];
    const taps: [number, number, number][] = [
      [0.09 + 0.22 * k, 0.22 + 0.25 * k, 900 - 450 * k],
      [0.26 + 0.5 * k, 0.1 + 0.16 * k, 600 - 250 * k],
    ];
    for (const [delay, g, cutoff] of taps) {
      const dl = c.createDelay(1.2);
      dl.delayTime.value = delay;
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cutoff;
      const eg = c.createGain();
      eg.gain.value = g;
      lp.connect(dl).connect(f).connect(eg).connect(panner);
      echoNodes.push(dl, f, eg);
    }
    // Tugunlarni ovoz tugagach bo'shatamiz (delay tuguni o'z-o'zidan yig'ilmaydi)
    window.setTimeout(() => {
      for (const n of [entry, lp, ...echoNodes, panner]) {
        try {
          n.disconnect();
        } catch {
          /* e'tibor bermaymiz */
        }
      }
    }, 3200);
    return { d: entry, dist, k };
  }

  /**
   * Pichoq hilpirashi (havoni kesish): sekin ko'tarilib tushadigan yumshoq "vush" — o'q ovozidan farqli
   * o'laroq keskin boshlanishsiz (attack 90 ms), past tovush va o'rta chastotali tor filtr.
   */
  knifeSwing(pos?: P3): void {
    const chain = this.shotDest(pos);
    if (!chain) return;
    const t = this.ctx!.currentTime;
    // Asosiy "vush": bandpass 350 → 1400 Hz, 0.26 s, sekin kirish
    this.noise(chain.d, t, 0.26, 'bandpass', 350, 1400, 2.2, 0.16, 0.09);
    // Yengil "svish" dumi
    this.noise(chain.d, t + 0.08, 0.16, 'bandpass', 1800, 900, 1.6, 0.05, 0.05);
  }

  /** Pichoq tanaga tegdi: bo'g'iq "tup" — past shovqin va qisqa past ton. */
  knifeHit(): void {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    this.noise(this.master, t, 0.11, 'lowpass', 420, 90, 0.8, 0.5, 0.004);
    this.tone(this.master, t, 'sine', 140, 55, 0.09, 0.35);
  }

  gunshot(w: WeaponId, pos?: P3): void {
    const chain = this.shotDest(pos);
    if (!chain) return;
    const { d, k } = chain;
    const t = this.ctx!.currentTime;
    if (k > 0) {
      // Uzoqdagi otishmaning past chastotali gumburlashi
      this.noise(d, t + 0.01, 0.35 + 0.6 * k, 'lowpass', 420, 70, 0.7, 0.12 + 0.3 * k, 0.02);
    }
    switch (w) {
      case 'pistol':
        this.noise(d, t, 0.13, 'bandpass', 2400, 700, 0.9, 0.9);
        this.tone(d, t, 'triangle', 240, 60, 0.09, 0.5);
        break;
      case 'rifle':
        this.noise(d, t, 0.17, 'lowpass', 4200, 450, 0.7, 1.0);
        this.tone(d, t, 'sawtooth', 150, 40, 0.1, 0.35);
        break;
      case 'shotgun':
        this.noise(d, t, 0.42, 'lowpass', 2400, 180, 0.6, 1.3);
        this.tone(d, t, 'sine', 110, 30, 0.3, 0.9);
        break;
      case 'sniper':
        this.noise(d, t, 0.05, 'highpass', 5000, 3000, 0.7, 0.8);
        this.noise(d, t, 0.75, 'lowpass', 3200, 140, 0.6, 1.3);
        this.tone(d, t, 'sine', 85, 28, 0.45, 1.0);
        break;
    }
  }

  private click(d: AudioNode, t: number, f: number, gain = 0.35) {
    this.noise(d, t, 0.035, 'highpass', f, f * 0.8, 1, gain, 0.002);
    this.tone(d, t, 'square', f * 0.5, f * 0.4, 0.025, gain * 0.4);
  }

  reload(duration: number, pos?: P3): void {
    // Qayta o'qlash davomiyligi qurolga bog'liq (2.8 s gacha) — panner oxirgi klikdan keyin ham yashasin
    const d = this.dest(pos, duration + 1.5);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.click(d, t + 0.05, 1500, 0.25);
    this.click(d, t + duration * 0.35, 900, 0.4);
    this.click(d, t + duration * 0.7, 1300, 0.45);
    this.click(d, t + duration * 0.9, 2200, 0.35);
  }

  switchWeapon(): void {
    const d = this.dest();
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.click(d, t, 1800, 0.25);
    this.click(d, t + 0.12, 1200, 0.25);
  }

  empty(): void {
    const d = this.dest();
    if (!d) return;
    this.click(d, this.ctx!.currentTime, 2600, 0.3);
  }

  /** Qadam tovushi yuzaga qarab: maysa (yumshoq), shag'al (g'ichirlash), tuproq, yog'och (taqillash), tosh, metall. */
  footstep(pos?: P3, vol = 0.25, surface: SurfaceKind = 'grass'): void {
    const d = this.dest(pos);
    if (!d) return;
    const t = this.ctx!.currentTime;
    const r = Math.random();
    switch (surface) {
      case 'gravel': {
        // Shag'al — ikki faza: tovon zarbasi (zich donador g'ichirlash) va ~80 ms keyin oyoq uchi sirpanishi
        // (yengilroq, siyrakroq donalar + qisqa "shsh"); ostida past "ezilish" tanasi; gohida tosh dumalashi.
        const heavy = vol > 0.15; // sprint — ko'proq va kuchliroq donalar
        this.noise(d, t, 0.07, 'lowpass', 520 + r * 180, 190, 1.0, vol * 0.75, 0.003);
        this.tone(d, t, 'sine', 95, 60, 0.04, vol * 0.3);
        const heelGrains = (heavy ? 9 : 6) + Math.floor(Math.random() * 4);
        for (let i = 0; i < heelGrains; i++) {
          // Donalar zarba boshida zich, keyin siyraklashadi
          const dt = Math.pow(Math.random(), 1.6) * 0.045;
          const f = 1400 + Math.random() * 4200;
          const g = vol * (0.14 + Math.random() * 0.32);
          this.noise(d, t + dt, 0.007 + Math.random() * 0.012, 'bandpass', f, f * 0.8, 1.8 + Math.random(), g, 0.001);
        }
        const toeAt = t + 0.07 + Math.random() * 0.04;
        const toeGrains = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < toeGrains; i++) {
          const dt = Math.random() * 0.05;
          const f = 1800 + Math.random() * 3600;
          this.noise(d, toeAt + dt, 0.006 + Math.random() * 0.01, 'bandpass', f, f * 0.8, 2.0, vol * (0.07 + Math.random() * 0.16), 0.001);
        }
        this.noise(d, toeAt, 0.055, 'bandpass', 2100 + r * 900, 1500, 0.8, vol * 0.2, 0.006);
        if (Math.random() < 0.22) {
          // Tepilgan toshcha dumalashi
          this.tone(d, toeAt + 0.03, 'triangle', 900 + r * 500, 560, 0.045, vol * 0.18);
        }
        break;
      }
      case 'dirt': {
        const f = 650 + r * 350;
        this.noise(d, t, 0.085, 'lowpass', f, f * 0.4, 1.1, vol, 0.003);
        this.noise(d, t + 0.01, 0.035, 'bandpass', 1500 + r * 800, 1200, 1.2, vol * 0.25, 0.002);
        this.tone(d, t, 'sine', 85, 55, 0.05, vol * 0.45);
        break;
      }
      case 'wood': {
        // Yog'och pol: quruq "tak" — qisqa rezonansli zarba va ichi bo'sh taxta ohangi
        const f = 170 + r * 80;
        this.tone(d, t, 'sine', f, f * 0.6, 0.075, vol * 1.1);
        this.tone(d, t, 'triangle', f * 2.1, f * 1.3, 0.045, vol * 0.35);
        this.noise(d, t, 0.045, 'bandpass', 900 + r * 500, 500, 3.0, vol * 0.7, 0.002);
        break;
      }
      case 'stone': {
        const f = 1800 + r * 1200;
        this.noise(d, t, 0.05, 'highpass', f, f * 0.6, 1.0, vol * 0.75, 0.002);
        this.tone(d, t, 'sine', 320 + r * 120, 240, 0.045, vol * 0.4);
        break;
      }
      case 'metal': {
        this.noise(d, t, 0.04, 'highpass', 2600, 1800, 1.2, vol * 0.6, 0.002);
        this.tone(d, t, 'triangle', 2200 + r * 600, 1900, 0.14, vol * 0.35);
        this.tone(d, t, 'sine', 140, 90, 0.06, vol * 0.5);
        break;
      }
      case 'grass':
      default: {
        // Maysa: yumshoq, bo'g'iq zarba + ingichka shitirlash
        const f = 380 + r * 260;
        this.noise(d, t, 0.09, 'lowpass', f, f * 0.45, 1.2, vol * 0.85, 0.004);
        this.noise(d, t + 0.005, 0.07, 'bandpass', 2300 + r * 900, 1600, 0.9, vol * 0.22, 0.004);
        this.tone(d, t, 'sine', 80, 55, 0.05, vol * 0.4);
        break;
      }
    }
  }

  land(vol = 0.4): void {
    const d = this.dest();
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noise(d, t, 0.12, 'lowpass', 500, 120, 1, vol);
  }

  jump(): void {
    const d = this.dest();
    if (!d) return;
    this.noise(d, this.ctx!.currentTime, 0.06, 'lowpass', 700, 300, 1, 0.12);
  }

  hitmarker(head: boolean): void {
    const d = this.dest();
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.tone(d, t, 'sine', 1500, 1400, 0.06, 0.22);
    if (head) this.tone(d, t + 0.02, 'sine', 2600, 2500, 0.12, 0.25);
  }

  killConfirm(): void {
    const d = this.dest();
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.tone(d, t + 0.05, 'triangle', 880, 880, 0.1, 0.25);
    this.tone(d, t + 0.14, 'triangle', 1320, 1320, 0.16, 0.25);
  }

  hurt(): void {
    const d = this.dest();
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.tone(d, t, 'sine', 220, 110, 0.15, 0.35);
    this.noise(d, t, 0.1, 'lowpass', 900, 300, 1, 0.35);
  }

  explosion(pos?: P3): void {
    const d = this.dest(pos);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noise(d, t, 0.18, 'bandpass', 1800, 400, 0.6, 1.2);
    this.noise(d, t, 1.4, 'lowpass', 1400, 60, 0.7, 1.8, 0.01);
    this.tone(d, t, 'sine', 70, 22, 0.9, 1.4);
  }

  throwGrenade(): void {
    const d = this.dest();
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.click(d, t, 2000, 0.2);
    this.noise(d, t + 0.1, 0.25, 'bandpass', 900, 300, 1.5, 0.3, 0.05);
  }

  bounce(pos?: P3): void {
    const d = this.dest(pos);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.tone(d, t, 'triangle', 700, 500, 0.06, 0.25);
  }

  ui(): void {
    const d = this.dest();
    if (!d) return;
    this.tone(d, this.ctx!.currentTime, 'sine', 900, 1200, 0.06, 0.15);
  }

  roundEnd(win: boolean): void {
    const d = this.dest();
    if (!d) return;
    const t = this.ctx!.currentTime;
    const notes = win ? [523, 659, 784, 1046] : [523, 466, 392, 311];
    notes.forEach((f, i) => this.tone(d, t + i * 0.16, 'triangle', f, f, 0.3, 0.3));
  }
}
