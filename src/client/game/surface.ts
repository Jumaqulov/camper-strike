import { sampleForestSquareRoad } from '../../shared/forestSquareRoads';
import { getForestSquarePoiSites } from '../../shared/structures/contracts';
import { sampleTerrainSlopeDeg } from '../../shared/terrain';
import type { WorldDefinition } from '../../shared/world';

/** Qadam tovushi uchun yuza turi. */
export type SurfaceKind = 'grass' | 'gravel' | 'dirt' | 'wood' | 'stone' | 'metal';

const poiCache = new Map<number, { x: number; z: number; r: number }[]>();

/**
 * O'yinchi turgan yuzani aniqlaydi (faqat klient, ovoz uchun):
 * 1. Kollayder ustida tursa — binolar/qutilar yog'och, tosh yoki metall;
 * 2. Forest Square: so'qmoq → shag'al, hovli → tuproq, qoya → tosh, qolgani → maysa;
 * 3. Tekis xaritalar (Dust Arena) → tuproq.
 */
export function detectSurface(world: WorldDefinition, x: number, y: number, z: number): SurfaceKind {
  // 1. Kollayder tepasida turibmizmi? (oyoq nuqtasi box ustidan ≤ 0.2 m)
  const r = 0.35;
  for (const b of world.colliders) {
    if (b.tag === 'boundary' || b.tag === 'tree') continue;
    if (x + r < b.min.x || x - r > b.max.x || z + r < b.min.z || z - r > b.max.z) continue;
    const dy = y - b.max.y;
    if (dy < -0.05 || dy > 0.2) continue;
    if (b.tag === 'rock') return 'stone';
    switch (b.mat) {
      case 'metal':
        return 'metal';
      case 'concrete':
        return 'stone';
      case 'ground':
        return 'dirt';
      default:
        return 'wood'; // 'wall' | 'crate' | 'roof' — yog'och kabinalar, qutilar, pollar
    }
  }

  // 2. Yer yuzasi
  if (sampleTerrainSlopeDeg(world.terrain, x, z) > 35) return 'stone';
  if (world.mapId === 'forest_square') {
    const seed = world.publicLayoutSeed;
    const road = sampleForestSquareRoad(x, z, seed);
    if (road.dist <= road.halfWidth + 0.35) return 'gravel';
    let sites = poiCache.get(seed);
    if (!sites) {
      sites = getForestSquarePoiSites(seed).map((s) => ({ x: s.center.x, z: s.center.z, r: s.flatRadius + 3.5 }));
      poiCache.set(seed, sites);
    }
    for (const s of sites) {
      if (Math.hypot(x - s.x, z - s.z) < s.r) return 'dirt';
    }
  }
  return 'grass';
}
