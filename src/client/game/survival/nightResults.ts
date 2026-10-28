/**
 * "Tong otguncha" natija varag'i (pergament) uchun sof HTML quruvchilar: qiyinlik, mukofotlar va tun
 * statistikasi jadvali. DOM'ga bog'liq emas — SurvivalUI natijani innerHTML ga qo'yadi, testlar Node'da tekshiradi.
 */
import {
  NIGHT_AWARD_TITLES_UZ,
  NIGHT_DIFFICULTIES,
  sanitizeNightDifficulty,
  type NightAward,
  type NightAwardKind,
  type NightRoundSummary,
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
};
const AWARD_UNITS_UZ: Readonly<Record<NightAwardKind, string>> = {
  mvp: 'ball',
  hunter: "bo'ri",
  woodsman: "o'tin",
  firekeeper: 'marta',
};
/** MVP alohida taxtachada; qolganlari doim shu tartibda. */
const SECONDARY_AWARDS: readonly NightAwardKind[] = ['hunter', 'woodsman', 'firekeeper'];

const ME_TAG = '<span class="s07-tag">Siz</span>';
const BOT_TAG = '<span class="s07-bot" title="Bot">🤖</span>';

/** Mukofot qiymati birligi bilan: "23 ball", "5 bo'ri", "12 o'tin", "3 marta". */
export function formatNightAwardValueUz(a: NightAward): string {
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
      const cls = [s.id === mvpId ? 'is-mvp' : '', isMe ? 'is-me' : '', s.survived ? '' : 'is-out']
        .filter(Boolean)
        .join(' ');
      const alphas = count(s.alphaKills);
      const alphaHtml = alphas > 0 ? `<span class="s07-alpha" title="To'da boshliqlari">👑${alphas}</span>` : '';
      const statusHtml = s.survived
        ? `<span class="s07-st is-alive" title="Tong ko'rdi">🌅<span class="s07-word"> Tong ko'rdi</span></span>`
        : `<span class="s07-st is-dead" title="Halok bo'ldi">💀<span class="s07-word"> Halok bo'ldi</span></span>`;
      return `
              <tr${cls ? ` class="${cls}"` : ''}>
                <td><span class="s07-rank">#${i + 1}</span></td>
                <td class="s07-name">${escHtml(s.name)}${s.isBot ? BOT_TAG : ''}${isMe ? ME_TAG : ''}</td>
                <td class="s07-num">${count(s.wolfKills)}${alphaHtml}</td>
                <td class="s07-num">${count(s.logsFed)}</td>
                <td class="s07-num">${count(s.relights)}</td>
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

/** Butun pergament: qiyinlik → mukofotlar → statistika jadvali (uzun bo'lsa ichida aylantiriladi). */
export function buildNightSummaryBoardHtml(summary: NightRoundSummary, myId: string): string {
  const diff = sanitizeNightDifficulty(summary.difficulty);
  return `
          <div class="s07-win-board s07-night-board">
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
                    <th class="s07-num" title="O'chgan gulxanni qayta yoqish">🔥<span class="s07-word"> Yoqish</span></th>
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
