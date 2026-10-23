export type Team = 'red' | 'blue' | 'none';
export type GameMode = 'tdm' | 'ffa' | 'forest_survival';

export const SERVER_PORT = 3000;
export const TICK_RATE = 30;

// O'yinchi o'lchamlari (metr)
export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const STEP_HEIGHT = 0.55;

// Harakat
export const GRAVITY = 22;
export const JUMP_SPEED = 7.6;
export const RUN_SPEED = 6.5;
export const WALK_SPEED = 3.0;
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
