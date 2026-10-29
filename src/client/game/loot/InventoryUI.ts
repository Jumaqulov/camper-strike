import {
  MAX_FLARES_PER_PLAYER,
  MAX_GRENADES_LOOT_MODE,
  MAX_MEDKITS_PER_PLAYER,
  type PlayerInventorySnap,
} from '../../../shared/loot';
import { KNIFE, KNIFE_SLOT_KEY, WEAPONS, WEAPON_SLOTS, type WeaponId } from '../../../shared/weapons';
import { TORCH_WEAPON_MESSAGE_UZ, WOOD_CARRY_MAX, isTorchWeapon } from '../../../shared/wolf/camp';
import { FLARE_DURATION_SEC } from '../../../shared/wolf/flare';
import { weaponIconHtml } from '../Hud';
import { onWeaponAssetsReady } from '../WeaponAssetRegistry';

export interface InventoryUICallbacks {
  onSelectWeapon: (weapon: WeaponId | null) => void;
  onUseMedkit: () => void;
  /** wolf_night: signal raketasini otish (chip bosilganda; [X] tugmasi Game da). */
  onUseFlare?: () => void;
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
  /** "Tong otguncha": qo'ldagi o'tin soni (null — boshqa rejimlar, chip ko'rsatilmaydi). */
  private wood: number | null = null;
  /** "Tong otguncha": mash'al qo'lda — faqat pichoq/to'pponcha slotlari ochiq. */
  private torch = false;

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

  /** O'tin chipi: `null` — yashirin (tun rejimi emas), aks holda "🪵 n/3". */
  setWood(wood: number | null): void {
    if (this.wood === wood) return;
    this.wood = wood;
    this.render();
  }

  /**
   * "Og'ir yuk" ishorasi: to'la qo'l o'tin bilan Shift bosilganda o'tin chipi qisqa pulsatsiya qiladi
   * (CSS 'heavy' klassi; DOM qayta chizilmaydi).
   */
  pulseWoodHeavy(): void {
    const chip = this.stripEl?.querySelector('.wood-chip');
    if (!chip) return;
    chip.classList.remove('heavy');
    // Klassni qayta qo'shish animatsiyani qaytadan boshlaydi
    void (chip as HTMLElement).offsetWidth;
    chip.classList.add('heavy');
  }

  /** wolf_night: mash'al qo'lda — avtomat/drobovik/snayper slotlari kulrang ('blocked'), 1–4 bosilsa toast. */
  setTorch(on: boolean): void {
    if (this.torch === on) return;
    this.torch = on;
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
    this.wood = null;
    this.torch = false;
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
    const flares = s.flares ?? 0;
    const renderKey = `${s.inventoryVersion}|${s.equippedWeapon ?? 'none'}|${s.ownedWeapons.join(',')}|${s.medkits}/${s.maxMedkits}|${s.grenades}/${s.maxGrenades}|${s.armor ?? 0}|${s.helmet ?? 0}|${ammoKey}|w${this.wood ?? '-'}|t${this.torch ? 1 : 0}|f${flares}`;
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

    // Ixcham yog'och taxtacha: [tugma raqami + ikonka] ustida, [nom + o'q] ostida; matnli holatlar tooltip'da.
    // Mash'al qo'lda bo'lsa pichoq/to'pponchadan boshqa qurollar 'blocked' (kulrang) — tanlash serverda ham rad etiladi.
    const torch = this.torch;
    const slotHtml = (w: WeaponId, key: number, owned: boolean, equipped: boolean, ammoText: string, tip: string) => {
      const blocked = torch && !isTorchWeapon(w);
      return `
        <button type="button" class="s06-inv-slot ${equipped ? 'owned equipped' : owned ? 'owned' : 'locked'}${blocked ? ' blocked' : ''}"
          data-weapon="${escapeHtml(w)}" ${!owned ? 'disabled' : ''} title="${escapeHtml(blocked ? `${WEAPONS[w].name} — ${TORCH_WEAPON_MESSAGE_UZ}` : tip)}">
          <span class="s06-slot-top"><span class="s06-slot-key">${key}</span><span class="s06-slot-icon">${weaponIconHtml(w)}</span></span>
          <span class="s06-slot-bottom"><span class="s06-slot-name">${escapeHtml(WEAPONS[w].name)}</span><span class="s06-slot-ammo">${escapeHtml(ammoText)}</span></span>
        </button>`;
    };

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
    const wood = this.wood;
    const woodHtml =
      wood === null
        ? ''
        : `<div class="s06-util-btn wood-chip ${wood > 0 ? 'has-item' : 'empty'}" title="O'tin: g'aramdan [E] bilan oling, gulxanga [E] bilan tashlang (${wood}/${WOOD_CARRY_MAX})">
          <span class="s06-util-icon">🪵</span><span class="s06-util-count">${wood}/${WOOD_CARRY_MAX}</span>
        </div>`;
    // Signal raketasi chipi (faqat tun rejimida yoki raketa bo'lsa): [X] bilan otiladi
    const maxFlares = s.maxFlares ?? MAX_FLARES_PER_PLAYER;
    const flareHtml =
      wood === null && flares <= 0
        ? ''
        : `<button type="button" class="s06-util-btn flare-btn ${flares > 0 ? 'has-item' : 'empty'}" data-action="flare"
          title="Signal raketasi [X]: ${FLARE_DURATION_SEC} s davomida hamma bo'rilarni qo'rqitadi — qochadi, tishlamaydi (${flares}/${maxFlares})">
          <span class="s06-util-icon">🎇</span><span class="s06-util-count">${flares}</span><span class="s06-util-key">X</span>
        </button>`;

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
        ${woodHtml}
        ${flareHtml}
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

    const flareBtn = this.stripEl.querySelector<HTMLButtonElement>('[data-action="flare"]');
    if (flareBtn) {
      flareBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.callbacks.onUseFlare?.();
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
