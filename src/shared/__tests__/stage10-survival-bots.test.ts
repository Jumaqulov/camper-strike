import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';
import { MAX_HP } from '../constants';
import type { MatchState } from '../protocol';

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

  it('2. Botlar konteynerlarni ochib qurol yig‘adi (loot AI) va hech biri zonadan tashqarida o‘lmaydi', () => {
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

      // 120 soniyagacha real tick (30 Hz); kamida bitta bot qurollanishi bilan to'xtaymiz
      const bots = [...room.players.values()].filter((p) => p.isBot);
      for (let i = 0; i < 120; i++) {
        p1.pos = { x: 0, y: p1.pos.y, z: 0 };
        p1.hp = MAX_HP;
        room.advanceTimeForTest(1, 1 / 30);
        if (room.phase !== 'playing') break;
        if (i >= 20 && bots.some((b) => b.weapon !== null)) break;
      }
      const opened = room.loot.getPublicLootSnapshot().containers.filter((c) => c.opened).length;
      assert.ok(opened >= 1, `botlar kamida bitta konteyner ochishi kerak (opened=${opened})`);
      const armed = bots.filter((b) => b.weapon !== null);
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
  });

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
});
