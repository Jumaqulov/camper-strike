import {
  CONTAINER_KIND_LABELS_UZ,
  LOOT_CATALOG,
  type ContainerStatus,
  type LootItemKind,
  type PublicContainerState,
  type PublicLootItem,
} from '../../../shared/loot';
import type { ContainerKind } from '../../../shared/world';

export interface LootUICallbacks {
  onOpenContainer: (containerId: string) => void;
  onPickupItem: (containerId: string | null, itemId: string) => void;
  onClosePanel?: () => void;
}

export interface TargetContainerPrompt {
  container: PublicContainerState;
  canInteract: boolean;
  distanceM: number;
  blockedReasonUz?: string;
}

export interface LootUIDiagnostics {
  promptVisible: boolean;
  promptText: string;
  activeContainerId: string | null;
  activeContainerStatus: ContainerStatus | null;
  visibleItemIds: string[];
  pendingItemIds: string[];
  statusText: string;
  statusKind: string;
}

export type LootStatusKind = 'info' | 'success' | 'error' | 'loading';

const STYLE_ELEMENT_ID = 'stage06-loot-ui-styles';

const CONTAINER_KIND_ICONS: Record<ContainerKind, string> = {
  supply_crate: '📦',
  weapon_locker: '🗄️',
  ammo_box: '🧰',
  camp_chest: '🧳',
};

const ITEM_KIND_ICONS: Record<LootItemKind, string> = {
  weapon: '🔫',
  ammo: '🟨',
  medkit: '🩹',
  grenade: '💣',
};

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

function injectLootUIStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    #stage06-loot-ui-root {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 12;
      font-family: 'Segoe UI', 'Roboto', system-ui, sans-serif;
      user-select: none;
    }

    /* Interaction Prompt */
    #stage06-loot-prompt {
      position: absolute;
      bottom: 165px;
      left: 50%;
      transform: translateX(-50%);
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      border-radius: 10px;
      background: rgba(18, 24, 20, 0.9);
      border: 1.5px solid rgba(255, 198, 76, 0.72);
      color: #fff8e7;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.3px;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.55);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
      white-space: nowrap;
      transition: opacity 0.14s ease, transform 0.14s ease;
    }

    #stage06-loot-prompt.blocked {
      background: rgba(44, 18, 18, 0.9);
      border-color: rgba(255, 96, 96, 0.78);
      color: #ffd6d6;
    }

    #stage06-loot-prompt.empty {
      background: rgba(24, 28, 34, 0.86);
      border-color: rgba(168, 179, 194, 0.45);
      color: #b7c2d0;
    }

    #stage06-loot-prompt .key-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 22px;
      padding: 0 6px;
      border-radius: 5px;
      background: linear-gradient(180deg, #ffce54, #e58e08);
      color: #1c1300;
      font-weight: 900;
      font-size: 12px;
      text-shadow: none;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
    }

    /* Open Container Loot Panel */
    #stage06-container-panel {
      position: absolute;
      bottom: 215px;
      left: 50%;
      transform: translateX(-50%);
      width: min(410px, 90vw);
      background: rgba(16, 22, 18, 0.92);
      border: 2px solid rgba(255, 196, 68, 0.68);
      border-radius: 14px;
      padding: 12px 14px;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(8px);
      pointer-events: auto;
      color: #f4f6f9;
    }

    #stage06-container-panel.is-empty {
      border-color: rgba(148, 163, 184, 0.45);
    }

    .s06-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding-bottom: 8px;
      margin-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }

    .s06-panel-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .s06-panel-icon {
      font-size: 19px;
      line-height: 1;
    }

    .s06-panel-title {
      font-size: 15px;
      font-weight: 800;
      letter-spacing: 0.4px;
      color: #fff6e0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .s06-panel-badges {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .s06-status-badge {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.8px;
      padding: 3px 8px;
      border-radius: 999px;
      text-transform: uppercase;
    }

    .s06-status-badge.open {
      background: rgba(46, 204, 113, 0.22);
      color: #69f0ae;
      border: 1px solid rgba(105, 240, 174, 0.45);
    }

    .s06-status-badge.empty {
      background: rgba(148, 163, 184, 0.18);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.35);
    }

    .s06-panel-body {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 210px;
      overflow-y: auto;
    }

    .s06-empty-msg {
      padding: 14px 10px;
      text-align: center;
      font-size: 13px;
      font-weight: 600;
      color: #9aa6b8;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
      border: 1px dashed rgba(255, 255, 255, 0.1);
    }

    .s06-loot-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 7px 10px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease;
    }

    .s06-loot-row:hover {
      background: rgba(255, 196, 68, 0.14);
      border-color: rgba(255, 196, 68, 0.62);
    }

    .s06-loot-row:active {
      transform: scale(0.99);
    }

    .s06-loot-row.primary-pick {
      background: rgba(255, 188, 44, 0.12);
      border-color: rgba(255, 198, 76, 0.52);
    }

    .s06-loot-row.is-pending {
      opacity: 0.62;
      cursor: wait;
    }

    .s06-item-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }

    .s06-slot-badge {
      font-size: 11px;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.12);
      color: #ffd56b;
      flex-shrink: 0;
    }

    .s06-item-icon {
      font-size: 18px;
      line-height: 1;
      flex-shrink: 0;
    }

    .s06-item-info {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .s06-item-name {
      font-size: 14px;
      font-weight: 800;
      color: #f8fafc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .s06-item-meta {
      font-size: 11px;
      font-weight: 600;
      color: #b4c0cf;
    }

    .s06-pickup-btn {
      border: none;
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.4px;
      cursor: pointer;
      background: linear-gradient(180deg, #ffca47, #e48a07);
      color: #1b1200;
      flex-shrink: 0;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
    }

    .s06-pickup-btn:hover {
      filter: brightness(1.08);
    }

    .s06-pickup-btn:disabled {
      background: rgba(148, 163, 184, 0.28);
      color: #cbd5e1;
      cursor: wait;
    }

    /* Status / Error Banner */
    #stage06-loot-toast {
      position: absolute;
      top: 82px;
      left: 50%;
      transform: translateX(-50%);
      padding: 7px 16px;
      border-radius: 9px;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.3px;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.5);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
      white-space: nowrap;
      transition: opacity 0.18s ease, transform 0.18s ease;
    }

    #stage06-loot-toast.kind-info {
      background: rgba(20, 34, 48, 0.92);
      border: 1.5px solid rgba(96, 165, 250, 0.75);
      color: #dbeafe;
    }

    #stage06-loot-toast.kind-success {
      background: rgba(18, 44, 28, 0.92);
      border: 1.5px solid rgba(74, 222, 128, 0.8);
      color: #dcfce7;
    }

    #stage06-loot-toast.kind-error {
      background: rgba(54, 18, 22, 0.94);
      border: 1.5px solid rgba(248, 113, 113, 0.85);
      color: #fee2e2;
    }

    #stage06-loot-toast.kind-loading {
      background: rgba(44, 34, 14, 0.92);
      border: 1.5px solid rgba(251, 191, 36, 0.8);
      color: #fef3c7;
    }
  `;
  document.head.appendChild(style);
}

export class LootUI {
  private readonly callbacks: LootUICallbacks;
  private rootEl: HTMLElement | null = null;
  private promptEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;
  private toastEl: HTMLElement | null = null;

  private currentPrompt: TargetContainerPrompt | null = null;
  private promptText = '';
  private activeContainer: PublicContainerState | null = null;
  private readonly pendingItemIds = new Set<string>();

  private statusText = '';
  private statusKind: LootStatusKind | '' = '';
  private statusTimer = 0;

  private lastPromptRenderKey = '';
  private lastPanelRenderKey = '';

  constructor(callbacks: LootUICallbacks) {
    this.callbacks = callbacks;
    injectLootUIStyles();
    this.mountDom();
  }

  private mountDom(): void {
    if (typeof document === 'undefined') return;

    const existing = document.getElementById('stage06-loot-ui-root');
    if (existing) existing.remove();

    const host = document.getElementById('hud') ?? document.body;
    const root = document.createElement('div');
    root.id = 'stage06-loot-ui-root';

    const prompt = document.createElement('div');
    prompt.id = 'stage06-loot-prompt';
    prompt.className = 'hidden';

    const panel = document.createElement('div');
    panel.id = 'stage06-container-panel';
    panel.className = 'hidden';

    const toast = document.createElement('div');
    toast.id = 'stage06-loot-toast';
    toast.className = 'hidden';

    root.appendChild(prompt);
    root.appendChild(panel);
    root.appendChild(toast);
    host.appendChild(root);

    this.rootEl = root;
    this.promptEl = prompt;
    this.panelEl = panel;
    this.toastEl = toast;
  }

  setTargetPrompt(prompt: TargetContainerPrompt | null): void {
    this.currentPrompt = prompt;
    this.renderPrompt();
  }

  setActiveContainer(container: PublicContainerState | null): void {
    if (!container || !container.opened) {
      this.activeContainer = null;
      this.pendingItemIds.clear();
    } else {
      this.activeContainer = container;
      const presentIds = new Set(container.items.map((item) => item.id));
      for (const pendingId of Array.from(this.pendingItemIds)) {
        if (!presentIds.has(pendingId)) {
          this.pendingItemIds.delete(pendingId);
        }
      }
    }
    this.renderPanel();
  }

  getActiveContainerId(): string | null {
    return this.activeContainer ? this.activeContainer.id : null;
  }

  markItemPending(itemId: string, pending: boolean): void {
    if (pending) {
      this.pendingItemIds.add(itemId);
    } else {
      this.pendingItemIds.delete(itemId);
    }
    this.renderPanel();
  }

  clearPendingItems(): void {
    if (this.pendingItemIds.size === 0) return;
    this.pendingItemIds.clear();
    this.renderPanel();
  }

  showStatus(textUz: string, kind: LootStatusKind = 'info', durationMs = 2600): void {
    this.statusText = textUz;
    this.statusKind = kind;

    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = 0;
    }

    if (this.toastEl) {
      this.toastEl.textContent = textUz;
      this.toastEl.className = `kind-${kind}`;
    }

    if (durationMs > 0 && typeof window !== 'undefined') {
      this.statusTimer = window.setTimeout(() => {
        this.statusTimer = 0;
        this.statusText = '';
        this.statusKind = '';
        if (this.toastEl) {
          this.toastEl.className = 'hidden';
          this.toastEl.textContent = '';
        }
      }, durationMs);
    }
  }

  triggerPrimaryInteract(): boolean {
    if (this.currentPrompt?.canInteract) {
      const targetContainer = this.currentPrompt.container;
      if (!targetContainer.opened) {
        this.callbacks.onOpenContainer(targetContainer.id);
        return true;
      }
      if (this.activeContainer && this.activeContainer.items.length > 0) {
        const firstAvailable = this.activeContainer.items.find(
          (item) => !this.pendingItemIds.has(item.id),
        );
        if (firstAvailable) {
          this.callbacks.onPickupItem(this.activeContainer.id, firstAvailable.id);
          return true;
        }
      } else if (targetContainer.items.length > 0) {
        const firstAvailable = targetContainer.items.find(
          (item) => !this.pendingItemIds.has(item.id),
        );
        if (firstAvailable) {
          this.callbacks.onPickupItem(targetContainer.id, firstAvailable.id);
          return true;
        }
      }
    } else if (this.activeContainer && this.activeContainer.items.length > 0) {
      const firstAvailable = this.activeContainer.items.find(
        (item) => !this.pendingItemIds.has(item.id),
      );
      if (firstAvailable) {
        this.callbacks.onPickupItem(this.activeContainer.id, firstAvailable.id);
        return true;
      }
    }

    return false;
  }

  triggerSlotPickup(slotIndex: number): boolean {
    if (!this.activeContainer || !this.activeContainer.opened) return false;
    if (slotIndex < 0 || slotIndex >= this.activeContainer.items.length) return false;
    const item = this.activeContainer.items[slotIndex];
    if (!item || this.pendingItemIds.has(item.id)) return false;
    this.callbacks.onPickupItem(this.activeContainer.id, item.id);
    return true;
  }

  getDiagnostics(): LootUIDiagnostics {
    return {
      promptVisible: this.currentPrompt !== null,
      promptText: this.promptText,
      activeContainerId: this.activeContainer ? this.activeContainer.id : null,
      activeContainerStatus: this.activeContainer ? this.activeContainer.status : null,
      visibleItemIds: this.activeContainer ? this.activeContainer.items.map((i) => i.id) : [],
      pendingItemIds: Array.from(this.pendingItemIds),
      statusText: this.statusText,
      statusKind: this.statusKind,
    };
  }

  reset(): void {
    this.currentPrompt = null;
    this.promptText = '';
    this.activeContainer = null;
    this.pendingItemIds.clear();
    this.statusText = '';
    this.statusKind = '';
    this.lastPromptRenderKey = '';
    this.lastPanelRenderKey = '';

    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = 0;
    }

    if (this.promptEl) {
      this.promptEl.className = 'hidden';
      this.promptEl.innerHTML = '';
    }
    if (this.panelEl) {
      this.panelEl.className = 'hidden';
      this.panelEl.innerHTML = '';
    }
    if (this.toastEl) {
      this.toastEl.className = 'hidden';
      this.toastEl.textContent = '';
    }
  }

  dispose(): void {
    this.reset();
    if (this.rootEl) {
      this.rootEl.remove();
      this.rootEl = null;
    }
    this.promptEl = null;
    this.panelEl = null;
    this.toastEl = null;
  }

  private renderPrompt(): void {
    const p = this.currentPrompt;
    if (!p) {
      this.promptText = '';
      this.lastPromptRenderKey = '';
      if (this.promptEl) {
        this.promptEl.className = 'hidden';
        this.promptEl.innerHTML = '';
      }
      return;
    }

    const label = p.container.labelUz || CONTAINER_KIND_LABELS_UZ[p.container.kind] || 'Konteyner';
    let plainText = '';
    let html = '';
    let variantClass = '';

    if (!p.canInteract) {
      const reason = p.blockedReasonUz ?? "Masofa uzoq yoki to'siq bor";
      plainText = `⚠ ${label} — ${reason}`;
      html = `<span>⚠ ${escapeHtml(label)} — ${escapeHtml(reason)}</span>`;
      variantClass = 'blocked';
    } else if (!p.container.opened) {
      const distStr = p.distanceM.toFixed(1);
      plainText = `[E] ${label} — Ochish (${distStr} m)`;
      html = `<span class="key-pill">E</span><span>${escapeHtml(label)} — Ochish (${distStr} m)</span>`;
    } else if (p.container.items.length > 0) {
      const count = p.container.items.length;
      plainText = `[E] ${label} — Buyumni olish (${count} ta)`;
      html = `<span class="key-pill">E</span><span>${escapeHtml(label)} — Buyumni olish (${count} ta)</span>`;
    } else {
      plainText = `📦 ${label} — Bo'sh`;
      html = `<span>📦 ${escapeHtml(label)} — Bo'sh</span>`;
      variantClass = 'empty';
    }

    this.promptText = plainText;

    const renderKey = `${variantClass}|${plainText}`;
    if (renderKey === this.lastPromptRenderKey) return;
    this.lastPromptRenderKey = renderKey;

    if (this.promptEl) {
      this.promptEl.className = variantClass;
      this.promptEl.innerHTML = html;
    }
  }

  private formatItemMeta(item: PublicLootItem): string {
    const entry = LOOT_CATALOG[item.catalogId];
    if (item.kind === 'weapon') {
      const mag = item.initialMag ?? 0;
      const res = item.initialReserve ?? 0;
      return `Qurol · ${mag}/${res} o'q`;
    }
    if (item.kind === 'ammo') {
      return `O'q-dori · +${item.quantity} dona`;
    }
    if (item.kind === 'medkit') {
      const heal = entry?.healAmount ?? 45;
      return `Davolash · +${heal} HP (×${item.quantity})`;
    }
    if (item.kind === 'grenade') {
      return `Portlovchi · ×${item.quantity}`;
    }
    return `×${item.quantity}`;
  }

  private renderPanel(): void {
    const c = this.activeContainer;
    if (!c || !c.opened) {
      this.lastPanelRenderKey = '';
      if (this.panelEl) {
        this.panelEl.className = 'hidden';
        this.panelEl.innerHTML = '';
      }
      return;
    }

    const pendingKey = Array.from(this.pendingItemIds).sort().join(',');
    const itemsKey = c.items.map((i) => `${i.id}:${i.quantity}`).join(';');
    const renderKey = `${c.id}|${c.version}|${c.status}|${itemsKey}|${pendingKey}`;
    if (renderKey === this.lastPanelRenderKey) return;
    this.lastPanelRenderKey = renderKey;

    if (!this.panelEl) return;

    const isEmpty = c.items.length === 0;
    const icon = CONTAINER_KIND_ICONS[c.kind] ?? '📦';
    const label = c.labelUz || CONTAINER_KIND_LABELS_UZ[c.kind] || 'Konteyner';
    const badgeClass = isEmpty ? 'empty' : 'open';
    const badgeText = isEmpty ? "BO'SH" : 'OCHIQ';

    const firstAvailableIndex = c.items.findIndex((item) => !this.pendingItemIds.has(item.id));

    let bodyHtml = '';
    if (isEmpty) {
      bodyHtml = `<div class="s06-empty-msg">Bu konteyner bo'sh — barcha buyumlar olingan</div>`;
    } else {
      bodyHtml = c.items
        .map((item, idx) => {
          const isPending = this.pendingItemIds.has(item.id);
          const isPrimary = idx === firstAvailableIndex;
          const itemIcon = ITEM_KIND_ICONS[item.kind] ?? '📦';
          const slotBadge = isPrimary ? `[E] / [${idx + 1}]` : `[${idx + 1}]`;
          const btnLabel = isPending
            ? 'Olinmoqda...'
            : isPrimary
              ? 'OLISH [E]'
              : `OLISH [${idx + 1}]`;
          const metaText = this.formatItemMeta(item);

          return `
            <div class="s06-loot-row ${isPrimary ? 'primary-pick' : ''} ${isPending ? 'is-pending' : ''}" data-item-id="${escapeHtml(item.id)}">
              <div class="s06-item-left">
                <span class="s06-slot-badge">${slotBadge}</span>
                <span class="s06-item-icon">${itemIcon}</span>
                <div class="s06-item-info">
                  <div class="s06-item-name">${escapeHtml(item.nameUz)}</div>
                  <div class="s06-item-meta">${escapeHtml(metaText)}</div>
                </div>
              </div>
              <button type="button" class="s06-pickup-btn" data-item-id="${escapeHtml(item.id)}" ${isPending ? 'disabled' : ''}>
                ${btnLabel}
              </button>
            </div>
          `;
        })
        .join('');
    }

    this.panelEl.className = isEmpty ? 'is-empty' : '';
    this.panelEl.innerHTML = `
      <div class="s06-panel-header">
        <div class="s06-panel-title-wrap">
          <span class="s06-panel-icon">${icon}</span>
          <span class="s06-panel-title">${escapeHtml(label)}</span>
        </div>
        <div class="s06-panel-badges">
          <span class="s06-status-badge ${badgeClass}">${badgeText}</span>
        </div>
      </div>
      <div class="s06-panel-body">
        ${bodyHtml}
      </div>
    `;

    const rows = this.panelEl.querySelectorAll<HTMLElement>('.s06-loot-row');
    rows.forEach((row) => {
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const itemId = row.getAttribute('data-item-id');
        if (!itemId || !this.activeContainer || this.pendingItemIds.has(itemId)) return;
        this.callbacks.onPickupItem(this.activeContainer.id, itemId);
      });
    });
  }
}
