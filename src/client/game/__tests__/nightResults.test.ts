import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { SurvivalStateSnap } from '../../../shared/survival';
import { computeNightSummary, type NightPlayerStats, type NightRoundSummary } from '../../../shared/wolf/night';
import {
  buildNightAwardsHtml,
  buildNightStatsRowsHtml,
  buildNightSummaryBoardHtml,
  escHtml,
  formatNightAwardValueUz,
  nightDifficultyNameUz,
} from '../survival/nightResults';
import { SurvivalUI } from '../survival/SurvivalUI';

// "Tong otguncha" natija varag'i: sof HTML quruvchilar (jadval, mukofotlar, qiyinlik) va
// SurvivalUI ularni faqat mazmun o'zgarganda qayta chizishi. Node, minimal document stubi.

const stat = (over: Partial<NightPlayerStats> & { id: string; name: string }): NightPlayerStats => ({
  isBot: false,
  wolfKills: 0,
  alphaKills: 0,
  wolfDamage: 0,
  logsFed: 0,
  relights: 0,
  survived: false,
  revives: 0,
  downs: 0,
  ...over,
});

const EVIL = `<img src=x onerror="alert('x')">&`;

function sampleSummary(): NightRoundSummary {
  return computeNightSummary(
    [
      stat({ id: 'me', name: 'Sardor', wolfKills: 2, logsFed: 9, survived: true }),
      stat({ id: 'b1', name: 'Bot Ali', isBot: true, wolfKills: 6, alphaKills: 1, relights: 2, survived: true }),
      stat({ id: 'x', name: EVIL, logsFed: 1 }),
    ],
    'hard',
    true,
  );
}

/** <tr> bo'laklari (thead'siz). */
const rowsOf = (html: string): string[] => html.split('<tr').slice(1);

describe('nightResults — tun statistikasi jadvali', () => {
  it('1. Qatorlar serverdagi tartibda, #rank, Siz/bot belgisi, 👑 boshliqlar, holat', () => {
    const summary = sampleSummary();
    assert.deepEqual(
      summary.stats.map((s) => s.id),
      ['b1', 'me', 'x'],
      'computeNightSummary ball bo‘yicha saralaydi',
    );
    const rows = rowsOf(buildNightStatsRowsHtml(summary, 'me'));
    assert.equal(rows.length, 3);

    // 1-qator: bot, MVP, 6 bo'ri + 👑1, tong ko'rdi
    assert.match(rows[0]!, /class="is-mvp"/);
    assert.match(rows[0]!, /#1</);
    assert.match(rows[0]!, /Bot Ali<span class="s07-bot"/);
    assert.match(rows[0]!, /6<span class="s07-alpha"[^>]*>👑1</);
    assert.match(rows[0]!, /Tong ko'rdi/);
    assert.doesNotMatch(rows[0]!, /s07-tag/);

    // 2-qator: men — "Siz" belgisi, bot emas, boshliqsiz
    assert.match(rows[1]!, /class="is-me"/);
    assert.match(rows[1]!, /#2</);
    assert.match(rows[1]!, /Sardor<span class="s07-tag">Siz<\/span>/);
    assert.doesNotMatch(rows[1]!, /s07-bot|s07-alpha/);
    assert.match(rows[1]!, /<td class="s07-num">9<\/td>/, "o'tin");

    // 3-qator: halok bo'lgan
    assert.match(rows[2]!, /class="is-out"/);
    assert.match(rows[2]!, /Halok bo'ldi/);
  });

  it('2. Ismlar HTML-qochiriladi (jadval va mukofotlarda)', () => {
    const summary = sampleSummary();
    summary.awards = [{ kind: 'mvp', playerId: 'x', playerName: EVIL, value: 1, titleUz: '<b>t</b>' }];
    const html = buildNightSummaryBoardHtml(summary, 'me');
    assert.equal(html.split(escHtml(EVIL)).length - 1, 2, 'jadvalda va MVP taxtachasida');
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<b>t<\/b>/);
    assert.ok(html.includes(escHtml(EVIL)));
    assert.equal(escHtml(EVIL), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
  });

  it('3. Bo‘sh statistika — bitta izoh qatori', () => {
    const html = buildNightStatsRowsHtml({ difficulty: 'normal', dawn: false, stats: [], awards: [] }, 'me');
    assert.match(html, /colspan="6"/);
  });
});

describe('nightResults — mukofotlar va qiyinlik', () => {
  it('4. MVP alohida taxtachada birinchi, qolganlari ovchi → o‘tinchi → olov tartibida', () => {
    const summary = sampleSummary();
    // Tartibni ataylab buzamiz — klient doim bir xil tartibda ko'rsatadi
    summary.awards.reverse();
    const html = buildNightAwardsHtml(summary, 'me');
    const mvpAt = html.indexOf('s07-mvp"');
    const hunterAt = html.indexOf('is-hunter');
    const woodAt = html.indexOf('is-woodsman');
    const fireAt = html.indexOf('is-firekeeper');
    assert.ok(mvpAt >= 0 && mvpAt < hunterAt && hunterAt < woodAt && woodAt < fireAt, html);
    // Sarlavhalar serverdan (titleUz) — apostrof ham qochiriladi
    for (const t of ['Tun qahramoni', "Bo'ri ovchisi", "Eng yaxshi o'tinchi", "Olov qo'riqchisi"]) {
      assert.ok(html.includes(escHtml(t)), t);
    }
    assert.ok(html.includes(escHtml("6 bo'ri")));
    // O'tinchi — men: "Siz" belgisi
    assert.match(html, /Sardor<span class="s07-tag">Siz<\/span>/);
  });

  it('5. Qiymat birliklari va mukofotsiz tun', () => {
    const base = { playerId: 'p', playerName: 'P', titleUz: '' };
    assert.equal(formatNightAwardValueUz({ ...base, kind: 'mvp', value: 23 }), '23 ball');
    assert.equal(formatNightAwardValueUz({ ...base, kind: 'hunter', value: 5 }), "5 bo'ri");
    assert.equal(formatNightAwardValueUz({ ...base, kind: 'woodsman', value: 12 }), "12 o'tin");
    assert.equal(formatNightAwardValueUz({ ...base, kind: 'firekeeper', value: 3 }), '3 marta');
    assert.equal(buildNightAwardsHtml({ difficulty: 'easy', dawn: false, stats: [], awards: [] }, 'me'), '');
  });

  it('6. Qiyinlik nomi pergamentda; noma‘lum qiymat — O‘rta', () => {
    assert.match(buildNightSummaryBoardHtml(sampleSummary(), 'me'), /is-hard">🌙 Qiyinlik: <b>Qiyin<\/b>/);
    assert.equal(nightDifficultyNameUz('easy'), 'Oson');
    assert.equal(nightDifficultyNameUz('???'), "O'rta");
  });
});

// ---------- SurvivalUI: natija varag'i faqat mazmun o'zgarganda qayta quriladi ----------

class FakeEl {
  id = '';
  className = '';
  textContent = '';
  writes = 0;
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private html = '';
  private readonly queried = new Map<string, FakeEl>();
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(v: string) {
    this.writes++;
    this.html = v;
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  querySelector(sel: string): FakeEl {
    let e = this.queried.get(sel);
    if (!e) {
      e = new FakeEl();
      this.queried.set(sel, e);
    }
    return e;
  }
  addEventListener(): void {}
  remove(): void {}
}

let created: FakeEl[];
let prevDocument: PropertyDescriptor | undefined;

beforeEach(() => {
  created = [];
  prevDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: {
      body: new FakeEl(),
      getElementById: () => null,
      createElement: () => {
        const e = new FakeEl();
        created.push(e);
        return e;
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (prevDocument) Object.defineProperty(globalThis, 'document', prevDocument);
  else delete (globalThis as Record<string, unknown>).document;
});

function endedSnap(over: Partial<SurvivalStateSnap> = {}): SurvivalStateSnap {
  return {
    roundId: 3,
    phase: 'ended',
    timeLeft: 10,
    minPlayers: 2,
    readyCount: 3,
    readyHumans: 1,
    minHumans: 1,
    contenderIds: ['me', 'b1', 'x'],
    aliveIds: ['me', 'b1'],
    spectatorIds: [],
    aliveCount: 2,
    totalContenders: 3,
    winnerId: null,
    winnerName: 'Sardor, Bot Ali',
    winReason: 'dawn',
    statusTextUz: '',
    players: [
      { id: 'me', name: 'Sardor', role: 'contender', alive: true, ready: true, kills: 2, deaths: 0 },
      { id: 'b1', name: 'Bot Ali', role: 'contender', alive: true, ready: true, kills: 5, deaths: 0 },
      { id: 'x', name: 'X', role: 'eliminated', alive: false, ready: true, kills: 0, deaths: 1 },
    ],
    winnerIds: ['me', 'b1'],
    nightSummary: sampleSummary(),
    ...over,
  };
}

const overlayOf = (): FakeEl => {
  const o = created.find((e) => e.id === 'stage07-winner-overlay');
  assert.ok(o, 'winner overlay yaratildi');
  return o;
};

describe('SurvivalUI — tun natijasi varag‘i', () => {
  it('7. Bir xil snapshot — qayta yozilmaydi; faqat taymer — pastki qism yangilanadi; natija o‘zgarsa — qayta quriladi', () => {
    const ui = new SurvivalUI({ onCycleSpectatorTarget: () => {}, onToggleCameraPerspective: () => {} });
    ui.setMode('wolf_night');
    ui.setVisible(true);
    const overlay = overlayOf();

    ui.update(endedSnap(), 'me', null);
    assert.equal(overlay.writes, 1);
    assert.equal(overlay.className, 'is-night-summary');
    assert.match(overlay.innerHTML, /OMON QOLDINGIZ!/, 'sarlavha saqlanadi');
    assert.match(overlay.innerHTML, /s07-night-table/);
    assert.match(overlay.innerHTML, /Tun qahramoni/);
    assert.match(overlay.innerHTML, /Qiyinlik: <b>Qiyin/);
    assert.match(overlay.innerHTML, /s07-win-bar/, 'taymer chizig‘i saqlanadi');
    assert.doesNotMatch(overlay.innerHTML, />Qotil</, 'eski o‘rin/qotil jadvali yo‘q');

    for (let i = 0; i < 5; i++) ui.update(endedSnap(), 'me', null);
    assert.equal(overlay.writes, 1, 'har kadr qayta chizilmaydi');

    ui.update(endedSnap({ timeLeft: 7 }), 'me', null);
    assert.equal(overlay.writes, 1, 'taymer uchun varaq qayta qurilmaydi');
    assert.equal(overlay.querySelector('.s07-win-footer b').textContent, '7');
    assert.equal(overlay.querySelector('.s07-win-bar i').style.width, '70%');

    const changed = sampleSummary();
    changed.stats[0]!.logsFed = 4;
    ui.update(endedSnap({ timeLeft: 7, nightSummary: changed }), 'me', null);
    assert.equal(overlay.writes, 2, 'natija o‘zgardi');
  });

  it('8. nightSummary yo‘q — eski tun jadvali; forest_survival natijasi o‘zgarmagan', () => {
    const ui = new SurvivalUI({ onCycleSpectatorTarget: () => {}, onToggleCameraPerspective: () => {} });
    ui.setMode('wolf_night');
    ui.setVisible(true);
    const overlay = overlayOf();
    ui.update(endedSnap({ nightSummary: null }), 'me', null);
    assert.equal(overlay.className, '');
    assert.match(overlay.innerHTML, />Qotil</);
    assert.doesNotMatch(overlay.innerHTML, /s07-night/);

    ui.setMode('forest_survival');
    ui.update(
      endedSnap({ winReason: 'last_standing', winnerId: 'me', winnerName: 'Sardor', winnerIds: undefined }),
      'me',
      null,
    );
    assert.match(overlay.innerHTML, /G'ALABA!/);
    assert.match(overlay.innerHTML, /Keyingi raund/);
    assert.doesNotMatch(overlay.innerHTML, /s07-night|Tun qahramoni/);
  });

  it('9. "Tabib" (medic) mukofoti: ⛑ nishoni oxirida, "N marta"; turg‘izish bo‘lmasa chiqmaydi', () => {
    const summary = computeNightSummary(
      [
        stat({ id: 'me', name: 'Sardor', wolfKills: 2, survived: true }),
        stat({ id: 'd', name: 'Dilshod', revives: 3, downs: 1, survived: true }),
        stat({ id: 'b1', name: 'Bot Ali', isBot: true, logsFed: 4, relights: 1 }),
      ],
      'normal',
      true,
    );
    const html = buildNightAwardsHtml(summary, 'd');
    const medicAt = html.indexOf('is-medic');
    assert.ok(medicAt >= 0, html);
    assert.ok(html.indexOf('is-hunter') < html.indexOf('is-woodsman'));
    assert.ok(html.indexOf('is-firekeeper') < medicAt, 'tabib — oxirgi nishon');
    assert.ok(html.includes('Tabib'));
    assert.ok(html.includes('3 marta'));
    assert.match(html, /Dilshod<span class="s07-tag">Siz<\/span>/);
    assert.equal(formatNightAwardValueUz({ kind: 'medic', playerId: 'd', playerName: 'D', titleUz: '', value: 3 }), '3 marta');
    // Turg'izish yo'q — tabib yo'q (sampleSummary'da revives 0)
    assert.doesNotMatch(buildNightAwardsHtml(sampleSummary(), 'me'), /is-medic|Tabib/);
  });
});
