import type { GroundCoverField } from '../../shared/groundCover';
import type { QualityLevel } from '../settings';
import {
  createGrassRenderer,
  type GroundCoverRendererHandle,
  type GroundCoverStats,
} from './grass/GrassRenderer';
import type { GrassPlannerContext } from './grass/GrassVariantPlanner';

/**
 * STAGE 08-FIX / 08-TERRAIN-VISUAL — vizual o't qatlami uchun yupqa kirish nuqtasi.
 *
 * Haqiqiy renderer `grass/GrassRenderer.ts` da (17 ta GLB variant, `InstancedMesh`, chunk culling).
 * Ilgari bu yerda ~380 qatorlik procedural zaxira renderer ham bor edi, lekin unga faqat
 * `createGrassRenderer` throw qilganda o'tilardi — registry esa GLB yuklanmasa o'zi procedural
 * fallback geometriya qaytaradi, shuning uchun u yo'l hech qachon ishlamagan va olib tashlandi.
 *
 * Sof kosmetik qatlam: kollayderlar yo'q, `world.visuals` / gameplayHash / serverda yo'q.
 */

export type { GroundCoverRendererHandle, GroundCoverStats };

/**
 * GLB o't lifecycle & diagnostika API si (`GrassAssetRegistry`) — iste'molchilar uchun yagona yo'l.
 */
export {
  onGrassAssetsReady,
  getGrassAssetDiagnostics,
  type GrassAssetDiagnostics,
} from './grass/GrassAssetRegistry';

/**
 * Vizual o't qatlamini quradi. `plannerCtx` — jonli dunyo daraxtlari/relyefi
 * (`createGrassPlannerContext(world)`); berilmasa planner seed bo'yicha o'zi quradi.
 */
export function createGroundCoverRenderer(
  field: GroundCoverField,
  quality: QualityLevel,
  seed = 6501,
  plannerCtx?: GrassPlannerContext,
): GroundCoverRendererHandle {
  return createGrassRenderer(field, quality, seed, plannerCtx);
}
