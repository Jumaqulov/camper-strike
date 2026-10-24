import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GCProfiler } from 'node:v8';
import * as THREE from 'three';
import {
  instantiateCamperBuddy,
  parseCharacterGlb,
  registerCharacterTemplateForTest,
  type CamperBuddyInstance,
} from '../CharacterAssetRegistry';
import { CamperBuddyAnimator } from '../../animation/CamperBuddyAnimator';

// Stage 08B-CHAR-INTEGRATION — sub-agent D: agent C modules (aim pose, weapon mount, team material).
// Each suite is skipped while its module does not exist yet.

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const GLB_PATH = here('../../../../../public/models/characters/camper_buddy_balanced_rigged.glb');
const AIM_PATH = here('../CharacterAimPose.ts');
const MOUNT_PATH = here('../CharacterWeaponMount.ts');
const MAT_PATH = here('../CharacterMaterials.ts');
const DT = 1 / 60;
const WEAPONS = ['rifle', 'pistol', 'shotgun', 'sniper'] as const;
const AIM_BONES = ['Spine', 'Chest', 'Neck', 'Head'];
const ARM_BONES = ['Shoulder_L', 'UpperArm_L', 'LowerArm_L', 'Hand_L', 'Shoulder_R', 'UpperArm_R', 'LowerArm_R', 'Hand_R'];
const LEG_BONES = ['Root', 'Hips', 'UpperLeg_L', 'LowerLeg_L', 'Foot_L', 'Toe_L', 'UpperLeg_R', 'LowerLeg_R', 'Foot_R', 'Toe_R'];

type AimOpts = { weight: number; pitch: number; armed: boolean; reloadT: number; weapon?: string };
type AimFn = (bones: Map<string, THREE.Bone>, o: AimOpts) => void;

async function setupRegistry(): Promise<void> {
  const buf = readFileSync(GLB_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  registerCharacterTemplateForTest(await parseCharacterGlb(ab));
}

function snap(inst: CamperBuddyInstance, names?: string[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const [n, b] of inst.bones) {
    if (names && !names.includes(n)) continue;
    m.set(n, [...b.position.toArray(), ...b.quaternion.toArray(), ...b.scale.toArray()]);
  }
  return m;
}
function restore(inst: CamperBuddyInstance, s: Map<string, number[]>): void {
  for (const [n, v] of s) {
    const b = inst.bones.get(n)!;
    b.position.fromArray(v, 0);
    b.quaternion.fromArray(v, 3);
    b.scale.fromArray(v, 7);
  }
}
function diff(a: Map<string, number[]>, b: Map<string, number[]>, only?: string[]): number {
  let m = 0;
  for (const [k, va] of a) {
    if (only && !only.includes(k)) continue;
    const vb = b.get(k)!;
    for (let i = 0; i < va.length; i++) m = Math.max(m, Math.abs(va[i] - vb[i]));
  }
  return m;
}

/** Instance posed by a few frames of the real Walk clip (so overrides are tested on a non-bind pose). */
function posedInstance(speed = 3): { inst: CamperBuddyInstance; anim: CamperBuddyAnimator } {
  const inst = instantiateCamperBuddy()!;
  const anim = new CamperBuddyAnimator(inst.root, inst.clips);
  for (let i = 0; i < 17; i++) anim.update(DT, { speed, onGround: true, alive: true });
  return { inst, anim };
}

describe('BOSQICH 08B-CHAR — CharacterAimPose (agent C)', { skip: !existsSync(AIM_PATH) && 'CharacterAimPose.ts hali yo‘q' }, () => {
  let apply: AimFn;
  before(async () => {
    await setupRegistry();
    apply = (await import('../CharacterAimPose')).applyUpperBodyAimPose as AimFn;
  });
  after(() => registerCharacterTemplateForTest(null));

  it('1. weight=0 → sof clip pozasi (hech bir suyak o‘zgarmaydi)', () => {
    const { inst, anim } = posedInstance();
    const before = snap(inst);
    for (const pitch of [-0.6, 0, 0.6]) {
      for (const armed of [true, false]) apply(inst.bones, { weight: 0, pitch, armed, reloadT: 0.3, weapon: 'rifle' });
    }
    assert.ok(diff(before, snap(inst)) < 1e-9, 'weight 0 must be identity');
    anim.dispose();
    inst.dispose();
  });

  it('2. Deterministik: bir xil kirish → bir xil chiqish; oyoq/Hips suyaklariga tegmaydi', () => {
    const { inst, anim } = posedInstance();
    const base = snap(inst);
    const outs: Map<string, number[]>[] = [];
    for (let r = 0; r < 3; r++) {
      restore(inst, base);
      apply(inst.bones, { weight: 1, pitch: 0.37, armed: true, reloadT: 0.25, weapon: 'rifle' });
      outs.push(snap(inst));
    }
    assert.equal(diff(outs[0], outs[1]), 0);
    assert.equal(diff(outs[0], outs[2]), 0);
    assert.ok(diff(base, outs[0], [...AIM_BONES, ...ARM_BONES]) > 1e-4, 'override must change upper body');
    assert.ok(diff(base, outs[0], LEG_BONES) < 1e-9, 'legs/Hips must stay clip-driven');
    for (const v of outs[0].values()) assert.ok(v.every(Number.isFinite));
    for (const b of inst.bones.values()) assert.ok(Math.abs(b.quaternion.length() - 1) < 1e-4, `${b.name} unit q`);
    anim.dispose();
    inst.dispose();
  });

  it('3. Pitch monoton: Chest/Head dunyo yo‘nalishi pitch bilan bir tomonga buriladi, −0.6..0.6 da NaN yo‘q', () => {
    const { inst, anim } = posedInstance(0);
    const base = snap(inst);
    const headFwdY: number[] = [];
    const v = new THREE.Vector3();
    for (let p = -0.6; p <= 0.6 + 1e-9; p += 0.1) {
      restore(inst, base);
      apply(inst.bones, { weight: 1, pitch: p, armed: true, reloadT: 0, weapon: 'rifle' });
      inst.root.updateMatrixWorld(true);
      const head = inst.bones.get('Head')!;
      v.set(0, 0, -1).transformDirection(head.matrixWorld);
      assert.ok(Number.isFinite(v.y));
      headFwdY.push(v.y);
    }
    const inc = headFwdY.every((y, i) => i === 0 || y >= headFwdY[i - 1] - 1e-6);
    const dec = headFwdY.every((y, i) => i === 0 || y <= headFwdY[i - 1] + 1e-6);
    assert.ok(inc || dec, `head pitch monotonic: ${headFwdY.map((y) => y.toFixed(3)).join(',')}`);
    assert.ok(Math.abs(headFwdY[headFwdY.length - 1] - headFwdY[0]) > 0.2, 'pitch must visibly move the head');
    anim.dispose();
    inst.dispose();
  });

  it('4. Allokatsiyasiz: funksiya va yordamchilarida `new`/clone/literal yo‘q; dinamik: < 512 B/chaqiriq (suyak boshiga obyekt yaratilmaydi)', (t) => {
    const src = readFileSync(AIM_PATH, 'utf8');
    const bodyOf = (sig: string): string => {
      const start = src.indexOf(sig);
      assert.ok(start >= 0, `${sig} topilmadi`);
      let i = src.indexOf('{', src.indexOf(')', start));
      const from = i;
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
      }
      return src.slice(from, i + 1);
    };
    for (const sig of [
      'export function applyUpperBodyAimPose',
      'function blendInto',
      'function stabilised',
      'function applyUnarmed',
      ...['function applyArmed', 'function restoreClipInputs', 'function recordOutputs'].filter((x) => src.includes(x)),
    ]) {
      const body = bodyOf(sig);
      assert.ok(!/\bnew\s+[A-Za-z_$]/.test(body), `${sig}: \`new\` per call`);
      assert.ok(!/\.clone\(\)/.test(body), `${sig}: clone() per call`);
      assert.ok(!/=\s*\[|\(\s*\[|=\s*\{\s*[a-z_$]+\s*:/i.test(body), `${sig}: array/object literal per call`);
    }

    // Dynamic: bytes reclaimed from new-space per call (Node 22: one THREE.Quaternion ≈ 131 B, Vector3 ≈ 103 B).
    // The function writes 12 bones, so any per-bone object allocation would be ≳ 1.5 KB/call. The measured
    // residual (≈165 B/call on Node 22) is V8 HeapNumber boxing of double arguments to non-inlined helpers —
    // no `new` exists in these bodies (static check above). Bound 512 B keeps headroom across V8 versions.
    const { inst, anim } = posedInstance();
    const bones = inst.bones;
    const opts: AimOpts = { weight: 1, pitch: 0, armed: true, reloadT: 0, weapon: 'rifle' };
    const N = 200_000;
    for (let k = 0; k < 5000; k++) apply(bones, opts); // warm-up / JIT
    const prof = new GCProfiler();
    prof.start();
    for (let k = 0; k < N; k++) {
      opts.pitch = ((k % 120) - 60) / 100;
      opts.reloadT = (k % 50) / 50;
      opts.weapon = WEAPONS[k & 3];
      apply(bones, opts);
    }
    const res = prof.stop();
    let freed = 0;
    for (const s of res?.statistics ?? []) {
      const b = s.beforeGC.heapSpaceStatistics.find((x) => x.spaceName === 'new_space');
      const a = s.afterGC.heapSpaceStatistics.find((x) => x.spaceName === 'new_space');
      if (a && b) freed += Math.max(0, b.spaceUsedSize - a.spaceUsedSize);
    }
    const perCall = freed / N;
    t.diagnostic(`aim pose garbage ≈ ${perCall.toFixed(1)} B/call`);
    assert.ok(perCall < 512, `per-call garbage ${perCall.toFixed(1)} B — object allocation suspected`);
    anim.dispose();
    inst.dispose();
  });

  it('4c. Idempotent: mixer yangilamasa (dt=0 / bir xil kadr) qayta chaqiriq to‘planmaydi; weight 1 → 0 sof clip’ga qaytaradi', () => {
    for (const armed of [true, false]) {
      const { inst, anim } = posedInstance();
      const clip = snap(inst);
      const o: AimOpts = { weight: 1, pitch: 0.45, armed, reloadT: 0.2, weapon: 'shotgun' };
      apply(inst.bones, o);
      const once = snap(inst);
      for (let k = 0; k < 10; k++) {
        anim.update(0, { speed: 3, onGround: true, alive: true }); // mixer re-applies nothing new
        apply(inst.bones, o);
      }
      assert.ok(diff(once, snap(inst)) < 1e-6, `armed=${armed}: repeated override accumulates (${diff(once, snap(inst))})`);
      apply(inst.bones, { ...o, weight: 0 });
      assert.ok(diff(clip, snap(inst)) < 1e-6, `armed=${armed}: weight 0 after 1 must restore the clip pose`);
      // and a real mixer step afterwards still drives the bones from the clip
      anim.update(DT, { speed: 3, onGround: true, alive: true });
      apply(inst.bones, o);
      for (const b of inst.bones.values()) assert.ok(b.quaternion.toArray().every(Number.isFinite));
      anim.dispose();
      inst.dispose();
    }
  });

  it('4b. armed=false: qo‘llar clip’da qoladi, faqat Spine/Chest/Neck yengil pitch oladi', () => {
    const { inst, anim } = posedInstance();
    const base = snap(inst);
    apply(inst.bones, { weight: 1, pitch: 0.5, armed: false, reloadT: 0 });
    const after = snap(inst);
    assert.ok(diff(base, after, ARM_BONES) < 1e-9, 'unarmed arms keep clip swing');
    assert.ok(diff(base, after, LEG_BONES) < 1e-9);
    assert.ok(diff(base, after, ['Spine', 'Chest', 'Neck']) > 1e-4);
    // NaN / out-of-range inputs never produce NaN
    for (const o of [
      { weight: NaN, pitch: 0.2, armed: true, reloadT: 0 },
      { weight: 1, pitch: NaN, armed: true, reloadT: NaN },
      { weight: 7, pitch: 99, armed: true, reloadT: -3 },
      { weight: 1, pitch: -Infinity, armed: true, reloadT: Infinity, weapon: 'grenade' },
    ]) {
      restore(inst, base);
      apply(inst.bones, o as AimOpts);
      for (const b of inst.bones.values()) assert.ok(b.quaternion.toArray().every(Number.isFinite), `${JSON.stringify(o)}: ${b.name}`);
    }
    anim.dispose();
    inst.dispose();
  });
});

describe('BOSQICH 08B-CHAR — CharacterWeaponMount (agent C)', { skip: !existsSync(MOUNT_PATH) && 'CharacterWeaponMount.ts hali yo‘q' }, () => {
  type Mount = {
    holder: THREE.Group;
    update(pitch: number, recoil: number, reloadTilt: number): void;
    setWeapon?(w: string | null): void;
  };
  let MountCtor: new (socket: THREE.Object3D, root: THREE.Object3D) => Mount;
  let apply: AimFn | null = null;
  before(async () => {
    await setupRegistry();
    MountCtor = (await import('../CharacterWeaponMount')).CharacterWeaponMount as unknown as typeof MountCtor;
    if (existsSync(AIM_PATH)) apply = (await import('../CharacterAimPose')).applyUpperBodyAimPose as AimFn;
  });
  after(() => registerCharacterTemplateForTest(null));

  /** Camera convention (Game.ts: pitch = camera.rotation.x, +pitch looks up), yaw = root rotation.y. */
  function aimDir(yaw: number, pitch: number): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  }

  it('5. Holder Hand_R_Grip socket’iga biriktirilgan', () => {
    const inst = instantiateCamperBuddy()!;
    const socket = inst.sockets.get('Hand_R_Grip')!;
    const m = new MountCtor(socket, inst.root);
    assert.equal(m.holder.parent, socket);
    inst.dispose();
  });

  it('6. Qurol −Z o‘qi aim yo‘nalishiga ≤1° mos: pitch −0.6..0.6, 4 xil qurol, bir nechta yaw va clip pozalari', (t) => {
    let worst = 0;
    let worstCase = '';
    for (const speed of [0, 3, 6.5]) {
      const { inst, anim } = posedInstance(speed);
      const outer = new THREE.Group();
      outer.add(inst.root);
      const m = new MountCtor(inst.sockets.get('Hand_R_Grip')!, inst.root);
      const base = snap(inst);
      for (const w of WEAPONS) {
        m.setWeapon?.(w);
        for (const yaw of [0, 0.9, -2.4, Math.PI]) {
          outer.rotation.set(0, yaw, 0);
          for (let p = -0.6; p <= 0.6 + 1e-9; p += 0.15) {
            restore(inst, base);
            apply?.(inst.bones, { weight: 1, pitch: p, armed: true, reloadT: 0, weapon: w });
            outer.updateMatrixWorld(true);
            m.update(p, 0, 0);
            outer.updateMatrixWorld(true);
            const fwd = new THREE.Vector3(0, 0, -1).transformDirection(m.holder.matrixWorld);
            const ang = THREE.MathUtils.radToDeg(fwd.angleTo(aimDir(yaw, p)));
            assert.ok(Number.isFinite(ang), 'finite');
            if (ang > worst) {
              worst = ang;
              worstCase = `speed ${speed} weapon ${w} yaw ${yaw.toFixed(2)} pitch ${p.toFixed(2)}`;
            }
          }
        }
      }
      anim.dispose();
      inst.dispose();
    }
    t.diagnostic(`max aim error ${worst.toFixed(4)}° (${worstCase})`);
    assert.ok(worst <= 1, `max aim error ${worst.toFixed(3)}° at ${worstCase}`);
  });

  it('7. Recoil/reload tilt chekli va qaytuvchan (recoil=0, tilt=0 → yana aniq aim)', () => {
    const { inst, anim } = posedInstance(0);
    const m = new MountCtor(inst.sockets.get('Hand_R_Grip')!, inst.root);
    m.setWeapon?.('rifle');
    inst.root.updateMatrixWorld(true);
    m.update(0.2, 1, -0.5);
    inst.root.updateMatrixWorld(true);
    assert.ok(m.holder.matrixWorld.elements.every(Number.isFinite));
    m.update(0.2, 0, 0);
    inst.root.updateMatrixWorld(true);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(m.holder.matrixWorld);
    assert.ok(THREE.MathUtils.radToDeg(fwd.angleTo(aimDir(0, 0.2))) <= 1);
    anim.dispose();
    inst.dispose();
  });
});

describe('BOSQICH 08B-CHAR — CharacterWeaponMount grip nuqtasi (agent C)', { skip: !existsSync(MOUNT_PATH) && 'CharacterWeaponMount.ts hali yo‘q' }, () => {
  before(setupRegistry);
  after(() => registerCharacterTemplateForTest(null));

  it('7b. recoil=0 da qurolning grip nuqtasi (WEAPON_GRIP_OFFSETS × GUN_SCALE_3P) Hand_R_Grip socket ustida (≤1 mm), holder dunyo masshtabi = 1', async () => {
    const mod = await import('../CharacterWeaponMount');
    assert.equal(mod.GUN_SCALE_3P, 1.32);
    for (const speed of [0, 6.5]) {
      const { inst, anim } = posedInstance(speed);
      const outer = new THREE.Group();
      outer.position.set(12, 3, -40);
      outer.rotation.y = 1.1;
      outer.add(inst.root);
      const socket = inst.sockets.get('Hand_R_Grip')!;
      const m = new mod.CharacterWeaponMount(socket, inst.root);
      for (const w of WEAPONS) {
        m.setWeapon(w);
        for (const p of [-0.6, 0, 0.6]) {
          outer.updateMatrixWorld(true);
          m.update(p, 0, 0);
          const grip = mod.WEAPON_GRIP_OFFSETS[w].clone().multiplyScalar(mod.GUN_SCALE_3P);
          const gripWorld = m.holder.localToWorld(grip.clone());
          const sockWorld = socket.getWorldPosition(new THREE.Vector3());
          const err = gripWorld.distanceTo(sockWorld);
          assert.ok(err < 1e-3, `${w} pitch ${p}: grip-socket error ${(err * 1000).toFixed(2)} mm`);
          const sc = new THREE.Vector3();
          m.holder.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
          assert.ok(Math.abs(sc.x - 1) < 1e-4 && Math.abs(sc.y - 1) < 1e-4 && Math.abs(sc.z - 1) < 1e-4, `${w}: holder world scale ${sc.toArray()}`);
        }
      }
      m.dispose();
      assert.equal(m.holder.parent, null, 'dispose → holder socket’dan olinadi');
      anim.dispose();
      inst.dispose();
    }
  });
});

describe('BOSQICH 08B-CHAR — CharacterMaterials.applyTeamColor (agent C)', { skip: !existsSync(MAT_PATH) && 'CharacterMaterials.ts hali yo‘q' }, () => {
  let applyTeamColor: (inst: CamperBuddyInstance, color: THREE.ColorRepresentation) => void;
  before(async () => {
    await setupRegistry();
    applyTeamColor = (await import('../CharacterMaterials')).applyTeamColor as typeof applyTeamColor;
  });
  after(() => registerCharacterTemplateForTest(null));

  it('8. Faqat shu instansiyaning team materiali o‘zgaradi (buddy_main, shablon, boshqa instansiya daxlsiz)', () => {
    const a = instantiateCamperBuddy()!;
    const b = instantiateCamperBuddy()!;
    const main = a.mainMaterial as THREE.MeshStandardMaterial;
    const mainState = JSON.stringify(main.toJSON());
    const bTeam = b.teamMaterial.color.getHex();
    const aMats = a.skinnedMeshes.map((m) => m.material);
    let mainDisposed = 0;
    main.addEventListener('dispose', () => mainDisposed++);

    applyTeamColor(a, '#e03a30');
    const red = new THREE.Color('#e03a30');
    const got = a.teamMaterial.color;
    // Allow either linear or sRGB handling, but it must actually be the requested colour family.
    assert.ok(got.r > got.g && got.r > got.b, `team colour applied: #${got.getHexString()}`);
    assert.ok(Math.abs(got.r - red.r) < 0.25, `red channel ${got.r} vs ${red.r}`);
    applyTeamColor(a, '#2e75e8');
    assert.ok(a.teamMaterial.color.b > a.teamMaterial.color.r, 'recolour to blue');

    assert.equal(JSON.stringify(main.toJSON()), mainState, 'buddy_main must not be mutated');
    assert.equal(b.teamMaterial.color.getHex(), bTeam, 'other instance untouched');
    assert.deepEqual(a.skinnedMeshes.map((m) => m.material), aMats, 'no material reassignment');
    assert.equal(mainDisposed, 0);
    a.dispose();
    b.dispose();
  });
});
