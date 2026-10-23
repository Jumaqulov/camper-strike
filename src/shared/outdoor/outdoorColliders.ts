import type { Vec3 } from '../math';
import type { ColliderBox } from '../world';
import type { OutdoorAssetId, OutdoorPlacement } from './contracts';

const q3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface OutdoorLocalColliderSpec {
  name: string;
  center: readonly [number, number, number];
  size: readonly [number, number, number];
  tag: 'prop' | 'structure';
  mat: 'crate' | 'wall' | 'metal';
  /**
   * STAGE 08-FIX: `'invariant'` marks parts whose horizontal footprint is (approximately) round or a thin
   * post, so the world AABB is the unrotated `size.x × size.z` box at the rotated centre regardless of yaw
   * (identical to the legacy result at axis-aligned yaws for square footprints). Default `'rotate'`.
   */
  yawMode?: 'rotate' | 'invariant';
}

/**
 * STAGE 08-FIX: max allowed world-AABB overshoot (m) beyond the true yawed rectangle of a collider piece.
 * A `w × t` rectangle rotated by θ has an AABB whose corner triangles reach `max(w, t) · |sin 2θ| / 2`
 * beyond the rectangle edges.
 */
export const OUTDOOR_ROTATED_SEGMENT_TOLERANCE = 0.06;
/** STAGE 08-FIX: hard cap of strips along the longest local axis for one rotated collider part. */
export const OUTDOOR_ROTATED_MAX_SEGMENTS = 24;
/** STAGE 08-FIX: hard cap of total AABB pieces (strips + end-cap cells) for one rotated collider part. */
export const OUTDOOR_ROTATED_MAX_PIECES = 32;
/** STAGE 08-FIX: yaws within this distance (rad) of a multiple of π/2 are treated as axis-aligned. */
export const OUTDOOR_AXIS_ALIGNED_YAW_EPS = 1e-3;

const UPRIGHT_BARREL_SPECS: readonly OutdoorLocalColliderSpec[] = [
  {
    name: 'barrel',
    center: [0, 0.45, 0],
    size: [0.58, 0.9, 0.58],
    tag: 'prop',
    mat: 'metal',
    // Upright cylinder (GLB radius ≈ 0.298 m): footprint does not change with yaw
    yawMode: 'invariant',
  },
];

const TIPPED_BARREL_SPECS: readonly OutdoorLocalColliderSpec[] = [
  {
    name: 'barrel_tipped',
    center: [-0.45, 0, 0],
    size: [0.9, 0.58, 0.58],
    tag: 'prop',
    mat: 'metal',
  },
];

export const OUTDOOR_STATIC_COLLIDER_SPECS: Record<
  Exclude<OutdoorAssetId, 'rusty_barrel_01'>,
  readonly OutdoorLocalColliderSpec[]
> = {
  wooden_signpost_01: [
    // Only the central vertical post has a collider; high signboards (y = 1.25..1.85m) are collider-free
    {
      name: 'post',
      center: [0, 1.0, 0],
      size: [0.16, 2.0, 0.16],
      tag: 'prop',
      mat: 'crate',
      // Thin 0.16 m post: rotation-invariant box (a yawed post's corners poke out of it by ≤ 0.034 m)
      yawMode: 'invariant',
    },
  ],
  lumber_stack_01: [
    {
      name: 'stack',
      center: [0, 0.525, 0],
      size: [2.3, 1.05, 1.25],
      tag: 'prop',
      mat: 'crate',
    },
  ],
  sawhorse_01: [
    {
      name: 'frame',
      center: [0, 0.51, 0],
      size: [1.58, 1.02, 0.82],
      tag: 'prop',
      mat: 'crate',
    },
  ],
  old_fuel_pump_01: [
    {
      name: 'base',
      center: [0, 0.04, 0],
      size: [0.7, 0.08, 0.6],
      tag: 'prop',
      mat: 'wall',
    },
    {
      name: 'body',
      center: [0, 0.73, 0],
      size: [0.56, 1.32, 0.42],
      tag: 'prop',
      mat: 'metal',
    },
  ],
  forest_tent_01: [
    // Segmented into 5 thin perimeter wall strips so the +Z entrance and interior cavity remain open.
    // STAGE 08-FIX: re-fitted to the measured GLB (`forest_tent_01.glb`, no node transforms):
    //   A-frame fabric x ∈ [-1.02, 1.02] at ground, half-width ≈ 1.02 − 0.69·y, ridge y ≈ 1.55..1.60;
    //   side slopes span z ∈ [-1.20, +1.15]; closed back gable at z ≈ -1.20; the +Z gable is fully open
    //   (door flaps folded back along the sides at |x| ≈ 0.83..0.90, z ≈ 0.75..1.15); thin 4 cm poles at
    //   x = 0, z ≈ ±1.18 (front pole intentionally collider-free so the doorway is not split).
    // Side walls occupy the strip where the fabric is below ≈0.32 m (|x| ∈ [0.80, 1.02]), so the walkable
    // interior is 1.60 m wide (0.8 m player body + 0.4 m clearance per side) and the doorway is open for
    // |x| < 0.80, matching the visual opening at knee height. Height 1.45 m > max jump apex
    // (JUMP_SPEED² / 2·GRAVITY ≈ 1.31 m) so walls cannot be jumped through.
    {
      name: 'left_wall_front',
      center: [-0.91, 0.725, 0.575],
      size: [0.22, 1.45, 1.15],
      tag: 'structure',
      mat: 'crate',
    },
    {
      name: 'left_wall_back',
      center: [-0.91, 0.725, -0.6],
      size: [0.22, 1.45, 1.2],
      tag: 'structure',
      mat: 'crate',
    },
    {
      name: 'right_wall_front',
      center: [0.91, 0.725, 0.575],
      size: [0.22, 1.45, 1.15],
      tag: 'structure',
      mat: 'crate',
    },
    {
      name: 'right_wall_back',
      center: [0.91, 0.725, -0.6],
      size: [0.22, 1.45, 1.2],
      tag: 'structure',
      mat: 'crate',
    },
    {
      name: 'back_wall',
      center: [0, 0.725, -1.2],
      size: [2.04, 1.45, 0.14],
      tag: 'structure',
      mat: 'crate',
    },
  ],
  campfire_pit_01: [
    // Low stone ring obstacle (height = 0.22m <= STEP_HEIGHT, no fire damage in Stage 08A)
    {
      name: 'ring',
      center: [0, 0.11, 0],
      size: [1.12, 0.22, 1.12],
      tag: 'prop',
      mat: 'wall',
      // Circular stone ring: footprint does not change with yaw
      yawMode: 'invariant',
    },
  ],
  wooden_railing_01: [
    // 3.0m modular barrier (height = 1.1m > STEP_HEIGHT, blocks player movement across railing)
    {
      name: 'barrier',
      center: [0, 0.55, 0],
      size: [3.0, 1.1, 0.18],
      tag: 'structure',
      mat: 'crate',
    },
  ],
};

/**
 * Resolves the local collider part specifications for an `OutdoorPlacement`.
 */
export function getOutdoorLocalColliderSpecs(
  placement: OutdoorPlacement,
): readonly OutdoorLocalColliderSpec[] {
  if (placement.assetId === 'rusty_barrel_01') {
    const rotZ = Math.abs(placement.rotationZ ?? 0);
    const rotX = Math.abs(placement.rotationX ?? 0);
    if (rotZ < 0.4 && rotX < 0.4) {
      return UPRIGHT_BARREL_SPECS;
    }
    return TIPPED_BARREL_SPECS;
  }
  return OUTDOOR_STATIC_COLLIDER_SPECS[placement.assetId];
}

/**
 * STAGE 08-FIX: true when `yaw` lies within `OUTDOOR_AXIS_ALIGNED_YAW_EPS` of a multiple of π/2
 * (e.g. the q3-rounded 1.571 / 3.142 yaws used by the layout generator).
 */
export function isOutdoorYawAxisAligned(yaw: number): boolean {
  const quarter = Math.PI / 2;
  const k = yaw / quarter;
  return Math.abs(k - Math.round(k)) * quarter < OUTDOOR_AXIS_ALIGNED_YAW_EPS;
}

/** One horizontal piece of a collider part, in the part's scaled local frame (offsets from part centre). */
interface LocalPiece {
  dx: number;
  dz: number;
  sx: number;
  sz: number;
}

/**
 * STAGE 08-FIX: yaw-aware segmentation of a rotated `lenX × lenZ` local rectangle into pieces whose world
 * AABBs overshoot the true rotated rectangle by at most `tol` (≈ `OUTDOOR_ROTATED_SEGMENT_TOLERANCE`).
 *
 * Geometry: a `w × t` rectangle at yaw θ has an AABB whose 4 empty corner triangles each have one rectangle
 * edge as hypotenuse and reach `edge · k` beyond it, k = |sin 2θ| / 2. A triangle on an edge shared with a
 * neighbour piece stays inside the part rectangle as long as its depth does not run past the part's end.
 *   - Split along the longest local axis (length L) into `Nl = ceil(L·k / tol)` strips of length l = L/Nl
 *     → every piece's outer long edge is ≤ l, overshoot ≤ tol.
 *   - Strip i whose near cut line lies `d_i = min(i, Nl−1−i)·l` from the part end is further split across
 *     the short axis (thickness T) into `Ns_i = ceil(T·k / (d_i + tol))` cells, so the triangle on its
 *     end-facing edge (depth ≤ (T/Ns_i)·k) ends within `tol` of the part end face (Ns_0 = ceil(T·k/tol)).
 *   - If `Nl > OUTDOOR_ROTATED_MAX_SEGMENTS` or `ΣNs_i > OUTDOOR_ROTATED_MAX_PIECES`, `tol` is relaxed by
 *     ×1.05 steps (deterministic) until both caps hold.
 * Returns `null` when the unsplit part already satisfies the tolerance.
 */
function segmentRotatedRect(lenX: number, lenZ: number, yaw: number): LocalPiece[] | null {
  const k = Math.abs(Math.sin(2 * yaw)) / 2;
  const longIsX = lenX >= lenZ;
  const L = longIsX ? lenX : lenZ;
  const T = longIsX ? lenZ : lenX;
  if (L * k <= OUTDOOR_ROTATED_SEGMENT_TOLERANCE + 1e-9) return null;

  let tol = OUTDOOR_ROTATED_SEGMENT_TOLERANCE;
  let nl = 1;
  let cellsPerStrip: number[] = [1];
  for (let guard = 0; guard < 200; guard++) {
    nl = Math.max(1, Math.ceil(L * k / tol - 1e-9));
    const l = L / nl;
    cellsPerStrip = [];
    let total = 0;
    for (let i = 0; i < nl; i++) {
      const d = Math.min(i, nl - 1 - i) * l;
      const ns = Math.max(1, Math.ceil(T * k / (d + tol) - 1e-9));
      cellsPerStrip.push(ns);
      total += ns;
    }
    if (nl <= OUTDOOR_ROTATED_MAX_SEGMENTS && total <= OUTDOOR_ROTATED_MAX_PIECES) break;
    tol *= 1.05;
  }

  const pieces: LocalPiece[] = [];
  const l = L / nl;
  for (let i = 0; i < nl; i++) {
    const u = -L / 2 + (i + 0.5) * l;
    const ns = cellsPerStrip[i];
    const tw = T / ns;
    for (let j = 0; j < ns; j++) {
      const v = -T / 2 + (j + 0.5) * tw;
      pieces.push(longIsX ? { dx: u, dz: v, sx: l, sz: tw } : { dx: v, dz: u, sx: tw, sz: l });
    }
  }
  return pieces;
}

/**
 * Compiles deterministic, gameplay-accurate world-space `ColliderBox[]` for a single `OutdoorPlacement`.
 *
 * STAGE 08-FIX: for yaws that are not axis-aligned, each `'rotate'` part is split into yaw-aware pieces
 * (see `segmentRotatedRect`) so world AABBs no longer bulge into tent interiors or form phantom walls next
 * to long railings. Split pieces get IDs `${placement.id}:col:${part.name}_s${i}`; unsplit parts (all
 * axis-aligned placements, `'invariant'` parts, and parts already within tolerance) keep the legacy
 * `${placement.id}:col:${part.name}` ID and the exact legacy box.
 */
export function buildOutdoorPlacementColliders(placement: OutdoorPlacement): ColliderBox[] {
  const parts = getOutdoorLocalColliderSpecs(placement);
  const yaw = placement.rotationY;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const axisAligned = isOutdoorYawAxisAligned(yaw);

  const sxScale = placement.scale?.x ?? 1;
  const syScale = placement.scale?.y ?? 1;
  const szScale = placement.scale?.z ?? 1;

  const out: ColliderBox[] = [];
  const emit = (
    id: string,
    part: OutdoorLocalColliderSpec,
    rx: number,
    ry: number,
    rz: number,
    lenX: number,
    lenY: number,
    lenZ: number,
    invariant: boolean,
  ): void => {
    const worldCx = placement.position.x + rx * cos + rz * sin;
    const worldCy = placement.position.y + ry;
    const worldCz = placement.position.z - rx * sin + rz * cos;

    const halfX = invariant ? 0.5 * lenX : 0.5 * (Math.abs(lenX * cos) + Math.abs(lenZ * sin));
    const halfY = 0.5 * lenY;
    const halfZ = invariant ? 0.5 * lenZ : 0.5 * (Math.abs(lenX * sin) + Math.abs(lenZ * cos));

    out.push({
      id,
      tag: part.tag,
      sourceObjectId: placement.id,
      mat: part.mat,
      min: {
        x: q3(worldCx - halfX),
        y: q3(worldCy - halfY),
        z: q3(worldCz - halfZ),
      },
      max: {
        x: q3(worldCx + halfX),
        y: q3(worldCy + halfY),
        z: q3(worldCz + halfZ),
      },
    });
  };

  for (const part of parts) {
    const [cx, cy, cz] = part.center;
    const [sx, sy, sz] = part.size;

    const rx = cx * sxScale;
    const ry = cy * syScale;
    const rz = cz * szScale;
    const lenX = sx * sxScale;
    const lenY = sy * syScale;
    const lenZ = sz * szScale;
    // Axis-aligned placements always use the legacy formula so their boxes stay bit-identical.
    const invariant = part.yawMode === 'invariant' && !axisAligned;

    const pieces = invariant || axisAligned ? null : segmentRotatedRect(lenX, lenZ, yaw);
    if (!pieces) {
      emit(`${placement.id}:col:${part.name}`, part, rx, ry, rz, lenX, lenY, lenZ, invariant);
      continue;
    }
    pieces.forEach((piece, i) => {
      emit(
        `${placement.id}:col:${part.name}_s${i}`,
        part,
        rx + piece.dx,
        ry,
        rz + piece.dz,
        piece.sx,
        lenY,
        piece.sz,
        false,
      );
    });
  }
  return out;
}

/**
 * Compiles all `ColliderBox[]` across a list of `OutdoorPlacement` instances.
 */
export function compileAllOutdoorColliders(
  placements: readonly OutdoorPlacement[],
): ColliderBox[] {
  const colliders: ColliderBox[] = [];
  for (const placement of placements) {
    colliders.push(...buildOutdoorPlacementColliders(placement));
  }
  return colliders;
}

/**
 * Returns the world-space interior cavity sample point inside a `forest_tent_01` placement.
 */
export function getOutdoorTentInteriorPoint(placement: OutdoorPlacement): Vec3 {
  return {
    x: q3(placement.position.x),
    y: q3(placement.position.y + 0.5),
    z: q3(placement.position.z),
  };
}

/**
 * Returns a world-space point outside the open `+Z` entrance of a `forest_tent_01` placement.
 */
export function getOutdoorTentEntrancePoint(
  placement: OutdoorPlacement,
  distFromCenter = 1.35,
): Vec3 {
  const yaw = placement.rotationY;
  return {
    x: q3(placement.position.x + Math.sin(yaw) * distFromCenter),
    y: q3(placement.position.y + 0.5),
    z: q3(placement.position.z + Math.cos(yaw) * distFromCenter),
  };
}
