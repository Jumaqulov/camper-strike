import * as THREE from 'three';
import type { WeaponId } from '../../../shared/weapons';

/**
 * Stage 08B — upper-body override for the Camper Buddy rig (no runtime IK).
 *
 * Call `applyUpperBodyAimPose()` every frame AFTER `mixer.update()` (and before
 * `updateMatrixWorld`). It:
 *  - stabilises Spine/Chest/Neck in character space (cancels most of the clip's hip/chest
 *    yaw-twist and roll, keeps `TORSO_BOB_KEEP` of it as bob) and distributes the aim pitch
 *    (positive = looking up) over Spine → Chest → Neck so the head ends at the full pitch
 *    (clamped to ±NECK_PITCH_LIMIT so the big head never folds onto the back);
 *  - replaces both arm chains (Shoulder, UpperArm, LowerArm, Hand) with a fixed "ready" pose
 *    whose local quaternions were solved OFFLINE against the real GLB rest skeleton
 *    (scratch numeric two-bone solver with elbow-down/outward preference) and baked below.
 *    The runtime only slerps clip pose → baked pose by `weight`;
 *  - rotates both shoulders by the remaining aim pitch (1 − chest share) about the
 *    character X axis so the whole arm assembly (and therefore the hands on the gun) follows
 *    the full aim pitch while the torso only leans by part of it.
 *
 * Character space = the parent space of the `Root` bone (the GLB scene root), +Y up, −Z forward.
 * No allocations per call (module-level temporaries, per-skeleton bone lookup cached in a WeakMap).
 */

export interface UpperBodyAimPoseOptions {
  /** 0 = pure clip, 1 = full override. */
  weight: number;
  /** Aim pitch in radians, positive = looking up (game convention). */
  pitch: number;
  /** false → arms keep the clip swing; only a light spine/neck pitch is applied. */
  armed: boolean;
  /** Reload phase 0..1 (cyclic), 0 when not reloading → left hand dips toward the magazine. */
  reloadT: number;
  /** Selects the baked hand layout. Defaults to 'rifle'. */
  weapon?: WeaponId | null;
}

/** Structural bone map (CamperBuddyInstance.bones satisfies this). */
export type CharacterBoneMap = ReadonlyMap<string, THREE.Bone>;

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

/** Fraction of the clip's torso rotation (relative to rest) that survives the stabiliser. */
export const TORSO_BOB_KEEP = 0.15;
/** Fraction of the clip's neck rotation (relative to rest) that survives. */
export const NECK_BOB_KEEP = 0.3;

/**
 * Armed pitch distribution (cumulative, character space). Head ends at 1.0 × pitch and the arms
 * frame (chest + shoulders) at 1.0 × pitch. Looking DOWN puts more into the low Spine pivot
 * (moves the hands forward/down, away from the belly) and less into the shoulder line (which sits
 * above the hands and would swing them back into the torso).
 */
const UP_SPINE_PITCH = 0.2;
const UP_CHEST_PITCH = 0.5; // cumulative (Spine + Chest)
const DOWN_SPINE_PITCH = 0.35;
const DOWN_CHEST_PITCH = 0.7;
const ARMED_NECK_PITCH = 1.0; // cumulative (head looks exactly along the aim)
/** Max cumulative head pitch (rad); beyond this only the arms/gun keep following the aim. */
const NECK_PITCH_LIMIT = 1.1;

/** Unarmed: light lean, applied on top of the clip (local, no stabilisation). */
const UNARMED_SPINE_PITCH = 0.12;
const UNARMED_CHEST_PITCH = 0.18;
const UNARMED_NECK_PITCH = 0.45;

/** Torso yaw ("bladed" stance) for long guns: right shoulder back, left shoulder forward. */
export const LONG_GUN_BLADE_YAW = -0.3;
export const PISTOL_BLADE_YAW = 0;

/** Pitch is clamped to the game range. */
const PITCH_LIMIT = 1.55;

// ---------------------------------------------------------------------------------------------
// Baked arm poses (local quaternions [x, y, z, w]), solved offline against
// public/models/characters/camper_buddy_balanced_rigged.glb rest transforms with the Chest
// at Ry(blade) and Spine at rest. Order: Shoulder, UpperArm, LowerArm, Hand.
//
// Achieved socket positions (character space, pitch 0, no bob):
//   long_R          Hand_R_Grip    (0.130, 1.220, -0.340)   elbow (0.315, 1.221, -0.111)
//   rifle_L         Hand_L_Support (0.109, 1.280, -0.569)   elbow (-0.048, 1.273, -0.313)
//   shotgun_L       Hand_L_Support (0.109, 1.267, -0.569)
//   sniper_L        Hand_L_Support (0.109, 1.240, -0.569)
//   long_reload_L   Hand_L_Support (0.080, 1.150, -0.500)
//   pistol_R        Hand_R_Grip    (0.060, 1.300, -0.450)   elbow (0.250, 1.272, -0.231)
//   pistol_L        Hand_L_Support (0.027, 1.227, -0.443)   elbow (-0.166, 1.215, -0.213)
//   pistol_reload_L Hand_L_Support (0.027, 1.107, -0.393)
// ---------------------------------------------------------------------------------------------

type Q4 = readonly [number, number, number, number];
type ArmPose = readonly [Q4, Q4, Q4, Q4];

const LONG_R: ArmPose = [
  [-0.000384, -0.025769, 0.014884, 0.999557],
  [0.329318, 0.455142, 0.3367, 0.755664],
  [0.666507, 0, 0, 0.745499],
  [-0.303388, 0.128659, -0.113511, 0.937293],
];
const RIFLE_L: ArmPose = [
  [-0.004806, -0.167327, 0.028308, 0.985483],
  [0.586662, -0.004097, -0.078092, 0.806047],
  [0.150551, 0, 0, 0.988602],
  [-0.035837, 0.027745, -0.000924, 0.998972],
];
const SHOTGUN_L: ArmPose = [
  [-0.005814, -0.173969, 0.032891, 0.984185],
  [0.577636, 0.000853, -0.08324, 0.812039],
  [0.149655, 0, 0, 0.988738],
  [-0.030029, 0.025702, -0.001697, 0.999217],
];
const SNIPER_L: ArmPose = [
  [-0.008662, -0.187449, 0.045342, 0.981189],
  [0.562403, 0.007338, -0.098684, 0.82092],
  [0.142305, 0, 0, 0.989823],
  [-0.018008, 0.023808, -0.001637, 0.999553],
];
const LONG_RELOAD_L: ArmPose = [
  [-0.002435, -0.071891, 0.033766, 0.996838],
  [0.427264, -0.113471, -0.04591, 0.895802],
  [0.246177, 0, 0, 0.969225],
  [0.0175, 0.038623, -0.002555, 0.999097],
];
const PISTOL_R: ArmPose = [
  [-0.000409, -0.028588, 0.014298, 0.999489],
  [0.461798, 0.378623, 0.330677, 0.73078],
  [0.540264, 0, 0, 0.841495],
  [-0.332316, 0.121477, -0.154676, 0.922434],
];
const PISTOL_L: ArmPose = [
  [0.000014, -0.00189, -0.007288, 0.999972],
  [0.447401, -0.39492, -0.138471, 0.790377],
  [0.41232, 0, 0, 0.911039],
  [-0.168317, -0.013628, 0.002214, 0.985636],
];
const PISTOL_RELOAD_L: ArmPose = [
  [0.000001, -0.007673, -0.000187, 0.999971],
  [0.338493, -0.434707, -0.114663, 0.826622],
  [0.389629, 0, 0, 0.920972],
  [-0.111942, -0.023885, 0.003039, 0.993423],
];

interface PoseSet {
  readonly blade: number;
  readonly right: readonly THREE.Quaternion[];
  readonly left: readonly THREE.Quaternion[];
  readonly leftReload: readonly THREE.Quaternion[];
}

const toQuats = (p: ArmPose): THREE.Quaternion[] => p.map((q) => new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize());

const POSES: Record<WeaponId, PoseSet> = {
  rifle: { blade: LONG_GUN_BLADE_YAW, right: toQuats(LONG_R), left: toQuats(RIFLE_L), leftReload: toQuats(LONG_RELOAD_L) },
  shotgun: { blade: LONG_GUN_BLADE_YAW, right: toQuats(LONG_R), left: toQuats(SHOTGUN_L), leftReload: toQuats(LONG_RELOAD_L) },
  sniper: { blade: LONG_GUN_BLADE_YAW, right: toQuats(LONG_R), left: toQuats(SNIPER_L), leftReload: toQuats(LONG_RELOAD_L) },
  pistol: { blade: PISTOL_BLADE_YAW, right: toQuats(PISTOL_R), left: toQuats(PISTOL_L), leftReload: toQuats(PISTOL_RELOAD_L) },
  // Pichoq bir qo'lda to'pponcha kabi ushlanadi
  knife: { blade: PISTOL_BLADE_YAW, right: toQuats(PISTOL_R), left: toQuats(PISTOL_L), leftReload: toQuats(PISTOL_RELOAD_L) },
};

/** Character-space socket targets the baked poses were solved for (pitch 0); for tests/diagnostics. */
export const BAKED_HAND_TARGETS: Readonly<Record<'long' | 'pistol', { grip: readonly [number, number, number] }>> = {
  long: { grip: [0.13, 1.22, -0.34] },
  pistol: { grip: [0.06, 1.3, -0.45] },
};

// ---------------------------------------------------------------------------------------------
// Bone lookup cache
// ---------------------------------------------------------------------------------------------

interface BoneSet {
  root: THREE.Bone | undefined;
  hips: THREE.Bone;
  spine: THREE.Bone;
  chest: THREE.Bone;
  neck: THREE.Bone;
  armR: THREE.Bone[]; // Shoulder, UpperArm, LowerArm, Hand
  armL: THREE.Bone[];
  /**
   * Every bone this module writes, with the last clip value it saw and the last value it wrote.
   * THREE.PropertyMixer only re-applies a track when its value CHANGED since its last apply
   * (paused/frozen mixer, constant tracks, same time twice), so a bone may still hold our previous
   * override when we run. Detect that (bone == lastOut) and restore the clip value first, which
   * keeps the override idempotent and lets weight 0 return the bone to the pure clip.
   */
  written: THREE.Bone[];
  lastClip: THREE.Quaternion[];
  lastOut: THREE.Quaternion[];
}

const boneCache = new WeakMap<CharacterBoneMap, BoneSet | null>();
const ARM_SUFFIX = ['Shoulder_', 'UpperArm_', 'LowerArm_', 'Hand_'] as const;

function resolveBones(bones: CharacterBoneMap): BoneSet | null {
  const cached = boneCache.get(bones);
  if (cached !== undefined) return cached;
  const hips = bones.get('Hips');
  const spine = bones.get('Spine');
  const chest = bones.get('Chest');
  const neck = bones.get('Neck');
  const armR: THREE.Bone[] = [];
  const armL: THREE.Bone[] = [];
  for (const s of ARM_SUFFIX) {
    const r = bones.get(s + 'R');
    const l = bones.get(s + 'L');
    if (r) armR.push(r);
    if (l) armL.push(l);
  }
  let set: BoneSet | null = null;
  if (hips && spine && chest && neck && armR.length === 4 && armL.length === 4) {
    const written = [spine, chest, neck, ...armR, ...armL];
    set = {
      root: bones.get('Root'),
      hips,
      spine,
      chest,
      neck,
      armR,
      armL,
      written,
      lastClip: written.map((b) => b.quaternion.clone()),
      lastOut: written.map(() => new THREE.Quaternion(NaN, NaN, NaN, NaN)),
    };
  }
  boneCache.set(bones, set);
  return set;
}

/** Restores the clip value on bones the mixer did not rewrite since our last call. */
function restoreClipInputs(b: BoneSet): void {
  const { written, lastClip, lastOut } = b;
  for (let i = 0; i < written.length; i++) {
    const q = written[i].quaternion;
    if (q.equals(lastOut[i])) q.copy(lastClip[i]);
    else lastClip[i].copy(q);
  }
}

function recordOutputs(b: BoneSet): void {
  const { written, lastOut } = b;
  for (let i = 0; i < written.length; i++) lastOut[i].copy(written[i].quaternion);
}

// ---------------------------------------------------------------------------------------------
// Temporaries (no per-call allocation)
// ---------------------------------------------------------------------------------------------

const IDENTITY = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const _hipsC = new THREE.Quaternion();
const _clipSpineC = new THREE.Quaternion();
const _clipChestC = new THREE.Quaternion();
const _clipNeckC = new THREE.Quaternion();
const _spineC = new THREE.Quaternion();
const _chestC = new THREE.Quaternion();
const _des = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
const _rx = new THREE.Quaternion();
const _ry = new THREE.Quaternion();
const _shoulderRot = new THREE.Quaternion();
const _armQ = new THREE.Quaternion();

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * `out = slerp(bone.quaternion, target, w)` written into the bone.
 */
function blendInto(bone: THREE.Bone, target: THREE.Quaternion, w: number): void {
  if (w >= 1) bone.quaternion.copy(target);
  else bone.quaternion.slerp(target, w);
}

/** Desired char-space orientation = Rx(pitch) · Ry(yaw) · slerp(clipC, I, 1 - keep). */
function stabilised(out: THREE.Quaternion, clipC: THREE.Quaternion, keep: number, pitch: number, yaw: number): THREE.Quaternion {
  out.copy(IDENTITY).slerp(clipC, keep);
  if (yaw !== 0) out.premultiply(_ry.setFromAxisAngle(AXIS_Y, yaw));
  return out.premultiply(_rx.setFromAxisAngle(AXIS_X, pitch));
}

function applyUnarmed(b: BoneSet, w: number, pitch: number): void {
  b.spine.quaternion.premultiply(_rx.setFromAxisAngle(AXIS_X, pitch * UNARMED_SPINE_PITCH * w));
  b.chest.quaternion.premultiply(_rx.setFromAxisAngle(AXIS_X, pitch * UNARMED_CHEST_PITCH * w));
  b.neck.quaternion.premultiply(_rx.setFromAxisAngle(AXIS_X, pitch * UNARMED_NECK_PITCH * w));
}

/**
 * Upper-body override. Must run after `mixer.update(dt)` each frame (it reads the clip pose
 * from the bones and writes the blended result back). Weight 0 = pure clip. Keep calling it
 * while the weight is 0 or the mixer is frozen: it restores any stale override the mixer did
 * not overwrite (PropertyMixer skips unchanged values), so the result never accumulates.
 */
export function applyUpperBodyAimPose(bones: CharacterBoneMap, opts: UpperBodyAimPoseOptions): void {
  const b = resolveBones(bones);
  if (!b) return;
  restoreClipInputs(b);
  const w = clamp01(Number.isFinite(opts.weight) ? opts.weight : 0);
  if (w > 0) {
    let pitch = Number.isFinite(opts.pitch) ? opts.pitch : 0;
    if (pitch > PITCH_LIMIT) pitch = PITCH_LIMIT;
    else if (pitch < -PITCH_LIMIT) pitch = -PITCH_LIMIT;
    if (opts.armed) applyArmed(b, w, pitch, opts);
    else applyUnarmed(b, w, pitch);
  }
  recordOutputs(b);
}

function applyArmed(b: BoneSet, w: number, pitch: number, opts: UpperBodyAimPoseOptions): void {
  const pose = POSES[opts.weapon ?? 'rifle'] ?? POSES.rifle;
  const spineK = pitch < 0 ? DOWN_SPINE_PITCH : UP_SPINE_PITCH;
  const chestK = pitch < 0 ? DOWN_CHEST_PITCH : UP_CHEST_PITCH;

  // --- clip orientations in character space ---------------------------------------------
  _hipsC.copy(b.hips.quaternion);
  if (b.root) _hipsC.premultiply(b.root.quaternion);
  _clipSpineC.multiplyQuaternions(_hipsC, b.spine.quaternion);
  _clipChestC.multiplyQuaternions(_clipSpineC, b.chest.quaternion);
  _clipNeckC.multiplyQuaternions(_clipChestC, b.neck.quaternion);

  // --- Spine ------------------------------------------------------------------------------
  stabilised(_des, _clipSpineC, TORSO_BOB_KEEP, pitch * spineK, pose.blade * 0.35);
  blendInto(b.spine, _inv.copy(_hipsC).invert().multiply(_des), w);
  _spineC.multiplyQuaternions(_hipsC, b.spine.quaternion);

  // --- Chest (arms frame) -----------------------------------------------------------------
  stabilised(_des, _clipChestC, TORSO_BOB_KEEP, pitch * chestK, pose.blade);
  blendInto(b.chest, _inv.copy(_spineC).invert().multiply(_des), w);
  _chestC.multiplyQuaternions(_spineC, b.chest.quaternion);

  // --- Neck (head looks along the aim, cancels the blade yaw) ------------------------------
  let neckPitch = pitch * ARMED_NECK_PITCH;
  if (neckPitch > NECK_PITCH_LIMIT) neckPitch = NECK_PITCH_LIMIT;
  else if (neckPitch < -NECK_PITCH_LIMIT) neckPitch = -NECK_PITCH_LIMIT;
  stabilised(_des, _clipNeckC, NECK_BOB_KEEP, neckPitch, 0);
  blendInto(b.neck, _inv.copy(_chestC).invert().multiply(_des), w);

  // --- Arms -------------------------------------------------------------------------------
  // Remaining pitch about the character X axis, expressed in Chest-local space:
  // S = inv(chestC) · Rx(p·(1 − chestK)) · chestC  (both shoulder pivots lie on ≈ the same line,
  // so the arm assembly rotates ~rigidly and the hands keep their layout on the gun).
  _rx.setFromAxisAngle(AXIS_X, pitch * (1 - chestK));
  _shoulderRot.copy(_chestC).invert().multiply(_rx).multiply(_chestC);

  let dip = 0;
  const rt = opts.reloadT;
  if (rt > 0 && Number.isFinite(rt)) {
    const s = Math.sin(Math.PI * (rt - Math.floor(rt)));
    dip = s * s * (3 - 2 * s); // smoothstep(sin) — eases in/out of the magazine
  }

  for (let i = 0; i < 4; i++) {
    _armQ.copy(pose.right[i]);
    if (i === 0) _armQ.premultiply(_shoulderRot);
    blendInto(b.armR[i], _armQ, w);

    _armQ.copy(pose.left[i]);
    if (dip > 0) _armQ.slerp(pose.leftReload[i], dip);
    if (i === 0) _armQ.premultiply(_shoulderRot);
    blendInto(b.armL[i], _armQ, w);
  }
}
