import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';
import { packGearState, unpackGearState, type Snapshot } from '../protocol';

function createFakeIo(): { io: Server; emitted: { event: string; payload: unknown }[] } {
  const emitted: { event: string; payload: unknown }[] = [];
  const io = {
    to() {
      const emitFn = (event: string, payload: unknown) => {
        emitted.push({ event, payload });
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

describe('Bosqich 11 — modelda ko‘rinadigan jihozlar (kaska, nimcha, granata, aptechka)', () => {
  it('1. packGearState / unpackGearState 6 bitda to‘liq aylanadi va chegaralaydi', () => {
    for (const helmet of [false, true]) {
      for (const armor of [false, true]) {
        for (let grenades = 0; grenades <= 3; grenades++) {
          for (let medkits = 0; medkits <= 3; medkits++) {
            const packed = packGearState({ helmet, armor, grenades, medkits });
            assert.ok(packed >= 0 && packed < 64, 'bit maydoni 6 bitga sig‘adi');
            assert.deepEqual(unpackGearState(packed), { helmet, armor, grenades, medkits });
          }
        }
      }
    }
    assert.deepEqual(unpackGearState(undefined), { helmet: false, armor: false, grenades: 0, medkits: 0 });
    assert.equal(unpackGearState(packGearState({ helmet: false, armor: false, grenades: 9, medkits: -2 })).grenades, 3);
    assert.equal(unpackGearState(packGearState({ helmet: false, armor: false, grenades: 9, medkits: -2 })).medkits, 0);
  });

  it('2. Server snapshotida har o‘yinchining jihoz holati (zirh, kaska, granata, aptechka) keladi', () => {
    const { io, emitted } = createFakeIo();
    const room = new Room(
      {
        name: 'Gear Snap',
        mode: 'forest_survival',
        mapId: 'forest_square',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 3,
        scoreLimit: 1,
        publicLayoutSeed: 6501,
        countdownSec: 2,
      },
      io,
      () => {},
    );
    try {
      room.addHuman(createFakeSocket('p1'), 'A');
      room.addHuman(createFakeSocket('p2'), 'B');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      const p1 = room.players.get('p1')!;
      p1.helmet = 100;
      p1.armor = 40;
      p1.grenades = 2;
      // Aptechkalar loot inventaridan o'qiladi
      room.loot.syncPlayerFromServerPlayer(p1.id, p1);
      const invBefore = room.loot.getMedkitCount('p1');
      assert.equal(invBefore, 0);

      emitted.length = 0;
      room.advanceTimeForTest(0.2, 1 / 30);
      const snaps = emitted.filter((e) => e.event === 'snap').map((e) => e.payload as Snapshot);
      assert.ok(snaps.length > 0, 'snap yuboriladi');
      const last = snaps[snaps.length - 1]!;
      const s1 = last.players.find((p) => p.id === 'p1')!;
      const s2 = last.players.find((p) => p.id === 'p2')!;
      assert.deepEqual(unpackGearState(s1.gear), { helmet: true, armor: true, grenades: 2, medkits: 0 });
      assert.deepEqual(unpackGearState(s2.gear), { helmet: false, armor: false, grenades: 0, medkits: 0 });
    } finally {
      room.destroy();
    }
  });
});
