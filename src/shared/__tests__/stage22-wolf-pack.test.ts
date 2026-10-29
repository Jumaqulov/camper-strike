import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import {
  WOLF_FLANK_MAX_DEG,
  WOLF_FLANK_MIN_DEG,
  WOLF_FLANK_RADIUS_M,
  WOLF_PACK_SHARE_RANGE_M,
  angularSeparation,
} from '../../server/wolfPack';
import { MAX_HP } from '../constants';
import type { Vec3 } from '../math';
import type { CreateRoomOpts, Snapshot } from '../protocol';
import { sampleTerrainHeight } from '../world';
import { CAMPFIRE_RADIUS_M, CAMPFIRE_STANDOFF_M, type WolfBiteEvent } from '../wolf';

// Bosqich 22 — Tong otguncha: to'da taktikasi (WolfPack): yolg'iz/gulxandan uzoq nishon, haydovchi va qanotlar,
// to'da xabardorligi, halqada yoyilish, yiqilgan nishon tashlanadi. Xona haqiqiy Room, io/socket soxta; vaqt
// room.advanceTimeForTest bilan deterministik suriladi.

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

function makeFfaRoom(io: Server, bots: number, wolves: number): Room {
  return new Room(
    {
      name: "Bo'ri FFA",
      mode: 'ffa',
      mapId: 'forest_square',
      bots,
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

/** Ikki odam tayyor bo'lib raundni boshlaydi (sanoq 2 s). */
function startDuoNight(room: Room) {
  const s1 = createFakeSocket('p1');
  const s2 = createFakeSocket('p2');
  room.addHuman(s1.socket, 'Ovchi');
  room.addHuman(s2.socket, 'Sherik');
  room.onReady('p1', { world: room.worldMeta() });
  room.onReady('p2', { world: room.worldMeta() });
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  const p1 = room.players.get('p1')!;
  const p2 = room.players.get('p2')!;
  p1.spawnTime = -99;
  p2.spawnTime = -99;
  return { p1, p2, s1, s2 };
}

function lastSnap(emitted: EmittedRoomEvent[]): Snapshot {
  const s = emitted.filter((e) => e.event === 'snap').pop()?.payload as Snapshot | undefined;
  assert.ok(s, 'snap hodisasi yuborilgan');
  return s!;
}

function mainFire(room: Room) {
  const f = [...room.campfires.values()].find((c) => c.main);
  assert.ok(f, 'asosiy gulxan bor');
  return f!;
}

function groundAt(room: Room, x: number, z: number): Vec3 {
  return { x, y: sampleTerrainHeight(room.world.terrain, x, z), z };
}

/** Xonada kamida `n` tirik bo'ri bo'lsin (to'lqin bergani ustiga qo'shiladi). */
function ensureWolves(room: Room, n: number): ServerWolf[] {
  while (room.wolves.size < n) {
    const w = room.addWolf();
    assert.ok(w, "bo'ri qo'shildi");
  }
  return [...room.wolves.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Bo'rini joyga qo'yadi (tezlik 0, nishonga qaraydi). */
function placeWolf(w: ServerWolf, pos: Vec3, lookAt?: Vec3): void {
  w.pos = { ...pos };
  w.vel = { x: 0, y: 0, z: 0 };
  if (lookAt) w.yaw = Math.atan2(-(lookAt.x - pos.x), -(lookAt.z - pos.z));
}

/** O'yinchi `at` ga qaraydi (old yo'nalish = (-sin yaw, -cos yaw)). */
function faceTowards(p: ServerPlayer, at: Vec3): void {
  p.yaw = Math.atan2(-(at.x - p.pos.x), -(at.z - p.pos.z));
}

/**
 * Ochiq maydon: nav tuguni, undan +X tomonga `len` m gacha to'siqsiz chiziq va atrofidagi `ring` m radiusli
 * halqa (12 nuqta) nav-grafda — barchasi yonib turgan gulxanlardan uzoqda.
 */
function findOpenArena(room: Room, len: number, ring: number): { a: Vec3; b: Vec3 } {
  const nav = room.nav;
  outer: for (const i of nav.roamList) {
    const a = nav.center(i);
    if (room.litFireContaining(a.x, a.z, 14)) continue;
    const b = { x: a.x + len, y: a.y, z: a.z };
    const j = nav.nearest(b);
    if (j < 0) continue;
    const bc = nav.center(j);
    if (Math.hypot(bc.x - b.x, bc.z - b.z) > 2.5) continue;
    if (Math.abs(bc.y - a.y) > 0.8) continue;
    if (!nav.segmentClear(a, bc)) continue;
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2;
      const pt = { x: a.x + Math.cos(ang) * ring, y: a.y, z: a.z + Math.sin(ang) * ring };
      const ni = nav.nearest(pt);
      if (ni < 0) continue outer;
      const c = nav.center(ni);
      if (Math.hypot(c.x - pt.x, c.z - pt.z) > 3 || Math.abs(c.y - a.y) > 0.8) continue outer;
      if (!nav.segmentClear(a, c)) continue outer;
    }
    return { a, b: bc };
  }
  throw new Error('ochiq maydon topilmadi');
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

/** Halqasi (standoff radiusida, 12 nuqta) eng ochiq yonib turgan gulxan: nav tuguni yaqin bo'lgan nuqtalar soni bo'yicha. */
function mostOpenFire(room: Room) {
  // Bosqich 26: tun gulxanlari bezak o'choqlar ustida — POI bezaklari (kulbalar, o'rindiqlar, panjaralar) orasida
  // yonadi; halqa testlari ochiq maydon talab qiladi: yonib turgan gulxan ochiq sayr maydoniga ko'chiriladi (halqa
  // 12 nuqtasi tugunli va to'siqsiz, kamida bir yo'nalishda ikki tomonga 22 m to'siqsiz; boshqa gulxanlardan ≥ 40 m).
  // Gulxan — ish vaqtidagi obyekt, dunyo tavsifi (kollayderlar, gameplayHash) o'zgarmaydi.
  const nav = room.nav;
  const fires = [...room.campfires.values()].filter((f) => f.lit);
  assert.ok(fires.length > 0, 'yonib turgan gulxan bor');
  const fire = fires.find((f) => f.main) ?? fires[0]!;
  const nodeNear = (pt: Vec3, from: Vec3, tol: number): boolean => {
    const ni = nav.nearest(pt);
    if (ni < 0) return false;
    const c = nav.center(ni);
    return Math.hypot(c.x - pt.x, c.z - pt.z) <= tol && Math.abs(c.y - from.y) <= 0.8 && nav.segmentClear(from, c);
  };
  for (const i of nav.roamList) {
    const c = nav.center(i);
    if (fires.some((f) => f !== fire && Math.hypot(f.x - c.x, f.z - c.z) < 40)) continue;
    let ok = true;
    for (let k = 0; k < 12 && ok; k++) {
      const ang = (k / 12) * Math.PI * 2;
      ok = nodeNear({ x: c.x + Math.cos(ang) * CAMPFIRE_STANDOFF_M, y: c.y, z: c.z + Math.sin(ang) * CAMPFIRE_STANDOFF_M }, c, 2);
    }
    if (!ok) continue;
    let line = false;
    for (let k = 0; k < 16 && !line; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const dx = Math.cos(ang) * 22;
      const dz = Math.sin(ang) * 22;
      line = nodeNear({ x: c.x + dx, y: c.y, z: c.z + dz }, c, 2.5) && nodeNear({ x: c.x - dx, y: c.y, z: c.z - dz }, c, 2.5);
    }
    if (!line) continue;
    fire.x = c.x;
    fire.y = c.y;
    fire.z = c.z;
    return fire;
  }
  throw new Error('gulxan uchun ochiq maydon topilmadi');
}

/** Vaqtni suradi; `pinned` dagilar joyida qoladi va joni to'ldiriladi. */
function tickPinned(room: Room, sec: number, pinned: { p: ServerPlayer; pos: Vec3 }[], step = 1 / 30, onTick?: (t: number) => void): void {
  let left = sec;
  while (left > 1e-6 && room.phase === 'playing') {
    const d = Math.min(step, left);
    room.advanceTimeForTest(d, step);
    for (const { p, pos } of pinned) {
      if (p.alive && !p.downed) p.hp = MAX_HP;
      p.pos = { ...pos };
      p.vel = { x: 0, y: 0, z: 0 };
    }
    onTick?.(room.now());
    left -= d;
  }
}

function angleFrom(center: Vec3, pt: Vec3): number {
  return Math.atan2(pt.z - center.z, pt.x - center.x);
}

describe("Bosqich 22 — Tong otguncha: to'da taktikasi (haydovchi, qanotlar, to'da xabardorligi)", () => {
  it("1. To'da gulxan yonidagi emas, gulxandan uzoqdagi yolg'iz o'yinchini nishonga oladi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p1, p2 } = startDuoNight(room);
      // Gulxandan uzun ochiq yo'nalish bor gulxan (asosiy lager hovlisi tor bo'lishi mumkin)
      let fire = mainFire(room) as { x: number; y: number; z: number };
      let dir: { dx: number; dz: number } | null = null;
      let len = 0;
      for (const l of [32, 26, 22]) {
        for (const f of room.campfires.values()) {
          if (!f.lit) continue;
          try {
            dir = openDirFromFire(room, f, l);
            fire = f;
            len = l;
            break;
          } catch {
            /* keyingi gulxan */
          }
        }
        if (dir) break;
      }
      assert.ok(dir, "gulxandan ochiq yo'nalish bor");
      // p1 gulxan yonida, p2 o'sha yo'nalishda (len-2) m narida — gulxandan uzoqda, yolg'iz
      p1.pos = groundAt(room, fire.x + dir!.dx * 1.5, fire.z + dir!.dz * 1.5);
      p2.pos = groundAt(room, fire.x + dir!.dx * (len - 2), fire.z + dir!.dz * (len - 2));
      const nearFire = room.nearestLitFire(p2.pos.x, p2.pos.z)!;
      assert.ok(Math.hypot(p2.pos.x - nearFire.x, p2.pos.z - nearFire.z) > CAMPFIRE_RADIUS_M + 12, "p2 har qanday yonib turgan gulxandan uzoqda");
      const [w] = ensureWolves(room, 1);
      // Bo'ri p1 ga yaqinroq (gulxan chetida, 10.5 m; p2 gacha 18 m), lekin to'da ikkalasini ham biladi
      placeWolf(w!, groundAt(room, fire.x + dir!.dx * 10, fire.z + dir!.dz * 10), p1.pos);
      const t = room.now();
      room.pack.report(w!, p1, t);
      room.pack.report(w!, p2, t);
      assert.equal(room.pack.knowsPrey('p1'), true);
      assert.equal(room.pack.knowsPrey('p2'), true);
      tickPinned(room, 0.3, [{ p: p1, pos: p1.pos }, { p: p2, pos: p2.pos }]);
      assert.equal(w!.targetId, 'p2', `yolg'iz, gulxandan uzoq o'yinchi nishon (${w!.targetId})`);
      assert.equal(w!.role, 'driver', "yakka bo'ri — haydovchi");
      const snapW = lastSnap(emitted).wolves?.find((s) => s.id === w!.id);
      assert.equal(snapW?.role, 'd', "snapshotda vazifa 'd'");
      assert.equal(snapW?.targetId, 'p2');
    } finally {
      room.destroy();
    }
  });

  it("2. Bir nishonga 3 bo'ri: bitta haydovchi, qanotlar nishon atrofidagi 9 m doirada qarama-qarshi tomonlarda (±100..150°)", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const arena = findOpenArena(room, 20, WOLF_FLANK_RADIUS_M);
      p.pos = { ...arena.a };
      const wolves = ensureWolves(room, 3);
      // Hammasi +X tomonda, turli masofada (eng yaqini haydovchi bo'ladi)
      const dists = [20, 24, 28];
      wolves.forEach((w, i) => placeWolf(w, groundAt(room, arena.a.x + dists[i]!, arena.a.z), p.pos));
      const t = room.now();
      for (const w of wolves) room.pack.report(w, p, t);
      tickPinned(room, 0.2, [{ p, pos: p.pos }]);
      const drivers = wolves.filter((w) => w.role === 'driver');
      const flankers = wolves.filter((w) => w.role === 'flanker');
      assert.equal(drivers.length, 1, `aynan bitta haydovchi (${wolves.map((w) => w.role).join(',')})`);
      assert.equal(flankers.length, 2, 'qolganlari qanot');
      assert.equal(drivers[0]!.id, wolves[0]!.id, "eng yaqini haydovchi");
      for (const w of wolves) assert.equal(w.targetId, 'p1');
      const a0 = angleFrom(p.pos, drivers[0]!.pos);
      const rel: number[] = [];
      for (const f of flankers) {
        const g = room.pack.flankGoalOf(f.id);
        assert.ok(g, `${f.id} qanot nuqtasi bor`);
        const r = Math.hypot(g!.x - p.pos.x, g!.z - p.pos.z);
        assert.ok(Math.abs(r - WOLF_FLANK_RADIUS_M) < 0.05, `qanot nuqtasi ${WOLF_FLANK_RADIUS_M} m doirada (${r.toFixed(2)})`);
        const sep = angularSeparation(a0, angleFrom(p.pos, g!));
        const deg = (sep * 180) / Math.PI;
        assert.ok(deg >= WOLF_FLANK_MIN_DEG - 1 && deg <= WOLF_FLANK_MAX_DEG + 1, `qanot burchagi ${deg.toFixed(0)}° (100..150)`);
        // Ishorali farq: tomonlar qarama-qarshi
        const d = Math.atan2(Math.sin(angleFrom(p.pos, g!) - a0), Math.cos(angleFrom(p.pos, g!) - a0));
        rel.push(d);
      }
      assert.ok(rel[0]! * rel[1]! < 0, `qanotlar qarama-qarshi tomonlarda (${rel.map((r) => ((r * 180) / Math.PI).toFixed(0)).join(', ')}°)`);
      const snap = lastSnap(emitted);
      assert.equal(snap.wolves?.filter((s) => s.role === 'f').length, 2, "snapshotda 2 ta 'f'");
      assert.equal(snap.wolves?.filter((s) => s.role === 'd').length, 1, "snapshotda 1 ta 'd'");
    } finally {
      room.destroy();
    }
  });

  it("3. To'da xabardorligi: o'yinchini ko'rmagan bo'ri 60 m ichidagi sherigi ko'rgani uchun joyini biladi; 60 m dan uzoqdagi — bilmaydi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const arena = findOpenArena(room, 10, 4);
      p.pos = { ...arena.a };
      const [seer, near, far] = ensureWolves(room, 3);
      placeWolf(seer!, arena.b, p.pos);
      // Sherik: ko'ruvchidan 45 m (p dan 55 m — ko'rish 42 m dan uzoq), orqasi bilan; uzoqdagi: 75 m
      const nav = room.nav;
      const snap = (pt: Vec3): Vec3 => {
        const i = nav.nearest(pt);
        return i >= 0 ? nav.center(i) : pt;
      };
      const nearPos = snap({ x: arena.b.x + 45, y: arena.b.y, z: arena.b.z });
      const farPos = snap({ x: arena.b.x + 75, y: arena.b.y, z: arena.b.z });
      placeWolf(near!, nearPos);
      near!.yaw = Math.atan2(-(near!.pos.x - p.pos.x), -(near!.pos.z - p.pos.z)); // p dan teskari tomonga qaraydi
      placeWolf(far!, farPos);
      far!.yaw = near!.yaw;
      const dNear = Math.hypot(near!.pos.x - seer!.pos.x, near!.pos.z - seer!.pos.z);
      const dFar = Math.hypot(far!.pos.x - seer!.pos.x, far!.pos.z - seer!.pos.z);
      assert.ok(dNear <= WOLF_PACK_SHARE_RANGE_M && dNear > 30, `sherik ko'ruvchidan ${dNear.toFixed(0)} m`);
      assert.ok(dFar > WOLF_PACK_SHARE_RANGE_M, `uzoqdagi ko'ruvchidan ${dFar.toFixed(0)} m`);
      assert.ok(Math.hypot(near!.pos.x - p.pos.x, near!.pos.z - p.pos.z) > 44, "sherik o'yinchini ko'ra olmaydi");
      assert.equal(near!.targetId, null);
      room.pack.report(seer!, p, room.now());
      tickPinned(room, 0.2, [{ p, pos: p.pos }], 1 / 30, () => {
        // Bo'rilar joyida (qochmasin/yurmasin — faqat nishon bilishini tekshiramiz)
        placeWolf(near!, nearPos);
        placeWolf(far!, farPos);
        placeWolf(seer!, arena.b, p.pos);
      });
      assert.equal(seer!.targetId, 'p1', "ko'ruvchi ovlaydi");
      assert.equal(near!.targetId, 'p1', "60 m ichidagi sherik ham nishonni biladi (to'da xabardorligi)");
      assert.equal(far!.targetId, null, "60 m dan uzoqdagi bo'ri bilmaydi");
    } finally {
      room.destroy();
    }
  });

  it("4. Qanot: qanot nuqtasiga boradi, kutadi (stalk), keyin ovga o'tib tishlaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const arena = findOpenArena(room, 22, WOLF_FLANK_RADIUS_M + 1);
      p.pos = { ...arena.a };
      const [driver, flanker] = ensureWolves(room, 2);
      // Haydovchi 10 m da (hujumga yetmaydi, ≤ 11 m — vazifasini saqlaydi), qanot 22 m da
      const driverPos = groundAt(room, arena.a.x + 10, arena.a.z);
      placeWolf(driver!, driverPos, p.pos);
      placeWolf(flanker!, arena.b, p.pos);
      const t0 = room.now();
      room.pack.report(driver!, p, t0);
      room.pack.report(flanker!, p, t0);
      room.advanceTimeForTest(1 / 30, 1 / 30);
      assert.equal(driver!.role, 'driver');
      assert.equal(flanker!.role, 'flanker');
      let minToGoal = Infinity;
      let heldAtRing = false;
      let huntedAfterHold = false;
      let flankerBit = false;
      const states = new Set<string>();
      tickPinned(room, 16, [{ p, pos: p.pos }], 1 / 30, () => {
        // Haydovchi joyida ushlab turiladi (qanotlar haydovchi yaqinlashganda emas, kutib bo'lgach hujum qiladi)
        placeWolf(driver!, driverPos, p.pos);
        // O'yinchi doim qanotga qarab turadi — "orqa o'girgan" sharti ishlamaydi
        faceTowards(p, flanker!.pos);
        const g = room.pack.flankGoalOf(flanker!.id);
        if (g) {
          const dg = Math.hypot(g.x - flanker!.pos.x, g.z - flanker!.pos.z);
          minToGoal = Math.min(minToGoal, dg);
          if (dg < 1.5 && flanker!.state === 'stalk') heldAtRing = true;
        }
        states.add(flanker!.state);
        if (heldAtRing && (flanker!.state === 'hunt' || flanker!.state === 'attack')) huntedAfterHold = true;
        if (emitted.some((e) => e.event === 'wolf:bite' && (e.payload as WolfBiteEvent).id === flanker!.id && (e.payload as WolfBiteEvent).hit)) {
          flankerBit = true;
        }
      });
      assert.ok(minToGoal < 1.5, `qanot qanot nuqtasiga yetdi (eng yaqin ${minToGoal.toFixed(2)} m)`);
      assert.ok(heldAtRing, `qanot nuqtasida poylab turdi (holatlar: ${[...states].join(',')})`);
      assert.ok(huntedAfterHold, "kutib bo'lgach ovga o'tdi");
      assert.ok(flankerBit, 'qanot tishladi');
    } finally {
      room.destroy();
    }
  });

  it("5. Nishon yonib turgan gulxan ichida: 4 bo'ri halqa bo'ylab yoyiladi (juftlik orasi ≥ 60°), olovga kirmaydi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const fire = mostOpenFire(room);
      const dir = openDirFromFire(room, fire, 20);
      p.pos = groundAt(room, fire.x + dir.dx * 1.5, fire.z + dir.dz * 1.5);
      assert.ok(room.litFireContaining(p.pos.x, p.pos.z, 0), "o'yinchi gulxan doirasida");
      const wolves = ensureWolves(room, 4);
      // Hammasi bir yo'nalishdan, ketma-ket keladi (to'planib qolmasligi kerak)
      wolves.forEach((w, i) => placeWolf(w, groundAt(room, fire.x + dir.dx * (13 + i * 2), fire.z + dir.dz * (13 + i * 2)), p.pos));
      const t = room.now();
      for (const w of wolves) room.pack.report(w, p, t);
      let minFireDist = Infinity;
      tickPinned(room, 20, [{ p, pos: p.pos }], 1 / 30, () => {
        for (const w of wolves) minFireDist = Math.min(minFireDist, Math.hypot(w.pos.x - fire.x, w.pos.z - fire.z));
      });
      assert.ok(minFireDist >= CAMPFIRE_RADIUS_M - 0.3, `bo'rilar olovga kirmadi (eng yaqin ${minFireDist.toFixed(1)} m)`);
      const angles = wolves.map((w) => angleFrom({ x: fire.x, y: fire.y, z: fire.z }, w.pos));
      let minSep = Infinity;
      for (let i = 0; i < angles.length; i++) {
        for (let j = i + 1; j < angles.length; j++) minSep = Math.min(minSep, angularSeparation(angles[i]!, angles[j]!));
      }
      const minSepDeg = (minSep * 180) / Math.PI;
      assert.ok(minSepDeg >= 60, `to'da halqada yoyildi: eng kichik burchak farqi ${minSepDeg.toFixed(0)}° (≥ 60°)`);
      for (const w of wolves) {
        const d = Math.hypot(w.pos.x - fire.x, w.pos.z - fire.z);
        assert.ok(d >= CAMPFIRE_RADIUS_M && d <= CAMPFIRE_STANDOFF_M + 3, `${w.id} halqa yaqinida (${d.toFixed(1)} m)`);
        assert.equal(w.targetId, 'p1');
        assert.ok(w.state === 'alert' || w.state === 'howl', `${w.id} chetida kutadi (${w.state})`);
      }
    } finally {
      room.destroy();
    }
  });

  it("6. Yiqilgan o'yinchi to'da uchun nishon emas: darhol tashlanadi, bo'ri sherigiga o'tadi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p1, p2 } = startDuoNight(room);
      const arena = findOpenArena(room, 12, 4);
      p1.pos = { ...arena.a };
      p2.pos = groundAt(room, arena.a.x, arena.a.z + 6);
      const [w] = ensureWolves(room, 1);
      placeWolf(w!, arena.b, p1.pos);
      const t = room.now();
      room.pack.report(w!, p2, t);
      w!.brain.onDamaged(p1, t); // p1 ni ovlaydi (qasos)
      tickPinned(room, 0.2, [{ p: p1, pos: p1.pos }, { p: p2, pos: p2.pos }]);
      assert.equal(w!.targetId, 'p1');
      assert.equal(room.pack.knowsPrey('p1'), true);
      room.damageForTest(p1, w!, MAX_HP, 'wolf');
      assert.equal(p1.downed, true, 'p1 yiqildi (ikki kishilik tunda o‘lmaydi)');
      room.advanceTimeForTest(2 / 30, 1 / 30);
      assert.equal(room.pack.knowsPrey('p1'), false, "to'da yiqilganni unutdi");
      assert.notEqual(w!.targetId, 'p1', 'yiqilgan nishon tashlandi');
      assert.equal(w!.targetId, 'p2', "bo'ri sherigiga o'tdi");
    } finally {
      room.destroy();
    }
  });

  it("7. FFA 'wolves' varianti: yakka bo'ri haydovchi, odatdagidek quvib tishlaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeFfaRoom(io, 0, 1);
    try {
      const s1 = createFakeSocket('p1');
      room.addHuman(s1.socket, 'Qurbon');
      room.onReady('p1', { world: room.worldMeta() });
      const p1 = room.players.get('p1')!;
      const w = [...room.wolves.values()][0]!;
      const arena = findOpenArena(room, 9, 3);
      p1.pos = { ...arena.a };
      p1.vel = { x: 0, y: 0, z: 0 };
      placeWolf(w, arena.b, p1.pos);
      p1.spawnTime = -99;
      let sawDriver = false;
      let bitten = false;
      for (let i = 0; i < 40 && !bitten; i++) {
        room.advanceTimeForTest(0.25, 1 / 30);
        if (w.role === 'driver') sawDriver = true;
        if (p1.hp < MAX_HP) bitten = true;
      }
      assert.ok(sawDriver, "yakka bo'ri — haydovchi");
      assert.equal(w.role, 'driver');
      assert.ok(bitten, "10 s ichida bo'ri o'yinchini tishlaydi");
      const bite = emitted.find((e) => e.event === 'wolf:bite' && (e.payload as WolfBiteEvent).hit)?.payload as WolfBiteEvent | undefined;
      assert.ok(bite && bite.target === 'p1');
      assert.equal(lastSnap(emitted).wolves?.[0]?.role, 'd');
    } finally {
      room.destroy();
    }
  });
});
