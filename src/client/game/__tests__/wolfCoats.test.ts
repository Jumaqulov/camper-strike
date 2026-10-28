import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as THREE from 'three';
import {
  WOLF_COAT_COUNT,
  WOLF_COAT_URLS,
  WOLF_GLB_URL,
  instantiateWolf,
  isWolfAssetReady,
  registerWolfTemplateForTest,
  type WolfAssetTemplate,
} from '../wolf/WolfAssetRegistry';

function fakeTemplate(): WolfAssetTemplate {
  return {
    scene: new THREE.Group(),
    clips: [],
    validation: { ok: true, clips: [], joints: 24, sockets: [], triangles: 0, errors: [] },
  };
}

describe("Bo'ri rang variantlari (WolfAssetRegistry coat)", () => {
  afterEach(() => registerWolfTemplateForTest(null));

  it('1. Har bir coat o‘z GLB fayliga ega, 0 — charcoal (feral_wolf_rigged.glb)', () => {
    assert.equal(WOLF_COAT_COUNT, 5);
    assert.equal(WOLF_COAT_URLS[0], WOLF_GLB_URL);
    assert.equal(new Set(WOLF_COAT_URLS).size, 5, 'URL lar takrorlanmaydi');
  });

  it('2. Shablon coat bo‘yicha alohida: bitta coat tayyor bo‘lsa boshqasi tayyor emas', () => {
    registerWolfTemplateForTest(fakeTemplate(), 2);
    assert.equal(isWolfAssetReady(2), true);
    assert.equal(isWolfAssetReady(0), false);
    assert.equal(isWolfAssetReady(4), false);
    assert.ok(instantiateWolf(2), 'tayyor coat nusxa beradi');
    assert.equal(instantiateWolf(0), null, 'tayyor bo‘lmagan coat null beradi');
  });

  it('3. Noma‘lum coat (diapazondan tashqari / kasr) charcoal ga tushadi; coat siz — barcha variantlar', () => {
    registerWolfTemplateForTest(fakeTemplate(), 0);
    assert.equal(isWolfAssetReady(9), true);
    assert.equal(isWolfAssetReady(-1), true);
    assert.equal(isWolfAssetReady(1.5), true);
    assert.equal(isWolfAssetReady(1), false);
    registerWolfTemplateForTest(fakeTemplate());
    for (let c = 0; c < WOLF_COAT_COUNT; c++) assert.equal(isWolfAssetReady(c), true);
  });
});
