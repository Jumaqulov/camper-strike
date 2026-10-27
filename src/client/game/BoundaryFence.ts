import * as THREE from 'three';
import { sampleTerrainHeight } from '../../shared/terrain';
import type { WorldDefinition } from '../../shared/world';

/**
 * Xarita chegarasi: yog'och ranger panjarasi va "LAGER CHEGARASI" belgilari.
 * Faqat vizual (ko'rinmas chegara devori fizikada allaqachon bor: world.bounds).
 * Barchasi instanced — ustunlar, reykalar, belgi taxtalari uchun 4 ta draw call.
 */
export interface BoundaryFenceHandle {
  group: THREE.Group;
  dispose(): void;
}

const POST_STEP = 3.2;
const SIGN_EVERY = 12; // har 12-segmentda belgi (~38 m)
const POST_H = 1.5;
const RAIL_HEIGHTS = [0.52, 1.1];

function makeSignTexture(): THREE.CanvasTexture | null {
  // Node testlarida (DOM yo'q) tekstura o'rniga oddiy rang ishlatiladi
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d')!;
  // Taxta foni: och yog'och + tolalar
  g.fillStyle = '#b98a52';
  g.fillRect(0, 0, c.width, c.height);
  g.globalAlpha = 0.18;
  for (let i = 0; i < 70; i++) {
    g.fillStyle = i % 2 ? '#7a5230' : '#d9a86a';
    g.fillRect(0, Math.random() * c.height, c.width, 1 + Math.random() * 2);
  }
  g.globalAlpha = 1;
  g.strokeStyle = '#4a2f1b';
  g.lineWidth = 10;
  g.strokeRect(5, 5, c.width - 10, c.height - 10);
  g.fillStyle = '#2b1a0a';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 54px Bahnschrift, "Arial Black", Impact, sans-serif';
  g.fillText('LAGER CHEGARASI', c.width / 2, 58);
  g.font = '800 30px Bahnschrift, "Segoe UI", sans-serif';
  g.fillStyle = '#8a1f12';
  g.fillText('ROUTE 65 · MABUTTS VALLEY · O‘TISH TAQIQLANGAN', c.width / 2, 112);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function buildBoundaryFence(world: WorldDefinition): BoundaryFenceHandle {
  const group = new THREE.Group();
  group.name = 'boundary_fence';
  const b = world.bounds;
  const inset = 0.25; // panjara chizig'i chegaradan shuncha ichkarida (o'yinchi tanasi unga tegib to'xtaydi)
  const minX = b.minX + inset;
  const maxX = b.maxX - inset;
  const minZ = b.minZ + inset;
  const maxZ = b.maxZ - inset;
  const hAt = (x: number, z: number) => sampleTerrainHeight(world.terrain, x, z);

  // To'rt tomon bo'ylab ustun nuqtalari (burchaklar bir marta)
  type Side = { x0: number; z0: number; x1: number; z1: number; inwardYaw: number };
  const sides: Side[] = [
    // PlaneGeometry normali +Z; Y o'qi atrofida θ ga burilganda normal = (sin θ, 0, cos θ)
    { x0: minX, z0: minZ, x1: maxX, z1: minZ, inwardYaw: 0 }, // shimol (-Z) → belgi +Z ga qaraydi
    { x0: maxX, z0: minZ, x1: maxX, z1: maxZ, inwardYaw: -Math.PI / 2 }, // sharq (+X) → -X
    { x0: maxX, z0: maxZ, x1: minX, z1: maxZ, inwardYaw: Math.PI }, // janub (+Z) → -Z
    { x0: minX, z0: maxZ, x1: minX, z1: minZ, inwardYaw: Math.PI / 2 }, // g'arb (-X) → +X
  ];

  const posts: { x: number; z: number; y: number; tall: boolean }[] = [];
  const rails: { ax: number; az: number; ay: number; bx: number; bz: number; by: number }[] = [];
  const signs: { x: number; z: number; y: number; yaw: number }[] = [];

  let seed = 0x5eed;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (const s of sides) {
    const len = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    const n = Math.round(len / POST_STEP);
    const dx = (s.x1 - s.x0) / n;
    const dz = (s.z1 - s.z0) / n;
    let prev: { x: number; z: number; y: number } | null = null;
    for (let i = 0; i < n; i++) {
      const x = s.x0 + dx * i;
      const z = s.z0 + dz * i;
      const y = hAt(x, z);
      const tall = i % SIGN_EVERY === SIGN_EVERY >> 1;
      posts.push({ x, z, y, tall });
      if (tall) {
        // Belgi taxtasi ustunning ichki tomonida, o'yin maydoniga qaraydi
        const ix = Math.sin(s.inwardYaw) * 0.12;
        const iz = Math.cos(s.inwardYaw) * 0.12;
        signs.push({ x: x + ix, z: z + iz, y: y + 1.55, yaw: s.inwardYaw });
      }
      if (prev) rails.push({ ax: prev.x, az: prev.z, ay: prev.y, bx: x, bz: z, by: y });
      prev = { x, z, y };
    }
    // Tomonning oxirgi reykasi keyingi tomonning birinchi ustuniga (burchak)
    const cy = hAt(s.x1, s.z1);
    if (prev) rails.push({ ax: prev.x, az: prev.z, ay: prev.y, bx: s.x1, bz: s.z1, by: cy });
  }

  const woodMat = new THREE.MeshStandardMaterial({ color: '#7a5533', roughness: 0.88, metalness: 0.02 });
  const railMat = new THREE.MeshStandardMaterial({ color: '#8a6238', roughness: 0.86, metalness: 0.02 });
  const signTex = makeSignTexture();
  const signMat = new THREE.MeshStandardMaterial({
    map: signTex ?? undefined,
    color: signTex ? '#ffffff' : '#b98a52',
    roughness: 0.8,
    side: THREE.DoubleSide,
  });

  const postGeo = new THREE.BoxGeometry(0.16, 1, 0.16);
  postGeo.translate(0, 0.5, 0); // tubi 0 da
  const railGeo = new THREE.BoxGeometry(1, 0.11, 0.06);
  const signGeo = new THREE.PlaneGeometry(1.7, 0.53);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  const postMesh = new THREE.InstancedMesh(postGeo, woodMat, posts.length);
  postMesh.name = 'fence_posts';
  const col = new THREE.Color();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i]!;
    const h = (p.tall ? 2.05 : POST_H) * (0.96 + rnd() * 0.08);
    e.set((rnd() - 0.5) * 0.06, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.06);
    q.setFromEuler(e);
    pos.set(p.x, p.y - 0.08, p.z);
    scl.set(1, h, 1);
    m.compose(pos, q, scl);
    postMesh.setMatrixAt(i, m);
    col.setRGB(0.85 + rnd() * 0.3, 0.85 + rnd() * 0.25, 0.85 + rnd() * 0.2);
    postMesh.setColorAt(i, col);
  }
  postMesh.castShadow = false;
  postMesh.receiveShadow = true;
  group.add(postMesh);

  const railMesh = new THREE.InstancedMesh(railGeo, railMat, rails.length * RAIL_HEIGHTS.length);
  railMesh.name = 'fence_rails';
  let ri = 0;
  for (const r of rails) {
    const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
    const yaw = Math.atan2(-(r.bz - r.az), r.bx - r.ax); // +X bo'ylab reyka
    for (const rh of RAIL_HEIGHTS) {
      const ay = r.ay + rh;
      const by = r.by + rh;
      const pitch = Math.atan2(by - ay, len);
      e.set(0, yaw, pitch, 'YXZ');
      q.setFromEuler(e);
      pos.set((r.ax + r.bx) / 2, (ay + by) / 2 + (rnd() - 0.5) * 0.03, (r.az + r.bz) / 2);
      scl.set(len * 1.02, 1, 1);
      m.compose(pos, q, scl);
      railMesh.setMatrixAt(ri, m);
      col.setRGB(0.85 + rnd() * 0.3, 0.85 + rnd() * 0.25, 0.85 + rnd() * 0.2);
      railMesh.setColorAt(ri, col);
      ri++;
    }
  }
  railMesh.castShadow = false;
  railMesh.receiveShadow = true;
  group.add(railMesh);

  const signMesh = new THREE.InstancedMesh(signGeo, signMat, signs.length);
  signMesh.name = 'fence_signs';
  for (let i = 0; i < signs.length; i++) {
    const s = signs[i]!;
    e.set(0, s.yaw, (rnd() - 0.5) * 0.04);
    q.setFromEuler(e);
    pos.set(s.x, s.y, s.z);
    scl.set(1, 1, 1);
    m.compose(pos, q, scl);
    signMesh.setMatrixAt(i, m);
  }
  signMesh.castShadow = false;
  signMesh.receiveShadow = false;
  group.add(signMesh);

  // Panjara xaritani halqa bo'ylab o'raydi: instanced mesh ning bounding sphere si kamerani doim
  // o'z ichiga oladi, shuning uchun three.js frustum tekshiruvi hech qachon kesmaydi — uni o'chirib,
  // har kadrdagi bekor hisobni tejaymiz. Masofaviy yashirish yo'q (4 ta arzon draw call, update hook ham yo'q).
  postMesh.frustumCulled = false;
  railMesh.frustumCulled = false;
  signMesh.frustumCulled = false;

  return {
    group,
    dispose() {
      group.parent?.remove(group);
      postMesh.dispose();
      railMesh.dispose();
      signMesh.dispose();
      postGeo.dispose();
      railGeo.dispose();
      signGeo.dispose();
      woodMat.dispose();
      railMat.dispose();
      signMat.dispose();
      signTex?.dispose();
    },
  };
}
