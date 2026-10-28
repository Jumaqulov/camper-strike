import type {
  SurvivalConfig,
  SurvivalPhase,
  SurvivalPlayerRole,
  SurvivalRoundEvaluation,
  SurvivalStateSnap,
  SurvivalWinReason,
} from './contracts';

export const DEFAULT_SURVIVAL_CONFIG: SurvivalConfig = {
  minPlayersToStart: 2,
  countdownDurationSec: 10,
  roundDurationSec: 180,
  endedDisplayDurationSec: 8,
  zoneEnabled: true,
  minHumansToStart: 1,
};

export const SURVIVAL_PHASE_LABELS_UZ: Record<SurvivalPhase, string> = {
  waiting: 'KUTILMOQDA',
  countdown: 'TAYYORGARLIK',
  playing: 'JANG DAVOM ETMOQDA',
  ended: 'RAUND YAKUNLANDI',
};

export const SURVIVAL_ROLE_LABELS_UZ: Record<SurvivalPlayerRole, string> = {
  waiting: 'Tayyor',
  contender: 'Tirik ishtirokchi',
  eliminated: 'Safdan chiqqan',
  spectator: 'Kuzatuvchi',
};

export const SURVIVAL_WIN_REASON_LABELS_UZ: Record<SurvivalWinReason, string> = {
  none: 'Jang davom etmoqda',
  last_standing: 'Yagona tirik qolgan jangchi',
  opponent_disconnected: 'Raqib o‘yindan chiqdi — texnik g‘alaba',
  draw_mutual_elimination: 'Durang: barcha ishtirokchilar bir vaqtda halok bo‘ldi',
  draw_timeout: 'Durang: vaqt tugadi, g‘olib aniqlanmadi',
  draw_no_survivors: 'Durang: tirik ishtirokchilar qolmadi',
  dawn: 'Tong otdi — tunni o‘tkazganlar g‘olib',
};

export function isSurvivalPhase(x: unknown): x is SurvivalPhase {
  return x === 'waiting' || x === 'countdown' || x === 'playing' || x === 'ended';
}

export function isSurvivalPlayerRole(x: unknown): x is SurvivalPlayerRole {
  return x === 'waiting' || x === 'contender' || x === 'eliminated' || x === 'spectator';
}

export function canPlayerPerformCombatAction(
  phase: SurvivalPhase,
  role: SurvivalPlayerRole,
  alive: boolean,
): boolean {
  return phase === 'playing' && role === 'contender' && alive === true;
}

export function canPlayerPerformLootAction(
  phase: SurvivalPhase,
  role: SurvivalPlayerRole,
  alive: boolean,
): boolean {
  return phase === 'playing' && role === 'contender' && alive === true;
}

export function canPlayerMoveInSurvival(
  phase: SurvivalPhase,
  role: SurvivalPlayerRole,
  alive: boolean,
): boolean {
  if (!alive || role === 'eliminated' || role === 'spectator') {
    return false;
  }
  if ((phase === 'waiting' || phase === 'countdown') && role === 'waiting') {
    return true;
  }
  if (phase === 'playing' && role === 'contender') {
    return true;
  }
  return false;
}

export function computePreRoundPhaseTransition(
  currentPhase: 'waiting' | 'countdown',
  readyHumanCount: number,
  minPlayersToStart: number,
  countdownRemainingSec: number,
): 'waiting' | 'countdown' | 'playing' {
  if (readyHumanCount < minPlayersToStart) {
    return 'waiting';
  }
  if (currentPhase === 'waiting') {
    return 'countdown';
  }
  if (countdownRemainingSec <= 0) {
    return 'playing';
  }
  return 'countdown';
}

/** Raund natijasi; `winnerIds` — wolf_night (sharedSurvival) rejimida tong otganda birgalikda g'olib bo'lganlar. */
export type SurvivalRoundOutcome = SurvivalRoundEvaluation & { winnerIds?: string[] };

export function evaluateSurvivalRoundOutcome(
  contenderIds: readonly string[],
  aliveContenderIds: readonly string[],
  timeRemainingSec: number,
  opts?: { endedByDisconnect?: boolean; sharedSurvival?: boolean },
): SurvivalRoundOutcome {
  if (opts?.sharedSurvival) {
    // Tong otguncha: oxirgi tirik qolgan raundni tugatmaydi; hamma o'lsa — bo'rilar yutdi,
    // taymer tugasa — barcha tirik ishtirokchilar birgalikda g'olib ('dawn').
    if (aliveContenderIds.length === 0) {
      return { shouldEnd: true, winnerId: null, winReason: 'draw_no_survivors', winnerIds: [] };
    }
    if (timeRemainingSec <= 0) {
      return { shouldEnd: true, winnerId: null, winReason: 'dawn', winnerIds: [...aliveContenderIds] };
    }
    return { shouldEnd: false, winnerId: null, winReason: 'none' };
  }

  if (contenderIds.length < 2) {
    if (aliveContenderIds.length === 1) {
      return {
        shouldEnd: true,
        winnerId: aliveContenderIds[0]!,
        winReason: 'last_standing',
      };
    }
    return {
      shouldEnd: true,
      winnerId: null,
      winReason: 'draw_no_survivors',
    };
  }

  if (aliveContenderIds.length === 1) {
    return {
      shouldEnd: true,
      winnerId: aliveContenderIds[0]!,
      winReason: opts?.endedByDisconnect ? 'opponent_disconnected' : 'last_standing',
    };
  }

  if (aliveContenderIds.length === 0) {
    return {
      shouldEnd: true,
      winnerId: null,
      winReason: 'draw_mutual_elimination',
    };
  }

  if (timeRemainingSec <= 0) {
    return {
      shouldEnd: true,
      winnerId: null,
      winReason: 'draw_timeout',
    };
  }

  return {
    shouldEnd: false,
    winnerId: null,
    winReason: 'none',
  };
}

export function formatSurvivalStatusTextUz(
  snap: Pick<
    SurvivalStateSnap,
    | 'phase'
    | 'timeLeft'
    | 'readyCount'
    | 'minPlayers'
    | 'aliveCount'
    | 'totalContenders'
    | 'winnerId'
    | 'winnerName'
    | 'winReason'
  > & { readyHumans?: number; minHumans?: number },
): string {
  const secs = Math.max(0, Math.ceil(snap.timeLeft));

  switch (snap.phase) {
    case 'waiting': {
      const minHumans = snap.minHumans ?? 1;
      const readyHumans = snap.readyHumans ?? snap.readyCount;
      if (minHumans > 1 && readyHumans < minHumans) {
        return `Odamlar kutilmoqda (${readyHumans}/${minHumans}) — yana ${minHumans - readyHumans} odam kerak`;
      }
      const needed = Math.max(0, snap.minPlayers - snap.readyCount);
      if (needed > 0) {
        return `Ishtirokchilar kutilmoqda (${snap.readyCount}/${snap.minPlayers}) — yana ${needed} o‘yinchi kerak`;
      }
      return `Ishtirokchilar tayyor (${snap.readyCount}/${snap.minPlayers})`;
    }
    case 'countdown':
      return `Raund boshlanishiga ${secs}s qoldi (${snap.readyCount} ishtirokchi tayyor)`;
    case 'playing':
      return `Tirik qolganlar: ${snap.aliveCount}/${snap.totalContenders} • Vaqt: ${secs}s`;
    case 'ended': {
      if (snap.winReason === 'dawn') {
        const names = snap.winnerName || SURVIVAL_WIN_REASON_LABELS_UZ.dawn;
        return `Tong otdi — g‘oliblar: ${names} • Keyingi raund: ${secs}s`;
      }
      if (snap.winnerId && snap.winnerName) {
        const reasonText = SURVIVAL_WIN_REASON_LABELS_UZ[snap.winReason];
        return `G‘olib: ${snap.winnerName} (${reasonText}) • Keyingi raund: ${secs}s`;
      }
      const drawReason = SURVIVAL_WIN_REASON_LABELS_UZ[snap.winReason] || 'Durang';
      return `${drawReason} • Keyingi raund: ${secs}s`;
    }
  }
}
