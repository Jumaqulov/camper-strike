import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server } from 'socket.io';
import { sanitizeOpts } from '../../server/lobby';
import { Room } from '../../server/room';
import type { MapId } from '../world';

describe('Bosqich 12 — Dust Arena o‘yindan olib tashlandi', () => {
  it('1. Lobbi noma‘lum (o‘chirilgan dust_arena) xarita so‘rovini qabul qilmaydi, standart xarita forest_square', () => {
    // 'dust_arena' endi MapId emas — tarmoqdan kelgan eski/noto'g'ri qiymat sifatida tekshiriladi
    const removedMapId = 'dust_arena' as unknown as MapId;
    const ffa = sanitizeOpts({ name: 'x', mode: 'ffa', bots: 2, maxPlayers: 8, timeLimit: 10, scoreLimit: 25, mapId: removedMapId }, 'Host');
    assert.equal(ffa.mapId, 'forest_square');
    const tdm = sanitizeOpts({ name: 'x', mode: 'tdm', bots: 2, maxPlayers: 8, timeLimit: 10, scoreLimit: 50 }, 'Host');
    assert.equal(tdm.mapId, 'forest_square', 'xarita berilmasa ham forest_square');
    const sample = sanitizeOpts({ name: 'x', mode: 'ffa', bots: 2, maxPlayers: 8, timeLimit: 10, scoreLimit: 25, mapId: 'forest_sample' }, 'Host');
    assert.equal(sample.mapId, 'forest_sample', 'boshqa o‘rmon xaritalari saqlanadi');
  });

  it('2. Xarita ko‘rsatilmagan klassik xona forest_square dunyosini yaratadi', () => {
    const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) } as unknown as Server;
    const room = new Room(
      { name: 'Classic', mode: 'tdm', bots: 2, maxPlayers: 8, timeLimit: 10, scoreLimit: 50, publicLayoutSeed: 6501 },
      io,
      () => {},
    );
    try {
      assert.equal(room.world.mapId, 'forest_square');
      assert.equal(room.botCount(), 2);
    } finally {
      room.destroy();
    }
  });
});
