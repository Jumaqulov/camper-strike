import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { generateRoomContainersAndLoot } from '../../server/loot/lootGenerator';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import { MAX_HP } from '../constants';
import { LOOT_CATALOG, type PublicContainerState, type PublicLootItem } from '../loot';
import type { Vec3 } from '../math';
import type { ChatMsg, CreateRoomOpts, Snapshot } from '../protocol';
import { computeGameplayHash, sampleTerrainHeight } from '../world';
import {
  CAMPFIRE_MAX_FUEL_SEC,
  FLARE_DURATION_SEC,
  FLARE_FEAR_RADIUS_M,
  SUPPLY_DROP_CLEAR_M,
  SUPPLY_DROP_FALL_SEC,
  SUPPLY_DROP_FIRE_CLEAR_M,
  SUPPLY_DROP_MAX_DIST_M,
  SUPPLY_DROP_MIN_DIST_M,
  compassDirUz,
  isSupplyContainerId,
  type NightFlareEvent,
  type NightSupplyDropEvent,
  type UseFlareAck,
} from '../wolf';

// Bosqich 23 — Tong otguncha: yarim tungi yordam yuki (3-to'lqin boshida runtime konteyner) va signal raketasi
// (item:flare — otilganda 20 s davomida hamma bo'rilar qochadi). Xona haqiqiy Room, io/socket soxta; vaqt
// room.advanceTimeForTest bilan deterministik suriladi (publicLayoutSeed 6501, timeLimit 4 → 3-to'lqin 120 s da).

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

function systemChats(emitted: EmittedRoomEvent[]): string[] {
  return emitted.filter((e) => e.event === 'chat').map((e) => (e.payload as ChatMsg).text);
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

/**
 * Vaqtni suradi; o'yinchilar joyida, joni to'la, gulxanlar to'la (90 s dan keyin o'chib bo'rilar kirib kelmasin).
 */
function surviveFor(room: Room, sec: number, pinned: { p: ServerPlayer; pos: Vec3 }[], step = 0.25, onTick?: (t: number) => void): void {
  let left = sec;
  while (left > 1e-6 && room.phase === 'playing') {
    const d = Math.min(step, left);
    room.advanceTimeForTest(d, 1 / 30);
    for (const f of room.campfires.values()) {
      f.fuelSec = CAMPFIRE_MAX_FUEL_SEC;
      f.lit = true;
    }
    for (const { p, pos } of pinned) {
      if (p.alive && !p.downed) p.hp = MAX_HP;
      p.pos = { ...pos };
      p.vel = { x: 0, y: 0, z: 0 };
    }
    onTick?.(room.now());
    left -= d;
  }
}

/** Raundni 3-to'lqin boshiga (tunning yarmi) suradi, quti yerga tekkuncha kutadi va yordam yukini qaytaradi. */
function reachSupplyDrop(room: Room, p: ServerPlayer) {
  const home = { ...p.pos };
  const dur = 4 * 60;
  surviveFor(room, dur * 0.5 - 2, [{ p, pos: home }]);
  assert.equal(room.getSupplyDrop(), null, "3-to'lqindan oldin yordam yuki yo'q");
  surviveFor(room, 4 + SUPPLY_DROP_FALL_SEC, [{ p, pos: home }]);
  const s = room.getSupplyDrop();
  assert.ok(s, "3-to'lqin boshida yordam yuki tushdi");
  assert.equal(s!.landed, true, 'quti yerga tegdi');
  return { supply: s!, home };
}

/** O'yinchini konteyner oldiga (1.1 m, yuzi konteynerga) qo'yadi. */
function standAtContainer(room: Room, p: ServerPlayer, c: { x: number; y: number; z: number; yaw: number }): void {
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

function pickup(room: Room, p: ServerPlayer, containerId: string, itemId: string, reqId: string) {
  return room.onLootPickup(p.id, { requestId: reqId, containerId, itemId, roundId: room.getRoundId(), spawnId: p.spawnId });
}

/** Ochiq konteynerdan o'yinchi barcha raketalarni oladi; qaytaradi: olingan son. */
function takeFlares(room: Room, p: ServerPlayer, supplyId: string): number {
  const open = openContainer(room, p, supplyId, `open:${p.id}`);
  assert.ok(open.ok, `konteyner ochildi: ${open.code ?? ''} ${open.message ?? ''}`);
  const flares = open.container!.items.filter((it) => it.kind === 'flare');
  let n = 0;
  for (const it of flares) {
    const res = pickup(room, p, supplyId, it.id, `pick:${p.id}:${it.id}`);
    assert.ok(res.ok, `raketa olindi: ${res.code ?? ''}`);
    n++;
  }
  return n;
}

/** Xonada kamida bitta tirik bo'ri bo'lsin. */
function firstWolf(room: Room): ServerWolf {
  let w = [...room.wolves.values()].find((x) => x.alive);
  if (!w) w = room.addWolf() ?? undefined;
  assert.ok(w, "bo'ri bor");
  return w!;
}

/**
 * O'yinchidan ~`len` m uzoqda, gulxanlardan uzoq, to'siqsiz nuqta (24 yo'nalish; yordam yuki joyi tasodifiy —
 * topilmasa masofa biroz qisqartirib/uzaytirib, balandlik farqi yumshatilib sinaladi).
 */
function openPointFrom(room: Room, from: Vec3, len: number): Vec3 {
  const nav = room.nav;
  for (const [l, dyMax] of [[len, 1.0], [len * 0.75, 1.0], [len * 1.25, 1.0], [len, 1.8], [len * 0.6, 1.8], [len * 1.4, 1.8]] as const) {
    for (let k = 0; k < 24; k++) {
      const ang = (k / 24) * Math.PI * 2;
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
  throw new Error("ochiq nuqta topilmadi");
}

describe("Bosqich 23 — Tong otguncha: yarim tungi yordam yuki va signal raketasi", () => {
  it("1. Yordam yuki 3-to'lqin boshida tushadi: joy (40–160 m asosiy gulxandan, ≥ 30 m gulxanlardan, ≥ 12 m g'aramlardan), tarkibi, snapshotlar, chat, hodisa; gameplayHash o'zgarmaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const hashBefore = room.world.gameplayHash;
      assert.equal(hashBefore, '344d2cb0662ba731');
      const containersBefore = room.loot.getPublicLootSnapshot().containers.length;
      const { supply } = reachSupplyDrop(room, p);
      assert.ok(isSupplyContainerId(supply.id));

      // Joy: asosiy gulxandan 40–160 m, gulxanlardan ≥ 30 m, g'aramlardan ≥ 12 m, nav tugunida (sayr komponenti)
      const main = mainFire(room);
      const dMain = Math.hypot(supply.x - main.x, supply.z - main.z);
      assert.ok(dMain >= SUPPLY_DROP_MIN_DIST_M && dMain <= SUPPLY_DROP_MAX_DIST_M, `asosiy gulxandan ${dMain.toFixed(1)} m`);
      for (const f of room.campfires.values()) {
        assert.ok(Math.hypot(supply.x - f.x, supply.z - f.z) >= SUPPLY_DROP_FIRE_CLEAR_M, `gulxan ${f.id} dan uzoq`);
      }
      for (const pl of room.woodPiles.values()) {
        assert.ok(Math.hypot(supply.x - pl.x, supply.z - pl.z) >= SUPPLY_DROP_CLEAR_M, `g'aram ${pl.id} dan uzoq`);
      }
      const ni = room.nav.nearest(supply);
      assert.ok(ni >= 0);
      const c = room.nav.center(ni);
      assert.ok(Math.hypot(c.x - supply.x, c.z - supply.z) < 0.01, 'nav tugunida');

      // Runtime konteyner ommaviy snapshotda; dunyo ta'rifi va gameplayHash daxlsiz
      const snap = room.loot.getPublicLootSnapshot();
      assert.equal(snap.containers.length, containersBefore + 1);
      const pub = snap.containers.find((x) => x.id === supply.id);
      assert.ok(pub, 'konteyner snapshotda');
      assert.equal(pub!.kind, 'supply_crate');
      assert.equal(pub!.labelUz, 'Yordam yuki');
      assert.equal(pub!.opened, false);
      assert.equal(pub!.itemCount, -1);
      assert.equal(pub!.items.length, 0);
      assert.equal(room.world.containerLocations.length, containersBefore);
      assert.equal(room.world.gameplayHash, '344d2cb0662ba731');
      assert.equal(computeGameplayHash(room.world), '344d2cb0662ba731', 'runtime konteyner xarita hashiga kirmaydi');

      // Tarkib (server yozuvi): qurol (avtomat/drobovik) + 2 ta mos o'q + aptechka + granata + 2 raketa
      const raw = room.loot.getRawContainerForServerTest(supply.id)!;
      const items = [...raw.items.values()];
      assert.equal(items.length, 7);
      const weapon = items.filter((it) => it.kind === 'weapon');
      assert.equal(weapon.length, 1);
      assert.ok(weapon[0]!.weaponId === 'rifle' || weapon[0]!.weaponId === 'shotgun');
      const ammo = items.filter((it) => it.kind === 'ammo');
      assert.equal(ammo.length, 2);
      for (const a of ammo) assert.equal(a.ammoWeapon, weapon[0]!.weaponId);
      assert.equal(items.filter((it) => it.kind === 'medkit').length, 1);
      assert.equal(items.filter((it) => it.kind === 'grenade').length, 1);
      assert.equal(items.filter((it) => it.kind === 'flare').length, 2);
      assert.equal(items.filter((it) => it.catalogId === 'item:flare').length, 2);
      // Ankorlar konteyner yonida (≤ 0.5 m)
      for (const it of items) assert.ok(Math.hypot(it.position.x - supply.x, it.position.z - supply.z) <= 0.5);

      // NightSnap.supply, 'night:supplyDrop' hodisasi va chat (yo'nalish + masofa)
      const night = room.getNightSnap()!;
      assert.ok(night.supply, 'NightSnap.supply bor');
      assert.equal(night.supply!.id, supply.id);
      assert.equal(night.supply!.opened, false);
      assert.equal(night.supply!.x, supply.x);
      const ev = emitted.find((e) => e.event === 'night:supplyDrop')?.payload as NightSupplyDropEvent | undefined;
      assert.ok(ev, 'night:supplyDrop hodisasi');
      assert.equal(ev!.id, supply.id);
      const chat = systemChats(emitted).find((t) => t.includes('Yordam yuki tushdi'));
      assert.ok(chat, 'chat xabari');
      assert.ok(chat!.includes(compassDirUz(supply.x - main.x, supply.z - main.z)), `yo'nalish chatda: ${chat}`);
      assert.ok(chat!.includes(`${Math.round(dMain)} m`), `masofa chatda: ${chat}`);
      // Yangi loot:snapshot yuborilgan (klient konteynerni chizadi)
      const lootSnaps = emitted.filter((e) => e.event === 'loot:snapshot');
      assert.ok(lootSnaps.some((e) => (e.payload as { containers: PublicContainerState[] }).containers.some((x) => x.id === supply.id)));
      // Match snapshotda ham (kech qo'shilganlar uchun)
      const m = emitted.filter((e) => e.event === 'match').pop()?.payload as { survival?: { night?: { supply?: unknown } } };
      assert.ok(m?.survival?.night?.supply, 'match.survival.night.supply');
      // Snapshot ('snap') hali ham keladi
      lastSnap(emitted);
    } finally {
      room.destroy();
    }
  });

  it("2. Yordam yukini ochish `opened` ni o'zgartiradi; raketalar inventarga (flares 2, item:flare slot) tushadi; ikkinchi tushish yo'q", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p, socket } = startSoloNight(room);
      const { supply } = reachSupplyDrop(room, p);
      const pub = room.loot.getPublicContainerState(supply.id)!;
      standAtContainer(room, p, { x: pub.position.x, y: pub.position.y, z: pub.position.z, yaw: pub.yaw });
      const open = openContainer(room, p, supply.id, 'o1');
      assert.ok(open.ok, `ochildi: ${open.code ?? ''} ${open.message ?? ''}`);
      assert.equal(open.container!.opened, true);
      assert.equal(open.container!.items.length, 7);
      assert.equal(room.getNightSnap()!.supply!.opened, true, 'NightSnap.supply.opened');
      assert.ok(emitted.some((e) => e.event === 'container:state' && (e.payload as PublicContainerState).id === supply.id));

      const flares = open.container!.items.filter((it) => it.kind === 'flare');
      assert.equal(flares.length, 2);
      const r1 = pickup(room, p, supply.id, flares[0]!.id, 'k1');
      assert.ok(r1.ok, r1.code ?? "");
      assert.equal(r1.inventory!.flares, 1);
      const r2 = pickup(room, p, supply.id, flares[1]!.id, 'k2');
      assert.ok(r2.ok, r2.code ?? "");
      assert.equal(r2.inventory!.flares, 2);
      assert.equal(r2.inventory!.maxFlares, 2);
      const slot = r2.inventory!.items.find((it) => it.catalogId === 'item:flare');
      assert.ok(slot, 'inventar slotida item:flare');
      assert.equal(slot!.kind, 'flare');
      assert.equal(slot!.quantity, 2);
      assert.equal(slot!.nameUz, LOOT_CATALOG['item:flare'].nameUz);
      assert.equal(room.loot.getFlareCount(p.id), 2);
      // Klientga inventory:state yuborilgan
      assert.ok(socket.events.some((e) => e.event === 'inventory:state' && (e.payload as { flares: number }).flares === 2));
      // Konteynerda 5 buyum qoldi
      assert.equal(room.loot.getPublicContainerState(supply.id)!.items.length, 5);

      // Raund davomida yana yuk tushmaydi (4-to'lqinda ham)
      const home = { ...p.pos };
      surviveFor(room, 65, [{ p, pos: home }]);
      assert.equal(room.getSupplyDrop()!.id, supply.id);
      assert.equal(room.loot.getPublicLootSnapshot().containers.filter((c) => isSupplyContainerId(c.id)).length, 1);
    } finally {
      room.destroy();
    }
  });

  it("3. Raketa otish: 1 ta sarflanadi, 'night:flare' va chat; ovlayotgan bo'ri qochadi, 20 s davomida ≥ ~30 m da turadi, tishlamaydi, to'da nishon bermaydi; keyin qaytadi (o'chmaydi)", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      const { supply } = reachSupplyDrop(room, p);
      const pub = room.loot.getPublicContainerState(supply.id)!;
      standAtContainer(room, p, { x: pub.position.x, y: pub.position.y, z: pub.position.z, yaw: pub.yaw });
      assert.equal(takeFlares(room, p, supply.id), 2);

      // Ochiq joy: o'yinchi gulxandan tashqarida, bo'ri 20 m narida ovlamoqda
      const anchor = groundAt(room, pub.position.x, pub.position.z);
      const wolfPos = openPointFrom(room, anchor, 20);
      const w = firstWolf(room);
      for (const o of room.wolves.values()) {
        if (o !== w) {
          // Boshqa bo'rilar uzoqda (sinovga xalaqit bermasin)
          o.pos = { ...room.nav.randomPoint() };
          while (Math.hypot(o.pos.x - anchor.x, o.pos.z - anchor.z) < 65) o.pos = { ...room.nav.randomPoint() };
        }
      }
      w.pos = { ...wolfPos };
      w.vel = { x: 0, y: 0, z: 0 };
      w.yaw = Math.atan2(-(anchor.x - w.pos.x), -(anchor.z - w.pos.z));
      w.brain.onDamaged(p, room.now());
      room.advanceTimeForTest(0.5, 1 / 30);
      p.pos = { ...anchor };
      assert.ok(w.targetId === p.id || w.state === 'hunt' || w.state === 'stalk' || w.state === 'hit', `bo'ri ovlamoqda (${w.state})`);

      const before = emitted.length;
      const t0 = room.now();
      const ack = room.onUseFlare(p.id, {});
      assert.equal(ack.ok, true, ack.error ?? "");
      assert.equal(ack.flares, 1);
      assert.ok(ack.until! > t0 + FLARE_DURATION_SEC - 0.5);
      assert.equal(room.loot.getFlareCount(p.id), 1);
      const ev = emitted.slice(before).find((e) => e.event === 'night:flare')?.payload as NightFlareEvent | undefined;
      assert.ok(ev, 'night:flare hodisasi');
      assert.equal(ev!.byId, p.id);
      assert.equal(ev!.byName, 'Ovchi');
      assert.equal(ev!.leftSec, FLARE_DURATION_SEC);
      assert.ok(Math.hypot(ev!.x - p.pos.x, ev!.z - p.pos.z) < 0.01);
      assert.ok(systemChats(emitted.slice(before)).some((t) => t.includes('Ovchi signal raketasini otdi')), 'chat');
      // Olov manbai — raketa
      const src = room.fearSourceContaining(p.pos.x, p.pos.z, 0);
      assert.equal(src?.kind, 'flare');
      assert.equal(src?.radius, FLARE_FEAR_RADIUS_M);
      assert.equal(room.isWolfPrey(p), true);
      assert.equal(room.isWolfPreyExposed(p), false, "raketa doirasida nishon bo'lmaydi");
      // NightSnap.flares
      const night = room.getNightSnap()!;
      assert.equal(night.flares?.length, 1);
      assert.equal(night.flares![0]!.id, ev!.id);
      assert.ok(night.flares![0]!.leftSec >= FLARE_DURATION_SEC - 1);
      // Bo'ri darhol qochadi
      assert.equal(w.state, 'flee', "bo'ri qochmoqda");
      assert.ok(w.scaredUntil > t0, 'scaredUntil belgilangan');
      assert.equal(Number.isFinite(w.fleeUntil), false, 'tong qochishi bilan adashtirilmagan');

      // 20 s: bo'ri 3 s dan keyin uzoqda (yuk joyi tasodifiy — xarita chetida qochish yo'li o'yinchi yonidan
      // biroz o'tishi mumkin, lekin yaqinlashmaydi), tashlanmaydi, tishlamaydi, to'da unga nishon bermaydi, xonadan o'chmaydi
      let minD = Infinity;
      let attacked = false;
      let bitten = false;
      let assigned = false;
      surviveFor(room, FLARE_DURATION_SEC - 0.5, [{ p, pos: anchor }], 0.1, (t) => {
        if (!room.wolves.has(w.id)) return;
        if (t - t0 > 3) minD = Math.min(minD, Math.hypot(w.pos.x - p.pos.x, w.pos.z - p.pos.z));
        if (w.state === 'attack') attacked = true;
        if (p.hp < MAX_HP) bitten = true;
        if (w.role !== null || w.targetId === p.id) assigned = true;
      });
      assert.ok(room.wolves.has(w.id), "qo'rqib qochgan bo'ri xonadan o'chirilmaydi");
      assert.equal(attacked, false, "tashlanmadi");
      assert.equal(bitten, false, 'tishlanmadi');
      assert.equal(assigned, false, "to'da raketa doirasidagi o'yinchiga nishon bermaydi");
      assert.ok(minD >= 10, `bo'ri eng yaqin ${minD.toFixed(1)} m (≥ 10)`);
      assert.ok(!emitted.slice(before).some((e) => e.event === 'wolf:bite' && (e.payload as { hit: boolean }).hit), "tishlash hodisasi yo'q");

      // Raketa so'ndi — manba yo'q, bo'ri qochishni to'xtatib sayrga qaytadi (tirik va xonada)
      surviveFor(room, 3, [{ p, pos: anchor }], 0.1);
      assert.equal(room.flares.size, 0, 'raketa so‘ndi');
      assert.equal(room.fearSourceContaining(p.pos.x, p.pos.z, 0), null);
      assert.equal(room.getNightSnap()!.flares, undefined);
      assert.ok(room.wolves.has(w.id) && w.alive);
      assert.notEqual(w.state, 'flee', `bo'ri qaytdi (${w.state})`);
      assert.equal(w.scaredUntil, 0);
    } finally {
      room.destroy();
    }
  });

  it("4. Xatolar: COOLDOWN (ketma-ket), NO_FLARE (raketa yo'q), DOWNED (yiqilgan), NOT_FOUND (begona id); boshqa rejimda NOT_NIGHT", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const { p } = startSoloNight(room);
      assert.deepEqual(room.onUseFlare(p.id, {}), { ok: false, error: 'NO_FLARE', flares: 0 } satisfies UseFlareAck);
      assert.equal(room.onUseFlare('yoq', {}).error, 'NOT_FOUND');
      const { supply } = reachSupplyDrop(room, p);
      const pub = room.loot.getPublicContainerState(supply.id)!;
      standAtContainer(room, p, { x: pub.position.x, y: pub.position.y, z: pub.position.z, yaw: pub.yaw });
      assert.equal(takeFlares(room, p, supply.id), 2);
      p.downed = true;
      assert.equal(room.onUseFlare(p.id, {}).error, 'DOWNED');
      assert.equal(room.loot.getFlareCount(p.id), 2, 'yiqilganda sarflanmaydi');
      p.downed = false;
      assert.equal(room.onUseFlare(p.id, {}).ok, true);
      const cd = room.onUseFlare(p.id, {});
      assert.equal(cd.error, 'COOLDOWN');
      assert.equal(cd.flares, 1);
      room.advanceTimeForTest(3.5, 0.25);
      p.hp = MAX_HP;
      const second = room.onUseFlare(p.id, {});
      assert.equal(second.ok, true, second.error ?? "");
      assert.equal(second.flares, 0);
      assert.equal(room.flares.size, 2, 'ikkita faol raketa');
      room.advanceTimeForTest(3.5, 0.25);
      p.hp = MAX_HP;
      assert.equal(room.onUseFlare(p.id, {}).error, 'NO_FLARE');
    } finally {
      room.destroy();
    }

    // forest_survival: raketa yo'q (NOT_NIGHT), yordam yuki tushmaydi
    const other = createFakeIo();
    const fs = new Room(
      {
        name: 'Survival',
        mode: 'forest_survival',
        mapId: 'forest_square',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 4,
        scoreLimit: 1,
        publicLayoutSeed: 6501,
        countdownSec: 2,
      },
      other.io,
      () => {},
    );
    try {
      const s = createFakeSocket('q1');
      fs.addHuman(s.socket, 'Omon');
      assert.equal(fs.onUseFlare('q1', {}).error, 'NOT_NIGHT');
      assert.equal(fs.getSupplyDrop(), null);
      assert.equal(fs.getNightSnap(), null);
    } finally {
      fs.destroy();
    }
  });

  it("5. Generator: item:flare faqat `flares` yoqilganda (wolf_night) chiqadi; forest_survival/FFA konteynerlarida hech qachon; katalog nightOnly", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      assert.equal(LOOT_CATALOG['item:flare'].nightOnly, true);
      assert.equal(LOOT_CATALOG['item:flare'].kind, 'flare');
      assert.equal(LOOT_CATALOG['item:flare'].maxStack, 2);
      const countFlares = (m: Map<string, { items: Map<string, PublicLootItem> }>) => {
        let n = 0;
        for (const c of m.values()) for (const it of c.items.values()) if (it.catalogId === 'item:flare') n++;
        return n;
      };
      let withFlares = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const off = generateRoomContainersAndLoot(room.world, seed, 'r', 1);
        assert.equal(countFlares(off), 0, `seed ${seed}: raketasiz generatsiyada raketa yo'q`);
        const offExplicit = generateRoomContainersAndLoot(room.world, seed, 'r', 1, { flares: false });
        assert.equal(countFlares(offExplicit), 0);
        const on = generateRoomContainersAndLoot(room.world, seed, 'r', 1, { flares: true });
        withFlares += countFlares(on);
        // Raketa faqat uchinchi slotda, qurol+o'q juftligi buzilmaydi
        for (const c of on.values()) {
          const items = [...c.items.values()];
          items.forEach((it, i) => {
            if (it.catalogId === 'item:flare') assert.equal(i, 2);
          });
          if (items[0]?.kind === 'weapon') assert.equal(items[1]?.ammoWeapon, items[0].weaponId);
        }
      }
      assert.ok(withFlares >= 1, `40 seed ichida kamida bitta raketa (${withFlares})`);
      // Raketasiz generatsiya deterministik — avvalgi rejimlar o'zgarmagan (seed 7 uchun id/kataloglar bir xil)
      const a = [...generateRoomContainersAndLoot(room.world, 7, 'r', 1).values()].map((c) => [...c.items.values()].map((it) => it.catalogId).join(','));
      const b = [...generateRoomContainersAndLoot(room.world, 7, 'r', 1, { flares: false }).values()].map((c) => [...c.items.values()].map((it) => it.catalogId).join(','));
      assert.deepEqual(a, b);
    } finally {
      room.destroy();
    }
  });

  it("6. Bot yordam yukini ochib raketa oladi va bo'ri yaqinlashganda otadi (botUseFlare); raketa doirasida bo'ri nishon olmaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io, { bots: 1 });
    try {
      const { p } = startSoloNight(room);
      const bot = [...room.players.values()].find((x) => x.isBot)!;
      assert.ok(bot, 'bot bor');
      const { supply } = reachSupplyDrop(room, p);
      const pub = room.loot.getPublicContainerState(supply.id)!;
      // Bot konteyner oldida: ochadi va raketa oladi (odam bilan bir xil tekshiruvlar)
      standAtContainer(room, bot, { x: pub.position.x, y: pub.position.y, z: pub.position.z, yaw: pub.yaw });
      bot.hp = MAX_HP;
      const open = room.botOpenContainer(bot, supply.id);
      assert.ok(open.ok, `bot ochdi: ${open.code ?? ''}`);
      const flare = open.container!.items.find((it) => it.kind === 'flare')!;
      // Bot 2 daqiqa davomida o'z loot AI si bilan oddiy konteynerdan raketa topgan bo'lishi mumkin
      // (secretLootSeed tasodifiy) — shuning uchun nisbiy tekshiruv
      const hadFlares = room.loot.getFlareCount(bot.id);
      if (hadFlares < 2) {
        const got = room.botPickupItem(bot, supply.id, flare.id);
        assert.ok(got.ok, got.code ?? '');
        assert.equal(room.loot.getFlareCount(bot.id), hadFlares + 1);
      } else {
        assert.equal(room.botPickupItem(bot, supply.id, flare.id).code, 'FLARES_FULL');
      }
      const have = room.loot.getFlareCount(bot.id);
      assert.ok(have >= 1);

      // Bo'ri botni ovlab yaqinlashdi — bot raketa otadi
      const anchor = groundAt(room, pub.position.x, pub.position.z);
      const wolfPos = openPointFrom(room, anchor, 12);
      const w = firstWolf(room);
      w.pos = { ...wolfPos };
      w.vel = { x: 0, y: 0, z: 0 };
      w.brain.onDamaged(bot, room.now());
      const before = emitted.length;
      const ack = room.botUseFlare(bot);
      assert.equal(ack.ok, true, ack.error ?? '');
      assert.equal(room.loot.getFlareCount(bot.id), have - 1);
      assert.equal(ack.flares, have - 1);
      assert.equal(w.state, 'flee');
      const ev = emitted.slice(before).find((e) => e.event === 'night:flare')?.payload as NightFlareEvent | undefined;
      assert.equal(ev?.byId, bot.id);
      // Doira ichidagi odam ham nishon bo'lmaydi
      p.pos = { ...anchor };
      assert.equal(room.isWolfPreyExposed(p), false);
      assert.equal(room.isWolfPreyExposed(bot), false);
    } finally {
      room.destroy();
    }
  });

  it('7. compassDirUz: 8 sektor (shimol = -Z, sharq = +X)', () => {
    assert.equal(compassDirUz(0, -10), 'shimol');
    assert.equal(compassDirUz(10, 0), 'sharq');
    assert.equal(compassDirUz(0, 10), 'janub');
    assert.equal(compassDirUz(-10, 0), "g'arb");
    assert.equal(compassDirUz(10, -10), 'shimoli-sharq');
    assert.equal(compassDirUz(10, 10), 'janubi-sharq');
    assert.equal(compassDirUz(-10, 10), "janubi-g'arb");
    assert.equal(compassDirUz(-10, -10), "shimoli-g'arb");
  });
});
