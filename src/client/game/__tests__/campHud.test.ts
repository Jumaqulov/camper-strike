import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CAMPFIRE_LOW_FUEL_SEC } from '../../../shared/wolf/camp';
import {
  bearingToArrowDeg,
  bearingToward,
  campWarningTextUz,
  fireIndicatorState,
  fireShortNameUz,
  formatFireIndicatorsUz,
  formatFuelMmSs,
  pickCampWarningFire,
  type FireIndicatorInput,
} from '../survival/campHud';
import { fireIndicatorHtml } from '../survival/SurvivalUI';

// "Tong otguncha" lager HUD'ining sof qismi: yo'nalish (kompas strelkasi), gulxanlar qatori formatlash,
// ogohlantirish uchun eng yomon gulxan va banner matni.

const fire = (over: Partial<FireIndicatorInput> & { id: string }): FireIndicatorInput => ({
  name: '2-lager',
  main: false,
  lit: true,
  fuelSec: 120,
  bearingRad: 0,
  distM: 10,
  ...over,
});

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

describe('campHud — yo‘nalish (bearingToward)', () => {
  it('1. Oldinda 0, chapda +π/2, o‘ngda −π/2, orqada ±π; yaw hisobga olinadi', () => {
    const me = { x: 0, z: 0 };
    near(bearingToward(me, { x: 0, z: -10 }, 0), 0, 1e-9);
    near(bearingToward(me, { x: -10, z: 0 }, 0), Math.PI / 2);
    near(bearingToward(me, { x: 10, z: 0 }, 0), -Math.PI / 2);
    near(Math.abs(bearingToward(me, { x: 0, z: 10 }, 0)), Math.PI);
    // O'yinchi chapga (yaw = +π/2) qaragan — chapdagi nishon endi to'g'ri oldinda
    near(bearingToward(me, { x: -10, z: 0 }, Math.PI / 2), 0);
    // Oldindagi nishon o'ngda ko'rinadi
    near(bearingToward(me, { x: 0, z: -10 }, Math.PI / 2), -Math.PI / 2);
    // Kuzatuvchi nishon ustida — 0 (NaN emas)
    assert.equal(bearingToward(me, { x: 0, z: 0 }, 1.3), 0);
  });

  it('2. Strelka gradusi: chap → manfiy (soat yo‘nalishiga teskari), butun son, −180 → 180', () => {
    assert.equal(bearingToArrowDeg(0), 0);
    assert.equal(bearingToArrowDeg(Math.PI / 2), -90);
    assert.equal(bearingToArrowDeg(-Math.PI / 2), 90);
    assert.equal(bearingToArrowDeg(Math.PI), 180);
    assert.equal(bearingToArrowDeg(-Math.PI), 180);
    assert.equal(bearingToArrowDeg(0.004), 0);
  });
});

describe('campHud — gulxanlar qatori', () => {
  it('3. Holat: yonib/yetarli → ok, ≤ LOW → low, o‘chgan yoki 0 → out', () => {
    assert.equal(fireIndicatorState({ lit: true, fuelSec: CAMPFIRE_LOW_FUEL_SEC + 1 }), 'ok');
    assert.equal(fireIndicatorState({ lit: true, fuelSec: CAMPFIRE_LOW_FUEL_SEC }), 'low');
    assert.equal(fireIndicatorState({ lit: true, fuelSec: 1 }), 'low');
    assert.equal(fireIndicatorState({ lit: true, fuelSec: 0 }), 'out');
    assert.equal(fireIndicatorState({ lit: false, fuelSec: 50 }), 'out');
  });

  it('4. Qisqa nom — birinchi so‘z; m:ss; asosiy birinchi, qolganlari id tartibida', () => {
    assert.equal(fireShortNameUz('Asosiy lager', true), 'Asosiy');
    assert.equal(fireShortNameUz('2-lager', false), '2-lager');
    assert.equal(fireShortNameUz('', true), 'Asosiy');
    assert.equal(fireShortNameUz('', false), 'Lager');
    assert.equal(formatFuelMmSs(150.9), '2:30');
    assert.equal(formatFuelMmSs(5), '0:05');
    assert.equal(formatFuelMmSs(-3), '0:00');
    assert.equal(formatFuelMmSs(Number.NaN), '0:00');

    const views = formatFireIndicatorsUz([
      fire({ id: 'fire:3', name: '3-lager', lit: false, fuelSec: 0, bearingRad: Math.PI / 2, distM: 83.4 }),
      fire({ id: 'fire:1', name: 'Asosiy lager', main: true, fuelSec: 150, bearingRad: 0, distM: 2.2 }),
      fire({ id: 'fire:2', name: '2-lager', fuelSec: 20, bearingRad: -Math.PI / 2, distM: 40.6 }),
    ]);
    assert.deepEqual(
      views.map((v) => [v.id, v.main, v.state, v.tag, v.fuelText, v.distText, v.arrowDeg]),
      [
        ['fire:1', true, 'ok', 'Asosiy', '2:30', '2 m', 0],
        ['fire:2', false, 'low', '2-lager', '0:20', '41 m', 90],
        ['fire:3', false, 'out', '3-lager', '—', '83 m', -90],
      ],
    );
    assert.equal(views[0]!.name, 'Asosiy lager');
    assert.deepEqual(formatFireIndicatorsUz([]), []);
  });

  it('5. Indikator HTML: holat klassi, asosiy yulduzchasi, strelka rotate, nom qochiriladi', () => {
    const [v] = formatFireIndicatorsUz([
      fire({ id: 'fire:1', name: '<b>Asosiy</b> lager', main: true, fuelSec: 95, bearingRad: Math.PI / 2, distM: 12 }),
    ]);
    const html = fireIndicatorHtml(v!);
    assert.match(html, /class="s07-fire is-ok is-main"/);
    assert.match(html, /data-fire="fire:1"/);
    assert.match(html, /<g data-fire="fire:1" transform="rotate\(-90 8 8\)"/);
    assert.match(html, /s07-fire-crown/);
    assert.match(html, /<span class="s07-fire-fuel">1:35<\/span>/);
    assert.match(html, /<span class="s07-fire-dist">12 m<\/span>/);
    assert.doesNotMatch(html, /<b>/);
    assert.ok(html.includes('&lt;b&gt;Asosiy&lt;/b&gt;'));

    const [o] = formatFireIndicatorsUz([fire({ id: 'fire:2', lit: false, fuelSec: 0 })]);
    const out = fireIndicatorHtml(o!);
    assert.match(out, /class="s07-fire is-out"/);
    assert.doesNotMatch(out, /s07-fire-crown/);
    assert.match(out, /s07-fire-x/);
    assert.match(out, /<span class="s07-fire-fuel">—<\/span>/);
  });
});

describe('campHud — ogohlantirish gulxani', () => {
  it('6. O‘chgan o‘chayotgandan, asosiy boshqalardan ustun; hammasi yaxshi — null', () => {
    const main = fire({ id: 'fire:1', name: 'Asosiy lager', main: true });
    const f2 = fire({ id: 'fire:2' });
    const f3 = fire({ id: 'fire:3', name: '3-lager' });
    assert.equal(pickCampWarningFire([main, f2, f3]), null);
    // Faqat 2-lager o'chmoqda
    let w = pickCampWarningFire([main, { ...f2, fuelSec: 10 }, f3]);
    assert.deepEqual([w!.fire.id, w!.level], ['fire:2', 'low']);
    // Asosiy o'chmoqda, 3-lager o'chgan — o'chgan ustun
    w = pickCampWarningFire([{ ...main, fuelSec: 10 }, f2, { ...f3, lit: false, fuelSec: 0 }]);
    assert.deepEqual([w!.fire.id, w!.level], ['fire:3', 'out']);
    // Ikkisi ham o'chgan — asosiy
    w = pickCampWarningFire([{ ...main, lit: false }, f2, { ...f3, lit: false }]);
    assert.deepEqual([w!.fire.id, w!.level], ['fire:1', 'out']);
    // Ikkisi ham o'chmoqda (asosiy emas) — id tartibi
    w = pickCampWarningFire([main, { ...f3, fuelSec: 5 }, { ...f2, fuelSec: 25 }]);
    assert.deepEqual([w!.fire.id, w!.level], ['fire:2', 'low']);
    // Asosiy o'chmoqda, boshqa o'chmoqda — asosiy
    w = pickCampWarningFire([{ ...f2, fuelSec: 3 }, { ...main, fuelSec: 29 }, f3]);
    assert.deepEqual([w!.fire.id, w!.level], ['fire:1', 'low']);
    assert.equal(pickCampWarningFire([]), null);
  });

  it('7. Banner matni gulxanni nomlaydi', () => {
    assert.equal(campWarningTextUz('low', 'Asosiy lager', true), "ASOSIY GULXAN O'CHMOQDA — O'TIN KELTIRING!");
    assert.equal(campWarningTextUz('out', 'Asosiy lager', true), "ASOSIY GULXAN O'CHDI — BO'RILAR KELMOQDA!");
    assert.equal(campWarningTextUz('low', '2-lager', false), "2-LAGER GULXANI O'CHMOQDA — O'TIN KELTIRING!");
    assert.equal(campWarningTextUz('out', '3-lager', false), "3-LAGER GULXANI O'CHDI — BO'RILAR KELMOQDA!");
  });
});
