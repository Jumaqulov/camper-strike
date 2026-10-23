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

    #stage06-unarmed-banner {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(62, 34, 12, 0.92), rgba(40, 24, 12, 0.92));
      border: 1.5px solid rgba(255, 186, 56, 0.78);
      color: #ffe8b0;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.35px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
      white-space: nowrap;
    }

    #stage06-inventory-strip {
      display: flex;
      align-items: stretch;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 12px;
      background: rgba(16, 20, 26, 0.88);
      border: 1.5px solid rgba(217, 155, 82, 0.52);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(6px);
      pointer-events: auto;
    }

    .s06-inv-weapons {
      display: flex;
      align-items: stretch;
      gap: 5px;
    }

    .s06-inv-slot {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-width: 104px;
      padding: 5px 8px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease;
      text-align: left;
    }

    .s06-inv-slot.locked {
      opacity: 0.48;
      cursor: not-allowed;
      background: rgba(15, 18, 24, 0.6);
      border-style: dashed;
    }

    .s06-inv-slot.owned:hover {
      background: rgba(255, 196, 68, 0.15);
      border-color: rgba(255, 196, 68, 0.58);
    }

    .s06-inv-slot.equipped {
      background: linear-gradient(180deg, rgba(255, 196, 56, 0.28), rgba(230, 140, 14, 0.22));
      border: 1.5px solid #ffd166;
      color: #fff9eb;
      box-shadow: 0 0 12px rgba(255, 184, 36, 0.28);
      transform: translateY(-1px);
    }

    .s06-slot-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      font-size: 11px;
      font-weight: 800;
    }

    .s06-slot-key {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.12);
      color: #ffd166;
      font-size: 10px;
      font-weight: 900;
    }

    .s06-inv-slot.equipped .s06-slot-key {
      background: #ffd166;
      color: #1b1200;
    }

    .s06-slot-state {
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.3px;
      color: #94a3b8;
    }

    .s06-inv-slot.equipped .s06-slot-state {
      color: #ffd166;
    }

    .s06-slot-name {
      font-size: 12px;
      font-weight: 800;
      color: #f1f5f9;
      margin-top: 2px;
      white-space: nowrap;
    }

    .s06-slot-sub {
      font-size: 10px;
      font-weight: 700;
      color: #94a3b8;
      margin-top: 1px;
      font-variant-numeric: tabular-nums;
    }

    .s06-inv-slot.owned .s06-slot-sub {
      color: #d8e2ef;
    }

    .s06-inv-divider {
      width: 1px;
      background: rgba(255, 255, 255, 0.14);
      margin: 2px 2px;
    }

    .s06-inv-utils {
      display: flex;
      align-items: stretch;
      gap: 5px;
    }

    .s06-util-btn {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: 2px;
      padding: 4px 9px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #e2e8f0;
      font-size: 11px;
      font-weight: 800;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
      white-space: nowrap;
    }

    .s06-util-btn:hover {
      background: rgba(255, 255, 255, 0.14);
      border-color: rgba(255, 209, 102, 0.55);
    }

    .s06-util-btn.medkit-btn.has-medkit {
      border-color: rgba(74, 222, 128, 0.55);
      background: rgba(22, 101, 52, 0.35);
      color: #dcfce7;
    }

    .s06-util-btn.unarm-btn.active {
      border-color: #ffd166;
      background: rgba(255, 196, 56, 0.22);
      color: #fff7db;
    }

    .s06-util-sub {
      font-size: 10px;
      font-weight: 700;
      color: #94a3b8;
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
            ? "✋ QUROLSIZ HOLAT — Konteynerlarni [E] bilan ochib qurol va o'q-dori toping!"
            : "✋ QO'LLAR BO'SH — Qurol tanlash uchun [1–4] bosing";
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
      const stateLabel = isEquipped ? "★ QO'LDA" : isOwned ? 'TAYYOR' : '🔒 Topilmagan';
      const subLabel = isOwned ? `${ammo.mag} / ${ammo.reserve} o'q` : '🔒 Topilmagan';

      return `
        <button type="button" class="s06-inv-slot ${stateClass}" data-weapon="${escapeHtml(w)}" ${!isOwned ? 'disabled' : ''}>
          <div class="s06-slot-top">
            <span class="s06-slot-key">${idx + 1}</span>
            <span class="s06-slot-state">${escapeHtml(stateLabel)}</span>
          </div>
          <div class="s06-slot-name">${idx + 1}: ${escapeHtml(def.name)}</div>
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
          <span>🩹 Aptechka [H]: ×${s.medkits}/${maxMedkits}</span>
          <span class="s06-util-sub">${s.medkits > 0 ? '+45 HP tiklash' : "Yo'q"}</span>
        </button>
        <div class="s06-util-btn" style="cursor: default;">
          <span>💣 Granata [G]: ×${s.grenades}/${maxGrenades}</span>
          <span class="s06-util-sub">Uloqtirish</span>
        </div>
        <button type="button" class="s06-util-btn unarm-btn ${isHandsEmpty ? 'active' : ''}" data-action="unarm">
          <span>[0] Bo'sh qo'l</span>
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
