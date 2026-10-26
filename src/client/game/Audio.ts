import type { WeaponId } from '../../shared/weapons';

interface P3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Barcha ovozlar WebAudio yordamida protsedural tarzda yaratiladi (tashqi fayllar kerak emas).
 * 3D pozitsion ovoz uchun HRTF PannerNode ishlatiladi.
 */
export class AudioSys {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private vol = 0.7;

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
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
  }

  setVolume(v: number): void {
    this.vol = v;
    if (this.ctx) this.master.gain.value = v;
  }

  updateListener(pos: P3, fwd: P3): void {
    const c = this.ctx;
    if (!c) return;
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

  private dest(pos?: P3): AudioNode | null {
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

  gunshot(w: WeaponId, pos?: P3): void {
    const d = this.dest(pos);
    if (!d) return;
    const t = this.ctx!.currentTime;
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
    const d = this.dest(pos);
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

  footstep(pos?: P3, vol = 0.25): void {
    const d = this.dest(pos);
    if (!d) return;
    const t = this.ctx!.currentTime;
    const f = 500 + Math.random() * 400;
    this.noise(d, t, 0.08, 'lowpass', f, f * 0.5, 1.2, vol, 0.003);
    this.tone(d, t, 'sine', 90, 60, 0.05, vol * 0.5);
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
