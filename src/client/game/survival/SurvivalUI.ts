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
