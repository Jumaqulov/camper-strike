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
import type { SpectatorCameraPose } from './SpectatorController';

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

const STYLE_ELEMENT_ID = 'stage07-survival-ui-styles';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
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

function injectSurvivalUIStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    #stage07-survival-hud {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 13;
      font-family: 'Segoe UI', 'Roboto', system-ui, sans-serif;
      user-select: none;
    }

    #stage07-survival-hud.hidden,
    #stage07-survival-hud .hidden {
      display: none !important;
    }

    /* 1. Yagona yuqori status paneli (TDM top-bar survival'da yashirin) */
    #stage07-top-pill {
      position: absolute;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      display: inline-flex;
      align-items: stretch;
      gap: 0;
      padding: 0;
      border-radius: 10px;
      background: rgba(36, 26, 16, 0.84);
      border: 2px solid rgba(217, 155, 82, 0.6);
      color: #fff8e7;
      font-family: 'Bahnschrift', 'Segoe UI', 'Roboto', system-ui, sans-serif;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.6px;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.5);
      white-space: nowrap;
      overflow: hidden;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    }

    #stage07-top-pill > span {
      display: inline-flex;
      align-items: center;
      padding: 6px 12px;
      border-right: 1px solid rgba(255, 255, 255, 0.1);
    }

    #stage07-top-pill > span:last-child {
      border-right: 0;
    }

    .s07-pill-round {
      background: rgba(255, 196, 68, 0.16);
      color: #ffd166;
      font-weight: 900;
      text-transform: uppercase;
    }

    .s07-pill-time {
      font-size: 20px;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
      color: #fff8e7;
      min-width: 64px;
      justify-content: center;
    }

    .s07-pill-time.urgent {
      color: #fcd34d;
    }

    .s07-pill-phase {
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .s07-pill-phase.phase-waiting {
      background: rgba(148, 163, 184, 0.22);
      color: #cbd5e1;
    }

    .s07-pill-phase.phase-countdown {
      background: rgba(245, 158, 11, 0.28);
      color: #fcd34d;
    }

    .s07-pill-phase.phase-playing {
      background: rgba(34, 197, 94, 0.25);
      color: #86efac;
    }

    .s07-pill-phase.phase-ended {
      background: rgba(234, 179, 8, 0.28);
      color: #fde047;
    }

    .s07-pill-zone {
      color: #7dd3fc;
      font-variant-numeric: tabular-nums;
      font-weight: 800;
    }

    .s07-pill-zone.shrinking {
      color: #ffb74d;
      animation: s07-zone-pulse 1s ease-in-out infinite;
    }

    @keyframes s07-zone-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }

    .s07-pill-count {
      color: #f8fafc;
      font-variant-numeric: tabular-nums;
    }

    /* 2. Raund oldi eslatmasi (ixcham, status paneli ostida) */
    #stage07-preround-banner {
      position: absolute;
      top: 64px;
      left: 50%;
      transform: translateX(-50%);
      width: min(480px, 90vw);
      padding: 7px 14px;
      border-radius: 9px;
      background: rgba(36, 26, 16, 0.78);
      border: 1.5px solid rgba(217, 155, 82, 0.5);
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
      text-align: center;
      color: #fff8e7;
      font-family: 'Bahnschrift', 'Segoe UI', 'Roboto', system-ui, sans-serif;
    }

    #stage07-preround-banner.phase-countdown {
      border-color: rgba(251, 191, 36, 0.85);
    }

    .s07-preround-title {
      font-size: 13px;
      font-weight: 900;
      color: #ffd166;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
    }

    .s07-preround-sub {
      margin-top: 2px;
      font-size: 11.5px;
      font-weight: 600;
      color: #e8dcc4;
      line-height: 1.3;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    }

    /* 3. Spectator Panel */
    #stage07-spectator-panel {
      position: absolute;
      bottom: 130px;
      left: 50%;
      transform: translateX(-50%);
      width: min(500px, 92vw);
      padding: 10px 16px;
      border-radius: 14px;
      background: rgba(15, 21, 28, 0.92);
      border: 1.5px solid rgba(96, 165, 250, 0.68);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.65);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      color: #f1f5f9;
      pointer-events: auto;
    }

    #stage07-spec-role {
      font-size: 12.5px;
      font-weight: 900;
      color: #93c5fd;
      letter-spacing: 0.35px;
      text-align: center;
    }

    #stage07-spec-role.eliminated {
      color: #fca5a5;
    }

    #stage07-spec-killer {
      font-size: 11.5px;
      font-weight: 700;
      color: #fde68a;
      text-align: center;
    }

    #stage07-spec-target {
      font-size: 13px;
      font-weight: 800;
      color: #ffffff;
      background: rgba(255, 255, 255, 0.06);
      padding: 4px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
    }

    .s07-spec-controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 2px;
    }

    .s07-spec-btn {
      padding: 5px 11px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.09);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #f8fafc;
      font-size: 11.5px;
      font-weight: 800;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease;
    }

    .s07-spec-btn:hover {
      background: rgba(96, 165, 250, 0.24);
      border-color: #93c5fd;
    }

    .s07-spec-btn:active {
      transform: translateY(1px);
    }

    /* 4. Winner / Round-End Overlay */
    #stage07-winner-overlay {
      position: absolute;
      top: 135px;
      left: 50%;
      transform: translateX(-50%);
      width: min(540px, 92vw);
      padding: 16px 20px;
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(22, 29, 23, 0.96), rgba(14, 18, 15, 0.96));
      border: 2.5px solid #fbbf24;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.75);
      color: #fffbeb;
      text-align: center;
      pointer-events: auto;
    }

    .s07-win-header {
      font-size: 18px;
      font-weight: 900;
      color: #fde047;
      letter-spacing: 0.4px;
      text-shadow: 0 2px 6px rgba(0, 0, 0, 0.85);
    }

    .s07-win-reason {
      margin-top: 4px;
      font-size: 13px;
      font-weight: 700;
      color: #fef3c7;
    }

    .s07-win-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 12px;
      text-align: left;
    }

    .s07-win-table th {
      padding: 5px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.18);
      color: #94a3b8;
      font-weight: 800;
      font-size: 11px;
      text-transform: uppercase;
    }

    .s07-win-table td {
      padding: 6px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
      color: #e2e8f0;
      font-weight: 700;
    }

    .s07-win-table tr.is-winner td {
      color: #fde047;
      font-weight: 900;
      background: rgba(250, 204, 21, 0.1);
    }

    .s07-win-table tr.is-me td {
      outline: 1px solid rgba(251, 191, 36, 0.45);
    }

    .s07-win-footer {
      margin-top: 12px;
      font-size: 12.5px;
      font-weight: 800;
      color: #cbd5e1;
    }
  `;
  document.head.appendChild(style);
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
  private winnerOverlayEl: HTMLElement | null = null;

  private visible = false;
  private snap: SurvivalStateSnap | null = null;
  private myId = '';
  private myRole: SurvivalPlayerRole | null = null;
  private spectatorPose: SpectatorCameraPose | null = null;
  private killerHtml = '';

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

  constructor(callbacks: SurvivalUICallbacks) {
    this.callbacks = callbacks;
    injectSurvivalUIStyles();
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

    const preRoundBanner = document.createElement('div');
    preRoundBanner.id = 'stage07-preround-banner';
    preRoundBanner.className = 'hidden';

    const spectatorPanel = document.createElement('div');
    spectatorPanel.id = 'stage07-spectator-panel';
    spectatorPanel.className = 'hidden';
    spectatorPanel.innerHTML = `
      <div id="stage07-spec-role"></div>
      <div id="stage07-spec-killer" class="hidden"></div>
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
    root.appendChild(preRoundBanner);
    root.appendChild(spectatorPanel);
    root.appendChild(winnerOverlay);
    host.appendChild(root);

    this.rootEl = root;
    this.topPillEl = topPill;
    this.preRoundBannerEl = preRoundBanner;
    this.spectatorPanelEl = spectatorPanel;
    this.specRoleEl = spectatorPanel.querySelector('#stage07-spec-role');
    this.specKillerEl = spectatorPanel.querySelector('#stage07-spec-killer');
    this.specTargetEl = spectatorPanel.querySelector('#stage07-spec-target');
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

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.render();
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
      return;
    }

    if (this.rootEl && this.lastRootHidden !== false) {
      this.rootEl.className = '';
      this.lastRootHidden = false;
    }

    const myStatus = this.resolveMyStatus(snap, this.myId);
    this.myRole = myStatus ? myStatus.role : null;

    // 1. Top Pill
    const phaseLabel = SURVIVAL_PHASE_LABELS_UZ[snap.phase] ?? snap.phase.toUpperCase();
    const countLabel =
      snap.phase === 'waiting' || snap.phase === 'countdown'
        ? (snap.minHumans ?? 1) > 1 && (snap.readyHumans ?? 0) < (snap.minHumans ?? 1)
          ? `Odamlar: ${snap.readyHumans ?? 0}/${snap.minHumans}`
          : `Tayyor: ${snap.readyCount}/${snap.minPlayers}`
        : `Tirik: ${snap.aliveCount}/${snap.totalContenders}`;
    this.topStatusText = `RAUND #${snap.roundId} · ${phaseLabel} · ${countLabel}`;

    const pillKey = `${snap.roundId}|${snap.phase}|${snap.timeLeft}|${countLabel}|${
      snap.phase === 'playing' && snap.zone ? `${formatZoneStatusUz(snap.zone)}|${snap.zone.shrinking ? 1 : 0}` : ''
    }`;
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
        ${snap.phase === 'playing' && snap.zone ? `<span class="s07-pill-zone${snap.zone.shrinking ? ' shrinking' : ''}">${esc(formatZoneStatusUz(snap.zone))}</span>` : ''}
      `;
    }

    // 2. Pre-Round Banner
    if (snap.phase === 'waiting' || snap.phase === 'countdown') {
      const title =
        snap.phase === 'waiting'
          ? (snap.minHumans ?? 1) > 1 && (snap.readyHumans ?? 0) < (snap.minHumans ?? 1)
            ? `Odamlar kutilmoqda · ${snap.readyHumans ?? 0}/${snap.minHumans}`
            : `O'yinchilar kutilmoqda · ${snap.readyCount}/${snap.minPlayers}`
          : `Raund boshlanmoqda`;
      const subtitle =
        snap.phase === 'waiting'
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

    // 4. Winner / Round-End Overlay
    const showWinner = snap.phase === 'ended';
    this.winnerOverlayVisible = showWinner;

    const winKey = showWinner
      ? `1|${snap.winnerId}|${snap.winnerName}|${snap.winReason}|${snap.timeLeft}|${snap.players
          .map((p) => `${p.id}:${p.role}:${p.alive ? 1 : 0}:${p.kills}:${p.deaths}:${p.placement ?? ''}`)
          .join(',')}`
      : '0';
    if (this.winnerOverlayEl && winKey !== this.lastWinKey) {
      this.lastWinKey = winKey;
      if (showWinner) {
        this.winnerOverlayEl.className = '';
        const isDraw = snap.winnerId === null || snap.winnerName === 'draw' || !snap.winnerName;
        const headerText = isDraw
          ? "⚖️ DURRANG — G'OLIB ANIQLANMADI"
          : snap.winnerId === this.myId
            ? "🏆 G'ALABA! SIZ OXIRGI TIRIK QOLGAN O'YINCHISIZ!"
            : `🏆 RAUND G'OLIBI: ${esc(snap.winnerName)}!`;

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
            const rowCls = `${isWinner ? 'is-winner' : ''} ${isMe ? 'is-me' : ''}`.trim();
            return `
              <tr class="${rowCls}">
                <td>${esc(placeText)}</td>
                <td>${esc(p.name)}${isMe ? ' (Siz)' : ''}</td>
                <td>${esc(statusText)}</td>
                <td>${p.kills}</td>
              </tr>
            `;
          })
          .join('');

        this.winnerOverlayEl.innerHTML = `
          <div class="s07-win-header">${headerText}</div>
          <div class="s07-win-reason">${esc(reasonLabel)}</div>
          <table class="s07-win-table">
            <thead>
              <tr>
                <th>O'rin</th>
                <th>O'yinchi</th>
                <th>Holat</th>
                <th>Qotil</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
          <div class="s07-win-footer">Keyingi raund ${snap.timeLeft} soniyadan keyin boshlanadi...</div>
        `;
      } else {
        this.winnerOverlayEl.className = 'hidden';
        this.winnerOverlayEl.innerHTML = '';
      }
    }
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

    if (this.rootEl) this.rootEl.className = 'hidden';
    if (this.topPillEl) this.topPillEl.innerHTML = '';
    if (this.preRoundBannerEl) {
      this.preRoundBannerEl.className = 'hidden';
      this.preRoundBannerEl.innerHTML = '';
    }
    if (this.spectatorPanelEl) {
      this.spectatorPanelEl.className = 'hidden';
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
    this.preRoundBannerEl = null;
    this.spectatorPanelEl = null;
    this.specRoleEl = null;
    this.specKillerEl = null;
    this.specTargetEl = null;
    this.winnerOverlayEl = null;
  }
}
