import type { Material, Mesh, Object3D } from 'three';
import { MATCH_END_DURATION } from '../../../shared/constants';

/**
 * "Tong otguncha" — tong epilogi: raund tong bilan tugaganda server 'ended' fazasini NIGHT_DAWN_EPILOGUE_SEC ga
 * uzaytiradi. Shu vaqtda natija varag'i chiqmaydi ("Tong otdi!" belgisi), tirik qolgan atrofga qaray oladi,
 * bo'rilar uvlab o'rmonga qochadi; snapshotdan chiqqan qochoq bo'ri sahnada birdan yo'qolmaydi — so'nadi.
 *
 * Bu faylda: (1) sof vaqt yordamchilari (SurvivalUI va Game), (2) `WolfDepartures` — ketayotgan bo'rilarni
 * so'ndirish (three faqat tip sifatida — testlarda oddiy obyektlar bilan ishlaydi).
 */

export interface DawnEpilogueInput {
  /** Survival fazasi: 'waiting' | 'countdown' | 'playing' | 'ended'. */
  phase: string;
  /** survival.winReason ('dawn' — tong otdi). */
  winReason?: string | null;
  /** Fazaning qolgan vaqti (s, server butun soniyaga yaxlitlaydi). */
  timeLeft?: number | null;
}

/** Raund tong bilan tugadimi ('ended' + 'dawn') — epilog va natija ekrani davomida true. */
export function isDawnEnding(m: DawnEpilogueInput | null | undefined): boolean {
  return !!m && m.phase === 'ended' && m.winReason === 'dawn';
}

/**
 * Tong epilogi davom etyaptimi: tong uchun 'ended' fazasi natija ekrani (`resultsSec`, server
 * endedDisplayDurationSec = MATCH_END_DURATION) + epilogdan iborat — qolgan vaqt natija ekranidan ko'p bo'lsa,
 * hali epilog (natija varag'i chiqmaydi). Raund o'rtasida kirgan o'yinchida ham to'g'ri (server vaqti bo'yicha).
 */
export function dawnEpilogueActive(m: DawnEpilogueInput | null | undefined, resultsSec = MATCH_END_DURATION): boolean {
  return isDawnEnding(m) && typeof m!.timeLeft === 'number' && m!.timeLeft > resultsSec;
}

// ---------------- Qochib ketayotgan bo'rilarni so'ndirish ----------------

/** Snapshotdan chiqqan qochoq bo'ri shuncha soniyada so'nib yo'qoladi. */
export const WOLF_DEPART_FADE_SEC = 1.4;

/** So'nish shaffofligi 1 → 0 (smoothstep: boshida sekin, oxirida yumshoq). */
export function wolfDepartAlpha(ageSec: number, fadeSec = WOLF_DEPART_FADE_SEC): number {
  const k = Math.min(1, Math.max(0, Number.isFinite(ageSec) ? ageSec / Math.max(1e-3, fadeSec) : 1));
  return 1 - k * k * (3 - 2 * k);
}

export interface WolfDepartureInput {
  /** Bo'ri modelining ildizi (sahnada; pozitsiyasi shu yerda yuritiladi). */
  root: Object3D;
  /** Oxirgi yo'nalish (rad, server konvensiyasi: oldinga = (-sin, -cos)) va tezlik (m/s). */
  yaw: number;
  speed: number;
  /** Har kadr: animatsiya/LOD (WolfModel.update). */
  animate: (dt: number) => void;
  /** So'nish tugadi: sahnadan olib tashlash va dispose (bir marta chaqiriladi). */
  finish: () => void;
}

interface Departure extends WolfDepartureInput {
  age: number;
  vx: number;
  vz: number;
  /** Asl material → shu bo'ri uchun shaffof nusxa (umumiy GLB materiallari o'zgarmasin). */
  clones: Map<Material, Material>;
}

/**
 * Tong otgach snapshotdan chiqqan (qochib ketgan) bo'rilar: oxirgi yo'nalishi va tezligi bilan yugurishda davom
 * etadi (yer balandligi bo'yicha, to'siqqa yetsa to'xtaydi) va WOLF_DEPART_FADE_SEC ichida so'nadi. Materiallar
 * har bo'ri uchun nusxalanadi (asl umumiy materiallar shaffof bo'lib qolmaydi), tugaganda nusxalar dispose qilinadi.
 */
export class WolfDepartures {
  private list: Departure[] = [];

  constructor(
    private readonly groundAt: (x: number, z: number) => number,
    private readonly blocked: (x: number, y: number, z: number, dx: number, dz: number, dist: number) => boolean = () => false,
  ) {}

  get size(): number {
    return this.list.length;
  }

  add(d: WolfDepartureInput): void {
    const sp = Number.isFinite(d.speed) ? Math.max(0, d.speed) : 0;
    this.list.push({ ...d, age: 0, vx: -Math.sin(d.yaw) * sp, vz: -Math.cos(d.yaw) * sp, clones: new Map() });
  }

  update(dt: number): void {
    if (!this.list.length) return;
    const step = Math.max(0, dt);
    this.list = this.list.filter((d) => {
      d.age += step;
      if (d.age >= WOLF_DEPART_FADE_SEC) {
        this.finish(d);
        return false;
      }
      const p = d.root.position;
      const dist = Math.hypot(d.vx, d.vz) * step;
      if (dist > 1e-4) {
        const sp = Math.hypot(d.vx, d.vz);
        if (this.blocked(p.x, p.y, p.z, d.vx / sp, d.vz / sp, dist + 0.4)) {
          d.vx = 0;
          d.vz = 0;
        } else {
          p.x += d.vx * step;
          p.z += d.vz * step;
          p.y = this.groundAt(p.x, p.z);
        }
      }
      d.animate(step);
      this.applyOpacity(d, wolfDepartAlpha(d.age));
      return true;
    });
  }

  /** Hammasi darhol (xonadan chiqish/dispose). */
  clear(): void {
    const list = this.list;
    this.list = [];
    for (const d of list) this.finish(d);
  }

  private finish(d: Departure): void {
    d.finish();
    for (const c of d.clones.values()) c.dispose();
    d.clones.clear();
  }

  /** Har kadr: ildiz ostidagi barcha meshlarga shaffof nusxa (yangi qo'shilgan mesh ham — masalan GLB kech kelsa). */
  private applyOpacity(d: Departure, alpha: number): void {
    const own = new Set(d.clones.values());
    d.root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const swap = (m: Material): Material => {
        if (own.has(m)) return m;
        let c = d.clones.get(m);
        if (!c) {
          c = m.clone();
          c.transparent = true;
          d.clones.set(m, c);
          own.add(c);
        }
        return c;
      };
      if (Array.isArray(mesh.material)) {
        if (mesh.material.some((m) => !own.has(m))) mesh.material = mesh.material.map(swap);
      } else if (!own.has(mesh.material)) {
        mesh.material = swap(mesh.material);
      }
    });
    for (const c of d.clones.values()) c.opacity = alpha;
  }
}
