import { q3, type Vec3 } from '../../shared/math';
import type { ContainerAssetId, WorldItemAnchor } from '../../shared/structures/contracts';
import { WEAPONS, WEAPON_SLOTS, type WeaponId } from '../../shared/weapons';
import { createSeededRng, type ContainerKind, type WorldDefinition } from '../../shared/world';
import {
  CONTAINER_KIND_LABELS_UZ,
  getAmmoCatalogId,
  getWeaponCatalogId,
  LOOT_CATALOG,
  type ContainerStatus,
  type LootCatalogId,
  type PublicLootItem,
} from '../../shared/loot';

export interface ServerContainerRecord {
  id: string;
  locationId: string;
  assetId: ContainerAssetId;
  kind: ContainerKind;
  labelUz: string;
  position: Vec3;
  yaw: number;
  interactionRadius: number;
  status: ContainerStatus;
  opened: boolean;
  openFraction: number;
  version: number;
  items: Map<string, PublicLootItem>;
  takenItemIds: Set<string>;
  anchors: WorldItemAnchor[];
}

interface NormalizedContainerPlacement {
  id: string;
  locationId: string;
  assetId: ContainerAssetId;
  kind: ContainerKind;
  position: Vec3;
  rotationY: number;
  interactionRadius: number;
}

const KIND_TO_ASSET_ID: Record<ContainerKind, ContainerAssetId> = {
  supply_crate: 'wooden_loot_crate_01',
  weapon_locker: 'metal_locker_01',
  ammo_box: 'old_toolbox_01',
  camp_chest: 'wooden_loot_crate_01',
};

function cloneAnchor(a: WorldItemAnchor): WorldItemAnchor {
  return {
    id: a.id,
    name: a.name,
    sourceInstanceId: a.sourceInstanceId,
    assetId: a.assetId,
    category: a.category,
    localPosition: [a.localPosition[0], a.localPosition[1], a.localPosition[2]],
    worldPosition: { x: a.worldPosition.x, y: a.worldPosition.y, z: a.worldPosition.z },
    up: [a.up[0], a.up[1], a.up[2]],
    requiresOpenDoorOrLid: a.requiresOpenDoorOrLid,
  };
}

function synthesizeContainerAnchors(cnt: NormalizedContainerPlacement): WorldItemAnchor[] {
  return [
    {
      id: `${cnt.id}:anchor:synth_0`,
      name: 'synth_slot_0',
      sourceInstanceId: cnt.id,
      assetId: cnt.assetId,
      category: 'inside_container',
      localPosition: [-0.15, 0.25, 0],
      worldPosition: {
        x: q3(cnt.position.x - 0.15),
        y: q3(cnt.position.y + 0.25),
        z: q3(cnt.position.z),
      },
      up: [0, 1, 0],
      requiresOpenDoorOrLid: true,
    },
    {
      id: `${cnt.id}:anchor:synth_1`,
      name: 'synth_slot_1',
      sourceInstanceId: cnt.id,
      assetId: cnt.assetId,
      category: 'inside_container',
      localPosition: [0.15, 0.25, 0],
      worldPosition: {
        x: q3(cnt.position.x + 0.15),
        y: q3(cnt.position.y + 0.25),
        z: q3(cnt.position.z),
      },
      up: [0, 1, 0],
      requiresOpenDoorOrLid: true,
    },
  ];
}

function buildPublicLootItem(
  id: string,
  catalogId: LootCatalogId,
  cnt: NormalizedContainerPlacement,
  anchor: WorldItemAnchor,
): PublicLootItem {
  const entry = LOOT_CATALOG[catalogId];
  const item: PublicLootItem = {
    id,
    catalogId,
    kind: entry.kind,
    nameUz: entry.nameUz,
    quantity: entry.defaultQuantity,
    containerId: cnt.id,
    anchorId: anchor.id,
    position: {
      x: anchor.worldPosition.x,
      y: anchor.worldPosition.y,
      z: anchor.worldPosition.z,
    },
    yaw: cnt.rotationY,
  };

  if (entry.kind === 'weapon' && entry.weaponId) {
    const wDef = WEAPONS[entry.weaponId];
    item.weaponId = entry.weaponId;
    item.initialMag = wDef.magSize;
    item.initialReserve = wDef.magSize;
  } else if (entry.kind === 'ammo' && entry.ammoWeapon) {
    item.ammoWeapon = entry.ammoWeapon;
    item.quantity = entry.defaultQuantity;
  }

  return item;
}

/**
 * Deterministically generates server-authoritative containers and interior loot items
 * from `secretLootSeed` without mutating the frozen `WorldDefinition`.
 */
export function generateRoomContainersAndLoot(
  world: WorldDefinition,
  secretLootSeed: number,
  roomId: string,
  roundId = 1,
): Map<string, ServerContainerRecord> {
  const rng = createSeededRng(secretLootSeed);

  const stageContainers = world.stage04aLayout?.containers;
  const placements: NormalizedContainerPlacement[] =
    stageContainers && stageContainers.length > 0
      ? stageContainers.map((c) => ({
          id: c.id,
          locationId: c.locationId,
          assetId: c.assetId,
          kind: c.containerKind,
          position: { x: c.position.x, y: c.position.y, z: c.position.z },
          rotationY: c.rotationY,
          interactionRadius: c.interactionRadius,
        }))
      : world.containerLocations.map((c) => ({
          id: c.id,
          locationId: c.locationId,
          assetId: KIND_TO_ASSET_ID[c.kind],
          kind: c.kind,
          position: { x: c.position.x, y: c.position.y, z: c.position.z },
          rotationY: c.yaw,
          interactionRadius: c.interactionRadius,
        }));

  const worldAnchors = world.stage04aLayout?.worldAnchors ?? [];

  // Deterministically shuffle all 4 weapons using secretLootSeed
  const weaponOrder: WeaponId[] = [...WEAPON_SLOTS];
  for (let i = weaponOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = weaponOrder[i]!;
    weaponOrder[i] = weaponOrder[j]!;
    weaponOrder[j] = tmp;
  }

  // Group container indices by POI locationId to ensure balanced POI loot kits
  const poiGroups = new Map<string, number[]>();
  const containerPoiLocalIdx: number[] = [];
  const containerPoiGroupIdx: number[] = [];

  for (let idx = 0; idx < placements.length; idx++) {
    const locId = placements[idx]!.locationId;
    let group = poiGroups.get(locId);
    if (!group) {
      group = [];
      poiGroups.set(locId, group);
    }
    containerPoiLocalIdx.push(group.length);
    group.push(idx);
  }

  const poiOrder = [...poiGroups.keys()];
  for (let idx = 0; idx < placements.length; idx++) {
    const locId = placements[idx]!.locationId;
    containerPoiGroupIdx.push(poiOrder.indexOf(locId));
  }

  const result = new Map<string, ServerContainerRecord>();

  for (let cntIdx = 0; cntIdx < placements.length; cntIdx++) {
    const cnt = placements[cntIdx]!;
    const matchingAnchors = worldAnchors
      .filter((a) => a.sourceInstanceId === cnt.id && a.category === 'inside_container')
      .map(cloneAnchor);

    const anchors: WorldItemAnchor[] =
      matchingAnchors.length >= 2 ? matchingAnchors : synthesizeContainerAnchors(cnt);

    const poiLocalIdx = containerPoiLocalIdx[cntIdx]!;
    const poiGroupIdx = containerPoiGroupIdx[cntIdx]!;

    // Determine how many items to place in cnt (at least 2 items per container)
    let targetItemCount = Math.min(anchors.length, 2 + Math.floor(rng() * 2));
    if (poiLocalIdx === 0 && anchors.length >= 3) {
      // Ensure the primary container of each POI holds a 3-item complete starter kit (weapon + matching ammo + medkit/grenade)
      targetItemCount = Math.min(anchors.length, 3);
    }

    const slotCatalogIds: LootCatalogId[] = [];

    if (cntIdx < 4) {
      // Guarantee all 4 weapons appear across the first 4 containers
      const w = weaponOrder[cntIdx]!;
      slotCatalogIds.push(getWeaponCatalogId(w));
      slotCatalogIds.push(getAmmoCatalogId(w));
      if (targetItemCount >= 3) {
        slotCatalogIds.push(cntIdx % 2 === 0 ? 'heal:medkit' : 'throwable:grenade');
      }
    } else if (poiLocalIdx === 0) {
      // First container of every subsequent POI guarantees a weapon + matching ammo + medkit/grenade
      const w = weaponOrder[poiGroupIdx % weaponOrder.length]!;
      slotCatalogIds.push(getWeaponCatalogId(w));
      slotCatalogIds.push(getAmmoCatalogId(w));
      if (targetItemCount >= 3) {
        slotCatalogIds.push(rng() < 0.6 ? 'heal:medkit' : 'throwable:grenade');
      }
    } else if (poiLocalIdx === 1) {
      // Second container in each POI ensures both medkit and grenade availability in the POI,
      // plus a guaranteed piece of gear (vest / helmet alternating per POI) when there is room
      const medkitFirst = rng() < 0.5;
      slotCatalogIds.push(medkitFirst ? 'heal:medkit' : 'throwable:grenade');
      slotCatalogIds.push(medkitFirst ? 'throwable:grenade' : 'heal:medkit');
      const gearId: LootCatalogId = poiGroupIdx % 2 === 0 ? 'gear:vest' : 'gear:helmet';
      if (anchors.length >= 3) {
        targetItemCount = Math.max(targetItemCount, 3);
        slotCatalogIds.push(gearId);
      } else {
        // Joy kam (2 anchor): jihoz ikkinchi iste'mol buyumi o'rnini oladi — birinchi konteyner
        // allaqachon aptechka/granata beradi, shuning uchun POI kiti to'liq qoladi
        slotCatalogIds[1] = gearId;
      }
    } else {
      // Remaining containers in the POI
      const rollWeapon =
        cnt.kind === 'weapon_locker' || (cnt.kind !== 'ammo_box' && rng() < 0.5);
      if (rollWeapon) {
        const w = weaponOrder[(cntIdx + Math.floor(rng() * weaponOrder.length)) % weaponOrder.length]!;
        slotCatalogIds.push(getWeaponCatalogId(w));
        slotCatalogIds.push(getAmmoCatalogId(w));
        if (targetItemCount >= 3) {
          slotCatalogIds.push(rng() < 0.5 ? 'heal:medkit' : 'throwable:grenade');
        }
      } else if (cnt.kind === 'ammo_box') {
        const w1 = weaponOrder[Math.floor(rng() * weaponOrder.length)]!;
        slotCatalogIds.push(getAmmoCatalogId(w1));
        slotCatalogIds.push(rng() < 0.5 ? 'heal:medkit' : 'throwable:grenade');
        if (targetItemCount >= 3) {
          const w2 = weaponOrder[(WEAPON_SLOTS.indexOf(w1) + 1) % weaponOrder.length]!;
          slotCatalogIds.push(getAmmoCatalogId(w2));
        }
      } else {
        const w = weaponOrder[Math.floor(rng() * weaponOrder.length)]!;
        slotCatalogIds.push(getAmmoCatalogId(w));
        slotCatalogIds.push(rng() < 0.5 ? 'heal:medkit' : 'throwable:grenade');
        if (targetItemCount >= 3) {
          // Uchinchi slot: granata/aptechka yoki (30%) zirh/kaska
          const gearRoll = rng();
          slotCatalogIds.push(
            gearRoll < 0.15 ? 'gear:vest' : gearRoll < 0.3 ? 'gear:helmet' : rng() < 0.5 ? 'throwable:grenade' : 'heal:medkit',
          );
        }
      }
    }

    // Enforce invariant: whenever slot 0 is a weapon, slot 1 is its matching ammo
    const firstCatalog = slotCatalogIds[0];
    if (firstCatalog && LOOT_CATALOG[firstCatalog].kind === 'weapon') {
      const weaponId = LOOT_CATALOG[firstCatalog].weaponId!;
      slotCatalogIds[1] = getAmmoCatalogId(weaponId);
    }

    const items = new Map<string, PublicLootItem>();
    const count = Math.min(anchors.length, slotCatalogIds.length);
    for (let slotIdx = 0; slotIdx < count; slotIdx++) {
      const catalogId = slotCatalogIds[slotIdx]!;
      const anchor = anchors[slotIdx]!;
      const itemId = `itm:${roomId}:r${roundId}:c${cntIdx}:${slotIdx}`;
      const item = buildPublicLootItem(itemId, catalogId, cnt, anchor);
      items.set(itemId, item);
    }

    const record: ServerContainerRecord = {
      id: cnt.id,
      locationId: cnt.locationId,
      assetId: cnt.assetId,
      kind: cnt.kind,
      labelUz: CONTAINER_KIND_LABELS_UZ[cnt.kind],
      position: { x: cnt.position.x, y: cnt.position.y, z: cnt.position.z },
      yaw: cnt.rotationY,
      interactionRadius: cnt.interactionRadius,
      status: 'closed',
      opened: false,
      openFraction: 0,
      version: 1,
      items,
      takenItemIds: new Set<string>(),
      anchors,
    };

    result.set(cnt.id, record);
  }

  return result;
}
