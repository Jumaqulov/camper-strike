import * as THREE from 'three';

/**
 * Bo'ri LOD (detal darajalari): skinlangan geometriyani ish vaqtida (GLB tahlilida, har coat shabloni uchun bir
 * marta) vertex-klasterlash bilan soddalashtiramiz — `SimplifyModifier` skinIndex/skinWeight atributlarini
 * tashlaydi va 6k vertexda sekin, bu esa suyak atributlarini saqlaydi va bir necha ms da ishlaydi.
 *
 * Usul: model fazosida `cell` qadamli to'r; har katakdagi vertexlar birinchisiga yig'iladi (pozitsiya — katak
 * o'rtachasi, qolgan atributlar — birinchi vertexniki: normal, uv, rang, skinIndex, skinWeight). Uchburchak
 * indekslari qayta yoziladi, degenerat (ikki uchi bir) va takroriy uchburchaklar tashlanadi. Suyak tartibi va
 * bindMatrix o'zgarmaydi — LOD geometriyalari bir xil skelet bilan ishlaydi (`mesh.geometry = lodGeo`).
 */

/**
 * LOD 1 va 2 uchun klaster katak o'lchamlari (model fazosida, m) — WolfAssetRegistry shuni ishlatadi.
 * feral_wolf_rigged.glb (11 444 uchburchak) uchun o'lchangan: 0.05 m → ≈35 %, 0.08 m → ≈15 % uchburchak.
 */
export const WOLF_LOD1_CELL_M = 0.05;
export const WOLF_LOD2_CELL_M = 0.08;

/** Kamera masofalari (m): LOD0 < 18, LOD1 18..40, LOD2 > 40; 2 m gisterezis (orqaga qaytish 16 / 38). */
export const WOLF_LOD1_DIST_M = 18;
export const WOLF_LOD2_DIST_M = 40;
export const WOLF_LOD_HYSTERESIS_M = 2;
/** Shu masofadan uzoqda soya tashlamaydi. */
export const WOLF_SHADOW_MAX_DIST_M = 40;
/** Animatsiya mikseri yangilanish qadami: 70 m dan har 2-kadr, 110 m dan har 4-kadr, 160 m dan yangilanmaydi. */
export const WOLF_MIXER_HALF_DIST_M = 70;
export const WOLF_MIXER_QUARTER_DIST_M = 110;
export const WOLF_MIXER_OFF_DIST_M = 160;

export type WolfLodLevel = 0 | 1 | 2;

/**
 * Masofa bo'yicha LOD darajasi, gisterezis bilan: joriy darajadan uzoqlashganda chegara (18/40), yaqinlashganda
 * chegara − 2 m (16/38) — snapshot shovqinida har kadr almashib turmaydi. Sof funksiya (test uchun).
 */
export function pickWolfLod(dist: number, current: WolfLodLevel): WolfLodLevel {
  if (!Number.isFinite(dist)) return current;
  const h = WOLF_LOD_HYSTERESIS_M;
  const up1 = WOLF_LOD1_DIST_M;
  const up2 = WOLF_LOD2_DIST_M;
  if (current === 0) return dist >= up2 ? 2 : dist >= up1 ? 1 : 0;
  if (current === 1) return dist >= up2 ? 2 : dist < up1 - h ? 0 : 1;
  return dist < up1 - h ? 0 : dist < up2 - h ? 1 : 2;
}

/** Mikser yangilanish qadami (kadr): 1 — har kadr, 2 — har ikkinchi, 4 — har to'rtinchi, 0 — yangilanmaydi. */
export function wolfMixerStride(dist: number): 0 | 1 | 2 | 4 {
  if (!Number.isFinite(dist) || dist < WOLF_MIXER_HALF_DIST_M) return 1;
  if (dist < WOLF_MIXER_QUARTER_DIST_M) return 2;
  if (dist < WOLF_MIXER_OFF_DIST_M) return 4;
  return 0;
}

/** Shu masofada soya tashlaydimi. */
export function wolfCastsShadowAt(dist: number): boolean {
  return !Number.isFinite(dist) || dist < WOLF_SHADOW_MAX_DIST_M;
}

export interface ClusterDecimateResult {
  geometry: THREE.BufferGeometry;
  /** Kirish/chiqish uchburchak va vertex sonlari (diagnostika). */
  trianglesIn: number;
  trianglesOut: number;
  verticesIn: number;
  verticesOut: number;
}

function triangleCount(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  if (idx) return Math.floor(idx.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.floor(pos.count / 3) : 0;
}

/**
 * Vertex-klasterlash dekimatsiyasi (skin atributlarini saqlaydi). `cell` — katak o'lchami (geometriya
 * fazosida). Indekssiz geometriya ham qabul qilinadi (indeks yasaladi). Guruhlar (`geometry.groups`) tashlanadi —
 * bo'ri primitivlari alohida meshlar, bitta material.
 */
export function clusterDecimateSkinned(src: THREE.BufferGeometry, cell: number): ClusterDecimateResult {
  const pos = src.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || !(cell > 0)) {
    return { geometry: src.clone(), trianglesIn: triangleCount(src), trianglesOut: triangleCount(src), verticesIn: pos?.count ?? 0, verticesOut: pos?.count ?? 0 };
  }
  const nV = pos.count;
  const srcIndex = src.getIndex();
  const nTri = srcIndex ? Math.floor(srcIndex.count / 3) : Math.floor(nV / 3);
  const triIdx = (k: number): number => (srcIndex ? srcIndex.getX(k) : k);

  // 1) Katak kaliti → vakil vertex (birinchi), katak yig'indisi (o'rtacha pozitsiya uchun)
  const inv = 1 / cell;
  const repOf = new Int32Array(nV);
  const cellByKey = new Map<string, number>();
  const reps: number[] = [];
  const sumX: number[] = [];
  const sumY: number[] = [];
  const sumZ: number[] = [];
  const cnt: number[] = [];
  for (let v = 0; v < nV; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const key = `${Math.floor(x * inv)},${Math.floor(y * inv)},${Math.floor(z * inv)}`;
    let c = cellByKey.get(key);
    if (c === undefined) {
      c = reps.length;
      cellByKey.set(key, c);
      reps.push(v);
      sumX.push(0);
      sumY.push(0);
      sumZ.push(0);
      cnt.push(0);
    }
    repOf[v] = c;
    sumX[c]! += x;
    sumY[c]! += y;
    sumZ[c]! += z;
    cnt[c]! += 1;
  }

  // 2) Uchburchaklar: klaster indekslariga; degenerat va takrorlar tashlanadi
  const outTris: number[] = [];
  const seen = new Set<string>();
  const used = new Int32Array(reps.length).fill(-1);
  let nOut = 0;
  for (let tIdx = 0; tIdx < nTri; tIdx++) {
    const a = repOf[triIdx(tIdx * 3)]!;
    const b = repOf[triIdx(tIdx * 3 + 1)]!;
    const c = repOf[triIdx(tIdx * 3 + 2)]!;
    if (a === b || b === c || a === c) continue;
    // Takror (bir xil uchlar to'plami, har qanday tartibda) — bir marta
    const lo = Math.min(a, b, c);
    const hi = Math.max(a, b, c);
    const mid = a + b + c - lo - hi;
    const key = `${lo},${mid},${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const r of [a, b, c]) {
      if (used[r] === -1) used[r] = nOut++;
    }
    outTris.push(used[a]!, used[b]!, used[c]!);
  }

  // 3) Atributlarni vakil vertexdan nusxalash (pozitsiya — katak o'rtachasi)
  const geo = new THREE.BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    const attr = src.getAttribute(name);
    if (!attr || (attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue;
    const ba = attr as THREE.BufferAttribute;
    const itemSize = ba.itemSize;
    const ArrayCtor = ba.array.constructor as new (n: number) => THREE.TypedArray;
    const out = new ArrayCtor(nOut * itemSize);
    for (let c = 0; c < reps.length; c++) {
      const o = used[c]!;
      if (o < 0) continue;
      const v = reps[c]!;
      if (name === 'position') {
        const k = cnt[c]!;
        out[o * 3] = sumX[c]! / k;
        out[o * 3 + 1] = sumY[c]! / k;
        out[o * 3 + 2] = sumZ[c]! / k;
        continue;
      }
      for (let i = 0; i < itemSize; i++) out[o * itemSize + i] = ba.array[v * itemSize + i]!;
    }
    const nb = new THREE.BufferAttribute(out, itemSize, ba.normalized);
    geo.setAttribute(name, nb);
  }
  geo.setIndex(nOut > 65535 ? new THREE.Uint32BufferAttribute(outTris, 1) : new THREE.Uint16BufferAttribute(outTris, 1));
  if (geo.getAttribute('normal')) {
    // O'rtachalangan pozitsiyalarda vakil normallar ozgina chetlanadi — normalizatsiya kifoya (silliq ko'rinish)
    const n = geo.getAttribute('normal') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < n.count; i++) {
      v.set(n.getX(i), n.getY(i), n.getZ(i));
      if (v.lengthSq() > 1e-12) v.normalize();
      n.setXYZ(i, v.x, v.y, v.z);
    }
  }
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return { geometry: geo, trianglesIn: nTri, trianglesOut: outTris.length / 3, verticesIn: nV, verticesOut: nOut };
}

/** Geometriya uchburchak soni (indeksli yoki indekssiz). */
export function geometryTriangleCount(geo: THREE.BufferGeometry | null | undefined): number {
  return geo ? triangleCount(geo) : 0;
}
