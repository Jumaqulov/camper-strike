import * as THREE from 'three';
import type { MaterialKind } from '../../shared/map';

type Draw = (g: CanvasRenderingContext2D, s: number) => void;

function canvasTex(size: number, draw: Draw): THREE.Texture {
  if (typeof document === 'undefined') {
    const data = new Uint8Array([128, 128, 128, 255]);
    const t = new THREE.DataTexture(data, 1, 1);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function speckle(g: CanvasRenderingContext2D, s: number, n: number, colors: string[], maxSize: number, alpha = 0.18) {
  for (let i = 0; i < n; i++) {
    g.globalAlpha = 0.04 + Math.random() * alpha;
    g.fillStyle = colors[Math.floor(Math.random() * colors.length)];
    const sz = 1 + Math.random() * maxSize;
    g.fillRect(Math.random() * s, Math.random() * s, sz, sz);
  }
  g.globalAlpha = 1;
}

function stains(g: CanvasRenderingContext2D, s: number, n: number, color: string) {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const r = 20 + Math.random() * 60;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

/** Har bir material uchun: tekstura va uning dunyodagi o'lchami (metr). null = har yuzaga bitta. */
export const TEX_SCALE: Record<MaterialKind, number | null> = {
  ground: 4,
  wall: 3,
  concrete: 4,
  crate: null,
  metal: 2,
  roof: 3,
};

export function createTextures(): Record<MaterialKind, THREE.Texture> {
  // O'rmon maysazori, qarag'ay ignalari va tuproq so'qmoq ("RV There Yet?" backcountry)
  const ground = canvasTex(512, (g, s) => {
    g.fillStyle = '#4a7036';
    g.fillRect(0, 0, s, s);
    stains(g, s, 14, 'rgba(110, 82, 48, 0.28)'); // tuproq va loy dog'lari
    stains(g, s, 10, 'rgba(42, 72, 28, 0.35)');  // quyuq mox
    speckle(g, s, 11000, ['#3d5e2b', '#5d8744', '#6d964f', '#7e6340', '#8c724d'], 3.2, 0.25);
    // Maysa va qarag'ay ignalari chiziqlari
    for (let i = 0; i < 900; i++) {
      g.strokeStyle = i % 3 === 0 ? 'rgba(130, 175, 85, 0.28)' : 'rgba(45, 75, 30, 0.25)';
      g.lineWidth = 1.2;
      const x = Math.random() * s;
      const y = Math.random() * s;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (Math.random() - 0.5) * 6, y - 4 - Math.random() * 6);
      g.stroke();
    }
    // Mayda oq-sariq dala gullari va toshchalar
    speckle(g, s, 350, ['#e8e2d0', '#f4d046', '#9aa09a'], 2.2, 0.45);
  });

  // Yog'och kulba devori (Log Cabin timber)
  const wall = canvasTex(512, (g, s) => {
    g.fillStyle = '#734827';
    g.fillRect(0, 0, s, s);
    const rows = 6;
    const bh = s / rows;
    for (let r = 0; r < rows; r++) {
      const y0 = r * bh;
      const grad = g.createLinearGradient(0, y0, 0, y0 + bh);
      grad.addColorStop(0, '#543218');
      grad.addColorStop(0.22, '#8c5830');
      grad.addColorStop(0.55, '#996238');
      grad.addColorStop(0.88, '#6e4322');
      grad.addColorStop(1, '#3d220e');
      g.fillStyle = grad;
      g.fillRect(0, y0 + 2, s, bh - 4);

      // Yog'och tolalari va ko'zchalari (knots)
      g.strokeStyle = 'rgba(55, 28, 10, 0.25)';
      g.lineWidth = 1.5;
      for (let k = 0; k < 5; k++) {
        const ly = y0 + 8 + (k * (bh - 16)) / 5;
        g.beginPath();
        g.moveTo(0, ly);
        g.bezierCurveTo(s * 0.33, ly + (Math.random() - 0.5) * 6, s * 0.66, ly + (Math.random() - 0.5) * 6, s, ly);
        g.stroke();
      }
      // Xoda ulanish joyi
      const seamX = ((r * 173 + 90) % (s - 80)) + 40;
      g.fillStyle = 'rgba(40, 20, 8, 0.55)';
      g.fillRect(seamX, y0 + 3, 4, bh - 6);
    }
    speckle(g, s, 4500, ['#5c381c', '#a86e42', '#472a13'], 2.2, 0.16);
  });

  // Tog' xarsangtoshi va mox bosgan granit (Mountain Rock)
  const concrete = canvasTex(512, (g, s) => {
    g.fillStyle = '#72797c';
    g.fillRect(0, 0, s, s);
    stains(g, s, 14, 'rgba(45, 52, 55, 0.25)');
    stains(g, s, 8, 'rgba(65, 98, 48, 0.22)'); // yashil mox dog'lari
    speckle(g, s, 9500, ['#596063', '#8a9296', '#61686b', '#4d6b3c'], 3, 0.22);
    // Tosh yoriqlari
    g.strokeStyle = 'rgba(35, 40, 42, 0.45)';
    g.lineWidth = 2.5;
    for (let i = 0; i < 8; i++) {
      let x = Math.random() * s;
      let y = Math.random() * s;
      g.beginPath();
      g.moveTo(x, y);
      for (let j = 0; j < 4; j++) {
        x += (Math.random() - 0.5) * 90;
        y += (Math.random() - 0.5) * 90;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  });

  // Lager yashigi / Piknik muzlatgich-qutisi (Camp Supply Crate)
  const crate = canvasTex(256, (g, s) => {
    g.fillStyle = '#b87b3e';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 6; i++) {
      const y = (i * s) / 6;
      g.fillStyle = i % 2 ? '#ad7135' : '#c48647';
      g.fillRect(0, y, s, s / 6);
      g.fillStyle = 'rgba(55, 32, 10, 0.55)';
      g.fillRect(0, y, s, 2);
    }
    // "RV CAMP" qizil-sariq belbog' chizig'i
    g.fillStyle = '#c83e2b';
    g.fillRect(18, s * 0.42, s - 36, s * 0.16);
    g.fillStyle = '#f2c14e';
    g.fillRect(18, s * 0.48, s - 36, s * 0.04);

    speckle(g, s, 2500, ['#7a5428', '#d49a60'], 2);
    g.strokeStyle = '#633d1a';
    g.lineWidth = 20;
    g.strokeRect(10, 10, s - 20, s - 20);
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 2;
    g.strokeRect(20, 20, s - 40, s - 40);
    g.fillStyle = '#2d3134';
    for (const [x, y] of [[12, 12], [s - 12, 12], [12, s - 12], [s - 12, s - 12]]) {
      g.beginPath();
      g.arc(x, y, 4.5, 0, Math.PI * 2);
      g.fill();
    }
  });

  // Klassik 70-80 yillar "RV There Yet?" furgon qoplamasi (Bej + To'q sariq/Jigarrang chiziqlar)
  const metal = canvasTex(256, (g, s) => {
    g.fillStyle = '#e8dec6';
    g.fillRect(0, 0, s, s);
    // Gorizontal gofra chiziqlari
    for (let y = 0; y < s; y += 12) {
      g.fillStyle = 'rgba(120, 105, 80, 0.14)';
      g.fillRect(0, y, s, 2);
    }
    // Retro RV chiziqlari (to'q sariq, oltin-sariq, to'q jigarrang)
    g.fillStyle = '#d96226';
    g.fillRect(0, s * 0.48, s, s * 0.11);
    g.fillStyle = '#ebaa2f';
    g.fillRect(0, s * 0.59, s, s * 0.07);
    g.fillStyle = '#593218';
    g.fillRect(0, s * 0.66, s, s * 0.08);
    // Pastki qismida loy sachragan dog'lar
    stains(g, s, 8, 'rgba(95, 70, 42, 0.22)');
    // Zaklyopkalar
    g.fillStyle = 'rgba(60, 50, 40, 0.55)';
    for (let i = 0; i < 4; i++) {
      for (const x of [10, s - 10]) {
        g.beginPath();
        g.arc(x, 20 + i * (s / 4), 3, 0, Math.PI * 2);
        g.fill();
      }
    }
  });

  // O'rmon kulbasi tomi (Yashil-qo'ng'ir cherepitsa)
  const roof = canvasTex(256, (g, s) => {
    g.fillStyle = '#364a3a';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 8; i++) {
      const x = (i * s) / 8;
      const l = 52 + Math.random() * 20;
      g.fillStyle = `rgb(${l},${l * 1.25},${l * 0.98})`;
      g.fillRect(x + 1, 0, s / 8 - 2, s);
    }
    speckle(g, s, 2500, ['#263629', '#4f6b53', '#6b533b'], 2);
  });

  return { ground, wall, concrete, crate, metal, roof };
}

export function radialTexture(inner: string, outer: string, size = 64): THREE.Texture {
  if (typeof document === 'undefined') {
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function flashTexture(): THREE.Texture {
  if (typeof document === 'undefined') {
    const t = new THREE.DataTexture(new Uint8Array([255, 240, 180, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, size / 2);
  grad.addColorStop(0, 'rgba(255,255,230,1)');
  grad.addColorStop(0.25, 'rgba(255,210,90,0.9)');
  grad.addColorStop(1, 'rgba(255,120,0,0)');
  g.fillStyle = grad;
  for (let i = 0; i < 7; i++) {
    g.rotate((Math.PI * 2) / 7);
    g.beginPath();
    g.moveTo(-8, 0);
    g.lineTo(0, -size / 2);
    g.lineTo(8, 0);
    g.fill();
  }
  g.beginPath();
  g.arc(0, 0, size / 5, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
