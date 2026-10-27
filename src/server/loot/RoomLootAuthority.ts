import { GRENADES_PER_LIFE, MAX_HP } from '../../shared/constants';
import type { Vec3 } from '../../shared/math';
import { fullAmmo, WEAPONS, WEAPON_SLOTS, type AmmoState, type WeaponId } from '../../shared/weapons';
import type { WorldDefinition } from '../../shared/world';
import {
  ARMOR_MAX,
  DEFAULT_CONTAINER_EXTRA_MARGIN_M,
  getWeaponCatalogId,
  HELMET_MAX,
  GROUND_ITEM_PICKUP_RADIUS_M,
  hasLineOfSightToContainer,
  isWithinInteractionDistance,
  LOOT_CATALOG,
  LOOT_ERROR_MESSAGES_UZ,
  MAX_AMMO_RESERVE,
  MAX_GRENADES_LOOT_MODE,
  MAX_MEDKITS_PER_PLAYER,
  MAX_WEAPON_SLOTS,
  MEDKIT_HEAL_AMOUNT,
  sanitizeContainerOpenReq,
  sanitizeEquipWeaponReq,
  sanitizeLootPickupReq,
  sanitizeUseMedkitReq,
  type ContainerOpenAck,
  type EquipWeaponAck,
  type InventoryEntrySnap,
  type LootErrorCode,
  type LootPickupAck,
  type PlayerInventorySnap,
  type PublicContainerState,
  type PublicLootItem,
  type RoomLootSnapshot,
  type UseMedkitAck,
} from '../../shared/loot';
import { eyeHeightOf } from '../../shared/stance';
import { generateRoomContainersAndLoot, type ServerContainerRecord } from './lootGenerator';

export interface ServerPlayerInventory {
  playerId: string;
  spawnId: number;
  inventoryVersion: number;
  equippedWeapon: WeaponId | null;
  ownedWeapons: Set<WeaponId>;
  ammo: AmmoState;
  grenades: number;
  medkits: number;
  armor: number;
  helmet: number;
}

export interface LootAuthorityStats {
  containersOpened: number;
  itemsPickedUp: number;
  rejectedNotInLootMode: number;
  rejectedStaleRoundOrSpawn: number;
  rejectedOpenDistance: number;
  rejectedOpenLos: number;
  rejectedOpenDead: number;
  rejectedPickupClosed: number;
  rejectedPickupTaken: number;
  rejectedPickupDistance: number;
  rejectedPickupLos: number;
  rejectedEquipUnowned: number;
  idempotentReplays: number;
  roundResets: number;
}

function emptyAmmo(): AmmoState {
  return {
    rifle: { mag: 0, reserve: 0 },
    pistol: { mag: 0, reserve: 0 },
    shotgun: { mag: 0, reserve: 0 },
    sniper: { mag: 0, reserve: 0 },
    knife: { mag: 0, reserve: 0 },
  };
}

function cloneAmmo(ammo: AmmoState): AmmoState {
  return {
    rifle: { mag: ammo.rifle.mag, reserve: ammo.rifle.reserve },
    pistol: { mag: ammo.pistol.mag, reserve: ammo.pistol.reserve },
    shotgun: { mag: ammo.shotgun.mag, reserve: ammo.shotgun.reserve },
    sniper: { mag: ammo.sniper.mag, reserve: ammo.sniper.reserve },
    knife: { mag: 0, reserve: 0 },
  };
}

function clonePublicLootItem(item: PublicLootItem): PublicLootItem {
  const copy: PublicLootItem = {
    id: item.id,
    catalogId: item.catalogId,
    kind: item.kind,
    nameUz: item.nameUz,
    quantity: item.quantity,
    containerId: item.containerId,
    position: { x: item.position.x, y: item.position.y, z: item.position.z },
    yaw: item.yaw,
  };
  if (item.weaponId !== undefined) copy.weaponId = item.weaponId;
  if (item.ammoWeapon !== undefined) copy.ammoWeapon = item.ammoWeapon;
  if (item.initialMag !== undefined) copy.initialMag = item.initialMag;
  if (item.initialReserve !== undefined) copy.initialReserve = item.initialReserve;
  if (item.anchorId !== undefined) copy.anchorId = item.anchorId;
  return copy;
}

const MAX_IDEMPOTENCY_CACHE_ENTRIES = 512;
const MAX_GROUND_ITEMS = 32;

export class RoomLootAuthority {
  private readonly containers: Map<string, ServerContainerRecord>;
  private readonly groundItems = new Map<string, PublicLootItem>();
  private readonly inventories = new Map<string, ServerPlayerInventory>();
  private readonly openIdempotency = new Map<string, ContainerOpenAck>();
  private readonly pickupIdempotency = new Map<string, LootPickupAck>();
  private readonly equipIdempotency = new Map<string, EquipWeaponAck>();
  private readonly medkitIdempotency = new Map<string, { ack: UseMedkitAck; newHp: number }>();
  private roundId: number;
  private nextInventoryVersion = 0;
  private dropSeq = 0;
  private version = 1;

  readonly stats: LootAuthorityStats = {
    containersOpened: 0,
    itemsPickedUp: 0,
    rejectedNotInLootMode: 0,
    rejectedStaleRoundOrSpawn: 0,
    rejectedOpenDistance: 0,
    rejectedOpenLos: 0,
    rejectedOpenDead: 0,
    rejectedPickupClosed: 0,
    rejectedPickupTaken: 0,
    rejectedPickupDistance: 0,
    rejectedPickupLos: 0,
    rejectedEquipUnowned: 0,
    idempotentReplays: 0,
    roundResets: 0,
  };

  constructor(
    readonly world: WorldDefinition,
    private secretLootSeed: number,
    readonly roomId: string,
    readonly lootEnabled: boolean,
    initialRoundId = 1,
  ) {
    this.roundId = initialRoundId;
    this.containers = generateRoomContainersAndLoot(
      this.world,
      this.secretLootSeed,
      this.roomId,
      this.roundId,
    );
  }

  get lootPreview(): boolean {
    return this.lootEnabled;
  }

  getRoundId(): number {
    return this.roundId;
  }

  getSecretLootSeed(): number {
    return this.secretLootSeed;
  }

  getVersion(): number {
    return this.version;
  }

  getStats(): LootAuthorityStats {
    return { ...this.stats };
  }

  private invalidatePlayerIdempotency(playerId: string): void {
    const prefix = `${playerId}:`;
    for (const key of this.openIdempotency.keys()) {
      if (key.startsWith(prefix)) this.openIdempotency.delete(key);
    }
    for (const key of this.pickupIdempotency.keys()) {
      if (key.startsWith(prefix)) this.pickupIdempotency.delete(key);
    }
    for (const key of this.equipIdempotency.keys()) {
      if (key.startsWith(prefix)) this.equipIdempotency.delete(key);
    }
    for (const key of this.medkitIdempotency.keys()) {
      if (key.startsWith(prefix)) this.medkitIdempotency.delete(key);
    }
  }

  private hasInvalidOrStaleContext(
    rawReq: unknown,
    currentSpawnId: number,
    requireContext: boolean = this.lootEnabled,
  ): boolean {
    if (!rawReq || typeof rawReq !== 'object') return true;
    const o = rawReq as Record<string, unknown>;
    const isPosInt = (v: unknown): v is number =>
      typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 0x7fffffff;
    const hasRound = o.roundId !== undefined && o.roundId !== null;
    const hasSpawn = o.spawnId !== undefined && o.spawnId !== null;

    if (requireContext) {
      if (!hasRound || !hasSpawn) return true;
      if (!isPosInt(o.roundId) || !isPosInt(o.spawnId)) return true;
      if (o.roundId !== this.roundId || o.spawnId !== currentSpawnId) return true;
      return false;
    }

    if (o.roundId === null || o.spawnId === null) return true;
    if (hasRound && (!isPosInt(o.roundId) || o.roundId !== this.roundId)) return true;
    if (hasSpawn && (!isPosInt(o.spawnId) || o.spawnId !== currentSpawnId)) return true;
    return false;
  }

  resetForRound(newRoundId: number, newSecretLootSeed: number): RoomLootSnapshot {
    this.roundId = newRoundId;
    this.secretLootSeed = newSecretLootSeed;
    this.openIdempotency.clear();
    this.pickupIdempotency.clear();
    this.equipIdempotency.clear();
    this.medkitIdempotency.clear();
    this.groundItems.clear();

    const freshContainers = generateRoomContainersAndLoot(
      this.world,
      this.secretLootSeed,
      this.roomId,
      this.roundId,
    );
    this.containers.clear();
    for (const [id, record] of freshContainers) {
      this.containers.set(id, record);
    }

    this.version++;
    this.stats.roundResets++;

    for (const [pid, inv] of this.inventories) {
      this.resetPlayerForSpawn(pid, inv.spawnId);
    }

    return this.getPublicLootSnapshot();
  }

  initPlayer(playerId: string, spawnId: number): PlayerInventorySnap {
    return this.resetPlayerForSpawn(playerId, spawnId);
  }

  resetPlayerForSpawn(playerId: string, spawnId: number): PlayerInventorySnap {
    this.invalidatePlayerIdempotency(playerId);
    const nextVersion = ++this.nextInventoryVersion;

    if (this.lootEnabled) {
      const inv: ServerPlayerInventory = {
        playerId,
        spawnId,
        inventoryVersion: nextVersion,
        equippedWeapon: null,
        ownedWeapons: new Set<WeaponId>(),
        ammo: emptyAmmo(),
        grenades: 0,
        medkits: 0,
        armor: 0,
        helmet: 0,
      };
      this.inventories.set(playerId, inv);
    } else {
      const inv: ServerPlayerInventory = {
        playerId,
        spawnId,
        inventoryVersion: nextVersion,
        equippedWeapon: 'rifle',
        ownedWeapons: new Set<WeaponId>(WEAPON_SLOTS),
        ammo: fullAmmo(),
        grenades: GRENADES_PER_LIFE,
        medkits: 0,
        armor: 0,
        helmet: 0,
      };
      this.inventories.set(playerId, inv);
    }

    return this.getPlayerInventorySnap(playerId)!;
  }

  syncPlayerFromServerPlayer(
    playerId: string,
    p: { spawnId: number; weapon: WeaponId | null; ammo: AmmoState; grenades: number; armor?: number; helmet?: number },
  ): void {
    let inv = this.inventories.get(playerId);
    if (!inv) {
      this.initPlayer(playerId, p.spawnId);
      inv = this.inventories.get(playerId)!;
    }
    if (inv.spawnId !== p.spawnId) {
      this.invalidatePlayerIdempotency(playerId);
    }
    inv.spawnId = p.spawnId;
    if (p.weapon === null) {
      if (this.lootEnabled || inv.ownedWeapons.size === 0) {
        inv.equippedWeapon = null;
      }
    } else if (p.weapon === 'knife' || inv.ownedWeapons.has(p.weapon)) {
      inv.equippedWeapon = p.weapon;
    }
    inv.ammo = cloneAmmo(p.ammo);
    inv.grenades = p.grenades;
    if (p.armor !== undefined) inv.armor = Math.max(0, p.armor);
    if (p.helmet !== undefined) inv.helmet = Math.max(0, p.helmet);
  }

  applyInventoryToServerPlayer(
    playerId: string,
    p: {
      weapon: WeaponId | null;
      ammo: AmmoState;
      grenades: number;
      reloadWeapon: WeaponId | null;
      armor?: number;
      helmet?: number;
    },
  ): void {
    const inv = this.inventories.get(playerId);
    if (!inv) return;

    p.weapon = inv.equippedWeapon;
    p.armor = inv.armor;
    p.helmet = inv.helmet;
    for (const w of WEAPON_SLOTS) {
      p.ammo[w] = { mag: inv.ammo[w].mag, reserve: inv.ammo[w].reserve };
    }
    p.grenades = inv.grenades;
    if (p.reloadWeapon && !inv.ownedWeapons.has(p.reloadWeapon)) {
      p.reloadWeapon = null;
    }
  }

  removePlayer(playerId: string): void {
    this.invalidatePlayerIdempotency(playerId);
    this.inventories.delete(playerId);
  }

  onPlayerDeath(playerId: string): void {
    this.invalidatePlayerIdempotency(playerId);
    if (this.lootEnabled) {
      const inv = this.inventories.get(playerId);
      if (inv) {
        inv.equippedWeapon = null;
      }
    }
  }

  canPlayerUseWeapon(playerId: string, weapon: WeaponId | null): boolean {
    // Pichoq har doim mavjud (loot buyumi emas, slot egallamaydi)
    if (weapon === 'knife') return true;
    const inv = this.inventories.get(playerId);
    if (!inv) {
      return !this.lootEnabled && weapon !== null;
    }
    if (weapon === null) {
      return this.lootEnabled || inv.ownedWeapons.size === 0;
    }
    return inv.ownedWeapons.has(weapon);
  }

  /** Arzon o'qish (har snapshotda chaqiriladi): o'yinchidagi aptechkalar soni. */
  getMedkitCount(playerId: string): number {
    return this.inventories.get(playerId)?.medkits ?? 0;
  }

  getPlayerInventorySnap(playerId: string): PlayerInventorySnap | null {
    const inv = this.inventories.get(playerId);
    if (!inv) return null;

    const items: InventoryEntrySnap[] = [];
    for (let i = 0; i < WEAPON_SLOTS.length; i++) {
      const w = WEAPON_SLOTS[i]!;
      if (!inv.ownedWeapons.has(w)) continue;
      const catalogId = getWeaponCatalogId(w);
      const entry = LOOT_CATALOG[catalogId];
      items.push({
        slotIndex: i,
        catalogId,
        kind: 'weapon',
        nameUz: entry.nameUz,
        weaponId: w,
        quantity: 1,
      });
    }

    if (inv.medkits > 0) {
      const entry = LOOT_CATALOG['heal:medkit'];
      items.push({
        slotIndex: 4,
        catalogId: 'heal:medkit',
        kind: 'medkit',
        nameUz: entry.nameUz,
        quantity: inv.medkits,
      });
    }

    if (inv.grenades > 0) {
      const entry = LOOT_CATALOG['throwable:grenade'];
      items.push({
        slotIndex: 5,
        catalogId: 'throwable:grenade',
        kind: 'grenade',
        nameUz: entry.nameUz,
        quantity: inv.grenades,
      });
    }
    if (inv.armor > 0) {
      items.push({ slotIndex: 6, catalogId: 'gear:vest', kind: 'armor', nameUz: LOOT_CATALOG['gear:vest'].nameUz, quantity: inv.armor });
    }
    if (inv.helmet > 0) {
      items.push({ slotIndex: 7, catalogId: 'gear:helmet', kind: 'helmet', nameUz: LOOT_CATALOG['gear:helmet'].nameUz, quantity: inv.helmet });
    }

    return {
      playerId: inv.playerId,
      roundId: this.roundId,
      spawnId: inv.spawnId,
      inventoryVersion: inv.inventoryVersion,
      lootEnabled: this.lootEnabled,
      lootPreview: this.lootEnabled,
      equippedWeapon: inv.equippedWeapon,
      ownedWeapons: WEAPON_SLOTS.filter((w) => inv.ownedWeapons.has(w)),
      ammo: cloneAmmo(inv.ammo),
      grenades: inv.grenades,
      medkits: inv.medkits,
      armor: inv.armor,
      helmet: inv.helmet,
      maxWeaponSlots: MAX_WEAPON_SLOTS,
      maxMedkits: MAX_MEDKITS_PER_PLAYER,
      maxGrenades: this.lootEnabled ? MAX_GRENADES_LOOT_MODE : GRENADES_PER_LIFE,
      items,
    };
  }

  getPublicContainerState(containerId: string): PublicContainerState | null {
    const cnt = this.containers.get(containerId);
    if (!cnt) return null;

    return {
      id: cnt.id,
      locationId: cnt.locationId,
      assetId: cnt.assetId,
      kind: cnt.kind,
      labelUz: cnt.labelUz,
      position: { x: cnt.position.x, y: cnt.position.y, z: cnt.position.z },
      yaw: cnt.yaw,
      interactionRadius: cnt.interactionRadius,
      status: cnt.status,
      opened: cnt.opened,
      openFraction: cnt.openFraction,
      version: cnt.version,
      itemCount: cnt.opened ? cnt.items.size : -1,
      items: cnt.opened ? [...cnt.items.values()].map(clonePublicLootItem) : [],
    };
  }

  getPublicLootSnapshot(): RoomLootSnapshot {
    const containers: PublicContainerState[] = [];
    for (const id of this.containers.keys()) {
      const pub = this.getPublicContainerState(id);
      if (pub) containers.push(pub);
    }

    return {
      roomId: this.roomId,
      roundId: this.roundId,
      version: this.version,
      lootEnabled: this.lootEnabled,
      lootPreview: this.lootEnabled,
      containers,
      groundItems: [...this.groundItems.values()].map(clonePublicLootItem),
    };
  }

  getAuthoritativeContainerIds(): string[] {
    return [...this.containers.keys()];
  }

  getRawContainerForServerTest(containerId: string): ServerContainerRecord | undefined {
    return this.containers.get(containerId);
  }

  private setCacheEntry<T>(map: Map<string, T>, key: string, value: T): void {
    if (map.size >= MAX_IDEMPOTENCY_CACHE_ENTRIES) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) {
        map.delete(firstKey);
      }
    }
    map.set(key, value);
  }

  openContainer(
    player: { id: string; alive: boolean; pos: Vec3; spawnId: number; crouched?: boolean },
    rawReq: unknown,
  ): ContainerOpenAck {
    const req = sanitizeContainerOpenReq(rawReq);
    if (!req) {
      return {
        ok: false,
        requestId: '',
        containerId: '',
        roundId: this.roundId,
        spawnId: player.spawnId,
        code: 'INVALID_REQUEST',
        message: LOOT_ERROR_MESSAGES_UZ.INVALID_REQUEST,
      };
    }

    if (!this.lootEnabled) {
      this.stats.rejectedNotInLootMode++;
      return {
        ok: false,
        requestId: req.requestId,
        containerId: req.containerId,
        roundId: this.roundId,
        spawnId: player.spawnId,
        code: 'NOT_IN_LOOT_MODE',
        message: LOOT_ERROR_MESSAGES_UZ.NOT_IN_LOOT_MODE,
      };
    }

    if (!this.inventories.has(player.id)) {
      this.initPlayer(player.id, player.spawnId);
    } else {
      const existingInv = this.inventories.get(player.id)!;
      if (existingInv.spawnId !== player.spawnId) {
        this.invalidatePlayerIdempotency(player.id);
        existingInv.spawnId = player.spawnId;
      }
    }

    const currentSpawnId = player.spawnId;
    if (!player.alive) {
      this.invalidatePlayerIdempotency(player.id);
      this.stats.rejectedOpenDead++;
      return {
        ok: false,
        requestId: req.requestId,
        containerId: req.containerId,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'PLAYER_DEAD',
        message: LOOT_ERROR_MESSAGES_UZ.PLAYER_DEAD,
      };
    }

    if (this.hasInvalidOrStaleContext(rawReq, currentSpawnId, this.lootEnabled)) {
      this.stats.rejectedStaleRoundOrSpawn++;
      return {
        ok: false,
        requestId: req.requestId,
        containerId: req.containerId,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'INVALID_REQUEST',
        message: LOOT_ERROR_MESSAGES_UZ.INVALID_REQUEST,
      };
    }

    const cacheKey = `${player.id}:r${this.roundId}:s${currentSpawnId}:open:${req.requestId}`;
    const cached = this.openIdempotency.get(cacheKey);
    if (cached) {
      this.stats.idempotentReplays++;
      return {
        ...cached,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        container: this.getPublicContainerState(cached.containerId) ?? cached.container,
        inventory: this.getPlayerInventorySnap(player.id) ?? cached.inventory,
        idempotentReplay: true,
      };
    }

    const cnt = this.containers.get(req.containerId);
    if (!cnt) {
      return {
        ok: false,
        requestId: req.requestId,
        containerId: req.containerId,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'CONTAINER_NOT_FOUND',
        message: LOOT_ERROR_MESSAGES_UZ.CONTAINER_NOT_FOUND,
      };
    }

    const distCheck = isWithinInteractionDistance(
      player.pos,
      cnt.position,
      cnt.interactionRadius + DEFAULT_CONTAINER_EXTRA_MARGIN_M,
    );
    if (!distCheck.ok) {
      this.stats.rejectedOpenDistance++;
      return {
        ok: false,
        requestId: req.requestId,
        containerId: cnt.id,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'OUT_OF_RANGE',
        message: LOOT_ERROR_MESSAGES_UZ.OUT_OF_RANGE,
      };
    }

    // Ko'z balandligi o'tirish holatiga bog'liq (EYE_HEIGHT / CROUCH_EYE_HEIGHT)
    const eye: Vec3 = {
      x: player.pos.x,
      y: player.pos.y + eyeHeightOf(player),
      z: player.pos.z,
    };
    if (!hasLineOfSightToContainer(this.world, eye, cnt.position, cnt.id)) {
      this.stats.rejectedOpenLos++;
      return {
        ok: false,
        requestId: req.requestId,
        containerId: cnt.id,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'LOS_BLOCKED',
        message: LOOT_ERROR_MESSAGES_UZ.LOS_BLOCKED,
      };
    }

    if (!cnt.opened) {
      cnt.opened = true;
      cnt.openFraction = 1;
      cnt.status = cnt.items.size > 0 ? 'opened' : 'empty';
      cnt.version++;
      this.version++;
      this.stats.containersOpened++;
    }

    const ack: ContainerOpenAck = {
      ok: true,
      requestId: req.requestId,
      containerId: cnt.id,
      roundId: this.roundId,
      spawnId: currentSpawnId,
      container: this.getPublicContainerState(cnt.id)!,
      inventory: this.getPlayerInventorySnap(player.id)!,
      lootVersion: this.version,
    };

    this.setCacheEntry(this.openIdempotency, cacheKey, ack);
    return ack;
  }

  pickupItem(
    player: { id: string; alive: boolean; pos: Vec3; spawnId: number; crouched?: boolean },
    rawReq: unknown,
  ): LootPickupAck {
    const req = sanitizeLootPickupReq(rawReq);
    if (!req) {
      return {
        ok: false,
        requestId: '',
        itemId: '',
        containerId: null,
        roundId: this.roundId,
        spawnId: player.spawnId,
        code: 'INVALID_REQUEST',
        message: LOOT_ERROR_MESSAGES_UZ.INVALID_REQUEST,
      };
    }

    if (!this.lootEnabled) {
      this.stats.rejectedNotInLootMode++;
      return {
        ok: false,
        requestId: req.requestId,
        itemId: req.itemId,
        containerId: req.containerId ?? null,
        roundId: this.roundId,
        spawnId: player.spawnId,
        code: 'NOT_IN_LOOT_MODE',
        message: LOOT_ERROR_MESSAGES_UZ.NOT_IN_LOOT_MODE,
      };
    }

    if (!this.inventories.has(player.id)) {
      this.initPlayer(player.id, player.spawnId);
    } else {
      const existingInv = this.inventories.get(player.id)!;
      if (existingInv.spawnId !== player.spawnId) {
        this.invalidatePlayerIdempotency(player.id);
        existingInv.spawnId = player.spawnId;
      }
    }
    const inv = this.inventories.get(player.id)!;
    const currentSpawnId = player.spawnId;

    if (!player.alive) {
      this.invalidatePlayerIdempotency(player.id);
      return {
        ok: false,
        requestId: req.requestId,
        itemId: req.itemId,
        containerId: req.containerId,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'PLAYER_DEAD',
        message: LOOT_ERROR_MESSAGES_UZ.PLAYER_DEAD,
      };
    }

    if (this.hasInvalidOrStaleContext(rawReq, currentSpawnId, this.lootEnabled)) {
      this.stats.rejectedStaleRoundOrSpawn++;
      return {
        ok: false,
        requestId: req.requestId,
        itemId: req.itemId,
        containerId: req.containerId ?? null,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'INVALID_REQUEST',
        message: LOOT_ERROR_MESSAGES_UZ.INVALID_REQUEST,
      };
    }

    const cacheKey = `${player.id}:r${this.roundId}:s${currentSpawnId}:pickup:${req.requestId}`;
    const cached = this.pickupIdempotency.get(cacheKey);
    if (cached) {
      this.stats.idempotentReplays++;
      return {
        ...cached,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        container:
          (cached.containerId ? this.getPublicContainerState(cached.containerId) : null) ??
          cached.container,
        inventory: this.getPlayerInventorySnap(player.id) ?? cached.inventory,
        idempotentReplay: true,
      };
    }

    let cnt: ServerContainerRecord | undefined;
    if (req.containerId) {
      cnt = this.containers.get(req.containerId);
    } else {
      for (const c of this.containers.values()) {
        if (c.items.has(req.itemId) || c.takenItemIds.has(req.itemId)) {
          cnt = c;
          break;
        }
      }
    }

    // Yerda yotgan buyum (o'lgan o'yinchining quroli): konteynersiz olish
    if (!cnt && !req.containerId) {
      const ground = this.groundItems.get(req.itemId);
      if (ground) {
        const gd = isWithinInteractionDistance(player.pos, ground.position, GROUND_ITEM_PICKUP_RADIUS_M);
        if (!gd.ok) {
          this.stats.rejectedPickupDistance++;
          return {
            ok: false, requestId: req.requestId, itemId: req.itemId, containerId: null,
            roundId: this.roundId, spawnId: currentSpawnId,
            code: 'OUT_OF_RANGE', message: LOOT_ERROR_MESSAGES_UZ.OUT_OF_RANGE,
          };
        }
        const gErr = this.applyItemToInventory(inv, ground);
        if (gErr) {
          return {
            ok: false, requestId: req.requestId, itemId: req.itemId, containerId: null,
            roundId: this.roundId, spawnId: currentSpawnId,
            code: gErr, message: LOOT_ERROR_MESSAGES_UZ[gErr],
            inventory: this.getPlayerInventorySnap(player.id)!,
          };
        }
        this.groundItems.delete(ground.id);
        this.version++;
        inv.inventoryVersion = ++this.nextInventoryVersion;
        this.stats.itemsPickedUp++;
        const gack: LootPickupAck = {
          ok: true, requestId: req.requestId, itemId: ground.id, containerId: null,
          roundId: this.roundId, spawnId: currentSpawnId,
          pickedItem: clonePublicLootItem(ground),
          inventory: this.getPlayerInventorySnap(player.id)!,
          lootVersion: this.version,
        };
        this.setCacheEntry(this.pickupIdempotency, cacheKey, gack);
        return gack;
      }
    }

    if (!cnt) {
      return {
        ok: false,
        requestId: req.requestId,
        itemId: req.itemId,
        containerId: req.containerId ?? null,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'CONTAINER_NOT_FOUND',
        message: LOOT_ERROR_MESSAGES_UZ.CONTAINER_NOT_FOUND,
      };
    }

    if (!cnt.opened) {
      this.stats.rejectedPickupClosed++;
      return {
        ok: false,
        requestId: req.requestId,
        itemId: req.itemId,
        containerId: cnt.id,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'CONTAINER_CLOSED',
        message: LOOT_ERROR_MESSAGES_UZ.CONTAINER_CLOSED,
      };
    }

    const distCheck = isWithinInteractionDistance(
      player.pos,
      cnt.position,
      cnt.interactionRadius + DEFAULT_CONTAINER_EXTRA_MARGIN_M,
    );
    if (!distCheck.ok) {
      this.stats.rejectedPickupDistance++;
      return {
        ok: false,
        requestId: req.requestId,
        itemId: req.itemId,
        containerId: cnt.id,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'OUT_OF_RANGE',
        message: LOOT_ERROR_MESSAGES_UZ.OUT_OF_RANGE,
      };
    }

    const eye: Vec3 = {
      x: player.pos.x,
      y: player.pos.y + eyeHeightOf(player),
      z: player.pos.z,
    };
    if (!hasLineOfSightToContainer(this.world, eye, cnt.position, cnt.id)) {
      this.stats.rejectedPickupLos++;
      return {
        ok: false,
        requestId: req.requestId,
        itemId: req.itemId,
        containerId: cnt.id,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'LOS_BLOCKED',
        message: LOOT_ERROR_MESSAGES_UZ.LOS_BLOCKED,
      };
    }

    const item = cnt.items.get(req.itemId);
    if (!item) {
      if (cnt.takenItemIds.has(req.itemId)) {
        this.stats.rejectedPickupTaken++;
        return {
          ok: false,
          requestId: req.requestId,
          itemId: req.itemId,
          containerId: cnt.id,
          roundId: this.roundId,
          spawnId: currentSpawnId,
          code: 'ITEM_ALREADY_TAKEN',
          message: LOOT_ERROR_MESSAGES_UZ.ITEM_ALREADY_TAKEN,
          container: this.getPublicContainerState(cnt.id)!,
        };
      }
      return {
        ok: false,
        requestId: req.requestId,
        itemId: req.itemId,
        containerId: cnt.id,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'ITEM_NOT_FOUND',
        message: LOOT_ERROR_MESSAGES_UZ.ITEM_NOT_FOUND,
        container: this.getPublicContainerState(cnt.id)!,
      };
    }

    // Validate inventory capacity & apply item
    const applyErr = this.applyItemToInventory(inv, item);
    if (applyErr) {
      return {
        ok: false,
        requestId: req.requestId,
        itemId: req.itemId,
        containerId: cnt.id,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: applyErr,
        message: LOOT_ERROR_MESSAGES_UZ[applyErr],
        container: this.getPublicContainerState(cnt.id)!,
        inventory: this.getPlayerInventorySnap(player.id)!,
      };
    }

    // Atomically mutate container & inventory state
    cnt.items.delete(item.id);
    cnt.takenItemIds.add(item.id);
    cnt.status = cnt.items.size > 0 ? 'opened' : 'empty';
    cnt.version++;
    this.version++;
    inv.inventoryVersion = ++this.nextInventoryVersion;
    this.stats.itemsPickedUp++;

    const ack: LootPickupAck = {
      ok: true,
      requestId: req.requestId,
      itemId: item.id,
      containerId: cnt.id,
      roundId: this.roundId,
      spawnId: currentSpawnId,
      pickedItem: clonePublicLootItem(item),
      container: this.getPublicContainerState(cnt.id)!,
      inventory: this.getPlayerInventorySnap(player.id)!,
      lootVersion: this.version,
    };

    this.setCacheEntry(this.pickupIdempotency, cacheKey, ack);
    return ack;
  }

  /**
   * Buyumni inventarga qo'llaydi (sig'im tekshiruvi bilan). Xato kodi yoki null (muvaffaqiyat).
   * Konteyner va yerdagi buyumlar uchun umumiy.
   */
  private applyItemToInventory(inv: ServerPlayerInventory, item: PublicLootItem): LootErrorCode | null {
    if (item.kind === 'weapon') {
      const w = item.weaponId ?? LOOT_CATALOG[item.catalogId].weaponId!;
      if (!inv.ownedWeapons.has(w)) {
        inv.ownedWeapons.add(w);
        inv.ammo[w].mag = item.initialMag ?? WEAPONS[w].magSize;
        inv.ammo[w].reserve = Math.min(
          MAX_AMMO_RESERVE[w],
          inv.ammo[w].reserve + (item.initialReserve ?? WEAPONS[w].magSize),
        );
        if (inv.equippedWeapon === null || inv.equippedWeapon === 'knife') {
          // Qo'l bo'sh yoki pichoq ushlab turgan bo'lsa — topilgan o'qotar qurol darhol qo'lga olinadi
          inv.equippedWeapon = w;
        }
      } else {
        if (inv.ammo[w].reserve >= MAX_AMMO_RESERVE[w]) return 'WEAPON_ALREADY_OWNED';
        inv.ammo[w].reserve = Math.min(
          MAX_AMMO_RESERVE[w],
          inv.ammo[w].reserve + (item.initialMag ?? 0) + (item.initialReserve ?? WEAPONS[w].magSize),
        );
      }
      return null;
    }
    if (item.kind === 'ammo') {
      const w = item.ammoWeapon ?? LOOT_CATALOG[item.catalogId].ammoWeapon!;
      if (inv.ammo[w].reserve >= MAX_AMMO_RESERVE[w]) return 'AMMO_FULL';
      inv.ammo[w].reserve = Math.min(MAX_AMMO_RESERVE[w], inv.ammo[w].reserve + item.quantity);
      return null;
    }
    if (item.kind === 'medkit') {
      if (inv.medkits >= MAX_MEDKITS_PER_PLAYER) return 'MEDKITS_FULL';
      inv.medkits = Math.min(MAX_MEDKITS_PER_PLAYER, inv.medkits + item.quantity);
      return null;
    }
    if (item.kind === 'grenade') {
      if (inv.grenades >= MAX_GRENADES_LOOT_MODE) return 'GRENADES_FULL';
      inv.grenades = Math.min(MAX_GRENADES_LOOT_MODE, inv.grenades + item.quantity);
      return null;
    }
    if (item.kind === 'armor') {
      if (inv.armor >= ARMOR_MAX) return 'ARMOR_FULL';
      inv.armor = ARMOR_MAX;
      return null;
    }
    if (item.kind === 'helmet') {
      if (inv.helmet >= HELMET_MAX) return 'HELMET_FULL';
      inv.helmet = HELMET_MAX;
      return null;
    }
    return 'INVALID_REQUEST';
  }

  /**
   * O'yinchi o'lganda qo'lidagi qurolini (joriy magazin va zaxira o'q bilan) yerga tashlaydi.
   * Faqat loot rejimida. Qaytaradi: yaratilgan buyum yoki null.
   */
  dropWeaponOnDeath(playerId: string, equipped: WeaponId | null, pos: Vec3, yaw: number): PublicLootItem | null {
    if (!this.lootEnabled) return null;
    const inv = this.inventories.get(playerId);
    if (!inv) return null;
    // Pichoq yerga tushmaydi; pichoq qo'lda bo'lsa egalik qilingan birinchi o'qotar qurol tushadi
    const w = equipped && equipped !== 'knife' && inv.ownedWeapons.has(equipped) ? equipped : [...inv.ownedWeapons][0] ?? null;
    if (!w) return null;
    const catalogId = getWeaponCatalogId(w);
    const entry = LOOT_CATALOG[catalogId];
    const id = `drop:r${this.roundId}:${++this.dropSeq}`;
    const item: PublicLootItem = {
      id,
      catalogId,
      kind: 'weapon',
      nameUz: entry.nameUz,
      weaponId: w,
      quantity: 1,
      initialMag: inv.ammo[w].mag,
      initialReserve: inv.ammo[w].reserve,
      containerId: null,
      position: { x: pos.x, y: pos.y, z: pos.z },
      yaw,
    };
    // Qurol endi yerda — o'lgan o'yinchining inventaridan chiqadi (spawn'da baribir tozalanadi)
    inv.ownedWeapons.delete(w);
    inv.ammo[w] = { mag: 0, reserve: 0 };
    if (inv.equippedWeapon === w) inv.equippedWeapon = null;
    this.groundItems.set(id, item);
    // Yerdagi buyumlar soni cheklangan: eng eskisi o'chadi
    while (this.groundItems.size > MAX_GROUND_ITEMS) {
      const oldest = this.groundItems.keys().next().value;
      if (oldest === undefined) break;
      this.groundItems.delete(oldest);
    }
    this.version++;
    return item;
  }

  equipWeapon(playerId: string, alive: boolean, rawReq: unknown): EquipWeaponAck {
    const req = sanitizeEquipWeaponReq(rawReq);
    if (!req) {
      return {
        ok: false,
        requestId: '',
        equippedWeapon: null,
        roundId: this.roundId,
        code: 'INVALID_REQUEST',
        message: LOOT_ERROR_MESSAGES_UZ.INVALID_REQUEST,
      };
    }

    const inv = this.inventories.get(playerId);
    if (!this.lootEnabled && req.weapon === null) {
      this.stats.rejectedNotInLootMode++;
      return {
        ok: false,
        requestId: req.requestId,
        equippedWeapon: inv?.equippedWeapon ?? 'rifle',
        roundId: this.roundId,
        spawnId: inv?.spawnId ?? 0,
        code: 'NOT_IN_LOOT_MODE',
        message: LOOT_ERROR_MESSAGES_UZ.NOT_IN_LOOT_MODE,
        inventory: this.getPlayerInventorySnap(playerId) ?? undefined,
      };
    }

    if (!inv) {
      return {
        ok: false,
        requestId: req.requestId,
        equippedWeapon: null,
        roundId: this.roundId,
        spawnId: 0,
        code: 'PLAYER_NOT_FOUND',
        message: LOOT_ERROR_MESSAGES_UZ.PLAYER_NOT_FOUND,
      };
    }

    const currentSpawnId = inv.spawnId;
    if (!alive) {
      this.invalidatePlayerIdempotency(playerId);
      return {
        ok: false,
        requestId: req.requestId,
        equippedWeapon: inv.equippedWeapon,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'PLAYER_DEAD',
        message: LOOT_ERROR_MESSAGES_UZ.PLAYER_DEAD,
        inventory: this.getPlayerInventorySnap(playerId)!,
      };
    }

    if (this.hasInvalidOrStaleContext(rawReq, currentSpawnId, this.lootEnabled)) {
      this.stats.rejectedStaleRoundOrSpawn++;
      return {
        ok: false,
        requestId: req.requestId,
        equippedWeapon: inv.equippedWeapon,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'INVALID_REQUEST',
        message: LOOT_ERROR_MESSAGES_UZ.INVALID_REQUEST,
        inventory: this.getPlayerInventorySnap(playerId)!,
      };
    }

    const cacheKey = `${playerId}:r${this.roundId}:s${currentSpawnId}:equip:${req.requestId}`;
    const cached = this.equipIdempotency.get(cacheKey);
    if (cached) {
      this.stats.idempotentReplays++;
      return {
        ...cached,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        inventory: this.getPlayerInventorySnap(playerId) ?? cached.inventory,
        idempotentReplay: true,
      };
    }

    if (!this.canPlayerUseWeapon(playerId, req.weapon)) {
      this.stats.rejectedEquipUnowned++;
      return {
        ok: false,
        requestId: req.requestId,
        equippedWeapon: inv.equippedWeapon,
        roundId: this.roundId,
        spawnId: currentSpawnId,
        code: 'WEAPON_NOT_OWNED',
        message: LOOT_ERROR_MESSAGES_UZ.WEAPON_NOT_OWNED,
        inventory: this.getPlayerInventorySnap(playerId)!,
      };
    }

    inv.equippedWeapon = req.weapon;
    inv.inventoryVersion = ++this.nextInventoryVersion;

    const ack: EquipWeaponAck = {
      ok: true,
      requestId: req.requestId,
      equippedWeapon: inv.equippedWeapon,
      roundId: this.roundId,
      spawnId: currentSpawnId,
      inventory: this.getPlayerInventorySnap(playerId)!,
    };

    this.setCacheEntry(this.equipIdempotency, cacheKey, ack);
    return ack;
  }

  useMedkit(
    player: { id: string; alive: boolean; hp: number; spawnId?: number },
    rawReq: unknown,
  ): { ack: UseMedkitAck; newHp: number } {
    const req = sanitizeUseMedkitReq(rawReq);
    if (!req) {
      return {
        ack: {
          ok: false,
          requestId: '',
          roundId: this.roundId,
          spawnId: player.spawnId ?? 0,
          code: 'INVALID_REQUEST',
          message: LOOT_ERROR_MESSAGES_UZ.INVALID_REQUEST,
        },
        newHp: player.hp,
      };
    }

    const inv = this.inventories.get(player.id);
    const currentSpawnId = player.spawnId ?? inv?.spawnId ?? 0;

    if (!this.lootEnabled) {
      this.stats.rejectedNotInLootMode++;
      return {
        ack: {
          ok: false,
          requestId: req.requestId,
          hp: player.hp,
          roundId: this.roundId,
          spawnId: currentSpawnId,
          code: 'NOT_IN_LOOT_MODE',
          message: LOOT_ERROR_MESSAGES_UZ.NOT_IN_LOOT_MODE,
          inventory: this.getPlayerInventorySnap(player.id) ?? undefined,
        },
        newHp: player.hp,
      };
    }

    if (!inv) {
      return {
        ack: {
          ok: false,
          requestId: req.requestId,
          roundId: this.roundId,
          spawnId: currentSpawnId,
          code: 'PLAYER_NOT_FOUND',
          message: LOOT_ERROR_MESSAGES_UZ.PLAYER_NOT_FOUND,
        },
        newHp: player.hp,
      };
    }

    if (player.spawnId !== undefined && inv.spawnId !== player.spawnId) {
      this.invalidatePlayerIdempotency(player.id);
      inv.spawnId = player.spawnId;
    }

    if (!player.alive) {
      this.invalidatePlayerIdempotency(player.id);
      return {
        ack: {
          ok: false,
          requestId: req.requestId,
          hp: player.hp,
          roundId: this.roundId,
          spawnId: currentSpawnId,
          code: 'PLAYER_DEAD',
          message: LOOT_ERROR_MESSAGES_UZ.PLAYER_DEAD,
          inventory: this.getPlayerInventorySnap(player.id)!,
        },
        newHp: player.hp,
      };
    }

    if (this.hasInvalidOrStaleContext(rawReq, currentSpawnId, this.lootEnabled)) {
      this.stats.rejectedStaleRoundOrSpawn++;
      return {
        ack: {
          ok: false,
          requestId: req.requestId,
          hp: player.hp,
          roundId: this.roundId,
          spawnId: currentSpawnId,
          code: 'INVALID_REQUEST',
          message: LOOT_ERROR_MESSAGES_UZ.INVALID_REQUEST,
          inventory: this.getPlayerInventorySnap(player.id)!,
        },
        newHp: player.hp,
      };
    }

    const cacheKey = `${player.id}:r${this.roundId}:s${currentSpawnId}:medkit:${req.requestId}`;
    const cached = this.medkitIdempotency.get(cacheKey);
    if (cached) {
      this.stats.idempotentReplays++;
      return {
        ack: {
          ...cached.ack,
          roundId: this.roundId,
          spawnId: currentSpawnId,
          inventory: this.getPlayerInventorySnap(player.id) ?? cached.ack.inventory,
          idempotentReplay: true,
        },
        newHp: cached.newHp,
      };
    }

    if (inv.medkits <= 0) {
      return {
        ack: {
          ok: false,
          requestId: req.requestId,
          hp: player.hp,
          roundId: this.roundId,
          spawnId: currentSpawnId,
          code: 'NO_MEDKITS',
          message: LOOT_ERROR_MESSAGES_UZ.NO_MEDKITS,
          inventory: this.getPlayerInventorySnap(player.id)!,
        },
        newHp: player.hp,
      };
    }

    if (player.hp >= MAX_HP) {
      return {
        ack: {
          ok: false,
          requestId: req.requestId,
          hp: player.hp,
          roundId: this.roundId,
          spawnId: currentSpawnId,
          code: 'HP_ALREADY_FULL',
          message: LOOT_ERROR_MESSAGES_UZ.HP_ALREADY_FULL,
          inventory: this.getPlayerInventorySnap(player.id)!,
        },
        newHp: player.hp,
      };
    }

    inv.medkits--;
    const newHp = Math.min(MAX_HP, player.hp + MEDKIT_HEAL_AMOUNT);
    inv.inventoryVersion = ++this.nextInventoryVersion;

    const ack: UseMedkitAck = {
      ok: true,
      requestId: req.requestId,
      hp: newHp,
      roundId: this.roundId,
      spawnId: currentSpawnId,
      inventory: this.getPlayerInventorySnap(player.id)!,
    };

    const result = { ack, newHp };
    this.setCacheEntry(this.medkitIdempotency, cacheKey, result);
    return result;
  }
}
