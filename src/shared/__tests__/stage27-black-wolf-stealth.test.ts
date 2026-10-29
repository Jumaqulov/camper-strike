import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room, type ServerPlayer } from '../../server/room';
import type { ServerWolf } from '../../server/wolf';
import type { CreateRoomOpts } from '../protocol';
import {
  WOLF_COAT_BLACK,
  WOLF_COAT_CHARCOAL,
  WOLF_COAT_RED,
  WOLF_COAT_TAN,
  WOLF_COAT_WHITE,
  WOLF_STEALTH_NOTICE_MUL,
  wolfCoatTraits,
  wolfNoticeRange,
} from '../wolf';

// Bosqich 27 — "Tun soyasi" (qora bo'ri) qorong'ida yaxshi yashirinadi: botlar uni tunda (wolf_night) qisqaroq
// masofadan sezadi (Room.nearestWolfThreat → wolfNoticeRange). Klassik (kunduzgi) rejimda va boshqa turlarda masofa
// o'zgarmaydi. Klient tomoni (ko'z, uvlash belgisi, panja tovushi) — client/game/__tests__/wolfStealth.test.ts.
// Xona haqiqiy Room (forest_square), io/socket soxta; bo'rilar to'g'ridan-to'g'ri joylashtiriladi (vaqt yurmaydi).

/** Botning bo'ri tahdidi radiusi (bot.ts handleWolfThreat: nearestWolfThreat(me, 22)). */
const BOT_WOLF_NOTICE_M = 22;

function createFakeIo(): Server {
  const emitFn = () => {};
  return {
    to() {
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

function makeRoom(mode: CreateRoomOpts['mode'], wolves: number): Room {
  return new Room(
    {
      name: 'Tun soyasi',
      mode,
      mapId: 'forest_square',
      bots: 0,
      maxPlayers: 8,
      timeLimit: 4,
      scoreLimit: mode === 'wolf_night' ? 1 : 25,
      publicLayoutSeed: 6501,
      countdownSec: 2,
      wolves,
    },
    createFakeIo(),
    () => {},
  );
}

/** Yakka odam tayyor bo'lib raundni boshlaydi (wolf_night: sanoq 2 s). */
function startSolo(room: Room): ServerPlayer {
  room.addHuman(createFakeSocket('p1'), 'Ovchi');
  room.onReady('p1', { world: room.worldMeta() });
  if (room.phase === 'countdown') room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  return room.players.get('p1')!;
}

/** Xonada aynan bitta tirik bo'ri: qolganlari o'chiriladi, shu bo'ri turi `coat` ga o'rnatiladi. */
function soleWolf(room: Room, coat: number): ServerWolf {
  if (room.wolves.size === 0) assert.ok(room.addWolf(), "bo'ri qo'shildi");
  const [w, ...rest] = [...room.wolves.values()];
  for (const o of rest) o.alive = false;
  room.setWolfCoatForTest(w!, coat);
  w!.alive = true;
  w!.state = 'idle';
  w!.targetId = null;
  return w!;
}

/** Bo'rini o'yinchidan +X tomonga `d` m ga qo'yadi (nearestWolfThreat faqat XZ masofaga qaraydi). */
function placeAt(w: ServerWolf, p: ServerPlayer, d: number): void {
  w.pos = { x: p.pos.x + d, y: p.pos.y, z: p.pos.z };
  w.vel = { x: 0, y: 0, z: 0 };
}

const ALL_COATS = [WOLF_COAT_CHARCOAL, WOLF_COAT_RED, WOLF_COAT_TAN, WOLF_COAT_BLACK, WOLF_COAT_WHITE];

describe("Bosqich 27 — 'Tun soyasi' botlardan yashirinadi", () => {
  it('1. wolfNoticeRange: tunda faqat soya qisqaradi (×WOLF_STEALTH_NOTICE_MUL), kunduzi hech kim', () => {
    assert.ok(WOLF_STEALTH_NOTICE_MUL > 0.4 && WOLF_STEALTH_NOTICE_MUL < 1, 'mo‘tadil ko‘paytuvchi');
    for (const c of ALL_COATS) {
      const night = wolfNoticeRange(c, BOT_WOLF_NOTICE_M, true);
      if (wolfCoatTraits(c).stealthy) assert.equal(night, BOT_WOLF_NOTICE_M * WOLF_STEALTH_NOTICE_MUL, `coat ${c}`);
      else assert.equal(night, BOT_WOLF_NOTICE_M, `coat ${c}`);
      assert.equal(wolfNoticeRange(c, BOT_WOLF_NOTICE_M, false), BOT_WOLF_NOTICE_M, `kunduzi coat ${c}`);
    }
    assert.equal(wolfCoatTraits(WOLF_COAT_BLACK).stealthy, true, 'qora bo‘ri — soya');
    // Noma'lum coat — oddiy bo'ri
    assert.equal(wolfNoticeRange(undefined, 14, true), 14);
    assert.equal(wolfNoticeRange(42, 14, true), 14);
  });

  it("2. wolf_night: 18 m dagi soyani bot sezmaydi (hatto ov qilsa ham), oddiy bo'rini sezadi", () => {
    const room = makeRoom('wolf_night', 0);
    try {
      const p = startSolo(room);
      const far = BOT_WOLF_NOTICE_M * WOLF_STEALTH_NOTICE_MUL + 5;
      assert.ok(far < BOT_WOLF_NOTICE_M);
      const w = soleWolf(room, WOLF_COAT_BLACK);
      placeAt(w, p, far);
      assert.equal(room.nearestWolfThreat(p, BOT_WOLF_NOTICE_M), null, 'sayrdagi soya sezilmaydi');
      w.state = 'hunt';
      w.targetId = p.id;
      assert.equal(room.nearestWolfThreat(p, BOT_WOLF_NOTICE_M), null, 'ovlayotgan soya ham uzoqdan sezilmaydi');

      room.setWolfCoatForTest(w, WOLF_COAT_CHARCOAL);
      assert.equal(room.nearestWolfThreat(p, BOT_WOLF_NOTICE_M), w, 'oddiy bo‘ri shu masofada seziladi');
      room.setWolfCoatForTest(w, WOLF_COAT_WHITE);
      assert.equal(room.nearestWolfThreat(p, BOT_WOLF_NOTICE_M), w, 'to‘da boshlig‘i ham seziladi');
    } finally {
      room.destroy();
    }
  });

  it('3. wolf_night: yaqinlashgan soya seziladi; yiqilgan sherik/yordam yuki tekshiruvi (14 m) ham qisqaradi', () => {
    const room = makeRoom('wolf_night', 0);
    try {
      const p = startSolo(room);
      const w = soleWolf(room, WOLF_COAT_BLACK);
      const near = BOT_WOLF_NOTICE_M * WOLF_STEALTH_NOTICE_MUL - 1;
      placeAt(w, p, near);
      assert.equal(room.nearestWolfThreat(p, BOT_WOLF_NOTICE_M), w, `${near.toFixed(1)} m dagi soya seziladi`);
      // bot.ts BOT_REVIVE_WOLF_CLEAR_M = 14: 10 m dagi soya "xavf yo'q" deb hisoblanadi, oddiy bo'ri — xavf
      placeAt(w, p, 10);
      assert.equal(room.nearestWolfThreat(p, 14), null);
      room.setWolfCoatForTest(w, WOLF_COAT_TAN);
      assert.equal(room.nearestWolfThreat(p, 14), w);
    } finally {
      room.destroy();
    }
  });

  it('4. Klassik (kunduzgi) rejim: qora bo‘ri odatdagi masofadan seziladi', () => {
    const room = makeRoom('ffa', 1);
    try {
      const p = startSolo(room);
      const w = soleWolf(room, WOLF_COAT_BLACK);
      placeAt(w, p, BOT_WOLF_NOTICE_M - 4);
      assert.equal(room.isNight, false);
      assert.equal(room.nearestWolfThreat(p, BOT_WOLF_NOTICE_M), w);
    } finally {
      room.destroy();
    }
  });
});
