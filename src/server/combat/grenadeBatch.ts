import type { Vec3 } from '../../shared/math';
import { stepProjectileInWorld } from '../../shared/physics';
import type { WorldDefinition } from '../../shared/world';

export interface ServerGrenadeRecord {
  id: number;
  owner: string;
  pos: Vec3;
  vel: Vec3;
  explodeAt: number;
}

export interface GrenadeStepBatchResult {
  /** Grenades that reached `nowSec >= explodeAt` during this tick, in deterministic order. */
  exploding: ServerGrenadeRecord[];
  /** Grenades still in flight (`nowSec < explodeAt`) after stepping physics. */
  remaining: ServerGrenadeRecord[];
}

export interface GrenadeBatchExecutionSummary {
  steppedCount: number;
  explodedCount: number;
  remainingCount: number;
}

export interface ExecuteGrenadeTickBatchParams {
  getGrenades: () => readonly ServerGrenadeRecord[];
  setGrenades: (next: ServerGrenadeRecord[]) => void;
  getPhase: () => string;
  dt: number;
  nowSec: number;
  world: WorldDefinition;
  explodeOne: (g: ServerGrenadeRecord) => void;
  onBatchComplete: () => void;
}

/**
 * Type guard verifying that a candidate value is a well-formed `ServerGrenadeRecord`
 * with valid numeric position, velocity, id, and detonation timestamp.
 */
export function isValidGrenadeRecord(g: unknown): g is ServerGrenadeRecord {
  if (!g || typeof g !== 'object') return false;
  const candidate = g as Record<string, unknown>;
  if (typeof candidate.id !== 'number' || typeof candidate.owner !== 'string') {
    return false;
  }
  if (typeof candidate.explodeAt !== 'number') {
    return false;
  }
  const pos = candidate.pos as Record<string, unknown> | null | undefined;
  if (
    !pos ||
    typeof pos !== 'object' ||
    typeof pos.x !== 'number' ||
    typeof pos.y !== 'number' ||
    typeof pos.z !== 'number'
  ) {
    return false;
  }
  const vel = candidate.vel as Record<string, unknown> | null | undefined;
  if (
    !vel ||
    typeof vel !== 'object' ||
    typeof vel.x !== 'number' ||
    typeof vel.y !== 'number' ||
    typeof vel.z !== 'number'
  ) {
    return false;
  }
  return true;
}

/**
 * Takes a defensive snapshot of active grenades, steps their projectile physics in the world,
 * and partitions them into `exploding` (`nowSec >= explodeAt`) and `remaining` (`nowSec < explodeAt`).
 */
export function stepAndPartitionGrenades(
  grenades: readonly ServerGrenadeRecord[],
  dt: number,
  nowSec: number,
  world: WorldDefinition,
  phase: string,
): GrenadeStepBatchResult {
  if (phase !== 'playing' || !Array.isArray(grenades) || grenades.length === 0) {
    return { exploding: [], remaining: [] };
  }

  const snapshot = grenades.filter(isValidGrenadeRecord);
  const exploding: ServerGrenadeRecord[] = [];
  const remaining: ServerGrenadeRecord[] = [];

  for (const g of snapshot) {
    stepProjectileInWorld(g, dt, world);
    if (nowSec >= g.explodeAt) {
      exploding.push(g);
    } else {
      remaining.push(g);
    }
  }

  return { exploding, remaining };
}

/**
 * Executes a single server tick of grenade physics and batch detonation.
 * Ensures external array mutations (such as round-end resets) cannot corrupt iteration,
 * and defers round/win evaluation (`onBatchComplete`) until all grenades exploding in
 * the same tick have applied their damage.
 */
export function executeGrenadeTickBatch(
  params: ExecuteGrenadeTickBatchParams,
): GrenadeBatchExecutionSummary {
  const current = params.getGrenades();
  const { exploding, remaining } = stepAndPartitionGrenades(
    current,
    params.dt,
    params.nowSec,
    params.world,
    params.getPhase(),
  );

  params.setGrenades(remaining);

  if (exploding.length > 0) {
    for (const g of exploding) {
      if (params.getPhase() !== 'playing') break;
      params.explodeOne(g);
    }

    if (params.getPhase() === 'playing') {
      params.onBatchComplete();
    }

    if (params.getPhase() !== 'playing') {
      params.setGrenades([]);
    }
  }

  return {
    steppedCount: exploding.length + remaining.length,
    explodedCount: exploding.length,
    remainingCount: params.getPhase() === 'playing' ? remaining.length : 0,
  };
}
