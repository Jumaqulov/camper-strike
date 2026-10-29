import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import {
  WOLF_DRIVER_FEINT_M,
  WOLF_DRIVER_LUNGE_M,
  WOLF_FLANK_ENGAGE_M,
  WOLF_PACK_COMMIT_MAX_SEC,
  angularSeparation,
  type PackOrder,
} from '../../server/wolfPack';
import { MAX_HP } from '../constants';
import type { Vec3 } from '../math';
import { collidesAtWorld } from '../physics';
import type { CreateRoomOpts } from '../protocol';
import { sampleTerrainHeight } from '../world';
import {
  CAMPFIRE_RADIUS_M,
  CAMPFIRE_STANDOFF_M,
  FLARE_FEAR_RADIUS_M,
  FLARE_STANDOFF_M,
  TORCH_STANDOFF_M,
  WOLF_MAX_HP,
  WOLF_RADIUS,
  type WolfBiteEvent,
  type WolfHowlEvent,
} from '../wolf';

// Bosqich 30 — Tong otguncha: to'da taktikasi jonli dinamikada. Haydovchi nishon oldida chalg'itadi (irillab turadi,
// aldab otiladi), qanotlar kengroq doira bo'ylab o'z tomonidan aylanib orqa sektorga yetadi va orqadan tashlanadi;
// to'lqin boshidagi uvlashda vazifa almashmaydi; haqiqiy asosiy gulxan atrofida (kulba, panjara, o'tin g'aramlari
// orasida) to'da halqa bo'ylab yoyiladi; mash'al ko'targan o'yinchi gulxan yonidagidek himoyalangan deb baholanadi.
// O'yinchi yaqinlashayotgan bo'rini otsa butun to'da hujumga o'tmaydi (faqat zarba yegani qasos oladi); hujum
// boshlangandan keyin qo'shilgan bo'rilar ham orqadan aylanib keladi; nishonning olov manbai (raketa ↔ mash'al)
// almashsa halqa radiusi eskirmaydi.
// Bo'rilar hech qayerda ushlab turilmaydi (faqat o'yinchi joyida, joni to'ldiriladi); xona haqiqiy Room, io/socket
// soxta; vaqt room.advanceTimeForTest bilan suriladi.

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

/** Odamlar tayyor bo'lib raundni boshlaydi (sanoq 2 s). */
function startNight(room: Room, ids: string[]): ServerPlayer[] {
  for (const id of ids) room.addHuman(createFakeSocket(id), id);
  for (const id of ids) room.onReady(id, { world: room.worldMeta() });
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  return ids.map((id) => {
    const p = room.players.get(id)!;
    p.spawnTime = -99;
    return p;
  });
}

function groundAt(room: Room, x: number, z: number): Vec3 {
  return { x, y: sampleTerrainHeight(room.world.terrain, x, z), z };
}

/**
 * Xonada aynan `n` ta yangi bo'ri: to'lqin raund boshida chiqargan bo'rilar olib tashlanadi (ular tasodifiy joyda
 * tug'iladi va o'yinchini oldinroq sezib, to'lqin uvlashini ishlatib qo'yishi mumkin). `howl` — to'lqindagi birinchi
 * nishon uvlashi qaytadan kutiladi (false — bu to'lqinda allaqachon uvlangan).
 */
function freshWolves(room: Room, n: number, howl = true): ServerWolf[] {
  room.wolves.clear();
  (room.pack as unknown as { lastHowlWave: number }).lastHowlWave = howl ? -2 : room.currentNightWaveIdx();
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

const distXZ = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const angleFrom = (c: { x: number; z: number }, pt: { x: number; z: number }) => Math.atan2(pt.z - c.z, pt.x - c.x);
const toDeg = (r: number) => (r * 180) / Math.PI;

/**
 * Ochiq maydon (gulxanlardan uzoq): nav tuguni `a`, undan `dir` (±1) tomonga X o'qi bo'ylab `len` m to'siqsiz
 * chiziq va atrofidagi `ring` m halqa (12 nuqta) nav-grafda. `skip` — shuncha mos maydon o'tkazib yuboriladi
 * (turli boshlang'ich joylashuvlar).
 */
function findOpenArena(room: Room, len: number, ring: number, dir: 1 | -1, skip: number): Vec3 {
  const nav = room.nav;
  let found = 0;
  outer: for (const i of nav.roamList) {
    const a = nav.center(i);
    if (room.litFireContaining(a.x, a.z, 20)) continue;
    const j = nav.nearest({ x: a.x + dir * len, y: a.y, z: a.z });
    if (j < 0) continue;
    const b = nav.center(j);
    if (Math.hypot(b.x - a.x - dir * len, b.z - a.z) > 2.5 || Math.abs(b.y - a.y) > 0.8) continue;
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
    if (found++ < skip) continue;
    return a;
  }
  throw new Error('ochiq maydon topilmadi');
}

type Facing = 'pack' | 'side' | 'away' | 'track';

interface FlankerResult {
  id: string;
  /** Birinchi tishlash burchagi — to'da kelgan (haydovchi yaqinlashgan) yo'nalishdan, gradus. */
  biteDeg: number;
  /** Tishlashdan oldin qanot maydoniga yetdi (o'z nuqtasiga ≤ 2.5 m yoki orqa sektorda ≤ WOLF_FLANK_ENGAGE_M). */
  reached: boolean;
  /** Tishlashdan oldin old sektorda (haydovchi yo'nalishidan < 60°) nishonga 7 m dan yaqin kelgan. */
  cutFront: boolean;
}

interface LiveRun {
  label: string;
  /** To'lqin uvlashi bo'ldi (haydovchi 3 s uvlaydi — qanotlar bu orada joyiga yetib olishi mumkin). */
  howl: boolean;
  flankers: FlankerResult[];
  driverBiteAt: number | null;
  commitAt: number | null;
  /** Chalg'itish bosqichida haydovchi nishon oldida (LUNGE − 0.6 .. FEINT + 1.5 m) turgan vaqt (s). */
  feintHeldSec: number;
  /** Chalg'itish bosqichidagi haydovchining nishongacha eng kichik masofasi. */
  feintMinDist: number;
  /** Hujumgacha haydovchi vazifasining almashishlari. */
  driverFlips: number;
  /** O'yinchi otgan bo'lsa: birinchi zarbadan keyingi tickdagi hujum bosqichi (undefined — otmadi). */
  shotPhase?: 'feint' | 'commit' | null;
}

/**
 * O'yinchi bo'rini otdi: xonaning haqiqiy zarba yo'li (damageWolf → onDamaged → to'daga qasos xabari, turtki) va
 * o'q ovozi (onNoise); bo'ri o'lmasin deb joni to'ldiriladi.
 */
function shootWolf(room: Room, w: ServerWolf, p: ServerPlayer): void {
  const r = room as unknown as { damageWolf(w: ServerWolf, attacker: ServerPlayer, amount: number, from: Vec3): void };
  r.damageWolf(w, p, 10, { ...p.pos });
  w.hp = WOLF_MAX_HP;
  for (const o of room.wolves.values()) if (o.alive) o.brain.onNoise({ ...p.pos }, room.now(), p);
}

/**
 * Jonli to'da: 3 bo'ri ochiq maydonda bir tomondan (`dists` m) keladi, o'yinchi joyida (joni to'ldiriladi),
 * `facing` bo'yicha qaraydi ('track' — eng yaqin bo'riga burilib turadi). 12 s davomida hech bir bo'ri ushlab
 * turilmaydi; har bo'rining birinchi tishlashi, qanot maydoniga yetgani va hujum bosqichi yoziladi. `shootRange` > 0
 * — o'yinchi shu masofadagi eng yaqin bo'rini har 0.6 s da otadi.
 */
function runLivePack(seed: number, dists: number[], facing: Facing, dir: 1 | -1, skip: number, howl: boolean, shootRange = 0): LiveRun {
  const { io, emitted } = createFakeIo();
  const room = makeNightRoom(io, { publicLayoutSeed: seed });
  try {
    const [p] = startNight(room, ['p1']);
    const a = findOpenArena(room, 20, 12, dir, skip);
    const pos0 = groundAt(room, a.x, a.z);
    p!.pos = { ...pos0 };
    // To'lqin uvlashi faqat birinchi nishonda — uvlashsiz holatni ham sinaymiz
    const wolves = freshWolves(room, 3, howl);
    dists.forEach((d, i) => placeWolf(wolves[i]!, groundAt(room, a.x + dir * d, a.z + (i - 1) * 2), pos0));
    for (const w of wolves) room.pack.report(w, p!, room.now());
    const approach = dir > 0 ? 0 : Math.PI;
    const t0 = room.now();
    let seen = emitted.length;
    const first = new Map<string, FlankerResult>();
    const reached = new Set<string>();
    const cutFront = new Set<string>();
    let driverBiteAt: number | null = null;
    let commitAt: number | null = null;
    let feintHeldSec = 0;
    let feintMinDist = Infinity;
    let feintStarted = false;
    let driverFlips = 0;
    let lastDriver: string | null = null;
    let lastShot = -99;
    let shotPending = false;
    let shotPhase: LiveRun['shotPhase'];
    const step = 1 / 30;
    for (let i = 0; i < 30 * 12; i++) {
      if (shootRange > 0) {
        const near = wolves.reduce((b, w) => (distXZ(w.pos, pos0) < distXZ(b.pos, pos0) ? w : b));
        const ts = room.now() - t0;
        if (distXZ(near.pos, pos0) <= shootRange && ts - lastShot >= 0.6) {
          lastShot = ts;
          shootWolf(room, near, p!);
          if (shotPhase === undefined) shotPending = true;
        }
      }
      room.advanceTimeForTest(step, step);
      if (shotPending) {
        shotPending = false;
        shotPhase = room.pack.huntPhaseOf('p1');
      }
      p!.pos = { ...pos0 };
      p!.vel = { x: 0, y: 0, z: 0 };
      p!.hp = MAX_HP;
      if (facing === 'pack') p!.yaw = Math.atan2(-Math.cos(approach), -Math.sin(approach));
      else if (facing === 'side') p!.yaw = Math.atan2(-Math.cos(approach + Math.PI / 2), -Math.sin(approach + Math.PI / 2));
      else if (facing === 'away') p!.yaw = Math.atan2(Math.cos(approach), Math.sin(approach));
      else {
        const near = wolves.reduce((b, w) => (distXZ(w.pos, pos0) < distXZ(b.pos, pos0) ? w : b));
        p!.yaw = Math.atan2(-(near.pos.x - pos0.x), -(near.pos.z - pos0.z));
      }
      const t = room.now() - t0;
      const driver = wolves.find((w) => w.role === 'driver');
      const phase = room.pack.huntPhaseOf('p1');
      if (phase === 'commit' && commitAt === null) commitAt = t;
      if (driver) {
        if (lastDriver && driver.id !== lastDriver && commitAt === null) driverFlips++;
        lastDriver = driver.id;
      }
      if (driver && phase === 'feint') {
        const dd = distXZ(driver.pos, pos0);
        if (dd <= WOLF_DRIVER_FEINT_M + 1.5) feintStarted = true;
        if (feintStarted) {
          feintMinDist = Math.min(feintMinDist, dd);
          if (dd >= WOLF_DRIVER_LUNGE_M - 0.6 && dd <= WOLF_DRIVER_FEINT_M + 1.5) feintHeldSec += step;
        }
      }
      const drvAng = driver ? angleFrom(pos0, driver.pos) : approach;
      for (const w of wolves) {
        if (w.role !== 'flanker' || first.has(w.id)) continue;
        const d = distXZ(w.pos, pos0);
        const rel = angularSeparation(drvAng, angleFrom(pos0, w.pos));
        const g = room.pack.flankGoalOf(w.id);
        if ((g && distXZ(g, w.pos) < 2.5) || (rel >= Math.PI / 2 && d <= WOLF_FLANK_ENGAGE_M)) reached.add(w.id);
        if (!reached.has(w.id) && rel < Math.PI / 3 && d < 7) cutFront.add(w.id);
      }
      for (; seen < emitted.length; seen++) {
        const e = emitted[seen]!;
        if (e.event !== 'wolf:bite' || !(e.payload as WolfBiteEvent).hit) continue;
        const w = room.wolves.get((e.payload as WolfBiteEvent).id);
        if (!w) continue;
        if (w.role === 'driver' && driverBiteAt === null) driverBiteAt = t;
        if (w.role !== 'flanker' || first.has(w.id)) continue;
        first.set(w.id, {
          id: w.id,
          biteDeg: toDeg(angularSeparation(approach, angleFrom(pos0, w.pos))),
          reached: reached.has(w.id),
          cutFront: cutFront.has(w.id),
        });
      }
    }
    return {
      label: `seed=${seed} d=${dists.join('/')} ${facing} dir=${dir} skip=${skip} howl=${howl}`,
      howl,
      flankers: [...first.values()],
      driverBiteAt,
      commitAt,
      feintHeldSec,
      feintMinDist,
      driverFlips,
      shotPhase,
    };
  } finally {
    room.destroy();
  }
}

interface LateJoinRun {
  label: string;
  /** Sheriklar qo'shilishidan oldingi hujum bosqichi (yakka bo'ri — 'commit'). */
  phaseBeforeJoin: 'feint' | 'commit' | null;
  /** Qo'shilgan bo'rilarning birinchi tishlashlari (burchak — yakka bo'ri kelgan yo'nalishdan). */
  joiners: FlankerResult[];
}

/**
 * Yakka bo'ri o'yinchini birinchi topadi (12 m dan, darhol hujum qiladi), `joinAt` s dan keyin ikki sherigi o'sha
 * tomondan 26 m dan qo'shiladi. O'yinchi joyida (joni to'ldiriladi), `facing`: 'pack' — kelish tomoniga, 'side' —
 * yonga qaraydi. 16 s davomida qo'shilganlarning birinchi tishlashi, qanot maydoniga yetgani yoziladi.
 */
function runLateJoin(seed: number, joinAt: number, facing: 'pack' | 'side'): LateJoinRun {
  const { io, emitted } = createFakeIo();
  const room = makeNightRoom(io, { publicLayoutSeed: seed });
  try {
    const [p] = startNight(room, ['p1']);
    const a = findOpenArena(room, 26, 12, 1, 0);
    const pos0 = groundAt(room, a.x, a.z);
    p!.pos = { ...pos0 };
    const [lone] = freshWolves(room, 1, false);
    placeWolf(lone!, groundAt(room, a.x + 12, a.z), pos0);
    room.pack.report(lone!, p!, room.now());
    const approach = 0;
    const t0 = room.now();
    let seen = emitted.length;
    let phaseBeforeJoin: LateJoinRun['phaseBeforeJoin'] = null;
    let joiners: ServerWolf[] = [];
    const first = new Map<string, FlankerResult>();
    const reached = new Set<string>();
    const cutFront = new Set<string>();
    const step = 1 / 30;
    for (let i = 0; i < 30 * 16; i++) {
      if (joiners.length === 0 && room.now() - t0 >= joinAt) {
        phaseBeforeJoin = room.pack.huntPhaseOf('p1');
        const j1 = room.addWolf();
        const j2 = room.addWolf();
        assert.ok(j1 && j2, "sheriklar qo'shildi");
        joiners = [j1, j2];
        joiners.forEach((w, k) => {
          placeWolf(w, groundAt(room, a.x + 26, a.z + (k === 0 ? 2 : -2)), pos0);
          room.pack.report(w, p!, room.now());
        });
      }
      room.advanceTimeForTest(step, step);
      p!.pos = { ...pos0 };
      p!.vel = { x: 0, y: 0, z: 0 };
      p!.hp = MAX_HP;
      p!.yaw = facing === 'pack' ? Math.atan2(-Math.cos(approach), -Math.sin(approach)) : Math.atan2(-Math.cos(approach + Math.PI / 2), -Math.sin(approach + Math.PI / 2));
      for (const w of joiners) {
        if (first.has(w.id)) continue;
        const d = distXZ(w.pos, pos0);
        const rel = angularSeparation(approach, angleFrom(pos0, w.pos));
        const g = room.pack.flankGoalOf(w.id);
        if (w.role === 'flanker' && ((g && distXZ(g, w.pos) < 2.5) || (rel >= Math.PI / 2 && d <= WOLF_FLANK_ENGAGE_M))) reached.add(w.id);
        if (!reached.has(w.id) && rel < Math.PI / 3 && d < 7) cutFront.add(w.id);
      }
      for (; seen < emitted.length; seen++) {
        const e = emitted[seen]!;
        if (e.event !== 'wolf:bite' || !(e.payload as WolfBiteEvent).hit) continue;
        const w = joiners.find((j) => j.id === (e.payload as WolfBiteEvent).id);
        if (!w || first.has(w.id)) continue;
        first.set(w.id, {
          id: w.id,
          biteDeg: toDeg(angularSeparation(approach, angleFrom(pos0, w.pos))),
          reached: reached.has(w.id),
          cutFront: cutFront.has(w.id),
        });
      }
    }
    return { label: `seed=${seed} join@${joinAt}s ${facing}`, phaseBeforeJoin, joiners: [...first.values()] };
  } finally {
    room.destroy();
  }
}

/** Bo'rining to'da buyrug'i (testlar uchun — WolfBrain ning yopiq maydoni). */
function orderOf(w: ServerWolf): PackOrder | null {
  return (w.brain as unknown as { order: PackOrder | null }).order;
}

/** Asosiy gulxan yonida, o'choq kollayderidan tashqaridagi bo'sh nuqta (gulxan doirasi ichida). */
function spotAtFire(room: Room, fire: { x: number; y: number; z: number }): Vec3 {
  for (const r of [2, 2.5, 3]) {
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const pt = groundAt(room, fire.x + Math.cos(ang) * r, fire.z + Math.sin(ang) * r);
      if (!collidesAtWorld(room.world, pt.x, pt.y + 0.05, pt.z)) return pt;
    }
  }
  throw new Error("gulxan yonida bo'sh joy topilmadi");
}

describe("Bosqich 30 — to'da taktikasi jonli dinamikada: chalg'itish, orqadan aylanib kelish, haqiqiy gulxan halqasi", () => {
  it("1. Jonli to'da (seedlar, joylashuvlar, o'yinchi qarashi): qanotlar o'z tomonidan aylanib qanot maydoniga yetadi va orqa sektordan (> 90°) tishlaydi; haydovchi hujumgacha chalg'itadi", () => {
    const runs: LiveRun[] = [];
    const layouts: { dists: number[]; dir: 1 | -1; skip: number }[] = [
      { dists: [12, 15, 18], dir: 1, skip: 0 },
      { dists: [20, 24, 28], dir: 1, skip: 0 },
      { dists: [26, 30, 34], dir: 1, skip: 0 },
      { dists: [20, 24, 28], dir: -1, skip: 2 },
    ];
    const facings: Facing[] = ['pack', 'side', 'away', 'track'];
    let k = 0;
    for (const seed of [6501, 1, 42]) {
      for (const lay of layouts) {
        for (const facing of facings) {
          runs.push(runLivePack(seed, lay.dists, facing, lay.dir, lay.skip, k++ % 2 === 0));
        }
      }
    }
    const describeRun = (r: LiveRun) =>
      `${r.label}: ${r.flankers.map((f) => `${f.biteDeg.toFixed(0)}°${f.reached ? '*' : ''}${f.cutFront ? '!' : ''}`).join(' ') || 'qanot tishlamadi'}`;
    // (i) Ko'p yugurishda kamida bitta qanotning birinchi tishlashi orqa sektordan va qanot maydoniga yetgandan keyin
    const rearRuns = runs.filter((r) => r.flankers.some((f) => f.biteDeg > 90 && f.reached));
    assert.ok(
      rearRuns.length >= Math.ceil(runs.length * 0.8),
      `orqadan tishlash ${rearRuns.length}/${runs.length} yugurishda (≥ 80%)\n${runs.filter((r) => !rearRuns.includes(r)).map(describeRun).join('\n')}`,
    );
    const bites = runs.flatMap((r) => r.flankers);
    assert.ok(bites.length >= runs.length, `qanotlar tishladi (${bites.length} ta birinchi tishlash)`);
    const reachedBites = bites.filter((f) => f.reached).length;
    assert.ok(reachedBites >= Math.ceil(bites.length * 0.85), `qanotlar tishlashdan oldin qanot maydoniga yetdi: ${reachedBites}/${bites.length}`);
    const rearBites = bites.filter((f) => f.biteDeg > 90).length;
    assert.ok(rearBites >= Math.ceil(bites.length * 0.7), `qanotlarning birinchi tishlashlari orqa sektordan: ${rearBites}/${bites.length}`);
    // Qanot old tomondan (haydovchi yonidan) nishonga kesib o'tmaydi
    const cut = bites.filter((f) => f.cutFront).length;
    assert.ok(cut <= Math.floor(bites.length * 0.1), `old tomondan kesib o'tgan qanotlar: ${cut}/${bites.length}`);
    // Haydovchi chalg'itadi: nishon oldida turadi, hujumdan oldin tishlamaydi; hujum chegaralangan vaqtda boshlanadi
    for (const r of runs) {
      assert.ok(r.commitAt !== null, `${r.label}: to'da hujumga o'tdi`);
      assert.ok(r.commitAt! <= WOLF_PACK_COMMIT_MAX_SEC + 0.5, `${r.label}: hujum chegaralangan vaqtda (${r.commitAt!.toFixed(1)} s)`);
      if (r.driverBiteAt !== null) assert.ok(r.driverBiteAt >= r.commitAt!, `${r.label}: haydovchi hujumdan oldin tishlamadi`);
      if (Number.isFinite(r.feintMinDist)) {
        assert.ok(r.feintMinDist >= WOLF_DRIVER_LUNGE_M - 0.8, `${r.label}: chalg'itishda nishonga yopishmadi (${r.feintMinDist.toFixed(2)} m)`);
      }
      assert.equal(r.driverFlips, 0, `${r.label}: hujumgacha haydovchi almashmadi`);
    }
    // Uvlashsiz haydovchi qanotlardan oldin yetib keladi — ular orqaga aylanguncha nishon oldida chalg'itib turadi
    // (uvlashda qanotlar 3 s ichida joyiga yetib olishi mumkin, haydovchi kelishi bilan hujum boshlanadi)
    const quiet = runs.filter((r) => !r.howl);
    const feinted = quiet.filter((r) => r.feintHeldSec >= 1).length;
    assert.ok(feinted >= Math.ceil(quiet.length * 0.75), `haydovchi nishon oldida ≥ 1 s chalg'itdi: ${feinted}/${quiet.length}`);
  });

  it("2. To'lqin boshidagi uvlash: haydovchi 3 s uvlaydi, qanotlar bu orada undan yaqinlashadi — vazifa almashmaydi", () => {
    for (const seed of [6501, 1, 42]) {
      const { io, emitted } = createFakeIo();
      const room = makeNightRoom(io, { publicLayoutSeed: seed });
      try {
        const [p] = startNight(room, ['p1']);
        const a = findOpenArena(room, 20, 12, 1, 0);
        const pos0 = groundAt(room, a.x, a.z);
        p!.pos = { ...pos0 };
        const wolves = freshWolves(room, 3);
        [20, 24, 28].forEach((d, i) => placeWolf(wolves[i]!, groundAt(room, a.x + d, a.z + (i - 1) * 2), pos0));
        for (const w of wolves) room.pack.report(w, p!, room.now());
        room.advanceTimeForTest(1 / 30, 1 / 30);
        const driver = wolves.find((w) => w.role === 'driver');
        assert.ok(driver, `seed ${seed}: haydovchi tanlandi`);
        assert.equal(driver!.id, wolves[0]!.id, `seed ${seed}: eng yaqini haydovchi`);
        let howled = false;
        let flankerCloser = false;
        let flips = 0;
        for (let i = 0; i < 30 * 7; i++) {
          room.advanceTimeForTest(1 / 30, 1 / 30);
          p!.pos = { ...pos0 };
          p!.vel = { x: 0, y: 0, z: 0 };
          p!.hp = MAX_HP;
          p!.yaw = -Math.PI / 2;
          if (driver!.state === 'howl') howled = true;
          const dd = distXZ(driver!.pos, pos0);
          for (const w of wolves) {
            if (w !== driver && distXZ(w.pos, pos0) < dd - 2) flankerCloser = true;
          }
          if (driver!.role !== 'driver' || wolves.filter((w) => w.role === 'driver').length !== 1) flips++;
        }
        assert.ok(howled, `seed ${seed}: haydovchi uvladi`);
        assert.ok(
          emitted.some((e) => e.event === 'wolf:howl' && (e.payload as WolfHowlEvent).id === driver!.id),
          `seed ${seed}: uvlash hodisasi haydovchidan`,
        );
        assert.ok(flankerCloser, `seed ${seed}: uvlash paytida qanot haydovchidan > 2 m yaqinlashdi (almashish sharti yuzaga keldi)`);
        assert.equal(flips, 0, `seed ${seed}: haydovchi vazifasi almashmadi`);
      } finally {
        room.destroy();
      }
    }
  });

  it("3. Haqiqiy asosiy gulxan (bezak o'choq ustida, kulba/panjara/g'aramlar orasida): 4 bo'ri halqa bo'ylab yoyiladi — eng kichik burchak oralig'i ≥ 30°", () => {
    const results: string[] = [];
    for (const seed of [6501, 1, 42, 777]) {
      for (const layout of [0, 1, 2]) {
        const { io } = createFakeIo();
        const room = makeNightRoom(io, { publicLayoutSeed: seed });
        try {
          const [p] = startNight(room, ['p1']);
          const fire = [...room.campfires.values()].find((f) => f.main);
          assert.ok(fire && fire.lit, 'asosiy gulxan yonib turibdi');
          // Halqa bezaklar bilan qisman to'silgan (test haqiqiy, ko'chirilmagan gulxanni tekshiradi)
          let blocked = 0;
          for (let k = 0; k < 36; k++) {
            const ang = (k / 36) * Math.PI * 2;
            const pt = groundAt(room, fire!.x + Math.cos(ang) * CAMPFIRE_STANDOFF_M, fire!.z + Math.sin(ang) * CAMPFIRE_STANDOFF_M);
            if (collidesAtWorld(room.world, pt.x, pt.y + 0.05, pt.z, WOLF_RADIUS, 1.0)) blocked++;
          }
          assert.ok(blocked >= 3, `seed ${seed}: halqaning ${blocked}/36 nuqtasi bezak bilan to'silgan`);
          const pos0 = spotAtFire(room, fire!);
          p!.pos = { ...pos0 };
          const wolves = freshWolves(room, 4);
          // Bo'rilar gulxandan 18–30 m dagi nav tugunlarida, burchak bo'yicha ketma-ket (bir tomondan) keladi
          const nav = room.nav;
          const cands = nav.roamList
            .map((i) => nav.center(i))
            .filter((c) => {
              const d = distXZ(c, fire!);
              return d > 18 && d < 30;
            })
            .sort((x, y) => angleFrom(fire!, x) - angleFrom(fire!, y));
          wolves.forEach((w, i) => placeWolf(w, cands[(i * 3 + layout * 5) % cands.length]!, pos0));
          for (const w of wolves) room.pack.report(w, p!, room.now());
          let minFireDist = Infinity;
          for (let i = 0; i < 30 * 15; i++) {
            room.advanceTimeForTest(1 / 30, 1 / 30);
            p!.pos = { ...pos0 };
            p!.vel = { x: 0, y: 0, z: 0 };
            p!.hp = MAX_HP;
            for (const w of wolves) minFireDist = Math.min(minFireDist, distXZ(w.pos, fire!));
          }
          const angs = wolves.map((w) => angleFrom(fire!, w.pos));
          let minSep = Infinity;
          for (let i = 0; i < angs.length; i++) {
            for (let j = i + 1; j < angs.length; j++) minSep = Math.min(minSep, angularSeparation(angs[i]!, angs[j]!));
          }
          results.push(`seed ${seed}/${layout}: ${toDeg(minSep).toFixed(0)}°`);
          assert.ok(toDeg(minSep) >= 30, `seed ${seed}/${layout}: eng kichik burchak oralig'i ${toDeg(minSep).toFixed(0)}° (≥ 30°)`);
          assert.ok(minFireDist >= CAMPFIRE_RADIUS_M - 0.3, `seed ${seed}/${layout}: bo'rilar olovga kirmadi (${minFireDist.toFixed(1)} m)`);
          for (const w of wolves) {
            const d = distXZ(w.pos, fire!);
            assert.ok(d >= CAMPFIRE_RADIUS_M && d <= CAMPFIRE_STANDOFF_M + 4.5, `seed ${seed}/${layout}: ${w.id} halqa yaqinida (${d.toFixed(1)} m)`);
            assert.equal(w.targetId, 'p1');
            assert.ok(w.state === 'alert' || w.state === 'howl', `seed ${seed}/${layout}: ${w.id} chetida kutadi (${w.state})`);
            assert.equal(w.brain.fearFlinchCount, 0, `seed ${seed}/${layout}: ${w.id} olovdan seskanmadi`);
          }
        } finally {
          room.destroy();
        }
      }
    }
    assert.equal(results.length, 12, results.join(', '));
  });

  it("4. Mash'al ko'targan o'yinchi gulxan yonidagidek himoyalangan: to'da yaqinroqdagi mash'alchini emas, mash'alsiz yolg'izni tanlaydi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p1, p2] = startNight(room, ['p1', 'p2']);
      // p1 bo'riga yaqin (8 m), mash'al bilan; p2 uzoqroq (32 m), mash'alsiz; ikkalasi har qanday gulxandan ≥ 40 m
      // (ball "gulxandan uzoq" chegarasida — farq faqat mash'al va bo'rigacha masofadan)
      let a: Vec3 | null = null;
      for (let skip = 0; skip < 40 && !a; skip++) {
        const c = findOpenArena(room, 20, 4, 1, skip);
        const far = (x: number, z: number) => {
          const f = room.nearestLitFire(x, z);
          return !f || distXZ(f, { x, z }) >= 40;
        };
        if (far(c.x, c.z) && far(c.x + 40, c.z)) a = c;
      }
      assert.ok(a, "gulxanlardan uzoq maydon topildi");
      const pos1 = groundAt(room, a!.x, a!.z);
      const pos2 = groundAt(room, a!.x + 40, a!.z);
      p1!.pos = { ...pos1 };
      p2!.pos = { ...pos2 };
      const [w] = freshWolves(room, 1);
      placeWolf(w!, groundAt(room, a!.x + 8, a!.z), pos1);
      const t = room.now();
      room.pack.report(w!, p1!, t);
      room.pack.report(w!, p2!, t);
      p1!.torchUntil = room.now() + 60;
      for (let i = 0; i < 9; i++) {
        room.advanceTimeForTest(1 / 30, 1 / 30);
        p1!.pos = { ...pos1 };
        p2!.pos = { ...pos2 };
        p1!.hp = MAX_HP;
        p2!.hp = MAX_HP;
      }
      assert.equal(room.hasTorch(p1!), true, "p1 da mash'al bor");
      assert.equal(w!.targetId, 'p2', `mash'alsiz o'yinchi nishon (${w!.targetId})`);
      // Mash'al so'ngach yaqindagi o'yinchi yana afzal (ball faqat mash'al sababli o'zgargan)
      p1!.torchUntil = 0;
      for (let i = 0; i < 9; i++) {
        room.advanceTimeForTest(1 / 30, 1 / 30);
        p1!.pos = { ...pos1 };
        p2!.pos = { ...pos2 };
        w!.pos = groundAt(room, a!.x + 8, a!.z);
        room.pack.report(w!, p1!, room.now());
        room.pack.report(w!, p2!, room.now());
      }
      assert.equal(w!.targetId, 'p1', `mash'alsiz yaqin o'yinchi yana nishon (${w!.targetId})`);
    } finally {
      room.destroy();
    }
  });

  it("5. O'yinchi yaqinlashayotgan eng yaqin bo'rini 18–30 m dan otib turadi: faqat zarba yegani qasos oladi, to'da birdaniga hujumga o'tmaydi — qanotlar baribir orqadan tishlaydi", () => {
    const runs: LiveRun[] = [];
    const layouts: { dists: number[]; dir: 1 | -1; skip: number }[] = [
      { dists: [20, 24, 28], dir: 1, skip: 0 },
      { dists: [26, 30, 34], dir: 1, skip: 0 },
      { dists: [20, 24, 28], dir: -1, skip: 2 },
    ];
    let k = 0;
    for (const seed of [6501, 1, 42]) {
      for (const lay of layouts) {
        for (const range of [18, 30]) {
          runs.push(runLivePack(seed, lay.dists, 'track', lay.dir, lay.skip, k++ % 2 === 0, range));
        }
      }
    }
    const describeRun = (r: LiveRun) =>
      `${r.label}: ${r.flankers.map((f) => `${f.biteDeg.toFixed(0)}°${f.reached ? '*' : ''}${f.cutFront ? '!' : ''}`).join(' ') || 'qanot tishlamadi'}`;
    for (const r of runs) {
      assert.ok(r.shotPhase !== undefined, `${r.label}: o'yinchi bo'rini otdi`);
      // Zarba to'dani hujumga o'tkazmaydi: haydovchi hali uzoqda, qanotlar aylanmagan — to'da chalg'itishda qoladi
      assert.equal(r.shotPhase, 'feint', `${r.label}: birinchi zarbadan keyin to'da hali chalg'itmoqda (${r.shotPhase})`);
      assert.ok(r.commitAt !== null && r.commitAt <= WOLF_PACK_COMMIT_MAX_SEC + 0.5, `${r.label}: hujum chegaralangan vaqtda`);
    }
    const rearRuns = runs.filter((r) => r.flankers.some((f) => f.biteDeg > 90 && f.reached));
    assert.ok(
      rearRuns.length >= Math.ceil(runs.length * 0.8),
      `o'q ostida orqadan tishlash ${rearRuns.length}/${runs.length} yugurishda (≥ 80%)\n${runs.filter((r) => !rearRuns.includes(r)).map(describeRun).join('\n')}`,
    );
    const bites = runs.flatMap((r) => r.flankers);
    assert.ok(bites.length >= runs.length, `qanotlar tishladi (${bites.length} ta birinchi tishlash)`);
    const rearBites = bites.filter((f) => f.biteDeg > 90).length;
    assert.ok(rearBites >= Math.ceil(bites.length * 0.7), `o'q ostida qanotlarning birinchi tishlashlari orqa sektordan: ${rearBites}/${bites.length}\n${runs.map(describeRun).join('\n')}`);
    const reachedBites = bites.filter((f) => f.reached).length;
    assert.ok(reachedBites >= Math.ceil(bites.length * 0.85), `o'q ostida qanotlar tishlashdan oldin qanot maydoniga yetdi: ${reachedBites}/${bites.length}`);
    const cut = bites.filter((f) => f.cutFront).length;
    assert.ok(cut <= Math.floor(bites.length * 0.1), `o'q ostida old tomondan kesib o'tgan qanotlar: ${cut}/${bites.length}`);
  });

  it("6. Yakka bo'ri o'yinchini birinchi topib hujum qiladi, sheriklari 3–6 s keyin o'sha tomondan qo'shiladi: ular ham old tomondan emas, orqadan aylanib kelib tishlaydi", () => {
    const runs: LateJoinRun[] = [];
    for (const seed of [6501, 1, 42, 777]) {
      for (const joinAt of [3, 6]) {
        runs.push(runLateJoin(seed, joinAt, joinAt === 3 ? 'pack' : 'side'));
      }
    }
    const describeRun = (r: LateJoinRun) =>
      `${r.label}: ${r.joiners.map((f) => `${f.biteDeg.toFixed(0)}°${f.reached ? '*' : ''}${f.cutFront ? '!' : ''}`).join(' ') || 'tishlamadi'}`;
    for (const r of runs) {
      // Holat aynan shu: yakka bo'ri hujumga allaqachon o'tgan (chalg'itish yo'q), sheriklar keyin keladi
      assert.equal(r.phaseBeforeJoin, 'commit', `${r.label}: yakka bo'ri qo'shilishdan oldin hujumda`);
    }
    const bites = runs.flatMap((r) => r.joiners);
    assert.ok(bites.length >= runs.length, `qo'shilganlar tishladi (${bites.length} ta birinchi tishlash)\n${runs.map(describeRun).join('\n')}`);
    const rear = bites.filter((f) => f.biteDeg > 90 && f.reached).length;
    assert.ok(rear >= Math.ceil(bites.length * 0.8), `qo'shilganlarning birinchi tishlashlari orqa sektordan: ${rear}/${bites.length}\n${runs.map(describeRun).join('\n')}`);
    const cut = bites.filter((f) => f.cutFront).length;
    assert.ok(cut <= Math.floor(bites.length * 0.1), `old tomondan kesib o'tgan qo'shilganlar: ${cut}/${bites.length}\n${runs.map(describeRun).join('\n')}`);
  });

  it("7. Nishonning olov manbai almashadi (raketa doirasidan mash'al bilan chiqdi / mash'alchi yonida raketa yondi): halqa radiusi joriy manbaniki, bo'rilar mash'alchi yonida turadi", () => {
    // Har tickda: halqa o'rni berilgan bo'rining radiusi nishonning joriy manbai (raketa/mash'al) bilan bir xil
    const checkRing = (room: Room, p: ServerPlayer, wolves: ServerWolf[], label: string) => {
      const src = room.preyFearSource(p);
      if (!src || src.kind === 'fire') return;
      for (const w of wolves) {
        const o = orderOf(w);
        if (o?.targetId !== p.id || o.standoffR === undefined) continue;
        assert.equal(o.standoffR, src.standoff, `${label}: ${w.id} halqa radiusi ${o.standoffR} m, manba (${src.kind}) ${src.standoff} m`);
      }
    };
    // a) Raketa yonib turibdi (28 m orqada), mash'alchi undan 2 m/s bilan uzoqlashadi — raketa chetida (≤ 31.6 m)
    // to'da raketa halqasini quradi, keyin nishon o'z mash'ali himoyasiga o'tadi
    for (const seed of [6501, 1, 42]) {
      const { io } = createFakeIo();
      const room = makeNightRoom(io, { publicLayoutSeed: seed });
      try {
        const [p] = startNight(room, ['p1']);
        const a = findOpenArena(room, 20, 12, 1, 0);
        const flarePos = groundAt(room, a.x - 28, a.z);
        room.flares.set('fl1', { id: 'fl1', x: flarePos.x, y: flarePos.y, z: flarePos.z, until: room.now() + 60, byId: 'p1' });
        let px = a.x;
        p!.pos = groundAt(room, px, a.z);
        p!.torchUntil = room.now() + 120;
        const wolves = freshWolves(room, 3, false);
        wolves.forEach((w, i) => placeWolf(w, groundAt(room, a.x + 14 + i * 2, a.z + (i - 1) * 4), p!.pos));
        let flareRing = false;
        for (let i = 0; i < 30 * 16; i++) {
          if (px < a.x + 8) px += 2 / 30;
          room.advanceTimeForTest(1 / 30, 1 / 30);
          p!.pos = groundAt(room, px, a.z);
          p!.vel = { x: 0, y: 0, z: 0 };
          p!.hp = MAX_HP;
          for (const w of wolves) room.pack.report(w, p!, room.now());
          if (room.preyFearSource(p!)?.kind === 'flare' && wolves.some((w) => orderOf(w)?.standoffR === FLARE_STANDOFF_M)) flareRing = true;
          checkRing(room, p!, wolves, `seed ${seed} t=${i}`);
        }
        assert.ok(flareRing, `seed ${seed}: raketa chetida to'da raketa halqasini qurdi`);
        assert.equal(room.preyFearSource(p!)?.kind, 'torch', `seed ${seed}: nishon endi o'z mash'ali himoyasida`);
        for (const w of wolves) {
          const d = distXZ(w.pos, p!.pos);
          assert.ok(d <= TORCH_STANDOFF_M + 1.5, `seed ${seed}: ${w.id} mash'alchi yonida (${d.toFixed(1)} m)`);
        }
      } finally {
        room.destroy();
      }
    }
    // b) Bo'rilar mash'alchi atrofida turibdi, 30.8 m narida raketa yonadi — nishon raketa chetida, halqa raketaniki
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p] = startNight(room, ['p1']);
      const a = findOpenArena(room, 20, 12, 1, 0);
      const pos0 = groundAt(room, a.x, a.z);
      p!.pos = { ...pos0 };
      p!.torchUntil = room.now() + 120;
      const wolves = freshWolves(room, 3, false);
      wolves.forEach((w, i) => placeWolf(w, groundAt(room, a.x + 12 + i, a.z + (i - 1) * 3), pos0));
      const tick = (n: number, label: string) => {
        for (let i = 0; i < n; i++) {
          room.advanceTimeForTest(1 / 30, 1 / 30);
          p!.pos = { ...pos0 };
          p!.vel = { x: 0, y: 0, z: 0 };
          p!.hp = MAX_HP;
          for (const w of wolves) room.pack.report(w, p!, room.now());
          checkRing(room, p!, wolves, `${label} t=${i}`);
        }
      };
      tick(30 * 4, "mash'al");
      assert.equal(room.preyFearSource(p!)?.kind, 'torch');
      assert.ok(wolves.every((w) => orderOf(w)?.standoffR === TORCH_STANDOFF_M), "mash'al halqasi");
      const flarePos = groundAt(room, a.x - 30.8, a.z);
      room.flares.set('fl1', { id: 'fl1', x: flarePos.x, y: flarePos.y, z: flarePos.z, until: room.now() + 60, byId: 'p1' });
      tick(30 * 8, 'raketa');
      assert.equal(room.preyFearSource(p!)?.kind, 'flare');
      assert.ok(wolves.every((w) => orderOf(w)?.standoffR === FLARE_STANDOFF_M), 'raketa halqasi');
      for (const w of wolves) {
        assert.ok(distXZ(w.pos, flarePos) >= FLARE_FEAR_RADIUS_M - 0.3, `${w.id} raketa doirasidan tashqarida (${distXZ(w.pos, flarePos).toFixed(1)} m)`);
      }
    } finally {
      room.destroy();
    }
  });
});
