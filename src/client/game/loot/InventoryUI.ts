import {
  MAX_GRENADES_LOOT_MODE,
  MAX_MEDKITS_PER_PLAYER,
  type PlayerInventorySnap,
} from '../../../shared/loot';
import { KNIFE, KNIFE_SLOT_KEY, WEAPONS, WEAPON_SLOTS, type WeaponId } from '../../../shared/weapons';
import { weaponIconHtml } from '../Hud';
import { onWeaponAssetsReady } from '../WeaponAssetRegistry';

export interface InventoryUICallbacks {
  onSelectWeapon: (weapon: WeaponId | null) => void;
  onUseMedkit: () => void;
}

export interface InventoryUIDiagnostics {
  visible: boolean;
  unarmedBannerVisible: boolean;
  equippedWeapon: WeaponId | null;
  ownedWeapons: WeaponId[];
  medkits: number;
  grenades: number;
  inventoryVersion: number;
}


function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

export class InventoryUI {
  private readonly callbacks: InventoryUICallbacks;
  private rootEl: HTMLElement | null = null;
  private bannerEl: HTMLElement | null = null;
  private stripEl: HTMLElement | null = null;

  private visible = false;
  private snap: PlayerInventorySnap | null = null;
  private lastRenderKey = '';

  constructor(callbacks: InventoryUICallbacks) {
    this.callbacks = callbacks;
    this.mountDom();
  }

  private mountDom(): void {
    if (typeof document === 'undefined') return;

    const existing = document.getElementById('stage06-inventory-hud');
    if (existing) existing.remove();

    const host = document.getElementById('hud') ?? document.body;
    const root = document.createElement('div');
    root.id = 'stage06-inventory-hud';
    root.className = 'hidden';

    const banner = document.createElement('div');
    banner.id = 'stage06-unarmed-banner';
    banner.className = 'hidden';

    const strip = document.createElement('div');
    strip.id = 'stage06-inventory-strip';

    root.appendChild(banner);
    root.appendChild(strip);
    host.appendChild(root);

    this.rootEl = root;
    this.bannerEl = banner;
    this.stripEl = strip;
    // 3D qurol ikonkalari keyinroq tayyor bo'ladi — kelganda panel qayta chiziladi
    onWeaponAssetsReady(() => {
      this.lastRenderKey = '';
      this.render();
    });
  }

  updateInventory(snap: PlayerInventorySnap | null): void {
    this.snap = snap;
    this.render();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.render();
  }

  private isUnarmedBannerVisible(): boolean {
    return Boolean(this.visible && this.snap && this.snap.lootPreview && this.snap.equippedWeapon === null);
  }

  getDiagnostics(): InventoryUIDiagnostics {
    return {
      visible: Boolean(this.visible && this.snap && this.snap.lootPreview),
      unarmedBannerVisible: this.isUnarmedBannerVisible(),
      equippedWeapon: this.snap ? this.snap.equippedWeapon : null,
      ownedWeapons: this.snap ? [...this.snap.ownedWeapons] : [],
      medkits: this.snap ? this.snap.medkits : 0,
      grenades: this.snap ? this.snap.grenades : 0,
      inventoryVersion: this.snap ? this.snap.inventoryVersion : 0,
    };
  }

  reset(): void {
    this.snap = null;
    this.visible = false;
    this.lastRenderKey = '';
    if (this.rootEl) {
      this.rootEl.className = 'hidden';
    }
    if (this.bannerEl) {
      this.bannerEl.className = 'hidden';
      this.bannerEl.textContent = '';
    }
    if (this.stripEl) {
      this.stripEl.innerHTML = '';
    }
  }

  dispose(): void {
    this.reset();
    if (this.rootEl) {
      this.rootEl.remove();
      this.rootEl = null;
    }
    this.bannerEl = null;
    this.stripEl = null;
  }

  private render(): void {
    const s = this.snap;
    const shouldShowHud = Boolean(this.visible && s && s.lootPreview);

    if (!shouldShowHud || !s) {
      this.lastRenderKey = '';
      if (this.rootEl) this.rootEl.className = 'hidden';
      if (this.bannerEl) {
        this.bannerEl.className = 'hidden';
        this.bannerEl.textContent = '';
      }
      return;
    }

    if (this.rootEl) {
      this.rootEl.className = '';
    }

    const ammoKey = WEAPON_SLOTS.map((w) => {
      const a = s.ammo[w];
      return `${w}:${a ? a.mag : 0}/${a ? a.reserve : 0}`;
    }).join('|');
    const renderKey = `${s.inventoryVersion}|${s.equippedWeapon ?? 'none'}|${s.ownedWeapons.join(',')}|${s.medkits}/${s.maxMedkits}|${s.grenades}/${s.maxGrenades}|${s.armor ?? 0}|${s.helmet ?? 0}|${ammoKey}`;
    if (renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;

    if (this.bannerEl) {
      if (s.equippedWeapon === null) {
        this.bannerEl.className = '';
        this.bannerEl.textContent =
          s.ownedWeapons.length === 0
            ? "Qurolsiz — konteynerlarni [E] bilan oching"
            : "Qo'llar bo'sh — [1–4] qurol tanlang";
      } else {
        this.bannerEl.className = 'hidden';
        this.bannerEl.textContent = '';
      }
    }

    if (!this.stripEl) return;

    // Ixcham yog'och taxtacha: [tugma raqami + ikonka] ustida, [nom + o'q] ostida; matnli holatlar tooltip'da
    const slotHtml = (w: WeaponId, key: number, owned: boolean, equipped: boolean, ammoText: string, tip: string) => `
        <button type="button" class="s06-inv-slot ${equipped ? 'owned equipped' : owned ? 'owned' : 'locked'}"
          data-weapon="${escapeHtml(w)}" ${!owned ? 'disabled' : ''} title="${escapeHtml(tip)}">
          <span class="s06-slot-top"><span class="s06-slot-key">${key}</span><span class="s06-slot-icon">${weaponIconHtml(w)}</span></span>
          <span class="s06-slot-bottom"><span class="s06-slot-name">${escapeHtml(WEAPONS[w].name)}</span><span class="s06-slot-ammo">${escapeHtml(ammoText)}</span></span>
        </button>`;

    const weaponsHtml = WEAPON_SLOTS.map((w, idx) => {
      const def = WEAPONS[w];
      const isOwned = s.ownedWeapons.includes(w);
      const isEquipped = s.equippedWeapon === w;
      const ammo = s.ammo[w] ?? { mag: 0, reserve: 0 };
      const tip = isEquipped
        ? `${def.name} — qo'lda (${ammo.mag}/${ammo.reserve})`
        : isOwned
          ? `${def.name} — [${idx + 1}] bilan oling (${ammo.mag}/${ammo.reserve})`
          : `${def.name} — hali topilmagan, konteynerlardan qidiring`;
      return slotHtml(w, idx + 1, isOwned, isEquipped, isOwned ? `${ammo.mag}/${ammo.reserve}` : '—', tip);
    }).join('');

    const maxMedkits = s.maxMedkits ?? MAX_MEDKITS_PER_PLAYER;
    const maxGrenades = s.maxGrenades ?? MAX_GRENADES_LOOT_MODE;
    const isHandsEmpty = s.equippedWeapon === null;
    const armor = s.armor ?? 0;
    const helmet = s.helmet ?? 0;

    this.stripEl.innerHTML = `
      <div class="s06-inv-weapons">
        ${weaponsHtml}
        ${slotHtml(
          KNIFE,
          KNIFE_SLOT_KEY,
          true,
          s.equippedWeapon === KNIFE,
          '∞',
          s.equippedWeapon === KNIFE ? "Pichoq — qo'lda" : `Pichoq — har doim bor, [${KNIFE_SLOT_KEY}] bilan oling`,
        )}
      </div>
      <div class="s06-inv-divider"></div>
      <div class="s06-inv-utils">
        <button type="button" class="s06-util-btn medkit-btn ${s.medkits > 0 ? 'has-item' : 'empty'}" data-action="medkit"
          title="Aptechka [H]: +45 HP (${s.medkits}/${maxMedkits})">
          <span class="s06-util-icon">🩹</span><span class="s06-util-count">${s.medkits}</span><span class="s06-util-key">H</span>
        </button>
        <div class="s06-util-btn grenade-chip ${s.grenades > 0 ? 'has-item' : 'empty'}" title="Granata [G]: uloqtirish (${s.grenades}/${maxGrenades})">
          <span class="s06-util-icon">${weaponIconHtml('grenade')}</span><span class="s06-util-count">${s.grenades}</span><span class="s06-util-key">G</span>
        </div>
        <button type="button" class="s06-util-btn unarm-btn ${isHandsEmpty ? 'active' : ''}" data-action="unarm"
          title="Bo'sh qo'l [0]: qurolni yechish${isHandsEmpty ? ' (hozir faol)' : ''}">
          <span class="s06-util-icon">✋</span><span class="s06-util-key">0</span>
        </button>
        <div class="s06-util-btn gear-chip ${armor > 0 ? 'has-item' : 'empty'}" title="Zirh nimcha: tana zararining 40% ini yutadi${armor > 0 ? ` (mustahkamlik ${Math.round(armor)})` : ' — yo‘q'}">
          <span class="s06-util-icon">🦺</span><span class="s06-util-count">${armor > 0 ? Math.round(armor) : '—'}</span>
        </div>
        <div class="s06-util-btn gear-chip ${helmet > 0 ? 'has-item' : 'empty'}" title="Kaska: bosh zararining 50% ini yutadi${helmet > 0 ? ` (mustahkamlik ${Math.round(helmet)})` : ' — yo‘q'}">
          <span class="s06-util-icon">⛑️</span><span class="s06-util-count">${helmet > 0 ? Math.round(helmet) : '—'}</span>
        </div>
      </div>
    `;

    const weaponBtns = this.stripEl.querySelectorAll<HTMLButtonElement>('.s06-inv-slot[data-weapon]');
    weaponBtns.forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const weapon = btn.getAttribute('data-weapon') as WeaponId | null;
        if (!weapon || !this.snap || !this.snap.ownedWeapons.includes(weapon)) return;
        this.callbacks.onSelectWeapon(weapon);
      });
    });

    const medkitBtn = this.stripEl.querySelector<HTMLButtonElement>('[data-action="medkit"]');
    if (medkitBtn) {
      medkitBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.callbacks.onUseMedkit();
      });
    }

    const unarmBtn = this.stripEl.querySelector<HTMLButtonElement>('[data-action="unarm"]');
    if (unarmBtn) {
      unarmBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.callbacks.onSelectWeapon(null);
      });
    }
  }
}
