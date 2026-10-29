import { clamp } from '../shared/math';
import {
  MAX_INPUT_BATCH_SIZE,
  MAX_INPUT_DT,
  MAX_INPUT_QUEUE_SIZE,
  MAX_SIM_TIME_PER_TICK,
  sanitizePlayerInputCmd,
  stepNeutralMovement,
  stepPlayerMovement,
} from '../shared/netMovement';
import type { Body } from '../shared/physics';
import type { PlayerInputCmd } from '../shared/protocol';
import type { WeaponId } from '../shared/weapons';
import type { WorldDefinition } from '../shared/world';

export interface MovementAuthorityStats {
  acceptedInputs: number;
  processedInputs: number;
  rejectedInvalid: number;
  rejectedSpawnMismatch: number;
  rejectedDuplicateOrOld: number;
  rejectedOutOfOrder: number;
  rejectedQueueFull: number;
  rejectedLegacyState: number;
  starvationSteps: number;
  speedhackClampedSec: number;
  /** Tarmoq uzilishidan keyin seq oralig'i qayta sinxronlangan holatlar soni. */
  stallResyncs: number;
}

const INITIAL_SIM_CREDIT_SEC = 0.16;
const MAX_SIM_CREDIT_SEC = 0.24;
const SIM_CREDIT_REPLENISH_RATE = 1.05;
const STARVATION_GRACE_SEC = 0.065;
const MAX_BUFFERED_QUEUE_SIM_SEC = 0.1;
/** Server tick'i shu vaqtdan uzoqroq kechiksa (GC, taymer stall), yetib olish uchun qo'shimcha budjet beriladi. */
const SERVER_STALL_THRESHOLD_SEC = 0.1;
const MAX_SERVER_STALL_CATCHUP_SEC = 0.5;

/**
 * Per-player server-side movement authority.
 * Validates, sanitizes, and queues client input commands (`PlayerInputCmd`),
 * enforces anti-speedhack simulation time budgets, and steps authoritative physics.
 */
export class PlayerMovementAuthority {
  spawnId = 0;
  lastQueuedSeq = 0;
  lastProcessedSeq = 0;
  readonly queue: PlayerInputCmd[] = [];
  simTimeCreditSec = INITIAL_SIM_CREDIT_SEC;
  timeSinceLastInputSec = 0;
  /**
   * Server o'zi qurolni almashtirganda (pickup auto-equip, inventory:equip) klientning hali eski qurolni
   * ko'rsatayotgan, yo'lda kelayotgan kirishlari serverni orqaga qaytarmasligi uchun qo'riqlash.
   */
  private revertGuardWeapon: WeaponId | null = null;
  private revertGuardThroughSeq = 0;
  private revertGuardActive = false;

  readonly stats: MovementAuthorityStats = {
    acceptedInputs: 0,
    processedInputs: 0,
    rejectedInvalid: 0,
    rejectedSpawnMismatch: 0,
    rejectedDuplicateOrOld: 0,
    rejectedOutOfOrder: 0,
    rejectedQueueFull: 0,
    rejectedLegacyState: 0,
    starvationSteps: 0,
    speedhackClampedSec: 0,
    stallResyncs: 0,
  };

  resetForSpawn(spawnId: number): void {
    this.spawnId = spawnId;
    this.lastQueuedSeq = 0;
    this.lastProcessedSeq = 0;
    this.queue.length = 0;
    this.simTimeCreditSec = INITIAL_SIM_CREDIT_SEC;
    this.timeSinceLastInputSec = 0;
    this.revertGuardActive = false;
  }

  /**
   * Server tomonidan boshlangan qurol almashtirishdan keyin chaqiriladi: `prevWeapon` ga qaytaruvchi,
   * seq ≤ lastQueuedSeq + window bo'lgan kirishlar e'tiborsiz qoldiriladi (klient ack olguncha yuborganlari).
   */
  guardWeaponRevert(prevWeapon: WeaponId | null, windowInputs = 24): void {
    this.revertGuardWeapon = prevWeapon;
    this.revertGuardThroughSeq = this.lastQueuedSeq + windowInputs;
    this.revertGuardActive = true;
  }

  clear(): void {
    this.queue.length = 0;
    this.timeSinceLastInputSec = 0;
  }

  recordRejectedLegacyState(): void {
    this.stats.rejectedLegacyState++;
  }

  enqueueInputPacket(
    rawPacket: unknown,
    currentWeapon: WeaponId | null = 'rifle',
  ): { accepted: number; rejected: number; ping?: number } {
    if (!rawPacket || typeof rawPacket !== 'object' || Array.isArray(rawPacket)) {
      this.stats.rejectedInvalid++;
      return { accepted: 0, rejected: 1 };
    }

    const obj = rawPacket as Record<string, unknown>;
    let ping: number | undefined;
    if (typeof obj.ping === 'number' && Number.isFinite(obj.ping)) {
      ping = clamp(Math.round(obj.ping), 0, 9999);
    }

    const isBatch = 'inputs' in obj;
    let rawItems: unknown[];

    if (isBatch) {
      if (
        !Array.isArray(obj.inputs) ||
        obj.inputs.length === 0 ||
        obj.inputs.length > MAX_INPUT_BATCH_SIZE
      ) {
        this.stats.rejectedInvalid++;
        return { accepted: 0, rejected: 1, ping };
      }
      if ('spawnId' in obj && obj.spawnId !== undefined) {
        if (typeof obj.spawnId !== 'number' || !Number.isInteger(obj.spawnId) || obj.spawnId < 0) {
          this.stats.rejectedInvalid++;
          return { accepted: 0, rejected: 1, ping };
        }
        if (obj.spawnId !== this.spawnId) {
          this.stats.rejectedSpawnMismatch++;
          return { accepted: 0, rejected: obj.inputs.length, ping };
        }
      }
      rawItems = obj.inputs;
    } else {
      rawItems = [rawPacket];
    }

    const initialLastQueuedSeq = this.lastQueuedSeq;
    const hasNewerSeqInBatch =
      isBatch &&
      rawItems.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const c = item as Record<string, unknown>;
        return (
          typeof c.seq === 'number' &&
          Number.isInteger(c.seq) &&
          c.seq > initialLastQueuedSeq &&
          c.spawnId === this.spawnId
        );
      });

    let accepted = 0;
    let rejected = 0;
    let prevBatchSeq = 0;

    for (const rawItem of rawItems) {
      const cmd = sanitizePlayerInputCmd(rawItem, currentWeapon);
      if (!cmd) {
        this.stats.rejectedInvalid++;
        rejected++;
        continue;
      }

      if (cmd.spawnId !== this.spawnId) {
        this.stats.rejectedSpawnMismatch++;
        rejected++;
        continue;
      }

      if (isBatch && cmd.seq <= prevBatchSeq) {
        this.stats.rejectedDuplicateOrOld++;
        if (cmd.seq < prevBatchSeq) {
          this.stats.rejectedOutOfOrder++;
        }
        rejected++;
        continue;
      }
      prevBatchSeq = cmd.seq;

      if (cmd.seq <= this.lastProcessedSeq || cmd.seq <= this.lastQueuedSeq) {
        if (isBatch && hasNewerSeqInBatch) {
          // Redundant prefix in a valid packet-loss resilience batch; silently skip
          continue;
        }
        this.stats.rejectedDuplicateOrOld++;
        if (cmd.seq < this.lastQueuedSeq) {
          this.stats.rejectedOutOfOrder++;
        }
        rejected++;
        continue;
      }

      if (cmd.seq > this.lastQueuedSeq + MAX_INPUT_QUEUE_SIZE) {
        // Tarmoq uzilishi (burst) dan keyin navbat to'lib, lastQueuedSeq orqada qolib ketgan bo'lishi mumkin.
        // Navbat to'liq bo'shagan bo'lsa, eski kirishlarni yo'qotilgan deb hisoblab, yangi seq ga qayta sinxronlanamiz —
        // aks holda o'yinchi shu hayot davomida abadiy muzlab qoladi.
        if (this.queue.length === 0 && cmd.seq > this.lastProcessedSeq) {
          this.stats.stallResyncs++;
          this.lastQueuedSeq = cmd.seq - 1;
          this.lastProcessedSeq = Math.max(this.lastProcessedSeq, cmd.seq - 1);
        } else {
          this.stats.rejectedOutOfOrder++;
          rejected++;
          continue;
        }
      }

      if (this.queue.length >= MAX_INPUT_QUEUE_SIZE) {
        this.stats.rejectedQueueFull++;
        rejected++;
        continue;
      }

      this.queue.push(cmd);
      this.lastQueuedSeq = cmd.seq;
      this.stats.acceptedInputs++;
      accepted++;
    }

    return { accepted, rejected, ping };
  }

  stepAuthoritativeTick(
    player: Body & {
      yaw: number;
      pitch: number;
      weapon: WeaponId | null;
      scoped?: boolean;
      reloadWeapon?: WeaponId | null;
      stamina?: number;
      staminaLocked?: boolean;
    },
    serverDt: number,
    world: WorldDefinition,
    canEquipWeapon?: (w: WeaponId | null) => boolean,
    /** Haqiqiy o'tgan server vaqti (clamp qilinmagan). Server stall'dan keyin yetib olish budjeti uchun. */
    rawElapsedSec: number = serverDt,
    /**
     * wolf_night yiqilgan holat: kirishlar qabul qilinadi (seq tasdiqlanadi, yaw/pitch qo'llanadi), lekin
     * harakat/sakrash/o'tirish nolga tenglashtiriladi — faqat gravitatsiya ishlaydi.
     */
    opts?: { lockMovement?: boolean },
  ): number {
    const lockMovement = opts?.lockMovement === true;
    const safeServerDt = clamp(serverDt, 0.001, 0.1);
    // Server o'zi kechikkan bo'lsa (GC pauza, Windows taymer stall), halol klientning to'planib qolgan
    // kirishlari "speedhack" deb tashlanmasligi uchun kechikish miqdoricha qo'shimcha budjet beramiz.
    const stallCatchup = Number.isFinite(rawElapsedSec)
      ? clamp(rawElapsedSec - SERVER_STALL_THRESHOLD_SEC, 0, MAX_SERVER_STALL_CATCHUP_SEC)
      : 0;
    this.simTimeCreditSec = Math.min(
      MAX_SIM_CREDIT_SEC + stallCatchup,
      this.simTimeCreditSec + Math.max(safeServerDt, Math.min(rawElapsedSec || 0, MAX_SERVER_STALL_CATCHUP_SEC)) * SIM_CREDIT_REPLENISH_RATE,
    );

    let simTimeUsedThisTick = 0;
    let processedThisTick = 0;
    const maxTickBudget = Math.min(this.simTimeCreditSec, MAX_SIM_TIME_PER_TICK + stallCatchup);

    while (this.queue.length > 0) {
      const cmd = this.queue[0];
      if (simTimeUsedThisTick + cmd.dt > maxTickBudget) {
        if (processedThisTick > 0 || this.simTimeCreditSec < cmd.dt) {
          let queuedSimSec = 0;
          for (const q of this.queue) queuedSimSec += q.dt;
          if (this.queue.length > 8 || queuedSimSec > MAX_BUFFERED_QUEUE_SIM_SEC) {
            while (
              this.queue.length > 6 ||
              (this.queue.length > 1 && queuedSimSec > MAX_BUFFERED_QUEUE_SIM_SEC)
            ) {
              const excess = this.queue.shift()!;
              queuedSimSec -= excess.dt;
              this.lastProcessedSeq = excess.seq;
              this.stats.speedhackClampedSec += excess.dt;
            }
          }
        }
        break;
      }

      this.queue.shift();
      this.simTimeCreditSec = Math.max(0, this.simTimeCreditSec - cmd.dt);
      simTimeUsedThisTick += cmd.dt;

      if (this.revertGuardActive && cmd.seq > this.revertGuardThroughSeq) {
        this.revertGuardActive = false;
      }
      if (cmd.weapon !== player.weapon) {
        const revertingToOld = this.revertGuardActive && cmd.weapon === this.revertGuardWeapon;
        const allowed = !revertingToOld && (canEquipWeapon ? canEquipWeapon(cmd.weapon) : true);
        if (allowed) {
          player.weapon = cmd.weapon;
          player.reloadWeapon = null;
        } else {
          cmd.weapon = player.weapon;
          cmd.scoped = player.weapon === 'sniper' ? Boolean(cmd.scoped) : false;
        }
      }
      player.scoped = player.weapon === 'sniper' ? cmd.scoped : false;
      player.yaw = cmd.yaw;
      player.pitch = cmd.pitch;

      if (lockMovement) {
        cmd.moveForward = 0;
        cmd.moveRight = 0;
        cmd.jump = false;
        cmd.walk = false;
        cmd.crouch = false;
        player.scoped = false;
      }
      stepPlayerMovement(player, cmd, world);

      this.lastProcessedSeq = cmd.seq;
      this.stats.processedInputs++;
      processedThisTick++;
      this.timeSinceLastInputSec = 0;
    }

    if (processedThisTick === 0) {
      this.timeSinceLastInputSec += safeServerDt;
      if (
        this.timeSinceLastInputSec >= STARVATION_GRACE_SEC &&
        (!player.onGround || Math.hypot(player.vel.x, player.vel.y, player.vel.z) > 0.01)
      ) {
        stepNeutralMovement(player, Math.min(safeServerDt, MAX_INPUT_DT), world);
        this.stats.starvationSteps++;
      }
    }

    return processedThisTick;
  }
}
