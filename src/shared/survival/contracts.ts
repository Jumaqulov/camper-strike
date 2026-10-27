import type { SurvivalZoneSnap } from './zone';
export type SurvivalPhase = 'waiting' | 'countdown' | 'playing' | 'ended';

export type SurvivalPlayerRole = 'waiting' | 'contender' | 'eliminated' | 'spectator';

export type SurvivalWinReason =
  | 'none'
  | 'last_standing'
  | 'opponent_disconnected'
  | 'draw_mutual_elimination'
  | 'draw_timeout'
  | 'draw_no_survivors';

export interface SurvivalConfig {
  minPlayersToStart: number;
  countdownDurationSec: number;
  roundDurationSec: number;
  endedDisplayDurationSec: number;
  /** Xavfsiz zona torayishi yoqilganmi (standart: true). */
  zoneEnabled: boolean;
}

export interface SurvivalPlayerStatusSnap {
  id: string;
  name: string;
  role: SurvivalPlayerRole;
  alive: boolean;
  ready: boolean;
  kills: number;
  deaths: number;
  eliminatedAt?: number;
  eliminatedBy?: string;
  placement?: number;
}

export interface SurvivalStateSnap {
  roundId: number;
  phase: SurvivalPhase;
  timeLeft: number;
  minPlayers: number;
  readyCount: number;
  contenderIds: string[];
  aliveIds: string[];
  spectatorIds: string[];
  aliveCount: number;
  totalContenders: number;
  winnerId: string | null;
  winnerName: string;
  winReason: SurvivalWinReason;
  statusTextUz: string;
  players: SurvivalPlayerStatusSnap[];
  /** Xavfsiz zona holati (faqat 'playing' fazasida). */
  zone?: SurvivalZoneSnap | null;
}

export interface SurvivalRoundEvaluation {
  shouldEnd: boolean;
  winnerId: string | null;
  winReason: SurvivalWinReason;
}
