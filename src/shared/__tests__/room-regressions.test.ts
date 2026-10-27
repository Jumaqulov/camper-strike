import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';

function createFakeIo(): Server {
  const emitFn = () => {};
  return {
    to() {
      return { emit: emitFn, volatile: { emit: emitFn } };
    },
  } as unknown as Server;
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

function createLootFfaRoom(): Room {
  return new Room(
    {
      name: 'Audit Fix Room',
      mode: 'ffa',
      bots: 0,
      maxPlayers: 8,
      timeLimit: 10,
      scoreLimit: 25,
      mapId: 'forest_square',
      publicLayoutSeed: 6501,
      lootPreview: true,
    },
    createFakeIo(),
    () => {},
  );
}

describe('Room regressiya testlari (sobiq repo-audit tuzatishlari)', () => {
  it('FFA + lootPreview: restartMatch konteynerlarni yangi raund uchun qayta to\'ldiradi', () => {
    const room = createLootFfaRoom();
    try {
      room.addHuman(createFakeSocket('p1'), 'PlayerOne');
      room.onReady('p1', { world: room.worldMeta() });

      const roundBefore = room.loot.getRoundId();
      const containerId = room.loot.getAuthoritativeContainerIds()[0];
      assert.ok(containerId, 'kamida bitta konteyner bo\'lishi kerak');

      // Konteynerni "bo'shatilgan" holatga keltiramiz (barcha buyumlar olingan)
      const raw = room.loot.getRawContainerForServerTest(containerId)!;
      const itemCountBefore = raw.items.size;
      assert.ok(itemCountBefore > 0, 'birinchi konteynerda buyum bo\'lishi kerak');
      for (const itemId of raw.items.keys()) raw.takenItemIds.add(itemId);
      raw.items.clear();
      raw.opened = true;

      const internal = room as unknown as { endMatch: () => void; restartMatch: () => void };
      internal.endMatch();
      internal.restartMatch();

      assert.equal(room.loot.getRoundId(), roundBefore + 1, 'loot roundId oshishi kerak');
      const fresh = room.loot.getRawContainerForServerTest(containerId)!;
      assert.ok(fresh.items.size > 0, 'yangi raundda konteyner qayta to\'lishi kerak');
      assert.equal(fresh.takenItemIds.size, 0);
      assert.equal(fresh.opened, false);

      const p1 = room.players.get('p1')!;
      assert.equal(p1.alive, true);
      assert.equal(p1.weapon, null, 'loot rejimida qayta tug\'ilish qurolsiz bo\'ladi');
    } finally {
      room.destroy();
    }
  });

  it('tick() qisqa yetib olish tick\'larida vaqtni ikki marta sanamaydi', () => {
    const room = createLootFfaRoom();
    try {
      const internal = room as unknown as {
        lastTick: number;
        manualTimeSec: number | null;
        matchEndsAt: number;
        tick: () => void;
        updateGrenades: (dt: number, t: number) => void;
      };
      const seenDt: number[] = [];
      internal.updateGrenades = (dt: number) => {
        seenDt.push(dt);
      };
      internal.manualTimeSec = 1000;
      internal.matchEndsAt = 1000 + 600;

      // 4 ms oraliqdagi yetib olish tick'i: dt haqiqiy 0.004 s bo'lishi kerak, 1/30 s emas
      internal.lastTick = 1000 - 0.004;
      internal.tick();
      // Uzoq to'xtashdan keyin dt 0.1 s bilan cheklanadi
      internal.manualTimeSec = 1001;
      internal.tick();

      assert.equal(seenDt.length, 2);
      assert.ok(Math.abs(seenDt[0] - 0.004) < 1e-9, `kutilgan 0.004, olingan ${seenDt[0]}`);
      assert.equal(seenDt[1], 0.1);
    } finally {
      room.destroy();
    }
  });
});
