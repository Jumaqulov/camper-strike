import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  CAMPER_BUDDY_CLIPS,
  CAMPER_BUDDY_JOINTS,
  CAMPER_BUDDY_SOCKETS,
  getCharacterAssetDiagnostics,
  hasCharacterAssetFailed,
  instantiateCamperBuddy,
  isCharacterAssetReady,
  onCharacterAssetReady,
  parseCharacterGlb,
  preloadCharacterAssets,
  registerCharacterTemplateForTest,
  validateCharacterTemplate,
  type CamperBuddyInstance,
  type CharacterAssetTemplate,
} from '../CharacterAssetRegistry';
import { CamperBuddyAnimator } from '../../animation/CamperBuddyAnimator';

// Stage 08B-CHAR-INTEGRATION — sub-agent D: Camper Buddy GLB + asset registry tests

const GLB_PATH = fileURLToPath(
  new URL('../../../../../public/models/characters/camper_buddy_balanced_rigged.glb', import.meta.url),
);
const GLB_SHA256 = 'a898d979d5449a06da66e1b7208cb3a9571d8eed0d3dcbbf77842b3acf9be379';
const GLB_BYTES = 610972;

const glbBuffer = readFileSync(GLB_PATH);

/** Standalone ArrayBuffer copy (Node Buffers share a pooled ArrayBuffer). */
function glbArrayBuffer(): ArrayBuffer {
  return glbBuffer.buffer.slice(glbBuffer.byteOffset, glbBuffer.byteOffset + glbBuffer.byteLength) as ArrayBuffer;
}

/** Fresh, independent template each call (tests below mutate some of them). */
function loadTemplate(): Promise<CharacterAssetTemplate> {
  return parseCharacterGlb(glbArrayBuffer());
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

function skinnedMeshesOf(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh);
  });
  return out;
}

function materialByName(root: THREE.Object3D, name: string): THREE.Material {
  for (const m of skinnedMeshesOf(root)) {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (mat.name === name) return mat;
  }
  throw new Error(`material ${name} not found`);
}

function snapshotPose(inst: CamperBuddyInstance): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [name, bone] of inst.bones) {
    out.set(name, [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]);
  }
  return out;
}

function poseDelta(a: Map<string, number[]>, b: Map<string, number[]>): number {
  let max = 0;
  for (const [k, va] of a) {
    const vb = b.get(k)!;
    for (let i = 0; i < va.length; i++) max = Math.max(max, Math.abs(va[i] - vb[i]));
  }
  return max;
}

describe('BOSQICH 08B-CHAR — Camper Buddy GLB yaxlitligi (asset integrity)', () => {
  it('1. GLB fayli: aynan 610972 bayt va SHA-256 a898d979…f9be379', () => {
    assert.equal(glbBuffer.byteLength, GLB_BYTES, 'GLB hajmi o‘zgarmagan bo‘lishi shart');
    const sha = createHash('sha256').update(glbBuffer).digest('hex');
    assert.equal(sha, GLB_SHA256, 'GLB SHA-256 kontraktdagi bilan mos bo‘lishi shart');
    // glTF binary header: magic 'glTF', version 2
    assert.equal(glbBuffer.toString('ascii', 0, 4), 'glTF');
    assert.equal(glbBuffer.readUInt32LE(4), 2);
    assert.equal(glbBuffer.readUInt32LE(8), GLB_BYTES, 'header length = file length');
  });

  it('2. parseCharacterGlb Node’da ishlaydi: validation ok, 7 clip (aniq nomlar), 22 joint, 4 socket, 2 SkinnedMesh, 11468 uchburchak', async () => {
    const t = await loadTemplate();
    const v = t.validation;
    assert.deepEqual(v.errors, [], `validation errors: ${v.errors.join('; ')}`);
    assert.equal(v.ok, true);
    assert.deepEqual([...v.clips].sort(), [...CAMPER_BUDDY_CLIPS].sort());
    assert.deepEqual(v.clips, ['Idle', 'Walk', 'Run', 'JumpStart', 'JumpAir', 'Land', 'Interact']);
    assert.equal(v.joints, 22);
    assert.deepEqual(v.sockets, ['Hand_R_Grip', 'Hand_L_Support', 'Head_Attach', 'Back_Attach']);
    assert.equal(v.skinnedMeshes, 2);
    assert.equal(v.triangles, 11468);

    // Joint names and socket parents match the contract
    const sk = skinnedMeshesOf(t.scene);
    assert.equal(sk.length, 2);
    const jointNames = new Set(sk.flatMap((m) => m.skeleton.bones.map((b) => b.name)));
    assert.deepEqual([...jointNames].sort(), [...CAMPER_BUDDY_JOINTS].sort());
    const parents: Record<string, string> = {
      Hand_R_Grip: 'Hand_R',
      Hand_L_Support: 'Hand_L',
      Head_Attach: 'Head',
      Back_Attach: 'Chest',
    };
    for (const s of CAMPER_BUDDY_SOCKETS) {
      const node = t.scene.getObjectByName(s);
      assert.ok(node, `socket ${s}`);
      assert.equal(node!.parent?.name, parents[s], `socket ${s} parent`);
      assert.ok(!(node as THREE.Bone).isBone, `socket ${s} plain node (not a skin joint)`);
    }
    // Materials: buddy_main (vertex colours) + buddy_team_color (MeshStandardMaterial)
    const main = materialByName(t.scene, 'buddy_main');
    assert.equal(main.vertexColors, true, 'buddy_main vertex colours');
    assert.ok(materialByName(t.scene, 'buddy_team_color') instanceof THREE.MeshStandardMaterial);
  });

  it('3. Clip davomiyliklari kontraktga mos (Idle 3.0, Walk 0.48, Run 0.46, JumpStart 0.4, JumpAir 0.6, Land 0.5, Interact 1.2)', async () => {
    const t = await loadTemplate();
    const expected: Record<string, number> = {
      Idle: 3.0,
      Walk: 0.48,
      Run: 0.46,
      JumpStart: 0.4,
      JumpAir: 0.6,
      Land: 0.5,
      Interact: 1.2,
    };
    for (const c of t.clips) {
      assert.ok(Math.abs(c.duration - expected[c.name]) < 1e-3, `${c.name} duration ${c.duration}`);
    }
  });

  it('4. Barcha clip’lar in-place: Hips gorizontal (X/Z) siljish diapazoni < 0.05 m, faqat Hips.position translation', async () => {
    const t = await loadTemplate();
    for (const clip of t.clips) {
      const posTracks = clip.tracks.filter((tr) => tr.name.endsWith('.position'));
      assert.deepEqual(
        posTracks.map((tr) => tr.name),
        ['Hips.position'],
        `${clip.name}: faqat Hips.position translation bo‘lishi shart`,
      );
      assert.ok(!clip.tracks.some((tr) => tr.name.startsWith('Root.position')), `${clip.name}: root motion yo‘q`);
      const v = posTracks[0].values;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < v.length; i += 3) {
        minX = Math.min(minX, v[i]);
        maxX = Math.max(maxX, v[i]);
        minZ = Math.min(minZ, v[i + 2]);
        maxZ = Math.max(maxZ, v[i + 2]);
      }
      assert.ok(maxX - minX < 0.05, `${clip.name}: Hips X range ${(maxX - minX).toFixed(4)} m`);
      assert.ok(maxZ - minZ < 0.05, `${clip.name}: Hips Z range ${(maxZ - minZ).toFixed(4)} m`);
      for (const tr of clip.tracks) {
        assert.ok(tr.values.every(Number.isFinite), `${clip.name}/${tr.name} finite values`);
      }
    }
  });

  it('5. Shablon tayyorlash: soya yoqilgan, frustum culling YOQILGAN, umumiy bounding sphere (markaz y=0.9, r=1.3)', async () => {
    const t = await loadTemplate();
    for (const m of skinnedMeshesOf(t.scene)) {
      assert.equal(m.castShadow, true);
      assert.equal(m.receiveShadow, true);
      assert.equal(m.frustumCulled, true, 'frustumCulled=false taqiqlangan');
      for (const s of [m.boundingSphere!, m.geometry.boundingSphere!]) {
        assert.ok(s, 'bounding sphere');
        assert.ok(s.radius >= 1.3 - 1e-6, `radius ${s.radius}`);
        assert.ok(Math.abs(s.center.y - 0.9) < 1e-6 && s.center.x === 0 && s.center.z === 0);
      }
    }
  });
});

describe('BOSQICH 08B-CHAR — Registry klon xavfsizligi (clone safety)', () => {
  let tpl: CharacterAssetTemplate;
  beforeEach(async () => {
    tpl = await loadTemplate();
    registerCharacterTemplateForTest(tpl);
  });

  it('6. N=6 instansiya: suyaklar (Bone) bir-biridan va shablondan ajratilgan, skeleton.bones o‘z root’iga tegishli', () => {
    assert.equal(isCharacterAssetReady(), true);
    const tplBones = new Set<THREE.Object3D>();
    tpl.scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) tplBones.add(o);
    });
    const insts = Array.from({ length: 6 }, () => instantiateCamperBuddy()!);
    const seen = new Set<THREE.Bone>();
    for (const inst of insts) {
      assert.ok(inst, 'instance');
      assert.equal(inst.bones.size, 22);
      assert.equal(inst.sockets.size, 4);
      assert.equal(inst.skinnedMeshes.length, 2);
      assert.equal(inst.clips.size, 7);
      for (const b of inst.bones.values()) {
        assert.ok(!seen.has(b), `bone ${b.name} ikki instansiyada bir xil obyekt`);
        assert.ok(!tplBones.has(b), `bone ${b.name} shablon suyagi`);
        seen.add(b);
      }
      const rootSet = new Set<THREE.Object3D>();
      inst.root.traverse((o) => rootSet.add(o));
      for (const m of inst.skinnedMeshes) {
        assert.equal(m.skeleton.bones.length, 22);
        for (const b of m.skeleton.bones) assert.ok(rootSet.has(b), `${b.name} skeleton bone not under own root`);
      }
      for (const s of inst.sockets.values()) assert.ok(rootSet.has(s), 'socket under own root');
      for (const name of CAMPER_BUDDY_SOCKETS) {
        const s = inst.sockets.get(name)!;
        assert.equal(s, inst.root.getObjectByName(name));
      }
    }
    assert.equal(seen.size, 6 * 22);
    for (const i of insts) i.dispose();
  });

  it('7. Bir instansiyani animatsiya qilish boshqasini bind pose’da qoldiradi; clip obyektlari o‘zgarmaydi', () => {
    const a = instantiateCamperBuddy()!;
    const b = instantiateCamperBuddy()!;
    const bBefore = snapshotPose(b);
    const aBefore = snapshotPose(a);
    const walk = a.clips.get('Walk')!;
    const walkValuesBefore = walk.tracks.map((t) => Float32Array.from(t.values));

    const mixer = new THREE.AnimationMixer(a.root);
    mixer.clipAction(walk).play();
    for (let i = 0; i < 20; i++) mixer.update(1 / 60);
    a.root.updateMatrixWorld(true);
    b.root.updateMatrixWorld(true);

    assert.ok(poseDelta(aBefore, snapshotPose(a)) > 0.01, 'A animatsiya bo‘lishi kerak');
    assert.equal(poseDelta(bBefore, snapshotPose(b)), 0, 'B bind pose’da qolishi shart');
    // Template bones untouched as well
    const tplHips = tpl.scene.getObjectByName('Hips')!;
    assert.deepEqual(tplHips.quaternion.toArray(), [0, 0, 0, 1]);
    // Clips are shared and immutable
    assert.equal(a.clips.get('Walk'), b.clips.get('Walk'));
    walk.tracks.forEach((t, i) => assert.deepEqual(Float32Array.from(t.values), walkValuesBefore[i]));

    mixer.stopAllAction();
    mixer.uncacheRoot(a.root);
    a.dispose();
    b.dispose();
  });

  it('8. Geometriya va buddy_main umumiy; team material har bir instansiyada alohida klon', () => {
    const tplMain = materialByName(tpl.scene, 'buddy_main');
    const tplTeam = materialByName(tpl.scene, 'buddy_team_color') as THREE.MeshStandardMaterial;
    const tplGeos = skinnedMeshesOf(tpl.scene).map((m) => m.geometry);
    const tplTeamColor = tplTeam.color.getHex();

    const a = instantiateCamperBuddy()!;
    const b = instantiateCamperBuddy()!;
    for (const inst of [a, b]) {
      assert.equal(inst.mainMaterial, tplMain, 'mainMaterial shablon bilan umumiy');
      assert.notEqual(inst.teamMaterial, tplTeam, 'teamMaterial klon bo‘lishi shart');
      assert.ok(inst.teamMaterial instanceof THREE.MeshStandardMaterial);
      assert.equal(inst.teamMaterial.name, 'buddy_team_color');
      inst.skinnedMeshes.forEach((m) => assert.ok(tplGeos.includes(m.geometry), 'geometriya umumiy'));
      const mats = inst.skinnedMeshes.map((m) => m.material as THREE.Material);
      assert.ok(mats.includes(inst.teamMaterial), 'teamMaterial meshga biriktirilgan');
      assert.ok(mats.includes(inst.mainMaterial));
    }
    assert.notEqual(a.teamMaterial, b.teamMaterial);
    assert.equal(a.skinnedMeshes[0].geometry, b.skinnedMeshes[0].geometry);
    assert.equal(a.skinnedMeshes[1].geometry, b.skinnedMeshes[1].geometry);

    a.teamMaterial.color.set('#ff0000');
    assert.equal(b.teamMaterial.color.getHex(), tplTeamColor, 'B rangi o‘zgarmasligi shart');
    assert.equal(tplTeam.color.getHex(), tplTeamColor, 'shablon rangi o‘zgarmasligi shart');
    a.dispose();
    b.dispose();
  });

  it('9. dispose(): idempotent, faqat team material klonini yo‘q qiladi (umumiy geometriya/buddy_main dispose qilinmaydi), hisoblagichlar to‘g‘ri', () => {
    const tplMain = materialByName(tpl.scene, 'buddy_main');
    const tplTeam = materialByName(tpl.scene, 'buddy_team_color');
    const disposed: string[] = [];
    const geos = skinnedMeshesOf(tpl.scene).map((m) => m.geometry);
    geos.forEach((g, i) => g.addEventListener('dispose', () => disposed.push(`geo${i}`)));
    tplMain.addEventListener('dispose', () => disposed.push('main'));
    tplTeam.addEventListener('dispose', () => disposed.push('tplTeam'));
    const d0 = getCharacterAssetDiagnostics();
    assert.equal(d0.state, 'ready');
    assert.equal(d0.liveInstances, 0);
    assert.equal(d0.createdInstances, 0);
    assert.equal(d0.disposedInstances, 0);
    assert.equal(d0.error, null);
    assert.equal(d0.validation?.ok, true);
    assert.equal(d0.url, '/models/characters/camper_buddy_balanced_rigged.glb');

    const a = instantiateCamperBuddy()!;
    const b = instantiateCamperBuddy()!;
    const c = instantiateCamperBuddy()!;
    a.teamMaterial.addEventListener('dispose', () => disposed.push('teamA'));
    let d = getCharacterAssetDiagnostics();
    assert.deepEqual([d.liveInstances, d.createdInstances, d.disposedInstances], [3, 3, 0]);

    a.dispose();
    a.dispose();
    a.dispose();
    d = getCharacterAssetDiagnostics();
    assert.deepEqual([d.liveInstances, d.createdInstances, d.disposedInstances], [2, 3, 1], 'idempotent dispose');
    assert.deepEqual(disposed, ['teamA'], 'faqat A team material klonini dispose qilish');

    b.dispose();
    c.dispose();
    c.dispose();
    d = getCharacterAssetDiagnostics();
    assert.deepEqual([d.liveInstances, d.createdInstances, d.disposedInstances], [0, 3, 3]);
    assert.ok(!disposed.includes('main') && !disposed.includes('geo0') && !disposed.includes('geo1'));
    assert.ok(!disposed.includes('tplTeam'));

    // The shared template still instantiates after everything was disposed
    const e = instantiateCamperBuddy();
    assert.ok(e);
    assert.equal(e!.mainMaterial, tplMain);
    e!.dispose();
  });

  it('10. Eski shablondan qolgan instansiyani qayta-ro‘yxatdan keyin dispose qilish yangi hisoblagichlarni buzmaydi', async () => {
    const old = instantiateCamperBuddy()!;
    registerCharacterTemplateForTest(await loadTemplate());
    old.dispose();
    const d = getCharacterAssetDiagnostics();
    assert.deepEqual([d.liveInstances, d.createdInstances, d.disposedInstances], [0, 0, 0]);
    const n = instantiateCamperBuddy()!;
    assert.equal(getCharacterAssetDiagnostics().liveInstances, 1);
    n.dispose();
    assert.equal(getCharacterAssetDiagnostics().liveInstances, 0);
  });
});

describe('BOSQICH 08B-CHAR — Xato holatlari va fallback (failure / fallback)', () => {
  beforeEach(() => registerCharacterTemplateForTest(null));

  async function expectFailed(mutate: (t: CharacterAssetTemplate) => void, errorRe: RegExp): Promise<void> {
    const t = await loadTemplate();
    mutate(t);
    t.validation = validateCharacterTemplate(t.scene, t.clips);
    assert.equal(t.validation.ok, false, 'validation must fail');
    assert.ok(
      t.validation.errors.some((e) => errorRe.test(e)),
      `kutilgan xato topilmadi: ${t.validation.errors.join('; ')}`,
    );

    let fired = 0;
    const unsub = onCharacterAssetReady(() => fired++);
    const origWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      registerCharacterTemplateForTest(t);
      registerCharacterTemplateForTest(t); // repeat registration must not fire either
    } finally {
      console.warn = origWarn;
    }
    await flushMicrotasks();

    assert.equal(hasCharacterAssetFailed(), true);
    assert.equal(isCharacterAssetReady(), false);
    assert.equal(instantiateCamperBuddy(), null, 'instantiate null qaytarishi shart');
    const d = getCharacterAssetDiagnostics();
    assert.equal(d.state, 'failed');
    assert.ok(d.error && d.error.includes('validation failed'), `error: ${d.error}`);
    assert.equal(d.validation?.ok, false);
    assert.deepEqual([d.liveInstances, d.createdInstances, d.disposedInstances], [0, 0, 0]);
    assert.equal(fired, 0, 'ready listener xatoda hech qachon chaqirilmasligi shart');
    assert.ok(warnings.length >= 1, 'bir marta ogohlantirish');
    // A listener added after failure must not fire either
    let late = 0;
    onCharacterAssetReady(() => late++);
    await flushMicrotasks();
    assert.equal(late, 0);
    unsub();
  }

  it('11. Clip yetishmasa (Interact olib tashlangan) → failed, instantiate null, listener chaqirilmaydi', async () => {
    await expectFailed((t) => {
      t.clips = t.clips.filter((c) => c.name !== 'Interact');
    }, /missing clip 'Interact'/);
  });

  it('12. Ortiqcha / noto‘g‘ri nomli clip → failed', async () => {
    await expectFailed((t) => {
      t.clips[0].name = 'idle';
    }, /unexpected clip 'idle'/);
  });

  it('13. Socket yetishmasa (Hand_R_Grip olib tashlangan) → failed', async () => {
    await expectFailed((t) => {
      t.scene.getObjectByName('Hand_R_Grip')!.removeFromParent();
    }, /missing socket 'Hand_R_Grip'/);
  });

  it('14. Joint soni noto‘g‘ri (23) → failed', async () => {
    await expectFailed((t) => {
      const extra = new THREE.Bone();
      extra.name = 'Tail';
      const m = skinnedMeshesOf(t.scene)[0];
      m.skeleton.bones.push(extra);
    }, /expected 22 joints, got 23/);
  });

  it('15. Joint nomi yo‘q (Hips qayta nomlangan) → failed', async () => {
    await expectFailed((t) => {
      t.scene.getObjectByName('Hips')!.name = 'Pelvis';
    }, /missing joint 'Hips'/);
  });

  it('16. SkinnedMesh soni noto‘g‘ri (bittasi olib tashlangan) → failed', async () => {
    await expectFailed((t) => {
      skinnedMeshesOf(t.scene)[1].removeFromParent();
    }, /expected 2 skinned meshes, got 1/);
  });

  it('17. registerCharacterTemplateForTest(null) → idle holatga to‘liq qaytish, eski listenerlar tozalanadi', async () => {
    let stale = 0;
    onCharacterAssetReady(() => stale++);
    registerCharacterTemplateForTest(null);
    const d = getCharacterAssetDiagnostics();
    assert.equal(d.state, 'idle');
    assert.equal(d.error, null);
    assert.equal(d.validation, null);
    assert.equal(d.loadMs, null);
    assert.equal(isCharacterAssetReady(), false);
    assert.equal(hasCharacterAssetFailed(), false);
    assert.equal(instantiateCamperBuddy(), null, 'idle holatda instantiate null');

    registerCharacterTemplateForTest(await loadTemplate());
    await flushMicrotasks();
    assert.equal(stale, 0, 'reset’dan oldingi listener chaqirilmasligi shart');
    registerCharacterTemplateForTest(null);
  });

  it('18. preloadCharacterAssets Node’da no-op: hech qachon reject qilmaydi, holat idle qoladi, idempotent', async () => {
    const p1 = preloadCharacterAssets();
    const p2 = preloadCharacterAssets();
    assert.equal(p1, p2, 'idempotent (bir xil promise)');
    await p1;
    assert.equal(getCharacterAssetDiagnostics().state, 'idle');
    assert.equal(instantiateCamperBuddy(), null);
  });

  it('19. Xatodan keyin to‘g‘ri shablon ro‘yxatdan o‘tsa → ready, kutayotgan listener bir marta chaqiriladi', async () => {
    const bad = await loadTemplate();
    bad.clips = bad.clips.slice(1);
    bad.validation = validateCharacterTemplate(bad.scene, bad.clips);
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      registerCharacterTemplateForTest(bad);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(hasCharacterAssetFailed(), true);
    registerCharacterTemplateForTest(null);
    let fired = 0;
    onCharacterAssetReady(() => fired++);
    registerCharacterTemplateForTest(await loadTemplate());
    registerCharacterTemplateForTest(await loadTemplate());
    await flushMicrotasks();
    assert.equal(fired, 1, 'listener aynan bir marta');
    assert.equal(getCharacterAssetDiagnostics().error, null);
  });
});

describe('BOSQICH 08B-CHAR — onCharacterAssetReady semantikasi', () => {
  it('20. Yuklanishdan oldin qo‘shilgan listener ready bo‘lganda sinxron bir marta; tayyor holatda — microtask’da; unsubscribe bekor qiladi', async () => {
    registerCharacterTemplateForTest(null);
    const calls: string[] = [];
    onCharacterAssetReady(() => calls.push('early'));
    const unsubEarly2 = onCharacterAssetReady(() => calls.push('early-unsub'));
    unsubEarly2();
    registerCharacterTemplateForTest(await loadTemplate());
    assert.deepEqual(calls, ['early'], 'ready bo‘lganda darhol');

    onCharacterAssetReady(() => calls.push('late'));
    assert.deepEqual(calls, ['early'], 'tayyor holatda sinxron emas (microtask)');
    const unsubLate = onCharacterAssetReady(() => calls.push('late-cancelled'));
    unsubLate();
    await flushMicrotasks();
    assert.deepEqual(calls, ['early', 'late']);

    // A throwing listener does not break others
    registerCharacterTemplateForTest(null);
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      onCharacterAssetReady(() => {
        throw new Error('boom');
      });
      onCharacterAssetReady(() => calls.push('after-throw'));
      registerCharacterTemplateForTest(await loadTemplate());
    } finally {
      console.warn = origWarn;
    }
    assert.ok(calls.includes('after-throw'));
    registerCharacterTemplateForTest(null);
  });
});

describe('BOSQICH 08B-CHAR — Xotira oqishi sikli (leak loop)', () => {
  it('21. 50× (instantiate → animator → kadrlar → animator.dispose → instance.dispose): liveInstances 0, mixer’da kesh qolmaydi', async () => {
    const tpl = await loadTemplate();
    registerCharacterTemplateForTest(tpl);
    const tplMain = materialByName(tpl.scene, 'buddy_main');
    let sharedDisposed = 0;
    tplMain.addEventListener('dispose', () => sharedDisposed++);
    skinnedMeshesOf(tpl.scene).forEach((m) => m.geometry.addEventListener('dispose', () => sharedDisposed++));

    const mixers: THREE.AnimationMixer[] = [];
    for (let i = 0; i < 50; i++) {
      const inst = instantiateCamperBuddy();
      assert.ok(inst, `iteration ${i}`);
      const anim = new CamperBuddyAnimator(inst!.root, inst!.clips);
      for (let f = 0; f < 30; f++) {
        anim.update(1 / 60, { speed: f < 10 ? 0 : f < 20 ? 3 : 6.5, onGround: f % 13 !== 0, alive: true });
      }
      if (i % 5 === 0) anim.playInteract();
      anim.update(1 / 60, { speed: 0, onGround: true, alive: true });
      const statsBefore = anim.mixer.stats.actions.total;
      assert.ok(statsBefore > 0 && statsBefore <= 7, `actions cached while alive: ${statsBefore}`);
      anim.dispose();
      anim.dispose(); // idempotent
      inst!.dispose();

      const mx = anim.mixer as unknown as {
        _actions: unknown[];
        _nActiveActions: number;
        _bindings: unknown[];
        _nActiveBindings: number;
        _actionsByClip: Record<string, unknown>;
        _bindingsByRootAndName: Record<string, unknown>;
      };
      assert.equal(anim.mixer.stats.actions.total, 0, 'stats.actions.total 0');
      assert.equal(anim.mixer.stats.actions.inUse, 0);
      assert.equal(anim.mixer.stats.bindings.total, 0, 'stats.bindings.total 0');
      assert.equal(mx._actions.length, 0, '_actions bo‘sh');
      assert.equal(mx._nActiveActions, 0);
      assert.equal(mx._bindings.length, 0, '_bindings bo‘sh');
      assert.equal(Object.keys(mx._actionsByClip).length, 0, '_actionsByClip bo‘sh');
      assert.equal(mx._bindingsByRootAndName[inst!.root.uuid], undefined);
      mixers.push(anim.mixer);
    }
    const d = getCharacterAssetDiagnostics();
    assert.equal(d.liveInstances, 0);
    assert.equal(d.createdInstances, 50);
    assert.equal(d.disposedInstances, 50);
    assert.equal(sharedDisposed, 0, 'umumiy resurslar dispose qilinmasligi shart');
    assert.equal(new Set(mixers).size, 50);
    // Template still pristine: no residual userData/children added by instances
    assert.equal(tpl.scene.getObjectByName('Hips')!.quaternion.w, 1);
    registerCharacterTemplateForTest(null);
  });
});

describe('BOSQICH 08B-CHAR — Skeleton ulashish (perf)', () => {
  it('19b. Instansiyadagi 2 ta SkinnedMesh bitta Skeleton’ni ulashadi (bone matritsalar kadrda 1 marta)', async () => {
    registerCharacterTemplateForTest(await loadTemplate());
    const a = instantiateCamperBuddy()!;
    const b = instantiateCamperBuddy()!;
    assert.equal(a.skinnedMeshes.length, 2);
    assert.equal(a.skinnedMeshes[0].skeleton, a.skinnedMeshes[1].skeleton, 'bitta instansiya — bitta Skeleton');
    assert.notEqual(a.skinnedMeshes[0].skeleton, b.skinnedMeshes[0].skeleton, 'instansiyalar Skeleton ulashmaydi');
    // bind() must keep the original bind matrices (both primitives share one glTF skin)
    for (const m of a.skinnedMeshes) {
      for (let i = 0; i < m.skeleton.boneInverses.length; i++) {
        assert.ok(m.skeleton.boneInverses[i].equals(b.skinnedMeshes[0].skeleton.boneInverses[i]));
      }
    }
    a.dispose();
    b.dispose();
    assert.equal(getCharacterAssetDiagnostics().liveInstances, 0);
    registerCharacterTemplateForTest(null);
  });
});
