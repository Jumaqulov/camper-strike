// Validates the feral wolf GLBs (pure Node, no deps).
//   node scripts/validate-wolf-glb.mjs              -> checks all five coat files
//   node scripts/validate-wolf-glb.mjs file.glb     -> checks one file
// Prints a report and exits with code 1 when any check fails.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv[2]) {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/models/characters');
  let failed = 0;
  for (const coat of ['', '_red', '_tan', '_black', '_white']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), resolve(dir, `feral_wolf${coat}_rigged.glb`)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `\n${failed} file(s) FAILED` : '\nall coat variants passed');
  process.exit(failed ? 1 : 0);
}

const FILE = process.argv[2];
const EXPECTED_PARENT = {
  Root: 'feral_wolf', Hips: 'Root', Spine: 'Hips', Chest: 'Spine', Neck: 'Chest', Head: 'Neck', Jaw: 'Head', Ear_L: 'Head', Ear_R: 'Head',
  Tail_1: 'Hips', Tail_2: 'Tail_1', Tail_3: 'Tail_2',
  UpperLeg_BL: 'Hips', LowerLeg_BL: 'UpperLeg_BL', Foot_BL: 'LowerLeg_BL',
  UpperLeg_BR: 'Hips', LowerLeg_BR: 'UpperLeg_BR', Foot_BR: 'LowerLeg_BR',
  UpperLeg_FL: 'Chest', LowerLeg_FL: 'UpperLeg_FL', Foot_FL: 'LowerLeg_FL',
  UpperLeg_FR: 'Chest', LowerLeg_FR: 'UpperLeg_FR', Foot_FR: 'LowerLeg_FR',
};
const EXPECTED_JOINTS = Object.keys(EXPECTED_PARENT);
const CLIPS = { Idle: 2.0, Sniff: 1.6, Alert: 1.0, Walk: 1.0, Run: 0.6, Howl: 3.0, Attack: 0.7, Hit: 0.4, Death: 1.2 };
const LOOPING = ['Idle', 'Sniff', 'Alert', 'Walk', 'Run'];
const SOCKETS = { socket_mouth: 'Jaw', socket_eyes: 'Head', socket_back: 'Chest', socket_nose: 'Head' };
const BOX = { min: [-0.35, 0, -1.05], max: [0.35, 1.25, 0.95] };
const MAX_TRIS = 12000;
const ATTRS = ['POSITION', 'NORMAL', 'COLOR_0', 'JOINTS_0', 'WEIGHTS_0'];
const EPS = 1e-4;

const results = [];
const check = (section, ok, msg) => results.push({ section, ok: !!ok, msg });

const buf = readFileSync(FILE);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${FILE} is not a GLB`);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const bin = buf.subarray(28 + jsonLen, 28 + jsonLen + buf.readUInt32LE(20 + jsonLen));
const COMPONENTS = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPED = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const read = (index) => {
  const a = gltf.accessors[index];
  const v = gltf.bufferViews[a.bufferView];
  const T = TYPED[a.componentType];
  const n = a.count * COMPONENTS[a.type];
  const off = bin.byteOffset + (v.byteOffset || 0) + (a.byteOffset || 0);
  return new T(bin.buffer.slice(off, off + n * T.BYTES_PER_ELEMENT));
};
const nodes = gltf.nodes;
const byName = new Map(nodes.map((n, i) => [n.name, i]));
const parentOf = new Map();
nodes.forEach((n, i) => (n.children || []).forEach((c) => parentOf.set(c, i)));
const nameOf = (i) => nodes[i]?.name;
const worldPos = (i) => {
  let p = [0, 0, 0];
  for (let n = i; n !== undefined; n = parentOf.get(n)) {
    const t = nodes[n].translation || [0, 0, 0];
    p = [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
  }
  return p;
};

// ---------- 1. hierarchy / skeleton ----------
{
  const S = '1 skeleton';
  const root = byName.get('feral_wolf');
  const bodyIdx = byName.get('wolf_body');
  check(S, root !== undefined && gltf.scenes[gltf.scene ?? 0].nodes.includes(root), 'scene root "feral_wolf"');
  check(S, parentOf.get(bodyIdx) === root && nodes[bodyIdx].mesh !== undefined && nodes[bodyIdx].skin !== undefined, '"wolf_body" skinned mesh under "feral_wolf"');
  const skin = gltf.skins?.[0];
  const names = skin ? skin.joints.map(nameOf) : [];
  const missing = EXPECTED_JOINTS.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !EXPECTED_JOINTS.includes(n));
  check(S, names.length <= 28 && !missing.length && !extra.length, `${names.length} joints, names exact${missing.length ? ` missing ${missing}` : ''}${extra.length ? ` extra ${extra}` : ''}`);
  const bad = EXPECTED_JOINTS.filter((n) => nameOf(parentOf.get(byName.get(n))) !== EXPECTED_PARENT[n]);
  check(S, !bad.length, `joint hierarchy as specified${bad.length ? ` (wrong: ${bad})` : ''}`);
  const jointSet = new Set(skin?.joints || []);
  const socketSet = new Set(Object.keys(SOCKETS).map((n) => byName.get(n)));
  let badScale = 0;
  let badXf = 0;
  nodes.forEach((n, i) => {
    if (n.matrix || (n.scale && n.scale.some((s) => Math.abs(s - 1) > EPS))) badScale++;
    if (!jointSet.has(i) && !socketSet.has(i) && (n.translation || n.rotation || n.scale)) badXf++;
    if (socketSet.has(i) && (n.rotation || n.scale)) badXf++;
    if (jointSet.has(i) && n.rotation) badXf++;
  });
  check(S, badScale === 0, 'no scale / matrix on any node');
  check(S, badXf === 0, 'identity transforms on non-joint nodes, identity rest rotations');
  if (skin) {
    const ibm = read(skin.inverseBindMatrices);
    let worst = 0;
    skin.joints.forEach((j, k) => {
      const p = worldPos(j);
      const e = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1];
      for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(ibm[k * 16 + i] - e[i]));
    });
    check(S, worst < 1e-4, `inverseBindMatrices match the rest pose (max err ${worst.toExponential(1)})`);
    const chestY = worldPos(byName.get('Chest'))[1];
    check(S, chestY >= 0.95 && chestY <= 1.1, `Chest joint y ${chestY.toFixed(3)} (0.95-1.10)`);
    check(S, Math.hypot(...worldPos(byName.get('Root'))) < EPS, 'Root at the origin');
  }
}

// ---------- 2. clips ----------
{
  const S = '2 clips';
  const anims = gltf.animations || [];
  const names = anims.map((a) => a.name);
  check(S, names.length === Object.keys(CLIPS).length && names.every((n) => n in CLIPS), `clips: ${names.join(', ')}`);
  const jointSet = new Set(gltf.skins[0].joints);
  for (const a of anims) {
    let dur = 0;
    let bad = 0;
    for (const ch of a.channels) {
      const s = a.samplers[ch.sampler];
      dur = Math.max(dur, gltf.accessors[s.input].max[0]);
      const node = nameOf(ch.target.node);
      if ((s.interpolation || 'LINEAR') !== 'LINEAR' || !jointSet.has(ch.target.node) || ch.target.path === 'scale' || node === 'Root') bad++;
      if (ch.target.path === 'translation' && node !== 'Hips') bad++;
      if (ch.target.path === 'rotation') {
        const q = read(s.output);
        for (let i = 0; i < q.length; i += 4) if (Math.abs(Math.hypot(q[i], q[i + 1], q[i + 2], q[i + 3]) - 1) > 1e-3) bad++;
      }
    }
    const frames = gltf.accessors[a.samplers[0].input].count;
    const fps = (frames - 1) / dur;
    check(S, Math.abs(dur - CLIPS[a.name]) <= 0.05 && Math.abs(fps - 30) < 0.5 && !bad,
      `${a.name}: ${dur.toFixed(2)} s @ ${fps.toFixed(0)} fps, LINEAR, Hips-only translation, Root untouched`);
  }
  for (const name of LOOPING) {
    const a = anims.find((x) => x.name === name);
    if (!a) continue;
    let worst = 0;
    for (const ch of a.channels) {
      const out = read(a.samplers[ch.sampler].output);
      const k = ch.target.path === 'rotation' ? 4 : 3;
      const first = out.subarray(0, k);
      const last = out.subarray(out.length - k);
      const sign = k === 4 && first[0] * last[0] + first[1] * last[1] + first[2] * last[2] + first[3] * last[3] < 0 ? -1 : 1;
      for (let e = 0; e < k; e++) worst = Math.max(worst, Math.abs(first[e] - sign * last[e]));
    }
    check(S, worst < 1e-3, `${name} loops seamlessly`);
  }
  const jawAt = (anim, t) => {
    const ch = anim.channels.find((c) => nameOf(c.target.node) === 'Jaw' && c.target.path === 'rotation');
    const times = read(anim.samplers[ch.sampler].input);
    const q = read(anim.samplers[ch.sampler].output);
    let i = 0;
    while (i < times.length - 1 && times[i + 1] <= t + 1e-6) i++;
    return (2 * Math.acos(Math.min(1, Math.abs(q[i * 4 + 3]))) * 180) / Math.PI;
  };
  const jawMax = (anim) => {
    const ch = anim.channels.find((c) => nameOf(c.target.node) === 'Jaw' && c.target.path === 'rotation');
    const q = read(anim.samplers[ch.sampler].output);
    let m = 0;
    for (let i = 3; i < q.length; i += 4) m = Math.max(m, (2 * Math.acos(Math.min(1, Math.abs(q[i]))) * 180) / Math.PI);
    return m;
  };
  const attack = anims.find((a) => a.name === 'Attack');
  if (attack) {
    check(S, jawMax(attack) >= 35, `Attack jaw opens ${jawMax(attack).toFixed(1)} deg (>= 35)`);
    check(S, jawAt(attack, 0.25) > 30 && jawAt(attack, 0.3) < 2, `bite closes at 0.30 s (${jawAt(attack, 0.25).toFixed(0)} -> ${jawAt(attack, 0.3).toFixed(0)} deg)`);
  }
}

// ---------- 3. geometry ----------
{
  const S = '3 geometry';
  let tris = 0;
  const nJoints = gltf.skins[0].joints.length;
  for (const p of gltf.meshes[0].primitives) {
    const mat = gltf.materials[p.material].name;
    tris += gltf.accessors[p.indices].count / 3;
    const missing = ATTRS.filter((a) => p.attributes[a] === undefined);
    check(S, !missing.length && (p.mode ?? 4) === 4, `"${mat}" triangles with ${Object.keys(p.attributes).join(', ')}`);
    const j = read(p.attributes.JOINTS_0);
    const w = read(p.attributes.WEIGHTS_0);
    const n = read(p.attributes.NORMAL);
    let bad = 0;
    for (let i = 0; i < w.length; i += 4) {
      if (Math.abs(w[i] + w[i + 1] + w[i + 2] + w[i + 3] - 1) > 1e-3) bad++;
      for (let k = 0; k < 4; k++) if (j[i + k] >= nJoints || w[i + k] < 0) bad++;
    }
    for (let i = 0; i < n.length; i += 3) if (Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) > 1e-2) bad++;
    check(S, !bad, `"${mat}" weights normalized (<= 4 influences), unit normals`);
  }
  check(S, tris >= 2500 && tris <= MAX_TRIS, `${tris} triangles (2500-${MAX_TRIS})`);
}

// ---------- 4. bounds ----------
{
  const S = '4 bounds';
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of gltf.meshes[0].primitives) {
    const a = gltf.accessors[p.attributes.POSITION];
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], a.min[c]);
      hi[c] = Math.max(hi[c], a.max[c]);
    }
  }
  check(S, lo.every((v, c) => v >= BOX.min[c] - EPS) && hi.every((v, c) => v <= BOX.max[c] + EPS),
    `POSITION [${lo.map((v) => v.toFixed(3))}]..[${hi.map((v) => v.toFixed(3))}] inside x+-0.35 y0..1.25 z-1.05..0.95`);
  check(S, Math.abs(lo[1]) < 2e-3, `paws on the ground (min y ${lo[1].toFixed(4)})`);
}

// ---------- 5. sockets / materials ----------
{
  const S = '5 sockets/materials';
  for (const [s, parent] of Object.entries(SOCKETS)) {
    const i = byName.get(s);
    check(S, i !== undefined && nameOf(parentOf.get(i)) === parent && nodes[i].mesh === undefined, `${s} under ${parent}`);
  }
  const main = gltf.materials.find((m) => m.name === 'wolf_main');
  check(S, main && main.pbrMetallicRoughness.metallicFactor === 0 && Math.abs(main.pbrMetallicRoughness.roughnessFactor - 0.85) < 1e-6, 'wolf_main: metallic 0, roughness 0.85');
  const ei = gltf.materials.findIndex((m) => m.name === 'wolf_eyes');
  const em = gltf.materials[ei];
  const strength = em?.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
  check(S, gltf.meshes[0].primitives.some((p) => p.material === ei), 'eyes primitive uses wolf_eyes');
  check(S, em && em.emissiveFactor?.some((v) => v > 0) && strength >= 2 && em.pbrMetallicRoughness.baseColorFactor.slice(0, 3).every((v) => v === 0),
    `wolf_eyes emissive x${strength}, black base colour`);
  check(S, gltf.materials.every((m) => !m.alphaMode || m.alphaMode === 'OPAQUE'), 'no transparency');
}

// ---------- 6. file ----------
{
  const S = '6 file';
  const used = gltf.extensionsUsed || [];
  check(S, statSync(FILE).size < 1.5 * 1024 * 1024, `${(statSync(FILE).size / 1024).toFixed(1)} KB (< 1.5 MB)`);
  check(S, used.every((e) => e === 'KHR_materials_emissive_strength'), `extensions: ${used.join(', ') || 'none'}`);
  check(S, !gltf.textures && !gltf.images && !gltf.cameras, 'no textures, images or cameras');
}

let section = '';
for (const r of results) {
  if (r.section !== section) {
    section = r.section;
    console.log(`\n[${section}]`);
  }
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? ` - ${failed} FAILED` : ''}  (${FILE})`);
process.exit(failed ? 1 : 0);
