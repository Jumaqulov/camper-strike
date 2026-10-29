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
} from '../../server/wolfPack';
import { MAX_HP } from '../constants';
import type { Vec3 } from '../math';
import { collidesAtWorld } from '../physics';
import type { CreateRoomOpts } from '../protocol';
import { sampleTerrainHeight } from '../world';
import { CAMPFIRE_RADIUS_M, CAMPFIRE_STANDOFF_M, WOLF_RADIUS, type WolfBiteEvent, type WolfHowlEvent } from '../wolf';

// Bosqich 30 — Tong otguncha: to'da taktikasi jonli dinamikada. Haydovchi nishon oldida chalg'itadi (irillab turadi,
// aldab otiladi), qanotlar kengroq doira bo'ylab o'z tomonidan aylanib orqa sektorga yetadi va orqadan tashlanadi;
// to'lqin boshidagi uvlashda vazifa almashmaydi; haqiqiy asosiy gulxan atrofida (kulba, panjara, o'tin g'aramlari
// orasida) to'da halqa bo'ylab yoyiladi; mash'al ko'targan o'yinchi gulxan yonidagidek himoyalangan deb baholanadi.
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
}

/**
 * Jonli to'da: 3 bo'ri ochiq maydonda bir tomondan (`dists` m) keladi, o'yinchi joyida (joni to'ldiriladi),
 * `facing` bo'yicha qaraydi ('track' — eng yaqin bo'riga burilib turadi). 12 s davomida hech bir bo'ri ushlab
 * turilmaydi; har bo'rining birinchi tishlashi, qanot maydoniga yetgani va hujum bosqichi yoziladi.
 */
function runLivePack(seed: number, dists: number[], facing: Facing, dir: 1 | -1, skip: number, howl: boolean): LiveRun {
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
    const step = 1 / 30;
    for (let i = 0; i < 30 * 12; i++) {
      room.advanceTimeForTest(step, step);
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
    };
  } finally {
    room.destroy();
  }
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
});
