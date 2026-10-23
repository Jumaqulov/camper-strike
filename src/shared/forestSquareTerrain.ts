import { clamp } from './math';
import { sampleForestSquareRoad } from './forestSquareRoads';
import {
  FOREST_SQUARE_CELL_SIZE,
  FOREST_SQUARE_HALF,
  FOREST_SQUARE_SIZE,
  getForestSquarePoiSites,
  type ForestSquarePoiSiteSpec,
} from './structures/contracts';
import { DEFAULT_MAX_WALKABLE_SLOPE_DEG } from './terrain';
import { DEFAULT_PUBLIC_LAYOUT_SEED, type HeightfieldTerrainDescriptor } from './world';

const q3 = (n: number): number => Math.round(n * 1000) / 1000;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Deterministic 2D smooth value noise (pure TypeScript, no external dependencies).
 */
function hash2D(ix: number, iz: number, seed: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041);
  n = (n ^ (n >>> 13)) * 1274126177;
  return (((n ^ (n >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}

function smoothNoise2D(x: number, z: number, scale: number, seed: number): number {
  const gx = x / scale;
  const gz = z / scale;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);

  const n00 = hash2D(ix, iz, seed);
  const n10 = hash2D(ix + 1, iz, seed);
  const n01 = hash2D(ix, iz + 1, seed);
  const n11 = hash2D(ix + 1, iz + 1, seed);

  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  return nx0 + v * (nx1 - nx0);
}

const poiSitesCache = new Map<number, ForestSquarePoiSiteSpec[]>();
const terrainCache = new Map<number, HeightfieldTerrainDescriptor>();

function getCachedPoiSites(seed: number): ForestSquarePoiSiteSpec[] {
  const key = seed | 0;
  let sites = poiSitesCache.get(key);
  if (!sites) {
    sites = getForestSquarePoiSites(key);
    poiSitesCache.set(key, sites);
  }
  return sites;
}

function evalCosineBump(
  x: number,
  z: number,
  cx: number,
  cz: number,
  rx: number,
  rz: number,
  amp: number,
): number {
  const dx = (x - cx) / rx;
  if (dx <= -1 || dx >= 1) return 0;
  const dz = (z - cz) / rz;
  if (dz <= -1 || dz >= 1) return 0;
  const dSq = dx * dx + dz * dz;
  if (dSq >= 1) return 0;
  const t = 1 - dSq;
  return amp * t * t;
}

/**
 * Builds the 256x256 m (`129x129` height samples, `cellSize = 2`) heightfield terrain
 * for `forest_square`.
 *
 * Includes:
 * - Natural walkable hills (`slope <= 30°`) and mossy hollows (`-1.8 m .. +4.2 m`)
 * - 2 steep unwalkable rocky crag barriers (`slope > 45°`) at `(-108, -106)` and `(104, 96)`
 * - 6 terraced POI pads strictly flat at `site.padElevation` inside `site.flatRadius` and
 *   organically blended into surrounding relief across `site.flatRadius .. site.blendRadius`
 * - Walkable road network (`slope <= 28°`) and smooth outer perimeter feathering (`edgeDist < 6m`)
 */
export function buildForestSquareTerrain(
  seed = DEFAULT_PUBLIC_LAYOUT_SEED,
): HeightfieldTerrainDescriptor {
  const seedKey = seed | 0;
  const cached = terrainCache.get(seedKey);
  if (cached) {
    return {
      ...cached,
      heights: cached.heights.slice(),
    };
  }

  const width = FOREST_SQUARE_SIZE; // 256
  const depth = FOREST_SQUARE_SIZE; // 256
  const cellSize = FOREST_SQUARE_CELL_SIZE; // 2
  const originX = -FOREST_SQUARE_HALF; // -128
  const originZ = -FOREST_SQUARE_HALF; // -128
  const cols = Math.floor(width / cellSize) + 1; // 129
  const rows = Math.floor(depth / cellSize) + 1; // 129
  const heights: number[] = new Array(cols * rows);

  const sites = getCachedPoiSites(seedKey);

  for (let r = 0; r < rows; r++) {
    const z = originZ + r * cellSize;
    for (let c = 0; c < cols; c++) {
      const x = originX + c * cellSize;

      // 1. Walkable macro hills (gentle slopes <= 26 deg)
      let hills = 0;
      hills += evalCosineBump(x, z, 0, -90, 28, 22, 3.25); // North Pine Ridge
      hills += evalCosineBump(x, z, -100, -38, 22, 26, 3.05); // NW High Woods
      hills += evalCosineBump(x, z, 96, -34, 22, 24, 3.45); // NE Overlook Mound
      hills += evalCosineBump(x, z, 92, 16, 24, 28, 3.65); // East Timber Ridge
      hills += evalCosineBump(x, z, 24, 94, 26, 22, 2.55); // South Sunlit Knoll
      hills += evalCosineBump(x, z, -98, 44, 22, 26, 2.85); // SW Timber Rise

      // Gentle underlying plateaus under the 6 POIs so roads ramp effortlessly onto pads
      for (let i = 0; i < sites.length; i++) {
        const s = sites[i]!;
        hills += evalCosineBump(
          x,
          z,
          s.center.x,
          s.center.z,
          s.blendRadius + 10,
          s.blendRadius + 10,
          s.padElevation * 0.88,
        );
      }

      // 2. Natural valleys / mossy depressions (-1.75 m .. -1.10 m)
      let hollows = 0;
      hollows += evalCosineBump(x, z, -24, 88, 22, 20, -1.62); // SW Mossy Basin
      hollows += evalCosineBump(x, z, -34, -24, 22, 22, -1.42); // West-Central Creek Hollow
      hollows += evalCosineBump(x, z, 44, -20, 20, 20, -1.18); // East Mossy Dell
      hollows += evalCosineBump(x, z, 34, -92, 20, 18, -1.08); // NE Glade Dip

      // 3. Two steep unwalkable rocky crag barriers (slope > 45 deg, far from roads & POIs)
      // NW Rocky Crag at (-108, -106)
      let crags = 0;
      const dCragNW = Math.hypot((x - -108) / 8.0, (z - -106) / 7.5);
      if (dCragNW < 1) {
        const rim = clamp((1 - dCragNW) / 0.34, 0, 1);
        crags += 3.95 * rim * rim * (3 - 2 * rim);
      }

      // SE Rocky Crag behind Cliff Watch at (104, 96)
      const dCragSE = Math.hypot((x - 104) / 8.5, (z - 96) / 7.5);
      if (dCragSE < 1) {
        const rim = clamp((1 - dCragSE) / 0.34, 0, 1);
        crags += 4.05 * rim * rim * (3 - 2 * rim);
      }

      // 4. Multi-octave organic woodland relief noise (suppressed on roads for smooth driving/walking)
      const road = sampleForestSquareRoad(x, z, seed);
      const n1 = smoothNoise2D(x, z, 28, seed) * 0.42;
      const n2 = smoothNoise2D(x + 41, z - 29, 13, seed + 31) * 0.16;
      const roadNoiseDamp = 1 - road.blend * 0.78;
      const roadCarve = -0.08 * road.blend;

      const rawH = clamp(
        hills + hollows + crags + (n1 + n2) * roadNoiseDamp + roadCarve,
        -1.78,
        4.15,
      );

      // 5. POI Terraced Pads: strictly flat at `site.padElevation` within `d <= site.flatRadius`,
      // and organic radial blend (`smoothstep` + angular noise) across `flatRadius .. blendRadius`
      let blendedH = rawH;
      for (let i = 0; i < sites.length; i++) {
        const site = sites[i]!;
        const dx = x - site.center.x;
        const dz = z - site.center.z;
        const maxCheckR = site.blendRadius + 2.5;
        if (dx * dx + dz * dz >= maxCheckR * maxCheckR) continue;

        const d = Math.hypot(dx, dz);
        if (d <= site.flatRadius) {
          blendedH = site.padElevation;
          break;
        }

        const angle = Math.atan2(dz, dx);
        const angularNoise =
          (0.55 * Math.sin(angle * 3 + seed * 0.13 + i) +
            0.45 * Math.cos(angle * 5 - seed * 0.09 - i)) *
          1.8;
        const effectiveBlendRadius = Math.max(
          site.flatRadius + 4,
          site.blendRadius + angularNoise,
        );
        if (d < effectiveBlendRadius) {
          const padMask = smoothstep(site.flatRadius, effectiveBlendRadius, d);
          blendedH = site.padElevation * (1 - padMask) + rawH * padMask;
          break;
        }
      }

      // 6. Outer map border (< 6m from +/-128) smoothly feathered to y = 0
      const edgeDist = Math.min(FOREST_SQUARE_HALF - Math.abs(x), FOREST_SQUARE_HALF - Math.abs(z));
      const edgeFeather = smoothstep(0, 6.0, edgeDist);
      const finalH = blendedH * edgeFeather;

      heights[r * cols + c] = q3(finalH);
    }
  }

  const descriptor: HeightfieldTerrainDescriptor = {
    kind: 'heightfield',
    width,
    depth,
    cellSize,
    originX,
    originZ,
    cols,
    rows,
    heights,
  };
  terrainCache.set(seedKey, descriptor);
  return {
    ...descriptor,
    heights: descriptor.heights.slice(),
  };
}

/**
 * Vertex color sampler for the 256x256 `forest_square` terrain mesh (calibrated for ACES tone-mapping).
 * Blends rich dirt roads with tire ruts, organic road shoulders, compacted woodland soil and
 * fallen pine needle aprons at POIs, damp mossy hollows, sunlit golden-olive knolls,
 * and steep slate-grey rocky crags.
 */
export function sampleForestSquareTerrainColor(
  x: number,
  y: number,
  z: number,
  slopeDeg: number,
  seed = DEFAULT_PUBLIC_LAYOUT_SEED,
): [number, number, number] {
  // 1. Steep rocky crags (slopeDeg > 35°): slate grey stone [0.24, 0.25, 0.25] with subtle cool green moss streaks
  if (slopeDeg > 35) {
    const mossNoise = smoothNoise2D(x * 1.5, z * 1.5 + y * 0.6, 3.2, seed + 83) * 0.5 + 0.5;
    const mossStreak = smoothstep(0.38, 0.72, mossNoise);
    const cragR = 0.240 - mossStreak * 0.015;
    const cragG = 0.250 + mossStreak * 0.018;
    const cragB = 0.250 - mossStreak * 0.012;
    return [clamp(cragR, 0, 1), clamp(cragG, 0, 1), clamp(cragB, 0, 1)];
  }

  const road = sampleForestSquareRoad(x, z, seed);
  const sites = getCachedPoiSites(seed);

  // Multi-frequency organic woodland floor noise:
  // Macro noise (16m): sunlit glade zones vs cool canopy grove tones
  const macroNoise = smoothNoise2D(x, z, 16, seed + 101) * 0.5 + 0.5;
  // Mid noise (7.5m): organic glade patches and moss cushions
  const midNoise = smoothNoise2D(x + 23, z - 17, 7.5, seed + 157) * 0.5 + 0.5;
  // Meso detail (3.8m): breaks up 2m grid polygons into distinctive local variation
  const mesoNoise = smoothNoise2D(x - 17, z + 31, 3.8, seed + 211) * 0.5 + 0.5;
  // Micro noise (2.2m): micro soil grit between adjacent vertices
  const microNoise = smoothNoise2D(x * 1.6, z * 1.6, 2.2, seed + 229) * 0.5 + 0.5;

  // 2. Standard forest glades:
  // Blend warm golden-olive glade patches [0.180, 0.290, 0.080] and rich deep moss tones [0.120, 0.240, 0.070]
  // with temperate vibrant forest grass [0.150, 0.265, 0.085]
  const patchT = macroNoise * 0.45 + midNoise * 0.35 + mesoNoise * 0.20;

  let r = 0.150;
  let g = 0.265;
  let b = 0.085;

  if (patchT > 0.5) {
    const gladeK = smoothstep(0.50, 0.78, patchT);
    r = r * (1 - gladeK) + 0.180 * gladeK;
    g = g * (1 - gladeK) + 0.290 * gladeK;
    b = b * (1 - gladeK) + 0.080 * gladeK;
  } else {
    const mossK = 1.0 - smoothstep(0.22, 0.50, patchT);
    r = r * (1 - mossK) + 0.120 * mossK;
    g = g * (1 - mossK) + 0.240 * mossK;
    b = b * (1 - mossK) + 0.070 * mossK;
  }

  // Micro grit gives adjacent 2m grid vertices tactile organic variation
  const grit = microNoise - 0.5;
  r += grit * 0.016;
  g += grit * 0.018;
  b += grit * 0.010;

  // Subtle slope-based shading for natural hillside depth
  const slopeShade = clamp(slopeDeg / 38, 0, 1) * 0.14;
  r *= 1 - slopeShade * 0.5;
  g *= 1 - slopeShade;
  b *= 1 - slopeShade * 0.6;

  // 3. Biome & Terrain Zone Palette Enrichment
  if (y < -0.2) {
    // Damp hollows / stream beds / depressions (y < -0.2m): deep rich woodland moss [0.09, 0.20, 0.06]
    const k = clamp((-y - 0.2) / 1.5, 0, 1);
    r = r * (1 - k) + 0.090 * k;
    g = g * (1 - k) + 0.200 * k;
    b = b * (1 - k) + 0.060 * k;
  } else if (y > 1.2) {
    // Golden knolls / open sunlit plateau (y > 1.2m): warm golden-olive grass [0.22, 0.31, 0.11]
    const k = clamp((y - 1.2) / 2.5, 0, 1);
    r = r * (1 - k) + 0.220 * k;
    g = g * (1 - k) + 0.310 * k;
    b = b * (1 - k) + 0.110 * k;
  }

  // 4. POI Yard Aprons & Seamless Road Transitions
  // For all 6 POIs (Ranger House, Cabin Cluster, Lumber Mill, Service Station, Forest Camp, Cliff Watch):
  // - Center yard: compacted woodland soil [0.225, 0.165, 0.095]
  // - Yard perimeter: fallen pine needle apron [0.235, 0.145, 0.075] that seamlessly merges into road networks
  let nearestSite: ForestSquarePoiSiteSpec | null = null;
  let nearestSiteDist = Infinity;
  let nearestSiteDrivewayDist = Infinity;

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]!;
    const dx = x - site.center.x;
    const dz = z - site.center.z;
    const outerYardCheck = site.flatRadius + 8.0;
    if (dx * dx + dz * dz > outerYardCheck * outerYardCheck) continue;

    const dCenter = Math.hypot(dx, dz);
    if (dCenter < nearestSiteDist) {
      nearestSiteDist = dCenter;
      nearestSite = site;

      // Distance to driveway segment connecting center to roadAnchor
      const abx = site.roadAnchor.x - site.center.x;
      const abz = site.roadAnchor.z - site.center.z;
      const segLenSq = abx * abx + abz * abz;
      const tSeg = segLenSq > 0.001 ? clamp((dx * abx + dz * abz) / segLenSq, 0, 1) : 0;
      const projX = site.center.x + tSeg * abx;
      const projZ = site.center.z + tSeg * abz;
      nearestSiteDrivewayDist = Math.hypot(x - projX, z - projZ);
    }
  }

  let inPoiYard = false;
  let poiYardSoilColor: [number, number, number] = [0.225, 0.165, 0.095];

  if (nearestSite) {
    const site = nearestSite;
    const elevDiff = Math.abs(y - site.padElevation);
    const elevAtten = 1 - smoothstep(1.1, 2.2, elevDiff);

    if (elevAtten > 0.01) {
      const outerYardR = site.flatRadius + 5.5 + (midNoise - 0.5) * 1.8;
      const dYardCenter = nearestSiteDist + (microNoise - 0.5) * 0.8;

      // Center yard blends outward to fallen pine needle apron
      const centerMask = 1 - smoothstep(site.flatRadius * 0.55, outerYardR, dYardCenter);
      // Driveway apron corridor to roadAnchor
      const drivewayMask =
        (1 - smoothstep(2.5, 6.2, nearestSiteDrivewayDist)) *
        (1 - smoothstep(site.flatRadius * 0.5, outerYardR + 2.0, dYardCenter));
      const combinedYardMask = Math.max(centerMask, drivewayMask);

      const poiYardBlend = clamp(combinedYardMask * elevAtten, 0, 1);

      if (poiYardBlend > 0.005) {
        inPoiYard = true;
        // Pine needle factor: 0.0 in center yard, 1.0 towards perimeter apron & driveway edges
        const pineNeedleFactor = clamp(
          smoothstep(site.flatRadius * 0.50, outerYardR - 0.5, dYardCenter) +
            smoothstep(2.2, 5.5, nearestSiteDrivewayDist) * 0.35,
          0,
          1,
        );

        const yardGrit = (microNoise - 0.5) * 0.014;
        const yardSoilR = 0.225 * (1 - pineNeedleFactor) + 0.235 * pineNeedleFactor + yardGrit;
        const yardSoilG = 0.165 * (1 - pineNeedleFactor) + 0.145 * pineNeedleFactor + yardGrit * 0.7;
        const yardSoilB = 0.095 * (1 - pineNeedleFactor) + 0.075 * pineNeedleFactor + yardGrit * 0.4;
        poiYardSoilColor = [yardSoilR, yardSoilG, yardSoilB];

        r = r * (1 - poiYardBlend) + yardSoilR * poiYardBlend;
        g = g * (1 - poiYardBlend) + yardSoilG * poiYardBlend;
        b = b * (1 - poiYardBlend) + yardSoilB * poiYardBlend;
      }
    }
  }

  // 5. Soil Roads (Earthy Contrast & Distinct Ruts)
  // - Road center: rich dark earthy brown [0.20, 0.135, 0.065]
  // - Dual tire ruts: darker compacted depressions [0.165, 0.105, 0.048] (~0.8m - 1.4m from centerline, peak ~1.08m)
  // - Center crown: slightly lighter dusted dirt [0.215, 0.150, 0.075] (within ~0.0m - 0.65m)
  // - Organic road shoulders: natural transition zone [0.215, 0.175, 0.095] with pebble and dry grass tinting
  if (road.dist < 6.5) {
    const edgeJitter = (midNoise - 0.5) * 0.55 + (microNoise - 0.5) * 0.25;
    const noisyRoadDist = Math.max(0, road.dist + edgeJitter);

    // Confident road blend across the road bed so dirt never washes out with grass green
    const organicRoadBlend = clamp(
      Math.max(road.blend, 1 - smoothstep(1.35, 2.85, noisyRoadDist)),
      0,
      1,
    );

    // Organic road shoulder with subtle pebble & dry grass tinting
    const organicShoulder = clamp(
      Math.max(
        road.shoulderBlend,
        (1 - smoothstep(0.8, 2.3, Math.abs(noisyRoadDist - 2.45))) * (1 - organicRoadBlend * 0.7),
      ),
      0,
      1,
    );

    // Apply shoulder first
    if (organicShoulder > 0.01) {
      const sb = organicShoulder * 0.88;
      const shoulderGrit = (microNoise - 0.5) * 0.014;
      const dryGrassTint = (macroNoise - 0.5) * 0.012;
      const shoulderR = 0.215 + shoulderGrit + dryGrassTint * 0.5;
      const shoulderG = 0.175 + shoulderGrit * 0.7 + dryGrassTint;
      const shoulderB = 0.095 + shoulderGrit * 0.4;

      r = r * (1 - sb) + shoulderR * sb;
      g = g * (1 - sb) + shoulderG * sb;
      b = b * (1 - sb) + shoulderB * sb;
    }

    // Apply main road track with center crown and dual compacted tire ruts
    if (organicRoadBlend > 0.01) {
      // Base road track: rich dark earthy brown [0.20, 0.135, 0.065]
      let dirtR = 0.200;
      let dirtG = 0.135;
      let dirtB = 0.065;

      // Center crown: slightly lighter dusted dirt [0.215, 0.150, 0.075] (within ~0.0m - 0.65m)
      const crownMask = 1 - smoothstep(0.18, 0.68, noisyRoadDist);
      dirtR = dirtR * (1 - crownMask) + 0.215 * crownMask;
      dirtG = dirtG * (1 - crownMask) + 0.150 * crownMask;
      dirtB = dirtB * (1 - crownMask) + 0.075 * crownMask;

      // Dual tire ruts: darker compacted depressions [0.165, 0.105, 0.048] (~0.8m - 1.4m from centerline, peak ~1.08m)
      const rutOffset = Math.abs(noisyRoadDist - 1.08);
      const rutMask = 1 - smoothstep(0.0, 0.32, rutOffset);
      dirtR = dirtR * (1 - rutMask) + 0.165 * rutMask;
      dirtG = dirtG * (1 - rutMask) + 0.105 * rutMask;
      dirtB = dirtB * (1 - rutMask) + 0.048 * rutMask;

      // Soil grit & pebble flecks
      const roadGrit = (microNoise - 0.5) * 0.014;
      dirtR += roadGrit;
      dirtG += roadGrit * 0.7;
      dirtB += roadGrit * 0.4;

      // Inside POI courtyard: seamlessly harmonize road termination into the POI yard soil
      if (inPoiYard && nearestSite && nearestSiteDist < nearestSite.flatRadius * 0.85) {
        const yardMerge =
          1 - smoothstep(nearestSite.flatRadius * 0.4, nearestSite.flatRadius * 0.85, nearestSiteDist);
        dirtR = dirtR * (1 - yardMerge * 0.65) + poiYardSoilColor[0] * (yardMerge * 0.65);
        dirtG = dirtG * (1 - yardMerge * 0.65) + poiYardSoilColor[1] * (yardMerge * 0.65);
        dirtB = dirtB * (1 - yardMerge * 0.65) + poiYardSoilColor[2] * (yardMerge * 0.65);
      }

      const rb = organicRoadBlend;
      r = r * (1 - rb) + dirtR * rb;
      g = g * (1 - rb) + dirtG * rb;
      b = b * (1 - rb) + dirtB * rb;
    }
  }

  // 6. Feather outer 6m perimeter smoothly into the outer valley floor color
  const edgeDist = Math.min(FOREST_SQUARE_HALF - Math.abs(x), FOREST_SQUARE_HALF - Math.abs(z));
  const outerBlend = 1 - smoothstep(0.0, 6.0, edgeDist);
  if (outerBlend > 0.001) {
    r = r * (1 - outerBlend) + 0.142 * outerBlend;
    g = g * (1 - outerBlend) + 0.248 * outerBlend;
    b = b * (1 - outerBlend) + 0.092 * outerBlend;
  }

  return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
}
