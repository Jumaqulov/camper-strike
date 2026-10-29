import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';
import { MAX_HP, type GameMode } from '../constants';
import type { Vec3 } from '../math';
import type { CreateRoomOpts } from '../protocol';
import { sampleTerrainHeight } from '../world';
import type { WolfBiteEvent } from '../wolf';

// Bosqich 32 — kunduzgi rejimlar (ffa/tdm, 'wolves' varianti): to'da chalg'itmaydi. Haydovchining chalg'itishi va
// to'da hujumini kutish faqat Tong otguncha rejimida — kunduzgi to'da avvalgidek darhol hujum qiladi (qanotlar
// baribir o'z tomonidan aylanib keladi). Xona haqiqiy Room, io/socket soxta; vaqt room.advanceTimeForTest bilan
// suriladi, Math.random urug'langan.

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

function makeDayRoom(io: Server, mode: GameMode, wolves: number, overrides: Partial<CreateRoomOpts> = {}): Room {
  return new Room(
    {
      name: "Bo'ri kunduzi",
      mode,
      mapId: 'forest_square',
      bots: 0,
      maxPlayers: 8,
      timeLimit: 10,
      scoreLimit: 25,
      publicLayoutSeed: 6501,
      wolves,
      ...overrides,
    },
    io,
    () => {},
  );
}

/** Mulberry32 — kichik urug'langan PRNG (bo'ri AI va xona `Math.random` dan foydalanadi). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministik RNG bilan ishga tushirilgan yugurish; `Math.random` doim qayta tiklanadi. */
function withSeededRandom<T>(seed: number, fn: () => T): T {
  const realRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = realRandom;
  }
}

function groundAt(room: Room, x: number, z: number): Vec3 {
  return { x, y: sampleTerrainHeight(room.world.terrain, x, z), z };
}

/**
 * Ochiq maydon: nav tuguni, undan +X tomonga `len` m gacha to'siqsiz chiziq va atrofidagi `ring` m radiusli halqa
 * (12 nuqta) nav-grafda.
 */
function findOpenArena(room: Room, len: number, ring: number): Vec3 {
  const nav = room.nav;
  outer: for (const i of nav.roamList) {
    const a = nav.center(i);
    const j = nav.nearest({ x: a.x + len, y: a.y, z: a.z });
    if (j < 0) continue;
    const b = nav.center(j);
    if (Math.hypot(b.x - a.x - len, b.z - a.z) > 2.5 || Math.abs(b.y - a.y) > 0.8) continue;
    if (!nav.segmentClear(a, b)) continue;
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2;
      const pt = { x: a.x + Math.cos(ang) * ring, y: a.y, z: a.z + Math.sin(ang) * ring };
      const ni = nav.nearest(pt);
      if (ni < 0) continue outer;
      const c = nav.center(ni);
      if (Math.hypot(c.x - pt.x, c.z - pt.z) > 3 || Math.abs(c.y - a.y) > 0.8) continue outer;
      if (!nav.segmentClear(a, c)) continue outer;
    }
    return a;
  }
  throw new Error('ochiq maydon topilmadi');
}

interface DayPackRun {
  label: string;
  /** To'da tuzilgandan keyingi ticklardagi hujum bosqichlari (null — to'da yo'q). */
  phases: ('feint' | 'commit' | null)[];
  /** Birinchi tishlash vaqti (s) va tishlagan bo'rining vazifasi. */
  firstBiteAt: number | null;
  firstBiteRole: string | null;
}

/**
 * Kunduzgi xona (`mode`, `dists.length` bo'ri): o'yinchi ochiq maydonda joyida (joni to'ldiriladi), bo'rilarga
 * qarab turadi; bo'rilar bir tomondan (`dists` m) keladi, to'da ularni darhol biladi (report). 8 s davomida har
 * tickdagi hujum bosqichi va birinchi tishlash yoziladi.
 */
function runDayPack(mode: GameMode, dists: number[]): DayPackRun {
  const { io, emitted } = createFakeIo();
  const room = makeDayRoom(io, mode, dists.length);
  try {
    room.addHuman(createFakeSocket('p1'), 'Ovchi');
    room.onReady('p1', { world: room.worldMeta() });
    room.advanceTimeForTest(0.5, 0.25);
    assert.equal(room.phase, 'playing');
    const p = room.players.get('p1')!;
    p.spawnTime = -99;
    const a = findOpenArena(room, 20, 9);
    const pos0 = groundAt(room, a.x, a.z);
    p.pos = { ...pos0 };
    p.vel = { x: 0, y: 0, z: 0 };
    p.yaw = Math.atan2(-1, 0);
    const wolves = [...room.wolves.values()].sort((x, y) => (x.id < y.id ? -1 : 1));
    assert.equal(wolves.length, dists.length, `xonada ${dists.length} bo'ri`);
    wolves.forEach((w, i) => {
      w.pos = groundAt(room, a.x + dists[i]!, a.z + (i - (dists.length - 1) / 2) * 2);
      w.vel = { x: 0, y: 0, z: 0 };
      w.yaw = Math.atan2(-(pos0.x - w.pos.x), -(pos0.z - w.pos.z));
    });
    const t0 = room.now();
    for (const w of wolves) room.pack.report(w, p, t0);
    let seen = emitted.length;
    const phases: DayPackRun['phases'] = [];
    let firstBiteAt: number | null = null;
    let firstBiteRole: string | null = null;
    for (let i = 0; i < 30 * 8 && firstBiteAt === null; i++) {
      room.advanceTimeForTest(1 / 30, 1 / 30);
      p.pos = { ...pos0 };
      p.vel = { x: 0, y: 0, z: 0 };
      p.yaw = Math.atan2(-1, 0);
      p.hp = MAX_HP;
      phases.push(room.pack.huntPhaseOf('p1'));
      for (; seen < emitted.length; seen++) {
        const e = emitted[seen]!;
        if (e.event !== 'wolf:bite' || !(e.payload as WolfBiteEvent).hit || (e.payload as WolfBiteEvent).target !== 'p1') continue;
        firstBiteAt = room.now() - t0;
        firstBiteRole = room.wolves.get((e.payload as WolfBiteEvent).id)?.role ?? null;
        break;
      }
    }
    return { label: `${mode} ${dists.join('/')} m`, phases, firstBiteAt, firstBiteRole };
  } finally {
    room.destroy();
  }
}

describe("Bosqich 32 — kunduzgi rejimlarda bo'rilar to'dasi chalg'itmaydi (darhol hujum)", () => {
  it("1. FFA, 2–3 bo'ri bitta o'yinchiga: to'da birinchi tickdan hujumda (chalg'itish yo'q), birinchi tishlash ~3 s ichida", () => {
    const layouts = [
      [10, 14],
      [10, 14, 18],
    ];
    for (const dists of layouts) {
      const r = withSeededRandom(dists.length * 7919, () => runDayPack('ffa', dists));
      const formed = r.phases.filter((ph) => ph !== null);
      assert.ok(formed.length > 0, `${r.label}: to'da o'yinchini nishonga oldi`);
      assert.equal(r.phases[0], 'commit', `${r.label}: to'da birinchi tickdan hujumda (${r.phases[0]})`);
      assert.ok(
        formed.every((ph) => ph === 'commit'),
        `${r.label}: haydovchi chalg'itmadi (${formed.filter((ph) => ph === 'feint').length} tick 'feint')`,
      );
      assert.ok(r.firstBiteAt !== null, `${r.label}: bo'ri o'yinchini tishladi`);
      assert.ok(r.firstBiteAt! <= 2.5, `${r.label}: birinchi tishlash ${r.firstBiteAt!.toFixed(2)} s da (≤ 2.5 s)`);
      assert.equal(r.firstBiteRole, 'driver', `${r.label}: birinchi bo'lib haydovchi tishladi (${r.firstBiteRole})`);
    }
  });
});
