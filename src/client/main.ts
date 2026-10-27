import './style.css';
import { io } from 'socket.io-client';
import type { CreateRoomOpts, ReadyAck, RoomInfo, WelcomeMsg } from '../shared/protocol';
import { validateWorldCompatibility, type MapId } from '../shared/world';
import { AudioSys } from './game/Audio';
import { preloadBuildingAssets } from './game/buildings';
import { preloadContainerAssets } from './game/containers';
import { preloadForestAssets } from './game/ForestAssetRegistry';
import { Game } from './game/Game';
import { esc } from './game/Hud';
import { preloadInteriorAssets } from './game/interiors';
import { preloadGrassAssets } from './game/grass/GrassAssetRegistry';
import { preloadWeaponAssets } from './game/WeaponAssetRegistry';
import { loadSettings, saveSettings, type QualityLevel } from './settings';

const socket = io({ transports: ['websocket', 'polling'] });
const audio = new AudioSys();
const settings = loadSettings();

// Asynchronous asset preloads (no WebGL render loop or 3D canvas)
void preloadWeaponAssets();
void preloadForestAssets();
void preloadBuildingAssets();
void preloadInteriorAssets();
void preloadContainerAssets();
void preloadGrassAssets();

let game: Game | null = null;
let entered = false;
let toastTimer = 0;

// Helper: safe DOM lookups
function getEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function bindClick(id: string, handler: (e: MouseEvent) => void): void {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('click', handler);
  }
}

// ---------------- Toast xabarlari ----------------
function toast(msg: string, info = false): void {
  const t = getEl('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (info ? ' info' : '');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (t) t.className = info ? 'info' : '';
  }, 3000);
}

// ---------------- Ekranlar almashinuvi ----------------
function show(screen: 'menu' | 'lobby' | 'game'): void {
  const menu = getEl('screen-menu');
  const lobby = getEl('screen-lobby');
  const hud = getEl('hud');

  if (menu) menu.classList.toggle('hidden', screen !== 'menu');
  if (lobby) lobby.classList.toggle('hidden', screen !== 'lobby');
  if (hud) hud.classList.toggle('hidden', screen !== 'game');

  if (screen === 'game') {
    closeSettingsModal();
    closeNicknameModal();
  }
}

// ---------------- O'yinchi ismini sinxronlash ----------------
function getNicknameModalInput(): HTMLInputElement | null {
  return (
    getEl<HTMLInputElement>('modal-name-input') ||
    getEl<HTMLInputElement>('modal-nickname-input') ||
    getEl<HTMLInputElement>('input-edit-nickname') ||
    getEl<HTMLInputElement>('nickname-input')
  );
}

function syncPlayerName(name: string): void {
  const trimmed = (name || '').trim().slice(0, 16) || 'Sardor';
  settings.name = trimmed;
  settings.sensitivity = settings.sens;
  saveSettings(settings);

  // #name-input (asosiy menyu inputi)
  const nameInput = getEl<HTMLInputElement>('name-input');
  if (nameInput && document.activeElement !== nameInput) {
    nameInput.value = trimmed;
  }

  // #lobby-name (lobbi headeri)
  const lobbyName = getEl('lobby-name');
  if (lobbyName) lobbyName.textContent = trimmed;

  // #menu-player-name / #menu-profile-name (P1-D fix: index.html da menu-player-name mavjud)
  const menuProfile = getEl('menu-player-name') || getEl('menu-profile-name');
  if (menuProfile) menuProfile.textContent = trimmed;

  // Nickname tahrirlash modal inputi
  const modalInput = getNicknameModalInput();
  if (modalInput && document.activeElement !== modalInput) {
    modalInput.value = trimmed;
  }
}

// ---------------- Sozlamalar UI sinxronlash ----------------
function syncSettingsUI(): void {
  // Sezgirlik: 0.1 .. 4.0
  const sensStr = settings.sens.toFixed(2);
  const sensInputs = [
    getEl<HTMLInputElement>('menu-set-sens'),
    getEl<HTMLInputElement>('set-sens'),
  ];
  sensInputs.forEach((el) => {
    if (el) el.value = String(settings.sens);
  });
  const sensLabels = [getEl('menu-val-sens'), getEl('val-sens')];
  sensLabels.forEach((el) => {
    if (el) el.textContent = sensStr;
  });

  // Ovoz: 0.0 .. 1.0 (foiz 0 .. 100)
  const volPct = String(Math.round(settings.volume * 100));
  const volInputs = [
    getEl<HTMLInputElement>('menu-set-vol'),
    getEl<HTMLInputElement>('set-vol'),
  ];
  volInputs.forEach((el) => {
    if (el) el.value = String(settings.volume);
  });
  const volLabels = [getEl('menu-val-vol'), getEl('val-vol')];
  volLabels.forEach((el) => {
    if (el) el.textContent = volPct;
  });

  // FOV: 60 .. 110
  const fovStr = String(Math.round(settings.fov));
  const fovInputs = [
    getEl<HTMLInputElement>('menu-set-fov'),
    getEl<HTMLInputElement>('set-fov'),
  ];
  fovInputs.forEach((el) => {
    if (el) el.value = String(settings.fov);
  });
  const fovLabels = [getEl('menu-val-fov'), getEl('val-fov')];
  fovLabels.forEach((el) => {
    if (el) el.textContent = fovStr;
  });

  // Sifat: low | medium | high
  const qualitySelects = [
    getEl<HTMLSelectElement>('menu-set-quality'),
    getEl<HTMLSelectElement>('set-quality'),
  ];
  qualitySelects.forEach((el) => {
    if (el) el.value = settings.quality;
  });
}

// ---------------- Sozlamalar modali ----------------
function openSettingsModal(): void {
  audio.ui();
  syncSettingsUI();
  const modal = getEl('modal-settings');
  if (modal) {
    modal.classList.remove('hidden');
  }
}

function closeSettingsModal(): void {
  audio.ui();
  const modal = getEl('modal-settings');
  if (modal) {
    modal.classList.add('hidden');
  }
}

// ---------------- Nickname modali ----------------
function openNicknameModal(): void {
  audio.ui();
  const modal = getEl('modal-nickname');
  if (modal) {
    modal.classList.remove('hidden');
    const input = getNicknameModalInput();
    if (input) {
      input.value = settings.name;
      input.focus();
      input.select();
    }
  } else {
    // Agar modal bo'lmasa, menyu ekranidagi ism maydoniga qaytish
    show('menu');
    const nameInput = getEl<HTMLInputElement>('name-input');
    if (nameInput) {
      nameInput.value = settings.name;
      nameInput.focus();
      nameInput.select();
    }
  }
}

function closeNicknameModal(): void {
  audio.ui();
  const modal = getEl('modal-nickname');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function saveNickname(): void {
  const input = getNicknameModalInput();
  const raw = input ? input.value.trim() : '';
  const val = raw.length > 0 ? raw.slice(0, 16) : 'Sardor';

  syncPlayerName(val);
  closeNicknameModal();
  toast(`Ism saqlandi: ${settings.name}`, true);

  if (socket.connected) {
    socket.emit('hello', { name: settings.name }, (res: { ok: boolean; name: string; rooms: RoomInfo[] }) => {
      if (res?.name) syncPlayerName(res.name);
      if (res?.rooms) renderRooms(res.rooms);
    });
  }
}

// ---------------- Asosiy menyu & Kirish ----------------
function enter(): void {
  const nameInput = getEl<HTMLInputElement>('name-input');
  const inputVal = nameInput ? nameInput.value.trim() : '';
  const finalName = inputVal || settings.name || 'Sardor';

  syncPlayerName(finalName);
  audio.init();
  audio.ui();
  hello();
}

function hello(): void {
  if (!socket.connected) {
    toast("Server bilan aloqa yo'q. Kuting...");
    return;
  }
  socket.emit('hello', { name: settings.name }, (res: { ok: boolean; name: string; rooms: RoomInfo[] }) => {
    entered = true;
    syncPlayerName(res.name);
    renderRooms(res.rooms);
    show('lobby');
  });
}

// ---------------- Quick Play (P2-E Forest Survival) ----------------
function quickPlay(): void {
  const nameInput = getEl<HTMLInputElement>('name-input');
  const inputVal = nameInput ? nameInput.value.trim() : '';
  const finalName = inputVal || settings.name || 'Sardor';

  syncPlayerName(finalName);
  audio.init();
  audio.ui();

  if (!socket.connected) {
    toast("Server bilan aloqa yo'q. Kuting...");
    return;
  }

  socket.emit('hello', { name: settings.name }, (res: { ok: boolean; name: string; rooms: RoomInfo[] }) => {
    entered = true;
    syncPlayerName(res.name);
    renderRooms(res.rooms);

    const openRoom = res.rooms?.find(
      (r) =>
        r.mode === 'forest_survival' &&
        ((r as any).playerCount !== undefined ? (r as any).playerCount : r.players) < r.maxPlayers,
    );

    if (openRoom) {
      toast(`Forest Survival xonasiga ulanmoqda: ${openRoom.name}...`, true);
      joinRoom(openRoom.id);
    } else {
      toast("Yangi Forest Survival xonasi ochilmoqda...", true);
      const opts: CreateRoomOpts = {
        name: `${settings.name} o'rmoni`,
        mode: 'forest_survival',
        bots: 3, // tezkor start: yolg'iz o'yinchi ham loot AI botlari bilan o'ynay oladi
        maxPlayers: 10,
        timeLimit: 15,
        scoreLimit: 1,
        mapId: 'forest_square',
        lootPreview: true,
      };
      socket.emit('createRoom', opts, (cRes: { ok: boolean; roomId?: string; error?: string }) => {
        if (cRes.ok && cRes.roomId) {
          joinRoom(cRes.roomId);
        } else {
          show('lobby');
          toast(cRes.error ?? "Xona ochib bo'lmadi, lobbiga o'tildi");
        }
      });
    }
  });
}

// ---------------- Server ulanish holati ----------------
function updateConnStatus(status: 'connecting' | 'connected' | 'disconnected' | 'error'): void {
  const elements = document.querySelectorAll('#conn-status, .conn-status');
  elements.forEach((el) => {
    if (status === 'connected') {
      el.textContent = 'Serverga ulandi ✓';
      el.className = 'conn ok';
    } else if (status === 'disconnected') {
      el.textContent = 'Server bilan aloqa uzildi. Qayta ulanmoqda...';
      el.className = 'conn bad';
    } else if (status === 'error') {
      el.textContent = "Serverga ulanib bo'lmadi. Server ishga tushirilganini tekshiring.";
      el.className = 'conn bad';
    } else {
      el.textContent = 'Serverga ulanmoqda...';
      el.className = 'conn';
    }
  });
}

socket.on('connect', () => {
  updateConnStatus('connected');
  if (entered && !game) hello();
});

socket.on('disconnect', () => {
  updateConnStatus('disconnected');
  if (game) {
    game.destroy();
    game = null;
    const gameRoot = getEl('game-root');
    if (gameRoot) gameRoot.innerHTML = '';
    show(entered ? 'lobby' : 'menu');
    toast('Server bilan aloqa uzildi');
  }
});

socket.on('connect_error', () => {
  updateConnStatus('error');
});

// ---------------- Rejim tanlash & Sinxronizatsiya ----------------
function applyModeSelection(mode: string): void {
  const modeSel = getEl<HTMLSelectElement>('room-mode');
  if (modeSel && modeSel.value !== mode) {
    modeSel.value = mode;
  }

  // data-mode bo'yicha kartochkalarning active holati
  document.querySelectorAll('[data-mode]').forEach((el) => {
    const cardMode = el.getAttribute('data-mode');
    const isSelected = cardMode === mode;
    el.classList.toggle('active', isSelected);
    el.classList.toggle('selected', isSelected);
  });

  const mapSel = getEl<HTMLSelectElement>('room-map');
  const botsInput = getEl<HTMLInputElement>('room-bots');
  const scoreInput = getEl<HTMLInputElement>('room-score');
  const lootPreviewChk = getEl<HTMLInputElement>('room-loot-preview');

  if (mode === 'forest_survival') {
    if (mapSel) mapSel.value = 'forest_square';
    if (botsInput) {
      // Survival'da botlar loot AI bilan qatnashadi (0–8)
      botsInput.disabled = false;
      botsInput.max = '8';
      if (Number(botsInput.value) > 8 || Number(botsInput.value) === 0) botsInput.value = '3';
    }
    if (scoreInput) {
      scoreInput.value = '1';
      scoreInput.disabled = true;
    }
    if (lootPreviewChk) {
      lootPreviewChk.checked = true;
      lootPreviewChk.disabled = true;
    }
  } else {
    if (scoreInput) {
      scoreInput.disabled = false;
      scoreInput.value = mode === 'tdm' ? '50' : '25';
    }
    if (lootPreviewChk) {
      lootPreviewChk.disabled = false;
      lootPreviewChk.checked = false;
    }
    if (botsInput) {
      botsInput.disabled = false;
      botsInput.max = '16';
      if (Number(botsInput.value) === 0) {
        botsInput.value = '4';
      }
    }
  }
}

// ---------------- Xonalar & Lobby ----------------
function renderRooms(rooms: RoomInfo[]): void {
  const list = getEl('room-list');
  if (!list) return;
  if (!rooms.length) {
    list.innerHTML = `<div class="room-empty">Hozircha xonalar yo'q.<br/>O'ng tomondan yangi xona yarating!</div>`;
    return;
  }
  list.innerHTML = rooms
    .map((r) => {
      const mapLabel =
        r.world?.mapId === 'forest_square'
          ? '🌲 Forest Square (256×256, 6 POI)'
          : r.world?.mapId === 'forest_assets_preview'
            ? '🏚️ Forest Assets Preview (04A)'
            : r.world?.mapId === 'forest_sample'
              ? "🌲 Forest Preview (96×96)"
              : '🚐 Dust Arena';
      const lootBadge =
        r.mode === 'forest_survival'
          ? ` · <b style="color:#4ade80;">🌲 Oxirgi tirik qolgan · Qurolsiz boshlash</b>`
          : r.lootPreview
            ? ` · <b style="color:#fbbf24;">📦 Qurolsiz boshlash + Loot sinovi</b>`
            : '';
      const modeBadgeLabel =
        r.mode === 'forest_survival'
          ? 'SURVIVAL'
          : r.mode === 'tdm'
            ? 'JAMOAVIY'
            : 'FFA';
      return `
      <div class="room-item">
        <span class="r-mode ${r.mode}">${modeBadgeLabel}</span>
        <div class="r-main">
          <div class="r-name">${esc(r.name)}</div>
          <div class="r-meta">${mapLabel}${lootBadge} · 👤 ${r.players}/${r.maxPlayers} o'yinchi · 🤖 ${r.bots} bot · ⏱ ${r.timeLimit} daq · 🎯 ${r.mode === 'forest_survival' ? '1 tirik' : r.scoreLimit}</div>
        </div>
        <button class="btn primary" data-join="${r.id}" ${r.players >= r.maxPlayers ? 'disabled' : ''}>KIRISH</button>
      </div>`;
    })
    .join('');
}

function joinRoom(roomId: string): void {
  audio.init();
  socket.emit('joinRoom', { roomId }, (res: { ok: boolean; error?: string; welcome?: WelcomeMsg }) => {
    if (!res.ok || !res.welcome) return toast(res.error ?? "Xonaga kirib bo'lmadi");
    startGame(res.welcome);
  });
}

function startGame(welcome: WelcomeMsg): void {
  show('game');
  const gameRoot = getEl('game-root');
  if (!gameRoot) return;

  // WebGL 3D sahna faqat xonaga kirganda ishga tushiriladi
  game = new Game(gameRoot, socket, welcome, audio, settings, () => leaveGame());
  const clientWorld = game.getWorldMeta();
  const check = validateWorldCompatibility(welcome.world, clientWorld);
  if (!check.ok) {
    toast(check.reason ?? 'Xarita versiyasi server bilan mos kelmadi');
    leaveGame();
    return;
  }
  socket.emit('ready', { world: clientWorld }, (res?: ReadyAck) => {
    if (res && !res.ok) {
      toast(res.error ?? 'Xarita versiyasi server bilan mos kelmadi');
      leaveGame();
    }
  });
}

socket.on('worldMismatch', (payload: { error?: string }) => {
  toast(payload?.error ?? 'Xarita versiyasi server bilan mos kelmadi');
  if (game) leaveGame();
});

function leaveGame(): void {
  if (game) {
    game.destroy();
    game = null;
  }
  const gameRoot = getEl('game-root');
  if (gameRoot) {
    gameRoot.innerHTML = '';
  }
  socket.emit('leaveRoom');
  syncSettingsUI();
  show('lobby');
  socket.emit('listRooms', (rooms: RoomInfo[]) => renderRooms(rooms));
}

// ---------------- DOM Event Wire-up ----------------
function initEvents(): void {
  // Asosiy menyu: O'ynash / Kirish / Quick Play
  bindClick('btn-enter', () => enter());
  bindClick('btn-play', () => enter());
  bindClick('btn-menu-play', () => enter());
  bindClick('btn-quick-play', () => quickPlay());

  const nameInput = getEl<HTMLInputElement>('name-input');
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enter();
  });
  nameInput?.addEventListener('input', () => {
    const raw = nameInput.value;
    const trimmed = raw.trim().slice(0, 16);
    if (trimmed) {
      settings.name = trimmed;
      settings.sensitivity = settings.sens;
      saveSettings(settings);
      const lobbyName = getEl('lobby-name');
      if (lobbyName) lobbyName.textContent = trimmed;
      const menuProfile = getEl('menu-player-name') || getEl('menu-profile-name');
      if (menuProfile) menuProfile.textContent = trimmed;
      const modalInput = getNicknameModalInput();
      if (modalInput && document.activeElement !== modalInput) {
        modalInput.value = trimmed;
      }
    }
  });
  nameInput?.addEventListener('change', () => {
    syncPlayerName(nameInput.value);
    if (socket.connected) {
      socket.emit('hello', { name: settings.name }, (res: { ok: boolean; name: string; rooms: RoomInfo[] }) => {
        if (res?.name) syncPlayerName(res.name);
        if (res?.rooms) renderRooms(res.rooms);
      });
    }
  });
  nameInput?.addEventListener('blur', () => {
    syncPlayerName(nameInput.value);
  });

  // Navigatsiya: Xonalar / Lobbi
  bindClick('btn-open-rooms', () => {
    audio.init();
    audio.ui();
    if (entered && socket.connected) {
      show('lobby');
      socket.emit('listRooms', (rooms: RoomInfo[]) => renderRooms(rooms));
    } else {
      hello();
    }
  });

  bindClick('btn-back-to-menu', () => {
    audio.ui();
    show('menu');
  });

  // Nickname tahrirlash
  bindClick('btn-change-name', () => openNicknameModal());
  bindClick('btn-menu-edit-name', () => openNicknameModal());
  bindClick('btn-save-nickname', () => saveNickname());
  bindClick('btn-cancel-nickname', () => closeNicknameModal());
  bindClick('btn-close-nickname', () => closeNicknameModal());

  // Sozlamalar modali
  bindClick('btn-open-settings', () => openSettingsModal());
  bindClick('btn-menu-settings', () => openSettingsModal());
  bindClick('btn-close-settings', () => closeSettingsModal());
  bindClick('btn-settings-close', () => closeSettingsModal());
  bindClick('btn-settings-save', () => closeSettingsModal());

  // Close tugmalari (data-close atributli)
  document.querySelectorAll('[data-close="settings"]').forEach((btn) => {
    btn.addEventListener('click', () => closeSettingsModal());
  });
  document.querySelectorAll('[data-close="nickname"]').forEach((btn) => {
    btn.addEventListener('click', () => closeNicknameModal());
  });

  // Modal foniga (backdrop) bosganda yopish
  ['modal-settings', 'modal-nickname'].forEach((modalId) => {
    const modal = getEl(modalId);
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) {
        if (modalId === 'modal-settings') closeSettingsModal();
        if (modalId === 'modal-nickname') closeNicknameModal();
      }
    });
  });

  // Escape klavishi
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modalSettings = getEl('modal-settings');
      if (modalSettings && !modalSettings.classList.contains('hidden')) {
        closeSettingsModal();
      }
      const modalNickname = getEl('modal-nickname');
      if (modalNickname && !modalNickname.classList.contains('hidden')) {
        closeNicknameModal();
      }
    }
  });

  // Nickname modal inputida Enter bosilganda saqlash
  const nickInput = getNicknameModalInput();
  nickInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveNickname();
    }
  });

  // Sozlamalar slayderlari va selektorlari
  const wireSlider = (ids: string[], onVal: (v: number) => void) => {
    ids.forEach((id) => {
      const el = getEl<HTMLInputElement>(id);
      if (el) {
        el.addEventListener('input', () => {
          const val = Number(el.value);
          if (!Number.isNaN(val)) onVal(val);
        });
      }
    });
  };

  wireSlider(['menu-set-sens', 'set-sens'], (v) => {
    settings.sens = Math.max(0.1, Math.min(4.0, v));
    settings.sensitivity = settings.sens;
    saveSettings(settings);
    syncSettingsUI();
  });

  wireSlider(['menu-set-vol', 'set-vol'], (v) => {
    settings.volume = Math.max(0, Math.min(1.0, v));
    audio.setVolume(settings.volume);
    saveSettings(settings);
    syncSettingsUI();
  });

  wireSlider(['menu-set-fov', 'set-fov'], (v) => {
    settings.fov = Math.max(60, Math.min(110, Math.round(v)));
    saveSettings(settings);
    syncSettingsUI();
  });

  ['menu-set-quality', 'set-quality'].forEach((id) => {
    const el = getEl<HTMLSelectElement>(id);
    el?.addEventListener('change', () => {
      const val = el.value as QualityLevel;
      if (val === 'low' || val === 'medium' || val === 'high') {
        settings.quality = val;
        saveSettings(settings);
        syncSettingsUI();
      }
    });
  });

  // Rejim kartochkalari va dropdown
  const modeSel = getEl<HTMLSelectElement>('room-mode');
  modeSel?.addEventListener('change', () => {
    applyModeSelection(modeSel.value);
  });

  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-mode]') as HTMLElement | null;
    if (target && target.dataset.mode) {
      applyModeSelection(target.dataset.mode);
    }
  });

  const lootPreviewChk = getEl<HTMLInputElement>('room-loot-preview');
  lootPreviewChk?.addEventListener('change', () => {
    const botsInput = getEl<HTMLInputElement>('room-bots');
    const mapSel = getEl<HTMLSelectElement>('room-map');
    if (modeSel?.value === 'forest_survival') {
      // Survival: botlar ruxsat etilgan (loot AI), xarita qat'iy forest_square
      if (botsInput) {
        botsInput.disabled = false;
        botsInput.max = '8';
        if (Number(botsInput.value) > 8) botsInput.value = '3';
      }
      if (mapSel) mapSel.value = 'forest_square';
    } else if (lootPreviewChk.checked) {
      if (botsInput) {
        botsInput.value = '0';
        botsInput.disabled = true;
      }
    } else {
      if (botsInput) {
        botsInput.disabled = false;
        if (Number(botsInput.value) === 0) botsInput.value = '4';
      }
    }
  });

  // Xona yaratish tugmasi
  bindClick('btn-create', () => {
    audio.init();
    const mapSel = getEl<HTMLSelectElement>('room-map');
    const curMode = modeSel ? modeSel.value : 'forest_survival';
    const isSurvival = curMode === 'forest_survival';
    const selectedMap = isSurvival
      ? 'forest_square'
      : (mapSel?.value as MapId) || 'forest_square';
    const lootPreview = isSurvival || Boolean(lootPreviewChk?.checked);

    const rNameInput = getEl<HTMLInputElement>('room-name');
    const botsInput = getEl<HTMLInputElement>('room-bots');
    const maxInput = getEl<HTMLInputElement>('room-max');
    const timeInput = getEl<HTMLInputElement>('room-time');
    const scoreInput = getEl<HTMLInputElement>('room-score');

    const opts: CreateRoomOpts = {
      name: (rNameInput ? rNameInput.value.trim() : '') || `${settings.name} xonasi`,
      mode: isSurvival ? 'forest_survival' : curMode === 'ffa' ? 'ffa' : 'tdm',
      bots: isSurvival
        ? Math.max(0, Math.min(8, Number(botsInput?.value ?? 3)))
        : lootPreview
          ? 0
          : Math.max(0, Math.min(16, Number(botsInput?.value ?? 4))),
      maxPlayers: Math.max(isSurvival ? 2 : 1, Math.min(16, Number(maxInput?.value ?? 10))),
      timeLimit: Math.max(1, Math.min(60, Number(timeInput?.value ?? (isSurvival ? 15 : 10)))),
      scoreLimit: isSurvival ? 1 : Math.max(1, Math.min(500, Number(scoreInput?.value ?? (curMode === 'tdm' ? 50 : 25)))),
      mapId: selectedMap,
      lootPreview,
    };

    socket.emit('createRoom', opts, (res: { ok: boolean; roomId?: string; error?: string }) => {
      if (!res.ok || !res.roomId) return toast(res.error ?? "Xona yaratib bo'lmadi");
      joinRoom(res.roomId);
    });
  });

  // Xonalar ro'yxati klik va yangilash
  getEl('room-list')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-join]') as HTMLElement | null;
    if (btn?.dataset.join) joinRoom(btn.dataset.join);
  });

  socket.on('roomList', (rooms: RoomInfo[]) => renderRooms(rooms));
  bindClick('btn-refresh', () => {
    audio.ui();
    socket.emit('listRooms', (rooms: RoomInfo[]) => renderRooms(rooms));
  });
}

// ---------------- LAN manzillari ----------------
function fetchLanInfo(): void {
  fetch('/api/info')
    .then((r) => r.json())
    .then((info: { ips: string[]; port: number }) => {
      const port = window.location.port ? `:${window.location.port}` : '';
      const urls = info.ips.map((ip) => `http://${ip}${port}`);
      const lanEl = getEl('lan-urls');
      if (lanEl) {
        lanEl.innerHTML = urls.length ? urls.map((u) => `<div>${u}</div>`).join('') : '<div>Tarmoq topilmadi</div>';
      }
    })
    .catch(() => {
      const lanEl = getEl('lan-urls');
      if (lanEl) lanEl.textContent = window.location.origin;
    });
}

// ---------------- Boshlang'ich initsializatsiya ----------------
syncPlayerName(settings.name);
syncSettingsUI();
audio.setVolume(settings.volume);
initEvents();

// Initial mode sinxronizatsiyasi: Default tavsiya etilgan rejim 'forest_survival'
applyModeSelection('forest_survival');

fetchLanInfo();
updateConnStatus(socket.connected ? 'connected' : 'connecting');
show('menu');

const initialNameInput = getEl<HTMLInputElement>('name-input');
if (initialNameInput && settings.name) {
  initialNameInput.value = settings.name;
}
