import { EYE_HEIGHT } from '../../../shared/constants';
import { clamp, lerp, type Vec3 } from '../../../shared/math';
import { eyeHeightOf } from '../../../shared/stance';
import type { WeaponId } from '../../../shared/weapons';
import { sampleTerrainHeight, type WorldDefinition } from '../../../shared/world';
import { computeFairThirdPersonCameraDist } from '../ForestRenderer';
import { TP_MAX_DIST_SPECTATOR, TP_SHOULDER_OFFSET } from '../cameraConstants';

export interface SpectatableTarget {
  id: string;
  name: string;
  pos: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  weapon: WeaponId | null;
  /** O'tirgan holat: kamera CROUCH_EYE_HEIGHT ga (mavjud silliqlash bilan) tushadi. */
  crouched?: boolean;
}

export interface SpectatorCameraPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  mode: 'follow' | 'overview';
  targetId: string | null;
  targetName: string | null;
  targetHp: number;
  targetWeapon: WeaponId | null;
  thirdPerson: boolean;
}

export interface SpectatorDiagnostics {
  active: boolean;
  mode: 'follow' | 'overview';
  targetId: string | null;
  targetName: string | null;
  availableTargetIds: string[];
  thirdPerson: boolean;
  cameraPose: { x: number; y: number; z: number; yaw: number; pitch: number };
}

function createInitialPose(): SpectatorCameraPose {
  return {
    x: 0,
    y: EYE_HEIGHT + 12,
    z: 14,
    yaw: 0,
    pitch: -0.48,
    mode: 'overview',
    targetId: null,
    targetName: null,
    targetHp: 0,
    targetWeapon: null,
    thirdPerson: true,
  };
}

export class SpectatorController {
  private active = false;
  private targetId: string | null = null;
  private orbitAngle = 0;
  private smoothedCamY = EYE_HEIGHT;
  private lastPose: SpectatorCameraPose = createInitialPose();
  private lastAvailableTargetIds: string[] = [];

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      this.targetId = null;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  setTarget(targetId: string | null): void {
    this.targetId = targetId;
  }

  getTargetId(): string | null {
    return this.targetId;
  }

  getLastPose(): SpectatorCameraPose {
    return { ...this.lastPose };
  }

  cycleTarget(delta: number, targets: readonly SpectatableTarget[]): SpectatableTarget | null {
    const aliveTargets = targets.filter((t) => t.alive);
    this.lastAvailableTargetIds = aliveTargets.map((t) => t.id);

    if (aliveTargets.length === 0) {
      this.targetId = null;
      return null;
    }

    const curIdx = this.targetId ? aliveTargets.findIndex((t) => t.id === this.targetId) : -1;
    const step = delta === 0 ? 1 : delta;
    const nextIdx =
      curIdx >= 0
        ? (((curIdx + step) % aliveTargets.length) + aliveTargets.length) % aliveTargets.length
        : step >= 0
          ? 0
          : aliveTargets.length - 1;

    const chosen = aliveTargets[nextIdx]!;
    this.targetId = chosen.id;
    return chosen;
  }

  updateCameraPose(
    dt: number,
    targets: readonly SpectatableTarget[],
    world: WorldDefinition,
    thirdPerson: boolean,
    fallbackPos: Vec3,
  ): SpectatorCameraPose {
    const aliveTargets = targets.filter((t) => t.alive);
    this.lastAvailableTargetIds = aliveTargets.map((t) => t.id);

    if (aliveTargets.length > 0) {
      if (!this.targetId || !aliveTargets.some((t) => t.id === this.targetId)) {
        this.targetId = aliveTargets[0]!.id;
      }
      const target = aliveTargets.find((t) => t.id === this.targetId) ?? aliveTargets[0]!;
      this.targetId = target.id;

      const eyeY = target.pos.y + eyeHeightOf(target);
      this.smoothedCamY =
        Math.abs(eyeY - this.smoothedCamY) < 1.2
          ? lerp(this.smoothedCamY, eyeY, Math.min(1, Math.max(0, dt) * 16))
          : eyeY;

      let x = target.pos.x;
      let y = this.smoothedCamY;
      let z = target.pos.z;

      if (thirdPerson) {
        const rightX = Math.cos(target.yaw);
        const rightZ = -Math.sin(target.yaw);
        const fwdX = -Math.sin(target.yaw) * Math.cos(target.pitch);
        const fwdY = Math.sin(target.pitch);
        const fwdZ = -Math.cos(target.yaw) * Math.cos(target.pitch);
        const pivot = {
          x: target.pos.x + rightX * TP_SHOULDER_OFFSET,
          y: this.smoothedCamY + 0.18,
          z: target.pos.z + rightZ * TP_SHOULDER_OFFSET,
        };
        const backDir = { x: -fwdX, y: -fwdY, z: -fwdZ };
        const dist = computeFairThirdPersonCameraDist(world, pivot, backDir, TP_MAX_DIST_SPECTATOR);
        x = pivot.x + backDir.x * dist;
        y = pivot.y + backDir.y * dist;
        z = pivot.z + backDir.z * dist;
      }

      this.lastPose = {
        x,
        y,
        z,
        yaw: target.yaw,
        pitch: target.pitch,
        mode: 'follow',
        targetId: target.id,
        targetName: target.name,
        targetHp: target.hp,
        targetWeapon: target.weapon,
        thirdPerson,
      };
      return { ...this.lastPose };
    }

    this.targetId = null;
    this.orbitAngle = (this.orbitAngle + Math.max(0, dt) * 0.22) % (Math.PI * 2);
    const radius = 14;
    const cx = clamp(fallbackPos.x + Math.sin(this.orbitAngle) * radius, -110, 110);
    const cz = clamp(fallbackPos.z + Math.cos(this.orbitAngle) * radius, -110, 110);
    const groundY = sampleTerrainHeight(world.terrain, cx, cz);
    const cy = Math.max(groundY + 12, fallbackPos.y + 10);
    const yaw = Math.atan2(cx - fallbackPos.x, cz - fallbackPos.z);
    const pitch = -0.48;

    this.lastPose = {
      x: cx,
      y: cy,
      z: cz,
      yaw,
      pitch,
      mode: 'overview',
      targetId: null,
      targetName: null,
      targetHp: 0,
      targetWeapon: null,
      thirdPerson: true,
    };
    return { ...this.lastPose };
  }

  getDiagnostics(targets?: readonly SpectatableTarget[]): SpectatorDiagnostics {
    const availableTargetIds = targets
      ? targets.filter((t) => t.alive).map((t) => t.id)
      : [...this.lastAvailableTargetIds];

    return {
      active: this.active,
      mode: this.lastPose.mode,
      targetId: this.targetId,
      targetName: this.lastPose.targetName,
      availableTargetIds,
      thirdPerson: this.lastPose.thirdPerson,
      cameraPose: {
        x: this.lastPose.x,
        y: this.lastPose.y,
        z: this.lastPose.z,
        yaw: this.lastPose.yaw,
        pitch: this.lastPose.pitch,
      },
    };
  }

  reset(): void {
    this.active = false;
    this.targetId = null;
    this.orbitAngle = 0;
    this.smoothedCamY = EYE_HEIGHT;
    this.lastAvailableTargetIds = [];
    this.lastPose = createInitialPose();
  }
}
