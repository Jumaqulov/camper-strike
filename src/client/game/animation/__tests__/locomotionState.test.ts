import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCO_TUNING,
  LocomotionStateMachine,
  RUN_NATURAL_SPEED,
  WALK_NATURAL_SPEED,
  locomotionTimeScale,
  type LocoInput,
  type LocoOutput,
  type LocoState,
} from '../locomotionState';

// Stage 08B-CHAR-INTEGRATION — sub-agent D: adversarial tests for the pure locomotion state machine

const DT = 1 / 60;
const VALID: ReadonlySet<LocoState> = new Set(['Idle', 'Walk', 'Run', 'JumpStart', 'JumpAir', 'Land', 'Interact']);
const FADES = new Set<number>([
  LOCO_TUNING.FADE_LOCOMOTION,
  LOCO_TUNING.FADE_JUMP_START,
  LOCO_TUNING.FADE_JUMP_AIR,
  LOCO_TUNING.FADE_LAND,
  LOCO_TUNING.FADE_INTERACT,
]);

interface Trace {
  states: LocoState[];
  transitions: Array<{ frame: number; to: LocoState }>;
}

/** Runs `frames` updates, checks per-frame output invariants, returns state trace. */
function run(
  sm: LocomotionStateMachine,
  frames: number,
  input: (f: number) => LocoInput,
  dt: number | ((f: number) => number) = DT,
): Trace {
  const states: LocoState[] = [];
  const transitions: Trace['transitions'] = [];
  let prev = sm.state;
  for (let f = 0; f < frames; f++) {
    const d = typeof dt === 'function' ? dt(f) : dt;
    const inp = input(f);
    prev = sm.state; // input() may call reset() (fuzz)
    const out = sm.update(d, inp);
    checkOutput(out, prev);
    if (out.changed) transitions.push({ frame: f, to: out.state });
    prev = out.state;
    states.push(out.state);
  }
  return { states, transitions };
}

function checkOutput(out: LocoOutput, prev: LocoState): void {
  assert.ok(VALID.has(out.state), `invalid state ${out.state}`);
  assert.ok(Number.isFinite(out.timeScale), `timeScale finite: ${out.timeScale}`);
  assert.ok(out.timeScale >= LOCO_TUNING.WALK_TIMESCALE_MIN - 1e-9, `timeScale ≥ min: ${out.timeScale}`);
  assert.ok(out.timeScale <= LOCO_TUNING.WALK_TIMESCALE_MAX + 1e-9, `timeScale ≤ max: ${out.timeScale}`);
  assert.ok(FADES.has(out.fade), `fade ${out.fade}`);
  assert.equal(out.changed, out.state !== prev, 'changed ⇔ state differs from previous frame');
}

const ground = (speed: number): LocoInput => ({ speed, onGround: true, alive: true });

describe('BOSQICH 08B-CHAR — LocomotionStateMachine asosiy oqim', () => {
  it('1. Boshlang‘ich holat Idle; birinchi namuna snap qiladi (mid-run spawn → darhol Run)', () => {
    const sm = new LocomotionStateMachine();
    assert.equal(sm.state, 'Idle');
    const out = sm.update(DT, ground(6.5));
    assert.equal(out.state, 'Run');
    assert.equal(out.changed, true);
    assert.equal(sm.smoothedSpeed, 6.5);
    const sm2 = new LocomotionStateMachine();
    assert.equal(sm2.update(DT, ground(3)).state, 'Walk');
    const sm3 = new LocomotionStateMachine();
    const o3 = sm3.update(DT, ground(0));
    assert.equal(o3.state, 'Idle');
    assert.equal(o3.changed, false);
  });

  it('2. Idle → Walk → Run → Walk → Idle tezlanish/sekinlashish, har biri bir marta', () => {
    const sm = new LocomotionStateMachine();
    const seq = [0, 3, 6.5, 3, 0];
    const t = run(sm, seq.length * 60, (f) => ground(seq[Math.floor(f / 60)]));
    assert.deepEqual(
      t.transitions.map((x) => x.to),
      ['Walk', 'Run', 'Walk', 'Idle'],
    );
  });

  it('3. timeScale: Run≈1 @6.5 m/s, Walk≈1 @3.0 m/s; clamp chegaralari hurmat qilinadi', () => {
    const sm = new LocomotionStateMachine();
    run(sm, 120, () => ground(6.5));
    const r = sm.update(DT, ground(6.5));
    assert.equal(r.state, 'Run');
    assert.ok(Math.abs(r.timeScale - 1) < 0.01, `Run ts ${r.timeScale}`);
    assert.ok(Math.abs(r.timeScale - 6.5 / RUN_NATURAL_SPEED) < 1e-6);

    const sw = new LocomotionStateMachine();
    run(sw, 120, () => ground(3.0));
    const w = sw.update(DT, ground(3.0));
    assert.equal(w.state, 'Walk');
    assert.ok(Math.abs(w.timeScale - 1) < 0.01, `Walk ts ${w.timeScale}`);
    assert.ok(Math.abs(w.timeScale - 3.0 / WALK_NATURAL_SPEED) < 1e-6);

    // Pure clamp function
    const T = LOCO_TUNING;
    assert.equal(locomotionTimeScale('Walk', 100), T.WALK_TIMESCALE_MAX);
    assert.equal(locomotionTimeScale('Walk', 0.01), T.WALK_TIMESCALE_MIN);
    assert.equal(locomotionTimeScale('Run', 100), T.RUN_TIMESCALE_MAX);
    assert.equal(locomotionTimeScale('Run', 0.5), T.RUN_TIMESCALE_MIN);
    for (const st of ['Idle', 'JumpStart', 'JumpAir', 'Land', 'Interact'] as const) {
      assert.equal(locomotionTimeScale(st, 50), 1, `${st} ts=1`);
    }

    // In-machine clamps: speed-hack 30 m/s run, slow 0.8 m/s walk
    const sf = new LocomotionStateMachine();
    run(sf, 60, () => ground(30));
    assert.equal(sf.update(DT, ground(30)).timeScale, T.RUN_TIMESCALE_MAX);
    const ss = new LocomotionStateMachine();
    run(ss, 60, () => ground(0.8));
    const slow = ss.update(DT, ground(0.8));
    assert.equal(slow.state, 'Walk');
    assert.equal(slow.timeScale, T.WALK_TIMESCALE_MIN);
  });

  it('4. Sakrash: JumpStart (0.4s) → JumpAir → Land (uzoq havo) → Idle; qisqa sakrash Land’siz', () => {
    const sm = new LocomotionStateMachine();
    run(sm, 30, () => ground(0));
    // 0.69 s in the air
    const t = run(sm, 41 + 60, (f) => ({ speed: 0, onGround: f >= 41, alive: true }));
    assert.deepEqual(
      t.transitions.map((x) => x.to),
      ['JumpStart', 'JumpAir', 'Land', 'Idle'],
    );
    // JumpStart lasts ≈ 0.4 s
    const js = t.transitions[0].frame;
    const ja = t.transitions[1].frame;
    assert.ok(Math.abs((ja - js) * DT - 0.4) < 2 * DT, `JumpStart dur ${(ja - js) * DT}`);

    // Short hop (0.15 s air) → JumpStart then straight back to locomotion, no Land
    const sh = new LocomotionStateMachine();
    run(sh, 30, () => ground(3));
    const h = run(sh, 9 + 30, (f) => ({ speed: 3, onGround: f >= 9, alive: true }));
    assert.deepEqual(
      h.transitions.map((x) => x.to),
      ['JumpStart', 'Walk'],
    );
  });
});

describe('BOSQICH 08B-CHAR — Adversarial kirishlar (shovqin, flicker, NaN, dt)', () => {
  it('5. Remote shovqinli tezlik (2.4/3.6 almashinuvi, 5 s) → doim Walk, 0 ta qo‘shimcha o‘tish', () => {
    const sm = new LocomotionStateMachine();
    const t = run(sm, 300, (f) => ground(f % 2 ? 2.4 : 3.6));
    assert.equal(t.transitions.length, 1, JSON.stringify(t.transitions));
    assert.ok(t.states.slice(1).every((s) => s === 'Walk'));
  });

  it('6. Turgan remote 0/0.6 almashinuvi → Idle’da qoladi (moon-walk yo‘q)', () => {
    const sm = new LocomotionStateMachine();
    const t = run(sm, 600, (f) => ground(f % 2 ? 0.6 : 0));
    assert.ok(t.states.slice(30).every((s) => s === 'Idle'), `transitions: ${JSON.stringify(t.transitions)}`);
    // Start the other way around (primed at 0.6) — must also settle to Idle
    const sm2 = new LocomotionStateMachine();
    const t2 = run(sm2, 600, (f) => ground(f % 2 ? 0 : 0.6));
    assert.ok(t2.transitions.length <= 2, JSON.stringify(t2.transitions));
    assert.equal(t2.states[t2.states.length - 1], 'Idle');
  });

  it('7. Walk/Run chegarasidagi shovqin (4.0/5.2, o‘rtacha 4.6) va tushib qolgan snapshotlar (6.5,6.5,6.5,0) → thrash yo‘q', () => {
    for (const start of ['Walk', 'Run'] as const) {
      const sm = new LocomotionStateMachine();
      run(sm, 60, () => ground(start === 'Walk' ? 3 : 6.5));
      assert.equal(sm.state, start);
      const t = run(sm, 600, (f) => ground(f % 2 ? 4.0 : 5.2));
      assert.ok(t.transitions.length <= 1, `${start}: ${JSON.stringify(t.transitions)}`);
      const tail = t.states.slice(60);
      assert.ok(tail.every((s) => s === tail[0]), `${start}: settled`);
    }
    const sd = new LocomotionStateMachine();
    const td = run(sd, 600, (f) => ground(f % 4 === 3 ? 0 : 6.5));
    assert.equal(td.transitions.length, 1, JSON.stringify(td.transitions));
    assert.ok(td.states.every((s) => s === 'Run'));
  });

  it('8. Kvadrat to‘lqin 0↔6.5 har xil davrlarda: o‘tishlar MIN_DWELL bilan cheklangan (≤ 1/MIN_DWELL + 1 /s)', () => {
    for (const period of [2, 4, 6, 10, 18, 30]) {
      const sm = new LocomotionStateMachine();
      const frames = 600; // 10 s
      const t = run(sm, frames, (f) => ground(Math.floor(f / period) % 2 ? 0 : 6.5));
      const perSec = t.transitions.length / (frames * DT);
      assert.ok(perSec <= 1 / LOCO_TUNING.MIN_DWELL + 1, `period ${period}: ${perSec.toFixed(2)} /s`);
      for (let i = 1; i < t.transitions.length; i++) {
        const gap = (t.transitions[i].frame - t.transitions[i - 1].frame) * DT;
        assert.ok(gap >= LOCO_TUNING.MIN_DWELL - 1e-9, `period ${period}: dwell ${gap.toFixed(3)} s`);
      }
    }
  });

  it('9. onGround flicker (har 10 kadrda 1–4 kadr false, 60 Hz) → hech qachon JumpStart emas', () => {
    for (const flick of [1, 2, 3, 4]) {
      for (const speed of [0, 3, 6.5]) {
        const sm = new LocomotionStateMachine();
        const t = run(sm, 600, (f) => ({ speed, onGround: f % 10 >= flick, alive: true }));
        assert.ok(
          !t.states.includes('JumpStart') && !t.states.includes('JumpAir') && !t.states.includes('Land'),
          `flick ${flick} speed ${speed}: ${JSON.stringify(t.transitions)}`,
        );
        assert.ok(t.transitions.length <= 1);
      }
    }
    // 30 Hz: 2 frames of air (0.067 s) still under the coyote window
    const s30 = new LocomotionStateMachine();
    const t30 = run(s30, 300, (f) => ({ speed: 3, onGround: f % 8 >= 2, alive: true }), 1 / 30);
    assert.ok(!t30.states.includes('JumpStart'));
  });

  it('10. NaN / ±Infinity / manfiy tezlik: NaN,±Inf → 0, manfiy → |v|; smoothedSpeed doim chekli', () => {
    const sm = new LocomotionStateMachine();
    const bad = [NaN, Infinity, -Infinity, -3, Number.MAX_VALUE, -Number.MAX_VALUE, 1e308, -0];
    const t = run(sm, 400, (f) => ground(bad[f % bad.length]));
    assert.ok(t.states.every((s) => VALID.has(s)));
    assert.ok(Number.isFinite(sm.smoothedSpeed), `smoothed ${sm.smoothedSpeed}`);

    const sn = new LocomotionStateMachine();
    run(sn, 120, () => ground(NaN));
    assert.equal(sn.state, 'Idle');
    assert.equal(sn.smoothedSpeed, 0);

    const si = new LocomotionStateMachine();
    run(si, 120, () => ground(Infinity));
    assert.equal(si.state, 'Idle', 'Infinity → 0 m/s');

    const neg = new LocomotionStateMachine();
    run(neg, 120, () => ground(-6.5));
    assert.equal(neg.state, 'Run', 'manfiy tezlik abs qilinadi');
    const negOut = neg.update(DT, ground(-6.5));
    assert.ok(negOut.timeScale > 0.99 && negOut.timeScale < 1.01);
  });

  it('11. Ulkan dt (1e9, Infinity, NaN, manfiy) holatlarni sakrab o‘tmaydi: har update’da ≤1 o‘tish, MAX_DT clamp', () => {
    const sm = new LocomotionStateMachine();
    sm.update(DT, ground(0));
    const seq: LocoState[] = [];
    // jump with huge dt
    for (const onGround of [false, false, false, false, true, true, true, true]) {
      const out = sm.update(1e9, { speed: 0, onGround, alive: true });
      seq.push(out.state);
    }
    assert.deepEqual(seq.slice(0, 4), ['JumpStart', 'JumpStart', 'JumpAir', 'JumpAir']);
    assert.equal(seq[4], 'Land');
    assert.ok(seq.includes('Idle'), `Land tugashi kerak: ${seq.join(',')}`);

    // Speed smoothing with huge dt converges but stays finite
    const s2 = new LocomotionStateMachine();
    s2.update(DT, ground(0));
    const o = s2.update(1e9, ground(6.5));
    assert.ok(Number.isFinite(s2.smoothedSpeed) && s2.smoothedSpeed <= 6.5);
    assert.ok(VALID.has(o.state));

    // Non-finite / negative dt behave like dt=0
    for (const d of [Infinity, -Infinity, NaN, -1, -1e9]) {
      const s3 = new LocomotionStateMachine();
      s3.update(DT, ground(0));
      const t = run(s3, 50, () => ({ speed: 6.5, onGround: false, alive: true }), d);
      assert.equal(t.transitions.length, 0, `dt=${d}: ${JSON.stringify(t.transitions)}`);
      assert.equal(s3.smoothedSpeed, 0);
    }
  });

  it('12. dt=0: tezlik silliqlanmaydi, havo vaqti yig‘ilmaydi → hech qanday o‘tish yo‘q', () => {
    const sm = new LocomotionStateMachine();
    sm.update(0, ground(0)); // priming frame
    const t = run(sm, 1000, (f) => ({ speed: f % 2 ? 6.5 : 30, onGround: f % 3 !== 0, alive: true }), 0);
    assert.equal(t.transitions.length, 0);
    assert.equal(sm.state, 'Idle');
    assert.equal(sm.smoothedSpeed, 0);
    // Interact still honoured at dt=0 (stationary) and held
    sm.requestInteract();
    const o = sm.update(0, ground(0));
    assert.equal(o.state, 'Interact');
    run(sm, 100, () => ground(0), 0);
    assert.equal(sm.state, 'Interact', 'dt=0 da Interact tugamaydi');
  });

  it('13. Sakrash o‘rtasida o‘lim → holat muzlaydi; reset() → Idle, keyingi update Land emas', () => {
    const sm = new LocomotionStateMachine();
    run(sm, 30, () => ground(6.5));
    run(sm, 40, () => ({ speed: 6.5, onGround: false, alive: true }));
    assert.equal(sm.state, 'JumpAir');
    const dead = run(sm, 120, (f) => ({ speed: f % 2 ? 0 : 9, onGround: f % 3 === 0, alive: false }));
    assert.equal(dead.transitions.length, 0, 'o‘lik paytda o‘tish yo‘q');
    assert.ok(dead.states.every((s) => s === 'JumpAir'));
    const deadOut = sm.update(DT, { speed: 0, onGround: true, alive: false });
    assert.equal(deadOut.changed, false);

    sm.requestInteract(); // queued while dead…
    sm.update(DT, { speed: 0, onGround: true, alive: false }); // …and dropped by the dead update
    sm.reset();
    assert.equal(sm.state, 'Idle');
    assert.equal(sm.smoothedSpeed, 0);
    const o = sm.update(DT, ground(0));
    assert.equal(o.state, 'Idle', 'respawn Idle (Land emas, Interact emas)');
    const t = run(sm, 120, () => ground(0));
    assert.equal(t.transitions.length, 0);

    // reset() without a following death also clears a pending Interact and air time
    const s2 = new LocomotionStateMachine();
    run(s2, 10, () => ground(0));
    run(s2, 3, () => ({ speed: 0, onGround: false, alive: true }));
    s2.requestInteract();
    s2.reset();
    const o2 = s2.update(DT, { speed: 0, onGround: false, alive: true });
    assert.equal(o2.state, 'Idle', 'airTime reset’da tozalanadi');
    assert.equal(s2.update(DT, ground(0)).state, 'Idle', 'Interact so‘rovi reset’da tozalanadi');

    // Revive WITHOUT reset while state was JumpAir and grounded → resolves within bounded frames
    const s3 = new LocomotionStateMachine();
    run(s3, 10, () => ground(0));
    run(s3, 40, () => ({ speed: 0, onGround: false, alive: true }));
    run(s3, 10, () => ({ speed: 0, onGround: true, alive: false }));
    const rv = run(s3, 60, () => ground(0));
    assert.equal(rv.states[rv.states.length - 1], 'Idle');
    assert.ok(rv.transitions.length <= 2);
  });

  it('14. Interact so‘rovi: harakatda / havoda / o‘likda e’tiborsiz va bir martalik; turganda 1.2 s ijro', () => {
    // moving
    const sm = new LocomotionStateMachine();
    run(sm, 60, () => ground(3));
    sm.requestInteract();
    assert.equal(sm.update(DT, ground(3)).state, 'Walk');
    run(sm, 60, () => ground(0));
    assert.equal(sm.state, 'Idle', 'iste’mol qilingan so‘rov keyin ishga tushmasligi kerak');

    // running
    const sr = new LocomotionStateMachine();
    run(sr, 60, () => ground(6.5));
    sr.requestInteract();
    assert.equal(sr.update(DT, ground(6.5)).state, 'Run');

    // airborne
    const sa = new LocomotionStateMachine();
    run(sa, 30, () => ground(0));
    run(sa, 20, () => ({ speed: 0, onGround: false, alive: true }));
    const airState = sa.state;
    sa.requestInteract();
    assert.equal(sa.update(DT, { speed: 0, onGround: false, alive: true }).state, airState);
    assert.ok(airState === 'JumpStart' || airState === 'JumpAir');
    // in coyote window (1 frame off-ground) — not grounded → refused
    const sc = new LocomotionStateMachine();
    run(sc, 30, () => ground(0));
    sc.requestInteract();
    assert.equal(sc.update(DT, { speed: 0, onGround: false, alive: true }).state, 'Idle');
    assert.equal(sc.update(DT, ground(0)).state, 'Idle');

    // dead
    const sd = new LocomotionStateMachine();
    run(sd, 30, () => ground(0));
    sd.requestInteract();
    assert.equal(sd.update(DT, { speed: 0, onGround: true, alive: false }).state, 'Idle');
    assert.equal(sd.update(DT, ground(0)).state, 'Idle', 'o‘likdagi so‘rov tirilgandan keyin bajarilmasligi shart');

    // stationary → Interact for ≈1.2 s then Idle
    const si = new LocomotionStateMachine();
    run(si, 30, () => ground(0));
    si.requestInteract();
    const t = run(si, 120, () => ground(0));
    assert.deepEqual(t.transitions.map((x) => x.to), ['Interact', 'Idle']);
    const dur = (t.transitions[1].frame - t.transitions[0].frame) * DT;
    assert.ok(Math.abs(dur - 1.2) < 2 * DT, `Interact dur ${dur}`);

    // Interact cancelled by moving, and by jumping
    const sx = new LocomotionStateMachine();
    run(sx, 30, () => ground(0));
    sx.requestInteract();
    sx.update(DT, ground(0));
    assert.equal(sx.state, 'Interact');
    const mv = run(sx, 30, () => ground(3));
    assert.equal(mv.transitions[0]?.to, 'Walk');
    const sj = new LocomotionStateMachine();
    run(sj, 30, () => ground(0));
    sj.requestInteract();
    sj.update(DT, ground(0));
    const jp = run(sj, 30, () => ({ speed: 0, onGround: false, alive: true }));
    assert.equal(jp.transitions[0]?.to, 'JumpStart');

    // Interact during Land (low speed) is allowed
    const sl = new LocomotionStateMachine();
    run(sl, 10, () => ground(0));
    run(sl, 40, () => ({ speed: 0, onGround: false, alive: true }));
    sl.update(DT, ground(0));
    assert.equal(sl.state, 'Land');
    sl.requestInteract();
    assert.equal(sl.update(DT, ground(0)).state, 'Interact');

    // Spamming requests every frame while standing: one Interact per 1.2 s cycle at most
    const sp = new LocomotionStateMachine();
    run(sp, 10, () => ground(0));
    const spam = run(sp, 600, () => {
      sp.requestInteract();
      return ground(0);
    });
    assert.ok(spam.transitions.length <= 2 * Math.ceil(10 / 1.2) + 2, `spam: ${spam.transitions.length}`);
  });

  it('15. Seed’langan fuzz (20 000 kadr): holat/timeScale/fade invariantlari, o‘tishlar chegaralangan', () => {
    let seed = 0x5eed1234;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const sm = new LocomotionStateMachine();
    let base = 0;
    let onGround = true;
    let alive = true;
    const t = run(
      sm,
      20000,
      (f) => {
        if (f % 90 === 0) base = [0, 0.5, 1.5, 3, 4.6, 6.5, 9][Math.floor(rnd() * 7)];
        if (rnd() < 0.01) onGround = !onGround;
        if (rnd() < 0.002) alive = !alive;
        if (rnd() < 0.005) sm.requestInteract();
        if (rnd() < 0.001) sm.reset();
        const noise = (rnd() - 0.5) * 1.2;
        const speed = rnd() < 0.01 ? [NaN, Infinity, -5][Math.floor(rnd() * 3)] : base + noise;
        return { speed, onGround: rnd() < 0.03 ? !onGround : onGround, alive };
      },
      () => (rnd() < 0.01 ? [0, 0.5, 2, -1, NaN][Math.floor(rnd() * 5)] : DT * (0.5 + rnd())),
    );
    const seconds = 20000 * DT;
    assert.ok(t.transitions.length / seconds < 1 / LOCO_TUNING.MIN_DWELL, `${t.transitions.length} transitions`);
  });
});
