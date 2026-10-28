import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { NIGHT_DAWN_TRANSITION_SEC } from '../../../shared/wolf/night';
import {
  DAWN_LOOK,
  DAWN_MAX_RATE_PER_SEC,
  DawnTracker,
  NIGHT_LOOK,
  createDawnLighting,
  dawnBlendFactor,
  dawnExposure,
  dawnSkyUniformDefaults,
  dawnTargetProgress,
  stepDawnProgress,
  type DawnSkyUniforms,
} from '../night/dawnLighting';

// Tong otishi: maqsadli daraja, kadrma-kadr silliqlash va yorug'lik interpolyatsiyasi.

/** Tracker ni `sec` soniya davomida 60 FPS da yuritadi, match yangilanishlari 2 Hz (har 0.5 s). */
function run(tr: DawnTracker, startSec: number, sec: number, match: (t: number) => Parameters<DawnTracker['onMatch']>[0]): number {
  const dt = 1 / 60;
  let nextMatch = startSec;
  let t = startSec;
  for (let i = 0; i < Math.round(sec * 60); i++) {
    t += dt;
    if (t >= nextMatch) {
      tr.onMatch(match(t));
      nextMatch += 0.5;
    }
    tr.update(dt);
  }
  return tr.value;
}

describe('Tong otishi — maqsadli daraja (dawnTargetProgress)', () => {
  it("1. 'playing': oxirgi NIGHT_DAWN_TRANSITION_SEC da 0 → 1, undan oldin tun", () => {
    assert.equal(dawnTargetProgress({ phase: 'playing', dawnInSec: 300 }), 0);
    assert.equal(dawnTargetProgress({ phase: 'playing', dawnInSec: NIGHT_DAWN_TRANSITION_SEC }), 0);
    assert.equal(dawnTargetProgress({ phase: 'playing', dawnInSec: NIGHT_DAWN_TRANSITION_SEC / 2 }), 0.5);
    assert.equal(dawnTargetProgress({ phase: 'playing', dawnInSec: 0 }), 1);
    assert.equal(dawnTargetProgress({ phase: 'playing', dawnInSec: null }), 0, "tun ma'lumoti yo'q — tun");
  });

  it("2. 'ended' + dawn — 1 ushlanadi; bo'rilar yutsa — joriy daraja (null); yangi tun — 0", () => {
    assert.equal(dawnTargetProgress({ phase: 'ended', winReason: 'dawn' }), 1);
    assert.equal(dawnTargetProgress({ phase: 'ended', winReason: 'draw_no_survivors' }), null);
    assert.equal(dawnTargetProgress({ phase: 'countdown', winReason: 'dawn' }), 0);
    assert.equal(dawnTargetProgress({ phase: 'waiting' }), 0);
  });

  it('3. stepDawnProgress tezligi cheklangan, maqsaddan oshib ketmaydi', () => {
    assert.equal(stepDawnProgress(0, 1, 0.1), 0.1 * DAWN_MAX_RATE_PER_SEC);
    assert.equal(stepDawnProgress(1, 0, 0.1), 1 - 0.1 * DAWN_MAX_RATE_PER_SEC);
    assert.equal(stepDawnProgress(0.5, 0.51, 1), 0.51);
    assert.equal(stepDawnProgress(0.3, 0.3, 0.016), 0.3);
  });

  it('4. dawnBlendFactor — smoothstep, chegaralangan', () => {
    assert.equal(dawnBlendFactor(0), 0);
    assert.equal(dawnBlendFactor(1), 1);
    assert.equal(dawnBlendFactor(0.5), 0.5);
    assert.ok(dawnBlendFactor(0.1) < 0.1, 'boshida sekin');
    assert.equal(dawnBlendFactor(-3), 0);
    assert.equal(dawnBlendFactor(7), 1);
    assert.equal(dawnBlendFactor(Number.NaN), 0);
    assert.equal(dawnExposure(0), NIGHT_LOOK.exposure);
    assert.equal(dawnExposure(1), DAWN_LOOK.exposure);
  });
});

describe('Tong otishi — DawnTracker (2 Hz yangilanishlar orasida silliq)', () => {
  it("1. Butun soniyali (ceil) dawnInSec bilan ham daraja monoton va sakrashsiz o'sadi", () => {
    const tr = new DawnTracker();
    // t = 140 da tong; match yangilanishlari tasodifiy fazada (0.37 s siljish) keladi
    const roundEnd = 140.37;
    tr.onMatch({ phase: 'playing', dawnInSec: Math.ceil(roundEnd - 100) });
    const dt = 1 / 60;
    let prev = tr.value;
    let maxJump = 0;
    let nextMatch = 100.5;
    for (let t = 100 + dt; t < 140.2; t += dt) {
      if (t >= nextMatch) {
        tr.onMatch({ phase: 'playing', dawnInSec: Math.max(0, Math.ceil(roundEnd - t)) });
        nextMatch += 0.5;
      }
      const v = tr.update(dt);
      assert.ok(v >= prev - 1e-9, `kamaymaydi (t=${t.toFixed(2)})`);
      maxJump = Math.max(maxJump, v - prev);
      prev = v;
    }
    // Chiziqli o'sish 1/60 s⁻¹ — bir kadrdagi o'zgarish juda kichik (2 Hz "zinapoya" yo'q)
    assert.ok(maxJump < 0.002, `kadr sakrashi ${maxJump}`);
    assert.ok(prev > 0.95, `tongga yaqin: ${prev}`);
  });

  it("2. Tong otdi ('ended' + dawn) — 1 da ushlanadi; keyingi sanoqda ~2 s da tunga qaytadi", () => {
    const tr = new DawnTracker();
    tr.onMatch({ phase: 'playing', dawnInSec: 0 });
    assert.equal(tr.value, 1, 'raund o‘rtasida kirgan o‘yinchi darhol joriy darajani oladi');
    const held = run(tr, 0, 6, () => ({ phase: 'ended', winReason: 'dawn' }));
    assert.equal(held, 1);
    const half = run(tr, 6, 1, () => ({ phase: 'countdown' }));
    assert.ok(half > 0.3 && half < 0.7, `bir soniyada yarmi: ${half}`);
    const back = run(tr, 7, 1.5, () => ({ phase: 'countdown' }));
    assert.equal(back, 0, 'to‘liq tun');
  });

  it("3. Bo'rilar yutganda ('ended', boshqa sabab) joriy yorug'lik o'zgarmaydi", () => {
    const tr = new DawnTracker();
    tr.onMatch({ phase: 'playing', dawnInSec: NIGHT_DAWN_TRANSITION_SEC / 2 });
    const before = tr.value;
    const after = run(tr, 0, 3, () => ({ phase: 'ended', winReason: 'draw_no_survivors' }));
    assert.equal(after, before);
  });
});

describe("Tong otishi — yorug'lik interpolyatsiyasi (createDawnLighting)", () => {
  function scene() {
    const hemi = new THREE.HemisphereLight(NIGHT_LOOK.hemiSky, NIGHT_LOOK.hemiGround, NIGHT_LOOK.hemiIntensity);
    const moon = new THREE.DirectionalLight(NIGHT_LOOK.moonColor, NIGHT_LOOK.moonIntensity);
    moon.position.set(52, 54, 36);
    const rim = new THREE.DirectionalLight(NIGHT_LOOK.rimColor, 0.25);
    const sky: DawnSkyUniforms = {
      top: { value: new THREE.Color(NIGHT_LOOK.skyTop) },
      horizon: { value: new THREE.Color(NIGHT_LOOK.skyHorizon) },
      sunDir: { value: moon.position.clone().normalize() },
      glowColor: { value: new THREE.Color(0.86, 0.9, 1.0) },
      glowCore: { value: 2 },
      glowHalo: { value: 0.1 },
      ...dawnSkyUniformDefaults(),
    };
    const fog = new THREE.Fog(NIGHT_LOOK.fog, 28, 150);
    const lighting = createDawnLighting({ hemi, moon, rim, sky, fog, fogBase: () => ({ near: 28, far: 150 }) });
    return { hemi, moon, rim, sky, fog, lighting };
  }

  it("1. Daraja 0 — tun sozlamalari o'zgarmaydi", () => {
    const s = scene();
    const pos = s.moon.position.clone();
    s.lighting.apply(0);
    assert.equal(s.hemi.intensity, NIGHT_LOOK.hemiIntensity);
    assert.equal(s.fog.near, 28);
    assert.equal(s.fog.far, 150);
    assert.equal(s.sky.dawnAmount.value, 0);
    assert.ok(s.moon.position.distanceTo(pos) < 1e-6);
  });

  it("2. Daraja 1 — yorqinroq ambient, tuman ko'tariladi, oy pasayadi va iliqlashadi, sharqda shafaq", () => {
    const s = scene();
    const nightElev = Math.atan2(s.moon.position.y, Math.hypot(s.moon.position.x, s.moon.position.z));
    const nightMoon = s.moon.color.clone();
    const nightHorizon = s.sky.horizon.value.clone();
    s.lighting.apply(1);
    assert.ok(s.hemi.intensity > NIGHT_LOOK.hemiIntensity * 1.8);
    assert.ok(s.fog.near > 28 && s.fog.far > 150 * 1.5);
    const elev = Math.atan2(s.moon.position.y, Math.hypot(s.moon.position.x, s.moon.position.z));
    assert.ok(elev < nightElev - 0.15, `oy pasaydi: ${elev} < ${nightElev}`);
    assert.ok(Math.abs(s.moon.position.length() - Math.hypot(52, 54, 36)) < 1e-6, 'masofa saqlanadi');
    assert.ok(s.moon.color.r >= nightMoon.r && s.moon.color.b < nightMoon.b, 'iliq tus');
    assert.ok(s.sky.horizon.value.r > nightHorizon.r * 3, 'pushti-to‘q sariq ufq');
    assert.ok(s.sky.dawnAmount.value > 0.5);
    // Shafaq oy azimutiga qarama-qarshi tomonda
    assert.ok(s.sky.dawnDir.value.dot(new THREE.Vector3(52, 0, 36).normalize()) < -0.99);
    // Osmondagi oy gardishi yorug'lik yo'nalishiga mos
    assert.ok(s.sky.sunDir.value.distanceTo(s.moon.position.clone().normalize()) < 1e-6);
  });

  it('3. Soya kuzatuvchisi nishonni siljitsa — oy pasaygan ofset bilan qayta joylashadi', () => {
    const s = scene();
    s.lighting.apply(1);
    const off = s.moon.position.clone().sub(s.moon.target.position);
    s.moon.target.position.set(40, 0, -20);
    s.moon.position.set(40 + 52, 54, -20 + 36); // kuzatuvchi tungi ofset bilan yozdi
    s.lighting.reapplyMoonDirection();
    assert.ok(s.moon.position.clone().sub(s.moon.target.position).distanceTo(off) < 1e-6);
  });
});
