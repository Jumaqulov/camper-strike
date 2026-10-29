import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { parseWolfGlb, wolfLodGeometriesFor, wolfLodTriangles } from '../wolf/WolfAssetRegistry';
import {
  WOLF_LOD1_DIST_M,
  WOLF_LOD2_DIST_M,
  WOLF_LOD_HYSTERESIS_M,
  WOLF_MIXER_HALF_DIST_M,
  WOLF_MIXER_OFF_DIST_M,
  WOLF_MIXER_QUARTER_DIST_M,
  WOLF_SHADOW_MAX_DIST_M,
  clusterDecimateSkinned,
  pickWolfLod,
  wolfCastsShadowAt,
  wolfMixerStride,
} from '../wolf/wolfLod';

// Bo'ri LOD: vertex-klasterlash dekimatsiyasi (skin atributlari saqlanadi) va masofa bo'yicha LOD tanlovi (gisterezis).

/** Sintetik skinlangan geometriya: sfera (indeksli) + skinIndex/skinWeight/color atributlari. */
function makeSkinnedSphere(radius = 1, w = 64, h = 32): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(radius, w, h);
  const n = g.getAttribute('position').count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Har vertex 2 suyakka bog'langan: indeks vertex bo'yicha (0..23), og'irliklar yig'indisi 1
    si[i * 4] = i % 24;
    si[i * 4 + 1] = (i + 7) % 24;
    sw[i * 4] = 0.7;
    sw[i * 4 + 1] = 0.3;
    col[i * 3] = 0.2;
    col[i * 3 + 1] = 0.4;
    col[i * 3 + 2] = 0.6;
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

function tris(g: THREE.BufferGeometry): number {
  return g.getIndex()!.count / 3;
}

describe("Bo'ri LOD — klaster dekimatsiya (clusterDecimateSkinned)", () => {
  it('1. Uchburchaklar kamayadi (kutilgan oraliqda), katak kattaroq — kamroq uchburchak', () => {
    const src = makeSkinnedSphere();
    const nIn = tris(src);
    const r1 = clusterDecimateSkinned(src, 0.12);
    const r2 = clusterDecimateSkinned(src, 0.25);
    assert.equal(r1.trianglesIn, nIn);
    assert.equal(r1.trianglesOut, tris(r1.geometry));
    assert.ok(r1.trianglesOut > 0 && r1.trianglesOut < nIn * 0.6, `LOD1 ${r1.trianglesOut}/${nIn}`);
    assert.ok(r1.trianglesOut > nIn * 0.03, 'juda ham kamaymaydi');
    assert.ok(r2.trianglesOut < r1.trianglesOut, `LOD2 ${r2.trianglesOut} < LOD1 ${r1.trianglesOut}`);
    assert.ok(r2.trianglesOut > 0);
    assert.ok(r1.verticesOut < r1.verticesIn);
    // Asl geometriya o'zgarmaydi
    assert.equal(tris(src), nIn);
  });

  it('2. skinIndex/skinWeight/color/normal saqlanadi: soni pozitsiya bilan teng, qiymatlar manbadan', () => {
    const src = makeSkinnedSphere();
    const { geometry } = clusterDecimateSkinned(src, 0.12);
    const pos = geometry.getAttribute('position');
    for (const name of ['normal', 'uv', 'color', 'skinIndex', 'skinWeight']) {
      const a = geometry.getAttribute(name);
      assert.ok(a, `${name} atributi bor`);
      assert.equal(a.count, pos.count, `${name} soni`);
      assert.equal(a.itemSize, src.getAttribute(name).itemSize, `${name} itemSize`);
    }
    const si = geometry.getAttribute('skinIndex');
    const sw = geometry.getAttribute('skinWeight');
    assert.ok(si.array instanceof Uint16Array, 'skinIndex turi saqlanadi (Uint16)');
    for (let i = 0; i < si.count; i++) {
      assert.ok(si.getX(i) >= 0 && si.getX(i) < 24, 'suyak indeksi diapazonda');
      assert.equal(si.getY(i), (si.getX(i) + 7) % 24, 'vakil vertexning juftligi (birinchi vertex atributlari)');
      const sum = sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i);
      assert.ok(Math.abs(sum - 1) < 1e-5, "og'irliklar yig'indisi 1");
    }
    const n = geometry.getAttribute('normal');
    for (let i = 0; i < n.count; i++) {
      const l = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      assert.ok(Math.abs(l - 1) < 1e-4, 'normal birlik uzunlikda');
    }
    const c = geometry.getAttribute('color');
    assert.ok(Math.abs(c.getZ(0) - 0.6) < 1e-6, 'rang nusxalandi');
  });

  it('3. Degenerat va takroriy uchburchak yo‘q; indekslar diapazonda', () => {
    const src = makeSkinnedSphere();
    const { geometry } = clusterDecimateSkinned(src, 0.12);
    const idx = geometry.getIndex()!;
    const nV = geometry.getAttribute('position').count;
    const pos = geometry.getAttribute('position');
    const seen = new Set<string>();
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t);
      const b = idx.getX(t + 1);
      const c = idx.getX(t + 2);
      assert.ok(a < nV && b < nV && c < nV, 'indeks diapazonda');
      assert.ok(a !== b && b !== c && a !== c, 'uchlar farqli');
      // Pozitsiyalar ham farqli (nol yuzali uchburchak yo'q)
      const d1 = Math.hypot(pos.getX(a) - pos.getX(b), pos.getY(a) - pos.getY(b), pos.getZ(a) - pos.getZ(b));
      const d2 = Math.hypot(pos.getX(b) - pos.getX(c), pos.getY(b) - pos.getY(c), pos.getZ(b) - pos.getZ(c));
      assert.ok(d1 > 1e-6 && d2 > 1e-6, 'uchlar bir nuqtada emas');
      const key = [a, b, c].sort((x, y) => x - y).join(',');
      assert.ok(!seen.has(key), 'takror uchburchak yo‘q');
      seen.add(key);
    }
  });

  it('4. Chegaraviy sfera manbaga yaqin (±15 %), markaz ±0.1', () => {
    const src = makeSkinnedSphere(1.0);
    const { geometry } = clusterDecimateSkinned(src, 0.12);
    assert.ok(geometry.boundingSphere, 'sfera hisoblangan');
    const r0 = src.boundingSphere!.radius;
    const r1 = geometry.boundingSphere!.radius;
    assert.ok(Math.abs(r1 - r0) / r0 < 0.15, `radius ${r1.toFixed(3)} vs ${r0.toFixed(3)}`);
    assert.ok(geometry.boundingSphere!.center.distanceTo(src.boundingSphere!.center) < 0.1);
  });

  it('5. Indekssiz geometriya ham ishlaydi; noto‘g‘ri katak (0) — nusxa, o‘zgarishsiz', () => {
    const src = makeSkinnedSphere().toNonIndexed();
    const nIn = src.getAttribute('position').count / 3;
    const r = clusterDecimateSkinned(src, 0.12);
    assert.equal(r.trianglesIn, nIn);
    assert.ok(r.trianglesOut > 0 && r.trianglesOut < nIn * 0.6);
    const same = clusterDecimateSkinned(src, 0);
    assert.equal(same.trianglesOut, nIn);
  });
});

describe("Bo'ri LOD — masofa bo'yicha tanlov (pickWolfLod, gisterezis) va mikser qadami", () => {
  it('6. Chegaralar: < 18 m LOD0, 18..40 LOD1, > 40 LOD2 (joriy 0 dan)', () => {
    assert.equal(pickWolfLod(0, 0), 0);
    assert.equal(pickWolfLod(WOLF_LOD1_DIST_M - 0.01, 0), 0);
    assert.equal(pickWolfLod(WOLF_LOD1_DIST_M, 0), 1);
    assert.equal(pickWolfLod(30, 0), 1);
    assert.equal(pickWolfLod(WOLF_LOD2_DIST_M, 0), 2);
    assert.equal(pickWolfLod(200, 0), 2);
    assert.equal(pickWolfLod(Number.NaN, 1), 1, 'noto‘g‘ri masofa — joriy daraja');
  });

  it('7. Gisterezis 2 m: chegara atrofida almashib turmaydi; yaqinlashganda chegara − 2 da qaytadi', () => {
    const h = WOLF_LOD_HYSTERESIS_M;
    assert.equal(h, 2);
    // 18 m dan uzoqlashdi → 1; 17 m ga qaytdi → hali 1; 15.9 → 0
    assert.equal(pickWolfLod(WOLF_LOD1_DIST_M - 1, 1), 1);
    assert.equal(pickWolfLod(WOLF_LOD1_DIST_M - h - 0.1, 1), 0);
    // LOD2 dan: 39 m → hali 2; 37.9 → 1; 15 → 0
    assert.equal(pickWolfLod(WOLF_LOD2_DIST_M - 1, 2), 2);
    assert.equal(pickWolfLod(WOLF_LOD2_DIST_M - h - 0.1, 2), 1);
    assert.equal(pickWolfLod(15, 2), 0);
    // LOD1 dan 40 → 2
    assert.equal(pickWolfLod(WOLF_LOD2_DIST_M, 1), 2);
    // Chegara ustida tebranish: 17.9 ↔ 18.1 — bir marta 1 ga o'tgach qoladi
    let cur = pickWolfLod(17.9, 0);
    assert.equal(cur, 0);
    cur = pickWolfLod(18.1, cur);
    assert.equal(cur, 1);
    cur = pickWolfLod(17.9, cur);
    assert.equal(cur, 1);
    cur = pickWolfLod(18.1, cur);
    assert.equal(cur, 1);
  });

  it('8. Soya 40 m gacha; mikser qadami 1 / 2 (70 m) / 4 (110 m) / 0 (160 m)', () => {
    assert.equal(wolfCastsShadowAt(10), true);
    assert.equal(wolfCastsShadowAt(WOLF_SHADOW_MAX_DIST_M - 0.1), true);
    assert.equal(wolfCastsShadowAt(WOLF_SHADOW_MAX_DIST_M), false);
    assert.equal(wolfMixerStride(0), 1);
    assert.equal(wolfMixerStride(WOLF_MIXER_HALF_DIST_M - 0.1), 1);
    assert.equal(wolfMixerStride(WOLF_MIXER_HALF_DIST_M), 2);
    assert.equal(wolfMixerStride(WOLF_MIXER_QUARTER_DIST_M), 4);
    assert.equal(wolfMixerStride(WOLF_MIXER_OFF_DIST_M), 0);
    assert.equal(wolfMixerStride(Number.NaN), 1);
  });
});

const GLB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../public/models/characters/feral_wolf_rigged.glb');

describe("Bo'ri LOD — haqiqiy GLB (feral_wolf_rigged.glb)", { skip: !existsSync(GLB_PATH) }, () => {
  it('9. parseWolfGlb LOD to‘plamini quradi: tana LOD1 ≈ 25–45 %, LOD2 ≈ 8–20 %; ko‘zlar LOD1 asl, LOD2 yo‘q', async () => {
    const buf = readFileSync(GLB_PATH);
    const tpl = await parseWolfGlb(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    assert.ok(tpl.validation.ok, tpl.validation.errors.join('; '));
    const meshes: THREE.SkinnedMesh[] = [];
    tpl.scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
    });
    assert.equal(meshes.length, 2);
    let body = 0;
    let eyes = 0;
    for (const m of meshes) {
      const set = wolfLodGeometriesFor(m.geometry);
      assert.ok(set, `${m.name} uchun LOD to'plami`);
      const [n0, n1, n2] = wolfLodTriangles(set);
      const mat = m.material as THREE.Material;
      if (mat.name === 'wolf_eyes') {
        eyes++;
        assert.equal(set[1], set[0], 'ko‘zlar LOD1 — asl geometriya');
        assert.equal(set[2], null, 'ko‘zlar LOD2 — yo‘q');
        assert.equal(n2, 0);
      } else {
        body++;
        assert.ok(n0 > 10000, `tana LOD0 ${n0}`);
        assert.ok(n1 / n0 > 0.25 && n1 / n0 < 0.45, `tana LOD1 ${n1}/${n0} = ${((100 * n1) / n0).toFixed(1)} %`);
        assert.ok(n2 / n0 > 0.08 && n2 / n0 < 0.2, `tana LOD2 ${n2}/${n0} = ${((100 * n2) / n0).toFixed(1)} %`);
        for (const g of [set[1], set[2]!]) {
          assert.ok(g.getAttribute('skinIndex') && g.getAttribute('skinWeight'), 'skin atributlari');
          assert.equal(g.getAttribute('skinIndex').count, g.getAttribute('position').count);
          assert.ok(g.boundingSphere && g.boundingSphere.radius > 1.5, 'culling sferasi (saxiy) qo‘yilgan');
        }
      }
    }
    assert.equal(body, 1);
    assert.equal(eyes, 1);
  });
});
