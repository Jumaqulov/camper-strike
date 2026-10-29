import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room, type ServerCampfire, type ServerPlayer } from '../../server/room';
import { MAX_HP } from '../constants';
import { sampleTerrainHeight } from '../world';
import type { ChatMsg, CreateRoomOpts } from '../protocol';
import {
  NIGHT_DOWNED_BLEED_SEC,
  NIGHT_REVIVE_SEC,
  NIGHT_STAR_TITLES_UZ,
  NIGHT_WAVES,
  TORCH_FUEL_COST_SEC,
  WOLF_COAT_WHITE,
  computeNightSummary,
  formatNightKeepTime,
  nightPlayerScore,
  nightWolvesForWave,
  type NightPlayerStats,
  type NightRoundSummary,
  type NightStarKind,
} from '../wolf';
import { buildNightStatsRowsHtml } from '../../client/game/survival/nightResults';

// Bosqich 33 — "Tong otguncha" natijasi: gulxanni yoqib turgan vaqt (fireKeepSec), u asosidagi "Olov qo'riqchisi"
// va MVP balli, chiqib ketganlar, qat'iy "Hamma tirik qoldi" yulduzi va to'lqin boshlig'ining albatta chiqishi.

interface EmittedRoomEvent {
  room: string;
  event: string;
  payload: unknown;
}

function createFakeIo(): { io: Server; emitted: EmittedRoomEvent[] } {
  const emitted: EmittedRoomEvent[] = [];
  const io = {
    to(room: string) {
      const emitFn = (event: string, payload: unknown) => {
        emitted.push({ room, event, payload });
      };
      return { emit: emitFn, volatile: { emit: emitFn } };
    },
  } as unknown as Server;
  return { io, emitted };
}

function createFakeSocket(id: string): Socket {
  return {
    id,
    join() {},
    leave() {},
    emit() {},
    to() {
      return { emit() {} };
    },
  } as unknown as Socket;
}

function makeNightRoom(io: Server, overrides: Partial<CreateRoomOpts> = {}): Room {
  return new Room(
    {
      name: 'Tong otguncha',
      mode: 'wolf_night',
      mapId: 'forest_square',
      bots: 0,
      maxPlayers: 8,
      timeLimit: 3,
      scoreLimit: 1,
      publicLayoutSeed: 6501,
      countdownSec: 2,
      wolves: 0,
      ...overrides,
    },
    io,
    () => {},
  );
}

/** Odamlar tayyor bo'lib raundni boshlaydi (sanoq 2 s); spawn himoyasi olib tashlanadi. */
function startNight(room: Room, ids: readonly string[]): ServerPlayer[] {
  for (const id of ids) {
    room.addHuman(createFakeSocket(id), id.toUpperCase());
    room.onReady(id, { world: room.worldMeta() });
  }
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  const ps = ids.map((id) => room.players.get(id)!);
  for (const p of ps) p.spawnTime = -99;
  return ps;
}

/**
 * Vaqtni suradi (tick 0.1 s — server dt chegarasi, gulxan aynan shuncha yonadi); `keepAlive` dagilarning joni
 * har qadamda to'ldiriladi. `until` berilsa — shart bajarilganda to'xtaydi.
 */
function tickFor(room: Room, sec: number, keepAlive: readonly ServerPlayer[] = [], until?: () => boolean): void {
  const t0 = room.now();
  while (room.now() - t0 < sec - 1e-6 && room.phase === 'playing') {
    if (until?.()) return;
    room.advanceTimeForTest(0.1, 0.1);
    for (const p of keepAlive) {
      if (p.alive && !p.downed) p.hp = MAX_HP;
      p.vel = { x: 0, y: 0, z: 0 };
    }
  }
}

function mainFire(room: Room): ServerCampfire {
  const f = [...room.campfires.values()].find((c) => c.main);
  assert.ok(f, 'asosiy gulxan bor');
  return f!;
}

/** O'yinchini gulxan yoniga (yetib boradigan masofaga) qo'yadi. */
function standAt(room: Room, p: ServerPlayer, f: ServerCampfire, dx = 1.2): void {
  p.pos = { x: f.x + dx, y: sampleTerrainHeight(room.world.terrain, f.x + dx, f.z), z: f.z };
  p.vel = { x: 0, y: 0, z: 0 };
  p.lastCampAction = -99;
}

function statOf(room: Room, id: string): NightPlayerStats {
  const s = room.getNightStatsForTest().find((x) => x.id === id);
  assert.ok(s, `${id} statistikasi bor`);
  return s!;
}

function systemChats(emitted: EmittedRoomEvent[]): string[] {
  return emitted.filter((e) => e.event === 'chat').map((e) => (e.payload as ChatMsg).text);
}

/** Tong otdiradi (raund vaqti allaqachon o'tgan bo'ladi) va natijani qaytaradi. */
function finishAtDawn(room: Room, keepAlive: readonly ServerPlayer[]): NightRoundSummary {
  room.setSurvivalConfigForTest({ roundDurationSec: 2 });
  tickFor(room, 5, keepAlive);
  assert.equal(room.phase, 'ended');
  const sum = room.getSurvivalState()!.nightSummary;
  assert.ok(sum, 'yakunda nightSummary');
  assert.equal(sum!.dawn, true, 'tong otdi');
  return sum!;
}

const starOf = (sum: NightRoundSummary, kind: NightStarKind): boolean => sum.stars!.find((s) => s.kind === kind)!.earned;

const mk = (id: string, o: Partial<NightPlayerStats> = {}): NightPlayerStats => ({
  id,
  name: id.toUpperCase(),
  isBot: false,
  wolfKills: 0,
  alphaKills: 0,
  wolfDamage: 0,
  logsFed: 0,
  fireKeepSec: 0,
  relights: 0,
  survived: false,
  revives: 0,
  downs: 0,
  deaths: 0,
  ...o,
});

const EPS = 1e-6;

describe('Bosqich 33 — gulxanni yoqib turgan vaqt (server)', () => {
  it("1. Yakka: egasiz o'tin avval yonadi; sig'imdan ortgan qismi yozilmaydi — 1 o'tin (45 s) dan faqat 30 s", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p] = startNight(room, ['p1']);
      // Uzun tun: to'lqin almashmaydi (bo'rilar qaytib kelmaydi)
      room.setSurvivalConfigForTest({ roundDurationSec: 1000 });
      room.wolves.clear();
      const main = mainFire(room);
      main.fuelSec = 150; // egasiz (raund boshidagi kabi)
      standAt(room, p!, main);
      p!.wood = 2;
      const ack = room.onFeedFire('p1', { fireId: main.id });
      assert.equal(ack.ok, true);
      assert.equal(ack.wood, 1, "faqat 1 o'tin sig'di");
      assert.equal(main.fuelSec, 180);
      assert.equal(statOf(room, 'p1').logsFed, 1);
      assert.equal(statOf(room, 'p1').fireKeepSec, 0);

      // Egasiz 150 s yonguncha hech kimga yozilmaydi
      tickFor(room, 200, [p!], () => main.fuelSec <= 35);
      assert.ok(main.fuelSec <= 35 && main.fuelSec > 30, `${main.fuelSec}`);
      assert.ok(statOf(room, 'p1').fireKeepSec < EPS, "egasiz o'tin yonmoqda");
      // Keyin p1 ning ulushi: yongan = 30 − qolgan o'tin
      tickFor(room, 200, [p!], () => main.fuelSec <= 12);
      const mid = statOf(room, 'p1').fireKeepSec;
      assert.ok(Math.abs(mid - (30 - main.fuelSec)) < EPS, `${mid} ≈ ${30 - main.fuelSec}`);
      // O'chguncha: jami 30 s (45 emas)
      tickFor(room, 200, [p!], () => !main.lit);
      assert.equal(main.lit, false);
      assert.ok(Math.abs(statOf(room, 'p1').fireKeepSec - 30) < EPS, `${statOf(room, 'p1').fireKeepSec}`);
      assert.equal(statOf(room, 'p1').relights, 0);
    } finally {
      room.destroy();
    }
  });

  it("2. Ikki o'yinchi: navbat bo'yicha (kim avval tashlasa — o'shaniki avval yonadi); mash'al olgan o'tin hech kimga yozilmaydi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p1, p2] = startNight(room, ['p1', 'p2']);
      room.setSurvivalConfigForTest({ roundDurationSec: 1000 });
      room.wolves.clear();
      const main = mainFire(room);
      main.fuelSec = 10; // egasiz
      standAt(room, p1!, main, 1.2);
      standAt(room, p2!, main, -1.2);
      p1!.wood = 1;
      p2!.wood = 2;
      assert.equal(room.onFeedFire('p1', { fireId: main.id }).fuelSec, 55);
      assert.equal(room.onFeedFire('p2', { fireId: main.id }).fuelSec, 145);

      // 40 s atrofida: egasiz 10 s, keyin p1 ning 45 s dan bir qismi; p2 ga hali navbat kelmadi
      tickFor(room, 200, [p1!, p2!], () => main.fuelSec <= 105);
      const burned = 145 - main.fuelSec;
      assert.ok(Math.abs(statOf(room, 'p1').fireKeepSec - (burned - 10)) < EPS);
      assert.equal(statOf(room, 'p2').fireKeepSec, 0, 'p2 navbati keyin');

      // p2 mash'al oladi: gulxan 10 s o'tin yo'qotadi — hozir yonayotgan (p1) ulushidan, hech kimga yozilmaydi
      p2!.lastCampAction = -99;
      const torch = room.onTakeTorch('p2', { fireId: main.id });
      assert.equal(torch.ok, true, JSON.stringify(torch));
      assert.ok(Math.abs(main.fuelSec - (145 - burned - TORCH_FUEL_COST_SEC)) < EPS);
      // p1 yana 1 o'tin tashlaydi — navbat oxiriga
      p1!.wood = 1;
      p1!.lastCampAction = -99;
      assert.equal(room.onFeedFire('p1', { fireId: main.id }).ok, true);

      // O'chguncha: p1 = 45 − 10 (mash'al) + 45 = 80, p2 = 90; jami = qo'shilgan 180 − mash'al 10
      tickFor(room, 300, [p1!, p2!], () => !main.lit);
      assert.equal(main.lit, false);
      const k1 = statOf(room, 'p1').fireKeepSec;
      const k2 = statOf(room, 'p2').fireKeepSec;
      assert.ok(Math.abs(k1 - 80) < EPS, `p1 ${k1}`);
      assert.ok(Math.abs(k2 - 90) < EPS, `p2 ${k2}`);
      assert.equal(statOf(room, 'p1').logsFed, 2);
      assert.equal(statOf(room, 'p2').logsFed, 2);

      // O'chgan gulxanni qayta yoqish: relights +1, vaqt faqat yongani bo'yicha
      p2!.wood = 1;
      p2!.lastCampAction = -99;
      assert.equal(room.onFeedFire('p2', { fireId: main.id }).fuelSec, 45);
      tickFor(room, 5, [p1!, p2!]);
      const s2 = statOf(room, 'p2');
      assert.equal(s2.relights, 1);
      assert.ok(s2.fireKeepSec > 90 && s2.fireKeepSec < 96, `${s2.fireKeepSec}`);

      // Natijada butun soniya va "Olov qo'riqchisi" — eng ko'p yoqib turgan (p2)
      const sum = finishAtDawn(room, [p1!, p2!]);
      const byId = new Map(sum.stats.map((s) => [s.id, s] as const));
      assert.equal(byId.get('p1')!.fireKeepSec, 80);
      assert.ok(Number.isInteger(byId.get('p2')!.fireKeepSec));
      const keeper = sum.awards.find((a) => a.kind === 'firekeeper')!;
      assert.equal(keeper.playerId, 'p2');
      assert.equal(keeper.value, byId.get('p2')!.fireKeepSec);
    } finally {
      room.destroy();
    }
  });

  it('3. Keyingi raundda hisob noldan (ulushlar navbati ham tozalanadi)', () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p] = startNight(room, ['p1']);
      room.wolves.clear();
      const main = mainFire(room);
      main.fuelSec = 0.5;
      standAt(room, p!, main);
      p!.wood = 1;
      assert.equal(room.onFeedFire('p1', { fireId: main.id }).ok, true);
      tickFor(room, 3, [p!]);
      assert.ok(statOf(room, 'p1').fireKeepSec > 2);
      finishAtDawn(room, [p!]);
      // Natija ekrani (tong epilogi bilan) va yangi sanoq → keyingi raund
      for (let i = 0; i < 400 && room.phase !== 'playing'; i++) room.advanceTimeForTest(0.25, 0.25);
      assert.equal(room.phase, 'playing');
      assert.equal(statOf(room, 'p1').fireKeepSec, 0);
      assert.equal(statOf(room, 'p1').deaths, 0);
      room.wolves.clear();
      tickFor(room, 3, [p!]);
      assert.equal(statOf(room, 'p1').fireKeepSec, 0, "o'tgan tunning ulushi yangi gulxanda yonmaydi");
    } finally {
      room.destroy();
    }
  });
});

describe('Bosqich 33 — MVP balli va mukofotlar (sof)', () => {
  it("4. Qayta yoqish ball bermaydi; o'chirmay saqlagan (ko'proq yongan) qayta yoqqandan yuqori; olov qo'riqchisi — vaqt bo'yicha", () => {
    assert.equal(nightPlayerScore(mk('r', { relights: 10 })), 0, 'qayta yoqishning o‘zi — 0 ball');
    assert.equal(nightPlayerScore(mk('k', { fireKeepSec: 59 })), 1, 'har 30 s +1');
    assert.equal(nightPlayerScore(mk('k', { fireKeepSec: 60 })), 2);
    // Bir xil o'tin: biri gulxanni o'chirmadi (270 s yondi), boshqasi 3 marta o'chirib qayta yoqdi (200 s yondi)
    const keeper = mk('keeper', { logsFed: 6, fireKeepSec: 270, survived: true });
    const relighter = mk('relighter', { logsFed: 6, relights: 3, fireKeepSec: 200, survived: true });
    const sum = computeNightSummary([relighter, keeper], 'normal', true);
    assert.deepEqual(sum.stats.map((s) => s.id), ['keeper', 'relighter']);
    assert.equal(nightPlayerScore(keeper), 6 * 2 + 9 + 4);
    assert.equal(nightPlayerScore(relighter), 6 * 2 + 6 + 4);
    const fk = sum.awards.find((a) => a.kind === 'firekeeper')!;
    assert.equal(fk.playerId, 'keeper');
    assert.equal(fk.value, 270);
    assert.equal(sum.awards.find((a) => a.kind === 'mvp')!.playerId, 'keeper');
    // Hech kim yoqib turmagan (faqat qayta yoqish bor) — olov qo'riqchisi yo'q
    const none = computeNightSummary([mk('a', { relights: 4, logsFed: 4 })], 'normal', true);
    assert.equal(none.awards.find((a) => a.kind === 'firekeeper'), undefined);
    // Kasr soniya yaxlitlanadi
    assert.equal(computeNightSummary([mk('a', { fireKeepSec: 44.6 })], 'easy', true).awards.find((a) => a.kind === 'firekeeper')!.value, 45);
    assert.equal(formatNightKeepTime(135), '2:15');
    assert.equal(formatNightKeepTime(0), '0:00');
    assert.equal(formatNightKeepTime(3599.6), '60:00');
    assert.equal(formatNightKeepTime(-5), '0:00');
    assert.equal(formatNightKeepTime(Number.NaN), '0:00');
  });

  it('5. Chiqib ketgan mukofot olmaydi (MVP ham), jadvalda oxirida; qolganlar o‘z mukofotini oladi', () => {
    const sum = computeNightSummary(
      [
        mk('gone', { wolfKills: 10, alphaKills: 1, logsFed: 9, fireKeepSec: 500, revives: 2, left: true }),
        mk('a', { wolfKills: 2, survived: true }),
        mk('b', { logsFed: 1, fireKeepSec: 40, survived: true }),
      ],
      'hard',
      true,
    );
    assert.deepEqual(sum.stats.map((s) => s.id), ['a', 'b', 'gone']);
    assert.ok(sum.awards.every((a) => a.playerId !== 'gone'), JSON.stringify(sum.awards));
    assert.deepEqual(
      sum.awards.map((a) => [a.kind, a.playerId]),
      [
        ['mvp', 'a'],
        ['hunter', 'a'],
        ['woodsman', 'b'],
        ['firekeeper', 'b'],
      ],
    );
  });
});

describe('Bosqich 33 — xona: chiqib ketganlar va "Hamma tirik qoldi" yulduzi', () => {
  it("6. O'tin tashlab chiqib ketgan: natijada left, survived yo'q, oxirida; mukofot yo'q; jadvalda 'Chiqib ketdi'", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p1, p2] = startNight(room, ['p1', 'p2']);
      room.wolves.clear();
      const main = mainFire(room);
      main.fuelSec = 10;
      standAt(room, p2!, main);
      p2!.wood = 2;
      assert.equal(room.onFeedFire('p2', { fireId: main.id }).ok, true);
      tickFor(room, 1, [p1!, p2!]);
      room.removePlayer('p2');
      assert.equal(room.phase, 'playing');
      // Chiqib ketgandan keyin ham uning o'tini yonadi (statistikada qoladi)
      tickFor(room, 20, [p1!]);
      assert.ok(statOf(room, 'p2').fireKeepSec > 5);
      const sum = finishAtDawn(room, [p1!]);
      assert.deepEqual(sum.stats.map((s) => s.id), ['p1', 'p2']);
      const gone = sum.stats[1]!;
      assert.equal(gone.left, true);
      assert.equal(gone.survived, false);
      assert.equal(gone.logsFed, 2);
      assert.equal(sum.stats[0]!.left, undefined, 'qolgan o‘yinchida left yo‘q');
      assert.ok(sum.awards.every((a) => a.playerId !== 'p2'), JSON.stringify(sum.awards));
      assert.equal(sum.awards.find((a) => a.kind === 'mvp')!.playerId, 'p1');
      assert.equal(sum.awards.find((a) => a.kind === 'woodsman'), undefined, "o'tinchi chiqib ketgan — mukofot yo'q");
      assert.equal(starOf(sum, 'all_alive'), true, "tirik holda chiqib ketgan — yulduzga ta'sir qilmaydi");
      const rows = buildNightStatsRowsHtml(sum, 'p1').split('<tr').slice(1);
      assert.match(rows[1]!, /Chiqib ketdi/);
      assert.doesNotMatch(rows[1]!, /Halok bo'ldi/);
    } finally {
      room.destroy();
    }
  });

  it("7. Hamma qirilib, to'lqinda qaytib, tongda tirik — 'Hamma tirik qoldi' yo'q (deaths hisoblanadi)", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p] = startNight(room, ['p1']);
      // Tun 40 s: 2-to'lqin 10 s da — halok bo'lgan gulxan yonida qaytadi
      room.setSurvivalConfigForTest({ roundDurationSec: 40 });
      const w = [...room.wolves.values()][0]!;
      room.damageForTest(p!, w, MAX_HP, 'wolf');
      assert.equal(p!.alive, false);
      assert.equal(room.phase, 'playing', "asosiy gulxan yonmoqda — raund davom etadi");
      assert.equal(statOf(room, 'p1').deaths, 1);
      tickFor(room, 12, [], () => p!.alive);
      assert.equal(p!.alive, true, "2-to'lqinda qaytdi");
      tickFor(room, 40, [p!]);
      assert.equal(room.phase, 'ended');
      const sum = room.getSurvivalState()!.nightSummary!;
      assert.equal(sum.dawn, true);
      assert.equal(sum.stats[0]!.survived, true, 'tongda tirik');
      assert.equal(sum.stats[0]!.deaths, 1);
      assert.equal(starOf(sum, 'all_alive'), false, "tunda halok bo'lgan — yulduz yo'q");
      assert.equal(starOf(sum, 'fire_kept'), true);
      assert.ok(!systemChats(emitted).some((t) => t.startsWith('⭐') && t.includes(NIGHT_STAR_TITLES_UZ.all_alive)));
    } finally {
      room.destroy();
    }
  });

  it("8. Yiqilib turg'izilgan — 'Hamma tirik qoldi' bor (downs 1, deaths 0)", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p1, p2] = startNight(room, ['p1', 'p2']);
      const w = [...room.wolves.values()][0]!;
      room.damageForTest(p1!, w, MAX_HP, 'wolf');
      assert.equal(p1!.downed, true);
      room.wolves.clear();
      p2!.pos = { x: p1!.pos.x + 1.5, y: p1!.pos.y, z: p1!.pos.z };
      p2!.lastCampAction = -99;
      assert.equal(room.onRevive('p2', { targetId: 'p1' }).ok, true);
      tickFor(room, NIGHT_REVIVE_SEC + 0.3, [p2!]);
      assert.equal(p1!.downed, false, "turg'izildi");
      const sum = finishAtDawn(room, [p1!, p2!]);
      const s1 = sum.stats.find((s) => s.id === 'p1')!;
      assert.equal(s1.downs, 1);
      assert.equal(s1.deaths, 0);
      assert.equal(starOf(sum, 'all_alive'), true);
    } finally {
      room.destroy();
    }
  });

  it("9. Qon ketib halok bo'lib, keyin chiqib ketgan — 'Hamma tirik qoldi' yo'q; natijada 'chiqib ketgan'", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p1, p2] = startNight(room, ['p1', 'p2']);
      const w = [...room.wolves.values()][0]!;
      room.damageForTest(p1!, w, MAX_HP, 'wolf');
      assert.equal(p1!.downed, true);
      room.wolves.clear();
      tickFor(room, NIGHT_DOWNED_BLEED_SEC + 1, [p2!]);
      assert.equal(p1!.alive, false, "qon ketib o'ldi");
      assert.equal(statOf(room, 'p1').deaths, 1);
      room.removePlayer('p1');
      const sum = finishAtDawn(room, [p2!]);
      const gone = sum.stats.find((s) => s.id === 'p1')!;
      assert.equal(gone.left, true);
      assert.equal(gone.deaths, 1);
      assert.equal(sum.stats.find((s) => s.id === 'p2')!.survived, true);
      assert.equal(starOf(sum, 'all_alive'), false, "halok bo'lib chiqib ketgan — o'limi hisoblanadi");
    } finally {
      room.destroy();
    }
  });

  it("9b. Yiqilgan holda (qon ketishi tugamay) chiqib ketgan — o'lim hisoblanadi, 'Hamma tirik qoldi' yo'q", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p1, p2] = startNight(room, ['p1', 'p2']);
      const w = [...room.wolves.values()][0]!;
      room.damageForTest(p1!, w, MAX_HP, 'wolf');
      assert.equal(p1!.downed, true);
      room.wolves.clear();
      room.removePlayer('p1');
      const sum = finishAtDawn(room, [p2!]);
      const gone = sum.stats.find((s) => s.id === 'p1')!;
      assert.equal(gone.left, true);
      assert.equal(gone.deaths, 1);
      assert.equal(starOf(sum, 'all_alive'), false, "yiqilib chiqib ketgan — o'limi hisoblanadi");
    } finally {
      room.destroy();
    }
  });
});

describe("Bosqich 33 — to'lqin boshlig'i albatta chiqadi", () => {
  it("10. Oson, yakka o'yinchi: 3-to'lqinda bo'rilar soni o'smaydi (2 → 2), lekin oq bo'ri darhol keladi — son o'zgarmaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { nightDifficulty: 'easy' });
    try {
      const [p] = startNight(room, ['p1']);
      const want = nightWolvesForWave(NIGHT_WAVES[2]!, 1, 'easy');
      assert.equal(want, nightWolvesForWave(NIGHT_WAVES[1]!, 1, 'easy'), "3-to'lqinda son o'smaydi (shart)");
      // Tun 40 s: 3-to'lqin 20 s da
      room.setSurvivalConfigForTest({ roundDurationSec: 40 });
      tickFor(room, 25, [p!], () => room.currentNightWaveIdx() >= 1);
      assert.equal(room.currentNightWaveIdx(), 1);
      const alive = () => [...room.wolves.values()].filter((w) => w.alive);
      assert.ok(!alive().some((w) => w.coat === WOLF_COAT_WHITE), "2-to'lqinda oq bo'ri yo'q");
      const chatsBefore = systemChats(emitted).length;
      tickFor(room, 25, [p!], () => room.currentNightWaveIdx() >= 2);
      assert.equal(room.currentNightWaveIdx(), 2, "3-to'lqin boshlandi");
      const whites = alive().filter((w) => w.coat === WOLF_COAT_WHITE);
      assert.equal(whites.length, 1, "to'lqin boshlig'i darhol keldi");
      assert.equal(room.wolves.size, want, "son o'zgarmadi — oddiy bo'ri o'rniga");
      assert.equal(alive().length, want);
      const chats = systemChats(emitted).slice(chatsBefore);
      assert.ok(chats.some((t) => t.startsWith("🐺 To'da boshlig'i keldi — bu to'lqin boshlig'i!")), chats.join(' | '));
      // O'yinchidan uzoqda paydo bo'ldi
      assert.ok(Math.hypot(whites[0]!.pos.x - p!.pos.x, whites[0]!.pos.z - p!.pos.z) > 20);
      assert.equal(NIGHT_STAR_TITLES_UZ.alpha_slain, "To'lqin boshlig'i o'ldirildi");
    } finally {
      room.destroy();
    }
  });
});
