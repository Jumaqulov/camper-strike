import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room, type ServerPlayer } from '../../server/room';
import { SurvivalRoundController, type SurvivalPlayerView } from '../../server/survival';
import type { ServerWolf } from '../../server/wolf';
import { MATCH_END_DURATION, MAX_HP } from '../constants';
import { angleDiff, type Vec3 } from '../math';
import type { CreateRoomOpts, MatchState, WolfHowlEvent } from '../protocol';
import type { SurvivalConfig } from '../survival';
import {
  NIGHT_DAWN_EPILOGUE_SEC,
  WOLF_COAT_WHITE,
  WOLF_DAWN_FLEE_SEC,
  WOLF_DAWN_GONE_MAX_SEC,
  WOLF_DAWN_HOWL_FIRST_SEC,
  WOLF_DAWN_HOWL_JITTER_SEC,
  WOLF_DAWN_HOWL_SEC,
  WOLF_DAWN_HOWL_SPREAD_SEC,
  wolfDawnHowlDelaySec,
} from '../wolf';
import { sampleTerrainHeight } from '../world';

// Bosqich 28 — tong epilogi: bo'rilar tongda navbat bilan uvlab o'rmonga qochadi, raund birdan to'xtamaydi
// ('ended' fazasi tong uchun NIGHT_DAWN_EPILOGUE_SEC ga uzayadi, natija ekrani o'z davomiyligicha qoladi).

const TICK = 1 / 30;

interface EmittedRoomEvent {
  event: string;
  payload: unknown;
  /** Xona vaqti (room.now()) — uvlash vaqtlarini tekshirish uchun. */
  at: number;
}

function createFakeIo(): { io: Server; emitted: EmittedRoomEvent[]; setClock: (fn: () => number) => void } {
  const emitted: EmittedRoomEvent[] = [];
  let clock = () => 0;
  const io = {
    to() {
      const emitFn = (event: string, payload: unknown) => {
        emitted.push({ event, payload, at: clock() });
      };
      return { emit: emitFn, volatile: { emit: emitFn } };
    },
  } as unknown as Server;
  return { io, emitted, setClock: (fn) => (clock = fn) };
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

function makeNightRoom(overrides: Partial<CreateRoomOpts> = {}): { room: Room; emitted: EmittedRoomEvent[] } {
  const { io, emitted, setClock } = createFakeIo();
  const room = new Room(
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
      nightDifficulty: 'hard',
      ...overrides,
    },
    io,
    () => {},
  );
  setClock(() => room.now());
  return { room, emitted };
}

/** Yakka odam tayyor bo'lib tunni boshlaydi (sanoq 2 s). */
function startSoloNight(room: Room): ServerPlayer {
  room.addHuman(createFakeSocket('p1'), 'Ovchi');
  room.onReady('p1', { world: room.worldMeta() });
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  const p = room.players.get('p1')!;
  p.spawnTime = -99;
  return p;
}

/** Ishtirokchilarni tirik tutib (har tick joni to'ldiriladi) vaqtni suradi; `untilEnd` — raund tugashi bilan to'xtaydi. */
function keepAlive(room: Room, sec: number, untilEnd = false): void {
  const contenders = [...room.players.values()];
  for (let left = sec; left > 1e-6; left -= TICK) {
    if (untilEnd && room.phase !== 'playing') return;
    room.advanceTimeForTest(TICK, TICK);
    for (const c of contenders) {
      if (!c.alive) continue;
      c.hp = MAX_HP;
      c.vel = { x: 0, y: 0, z: 0 };
    }
  }
}

function groundAt(room: Room, x: number, z: number): Vec3 {
  return { x, y: sampleTerrainHeight(room.world.terrain, x, z), z };
}

/** Tunni oxirgi to'lqingacha o'tkazadi va kamida `n` ta tirik bo'ri bo'lishini ta'minlaydi (oq — to'da boshlig'i birinchi). */
function lastWaveWithWolves(room: Room, n: number): ServerWolf[] {
  room.setSurvivalConfigForTest({ roundDurationSec: 12 });
  keepAlive(room, 10, true);
  assert.equal(room.phase, 'playing');
  let living = [...room.wolves.values()].filter((w) => w.alive);
  while (living.length < n && room.addWolf()) living = [...room.wolves.values()].filter((w) => w.alive);
  assert.ok(living.length >= n, `bo'rilar yetarli (${living.length})`);
  return living;
}

/** Bo'rilarni `center` atrofida (to'da boshlig'i uvlashi radiusi ichida) yonma-yon qo'yadi. */
function huddle(room: Room, wolves: readonly ServerWolf[], center: Vec3): void {
  wolves.forEach((w, i) => {
    const a = (i / wolves.length) * Math.PI * 2;
    w.pos = groundAt(room, center.x + Math.cos(a) * (i === 0 ? 0 : 4), center.z + Math.sin(a) * (i === 0 ? 0 : 4));
    w.vel = { x: 0, y: 0, z: 0 };
  });
}

function howlsSince(emitted: EmittedRoomEvent[], t0: number): { id: string; at: number }[] {
  return emitted
    .filter((e) => e.event === 'wolf:howl' && e.at >= t0 - 1e-9)
    .map((e) => ({ id: (e.payload as WolfHowlEvent).id, at: e.at }));
}

function lastMatch(emitted: EmittedRoomEvent[]): MatchState {
  const m = emitted.filter((e) => e.event === 'match').pop()?.payload as MatchState | undefined;
  assert.ok(m, 'match hodisasi yuborilgan');
  return m!;
}

describe('Bosqich 28 — tong epilogi (wolf_night)', () => {
  it("1. Tong xori jadvali: birinchisi WOLF_DAWN_HOWL_FIRST_SEC da, qolganlari teng yoyilgan, jitter chegaralangan; bo'rilar yakun ekranidan oldin ketadi", () => {
    assert.equal(wolfDawnHowlDelaySec(0, 1), WOLF_DAWN_HOWL_FIRST_SEC, 'yolg‘iz bo‘ri — darhol birinchi');
    const d4 = [0, 1, 2, 3].map((i) => wolfDawnHowlDelaySec(i, 4));
    assert.equal(d4[0], WOLF_DAWN_HOWL_FIRST_SEC);
    assert.ok(Math.abs(d4[3]! - (WOLF_DAWN_HOWL_FIRST_SEC + WOLF_DAWN_HOWL_SPREAD_SEC)) < 1e-9, 'oxirgisi SPREAD dan keyin');
    for (let i = 1; i < d4.length; i++) {
      assert.ok(Math.abs(d4[i]! - d4[i - 1]! - WOLF_DAWN_HOWL_SPREAD_SEC / 3) < 1e-9, 'teng oraliq');
    }
    // Jitter [0, WOLF_DAWN_HOWL_JITTER_SEC] ga qisiladi; noto'g'ri indeks/son — chegarada
    assert.equal(wolfDawnHowlDelaySec(0, 3, 99), WOLF_DAWN_HOWL_FIRST_SEC + WOLF_DAWN_HOWL_JITTER_SEC);
    assert.equal(wolfDawnHowlDelaySec(0, 3, -1), WOLF_DAWN_HOWL_FIRST_SEC);
    assert.equal(wolfDawnHowlDelaySec(0, 3, Number.NaN), WOLF_DAWN_HOWL_FIRST_SEC);
    assert.equal(wolfDawnHowlDelaySec(9, 3), WOLF_DAWN_HOWL_FIRST_SEC + WOLF_DAWN_HOWL_SPREAD_SEC);
    assert.equal(wolfDawnHowlDelaySec(0, 0), WOLF_DAWN_HOWL_FIRST_SEC);
    // Xor taxminan birinchi 1–2 soniyada, bo'rilar yakun (epilog + natija ekrani) tugashidan ancha oldin yo'qoladi
    assert.ok(WOLF_DAWN_HOWL_FIRST_SEC + WOLF_DAWN_HOWL_SPREAD_SEC + WOLF_DAWN_HOWL_JITTER_SEC <= 2);
    assert.equal(
      WOLF_DAWN_GONE_MAX_SEC,
      WOLF_DAWN_HOWL_FIRST_SEC + WOLF_DAWN_HOWL_SPREAD_SEC + WOLF_DAWN_HOWL_JITTER_SEC + WOLF_DAWN_HOWL_SEC + WOLF_DAWN_FLEE_SEC,
    );
    assert.ok(WOLF_DAWN_GONE_MAX_SEC < MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC);
    // Oxirgi bo'ri epilog ichida qochishni boshlaydi (natija varag'idan oldin yugurgani ko'rinadi)
    assert.ok(WOLF_DAWN_HOWL_FIRST_SEC + WOLF_DAWN_HOWL_SPREAD_SEC + WOLF_DAWN_HOWL_JITTER_SEC + WOLF_DAWN_HOWL_SEC < NIGHT_DAWN_EPILOGUE_SEC - 2);
  });

  it("2. SurvivalRoundController: tong — 'ended' endedDisplay + dawnEpilogueSec; bo'rilar yutsa, forest_survival g'olibi va epilogsiz sozlama — eski davomiylik", () => {
    const view = (id: string, isBot = false): SurvivalPlayerView => ({ id, name: id, isBot, ready: true, alive: true, kills: 0, deaths: 0 });
    const make = (players: SurvivalPlayerView[], cfg: Partial<SurvivalConfig>) => {
      const byId = new Map(players.map((p) => [p.id, p] as const));
      const ctrl = new SurvivalRoundController(
        {
          getPlayers: () => players,
          getPlayerById: (id) => byId.get(id),
          onRoundStart: () => {},
          onRoundEnd: () => {},
          onPreRoundReset: () => {},
        },
        { minPlayersToStart: 1, countdownDurationSec: 1, roundDurationSec: 30, endedDisplayDurationSec: 10, ...cfg },
      );
      assert.equal(ctrl.startRoundNow(0), true);
      return ctrl;
    };
    const night = { sharedSurvival: true, zoneEnabled: false, dawnEpilogueSec: NIGHT_DAWN_EPILOGUE_SEC };

    // a) Tong otdi: natija ekrani (10 s) + epilog
    const a = make([view('h'), view('b', true)], night);
    assert.equal(a.checkOutcome(30), true);
    assert.equal(a.getWinReason(), 'dawn');
    assert.equal(a.getPhaseEndsAt(), 30 + 10 + NIGHT_DAWN_EPILOGUE_SEC);
    assert.equal(a.getStateSnap(30).timeLeft, 10 + NIGHT_DAWN_EPILOGUE_SEC);
    a.tick(30 + 10 + 0.5);
    assert.equal(a.getPhase(), 'ended', 'eski davomiylikda tugamaydi');
    a.tick(30 + 10 + NIGHT_DAWN_EPILOGUE_SEC);
    assert.equal(a.getPhase(), 'countdown');

    // b) Bo'rilar yutdi (hamma o'ldi): epilog yo'q
    const bp = [view('h')];
    const b = make(bp, night);
    bp[0]!.alive = false;
    assert.equal(b.checkOutcome(5), true);
    assert.equal(b.getWinReason(), 'draw_no_survivors');
    assert.equal(b.getPhaseEndsAt(), 5 + 10);

    // c) forest_survival (sharedSurvival yo'q): oxirgi tirik g'olib — epilog sozlangan bo'lsa ham qo'shilmaydi
    const cp = [view('h'), view('x')];
    const c = make(cp, { dawnEpilogueSec: NIGHT_DAWN_EPILOGUE_SEC });
    cp[1]!.alive = false;
    assert.equal(c.checkOutcome(7), true);
    assert.equal(c.getWinReason(), 'last_standing');
    assert.equal(c.getPhaseEndsAt(), 7 + 10);

    // d) Epilog sozlanmagan tun (standart 0) — tong ham eski davomiylikda; manfiy qiymat 0 ga qisiladi
    const d = make([view('h')], { sharedSurvival: true, zoneEnabled: false });
    assert.equal(d.getConfig().dawnEpilogueSec ?? 0, 0);
    d.setConfig({ dawnEpilogueSec: -3 }, 0);
    assert.equal(d.getConfig().dawnEpilogueSec, 0);
    assert.equal(d.checkOutcome(30), true);
    assert.equal(d.getWinReason(), 'dawn');
    assert.equal(d.getPhaseEndsAt(), 30 + 10);
  });

  it("3. Xona: tongda har tirik bo'ri bir marta uvlaydi (to'da boshlig'i birinchi), xor ~1-2 s ga yoyilgan, hech kim tezlashmaydi; uvlab bo'lgach qochadi", () => {
    const { room, emitted } = makeNightRoom();
    try {
      const p = startSoloNight(room);
      const wolves = lastWaveWithWolves(room, 4);
      const alpha = wolves[0]!;
      alpha.coat = WOLF_COAT_WHITE;
      // Tekshiruv sezgir: tun davomida boshliq uvlashi yonidagi bo'rilarni tezlashtiradi
      huddle(room, wolves, groundAt(room, p.pos.x + 25, p.pos.z));
      room.wolfHowl(alpha);
      assert.ok(wolves.slice(1).some((w) => w.alphaBuffUntil > room.now()), 'tunda boshliq uvlashi tezlashtiradi');

      keepAlive(room, 10, true);
      assert.equal(room.phase, 'ended');
      assert.equal(room.getSurvivalState()!.winReason, 'dawn');
      const tDawn = room.now();
      const living = [...room.wolves.values()].filter((w) => w.alive);
      assert.ok(living.length >= 4, `tongda tirik bo'rilar (${living.length})`);
      assert.ok(living.includes(alpha), "to'da boshlig'i tirik");
      // Tong lahzasida hech kim uvlamaydi (xor bir zumda emas) va tezlashuv tozalangan
      assert.equal(howlsSince(emitted, tDawn).length, 0);
      for (const w of living) {
        assert.equal(w.alphaBuffUntil, 0);
        assert.equal(w.state, 'idle', "uvlash navbatini joyida kutadi");
        assert.equal(w.targetId, null);
      }
      // Bo'rilar boshliq yonida — tong uvlashi tezlashtirsa sezilardi
      huddle(room, living, groundAt(room, p.pos.x + 25, p.pos.z));

      const stateSeen = new Map(living.map((w) => [w.id, new Set<string>()] as const));
      for (let t = 0; t < 4; t += TICK) {
        room.advanceTimeForTest(TICK, TICK);
        for (const w of room.wolves.values()) {
          assert.equal(w.alphaBuffUntil, 0, `tong uvlashi hech kimni tezlashtirmaydi (${w.id})`);
          stateSeen.get(w.id)?.add(w.state);
        }
      }
      const howls = howlsSince(emitted, tDawn);
      assert.equal(howls.length, living.length, "har tirik bo'ri bir marta uvladi");
      assert.deepEqual(new Set(howls.map((h) => h.id)), new Set(living.map((w) => w.id)));
      assert.equal(howls[0]!.id, alpha.id, "xorni to'da boshlig'i boshlaydi");
      const rel = howls.map((h) => h.at - tDawn);
      const first = Math.min(...rel);
      const last = Math.max(...rel);
      assert.ok(first >= WOLF_DAWN_HOWL_FIRST_SEC - 1e-6, `birinchi uvlash ${first.toFixed(2)} s`);
      assert.ok(last <= WOLF_DAWN_HOWL_FIRST_SEC + WOLF_DAWN_HOWL_SPREAD_SEC + WOLF_DAWN_HOWL_JITTER_SEC + TICK + 1e-6, `oxirgisi ${last.toFixed(2)} s`);
      assert.ok(last - first >= WOLF_DAWN_HOWL_SPREAD_SEC - WOLF_DAWN_HOWL_JITTER_SEC - TICK, `xor yoyilgan (${(last - first).toFixed(2)} s)`);
      assert.ok(new Set(rel.map((x) => x.toFixed(3))).size >= 2, 'bir zumda emas');
      // Har bo'ri: kutdi → uvladi → qochmoqda (epilog davomida yugurgani ko'rinadi)
      for (const w of living) {
        const seen = stateSeen.get(w.id)!;
        assert.ok(seen.has('howl') && seen.has('flee'), `${w.id}: ${[...seen].join(',')}`);
        if (room.wolves.has(w.id)) assert.equal(w.state, 'flee');
      }
      assert.equal(p.hp, MAX_HP, 'tong otgach tishlamaydi');
    } finally {
      room.destroy();
    }
  });

  it("4. Xona: tong — 'ended' MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC; bo'rilar yutsa — MATCH_END_DURATION (o'zgarmagan)", () => {
    // a) Tong otdi
    {
      const { room, emitted } = makeNightRoom();
      try {
        startSoloNight(room);
        room.setSurvivalConfigForTest({ roundDurationSec: 4 });
        keepAlive(room, 6, true);
        assert.equal(room.phase, 'ended');
        assert.equal(room.getSurvivalState()!.winReason, 'dawn');
        assert.equal(room.getSurvivalState()!.timeLeft, MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC);
        assert.equal(lastMatch(emitted).survival!.timeLeft, MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC);
        assert.ok(lastMatch(emitted).survival!.nightSummary, "natija birinchi 'ended' hodisasidayoq bor");
        room.advanceTimeForTest(MATCH_END_DURATION + 0.5, 0.25);
        assert.equal(room.phase, 'ended', 'natija ekrani epilogdan keyin to‘liq turadi');
        room.advanceTimeForTest(NIGHT_DAWN_EPILOGUE_SEC, 0.25);
        assert.equal(room.phase, 'countdown');
      } finally {
        room.destroy();
      }
    }
    // b) Bo'rilar yutdi (oxirgi to'lqinda — qaytish yo'q): eski davomiylik, epilog yo'q
    {
      const { room } = makeNightRoom({ nightDifficulty: 'normal' });
      try {
        const p = startSoloNight(room);
        room.setSurvivalConfigForTest({ roundDurationSec: 40 });
        keepAlive(room, 31, true);
        assert.equal(room.phase, 'playing');
        const w = [...room.wolves.values()].find((x) => x.alive)!;
        room.damageForTest(p, w, MAX_HP, 'wolf');
        assert.equal(room.phase, 'ended');
        assert.equal(room.getSurvivalState()!.winReason, 'draw_no_survivors');
        assert.equal(room.getSurvivalState()!.timeLeft, MATCH_END_DURATION);
        assert.equal(room.wolves.size, 0, "bo'rilar yutganda xor yo'q — darhol tozalanadi (avvalgidek)");
        room.advanceTimeForTest(MATCH_END_DURATION - 0.5, 0.25);
        assert.equal(room.phase, 'ended');
        room.advanceTimeForTest(1, 0.25);
        assert.equal(room.phase, 'countdown');
      } finally {
        room.destroy();
      }
    }
  });

  it("5. Tong epilogida botlar qotib turmaydi — yaqindagi uvlayotgan bo'riga qaraydi (joyidan siljimaydi)", () => {
    const { room } = makeNightRoom({ bots: 1 });
    try {
      startSoloNight(room);
      const bot = [...room.players.values()].find((x) => x.isBot)!;
      assert.ok(bot, 'bot bor');
      lastWaveWithWolves(room, 2);
      keepAlive(room, 10, true);
      assert.equal(room.phase, 'ended');
      assert.equal(room.getSurvivalState()!.winReason, 'dawn');
      assert.equal(bot.alive, true);
      // Barcha bo'rilar botning orqasida (~10 m) — bot ularga burilishi kerak
      const back = { x: bot.pos.x + Math.sin(bot.yaw) * 10, z: bot.pos.z + Math.cos(bot.yaw) * 10 };
      const living = [...room.wolves.values()].filter((w) => w.alive);
      huddle(room, living, groundAt(room, back.x, back.z));
      const pos0 = { ...bot.pos };
      room.advanceTimeForTest(1.2, TICK);
      const goal = Math.atan2(-(back.x - bot.pos.x), -(back.z - bot.pos.z));
      assert.ok(Math.abs(angleDiff(bot.yaw, goal)) < 0.5, `bot bo'rilarga qaradi (farq ${angleDiff(bot.yaw, goal).toFixed(2)} rad)`);
      assert.ok(Math.hypot(bot.pos.x - pos0.x, bot.pos.z - pos0.z) < 1e-6, 'bot joyidan siljimaydi');
    } finally {
      room.destroy();
    }
  });
});
