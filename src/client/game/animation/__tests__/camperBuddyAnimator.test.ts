import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { CamperBuddyAnimator } from '../CamperBuddyAnimator';
import { LOCO_TUNING, type LocoInput, type LocoState } from '../locomotionState';

/** Widened read (assert.equal narrows `anim.state` to a literal for TS). */
const stateOf = (a: CamperBuddyAnimator): LocoState => a.state;
import {
  instantiateCamperBuddy,
  parseCharacterGlb,
  registerCharacterTemplateForTest,
  type CamperBuddyInstance,
} from '../../character/CharacterAssetRegistry';

// Stage 08B-CHAR-INTEGRATION — sub-agent D: CamperBuddyAnimator on the real GLB clips

const GLB_PATH = fileURLToPath(
  new URL('../../../../../public/models/characters/camper_buddy_balanced_rigged.glb', import.meta.url),
);
const DT = 1 / 60;

interface MixerInternals {
  _actions: THREE.AnimationAction[];
  _nActiveActions: number;
}

/** Σ effective weight over the mixer's *active* actions — independent of the animator's own bookkeeping. */
function mixerActiveWeight(mixer: THREE.AnimationMixer): number {
  const m = mixer as unknown as MixerInternals;
  let w = 0;
  for (let i = 0; i < m._nActiveActions; i++) {
    const a = m._actions[i];
    if (a.enabled) w += a.getEffectiveWeight();
  }
  return w;
}

function assertFramePosed(anim: CamperBuddyAnimator, inst: CamperBuddyInstance, label: string): void {
  const d = anim.getDiagnostics();
  assert.ok(Math.abs(d.totalWeight - 1) < 1e-4, `${label}: diag totalWeight ${d.totalWeight}`);
  const sum = Object.values(d.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-4, `${label}: Σweights ${sum}`);
  const mw = mixerActiveWeight(anim.mixer);
  assert.ok(Math.abs(mw - 1) < 1e-4, `${label}: mixer active weight ${mw} (T-pose blend if < 1)`);
  for (const w of Object.values(d.weights)) assert.ok(w >= -1e-9 && w <= 1 + 1e-9, `${label}: weight ${w}`);
  assert.ok(Number.isFinite(d.timeScale), `${label}: timeScale`);
  for (const b of inst.bones.values()) {
    const q = b.quaternion;
    assert.ok(
      Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w),
      `${label}: ${b.name} quaternion NaN`,
    );
    assert.ok(Math.abs(q.length() - 1) < 1e-3, `${label}: ${b.name} |q|=${q.length()}`);
    assert.ok(b.position.toArray().every(Number.isFinite), `${label}: ${b.name} position`);
  }
}

function poseOf(inst: CamperBuddyInstance): number[] {
  const out: number[] = [];
  for (const b of inst.bones.values()) out.push(...b.quaternion.toArray(), ...b.position.toArray());
  return out;
}

function maxDiff(a: number[], b: number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function phaseOf(anim: CamperBuddyAnimator, inst: CamperBuddyInstance, name: 'Walk' | 'Run'): number {
  const clip = inst.clips.get(name)!;
  const a = anim.mixer.existingAction(clip)!;
  return (((a.time / clip.duration) % 1) + 1) % 1;
}

const ground = (speed: number): LocoInput => ({ speed, onGround: true, alive: true });

let bindPose: number[] = [];

describe('BOSQICH 08B-CHAR — CamperBuddyAnimator (haqiqiy GLB clip’lari)', () => {
  before(async () => {
    const buf = readFileSync(GLB_PATH);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    registerCharacterTemplateForTest(await parseCharacterGlb(ab));
    const probe = instantiateCamperBuddy()!;
    bindPose = poseOf(probe);
    probe.dispose();
  });
  after(() => registerCharacterTemplateForTest(null));

  function make(): { inst: CamperBuddyInstance; anim: CamperBuddyAnimator } {
    const inst = instantiateCamperBuddy();
    assert.ok(inst);
    return { inst: inst!, anim: new CamperBuddyAnimator(inst!.root, inst!.clips) };
  }

  it('1. Konstruktor: darhol Idle weight=1, bind pose emas (birinchi kadrdan T-pose yo‘q)', () => {
    const { inst, anim } = make();
    const d = anim.getDiagnostics();
    assert.equal(d.state, 'Idle');
    assert.equal(d.weights.Idle, 1);
    assert.equal(d.frozen, false);
    assert.deepEqual(Object.keys(d.weights).sort(), ['Idle', 'Interact', 'JumpAir', 'JumpStart', 'Land', 'Run', 'Walk']);
    assertFramePosed(anim, inst, 'ctor');
    assert.ok(maxDiff(poseOf(inst), bindPose) > 1e-3, 'Idle pose qo‘llanilgan bo‘lishi kerak (bind pose emas)');
    // Array-of-clips constructor form works too
    const inst2 = instantiateCamperBuddy()!;
    const anim2 = new CamperBuddyAnimator(inst2.root, [...inst2.clips.values()]);
    assert.equal(anim2.getDiagnostics().weights.Idle, 1);
    anim.dispose();
    anim2.dispose();
    inst.dispose();
    inst2.dispose();
  });

  it('2. To‘liq ssenariy (idle→walk→run→sakrash→land→interact→flicker→shovqin): HAR KADRDA Σweight≈1, NaN yo‘q', () => {
    const { inst, anim } = make();
    type Step = [frames: number, input: (f: number) => LocoInput, extra?: () => void];
    const steps: Step[] = [
      [30, () => ground(0)],
      [60, () => ground(3)],
      [60, () => ground(6.5)],
      [42, () => ({ speed: 6.5, onGround: false, alive: true })],
      [40, () => ground(6.5)],
      [30, () => ground(0)],
      [1, () => ground(0), () => anim.playInteract()],
      [20, () => ground(0)],
      [30, () => ground(3)], // cancel Interact mid-fade
      [5, () => ground(0)],
      [60, (f) => ground(f % 2 ? 0 : 6.5)], // adversarial square
      [60, (f) => ({ speed: 3, onGround: f % 5 !== 0, alive: true })],
      [12, () => ({ speed: 0, onGround: false, alive: true })], // short hop
      [3, () => ground(0)],
      [40, () => ({ speed: 0, onGround: false, alive: true })], // re-jump during fades
      [2, () => ground(0)],
      [10, () => ({ speed: 0, onGround: false, alive: true })], // jump out of Land
      [60, () => ground(4.6)],
      [60, (f) => ground([NaN, Infinity, -3, 6.5][f % 4])],
    ];
    const seen = new Set<string>();
    let frame = 0;
    for (const [n, input, extra] of steps) {
      extra?.();
      for (let f = 0; f < n; f++, frame++) {
        anim.update(DT, input(f));
        seen.add(anim.state);
        assertFramePosed(anim, inst, `frame ${frame} (${anim.state})`);
      }
    }
    for (const s of ['Idle', 'Walk', 'Run', 'JumpStart', 'JumpAir', 'Land', 'Interact']) {
      assert.ok(seen.has(s), `ssenariy ${s} holatini qamrashi kerak`);
    }
    anim.dispose();
    inst.dispose();
  });

  it('3. timeScale: Run @6.5 ≈1, Walk @3.0 ≈1; clamp (30 m/s → 1.35, 0.8 m/s → 0.55)', () => {
    const cases: Array<[number, string, number]> = [
      [6.5, 'Run', 1],
      [3.0, 'Walk', 1],
      [30, 'Run', LOCO_TUNING.RUN_TIMESCALE_MAX],
      [0.8, 'Walk', LOCO_TUNING.WALK_TIMESCALE_MIN],
    ];
    for (const [speed, state, ts] of cases) {
      const { inst, anim } = make();
      for (let i = 0; i < 90; i++) anim.update(DT, ground(speed));
      const d = anim.getDiagnostics();
      assert.equal(d.state, state);
      assert.ok(Math.abs(d.timeScale - ts) < 0.01, `${speed} m/s: ts ${d.timeScale}`);
      const action = anim.mixer.existingAction(inst.clips.get(state as 'Run')!)!;
      assert.ok(Math.abs(action.timeScale - ts) < 0.01, 'action.timeScale applied');
      assert.equal(d.weights[state], 1);
      anim.dispose();
      inst.dispose();
    }
  });

  it('4. Walk↔Run o‘tishi: normallashtirilgan faza ko‘chiriladi va blend davomida qulflangan (|Δphase| < 0.01)', () => {
    const { inst, anim } = make();
    for (let i = 0; i < 47; i++) anim.update(DT, ground(3));
    assert.equal(anim.state, 'Walk');
    let blendFrames = 0;
    let switched = false;
    for (let i = 0; i < 60; i++) {
      anim.update(DT, ground(6.5));
      if (stateOf(anim) === 'Run') switched = true;
      const d = anim.getDiagnostics();
      if (switched && d.weights.Walk > 0 && d.weights.Run > 0) {
        blendFrames++;
        const dp = Math.abs(phaseOf(anim, inst, 'Walk') - phaseOf(anim, inst, 'Run'));
        assert.ok(Math.min(dp, 1 - dp) < 0.01, `Walk→Run phase drift ${dp.toFixed(4)}`);
      }
    }
    assert.ok(switched && blendFrames >= 3, `blend frames ${blendFrames}`);

    blendFrames = 0;
    switched = false;
    for (let i = 0; i < 60; i++) {
      anim.update(DT, ground(3));
      if (stateOf(anim) === 'Walk') switched = true;
      const d = anim.getDiagnostics();
      if (switched && d.weights.Walk > 0 && d.weights.Run > 0) {
        blendFrames++;
        const dp = Math.abs(phaseOf(anim, inst, 'Walk') - phaseOf(anim, inst, 'Run'));
        assert.ok(Math.min(dp, 1 - dp) < 0.01, `Run→Walk phase drift ${dp.toFixed(4)}`);
      }
    }
    assert.ok(switched && blendFrames >= 3, `blend frames ${blendFrames}`);
    anim.dispose();
    inst.dispose();
  });

  it('5. Bir martalik clip’lar (JumpStart/Land/Interact) qayta kirishda 0-kadrdan boshlanadi', () => {
    const { inst, anim } = make();
    for (let i = 0; i < 20; i++) anim.update(DT, ground(0));
    for (let round = 0; round < 3; round++) {
      anim.playInteract();
      anim.update(DT, ground(0));
      assert.equal(anim.state, 'Interact');
      const a = anim.mixer.existingAction(inst.clips.get('Interact')!)!;
      assert.ok(a.time <= DT + 1e-6, `round ${round}: Interact restarted at ${a.time}`);
      for (let i = 0; i < 90; i++) anim.update(DT, ground(0));
      assert.equal(anim.state, 'Idle');
    }
    anim.dispose();
    inst.dispose();
  });

  it('6. freeze(): mixer to‘xtaydi, poza ushlanadi; resetToIdle() → Idle w=1, frozen=false', () => {
    const { inst, anim } = make();
    for (let i = 0; i < 30; i++) anim.update(DT, ground(6.5));
    anim.freeze();
    const held = poseOf(inst);
    const stateHeld = anim.state;
    for (let i = 0; i < 60; i++) anim.update(DT, { speed: 0, onGround: false, alive: false });
    assert.equal(maxDiff(poseOf(inst), held), 0, 'frozen pose must not move');
    assert.equal(anim.state, stateHeld);
    assert.equal(anim.getDiagnostics().frozen, true);
    assert.ok(Math.abs(anim.getDiagnostics().totalWeight - 1) < 1e-4);

    anim.resetToIdle();
    const d = anim.getDiagnostics();
    assert.equal(d.state, 'Idle');
    assert.equal(d.frozen, false);
    assert.equal(d.weights.Idle, 1);
    assert.equal(d.weights.Run, 0);
    assertFramePosed(anim, inst, 'after reset');
    for (let i = 0; i < 30; i++) {
      anim.update(DT, ground(0));
      assertFramePosed(anim, inst, `post-reset ${i}`);
    }
    assert.equal(anim.state, 'Idle', 'reset’dan keyin Land/Run emas');
    anim.dispose();
    inst.dispose();
  });

  it('7. O‘lim sakrash o‘rtasida → freeze → resetToIdle → normal davom etadi', () => {
    const { inst, anim } = make();
    for (let i = 0; i < 20; i++) anim.update(DT, ground(3));
    for (let i = 0; i < 30; i++) anim.update(DT, { speed: 3, onGround: false, alive: true });
    assert.equal(anim.state, 'JumpAir');
    anim.update(DT, { speed: 3, onGround: false, alive: false });
    anim.freeze();
    for (let i = 0; i < 10; i++) anim.update(DT, { speed: 0, onGround: true, alive: false });
    anim.resetToIdle();
    for (let i = 0; i < 60; i++) {
      anim.update(DT, ground(6.5));
      assertFramePosed(anim, inst, `respawn ${i}`);
    }
    assert.equal(anim.state, 'Run');
    anim.dispose();
    inst.dispose();
  });

  it('8. Ulkan / noto‘g‘ri dt (1e6, NaN, Infinity, -1, 0) → NaN yo‘q, Σweight≈1', () => {
    const { inst, anim } = make();
    const dts = [1e6, NaN, Infinity, -Infinity, -1, 0, 0, 1e-9, 5, DT];
    const inputs: LocoInput[] = [ground(6.5), ground(0), { speed: 3, onGround: false, alive: true }, ground(3)];
    for (let i = 0; i < 200; i++) {
      anim.update(dts[i % dts.length], inputs[Math.floor(i / 7) % inputs.length]);
      assertFramePosed(anim, inst, `dt ${dts[i % dts.length]} #${i}`);
    }
    // dt=0 must not advance pose
    const p = poseOf(inst);
    const st = anim.state;
    for (let i = 0; i < 10; i++) anim.update(0, ground(9));
    assert.equal(anim.state, st);
    assert.ok(maxDiff(poseOf(inst), p) < 1e-6, 'dt=0 pozani o‘zgartirmasligi kerak');
    anim.dispose();
    inst.dispose();
  });

  it('9. Ikkita animator bir-biriga ta’sir qilmaydi (alohida mixer/suyaklar)', () => {
    const a = make();
    const b = make();
    const bPose0 = poseOf(b.inst);
    for (let i = 0; i < 60; i++) a.anim.update(DT, ground(6.5));
    assert.equal(maxDiff(poseOf(b.inst), bPose0), 0);
    assert.equal(b.anim.state, 'Idle');
    assert.notEqual(a.anim.mixer, b.anim.mixer);
    for (const x of [a, b]) {
      x.anim.dispose();
      x.inst.dispose();
    }
  });

  it('10. dispose(): idempotent, keyin update/playInteract/resetToIdle xato bermaydi va mixer kesh bo‘sh', () => {
    const { inst, anim } = make();
    for (let i = 0; i < 20; i++) anim.update(DT, ground(3));
    anim.dispose();
    anim.dispose();
    assert.doesNotThrow(() => {
      anim.update(DT, ground(6.5));
      anim.playInteract();
      anim.resetToIdle();
      anim.freeze();
      anim.getDiagnostics();
    });
    assert.equal(anim.mixer.stats.actions.total, 0);
    assert.equal(anim.mixer.stats.bindings.total, 0);
    inst.dispose();
  });
});
