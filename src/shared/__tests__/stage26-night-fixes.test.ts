import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import { MAX_HP } from '../constants';
import { q3, type Vec3 } from '../math';
import { collidesAtWorld, raycastWorld } from '../physics';
import type { CreateRoomOpts } from '../protocol';
import type { BuildingPrefabPlacement, ForestSquarePoiId } from '../structures/contracts';
import { sampleTerrainHeight } from '../world';
import { CAMPFIRE_RADIUS_M, NIGHT_CAMPFIRE_COUNT, WOLF_BITE_RANGE, type WolfBiteEvent, type WolfState } from '../wolf';

// Bosqich 26 — Tong otguncha: o'yin sinovidagi ikki xato. (1) Har lagerda ikki gulxan: xarita bezagi (campfire_pit_01
// tosh halqa + olov) va tun gulxani bir-biridan 6 m da yonardi — endi tun gulxani aynan bezak o'choq ustida yonadi
// (klient tunda bezak o'choqni yashiradi). (2) Bo'ri devor orqali tishlardi — endi tishlash uchun og'izdan nishon
// ko'kragi va oyog'igacha to'siqsiz chiziq kerak (Room.wolfCanReach); yetib bo'lmas nishon yonida uvlaydi, aylanadi.
// Xona haqiqiy Room (forest_square), io/socket soxta; vaqt room.advanceTimeForTest bilan deterministik.

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

/** Yakka odam tayyor bo'lib raundni boshlaydi (sanoq 2 s); tug'ilish himoyasi o'chiriladi. */
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

function startDuoNight(room: Room): { p1: ServerPlayer; p2: ServerPlayer } {
  room.addHuman(createFakeSocket('p1'), 'Ovchi');
  room.addHuman(createFakeSocket('p2'), 'Sherik');
  room.onReady('p1', { world: room.worldMeta() });
  room.onReady('p2', { world: room.worldMeta() });
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  return { p1: room.players.get('p1')!, p2: room.players.get('p2')! };
}

function groundAt(room: Room, x: number, z: number): Vec3 {
  return { x, y: sampleTerrainHeight(room.world.terrain, x, z), z };
}

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
  w.onGround = true;
  if (lookAt) w.yaw = Math.atan2(-(lookAt.x - pos.x), -(lookAt.z - pos.z));
}

const distXZ = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Ochiq joy: yonib turgan gulxanlardan ≥ radius+6 m uzoqdagi sayr tuguni (o'lja) va undan `gap` m naridagi
 * to'siqsiz, tekis nuqta (bo'ri). Deterministik: roamList tartibida birinchi mos juftlik.
 */
function findOpenPair(room: Room, gap: number): { prey: Vec3; wolf: Vec3 } {
  const nav = room.nav;
  const fires = [...room.campfires.values()].filter((f) => f.lit);
  const list = nav.roamList.length ? nav.roamList : nav.validList;
  for (const ni of list) {
    const c = nav.center(ni);
    if (fires.some((f) => distXZ(f, c) < CAMPFIRE_RADIUS_M + 6)) continue;
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const bx = c.x + Math.cos(ang) * gap;
      const bz = c.z + Math.sin(ang) * gap;
      const b = groundAt(room, bx, bz);
      if (Math.abs(b.y - c.y) > 0.4) continue;
      if (nav.nearest(b) < 0 || !nav.segmentClear(c, b)) continue;
      if (collidesAtWorld(room.world, b.x, b.y + 0.05, b.z)) continue;
      return { prey: c, wolf: b };
    }
  }
  throw new Error("ochiq joy topilmadi");
}

interface WallPair {
  building: BuildingPrefabPlacement;
  /** Uy ichida, devordan 0.7 m ichkarida turgan o'yinchi oyoq nuqtasi. */
  inside: Vec3;
  /** Devorning narigi tomonida, tashqarida turgan bo'ri oyoq nuqtasi. */
  outside: Vec3;
}

/**
 * Haqiqiy forest_square dunyosida: uy ichidagi (pol ustida, bo'sh) nuqta — yon devordan 0.7 m ichkarida — va
 * devorning narigi tomonidagi bo'sh tashqi nuqta (1.6 m dan yaqin). Ichki nuqta yonib turgan gulxandan uzoq
 * (olov himoyasi natijaga ta'sir qilmasin) va tashqaridan hech qayerdan (4–8 m halqa, 36 burchak) bo'ri uni
 * tishlay olmaydigan (wolfCanReach yolg'on) bo'lishi kerak — eshik orqali ko'rinmaydigan burchak.
 */
function findWallPair(room: Room): WallPair {
  const world = room.world;
  const buildings = world.stage04aLayout?.buildings ?? [];
  assert.ok(buildings.length > 0, 'forest_square da uylar bor');
  const fires = [...room.campfires.values()];
  const probe = (pos: Vec3): ServerPlayer => ({ pos, crouched: false }) as unknown as ServerPlayer;
  for (const b of buildings) {
    const cos = Math.cos(b.rotationY || 0);
    const sin = Math.sin(b.rotationY || 0);
    const hw = b.gridWidthM * 0.5;
    const hd = b.gridDepthM * 0.5;
    // Markaz (lokal +x/+z yarim o'lchamlar burilgan)
    const cx = b.origin.x + hw * cos + hd * sin;
    const cz = b.origin.z - hw * sin + hd * cos;
    if (fires.some((f) => Math.hypot(f.x - cx, f.z - cz) < CAMPFIRE_RADIUS_M + 6)) continue;
    // Lokal o'qlar: ux — kenglik bo'ylab, uz — chuqurlik bo'ylab; devor yo'nalishlari
    const ux = { x: cos, z: -sin };
    const uz = { x: sin, z: cos };
    const dirs = [ux, { x: -ux.x, z: -ux.z }, uz, { x: -uz.x, z: -uz.z }];
    // Uy ichi to'ri (0.25 m): bo'sh (mebel/zina bilan to'qnashmaydigan) nuqtalar, devordan ≤ 0.9 m
    for (let lx = -hw + 0.5; lx <= hw - 0.5 + 1e-6; lx += 0.25) {
      for (let lz = -hd + 0.5; lz <= hd - 0.5 + 1e-6; lz += 0.25) {
        const ix = cx + ux.x * lx + uz.x * lz;
        const iz = cz + ux.z * lx + uz.z * lz;
        const inside = { x: ix, y: b.floorY, z: iz };
        if (collidesAtWorld(world, ix, b.floorY + 0.05, iz)) continue;
        for (const dir of dirs) {
          const hit = raycastWorld(world, { x: ix, y: b.floorY + 1.0, z: iz }, { x: dir.x, y: 0, z: dir.z }, 0.9);
          if (!hit || hit.kind !== 'collider' || !/wall/.test(hit.colliderId ?? '')) continue;
          const hp = hit.point;
          let outside: Vec3 | null = null;
          for (let s = 0.3; s <= 1.2 && !outside; s += 0.1) {
            const ox = hp.x + dir.x * s;
            const oz = hp.z + dir.z * s;
            const oy = sampleTerrainHeight(world.terrain, ox, oz);
            if (collidesAtWorld(world, ox, oy + 0.05, oz)) continue;
            if (distXZ({ x: ox, z: oz }, inside) > 1.6) break;
            outside = { x: ox, y: oy, z: oz };
          }
          if (!outside) continue;
          // Tashqaridan hech qayerdan tishlab bo'lmasin (eshik chizig'ida emas)
          let exposed = false;
          for (let r = 4; r <= 8 && !exposed; r += 2) {
            for (let k = 0; k < 36 && !exposed; k++) {
              const ang = (k / 36) * Math.PI * 2;
              const sx = ix + Math.cos(ang) * r;
              const sz = iz + Math.sin(ang) * r;
              const sp = { x: sx, y: sampleTerrainHeight(world.terrain, sx, sz), z: sz };
              if (room.wolfCanReach({ pos: sp }, probe(inside))) exposed = true;
            }
          }
          if (exposed) continue;
          return { building: b, inside, outside };
        }
      }
    }
  }
  throw new Error("uy ichida yashirin nuqta topilmadi");
}

describe("Bosqich 26 — Tong otguncha: bitta gulxan va devor orqali tishlamaslik", () => {
  it('1. Tun gulxanlari bezak o\'choq (campfire_pit_01) ustida: 3 ta, aynan o\'choq nuqtasida, ≥ 60 m oraliq', () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const placements = room.world.stage04aLayout?.outdoorPlacements ?? [];
      const pits = placements.filter((o) => o.assetId === 'campfire_pit_01');
      assert.equal(pits.length, 3, 'xaritada 3 ta bezak o\'choq');
      const fires = [...room.campfires.values()];
      assert.equal(fires.length, NIGHT_CAMPFIRE_COUNT);
      const expectSites: ForestSquarePoiId[] = ['poi_cabin_cluster', 'poi_cliff_watch', 'poi_forest_camp'];
      for (const site of expectSites) {
        const pit = pits.find((o) => o.siteId === site)!;
        assert.ok(pit, `${site} da o'choq bor`);
        const f = fires.find((c) => Math.abs(c.x - pit.position.x) < 1e-6 && Math.abs(c.z - pit.position.z) < 1e-6);
        assert.ok(f, `${site} o'chog'i ustida tun gulxani bor`);
        assert.equal(f!.y, q3(sampleTerrainHeight(room.world.terrain, pit.position.x, pit.position.z)), 'y — relyef');
        assert.equal(f!.main, site === 'poi_cabin_cluster', 'asosiy gulxan — uylar guruhi hovlisi');
      }
      for (let i = 0; i < fires.length; i++) {
        for (let j = i + 1; j < fires.length; j++) {
          assert.ok(distXZ(fires[i]!, fires[j]!) >= 60, `gulxanlar oralig'i ≥ 60 m (${fires[i]!.id}–${fires[j]!.id})`);
        }
      }
      // Tug'ilish halqasi o'choq va o'rindiqlar bilan to'qnashmaydi
      const { p1, p2 } = startDuoNight(room);
      const main = room.mainCampfire()!;
      for (const p of [p1, p2]) {
        assert.ok(p.alive);
        assert.ok(!collidesAtWorld(room.world, p.pos.x, p.pos.y + 0.05, p.pos.z), `${p.id} bo'sh joyda tug'ildi`);
        const d = distXZ(p.pos, main);
        assert.ok(d >= 2.5 && d <= 6, `${p.id} asosiy gulxan halqasida (${d.toFixed(2)} m)`);
      }
    } finally {
      room.destroy();
    }
  });

  it('3. Room.wolfCanReach: ochiq joyda — rost; uy devori orasida — yolg\'on', () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const p = startSoloNight(room);
      const { prey, wolf: wolfPos } = findOpenPair(room, 1.5);
      p.pos = { ...prey };
      assert.equal(room.wolfCanReach({ pos: wolfPos }, p), true, 'ochiq joyda yetadi');
      const pair = findWallPair(room);
      p.pos = { ...pair.inside };
      assert.ok(distXZ(pair.inside, pair.outside) < WOLF_BITE_RANGE, 'devor orasidagi masofa tishlash masofasidan kichik');
      assert.equal(room.wolfCanReach({ pos: pair.outside }, p), false, 'devor orqali yetmaydi');
      // Tishlash o'zi ham to'siqni tekshiradi: devor ortidan zarar yo'q, hodisa hit=false
      const [w] = ensureWolves(room, 1);
      placeWolf(w!, pair.outside, pair.inside);
      const hp0 = p.hp;
      room.wolfBite(w!, p);
      assert.equal(p.hp, hp0, 'devor orqali tishlash zarar bermaydi');
      // Ochiq joyda tishlash zarar beradi
      p.pos = { ...prey };
      placeWolf(w!, wolfPos, prey);
      room.wolfBite(w!, p);
      assert.ok(p.hp < hp0, 'ochiq joyda tishlash zarar beradi');
    } finally {
      room.destroy();
    }
  });

  it("2. O'yinchi uy ichida, bo'ri devor ortida (< 1.6 m): 12 s zarar yo'q, 'attack' yo'q, bo'ri devorga yopishib qolmaydi", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const p = startSoloNight(room);
      const pair = findWallPair(room);
      p.pos = { ...pair.inside };
      p.vel = { x: 0, y: 0, z: 0 };
      const [w] = ensureWolves(room, 1);
      placeWolf(w!, pair.outside, pair.inside);
      const start = { ...w!.pos };
      room.pack.report(w!, p, room.now());
      assert.ok(distXZ(pair.inside, pair.outside) < 1.6);

      let damaged = false;
      let attacked = false;
      const states = new Set<WolfState>();
      let left = 12;
      const step = 1 / 30;
      while (left > 1e-6 && room.phase === 'playing') {
        const d = Math.min(step, left);
        room.advanceTimeForTest(d, step);
        if (p.hp < MAX_HP || !p.alive || p.downed) damaged = true;
        p.hp = MAX_HP;
        p.pos = { ...pair.inside };
        p.vel = { x: 0, y: 0, z: 0 };
        if (w!.state === 'attack') attacked = true;
        states.add(w!.state);
        left -= d;
      }
      assert.equal(room.preyFearSource(p), null, "o'yinchi olov himoyasida emas (sinov ma'nosi)");
      assert.equal(w!.targetId, 'p1', "bo'ri o'yinchini nishon qilgan (hidi bor)");
      assert.equal(damaged, false, 'devor orqali zarar yo\'q');
      assert.equal(attacked, false, "'attack' holati bo'lmadi");
      const bitesHit = emitted.filter((e) => e.event === 'wolf:bite' && (e.payload as WolfBiteEvent).hit);
      assert.equal(bitesHit.length, 0, 'tishlash hodisasi (hit) yo\'q');
      assert.ok(
        w!.state === 'alert' || w!.state === 'howl' || w!.state === 'idle' || w!.state === 'stalk',
        `yakuniy holat kutish/uvlash (${w!.state}; ko'rilgan: ${[...states].join(',')})`,
      );
      const moved = distXZ(w!.pos, start);
      assert.ok(moved >= 1 || w!.state === 'howl' || w!.state === 'alert', `devorga yopishib qolmadi (${moved.toFixed(2)} m)`);
      assert.equal(w!.brain.walled, true, "bo'ri nishonni devor ortida deb biladi");
      assert.equal(room.pack.isUnreachable('p1'), true, "to'da koordinatori nishonni yetib bo'lmas deb belgilagan (jarima)");
    } finally {
      room.destroy();
    }
  });

  it("4. Regressiya: ochiq joyda bo'ri bir necha soniyada tishlaydi", () => {
    const { io } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const p = startSoloNight(room);
      const { prey, wolf: wolfPos } = findOpenPair(room, 4);
      p.pos = { ...prey };
      const [w] = ensureWolves(room, 1);
      placeWolf(w!, wolfPos, prey);
      room.pack.report(w!, p, room.now());
      let bitAt = -1;
      let left = 10;
      const step = 1 / 30;
      const t0 = room.now();
      while (left > 1e-6 && room.phase === 'playing' && bitAt < 0) {
        const d = Math.min(step, left);
        room.advanceTimeForTest(d, step);
        if (p.hp < MAX_HP) bitAt = room.now() - t0;
        p.hp = MAX_HP;
        p.pos = { ...prey };
        p.vel = { x: 0, y: 0, z: 0 };
        left -= d;
      }
      assert.ok(bitAt >= 0 && bitAt <= 10, `ochiq joyda tishladi (${bitAt.toFixed(2)} s)`);
    } finally {
      room.destroy();
    }
  });
});
