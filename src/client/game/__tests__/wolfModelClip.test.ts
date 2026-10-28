import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WOLF_RUN_SPEED, WOLF_STALK_SPEED, WOLF_WALK_SPEED } from '../../../shared/wolf/contracts';
import { WOLF_RUN_CLIP_ENTER_SPEED, WOLF_RUN_CLIP_EXIT_SPEED, wolfClipFor } from '../wolf/WolfModel';

// Bo'ri klipi tanlovi: Walk klipi (1.2 m/s × ≤2.2) sig'magan tezlikda oyoq sirpanmasligi uchun Run.

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
