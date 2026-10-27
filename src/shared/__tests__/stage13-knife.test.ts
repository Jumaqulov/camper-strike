import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';
import { EYE_HEIGHT, MAX_HP } from '../constants';
import { vnorm, vsub, type Vec3 } from '../math';
import type { KillEvent, ShotEvent } from '../protocol';
import { ALL_WEAPON_IDS, KNIFE_BACKSTAB_MUL, WEAPONS, emptyAmmo, fullAmmo, isMeleeWeapon, isWeaponId } from '../weapons';
import { getForestSquarePoiSites } from '../forestSquare';
import { sampleTerrainHeight } from '../world';

interface Emitted {
  event: string;
  payload: unknown;
}

function createFakeIo(): { io: Server; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const io = {
    to() {
      const emitFn = (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      };
      return { emit: emitFn, volatile: { emit: emitFn } };
    },
  } as unknown as Server;
  return { io, emitted };
}

function createFakeSocket(id: string, emitted: Emitted[]): Socket {
  return {
    id,
    join() {},
    leave() {},
    emit(event: string, payload: unknown) {
      emitted.push({ event: `sock:${id}:${event}`, payload });
    },
    to() {
      return {
        emit(event: string, payload: unknown) {
          emitted.push({ event, payload });
        },
      };
    },
  } as unknown as Socket;
}

/** Hujumchini qurbon oldida (yoki orqasida) `dist` metr masofaga qo'yadi va nishonga qaratadi. */
function placeDuel(
  room: Room,
  attackerId: string,
  victimId: string,
  dist: number,
  victimFacesAttacker: boolean,
  aimHeight = 1.0,
): { origin: Vec3; dir: Vec3 } {
  const a = room.players.get(attackerId)!;
  const v = room.players.get(victimId)!;
  const site = getForestSquarePoiSites(6501).find((s) => s.id === 'poi_service_station')!;
  const vx = site.center.x - 6;
  const vz = site.center.z + 6;
  v.pos = { x: vx, y: sampleTerrainHeight(room.world.terrain, vx, vz), z: vz };
  // Hujumchi qurbonning −Z tomonida (yoki +Z) turadi
  const ax = vx;
  const az = vz + dist;
  a.pos = { x: ax, y: sampleTerrainHeight(room.world.terrain, ax, az), z: az };
  a.vel = { x: 0, y: 0, z: 0 };
  v.vel = { x: 0, y: 0, z: 0 };
  // Qurbon yaw: oldi (−sin yaw, −cos yaw). Hujumchi +Z tomonda → unga qarash uchun yaw = π; teskari → 0
  v.yaw = victimFacesAttacker ? Math.PI : 0;
  a.spawnTime = -99;
  v.spawnTime = -99;
  a.lastShot = -99;
  a.switchUntil = -1;
  const origin: Vec3 = { x: a.pos.x, y: a.pos.y + EYE_HEIGHT, z: a.pos.z };
  const target: Vec3 = { x: v.pos.x, y: v.pos.y + aimHeight, z: v.pos.z };
  const dir = vnorm(vsub(target, origin));
  a.yaw = Math.atan2(-dir.x, -dir.z);
  a.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  return { origin, dir };
}

function makeRoom(io: Server, mode: 'ffa' | 'forest_survival'): Room {
  return new Room(
    {
      name: 'Knife',
      mode,
      mapId: 'forest_square',
      bots: 0,
      maxPlayers: 8,
      timeLimit: 10,
      scoreLimit: 25,
      publicLayoutSeed: 6501,
      countdownSec: 2,
    },
    io,
    () => {},
  );
}

describe('Bosqich 13 — Pichoq (yaqin masofa quroli)', () => {
  it('1. Qurol ta’rifi: knife WeaponId, o‘qsiz, melee; ammo jadvallarida mavjud', () => {
    assert.ok(isWeaponId('knife'));
    assert.ok(ALL_WEAPON_IDS.includes('knife'));
    assert.ok(isMeleeWeapon('knife'));
    assert.ok(!isMeleeWeapon('rifle'));
    assert.equal(WEAPONS.knife.magSize, 0);
    assert.ok(WEAPONS.knife.range < 2);
    assert.deepEqual(fullAmmo().knife, { mag: 0, reserve: 0 });
    assert.deepEqual(emptyAmmo().knife, { mag: 0, reserve: 0 });
  });

  it('2. Klassik FFA: pichoq 1.2 m dan tanaga 45 zarar beradi, o‘q sarflamaydi, 2.5 m dan tegmaydi, orqadan ×2.2', () => {
    const { io, emitted } = createFakeIo();
    const room = makeRoom(io, 'ffa');
    try {
      room.addHuman(createFakeSocket('p1', emitted), 'Attacker');
      room.addHuman(createFakeSocket('p2', emitted), 'Victim');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.advanceTimeForTest(0.5, 0.25);
      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;
      p1.weapon = 'knife';
      const ammoBefore = JSON.stringify(p1.ammo);

      // Old tomondan, 1.2 m
      let d = placeDuel(room, 'p1', 'p2', 1.2, true);
      p2.hp = MAX_HP;
      room.onShoot('p1', { weapon: 'knife', origin: d.origin, dirs: [d.dir] });
      assert.equal(p2.hp, MAX_HP - WEAPONS.knife.damage, 'oldindan tana zarbasi 45');
      assert.equal(JSON.stringify(p1.ammo), ammoBefore, 'pichoq o‘q sarflamaydi');
      const shot = emitted.filter((e) => e.event === 'shot').map((e) => e.payload as ShotEvent).pop();
      assert.ok(shot && shot.weapon === 'knife' && shot.ends.length === 1, 'bitta zarba hodisasi yuboriladi');

      // Otish oralig'i: odamlar uchun 2 zarbalik zaxira (tarmoq jitteri) bor, uchinchi darhol zarba o'tmaydi
      p2.hp = MAX_HP;
      room.onShoot('p1', { weapon: 'knife', origin: d.origin, dirs: [d.dir] });
      room.onShoot('p1', { weapon: 'knife', origin: d.origin, dirs: [d.dir] });
      assert.ok(MAX_HP - p2.hp <= WEAPONS.knife.damage * 1, 'fireInterval ichida ko‘pi bilan bitta qo‘shimcha zarba');

      // 2.5 m — yetmaydi
      d = placeDuel(room, 'p1', 'p2', 2.5, true);
      p2.hp = MAX_HP;
      room.onShoot('p1', { weapon: 'knife', origin: d.origin, dirs: [d.dir] });
      assert.equal(p2.hp, MAX_HP, '2.5 m dan pichoq tegmaydi');

      // Orqadan: qurbon teskari qaragan
      d = placeDuel(room, 'p1', 'p2', 1.2, false);
      p2.hp = MAX_HP;
      room.onShoot('p1', { weapon: 'knife', origin: d.origin, dirs: [d.dir] });
      const expectedBack = Math.round(WEAPONS.knife.damage * KNIFE_BACKSTAB_MUL);
      assert.equal(p2.hp, MAX_HP - expectedBack, `orqadan zarba ${expectedBack}`);

      // Orqadan ikkinchi zarba — halok, kill hodisasida qurol 'knife', pichoq yerga tushmaydi
      d = placeDuel(room, 'p1', 'p2', 1.2, false);
      room.onShoot('p1', { weapon: 'knife', origin: d.origin, dirs: [d.dir] });
      assert.equal(p2.alive, false);
      const kill = emitted.filter((e) => e.event === 'kill').map((e) => e.payload as KillEvent).pop();
      assert.ok(kill && kill.weapon === 'knife' && kill.killer === 'p1');
      assert.equal(room.loot.getPublicLootSnapshot().groundItems.length, 0);
    } finally {
      room.destroy();
    }
  });

  it('3. Survival (loot) rejimi: pichoq inventarsiz ham ruxsat etilgan, qurol tushganda yerga pichoq tushmaydi', () => {
    const { io, emitted } = createFakeIo();
    const room = makeRoom(io, 'forest_survival');
    try {
      room.addHuman(createFakeSocket('p1', emitted), 'A');
      room.addHuman(createFakeSocket('p2', emitted), 'B');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');
      assert.ok(room.loot.canPlayerUseWeapon('p1', 'knife'), 'pichoq doim ishlatiladi');
      assert.ok(!room.loot.canPlayerUseWeapon('p1', 'rifle'), 'o‘qotar qurol inventarsiz ishlatilmaydi');

      const ack = room.onEquipWeapon('p1', { requestId: 'eq_knife', weapon: 'knife', roundId: room.getRoundId(), spawnId: room.players.get('p1')!.spawnId });
      assert.equal(ack.ok, true, `pichoqni qo‘lga olish: ${ack.code}`);
      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;
      assert.equal(p1.weapon, 'knife');

      const d = placeDuel(room, 'p1', 'p2', 1.1, true);
      p2.hp = 30;
      room.onShoot('p1', { weapon: 'knife', origin: d.origin, dirs: [d.dir] });
      assert.equal(p2.alive, false, 'pichoq bilan eliminatsiya');
      assert.equal(room.loot.getPublicLootSnapshot().groundItems.length, 0, 'qurbon qurolsiz edi — hech narsa tushmaydi');
      assert.equal(room.loot.dropWeaponOnDeath('p1', 'knife', p1.pos, p1.yaw), null, 'pichoq hech qachon yerga tushmaydi');
    } finally {
      room.destroy();
    }
  });
});
