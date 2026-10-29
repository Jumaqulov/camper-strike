import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import { MAX_HP } from '../constants';
import type { ChatMsg, CreateRoomOpts, KillEvent, MatchState, Snapshot, SpawnEvent } from '../protocol';
import {
  NIGHT_AWARD_TITLES_UZ,
  NIGHT_DOWNED_BLEED_SEC,
  NIGHT_REVIVE_HP,
  NIGHT_REVIVE_RANGE_M,
  NIGHT_REVIVE_SEC,
  computeNightSummary,
  type NightPlayerStats,
  type NightRevivedEvent,
  type ReviveAck,
} from '../wolf';
import { evaluateSurvivalRoundOutcome } from '../survival';
import { buildNightAwardsHtml } from '../../client/game/survival/nightResults';

// Bosqich 20 — Tong otguncha: yiqilish (downed) + turg'izish (revive) va to'lqin boshida qayta tirilish.
// Xona haqiqiy Room, io/socket soxta; vaqt room.advanceTimeForTest bilan deterministik suriladi.

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

function createFakeSocket(id: string): { socket: Socket; events: { event: string; payload: unknown }[] } {
  const events: { event: string; payload: unknown }[] = [];
  const socket = {
    id,
    join() {},
    leave() {},
    emit(event: string, payload: unknown) {
      events.push({ event, payload });
    },
    to() {
      return { emit() {} };
    },
  } as unknown as Socket;
  return { socket, events };
}

function makeNightRoom(io: Server, overrides: Partial<CreateRoomOpts> = {}): Room {
  return new Room(
    {
      name: 'Tong otguncha',
      mode: 'wolf_night',
      mapId: 'forest_square',
      bots: 0,
      maxPlayers: 8,
      timeLimit: 4,
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

/** Yakka odam tayyor bo'lib raundni boshlaydi (sanoq 2 s). */
function startSoloNight(room: Room, id = 'p1', name = 'Ovchi') {
  const s = createFakeSocket(id);
  room.addHuman(s.socket, name);
  room.onReady(id, { world: room.worldMeta() });
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  return { socket: s, p: room.players.get(id)! };
}

/** Ikki odam tayyor bo'lib raundni boshlaydi (sanoq 2 s). */
function startDuoNight(room: Room) {
  const s1 = createFakeSocket('p1');
  const s2 = createFakeSocket('p2');
  room.addHuman(s1.socket, 'Ovchi');
  room.addHuman(s2.socket, 'Sherik');
  room.onReady('p1', { world: room.worldMeta() });
  room.onReady('p2', { world: room.worldMeta() });
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  const p1 = room.players.get('p1')!;
  const p2 = room.players.get('p2')!;
  p1.spawnTime = -99;
  p2.spawnTime = -99;
  return { p1, p2, s1, s2 };
}

/** Vaqtni suradi; `keepAlive` dagilarning joni har qadamda to'ldiriladi (bo'ri tishlab o'ldirmasin). */
function tickFor(room: Room, sec: number, keepAlive: ServerPlayer[] = [], step = 0.25): void {
  let left = sec;
  while (left > 1e-6 && room.phase === 'playing') {
    const d = Math.min(step, left);
    room.advanceTimeForTest(d, 1 / 30);
    for (const p of keepAlive) {
      if (p.alive && !p.downed) p.hp = MAX_HP;
      p.vel = { x: 0, y: 0, z: 0 };
    }
    left -= d;
  }
}

function systemChats(emitted: EmittedRoomEvent[]): string[] {
  return emitted.filter((e) => e.event === 'chat').map((e) => (e.payload as ChatMsg).text);
}

function kills(emitted: EmittedRoomEvent[]): KillEvent[] {
  return emitted.filter((e) => e.event === 'kill').map((e) => e.payload as KillEvent);
}

function lastSnap(emitted: EmittedRoomEvent[]): Snapshot {
  const s = emitted.filter((e) => e.event === 'snap').pop()?.payload as Snapshot | undefined;
  assert.ok(s, 'snap hodisasi yuborilgan');
  return s!;
}

function lastMatch(emitted: EmittedRoomEvent[]): MatchState {
  const m = emitted.filter((e) => e.event === 'match').pop()?.payload as MatchState | undefined;
  assert.ok(m, 'match hodisasi yuborilgan');
  return m!;
}

function firstWolf(room: Room): ServerWolf {
  const w = [...room.wolves.values()][0];
  assert.ok(w, "xonada bo'ri bor");
  return w!;
}

function mainFire(room: Room) {
  const f = [...room.campfires.values()].find((c) => c.main);
  assert.ok(f, 'asosiy gulxan bor');
  return f!;
}

/** p2 ni p1 yonida (d m, bir xil balandlik) turg'izadi. */
function placeNear(p1: ServerPlayer, p2: ServerPlayer, d: number): void {
  p2.pos = { x: p1.pos.x + d, y: p1.pos.y, z: p1.pos.z };
  p2.vel = { x: 0, y: 0, z: 0 };
}

describe('Bosqich 20 — Tong otguncha: yiqilish, turg\'izish va to\'lqinda qaytish', () => {
  it("1. Ikki kishilik tunda joni tugagan o'yinchi o'lmaydi — yiqiladi: hp 0, alive, snapshotda downed/bleedSec, bo'ri ovlamaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p1, p2 } = startDuoNight(room);
      const w = firstWolf(room);
      p1.wood = 2;
      p1.weapon = 'rifle';
      room.damageForTest(p1, w, MAX_HP, 'wolf');
      assert.equal(p1.downed, true, 'yiqildi');
      assert.equal(p1.alive, true, "o'lmadi");
      assert.equal(p1.hp, 0);
      assert.equal(p1.wood, 2, "o'tin saqlanadi");
      assert.equal(p1.weapon, 'rifle', 'qurol saqlanadi');
      assert.equal(kills(emitted).length, 0, "o'lim hodisasi yo'q");
      assert.equal(room.isWolfPrey(p1), false, "yiqilgan — bo'ri ovi emas");
      assert.equal(room.isWolfPrey(p2), true);
      assert.equal(room.survival!.isAliveContender('p1'), true, 'hali tirik ishtirokchi');
      assert.ok(systemChats(emitted).some((t) => t.includes('Ovchi yiqildi')));
      // Yiqilganga zarar yo'q: bo'ri tishlasa ham hp 0 da qoladi, o'lmaydi
      w.pos = { x: p1.pos.x + 1, y: p1.pos.y, z: p1.pos.z };
      room.wolfBite(w, p1);
      room.damageForTest(p1, w, 50, 'wolf');
      assert.equal(p1.alive, true);
      assert.equal(p1.downed, true);
      assert.equal(kills(emitted).length, 0);
      // Lager va loot amallari rad etiladi
      const pile = [...room.woodPiles.values()][0]!;
      p1.pos = { x: pile.x, y: pile.y, z: pile.z };
      assert.equal(room.onTakeWood('p1', { pileId: pile.id }).error, 'DOWNED');
      assert.equal(room.onUseMedkit('p1', { requestId: 'r1', roundId: 1, spawnId: p1.spawnId }).code, 'PLAYER_DEAD');
      room.advanceTimeForTest(0.2, 1 / 30);
      const me = lastSnap(emitted).players.find((s) => s.id === 'p1')!;
      assert.equal(me.downed, true);
      assert.equal(me.alive, true);
      assert.equal(me.hp, 0);
      assert.ok(me.bleedSec !== undefined && me.bleedSec <= NIGHT_DOWNED_BLEED_SEC && me.bleedSec >= NIGHT_DOWNED_BLEED_SEC - 1);
      assert.equal(me.reviveK, undefined, "hali hech kim turg'izmayapti");
      const other = lastSnap(emitted).players.find((s) => s.id === 'p2')!;
      assert.equal(other.downed, undefined, 'tik turgan sherikda maydon yuborilmaydi');
      assert.equal(room.getNightStatsForTest().find((s) => s.id === 'p1')!.downs, 1);
      assert.equal(room.phase, 'playing');
    } finally {
      room.destroy();
    }
  });

  it("2. Yakka o'yinchi (turg'izadigan yo'q) yiqilmaydi — darhol o'ladi; qotil bo'ri, weapon='wolf'", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      p.spawnTime = -99;
      const w = firstWolf(room);
      room.damageForTest(p, w, MAX_HP, 'wolf');
      assert.equal(p.alive, false, "darhol o'ldi");
      assert.equal(p.downed, false);
      const k = kills(emitted);
      assert.equal(k.length, 1);
      assert.equal(k[0]!.weapon, 'wolf');
      assert.equal(k[0]!.killer, w.id);
      assert.equal(k[0]!.victim, 'p1');
      assert.equal(room.getNightStatsForTest()[0]!.downs, 0, "yiqilish hisoblanmaydi");
    } finally {
      room.destroy();
    }
  });

  it("3. Qon ketish: NIGHT_DOWNED_BLEED_SEC ichida turg'izilmasa o'ladi — qotil yiqitgan bo'ri; sherik tirik qoladi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p1, p2 } = startDuoNight(room);
      const w = firstWolf(room);
      room.damageForTest(p1, w, MAX_HP, 'wolf');
      assert.equal(p1.downed, true);
      // Bo'rilar yo'q — sherik xotirjam kutadi; faqat vaqt o'tadi
      room.wolves.clear();
      tickFor(room, NIGHT_DOWNED_BLEED_SEC - 1, [p2]);
      assert.equal(p1.alive, true, '29 s da hali tirik');
      assert.equal(p1.downed, true);
      tickFor(room, 1.5, [p2]);
      assert.equal(p1.alive, false, "30 s dan keyin qon ketib o'ldi");
      assert.equal(p1.downed, false);
      const k = kills(emitted);
      assert.equal(k.length, 1);
      assert.equal(k[0]!.killer, w.id, "qotil — yiqitgan bo'ri");
      assert.equal(k[0]!.weapon, 'wolf');
      assert.equal(room.survival!.isAliveContender('p1'), false);
      assert.equal(room.survival!.isAliveContender('p2'), true);
      assert.equal(room.phase, 'playing', 'sherik tirik — raund davom etadi');
      assert.equal(room.getNightStatsForTest().find((s) => s.id === 'p1')!.downs, 1);
    } finally {
      room.destroy();
    }
  });

  it("4. Turg'izish: masofada [E] → 3 s da tik turadi (hp 40, qurol/o'tin saqlanadi); sherik ketsa jarayon 0 ga tushadi; hodisa va statistika", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p1, p2 } = startDuoNight(room);
      const w = firstWolf(room);
      p1.wood = 1;
      p1.weapon = 'pistol';
      room.damageForTest(p1, w, MAX_HP, 'wolf');
      assert.equal(p1.downed, true);
      room.wolves.clear();

      // Uzoqdan — TOO_FAR; o'zini — SELF; yiqilmaganni — NOT_DOWNED
      placeNear(p1, p2, NIGHT_REVIVE_RANGE_M + 2);
      assert.deepEqual(room.onRevive('p2', { targetId: 'p1' }), { ok: false, error: 'TOO_FAR' } satisfies ReviveAck);
      assert.equal(room.onRevive('p2', { targetId: 'p2' }).error, 'SELF');
      assert.equal(room.onRevive('p1', { targetId: 'p2' }).error, 'ROUND_NOT_ACTIVE', "yiqilgan o'zi turg'iza olmaydi");
      // Yonida: kanal boshlanadi, jarayon o'sadi
      placeNear(p1, p2, 1.5);
      assert.deepEqual(room.onRevive('p2', { targetId: 'p1' }), { ok: true });
      tickFor(room, 1.5, [p2], 0.1);
      assert.equal(p1.downed, true);
      const mid = lastSnap(emitted).players.find((s) => s.id === 'p1')!;
      assert.ok(mid.reviveK !== undefined && mid.reviveK > 0.3 && mid.reviveK < 0.7, `jarayon ~0.5 (${mid.reviveK})`);
      // Sherik uzoqlashdi — jarayon 0 ga tushadi, kanal yopiladi
      placeNear(p1, p2, NIGHT_REVIVE_RANGE_M + 3);
      tickFor(room, 0.3, [p2], 0.1);
      assert.equal(p1.downed, true);
      assert.equal(p1.reviveBy, null);
      assert.equal(p1.reviveProgress, 0);
      assert.equal(lastSnap(emitted).players.find((s) => s.id === 'p1')!.reviveK, undefined);
      // Qaytib kelib yana boshlaydi — 3 s dan keyin tik turadi
      placeNear(p1, p2, 1.5);
      p2.lastCampAction = -99;
      assert.equal(room.onRevive('p2', { targetId: 'p1' }).ok, true);
      tickFor(room, NIGHT_REVIVE_SEC + 0.3, [p2], 0.1);
      assert.equal(p1.downed, false, "turg'izildi");
      assert.equal(p1.alive, true);
      assert.equal(p1.hp, NIGHT_REVIVE_HP);
      assert.equal(p1.wood, 1, "o'tin saqlandi");
      assert.equal(p1.weapon, 'pistol', 'qurol saqlandi');
      assert.equal(room.isWolfPrey(p1), true, "yana bo'ri ovi");
      assert.equal(kills(emitted).length, 0);
      const ev = emitted.find((e) => e.event === 'night:revived')?.payload as NightRevivedEvent | undefined;
      assert.ok(ev, "'night:revived' hodisasi");
      assert.equal(ev!.id, 'p1');
      assert.equal(ev!.byId, 'p2');
      assert.equal(ev!.byName, 'Sherik');
      assert.ok(systemChats(emitted).some((t) => t.includes("Sherik Ovchini turg'izdi")));
      const stats = room.getNightStatsForTest();
      assert.equal(stats.find((s) => s.id === 'p2')!.revives, 1);
      assert.equal(stats.find((s) => s.id === 'p1')!.downs, 1);
      // Turg'izilgandan keyin qisqa himoya: darhol zarar yo'q
      room.damageForTest(p1, p2, 10, 'rifle');
      assert.equal(p1.hp, NIGHT_REVIVE_HP, "himoya davrida (va do'stona o't yo'q)");
      const snapP1 = lastSnap(emitted).players.find((s) => s.id === 'p1')!;
      assert.equal(snapP1.downed, undefined);
    } finally {
      room.destroy();
    }
  });

  it("5. Oxirgi tik turgan ham yiqilsa — turg'izadigan yo'q: hamma darhol o'ladi; gulxan o'chgan bo'lsa raund 'draw_no_survivors'", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p1, p2 } = startDuoNight(room);
      const w = firstWolf(room);
      const main = mainFire(room);
      main.lit = false;
      main.fuelSec = 0;
      room.damageForTest(p1, w, MAX_HP, 'wolf');
      assert.equal(p1.downed, true);
      room.damageForTest(p2, w, MAX_HP, 'wolf');
      assert.equal(p2.alive, false, "oxirgi tik turgan — darhol o'ladi");
      assert.equal(p1.alive, false, "yiqilgan ham qon ketib o'ldi (turg'izadigan yo'q)");
      assert.equal(kills(emitted).length, 2);
      assert.equal(room.phase, 'ended');
      assert.equal(room.getSurvivalState()!.winReason, 'draw_no_survivors');
    } finally {
      room.destroy();
    }
  });

  it("6. Hamma o'lsa, asosiy gulxan yonib tursa va oldinda to'lqin bo'lsa — raund tugamaydi; to'lqin boshida gulxan yonida qaytadi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { socket, p } = startSoloNight(room);
      // Tun 40 s: 2-to'lqin 10 s da
      room.setSurvivalConfigForTest({ roundDurationSec: 40 });
      p.spawnTime = -99;
      const w = firstWolf(room);
      room.damageForTest(p, w, MAX_HP, 'wolf');
      assert.equal(p.alive, false);
      assert.equal(room.phase, 'playing', "gulxan yonib turibdi, 2-to'lqin oldinda — raund tugamaydi");
      assert.equal(room.getSurvivalState()!.aliveCount, 0);
      assert.equal(room.survival!.getPlayerRole('p1'), 'eliminated');
      const spawnsBefore = socket.events.filter((e) => e.event === 'spawn').length;
      // 2-to'lqingacha kutamiz (o'lik — joni to'ldirilmaydi)
      const t0 = room.now();
      while (room.now() - t0 < 12 && !p.alive && room.phase === 'playing') room.advanceTimeForTest(0.25, 1 / 30);
      assert.equal(p.alive, true, "2-to'lqin boshida qaytdi");
      assert.equal(p.hp, MAX_HP);
      assert.equal(p.wood, 0);
      assert.equal(p.weapon, null, 'tun boshidagi yuklama — qurolsiz');
      assert.equal(room.survival!.isAliveContender('p1'), true);
      assert.equal(room.survival!.getPlayerRole('p1'), 'contender');
      assert.equal(room.survival!.getPlacement('p1'), undefined, "o'rin yozuvi tozalandi");
      const main = mainFire(room);
      assert.ok(Math.hypot(p.pos.x - main.x, p.pos.z - main.z) < 6, 'asosiy gulxan yonida');
      const spawnEvents = socket.events.filter((e) => e.event === 'spawn');
      assert.equal(spawnEvents.length, spawnsBefore + 1, "klientga 'spawn' hodisasi");
      assert.equal((spawnEvents.at(-1)!.payload as SpawnEvent).spawnId, p.spawnId);
      assert.ok(systemChats(emitted).some((t) => t.includes("2-to'lqin: halok bo'lganlar gulxan yonida qaytdi")));
      assert.equal(lastMatch(emitted).survival?.aliveCount, 1);
      assert.equal(room.phase, 'playing');
    } finally {
      room.destroy();
    }
  });

  it("7. Asosiy gulxan o'chgan bo'lsa to'lqin boshida hech kim qaytmaydi (chat); hamma o'lgan bo'lsa raund darhol tugaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p1, p2 } = startDuoNight(room);
      // Tun 120 s: to'lqinlar 30/60/90 s da
      room.setSurvivalConfigForTest({ roundDurationSec: 120 });
      const w = firstWolf(room);
      // p1 yiqiladi (2-to'lqin boshida hali tirik — qaytish kerak emas) va ~33 s da qon ketib o'ladi (p2 tirik)
      room.damageForTest(p1, w, MAX_HP, 'wolf');
      room.wolves.clear();
      tickFor(room, NIGHT_DOWNED_BLEED_SEC + 0.5, [p2]);
      assert.equal(p1.alive, false);
      assert.equal(room.phase, 'playing');
      // Gulxan o'chadi — 3-to'lqin (60 s) boshida hech kim qaytmaydi
      const main = mainFire(room);
      main.lit = false;
      main.fuelSec = 0;
      const chatsBefore = systemChats(emitted).length;
      tickFor(room, 32, [p2]);
      assert.equal(p1.alive, false, "gulxan o'chgan — qaytmadi");
      assert.equal(room.survival!.getPlayerRole('p1'), 'eliminated');
      const chats = systemChats(emitted).slice(chatsBefore);
      assert.ok(chats.some((t) => t.includes("3-to'lqin: bo'rilar ko'paydi")), "3-to'lqin boshlandi");
      assert.ok(chats.some((t) => t.includes("asosiy gulxan o'chgan — halok bo'lganlar qaytmadi")), 'chatda sabab');
      assert.equal(room.phase, 'playing', 'p2 tirik — raund davom etadi');
      // Endi p2 ham o'lsa — gulxan o'chgan: hech kim qaytmaydi, raund darhol tugaydi
      p2.hp = MAX_HP;
      room.damageForTest(p2, w, MAX_HP, 'wolf');
      assert.equal(p2.alive, false);
      assert.equal(room.phase, 'ended');
      assert.equal(room.getSurvivalState()!.winReason, 'draw_no_survivors');
    } finally {
      room.destroy();
    }
  });

  it("8. evaluateSurvivalRoundOutcome: pendingRespawn hamma o'lganda raundni tugatmaydi; vaqt tugasa/gulxan o'chsa — 'draw_no_survivors'", () => {
    const shared = { sharedSurvival: true };
    assert.equal(evaluateSurvivalRoundOutcome(['a', 'b'], [], 100, { ...shared, pendingRespawn: true }).shouldEnd, false);
    assert.equal(evaluateSurvivalRoundOutcome(['a', 'b'], [], 100, { ...shared, pendingRespawn: false }).winReason, 'draw_no_survivors');
    assert.equal(evaluateSurvivalRoundOutcome(['a', 'b'], [], 100, shared).winReason, 'draw_no_survivors');
    assert.equal(evaluateSurvivalRoundOutcome(['a', 'b'], [], 0, { ...shared, pendingRespawn: true }).winReason, 'draw_no_survivors');
    assert.equal(evaluateSurvivalRoundOutcome(['a', 'b'], ['a'], 0, { ...shared, pendingRespawn: true }).winReason, 'dawn');
    // forest_survival (sharedSurvival yo'q) — pendingRespawn ta'sir qilmaydi
    assert.equal(evaluateSurvivalRoundOutcome(['a', 'b'], [], 100, { pendingRespawn: true }).winReason, 'draw_mutual_elimination');
  });

  it("9. 'Tabib' mukofoti: revives ≥ 1 bo'lsa beriladi, ballga ×3 qo'shiladi; natija varag'ida ⛑ nishoni", () => {
    const mk = (id: string, o: Partial<NightPlayerStats> = {}): NightPlayerStats => ({
      id,
      name: id.toUpperCase(),
      isBot: false,
      wolfKills: 0,
      alphaKills: 0,
      wolfDamage: 0,
      logsFed: 0,
      relights: 0,
      survived: false,
      revives: 0,
      downs: 0,
      ...o,
    });
    const none = computeNightSummary([mk('a'), mk('b', { downs: 2 })], 'normal', true);
    assert.equal(none.awards.find((a) => a.kind === 'medic'), undefined, "turg'izish yo'q — mukofot yo'q");
    const sum = computeNightSummary([mk('a', { wolfKills: 1 }), mk('m', { revives: 2 })], 'normal', true);
    const medic = sum.awards.find((a) => a.kind === 'medic')!;
    assert.ok(medic);
    assert.equal(medic.playerId, 'm');
    assert.equal(medic.value, 2);
    assert.equal(medic.titleUz, NIGHT_AWARD_TITLES_UZ.medic);
    assert.equal(NIGHT_AWARD_TITLES_UZ.medic, 'Tabib');
    assert.equal(sum.stats[0]!.id, 'm', "2 turg'izish (6 ball) > 1 bo'ri (3 ball)");
    const html = buildNightAwardsHtml(sum, 'm');
    assert.ok(html.includes('is-medic'), html);
    assert.ok(html.includes('Tabib'));
    assert.ok(html.includes('2 marta'));
    assert.match(html, /M<span class="s07-tag">Siz<\/span>/);
    assert.ok(html.indexOf('is-hunter') < html.indexOf('is-medic'), 'tabib oxirgi nishon');
  });
});
