/**
 * Botlar uchun mayda (0.8 m) mahalliy yo'l topish — binolar ichi, ayvon zinalari va konteyner oldiga
 * yetib borish uchun. Umumiy NavGraph 4 m kataklarda ishlaydi va konteynerlardan 2–5 m narida tugaydi.
 *
 * Har katak uchun turish balandligi (terrain yoki kollayder usti) tanlanadi; qo'shni kataklar orasida
 * ko'tarilish STEP_HEIGHT dan oshmasin, tushish 1.2 m gacha bo'lsin.
 *
 * Narx: binary-heap A*, katak balandliklari va kollayder tekshiruvlari bitta qidiruv ichida keshlanadi,
 * kengaytirish soni 2500 bilan chegaralangan (server tickida ~2–4 ms).
 */
import { PLAYER_HEIGHT, PLAYER_RADIUS, STEP_HEIGHT } from '../shared/constants';
import type { Vec3 } from '../shared/math';
import { collidesAtWorld } from '../shared/physics';
import { getWorldSpatialIndex } from '../shared/spatialIndex';
import { sampleTerrainHeight, type WorldDefinition } from '../shared/world';

export const LOCAL_PATH_CELL_M = 0.8;
/** Mahalliy yo'l qamrovi (markazdan katak soni): 16 × 0.8 = 12.8 m. */
const RADIUS_CELLS = 16;
const MAX_DROP_M = 1.2;
const CLEAR_R = PLAYER_RADIUS * 0.85;
const MAX_EXPANSIONS = 2500;

class MinHeap {
  private f: number[] = [];
  private n: number[] = [];
  get size(): number {
    return this.n.length;
  }
  push(node: number, score: number): void {
    this.f.push(score);
    this.n.push(node);
    let i = this.n.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p]! <= this.f[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.n[0]!;
    const lastF = this.f.pop()!;
    const lastN = this.n.pop()!;
    if (this.n.length > 0) {
      this.f[0] = lastF;
      this.n[0] = lastN;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n.length && this.f[l]! < this.f[m]!) m = l;
        if (r < this.n.length && this.f[r]! < this.f[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const tf = this.f[a]!;
    this.f[a] = this.f[b]!;
    this.f[b] = tf;
    const tn = this.n[a]!;
    this.n[a] = this.n[b]!;
    this.n[b] = tn;
  }
}

/** (x,z) ustunidagi turish mumkin bo'lgan balandliklar: terrain va shu ustundagi kollayder tepalari (refY ± 3 m). */
export function standingHeights(world: WorldDefinition, x: number, z: number, refY: number): number[] {
  const out = [sampleTerrainHeight(world.terrain, x, z)];
  const boxes = getWorldSpatialIndex(world).queryAABB(x - 0.05, z - 0.05, x + 0.05, z + 0.05, refY - 3, refY + 3);
  for (const b of boxes) {
    if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) out.push(b.max.y);
  }
  return out;
}

/**
 * `from` dan `to` ga mahalliy yo'l (katak markazlari, oxirida `to` ning o'zi). Yo'l topilmasa bo'sh massiv.
 * Qamrovdan tashqaridagi maqsad uchun ham bo'sh massiv — chaqiruvchi umumiy NavGraph ga qaytadi.
 */
export function findLocalPath(world: WorldDefinition, from: Vec3, to: Vec3): Vec3[] {
  const cell = LOCAL_PATH_CELL_M;
  const size = RADIUS_CELLS * 2 + 1;
  const ox = from.x - RADIUS_CELLS * cell;
  const oz = from.z - RADIUS_CELLS * cell;
  const toIx = Math.round((to.x - ox) / cell);
  const toIz = Math.round((to.z - oz) / cell);
  if (toIx < 0 || toIz < 0 || toIx >= size || toIz >= size) return [];

  const idx = (ix: number, iz: number) => iz * size + ix;
  const n = size * size;
  const gScore = new Float32Array(n).fill(Infinity);
  const yAt = new Float32Array(n);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);

  // Qidiruv ichidagi keshlar: har katak uchun balandliklar bir marta, har (katak, balandlik) uchun kollayder bir marta
  const heightsCache = new Map<number, number[]>();
  const collideCache = new Map<number, boolean>();
  const heightsOf = (i: number, wx: number, wz: number, refY: number): number[] => {
    let h = heightsCache.get(i);
    if (!h) {
      h = standingHeights(world, wx, wz, refY);
      heightsCache.set(i, h);
    }
    return h;
  };
  const blockedAt = (i: number, wx: number, wz: number, h: number): boolean => {
    const key = i * 4096 + (Math.round(h * 20) & 4095);
    let b = collideCache.get(key);
    if (b === undefined) {
      b = collidesAtWorld(world, wx, h + 0.05, wz, CLEAR_R, PLAYER_HEIGHT - 0.1);
      collideCache.set(key, b);
    }
    return b;
  };
  const reachable = (i: number, wx: number, wz: number, fromY: number): number | null => {
    let best: number | null = null;
    let bestD = Infinity;
    for (const h of heightsOf(i, wx, wz, fromY)) {
      const rise = h - fromY;
      if (rise > STEP_HEIGHT + 0.02 || rise < -MAX_DROP_M) continue;
      const d = Math.abs(rise);
      if (d >= bestD) continue;
      if (blockedAt(i, wx, wz, h)) continue;
      best = h;
      bestD = d;
    }
    return best;
  };

  const start = idx(RADIUS_CELLS, RADIUS_CELLS);
  // Boshlang'ich balandlik: bot turgan joyga eng yaqin turish sathi (havoda/pol ostida bo'lsa ham)
  let startY = from.y;
  {
    let bestD = 1.5;
    for (const h of heightsOf(start, from.x, from.z, from.y)) {
      const d = Math.abs(h - from.y);
      if (d < bestD) {
        bestD = d;
        startY = h;
      }
    }
  }
  gScore[start] = 0;
  yAt[start] = startY;

  const h = (i: number) => {
    const ix = i % size;
    const iz = Math.floor(i / size);
    return Math.hypot(ix - toIx, iz - toIz) * cell;
  };
  const goal = idx(toIx, toIz);
  const heap = new MinHeap();
  heap.push(start, h(start));
  let found = -1;
  let expansions = 0;
  while (heap.size > 0 && expansions++ < MAX_EXPANSIONS) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) {
      found = cur;
      break;
    }
    const cx = cur % size;
    const cz = Math.floor(cur / size);
    const cy = yAt[cur]!;
    const curG = gScore[cur]!;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
        const ni = idx(nx, nz);
        if (closed[ni]) continue;
        const wx = ox + nx * cell;
        const wz = oz + nz * cell;
        const ny = reachable(ni, wx, wz, cy);
        if (ny === null) continue;
        // Diagonal o'tishda ikkala yon katak ham bo'sh bo'lsin (burchak kesib o'tmaslik)
        if (dx && dz) {
          if (reachable(idx(cx, nz), ox + cx * cell, wz, cy) === null) continue;
          if (reachable(idx(nx, cz), wx, oz + cz * cell, cy) === null) continue;
        }
        const step = (dx && dz ? 1.41421356 : 1) * cell + Math.abs(ny - cy) * 0.5;
        const g = curG + step;
        if (g < gScore[ni]!) {
          gScore[ni] = g;
          yAt[ni] = ny;
          came[ni] = cur;
          heap.push(ni, g + h(ni));
        }
      }
    }
  }
  if (found < 0) return [];

  const rev: Vec3[] = [];
  for (let i = found; i !== -1 && i !== start; i = came[i]!) {
    rev.push({ x: ox + (i % size) * cell, y: yAt[i]!, z: oz + Math.floor(i / size) * cell });
  }
  rev.reverse();
  // Oxirgi nuqta — maqsadning o'zi (katak markazi emas)
  if (rev.length) rev[rev.length - 1] = { x: to.x, y: rev[rev.length - 1]!.y, z: to.z };
  else rev.push({ x: to.x, y: startY, z: to.z });
  return rev;
}
