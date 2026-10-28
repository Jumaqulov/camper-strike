import * as THREE from 'three';
import {
  buildTerrainMeshData,
  sampleTerrainHeight,
  type MaterialKind,
  type WorldDefinition,
} from '../../shared/world';
import type { QualityLevel } from '../settings';
import {
  buildForestSampleScene,
  type CullingProfileStats,
  type Stage04ASceneHandles,
} from './ForestRenderer';
import { scaleBoxUVs } from './geometryUtils';
import { createTextures, TEX_SCALE } from './Textures';
import type { GroundCoverStats } from './GroundCoverRenderer';

export type { CullingProfileStats, Stage04ASceneHandles, GroundCoverStats };

/** Dunyo yoritilishi: 'day' — golden-hour (standart), 'night' — "Tong otguncha" oy nuri va tun tumani. */
export type WorldTheme = 'day' | 'night';

export interface WorldHandles {
  sun: THREE.DirectionalLight;
  sky: THREE.Mesh;
  setQuality?: (q: QualityLevel) => void;
  update?: (
    camera?: THREE.Camera,
    focusPos?: { x: number; y: number; z: number },
    thirdPerson?: boolean,
  ) => void;
  getCullingProfile?: () => CullingProfileStats;
  resetCullingProfile?: () => void;
  /** STAGE 08-FIX: visual-only ground cover stats (only present on `forest_square`). */
  getGroundCoverStats?: () => GroundCoverStats;
  stage04a?: Stage04ASceneHandles;
  dispose: () => void;
}

/** 3D qarag'ay daraxti (Pine Tree) yaratish */
function addPineTree(
  group: THREE.Group,
  x: number,
  y: number,
  z: number,
  scale: number,
  trunkMat: THREE.Material,
  leafMat1: THREE.Material,
  leafMat2: THREE.Material,
) {
  const tree = new THREE.Group();
  tree.position.set(x, y, z);
  tree.scale.setScalar(scale);

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.36, 2.4, 7), trunkMat);
  trunk.position.y = 1.2;
  trunk.castShadow = true;
  tree.add(trunk);

  const tiers: [number, number, number, THREE.Material][] = [
    [1.85, 3.2, 3.1, leafMat1],
    [1.45, 2.8, 4.9, leafMat2],
    [0.98, 2.3, 6.4, leafMat1],
  ];
  for (const [r, ch, cy, mat] of tiers) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, ch, 8), mat);
    cone.position.y = cy;
    cone.castShadow = true;
    cone.receiveShadow = true;
    tree.add(cone);
  }
  group.add(tree);
}

/**
 * Dunyo sahnasini quradi. O'rmon xaritalari (`forest_sample`, `forest_assets_preview`, `forest_square`)
 * `ForestRenderer` orqali, `forest_technical` esa quyidagi oddiy protsedural quruvchi orqali chiziladi.
 */
export function buildWorld(
  scene: THREE.Scene,
  world: WorldDefinition,
  quality: QualityLevel = 'medium',
  theme: WorldTheme = 'day',
): WorldHandles {
  if (
    world.mapId === 'forest_sample' ||
    world.mapId === 'forest_assets_preview' ||
    world.mapId === 'forest_square'
  ) {
    return buildForestSampleScene(scene, world, quality, theme);
  }
  const night = theme === 'night';
  const textures = createTextures();
  const mats = {} as Record<MaterialKind, THREE.MeshStandardMaterial>;
  for (const k of Object.keys(textures) as MaterialKind[]) {
    mats[k] = new THREE.MeshStandardMaterial({
      map: textures[k],
      roughness: k === 'metal' ? 0.42 : 0.9,
      metalness: k === 'metal' ? 0.25 : 0,
    });
  }

  const group = new THREE.Group();
  group.name = 'world';
  const logCapMat = new THREE.MeshStandardMaterial({ color: '#cfa36e', roughness: 0.85 });

  // Heightfield Terrain Mesh (Stage 02B): uses the exact same triangle split as physics
  let terrainMat: THREE.MeshStandardMaterial | null = null;
  {
    const meshData = buildTerrainMeshData(world.terrain);
    const terrainGeo = new THREE.BufferGeometry();
    terrainGeo.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    terrainGeo.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(meshData.colors, 3));
    terrainGeo.setAttribute('uv', new THREE.BufferAttribute(meshData.uvs, 2));
    terrainGeo.setIndex(new THREE.BufferAttribute(meshData.indices, 1));

    terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.02,
      flatShading: false,
    });
    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.name = 'heightfield_terrain';
    terrainMesh.receiveShadow = true;
    terrainMesh.castShadow = true;
    group.add(terrainMesh);
  }

  for (const vis of world.visuals) {
    if (vis.batchMode !== 'static_box' || !vis.boxDims || !vis.material) continue;
    const w = vis.boxDims.x;
    const h = vis.boxDims.y;
    const d = vis.boxDims.z;
    const cx = vis.transform.position.x;
    const cy = vis.transform.position.y;
    const cz = vis.transform.position.z;
    const topY = cy + h / 2;
    const mat = vis.material;

    const geo = new THREE.BoxGeometry(w, h, d);
    scaleBoxUVs(geo, w, h, d, TEX_SCALE[mat]);
    const m = new THREE.Mesh(geo, mats[mat]);
    m.position.set(cx, cy, cz);
    m.receiveShadow = vis.receiveShadow;
    m.castShadow = vis.castShadow;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);

    // Yog'och devorlar ('wall') ustiga 3D dumaloq xoda (log) qoplamasi qo'shish
    if (mat === 'wall' && h >= 1.5 && (w >= 2 || d >= 2)) {
      const horizX = w >= d;
      const len = horizX ? w + 0.16 : d + 0.16;
      const rad = Math.min(0.28, (horizX ? d : w) * 0.55);
      const topLog = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 10), mats.wall);
      if (horizX) topLog.rotation.z = Math.PI / 2;
      else topLog.rotation.x = Math.PI / 2;
      topLog.position.set(cx, topY, cz);
      topLog.castShadow = true;
      group.add(topLog);

      // Xoda uchlaridagi kesim doiralari
      for (const s of [-1, 1]) {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.85, rad * 0.85, 0.04, 10), logCapMat);
        if (horizX) {
          cap.rotation.z = Math.PI / 2;
          cap.position.set(cx + s * (len / 2), topY, cz);
        } else {
          cap.rotation.x = Math.PI / 2;
          cap.position.set(cx, topY, cz + s * (len / 2));
        }
        group.add(cap);
      }
    }
  }

  const trunkMat = new THREE.MeshStandardMaterial({ color: '#54351c', roughness: 0.9 });
  const leafMat1 = new THREE.MeshStandardMaterial({ color: '#244d29', roughness: 0.85 });
  const leafMat2 = new THREE.MeshStandardMaterial({ color: '#2f6133', roughness: 0.85 });

  if (world.mapId === 'forest_technical') {
    // Decorate grounded pine tree on the technical terrain fixture
    const treeGroundY = sampleTerrainHeight(world.terrain, -10, 8);
    addPineTree(group, -10, treeGroundY, 8, 1.25, trunkMat, leafMat1, leafMat2);
  }

  // Maydon atrofidagi qalin qarag'ay o'rmoni (130+ daraxt)
  for (let i = 0; i < 135; i++) {
    const a = (i / 135) * Math.PI * 2 + (Math.sin(i * 19.7) * 0.04);
    const ring = i % 3;
    const r = 58 + ring * 18 + (Math.cos(i * 7.3) * 6);
    const tx = Math.cos(a) * r * 1.12;
    const tz = Math.sin(a) * r * 0.88;
    const sc = 1.15 + ((i * 37) % 10) * 0.14;
    addPineTree(group, tx, -0.4, tz, sc, trunkMat, leafMat1, leafMat2);
  }

  // Uzoqdagi qorli tog' cho'qqilari ("Mt. Yurbuttsk" / Wilderness Mountains)
  const rockMat = new THREE.MeshStandardMaterial({ color: '#5c666e', roughness: 0.95 });
  const snowMat = new THREE.MeshStandardMaterial({ color: '#eef5f8', roughness: 0.7 });
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const r = 145 + (i % 3) * 32;
    const h = 38 + (i % 5) * 14;
    const rad = 26 + (i % 4) * 8;
    const mx = Math.cos(a) * r * 1.15;
    const mz = Math.sin(a) * r * 0.95;

    const mt = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 7), rockMat);
    mt.position.set(mx, h / 2 - 2, mz);
    mt.rotation.y = i * 0.9;
    group.add(mt);

    const capH = h * 0.36;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.37, capH, 7), snowMat);
    cap.position.set(mx, h - capH / 2 - 1.8, mz);
    cap.rotation.y = mt.rotation.y;
    group.add(cap);
  }

  const outerGround = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({ color: '#39592a', roughness: 1 }),
  );
  outerGround.rotation.x = -Math.PI / 2;
  outerGround.position.y = -3.2;
  group.add(outerGround);
  scene.add(group);

  // "RV There Yet?" Golden-Hour Mabutts Valley yorug'ligi (tunda — oy nuri)
  const hemi = night
    ? new THREE.HemisphereLight('#2b3a66', '#0d1410', 0.45)
    : new THREE.HemisphereLight('#ffe9c4', '#3f5930', 1.2);
  scene.add(hemi);
  const sun = night ? new THREE.DirectionalLight('#aebfff', 0.5) : new THREE.DirectionalLight('#ffe6b0', 2.85);
  sun.position.set(42, 62, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -62;
  sc.right = 62;
  sc.top = 48;
  sc.bottom = -48;
  sc.near = 10;
  sc.far = 170;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  // Mabutts Valley Golden-Hour osmoni
  const sunDir = sun.position.clone().normalize();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(night ? '#05070f' : '#1f579c') },
      bottom: { value: new THREE.Color(night ? '#1b2240' : '#f0d8b4') },
      sunDir: { value: sunDir },
      // Yorug'lik manbai nuri: kunduzi iliq quyosh gardishi, tunda kichikroq va oqroq oy
      glowColor: { value: night ? new THREE.Color(0.86, 0.9, 1.0) : new THREE.Color(1.0, 0.88, 0.62) },
      glowCore: { value: night ? 2.2 : 4.2 },
      glowHalo: { value: night ? 0.1 : 0.32 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 bottom;
      uniform vec3 sunDir;
      uniform vec3 glowColor;
      uniform float glowCore;
      uniform float glowHalo;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y * 1.55 + 0.06, 0.0, 1.0);
        vec3 col = mix(bottom, top, pow(h, 0.75));
        float s = max(dot(d, sunDir), 0.0);
        col += glowColor * (pow(s, 800.0) * glowCore + pow(s, 10.0) * glowHalo);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  scene.fog = night ? new THREE.Fog('#0a0f1c', 40, 190) : new THREE.Fog('#c8d9cc', 95, 340);

  return {
    sun,
    sky,
    dispose: () => {
      sun.shadow.map?.dispose();
      scene.remove(group);
      scene.remove(hemi);
      scene.remove(sun);
      scene.remove(sun.target);
      scene.remove(sky);
      sky.geometry.dispose();
      // Dekoratsiya materiallari va teksturalar (daraxtlar, tog'lar, yo'l qoplamalari) ham
      // bo'shatilsin — aks holda har kirib-chiqishda GPU xotirasi o'sib borardi.
      const disposedMats = new Set<THREE.Material>();
      const disposedTex = new Set<THREE.Texture>();
      group.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) {
          if (!m || disposedMats.has(m) || m.userData?.sharedAsset) continue;
          disposedMats.add(m);
          for (const key of ['map', 'normalMap', 'roughnessMap', 'emissiveMap', 'alphaMap'] as const) {
            const tex = (m as unknown as Record<string, unknown>)[key];
            if (tex instanceof THREE.Texture && !disposedTex.has(tex)) {
              disposedTex.add(tex);
              tex.dispose();
            }
          }
          m.dispose();
        }
      });
      terrainMat?.dispose();
      Object.values(mats).forEach((m) => m.dispose());
      Object.values(textures).forEach((t) => t.dispose());
      skyMat.dispose();
    },
  };
}
