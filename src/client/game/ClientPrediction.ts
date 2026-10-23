import { clamp, type Vec3 } from '../../shared/math';
import {
  cloneMovementState,
  RECONCILE_SMOOTH_THRESHOLD,
  RECONCILE_SNAP_THRESHOLD,
  sanitizePlayerInputCmd,
  stepPlayerMovement,
  type MovementState,
} from '../../shared/netMovement';
import { collidesAtWorld } from '../../shared/physics';
import type { PlayerInputCmd, PlayerSnap } from '../../shared/protocol';
import type { WeaponId } from '../../shared/weapons';
import type { WorldDefinition } from '../../shared/world';

export interface PredictedInputRecord {
  cmd: PlayerInputCmd;
  stateAfter: MovementState;
}

export interface PredictionDiagnostics {
  spawnId: number;
  currentSeq: number;
  lastAckedSeq: number;
  pendingInputs: number;
  lastServerTick: number;
  lastPositionError: number;
  maxPositionError: number;
  reconcileCount: number;
  smoothCorrectionCount: number;
  hardSnapCount: number;
  smoothOffsetMag: number;
}

export interface ReconcileResult {
  accepted: boolean;
  corrected: boolean;
  snapped: boolean;
  errorDist: number;
  replayedCount: number;
}

/** 08-FIX debug: client prediction vs server authority at the same (acknowledged) input seq. */
export interface AckComparison {
  ackSeq: number;
  predictedAtAck: Vec3;
  serverAtAck: Vec3;
  errorDist: number;
}

/**
 * Client-side movement prediction with bounded ring-buffer history,
 * server snapshot reconciliation (rewind + replay), and collision-safe visual smoothing.
 */
export class ClientPrediction {
  private readonly maxBufferSize: number;
  private spawnId = 0;
  private seq = 0;
  private lastAckedSeq = 0;
  private lastServerTick = 0;
  private readonly buffer: PredictedInputRecord[] = [];
  private smoothOffset: Vec3 = { x: 0, y: 0, z: 0 };

  private lastPositionError = 0;
  private maxPositionError = 0;
  private reconcileCount = 0;
  private smoothCorrectionCount = 0;
  private hardSnapCount = 0;
  private lastAckComparison: AckComparison | null = null;

  constructor(maxBufferSize = 120) {
    this.maxBufferSize = Math.max(8, Math.floor(maxBufferSize));
  }

  resetForSpawn(spawnId: number): void {
    this.spawnId = spawnId;
    this.seq = 0;
    this.lastAckedSeq = 0;
    this.buffer.length = 0;
    this.smoothOffset = { x: 0, y: 0, z: 0 };
    this.lastPositionError = 0;
    this.lastAckComparison = null;
  }

  clear(): void {
    this.buffer.length = 0;
    this.smoothOffset = { x: 0, y: 0, z: 0 };
  }

  recordAndStepInput(
    state: MovementState,
    intent: {
      dt: number;
      moveForward: number;
      moveRight: number;
      jump: boolean;
      walk: boolean;
      scoped: boolean;
      weapon: WeaponId | null;
      yaw: number;
      pitch: number;
    },
    world: WorldDefinition,
  ): PlayerInputCmd {
    const nextSeq = ++this.seq;
    const cmd = sanitizePlayerInputCmd(
      {
        ...intent,
        seq: nextSeq,
        spawnId: this.spawnId,
      },
      state.weapon,
    )!;

    stepPlayerMovement(state, cmd, world);

    this.buffer.push({
      cmd,
      stateAfter: cloneMovementState(state),
    });
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    // Exponentially decay visual smoothing offset
    const decay = Math.exp(-18 * cmd.dt);
    this.smoothOffset.x *= decay;
    this.smoothOffset.y *= decay;
    this.smoothOffset.z *= decay;
    if (Math.hypot(this.smoothOffset.x, this.smoothOffset.y, this.smoothOffset.z) < 0.002) {
      this.smoothOffset.x = 0;
      this.smoothOffset.y = 0;
      this.smoothOffset.z = 0;
    } else if (
      collidesAtWorld(
        world,
        state.pos.x + this.smoothOffset.x,
        state.pos.y + this.smoothOffset.y,
        state.pos.z + this.smoothOffset.z,
      )
    ) {
      this.smoothOffset.x = 0;
      this.smoothOffset.y = 0;
      this.smoothOffset.z = 0;
    }

    return cmd;
  }

  getBatchForSend(maxRedundancy = 4): PlayerInputCmd[] {
    const limit = Math.max(1, Math.floor(maxRedundancy));
    const unacked: PlayerInputCmd[] = [];
    for (let i = 0; i < this.buffer.length; i++) {
      const rec = this.buffer[i];
      if (rec.cmd.seq > this.lastAckedSeq) {
        unacked.push(rec.cmd);
      }
    }
    if (unacked.length <= limit) return unacked;
    return unacked.slice(unacked.length - limit);
  }

  reconcileSnapshot(
    state: MovementState,
    snap: PlayerSnap,
    serverTick: number | undefined,
    world: WorldDefinition,
  ): ReconcileResult {
    if (snap.spawnId !== undefined && snap.spawnId !== this.spawnId) {
      return {
        accepted: false,
        corrected: false,
        snapped: false,
        errorDist: 0,
        replayedCount: 0,
      };
    }

    const ackSeq = snap.lastProcessedInputSeq ?? 0;
    if (
      ackSeq < this.lastAckedSeq ||
      (serverTick !== undefined && serverTick < this.lastServerTick && ackSeq === this.lastAckedSeq)
    ) {
      return {
        accepted: false,
        corrected: false,
        snapped: false,
        errorDist: 0,
        replayedCount: 0,
      };
    }

    this.lastAckedSeq = ackSeq;
    if (serverTick !== undefined) {
      this.lastServerTick = Math.max(this.lastServerTick, serverTick);
    }
    this.reconcileCount++;

    const ackRecord = ackSeq > 0 ? this.buffer.find((r) => r.cmd.seq === ackSeq) : undefined;

    // Remove all buffered entries with seq <= ackSeq
    while (this.buffer.length > 0 && this.buffer[0].cmd.seq <= ackSeq) {
      this.buffer.shift();
    }

    if (ackRecord) {
      const posErrAtAck = Math.hypot(
        ackRecord.stateAfter.pos.x - snap.x,
        ackRecord.stateAfter.pos.y - snap.y,
        ackRecord.stateAfter.pos.z - snap.z,
      );
      const velErrAtAck = Math.hypot(
        ackRecord.stateAfter.vel.x - snap.vx,
        ackRecord.stateAfter.vel.y - snap.vy,
        ackRecord.stateAfter.vel.z - snap.vz,
      );
      this.lastPositionError = Number(posErrAtAck.toFixed(4));
      this.maxPositionError = Math.max(this.maxPositionError, this.lastPositionError);
      this.lastAckComparison = {
        ackSeq,
        predictedAtAck: { ...ackRecord.stateAfter.pos },
        serverAtAck: { x: snap.x, y: snap.y, z: snap.z },
        errorDist: posErrAtAck,
      };

      if (
        posErrAtAck <= RECONCILE_SMOOTH_THRESHOLD &&
        velErrAtAck <= 0.08 &&
        ackRecord.stateAfter.onGround === snap.onGround
      ) {
        return {
          accepted: true,
          corrected: false,
          snapped: false,
          errorDist: posErrAtAck,
          replayedCount: 0,
        };
      }
    }

    const prevVisual = {
      x: state.pos.x + this.smoothOffset.x,
      y: state.pos.y + this.smoothOffset.y,
      z: state.pos.z + this.smoothOffset.z,
    };

    const savedYaw = state.yaw;
    const savedPitch = state.pitch;
    const savedWeapon = state.weapon;
    const savedScoped = state.scoped;

    state.pos = { x: snap.x, y: snap.y, z: snap.z };
    state.vel = { x: snap.vx, y: snap.vy, z: snap.vz };
    state.onGround = snap.onGround;

    for (let i = 0; i < this.buffer.length; i++) {
      const rec = this.buffer[i];
      stepPlayerMovement(state, rec.cmd, world);
      rec.stateAfter = cloneMovementState(state);
    }

    // Preserve local look and weapon state after replay
    state.yaw = savedYaw;
    state.pitch = savedPitch;
    state.weapon = savedWeapon;
    state.scoped = savedScoped;

    const errorDist = Math.hypot(
      prevVisual.x - state.pos.x,
      prevVisual.y - state.pos.y,
      prevVisual.z - state.pos.z,
    );
    this.lastPositionError = Number(errorDist.toFixed(4));
    this.maxPositionError = Math.max(this.maxPositionError, this.lastPositionError);

    const replayedCount = this.buffer.length;

    if (errorDist <= 0.004) {
      return {
        accepted: true,
        corrected: false,
        snapped: false,
        errorDist,
        replayedCount,
      };
    }

    if (errorDist >= RECONCILE_SNAP_THRESHOLD) {
      this.smoothOffset = { x: 0, y: 0, z: 0 };
      this.hardSnapCount++;
      return {
        accepted: true,
        corrected: true,
        snapped: true,
        errorDist,
        replayedCount,
      };
    }

    this.smoothOffset = {
      x: clamp(prevVisual.x - state.pos.x, -0.85, 0.85),
      y: clamp(prevVisual.y - state.pos.y, -0.65, 0.65),
      z: clamp(prevVisual.z - state.pos.z, -0.85, 0.85),
    };
    if (
      collidesAtWorld(
        world,
        state.pos.x + this.smoothOffset.x,
        state.pos.y + this.smoothOffset.y,
        state.pos.z + this.smoothOffset.z,
      )
    ) {
      this.smoothOffset = { x: 0, y: 0, z: 0 };
    }
    this.smoothCorrectionCount++;

    return {
      accepted: true,
      corrected: true,
      snapped: false,
      errorDist,
      replayedCount,
    };
  }

  getSmoothedPosition(physicsPos: Vec3): Vec3 {
    return {
      x: physicsPos.x + this.smoothOffset.x,
      y: physicsPos.y + this.smoothOffset.y,
      z: physicsPos.z + this.smoothOffset.z,
    };
  }

  /** Last client-predicted vs server-authoritative position at the same acked input seq (DEV overlay). */
  getLastAckComparison(): AckComparison | null {
    return this.lastAckComparison;
  }

  getDiagnostics(): PredictionDiagnostics {
    return {
      spawnId: this.spawnId,
      currentSeq: this.seq,
      lastAckedSeq: this.lastAckedSeq,
      pendingInputs: this.buffer.length,
      lastServerTick: this.lastServerTick,
      lastPositionError: this.lastPositionError,
      maxPositionError: this.maxPositionError,
      reconcileCount: this.reconcileCount,
      smoothCorrectionCount: this.smoothCorrectionCount,
      hardSnapCount: this.hardSnapCount,
      smoothOffsetMag: Number(
        Math.hypot(this.smoothOffset.x, this.smoothOffset.y, this.smoothOffset.z).toFixed(4),
      ),
    };
  }
}
