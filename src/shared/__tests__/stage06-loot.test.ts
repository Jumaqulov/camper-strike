import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { sanitizeOpts } from '../../server/lobby';
import { Room } from '../../server/room';
import { EYE_HEIGHT, GRENADES_PER_LIFE, MAX_HP } from '../constants';
import { getForestSquarePoiSites } from '../forestSquare';
import {
  hasLineOfSightToContainer,
  LOOT_CATALOG_IDS,
  MEDKIT_HEAL_AMOUNT,
  type LootCatalogId,
} from '../loot';
import { vdist, vnorm, vsub, type Vec3 } from '../math';
import { raycastWorld } from '../physics';
import type { ShotEvent } from '../protocol';
import { fullAmmo, WEAPONS, WEAPON_SLOTS, type WeaponId } from '../weapons';
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

function stepRoomTick(room: Room, dtSec = 1 / 30): void {
  const internal = room as unknown as {
    lastTick: number;
    tick: () => void;
  };
  internal.lastTick = room.now() - dtSec;
  internal.tick();
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
      // Try container floor height first (for indoor containers on raised floors/tables), then terrain height
      const baseFloorY =
        cnt.position.y - terrainY > 0.65 && cnt.position.y - terrainY < 1.15
          ? cnt.position.y - 0.75 // table-top toolbox -> stand on cabin floor
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

describe('STAGE 06 — Server-Authoritative Loot, Containers, Inventory, Unarmed Spawn & Stage 05 Audit Fixes', () => {
  it('1. Stage 05 Audit Fix 1 — Virtual Bullet Origin Strictly Uses Server Eye (Even at 2.4m Offset < 2.5m)', () => {
    const { io, emitted } = createFakeIo();
    const room = new Room(
      {
        name: 'Audit Fix 1 Virtual Origin Room',
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
      const sock1 = createFakeSocket('shooter1', emitted);
      const sock2 = createFakeSocket('target2', emitted);
      room.addHuman(sock1.socket, 'Shooter');
      room.addHuman(sock2.socket, 'Target');
      room.onReady('shooter1', { world: room.worldMeta() });
      room.onReady('target2', { world: room.worldMeta() });

      const shooter = room.players.get('shooter1')!;
      const target = room.players.get('target2')!;

      const bldRanger = room.world.stage04aLayout?.buildings.find(
        (b) => b.id === 'poi:poi_ranger_house:bld:0',
      )!;
      assert.ok(bldRanger, 'Ranger house building must exist in forest_square');
      const ox = bldRanger.origin.x;
      const oz = bldRanger.origin.z;
      const floorY = bldRanger.floorY;

      // Place shooter inside poi_ranger_house behind the solid east wall (x = ox + 8.0)
      shooter.pos = { x: ox + 6.0, y: floorY, z: oz + 2.0 };
      shooter.yaw = -Math.PI / 2; // facing East (+X)
      shooter.pitch = 0;
      shooter.spawnTime = -99;
      shooter.lastShot = -99;

      // Place target outside the solid east wall at x = ox + 9.6
      const targetX = ox + 9.6;
      const targetZ = oz + 2.0;
      const groundY = sampleTerrainHeight(room.world.terrain, targetX, targetZ);
      target.pos = { x: targetX, y: groundY, z: targetZ };
      target.spawnTime = -99;
      target.hp = MAX_HP;

      const shooterEye: Vec3 = {
        x: shooter.pos.x,
        y: shooter.pos.y + EYE_HEIGHT,
        z: shooter.pos.z,
      };
      const targetChest: Vec3 = {
        x: target.pos.x,
        y: target.pos.y + 1.0,
        z: target.pos.z,
      };

      // Spoofed origin is shifted +2.4m East (x = ox + 8.4, outside the east wall!),
      // which is < 2.5m from shooterEye (distance = 2.4m) and would have bypassed Stage 05's old 2.5m threshold!
      const spoofedOrigin24m: Vec3 = {
        x: shooter.pos.x + 2.4,
        y: shooter.pos.y + EYE_HEIGHT,
        z: shooter.pos.z,
      };
      assert.ok(
        vdist(spoofedOrigin24m, shooterEye) < 2.5,
        'Spoofed origin must be < 2.5m from shooterEye to test the Stage 05 audit vulnerability',
      );

      const dirToTarget = vnorm(vsub(targetChest, shooterEye));
      shooter.yaw = Math.atan2(-dirToTarget.x, -dirToTarget.z);
      shooter.pitch = Math.asin(Math.max(-1, Math.min(1, dirToTarget.y)));

      room.onShoot('shooter1', {
        weapon: 'rifle',
        origin: spoofedOrigin24m,
        dirs: [dirToTarget],
      });

      assert.equal(
        target.hp,
        MAX_HP,
        'Server must never use 2.4m-shifted client origin to shoot through a solid wall',
      );

      const lastShotEv = emitted.filter((e) => e.event === 'shot').pop()?.payload as
        | ShotEvent
        | undefined;
      assert.ok(lastShotEv, 'ShotEvent must be emitted using authoritative eye origin');
      assert.ok(
        vdist(lastShotEv.origin, shooterEye) < 1e-4,
        `ShotEvent.origin (${JSON.stringify(lastShotEv.origin)}) must equal authoritative shooterEye (${JSON.stringify(shooterEye)})`,
      );

      const secStats = room.getCombatSecurityStats();
      assert.ok(
        secStats.rejectedFakeOriginShots >= 1,
        `Expected rejectedFakeOriginShots >= 1, got ${secStats.rejectedFakeOriginShots}`,
      );
    } finally {
      room.destroy();
    }
  });

  it('2. Stage 05 Audit Fix 2 — Bullet Aim Direction Validation Against Authoritative (yaw, pitch) & Spread Cone', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Audit Fix 2 Aim Cone Room',
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
      const sock1 = createFakeSocket('shooter1');
      const sock2 = createFakeSocket('target2');
      room.addHuman(sock1.socket, 'Shooter');
      room.addHuman(sock2.socket, 'Target');
      room.onReady('shooter1', { world: room.worldMeta() });
      room.onReady('target2', { world: room.worldMeta() });

      const shooter = room.players.get('shooter1')!;
      const target = room.players.get('target2')!;

      // Place shooter and target in unobstructed courtyard of poi_service_station
      const serviceSite = getForestSquarePoiSites(6501).find(
        (s) => s.id === 'poi_service_station',
      )!;
      const sx = serviceSite.center.x - 6;
      const sz = serviceSite.center.z + 6;
      const tx = sx;
      const tz = sz + 6; // Target is 6m South (+Z) of shooter

      shooter.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz), z: sz };
      target.pos = { x: tx, y: sampleTerrainHeight(room.world.terrain, tx, tz), z: tz };
      shooter.spawnTime = -99;
      shooter.lastShot = -99;
      target.spawnTime = -99;
      target.hp = MAX_HP;

      // Shooter faces North (yaw = 0, pitch = 0, forward = (0, 0, -1)), while target is South (+Z)
      shooter.yaw = 0;
      shooter.pitch = 0;
      const initialMag = shooter.ammo.rifle.mag;

      const shooterEye: Vec3 = {
        x: shooter.pos.x,
        y: shooter.pos.y + EYE_HEIGHT,
        z: shooter.pos.z,
      };
      const targetChest: Vec3 = {
        x: target.pos.x,
        y: target.pos.y + 1.0,
        z: target.pos.z,
      };
      const dirSouthToTarget = vnorm(vsub(targetChest, shooterEye));

      // Attempt 1: 180° backwards aimbot vector while facing North (yaw = 0)
      room.onShoot('shooter1', {
        weapon: 'rifle',
        origin: shooterEye,
        dirs: [dirSouthToTarget],
      });

      assert.equal(target.hp, MAX_HP, '180° off-angle aimbot shot must deal 0 damage');
      assert.equal(
        shooter.ammo.rifle.mag,
        initialMag,
        'Rejected aim-cone shot must not consume magazine ammo',
      );
      assert.equal(room.getCombatSecurityStats().rejectedAimDirectionShots, 1);

      // Attempt 2: 45° sideways spoofed vector (outside maximum weapon spread cone)
      room.onShoot('shooter1', {
        weapon: 'rifle',
        origin: shooterEye,
        dirs: [vnorm({ x: Math.sin(Math.PI / 4), y: 0, z: -Math.cos(Math.PI / 4) })],
      });
      assert.equal(room.getCombatSecurityStats().rejectedAimDirectionShots, 2);

      // Attempt 3: Legitimately rotate shooter.yaw = Math.PI (facing South toward target) and fire
      shooter.yaw = Math.atan2(-dirSouthToTarget.x, -dirSouthToTarget.z);
      shooter.pitch = Math.asin(Math.max(-1, Math.min(1, dirSouthToTarget.y)));
      room.onShoot('shooter1', {
        weapon: 'rifle',
        origin: shooterEye,
        dirs: [dirSouthToTarget],
      });

      assert.ok(
        target.hp < MAX_HP,
        `Valid shot aligned with authoritative yaw/pitch must hit target (hp=${target.hp})`,
      );
      assert.equal(shooter.ammo.rifle.mag, initialMag - 1);
    } finally {
      room.destroy();
    }
  });

  it('3. Stage 05 Audit Fix 3 & Stage 06 — Unarmed Spawn & Unowned Weapon Exploit Rejection', () => {
    // Lobby keeps the requested bot count in lootPreview rooms too (bots loot with their AI)
    const sanitized = sanitizeOpts(
      {
        name: 'Loot Room',
        mode: 'ffa',
        bots: 6,
        mapId: 'forest_square',
        lootPreview: true,
      },
      'Host',
    );
    assert.equal(sanitized.lootPreview, true);
    assert.equal(sanitized.bots, 6, 'sanitizeOpts keeps the bot count in lootPreview rooms');

    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Unarmed Spawn & Exploit Room',
        mode: 'ffa',
        bots: 4,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
        lootPreview: true,
      },
      io,
      () => {},
    );

    try {
      assert.equal(room.lootPreview, true);
      assert.equal(room.botCount(), 4, 'lootPreview room spawns the requested bots');
      for (const b of room.players.values()) {
        if (b.isBot) assert.equal(b.weapon, null, 'bots start unarmed in loot rooms too');
      }

      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      room.addHuman(sock1.socket, 'PlayerOne');
      room.addHuman(sock2.socket, 'PlayerTwo');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });

      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;

      // Verify both players spawned completely unarmed with 0 ammo, 0 grenades, 0 medkits
      for (const p of [p1, p2]) {
        assert.equal(p.weapon, null, `${p.id} must spawn with weapon === null`);
        for (const w of WEAPON_SLOTS) {
          assert.equal(p.ammo[w].mag, 0, `${p.id} ${w} mag must be 0 on unarmed spawn`);
          assert.equal(p.ammo[w].reserve, 0, `${p.id} ${w} reserve must be 0 on unarmed spawn`);
        }
        assert.equal(p.grenades, 0, `${p.id} must spawn with 0 grenades in lootPreview`);
        const inv = room.loot.getPlayerInventorySnap(p.id)!;
        assert.ok(inv);
        assert.equal(inv.equippedWeapon, null);
        assert.deepEqual(inv.ownedWeapons, []);
        assert.equal(inv.grenades, 0);
        assert.equal(inv.medkits, 0);
        assert.equal(inv.items.length, 0);
      }

      // Place p1 and p2 facing each other in clear sight
      const serviceSite = getForestSquarePoiSites(6501).find(
        (s) => s.id === 'poi_service_station',
      )!;
      const sx = serviceSite.center.x - 6;
      const sz = serviceSite.center.z + 6;
      p1.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz), z: sz };
      p2.pos = { x: sx, y: sampleTerrainHeight(room.world.terrain, sx, sz - 5), z: sz - 5 };
      p1.yaw = 0;
      p1.pitch = 0;
      p1.spawnTime = -99;
      p2.spawnTime = -99;

      const p1Eye: Vec3 = { x: p1.pos.x, y: p1.pos.y + EYE_HEIGHT, z: p1.pos.z };
      const p2Chest: Vec3 = { x: p2.pos.x, y: p2.pos.y + 1.0, z: p2.pos.z };
      const dirToP2 = vnorm(vsub(p2Chest, p1Eye));

      // Attempt to fire all 4 weapons while unarmed
      for (const w of WEAPON_SLOTS) {
        room.onShoot('p1', {
          weapon: w,
          origin: p1Eye,
          dirs: [dirToP2],
        });
      }

      assert.equal(p2.hp, MAX_HP, 'Unarmed player must deal 0 damage when spoofing weapon shots');
      assert.equal(p1.weapon, null, 'Unarmed player weapon must remain null');
      assert.ok(
        room.getCombatSecurityStats().rejectedWeaponShots >= 4,
        `All 4 unowned weapon shoot packets must be rejected (got ${room.getCombatSecurityStats().rejectedWeaponShots})`,
      );

      // Attempt to equip unowned 'sniper' via inventory:equip
      const eqAck = room.onEquipWeapon('p1', {
        requestId: 'eq_cheat_1',
        weapon: 'sniper',
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(eqAck.ok, false);
      assert.equal(eqAck.code, 'WEAPON_NOT_OWNED');
      assert.equal(p1.weapon, null);
      assert.ok(room.getCombatSecurityStats().lootStats.rejectedEquipUnowned >= 1);

      // Attempt to equip unowned 'sniper' and scope via movement input packet
      room.onInput('p1', {
        seq: 1,
        spawnId: p1.spawnId,
        dt: 0.016,
        moveForward: 1,
        moveRight: 0,
        jump: false,
        walk: false,
        scoped: true,
        weapon: 'sniper',
        yaw: 0,
        pitch: 0,
      });
      stepRoomTick(room, 1 / 30);

      assert.equal(
        p1.weapon,
        null,
        'Movement authority must refuse to switch to an unowned weapon from PlayerInputCmd',
      );
      assert.equal(p1.scoped, false, 'Unarmed player must not enter sniper scope state');
    } finally {
      room.destroy();
    }
  });

  it('4. Server-Authoritative 26 Containers, Frozen WorldDefinition, & Hidden Closed Loot', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: '26 Containers & Frozen World Room',
        mode: 'ffa',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
        lootPreview: true,
      },
      io,
      () => {},
    );

    try {
      // 4a) Verify WorldDefinition and container arrays remain deeply frozen
      assert.equal(Object.isFrozen(room.world), true);
      assert.equal(Object.isFrozen(room.world.containerLocations), true);
      assert.equal(Object.isFrozen(room.world.stage04aLayout), true);
      assert.equal(Object.isFrozen(room.world.stage04aLayout?.containers), true);
      assert.equal(Object.isFrozen(room.world.colliders), true);

      // 4b) Verify public snapshot exposes all 26 containers with hidden contents while closed
      const pubSnap = room.loot.getPublicLootSnapshot();
      assert.equal(pubSnap.containers.length, 26, 'forest_square must have 26 loot containers');

      const catalogCounts = new Map<LootCatalogId, number>();
      for (const cid of LOOT_CATALOG_IDS) catalogCounts.set(cid, 0);

      for (const pubCnt of pubSnap.containers) {
        assert.equal(pubCnt.opened, false);
        assert.equal(pubCnt.status, 'closed');
        assert.equal(pubCnt.openFraction, 0);
        assert.equal(
          pubCnt.itemCount,
          -1,
          `Closed container ${pubCnt.id} must report itemCount === -1 in public snapshot`,
        );
        assert.equal(
          pubCnt.items.length,
          0,
          `Closed container ${pubCnt.id} must not leak items in public snapshot before opening`,
        );

        // Inspect server-only raw record
        const rawCnt = room.loot.getRawContainerForServerTest(pubCnt.id);
        assert.ok(rawCnt, `Server internal record must exist for ${pubCnt.id}`);
        assert.ok(
          rawCnt.items.size >= 2,
          `Container ${pubCnt.id} must hold >= 2 items on server (got ${rawCnt.items.size})`,
        );

        const rawItems = [...rawCnt.items.values()];
        // Verify invariant: if slot 0 is a weapon, slot 1 is its matching ammo
        if (rawItems[0]?.kind === 'weapon') {
          assert.equal(rawItems[1]?.kind, 'ammo');
          assert.equal(
            rawItems[1]?.ammoWeapon,
            rawItems[0]?.weaponId,
            `Container ${pubCnt.id} weapon ${rawItems[0]?.weaponId} must be paired with matching ammo`,
          );
        }

        for (const item of rawItems) {
          catalogCounts.set(item.catalogId, (catalogCounts.get(item.catalogId) ?? 0) + 1);
        }
      }

      // 4c) Verify all 4 weapons, all 4 ammo types, medkit, and grenade exist across the 26 containers
      for (const cid of LOOT_CATALOG_IDS) {
        const count = catalogCounts.get(cid) ?? 0;
        assert.ok(
          count >= 1,
          `Expected catalog item ${cid} to be present across the 26 containers (got ${count})`,
        );
      }
    } finally {
      room.destroy();
    }
  });

  it('5. Container Open Validation — Distance, Vertical Floor Check, 3D Wall LOS, Dead Player, & Idempotency', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Container Open Security Room',
        mode: 'ffa',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
        lootPreview: true,
      },
      io,
      () => {},
    );

    try {
      const sock1 = createFakeSocket('p1');
      room.addHuman(sock1.socket, 'Explorer');
      room.onReady('p1', { world: room.worldMeta() });
      const p1 = room.players.get('p1')!;

      const bldRanger = room.world.stage04aLayout?.buildings.find(
        (b) => b.id === 'poi:poi_ranger_house:bld:0',
      )!;
      const ox = bldRanger.origin.x;
      const oz = bldRanger.origin.z;
      const floorY = bldRanger.floorY;

      // Target indoor supply crate in SE corner of poi_ranger_house: (ox + 7.35, floorY, oz + 3.45)
      const containerId = 'poi:poi_ranger_house:cnt_0:wooden_loot_crate_01';
      const cntStateBefore = room.loot.getPublicContainerState(containerId)!;
      assert.ok(cntStateBefore);
      assert.equal(cntStateBefore.opened, false);

      // 5a) Out of Range Horizontal (12m away) -> OUT_OF_RANGE
      p1.pos = {
        x: cntStateBefore.position.x + 12.0,
        y: floorY,
        z: cntStateBefore.position.z,
      };
      const ackFar = room.onContainerOpen('p1', {
        requestId: 'open_far_1',
        containerId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(ackFar.ok, false);
      assert.equal(ackFar.code, 'OUT_OF_RANGE');
      assert.equal(room.loot.getPublicContainerState(containerId)!.opened, false);

      // 5b) Out of Range Vertical (0m horizontal, 3.0m above on 2nd-floor loft -> vertDiff = 3.45m > 2.4m) -> OUT_OF_RANGE
      p1.pos = {
        x: cntStateBefore.position.x,
        y: floorY + 3.0,
        z: cntStateBefore.position.z,
      };
      const ackLoft = room.onContainerOpen('p1', {
        requestId: 'open_loft_1',
        containerId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(ackLoft.ok, false);
      assert.equal(ackLoft.code, 'OUT_OF_RANGE');
      assert.equal(room.loot.getPublicContainerState(containerId)!.opened, false);

      // 5c) Blocked by Solid East Cabin Wall (x = ox + 8.0) while within horizontal radius (~1.3m away at x = ox + 8.65) -> LOS_BLOCKED
      p1.pos = {
        x: ox + 8.65,
        y: floorY,
        z: cntStateBefore.position.z,
      };
      const ackWall = room.onContainerOpen('p1', {
        requestId: 'open_wall_1',
        containerId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(ackWall.ok, false);
      assert.equal(ackWall.code, 'LOS_BLOCKED');
      assert.equal(room.loot.getPublicContainerState(containerId)!.opened, false);

      // 5d) Dead Player Rejection (p1.alive = false right next to container) -> PLAYER_DEAD
      p1.pos = {
        x: cntStateBefore.position.x - 1.0,
        y: floorY,
        z: cntStateBefore.position.z - 0.5,
      };
      p1.alive = false;
      const ackDead = room.onContainerOpen('p1', {
        requestId: 'open_dead_1',
        containerId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(ackDead.ok, false);
      assert.equal(ackDead.code, 'PLAYER_DEAD');
      assert.equal(room.loot.getPublicContainerState(containerId)!.opened, false);

      // 5e) Valid Open & Idempotent Replay
      p1.alive = true;
      const ackOk = room.onContainerOpen('p1', {
        requestId: 'open_ok_1',
        containerId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(ackOk.ok, true);
      assert.ok(ackOk.container);
      assert.equal(ackOk.container.opened, true);
      assert.equal(ackOk.container.status, 'opened');
      assert.ok(ackOk.container.items.length >= 2);
      assert.equal(ackOk.container.itemCount, ackOk.container.items.length);

      const openedCountAfterFirst = room.loot.getStats().containersOpened;
      assert.equal(openedCountAfterFirst, 1);

      // Replay exact same requestId
      const ackReplay = room.onContainerOpen('p1', {
        requestId: 'open_ok_1',
        containerId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(ackReplay.ok, true);
      assert.equal(ackReplay.idempotentReplay, true);
      assert.equal(
        room.loot.getStats().containersOpened,
        openedCountAfterFirst,
        'Idempotent replay must not double-increment containersOpened',
      );
      assert.ok(room.loot.getStats().idempotentReplays >= 1);

      // Verify WorldDefinition is still frozen after container open
      assert.equal(Object.isFrozen(room.world), true);
      assert.equal(Object.isFrozen(room.world.containerLocations), true);
    } finally {
      room.destroy();
    }
  });

  it('6. Atomic Item Pickup, Closed-Container Pickup Rejection, & Concurrent 2-Client Race Condition', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Atomic Pickup Race Room',
        mode: 'ffa',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
        lootPreview: true,
      },
      io,
      () => {},
    );

    try {
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      room.addHuman(sock1.socket, 'RacerOne');
      room.addHuman(sock2.socket, 'RacerTwo');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });

      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;

      // Use metal weapon locker inside poi_ranger_house: poi:poi_ranger_house:cnt_1:metal_locker_01
      const cnt2Id = 'poi:poi_ranger_house:cnt_1:metal_locker_01';
      const rawCnt2 = room.loot.getRawContainerForServerTest(cnt2Id)!;
      assert.ok(rawCnt2);
      assert.equal(rawCnt2.opened, false);

      const secretFirstItemId = [...rawCnt2.items.keys()][0]!;
      assert.ok(secretFirstItemId);

      // Place both p1 and p2 1.0m in front of cnt2 inside the cabin with clear LOS
      const standPos: Vec3 = {
        x: rawCnt2.position.x,
        y: rawCnt2.position.y,
        z: rawCnt2.position.z + 1.0,
      };
      p1.pos = { ...standPos };
      p2.pos = { ...standPos };

      // 6a) Attempt to pick up real itemId while container is still CLOSED -> CONTAINER_CLOSED
      const ackClosed = room.onLootPickup('p1', {
        requestId: 'pick_closed_1',
        containerId: cnt2Id,
        itemId: secretFirstItemId,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(ackClosed.ok, false);
      assert.equal(ackClosed.code, 'CONTAINER_CLOSED');
      assert.equal(room.loot.getStats().rejectedPickupClosed, 1);

      // 6b) Open cnt2 legally
      const ackOpen = room.onContainerOpen('p1', {
        requestId: 'open_cnt2_1',
        containerId: cnt2Id,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(ackOpen.ok, true);
      assert.ok(ackOpen.container);
      const itemsAtOpen = [...ackOpen.container.items];
      assert.ok(itemsAtOpen.length >= 2);
      const firstItem = itemsAtOpen[0]!;

      // 6c) Concurrent 2-client pickup race for firstItem.id
      const ackP1 = room.onLootPickup('p1', {
        requestId: 'race_p1',
        containerId: cnt2Id,
        itemId: firstItem.id,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      const ackP2 = room.onLootPickup('p2', {
        requestId: 'race_p2',
        containerId: cnt2Id,
        itemId: firstItem.id,
        roundId: room.getRoundId(),
        spawnId: p2.spawnId,
      });

      assert.equal(ackP1.ok, true, 'First player in race must succeed');
      assert.equal(ackP1.pickedItem?.id, firstItem.id);

      assert.equal(ackP2.ok, false, 'Second player in race must be rejected');
      assert.equal(
        ackP2.code,
        'ITEM_ALREADY_TAKEN',
        'Second player must receive ITEM_ALREADY_TAKEN without duplicating the item',
      );
      assert.equal(room.loot.getStats().rejectedPickupTaken, 1);

      // Verify p2 did not receive any item
      const p2Inv = room.loot.getPlayerInventorySnap('p2')!;
      assert.equal(p2Inv.items.length, 0);
      assert.equal(p2.weapon, null);
      assert.equal(p2.grenades, 0);

      // 6d) Idempotent replay of winner's pickup request
      const itemsPickedBeforeReplay = room.loot.getStats().itemsPickedUp;
      const ackP1Replay = room.onLootPickup('p1', {
        requestId: 'race_p1',
        containerId: cnt2Id,
        itemId: firstItem.id,
        roundId: room.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(ackP1Replay.ok, true);
      assert.equal(ackP1Replay.idempotentReplay, true);
      assert.equal(
        room.loot.getStats().itemsPickedUp,
        itemsPickedBeforeReplay,
        'Idempotent pickup replay must not duplicate itemsPickedUp',
      );

      // 6e) Loot all remaining items in cnt2 and verify status transitions to 'empty'
      for (let i = 1; i < itemsAtOpen.length; i++) {
        const nextItem = itemsAtOpen[i]!;
        const ackNext = room.onLootPickup('p1', {
          requestId: `drain_cnt2_${i}`,
          containerId: cnt2Id,
          itemId: nextItem.id,
          roundId: room.getRoundId(),
          spawnId: p1.spawnId,
        });
        assert.equal(ackNext.ok, true);
      }

      const cnt2AfterDrain = room.loot.getPublicContainerState(cnt2Id)!;
      assert.equal(cnt2AfterDrain.status, 'empty');
      assert.equal(cnt2AfterDrain.opened, true);
      assert.equal(cnt2AfterDrain.items.length, 0);
      assert.equal(cnt2AfterDrain.itemCount, 0);
    } finally {
      room.destroy();
    }
  });

  it('7. Full Gameplay Loop — Loot Weapon + Ammo + Medkit + Grenade -> Equip -> Shoot -> Reload -> Heal -> Respawn Reset & Multi-Room Isolation', () => {
    const { io: ioA } = createFakeIo();
    const { io: ioB } = createFakeIo();

    const roomA = new Room(
      {
        name: 'Full Loop Loot Room A',
        mode: 'ffa',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
        lootPreview: true,
      },
      ioA,
      () => {},
    );
    const roomB = new Room(
      {
        name: 'Isolated Loot Room B',
        mode: 'ffa',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
        lootPreview: true,
      },
      ioB,
      () => {},
    );

    try {
      const sock1 = createFakeSocket('p1');
      const sock2 = createFakeSocket('p2');
      roomA.addHuman(sock1.socket, 'Survivor');
      roomA.addHuman(sock2.socket, 'Opponent');
      roomA.onReady('p1', { world: roomA.worldMeta() });
      roomA.onReady('p2', { world: roomA.worldMeta() });

      const p1 = roomA.players.get('p1')!;
      const p2 = roomA.players.get('p2')!;
      assert.equal(p1.weapon, null);

      // Helper to open a container and pick up a specific item inside it
      let reqCounter = 0;
      const openAndLootItem = (cntId: string, itemId: string) => {
        const rawCnt = roomA.loot.getRawContainerForServerTest(cntId)!;
        p1.pos = findClearPlayerPosNearContainer(roomA, rawCnt);
        const openAck = roomA.onContainerOpen('p1', {
          requestId: `loop_open_${++reqCounter}`,
          containerId: cntId,
          roundId: roomA.getRoundId(),
          spawnId: p1.spawnId,
        });
        assert.equal(openAck.ok, true, `Failed to open ${cntId}: ${openAck.code}`);
        const pickAck = roomA.onLootPickup('p1', {
          requestId: `loop_pick_${++reqCounter}`,
          containerId: cntId,
          itemId,
          roundId: roomA.getRoundId(),
          spawnId: p1.spawnId,
        });
        assert.equal(pickAck.ok, true, `Failed to pick ${itemId} from ${cntId}: ${pickAck.code}`);
        return pickAck;
      };

      // Find containers in roomA holding: (1) a weapon + its paired ammo, (2) a medkit, (3) a grenade
      let weaponCntId = '';
      let weaponItemId = '';
      let ammoItemId = '';
      let lootedWeaponId: WeaponId = 'rifle';
      let medkitCntId = '';
      let medkitItemId = '';
      let grenadeCntId = '';
      let grenadeItemId = '';

      for (const cntId of roomA.loot.getAuthoritativeContainerIds()) {
        const raw = roomA.loot.getRawContainerForServerTest(cntId)!;
        for (const item of raw.items.values()) {
          if (!weaponItemId && item.kind === 'weapon' && item.weaponId) {
            weaponCntId = cntId;
            weaponItemId = item.id;
            lootedWeaponId = item.weaponId;
            // Find matching ammo in the same container
            const matchingAmmo = [...raw.items.values()].find(
              (it) => it.kind === 'ammo' && it.ammoWeapon === lootedWeaponId,
            );
            if (matchingAmmo) ammoItemId = matchingAmmo.id;
          }
          if (!medkitItemId && item.kind === 'medkit') {
            medkitCntId = cntId;
            medkitItemId = item.id;
          }
          if (!grenadeItemId && item.kind === 'grenade') {
            grenadeCntId = cntId;
            grenadeItemId = item.id;
          }
        }
      }

      assert.ok(weaponItemId && ammoItemId, 'Must find a weapon and matching ammo in roomA');
      assert.ok(medkitItemId, 'Must find a medkit in roomA');
      assert.ok(grenadeItemId, 'Must find a grenade in roomA');

      // 7a) Loot first weapon -> verify auto-equip and initial mag + reserve
      openAndLootItem(weaponCntId, weaponItemId);
      assert.equal(
        p1.weapon,
        lootedWeaponId,
        'First looted weapon must auto-equip on unarmed player',
      );
      const wDef = WEAPONS[lootedWeaponId];
      assert.equal(p1.ammo[lootedWeaponId].mag, wDef.magSize);
      assert.equal(p1.ammo[lootedWeaponId].reserve, wDef.magSize);

      // Loot extra matching ammo, medkit, and grenade
      openAndLootItem(weaponCntId, ammoItemId);
      assert.ok(p1.ammo[lootedWeaponId].reserve > wDef.magSize);

      openAndLootItem(medkitCntId, medkitItemId);
      assert.equal(roomA.loot.getPlayerInventorySnap('p1')!.medkits, 1);

      openAndLootItem(grenadeCntId, grenadeItemId);
      assert.equal(p1.grenades, 1);
      assert.equal(roomA.loot.getPlayerInventorySnap('p1')!.grenades, 1);

      // 7b) Shoot p2 with the looted weapon -> verify damage dealt and mag decremented
      const serviceSite = getForestSquarePoiSites(6501).find(
        (s) => s.id === 'poi_service_station',
      )!;
      const sx = serviceSite.center.x - 6;
      const sz = serviceSite.center.z + 6;
      p1.pos = { x: sx, y: sampleTerrainHeight(roomA.world.terrain, sx, sz), z: sz };
      p2.pos = { x: sx, y: sampleTerrainHeight(roomA.world.terrain, sx, sz - 4), z: sz - 4 };
      p1.spawnTime = -99;
      p1.lastShot = -99;
      p2.spawnTime = -99;
      p2.hp = MAX_HP;

      const p1Eye: Vec3 = { x: p1.pos.x, y: p1.pos.y + EYE_HEIGHT, z: p1.pos.z };
      const p2Chest: Vec3 = { x: p2.pos.x, y: p2.pos.y + 1.0, z: p2.pos.z };
      const dirToP2 = vnorm(vsub(p2Chest, p1Eye));
      p1.yaw = Math.atan2(-dirToP2.x, -dirToP2.z);
      p1.pitch = Math.asin(Math.max(-1, Math.min(1, dirToP2.y)));

      const dirsForShot = Array.from({ length: wDef.pellets }, () => dirToP2);
      roomA.onShoot('p1', {
        weapon: lootedWeaponId,
        origin: p1Eye,
        dirs: dirsForShot,
      });

      assert.ok(p2.hp < MAX_HP, `Looted ${lootedWeaponId} shot must damage opponent (hp=${p2.hp})`);
      assert.equal(p1.ammo[lootedWeaponId].mag, wDef.magSize - 1);

      // 7c) Reload weapon -> verify mag refills from reserve
      const reserveBeforeReload = p1.ammo[lootedWeaponId].reserve;
      roomA.onReload('p1');
      assert.equal(p1.reloadWeapon, lootedWeaponId);
      p1.reloadUntil = roomA.now() - 0.01;
      stepRoomTick(roomA, 1 / 30);

      assert.equal(p1.reloadWeapon, null);
      assert.equal(p1.ammo[lootedWeaponId].mag, wDef.magSize);
      assert.equal(p1.ammo[lootedWeaponId].reserve, reserveBeforeReload - 1);

      // 7d) Use Medkit: first verify rejection at full HP, then heal from 40 HP -> 85 HP
      const fullHpMedAck = roomA.onUseMedkit('p1', {
        requestId: 'med_full_1',
        roundId: roomA.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(fullHpMedAck.ok, false);
      assert.equal(fullHpMedAck.code, 'HP_ALREADY_FULL');

      p1.hp = 40;
      const medAck = roomA.onUseMedkit('p1', {
        requestId: 'med_use_1',
        roundId: roomA.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(medAck.ok, true);
      assert.equal(p1.hp, 40 + MEDKIT_HEAL_AMOUNT); // 85 HP
      assert.equal(medAck.hp, 85);
      assert.equal(roomA.loot.getPlayerInventorySnap('p1')!.medkits, 0);

      // Attempt to use another medkit when medkits === 0 -> NO_MEDKITS
      const noMedAck = roomA.onUseMedkit('p1', {
        requestId: 'med_empty_1',
        roundId: roomA.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(noMedAck.ok, false);
      assert.equal(noMedAck.code, 'NO_MEDKITS');

      // 7e) Unequip to empty hands (weapon: null) and re-equip owned weapon
      const unequipAck = roomA.onEquipWeapon('p1', {
        requestId: 'unequip_hands_0',
        weapon: null,
        roundId: roomA.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(unequipAck.ok, true);
      assert.equal(p1.weapon, null);
      assert.equal(roomA.loot.getPlayerInventorySnap('p1')!.equippedWeapon, null);

      const reequipAck = roomA.onEquipWeapon('p1', {
        requestId: 'reequip_1',
        weapon: lootedWeaponId,
        roundId: roomA.getRoundId(),
        spawnId: p1.spawnId,
      });
      assert.equal(reequipAck.ok, true);
      assert.equal(p1.weapon, lootedWeaponId);

      // 7f) Respawn reset: p1 respawns unarmed while roomA containers remain opened, and roomB containers remain untouched
      roomA.spawn(p1);
      assert.equal(p1.weapon, null, 'Respawned player in lootPreview must reset to unarmed');
      const invAfterRespawn = roomA.loot.getPlayerInventorySnap('p1')!;
      assert.deepEqual(invAfterRespawn.ownedWeapons, []);
      assert.equal(invAfterRespawn.medkits, 0);
      assert.equal(invAfterRespawn.grenades, 0);
      assert.equal(
        roomA.loot.getPublicContainerState(weaponCntId)!.opened,
        true,
        'Opened container in roomA must remain opened across player respawns',
      );
      assert.equal(
        roomB.loot.getPublicContainerState(weaponCntId)!.opened,
        false,
        'Container in roomB must remain closed and isolated from roomA',
      );
    } finally {
      roomA.destroy();
      roomB.destroy();
    }
  });

  it('8. Legacy TDM / FFA Regression Check (lootPreview: false on forest_square & dust_arena)', () => {
    const { io } = createFakeIo();
    for (const mapId of ['forest_square', 'dust_arena'] as const) {
      const room = new Room(
        {
          name: `Legacy ${mapId} Room`,
          mode: 'tdm',
          bots: 2,
          maxPlayers: 8,
          timeLimit: 10,
          scoreLimit: 50,
          mapId,
          publicLayoutSeed: 6501,
          lootPreview: false,
        },
        io,
        () => {},
      );

      try {
        assert.equal(room.lootPreview, false);
        assert.equal(room.botCount(), 2, `Legacy ${mapId} room must spawn requested bots`);

        const sock1 = createFakeSocket('legacy_p1');
        room.addHuman(sock1.socket, 'LegacySoldier');
        room.onReady('legacy_p1', { world: room.worldMeta() });

        const p1 = room.players.get('legacy_p1')!;
        assert.equal(p1.weapon, 'rifle');
        assert.deepEqual(p1.ammo, fullAmmo());
        assert.equal(p1.grenades, GRENADES_PER_LIFE);

        const inv = room.loot.getPlayerInventorySnap('legacy_p1')!;
        assert.equal(inv.lootPreview, false);
        assert.equal(inv.equippedWeapon, 'rifle');
        assert.deepEqual(inv.ownedWeapons, [...WEAPON_SLOTS]);

        // Verify legacy player can freely equip any of the 4 weapons
        for (const w of WEAPON_SLOTS) {
          const ack = room.onEquipWeapon('legacy_p1', {
            requestId: `leg_eq_${w}`,
            weapon: w,
          });
          assert.equal(ack.ok, true);
          assert.equal(p1.weapon, w);
        }
      } finally {
        room.destroy();
      }
    }
  });
});
