import {
  MAX_GRENADES_LOOT_MODE,
  MAX_MEDKITS_PER_PLAYER,
  type PlayerInventorySnap,
} from '../../../shared/loot';
import { KNIFE, KNIFE_SLOT_KEY, WEAPONS, WEAPON_SLOTS, type WeaponId } from '../../../shared/weapons';

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

    const weaponsHtml = WEAPON_SLOTS.map((w, idx) => {
      const def = WEAPONS[w];
      const isOwned = s.ownedWeapons.includes(w);
      const isEquipped = s.equippedWeapon === w;
      const ammo = s.ammo[w] ?? { mag: 0, reserve: 0 };

      const stateClass = isEquipped ? 'owned equipped' : isOwned ? 'owned' : 'locked';
      const stateLabel = isEquipped ? "Qo'lda" : isOwned ? 'Tayyor' : 'Yo’q';
      const subLabel = isOwned ? `${ammo.mag} / ${ammo.reserve}` : 'Topilmagan';

      return `
        <button type="button" class="s06-inv-slot ${stateClass}" data-weapon="${escapeHtml(w)}" ${!isOwned ? 'disabled' : ''}>
          <div class="s06-slot-top">
            <span class="s06-slot-name"><span class="s06-slot-key">${idx + 1}</span> ${escapeHtml(def.name)}</span>
            <span class="s06-slot-state">${escapeHtml(stateLabel)}</span>
          </div>
          <div class="s06-slot-sub">${escapeHtml(subLabel)}</div>
        </button>
      `;
    }).join('');

    const maxMedkits = s.maxMedkits ?? MAX_MEDKITS_PER_PLAYER;
    const maxGrenades = s.maxGrenades ?? MAX_GRENADES_LOOT_MODE;
    const isHandsEmpty = s.equippedWeapon === null;

    this.stripEl.innerHTML = `
      <div class="s06-inv-weapons">
        ${weaponsHtml}
        <button type="button" class="s06-inv-slot owned ${s.equippedWeapon === KNIFE ? 'equipped' : ''}" data-weapon="${KNIFE}">
          <div class="s06-slot-top">
            <span class="s06-slot-name"><span class="s06-slot-key">${KNIFE_SLOT_KEY}</span> ${escapeHtml(WEAPONS.knife.name)}</span>
            <span class="s06-slot-state">${s.equippedWeapon === KNIFE ? "Qo'lda" : 'Har doim'}</span>
          </div>
          <div class="s06-slot-sub">∞ · yaqin masofa</div>
        </button>
      </div>
      <div class="s06-inv-divider"></div>
      <div class="s06-inv-utils">
        <button type="button" class="s06-util-btn medkit-btn ${s.medkits > 0 ? 'has-medkit' : ''}" data-action="medkit">
          <span>Aptechka ×${s.medkits}/${maxMedkits}<span class="s06-util-key">H</span></span>
          <span class="s06-util-sub">${s.medkits > 0 ? '+45 HP' : "Yo'q"}</span>
        </button>
        <div class="s06-util-btn" style="cursor: default;">
          <span>Granata ×${s.grenades}/${maxGrenades}<span class="s06-util-key">G</span></span>
          <span class="s06-util-sub">${s.grenades > 0 ? 'Uloqtirish' : "Yo'q"}</span>
        </div>
        <button type="button" class="s06-util-btn unarm-btn ${isHandsEmpty ? 'active' : ''}" data-action="unarm">
          <span>Bo'sh qo'l<span class="s06-util-key">0</span></span>
          <span class="s06-util-sub">${isHandsEmpty ? 'Faol' : 'Qurolni yechish'}</span>
        </button>
        <div class="s06-util-btn gear-chip ${(s.armor ?? 0) > 0 ? 'has-gear' : ''}" style="cursor: default;">
          <span>Zirh ${(s.armor ?? 0) > 0 ? `${s.armor}` : '—'}</span>
          <span class="s06-util-sub">${(s.armor ?? 0) > 0 ? '−40% zarar' : "Yo'q"}</span>
        </div>
        <div class="s06-util-btn gear-chip ${(s.helmet ?? 0) > 0 ? 'has-gear' : ''}" style="cursor: default;">
          <span>Kaska ${(s.helmet ?? 0) > 0 ? `${s.helmet}` : '—'}</span>
          <span class="s06-util-sub">${(s.helmet ?? 0) > 0 ? '−50% bosh' : "Yo'q"}</span>
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
