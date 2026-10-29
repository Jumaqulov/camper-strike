import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { formatFlarePillUz } from '../../client/game/survival/SurvivalUI';
import { applyAuthoritativeWeaponSwitch } from '../../server/combat/weaponSwitchAuthority';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import { MAX_HP } from '../constants';
import { LOOT_CATALOG, getAmmoCatalogId, getWeaponCatalogId, type LootCatalogId } from '../loot';
import type { Vec3 } from '../math';
import { collidesAtWorld, raycastWorld } from '../physics';
import type { ChatMsg, CreateRoomOpts, MatchState } from '../protocol';
import { isMeleeWeapon } from '../weapons';
import { sampleTerrainHeight } from '../world';
import {
  BOT_FLARE_COOLDOWN_SEC,
  BOT_FLARE_LOW_HP,
  BOT_FLARE_SWARM_COUNT,
  CAMPFIRE_MAX_FUEL_SEC,
  CAMPFIRE_RADIUS_M,
  FLARE_DURATION_SEC,
  FLARE_SCARE_SEC,
  SUPPLY_BEACON_SEC,
  SUPPLY_DROP_CLEAR_M,
  SUPPLY_DROP_EDGE_M,
  SUPPLY_DROP_FALL_SEC,
  SUPPLY_DROP_FIRE_CLEAR_M,
  SUPPLY_DROP_MAX_DIST_M,
  SUPPLY_DROP_MIN_DIST_M,
  WOLF_CORPSE_SEC,
  supplyDropClock,
  type NightSupplyDropEvent,
  type WolfBiteEvent,
} from '../wolf';

// Bosqich 34 — Tong otguncha: yordam yuki va signal raketasi spetsifikatsiyaga moslandi.
// 10-band: "Xaritaning tasodifiy joyiga qurol va o'q tushadi" — joy va qurol xonaning maxfiy loot seedi ⊕ raund
// bo'yicha (lobbi standart publicLayoutSeed bir xil bo'lsa ham har xonada/raundda boshqa), 40–160 m, lager va
// bezaklar ichiga emas, yetib boriladigan; quti havoda ochilmaydi; kech qo'shilganga mayoq qolgan vaqt bilan.
// 11-band: "20 soniya davomida hamma bo'rilarni qo'rqitib turadi" — masofadan qat'i nazar, raketa yonib turganda
// paydo bo'lgan/qayta tug'ilganlari ham; hech kim tishlanmaydi. Qurolli bot to'da o'rab olganda raketa otadi.

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

/** Lobbi standart sozlamalari bilan tun xonasi (publicLayoutSeed berilmaydi — standart 6501). */
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
      countdownSec: 2,
      wolves: 0,
      ...overrides,
    },
    io,
    () => {},
  );
}

/** Odamlar tayyor bo'lib raundni boshlaydi (sanoq 2 s). */
function startNight(room: Room, names: string[] = ['Ovchi']): ServerPlayer[] {
  const out: ServerPlayer[] = [];
  names.forEach((name, i) => {
    const id = `p${i + 1}`;
    room.addHuman(createFakeSocket(id), name);
    room.onReady(id, { world: room.worldMeta() });
  });
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  names.forEach((_, i) => {
    const p = room.players.get(`p${i + 1}`)!;
    p.spawnTime = -99;
    out.push(p);
  });
  return out;
}

function groundAt(room: Room, x: number, z: number): Vec3 {
  return { x, y: sampleTerrainHeight(room.world.terrain, x, z), z };
}

function mainFire(room: Room) {
  const f = [...room.campfires.values()].find((c) => c.main);
  assert.ok(f, 'asosiy gulxan bor');
  return f!;
}

type Pin = { p: ServerPlayer; pos: Vec3 };

/** Vaqtni suradi; o'yinchilar joyida, joni to'la (`onHurt` — shu qadamda jon kamaygan bo'lsa), gulxanlar to'la. */
function surviveFor(room: Room, sec: number, pinned: Pin[], step = 0.25, onTick?: (t: number) => void, onHurt?: (p: ServerPlayer) => void): void {
  let left = sec;
  while (left > 1e-6 && room.phase === 'playing') {
    const d = Math.min(step, left);
    room.advanceTimeForTest(d, 1 / 30);
    for (const f of room.campfires.values()) {
      f.fuelSec = CAMPFIRE_MAX_FUEL_SEC;
      f.lit = true;
    }
    for (const { p, pos } of pinned) {
      if (p.hp < MAX_HP || p.downed) onHurt?.(p);
      if (p.alive && !p.downed) p.hp = MAX_HP;
      p.pos = { ...pos };
      p.vel = { x: 0, y: 0, z: 0 };
    }
    onTick?.(room.now());
    left -= d;
  }
}

/** O'yinchini konteyner oldiga (1.1 m, yuzi konteynerga) qo'yadi. */
function standAt(room: Room, p: ServerPlayer, c: { x: number; z: number; yaw: number }): void {
  const x = c.x + Math.sin(c.yaw) * 1.1;
  const z = c.z + Math.cos(c.yaw) * 1.1;
  p.pos = groundAt(room, x, z);
  p.vel = { x: 0, y: 0, z: 0 };
  p.yaw = Math.atan2(-(c.x - p.pos.x), -(c.z - p.pos.z));
  p.pitch = -0.4;
}

function openContainer(room: Room, p: ServerPlayer, containerId: string, reqId: string) {
  return room.onContainerOpen(p.id, { requestId: reqId, containerId, roundId: room.getRoundId(), spawnId: p.spawnId });
}

/**
 * Sinov to'plami: `spot` da runtime konteyner (yordam yuki emas) — o'yinchi/bot ochib hammasini oladi
 * (odam bilan bir xil tekshiruvlar). Qaytaradi: konteyner joyi (o'yinchi uning oldida turadi).
 */
function giveKit(room: Room, p: ServerPlayer, spot: Vec3, items: LootCatalogId[], id = `test:kit:${p.id}`): void {
  room.loot.addRuntimeContainer({ id, kind: 'supply_crate', labelUz: 'Sinov', position: spot, yaw: 0, items });
  standAt(room, p, { x: spot.x, z: spot.z, yaw: 0 });
  p.hp = MAX_HP;
  const open = p.isBot ? room.botOpenContainer(p, id) : openContainer(room, p, id, `open:${id}`);
  assert.ok(open.ok, `sinov konteyneri ochildi: ${open.code ?? ''} ${open.message ?? ''}`);
  for (const it of open.container!.items) {
    const res = p.isBot
      ? room.botPickupItem(p, id, it.id)
      : room.onLootPickup(p.id, { requestId: `pick:${it.id}`, containerId: id, itemId: it.id, roundId: room.getRoundId(), spawnId: p.spawnId });
    assert.ok(res.ok, `${it.catalogId} olindi: ${res.code ?? ''}`);
  }
}

/** `from` dan ~`len` m uzoqda, gulxanlardan uzoq, to'g'ri chiziq ochiq nav nuqtasi (yo'nalish `ang0` dan boshlab). */
function openPointFrom(room: Room, from: Vec3, len: number, ang0 = 0): Vec3 {
  const nav = room.nav;
  for (const [l, dyMax] of [[len, 1.0], [len * 0.75, 1.0], [len * 1.25, 1.0], [len, 1.8], [len * 0.6, 1.8]] as const) {
    for (let k = 0; k < 24; k++) {
      const ang = ang0 + (k / 24) * Math.PI * 2;
      const bx = from.x + Math.cos(ang) * l;
      const bz = from.z + Math.sin(ang) * l;
      const b = groundAt(room, bx, bz);
      if (Math.abs(b.y - from.y) > dyMax) continue;
      const ni = nav.nearest(b);
      if (ni < 0) continue;
      const c = nav.center(ni);
      if (Math.hypot(c.x - bx, c.z - bz) > 2.5) continue;
      if (room.litFireContaining(c.x, c.z, 4)) continue;
      if (!nav.segmentClear(from, c)) continue;
      return c;
    }
  }
  throw new Error('ochiq nuqta topilmadi');
}

/** Kamida `n` ta tirik bo'ri (chegara ichida). */
function ensureWolves(room: Room, n: number): ServerWolf[] {
  while ([...room.wolves.values()].filter((w) => w.alive).length < n) {
    assert.ok(room.addWolf(), "bo'ri qo'shildi");
  }
  return [...room.wolves.values()].filter((w) => w.alive);
}

/** Bo'rini `pos` ga qo'yib, `prey` ni ovlashga undaydi (zarba — nishon). */
function setHunting(room: Room, w: ServerWolf, pos: Vec3, prey: ServerPlayer): void {
  w.pos = { ...pos };
  w.vel = { x: 0, y: 0, z: 0 };
  w.yaw = Math.atan2(-(prey.pos.x - pos.x), -(prey.pos.z - pos.z));
  w.brain.onDamaged(prey, room.now());
}

/** Bo'rini hamma o'yinchilardan `minD` m uzoq tasodifiy nav nuqtasiga olib ketadi. */
function moveFar(room: Room, w: ServerWolf, from: Vec3[], minD: number): void {
  for (let i = 0; i < 400; i++) {
    const c = room.nav.randomPoint();
    if (from.every((f) => Math.hypot(f.x - c.x, f.z - c.z) >= minD)) {
      w.pos = { ...c };
      w.vel = { x: 0, y: 0, z: 0 };
      return;
    }
  }
}

/** Raundni yordam yuki tushgan lahzagacha suradi (0.05 s qadam bilan — tushish paytida to'xtaydi). */
function reachDropMoment(room: Room, pins: Pin[]): { dropT: number } {
  const dur = 4 * 60;
  surviveFor(room, dur * 0.5 - 3, pins);
  assert.equal(room.getSupplyDrop(), null, "3-to'lqindan oldin yuk yo'q");
  for (let i = 0; i < 200 && !room.getSupplyDrop(); i++) surviveFor(room, 0.05, pins, 0.05);
  assert.ok(room.getSupplyDrop(), "3-to'lqin boshida yuk tusha boshladi");
  return { dropT: room.now() };
}

const planKey = (pl: { x: number; z: number }) => `${pl.x},${pl.z}`;

describe("Bosqich 34 — Tong otguncha: yordam yuki (10-band) va signal raketasi (11-band) spetsifikatsiya bo'yicha", () => {
  it("1. Yuk joyi va quroli har xonada va har raundda boshqa (lobbi standart sozlamalari — bir xil xarita va gulxanlar); bir xona/raund uchun barqaror", () => {
    const { io } = createFakeIo();
    const rooms = Array.from({ length: 4 }, () => makeNightRoom(io));
    try {
      // Ommaviy joylashuv hammada bir xil (publicLayoutSeed bir xil) — farq faqat maxfiy seedda
      const layout = (r: Room) => [...r.campfires.values()].map((f) => `${f.x},${f.z}`).join('|');
      for (const r of rooms) assert.equal(layout(r), layout(rooms[0]!), 'gulxanlar hamma xonada bir joyda');
      assert.equal(new Set(rooms.map((r) => r.getSecretLootSeedForServer())).size, rooms.length, 'maxfiy seedlar har xil');

      const plans = rooms.map((r) => [1, 2, 3, 4].map((round) => r.planSupplyDrop(round)!));
      for (const ps of plans) for (const pl of ps) assert.ok(pl, 'reja bor');
      // Barqaror: qayta chaqirilsa bir xil (raund ichida joy "sakramaydi")
      rooms.forEach((r, i) => assert.deepEqual(r.planSupplyDrop(1), plans[i]![0]));
      // 1-raund: xonalar bo'yicha joy bir xil emas (eski xato — hamma xonada aynan bir nuqta)
      const firstRound = new Set(plans.map((ps) => planKey(ps[0]!)));
      assert.ok(firstRound.size >= 3, `4 xonada 1-raund joylari: ${[...firstRound].join(' ; ')}`);
      // Har xonada raund sayin joy o'zgaradi
      for (const ps of plans) assert.ok(new Set(ps.map(planKey)).size >= 3, `raundlar bo'yicha joylar: ${ps.map(planKey).join(' ; ')}`);
      // Qurol ham tasodifiy: 16 rejada ikkala tur uchraydi
      const weapons = new Set(plans.flat().map((pl) => pl.weapon));
      assert.deepEqual([...weapons].sort(), ['rifle', 'shotgun']);
    } finally {
      for (const r of rooms) r.destroy();
    }
  });

  it("2. Joy: asosiy gulxandan 40–160 m (eski 35–70 m halqadan keng), gulxanlardan ≥ 30 m, g'aramlardan ≥ 12 m, chetdan ≥ 8 m, ochiq osmon, to'siqsiz, sayr komponentida — asosiy gulxandan nav yo'li bor", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const main = mainFire(room);
      const b = room.world.bounds;
      const roam = new Set(room.nav.roamList);
      const up = { x: 0, y: 1, z: 0 };
      const dists: number[] = [];
      for (let round = 1; round <= 30; round++) {
        const pl = room.planSupplyDrop(round)!;
        assert.ok(pl, `${round}-raund rejasi`);
        const d = Math.hypot(pl.x - main.x, pl.z - main.z);
        dists.push(d);
        assert.ok(d >= SUPPLY_DROP_MIN_DIST_M && d <= SUPPLY_DROP_MAX_DIST_M, `${round}: asosiy gulxandan ${d.toFixed(1)} m`);
        for (const f of room.campfires.values()) {
          const df = Math.hypot(pl.x - f.x, pl.z - f.z);
          assert.ok(df >= SUPPLY_DROP_FIRE_CLEAR_M && df > CAMPFIRE_RADIUS_M, `${round}: ${f.id} dan ${df.toFixed(1)} m`);
        }
        for (const pile of room.woodPiles.values()) {
          assert.ok(Math.hypot(pl.x - pile.x, pl.z - pile.z) >= SUPPLY_DROP_CLEAR_M, `${round}: ${pile.id} dan uzoq`);
        }
        assert.ok(pl.x >= b.minX + SUPPLY_DROP_EDGE_M && pl.x <= b.maxX - SUPPLY_DROP_EDGE_M, `${round}: x chetdan uzoq`);
        assert.ok(pl.z >= b.minZ + SUPPLY_DROP_EDGE_M && pl.z <= b.maxZ - SUPPLY_DROP_EDGE_M, `${round}: z chetdan uzoq`);
        // Sayr komponentidagi nav tuguni (yetib boriladigan), bezak/to'siq ichida emas, ustida tom yo'q
        const ni = room.nav.nearest(pl);
        assert.ok(ni >= 0 && roam.has(ni), `${round}: sayr komponentida`);
        const c = room.nav.center(ni);
        assert.ok(Math.hypot(c.x - pl.x, c.z - pl.z) < 0.01, `${round}: nav tugunida`);
        assert.equal(collidesAtWorld(room.world, pl.x, pl.y + 0.05, pl.z, 1.2, 1.0), false, `${round}: atrofi bo'sh`);
        assert.equal(raycastWorld(room.world, { x: pl.x, y: pl.y + 0.6, z: pl.z }, up, 14), null, `${round}: ochiq osmon`);
        // Asosiy gulxandan piyoda yo'l bor (oxirgi nuqta — yuk tuguni)
        const path = room.nav.findPath({ x: main.x, y: main.y, z: main.z }, pl);
        assert.ok(path.length > 0, `${round}: asosiy gulxandan yo'l topildi`);
        const last = path[path.length - 1]!;
        assert.ok(Math.hypot(last.x - pl.x, last.z - pl.z) < 0.01, `${round}: yo'l yukka yetadi`);
        // Burilish 90° karrali (quti panjaraga tekis)
        assert.ok(Math.abs(Math.round(pl.yaw / (Math.PI / 2)) * (Math.PI / 2) - pl.yaw) < 0.01);
      }
      // Xaritaning katta qismi: eski 70 m chegaradan nariga ham tushadi, masofalar keng tarqalgan
      assert.ok(Math.max(...dists) > 70, `eng uzoq ${Math.max(...dists).toFixed(1)} m`);
      assert.ok(Math.max(...dists) - Math.min(...dists) > 40, `tarqoqlik ${(Math.max(...dists) - Math.min(...dists)).toFixed(1)} m`);
    } finally {
      room.destroy();
    }
  });

  it("3. Havodagi quti ochilmaydi: SUPPLY_DROP_FALL_SEC davomida konteyner yo'q (odam ham, bot ham ocholmaydi), yerga tekkach loot:snapshot va ochiladi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { bots: 1 });
    try {
      const [p] = startNight(room);
      const bot = [...room.players.values()].find((x) => x.isBot)!;
      assert.ok(bot, 'bot bor');
      const home = { ...p!.pos };
      const before = emitted.length;
      const { dropT } = reachDropMoment(room, [{ p: p!, pos: home }]);
      const s = room.getSupplyDrop()!;
      assert.equal(s.landed, false, 'quti hali havoda');
      const ev = emitted.slice(before).find((e) => e.event === 'night:supplyDrop')?.payload as NightSupplyDropEvent | undefined;
      assert.ok(ev, 'night:supplyDrop hodisasi (tushish boshlandi)');
      assert.equal(ev!.id, s.id);
      assert.ok(Number.isFinite(ev!.yaw));
      const night = room.getNightSnap()!;
      assert.ok(night.supply, 'NightSnap.supply havodagi quti uchun ham bor');
      assert.equal(night.supply!.opened, false);
      assert.ok(night.supply!.ageSec >= 0 && night.supply!.ageSec < SUPPLY_DROP_FALL_SEC, `ageSec ${night.supply!.ageSec}`);
      assert.equal(night.supply!.yaw, ev!.yaw);

      // Havoda: konteyner snapshotda yo'q; quti tagida turgan odam va bot ocholmaydi
      const hasContainer = () => room.loot.getPublicLootSnapshot().containers.some((c) => c.id === s.id);
      assert.equal(hasContainer(), false, 'havodagi quti loot snapshotda yo‘q');
      assert.equal(room.loot.getPublicContainerState(s.id), null);
      const supplyLootSnaps = () =>
        emitted.filter(
          (e) => e.event === 'loot:snapshot' && (e.payload as { containers: { id: string }[] }).containers.some((c) => c.id === s.id),
        ).length;
      assert.equal(supplyLootSnaps(), 0, "yuk bilan loot:snapshot hali yuborilmagan");
      const crate = { x: s.x, z: s.z, yaw: ev!.yaw };
      standAt(room, p!, crate);
      const early = openContainer(room, p!, s.id, 'early');
      assert.equal(early.ok, false, 'havodagi qutini odam ocholmaydi');
      assert.equal(early.code, 'CONTAINER_NOT_FOUND');
      standAt(room, bot, { x: s.x, z: s.z, yaw: ev!.yaw + Math.PI });
      bot.hp = MAX_HP;
      assert.equal(room.botOpenContainer(bot, s.id).ok, false, 'havodagi qutini bot ocholmaydi');

      // Tushishning oxirigacha (0.3 s qolganda) ham yopiq
      const pins: Pin[] = [{ p: p!, pos: { ...p!.pos } }, { p: bot, pos: { ...bot.pos } }];
      surviveFor(room, SUPPLY_DROP_FALL_SEC - 0.3 - (room.now() - dropT), pins, 0.05);
      const t1 = room.getNightSnap()!.supply!.ageSec;
      if (t1 < SUPPLY_DROP_FALL_SEC - 0.05) {
        assert.equal(room.getSupplyDrop()!.landed, false);
        assert.equal(openContainer(room, p!, s.id, 'early2').ok, false, `${t1} s da hali yopiq`);
      }

      // Yerga tegdi: konteyner paydo bo'ladi, loot:snapshot yuboriladi, ochiladi
      surviveFor(room, 0.6, pins, 0.05);
      assert.equal(room.getSupplyDrop()!.landed, true, 'yerga tegdi');
      assert.equal(hasContainer(), true, 'konteyner snapshotda');
      assert.equal(supplyLootSnaps(), 1, 'yuk bilan bitta loot:snapshot');
      const pub = room.loot.getPublicContainerState(s.id)!;
      assert.equal(pub.kind, 'supply_crate');
      assert.ok(Math.abs(pub.yaw - ev!.yaw) < 1e-6, 'konteyner burilishi hodisadagi bilan bir xil');
      standAt(room, p!, crate);
      const open = openContainer(room, p!, s.id, 'late');
      assert.ok(open.ok, `yerga tushgan quti ochildi: ${open.code ?? ''} ${open.message ?? ''}`);
      const items = open.container!.items;
      assert.equal(items.length, 7);
      const weapon = items.find((it) => it.kind === 'weapon')!;
      assert.ok(weapon.weaponId === 'rifle' || weapon.weaponId === 'shotgun');
      assert.equal(items.filter((it) => it.kind === 'ammo' && it.ammoWeapon === weapon.weaponId).length, 2);
      assert.equal(items.filter((it) => it.kind === 'flare').length, 2);
      assert.equal(room.planSupplyDrop()!.weapon, weapon.weaponId, 'tarkib rejadagi qurol bilan bir xil');
    } finally {
      room.destroy();
    }
  });

  it("4. Kech qo'shilgan o'yinchi: NightSnap.supply.ageSec tushishdan beri o'tgan vaqtni beradi — mayoq tushgan paytdan 90 s, qaytadan to'liq emas", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p] = startNight(room);
      const pins: Pin[] = [{ p: p!, pos: { ...p!.pos } }];
      const { dropT } = reachDropMoment(room, pins);
      surviveFor(room, 30, pins);
      // Kech qo'shilgan odam: keyingi 'match' da yuk holati va o'tgan vaqt keladi
      room.addHuman(createFakeSocket('late'), 'Kechikkan');
      room.onReady('late', { world: room.worldMeta() });
      const before = emitted.length;
      surviveFor(room, 0.6, pins, 0.1);
      const m = emitted
        .slice(before)
        .filter((e) => e.event === 'match')
        .pop()?.payload as MatchState | undefined;
      const sup = m?.survival?.night?.supply;
      assert.ok(sup, "match.survival.night.supply kech qo'shilganga ham boradi");
      const age = room.now() - dropT;
      assert.ok(Math.abs(sup!.ageSec - age) <= 0.6, `ageSec ${sup!.ageSec} ≈ ${age.toFixed(1)}`);
      assert.ok(sup!.ageSec > 29, 'ageSec raund vaqtidan, ulanish paytidan emas');

      // Klient soati: mayoq tushgan paytdan SUPPLY_BEACON_SEC (bu yerda ~60 s qoldi, 90 emas); quti yerda
      const now = 1000;
      const clock = supplyDropClock(sup!.ageSec, now);
      assert.equal(clock.falling, false);
      assert.ok(Math.abs(clock.beaconUntil - (now - sup!.ageSec + SUPPLY_BEACON_SEC)) < 1e-9);
      assert.ok(clock.beaconUntil - now < SUPPLY_BEACON_SEC - 29, `mayoq ${(clock.beaconUntil - now).toFixed(1)} s qoldi`);
      // Tushish paytida ulangan — qolgan qismi animatsiya bilan; mayoq muddati o'tgan — yonmaydi; noto'g'ri qiymat — yerda
      const mid = supplyDropClock(1, 50);
      assert.equal(mid.falling, true);
      assert.equal(mid.droppedAt, 49);
      assert.ok(supplyDropClock(SUPPLY_BEACON_SEC + 5, 500).beaconUntil < 500, "muddati o'tgan mayoq yonmaydi");
      assert.equal(supplyDropClock(Number.NaN, 10).falling, false);
    } finally {
      room.destroy();
    }
  });

  it("5. Raketa HAMMA bo'rilarni (har qanday masofada) 20 s qo'rqitadi; shu vaqtda paydo bo'lgan va qayta tug'ilgan bo'ri qolgan vaqt qochadi; hech kim tishlanmaydi; keyin ovga qaytadi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p1, p2] = startNight(room, ['Ovchi', 'Uzoqdagi']);
      // Ikki o'yinchi bir-biridan ≥ 80 m, ikkalasi ham lagerdan tashqarida (ochiq joyda)
      const spotA = room.planSupplyDrop(1)!;
      let spotB: Vec3 | null = null;
      for (let r = 2; r <= 60 && !spotB; r++) {
        const pl = room.planSupplyDrop(r)!;
        if (Math.hypot(pl.x - spotA.x, pl.z - spotA.z) >= 80) spotB = pl;
      }
      assert.ok(spotB, "ikkinchi o'yinchi uchun uzoq joy");
      giveKit(room, p1!, spotA, ['item:flare']);
      assert.equal(room.loot.getFlareCount(p1!.id), 1);
      const a = groundAt(room, spotA.x, spotA.z);
      const bPos = groundAt(room, spotB!.x, spotB!.z);
      p1!.pos = { ...a };
      p2!.pos = { ...bPos };

      // Bo'rilar: biri otuvchini, biri ≥ 80 m naridagi o'yinchini ovlamoqda, qolganlari uzoqda
      const wolves = ensureWolves(room, 4);
      const [wNear, wFar, ...rest] = wolves;
      setHunting(room, wNear!, openPointFrom(room, a, 12), p1!);
      setHunting(room, wFar!, openPointFrom(room, bPos, 8), p2!);
      for (const w of rest) moveFar(room, w, [a, bPos], 60);
      const pins: Pin[] = [
        { p: p1!, pos: a },
        { p: p2!, pos: bPos },
      ];
      surviveFor(room, 0.4, pins, 0.1);
      const farD = Math.hypot(wFar!.pos.x - a.x, wFar!.pos.z - a.z);
      assert.ok(farD > 60, `uzoqdagi bo'ri raketadan ${farD.toFixed(0)} m`);
      assert.notEqual(wFar!.state, 'flee');

      const t0 = room.now();
      const before = emitted.length;
      const ack = room.onUseFlare(p1!.id, {});
      assert.equal(ack.ok, true, ack.error ?? '');
      // Hammasi darhol qochadi: masofadan qat'i nazar, scaredUntil = raketa so'nishi
      for (const w of room.wolves.values()) {
        if (!w.alive) continue;
        assert.equal(w.state, 'flee', `${w.id} (${Math.hypot(w.pos.x - a.x, w.pos.z - a.z).toFixed(0)} m) qochmoqda`);
        assert.ok(Math.abs(w.scaredUntil - (t0 + FLARE_SCARE_SEC)) < 1e-6, `${w.id} scaredUntil`);
        assert.equal(Number.isFinite(w.fleeUntil), false, 'tong qochishi emas');
      }
      assert.equal(FLARE_SCARE_SEC, FLARE_DURATION_SEC);
      const chat = emitted
        .slice(before)
        .filter((e) => e.event === 'chat')
        .map((e) => (e.payload as ChatMsg).text)
        .find((txt) => txt.includes('signal raketasini otdi'));
      assert.ok(chat?.includes("hamma bo'rilar") && chat.includes(`${FLARE_SCARE_SEC} s`), `chat haqiqatga mos: ${chat}`);

      // Kuzatuv: 20 s davomida har tickda hamma tirik bo'ri qochmoqda, hech kim tishlanmaydi
      let notFleeing = '';
      let attacked = false;
      let hurt = '';
      const watch = (t: number) => {
        if (t >= t0 + FLARE_SCARE_SEC - 0.05) return;
        for (const w of room.wolves.values()) {
          if (!w.alive) continue;
          if (w.state === 'attack') attacked = true;
          if (w.state !== 'flee' && !notFleeing) notFleeing = `${w.id} ${w.state} @${(t - t0).toFixed(1)} s`;
        }
      };
      const onHurt = (p: ServerPlayer) => {
        if (room.now() < t0 + FLARE_SCARE_SEC - 0.05 && !hurt) hurt = `${p.name} @${(room.now() - t0).toFixed(1)} s`;
      };
      surviveFor(room, 5, pins, 0.1, watch, onHurt);

      // Raketa yonib turganda yangi bo'ri paydo bo'ldi — qolgan ~15 s qochadi (20 emas)
      const fresh = room.addWolf();
      assert.ok(fresh, "yangi bo'ri qo'shildi");
      const tAdd = room.now();
      assert.equal(fresh!.state, 'flee', "raketa paytida paydo bo'lgan bo'ri darhol qochadi");
      assert.ok(Math.abs(fresh!.scaredUntil - (t0 + FLARE_SCARE_SEC)) < 1e-6, `qolgan vaqt: ${(fresh!.scaredUntil - tAdd).toFixed(2)} s`);
      assert.ok(fresh!.scaredUntil - tAdd < FLARE_SCARE_SEC - 4);

      // O'lgan bo'ri raketa paytida qayta tug'iladi — u ham qochadi
      const dead = rest[0]!;
      dead.alive = false;
      dead.hp = 0;
      dead.state = 'dead';
      dead.diedAt = room.now() - WOLF_CORPSE_SEC - 0.5;
      dead.respawnAt = room.now();
      surviveFor(room, 0.2, pins, 0.1, watch, onHurt);
      assert.equal(dead.alive, true, "bo'ri qayta tug'ildi");
      assert.equal(dead.state, 'flee', "qayta tug'ilgan bo'ri qochmoqda");
      assert.ok(Math.abs(dead.scaredUntil - (t0 + FLARE_SCARE_SEC)) < 1e-6, 'qayta tug‘ilgan — raketaning qolgan vaqti');

      surviveFor(room, t0 + FLARE_SCARE_SEC - 0.2 - room.now(), pins, 0.1, watch, onHurt);
      assert.equal(notFleeing, '', `raketa paytida hamma bo'ri qochishi kerak edi: ${notFleeing}`);
      assert.equal(attacked, false, "hech bir bo'ri tashlanmadi");
      assert.equal(hurt, '', `hech kim tishlanmadi: ${hurt}`);
      const bites = emitted.slice(before).filter((e) => e.event === 'wolf:bite' && (e.payload as WolfBiteEvent).hit);
      assert.equal(bites.length, 0, "tishlash hodisasi yo'q");
      assert.ok(room.wolves.has(wFar!.id), "qo'rqqan bo'rilar xonadan o'chmaydi");

      // Raketa so'ndi — qo'rquv tugaydi, bo'rilar odatdagi holatga qaytadi
      surviveFor(room, 1.5, pins, 0.1);
      assert.equal(room.hasActiveFlare(), false);
      for (const w of room.wolves.values()) {
        if (!w.alive) continue;
        assert.notEqual(w.state, 'flee', `${w.id} qaytdi (${w.state})`);
        assert.equal(w.scaredUntil, 0);
      }
      // Raketa yo'q paytda paydo bo'lgan bo'ri qo'rqmaydi
      const calm = room.addWolf();
      if (calm) {
        assert.notEqual(calm.state, 'flee');
        assert.equal(calm.scaredUntil, 0);
      }
    } finally {
      room.destroy();
    }
  });

  it("6. Qurolli bot: bitta bo'ri — otishadi (raketa saqlanadi), to'da (≥ 3 bo'ri) o'rab olsa — raketa otadi; joni oz yoki otolmasa ham otadi; gulxan yonida/faol raketa/cooldown — otmaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { bots: 1 });
    try {
      const [p] = startNight(room);
      const bot = [...room.players.values()].find((x) => x.isBot)!;
      assert.ok(bot, 'bot bor');
      const spot = room.planSupplyDrop(1)!;
      giveKit(room, bot, spot, [getWeaponCatalogId('rifle'), getAmmoCatalogId('rifle'), 'item:flare', 'item:flare']);
      applyAuthoritativeWeaponSwitch(bot, 'rifle', room.now(), { fromAutoPickup: true });
      room.loot.syncPlayerFromServerPlayer(bot.id, bot);
      assert.equal(bot.weapon, 'rifle');
      assert.ok(!isMeleeWeapon(bot.weapon) && bot.ammo.rifle.mag + bot.ammo.rifle.reserve > 0, 'bot qurolli (o‘q bor)');
      assert.equal(room.loot.getFlareCount(bot.id), 2);
      assert.equal(LOOT_CATALOG['item:flare'].spawnWeight <= 3, true, 'raketa kam uchraydigan buyum');

      const home = { ...p!.pos };
      const at = groundAt(room, spot.x, spot.z);
      bot.pos = { ...at };
      bot.hp = MAX_HP;
      const wolves = ensureWolves(room, BOT_FLARE_SWARM_COUNT + 1);
      for (const w of wolves) moveFar(room, w, [at, home], 70);
      const brain = bot.brain as unknown as { shouldFireFlare(t: number, dH: number, canShoot: boolean): boolean; nextFlareAt: number };

      // Qaror (sof): bitta ovlayotgan bo'ri 5 m da, bot otishga qodir va joni to'la — raketa kerak emas
      const [w1, w2, w3] = wolves;
      const near = (w: ServerWolf, len: number, ang: number) => {
        w.pos = openPointFrom(room, at, len, ang);
        w.state = 'hunt';
        w.targetId = bot.id;
      };
      near(w1!, 5, 0);
      const t = room.now();
      assert.equal(brain.shouldFireFlare(t, 5, true), false, "bitta bo'ri — qurolli bot otishadi");
      assert.equal(brain.shouldFireFlare(t, 5, false), true, "otolmaydi (ko'rmaydi/o'qsiz) — raketa");
      bot.hp = BOT_FLARE_LOW_HP;
      assert.equal(brain.shouldFireFlare(t, 5, true), true, 'joni oz — raketa');
      bot.hp = MAX_HP;
      near(w2!, 9, 2.1);
      assert.equal(brain.shouldFireFlare(t, 5, true), false, "ikki bo'ri — hali to'da emas");
      near(w3!, 11, 4.2);
      assert.equal(brain.shouldFireFlare(t, 5, true), true, "uch bo'ri aynan botni ovlamoqda — raketa (qurolli bo'lsa ham)");
      brain.nextFlareAt = t + 5;
      assert.equal(brain.shouldFireFlare(t, 5, true), false, 'cooldown');
      brain.nextFlareAt = 0;
      const fire = mainFire(room);
      bot.pos = groundAt(room, fire.x + 3, fire.z);
      assert.equal(brain.shouldFireFlare(t, 5, true), false, 'gulxan yonida — olov himoya qiladi');
      bot.pos = { ...at };
      for (const w of wolves) moveFar(room, w, [at, home], 70);
      for (const w of wolves) {
        w.state = 'idle';
        w.targetId = null;
      }

      // Haqiqiy AI: uchta bo'ri botga hujum qiladi — bot (qurolli, joni to'la) raketa otadi
      setHunting(room, w1!, openPointFrom(room, at, 10, 0), bot);
      setHunting(room, w2!, openPointFrom(room, at, 10, 2.1), bot);
      setHunting(room, w3!, openPointFrom(room, at, 10, 4.2), bot);
      const pins: Pin[] = [{ p: p!, pos: home }];
      let fired = false;
      let armedWhenFired = false;
      const before = emitted.length;
      surviveFor(room, 4, pins, 0.05, () => {
        if (fired) return;
        if (bot.alive && !bot.downed) bot.hp = MAX_HP;
        if (room.flares.size > 0) {
          fired = true;
          armedWhenFired = !!bot.weapon && !isMeleeWeapon(bot.weapon) && bot.ammo[bot.weapon].mag + bot.ammo[bot.weapon].reserve > 0;
        }
      });
      assert.ok(fired, "to'da o'rab olganda qurolli bot raketa otdi");
      assert.ok(armedWhenFired, 'otgan paytda bot qurolli edi');
      const ev = emitted.slice(before).find((e) => e.event === 'night:flare')?.payload as { byId: string } | undefined;
      assert.equal(ev?.byId, bot.id);
      assert.equal(room.loot.getFlareCount(bot.id), 1, 'bitta raketa sarflandi');
      assert.ok(brain.nextFlareAt >= room.now() + BOT_FLARE_COOLDOWN_SEC - 5, 'bot cooldownga tushdi');
      for (const w of [w1!, w2!, w3!]) if (w.alive) assert.equal(w.state, 'flee', `${w.id} qochmoqda`);
      // Raketa yonib turganda ikkinchisi behuda otilmaydi
      brain.nextFlareAt = 0;
      assert.equal(room.hasActiveFlare(), true);
      assert.equal(brain.shouldFireFlare(room.now(), 5, false), false, 'faol raketa bor — ikkinchisi otilmaydi');
    } finally {
      room.destroy();
    }
  });

  it("7. O'yinchiga ko'rinadigan matnlar haqiqiy xatti-harakatga mos: katalog tavsifi va HUD pilli — hamma bo'rilar, 20 s, radius yo'q", () => {
    const desc = LOOT_CATALOG['item:flare'].descriptionUz;
    assert.ok(desc.includes("hamma bo'rilarni"), desc);
    assert.ok(desc.includes(`${FLARE_DURATION_SEC} soniya`), desc);
    assert.ok(!/\d+\s*m\b/.test(desc), `tavsifda radius yo'q: ${desc}`);
    // Pill hammaga ko'rinadi — raketa xaritadagi hamma bo'rilarni qo'rqitadi
    const pill = formatFlarePillUz(14.2)!;
    assert.equal(pill.text, "🎇 Bo'rilar qochmoqda 15 s");
    assert.equal(pill.cls, '');
    assert.equal(formatFlarePillUz(4.1)!.cls, 'low');
    assert.equal(formatFlarePillUz(0), null);
    assert.equal(formatFlarePillUz(Number.NaN), null);
  });
});
