import {
  CROUCH_EYE_HEIGHT,
  CROUCH_HEIGHT,
  CROUCH_HITBOX_SCALE,
  EYE_HEIGHT,
  PLAYER_HEIGHT,
} from './constants';

/**
 * O'yinchi holati (tik turish / o'tirish) bo'yicha o'lchamlar — server, klient bashorati va
 * xitbokslar bir xil manbadan foydalanadi.
 */
export interface StanceCarrier {
  crouched?: boolean;
}

/** To'qnashuv balandligi (oyoqdan tepagacha), m. */
export function bodyHeightOf(b: StanceCarrier | null | undefined): number {
  return b?.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
}

/** Ko'z balandligi (oyoqdan), m — o'q chiqish nuqtasi va 1-shaxs kamera. */
export function eyeHeightOf(b: StanceCarrier | null | undefined): number {
  return b?.crouched ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
}

/** Xitboks balandliklarini masshtablash koeffitsienti (tik turish — 1). */
export function hitboxScaleOf(b: StanceCarrier | null | undefined): number {
  return b?.crouched ? CROUCH_HITBOX_SCALE : 1;
}
