import type { GameMode, Team } from '../../shared/constants';
import type { ChatMsg, KillEvent, MatchState, RosterEntry } from '../../shared/protocol';
import { WEAPONS, WEAPON_SLOTS, type WeaponId } from '../../shared/weapons';
import { getWeaponIcons3D } from './GunModels';
import { onWeaponAssetsReady } from './WeaponAssetRegistry';

const $ = (id: string) => document.getElementById(id)!;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const WEAPON_SHORT: Record<WeaponId | 'grenade', string> = {
  rifle: 'AVTOMAT',
  pistol: "TO'PPONCHA",
  shotgun: 'DROBOVIK',
  sniper: 'SNAYPER',
  grenade: 'GRANATA',
};

/** Har bir qurol uchun aniq taniladigan SVG siluet ikonkalari (Killfeed, HUD va O'lim ekrani uchun) */
export const WEAPON_SVG: Record<WeaponId | 'grenade', string> = {
  rifle: `<svg class="w-svg" viewBox="0 0 96 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Qundoq (Stock) -->
    <path d="M4 13L22 11V20L6 24C4.5 24 3.5 22.5 3.5 21V14.5C3.5 13.5 4 13 4 13Z" fill="#b8763c" stroke="#1a120b" stroke-width="1.5"/>
    <!-- Asosiy korpus (Receiver) -->
    <rect x="22" y="10" width="30" height="9" rx="1.5" fill="#d0d7de" stroke="#181c20" stroke-width="1.5"/>
    <!-- Kollimator pritsel (Red-dot sight) -->
    <path d="M30 10V5H40V10" fill="#3a424a" stroke="#181c20" stroke-width="1.5"/>
    <circle cx="35" cy="7.5" r="1.6" fill="#ff3b3b"/>
    <!-- Dasta (Pistol grip) -->
    <path d="M25 19L21 28H27L30 19H25Z" fill="#8c4f24" stroke="#181c20" stroke-width="1.4"/>
    <!-- Egilgan Avtomat magazini (Banana mag + ko'k skotch) -->
    <path d="M40 19C40 19 42 26 47 30L53 28C49 24 47 19 47 19H40Z" fill="#32383e" stroke="#181c20" stroke-width="1.4"/>
    <path d="M42.5 24L49.5 22.5L51 25L44 26.8Z" fill="#2e8cff"/>
    <!-- Old yog'och qism (Handguard + ko'k skotch) -->
    <rect x="52" y="11" width="18" height="6.5" rx="1" fill="#b8763c" stroke="#181c20" stroke-width="1.4"/>
    <rect x="57" y="10.8" width="4.5" height="7" fill="#2e8cff"/>
    <!-- Stvol va gaz trubkasi (Barrel + Front sight + Muzzle) -->
    <rect x="70" y="12.5" width="20" height="3" fill="#aeb8c2" stroke="#181c20" stroke-width="1.2"/>
    <rect x="70" y="10.2" width="11" height="2.2" fill="#5b646e"/>
    <path d="M84 12.5V7.5H87L88 12.5H84Z" fill="#3a424a"/>
    <rect x="89" y="11.5" width="5" height="5" rx="1" fill="#3a424a"/>
  </svg>`,

  pistol: `<svg class="w-svg" viewBox="0 0 72 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Yog'och dasta (Walnut Grip) -->
    <path d="M14 16L8 29H19L24 17L14 16Z" fill="#a65e2e" stroke="#181c20" stroke-width="1.6"/>
    <circle cx="15" cy="23" r="1.8" fill="#f0c24b"/>
    <!-- Tepki (Hammer) -->
    <path d="M13 11L9 7L12 6L16 11H13Z" fill="#d8e0e8" stroke="#181c20" stroke-width="1.2"/>
    <!-- Korpus va Revolver Barabani (Frame & Fluted Cylinder) -->
    <rect x="14" y="9" width="22" height="8.5" rx="1.5" fill="#bcc6d0" stroke="#181c20" stroke-width="1.5"/>
    <rect x="20" y="10.2" width="12" height="6.5" rx="1.5" fill="#49525c" stroke="#181c20" stroke-width="1.2"/>
    <line x1="22" y1="12.5" x2="30" y2="12.5" stroke="#bcc6d0" stroke-width="1.3"/>
    <line x1="22" y1="14.8" x2="30" y2="14.8" stroke="#bcc6d0" stroke-width="1.3"/>
    <!-- Trigger guard -->
    <path d="M23 17.5C23 21.5 29 21.5 29 17.5" stroke="#bcc6d0" stroke-width="1.6"/>
    <!-- Yo'g'on Magnum Stvoli (Heavy Vent Barrel + Red Front Sight) -->
    <rect x="36" y="8.5" width="26" height="6.5" rx="1" fill="#e2e8f0" stroke="#181c20" stroke-width="1.5"/>
    <rect x="36" y="14.5" width="22" height="2.5" fill="#68737e"/>
    <polygon points="57,8.5 61,5 62,8.5" fill="#ff3b3b"/>
  </svg>`,

  shotgun: `<svg class="w-svg" viewBox="0 0 98 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Yong'oq yog'ochli qundoq va dasta (Shotgun Stock) -->
    <path d="M3 16L22 12L27 17L23 23L19 19L5 25C3.5 25 2.5 23.5 2.5 22V17.5C2.5 16.5 3 16 3 16Z" fill="#a8602a" stroke="#181c20" stroke-width="1.5"/>
    <!-- Metall korpus (Receiver + Qizil patronlar) -->
    <rect x="25" y="10.5" width="24" height="7.5" rx="1.2" fill="#aeb7c0" stroke="#181c20" stroke-width="1.5"/>
    <rect x="29" y="12.2" width="2.8" height="4.5" rx="0.6" fill="#ff3838"/>
    <rect x="33" y="12.2" width="2.8" height="4.5" rx="0.6" fill="#ff3838"/>
    <rect x="37" y="12.2" width="2.8" height="4.5" rx="0.6" fill="#ff3838"/>
    <rect x="41" y="12.2" width="2.8" height="4.5" rx="0.6" fill="#ff3838"/>
    <!-- Ikki qavatli uzun stvol va magazin trubkasi -->
    <rect x="49" y="10.5" width="44" height="3.5" fill="#d0d8e0" stroke="#181c20" stroke-width="1.3"/>
    <rect x="49" y="14" width="36" height="3" fill="#6c7680" stroke="#181c20" stroke-width="1.2"/>
    <circle cx="91" cy="9.2" r="1.5" fill="#f5c542"/>
    <!-- Qovurg'ali yog'och pompa (Ribbed Pump Forend) -->
    <rect x="54" y="13.5" width="20" height="6" rx="1.5" fill="#8c4b1f" stroke="#181c20" stroke-width="1.5"/>
    <line x1="58" y1="14" x2="58" y2="19" stroke="#d4945a" stroke-width="1.4"/>
    <line x1="62" y1="14" x2="62" y2="19" stroke="#d4945a" stroke-width="1.4"/>
    <line x1="66" y1="14" x2="66" y2="19" stroke="#d4945a" stroke-width="1.4"/>
    <line x1="70" y1="14" x2="70" y2="19" stroke="#d4945a" stroke-width="1.4"/>
  </svg>`,

  sniper: `<svg class="w-svg" viewBox="0 0 106 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Snayper qundog'i va yonoq yostiqchasi (Sniper Stock & Cheekpad) -->
    <path d="M3 14L23 12L28 16L24 25L19 25L21 19L5 23C3.5 23 2.5 21.5 2.5 20V15.5Z" fill="#677848" stroke="#181c20" stroke-width="1.5"/>
    <rect x="7" y="10.5" width="11" height="3" rx="1" fill="#4a301c"/>
    <!-- Korpus va Magazin -->
    <rect x="24" y="11" width="32" height="6.5" rx="1" fill="#7c8c58" stroke="#181c20" stroke-width="1.5"/>
    <rect x="35" y="17.5" width="8" height="7" rx="1" fill="#32383e" stroke="#181c20" stroke-width="1.3"/>
    <!-- Katta Optik Pritsel (Telescopic Hunting Scope with Emerald Lens) -->
    <path d="M24 4.5L30 6H48L55 4V9.5L48 8H30L24 9.5V4.5Z" fill="#2d3339" stroke="#181c20" stroke-width="1.4"/>
    <rect x="33" y="8" width="3" height="3" fill="#abb4bd"/>
    <rect x="43" y="8" width="3" height="3" fill="#abb4bd"/>
    <rect x="54" y="4.5" width="2.2" height="4.5" fill="#22e6b8"/>
    <!-- Uzun stvol, Bipod oyoqchalari va Muzzle Brake -->
    <rect x="56" y="12" width="42" height="3.2" fill="#d0d8e0" stroke="#181c20" stroke-width="1.3"/>
    <line x1="64" y1="16.5" x2="59" y2="26" stroke="#8f9aa5" stroke-width="2" stroke-linecap="round"/>
    <line x1="66" y1="16.5" x2="72" y2="25" stroke="#8f9aa5" stroke-width="2" stroke-linecap="round"/>
    <rect x="96" y="10.5" width="7" height="6" rx="1" fill="#464f57" stroke="#181c20" stroke-width="1.3"/>
  </svg>`,

  grenade: `<svg class="w-svg w-svg-grenade" viewBox="0 0 36 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Fuse va Dasta (Spoon lever & Pull ring) -->
    <rect x="15" y="3" width="6" height="5" rx="1" fill="#b8c2cc" stroke="#181c20" stroke-width="1.3"/>
    <path d="M21 4.5H27L29 16L26 17L25 7H21" fill="#8f9aa5" stroke="#181c20" stroke-width="1.2"/>
    <circle cx="12" cy="5.5" r="3" stroke="#f5c542" stroke-width="1.8"/>
    <!-- Granata korpusi (Segmented Pineapple Frag Body) -->
    <ellipse cx="18" cy="18.5" rx="9.5" ry="11" fill="#4d6b38" stroke="#181c20" stroke-width="1.6"/>
    <line x1="10" y1="14" x2="26" y2="14" stroke="#243319" stroke-width="1.5"/>
    <line x1="9" y1="19" x2="27" y2="19" stroke="#243319" stroke-width="1.5"/>
    <line x1="10" y1="24" x2="26" y2="24" stroke="#243319" stroke-width="1.5"/>
    <line x1="18" y1="8" x2="18" y2="29" stroke="#243319" stroke-width="1.5"/>
  </svg>`,
};

const HEADSHOT_SVG = `<svg class="hs-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="9" stroke="#ff3b3b" stroke-width="2.2"/>
  <line x1="12" y1="0" x2="12" y2="6" stroke="#ff3b3b" stroke-width="2.2"/>
  <line x1="12" y1="18" x2="12" y2="24" stroke="#ff3b3b" stroke-width="2.2"/>
  <line x1="0" y1="12" x2="6" y2="12" stroke="#ff3b3b" stroke-width="2.2"/>
  <line x1="18" y1="12" x2="24" y2="12" stroke="#ff3b3b" stroke-width="2.2"/>
  <circle cx="12" cy="12" r="3" fill="#ffd15c"/>
</svg>`;

export function weaponIconHtml(w: WeaponId | 'grenade'): string {
  const icons3d = getWeaponIcons3D();
  const src = icons3d[w];
  if (src) {
    return `<img class="w-img-3d w-img-${w}" src="${src}" alt="" draggable="false" />`;
  }
  return WEAPON_SVG[w];
}

export function weaponBadgeHtml(w: WeaponId | 'grenade', headshot = false): string {
  return `<span class="kf-weapon">${weaponIconHtml(w)}${
    headshot ? `<span class="kf-hs">${HEADSHOT_SVG}</span>` : ''
  }</span>`;
}

export class Hud {
  private hitTimer = 0;
  private flashTimer = 0;
  private centerTimer = 0;
  private lastHp = -1;
  private lastAmmoKey = '';

  constructor() {
    onWeaponAssetsReady(() => {
      this.lastAmmoKey = '';
    });
  }

  show(v: boolean): void {
    $('hud').classList.toggle('hidden', !v);
  }

  setHealth(hp: number): void {
    if (hp === this.lastHp) return;
    this.lastHp = hp;
    $('hp-value').textContent = String(Math.max(0, Math.round(hp)));
    const fill = $('hp-fill');
    fill.style.width = `${Math.max(0, hp)}%`;
  }

  setAmmo(
    weapon: WeaponId | null,
    mag: number,
    reserve: number,
    reloading: boolean,
    grenades: number,
    ownedWeapons?: ReadonlySet<WeaponId>,
  ): void {
    const ownedKey = ownedWeapons ? [...ownedWeapons].sort().join(',') : 'all';
    const key = `${weapon ?? 'none'}|${mag}|${reserve}|${reloading}|${grenades}|${ownedKey}`;
    if (key === this.lastAmmoKey) return;
    this.lastAmmoKey = key;

    if (!weapon) {
      $('weapon-name').innerHTML = `<span>✋ Bo'sh qo'l</span>`;
      $('ammo-mag').textContent = '—';
      $('ammo-mag').classList.remove('low');
      $('ammo-reserve').textContent = '—';
      $('grenades').innerHTML = `${weaponIconHtml('grenade')} <span>GRANATA [G] ×${grenades}</span>`;
      $('weapon-slots').innerHTML = WEAPON_SLOTS.map((w, i) => {
        const owned = !ownedWeapons || ownedWeapons.has(w);
        return `<span class="slot ${owned ? '' : 'locked'}" style="${owned ? '' : 'opacity:0.32;filter:grayscale(1);'}"><b>${i + 1}</b>${weaponIconHtml(w)}</span>`;
      }).join('');
      $('reload-hint').classList.add('hidden');
      return;
    }

    const def = WEAPONS[weapon];
    $('weapon-name').innerHTML = `${weaponIconHtml(weapon)} <span>${def.name}${reloading ? " — o'qlanmoqda..." : ''}</span>`;
    $('ammo-mag').textContent = String(mag);
    $('ammo-mag').classList.toggle('low', mag <= Math.ceil(def.magSize * 0.25));
    $('ammo-reserve').textContent = String(reserve);
    $('grenades').innerHTML = `${weaponIconHtml('grenade')} <span>GRANATA [G] ×${grenades}</span>`;
    $('weapon-slots').innerHTML = WEAPON_SLOTS.map((w, i) => {
      const owned = !ownedWeapons || ownedWeapons.has(w);
      return `<span class="slot ${w === weapon ? 'active' : ''} ${owned ? '' : 'locked'}" style="${owned ? '' : 'opacity:0.32;filter:grayscale(1);'}"><b>${i + 1}</b>${weaponIconHtml(w)}</span>`;
    }).join('');
    $('reload-hint').classList.toggle('hidden', !(mag === 0 && reserve > 0 && !reloading));
  }

  setCrosshair(gapPx: number, visible: boolean): void {
    const ch = $('crosshair');
    ch.style.setProperty('--gap', `${Math.round(gapPx)}px`);
    ch.style.display = visible ? '' : 'none';
  }

  hitmarker(head: boolean, kill: boolean): void {
    const h = $('hitmarker');
    h.className = 'show' + (head ? ' head' : '') + (kill ? ' kill' : '');
    clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => {
      h.className = head ? 'head' : kill ? 'kill' : '';
    }, kill ? 220 : 90);
  }

  damage(angle: number): void {
    const el = document.createElement('div');
    el.className = 'dmg-ind';
    el.style.transform = `rotate(${-angle}rad)`;
    $('damage-indicators').appendChild(el);
    setTimeout(() => (el.style.opacity = '0'), 600);
    setTimeout(() => el.remove(), 1600);
    const f = $('damage-flash');
    f.classList.add('show');
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => f.classList.remove('show'), 80);
  }

  killfeed(e: KillEvent, myId: string): void {
    const kf = $('killfeed');
    const el = document.createElement('div');
    const isMeKiller = e.killer === myId;
    const isMeVictim = e.victim === myId;
    el.className = 'kf' + (isMeKiller || isMeVictim ? ' mine' : '') + (e.headshot ? ' hs-kill' : '');
    const self = e.killer === e.victim;
    el.innerHTML = self
      ? `${weaponBadgeHtml(e.weapon, false)}<span class="kf-name t-${e.victimTeam}">${esc(e.victimName)}</span>`
      : `<span class="kf-name t-${e.killerTeam}">${esc(e.killerName)}</span>${weaponBadgeHtml(e.weapon, e.headshot)}<span class="kf-name t-${e.victimTeam}">${esc(e.victimName)}</span>`;
    kf.appendChild(el);
    while (kf.children.length > 6) kf.firstElementChild?.remove();
    setTimeout(() => (el.style.opacity = '0'), 6500);
    setTimeout(() => el.remove(), 7100);
  }

  chat(m: ChatMsg): void {
    const log = $('chat-log');
    const el = document.createElement('div');
    el.className = 'chat-line' + (m.system ? ' sys' : '');
    el.innerHTML = m.system ? esc(m.text) : `<span class="t-${m.team}">${esc(m.name)}:</span> ${esc(m.text)}`;
    log.appendChild(el);
    while (log.children.length > 30) log.firstElementChild?.remove();
    setTimeout(() => el.classList.add('faded'), 9000);
  }

  setChatOpen(open: boolean): void {
    $('chat').classList.toggle('open', open);
    $('chat-input').classList.toggle('hidden', !open);
  }

  setMatch(m: MatchState, myTeam: Team, leader: number): void {
    const mm = Math.floor(m.timeLeft / 60);
    const ss = String(m.timeLeft % 60).padStart(2, '0');
    if (m.mode === 'forest_survival') {
      $('timer').textContent =
        m.phase === 'waiting'
          ? 'KUTILMOQDA'
          : m.phase === 'countdown' || m.phase === 'ended'
            ? `${m.timeLeft}s`
            : `${mm}:${ss}`;
      $('score-limit').textContent =
        m.phase === 'waiting'
          ? `Tayyor: ${m.readyCount ?? 0}/${m.minPlayers ?? 2}`
          : m.phase === 'countdown'
            ? 'boshlanishiga'
            : m.phase === 'ended'
              ? 'yangi raund'
              : `Raund #${m.roundId ?? 1}`;
      const red = $('score-red');
      const blue = $('score-blue');
      red.style.display = 'none';
      blue.style.display = '';
      blue.className = 'score';
      blue.textContent =
        m.phase === 'playing' || m.phase === 'ended'
          ? `Tirik: ${m.aliveCount ?? 0}/${m.totalContenders ?? 0}`
          : `Tayyor: ${m.readyCount ?? 0}/${m.minPlayers ?? 2}`;
      return;
    }
    $('timer').textContent = m.phase === 'ended' ? `${m.timeLeft}s` : `${mm}:${ss}`;
    $('score-limit').textContent = m.phase === 'ended' ? 'yangi raund' : `${m.scoreLimit} gacha`;
    const red = $('score-red');
    const blue = $('score-blue');
    if (m.mode === 'tdm') {
      red.style.display = '';
      blue.style.display = '';
      red.textContent = String(m.scores.red);
      blue.textContent = String(m.scores.blue);
    } else {
      red.style.display = 'none';
      blue.style.display = '';
      blue.className = 'score';
      blue.textContent = `Lider: ${leader}`;
    }
    void myTeam;
  }

  /** HUD joylashuv rejimi: survival'da TDM yuqori paneli va jamoa nishoni yashirinadi, loot rejimida takroriy slotlar olinadi. */
  setLayout(survival: boolean, lootMode: boolean): void {
    const hud = $('hud');
    hud.classList.toggle('survival', survival);
    hud.classList.toggle('loot', lootMode);
  }

  setTeamBadge(team: Team, mode: GameMode): void {
    const b = $('team-badge');
    if (mode === 'forest_survival') {
      // Survival'da yuqoridagi status paneli rejimni ko'rsatadi — pastdagi takroriy nishon kerak emas
      b.textContent = '';
      b.className = 't-none';
      b.style.display = 'none';
      return;
    }
    b.style.display = '';
    if (mode === 'ffa') {
      b.textContent = 'HAMMA HAMMAGA QARSHI';
      b.className = 't-none';
    } else {
      b.textContent = team === 'red' ? 'QIZIL JAMOA' : "KO'K JAMOA";
      b.className = `t-${team}`;
    }
  }

  scoreboard(show: boolean, roster: RosterEntry[], mode: GameMode, myId: string, m: MatchState | null, alive: Set<string>): void {
    const sb = $('scoreboard');
    sb.classList.toggle('hidden', !show);
    if (!show) return;
    const sorted = [...roster].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const table = (title: string, cls: string, list: RosterEntry[]) =>
      `<div class="sb-team ${cls}"><div class="sb-title">${title}</div><table><tr><th>O'yinchi</th><th>Qotil</th><th>O'lim</th><th>Ping</th></tr>${list
        .map(
          (r) =>
            `<tr class="${r.id === myId ? 'me' : ''} ${alive.has(r.id) ? '' : 'dead'}"><td>${esc(r.name)}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.isBot ? 'BOT' : r.ping}</td></tr>`,
        )
        .join('')}</table></div>`;
    sb.innerHTML =
      mode === 'tdm'
        ? table(`QIZIL — ${m?.scores.red ?? 0}`, 'red', sorted.filter((r) => r.team === 'red')) +
          table(`KO'K — ${m?.scores.blue ?? 0}`, 'blue', sorted.filter((r) => r.team === 'blue'))
        : mode === 'forest_survival'
          ? table(`🌲 FOREST SURVIVAL — RAUND #${m?.roundId ?? 1}`, 'ffa', sorted)
          : table('HAMMA HAMMAGA QARSHI', 'ffa', sorted);
  }

  death(show: boolean, killer = '', seconds = 0): void {
    $('death-screen').classList.toggle('hidden', !show);
    if (!show) return;
    $('death-killer').innerHTML = killer;
    $('respawn-timer').textContent = seconds > 0 ? `Qayta tug'ilish: ${seconds.toFixed(1)} s` : 'Kutilmoqda...';
  }

  center(html: string | null, seconds = 0): void {
    const c = $('center-msg');
    clearTimeout(this.centerTimer);
    if (!html) {
      c.classList.add('hidden');
      return;
    }
    c.innerHTML = html;
    c.classList.remove('hidden');
    if (seconds > 0) this.centerTimer = window.setTimeout(() => c.classList.add('hidden'), seconds * 1000);
  }

  scope(show: boolean): void {
    $('scope-overlay').classList.toggle('hidden', !show);
  }

  setDevStats(text: string | null): void {
    const el = $('dev-stats');
    el.classList.toggle('hidden', !text);
    if (text) el.textContent = text;
  }

  reset(): void {
    $('killfeed').innerHTML = '';
    $('chat-log').innerHTML = '';
    $('damage-indicators').innerHTML = '';
    this.center(null);
    this.death(false);
    this.scope(false);
    this.setDevStats(null);
    this.lastHp = -1;
    this.lastAmmoKey = '';
  }
}
