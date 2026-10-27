import type { Team } from '../../shared/constants';
import { sampleForestSquareTerrainColor } from '../../shared/forestSquareTerrain';
import { sampleTerrainHeight, sampleTerrainSlopeDeg } from '../../shared/terrain';
import type { WorldDefinition } from '../../shared/world';

/**
 * Mini-xarita (radar): o'yinchi atrofidagi aylana xarita, oldinga yo'nalish doim yuqorida.
 * - Statik dunyo rasmi (yer rangi: yo'llar, hovlilar, qoyalar; daraxtlar; kollayderlar) bir marta chiziladi.
 * - Har kadrda faqat aylana ichiga aylantirib chiziladi (arzon: bitta drawImage + bir nechta belgi).
 * - [N] bilan butun xarita (shimol yuqorida) rejimi.
 * - Raqiblar hech qachon ko'rsatilmaydi; TDM'da faqat jamoadoshlar.
 */
/** Xavfsiz zona (survival): joriy va maqsad aylana. */
export interface MiniMapZone {
  cx: number;
  cz: number;
  radius: number;
  targetCx: number;
  targetCz: number;
  targetRadius: number;
  shrinking: boolean;
}

export interface MiniMapMarker {
  x: number;
  z: number;
  team: Team;
  alive: boolean;
}

interface Poi {
  x: number;
  z: number;
  name: string;
}

const RADAR_SIZE = 184;
const WHOLE_SIZE = 440;
const RADAR_VIEW_RADIUS_M = 58;

export class MiniMap {
  private readonly wrap: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hint: HTMLElement;
  private readonly map: HTMLCanvasElement;
  private readonly mapScale: number; // px per metr (statik rasm)
  private readonly minX: number;
  private readonly minZ: number;
  private readonly worldW: number;
  private readonly worldD: number;
  private readonly pois: Poi[] = [];
  private whole = false;
  private cssSize = 0;
  private dpr = 1;

  constructor(world: WorldDefinition, container: HTMLElement) {
    this.wrap = container;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap';
    this.hint = document.createElement('div');
    this.hint.id = 'minimap-hint';
    this.hint.textContent = '[N] xarita';
    container.appendChild(this.canvas);
    container.appendChild(this.hint);
    this.ctx = this.canvas.getContext('2d')!;

    const b = world.bounds;
    this.minX = b.minX;
    this.minZ = b.minZ;
    this.worldW = b.maxX - b.minX;
    this.worldD = b.maxZ - b.minZ;
    this.mapScale = 2;
    this.map = this.buildStaticMap(world);

    for (const loc of world.locations) {
      if (loc.kind === 'clearing' || loc.kind === 'arena_center') continue;
      this.pois.push({ x: loc.position.x, z: loc.position.z, name: loc.name });
    }
    this.resize();
  }

  /** Statik dunyo rasmi: 1 m = 1 namuna (yer rangi), 2 px/m chizma; daraxtlar va kollayderlar ustidan. */
  private buildStaticMap(world: WorldDefinition): HTMLCanvasElement {
    const s = this.mapScale;
    const w = Math.ceil(this.worldW * s);
    const d = Math.ceil(this.worldD * s);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = d;
    const ctx = out.getContext('2d')!;

    // 1. Yer rangi — 1 m rezolyutsiyada namuna, keyin kattalashtirib chiziladi
    const cols = Math.ceil(this.worldW);
    const rows = Math.ceil(this.worldD);
    const low = document.createElement('canvas');
    low.width = cols;
    low.height = rows;
    const lctx = low.getContext('2d')!;
    const img = lctx.createImageData(cols, rows);
    const data = img.data;
    const isForestSquare = world.mapId === 'forest_square';
    const heightfield = world.terrain.kind === 'heightfield';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = this.minX + c + 0.5;
        const z = this.minZ + r + 0.5;
        let cr: number;
        let cg: number;
        let cb: number;
        if (heightfield) {
          const y = sampleTerrainHeight(world.terrain, x, z);
          const slope = sampleTerrainSlopeDeg(world.terrain, x, z);
          if (isForestSquare) {
            [cr, cg, cb] = sampleForestSquareTerrainColor(x, y, z, slope, world.publicLayoutSeed);
          } else {
            const k = Math.max(0, Math.min(1, (y + 1) / 6));
            cr = 0.16 + k * 0.18;
            cg = 0.3 + k * 0.12;
            cb = 0.1 + k * 0.08;
            if (slope > 35) {
              cr = 0.36;
              cg = 0.37;
              cb = 0.36;
            }
          }
        } else {
          cr = 0.42;
          cg = 0.36;
          cb = 0.22;
        }
        // Xarita o'qilishi uchun yorug'roq va to'yinganroq
        const o = (r * cols + c) * 4;
        data[o] = Math.min(255, (cr * 1.55 + 0.04) * 255);
        data[o + 1] = Math.min(255, (cg * 1.55 + 0.04) * 255);
        data[o + 2] = Math.min(255, (cb * 1.45 + 0.03) * 255);
        data[o + 3] = 255;
      }
    }
    lctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(low, 0, 0, w, d);

    // 2. Kollayderlar (binolar, devorlar, qutilar) — qoramtir to'rtburchaklar
    ctx.fillStyle = 'rgba(40, 26, 14, 0.85)';
    for (const box of world.colliders) {
      const bw = (box.max.x - box.min.x) * s;
      const bd = (box.max.z - box.min.z) * s;
      if (bw < 1.5 && bd < 1.5) continue; // mayda ustunlar xaritada shovqin
      if (box.max.y - box.min.y < 0.6) continue; // past to'siqlar
      ctx.fillRect((box.min.x - this.minX) * s, (box.min.z - this.minZ) * s, bw, bd);
    }

    // 3. Daraxtlar — kichik to'q yashil nuqtalar (o'rmon zichligini ko'rsatadi)
    ctx.fillStyle = 'rgba(22, 70, 30, 0.9)';
    for (const v of world.visuals) {
      if (v.category !== 'tree') continue;
      const p = v.transform.position;
      const px = (p.x - this.minX) * s;
      const pz = (p.z - this.minZ) * s;
      ctx.beginPath();
      ctx.arc(px, pz, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    return out;
  }

  toggleWhole(): void {
    this.whole = !this.whole;
    this.wrap.classList.toggle('whole', this.whole);
    this.resize();
  }

  isWhole(): boolean {
    return this.whole;
  }

  private resize(): void {
    this.cssSize = this.whole ? WHOLE_SIZE : RADAR_SIZE;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.cssSize * this.dpr);
    this.canvas.height = Math.round(this.cssSize * this.dpr);
    this.canvas.style.width = `${this.cssSize}px`;
    this.canvas.style.height = `${this.cssSize}px`;
    this.hint.textContent = this.whole ? '[N] radar' : '[N] xarita';
  }

  /**
   * @param me o'yinchi (yoki kuzatuvchi kamerasi) pozitsiyasi va yaw (radian, 0 = -Z)
   * @param allies ko'rsatiladigan jamoadoshlar (raqiblar hech qachon berilmaydi)
   */
  update(me: { x: number; z: number; yaw: number }, allies: readonly MiniMapMarker[], zone: MiniMapZone | null = null): void {
    const ctx = this.ctx;
    const size = this.cssSize;
    const half = size / 2;
    const s = this.mapScale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const radius = half - 3;
    const whole = this.whole;
    // Ko'rinish: radar — 58 m radius; butun — dunyoni sig'diradigan masshtab
    const viewRadiusM = whole ? Math.max(this.worldW, this.worldD) / 2 + 4 : RADAR_VIEW_RADIUS_M;
    const k = radius / viewRadiusM; // ekran px per metr
    const rot = whole ? 0 : me.yaw; // radarda xarita aylanadi (oldinga = yuqori)
    const cx = whole ? this.minX + this.worldW / 2 : me.x;
    const cz = whole ? this.minZ + this.worldD / 2 : me.z;

    // Aylana (yoki butun rejimda yumaloq burchakli kvadrat) kesimi
    ctx.save();
    ctx.beginPath();
    if (whole) {
      const r = 14;
      ctx.moveTo(3 + r, 3);
      ctx.arcTo(size - 3, 3, size - 3, size - 3, r);
      ctx.arcTo(size - 3, size - 3, 3, size - 3, r);
      ctx.arcTo(3, size - 3, 3, 3, r);
      ctx.arcTo(3, 3, size - 3, 3, r);
    } else {
      ctx.arc(half, half, radius, 0, Math.PI * 2);
    }
    ctx.closePath();
    ctx.clip();

    ctx.fillStyle = '#1b2a1e';
    ctx.fillRect(0, 0, size, size);

    // Dunyo rasmi
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(rot);
    ctx.scale(k / s, k / s);
    ctx.translate(-(cx - this.minX) * s, -(cz - this.minZ) * s);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.map, 0, 0);
    ctx.restore();

    // Dunyo → ekran koordinatasi
    const toScreen = (x: number, z: number): [number, number] => {
      const dx = (x - cx) * k;
      const dz = (z - cz) * k;
      const c = Math.cos(rot);
      const sn = Math.sin(rot);
      return [half + dx * c - dz * sn, half + dx * sn + dz * c];
    };

    // Xavfsiz zona: joriy aylana (och ko'k) va maqsad aylana (oq, chiziqli). Aylana burilishga bog'liq emas.
    if (zone) {
      const [zx, zz] = toScreen(zone.cx, zone.cz);
      ctx.save();
      // Zonadan tashqari qismni qizg'ish qoplama bilan belgilaymiz
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      ctx.arc(zx, zz, Math.max(0.1, zone.radius * k), 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(220, 60, 40, 0.22)';
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = whole ? 2 : 2.5;
      ctx.strokeStyle = zone.shrinking ? 'rgba(255, 183, 77, 0.95)' : 'rgba(125, 211, 252, 0.95)';
      ctx.beginPath();
      ctx.arc(zx, zz, Math.max(0.1, zone.radius * k), 0, Math.PI * 2);
      ctx.stroke();
      if (Math.abs(zone.targetRadius - zone.radius) > 0.5 || Math.hypot(zone.targetCx - zone.cx, zone.targetCz - zone.cz) > 0.5) {
        const [tx, tz] = toScreen(zone.targetCx, zone.targetCz);
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.beginPath();
        ctx.arc(tx, tz, Math.max(0.1, zone.targetRadius * k), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // POI nomlari
    ctx.font = `700 ${whole ? 12 : 10}px Bahnschrift, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.pois) {
      const [sx, sz] = toScreen(p.x, p.z);
      const inView = whole || Math.hypot(sx - half, sz - half) < radius - 8;
      if (!inView) continue;
      ctx.fillStyle = 'rgba(255, 209, 102, 0.95)';
      ctx.beginPath();
      ctx.arc(sx, sz, whole ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.strokeText(p.name, sx, sz - (whole ? 11 : 9));
      ctx.fillStyle = '#fff4dc';
      ctx.fillText(p.name, sx, sz - (whole ? 11 : 9));
    }

    // Jamoadoshlar
    for (const a of allies) {
      let [sx, sz] = toScreen(a.x, a.z);
      if (!whole) {
        // Radardan tashqaridagilar chetida ko'rsatiladi
        const ddx = sx - half;
        const ddz = sz - half;
        const dist = Math.hypot(ddx, ddz);
        const lim = radius - 7;
        if (dist > lim) {
          sx = half + (ddx / dist) * lim;
          sz = half + (ddz / dist) * lim;
        }
      }
      ctx.fillStyle = a.team === 'red' ? '#ff6b5a' : a.team === 'blue' ? '#6bb2ff' : '#ffd36b';
      ctx.globalAlpha = a.alive ? 1 : 0.4;
      ctx.beginPath();
      ctx.arc(sx, sz, whole ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.stroke();
    }

    // O'yinchi strelkasi
    {
      const [px, pz] = whole ? toScreen(me.x, me.z) : [half, half];
      ctx.save();
      ctx.translate(px, pz);
      // Radarda doim yuqoriga; butun rejimda yo'nalish bo'yicha (-yaw: canvas y pastga)
      ctx.rotate(whole ? -me.yaw : 0);
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6.5, 7);
      ctx.lineTo(0, 3.5);
      ctx.lineTo(-6.5, 7);
      ctx.closePath();
      ctx.fillStyle = '#ffd166';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore(); // clip

    // Shimol belgisi (radarda aylanadi) va ramka
    if (!whole) {
      const nAng = rot; // shimol = dunyo -Z; ekranda (0,-1) ni rot ga burish
      const nx = half + Math.sin(nAng) * (radius - 10);
      const nz = half - Math.cos(nAng) * (radius - 10);
      ctx.font = '900 11px Bahnschrift, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText('N', nx, nz);
      ctx.fillStyle = '#ff8a65';
      ctx.fillText('N', nx, nz);
    }
  }

  dispose(): void {
    this.canvas.remove();
    this.hint.remove();
    this.wrap.classList.remove('whole');
  }
}
