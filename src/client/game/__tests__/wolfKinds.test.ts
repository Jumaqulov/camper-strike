import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as THREE from 'three';
import {
  WOLF_COAT_BLACK,
  WOLF_COAT_CHARCOAL,
  WOLF_COAT_RED,
  WOLF_COAT_TAN,
  WOLF_COAT_WHITE,
  WOLF_RUN_SPEED,
  wolfCoatTraits,
  type WolfState,
} from '../../../shared/wolf/contracts';
import { wolfVoiceMood } from '../Audio';
import { registerWolfTemplateForTest } from '../wolf/WolfAssetRegistry';
import { WOLF_RUN_CLIP_ENTER_SPEED, WolfModel, wolfClipFor, wolfModelScale } from '../wolf/WolfModel';
import {
  WOLF_FLANK_WARN_DIST,
  WOLF_STEALTH_AUDIO_MUL,
  WOLF_STEALTH_HUNT_WARN_DIST,
  WOLF_WARN_ALERT_DIST,
  WOLF_WARN_NEAR_DIST,
  wolfAudioRangeMul,
  wolfWarningFor,
  type WolfThreatView,
} from '../wolf/wolfThreat';

// Bo'ri turlari (coat → kind): model masshtabi, 'flee' klipi, ovoz masofasi va HUD ogohlantirishi.

const ME = { x: 0, z: 0, alive: true };
const wolf = (over: Partial<WolfThreatView>): WolfThreatView => ({
  x: 0,
  z: 0,
  state: 'idle',
  targetId: null,
  alive: true,
  coat: WOLF_COAT_CHARCOAL,
  ...over,
});

describe("Bo'ri 'flee' klipi (tong otdi — o'rmonga qochish)", () => {
  it('1. WOLF_RUN_SPEED da Run, to‘xtaganda Alert', () => {
    assert.equal(wolfClipFor({ state: 'flee', speed: WOLF_RUN_SPEED }), 'Run');
    assert.equal(wolfClipFor({ state: 'flee', speed: 0 }), 'Alert');
    assert.notEqual(wolfClipFor({ state: 'flee', speed: WOLF_RUN_SPEED }), 'Attack', 'qochayotgan bo‘ri tishlamaydi');
  });

  it('2. Sekin qochish Walk (oyoq sirpanmasin), Walk/Run gisterezisi ishlaydi', () => {
    assert.equal(wolfClipFor({ state: 'flee', speed: 1.5 }), 'Walk');
    const mid = WOLF_RUN_CLIP_ENTER_SPEED - 0.1;
    assert.equal(wolfClipFor({ state: 'flee', speed: mid }, 'Run'), 'Run');
    assert.equal(wolfClipFor({ state: 'flee', speed: mid }, 'Walk'), 'Walk');
  });
});

describe("Bo'ri turi — model masshtabi", () => {
  afterEach(() => registerWolfTemplateForTest(null));

  it("1. wolfModelScale: to'da boshlig'i 1.22, chaqqon 0.92, oddiy/soya 1, noma'lum — 1", () => {
    assert.equal(wolfModelScale(WOLF_COAT_WHITE), 1.22);
    assert.equal(wolfModelScale(WOLF_COAT_RED), 0.92);
    assert.equal(wolfModelScale(WOLF_COAT_CHARCOAL), 1);
    assert.equal(wolfModelScale(WOLF_COAT_TAN), 1);
    assert.equal(wolfModelScale(WOLF_COAT_BLACK), 1);
    assert.equal(wolfModelScale(undefined), 1);
    assert.equal(wolfModelScale(42), 1);
    for (let c = 0; c < 5; c++) assert.equal(wolfModelScale(c), wolfCoatTraits(c).scale);
  });

  it('2. WolfModel root masshtabi turga mos (zaxira model bilan ham)', () => {
    const alpha = new WolfModel(WOLF_COAT_WHITE);
    const swift = new WolfModel(WOLF_COAT_RED);
    try {
      assert.equal(alpha.root.scale.x, 1.22);
      assert.equal(alpha.root.scale.y, 1.22);
      assert.equal(alpha.scale, 1.22);
      assert.equal(swift.root.scale.z, 0.92);
    } finally {
      alpha.dispose();
      swift.dispose();
    }
  });

  it("3. To'da boshlig'ining ko'zlari yorqinroq (GLB 'wolf_eyes' materiali), oddiy bo'riniki o'zgarmaydi", () => {
    const mkTemplate = () => {
      const scene = new THREE.Group();
      const eyes = new THREE.MeshStandardMaterial({ name: 'wolf_eyes', emissive: '#ffb020', emissiveIntensity: 4 });
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), eyes));
      return {
        eyes,
        tpl: { scene, clips: [], validation: { ok: true, clips: [], joints: 24, sockets: [], triangles: 0, errors: [] } },
      };
    };
    const white = mkTemplate();
    const grey = mkTemplate();
    registerWolfTemplateForTest(white.tpl, WOLF_COAT_WHITE);
    registerWolfTemplateForTest(grey.tpl, WOLF_COAT_CHARCOAL);
    const a = new WolfModel(WOLF_COAT_WHITE);
    const g = new WolfModel(WOLF_COAT_CHARCOAL);
    try {
      assert.ok(a.usesAsset() && g.usesAsset());
      assert.ok(white.eyes.emissiveIntensity > 4, `boshliq: ${white.eyes.emissiveIntensity}`);
      assert.equal(grey.eyes.emissiveIntensity, 4);
    } finally {
      a.dispose();
      g.dispose();
    }
  });
});

describe("'Tun soyasi' (stealthy) — ovoz va HUD ogohlantirishi", () => {
  it('1. Doimiy ovoz masofasi faqat soyada qisqaradi', () => {
    assert.equal(wolfAudioRangeMul(WOLF_COAT_BLACK), WOLF_STEALTH_AUDIO_MUL);
    assert.ok(WOLF_STEALTH_AUDIO_MUL < 1);
    for (const c of [WOLF_COAT_CHARCOAL, WOLF_COAT_RED, WOLF_COAT_TAN, WOLF_COAT_WHITE, undefined]) {
      assert.equal(wolfAudioRangeMul(c), 1);
    }
  });

  it("2. 'Yaqinda bo'ri' — oddiy bo'ri 14 m da, soya esa yaqinroq kelgandagina", () => {
    const d = WOLF_WARN_NEAR_DIST - 1;
    assert.equal(wolfWarningFor([wolf({ x: d })], ME, 'me').level, 'near');
    assert.equal(wolfWarningFor([wolf({ x: d, coat: WOLF_COAT_BLACK })], ME, 'me').level, '');
    assert.equal(wolfWarningFor([wolf({ x: 5, coat: WOLF_COAT_BLACK })], ME, 'me').level, 'near');
    const da = WOLF_WARN_ALERT_DIST - 1;
    assert.equal(wolfWarningFor([wolf({ x: da, state: 'alert' })], ME, 'me').level, 'near');
    assert.equal(wolfWarningFor([wolf({ x: da, state: 'alert', coat: WOLF_COAT_BLACK })], ME, 'me').level, '');
  });

  it('3. Quvish banneri tur nomi bilan; soya uzoqdan quvsa banner chiqmaydi', () => {
    const w = wolfWarningFor([wolf({ x: 30, state: 'hunt', targetId: 'me', coat: WOLF_COAT_WHITE })], ME, 'me');
    assert.deepEqual(w, { level: 'hunt', nameUz: wolfCoatTraits(WOLF_COAT_WHITE).nameUz });
    const far = wolfWarningFor([wolf({ x: WOLF_STEALTH_HUNT_WARN_DIST + 5, state: 'hunt', targetId: 'me', coat: WOLF_COAT_BLACK })], ME, 'me');
    assert.equal(far.level, '');
    const near = wolfWarningFor([wolf({ x: WOLF_STEALTH_HUNT_WARN_DIST - 3, state: 'hunt', targetId: 'me', coat: WOLF_COAT_BLACK })], ME, 'me');
    assert.equal(near.level, 'hunt');
    assert.equal(near.nameUz, 'Tun soyasi');
  });

  it("4. Qochayotgan ('flee') va o'lik bo'rilar — hech qanday ogohlantirish yo'q; o'lgan o'yinchiga ham", () => {
    assert.equal(wolfWarningFor([wolf({ x: 2, state: 'flee', targetId: 'me' })], ME, 'me').level, '');
    assert.equal(wolfWarningFor([wolf({ x: 2, state: 'dead', alive: false })], ME, 'me').level, '');
    assert.equal(wolfWarningFor([wolf({ x: 2, state: 'hunt', targetId: 'me' })], { ...ME, alive: false }, 'me').level, '');
  });
});

describe("HUD 'flank' — orqamdagi qanot (me.yaw bilan)", () => {
  // yaw = 0: o'yinchi -z ga qaraydi; +z — orqasi
  const MEY = { ...ME, yaw: 0 };

  it("1. Orqa nuqtada 'stalk' da poylab turgan qanot ham 'flank' (banner 'hunt' ga sakramaydi); oldinda — 'hunt'", () => {
    const behind = wolfWarningFor([wolf({ z: 10, state: 'stalk', targetId: 'me' })], MEY, 'me');
    assert.deepEqual(behind, { level: 'flank', nameUz: wolfCoatTraits(WOLF_COAT_CHARCOAL).nameUz });
    const front = wolfWarningFor([wolf({ z: -10, state: 'stalk', targetId: 'me' })], MEY, 'me');
    assert.equal(front.level, 'hunt');
    // Hujumga o'tsa ham 'flank' qoladi (stalk → hunt → attack)
    for (const state of ['stalk', 'hunt', 'attack'] as const) {
      assert.equal(wolfWarningFor([wolf({ z: 10, state, targetId: 'me' })], MEY, 'me').level, 'flank', state);
    }
  });

  it("2. 'flank' faqat meni ovlayotgan, 18 m ichidagi bo'rida; yaw berilmasa — 'hunt'", () => {
    assert.equal(wolfWarningFor([wolf({ z: WOLF_FLANK_WARN_DIST + 2, state: 'stalk', targetId: 'me' })], MEY, 'me').level, 'hunt');
    assert.equal(wolfWarningFor([wolf({ z: 10, state: 'stalk', targetId: 'other' })], MEY, 'me').level, 'near', 'boshqani poylayapti');
    assert.equal(wolfWarningFor([wolf({ z: 10, state: 'alert', targetId: 'me' })], MEY, 'me').level, 'near', 'hushyor — xavf emas');
    assert.equal(wolfWarningFor([wolf({ z: 10, state: 'stalk', targetId: 'me' })], ME, 'me').level, 'hunt', 'yaw yo‘q');
  });
});

describe("Bo'ri doimiy ovozi kayfiyati (wolfVoiceMood)", () => {
  it("barcha holatlar: flee — qochish (irillashsiz), ov — threat", () => {
    const expected: Record<WolfState, string> = {
      idle: 'calm',
      sniff: 'alert',
      alert: 'alert',
      stalk: 'threat',
      hunt: 'threat',
      attack: 'threat',
      hit: 'calm',
      howl: 'calm',
      flee: 'flee',
      dead: 'calm',
    };
    for (const [state, mood] of Object.entries(expected)) assert.equal(wolfVoiceMood(state as WolfState), mood, state);
  });
});
