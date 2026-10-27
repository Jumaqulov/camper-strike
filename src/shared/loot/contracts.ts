import type { Vec3 } from '../math';
import type { ContainerAssetId } from '../structures/contracts';
import type { AmmoState, WeaponId } from '../weapons';
import type { ContainerKind } from '../world';

export type LootItemKind = 'weapon' | 'ammo' | 'medkit' | 'grenade' | 'armor' | 'helmet';

export type AmmoType = 'rifle_ammo' | 'pistol_ammo' | 'shotgun_ammo' | 'sniper_ammo';

export type LootCatalogId =
  | 'weapon:rifle'
  | 'weapon:pistol'
  | 'weapon:shotgun'
  | 'weapon:sniper'
  | 'ammo:rifle'
  | 'ammo:pistol'
  | 'ammo:shotgun'
  | 'ammo:sniper'
  | 'heal:medkit'
  | 'throwable:grenade'
  | 'gear:vest'
  | 'gear:helmet';

export interface LootCatalogEntry {
  catalogId: LootCatalogId;
  kind: LootItemKind;
  nameUz: string;
  shortNameUz: string;
  descriptionUz: string;
  weaponId?: WeaponId;
  ammoWeapon?: WeaponId;
  defaultQuantity: number;
  maxStack: number;
  healAmount?: number;
  spawnWeight: number;
  /** True if this item uses an existing GLB weapon model; false if it uses a stylized procedural marker. */
  hasGlbAsset: boolean;
}

export interface PublicLootItem {
  id: string;
  catalogId: LootCatalogId;
  kind: LootItemKind;
  nameUz: string;
  weaponId?: WeaponId;
  ammoWeapon?: WeaponId;
  quantity: number;
  initialMag?: number;
  initialReserve?: number;
  containerId: string | null;
  anchorId?: string;
  position: Vec3;
  yaw: number;
}

export type ContainerStatus = 'closed' | 'opened' | 'empty';

export interface PublicContainerState {
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
  /** Number of items remaining inside (only revealed when opened === true; -1 when closed). */
  itemCount: number;
  /** Items inside the container. ALWAYS empty `[]` when `opened === false`! */
  items: PublicLootItem[];
}

export interface RoomLootSnapshot {
  roomId: string;
  roundId: number;
  version: number;
  lootEnabled: boolean;
  lootPreview: boolean;
  containers: PublicContainerState[];
  groundItems: PublicLootItem[];
}

export interface InventoryEntrySnap {
  slotIndex: number;
  catalogId: LootCatalogId;
  kind: LootItemKind;
  nameUz: string;
  weaponId?: WeaponId;
  quantity: number;
}

export interface PlayerInventorySnap {
  playerId: string;
  roundId: number;
  spawnId: number;
  inventoryVersion: number;
  lootEnabled: boolean;
  lootPreview: boolean;
  equippedWeapon: WeaponId | null;
  ownedWeapons: WeaponId[];
  ammo: AmmoState;
  grenades: number;
  medkits: number;
  /** Zirh nimcha mustahkamligi 0..ARMOR_MAX (0 = yo'q). */
  armor: number;
  /** Kaska mustahkamligi 0..HELMET_MAX (0 = yo'q). */
  helmet: number;
  maxWeaponSlots: number;
  maxMedkits: number;
  maxGrenades: number;
  items: InventoryEntrySnap[];
}

export type LootErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_IN_LOOT_MODE'
  | 'ROUND_NOT_ACTIVE'
  | 'PLAYER_DEAD'
  | 'PLAYER_NOT_FOUND'
  | 'CONTAINER_NOT_FOUND'
  | 'CONTAINER_CLOSED'
  | 'OUT_OF_RANGE'
  | 'LOS_BLOCKED'
  | 'ITEM_NOT_FOUND'
  | 'ITEM_ALREADY_TAKEN'
  | 'INVENTORY_FULL'
  | 'WEAPON_ALREADY_OWNED'
  | 'AMMO_FULL'
  | 'MEDKITS_FULL'
  | 'GRENADES_FULL'
  | 'ARMOR_FULL'
  | 'HELMET_FULL'
  | 'WEAPON_NOT_OWNED'
  | 'NO_MEDKITS'
  | 'HP_ALREADY_FULL'
  | 'RATE_LIMITED';

export type LootContextValidationReason =
  | 'MISSING_CONTEXT'
  | 'INVALID_CONTEXT'
  | 'ROUND_MISMATCH'
  | 'SPAWN_MISMATCH';

export interface LootContextValidationResult {
  ok: boolean;
  roundId?: number;
  spawnId?: number;
  reason?: LootContextValidationReason;
}

export interface LootRequestContext {
  /** Mandatory positive integer in survival/loot-enabled modes; validated against the room's active roundId. */
  roundId?: number;
  /** Mandatory positive integer in survival/loot-enabled modes; validated against the player's active spawnId. */
  spawnId?: number;
}

export interface ContainerOpenReq extends LootRequestContext {
  requestId: string;
  containerId: string;
  /** Mandatory in survival/loot-enabled modes; must match active room roundId. */
  roundId?: number;
  /** Mandatory in survival/loot-enabled modes; must match player's current spawnId. */
  spawnId?: number;
}

export interface ContainerOpenAck {
  ok: boolean;
  requestId: string;
  containerId: string;
  roundId?: number;
  spawnId?: number;
  idempotentReplay?: boolean;
  code?: LootErrorCode;
  message?: string;
  container?: PublicContainerState;
  inventory?: PlayerInventorySnap;
  lootVersion?: number;
}

export interface LootPickupReq extends LootRequestContext {
  requestId: string;
  containerId?: string | null;
  itemId: string;
  /** Mandatory in survival/loot-enabled modes; must match active room roundId. */
  roundId?: number;
  /** Mandatory in survival/loot-enabled modes; must match player's current spawnId. */
  spawnId?: number;
}

export interface LootPickupAck {
  ok: boolean;
  requestId: string;
  itemId: string;
  containerId?: string | null;
  roundId?: number;
  spawnId?: number;
  idempotentReplay?: boolean;
  code?: LootErrorCode;
  message?: string;
  pickedItem?: PublicLootItem;
  container?: PublicContainerState;
  inventory?: PlayerInventorySnap;
  lootVersion?: number;
}

export interface EquipWeaponReq extends LootRequestContext {
  requestId: string;
  weapon: WeaponId | null;
  /** Mandatory in survival/loot-enabled modes; must match active room roundId. */
  roundId?: number;
  /** Mandatory in survival/loot-enabled modes; must match player's current spawnId. */
  spawnId?: number;
}

export interface EquipWeaponAck {
  ok: boolean;
  requestId: string;
  equippedWeapon: WeaponId | null;
  roundId?: number;
  spawnId?: number;
  idempotentReplay?: boolean;
  code?: LootErrorCode;
  message?: string;
  inventory?: PlayerInventorySnap;
}

export interface UseMedkitReq extends LootRequestContext {
  requestId: string;
  /** Mandatory in survival/loot-enabled modes; must match active room roundId. */
  roundId?: number;
  /** Mandatory in survival/loot-enabled modes; must match player's current spawnId. */
  spawnId?: number;
}

export interface UseMedkitAck {
  ok: boolean;
  requestId: string;
  hp?: number;
  roundId?: number;
  spawnId?: number;
  idempotentReplay?: boolean;
  code?: LootErrorCode;
  message?: string;
  inventory?: PlayerInventorySnap;
}
