import * as THREE from 'three';

/**
 * Enhances a Three.js MeshStandardMaterial for terrain rendering via onBeforeCompile.
 * Adds a multi-scale procedural woodland shading system directly in the fragment shader:
 *
 * 1. Macro Layer (3m - 20m):
 *    Continuous, rich value noise modulation across the forest floor:
 *    - Sunlit golden-olive glades (`vec3(1.18, 1.20, 0.86)` with warm sunny luminance)
 *    - Deep damp emerald moss hollows (`vec3(0.78, 0.98, 0.80)` with lush cool depth)
 *    - Russet humus & fallen pine needles under tree zones (`vec3(0.22, 0.145, 0.075)`)
 *    - Subtle dry straw tints on exposed rises
 *    - Continuous overlapping transitions eliminating flat dead zones across large polygons
 *
 * 2. Mezo Layer (0.5m - 3m):
 *    - Soft-edged velvet moss patches breaking up the 2-meter vertex polygons
 *    - Visible damp loam peeks (`vec3(0.175, 0.120, 0.065)`) nestled within grass areas
 *    - Directional fallen pine needle clusters (`~0.2m` needles within mezo patches)
 *
 * 3. Micro Layer (0.1m - 0.5m):
 *    - Subtle fine soil grit and pebble flecks (using standard GLSL `1.0 - smoothstep(0.14, 0.24, ...)`)
 *    - Calibrated to remain crisp close up without specular sparkling or distance shimmering
 *
 * 4. Stylized Daylight Camper Palette:
 *    - Warm sunlight and rich woodland greens harmonizing with daylight menu palette
 *    - Dirt roads: tire track dust, soil grit, and dry edge dusting
 *    - Steep rock slopes: slate grey stone with subtle moss runoffs
 *
 * 5. Roughness & Material Properties:
 *    - Damp moss: ~0.84 - 0.88
 *    - Dry forest floor / grass: ~0.92 - 0.94
 *    - Compacted dirt road & pebbles: ~0.94 - 0.96
 *    - Metalness: 0.0
 *
 * Highly performant for Intel UHD Graphics 730 (zero loops, pure arithmetic hash and 2D noise).
 */
export function createEnhancedTerrainMaterial(
  baseMat?: THREE.MeshStandardMaterial,
  seed = 0,
): THREE.MeshStandardMaterial {
  const mat =
    baseMat ??
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.0,
    });

  mat.vertexColors = true;
  mat.roughness = 0.94;
  mat.metalness = 0.0;

  // Custom program cache key ensures Three.js differentiates compiled shaders per seed
  mat.customProgramCacheKey = () => `enhanced_forest_terrain_${seed | 0}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrainSeed = { value: seed | 0 };

    // 1. Pass world coordinates from vertex shader
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      /* glsl */ `
#include <common>
#ifndef USE_TRANSMISSION
varying vec3 vWorldPosition;
#endif
`,
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      /* glsl */ `
#include <worldpos_vertex>
#ifndef USE_TRANSMISSION
vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif
`,
    );

    // 2. Fragment shader: add varying, uniforms and fast procedural hash/noise helpers
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      /* glsl */ `
#include <common>
#ifndef USE_TRANSMISSION
varying vec3 vWorldPosition;
#endif
uniform float uTerrainSeed;

// Lightweight deterministic pseudo-random hash (pure arithmetic, zero loops)
float terrainHash21(vec2 p, float s) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(443.897, 441.423, 437.195) + s * 0.0137);
  p3 += dot(p3, p3.yzx + 19.19);
  return fract((p3.x + p3.y) * p3.z);
}

// 2D value noise with bilinear Hermite interpolation (zero loops)
float terrainNoise2D(vec2 p, float s) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);

  float a = terrainHash21(i, s);
  float b = terrainHash21(i + vec2(1.0, 0.0), s);
  float c = terrainHash21(i + vec2(0.0, 1.0), s);
  float d = terrainHash21(i + vec2(1.0, 1.0), s);

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`,
    );

    // 3. Inject multi-scale procedural woodland shading into diffuseColor
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */ `
#include <color_fragment>

// --- Multi-scale procedural woodland shading ---
{
  vec2 wPos = vWorldPosition.xz;
  vec3 col = diffuseColor.rgb;

  // 1. Biome & ground classification from vertex color
  // Slate grey rock: channels are closely balanced with significant blue
  float rockDiff = max(abs(col.r - col.g), max(abs(col.g - col.b), abs(col.r - col.b)));
  float rockMask = clamp((1.0 - rockDiff * 16.0) * step(0.15, col.b), 0.0, 1.0);

  // Dirt roads & POI yards: red exceeds green significantly (r > g)
  float dirtDiff = col.r - col.g;
  float dirtMask = smoothstep(0.005, 0.038, dirtDiff) * (1.0 - rockMask);

  // Grassy forest floor: green exceeds red (g > r)
  float grassDiff = col.g - col.r;
  float grassMask = smoothstep(0.005, 0.038, grassDiff) * (1.0 - rockMask);

  // =========================================================================
  // MACRO LAYER (3m - 20m): Continuous woodland modulation without dead zones
  // Modulates color smoothly across broad patches so no polygon looks uniform
  // =========================================================================
  float nMacroA = terrainNoise2D(wPos * 0.055, uTerrainSeed + 17.0);   // ~18m wavelength
  float nMacroB = terrainNoise2D(wPos * 0.125, uTerrainSeed + 43.0);   // ~8m wavelength
  float macroNoise = nMacroA * 0.60 + nMacroB * 0.40;

  // Secondary macro noises for humus clearings and dry straw rises
  float nHumusMacro = terrainNoise2D(wPos * 0.082 + vec2(19.4, -27.6), uTerrainSeed + 71.0);  // ~12m
  float nHumusMezo  = terrainNoise2D(wPos * 0.220 + vec2(-12.3, 44.1), uTerrainSeed + 83.0);  // ~4.5m
  float humusVal = nHumusMacro * 0.65 + nHumusMezo * 0.35;

  float nStrawMacro = terrainNoise2D(wPos * 0.070 + vec2(-43.1, 31.8), uTerrainSeed + 97.0);  // ~14m

  // A. Golden-olive sunlit grass glades (continuous overlap above 0.42)
  float gladeFactor = smoothstep(0.42, 0.72, macroNoise);
  vec3 sunlitGlade = col * vec3(1.24, 1.26, 0.82) + vec3(0.038, 0.045, -0.012);

  // B. Deep damp emerald moss hollows (continuous overlap below 0.58)
  float hollowFactor = 1.0 - smoothstep(0.28, 0.58, macroNoise);
  vec3 dampMoss = col * vec3(0.72, 0.94, 0.75) + vec3(-0.032, 0.030, -0.022);

  // C. Russet brown humus & fallen pine needles under tree zones
  float humusFactor = smoothstep(0.48, 0.72, humusVal) * (1.0 - gladeFactor * 0.55);
  vec3 humusCol = vec3(0.220, 0.145, 0.075) + (humusVal - 0.60) * 0.035;

  // D. Subtle dry straw tints on exposed rises
  float riseFactor = clamp((vWorldPosition.y + 0.4) * 0.36, 0.0, 1.0);
  float strawFactor = smoothstep(0.50, 0.76, nStrawMacro) * riseFactor;
  vec3 strawCol = vec3(0.260, 0.250, 0.125);

  // Lush meadow base: a touch more saturated green so the grass blades above read as one carpet
  vec3 lushBase = col * vec3(0.90, 1.12, 0.80) + vec3(-0.010, 0.022, -0.010);
  vec3 grassMacroCol = mix(col, lushBase, 0.65);
  grassMacroCol = mix(grassMacroCol, sunlitGlade, gladeFactor * 0.70);
  grassMacroCol = mix(grassMacroCol, dampMoss, hollowFactor * 0.70);
  grassMacroCol = mix(grassMacroCol, humusCol, humusFactor * 0.38);
  grassMacroCol = mix(grassMacroCol, strawCol, strawFactor * 0.28);

  col = mix(col, grassMacroCol, grassMask);

  // =========================================================================
  // MEZO LAYER (0.5m - 3m): Velvet moss patches, damp earth & pine speckles
  // Breaks up the 2-meter vertex polygon boundaries with soft organic forms
  // =========================================================================
  float nMezoA = terrainNoise2D(wPos * 0.68, uTerrainSeed + 127.0);   // ~1.47m scale
  float nMezoB = terrainNoise2D(wPos * 1.55, uTerrainSeed + 151.0);   // ~0.65m scale
  float velvet = nMezoA * 0.65 + nMezoB * 0.35;

  // Velvet moss modulation (soft edges, rich emerald contrast)
  vec3 velvetDark = col * vec3(0.68, 0.92, 0.70) - vec3(0.032, 0.010, 0.022);
  vec3 velvetLight = col * vec3(1.30, 1.24, 0.82) + vec3(0.038, 0.044, -0.012);
  float velvetFactor = smoothstep(0.28, 0.72, velvet);
  vec3 mossCol = mix(velvetDark, velvetLight, velvetFactor);
  col = mix(col, mossCol, grassMask * 0.92);

  // Damp earth / loam peeks breaking through grass (scale ~1.5m - 2.0m)
  float nEarthA = terrainNoise2D(wPos * 0.92 + vec2(37.1, -19.4), uTerrainSeed + 179.0);
  float nEarthB = terrainNoise2D(wPos * 2.20 + vec2(-21.5, 53.2), uTerrainSeed + 183.0);
  float earthNoise = nEarthA * 0.68 + nEarthB * 0.32;
  // Rare, soft loam peeks only in shaded humus zones (meadows stay green)
  float earthPeeks = smoothstep(0.56, 0.80, earthNoise) * grassMask * (0.25 + 0.75 * humusFactor) * (1.0 - gladeFactor * 0.50);
  vec3 dampLoamCol = vec3(0.190, 0.130, 0.070);
  col = mix(col, dampLoamCol, earthPeeks * 0.55);

  // Pine needle speckling & clusters (~0.2m individual needles within mezo clusters)
  float needleCluster = terrainNoise2D(wPos * 0.40 + vec2(-51.0, 29.0), uTerrainSeed + 193.0);
  float needleClusterDense = smoothstep(0.40, 0.70, needleCluster);

  vec2 uvNeedle = wPos * 4.6; // cell ~0.22m
  vec2 nCell = floor(uvNeedle);
  vec2 nFrac = fract(uvNeedle) - 0.5;
  float needleHash = terrainHash21(nCell, uTerrainSeed + 107.0);
  float needleAngle = needleHash * 6.2831853;
  vec2 needleDir = vec2(cos(needleAngle), sin(needleAngle));
  float distAlong = abs(dot(nFrac, needleDir));
  float distPerp = abs(dot(nFrac, vec2(-needleDir.y, needleDir.x)));
  float needleThreshold = mix(0.74, 0.40, needleClusterDense);
  float needleMask = step(distPerp, 0.12) * step(distAlong, 0.42) * step(needleThreshold, needleHash);
  needleMask *= (1.0 - rockMask * 0.90);
  // Needles belong under the trees (humus zones) and on bare dirt, not scattered over open meadows
  needleMask *= clamp(0.15 + 0.85 * humusFactor + dirtMask * 0.6, 0.0, 1.0);
  vec3 needleColor = vec3(0.245, 0.148, 0.068) + (needleHash - 0.5) * 0.042;
  col = mix(col, needleColor, needleMask * 0.70);

  // =========================================================================
  // MICRO LAYER (0.1m - 0.5m): Subtle fine soil grit and pebble flecks
  // Purely arithmetic, avoids distance aliasing / specular shimmering
  // =========================================================================
  float nMid = terrainNoise2D(wPos * 1.35, uTerrainSeed + 13.0);
  float nFine = terrainNoise2D(wPos * 4.4, uTerrainSeed + 37.0);
  float soilGrit = (nMid * 0.60 + nFine * 0.40 - 0.5) * 0.18;

  // Pebble flecks on dirt roads, POI soil, woodland loam and rocky shoulders (scale ~0.3m)
  vec2 uvPebble = wPos * 3.3;
  vec2 pCell = floor(uvPebble);
  vec2 pFrac = fract(uvPebble) - 0.5;
  float pebbleHash = terrainHash21(pCell, uTerrainSeed + 59.0);
  float pebbleDist = length(pFrac);
  float isPebble = (1.0 - smoothstep(0.14, 0.24, pebbleDist)) * step(0.65, pebbleHash);
  // Pebble flecks only where there is bare ground (dirt roads, yards, rock, loam) — no white dots on grass
  float pebbleLuma = isPebble * (pebbleHash - 0.5) * 0.20 * (dirtMask * 1.25 + rockMask * 0.95 + earthPeeks * 0.80);

  col += vec3(soilGrit) * (dirtMask * 1.30 + grassMask * 0.45 + rockMask * 0.95);
  col += vec3(pebbleLuma);

  // =========================================================================
  // DIRT ROADS & POI COURTYARDS: Tire ruts, dust, grit and dry edge dusting
  // =========================================================================
  float roadNoise = terrainNoise2D(wPos * 0.88 + vec2(11.2, -14.7), uTerrainSeed + 211.0);
  vec3 roadDust = col + vec3(0.032, 0.026, 0.016);
  vec3 roadRut = col * vec3(0.85, 0.83, 0.80) - vec3(0.018, 0.014, 0.012);
  vec3 roadPolished = mix(roadRut, roadDust, smoothstep(0.36, 0.64, roadNoise));
  col = mix(col, roadPolished, dirtMask * 0.82);

  // Dry edge dusting where dirt road feathers into surrounding grass
  float roadEdge = smoothstep(0.08, 0.42, dirtMask) * (1.0 - smoothstep(0.52, 0.88, dirtMask));
  vec3 dryEdgeDust = vec3(0.240, 0.210, 0.125);
  col = mix(col, dryEdgeDust, roadEdge * 0.40);

  // =========================================================================
  // STEEP ROCK CRAGS: Slate grey stone with subtle moss runoffs
  // =========================================================================
  float rockMossNoise = terrainNoise2D(vec2(wPos.x * 1.5, wPos.y * 1.1 + vWorldPosition.y * 0.7), uTerrainSeed + 227.0);
  float mossRunoff = smoothstep(0.58, 0.78, rockMossNoise) * rockMask;
  vec3 rockMossCol = vec3(0.165, 0.230, 0.120);
  col = mix(col, rockMossCol, mossRunoff * 0.45);

  diffuseColor.rgb = clamp(col, 0.0, 1.0);
}
`,
    );

    // 4. Subtle micro roughness variation across biomes (moss, grass, dirt, pebble)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `
#include <roughnessmap_fragment>
{
  vec2 wPos = vWorldPosition.xz;
  vec3 col = diffuseColor.rgb;

  // Biome classification from diffuseColor
  float rRockDiff = max(abs(col.r - col.g), max(abs(col.g - col.b), abs(col.r - col.b)));
  float rRock = clamp((1.0 - rRockDiff * 16.0) * step(0.15, col.b), 0.0, 1.0);
  float rDirt = smoothstep(0.005, 0.038, col.r - col.g) * (1.0 - rRock);
  float rGrass = smoothstep(0.005, 0.038, col.g - col.r) * (1.0 - rRock);

  // Damp moss patches (scale ~1.47m)
  float nRoughMoss = terrainNoise2D(wPos * 0.68, uTerrainSeed + 127.0);
  float dampMossFactor = smoothstep(0.36, 0.66, nRoughMoss) * rGrass;

  // Pebble flecks
  vec2 uvPebble = wPos * 3.3;
  float pebbleHash = terrainHash21(floor(uvPebble), uTerrainSeed + 59.0);
  float isPebble = (1.0 - smoothstep(0.14, 0.24, length(fract(uvPebble) - 0.5))) * step(0.65, pebbleHash);

  // Target roughness calibration:
  // - Damp moss: ~0.84 - 0.88
  // - Dry forest floor / grass: ~0.92 - 0.94
  // - Compacted dirt road & pebbles: ~0.94 - 0.96
  float targetRoughness = 0.93;
  targetRoughness = mix(targetRoughness, 0.86, dampMossFactor);
  targetRoughness = mix(targetRoughness, 0.95, rDirt);
  targetRoughness = mix(targetRoughness, 0.94, rRock);
  targetRoughness = clamp(targetRoughness + isPebble * 0.02, 0.84, 0.96);

  roughnessFactor = targetRoughness;
}
`,
    );
  };

  return mat;
}
