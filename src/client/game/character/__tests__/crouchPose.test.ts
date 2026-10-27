import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  instantiateCamperBuddy,
  parseCharacterGlb,
  registerCharacterTemplateForTest,
  type CamperBuddyInstance,
} from '../CharacterAssetRegistry';
import { CamperBuddyAnimator } from '../../animation/CamperBuddyAnimator';
import { applyCrouchPose } from '../CharacterCrouchPose';
import { CROUCH_HEIGHT, PLAYER_HEIGHT } from '../../../../shared/constants';

// Bosqich 17 — o'tirish (crouch) pozasi haqiqiy Camper Buddy GLB rigida: oyoqlar yerda qoladi,
// bosh ≈ (PLAYER_HEIGHT − CROUCH_HEIGHT) ga pastlaydi, amount 0 — sof klip pozasi.

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const GLB_PATH = here('../../../../../public/models/characters/camper_buddy_balanced_rigged.glb');
const DT = 1 / 60;
const _v = new THREE.Vector3();

function worldY(inst: CamperBuddyInstance, bone: string): number {
  inst.root.updateMatrixWorld(true);
  return inst.bones.get(bone)!.getWorldPosition(_v).y;
}
function pose(inst: CamperBuddyInstance): number[] {
  const out: number[] = [];
  for (const b of inst.bones.values()) out.push(...b.position.toArray(), ...b.quaternion.toArray());
  return out;
}
function posed(speed: number, frames = 20): { inst: CamperBuddyInstance; anim: CamperBuddyAnimator } {
  const inst = instantiateCamperBuddy()!;
  const anim = new CamperBuddyAnimator(inst.root, inst.clips);
  for (let i = 0; i < frames; i++) anim.update(DT, { speed, onGround: true, alive: true });
  return { inst, anim };
}

describe("Bosqich 17 — Camper Buddy o'tirish pozasi (haqiqiy GLB)", () => {
  before(async () => {
    const buf = readFileSync(GLB_PATH);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    registerCharacterTemplateForTest(await parseCharacterGlb(ab));
  });

  it("amount 0 — klip pozasi o'zgarmaydi", () => {
    const { inst } = posed(0);
    const before = pose(inst);
    applyCrouchPose(inst.bones, 0);
    const after = pose(inst);
    for (let i = 0; i < before.length; i++) assert.ok(Math.abs(before[i] - after[i]) < 1e-9, `index ${i}`);
  });

  it("Idle: to'liq o'tirishda oyoqlar yerda, bosh ≈0.55 m pastga tushadi", () => {
    const { inst } = posed(0);
    const footL0 = worldY(inst, 'Foot_L');
    const footR0 = worldY(inst, 'Foot_R');
    const head0 = worldY(inst, 'Head');
    applyCrouchPose(inst.bones, 1);
    const footL1 = worldY(inst, 'Foot_L');
    const footR1 = worldY(inst, 'Foot_R');
    const head1 = worldY(inst, 'Head');
    assert.ok(Math.abs(footL1 - footL0) < 0.06, `chap oyoq siljidi: ${footL0.toFixed(3)} -> ${footL1.toFixed(3)}`);
    assert.ok(Math.abs(footR1 - footR0) < 0.06, `o'ng oyoq siljidi: ${footR0.toFixed(3)} -> ${footR1.toFixed(3)}`);
    const drop = head0 - head1;
    const expected = PLAYER_HEIGHT - CROUCH_HEIGHT;
    assert.ok(drop >= 0.45 && drop <= 0.65, `bosh pasayishi ${drop.toFixed(3)} m (kutilgan ≈${expected.toFixed(2)})`);
    // Tizzalar yer ostiga kirmaydi
    assert.ok(worldY(inst, 'LowerLeg_L') > 0 && worldY(inst, 'LowerLeg_R') > 0, 'tizza yer ostida');
  });

  it("Walk (o'tirib yurish): har kadrda oyoqlar klip balandligida, idempotent", () => {
    // Ikki nusxa bir xil kirish bilan: `ref` faqat klipni o'ynaydi (o'lchov uchun toza klip pozasi),
    // `inst` ga har kadrda o'tirish qo'llanadi. (Mixer o'zgarmagan trekni qayta yozmaydi — shu sababli
    // klip balandligini o'tirgan nusxaning o'zidan o'lchab bo'lmaydi.)
    const { inst, anim } = posed(2.1, 5);
    const { inst: ref, anim: refAnim } = posed(2.1, 5);
    for (let f = 0; f < 90; f++) {
      anim.update(DT, { speed: 2.1, onGround: true, alive: true });
      refAnim.update(DT, { speed: 2.1, onGround: true, alive: true });
      applyCrouchPose(inst.bones, 1);
      const once = pose(inst);
      for (const foot of ['Foot_L', 'Foot_R']) {
        const d = worldY(inst, foot) - worldY(ref, foot);
        assert.ok(Math.abs(d) < 0.06, `kadr ${f}: ${foot} klipdan ${d.toFixed(3)} m farq qiladi`);
      }
      assert.ok(worldY(ref, 'Head') - worldY(inst, 'Head') > 0.4, `kadr ${f}: bosh yetarlicha pastlamadi`);
      // Qayta qo'llash bir xil natija beradi (oldingi natija ustiga ikkinchi marta qo'shilmaydi)
      applyCrouchPose(inst.bones, 1);
      const twice = pose(inst);
      for (let i = 0; i < once.length; i++) assert.ok(Math.abs(once[i] - twice[i]) < 1e-6, `kadr ${f}: idempotent emas`);
    }
  });

  it("oraliq amount bosh balandligini monoton pasaytiradi", () => {
    const { inst } = posed(0);
    let prev = Infinity;
    for (const a of [0, 0.25, 0.5, 0.75, 1]) {
      applyCrouchPose(inst.bones, a);
      const h = worldY(inst, 'Head');
      assert.ok(h <= prev + 1e-6, `amount ${a}: bosh ${h.toFixed(3)} > oldingi ${prev.toFixed(3)}`);
      prev = h;
    }
  });
});
