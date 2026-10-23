import type { Vec3 } from './math';
import type { Team } from './constants';

export type MaterialKind = 'ground' | 'wall' | 'concrete' | 'crate' | 'metal' | 'roof';

export interface Box {
  min: Vec3;
  max: Vec3;
  mat: MaterialKind;
}

export interface SpawnPoint {
  x: number;
  z: number;
  yaw: number;
  team: Team;
}

export interface MapDef {
  name: string;
  boxes: Box[];
  spawns: SpawnPoint[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/**
 * "Dust Arena" — 100x70 metrli maydon. Xarita markazga nisbatan nuqtaviy simmetrik
 * (x,z) -> (-x,-z), shuning uchun ikkala jamoa uchun ham adolatli.
 * Qizil jamoa g'arbda (-X), Ko'k jamoa sharqda (+X).
 */
export function buildDustArena(seed = 6501): MapDef {
  let rngState = seed | 0;
  const nextRng = () => {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const boxes: Box[] = [];
  const add = (cx: number, cz: number, w: number, d: number, h: number, y0 = 0, mat: MaterialKind = 'wall') => {
    boxes.push({
      min: { x: cx - w / 2, y: y0, z: cz - d / 2 },
      max: { x: cx + w / 2, y: y0 + h, z: cz + d / 2 },
      mat,
    });
  };
  const sym = (cx: number, cz: number, w: number, d: number, h: number, y0 = 0, mat: MaterialKind = 'wall') => {
    add(cx, cz, w, d, h, y0, mat);
    add(-cx, -cz, w, d, h, y0, mat);
  };
  const crate = (x: number, z: number, s = 1.4, y = 0) => sym(x, z, s, s, s, y, 'crate');

  const W = 100;
  const D = 70;

  // Yer
  add(0, 0, W + 4, D + 4, 1, -1, 'ground');
  // Tashqi devorlar
  add(0, -D / 2 - 0.5, W + 2, 1, 8, 0, 'concrete');
  add(0, D / 2 + 0.5, W + 2, 1, 8, 0, 'concrete');
  add(-W / 2 - 0.5, 0, 1, D, 8, 0, 'concrete');
  add(W / 2 + 0.5, 0, 1, D, 8, 0, 'concrete');

  // Yo'laklarni ajratuvchi devorlar (z = ±12), o'tish joylari x = -15, 0, 15 da
  for (const z of [12, -12]) {
    for (const [a, b] of [[-30, -18], [-12, -3], [3, 12], [18, 30]]) {
      add((a + b) / 2, z, b - a, 1, 4, 0, 'wall');
    }
  }

  // Markaziy bino (14x10), g'arb va sharqda eshik, shimol/janubda deraza, tomi platforma
  sym(-2.25, 4.75, 9.5, 0.5, 4, 0, 'wall');
  sym(5.75, 4.75, 2.5, 0.5, 4, 0, 'wall');
  sym(3.5, 4.75, 2, 0.5, 1.2, 0, 'wall');
  sym(3.5, 4.75, 2, 0.5, 1.8, 2.2, 'wall');
  for (const x of [-6.75, 6.75]) {
    add(x, 3, 0.5, 3, 4);
    add(x, -3, 0.5, 3, 4);
    add(x, 0, 0.5, 3, 1.2, 2.8);
  }
  add(0, 0, 14, 10, 0.4, 4, 'roof');
  add(-6.75, 0, 0.5, 10, 0.7, 4.4, 'wall'); // tomdagi parapet
  add(6.75, 0, 0.5, 10, 0.7, 4.4, 'wall');
  // Tomga chiqadigan zinapoyalar
  for (let i = 0; i < 11; i++) sym(-5.65 + i * 0.7, 5.8, 0.7, 1.6, (i + 1) * 0.4, 0, 'concrete');

  // Spawn himoya devorlari
  sym(-40, 7, 1, 5, 2.2, 0, 'concrete');
  sym(-40, -7, 1, 5, 2.2, 0, 'concrete');
  // Burchakdagi bunkerlar
  sym(-45, 30, 8, 8, 5, 0, 'concrete');
  sym(-45, -30, 8, 8, 5, 0, 'concrete');

  // Yuqori yo'lak
  crate(-30, 22);
  crate(-28.6, 22);
  crate(-29.3, 22, 1.4, 1.4);
  sym(-20, 25, 6, 1, 3, 0, 'wall');
  crate(-10, 28);
  crate(-8.6, 28);
  crate(-9.3, 28, 1.4, 1.4);
  sym(-4, 20, 1, 5, 3, 0, 'wall');
  // Pastki yo'lak (RV kemper furgonlari bilan)
  crate(-33, -20);
  crate(-33, -21.4);
  sym(-22, -24, 2.7, 7.2, 2.8, 0, 'metal'); // Yo'lda tiqilib qolgan RV furgonlar #1
  sym(-22, -19.6, 1.4, 1.4, 1.45, 0, 'crate'); // RV tomiga chiqish uchun yashik
  crate(-12, -20);
  crate(-12, -28, 2);
  sym(-4, -27, 1.6, 1.6, 5.5, 0, 'wall'); // Yog'och kuzatuv minorasi ustuni
  // O'rta yo'lak (Asosiy RV kemper furgonlari)
  crate(-20, 4);
  crate(-20, -4);
  sym(-27, 0, 2.7, 7.2, 2.8, 0, 'metal'); // Asosiy RV furgonlar #2
  sym(-27, 4.4, 1.4, 1.4, 1.45, 0, 'crate'); // RV tomiga sakrab chiqish yashigi
  sym(-15, 6, 1.4, 1.4, 3.6, 0, 'concrete'); // Tog' xarsangtoshi
  crate(-36, 16);
  crate(-36, -16, 1.8);

  // Spawn nuqtalari
  const spawns: SpawnPoint[] = [];
  const redPts: [number, number][] = [
    [-46, -4], [-46, 0], [-46, 4], [-43, -2], [-43, 2], [-44, -9], [-44, 9],
    [-47, -13], [-47, 13], [-42, -13], [-42, 13], [-47, -20], [-47, 20],
  ];
  for (const [x, z] of redPts) {
    spawns.push({ x, z, yaw: -Math.PI / 2, team: 'red' });
    spawns.push({ x: -x, z: -z, yaw: Math.PI / 2, team: 'blue' });
  }
  const ffaPts: [number, number][] = [
    [0, 0], [0, 25], [0, -25], [-20, 30], [20, -30], [-25, -8], [25, 8],
    [-10, -6], [10, 6], [-35, 28], [35, -28], [-15, -30], [15, 30],
  ];
  for (const [x, z] of ffaPts) spawns.push({ x, z, yaw: nextRng() * Math.PI * 2, team: 'none' });

  return {
    name: 'Route 65: RV Valley',
    boxes,
    spawns,
    bounds: { minX: -W / 2, maxX: W / 2, minZ: -D / 2, maxZ: D / 2 },
  };
}

export const MAP: MapDef = buildDustArena();
