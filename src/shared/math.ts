export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vcopy = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
export const vadd = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vlen = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const vdist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const vdistXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export function vnorm(a: Vec3): Vec3 {
  const l = vlen(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** yaw=0 -> -Z tomonga qaraydi (Three.js kamerasi kabi). */
export function dirFromAngles(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

export function anglesFromDir(d: Vec3): { yaw: number; pitch: number } {
  const n = vnorm(d);
  return { yaw: Math.atan2(-n.x, -n.z), pitch: Math.asin(clamp(n.y, -1, 1)) };
}

/** a burchakdan b burchakka eng qisqa farq (-PI..PI). */
export function angleDiff(a: number, b: number): number {
  const TWO_PI = Math.PI * 2;
  return ((((b - a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

/** Yo'nalishga konus ichida tasodifiy og'ish beradi (o'q tarqalishi). */
export function spreadDir(d: Vec3, spread: number): Vec3 {
  if (spread <= 0) return vcopy(d);
  const up = Math.abs(d.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const r = vnorm(cross(d, up));
  const u = cross(r, d);
  const ang = Math.random() * Math.PI * 2;
  const rad = Math.sqrt(Math.random()) * spread;
  const ox = Math.cos(ang) * rad;
  const oy = Math.sin(ang) * rad;
  return vnorm({ x: d.x + r.x * ox + u.x * oy, y: d.y + r.y * ox + u.y * oy, z: d.z + r.z * ox + u.z * oy });
}

export function isVec3(v: unknown): v is Vec3 {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z);
}

/** Millimetr aniqlikda yaxlitlash (3 kasr). Deterministik dunyo/snapshot qiymatlari uchun yagona manba. */
export const q3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Deterministik 32-bit PRNG (Mulberry32). Berilgan butun urug' uchun klient va serverda
 * bir xil ketma-ketlik beradi. Dunyo generatsiyasi, o'simlik qoplami va zona jadvali — barchasi shu manbadan.
 */
export function createSeededRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
