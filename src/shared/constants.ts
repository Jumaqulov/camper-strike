export type Team = 'red' | 'blue' | 'none';
export type GameMode = 'tdm' | 'ffa' | 'forest_survival';

export const SERVER_PORT = 3000;
export const TICK_RATE = 30;

// O'yinchi o'lchamlari (metr)
export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const STEP_HEIGHT = 0.55;

// O'tirish (crouch) — Alt yoki C bosib turilganda
/** O'tirgan o'yinchining to'qnashuv balandligi, m. */
export const CROUCH_HEIGHT = 1.25;
/** O'tirgan holatdagi ko'z balandligi (kamera va o'q chiqish nuqtasi), m. */
export const CROUCH_EYE_HEIGHT = 1.1;
/** O'tirib yurish tezligi, m/s (sprint yo'q; yo'nalish/qurol ko'paytuvchilari baribir qo'llanadi). */
export const CROUCH_SPEED = 2.1;
/** O'tirganda bosh/tana/oyoq xitbokslari balandligi shu nisbatda kichrayadi. */
export const CROUCH_HITBOX_SCALE = CROUCH_HEIGHT / PLAYER_HEIGHT;

// Harakat
export const GRAVITY = 22;
export const JUMP_SPEED = 7.6;
/** Sprint (Shift bosilganda, asosan oldinga) tezligi, m/s. */
export const RUN_SPEED = 6.5;
/** Oddiy yurish (Shift'siz) tezligi, m/s. */
export const WALK_SPEED = 4.2;
/** Yon tomonga (A/D) yurish tezligi oldinga nisbatan. */
export const STRAFE_SPEED_MUL = 0.82;
/** Orqaga (S) yurish tezligi oldinga nisbatan. */
export const BACKPEDAL_SPEED_MUL = 0.68;
/** Sprint faqat harakat yo'nalishining oldinga ulushi shu qiymatdan katta bo'lsa ishlaydi. */
export const SPRINT_MIN_FORWARD = 0.3;

// Stamina (sprint chidamliligi), 0..1
/** To'liq staminadan bo'shgacha sprint vaqti (s). */
export const STAMINA_SPRINT_SECONDS = 6;
/** Bo'shdan to'liqqa tiklanish vaqti (s). */
export const STAMINA_REGEN_SECONDS = 9;
/** Stamina tugagach, yana sprint qilish uchun kamida shu darajagacha tiklanishi kerak. */
export const STAMINA_RELOCK_THRESHOLD = 0.25;
export const GROUND_ACCEL = 70;
export const AIR_ACCEL = 14;

// Jang
export const MAX_HP = 100;
export const RESPAWN_TIME = 3;
export const SPAWN_PROTECTION = 1.5;
export const GRENADES_PER_LIFE = 2;
export const GRENADE_FUSE = 2.2;
export const GRENADE_RADIUS = 7;
export const GRENADE_DAMAGE = 120;
export const GRENADE_THROW_SPEED = 17;
export const MATCH_END_DURATION = 10;

// Xitbokslar (oyoq nuqtasiga nisbatan)
export const BODY_HITBOX = { radius: 0.32, bottom: 0, top: 1.42 };
export const HEAD_HITBOX = { radius: 0.21, bottom: 1.42, top: 1.86 };

export const TEAM_NAMES: Record<Team, string> = { red: 'Qizil', blue: "Ko'k", none: '' };
