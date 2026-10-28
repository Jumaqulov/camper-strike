import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { sanitizeOpts } from '../../server/lobby';
import { Room } from '../../server/room';
import { GRENADE_FUSE, MATCH_END_DURATION, MAX_HP } from '../constants';
import { anglesFromDir, vnorm, vsub, type Vec3 } from '../math';
import type { CampActionAck, CampfireEvent, ChatMsg, CreateRoomOpts, KillEvent, MatchState, Snapshot } from '../protocol';
import { emptyAmmo } from '../weapons';
import { isTerrainWalkable, sampleTerrainHeight } from '../world';
import {
  CAMPFIRE_LOW_FUEL_SEC,
  CAMPFIRE_MAX_FUEL_SEC,
  CAMPFIRE_RADIUS_M,
  CAMPFIRE_START_FUEL_SEC,
  CAMPFIRE_WOOD_FUEL_SEC,
  CAMP_INTERACT_RANGE_M,
  NIGHT_CAMPFIRE_COUNT,
  NIGHT_DEFAULT_MINUTES,
  NIGHT_MAX_MINUTES,
  NIGHT_MIN_MINUTES,
  NIGHT_WAVES,
  NIGHT_WAVE_COUNT,
  NIGHT_WOOD_PILE_COUNT,
  WOOD_PILE_GAP_M,
  WOOD_PILE_MAX_DIST_M,
  WOOD_PILE_MIN_DIST_M,
  WOOD_PILE_RESPAWN_SEC,
  WOLF_CORPSE_SEC,
  WOLF_MAX_HP,
  WOLF_RESPAWN_SEC,
  WOOD_CARRY_MAX,
  type WolfBiteEvent,
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
  return { p1: room.players.get('p1')!, p2: room.players.get('p2')!, s1, s2 };
}

/** Gulxandan `len` m gacha to'siqsiz yo'nalish (16 ta burchak sinab chiqiladi). */
function openDirFromFire(room: Room, fire: { x: number; y: number; z: number }, len: number): { dx: number; dz: number } {
  const nav = room.nav;
  const a = { x: fire.x, y: fire.y, z: fire.z };
  for (let k = 0; k < 16; k++) {
    const ang = (k / 16) * Math.PI * 2;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const bx = fire.x + dx * len;
    const bz = fire.z + dz * len;
    const b = { x: bx, y: sampleTerrainHeight(room.world.terrain, bx, bz), z: bz };
    if (Math.abs(b.y - a.y) > 0.8) continue;
    if (nav.nearest(b) < 0) continue;
    if (nav.segmentClear(a, b)) return { dx, dz };
  }
  throw new Error("gulxandan ochiq yo'nalish topilmadi");
}

function groundAt(room: Room, x: number, z: number): Vec3 {
  return { x, y: sampleTerrainHeight(room.world.terrain, x, z), z };
}

function campfireEvents(emitted: EmittedRoomEvent[], kind?: CampfireEvent['kind']): CampfireEvent[] {
  return emitted
    .filter((e) => e.event === 'campfire')
    .map((e) => e.payload as CampfireEvent)
    .filter((e) => !kind || e.kind === kind);
}

function systemChats(emitted: EmittedRoomEvent[]): string[] {
  return emitted.filter((e) => e.event === 'chat').map((e) => (e.payload as ChatMsg).text);
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

  it("2. Yakka odam botlarsiz raund boshlaydi; zona yo'q, 1-to'lqinda jadvaldagi bo'rilar", () => {
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
      assert.equal(night!.wolvesAlive, NIGHT_WAVES[0]!.wolves);
      assert.ok(night!.dawnInSec > 230 && night!.dawnInSec <= 240, `tonggacha ~240 s (${night!.dawnInSec})`);
      assert.equal(room.wolves.size, NIGHT_WAVES[0]!.wolves);
      const w = [...room.wolves.values()][0]!;
      assert.equal(w.speedMul, NIGHT_WAVES[0]!.speedMul);
      assert.equal(w.hp, Math.round(WOLF_MAX_HP * NIGHT_WAVES[0]!.hpMul));
      const m = lastMatch(emitted);
      assert.equal(m.mode, 'wolf_night');
      assert.equal(m.survival?.zone, null);
      assert.equal(m.survival?.night?.wave, 1);
      assert.deepEqual(m.survival?.winnerIds, []);
      // Chat buyrug'i bilan bo'rilar soni o'zgarmaydi
      assert.equal(room.setWolfCount(4), NIGHT_WAVES[0]!.wolves);
      assert.equal(room.wolves.size, NIGHT_WAVES[0]!.wolves);
    } finally {
      room.destroy();
    }
  });

  it("3. To'lqinlar: 25% va 75% da jadvaldagi bo'rilar (kuchliroq); o'lgan bo'ri qayta tug'iladi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io, { timeLimit: 4 });
    try {
      const { p } = startSoloNight(room);
      p.spawnTime = -99;
      // 25% → 2-to'lqin
      surviveFor(room, p, 61);
      assert.equal(room.phase, 'playing', 'yakka tirik qolgan raundni tugatmaydi');
      assert.equal(room.wolves.size, NIGHT_WAVES[1]!.wolves, '2-to‘lqinda to‘lqin jadvalidagi bo‘rilar');
      const list2 = [...room.wolves.values()];
      assert.equal(list2[list2.length - 1]!.speedMul, NIGHT_WAVES[1]!.speedMul, 'yangi bo‘ri 2-to‘lqin kuchida');
      assert.equal(list2[0]!.speedMul, NIGHT_WAVES[0]!.speedMul, 'eski bo‘ri o‘z ko‘rsatkichini saqlaydi');
      assert.equal(room.getNightSnap()!.wave, 2);
      // 75% → 4-to'lqin
      surviveFor(room, p, 120);
      assert.equal(room.phase, 'playing');
      assert.equal(room.wolves.size, NIGHT_WAVES[3]!.wolves, '4-to‘lqinda to‘lqin jadvalidagi bo‘rilar');
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
      assert.equal(room.wolves.size, NIGHT_WAVES[3]!.wolves, 'jasad o‘chmaydi — qayta tug‘ilishni kutadi');
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

  // ---------------- 2-bosqich: lager (gulxanlar, o'tin), hamkorlik, bo'rilar olovdan qo'rqadi ----------------

  it("7. Hamkorlik: odamlar bir-biriga zarar bermaydi (o'q sherikdan o'tib bo'riga tegadi; granata ham), isEnemy false", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p1, p2 } = startDuoNight(room);
      assert.equal(room.isEnemy(p1, p2), false);
      assert.equal(room.isEnemy(p2, p1), false);
      const w = [...room.wolves.values()][0]!;
      const line = findOpenLine(room, 8);
      p1.pos = { ...line.a };
      p1.vel = { x: 0, y: 0, z: 0 };
      p1.spawnTime = -99;
      // Sherik otuvchi va bo'ri orasida (3 m), bo'ri 8 m da — o'q sherikdan o'tib bo'riga tegishi kerak
      const midX = line.a.x + (line.b.x - line.a.x) * (3 / 8);
      p2.pos = groundAt(room, midX, line.a.z);
      p2.vel = { x: 0, y: 0, z: 0 };
      p2.spawnTime = -99;
      w.pos = { ...line.b };
      w.vel = { x: 0, y: 0, z: 0 };
      p1.weapon = 'rifle';
      p1.ammo.rifle = { mag: 30, reserve: 90 };
      p1.reloadWeapon = null;
      p1.switchUntil = 0;
      const eye = { x: p1.pos.x, y: p1.pos.y + 1.62, z: p1.pos.z };
      const center = { x: w.pos.x, y: w.pos.y + 0.6, z: w.pos.z };
      const ang = anglesFromDir(vnorm(vsub(center, eye)));
      p1.yaw = ang.yaw;
      p1.pitch = ang.pitch;
      const wolfHp0 = w.hp;
      let wolfHit = false;
      for (let i = 0; i < 6 && !wolfHit; i++) {
        p1.lastShot = -99;
        // onShoot bilan bir xil `fire()` yo'li (odam qurol egaligi loot orqali beriladi — bu yerda to'g'ridan-to'g'ri)
        room.botFire(p1, 0);
        wolfHit = w.hp < wolfHp0;
      }
      assert.equal(p2.hp, MAX_HP, "sherikning joni o'zgarmaydi");
      assert.ok(wolfHit, `o'q sherikdan o'tib bo'riga tegadi (bo'ri hp ${w.hp}/${wolfHp0})`);
      assert.ok(!emitted.some((e) => e.event === 'kill'), 'hech kim o‘lmagan');

      // Granata otuvchi oyog'i ostida portlaydi: 2 m dagi sherikga zarar yo'q, o'z-o'ziga zarar saqlanadi
      room.wolves.clear();
      p1.grenades = 1;
      p1.lastGrenade = -99;
      const g0 = emitted.length;
      room.throwGrenade(p1, { x: 0, y: -0.2, z: 0 });
      p2.pos = groundAt(room, line.a.x + 2, line.a.z);
      const hp2 = p2.hp;
      let exploded = false;
      let selfHurt = false;
      for (let i = 0; i < 40 && !exploded; i++) {
        room.advanceTimeForTest(0.1, 1 / 30);
        p2.vel = { x: 0, y: 0, z: 0 };
        if (p1.hp < MAX_HP) selfHurt = true;
        p1.hp = MAX_HP;
        exploded = emitted.slice(g0).some((e) => e.event === 'explosion');
      }
      assert.ok(exploded, `granata ${GRENADE_FUSE} s da portlaydi`);
      assert.equal(p2.hp, hp2, 'granata sherikga zarar bermaydi');
      assert.ok(selfHurt, "o'z granatasi o'ziga zarar beradi (saqlanadi)");
    } finally {
      room.destroy();
    }
  });

  it("8. Lager joylashuvi: 3 gulxan (asosiy birinchi, yonib turadi), 8 g'aram, yuriladigan yerda, masofalar; o'yinchi asosiy gulxan yonida tug'iladi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const night = room.getNightSnap()!;
      assert.equal(night.fires.length, NIGHT_CAMPFIRE_COUNT);
      assert.equal(night.piles.length, NIGHT_WOOD_PILE_COUNT);
      const main = night.fires[0]!;
      assert.equal(main.main, true, 'asosiy gulxan birinchi');
      assert.equal(night.fires.filter((f) => f.main).length, 1);
      for (const f of night.fires) {
        assert.equal(f.lit, true);
        assert.equal(f.fuelSec, CAMPFIRE_START_FUEL_SEC);
        assert.equal(f.maxFuelSec, CAMPFIRE_MAX_FUEL_SEC);
        assert.ok(isTerrainWalkable(room.world.terrain, f.x, f.z), `gulxan ${f.id} yuriladigan relyefda`);
        assert.ok(Math.abs(sampleTerrainHeight(room.world.terrain, f.x, f.z) - f.y) < 0.05, 'y = relyef balandligi');
        assert.ok(room.nav.nearest({ x: f.x, y: f.y, z: f.z }) >= 0, 'nav tuguni bor');
      }
      for (let i = 0; i < night.fires.length; i++) {
        for (let j = i + 1; j < night.fires.length; j++) {
          const a = night.fires[i]!;
          const b = night.fires[j]!;
          assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 60, `gulxanlar ${a.id}/${b.id} ≥ 60 m`);
        }
      }
      for (const pl of night.piles) {
        assert.equal(pl.available, true);
        assert.equal(pl.respawnInSec, undefined);
        assert.ok(isTerrainWalkable(room.world.terrain, pl.x, pl.z), `g'aram ${pl.id} yuriladigan relyefda`);
        assert.ok(Math.abs(sampleTerrainHeight(room.world.terrain, pl.x, pl.z) - pl.y) < 0.05);
        const dFire = Math.min(...night.fires.map((f) => Math.hypot(f.x - pl.x, f.z - pl.z)));
        assert.ok(dFire >= WOOD_PILE_MIN_DIST_M && dFire <= WOOD_PILE_MAX_DIST_M, `g'aram ${pl.id} eng yaqin gulxandan ${WOOD_PILE_MIN_DIST_M}–${WOOD_PILE_MAX_DIST_M} m (${dFire.toFixed(1)})`);
        for (const o of night.piles) {
          if (o === pl) continue;
          assert.ok(Math.hypot(o.x - pl.x, o.z - pl.z) >= WOOD_PILE_GAP_M, `g'aramlar ${pl.id}/${o.id} ≥ ${WOOD_PILE_GAP_M} m`);
        }
      }
      // Asosiy gulxan — uylar guruhi hovlisida (POI markazidan ≤ flatRadius)
      assert.ok(Math.hypot(main.x - 64, main.z - -62) < 19, `asosiy gulxan uylar guruhida (${main.x}, ${main.z})`);
      // O'yinchi asosiy gulxan atrofidagi halqada tug'iladi
      assert.ok(Math.hypot(p.pos.x - main.x, p.pos.z - main.z) <= 6, "o'yinchi asosiy gulxandan ≤ 6 m da");
      assert.equal(p.wood, 0);
      // MatchState.survival.night ham gulxan/g'aramlarni oladi
      const m = lastMatch(emitted);
      assert.equal(m.survival?.night?.fires.length, NIGHT_CAMPFIRE_COUNT);
      assert.equal(m.survival?.night?.piles.length, NIGHT_WOOD_PILE_COUNT);
      assert.equal(m.survival?.night?.fires[0]?.main, true);
    } finally {
      room.destroy();
    }
  });

  it("9. O'tin olish / gulxanga tashlash: TOO_FAR, 3 ta o'tin, HANDS_FULL, g'aram bo'shaydi, tashlash +3×60 (chegaralangan), 'fed' hodisasi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      room.wolves.clear();
      p.spawnTime = -99;
      const night = room.getNightSnap()!;
      const piles = night.piles;
      // Uzoqdan — TOO_FAR
      let res = room.onTakeWood('p1', { pileId: piles[0]!.id });
      assert.equal(res.ok, false);
      assert.equal(res.error, 'TOO_FAR');
      assert.equal(res.wood, 0);
      // Noma'lum g'aram — NOT_FOUND; bo'lmagan o'yinchi — NOT_FOUND
      assert.equal(room.onTakeWood('p1', { pileId: 'pile:zzz' }).error, 'NOT_FOUND');
      assert.equal(room.onTakeWood('nope', { pileId: piles[0]!.id }).error, 'NOT_FOUND');

      let acked: CampActionAck | null = null;
      for (let i = 0; i < WOOD_CARRY_MAX; i++) {
        const pl = piles[i]!;
        p.pos = groundAt(room, pl.x + 1.0, pl.z);
        p.vel = { x: 0, y: 0, z: 0 };
        res = room.onTakeWood('p1', { pileId: pl.id }, (a) => (acked = a));
        assert.equal(res.ok, true, `o'tin ${i + 1}: ${res.error}`);
        assert.equal(res.wood, i + 1);
        assert.deepEqual(acked, res, 'ack bilan bir xil');
        assert.equal(room.woodPiles.get(pl.id)!.available, false, "g'aram bo'shadi");
        // Bo'sh g'aramdan qayta olish — PILE_EMPTY
        room.advanceTimeForTest(0.35, 1 / 30);
        assert.equal(room.onTakeWood('p1', { pileId: pl.id }).error, 'PILE_EMPTY');
        room.advanceTimeForTest(0.35, 1 / 30);
      }
      assert.equal(p.wood, WOOD_CARRY_MAX);
      // Snapshotda o'tin ko'rinadi; bo'sh g'aramda respawnInSec
      const snap = emitted.filter((e) => e.event === 'snap').pop()!.payload as Snapshot;
      assert.equal(snap.players.find((x) => x.id === 'p1')?.wood, WOOD_CARRY_MAX);
      const n2 = room.getNightSnap()!;
      const empty = n2.piles.find((x) => x.id === piles[0]!.id)!;
      assert.equal(empty.available, false);
      assert.ok((empty.respawnInSec ?? 0) > WOOD_PILE_RESPAWN_SEC - 15 && (empty.respawnInSec ?? 0) <= WOOD_PILE_RESPAWN_SEC, `respawnInSec ${empty.respawnInSec}`);
      // Qo'l to'la
      const pl4 = piles[3]!;
      p.pos = groundAt(room, pl4.x + 1.0, pl4.z);
      res = room.onTakeWood('p1', { pileId: pl4.id });
      assert.equal(res.error, 'HANDS_FULL');
      assert.equal(room.woodPiles.get(pl4.id)!.available, true);

      // Gulxan: uzoqdan TOO_FAR, yonida 3×60 qo'shiladi va maksimumda chegaralanadi
      const fire = room.campfires.get(night.fires[0]!.id)!;
      res = room.onFeedFire('p1', { fireId: fire.id });
      assert.equal(res.error, 'TOO_FAR');
      fire.fuelSec = 100;
      p.pos = groundAt(room, fire.x + 1.2, fire.z);
      const fedBefore = campfireEvents(emitted, 'fed').length;
      res = room.onFeedFire('p1', { fireId: fire.id });
      assert.equal(res.ok, true, res.error ?? '');
      assert.equal(res.wood, 0);
      assert.equal(p.wood, 0);
      assert.equal(res.fuelSec, CAMPFIRE_MAX_FUEL_SEC, `100 + 3×${CAMPFIRE_WOOD_FUEL_SEC} → ${CAMPFIRE_MAX_FUEL_SEC} da chegaralanadi`);
      assert.equal(Math.round(fire.fuelSec), CAMPFIRE_MAX_FUEL_SEC);
      const fed = campfireEvents(emitted, 'fed');
      assert.equal(fed.length, fedBefore + 1);
      assert.equal(fed[fed.length - 1]!.fireId, fire.id);
      assert.equal(fed[fed.length - 1]!.by, 'p1');
      assert.equal(fed[fed.length - 1]!.byName, 'Ovchi');
      assert.ok(systemChats(emitted).some((t) => t.includes("Ovchi gulxanga o'tin tashladi (3)")), 'chat xabari');
      // O'tinsiz — NO_WOOD; to'la gulxan — FIRE_FULL
      room.advanceTimeForTest(0.35, 1 / 30);
      assert.equal(room.onFeedFire('p1', { fireId: fire.id }).error, 'NO_WOOD');
      p.wood = 1;
      assert.equal(room.onFeedFire('p1', { fireId: fire.id }).error, 'FIRE_FULL');
      // Tezlik cheklovi: 0.3 s ichida ikkinchi amal xatosiz rad etiladi
      fire.fuelSec = 100;
      res = room.onFeedFire('p1', { fireId: fire.id });
      assert.equal(res.ok, true);
      p.wood = 1;
      res = room.onFeedFire('p1', { fireId: fire.id });
      assert.equal(res.ok, false);
      assert.equal(res.error, undefined, 'tezlik cheklovi — xato kodi yo‘q');
      // Boshqa rejimda — NOT_NIGHT
      const { io: io2 } = createFakeIo();
      const ffa = makeFfaRoom(io2, 0, 0);
      try {
        const s = createFakeSocket('h1');
        ffa.addHuman(s.socket, 'X');
        ffa.onReady('h1', { world: ffa.worldMeta() });
        assert.equal(ffa.onTakeWood('h1', { pileId: 'pile:1' }).error, 'NOT_NIGHT');
        assert.equal(ffa.getNightSnap(), null);
      } finally {
        ffa.destroy();
      }
    } finally {
      room.destroy();
    }
  });

  it("10. O'tin yonib tugaydi: 'low' hodisasi va ogohlantirish, keyin 'out' — gulxan o'chadi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      room.wolves.clear();
      const fire = room.campfires.get(room.getNightSnap()!.fires[0]!.id)!;
      const before = Math.round(fire.fuelSec);
      surviveFor(room, p, 5);
      assert.ok(fire.fuelSec < before - 4 && fire.fuelSec > before - 6, `o'tin sekundiga 1 kamayadi (${fire.fuelSec})`);
      assert.equal(campfireEvents(emitted).length, 0, 'hali hodisa yo‘q');
      fire.fuelSec = CAMPFIRE_LOW_FUEL_SEC + 2;
      surviveFor(room, p, 3);
      const low = campfireEvents(emitted, 'low');
      assert.equal(low.length, 1, "'low' bir marta");
      assert.equal(low[0]!.fireId, fire.id);
      assert.ok(systemChats(emitted).some((t) => t.includes("Asosiy lager gulxani o'chmoqda — o'tin keltiring!")));
      assert.equal(fire.lit, true);
      surviveFor(room, p, CAMPFIRE_LOW_FUEL_SEC + 2);
      assert.equal(campfireEvents(emitted, 'low').length, 1, "'low' takrorlanmaydi");
      const out = campfireEvents(emitted, 'out');
      assert.equal(out.length, 1);
      assert.equal(out[0]!.fuelSec, 0);
      assert.equal(fire.lit, false);
      assert.equal(fire.fuelSec, 0);
      assert.ok(systemChats(emitted).some((t) => t.includes("Asosiy lager gulxani o'chdi")));
      const snapFire = room.getNightSnap()!.fires.find((f) => f.id === fire.id)!;
      assert.equal(snapFire.lit, false);
      assert.equal(snapFire.fuelSec, 0);
      assert.equal(room.litFireContaining(fire.x, fire.z), null);
      // Qayta yoqish: o'tin tashlansa yonadi
      p.wood = 1;
      p.pos = groundAt(room, fire.x + 1.2, fire.z);
      const res = room.onFeedFire('p1', { fireId: fire.id });
      assert.equal(res.ok, true);
      assert.equal(fire.lit, true);
      assert.equal(res.fuelSec, CAMPFIRE_WOOD_FUEL_SEC);
      assert.ok(systemChats(emitted).some((t) => t.includes('qayta yoqdi')));
    } finally {
      room.destroy();
    }
  });

  it("11. Bo'ri olovdan qo'rqadi: gulxan yonidagi o'yinchini 15 s tishlamaydi, doiraga kirmaydi; gulxan o'chgach 10 s ichida tishlaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      p.spawnTime = -99;
      const w = [...room.wolves.values()][0]!;
      const fire = room.campfires.get(room.getNightSnap()!.fires[0]!.id)!;
      const dir = openDirFromFire(room, fire, 16);
      p.pos = groundAt(room, fire.x + dir.dx * 2, fire.z + dir.dz * 2);
      p.vel = { x: 0, y: 0, z: 0 };
      w.pos = groundAt(room, fire.x + dir.dx * 16, fire.z + dir.dz * 16);
      w.vel = { x: 0, y: 0, z: 0 };
      w.yaw = Math.atan2(-(p.pos.x - w.pos.x), -(p.pos.z - w.pos.z));
      w.brain.onDamaged(p, room.now());
      let minFireDist = Infinity;
      let bitten = false;
      for (let i = 0; i < 150; i++) {
        room.advanceTimeForTest(0.1, 1 / 30);
        if (p.hp < MAX_HP) bitten = true;
        p.hp = MAX_HP;
        p.vel = { x: 0, y: 0, z: 0 };
        p.pos = groundAt(room, fire.x + dir.dx * 2, fire.z + dir.dz * 2);
        minFireDist = Math.min(minFireDist, Math.hypot(w.pos.x - fire.x, w.pos.z - fire.z));
      }
      assert.equal(bitten, false, "yonib turgan gulxan yonidagi o'yinchi tishlanmaydi");
      assert.ok(
        !emitted.some((e) => e.event === 'wolf:bite' && (e.payload as WolfBiteEvent).hit),
        'tishlash hodisasi yo‘q',
      );
      assert.ok(minFireDist >= CAMPFIRE_RADIUS_M - 0.5, `bo'ri gulxanga ${minFireDist.toFixed(1)} m dan yaqin kelmaydi`);
      assert.equal(w.targetId, 'p1', "bo'ri nishonni ushlab turadi (chetida kutadi)");
      assert.ok(w.state === 'alert' || w.state === 'howl', `chetida hushyor/uvlaydi (${w.state})`);
      const dWolfPlayer = Math.hypot(w.pos.x - p.pos.x, w.pos.z - p.pos.z);
      assert.ok(dWolfPlayer < 16, `bo'ri olov chetiga yaqinlashgan (${dWolfPlayer.toFixed(1)} m)`);

      // Gulxan o'chadi — bo'ri qorong'i lagerga kirib tishlaydi
      fire.fuelSec = 0;
      let bittenAfter = false;
      for (let i = 0; i < 100 && !bittenAfter; i++) {
        room.advanceTimeForTest(0.1, 1 / 30);
        if (p.hp < MAX_HP) bittenAfter = true;
        p.hp = MAX_HP;
        p.vel = { x: 0, y: 0, z: 0 };
      }
      assert.equal(fire.lit, false);
      assert.equal(campfireEvents(emitted, 'out').length, 1);
      assert.ok(bittenAfter, "gulxan o'chgach 10 s ichida tishlaydi");
    } finally {
      room.destroy();
    }
  });

  it("12. Bot lagerni boqadi: o'tinli bot 5 m dagi o'chayotgan gulxanga ~20 s ichida o'tin tashlaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { bots: 1 });
    try {
      const { p } = startSoloNight(room);
      room.wolves.clear();
      const bot = [...room.players.values()].find((x) => x.isBot)!;
      assert.ok(bot.alive, 'bot ishtirokchi sifatida tug‘ildi');
      const fire = room.campfires.get(room.getNightSnap()!.fires[0]!.id)!;
      assert.ok(Math.hypot(bot.pos.x - fire.x, bot.pos.z - fire.z) <= 6, 'bot ham asosiy gulxan yonida tug‘iladi');
      // Odam yo'ldan chetda tursin
      p.pos = groundAt(room, fire.x - 6, fire.z);
      const dir = openDirFromFire(room, fire, 6);
      bot.pos = groundAt(room, fire.x + dir.dx * 5, fire.z + dir.dz * 5);
      bot.vel = { x: 0, y: 0, z: 0 };
      bot.wood = WOOD_CARRY_MAX;
      fire.fuelSec = 20;
      let fedAt = -1;
      for (let i = 0; i < 200 && fedAt < 0; i++) {
        room.advanceTimeForTest(0.1, 1 / 30);
        p.hp = MAX_HP;
        if (bot.wood === 0) fedAt = i;
      }
      assert.ok(fedAt >= 0, `bot 20 s ichida o'tin tashlaydi (fuel=${fire.fuelSec.toFixed(1)}, wood=${bot.wood})`);
      assert.ok(fire.fuelSec > 150, `gulxan to'ldi: ${fire.fuelSec.toFixed(1)} s`);
      const fed = campfireEvents(emitted, 'fed');
      assert.equal(fed.length, 1);
      assert.equal(fed[0]!.by, bot.id);
      assert.equal(fed[0]!.byName, bot.name);
      // Bot o'yinchini nishonga olmaydi (hamkorlik) — joni to'liq
      assert.equal(p.hp, MAX_HP);
    } finally {
      room.destroy();
    }
  });
});
