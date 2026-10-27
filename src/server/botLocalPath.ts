/**
 * Botlar uchun mayda (0.8 m) mahalliy yo'l topish — binolar ichi, ayvon zinalari va konteyner oldiga
 * yetib borish uchun. Umumiy NavGraph 4 m kataklarda ishlaydi va konteynerlardan 2–5 m narida tugaydi.
 *
 * Har katak uchun turish balandligi (terrain yoki kollayder usti) tanlanadi; qo'shni kataklar orasida
 * ko'tarilish STEP_HEIGHT dan oshmasin, tushish 1.2 m gacha bo'lsin.
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

/** (x,z) ustunidagi turish mumkin bo'lgan balandliklar: terrain va shu ustundagi kollayder tepalari (refY ± 3 m). */
export function standingHeights(world: WorldDefinition, x: number, z: number, refY: number): number[] {
  const out = [sampleTerrainHeight(world.terrain, x, z)];
  const boxes = getWorldSpatialIndex(world).queryAABB(x - 0.05, z - 0.05, x + 0.05, z + 0.05, refY - 3, refY + 3);
  for (const b of boxes) {
    if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) out.push(b.max.y);
  }
  return out;
}

/** Berilgan (x,z) da `fromY` dan qadam bilan o'tish mumkin bo'lgan eng yaqin turish balandligi; yo'q bo'lsa null. */
function reachableHeight(world: WorldDefinition, x: number, z: number, fromY: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const h of standingHeights(world, x, z, fromY)) {
    const rise = h - fromY;
    if (rise > STEP_HEIGHT + 0.02 || rise < -MAX_DROP_M) continue;
    const d = Math.abs(rise);
    if (d >= bestD) continue;
    if (collidesAtWorld(world, x, h + 0.05, z, CLEAR_R, PLAYER_HEIGHT - 0.1)) continue;
    best = h;
    bestD = d;
  }
  return best;
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
  const start = idx(RADIUS_CELLS, RADIUS_CELLS);
  gScore[start] = 0;
  yAt[start] = from.y;

  // Oddiy binary-heap o'rniga kichik ochiq ro'yxat (≤1089 katak) — har 1.5 s da bot uchun yetarli tez
  const open: number[] = [start];
  const h = (i: number) => {
    const ix = i % size;
    const iz = Math.floor(i / size);
    return Math.hypot(ix - toIx, iz - toIz) * cell;
  };
  const goal = idx(toIx, toIz);
  let found = -1;
  let guard = 0;
  while (open.length && guard++ < 4000) {
    // eng kichik f = g + h
    let bi = 0;
    let bf = Infinity;
    for (let k = 0; k < open.length; k++) {
      const f = gScore[open[k]!]! + h(open[k]!);
      if (f < bf) {
        bf = f;
        bi = k;
      }
    }
    const cur = open[bi]!;
    open[bi] = open[open.length - 1]!;
    open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) {
      found = cur;
      break;
    }
    const cx = cur % size;
    const cz = Math.floor(cur / size);
    const cy = yAt[cur]!;
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
        const ny = reachableHeight(world, wx, wz, cy);
        if (ny === null) continue;
        // Diagonal o'tishda ikkala yon katak ham bo'sh bo'lsin (burchak kesib o'tmaslik)
        if (dx && dz) {
          if (reachableHeight(world, ox + cx * cell, wz, cy) === null) continue;
          if (reachableHeight(world, wx, oz + cz * cell, cy) === null) continue;
        }
        const step = Math.hypot(dx, dz) * cell + Math.abs(ny - cy) * 0.5;
        const g = gScore[cur]! + step;
        if (g < gScore[ni]!) {
          gScore[ni] = g;
          yAt[ni] = ny;
          came[ni] = cur;
          open.push(ni);
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
  else rev.push({ x: to.x, y: from.y, z: to.z });
  return rev;
}
