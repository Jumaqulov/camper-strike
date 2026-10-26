import type { Server, Socket } from 'socket.io';
import { clamp } from '../shared/math';
import type {
  ClientState,
  ContainerOpenAck,
  ContainerOpenReq,
  CreateRoomOpts,
  EquipWeaponAck,
  EquipWeaponReq,
  LootPickupAck,
  LootPickupReq,
  PlayerInputBatchMsg,
  PlayerInputCmd,
  PlayerInventorySnap,
  ReadyAck,
  ReadyMsg,
  RoomInfo,
  RoomLootSnapshot,
  ShootMsg,
  UseMedkitAck,
  UseMedkitReq,
  WelcomeMsg,
} from '../shared/protocol';
import { DEFAULT_PUBLIC_LAYOUT_SEED, type MapId } from '../shared/world';
import { Room } from './room';

type Ack<T> = (res: T) => void;

const VALID_MAP_IDS: MapId[] = [
  'dust_arena',
  'forest_technical',
  'forest_sample',
  'forest_assets_preview',
  'forest_square',
];

function sanitizeName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/[<>]/g, '').trim().slice(0, 16) : '';
  return s || "O'yinchi" + Math.floor(Math.random() * 1000);
}

export function sanitizeOpts(raw: Partial<CreateRoomOpts> | undefined, owner: string): CreateRoomOpts {
  const mode =
    raw?.mode === 'forest_survival'
      ? 'forest_survival'
      : raw?.mode === 'ffa'
        ? 'ffa'
        : 'tdm';
  const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.replace(/[<>]/g, '').trim().slice(0, 24) : `${owner} xonasi`;
  const num = (v: unknown, def: number, min: number, max: number) => clamp(Math.round(Number.isFinite(Number(v)) ? Number(v) : def), min, max);
  const mapId: MapId =
    mode === 'forest_survival'
      ? 'forest_square'
      : typeof raw?.mapId === 'string' && (VALID_MAP_IDS as string[]).includes(raw.mapId)
        ? raw.mapId
        : 'dust_arena';
  const lootPreview = mode === 'forest_survival' || (Boolean(raw?.lootPreview) && mapId === 'forest_square');
  const opts: CreateRoomOpts = {
    name,
    mode,
    bots: lootPreview ? 0 : num(raw?.bots, 4, 0, 16),
    maxPlayers: num(raw?.maxPlayers, 10, mode === 'forest_survival' ? 2 : 1, 16),
    timeLimit: num(raw?.timeLimit, mode === 'forest_survival' ? 3 : 10, 1, 60),
    scoreLimit: num(raw?.scoreLimit, mode === 'forest_survival' ? 1 : mode === 'tdm' ? 50 : 25, 1, 500),
    mapId,
    publicLayoutSeed: num(raw?.publicLayoutSeed, DEFAULT_PUBLIC_LAYOUT_SEED, 1, 0x7fffffff),
    lootPreview,
  };
  if (raw?.countdownSec !== undefined && Number.isFinite(Number(raw.countdownSec))) {
    opts.countdownSec = clamp(Number(raw.countdownSec), 1, 60);
  }
  return opts;
}

export class Lobby {
  private rooms = new Map<string, Room>();
  private names = new Map<string, string>();
  private listTimer: NodeJS.Timeout | null = null;

  constructor(private io: Server) {
    io.on('connection', (socket) => this.onConnection(socket));
  }

  private list(): RoomInfo[] {
    return [...this.rooms.values()].filter((r) => !r.destroyed).map((r) => r.info());
  }

  private broadcastList() {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      this.io.to('lobby').emit('roomList', this.list());
    }, 150);
  }

  private onConnection(socket: Socket) {
    let room: Room | null = null;
    socket.join('lobby');

    const leave = () => {
      if (!room) return;
      room.removePlayer(socket.id);
      room = null;
      socket.join('lobby');
      this.broadcastList();
    };

    socket.on('hello', (data: { name?: string }, ack?: Ack<{ ok: boolean; name: string; rooms: RoomInfo[] }>) => {
      const name = sanitizeName(data?.name);
      this.names.set(socket.id, name);
      ack?.({ ok: true, name, rooms: this.list() });
    });

    socket.on('listRooms', (ack?: Ack<RoomInfo[]>) => ack?.(this.list()));

    socket.on('createRoom', (opts: Partial<CreateRoomOpts>, ack?: Ack<{ ok: boolean; roomId?: string; error?: string }>) => {
      if (this.rooms.size >= 20) return ack?.({ ok: false, error: "Xonalar soni juda ko'p" });
      if (opts?.mode === 'forest_survival' && opts?.mapId && opts.mapId !== 'forest_square') {
        return ack?.({
          ok: false,
          error: 'Forest Survival rejimi faqat Forest Square (256×256) xaritasida yaratilishi mumkin',
        });
      }
      const owner = this.names.get(socket.id) ?? "O'yinchi";
      const r = new Room(sanitizeOpts(opts, owner), this.io, (dead) => {
        this.rooms.delete(dead.id);
        this.broadcastList();
      });
      this.rooms.set(r.id, r);
      this.broadcastList();
      ack?.({ ok: true, roomId: r.id });
      // Hech kim kirmasa xonani 30 soniyadan keyin o'chirish
      setTimeout(() => {
        if (!r.destroyed && r.humanCount() === 0) r.destroy();
      }, 30000);
    });

    socket.on('joinRoom', (data: { roomId?: string }, ack?: Ack<{ ok: boolean; error?: string; welcome?: WelcomeMsg }>) => {
      const r = data?.roomId ? this.rooms.get(data.roomId) : undefined;
      if (!r || r.destroyed) return ack?.({ ok: false, error: 'Xona topilmadi' });
      if (r.isFull()) return ack?.({ ok: false, error: "Xona to'la" });
      leave();
      socket.leave('lobby');
      room = r;
      const welcome = r.addHuman(socket, this.names.get(socket.id) ?? sanitizeName(''));
      ack?.({ ok: true, welcome });
      this.broadcastList();
    });

    socket.on('ready', (msg?: ReadyMsg, ack?: Ack<ReadyAck>) => {
      if (!room) return;
      const res = room.onReady(socket.id, msg, ack);
      if (!res.ok) {
        room = null;
        socket.join('lobby');
        this.broadcastList();
      }
    });
    socket.on('leaveRoom', () => leave());
    socket.on('input', (msg: PlayerInputCmd | PlayerInputBatchMsg) => room?.onInput(socket.id, msg));
    socket.on('state', (s: ClientState) => room?.onState(socket.id, s));
    socket.on('shoot', (m: ShootMsg) => room?.onShoot(socket.id, m));
    socket.on('reload', (data?: { weapon?: unknown }) => room?.onReload(socket.id, data));
    socket.on('grenade', (d: { dir: { x: number; y: number; z: number } }) => room?.onGrenade(socket.id, d));
    socket.on('container:open', (req: ContainerOpenReq, ack?: Ack<ContainerOpenAck>) =>
      room?.onContainerOpen(socket.id, req, ack),
    );
    socket.on('loot:pickup', (req: LootPickupReq, ack?: Ack<LootPickupAck>) =>
      room?.onLootPickup(socket.id, req, ack),
    );
    socket.on('inventory:equip', (req: EquipWeaponReq, ack?: Ack<EquipWeaponAck>) =>
      room?.onEquipWeapon(socket.id, req, ack),
    );
    socket.on('inventory:useMedkit', (req: UseMedkitReq, ack?: Ack<UseMedkitAck>) =>
      room?.onUseMedkit(socket.id, req, ack),
    );
    socket.on(
      'loot:sync',
      (_data: unknown, ack?: Ack<{ loot: RoomLootSnapshot; inventory: PlayerInventorySnap | null }>) =>
        room?.onRequestLootSync(socket.id, ack),
    );
    socket.on('chat', (text: string) => room?.onChat(socket.id, text));
    socket.on('switchTeam', () => {
      room?.onSwitchTeam(socket.id);
    });
    socket.on('latency', (t: number, ack?: Ack<number>) => ack?.(t));

    socket.on('disconnect', () => {
      leave();
      this.names.delete(socket.id);
    });
  }
}
