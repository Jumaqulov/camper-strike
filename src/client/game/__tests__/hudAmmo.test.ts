import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Hud } from '../Hud';

// Hud.setAmmo: ikonkali (base64 <img>) qismlar faqat slot/qurol/granata o'zgarganda qayta yoziladi,
// o'q sonlari esa har o'qda matn sifatida yangilanadi. Node, minimal document stubi.

class FakeEl {
  writes = 0;
  textContent = '';
  private html = '';
  readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    toggle: (c: string, force?: boolean) => {
      if (force ?? !this.classes.has(c)) this.classes.add(c);
      else this.classes.delete(c);
    },
  };
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(v: string) {
    this.writes++;
    this.html = v;
  }
}

let els: Map<string, FakeEl>;
let prevDocument: PropertyDescriptor | undefined;
const el = (id: string): FakeEl => {
  let e = els.get(id);
  if (!e) {
    e = new FakeEl();
    els.set(id, e);
  }
  return e;
};

beforeEach(() => {
  els = new Map();
  prevDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: { getElementById: (id: string) => el(id) },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (prevDocument) Object.defineProperty(globalThis, 'document', prevDocument);
  else delete (globalThis as Record<string, unknown>).document;
});

describe('Hud.setAmmo — ikonkali qismlar faqat kerak bo‘lganda qayta quriladi', () => {
  it('1. O‘q sarflanganda #weapon-slots / qurol nomi / granata qayta yozilmaydi, son yangilanadi', () => {
    const hud = new Hud();
    hud.setAmmo('rifle', 30, 90, false, 2);
    assert.equal(el('weapon-slots').writes, 1);
    assert.equal(el('weapon-name').writes, 1);
    assert.equal(el('grenades').writes, 1);
    assert.equal(el('ammo-mag').textContent, '30');

    for (let mag = 29; mag >= 20; mag--) hud.setAmmo('rifle', mag, 90, false, 2);
    assert.equal(el('weapon-slots').writes, 1, 'slotlar o‘zgarmadi');
    assert.equal(el('weapon-name').writes, 1);
    assert.equal(el('grenades').writes, 1);
    assert.equal(el('ammo-mag').textContent, '20');
    assert.equal(el('ammo-reserve').textContent, '90');
  });

  it('2. Qayta o‘qlash, qurol almashtirish, granata va egalik o‘zgarishi tegishli qismni yangilaydi', () => {
    const hud = new Hud();
    const owned = new Set(['rifle', 'pistol'] as const);
    hud.setAmmo('rifle', 0, 90, false, 2, owned);
    hud.setAmmo('rifle', 0, 90, true, 2, owned);
    assert.equal(el('weapon-name').writes, 2, "o'qlanmoqda matni");
    assert.match(el('weapon-name').innerHTML, /o'qlanmoqda/);
    assert.equal(el('weapon-slots').writes, 1);

    hud.setAmmo('pistol', 12, 36, false, 2, owned);
    assert.equal(el('weapon-slots').writes, 2, 'faol slot o‘zgardi');
    assert.equal(el('weapon-name').writes, 3);

    hud.setAmmo('pistol', 12, 36, false, 1, owned);
    assert.equal(el('grenades').writes, 2);
    assert.match(el('grenades').innerHTML, /×1/);
    assert.equal(el('weapon-slots').writes, 2);

    hud.setAmmo('pistol', 12, 36, false, 1, new Set(['rifle', 'pistol', 'shotgun'] as const));
    assert.equal(el('weapon-slots').writes, 3, 'yangi qurol olindi');

    hud.setAmmo(null, 0, 0, false, 1, owned);
    assert.equal(el('weapon-slots').writes, 4);
    assert.match(el('weapon-name').innerHTML, /Bo'sh qo'l/);
    assert.equal(el('ammo-mag').textContent, '—');
  });

  it('3. reset() dan keyin hammasi qayta chiziladi', () => {
    const hud = new Hud();
    hud.setAmmo('rifle', 30, 90, false, 2);
    hud.reset();
    hud.setAmmo('rifle', 30, 90, false, 2);
    assert.equal(el('weapon-slots').writes, 2);
    assert.equal(el('weapon-name').writes, 2);
    assert.equal(el('grenades').writes, 2);
  });
});
