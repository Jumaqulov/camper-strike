import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { botMoveSpeed } from '../../server/bot';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import { MAX_HP, RUN_SPEED, WALK_SPEED } from '../constants';
import type { Vec3 } from '../math';
import { computeWishVelocity } from '../netMovement';
import type { CreateRoomOpts } from '../protocol';
import { WEAPONS, emptyAmmo, type WeaponId } from '../weapons';
import { sampleTerrainHeight } from '../world';
import {
  CAMPFIRE_MAX_FUEL_SEC,
  CAMPFIRE_RADIUS_M,
  WOLF_COAT_CHARCOAL,
  WOOD_CARRY_MAX,
  woodBlocksSprint,
  woodSpeedMul,
} from '../wolf';

// Bosqich 29 — Tong otguncha: o'tin og'irligi botlarga ham (qo'li to'la bot sprint qilolmaydi).
// Xona haqiqiy Room, io/socket soxta; vaqt room.advanceTimeForTest bilan deterministik suriladi.

const DT = 1 / 30;
const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

function createFakeIo(): Server {
  const io = {
    to() {
      const emitFn = () => {};
      return { emit: emitFn, volatile: { emit: emitFn } };
    },
  } as unknown as Server;
  return io;
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
      bots: 1,
      maxPlayers: 8,
      timeLimit: 4,
      scoreLimit: 1,
      publicLayoutSeed: 6501,
      countdownSec: 2,
      ...overrides,
    },
    io,
    () => {},
  );
}

/** Yakka odam va bitta bot bilan tun raundini boshlaydi (sanoq 2 s). */
function startNightWithBot(room: Room): { p: ServerPlayer; bot: ServerPlayer } {
  room.addHuman(createFakeSocket('p1'), 'Ovchi');
  room.onReady('p1', { world: room.worldMeta() });
  assert.equal(room.phase, 'countdown');
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  const p = room.players.get('p1')!;
  p.spawnTime = -99;
  const bot = [...room.players.values()].find((x) => x.isBot);
  assert.ok(bot && bot.alive && bot.brain, 'xonada tirik bot bor');
  bot!.spawnTime = -99;
  return { p, bot: bot! };
}

function groundAt(room: Room, x: number, z: number): Vec3 {
  return { x, y: sampleTerrainHeight(room.world.terrain, x, z), z };
}

function mainFire(room: Room) {
  const f = [...room.campfires.values()].find((c) => c.main);
  assert.ok(f, 'asosiy gulxan bor');
  return f!;
}

/** Odamni asosiy gulxandan eng uzoq gulxan yoniga chetga qo'yadi (bot yo'liga va bo'riga aralashmasin). */
function parkHuman(room: Room, p: ServerPlayer): void {
  const main = mainFire(room);
  let far = main;
  for (const f of room.campfires.values()) {
    if (Math.hypot(f.x - main.x, f.z - main.z) > Math.hypot(far.x - main.x, far.z - main.z)) far = f;
  }
  p.pos = groundAt(room, far.x + 2, far.z);
  p.vel = { x: 0, y: 0, z: 0 };
  p.hp = MAX_HP;
}

/** Gulxandan `len` m gacha to'siqsiz yo'nalish (16 ta burchak sinab chiqiladi). */
function openDirFromFire(room: Room, fire: { x: number; y: number; z: number }, len: number): { dx: number; dz: number } {
  const nav = room.nav;
  // Kesma gulxan tosh halqasi (campfire_pit_01 kollayderi) tashqarisidan boshlanadi
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
    if (room.nav.nearest(b) < 0) continue;
    if (nav.segmentClear(a, b)) return { dx, dz };
  }
  throw new Error("gulxandan ochiq yo'nalish topilmadi");
}

/** Bitta bo'rini qoldiradi (oddiy kulrang — yashirinish mantig'i aralashmasin), qolganlarini o'chiradi. */
function keepOneWolf(room: Room): ServerWolf {
  const w = [...room.wolves.values()][0];
  assert.ok(w, "xonada bo'ri bor");
  for (const id of [...room.wolves.keys()]) if (id !== w!.id) room.wolves.delete(id);
  w!.coat = WOLF_COAT_CHARCOAL;
  return w!;
}

/** Bo'rini joyiga mixlaydi: botni ovlab turibdi, lekin tishlash masofasiga yetmaydi (turtki tezlikni buzmasin). */
function pinWolf(room: Room, w: ServerWolf, bot: ServerPlayer, pos: Vec3): void {
  for (const id of [...room.wolves.keys()]) if (id !== w.id) room.wolves.delete(id);
  w.pos = { ...pos };
  w.vel = { x: 0, y: 0, z: 0 };
  w.hp = 999;
  w.alive = true;
  w.state = 'hunt';
  w.targetId = bot.id;
}

interface TickRec {
  /** Tick oxiridagi gorizontal tezlik (m/s). */
  v: number;
  /** Tick davomidagi gorizontal siljish / DT (m/s). */
  step: number;
  /** Botning joriy maqsad kaliti (wolf:flee / wolf:shelter / camp:...). */
  goal: string;
  /** Tick boshidagi qo'ldagi o'tin (tezlik shu bilan hisoblanadi). */
  wood: number;
}

/** `ticks` ta server tick (1/30 s) yuritadi; har tickdan keyin `each` (bo'rini mixlash, jonni to'ldirish). */
function runTicks(room: Room, bot: ServerPlayer, ticks: number, each: () => void): TickRec[] {
  const out: TickRec[] = [];
  const brain = bot.brain as unknown as { lastGoalKey: string };
  for (let i = 0; i < ticks && room.phase === 'playing'; i++) {
    const prev = { x: bot.pos.x, z: bot.pos.z };
    const wood = bot.wood;
    room.advanceTimeForTest(DT, DT);
    out.push({
      v: Math.hypot(bot.vel.x, bot.vel.z),
      step: Math.hypot(bot.pos.x - prev.x, bot.pos.z - prev.z) / DT,
      goal: brain.lastGoalKey,
      wood,
    });
    each();
  }
  return out;
}

function peak(recs: TickRec[], key: 'v' | 'step' = 'v'): number {
  return recs.reduce((m, r) => Math.max(m, r[key]), 0);
}

/** Har tickda tezlik ham, siljish ham chegaradan oshmaydi (siljishda to'qnashuv/qiyalik uchun kichik zaxira). */
function assertCapped(recs: TickRec[], cap: number, label: string): void {
  for (const [i, r] of recs.entries()) {
    assert.ok(r.v <= cap + 1e-6, `${label}: tick ${i} tezlik ${r.v.toFixed(3)} > ${cap.toFixed(3)} m/s`);
    assert.ok(r.step <= cap + 0.05, `${label}: tick ${i} siljish ${r.step.toFixed(3)} > ${cap.toFixed(3)} m/s`);
  }
}

describe("Bosqich 29 — botlarda o'tin og'irligi", () => {
  it("1. botMoveSpeed: odam bilan bir xil qoida — to'la qo'lda asos WALK_SPEED, woodSpeedMul har doim; o'tinsiz avvalgidek", () => {
    for (const weapon of WEAPON_IDS) {
      const mul = WEAPONS[weapon].speedMul;
      // O'tinsiz — avvalgi bot tezliklari (yugurish RUN_SPEED × qurol, sayr WALK_SPEED) o'zgarmagan
      assert.equal(botMoveSpeed(mul, 0), RUN_SPEED * mul, `${weapon}: o'tinsiz yugurish`);
      assert.equal(botMoveSpeed(mul, undefined), RUN_SPEED * mul, `${weapon}: o'tin maydoni yo'q`);
      assert.equal(botMoveSpeed(mul, 0, true), WALK_SPEED, `${weapon}: o'tinsiz sayr`);
      for (let wood = 0; wood <= WOOD_CARRY_MAX; wood++) {
        // Odamning oldinga sprint (Shift) tezligi bilan aynan bir xil (computeWishVelocity)
        const human = computeWishVelocity({ moveForward: 1, moveRight: 0, walk: true, scoped: false, weapon, yaw: 0 }, false, wood);
        assert.ok(Math.abs(botMoveSpeed(mul, wood) - human.maxSpeed) < 1e-9, `${weapon}, ${wood} o'tin: bot = odam`);
        assert.ok(botMoveSpeed(mul, wood, true) <= botMoveSpeed(mul, wood) + 1e-9, `${weapon}, ${wood} o'tin: sayr yugurishdan tez emas`);
      }
      // 1-2 ta o'tin — hali yuguradi (faqat yengil ko'paytuvchi); 3 ta — sprint yo'q
      for (const wood of [1, 2]) {
        assert.equal(woodBlocksSprint(wood), false);
        assert.ok(Math.abs(botMoveSpeed(mul, wood) - RUN_SPEED * mul * woodSpeedMul(wood)) < 1e-9);
        assert.ok(botMoveSpeed(mul, wood) > WALK_SPEED * mul, `${weapon}, ${wood} o'tin: yugurish saqlangan`);
      }
      const full = WALK_SPEED * mul * woodSpeedMul(WOOD_CARRY_MAX);
      assert.ok(Math.abs(botMoveSpeed(mul, WOOD_CARRY_MAX) - full) < 1e-9, `${weapon}: to'la qo'l — yurish`);
      assert.ok(botMoveSpeed(mul, WOOD_CARRY_MAX, true) <= full + 1e-9, `${weapon}: to'la qo'lda sayr ham chegarada`);
    }
  });

  it("2. Lager yo'li: 3 ta o'tinli bot o'chayotgan gulxanga sprintsiz yuradi, 2 ta o'tinli bot yugurib boradi", () => {
    const run = (wood: number) => {
      const room = makeNightRoom(createFakeIo());
      try {
        const { p, bot } = startNightWithBot(room);
        room.wolves.clear();
        parkHuman(room, p);
        const fire = mainFire(room);
        fire.fuelSec = 20;
        const dir = openDirFromFire(room, fire, 16);
        bot.pos = groundAt(room, fire.x + dir.dx * 15, fire.z + dir.dz * 15);
        bot.vel = { x: 0, y: 0, z: 0 };
        bot.weapon = 'pistol';
        bot.ammo = emptyAmmo();
        bot.ammo.pistol = { mag: 12, reserve: 36 };
        bot.wood = wood;
        const d0 = Math.hypot(bot.pos.x - fire.x, bot.pos.z - fire.z);
        const recs = runTicks(room, bot, 75, () => {
          room.wolves.clear();
          bot.hp = MAX_HP;
          fire.fuelSec = Math.min(fire.fuelSec, 20);
        });
        const d1 = Math.hypot(bot.pos.x - fire.x, bot.pos.z - fire.z);
        return { recs, moved: d0 - d1, weapon: bot.weapon, woodLeft: bot.wood };
      } finally {
        room.destroy();
      }
    };

    const mul = WEAPONS.pistol.speedMul;
    const heavy = run(WOOD_CARRY_MAX);
    assert.equal(heavy.weapon, 'pistol');
    assert.ok(heavy.recs.some((r) => r.goal.startsWith('camp:feed:')), 'bot gulxanga o‘tin tashlash vazifasini oldi');
    assert.ok(heavy.moved > 3, `bot gulxan tomon yurdi (${heavy.moved.toFixed(1)} m)`);
    // Gulxanga yetib o'tin tashlagach (qo'l bo'shadi) tezlik endi cheklanmaydi — faqat to'la qo'lli ticklar
    const heavyRecs = heavy.recs.filter((r) => r.wood === WOOD_CARRY_MAX);
    assert.ok(heavyRecs.length >= 45, `to'la qo'l bilan yetarli yo'l (${heavyRecs.length} tick)`);
    const cap = WALK_SPEED * mul * woodSpeedMul(WOOD_CARRY_MAX);
    assertCapped(heavyRecs, cap, "3 ta o'tin");
    assert.ok(peak(heavyRecs) > cap * 0.9, `yurish tezligida harakatlandi (${peak(heavyRecs).toFixed(2)} m/s)`);

    const light = run(2);
    assert.equal(light.weapon, 'pistol');
    const lightRecs = light.recs.filter((r) => r.wood === 2);
    assert.ok(lightRecs.length >= 30, `2 ta o'tin bilan yetarli yo'l (${lightRecs.length} tick)`);
    const lightCap = RUN_SPEED * mul * woodSpeedMul(2);
    assertCapped(lightRecs, lightCap, "2 ta o'tin");
    assert.ok(peak(lightRecs) > cap + 1, `2 ta o'tin bilan yuguradi (${peak(lightRecs).toFixed(2)} m/s)`);
  });

  it("3. Bo'ridan qochish va gulxanda panalanish: to'la qo'lli bot WALK chegarasidan oshmaydi, o'tinsiz bot avvalgidek yuguradi", () => {
    // a) Bot doiradan tashqarida (14 m): bo'ri yon tomonda — bot gulxanga qochadi (wolf:flee), doirada panalanadi
    const flee = (wood: number) => {
      const room = makeNightRoom(createFakeIo());
      try {
        const { p, bot } = startNightWithBot(room);
        parkHuman(room, p);
        const w = keepOneWolf(room);
        const fire = mainFire(room);
        fire.fuelSec = CAMPFIRE_MAX_FUEL_SEC;
        const dir = openDirFromFire(room, fire, 16);
        bot.pos = groundAt(room, fire.x + dir.dx * 14, fire.z + dir.dz * 14);
        bot.vel = { x: 0, y: 0, z: 0 };
        bot.weapon = null;
        bot.ammo = emptyAmmo();
        bot.wood = wood;
        assert.equal(room.litFireContaining(bot.pos.x, bot.pos.z, 0), null, 'bot doiradan tashqarida');
        const wolfPos = groundAt(room, bot.pos.x - dir.dz * 6, bot.pos.z + dir.dx * 6);
        pinWolf(room, w, bot, wolfPos);
        const recs = runTicks(room, bot, 60, () => {
          pinWolf(room, w, bot, wolfPos);
          bot.hp = MAX_HP;
          bot.wood = wood;
          fire.fuelSec = CAMPFIRE_MAX_FUEL_SEC;
        });
        return recs;
      } finally {
        room.destroy();
      }
    };
    const fullCap = WALK_SPEED * woodSpeedMul(WOOD_CARRY_MAX); // qurolsiz qochish: ko'paytuvchi 1
    const heavy = flee(WOOD_CARRY_MAX);
    const heavyFlee = heavy.filter((r) => r.goal === 'wolf:flee');
    assert.ok(heavyFlee.length >= 10, `bot bo'ridan qochdi (${heavyFlee.length} tick)`);
    assertCapped(heavy, fullCap, "qochish, 3 ta o'tin");
    assert.ok(peak(heavyFlee) > fullCap * 0.9, `yurib qochdi (${peak(heavyFlee).toFixed(2)} m/s)`);
    const empty = flee(0);
    const emptyFlee = empty.filter((r) => r.goal === 'wolf:flee');
    assert.ok(emptyFlee.length >= 5, `o'tinsiz bot ham qochdi (${emptyFlee.length} tick)`);
    assertCapped(empty, RUN_SPEED, "qochish, o'tinsiz");
    assert.ok(peak(emptyFlee) > RUN_SPEED * 0.95, `o'tinsiz bot sprint bilan qochadi (${peak(emptyFlee).toFixed(2)} m/s)`);

    // b) Bot doira ichida (4 m), bo'ri o'sha tomonda tashqarida — gulxanning narigi tomoniga o'tadi (wolf:shelter)
    const shelter = (wood: number) => {
      const room = makeNightRoom(createFakeIo());
      try {
        const { p, bot } = startNightWithBot(room);
        parkHuman(room, p);
        const w = keepOneWolf(room);
        const fire = mainFire(room);
        // To'la gulxan o'tinni qabul qilmaydi (FIRE_FULL) — og'irlik qo'lda qoladi
        fire.fuelSec = CAMPFIRE_MAX_FUEL_SEC;
        const dir = openDirFromFire(room, fire, 12);
        bot.pos = groundAt(room, fire.x + dir.dx * 4, fire.z + dir.dz * 4);
        bot.vel = { x: 0, y: 0, z: 0 };
        bot.weapon = null;
        bot.ammo = emptyAmmo();
        bot.wood = wood;
        const wolfPos = groundAt(room, fire.x + dir.dx * 11, fire.z + dir.dz * 11);
        pinWolf(room, w, bot, wolfPos);
        const recs = runTicks(room, bot, 30, () => {
          pinWolf(room, w, bot, wolfPos);
          bot.hp = MAX_HP;
          fire.fuelSec = CAMPFIRE_MAX_FUEL_SEC;
        });
        return { recs, woodLeft: bot.wood };
      } finally {
        room.destroy();
      }
    };
    const sh = shelter(WOOD_CARRY_MAX);
    assert.equal(sh.woodLeft, WOOD_CARRY_MAX, "to'la gulxanga o'tin tashlanmadi");
    assert.ok(sh.recs.filter((r) => r.goal === 'wolf:shelter').length >= 10, 'bot gulxan doirasida panalandi');
    assertCapped(sh.recs, fullCap * 0.7, "panalanish, 3 ta o'tin");
    const shEmpty = shelter(0);
    assert.ok(peak(shEmpty.recs) > fullCap * 0.7 + 0.5, `o'tinsiz bot tezroq panalanadi (${peak(shEmpty.recs).toFixed(2)} m/s)`);
    assertCapped(shEmpty.recs, RUN_SPEED * 0.7, "panalanish, o'tinsiz");
  });

  it("4. Bo'ri bilan jang: yaqin bo'ridan otib orqaga tisarilganda ham to'la qo'lli bot sprint qilmaydi", () => {
    const kite = (wood: number) => {
      const room = makeNightRoom(createFakeIo());
      try {
        const { p, bot } = startNightWithBot(room);
        parkHuman(room, p);
        const w = keepOneWolf(room);
        const fire = mainFire(room);
        const dir = openDirFromFire(room, fire, 22);
        bot.pos = groundAt(room, fire.x + dir.dx * 12, fire.z + dir.dz * 12);
        bot.vel = { x: 0, y: 0, z: 0 };
        bot.weapon = 'pistol';
        bot.ammo = emptyAmmo();
        bot.ammo.pistol = { mag: 12, reserve: 120 };
        bot.reloadWeapon = null;
        bot.wood = wood;
        // Bo'ri botdan 4 m gulxan tomonda (doiradan tashqarida) — bot uni ko'radi va gulxandan nari tisariladi
        const wolfAt = () => groundAt(room, bot.pos.x - dir.dx * 4, bot.pos.z - dir.dz * 4);
        pinWolf(room, w, bot, wolfAt());
        const start = { x: bot.pos.x, z: bot.pos.z };
        const recs = runTicks(room, bot, 30, () => {
          pinWolf(room, w, bot, wolfAt());
          bot.hp = MAX_HP;
          bot.wood = wood;
        });
        const backed = (bot.pos.x - start.x) * dir.dx + (bot.pos.z - start.z) * dir.dz;
        return { recs, backed, weapon: bot.weapon };
      } finally {
        room.destroy();
      }
    };
    const mul = WEAPONS.pistol.speedMul;
    const heavy = kite(WOOD_CARRY_MAX);
    assert.equal(heavy.weapon, 'pistol');
    assert.ok(heavy.backed > 1, `bot bo'ridan tisarildi (${heavy.backed.toFixed(2)} m)`);
    const cap = WALK_SPEED * mul * woodSpeedMul(WOOD_CARRY_MAX) * 0.7;
    assertCapped(heavy.recs, cap, "tisarilish, 3 ta o'tin");
    assert.ok(peak(heavy.recs) > cap * 0.9, `tisarilish tezligi (${peak(heavy.recs).toFixed(2)} m/s)`);
    const empty = kite(0);
    assertCapped(empty.recs, RUN_SPEED * mul * 0.7, "tisarilish, o'tinsiz");
    assert.ok(peak(empty.recs) > RUN_SPEED * mul * 0.7 * 0.95, `o'tinsiz bot avvalgidek tisariladi (${peak(empty.recs).toFixed(2)} m/s)`);
  });

  it("5. Qo'li to'la bot bo'ridan uzoqroq (≤45 m) gulxanga qochadi; 0-2 ta o'tinli bot — avvalgidek bo'ridan teskari tomonga", () => {
    const room = makeNightRoom(createFakeIo());
    try {
      const { p, bot } = startNightWithBot(room);
      parkHuman(room, p);
      const nav = room.nav;
      // Eng yaqin yonib turgan gulxandan 33-42 m dagi, gulxanga yo'li bor nav tuguni
      let spot: { pos: Vec3; fire: { x: number; y: number; z: number } } | null = null;
      for (const i of nav.roamList) {
        const c = nav.center(i);
        const f = room.nearestLitFire(c.x, c.z);
        if (!f) continue;
        const fd = Math.hypot(f.x - c.x, f.z - c.z);
        if (fd < 33 || fd > 42) continue;
        const fi = nav.nearest({ x: f.x, y: f.y, z: f.z });
        if (fi < 0 || nav.findPath(c, nav.center(fi)).length === 0) continue;
        spot = { pos: c, fire: f };
        break;
      }
      assert.ok(spot, 'gulxandan 33-42 m dagi nav tuguni topildi');
      const { pos, fire } = spot!;
      const fd = Math.hypot(fire.x - pos.x, fire.z - pos.z);
      // Bo'ri botning gulxanga teskari tomonida (yo'lni to'smaydi), 8 m da
      const ax = (pos.x - fire.x) / fd;
      const az = (pos.z - fire.z) / fd;
      const wolfPos = { x: pos.x + ax * 8, y: pos.y, z: pos.z + az * 8 };
      const brain = bot.brain as unknown as { pickWolfFleeGoal(wolfPos: Vec3, dH: number): { goal: Vec3; path: Vec3[] } };
      const pick = (wood: number) => {
        bot.pos = { ...pos };
        bot.wood = wood;
        const res = brain.pickWolfFleeGoal(wolfPos, 8);
        return { ...res, fireDist: Math.hypot(res.goal.x - fire.x, res.goal.z - fire.z) };
      };
      const loaded = pick(WOOD_CARRY_MAX);
      assert.ok(loaded.path.length > 0, "gulxanga yo'l bor");
      assert.ok(loaded.fireDist <= CAMPFIRE_RADIUS_M, `to'la qo'lli bot gulxanga qochadi (${loaded.fireDist.toFixed(1)} m, gulxan ${fd.toFixed(1)} m)`);
      for (const wood of [0, 1, 2]) {
        const free = pick(wood);
        assert.ok(free.fireDist > CAMPFIRE_RADIUS_M + 5, `${wood} ta o'tinli bot ~14 m ga qochadi (${free.fireDist.toFixed(1)} m)`);
      }
    } finally {
      room.destroy();
    }
  });
});
