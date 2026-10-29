import {
  DEFAULT_SURVIVAL_CONFIG,
  SurvivalConfig,
  SurvivalPhase,
  SurvivalPlayerRole,
  SurvivalPlayerStatusSnap,
  SurvivalStateSnap,
  SurvivalWinReason,
  canPlayerMoveInSurvival,
  canPlayerPerformCombatAction,
  canPlayerPerformLootAction,
  computePreRoundPhaseTransition,
  evaluateSurvivalRoundOutcome,
  formatSurvivalStatusTextUz,
} from '../../shared/survival';

export interface SurvivalPlayerView {
  id: string;
  name: string;
  isBot: boolean;
  ready: boolean;
  alive: boolean;
  kills: number;
  deaths: number;
}

export interface SurvivalControllerHooks {
  getPlayers: () => Iterable<SurvivalPlayerView>;
  getPlayerById: (id: string) => SurvivalPlayerView | undefined;
  onRoundStart: (roundId: number, contenderIds: string[]) => void;
  onRoundEnd: (
    roundId: number,
    winnerId: string | null,
    winnerName: string,
    winReason: SurvivalWinReason,
  ) => void;
  onPreRoundReset: (nextRoundId: number, nextPhase: 'waiting' | 'countdown') => void;
  onPhaseChanged?: (phase: SurvivalPhase, roundId: number) => void;
  onSystemChat?: (textUz: string) => void;
  /**
   * wolf_night: hamma o'lsa ham raund tugamasin — halok bo'lganlar keyingi to'lqinda qaytadi
   * (asosiy gulxan yonib turibdi va oldinda yana to'lqin bor). Berilmasa — false.
   */
  hasPendingRespawn?: () => boolean;
}

export class SurvivalRoundController {
  private config: SurvivalConfig;
  private roundId = 1;
  private phase: SurvivalPhase = 'waiting';
  private phaseEndsAt = 0;
  private contenderOrder: string[] = [];
  private contenderIds = new Set<string>();
  private aliveContenderIds = new Set<string>();
  private spectatorIds = new Set<string>();
  private eliminatedMeta = new Map<string, { at: number; by?: string; placement: number }>();
  private winnerId: string | null = null;
  private winnerName = '';
  private winReason: SurvivalWinReason = 'none';
  /** wolf_night: tong otganda birgalikda g'olib bo'lgan tirik ishtirokchilar (boshqa hollarda bo'sh). */
  private winnerIds: string[] = [];
  private winnerDeclaredForRound = false;
  private roundDeclareCount = 0;

  constructor(
    private readonly hooks: SurvivalControllerHooks,
    customConfig?: Partial<SurvivalConfig>,
  ) {
    this.config = {
      ...DEFAULT_SURVIVAL_CONFIG,
      ...customConfig,
    };
  }

  getConfig(): SurvivalConfig {
    return { ...this.config };
  }

  setConfig(partial: Partial<SurvivalConfig>, now: number): void {
    if (partial.minPlayersToStart !== undefined && Number.isFinite(partial.minPlayersToStart)) {
      // Kamida 1 (Tong otguncha yakka o'ynaladi; forest_survival konstruktorda 2 bilan yaratiladi)
      this.config.minPlayersToStart = Math.max(1, Math.floor(partial.minPlayersToStart));
    }
    if (
      partial.countdownDurationSec !== undefined &&
      Number.isFinite(partial.countdownDurationSec)
    ) {
      this.config.countdownDurationSec = Math.max(0.1, partial.countdownDurationSec);
      if (this.phase === 'countdown') {
        this.phaseEndsAt = now + this.config.countdownDurationSec;
      }
    }
    if (partial.roundDurationSec !== undefined && Number.isFinite(partial.roundDurationSec)) {
      this.config.roundDurationSec = Math.max(1, partial.roundDurationSec);
      if (this.phase === 'playing') {
        this.phaseEndsAt = now + this.config.roundDurationSec;
      }
    }
    if (
      partial.endedDisplayDurationSec !== undefined &&
      Number.isFinite(partial.endedDisplayDurationSec)
    ) {
      this.config.endedDisplayDurationSec = Math.max(0.1, partial.endedDisplayDurationSec);
      if (this.phase === 'ended') {
        this.phaseEndsAt = now + this.config.endedDisplayDurationSec;
      }
    }
    if (partial.zoneEnabled !== undefined) {
      this.config.zoneEnabled = Boolean(partial.zoneEnabled);
    }
    if (partial.minHumansToStart !== undefined && Number.isFinite(partial.minHumansToStart)) {
      this.config.minHumansToStart = Math.max(1, Math.floor(partial.minHumansToStart));
    }
    if (partial.sharedSurvival !== undefined) {
      this.config.sharedSurvival = Boolean(partial.sharedSurvival);
    }
  }

  getRoundId(): number {
    return this.roundId;
  }

  getPhase(): SurvivalPhase {
    return this.phase;
  }

  getPhaseEndsAt(): number {
    return this.phaseEndsAt;
  }

  getPlacement(playerId: string): number | undefined {
    return this.eliminatedMeta.get(playerId)?.placement;
  }

  getSpectateTarget(playerId: string): string | null {
    if (!this.isSpectator(playerId)) return null;
    for (const id of this.contenderOrder) {
      if (this.aliveContenderIds.has(id) && id !== playerId) {
        return id;
      }
    }
    return null;
  }

  getTimeLeft(now: number): number {
    if (this.phase === 'waiting') {
      return 0;
    }
    if (now >= this.phaseEndsAt) {
      return 0;
    }
    return Math.max(0, Math.ceil(this.phaseEndsAt - now));
  }

  getWinnerId(): string | null {
    return this.winnerId;
  }

  getWinnerName(): string {
    return this.winnerName;
  }

  getWinReason(): SurvivalWinReason {
    return this.winReason;
  }

  /** wolf_night: tong otganda birgalikda g'olib bo'lganlar; boshqa rejimlarda bo'sh. */
  getWinnerIds(): string[] {
    return [...this.winnerIds];
  }

  getRoundDeclareCount(): number {
    return this.roundDeclareCount;
  }

  private getReadyHumanPlayers(): SurvivalPlayerView[] {
    const res: SurvivalPlayerView[] = [];
    for (const p of this.hooks.getPlayers()) {
      if (!p.isBot && p.ready) {
        res.push(p);
      }
    }
    return res;
  }

  /** Tayyor ishtirokchilar: odamlar + botlar (botlar doim tayyor). */
  private getReadyContenders(): SurvivalPlayerView[] {
    const res: SurvivalPlayerView[] = [];
    for (const p of this.hooks.getPlayers()) {
      if (p.ready) {
        res.push(p);
      }
    }
    return res;
  }

  /**
   * Raund boshlash uchun hisobga olinadigan "tayyor" soni: kamida bitta tayyor odam bo'lmasa 0
   * (faqat botlar o'zaro raund boshlamaydi), aks holda odamlar + botlar.
   */
  private getEffectiveReadyCount(): number {
    if (this.getReadyHumanPlayers().length < Math.max(1, this.config.minHumansToStart)) return 0;
    return this.getReadyContenders().length;
  }

  getPlayerRole(playerId: string): SurvivalPlayerRole {
    if (this.phase === 'waiting' || this.phase === 'countdown') {
      const p = this.hooks.getPlayerById(playerId);
      if (p && p.ready) {
        return 'waiting';
      }
      return 'spectator';
    }

    if (this.contenderIds.has(playerId)) {
      return this.aliveContenderIds.has(playerId) ? 'contender' : 'eliminated';
    }
    return 'spectator';
  }

  isContender(playerId: string): boolean {
    return this.contenderIds.has(playerId);
  }

  isAliveContender(playerId: string): boolean {
    return this.aliveContenderIds.has(playerId);
  }

  isSpectator(playerId: string): boolean {
    const role = this.getPlayerRole(playerId);
    return role === 'eliminated' || role === 'spectator';
  }

  canPlayerMove(playerId: string): boolean {
    const p = this.hooks.getPlayerById(playerId);
    if (!p || !p.ready) {
      return false;
    }
    return canPlayerMoveInSurvival(this.phase, this.getPlayerRole(playerId), p.alive);
  }

  canPlayerCombat(playerId: string): boolean {
    const p = this.hooks.getPlayerById(playerId);
    if (!p || !p.ready) {
      return false;
    }
    return canPlayerPerformCombatAction(this.phase, this.getPlayerRole(playerId), p.alive);
  }

  canPlayerLoot(playerId: string): boolean {
    const p = this.hooks.getPlayerById(playerId);
    if (!p || !p.ready) {
      return false;
    }
    return canPlayerPerformLootAction(this.phase, this.getPlayerRole(playerId), p.alive);
  }

  onPlayerReady(
    playerId: string,
    now: number,
  ): { spawnInPreRound: boolean; joinAsSpectator: boolean } {
    if (this.phase === 'waiting' || this.phase === 'countdown') {
      this.spectatorIds.delete(playerId);
      const readyCount = this.getEffectiveReadyCount();
      if (this.phase === 'waiting' && readyCount >= this.config.minPlayersToStart) {
        this.phase = 'countdown';
        this.phaseEndsAt = now + this.config.countdownDurationSec;
        this.hooks.onPhaseChanged?.('countdown', this.roundId);
        this.hooks.onSystemChat?.(
          `Raund #${this.roundId} boshlanishiga ${Math.ceil(this.config.countdownDurationSec)} soniya qoldi!`,
        );
      }
      return { spawnInPreRound: true, joinAsSpectator: false };
    }

    this.spectatorIds.add(playerId);
    return { spawnInPreRound: false, joinAsSpectator: true };
  }

  onPlayerRemoved(playerId: string, now: number): void {
    this.spectatorIds.delete(playerId);

    if (this.phase === 'countdown') {
      if (this.getEffectiveReadyCount() < this.config.minPlayersToStart) {
        this.phase = 'waiting';
        this.phaseEndsAt = 0;
        this.hooks.onPhaseChanged?.('waiting', this.roundId);
        this.hooks.onSystemChat?.("Ishtirokchilar yetarli emas — kutish rejimiga qaytildi.");
      }
    } else if (this.phase === 'playing') {
      if (this.aliveContenderIds.has(playerId)) {
        const placement = this.aliveContenderIds.size;
        this.aliveContenderIds.delete(playerId);
        this.eliminatedMeta.set(playerId, { at: now, placement });
        this.checkOutcome(now, true);
      }
    }
  }

  recordElimination(
    victimId: string,
    killerId: string | undefined,
    now: number,
    deferOutcomeCheck = false,
  ): void {
    if (this.phase !== 'playing') {
      return;
    }

    if (this.aliveContenderIds.has(victimId)) {
      const placement = this.aliveContenderIds.size;
      this.aliveContenderIds.delete(victimId);
      this.spectatorIds.add(victimId);
      this.eliminatedMeta.set(victimId, {
        at: now,
        ...(killerId ? { by: killerId } : {}),
        placement,
      });
    }

    if (!deferOutcomeCheck) {
      this.checkOutcome(now, false);
    }
  }

  /**
   * wolf_night: halok bo'lgan ishtirokchini raundga qaytaradi (keyingi to'lqin boshida gulxan yonida) —
   * yana tirik ishtirokchi, kuzatuvchilar ro'yxatidan va o'rin yozuvidan chiqadi. Qaytaradi — qaytarildimi.
   */
  reviveEliminated(playerId: string): boolean {
    if (this.phase !== 'playing' || this.winnerDeclaredForRound) return false;
    if (!this.contenderIds.has(playerId) || this.aliveContenderIds.has(playerId)) return false;
    this.aliveContenderIds.add(playerId);
    this.spectatorIds.delete(playerId);
    this.eliminatedMeta.delete(playerId);
    return true;
  }

  checkOutcome(now: number, endedByDisconnect = false): boolean {
    if (this.phase !== 'playing' || this.winnerDeclaredForRound) {
      return false;
    }

    for (const id of [...this.aliveContenderIds]) {
      const p = this.hooks.getPlayerById(id);
      if (!p || !p.alive) {
        const placement = this.aliveContenderIds.size;
        this.aliveContenderIds.delete(id);
        if (p) {
          this.spectatorIds.add(id);
        }
        if (!this.eliminatedMeta.has(id)) {
          this.eliminatedMeta.set(id, { at: now, placement });
        }
      }
    }

    const evalRes = evaluateSurvivalRoundOutcome(
      this.contenderOrder,
      [...this.aliveContenderIds],
      this.phaseEndsAt - now,
      {
        endedByDisconnect,
        sharedSurvival: this.config.sharedSurvival === true,
        pendingRespawn: this.config.sharedSurvival === true && this.hooks.hasPendingRespawn?.() === true,
      },
    );

    if (!evalRes.shouldEnd) {
      return false;
    }

    this.winnerDeclaredForRound = true;
    this.roundDeclareCount++;
    this.phase = 'ended';
    this.phaseEndsAt = now + this.config.endedDisplayDurationSec;
    this.winnerId = evalRes.winnerId;
    this.winReason = evalRes.winReason;
    this.winnerIds = evalRes.winnerIds ? [...evalRes.winnerIds] : [];

    if (evalRes.winnerId) {
      const wp = this.hooks.getPlayerById(evalRes.winnerId);
      this.winnerName = wp ? wp.name : evalRes.winnerId;
      this.eliminatedMeta.set(evalRes.winnerId, { at: now, placement: 1 });
    } else if (this.winnerIds.length > 0) {
      // Tong otdi: barcha tirik qolganlar 1-o'rin, ismlar vergul bilan (ko'pi bilan 3 ta + "va yana N")
      const names: string[] = [];
      for (const id of this.winnerIds) {
        this.eliminatedMeta.set(id, { at: now, placement: 1 });
        const wp = this.hooks.getPlayerById(id);
        names.push(wp ? wp.name : id);
      }
      this.winnerName =
        names.length > 3 ? `${names.slice(0, 3).join(', ')} va yana ${names.length - 3}` : names.join(', ');
    } else {
      this.winnerName = 'draw';
    }

    this.hooks.onRoundEnd(this.roundId, this.winnerId, this.winnerName, this.winReason);
    this.hooks.onPhaseChanged?.('ended', this.roundId);
    return true;
  }

  startRoundNow(now: number): boolean {
    const readyPlayers = this.getReadyContenders();
    if (this.getEffectiveReadyCount() < this.config.minPlayersToStart) {
      this.phase = 'waiting';
      this.phaseEndsAt = 0;
      return false;
    }

    this.contenderOrder = readyPlayers.map((p) => p.id);
    this.contenderIds = new Set(this.contenderOrder);
    this.aliveContenderIds = new Set(this.contenderOrder);
    this.spectatorIds.clear();
    this.eliminatedMeta.clear();
    this.winnerId = null;
    this.winnerName = '';
    this.winReason = 'none';
    this.winnerIds = [];
    this.winnerDeclaredForRound = false;
    this.phase = 'playing';
    this.phaseEndsAt = now + this.config.roundDurationSec;

    this.hooks.onRoundStart(this.roundId, [...this.contenderOrder]);
    this.hooks.onPhaseChanged?.('playing', this.roundId);
    return true;
  }

  tick(now: number): void {
    const readyCount = this.getEffectiveReadyCount();

    if (this.phase === 'waiting' || this.phase === 'countdown') {
      const nextPrePhase = computePreRoundPhaseTransition(
        this.phase,
        readyCount,
        this.config.minPlayersToStart,
        this.phase === 'countdown' ? this.phaseEndsAt - now : this.config.countdownDurationSec,
      );
      if (this.phase === 'waiting' && nextPrePhase === 'countdown') {
        this.phase = 'countdown';
        this.phaseEndsAt = now + this.config.countdownDurationSec;
        this.hooks.onPhaseChanged?.('countdown', this.roundId);
      } else if (this.phase === 'countdown' && nextPrePhase === 'waiting') {
        this.phase = 'waiting';
        this.phaseEndsAt = 0;
        this.hooks.onPhaseChanged?.('waiting', this.roundId);
      } else if (this.phase === 'countdown' && nextPrePhase === 'playing') {
        this.startRoundNow(now);
      }
    } else if (this.phase === 'playing') {
      this.checkOutcome(now, false);
    } else if (this.phase === 'ended') {
      if (now >= this.phaseEndsAt) {
        this.roundId++;
        this.contenderOrder = [];
        this.contenderIds.clear();
        this.aliveContenderIds.clear();
        this.spectatorIds.clear();
        this.eliminatedMeta.clear();
        this.winnerId = null;
        this.winnerName = '';
        this.winReason = 'none';
        this.winnerIds = [];
        this.winnerDeclaredForRound = false;

        if (readyCount >= this.config.minPlayersToStart) {
          this.phase = 'countdown';
          this.phaseEndsAt = now + this.config.countdownDurationSec;
          this.hooks.onPreRoundReset(this.roundId, 'countdown');
          this.hooks.onPhaseChanged?.('countdown', this.roundId);
        } else {
          this.phase = 'waiting';
          this.phaseEndsAt = 0;
          this.hooks.onPreRoundReset(this.roundId, 'waiting');
          this.hooks.onPhaseChanged?.('waiting', this.roundId);
        }
      }
    }
  }

  getStateSnap(now: number): SurvivalStateSnap {
    const timeLeft = this.getTimeLeft(now);
    const readyCount = this.getEffectiveReadyCount();
    const contenderIds = [...this.contenderOrder];
    const aliveIds = [...this.aliveContenderIds];
    const aliveCount = this.aliveContenderIds.size;
    const totalContenders = this.contenderOrder.length;

    const spectatorSet = new Set<string>();
    for (const id of this.spectatorIds) {
      if (this.hooks.getPlayerById(id)) {
        spectatorSet.add(id);
      }
    }

    const players: SurvivalPlayerStatusSnap[] = [];
    for (const p of this.hooks.getPlayers()) {
      const role = this.getPlayerRole(p.id);
      if (role === 'spectator' || role === 'eliminated') {
        spectatorSet.add(p.id);
      }
      const meta = this.eliminatedMeta.get(p.id);
      const isAliveInMode =
        this.phase === 'playing' || this.phase === 'ended'
          ? this.aliveContenderIds.has(p.id) && p.alive
          : p.alive;

      players.push({
        id: p.id,
        name: p.name,
        role,
        alive: isAliveInMode,
        ready: p.ready,
        kills: p.kills,
        deaths: p.deaths,
        ...(meta?.at !== undefined ? { eliminatedAt: meta.at } : {}),
        ...(meta?.by !== undefined ? { eliminatedBy: meta.by } : {}),
        ...(meta?.placement !== undefined ? { placement: meta.placement } : {}),
      });
    }

    const spectatorIds = [...spectatorSet];
    const readyHumans = this.getReadyHumanPlayers().length;
    const minHumans = Math.max(1, this.config.minHumansToStart);
    const statusTextUz = formatSurvivalStatusTextUz({
      phase: this.phase,
      timeLeft,
      readyCount,
      readyHumans,
      minHumans,
      minPlayers: this.config.minPlayersToStart,
      aliveCount,
      totalContenders,
      winnerId: this.winnerId,
      winnerName: this.winnerName,
      winReason: this.winReason,
    });

    return {
      roundId: this.roundId,
      phase: this.phase,
      timeLeft,
      minPlayers: this.config.minPlayersToStart,
      readyCount,
      readyHumans,
      minHumans,
      contenderIds,
      aliveIds,
      spectatorIds,
      aliveCount,
      totalContenders,
      winnerId: this.winnerId,
      winnerName: this.winnerName,
      winReason: this.winReason,
      statusTextUz,
      players,
      ...(this.config.sharedSurvival ? { winnerIds: [...this.winnerIds] } : {}),
    };
  }
}
