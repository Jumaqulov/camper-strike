import * as THREE from 'three';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../../shared/constants';
import type { Vec3 } from '../../../shared/math';
import { boxOverlap, queryNearbyColliders } from '../../../shared/physics';
import { isTerrainWalkable, sampleTerrainHeight, sampleTerrainSlopeDeg } from '../../../shared/terrain';
import type { ColliderBox, WorldDefinition } from '../../../shared/world';

/**
 * STAGE 08-FIX — DEV-only collision debug overlay (toggle: F9).
 *
 * Shows the client-predicted body capsule, the last server-authoritative capsule, the sampled
 * terrain height under the feet and the nearest collider AABBs, plus a text panel with foot Y,
 * terrain Y, active/overlapping collider IDs and client↔server mismatch. Game.ts only creates it
 * behind `import.meta.env.DEV`, so production builds never instantiate (and tree-shake) it.
 */

export interface CollisionDebugInput {
  alive: boolean;
  /** Client-predicted physics position (feet). */
  predicted: Vec3;
  /** Rendered (smoothed) position (feet). */
  rendered?: Vec3;
  onGround: boolean;
  /** Last server-authoritative position (feet) from the latest snapshot, if any. */
  server: Vec3 | null;
  /** Predicted vs server position at the same acknowledged input seq, if known. */
  ack?: { ackSeq: number; predictedAtAck: Vec3; serverAtAck: Vec3; errorDist: number } | null;
}

export interface CollisionDebugNearbyCollider {
  id: string;
  tag: ColliderBox['tag'];
  /** Horizontal gap between the capsule surface and the box (negative = overlapping in XZ). */
  gap: number;
  overlapping: boolean;
  supporting: boolean;
  box: ColliderBox;
}

export interface CollisionDebugInfo {
  feetY: number;
  terrainY: number;
  feetAboveTerrain: number;
  slopeDeg: number;
  walkable: boolean;
  onGround: boolean;
  supportId: string | null;
  overlappingIds: string[];
  nearby: CollisionDebugNearbyCollider[];
  /** |server - predicted| right now (includes the normal latency lead of prediction). */
  liveMismatch: number | null;
  /** |server - predicted| at the same acked seq (true prediction error). */
  ackMismatch: number | null;
  ackSeq: number | null;
  renderOffset: number;
}

const SUPPORT_TOL = 0.06;
const OVERLAP_EPS = 0.005;

/** Pure, testable: derives all overlay values from world + positions. */
export function computeCollisionDebugInfo(
  world: WorldDefinition,
  input: CollisionDebugInput,
  maxNearby = 6,
): CollisionDebugInfo {
  const p = input.predicted;
  const r = PLAYER_RADIUS;
  const h = PLAYER_HEIGHT;
  const terrainY = sampleTerrainHeight(world.terrain, p.x, p.z);
  const candidates = queryNearbyColliders(world, p.x, p.z, 2.5, p.y - 1.5, p.y + h + 1.5);
  const nearby: CollisionDebugNearbyCollider[] = [];
  const overlappingIds: string[] = [];
  let support: ColliderBox | null = null;
  for (const b of candidates) {
    const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
    const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
    const gap = Math.hypot(dx, dz) - r;
    const overlapping = boxOverlap(
      p.x,
      p.y + OVERLAP_EPS,
      p.z,
      r - OVERLAP_EPS,
      h - 2 * OVERLAP_EPS,
      b,
    );
    const inFootprint = p.x + r > b.min.x && p.x - r < b.max.x && p.z + r > b.min.z && p.z - r < b.max.z;
    const supporting = inFootprint && Math.abs(p.y - b.max.y) <= SUPPORT_TOL;
    if (supporting && (!support || b.max.y > support.max.y)) support = b;
    if (overlapping) overlappingIds.push(b.id);
    nearby.push({ id: b.id, tag: b.tag, gap, overlapping, supporting, box: b });
  }
  nearby.sort((a, b) => Number(b.overlapping) - Number(a.overlapping) || a.gap - b.gap || (a.id < b.id ? -1 : 1));
  const server = input.server;
  const liveMismatch = server ? Math.hypot(server.x - p.x, server.y - p.y, server.z - p.z) : null;
  const rendered = input.rendered ?? p;
  return {
    feetY: p.y,
    terrainY,
    feetAboveTerrain: p.y - terrainY,
    slopeDeg: sampleTerrainSlopeDeg(world.terrain, p.x, p.z),
    walkable: isTerrainWalkable(world.terrain, p.x, p.z),
    onGround: input.onGround,
    supportId: support ? support.id : null,
    overlappingIds,
    nearby: nearby.slice(0, Math.max(0, maxNearby)),
    liveMismatch,
    ackMismatch: input.ack ? input.ack.errorDist : null,
    ackSeq: input.ack ? input.ack.ackSeq : null,
    renderOffset: Math.hypot(rendered.x - p.x, rendered.y - p.y, rendered.z - p.z),
  };
}

const f3 = (n: number) => n.toFixed(3);
const shortId = (id: string) => (id.length > 64 ? '…' + id.slice(id.length - 63) : id);

export function formatCollisionDebugText(info: CollisionDebugInfo, input: CollisionDebugInput): string {
  const p = input.predicted;
  const s = input.server;
  const lines = [
    'COLLISION DEBUG (F9)',
    `pred  : (${f3(p.x)}, ${f3(p.y)}, ${f3(p.z)}) ${info.onGround ? 'ground' : 'air'}`,
    s ? `server: (${f3(s.x)}, ${f3(s.y)}, ${f3(s.z)})` : 'server: —',
    `mismatch live ${info.liveMismatch === null ? '—' : f3(info.liveMismatch)} m | at ack#${info.ackSeq ?? '—'} ${
      info.ackMismatch === null ? '—' : f3(info.ackMismatch)
    } m | render ofs ${f3(info.renderOffset)} m`,
    `footY ${f3(info.feetY)} | terrainY ${f3(info.terrainY)} | Δ ${f3(info.feetAboveTerrain)}${
      info.feetAboveTerrain < -0.02 ? '  !! UNDER TERRAIN' : ''
    }`,
    `slope ${info.slopeDeg.toFixed(1)}° ${info.walkable ? 'walkable' : 'STEEP'} | support: ${
      info.supportId ? shortId(info.supportId) : info.feetAboveTerrain <= 0.08 ? 'terrain' : 'none'
    }`,
    info.overlappingIds.length ? `!! OVERLAP: ${info.overlappingIds.map(shortId).join(', ')}` : 'overlap: none',
    'nearby:',
    ...info.nearby.map(
      (n) => `  ${n.overlapping ? '!!' : n.supporting ? '^ ' : '  '}${n.tag.padEnd(9)} gap ${n.gap.toFixed(2)}  ${shortId(n.id)}`,
    ),
  ];
  return lines.join('\n');
}

const MAX_BOXES = 12;
const COLOR_PRED = 0x37ff7a;
const COLOR_SERVER = 0xffa133;
const COLOR_BOX = 0x33d6ff;
const COLOR_BOX_OVERLAP = 0xff3344;
const COLOR_BOX_SUPPORT = 0xffee33;
const COLOR_TERRAIN = 0xff55ff;

function makeLineMaterial(color: number): THREE.LineBasicMaterial {
  const m = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
  return m;
}

export class CollisionDebugOverlay {
  private enabled = false;
  private readonly group = new THREE.Group();
  private readonly predCapsule: THREE.LineSegments;
  private readonly serverCapsule: THREE.LineSegments;
  private readonly terrainMarker: THREE.LineSegments;
  private readonly boxes: THREE.LineSegments[] = [];
  private readonly boxMats: Record<'normal' | 'overlap' | 'support', THREE.LineBasicMaterial>;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly panel: HTMLPreElement;
  private textAcc = 0;
  private lastInfo: CollisionDebugInfo | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    parent: HTMLElement = document.body,
  ) {
    this.group.name = 'collision-debug-overlay';
    this.group.visible = false;
    this.group.renderOrder = 999;

    const capsuleGeo = new THREE.WireframeGeometry(
      new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - 2 * PLAYER_RADIUS, 3, 10),
    );
    const predMat = makeLineMaterial(COLOR_PRED);
    const serverMat = makeLineMaterial(COLOR_SERVER);
    this.predCapsule = new THREE.LineSegments(capsuleGeo, predMat);
    this.serverCapsule = new THREE.LineSegments(capsuleGeo, serverMat);
    this.predCapsule.renderOrder = 999;
    this.serverCapsule.renderOrder = 999;

    const cross = new THREE.BufferGeometry();
    cross.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.6, 0, 0, 0.6, 0, 0, 0, 0, -0.6, 0, 0, 0.6, 0, 0, 0, 0, 0.25, 0], 3),
    );
    const terrainMat = makeLineMaterial(COLOR_TERRAIN);
    this.terrainMarker = new THREE.LineSegments(cross, terrainMat);
    this.terrainMarker.renderOrder = 999;

    const unitBox = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.boxMats = {
      normal: makeLineMaterial(COLOR_BOX),
      overlap: makeLineMaterial(COLOR_BOX_OVERLAP),
      support: makeLineMaterial(COLOR_BOX_SUPPORT),
    };
    for (let i = 0; i < MAX_BOXES; i++) {
      const ls = new THREE.LineSegments(unitBox, this.boxMats.normal);
      ls.visible = false;
      ls.renderOrder = 999;
      this.boxes.push(ls);
      this.group.add(ls);
    }
    this.geos.push(capsuleGeo, cross, unitBox);
    this.mats.push(predMat, serverMat, terrainMat, this.boxMats.normal, this.boxMats.overlap, this.boxMats.support);
    this.group.add(this.predCapsule, this.serverCapsule, this.terrainMarker);
    scene.add(this.group);

    this.panel = document.createElement('pre');
    this.panel.id = 'collision-debug-panel';
    this.panel.style.cssText =
      'position:fixed;left:8px;bottom:150px;z-index:60;margin:0;padding:6px 8px;max-width:46vw;' +
      'font:11px/1.35 monospace;color:#d9ffe6;background:rgba(0,0,0,0.62);border:1px solid #2c6;' +
      'border-radius:4px;pointer-events:none;white-space:pre;display:none;';
    parent.appendChild(this.panel);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    this.panel.style.display = on ? 'block' : 'none';
    this.textAcc = 1;
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  getLastInfo(): CollisionDebugInfo | null {
    return this.lastInfo;
  }

  update(dt: number, world: WorldDefinition, input: CollisionDebugInput): void {
    if (!this.enabled) return;
    const info = computeCollisionDebugInfo(world, input, MAX_BOXES);
    this.lastInfo = info;
    const p = input.predicted;
    const half = PLAYER_HEIGHT / 2;

    this.predCapsule.visible = input.alive;
    this.predCapsule.position.set(p.x, p.y + half, p.z);
    const s = input.server;
    this.serverCapsule.visible = input.alive && !!s;
    if (s) this.serverCapsule.position.set(s.x, s.y + half, s.z);
    this.terrainMarker.position.set(p.x, info.terrainY + 0.01, p.z);

    for (let i = 0; i < this.boxes.length; i++) {
      const ls = this.boxes[i];
      const n = info.nearby[i];
      if (!n) {
        ls.visible = false;
        continue;
      }
      const b = n.box;
      ls.visible = true;
      ls.material = n.overlapping ? this.boxMats.overlap : n.supporting ? this.boxMats.support : this.boxMats.normal;
      ls.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
      ls.scale.set(
        Math.max(0.01, b.max.x - b.min.x),
        Math.max(0.01, b.max.y - b.min.y),
        Math.max(0.01, b.max.z - b.min.z),
      );
    }

    this.textAcc += dt;
    if (this.textAcc >= 0.1) {
      this.textAcc = 0;
      const shown = { ...info, nearby: info.nearby.slice(0, 6) };
      this.panel.textContent = formatCollisionDebugText(shown, input);
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.panel.remove();
  }
}
