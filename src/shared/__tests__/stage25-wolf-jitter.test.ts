import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import { MAX_HP } from '../constants';
import type { Vec3 } from '../math';
import type { CreateRoomOpts } from '../protocol';
import { sampleTerrainHeight } from '../world';
import {
  CAMPFIRE_RADIUS_M,
  CAMPFIRE_STANDOFF_M,
  FEAR_PROTECT_ENTER_M,
  FEAR_PROTECT_EXIT_M,
  WOLF_BITE_CONNECT_RANGE,
  type WolfState,
} from '../wolf';

// Bosqich 25 — Tong otguncha: bo'ri tebranishi tuzatildi. (1) Nishon gulxan chetidagi 1 m halqada tursa — himoya
// gisterezisi (kirish radius+1.0 / chiqish radius+1.6), halqada o'lik zona; (2) yo'li yonib turgan gulxan doirasini
// kesib o'tsa — olovni hisobga olgan A* (bloklangan tugunlar) va to'g'ri chiziq tekshiruvi; (3) halqada turgan bo'ri
// mikro-qadam qilmaydi. Xona haqiqiy Room, io/socket soxta; vaqt room.advanceTimeForTest bilan deterministik.

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
function startSoloNight(room: Room, id = 'p1', name = 'Ovchi'): ServerPlayer {
  room.addHuman(createFakeSocket(id), name);
  room.onReady(id, { world: room.worldMeta() });
  assert.equal(room.phase, 'countdown');
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  const p = room.players.get(id)!;
  p.spawnTime = -99;
  return p;
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

/** Gulxandan `len` m gacha to'siqsiz yo'nalish (16 ta burchak sinab chiqiladi); `both` — teskari tomon ham `lenBack` m. */
function openDirFromFire(
  room: Room,
  fire: { x: number; y: number; z: number },
  len: number,
  lenBack = 0,
): { dx: number; dz: number } {
  const nav = room.nav;
  // Kesma gulxan o'chog'i (tosh halqa, o'rindiq/stol bezaklari) tashqarisidan boshlanadi — tun gulxani o'choq
  // ustida yonadi; 64 burchak (ikki tomonlama tekshiruvda tor hovlida ham yo'nalish topilsin)
  const RING = 2.0;
  const N = 64;
  for (let k = 0; k < N; k++) {
    const ang = (k / N) * Math.PI * 2;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    let ok = true;
    for (const l of lenBack > 0 ? [len, -lenBack] : [len]) {
      const s = Math.sign(l) * RING;
      const a = { x: fire.x + dx * s, y: fire.y, z: fire.z + dz * s };
      const bx = fire.x + dx * l;
      const bz = fire.z + dz * l;
      const b = { x: bx, y: sampleTerrainHeight(room.world.terrain, bx, bz), z: bz };
      if (Math.abs(b.y - a.y) > 0.8 || nav.nearest(b) < 0 || !nav.segmentClear(a, b)) {
        ok = false;
        break;
      }
    }
    if (ok) return { dx, dz };
  }
  throw new Error("gulxandan ochiq yo'nalish topilmadi");
}

/** Halqasi (standoff radiusida, 12 nuqta) eng ochiq yonib turgan gulxan. */
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

const distXZ = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

describe("Bosqich 25 — bo'ri tebranishi: gulxan cheti gisterezisi, olovni aylanib o'tish, halqada tinch turish", () => {
  it('1. Himoya gisterezisi (Room.preyFearSource): kirish radius+1.0, chiqish radius+1.6', () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const p = startSoloNight(room);
      const fire = mostOpenFire(room);
      const dir = openDirFromFire(room, fire, 20);
      ensureWolves(room, 1);
      const at = (d: number) => groundAt(room, fire.x + dir.dx * d, fire.z + dir.dz * d);
      const R = CAMPFIRE_RADIUS_M;
      // Tug'ilish joyi asosiy gulxan yonida (himoyalangan) — avval uzoqqa (radius+3, himoyasiz), keyin chetga
      tickPinned(room, 0.2, [{ p, pos: at(R + 3) }]);
      assert.equal(room.preyFearSource(p), null, 'radius+3 — himoyasiz');
      // radius+1.3: himoyasizdan kelganda → himoyasiz (kirish chegarasi 1.0)
      tickPinned(room, 0.2, [{ p, pos: at(R + 1.3) }]);
      assert.equal(room.preyFearSource(p), null, 'radius+1.3 — himoyasiz');
      // radius+0.9 → himoyalangan
      tickPinned(room, 0.2, [{ p, pos: at(R + 0.9) }]);
      assert.equal(room.preyFearSource(p)?.kind, 'fire', 'radius+0.9 — himoyalangan');
      // radius+1.3 → hali himoyalangan (chiqish chegarasi 1.6)
      tickPinned(room, 0.2, [{ p, pos: at(R + 1.3) }]);
      assert.equal(room.preyFearSource(p)?.kind, 'fire', 'radius+1.3 — gisterezis ushlab turadi');
      // radius+1.7 → himoyasiz
      tickPinned(room, 0.2, [{ p, pos: at(R + 1.7) }]);
      assert.equal(room.preyFearSource(p), null, 'radius+1.7 — himoyasiz');
      assert.ok(FEAR_PROTECT_EXIT_M > FEAR_PROTECT_ENTER_M);
    } finally {
      room.destroy();
    }
  });

  it("2. Nishon gulxan chetidagi 1 m halqada (radius+0.9) 20 s turadi: bo'ri halqada qoladi, holat almashmaydi, olovga kirmaydi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const p = startSoloNight(room);
      const fire = mostOpenFire(room);
      const dir = openDirFromFire(room, fire, 20);
      const R = CAMPFIRE_RADIUS_M;
      const preyPos = groundAt(room, fire.x + dir.dx * (R + 0.9), fire.z + dir.dz * (R + 0.9));
      p.pos = { ...preyPos };
      const [w] = ensureWolves(room, 1);
      placeWolf(w!, groundAt(room, fire.x + dir.dx * (R + 12), fire.z + dir.dz * (R + 12)), preyPos);
      room.pack.report(w!, p, room.now());
      const t0 = room.now();
      let minFireDist = Infinity;
      let changesAfterSettle = 0;
      let prev: WolfState = w!.state;
      tickPinned(room, 20, [{ p, pos: preyPos }], 1 / 30, (t) => {
        minFireDist = Math.min(minFireDist, distXZ(w!.pos, fire));
        if (w!.state !== prev) {
          // Uvlash (alert → howl → alert) sanalmaydi — bu tebranish emas, davriy xatti-harakat
          if (t - t0 > 6 && prev !== 'howl' && w!.state !== 'howl') changesAfterSettle++;
          prev = w!.state;
        }
      });
      assert.equal(w!.targetId, 'p1', "nishon o'yinchi");
      assert.ok(minFireDist >= R + 0.3, `bo'ri olov chetiga yaqin kelmadi (eng yaqin ${minFireDist.toFixed(2)} m ≥ ${(R + 0.3).toFixed(1)})`);
      assert.ok(changesAfterSettle <= 6, `o'rnashgach holat ≤ 6 marta almashdi (${changesAfterSettle})`);
      assert.equal(w!.brain.fearFlinchCount, 0, 'olovdan seskanish bo‘lmadi');
      assert.ok(w!.state === 'alert' || w!.state === 'howl', `chetida kutadi (${w!.state})`);
      const d = distXZ(w!.pos, fire);
      assert.ok(d >= R + 0.9 && d <= CAMPFIRE_STANDOFF_M + 1.5, `halqa yaqinida (${d.toFixed(2)} m)`);
    } finally {
      room.destroy();
    }
  });

  it("3. Nishon gulxanning narigi tomonida (to'g'ri chiziq olovni kesadi): bo'ri olovni aylanib tishlash masofasiga yetadi, seskanmaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const p = startSoloNight(room);
      const fire = mostOpenFire(room);
      const R = CAMPFIRE_RADIUS_M;
      const dir = openDirFromFire(room, fire, R + 5, R + 8);
      const preyPos = groundAt(room, fire.x + dir.dx * (R + 4), fire.z + dir.dz * (R + 4));
      p.pos = { ...preyPos };
      assert.equal(room.litFireContaining(preyPos.x, preyPos.z, FEAR_PROTECT_ENTER_M), null, "o'yinchi himoyasiz (radius+4)");
      const [w] = ensureWolves(room, 1);
      placeWolf(w!, groundAt(room, fire.x - dir.dx * (R + 6), fire.z - dir.dz * (R + 6)), preyPos);
      room.pack.report(w!, p, room.now());
      let minFireDist = Infinity;
      let minPreyDist = Infinity;
      let reachedAt = -1;
      tickPinned(room, 30, [{ p, pos: preyPos }], 1 / 30, (t) => {
        minFireDist = Math.min(minFireDist, distXZ(w!.pos, fire));
        const d = distXZ(w!.pos, preyPos);
        minPreyDist = Math.min(minPreyDist, d);
        if (reachedAt < 0 && d <= WOLF_BITE_CONNECT_RANGE) reachedAt = t;
      });
      assert.ok(minPreyDist <= WOLF_BITE_CONNECT_RANGE, `tishlash masofasiga yetdi (eng yaqin ${minPreyDist.toFixed(2)} m)`);
      assert.ok(minFireDist >= R, `olov doirasiga kirmadi (eng yaqin ${minFireDist.toFixed(2)} m ≥ ${R})`);
      assert.equal(w!.brain.fearFlinchCount, 0, 'olovdan seskanish 0');
      const bites = emitted.filter((e) => e.event === 'wolf:bite').length;
      assert.ok(bites > 0 || w!.state === 'attack', `tishladi (${bites} ta tishlash)`);
    } finally {
      room.destroy();
    }
  });

  it("4. A* bloklangan tugunlar: ikki tomon orasidagi yo'l bloklangan doirani (va silliqlash qisqartmalarini) chetlab o'tadi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const nav = room.nav;
      const LEN = 26;
      const DISC_R = 6;
      // Ochiq maydon: tugun a, +X da LEN m da b (to'siqsiz), o'rtadagi doira atrofida (DISC_R+3 radiusli halqa) tugunlar bor
      let arena: { a: Vec3; b: Vec3; c: Vec3 } | null = null;
      outer: for (const i of nav.roamList) {
        const a = nav.center(i);
        const j = nav.nearest({ x: a.x + LEN, y: a.y, z: a.z });
        if (j < 0) continue;
        const b = nav.center(j);
        if (Math.abs(b.x - a.x - LEN) > 2.5 || Math.abs(b.z - a.z) > 2.5 || Math.abs(b.y - a.y) > 0.8) continue;
        if (!nav.segmentClear(a, b)) continue;
        const c = { x: (a.x + b.x) / 2, y: a.y, z: (a.z + b.z) / 2 };
        for (let k = 0; k < 12; k++) {
          const ang = (k / 12) * Math.PI * 2;
          const pt = { x: c.x + Math.cos(ang) * (DISC_R + 3), y: a.y, z: c.z + Math.sin(ang) * (DISC_R + 3) };
          const ni = nav.nearest(pt);
          if (ni < 0) continue outer;
          const cc = nav.center(ni);
          if (Math.hypot(cc.x - pt.x, cc.z - pt.z) > 3 || Math.abs(cc.y - a.y) > 0.8) continue outer;
        }
        arena = { a, b, c };
        break;
      }
      assert.ok(arena, 'ochiq maydon topildi');
      const { a, b, c } = arena!;
      const blocked = (x: number, z: number) => Math.hypot(x - c.x, z - c.z) <= DISC_R;
      const sampleMinDist = (path: Vec3[]): number => {
        let min = Infinity;
        let prev = a;
        for (const wp of path) {
          const d = Math.hypot(wp.x - prev.x, wp.z - prev.z);
          const steps = Math.max(1, Math.ceil(d / 0.25));
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            min = Math.min(min, Math.hypot(prev.x + (wp.x - prev.x) * t - c.x, prev.z + (wp.z - prev.z) * t - c.z));
          }
          prev = wp;
        }
        return min;
      };
      // Bloklanmagan yo'l doira orqali o'tadi (test ma'noli)
      const plain = nav.findPath(a, b);
      assert.ok(plain.length > 0, "oddiy yo'l bor");
      assert.ok(sampleMinDist(plain) < DISC_R - 1, `oddiy yo'l doirani kesadi (${sampleMinDist(plain).toFixed(1)} m)`);
      // Bloklangan yo'l: tugunlar doiradan tashqarida, kesmalar ham (silliqlash qisqartmasi doira ustidan o'tmaydi)
      const path = nav.findPath(a, b, blocked);
      assert.ok(path.length > 0, "bloklangan doira bilan yo'l topildi");
      for (const wp of path) assert.ok(!blocked(wp.x, wp.z), `yo'l tuguni doiradan tashqarida (${Math.hypot(wp.x - c.x, wp.z - c.z).toFixed(2)} m)`);
      const minD = sampleMinDist(path);
      assert.ok(minD >= DISC_R - 0.3, `yo'l kesmalari doirani kesmaydi (eng yaqin ${minD.toFixed(2)} m ≥ ${DISC_R - 0.3})`);
      const last = path[path.length - 1]!;
      assert.ok(Math.hypot(last.x - b.x, last.z - b.z) < 0.01, "yo'l maqsadda tugaydi");
      // Yo'l uzunligi: aylanib o'tish to'g'ri chiziqdan uzunroq, lekin ma'qul (≤ 2×)
      let len = 0;
      let prev = a;
      for (const wp of path) {
        len += Math.hypot(wp.x - prev.x, wp.z - prev.z);
        prev = wp;
      }
      assert.ok(len > LEN && len < LEN * 2, `yo'l uzunligi ${len.toFixed(1)} m`);
    } finally {
      room.destroy();
    }
  });

  it("5. Halqada turgan bo'ri (nishon gulxan ichida) o'rnashgach 3 s da < 0.5 m siljiydi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const p = startSoloNight(room);
      const fire = mostOpenFire(room);
      const dir = openDirFromFire(room, fire, 20);
      const preyPos = groundAt(room, fire.x + dir.dx * 1.5, fire.z + dir.dz * 1.5);
      p.pos = { ...preyPos };
      const [w] = ensureWolves(room, 1);
      placeWolf(w!, groundAt(room, fire.x + dir.dx * 14, fire.z + dir.dz * 14), preyPos);
      room.pack.report(w!, p, room.now());
      tickPinned(room, 12, [{ p, pos: preyPos }]);
      const d0 = distXZ(w!.pos, fire);
      assert.ok(d0 >= CAMPFIRE_RADIUS_M + 0.9 && d0 <= CAMPFIRE_STANDOFF_M + 1, `halqada (${d0.toFixed(2)} m)`);
      assert.ok(w!.state === 'alert' || w!.state === 'howl', `chetida kutadi (${w!.state})`);
      let travelled = 0;
      let prev = { x: w!.pos.x, z: w!.pos.z };
      tickPinned(room, 3, [{ p, pos: preyPos }], 1 / 30, () => {
        travelled += distXZ(w!.pos, prev);
        prev = { x: w!.pos.x, z: w!.pos.z };
      });
      assert.ok(travelled < 0.5, `3 s da jami siljish ${travelled.toFixed(3)} m < 0.5`);
      assert.equal(w!.brain.fearFlinchCount, 0);
      assert.equal(w!.targetId, 'p1');
    } finally {
      room.destroy();
    }
  });
});
