import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { sanitizeOpts } from '../../server/lobby';
import { Room } from '../../server/room';
import { MATCH_END_DURATION, MAX_HP } from '../constants';
import { anglesFromDir, vnorm, vsub, type Vec3 } from '../math';
import type { CreateRoomOpts, KillEvent, MatchState } from '../protocol';
import { emptyAmmo } from '../weapons';
import {
  NIGHT_DEFAULT_MINUTES,
  NIGHT_MAX_MINUTES,
  NIGHT_MIN_MINUTES,
  NIGHT_WAVES,
  NIGHT_WAVE_COUNT,
  WOLF_CORPSE_SEC,
  WOLF_MAX_HP,
  WOLF_RESPAWN_SEC,
} from '../wolf';

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

function makeFfaRoom(io: Server, bots: number, wolves: number): Room {
  return new Room(
    {
      name: "Bo'ri FFA",
      mode: 'ffa',
      mapId: 'forest_square',
      bots,
      maxPlayers: 8,
      timeLimit: 10,
      scoreLimit: 25,
      publicLayoutSeed: 6501,
      wolves,
    },
    io,
    () => {},
  );
}

/** Ochiq joy: nav tuguni va undan +X tomonga `len` m gacha to'siqsiz chiziq. */
function findOpenLine(room: Room, len: number): { a: Vec3; b: Vec3 } {
  const nav = room.nav;
  for (const i of nav.roamList) {
    const a = nav.center(i);
    const b = { x: a.x + len, y: a.y, z: a.z };
    const j = nav.nearest(b);
    if (j < 0) continue;
    const bc = nav.center(j);
    if (Math.hypot(bc.x - b.x, bc.z - b.z) > 2.5) continue;
    if (Math.abs(bc.y - a.y) > 0.8) continue;
    if (nav.segmentClear(a, bc)) return { a, b: bc };
  }
  throw new Error('ochiq chiziq topilmadi');
}

/** Yakka odam tayyor bo'lib raundni boshlaydi (sanoq 2 s). */
function startSoloNight(room: Room, id = 'p1', name = 'Ovchi') {
  const s = createFakeSocket(id);
  room.addHuman(s.socket, name);
  room.onReady(id, { world: room.worldMeta() });
  assert.equal(room.phase, 'countdown', 'yakka odam tayyor — sanoq boshlanadi (minPlayersToStart 1)');
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  return { socket: s, p: room.players.get(id)! };
}

/** O'yinchini tirik tutib vaqtni suradi: har qadamda joni to'ldiriladi. */
function surviveFor(room: Room, p: { hp: number; vel: Vec3 }, sec: number, step = 0.25): void {
  let left = sec;
  while (left > 1e-6 && room.phase === 'playing') {
    const d = Math.min(step, left);
    room.advanceTimeForTest(d, 1 / 30);
    p.hp = MAX_HP;
    p.vel = { x: 0, y: 0, z: 0 };
    left -= d;
  }
}

function lastMatch(emitted: EmittedRoomEvent[]): MatchState {
  const m = emitted.filter((e) => e.event === 'match').pop()?.payload as MatchState | undefined;
  assert.ok(m, 'match hodisasi yuborilgan');
  return m!;
}

describe("Bosqich 19 — Tong otguncha (wolf_night)", () => {
  it("1. sanitizeOpts: wolf_night saqlanadi, forest_square + loot, tun davomiyligi chegaralanadi, bo'rilar 0; noma'lum rejim → tdm", () => {
    const o = sanitizeOpts(
      { mode: 'wolf_night', mapId: 'forest_technical', lootPreview: false, wolves: 3, bots: 0, maxPlayers: 1 },
      'X',
    );
    assert.equal(o.mode, 'wolf_night');
    assert.equal(o.mapId, 'forest_square');
    assert.equal(o.lootPreview, true);
    assert.equal(o.timeLimit, NIGHT_DEFAULT_MINUTES);
    assert.equal(o.wolves, 0, "to'lqinlar boshqaradi — opts.wolves 0");
    assert.equal(o.bots, 0);
    assert.equal(o.maxPlayers, 1, 'yakka o‘yinchi xonasi mumkin');
    assert.equal(o.minHumans, 1);
    assert.equal(sanitizeOpts({ mode: 'wolf_night', timeLimit: 99 }, 'X').timeLimit, NIGHT_MAX_MINUTES);
    assert.equal(sanitizeOpts({ mode: 'wolf_night', timeLimit: 1 }, 'X').timeLimit, NIGHT_MIN_MINUTES);
    assert.equal(sanitizeOpts({ mode: 'nope' as unknown as CreateRoomOpts['mode'] }, 'X').mode, 'tdm');
    // Eski rejimlar o'zgarmagan
    const fs = sanitizeOpts({ mode: 'forest_survival' }, 'X');
    assert.equal(fs.timeLimit, 3);
    assert.equal(fs.maxPlayers, 10);
    assert.equal(fs.bots, 3);
  });

  it("2. Yakka odam botlarsiz raund boshlaydi; zona yo'q, 1-to'lqinda 1 ta bo'ri", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      assert.equal(room.isNight, true);
      assert.equal(room.isSurvival, true);
      assert.equal(room.wolves.size, 0, "raundgacha bo'ri yo'q");
      startSoloNight(room);
      assert.equal(room.getZoneSnap(), null, 'wolf_night da xavfsiz zona yo‘q');
      const night = room.getNightSnap();
      assert.ok(night, 'tun holati bor');
      assert.equal(night!.wave, 1);
      assert.equal(night!.waveCount, NIGHT_WAVE_COUNT);
      assert.equal(night!.wolvesAlive, 1);
      assert.ok(night!.dawnInSec > 230 && night!.dawnInSec <= 240, `tonggacha ~240 s (${night!.dawnInSec})`);
      assert.equal(room.wolves.size, 1);
      const w = [...room.wolves.values()][0]!;
      assert.equal(w.speedMul, NIGHT_WAVES[0]!.speedMul);
      assert.equal(w.hp, Math.round(WOLF_MAX_HP * NIGHT_WAVES[0]!.hpMul));
      const m = lastMatch(emitted);
      assert.equal(m.mode, 'wolf_night');
      assert.equal(m.survival?.zone, null);
      assert.equal(m.survival?.night?.wave, 1);
      assert.deepEqual(m.survival?.winnerIds, []);
      // Chat buyrug'i bilan bo'rilar soni o'zgarmaydi
      assert.equal(room.setWolfCount(4), 1);
      assert.equal(room.wolves.size, 1);
    } finally {
      room.destroy();
    }
  });

  it("3. To'lqinlar: 25% da 2, 75% da 4 bo'ri (kuchliroq); o'lgan bo'ri qayta tug'iladi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io, { timeLimit: 4 });
    try {
      const { p } = startSoloNight(room);
      p.spawnTime = -99;
      // 25% → 2-to'lqin
      surviveFor(room, p, 61);
      assert.equal(room.phase, 'playing', 'yakka tirik qolgan raundni tugatmaydi');
      assert.equal(room.wolves.size, 2, '2-to‘lqinda 2 bo‘ri');
      const list2 = [...room.wolves.values()];
      assert.equal(list2[1]!.speedMul, NIGHT_WAVES[1]!.speedMul);
      assert.equal(list2[0]!.speedMul, NIGHT_WAVES[0]!.speedMul, 'eski bo‘ri o‘z ko‘rsatkichini saqlaydi');
      assert.equal(room.getNightSnap()!.wave, 2);
      // 75% → 4-to'lqin
      surviveFor(room, p, 120);
      assert.equal(room.phase, 'playing');
      assert.equal(room.wolves.size, 4, '4-to‘lqinda 4 bo‘ri');
      assert.equal(room.getNightSnap()!.wave, 4);
      const newest = [...room.wolves.values()].pop()!;
      assert.equal(newest.hpMul, NIGHT_WAVES[3]!.hpMul);
      assert.equal(newest.biteMul, NIGHT_WAVES[3]!.biteMul);

      // Bo'rini o'ldiramiz: 1 hp, ochiq chiziqda otamiz (loot rejimida qurol egaligi tekshirilmasin —
      // server ichidagi botFire orqali, mo'ljal yaw/pitch dan olinadi)
      const w = [...room.wolves.values()][0]!;
      const line = findOpenLine(room, 6);
      p.pos = { ...line.a };
      p.vel = { x: 0, y: 0, z: 0 };
      w.pos = { ...line.b };
      w.vel = { x: 0, y: 0, z: 0 };
      w.hp = 1;
      p.weapon = 'rifle';
      p.ammo.rifle = { mag: 30, reserve: 90 };
      p.reloadWeapon = null;
      p.switchUntil = 0;
      const eye = { x: p.pos.x, y: p.pos.y + 1.62, z: p.pos.z };
      const center = { x: w.pos.x, y: w.pos.y + 0.6, z: w.pos.z };
      const ang = anglesFromDir(vnorm(vsub(center, eye)));
      p.yaw = ang.yaw;
      p.pitch = ang.pitch;
      p.lastShot = -99;
      let killed = false;
      for (let i = 0; i < 5 && !killed; i++) {
        p.lastShot = -99;
        room.botFire(p, 0);
        killed = !w.alive;
      }
      assert.equal(w.alive, false, "bo'ri o'ldi");
      assert.equal(room.wolves.size, 4, 'jasad o‘chmaydi — qayta tug‘ilishni kutadi');
      surviveFor(room, p, WOLF_CORPSE_SEC + WOLF_RESPAWN_SEC + 1);
      assert.equal(room.phase, 'playing');
      assert.equal(w.alive, true, "bo'ri qayta tug'ildi");
      assert.equal(w.hpMul, NIGHT_WAVES[3]!.hpMul, 'qayta tug‘ilgan bo‘ri joriy to‘lqin kuchida');
      assert.equal(w.hp, Math.round(WOLF_MAX_HP * NIGHT_WAVES[3]!.hpMul));
    } finally {
      room.destroy();
    }
  });

  it("4. Tong otdi: tirik qolgan odam g'olib (winReason 'dawn', winnerIds), kill hodisasi yo'q", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { timeLimit: 3 });
    try {
      const { p } = startSoloNight(room);
      p.spawnTime = -99;
      // Testni tezlashtirish: tun 40 s (to'lqinlar shu davomiylikka nisbatan hisoblanadi)
      room.setSurvivalConfigForTest({ roundDurationSec: 40 });
      surviveFor(room, p, 60);
      assert.equal(room.phase, 'ended', 'taymer tugaganda raund yakunlanadi');
      const surv = room.getSurvivalState()!;
      assert.equal(surv.winReason, 'dawn');
      assert.equal(surv.winnerId, null);
      assert.deepEqual(surv.winnerIds, ['p1']);
      assert.equal(surv.winnerName, 'Ovchi');
      assert.ok(surv.statusTextUz.startsWith('Tong otdi'), surv.statusTextUz);
      assert.equal(surv.players.find((x) => x.id === 'p1')?.placement, 1);
      assert.equal(room.survival!.getWinnerIds()[0], 'p1');
      const m = lastMatch(emitted);
      assert.equal(m.winReason, 'dawn');
      assert.ok(m.survival?.winnerIds?.includes('p1'), 'MatchState.survival.winnerIds');
      assert.equal(m.winner, 'Ovchi');
      assert.ok(!emitted.some((e) => e.event === 'kill'), 'hech kim o‘lmagan');
      assert.equal(room.wolves.size, 0, 'tong otgach bo‘rilar ketadi');
      // Yakunlash ko'rsatuvi o'tgach yakka odam yana sanoqqa o'tadi
      room.advanceTimeForTest(MATCH_END_DURATION + 0.5, 0.25);
      assert.equal(room.phase, 'countdown');
      assert.deepEqual(room.getSurvivalState()!.winnerIds, []);
    } finally {
      room.destroy();
    }
  });

  it("5. Hamma o'lsa — 'draw_no_survivors', o'lim hodisasida weapon='wolf'", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { timeLimit: 3 });
    try {
      const { p } = startSoloNight(room);
      const w = [...room.wolves.values()][0]!;
      const line = findOpenLine(room, 6);
      p.pos = { ...line.a };
      p.vel = { x: 0, y: 0, z: 0 };
      p.spawnTime = -99;
      w.pos = { ...line.b };
      w.vel = { x: 0, y: 0, z: 0 };
      w.yaw = Math.atan2(-(p.pos.x - w.pos.x), -(p.pos.z - w.pos.z));
      for (let i = 0; i < 160 && p.alive; i++) {
        room.advanceTimeForTest(0.25, 1 / 30);
        p.vel = { x: 0, y: 0, z: 0 };
      }
      assert.equal(p.alive, false, "bo'ri odamni 40 s ichida o'ldiradi");
      const kill = emitted.find((e) => e.event === 'kill')?.payload as KillEvent | undefined;
      assert.ok(kill && kill.weapon === 'wolf' && kill.victim === 'p1');
      assert.equal(room.phase, 'ended');
      const surv = room.getSurvivalState()!;
      assert.equal(surv.winReason, 'draw_no_survivors');
      assert.deepEqual(surv.winnerIds, []);
      assert.equal(room.wolves.size, 0);
    } finally {
      room.destroy();
    }
  });

  it("6. Botlar bo'riga qarshi: qurolli bot otadi, qurolsiz bot qochadi", () => {
    // 6a: avtomatli bot 8 m dagi ovlayotgan bo'rini 6 s ichida yaralaydi
    {
      const { io } = createFakeIo();
      const room = makeFfaRoom(io, 1, 1);
      try {
        room.advanceTimeForTest(0.2, 1 / 30);
        const bot = [...room.players.values()].find((x) => x.isBot)!;
        assert.ok(bot.alive, 'bot tug‘ildi');
        const w = [...room.wolves.values()][0]!;
        const line = findOpenLine(room, 8);
        bot.pos = { ...line.a };
        bot.vel = { x: 0, y: 0, z: 0 };
        bot.weapon = 'rifle';
        bot.ammo.rifle = { mag: 30, reserve: 90 };
        bot.reloadWeapon = null;
        bot.switchUntil = 0;
        w.pos = { ...line.b };
        w.vel = { x: 0, y: 0, z: 0 };
        w.brain.onDamaged(bot, room.now());
        assert.equal(w.targetId ?? bot.id, bot.id);
        const hp0 = w.hp;
        let damaged = false;
        for (let i = 0; i < 60 && !damaged; i++) {
          room.advanceTimeForTest(0.1, 1 / 30);
          if (w.hp < hp0) damaged = true;
        }
        assert.ok(damaged, `bot bo'rini 6 s ichida yaralashi kerak (hp=${w.hp}, bot hp=${bot.hp})`);
      } finally {
        room.destroy();
      }
    }
    // 6b: qurolsiz bot bo'ridan uzoqlashadi (bo'ri joyida ushlab turiladi)
    {
      const { io } = createFakeIo();
      const room = makeFfaRoom(io, 1, 1);
      try {
        room.advanceTimeForTest(0.2, 1 / 30);
        const bot = [...room.players.values()].find((x) => x.isBot)!;
        assert.ok(bot.alive);
        const w = [...room.wolves.values()][0]!;
        const line = findOpenLine(room, 8);
        bot.pos = { ...line.a };
        bot.vel = { x: 0, y: 0, z: 0 };
        bot.weapon = null;
        bot.ammo = emptyAmmo();
        bot.reloadWeapon = null;
        w.pos = { ...line.b };
        w.vel = { x: 0, y: 0, z: 0 };
        w.brain.onDamaged(bot, room.now());
        const d0 = Math.hypot(w.pos.x - bot.pos.x, w.pos.z - bot.pos.z);
        for (let i = 0; i < 30; i++) {
          room.advanceTimeForTest(0.1, 1 / 30);
          w.pos = { ...line.b };
          w.vel = { x: 0, y: 0, z: 0 };
        }
        const d1 = Math.hypot(w.pos.x - bot.pos.x, w.pos.z - bot.pos.z);
        assert.ok(d1 > d0 + 3, `qurolsiz bot qochishi kerak: ${d0.toFixed(1)} → ${d1.toFixed(1)} m`);
        assert.equal(bot.weapon, null, 'qurol paydo bo‘lmaydi');
      } finally {
        room.destroy();
      }
    }
  });
});
