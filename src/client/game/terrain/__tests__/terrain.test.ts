import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  buildForestSquareTerrain,
  sampleForestSquareTerrainColor,
} from '../../../../shared/forestSquareTerrain';
import { sampleForestSquareRoad } from '../../../../shared/forestSquareRoads';
import { getForestSquarePoiSites } from '../../../../shared/structures/contracts';
import { DEFAULT_PUBLIC_LAYOUT_SEED } from '../../../../shared/world';
import { createEnhancedTerrainMaterial } from '../TerrainMaterial';

describe('STAGE 08-TERRAIN-VISUAL — Sub-agent B (Terrain & Roads)', () => {
  describe('1. Enhanced sampleForestSquareTerrainColor', () => {
    const seed = DEFAULT_PUBLIC_LAYOUT_SEED;

    it('returns clamped [r, g, b] values strictly in [0, 1] across entire terrain', () => {
      for (let x = -120; x <= 120; x += 30) {
        for (let z = -120; z <= 120; z += 30) {
          for (const y of [-1.5, 0.0, 1.5, 3.5]) {
            for (const slope of [5, 20, 36, 48]) {
              const [r, g, b] = sampleForestSquareTerrainColor(x, y, z, slope, seed);
              assert.ok(r >= 0 && r <= 1, `r=${r} out of bounds at (${x}, ${y}, ${z})`);
              assert.ok(g >= 0 && g <= 1, `g=${g} out of bounds at (${x}, ${y}, ${z})`);
              assert.ok(b >= 0 && b <= 1, `b=${b} out of bounds at (${x}, ${y}, ${z})`);
            }
          }
        }
      }
    });

    it('samples steep rocky crags (slopeDeg > 35°) as slate grey stone with subtle moss streaks', () => {
      // Steep crag at NW cliff barrier (-108, -106)
      const [r1, g1, b1] = sampleForestSquareTerrainColor(-108, 2.5, -106, 46, seed);
      // Slate grey stone base: cool tones, low saturation (r ~ 0.21..0.24, g ~ 0.25..0.29, b ~ 0.17..0.27)
      assert.ok(r1 >= 0.19 && r1 <= 0.26, `Rocky crag red=${r1} should be slate grey`);
      assert.ok(g1 >= 0.23 && g1 <= 0.31, `Rocky crag green=${g1} should be slate/moss`);
      assert.ok(b1 >= 0.16 && b1 <= 0.28, `Rocky crag blue=${b1} should be cool slate`);

      // Verify another steep slope at > 35 deg
      const [r2, g2, b2] = sampleForestSquareTerrainColor(104, 3.0, 96, 44, seed);
      assert.ok(r2 >= 0.19 && r2 <= 0.26);
      assert.ok(g2 >= 0.23 && g2 <= 0.31);
      assert.ok(b2 >= 0.16 && b2 <= 0.28);
    });

    it('samples dirt roads as rich dark earthy brown [0.22, 0.15, 0.08] with tire rut depression and shoulder [0.21, 0.19, 0.11]', () => {
      // Find a road coordinate along the main arterial road near center (0, 0)
      let roadX = 0;
      let roadZ = 0;
      let foundRoad = false;
      for (let x = -30; x <= 30; x += 1) {
        for (let z = -30; z <= 30; z += 1) {
          const sample = sampleForestSquareRoad(x, z, seed);
          if (sample.dist < 0.2 && sample.blend > 0.95) {
            roadX = x;
            roadZ = z;
            foundRoad = true;
            break;
          }
        }
        if (foundRoad) break;
      }
      assert.ok(foundRoad, 'Failed to locate road center sample near origin');

      // Sample on the road track
      const [rTrack, gTrack, bTrack] = sampleForestSquareTerrainColor(roadX, 0.0, roadZ, 2, seed);
      // Earthy brown: r > g > b, dark contrast
      assert.ok(rTrack > gTrack, `Road red (${rTrack}) should exceed green (${gTrack})`);
      assert.ok(gTrack > bTrack, `Road green (${gTrack}) should exceed blue (${bTrack})`);
      assert.ok(rTrack >= 0.16 && rTrack <= 0.25, `Road red should be in dark earthy range`);
      assert.ok(gTrack >= 0.10 && gTrack <= 0.18, `Road green should be in dark earthy range`);
      assert.ok(bTrack >= 0.05 && bTrack <= 0.11, `Road blue should be in dark earthy range`);
    });

    it('samples POI yards with compacted warm woodland soil and pine needle apron', () => {
      const sites = getForestSquarePoiSites(seed);
      assert.ok(sites.length > 0);
      const site = sites[0]!;

      // Directly inside the yard near POI center
      const [rYard, gYard, bYard] = sampleForestSquareTerrainColor(
        site.center.x,
        site.padElevation,
        site.center.z,
        1,
        seed,
      );
      // Warm compacted woodland soil: warm reddish-brown tones (r > g > b)
      assert.ok(rYard > gYard, `Yard center red (${rYard}) should exceed green (${gYard})`);
      assert.ok(rYard >= 0.20 && rYard <= 0.26, `Yard red should be warm soil tone`);
      assert.ok(gYard >= 0.15 && gYard <= 0.21, `Yard green should be warm soil tone`);
      assert.ok(bYard >= 0.08 && bYard <= 0.13, `Yard blue should be warm soil tone`);
    });

    it('samples plateau hilltops (y > 1.2) as warm golden-olive sunlit grass', () => {
      // Sample South Sunlit Knoll away from roads (at x=24, z=94 where y > 2.0m)
      const [rHill, gHill, bHill] = sampleForestSquareTerrainColor(24, 2.5, 94, 8, seed);
      // Sunlit golden-olive: bright and warm (r ~ 0.17..0.25, g ~ 0.26..0.35, b ~ 0.08..0.13)
      assert.ok(gHill > rHill, `Grass green should dominate on hilltop`);
      assert.ok(rHill >= 0.16 && rHill <= 0.25, `Hilltop red should have warm golden tone`);
      assert.ok(gHill >= 0.25 && gHill <= 0.35, `Hilltop green should be sunlit olive`);
    });

    it('samples damp depressions (y < -0.2) as deep rich woodland moss green', () => {
      // Sample SW Mossy Basin (x=-24, z=88, y ~ -1.5m)
      const [rHollow, gHollow, bHollow] = sampleForestSquareTerrainColor(-24, -1.4, 88, 6, seed);
      // Deep rich woodland moss green: darker, deeper green, low red
      assert.ok(gHollow > rHollow, `Hollow green should dominate`);
      assert.ok(rHollow <= 0.13, `Hollow red (${rHollow}) should be deep and muted`);
      assert.ok(gHollow >= 0.17 && gHollow <= 0.25, `Hollow green (${gHollow}) should be deep moss`);
      assert.ok(bHollow <= 0.10, `Hollow blue (${bHollow}) should be deep moss`);
    });

    it('guarantees buildForestSquareTerrain heights, bounds, and layout are 100% deterministic and untouched', () => {
      const t1 = buildForestSquareTerrain(seed);
      const t2 = buildForestSquareTerrain(seed);
      assert.equal(t1.width, 256);
      assert.equal(t1.depth, 256);
      assert.equal(t1.cellSize, 2);
      assert.equal(t1.cols, 129);
      assert.equal(t1.rows, 129);
      assert.equal(t1.heights.length, 129 * 129);
      assert.deepEqual(t1.heights, t2.heights);
    });
  });

  describe('2. createEnhancedTerrainMaterial', () => {
    it('configures vertexColors: true, roughness: 0.94, metalness: 0.0', () => {
      const mat = createEnhancedTerrainMaterial(new THREE.MeshStandardMaterial(), 42);
      assert.equal(mat.vertexColors, true);
      assert.equal(mat.roughness, 0.94);
      assert.equal(mat.metalness, 0.0);
      assert.ok(typeof mat.customProgramCacheKey === 'function');
      assert.ok(mat.customProgramCacheKey().includes('42'));
    });

    it('creates default material if none provided', () => {
      const mat = createEnhancedTerrainMaterial(undefined, 1337);
      assert.ok(mat instanceof THREE.MeshStandardMaterial);
      assert.equal(mat.vertexColors, true);
      assert.equal(mat.roughness, 0.94);
      assert.equal(mat.metalness, 0.0);
    });

    it('hooks into onBeforeCompile with shader modifications', () => {
      const mat = createEnhancedTerrainMaterial(new THREE.MeshStandardMaterial(), 77);

      const mockShader = {
        uniforms: {} as Record<string, { value: unknown }>,
        vertexShader: `
#include <common>
void main() {
  #include <worldpos_vertex>
}
`,
        fragmentShader: `
#include <common>
void main() {
  #include <color_fragment>
  #include <roughnessmap_fragment>
}
`,
      };

      assert.ok(typeof mat.onBeforeCompile === 'function');
      mat.onBeforeCompile(mockShader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);

      // Check uniforms
      assert.equal(mockShader.uniforms.uTerrainSeed?.value, 77);

      // Check vertex shader hooks
      assert.ok(
        mockShader.vertexShader.includes('varying vec3 vWorldPosition;'),
        'Vertex shader must declare vWorldPosition',
      );
      assert.ok(
        mockShader.vertexShader.includes('vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;'),
        'Vertex shader must compute vWorldPosition',
      );

      // Check fragment shader hooks
      assert.ok(
        mockShader.fragmentShader.includes('varying vec3 vWorldPosition;'),
        'Fragment shader must receive vWorldPosition',
      );
      assert.ok(
        mockShader.fragmentShader.includes('uniform float uTerrainSeed;'),
        'Fragment shader must declare uTerrainSeed',
      );
      assert.ok(
        mockShader.fragmentShader.includes('terrainNoise2D'),
        'Fragment shader must include terrainNoise2D',
      );
      assert.ok(
        mockShader.fragmentShader.includes('terrainHash21'),
        'Fragment shader must include terrainHash21',
      );
      assert.ok(
        mockShader.fragmentShader.includes('soilGrit'),
        'Fragment shader must compute soilGrit micro noise',
      );
      assert.ok(
        mockShader.fragmentShader.includes('mossCol') || mockShader.fragmentShader.includes('velvet'),
        'Fragment shader must compute velvet moss variation',
      );
      assert.ok(
        mockShader.fragmentShader.includes('needleMask') || mockShader.fragmentShader.includes('needleColor'),
        'Fragment shader must compute pine needle speckles',
      );
      assert.ok(
        mockShader.fragmentShader.includes('roughnessFactor'),
        'Fragment shader must modulate roughnessFactor',
      );
    });
  });
});
