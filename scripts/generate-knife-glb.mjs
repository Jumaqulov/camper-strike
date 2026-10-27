// Low-poly stylized combat knife -> public/models/weapons/knife.glb
// Pure Node (no deps). Run: node scripts/generate-knife-glb.mjs
//
// Axes: Y up, blade tip at -Z, pommel at +Z, cutting edge at -Y.
// Origin = grip centre. All parts are authored in knife space, so every node
// keeps an identity transform (the empties only carry a translation).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/models/weapons/knife.glb');

// ============== Vektor yordamchilari ==============
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (e0, e1, v) => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ============== Mesh builder ==============
class MeshBuilder {
  constructor(name, material) {
    this.name = name;
    this.material = material;
    this.positions = [];
    this.normals = [];
    this.indices = [];
    this.lookup = new Map();
  }

  vertex(p, n) {
    const key = [...p, ...n].map((v) => v.toFixed(7)).join(',');
    let i = this.lookup.get(key);
    if (i === undefined) {
      i = this.positions.length;
      this.positions.push(p);
      this.normals.push(n);
      this.lookup.set(key, i);
    }
    return i;
  }

  // Flat-shaded triangle; winding is flipped when needed so the face normal agrees with `outward`.
  flatTri(a, b, c, outward) {
    let n = cross(sub(b, a), sub(c, a));
    if (dot(n, outward) < 0) {
      [b, c] = [c, b];
      n = [-n[0], -n[1], -n[2]];
    }
    n = normalize(n);
    this.indices.push(this.vertex(a, n), this.vertex(b, n), this.vertex(c, n));
  }

  flatQuad(a, b, c, d, outward) {
    this.flatTri(a, b, c, outward);
    this.flatTri(a, c, d, outward);
  }

  // Convex polygon, fanned from the first point.
  flatFan(pts, outward) {
    for (let i = 1; i < pts.length - 1; i++) this.flatTri(pts[0], pts[i], pts[i + 1], outward);
  }

  // Smooth triangle from [position, normal] pairs; outward hint = summed vertex normals.
  smoothTri(a, b, c) {
    const hint = add(add(a[1], b[1]), c[1]);
    if (dot(cross(sub(b[0], a[0]), sub(c[0], a[0])), hint) < 0) [b, c] = [c, b];
    this.indices.push(this.vertex(...a), this.vertex(...b), this.vertex(...c));
  }

  get triangleCount() {
    return this.indices.length / 3;
  }
}

// Smooth normals for a grid of closed rings (ring r, segment s), oriented away from the Z axis
// (or along +Z for degenerate apex rings).
function gridNormals(rings) {
  const acc = rings.map((ring) => ring.map(() => [0, 0, 0]));
  const segs = rings[0].length;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      const p00 = rings[r][s], p01 = rings[r][s1], p10 = rings[r + 1][s], p11 = rings[r + 1][s1];
      let n = cross(sub(p11, p00), sub(p01, p10));
      const c = [(p00[0] + p11[0]) / 2, (p00[1] + p11[1]) / 2, 0];
      if (dot(n, c) < 0) n = [-n[0], -n[1], -n[2]];
      for (const [rr, ss] of [[r, s], [r, s1], [r + 1, s], [r + 1, s1]]) acc[rr][ss] = add(acc[rr][ss], n);
    }
  }
  return acc.map((ring) => ring.map(normalize));
}

function emitBand(mesh, ringA, ringB, nA, nB) {
  const segs = ringA.length;
  for (let s = 0; s < segs; s++) {
    const s1 = (s + 1) % segs;
    const a0 = [ringA[s], nA[s]], a1 = [ringA[s1], nA[s1]];
    const b0 = [ringB[s], nB[s]], b1 = [ringB[s1], nB[s1]];
    mesh.smoothTri(a0, a1, b1);
    mesh.smoothTri(a0, b1, b0);
  }
}

// ============== Dimensions ==============
const BLADE_BASE_Z = -0.06; // visible blade starts at the guard face
const BLADE_LEN = 0.19;
const TIP_Z = BLADE_BASE_Z - BLADE_LEN; // -0.25
const TIP_Y = 0.002;

const GUARD_FRONT_Z = -0.06;
const GUARD_BACK_Z = -0.048;
const GUARD_CY = -0.002;

const HANDLE_START_Z = -0.048;
const HANDLE_LEN = 0.108;
const POMMEL_START_Z = HANDLE_START_Z + HANDLE_LEN; // 0.060

// ============== Blade profile (u: 0 at guard face, 1 at tip) ==============
const bladeZ = (u) => BLADE_BASE_Z - BLADE_LEN * u;

function spineY(u) {
  if (u <= 0.58) return 0.015;
  const s = (u - 0.58) / 0.42;
  return 0.015 - (0.015 - TIP_Y) * Math.pow(s, 1.9); // drop-point curve
}

function edgeY(u) {
  const base = -0.019;
  const bellyStart = -0.016;
  if (u <= 0.5) return base + (bellyStart - base) * Math.max(u, 0) / 0.5;
  const s = (u - 0.5) / 0.5;
  return bellyStart + (TIP_Y - bellyStart) * Math.pow(s, 2.3); // belly sweeping up to the tip
}

const halfThickness = (u) => 0.002 - 0.0015 * Math.pow(clamp01((u - 0.55) / 0.45), 1.3);
const bevelHeight = (u) => Math.min(0.0075, 0.48 * (spineY(u) - edgeY(u)));

// Last station is the tip; station 0 sits 6 mm inside the guard.
const BLADE_U = [-0.0316, 0.06, 0.16, 0.27, 0.38, 0.48, 0.57, 0.65, 0.72, 0.78, 0.84, 0.89, 0.93, 0.965, 1];
const FULLER_FIRST = 1;
const FULLER_LAST = 6;

function buildBlade() {
  const blade = new MeshBuilder('blade', 'metal');
  const edge = new MeshBuilder('edge', 'edge_shine');
  const fuller = new MeshBuilder('fuller', 'metal');

  const tip = [0, TIP_Y, TIP_Z];
  const stations = BLADE_U.slice(0, -1).map((u, i) => {
    const z = bladeZ(u);
    const h = halfThickness(u);
    const ys = spineY(u);
    const ye = edgeY(u);
    const yb = ye + bevelHeight(u);
    const st = {
      sp: [h, ys, z], sn: [-h, ys, z],
      bp: [h, yb, z], bn: [-h, yb, z],
      e: [0, ye, z],
      fuller: i >= FULLER_FIRST && i <= FULLER_LAST,
    };
    if (st.fuller) {
      const end = i === FULLER_FIRST || i === FULLER_LAST;
      const half = end ? 0.0018 : 0.00275;
      const depth = end ? 0.0005 : 0.0007;
      const fc = ys - 0.0085;
      st.ftp = [h, fc + half, z]; st.ftn = [-h, fc + half, z];
      st.fbp = [h, fc - half, z]; st.fbn = [-h, fc - half, z];
      st.fmp = [h - depth, fc, z]; st.fmn = [-(h - depth), fc, z];
    }
    return st;
  });

  // Back cap (hidden inside the guard, keeps the solid closed)
  const s0 = stations[0];
  blade.flatFan([s0.sp, s0.bp, s0.e, s0.bn, s0.sn], [0, 0, 1]);

  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    blade.flatQuad(a.sn, a.sp, b.sp, b.sn, [0, 1, 0]); // flat spine

    for (const side of ['p', 'n']) {
      const sx = side === 'p' ? 1 : -1;
      const S = (st) => st['s' + side], B = (st) => st['b' + side];
      const FT = (st) => st['ft' + side], FB = (st) => st['fb' + side], FM = (st) => st['fm' + side];
      const out = [sx, 0, 0];

      if (a.fuller && b.fuller) {
        blade.flatQuad(S(a), FT(a), FT(b), S(b), out);
        blade.flatQuad(FB(a), B(a), B(b), FB(b), out);
        fuller.flatQuad(FT(a), FM(a), FM(b), FT(b), out);
        fuller.flatQuad(FM(a), FB(a), FB(b), FM(b), out);
      } else if (b.fuller) {
        // flat face widens into the groove start (6 points on the right edge, no T-junctions)
        blade.flatTri(S(a), FT(b), S(b), out);
        blade.flatTri(S(a), FB(b), FT(b), out);
        blade.flatTri(S(a), B(a), FB(b), out);
        blade.flatTri(B(a), B(b), FB(b), out);
        fuller.flatTri(FT(b), FM(b), FB(b), [0, 0, -1]); // groove end wall faces into the groove
      } else if (a.fuller) {
        blade.flatTri(S(b), FT(a), S(a), out);
        blade.flatTri(S(b), FB(a), FT(a), out);
        blade.flatTri(S(b), B(b), FB(a), out);
        blade.flatTri(B(b), B(a), FB(a), out);
        fuller.flatTri(FT(a), FM(a), FB(a), [0, 0, 1]);
      } else {
        blade.flatQuad(S(a), B(a), B(b), S(b), out);
      }

      edge.flatQuad(B(a), a.e, b.e, B(b), [sx, -1, 0]); // bevelled cutting edge
    }
  }

  // Tip segment
  const last = stations[stations.length - 1];
  blade.flatTri(last.sn, last.sp, tip, [0, 1, 0]);
  blade.flatTri(last.sp, last.bp, tip, [1, 0, 0]);
  blade.flatTri(last.sn, last.bn, tip, [-1, 0, 0]);
  edge.flatTri(last.bp, last.e, tip, [1, -1, 0]);
  edge.flatTri(last.bn, last.e, tip, [-1, -1, 0]);

  return { blade, edge, fuller, tip, edgeMid: [0, edgeY(0.5), bladeZ(0.5)] };
}

// ============== Guard: chamfered rounded-rectangle plate ==============
function roundedRect(hx, hy, rc, cy, z, perCorner = 4) {
  const pts = [];
  const corners = [[1, 1, 0], [-1, 1, 1], [-1, -1, 2], [1, -1, 3]];
  for (const [sx, sy, q] of corners) {
    for (let k = 0; k < perCorner; k++) {
      const a = (q + k / (perCorner - 1)) * (Math.PI / 2);
      pts.push([sx * (hx - rc) + rc * Math.cos(a), cy + sy * (hy - rc) + rc * Math.sin(a), z]);
    }
  }
  return pts;
}

function buildGuard() {
  const guard = new MeshBuilder('guard', 'dark_metal');
  const hx = 0.0135, hy = 0.0215, rc = 0.0055, ch = 0.0012;
  const rings = [
    roundedRect(hx - ch, hy - ch, rc - ch, GUARD_CY, GUARD_FRONT_Z),
    roundedRect(hx, hy, rc, GUARD_CY, GUARD_FRONT_Z + ch),
    roundedRect(hx, hy, rc, GUARD_CY, GUARD_BACK_Z - ch),
    roundedRect(hx - ch, hy - ch, rc - ch, GUARD_CY, GUARD_BACK_Z),
  ];
  const bandZ = [-1, 0, 1];
  for (let r = 0; r < rings.length - 1; r++) {
    const A = rings[r], B = rings[r + 1];
    for (let s = 0; s < A.length; s++) {
      const s1 = (s + 1) % A.length;
      const mid = [(A[s][0] + A[s1][0]) / 2, (A[s][1] + A[s1][1]) / 2 - GUARD_CY, 0];
      guard.flatQuad(A[s], A[s1], B[s1], B[s], add(normalize(mid), [0, 0, bandZ[r]]));
    }
  }
  guard.flatFan(rings[0], [0, 0, -1]);
  guard.flatFan(rings[rings.length - 1], [0, 0, 1]);
  return guard;
}

// ============== Handle: oval grip with 5 finger grooves ==============
const HANDLE_SEGS = 12;
const GROOVES = 5;
const GROOVE_T0 = 0.07;
const GROOVE_T1 = 0.8;
const handleT = (z) => clamp01((z - HANDLE_START_Z) / HANDLE_LEN);

function handleRadii(t) {
  const k = 1 + 0.12 * t + 0.05 * smoothstep(0.82, 1, t); // thicker toward the pommel
  return [0.0108 * k, 0.0142 * k];
}

function grooveAmount(t) {
  if (t <= GROOVE_T0 || t >= GROOVE_T1) return 0;
  const p = ((t - GROOVE_T0) / (GROOVE_T1 - GROOVE_T0)) * GROOVES;
  return Math.sin(Math.PI * p) ** 2;
}

function handleRing(z) {
  const t = handleT(z);
  const [rx, ry] = handleRadii(t);
  const g = grooveAmount(t);
  const ring = [];
  for (let s = 0; s < HANDLE_SEGS; s++) {
    const a = (s / HANDLE_SEGS) * Math.PI * 2;
    const sin = Math.sin(a);
    // Finger grooves bite deepest on the underside (edge side), shallow all around.
    const w = 0.3 + 0.7 * Math.pow(Math.max(0, -sin), 1.5);
    const k = 1 - 0.15 * g * w;
    ring.push([rx * Math.cos(a) * k, ry * sin * k, z]);
  }
  return ring;
}

function buildHandle() {
  const handle = new MeshBuilder('handle', 'wood');
  const grooves = new MeshBuilder('handle_groove', 'rubber');

  // Ring stations: quarter-groove steps through the groove zone so each groove gets 4 bands.
  const zAt = (t) => HANDLE_START_Z + HANDLE_LEN * t;
  const stations = [{ z: -0.05 }, { z: zAt(0) }, { z: zAt(0.035) }];
  for (let k = 0; k <= GROOVES * 4; k++) stations.push({ z: zAt(GROOVE_T0 + ((GROOVE_T1 - GROOVE_T0) * k) / (GROOVES * 4)), k });
  stations.push({ z: zAt(0.86) }, { z: zAt(0.93) }, { z: zAt(1) }, { z: POMMEL_START_Z + 0.0015 });

  const rings = stations.map((st) => handleRing(st.z));
  const normals = gridNormals(rings);

  for (let r = 0; r < rings.length - 1; r++) {
    const k = stations[r].k;
    const isGroove = k !== undefined && stations[r + 1].k !== undefined && (k % 4 === 1 || k % 4 === 2);
    emitBand(isGroove ? grooves : handle, rings[r], rings[r + 1], normals[r], normals[r + 1]);
  }

  // End caps (hidden inside guard / pommel)
  handle.flatFan(rings[0], [0, 0, -1]);
  handle.flatFan(rings[rings.length - 1], [0, 0, 1]);
  return { handle, grooves };
}

// ============== Pommel cap + lanyard ring ==============
function buildPommel() {
  const pommel = new MeshBuilder('pommel', 'dark_metal');
  const [rx, ry] = handleRadii(1);
  const profile = [
    [POMMEL_START_Z - 0.0005, 0.97],
    [POMMEL_START_Z + 0.0002, 1.07],
    [POMMEL_START_Z + 0.0032, 1.1],
    [POMMEL_START_Z + 0.0055, 0.98],
    [POMMEL_START_Z + 0.0064, 0.72],
  ];
  const apexZ = POMMEL_START_Z + 0.0067;
  const rings = profile.map(([z, k]) => {
    const ring = [];
    for (let s = 0; s < HANDLE_SEGS; s++) {
      const a = (s / HANDLE_SEGS) * Math.PI * 2;
      ring.push([rx * k * Math.cos(a), ry * k * Math.sin(a), z]);
    }
    return ring;
  });
  const apexRing = rings[0].map(() => [0, 0, apexZ]);
  const normals = gridNormals([...rings, apexRing]);

  for (let r = 0; r < rings.length - 1; r++) emitBand(pommel, rings[r], rings[r + 1], normals[r], normals[r + 1]);
  const last = rings.length - 1;
  const apex = [[0, 0, apexZ], [0, 0, 1]];
  for (let s = 0; s < HANDLE_SEGS; s++) {
    const s1 = (s + 1) % HANDLE_SEGS;
    pommel.smoothTri([rings[last][s], normals[last][s]], [rings[last][s1], normals[last][s1]], apex);
  }
  pommel.flatFan(rings[0], [0, 0, -1]);
  return pommel;
}

function buildLanyardRing() {
  const ring = new MeshBuilder('lanyard_ring', 'dark_metal');
  const zc = 0.0665, R = 0.0029, r = 0.0007;
  const MAJOR = 10, MINOR = 6;
  const grid = [];
  for (let i = 0; i < MAJOR; i++) {
    const phi = (i / MAJOR) * Math.PI * 2;
    const dir = [0, Math.cos(phi), Math.sin(phi)]; // ring lies in the YZ plane, hole axis = X
    const row = [];
    for (let j = 0; j < MINOR; j++) {
      const psi = (j / MINOR) * Math.PI * 2;
      const n = add(dir.map((v) => v * Math.cos(psi)), [Math.sin(psi), 0, 0]);
      row.push([[n[0] * r, dir[1] * R + n[1] * r, zc + dir[2] * R + n[2] * r], n]);
    }
    grid.push(row);
  }
  for (let i = 0; i < MAJOR; i++) {
    for (let j = 0; j < MINOR; j++) {
      const a = grid[i][j], b = grid[(i + 1) % MAJOR][j];
      const c = grid[(i + 1) % MAJOR][(j + 1) % MINOR], d = grid[i][(j + 1) % MINOR];
      ring.smoothTri(a, b, c);
      ring.smoothTri(a, c, d);
    }
  }
  return ring;
}

// ============== Materials ==============
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hexColor = (hex) => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => srgbToLinear(c / 255)).concat(1);
};

const MATERIALS = [
  { name: 'metal', color: '#c8cdd3', roughness: 0.35, metalness: 0.8 },
  { name: 'dark_metal', color: '#3b3f45', roughness: 0.5, metalness: 0.7 },
  { name: 'wood', color: '#5a3b22', roughness: 0.7, metalness: 0 },
  { name: 'rubber', color: '#1e1e1e', roughness: 0.9, metalness: 0 },
  { name: 'edge_shine', color: '#eef1f4', roughness: 0.2, metalness: 0.9 },
];

// ============== GLB writer ==============
function writeGlb(meshes, empties) {
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
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: typed.byteLength, target });
    chunks.push(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength));
    byteLength += typed.byteLength;
    return bufferViews.length - 1;
  };

  const matIndex = new Map(MATERIALS.map((m, i) => [m.name, i]));
  const gltfMeshes = meshes.map((m) => {
    const pos = new Float32Array(m.positions.flat());
    const nrm = new Float32Array(m.normals.flat());
    const idx = new Uint16Array(m.indices);
    const min = [0, 1, 2].map((c) => Math.min(...m.positions.map((p) => Math.fround(p[c]))));
    const max = [0, 1, 2].map((c) => Math.max(...m.positions.map((p) => Math.fround(p[c]))));
    accessors.push({ bufferView: pushView(pos, 34962), componentType: 5126, count: m.positions.length, type: 'VEC3', min, max });
    const posAcc = accessors.length - 1;
    accessors.push({ bufferView: pushView(nrm, 34962), componentType: 5126, count: m.normals.length, type: 'VEC3' });
    const nrmAcc = accessors.length - 1;
    accessors.push({ bufferView: pushView(idx, 34963), componentType: 5123, count: m.indices.length, type: 'SCALAR' });
    const idxAcc = accessors.length - 1;
    return {
      name: m.name,
      primitives: [{ attributes: { POSITION: posAcc, NORMAL: nrmAcc }, indices: idxAcc, material: matIndex.get(m.material), mode: 4 }],
    };
  });

  const nodes = [{ name: 'knife', children: [] }];
  meshes.forEach((m, i) => {
    nodes[0].children.push(nodes.length);
    nodes.push({ name: m.name, mesh: i });
  });
  for (const e of empties) {
    nodes[0].children.push(nodes.length);
    nodes.push({ name: e.name, translation: e.position });
  }

  const json = {
    asset: { version: '2.0', generator: 'stickman-strike generate-knife-glb.mjs' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes,
    meshes: gltfMeshes,
    materials: MATERIALS.map((m) => ({
      name: m.name,
      pbrMetallicRoughness: { baseColorFactor: hexColor(m.color), metallicFactor: m.metalness, roughnessFactor: m.roughness },
    })),
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
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const chunkHeader = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([header, chunkHeader(jsonBuf.length, 0x4e4f534a), jsonBuf, chunkHeader(bin.length, 0x004e4942), bin]);
}

// ============== Build ==============
const { blade, edge, fuller, tip, edgeMid } = buildBlade();
const { handle, grooves } = buildHandle();
const meshes = [blade, edge, fuller, buildGuard(), handle, grooves, buildPommel(), buildLanyardRing()];
const empties = [
  { name: 'grip', position: [0, 0, 0] },
  { name: 'tip', position: tip },
  { name: 'edge_mid', position: edgeMid },
];

const glb = writeGlb(meshes, empties);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, glb);

let tris = 0;
for (const m of meshes) {
  tris += m.triangleCount;
  console.log(`${m.name.padEnd(14)} ${String(m.triangleCount).padStart(4)} tris  (${m.material})`);
}
console.log(`total          ${String(tris).padStart(4)} tris, ${(glb.length / 1024).toFixed(1)} KB -> ${OUT}`);
