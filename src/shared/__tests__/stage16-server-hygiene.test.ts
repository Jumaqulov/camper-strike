import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';
import { MinHeap } from '../../server/minHeap';
import type { Snapshot } from '../protocol';
import { sampleTerrainHeight } from '../world';

// ---------------- Soxta Socket.IO ----------------

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

function makeRoom(io: Server, mode: 'ffa' | 'tdm', lootPreview = false): Room {
  return new Room(
    {
      name: 'Stage16 hygiene',
      mode,
      bots: 0,
      maxPlayers: 8,
      timeLimit: 10,
      scoreLimit: 25,
      mapId: 'forest_square',
      publicLayoutSeed: 6501,
      lootPreview,
    },
    io,
    () => {},
  );
}

/** Dunyo muzlatilgan (frozen) — spawn ro'yxatini almashtirish uchun sayoz nusxa qo'yamiz. */
function overrideSpawnPoints(room: Room, spawnPoints: Room['world']['spawnPoints']): void {
  (room as unknown as { world: Room['world'] }).world = { ...room.world, spawnPoints };
}

function countEvents(emitted: EmittedRoomEvent[], event: string): number {
  return emitted.filter((e) => e.event === event).length;
}

describe('Bosqich 16 — server gigiyenasi', () => {
  it('1. pickSpawn: TDM jamoasida spawn bo‘lmasa — barcha spawnlar; umuman bo‘lmasa — markaz + bitta warn', () => {
    const { io } = createFakeIo();
    const room = makeRoom(io, 'tdm');
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const redOnly = room.world.spawnPoints.filter((s) => s.team === 'red');
      assert.ok(redOnly.length > 0, 'forest_square da qizil spawnlar bor');
      overrideSpawnPoints(room, redOnly);

      room.addHuman(createFakeSocket('blue1'), 'Blue');
      const blue = room.players.get('blue1')!;
      blue.team = 'blue';
      room.onReady('blue1', { world: room.worldMeta() });
      assert.equal(blue.alive, true);
      assert.ok(
        redOnly.some((s) => Math.abs(s.x - blue.pos.x) < 1e-9 && Math.abs(s.z - blue.pos.z) < 1e-9),
        'jamoa spawnlari yo‘q — boshqa jamoaning spawnlaridan biri ishlatiladi',
      );
      assert.equal(warns.length, 0, 'spawnlar mavjud — ogohlantirish yo‘q');

      // Spawnlar umuman yo'q: chegaralar markazi, terrain balandligida
      overrideSpawnPoints(room, []);
      room.addHuman(createFakeSocket('p2'), 'Two');
      room.onReady('p2', { world: room.worldMeta() });
      const p2 = room.players.get('p2')!;
      const b = room.world.bounds;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      assert.equal(p2.alive, true);
      assert.ok(Math.abs(p2.pos.x - cx) < 1e-9 && Math.abs(p2.pos.z - cz) < 1e-9, 'markazda tug‘iladi');
      assert.ok(Math.abs(p2.pos.y - sampleTerrainHeight(room.world.terrain, cx, cz)) < 1e-9, 'terrain balandligida');
      assert.equal(warns.length, 1, 'birinchi fallback bitta warn beradi');

      // Ikkinchi marta — warn takrorlanmaydi
      room.addHuman(createFakeSocket('p3'), 'Three');
      room.onReady('p3', { world: room.worldMeta() });
      assert.equal(room.players.get('p3')!.alive, true);
      assert.equal(warns.length, 1, 'warn faqat bir marta');
    } finally {
      console.warn = origWarn;
      room.destroy();
    }
  });

  it('2. snap: vz haqiqiy tezlikdan olinadi (q3 bilan yaxlitlanadi)', () => {
    const { io, emitted } = createFakeIo();
    const room = makeRoom(io, 'ffa');
    try {
      room.addHuman(createFakeSocket('p1'), 'One');
      room.onReady('p1', { world: room.worldMeta() });
      const p1 = room.players.get('p1')!;
      p1.vel = { x: 0.12345, y: -1.5, z: 2.34567 };
      emitted.length = 0;
      (room as unknown as { sendSnapshot: (t: number) => void }).sendSnapshot(room.now());
      const snap = emitted.find((e) => e.event === 'snap')?.payload as Snapshot | undefined;
      assert.ok(snap, 'snap yuboriladi');
      const sp = snap.players.find((x) => x.id === 'p1')!;
      assert.equal(sp.vx, 0.123);
      assert.equal(sp.vy, -1.5);
      assert.equal(sp.vz, 2.346);
    } finally {
      room.destroy();
    }
  });

  it('3. Loot e‘lonlari: konteyner ochish/olish — faqat container:state; yerdan olish — loot:snapshot', () => {
    const { io, emitted } = createFakeIo();
    const room = makeRoom(io, 'ffa', true);
    try {
      room.addHuman(createFakeSocket('p1'), 'Explorer');
      room.onReady('p1', { world: room.worldMeta() });
      const p1 = room.players.get('p1')!;
      const bld = room.world.stage04aLayout?.buildings.find((b) => b.id === 'poi:poi_ranger_house:bld:0')!;
      assert.ok(bld);
      const containerId = 'poi:poi_ranger_house:cnt_0:wooden_loot_crate_01';
      const cnt = room.loot.getPublicContainerState(containerId)!;
      p1.pos = { x: cnt.position.x - 1.0, y: bld.floorY, z: cnt.position.z - 0.5 };

      // Ochish: bitta container:state, loot:snapshot yo'q
      emitted.length = 0;
      const open = room.onContainerOpen('p1', {
        requestId: 'open_1',
        containerId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(open.ok, true);
      assert.equal(countEvents(emitted, 'container:state'), 1);
      assert.equal(countEvents(emitted, 'loot:snapshot'), 0, 'ochish yer buyumlarini o‘zgartirmaydi');

      // Konteynerdan qurol olish: faqat container:state
      const weaponItem = open.container!.items.find((i) => i.kind === 'weapon');
      assert.ok(weaponItem, 'konteynerda qurol bor');
      emitted.length = 0;
      const pick = room.onLootPickup('p1', {
        requestId: 'pick_1',
        containerId,
        itemId: weaponItem.id,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(pick.ok, true, pick.message ?? '');
      assert.ok(pick.container);
      assert.equal(countEvents(emitted, 'container:state'), 1);
      assert.equal(countEvents(emitted, 'loot:snapshot'), 0, 'konteynerdan olish yer buyumlarini o‘zgartirmaydi');
      assert.ok(p1.weapon, 'qurol qo‘lga olinadi');

      // Qurol yerga tushadi (o'lim yo'lidagi kabi), so'ng yerdan olinadi: loot:snapshot shart
      const dropped = room.loot.dropWeaponOnDeath(p1.id, p1.weapon, p1.pos, p1.yaw);
      assert.ok(dropped, 'qurol yerga tushadi');
      room.loot.applyInventoryToServerPlayer(p1.id, p1);
      emitted.length = 0;
      const ground = room.onLootPickup('p1', {
        requestId: 'pick_ground_1',
        containerId: null,
        itemId: dropped.id,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(ground.ok, true, ground.message ?? '');
      assert.equal(ground.container, undefined);
      assert.equal(countEvents(emitted, 'loot:snapshot'), 1, 'yerdan olish to‘liq snapshot bilan e‘lon qilinadi');
      assert.equal(countEvents(emitted, 'container:state'), 0);
      assert.equal(room.loot.getPublicLootSnapshot().groundItems.length, 0);
    } finally {
      room.destroy();
    }
  });

  it('4. Rad etish ack shakli o‘zgarmagan (PLAYER_NOT_FOUND maydonlari)', () => {
    const { io } = createFakeIo();
    const room = makeRoom(io, 'ffa', true);
    try {
      const open = room.onContainerOpen('ghost', { requestId: 'r1', containerId: 'c1' });
      assert.deepEqual(Object.keys(open).sort(), ['code', 'containerId', 'message', 'ok', 'requestId']);
      assert.equal(open.requestId, 'r1');
      assert.equal(open.containerId, 'c1');
      assert.equal(open.code, 'PLAYER_NOT_FOUND');

      const pick = room.onLootPickup('ghost', { requestId: 'r2', itemId: 'i1' });
      assert.deepEqual(Object.keys(pick).sort(), ['code', 'itemId', 'message', 'ok', 'requestId']);
      assert.equal(pick.itemId, 'i1');

      const equip = room.onEquipWeapon('ghost', { requestId: 'r3', weaponId: 'rifle' });
      assert.deepEqual(Object.keys(equip).sort(), ['code', 'equippedWeapon', 'message', 'ok', 'requestId']);
      assert.equal(equip.equippedWeapon, null);

      const med = room.onUseMedkit('ghost', 42);
      assert.deepEqual(Object.keys(med).sort(), ['code', 'message', 'ok', 'requestId']);
      assert.equal(med.requestId, '', 'satr bo‘lmagan so‘rov — bo‘sh requestId');
    } finally {
      room.destroy();
    }
  });

  it('5. MinHeap: umumiy uyum A* uchun o‘sish tartibida qaytaradi', () => {
    const heap = new MinHeap();
    const scores = [5, 1, 4, 1, 3, 9, 2, 6];
    scores.forEach((s, i) => heap.push(i, s));
    assert.equal(heap.size, scores.length);
    const out: number[] = [];
    while (heap.size) out.push(scores[heap.pop()]!);
    assert.deepEqual(out, [...scores].sort((a, b) => a - b));
  });
});
