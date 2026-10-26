import {
  MAX_GRENADES_LOOT_MODE,
  MAX_MEDKITS_PER_PLAYER,
  type PlayerInventorySnap,
} from '../../../shared/loot';
import { WEAPONS, WEAPON_SLOTS, type WeaponId } from '../../../shared/weapons';

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

const STYLE_ELEMENT_ID = 'stage06-inventory-ui-styles';

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

function injectInventoryUIStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    #stage06-inventory-hud {
      position: fixed;
      bottom: 54px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      z-index: 11;
      pointer-events: none;
      font-family: 'Segoe UI', 'Roboto', system-ui, sans-serif;
      user-select: none;
    }

    #stage06-inventory-hud,
    #stage06-inventory-hud button {
      font-family: 'Bahnschrift', 'Segoe UI', 'Roboto', system-ui, sans-serif;
    }

    /* Qurolsiz eslatma: panel ustida kichik, ramkasiz satr */
    #stage06-unarmed-banner {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 10px;
      border-radius: 6px;
      background: rgba(36, 26, 16, 0.6);
      color: #ffd166;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
      white-space: nowrap;
    }

    /* Inventar paneli: HUD panellari bilan bir xil to'q yog'och/shisha ko'rinish */
    #stage06-inventory-strip {
      display: flex;
      align-items: stretch;
      gap: 5px;
      padding: 5px 6px;
      border-radius: 12px;
      background: rgba(36, 26, 16, 0.8);
      border: 2px solid rgba(217, 155, 82, 0.55);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(6px);
      pointer-events: auto;
    }

    .s06-inv-weapons {
      display: flex;
      align-items: stretch;
      gap: 4px;
    }

    .s06-inv-slot {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 1px;
      min-width: 78px;
      padding: 3px 7px 3px 6px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #d8ccb4;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease;
      text-align: left;
    }

    .s06-inv-slot.locked {
      opacity: 0.42;
      cursor: not-allowed;
      background: rgba(0, 0, 0, 0.25);
      border-style: dashed;
    }

    .s06-inv-slot.owned:hover {
      background: rgba(255, 196, 68, 0.15);
      border-color: rgba(255, 196, 68, 0.58);
    }

    .s06-inv-slot.equipped {
      background: linear-gradient(180deg, #ffca4b, #e8920c);
      border: 1px solid #fff2b2;
      color: #1b1200;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.4);
      transform: translateY(-2px);
      text-shadow: none;
    }

    .s06-slot-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 11px;
      font-weight: 800;
    }

    .s06-slot-key {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      padding: 0 4px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.35);
      color: #ffd166;
      font-size: 10px;
      font-weight: 900;
      line-height: 15px;
    }

    .s06-inv-slot.equipped .s06-slot-key {
      background: rgba(0, 0, 0, 0.55);
      color: #ffd166;
    }

    .s06-slot-state {
      font-size: 9px;
      font-weight: 900;
      letter-spacing: 0.6px;
      color: #9a8f7a;
      text-transform: uppercase;
    }

    .s06-inv-slot.equipped .s06-slot-state {
      color: #3a2400;
    }

    .s06-slot-name {
      font-size: 11px;
      font-weight: 900;
      color: #fff4dc;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .s06-inv-slot.equipped .s06-slot-name {
      color: #1b1200;
    }

    .s06-slot-sub {
      font-size: 10.5px;
      font-weight: 700;
      color: #9a8f7a;
      font-variant-numeric: tabular-nums;
    }

    .s06-inv-slot.owned .s06-slot-sub {
      color: #e8dcc4;
    }

    .s06-inv-slot.equipped .s06-slot-sub {
      color: #3a2400;
    }

    .s06-inv-divider {
      width: 1px;
      background: rgba(255, 255, 255, 0.14);
      margin: 2px 2px;
    }

    .s06-inv-utils {
      display: flex;
      align-items: stretch;
      gap: 4px;
    }

    .s06-util-btn {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: 1px;
      padding: 3px 7px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #fff4dc;
      font-size: 10.5px;
      font-weight: 900;
      letter-spacing: 0.3px;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
      white-space: nowrap;
    }

    .s06-util-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 209, 102, 0.55);
    }

    .s06-util-btn.medkit-btn.has-medkit {
      border-color: rgba(74, 222, 128, 0.55);
      background: rgba(22, 101, 52, 0.35);
      color: #dcfce7;
    }

    .s06-util-btn.unarm-btn.active {
      border-color: #ffd166;
      background: rgba(255, 196, 56, 0.2);
      color: #fff7db;
    }

    .s06-util-sub {
      font-size: 10px;
      font-weight: 700;
      color: #9a8f7a;
    }

    .s06-util-key {
      display: inline-block;
      min-width: 14px;
      padding: 0 4px;
      margin-left: 4px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.35);
      color: #ffd166;
      font-size: 10px;
      line-height: 15px;
      text-align: center;
    }
  `;
  document.head.appendChild(style);
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
    injectInventoryUIStyles();
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
    const renderKey = `${s.inventoryVersion}|${s.equippedWeapon ?? 'none'}|${s.ownedWeapons.join(',')}|${s.medkits}/${s.maxMedkits}|${s.grenades}/${s.maxGrenades}|${ammoKey}`;
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
