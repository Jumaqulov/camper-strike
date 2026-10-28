import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';
import { MAX_HP } from '../constants';
import { anglesFromDir, vnorm, vsub, type Vec3 } from '../math';
import type { HurtEvent, KillEvent, Snapshot, WolfBiteEvent, WolfDeathEvent } from '../protocol';
import { WEAPONS } from '../weapons';
import { WOLF_MAX_HP, WOLF_RESPAWN_SEC, WOLF_CORPSE_SEC, isWolfThreatState } from '../wolf';

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

function makeFfaRoom(io: Server, wolves: number): Room {
  return new Room(
    {
      name: "Bo'ri FFA",
      mode: 'ffa',
      mapId: 'forest_square',
      bots: 0,
      maxPlayers: 8,
      timeLimit: 10,
      scoreLimit: 25,
      publicLayoutSeed: 6501,
      wolves,
    },
    io,
    () => {},
  );
}

/** Ochiq joy: nav tuguni va undan +X tomonga `len` m gacha to'siqsiz chiziq. */
function findOpenLine(room: Room, len: number): { a: Vec3; b: Vec3 } {
  const nav = room.nav;
  for (const i of nav.roamList) {
    const a = nav.center(i);
    const b = { x: a.x + len, y: a.y, z: a.z };
    const j = nav.nearest(b);
    if (j < 0) continue;
    const bc = nav.center(j);
    // Nav katagi 4 m: eng yaqin tugun so'ralgan nuqtadan 2 m gacha chetda bo'lishi mumkin
    if (Math.hypot(bc.x - b.x, bc.z - b.z) > 2.5) continue;
    if (Math.abs(bc.y - a.y) > 0.8) continue;
    if (nav.segmentClear(a, bc)) return { a, b: bc };
  }
  throw new Error('ochiq chiziq topilmadi');
}

function wolfOf(room: Room) {
  const w = [...room.wolves.values()][0];
  assert.ok(w, "xonada bo'ri bo'lishi kerak");
  return w;
}

describe("Bosqich 18 — Vahshiy bo'ri", () => {
  it("1. Klassik xonada bo'ri darhol paydo bo'ladi, snapshotga chiqadi va o'yinchidan uzoqda turadi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeFfaRoom(io, 1);
    try {
      assert.equal(room.wolves.size, 1);
      assert.equal(room.info().wolves, 1);
      const s1 = createFakeSocket('p1');
      room.addHuman(s1.socket, 'Ovchi');
      room.onReady('p1', { world: room.worldMeta() });
      const p1 = room.players.get('p1')!;
      const w = wolfOf(room);
      assert.equal(w.hp, WOLF_MAX_HP);
      assert.equal(w.alive, true);
      room.advanceTimeForTest(0.5, 1 / 30);
      const snap = emitted.filter((e) => e.event === 'snap').pop()?.payload as Snapshot;
      assert.ok(snap.wolves && snap.wolves.length === 1, "snapshotda bo'ri bor");
      assert.equal(snap.wolves![0]!.id, w.id);
      assert.ok(typeof snap.wolves![0]!.state === 'string');
      // Spawn vaqtida o'yinchi 35 m dan uzoqda (yoki iloji boricha uzoq) edi — hozir ham 15 m dan yaqin emas
      assert.ok(Math.hypot(w.pos.x - p1.pos.x, w.pos.z - p1.pos.z) > 15, "bo'ri o'yinchi yoniga tushmaydi");
    } finally {
      room.destroy();
    }
  });

  it("2. Bo'ri yaqin o'yinchini sezib quvadi va tishlaydi (hurt/wolf:bite hodisalari)", () => {
    const { io, emitted } = createFakeIo();
    const room = makeFfaRoom(io, 1);
    try {
      const s1 = createFakeSocket('p1');
      room.addHuman(s1.socket, 'Qurbon');
      room.onReady('p1', { world: room.worldMeta() });
      const p1 = room.players.get('p1')!;
      const w = wolfOf(room);
      const line = findOpenLine(room, 9);
      p1.pos = { ...line.a };
      p1.vel = { x: 0, y: 0, z: 0 };
      w.pos = { ...line.b };
      w.vel = { x: 0, y: 0, z: 0 };
      // Bo'ri o'yinchiga qaraydi (ko'rish yarim-doirasi) — spawn himoyasi (1.5 s) o'tishini ham kutamiz
      w.yaw = Math.atan2(-(p1.pos.x - w.pos.x), -(p1.pos.z - w.pos.z));
      p1.spawnTime = -99;
      let sawThreat = false;
      let bitten = false;
      for (let i = 0; i < 40 && !bitten; i++) {
        room.advanceTimeForTest(0.25, 1 / 30);
        // O'yinchi joyida turadi (server avtoritativ harakat uni surmaydi)
        if (isWolfThreatState(w.state)) sawThreat = true;
        if (p1.hp < MAX_HP) bitten = true;
      }
      assert.ok(sawThreat, "bo'ri stalk/hunt/attack holatiga o'tishi kerak");
      assert.ok(bitten, "10 s ichida bo'ri o'yinchini tishlashi kerak");
      const bite = emitted.find((e) => e.event === 'wolf:bite' && (e.payload as WolfBiteEvent).hit)?.payload as
        | WolfBiteEvent
        | undefined;
      assert.ok(bite, "wolf:bite (hit=true) hodisasi yuborilgan");
      assert.equal(bite!.target, 'p1');
      const hurt = s1.events.find((e) => e.event === 'hurt')?.payload as HurtEvent | undefined;
      assert.ok(hurt && hurt.attacker === w.id, "hurt hodisasida hujumchi — bo'ri");
      assert.equal(w.targetId, 'p1', "snapshot uchun nishon ko'rsatiladi");
    } finally {
      room.destroy();
    }
  });

  it("3. O'yinchi bo'rini otib o'ldiradi; killfeed yo'q, wolf:death bor; klassikda bo'ri qayta paydo bo'ladi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeFfaRoom(io, 1);
    try {
      const s1 = createFakeSocket('p1');
      room.addHuman(s1.socket, 'Mergan');
      room.onReady('p1', { world: room.worldMeta() });
      const p1 = room.players.get('p1')!;
      const w = wolfOf(room);
      const line = findOpenLine(room, 6);
      p1.pos = { ...line.a };
      w.pos = { ...line.b };
      w.vel = { x: 0, y: 0, z: 0 };
      // Bo'ri o'yinchiga orqa o'girgan va uzoqdan hid olmasin deb hujumga o'tgunicha otib bo'lamiz
      p1.weapon = 'rifle';
      p1.ammo.rifle = { mag: 30, reserve: 90 };
      const def = WEAPONS.rifle;
      let shots = 0;
      for (let i = 0; i < 60 && w.alive; i++) {
        const eye = { x: p1.pos.x, y: p1.pos.y + 1.62, z: p1.pos.z };
        const center = { x: w.pos.x, y: w.pos.y + 0.6, z: w.pos.z };
        const dir = vnorm(vsub(center, eye));
        const ang = anglesFromDir(dir);
        p1.yaw = ang.yaw;
        p1.pitch = ang.pitch;
        p1.lastShot = -99;
        room.onShoot('p1', { weapon: 'rifle', origin: eye, dirs: [dir] });
        shots++;
        room.advanceTimeForTest(def.fireInterval * 2.2, 1 / 30);
        if (p1.ammo.rifle.mag === 0) p1.ammo.rifle.mag = 30;
      }
      assert.equal(w.alive, false, `bo'ri ${shots} o'qdan keyin o'lishi kerak (hp=${w.hp})`);
      assert.equal(w.state, 'dead');
      const death = emitted.find((e) => e.event === 'wolf:death')?.payload as WolfDeathEvent | undefined;
      assert.ok(death && death.killerId === 'p1', "wolf:death hodisasi otuvchini ko'rsatadi");
      assert.ok(!emitted.some((e) => e.event === 'kill'), "bo'ri o'limi o'yinchilar killfeediga tushmaydi");
      assert.equal(p1.kills, 0, "bo'ri o'ldirish hisobga yozilmaydi");
      const hc = s1.events.filter((e) => e.event === 'hitConfirm');
      assert.ok(hc.length > 0, 'otuvchi hitConfirm oladi');
      // Jasad bir necha soniya snapshotda qoladi, keyin klassik rejimda bo'ri qayta paydo bo'ladi
      const lastSnapWolves = () => (emitted.filter((e) => e.event === 'snap').pop()?.payload as Snapshot).wolves ?? [];
      room.advanceTimeForTest(WOLF_CORPSE_SEC - 1, 0.25);
      assert.ok(lastSnapWolves().some((x) => x.id === w.id && x.state === 'dead'), 'jasad snapshotda ko‘rinadi');
      room.advanceTimeForTest(1.5, 0.25);
      assert.equal(room.wolves.size, 1, 'klassikda jasad o‘chmaydi, bo‘ri qayta tug‘ilishini kutadi');
      assert.ok(!lastSnapWolves().some((x) => x.id === w.id), `jasad ${WOLF_CORPSE_SEC} s dan keyin snapshotdan chiqadi`);
      room.advanceTimeForTest(WOLF_RESPAWN_SEC, 0.25);
      const w2 = wolfOf(room);
      assert.equal(w2.alive, true, "bo'ri qayta paydo bo'ldi");
      assert.equal(w2.hp, WOLF_MAX_HP);
      assert.ok(lastSnapWolves().some((x) => x.id === w2.id && x.state !== 'dead'), 'qayta tug‘ilgan bo‘ri snapshotga qaytadi');
    } finally {
      room.destroy();
    }
  });

  it("4. Loftdagi o'yinchiga bo'ri yetolmaydi: pastda hushyor turadi, zinaga chiqmaydi, zarar bermaydi", () => {
    const { io } = createFakeIo();
    const room = makeFfaRoom(io, 1);
    try {
      const s1 = createFakeSocket('p1');
      room.addHuman(s1.socket, 'Loftchi');
      room.onReady('p1', { world: room.worldMeta() });
      const p1 = room.players.get('p1')!;
      const w = wolfOf(room);
      // Kulba (seed 6501): loft plitasi x 66..70, z -72..-68, usti y 5.03; zal poli y 2.03
      p1.pos = { x: 66.4, y: 5.03, z: -71.0 };
      p1.vel = { x: 0, y: 0, z: 0 };
      p1.onGround = true;
      p1.spawnTime = -99;
      w.pos = { x: 63.2, y: 2.03, z: -71.0 };
      w.vel = { x: 0, y: 0, z: 0 };
      w.yaw = Math.atan2(-(p1.pos.x - w.pos.x), -(p1.pos.z - w.pos.z));
      let maxWolfY = w.pos.y;
      for (let i = 0; i < 48; i++) {
        room.advanceTimeForTest(0.25, 1 / 30);
        maxWolfY = Math.max(maxWolfY, w.pos.y);
      }
      assert.equal(w.targetId, 'p1', "bo'ri loftdagi o'yinchini sezadi");
      assert.equal(p1.hp, MAX_HP, "loftdagi o'yinchi tishlanmaydi");
      assert.ok(maxWolfY < 3.3, `bo'ri loftga/zinaga chiqmaydi (max y=${maxWolfY.toFixed(2)})`);
      assert.ok(w.state === 'alert' || w.state === 'howl', `pastda hushyor/uvlaydi (holat: ${w.state})`);
    } finally {
      room.destroy();
    }
  });

  it("5. Survival: bo'rilar raund boshida paydo bo'ladi, raund tugagach yo'qoladi; bo'ri o'ldirsa KillEvent weapon='wolf'", () => {
    const { io, emitted } = createFakeIo();
    const room = new Room(
      {
        name: "Bo'ri Survival",
        mode: 'forest_survival',
        mapId: 'forest_square',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 3,
        scoreLimit: 1,
        publicLayoutSeed: 6501,
        countdownSec: 2,
        wolves: 2,
      },
      io,
      () => {},
    );
    try {
      assert.equal(room.wolves.size, 0, "survivalda bo'rilar raundgacha yo'q");
      const s1 = createFakeSocket('p1');
      const s2 = createFakeSocket('p2');
      room.addHuman(s1.socket, 'A');
      room.addHuman(s2.socket, 'B');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      assert.equal(room.wolves.size, 2, "raund boshida 2 ta bo'ri");
      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;
      // p2 ni bo'ridan uzoqda tutamiz; p1 ni bo'ri oldiga qo'yib, o'limgacha kutamiz
      const w = wolfOf(room);
      const line = findOpenLine(room, 6);
      p1.pos = { ...line.a };
      p1.vel = { x: 0, y: 0, z: 0 };
      p1.spawnTime = -99;
      w.pos = { ...line.b };
      w.yaw = Math.atan2(-(p1.pos.x - w.pos.x), -(p1.pos.z - w.pos.z));
      p2.pos = { x: -line.a.x, y: p2.pos.y, z: -line.a.z };
      for (let i = 0; i < 160 && p1.alive; i++) {
        room.advanceTimeForTest(0.25, 1 / 30);
        p1.vel = { x: 0, y: 0, z: 0 };
      }
      assert.equal(p1.alive, false, "bo'ri p1 ni 40 s ichida o'ldiradi");
      const kill = emitted.find((e) => e.event === 'kill' && (e.payload as KillEvent).victim === 'p1')?.payload as
        | KillEvent
        | undefined;
      assert.ok(kill, "o'lim hodisasi");
      assert.equal(kill!.weapon, 'wolf');
      assert.equal(kill!.killer, w.id);
      assert.equal(kill!.killerTeam, 'none');
      // Oxirgi tirik p2 — raund tugaydi, bo'rilar tozalanadi
      assert.equal(room.phase, 'ended');
      assert.equal(room.wolves.size, 0, "raund tugagach bo'rilar yo'qoladi");
    } finally {
      room.destroy();
    }
  });
});
