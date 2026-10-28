import * as THREE from 'three';

/**
 * Birinchi shaxs qo'llari (ViewModel) uchun umumiy materiallar: kemper terisi va flanel yeng
 * teksturasi. Ilgari protsedural Stickman tanasida ham ishlatilgan — endi faqat ViewModel uchun.
 */

/** Silliq gradientli mato teksturasi (jamoa rangi bo'yicha keshlanadi). */
const shirtTexCache = new Map<string, THREE.CanvasTexture>();
export function getFlannelTexture(hexColor: string): THREE.CanvasTexture {
  let tex = shirtTexCache.get(hexColor);
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const base = new THREE.Color(hexColor);
  const dark = base.clone().multiplyScalar(0.82);
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, `#${base.getHexString()}`);
  grad.addColorStop(1, `#${dark.getHexString()}`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  shirtTexCache.set(hexColor, tex);
  return tex;
}

/** Kemper terisi — umumiy material (dispose qilinmaydi). */
export const skinMat = new THREE.MeshStandardMaterial({ color: '#ffcaa3', roughness: 0.42 });
