import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { ClientPrediction } from '../../client/game/ClientPrediction';
import { LocalPlayer } from '../../client/game/LocalPlayer';
import { PlayerMovementAuthority } from '../../server/movementAuthority';
import { Room, validateMapSpawns } from '../../server/room';
import {
  EYE_HEIGHT,
  GRAVITY,
  JUMP_SPEED,
  MAX_HP,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  RUN_SPEED,
  WALK_SPEED,
} from '../constants';
import {
  buildForestSquareSpawns,
  createForestSquareWorld,
  getForestSquarePoiSites,
  sampleForestSquareRoad,
} from '../forestSquare';
import { MAX_SPAWN_SLOPE_DEG } from '../forestSquareSpawns';
import { vdist, vnorm, vsub, type Vec3 } from '../math';
import {
  extractSanitizedInputBatch,
  FIXED_MOVE_DT,
  MAX_INPUT_BATCH_SIZE,
  MAX_INPUT_DT,
  MAX_INPUT_QUEUE_SIZE,
  MAX_PITCH_RAD,
  MIN_INPUT_DT,
  normalizeYaw,
  RECONCILE_SNAP_THRESHOLD,
  sanitizePlayerInputCmd,
  stepPlayerMovement,
  type MovementState,
} from '../netMovement';
import {
  collidesAtWorld,
  isSpawnPointSafe,
  raycastWorld,
  type Body,
} from '../physics';
import type {
  ClientState,
  HitConfirm,
  PlayerInputCmd,
  PlayerSnap,
  ShotEvent,
  Snapshot,
  SpawnEvent,
} from '../protocol';
import { DEFAULT_MAX_WALKABLE_SLOPE_DEG } from '../terrain';
import { WEAPONS } from '../weapons';
import {
  createTechnicalTerrainFixture,
  createWorldDefinition,
  sampleTerrainHeight,
  sampleTerrainSlopeDeg,
  type ColliderBox,
  type WorldDefinition,
} from '../world';

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

describe('STAGE 05 — Server-Authoritative Movement, Client Prediction, Adversarial Security & Stage 04B Audit Fixes', () => {
  it('1. Stage 04B Audit Fixes: Deeply Frozen WorldDefinition, 36 Valid Spawns & Crowded Spacing Fallback', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    // 1a) Verify deep freeze across world, terrain, colliders, buildings, containers, and spawns
    assert.equal(Object.isFrozen(world), true, 'WorldDefinition root must be frozen');
    assert.equal(Object.isFrozen(world.colliders), true, 'world.colliders array must be frozen');
    assert.equal(Object.isFrozen(world.terrain), true, 'world.terrain must be frozen');
    assert.equal(Object.isFrozen(world.poiLayout), true, 'world.poiLayout must be frozen');
    assert.equal(
      Object.isFrozen(world.poiLayout.buildings),
      true,
      'world.poiLayout.buildings must be frozen',
    );
    assert.equal(
      Object.isFrozen(world.poiLayout.containers),
      true,
      'world.poiLayout.containers must be frozen',
    );
    assert.equal(Object.isFrozen(world.spawnPoints), true, 'world.spawnPoints must be frozen');

    assert.throws(() => {
      world.colliders.push({
        id: 'hack_col',
        tag: 'prop',
        mat: 'crate',
        min: { x: 0, y: 0, z: 0 },
        max: { x: 1, y: 1, z: 1 },
      });
    }, TypeError);

    assert.throws(() => {
      (world.spawnPoints[0] as { x: number }).x = 999;
    }, TypeError);

    assert.throws(() => {
      if (world.terrain.kind === 'heightfield') {
        world.terrain.heights[0] = 999;
      }
    }, TypeError);

    // 1b) Verify all 36 spawns (12 red, 12 blue, 12 ffa) pass validation, collision, slope <= 28°, and POI pad exclusion
    assert.equal(world.spawnPoints.length, 36);
    assert.equal(world.spawnPoints.filter((s) => s.team === 'red').length, 12);
    assert.equal(world.spawnPoints.filter((s) => s.team === 'blue').length, 12);
    assert.equal(world.spawnPoints.filter((s) => s.team === 'none').length, 12);

    const badSpawns = validateMapSpawns(world);
    assert.deepEqual(badSpawns, [], 'validateMapSpawns(world) must report 0 invalid spawns');

    const poiSites = getForestSquarePoiSites(6501);
    for (const sp of world.spawnPoints) {
      assert.equal(isSpawnPointSafe(world, sp), true, `Spawn ${sp.id} must be safe`);
      assert.equal(
        collidesAtWorld(world, sp.x, sp.y + 0.02, sp.z, PLAYER_RADIUS, PLAYER_HEIGHT - 0.02),
        false,
        `Spawn ${sp.id} must not collide with world`,
      );
      const slope = sampleTerrainSlopeDeg(world.terrain, sp.x, sp.z);
      assert.ok(
        slope <= MAX_SPAWN_SLOPE_DEG,
        `Spawn ${sp.id} slope (${slope.toFixed(2)}°) must be <= ${MAX_SPAWN_SLOPE_DEG}°`,
      );
      for (const site of poiSites) {
        const distToPoi = Math.hypot(sp.x - site.center.x, sp.z - site.center.z);
        assert.ok(
          distToPoi >= site.flatRadius + 2.2,
          `Spawn ${sp.id} must lie outside POI ${site.id} flat pad`,
        );
      }
    }

    // 1c) Crowded spacing fallback: block primary spiral regions with dense obstacles so fallback grid/ring scans execute
    const crowdingObstacles: ColliderBox[] = [];
    for (let i = 0; i < world.spawnPoints.length; i++) {
      const sp = world.spawnPoints[i];
      crowdingObstacles.push({
        id: `crowd_blocker_${i}`,
        tag: 'rock',
        mat: 'wall',
        min: { x: sp.x - 2.2, y: sp.y - 1, z: sp.z - 2.2 },
        max: { x: sp.x + 2.2, y: sp.y + 4, z: sp.z + 2.2 },
      });
    }

    const crowdedSpawns = buildForestSquareSpawns({
      terrain: world.terrain,
      seed: 6501,
      poiSites,
      allColliders: [...world.colliders, ...crowdingObstacles],
      roadDistSampler: (x, z) => sampleForestSquareRoad(x, z, 6501).dist,
    });

    assert.equal(crowdedSpawns.length, 36);
    for (const sp of crowdedSpawns) {
      assert.equal(
        collidesAtWorld(world, sp.x, sp.y + 0.02, sp.z, PLAYER_RADIUS, PLAYER_HEIGHT - 0.02),
        false,
        `Fallback spawn ${sp.id} must be collision-free`,
      );
      const slope = sampleTerrainSlopeDeg(world.terrain, sp.x, sp.z);
      assert.ok(slope <= MAX_SPAWN_SLOPE_DEG, `Fallback spawn ${sp.id} must respect max slope`);
    }
  });

  it('2. Input Sanitization & Coordinate Stripping (netMovement.ts)', () => {
    // 2a) Rejects null, primitives, arrays, invalid seq/spawnId, and NaN/Infinity floats
    assert.equal(sanitizePlayerInputCmd(null), null);
    assert.equal(sanitizePlayerInputCmd(undefined), null);
    assert.equal(sanitizePlayerInputCmd('invalid'), null);
    assert.equal(sanitizePlayerInputCmd(123), null);
    assert.equal(sanitizePlayerInputCmd([]), null);

    const baseValid = {
      seq: 1,
      spawnId: 1,
      dt: 1 / 60,
      moveForward: 1,
      moveRight: -0.5,
      jump: false,
      walk: false,
      scoped: false,
      weapon: 'rifle',
      yaw: 0.5,
      pitch: 0.2,
    };

    assert.equal(sanitizePlayerInputCmd({ ...baseValid, seq: 0 }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, seq: -3 }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, seq: 1.5 }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, spawnId: 0 }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, spawnId: -1 }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, spawnId: 2.7 }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, dt: Number.NaN }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, dt: Number.POSITIVE_INFINITY }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, moveForward: Number.NaN }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, moveRight: Number.NEGATIVE_INFINITY }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, yaw: Number.NaN }), null);
    assert.equal(sanitizePlayerInputCmd({ ...baseValid, pitch: Number.POSITIVE_INFINITY }), null);

    // 2b) Clamps axes, pitch, dt, normalizes yaw, validates weapon, and strips injected coordinates
    const dirtyInput = {
      seq: 7,
      spawnId: 2,
      dt: 99.0,
      moveForward: 500,
      moveRight: -500,
      jump: 1,
      walk: 0,
      scoped: true,
      weapon: 'invalid_laser' as unknown as string,
      yaw: Math.PI * 5 + 0.25,
      pitch: -9.99,
      // Injected cheat coordinates & velocity that MUST be stripped:
      x: 100,
      y: 50,
      z: -100,
      vx: 999,
      vy: 999,
      vz: 999,
      onGround: true,
      hp: 9999,
    };

    const clean = sanitizePlayerInputCmd(dirtyInput, 'pistol');
    assert.ok(clean, 'Dirty input with valid numbers should be sanitized, not null');
    assert.equal(clean.seq, 7);
    assert.equal(clean.spawnId, 2);
    assert.equal(clean.dt, MAX_INPUT_DT);
    assert.equal(clean.moveForward, 1);
    assert.equal(clean.moveRight, -1);
    assert.equal(clean.pitch, -MAX_PITCH_RAD);
    assert.equal(clean.weapon, 'pistol');
    assert.equal(clean.scoped, false, 'Non-sniper weapon must force scoped=false');
    assert.ok(Math.abs(clean.yaw - normalizeYaw(Math.PI + 0.25)) < 1e-4);

    // Verify tiny dt is clamped to MIN_INPUT_DT
    const tinyDtClean = sanitizePlayerInputCmd({ ...baseValid, dt: 0.00001 });
    assert.ok(tinyDtClean);
    assert.equal(tinyDtClean.dt, Math.round(MIN_INPUT_DT * 100000) / 100000);

    // Verify all injected coordinate/velocity keys are completely absent
    const cleanRecord = clean as unknown as Record<string, unknown>;
    assert.equal('x' in cleanRecord, false);
    assert.equal('y' in cleanRecord, false);
    assert.equal('z' in cleanRecord, false);
    assert.equal('vx' in cleanRecord, false);
    assert.equal('vy' in cleanRecord, false);
    assert.equal('vz' in cleanRecord, false);
    assert.equal('onGround' in cleanRecord, false);
    assert.equal('hp' in cleanRecord, false);

    // 2c) extractSanitizedInputBatch enforces batch bounds [1, MAX_INPUT_BATCH_SIZE] and spawnId matching
    assert.equal(extractSanitizedInputBatch({ spawnId: 1, inputs: [] }), null);
    const oversized = Array.from({ length: MAX_INPUT_BATCH_SIZE + 1 }, (_, i) => ({
      ...baseValid,
      seq: i + 1,
    }));
    assert.equal(extractSanitizedInputBatch({ spawnId: 1, inputs: oversized }), null);

    const mixedBatch = extractSanitizedInputBatch({
      spawnId: 3,
      ping: 42,
      inputs: [
        { ...baseValid, seq: 1, spawnId: 2 }, // stale spawnId -> filtered out
        { ...baseValid, seq: 2, spawnId: 3 }, // matches
        { ...baseValid, seq: 3, spawnId: 3 }, // matches
      ],
    });
    assert.ok(mixedBatch);
    assert.equal(mixedBatch.spawnId, 3);
    assert.equal(mixedBatch.inputs.length, 2);
    assert.deepEqual(
      mixedBatch.inputs.map((c) => c.seq),
      [2, 3],
    );
    assert.equal(mixedBatch.ping, 42);
  });

  it('3. Adversarial Test 1 — Teleport Cheat Rejection (Room.onState & Room.onInput)', () => {
    const { io } = createFakeIo();
    const room = new Room(
      {
        name: 'Adversarial Teleport Room',
        mode: 'ffa',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
      },
      io,
      () => {},
    );

    try {
      const sock1 = createFakeSocket('p1');
      room.addHuman(sock1.socket, 'CheaterP1');
      const readyAck = room.onReady('p1', { world: room.worldMeta() });
      assert.equal(readyAck.ok, true);

      const p1 = room.players.get('p1')!;
      assert.ok(p1);
      assert.equal(p1.alive, true);

      const spawnX = p1.pos.x;
      const spawnY = p1.pos.y;
      const spawnZ = p1.pos.z;
      const spawnId = p1.spawnId;

      // Attempt 1: Legacy ClientState packet trying to teleport to (90, 50, -90)
      const legacyCheat: ClientState = {
        spawnId,
        x: 90,
        y: 50,
        z: -90,
        vx: 100,
        vy: 100,
        vz: 100,
        yaw: 1.2,
        pitch: 0.3,
        onGround: true,
        weapon: 'rifle',
        ping: 25,
      };
      room.onState('p1', legacyCheat);

      // Attempt 2: Injecting raw x/y/z coordinates into onInput with zero movement intent
      room.onInput('p1', {
        seq: 1,
        spawnId,
        dt: 0.016,
        moveForward: 0,
        moveRight: 0,
        jump: false,
        walk: false,
        scoped: false,
        weapon: 'rifle',
        yaw: 0,
        pitch: 0,
        x: 90,
        y: 50,
        z: -90,
        vx: 500,
        vy: 500,
        vz: 500,
      });

      stepRoomTick(room, 1 / 30);

      // Verify 0.0m horizontal teleport and rejectedLegacyState counter incremented
      const horizMoved = Math.hypot(p1.pos.x - spawnX, p1.pos.z - spawnZ);
      assert.equal(horizMoved, 0, 'Player must not teleport horizontally');
      assert.ok(Math.abs(p1.pos.y - spawnY) < 1e-3, 'Player must not teleport vertically');

      const stats = room.getPlayerAuthorityStats('p1')!;
      assert.ok(stats);
      assert.ok(stats.rejectedLegacyState >= 1, 'Legacy state packet must be recorded as rejected');
      assert.equal(stats.processedInputs, 1);
    } finally {
      room.destroy();
    }
  });

  it('4. Adversarial Test 2 — Speedhack / Input Flood / Inflated dt & Axis Clamp', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    // Use the flat courtyard of poi_service_station so movement is unobstructed for 15m+
    const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
    const startX = serviceSite.center.x - 10;
    const startZ = serviceSite.center.z + 8;
    const startY = sampleTerrainHeight(world.terrain, startX, startZ);

    const player = {
      pos: { x: startX, y: startY, z: startZ },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
      yaw: -Math.PI / 2, // facing +X
      pitch: 0,
      weapon: 'rifle' as const,
      scoped: false,
      reloadWeapon: null,
    };

    const auth = new PlayerMovementAuthority();
    auth.resetForSpawn(1);
    // Start with steady-state simulation credit (one 50ms tick worth) to test a 1.0s window
    auth.simTimeCreditSec = 0.05;

    // Flood 80 speedhack commands on tick 0, then continue flooding 6 speedhack commands every 50ms tick
    let seq = 0;
    for (let i = 0; i < 80; i++) {
      seq++;
      auth.enqueueInputPacket(
        {
          seq,
          spawnId: 1,
          dt: 5.0,
          moveForward: 500,
          moveRight: 0,
          jump: false,
          walk: false,
          scoped: false,
          weapon: 'rifle',
          yaw: -Math.PI / 2,
          pitch: 0,
        },
        'rifle',
      );
    }

    // Run 20 server ticks of 50ms (= 1.0s total server time) while attacker keeps flooding dt=5.0
    for (let t = 0; t < 20; t++) {
      if (t > 0) {
        for (let k = 0; k < 6; k++) {
          seq++;
          auth.enqueueInputPacket(
            {
              seq,
              spawnId: 1,
              dt: 5.0,
              moveForward: 500,
              moveRight: 0,
              jump: false,
              walk: false,
              scoped: false,
              weapon: 'rifle',
              yaw: -Math.PI / 2,
              pitch: 0,
            },
            'rifle',
          );
        }
      }
      auth.stepAuthoritativeTick(player, 0.05, world);
    }

    const distTraveled = Math.hypot(player.pos.x - startX, player.pos.z - startZ);
    const maxLegalSpeed = RUN_SPEED * WEAPONS.rifle.speedMul; // 6.5 * 0.93 = 6.045 m/s
    const maxAllowedDist = maxLegalSpeed * 1.15; // 6.95175 m

    assert.ok(
      distTraveled <= maxAllowedDist,
      `Speedhack flood distance (${distTraveled.toFixed(3)}m) must not exceed legal 1.0s bound (${maxAllowedDist.toFixed(3)}m)`,
    );
    assert.ok(
      distTraveled > maxLegalSpeed * 0.85,
      `Player should still move at normal legal speed (${distTraveled.toFixed(3)}m)`,
    );
    assert.ok(
      auth.stats.rejectedQueueFull > 0,
      `Expected rejectedQueueFull > 0 when flooding 80 commands (got ${auth.stats.rejectedQueueFull})`,
    );
    assert.ok(
      auth.stats.speedhackClampedSec > 0,
      `Expected speedhackClampedSec > 0 when flooding excess simulation time (got ${auth.stats.speedhackClampedSec})`,
    );
  });

  it('5. Adversarial Test 3 — Wall / Rotated Building / Rock / Tree / Steep Slope (> 42°) Noclip Prevention', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const sites = getForestSquarePoiSites(6501);
    const siteMap = new Map(sites.map((s) => [s.id, s]));
    const layout = world.poiLayout;

    const runSteps = (
      body: Body & { yaw?: number; pitch?: number; weapon?: 'rifle'; scoped?: boolean },
      yaw: number,
      steps: number,
      targetWorld: WorldDefinition = world,
    ) => {
      for (let i = 1; i <= steps; i++) {
        stepPlayerMovement(
          body,
          {
            seq: i,
            spawnId: 1,
            dt: FIXED_MOVE_DT,
            moveForward: 1,
            moveRight: 0,
            jump: false,
            walk: false,
            scoped: false,
            weapon: 'rifle',
            yaw,
            pitch: 0,
          },
          targetWorld,
        );
        assert.equal(
          collidesAtWorld(
            targetWorld,
            body.pos.x,
            body.pos.y + 0.02,
            body.pos.z,
            PLAYER_RADIUS,
            PLAYER_HEIGHT - 0.02,
          ),
          false,
          `Step ${i}: player must never overlap solid world colliders at (${body.pos.x.toFixed(2)}, ${body.pos.y.toFixed(2)}, ${body.pos.z.toFixed(2)})`,
        );
      }
    };

    // 5a) Rotated +90° building solid back wall in poi_cabin_cluster (West 4x4 house, back wall at x = ox)
    {
      const clusterSite = siteMap.get('poi_cabin_cluster')!;
      const bldWest = layout.buildings.find((b) => b.id === 'poi:poi_cabin_cluster:bld:1')!;
      const ox = clusterSite.center.x - 10;
      const oz = clusterSite.center.z + 5;
      // Start outside the west solid wall (x = ox - 1.5, z = oz - 2.0) and walk east (+X, yaw = -PI/2) into the solid wall
      const startX = ox - 1.5;
      const startZ = oz - 2.0;
      const body: Body = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      runSteps(body, -Math.PI / 2, 60);
      assert.ok(
        body.pos.x < ox - PLAYER_RADIUS + 0.05,
        `Player must be blocked outside +90° rotated west building wall (x=${body.pos.x.toFixed(2)}, wallX=${ox}, floorY=${bldWest.floorY})`,
      );
    }

    // 5b) Rotated -90° building solid back wall in poi_cabin_cluster (East 4x4 house, back wall at x = ox)
    {
      const clusterSite = siteMap.get('poi_cabin_cluster')!;
      const ox = clusterSite.center.x + 10;
      const oz = clusterSite.center.z + 1;
      // Start outside the east solid wall (x = ox + 1.5, z = oz + 2.0) and walk west (-X, yaw = +PI/2) into the solid wall
      const startX = ox + 1.5;
      const startZ = oz + 2.0;
      const body: Body = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      runSteps(body, Math.PI / 2, 60);
      assert.ok(
        body.pos.x > ox + PLAYER_RADIUS - 0.05,
        `Player must be blocked outside -90° rotated east building wall (x=${body.pos.x.toFixed(2)}, wallX=${ox})`,
      );
    }

    // 5c) Rotated 180° building solid wall in poi_service_station (Warehouse 8x4 rotated 180°, east wall at x = ox)
    {
      const serviceSite = siteMap.get('poi_service_station')!;
      const ox = serviceSite.center.x + 4;
      const oz = serviceSite.center.z - 3;
      // Start east of the warehouse wall at (ox + 1.5, oz - 2.0) and walk west (-X, yaw = +PI/2)
      const startX = ox + 1.5;
      const startZ = oz - 2.0;
      const body: Body = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };
      runSteps(body, Math.PI / 2, 60);
      assert.ok(
        body.pos.x > ox + PLAYER_RADIUS - 0.05,
        `Player must be blocked outside 180° rotated service warehouse wall (x=${body.pos.x.toFixed(2)}, wallX=${ox})`,
      );
    }

    // 5d) Solid tree collider & rock collider noclip prevention
    const treeCol = world.colliders.find((c) => c.tag === 'tree')!;
    const rockCol = world.colliders.find((c) => c.tag === 'rock')!;
    assert.ok(treeCol);
    assert.ok(rockCol);

    for (const obstacle of [treeCol, rockCol]) {
      const cx = (obstacle.min.x + obstacle.max.x) * 0.5;
      const startZ = obstacle.max.z + PLAYER_RADIUS + 1.2;
      const startY = sampleTerrainHeight(world.terrain, cx, startZ);
      if (!collidesAtWorld(world, cx, startY + 0.02, startZ, PLAYER_RADIUS, PLAYER_HEIGHT - 0.02)) {
        const body: Body = {
          pos: { x: cx, y: startY, z: startZ },
          vel: { x: 0, y: 0, z: 0 },
          onGround: true,
        };
        // Walk north (-Z, yaw = 0) directly into the tree/rock collider
        runSteps(body, 0, 45);
        assert.ok(
          body.pos.z >= obstacle.max.z + PLAYER_RADIUS - 0.02,
          `Player must be blocked outside ${obstacle.tag} collider ${obstacle.id}`,
        );
      }
    }

    // 5e) Steep > 42° cliff slope noclip/climb prevention on both forest_square crag and technical terrain fixture
    // Locate steepest point on NW Rocky Crag around (-108, -106)
    let maxCragSlope = 0;
    let steepX = -108;
    let steepZ = -100;
    for (let gz = -114; gz <= -98; gz += 0.5) {
      for (let gx = -116; gx <= -100; gx += 0.5) {
        const s = sampleTerrainSlopeDeg(world.terrain, gx, gz);
        if (s > maxCragSlope) {
          maxCragSlope = s;
          steepX = gx;
          steepZ = gz;
        }
      }
    }
    assert.ok(
      maxCragSlope > DEFAULT_MAX_WALKABLE_SLOPE_DEG,
      `Expected NW Rocky Crag max slope > ${DEFAULT_MAX_WALKABLE_SLOPE_DEG}°, got ${maxCragSlope.toFixed(2)}° at (${steepX}, ${steepZ})`,
    );
    const cragClimber: Body = {
      pos: { x: -108, y: sampleTerrainHeight(world.terrain, -108, -97), z: -97 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    runSteps(cragClimber, 0, 90); // Walk north (-Z) toward crag peak at (-108, -106)
    assert.ok(
      cragClimber.pos.z > -104.5,
      `Player must not climb up steep (>42°) NW crag peak at z=-106 (stopped at z=${cragClimber.pos.z.toFixed(2)})`,
    );

    // Also verify on technical terrain fixture steep ridge (slope ~61° > 42°)
    const techWorld = createTechnicalTerrainFixture();
    const techClimber: Body = {
      pos: { x: 0, y: sampleTerrainHeight(techWorld.terrain, 0, -15), z: -15 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    runSteps(techClimber, 0, 90, techWorld);
    assert.ok(techClimber.pos.z > -18.5, 'Player must be blocked by >42° ridge');
  });

  it('6. Authoritative Verticality — Jump, Gravity, Stairs, Loft & 2nd Floor Watchpost', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const layout = world.poiLayout;

    // 6a) Jump impulse (JUMP_SPEED), airborne gravity, and landing back on terrainHeightAtWorld
    {
      const x = 6;
      const z = -6;
      const groundY = sampleTerrainHeight(world.terrain, x, z);
      const jumper: Body = {
        pos: { x, y: groundY, z },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
      };

      stepPlayerMovement(
        jumper,
        {
          seq: 1,
          spawnId: 1,
          dt: FIXED_MOVE_DT,
          moveForward: 0,
          moveRight: 0,
          jump: true,
          walk: false,
          scoped: false,
          weapon: 'pistol',
          yaw: 0,
          pitch: 0,
        },
        world,
      );

      assert.equal(jumper.onGround, false, 'Player must leave ground on jump frame');
      assert.ok(
        Math.abs(jumper.vel.y - (JUMP_SPEED - GRAVITY * FIXED_MOVE_DT)) < 0.05,
        `Initial jump velocity should match JUMP_SPEED - GRAVITY*dt (got ${jumper.vel.y.toFixed(3)})`,
      );

      let maxAirY = jumper.pos.y;
      for (let seq = 2; seq <= 90; seq++) {
        stepPlayerMovement(
          jumper,
          {
            seq,
            spawnId: 1,
            dt: FIXED_MOVE_DT,
            moveForward: 0,
            moveRight: 0,
            jump: false,
            walk: false,
            scoped: false,
            weapon: 'pistol',
            yaw: 0,
            pitch: 0,
          },
          world,
        );
        maxAirY = Math.max(maxAirY, jumper.pos.y);
        if (jumper.onGround) break;
      }

      assert.ok(maxAirY > groundY + 1.1, `Jump apex (${maxAirY.toFixed(2)}m) must exceed ground + 1.1m`);
      assert.equal(jumper.onGround, true, 'Player must land back on terrain');
      const landedGroundY = sampleTerrainHeight(world.terrain, jumper.pos.x, jumper.pos.z);
      assert.ok(Math.abs(jumper.pos.y - landedGroundY) < 1e-3);
    }

    // 6b) Walk through open doorway of poi_ranger_house (cabin_8x4) and up interior stairs to loft (y = floorY + 3.0m)
    {
      const bldRanger = layout.buildings.find((b) => b.id === 'poi:poi_ranger_house:bld:0')!;
      const ox = bldRanger.origin.x;
      const oz = bldRanger.origin.z;
      const floorY = bldRanger.floorY;

      // Start outside south porch steps at (ox + 2.0, oz + 6.4) facing north (-Z, yaw = 0)
      const startX = ox + 2.0;
      const startZ = oz + 6.4;
      const auth = new PlayerMovementAuthority();
      auth.resetForSpawn(1);
      const player = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
        yaw: 0,
        pitch: 0,
        weapon: 'pistol' as const,
        scoped: false,
        reloadWeapon: null,
      };

      let seq = 0;
      const stepCmds = (yaw: number, frames: number) => {
        for (let i = 0; i < frames; i++) {
          seq++;
          auth.enqueueInputPacket(
            {
              seq,
              spawnId: 1,
              dt: FIXED_MOVE_DT,
              moveForward: 1,
              moveRight: 0,
              jump: false,
              walk: false,
              scoped: false,
              weapon: 'pistol',
              yaw,
              pitch: 0,
            },
            'pistol',
          );
          auth.stepAuthoritativeTick(player, FIXED_MOVE_DT, world);
        }
      };

      // Walk north (-Z, yaw = 0) through the open doorway into the cabin ground floor (z ~ oz + 1.85)
      stepCmds(0, 48);
      assert.ok(
        Math.abs(player.pos.y - floorY) < 0.05 && player.pos.z < oz + 3.2,
        `Player must enter poi_ranger_house ground floor via doorway (pos=${JSON.stringify(player.pos)}, floorY=${floorY})`,
      );

      // Walk west (-X, yaw = Math.PI / 2) to the stair base (x ~ ox + 0.52)
      stepCmds(Math.PI / 2, 50);
      // Walk north (-Z, yaw = 0) onto the bottom stair landing (z ~ oz + 0.85)
      stepCmds(0, 40);
      // Walk east (+X, yaw = -Math.PI / 2) up the interior stairs onto the 2nd floor loft (y = floorY + 3.0)
      stepCmds(-Math.PI / 2, 75);

      assert.ok(
        player.pos.x > ox + 4.4 &&
          Math.abs(player.pos.y - (floorY + 3.0)) < 0.06,
        `Authoritative player must reach 2nd-floor loft in poi_ranger_house at y=${(floorY + 3.0).toFixed(2)}m (got ${JSON.stringify(player.pos)})`,
      );
    }

    // 6c) Walk up exterior stairs of poi_cliff_watch (watchpost_4x4) onto 2nd-floor observation deck (y = floorY + 3.0m)
    {
      const bldWatch = layout.buildings.find((b) => b.id === 'poi:poi_cliff_watch:bld:0')!;
      const ox = bldWatch.origin.x;
      const oz = bldWatch.origin.z;
      const floorY = bldWatch.floorY;
      const startX = ox - 0.75;
      const startZ = oz + 4.6;

      const watchPlayer = {
        pos: { x: startX, y: sampleTerrainHeight(world.terrain, startX, startZ), z: startZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
        yaw: 0,
        pitch: 0,
        weapon: 'pistol' as const,
        scoped: false,
      };

      for (let seq = 1; seq <= 85 && watchPlayer.pos.z > oz - 0.5; seq++) {
        stepPlayerMovement(
          watchPlayer,
          {
            seq,
            spawnId: 1,
            dt: FIXED_MOVE_DT,
            moveForward: 1,
            moveRight: 0,
            jump: false,
            walk: false,
            scoped: false,
            weapon: 'pistol',
            yaw: 0, // facing -Z up the exterior west stairs
            pitch: 0,
          },
          world,
        );
      }

      assert.ok(
        Math.abs(watchPlayer.pos.y - (floorY + 3.0)) < 0.06,
        `Authoritative player must ascend poi_cliff_watch exterior stairs onto 2nd-floor deck at y=${(floorY + 3.0).toFixed(2)}m (got ${JSON.stringify(watchPlayer.pos)})`,
      );
    }
  });

  it('7. Tick-Rate Independence (30 Hz vs 60 Hz vs Variable dt)', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
    const startX = serviceSite.center.x - 10;
    const startZ = serviceSite.center.z + 8;
    const startY = sampleTerrainHeight(world.terrain, startX, startZ);

    const makeBody = (): Body => ({
      pos: { x: startX, y: startY, z: startZ },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    });

    const body60 = makeBody();
    for (let i = 1; i <= 60; i++) {
      stepPlayerMovement(
        body60,
        {
          seq: i,
          spawnId: 1,
          dt: 1 / 60,
          moveForward: 1,
          moveRight: 0,
          jump: false,
          walk: false,
          scoped: false,
          weapon: 'rifle',
          yaw: -Math.PI / 2,
          pitch: 0,
        },
        world,
      );
    }

    const body30 = makeBody();
    for (let i = 1; i <= 30; i++) {
      stepPlayerMovement(
        body30,
        {
          seq: i,
          spawnId: 1,
          dt: 1 / 30,
          moveForward: 1,
          moveRight: 0,
          jump: false,
          walk: false,
          scoped: false,
          weapon: 'rifle',
          yaw: -Math.PI / 2,
          pitch: 0,
        },
        world,
      );
    }

    // Variable frame steps: 20 cycles of [0.011s, 0.023s, 0.016s] = 1.000s total
    const bodyVar = makeBody();
    const varPattern = [0.011, 0.023, 0.016];
    let seq = 0;
    for (let cycle = 0; cycle < 20; cycle++) {
      for (const dt of varPattern) {
        seq++;
        stepPlayerMovement(
          bodyVar,
          {
            seq,
            spawnId: 1,
            dt,
            moveForward: 1,
            moveRight: 0,
            jump: false,
            walk: false,
            scoped: false,
            weapon: 'rifle',
            yaw: -Math.PI / 2,
            pitch: 0,
          },
          world,
        );
      }
    }

    const diff30vs60 = vdist(body30.pos, body60.pos);
    const diffVarVs60 = vdist(bodyVar.pos, body60.pos);

    assert.ok(
      diff30vs60 < 0.08,
      `30 Hz vs 60 Hz 1.0s position difference (${diff30vs60.toFixed(4)}m) must be < 0.08m`,
    );
    assert.ok(
      diffVarVs60 < 0.08,
      `Variable dt vs 60 Hz 1.0s position difference (${diffVarVs60.toFixed(4)}m) must be < 0.08m`,
    );
  });

  it('8. Duplicate, Old, Out-of-Order, Future seq, and Stale spawnId Rejection + Redundancy Batch Acceptance', () => {
    const auth = new PlayerMovementAuthority();
    auth.resetForSpawn(5);

    const makeCmd = (seq: number, spawnId = 5): PlayerInputCmd => ({
      seq,
      spawnId,
      dt: FIXED_MOVE_DT,
      moveForward: 1,
      moveRight: 0,
      jump: false,
      walk: false,
      scoped: false,
      weapon: 'rifle',
      yaw: 0,
      pitch: 0,
    });

    // 8a) Stale / wrong spawnId rejected
    const wrongSpawnRes = auth.enqueueInputPacket(makeCmd(1, 4), 'rifle');
    assert.equal(wrongSpawnRes.accepted, 0);
    assert.equal(wrongSpawnRes.rejected, 1);
    assert.equal(auth.stats.rejectedSpawnMismatch, 1);

    // 8b) Accept seq 1 and seq 2
    assert.equal(auth.enqueueInputPacket(makeCmd(1), 'rifle').accepted, 1);
    assert.equal(auth.enqueueInputPacket(makeCmd(2), 'rifle').accepted, 1);
    assert.equal(auth.lastQueuedSeq, 2);

    // 8c) Duplicate seq 2 rejected
    const dupRes = auth.enqueueInputPacket(makeCmd(2), 'rifle');
    assert.equal(dupRes.accepted, 0);
    assert.equal(dupRes.rejected, 1);
    assert.equal(auth.stats.rejectedDuplicateOrOld, 1);

    // 8d) Out-of-order descending seq 1 rejected (increments both rejectedDuplicateOrOld and rejectedOutOfOrder)
    const oldRes = auth.enqueueInputPacket(makeCmd(1), 'rifle');
    assert.equal(oldRes.accepted, 0);
    assert.equal(oldRes.rejected, 1);
    assert.equal(auth.stats.rejectedDuplicateOrOld, 2);
    assert.equal(auth.stats.rejectedOutOfOrder, 1);

    // 8e) Impossible future seq > lastQueuedSeq + MAX_INPUT_QUEUE_SIZE rejected
    const futureRes = auth.enqueueInputPacket(makeCmd(2 + MAX_INPUT_QUEUE_SIZE + 5), 'rifle');
    assert.equal(futureRes.accepted, 0);
    assert.equal(futureRes.rejected, 1);
    assert.equal(auth.stats.rejectedOutOfOrder, 2);

    // 8f) Valid redundancy batch [seq 1, seq 2, seq 3] cleanly skips already-queued [1, 2] and accepts [3] with 0 errors
    const prevDupCount = auth.stats.rejectedDuplicateOrOld;
    const prevOooCount = auth.stats.rejectedOutOfOrder;
    const batchRes = auth.enqueueInputPacket(
      {
        spawnId: 5,
        inputs: [makeCmd(1), makeCmd(2), makeCmd(3)],
      },
      'rifle',
    );
    assert.equal(batchRes.accepted, 1);
    assert.equal(batchRes.rejected, 0);
    assert.equal(auth.lastQueuedSeq, 3);
    assert.equal(
      auth.stats.rejectedDuplicateOrOld,
      prevDupCount,
      'Redundant prefix in valid batch must not trigger rejectedDuplicateOrOld',
    );
    assert.equal(
      auth.stats.rejectedOutOfOrder,
      prevOooCount,
      'Redundant prefix in valid batch must not trigger rejectedOutOfOrder',
    );
  });

  it('9. Client Prediction & Server Reconciliation under 0ms, 80ms, 150ms, 200ms RTT + 15% Packet Loss + Smooth & Hard Snap', () => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });
    const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
    const spawnX = serviceSite.center.x - 10;
    const spawnZ = serviceSite.center.z + 8;
    const spawnY = sampleTerrainHeight(world.terrain, spawnX, spawnZ);

    // 9a) 0ms, 80ms, 150ms, 200ms RTT with 0% loss -> 0 reconciliation error (corrected === false, snapped === false)
    for (const rttMs of [0, 80, 150, 200]) {
      const clientPred = new ClientPrediction();
      clientPred.resetForSpawn(1);
      const clientState: MovementState = {
        pos: { x: spawnX, y: spawnY, z: spawnZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
        yaw: -Math.PI / 2,
        pitch: 0,
        weapon: 'rifle',
        scoped: false,
      };

      const serverAuth = new PlayerMovementAuthority();
      serverAuth.resetForSpawn(1);
      const serverPlayer = {
        pos: { x: spawnX, y: spawnY, z: spawnZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
        yaw: -Math.PI / 2,
        pitch: 0,
        weapon: 'rifle' as const,
        scoped: false,
        reloadWeapon: null,
      };

      const delayFrames = Math.round((rttMs / 1000) * 60);
      const pendingSnaps: Array<{ deliverAtFrame: number; snap: PlayerSnap; tick: number }> = [];

      for (let frame = 1; frame <= 60; frame++) {
        const moveRight = frame > 30 ? 0.5 : 0;
        clientPred.recordAndStepInput(
          clientState,
          {
            dt: FIXED_MOVE_DT,
            moveForward: 1,
            moveRight,
            jump: frame === 15,
            walk: false,
            scoped: false,
            weapon: 'rifle',
            yaw: -Math.PI / 2,
            pitch: 0,
          },
          world,
        );

        const batch = clientPred.getBatchForSend(4);
        serverAuth.enqueueInputPacket({ spawnId: 1, inputs: batch }, 'rifle');
        serverAuth.stepAuthoritativeTick(serverPlayer, FIXED_MOVE_DT, world);

        const snap: PlayerSnap = {
          id: 'p1',
          x: Math.round(serverPlayer.pos.x * 1000) / 1000,
          y: Math.round(serverPlayer.pos.y * 1000) / 1000,
          z: Math.round(serverPlayer.pos.z * 1000) / 1000,
          vx: Math.round(serverPlayer.vel.x * 1000) / 1000,
          vy: Math.round(serverPlayer.vel.y * 1000) / 1000,
          vz: Math.round(serverPlayer.vel.z * 1000) / 1000,
          yaw: serverPlayer.yaw,
          pitch: serverPlayer.pitch,
          hp: MAX_HP,
          alive: true,
          weapon: serverPlayer.weapon,
          onGround: serverPlayer.onGround,
          reloading: false,
          spawnId: 1,
          lastProcessedInputSeq: serverAuth.lastProcessedSeq,
        };
        pendingSnaps.push({ deliverAtFrame: frame + delayFrames, snap, tick: frame });

        while (pendingSnaps.length > 0 && pendingSnaps[0].deliverAtFrame <= frame) {
          const item = pendingSnaps.shift()!;
          const res = clientPred.reconcileSnapshot(clientState, item.snap, item.tick, world);
          assert.equal(res.accepted, true);
          assert.equal(
            res.corrected,
            false,
            `RTT ${rttMs}ms frame ${frame}: deterministic prediction should need 0 correction (errorDist=${res.errorDist})`,
          );
          assert.equal(res.snapped, false);
        }
      }
    }

    // 9b) 150ms RTT + 25ms jitter + 15% packet loss with 4-command redundancy batches
    {
      const clientPred = new ClientPrediction();
      clientPred.resetForSpawn(1);
      const clientState: MovementState = {
        pos: { x: spawnX, y: spawnY, z: spawnZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
        yaw: -Math.PI / 2,
        pitch: 0,
        weapon: 'rifle',
        scoped: false,
      };

      const serverAuth = new PlayerMovementAuthority();
      serverAuth.resetForSpawn(1);
      const serverPlayer = {
        pos: { x: spawnX, y: spawnY, z: spawnZ },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
        yaw: -Math.PI / 2,
        pitch: 0,
        weapon: 'rifle' as const,
        scoped: false,
        reloadWeapon: null,
      };

      // Simulate 60 active movement frames + 12 stop frames (200ms stop)
      // Drop every 7th packet (~14.3% packet loss, never dropping 4 consecutive packets so 4-cmd redundancy recovers 100%)
      for (let frame = 1; frame <= 72; frame++) {
        const isMoving = frame <= 60;
        clientPred.recordAndStepInput(
          clientState,
          {
            dt: FIXED_MOVE_DT,
            moveForward: isMoving ? 1 : 0,
            moveRight: 0,
            jump: false,
            walk: false,
            scoped: false,
            weapon: 'rifle',
            yaw: -Math.PI / 2,
            pitch: 0,
          },
          world,
        );

        const batch = clientPred.getBatchForSend(4);
        const packetDropped = frame % 7 === 0 && frame < 72;
        if (!packetDropped) {
          serverAuth.enqueueInputPacket({ spawnId: 1, inputs: batch }, 'rifle');
        }

        // Server steps every 2 client frames (30 Hz server tick = 2 * 1/60s)
        if (frame % 2 === 0) {
          serverAuth.stepAuthoritativeTick(serverPlayer, 1 / 30, world);
        }
      }

      // Flush any remaining queued inputs on server
      serverAuth.stepAuthoritativeTick(serverPlayer, 1 / 30, world);

      assert.equal(
        serverAuth.lastProcessedSeq,
        72,
        '4-command redundancy batches must recover all 15% dropped packets without sequence gaps',
      );

      // Final snapshot reconciliation
      const finalSnap: PlayerSnap = {
        id: 'p1',
        x: Math.round(serverPlayer.pos.x * 1000) / 1000,
        y: Math.round(serverPlayer.pos.y * 1000) / 1000,
        z: Math.round(serverPlayer.pos.z * 1000) / 1000,
        vx: Math.round(serverPlayer.vel.x * 1000) / 1000,
        vy: Math.round(serverPlayer.vel.y * 1000) / 1000,
        vz: Math.round(serverPlayer.vel.z * 1000) / 1000,
        yaw: serverPlayer.yaw,
        pitch: serverPlayer.pitch,
        hp: MAX_HP,
        alive: true,
        weapon: serverPlayer.weapon,
        onGround: serverPlayer.onGround,
        reloading: false,
        spawnId: 1,
        lastProcessedInputSeq: serverAuth.lastProcessedSeq,
      };
      clientPred.reconcileSnapshot(clientState, finalSnap, 36, world);

      const finalConvergenceErr = vdist(clientState.pos, serverPlayer.pos);
      assert.ok(
        finalConvergenceErr < 0.01,
        `Client and server positions must converge within < 0.01m after 200ms stop (got ${finalConvergenceErr.toFixed(5)}m)`,
      );
    }

    // 9c) External server impulse (0.45m knockback) -> rewind & replay + smooth visual offset decay
    {
      const localPlayer = new LocalPlayer();
      localPlayer.setWorld(world);
      const spawnEv: SpawnEvent = {
        spawnId: 1,
        x: spawnX,
        y: spawnY,
        z: spawnZ,
        yaw: -Math.PI / 2,
        team: 'none',
      };
      localPlayer.spawn(spawnEv, 0);

      // Record 6 local prediction steps
      for (let i = 0; i < 6; i++) {
        localPlayer.move(FIXED_MOVE_DT, 1, 0, false, false);
      }

      // Server snapshot acknowledges seq 3, but with a +0.45m Z knockback impulse
      const knockedSnap: PlayerSnap = {
        id: 'p1',
        x: localPlayer.body.pos.x - 0.15,
        y: spawnY,
        z: spawnZ + 0.45,
        vx: localPlayer.body.vel.x,
        vy: 0,
        vz: 0,
        yaw: localPlayer.yaw,
        pitch: localPlayer.pitch,
        hp: 75,
        alive: true,
        weapon: 'rifle',
        onGround: true,
        reloading: false,
        spawnId: 1,
        lastProcessedInputSeq: 3,
      };

      const recRes = localPlayer.reconcile(knockedSnap, 10);
      assert.equal(recRes.accepted, true);
      assert.equal(recRes.corrected, true);
      assert.equal(recRes.snapped, false);
      assert.equal(recRes.replayedCount, 3, 'Must replay unacknowledged inputs seq 4..6');

      const diagAfterImpulse = localPlayer.prediction.getDiagnostics();
      assert.ok(diagAfterImpulse.smoothOffsetMag > 0.1, 'Smooth visual offset must be active');
      assert.equal(diagAfterImpulse.smoothCorrectionCount, 1);

      // Step 25 more frames and verify smoothOffsetMag decays toward 0 without ever colliding
      let prevOffset = diagAfterImpulse.smoothOffsetMag;
      for (let i = 0; i < 25; i++) {
        localPlayer.move(FIXED_MOVE_DT, 1, 0, false, false);
        const smoothed = localPlayer.smoothedPos();
        assert.equal(
          collidesAtWorld(world, smoothed.x, smoothed.y + 0.02, smoothed.z, PLAYER_RADIUS, PLAYER_HEIGHT - 0.02),
          false,
          'Smoothed visual position must never clip into world colliders',
        );
      }
      const diagAfterDecay = localPlayer.prediction.getDiagnostics();
      assert.ok(
        diagAfterDecay.smoothOffsetMag < prevOffset * 0.02,
        `Smooth offset must decay exponentially toward 0 (before=${prevOffset}, after=${diagAfterDecay.smoothOffsetMag})`,
      );

      // 9d) Massive discrepancy (> RECONCILE_SNAP_THRESHOLD = 3.5m) -> hard snap
      const hardSnapMsg: PlayerSnap = {
        ...knockedSnap,
        x: localPlayer.body.pos.x + RECONCILE_SNAP_THRESHOLD + 2.0,
        lastProcessedInputSeq: localPlayer.prediction.getDiagnostics().currentSeq,
      };
      const snapRes = localPlayer.reconcile(hardSnapMsg, 20);
      assert.equal(snapRes.accepted, true);
      assert.equal(snapRes.corrected, true);
      assert.equal(snapRes.snapped, true);
      assert.equal(localPlayer.prediction.getDiagnostics().smoothOffsetMag, 0);
      assert.equal(localPlayer.prediction.getDiagnostics().hardSnapCount, 1);
    }
  });

  it('10. Multi-Room Isolation & Respawn / Rejoin Reset', () => {
    const { io: ioA } = createFakeIo();
    const { io: ioB } = createFakeIo();

    const roomA = new Room(
      {
        name: 'Room A',
        mode: 'tdm',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
      },
      ioA,
      () => {},
    );
    const roomB = new Room(
      {
        name: 'Room B',
        mode: 'tdm',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
      },
      ioB,
      () => {},
    );

    try {
      const sockA = createFakeSocket('playerA');
      const sockB = createFakeSocket('playerB');
      roomA.addHuman(sockA.socket, 'Alice');
      roomB.addHuman(sockB.socket, 'Bob');

      roomA.onReady('playerA', { world: roomA.worldMeta() });
      roomB.onReady('playerB', { world: roomB.worldMeta() });

      const pA = roomA.players.get('playerA')!;
      const pB = roomB.players.get('playerB')!;
      const bStartPos = { ...pB.pos };

      // Move playerA in roomA for 10 ticks; do not touch roomB
      for (let seq = 1; seq <= 10; seq++) {
        roomA.onInput('playerA', {
          seq,
          spawnId: pA.spawnId,
          dt: 1 / 30,
          moveForward: 1,
          moveRight: 0,
          jump: false,
          walk: false,
          scoped: false,
          weapon: 'rifle',
          yaw: pA.yaw,
          pitch: 0,
        });
        stepRoomTick(roomA, 1 / 30);
      }

      assert.equal(roomA.serverTick, 10);
      assert.equal(roomB.serverTick, 0, 'Room B serverTick must be completely isolated from Room A');
      assert.deepEqual(pB.pos, bStartPos, 'Room B player position must be untouched by Room A movement');
      assert.equal(pA.authority.lastProcessedSeq, 10);
      assert.equal(pB.authority.lastProcessedSeq, 0);

      // Respawn playerA -> spawnId increments from 1 to 2, authority resets
      const oldSpawnId = pA.spawnId;
      roomA.spawn(pA);
      assert.equal(pA.spawnId, oldSpawnId + 1);
      assert.equal(pA.authority.lastProcessedSeq, 0);
      assert.equal(pA.authority.queue.length, 0);

      // Sending an old input with stale spawnId=1 must be rejected with rejectedSpawnMismatch
      roomA.onInput('playerA', {
        seq: 11,
        spawnId: oldSpawnId,
        dt: 1 / 30,
        moveForward: 1,
        moveRight: 0,
        jump: false,
        walk: false,
        scoped: false,
        weapon: 'rifle',
        yaw: 0,
        pitch: 0,
      });
      const statsA = roomA.getPlayerAuthorityStats('playerA')!;
      assert.equal(statsA.rejectedSpawnMismatch, 1);
      assert.equal(pA.authority.queue.length, 0);

      // ClientPrediction.resetForSpawn(newSpawnId) clears old prediction history
      const pred = new ClientPrediction();
      pred.resetForSpawn(oldSpawnId);
      const dummyState: MovementState = {
        pos: { ...pA.pos },
        vel: { x: 0, y: 0, z: 0 },
        onGround: true,
        yaw: 0,
        pitch: 0,
        weapon: 'rifle',
        scoped: false,
      };
      pred.recordAndStepInput(
        dummyState,
        {
          dt: FIXED_MOVE_DT,
          moveForward: 1,
          moveRight: 0,
          jump: false,
          walk: false,
          scoped: false,
          weapon: 'rifle',
          yaw: 0,
          pitch: 0,
        },
        roomA.world,
      );
      assert.equal(pred.getDiagnostics().pendingInputs, 1);
      pred.resetForSpawn(pA.spawnId);
      const resetDiag = pred.getDiagnostics();
      assert.equal(resetDiag.spawnId, pA.spawnId);
      assert.equal(resetDiag.currentSeq, 0);
      assert.equal(resetDiag.lastAckedSeq, 0);
      assert.equal(resetDiag.pendingInputs, 0);
    } finally {
      roomA.destroy();
      roomB.destroy();
    }
  });

  it('11. Authoritative Combat & Bot Integration (room.onShoot rejects fake origin > 2.5m & confirms true eye hits)', () => {
    const { io, emitted } = createFakeIo();
    const room = new Room(
      {
        name: 'Combat Authority Room',
        mode: 'ffa',
        bots: 1,
        maxPlayers: 8,
        timeLimit: 10,
        scoreLimit: 25,
        mapId: 'forest_square',
        publicLayoutSeed: 6501,
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

      // Place shooter and target on opposite sides of the solid east wall of poi_ranger_house
      const bldRanger = room.world.stage04aLayout?.buildings.find(
        (b) => b.id === 'poi:poi_ranger_house:bld:0',
      )!;
      assert.ok(bldRanger);
      const ox = bldRanger.origin.x;
      const oz = bldRanger.origin.z;
      const floorY = bldRanger.floorY;

      // Shooter is inside cabin at (ox + 6.0, floorY, oz + 2.0); solid east wall is at x = ox + 8.0
      shooter.pos = { x: ox + 6.0, y: floorY, z: oz + 2.0 };
      shooter.yaw = -Math.PI / 2;
      shooter.pitch = 0;
      shooter.spawnTime = -99;
      shooter.lastShot = -99;

      // Target is outside east of the solid wall at (ox + 11.5, groundY, oz + 2.0)
      const targetX = ox + 11.5;
      const targetZ = oz + 2.0;
      target.pos = {
        x: targetX,
        y: sampleTerrainHeight(room.world.terrain, targetX, targetZ),
        z: targetZ,
      };
      target.spawnTime = -99;
      target.hp = MAX_HP;

      // Verify wall actually blocks ray from shooter's authoritative eye to target's chest
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
      const dirToTarget = vnorm(vsub(targetChest, shooterEye));
      const wallCheck = raycastWorld(
        room.world,
        shooterEye,
        dirToTarget,
        vdist(targetChest, shooterEye),
      );
      assert.ok(wallCheck && wallCheck.kind === 'collider', 'Solid cabin wall must lie between shooter and target');

      // 11a) Cheater claims fake origin outside the wall right in front of target (5.0m away from shooter.pos)
      const fakeOrigin: Vec3 = {
        x: ox + 10.2,
        y: target.pos.y + 1.0,
        z: targetZ,
      };
      const fakeDir = vnorm(vsub(targetChest, fakeOrigin));
      room.onShoot('shooter1', {
        weapon: 'rifle',
        origin: fakeOrigin,
        dirs: [fakeDir],
      });

      // Server must ignore fakeOrigin, clamp origin to shooterEye, hit the wall, and deal 0 damage to target
      assert.equal(
        target.hp,
        MAX_HP,
        'Shot with spoofed origin behind a wall must be evaluated from authoritative shooter.pos and blocked by wall',
      );
      const lastShotEv = emitted.filter((e) => e.event === 'shot').pop()?.payload as ShotEvent | undefined;
      assert.ok(lastShotEv);
      assert.ok(
        vdist(lastShotEv.origin, shooterEye) < 1e-4,
        'ShotEvent origin must equal authoritative shooter eye position, not fake client origin',
      );

      // 11b) Move shooter to an unobstructed position in the flat courtyard with clear line-of-sight to target
      const serviceSite = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
      const clearX1 = serviceSite.center.x - 8;
      const clearZ1 = serviceSite.center.z + 8;
      const clearX2 = serviceSite.center.x - 2;
      const clearZ2 = serviceSite.center.z + 8;

      shooter.pos = {
        x: clearX1,
        y: sampleTerrainHeight(room.world.terrain, clearX1, clearZ1),
        z: clearZ1,
      };
      target.pos = {
        x: clearX2,
        y: sampleTerrainHeight(room.world.terrain, clearX2, clearZ2),
        z: clearZ2,
      };
      shooter.lastShot = -99;

      const trueEye: Vec3 = {
        x: shooter.pos.x,
        y: shooter.pos.y + EYE_HEIGHT,
        z: shooter.pos.z,
      };
      const trueTargetChest: Vec3 = {
        x: target.pos.x,
        y: target.pos.y + 1.0,
        z: target.pos.z,
      };
      const trueDir = vnorm(vsub(trueTargetChest, trueEye));
      shooter.yaw = Math.atan2(-trueDir.x, -trueDir.z);
      shooter.pitch = Math.asin(Math.max(-1, Math.min(1, trueDir.y)));

      room.onShoot('shooter1', {
        weapon: 'rifle',
        origin: trueEye,
        dirs: [trueDir],
      });

      assert.ok(target.hp < MAX_HP, `Legitimate shot from true eye position must damage target (hp=${target.hp})`);
      const hitConfirms = sock1.events.filter((e) => e.event === 'hitConfirm');
      assert.equal(hitConfirms.length, 1, 'Shooter must receive hitConfirm event');
      const hc = hitConfirms[0].payload as HitConfirm;
      assert.equal(hc.target, 'target2');
      assert.ok(hc.damage > 0);

      // 11c) Verify bot ticks alongside authoritative human players and snapshots include Stage 05 fields
      stepRoomTick(room, 1 / 30);
      const lastSnap = emitted.filter((e) => e.event === 'snap').pop()?.payload as Snapshot | undefined;
      assert.ok(lastSnap);
      assert.ok((lastSnap.serverTick ?? 0) >= 1);
      const shooterSnap = lastSnap.players.find((p) => p.id === 'shooter1')!;
      assert.ok(shooterSnap);
      assert.equal(shooterSnap.spawnId, shooter.spawnId);
      assert.equal(typeof shooterSnap.lastProcessedInputSeq, 'number');
    } finally {
      room.destroy();
    }
  });
});
