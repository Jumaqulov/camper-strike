/**
 * Vahshiy bo'ri — server boshqaradigan yirtqich NPC (barcha rejimlarda ixtiyoriy, kelgusi "Tong otguncha"
 * rejimining asosi). Bu fayl faqat umumiy kontraktlar va sozlamalar: server (`server/wolf.ts`) AI ni,
 * klient (`client/game/wolf/`) ko'rinish va ovozni shu qiymatlarga tayanib quradi.
 */

/** Bo'rining server tomonidagi holati; klient shu holat bo'yicha animatsiya klipini tanlaydi. */
export type WolfState =
  | 'idle' // turibdi (nafas, quloq qimirlatish)
  | 'sniff' // hid izlayapti (boshi pastda)
  | 'alert' // shubhali tovush/hid — hushyor, g'ingshiydi
  | 'stalk' // nishonga sekin yaqinlashyapti (yurish)
  | 'hunt' // ov — yugurib quvyapti
  | 'attack' // tashlanib tishlayapti
  | 'hit' // zarba yedi (qisqa seskanish)
  | 'howl' // uvlayapti
  | 'dead'; // o'lgan (jasad bir necha soniya qoladi)

/** Snapshotdagi bo'ri (har tick). */
export interface WolfSnap {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  state: WolfState;
  /** Hozir ovlanayotgan o'yinchi (faqat stalk/hunt/attack holatlarida). */
  targetId?: string;
  /** Rang varianti 0..4 (klient modeli uchun; hozircha 0 — charcoal). */
  coat?: number;
}

/** Bo'ri uvladi (klient: pozitsion ovoz). */
export interface WolfHowlEvent {
  id: string;
  x: number;
  y: number;
  z: number;
}

/** Bo'ri tishladi (klient: ovoz + qon effekti; `target` — qurbon, `hit` — tegdimi). */
export interface WolfBiteEvent {
  id: string;
  target: string;
  hit: boolean;
  x: number;
  y: number;
  z: number;
}

/** Bo'ri o'ldi (klient: kim o'ldirgani chatga/killfeedga). */
export interface WolfDeathEvent {
  id: string;
  killerId: string;
  killerName: string;
}

// ---------- O'lchamlar va jang ----------
/** Bo'ri gavdasi kollayder radiusi (m) — o'yinchi kapsulasiga yaqin. */
export const WOLF_RADIUS = 0.45;
/** Yelka balandligi (m): xitboks tepasi va "ko'z" balandligi shu atrofda. */
export const WOLF_HEIGHT = 1.15;
export const WOLF_EYE_HEIGHT = 1.0;
export const WOLF_MAX_HP = 160;
/** Tishlash masofasi (bo'ri markazidan qurbon markazigacha, m). */
export const WOLF_BITE_RANGE = 2.0;
/** Tishlash paytida qurbon shu masofadan uzoqlashsa — tegmaydi. */
export const WOLF_BITE_CONNECT_RANGE = 2.4;
/** Bir tishlash zarari; hujum (0.7 s) + tanaffus (1.2 s) bilan ~10 hp/s — qochib otishga imkon qoladi. */
export const WOLF_BITE_DAMAGE = 20;
/** Hujum klipi davomiyligi va tishlash lahzasi (model: Attack 0.7 s, bite 0.30 s). */
export const WOLF_ATTACK_DURATION = 0.7;
export const WOLF_BITE_AT = 0.3;
/** Ketma-ket hujumlar orasidagi tanaffus (s). */
export const WOLF_ATTACK_COOLDOWN = 1.2;
/** O'yinchi qayta tug'ilish nuqtasi tirik bo'ridan kamida shuncha uzoq bo'lsin (m). */
export const WOLF_SPAWN_CLEARANCE = 28;
/** Zarba yeganda seskanish (s); hujum paytida uzilmaydi. */
export const WOLF_HIT_FLINCH = 0.4;
/** Jasad snapshotlarda qoladigan vaqt (s). */
export const WOLF_CORPSE_SEC = 6;
/** Klassik rejimlarda (TDM/FFA) o'lgan bo'ri qayta paydo bo'lish vaqti (s). */
export const WOLF_RESPAWN_SEC = 25;

// ---------- Tezliklar ----------
export const WOLF_WALK_SPEED = 2.4;
export const WOLF_STALK_SPEED = 4.2;
/** Sprint qilayotgan o'yinchi (6.5 m/s) dan tezroq — faqat to'siq va eshiklar qutqaradi. */
export const WOLF_RUN_SPEED = 7.6;
/** Bo'ri burilish tezligi (rad/s). */
export const WOLF_TURN_RATE = 6;

// ---------- Sezgi ----------
/** Ko'rish masofasi (LOS kerak) va old yarim-doira (dot chegarasi; yaqin masofada har tomonga ko'radi). */
export const WOLF_SIGHT_RANGE = 42;
export const WOLF_SIGHT_FOV_DOT = -0.2;
export const WOLF_SIGHT_NEAR = 7;
/** Hid: LOS shart emas; yugurgan o'yinchi uzoqroqdan, o'tirib yurgan yaqindan sezilgadi. */
export const WOLF_SMELL_RANGE = 16;
export const WOLF_SMELL_SPRINT_MUL = 1.5;
export const WOLF_SMELL_CROUCH_MUL = 0.45;
/** O'q ovozi shu masofadan eshitiladi va bo'rini o'sha joyga tortadi. */
export const WOLF_HEAR_SHOT_RANGE = 80;
/** Nishonni ko'rmay/sezmay shuncha vaqt o'tsa — izini yo'qotadi. */
export const WOLF_LOSE_TARGET_SEC = 7;
/** Nishon bo'ridan shuncha balandda (2-qavat/tom) bo'lsa — yetolmaydi, pastda aylanib uvlaydi. */
export const WOLF_UNREACHABLE_DY = 1.6;
/** Sayrda uvlash oralig'i (s). */
export const WOLF_HOWL_MIN_SEC = 28;
export const WOLF_HOWL_MAX_SEC = 55;

/** Xonadagi bo'rilar sonining chegarasi. */
export const WOLF_MAX_PER_ROOM = 6;

export const WOLF_NAME_UZ = "Vahshiy bo'ri";

/** Bo'ri ID formati (`wolf:3`); KillEvent/HurtEvent da hujumchi sifatida ishlatiladi. */
export function isWolfId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('wolf:');
}

/** Holat bo'yicha harakat tezligi (server). */
export function wolfSpeedForState(state: WolfState): number {
  switch (state) {
    case 'stalk':
      return WOLF_STALK_SPEED;
    case 'hunt':
      return WOLF_RUN_SPEED;
    case 'idle':
    case 'sniff':
    case 'alert':
      return WOLF_WALK_SPEED;
    default:
      return 0;
  }
}

/** Bo'ri shu holatda o'yinchiga xavf solyaptimi (HUD ogohlantirishi uchun). */
export function isWolfThreatState(state: WolfState): boolean {
  return state === 'stalk' || state === 'hunt' || state === 'attack';
}
