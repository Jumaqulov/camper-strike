/**
 * Stage 08B-CHAR — clip playback for one Camper Buddy instance.
 *
 * Wraps a THREE.AnimationMixer bound to the instance root and drives the 7 authored clips from
 * LocomotionStateMachine. Weights are managed manually (not crossFadeTo) so that interrupted fades
 * can never leave a frame whose total weight is < 1 (no bind/T-pose pop):
 *   target += dt / fade; every other action is rescaled so Σ(others) = 1 − target.
 * Walk↔Run transitions copy the normalized phase and keep both clips phase-locked while blending.
 *
 * The animator only touches mixer/action state; upper-body aim overrides are applied by the caller
 * after `update()` (see CharacterAimPose).
 */
import * as THREE from 'three';
import { LocomotionStateMachine, type LocoInput, type LocoState } from './locomotionState';

/** Clip lookup by name (structurally compatible with ReadonlyMap<CamperBuddyClipName, AnimationClip>). */
export type ClipMap = ReadonlyMap<string, THREE.AnimationClip>;

export interface CamperBuddyAnimatorDiagnostics {
  state: LocoState;
  /** Effective weight per clip name. */
  weights: Record<string, number>;
  /** timeScale of the current state's action. */
  timeScale: number;
  totalWeight: number;
  frozen: boolean;
}

const STATES: readonly LocoState[] = ['Idle', 'Walk', 'Run', 'JumpStart', 'JumpAir', 'Land', 'Interact'];
const LOOPING: ReadonlySet<LocoState> = new Set<LocoState>(['Idle', 'Walk', 'Run', 'JumpAir']);
/** Used when a clip is missing from the asset (validation should prevent this). */
const FALLBACK: Readonly<Record<LocoState, LocoState | null>> = {
  Idle: null,
  Walk: 'Idle',
  Run: 'Walk',
  JumpStart: 'JumpAir',
  JumpAir: 'Idle',
  Land: 'Idle',
  Interact: 'Idle',
};
const EPS = 1e-6;

interface Slot {
  name: string;
  action: THREE.AnimationAction;
  duration: number;
  weight: number;
  playing: boolean;
}

export class CamperBuddyAnimator {
  readonly mixer: THREE.AnimationMixer;
  private readonly root: THREE.Object3D;
  private readonly sm = new LocomotionStateMachine();
  private readonly slots: Slot[] = [];
  /** State → index into `slots` (after fallback resolution). */
  private readonly stateSlot = new Map<LocoState, number>();
  private target = 0;
  private fade = 0.18;
  private frozen = false;
  private disposed = false;

  constructor(root: THREE.Object3D, clips: ClipMap | readonly THREE.AnimationClip[]) {
    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);

    const byName = new Map<string, THREE.AnimationClip>();
    if (clips instanceof Map || (!Array.isArray(clips) && typeof (clips as ClipMap).get === 'function')) {
      for (const [k, c] of clips as ClipMap) byName.set(k, c);
    } else {
      for (const c of clips as readonly THREE.AnimationClip[]) byName.set(c.name, c);
    }

    const clipSlot = new Map<string, number>();
    for (const st of STATES) {
      const clip = byName.get(st);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      if (LOOPING.has(st)) {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      } else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      action.setEffectiveWeight(0);
      clipSlot.set(st, this.slots.length);
      this.slots.push({ name: st, action, duration: Math.max(clip.duration, EPS), weight: 0, playing: false });
    }
    for (const st of STATES) {
      let s: LocoState | null = st;
      while (s && !clipSlot.has(s)) s = FALLBACK[s];
      if (s) this.stateSlot.set(st, clipSlot.get(s)!);
    }
    if (!this.stateSlot.has('Idle')) {
      // Any clip at all keeps the character posed; otherwise this asset is unusable.
      if (this.slots.length === 0) throw new Error('CamperBuddyAnimator: no usable clips');
      for (const st of STATES) if (!this.stateSlot.has(st)) this.stateSlot.set(st, 0);
    }

    this.resetToIdle();
  }

  get state(): LocoState {
    return this.sm.state;
  }

  update(dt: number, input: LocoInput): void {
    if (this.disposed || this.frozen) return;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;

    const out = this.sm.update(dt, input);
    if (out.changed) this.enter(out.state, out.fade);

    this.advanceWeights(dt);
    this.applyTimeScales(out.timeScale);
    this.mixer.update(dt);
  }

  /** Request the one-shot Interact (honoured only when grounded, alive and ~stationary). */
  playInteract(): void {
    this.sm.requestInteract();
  }

  /** Death: stop advancing the mixer; the current pose is held until resetToIdle(). */
  freeze(): void {
    this.frozen = true;
  }

  /** Respawn / pooled reuse: hard cut to Idle at weight 1. */
  resetToIdle(): void {
    if (this.disposed) return;
    this.frozen = false;
    this.sm.reset();
    this.mixer.stopAllAction();
    for (const s of this.slots) {
      s.weight = 0;
      s.playing = false;
      s.action.setEffectiveWeight(0);
      s.action.timeScale = 1;
    }
    const idle = this.stateSlot.get('Idle')!;
    const slot = this.slots[idle];
    slot.weight = 1;
    slot.action.reset();
    slot.action.setEffectiveWeight(1);
    slot.action.play();
    slot.playing = true;
    this.target = idle;
    this.fade = 0.18;
    this.mixer.update(0); // pose immediately: never render the bind pose
  }

  getDiagnostics(): CamperBuddyAnimatorDiagnostics {
    const weights: Record<string, number> = {};
    let total = 0;
    for (const s of this.slots) {
      const w = s.playing ? s.action.getEffectiveWeight() : 0;
      weights[s.name] = w;
      total += w;
    }
    return {
      state: this.sm.state,
      weights,
      timeScale: this.slots[this.target]?.action.timeScale ?? 1,
      totalWeight: total,
      frozen: this.frozen,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }

  // ---------------------------------------------------------------------------------------------

  private enter(state: LocoState, fade: number): void {
    const idx = this.stateSlot.get(state)!;
    const prev = this.target;
    const slot = this.slots[idx];
    this.fade = Math.max(fade, 0.01);

    const isLoop = LOOPING.has(slot.name as LocoState);
    if (!isLoop) {
      // One-shots always restart from frame 0.
      slot.action.reset();
    } else if (!slot.playing || slot.weight <= EPS) {
      slot.action.reset();
    }

    // Walk↔Run: start the incoming cycle at the outgoing cycle's normalized phase.
    const src = this.slots[prev];
    if (
      idx !== prev &&
      src.playing &&
      ((slot.name === 'Walk' && src.name === 'Run') || (slot.name === 'Run' && src.name === 'Walk'))
    ) {
      const phase = (((src.action.time / src.duration) % 1) + 1) % 1;
      slot.action.time = phase * slot.duration;
    }

    if (!slot.playing) {
      slot.action.play();
      slot.playing = true;
    }
    slot.action.enabled = true;
    this.target = idx;
  }

  private advanceWeights(dt: number): void {
    const tgt = this.slots[this.target];
    tgt.weight = Math.min(1, tgt.weight + (this.fade > 0 ? dt / this.fade : 1));

    let others = 0;
    for (let i = 0; i < this.slots.length; i++) if (i !== this.target) others += this.slots[i].weight;
    if (others <= EPS) {
      tgt.weight = 1;
      for (let i = 0; i < this.slots.length; i++) if (i !== this.target) this.slots[i].weight = 0;
    } else {
      const k = (1 - tgt.weight) / others;
      for (let i = 0; i < this.slots.length; i++) if (i !== this.target) this.slots[i].weight *= k;
    }

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (i !== this.target && s.weight <= EPS) {
        s.weight = 0;
        if (s.playing) {
          s.action.setEffectiveWeight(0);
          s.action.stop();
          s.playing = false;
        }
        continue;
      }
      s.action.enabled = true;
      s.action.setEffectiveWeight(s.weight);
    }
  }

  private applyTimeScales(timeScale: number): void {
    const tgt = this.slots[this.target];
    tgt.action.timeScale = timeScale;
    // Keep an outgoing Walk/Run phase-locked to the incoming one while they blend.
    if (tgt.name === 'Walk' || tgt.name === 'Run') {
      const other = this.slots[this.stateSlot.get(tgt.name === 'Walk' ? 'Run' : 'Walk')!];
      if (other !== tgt && other.playing && (other.name === 'Walk' || other.name === 'Run')) {
        other.action.timeScale = (timeScale / tgt.duration) * other.duration;
      }
    }
  }
}
