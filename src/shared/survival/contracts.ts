import type { NightRoundSummary, NightSnap } from '../wolf/night';
import type { SurvivalZoneSnap } from './zone';
export type SurvivalPhase = 'waiting' | 'countdown' | 'playing' | 'ended';

export type SurvivalPlayerRole = 'waiting' | 'contender' | 'eliminated' | 'spectator';

export type SurvivalWinReason =
  | 'none'
  | 'last_standing'
  | 'opponent_disconnected'
  | 'draw_mutual_elimination'
  | 'draw_timeout'
  | 'draw_no_survivors'
  /** wolf_night: tong otdi — barcha tirik ishtirokchilar birgalikda g'olib. */
  | 'dawn';

export interface SurvivalConfig {
  minPlayersToStart: number;
  countdownDurationSec: number;
  roundDurationSec: number;
  endedDisplayDurationSec: number;
  /** Xavfsiz zona torayishi yoqilganmi (standart: true). */
  zoneEnabled: boolean;
  /** Raund boshlanishi uchun kerakli tayyor odamlar soni (botlar hisobga olinmaydi), kamida 1. */
  minHumansToStart: number;
  /**
   * wolf_night: raund oxirgi tirik qolganda tugamaydi; taymer tugaganda barcha tirik ishtirokchilar
   * g'olib ('dawn'), hamma o'lsa 'draw_no_survivors'.
   */
  sharedSurvival?: boolean;
  /**
   * wolf_night: raund tong bilan tugaganda ('dawn') 'ended' fazasi endedDisplayDurationSec + shuncha soniya
   * davom etadi (tong epilogi — natija varag'idan oldin). Boshqa yakunlarda qo'shilmaydi. Standart: 0.
   */
  dawnEpilogueSec?: number;
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
  /** Tayyor odamlar soni va boshlash uchun kerakli odamlar soni (botlarsiz). */
  readyHumans: number;
  minHumans: number;
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
  /** wolf_night: tun/to'lqin holati (faqat 'playing' fazasida). */
  night?: NightSnap | null;
  /** wolf_night: tong otganda birgalikda g'olib bo'lgan tirik ishtirokchilar. */
  winnerIds?: string[];
  /** wolf_night: tun natijasi — shaxsiy statistika va mukofotlar (faqat 'ended' fazasida). */
  nightSummary?: NightRoundSummary | null;
}

export interface SurvivalRoundEvaluation {
  shouldEnd: boolean;
  winnerId: string | null;
  winReason: SurvivalWinReason;
}
