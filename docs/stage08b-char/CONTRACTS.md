# Stage 08B-CHAR-INTEGRATION — module contracts (coordinator-owned)

Asset: `public/models/characters/camper_buddy_balanced_rigged.glb` (610972 B, SHA-256 `a898d979d5449a06da66e1b7208cb3a9571d8eed0d3dcbbf77842b3acf9be379`).
URL at runtime: `/models/characters/camper_buddy_balanced_rigged.glb`.
GLB facts: glTF 2.0, no textures/images/extensions; 1 skin / 22 joints
(Root, Hips, Spine, Chest, Neck, Head, Shoulder_L, UpperArm_L, LowerArm_L, Hand_L, Shoulder_R, UpperArm_R,
LowerArm_R, Hand_R, UpperLeg_L, LowerLeg_L, Foot_L, Toe_L, UpperLeg_R, LowerLeg_R, Foot_R, Toe_R);
sockets (plain nodes): Hand_R_Grip (Hand_R), Hand_L_Support (Hand_L), Head_Attach (Head), Back_Attach (Chest);
mesh node `CamperBuddy_Body` (1 mesh, 2 primitives → 2 SkinnedMesh after GLTFLoader), materials `buddy_main`
(vertex colors) and `buddy_team_color`; scene root node `camper_buddy_balanced`.
Clips (LINEAR, in-place, Hips.translation only): Idle 3.0s loop, Walk 0.48s loop (natural 3.005 m/s),
Run 0.46s loop (natural 6.498 m/s), JumpStart 0.4s once, JumpAir 0.6s loop, Land 0.5s once, Interact 1.2s once.
Axes: +Y up, −Z forward, +X right (`*_R`), origin on the ground between the feet. Height 1.802 m.

## File ownership (no agent edits another agent's files)
| Owner | Files |
|---|---|
| Coordinator | `Stickman.ts`, `Game.ts`, `LocalPlayer.ts`, `package.json`, this doc, `public/models/characters/*` |
| A — asset registry | `src/client/game/character/CharacterAssetRegistry.ts` |
| B — animator | `src/client/game/animation/locomotionState.ts`, `src/client/game/animation/CamperBuddyAnimator.ts` |
| C — sockets/aim/material | `src/client/game/character/CharacterAimPose.ts`, `src/client/game/character/CharacterWeaponMount.ts`, `src/client/game/character/CharacterMaterials.ts` |
| D — tests | `src/client/game/character/__tests__/*.test.ts`, `src/client/game/animation/__tests__/*.test.ts` |
| E — browser QA | `scripts/qa-stage08b-char.mjs`, `docs/stage08b-char/qa_*` |

## A — `character/CharacterAssetRegistry.ts`
```ts
export const CAMPER_BUDDY_URL = '/models/characters/camper_buddy_balanced_rigged.glb';
export const CAMPER_BUDDY_CLIPS = ['Idle','Walk','Run','JumpStart','JumpAir','Land','Interact'] as const;
export type CamperBuddyClipName = typeof CAMPER_BUDDY_CLIPS[number];
export const CAMPER_BUDDY_SOCKETS = ['Hand_R_Grip','Hand_L_Support','Head_Attach','Back_Attach'] as const;
export interface CharacterAssetTemplate { scene: THREE.Object3D; clips: THREE.AnimationClip[]; validation: CharacterValidation }
export interface CharacterValidation { ok: boolean; clips: string[]; joints: number; sockets: string[]; skinnedMeshes: number; triangles: number; errors: string[] }
export interface CamperBuddyInstance {
  root: THREE.Object3D;                       // SkeletonUtils.clone of template scene — own skeleton
  skinnedMeshes: THREE.SkinnedMesh[];         // 2
  bones: Map<string, THREE.Bone>;             // 22, keyed by joint name
  sockets: Map<string, THREE.Object3D>;       // 4
  clips: ReadonlyMap<CamperBuddyClipName, THREE.AnimationClip>; // shared (immutable) clips
  teamMaterial: THREE.MeshStandardMaterial;   // per-instance clone of buddy_team_color
  mainMaterial: THREE.Material;               // shared buddy_main (never mutated)
  dispose(): void;                            // disposes only per-instance resources (team material clone, skeleton.dispose())
}
export function parseCharacterGlb(data: ArrayBuffer): Promise<CharacterAssetTemplate>; // works in node (no textures)
export function validateCharacterTemplate(scene, clips): CharacterValidation;
export function preloadCharacterAssets(): Promise<void>;        // idempotent, fetch+parse once, never throws
export function isCharacterAssetReady(): boolean;
export function hasCharacterAssetFailed(): boolean;
export function onCharacterAssetReady(cb: () => void): () => void; // fires immediately (microtask) if already ready; never on failure
export function instantiateCamperBuddy(): CamperBuddyInstance | null; // null while loading / failed / invalid
export function registerCharacterTemplateForTest(t: CharacterAssetTemplate | null): void;
export function getCharacterAssetDiagnostics(): { url; state: 'idle'|'loading'|'ready'|'failed'; error: string|null; validation: CharacterValidation|null; liveInstances: number; createdInstances: number; disposedInstances: number; loadMs: number|null };
```
Shadow: skinned meshes `castShadow = true`, `receiveShadow = true`, `frustumCulled = false` is NOT allowed
(keep culling on; compute bounding sphere generous enough for animated bbox ±0.8 m radius 1.3 m centred y=0.9).

## B — animation
`locomotionState.ts` (pure, no three import):
```ts
export type LocoState = 'Idle'|'Walk'|'Run'|'JumpStart'|'JumpAir'|'Land'|'Interact';
export interface LocoInput { speed: number; onGround: boolean; alive: boolean }
export interface LocoOutput { state: LocoState; changed: boolean; timeScale: number; fade: number }
export class LocomotionStateMachine { update(dt: number, i: LocoInput): LocoOutput; requestInteract(): void; reset(): void; readonly state: LocoState }
export const WALK_NATURAL_SPEED = 3.005, RUN_NATURAL_SPEED = 6.498;
```
`CamperBuddyAnimator.ts`: `new CamperBuddyAnimator(root, clips)`, `update(dt, LocoInput)`, `playInteract()`,
`getDiagnostics(): { state; weights: Record<string,number>; timeScale: number }`, `freeze()` (death: stop advancing),
`resetToIdle()`, `dispose()` (stopAllAction + uncacheRoot).

## C — upper-body override, weapon mount, materials
`CharacterAimPose.ts`: `applyUpperBodyAimPose(bones, { weight, pitch, armed, reloadT })` — called AFTER mixer.update;
overrides Spine/Chest/Neck/Head (pitch distribution) and both arm chains (fixed baked rifle pose, offline-authored
constants; no runtime IK). Weight 0 = pure clip.
`CharacterWeaponMount.ts`: `class CharacterWeaponMount { constructor(socket: Object3D, characterRoot: Object3D); readonly holder: THREE.Group; update(pitch, recoil, reloadTilt): void }`
— holder is parented to `Hand_R_Grip`; each frame its local transform is solved so the gun points along the
character aim direction (root yaw + pitch) regardless of hand bone orientation.
`CharacterMaterials.ts`: `applyTeamColor(inst: CamperBuddyInstance, color)` (only the per-instance team material).

## Coordinator adapter
`Stickman` keeps its full public API. When `instantiateCamperBuddy()` returns an instance, `Stickman` hides its
procedural `body` and parents the buddy under `root`; otherwise (loading/failed) the procedural body is used.
Death = procedural fallback (buddy root tilt/fall driven by existing `deathStyle`), animator frozen.

## Debug hook (DEV only) for E
`window.__DEV_GAME_TOOLS__.getCharacterDiagnostics()` →
`{ asset: getCharacterAssetDiagnostics(), local: CharacterModelDiag, remotes: Array<{ id: string } & CharacterModelDiag> }`
where `CharacterModelDiag = { mode: 'buddy'|'procedural'; visible: boolean; state: string|null; weights: Record<string,number>; timeScale: number; weapon: string|null; muzzleWorld: Vec3; gripWorld: Vec3|null }`.
