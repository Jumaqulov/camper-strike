import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { buildGun, buildProceduralGun } from '../../client/game/GunModels';
import {
  getCachedWeaponTemplate,
  getWeaponAssetDiagnostics,
  registerWeaponTemplateFromObject,
  WEAPON_GLB_URLS,
} from '../../client/game/WeaponAssetRegistry';
import { WorldWeaponItem } from '../../client/game/WorldWeaponItem';
import { WEAPON_SLOTS, type WeaponId } from '../weapons';

function parseGlbNodeNames(filePath: string): { nodeNames: string[]; materialNames: string[] } {
  const buf = fs.readFileSync(filePath);
  const magic = buf.readUInt32LE(0);
  assert.equal(magic, 0x46546c67, `${filePath} haqiqiy GLB fayli bo'lishi kerak`);
  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.readUInt32LE(16);
  assert.equal(jsonType, 0x4e4f534a, `${filePath} JSON chunkga ega bo'lishi kerak`);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as {
    nodes?: { name?: string }[];
    materials?: { name?: string }[];
  };
  return {
    nodeNames: (gltf.nodes ?? []).map((n) => n.name ?? ''),
    materialNames: (gltf.materials ?? []).map((m) => m.name ?? ''),
  };
}

function buildMockGlbHierarchy(weapon: WeaponId): THREE.Group {
  const root = new THREE.Group();
  root.name = `mock_${weapon}`;

  const addPart = (name: string, matName: string, w: number, h: number, d: number, z = 0) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshStandardMaterial({ name: matName, color: '#333333', metalness: 0.8, roughness: 0.3 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.position.set(0, 0, z);
    root.add(mesh);
  };

  addPart('receiver', 'metal', 0.05, 0.07, 0.25, -0.05);
  addPart('barrel', 'dark_metal', 0.02, 0.02, 0.45, -0.4);
  addPart('stock', 'wood', 0.04, 0.14, 0.28, 0.22);
  // Micro-detail mesh that should be omitted in 3P LOD
  addPart('rail_tooth_1', 'dark_metal', 0.02, 0.005, 0.006, -0.15);
  addPart('rail_tooth_2', 'dark_metal', 0.02, 0.005, 0.006, -0.17);

  if (weapon === 'pistol') {
    addPart('slide', 'metal', 0.028, 0.033, 0.19, -0.05);
    addPart('mag_base', 'dark_metal', 0.03, 0.01, 0.04, 0.04);
  } else if (weapon === 'shotgun') {
    addPart('pump', 'wood', 0.05, 0.048, 0.17, -0.3);
    addPart('pump_ring', 'wood_dark', 0.054, 0.05, 0.006, -0.28);
  } else if (weapon === 'rifle') {
    addPart('magazine', 'dark_metal', 0.032, 0.22, 0.14, -0.16);
    addPart('mag_floorplate', 'metal', 0.036, 0.02, 0.06, -0.2);
  } else if (weapon === 'sniper') {
    addPart('bolt_handle', 'metal', 0.05, 0.012, 0.012, 0.035);
    addPart('bolt_knob', 'dark_metal', 0.024, 0.024, 0.024, 0.035);
    addPart('magazine', 'dark_metal', 0.04, 0.07, 0.075, -0.09);
    addPart('scope_lens_front', 'lens', 0.045, 0.045, 0.004, -0.32);
  }

  return root;
}

describe('ASSET-01 — GLB qurol modellari, kesh, animatsiya qismlari va WorldWeaponItem', () => {
  it("public/models/weapons/ ichidagi to'rtta GLB fayli mavjud va kutilgan nomlangan qismlarga ega", () => {
    const publicDir = path.resolve(process.cwd(), 'public');
    const expectedParts: Record<WeaponId, string[]> = {
      rifle: ['receiver', 'barrel', 'magazine', 'stock'],
      pistol: ['slide', 'frame', 'muzzle', 'grip'],
      shotgun: ['receiver', 'barrel', 'pump', 'stock'],
      sniper: ['stock', 'receiver', 'bolt_handle', 'magazine'],
    };

    for (const w of WEAPON_SLOTS) {
      const relUrl = WEAPON_GLB_URLS[w].replace(/^\//, '');
      const fullPath = path.join(publicDir, relUrl);
      assert.ok(fs.existsSync(fullPath), `${fullPath} mavjud bo'lishi shart`);
      const { nodeNames, materialNames } = parseGlbNodeNames(fullPath);
      for (const reqPart of expectedParts[w]) {
        assert.ok(
          nodeNames.includes(reqPart),
          `${w} (${relUrl}) ichida '${reqPart}' obyekti topilishi kerak`,
        );
      }
      assert.ok(materialNames.length > 0);
    }
  });

  it('procedural fallback modellari barcha 4 qurol uchun xavfsiz ishlaydi', () => {
    for (const w of WEAPON_SLOTS) {
      const proc = buildProceduralGun(w);
      assert.ok(proc.group instanceof THREE.Group);
      assert.equal(proc.isGlb, false);
      assert.ok(proc.muzzle.z < -0.15);
    }
  });

  it('WeaponAssetRegistry GLB iyerarxiyasidan slide/pump/bolt_handle/magazine qismlarini ajratadi va 3P LOD uchburchaklarini kamaytiradi', () => {
    for (const w of WEAPON_SLOTS) {
      const mockScene = buildMockGlbHierarchy(w);
      const tpl = registerWeaponTemplateFromObject(w, mockScene);
      assert.ok(tpl);
      assert.ok(tpl.triangles3p < tpl.triangles1p, `${w} uchun 3P LOD uchburchaklar soni 1P dan kam bo'lishi kerak`);
      if (w === 'pistol' || w === 'shotgun' || w === 'sniper') {
        assert.equal(tpl.hasSlide, true);
      }
      if (w === 'rifle' || w === 'sniper' || w === 'pistol') {
        assert.equal(tpl.hasMag, true);
      }
    }

    const diag = getWeaponAssetDiagnostics();
    for (const w of WEAPON_SLOTS) {
      assert.equal(diag[w].loaded, true);
      assert.equal(diag[w].failed, false);
    }
  });

  it('kutilmagan / nomlanmagan iyerarxiya xatosiz (crashsiz) boshqariladi', () => {
    const unnamedRoot = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.5), new THREE.MeshStandardMaterial());
    unnamedRoot.add(m);

    const tpl = registerWeaponTemplateFromObject('rifle', unnamedRoot);
    assert.equal(tpl.hasSlide, false);
    assert.equal(tpl.hasMag, false);
    assert.ok(tpl.lod['1p'].staticSlices.length >= 1);

    // Asl mock shablonni qayta tiklaymiz
    registerWeaponTemplateFromObject('rifle', buildMockGlbHierarchy('rifle'));
  });

  it('buildGun() keshdagi bir xil BufferGeometry va Material obyektlarini qayta ishlatadi', () => {
    const gunA = buildGun('sniper', '1p');
    const gunB = buildGun('sniper', '1p');
    assert.equal(gunA.isGlb, true);
    assert.equal(gunB.isGlb, true);

    const meshesA: THREE.Mesh[] = [];
    const meshesB: THREE.Mesh[] = [];
    gunA.group.traverse((o) => {
      if (o instanceof THREE.Mesh) meshesA.push(o);
    });
    gunB.group.traverse((o) => {
      if (o instanceof THREE.Mesh) meshesB.push(o);
    });

    assert.equal(meshesA.length, meshesB.length);
    for (let i = 0; i < meshesA.length; i++) {
      assert.equal(meshesA[i].geometry, meshesB[i].geometry, 'BufferGeometry qayta ishlatilishi shart');
      assert.equal(meshesA[i].material, meshesB[i].material, 'Material qayta ishlatilishi shart');
    }
  });

  it('WorldWeaponItem kelajakdagi loot tizimi uchun 3P modelni yaratadi va umumiy keshni buzmasdan tozalanadi', () => {
    const item = new WorldWeaponItem({
      weapon: 'shotgun',
      position: new THREE.Vector3(4, 0, -6),
      yaw: 0.75,
      pose: 'flat',
      highlighted: true,
    });

    assert.equal(item.weapon, 'shotgun');
    assert.equal(item.isHighlighted(), true);
    item.setHighlighted(false);
    assert.equal(item.isHighlighted(), false);

    item.applyPose('display');
    item.update(0.16);
    item.dispose();

    const tpl = getCachedWeaponTemplate('shotgun');
    assert.ok(tpl);
    assert.ok(tpl.lod['3p'].staticSlices[0].geometry.attributes.position.count > 0);
  });
});
