#!/usr/bin/env node
/**
 * `public/models/buildings/wood_stairs_01.glb` dan +X tomondagi vizual tutqichni (2 ustun, qiya dasta,
 * 4 ta panjara) olib tashlaydi. Pog'onalar, panellar va ikkala yon taxta saqlanadi.
 *
 * Nega: tutqich kollayderi avval olib tashlangan edi (zinaga kirish va yuqorida burilishni to'sib
 * qo'yardi), lekin GLB dagi tutqich ko'rinib turar va o'yinchi uning ichidan o'tib yurardi.
 *
 * Mesh bitta indekssiz primitiv (POSITION / COLOR_0 / NORMAL, 828 uchburchak). Uchburchaklar umumiy
 * uchlari bo'yicha bog'langan qismlarga ajratiladi; min x >= 0.58 va min y >= 0.1 bo'lgan qismlar
 * (tutqich) tashlab yuboriladi — yon taxta (min y = -0.01) qoladi.
 *
 *   node scripts/strip-stairs-handrail.mjs            # faylni qayta yozadi
 *   node scripts/strip-stairs-handrail.mjs --dry-run  # faqat hisobot
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.cwd(), 'public/models/buildings/wood_stairs_01.glb');
const dryRun = process.argv.includes('--dry-run');

const glb = readFileSync(file);
if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('GLB magic xato');
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
const binLen = glb.readUInt32LE(20 + jsonLen);
const bin = glb.subarray(28 + jsonLen, 28 + jsonLen + binLen);

const prim = json.meshes[0].primitives[0];
if (prim.indices !== undefined) throw new Error('indekssiz primitiv kutilgan edi');
const attrNames = ['POSITION', 'COLOR_0', 'NORMAL'];
const readAttr = (name) => {
  const acc = json.accessors[prim.attributes[name]];
  const bv = json.bufferViews[acc.bufferView];
  const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? 12;
  const out = new Float32Array(acc.count * 3);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < 3; c++) out[i * 3 + c] = bin.readFloatLE(off + i * stride + c * 4);
  }
  return out;
};
const data = Object.fromEntries(attrNames.map((n) => [n, readAttr(n)]));
const vertCount = json.accessors[prim.attributes.POSITION].count;
const triCount = vertCount / 3;

// Umumiy uchlar bo'yicha bog'langan qismlar (union-find)
const parent = Array.from({ length: triCount }, (_, i) => i);
const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
const seen = new Map();
const pos = data.POSITION;
for (let t = 0; t < triCount; t++) {
  for (let c = 0; c < 3; c++) {
    const v = (t * 3 + c) * 3;
    const key = `${pos[v].toFixed(3)},${pos[v + 1].toFixed(3)},${pos[v + 2].toFixed(3)}`;
    const other = seen.get(key);
    if (other === undefined) seen.set(key, t);
    else parent[find(other)] = find(t);
  }
}
const compMin = new Map();
for (let t = 0; t < triCount; t++) {
  const r = find(t);
  let m = compMin.get(r);
  if (!m) compMin.set(r, (m = { x: Infinity, y: Infinity }));
  for (let c = 0; c < 3; c++) {
    const v = (t * 3 + c) * 3;
    m.x = Math.min(m.x, pos[v]);
    m.y = Math.min(m.y, pos[v + 1]);
  }
}
const isHandrail = (t) => {
  const m = compMin.get(find(t));
  return m.x >= 0.58 && m.y >= 0.1;
};
const keep = [];
for (let t = 0; t < triCount; t++) if (!isHandrail(t)) keep.push(t);
const removedComps = new Set([...compMin.keys()].filter((r) => isHandrail(r))).size;
console.log(`uchburchaklar: ${triCount} -> ${keep.length} (olib tashlangan qismlar: ${removedComps})`);
if (removedComps === 0) {
  console.log('Tutqich topilmadi — fayl o‘zgartirilmadi.');
  process.exit(0);
}

// Yangi buferlar
const newCount = keep.length * 3;
const views = attrNames.map((n) => {
  const src = data[n];
  const out = Buffer.alloc(newCount * 12);
  let w = 0;
  for (const t of keep) {
    for (let c = 0; c < 3; c++) {
      const v = (t * 3 + c) * 3;
      for (let k = 0; k < 3; k++) {
        out.writeFloatLE(src[v + k], w);
        w += 4;
      }
    }
  }
  return out;
});
const newBin = Buffer.concat(views);
let offset = 0;
attrNames.forEach((n, i) => {
  const acc = json.accessors[prim.attributes[n]];
  const bv = json.bufferViews[acc.bufferView];
  bv.byteOffset = offset;
  bv.byteLength = views[i].length;
  offset += views[i].length;
  acc.count = newCount;
  acc.byteOffset = 0;
  if (n === 'POSITION') {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < newCount; v++) {
      for (let k = 0; k < 3; k++) {
        const x = views[i].readFloatLE((v * 3 + k) * 4);
        mn[k] = Math.min(mn[k], x);
        mx[k] = Math.max(mx[k], x);
      }
    }
    acc.min = mn;
    acc.max = mx;
    console.log('yangi chegaralar min', mn.map((x) => x.toFixed(3)), 'max', mx.map((x) => x.toFixed(3)));
  }
});
json.buffers[0].byteLength = newBin.length;

if (dryRun) process.exit(0);

const pad4 = (n) => (n + 3) & ~3;
let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)]);
const binBuf = Buffer.concat([newBin, Buffer.alloc(pad4(newBin.length) - newBin.length)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const jsonHdr = Buffer.alloc(8);
jsonHdr.writeUInt32LE(jsonBuf.length, 0);
jsonHdr.writeUInt32LE(0x4e4f534a, 4);
const binHdr = Buffer.alloc(8);
binHdr.writeUInt32LE(binBuf.length, 0);
binHdr.writeUInt32LE(0x004e4942, 4);
writeFileSync(file, Buffer.concat([header, jsonHdr, jsonBuf, binHdr, binBuf]));
console.log(`yozildi: ${file}`);
