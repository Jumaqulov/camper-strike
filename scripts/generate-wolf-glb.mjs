// Feral wolf generator: a sculpted signed-distance model (ellipsoids + round cones blended
// with smooth unions) -> surface nets -> QEM decimation -> rig, skin, clips -> glTF 2.0 binary.
// Pure Node, no dependencies, deterministic (same bytes on every run).
//
//   node scripts/generate-wolf-glb.mjs
//
// Writes public/models/characters/feral_wolf_rigged.glb (charcoal coat) plus
// feral_wolf_{red,tan,black,white}_rigged.glb: same mesh, rig and clips, other coat colours.
// Axes: Y up, nose toward -Z, the wolf's right side is +X, origin on the ground between the paws.
// Every joint has an identity rest rotation, so inverse bind matrices are pure translations.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/models/characters');
const FPS = 30;
const TAU = Math.PI * 2;
const CELL = 0.0105; // surface-nets grid spacing (m)
const BODY_TRIS = 9800; // decimation targets
const JAW_TRIS = 900;

// ============== Vector / quaternion math ==============
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => mul(a, 1 / (length(a) || 1));
const lerp3 = (a, b, t) => add(a, mul(sub(b, a), t));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (v) => v * v * (3 - 2 * v);
const ss = (e0, e1, x) => smooth(clamp01((x - e0) / (e1 - e0)));
const mixC = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qAxis = (axis, ang) => {
  const s = Math.sin(ang / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)];
};
// Euler [pitch X, yaw Y, roll Z], applied as yaw * pitch * roll
const qEuler = ([x, y, z]) => qMul(qMul(qAxis([0, 1, 0], y), qAxis([1, 0, 0], x)), qAxis([0, 0, 1], z));
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qRot = (q, v) => {
  const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), qConj(q));
  return [p[0], p[1], p[2]];
};
const qPitch = (q) => {
  const f = qRot(q, [0, 0, -1]);
  return Math.atan2(f[1], -f[2]);
};
// Rotation of the basis vectors (for oriented ellipsoids)
const rotBasis = (euler) => {
  const q = qEuler(euler);
  return [qRot(q, [1, 0, 0]), qRot(q, [0, 1, 0]), qRot(q, [0, 0, 1])];
};

// Integer hash -> [0,1) for deterministic variation
const hash = (...n) => {
  let x = 2166136261;
  for (const v of n) {
    x ^= Math.round(v * 1000) | 0;
    x = Math.imul(x, 16777619);
  }
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
};

// ============== Coats (sRGB hex -> linear) ==============
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hex = (h) => {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => srgbToLinear(c / 255));
};
const COMMON = {
  nose: hex('#131114'),
  lip: hex('#1d1a1e'),
  gum: hex('#9c3a45'),
  tongue: hex('#c45a64'),
  pad: hex('#29252a'),
  fang: hex('#f1ebd9'),
  claw: hex('#1a181c'),
  pupil: hex('#0a0809'),
  black: [0, 0, 0],
};
// The five coats of the reference sheet, left to right. `socks` = how white the lower legs are.
const COATS = {
  charcoal: { dark: '#2b2a31', fur: '#44434c', mid: '#605f69', light: '#8d8c96', cream: '#ecebe6', shade: '#c4c2bd', inner: '#ddd6d0', socks: 0.15 },
  red: { dark: '#5e2412', fur: '#86381a', mid: '#ad5a2a', light: '#d08a52', cream: '#f4ece0', shade: '#dccbb7', inner: '#f0e2d4', socks: 1 },
  tan: { dark: '#6e4f2b', fur: '#946f42', mid: '#b8925e', light: '#d6b886', cream: '#f2e9d7', shade: '#dacbb0', inner: '#eee1cc', socks: 0.65 },
  black: { dark: '#100f12', fur: '#1b1a1f', mid: '#29282e', light: '#45434b', cream: '#8f8b88', shade: '#6c6866', inner: '#84807d', socks: 0 },
  white: { dark: '#7f7e87', fur: '#9d9ca5', mid: '#bdbcc4', light: '#dddce2', cream: '#f6f5f2', shade: '#dcdad5', inner: '#f2ece8', socks: 1 },
};
const coatPalette = (name) => {
  const c = COATS[name];
  return { ...COMMON, dark: hex(c.dark), fur: hex(c.fur), mid: hex(c.mid), light: hex(c.light), cream: hex(c.cream), shade: hex(c.shade), inner: hex(c.inner), socks: c.socks };
};

// Surface colour per sculpt "role"; p = position, n = normal
const ROLE_COLOR = {
  coat: (P, p, n) => mixC(mixC(P.mid, P.dark, ss(0.05, 0.85, n[1])), P.shade, ss(-0.35, -0.85, n[1])),
  dark: (P, p, n) => mixC(P.fur, P.dark, ss(-0.2, 0.6, n[1])),
  head: (P, p, n) => mixC(P.mid, P.fur, ss(0.1, 0.8, n[1])),
  mask: (P, p, n) => mixC(P.cream, P.shade, ss(0.2, -0.8, n[1]) * 0.35),
  bib: (P) => P.cream,
  belly: (P) => P.shade,
  muzzle: (P, p, n) => mixC(P.cream, P.light, ss(0.35, 0.9, n[1]) * 0.7),
  bridge: (P, p, n) => mixC(P.light, P.mid, ss(0.5, 0.95, n[1]) * 0.6),
  flew: (P, p) => mixC(P.cream, P.lip, ss(0.935, 0.92, p[1])),
  lid: (P) => P.lip,
  nose: (P) => P.nose,
  lip: (P) => P.lip,
  gum: (P) => P.gum,
  tongue: (P) => P.tongue,
  inner: (P) => P.inner,
  leg: (P, p, n) => {
    let c = mixC(P.fur, P.dark, ss(0.4, 0.8, p[1]) * 0.7);
    c = mixC(c, P.mid, ss(0.0, -0.8, n[2]) * 0.45); // a little lighter on the fronts
    return mixC(c, P.cream, ss(0.42, 0.18, p[1]) * P.socks);
  },
  paw: (P, p, n) => (n[1] < -0.75 ? P.pad : mixC(mixC(P.fur, P.mid, 0.35), P.cream, P.socks)),
  tail: (P, p, n) => mixC(mixC(P.mid, P.dark, ss(-0.2, 0.7, n[1] + n[2] * 0.5)), P.dark, ss(0.55, 0.45, p[1])),
};

// The sculpt is authored at a smaller head size; the finished head (and its joints and
// sockets) is scaled about this point so it reads big against the heavy body.
const HEAD_PIVOT = [0, 0.99, -0.66];
const HEAD_SCALE = [1.12, 1.035, 1.06];
const HEAD_JOINTS = ['Head', 'Jaw', 'Ear_L', 'Ear_R'];
const headScaled = (p, w = 1) => [0, 1, 2].map((c) => HEAD_PIVOT[c] + (p[c] - HEAD_PIVOT[c]) * (1 + (HEAD_SCALE[c] - 1) * w));

// ============== Skeleton (rest = standing alert, world positions) ==============
const JOINT_DEFS = [
  ['Root', null, [0, 0, 0]],
  ['Hips', 'Root', [0, 0.9, 0.4]],
  ['Spine', 'Hips', [0, 0.93, 0.08]],
  ['Chest', 'Spine', [0, 0.96, -0.28]],
  ['Neck', 'Chest', [0, 0.99, -0.5]],
  ['Head', 'Neck', [0, 1.0, -0.7]],
  ['Jaw', 'Head', headScaled([0, 0.955, -0.73])],
  ['Ear_L', 'Head', headScaled([-0.085, 1.1, -0.7])],
  ['Ear_R', 'Head', headScaled([0.085, 1.1, -0.7])],
  ['Tail_1', 'Hips', [0, 0.89, 0.6]],
  ['Tail_2', 'Tail_1', [0, 0.73, 0.74]],
  ['Tail_3', 'Tail_2', [0, 0.52, 0.835]],
];
const LEG_REST = {
  B: { parent: 'Hips', A: [0.15, 0.84, 0.42], B: [0.16, 0.54, 0.28], C: [0.16, 0.22, 0.5], P: [0.16, 0, 0.45] },
  F: { parent: 'Chest', A: [0.17, 0.8, -0.34], B: [0.18, 0.48, -0.27], C: [0.18, 0.13, -0.4], P: [0.18, 0, -0.45] },
};
const LEGS = {};
for (const end of ['B', 'F']) {
  for (const side of ['L', 'R']) {
    const r = LEG_REST[end];
    const fx = side === 'L' ? (p) => [-p[0], p[1], p[2]] : (p) => p;
    const id = end + side;
    LEGS[id] = {
      id, end, side, sx: side === 'L' ? -1 : 1, parent: r.parent,
      upper: `UpperLeg_${id}`, lower: `LowerLeg_${id}`, foot: `Foot_${id}`,
      A: fx(r.A), B: fx(r.B), C: fx(r.C), P: fx(r.P),
    };
  }
}
for (const id of ['BL', 'BR', 'FL', 'FR']) {
  const l = LEGS[id];
  JOINT_DEFS.push([l.upper, l.parent, l.A], [l.lower, l.upper, l.B], [l.foot, l.lower, l.C]);
}
const JOINT_NAMES = JOINT_DEFS.map((d) => d[0]);
const JI = new Map(JOINT_NAMES.map((n, i) => [n, i]));
const REST = Object.fromEntries(JOINT_DEFS.map(([n, , p]) => [n, p]));
const PARENT = Object.fromEntries(JOINT_DEFS.map(([n, p]) => [n, p]));
const LOCAL_T = Object.fromEntries(JOINT_DEFS.map(([n, p, pos]) => [n, p ? sub(pos, REST[p]) : pos]));
const J = (name) => {
  if (!JI.has(name)) throw new Error(`unknown joint ${name}`);
  return JI.get(name);
};
const TAIL_TIP = [0, 0.27, 0.885];

// ============== Signed distance sculpt ==============
const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a, b, k) => -smin(-a, -b, k);

// joints: [[name, weight], ...]
function ellipsoid(c, r, { rot = [0, 0, 0], k = 0.03, role = 'coat', joints, sub: isSub = false } = {}) {
  const [ax, ay, az] = rotBasis(rot);
  const R = Math.max(...r);
  return {
    kind: 0, sub: isSub, k, role, joints,
    cx: c[0], cy: c[1], cz: c[2],
    a0: ax[0], a1: ax[1], a2: ax[2], b0: ay[0], b1: ay[1], b2: ay[2], c0: az[0], c1: az[1], c2: az[2],
    ir0: 1 / r[0], ir1: 1 / r[1], ir2: 1 / r[2], rmin: Math.min(...r),
    lo: [c[0] - R, c[1] - R, c[2] - R], hi: [c[0] + R, c[1] + R, c[2] + R],
  };
}
// Round cone from a (radius r1) to b (radius r2); `flat` squashes it along a normal (ears)
function cone(a, b, r1, r2, { k = 0.03, role = 'coat', joints, sub: isSub = false, flat } = {}) {
  const ba = sub(b, a);
  const l2 = dot(ba, ba);
  const rr = r1 - r2;
  const R = Math.max(r1, r2);
  return {
    kind: 1, sub: isSub, k, role, joints,
    ax: a[0], ay: a[1], az: a[2], bax: ba[0], bay: ba[1], baz: ba[2],
    l2, rr, a2: l2 - rr * rr, il2: 1 / l2, sg: Math.sign(rr), r1, r2,
    flat: !!flat, nx: flat ? flat.n[0] : 0, ny: flat ? flat.n[1] : 0, nz: flat ? flat.n[2] : 0, s: flat ? flat.s : 1,
    lo: [Math.min(a[0], b[0]) - R, Math.min(a[1], b[1]) - R, Math.min(a[2], b[2]) - R],
    hi: [Math.max(a[0], b[0]) + R, Math.max(a[1], b[1]) + R, Math.max(a[2], b[2]) + R],
  };
}

function primDist(e, px, py, pz) {
  if (e.kind === 0) {
    const dx = px - e.cx, dy = py - e.cy, dz = pz - e.cz;
    const x = (dx * e.a0 + dy * e.a1 + dz * e.a2) * e.ir0;
    const y = (dx * e.b0 + dy * e.b1 + dz * e.b2) * e.ir1;
    const z = (dx * e.c0 + dy * e.c1 + dz * e.c2) * e.ir2;
    const k0 = Math.sqrt(x * x + y * y + z * z);
    const k1 = Math.sqrt(x * x * e.ir0 * e.ir0 + y * y * e.ir1 * e.ir1 + z * z * e.ir2 * e.ir2);
    return k1 < 1e-12 ? -e.rmin : (k0 * (k0 - 1)) / k1;
  }
  let qx = px - e.ax, qy = py - e.ay, qz = pz - e.az;
  if (e.flat) {
    const t = (qx * e.nx + qy * e.ny + qz * e.nz) * (e.s - 1);
    qx += e.nx * t;
    qy += e.ny * t;
    qz += e.nz * t;
  }
  const y = qx * e.bax + qy * e.bay + qz * e.baz;
  const z = y - e.l2;
  const xx = qx * e.l2 - e.bax * y, xy = qy * e.l2 - e.bay * y, xz = qz * e.l2 - e.baz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * e.l2;
  const z2 = z * z * e.l2;
  const k = e.sg * e.rr * e.rr * x2;
  let d;
  if (Math.sign(z) * e.a2 * z2 > k) d = Math.sqrt(x2 + z2) * e.il2 - e.r2;
  else if (Math.sign(y) * e.a2 * y2 < k) d = Math.sqrt(x2 + y2) * e.il2 - e.r1;
  else d = (Math.sqrt(x2 * e.a2 * e.il2) + y * e.rr) * e.il2 - e.r1;
  return e.flat ? d / e.s : d;
}

// Bucketed field over a primitive list (adds blended with smin, subtractions with smax)
function makeField(prims, { ground = false } = {}) {
  const list = [...prims.filter((p) => !p.sub), ...prims.filter((p) => p.sub)];
  const B = 0.06;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of list) for (let c = 0; c < 3; c++) {
    lo[c] = Math.min(lo[c], p.lo[c] - p.k);
    hi[c] = Math.max(hi[c], p.hi[c] + p.k);
  }
  const dims = [0, 1, 2].map((c) => Math.ceil((hi[c] - lo[c]) / B) + 1);
  const buckets = new Array(dims[0] * dims[1] * dims[2]).fill(null);
  for (const p of list) {
    const i0 = [0, 1, 2].map((c) => Math.floor((p.lo[c] - p.k - 0.02 - lo[c]) / B));
    const i1 = [0, 1, 2].map((c) => Math.floor((p.hi[c] + p.k + 0.02 - lo[c]) / B));
    for (let z = Math.max(0, i0[2]); z <= Math.min(dims[2] - 1, i1[2]); z++)
      for (let y = Math.max(0, i0[1]); y <= Math.min(dims[1] - 1, i1[1]); y++)
        for (let x = Math.max(0, i0[0]); x <= Math.min(dims[0] - 1, i1[0]); x++) {
          const i = x + dims[0] * (y + dims[1] * z);
          (buckets[i] ||= []).push(p);
        }
  }
  const near = (px, py, pz) => {
    const x = Math.floor((px - lo[0]) / B), y = Math.floor((py - lo[1]) / B), z = Math.floor((pz - lo[2]) / B);
    if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) return null;
    return buckets[x + dims[0] * (y + dims[1] * z)];
  };
  const value = (px, py, pz) => {
    const ps = near(px, py, pz);
    if (!ps) return 1;
    let d = 1e9;
    for (const p of ps) {
      const di = primDist(p, px, py, pz);
      if (p.sub) d = smax(d, -di, p.k);
      else d = d > 1e8 ? di : smin(d, di, p.k);
    }
    if (d > 1e8) return 1;
    return ground ? smax(d, -py, 0.012) : d;
  };
  const grad = (p, e = 0.002) => normalize([
    value(p[0] + e, p[1], p[2]) - value(p[0] - e, p[1], p[2]),
    value(p[0], p[1] + e, p[2]) - value(p[0], p[1] - e, p[2]),
    value(p[0], p[1], p[2] + e) - value(p[0], p[1], p[2] - e),
  ]);
  return { value, grad, near, lo, hi };
}

// March from an interior point outward to the surface
function surfacePoint(field, origin, dir) {
  const d = normalize(dir);
  let t0 = 0;
  let t1 = 0;
  for (let t = 0.005; t < 1; t += 0.005) {
    if (field.value(...add(origin, mul(d, t))) > 0) {
      t1 = t;
      break;
    }
    t0 = t;
  }
  if (!t1) return null;
  for (let i = 0; i < 24; i++) {
    const tm = (t0 + t1) / 2;
    if (field.value(...add(origin, mul(d, tm))) > 0) t1 = tm;
    else t0 = tm;
  }
  return add(origin, mul(d, (t0 + t1) / 2));
}

// Blend of the primitives touching a point: [{prim, w}], sharper sigma -> crisper boundaries
function influences(field, p, sigma) {
  const ps = field.near(p[0], p[1], p[2]) || [];
  const ds = ps.map((e) => Math.abs(primDist(e, p[0], p[1], p[2])));
  const dmin = Math.min(...ds);
  const out = [];
  ps.forEach((e, i) => {
    const t = 1 - (ds[i] - dmin) / sigma;
    if (t > 0) out.push({ prim: e, w: t * t });
  });
  return out;
}
function skinAt(field, p) {
  const acc = new Map();
  for (const { prim, w } of influences(field, p, 0.035)) {
    for (const [name, jw] of prim.joints) acc.set(name, (acc.get(name) || 0) + w * jw);
  }
  return [...acc].map(([n, w]) => [J(n), w]);
}

// ============== The sculpt ==============
const TOES = [[-0.062, -0.054], [-0.022, -0.082], [0.022, -0.082], [0.062, -0.054]];
const W = (...pairs) => {
  const out = [];
  for (let i = 0; i < pairs.length; i += 2) out.push([pairs[i], pairs[i + 1]]);
  return out;
};
const body = [];
const jaw = [];

// --- trunk: deep chest, moderate waist tuck, strong hindquarters ---
body.push(
  ellipsoid([0, 0.79, -0.3], [0.22, 0.27, 0.29], { joints: W('Chest', 1), k: 0.07 }), // deep chest
  ellipsoid([0, 0.94, -0.28], [0.22, 0.12, 0.25], { joints: W('Chest', 1), role: 'dark', k: 0.07 }), // shoulder hump
  ellipsoid([0, 0.81, -0.04], [0.2, 0.21, 0.26], { joints: W('Spine', 0.6, 'Chest', 0.4), k: 0.07 }), // ribcage
  ellipsoid([0, 0.85, 0.17], [0.16, 0.15, 0.2], { joints: W('Spine', 0.6, 'Hips', 0.4), k: 0.07 }), // loin (tucked)
  ellipsoid([0, 0.86, 0.41], [0.175, 0.16, 0.21], { joints: W('Hips', 1), k: 0.07 }), // pelvis
  ellipsoid([0, 0.66, -0.12], [0.13, 0.09, 0.2], { joints: W('Chest', 0.5, 'Spine', 0.5), role: 'belly', k: 0.08 }), // brisket line
);
// --- neck ---
const NECK_A = [0, 0.86, -0.36];
const NECK_B = [0, 1.0, -0.66];
body.push(cone(NECK_A, NECK_B, 0.205, 0.14, { joints: W('Neck', 1), k: 0.07 }));
body.push(ellipsoid([0, 0.75, -0.52], [0.15, 0.18, 0.13], { joints: W('Chest', 0.5, 'Neck', 0.5), role: 'bib', k: 0.07 })); // chest front

// --- head (upper skull + muzzle) ---
const HJ = W('Head', 1);
body.push(
  ellipsoid([0, 1.035, -0.7], [0.132, 0.106, 0.14], { joints: HJ, role: 'head', k: 0.04 }),
  ellipsoid([0, 1.05, -0.66], [0.108, 0.088, 0.095], { joints: HJ, role: 'head', k: 0.04 }), // crown
  cone([0, 0.99, -0.8], [0, 0.972, -0.975], 0.07, 0.045, { joints: HJ, role: 'muzzle', k: 0.035 }),
  ellipsoid([0, 1.012, -0.89], [0.034, 0.032, 0.105], { joints: HJ, role: 'bridge', k: 0.03 }),
  ellipsoid([0, 0.998, -0.995], [0.031, 0.024, 0.029], { joints: HJ, role: 'nose', k: 0.012 }),
);
for (const s of [-1, 1]) {
  body.push(
    ellipsoid([s * 0.08, 0.982, -0.755], [0.08, 0.072, 0.09], { joints: HJ, role: 'mask', k: 0.04 }), // cheeks
    ellipsoid([s * 0.038, 0.948, -0.9], [0.036, 0.03, 0.08], { joints: HJ, role: 'flew', k: 0.02 }), // upper lips
    // heavy brow ridge: low over the nose, sweeping up to the temples
    ellipsoid([s * 0.054, 1.06, -0.815], [0.062, 0.025, 0.044], { rot: [0, -s * 0.5, s * 0.4], joints: HJ, role: 'dark', k: 0.02 }),
    ellipsoid([s * 0.068, 1.036, -0.842], [0.028, 0.019, 0.022], { rot: [0, -s * 0.5, s * 0.35], joints: HJ, role: 'lid', k: 0.008, sub: true }), // eye socket
  );
}
// --- ears: flattened cones with a cupped front ---
for (const s of [-1, 1]) {
  const side = s < 0 ? 'Ear_L' : 'Ear_R';
  const n = normalize([s * 0.3, 0.05, -1]);
  const base = [s * 0.086, 1.1, -0.7];
  const tip = [s * 0.128, 1.226, -0.682];
  body.push(cone(base, tip, 0.07, 0.011, { joints: W(side, 1), role: 'dark', k: 0.02, flat: { n, s: 2.2 } }));
  body.push(cone(add(base, add(mul(n, 0.014), [0, 0.014, 0])), add(tip, mul(n, 0.009)), 0.052, 0.004,
    { joints: W(side, 1), role: 'inner', k: 0.008, sub: true, flat: { n, s: 2.2 } }));
}

// --- legs: muscular tops, slim lower legs with clear elbow / hock angles, big paws ---
for (const leg of Object.values(LEGS)) {
  const { A, B, C, P, sx } = leg;
  const up = W(leg.upper, 1);
  const lo = W(leg.lower, 1);
  const ft = W(leg.foot, 1);
  if (leg.end === 'F') {
    body.push(
      ellipsoid([sx * 0.175, 0.72, -0.32], [0.1, 0.17, 0.13], { joints: W('Chest', 0.5, leg.upper, 0.5), k: 0.06 }), // shoulder
      cone(add(A, [0, -0.05, 0]), B, 0.1, 0.07, { joints: up, role: 'leg', k: 0.045 }), // upper arm
      ellipsoid(add(B, [0, 0.01, 0.03]), [0.05, 0.06, 0.05], { joints: W(leg.upper, 0.5, leg.lower, 0.5), role: 'leg', k: 0.03 }), // elbow
      cone(B, lerp3(B, C, 0.35), 0.066, 0.056, { joints: lo, role: 'leg', k: 0.035 }), // forearm muscle
      cone(lerp3(B, C, 0.35), C, 0.056, 0.046, { joints: lo, role: 'leg', k: 0.03 }),
      cone(C, [P[0], 0.06, P[2] + 0.01], 0.048, 0.05, { joints: ft, role: 'leg', k: 0.025 }), // pastern
    );
  } else {
    body.push(
      ellipsoid([sx * 0.15, 0.72, 0.4], [0.105, 0.19, 0.16], { joints: W('Hips', 0.4, leg.upper, 0.6), k: 0.06 }), // thigh muscle
      cone(A, B, 0.11, 0.062, { joints: up, role: 'leg', k: 0.045 }),
      cone(B, lerp3(B, C, 0.4), 0.062, 0.05, { joints: lo, role: 'leg', k: 0.035 }), // gaskin
      cone(lerp3(B, C, 0.4), C, 0.05, 0.04, { joints: lo, role: 'leg', k: 0.03 }),
      ellipsoid(add(C, [0, 0.01, 0.025]), [0.035, 0.045, 0.035], { joints: W(leg.lower, 0.5, leg.foot, 0.5), role: 'leg', k: 0.02 }), // hock point
      cone(C, [P[0], 0.06, P[2] + 0.02], 0.042, 0.046, { joints: ft, role: 'leg', k: 0.025 }), // metatarsus
    );
  }
  // big paw with four fat toes; the ground plane flattens the pads
  const k = leg.end === 'F' ? 1.12 : 1.02;
  const pz = P[2];
  body.push(ellipsoid([P[0], 0.045, pz - 0.01], [0.075 * k, 0.05, 0.082 * k], { joints: ft, role: 'paw', k: 0.03 }));
  for (const [dx, dz] of TOES) {
    body.push(ellipsoid([P[0] + dx * k, 0.031, pz + dz * k], [0.028 * k, 0.031, 0.036 * k], { rot: [0, -dx * 4, 0], joints: ft, role: 'paw', k: 0.012 }));
  }
}

// --- tail ---
const TAIL_PTS = [[0, 0.86, 0.56], REST.Tail_1, REST.Tail_2, REST.Tail_3, TAIL_TIP];
const TAIL_R = [0.07, 0.085, 0.1, 0.09, 0.035];
const TAIL_J = ['Hips', 'Tail_1', 'Tail_2', 'Tail_3'];
for (let i = 0; i < 4; i++) {
  body.push(cone(TAIL_PTS[i], TAIL_PTS[i + 1], TAIL_R[i], TAIL_R[i + 1], { joints: W(TAIL_J[i], 1), role: 'tail', k: 0.03 }));
}

// --- lower jaw (separate mesh so the mouth can open) ---
const JJ = W('Jaw', 1);
jaw.push(
  cone([0, 0.945, -0.69], [0, 0.918, -0.945], 0.066, 0.034, { joints: JJ, role: 'mask', k: 0.03 }),
  ellipsoid([0, 0.912, -0.925], [0.04, 0.03, 0.045], { joints: JJ, role: 'mask', k: 0.025 }),
  ellipsoid([0, 0.958, -0.84], [0.034, 0.012, 0.085], { joints: JJ, role: 'tongue', k: 0.015 }),
);
for (const s of [-1, 1]) jaw.push(ellipsoid([s * 0.034, 0.94, -0.87], [0.03, 0.018, 0.075], { joints: JJ, role: 'lip', k: 0.015 }));

// --- sculpted fur tufts: round cones rooted in the surface, blended in softly ---
const baseField = makeField(body, { ground: true });
let tuftCount = 0;
function tuft(origin, dir, flow, { len, r1 = 0.04, r2 = 0.011, lift = 0.4, role = 'coat', k = 0.02 }) {
  const s = surfacePoint(baseField, origin, dir);
  if (!s) return;
  const n = baseField.grad(s);
  let f = sub(flow, mul(n, dot(flow, n)));
  f = length(f) < 1e-4 ? n : normalize(f);
  const d = normalize(add(mul(f, Math.cos(lift)), mul(n, Math.sin(lift))));
  const a = sub(s, mul(n, r1 * 0.75));
  // keep tuft tips inside the asset's bounding box (x +-0.35, y <= 1.25, z <= 0.95)
  const room = [0.33 - r2 - Math.abs(a[0]), 1.22 - r2 - a[1], 0.935 - r2 - a[2]];
  const reach = [Math.abs(d[0]), d[1], d[2]];
  for (let c = 0; c < 3; c++) if (reach[c] > 1e-6) len = Math.min(len, Math.max(0.02, room[c] / reach[c]));
  const joints = skinAt(baseField, s).map(([j, w]) => [JOINT_NAMES[j], w]);
  const m = add(a, mul(d, len * 0.55));
  let d2 = normalize(add(d, [0, -0.55, 0]));
  if (m[1] + d2[1] * len * 0.45 < 0.02) d2 = d; // never curl into the ground
  const t = add(m, mul(d2, len * 0.45));
  const rm = (r1 + r2) / 2 + 0.004;
  const lock = { a, t };
  body.push(cone(a, m, r1, rm, { joints, role, k: k * 0.7 }), cone(m, t, rm, r2, { joints, role, k: k * 0.5 }));
  body[body.length - 1].lock = lock;
  body[body.length - 2].lock = lock;
  tuftCount++;
}
const around = (axis, ang) => {
  // direction around a mostly-horizontal axis: 0 = up, +-PI/2 = sides
  const u = normalize(sub([0, 1, 0], mul(axis, axis[1])));
  const v = normalize(cross(axis, u));
  return add(mul(u, Math.cos(ang)), mul(v, Math.sin(ang)));
};

// Mane: thick layered ruff over the neck and shoulders, white on the throat
{
  const axis = normalize(sub(NECK_B, NECK_A));
  for (let r = 0; r < 6; r++) {
    const t = 0.08 + r * 0.14;
    const o = lerp3(NECK_A, NECK_B, t);
    for (let i = 0; i < 13; i++) {
      const ang = -Math.PI * 0.95 + (i + (r % 2) * 0.5) * ((Math.PI * 1.9) / 12.5);
      const dir = around(axis, ang);
      const throat = Math.abs(ang) > Math.PI * 0.62;
      const h = hash(r, i);
      const topness = Math.cos(ang); // 1 on top of the neck
      tuft(o, dir, add(mul(axis, -1), [0, throat ? -1.2 : -0.45, 0]), {
        len: (throat ? 0.12 : 0.13 - 0.03 * Math.max(0, topness)) + 0.03 * h, r1: 0.05, r2: 0.02,
        lift: throat ? 0.25 : 0.32 - 0.16 * Math.max(0, topness), role: throat ? 'bib' : 'coat',
      });
    }
  }
}
// Cheek ruff framing the face
for (const s of [-1, 1]) {
  const o = [s * 0.06, 0.985, -0.74];
  for (let i = 0; i < 10; i++) {
    const down = -0.35 + (i % 4) * 0.32;
    const back = -0.2 + Math.floor(i / 4) * 0.35;
    const dir = normalize([s * Math.cos(down), Math.sin(-down) * 0.8 - 0.1, back]);
    tuft(o, dir, [s * 0.8, -0.55, 0.5], { len: 0.1 + 0.03 * hash(s, i), r1: 0.034, r2: 0.01, lift: 0.35, role: 'mask', k: 0.016 });
  }
}
// Crown tufts between the ears
for (let i = 0; i < 5; i++) {
  tuft([0, 1.0, -0.7 + i * 0.03], [(i - 2) * 0.3, 1, 0.3], [0, 0, 1], { len: 0.055, r1: 0.028, r2: 0.012, lift: 0.25, role: 'head', k: 0.016 });
}
// Chest bib hanging down between the forelegs
for (let i = 0; i < 18; i++) {
  const az = -0.9 + (i % 6) * 0.36;
  const el = -0.15 - Math.floor(i / 6) * 0.38;
  const dir = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  tuft([0, 0.8, -0.32], dir, [0, -1, 0.25], { len: 0.1 + 0.03 * hash(i, 5), r1: 0.042, r2: 0.012, lift: 0.3, role: 'bib' });
}
// Back and shoulder hump: layered shaggy coat
for (let r = 0; r < 11; r++) {
  const z = -0.36 + r * 0.085;
  for (const a of [-0.7, -0.35, 0, 0.35, 0.7]) {
    tuft([0, 0.8, z], [Math.sin(a), Math.cos(a), 0], [0, -0.35, 1], { len: 0.1 + 0.03 * hash(r, a), r1: 0.05, r2: 0.021, lift: 0.2, role: 'dark', k: 0.025 });
  }
}
// Flanks, getting paler toward the belly
for (let r = 0; r < 10; r++) {
  const z = -0.36 + r * 0.09;
  for (const s of [-1, 1]) {
    for (const a of [1.0, 1.35, 1.7, 2.05]) {
      tuft([0, 0.8, z], [s * Math.sin(a), Math.cos(a), 0], [0, -0.7, 1], {
        len: 0.09 + 0.025 * hash(r, s, a), r1: 0.048, r2: 0.02, lift: 0.14, role: a > 1.9 ? 'belly' : 'coat', k: 0.025,
      });
    }
  }
}
// Belly fringe hanging down
for (let r = 0; r < 6; r++) {
  for (const x of [-0.09, 0, 0.09]) {
    tuft([x, 0.7, -0.3 + r * 0.06], [x * 3, -1, 0], [0, -0.8, 0.6], { len: 0.075, r1: 0.036, r2: 0.014, lift: 0.3, role: 'belly', k: 0.02 });
  }
}
// Shoulder and haunch fur, elbow and thigh feathering
for (const leg of Object.values(LEGS)) {
  const front = leg.end === 'F';
  const c = front ? [leg.sx * 0.17, 0.72, -0.32] : [leg.sx * 0.14, 0.72, 0.38];
  for (let i = 0; i < 7; i++) {
    const a = -0.6 + i * 0.32;
    tuft(c, [leg.sx * Math.cos(a), Math.sin(a) * 0.6, 0.35], [0, -1, 0.45], { len: 0.085, r1: 0.044, r2: 0.019, lift: 0.12, role: 'coat', k: 0.024 });
  }
  for (const t of front ? [0.65, 0.9, 1.1] : [0.25, 0.45, 0.65]) {
    const o = t <= 1 ? lerp3(leg.A, leg.B, t) : lerp3(leg.B, leg.C, t - 1);
    for (let i = 0; i < 3; i++) {
      tuft(o, [leg.sx * (0.15 + i * 0.4), -0.05, 1], [0, -1, 0.35], {
        len: 0.075 + 0.02 * hash(t, i), r1: 0.036, r2: 0.014, lift: 0.22, role: front ? 'leg' : 'coat', k: 0.018,
      });
    }
  }
}
// Bushy tail
for (let r = 0; r < 9; r++) {
  const t = 0.08 + r * 0.105;
  const seg = Math.min(3, Math.floor(t * 4));
  const ft = t * 4 - seg;
  const o = lerp3(TAIL_PTS[seg], TAIL_PTS[seg + 1], ft);
  const axis = normalize(sub(TAIL_PTS[seg + 1], TAIL_PTS[seg]));
  const u = normalize(cross(axis, [1, 0, 0]));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + r * 0.45;
    const dir = add(mul(u, Math.cos(a)), mul([1, 0, 0], Math.sin(a)));
    tuft(o, dir, axis, { len: 0.11 + 0.03 * hash(r, i), r1: 0.046, r2: 0.02, lift: 0.3, role: 'tail', k: 0.024 });
  }
}
// Fluffy ear insides
for (const s of [-1, 1]) {
  const side = s < 0 ? 'Ear_L' : 'Ear_R';
  for (const [dx, dy] of [[-0.012, 0], [0.012, 0.005], [0, 0.03]]) {
    const a = [s * 0.086 + dx, 1.108 + dy, -0.718];
    body.push(cone(a, add(a, [s * 0.02, 0.06, -0.012]), 0.016, 0.006, { joints: W(side, 1), role: 'inner', k: 0.008 }));
  }
}

// ============== Surface nets ==============
function polygonize(field, h) {
  const lo = field.lo.map((v) => v - 2 * h);
  const hi = field.hi.map((v) => v + 2 * h);
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1;
  const ny = Math.ceil((hi[1] - lo[1]) / h) + 1;
  const nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
  const V = new Float32Array(nx * ny * nz);
  const gi = (i, j, k) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    V[gi(i, j, k)] = field.value(lo[0] + i * h, lo[1] + j * h, lo[2] + k * h);
  }
  const cx = nx - 1, cy = ny - 1;
  const ci = (i, j, k) => i + cx * (j + cy * k);
  const cellVert = new Int32Array(cx * cy * (nz - 1)).fill(-1);
  const pos = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      val[c] = V[gi(i + corner[c][0], j + corner[c][1], k + corner[c][2])];
      if (val[c] < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of edges) {
      if ((val[a] < 0) === (val[b] < 0)) continue;
      const t = val[a] / (val[a] - val[b]);
      sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
      sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
      sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
      cnt++;
    }
    cellVert[ci(i, j, k)] = pos.length / 3;
    pos.push(lo[0] + (i + sx / cnt) * h, lo[1] + (j + sy / cnt) * h, lo[2] + (k + sz / cnt) * h);
  }
  const faces = [];
  const P = (v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
  // a-b-c-d run counter-clockwise around +axis, so they face +axis when the lower grid point is inside
  const quad = (a, b, c, d, inside) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const pa = P(a), pb = P(b), pc = P(c), pd = P(d);
    // split along the shorter diagonal
    const t = length(sub(pa, pc)) <= length(sub(pb, pd)) ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
    for (const [x, y, z] of t) faces.push(...(inside ? [x, y, z] : [x, z, y]));
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v0 = V[gi(i, j, k)];
    const in0 = v0 < 0;
    if (in0 !== (V[gi(i + 1, j, k)] < 0)) quad(cellVert[ci(i, j - 1, k - 1)], cellVert[ci(i, j, k - 1)], cellVert[ci(i, j, k)], cellVert[ci(i, j - 1, k)], in0);
    if (in0 !== (V[gi(i, j + 1, k)] < 0)) quad(cellVert[ci(i - 1, j, k - 1)], cellVert[ci(i - 1, j, k)], cellVert[ci(i, j, k)], cellVert[ci(i, j, k - 1)], in0);
    if (in0 !== (V[gi(i, j, k + 1)] < 0)) quad(cellVert[ci(i - 1, j - 1, k)], cellVert[ci(i, j - 1, k)], cellVert[ci(i, j, k)], cellVert[ci(i - 1, j, k)], in0);
  }
  return { pos: Float64Array.from(pos), faces: Int32Array.from(faces) };
}

// ============== QEM decimation (edge collapse, manifold + flip safe) ==============
function decimate(P, F, target) {
  const nv = P.length / 3;
  const nf = F.length / 3;
  const faces = Int32Array.from(F);
  const fAlive = new Uint8Array(nf).fill(1);
  const vAlive = new Uint8Array(nv).fill(1);
  const ver = new Uint32Array(nv);
  const vf = Array.from({ length: nv }, () => []);
  const Q = new Float64Array(nv * 10);
  const pt = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  for (let f = 0; f < nf; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    vf[a].push(f);
    vf[b].push(f);
    vf[c].push(f);
    const n = cross(sub(pt(b), pt(a)), sub(pt(c), pt(a)));
    const len = length(n);
    if (len < 1e-15) continue;
    const [x, y, z] = mul(n, 1 / len);
    const d = -dot([x, y, z], pt(a));
    const w = len * 0.5;
    const q = [x * x, x * y, x * z, x * d, y * y, y * z, y * d, z * z, z * d, d * d];
    for (const v of [a, b, c]) for (let i = 0; i < 10; i++) Q[v * 10 + i] += q[i] * w;
  }
  const qCost = (q, x, y, z) =>
    q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
  const optimal = (a, b) => {
    const q = new Float64Array(10);
    for (let i = 0; i < 10; i++) q[i] = Q[a * 10 + i] + Q[b * 10 + i];
    const pa = pt(a), pb = pt(b);
    const mid = lerp3(pa, pb, 0.5);
    const cands = [pa, pb, mid];
    const det = q[0] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * q[5] - q[4] * q[2]);
    if (Math.abs(det) > 1e-14) {
      const r = [-q[3], -q[6], -q[8]];
      const dx = r[0] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (r[1] * q[7] - q[5] * r[2]) + q[2] * (r[1] * q[5] - q[4] * r[2]);
      const dy = q[0] * (r[1] * q[7] - q[5] * r[2]) - r[0] * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * r[2] - r[1] * q[2]);
      const dz = q[0] * (q[4] * r[2] - r[1] * q[5]) - q[1] * (q[1] * r[2] - r[1] * q[2]) + r[0] * (q[1] * q[5] - q[4] * q[2]);
      const o = [dx / det, dy / det, dz / det];
      if (length(sub(o, mid)) < length(sub(pa, pb)) * 1.5) cands.unshift(o);
    }
    let best = null;
    for (const c of cands) {
      const cost = qCost(q, c[0], c[1], c[2]);
      if (!best || cost < best.cost - 1e-18) best = { cost, p: c };
    }
    return best;
  };
  // binary min-heap of edges
  const heap = [];
  const hpush = (e) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].cost <= e.cost) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = e;
  };
  const hpop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mc = last.cost;
        if (l < heap.length && heap[l].cost < mc) {
          m = l;
          mc = heap[l].cost;
        }
        if (r < heap.length && heap[r].cost < mc) m = r;
        if (m === i) break;
        heap[i] = heap[m];
        i = m;
      }
      heap[i] = last;
    }
    return top;
  };
  const pushEdge = (a, b) => {
    const o = optimal(a, b);
    hpush({ cost: o.cost, a, b, va: ver[a], vb: ver[b], p: o.p });
  };
  const seen = new Set();
  for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 3; e++) {
      const a = faces[f * 3 + e];
      const b = faces[f * 3 + ((e + 1) % 3)];
      const key = a < b ? a * nv + b : b * nv + a;
      if (seen.has(key)) continue;
      seen.add(key);
      pushEdge(a, b);
    }
  }
  const neighbors = (v) => {
    const s = new Set();
    for (const f of vf[v]) if (fAlive[f]) for (let e = 0; e < 3; e++) s.add(faces[f * 3 + e]);
    s.delete(v);
    return s;
  };
  const has = (f, v) => faces[f * 3] === v || faces[f * 3 + 1] === v || faces[f * 3 + 2] === v;
  const flips = (v, other, np) => {
    for (const f of vf[v]) {
      if (!fAlive[f] || has(f, other)) continue;
      const ids = [faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]];
      const before = ids.map(pt);
      const after = ids.map((id) => (id === v ? np : pt(id)));
      const n0 = cross(sub(before[1], before[0]), sub(before[2], before[0]));
      const n1 = cross(sub(after[1], after[0]), sub(after[2], after[0]));
      const l1 = length(n1);
      if (l1 < 1e-14) return true;
      if (dot(n0, n1) < 0.25 * length(n0) * l1) return true;
    }
    return false;
  };
  let alive = nf;
  while (alive > target && heap.length) {
    const e = hpop();
    const { a, b } = e;
    if (!vAlive[a] || !vAlive[b] || ver[a] !== e.va || ver[b] !== e.vb) continue;
    let shared = 0;
    for (const f of vf[a]) if (fAlive[f] && has(f, b)) shared++;
    if (shared !== 2) continue;
    const na = neighbors(a);
    const nb = neighbors(b);
    let common = 0;
    for (const v of na) if (nb.has(v)) common++;
    if (common !== 2) continue;
    if (flips(a, b, e.p) || flips(b, a, e.p)) continue;
    P[a * 3] = e.p[0];
    P[a * 3 + 1] = e.p[1];
    P[a * 3 + 2] = e.p[2];
    for (let i = 0; i < 10; i++) Q[a * 10 + i] += Q[b * 10 + i];
    for (const f of vf[b]) {
      if (!fAlive[f]) continue;
      if (has(f, a)) {
        fAlive[f] = 0;
        alive--;
      } else {
        for (let k = 0; k < 3; k++) if (faces[f * 3 + k] === b) faces[f * 3 + k] = a;
        vf[a].push(f);
      }
    }
    vAlive[b] = 0;
    vf[b] = [];
    vf[a] = vf[a].filter((f) => fAlive[f]);
    ver[a]++;
    for (const v of neighbors(a)) pushEdge(a, v);
  }
  const remap = new Int32Array(nv).fill(-1);
  const outP = [];
  const outF = [];
  for (let f = 0; f < nf; f++) {
    if (!fAlive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k];
      if (remap[v] < 0) {
        remap[v] = outP.length / 3;
        outP.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      }
      outF.push(remap[v]);
    }
  }
  return { pos: outP, faces: outF };
}

// Sculpt -> decimated mesh with SDF normals, skin weights and per-coat colours
// Open / inconsistently wound edges (debug: WOLF_DEBUG=1)
function meshStats(faces) {
  const edges = new Map();
  for (let f = 0; f < faces.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const k = `${faces[f + e]},${faces[f + ((e + 1) % 3)]}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let open = 0;
  let dup = 0;
  for (const [k, c] of edges) {
    const [a, b] = k.split(',');
    if (!edges.has(`${b},${a}`)) open++;
    if (c > 1) dup++;
  }
  return { tris: faces.length / 3, open, dup };
}

const headWeight = (skin) => skin.joints.reduce((s, j, i) => s + (HEAD_JOINTS.includes(JOINT_NAMES[j]) ? skin.weights[i] : 0), 0);

function buildSurface(prims, targetTris, ground) {
  const field = makeField(prims, { ground });
  const raw = polygonize(field, CELL);
  const dec = decimate(raw.pos, raw.faces, targetTris);
  if (process.env.WOLF_DEBUG) console.log('raw', meshStats(raw.faces), 'decimated', meshStats(dec.faces));
  const verts = [];
  for (let i = 0; i < dec.pos.length; i += 3) {
    let p = [dec.pos[i], dec.pos[i + 1], dec.pos[i + 2]];
    for (let it = 0; it < 2; it++) p = sub(p, mul(field.grad(p), field.value(...p))); // settle onto the surface
    if (ground) p[1] = Math.max(0, p[1]);
    const n = field.grad(p);
    const roles = influences(field, p, 0.014).map(({ prim, w }) => [prim.role, w, prim.lock]);
    const skin = normalizeWeights(skinAt(field, p));
    verts.push({ p: headScaled(p, headWeight(skin)), p0: p, n, roles, skin });
  }
  return { verts, faces: dec.faces, rawTris: raw.faces.length / 3 };
}

function normalizeWeights(list) {
  const top = [...list].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
  const sum = top.reduce((s, [, v]) => s + v, 0);
  const joints = [0, 0, 0, 0];
  const weights = [0, 0, 0, 0];
  top.forEach(([j, v], i) => {
    joints[i] = j;
    weights[i] = v / sum;
  });
  return { joints, weights };
}

// ============== Hand-built details: eyes, pupils, teeth, claws ==============
class Mesh {
  constructor() {
    this.verts = [];
    this.faces = [];
  }

  vertex(p, n, color, skin) {
    this.verts.push({ p, n, color, skin });
    return this.verts.length - 1;
  }
}
const rigidSkin = (name) => normalizeWeights([[J(name), 1]]);

// Oriented ellipsoid (lat-long)
function emitEllipsoid(mesh, c, axes, r, color, skin, segU = 10, segV = 6) {
  const base = mesh.verts.length;
  for (let v = 0; v <= segV; v++) {
    const th = (v / segV) * Math.PI;
    for (let u = 0; u < segU; u++) {
      const ph = (u / segU) * TAU;
      const l = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      const p = add(c, add(add(mul(axes[0], l[0] * r[0]), mul(axes[1], l[1] * r[1])), mul(axes[2], l[2] * r[2])));
      const n = normalize(add(add(mul(axes[0], l[0] / r[0]), mul(axes[1], l[1] / r[1])), mul(axes[2], l[2] / r[2])));
      mesh.vertex(p, n, color, skin);
    }
  }
  for (let v = 0; v < segV; v++) for (let u = 0; u < segU; u++) {
    const a = base + v * segU + u;
    const b = base + v * segU + ((u + 1) % segU);
    const c2 = a + segU;
    const d = b + segU;
    if (v > 0) mesh.faces.push(a, b, c2);
    if (v < segV - 1) mesh.faces.push(b, d, c2);
  }
}
// Curved cone: tooth or claw
function emitFang(mesh, base, tip, radius, bend, color, skin, ref = [0, 0, -1], sides = 6) {
  const axis = normalize(sub(tip, base));
  const u = normalize(sub(ref, mul(axis, dot(ref, axis))));
  const v = cross(axis, u);
  const mid = add(lerp3(base, tip, 0.5), mul(u, bend));
  const rings = [[base, radius], [mid, radius * 0.6]];
  const start = mesh.verts.length;
  for (const [c, r] of rings) {
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TAU;
      const dir = add(mul(u, Math.cos(a)), mul(v, Math.sin(a)));
      mesh.vertex(add(c, mul(dir, r)), normalize(add(dir, mul(axis, 0.3))), color, skin);
    }
  }
  const t = mesh.vertex(tip, axis, color, skin);
  for (let i = 0; i < sides; i++) {
    const i1 = (i + 1) % sides;
    mesh.faces.push(start + i, start + i1, start + sides + i1, start + i, start + sides + i1, start + sides + i);
    mesh.faces.push(start + sides + i, start + sides + i1, t);
  }
  // fix winding against the radial normals
  for (let f = mesh.faces.length - sides * 3 * 3; f < mesh.faces.length; f += 3) {
    const [a, b, c] = [mesh.faces[f], mesh.faces[f + 1], mesh.faces[f + 2]].map((i) => mesh.verts[i]);
    if (dot(cross(sub(b.p, a.p), sub(c.p, a.p)), add(add(a.n, b.n), c.n)) < 0) {
      const tmp = mesh.faces[f + 1];
      mesh.faces[f + 1] = mesh.faces[f + 2];
      mesh.faces[f + 2] = tmp;
    }
  }
}

function buildDetails() {
  const detail = new Mesh(); // goes into the body primitive
  const glow = new Mesh(); // emissive eyes primitive
  const head = rigidSkin('Head');
  const jawS = rigidSkin('Jaw');
  for (const s of [-1, 1]) {
    // almond eye with the outer corner swept up
    const c = [s * 0.068, 1.036, -0.846];
    const out = normalize([s * 0.42, 0.12, -0.9]);
    const width = normalize(cross([0, 1, 0], out));
    const tilt = qAxis(out, s * -0.3 * (s < 0 ? -1 : 1));
    const ax0 = qRot(tilt, width);
    const ax1 = qRot(tilt, [0, 1, 0]);
    emitEllipsoid(glow, c, [ax0, ax1, out], [0.025, 0.0125, 0.012], 'black', head, 12, 6);
    emitEllipsoid(detail, add(c, mul(out, 0.0095)), [ax0, ax1, out], [0.0055, 0.0095, 0.0035], 'pupil', head, 8, 4);
    // teeth
    emitFang(detail, [s * 0.045, 0.94, -0.93], [s * 0.047, 0.876, -0.94], 0.011, -0.004, 'fang', head);
    emitFang(detail, [s * 0.036, 0.935, -0.945], [s * 0.037, 0.978, -0.952], 0.009, 0.003, 'fang', jawS);
    for (const [x, z] of [[0.056, -0.86], [0.052, -0.89]]) emitFang(detail, [s * x, 0.945, z], [s * x, 0.912, z - 0.003], 0.0075, 0, 'fang', head);
    for (const [x, z] of [[0.042, -0.88], [0.038, -0.905]]) emitFang(detail, [s * x, 0.935, z], [s * x, 0.958, z - 0.002], 0.0065, 0, 'fang', jawS);
  }
  for (const x of [-0.024, -0.008, 0.008, 0.024]) {
    emitFang(detail, [x, 0.942, -0.975 + Math.abs(x) * 0.4], [x, 0.912, -0.98 + Math.abs(x) * 0.4], 0.0065, 0, 'fang', head);
    emitFang(detail, [x * 0.9, 0.932, -0.952 + Math.abs(x) * 0.4], [x * 0.9, 0.952, -0.956 + Math.abs(x) * 0.4], 0.0055, 0, 'fang', jawS);
  }
  // claws
  for (const leg of Object.values(LEGS)) {
    const k = leg.end === 'F' ? 1.12 : 1.02;
    const skin = rigidSkin(leg.foot);
    for (const [dx, dz] of TOES) {
      const tx = leg.P[0] + dx * k;
      const tz = leg.P[2] + dz * k;
      emitFang(detail, [tx, 0.036, tz - 0.03], [tx + dx * 0.3, 0, tz - 0.098], 0.011, 0.013, 'claw', skin, [0, 1, 0], 6);
    }
  }
  for (const v of [...detail.verts, ...glow.verts]) v.p = headScaled(v.p, headWeight(v.skin));
  return { detail, glow };
}

// ============== Build geometry once ==============
const t0 = Date.now();
const bodySurf = buildSurface(body, BODY_TRIS, true);
const jawSurf = buildSurface(jaw, JAW_TRIS, false);
const { detail, glow } = buildDetails();
const buildMs = Date.now() - t0;

// ============== Sockets ==============
const SOCKETS = [
  { name: 'socket_mouth', parent: 'Jaw', pos: headScaled([0, 0.905, -0.94]) },
  { name: 'socket_eyes', parent: 'Head', pos: headScaled([0, 1.04, -0.85]) },
  { name: 'socket_back', parent: 'Chest', pos: [0, 1.04, -0.28] },
  { name: 'socket_nose', parent: 'Head', pos: headScaled([0, 0.998, -1.026]) },
];

// ============== Animation ==============
const ZERO = [0, 0, 0];
const bumpIn = (t, t0, t1) => (t <= t0 || t >= t1 ? 0 : Math.sin((Math.PI * (t - t0)) / (t1 - t0)) ** 2);
function keys(t, ks) {
  if (t <= ks[0][0]) return ks[0][1];
  for (let i = 0; i < ks.length - 1; i++) {
    const [ta, va] = ks[i];
    const [tb, vb] = ks[i + 1];
    if (t <= tb) return va + (vb - va) * smooth((t - ta) / (tb - ta));
  }
  return ks[ks.length - 1][1];
}
const STILL = { BL: null, BR: null, FL: null, FR: null };

// Paw path for in-place locomotion; phase 0 = touchdown with the paw forward
function gaitPaw(phase, stance, len, lift, aLift, aSwing) {
  const p = ((phase % 1) + 1) % 1;
  if (p < stance) {
    const s = p / stance;
    return { off: [0, 0, -len / 2 + len * s], a: s > 0.75 ? (aLift * (s - 0.75)) / 0.25 : 0 };
  }
  const s = (p - stance) / (1 - stance);
  const e = 0.5 - 0.5 * Math.cos(Math.PI * s);
  return { off: [0, lift * Math.sin(Math.PI * s), len / 2 - len * e], a: (1 - s) * aLift + aSwing * Math.sin(Math.PI * s) };
}
function gait(p, phases, stance, len, lift, front, back) {
  const out = {};
  for (const [id, off] of Object.entries(phases)) {
    const [aLift, aSwing] = id[0] === 'F' ? front : back;
    out[id] = gaitPaw(p - off, stance, len, lift, aLift, aSwing);
  }
  return out;
}

const CLIPS = [
  {
    name: 'Idle', dur: 2.0,
    pose(t) {
      const w = (TAU * t) / 2;
      const flick = bumpIn(t, 1.15, 1.35);
      const twitch = bumpIn(t, 0.3, 0.45);
      return {
        hips: [0, 0.006 * Math.sin(w), 0],
        rot: {
          Spine: [0.01 * Math.sin(w), 0, 0],
          Chest: [0.02 * Math.sin(w), 0, 0],
          Neck: [0.03 * Math.sin(w + 0.6), 0.05 * Math.sin(w), 0],
          Head: [-0.02 * Math.sin(w + 0.6), 0.04 * Math.sin(w - 0.5), 0],
          Jaw: [-0.03 - 0.025 * (0.5 + 0.5 * Math.sin(w)), 0, 0],
          Ear_L: [0.1 * twitch, 0, 0.25 * twitch],
          Ear_R: [0.35 * flick, 0, -0.35 * flick],
          Tail_1: [0, 0.1 * Math.sin(w), 0],
          Tail_2: [0, 0.14 * Math.sin(w - 0.7), 0],
          Tail_3: [0, 0.18 * Math.sin(w - 1.4), 0],
        },
        paws: STILL,
      };
    },
  },
  {
    name: 'Sniff', dur: 1.6,
    pose(t) {
      const w = (TAU * t) / 1.6;
      const stepA = keys(t, [[0, 0], [0.15, 0], [0.4, 1], [0.95, 1], [1.2, 0], [1.6, 0]]);
      const liftA = bumpIn(t, 0.15, 0.4) + bumpIn(t, 0.95, 1.2);
      const stepB = keys(t, [[0, 0], [0.55, 0], [0.8, 1], [1.3, 1], [1.55, 0], [1.6, 0]]);
      const liftB = bumpIn(t, 0.55, 0.8) + bumpIn(t, 1.3, 1.55);
      return {
        hips: [0, -0.05, 0.02],
        rot: {
          Hips: [-0.04, 0, 0],
          Spine: [-0.03, 0.03 * Math.sin(w), 0],
          Chest: [-0.1, 0.05 * Math.sin(w), 0],
          Neck: [-0.85, 0.3 * Math.sin(w), 0],
          Head: [-0.42 + 0.04 * Math.sin(4 * w), 0.22 * Math.sin(w - 0.4), 0.06 * Math.sin(w)],
          Jaw: [-0.02 - 0.02 * Math.max(0, Math.sin(4 * w)), 0, 0],
          Ear_L: [-0.18, 0, 0.08],
          Ear_R: [-0.18, 0, -0.08],
          Tail_1: [0.05, 0.08 * Math.sin(w), 0],
          Tail_2: [0.03, 0.1 * Math.sin(w - 0.7), 0],
          Tail_3: [0, 0.12 * Math.sin(w - 1.4), 0],
        },
        paws: {
          FL: { off: [0, 0.035 * liftA, -0.07 * stepA], a: 0.4 * liftA },
          BR: { off: [0, 0.03 * liftB, -0.05 * stepB], a: 0.3 * liftB },
          FR: null, BL: null,
        },
      };
    },
  },
  {
    name: 'Alert', dur: 1.0,
    pose(t) {
      const w = TAU * t;
      const g = Math.sin(4 * w); // growl tremble
      return {
        hips: [0, -0.07 + 0.008 * Math.sin(2 * w), 0.02],
        rot: {
          Hips: [-0.05, 0, 0],
          Spine: [0.02, 0, 0],
          Chest: [-0.07 + 0.006 * Math.sin(2 * w), 0, 0],
          Neck: [-0.64 + 0.02 * Math.sin(2 * w), 0.06, 0],
          Head: [0.8, -0.04, 0],
          Jaw: [-0.17 - 0.02 * (0.5 + 0.5 * g), 0, 0],
          Ear_L: [-0.1, 0, -0.06],
          Ear_R: [-0.1, 0, 0.06],
          Tail_1: [0.12, 0, 0],
          Tail_2: [0.1 + 0.03 * g, 0, 0],
          Tail_3: [0.05, 0, 0],
        },
        paws: { FL: { off: [0, 0, -0.17], a: 0 }, FR: { off: [0, 0, 0.06], a: 0.15 }, BL: { off: [0, 0, 0.05], a: 0.1 }, BR: { off: [0, 0, -0.06], a: 0 } },
      };
    },
  },
  {
    name: 'Walk', dur: 1.0,
    pose(t) {
      const w = TAU * t;
      return {
        hips: [0.012 * Math.sin(w), -0.09 + 0.012 * Math.cos(2 * w), 0],
        rot: {
          Hips: [-0.03, 0.035 * Math.sin(w), 0.03 * Math.sin(w + 0.5)],
          Spine: [0, -0.03 * Math.sin(w), 0],
          Chest: [-0.03, -0.03 * Math.sin(w), -0.03 * Math.sin(w + 0.5)],
          Neck: [-0.5 + 0.03 * Math.cos(2 * w), 0.05 * Math.sin(w), 0],
          Head: [0.42 - 0.03 * Math.cos(2 * w), -0.04 * Math.sin(w), 0],
          Jaw: [-0.04, 0, 0],
          Ear_L: [0.1, 0, 0],
          Ear_R: [0.1, 0, 0],
          Tail_1: [0.06, 0.1 * Math.sin(w), 0],
          Tail_2: [0.05, 0.13 * Math.sin(w - 0.8), 0],
          Tail_3: [0.04, 0.16 * Math.sin(w - 1.6), 0],
        },
        // stride 1.2 m per cycle: planted paws slide back at 1.2 m/s
        paws: gait(t, { BL: 0, FL: 0.25, BR: 0.5, FR: 0.75 }, 0.55, 1.2 * 0.55, 0.1, [0.5, 1.1], [0.35, 0.6]),
      };
    },
  },
  {
    name: 'Run', dur: 0.6,
    pose(t) {
      const p = t / 0.6;
      const w = TAU * p;
      const flex = Math.cos(TAU * (p - 0.05)); // +1 gathered, -1 stretched
      return {
        hips: [0, -0.07 + 0.045 * Math.cos(TAU * (p - 0.92)), 0],
        rot: {
          Hips: [0.07 * flex, 0, 0],
          Spine: [-0.12 * flex, 0, 0],
          Chest: [-0.08 * flex, 0, 0],
          Neck: [-0.25 + 0.1 * flex, 0, 0],
          Head: [0.2 - 0.06 * flex, 0, 0],
          Jaw: [-0.12, 0, 0],
          Ear_L: [0.6, 0, 0.2],
          Ear_R: [0.6, 0, -0.2],
          Tail_1: [-0.55 + 0.1 * Math.sin(w), 0, 0],
          Tail_2: [-0.15 + 0.12 * Math.sin(w - 0.8), 0, 0],
          Tail_3: [-0.1 + 0.15 * Math.sin(w - 1.6), 0, 0],
        },
        // stride 2.4 m per 0.6 s cycle -> 4 m/s
        paws: gait(p, { BL: 0, BR: 0.1, FL: 0.5, FR: 0.6 }, 0.3, 4 * 0.6 * 0.3, 0.17, [0.6, 1.4], [0.4, 0.8]),
      };
    },
  },
  {
    name: 'Howl', dur: 3.0,
    pose(t) {
      const k = keys(t, [[0, 0], [0.75, 1], [2.25, 1], [3.0, 0]]);
      const jawK = keys(t, [[0, 0], [0.45, 0], [0.8, 1], [2.15, 1], [2.55, 0], [3.0, 0]]);
      const tremble = Math.sin(TAU * t * 6) * bumpIn(t, 0.75, 2.25);
      return {
        hips: [0, -0.06 * k, 0.03 * k],
        rot: {
          Hips: [0.1 * k, 0, 0],
          Spine: [0.04 * k, 0, 0],
          Chest: [0.06 * k, 0, 0],
          Neck: [0.55 * k, 0, 0],
          Head: [0.55 * k + 0.02 * tremble, 0, 0],
          Jaw: [-0.68 * jawK - 0.02 * tremble * jawK, 0, 0], // ~39 deg
          Ear_L: [0.35 * k, 0, 0.15 * k],
          Ear_R: [0.35 * k, 0, -0.15 * k],
          Tail_1: [0.15 * k, 0, 0],
          Tail_2: [0.05 * k, 0, 0],
        },
        paws: STILL,
      };
    },
  },
  {
    name: 'Attack', dur: 0.7,
    pose(t) {
      const crouch = keys(t, [[0, 0], [0.2, 1], [0.27, 0], [0.7, 0]]);
      const lunge = keys(t, [[0, 0], [0.2, 0], [0.33, 1], [0.45, 0.85], [0.7, 0]]);
      const jawK = keys(t, [[0, 0], [0.18, 1], [0.27, 1], [0.3, 0], [0.7, 0]]); // bite closes at 0.30 s
      const step = keys(t, [[0, 0], [0.2, 0], [0.34, 1], [0.48, 1], [0.66, 0], [0.7, 0]]);
      const stepLift = bumpIn(t, 0.2, 0.34) + bumpIn(t, 0.48, 0.66);
      const ears = Math.min(1, crouch + lunge);
      return {
        hips: [0, -0.11 * crouch + 0.02 * lunge, 0.06 * crouch - 0.26 * lunge],
        rot: {
          Hips: [-0.05 * crouch, 0, 0],
          Spine: [0.03 * crouch - 0.03 * lunge, 0, 0],
          Chest: [-0.06 * crouch, 0, 0],
          Neck: [-0.28 * crouch + 0.05 * lunge, 0, 0],
          Head: [0.12 * crouch - 0.12 * lunge, 0, 0],
          Jaw: [-0.7 * jawK, 0, 0],
          Ear_L: [0.55 * ears, 0, 0.3 * ears],
          Ear_R: [0.55 * ears, 0, -0.3 * ears],
          Tail_1: [-0.25 * lunge, 0, 0],
          Tail_2: [0.1 * crouch, 0, 0],
        },
        paws: {
          FL: { off: [0, 0.08 * stepLift, -0.24 * step], a: 0.5 * stepLift },
          FR: { off: [0, 0.08 * stepLift, -0.2 * step], a: 0.5 * stepLift },
          BL: { off: [0, 0, -0.06 * lunge], a: 0.25 * lunge },
          BR: { off: [0, 0, -0.06 * lunge], a: 0.25 * lunge },
        },
      };
    },
  },
  {
    name: 'Hit', dur: 0.4,
    pose(t) {
      const h = keys(t, [[0, 0], [0.08, 1], [0.4, 0]]);
      return {
        hips: [0.05 * h, -0.03 * h, 0.02 * h],
        rot: {
          Hips: [0, 0, -0.06 * h],
          Spine: [0, 0.16 * h, 0],
          Chest: [0, 0.12 * h, -0.05 * h],
          Neck: [0.15 * h, -0.35 * h, 0],
          Head: [0.1 * h, -0.2 * h, 0.15 * h],
          Jaw: [-0.3 * h, 0, 0],
          Ear_L: [0.6 * h, 0, 0.3 * h],
          Ear_R: [0.6 * h, 0, -0.3 * h],
          Tail_1: [0.2 * h, 0.2 * h, 0],
        },
        paws: STILL,
      };
    },
  },
  {
    name: 'Death', dur: 1.2,
    pose(t) {
      const stag = keys(t, [[0, 0], [0.22, 1], [1.2, 1]]);
      const fall = keys(t, [[0, 0], [0.18, 0], [0.72, 1], [1.2, 1]]);
      const tw = t > 0.72 && t < 1.08 ? Math.sin(TAU * (t - 0.72) * 7) * (1 - (t - 0.72) / 0.36) : 0;
      const legs = {};
      for (const s of ['L', 'R']) {
        const top = s === 'L' ? 1 : 0;
        legs[`UpperLeg_F${s}`] = [0.35 * fall, 0, 0.25 * top * fall];
        legs[`LowerLeg_F${s}`] = [-0.25 * fall + 0.12 * tw * top, 0, 0];
        legs[`Foot_F${s}`] = [0.45 * fall, 0, 0];
        legs[`UpperLeg_B${s}`] = [-0.3 * fall, 0, 0.2 * top * fall];
        legs[`LowerLeg_B${s}`] = [0.2 * fall + 0.1 * tw, 0, 0];
        legs[`Foot_B${s}`] = [0.35 * fall - 0.08 * tw, 0, 0];
      }
      return {
        hips: [0.03 * stag * (1 - fall) + 0.33 * fall, -0.69 * fall, 0],
        rot: {
          Hips: [0, 0, -1.48 * fall],
          Spine: [0, 0.05 * fall, 0],
          Chest: [-0.05 * stag * (1 - fall), 0, 0],
          Neck: [-0.3 * stag * (1 - fall) - 0.1 * fall, 0, 0.1 * fall],
          Head: [-0.15 * fall, 0, -0.15 * fall],
          Jaw: [-0.25 * fall, 0, 0],
          Ear_L: [0.4 * fall, 0, 0],
          Ear_R: [0.4 * fall, 0, 0],
          Tail_1: [0.2 * fall, 0, 0],
          ...legs,
        },
        paws: null, // limp legs (FK)
      };
    },
  },
];

function forward(pose, names) {
  const world = {};
  const get = (name) => {
    if (world[name]) return world[name];
    const parent = PARENT[name];
    const q = qEuler(pose.rot[name] || ZERO);
    let t = LOCAL_T[name];
    if (name === 'Hips') t = add(t, pose.hips || ZERO);
    if (!parent) return (world[name] = { p: t, q });
    const pw = get(parent);
    return (world[name] = { p: add(pw.p, qRot(pw.q, t)), q: qMul(pw.q, q) });
  };
  for (const n of names) get(n);
  return world;
}

// Planar 2-bone IK in the leg's parent frame; the paw keeps world pitch `a`
function solveLeg(leg, parentWorld, paw) {
  const off = paw ? paw.off : ZERO;
  const a = paw ? paw.a : 0;
  const footVec = qRot(qAxis([1, 0, 0], a), sub(leg.C, leg.P));
  const targetW = add(add(leg.P, off), footVec);
  const Cl = qRot(qConj(parentWorld.q), sub(targetW, parentWorld.p));
  const A = LOCAL_T[leg.upper];
  const B0 = add(A, LOCAL_T[leg.lower]);
  const C0 = add(B0, LOCAL_T[leg.foot]);
  const v2 = (p) => [p[2], p[1]];
  const ang = (v) => Math.atan2(v[1], v[0]);
  const d2 = (p, q) => [p[0] - q[0], p[1] - q[1]];
  const len2 = (v) => Math.hypot(v[0], v[1]);
  const cr2 = (u, v) => u[0] * v[1] - u[1] * v[0];
  const a2 = v2(A);
  const b0 = v2(B0);
  const c0 = v2(C0);
  const l1 = len2(d2(b0, a2));
  const l2 = len2(d2(c0, b0));
  const toC = d2(v2(Cl), a2);
  const dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, len2(toC)));
  const base = ang(toC);
  const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const bend = Math.sign(cr2(d2(c0, a2), d2(b0, a2))) || 1;
  const angB = base + bend * Math.acos(Math.max(-1, Math.min(1, cosA)));
  const b = [a2[0] + l1 * Math.cos(angB), a2[1] + l1 * Math.sin(angB)];
  const c = [a2[0] + dist * Math.cos(base), a2[1] + dist * Math.sin(base)];
  // rotation about X turns the (z, y) plane clockwise, hence the minus signs
  const th1 = -(ang(d2(b, a2)) - ang(d2(b0, a2)));
  const th12 = -(ang(d2(c, b)) - ang(d2(c0, b0)));
  const th3 = a - qPitch(parentWorld.q) - th12;
  return { [leg.upper]: [th1, 0, 0], [leg.lower]: [th12 - th1, 0, 0], [leg.foot]: [th3, 0, 0] };
}

function sampleClip(clip) {
  const frames = Math.round(clip.dur * FPS) + 1;
  const times = [];
  const rot = Object.fromEntries(JOINT_NAMES.filter((n) => n !== 'Root').map((n) => [n, []]));
  const hips = [];
  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.dur, f / FPS);
    times.push(t);
    const pose = clip.pose(t);
    pose.rot = { ...pose.rot };
    if (pose.paws) {
      const world = forward(pose, ['Hips', 'Chest']);
      for (const leg of Object.values(LEGS)) Object.assign(pose.rot, solveLeg(leg, world[leg.parent], pose.paws[leg.id]));
    }
    for (const name of Object.keys(rot)) {
      let q = qEuler(pose.rot[name] || ZERO);
      const prev = rot[name][rot[name].length - 1];
      if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = q.map((v) => -v);
      rot[name].push(q);
    }
    hips.push(add(LOCAL_T.Hips, pose.hips || ZERO));
  }
  return { name: clip.name, times, rot, hips };
}
const SAMPLED = CLIPS.map(sampleClip);

// ============== GLB writer ==============
const MATERIALS = [
  { name: 'wolf_main', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.85 } },
  {
    name: 'wolf_eyes',
    pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 1], metallicFactor: 0, roughnessFactor: 0.4 },
    emissiveFactor: hex('#ffb020'),
    extensions: { KHR_materials_emissive_strength: { emissiveStrength: 4 } },
  },
];

const colorOfRoles = (P, roles, p, n) => {
  let sum = 0;
  let c = [0, 0, 0];
  for (const [role, w, lock] of roles) {
    let rc = ROLE_COLOR[role](P, p, n);
    if (lock) {
      const ax = sub(lock.t, lock.a);
      const u = clamp01(dot(sub(p, lock.a), ax) / dot(ax, ax));
      const light = role === 'bib' || role === 'mask' || role === 'belly' ? P.cream : P.light;
      rc = mixC(rc, light, 0.38 * u * u);
    }
    c = add(c, mul(rc, w));
    sum += w;
  }
  return mul(c, 1 / sum);
};

// Flatten surfaces + details into the two glTF primitives for one coat
function assemble(P) {
  const bodyV = [];
  const bodyF = [];
  const pushSurf = (surf, mouthRoof) => {
    const base = bodyV.length;
    for (const v of surf.verts) {
      let color = colorOfRoles(P, v.roles, v.p0, v.n);
      if (mouthRoof && v.p[2] < -0.8 && v.p[1] < 0.96 && v.n[1] < -0.55 && Math.abs(v.p[0]) < 0.06) color = P.gum;
      if (!mouthRoof && v.n[1] > 0.6 && v.p[2] < -0.72 && Math.abs(v.p[0]) < 0.055) color = mixC(P.gum, color, v.roles.some(([r]) => r === 'tongue') ? 0.6 : 0);
      bodyV.push({ p: v.p, n: v.n, c: color, skin: v.skin });
    }
    for (const f of surf.faces) bodyF.push(base + f);
  };
  pushSurf(bodySurf, true);
  pushSurf(jawSurf, false);
  const base = bodyV.length;
  for (const v of detail.verts) bodyV.push({ p: v.p, n: v.n, c: P[v.color], skin: v.skin });
  for (const f of detail.faces) bodyF.push(base + f);
  const eyeV = glow.verts.map((v) => ({ p: v.p, n: v.n, c: P.black, skin: v.skin }));
  return [{ verts: bodyV, faces: bodyF, material: 0 }, { verts: eyeV, faces: glow.faces, material: 1 }];
}

function writeGlb(prims) {
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [];
  const accessors = [];
  const pushView = (typed, target) => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    const view = { buffer: 0, byteOffset: byteLength, byteLength: typed.byteLength };
    if (target) view.target = target;
    bufferViews.push(view);
    chunks.push(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength));
    byteLength += typed.byteLength;
    return bufferViews.length - 1;
  };
  const accessor = (typed, componentType, type, count, extra = {}, target) => {
    accessors.push({ bufferView: pushView(typed, target), componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const minMax = (arr) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < arr.length; i++) {
      min[i % 3] = Math.min(min[i % 3], arr[i]);
      max[i % 3] = Math.max(max[i % 3], arr[i]);
    }
    return { min, max };
  };

  const gltfPrims = prims.map(({ verts, faces, material }) => {
    const pos = new Float32Array(verts.flatMap((v) => v.p));
    const attributes = {
      POSITION: accessor(pos, 5126, 'VEC3', verts.length, minMax(pos), 34962),
      NORMAL: accessor(new Float32Array(verts.flatMap((v) => v.n)), 5126, 'VEC3', verts.length, {}, 34962),
      COLOR_0: accessor(new Float32Array(verts.flatMap((v) => v.c)), 5126, 'VEC3', verts.length, {}, 34962),
      JOINTS_0: accessor(new Uint8Array(verts.flatMap((v) => v.skin.joints)), 5121, 'VEC4', verts.length, {}, 34962),
      WEIGHTS_0: accessor(new Float32Array(verts.flatMap((v) => v.skin.weights)), 5126, 'VEC4', verts.length, {}, 34962),
    };
    const big = verts.length > 65535;
    const idx = big ? new Uint32Array(faces) : new Uint16Array(faces);
    return { attributes, indices: accessor(idx, big ? 5125 : 5123, 'SCALAR', faces.length, {}, 34963), material, mode: 4 };
  });

  const nodes = [{ name: 'feral_wolf', children: [1] }, { name: 'wolf_body', mesh: 0, skin: 0 }];
  const jointNode = {};
  for (const name of JOINT_NAMES) {
    jointNode[name] = nodes.length;
    const node = { name };
    if (length(LOCAL_T[name]) > 0) node.translation = LOCAL_T[name];
    nodes.push(node);
  }
  for (const name of JOINT_NAMES) {
    const parent = PARENT[name];
    if (parent) (nodes[jointNode[parent]].children ||= []).push(jointNode[name]);
  }
  nodes[0].children.push(jointNode.Root);
  for (const s of SOCKETS) {
    (nodes[jointNode[s.parent]].children ||= []).push(nodes.length);
    nodes.push({ name: s.name, translation: sub(s.pos, REST[s.parent]) });
  }

  const ibm = new Float32Array(JOINT_NAMES.length * 16);
  JOINT_NAMES.forEach((name, i) => {
    const p = REST[name];
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], i * 16);
  });
  const skin = {
    name: 'feral_wolf_skin',
    inverseBindMatrices: accessor(ibm, 5126, 'MAT4', JOINT_NAMES.length),
    joints: JOINT_NAMES.map((n) => jointNode[n]),
    skeleton: jointNode.Root,
  };

  const animations = SAMPLED.map((s) => {
    const times = new Float32Array(s.times);
    const input = accessor(times, 5126, 'SCALAR', times.length, { min: [0], max: [times[times.length - 1]] });
    const samplers = [];
    const channels = [];
    for (const [name, qs] of Object.entries(s.rot)) {
      samplers.push({ input, output: accessor(new Float32Array(qs.flat()), 5126, 'VEC4', qs.length), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: jointNode[name], path: 'rotation' } });
    }
    samplers.push({ input, output: accessor(new Float32Array(s.hips.flat()), 5126, 'VEC3', s.hips.length), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: jointNode.Hips, path: 'translation' } });
    return { name: s.name, samplers, channels };
  });

  const json = {
    asset: { version: '2.0', generator: 'stickman-strike generate-wolf-glb.mjs' },
    extensionsUsed: ['KHR_materials_emissive_strength'],
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes,
    meshes: [{ name: 'wolf_body', primitives: gltfPrims }],
    skins: [skin],
    materials: MATERIALS,
    animations,
    accessors,
    bufferViews,
    buffers: [{ byteLength: 0 }],
  };
  const binPad = (4 - (byteLength % 4)) % 4;
  if (binPad) chunks.push(new Uint8Array(binPad));
  const bin = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  json.buffers[0].byteLength = bin.length;
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const chunkHeader = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([header, chunkHeader(jsonBuf.length, 0x4e4f534a), jsonBuf, chunkHeader(bin.length, 0x004e4942), bin]);
}

// ============== Write all coats ==============
mkdirSync(OUT_DIR, { recursive: true });
const FILES = [['charcoal', 'feral_wolf_rigged.glb'], ['red', 'feral_wolf_red_rigged.glb'], ['tan', 'feral_wolf_tan_rigged.glb'], ['black', 'feral_wolf_black_rigged.glb'], ['white', 'feral_wolf_white_rigged.glb']];
for (const [coat, file] of FILES) {
  const prims = assemble(coatPalette(coat));
  const glb = writeGlb(prims);
  writeFileSync(resolve(OUT_DIR, file), glb);
  const tris = prims.reduce((s, p) => s + p.faces.length / 3, 0);
  console.log(`${coat.padEnd(8)} ${tris} tris, ${(glb.length / 1024).toFixed(1)} KB -> ${file}`);
}
console.log(`sculpt: ${body.length + jaw.length} primitives (${tuftCount} fur tufts), surface nets ${bodySurf.rawTris + jawSurf.rawTris} tris -> decimated, built in ${(buildMs / 1000).toFixed(1)} s`);
