import * as THREE from 'three';
import type { PublicContainerState, PublicLootItem, RoomLootSnapshot } from '../../../shared/loot';
import type { Vec3 } from '../../../shared/math';
import { WEAPON_SLOTS, type WeaponId } from '../../../shared/weapons';
import type { WorldDefinition } from '../../../shared/world';
import type { ContainerVisualsSceneHandles } from '../containers';
import { WorldWeaponItem } from '../WorldWeaponItem';

export interface LootWorldRendererDiagnostics {
  version: number;
  activeItemMeshCount: number;
  visibleItemMeshCount: number;
  openContainerIds: string[];
  renderedItemIds: string[];
  highlightedContainerId: string | null;
  highlightedItemId: string | null;
}

const MAX_DRAW_DIST = 28;
const MAX_DRAW_DIST_SQ = MAX_DRAW_DIST * MAX_DRAW_DIST; // 784
const ITEM_Y_LIFT = 0.03;
const WEAPON_INSIDE_CONTAINER_SCALE = 0.56;

interface SharedProceduralLootCache {
  ammoBodyGeo: THREE.BoxGeometry;
  ammoStripeGeo: THREE.BoxGeometry;
  ammoBrassBarGeo: THREE.BoxGeometry;
  ammoBaseMat: THREE.MeshStandardMaterial;
  ammoBrassMat: THREE.MeshStandardMaterial;
  ammoStripeMats: Record<WeaponId, THREE.MeshStandardMaterial>;

  medkitBodyGeo: THREE.BoxGeometry;
  medkitTopCrossHGeo: THREE.BoxGeometry;
  medkitTopCrossVGeo: THREE.BoxGeometry;
  medkitFrontCrossHGeo: THREE.BoxGeometry;
  medkitFrontCrossVGeo: THREE.BoxGeometry;
  medkitBodyMat: THREE.MeshStandardMaterial;
  medkitCrossMat: THREE.MeshStandardMaterial;

  grenadeSphereGeo: THREE.SphereGeometry;
  grenadeNeckGeo: THREE.CylinderGeometry;
  grenadeRingGeo: THREE.TorusGeometry;
  grenadeLeverGeo: THREE.BoxGeometry;
  grenadeBodyMat: THREE.MeshStandardMaterial;
  grenadeCapMat: THREE.MeshStandardMaterial;

  itemHighlightRingGeo: THREE.RingGeometry;
  itemHighlightRingMat: THREE.MeshBasicMaterial;
  containerHighlightRingGeo: THREE.RingGeometry;
  containerHighlightRingMat: THREE.MeshBasicMaterial;
}

let sharedLootCache: SharedProceduralLootCache | null = null;

function markShared<T extends THREE.BufferGeometry | THREE.Material>(asset: T): T {
  asset.userData = { ...(asset.userData ?? {}), sharedAsset: true };
  return asset;
}

function getSharedProceduralLootCache(): SharedProceduralLootCache {
  if (sharedLootCache) return sharedLootCache;

  // Ammo box (0.22 x 0.14 x 0.16 m) + color-coded stripe + brass cartridge bar
  const ammoBodyGeo = markShared(new THREE.BoxGeometry(0.22, 0.14, 0.16));
  const ammoStripeGeo = markShared(new THREE.BoxGeometry(0.226, 0.044, 0.166));
  const ammoBrassBarGeo = markShared(new THREE.BoxGeometry(0.12, 0.022, 0.046));

  const ammoBaseMat = markShared(
    new THREE.MeshStandardMaterial({
      name: 'loot_ammo_base_mat',
      color: '#2b332e',
      roughness: 0.62,
      metalness: 0.28,
    }),
  );
  const ammoBrassMat = markShared(
    new THREE.MeshStandardMaterial({
      name: 'loot_ammo_brass_mat',
      color: '#d4af37',
      roughness: 0.32,
      metalness: 0.68,
    }),
  );
  const ammoStripeMats: Record<WeaponId, THREE.MeshStandardMaterial> = {
    // Pichoq uchun o'q yo'q — faqat tip to'liqligi uchun (hech qachon chizilmaydi)
    knife: markShared(new THREE.MeshStandardMaterial({ name: 'loot_ammo_knife_mat', color: '#777777' })),
    rifle: markShared(
      new THREE.MeshStandardMaterial({
        name: 'loot_ammo_rifle_mat',
        color: '#2b6cb0',
        roughness: 0.48,
        metalness: 0.15,
      }),
    ),
    pistol: markShared(
      new THREE.MeshStandardMaterial({
        name: 'loot_ammo_pistol_mat',
        color: '#d69e2e',
        roughness: 0.48,
        metalness: 0.15,
      }),
    ),
    shotgun: markShared(
      new THREE.MeshStandardMaterial({
        name: 'loot_ammo_shotgun_mat',
        color: '#c53030',
        roughness: 0.48,
        metalness: 0.15,
      }),
    ),
    sniper: markShared(
      new THREE.MeshStandardMaterial({
        name: 'loot_ammo_sniper_mat',
        color: '#2f855a',
        roughness: 0.48,
        metalness: 0.15,
      }),
    ),
  };

  // Medkit (0.24 x 0.15 x 0.18 m) white/cream box + red cross (#e53e3e) on top and front
  const medkitBodyGeo = markShared(new THREE.BoxGeometry(0.24, 0.15, 0.18));
  const medkitTopCrossHGeo = markShared(new THREE.BoxGeometry(0.11, 0.008, 0.032));
  const medkitTopCrossVGeo = markShared(new THREE.BoxGeometry(0.032, 0.008, 0.11));
  const medkitFrontCrossHGeo = markShared(new THREE.BoxGeometry(0.09, 0.026, 0.008));
  const medkitFrontCrossVGeo = markShared(new THREE.BoxGeometry(0.026, 0.09, 0.008));

  const medkitBodyMat = markShared(
    new THREE.MeshStandardMaterial({
      name: 'loot_medkit_body_mat',
      color: '#f6f4eb',
      roughness: 0.45,
      metalness: 0.08,
    }),
  );
  const medkitCrossMat = markShared(
    new THREE.MeshStandardMaterial({
      name: 'loot_medkit_cross_mat',
      color: '#e53e3e',
      roughness: 0.4,
      metalness: 0.05,
    }),
  );

  // Grenade (0.14m diameter sphere + brass lever ring)
  const grenadeSphereGeo = markShared(new THREE.SphereGeometry(0.07, 12, 10));
  const grenadeNeckGeo = markShared(new THREE.CylinderGeometry(0.022, 0.026, 0.034, 10));
  const grenadeRingGeo = markShared(new THREE.TorusGeometry(0.022, 0.0045, 8, 16));
  const grenadeLeverGeo = markShared(new THREE.BoxGeometry(0.016, 0.075, 0.028));

  const grenadeBodyMat = markShared(
    new THREE.MeshStandardMaterial({
      name: 'loot_grenade_body_mat',
      color: '#3f5a36',
      roughness: 0.55,
      metalness: 0.25,
    }),
  );
  const grenadeCapMat = markShared(
    new THREE.MeshStandardMaterial({
      name: 'loot_grenade_cap_mat',
      color: '#2c332e',
      roughness: 0.5,
      metalness: 0.45,
    }),
  );

  const itemHighlightRingGeo = markShared(new THREE.RingGeometry(0.14, 0.19, 24));
  itemHighlightRingGeo.rotateX(-Math.PI / 2);
  const itemHighlightRingMat = markShared(
    new THREE.MeshBasicMaterial({
      name: 'loot_item_highlight_ring_mat',
      color: '#ffd166',
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );

  const containerHighlightRingGeo = markShared(new THREE.RingGeometry(0.56, 0.66, 32));
  containerHighlightRingGeo.rotateX(-Math.PI / 2);
  const containerHighlightRingMat = markShared(
    new THREE.MeshBasicMaterial({
      name: 'loot_container_highlight_ring_mat',
      color: '#ffd166',
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );

  sharedLootCache = {
    ammoBodyGeo,
    ammoStripeGeo,
    ammoBrassBarGeo,
    ammoBaseMat,
    ammoBrassMat,
    ammoStripeMats,
    medkitBodyGeo,
    medkitTopCrossHGeo,
    medkitTopCrossVGeo,
    medkitFrontCrossHGeo,
    medkitFrontCrossVGeo,
    medkitBodyMat,
    medkitCrossMat,
    grenadeSphereGeo,
    grenadeNeckGeo,
    grenadeRingGeo,
    grenadeLeverGeo,
    grenadeBodyMat,
    grenadeCapMat,
    itemHighlightRingGeo,
    itemHighlightRingMat,
    containerHighlightRingGeo,
    containerHighlightRingMat,
  };

  return sharedLootCache;
}

function buildStylizedAmmoGroup(ammoWeapon: WeaponId): THREE.Group {
  const cache = getSharedProceduralLootCache();
  const group = new THREE.Group();
  group.name = `loot_marker_ammo_${ammoWeapon}`;

  const body = new THREE.Mesh(cache.ammoBodyGeo, cache.ammoBaseMat);
  body.position.y = 0.07;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const stripeMat = cache.ammoStripeMats[ammoWeapon] ?? cache.ammoStripeMats.rifle;
  const stripe = new THREE.Mesh(cache.ammoStripeGeo, stripeMat);
  stripe.position.y = 0.078;
  group.add(stripe);

  const brassBar = new THREE.Mesh(cache.ammoBrassBarGeo, cache.ammoBrassMat);
  brassBar.position.set(0, 0.151, 0);
  group.add(brassBar);

  return group;
}

function buildStylizedMedkitGroup(): THREE.Group {
  const cache = getSharedProceduralLootCache();
  const group = new THREE.Group();
  group.name = 'loot_marker_medkit';

  const body = new THREE.Mesh(cache.medkitBodyGeo, cache.medkitBodyMat);
  body.position.y = 0.075;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const topH = new THREE.Mesh(cache.medkitTopCrossHGeo, cache.medkitCrossMat);
  topH.position.set(0, 0.154, 0);
  group.add(topH);

  const topV = new THREE.Mesh(cache.medkitTopCrossVGeo, cache.medkitCrossMat);
  topV.position.set(0, 0.154, 0);
  group.add(topV);

  const frontH = new THREE.Mesh(cache.medkitFrontCrossHGeo, cache.medkitCrossMat);
  frontH.position.set(0, 0.075, 0.092);
  group.add(frontH);

  const frontV = new THREE.Mesh(cache.medkitFrontCrossVGeo, cache.medkitCrossMat);
  frontV.position.set(0, 0.075, 0.092);
  group.add(frontV);

  return group;
}

// Zirh nimcha / kaska belgilari (umumiy geometriya va materiallar; dispose qilinmaydi)
const GEAR_VEST_GEO = new THREE.BoxGeometry(0.3, 0.09, 0.22);
const GEAR_HELMET_GEO = new THREE.SphereGeometry(0.12, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const GEAR_HELMET_BRIM_GEO = new THREE.CylinderGeometry(0.13, 0.13, 0.025, 14);
const GEAR_VEST_MAT = new THREE.MeshStandardMaterial({ color: '#3f5a3a', roughness: 0.85 });
const GEAR_STRAP_MAT = new THREE.MeshStandardMaterial({ color: '#1f2a1d', roughness: 0.9 });
const GEAR_HELMET_MAT = new THREE.MeshStandardMaterial({ color: '#4b5a3c', roughness: 0.6, metalness: 0.15 });
for (const g of [GEAR_VEST_GEO, GEAR_HELMET_GEO, GEAR_HELMET_BRIM_GEO]) g.userData.sharedAsset = true;
for (const m of [GEAR_VEST_MAT, GEAR_STRAP_MAT, GEAR_HELMET_MAT]) m.userData.sharedAsset = true;

// Signal raketasi belgisi: qizil tsilindr (patron) + oq uchlik qalpoq + "chiziq" (umumiy, dispose qilinmaydi)
const FLARE_BODY_GEO = new THREE.CylinderGeometry(0.03, 0.03, 0.22, 10);
const FLARE_CAP_GEO = new THREE.CylinderGeometry(0.032, 0.032, 0.035, 10);
const FLARE_BODY_MAT = new THREE.MeshStandardMaterial({ color: '#c8281e', roughness: 0.55, emissive: '#5a0d08', emissiveIntensity: 0.35 });
const FLARE_CAP_MAT = new THREE.MeshStandardMaterial({ color: '#e8e2d6', roughness: 0.6 });
for (const g of [FLARE_BODY_GEO, FLARE_CAP_GEO]) g.userData.sharedAsset = true;
for (const m of [FLARE_BODY_MAT, FLARE_CAP_MAT]) m.userData.sharedAsset = true;

function buildStylizedFlareGroup(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'loot_marker_flare';
  const body = new THREE.Mesh(FLARE_BODY_GEO, FLARE_BODY_MAT);
  // Yotgan patron (biroz qiya)
  body.rotation.z = Math.PI / 2;
  body.rotation.y = 0.5;
  body.position.y = 0.035;
  body.castShadow = true;
  group.add(body);
  const cap = new THREE.Mesh(FLARE_CAP_GEO, FLARE_CAP_MAT);
  cap.rotation.z = Math.PI / 2;
  cap.rotation.y = 0.5;
  cap.position.set(Math.cos(0.5) * 0.125, 0.035, -Math.sin(0.5) * 0.125);
  group.add(cap);
  return group;
}

function buildStylizedGearGroup(kind: 'armor' | 'helmet'): THREE.Group {
  const group = new THREE.Group();
  group.name = `loot_marker_${kind}`;
  if (kind === 'armor') {
    const body = new THREE.Mesh(GEAR_VEST_GEO, GEAR_VEST_MAT);
    body.position.y = 0.045;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const strap = new THREE.Mesh(GEAR_VEST_GEO, GEAR_STRAP_MAT);
    strap.scale.set(0.3, 1.1, 1.02);
    strap.position.y = 0.045;
    group.add(strap);
  } else {
    const dome = new THREE.Mesh(GEAR_HELMET_GEO, GEAR_HELMET_MAT);
    dome.position.y = 0.03;
    dome.castShadow = true;
    dome.receiveShadow = true;
    group.add(dome);
    const brim = new THREE.Mesh(GEAR_HELMET_BRIM_GEO, GEAR_STRAP_MAT);
    brim.position.y = 0.03;
    group.add(brim);
  }
  return group;
}

/**
 * Shader/tekstura oldindan isitish uchun har xil loot buyumidan bittadan: o'yin boshida bir necha kadr
 * ko'rinmas joyda chizilib, keyin o'yin o'rtasida birinchi konteyner ochilganda kompilyatsiya qotishi bo'lmaydi.
 */
export function createLootPrewarmGroup(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'loot_prewarm';
  let i = 0;
  const place = (o: THREE.Object3D) => {
    o.position.set((i++ % 6) * 1.5, 0, Math.floor(i / 6) * 1.5);
    g.add(o);
  };
  for (const w of WEAPON_SLOTS) {
    place(new WorldWeaponItem({ weapon: w, pose: 'flat', scale: WEAPON_INSIDE_CONTAINER_SCALE, highlighted: false }).root);
    place(buildStylizedAmmoGroup(w));
  }
  place(buildStylizedMedkitGroup());
  place(buildStylizedGrenadeGroup());
  place(buildStylizedGearGroup('armor'));
  place(buildStylizedGearGroup('helmet'));
  const cache = getSharedProceduralLootCache();
  place(new THREE.Mesh(cache.itemHighlightRingGeo, cache.itemHighlightRingMat));
  return g;
}

function buildStylizedGrenadeGroup(): THREE.Group {
  const cache = getSharedProceduralLootCache();
  const group = new THREE.Group();
  group.name = 'loot_marker_grenade';

  const body = new THREE.Mesh(cache.grenadeSphereGeo, cache.grenadeBodyMat);
  body.position.y = 0.07;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const neck = new THREE.Mesh(cache.grenadeNeckGeo, cache.grenadeCapMat);
  neck.position.y = 0.145;
  group.add(neck);

  const lever = new THREE.Mesh(cache.grenadeLeverGeo, cache.ammoBrassMat);
  lever.position.set(0.038, 0.115, 0);
  lever.rotation.z = -0.25;
  group.add(lever);

  const ring = new THREE.Mesh(cache.grenadeRingGeo, cache.ammoBrassMat);
  ring.position.set(-0.024, 0.152, 0);
  ring.rotation.y = Math.PI / 2;
  group.add(ring);

  return group;
}

function resolveAmmoWeapon(item: PublicLootItem): WeaponId {
  if (item.ammoWeapon) return item.ammoWeapon;
  if (item.catalogId === 'ammo:pistol') return 'pistol';
  if (item.catalogId === 'ammo:shotgun') return 'shotgun';
  if (item.catalogId === 'ammo:sniper') return 'sniper';
  return 'rifle';
}

function resolveWeaponId(item: PublicLootItem): WeaponId {
  if (item.weaponId) return item.weaponId;
  if (item.catalogId === 'weapon:pistol') return 'pistol';
  if (item.catalogId === 'weapon:shotgun') return 'shotgun';
  if (item.catalogId === 'weapon:sniper') return 'sniper';
  return 'rifle';
}

interface RenderedLootItemEntry {
  id: string;
  catalogId: PublicLootItem['catalogId'];
  kind: PublicLootItem['kind'];
  containerId: string | null;
  position: Vec3;
  yaw: number;
  root: THREE.Group;
  highlightRing: THREE.Mesh;
  weaponItem: WorldWeaponItem | null;
  highlighted: boolean;
  phase: number;
}

/**
 * Renders world and inside-container loot items and syncs container lid/door animations.
 * - Reuses `WorldWeaponItem` (3P cached GLBs) for weapons and shared procedural markers (`userData.sharedAsset = true`)
 *   for ammo, medkits, and grenades.
 * - Diff-updates item instances only when snapshots change (never recreating unchanged meshes).
 * - Distance-culls item meshes beyond 28m (`maxDrawDistSq = 784`) so distant POI loot adds 0 draw calls.
 */
export class LootWorldRenderer {
  private readonly scene: THREE.Scene;
  private readonly world: WorldDefinition;
  private containerHandles: ContainerVisualsSceneHandles | null;

  private readonly root = new THREE.Group();
  private readonly itemsGroup = new THREE.Group();
  private readonly containerHighlightRing: THREE.Mesh;

  private readonly itemEntries = new Map<string, RenderedLootItemEntry>();
  private readonly containerStates = new Map<string, PublicContainerState>();
  private readonly containerPositions = new Map<string, Vec3>();

  private lastVersion = -1;
  private openContainerIds: string[] = [];
  private highlightedContainerId: string | null = null;
  private highlightedItemId: string | null = null;

  private animTime = 0;
  private lastCameraPos: Vec3 | null = null;
  private disposed = false;

  constructor(
    scene: THREE.Scene,
    world: WorldDefinition,
    containerHandles: ContainerVisualsSceneHandles | null = null,
  ) {
    this.scene = scene;
    this.world = world;
    this.containerHandles = containerHandles;

    this.root.name = 'stage06_loot_world_renderer';
    this.itemsGroup.name = 'loot_world_items';
    this.root.add(this.itemsGroup);

    const cache = getSharedProceduralLootCache();
    this.containerHighlightRing = new THREE.Mesh(
      cache.containerHighlightRingGeo,
      cache.containerHighlightRingMat,
    );
    this.containerHighlightRing.name = 'loot_container_highlight_ring';
    this.containerHighlightRing.visible = false;
    this.root.add(this.containerHighlightRing);

    for (const cnt of this.world.containerLocations) {
      this.containerPositions.set(cnt.id, {
        x: cnt.position.x,
        y: cnt.position.y,
        z: cnt.position.z,
      });
    }

    this.scene.add(this.root);
  }

  setContainerHandles(handles: ContainerVisualsSceneHandles | null): void {
    this.containerHandles = handles;
    if (!this.containerHandles) return;

    for (const cnt of this.containerStates.values()) {
      this.containerHandles.setContainerOpenFraction(cnt.id, cnt.opened ? 1 : 0, true);
    }
  }

  applyLootSnapshot(snapshot: RoomLootSnapshot): void {
    if (this.disposed) return;

    this.lastVersion = snapshot.version;
    const nextOpenContainerIds: string[] = [];
    const desiredItems = new Map<string, PublicLootItem>();

    this.containerStates.clear();
    for (const cnt of snapshot.containers) {
      this.containerStates.set(cnt.id, cnt);
      this.containerPositions.set(cnt.id, {
        x: cnt.position.x,
        y: cnt.position.y,
        z: cnt.position.z,
      });

      this.containerHandles?.setContainerOpenFraction(cnt.id, cnt.opened ? 1 : 0, true);

      if (cnt.opened) {
        nextOpenContainerIds.push(cnt.id);
        for (const item of cnt.items) {
          desiredItems.set(item.id, item);
        }
      }
    }

    for (const item of snapshot.groundItems) {
      desiredItems.set(item.id, item);
    }

    this.openContainerIds = nextOpenContainerIds;

    // Remove items that were picked up or belong to closed containers
    for (const [existingId, existingEntry] of this.itemEntries.entries()) {
      const nextItem = desiredItems.get(existingId);
      if (!nextItem || nextItem.catalogId !== existingEntry.catalogId) {
        this.disposeItemEntry(existingEntry);
        this.itemEntries.delete(existingId);
      }
    }

    // Create new item entries or update transforms on existing ones
    for (const [id, item] of desiredItems.entries()) {
      let entry = this.itemEntries.get(id);
      if (!entry) {
        entry = this.createItemEntry(item);
        this.itemsGroup.add(entry.root);
        this.itemEntries.set(id, entry);
      }

      const liftedY = item.position.y + ITEM_Y_LIFT;
      entry.containerId = item.containerId;
      entry.position.x = item.position.x;
      entry.position.y = liftedY;
      entry.position.z = item.position.z;
      entry.yaw = item.yaw;

      entry.root.position.set(item.position.x, liftedY, item.position.z);
      entry.root.rotation.set(0, item.yaw, 0);
    }

    this.syncHighlights();
    if (this.lastCameraPos) {
      this.applyDistanceCulling(this.lastCameraPos);
    }
  }

  setHighlightedTarget(containerId: string | null, itemId: string | null = null): void {
    if (this.disposed) return;
    const nextContainerId = containerId ?? null;
    const nextItemId = itemId ?? null;
    if (
      this.highlightedContainerId === nextContainerId &&
      this.highlightedItemId === nextItemId
    ) {
      return;
    }
    this.highlightedContainerId = nextContainerId;
    this.highlightedItemId = nextItemId;
    this.syncHighlights();
  }

  update(dt: number, cameraPos: Vec3): void {
    if (this.disposed) return;
    const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.animTime += safeDt;
    if (this.lastCameraPos) {
      this.lastCameraPos.x = cameraPos.x;
      this.lastCameraPos.y = cameraPos.y;
      this.lastCameraPos.z = cameraPos.z;
    } else {
      this.lastCameraPos = { x: cameraPos.x, y: cameraPos.y, z: cameraPos.z };
    }

    this.containerHandles?.updateDampedAnimations(safeDt);

    for (const entry of this.itemEntries.values()) {
      const dx = entry.position.x - cameraPos.x;
      const dy = entry.position.y - cameraPos.y;
      const dz = entry.position.z - cameraPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const isVisible = distSq <= MAX_DRAW_DIST_SQ;

      entry.root.visible = isVisible;
      if (!isVisible) continue;

      if (entry.highlighted) {
        entry.highlightRing.visible = true;
        const pulse = 0.5 + 0.5 * Math.sin(this.animTime * 4.5 + entry.phase);
        entry.highlightRing.position.y = 0.008 + pulse * 0.012;
        const scale = 0.94 + pulse * 0.12;
        entry.highlightRing.scale.set(scale, scale, 1);
      } else {
        entry.highlightRing.visible = false;
      }
    }

    this.updateContainerHighlightRing(cameraPos);
  }

  getDiagnostics(): LootWorldRendererDiagnostics {
    let visibleCount = 0;
    const renderedItemIds: string[] = [];

    for (const entry of this.itemEntries.values()) {
      renderedItemIds.push(entry.id);
      if (entry.root.visible) {
        visibleCount++;
      }
    }

    return {
      version: this.lastVersion,
      activeItemMeshCount: this.itemEntries.size,
      visibleItemMeshCount: visibleCount,
      openContainerIds: [...this.openContainerIds],
      renderedItemIds,
      highlightedContainerId: this.highlightedContainerId,
      highlightedItemId: this.highlightedItemId,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const entry of this.itemEntries.values()) {
      this.disposeItemEntry(entry);
    }
    this.itemEntries.clear();
    this.containerStates.clear();
    this.containerPositions.clear();
    this.openContainerIds = [];

    if (this.root.parent) {
      this.root.parent.remove(this.root);
    }

    this.root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.geometry && !obj.geometry.userData?.sharedAsset) {
        obj.geometry.dispose();
      }
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m && !m.userData?.sharedAsset) {
          m.dispose();
        }
      }
    });

    this.itemsGroup.clear();
    this.root.clear();
  }

  private createItemEntry(item: PublicLootItem): RenderedLootItemEntry {
    const cache = getSharedProceduralLootCache();
    const root = new THREE.Group();
    root.name = `loot_item_${item.id}`;
    root.userData = {
      itemId: item.id,
      catalogId: item.catalogId,
      kind: item.kind,
      containerId: item.containerId,
    };

    let weaponItem: WorldWeaponItem | null = null;

    if (item.kind === 'weapon') {
      const weaponId = resolveWeaponId(item);
      weaponItem = new WorldWeaponItem({
        weapon: weaponId,
        pose: 'flat',
        scale: WEAPON_INSIDE_CONTAINER_SCALE,
        highlighted: false,
      });
      root.add(weaponItem.root);
    } else if (item.kind === 'ammo') {
      const ammoWeapon = resolveAmmoWeapon(item);
      root.add(buildStylizedAmmoGroup(ammoWeapon));
    } else if (item.kind === 'medkit') {
      root.add(buildStylizedMedkitGroup());
    } else if (item.kind === 'armor' || item.kind === 'helmet') {
      root.add(buildStylizedGearGroup(item.kind));
    } else if (item.kind === 'flare') {
      root.add(buildStylizedFlareGroup());
    } else {
      root.add(buildStylizedGrenadeGroup());
    }

    const highlightRing = new THREE.Mesh(
      cache.itemHighlightRingGeo,
      cache.itemHighlightRingMat,
    );
    highlightRing.name = `loot_item_highlight_${item.id}`;
    highlightRing.position.y = 0.008;
    highlightRing.visible = false;
    root.add(highlightRing);

    let hash = 0;
    for (let i = 0; i < item.id.length; i++) {
      hash = (hash * 31 + item.id.charCodeAt(i)) | 0;
    }
    const phase = ((hash >>> 0) % 628) / 100;

    return {
      id: item.id,
      catalogId: item.catalogId,
      kind: item.kind,
      containerId: item.containerId,
      position: {
        x: item.position.x,
        y: item.position.y + ITEM_Y_LIFT,
        z: item.position.z,
      },
      yaw: item.yaw,
      root,
      highlightRing,
      weaponItem,
      highlighted: false,
      phase,
    };
  }

  private disposeItemEntry(entry: RenderedLootItemEntry): void {
    entry.weaponItem?.dispose();
    if (entry.root.parent) {
      entry.root.parent.remove(entry.root);
    }
    entry.root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.geometry && !obj.geometry.userData?.sharedAsset) {
        obj.geometry.dispose();
      }
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m && !m.userData?.sharedAsset) {
          m.dispose();
        }
      }
    });
    entry.root.clear();
  }

  private syncHighlights(): void {
    for (const entry of this.itemEntries.values()) {
      const isDirectItemMatch =
        this.highlightedItemId !== null && entry.id === this.highlightedItemId;
      const isContainerMatch =
        this.highlightedItemId === null &&
        this.highlightedContainerId !== null &&
        entry.containerId === this.highlightedContainerId;

      const highlighted = isDirectItemMatch || isContainerMatch;
      entry.highlighted = highlighted;
      entry.highlightRing.visible = highlighted && entry.root.visible;
      if (!highlighted) {
        entry.highlightRing.position.y = 0.008;
        entry.highlightRing.scale.setScalar(1);
      }
    }

    this.updateContainerHighlightRing(this.lastCameraPos);
  }

  private applyDistanceCulling(cameraPos: Vec3): void {
    for (const entry of this.itemEntries.values()) {
      const dx = entry.position.x - cameraPos.x;
      const dy = entry.position.y - cameraPos.y;
      const dz = entry.position.z - cameraPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const isVisible = distSq <= MAX_DRAW_DIST_SQ;
      entry.root.visible = isVisible;
      entry.highlightRing.visible = isVisible && entry.highlighted;
    }
    this.updateContainerHighlightRing(cameraPos);
  }

  private updateContainerHighlightRing(cameraPos: Vec3 | null): void {
    if (!this.highlightedContainerId) {
      this.containerHighlightRing.visible = false;
      return;
    }

    const pos = this.containerPositions.get(this.highlightedContainerId);
    if (!pos) {
      this.containerHighlightRing.visible = false;
      return;
    }

    if (cameraPos) {
      const dx = pos.x - cameraPos.x;
      const dy = pos.y - cameraPos.y;
      const dz = pos.z - cameraPos.z;
      if (dx * dx + dy * dy + dz * dz > MAX_DRAW_DIST_SQ) {
        this.containerHighlightRing.visible = false;
        return;
      }
    }

    const pulse = 0.5 + 0.5 * Math.sin(this.animTime * 4.0);
    this.containerHighlightRing.visible = true;
    this.containerHighlightRing.position.set(pos.x, pos.y + 0.02 + pulse * 0.01, pos.z);
    const ringScale = 0.96 + pulse * 0.08;
    this.containerHighlightRing.scale.set(ringScale, ringScale, 1);
  }
}
