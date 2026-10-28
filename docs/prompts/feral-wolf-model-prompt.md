# Low-poly feral wolf for Three.js — rigged + animated GLB

> Prompt for an AI coding agent (Claude Code / Codex / Blender agent). Copy everything below the line.

---

## Goal

Build **one production-ready GLB** of a **feral, frightening wolf** for the browser FPS game *Camper Strike 65* (TypeScript, **Three.js r186**, GLTFLoader, no post-processing). The wolf is an AI hunter that stalks, sniffs, howls, lunges and bites players at night, so it must read as *dangerous* from 30 m away and still look good 1 m from the camera in first person.

Output file: `public/models/characters/feral_wolf_rigged.glb`

The model must be generated **reproducibly**: either a pure-Node script `scripts/generate-wolf-glb.mjs` (no npm dependencies, like our existing `scripts/generate-knife-glb.mjs`) or a Blender Python script `scripts/generate-wolf.blend.py` + export. Re-running the script must produce the same file.

## Art direction (match the existing game)

Our player character is `camper_buddy_balanced_rigged.glb`: low-poly, **flat-shaded hard edges, no textures, vertex colors only (`COLOR_0`)**, 1.80 m tall, ~600 KB. The wolf must sit in the same world without looking like it came from another game:

- **Low-poly stylized, NOT realistic.** Chunky silhouette, faceted surfaces, 2 500 – 5 000 triangles total.
- **Feral and scary:** gaunt body with visible rib ridges, raised spiky hackles along the spine, long muzzle with exposed fangs, one torn ear, two or three scar notches, slightly oversized head and paws, tail low and bristled.
- **Palette (vertex colors, linear sRGB):** fur dark charcoal `#2a2b2e` on back, mid grey `#4a4c50` on flanks, dirty light grey `#8a8c88` on belly/throat/inner legs, muzzle and paw tips darker `#1c1c1f`, dried-blood tint `#5a1f1f` around the mouth and on the chest, pink-black gums `#3a1a22`, white-yellow fangs `#e8e2c8`.
- **Eyes glow:** separate primitive with an **emissive** material (`wolf_eyes`, emissive `#ffb020`, emissiveStrength ≥ 2, base color black). They must be visible in the dark at distance.
- Materials: `wolf_main` (metallic 0, roughness 0.85, vertex colors), `wolf_eyes` (emissive). No textures, no transparency, no Draco, no extensions except `KHR_materials_emissive_strength` (optional).

## Dimensions and axes (strict)

- Units **meters**, **Y up**, wolf faces **−Z** (nose toward −Z, tail toward +Z), **origin on the ground midway between the four paws**, paw pads at y = 0.
- Larger than a real wolf (menacing): **shoulder height 1.00 m** (± 0.05), head height when alert ≈ 1.15 m, body length nose tip → tail base ≈ 1.60 m, tail adds ≈ 0.60 m.
- Rest-pose bounding box roughly: x ∈ [−0.35, 0.35], y ∈ [0, 1.25], z ∈ [−1.05, 0.95].
- Single skinned mesh node named `wolf_body` (primitives: body + eyes), parent empty `feral_wolf`. Identity transforms on all non-joint nodes; **no negative or non-uniform scale anywhere**.

## Rig (≤ 28 joints, exact names)

```
Root
└ Hips
  ├ Spine ─ Chest ─ Neck ─ Head ─ Jaw
  │                        ├ Ear_L
  │                        └ Ear_R
  ├ Tail_1 ─ Tail_2 ─ Tail_3
  ├ UpperLeg_BL ─ LowerLeg_BL ─ Foot_BL
  └ UpperLeg_BR ─ LowerLeg_BR ─ Foot_BR
  (Chest) ├ UpperLeg_FL ─ LowerLeg_FL ─ Foot_FL
          └ UpperLeg_FR ─ LowerLeg_FR ─ Foot_FR
```

- `JOINTS_0` / `WEIGHTS_0`, max 4 influences per vertex, weights normalized to 1, correct `inverseBindMatrices`, rest pose = standing alert.
- `Root` stays at the origin in every clip (no root motion); only `Hips` may translate (bob).
- Jaw must open at least 35° for the bite.

## Sockets (empty nodes, children of the named joints)

- `socket_mouth` — child of `Jaw`, at the fang tips (bite contact point, used for bite hit-test and blood FX).
- `socket_eyes` — child of `Head`, between the eyes (for the glow sprite / look direction).
- `socket_back` — child of `Chest`, on top of the shoulders (hit FX, future rider/marker).
- `socket_nose` — child of `Head`, at the nose tip (sniff FX).

## Animation clips (exact names, 30 fps, LINEAR, in place)

| Clip | Length | Loop | Notes |
|---|---|---|---|
| `Idle` | 2.0 s | yes | Breathing, ear flick, slight tail sway |
| `Sniff` | 1.6 s | yes | Head low, nose sweeping left-right, slow step shuffle |
| `Alert` | 1.0 s | yes | Crouched threat pose, hackles up, jaw slightly open, growl bob |
| `Walk` | 1.0 s | yes | Stalking walk, stride ≈ 1.2 m per cycle, head low |
| `Run` | 0.6 s | yes | Gallop, stride ≈ 2.4 m per cycle, spine flexes |
| `Howl` | 3.0 s | no | Head up, jaw open, hold 1.5 s, return |
| `Attack` | 0.7 s | no | Crouch 0.0–0.2 s, lunge 0.2–0.35 s, **bite closes at 0.30 s**, recover |
| `Hit` | 0.4 s | no | Flinch to the side, ears back |
| `Death` | 1.2 s | no | Collapse to the right side, legs twitch, **hold last frame** |

- Clip timeline: Walk/Run must be phase-matched (foot-down at t = 0 for the same leg) so we can blend them.
- Rotations as quaternions, translations only on `Hips`, no scale tracks.
- All clips bound to the same skeleton; no extra nodes created per clip.

## Validation script (required)

Provide `scripts/validate-wolf-glb.mjs` (pure Node) that loads the GLB JSON chunk and asserts, printing a report:

1. node `feral_wolf` → `wolf_body` skinned mesh; exactly the joint names above; ≤ 28 joints.
2. clip names and durations exactly as the table (± 0.05 s); no unexpected clips.
3. total triangles 2 500 – 5 000; attributes `POSITION, NORMAL, COLOR_0, JOINTS_0, WEIGHTS_0`.
4. POSITION accessor min/max within the box above; shoulder height sanity (highest `Chest` joint y in rest pose 0.95 – 1.10).
5. all four sockets present under the right parents; eyes primitive uses the emissive material.
6. file size < 1.5 MB; no Draco; only allowed extensions.

Also add a throwaway viewer `scripts/wolf-preview.html` (Three.js from a CDN, OrbitControls, clip dropdown, grid at y = 0, a 1.8 m reference capsule) so a human can rotate the wolf and play every clip. Print the validation report at the end and fix anything that fails before finishing.

## Do not

- Do not use textures, image files, Draco, quantization or `KHR_texture_*`.
- Do not bake lighting into vertex colors (flat material colors only).
- Do not exceed 5 000 triangles or 1.5 MB.
- Do not change existing project files other than adding the three new scripts and the GLB.
