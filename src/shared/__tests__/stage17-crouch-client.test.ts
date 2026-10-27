import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClientPrediction } from '../../client/game/ClientPrediction';
import { CROUCH_VIEW_BLEND_TIME, LocalPlayer } from '../../client/game/LocalPlayer';
import { CROUCH_EYE_HEIGHT, EYE_HEIGHT, MAX_HP } from '../constants';
import { cloneMovementState, FIXED_MOVE_DT, type MovementState } from '../netMovement';
import type { PlayerSnap } from '../protocol';
import { boxCollider, makeFlatWorld } from './flatWorldFixture';

// Bosqich 17 (klient tomoni): o'tirish (crouch) — bashorat, server bilan solishtirish va LocalPlayer ko'zi.
// Server/umumiy fizika testlari — stage17-crouch.test.ts (agent A).

const world = makeFlatWorld([]);

function freshState(): MovementState {
  return {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    onGround: true,
    yaw: 0,
    pitch: 0,
    weapon: 'rifle',
    scoped: false,
  };
}

function intent(crouch: boolean, moveForward = 1) {
  return {
    dt: FIXED_MOVE_DT,
    moveForward,
    moveRight: 0,
    jump: false,
    walk: false,
    crouch,
    scoped: false,
    weapon: 'rifle' as const,
    yaw: 0,
    pitch: 0,
  };
}

/** Berilgan holatdan server snapshot'i (ack = seq); `crouched` faqat true bo'lsa yuboriladi (server kabi). */
function snapFrom(st: MovementState, seq: number, crouched: boolean): PlayerSnap {
  const snap: PlayerSnap = {
    id: 'me',
    x: st.pos.x,
    y: st.pos.y,
    z: st.pos.z,
    vx: st.vel.x,
    vy: st.vel.y,
    vz: st.vel.z,
    yaw: 0,
    pitch: 0,
    hp: MAX_HP,
    alive: true,
    weapon: 'rifle',
    onGround: st.onGround,
    reloading: false,
    spawnId: 1,
    lastProcessedInputSeq: seq,
    stamina: st.stamina,
    staminaLocked: st.staminaLocked,
  };
  if (crouched) snap.crouched = true;
  return snap;
}

/** `n` ta kirishni yozadi; har bir qadamdan keyingi holat nusxalari qaytariladi (index = seq − 1). */
function record(pred: ClientPrediction, state: MovementState, n: number, crouch: boolean): MovementState[] {
  const after: MovementState[] = [];
  for (let i = 0; i < n; i++) {
    pred.recordAndStepInput(state, intent(crouch), world);
    after.push(cloneMovementState(state));
  }
  return after;
}

describe('BOSQICH 17 — O\'tirish: klient bashorati va reconcile', () => {
  it('1. ClientPrediction crouch kirishini yozadi: buyruqda crouch=true, holat o\'tirgan', () => {
    const pred = new ClientPrediction();
    pred.resetForSpawn(1);
    const state = freshState();
    const after = record(pred, state, 6, true);
    assert.equal(state.crouched, true);
    assert.ok(after.every((s) => s.crouched === true), 'har bir stateAfter o\'tirgan');
    const batch = pred.getBatchForSend(16);
    assert.equal(batch.length, 6);
    assert.ok(batch.every((c) => c.crouch === true), 'yuboriladigan buyruqlarda crouch=true');
    // O'tirib yurish tezligi tik yurishdan sekin
    const standPred = new ClientPrediction();
    standPred.resetForSpawn(1);
    const standing = freshState();
    record(standPred, standing, 6, false);
    assert.equal(Boolean(standing.crouched), false);
    assert.ok(Math.hypot(state.vel.x, state.vel.z) < Math.hypot(standing.vel.x, standing.vel.z));
  });

  it('2. Mos snapshot (crouched: true) → tezkor qabul: tuzatish yo\'q, qayta o\'ynash yo\'q', () => {
    const pred = new ClientPrediction();
    pred.resetForSpawn(1);
    const state = freshState();
    const after = record(pred, state, 10, true);
    const before = cloneMovementState(state);
    const res = pred.reconcileSnapshot(state, snapFrom(after[5], 6, true), 1, world);
    assert.equal(res.accepted, true);
    assert.equal(res.corrected, false);
    assert.equal(res.snapped, false);
    assert.equal(res.replayedCount, 0, 'tezkor qabul yo\'li (rewind yo\'q)');
    assert.deepEqual(state, before, 'holat o\'zgarmaydi');
  });

  it('3. Pozitsiya bir xil, lekin crouched mos emas → rewind + tuzatish (server holati qabul qilinadi)', () => {
    // a) Klient o'tirgan deb bashorat qildi, server tik turibdi (snapshot'da crouched yo'q), kutilayotgan kirish yo'q
    {
      const pred = new ClientPrediction();
      pred.resetForSpawn(1);
      const state = freshState();
      const after = record(pred, state, 8, true);
      const res = pred.reconcileSnapshot(state, snapFrom(after[7], 8, false), 1, world);
      assert.equal(res.accepted, true);
      assert.equal(res.corrected, true, 'faqat o\'tirish holati tuzatilsa ham — tuzatish');
      assert.equal(res.snapped, false);
      assert.equal(Boolean(state.crouched), false, 'server holati (tik) qabul qilindi');
    }
    // b) Klient tik deb bashorat qildi, server o'tirgan (masalan, past shift ostida turolmadi)
    {
      const pred = new ClientPrediction();
      pred.resetForSpawn(1);
      const state = freshState();
      const after = record(pred, state, 8, false);
      const res = pred.reconcileSnapshot(state, snapFrom(after[7], 8, true), 1, world);
      assert.equal(res.corrected, true);
      assert.equal(state.crouched, true, 'server holati (o\'tirgan) qabul qilindi');
    }
    // c) Mos kelmaslik + kutilayotgan kirishlar: tezkor qabul emas, ack dan keyingi kirishlar qayta o'ynaladi
    {
      const pred = new ClientPrediction();
      pred.resetForSpawn(1);
      const state = freshState();
      const after = record(pred, state, 10, true);
      const res = pred.reconcileSnapshot(state, snapFrom(after[4], 5, false), 1, world);
      assert.equal(res.accepted, true);
      assert.equal(res.replayedCount, 5, 'rewind: seq 6..10 qayta o\'ynaldi');
      assert.equal(state.crouched, true, 'qayta o\'ynalgan crouch kirishlari yana o\'tqazadi');
      for (const rec of pred.getBatchForSend(16)) assert.equal(rec.crouch, true);
    }
  });

  it('4. LocalPlayer: move(crouch) → eye()/smoothedEye() CROUCH_EYE_HEIGHT; kamera ko\'zi ~0.12 s da silliq o\'tadi', () => {
    const me = new LocalPlayer(world);
    me.spawn({ spawnId: 1, x: 0, y: 0, z: 0, yaw: 0, team: 'none', weapon: 'rifle' }, 0);
    assert.equal(me.body.crouched, false);
    assert.equal(me.viewEyeHeight(), EYE_HEIGHT);

    const cmd = me.move(FIXED_MOVE_DT, 0, 0, false, false, true);
    assert.equal(cmd.crouch, true);
    assert.equal(me.body.crouched, true);
    assert.ok(Math.abs(me.eye().y - (me.body.pos.y + CROUCH_EYE_HEIGHT)) < 1e-9, 'o\'q chiqish nuqtasi darhol pastda');
    assert.ok(Math.abs(me.smoothedEye().y - (me.smoothedPos().y + CROUCH_EYE_HEIGHT)) < 1e-9);

    // Kamera: yarim yo'lda oraliq qiymat, CROUCH_VIEW_BLEND_TIME dan keyin aynan CROUCH_EYE_HEIGHT
    const mid = me.updateViewCrouch(CROUCH_VIEW_BLEND_TIME / 2);
    assert.ok(mid < EYE_HEIGHT && mid > CROUCH_EYE_HEIGHT, `oraliq: ${mid}`);
    assert.equal(me.updateViewCrouch(CROUCH_VIEW_BLEND_TIME / 2), CROUCH_EYE_HEIGHT);

    // Qo'yib yuborish: ochiq joyda darhol turadi
    me.move(FIXED_MOVE_DT, 0, 0, false, false, false);
    assert.equal(me.body.crouched, false);
    assert.ok(Math.abs(me.eye().y - (me.body.pos.y + EYE_HEIGHT)) < 1e-9);
    me.updateViewCrouch(1);
    assert.equal(me.viewEyeHeight(), EYE_HEIGHT);

    // Spawn holatni tiklaydi
    me.move(FIXED_MOVE_DT, 0, 0, false, false, true);
    me.updateViewCrouch(1);
    me.spawn({ spawnId: 2, x: 0, y: 0, z: 0, yaw: 0, team: 'none', weapon: 'rifle' }, 1);
    assert.equal(me.body.crouched, false);
    assert.equal(me.viewCrouch, 0);
    assert.equal(me.viewEyeHeight(), EYE_HEIGHT);
  });

  it('5. LocalPlayer: past shift ostida qo\'yib yuborilsa ham o\'tirgan qoladi; reconcile server holatini oladi', () => {
    // Shift pastki yuzasi 1.5 m: o'tirgan (1.25) sig'adi, tik (1.8) sig'maydi
    const lowWorld = makeFlatWorld([boxCollider('low_ceiling', { x: -3, y: 1.5, z: -3 }, { x: 3, y: 2, z: 3 }, 'concrete')]);
    const me = new LocalPlayer(lowWorld);
    me.spawn({ spawnId: 1, x: 0, y: 0, z: 0, yaw: 0, team: 'none', weapon: 'rifle' }, 0);
    me.body.crouched = true; // shift ostiga o'tirib kirgan
    for (let i = 0; i < 5; i++) me.move(FIXED_MOVE_DT, 0, 0, false, false, false);
    assert.equal(me.body.crouched, true, 'tepada joy yo\'q — turmaydi');
    assert.ok(Math.abs(me.eye().y - (me.body.pos.y + CROUCH_EYE_HEIGHT)) < 1e-9);

    // Ochiq joyda: klient tik deb bashorat qildi, server esa o'tirgan → reconcile o'tqazadi
    const me2 = new LocalPlayer(world);
    me2.spawn({ spawnId: 1, x: 0, y: 0, z: 0, yaw: 0, team: 'none', weapon: 'rifle' }, 0);
    for (let i = 0; i < 3; i++) me2.move(FIXED_MOVE_DT, 0, 0, false, false, false);
    const st: MovementState = {
      pos: { ...me2.body.pos },
      vel: { ...me2.body.vel },
      onGround: me2.body.onGround,
      yaw: 0,
      pitch: 0,
      weapon: 'rifle',
      scoped: false,
      stamina: me2.stamina,
      staminaLocked: me2.staminaLocked,
    };
    const res = me2.reconcile(snapFrom(st, 3, true), 1);
    assert.equal(res.corrected, true);
    assert.equal(me2.body.crouched, true);
    assert.ok(Math.abs(me2.eye().y - (me2.body.pos.y + CROUCH_EYE_HEIGHT)) < 1e-9);
  });
});
