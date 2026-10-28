import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';
import {
  CROUCH_EYE_HEIGHT,
  CROUCH_HEIGHT,
  CROUCH_SPEED,
  EYE_HEIGHT,
  MAX_HP,
  PLAYER_RADIUS,
  RUN_SPEED,
  STRAFE_SPEED_MUL,
  WALK_SPEED,
} from '../constants';
import { getForestSquarePoiSites } from '../forestSquare';
import { vdist, vnorm, vsub, type Vec3 } from '../math';
import {
  cloneMovementState,
  computeWishVelocity,
  extractSanitizedInputBatch,
  resolveStance,
  sanitizePlayerInputCmd,
  stepNeutralMovement,
  stepPlayerMovement,
  type MovementState,
} from '../netMovement';
import { rayVsPlayer } from '../physics';
import type { HitConfirm, PlayerInputCmd, ShotEvent, Snapshot } from '../protocol';
import { WEAPONS } from '../weapons';
import { createWorldDefinition, sampleTerrainHeight } from '../world';
import { boxCollider, makeFlatWorld } from './flatWorldFixture';

// ---------------- Yordamchilar ----------------

const DT = 1 / 60;

function cmd(seq: number, over: Partial<PlayerInputCmd> = {}): PlayerInputCmd {
  return {
    seq,
    spawnId: 1,
    dt: DT,
    moveForward: 0,
    moveRight: 0,
    jump: false,
    walk: false,
    crouch: false,
    scoped: false,
    weapon: 'rifle',
    yaw: 0,
    pitch: 0,
    ...over,
  };
}

function freshState(x = 0, y = 0, z = 0): MovementState {
  return {
    pos: { x, y, z },
    vel: { x: 0, y: 0, z: 0 },
    onGround: true,
    yaw: 0,
    pitch: 0,
    weapon: 'rifle',
    scoped: false,
    stamina: 1,
    staminaLocked: false,
  };
}

const close = (a: number, b: number, eps: number, msg: string) =>
  assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

/** Pastki yuzasi 1.5 m da bo'lgan shift (overhang): z ∈ [-6, -2], x ∈ [-3, 3]. yaw=0 da oldinga — −z. */
const SLAB_MIN_Y = 1.5;
const slabWorld = makeFlatWorld([boxCollider('slab', { x: -3, y: SLAB_MIN_Y, z: -6 }, { x: 3, y: 2.0, z: -2 })]);

// ---------------- Soxta Socket.IO ----------------

interface EmittedEvent {
  event: string;
  payload: unknown;
}

function createFakeIo(): { io: Server; emitted: EmittedEvent[] } {
  const emitted: EmittedEvent[] = [];
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

/** O'ziga (`emit`) va xonaga (`to().emit`) yuborilgan hodisalarni yozib boradigan soxta socket. */
function createRecordingSocket(id: string): { socket: Socket; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const socket = {
    id,
    join() {},
    leave() {},
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
  return { socket, events };
}

function makeRoom(io: Server): Room {
  return new Room(
    {
      name: 'Stage17 crouch',
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
}

function stepRoomTick(room: Room, dtSec = 1 / 30): void {
  const internal = room as unknown as { lastTick: number; tick: () => void };
  internal.lastTick = room.now() - dtSec;
  internal.tick();
}

function lastSnapOf(emitted: EmittedEvent[], id: string) {
  const snap = emitted.filter((e) => e.event === 'snap').pop()?.payload as Snapshot | undefined;
  assert.ok(snap, 'snap yuborilgan');
  const sp = snap.players.find((p) => p.id === id);
  assert.ok(sp, `${id} snapshotda bor`);
  return sp;
}

function aimAngles(dir: Vec3): { yaw: number; pitch: number } {
  return { yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))) };
}

// ---------------- Testlar ----------------

describe("Bosqich 17 — o'tirish (crouch): umumiy simulyatsiya + server", () => {
  it('a) sanitize: crouch yo‘q — false, truthy — true; batch ham saqlaydi', () => {
    const raw = { ...cmd(1) } as Record<string, unknown>;
    delete raw.crouch;
    assert.equal(sanitizePlayerInputCmd(raw)!.crouch, false, 'eski klient — tik turish');
    assert.equal(sanitizePlayerInputCmd({ ...raw, crouch: true })!.crouch, true);
    assert.equal(sanitizePlayerInputCmd({ ...raw, crouch: 1 })!.crouch, true, 'truthy qiymat');
    assert.equal(sanitizePlayerInputCmd({ ...raw, crouch: 0 })!.crouch, false);
    const batch = extractSanitizedInputBatch({ spawnId: 1, inputs: [{ ...raw, crouch: true }, { ...raw, seq: 2 }] });
    assert.ok(batch);
    assert.deepEqual(
      batch.inputs.map((c) => c.crouch),
      [true, false],
    );
    // cloneMovementState holatni ham ko'chiradi
    const st = freshState();
    st.crouched = true;
    assert.equal(cloneMovementState(st).crouched, true);
    assert.equal(cloneMovementState(freshState()).crouched, false);
  });

  it('b) o‘tirib yurish tezligi CROUCH_SPEED × qurol; Shift sprint bermaydi va staminani sarflamaydi', () => {
    const world = makeFlatWorld([]);
    const st = freshState();
    st.stamina = 0.5;
    let seq = 0;
    for (let i = 0; i < 120; i++) {
      stepPlayerMovement(st, cmd(++seq, { moveForward: 1, walk: true, crouch: true }), world);
    }
    const expected = CROUCH_SPEED * WEAPONS.rifle.speedMul;
    assert.equal(st.crouched, true);
    close(Math.hypot(st.vel.x, st.vel.z), expected, 1e-6, 'barqaror o‘tirib yurish tezligi');
    assert.ok((st.stamina ?? 0) > 0.5 + 0.1, `o‘tirganda stamina tiklanadi: ${st.stamina}`);
    const z0 = st.pos.z;
    for (let i = 0; i < 60; i++) {
      stepPlayerMovement(st, cmd(++seq, { moveForward: 1, walk: true, crouch: true }), world);
    }
    close(z0 - st.pos.z, expected, 1e-3, '1 s da bosib o‘tilgan masofa');

    // computeWishVelocity: crouched — sprintsiz CROUCH_SPEED, yo'nalish ko'paytuvchisi saqlanadi
    const base = { scoped: false, weapon: null as null, yaw: 0, walk: true };
    const unarmed = computeWishVelocity({ ...base, moveForward: 0, moveRight: 0 }).maxSpeed / WALK_SPEED;
    close(
      computeWishVelocity({ ...base, moveForward: 0, moveRight: 1 }, true).maxSpeed,
      CROUCH_SPEED * STRAFE_SPEED_MUL * unarmed,
      1e-9,
      'o‘tirib yon',
    );
    close(computeWishVelocity({ ...base, moveForward: 1, moveRight: 0 }).maxSpeed, RUN_SPEED * unarmed, 1e-9, 'standart — sprint o‘zgarmagan');
    close(computeWishVelocity({ ...base, moveForward: 1, moveRight: 0 }, true).maxSpeed, CROUCH_SPEED * unarmed, 1e-9, 'o‘tirganda Shift sprint bermaydi');
    close(computeWishVelocity({ ...base, moveForward: 0, moveRight: 0 }, true).maxSpeed, CROUCH_SPEED * unarmed, 1e-9, 'kirishsiz maxSpeed');
    assert.ok(CROUCH_SPEED < WALK_SPEED);

    // Ochiq joyda qo'yib yuborilsa — darhol turadi va Shift yana sprint beradi
    const stBefore = st.stamina ?? 0;
    stepPlayerMovement(st, cmd(++seq, { moveForward: 1, walk: true, crouch: false }), world);
    assert.equal(st.crouched, false, 'tepada joy bor — turadi');
    for (let i = 0; i < 60; i++) {
      stepPlayerMovement(st, cmd(++seq, { moveForward: 1, walk: true, crouch: false }), world);
    }
    close(Math.hypot(st.vel.x, st.vel.z), RUN_SPEED * WEAPONS.rifle.speedMul, 1e-6, 'turgach sprint');
    assert.ok((st.stamina ?? 1) < stBefore, 'sprint staminani sarflaydi');
  });

  it('c) o‘tirgan o‘yinchi 1.5 m shift ostidan o‘tadi, ostida tura olmaydi, chiqqach turadi', () => {
    assert.ok(CROUCH_HEIGHT < SLAB_MIN_Y, 'o‘tirgan kapsula shift ostiga sig‘adi');
    // Tik turgan o'yinchi shiftga to'qnashadi
    const standing = freshState();
    let seq = 0;
    for (let i = 0; i < 120; i++) stepPlayerMovement(standing, cmd(++seq, { moveForward: 1 }), slabWorld);
    assert.ok(standing.pos.z > -2 + PLAYER_RADIUS - 0.01, `tik turgan to‘siladi: z=${standing.pos.z}`);
    assert.ok(!standing.crouched, 'tik turgan holat');

    // O'tirgan o'yinchi ostiga kiradi
    const st = freshState();
    seq = 0;
    for (let i = 0; i < 600 && st.pos.z > -4; i++) {
      stepPlayerMovement(st, cmd(++seq, { moveForward: 1, crouch: true }), slabWorld);
    }
    assert.ok(st.pos.z <= -4, `o‘tirgan o‘yinchi shift ostiga kirdi: z=${st.pos.z}`);
    close(st.pos.y, 0, 1e-6, 'oyoq yerda');

    // Ostida tugma qo'yib yuborildi — o'tirgan holat saqlanadi
    for (let i = 0; i < 30; i++) stepPlayerMovement(st, cmd(++seq, { crouch: false }), slabWorld);
    assert.equal(st.crouched, true, 'shift ostida turib bo‘lmaydi');
    const probe = cloneMovementState(st);
    resolveStance(probe, false, slabWorld);
    assert.equal(probe.crouched, true, 'resolveStance ham turg‘izmaydi');

    // Kirishsiz (starvation) qadam holatni o'zgartirmaydi va kapsula pastligicha qoladi
    const neutral = cloneMovementState(st);
    neutral.vel.x = 1.5;
    stepNeutralMovement(neutral, DT, slabWorld);
    assert.equal(neutral.crouched, true);
    close(neutral.pos.y, 0, 1e-6, 'neytral qadamda shift itarib yubormaydi');

    // Shift ostida o'tirib sakrash: bosh shiftga tegadi (≤ 1.5 − 1.25 m)
    const jumper = cloneMovementState(st);
    let maxY = 0;
    let jseq = 1000;
    stepPlayerMovement(jumper, cmd(++jseq, { jump: true, crouch: true }), slabWorld);
    for (let i = 0; i < 60; i++) {
      stepPlayerMovement(jumper, cmd(++jseq, { crouch: true }), slabWorld);
      maxY = Math.max(maxY, jumper.pos.y);
    }
    assert.ok(maxY > 0.05 && maxY <= SLAB_MIN_Y - CROUCH_HEIGHT + 1e-3, `o‘tirib sakrash shiftgacha: ${maxY}`);
    assert.equal(jumper.crouched, true);

    // Tugmasiz oldinga — shift ostida o'tirgan holda yuradi, chiqqach turadi
    let stoodUnderSlab = false;
    for (let i = 0; i < 600 && st.crouched; i++) {
      const zBefore = st.pos.z;
      stepPlayerMovement(st, cmd(++seq, { moveForward: 1, crouch: false }), slabWorld);
      if (!st.crouched && zBefore + PLAYER_RADIUS > -6) stoodUnderSlab = true;
    }
    assert.equal(st.crouched, false, 'shiftdan chiqqach turadi');
    assert.equal(stoodUnderSlab, false, 'shift ostida hech qachon turmagan');
    assert.ok(st.pos.z + PLAYER_RADIUS < -6 + 0.1, `turish nuqtasi shiftdan tashqarida: z=${st.pos.z}`);

    // Ochiq joyda o'tirib sakrash ruxsat: holat o'tirganligicha qoladi
    const open = freshState(0, 0, 10);
    stepPlayerMovement(open, cmd(1, { jump: true, crouch: true }), slabWorld);
    assert.ok(open.vel.y > 0, 'sakrash boshlandi');
    assert.equal(open.crouched, true);
  });

  it('d) rayVsPlayer: o‘tirgan o‘yinchining xitbokslari pastroq', () => {
    const feet = { x: 0, y: 0, z: 0 };
    const dir = { x: 1, y: 0, z: 0 };
    const at = (y: number) => ({ x: -5, y, z: 0 });
    // 1.6 m — tik turganda bosh, o'tirganda tepadan o'tadi
    const standHead = rayVsPlayer(at(1.6), dir, feet, 50);
    assert.equal(standHead?.zone, 'head');
    assert.deepEqual(rayVsPlayer(at(1.6), dir, feet, 50, false), standHead, 'standart parametr — tik turish');
    assert.equal(rayVsPlayer(at(1.6), dir, feet, 50, true), null, 'o‘tirgan o‘yinchi ustidan o‘tadi');
    // 1.05 m — o'tirgan bosh, tik turgan tana
    const crouchHead = rayVsPlayer(at(1.05), dir, feet, 50, true);
    assert.ok(crouchHead);
    assert.equal(crouchHead.zone, 'head');
    assert.equal(crouchHead.head, true);
    assert.equal(rayVsPlayer(at(1.05), dir, feet, 50)?.zone, 'torso');
    // 0.7 m — tik turganda oyoq, o'tirganda tana; 0.4 m — ikkalasida oyoq
    assert.equal(rayVsPlayer(at(0.7), dir, feet, 50)?.zone, 'legs');
    assert.equal(rayVsPlayer(at(0.7), dir, feet, 50, true)?.zone, 'torso');
    assert.equal(rayVsPlayer(at(0.4), dir, feet, 50, true)?.zone, 'legs');
  });

  it('e) Room: crouch kirishi snapshotda crouched=true; o‘q chiqish nuqtasi va qurbon xitboksi o‘tirishga mos', () => {
    const { io, emitted } = createFakeIo();
    const room = makeRoom(io);
    try {
      const s1 = createRecordingSocket('shooter1');
      const s2 = createRecordingSocket('target2');
      room.addHuman(s1.socket, 'Shooter');
      room.addHuman(s2.socket, 'Target');
      room.onReady('shooter1', { world: room.worldMeta() });
      room.onReady('target2', { world: room.worldMeta() });
      const shooter = room.players.get('shooter1')!;
      const target = room.players.get('target2')!;
      assert.equal(shooter.crouched, false, 'spawn — tik turgan');

      // Servis stansiyasi hovlisi: ochiq, tekis joy
      const site = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
      const place = (x: number, z: number) => ({ x, y: sampleTerrainHeight(room.world.terrain, x, z), z });
      shooter.pos = place(site.center.x - 8, site.center.z + 8);
      target.pos = place(site.center.x - 2, site.center.z + 8);
      for (const p of [shooter, target]) {
        p.vel = { x: 0, y: 0, z: 0 };
        p.onGround = true;
        p.spawnTime = -99;
      }

      stepRoomTick(room);
      assert.equal('crouched' in lastSnapOf(emitted, 'shooter1'), false, 'tik turganda maydon yuborilmaydi');

      let shooterSeq = 0;
      let targetSeq = 0;
      const send = (id: string, seq: number, spawnId: number, crouch: boolean) =>
        room.onInput(id, { ...cmd(seq, { crouch, dt: 1 / 30 }), spawnId });

      send('shooter1', ++shooterSeq, shooter.spawnId, true);
      stepRoomTick(room);
      assert.equal(shooter.crouched, true, 'server o‘tirgan holatni qabul qildi');
      assert.equal(lastSnapOf(emitted, 'shooter1').crouched, true, 'snapshotda crouched: true');

      // Kirish kelmasa ham (starvation zaxira qadami bilan birga) holat saqlanadi
      shooter.vel.y = 2;
      shooter.onGround = false;
      const starvBefore = room.getPlayerAuthorityStats('shooter1')!.starvationSteps;
      for (let i = 0; i < 20; i++) stepRoomTick(room);
      assert.ok(room.getPlayerAuthorityStats('shooter1')!.starvationSteps > starvBefore, 'zaxira qadam ishladi');
      assert.equal(shooter.crouched, true, 'kirishsiz tick’larda o‘tirgan holat saqlanadi');
      assert.equal(shooter.onGround, true, 'qo‘ndi');
      assert.equal(lastSnapOf(emitted, 'shooter1').crouched, true);

      // O'q chiqish nuqtasi — o'tirgan ko'z balandligi
      const crouchEye = { x: shooter.pos.x, y: shooter.pos.y + CROUCH_EYE_HEIGHT, z: shooter.pos.z };
      const chest = { x: target.pos.x, y: target.pos.y + 1.0, z: target.pos.z };
      const fireAt = (eye: Vec3, aimPoint: Vec3) => {
        const dir = vnorm(vsub(aimPoint, eye));
        const { yaw, pitch } = aimAngles(dir);
        shooter.yaw = yaw;
        shooter.pitch = pitch;
        shooter.lastShot = -99;
        s1.events.length = 0;
        room.onShoot('shooter1', { weapon: 'rifle', origin: eye, dirs: [dir] });
        const shot = s1.events.filter((e) => e.event === 'shot').pop()?.payload as ShotEvent | undefined;
        assert.ok(shot, 'shot hodisasi');
        return shot;
      };
      target.hp = MAX_HP;
      const shot1 = fireAt(crouchEye, chest);
      assert.ok(vdist(shot1.origin, crouchEye) < 1e-9, `origin o‘tirgan ko‘zdan: y=${shot1.origin.y}`);
      assert.ok(Math.abs(shot1.origin.y - (shooter.pos.y + EYE_HEIGHT)) > 0.4, 'tik turgan ko‘z emas');
      assert.ok(target.hp < MAX_HP, 'o‘tirgan otuvchi nishonga tegdi');

      // Otuvchi turadi, nishon o'tiradi
      send('shooter1', ++shooterSeq, shooter.spawnId, false);
      send('target2', ++targetSeq, target.spawnId, true);
      stepRoomTick(room);
      assert.equal(shooter.crouched, false, 'ochiq joyda turdi');
      assert.equal(target.crouched, true);
      assert.equal(lastSnapOf(emitted, 'target2').crouched, true);
      assert.equal('crouched' in lastSnapOf(emitted, 'shooter1'), false);

      const standEye = { x: shooter.pos.x, y: shooter.pos.y + EYE_HEIGHT, z: shooter.pos.z };
      target.hp = MAX_HP;
      const shot2 = fireAt(standEye, { x: target.pos.x, y: target.pos.y + 1.6, z: target.pos.z });
      assert.ok(vdist(shot2.origin, standEye) < 1e-9, 'tik turgan ko‘z');
      assert.equal(target.hp, MAX_HP, 'tik turgan bosh balandligidagi o‘q o‘tirgan nishon ustidan o‘tadi');

      fireAt(standEye, { x: target.pos.x, y: target.pos.y + 1.05, z: target.pos.z });
      assert.ok(target.hp < MAX_HP, 'o‘tirgan boshga tegdi');
      const hc = s1.events.find((e) => e.event === 'hitConfirm')?.payload as HitConfirm | undefined;
      assert.ok(hc, 'hitConfirm');
      assert.equal(hc.headshot, true, 'o‘tirgan bosh — headshot');

      // Qayta tug'ilish tik turgan holatda
      room.spawn(target);
      assert.equal(target.crouched, false);
    } finally {
      room.destroy();
    }
  });

  it('f) determinizm: forest_square seed 6501 gameplayHash o‘zgarmagan', () => {
    const w = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 });
    assert.equal(w.gameplayHash, 'a746d9f39e5ba0b2');
  });
});
