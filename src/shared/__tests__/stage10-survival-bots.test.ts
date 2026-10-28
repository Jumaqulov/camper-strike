import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';
import { MAX_HP } from '../constants';
import type { Vec3 } from '../math';
import type { MatchState } from '../protocol';
import type { WeaponId } from '../weapons';
import { sampleTerrainHeight } from '../world';

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

function makeSurvivalRoom(io: Server, bots: number): Room {
  return new Room(
    {
      name: 'Bots Survival',
      mode: 'forest_survival',
      mapId: 'forest_square',
      bots,
      maxPlayers: 8,
      timeLimit: 3,
      scoreLimit: 1,
      publicLayoutSeed: 6501,
      countdownSec: 2,
    },
    io,
    () => {},
  );
}

/**
 * Mulberry32 — kichik urug'langan PRNG. Bot AI (bot.ts) va xona (room.ts: secretLootSeed, spawn
 * tanlovi, boshlang'ich yaw) `Math.random` dan foydalanadi; loot AI testini takrorlanuvchan qilish
 * uchun shu generator vaqtincha `Math.random` o'rniga qo'yiladi.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministik RNG bilan ishga tushirilgan test tanasi; `Math.random` doim qayta tiklanadi. */
function withSeededRandom<T>(seed: number, fn: () => T): T {
  const realRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = realRandom;
  }
}

describe('Bosqich 10 — Forest Survival botlari (loot AI)', () => {
  it('1. Faqat botlar raund boshlamaydi; tayyor odam kelgach botlar bilan birga ishtirokchi bo‘ladi', () => {
    const { io } = createFakeIo();
    const room = makeSurvivalRoom(io, 3);
    try {
      assert.equal(room.botCount(), 3);
      // Odam yo'q — 3 ta bot "tayyor" bo'lsa ham kutish rejimida qoladi
      room.advanceTimeForTest(6, 0.25);
      assert.equal(room.phase, 'waiting', 'botlar o‘zaro raund boshlamaydi');

      const s1 = createFakeSocket('p1');
      room.addHuman(s1.socket, 'Solo');
      // Odam ulangan, lekin hali tayyor emas
      room.advanceTimeForTest(3, 0.25);
      assert.equal(room.phase, 'waiting', 'tayyor bo‘lmagan odam bilan ham boshlanmaydi');

      room.onReady('p1', { world: room.worldMeta() });
      assert.equal(room.phase, 'countdown', 'bitta tayyor odam + botlar → sanoq boshlanadi');
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      const surv = room.getSurvivalState()!;
      assert.equal(surv.totalContenders, 4, 'odam + 3 bot ishtirokchi');
      assert.equal(surv.aliveCount, 4);
      const botIds = [...room.players.values()].filter((p) => p.isBot).map((p) => p.id);
      for (const id of botIds) {
        assert.ok(surv.contenderIds.includes(id), `bot ${id} ishtirokchi bo‘lishi kerak`);
        assert.ok(surv.players.some((pl) => pl.id === id), 'bot holati snapshotda ko‘rinadi');
      }
      for (const b of room.players.values()) {
        if (b.isBot) {
          assert.equal(b.alive, true);
          assert.equal(b.weapon, null, 'bot qurolsiz spawn bo‘ladi');
          assert.ok(room.loot.getPlayerInventorySnap(b.id), 'botning loot inventari bor');
        }
      }
    } finally {
      room.destroy();
    }
  });

  it('2. Botlar konteynerlarni ochib qurol yig‘adi (loot AI) va hech biri zonadan tashqarida o‘lmaydi', () => withSeededRandom(0x5eed_1065, () => {
    // Urug'langan RNG: secretLootSeed, bot spawn/yo'l tanlovi va loot "o'ylash" taymerlari takrorlanuvchan
    const { io, emitted } = createFakeIo();
    const room = makeSurvivalRoom(io, 3);
    try {
      const s1 = createFakeSocket('p1');
      room.addHuman(s1.socket, 'Solo');
      room.onReady('p1', { world: room.worldMeta() });
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      const p1 = room.players.get('p1')!;
      // Odamni xarita markazida (zona ichida) ushlab turamiz, u botlardan uzoqda — jang bo'lmasin
      p1.pos = { x: 0, y: p1.pos.y, z: 0 };

      const openedBefore = room.loot.getPublicLootSnapshot().containers.filter((c) => c.opened).length;
      assert.equal(openedBefore, 0);

      // 180 soniyagacha real tick (30 Hz); kamida bitta bot qurollanishi bilan to'xtaymiz
      const bots = [...room.players.values()].filter((p) => p.isBot);
      for (let i = 0; i < 180; i++) {
        p1.pos = { x: 0, y: p1.pos.y, z: 0 };
        p1.hp = MAX_HP;
        room.advanceTimeForTest(1, 1 / 30);
        if (room.phase !== 'playing') break;
        // Pichoq har doim bor — faqat o'qotar qurol olgan bot "qurollangan" hisoblanadi
        if (i >= 20 && bots.some((b) => b.weapon !== null && b.weapon !== 'knife')) break;
      }
      const opened = room.loot.getPublicLootSnapshot().containers.filter((c) => c.opened).length;
      assert.ok(opened >= 1, `botlar kamida bitta konteyner ochishi kerak (opened=${opened})`);
      const armed = bots.filter((b) => b.weapon !== null && b.weapon !== 'knife');
      assert.ok(
        armed.length >= 1,
        `kamida bitta bot qurol olishi kerak (armed=${armed.length}, weapons=${bots.map((b) => b.weapon).join(',')})`,
      );
      for (const b of armed) {
        assert.ok(room.loot.canPlayerUseWeapon(b.id, b.weapon), 'bot faqat o‘zi olgan qurolni ushlaydi');
        assert.ok(b.ammo[b.weapon!].mag > 0, 'olingan qurol o‘qli');
      }
      // Konteyner ochilishi klientlarga e'lon qilinadi
      assert.ok(emitted.some((e) => e.event === 'container:state'), 'container:state hodisasi yuboriladi');
    } finally {
      room.destroy();
    }
  }));

  it('3. Odam chiqib ketsa botlar raundni davom ettiradi; zonadan tashqarida qolgan odam o‘lsa bot g‘olib bo‘ladi', () => {
    const { io } = createFakeIo();
    const room = makeSurvivalRoom(io, 1);
    try {
      // Qisqa raund — zona 17 s ichida oxirgi aylanaga toraysin
      room.setSurvivalConfigForTest({ roundDurationSec: 20, countdownDurationSec: 2 });
      const s1 = createFakeSocket('p1');
      const s2 = createFakeSocket('p2');
      room.addHuman(s1.socket, 'Stayer');
      room.addHuman(s2.socket, 'Leaver');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      const p1 = room.players.get('p1')!;
      const bot = [...room.players.values()].find((p) => p.isBot)!;
      assert.ok(bot);
      assert.equal(room.getSurvivalState()!.aliveCount, 3);

      // Bir odam chiqib ketadi — raund odam + bot bilan davom etadi
      room.removePlayer('p2');
      assert.equal(room.phase, 'playing', 'odam chiqib ketgach ham raund davom etadi');
      const surv = room.getSurvivalState()!;
      assert.equal(surv.aliveCount, 2);
      assert.ok(!surv.aliveIds.includes('p2'));
      assert.ok(surv.aliveIds.includes(bot.id));

      // Qolgan odam zona markazidan uzoqda turadi, bot esa zona markazida — zona odamni yo'q qiladi
      for (let i = 0; i < 25 && room.phase === 'playing'; i++) {
        const z = room.getZoneSnap();
        if (z) {
          bot.pos = { x: z.targetCx, y: bot.pos.y, z: z.targetCz };
          bot.hp = MAX_HP;
          const dirX = z.targetCx >= 0 ? -1 : 1;
          p1.pos = { x: z.targetCx + dirX * 60, y: p1.pos.y, z: z.targetCz };
        }
        room.advanceTimeForTest(1, 1 / 30);
      }
      assert.equal(p1.alive, false, 'zonadan tashqaridagi odam halok bo‘lishi kerak');
      assert.equal(bot.alive, true, 'zona ichidagi bot tirik');
      assert.equal(room.phase, 'ended');
      const after = room.getSurvivalState()!;
      assert.equal(after.winnerId, bot.id, 'g‘olib — bot');
      assert.equal(after.winReason, 'last_standing');
    } finally {
      room.destroy();
    }
  });

  it('5. minHumans: shuncha odam tayyor bo‘lmaguncha botlar bilan ham raund boshlanmaydi', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Min Humans',
        mode: 'forest_survival',
        mapId: 'forest_square',
        bots: 3,
        maxPlayers: 8,
        timeLimit: 3,
        scoreLimit: 1,
        publicLayoutSeed: 6501,
        countdownSec: 2,
        minHumans: 2,
      },
      io,
      () => {},
    );
    try {
      assert.equal(room.info().minHumans, 2);
      const s1 = createFakeSocket('p1');
      const s2 = createFakeSocket('p2');
      room.addHuman(s1.socket, 'One');
      room.addHuman(s2.socket, 'Two');
      room.onReady('p1', { world: room.worldMeta() });
      room.advanceTimeForTest(3, 0.25);
      assert.equal(room.phase, 'waiting', 'bitta odam + 3 bot — 2 odam talab qilinganda kutiladi');
      const surv = room.getSurvivalState()!;
      assert.equal(surv.readyHumans, 1);
      assert.equal(surv.minHumans, 2);
      assert.equal(surv.readyCount, 0, 'odamlar yetarli bo‘lmaguncha samarali tayyorlar soni 0');
      assert.match(surv.statusTextUz, /Odamlar kutilmoqda \(1\/2\)/);

      room.onReady('p2', { world: room.worldMeta() });
      assert.equal(room.phase, 'countdown', 'ikkinchi odam tayyor — sanoq boshlanadi');
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      assert.equal(room.getSurvivalState()!.totalContenders, 5, '2 odam + 3 bot');

      // Sanoq paytida odam chiqib ketsa — kutishga qaytadi
    } finally {
      room.destroy();
    }
  });

  it('4. Match snapshotida botlar tirik ishtirokchilar qatorida sanaladi', () => {
    const { io, emitted } = createFakeIo();
    const room = makeSurvivalRoom(io, 2);
    try {
      const s1 = createFakeSocket('p1');
      room.addHuman(s1.socket, 'Solo');
      room.onReady('p1', { world: room.worldMeta() });
      room.advanceTimeForTest(2.5, 0.25);
      const matches = emitted.filter((e) => e.event === 'match').map((e) => e.payload as MatchState);
      const last = matches[matches.length - 1]!;
      assert.equal(last.phase, 'playing');
      assert.equal(last.totalContenders, 3);
      assert.equal(last.aliveCount, 3);
      assert.equal(last.survival!.players.filter((p) => p.id.startsWith('bot-')).length, 2);
    } finally {
      room.destroy();
    }
  });

  it("6. Loot rejimi: botdan tushgan qurol haqiqiy o'q soni bilan; o'qi tugagan bot yerdagi xuddi shu qurolni o'q uchun oladi", () => withSeededRandom(0x10ad_0065, () => {
    const { io } = createFakeIo();
    const room = new Room(
      { name: 'Bot Ammo', mode: 'ffa', bots: 1, maxPlayers: 4, timeLimit: 10, scoreLimit: 25, mapId: 'forest_square', publicLayoutSeed: 6501, lootPreview: true },
      io,
      () => {},
    );
    try {
      const s1 = createFakeSocket('p1');
      room.addHuman(s1.socket, 'Kuzatuvchi');
      room.onReady('p1', { world: room.worldMeta() });
      room.advanceTimeForTest(0.2, 1 / 30);
      const p1 = room.players.get('p1')!;
      const bot = [...room.players.values()].find((p) => p.isBot)!;
      const internal = room.loot as unknown as { inventories: Map<string, { ownedWeapons: Set<WeaponId> }> };
      // Ochiq joy: nav tuguni va 3 m yonidagi to'siqsiz nuqta
      let spot: { a: Vec3; b: Vec3 } | null = null;
      for (const i of room.nav.roamList) {
        const a = room.nav.center(i);
        const b = { x: a.x + 3, y: sampleTerrainHeight(room.world.terrain, a.x + 3, a.z), z: a.z };
        if (Math.abs(b.y - a.y) < 0.3 && room.nav.segmentClear(a, b) && Math.hypot(a.x - p1.pos.x, a.z - p1.pos.z) > 60) {
          spot = { a, b };
          break;
        }
      }
      assert.ok(spot, 'ochiq joy topildi');
      const keepAway = () => {
        p1.pos = { x: spot!.a.x + 90, y: sampleTerrainHeight(room.world.terrain, spot!.a.x + 90, spot!.a.z), z: spot!.a.z };
        p1.vel = { x: 0, y: 0, z: 0 };
        p1.hp = MAX_HP;
      };
      keepAway();

      // 1) Bot avtomat bilan 5 marta otadi, keyin o'ladi — yerdagi qurolda joriy (25/60) o'q
      internal.inventories.get(bot.id)!.ownedWeapons.add('rifle');
      bot.weapon = 'rifle';
      bot.ammo.rifle = { mag: 30, reserve: 60 };
      bot.reloadWeapon = null;
      room.loot.syncPlayerFromServerPlayer(bot.id, bot);
      for (let i = 0; i < 5; i++) {
        bot.lastShot = -99;
        assert.equal(room.botFire(bot, 0), true);
      }
      assert.equal(bot.ammo.rifle.mag, 25);
      bot.pos = { ...spot!.a };
      (room as unknown as { kill(v: unknown, k: unknown, w: string, h: boolean): void }).kill(bot, p1, 'rifle', false);
      const drop = room.loot.getPublicLootSnapshot().groundItems.find((g) => g.weaponId === 'rifle');
      assert.ok(drop, 'botning quroli yerga tushdi');
      assert.equal(drop!.initialMag, 25, "tushgan qurolda botning haqiqiy magazini (eskirgan 30 emas)");
      assert.equal(drop!.initialReserve, 60);

      // 2) Bot qayta tug'iladi: avtomati bor, lekin o'qi tugagan — yonidagi (3 m) avtomatni o'q uchun oladi
      room.advanceTimeForTest(4, 1 / 30);
      keepAway();
      assert.ok(bot.alive, 'bot qayta tug‘ildi');
      room.loot.initPlayer(bot.id, bot.spawnId);
      internal.inventories.get(bot.id)!.ownedWeapons.add('rifle');
      bot.weapon = 'rifle';
      bot.ammo.rifle = { mag: 0, reserve: 0 };
      bot.reloadWeapon = null;
      room.loot.syncPlayerFromServerPlayer(bot.id, bot);
      bot.pos = { ...spot!.b };
      bot.vel = { x: 0, y: 0, z: 0 };
      // Qayta tug'ilish kutilganda tanlangan loot maqsadi tozalansin (yangi holatdan qaror qilsin)
      bot.brain!.onSpawn();
      for (let i = 0; i < 80 && bot.ammo.rifle.mag + bot.ammo.rifle.reserve === 0; i++) {
        room.advanceTimeForTest(0.1, 1 / 30);
        keepAway();
      }
      assert.ok(bot.ammo.rifle.mag + bot.ammo.rifle.reserve > 0, "o'qsiz bot yerdagi avtomatdan o'q oldi");
      assert.ok(!room.loot.getPublicLootSnapshot().groundItems.some((g) => g.id === drop!.id), 'yerdagi qurol olindi');
    } finally {
      room.destroy();
    }
  }));
});
