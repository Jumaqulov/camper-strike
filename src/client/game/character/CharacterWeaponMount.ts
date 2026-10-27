import * as THREE from 'three';
import type { WeaponId } from '../../../shared/weapons';

/**
 * Stage 08B — third-person weapon mount on the Camper Buddy `Hand_R_Grip` socket.
 *
 * `holder` is parented to the socket. The gun model (`buildGun(w, '3p')`, scaled by
 * `GUN_SCALE_3P` by the caller, exactly like Stickman's gunHolder) is added to `holder` with
 * its origin at the holder origin. Each frame `update()` solves the holder's LOCAL transform so
 * that, in world space:
 *  - the gun points along the character aim: rootWorldQuat · Euler(pitch + reloadTilt + recoil·0.26, 0, 0, 'YXZ')
 *    (gun forward = its local −Z), independent of the hand bone's orientation;
 *  - the gun's grip point (per-weapon `WEAPON_GRIP_OFFSETS`, gun-local, unscaled) sits on the socket,
 *    kicked back along the aim +Z by 0.075·recoil and up by 0.02·recoil (Stickman feel);
 *  - the parent (hand) world scale is divided out, so the gun keeps GUN_SCALE_3P in world.
 *
 * Call order per frame: mixer.update → applyUpperBodyAimPose → characterRoot.updateMatrixWorld(true)
 * → mount.update(...). `recoil` / `reloadTilt` are the caller's already-smoothed values
 * (Stickman: recoilKick decays with exp(-dt·14); reloadTilt = −0.50 while reloading, lerped).
 * No allocations per frame.
 */

/** Uniform 3P gun scale used by Stickman (`gun.group.scale.setScalar(1.32)`). */
export const GUN_SCALE_3P = 1.32;

/** Gun-local (unscaled, as built by buildGun(w,'3p')) palm-centre point of the right-hand grip. */
export const WEAPON_GRIP_OFFSETS: Readonly<Record<WeaponId, Readonly<THREE.Vector3>>> = {
  // AK47 pistol grip box z[0.014, 0.114] y[-0.123, 0.018] → upper-middle of the grip
  rifle: new THREE.Vector3(0, -0.05, 0.07),
  // Pistol grip z[-0.034, 0.092] y[-0.155, 0.052] → upper part (slide above the hand)
  pistol: new THREE.Vector3(0, -0.05, 0.03),
  // Pump shotgun: stock wrist just behind the trigger guard (z ≈ 0.07)
  shotgun: new THREE.Vector3(0, -0.035, 0.1),
  // AWP thumbhole grip behind the trigger guard (z[-0.054, 0.046], y ≥ -0.08)
  sniper: new THREE.Vector3(0, -0.075, 0.09),
  // Pichoq: GLB origin dastaning markazida (z[-0.05, 0.062]) — qo'l biroz pastroq ushlaydi
  knife: new THREE.Vector3(0, -0.01, 0.01),
};

/** Gun-local points where the left palm lands with the baked pose (diagnostics / tests). */
export const WEAPON_SUPPORT_OFFSETS: Readonly<Record<WeaponId, Readonly<THREE.Vector3>>> = {
  rifle: new THREE.Vector3(-0.015, -0.005, -0.105),
  pistol: new THREE.Vector3(-0.025, -0.105, 0.035),
  shotgun: new THREE.Vector3(-0.015, 0, -0.075),
  sniper: new THREE.Vector3(-0.015, -0.06, -0.085),
  knife: new THREE.Vector3(-0.025, -0.105, 0.035),
};

export const RECOIL_PITCH_GAIN = 0.26;
export const RECOIL_KICKBACK = 0.075;
export const RECOIL_RISE = 0.02;

const _socketPos = new THREE.Vector3();
const _socketQuat = new THREE.Quaternion();
const _socketScale = new THREE.Vector3();
const _rootPos = new THREE.Vector3();
const _rootQuat = new THREE.Quaternion();
const _rootScale = new THREE.Vector3();
const _aimQuat = new THREE.Quaternion();
const _pitchQuat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _offset = new THREE.Vector3();
const _worldPos = new THREE.Vector3();
const _invSocket = new THREE.Matrix4();

export class CharacterWeaponMount {
  readonly holder = new THREE.Group();
  private readonly socket: THREE.Object3D;
  private readonly characterRoot: THREE.Object3D;
  private weapon: WeaponId | null = null;
  /** Scaled grip offset (gun-local × GUN_SCALE_3P) of the current weapon. */
  private readonly grip = new THREE.Vector3();
  /** Last solved aim quaternion (world), for diagnostics. */
  readonly aimWorldQuaternion = new THREE.Quaternion();

  constructor(socket: THREE.Object3D, characterRoot: THREE.Object3D) {
    this.socket = socket;
    this.characterRoot = characterRoot;
    this.holder.name = 'buddy_gun_holder';
    socket.add(this.holder);
    this.setWeapon('rifle');
  }

  get currentWeapon(): WeaponId | null {
    return this.weapon;
  }

  /** Selects the grip offset. `null` keeps the last offset (holder visibility is the caller's). */
  setWeapon(w: WeaponId | null): void {
    this.weapon = w;
    if (!w) return;
    this.grip.copy(WEAPON_GRIP_OFFSETS[w] ?? WEAPON_GRIP_OFFSETS.rifle).multiplyScalar(GUN_SCALE_3P);
  }

  /**
   * Solves the holder's local transform. Requires up-to-date `socket.matrixWorld`
   * and `characterRoot.matrixWorld` (call after `characterRoot.updateMatrixWorld(true)`).
   * Updates `holder.matrixWorld` (and its children) before returning.
   */
  update(pitch: number, recoil: number, reloadTilt: number): void {
    const p = Number.isFinite(pitch) ? pitch : 0;
    const r = Number.isFinite(recoil) ? recoil : 0;
    const t = Number.isFinite(reloadTilt) ? reloadTilt : 0;

    this.socket.matrixWorld.decompose(_socketPos, _socketQuat, _socketScale);
    this.characterRoot.matrixWorld.decompose(_rootPos, _rootQuat, _rootScale);

    // World aim orientation: root yaw (and whatever the root carries) × gun pitch.
    _euler.set(p + t + r * RECOIL_PITCH_GAIN, 0, 0, 'YXZ');
    _aimQuat.copy(_rootQuat).multiply(_pitchQuat.setFromEuler(_euler));
    this.aimWorldQuaternion.copy(_aimQuat);

    // Gun origin (world) = socket − aim·grip + aim·(0, rise, kickback)
    _offset.set(-this.grip.x, -this.grip.y + r * RECOIL_RISE, -this.grip.z + r * RECOIL_KICKBACK).applyQuaternion(_aimQuat);
    _worldPos.copy(_socketPos).add(_offset);

    // Local transform under the socket.
    _invSocket.copy(this.socket.matrixWorld).invert();
    this.holder.position.copy(_worldPos).applyMatrix4(_invSocket);
    this.holder.quaternion.copy(_socketQuat).invert().multiply(_aimQuat);
    this.holder.scale.set(safeInv(_socketScale.x), safeInv(_socketScale.y), safeInv(_socketScale.z));
    this.holder.updateMatrixWorld(true);
  }

  dispose(): void {
    this.holder.removeFromParent();
    this.holder.clear();
  }
}

function safeInv(s: number): number {
  return Math.abs(s) > 1e-6 ? 1 / s : 1;
}
