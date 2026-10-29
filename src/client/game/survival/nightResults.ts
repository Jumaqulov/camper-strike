/**
 * "Tong otguncha" natija varag'i (pergament) uchun sof HTML quruvchilar: qiyinlik, mukofotlar va tun
 * statistikasi jadvali. DOM'ga bog'liq emas — SurvivalUI natijani innerHTML ga qo'yadi, testlar Node'da tekshiradi.
 */
import {
  NIGHT_AWARD_TITLES_UZ,
  NIGHT_DIFFICULTIES,
  NIGHT_STAR_KINDS,
  NIGHT_STAR_TITLES_UZ,
  countNightStars,
  formatNightKeepTime,
  sanitizeNightDifficulty,
  type NightAward,
  type NightAwardKind,
  type NightRoundSummary,
  type NightStar,
  type NightStarKind,
} from '../../../shared/wolf/night';

/** HTML maxsus belgilarini qochirish (o'yinchi ismlarini foydalanuvchi kiritadi). */
export function escHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

/** Tarmoqdan kelgan hisob — manfiy bo'lmagan butun son (innerHTML ga faqat raqam tushsin). */
function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

const AWARD_ICONS: Readonly<Record<NightAwardKind, string>> = {
  mvp: '🏅',
  hunter: '🐺',
  woodsman: '🪵',
  firekeeper: '🔥',
  medic: '⛑️',
};
/** Birliklar (firekeeper — vaqt "2:15" ko'rinishida, birliksiz). */
const AWARD_UNITS_UZ: Readonly<Record<NightAwardKind, string>> = {
  mvp: 'ball',
  hunter: "bo'ri",
  woodsman: "o'tin",
  firekeeper: '',
  medic: 'marta',
};
/** MVP alohida taxtachada; qolganlari doim shu tartibda. */
const SECONDARY_AWARDS: readonly NightAwardKind[] = ['hunter', 'woodsman', 'firekeeper', 'medic'];

const ME_TAG = '<span class="s07-tag">Siz</span>';
const BOT_TAG = '<span class="s07-bot" title="Bot">🤖</span>';

/** Mukofot qiymati birligi bilan: "23 ball", "5 bo'ri", "12 o'tin", "3 marta"; olov qo'riqchisi — vaqt "2:15". */
export function formatNightAwardValueUz(a: NightAward): string {
  if (a.kind === 'firekeeper') return formatNightKeepTime(count(a.value));
  return `${count(a.value)} ${AWARD_UNITS_UZ[a.kind] ?? ''}`.trim();
}

/** Qiyinlik nomi (noma'lum qiymat — standart "O'rta"). */
export function nightDifficultyNameUz(d: unknown): string {
  return NIGHT_DIFFICULTIES[sanitizeNightDifficulty(d)].nameUz;
}

/** Kesh kaliti: natija o'zgarmasa varaq qayta chizilmaydi. */
export function nightSummaryKey(s: NightRoundSummary | null | undefined): string {
  return s ? JSON.stringify(s) : '';
}

/** Jadval qatorlari — tartib serverdan (ball bo'yicha), qayta saralanmaydi. */
export function buildNightStatsRowsHtml(summary: NightRoundSummary, myId: string): string {
  if (!summary.stats.length) {
    return `<tr><td colspan="6" class="s07-empty">Statistika yo'q</td></tr>`;
  }
  const mvpId = summary.awards.find((a) => a.kind === 'mvp')?.playerId ?? null;
  return summary.stats
    .map((s, i) => {
      const isMe = s.id === myId;
      const left = s.left === true;
      const cls = [s.id === mvpId ? 'is-mvp' : '', isMe ? 'is-me' : '', s.survived && !left ? '' : 'is-out']
        .filter(Boolean)
        .join(' ');
      const alphas = count(s.alphaKills);
      const alphaHtml = alphas > 0 ? `<span class="s07-alpha" title="To'da boshliqlari">👑${alphas}</span>` : '';
      const relights = count(s.relights);
      const keepTitle = relights > 0 ? ` title="O'chgan gulxanni ${relights} marta qayta yoqdi"` : '';
      const statusHtml = left
        ? `<span class="s07-st is-left" title="Chiqib ketdi">🚪<span class="s07-word"> Chiqib ketdi</span></span>`
        : s.survived
          ? `<span class="s07-st is-alive" title="Tong ko'rdi">🌅<span class="s07-word"> Tong ko'rdi</span></span>`
          : `<span class="s07-st is-dead" title="Halok bo'ldi">💀<span class="s07-word"> Halok bo'ldi</span></span>`;
      return `
              <tr${cls ? ` class="${cls}"` : ''}>
                <td><span class="s07-rank">#${i + 1}</span></td>
                <td class="s07-name">${escHtml(s.name)}${s.isBot ? BOT_TAG : ''}${isMe ? ME_TAG : ''}</td>
                <td class="s07-num">${count(s.wolfKills)}${alphaHtml}</td>
                <td class="s07-num">${count(s.logsFed)}</td>
                <td class="s07-num"${keepTitle}>${formatNightKeepTime(count(s.fireKeepSec))}</td>
                <td class="s07-status">${statusHtml}</td>
              </tr>`;
    })
    .join('');
}

/** Mukofotlar: MVP ("Tun qahramoni") katta oltin taxtachada, qolganlari ostida kichik nishonlar. */
export function buildNightAwardsHtml(summary: NightRoundSummary, myId: string): string {
  const known = summary.awards.filter((a) => Object.prototype.hasOwnProperty.call(AWARD_ICONS, a.kind));
  const title = (a: NightAward) => escHtml(a.titleUz || NIGHT_AWARD_TITLES_UZ[a.kind]);
  const who = (a: NightAward) => `${escHtml(a.playerName)}${a.playerId === myId ? ME_TAG : ''}`;

  const mvp = known.find((a) => a.kind === 'mvp');
  const mvpHtml = mvp
    ? `
          <div class="s07-mvp">
            <span class="s07-mvp-medal" aria-hidden="true">${AWARD_ICONS.mvp}</span>
            <span class="s07-mvp-body">
              <span class="s07-mvp-title">${title(mvp)}</span>
              <span class="s07-mvp-name">${who(mvp)}</span>
            </span>
            <span class="s07-mvp-value">${escHtml(formatNightAwardValueUz(mvp))}</span>
          </div>`
    : '';

  const rest = SECONDARY_AWARDS.map((kind) => known.find((a) => a.kind === kind)).filter(
    (a): a is NightAward => a !== undefined,
  );
  const restHtml = rest.length
    ? `
          <ul class="s07-awards">${rest
            .map(
              (a) => `
            <li class="s07-award is-${a.kind}">
              <span class="s07-award-icon" aria-hidden="true">${AWARD_ICONS[a.kind]}</span>
              <span class="s07-award-body">
                <span class="s07-award-title">${title(a)}</span>
                <span class="s07-award-name">${who(a)}</span>
              </span>
              <span class="s07-award-value">${escHtml(formatNightAwardValueUz(a))}</span>
            </li>`,
            )
            .join('')}
          </ul>`
    : '';
  return mvpHtml + restHtml;
}

/**
 * Yulduzlar: serverdan kelganlarni NIGHT_STAR_KINDS tartibiga keltiradi (yetishmagani — olinmagan,
 * noma'lum turi tashlab yuboriladi). `stars` bo'lmasa (eski server) — null.
 */
export function normalizeNightStars(stars: readonly NightStar[] | null | undefined): NightStar[] | null {
  if (!Array.isArray(stars)) return null;
  return NIGHT_STAR_KINDS.map((kind) => ({ kind, earned: stars.some((s) => s && s.kind === kind && s.earned === true) }));
}

/** "2/3 yulduz". */
export function formatNightStarsTotalUz(stars: readonly NightStar[]): string {
  return `${countNightStars(stars)}/${stars.length} yulduz`;
}

/** Yulduzlar qatori: uchta katta yulduz (★ oltin — olingan, ☆ xira — olinmagan) va ostida sarlavhasi; jami. */
export function buildNightStarsHtml(summary: NightRoundSummary): string {
  const stars = normalizeNightStars(summary.stars);
  if (!stars) return '';
  const total = formatNightStarsTotalUz(stars);
  const items = stars
    .map((s) => {
      const kind: NightStarKind = s.kind;
      return `
            <div class="s07-star is-${kind}${s.earned ? ' is-earned' : ''}" title="${escHtml(NIGHT_STAR_TITLES_UZ[kind])}">
              <span class="s07-star-glyph" aria-hidden="true">${s.earned ? '★' : '☆'}</span>
              <span class="s07-star-label">${escHtml(NIGHT_STAR_TITLES_UZ[kind])}</span>
            </div>`;
    })
    .join('');
  return `
          <div class="s07-stars" role="group" aria-label="${escHtml(total)}">
            <div class="s07-stars-row">${items}
            </div>
            <div class="s07-stars-total">${escHtml(total)}</div>
          </div>`;
}

/** Butun pergament: yulduzlar → qiyinlik → mukofotlar → statistika jadvali (uzun bo'lsa ichida aylantiriladi). */
export function buildNightSummaryBoardHtml(summary: NightRoundSummary, myId: string): string {
  const diff = sanitizeNightDifficulty(summary.difficulty);
  return `
          <div class="s07-win-board s07-night-board">
            ${buildNightStarsHtml(summary)}
            <div class="s07-night-diff is-${diff}">🌙 Qiyinlik: <b>${escHtml(NIGHT_DIFFICULTIES[diff].nameUz)}</b></div>
            ${buildNightAwardsHtml(summary, myId)}
            <div class="s07-night-scroll">
              <table class="s07-win-table s07-night-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>O'yinchi</th>
                    <th class="s07-num" title="O'ldirilgan bo'rilar (👑 — to'da boshliqlari)">🐺<span class="s07-word"> Bo'ri</span></th>
                    <th class="s07-num" title="Gulxanga tashlangan o'tin">🪵<span class="s07-word"> O'tin</span></th>
                    <th class="s07-num" title="Gulxanni o'chirmay yoqib turgan vaqt — tashlagan o'tini yongan daqiqa:soniya">🔥<span class="s07-word"> Olov</span></th>
                    <th>Holat</th>
                  </tr>
                </thead>
                <tbody>
                  ${buildNightStatsRowsHtml(summary, myId)}
                </tbody>
              </table>
            </div>
          </div>`;
}
