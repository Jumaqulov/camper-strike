import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { getNav } from '../../server/navgraph';
import { Room } from '../../server/room';
import { buildDustArena, MAP } from '../map';
import { applyMovement, type Body } from '../physics';
import {
  adaptDustArenaToWorld,
  compilePrefabPlacement,
  computeGameplayHash,
  createWorldDefinition,
  CURRENT_WORLD_VERSION,
  DEFAULT_PUBLIC_LAYOUT_SEED,
  DEFAULT_WORLD,
  extractWorldMeta,
  getChunkCoord,
  validateWorldCompatibility,
  type LocalBoxPart,
  type MapId,
  type PrefabPlacement,
} from '../world';

function createFakeIo(): { io: Server; emitted: { room: string; event: string; payload: unknown }[] } {
  const emitted: { room: string; event: string; payload: unknown }[] = [];
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emitted.push({ room, event, payload });
        },
      };
    },
  } as unknown as Server;
  return { io, emitted };
}

function createFakeSocket(id: string): {
  socket: Socket;
  events: { event: string; payload: unknown }[];
  joinedRooms: Set<string>;
} {
  const events: { event: string; payload: unknown }[] = [];
  const joinedRooms = new Set<string>();
  const socket = {
    id,
    join(roomId: string) {
      joinedRooms.add(roomId);
    },
    leave(roomId: string) {
      joinedRooms.delete(roomId);
    },
    emit(event: string, payload: unknown) {
      events.push({ event, payload });
    },
    to() {
      return {
        emit(event: string, payload: unknown) {
          events.push({ event, payload });
        },
      };
    },
  } as unknown as Socket;
  return { socket, events, joinedRooms };
}

describe('Bosqich 02A — WorldDefinition va deterministik dunyo arxitekturasi', () => {
  it('buildDustArena() adapteri 100x70 m arena va barcha collider/spawnlarni buzmasdan WorldDefinition ga moslashtiradi', () => {
    const legacy = buildDustArena(DEFAULT_PUBLIC_LAYOUT_SEED);
    const world = adaptDustArenaToWorld(legacy, {
      publicLayoutSeed: DEFAULT_PUBLIC_LAYOUT_SEED,
      worldVersion: CURRENT_WORLD_VERSION,
    });

    assert.equal(world.mapId, 'dust_arena');
    assert.equal(world.worldVersion, CURRENT_WORLD_VERSION);
    assert.equal(world.publicLayoutSeed, DEFAULT_PUBLIC_LAYOUT_SEED);
    assert.equal(world.bounds.maxX - world.bounds.minX, 100);
    assert.equal(world.bounds.maxZ - world.bounds.minZ, 70);
    assert.equal(world.terrain.kind, 'flat');
    assert.equal(world.colliders.length, MAP.boxes.length);
    assert.equal(world.visuals.length, MAP.boxes.length);
    assert.equal(
      world.spawnPoints.filter((s) => s.team === 'red').length,
      MAP.spawns.filter((s) => s.team === 'red').length,
    );
    assert.equal(
      world.spawnPoints.filter((s) => s.team === 'blue').length,
      MAP.spawns.filter((s) => s.team === 'blue').length,
    );
    assert.equal(
      world.spawnPoints.filter((s) => s.team === 'none').length,
      MAP.spawns.filter((s) => s.team === 'none').length,
    );
    assert.ok(world.locations.length >= 1);
    assert.ok(Array.isArray(world.containerLocations));

    // Harakat va to'qnashuv eski MAP.boxes bilan bir xil ishlashini tekshirish
    const b1: Body = { pos: { x: -38, y: 0, z: -22 }, vel: { x: 0, y: 0, z: 0 }, onGround: true };
    const b2: Body = { pos: { x: -38, y: 0, z: -22 }, vel: { x: 0, y: 0, z: 0 }, onGround: true };
    for (let i = 0; i < 30; i++) {
      applyMovement(b1, 5.5, 2.2, i === 0, 1 / 60, MAP.boxes);
      applyMovement(b2, 5.5, 2.2, i === 0, 1 / 60, DEFAULT_WORLD.colliders);
    }
    assert.deepEqual(b1, b2);
  });

  it('bir xil (mapId, worldVersion, publicLayoutSeed) har doim bir xil gameplayHash va joylashuv beradi', () => {
    const w1 = createWorldDefinition({
      mapId: 'dust_arena',
      worldVersion: 1,
      publicLayoutSeed: 424242,
    });
    const w2 = createWorldDefinition({
      mapId: 'dust_arena',
      worldVersion: 1,
      publicLayoutSeed: 424242,
    });
    const wDifferentSeed = createWorldDefinition({
      mapId: 'dust_arena',
      worldVersion: 1,
      publicLayoutSeed: 999999,
    });
    const wDifferentVersion = createWorldDefinition({
      mapId: 'dust_arena',
      worldVersion: 2,
      publicLayoutSeed: 424242,
    });

    assert.equal(w1.gameplayHash, w2.gameplayHash);
    assert.deepEqual(w1.colliders, w2.colliders);
    assert.deepEqual(w1.spawnPoints, w2.spawnPoints);
    assert.notEqual(w1.gameplayHash, wDifferentSeed.gameplayHash);
    assert.notEqual(w1.gameplayHash, wDifferentVersion.gameplayHash);
  });

  it("gameplayHash render/vizual descriptorlarga bog'liq emas", () => {
    const w1 = createWorldDefinition({
      mapId: 'dust_arena',
      worldVersion: 1,
      publicLayoutSeed: 6501,
    });
    const w2 = structuredClone(w1);
    const chunk = getChunkCoord(12, -8, w2.chunkSize);
    w2.visuals.push({
      id: 'decor_pine_instanced_test',
      sourceObjectId: 'pine_tree_01',
      prefabId: 'pine_tree_v1',
      category: 'foliage',
      batchKey: 'foliage:pine_needles',
      batchMode: 'instanced',
      chunkKey: chunk.key,
      lod: 'far',
      maxDrawDistance: 220,
      transform: {
        position: { x: 12, y: 0, z: -8 },
        yaw: 0,
        scale: { x: 1, y: 1, z: 1 },
      },
      boxDims: { x: 3, y: 9, z: 3 },
      material: 'crate',
      castShadow: false,
      receiveShadow: false,
    });

    assert.equal(computeGameplayHash(w1), computeGameplayHash(w2));
  });

  it('compilePrefabPlacement vizual model va fizik colliderni umumiy joylashuvdan mos koordinatada yaratadi', () => {
    const parts: LocalBoxPart[] = [
      {
        localId: 'north_wall',
        offset: { x: 0, y: 1.5, z: -3 },
        size: { x: 6, y: 3, z: 0.4 },
        mat: 'crate',
        colliderTag: 'structure',
        hasCollider: true,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'structure:cabin_wall',
        batchMode: 'static_box',
        lod: 'near',
      },
      {
        localId: 'roof_trim_decor',
        offset: { x: 0, y: 3.1, z: 0 },
        size: { x: 6.4, y: 0.2, z: 6.4 },
        mat: 'roof',
        hasCollider: false,
        hasVisual: true,
        visualCategory: 'structure',
        batchKey: 'structure:cabin_roof_trim',
        batchMode: 'instanced',
        lod: 'mid',
      },
      {
        localId: 'invisible_step_blocker',
        offset: { x: 2, y: 0.5, z: 0 },
        size: { x: 1, y: 1, z: 1 },
        mat: 'wall',
        colliderTag: 'prop',
        hasCollider: true,
        hasVisual: false,
        visualCategory: 'prop',
        batchKey: 'prop:blocker',
        batchMode: 'static_box',
      },
    ];

    const placement: PrefabPlacement = {
      objectId: 'cabin_alpha',
      prefabId: 'wood_cabin_small',
      transform: {
        position: { x: 20, y: 0, z: -15 },
        yaw: Math.PI / 2,
        scale: { x: 1, y: 1, z: 1 },
      },
      parts,
    };

    const compiled = compilePrefabPlacement(placement, 32);
    assert.equal(compiled.colliders.length, 2);
    assert.equal(compiled.visuals.length, 2);

    const wallCol = compiled.colliders.find((c) => c.id === 'cabin_alpha:north_wall:col')!;
    const wallVis = compiled.visuals.find((v) => v.id === 'cabin_alpha:north_wall:vis')!;
    assert.ok(wallCol);
    assert.ok(wallVis);

    // 90 daraja burilganda (ox=0, oz=-3) -> (rx=-3, rz=0) => markaz (17, 1.5, -15)
    // va o'lchamlari (sx=6, sz=0.4) -> AABB kengligi 0.4, chuqurligi 6 bo'ladi
    const colCenterX = (wallCol.min.x + wallCol.max.x) / 2;
    const colCenterY = (wallCol.min.y + wallCol.max.y) / 2;
    const colCenterZ = (wallCol.min.z + wallCol.max.z) / 2;
    assert.ok(Math.abs(colCenterX - wallVis.transform.position.x) < 1e-6);
    assert.ok(Math.abs(colCenterY - wallVis.transform.position.y) < 1e-6);
    assert.ok(Math.abs(colCenterZ - wallVis.transform.position.z) < 1e-6);
    assert.ok(Math.abs(colCenterX - 17) < 1e-6);
    assert.ok(Math.abs(colCenterZ - -15) < 1e-6);
    assert.ok(Math.abs(wallCol.max.x - wallCol.min.x - 0.4) < 1e-6);
    assert.ok(Math.abs(wallCol.max.z - wallCol.min.z - 6) < 1e-6);
  });

  it('xonalar mustaqil WorldDefinition ga ega, maxfiy loot seed mijozga chiqmaydi va mos kelmagan versiya rad etiladi', () => {
    const { io } = createFakeIo();
    const roomA = new Room(
      {
        name: 'Xona A',
        mode: 'tdm',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 5,
        scoreLimit: 25,
        publicLayoutSeed: 1001,
      },
      io,
      () => {},
    );
    const roomB = new Room(
      {
        name: 'Xona B',
        mode: 'ffa',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 5,
        scoreLimit: 25,
        publicLayoutSeed: 2002,
      },
      io,
      () => {},
    );

    try {
      assert.notEqual(roomA.world.publicLayoutSeed, roomB.world.publicLayoutSeed);
      assert.notEqual(roomA.world.gameplayHash, roomB.world.gameplayHash);
      assert.notEqual(getNav(roomA.world), getNav(roomB.world));
      assert.notEqual(roomA.getSecretLootSeedForServer(), roomA.world.publicLayoutSeed);

      // RoomInfo va WelcomeMsg ichida secretLootSeed yo'qligini tekshirish
      const infoJson = JSON.stringify(roomA.info());
      assert.ok(!infoJson.includes('secretLootSeed'));
      assert.ok(!infoJson.includes(String(roomA.getSecretLootSeedForServer())));

      // Avval normal o'yinchi qo'shamiz (xona bo'sh qolib destroy bo'lmasligi uchun)
      const { socket: hostClient } = createFakeSocket('client_host');
      roomA.addHuman(hostClient, 'HostPlayer');

      // Mos kelmaydigan worldMeta bilan ready yuborgan mijoz xonadan chiqariladi va tushunarli xato oladi
      const { socket: badClient, events: badEvents } = createFakeSocket('client_bad');
      const welcomeBad = roomA.addHuman(badClient, 'TesterBad');
      const welcomeJson = JSON.stringify(welcomeBad);
      assert.ok(!welcomeJson.includes('secretLootSeed'));

      let badAckResult: { ok: boolean; error?: string } | undefined;
      roomA.onReady(
        'client_bad',
        {
          world: {
            ...extractWorldMeta(roomA.world),
            worldVersion: 999,
          },
        },
        (ack) => {
          badAckResult = ack;
        },
      );

      assert.ok(badAckResult);
      assert.equal(badAckResult.ok, false);
      assert.ok(badAckResult.error?.includes('Xarita versiyasi mos kelmadi'));
      assert.ok(badEvents.some((e) => e.event === 'worldMismatch'));
      assert.equal(roomA.players.has('client_bad'), false);

      // To'g'ri worldMeta bilan ready yuborgan mijoz muvaffaqiyatli spawn qilinadi
      const { socket: goodClient, events: goodEvents } = createFakeSocket('client_good');
      roomA.addHuman(goodClient, 'TesterGood');
      let goodAckResult: { ok: boolean; error?: string } | undefined;
      roomA.onReady('client_good', { world: extractWorldMeta(roomA.world) }, (ack) => {
        goodAckResult = ack;
      });

      assert.ok(goodAckResult);
      assert.equal(goodAckResult.ok, true);
      assert.equal(roomA.players.has('client_good'), true);
      assert.ok(goodEvents.some((e) => e.event === 'spawn'));
    } finally {
      roomA.destroy();
      roomB.destroy();
    }
  });

  it('validateWorldCompatibility barcha nomutanosiblik holatlarida aniq xabar qaytaradi', () => {
    const serverMeta = extractWorldMeta(DEFAULT_WORLD);
    assert.deepEqual(validateWorldCompatibility(serverMeta, { ...serverMeta }), { ok: true });
    assert.equal(validateWorldCompatibility(serverMeta, null).ok, false);
    assert.equal(
      validateWorldCompatibility(serverMeta, { ...serverMeta, mapId: 'forest_square' as MapId }).ok,
      false,
    );
    assert.equal(validateWorldCompatibility(serverMeta, { ...serverMeta, worldVersion: 99 }).ok, false);
    assert.equal(validateWorldCompatibility(serverMeta, { ...serverMeta, publicLayoutSeed: 777 }).ok, false);
    assert.equal(validateWorldCompatibility(serverMeta, { ...serverMeta, gameplayHash: 'deadbeef' }).ok, false);
  });
});
