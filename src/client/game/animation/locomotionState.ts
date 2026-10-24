/**
 * Stage 08B-CHAR — locomotion state machine for the Camper Buddy character.
 *
 * Pure TypeScript (no three.js import) so it can be unit-tested headless.
 *
 * Inputs are noisy in practice:
 *  - `speed` for remotes comes from interpolated snapshot vx/vz and can flip between two
 *    snapshot values frame-to-frame; for the local player it is the predicted horizontal speed.
 *  - `onGround` can flicker false for 1–2 frames on slopes / step-downs.
 *
 * Filtering strategy:
 *  1. Speed is exponentially smoothed (time constant SPEED_SMOOTH_TAU) before classification.
 *  2. Idle↔Walk↔Run use hysteresis bands (enter/exit thresholds below) plus a minimum dwell time.
 *  3. Leaving the ground only counts as airborne after AIR_COYOTE_TIME of continuous air time.
 *
 * Tuning (game: WALK_SPEED 3.0, RUN_SPEED 6.5, jump air time ≈ 2·7.6/22 ≈ 0.69 s):
 *  - Walk enter > 0.7 m/s, exit to Idle < 0.4 m/s. Exit is deliberately above 0.3 m/s: a standing remote
 *    whose speed flickers 0 / 0.6 (±0.6 noise rectified at 0) smooths to ≈0.3 ± 0.04 and must still
 *    settle to Idle instead of moon-walking in place. Accelerating 0→3 m/s crosses 0.7 smoothed in ≈30 ms.
 *  - Run enter > 4.9 m/s, exit to Walk < 4.3 m/s. The 0.6 m/s band is ~15× the residual ripple of
 *    ±0.6 m/s alternating noise after smoothing (≈ ±0.04 m/s at 60 Hz), so it never thrashes,
 *    while staying far from both natural speeds (3.0 walk / 6.5 run) so timeScale clamps rarely bite.
 *  - When (re)entering locomotion from a non-locomotion state the band midpoints are used
 *    (0.55 m/s Idle/Walk, 4.6 m/s Walk/Run) since there is no "current" loco state to hysterese on.
 */

export type LocoState = 'Idle' | 'Walk' | 'Run' | 'JumpStart' | 'JumpAir' | 'Land' | 'Interact';

export interface LocoInput {
  /** Horizontal speed, m/s (non-finite → 0, negative → abs). */
  speed: number;
  onGround: boolean;
  alive: boolean;
}

export interface LocoOutput {
  state: LocoState;
  /** True only on the update in which `state` changed. */
  changed: boolean;
  /** Recommended playback rate for the state's clip. */
  timeScale: number;
  /** Recommended crossfade seconds for the most recent transition into `state`. */
  fade: number;
}

/** Natural ground speed of the authored clips (m/s at timeScale 1). */
export const WALK_NATURAL_SPEED = 3.005;
export const RUN_NATURAL_SPEED = 6.498;

/** Clip durations (seconds) — match the GLB (see docs/stage08b-char/CONTRACTS.md). */
export const JUMP_START_DURATION = 0.4;
export const LAND_DURATION = 0.5;
export const INTERACT_DURATION = 1.2;

export const LOCO_TUNING = {
  /** Exponential smoothing time constant for speed (s). */
  SPEED_SMOOTH_TAU: 0.12,
  WALK_ENTER: 0.7,
  WALK_EXIT: 0.4,
  RUN_ENTER: 4.9,
  RUN_EXIT: 4.3,
  /** Minimum time in a locomotion state before another locomotion transition (s). */
  MIN_DWELL: 0.15,
  /** Continuous air time before the character is considered airborne (s). */
  AIR_COYOTE_TIME: 0.08,
  /** Air time at/above which touching down plays Land; shorter hops go straight to locomotion. */
  LAND_MIN_AIR_TIME: 0.25,
  /** Smoothed speed above which Land is interrupted (after LAND_INTERRUPT_AFTER) and Interact cancelled. */
  MOVE_CANCEL_SPEED: 1.0,
  LAND_INTERRUPT_AFTER: 0.15,
  WALK_TIMESCALE_MIN: 0.55,
  WALK_TIMESCALE_MAX: 1.6,
  RUN_TIMESCALE_MIN: 0.7,
  RUN_TIMESCALE_MAX: 1.35,
  /** Recommended crossfade durations (s). */
  FADE_LOCOMOTION: 0.18,
  FADE_JUMP_START: 0.1,
  FADE_JUMP_AIR: 0.15,
  FADE_LAND: 0.12,
  FADE_INTERACT: 0.2,
  /** Per-update dt clamp (s) so a long hitch can't skip whole states. */
  MAX_DT: 0.25,
} as const;

const T = LOCO_TUNING;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isLocomotion(s: LocoState): s is 'Idle' | 'Walk' | 'Run' {
  return s === 'Idle' || s === 'Walk' || s === 'Run';
}

function fadeInto(s: LocoState): number {
  switch (s) {
    case 'JumpStart': return T.FADE_JUMP_START;
    case 'JumpAir': return T.FADE_JUMP_AIR;
    case 'Land': return T.FADE_LAND;
    case 'Interact': return T.FADE_INTERACT;
    default: return T.FADE_LOCOMOTION;
  }
}

/** Recommended timeScale for `state` at (smoothed) `speed`. */
export function locomotionTimeScale(state: LocoState, speed: number): number {
  if (state === 'Walk') return clamp(speed / WALK_NATURAL_SPEED, T.WALK_TIMESCALE_MIN, T.WALK_TIMESCALE_MAX);
  if (state === 'Run') return clamp(speed / RUN_NATURAL_SPEED, T.RUN_TIMESCALE_MIN, T.RUN_TIMESCALE_MAX);
  return 1;
}

export class LocomotionStateMachine {
  private _state: LocoState = 'Idle';
  private stateTime = 0;
  private smoothSpeed = 0;
  private primed = false;
  /** Continuous time with onGround=false (includes the coyote window). */
  private airTime = 0;
  private interactRequested = false;
  private lastFade: number = T.FADE_LOCOMOTION;
  private lastTimeScale = 1;

  get state(): LocoState {
    return this._state;
  }

  /** Smoothed speed used for classification (diagnostics / tests). */
  get smoothedSpeed(): number {
    return this.smoothSpeed;
  }

  /** Queue a one-shot Interact; honoured on the next update only if grounded, alive and ~stationary. */
  requestInteract(): void {
    this.interactRequested = true;
  }

  reset(): void {
    this._state = 'Idle';
    this.stateTime = 0;
    this.smoothSpeed = 0;
    this.primed = false;
    this.airTime = 0;
    this.interactRequested = false;
    this.lastFade = T.FADE_LOCOMOTION;
    this.lastTimeScale = 1;
  }

  update(dt: number, i: LocoInput): LocoOutput {
    if (!i.alive) {
      // Death is procedural elsewhere: hold everything.
      this.interactRequested = false;
      return { state: this._state, changed: false, timeScale: this.lastTimeScale, fade: this.lastFade };
    }

    dt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, T.MAX_DT) : 0;
    const rawSpeed = Number.isFinite(i.speed) ? Math.abs(i.speed) : 0;

    if (!this.primed) {
      // First sample after construction/reset: snap so a remote that spawns mid-run doesn't ramp from Idle.
      this.smoothSpeed = rawSpeed;
      this.primed = true;
      this.stateTime = T.MIN_DWELL; // classify immediately on the priming frame
    } else if (dt > 0) {
      const a = 1 - Math.exp(-dt / T.SPEED_SMOOTH_TAU);
      this.smoothSpeed += (rawSpeed - this.smoothSpeed) * a;
    }
    const s = this.smoothSpeed;

    this.stateTime += dt;
    if (!i.onGround) this.airTime += dt;
    // decide() reads airTime at touchdown (Land vs short hop) before it is cleared.
    const next = this.decide(s, i.onGround);
    if (i.onGround) this.airTime = 0;

    const wantInteract = this.interactRequested;
    this.interactRequested = false;

    let target = next;
    if (
      wantInteract &&
      i.onGround &&
      target !== 'Interact' &&
      (isLocomotion(target) || target === 'Land') &&
      s <= T.MOVE_CANCEL_SPEED
    ) {
      target = 'Interact';
    }

    let changed = false;
    if (target !== this._state) {
      this._state = target;
      this.stateTime = 0;
      this.lastFade = fadeInto(target);
      changed = true;
    }

    this.lastTimeScale = locomotionTimeScale(this._state, s);
    return { state: this._state, changed, timeScale: this.lastTimeScale, fade: this.lastFade };
  }

  /** Fresh locomotion classification (no current loco state to apply hysteresis against). */
  private classifyFresh(s: number): 'Idle' | 'Walk' | 'Run' {
    if (s > (T.RUN_ENTER + T.RUN_EXIT) * 0.5) return 'Run';
    if (s > (T.WALK_ENTER + T.WALK_EXIT) * 0.5) return 'Walk';
    return 'Idle';
  }

  /** Hysteresis classification relative to the current locomotion state. */
  private classifyFrom(cur: 'Idle' | 'Walk' | 'Run', s: number): 'Idle' | 'Walk' | 'Run' {
    switch (cur) {
      case 'Idle':
        if (s > T.RUN_ENTER) return 'Run';
        if (s > T.WALK_ENTER) return 'Walk';
        return 'Idle';
      case 'Walk':
        if (s > T.RUN_ENTER) return 'Run';
        if (s < T.WALK_EXIT) return 'Idle';
        return 'Walk';
      case 'Run':
        if (s < T.WALK_EXIT) return 'Idle';
        if (s < T.RUN_EXIT) return 'Walk';
        return 'Run';
    }
  }

  private decide(s: number, onGround: boolean): LocoState {
    const st = this._state;
    const airborne = !onGround && this.airTime > T.AIR_COYOTE_TIME;

    switch (st) {
      case 'JumpStart':
      case 'JumpAir':
        if (onGround) {
          return this.airTime >= T.LAND_MIN_AIR_TIME ? 'Land' : this.classifyFresh(s);
        }
        if (st === 'JumpStart' && this.stateTime >= JUMP_START_DURATION) return 'JumpAir';
        return st;

      case 'Land':
        if (airborne) return 'JumpStart';
        if (s > T.MOVE_CANCEL_SPEED && this.stateTime >= T.LAND_INTERRUPT_AFTER) return this.classifyFresh(s);
        if (this.stateTime >= LAND_DURATION) return this.classifyFresh(s);
        return 'Land';

      case 'Interact':
        if (airborne) return 'JumpStart';
        if (s > T.MOVE_CANCEL_SPEED) return this.classifyFresh(s);
        if (this.stateTime >= INTERACT_DURATION) return this.classifyFresh(s);
        return 'Interact';

      default: {
        if (airborne) return 'JumpStart';
        if (this.stateTime < T.MIN_DWELL) return st;
        return this.classifyFrom(st, s);
      }
    }
  }
}
