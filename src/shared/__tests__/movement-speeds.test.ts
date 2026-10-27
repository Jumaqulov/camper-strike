import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BACKPEDAL_SPEED_MUL, RUN_SPEED, STRAFE_SPEED_MUL, WALK_SPEED } from '../constants';
import { computeWishVelocity, stepStamina, wantsSprint } from '../netMovement';
import { STAMINA_RELOCK_THRESHOLD, STAMINA_SPRINT_SECONDS } from '../constants';
import { WEAPONS } from '../weapons';

const base = { scoped: false, weapon: null as null, yaw: 0 };
const speedOf = (fwd: number, right: number, sprint: boolean, weapon: 'rifle' | null = null) => {
  const { wx, wz } = computeWishVelocity({ ...base, weapon, moveForward: fwd, moveRight: right, walk: sprint });
  return Math.hypot(wx, wz);
};
const close = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

describe('Harakat tezliklari — yurish / sprint / yon / orqaga', () => {
  it("Shift'siz oldinga yurish WALK_SPEED, Shift bilan sprint RUN_SPEED", () => {
    close(speedOf(1, 0, false), WALK_SPEED, 'yurish');
    close(speedOf(1, 0, true), RUN_SPEED, 'sprint');
    assert.ok(RUN_SPEED > WALK_SPEED, 'sprint yurishdan tez');
  });

  it('yon tomonga va orqaga yurish oldinga nisbatan sekinroq', () => {
    close(speedOf(0, 1, false), WALK_SPEED * STRAFE_SPEED_MUL, 'o‘ngga');
    close(speedOf(0, -1, false), WALK_SPEED * STRAFE_SPEED_MUL, 'chapga');
    close(speedOf(-1, 0, false), WALK_SPEED * BACKPEDAL_SPEED_MUL, 'orqaga');
    const diag = speedOf(1, 1, false);
    assert.ok(diag < WALK_SPEED && diag > WALK_SPEED * STRAFE_SPEED_MUL, `diagonal oraliqda: ${diag}`);
  });

  it('sprint faqat oldinga: orqaga va sof yon harakatda Shift tezlikni oshirmaydi', () => {
    close(speedOf(-1, 0, true), WALK_SPEED * BACKPEDAL_SPEED_MUL, 'orqaga sprint yo‘q');
    close(speedOf(0, 1, true), WALK_SPEED * STRAFE_SPEED_MUL, 'yon sprint yo‘q');
    const diagSprint = speedOf(1, 1, true);
    assert.ok(diagSprint > speedOf(1, 1, false), 'oldinga-diagonal sprint tezroq');
  });

  it('stamina: sprint ~6 s da tugaydi, qulflanadi, tiklangach yana ochiladi', () => {
    const st: { stamina?: number; staminaLocked?: boolean } = { stamina: 1, staminaLocked: false };
    const dt = 1 / 60;
    let sprintFrames = 0;
    for (let i = 0; i < 60 * 10 && !st.staminaLocked; i++) if (stepStamina(st, true, dt)) sprintFrames++;
    const sprintSec = sprintFrames * dt;
    assert.ok(Math.abs(sprintSec - STAMINA_SPRINT_SECONDS) < 0.1, `sprint davomiyligi ${sprintSec.toFixed(2)} s`);
    assert.equal(st.staminaLocked, true, 'tugagach qulflanadi');
    assert.equal(st.stamina, 0);
    // Qulflangan holatda sprint so'ralsa ham ruxsat yo'q va stamina tiklanadi
    let unlockedAt = -1;
    for (let i = 0; i < 60 * 10; i++) {
      const ok = stepStamina(st, true, dt);
      if (!st.staminaLocked && unlockedAt < 0) unlockedAt = i * dt;
      if (unlockedAt < 0) assert.equal(ok, false, 'qulfda sprint yo‘q');
      if (unlockedAt >= 0) break;
    }
    assert.ok(unlockedAt > 0 && (st.stamina ?? 0) >= STAMINA_RELOCK_THRESHOLD - 1e-6, `qulf ${unlockedAt.toFixed(2)} s da ochildi`);
    assert.equal(wantsSprint({ moveForward: 1, moveRight: 0, walk: true }), true);
    assert.equal(wantsSprint({ moveForward: -1, moveRight: 0, walk: true }), false);
    assert.equal(wantsSprint({ moveForward: 1, moveRight: 0, walk: false }), false);
  });

  it('qurol tezlik koeffitsiyenti saqlanadi', () => {
    close(speedOf(1, 0, true, 'rifle'), RUN_SPEED * WEAPONS.rifle.speedMul, 'avtomat bilan sprint');
    close(speedOf(1, 0, false, 'rifle'), WALK_SPEED * WEAPONS.rifle.speedMul, 'avtomat bilan yurish');
  });
});
