import { WEAPONS, type WeaponId } from '../../shared/weapons';

/**
 * Tolerance multiplier applied to server-side switchTime enforcement to account for
 * network jitter and tick quantization when a legitimate client completes its local
 * switchUntil timer and fires.
 */
export const SERVER_SWITCH_TIME_TOLERANCE = 0.75;

export interface ServerWeaponCarrier {
  id: string;
  isBot: boolean;
  alive: boolean;
  weapon: WeaponId | null;
  switchUntil: number;
  reloadWeapon: WeaponId | null;
  reloadUntil: number;
  scoped: boolean;
}

export type ShotWeaponValidationFailure =
  | 'PLAYER_DEAD'
  | 'WEAPON_NOT_OWNED'
  | 'WEAPON_NOT_EQUIPPED'
  | 'SWITCH_COOLDOWN_ACTIVE';

export interface ShotWeaponValidationResult {
  ok: boolean;
  reason?: ShotWeaponValidationFailure;
  remainingSwitchSec?: number;
}

export function resetServerWeaponSwitchState(player: ServerWeaponCarrier): void {
  player.switchUntil = 0;
}

export function applyAuthoritativeWeaponSwitch(
  player: ServerWeaponCarrier,
  nextWeapon: WeaponId | null,
  nowSec: number,
  options?: { fromAutoPickup?: boolean; tolerance?: number },
): boolean {
  const prevWeapon = player.weapon;
  player.weapon = nextWeapon;

  if (prevWeapon !== nextWeapon) {
    player.reloadWeapon = null;
    player.reloadUntil = 0;
    if (nextWeapon !== 'sniper') {
      player.scoped = false;
    }

    if (nextWeapon === null || options?.fromAutoPickup) {
      player.switchUntil = 0;
    } else {
      const tol = options?.tolerance ?? SERVER_SWITCH_TIME_TOLERANCE;
      player.switchUntil = nowSec + WEAPONS[nextWeapon].switchTime * tol;
    }
    return true;
  }

  return false;
}

export function validateAuthoritativeShotWeapon(
  player: ServerWeaponCarrier,
  requestedWeapon: WeaponId,
  nowSec: number,
  canUseWeapon: (weapon: WeaponId) => boolean,
): ShotWeaponValidationResult {
  if (!player.alive) {
    return { ok: false, reason: 'PLAYER_DEAD' };
  }

  if (!player.isBot && !canUseWeapon(requestedWeapon)) {
    return { ok: false, reason: 'WEAPON_NOT_OWNED' };
  }

  // Never mutate player.weapon during shot validation
  if (player.weapon === null || player.weapon !== requestedWeapon) {
    return { ok: false, reason: 'WEAPON_NOT_EQUIPPED' };
  }

  if (!player.isBot && nowSec < player.switchUntil) {
    return {
      ok: false,
      reason: 'SWITCH_COOLDOWN_ACTIVE',
      remainingSwitchSec: Number((player.switchUntil - nowSec).toFixed(4)),
    };
  }

  return { ok: true };
}
