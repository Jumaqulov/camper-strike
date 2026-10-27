import * as THREE from 'three';
import type { SurvivalZoneCircle } from '../../../shared/survival';

/**
 * Xavfsiz zona chegarasi — dunyoda ko'rinadigan yarim shaffof silindr devor.
 * Geometriya birlik radiusli; har kadrda faqat pozitsiya va masshtab yangilanadi (GPU uchun arzon).
 */
export class ZoneWall {
  readonly root = new THREE.Group();
  private readonly wall: THREE.Mesh;
  private readonly rim: THREE.Mesh;
  private readonly wallMat: THREE.MeshBasicMaterial;
  private readonly rimMat: THREE.MeshBasicMaterial;
  private t = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'survival_zone_wall';
    const wallGeo = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true);
    this.wallMat = new THREE.MeshBasicMaterial({
      color: '#4fc3f7',
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    });
    this.wall = new THREE.Mesh(wallGeo, this.wallMat);
    this.wall.renderOrder = 20;
    this.wall.frustumCulled = false;
    this.root.add(this.wall);

    // Yer sathidagi yorqin chiziq — chegarani yerdan aniq ko'rsatadi
    const rimGeo = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true);
    this.rimMat = new THREE.MeshBasicMaterial({
      color: '#aee9ff',
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    });
    this.rim = new THREE.Mesh(rimGeo, this.rimMat);
    this.rim.renderOrder = 21;
    this.rim.frustumCulled = false;
    this.root.add(this.rim);

    this.root.visible = false;
    scene.add(this.root);
  }

  /** Aylana va holatni yangilaydi; `shrinking` — devor pulsatsiya qiladi. */
  update(zone: SurvivalZoneCircle | null, groundY: number, shrinking: boolean, dt: number): void {
    if (!zone) {
      this.root.visible = false;
      return;
    }
    this.t += dt;
    this.root.visible = true;
    const height = 70;
    this.wall.position.set(zone.cx, groundY + height / 2 - 6, zone.cz);
    this.wall.scale.set(zone.radius, height, zone.radius);
    this.rim.position.set(zone.cx, groundY + 0.6, zone.cz);
    this.rim.scale.set(zone.radius + 0.05, 1.2, zone.radius + 0.05);
    const pulse = shrinking ? 0.5 + 0.5 * Math.sin(this.t * 5) : 0;
    this.wallMat.opacity = 0.14 + pulse * 0.1;
    this.rimMat.opacity = 0.5 + pulse * 0.35;
    this.wallMat.color.set(shrinking ? '#ffb74d' : '#4fc3f7');
    this.rimMat.color.set(shrinking ? '#ffe0b2' : '#aee9ff');
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.wall.geometry.dispose();
    this.rim.geometry.dispose();
    this.wallMat.dispose();
    this.rimMat.dispose();
  }
}
