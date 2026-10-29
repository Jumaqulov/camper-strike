import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { sanitizeOpts } from '../../server/lobby';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
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
  WOLF_NIGHT_RESPAWN_SEC,
  WOLF_RESPAWN_SEC,
  WOOD_CARRY_MAX,
  NIGHT_DIFFICULTIES,
  NIGHT_WOLF_CAP,
  WOLF_ALPHA_BUFF_RADIUS,
  WOLF_ALPHA_BUFF_SEC,
  WOLF_COAT_BLACK,
  WOLF_COAT_CHARCOAL,
  WOLF_COAT_RED,
  WOLF_COAT_TAN,
  WOLF_COAT_WHITE,
  WOLF_DAWN_FLEE_SEC,
  WOLF_DAWN_GONE_MAX_SEC,
  NIGHT_DAWN_EPILOGUE_SEC,
  WOLF_HEIGHT,
  WOLF_MAX_PER_ROOM,
  WOLF_RADIUS,
  NIGHT_AWARD_TITLES_UZ,
  computeNightSummary,
  nightPlayerScore,
  nightWolvesForWave,
  sanitizeNightDifficulty,
  wolfCoatTraits,
  type NightPlayerStats,
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
  // Kesma gulxan tosh halqasi (campfire_pit_01 kollayderi) tashqarisidan boshlanadi — tun gulxani o'choq ustida yonadi
  const RING = 1.2;
  for (let k = 0; k < 16; k++) {
    const ang = (k / 16) * Math.PI * 2;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const a = { x: fire.x + dx * RING, y: fire.y, z: fire.z + dz * RING };
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

function lastSnap(emitted: EmittedRoomEvent[]): Snapshot {
  const s = emitted.filter((e) => e.event === 'snap').pop()?.payload as Snapshot | undefined;
  assert.ok(s, 'snap hodisasi yuborilgan');
  return s!;
}

/** Yakka odamli tunda (1 ishtirokchi) `wave` dagi kutilgan bo'rilar soni. */
function soloWolves(waveIdx: number, difficulty: keyof typeof NIGHT_DIFFICULTIES = 'normal'): number {
  return nightWolvesForWave(NIGHT_WAVES[waveIdx]!, 1, difficulty);
}

/**
 * O'yinchini ochiq chiziqning bir uchiga, bo'rini 6 m naridagi uchiga qo'yib, bo'ri o'lguncha avtomatdan
 * otadi (server ichidagi botFire — fire() yo'li; vaqt o'tmaydi, bo'ri joyidan siljimaydi).
 */
function shootWolfDead(room: Room, p: ServerPlayer, w: ServerWolf): void {
  const line = findOpenLine(room, 6);
  p.pos = { ...line.a };
  p.vel = { x: 0, y: 0, z: 0 };
  w.pos = { ...line.b };
  w.vel = { x: 0, y: 0, z: 0 };
  p.weapon = 'rifle';
  p.reloadWeapon = null;
  p.switchUntil = 0;
  for (let i = 0; i < 60 && w.alive; i++) {
    p.ammo.rifle = { mag: 30, reserve: 90 };
    w.vel = { x: 0, y: 0, z: 0 };
    const eye = { x: p.pos.x, y: p.pos.y + 1.62, z: p.pos.z };
    const center = { x: w.pos.x, y: w.pos.y + 0.6, z: w.pos.z };
    const ang = anglesFromDir(vnorm(vsub(center, eye)));
    p.yaw = ang.yaw;
    p.pitch = ang.pitch;
    p.lastShot = -99;
    room.botFire(p, 0);
  }
  assert.equal(w.alive, false, `bo'ri otib o'ldirildi (hp=${w.hp})`);
}

const GREY_COATS = [WOLF_COAT_CHARCOAL, WOLF_COAT_TAN];

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

  it("2. Yakka odam botlarsiz raund boshlaydi; zona yo'q, 1-to'lqinda 1 ishtirokchiga moslangan bo'rilar", () => {
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
      assert.equal(night!.wolvesAlive, soloWolves(0));
      assert.ok(night!.dawnInSec > 230 && night!.dawnInSec <= 240, `tonggacha ~240 s (${night!.dawnInSec})`);
      assert.equal(room.wolves.size, soloWolves(0));
      const w = [...room.wolves.values()][0]!;
      assert.ok(GREY_COATS.includes(w.coat), "1-to'lqinda faqat oddiy bo'rilar");
      assert.equal(w.speedMul, NIGHT_WAVES[0]!.speedMul);
      assert.equal(w.hp, Math.round(WOLF_MAX_HP * NIGHT_WAVES[0]!.hpMul));
      const m = lastMatch(emitted);
      assert.equal(m.mode, 'wolf_night');
      assert.equal(m.survival?.zone, null);
      assert.equal(m.survival?.night?.wave, 1);
      assert.deepEqual(m.survival?.winnerIds, []);
      // Chat buyrug'i bilan bo'rilar soni o'zgarmaydi
      assert.equal(room.setWolfCount(4), soloWolves(0));
      assert.equal(room.wolves.size, soloWolves(0));
    } finally {
      room.destroy();
    }
  });

  it("3. To'lqinlar: 25% va 75% da moslangan sondagi bo'rilar (kuchliroq); o'lgan bo'ri qayta tug'iladi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io, { timeLimit: 4 });
    try {
      const { p } = startSoloNight(room);
      p.spawnTime = -99;
      // 25% → 2-to'lqin
      surviveFor(room, p, 61);
      assert.equal(room.phase, 'playing', 'yakka tirik qolgan raundni tugatmaydi');
      assert.equal(room.wolves.size, soloWolves(1), '2-to‘lqinda 1 ishtirokchiga moslangan bo‘rilar');
      const list2 = [...room.wolves.values()];
      const newest2 = list2[list2.length - 1]!;
      // Ko'paytuvchi = to'lqin × qiyinlik (normal = 1) × rang turi
      assert.equal(newest2.speedMul, NIGHT_WAVES[1]!.speedMul * 1 * wolfCoatTraits(newest2.coat).speedMul, 'yangi bo‘ri 2-to‘lqin kuchida');
      assert.equal(list2[0]!.speedMul, NIGHT_WAVES[0]!.speedMul, 'eski bo‘ri o‘z ko‘rsatkichini saqlaydi');
      assert.equal(room.getNightSnap()!.wave, 2);
      // 75% → 4-to'lqin
      surviveFor(room, p, 120);
      assert.equal(room.phase, 'playing');
      assert.equal(room.wolves.size, soloWolves(3), '4-to‘lqinda moslangan bo‘rilar');
      assert.equal(room.getNightSnap()!.wave, 4);
      const newest = [...room.wolves.values()].pop()!;
      const nk = wolfCoatTraits(newest.coat);
      assert.equal(newest.hpMul, NIGHT_WAVES[3]!.hpMul * 1 * nk.hpMul);
      assert.equal(newest.biteMul, NIGHT_WAVES[3]!.biteMul * 1 * nk.biteMul);

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
      assert.equal(room.wolves.size, soloWolves(3), 'jasad o‘chmaydi — qayta tug‘ilishni kutadi');
      assert.ok(Math.abs(w.respawnAt - w.diedAt - NIGHT_DIFFICULTIES.normal.respawnSec) < 1e-9, 'qaytish vaqti qiyinlikdan');
      // Tunda qayta tug'ilish WOLF_NIGHT_RESPAWN_SEC (klassikdagi WOLF_RESPAWN_SEC dan tezroq)
      assert.ok(WOLF_NIGHT_RESPAWN_SEC < WOLF_RESPAWN_SEC && WOLF_NIGHT_RESPAWN_SEC > WOLF_CORPSE_SEC);
      surviveFor(room, p, WOLF_NIGHT_RESPAWN_SEC - 1);
      assert.equal(w.alive, false, 'qayta tug‘ilish vaqtigacha jasad');
      surviveFor(room, p, 2);
      assert.equal(room.phase, 'playing');
      assert.equal(w.alive, true, "bo'ri qayta tug'ildi");
      // Qayta tug'ilganda rang (tur) qaytadan tanlanadi va uning ko'rsatkichlari qo'llanadi
      assert.equal(w.hpMul, NIGHT_WAVES[3]!.hpMul * 1 * wolfCoatTraits(w.coat).hpMul, 'qayta tug‘ilgan bo‘ri joriy to‘lqin kuchida');
      assert.equal(w.hp, Math.round(WOLF_MAX_HP * w.hpMul));
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
      // Tong otgach bo'rilar uvlab (tong xori) o'rmonga qochadi (WOLF_DAWN_GONE_MAX_SEC ichida) — yakun ekrani davomida yo'qoladi
      assert.ok([...room.wolves.values()].every((w) => !w.alive || Number.isFinite(w.fleeUntil)), "qolgan bo'rilar tong xorida");
      room.advanceTimeForTest(WOLF_DAWN_GONE_MAX_SEC + 0.5, 0.25);
      assert.equal(room.phase, 'ended');
      assert.equal(room.wolves.size, 0, 'tong otgach bo‘rilar ketadi');
      // Tong epilogi va yakunlash ko'rsatuvi o'tgach yakka odam yana sanoqqa o'tadi
      room.advanceTimeForTest(MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC - WOLF_DAWN_GONE_MAX_SEC, 0.25);
      assert.equal(room.phase, 'countdown');
      assert.deepEqual(room.getSurvivalState()!.winnerIds, []);
    } finally {
      room.destroy();
    }
  });

  it("5. Hamma o'lsa (asosiy gulxan o'chgan) — 'draw_no_survivors', o'lim hodisasida weapon='wolf'", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { timeLimit: 3 });
    try {
      const { p } = startSoloNight(room);
      // Asosiy gulxan o'chgan — halok bo'lganlar keyingi to'lqinda qaytmaydi, raund darhol tugaydi
      // (gulxan yonib tursa qaytish kutiladi — stage20 testlari)
      const main = [...room.campfires.values()].find((f) => f.main)!;
      main.lit = false;
      main.fuelSec = 0;
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
      assert.equal(room.wolves.size, 0, "bo'rilar yutganda bo'rilar darhol tozalanadi (avvalgidek)");
      // Natija: tong otmadi, hech kim tirik emas, hamma qiymat 0 — mukofot yo'q
      const sum = surv.nightSummary!;
      assert.ok(sum, 'nightSummary yakunda bor');
      assert.equal(sum.dawn, false);
      assert.equal(sum.stats.length, 1);
      assert.equal(sum.stats[0]!.survived, false);
      assert.deepEqual(sum.awards, []);
      assert.equal(lastMatch(emitted).survival?.nightSummary?.dawn, false);
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

  it("8. Lager joylashuvi: 3 gulxan (asosiy birinchi, yonib turadi), 12 g'aram, yuriladigan yerda, masofalar; o'yinchi asosiy gulxan yonida tug'iladi", () => {
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

  it("9. O'tin olish / gulxanga tashlash: TOO_FAR, 3 ta o'tin, HANDS_FULL, g'aram bo'shaydi, har o'tin +45 s — faqat sig'adigani tashlanadi, 'fed' hodisasi", () => {
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

      // Gulxan: uzoqdan TOO_FAR; yonida faqat sig'adigan o'tin tashlanadi (100 s + 2×45 → 180 da chegara),
      // ortiqchasi qo'lda qoladi
      const fire = room.campfires.get(night.fires[0]!.id)!;
      res = room.onFeedFire('p1', { fireId: fire.id });
      assert.equal(res.error, 'TOO_FAR');
      fire.fuelSec = 100;
      p.pos = groundAt(room, fire.x + 1.2, fire.z);
      const fedBefore = campfireEvents(emitted, 'fed').length;
      res = room.onFeedFire('p1', { fireId: fire.id });
      assert.equal(res.ok, true, res.error ?? '');
      const used = Math.ceil((CAMPFIRE_MAX_FUEL_SEC - 100) / CAMPFIRE_WOOD_FUEL_SEC);
      assert.equal(used, 2);
      assert.equal(res.wood, WOOD_CARRY_MAX - used, "sig'magan o'tin qo'lda qoladi");
      assert.equal(p.wood, WOOD_CARRY_MAX - used);
      assert.equal(res.fuelSec, CAMPFIRE_MAX_FUEL_SEC, `100 + ${used}×${CAMPFIRE_WOOD_FUEL_SEC} → ${CAMPFIRE_MAX_FUEL_SEC} da chegaralanadi`);
      assert.equal(Math.round(fire.fuelSec), CAMPFIRE_MAX_FUEL_SEC);
      const fed = campfireEvents(emitted, 'fed');
      assert.equal(fed.length, fedBefore + 1);
      assert.equal(fed[fed.length - 1]!.fireId, fire.id);
      assert.equal(fed[fed.length - 1]!.by, 'p1');
      assert.equal(fed[fed.length - 1]!.byName, 'Ovchi');
      assert.ok(systemChats(emitted).some((t) => t.includes(`Ovchi gulxanga o'tin tashladi (${used})`)), 'chat xabari');
      // To'la gulxan — FIRE_FULL (o'tin qo'lda qoladi); o'tinsiz — NO_WOOD
      room.advanceTimeForTest(0.35, 1 / 30);
      const full = room.onFeedFire('p1', { fireId: fire.id });
      assert.equal(full.error, 'FIRE_FULL');
      assert.equal(full.wood, WOOD_CARRY_MAX - used);
      p.wood = 0;
      assert.equal(room.onFeedFire('p1', { fireId: fire.id }).error, 'NO_WOOD');
      // Tezlik cheklovi: 0.3 s ichida ikkinchi amal xatosiz rad etiladi
      fire.fuelSec = 100;
      p.wood = 1;
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

  it("13. Keyingi tun sanog'ida lager tiklangan: gulxanlar yonib turibdi (boshlang'ich o'tin), g'aramlar to'la, qo'lda o'tin yo'q", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io, { timeLimit: 3 });
    try {
      const { p } = startSoloNight(room);
      room.wolves.clear();
      p.spawnTime = -99;
      room.setSurvivalConfigForTest({ roundDurationSec: 20 });
      const fire = room.campfires.get(room.getNightSnap()!.fires[0]!.id)!;
      const pile = [...room.woodPiles.values()][0]!;
      fire.fuelSec = 0.5;
      pile.available = false;
      pile.respawnAt = room.now() + 999;
      surviveFor(room, p, 2);
      assert.equal(fire.lit, false, "gulxan o'chdi");
      p.wood = 2;
      surviveFor(room, p, 30);
      assert.equal(room.phase, 'ended');
      room.advanceTimeForTest(MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC + 0.5, 0.25);
      assert.equal(room.phase, 'countdown');
      const night = room.getNightSnap()!;
      assert.ok(night, 'sanoqda ham tun holati yuboriladi');
      for (const f of night.fires) {
        assert.equal(f.lit, true, `gulxan ${f.id} yana yonadi`);
        assert.equal(f.fuelSec, CAMPFIRE_START_FUEL_SEC);
      }
      assert.ok(night.piles.every((x) => x.available), "g'aramlar to'la");
      assert.equal(p.wood, 0, "o'tgan tunning o'tini qolmaydi");
    } finally {
      room.destroy();
    }
  });

  it('14. timeLimit berilmasa tun lobbidagi standart davomiylikda (NIGHT_DEFAULT_MINUTES)', () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io, { timeLimit: undefined as unknown as number });
    try {
      assert.equal(room.survival!.getConfig().roundDurationSec, NIGHT_DEFAULT_MINUTES * 60);
    } finally {
      room.destroy();
    }
  });

  it("15. Qurolsiz bot bo'ridan gulxan doirasidan chiqib qochmaydi; tashqarida bo'lsa yaqin gulxanga yuguradi", () => {
    const run = (place: (r: Room, fire: Vec3, dir: { dx: number; dz: number }) => { bot: Vec3; wolf: Vec3 }) => {
      const { io } = createFakeIo();
      const room = makeNightRoom(io, { bots: 1 });
      try {
        const { p } = startSoloNight(room);
        const night = room.getNightSnap()!;
        const fire = room.campfires.get(night.fires[0]!.id)!;
        // Odam boshqa gulxan yonida — bo'ri faqat botni ko'radi
        const far = night.fires[1]!;
        const keep = [...room.wolves.values()][0]!;
        for (const id of [...room.wolves.keys()]) if (id !== keep.id) room.wolves.delete(id);
        const bot = [...room.players.values()].find((x) => x.isBot)!;
        bot.weapon = null;
        bot.ammo = emptyAmmo();
        bot.spawnTime = -99;
        const dir = openDirFromFire(room, fire, 16);
        const pos = place(room, { x: fire.x, y: fire.y, z: fire.z }, dir);
        bot.pos = pos.bot;
        bot.vel = { x: 0, y: 0, z: 0 };
        keep.pos = pos.wolf;
        keep.vel = { x: 0, y: 0, z: 0 };
        keep.brain.onDamaged(bot, room.now());
        const fireDist = () => Math.hypot(bot.pos.x - fire.x, bot.pos.z - fire.z);
        const track: number[] = [];
        for (let i = 0; i < 60; i++) {
          room.advanceTimeForTest(0.1, 1 / 30);
          p.pos = groundAt(room, far.x + 1, far.z);
          p.vel = { x: 0, y: 0, z: 0 };
          p.hp = MAX_HP;
          track.push(fireDist());
        }
        return { track, botHp: bot.hp, wolfTarget: keep.targetId, botId: bot.id };
      } finally {
        room.destroy();
      }
    };

    // a) Bot doira ichida (markazdan 4 m), bo'ri o'sha tomonda doiradan tashqarida — bot doirada qoladi
    const a = run((r, f, d) => ({
      bot: groundAt(r, f.x + d.dx * 4, f.z + d.dz * 4),
      wolf: groundAt(r, f.x + d.dx * 11, f.z + d.dz * 11),
    }));
    assert.ok(Math.max(...a.track) <= CAMPFIRE_RADIUS_M, `bot doiradan chiqmaydi (max ${Math.max(...a.track).toFixed(1)} m)`);
    assert.equal(a.botHp, MAX_HP, 'gulxan doirasidagi botni bo‘ri tishlamaydi');

    // b) Bot doiradan tashqarida (12 m), bo'ri yon tomondan keladi — bot gulxanga yuguradi va doirada qoladi
    const b = run((r, f, d) => {
      const bx = f.x + d.dx * 12;
      const bz = f.z + d.dz * 12;
      return { bot: groundAt(r, bx, bz), wolf: groundAt(r, bx - d.dz * 10, bz + d.dx * 10) };
    });
    const firstIn = b.track.findIndex((x) => x <= CAMPFIRE_RADIUS_M);
    assert.ok(firstIn >= 0 && firstIn <= 40, `bot 4 s ichida gulxan doirasiga kiradi (${firstIn}, min ${Math.min(...b.track).toFixed(1)} m)`);
    assert.ok(b.track.slice(firstIn).every((x) => x <= CAMPFIRE_RADIUS_M), 'kirgach doirada qoladi');
  });

  it("16. Gulxan doirasidagi o'q ovozi: bo'ri chetigacha borib tekshiradi, olovga kirib-chiqib tebranmaydi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const night = room.getNightSnap()!;
      const fire = room.campfires.get(night.fires[0]!.id)!;
      const far = night.fires[1]!;
      const w = [...room.wolves.values()][0]!;
      for (const id of [...room.wolves.keys()]) if (id !== w.id) room.wolves.delete(id);
      const dir = openDirFromFire(room, fire, 16);
      w.pos = groundAt(room, fire.x + dir.dx * 16, fire.z + dir.dz * 16);
      w.vel = { x: 0, y: 0, z: 0 };
      w.brain.onNoise({ x: fire.x, y: fire.y + 1.5, z: fire.z }, room.now(), null);
      let minD = Infinity;
      let burningTicks = 0;
      let sniffed = false;
      for (let i = 0; i < 120 && !sniffed; i++) {
        room.advanceTimeForTest(1 / 30, 1 / 30);
        p.pos = groundAt(room, far.x + 1, far.z);
        p.vel = { x: 0, y: 0, z: 0 };
        p.hp = MAX_HP;
        const d = Math.hypot(w.pos.x - fire.x, w.pos.z - fire.z);
        minD = Math.min(minD, d);
        if (room.litFireContaining(w.pos.x, w.pos.z, 1)) burningTicks++;
        if (w.state === 'sniff') sniffed = true;
      }
      assert.ok(sniffed, "bo'ri olov chetida hid oladi (tekshiruv tugadi)");
      assert.equal(burningTicks, 0, "bo'ri olov doirasiga (+1 m) kirmaydi");
      assert.ok(minD >= CAMPFIRE_RADIUS_M + 1, `chetida to'xtaydi (min ${minD.toFixed(1)} m)`);
    } finally {
      room.destroy();
    }
  });

  // ---------------- 3-bosqich: qiyinlik, bo'ri turlari, tong otishi, tun natijasi ----------------

  it('17. Tun qiyinligi: sanitizeNightDifficulty/sanitizeOpts, RoomInfo.nightDifficulty faqat wolf_night da', () => {
    assert.equal(sanitizeNightDifficulty('hard'), 'hard');
    assert.equal(sanitizeNightDifficulty('easy'), 'easy');
    assert.equal(sanitizeNightDifficulty('HARD'), 'normal');
    assert.equal(sanitizeNightDifficulty(undefined), 'normal');
    assert.equal(sanitizeNightDifficulty(3), 'normal');
    assert.equal(sanitizeOpts({ mode: 'wolf_night', nightDifficulty: 'hard' }, 'X').nightDifficulty, 'hard');
    assert.equal(sanitizeOpts({ mode: 'wolf_night', nightDifficulty: 'nope' as unknown as 'hard' }, 'X').nightDifficulty, 'normal');
    assert.equal(sanitizeOpts({ mode: 'wolf_night' }, 'X').nightDifficulty, 'normal');
    assert.equal(sanitizeOpts({ mode: 'ffa', nightDifficulty: 'hard' }, 'X').nightDifficulty, undefined, 'boshqa rejimda maydon yo‘q');
    assert.equal(sanitizeOpts({ mode: 'forest_survival', nightDifficulty: 'hard' }, 'X').nightDifficulty, undefined);
    const { io } = createFakeIo();
    const hard = makeNightRoom(io, { nightDifficulty: 'hard' });
    const def = makeNightRoom(io);
    const bogus = makeNightRoom(io, { nightDifficulty: 'x' as unknown as 'hard' });
    const ffa = makeFfaRoom(io, 0, 0);
    try {
      assert.equal(hard.nightDifficulty, 'hard');
      assert.equal(hard.info().nightDifficulty, 'hard');
      assert.equal(def.info().nightDifficulty, 'normal');
      assert.equal(bogus.info().nightDifficulty, 'normal', 'xona ham noma‘lum qiymatni tozalaydi');
      assert.equal(ffa.info().nightDifficulty, undefined);
    } finally {
      hard.destroy();
      def.destroy();
      bogus.destroy();
      ffa.destroy();
    }
  });

  it("18. To'lqindagi bo'rilar soni tirik ishtirokchilar va qiyinlikka moslanadi, NIGHT_WOLF_CAP dan oshmaydi", () => {
    // Jadval ~3 ishtirokchi uchun: 'normal' da 3 kishi — aynan NIGHT_WAVES dagi son
    for (const wave of NIGHT_WAVES) {
      assert.equal(nightWolvesForWave(wave, 3, 'normal'), wave.wolves, `${wave.wave}-to'lqin, 3 ishtirokchi`);
      assert.ok(nightWolvesForWave(wave, 1, 'normal') <= wave.wolves, 'yakka — kamroq');
      assert.ok(nightWolvesForWave(wave, 8, 'normal') >= wave.wolves, "ko'p ishtirokchi — ko'proq");
      assert.ok(nightWolvesForWave(wave, 3, 'easy') <= wave.wolves);
      assert.ok(nightWolvesForWave(wave, 3, 'hard') >= wave.wolves);
      for (let n = 0; n <= 16; n++) {
        for (const d of ['easy', 'normal', 'hard'] as const) {
          const k = nightWolvesForWave(wave, n, d);
          assert.ok(k >= 1 && k <= NIGHT_WOLF_CAP, `1..${NIGHT_WOLF_CAP} (${k})`);
        }
      }
    }
    assert.equal(nightWolvesForWave(NIGHT_WAVES[3]!, 8, 'hard'), NIGHT_WOLF_CAP);
    assert.ok(NIGHT_WOLF_CAP > WOLF_MAX_PER_ROOM);

    // Xona: 1 odam + 7 bot, 'hard' — 4-to'lqinda NIGHT_WOLF_CAP ta bo'ri (klassik chegaradan ko'p)
    const { io } = createFakeIo();
    const room = makeNightRoom(io, { bots: 7, nightDifficulty: 'hard' });
    try {
      const { p } = startSoloNight(room);
      p.spawnTime = -99;
      assert.equal(room.getSurvivalState()!.aliveCount, 8);
      // Statistika har bir ishtirokchi (odam va bot) uchun
      const stats = room.getNightStatsForTest();
      assert.equal(stats.length, 8);
      assert.equal(stats.filter((s) => s.isBot).length, 7);
      assert.equal(room.wolves.size, nightWolvesForWave(NIGHT_WAVES[0]!, 8, 'hard'));
      const H = NIGHT_DIFFICULTIES.hard;
      for (const w of room.wolves.values()) {
        const k = wolfCoatTraits(w.coat);
        assert.ok(Math.abs(w.speedMul - NIGHT_WAVES[0]!.speedMul * H.speedMul * k.speedMul) < 1e-9, 'to‘lqin × qiyinlik × tur');
        assert.ok(Math.abs(w.biteMul - NIGHT_WAVES[0]!.biteMul * H.biteMul * k.biteMul) < 1e-9);
        assert.equal(w.hp, Math.round(WOLF_MAX_HP * NIGHT_WAVES[0]!.hpMul * H.hpMul * k.hpMul));
      }
      // Qiyin tunda o'ldirilgan bo'ri tezroq qaytadi
      const w0 = [...room.wolves.values()][0]!;
      shootWolfDead(room, p, w0);
      // Vaqtlar soniyada (kasr) — ayirma suzuvchi nuqta xatosigacha teng
      assert.ok(Math.abs(w0.respawnAt - w0.diedAt - H.respawnSec) < 1e-9, `qaytish vaqti ${w0.respawnAt - w0.diedAt} s (${H.respawnSec})`);
      // 4-to'lqingacha (tun 40 s): hamma tirik tutiladi — ishtirokchilar soni 8 bo'lib qoladi
      room.setSurvivalConfigForTest({ roundDurationSec: 40 });
      for (let i = 0; i < 400 && room.getNightSnap()!.wave < 4; i++) {
        room.advanceTimeForTest(0.1, 1 / 30);
        for (const pl of room.players.values()) pl.hp = MAX_HP;
      }
      assert.equal(room.phase, 'playing');
      assert.equal(room.getNightSnap()!.wave, 4);
      assert.equal(room.getSurvivalState()!.aliveCount, 8);
      assert.equal(room.wolves.size, NIGHT_WOLF_CAP, `4-to'lqinda ${NIGHT_WOLF_CAP} ta bo'ri`);
      assert.ok(room.addWolf() === null, 'chegaradan ortiq bo‘ri qo‘shilmaydi');
    } finally {
      room.destroy();
    }
  });

  it("19. Bo'ri turlari: 1-to'lqinda faqat oddiy, 2-dan chaqqon/soya, 3-dan to'da boshlig'i — bir vaqtda ko'pi bilan bitta", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { nightDifficulty: 'hard' });
    try {
      const { p } = startSoloNight(room);
      room.setSurvivalConfigForTest({ roundDurationSec: 80 });
      const seen = new Map<number, Set<number>>();
      let maxAlpha = 0;
      let firstAlphaWave = 0;
      for (let i = 0; i < 300 && room.phase === 'playing'; i++) {
        room.advanceTimeForTest(0.25, 1 / 30);
        p.hp = MAX_HP;
        p.vel = { x: 0, y: 0, z: 0 };
        const wave = room.getNightSnap()!.wave;
        const alive = [...room.wolves.values()].filter((w) => w.alive);
        const alphas = alive.filter((w) => w.coat === WOLF_COAT_WHITE).length;
        assert.ok(alphas <= 1, `bir vaqtda ko'pi bilan bitta to'da boshlig'i (${alphas})`);
        maxAlpha = Math.max(maxAlpha, alphas);
        if (alphas > 0 && !firstAlphaWave) firstAlphaWave = wave;
        if (!seen.has(wave)) seen.set(wave, new Set());
        for (const w of alive) {
          seen.get(wave)!.add(w.coat);
          if (wave < 3) assert.notEqual(w.coat, WOLF_COAT_WHITE, `${wave}-to'lqinda to'da boshlig'i yo'q`);
          if (wave < 2) assert.ok(GREY_COATS.includes(w.coat), "1-to'lqinda faqat oddiy bo'rilar");
          // Tur ko'rsatkichi har doim qo'llangan (to'lqin ko'paytuvchisi bo'ri tug'ilgan to'lqindan)
          const k = wolfCoatTraits(w.coat);
          const waveMul = w.hpMul / (k.hpMul * NIGHT_DIFFICULTIES.hard.hpMul);
          assert.ok(NIGHT_WAVES.some((x) => Math.abs(x.hpMul - waveMul) < 1e-9), `hpMul = to'lqin × qiyinlik × tur (${w.hpMul})`);
        }
        // Qayta tug'ilishni tezlashtiramiz: har 1 s da bitta bo'ri "o'ladi" va darhol qaytadi (rang qayta tanlanadi)
        if (i % 4 === 3 && alive.length) {
          const w = alive[i % alive.length]!;
          w.alive = false;
          w.state = 'dead';
          w.hp = 0;
          w.diedAt = room.now() - WOLF_CORPSE_SEC - 0.1;
          w.respawnAt = room.now();
        }
      }
      assert.ok(seen.get(4), "4-to'lqinga yetildi");
      assert.equal(maxAlpha, 1, "3-to'lqindan to'da boshlig'i chiqadi");
      assert.equal(firstAlphaWave, 3, "to'da boshlig'i 3-to'lqin boshida keladi");
      const laterCoats = new Set([...(seen.get(2) ?? []), ...(seen.get(3) ?? []), ...(seen.get(4) ?? [])]);
      assert.ok(laterCoats.has(WOLF_COAT_RED) || laterCoats.has(WOLF_COAT_BLACK), "2-to'lqindan chaqqon/soya bo'rilar");
      assert.ok(systemChats(emitted).some((t) => t.includes("To'da boshlig'i keldi")), 'chatda e‘lon');
      // Snapshotda rang (klient GLB tanlaydi)
      const snapWolves = lastSnap(emitted).wolves ?? [];
      for (const sw of snapWolves) assert.equal(sw.coat, room.wolves.get(sw.id)!.coat);
    } finally {
      room.destroy();
    }
  });

  it("20. To'da boshlig'i: jon/tishlash/tezlik ko'paytuvchilari, katta xitboks, uvlashi yaqin bo'rilarni tezlashtiradi, o'ldirilsa chatda nomi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      p.spawnTime = -99;
      const alpha = [...room.wolves.values()][0]!;
      const grey = room.addWolf()!;
      const far = room.addWolf()!;
      assert.ok(GREY_COATS.includes(grey.coat) && GREY_COATS.includes(far.coat), "1-to'lqin — oddiy bo'rilar");
      room.setWolfCoatForTest(alpha, WOLF_COAT_WHITE);
      const A = wolfCoatTraits(WOLF_COAT_WHITE);
      assert.equal(A.kind, 'alpha');
      assert.equal(alpha.hpMul, NIGHT_WAVES[0]!.hpMul * 1 * A.hpMul);
      assert.equal(alpha.hp, Math.round(WOLF_MAX_HP * NIGHT_WAVES[0]!.hpMul * A.hpMul));
      assert.ok(alpha.hp > grey.hp, 'to‘da boshlig‘i chidamliroq');
      assert.equal(alpha.biteMul, NIGHT_WAVES[0]!.biteMul * 1 * A.biteMul);
      assert.equal(alpha.speedMul, NIGHT_WAVES[0]!.speedMul * 1 * A.speedMul);

      // Xitboks masshtabi: oddiy bo'ri xitboksidan tashqarida, boshliqnikida — tegadi
      const base = { ...alpha.pos };
      grey.pos = { ...base };
      const dirX = { x: 1, y: 0, z: 0 };
      const high = { x: base.x - 10, y: base.y + (WOLF_HEIGHT * (1 + A.scale)) / 2, z: base.z };
      assert.ok(room.rayVsWolfForTest(high, dirX, alpha, 50) !== null, 'baland nur boshliqqa tegadi');
      assert.equal(room.rayVsWolfForTest(high, dirX, grey, 50), null, 'oddiy bo‘riga tegmaydi');
      const side = { x: base.x - 10, y: base.y + 0.5, z: base.z + ((WOLF_RADIUS + 0.25) * (1 + A.scale)) / 2 };
      assert.ok(room.rayVsWolfForTest(side, dirX, alpha, 50) !== null, 'yon nur boshliqqa tegadi');
      assert.equal(room.rayVsWolfForTest(side, dirX, grey, 50), null);

      // Uvlash: radius ichidagi boshqa bo'ri tezlashadi, tashqaridagi va boshliqning o'zi — yo'q
      grey.pos = { x: base.x + 10, y: base.y, z: base.z };
      far.pos = { x: base.x + WOLF_ALPHA_BUFF_RADIUS + 10, y: base.y, z: base.z };
      const t0 = room.now();
      room.wolfHowl(alpha);
      assert.ok(Math.abs(grey.alphaBuffUntil - (t0 + WOLF_ALPHA_BUFF_SEC)) < 1e-6, 'yaqin bo‘ri tezlashdi');
      assert.equal(far.alphaBuffUntil, 0, 'uzoqdagi bo‘ri tezlashmaydi');
      assert.equal(alpha.alphaBuffUntil, 0, 'boshliqning o‘zi tezlashmaydi');
      grey.alphaBuffUntil = 0;
      room.wolfHowl(far);
      assert.equal(grey.alphaBuffUntil, 0, 'oddiy bo‘ri uvlashi tezlashtirmaydi');

      // O'ldirish: chatda tur nomi, statistika
      room.wolves.delete(grey.id);
      room.wolves.delete(far.id);
      const hp0 = alpha.hp;
      shootWolfDead(room, p, alpha);
      assert.ok(systemChats(emitted).some((t) => t.includes("Ovchi to'da boshlig'ini o'ldirdi!")), 'chatda tur nomi');
      const st = room.getNightStatsForTest()[0]!;
      assert.equal(st.wolfKills, 1);
      assert.equal(st.alphaKills, 1);
      assert.equal(st.wolfDamage, hp0, "zarar — bo'rining joni (ortiqcha hisoblanmaydi)");
    } finally {
      room.destroy();
    }
  });

  it("21. Tong otdi: bo'rilar uvlab 'flee' — yakun ekranida snapshotda qoladi, tishlamaydi, uzoqlashadi, keyin yo'qoladi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { timeLimit: 3 });
    try {
      const { p } = startSoloNight(room);
      p.spawnTime = -99;
      room.setSurvivalConfigForTest({ roundDurationSec: 12 });
      surviveFor(room, p, 10);
      assert.equal(room.phase, 'playing');
      // Tong otishidan oldin bo'rilar o'yinchi yonida hujumda
      const line = findOpenLine(room, 6);
      p.pos = { ...line.a };
      p.vel = { x: 0, y: 0, z: 0 };
      const wolves = [...room.wolves.values()].filter((w) => w.alive);
      assert.ok(wolves.length >= 2, `bo'rilar bor (${wolves.length})`);
      wolves.forEach((w, i) => {
        w.pos = i === 0 ? groundAt(room, line.a.x + 1.2, line.a.z) : { ...line.b };
        w.vel = { x: 0, y: 0, z: 0 };
        w.brain.onDamaged(p, room.now());
      });
      for (let i = 0; i < 40 && room.phase === 'playing'; i++) {
        room.advanceTimeForTest(0.1, 1 / 30);
        p.hp = MAX_HP;
        p.vel = { x: 0, y: 0, z: 0 };
        p.pos = { ...line.a };
      }
      assert.equal(room.phase, 'ended');
      assert.equal(room.getSurvivalState()!.winReason, 'dawn');
      const tDawn = room.now();
      const fleeing = [...room.wolves.values()].filter((w) => w.alive);
      assert.ok(fleeing.length >= 2, `yaqindagi bo'rilar darhol yo'qolmaydi (${fleeing.length})`);
      for (const w of fleeing) {
        // Tong xori: avval joyida turib uvlaydi ('idle' → 'howl'), keyin qochadi
        assert.equal(w.state, 'idle');
        assert.equal(w.targetId, null);
        assert.ok(w.fleeUntil <= tDawn + WOLF_DAWN_GONE_MAX_SEC + 1e-6);
      }
      const d0 = new Map(fleeing.map((w) => [w.id, Math.hypot(w.pos.x - p.pos.x, w.pos.z - p.pos.z)] as const));
      const bitesBefore = emitted.filter((e) => e.event === 'wolf:bite').length;
      const dawnStates = new Set(['idle', 'howl', 'flee']);
      let snapsWithDawn = 0;
      const steps = Math.round(NIGHT_DAWN_EPILOGUE_SEC * 10);
      for (let i = 0; i < steps; i++) {
        room.advanceTimeForTest(0.1, 1 / 30);
        p.pos = { ...line.a };
        p.vel = { x: 0, y: 0, z: 0 };
        const sw = (lastSnap(emitted).wolves ?? []).filter((x) => x.state !== 'dead');
        if (sw.length > 0 && sw.every((x) => dawnStates.has(x.state))) snapsWithDawn++;
        for (const w of room.wolves.values()) {
          if (w.alive) assert.ok(dawnStates.has(w.state), `'ended' fazasi tong xori/qochishni buzmaydi (${w.state})`);
        }
      }
      assert.equal(p.hp, MAX_HP, 'tong otgach bo‘ri tishlamaydi');
      assert.equal(emitted.filter((e) => e.event === 'wolf:bite').length, bitesBefore, "wolf:bite hodisasi yo'q");
      assert.ok(snapsWithDawn >= steps - 5, `yakun ekranida snapshotlarda uvlayotgan/qochayotgan bo'rilar (${snapsWithDawn})`);
      // Epilog oxirida hammasi uvlab bo'lgan va qochmoqda
      for (const sw of lastSnap(emitted).wolves ?? []) {
        if (sw.state === 'dead') continue;
        assert.equal(sw.state, 'flee');
        assert.equal(sw.targetId, undefined);
      }
      const still = fleeing.filter((w) => room.wolves.has(w.id));
      const gains = still.map((w) => Math.hypot(w.pos.x - p.pos.x, w.pos.z - p.pos.z) - d0.get(w.id)!);
      const avgGain = gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : Infinity;
      assert.ok(avgGain > 5, `bo'rilar o'yinchidan uzoqlashadi (o'rtacha +${avgGain.toFixed(1)} m)`);
      // WOLF_DAWN_GONE_MAX_SEC dan keyin hammasi yo'q, yakun ekrani hali davom etadi
      room.advanceTimeForTest(tDawn + WOLF_DAWN_GONE_MAX_SEC + 0.3 - room.now(), 1 / 30);
      assert.equal(room.phase, 'ended');
      assert.ok(![...room.wolves.values()].some((w) => w.alive), "qochgan bo'rilar xonadan olib tashlandi");
      assert.ok(!(lastSnap(emitted).wolves ?? []).some((x) => x.state === 'flee'), "snapshotda qochayotgan bo'ri qolmadi");
      // Keyingi tun sanog'ida bo'ri yo'q (yakun: tong epilogi + MATCH_END_DURATION, sanoq 2 s)
      room.advanceTimeForTest(MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC - WOLF_DAWN_GONE_MAX_SEC, 0.25);
      assert.equal(room.phase, 'countdown');
      assert.equal(room.wolves.size, 0);
    } finally {
      room.destroy();
    }
  });

  it("22. Tun statistikasi: bo'ri o'ldirish/zarar, o'tin, qayta yoqish, gulxanni yoqib turgan vaqt; yakunda nightSummary (MVP, mukofotlar), keyingi sanoqda null", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { timeLimit: 3 });
    try {
      const { p } = startSoloNight(room);
      p.spawnTime = -99;
      assert.deepEqual(room.getNightStatsForTest(), [
        {
          id: 'p1',
          name: 'Ovchi',
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
        },
      ]);
      assert.equal(room.getSurvivalState()!.nightSummary, null, "o'yin davomida natija yo'q");
      assert.equal(lastMatch(emitted).survival?.nightSummary, null);

      // 1) Bo'ri (150 hp): zarar aynan 150 — o'ldiruvchi o'qning ortiqchasi hisoblanmaydi
      const w = [...room.wolves.values()][0]!;
      w.hp = 150;
      shootWolfDead(room, p, w);
      assert.ok(systemChats(emitted).some((t) => t.includes("Ovchi vahshiy bo'rini o'ldirdi!")));
      room.wolves.clear();
      // 2) Asosiy gulxanga 2 ta o'tin
      const fires = room.getNightSnap()!.fires;
      const main = room.campfires.get(fires[0]!.id)!;
      main.fuelSec = 100;
      p.pos = groundAt(room, main.x + 1.2, main.z);
      p.vel = { x: 0, y: 0, z: 0 };
      p.wood = 2;
      assert.equal(room.onFeedFire('p1', { fireId: main.id }).ok, true);
      // 3) 2-gulxan o'chadi va 1 o'tin bilan qayta yoqiladi
      const f2 = room.campfires.get(fires[1]!.id)!;
      f2.fuelSec = 0.05;
      room.advanceTimeForTest(0.4, 1 / 30);
      assert.equal(f2.lit, false);
      p.pos = groundAt(room, f2.x + 1.2, f2.z);
      p.vel = { x: 0, y: 0, z: 0 };
      p.wood = 1;
      assert.equal(room.onFeedFire('p1', { fireId: f2.id }).ok, true);
      const st = room.getNightStatsForTest()[0]!;
      assert.equal(st.wolfKills, 1);
      assert.equal(st.alphaKills, 0);
      assert.equal(st.wolfDamage, 150);
      assert.equal(st.logsFed, 3);
      assert.equal(st.relights, 1);
      assert.equal(st.fireKeepSec, 0, "o'tin hali yonmadi");
      // 4) 3 s o'tadi: 2-gulxanda p1 ning o'tini yonadi (asosiy gulxanda avval egasiz 100 s yonadi)
      room.advanceTimeForTest(3, 1 / 30);
      const kept = room.getNightStatsForTest()[0]!.fireKeepSec;
      assert.ok(Math.abs(kept - 3) < 0.05, `gulxanni yoqib turgan vaqt ~3 s (${kept})`);

      // Tong otadi
      room.setSurvivalConfigForTest({ roundDurationSec: 2 });
      surviveFor(room, p, 3);
      assert.equal(room.phase, 'ended');
      const sum = room.getSurvivalState()!.nightSummary!;
      assert.ok(sum, 'yakunda nightSummary');
      assert.equal(sum.dawn, true);
      assert.equal(sum.difficulty, 'normal');
      assert.equal(sum.stats.length, 1);
      const s = sum.stats[0]!;
      assert.equal(s.survived, true);
      // Tong otguncha 2-gulxan yonishda davom etdi; natijada butun soniya
      assert.equal(s.fireKeepSec, Math.round(room.getNightStatsForTest()[0]!.fireKeepSec), 'natijada butun soniya');
      assert.ok(s.fireKeepSec >= 3 && s.fireKeepSec < 30, `${s.fireKeepSec}`);
      const score = nightPlayerScore(s);
      assert.equal(score, 1 * 3 + 3 * 2 + 4 + 1, 'bo‘ri 3 + o‘tin 6 + tong 4 + zarar 1 (qayta yoqish ball bermaydi, < 30 s)');
      const byKind = new Map(sum.awards.map((a) => [a.kind, a] as const));
      assert.deepEqual(
        [...byKind.keys()].sort(),
        ['firekeeper', 'hunter', 'mvp', 'woodsman'],
      );
      assert.equal(byKind.get('mvp')!.playerId, 'p1');
      assert.equal(byKind.get('mvp')!.value, score);
      assert.equal(byKind.get('mvp')!.titleUz, NIGHT_AWARD_TITLES_UZ.mvp);
      assert.equal(byKind.get('hunter')!.value, 1);
      assert.equal(byKind.get('woodsman')!.value, 3);
      assert.equal(byKind.get('firekeeper')!.value, s.fireKeepSec, "olov qo'riqchisi — yoqib turgan soniyalar");
      const m = lastMatch(emitted);
      assert.equal(m.phase, 'ended');
      assert.deepEqual(m.survival?.nightSummary, sum, 'MatchState.survival.nightSummary');
      assert.ok(systemChats(emitted).some((t) => t.includes(`🏆 ${NIGHT_AWARD_TITLES_UZ.mvp}: Ovchi (${score} ball)`)), 'MVP chatda');

      // Keyingi sanoq (tong epilogi + natija ekranidan keyin): natija va statistika tozalanadi
      room.advanceTimeForTest(MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC + 0.5, 0.25);
      assert.equal(room.phase, 'countdown');
      assert.equal(room.getSurvivalState()!.nightSummary, null);
      assert.equal(lastMatch(emitted).survival?.nightSummary, null);
      assert.equal(room.getNightStatsForTest().length, 0);
    } finally {
      room.destroy();
    }
  });

  it("23. computeNightSummary: ball tartibi, teng qiymat (barqaror tartib), nol qiymat — mukofot yo'q", () => {
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
    const brief = (sum: ReturnType<typeof computeNightSummary>) => sum.awards.map((a) => [a.kind, a.playerId, a.value]);
    // Bo'sh ro'yxat
    assert.deepEqual(computeNightSummary([], 'easy', true), {
      difficulty: 'easy',
      dawn: true,
      stats: [],
      awards: [],
      // Faktlarsiz — yulduzlar berilmaydi (stage24: yulduz mantig'i)
      stars: [
        { kind: 'all_alive', earned: false },
        { kind: 'fire_kept', earned: false },
        { kind: 'alpha_slain', earned: false },
      ],
    });
    // Hamma nol — mukofot yo'q, tartib saqlanadi
    const zeros = computeNightSummary([mk('a'), mk('b'), mk('c')], 'normal', false);
    assert.deepEqual(zeros.awards, []);
    assert.deepEqual(zeros.stats.map((x) => x.id), ['a', 'b', 'c']);
    assert.equal(zeros.dawn, false);
    // Faqat tongga yetish: MVP (4 ball), boshqa mukofot yo'q
    const surv = computeNightSummary([mk('a'), mk('b', { survived: true })], 'hard', true);
    assert.deepEqual(brief(surv), [['mvp', 'b', 4]]);
    assert.deepEqual(surv.stats.map((x) => x.id), ['b', 'a']);
    assert.equal(surv.difficulty, 'hard');
    // Teng ball: kiritish tartibi hal qiladi
    const tie = computeNightSummary([mk('a', { logsFed: 3 }), mk('b', { fireKeepSec: 180 })], 'normal', true);
    assert.deepEqual(brief(tie), [['mvp', 'a', 6], ['woodsman', 'a', 3], ['firekeeper', 'b', 180]]);
    const tie2 = computeNightSummary([mk('b', { fireKeepSec: 180 }), mk('a', { logsFed: 3 })], 'normal', true);
    assert.equal(tie2.awards[0]!.playerId, 'b', 'teng ballda birinchi kelgan');
    // Teng bo'ri soni: balli yuqorisi (saralangan tartibda birinchi) ovchi
    const hunt = computeNightSummary([mk('a', { wolfKills: 2 }), mk('b', { wolfKills: 2, logsFed: 1 })], 'normal', true);
    assert.deepEqual(brief(hunt), [['mvp', 'b', 8], ['hunter', 'b', 2], ['woodsman', 'b', 1]]);
    // Boshliq +3, zarar /100 pastga yaxlitlanadi
    const alpha = computeNightSummary([mk('a', { wolfKills: 1, alphaKills: 1, wolfDamage: 399 })], 'normal', true);
    assert.deepEqual(brief(alpha), [['mvp', 'a', 3 + 3 + 3], ['hunter', 'a', 1]]);
    // Har mukofot boshqa o'yinchiga
    const mix = computeNightSummary(
      [mk('h', { wolfKills: 4 }), mk('w', { logsFed: 5 }), mk('f', { fireKeepSec: 270, relights: 3, survived: true })],
      'normal',
      true,
    );
    assert.deepEqual(mix.stats.map((x) => x.id), ['f', 'h', 'w']);
    assert.deepEqual(brief(mix), [['mvp', 'f', 13], ['hunter', 'h', 4], ['woodsman', 'w', 5], ['firekeeper', 'f', 270]]);
    for (const a of mix.awards) assert.equal(a.titleUz, NIGHT_AWARD_TITLES_UZ[a.kind]);
    assert.equal(mix.awards.find((a) => a.kind === 'hunter')!.playerName, 'H');
  });
});
