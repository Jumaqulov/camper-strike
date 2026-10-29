import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as THREE from 'three';
import { MATCH_END_DURATION } from '../../../shared/constants';
import type { SurvivalStateSnap } from '../../../shared/survival';
import { NIGHT_DAWN_EPILOGUE_SEC } from '../../../shared/wolf/night';
import {
  WOLF_DEPART_FADE_SEC,
  WolfDepartures,
  dawnEpilogueActive,
  isDawnEnding,
  wolfDepartAlpha,
} from '../night/dawnEpilogue';
import { SurvivalUI } from '../survival/SurvivalUI';

// Tong epilogi: natija varag'i qachon chiqadi (server qolgan vaqti bo'yicha), epilog banneri va
// snapshotdan chiqqan qochoq bo'rilarni so'ndirish. Node, minimal document stubi.

describe('Tong epilogi — vaqt yordamchilari', () => {
  it("1. Epilog: 'ended' + 'dawn' va qolgan vaqt natija ekranidan (MATCH_END_DURATION) ko'p; boshqa hollarda yo'q", () => {
    const total = MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC;
    assert.equal(dawnEpilogueActive({ phase: 'ended', winReason: 'dawn', timeLeft: total }), true, 'tong lahzasi');
    assert.equal(dawnEpilogueActive({ phase: 'ended', winReason: 'dawn', timeLeft: MATCH_END_DURATION + 1 }), true);
    assert.equal(dawnEpilogueActive({ phase: 'ended', winReason: 'dawn', timeLeft: MATCH_END_DURATION }), false, 'natija varag‘i vaqti');
    assert.equal(dawnEpilogueActive({ phase: 'ended', winReason: 'dawn', timeLeft: 0 }), false);
    assert.equal(dawnEpilogueActive({ phase: 'ended', winReason: 'dawn' }), false, "vaqt noma'lum — varaq");
    // Bo'rilar yutdi / boshqa fazalar — epilog yo'q (natija avvalgidek darhol)
    assert.equal(dawnEpilogueActive({ phase: 'ended', winReason: 'draw_no_survivors', timeLeft: total }), false);
    assert.equal(dawnEpilogueActive({ phase: 'playing', winReason: 'none', timeLeft: total }), false);
    assert.equal(dawnEpilogueActive({ phase: 'countdown', winReason: 'dawn', timeLeft: total }), false);
    assert.equal(dawnEpilogueActive(null), false);
    assert.equal(dawnEpilogueActive({ phase: 'ended', winReason: 'dawn', timeLeft: 5 }, 4), true, 'natija ekrani boshqa uzunlikda');
    // Tong yakuni (epilog + natija ekrani) — qarash ochiq; boshqa yakunlarda yo'q
    assert.equal(isDawnEnding({ phase: 'ended', winReason: 'dawn', timeLeft: 3 }), true);
    assert.equal(isDawnEnding({ phase: 'ended', winReason: 'last_standing' }), false);
    assert.equal(isDawnEnding({ phase: 'playing', winReason: 'dawn' }), false);
    assert.equal(isDawnEnding(undefined), false);
  });

  it("2. wolfDepartAlpha: 1 → 0 WOLF_DEPART_FADE_SEC ichida, kamayib boradi, chegaralangan", () => {
    assert.equal(wolfDepartAlpha(0), 1);
    assert.equal(wolfDepartAlpha(WOLF_DEPART_FADE_SEC), 0);
    assert.equal(wolfDepartAlpha(WOLF_DEPART_FADE_SEC * 3), 0);
    assert.equal(wolfDepartAlpha(-1), 1);
    assert.equal(wolfDepartAlpha(Number.NaN), 0);
    assert.ok(Math.abs(wolfDepartAlpha(WOLF_DEPART_FADE_SEC / 2) - 0.5) < 1e-9);
    let prev = 1;
    for (let t = 0.05; t < WOLF_DEPART_FADE_SEC; t += 0.05) {
      const a = wolfDepartAlpha(t);
      assert.ok(a < prev && a > 0, `kamayadi (${t.toFixed(2)} s)`);
      prev = a;
    }
  });
});

describe("Tong epilogi — qochoq bo'rilarni so'ndirish (WolfDepartures)", () => {
  const wolfLike = (mat: THREE.Material) => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
    const eyes = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), [mat, mat]);
    root.add(eyes);
    return { root, body: root.children[0] as THREE.Mesh, eyes };
  };

  it("3. Oxirgi yo'nalishda yuguradi (yer balandligida), material nusxasi so'nadi, asl umumiy material o'zgarmaydi; oxirida bir marta tugaydi", () => {
    const shared = new THREE.MeshStandardMaterial({ color: '#444' });
    const a = wolfLike(shared);
    const b = wolfLike(shared);
    let animated = 0;
    let finished = 0;
    const deps = new WolfDepartures(() => 2);
    deps.add({ root: a.root, yaw: 0, speed: 5, animate: () => animated++, finish: () => finished++ });
    deps.add({ root: b.root, yaw: Math.PI / 2, speed: 0, animate: () => {}, finish: () => finished++ });
    assert.equal(deps.size, 2);

    deps.update(0.1);
    // yaw 0 — oldinga (-sin, -cos) = -Z
    assert.ok(Math.abs(a.root.position.z - -0.5) < 1e-9, `z ${a.root.position.z}`);
    assert.ok(Math.abs(a.root.position.x) < 1e-9);
    assert.equal(a.root.position.y, 2, 'yer balandligida');
    assert.equal(b.root.position.z, 0, "tezligi yo'q — joyida so'nadi");
    assert.equal(animated, 1, 'animatsiya har kadr');
    const clone = a.body.material as THREE.Material;
    assert.notEqual(clone, shared, 'nusxa');
    assert.equal(clone.transparent, true);
    assert.ok(clone.opacity < 1 && clone.opacity > 0.9);
    assert.ok((a.eyes.material as THREE.Material[]).every((m) => m === clone), "massivdagi material ham shu nusxa");
    assert.notEqual(b.body.material, clone, "har bo'riga alohida nusxa");
    assert.equal(shared.transparent, false, 'asl material shaffof bo‘lmadi');
    assert.equal(shared.opacity, 1);

    let disposed = 0;
    clone.addEventListener('dispose', () => disposed++);
    const steps = Math.ceil(WOLF_DEPART_FADE_SEC / 0.1) + 1;
    for (let i = 0; i < steps; i++) deps.update(0.1);
    assert.equal(deps.size, 0);
    assert.equal(finished, 2, 'har biri bir marta tugadi');
    assert.equal(disposed, 1, 'nusxa dispose qilindi');
    assert.equal(shared.opacity, 1);
    deps.update(0.1);
    assert.equal(finished, 2);
  });

  it("4. To'siqqa yetsa to'xtaydi; clear() — hammasi darhol tugaydi", () => {
    const mat = new THREE.MeshStandardMaterial();
    const w = wolfLike(mat);
    let finished = 0;
    const deps = new WolfDepartures(
      () => 0,
      () => true,
    );
    deps.add({ root: w.root, yaw: 0, speed: 6, animate: () => {}, finish: () => finished++ });
    deps.update(0.2);
    assert.equal(w.root.position.z, 0, "devor — oldinga o'tmaydi");
    deps.update(0.2);
    assert.equal(w.root.position.z, 0);
    deps.clear();
    assert.equal(finished, 1);
    assert.equal(deps.size, 0);
    deps.clear();
    assert.equal(finished, 1);
  });
});

// ---------- SurvivalUI: epilog davomida natija varag'i o'rniga "Tong otdi!" belgisi ----------

class FakeEl {
  id = '';
  className = '';
  textContent = '';
  writes = 0;
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private html = '';
  private readonly queried = new Map<string, FakeEl>();
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(v: string) {
    this.writes++;
    this.html = v;
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  querySelector(sel: string): FakeEl {
    let e = this.queried.get(sel);
    if (!e) {
      e = new FakeEl();
      this.queried.set(sel, e);
    }
    return e;
  }
  addEventListener(): void {}
  remove(): void {}
}

let created: FakeEl[];
let prevDocument: PropertyDescriptor | undefined;

beforeEach(() => {
  created = [];
  prevDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: {
      body: new FakeEl(),
      getElementById: () => null,
      createElement: () => {
        const e = new FakeEl();
        created.push(e);
        return e;
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (prevDocument) Object.defineProperty(globalThis, 'document', prevDocument);
  else delete (globalThis as Record<string, unknown>).document;
});

function dawnSnap(over: Partial<SurvivalStateSnap> = {}): SurvivalStateSnap {
  return {
    roundId: 2,
    phase: 'ended',
    timeLeft: MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC,
    minPlayers: 1,
    readyCount: 2,
    readyHumans: 1,
    minHumans: 1,
    contenderIds: ['me', 'b1'],
    aliveIds: ['me', 'b1'],
    spectatorIds: [],
    aliveCount: 2,
    totalContenders: 2,
    winnerId: null,
    winnerName: 'Sardor, Bot Ali',
    winReason: 'dawn',
    statusTextUz: '',
    players: [
      { id: 'me', name: 'Sardor', role: 'contender', alive: true, ready: true, kills: 2, deaths: 0 },
      { id: 'b1', name: 'Bot Ali', role: 'contender', alive: true, ready: true, kills: 5, deaths: 0 },
    ],
    winnerIds: ['me', 'b1'],
    nightSummary: null,
    ...over,
  };
}

const overlayOf = (): FakeEl => {
  const o = created.find((e) => e.id === 'stage07-winner-overlay');
  assert.ok(o, 'winner overlay yaratildi');
  return o;
};

describe('SurvivalUI — tong epilogi', () => {
  it("5. Epilog: faqat 'Tong otdi!' belgisi (jadvalsiz, har soniya qayta yozilmaydi), keyin natija varag'i noldan quriladi", () => {
    const ui = new SurvivalUI({ onCycleSpectatorTarget: () => {}, onToggleCameraPerspective: () => {} });
    ui.setMode('wolf_night');
    ui.setVisible(true);
    const overlay = overlayOf();

    ui.update(dawnSnap(), 'me', null);
    assert.equal(overlay.className, 'is-dawn-epilogue');
    assert.match(overlay.innerHTML, /TONG OTDI!/);
    assert.match(overlay.innerHTML, /Omon qoldingiz/);
    assert.match(overlay.innerHTML, /uvlab o'rmonga qochmoqda/);
    assert.doesNotMatch(overlay.innerHTML, /s07-win-table|s07-night-table|s07-win-footer/, 'natija jadvali hali yo‘q');
    const writes = overlay.writes;
    for (let s = MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC - 1; s > MATCH_END_DURATION; s--) {
      ui.update(dawnSnap({ timeLeft: s }), 'me', null);
    }
    assert.equal(overlay.writes, writes, 'epilog davomida taymer uchun qayta yozilmaydi');
    assert.equal(ui.getDiagnostics().winnerOverlayVisible, true);

    // Epilog tugadi — to'liq varaq (sarlavha, jadval, taymer)
    ui.update(dawnSnap({ timeLeft: MATCH_END_DURATION }), 'me', null);
    assert.equal(overlay.className, '');
    assert.match(overlay.innerHTML, /OMON QOLDINGIZ!/);
    assert.match(overlay.innerHTML, /s07-win-table/);
    assert.match(overlay.innerHTML, /s07-win-footer/);
  });

  it("6. Kuzatuvchiga g'oliblar ismi; bo'rilar yutsa va forest_survival — epilogsiz darhol natija (avvalgidek)", () => {
    const ui = new SurvivalUI({ onCycleSpectatorTarget: () => {}, onToggleCameraPerspective: () => {} });
    ui.setMode('wolf_night');
    ui.setVisible(true);
    const overlay = overlayOf();
    ui.update(dawnSnap(), 'spec', null);
    assert.equal(overlay.className, 'is-dawn-epilogue');
    assert.match(overlay.innerHTML, /Tunni o'tkazganlar: Sardor, Bot Ali/);
    assert.doesNotMatch(overlay.innerHTML, /Omon qoldingiz/);

    const lost = dawnSnap({
      winReason: 'draw_no_survivors',
      winnerIds: [],
      aliveIds: [],
      aliveCount: 0,
      timeLeft: MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC,
    });
    ui.update(lost, 'me', null);
    assert.notEqual(overlay.className, 'is-dawn-epilogue');
    assert.match(overlay.innerHTML, /BO'RILAR YUTDI/);

    ui.setMode('forest_survival');
    ui.update(dawnSnap({ winReason: 'last_standing', winnerId: 'me', winnerName: 'Sardor', winnerIds: undefined }), 'me', null);
    assert.match(overlay.innerHTML, /G'ALABA!/);
  });
});
