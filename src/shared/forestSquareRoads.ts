import { clamp, q3 } from './math';
import { getForestSquarePoiSites, type ForestSquarePoiId } from './structures/contracts';
import { DEFAULT_PUBLIC_LAYOUT_SEED } from './world';

export interface ForestSquareRoadSample {
  dist: number;
  blend: number;
  shoulderBlend: number;
  nearestSegmentId: string;
  tangentYaw: number;
  /** Eng yaqin yo'l segmentining yarim kengligi (metr). */
  halfWidth: number;
}

export interface ForestSquareRoadPolyline {
  id: string;
  width: number;
  points: Array<{ x: number; z: number }>;
}


function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function seedShift(seed: number, salt: number, amplitude: number): number {
  let h = Math.imul(seed ^ (salt * 374761393), 668265263);
  h = (h ^ (h >>> 13)) * 1274126177;
  const u = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  return (u * 2 - 1) * amplitude;
}

/**
 * Evaluates a centripetal/uniform Catmull-Rom spline through `controlPoints`,
 * guaranteeing that every control point (including junctions and POI `roadAnchor`s)
 * is an exact vertex of the resulting polyline.
 */
function subdivideCatmullRom(
  controlPoints: ReadonlyArray<{ x: number; z: number }>,
  subdivisionsPerSpan = 5,
): Array<{ x: number; z: number }> {
  const n = controlPoints.length;
  if (n <= 1) return controlPoints.map((p) => ({ x: q3(p.x), z: q3(p.z) }));

  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = controlPoints[Math.max(0, i - 1)]!;
    const p1 = controlPoints[i]!;
    const p2 = controlPoints[i + 1]!;
    const p3 = controlPoints[Math.min(n - 1, i + 2)]!;

    const steps = i === n - 2 ? subdivisionsPerSpan : subdivisionsPerSpan;
    for (let s = 0; s < steps; s++) {
      if (s === 0) {
        // Exact control point preservation
        out.push({ x: q3(p1.x), z: q3(p1.z) });
        continue;
      }
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;

      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const z =
        0.5 *
        (2 * p1.z +
          (-p0.z + p2.z) * t +
          (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
          (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);

      out.push({ x: q3(x), z: q3(z) });
    }
  }
  const last = controlPoints[n - 1]!;
  out.push({ x: q3(last.x), z: q3(last.z) });
  return out;
}

interface CompiledRoadSegment {
  polyId: string;
  halfWidth: number;
  ax: number;
  az: number;
  dx: number;
  dz: number;
  invLenSq: number;
  tangentYaw: number;
  midX: number;
  midZ: number;
  halfLen: number;
}

interface CachedRoadNetwork {
  polylines: ForestSquareRoadPolyline[];
  segments: CompiledRoadSegment[];
  gridCells: CompiledRoadSegment[][];
}

const GRID_DIM = 64; // 64x64 cells over [-128, 128] (each cell is 4x4 m)
const GRID_MIN = -128;
const GRID_CELL_SIZE = 256 / GRID_DIM; // 4m
const CELL_HALF_DIAG = Math.SQRT2 * (GRID_CELL_SIZE * 0.5); // ~2.828m

const roadNetworkCache = new Map<number, CachedRoadNetwork>();

function pointToSegmentDistSq(px: number, pz: number, seg: CompiledRoadSegment): number {
  const vx = px - seg.ax;
  const vz = pz - seg.az;
  const t = clamp((vx * seg.dx + vz * seg.dz) * seg.invLenSq, 0, 1);
  const ex = vx - seg.dx * t;
  const ez = vz - seg.dz * t;
  return ex * ex + ez * ez;
}

function buildCachedRoadNetwork(seed: number): CachedRoadNetwork {
  const sites = getForestSquarePoiSites(seed);
  const byId = new Map<ForestSquarePoiId, (typeof sites)[number]>();
  for (const s of sites) {
    byId.set(s.id, s);
  }

  const ranger = byId.get('poi_ranger_house')!.roadAnchor;
  const cluster = byId.get('poi_cabin_cluster')!.roadAnchor;
  const lumber = byId.get('poi_lumber_mill')!.roadAnchor;
  const service = byId.get('poi_service_station')!.roadAnchor;
  const camp = byId.get('poi_forest_camp')!.roadAnchor;
  const cliff = byId.get('poi_cliff_watch')!.roadAnchor;

  // Deterministic seed-dependent winding offsets
  const w0 = seedShift(seed, 11, 2.5);
  const w1 = seedShift(seed, 23, 3.0);
  const w2 = seedShift(seed, 37, 2.5);
  const w3 = seedShift(seed, 53, 3.0);
  const w4 = seedShift(seed, 71, 2.5);

  // Key road junctions along the main S-curve spine
  const southEntry = { x: q3(0 + w0), z: 118 };
  const jSouth = { x: q3(-8 + w1), z: q3(52 + w2 * 0.5) };
  // Central crossroads passes directly through poi_service_station's roadAnchor (~ (6, -8))
  const jCenter = { x: service.x, z: service.z };
  const jNorth = { x: q3(-8 + w3), z: q3(-58 + w4 * 0.5) };
  const northExit = { x: q3(4 - w0), z: -118 };

  // 1. Main winding forest road (South entrance -> Central-South -> Central crossroads -> North junction -> North exit)
  const mainRoadPoints = subdivideCatmullRom(
    [
      southEntry,
      { x: q3(-3 + w2), z: 86 },
      jSouth,
      { x: q3(-2 - w1), z: 22 },
      jCenter,
      { x: q3(-1 + w4), z: -33 },
      jNorth,
      { x: q3(-2 - w3), z: -88 },
      northExit,
    ],
    4,
  );

  // 2. Branch 1 (NW): North junction -> poi_ranger_house.roadAnchor
  const branchNwPoints = subdivideCatmullRom(
    [
      jNorth,
      { x: q3(-26 + w1 * 0.6), z: q3(-53 + w2 * 0.6) },
      { x: q3(-46 - w3 * 0.5), z: q3(-50 - w1 * 0.5) },
      ranger,
    ],
    4,
  );

  // 3. Branch 2 (NE): North junction -> poi_cabin_cluster.roadAnchor
  const branchNePoints = subdivideCatmullRom(
    [
      jNorth,
      { x: q3(12 + w2 * 0.5), z: q3(-52 + w3 * 0.5) },
      { x: q3(33 - w4 * 0.5), z: q3(-58 - w0 * 0.5) },
      cluster,
    ],
    4,
  );

  // 4. Branch 3 (W): Central crossroads -> poi_lumber_mill.roadAnchor
  const branchWLumberPoints = subdivideCatmullRom(
    [
      jCenter,
      { x: q3(-16 + w0 * 0.6), z: q3(-2 + w2 * 0.5) },
      { x: q3(-39 - w1 * 0.5), z: q3(8 - w3 * 0.5) },
      lumber,
    ],
    4,
  );

  // 5. Western Loop Trail: poi_lumber_mill.roadAnchor -> poi_forest_camp.roadAnchor
  const trailWLoopPoints = subdivideCatmullRom(
    [
      lumber,
      { x: q3(-58 + w2 * 0.6), z: q3(31 + w0 * 0.5) },
      { x: q3(-54 - w4 * 0.6), z: q3(48 - w1 * 0.5) },
      camp,
    ],
    4,
  );

  // 6. Branch 4 (SW): Central-South junction -> poi_forest_camp.roadAnchor
  const branchSwCampPoints = subdivideCatmullRom(
    [
      jSouth,
      { x: q3(-22 + w3 * 0.5), z: q3(56 + w1 * 0.5) },
      { x: q3(-35 - w2 * 0.5), z: q3(62 - w0 * 0.5) },
      camp,
    ],
    4,
  );

  // 7. Branch 5 (SE): Central-South junction -> poi_cliff_watch.roadAnchor -> Central crossroads (poi_service_station)
  const branchSeCliffPoints = subdivideCatmullRom(
    [
      jSouth,
      { x: q3(14 + w1 * 0.5), z: q3(58 + w3 * 0.5) },
      { x: q3(36 - w0 * 0.5), z: q3(62 - w2 * 0.5) },
      cliff,
      { x: q3(36 + w4 * 0.5), z: q3(38 + w1 * 0.5) },
      { x: q3(16 - w2 * 0.5), z: q3(18 - w3 * 0.5) },
      jCenter,
    ],
    4,
  );

  const polylines: ForestSquareRoadPolyline[] = [
    { id: 'main_road', width: 3.8, points: mainRoadPoints },
    { id: 'branch_nw_ranger', width: 3.0, points: branchNwPoints },
    { id: 'branch_ne_cluster', width: 3.0, points: branchNePoints },
    { id: 'branch_w_lumber', width: 3.2, points: branchWLumberPoints },
    { id: 'trail_w_loop', width: 2.6, points: trailWLoopPoints },
    { id: 'branch_sw_camp', width: 3.0, points: branchSwCampPoints },
    { id: 'branch_se_cliff', width: 3.0, points: branchSeCliffPoints },
  ];

  const segments: CompiledRoadSegment[] = [];
  for (const poly of polylines) {
    const halfWidth = poly.width * 0.5;
    const pts = poly.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 1e-6) continue;
      const len = Math.sqrt(lenSq);
      segments.push({
        polyId: poly.id,
        halfWidth,
        ax: a.x,
        az: a.z,
        dx,
        dz,
        invLenSq: 1 / lenSq,
        tangentYaw: Math.atan2(dx, dz),
        midX: (a.x + b.x) * 0.5,
        midZ: (a.z + b.z) * 0.5,
        halfLen: len * 0.5,
      });
    }
  }

  // Build exact spatial acceleration grid (triangle-inequality certified bucket pruning)
  const gridCells: CompiledRoadSegment[][] = new Array(GRID_DIM * GRID_DIM);
  const segDists = new Float64Array(segments.length);

  for (let gz = 0; gz < GRID_DIM; gz++) {
    const cz = GRID_MIN + (gz + 0.5) * GRID_CELL_SIZE;
    for (let gx = 0; gx < GRID_DIM; gx++) {
      const cx = GRID_MIN + (gx + 0.5) * GRID_CELL_SIZE;
      let minCenterDist = Infinity;

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        const d = Math.sqrt(pointToSegmentDistSq(cx, cz, seg));
        segDists[i] = d;
        if (d < minCenterDist) {
          minCenterDist = d;
        }
      }

      // Any segment that could possibly be closest to any point in this cell
      // has distance from cell center <= minCenterDist + 2 * CELL_HALF_DIAG
      const threshold = minCenterDist + 2 * CELL_HALF_DIAG + 0.25;
      const cellBucket: CompiledRoadSegment[] = [];
      for (let i = 0; i < segments.length; i++) {
        if (segDists[i]! <= threshold) {
          cellBucket.push(segments[i]!);
        }
      }
      gridCells[gz * GRID_DIM + gx] = cellBucket;
    }
  }

  return { polylines, segments, gridCells };
}

function getCachedRoadNetwork(seed: number): CachedRoadNetwork {
  const key = seed | 0;
  let cached = roadNetworkCache.get(key);
  if (!cached) {
    cached = buildCachedRoadNetwork(key);
    roadNetworkCache.set(key, cached);
  }
  return cached;
}

/**
 * Returns the full deterministic road polyline network for `forest_square` (256x256 m).
 */
export function getForestSquareRoadNetwork(
  seed = DEFAULT_PUBLIC_LAYOUT_SEED,
): ForestSquareRoadPolyline[] {
  return getCachedRoadNetwork(seed).polylines;
}

/**
 * Samples the `forest_square` road network at world XZ coordinates `(x, z)`.
 * Uses a seed-cached spatial grid so 16,641 terrain/color queries execute in < 5 ms.
 */
export function sampleForestSquareRoad(
  x: number,
  z: number,
  seed = DEFAULT_PUBLIC_LAYOUT_SEED,
): ForestSquareRoadSample {
  const net = getCachedRoadNetwork(seed);
  const gx = clamp(Math.floor((x - GRID_MIN) / GRID_CELL_SIZE), 0, GRID_DIM - 1);
  const gz = clamp(Math.floor((z - GRID_MIN) / GRID_CELL_SIZE), 0, GRID_DIM - 1);
  const bucket = net.gridCells[gz * GRID_DIM + gx] ?? net.segments;

  let bestDistSq = Infinity;
  let bestSeg = bucket[0] ?? net.segments[0]!;

  for (let i = 0; i < bucket.length; i++) {
    const seg = bucket[i]!;
    const distSq = pointToSegmentDistSq(x, z, seg);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestSeg = seg;
    }
  }

  const dist = Math.sqrt(bestDistSq);
  const hw = bestSeg.halfWidth;
  if (dist > hw + 2.95) {
    return {
      dist,
      blend: 0,
      shoulderBlend: 0,
      nearestSegmentId: bestSeg.polyId,
      tangentYaw: bestSeg.tangentYaw,
      halfWidth: hw,
    };
  }

  const blend = 1 - smoothstep(hw * 0.72, hw + 1.35, dist);
  const shoulderCenter = hw + 0.55;
  const shoulderBlend =
    (1 - smoothstep(1.0, 2.35, Math.abs(dist - shoulderCenter))) * (1 - blend * 0.65);

  return {
    dist,
    blend,
    shoulderBlend,
    nearestSegmentId: bestSeg.polyId,
    tangentYaw: bestSeg.tangentYaw,
    halfWidth: hw,
  };
}
