import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { Room } from '../../server/room';
import { MATCH_END_DURATION, MAX_HP } from '../constants';
import type { Vec3 } from '../math';
import type { ChatMsg, CreateRoomOpts, MatchState } from '../protocol';
import {
  NIGHT_DAWN_EPILOGUE_SEC,
  NIGHT_STAR_KINDS,
  NIGHT_STAR_TITLES_UZ,
  computeNightStars,
  computeNightSummary,
  countNightStars,
  formatNightStarsChatUz,
  type NightPlayerStats,
  type NightRoundFacts,
  type NightStar,
} from '../wolf';

// Stage 24 — "Tong otguncha" natija yulduzlari: computeNightStars mantig'i (sof) va xona darajasida
// asosiy gulxan o'chishlari hisobi + yakun holatida nightSummary.stars va chat qatori.

const mk = (id: string, o: Partial<NightPlayerStats> = {}): NightPlayerStats => ({
  id,
  name: id.toUpperCase(),
  isBot: false,
  wolfKills: 0,
  alphaKills: 0,
  wolfDamage: 0,
  logsFed: 0,
  relights: 0,
  survived: false,
  revives: 0,
  downs: 0,
  ...o,
});

const facts = (o: Partial<NightRoundFacts> = {}): NightRoundFacts => ({
  mainFireOuts: 0,
  startedContenderIds: ['a', 'b'],
  elapsedSec: 300,
  ...o,
});

const earnedKinds = (stars: readonly NightStar[]) => stars.filter((s) => s.earned).map((s) => s.kind);

describe('Stage 24 — computeNightStars (sof)', () => {
  it('1. Uchalasi ham olinadi: tong otdi, hamma tirik, asosiy gulxan o‘chmadi, boshliq o‘ldirildi; tartib NIGHT_STAR_KINDS', () => {
    const stars = computeNightStars([mk('a', { survived: true, alphaKills: 1 }), mk('b', { survived: true })], true, facts());
    assert.deepEqual(
      stars.map((s) => s.kind),
      [...NIGHT_STAR_KINDS],
    );
    assert.deepEqual(earnedKinds(stars), ['all_alive', 'fire_kept', 'alpha_slain']);
    assert.equal(countNightStars(stars), 3);
    // computeNightSummary ham shu yulduzlarni qo'yadi
    const sum = computeNightSummary([mk('a', { survived: true, alphaKills: 1 }), mk('b', { survived: true })], 'normal', true, facts());
    assert.deepEqual(sum.stars, stars);
  });

  it('2. Asosiy gulxan o‘chdi → fire_kept yo‘q; boshliq o‘ldirilmadi → alpha_slain yo‘q (yig‘indi hisoblanadi)', () => {
    const stars = computeNightStars([mk('a', { survived: true }), mk('b', { survived: true })], true, facts({ mainFireOuts: 1 }));
    assert.deepEqual(earnedKinds(stars), ['all_alive']);
    // Boshliq ikki o'yinchi orasida yig'indisi ≥ 1
    const two = computeNightStars([mk('a', { survived: true, alphaKills: 0 }), mk('b', { survived: true, alphaKills: 2 })], true, facts());
    assert.ok(two.find((s) => s.kind === 'alpha_slain')!.earned);
  });

  it('3. Kimdir o‘lib tirilmadi → all_alive yo‘q; qaytib tirilgan (survived) — tirik hisoblanadi', () => {
    const dead = computeNightStars([mk('a', { survived: true }), mk('b', { survived: false, downs: 1 })], true, facts());
    assert.deepEqual(earnedKinds(dead), ['fire_kept']);
    // Yiqilgan/qayta tirilgan, lekin tongda tirik — survived true bo'lib keladi
    const back = computeNightStars([mk('a', { survived: true }), mk('b', { survived: true, downs: 2 })], true, facts());
    assert.ok(back.find((s) => s.kind === 'all_alive')!.earned);
    // Raundni boshlagan, lekin statistikasi yo'q (bo'lmasligi kerak) — tirik deb olinmaydi
    const missing = computeNightStars([mk('a', { survived: true })], true, facts({ startedContenderIds: ['a', 'ghost'] }));
    assert.equal(missing.find((s) => s.kind === 'all_alive')!.earned, false);
  });

  it('4. Bo‘rilar yutdi (dawn=false): all_alive hech qachon yo‘q, fire_kept va alpha_slain olinishi mumkin', () => {
    const stars = computeNightStars([mk('a', { survived: false, alphaKills: 1 }), mk('b')], false, facts());
    assert.deepEqual(earnedKinds(stars), ['fire_kept', 'alpha_slain']);
    // survived noto'g'ri true bo'lsa ham tong otmagan — yo'q
    const weird = computeNightStars([mk('a', { survived: true })], false, facts({ startedContenderIds: ['a'] }));
    assert.equal(weird.find((s) => s.kind === 'all_alive')!.earned, false);
  });

  it('5. Chiqib ketgan hisobga olinmaydi; hamma chiqib ketsa — all_alive yo‘q; 0 s raund yoki faktlarsiz — yulduz yo‘q', () => {
    const left = computeNightStars([mk('a', { survived: true }), mk('b', { survived: false })], true, facts({ leftIds: ['b'] }));
    assert.ok(left.find((s) => s.kind === 'all_alive')!.earned, 'chiqib ketgan b hisobga olinmaydi');
    const allLeft = computeNightStars([mk('a'), mk('b')], true, facts({ leftIds: ['a', 'b'] }));
    assert.equal(allLeft.find((s) => s.kind === 'all_alive')!.earned, false);
    assert.deepEqual(earnedKinds(computeNightStars([mk('a', { survived: true, alphaKills: 1 })], true, facts({ elapsedSec: 0 }))), []);
    assert.deepEqual(earnedKinds(computeNightStars([mk('a', { survived: true, alphaKills: 1 })], true, null)), []);
    assert.deepEqual(earnedKinds(computeNightSummary([mk('a', { survived: true, alphaKills: 1 })], 'easy', true).stars!), []);
    // elapsedSec berilmasa — raund o'tgan deb olinadi
    assert.equal(countNightStars(computeNightStars([mk('a', { survived: true, alphaKills: 1 })], true, { mainFireOuts: 0, startedContenderIds: ['a'] })), 3);
  });

  it('6. Chat matni: "⭐ Tun yakuni: 2/3 yulduz (…)"; 0 ta — qavssiz', () => {
    const two: NightStar[] = [
      { kind: 'all_alive', earned: true },
      { kind: 'fire_kept', earned: false },
      { kind: 'alpha_slain', earned: true },
    ];
    assert.equal(
      formatNightStarsChatUz(two),
      `⭐ Tun yakuni: 2/3 yulduz (${NIGHT_STAR_TITLES_UZ.all_alive}, ${NIGHT_STAR_TITLES_UZ.alpha_slain})`,
    );
    assert.equal(formatNightStarsChatUz(two.map((s) => ({ ...s, earned: false }))), '⭐ Tun yakuni: 0/3 yulduz');
    assert.equal(countNightStars(undefined), 0);
  });
});

// ---------- Xona darajasi ----------

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
      timeLimit: 3,
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
function startNight(room: Room, ids: readonly string[]) {
  for (const id of ids) {
    room.addHuman(createFakeSocket(id), id.toUpperCase());
    room.onReady(id, { world: room.worldMeta() });
  }
  room.advanceTimeForTest(2.5, 0.25);
  assert.equal(room.phase, 'playing');
  return ids.map((id) => room.players.get(id)!);
}

/** Ishtirokchilarni tirik tutib vaqtni suradi: har qadamda joni to'ldiriladi. */
function surviveFor(room: Room, ps: readonly { hp: number; vel: Vec3 }[], sec: number, step = 0.25): void {
  let left = sec;
  while (left > 1e-6 && room.phase === 'playing') {
    const d = Math.min(step, left);
    room.advanceTimeForTest(d, 1 / 30);
    for (const p of ps) {
      p.hp = MAX_HP;
      p.vel = { x: 0, y: 0, z: 0 };
    }
    left -= d;
  }
}

function lastMatch(emitted: EmittedRoomEvent[]): MatchState {
  const m = emitted.filter((e) => e.event === 'match').pop()?.payload as MatchState | undefined;
  assert.ok(m, 'match hodisasi yuborilgan');
  return m!;
}

function systemChats(emitted: EmittedRoomEvent[]): string[] {
  return emitted.filter((e) => e.event === 'chat').map((e) => (e.payload as ChatMsg).text);
}

/** Gulxanni darhol o'chiradi (o'tin 0.05 s → keyingi tickda 'out'). */
function burnOut(room: Room, fire: { fuelSec: number; lit: boolean }): void {
  fire.fuelSec = 0.05;
  room.advanceTimeForTest(0.4, 1 / 30);
  assert.equal(fire.lit, false, "gulxan o'chdi");
}

describe('Stage 24 — xona: asosiy gulxan o‘chishlari va yakundagi yulduzlar', () => {
  it("7. Yakka: 2-lager o'chsa mainFireOuts 0; tongda all_alive + fire_kept; stars match holatida; chat qatori", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p] = startNight(room, ['p1']);
      assert.equal(room.getMainFireOutsForTest(), 0);
      const fires = room.getNightSnap()!.fires;
      assert.equal(fires[0]!.main, true);
      assert.equal(fires[0]!.name, 'Asosiy lager', 'snapshotda gulxan nomi');
      assert.equal(fires[1]!.name, '2-lager');
      burnOut(room, room.campfires.get(fires[1]!.id)!);
      assert.equal(room.getMainFireOutsForTest(), 0, "boshqa gulxan o'chishi hisoblanmaydi");

      room.setSurvivalConfigForTest({ roundDurationSec: 2 });
      surviveFor(room, [p!], 3);
      assert.equal(room.phase, 'ended');
      const sum = room.getSurvivalState()!.nightSummary!;
      assert.ok(sum.stars, 'yulduzlar yakunda');
      assert.deepEqual(sum.stars, [
        { kind: 'all_alive', earned: true },
        { kind: 'fire_kept', earned: true },
        { kind: 'alpha_slain', earned: false },
      ]);
      assert.deepEqual(lastMatch(emitted).survival?.nightSummary?.stars, sum.stars, 'MatchState.survival.nightSummary.stars');
      assert.ok(
        systemChats(emitted).some(
          (t) => t === `⭐ Tun yakuni: 2/3 yulduz (${NIGHT_STAR_TITLES_UZ.all_alive}, ${NIGHT_STAR_TITLES_UZ.fire_kept})`,
        ),
        'yulduzlar chatda',
      );
    } finally {
      room.destroy();
    }
  });

  it("8. Asosiy gulxan o'chdi (qayta yoqilsa ham) → mainFireOuts 1, fire_kept yo'q; keyingi raundda hisob noldan", () => {
    const { io, emitted } = createFakeIo();
    const room = makeNightRoom(io);
    try {
      const [p] = startNight(room, ['p1']);
      const main = [...room.campfires.values()].find((f) => f.main)!;
      burnOut(room, main);
      assert.equal(room.getMainFireOutsForTest(), 1);
      // Qayta yoqish hisobni o'chirmaydi
      main.lit = true;
      main.fuelSec = 120;
      room.setSurvivalConfigForTest({ roundDurationSec: 2 });
      surviveFor(room, [p!], 3);
      assert.equal(room.phase, 'ended');
      const stars = room.getSurvivalState()!.nightSummary!.stars!;
      assert.deepEqual(
        stars.map((s) => [s.kind, s.earned]),
        [
          ['all_alive', true],
          ['fire_kept', false],
          ['alpha_slain', false],
        ],
      );
      assert.ok(systemChats(emitted).some((t) => t.startsWith('⭐ Tun yakuni: 1/3 yulduz (')));

      // Keyingi sanoq (tong epilogi + natija ekranidan keyin): hisob tozalanadi
      room.advanceTimeForTest(MATCH_END_DURATION + NIGHT_DAWN_EPILOGUE_SEC + 0.5, 0.25);
      assert.equal(room.phase, 'countdown');
      assert.equal(room.getMainFireOutsForTest(), 0);
    } finally {
      room.destroy();
    }
  });

  it("9. Bo'rilar yutsa all_alive yo'q (fire_kept qoladi); chiqib ketgan sherik all_alive ga ta'sir qilmaydi", () => {
    // a) Bo'rilar yutdi: asosiy gulxan yonib tursa ham o'yinchi o'lib qoldi — raund 'draw_no_survivors' bilan tugaydi
    {
      const { io } = createFakeIo();
      const room = makeNightRoom(io);
      try {
        const [p] = startNight(room, ['p1']);
        // Asosiy gulxan o'chgan bo'lsa qaytish yo'q — bo'rilar yutadi; bu yerda uni o'chirmay turib
        // o'yinchini to'g'ridan-to'g'ri o'ldiramiz: asosiy gulxanni o'chirib (fire_kept yo'qoladi) emas,
        // oxirgi to'lqinda (qaytish yo'q) o'ldiramiz.
        room.setSurvivalConfigForTest({ roundDurationSec: 40 });
        surviveFor(room, [p!], 31); // 4-to'lqin (0.75 × 40 = 30 s) — qaytish yo'q
        assert.equal(room.phase, 'playing');
        const w = [...room.wolves.values()][0]!;
        p!.spawnTime = -99;
        room.damageForTest(p!, w, MAX_HP, 'wolf');
        assert.equal(room.phase, 'ended');
        const surv = room.getSurvivalState()!;
        assert.equal(surv.winReason, 'draw_no_survivors');
        const stars = surv.nightSummary!.stars!;
        assert.equal(stars.find((s) => s.kind === 'all_alive')!.earned, false);
        assert.equal(stars.find((s) => s.kind === 'fire_kept')!.earned, true, "asosiy gulxan o'chmagan");
      } finally {
        room.destroy();
      }
    }
    // b) Ikki odam, biri o'rtada chiqib ketdi — qolgani tongni ko'rdi → all_alive
    {
      const { io } = createFakeIo();
      const room = makeNightRoom(io);
      try {
        const [p1] = startNight(room, ['p1', 'p2']);
        room.setSurvivalConfigForTest({ roundDurationSec: 4 });
        surviveFor(room, [p1!, room.players.get('p2')!], 1);
        room.removePlayer('p2');
        assert.equal(room.phase, 'playing');
        surviveFor(room, [p1!], 4);
        assert.equal(room.phase, 'ended');
        const sum = room.getSurvivalState()!.nightSummary!;
        assert.deepEqual(
          sum.stats.map((s) => [s.id, s.survived]).sort(),
          [
            ['p1', true],
            ['p2', false],
          ],
          'chiqib ketgan statistikada qoladi, tirik emas',
        );
        assert.equal(sum.stars!.find((s) => s.kind === 'all_alive')!.earned, true, 'chiqib ketgan hisobga olinmaydi');
      } finally {
        room.destroy();
      }
    }
  });
});
