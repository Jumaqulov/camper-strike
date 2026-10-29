import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import { WOLF_DRIVER_FEINT_M, WOLF_DRIVER_LUNGE_M, angularSeparation, type PackOrder } from '../../server/wolfPack';
import { MAX_HP } from '../constants';
import type { Vec3 } from '../math';
import { collidesAtWorld } from '../physics';
import type { CreateRoomOpts } from '../protocol';
import { sampleTerrainHeight } from '../world';
import { TORCH_STANDOFF_M, WOLF_RADIUS, WOLF_WALK_SPEED } from '../wolf';

// Bosqich 31 — Tong otguncha: bo'ri harakati (lokomotsiya). To'siqqa tiralib sirpanayotgan bo'ri tanasini sirpanish
// tomoniga buradi (orqasi/yoni bilan to'liq tezlikda chopmaydi), aylanib o'tayotgan qanot ortga sirpanmaydi;
// chalg'itayotgan haydovchi otilgandan keyin sekin (yurish tezligida) chekinadi; qochayotgan bo'ri (tong, raketa)
// daraxt/quti burchagida qotib qolmaydi; halqa o'rni burchagiga yetib bo'lmasa bo'ri devorga tiralib turmaydi —
// joyida kutadi (nav tuguniga ko'chirilmaydi); qo'zg'almas halqa o'rniga yo'l ikki A* yo'li orasida chayqalmaydi.
// Xona haqiqiy Room, io/socket soxta; vaqt room.advanceTimeForTest bilan suriladi, Math.random urug'langan.

function createFakeIo(): Server {
  return {
    to() {
      const emitFn = () => {};
      return { emit: emitFn, volatile: { emit: emitFn } };
    },
  } as unknown as Server;
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

function makeNightRoom(overrides: Partial<CreateRoomOpts> = {}): Room {
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
    createFakeIo(),
    () => {},
  );
}

/** Odam tayyor bo'lib raundni boshlaydi (sanoq 2 s). */
function startNight(room: Room): ServerPlayer {
  room.addHuman(createFakeSocket('p1'), 'p1');
  room.onReady('p1', { world: room.worldMeta() });
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  const p = room.players.get('p1')!;
  p.spawnTime = -99;
  return p;
}

function groundAt(room: Room, x: number, z: number): Vec3 {
  return { x, y: sampleTerrainHeight(room.world.terrain, x, z), z };
}

/** Xonada aynan `n` ta yangi bo'ri (to'lqin bo'rilari olib tashlanadi, to'lqin uvlashi bu to'lqinda bo'lgan). */
function freshWolves(room: Room, n: number): ServerWolf[] {
  room.wolves.clear();
  (room.pack as unknown as { lastHowlWave: number }).lastHowlWave = room.currentNightWaveIdx();
  while (room.wolves.size < n) {
    const w = room.addWolf();
    assert.ok(w, "bo'ri qo'shildi");
  }
  return [...room.wolves.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Bo'rini joyga qo'yadi (tezlik 0, nishonga qaraydi). */
function placeWolf(w: ServerWolf, pos: Vec3, lookAt: Vec3): void {
  w.pos = { ...pos };
  w.vel = { x: 0, y: 0, z: 0 };
  w.yaw = Math.atan2(-(lookAt.x - pos.x), -(lookAt.z - pos.z));
}

/** O'yinchi joyida turadi (joni to'ldiriladi). */
function pin(p: ServerPlayer, pos: Vec3): void {
  p.pos = { ...pos };
  p.vel = { x: 0, y: 0, z: 0 };
  p.hp = MAX_HP;
}

const distXZ = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
/** Bo'rining old yo'nalishi (XZ birlik vektor). */
const facingOf = (w: ServerWolf) => ({ x: -Math.sin(w.yaw), z: -Math.cos(w.yaw) });

/** Mulberry32 — urug'langan PRNG: bo'ri AI va xona `Math.random` dan foydalanadi, testlar takrorlanuvchan bo'lsin. */
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

/** Deterministik RNG bilan test tanasi; `Math.random` doim qayta tiklanadi. */
function withSeededRandom<T>(seed: number, fn: () => T): T {
  const realRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = realRandom;
  }
}

/** Testlar uchun WolfBrain ning yopiq maydonlari (sirpanish, tiqilish, halqa siljishi, to'da buyrug'i). */
interface BrainInternals {
  slipDir: { x: number; z: number } | null;
  slipUntil: number;
  stuckCount: number;
  slideHoldUntil: number;
  lastWishX: number;
  lastWishZ: number;
  startSlip(t: number): void;
  checkStuck(t: number, wishing: boolean): void;
  setPackOrder(order: PackOrder | null, t: number): void;
}
const brainOf = (w: ServerWolf) => w.brain as unknown as BrainInternals;

/**
 * Ochiq maydon (gulxanlardan uzoq): nav tuguni `a`, undan +X tomonga `len` m to'siqsiz chiziq va atrofidagi `ring` m
 * halqa (12 nuqta) nav-grafda.
 */
function findOpenArena(room: Room, len: number, ring: number): Vec3 {
  const nav = room.nav;
  outer: for (const i of nav.roamList) {
    const a = nav.center(i);
    if (room.litFireContaining(a.x, a.z, 20)) continue;
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

interface SlipRun {
  /** Sirpanishlar (bo'sh yo'nalish topilgan startSlip) soni. */
  slips: number;
  /** Shulardan istakka teskari (|istak| bo'yicha kosinus < -0.3) yo'nalishdagilari. */
  backSlips: number;
  /** Sirpanish boshidan ~0.3 s o'tib hali sirpanayotgan va yurayotgan holatlar / shulardan tanasi sirpanish tomoniga qaragani. */
  checked: number;
  aligned: number;
  /** Sirpanishda ≥ 0.3 s uzluksiz orqasi bilan (harakat·old < −0.5, ≥ 2 m/s) yugurish epizodlari. */
  backGallops: number;
  /** Tishlash holatiga yetgan bo'rilar / jami. */
  attackers: number;
  wolves: number;
}

/**
 * Jonli to'da (3 bo'ri) o'rmonda 20 m dan keladi; o'yinchi joyida (`moving` — 4 m doirada sekin aylanadi). 15 s
 * davomida har sirpanish (startSlip) va har tickdagi tana yo'nalishi bilan harakat yo'nalishi yoziladi.
 */
function runSlipPack(seed: number, idx: number, moving: boolean): SlipRun {
  const room = makeNightRoom({ publicLayoutSeed: seed });
  const out: SlipRun = { slips: 0, backSlips: 0, checked: 0, aligned: 0, backGallops: 0, attackers: 0, wolves: 0 };
  try {
    const p = startNight(room);
    const nav = room.nav;
    const list = nav.roamList.filter((i) => !room.litFireContaining(nav.center(i).x, nav.center(i).z, 25));
    const a = nav.center(list[(idx * 97 + seed) % list.length]!);
    const pos0 = groundAt(room, a.x, a.z);
    pin(p, pos0);
    const wolves = freshWolves(room, 3);
    const slipAt = new Map<string, number>();
    wolves.forEach((w, i) => {
      const ang = (idx * 1.3 + i * 2.1) % (Math.PI * 2);
      const ni = nav.nearest({ x: a.x + Math.cos(ang) * 20, y: a.y, z: a.z + Math.sin(ang) * 20 });
      const c = nav.center(ni >= 0 ? ni : list[0]!);
      placeWolf(w, groundAt(room, c.x, c.z), pos0);
      const b = brainOf(w);
      const start = b.startSlip.bind(b);
      b.startSlip = (t: number) => {
        start(t);
        if (!b.slipDir) return;
        out.slips++;
        slipAt.set(w.id, t);
        const wl = Math.hypot(b.lastWishX, b.lastWishZ) || 1;
        if ((b.slipDir.x * b.lastWishX + b.slipDir.z * b.lastWishZ) / wl < -0.3) out.backSlips++;
      };
    });
    for (const w of wolves) room.pack.report(w, p, room.now());
    const prev = new Map(wolves.map((w) => [w.id, { x: w.pos.x, z: w.pos.z, back: 0, checkedSlip: -1, attacked: false }]));
    const step = 1 / 30;
    const t0 = room.now();
    for (let i = 0; i < 30 * 15; i++) {
      room.advanceTimeForTest(step, step);
      const tt = room.now() - t0;
      pin(p, moving ? groundAt(room, pos0.x + Math.cos(tt * 0.4) * 4, pos0.z + Math.sin(tt * 0.4) * 4) : pos0);
      const t = room.now();
      for (const w of wolves) {
        const pr = prev.get(w.id)!;
        if (w.state === 'attack') pr.attacked = true;
        const dx = w.pos.x - pr.x;
        const dz = w.pos.z - pr.z;
        pr.x = w.pos.x;
        pr.z = w.pos.z;
        const d = Math.hypot(dx, dz);
        const b = brainOf(w);
        const slip = !!b.slipDir && t < b.slipUntil;
        const v = d / step;
        const f = facingOf(w);
        const sa = slipAt.get(w.id);
        if (slip && sa !== undefined && sa !== pr.checkedSlip && t - sa >= 0.3 && v >= 1 && w.state !== 'attack') {
          pr.checkedSlip = sa;
          out.checked++;
          if (f.x * b.slipDir!.x + f.z * b.slipDir!.z >= 0.9) out.aligned++;
        }
        if (slip && v >= 2 && (dx * f.x + dz * f.z) / d < -0.5) {
          pr.back += step;
          if (pr.back >= 0.3 && pr.back < 0.3 + step) out.backGallops++;
        } else {
          pr.back = 0;
        }
      }
    }
    for (const w of wolves) {
      out.wolves++;
      if (prev.get(w.id)!.attacked) out.attackers++;
    }
    return out;
  } finally {
    room.destroy();
  }
}

/**
 * Tong (yoki raketa) qochishi: o'yinchi asosiy gulxan yonida, 4 bo'ri 18–30 m dan 12 s ovlaydi (halqada turadi), so'ng
 * `trigger`: 'dawn' — raund vaqti tugaydi (tong xori, keyin qochish), 'flare' — hammasi startScared (8 s). Qochish
 * ('flee') holatidagi har bo'rining eng uzun uzluksiz to'xtashi (< 0.3 m/s) va qochish boshidagi tiqilish hisobi.
 */
function runFlee(seed: number, layout: number, trigger: 'dawn' | 'flare'): { maxFreeze: number[]; stuckAtStart: number; fleeing: number } {
  const room = makeNightRoom({ publicLayoutSeed: seed });
  try {
    const p = startNight(room);
    const fire = [...room.campfires.values()].find((f) => f.main)!;
    let pos0: Vec3 | null = null;
    for (const r of [2, 2.5, 3]) {
      for (let k = 0; k < 16 && !pos0; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const pt = groundAt(room, fire.x + Math.cos(ang) * r, fire.z + Math.sin(ang) * r);
        if (!collidesAtWorld(room.world, pt.x, pt.y + 0.05, pt.z)) pos0 = pt;
      }
      if (pos0) break;
    }
    assert.ok(pos0, "gulxan yonida bo'sh joy");
    pin(p, pos0);
    const wolves = freshWolves(room, 4);
    const nav = room.nav;
    const cands = nav.roamList
      .map((i) => nav.center(i))
      .filter((c) => {
        const d = distXZ(c, fire);
        return d > 18 && d < 30;
      });
    wolves.forEach((w, i) => placeWolf(w, cands[(i * 11 + layout * 7 + seed) % cands.length]!, pos0!));
    const step = 1 / 30;
    for (let i = 0; i < 12 * 30; i++) {
      for (const w of wolves) room.pack.report(w, p, room.now());
      room.advanceTimeForTest(step, step);
      pin(p, pos0);
    }
    if (trigger === 'dawn') {
      room.setSurvivalConfigForTest({ roundDurationSec: 1 });
      for (let i = 0; i < 90 && room.phase === 'playing'; i++) {
        room.advanceTimeForTest(step, step);
        pin(p, pos0);
      }
      assert.equal(room.phase, 'ended', 'tong otdi');
    } else {
      for (const w of wolves) w.brain.startScared(room.now(), 8);
    }
    const prev = new Map(wolves.map((w) => [w.id, { ...w.pos }]));
    const run = new Map<string, number>();
    const maxRun = new Map<string, number>();
    const seen = new Set<string>();
    let stuckAtStart = 0;
    for (let i = 0; i < 30 * (trigger === 'dawn' ? 12 : 8); i++) {
      room.advanceTimeForTest(step, step);
      pin(p, pos0);
      for (const w of wolves) {
        const before = prev.get(w.id)!;
        prev.set(w.id, { ...w.pos });
        if (!room.wolves.has(w.id) || w.state !== 'flee') {
          run.set(w.id, 0);
          continue;
        }
        if (!seen.has(w.id)) {
          seen.add(w.id);
          const b = brainOf(w);
          if (b.stuckCount > 0 || (b.slipDir && b.slipUntil > room.now())) stuckAtStart++;
          continue;
        }
        const r = distXZ(w.pos, before) < 0.3 * step ? (run.get(w.id) ?? 0) + step : 0;
        run.set(w.id, r);
        maxRun.set(w.id, Math.max(maxRun.get(w.id) ?? 0, r));
      }
    }
    return { maxFreeze: wolves.map((w) => maxRun.get(w.id) ?? 0), stuckAtStart, fleeing: seen.size };
  } finally {
    room.destroy();
  }
}

interface WallSpot {
  pos: Vec3;
  /** Nuqtadan devor tomon yo'nalish (XZ burchak, rad). */
  wallDir: number;
  /** Xarita chegarasidan uzoqda (kulba/bino devori), aks holda xarita chetidagi to'siq. */
  inner: boolean;
}

/**
 * Devorga suyanib turish joylari (Bosqich 30 dagidek): nav tuguni gulxanlardan uzoq, 3.5 m dagi 16 nuqtadan 5..8 tasi
 * to'silgan, mash'al halqasining kamida 9/36 nuqtasi to'siq ichida, devorga qarama-qarshi tomoni (±60°) bo'sh, ochiq
 * tomonda 15 m da nav tugunlari bor; joylar bir-biridan ≥ 25 m.
 */
function findWallSpots(room: Room): WallSpot[] {
  const nav = room.nav;
  const bounds = room.world.bounds;
  const out: WallSpot[] = [];
  outer: for (const i of nav.roamList) {
    const c = nav.center(i);
    if (room.litFireContaining(c.x, c.z, 10)) continue;
    if (out.some((s) => distXZ(s.pos, c) < 25)) continue;
    let blocked = 0;
    let sx = 0;
    let sz = 0;
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const pt = groundAt(room, c.x + Math.cos(ang) * 3.5, c.z + Math.sin(ang) * 3.5);
      if (collidesAtWorld(room.world, pt.x, pt.y + 0.3, pt.z, 0.4, 1.0)) {
        blocked++;
        sx += Math.cos(ang);
        sz += Math.sin(ang);
      }
    }
    if (blocked < 5 || blocked > 8) continue;
    const wallDir = Math.atan2(sz, sx);
    let ring = 0;
    for (let k = 0; k < 36; k++) {
      const ang = (k / 36) * Math.PI * 2;
      const pt = groundAt(room, c.x + Math.cos(ang) * TORCH_STANDOFF_M, c.z + Math.sin(ang) * TORCH_STANDOFF_M);
      if (!collidesAtWorld(room.world, pt.x, pt.y + 0.05, pt.z, WOLF_RADIUS, 1.0)) continue;
      if (angularSeparation(ang, wallDir + Math.PI) <= Math.PI / 3) continue outer;
      ring++;
    }
    if (ring < 9) continue;
    for (const da of [-0.5, 0, 0.5]) {
      const o = groundAt(room, c.x + Math.cos(wallDir + Math.PI + da) * 15, c.z + Math.sin(wallDir + Math.PI + da) * 15);
      const ni = nav.nearest(o);
      if (ni < 0 || distXZ(nav.center(ni), o) > 3) continue outer;
    }
    const edge = Math.min(c.x - bounds.minX, bounds.maxX - c.x, c.z - bounds.minZ, bounds.maxZ - c.z);
    out.push({ pos: groundAt(room, c.x, c.z), wallDir, inner: edge >= 10 });
  }
  return out;
}

/**
 * To'da buyrug'idagi halqa o'rnini (burchak, radius) majburan almashtiradi — o'rin to'da koordinatori qanday tanlashidan
 * qat'i nazar (to'silgan o'rin, qo'zg'almas o'rin).
 */
function forceSlot(w: ServerWolf, angle: number, r: number): void {
  const b = brainOf(w);
  const set = b.setPackOrder.bind(b);
  b.setPackOrder = (o, t) => set(o && o.standoffAngle !== undefined ? { ...o, standoffAngle: angle, standoffR: r } : o, t);
}

/**
 * checkStuck o'rab olinadi (har tick chaqiriladi): tiqilish tekshiruvi bo'rini nav tuguniga ko'chirgan (teleport)
 * holatlar soni va shu tickda istak (yurishga urinish) bormi.
 */
function watchStuck(w: ServerWolf): { teleports: number; wishing: boolean } {
  const b = brainOf(w);
  const check = b.checkStuck.bind(b);
  const s = { teleports: 0, wishing: false };
  b.checkStuck = (t, wishing) => {
    const before = { ...w.pos };
    check(t, wishing);
    s.wishing = wishing;
    if (distXZ(before, w.pos) > 0.01) s.teleports++;
  };
  return s;
}

describe("Bosqich 31 — bo'ri harakati: sirpanishda tana yo'nalishi, chalg'itishda sekin chekinish, qochishda qotmaslik, halqa o'rni", () => {
  it("1. Sirpanish boshlandi (orqaga / yonga): ~0.3 s ichida tana sirpanish tomoniga o'giriladi va shu tomonga yuradi", () => {
    for (const side of ['back', 'left'] as const) {
      withSeededRandom(3101, () => {
        const room = makeNightRoom({ publicLayoutSeed: 6501 });
        try {
          const p = startNight(room);
          const a = findOpenArena(room, 16, 10);
          const pos0 = groundAt(room, a.x, a.z);
          pin(p, pos0);
          const [w] = freshWolves(room, 1);
          placeWolf(w!, groundAt(room, a.x + 16, a.z), pos0);
          room.pack.report(w!, p, room.now());
          const step = 1 / 30;
          for (let i = 0; i < 6; i++) {
            room.advanceTimeForTest(step, step);
            pin(p, pos0);
          }
          assert.equal(w!.state, 'hunt', "bo'ri ovda");
          const f0 = facingOf(w!);
          assert.ok(-f0.x > 0.95, "bo'ri o'yinchiga (−X) qarab yuguradi");
          // Tiralishdan keyingi sirpanish: orqaga (old tomonga teskari) yoki chap yonga
          const dir = side === 'back' ? { x: -f0.x, z: -f0.z } : { x: -f0.z, z: f0.x };
          const b = brainOf(w!);
          b.slipDir = dir;
          b.slipUntil = room.now() + 0.8;
          let last = { ...w!.pos };
          for (let i = 0; i < 9; i++) {
            last = { ...w!.pos };
            room.advanceTimeForTest(step, step);
            pin(p, pos0);
          }
          const f = facingOf(w!);
          const mx = w!.pos.x - last.x;
          const mz = w!.pos.z - last.z;
          const ml = Math.hypot(mx, mz);
          assert.ok(f.x * dir.x + f.z * dir.z > 0.97, `${side}: 0.3 s da tana sirpanish tomoniga qaragan (cos ${(f.x * dir.x + f.z * dir.z).toFixed(2)})`);
          assert.ok(ml / step > 4, `${side}: sirpanish tezligi saqlangan (${(ml / step).toFixed(1)} m/s)`);
          assert.ok((mx * f.x + mz * f.z) / ml > 0.95, `${side}: oldinga qarab yuradi — orqasi/yoni bilan emas`);
        } finally {
          room.destroy();
        }
      });
    }
  });

  it("2. Jonli to'da daraxtlar orasidan keladi: sirpanishlar bo'ladi, lekin hech bir bo'ri sirpanishda orqasi bilan chopmaydi, aylanib o'tayotgan qanot ortga sirpanmaydi", () => {
    const tot: SlipRun = { slips: 0, backSlips: 0, checked: 0, aligned: 0, backGallops: 0, attackers: 0, wolves: 0 };
    withSeededRandom(3102, () => {
      for (let s = 0; s < 3; s++) {
        for (let k = 0; k < 4; k++) {
          for (const moving of [true, false]) {
            const r = runSlipPack(7100 + s, moving ? k : k + 10, moving);
            for (const key of Object.keys(tot) as (keyof SlipRun)[]) tot[key] += r[key];
          }
        }
      }
    });
    const label = JSON.stringify(tot);
    assert.ok(tot.slips >= 8, `sirpanishlar bo'ldi (${label})`);
    assert.equal(tot.backGallops, 0, `sirpanishda orqasi bilan yugurish yo'q (${label})`);
    assert.ok(tot.checked >= 5 && tot.aligned >= tot.checked * 0.9, `0.3 s da tana sirpanish tomoniga qaragan (${label})`);
    assert.ok(tot.backSlips <= Math.max(2, tot.slips * 0.1), `istakka teskari sirpanishlar kam (${label})`);
    assert.ok(tot.attackers >= tot.wolves * 0.95, `bo'rilar baribir tishlashga yetadi (${label})`);
  });

  it("3. Haydovchi chalg'itishda otilib, yurish tezligida (WOLF_WALK_SPEED) orqaga chekinadi — otilishning o'zi tez qoladi", () => {
    let backOffMax = 0;
    let lungeMax = 0;
    let minDist = Infinity;
    let backOffTicks = 0;
    withSeededRandom(3103, () => {
      for (const seed of [6501, 6502, 6503]) {
        const room = makeNightRoom({ publicLayoutSeed: seed });
        try {
          const p = startNight(room);
          const a = findOpenArena(room, 24, 12);
          const pos0 = groundAt(room, a.x, a.z);
          pin(p, pos0);
          const wolves = freshWolves(room, 3);
          [20, 24, 24].forEach((d, i) => placeWolf(wolves[i]!, groundAt(room, a.x + d, a.z + (i - 1) * 2), pos0));
          for (const w of wolves) room.pack.report(w, p, room.now());
          const step = 1 / 30;
          const prevD = new Map(wolves.map((w) => [w.id, distXZ(w.pos, pos0)]));
          for (let i = 0; i < 30 * 10; i++) {
            room.advanceTimeForTest(step, step);
            pin(p, pos0);
            // O'yinchi to'da tomonga qaraydi (qanotlar orqaga yetguncha to'da chalg'itadi)
            p.yaw = Math.atan2(-1, 0);
            const phase = room.pack.huntPhaseOf('p1');
            for (const w of wolves) {
              const d = distXZ(w.pos, pos0);
              const vr = (d - prevD.get(w.id)!) / step;
              prevD.set(w.id, d);
              if (w.role !== 'driver' || phase !== 'feint' || d > WOLF_DRIVER_FEINT_M + 1.5) continue;
              minDist = Math.min(minDist, d);
              if (vr > 0.3) {
                backOffTicks++;
                backOffMax = Math.max(backOffMax, vr);
              } else {
                lungeMax = Math.max(lungeMax, -vr);
              }
            }
          }
        } finally {
          room.destroy();
        }
      }
    });
    const label = `chekinish max ${backOffMax.toFixed(2)} m/s (${backOffTicks} tick), otilish max ${lungeMax.toFixed(2)} m/s, eng yaqin ${minDist.toFixed(2)} m`;
    assert.ok(minDist <= WOLF_DRIVER_FEINT_M - 1 && minDist >= WOLF_DRIVER_LUNGE_M - 0.8, `haydovchi aldab otildi (${label})`);
    assert.ok(backOffTicks >= 10, `otilishdan keyin chekindi (${label})`);
    assert.ok(backOffMax <= WOLF_WALK_SPEED + 0.1, `chekinish yurish tezligida (${label})`);
    assert.ok(lungeMax > WOLF_WALK_SPEED + 1, `otilish tez (${label})`);
  });

  it("4. Tong otdi / raketa yondi: qochayotgan bo'rilar daraxt va quti burchagida ≥ 1 s qotib turmaydi, joyida uvlash tiqilish deb hisoblanmaydi", () => {
    const frozen: string[] = [];
    let stuckAtStart = 0;
    let fleeing = 0;
    withSeededRandom(3104, () => {
      for (const seed of [2024, 31337, 8080, 6501, 42, 9]) {
        for (const layout of [0, 1, 2]) {
          for (const trigger of ['dawn', 'flare'] as const) {
            if (trigger === 'flare' && layout > 0) continue;
            const r = runFlee(seed, layout, trigger);
            stuckAtStart += r.stuckAtStart;
            fleeing += r.fleeing;
            r.maxFreeze.forEach((m, i) => {
              if (m >= 1) frozen.push(`${trigger} seed=${seed}/${layout} #${i} ${m.toFixed(2)} s`);
            });
          }
        }
      }
    });
    assert.ok(fleeing >= 80, `bo'rilar qochdi (${fleeing})`);
    assert.deepEqual(frozen, [], 'qochishda ≥ 1 s qotib turgan bo\'ri yo\'q');
    assert.equal(stuckAtStart, 0, "qochish boshida tiqilish hisobi va eski sirpanish yo'q");
  });

  it("5. Mash'alchi xarita chetiga suyangan, bo'rining halqa o'rni devor ichida (yetib bo'lmaydi): bo'ri devorga tiralmaydi — joyida kutadi, nav tuguniga ko'chirilmaydi va seskanmaydi", () => {
    const report: string[] = [];
    for (const seed of [6501, 1]) {
      withSeededRandom(3105 + seed, () => {
        const room = makeNightRoom({ publicLayoutSeed: seed });
        try {
          const p = startNight(room);
          const spot = findWallSpots(room).find((s) => !s.inner);
          assert.ok(spot, 'xarita chetida devor joyi');
          const pos0 = spot.pos;
          pin(p, pos0);
          p.torchUntil = room.now() + 300;
          const wolves = freshWolves(room, 3);
          const open = spot.wallDir + Math.PI;
          wolves.forEach((w, k) => {
            const ang = open + (k - 1) * 0.4;
            const c = room.nav.center(room.nav.nearest(groundAt(room, pos0.x + Math.cos(ang) * 13, pos0.z + Math.sin(ang) * 13)));
            placeWolf(w, c, pos0);
          });
          // Birinchi bo'rining o'rni — devor tomonda (o'rin nuqtasi to'siq ichida)
          const blocked = wolves[0]!;
          const sp = groundAt(room, pos0.x + Math.cos(spot.wallDir) * TORCH_STANDOFF_M, pos0.z + Math.sin(spot.wallDir) * TORCH_STANDOFF_M);
          assert.ok(collidesAtWorld(room.world, sp.x, sp.y + 0.05, sp.z, WOLF_RADIUS + 0.15, 1.0), "o'rin nuqtasi to'siq ichida");
          forceSlot(blocked, spot.wallDir, TORCH_STANDOFF_M);
          const stuck = watchStuck(blocked);
          const flinch0 = wolves.map((w) => w.brain.fearFlinchCount);
          const step = 1 / 30;
          let held = 0;
          let pushing = 0;
          for (let i = 0; i < 30 * 40; i++) {
            for (const w of wolves) room.pack.report(w, p, room.now());
            room.advanceTimeForTest(step, step);
            pin(p, pos0);
            if (i < 30 * 10) continue;
            if (room.now() < brainOf(blocked).slideHoldUntil) held++;
            else if (stuck.wishing && Math.hypot(blocked.vel.x, blocked.vel.z) < 0.3) pushing++;
          }
          const flinches = wolves.map((w, k) => w.brain.fearFlinchCount - flinch0[k]!);
          report.push(`seed=${seed}: teleport=${stuck.teleports} kutdi=${(held / 30).toFixed(1)} s tiraldi=${(pushing / 30).toFixed(1)} s seskanish=${flinches.join('/')}`);
          assert.equal(stuck.teleports, 0, `nav tuguniga ko'chirilmadi (${report.at(-1)})`);
          assert.deepEqual(flinches, [0, 0, 0], `seskanmadi (${report.at(-1)})`);
          assert.ok(held > 30 * 15, `ko'p vaqt joyida kutdi (${report.at(-1)})`);
          assert.ok(pushing < held / 3, `devorga kamdan-kam tiraladi (${report.at(-1)})`);
        } finally {
          room.destroy();
        }
      });
    }
  });

  it("6. Qo'zg'almas halqa o'rni kulba ortida (seed 42, ikki A* yo'li almashinadigan joy): bo'ri borib-kelib qolmaydi — o'rniga tez yetadi", () => {
    const report: string[] = [];
    for (const [sx, sz] of [
      [42, 90],
      [44, 92],
      [46, 94],
    ] as const) {
      for (const rs of [1, 2, 3]) {
        withSeededRandom(3106 + rs * 31 + sx, () => {
          const room = makeNightRoom({ publicLayoutSeed: 42 });
          try {
            const p = startNight(room);
            const pos0 = groundAt(room, 34, 82);
            assert.ok(!collidesAtWorld(room.world, pos0.x, pos0.y + 0.05, pos0.z), "mash'alchi joyi bo'sh");
            pin(p, pos0);
            p.torchUntil = room.now() + 300;
            const [w] = freshWolves(room, 1);
            const ni = room.nav.nearest(groundAt(room, sx, sz));
            placeWolf(w!, room.nav.center(ni), pos0);
            const ang = (100 * Math.PI) / 180;
            forceSlot(w!, ang, TORCH_STANDOFF_M);
            const slot = { x: pos0.x + Math.cos(ang) * TORCH_STANDOFF_M, z: pos0.z + Math.sin(ang) * TORCH_STANDOFF_M };
            const step = 1 / 30;
            const t0 = room.now();
            let reachedAt = -1;
            for (let i = 0; i < 30 * 25 && reachedAt < 0; i++) {
              room.pack.report(w!, p, room.now());
              room.advanceTimeForTest(step, step);
              pin(p, pos0);
              if (distXZ(w!.pos, slot) < 1.5) reachedAt = room.now() - t0;
            }
            report.push(`(${sx},${sz}) rs=${rs}: ${reachedAt < 0 ? 'yetmadi' : `${reachedAt.toFixed(1)} s`}`);
          } finally {
            room.destroy();
          }
        });
      }
    }
    const slow = report.filter((r) => r.endsWith('yetmadi') || Number(r.split(': ')[1]!.split(' ')[0]) > 10);
    assert.deepEqual(slow, [], `hamma boshlang'ich joydan o'ringa ≤ 10 s da yetadi: ${report.join(', ')}`);
  });
});
