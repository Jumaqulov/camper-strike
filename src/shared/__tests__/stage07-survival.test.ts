import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { LocalPlayer } from '../../client/game/LocalPlayer';
import {
  SpectatorController,
  type SpectatableTarget,
} from '../../client/game/survival/SpectatorController';
import { sanitizeOpts } from '../../server/lobby';
import { Room } from '../../server/room';
import { EYE_HEIGHT, GRENADES_PER_LIFE, MAX_HP, RESPAWN_TIME } from '../constants';
import { getForestSquarePoiSites } from '../forestSquare';
import { hasLineOfSightToContainer } from '../loot';
import { vdist, vnorm, vsub, type Vec3 } from '../math';
import type { MatchState, PlayerInventorySnap } from '../protocol';
import { WEAPONS, WEAPON_SLOTS, damageAt, type WeaponId } from '../weapons';
import { sampleTerrainHeight } from '../world';

// ---------------- Fake Socket.IO Harness for Room Tests ----------------

interface EmittedRoomEvent {
  room: string;
  event: string;
  payload: unknown;
}

interface EmittedSocketEvent {
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
      return {
        emit: emitFn,
        volatile: {
          emit: emitFn,
        },
      };
    },
  } as unknown as Server;
  return { io, emitted };
}

function createFakeSocket(
  id: string,
  roomEmitted?: EmittedRoomEvent[],
): {
  socket: Socket;
  events: EmittedSocketEvent[];
  joinedRooms: Set<string>;
} {
  const events: EmittedSocketEvent[] = [];
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
    to(roomId: string) {
      return {
        emit(event: string, payload: unknown) {
          events.push({ event, payload });
          roomEmitted?.push({ room: roomId, event, payload });
        },
      };
    },
  } as unknown as Socket;
  return { socket, events, joinedRooms };
}

/**
 * Computes a valid player position ~0.85m in front of a container along its local +Z front normal,
 * or falls back to a nearby clear line-of-sight offset if needed.
 */
function findClearPlayerPosNearContainer(
  room: Room,
  cnt: { id: string; position: Vec3; yaw: number },
): Vec3 {
  const candidates: Vec3[] = [];
  const frontDist = 0.85;
  candidates.push({
    x: cnt.position.x + Math.sin(cnt.yaw) * frontDist,
    y: cnt.position.y,
    z: cnt.position.z + Math.cos(cnt.yaw) * frontDist,
  });
  for (let angleDeg = 0; angleDeg < 360; angleDeg += 30) {
    const rad = (angleDeg * Math.PI) / 180;
    for (const r of [0.75, 1.05, 1.35]) {
      const x = cnt.position.x + Math.cos(rad) * r;
      const z = cnt.position.z + Math.sin(rad) * r;
      const terrainY = sampleTerrainHeight(room.world.terrain, x, z);
      const baseFloorY =
        cnt.position.y - terrainY > 0.65 && cnt.position.y - terrainY < 1.15
          ? cnt.position.y - 0.75
          : cnt.position.y;
      candidates.push({ x, y: baseFloorY, z });
      candidates.push({ x, y: terrainY, z });
    }
  }

  for (const pos of candidates) {
    const eye: Vec3 = { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z };
    if (hasLineOfSightToContainer(room.world, eye, cnt.position, cnt.id)) {
      return pos;
    }
  }

  return {
    x: cnt.position.x + Math.sin(cnt.yaw) * 0.7,
    y: cnt.position.y,
    z: cnt.position.z + Math.cos(cnt.yaw) * 0.7,
  };
}

/**
 * Helper: finds a container holding a weapon and its paired ammo in the room,
 * moves the player in front of it, opens it, and picks up both the weapon and ammo.
 */
function armPlayerFromContainer(
  room: Room,
  playerId: string,
  reqPrefix: string,
): { containerId: string; weaponId: WeaponId; weaponItemId: string; ammoItemId: string } {
  const p = room.players.get(playerId)!;
  assert.ok(p, `Player ${playerId} must exist`);

  let chosenCntId = '';
  let weaponItemId = '';
  let ammoItemId = '';
  let weaponId: WeaponId = 'rifle';

  for (const cntId of room.loot.getAuthoritativeContainerIds()) {
    const raw = room.loot.getRawContainerForServerTest(cntId)!;
    for (const item of raw.items.values()) {
      if (item.kind === 'weapon' && item.weaponId) {
        const matchingAmmo = [...raw.items.values()].find(
          (it) => it.kind === 'ammo' && it.ammoWeapon === item.weaponId,
        );
        if (matchingAmmo) {
          chosenCntId = cntId;
          weaponItemId = item.id;
          ammoItemId = matchingAmmo.id;
          weaponId = item.weaponId;
          break;
        }
      }
    }
    if (chosenCntId) break;
  }

  assert.ok(chosenCntId && weaponItemId && ammoItemId, 'Must find a container with weapon + ammo');
  const rawCnt = room.loot.getRawContainerForServerTest(chosenCntId)!;
  p.pos = findClearPlayerPosNearContainer(room, rawCnt);

  const openAck = room.onContainerOpen(playerId, {
    requestId: `${reqPrefix}_open`,
    containerId: chosenCntId,
    roundId: room.getRoundId(),
    spawnId: p.spawnId,
  });
  assert.equal(openAck.ok, true, `Expected container open ok, got ${openAck.code}`);

  const pickW = room.onLootPickup(playerId, {
    requestId: `${reqPrefix}_pick_w`,
    containerId: chosenCntId,
    itemId: weaponItemId,
    roundId: room.getRoundId(),
    spawnId: p.spawnId,
  });
  assert.equal(pickW.ok, true, `Expected weapon pickup ok, got ${pickW.code}`);

  const pickA = room.onLootPickup(playerId, {
    requestId: `${reqPrefix}_pick_a`,
    containerId: chosenCntId,
    itemId: ammoItemId,
    roundId: room.getRoundId(),
    spawnId: p.spawnId,
  });
  assert.equal(pickA.ok, true, `Expected ammo pickup ok, got ${pickA.code}`);

  return { containerId: chosenCntId, weaponId, weaponItemId, ammoItemId };
}

/**
 * Helper: positions shooter and victim in clear line-of-sight at poi_service_station courtyard
 * and fires authoritative shots until victim is eliminated.
 */
function eliminateTargetWithGunfire(room: Room, shooterId: string, victimId: string): void {
  const shooter = room.players.get(shooterId)!;
  const victim = room.players.get(victimId)!;
  assert.ok(shooter && victim, 'Shooter and victim must exist');
  assert.ok(shooter.weapon, 'Shooter must have an equipped weapon');

  const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
  const sx = serviceSite.center.x - 6;
  const sz = serviceSite.center.z + 6;
  const vx = sx;
  const vz = sz - 3.5;

  shooter.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz), z: sz };
  victim.pos = { x: vx, y: sampleTerrainHeight(room.world.terrain, vx, vz), z: vz };
  shooter.spawnTime = -99;
  victim.spawnTime = -99;

  const wDef = WEAPONS[shooter.weapon];
  for (let guard = 0; guard < 25 && victim.alive; guard++) {
    // Re-place victim in case knockback moved them slightly
    victim.pos = { x: vx, y: sampleTerrainHeight(room.world.terrain, vx, vz), z: vz };
    const shooterEye: Vec3 = {
      x: shooter.pos.x,
      y: shooter.pos.y + EYE_HEIGHT,
      z: shooter.pos.z,
    };
    const victimHead: Vec3 = {
      x: victim.pos.x,
      y: victim.pos.y + 1.5,
      z: victim.pos.z,
    };
    const dir = vnorm(vsub(victimHead, shooterEye));
    shooter.yaw = Math.atan2(-dir.x, -dir.z);
    shooter.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    shooter.lastShot = -99;
    if (shooter.ammo[wDef.id].mag <= 0) {
      shooter.ammo[wDef.id].mag = wDef.magSize;
    }

    const dirs = Array.from({ length: wDef.pellets }, () => dir);
    room.onShoot(shooterId, {
      weapon: wDef.id,
      origin: shooterEye,
      dirs,
    });
  }

  assert.equal(victim.alive, false, `Expected ${victimId} to be eliminated by ${shooterId}`);
}

describe('STAGE 07 — Forest Survival Mode, Round Lifecycle, Elimination, Spectator & Stage 06 Audit Fixes', () => {
  it('1. Stage 06 Audit Fix 1 — NOT_IN_LOOT_MODE Gate in Classic TDM/FFA (lootPreview: false)', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Classic FFA No-Loot Room',
        mode: 'ffa',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
        lootPreview: false,
      },
      io,
      () => {},
    );

    try {
      assert.equal(room.lootEnabled, false);
      assert.equal(room.lootPreview, false);

      const sock1 = createFakeSocket('p1');
      room.addHuman(sock1.socket, 'ClassicPlayer');
      room.onReady('p1', { world: room.worldMeta() });

      const p1 = room.players.get('p1')!;
      assert.equal(p1.weapon, 'rifle');
      assert.equal(p1.grenades, GRENADES_PER_LIFE);

      // Place p1 right in front of a valid container on forest_square
      const containerId = 'poi:poi_ranger_house:cnt_0:wooden_loot_crate_01';
      const rawCnt = room.loot.getRawContainerForServerTest(containerId)!;
      assert.ok(rawCnt);
      const anyItemId = [...rawCnt.items.keys()][0]!;
      p1.pos = findClearPlayerPosNearContainer(room, rawCnt);

      // 1a) Container open must be rejected with NOT_IN_LOOT_MODE
      const openAck = room.onContainerOpen('p1', {
        requestId: 'noloot_open_1',
        containerId,
      });
      assert.equal(openAck.ok, false);
      assert.equal(openAck.code, 'NOT_IN_LOOT_MODE');
      assert.equal(room.loot.getPublicContainerState(containerId)!.opened, false);

      // 1b) Loot pickup must be rejected with NOT_IN_LOOT_MODE
      const pickAck = room.onLootPickup('p1', {
        requestId: 'noloot_pick_1',
        containerId,
        itemId: anyItemId,
      });
      assert.equal(pickAck.ok, false);
      assert.equal(pickAck.code, 'NOT_IN_LOOT_MODE');

      // 1c) Medkit use must be rejected with NOT_IN_LOOT_MODE even when damaged
      p1.hp = 50;
      const medAck = room.onUseMedkit('p1', {
        requestId: 'noloot_med_1',
      });
      assert.equal(medAck.ok, false);
      assert.equal(medAck.code, 'NOT_IN_LOOT_MODE');
      assert.equal(p1.hp, 50);

      // 1d) Unequipping to empty hands (weapon: null) must be rejected with NOT_IN_LOOT_MODE in classic mode
      const unequipAck = room.onEquipWeapon('p1', {
        requestId: 'noloot_unequip_1',
        weapon: null,
      });
      assert.equal(unequipAck.ok, false);
      assert.equal(unequipAck.code, 'NOT_IN_LOOT_MODE');
      assert.equal(p1.weapon, 'rifle');

      // 1e) Equipping an owned classic weapon ('pistol') must succeed
      const equipAck = room.onEquipWeapon('p1', {
        requestId: 'classic_equip_pistol',
        weapon: 'pistol',
      });
      assert.equal(equipAck.ok, true);
      assert.equal(p1.weapon, 'pistol');

      assert.ok(
        room.loot.getStats().rejectedNotInLootMode >= 4,
        `Expected rejectedNotInLootMode >= 4, got ${room.loot.getStats().rejectedNotInLootMode}`,
      );
    } finally {
      room.destroy();
    }
  });

  it('2. Stage 06 Audit Fix 2 — roundId & spawnId Scoped Idempotency & Stale ACK Protection', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Scoped Idempotency Survival Room',
        mode: 'forest_survival',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 3,
        scoreLimit: 1,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
        countdownSec: 2,
      },
      io,
      () => {},
    );

    try {
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      room.addHuman(sock1.socket, 'One');
      room.addHuman(sock2.socket, 'Two');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });

      // Advance past countdown into Round 1 playing phase
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      assert.equal(room.getRoundId(), 1);

      const p1 = room.players.get('p1')!;
      const spawnId1 = p1.spawnId;

      const containerId = 'poi:poi_ranger_house:cnt_0:wooden_loot_crate_01';
      const rawCnt = room.loot.getRawContainerForServerTest(containerId)!;
      const firstItem = [...rawCnt.items.values()][0]!;
      p1.pos = findClearPlayerPosNearContainer(room, rawCnt);

      const openAck1 = room.onContainerOpen('p1', {
        requestId: 'dup_open_1',
        containerId,
        roundId: 1,
        spawnId: spawnId1,
      });
      assert.equal(openAck1.ok, true);
      assert.equal(openAck1.roundId, 1);
      assert.equal(openAck1.spawnId, spawnId1);

      // Pickup item with requestId: 'dup_req_1'
      const ack1 = room.onLootPickup('p1', {
        requestId: 'dup_req_1',
        containerId,
        itemId: firstItem.id,
        roundId: 1,
        spawnId: spawnId1,
      });
      assert.equal(ack1.ok, true);
      assert.equal(ack1.roundId, 1);
      assert.equal(ack1.spawnId, spawnId1);
      assert.ok(!ack1.idempotentReplay);

      // Replay 'dup_req_1' in the same spawn & round -> idempotentReplay === true
      const ackReplay = room.onLootPickup('p1', {
        requestId: 'dup_req_1',
        containerId,
        itemId: firstItem.id,
        roundId: 1,
        spawnId: spawnId1,
      });
      assert.equal(ackReplay.ok, true);
      assert.equal(ackReplay.idempotentReplay, true);
      assert.equal(ackReplay.roundId, 1);
      assert.equal(ackReplay.spawnId, spawnId1);

      // Respawn p1 so p1.spawnId increments
      room.spawn(p1);
      assert.equal(p1.spawnId, spawnId1 + 1);
      assert.equal(p1.weapon, null);
      assert.equal(room.loot.getPlayerInventorySnap('p1')!.items.length, 0);

      // Place p1 back near the container and send 'dup_req_1' again under the new spawnId
      p1.pos = findClearPlayerPosNearContainer(room, rawCnt);
      const ackNewSpawn = room.onLootPickup('p1', {
        requestId: 'dup_req_1',
        containerId,
        itemId: firstItem.id,
        roundId: 1,
        spawnId: p1.spawnId,
      });
      assert.ok(
        !ackNewSpawn.idempotentReplay,
        'Replaying old requestId after respawn must NOT return cached idempotent ACK from previous spawn',
      );
      assert.equal(ackNewSpawn.ok, false);
      assert.equal(ackNewSpawn.code, 'ITEM_ALREADY_TAKEN');
      assert.equal(
        room.loot.getPlayerInventorySnap('p1')!.items.length,
        0,
        'Old spawn inventory must not leak into new spawn',
      );

      // Sending a request with an explicit stale spawnId or stale roundId must be rejected
      const staleSpawnAck = room.onContainerOpen('p1', {
        requestId: 'explicit_stale_spawn',
        containerId,
        spawnId: spawnId1,
      });
      assert.equal(staleSpawnAck.ok, false);
      assert.equal(staleSpawnAck.code, 'INVALID_REQUEST');

      const staleRoundAck = room.onContainerOpen('p1', {
        requestId: 'explicit_stale_round',
        containerId,
        roundId: 99,
      });
      assert.equal(staleRoundAck.ok, false);
      assert.equal(staleRoundAck.code, 'INVALID_REQUEST');
      assert.ok(room.loot.getStats().rejectedStaleRoundOrSpawn >= 2);
    } finally {
      room.destroy();
    }

    // Client-side LocalPlayer.applyInventorySnap stale roundId / spawnId / inventoryVersion protection
    const me = new LocalPlayer();
    me.setLootPreview(true);
    me.spawn(
      {
        spawnId: 3,
        roundId: 2,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        team: 'none',
        weapon: null,
        lootPreview: true,
        lootEnabled: true,
      },
      10,
    );

    const validSnap: PlayerInventorySnap = {
      playerId: 'p1',
      roundId: 2,
      spawnId: 3,
      inventoryVersion: 5,
      lootEnabled: true,
      lootPreview: true,
      equippedWeapon: 'shotgun',
      ownedWeapons: ['shotgun'],
      ammo: {
        rifle: { mag: 0, reserve: 0 },
        pistol: { mag: 0, reserve: 0 },
        shotgun: { mag: 6, reserve: 18 },
        sniper: { mag: 0, reserve: 0 },
      },
      grenades: 1,
      medkits: 1,
      maxWeaponSlots: 4,
      maxMedkits: 2,
      maxGrenades: 2,
      items: [],
      armor: 0,
      helmet: 0,
    };
    me.applyInventorySnap(validSnap, 11);
    assert.equal(me.weapon, 'shotgun');
    assert.equal(me.roundId, 2);
    assert.equal(me.spawnId, 3);
    assert.equal(me.inventoryVersion, 5);
    assert.equal(me.ammo.shotgun.mag, 6);

    // 2a) Stale roundId (roundId: 1 < me.roundId: 2) must be ignored even if inventoryVersion is higher
    const appliedStaleRound = me.applyInventorySnap(
      {
        ...validSnap,
        roundId: 1,
        spawnId: 3,
        inventoryVersion: 99,
        equippedWeapon: 'pistol',
        ownedWeapons: ['pistol'],
      },
      12,
    );
    assert.equal(appliedStaleRound, false);
    assert.equal(me.roundId, 2);
    assert.equal(me.weapon, 'shotgun');
    assert.deepEqual([...me.ownedWeapons], ['shotgun']);
    assert.equal(me.ammo.shotgun.mag, 6);

    // 2b) Stale spawnId (spawnId: 2 !== me.spawnId: 3) must be ignored even if inventoryVersion is higher
    const appliedStaleSpawn = me.applyInventorySnap(
      {
        ...validSnap,
        roundId: 2,
        spawnId: 2,
        inventoryVersion: 99,
        equippedWeapon: null,
        ownedWeapons: [],
      },
      13,
    );
    assert.equal(appliedStaleSpawn, false);
    assert.equal(me.spawnId, 3);
    assert.equal(me.weapon, 'shotgun');
    assert.deepEqual([...me.ownedWeapons], ['shotgun']);

    // 2c) Lower inventoryVersion (inventoryVersion: 4 < 5) in same round & spawn must be ignored
    const appliedStaleVersion = me.applyInventorySnap(
      {
        ...validSnap,
        roundId: 2,
        spawnId: 3,
        inventoryVersion: 4,
        equippedWeapon: 'rifle',
        ownedWeapons: ['rifle'],
      },
      14,
    );
    assert.equal(appliedStaleVersion, false);
    assert.equal(me.inventoryVersion, 5);
    assert.equal(me.weapon, 'shotgun');
  });

  it('3. forest_survival Map & Mode Restrictions (forest_square Only, 0 Bots, No Team Switch)', () => {
    const { io } = createFakeIo();

    // 3a) Creating forest_survival on dust_arena must throw
    assert.throws(
      () =>
        new Room(
          {
            name: 'Bad Map Survival',
            mode: 'forest_survival',
            mapId: 'dust_arena',
            bots: 4,
            maxPlayers: 8,
            timeLimit: 3,
            scoreLimit: 10,
          },
          io,
          () => {},
        ),
      /forest_square/i,
    );

    // 3b) sanitizeOpts forces forest_square, 0 bots, lootPreview: true
    const sanitized = sanitizeOpts(
      {
        name: 'Survival Sanitize',
        mode: 'forest_survival',
        mapId: 'dust_arena',
        bots: 8,
        maxPlayers: 1,
      },
      'Host',
    );
    assert.equal(sanitized.mode, 'forest_survival');
    assert.equal(sanitized.mapId, 'forest_square');
    assert.equal(sanitized.bots, 0);
    assert.equal(sanitized.lootPreview, true);
    assert.ok(sanitized.maxPlayers >= 2);

    // 3c) Room constructor forces 0 bots, blocks /addbot and /removebot, and ignores onSwitchTeam
    const room = new Room(
      {
        name: 'Valid Survival Room',
        mode: 'forest_survival',
        mapId: 'forest_square',
        bots: 6,
        maxPlayers: 8,
        timeLimit: 3,
        scoreLimit: 1,
        publicLayoutSeed: 6501,
      },
      io,
      () => {},
    );

    try {
      assert.equal(room.isSurvival, true);
      assert.equal(room.lootEnabled, true);
      assert.equal(room.botCount(), 0, 'forest_survival must spawn 0 bots');

      const sock1 = createFakeSocket('p1');
      room.addHuman(sock1.socket, 'Solo');
      room.onReady('p1', { world: room.worldMeta() });

      const p1 = room.players.get('p1')!;
      assert.equal(p1.team, 'none');

      room.onChat('p1', '/addbot');
      assert.equal(room.botCount(), 0, '/addbot must be blocked in forest_survival');

      room.onChat('p1', '/removebot');
      assert.equal(room.botCount(), 0, '/removebot must be blocked in forest_survival');

      room.onSwitchTeam('p1');
      assert.equal(p1.team, 'none', 'onSwitchTeam must be ignored in forest_survival');
    } finally {
      room.destroy();
    }
  });

  it('4. Minimum Players Gate (waiting Phase with < 2 Ready Players)', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Waiting Gate Room',
        mode: 'forest_survival',
        mapId: 'forest_square',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 3,
        scoreLimit: 1,
        publicLayoutSeed: 6501,
      },
      io,
      () => {},
    );

    try {
      room.setSurvivalConfigForTest({
        minPlayersToStart: 2,
        countdownDurationSec: 5,
        roundDurationSec: 60,
        endedDisplayDurationSec: 4,
      });

      const sock1 = createFakeSocket('p1');
      room.addHuman(sock1.socket, 'WaitingPlayer');
      room.onReady('p1', { world: room.worldMeta() });

      const p1 = room.players.get('p1')!;
      const survBefore = room.getSurvivalState()!;
      assert.ok(survBefore);
      assert.equal(room.phase, 'waiting');
      assert.equal(survBefore.phase, 'waiting');
      assert.equal(survBefore.readyCount, 1);
      assert.equal(survBefore.minPlayers, 2);

      // Advance 30s with only 1 ready player
      room.advanceTimeForTest(30, 0.5);

      const survAfter = room.getSurvivalState()!;
      assert.equal(room.phase, 'waiting', 'Room must remain in waiting with < 2 ready players');
      assert.equal(survAfter.phase, 'waiting');
      assert.equal(survAfter.roundId, 1);
      assert.equal(survAfter.winnerId, null);
      assert.equal(p1.weapon, null, 'Player must remain unarmed during waiting');

      // Verify p1 cannot open containers during waiting
      const containerId = 'poi:poi_ranger_house:cnt_0:wooden_loot_crate_01';
      const rawCnt = room.loot.getRawContainerForServerTest(containerId)!;
      p1.pos = findClearPlayerPosNearContainer(room, rawCnt);

      const openAck = room.onContainerOpen('p1', {
        requestId: 'wait_open_1',
        containerId,
      });
      assert.equal(openAck.ok, false);
      assert.equal(openAck.code, 'ROUND_NOT_ACTIVE');
    } finally {
      room.destroy();
    }
  });

  it('5. Countdown Start (2/2 Ready) & Cancellation When Player Leaves (< 2 Ready)', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Countdown Cancel Room',
        mode: 'forest_survival',
        mapId: 'forest_square',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 3,
        scoreLimit: 1,
        publicLayoutSeed: 6501,
      },
      io,
      () => {},
    );

    try {
      room.setSurvivalConfigForTest({
        minPlayersToStart: 2,
        countdownDurationSec: 5,
        roundDurationSec: 60,
        endedDisplayDurationSec: 4,
      });

      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      room.addHuman(sock1.socket, 'Alpha');
      room.onReady('p1', { world: room.worldMeta() });
      assert.equal(room.phase, 'waiting');

      // Join and ready p2 -> immediate transition to countdown
      room.addHuman(sock2.socket, 'Bravo');
      room.onReady('p2', { world: room.worldMeta() });
      assert.equal(room.phase, 'countdown');
      assert.ok(room.getSurvivalState()!.timeLeft > 0);
      assert.equal(room.getSurvivalState()!.readyCount, 2);

      // Advance 2.0s into countdown, then remove p2 -> cancels back to waiting
      room.advanceTimeForTest(2.0, 0.25);
      assert.equal(room.phase, 'countdown');

      room.removePlayer('p2');
      assert.equal(room.phase, 'waiting', 'Countdown must cancel to waiting when player leaves');
      assert.equal(room.getSurvivalState()!.readyCount, 1);
      assert.equal(room.getSurvivalState()!.timeLeft, 0);

      // Re-add and ready p2 -> countdown restarts, and advancing 5.5s starts Round 1 playing
      const sock2b = createFakeSocket('p2');
      room.addHuman(sock2b.socket, 'BravoRejoined');
      room.onReady('p2', { world: room.worldMeta() });
      assert.equal(room.phase, 'countdown');

      room.advanceTimeForTest(5.5, 0.25);
      const survPlaying = room.getSurvivalState()!;
      assert.equal(room.phase, 'playing');
      assert.equal(survPlaying.phase, 'playing');
      assert.equal(survPlaying.roundId, 1);
      assert.equal(survPlaying.aliveCount, 2);
      assert.equal(survPlaying.totalContenders, 2);
    } finally {
      room.destroy();
    }
  });

  it('6. Unarmed Spawn & 26 Closed Containers at Round Start', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Round Start State Room',
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
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      room.addHuman(sock1.socket, 'Contender1');
      room.addHuman(sock2.socket, 'Contender2');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });

      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      for (const id of ['p1', 'p2']) {
        const p = room.players.get(id)!;
        const inv = room.loot.getPlayerInventorySnap(id)!;
        assert.equal(p.alive, true);
        assert.equal(p.hp, MAX_HP);
        assert.equal(p.weapon, null);
        assert.equal(p.grenades, 0);
        assert.equal(inv.ownedWeapons.length, 0);
        assert.equal(room.survival!.getPlayerRole(id), 'contender');
      }

      const pubSnap = room.loot.getPublicLootSnapshot();
      assert.equal(pubSnap.containers.length, 26);
      for (const cnt of pubSnap.containers) {
        assert.equal(cnt.status, 'closed');
        assert.equal(cnt.opened, false);
        assert.equal(cnt.items.length, 0);
        assert.equal(cnt.itemCount, -1);

        const rawCnt = room.loot.getRawContainerForServerTest(cnt.id)!;
        assert.ok(rawCnt.items.size >= 2);
        for (const itemId of rawCnt.items.keys()) {
          assert.ok(
            itemId.startsWith(`itm:${room.id}:r1:c`),
            `Expected Round 1 item ID prefix itm:${room.id}:r1:c, got ${itemId}`,
          );
        }
      }
    } finally {
      room.destroy();
    }
  });

  it('7. Elimination Without Respawn (3s+ Post-Death Check) & Spectator Transition', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Elimination No-Respawn Room',
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
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      const sock3 = createFakeSocket('p3');
      room.addHuman(sock1.socket, 'Hunter');
      room.addHuman(sock2.socket, 'VictimTwo');
      room.addHuman(sock3.socket, 'SurvivorThree');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.onReady('p3', { world: room.worldMeta() });

      // Start Round 1 with 3 contenders
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      assert.equal(room.getSurvivalState()!.aliveCount, 3);
      assert.equal(room.getSurvivalState()!.totalContenders, 3);

      const p2 = room.players.get('p2')!;

      // Arm p1 from a container and kill p2
      armPlayerFromContainer(room, 'p1', 'r1_p1');
      eliminateTargetWithGunfire(room, 'p1', 'p2');

      assert.equal(p2.alive, false);
      assert.equal(p2.hp, 0);
      assert.equal(p2.respawnAt, Infinity);
      assert.equal(room.phase, 'playing', 'Match must continue while p1 and p3 are alive');
      assert.equal(room.getSurvivalState()!.aliveCount, 2);
      assert.equal(room.survival!.getPlayerRole('p2'), 'eliminated');
      assert.equal(room.survival!.getPlacement('p2'), 3);
      const p2SpectateTarget = room.survival!.getSpectateTarget('p2');
      assert.ok(
        p2SpectateTarget === 'p1' || p2SpectateTarget === 'p3',
        `Expected p2 spectateTargetId to be 'p1' or 'p3', got ${p2SpectateTarget}`,
      );

      // Advance 6.0s (> RESPAWN_TIME = 3.0s) and verify p2 NEVER respawns mid-round
      room.advanceTimeForTest(6.0, 0.2);
      assert.ok(6.0 > RESPAWN_TIME);
      assert.equal(p2.alive, false, 'Eliminated player p2 must NEVER respawn mid-round');
      assert.equal(room.getSurvivalState()!.aliveCount, 2);
    } finally {
      room.destroy();
    }
  });

  it('8. Eliminated Player Action Blocking (Move, Shoot, Reload, Grenade, Container Open, Pickup, Equip, Medkit)', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Eliminated Action Blocking Room',
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
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      const sock3 = createFakeSocket('p3');
      room.addHuman(sock1.socket, 'Hunter');
      room.addHuman(sock2.socket, 'EliminatedP2');
      room.addHuman(sock3.socket, 'SurvivorP3');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.onReady('p3', { world: room.worldMeta() });

      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;

      armPlayerFromContainer(room, 'p1', 'blk_p1');
      eliminateTargetWithGunfire(room, 'p1', 'p2');
      assert.equal(p2.alive, false);
      assert.equal(room.survival!.getPlayerRole('p2'), 'eliminated');

      const unopenedCntId = 'poi:poi_ranger_house:cnt_1:metal_locker_01';
      const unopenedRaw = room.loot.getRawContainerForServerTest(unopenedCntId)!;
      const unopenedItemId = [...unopenedRaw.items.keys()][0]!;

      p2.pos = findClearPlayerPosNearContainer(room, unopenedRaw);
      const p2PosBefore = { ...p2.pos };

      // 8a) Movement input blocked (0m movement)
      room.onInput('p2', {
        seq: 1,
        spawnId: p2.spawnId,
        dt: 0.05,
        moveForward: 1,
        moveRight: 1,
        jump: true,
        walk: false,
        scoped: false,
        weapon: null,
        yaw: 0,
        pitch: 0,
      });
      room.advanceTimeForTest(0.5, 0.05);
      assert.equal(vdist(p2.pos, p2PosBefore), 0, 'Eliminated player must not move');

      // 8b) Shoot, Reload, Grenade blocked
      const p1HpBefore = p1.hp;
      const p2Eye: Vec3 = { x: p2.pos.x, y: p2.pos.y + EYE_HEIGHT, z: p2.pos.z };
      const p1Chest: Vec3 = { x: p1.pos.x, y: p1.pos.y + 1.0, z: p1.pos.z };
      room.onShoot('p2', {
        weapon: 'rifle',
        origin: p2Eye,
        dirs: [vnorm(vsub(p1Chest, p2Eye))],
      });
      assert.equal(p1.hp, p1HpBefore, 'Eliminated player cannot deal damage');

      room.onReload('p2');
      assert.equal(p2.reloadWeapon, null);
      room.onGrenade('p2', { dir: { x: 0, y: 0, z: -1 } });

      // 8c) Container open, pickup, equip, medkit all return PLAYER_DEAD
      const deadOpenAck = room.onContainerOpen('p2', {
        requestId: 'dead_open_1',
        containerId: unopenedCntId,
      });
      assert.equal(deadOpenAck.ok, false);
      assert.equal(deadOpenAck.code, 'PLAYER_DEAD');

      const deadPickAck = room.onLootPickup('p2', {
        requestId: 'dead_pick_1',
        containerId: unopenedCntId,
        itemId: unopenedItemId,
      });
      assert.equal(deadPickAck.ok, false);
      assert.equal(deadPickAck.code, 'PLAYER_DEAD');

      const deadEquipAck = room.onEquipWeapon('p2', {
        requestId: 'dead_equip_1',
        weapon: 'rifle',
      });
      assert.equal(deadEquipAck.ok, false);
      assert.equal(deadEquipAck.code, 'PLAYER_DEAD');

      const deadMedAck = room.onUseMedkit('p2', {
        requestId: 'dead_med_1',
      });
      assert.equal(deadMedAck.ok, false);
      assert.equal(deadMedAck.code, 'PLAYER_DEAD');
    } finally {
      room.destroy();
    }
  });

  it('9. Mid-Match Joiner Enters as Spectator & Cannot Act Until Next Round', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Mid-Match Joiner Room',
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
      const sock1 = createFakeSocket('p1');
      const sock3 = createFakeSocket('p3');
      room.addHuman(sock1.socket, 'FighterOne');
      room.addHuman(sock3.socket, 'FighterThree');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p3', { world: room.worldMeta() });

      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      assert.equal(room.getSurvivalState()!.aliveCount, 2);
      assert.equal(room.getSurvivalState()!.totalContenders, 2);

      // Join p4 mid-match
      const sock4 = createFakeSocket('p4');
      room.addHuman(sock4.socket, 'LateJoiner');
      room.onReady('p4', { world: room.worldMeta() });

      const p4 = room.players.get('p4')!;
      assert.equal(p4.alive, false, 'Mid-match joiner must enter dead/spectating');
      assert.equal(p4.hp, 0);
      assert.equal(p4.weapon, null);
      assert.equal(room.survival!.getPlayerRole('p4'), 'spectator');
      assert.equal(room.getSurvivalState()!.aliveCount, 2, 'Mid-match joiner must not change aliveCount');
      assert.equal(
        room.getSurvivalState()!.totalContenders,
        2,
        'Mid-match joiner must not change totalContenders of active round',
      );

      const unopenedCntId = 'poi:poi_ranger_house:cnt_0:wooden_loot_crate_01';
      const rawCnt = room.loot.getRawContainerForServerTest(unopenedCntId)!;
      p4.pos = findClearPlayerPosNearContainer(room, rawCnt);
      const p4PosBefore = { ...p4.pos };

      room.onInput('p4', {
        seq: 1,
        spawnId: p4.spawnId,
        dt: 0.05,
        moveForward: 1,
        moveRight: 0,
        jump: false,
        walk: false,
        scoped: false,
        weapon: null,
        yaw: 0,
        pitch: 0,
      });
      room.advanceTimeForTest(0.3, 0.05);
      assert.equal(vdist(p4.pos, p4PosBefore), 0, 'Spectator p4 must not move during active round');

      const p4OpenAck = room.onContainerOpen('p4', {
        requestId: 'spec_open_1',
        containerId: unopenedCntId,
      });
      assert.equal(p4OpenAck.ok, false);
      assert.equal(p4OpenAck.code, 'PLAYER_DEAD');
    } finally {
      room.destroy();
    }
  });

  it('10. Last Alive Contender Wins (last_standing) & Single Winner Declaration Guard', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Last Standing Winner Guard Room',
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
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      const sock3 = createFakeSocket('p3');
      room.addHuman(sock1.socket, 'Champion');
      room.addHuman(sock2.socket, 'SecondRunner');
      room.addHuman(sock3.socket, 'FirstRunner');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.onReady('p3', { world: room.worldMeta() });

      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      const p1 = room.players.get('p1')!;
      const p3 = room.players.get('p3')!;

      armPlayerFromContainer(room, 'p1', 'win_p1');
      eliminateTargetWithGunfire(room, 'p1', 'p2');
      assert.equal(room.phase, 'playing');

      eliminateTargetWithGunfire(room, 'p1', 'p3');
      assert.equal(p3.alive, false);
      assert.equal(room.phase, 'ended');

      const survEnded = room.getSurvivalState()!;
      assert.equal(survEnded.phase, 'ended');
      assert.equal(survEnded.aliveCount, 1);
      assert.equal(survEnded.winnerId, 'p1');
      assert.equal(survEnded.winnerName, p1.name);
      assert.equal(survEnded.winReason, 'last_standing');
      assert.equal(room.survival!.getPlacement('p1'), 1);
      assert.equal(room.survival!.getPlacement('p3'), 2);
      assert.equal(room.survival!.getPlacement('p2'), 3);
      assert.equal(room.survival!.getRoundDeclareCount(), 1);

      // Calling checkOutcome again and advancing 1.0s during ended must NOT re-declare a winner
      const recheck = room.survival!.checkOutcome(room.now());
      assert.equal(recheck, false);
      room.advanceTimeForTest(1.0, 0.25);
      assert.equal(room.survival!.getRoundDeclareCount(), 1);
    } finally {
      room.destroy();
    }
  });

  it('11. Simultaneous Elimination (draw_mutual_elimination)', () => {
    const { io, emitted } = createFakeIo();
    const room = new Room(
      {
        name: 'Mutual Elimination Draw Room',
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
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      room.addHuman(sock1.socket, 'BoomOne');
      room.addHuman(sock2.socket, 'BoomTwo');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });

      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;

      // Loot a grenade for p1 (or find grenade container)
      let grenadeCntId = '';
      let grenadeItemId = '';
      for (const cntId of room.loot.getAuthoritativeContainerIds()) {
        const raw = room.loot.getRawContainerForServerTest(cntId)!;
        for (const it of raw.items.values()) {
          if (it.kind === 'grenade') {
            grenadeCntId = cntId;
            grenadeItemId = it.id;
            break;
          }
        }
        if (grenadeCntId) break;
      }
      assert.ok(grenadeCntId && grenadeItemId, 'Must find a grenade in room containers');
      const rawG = room.loot.getRawContainerForServerTest(grenadeCntId)!;
      p1.pos = findClearPlayerPosNearContainer(room, rawG);
      assert.equal(
        room.onContainerOpen('p1', {
          requestId: 'g_open',
          containerId: grenadeCntId,
          roundId: room.getRoundId(),
          spawnId: p1.spawnId,
        }).ok,
        true,
      );
      assert.equal(
        room.onLootPickup('p1', {
          requestId: 'g_pick',
          containerId: grenadeCntId,
          itemId: grenadeItemId,
          roundId: room.getRoundId(),
          spawnId: p1.spawnId,
        }).ok,
        true,
      );
      assert.equal(p1.grenades, 1);

      // Place p1 and p2 at the same open spot with 40 HP and no spawn protection
      const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
      const gx = serviceSite.center.x - 6;
      const gz = serviceSite.center.z + 6;
      const gy = sampleTerrainHeight(room.world.terrain, gx, gz);

      p1.pos = { x: gx, y: gy, z: gz };
      p2.pos = { x: gx + 0.2, y: gy, z: gz };
      p1.vel = { x: 0, y: 0, z: 0 };
      p2.vel = { x: 0, y: 0, z: 0 };
      p1.hp = 40;
      p2.hp = 40;
      p1.spawnTime = -99;
      p2.spawnTime = -99;

      // Throw grenade straight down at their feet
      room.onGrenade('p1', { dir: { x: 0, y: -1, z: 0 } });

      // Advance time until grenade explodes (~2.2s fuse)
      room.advanceTimeForTest(2.5, 0.05);

      const surv = room.getSurvivalState()!;
      assert.equal(p1.alive, false);
      assert.equal(p2.alive, false);
      assert.equal(room.phase, 'ended');
      assert.equal(surv.phase, 'ended');
      assert.equal(surv.aliveCount, 0);
      assert.equal(surv.winnerId, null);
      assert.equal(surv.winReason, 'draw_mutual_elimination');
      assert.equal(room.survival!.getRoundDeclareCount(), 1);

      const lastMatchEv = emitted.filter((e) => e.event === 'match').pop()?.payload as MatchState | undefined;
      assert.ok(lastMatchEv);
      assert.equal(lastMatchEv.winner, 'draw');
    } finally {
      room.destroy();
    }
  });

  it('12. Disconnect Victory (opponent_disconnected)', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Disconnect Victory Room',
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
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      room.addHuman(sock1.socket, 'Stayer');
      room.addHuman(sock2.socket, 'Leaver');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });

      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      // Disconnect p2 mid-round
      room.removePlayer('p2');

      const surv = room.getSurvivalState()!;
      assert.equal(room.phase, 'ended');
      assert.equal(surv.phase, 'ended');
      assert.equal(surv.winnerId, 'p1');
      assert.equal(surv.winnerName, 'Stayer');
      assert.equal(surv.winReason, 'opponent_disconnected');
    } finally {
      room.destroy();
    }
  });

  it('13. Timeout Draw (draw_timeout — Never Award Win by Kill Count!)', () => {
    const { io, emitted } = createFakeIo();
    const room = new Room(
      {
        name: 'Timeout Draw Room',
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
      room.setSurvivalConfigForTest({
        minPlayersToStart: 2,
        countdownDurationSec: 2,
        roundDurationSec: 15,
        endedDisplayDurationSec: 5,
      });

      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      const sock3 = createFakeSocket('p3');
      room.addHuman(sock1.socket, 'HighKills');
      room.addHuman(sock2.socket, 'ZeroKills');
      room.addHuman(sock3.socket, 'FallenThird');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.onReady('p3', { world: room.worldMeta() });

      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      room.setSurvivalConfigForTest({ roundDurationSec: 15 });

      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;

      // Have p1 kill p3 so p1 has 1 kill and p2 has 0 kills, while both p1 and p2 remain alive
      armPlayerFromContainer(room, 'p1', 'to_p1');
      eliminateTargetWithGunfire(room, 'p1', 'p3');

      assert.equal(p1.kills, 1);
      assert.equal(p2.kills, 0);
      assert.equal(p1.alive, true);
      assert.equal(p2.alive, true);
      assert.equal(room.getSurvivalState()!.aliveCount, 2);
      assert.equal(room.phase, 'playing');

      // Advance time past the 15s round timer with both p1 and p2 still alive
      room.advanceTimeForTest(16.0, 0.5);

      const surv = room.getSurvivalState()!;
      assert.equal(room.phase, 'ended');
      assert.equal(surv.phase, 'ended');
      assert.equal(
        surv.winnerId,
        null,
        'Timeout with >=2 alive players must NEVER award victory by kill count',
      );
      assert.equal(surv.winReason, 'draw_timeout');

      const lastMatchEv = emitted.filter((e) => e.event === 'match').pop()?.payload as MatchState | undefined;
      assert.ok(lastMatchEv);
      assert.equal(lastMatchEv.winner, 'draw');
    } finally {
      room.destroy();
    }
  });

  it('14. Multi-Round Full Reset (roundId = 1 -> 2 -> 3)', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Multi-Round Reset Room',
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
      room.setSurvivalConfigForTest({
        minPlayersToStart: 2,
        countdownDurationSec: 2,
        roundDurationSec: 30,
        endedDisplayDurationSec: 3,
      });

      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      const sock3 = createFakeSocket('p3');
      room.addHuman(sock1.socket, 'One');
      room.addHuman(sock2.socket, 'Two');
      room.addHuman(sock3.socket, 'Three');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.onReady('p3', { world: room.worldMeta() });

      // Start Round 1
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      assert.equal(room.getSurvivalState()!.roundId, 1);

      // Have p4 join mid-Round 1 as spectator
      const sock4 = createFakeSocket('p4');
      room.addHuman(sock4.socket, 'FourMidJoin');
      room.onReady('p4', { world: room.worldMeta() });
      assert.equal(room.survival!.getPlayerRole('p4'), 'spectator');

      // Arm p1, record Round 1 container & item ID, and eliminate p2 & p3 to end Round 1
      const { containerId: r1CntId, weaponItemId: r1WeaponItemId } = armPlayerFromContainer(
        room,
        'p1',
        'r1_win',
      );
      assert.ok(r1WeaponItemId.includes(':r1:'));
      eliminateTargetWithGunfire(room, 'p1', 'p2');
      eliminateTargetWithGunfire(room, 'p1', 'p3');
      assert.equal(room.phase, 'ended');
      assert.equal(room.getSurvivalState()!.winnerId, 'p1');

      // Advance past endedDisplayDurationSec (3s) -> transitions to Round 2 countdown
      room.advanceTimeForTest(3.5, 0.25);
      assert.equal(room.phase, 'countdown');
      assert.equal(room.getSurvivalState()!.roundId, 2);

      // Advance past countdownDurationSec (2s) -> transitions to Round 2 playing
      room.advanceTimeForTest(2.5, 0.25);
      const survR2 = room.getSurvivalState()!;
      assert.equal(room.phase, 'playing');
      assert.equal(survR2.phase, 'playing');
      assert.equal(survR2.roundId, 2);
      assert.equal(survR2.aliveCount, 4);
      assert.equal(survR2.totalContenders, 4);

      // Verify all 4 players (including eliminated p2/p3 and mid-joiner p4) are active unarmed contenders
      for (const id of ['p1', 'p2', 'p3', 'p4']) {
        const p = room.players.get(id)!;
        const inv = room.loot.getPlayerInventorySnap(id)!;
        assert.equal(p.alive, true, `${id} must be alive in Round 2`);
        assert.equal(p.hp, MAX_HP);
        assert.equal(p.kills, 0, `${id} kills must reset to 0 in Round 2`);
        assert.equal(p.deaths, 0, `${id} deaths must reset to 0 in Round 2`);
        assert.equal(p.weapon, null, `${id} must reset to unarmed in Round 2`);
        assert.equal(p.grenades, 0);
        assert.equal(inv.ownedWeapons.length, 0);
        assert.equal(inv.roundId, 2);
        for (const w of WEAPON_SLOTS) {
          assert.equal(p.ammo[w].mag, 0);
          assert.equal(p.ammo[w].reserve, 0);
        }
        assert.equal(room.survival!.getPlayerRole(id), 'contender');
      }

      // Verify all 26 containers are reset to closed and item IDs are scoped to r2
      const pubSnapR2 = room.loot.getPublicLootSnapshot();
      assert.equal(pubSnapR2.roundId, 2);
      assert.equal(pubSnapR2.containers.length, 26);
      for (const cnt of pubSnapR2.containers) {
        assert.equal(cnt.status, 'closed');
        assert.equal(cnt.opened, false);
        assert.equal(cnt.items.length, 0);
        assert.equal(cnt.itemCount, -1);

        const rawCnt = room.loot.getRawContainerForServerTest(cnt.id)!;
        for (const itemId of rawCnt.items.keys()) {
          assert.ok(
            itemId.startsWith(`itm:${room.id}:r2:c`),
            `Expected Round 2 item ID prefix itm:${room.id}:r2:c, got ${itemId}`,
          );
        }
      }

      // Verify attempting to pick up a Round 1 item ID fails cleanly in Round 2
      const p1 = room.players.get('p1')!;
      const rawR2Cnt = room.loot.getRawContainerForServerTest(r1CntId)!;
      p1.pos = findClearPlayerPosNearContainer(room, rawR2Cnt);

      const closedPickR1 = room.onLootPickup('p1', {
        requestId: 'r2_pick_stale_r1_closed',
        containerId: r1CntId,
        itemId: r1WeaponItemId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(closedPickR1.ok, false);
      assert.equal(closedPickR1.code, 'CONTAINER_CLOSED');

      assert.equal(
        room.onContainerOpen('p1', {
          requestId: 'r2_open_cnt',
          containerId: r1CntId,
          roundId: room.getRoundId(),
          spawnId: p1.spawnId,
        }).ok,
        true,
      );
      const openedPickR1 = room.onLootPickup('p1', {
        requestId: 'r2_pick_stale_r1_opened',
        containerId: r1CntId,
        itemId: r1WeaponItemId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(openedPickR1.ok, false);
      assert.equal(openedPickR1.code, 'ITEM_NOT_FOUND');

      // Complete Round 2 via timeout and transition into Round 3
      room.advanceTimeForTest(31.0, 0.5);
      assert.equal(room.phase, 'ended');
      assert.equal(room.getSurvivalState()!.roundId, 2);

      // Advance past ended (3s) + countdown (2s) -> Round 3 playing
      room.advanceTimeForTest(6.0, 0.25);
      const survR3 = room.getSurvivalState()!;
      assert.equal(room.phase, 'playing');
      assert.equal(survR3.phase, 'playing');
      assert.equal(survR3.roundId, 3);
      assert.equal(survR3.aliveCount, 4);
      assert.equal(survR3.totalContenders, 4);

      const rawR3Cnt = room.loot.getRawContainerForServerTest(r1CntId)!;
      assert.equal(rawR3Cnt.opened, false);
      for (const itemId of rawR3Cnt.items.keys()) {
        assert.ok(
          itemId.startsWith(`itm:${room.id}:r3:c`),
          `Expected Round 3 item ID prefix itm:${room.id}:r3:c, got ${itemId}`,
        );
      }
    } finally {
      room.destroy();
    }
  });

  it('15. SpectatorController Unit Verification (Target Cycling, Auto-Switch on Death, Overview Fallback)', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Spectator World Fixture Room',
        mode: 'forest_survival',
        mapId: 'forest_square',
        bots: 0,
        maxPlayers: 4,
        timeLimit: 3,
        scoreLimit: 1,
        publicLayoutSeed: 6501,
      },
      io,
      () => {},
    );

    try {
      const spec = new SpectatorController();
      assert.equal(spec.isActive(), false);
      spec.setActive(true);
      assert.equal(spec.isActive(), true);

      const targets: SpectatableTarget[] = [
        {
          id: 'p1',
          name: 'Alpha',
          pos: { x: 10, y: 2, z: 10 },
          yaw: 0,
          pitch: 0,
          hp: 100,
          alive: true,
          weapon: 'rifle',
        },
        {
          id: 'p2',
          name: 'Bravo',
          pos: { x: -15, y: 2, z: 20 },
          yaw: Math.PI / 2,
          pitch: -0.1,
          hp: 75,
          alive: true,
          weapon: 'shotgun',
        },
        {
          id: 'p3',
          name: 'Charlie',
          pos: { x: 5, y: 2, z: -25 },
          yaw: -Math.PI / 2,
          pitch: 0.05,
          hp: 50,
          alive: true,
          weapon: null,
        },
      ];

      // 15a) Cycle forward through alive targets
      assert.equal(spec.cycleTarget(1, targets)?.id, 'p1');
      assert.equal(spec.cycleTarget(1, targets)?.id, 'p2');
      assert.equal(spec.cycleTarget(1, targets)?.id, 'p3');
      assert.equal(spec.cycleTarget(1, targets)?.id, 'p1');

      // 15b) Cycle backward through alive targets
      assert.equal(spec.cycleTarget(-1, targets)?.id, 'p3');
      assert.equal(spec.cycleTarget(-1, targets)?.id, 'p2');

      const fallbackPos: Vec3 = { x: 0, y: 2, z: 0 };
      const poseFollowP2 = spec.updateCameraPose(0.016, targets, room.world, true, fallbackPos, 0);
      assert.equal(poseFollowP2.mode, 'follow');
      assert.equal(poseFollowP2.targetId, 'p2');
      assert.equal(poseFollowP2.targetName, 'Bravo');
      assert.equal(poseFollowP2.thirdPerson, true);

      // 15c) Current spectated target (p2) dies -> automatically switches to an alive target
      targets[1]!.alive = false;
      const poseAfterP2Death = spec.updateCameraPose(
        0.016,
        targets,
        room.world,
        false,
        fallbackPos,
        0,
      );
      assert.equal(poseAfterP2Death.mode, 'follow');
      assert.equal(poseAfterP2Death.targetId, 'p1');
      assert.equal(poseAfterP2Death.thirdPerson, false);

      // 15d) All targets die (0 alive) -> switches to overview mode
      targets[0]!.alive = false;
      targets[2]!.alive = false;
      const poseOverview = spec.updateCameraPose(0.5, targets, room.world, true, fallbackPos, 0);
      assert.equal(poseOverview.mode, 'overview');
      assert.equal(poseOverview.targetId, null);
      assert.equal(spec.getTargetId(), null);
      assert.equal(spec.cycleTarget(1, targets), null);

      const diag = spec.getDiagnostics(targets);
      assert.equal(diag.active, true);
      assert.equal(diag.mode, 'overview');
      assert.deepEqual(diag.availableTargetIds, []);

      spec.reset();
      assert.equal(spec.isActive(), false);
      assert.equal(spec.getTargetId(), null);
    } finally {
      room.destroy();
    }
  });

  it("16. O'lgan o'yinchining quroli (joriy o'qlari bilan) yerga tushadi va g'olib uni yerdan oladi", () => {
    const { io, emitted } = createFakeIo();
    const room = new Room(
      {
        name: 'Weapon Drop Room',
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
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      const sock3 = createFakeSocket('p3');
      room.addHuman(sock1.socket, 'Winner');
      room.addHuman(sock2.socket, 'Victim');
      room.addHuman(sock3.socket, 'Bystander');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.onReady('p3', { world: room.worldMeta() });
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      armPlayerFromContainer(room, 'p1', 'drop_p1');
      const victimArm = armPlayerFromContainer(room, 'p2', 'drop_p2');
      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;
      const victimWeapon = p2.weapon;
      assert.ok(victimWeapon, 'qurbon qurollangan bo‘lishi kerak');
      const victimMagBefore = p2.ammo[victimWeapon!].mag;

      assert.equal(room.loot.getPublicLootSnapshot().groundItems.length, 0);
      eliminateTargetWithGunfire(room, 'p1', 'p2');
      assert.equal(p2.alive, false);
      assert.equal(room.phase, 'playing', 'uchinchi o‘yinchi tirik — raund davom etadi');

      const snap = room.loot.getPublicLootSnapshot();
      assert.equal(snap.groundItems.length, 1, 'qurbonning quroli yerga tushishi shart');
      const dropped = snap.groundItems[0]!;
      assert.equal(dropped.kind, 'weapon');
      assert.equal(dropped.weaponId, victimArm.weaponId);
      assert.equal(dropped.containerId, null);
      assert.ok(Math.hypot(dropped.position.x - p2.pos.x, dropped.position.z - p2.pos.z) < 0.01, 'qurol qurbon joyida');
      assert.equal(dropped.initialMag, victimMagBefore, 'joriy magazin saqlanadi');
      assert.ok(
        emitted.some((e) => e.event === 'loot:snapshot'),
        'yangi yer buyumi loot:snapshot bilan e‘lon qilinadi',
      );
      const victimInv = room.loot.getPlayerInventorySnap('p2')!;
      assert.ok(!victimInv.ownedWeapons.includes(victimArm.weaponId), 'qurbonning inventaridan qurol chiqadi');

      // Uzoqdan olib bo'lmaydi
      p1.pos = { x: dropped.position.x + 6, y: dropped.position.y, z: dropped.position.z };
      const far = room.onLootPickup('p1', {
        requestId: 'drop_pick_far',
        containerId: null,
        itemId: dropped.id,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(far.ok, false);
      assert.equal(far.code, 'OUT_OF_RANGE');

      // Yaqin kelib olish
      p1.pos = { x: dropped.position.x + 0.8, y: dropped.position.y, z: dropped.position.z };
      const ownedBefore = room.loot.getPlayerInventorySnap('p1')!.ownedWeapons.includes(victimArm.weaponId);
      const near = room.onLootPickup('p1', {
        requestId: 'drop_pick_near',
        containerId: null,
        itemId: dropped.id,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      if (ownedBefore) {
        assert.ok(near.ok || near.code === 'WEAPON_ALREADY_OWNED', `ack=${JSON.stringify(near.code)}`);
      } else {
        assert.equal(near.ok, true, `yerdan olish muvaffaqiyatli bo‘lishi shart: ${near.code} ${near.message}`);
        assert.ok(room.loot.getPlayerInventorySnap('p1')!.ownedWeapons.includes(victimArm.weaponId));
        assert.equal(room.loot.getPublicLootSnapshot().groundItems.length, 0, 'olingan buyum yerdan yo‘qoladi');
        // Idempotent takror
        const replay = room.onLootPickup('p1', {
          requestId: 'drop_pick_near',
          containerId: null,
          itemId: dropped.id,
          roundId: room.getRoundId(),
          spawnId: p1.spawnId,
        });
        assert.equal(replay.ok, true);
        assert.equal(replay.idempotentReplay, true);
      }
    } finally {
      room.destroy();
    }
  });

  it("17. Zirh nimcha tana zararini, kaska bosh zararini kamaytiradi; ikkinchi nimcha ARMOR_FULL", () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Armor Room',
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
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      room.addHuman(sock1.socket, 'Shooter');
      room.addHuman(sock2.socket, 'Tank');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      armPlayerFromContainer(room, 'p1', 'arm_p1');
      const shooter = room.players.get('p1')!;
      const tank = room.players.get('p2')!;

      // Berilgan turdagi jihozni (nimcha/kaska) biror konteynerdan olishga urinadi va ack qaytaradi
      const usedContainers = new Set<string>();
      const pickGear = (kind: 'armor' | 'helmet', reqPrefix: string) => {
        for (const cntId of room.loot.getAuthoritativeContainerIds()) {
          if (usedContainers.has(cntId)) continue;
          const raw = room.loot.getRawContainerForServerTest(cntId)!;
          const gear = [...raw.items.values()].find((it) => it.kind === kind);
          if (!gear) continue;
          usedContainers.add(cntId);
          tank.pos = findClearPlayerPosNearContainer(room, raw);
          const openAck = room.onContainerOpen('p2', {
            requestId: `${reqPrefix}_open`,
            containerId: cntId,
            roundId: room.getRoundId(),
            spawnId: tank.spawnId,
          });
          assert.equal(openAck.ok, true, `open ${cntId}: ${openAck.code}`);
          return room.onLootPickup('p2', {
            requestId: `${reqPrefix}_pick`,
            containerId: cntId,
            itemId: gear.id,
            roundId: room.getRoundId(),
            spawnId: tank.spawnId,
          });
        }
        assert.fail(`${kind} buyumi hech bir konteynerda topilmadi`);
      };

      const vestAck = pickGear('armor', 'vest');
      assert.equal(vestAck.ok, true, `nimcha olish: ${vestAck.code} ${vestAck.message}`);
      assert.equal(tank.armor, 100, 'nimcha olingach armor 100');
      const inv = room.loot.getPlayerInventorySnap('p2')!;
      assert.equal(inv.armor, 100);
      assert.ok(inv.items.some((it) => it.catalogId === 'gear:vest'), 'inventar snapshotida nimcha ko‘rinadi');

      // Ikkinchi nimcha olib bo'lmaydi
      const dup = pickGear('armor', 'vest_dup');
      assert.equal(dup.ok, false);
      assert.equal(dup.code, 'ARMOR_FULL');

      const helmAck = pickGear('helmet', 'helm');
      assert.equal(helmAck.ok, true, `kaska olish: ${helmAck.code} ${helmAck.message}`);
      assert.equal(tank.helmet, 100, 'kaska olingach helmet 100');

      // Otishma sahnasi: tana va bosh
      const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
      const sx = serviceSite.center.x - 6;
      const sz = serviceSite.center.z + 6;
      shooter.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz), z: sz };
      tank.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz - 3.5), z: sz - 3.5 };
      shooter.spawnTime = -99;
      tank.spawnTime = -99;
      const wDef = WEAPONS[shooter.weapon!];
      const shootAt = (targetY: number) => {
        const eye: Vec3 = { x: shooter.pos.x, y: shooter.pos.y + EYE_HEIGHT, z: shooter.pos.z };
        const aim: Vec3 = { x: tank.pos.x, y: tank.pos.y + targetY, z: tank.pos.z };
        const dir = vnorm(vsub(aim, eye));
        shooter.yaw = Math.atan2(-dir.x, -dir.z);
        shooter.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
        shooter.lastShot = -99;
        shooter.ammo[wDef.id].mag = wDef.magSize;
        room.onShoot('p1', { weapon: wDef.id, origin: eye, dirs: Array.from({ length: wDef.pellets }, () => dir) });
      };

      tank.hp = MAX_HP;
      const hp0 = tank.hp;
      shootAt(1.0); // tana
      assert.ok(tank.alive, "tana otishmasidan keyin tirik qolishi kerak");
      const bodyLoss = hp0 - tank.hp;
      assert.ok(bodyLoss > 0, 'tana otishmasi zarar yetkazishi kerak');
      assert.ok(tank.armor < 100, `nimcha yemirilishi kerak (armor=${tank.armor})`);
      assert.equal(tank.helmet, 100, 'tana otishmasi kaskaga tegmaydi');
      const absorbedBody = 100 - tank.armor;
      assert.ok(
        Math.abs(absorbedBody - Math.round((bodyLoss + absorbedBody) * 0.4)) <= 1,
        `tana zararining ~40% yutilishi kerak (loss=${bodyLoss}, absorbed=${absorbedBody})`,
      );

      // Bosh otishmasi: kaska xom zararning 50% ini (ko'pi bilan mustahkamligi qadar) yutadi.
      // Snayper boshga 212 beradi — kaska 100 ni yutsa ham 112 qoladi, o'yinchi o'lishi mumkin (dizayn bo'yicha).
      tank.hp = MAX_HP;
      const hp1 = tank.hp;
      const helmetBefore = tank.helmet;
      const eyeH: Vec3 = { x: shooter.pos.x, y: shooter.pos.y + EYE_HEIGHT, z: shooter.pos.z };
      const headAim: Vec3 = { x: tank.pos.x, y: tank.pos.y + 1.5, z: tank.pos.z };
      const rawHead = damageAt(wDef, vdist(eyeH, headAim), 'head');
      shootAt(1.5); // bosh
      const headLoss = hp1 - Math.max(0, tank.hp);
      assert.ok(headLoss > 0, 'bosh otishmasi zarar yetkazishi kerak');
      const absorbedHead = helmetBefore - tank.helmet;
      const expectedAbsorb = Math.min(helmetBefore, Math.round(rawHead * 0.5));
      assert.ok(
        Math.abs(absorbedHead - expectedAbsorb) <= 1,
        `kaska ${expectedAbsorb} yutishi kerak (absorbed=${absorbedHead})`,
      );
      assert.ok(
        Math.abs(headLoss - Math.min(MAX_HP, rawHead - absorbedHead)) <= 1,
        `bosh zarari ${rawHead - absorbedHead} bo'lishi kerak (loss=${headLoss})`,
      );
      assert.equal(tank.armor, 100 - absorbedBody, 'bosh otishmasi nimchaga tegmaydi');
    } finally {
      room.destroy();
    }
  });
});
