import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import * as THREE from 'three';
import {
  WOLF_COAT_BLACK,
  WOLF_COAT_CHARCOAL,
  WOLF_COAT_RED,
  WOLF_COAT_TAN,
  WOLF_COAT_WHITE,
} from '../../../shared/wolf/contracts';
import { footstepDistanceGain } from '../Audio';
import { parseWolfGlb, registerWolfTemplateForTest, type WolfAssetTemplate } from '../wolf/WolfAssetRegistry';
import { WolfModel } from '../wolf/WolfModel';
import { WOLF_LOD1_DIST_M, WOLF_LOD2_DIST_M } from '../wolf/wolfLod';
import {
  WOLF_STEALTH_EYE_FAR,
  WOLF_STEALTH_EYE_FAR_M,
  WOLF_STEALTH_EYE_NEAR,
  WOLF_STEALTH_EYE_NEAR_M,
  WOLF_STEALTH_FUR_TINT,
  wolfHowlRevealsPosition,
  wolfStealthEyeGlow,
} from '../wolf/wolfStealth';
import { WOLF_STEALTH_AUDIO_MUL, wolfAudioRangeMul } from '../wolf/wolfThreat';

// "Tun soyasi" (qora bo'ri) qorong'ida yaxshi yashirinadi: ko'zlari xira (faqat yaqinda ko'rinadi, barcha LOD larda),
// mo'ynasi to'qroq, uvlashi HUD/mini-xaritada joyini ko'rsatmaydi, panja tovushi nafasidek faqat yaqindan eshitiladi.
// Boshqa coat larning (umumiy, keshlangan) materiallari o'zgarmaydi.

/** GLB dagi oddiy bo'ri ko'zi yorqinligi (KHR_materials_emissive_strength). */
const NORMAL_EYE_EMISSIVE = 4;
const IDLE = { state: 'idle' as const, speed: 0 };

function eyeMaterialsOf(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const out = new Set<THREE.MeshStandardMaterial>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (m instanceof THREE.MeshStandardMaterial && m.emissive.getHex() !== 0) out.add(m);
    }
  });
  return [...out];
}

/** Soxta shablon: tana (wolf_main) + ko'zlar (wolf_eyes, emissive 4) — oddiy meshlar. */
function fakeTemplate(): { tpl: WolfAssetTemplate; eyes: THREE.MeshStandardMaterial; fur: THREE.MeshStandardMaterial } {
  const scene = new THREE.Group();
  const fur = new THREE.MeshStandardMaterial({ name: 'wolf_main', color: '#ffffff', roughness: 0.85 });
  const eyes = new THREE.MeshStandardMaterial({ name: 'wolf_eyes', emissive: '#ffb020', emissiveIntensity: NORMAL_EYE_EMISSIVE });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 1.4), fur));
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), eyes));
  return {
    eyes,
    fur,
    tpl: { scene, clips: [], validation: { ok: true, clips: [], joints: 24, sockets: [], triangles: 0, errors: [] } },
  };
}

describe("'Tun soyasi' — ko'z yorqinligi va uvlash belgisi (sof funksiyalar)", () => {
  it("1. wolfStealthEyeGlow: yaqinda NEAR, uzoqda FAR, oraliqda kamayib boradi; oddiy ko'zdan ancha xira", () => {
    assert.ok(WOLF_STEALTH_EYE_NEAR <= NORMAL_EYE_EMISSIVE / 3, 'yaqinda ham oddiy ko‘zdan kamida 3 barobar xira');
    assert.ok(WOLF_STEALTH_EYE_FAR < WOLF_STEALTH_EYE_NEAR / 4, 'uzoqda deyarli ko‘rinmaydi');
    assert.equal(wolfStealthEyeGlow(0), WOLF_STEALTH_EYE_NEAR);
    assert.equal(wolfStealthEyeGlow(WOLF_STEALTH_EYE_NEAR_M), WOLF_STEALTH_EYE_NEAR);
    assert.equal(wolfStealthEyeGlow(WOLF_STEALTH_EYE_FAR_M), WOLF_STEALTH_EYE_FAR);
    assert.equal(wolfStealthEyeGlow(200), WOLF_STEALTH_EYE_FAR);
    let prev = Infinity;
    for (let d = 0; d <= 30; d += 0.5) {
      const g = wolfStealthEyeGlow(d);
      assert.ok(g <= prev + 1e-9, `${d} m da kamaymaydi`);
      assert.ok(g >= WOLF_STEALTH_EYE_FAR - 1e-9 && g <= WOLF_STEALTH_EYE_NEAR + 1e-9);
      prev = g;
    }
    // Noma'lum masofa — xira (yangi model bir kadr ham yorqin ko'z bilan chiqmasin)
    assert.equal(wolfStealthEyeGlow(NaN), WOLF_STEALTH_EYE_FAR);
    assert.equal(wolfStealthEyeGlow(Infinity), WOLF_STEALTH_EYE_FAR);
  });

  it("2. wolfHowlRevealsPosition: soya uvlashi HUD/mini-xaritada belgilanmaydi, qolganlari — belgilanadi", () => {
    assert.equal(wolfHowlRevealsPosition(WOLF_COAT_BLACK), false);
    for (const c of [WOLF_COAT_CHARCOAL, WOLF_COAT_RED, WOLF_COAT_TAN, WOLF_COAT_WHITE, undefined, 42]) {
      assert.equal(wolfHowlRevealsPosition(c), true, `coat ${c}`);
    }
  });
});

describe("'Tun soyasi' — panja tovushi masofasi (footstepDistanceGain)", () => {
  it('1. Oddiy qadam avvalgidek: 3 m gacha to‘liq, 30 m dan nari jim, oraliqda kvadratik', () => {
    const old = (d: number) => (d > 30 ? 0 : (1 - Math.max(0, d - 3) / 27) ** 2);
    for (const d of [0, 2, 3, 5, 10, 16, 20, 29.9, 30, 31, 60]) {
      assert.ok(Math.abs(footstepDistanceGain(d) - old(d)) < 1e-12, `${d} m`);
    }
  });

  it("2. Soya panjalari nafasidek faqat yaqindan: ~13.5 m dan nari jim (oddiy bo'riniki eshitiladi)", () => {
    const mul = wolfAudioRangeMul(WOLF_COAT_BLACK);
    assert.equal(mul, WOLF_STEALTH_AUDIO_MUL);
    const max = 30 * mul;
    // Soya nafasi 35 m × mul ≈ 15.8 m gacha — panja tovushi undan uzoqqa ketmasin
    assert.ok(max < 35 * mul);
    for (const d of [max + 0.1, 14, 16, 20, 29]) {
      assert.equal(footstepDistanceGain(d, mul), 0, `soya ${d} m`);
      assert.ok(footstepDistanceGain(d, wolfAudioRangeMul(WOLF_COAT_CHARCOAL)) > 0, `oddiy ${d} m`);
    }
    assert.ok(footstepDistanceGain(5, mul) > 0, 'yaqinda eshitiladi');
    assert.equal(footstepDistanceGain(1, mul), 1);
    assert.ok(footstepDistanceGain(8, mul) < footstepDistanceGain(8), 'bir xil masofada sokinroq');
  });
});

describe("'Tun soyasi' — WolfModel materiallari (soxta shablon)", () => {
  afterEach(() => registerWolfTemplateForTest(null));

  it("1. Soya o'z ko'z/mo'yna klonlarini oladi; shablon (umumiy) materiallari va oddiy bo'riniki o'zgarmaydi", () => {
    const t = fakeTemplate();
    // Ikkala coat bitta shablonni bo'lishadi — soya uni o'zgartirsa oddiy bo'ri ham xiralashib qolardi
    registerWolfTemplateForTest(t.tpl, WOLF_COAT_BLACK);
    registerWolfTemplateForTest(t.tpl, WOLF_COAT_CHARCOAL);
    const black = new WolfModel(WOLF_COAT_BLACK);
    const grey = new WolfModel(WOLF_COAT_CHARCOAL);
    try {
      assert.ok(black.usesAsset() && grey.usesAsset());
      assert.equal(black.stealthy, true);
      assert.equal(grey.stealthy, false);
      black.update(1 / 60, IDLE, 30);
      grey.update(1 / 60, IDLE, 30);
      assert.equal(t.eyes.emissiveIntensity, NORMAL_EYE_EMISSIVE, 'shablon ko‘zi o‘zgarmadi');
      assert.equal(t.fur.color.getHex(), 0xffffff, 'shablon mo‘ynasi o‘zgarmadi');
      assert.deepEqual(eyeMaterialsOf(grey.root), [t.eyes], 'oddiy bo‘ri shablon materialini ishlatadi');
      const [bEye, ...more] = eyeMaterialsOf(black.root);
      assert.equal(more.length, 0);
      assert.notEqual(bEye, t.eyes, 'soya — o‘z klonida');
      assert.equal(bEye!.emissiveIntensity, WOLF_STEALTH_EYE_FAR);
      black.update(1 / 60, IDLE, 2);
      assert.equal(bEye!.emissiveIntensity, WOLF_STEALTH_EYE_NEAR, 'yaqinda biroz ko‘rinadi');
      assert.equal(t.eyes.emissiveIntensity, NORMAL_EYE_EMISSIVE);
      // Mo'yna: to'qroq va xira (vertex ranglar ustidan ko'paytuvchi)
      let furClone: THREE.MeshStandardMaterial | null = null;
      black.root.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m instanceof THREE.MeshStandardMaterial && m.name === 'wolf_main') furClone = m;
      });
      assert.ok(furClone && furClone !== t.fur);
      const fc = furClone as THREE.MeshStandardMaterial;
      assert.ok(Math.abs(fc.color.r - WOLF_STEALTH_FUR_TINT) < 1e-6, `mo‘yna rangi ${fc.color.r}`);
      assert.equal(fc.roughness, 1);
    } finally {
      black.dispose();
      grey.dispose();
    }
  });

  it("2. GLB kelguncha zaxira modelning ko'zlari ham xira (to'da boshlig'iniki — yorqin)", () => {
    const black = new WolfModel(WOLF_COAT_BLACK);
    const alpha = new WolfModel(WOLF_COAT_WHITE);
    try {
      assert.equal(black.usesAsset(), false);
      const [eye] = eyeMaterialsOf(black.root);
      assert.ok(eye);
      assert.equal(eye.emissiveIntensity, WOLF_STEALTH_EYE_FAR, 'birinchi kadrgacha ham xira');
      black.update(1 / 60, IDLE, 1);
      assert.equal(eye.emissiveIntensity, WOLF_STEALTH_EYE_NEAR);
      const [aEye] = eyeMaterialsOf(alpha.root);
      alpha.update(1 / 60, IDLE, 30);
      assert.ok(aEye && aEye.emissiveIntensity > WOLF_STEALTH_EYE_NEAR * 3, 'boshliq ko‘zlari xiralashmaydi');
    } finally {
      black.dispose();
      alpha.dispose();
    }
  });

  it("3. Zaxiradan GLB ga o'tganda xira ko'z saqlanadi; dispose klonlarni tozalaydi", () => {
    const black = new WolfModel(WOLF_COAT_BLACK);
    try {
      black.update(1 / 60, IDLE, 25);
      const t = fakeTemplate();
      registerWolfTemplateForTest(t.tpl, WOLF_COAT_BLACK);
      // Shablon ro'yxatga olinganda kutayotgan model darhol (sinxron, onWolfAssetReady) GLB nusxasiga o'tadi
      assert.equal(black.usesAsset(), true);
      const eyes = eyeMaterialsOf(black.root);
      assert.equal(eyes.length, 1);
      assert.notEqual(eyes[0], t.eyes);
      assert.equal(eyes[0]!.emissiveIntensity, wolfStealthEyeGlow(25), 'oxirgi kamera masofasi bo‘yicha');
      let disposed = 0;
      eyes[0]!.addEventListener('dispose', () => disposed++);
      black.dispose();
      assert.equal(disposed, 1, 'klon dispose qilindi');
      assert.equal(t.eyes.emissiveIntensity, NORMAL_EYE_EMISSIVE);
    } finally {
      black.dispose();
    }
  });
});

const GLB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../public/models/characters');
const BLACK_GLB = resolve(GLB_DIR, 'feral_wolf_black_rigged.glb');
const CHARCOAL_GLB = resolve(GLB_DIR, 'feral_wolf_rigged.glb');

async function loadGlb(path: string): Promise<WolfAssetTemplate> {
  const buf = readFileSync(path);
  return parseWolfGlb(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

describe(
  "'Tun soyasi' — haqiqiy GLB, barcha LOD darajalari",
  { skip: !existsSync(BLACK_GLB) || !existsSync(CHARCOAL_GLB) },
  () => {
    afterEach(() => registerWolfTemplateForTest(null));

    it("1. Ko'zlar LOD0/LOD1 da xira, LOD2 da yo'q; qayta yaqinlashganda ham xira; oddiy bo'ri ko'zi 4", async () => {
      const blackTpl = await loadGlb(BLACK_GLB);
      const greyTpl = await loadGlb(CHARCOAL_GLB);
      assert.ok(blackTpl.validation.ok && greyTpl.validation.ok);
      registerWolfTemplateForTest(blackTpl, WOLF_COAT_BLACK);
      registerWolfTemplateForTest(greyTpl, WOLF_COAT_CHARCOAL);
      const tplEyes = eyeMaterialsOf(blackTpl.scene);
      assert.equal(tplEyes.length, 1);
      const black = new WolfModel(WOLF_COAT_BLACK);
      const grey = new WolfModel(WOLF_COAT_CHARCOAL);
      try {
        const eyeMesh = (() => {
          let found: THREE.SkinnedMesh | null = null;
          black.root.traverse((o) => {
            const m = o as THREE.SkinnedMesh;
            if (m.isSkinnedMesh && (m.material as THREE.Material).name === 'wolf_eyes') found = m;
          });
          return found as THREE.SkinnedMesh | null;
        })();
        assert.ok(eyeMesh, "ko'z meshi");
        const eyeMat = eyeMesh.material as THREE.MeshStandardMaterial;
        assert.notEqual(eyeMat, tplEyes[0], 'soya ko‘zi — klon');
        const cases: [number, 0 | 1 | 2][] = [
          [3, 0],
          [WOLF_LOD1_DIST_M + 4, 1],
          [WOLF_LOD2_DIST_M + 5, 2],
          [3, 0],
        ];
        for (const [d, lod] of cases) {
          black.update(1 / 60, IDLE, d);
          grey.update(1 / 60, IDLE, d);
          assert.equal(black.lodLevel, lod, `${d} m → LOD${lod}`);
          assert.equal(eyeMesh.material, eyeMat, `LOD${lod}: material o'sha klon`);
          assert.equal(eyeMesh.visible, lod < 2, `LOD${lod}: ko'z ${lod < 2 ? 'ko‘rinadi' : 'yo‘q'}`);
          assert.equal(eyeMat.emissiveIntensity, wolfStealthEyeGlow(d));
          assert.ok(eyeMat.emissiveIntensity <= WOLF_STEALTH_EYE_NEAR);
        }
        assert.equal(tplEyes[0]!.emissiveIntensity, NORMAL_EYE_EMISSIVE, 'qora shablon ko‘zi o‘zgarmadi');
        const [gEye] = eyeMaterialsOf(grey.root);
        assert.equal(gEye!.emissiveIntensity, NORMAL_EYE_EMISSIVE, 'oddiy bo‘ri ko‘zi o‘zgarmadi');
      } finally {
        black.dispose();
        grey.dispose();
      }
    });
  },
);
