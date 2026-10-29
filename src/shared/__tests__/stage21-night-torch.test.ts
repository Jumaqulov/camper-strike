import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import { MAX_HP, RUN_SPEED, WALK_SPEED } from '../constants';
import type { ChatMsg, CreateRoomOpts, PlayerInputCmd, Snapshot } from '../protocol';
import { computeWishVelocity, stepPlayerMovement } from '../netMovement';
import { getForestSquarePoiSites } from '../structures/contracts';
import { createWorldDefinition, sampleTerrainHeight, type WorldDefinition } from '../world';
import {
  CAMPFIRE_RADIUS_M,
  TORCH_BURN_SEC,
  TORCH_FEAR_RADIUS_M,
  TORCH_FUEL_COST_SEC,
  WOOD_CARRY_MAX,
  WOOD_SPEED_MUL,
  isTorchWeapon,
  woodBlocksSprint,
  woodSpeedMul,
  type CampActionAck,
  type WolfBiteEvent,
} from '../wolf';

// Bosqich 21 — Tong otguncha: o'tinning og'irligi (sprint yo'q, tezlik ko'paytuvchisi) va mash'al.
// Xona haqiqiy Room, io/socket soxta; vaqt room.advanceTimeForTest bilan deterministik suriladi.

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

function createFakeSocket(id: string): { socket: Socket; events: { event: string; payload: unknown }[] } {
  const events: { event: string; payload: unknown }[] = [];
  const socket = {
    id,
    join() {},
    leave() {},
    emit(event: string, payload: unknown) {
      events.push({ event, payload });
    },
    to() {
      return { emit() {} };
    },
  } as unknown as Socket;
  return { socket, events };
}

function makeNightRoom(io: Server, overrides: Partial<CreateRoomOpts> = {}): Room {
  return new Room(
    {
      name: 'Tong otguncha',
      mode: 'wolf_night',
      mapId: 'forest_square',
      bots: 0,
      maxPlayers: 8,
      timeLimit: 4,
      scoreLimit: 1,
      publicLayoutSeed: 6501,
      countdownSec: 2,
      wolves: 0,
      ...overrides,
    },
    io,
    () => {},
  );
}

/** Yakka odam tayyor bo'lib raundni boshlaydi (sanoq 2 s). */
function startSoloNight(room: Room, id = 'p1', name = 'Ovchi') {
  const s = createFakeSocket(id);
  room.addHuman(s.socket, name);
  room.onReady(id, { world: room.worldMeta() });
  assert.equal(room.phase, 'countdown');
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  const p = room.players.get(id)!;
  p.spawnTime = -99;
  return { socket: s, p };
}

/** Vaqtni suradi; `keepAlive` dagilarning joni har qadamda to'ldiriladi va joyida qoladi. */
function tickFor(room: Room, sec: number, keepAlive: ServerPlayer[] = [], step = 0.25): void {
  let left = sec;
  while (left > 1e-6 && room.phase === 'playing') {
    const d = Math.min(step, left);
    room.advanceTimeForTest(d, 1 / 30);
    for (const p of keepAlive) {
      if (p.alive && !p.downed) p.hp = MAX_HP;
      p.vel = { x: 0, y: 0, z: 0 };
    }
    left -= d;
  }
}

function systemChats(emitted: EmittedRoomEvent[]): string[] {
  return emitted.filter((e) => e.event === 'chat').map((e) => (e.payload as ChatMsg).text);
}

function lastSnap(emitted: EmittedRoomEvent[]): Snapshot {
  const s = emitted.filter((e) => e.event === 'snap').pop()?.payload as Snapshot | undefined;
  assert.ok(s, 'snap hodisasi yuborilgan');
  return s!;
}

function firstWolf(room: Room): ServerWolf {
  const w = [...room.wolves.values()][0];
  assert.ok(w, "xonada bo'ri bor");
  return w!;
}

function mainFire(room: Room) {
  const f = [...room.campfires.values()].find((c) => c.main);
  assert.ok(f, 'asosiy gulxan bor');
  return f!;
}

function groundAt(room: Room, x: number, z: number) {
  return { x, y: sampleTerrainHeight(room.world.terrain, x, z), z };
}

/** Gulxandan `len` m gacha to'siqsiz yo'nalish (16 ta burchak sinab chiqiladi). */
function openDirFromFire(room: Room, fire: { x: number; y: number; z: number }, len: number): { dx: number; dz: number } {
  const nav = room.nav;
  // Kesma gulxan tosh halqasi (campfire_pit_01 kollayderi) tashqarisidan boshlanadi — tun gulxani o'choq ustida yonadi
  const RING = 1.2;
  for (let k = 0; k < 16; k++) {
    const ang = (k / 16) * Math.PI * 2;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const a = { x: fire.x + dx * RING, y: fire.y, z: fire.z + dz * RING };
    const bx = fire.x + dx * len;
    const bz = fire.z + dz * len;
    const b = { x: bx, y: sampleTerrainHeight(room.world.terrain, bx, bz), z: bz };
    if (Math.abs(b.y - a.y) > 0.8) continue;
    if (nav.nearest(b) < 0) continue;
    if (nav.segmentClear(a, b)) return { dx, dz };
  }
  throw new Error("gulxandan ochiq yo'nalish topilmadi");
}

/** Ochiq joy: nav tuguni va undan +X tomonga `len` m gacha to'siqsiz chiziq — ikkala uchi ham yonib turgan gulxandan uzoqda. */
function findOpenLineAwayFromFires(room: Room, len: number): { a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } } {
  const nav = room.nav;
  for (const i of nav.roamList) {
    const a = nav.center(i);
    if (room.litFireContaining(a.x, a.z, 6)) continue;
    const b = { x: a.x + len, y: a.y, z: a.z };
    const j = nav.nearest(b);
    if (j < 0) continue;
    const bc = nav.center(j);
    if (Math.hypot(bc.x - b.x, bc.z - b.z) > 2.5) continue;
    if (Math.abs(bc.y - a.y) > 0.8) continue;
    if (room.litFireContaining(bc.x, bc.z, 6)) continue;
    if (nav.segmentClear(a, bc)) return { a, b: bc };
  }
  throw new Error('ochiq chiziq topilmadi');
}

/** O'yinchini gulxan yoniga (olish masofasida) qo'yadi. */
function standAtFire(room: Room, p: ServerPlayer, fire: { x: number; y: number; z: number }): void {
  const dir = openDirFromFire(room, fire, 10);
  p.pos = groundAt(room, fire.x + dir.dx * 1.5, fire.z + dir.dz * 1.5);
  p.vel = { x: 0, y: 0, z: 0 };
}

function takeTorch(room: Room, id: string, fireId: string): CampActionAck {
  let got: CampActionAck | undefined;
  room.onTakeTorch(id, { fireId }, (res) => {
    got = res;
  });
  assert.ok(got, 'ack chaqirildi');
  return got!;
}

// ---------- Umumiy harakat uchun tekis maydon ----------

function flatWorld(): { world: WorldDefinition; start: { x: number; y: number; z: number } } {
  const world = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 });
  const site = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
  const x = site.center.x - 10;
  const z = site.center.z + 8;
  return { world, start: { x, y: sampleTerrainHeight(world.terrain, x, z), z } };
}

function makeCmd(seq: number, walk: boolean): PlayerInputCmd {
  return {
    seq,
    spawnId: 1,
    dt: 1 / 60,
    moveForward: 1,
    moveRight: 0,
    jump: false,
    walk,
    crouch: false,
    scoped: false,
    weapon: null,
    yaw: -Math.PI / 2,
    pitch: 0,
  };
}

/** 2 s oldinga yurish (Shift = `sprint`), `wood` o'tin bilan: oxirgi gorizontal tezlik va stamina. */
function runFlat(wood: number, sprint: boolean): { speed: number; stamina: number } {
  const { world, start } = flatWorld();
  const st = {
    pos: { ...start },
    vel: { x: 0, y: 0, z: 0 },
    onGround: true,
    crouched: false,
    yaw: 0,
    pitch: 0,
    weapon: null as null,
    scoped: false,
    stamina: 1,
    staminaLocked: false,
    wood,
  };
  for (let i = 1; i <= 120; i++) stepPlayerMovement(st, makeCmd(i, sprint), world);
  return { speed: Math.hypot(st.vel.x, st.vel.z), stamina: st.stamina };
}

describe("Bosqich 21 — Tong otguncha: o'tinning og'irligi va mash'al", () => {
  it("1. O'tin og'irligi (shared): 3 o'tin bilan sprint yo'q va tezlik 0.88×, 1–2 o'tin — sprint bor, lekin sekinroq", () => {
    assert.deepEqual([...WOOD_SPEED_MUL], [1, 0.97, 0.93, 0.88]);
    assert.equal(woodSpeedMul(0), 1);
    assert.equal(woodSpeedMul(3), 0.88);
    assert.equal(woodSpeedMul(undefined), 1);
    assert.equal(woodBlocksSprint(WOOD_CARRY_MAX), true);
    assert.equal(woodBlocksSprint(2), false);
    const base = { moveForward: 1, moveRight: 0, scoped: false, weapon: null as null, yaw: 0 };
    const speed = (wood: number, sprint: boolean) => {
      const { wx, wz } = computeWishVelocity({ ...base, walk: sprint }, false, wood);
      return Math.hypot(wx, wz);
    };
    const close = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
    close(speed(0, true), RUN_SPEED, "o'tinsiz sprint");
    close(speed(1, true), RUN_SPEED * 0.97, '1 o‘tin sprint 0.97×');
    close(speed(2, false), WALK_SPEED * 0.93, '2 o‘tin yurish 0.93×');
    close(speed(3, true), WALK_SPEED * 0.88, "3 o'tin: Shift bosilsa ham yurish tezligi × 0.88");
    close(speed(3, false), WALK_SPEED * 0.88, "3 o'tin yurish 0.88×");
    // Yo'q bo'lsa (eski chaqiruvlar) — 0 o'tin
    close(computeWishVelocity({ ...base, walk: true }).maxSpeed, RUN_SPEED, 'standart chaqiruv o‘zgarmagan');
  });

  it("2. O'tin og'irligi (stepPlayerMovement, tekis maydon): to'la qo'lda Shift bilan ham yurish tezligi va stamina kamaymaydi", () => {
    const free = runFlat(0, true);
    const heavy = runFlat(WOOD_CARRY_MAX, true);
    const heavyWalk = runFlat(WOOD_CARRY_MAX, false);
    assert.ok(free.speed > WALK_SPEED + 0.8, `o'tinsiz sprint tez (${free.speed.toFixed(2)} m/s)`);
    assert.ok(free.stamina < 0.9, `sprintda stamina kamayadi (${free.stamina.toFixed(2)})`);
    assert.ok(heavy.speed <= WALK_SPEED * 0.88 + 0.05, `3 o'tin bilan Shift — yurish tezligi (${heavy.speed.toFixed(2)} m/s)`);
    assert.ok(Math.abs(heavy.speed - heavyWalk.speed) < 0.05, 'Shift bosilgani tezlikni o‘zgartirmaydi');
    assert.equal(heavy.stamina, 1, "sprint bloklanganda stamina sarflanmaydi");
    const light = runFlat(1, true);
    assert.ok(light.speed > WALK_SPEED + 0.8 && light.speed < free.speed, `1 o'tin bilan sprint bor, lekin sekinroq (${light.speed.toFixed(2)})`);
  });

  it("3. Mash'al olish: yonib turgan gulxandan 10 s o'tin ketadi, torchSec 40, qurol pichoq/to'pponchaga o'tadi; snapshotda torchSec", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const fire = mainFire(room);
      standAtFire(room, p, fire);
      p.weapon = 'rifle';
      const fuel0 = fire.fuelSec;
      assert.equal(room.hasTorch(p), false);
      const ack = takeTorch(room, 'p1', fire.id);
      assert.equal(ack.ok, true, `mash'al olindi (${ack.error ?? ''})`);
      assert.equal(ack.torchSec, TORCH_BURN_SEC);
      assert.ok(Math.abs(fire.fuelSec - (fuel0 - TORCH_FUEL_COST_SEC)) < 0.01, `gulxan ${TORCH_FUEL_COST_SEC} s o'tin yo'qotadi`);
      assert.equal(ack.fuelSec, Math.round(fire.fuelSec));
      assert.equal(room.hasTorch(p), true);
      assert.equal(room.torchSecLeft(p), TORCH_BURN_SEC);
      assert.ok(isTorchWeapon(p.weapon), `qurol pichoq/to'pponchaga o'tdi (${p.weapon})`);
      assert.equal(ack.weapon, p.weapon, "ack'da yangi qurol");
      assert.equal(room.torchAllowsWeapon(p, 'rifle'), false);
      assert.equal(room.torchAllowsWeapon(p, 'pistol'), true);
      assert.equal(room.torchAllowsWeapon(p, 'knife'), true);
      room.advanceTimeForTest(0.5, 1 / 30);
      const me = lastSnap(emitted).players.find((s) => s.id === 'p1')!;
      assert.ok((me.torchSec ?? 0) > 0 && (me.torchSec ?? 0) <= TORCH_BURN_SEC, `snapshotda torchSec (${me.torchSec})`);
      // Ikkinchi marta — HAS_TORCH
      p.lastCampAction = -99;
      const again = takeTorch(room, 'p1', fire.id);
      assert.equal(again.ok, false);
      assert.equal(again.error, 'HAS_TORCH');
    } finally {
      room.destroy();
    }
  });

  it("4. Xatolar: o'chgan gulxan — FIRE_OUT, o'tini ≤ 10 s — FIRE_LOW, uzoqdan — TOO_FAR; o'tin olishga ta'sir qilmaydi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const fire = mainFire(room);
      standAtFire(room, p, fire);
      fire.fuelSec = 8;
      p.lastCampAction = -99;
      const low = takeTorch(room, 'p1', fire.id);
      assert.equal(low.ok, false);
      assert.equal(low.error, 'FIRE_LOW');
      assert.equal(room.hasTorch(p), false);
      fire.fuelSec = 0;
      fire.lit = false;
      p.lastCampAction = -99;
      const out = takeTorch(room, 'p1', fire.id);
      assert.equal(out.ok, false);
      assert.equal(out.error, 'FIRE_OUT');
      fire.fuelSec = 90;
      fire.lit = true;
      p.pos = groundAt(room, fire.x + 6, fire.z);
      p.lastCampAction = -99;
      const far = takeTorch(room, 'p1', fire.id);
      assert.equal(far.ok, false);
      assert.equal(far.error, 'TOO_FAR');
      assert.equal(fire.fuelSec, 90, "xatoda o'tin ketmaydi");
    } finally {
      room.destroy();
    }
  });

  it("5. Mash'al 40 s dan keyin o'chadi; [F] bilan oldin tashlash mumkin (NO_TORCH ikkinchi marta)", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const fire = mainFire(room);
      standAtFire(room, p, fire);
      assert.equal(takeTorch(room, 'p1', fire.id).ok, true);
      tickFor(room, TORCH_BURN_SEC / 2, [p]);
      const left = room.torchSecLeft(p);
      assert.ok(left > 0 && left <= TORCH_BURN_SEC / 2 + 1, `yarmida qolgan vaqt ${left} s`);
      tickFor(room, TORCH_BURN_SEC / 2 + 1, [p]);
      assert.equal(room.hasTorch(p), false, "40 s dan keyin mash'al o'chdi");
      assert.equal(p.torchUntil, 0, 'torchUntil 0 ga tushdi');
      assert.equal(lastSnap(emitted).players.find((s) => s.id === 'p1')!.torchSec, undefined, 'snapshotda torchSec yo‘q');

      // Tashlash
      p.lastCampAction = -99;
      let drop: CampActionAck | undefined;
      room.onDropTorch('p1', {}, (r) => (drop = r));
      assert.equal(drop!.ok, false);
      assert.equal(drop!.error, 'NO_TORCH');
      fire.fuelSec = 120;
      fire.lit = true;
      p.lastCampAction = -99;
      assert.equal(takeTorch(room, 'p1', fire.id).ok, true);
      p.lastCampAction = -99;
      room.onDropTorch('p1', {}, (r) => (drop = r));
      assert.equal(drop!.ok, true);
      assert.equal(drop!.torchSec, 0);
      assert.equal(room.hasTorch(p), false);
    } finally {
      room.destroy();
    }
  });

  it("6. Bo'ri mash'al ko'targanni ovlaydi, lekin 15 s davomida 'attack' holatiga kirmaydi, ≥ ~4 m da turadi, tishlamaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const w = firstWolf(room);
      // O'yinchi gulxan doirasidan tashqarida (olov himoyasi yo'q), mash'al bilan; bo'ri 16 m narida, ochiq chiziqda
      const line = findOpenLineAwayFromFires(room, 16);
      const px = line.a.x;
      const pz = line.a.z;
      p.pos = { ...line.a };
      p.vel = { x: 0, y: 0, z: 0 };
      p.torchUntil = room.now() + 60;
      assert.equal(room.hasTorch(p), true);
      assert.equal(room.litFireContaining(p.pos.x, p.pos.z, 1), null, "o'yinchi gulxan doirasidan tashqarida");
      assert.ok(Math.hypot(mainFire(room).x - px, mainFire(room).z - pz) > CAMPFIRE_RADIUS_M + 6);
      const src = room.fearSourceContaining(p.pos.x, p.pos.z, 0);
      assert.equal(src?.kind, 'torch', "mash'al egasi olov manbai");
      assert.equal(src?.radius, TORCH_FEAR_RADIUS_M);
      w.pos = { ...line.b };
      w.vel = { x: 0, y: 0, z: 0 };
      w.yaw = Math.atan2(-(p.pos.x - w.pos.x), -(p.pos.z - w.pos.z));
      w.brain.onDamaged(p, room.now());
      let attacked = false;
      let bitten = false;
      let minD = Infinity;
      const states = new Set<string>();
      for (let i = 0; i < 150; i++) {
        room.advanceTimeForTest(0.1, 1 / 30);
        if (w.state === 'attack') attacked = true;
        states.add(w.state);
        if (p.hp < MAX_HP) bitten = true;
        p.hp = MAX_HP;
        p.vel = { x: 0, y: 0, z: 0 };
        p.pos = groundAt(room, px, pz);
        p.torchUntil = room.now() + 60;
        minD = Math.min(minD, Math.hypot(w.pos.x - p.pos.x, w.pos.z - p.pos.z));
      }
      assert.equal(attacked, false, `bo'ri mash'al egasiga tashlanmaydi (holatlar: ${[...states].join(',')})`);
      assert.equal(bitten, false, 'tishlanmadi');
      assert.ok(
        !emitted.some((e) => e.event === 'wolf:bite' && (e.payload as WolfBiteEvent).hit),
        'tishlash hodisasi yo‘q',
      );
      assert.ok(minD >= TORCH_FEAR_RADIUS_M - 0.5, `bo'ri ${minD.toFixed(1)} m dan yaqin kelmadi`);
      assert.equal(w.targetId, 'p1', "nishonni ushlab turadi (chetida kutadi)");
      const dEnd = Math.hypot(w.pos.x - p.pos.x, w.pos.z - p.pos.z);
      assert.ok(dEnd < 12, `bo'ri yaqinlashgan, lekin halqada (${dEnd.toFixed(1)} m)`);

      // Mash'al o'chdi — bo'ri 10 s ichida tishlaydi
      p.torchUntil = 0;
      let bittenAfter = false;
      for (let i = 0; i < 100 && !bittenAfter; i++) {
        room.advanceTimeForTest(0.1, 1 / 30);
        if (p.hp < MAX_HP) bittenAfter = true;
        p.hp = MAX_HP;
        p.vel = { x: 0, y: 0, z: 0 };
        p.pos = groundAt(room, px, pz);
      }
      assert.equal(bittenAfter, true, "mash'alsiz bo'ri tishlaydi");
    } finally {
      room.destroy();
    }
  });

  it("7. Mash'al bilan avtomatdan otish rad etiladi (onShoot va botFire), to'pponcha/pichoq ishlaydi; kirishdagi qurol almashtirish bloklanadi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const fire = mainFire(room);
      standAtFire(room, p, fire);
      p.weapon = 'rifle';
      p.ammo.rifle = { mag: 30, reserve: 90 };
      p.ammo.pistol = { mag: 12, reserve: 24 };
      assert.equal(takeTorch(room, 'p1', fire.id).ok, true);
      // Server qurolni almashtirgan; test uchun avtomatni qaytarib qo'yamiz (xakerlik ssenariysi)
      p.weapon = 'rifle';
      p.reloadWeapon = null;
      p.switchUntil = 0;
      p.lastShot = -99;
      const rejected0 = room.getCombatSecurityStats().rejectedWeaponShots;
      const shots0 = emitted.filter((e) => e.event === 'shot').length;
      const dir = { x: -Math.sin(p.yaw), y: 0, z: -Math.cos(p.yaw) };
      room.onShoot('p1', { weapon: 'rifle', origin: { x: p.pos.x, y: p.pos.y + 1.62, z: p.pos.z }, dirs: [dir] });
      assert.equal(room.getCombatSecurityStats().rejectedWeaponShots, rejected0 + 1, 'avtomat otishi rad etildi');
      assert.equal(emitted.filter((e) => e.event === 'shot').length, shots0, "'shot' hodisasi yo'q");
      assert.equal(room.botFire(p, 0), false, 'botFire ham avtomatni rad etadi');
      // To'pponcha — ruxsat
      p.weapon = 'pistol';
      p.lastShot = -99;
      p.fireCredit = 2;
      assert.equal(room.botFire(p, 0), true, "to'pponcha otadi");
      // Kirishdagi qurol almashtirish: mash'al bilan avtomatga o'tish rad etiladi (joriy qurol qoladi)
      const seq0 = p.authority.lastProcessedSeq;
      room.onInput('p1', {
        seq: seq0 + 1,
        spawnId: p.spawnId,
        dt: 1 / 60,
        moveForward: 0,
        moveRight: 0,
        jump: false,
        walk: false,
        crouch: false,
        scoped: false,
        weapon: 'rifle',
        yaw: p.yaw,
        pitch: 0,
      });
      room.advanceTimeForTest(0.1, 1 / 30);
      assert.ok(p.authority.lastProcessedSeq >= seq0 + 1, 'kirish ishlandi');
      assert.equal(p.weapon, 'pistol', "mash'al bilan avtomatga o'tib bo'lmaydi");
      // Mash'al tashlangach — ruxsat
      p.lastCampAction = -99;
      room.onDropTorch('p1', {}, () => {});
      assert.equal(room.hasTorch(p), false);
      assert.equal(room.torchAllowsWeapon(p, 'rifle'), true);
      assert.ok(systemChats(emitted).length >= 0);
    } finally {
      room.destroy();
    }
  });
});
