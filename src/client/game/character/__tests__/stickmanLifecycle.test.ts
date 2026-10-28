import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  getCharacterAssetDiagnostics,
  parseCharacterGlb,
  registerCharacterTemplateForTest,
  type CharacterAssetTemplate,
} from '../CharacterAssetRegistry';

// Stage 08B-CHAR-INTEGRATION — sub-agent D: coordinator adapter (Stickman) lifecycle in Node.
// Stickman draws canvas textures (name tag, flash) → a minimal `document` stub with a no-op 2D
// context is installed for this file only. `window` stays undefined, so the asset/weapon
// preloaders are no-ops and the template is injected via registerCharacterTemplateForTest.
// There is no procedural fallback body any more: until the GLB is ready the model renders nothing.

const GLB_PATH = fileURLToPath(
  new URL('../../../../../public/models/characters/camper_buddy_balanced_rigged.glb', import.meta.url),
);
const DT = 1 / 60;
const WEAPONS = ['rifle', 'pistol', 'shotgun', 'sniper'] as const;

function installDocumentStub(): () => void {
  const g = globalThis as { document?: unknown };
  const prev = g.document;
  const ctx2d: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'canvas') return undefined;
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'getImageData' || prop === 'createImageData') {
          return (...a: number[]) => ({ data: new Uint8ClampedArray(Math.max(4, (a[2] ?? 1) * (a[3] ?? 1) * 4)) });
        }
        if (typeof prop === 'string' && prop.startsWith('create')) return () => ({ addColorStop() {} });
        return () => undefined;
      },
      set: () => true,
    },
  );
  g.document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`stub: <${tag}> not supported`);
      return { width: 0, height: 0, style: {}, getContext: () => ctx2d, toDataURL: () => 'data:,' };
    },
    createElementNS: (_ns: string, tag: string) => (g.document as { createElement(t: string): unknown }).createElement(tag),
  };
  return () => {
    g.document = prev;
  };
}

function glbTemplate(): Promise<CharacterAssetTemplate> {
  const buf = readFileSync(GLB_PATH);
  return parseCharacterGlb(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** `root` ostidagi barcha Mesh/SkinnedMesh'lar soni (ism yorlig'i / olov Sprite hisobga olinmaydi). */
function countMeshes(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n++;
  });
  return n;
}

type StickmanCtor = typeof import('../../Stickman').Stickman;
type StickmanState = import('../../Stickman').StickmanState;

const alive = (speed: number, pitch = 0, extra: Partial<StickmanState> = {}): StickmanState => ({
  speed,
  onGround: true,
  pitch,
  alive: true,
  reloading: false,
  ...extra,
});

describe('BOSQICH 08B-CHAR — Stickman adapter hayot sikli (Node, document stub)', () => {
  let Stickman: StickmanCtor;
  let uninstall: () => void;
  let tpl: CharacterAssetTemplate;

  before(async () => {
    uninstall = installDocumentStub();
    registerCharacterTemplateForTest(null);
    Stickman = (await import('../../Stickman')).Stickman;
    tpl = await glbTemplate();
  });
  after(() => {
    registerCharacterTemplateForTest(null);
    uninstall();
  });

  it('1. Asset yuklanmaguncha root bo‘sh (pending); registry ready → buddy + kutib turgan qurol/jihoz; har 4 qurol; tirik/o‘lik/tirilish; dispose → liveInstances 0', async () => {
    const s = new Stickman('#e03a30');
    assert.equal(s.usesCharacterAsset(), false, 'yuklanishdan oldin buddy yo‘q');
    assert.equal(s.getCharacterDiagnostics().mode, 'pending');
    assert.equal(countMeshes(s.root), 0, 'zaxira tana yo‘q — GLB kelmaguncha hech qanday mesh chizilmaydi');
    s.setWeapon('rifle');
    s.setGear({ helmet: true, armor: true, grenades: 2, medkits: 1 });
    s.update(DT, alive(3));
    assert.equal(s.hasWeapon(), false, 'qurol so‘rovi saqlanadi, lekin model hali o‘rnatilmagan');
    assert.equal(countMeshes(s.root), 0, 'qurol/jihoz so‘rovi ham root’ga mesh qo‘shmaydi');
    // Anchorlar root ostida — muzzle o‘yinchi bilan birga yuradi, xarita markazida emas
    s.root.position.set(10, 0, -4);
    s.root.updateMatrixWorld(true);
    const pendingMuzzle = s.getMuzzleWorld(new THREE.Vector3());
    assert.ok(Math.abs(pendingMuzzle.x - 10) < 1 && Math.abs(pendingMuzzle.z + 4) < 1, 'pending muzzle root yonida');
    s.root.position.set(0, 0, 0);

    registerCharacterTemplateForTest(tpl);
    await flush();
    assert.equal(s.usesCharacterAsset(), true, 'ready bo‘lgach buddy');
    let d = getCharacterAssetDiagnostics();
    assert.equal(d.liveInstances, 1);
    const diag = s.getCharacterDiagnostics();
    assert.equal(diag.mode, 'buddy');
    assert.equal(diag.weapon, 'rifle', 'kutib turgan qurol hand socket’ga o‘rnatiladi');
    assert.equal(s.hasWeapon(), true);
    assert.ok(countMeshes(s.root) > 0, 'buddy skinned mesh + qurol + jihoz mesh’lari root ostida');
    let gearHelmet: THREE.Object3D | undefined;
    s.root.traverse((o) => {
      if (o.name === 'gear_helmet') gearHelmet = o;
    });
    assert.ok(gearHelmet?.visible, 'kutib turgan jihoz (kaska) suyakka ulanadi');
    let buddyRoot: THREE.Object3D | undefined;
    s.root.traverse((o) => {
      if (o.name === 'camper_buddy_instance') buddyRoot = o;
    });
    assert.ok(buddyRoot, 'buddy root Stickman.root ostida');

    const muzzle = new THREE.Vector3();
    for (const w of WEAPONS) {
      s.setWeapon(w);
      for (let i = 0; i < 20; i++) s.update(DT, alive(i < 10 ? 3 : 6.5, 0.3));
      s.root.updateMatrixWorld(true);
      const cd = s.getCharacterDiagnostics();
      assert.equal(cd.weapon, w);
      assert.ok(cd.gripWorld, `${w}: gripWorld`);
      s.getMuzzleWorld(muzzle);
      assert.ok(muzzle.toArray().every(Number.isFinite), `${w}: muzzle finite`);
      // muzzle in front of the character (root faces −Z) and at chest/head height
      assert.ok(muzzle.z < 0, `${w}: muzzle z ${muzzle.z.toFixed(3)} (−Z forward)`);
      assert.ok(muzzle.y > 0.9 && muzzle.y < 2.0, `${w}: muzzle y ${muzzle.y.toFixed(3)}`);
      const wsum = Object.values(cd.weights).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(wsum - 1) < 1e-4, `${w}: Σweights ${wsum}`);
    }
    s.setWeapon(null);
    s.update(DT, alive(0));
    assert.equal(s.getCharacterDiagnostics().weapon, null);
    s.setWeapon('rifle');

    // death (frozen skeleton + whole-body pivot fall) → revive
    s.triggerDeath(false, 'rifle');
    for (let i = 0; i < 90; i++) s.update(DT, { ...alive(0), alive: false });
    assert.equal(s.usesCharacterAsset(), true);
    for (let i = 0; i < 10; i++) s.update(DT, alive(0));
    const rd = s.getCharacterDiagnostics();
    assert.equal(rd.state, 'Idle', 'tirilgandan keyin Idle');
    assert.equal(rd.weights.Idle, 1);

    s.setColor('#2e75e8');
    s.setCameraProximityFade(0.3);
    s.setCameraProximityFade(5);
    s.playInteract();
    s.update(DT, alive(0));
    assert.equal(s.getCharacterDiagnostics().state, 'Interact');

    s.dispose();
    d = getCharacterAssetDiagnostics();
    assert.equal(d.liveInstances, 0, 'dispose → liveInstances 0');
    assert.equal(d.disposedInstances, 1);
    assert.equal(s.usesCharacterAsset(), false);
  });

  it('2. Asset allaqachon tayyor: N=8 Stickman (microtask’da buddy), har biri alohida skelet; dispose → 0', async () => {
    registerCharacterTemplateForTest(tpl);
    const all = Array.from({ length: 8 }, (_, i) => new Stickman(i % 2 ? '#e03a30' : '#2e75e8'));
    await flush();
    assert.ok(all.every((s) => s.usesCharacterAsset()));
    assert.equal(getCharacterAssetDiagnostics().liveInstances, 8);
    all.forEach((s, i) => {
      s.setWeapon(WEAPONS[i % 4]);
      for (let f = 0; f < 15; f++) s.update(DT, alive(i, 0.1 * (i - 4)));
    });
    const states = new Set(all.map((s) => s.getCharacterDiagnostics().state));
    assert.ok(states.size >= 2, `turli tezlik → turli holatlar: ${[...states].join(',')}`);
    for (const s of all) s.dispose();
    assert.equal(getCharacterAssetDiagnostics().liveInstances, 0);
  });

  it('3. Ready’dan oldin dispose qilingan Stickman buddy olmaydi (listener bekor qilinadi, oqish yo‘q)', async () => {
    registerCharacterTemplateForTest(null);
    const s = new Stickman('#e03a30');
    s.dispose();
    registerCharacterTemplateForTest(tpl);
    await flush();
    assert.equal(s.usesCharacterAsset(), false);
    assert.equal(getCharacterAssetDiagnostics().createdInstances, 0);
    assert.equal(getCharacterAssetDiagnostics().liveInstances, 0);
  });

  it('4. Asset xatosi → model pending (bo‘sh) qoladi, update/setWeapon/o‘lim/dispose xatosiz', async () => {
    registerCharacterTemplateForTest(null);
    const bad = await glbTemplate();
    bad.clips = bad.clips.filter((c) => c.name !== 'Run');
    const { validateCharacterTemplate } = await import('../CharacterAssetRegistry');
    bad.validation = validateCharacterTemplate(bad.scene, bad.clips);
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      registerCharacterTemplateForTest(bad);
    } finally {
      console.warn = origWarn;
    }
    const s = new Stickman('#e03a30');
    await flush();
    assert.equal(s.usesCharacterAsset(), false);
    assert.equal(countMeshes(s.root), 0, 'xato holatida ham zaxira tana chizilmaydi');
    for (const w of WEAPONS) {
      s.setWeapon(w);
      s.update(DT, alive(3));
      assert.equal(s.hasWeapon(), false);
    }
    s.setCrouch(true);
    s.update(DT, alive(0));
    s.setCameraProximityFade(0.3);
    s.playInteract();
    s.triggerDeath(true);
    s.update(DT, { ...alive(0), alive: false });
    s.update(DT, alive(0));
    assert.equal(s.getCharacterDiagnostics().mode, 'pending');
    assert.equal(countMeshes(s.root), 0);
    s.dispose();
    assert.equal(getCharacterAssetDiagnostics().liveInstances, 0);
    assert.equal(getCharacterAssetDiagnostics().createdInstances, 0);
  });
});
