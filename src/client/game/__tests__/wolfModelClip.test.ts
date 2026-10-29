import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as THREE from 'three';
import { WOLF_COAT_CHARCOAL, WOLF_RUN_SPEED, WOLF_STALK_SPEED, WOLF_WALK_SPEED } from '../../../shared/wolf/contracts';
import { WOLF_CLIPS, registerWolfTemplateForTest, type WolfAssetTemplate } from '../wolf/WolfAssetRegistry';
import {
  WOLF_BACKPEDAL_ENTER_COS,
  WOLF_BACKPEDAL_EXIT_COS,
  WOLF_BACKPEDAL_MIN_COHERENCE,
  WOLF_BACKPEDAL_MIN_SPEED,
  WOLF_RUN_CLIP_ENTER_SPEED,
  WOLF_RUN_CLIP_EXIT_SPEED,
  WolfModel,
  wolfBackpedal,
  wolfClipFor,
  wolfClipTimeScale,
} from '../wolf/WolfModel';

// Bo'ri klipi tanlovi: Walk klipi (1.2 m/s × ≤2.2) sig'magan tezlikda oyoq sirpanmasligi uchun Run.
// Orqaga siljiyotgan bo'ri (soxta hamladan keyin chekinish) — Walk teskari ("moonwalk" yo'q).

describe("Bo'ri klipi — tezlik bo'yicha Walk/Run (oyoq sirpanishi)", () => {
  it("1. Olovdan WOLF_RUN_SPEED bilan qochayotgan 'alert' bo'ri — Run", () => {
    assert.equal(wolfClipFor({ state: 'alert', speed: WOLF_RUN_SPEED }), 'Run');
    assert.equal(wolfClipFor({ state: 'alert', speed: 0.2 }), 'Alert', "turgan joyda — Alert");
  });

  it('2. Sayr (WOLF_WALK_SPEED) Walk bo‘lib qoladi; har qanday tez harakat — Run', () => {
    for (const state of ['idle', 'sniff', 'alert', 'stalk'] as const) {
      assert.equal(wolfClipFor({ state, speed: WOLF_WALK_SPEED }), 'Walk', `${state} @ walk`);
      assert.equal(wolfClipFor({ state, speed: WOLF_RUN_SPEED }), 'Run', `${state} @ run`);
    }
    assert.equal(wolfClipFor({ state: 'stalk', speed: WOLF_STALK_SPEED }), 'Run');
    assert.equal(wolfClipFor({ state: 'hunt', speed: 1 }), 'Run', "ov — avvalgidek Run");
    assert.equal(wolfClipFor({ state: 'attack', speed: WOLF_RUN_SPEED }), 'Attack', 'harakatsiz klipga tegmaydi');
  });

  it('3. Gisterezis: chegara atrofidagi tezlikda klip almashib turmaydi', () => {
    const mid = (WOLF_RUN_CLIP_ENTER_SPEED + WOLF_RUN_CLIP_EXIT_SPEED) / 2;
    assert.equal(wolfClipFor({ state: 'alert', speed: mid }, 'Walk'), 'Walk');
    assert.equal(wolfClipFor({ state: 'alert', speed: mid }, 'Run'), 'Run');
    assert.equal(wolfClipFor({ state: 'alert', speed: WOLF_RUN_CLIP_EXIT_SPEED - 0.05 }, 'Run'), 'Walk');
    assert.ok(WOLF_WALK_SPEED < WOLF_RUN_CLIP_EXIT_SPEED, 'oddiy sayr Run ga o‘tib ketmaydi');
    // Run klipi eng sekini 4 × 0.6 = 2.4 m/s — chiqish chegarasidan past bo'lmasligi kerak
    assert.ok(WOLF_RUN_CLIP_EXIT_SPEED >= 2.4);
    // Walk klipi eng tezi 1.2 × 2.2 = 2.64 m/s — kirish chegarasi undan ozgina yuqori
    assert.ok(WOLF_RUN_CLIP_ENTER_SPEED - 1.2 * 2.2 < 0.3);
  });
});

/**
 * Klient silliqlashi (Game.updateWolves kabi): snapshot 30 Hz, kadr 60 fps; tezlik moduli va tezlik vektori
 * lerp(dt × 12) bilan, orqaga bayrog'i — `wolfBackpedal`, klip — `wolfClipFor` (joriy klip gisterezisi bilan).
 * `snaps` — har snapshotdagi siljish yo'nalishi (yuzga nisbatan burchak, rad; yaw = 0 — yuz -z ga) va tezligi (m/s).
 */
function runGait(state: 'stalk' | 'hunt', snaps: readonly { ang: number; speed: number }[]) {
  const FRAME = 1 / 60;
  const k = Math.min(1, FRAME * 12);
  let speed = 0;
  let vx = 0;
  let vz = 0;
  let back = false;
  let clip: ReturnType<typeof wolfClipFor> | null = null;
  const out: { back: boolean; clip: ReturnType<typeof wolfClipFor> }[] = [];
  for (const s of snaps) {
    const sx = -Math.sin(s.ang) * s.speed;
    const sz = -Math.cos(s.ang) * s.speed;
    for (let f = 0; f < 2; f++) {
      speed += (s.speed - speed) * k;
      vx += (sx - vx) * k;
      vz += (sz - vz) * k;
      back = wolfBackpedal(back, vx, vz, 0, speed);
      clip = wolfClipFor({ state, speed, backwards: back }, clip);
      out.push({ back, clip });
    }
  }
  return out;
}

/** Soxta shablon: 'leg' tuguni; Walk/Run klipi uni 1 s da x 0 → 1 ga suradi (teskari o'ynasa — kamayadi). */
function gaitTemplate(): WolfAssetTemplate {
  const scene = new THREE.Group();
  const leg = new THREE.Object3D();
  leg.name = 'leg';
  scene.add(leg);
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 1.4), new THREE.MeshStandardMaterial()));
  const clips = WOLF_CLIPS.map((name) =>
    name === 'Walk' || name === 'Run'
      ? new THREE.AnimationClip(name, 1, [new THREE.NumberKeyframeTrack('leg.position[x]', [0, 1], [0, 1])])
      : new THREE.AnimationClip(name, 1, []),
  );
  return { scene, clips, validation: { ok: true, clips: [...WOLF_CLIPS], joints: 24, sockets: [], triangles: 0, errors: [] } };
}

describe("Bo'ri orqaga yurishi — oyoqlar oldinga yugurmaydi (moonwalk yo'q)", () => {
  afterEach(() => registerWolfTemplateForTest(null));

  it('1. wolfBackpedal: harakat yuzdan 120° dan ko‘p og‘sa — orqaga; chiqish -0.2 dan (gisterezis); sekin/yonlama/zigzag — yo‘q', () => {
    const yaw = 1.1;
    // Yuzdan `ang` ga og'gan tezlik vektori (oldinga = (-sin yaw, -cos yaw)); izchil harakatda speed = |v|
    const back = (prev: boolean, ang: number, sp = 3, speed = sp) =>
      wolfBackpedal(prev, -Math.sin(yaw + ang) * sp, -Math.cos(yaw + ang) * sp, yaw, speed);
    assert.equal(back(false, Math.PI), true, "to'g'ri orqaga");
    assert.equal(back(false, 0), false, 'oldinga');
    assert.equal(back(false, Math.PI / 2), false, 'yonlama');
    assert.equal(back(true, -Math.PI / 2), false, 'yonlama (boshqa tomon)');
    const mid = Math.acos((WOLF_BACKPEDAL_ENTER_COS + WOLF_BACKPEDAL_EXIT_COS) / 2);
    assert.equal(back(false, mid), false, 'oraliqda — oldinga bo‘lsa oldinga qoladi');
    assert.equal(back(true, mid), true, 'oraliqda — orqaga bo‘lsa orqaga qoladi');
    assert.equal(back(true, Math.acos(WOLF_BACKPEDAL_EXIT_COS + 0.05)), false, 'chiqish chegarasidan o‘tdi');
    assert.equal(back(true, Math.PI, WOLF_BACKPEDAL_MIN_SPEED * 0.9), false, 'deyarli to‘xtadi');
    // Izchil emas: o'rtacha vektor tezlik modulidan ancha kichik (zigzag) — yo'nalishga ishonilmaydi
    const sp = 3 * WOLF_BACKPEDAL_MIN_COHERENCE * 0.9;
    assert.equal(back(true, Math.PI, sp, 3), false, 'zigzag — orqaga emas');
    assert.equal(back(false, Math.PI, 3 * WOLF_BACKPEDAL_MIN_COHERENCE * 1.1, 3), true, 'izchil — orqaga');
    assert.equal(wolfBackpedal(false, 0, 0, yaw, 0), false);
    assert.equal(wolfBackpedal(true, 0, 3, Number.NaN, 3), false);
  });

  it("2. Orqaga — Walk (stalk 4.2 m/s da ham Run emas) va manfiy timeScale; harakatsiz kliplar o'zgarmaydi", () => {
    for (const state of ['stalk', 'hunt', 'alert', 'idle', 'flee'] as const) {
      assert.equal(wolfClipFor({ state, speed: WOLF_STALK_SPEED, backwards: true }, 'Run'), 'Walk', state);
    }
    assert.equal(wolfClipFor({ state: 'stalk', speed: WOLF_STALK_SPEED, backwards: false }), 'Run', 'oldinga — avvalgidek');
    assert.equal(wolfClipFor({ state: 'attack', speed: 3, backwards: true }), 'Attack');
    assert.equal(wolfClipFor({ state: 'stalk', speed: 0.1, backwards: true }), 'Alert', 'turgan joyda — Alert');
    // Walk 1.2 m/s × masshtab — timeScale 1; orqaga — -1; 0.6..2.2 ichida
    const walkBack = (speed: number, scale = 1) => wolfClipTimeScale('Walk', { state: 'stalk', speed, backwards: true }, scale);
    assert.ok(Math.abs(walkBack(1.2) + 1) < 1e-9, 'tabiiy tezlikda teskari');
    assert.ok(Math.abs(walkBack(1.2 * 1.22, 1.22) + 1) < 1e-9, "katta bo'ri — qadami uzun");
    assert.equal(walkBack(20), -2.2);
    assert.equal(walkBack(0.1), -0.6);
    assert.ok(Math.abs(wolfClipTimeScale('Walk', { state: 'stalk', speed: 1.2 }) - 1) < 1e-9, 'oldinga — musbat');
    assert.equal(wolfClipTimeScale('Run', { state: 'hunt', speed: 4, backwards: true }), 1, 'Run teskari o‘ynalmaydi');
    assert.equal(wolfClipTimeScale('Attack', { state: 'attack', speed: 3, backwards: true }), 1);
  });

  it('3. Soxta hamla izi: chekinish bitta orqaga epizod, burchak shovqinida ham klip oldinga/orqaga almashib turmaydi', () => {
    const deg = Math.PI / 180;
    // Yaqinlashish (oldinga 4.2 m/s), o'ljaga qarab chekinish (`retreatAng` — har snapshotdagi yo'nalish), to'xtash
    // va yana oldinga hamla
    const trace = (retreatAng: (i: number) => number) => {
      const snaps: { ang: number; speed: number }[] = [];
      for (let i = 0; i < 30; i++) snaps.push({ ang: 0, speed: WOLF_STALK_SPEED });
      const retreat0 = snaps.length;
      for (let i = 0; i < 14; i++) snaps.push({ ang: retreatAng(i), speed: 2.6 });
      const stop0 = snaps.length;
      for (let i = 0; i < 9; i++) snaps.push({ ang: Math.PI, speed: 0 });
      for (let i = 0; i < 15; i++) snaps.push({ ang: 0, speed: WOLF_STALK_SPEED });
      const out = runGait('stalk', snaps);
      let flips = 0;
      for (let i = 1; i < out.length; i++) if (out[i]!.back !== out[i - 1]!.back) flips++;
      // Kadrlar (60 fps): har snapshotga 2 ta
      return { out, flips, retreatF: retreat0 * 2, stopF: stop0 * 2, firstBack: out.findIndex((o) => o.back) };
    };
    // To'g'ri orqaga (4.2 m/s oldinga → darhol 2.6 m/s orqaga): silliqlash kechikishi ~0.13 s (8 kadr) ichida orqaga,
    // to'xtaguncha Walk teskari
    const straight = trace(() => Math.PI);
    assert.equal(straight.flips, 2, 'bitta kirish, bitta chiqish');
    assert.ok(straight.firstBack >= straight.retreatF && straight.firstBack <= straight.retreatF + 8, `kirish kadri ${straight.firstBack}`);
    // Yo'nalish 100° / 150° orasida sakraydi: silliqlangan yo'nalish 120° chegara atrofida tebranadi — gisterezissiz
    // klip 10 marta almashardi; gisterezis bilan bitta epizod
    const noisy = trace((i) => (i % 2 ? 150 : 100) * deg);
    assert.equal(noisy.flips, 2, 'shovqinda ham bitta kirish, bitta chiqish');
    for (const { out, retreatF, stopF, firstBack } of [straight, noisy]) {
      for (let f = 0; f < retreatF; f++) assert.equal(out[f]!.back, false, `yaqinlashish kadri ${f}`);
      for (let f = firstBack; f < stopF; f++) {
        assert.equal(out[f]!.back, true, `chekinish kadri ${f}`);
        assert.equal(out[f]!.clip, 'Walk', `chekinishda Walk (kadr ${f})`);
      }
      assert.equal(out.at(-1)!.back, false);
      assert.equal(out.at(-1)!.clip, 'Run', 'yana oldinga hamla — Run');
    }
  });

  it("4. Zigzag (har snapshot yo'nalish +60° / -160° almashadi, 1.2 m/s — qanot shunday titraydi): klip teskariga sakramaydi", () => {
    const deg = Math.PI / 180;
    // O'rtacha siljish sekin (~0.4 m/s) va orqaga og'gan; silliqlangan yo'nalish chegaralardan har necha kadrda
    // o'tadi — izchillik tekshiruvisiz Walk ~1 s da 57 marta teskari/oldinga almashardi
    const snaps = Array.from({ length: 60 }, (_, i) => ({ ang: (i % 2 ? -160 : 60) * deg, speed: 1.2 }));
    const out = runGait('hunt', snaps);
    assert.ok(out.every((o) => !o.back), `orqaga kadrlar: ${out.filter((o) => o.back).length}`);
  });

  it("5. WolfModel: orqaga siljiganda Walk klipi teskari o'ynaydi (kalit kadr qiymati kamayadi), oldinga — ortadi", () => {
    registerWolfTemplateForTest(gaitTemplate(), WOLF_COAT_CHARCOAL);
    const m = new WolfModel(WOLF_COAT_CHARCOAL);
    try {
      assert.ok(m.usesAsset());
      const leg = m.root.getObjectByName('leg');
      assert.ok(leg);
      const dt = 1 / 30;
      // Klipning 1 s lik siklidagi qadam: (keyingi − oldingi) mod 1
      const stepOf = (s: { state: 'stalk'; speed: number; backwards?: boolean }) => {
        const x0 = leg.position.x;
        m.update(dt, s, 3);
        return (((leg.position.x - x0) % 1) + 1) % 1;
      };
      const fwd = { state: 'stalk' as const, speed: 1.2 };
      for (let i = 0; i < 12; i++) m.update(dt, fwd, 3); // fade-in tugasin
      for (let i = 0; i < 5; i++) assert.ok(Math.abs(stepOf(fwd) - dt) < 1e-6, 'oldinga: +dt');
      const back = { state: 'stalk' as const, speed: 1.2, backwards: true };
      m.update(dt, back, 3);
      for (let i = 0; i < 5; i++) assert.ok(Math.abs(stepOf(back) - (1 - dt)) < 1e-6, 'orqaga: −dt (teskari)');
      // Tez chekinish (stalk 4.2 m/s) — Run emas, teskari Walk (eng tezi 2.2)
      const fast = { state: 'stalk' as const, speed: WOLF_STALK_SPEED, backwards: true };
      m.update(dt, fast, 3);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(stepOf(fast) - (1 - dt * 2.2)) < 1e-6, 'orqaga: −2.2 dt');
    } finally {
      m.dispose();
    }
  });
});
