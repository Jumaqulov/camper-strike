import type { GameMode } from '../../../shared/constants';
import {
  SURVIVAL_PHASE_LABELS_UZ,
  SURVIVAL_WIN_REASON_LABELS_UZ,
  formatZoneStatusUz,
  type SurvivalPhase,
  type SurvivalPlayerRole,
  type SurvivalPlayerStatusSnap,
  type SurvivalStateSnap,
  type SurvivalWinReason,
} from '../../../shared/survival';
import type { NightSnap } from '../../../shared/wolf/night';
import { CAMPFIRE_LOW_FUEL_SEC } from '../../../shared/wolf/camp';
import { buildNightSummaryBoardHtml, escHtml as esc, nightSummaryKey } from './nightResults';
import { formatFireIndicatorsUz, type FireIndicatorInput, type FireIndicatorView } from './campHud';
import type { SpectatorCameraPose } from './SpectatorController';
import { dawnEpilogueActive } from '../night/dawnEpilogue';

/** Gulxanlar qatori DOM'i eng ko'pi bilan shuncha ms da bir yangilanadi (strelkalar har kadr aylanmasin). */
const FIRE_ROW_UPDATE_MS = 100;

/** Lager holati (Game har kadr beradi): asosiy gulxan o'tini, eng yaqin g'aram, qo'ldagi mash'al, faol raketa, uchala gulxan. */
export interface CampHudStatus {
  fuelSec: number;
  lit: boolean;
  pileM?: number | null;
  torchSec?: number;
  flareSec?: number;
  /** Uchala gulxan (yo'nalish/masofa o'yinchiga nisbatan) — gulxanlar qatori uchun. */
  fires?: readonly FireIndicatorInput[];
}

const FIRE_ARROW_SVG = (id: string, deg: number) =>
  `<svg class="s07-fire-arrow" viewBox="0 0 16 16" aria-hidden="true"><g data-fire="${esc(id)}" transform="rotate(${deg} 8 8)"><path d="M8 1.2 12.6 13.2 8 10.5 3.4 13.2Z"/></g></svg>`;
const FIRE_FLAME_SVG =
  '<svg class="s07-fire-flame" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1c.9 2.6 4.2 4.1 4.2 7.6A4.2 4.2 0 0 1 3.8 8.6c0-1.4.5-2.5 1.3-3.5.2 1 .8 1.9 1.7 2.3C6.5 4.9 7.4 2.9 8 1z"/><path class="s07-fire-flame-core" d="M8 7.2c.5 1.2 1.6 1.8 1.6 3.1a1.6 1.6 0 1 1-3.2 0c0-.6.2-1.1.6-1.5.1.4.3.7.6.9C7.5 8.9 7.8 8 8 7.2z"/></svg>';

/** Bitta gulxan indikatori HTML'i (sof; testlar uchun eksport). */
export function fireIndicatorHtml(v: FireIndicatorView): string {
  return `<div class="s07-fire is-${v.state}${v.main ? ' is-main' : ''}" data-fire="${esc(v.id)}" title="${esc(v.name)}">${FIRE_ARROW_SVG(
    v.id,
    v.arrowDeg,
  )}<span class="s07-fire-icon">${FIRE_FLAME_SVG}<span class="s07-fire-x" aria-hidden="true">✕</span></span><span class="s07-fire-tag">${
    v.main ? '<i class="s07-fire-crown" title="Asosiy lager">★</i>' : ''
  }${esc(v.tag)}</span><span class="s07-fire-fuel">${esc(v.fuelText)}</span><span class="s07-fire-dist">${esc(v.distText)}</span></div>`;
}

/** "Tong otguncha" yuqori pill matni: 🌙 Tonggacha mm:ss · 2/4-to'lqin · 🐺 2 */
function formatNightPillUz(n: NightSnap): string {
  const total = Math.max(0, Math.floor(n.dawnInSec));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `🌙 Tonggacha ${mm}:${ss} · ${n.wave}/${n.waveCount}-to'lqin · 🐺 ${n.wolvesAlive}`;
}

/** Asosiy lager gulxani holati (pill): "🔥 Lager m:ss" (kam o'tin — 'low'), o'chgan — "🔥 O'CHDI" ('out'). */
export function formatCampPillUz(
  fuelSec: number,
  lit: boolean,
  pileM: number | null = null,
): { text: string; cls: '' | 'low' | 'out' } {
  // Eng yaqin o'tin g'aramigacha masofa (qo'l to'la bo'lmasa) — o'tin topish oson bo'lsin
  const pile = pileM !== null ? ` · 🪵 ${Math.round(pileM)} m` : '';
  if (!lit || fuelSec <= 0) return { text: `🔥 O'CHDI${pile}`, cls: 'out' };
  const total = Math.max(0, Math.floor(fuelSec));
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return { text: `🔥 Lager ${mm}:${ss}${pile}`, cls: fuelSec < CAMPFIRE_LOW_FUEL_SEC ? 'low' : '' };
}

/**
 * Qo'ldagi mash'al pilli: "🔥 Mash'al 32 s · [F] tashlash" (oxirgi 8 s — 'low'); mash'al yo'q — null. F mash'alni
 * istalgan joyda tashlaydi — mash'al qo'lda ekan, ishora doim ko'rinib turadi. Sof funksiya (testlar uchun).
 */
export function formatTorchPillUz(torchSec: number): { text: string; cls: '' | 'low' } | null {
  if (!Number.isFinite(torchSec) || torchSec <= 0) return null;
  const s = Math.max(1, Math.ceil(torchSec));
  return { text: `🔥 Mash'al ${s} s · [F] tashlash`, cls: s <= 8 ? 'low' : '' };
}

/**
 * Faol signal raketasi pilli (hammaga — raketa xaritadagi hamma bo'rilarni qo'rqitadi, qayerda turishdan qat'i
 * nazar): "🎇 Bo'rilar qochmoqda 14 s" (oxirgi 5 s — 'low'); raketa yo'q — null. Sof funksiya (testlar uchun).
 */
export function formatFlarePillUz(flareSec: number): { text: string; cls: '' | 'low' } | null {
  if (!Number.isFinite(flareSec) || flareSec <= 0) return null;
  const s = Math.max(1, Math.ceil(flareSec));
  return { text: `🎇 Bo'rilar qochmoqda ${s} s`, cls: s <= 5 ? 'low' : '' };
}

/**
 * Safdan chiqqan o'yinchiga qaytish qatori (Tong otguncha): keyingi to'lqin boshida asosiy gulxan yonib tursa
 * qaytadi; oxirgi to'lqinda — tong otguncha tomosha qiladi; hamma halok bo'lgan bo'lsa — alohida urg'u.
 * Sof funksiya (testlar uchun); `aliveCount` — hozir tirik ishtirokchilar.
 */
export function formatNightRespawnLineUz(
  n: NightSnap,
  aliveCount: number,
): { text: string; cls: '' | 'is-out' | 'is-all-dead' } {
  if (n.wave >= n.waveCount) return { text: '🌅 Tong otguncha tomosha qilasiz', cls: 'is-out' };
  const total = Math.max(0, Math.floor(n.nextWaveInSec));
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  const mainLit = n.fires.some((f) => f.main && f.lit);
  if (!mainLit) {
    return { text: `🌑 Asosiy gulxan o'chgan — keyingi to'lqinda qaytish yo'q (yoqilsa qaytasiz) — ${mm}:${ss}`, cls: 'is-out' };
  }
  if (aliveCount <= 0) {
    return { text: `💀 Hamma halok bo'ldi — keyingi to'lqinda qaytasiz (gulxan yonib tursa) — ${mm}:${ss}`, cls: 'is-all-dead' };
  }
  return { text: `🔥 Keyingi to'lqinda qaytasiz (asosiy gulxan yonib tursa) — ${mm}:${ss}`, cls: '' };
}

/** Tun natijasi pastidagi chiziq: keyingi tungacha qolgan vaqt ulushi, % (natija ekrani 10 s turadi). */
function winBarPercent(timeLeft: number): string {
  return (Math.max(0, Math.min(1, timeLeft / 10)) * 100).toFixed(0);
}

export interface SurvivalUICallbacks {
  onCycleSpectatorTarget: (delta: number) => void;
  onToggleCameraPerspective: () => void;
}

export interface SurvivalUIDiagnostics {
  visible: boolean;
  roundId: number;
  phase: SurvivalPhase | null;
  aliveCount: number;
  totalContenders: number;
  readyCount: number;
  minPlayers: number;
  myRole: SurvivalPlayerRole | null;
  spectatorBannerVisible: boolean;
  spectatedTargetId: string | null;
  spectatedTargetName: string | null;
  winnerOverlayVisible: boolean;
  winnerId: string | null;
  winnerName: string;
  winReason: SurvivalWinReason;
  topStatusText: string;
  preRoundBannerText: string;
}

export class SurvivalUI {
  private readonly callbacks: SurvivalUICallbacks;
  private rootEl: HTMLElement | null = null;
  private topPillEl: HTMLElement | null = null;
  private preRoundBannerEl: HTMLElement | null = null;
  private spectatorPanelEl: HTMLElement | null = null;
  private specRoleEl: HTMLElement | null = null;
  private specKillerEl: HTMLElement | null = null;
  private specTargetEl: HTMLElement | null = null;
  /** wolf_night: safdan chiqqan o'yinchiga "keyingi to'lqinda qaytasiz" qatori. */
  private specRespawnEl: HTMLElement | null = null;
  private lastRespawnKey = '';
  private winnerOverlayEl: HTMLElement | null = null;

  private visible = false;
  /** Xona rejimi — wolf_night bo'lsa tun matnlari/natija ekranlari ('playing' dan oldin ham ma'lum). */
  private mode: GameMode = 'forest_survival';
  private snap: SurvivalStateSnap | null = null;
  private myId = '';
  private myRole: SurvivalPlayerRole | null = null;
  private spectatorPose: SpectatorCameraPose | null = null;
  private killerHtml = '';
  /** Lager holati (Game har kadr ekstrapolyatsiya qilib beradi); null — lager yo'q. */
  private camp: CampHudStatus | null = null;
  /** Uchala gulxan indikatorlari qatori (yuqori pill ostida). */
  private fireRowEl: HTMLElement | null = null;
  private lastFireRowKey = '';
  private lastFireRowAt = 0;
  /** Strelka <g> elementlari (gulxan id → element) — faqat burilish o'zgarganda setAttribute. */
  private fireArrowEls = new Map<string, Element>();
  private lastFireArrowDeg = new Map<string, number>();

  private spectatorBannerVisible = false;
  private winnerOverlayVisible = false;
  private topStatusText = '';
  private preRoundBannerText = '';
  // DOM faqat mazmun o'zgarganda yangilanadi (update() har kadr chaqiriladi — innerHTML har kadr qimmat)
  private lastRootHidden: boolean | null = null;
  private lastPillKey = '';
  private lastBannerKey = '';
  private lastSpecKey = '';
  private lastWinKey = '';
  /** Tun natijasi varag'ining taymersiz mazmuni: o'zgarmasa har soniyada faqat pastki taymer yangilanadi. */
  private lastNightSheetKey = '';

  constructor(callbacks: SurvivalUICallbacks) {
    this.callbacks = callbacks;
    this.mountDom();
  }

  private mountDom(): void {
    if (typeof document === 'undefined') return;

    const existing = document.getElementById('stage07-survival-hud');
    if (existing) existing.remove();

    const host = document.getElementById('hud') ?? document.body;
    const root = document.createElement('div');
    root.id = 'stage07-survival-hud';
    root.className = 'hidden';

    const topPill = document.createElement('div');
    topPill.id = 'stage07-top-pill';

    const fireRow = document.createElement('div');
    fireRow.id = 'stage07-fire-row';
    fireRow.className = 'hidden';

    const preRoundBanner = document.createElement('div');
    preRoundBanner.id = 'stage07-preround-banner';
    preRoundBanner.className = 'hidden';

    const spectatorPanel = document.createElement('div');
    spectatorPanel.id = 'stage07-spectator-panel';
    spectatorPanel.className = 'hidden';
    spectatorPanel.innerHTML = `
      <div id="stage07-spec-role"></div>
      <div id="stage07-spec-killer" class="hidden"></div>
      <div id="stage07-spec-respawn" class="hidden"></div>
      <div id="stage07-spec-target"></div>
      <div class="s07-spec-controls">
        <button type="button" id="stage07-spec-prev" class="s07-spec-btn">◀ Oldingi [A]</button>
        <button type="button" id="stage07-spec-cam" class="s07-spec-btn">Kamera 1P/3P [V]</button>
        <button type="button" id="stage07-spec-next" class="s07-spec-btn">Keyingi [D] ▶</button>
      </div>
    `;

    const winnerOverlay = document.createElement('div');
    winnerOverlay.id = 'stage07-winner-overlay';
    winnerOverlay.className = 'hidden';

    root.appendChild(topPill);
    root.appendChild(fireRow);
    root.appendChild(preRoundBanner);
    root.appendChild(spectatorPanel);
    root.appendChild(winnerOverlay);
    host.appendChild(root);

    this.rootEl = root;
    this.topPillEl = topPill;
    this.fireRowEl = fireRow;
    this.preRoundBannerEl = preRoundBanner;
    this.spectatorPanelEl = spectatorPanel;
    this.specRoleEl = spectatorPanel.querySelector('#stage07-spec-role');
    this.specKillerEl = spectatorPanel.querySelector('#stage07-spec-killer');
    this.specTargetEl = spectatorPanel.querySelector('#stage07-spec-target');
    this.specRespawnEl = spectatorPanel.querySelector('#stage07-spec-respawn');
    this.winnerOverlayEl = winnerOverlay;

    const prevBtn = spectatorPanel.querySelector<HTMLButtonElement>('#stage07-spec-prev');
    const camBtn = spectatorPanel.querySelector<HTMLButtonElement>('#stage07-spec-cam');
    const nextBtn = spectatorPanel.querySelector<HTMLButtonElement>('#stage07-spec-next');

    prevBtn?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.callbacks.onCycleSpectatorTarget(-1);
    });
    camBtn?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.callbacks.onToggleCameraPerspective();
    });
    nextBtn?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.callbacks.onCycleSpectatorTarget(1);
    });
  }

  /** Xona rejimini o'rnatish (Game konstruktorida, birinchi snapshot kelmasidan oldin). */
  setMode(mode: GameMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // Kesh kalitlari rejimga bog'liq emas — majburan qayta chizish
    this.lastPillKey = '';
    this.lastBannerKey = '';
    this.lastWinKey = '';
    this.lastNightSheetKey = '';
    this.render();
  }

  private get isNight(): boolean {
    return this.mode === 'wolf_night';
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.render();
  }

  /**
   * Lager holati (tun rejimi): asosiy gulxan pill'da "🔥 Lager m:ss", `torchSec` — "🔥 Mash'al N s", `flareSec` —
   * raketa; `fires` — uchala gulxan indikatorlari qatori (pill ostida).
   */
  setCampStatus(camp: CampHudStatus | null): void {
    this.camp = camp;
  }

  /**
   * Gulxanlar qatori: tuzilma (nom/holat/o'tin/masofa) o'zgarganda innerHTML, strelkalar esa faqat burilish
   * o'zgarganda setAttribute; hammasi eng ko'pi FIRE_ROW_UPDATE_MS da bir. Bo'sh ro'yxat — yashirinadi.
   */
  private renderFireRow(fires: readonly FireIndicatorInput[]): void {
    const el = this.fireRowEl;
    if (!el) return;
    if (!fires.length) {
      if (this.lastFireRowKey !== '') {
        this.lastFireRowKey = '';
        this.lastFireRowAt = 0;
        this.fireArrowEls.clear();
        this.lastFireArrowDeg.clear();
        el.className = 'hidden';
        el.innerHTML = '';
      }
      return;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.lastFireRowKey !== '' && now - this.lastFireRowAt < FIRE_ROW_UPDATE_MS) return;
    this.lastFireRowAt = now;
    const views = formatFireIndicatorsUz(fires);
    const key = views.map((v) => `${v.id}|${v.main ? 1 : 0}|${v.state}|${v.tag}|${v.fuelText}|${v.distText}`).join(';');
    if (key !== this.lastFireRowKey) {
      this.lastFireRowKey = key;
      el.innerHTML = views.map(fireIndicatorHtml).join('');
      el.className = '';
      this.fireArrowEls.clear();
      this.lastFireArrowDeg.clear();
      const gs = typeof el.querySelectorAll === 'function' ? el.querySelectorAll('.s07-fire-arrow g[data-fire]') : null;
      gs?.forEach((g) => {
        const id = g.getAttribute('data-fire');
        if (id) this.fireArrowEls.set(id, g);
      });
      for (const v of views) this.lastFireArrowDeg.set(v.id, v.arrowDeg);
      return;
    }
    for (const v of views) {
      if (this.lastFireArrowDeg.get(v.id) === v.arrowDeg) continue;
      this.lastFireArrowDeg.set(v.id, v.arrowDeg);
      this.fireArrowEls.get(v.id)?.setAttribute('transform', `rotate(${v.arrowDeg} 8 8)`);
    }
  }

  update(
    snap: SurvivalStateSnap | null,
    myId: string,
    spectatorPose: SpectatorCameraPose | null,
    killerHtml?: string,
  ): void {
    this.snap = snap;
    this.myId = myId;
    this.spectatorPose = spectatorPose;
    if (killerHtml !== undefined) {
      this.killerHtml = killerHtml;
    }
    this.render();
  }

  private resolveMyStatus(snap: SurvivalStateSnap, myId: string): SurvivalPlayerStatusSnap | null {
    const found = snap.players.find((p) => p.id === myId);
    if (found) return found;
    if (snap.spectatorIds.includes(myId)) {
      return {
        id: myId,
        name: '',
        role: 'spectator',
        alive: false,
        ready: false,
        kills: 0,
        deaths: 0,
      };
    }
    if (snap.contenderIds.includes(myId)) {
      const alive = snap.aliveIds.includes(myId);
      return {
        id: myId,
        name: '',
        role: alive ? 'contender' : 'eliminated',
        alive,
        ready: true,
        kills: 0,
        deaths: 0,
      };
    }
    if (snap.phase === 'waiting' || snap.phase === 'countdown') {
      return {
        id: myId,
        name: '',
        role: 'waiting',
        alive: true,
        ready: true,
        kills: 0,
        deaths: 0,
      };
    }
    return null;
  }

  private render(): void {
    const snap = this.snap;
    if (!this.visible || !snap) {
      this.myRole = null;
      this.spectatorBannerVisible = false;
      this.winnerOverlayVisible = false;
      this.topStatusText = '';
      this.preRoundBannerText = '';
      if (this.rootEl && this.lastRootHidden !== true) {
        this.rootEl.className = 'hidden';
        this.lastRootHidden = true;
      }
      this.renderFireRow([]);
      return;
    }

    if (this.rootEl && this.lastRootHidden !== false) {
      this.rootEl.className = '';
      this.lastRootHidden = false;
    }

    const myStatus = this.resolveMyStatus(snap, this.myId);
    this.myRole = myStatus ? myStatus.role : null;

    // 1. Top Pill
    const night = this.isNight;
    const phaseLabel =
      night && snap.phase === 'playing'
        ? 'TUN DAVOM ETMOQDA'
        : SURVIVAL_PHASE_LABELS_UZ[snap.phase] ?? snap.phase.toUpperCase();
    const countLabel =
      snap.phase === 'waiting' || snap.phase === 'countdown'
        ? (snap.minHumans ?? 1) > 1 && (snap.readyHumans ?? 0) < (snap.minHumans ?? 1)
          ? `Odamlar: ${snap.readyHumans ?? 0}/${snap.minHumans}`
          : `Tayyor: ${snap.readyCount}/${snap.minPlayers}`
        : `Tirik: ${snap.aliveCount}/${snap.totalContenders}`;
    this.topStatusText = `RAUND #${snap.roundId} · ${phaseLabel} · ${countLabel}`;

    // Tunda zona yo'q — pillda to'lqin/tong ma'lumoti ko'rsatiladi
    const nightText = night && snap.phase === 'playing' && snap.night ? formatNightPillUz(snap.night) : '';
    const campPill = night && snap.phase === 'playing' && this.camp ? formatCampPillUz(this.camp.fuelSec, this.camp.lit, this.camp.pileM ?? null) : null;
    const torchPill = night && snap.phase === 'playing' && this.camp ? formatTorchPillUz(this.camp.torchSec ?? 0) : null;
    const flarePill = night && snap.phase === 'playing' && this.camp ? formatFlarePillUz(this.camp.flareSec ?? 0) : null;
    const pillKey = `${snap.roundId}|${snap.phase}|${snap.timeLeft}|${countLabel}|${
      !night && snap.phase === 'playing' && snap.zone
        ? `${formatZoneStatusUz(snap.zone)}|${snap.zone.shrinking ? 1 : 0}`
        : ''
    }${night ? `|${phaseLabel}|${nightText}|${campPill ? `${campPill.text}|${campPill.cls}` : ''}|${torchPill ? `${torchPill.text}|${torchPill.cls}` : ''}|${flarePill ? `${flarePill.text}|${flarePill.cls}` : ''}` : ''}`;
    if (this.topPillEl && pillKey !== this.lastPillKey) {
      this.lastPillKey = pillKey;
      // Vaqt segmenti: countdown/ended — soniya, playing — mm:ss, waiting — ko'rsatilmaydi
      let timeHtml = '';
      if (snap.phase === 'countdown' || snap.phase === 'ended') {
        timeHtml = `<span class="s07-pill-time${snap.timeLeft <= 5 ? ' urgent' : ''}">${snap.timeLeft}s</span>`;
      } else if (snap.phase === 'playing') {
        const mm = Math.floor(snap.timeLeft / 60);
        const ss = String(Math.max(0, snap.timeLeft % 60)).padStart(2, '0');
        timeHtml = `<span class="s07-pill-time${snap.timeLeft <= 30 ? ' urgent' : ''}">${mm}:${ss}</span>`;
      }
      this.topPillEl.innerHTML = `
        <span class="s07-pill-round">Raund ${snap.roundId}</span>
        ${timeHtml}
        <span class="s07-pill-phase phase-${esc(snap.phase)}">${esc(phaseLabel)}</span>
        <span class="s07-pill-count">${esc(countLabel)}</span>
        ${
          night
            ? `${nightText ? `<span class="s07-pill-night">${esc(nightText)}</span>` : ''}${
                campPill ? `<span class="s07-pill-camp ${campPill.cls}">${esc(campPill.text)}</span>` : ''
              }${torchPill ? `<span class="s07-pill-torch ${torchPill.cls}">${esc(torchPill.text)}</span>` : ''}${
                flarePill ? `<span class="s07-pill-flare ${flarePill.cls}">${esc(flarePill.text)}</span>` : ''
              }`
            : snap.phase === 'playing' && snap.zone
              ? `<span class="s07-pill-zone${snap.zone.shrinking ? ' shrinking' : ''}">${esc(formatZoneStatusUz(snap.zone))}</span>`
              : ''
        }
      `;
    }
    // 1b. Uchala gulxan indikatorlari (faqat tunda, raund davomida)
    this.renderFireRow(night && snap.phase === 'playing' && this.camp?.fires ? this.camp.fires : []);

    // 2. Pre-Round Banner
    if (snap.phase === 'waiting' || snap.phase === 'countdown') {
      const needHumans = (snap.minHumans ?? 1) > 1 && (snap.readyHumans ?? 0) < (snap.minHumans ?? 1);
      const title = night
        ? snap.phase === 'waiting'
          ? `Tun boshlanishini kutamiz · ${needHumans ? `${snap.readyHumans ?? 0}/${snap.minHumans} odam` : `${snap.readyCount}/${snap.minPlayers}`}`
          : `Tun boshlanishiga ${snap.timeLeft} s`
        : snap.phase === 'waiting'
          ? needHumans
            ? `Odamlar kutilmoqda · ${snap.readyHumans ?? 0}/${snap.minHumans}`
            : `O'yinchilar kutilmoqda · ${snap.readyCount}/${snap.minPlayers}`
          : `Raund boshlanmoqda`;
      const subtitle = night
        ? snap.phase === 'waiting'
          ? `Tayyor bo'ling — bo'rilar to'lqin bo'lib keladi, tong otguncha omon qoling`
          : `Bo'rilar kelmoqda — konteynerlarni [E] bilan oching, birga himoyalaning`
        : snap.phase === 'waiting'
          ? (snap.minHumans ?? 1) > 1
            ? `Kamida ${snap.minHumans} odam kerak · hamma qurolsiz boshlaydi`
            : `Kamida ${snap.minPlayers} o'yinchi kerak · hamma qurolsiz boshlaydi`
          : `Konteynerlarni [E] bilan oching · oxirgi tirik qolgan g'olib`;

      this.preRoundBannerText = `${title} — ${subtitle}`;
      const bannerKey = `${snap.phase}|${title}`;
      if (this.preRoundBannerEl && bannerKey !== this.lastBannerKey) {
        this.lastBannerKey = bannerKey;
        this.preRoundBannerEl.className = `phase-${snap.phase}`;
        this.preRoundBannerEl.innerHTML = `
          <div class="s07-preround-title">${esc(title)}</div>
          <div class="s07-preround-sub">${esc(subtitle)}</div>
        `;
      }
    } else {
      this.preRoundBannerText = '';
      if (this.preRoundBannerEl && this.lastBannerKey !== 'hidden') {
        this.lastBannerKey = 'hidden';
        this.preRoundBannerEl.className = 'hidden';
        this.preRoundBannerEl.innerHTML = '';
      }
    }

    // 3. Spectator Panel
    const showSpectator = this.myRole === 'eliminated' || this.myRole === 'spectator';
    this.spectatorBannerVisible = showSpectator;

    const pose = this.spectatorPose;
    const specKey = `${showSpectator ? 1 : 0}|${this.myRole}|${myStatus?.placement ?? ''}|${this.killerHtml}|${
      myStatus?.eliminatedBy ?? ''
    }|${pose ? `${pose.targetId}|${pose.targetName ?? ''}|${Math.round(pose.targetHp)}|${pose.thirdPerson ? 1 : 0}` : ''}`;
    if (this.spectatorPanelEl && specKey !== this.lastSpecKey) {
      this.lastSpecKey = specKey;
      if (showSpectator) {
        this.spectatorPanelEl.className = '';
        if (this.specRoleEl) {
          if (this.myRole === 'eliminated') {
            const placementSuffix =
              myStatus?.placement !== undefined ? ` (#${myStatus.placement}-o'rin)` : '';
            this.specRoleEl.className = 'eliminated';
            this.specRoleEl.textContent = `👁 SIZ SAFDAN CHIQDINGIZ${placementSuffix} — KUZATUVCHI REJIMI`;
          } else {
            this.specRoleEl.className = '';
            this.specRoleEl.textContent =
              '👁 KUZATUVCHI REJIMI — JORIY RAUND DAVOM ETMOQDA (Keyingi raundda qatnashasiz)';
          }
        }

        if (this.specKillerEl) {
          if (this.myRole === 'eliminated' && this.killerHtml) {
            this.specKillerEl.className = '';
            this.specKillerEl.innerHTML = this.killerHtml;
          } else if (this.myRole === 'eliminated' && myStatus?.eliminatedBy) {
            this.specKillerEl.className = '';
            this.specKillerEl.textContent = `Sababchi: ${myStatus.eliminatedBy}`;
          } else {
            this.specKillerEl.className = 'hidden';
            this.specKillerEl.textContent = '';
          }
        }

        if (this.specTargetEl) {
          const pose = this.spectatorPose;
          if (pose && pose.targetId) {
            const hp = Math.max(0, Math.round(pose.targetHp));
            const camMode = pose.thirdPerson ? '3-shaxs' : '1-shaxs';
            this.specTargetEl.textContent = `🎥 Kuzatilmoqda: ${pose.targetName ?? pose.targetId} · ❤️ ${hp} HP · ${camMode}`;
          } else {
            this.specTargetEl.textContent = '🎥 Erkin kuzatuv kamerasi';
          }
        }
      } else {
        this.spectatorPanelEl.className = 'hidden';
      }
    }

    // 3b. Tong otguncha: safdan chiqqan o'yinchiga qaytish qatori (har soniya yangilanadi — alohida kalit)
    if (this.specRespawnEl) {
      const line = showSpectator && night && this.myRole === 'eliminated' && snap.phase === 'playing' && snap.night
        ? formatNightRespawnLineUz(snap.night, snap.aliveCount)
        : null;
      const key = line ? `${line.cls}|${line.text}` : '';
      if (key !== this.lastRespawnKey) {
        this.lastRespawnKey = key;
        if (line) {
          this.specRespawnEl.className = line.cls;
          this.specRespawnEl.textContent = line.text;
        } else {
          this.specRespawnEl.className = 'hidden';
          this.specRespawnEl.textContent = '';
        }
      }
    }

    // 4. Winner / Round-End Overlay
    const showWinner = snap.phase === 'ended';
    this.winnerOverlayVisible = showWinner;

    // Tun natijasi (statistika va mukofotlar) — server faqat wolf_night 'ended' fazasida yuboradi
    const nightSummary = showWinner && night ? snap.nightSummary ?? null : null;
    const nightSheet =
      showWinner &&
      night &&
      (nightSummary !== null || snap.winReason === 'dawn' || snap.winReason === 'draw_no_survivors');
    // Tong epilogi: natija varag'i hali chiqmaydi — faqat "Tong otdi!" belgisi (bo'rilar uvlab qochayotgani ko'rinsin)
    const dawnEpilogue = nightSheet && dawnEpilogueActive(snap);
    // Mazmun kaliti taymersiz: tun varag'ida faqat soniya o'zgarsa varaq qayta qurilmaydi (pastki taymer yangilanadi)
    const winContentKey = showWinner
      ? `1|${snap.winnerId}|${snap.winnerName}|${snap.winReason}|${snap.players
          .map((p) => `${p.id}:${p.role}:${p.alive ? 1 : 0}:${p.kills}:${p.deaths}:${p.placement ?? ''}`)
          .join(',')}${night ? `|${(snap.winnerIds ?? []).join(',')}|${nightSummaryKey(nightSummary)}` : ''}`
      : '0';
    const winKey = showWinner ? `${winContentKey}|${dawnEpilogue ? 'epilogue' : snap.timeLeft}` : '0';
    if (this.winnerOverlayEl && winKey !== this.lastWinKey) {
      this.lastWinKey = winKey;
      if (dawnEpilogue) {
        // Varaq epilogdan keyin noldan quriladi (pastki taymer bilan)
        this.lastNightSheetKey = '';
        this.winnerOverlayEl.className = 'is-dawn-epilogue';
        this.winnerOverlayEl.innerHTML = this.renderDawnEpilogueHtml(snap);
      } else if (nightSheet) {
        const cls = nightSummary ? 'is-night-summary' : '';
        if (this.winnerOverlayEl.className !== cls) this.winnerOverlayEl.className = cls;
        if (winContentKey !== this.lastNightSheetKey) {
          this.lastNightSheetKey = winContentKey;
          this.winnerOverlayEl.innerHTML = this.renderNightResultHtml(snap);
        } else {
          // Faqat taymer o'zgardi — jadval aylantirilgan joyidan sakramasin, chiziq silliq qisqarsin
          this.updateWinFooter(snap.timeLeft);
        }
      } else if (showWinner) {
        this.lastNightSheetKey = '';
        this.winnerOverlayEl.className = '';
        const isDraw = snap.winnerId === null || snap.winnerName === 'draw' || !snap.winnerName;
        // Yog'och lager belgisi: katta sarlavha (bo'yalgan taxta) + ostida izoh
        const headerText = isDraw
          ? 'DURRANG'
          : snap.winnerId === this.myId
            ? "G'ALABA!"
            : "RAUND G'OLIBI";
        const headerSub = isDraw
          ? "G'olib aniqlanmadi"
          : snap.winnerId === this.myId
            ? "Siz oxirgi tirik qolgan o'yinchisiz"
            : esc(snap.winnerName);
        const headerIcon = isDraw ? '⚖️' : '🏆';
        const signCls = isDraw ? 'is-draw' : snap.winnerId === this.myId ? 'is-victory' : 'is-other';

        const reasonLabel =
          SURVIVAL_WIN_REASON_LABELS_UZ[snap.winReason] ?? snap.statusTextUz ?? '';

        const sortedPlayers = [...snap.players].sort((a, b) => {
          if (a.id === snap.winnerId) return -1;
          if (b.id === snap.winnerId) return 1;
          if (a.role === 'spectator' && b.role !== 'spectator') return 1;
          if (b.role === 'spectator' && a.role !== 'spectator') return -1;
          if (a.placement !== undefined && b.placement !== undefined) {
            return a.placement - b.placement;
          }
          if (a.alive !== b.alive) return a.alive ? -1 : 1;
          return b.kills - a.kills || a.deaths - b.deaths;
        });

        const rowsHtml = sortedPlayers
          .map((p, idx) => {
            const isWinner = snap.winnerId !== null && p.id === snap.winnerId;
            const isMe = p.id === this.myId;
            const placeText = isWinner
              ? '#1'
              : p.placement !== undefined
                ? `#${p.placement}`
                : p.role === 'spectator'
                  ? '—'
                  : `#${idx + 1}`;
            const statusText = isWinner
              ? "🏆 G'olib"
              : p.role === 'spectator'
                ? '👁 Kuzatuvchi'
                : p.alive
                  ? '🛡 Tirik'
                  : '💀 Safdan chiqdi';
            const rowCls = `${isWinner ? 'is-winner' : ''} ${isMe ? 'is-me' : ''} ${
              !isWinner && !p.alive && p.role !== 'spectator' ? 'is-out' : ''
            }`.trim();
            return `
              <tr class="${rowCls}">
                <td><span class="s07-rank">${esc(placeText)}</span></td>
                <td class="s07-name">${esc(p.name)}${isMe ? '<span class="s07-tag">Siz</span>' : ''}</td>
                <td>${esc(statusText)}</td>
                <td class="s07-kills">${p.kills}</td>
              </tr>
            `;
          })
          .join('');

        // Keyingi raundgacha qolgan vaqt (natija ekrani 10 s turadi)
        const progress = Math.max(0, Math.min(1, snap.timeLeft / 10));
        this.winnerOverlayEl.innerHTML = `
          <div class="s07-win-sign ${signCls}">
            <span class="s07-win-icon">${headerIcon}</span>
            <span class="s07-win-title">${headerText}</span>
          </div>
          <div class="s07-win-sub">${headerSub}</div>
          <div class="s07-win-reason">${esc(reasonLabel)}</div>
          <div class="s07-win-board">
            <table class="s07-win-table">
              <thead>
                <tr>
                  <th>O'rin</th>
                  <th>O'yinchi</th>
                  <th>Holat</th>
                  <th class="s07-kills">Qotil</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
          <div class="s07-win-footer">
            <span>Keyingi raund <b>${snap.timeLeft}</b> soniyadan keyin boshlanadi</span>
            <span class="s07-win-bar"><i style="width:${(progress * 100).toFixed(0)}%"></i></span>
          </div>
        `;
      } else {
        this.lastNightSheetKey = '';
        this.winnerOverlayEl.className = 'hidden';
        this.winnerOverlayEl.innerHTML = '';
      }
    }
  }

  /** Natija varag'i pastidagi taymer (soniya va chiziq) — varaqni qayta qurmasdan. */
  private updateWinFooter(timeLeft: number): void {
    const el = this.winnerOverlayEl;
    if (!el) return;
    const secEl = el.querySelector<HTMLElement>('.s07-win-footer b');
    if (secEl) secEl.textContent = String(timeLeft);
    const barEl = el.querySelector<HTMLElement>('.s07-win-bar i');
    if (barEl) barEl.style.width = `${winBarPercent(timeLeft)}%`;
  }

  /**
   * "Tong otguncha" natija ekrani:
   *  - 'dawn' — tong otdi: barcha tiriklar (winnerIds) birga g'olib (#1), qolganlar yo'q bo'lish tartibida #2..;
   *  - 'draw_no_survivors' — bo'rilar yutdi: hech kim tongni ko'rmadi.
   * Server nightSummary yuborsa pergamentda o'rin/qotil jadvali o'rniga qiyinlik, mukofotlar va tun statistikasi.
   */
  private renderNightResultHtml(snap: SurvivalStateSnap): string {
    const summary = snap.nightSummary ?? null;
    const dawn = snap.winReason === 'dawn' || summary?.dawn === true;
    const winnerIds = new Set(dawn ? snap.winnerIds ?? [] : []);
    const meWon = winnerIds.has(this.myId);
    const survivorNames = snap.players.filter((p) => winnerIds.has(p.id)).map((p) => p.name);
    // Snapshot'da ismi bo'lmagan g'oliblar uchun serverning qo'shma ismlar matni
    const namesText = survivorNames.length ? survivorNames.join(', ') : snap.winnerName;

    const headerText = dawn ? (meWon ? 'OMON QOLDINGIZ!' : 'TONG OTDI!') : "BO'RILAR YUTDI";
    const headerSub = dawn ? `Tunni o'tkazganlar: ${esc(namesText)}` : "Hech kim tongni ko'rmadi";
    const headerIcon = dawn ? '🌅' : '🐺';
    const signCls = dawn ? (meWon ? 'is-victory' : 'is-other') : 'is-draw';
    const reasonLabel = SURVIVAL_WIN_REASON_LABELS_UZ[snap.winReason] ?? snap.statusTextUz ?? '';
    const boardHtml = summary
      ? buildNightSummaryBoardHtml(summary, this.myId)
      : this.renderNightPlacementBoardHtml(snap, winnerIds);

    return `
          <div class="s07-win-sign ${signCls}">
            <span class="s07-win-icon">${headerIcon}</span>
            <span class="s07-win-title">${headerText}</span>
          </div>
          <div class="s07-win-sub">${headerSub}</div>
          <div class="s07-win-reason">${esc(reasonLabel)}</div>
          ${boardHtml}
          <div class="s07-win-footer">
            <span>Keyingi tun <b>${snap.timeLeft}</b> soniyadan keyin boshlanadi</span>
            <span class="s07-win-bar"><i style="width:${winBarPercent(snap.timeLeft)}%"></i></span>
          </div>
        `;
  }

  /**
   * Tong epilogi (natija varag'idan oldin): taxta fonsiz "Tong otdi!" belgisi va izoh — ekranni yopmaydi,
   * tirik qolgan atrofga qarab bo'rilarning uvlab qochishini ko'radi.
   */
  private renderDawnEpilogueHtml(snap: SurvivalStateSnap): string {
    const winnerIds = new Set(snap.winnerIds ?? []);
    const meWon = winnerIds.has(this.myId);
    const survivorNames = snap.players.filter((p) => winnerIds.has(p.id)).map((p) => p.name);
    const namesText = survivorNames.length ? survivorNames.join(', ') : snap.winnerName;
    const sub = meWon ? "Omon qoldingiz — tunni o'tkazdingiz!" : `Tunni o'tkazganlar: ${esc(namesText)}`;
    return `
          <div class="s07-win-sign ${meWon ? 'is-victory' : 'is-other'}">
            <span class="s07-win-icon">🌅</span>
            <span class="s07-win-title">TONG OTDI!</span>
          </div>
          <div class="s07-win-sub">${sub}</div>
          <div class="s07-win-reason">🐺 Bo'rilar uvlab o'rmonga qochmoqda…</div>
        `;
  }

  /** nightSummary bo'lmasa (eski server): o'rin/holat/qotil jadvali. */
  private renderNightPlacementBoardHtml(snap: SurvivalStateSnap, winnerIds: ReadonlySet<string>): string {
    // Tartib: g'oliblar → yo'q bo'lganlar (keyinroq yo'q bo'lgan yuqorida) → kuzatuvchilar
    const sortedPlayers = [...snap.players].sort((a, b) => {
      const aw = winnerIds.has(a.id) ? 1 : 0;
      const bw = winnerIds.has(b.id) ? 1 : 0;
      if (aw !== bw) return bw - aw;
      if (a.role === 'spectator' && b.role !== 'spectator') return 1;
      if (b.role === 'spectator' && a.role !== 'spectator') return -1;
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (a.eliminatedAt !== undefined && b.eliminatedAt !== undefined && a.eliminatedAt !== b.eliminatedAt) {
        return b.eliminatedAt - a.eliminatedAt;
      }
      if (a.placement !== undefined && b.placement !== undefined && a.placement !== b.placement) {
        return a.placement - b.placement;
      }
      return b.kills - a.kills || a.deaths - b.deaths;
    });

    let nextRank = 2;
    const rowsHtml = sortedPlayers
      .map((p) => {
        const isWinner = winnerIds.has(p.id);
        const isMe = p.id === this.myId;
        const isSpectator = p.role === 'spectator';
        const placeText = isWinner ? '#1' : isSpectator ? '—' : `#${nextRank++}`;
        const statusText = isWinner
          ? '🌅 Omon qoldi'
          : isSpectator
            ? '👁 Kuzatuvchi'
            : p.alive
              ? '🛡 Tirik'
              : "💀 Bo'ri g'ajidi";
        const rowCls = `${isWinner ? 'is-winner' : ''} ${isMe ? 'is-me' : ''} ${
          !isWinner && !p.alive && !isSpectator ? 'is-out' : ''
        }`.trim();
        return `
              <tr class="${rowCls}">
                <td><span class="s07-rank">${esc(placeText)}</span></td>
                <td class="s07-name">${esc(p.name)}${isMe ? '<span class="s07-tag">Siz</span>' : ''}</td>
                <td>${esc(statusText)}</td>
                <td class="s07-kills">${p.kills}</td>
              </tr>
            `;
      })
      .join('');

    return `
          <div class="s07-win-board">
            <table class="s07-win-table">
              <thead>
                <tr>
                  <th>O'rin</th>
                  <th>O'yinchi</th>
                  <th>Holat</th>
                  <th class="s07-kills">Qotil</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>`;
  }

  getDiagnostics(): SurvivalUIDiagnostics {
    return {
      visible: Boolean(this.visible && this.snap !== null),
      roundId: this.snap ? this.snap.roundId : 0,
      phase: this.snap ? this.snap.phase : null,
      aliveCount: this.snap ? this.snap.aliveCount : 0,
      totalContenders: this.snap ? this.snap.totalContenders : 0,
      readyCount: this.snap ? this.snap.readyCount : 0,
      minPlayers: this.snap ? this.snap.minPlayers : 0,
      myRole: this.myRole,
      spectatorBannerVisible: this.spectatorBannerVisible,
      spectatedTargetId: this.spectatorPose ? this.spectatorPose.targetId : null,
      spectatedTargetName: this.spectatorPose ? this.spectatorPose.targetName : null,
      winnerOverlayVisible: this.winnerOverlayVisible,
      winnerId: this.snap ? this.snap.winnerId : null,
      winnerName: this.snap ? this.snap.winnerName : '',
      winReason: this.snap ? this.snap.winReason : 'none',
      topStatusText: this.topStatusText,
      preRoundBannerText: this.preRoundBannerText,
    };
  }

  reset(): void {
    this.snap = null;
    this.myId = '';
    this.myRole = null;
    this.spectatorPose = null;
    this.killerHtml = '';
    this.visible = false;
    this.spectatorBannerVisible = false;
    this.winnerOverlayVisible = false;
    this.topStatusText = '';
    this.preRoundBannerText = '';
    this.lastRootHidden = null;
    this.lastPillKey = '';
    this.lastBannerKey = '';
    this.lastSpecKey = '';
    this.lastWinKey = '';
    this.lastNightSheetKey = '';
    this.lastRespawnKey = '';

    if (this.rootEl) this.rootEl.className = 'hidden';
    if (this.topPillEl) this.topPillEl.innerHTML = '';
    this.renderFireRow([]);
    if (this.preRoundBannerEl) {
      this.preRoundBannerEl.className = 'hidden';
      this.preRoundBannerEl.innerHTML = '';
    }
    if (this.spectatorPanelEl) {
      this.spectatorPanelEl.className = 'hidden';
    }
    if (this.specRespawnEl) {
      this.specRespawnEl.className = 'hidden';
      this.specRespawnEl.textContent = '';
    }
    if (this.winnerOverlayEl) {
      this.winnerOverlayEl.className = 'hidden';
      this.winnerOverlayEl.innerHTML = '';
    }
  }

  dispose(): void {
    this.reset();
    if (this.rootEl) {
      this.rootEl.remove();
      this.rootEl = null;
    }
    this.topPillEl = null;
    this.fireRowEl = null;
    this.preRoundBannerEl = null;
    this.spectatorPanelEl = null;
    this.specRoleEl = null;
    this.specKillerEl = null;
    this.specTargetEl = null;
    this.specRespawnEl = null;
    this.winnerOverlayEl = null;
  }
}
