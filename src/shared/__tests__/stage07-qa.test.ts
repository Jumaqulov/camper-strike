import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import {
  executeGrenadeTickBatch,
  isValidGrenadeRecord,
  SERVER_SWITCH_TIME_TOLERANCE,
  stepAndPartitionGrenades,
  type ServerGrenadeRecord,
} from '../../server/combat';
import { Room } from '../../server/room';
import { EYE_HEIGHT, MAX_HP } from '../constants';
import { getForestSquarePoiSites } from '../forestSquare';
import { hasLineOfSightToContainer } from '../loot';
import { vdist, vnorm, vsub, type Vec3 } from '../math';
import type { MatchState } from '../protocol';
import { WEAPONS, type WeaponId } from '../weapons';
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
  preferredWeapon?: WeaponId,
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
      if (
        item.kind === 'weapon' &&
        item.weaponId &&
        (!preferredWeapon || item.weaponId === preferredWeapon)
      ) {
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
  shooter.switchUntil = 0;

  const wDef = WEAPONS[shooter.weapon];
  for (let guard = 0; guard < 25 && victim.alive; guard++) {
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

function getRoomGrenades(room: Room): ServerGrenadeRecord[] {
  return (room as unknown as { grenades: ServerGrenadeRecord[] }).grenades;
}

describe('STAGE 07-QA — Forest Survival Stabilization & Adversarial Audit Suite', () => {
  it('1. P0.1 — Double & Multi-Grenade Same-Tick Round-End Crash Prevention (Room.updateGrenades)', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'P0.1 Double Grenade Crash Prevention Room',
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
      room.addHuman(sock1.socket, 'ThrowerOne');
      room.addHuman(sock2.socket, 'LowHpTwo');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });

      // Advance past countdown into playing phase
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;

      const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
      const p2x = serviceSite.center.x - 6;
      const p2z = serviceSite.center.z + 6;
      const p2y = sampleTerrainHeight(room.world.terrain, p2x, p2z);

      // Place p1 at safe distance (20m away) with 100 HP, and p2 at low HP (30 HP)
      const p1x = p2x + 20;
      const p1z = p2z;
      const p1y = sampleTerrainHeight(room.world.terrain, p1x, p1z);

      p1.pos = { x: p1x, y: p1y, z: p1z };
      p2.pos = { x: p2x, y: p2y, z: p2z };
      p1.vel = { x: 0, y: 0, z: 0 };
      p2.vel = { x: 0, y: 0, z: 0 };
      p1.hp = 100;
      p2.hp = 30;
      p1.spawnTime = -99;
      p2.spawnTime = -99;

      // Give p1 2 grenades and throw both, then align their detonation timestamps to the same tick
      p1.grenades = 2;
      p1.lastGrenade = -10;
      room.onGrenade('p1', { dir: { x: -1, y: 0, z: 0 } });
      p1.lastGrenade = -10;
      room.onGrenade('p1', { dir: { x: -1, y: 0, z: 0 } });

      const activeGrenades = getRoomGrenades(room);
      assert.equal(activeGrenades.length, 2, 'Room must have 2 active grenades before explosion tick');

      const targetExplodeTime = room.now() + 0.04;
      // Place both grenades right next to p2 so the first explosion kills p2 while the second is in the same batch
      activeGrenades[0]!.pos = { x: p2x + 0.2, y: p2y + 0.2, z: p2z };
      activeGrenades[0]!.vel = { x: 0, y: 0, z: 0 };
      activeGrenades[0]!.explodeAt = targetExplodeTime;

      activeGrenades[1]!.pos = { x: p2x - 0.2, y: p2y + 0.2, z: p2z };
      activeGrenades[1]!.vel = { x: 0, y: 0, z: 0 };
      activeGrenades[1]!.explodeAt = targetExplodeTime;

      // Step across the explosion tick — MUST NOT throw TypeError: Cannot read properties of undefined (reading 'vel')
      assert.doesNotThrow(() => {
        room.advanceTimeForTest(0.1, 0.05);
      });

      const surv = room.getSurvivalState()!;
      assert.equal(room.phase, 'ended');
      assert.equal(surv.phase, 'ended');
      assert.equal(surv.winnerId, 'p1');
      assert.equal(surv.winReason, 'last_standing');
      assert.equal(p1.alive, true);
      assert.equal(p2.alive, false);
      assert.equal(getRoomGrenades(room).length, 0, 'All grenades must be cleared on round end');

      // Also verify the exact reverse-index audit case: g[0] has fuse in future, g[1] explodes now and ends round
      let externalGrenades: ServerGrenadeRecord[] = [
        {
          id: 1,
          owner: 'p1',
          pos: { x: p2x, y: p2y + 0.5, z: p2z },
          vel: { x: 1, y: 2, z: 0 },
          explodeAt: 100, // still in flight when g#2 explodes
        },
        {
          id: 2,
          owner: 'p1',
          pos: { x: p2x, y: p2y + 0.5, z: p2z },
          vel: { x: 0, y: 0, z: 0 },
          explodeAt: 10, // explodes on tick t = 10
        },
      ];
      let simPhase = 'playing';
      assert.doesNotThrow(() => {
        const summary = executeGrenadeTickBatch({
          getGrenades: () => externalGrenades,
          setGrenades: (next) => {
            externalGrenades = next;
          },
          getPhase: () => simPhase,
          dt: 1 / 30,
          nowSec: 10,
          world: room.world,
          explodeOne: () => {
            // Simulate round end clearing grenades mid-batch
            externalGrenades = [];
            simPhase = 'ended';
          },
          onBatchComplete: () => {
            simPhase = 'ended';
          },
        });
        assert.equal(summary.steppedCount, 2);
        assert.equal(summary.explodedCount, 1);
        assert.equal(summary.remainingCount, 0);
      });
      assert.equal(externalGrenades.length, 0);
      assert.equal(isValidGrenadeRecord(undefined), false);
      assert.equal(
        stepAndPartitionGrenades([undefined as unknown as ServerGrenadeRecord], 1 / 30, 10, room.world, 'playing')
          .exploding.length,
        0,
      );
    } finally {
      room.destroy();
    }
  });

  it('2. P0.2 — Simultaneous Multi-Grenade Mutual Elimination & 3-Player Batch Resolution', () => {
    // 2a) 2 contenders separated by 20m: Grenade 1 kills p2, Grenade 2 kills p1 in the exact same tick -> draw_mutual_elimination
    {
      const { io, emitted } = createFakeIo();
      const room = new Room(
        {
          name: 'P0.2 Mutual Elimination Batch Room',
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
        room.addHuman(sock1.socket, 'NorthGrenadier');
        room.addHuman(sock2.socket, 'SouthGrenadier');
        room.onReady('p1', { world: room.worldMeta() });
        room.onReady('p2', { world: room.worldMeta() });

        room.advanceTimeForTest(2.5, 0.25);
        assert.equal(room.phase, 'playing');

        const p1 = room.players.get('p1')!;
        const p2 = room.players.get('p2')!;

        const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
        const p1x = serviceSite.center.x - 10;
        const p1z = serviceSite.center.z + 6;
        const p1y = sampleTerrainHeight(room.world.terrain, p1x, p1z);

        // Separate p1 and p2 by 20m (> 2 * GRENADE_RADIUS = 14m) so each grenade only damages one player
        const p2x = p1x + 20;
        const p2z = p1z;
        const p2y = sampleTerrainHeight(room.world.terrain, p2x, p2z);

        p1.pos = { x: p1x, y: p1y, z: p1z };
        p2.pos = { x: p2x, y: p2y, z: p2z };
        assert.ok(vdist(p1.pos, p2.pos) >= 19.5, 'Players must be separated by ~20m');

        p1.vel = { x: 0, y: 0, z: 0 };
        p2.vel = { x: 0, y: 0, z: 0 };
        p1.hp = 40;
        p2.hp = 40;
        p1.spawnTime = -99;
        p2.spawnTime = -99;

        p1.grenades = 1;
        p2.grenades = 1;
        p1.lastGrenade = -10;
        p2.lastGrenade = -10;

        room.onGrenade('p1', { dir: { x: 1, y: 0, z: 0 } });
        room.onGrenade('p2', { dir: { x: -1, y: 0, z: 0 } });

        const activeGrenades = getRoomGrenades(room);
        assert.equal(activeGrenades.length, 2);

        const explodeTickTime = room.now() + 0.03;
        // Grenade 0 (thrown by p1) lands at p2's feet and explodes first in the batch
        activeGrenades[0]!.pos = { x: p2x, y: p2y + 0.15, z: p2z };
        activeGrenades[0]!.vel = { x: 0, y: 0, z: 0 };
        activeGrenades[0]!.explodeAt = explodeTickTime;

        // Grenade 1 (thrown by p2) lands at p1's feet and explodes in the exact same tick batch
        activeGrenades[1]!.pos = { x: p1x, y: p1y + 0.15, z: p1z };
        activeGrenades[1]!.vel = { x: 0, y: 0, z: 0 };
        activeGrenades[1]!.explodeAt = explodeTickTime;

        room.advanceTimeForTest(0.05, 0.05);

        const surv = room.getSurvivalState()!;
        assert.equal(p1.alive, false, 'p1 must be eliminated by grenade 2 in the same tick');
        assert.equal(p2.alive, false, 'p2 must be eliminated by grenade 1 in the same tick');
        assert.equal(room.phase, 'ended');
        assert.equal(surv.phase, 'ended');
        assert.equal(surv.aliveCount, 0);
        assert.equal(
          surv.winnerId,
          null,
          'Deferred batch checkWin must see 0 alive contenders and declare draw, NOT premature last_standing',
        );
        assert.equal(surv.winReason, 'draw_mutual_elimination');
        assert.equal(room.survival!.getRoundDeclareCount(), 1);
        assert.equal(getRoomGrenades(room).length, 0);

        const lastMatchEv = emitted.filter((e) => e.event === 'match').pop()?.payload as MatchState | undefined;
        assert.ok(lastMatchEv);
        assert.equal(lastMatchEv.winner, 'draw');
        assert.equal(lastMatchEv.winnerId, null);
        assert.equal(lastMatchEv.winReason, 'draw_mutual_elimination');
      } finally {
        room.destroy();
      }
    }

    // 2b) 3 contenders (p1, p2, p3) with 3 grenades in the same tick where p2 & p3 die and p1 survives,
    // plus a 4th grenade with explodeAt = t + 0.5 that must be cleared when Round 1 ends so it never carries into Round 2
    {
      const { io } = createFakeIo();
      const room = new Room(
        {
          name: 'P0.2 Three Contender Multi-Grenade Room',
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
          roundDurationSec: 60,
          endedDisplayDurationSec: 2,
        });

        const sock1 = createFakeSocket('p1');
        const sock2 = createFakeSocket('p2');
        const sock3 = createFakeSocket('p3');
        room.addHuman(sock1.socket, 'SurvivorP1');
        room.addHuman(sock2.socket, 'BlastVictimP2');
        room.addHuman(sock3.socket, 'BlastVictimP3');
        room.onReady('p1', { world: room.worldMeta() });
        room.onReady('p2', { world: room.worldMeta() });
        room.onReady('p3', { world: room.worldMeta() });

        room.advanceTimeForTest(2.5, 0.25);
        assert.equal(room.phase, 'playing');

        const p1 = room.players.get('p1')!;
        const p2 = room.players.get('p2')!;
        const p3 = room.players.get('p3')!;

        const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
        const baseX = serviceSite.center.x - 10;
        const baseZ = serviceSite.center.z + 6;

        p1.pos = { x: baseX - 20, y: sampleTerrainHeight(room.world.terrain, baseX - 20, baseZ), z: baseZ };
        p2.pos = { x: baseX, y: sampleTerrainHeight(room.world.terrain, baseX, baseZ), z: baseZ };
        p3.pos = { x: baseX + 20, y: sampleTerrainHeight(room.world.terrain, baseX + 20, baseZ), z: baseZ };
        p1.hp = 100;
        p2.hp = 40;
        p3.hp = 40;
        p1.spawnTime = -99;
        p2.spawnTime = -99;
        p3.spawnTime = -99;

        const now = room.now();
        const grenades = getRoomGrenades(room);
        grenades.push(
          {
            id: 101,
            owner: 'p1',
            pos: { x: p2.pos.x, y: p2.pos.y + 0.15, z: p2.pos.z },
            vel: { x: 0, y: 0, z: 0 },
            explodeAt: now + 0.02,
          },
          {
            id: 102,
            owner: 'p2',
            pos: { x: p3.pos.x, y: p3.pos.y + 0.15, z: p3.pos.z },
            vel: { x: 0, y: 0, z: 0 },
            explodeAt: now + 0.02,
          },
          {
            id: 103,
            owner: 'p3',
            pos: { x: p2.pos.x + 0.3, y: p2.pos.y + 0.15, z: p2.pos.z },
            vel: { x: 0, y: 0, z: 0 },
            explodeAt: now + 0.02,
          },
          {
            id: 104,
            owner: 'p1',
            pos: { x: p1.pos.x, y: p1.pos.y + 0.15, z: p1.pos.z },
            vel: { x: 0, y: 0, z: 0 },
            explodeAt: now + 0.5, // Next-tick fuse that must be wiped on round end!
          },
        );

        room.advanceTimeForTest(0.05, 0.05);

        const surv = room.getSurvivalState()!;
        assert.equal(p1.alive, true);
        assert.equal(p2.alive, false);
        assert.equal(p3.alive, false);
        assert.equal(room.phase, 'ended');
        assert.equal(surv.winnerId, 'p1');
        assert.equal(surv.winReason, 'last_standing');
        assert.equal(
          getRoomGrenades(room).length,
          0,
          'Delayed grenade (explodeAt = t + 0.5) must be cleared when Round 1 ends',
        );

        // Advance past ended (2s) + countdown (2s) into Round 2 and ensure p1 takes 0 leftover grenade damage
        room.advanceTimeForTest(4.5, 0.25);
        assert.equal(room.phase, 'playing');
        assert.equal(room.getRoundId(), 2);
        assert.equal(getRoomGrenades(room).length, 0);
        assert.equal(p1.hp, MAX_HP);
      } finally {
        room.destroy();
      }
    }
  });

  it('3. P1.1 — Mandatory roundId & spawnId Context on All Survival/Loot Requests', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'P1.1 Mandatory Round & Spawn Context Room',
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
        endedDisplayDurationSec: 2,
      });

      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      room.addHuman(sock1.socket, 'ContextTester');
      room.addHuman(sock2.socket, 'ContextPartner');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });

      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      assert.equal(room.getRoundId(), 1);

      const p1 = room.players.get('p1')!;
      const p1Round1SpawnId = p1.spawnId;

      const containerId = 'poi:poi_ranger_house:cnt_0:wooden_loot_crate_01';
      const rawCnt = room.loot.getRawContainerForServerTest(containerId)!;
      const anyItemId = [...rawCnt.items.keys()][0]!;
      p1.pos = findClearPlayerPosNearContainer(room, rawCnt);

      // 3a) Reproduce audit scenario: contextless onContainerOpen in forest_survival must be rejected
      const missingCtxOpen = room.onContainerOpen('p1', {
        requestId: 'missing_ctx_open',
        containerId,
      });
      assert.equal(missingCtxOpen.ok, false);
      assert.equal(missingCtxOpen.code, 'INVALID_REQUEST');
      assert.equal(room.loot.getPublicContainerState(containerId)!.opened, false);
      assert.ok(room.loot.getStats().rejectedStaleRoundOrSpawn >= 1);

      // 3b) Test all invalid/missing/null/old/future roundId & spawnId combinations across all 4 endpoints
      const invalidContexts: Array<{ label: string; ctx: Record<string, unknown> }> = [
        { label: 'missing both', ctx: {} },
        { label: 'missing roundId only', ctx: { spawnId: p1Round1SpawnId } },
        { label: 'missing spawnId only', ctx: { roundId: 1 } },
        { label: 'roundId: null', ctx: { roundId: null, spawnId: p1Round1SpawnId } },
        { label: 'spawnId: null', ctx: { roundId: 1, spawnId: null } },
        { label: 'spawnId: 0', ctx: { roundId: 1, spawnId: 0 } },
        { label: 'roundId: -1', ctx: { roundId: -1, spawnId: p1Round1SpawnId } },
        { label: 'future roundId: 999', ctx: { roundId: 999, spawnId: p1Round1SpawnId } },
        { label: 'future spawnId: 999', ctx: { roundId: 1, spawnId: 999 } },
      ];

      p1.hp = 60;
      for (let i = 0; i < invalidContexts.length; i++) {
        const { label, ctx } = invalidContexts[i]!;

        const openAck = room.onContainerOpen('p1', {
          requestId: `bad_open_${i}`,
          containerId,
          ...ctx,
        });
        assert.equal(openAck.ok, false, `onContainerOpen must reject (${label})`);
        assert.equal(openAck.code, 'INVALID_REQUEST', `onContainerOpen code for (${label})`);

        const pickAck = room.onLootPickup('p1', {
          requestId: `bad_pick_${i}`,
          containerId,
          itemId: anyItemId,
          ...ctx,
        });
        assert.equal(pickAck.ok, false, `onLootPickup must reject (${label})`);
        assert.equal(pickAck.code, 'INVALID_REQUEST', `onLootPickup code for (${label})`);

        const equipAck = room.onEquipWeapon('p1', {
          requestId: `bad_equip_${i}`,
          weapon: null,
          ...ctx,
        });
        assert.equal(equipAck.ok, false, `onEquipWeapon must reject (${label})`);
        assert.equal(equipAck.code, 'INVALID_REQUEST', `onEquipWeapon code for (${label})`);

        const medAck = room.onUseMedkit('p1', {
          requestId: `bad_med_${i}`,
          ...ctx,
        });
        assert.equal(medAck.ok, false, `onUseMedkit must reject (${label})`);
        assert.equal(medAck.code, 'INVALID_REQUEST', `onUseMedkit code for (${label})`);
      }

      assert.equal(
        room.loot.getPublicContainerState(containerId)!.opened,
        false,
        'Container must still be closed after all invalid context attempts',
      );

      // 3c) Complete Round 1 and transition into Round 2 (roundId = 2)
      armPlayerFromContainer(room, 'p1', 'r1_finish');
      eliminateTargetWithGunfire(room, 'p1', 'p2');
      assert.equal(room.phase, 'ended');

      // Advance through ended (2s) + countdown (2s) -> Round 2 playing
      room.advanceTimeForTest(4.5, 0.25);
      assert.equal(room.phase, 'playing');
      assert.equal(room.getRoundId(), 2);
      assert.notEqual(p1.spawnId, p1Round1SpawnId);

      const rawCntR2 = room.loot.getRawContainerForServerTest(containerId)!;
      assert.equal(rawCntR2.opened, false);
      p1.pos = findClearPlayerPosNearContainer(room, rawCntR2);

      // Delayed Round 1 request with old roundId & old spawnId must be rejected in Round 2
      const delayedR1Ack = room.onContainerOpen('p1', {
        requestId: 'old_r1_req',
        containerId,
        roundId: 1,
        spawnId: p1Round1SpawnId,
      });
      assert.equal(delayedR1Ack.ok, false);
      assert.equal(delayedR1Ack.code, 'INVALID_REQUEST');
      assert.equal(room.loot.getPublicContainerState(containerId)!.opened, false);

      // Contextless request in Round 2 must also be rejected
      const noCtxR2Ack = room.onContainerOpen('p1', {
        requestId: 'old_r1_no_ctx',
        containerId,
      });
      assert.equal(noCtxR2Ack.ok, false);
      assert.equal(noCtxR2Ack.code, 'INVALID_REQUEST');
      assert.equal(room.loot.getPublicContainerState(containerId)!.opened, false);

      // Valid Round 2 request with roundId: 2 and current p1.spawnId succeeds
      const freshR2Ack = room.onContainerOpen('p1', {
        requestId: 'fresh_r2_req',
        containerId,
        roundId: 2,
        spawnId: p1.spawnId,
      });
      assert.equal(freshR2Ack.ok, true);
      assert.equal(freshR2Ack.roundId, 2);
      assert.equal(freshR2Ack.spawnId, p1.spawnId);
      assert.equal(room.loot.getPublicContainerState(containerId)!.opened, true);
    } finally {
      room.destroy();
    }
  });

  it('4. P1.2 — Close shoot Weapon Equip & Switch Cooldown Bypass (FFA, TDM, and Forest Survival)', () => {
    // 4a) Classic FFA (lootPreview: false) — unequipped shot rejection + switchTime cooldown enforcement
    {
      const { io } = createFakeIo();
      const room = new Room(
        {
          name: 'P1.2 Classic FFA Shoot Bypass Room',
          mode: 'ffa',
          mapId: 'forest_square',
          bots: 0,
          maxPlayers: 8,
          timeLimit: 10,
          scoreLimit: 25,
          publicLayoutSeed: 6501,
          lootPreview: false,
        },
        io,
        () => {},
      );

      try {
        const sock1 = createFakeSocket('p1');
        const sock2 = createFakeSocket('p2');
        room.addHuman(sock1.socket, 'ShooterFFA');
        room.addHuman(sock2.socket, 'TargetFFA');
        room.onReady('p1', { world: room.worldMeta() });
        room.onReady('p2', { world: room.worldMeta() });

        const p1 = room.players.get('p1')!;
        const p2 = room.players.get('p2')!;
        assert.equal(p1.weapon, 'rifle');
        assert.equal(p1.ammo.pistol.mag, WEAPONS.pistol.magSize);

        // Position p1 and p2 in clear line of sight
        const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
        const sx = serviceSite.center.x - 6;
        const sz = serviceSite.center.z + 6;
        const vx = sx;
        const vz = sz - 4;

        p1.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz), z: sz };
        p2.pos = { x: vx, y: sampleTerrainHeight(room.world.terrain, vx, vz), z: vz };
        p1.spawnTime = -99;
        p2.spawnTime = -99;

        const p1Eye: Vec3 = { x: p1.pos.x, y: p1.pos.y + EYE_HEIGHT, z: p1.pos.z };
        const p2Chest: Vec3 = { x: p2.pos.x, y: p2.pos.y + 1.1, z: p2.pos.z };
        const dirToP2 = vnorm(vsub(p2Chest, p1Eye));
        p1.yaw = Math.atan2(-dirToP2.x, -dirToP2.z);
        p1.pitch = Math.asin(Math.max(-1, Math.min(1, dirToP2.y)));

        // Without equipping 'pistol', p1 sends onShoot with weapon: 'pistol'
        room.onShoot('p1', {
          weapon: 'pistol',
          origin: p1Eye,
          dirs: [dirToP2],
        });

        assert.equal(p2.hp, MAX_HP, 'Unequipped pistol shot must be rejected');
        assert.equal(p1.weapon, 'rifle', 'Server must NEVER mutate p1.weapon inside onShoot');
        assert.equal(p1.ammo.pistol.mag, WEAPONS.pistol.magSize, 'Pistol magazine must remain 12');
        assert.ok(room.getCombatSecurityStats().rejectedUnequippedWeaponShots >= 1);

        // Now legitimately equip 'pistol' via onEquipWeapon
        const eqAck = room.onEquipWeapon('p1', {
          requestId: 'eq_pistol_1',
          weapon: 'pistol',
        });
        assert.equal(eqAck.ok, true);
        assert.equal(p1.weapon, 'pistol');
        assert.ok(
          p1.switchUntil > room.now(),
          `Expected p1.switchUntil (${p1.switchUntil}) > room.now() (${room.now()})`,
        );

        // Advance only 0.01s (< WEAPONS.pistol.switchTime * 0.75 = 0.2625s) and attempt to shoot
        room.advanceTimeForTest(0.01, 0.01);
        p1.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz), z: sz };
        p2.pos = { x: vx, y: sampleTerrainHeight(room.world.terrain, vx, vz), z: vz };

        room.onShoot('p1', {
          weapon: 'pistol',
          origin: p1Eye,
          dirs: [dirToP2],
        });

        assert.equal(p2.hp, MAX_HP, 'Shot during active switchTime cooldown must be rejected');
        assert.equal(p1.ammo.pistol.mag, WEAPONS.pistol.magSize);
        assert.ok(room.getCombatSecurityStats().rejectedSwitchCooldownShots >= 1);

        // Advance past WEAPONS.pistol.switchTime and fire again -> must hit p2 and decrement mag to 11
        room.advanceTimeForTest(WEAPONS.pistol.switchTime + 0.05, 0.05);
        p1.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz), z: sz };
        p2.pos = { x: vx, y: sampleTerrainHeight(room.world.terrain, vx, vz), z: vz };

        room.onShoot('p1', {
          weapon: 'pistol',
          origin: p1Eye,
          dirs: [dirToP2],
        });

        assert.ok(p2.hp < MAX_HP, `Expected p2.hp < ${MAX_HP} after switch cooldown elapsed, got ${p2.hp}`);
        assert.equal(p1.ammo.pistol.mag, WEAPONS.pistol.magSize - 1);

        // Also verify switching weapon via authoritative movement input packet (onInput) enforces switchUntil cooldown
        const hpBeforeShotgun = p2.hp;
        room.onInput('p1', {
          seq: 1,
          spawnId: p1.spawnId,
          dt: 1 / 30,
          moveForward: 0,
          moveRight: 0,
          jump: false,
          walk: false,
          scoped: false,
          weapon: 'shotgun',
          yaw: p1.yaw,
          pitch: p1.pitch,
        });
        room.advanceTimeForTest(1 / 30, 1 / 30);
        assert.equal(p1.weapon, 'shotgun');
        assert.ok(p1.switchUntil > room.now(), 'Switching weapon via onInput must set switchUntil cooldown');

        const shotgunDirs = Array.from({ length: WEAPONS.shotgun.pellets }, () => dirToP2);
        room.onShoot('p1', {
          weapon: 'shotgun',
          origin: p1Eye,
          dirs: shotgunDirs,
        });
        assert.equal(p2.hp, hpBeforeShotgun, 'Immediate shotgun shot after onInput weapon switch must be rejected');
        assert.equal(p1.ammo.shotgun.mag, WEAPONS.shotgun.magSize);
      } finally {
        room.destroy();
      }
    }

    // 4b) Classic TDM — rapid rifle -> sniper switch macro blocked during switchTime
    {
      const { io } = createFakeIo();
      const room = new Room(
        {
          name: 'P1.2 Classic TDM Switch Cooldown Room',
          mode: 'tdm',
          mapId: 'forest_square',
          bots: 0,
          maxPlayers: 8,
          timeLimit: 10,
          scoreLimit: 25,
          publicLayoutSeed: 6501,
          lootPreview: false,
        },
        io,
        () => {},
      );

      try {
        const sock1 = createFakeSocket('p1');
        const sock2 = createFakeSocket('p2');
        room.addHuman(sock1.socket, 'RedSniper');
        room.addHuman(sock2.socket, 'BlueTarget');
        room.onReady('p1', { world: room.worldMeta() });
        room.onReady('p2', { world: room.worldMeta() });

        const p1 = room.players.get('p1')!;
        const p2 = room.players.get('p2')!;
        if (p1.team === p2.team) {
          room.onSwitchTeam('p2');
          room.advanceTimeForTest(1.2, 0.2);
        }

        const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
        const sx = serviceSite.center.x - 6;
        const sz = serviceSite.center.z + 6;
        const vx = sx;
        const vz = sz - 4;

        p1.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz), z: sz };
        p2.pos = { x: vx, y: sampleTerrainHeight(room.world.terrain, vx, vz), z: vz };
        p1.spawnTime = -99;
        p2.spawnTime = -99;

        const p1Eye: Vec3 = { x: p1.pos.x, y: p1.pos.y + EYE_HEIGHT, z: p1.pos.z };
        const p2Chest: Vec3 = { x: p2.pos.x, y: p2.pos.y + 1.1, z: p2.pos.z };
        const dirToP2 = vnorm(vsub(p2Chest, p1Eye));
        p1.yaw = Math.atan2(-dirToP2.x, -dirToP2.z);
        p1.pitch = Math.asin(Math.max(-1, Math.min(1, dirToP2.y)));

        // Switch from rifle to sniper via movement input packet and immediately try to fire on same tick
        room.onEquipWeapon('p1', { requestId: 'tdm_eq_sniper', weapon: 'sniper' });
        assert.equal(p1.weapon, 'sniper');
        assert.ok(
          p1.switchUntil >= room.now() + WEAPONS.sniper.switchTime * SERVER_SWITCH_TIME_TOLERANCE - 1e-4,
        );

        room.onShoot('p1', {
          weapon: 'sniper',
          origin: p1Eye,
          dirs: [dirToP2],
        });
        assert.equal(p2.hp, MAX_HP, 'Immediate sniper shot after switch must be blocked in TDM');
        assert.equal(p1.ammo.sniper.mag, WEAPONS.sniper.magSize);
      } finally {
        room.destroy();
      }
    }

    // 4c) Forest Survival — first auto-equipped weapon fires immediately, second looted weapon requires equip + switchTime
    {
      const { io } = createFakeIo();
      const room = new Room(
        {
          name: 'P1.2 Survival Weapon Switch Cooldown Room',
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
        room.addHuman(sock1.socket, 'SurvivalShooter');
        room.addHuman(sock2.socket, 'SurvivalTarget');
        room.onReady('p1', { world: room.worldMeta() });
        room.onReady('p2', { world: room.worldMeta() });

        room.advanceTimeForTest(2.5, 0.25);
        assert.equal(room.phase, 'playing');

        const p1 = room.players.get('p1')!;
        const p2 = room.players.get('p2')!;
        assert.equal(p1.weapon, null);

        // Loot first weapon (rifle) -> auto-equips from null with switchUntil === 0 (immediate fire allowed)
        const firstLoot = armPlayerFromContainer(room, 'p1', 'surv_w1', 'rifle');
        assert.equal(firstLoot.weaponId, 'rifle');
        assert.equal(p1.weapon, 'rifle');
        assert.equal(p1.switchUntil, 0, 'First auto-equipped weapon from unarmed must have 0 switch cooldown');

        // Also loot a second distinct weapon ('pistol')
        let pistolCntId = '';
        let pistolItemId = '';
        for (const cntId of room.loot.getAuthoritativeContainerIds()) {
          const raw = room.loot.getRawContainerForServerTest(cntId)!;
          for (const it of raw.items.values()) {
            if (it.kind === 'weapon' && it.weaponId === 'pistol') {
              pistolCntId = cntId;
              pistolItemId = it.id;
              break;
            }
          }
          if (pistolCntId) break;
        }
        assert.ok(pistolCntId && pistolItemId, 'Must find a pistol in room containers');
        const rawPistolCnt = room.loot.getRawContainerForServerTest(pistolCntId)!;
        p1.pos = findClearPlayerPosNearContainer(room, rawPistolCnt);
        assert.equal(
          room.onContainerOpen('p1', {
            requestId: 'surv_open_pistol_cnt',
            containerId: pistolCntId,
            roundId: room.getRoundId(),
            spawnId: p1.spawnId,
          }).ok,
          true,
        );
        assert.equal(
          room.onLootPickup('p1', {
            requestId: 'surv_pick_pistol',
            containerId: pistolCntId,
            itemId: pistolItemId,
            roundId: room.getRoundId(),
            spawnId: p1.spawnId,
          }).ok,
          true,
        );
        assert.equal(p1.weapon, 'rifle', 'Active weapon remains rifle when picking up second weapon');

        // Position p1 and p2 for combat
        const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
        const sx = serviceSite.center.x - 6;
        const sz = serviceSite.center.z + 6;
        const vx = sx;
        const vz = sz - 4;

        p1.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz), z: sz };
        p2.pos = { x: vx, y: sampleTerrainHeight(room.world.terrain, vx, vz), z: vz };
        p1.spawnTime = -99;
        p2.spawnTime = -99;

        const p1Eye: Vec3 = { x: p1.pos.x, y: p1.pos.y + EYE_HEIGHT, z: p1.pos.z };
        const p2Chest: Vec3 = { x: p2.pos.x, y: p2.pos.y + 1.1, z: p2.pos.z };
        const dirToP2 = vnorm(vsub(p2Chest, p1Eye));
        p1.yaw = Math.atan2(-dirToP2.x, -dirToP2.z);
        p1.pitch = Math.asin(Math.max(-1, Math.min(1, dirToP2.y)));

        // Firing unequipped owned weapon ('pistol') must be rejected
        room.onShoot('p1', {
          weapon: 'pistol',
          origin: p1Eye,
          dirs: [dirToP2],
        });
        assert.equal(p2.hp, MAX_HP);
        assert.equal(p1.weapon, 'rifle');

        // Equip 'pistol' with valid roundId & spawnId -> immediate shot rejected during switchTime, allowed after
        const eqPistol = room.onEquipWeapon('p1', {
          requestId: 'surv_eq_pistol',
          weapon: 'pistol',
          roundId: room.getRoundId(),
          spawnId: p1.spawnId,
        });
        assert.equal(eqPistol.ok, true);
        assert.equal(p1.weapon, 'pistol');

        room.onShoot('p1', {
          weapon: 'pistol',
          origin: p1Eye,
          dirs: [dirToP2],
        });
        assert.equal(p2.hp, MAX_HP, 'Immediate shot before pistol switchTime must be rejected in survival');

        room.advanceTimeForTest(WEAPONS.pistol.switchTime + 0.05, 0.05);
        p1.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz), z: sz };
        p2.pos = { x: vx, y: sampleTerrainHeight(room.world.terrain, vx, vz), z: vz };
        room.onShoot('p1', {
          weapon: 'pistol',
          origin: p1Eye,
          dirs: [dirToP2],
        });
        assert.ok(p2.hp < MAX_HP, 'Pistol shot after switchTime must succeed in survival');
      } finally {
        room.destroy();
      }
    }
  });

  it('5. P2 — Reject Post-Elimination Idempotent Cache Replay (RoomLootAuthority)', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'P2 Post-Elimination Idempotent Replay Room',
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
      room.addHuman(sock1.socket, 'ExecutionerP1');
      room.addHuman(sock2.socket, 'ReplayTargetP2');
      room.addHuman(sock3.socket, 'AnchorSurvivorP3');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.onReady('p3', { world: room.worldMeta() });

      // Advance to playing phase in Round 1
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      assert.equal(room.getRoundId(), 1);

      const p2 = room.players.get('p2')!;
      const p2SpawnId = p2.spawnId;

      // Find a container with a weapon + ammo and a container with a medkit for p2
      let wCntId = '';
      let wItemId = '';
      let aItemId = '';
      let wId: WeaponId = 'rifle';
      let medCntId = '';
      let medItemId = '';

      for (const cntId of room.loot.getAuthoritativeContainerIds()) {
        const raw = room.loot.getRawContainerForServerTest(cntId)!;
        for (const it of raw.items.values()) {
          if (!wCntId && it.kind === 'weapon' && it.weaponId) {
            const matchingAmmo = [...raw.items.values()].find(
              (a) => a.kind === 'ammo' && a.ammoWeapon === it.weaponId,
            );
            if (matchingAmmo) {
              wCntId = cntId;
              wItemId = it.id;
              aItemId = matchingAmmo.id;
              wId = it.weaponId;
            }
          }
          if (!medCntId && it.kind === 'medkit') {
            medCntId = cntId;
            medItemId = it.id;
          }
        }
        if (wCntId && medCntId) break;
      }
      assert.ok(wCntId && wItemId && aItemId && medCntId && medItemId);

      // 5a) While p2 is alive: open container, pick up weapon + ammo, equip weapon, and use medkit
      const rawWCnt = room.loot.getRawContainerForServerTest(wCntId)!;
      p2.pos = findClearPlayerPosNearContainer(room, rawWCnt);

      const openAck = room.onContainerOpen('p2', {
        requestId: 'p2_open_1',
        containerId: wCntId,
        roundId: 1,
        spawnId: p2SpawnId,
      });
      assert.equal(openAck.ok, true);
      assert.ok(!openAck.idempotentReplay);

      const pickWAck = room.onLootPickup('p2', {
        requestId: 'p2_pick_w',
        containerId: wCntId,
        itemId: wItemId,
        roundId: 1,
        spawnId: p2SpawnId,
      });
      assert.equal(pickWAck.ok, true);

      const pickAAck = room.onLootPickup('p2', {
        requestId: 'p2_pick_a',
        containerId: wCntId,
        itemId: aItemId,
        roundId: 1,
        spawnId: p2SpawnId,
      });
      assert.equal(pickAAck.ok, true);

      const equipAck = room.onEquipWeapon('p2', {
        requestId: 'p2_eq_1',
        weapon: wId,
        roundId: 1,
        spawnId: p2SpawnId,
      });
      assert.equal(equipAck.ok, true);

      // Open medkit container, pick up medkit, take minor damage, and use medkit
      if (medCntId !== wCntId) {
        const rawMedCnt = room.loot.getRawContainerForServerTest(medCntId)!;
        p2.pos = findClearPlayerPosNearContainer(room, rawMedCnt);
        assert.equal(
          room.onContainerOpen('p2', {
            requestId: 'p2_open_med_cnt',
            containerId: medCntId,
            roundId: 1,
            spawnId: p2SpawnId,
          }).ok,
          true,
        );
      }
      assert.equal(
        room.onLootPickup('p2', {
          requestId: 'p2_pick_med_item',
          containerId: medCntId,
          itemId: medItemId,
          roundId: 1,
          spawnId: p2SpawnId,
        }).ok,
        true,
      );

      p2.hp = 60;
      const medAck = room.onUseMedkit('p2', {
        requestId: 'p2_med_1',
        roundId: 1,
        spawnId: p2SpawnId,
      });
      assert.equal(medAck.ok, true);
      assert.ok(p2.hp > 60);

      // Verify idempotent replay works while p2 is still alive
      const aliveReplayOpen = room.onContainerOpen('p2', {
        requestId: 'p2_open_1',
        containerId: wCntId,
        roundId: 1,
        spawnId: p2SpawnId,
      });
      assert.equal(aliveReplayOpen.ok, true);
      assert.equal(aliveReplayOpen.idempotentReplay, true);

      // 5b) Now have p1 eliminate p2 while p3 remains alive (round stays in 'playing')
      armPlayerFromContainer(room, 'p1', 'p1_arm_kill_p2');
      eliminateTargetWithGunfire(room, 'p1', 'p2');
      assert.equal(p2.alive, false);
      assert.equal(room.phase, 'playing');
      assert.equal(room.survival!.getPlayerRole('p2'), 'eliminated');

      // 5c) Have eliminated p2 replay the exact same requestIds ('p2_open_1', 'p2_pick_w', 'p2_eq_1', 'p2_med_1')
      const deadReplayOpen = room.onContainerOpen('p2', {
        requestId: 'p2_open_1',
        containerId: wCntId,
        roundId: 1,
        spawnId: p2SpawnId,
      });
      assert.equal(deadReplayOpen.ok, false, 'Eliminated replay of p2_open_1 must fail');
      assert.equal(deadReplayOpen.code, 'PLAYER_DEAD');
      assert.ok(!deadReplayOpen.idempotentReplay, 'Must NOT return idempotentReplay: true after elimination');

      const deadReplayPick = room.onLootPickup('p2', {
        requestId: 'p2_pick_w',
        containerId: wCntId,
        itemId: wItemId,
        roundId: 1,
        spawnId: p2SpawnId,
      });
      assert.equal(deadReplayPick.ok, false, 'Eliminated replay of p2_pick_w must fail');
      assert.equal(deadReplayPick.code, 'PLAYER_DEAD');
      assert.ok(!deadReplayPick.idempotentReplay, 'Must NOT return idempotentReplay: true after elimination');

      const deadReplayEquip = room.onEquipWeapon('p2', {
        requestId: 'p2_eq_1',
        weapon: wId,
        roundId: 1,
        spawnId: p2SpawnId,
      });
      assert.equal(deadReplayEquip.ok, false, 'Eliminated replay of p2_eq_1 must fail');
      assert.equal(deadReplayEquip.code, 'PLAYER_DEAD');
      assert.ok(!deadReplayEquip.idempotentReplay, 'Must NOT return idempotentReplay: true after elimination');

      const deadReplayMed = room.onUseMedkit('p2', {
        requestId: 'p2_med_1',
        roundId: 1,
        spawnId: p2SpawnId,
      });
      assert.equal(deadReplayMed.ok, false, 'Eliminated replay of p2_med_1 must fail');
      assert.equal(deadReplayMed.code, 'PLAYER_DEAD');
      assert.ok(!deadReplayMed.idempotentReplay, 'Must NOT return idempotentReplay: true after elimination');
      assert.equal(p2.hp, 0, 'Eliminated player HP must remain 0');
      assert.equal(p2.weapon, null, 'Eliminated player weapon must remain null');
    } finally {
      room.destroy();
    }
  });
});
