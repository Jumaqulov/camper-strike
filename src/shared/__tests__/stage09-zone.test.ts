import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';
import { MAX_HP } from '../constants';
import type { KillEvent, MatchState } from '../protocol';
import {
  ZONE_FINAL_RADIUS_M,
  buildSurvivalZoneTimeline,
  evaluateSurvivalZone,
  formatZoneStatusUz,
  interpolateSurvivalZone,
  isOutsideSurvivalZone,
} from '../survival';

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

const HALF = 128;

describe('Bosqich 09 — Forest Survival xavfsiz zona torayishi', () => {
  it('1. Jadval deterministik: radiuslar kamayadi, har aylana avvalgisining ichida, oxirgi radius 14 m', () => {
    const a = buildSurvivalZoneTimeline(1234, 180, HALF);
    const b = buildSurvivalZoneTimeline(1234, 180, HALF);
    assert.deepEqual(a, b, 'bir xil seed — bir xil jadval');
    const c = buildSurvivalZoneTimeline(999, 180, HALF);
    assert.notDeepEqual(
      a.stages.slice(1).map((s) => [s.cx, s.cz]),
      c.stages.slice(1).map((s) => [s.cx, s.cz]),
      'boshqa seed — boshqa markazlar',
    );

    assert.equal(a.stages.length, 5);
    assert.ok(a.stages[0]!.radius >= HALF * Math.SQRT2, '0-bosqich butun xaritani qoplaydi');
    assert.equal(a.stages[0]!.cx, 0);
    assert.equal(a.stages[0]!.cz, 0);
    assert.equal(a.stages[a.stages.length - 1]!.radius, ZONE_FINAL_RADIUS_M);
    for (let i = 1; i < a.stages.length; i++) {
      const prev = a.stages[i - 1]!;
      const cur = a.stages[i]!;
      assert.ok(cur.radius < prev.radius, `radius kamayishi kerak (${i})`);
      assert.ok(cur.dps > prev.dps, `zarar oshishi kerak (${i})`);
      if (i >= 2) {
        const d = Math.hypot(cur.cx - prev.cx, cur.cz - prev.cz);
        assert.ok(d + cur.radius <= prev.radius + 1e-6, `yangi aylana avvalgisining ichida bo'lishi kerak (${i})`);
      }
      assert.ok(Math.abs(cur.cx) + cur.radius * 0.65 <= HALF + 1e-6, 'aylana asosan xarita ichida (x)');
      assert.ok(Math.abs(cur.cz) + cur.radius * 0.65 <= HALF + 1e-6, 'aylana asosan xarita ichida (z)');
    }
    // Barcha kutish + torayish vaqtlari raund davomiyligining 85% ini tashkil qiladi
    let total = 0;
    for (const s of a.stages) {
      if (Number.isFinite(s.holdSec)) total += s.holdSec;
      total += s.shrinkSec;
    }
    assert.ok(Math.abs(total - 180 * 0.85) < 1e-6, `jadval 0.85·D bo'lishi kerak (got ${total})`);
  });

  it('2. evaluateSurvivalZone: kutish → torayish → oxirgi aylana; interpolyatsiya maqsadga yetadi', () => {
    const tl = buildSurvivalZoneTimeline(42, 100, HALF);
    const s0 = tl.stages[0]!;
    const s1 = tl.stages[1]!;

    const atStart = evaluateSurvivalZone(tl, 0);
    assert.equal(atStart.radius, s0.radius);
    assert.equal(atStart.shrinking, false);
    assert.equal(atStart.stage, 0);
    assert.equal(atStart.stageCount, 4);
    assert.ok(Math.abs(atStart.nextChangeInSec - s0.holdSec) < 1e-9);
    assert.equal(atStart.targetRadius, s1.radius);
    assert.ok(!isOutsideSurvivalZone(atStart, HALF, HALF), 'boshida xarita burchagi ham zona ichida');

    const midShrink = evaluateSurvivalZone(tl, s0.holdSec + s0.shrinkSec / 2);
    assert.equal(midShrink.shrinking, true);
    assert.equal(midShrink.stage, 1);
    assert.ok(midShrink.radius < s0.radius && midShrink.radius > s1.radius, 'torayish o\'rtasida oraliq radius');
    assert.ok(Math.abs(midShrink.radius - (s0.radius + s1.radius) / 2) < 1e-6);
    assert.equal(midShrink.dps, s1.dps, 'torayish paytida yangi bosqich zarari');
    // Klient interpolyatsiyasi: qolgan vaqt o'tgach maqsad aylanaga yetadi
    const lerped = interpolateSurvivalZone(midShrink, midShrink.nextChangeInSec);
    assert.ok(Math.abs(lerped.radius - s1.radius) < 1e-6);
    assert.ok(Math.abs(lerped.cx - s1.cx) < 1e-6 && Math.abs(lerped.cz - s1.cz) < 1e-6);
    // Kutishda interpolyatsiya hech narsani o'zgartirmaydi
    const held = interpolateSurvivalZone(atStart, 5);
    assert.equal(held.radius, atStart.radius);

    const afterAll = evaluateSurvivalZone(tl, 90);
    assert.equal(afterAll.shrinking, false);
    assert.equal(afterAll.stage, 4);
    assert.equal(afterAll.radius, ZONE_FINAL_RADIUS_M);
    assert.ok(Math.abs(afterAll.nextChangeInSec - 10) < 1e-9, 'oxirgi bosqichda raund tugashigacha vaqt');
    assert.equal(formatZoneStatusUz(afterAll), 'Zona: oxirgi');
    assert.match(formatZoneStatusUz(atStart), /^Zona \d+:\d\d$/);
    assert.match(formatZoneStatusUz(midShrink), /^Zona torayapti \d+:\d\d$/);

    // Radius vaqt bo'yicha hech qachon oshmaydi
    let prevR = Infinity;
    for (let t = 0; t <= 100; t += 0.25) {
      const r = evaluateSurvivalZone(tl, t).radius;
      assert.ok(r <= prevR + 1e-9, `radius oshmasligi kerak (t=${t})`);
      prevR = r;
    }
  });

  it("3. Room: zonadan tashqaridagi o'yinchi zarar oladi va halok bo'ladi, ichkaridagi g'olib; match snapshotida zona bor", () => {
    const { io, emitted } = createFakeIo();
    const room = new Room(
      {
        name: 'Zone Room',
        mode: 'forest_survival',
        mapId: 'forest_square',
        bots: 0,
        maxPlayers: 8,
        timeLimit: 3,
        scoreLimit: 1,
        publicLayoutSeed: 6501,
        countdownSec: 2,
      },
      io,
      () => {},
    );
    try {
      const s1 = createFakeSocket('p1');
      const s2 = createFakeSocket('p2');
      room.addHuman(s1.socket, 'Inside');
      room.addHuman(s2.socket, 'Outside');
      room.onReady('p1', { world: room.worldMeta() });
      room.onReady('p2', { world: room.worldMeta() });
      assert.equal(room.getZoneSnap(), null, 'raund boshlanmaguncha zona yo\'q');
      room.advanceTimeForTest(2.5, 0.25);
      assert.equal(room.phase, 'playing');

      const start = room.getZoneSnap();
      assert.ok(start, 'raund boshlangach zona snapshoti bor');
      assert.equal(start.stage, 0);
      assert.equal(start.shrinking, false);

      const p1 = room.players.get('p1')!;
      const p2 = room.players.get('p2')!;
      // Butun xarita zona ichida — hech kim zarar olmaydi
      p1.pos = { x: 0, y: p1.pos.y, z: 0 };
      p2.pos = { x: HALF - 2, y: p2.pos.y, z: HALF - 2 };
      room.advanceTimeForTest(3, 0.25);
      assert.equal(p1.hp, MAX_HP);
      assert.equal(p2.hp, MAX_HP);

      // Oxirgi bosqichga o'tamiz (0.85·180 = 153 s dan keyin); oraliq bosqichlarda ikkalasini
      // keyingi maqsad aylana markazida ushlab turamiz — hech kim zarar olmasligi kerak
      for (let i = 0; i < 78; i++) {
        const z = room.getZoneSnap()!;
        p1.pos = { x: z.targetCx, y: p1.pos.y, z: z.targetCz };
        p2.pos = { x: z.targetCx, y: p2.pos.y, z: z.targetCz };
        room.advanceTimeForTest(2, 0.5);
      }
      assert.equal(p1.hp, MAX_HP, "markazda turgan o'yinchi zarar olmaydi");
      assert.equal(p2.hp, MAX_HP);
      assert.equal(room.phase, 'playing', 'hali raund davom etmoqda');
      const zone = room.getZoneSnap();
      assert.ok(zone);
      assert.equal(zone.stage, zone.stageCount);
      assert.equal(zone.radius, ZONE_FINAL_RADIUS_M);
      const matchEvents = emitted.filter((e) => e.event === 'match').map((e) => e.payload as MatchState);
      const lastMatch = matchEvents[matchEvents.length - 1]!;
      assert.ok(lastMatch.survival?.zone, 'match snapshotida zona bor');
      assert.equal(lastMatch.survival!.zone!.radius, ZONE_FINAL_RADIUS_M);

      p1.pos = { x: zone.cx, y: p1.pos.y, z: zone.cz };
      p1.hp = MAX_HP;
      p2.hp = MAX_HP;
      // p2 — aylanadan 30 m tashqarida (xarita ichida qolishi uchun markazdan teskari tomonga)
      const dirX = zone.cx >= 0 ? -1 : 1;
      p2.pos = { x: zone.cx + dirX * (ZONE_FINAL_RADIUS_M + 30), y: p2.pos.y, z: zone.cz };
      p1.spawnTime = -99;
      p2.spawnTime = -99;

      const hurtBefore = s2.events.filter((e) => e.event === 'hurt').length;
      room.advanceTimeForTest(1.0, 1 / 30);
      assert.equal(p1.hp, MAX_HP, 'ichkaridagi o\'yinchi zarar olmaydi');
      assert.ok(p2.hp < MAX_HP, 'tashqaridagi o\'yinchi zarar oladi');
      const lostIn1s = MAX_HP - p2.hp;
      assert.ok(Math.abs(lostIn1s - zone.dps) <= Math.ceil(zone.dps * 0.5) + 1, `~${zone.dps} hp/s yo'qotishi kerak (got ${lostIn1s})`);
      const hurtEvents = s2.events.filter((e) => e.event === 'hurt').slice(hurtBefore);
      assert.ok(hurtEvents.length >= 1, 'hurt hodisasi yuboriladi');
      const hurt = hurtEvents[0]!.payload as { attacker: string; from: { x: number; z: number } };
      assert.equal(hurt.attacker, '', 'zona zararida hujumchi yo\'q');
      assert.ok(Math.abs(hurt.from.x - zone.cx) < 1e-6, 'zarar yo\'nalishi zona markazini ko\'rsatadi');

      // Zirh zona zararini yutmaydi
      p2.armor = 100;
      const hpBeforeArmor = p2.hp;
      room.advanceTimeForTest(1.0, 1 / 30);
      assert.equal(p2.armor, 100, 'zirh zona zararidan yemirilmaydi');
      assert.ok(hpBeforeArmor - p2.hp >= zone.dps - 1, 'zirh zona zararini kamaytirmaydi');

      // Tashqarida qolaversa halok bo'ladi, ichkaridagi g'olib
      room.advanceTimeForTest(12, 1 / 30);
      assert.equal(p2.alive, false, 'zonadan tashqarida qolgan o\'yinchi halok bo\'ladi');
      assert.equal(p1.alive, true);
      const kills = emitted.filter((e) => e.event === 'kill').map((e) => e.payload as KillEvent);
      const zoneKill = kills.find((k) => k.victim === 'p2');
      assert.ok(zoneKill, 'kill hodisasi yuboriladi');
      assert.equal(zoneKill.weapon, 'zone');
      assert.equal(zoneKill.killer, 'p2', 'zona o\'limi — qotil qurbonning o\'zi');
      assert.equal(p2.kills, 0, 'zona o\'limi uchun kills kamaytirilmaydi');
      assert.equal(room.phase, 'ended');
      assert.equal(room.survival!.getWinnerId(), 'p1');
      assert.equal(room.survival!.getWinReason(), 'last_standing');
      assert.equal(room.getZoneSnap(), null, 'raund tugagach zona snapshoti null');
    } finally {
      room.destroy();
    }
  });
});
