import * as THREE from 'three';

/** Structural subset of CamperBuddyInstance needed here. */
export interface TeamMaterialHolder {
  teamMaterial: THREE.MeshStandardMaterial;
}

/**
 * Tints only the per-instance `buddy_team_color` material clone. The shared `buddy_main`
 * (vertex-colour) material is never touched, so other instances are unaffected.
 */
export function applyTeamColor(inst: TeamMaterialHolder, color: THREE.ColorRepresentation): void {
  const mat = inst.teamMaterial;
  if (!mat) return;
  mat.color.set(color);
}
