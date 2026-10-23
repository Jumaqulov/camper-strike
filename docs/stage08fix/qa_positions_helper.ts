/**
 * STAGE 08-FIX QA helper (agent F): generates deterministic camera poses and capsule-walk probes on
 * `forest_square` seed 6501 from a source root (default: the PRE-FIX snapshot) so BEFORE and AFTER
 * browser runs use byte-identical coordinates. The output JSON (`qa_camera_poses.json`) is read by
 * `scripts/qa-stage08fix.mjs`; regenerate only if you intentionally want new angles.
 *
 * Usage:  npx tsx docs/stage08fix/qa_positions_helper.ts [rootDir] [seed] [outJson]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? 'd:\\Stickman-strike-backup-pre08fix';
const seed = Number(process.argv[3] ?? 6501);
const outJson = process.argv[4] ?? null;

const imp = (rel: string) => import(pathToFileURL(path.join(root, rel)).href);

const fsq = await imp('src/shared/forestSquare.ts');
const terr = await imp('src/shared/terrain.ts');
const w = fsq.createForestSquareWorld({ publicLayoutSeed: seed });
const H = (x: number, z: number) => terr.sampleTerrainHeight(w.terrain, x, z) as number;
const road = (x: number, z: number) => fsq.sampleForestSquareRoad(x, z, seed);
const sites = fsq.getForestSquarePoiSites(seed);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

type P3 = { x: number; y: number; z: number };
type V = { id: string; category: string; batchKey: string; transform: { position: P3; yaw: number; scale: P3 } };
const visuals = w.visuals as V[];
const trees = visuals.filter((v) => v.category === 'tree' && !v.id.startsWith('sq_vista'));
const byKey = (k: string) => visuals.filter((v) => v.batchKey === k);
const logs = byKey('prop:fallen_log');
const stumps = byKey('prop:tree_stump');
const ferns = byKey('foliage:fern');
const rocks = visuals.filter((v) => v.category === 'rock');
const siteList = Object.values(sites) as Array<{ id: string; center: { x: number; z: number } }>;
const distToPoi = (x: number, z: number) => Math.min(...siteList.map((s) => Math.hypot(x - s.center.x, z - s.center.z)));
const nearestSpawn = (x: number, z: number) => Math.min(...w.spawnPoints.map((s: { x: number; z: number }) => Math.hypot(x - s.x, z - s.z)));
const countWithin = (arr: V[], x: number, z: number, r: number) => arr.filter((v) => Math.hypot(v.transform.position.x - x, v.transform.position.z - z) < r).length;
const nearestOf = (arr: V[], x: number, z: number, skip?: V) => Math.min(...arr.filter((t) => t !== skip).map((t) => Math.hypot(t.transform.position.x - x, t.transform.position.z - z)));
const nearestTree = (x: number, z: number) => nearestOf(trees, x, z);

/** Three.js YXZ camera {x,y,z,yaw,pitch} looking from eye to target (same as qa-stage08a.mjs). */
function lookAt(eye: P3, target: P3) {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const horiz = Math.hypot(dx, dz) || 1e-6;
  return { x: r3(eye.x), y: r3(eye.y), z: r3(eye.z), yaw: r4(Math.atan2(-dx, -dz)), pitch: r4(Math.atan2(dy, horiz)) };
}
/** camera/player yaw that faces from (x0,z0) toward (x1,z1) */
const yawToward = (x0: number, z0: number, x1: number, z1: number) => r4(Math.atan2(-(x1 - x0), -(z1 - z0)));

// ---------- 01 open forest ground ----------
let best01: { x: number; z: number; score: number } | null = null;
for (let x = -100; x <= 100; x += 4) {
  for (let z = -100; z <= 100; z += 4) {
    const rd = road(x, z).dist;
    if (rd < 12 || distToPoi(x, z) < 30 || Math.hypot(x + 14, z - 52) < 20) continue;
    if (nearestTree(x, z) < 3.5) continue;
    const n12 = countWithin(trees, x, z, 12);
    if (n12 < 5 || n12 > 12) continue;
    const slope = Math.abs(H(x + 2, z) - H(x - 2, z)) + Math.abs(H(x, z + 2) - H(x, z - 2));
    if (slope > 0.8) continue;
    const score = n12 - slope * 3 - Math.abs(Math.hypot(x, z) - 45) * 0.02;
    if (!best01 || score > best01.score) best01 = { x, z, score };
  }
}
if (!best01) throw new Error('no open-forest point');
const near01 = trees.filter((t) => Math.hypot(t.transform.position.x - best01!.x, t.transform.position.z - best01!.z) < 15);
const c01x = near01.reduce((s, t) => s + t.transform.position.x, 0) / near01.length;
const c01z = near01.reduce((s, t) => s + t.transform.position.z, 0) / near01.length;
const d01 = Math.hypot(c01x - best01.x, c01z - best01.z) || 1;
const look01 = { x: best01.x + ((c01x - best01.x) / d01) * 10, z: best01.z + ((c01z - best01.z) / d01) * 10 };

// ---------- 02 road edge ----------
let best02: { x: number; z: number; yaw: number; score: number } | null = null;
const mainRoad = (w.roadNetwork as Array<{ id: string; width: number; points: Array<{ x: number; z: number }> }>).find((r) => r.id === 'main_road')!;
for (let i = 1; i < mainRoad.points.length - 1; i++) {
  const a = mainRoad.points[i];
  const b = mainRoad.points[i + 1];
  const tx = b.x - a.x;
  const tz = b.z - a.z;
  const len = Math.hypot(tx, tz) || 1;
  const off = mainRoad.width * 0.5 + 1.3;
  const x = a.x + (-tz / len) * off;
  const z = a.z + (tx / len) * off;
  if (Math.abs(x) > 105 || Math.abs(z) > 105) continue;
  const dp = distToPoi(x, z);
  if (dp < 25 || nearestTree(x, z) < 2.5) continue;
  const score = countWithin(trees, x, z, 15) * 0.5 + Math.min(dp, 40) * 0.05;
  if (!best02 || score > best02.score) best02 = { x, z, yaw: Math.atan2(-tx, -tz), score };
}
if (!best02) throw new Error('no road-edge point');

// ---------- 04 tree roots / fern ----------
let best04: { tree: V; ferns: number } | null = null;
for (const t of trees) {
  const { x, z } = t.transform.position;
  if (road(x, z).dist < 8 || distToPoi(x, z) < 22) continue;
  const nf = countWithin(ferns, x, z, 3.5);
  if (!best04 || nf > best04.ferns) best04 = { tree: t, ferns: nf };
}
if (!best04) throw new Error('no fern tree');
const tp = best04.tree.transform.position;
const fernsNear = ferns.filter((f) => Math.hypot(f.transform.position.x - tp.x, f.transform.position.z - tp.z) < 3.5);
let fdx = fernsNear.reduce((s, f) => s + f.transform.position.x - tp.x, 0);
let fdz = fernsNear.reduce((s, f) => s + f.transform.position.z - tp.z, 0);
const fl = Math.hypot(fdx, fdz) || 1;
fdx /= fl;
fdz /= fl;
const eye04 = { x: tp.x + fdx * 4.2, z: tp.z + fdz * 4.2 };

// ---------- probes (hard objects) ----------
const probeOk = (v: V) => {
  const { x, z } = v.transform.position;
  return nearestSpawn(x, z) > 8 && road(x, z).dist > 6 && distToPoi(x, z) > 20 && nearestTree(x, z) > 3.0;
};
const pickLog = logs.filter(probeOk).sort((p, q) => q.transform.scale.x - p.transform.scale.x)[0];
const pickStump = stumps.filter(probeOk).sort((p, q) => q.transform.scale.x - p.transform.scale.x)[0];
const pickRock = rocks
  .filter((v) => probeOk(v) && nearestOf(rocks, v.transform.position.x, v.transform.position.z, v) > 6)
  .sort((p, q) => q.transform.scale.x - p.transform.scale.x)[0];
const placements = w.poiLayout.outdoorPlacements as Array<{ id: string; assetId: string; position: P3; rotationY: number }>;
const tent = placements.find((p) => p.id === 'poi:poi_forest_camp:out_1:forest_tent_01')!;
const isRot = (yaw: number) => Math.abs(Math.sin(2 * yaw)) > 0.05;
const railing = placements.find((p) => p.assetId === 'wooden_railing_01' && isRot(p.rotationY)) ?? placements.find((p) => p.assetId === 'wooden_railing_01')!;
const barrel = placements.find((p) => p.assetId === 'rusty_barrel_01' && isRot(p.rotationY)) ?? placements.find((p) => p.assetId === 'rusty_barrel_01')!;

type Probe = {
  id: string;
  objectId: string;
  kind: string;
  center: P3;
  start: { x: number; z: number; yOverride?: number };
  end: { x: number; z: number };
  /** optional multi-segment path; default = single segment to `end` with `maxSteps` */
  segments?: Array<{ to: { x: number; z: number }; maxSteps: number }>;
  walkYaw: number;
  maxSteps: number;
  expect: string;
  shotYaw: number; // player yaw for the 1P/3P screenshot at the final position
  fixedCam?: ReturnType<typeof lookAt>;
};
const probes: Probe[] = [];
const across = (id: string, kind: string, objectId: string, c: P3, dirX: number, dirZ: number, dist: number, expect: string, maxSteps = 110): Probe => {
  const start = { x: r3(c.x + dirX * dist), z: r3(c.z + dirZ * dist) };
  const end = { x: r3(c.x - dirX * dist), z: r3(c.z - dirZ * dist) };
  const walkYaw = yawToward(start.x, start.z, end.x, end.z);
  // fixed 3P-style camera: side-on, 4.5 m to the side of the walk line, 2.2 m up
  const sx = -dirZ;
  const sz = dirX;
  const eye = { x: c.x + sx * 4.5 + dirX * 1.5, y: H(c.x + sx * 4.5, c.z + sz * 4.5) + 2.2, z: c.z + sz * 4.5 + dirZ * 1.5 };
  return { id, objectId, kind, center: { x: r3(c.x), y: r3(c.y), z: r3(c.z) }, start, end, walkYaw, maxSteps, expect, shotYaw: walkYaw, fixedCam: lookAt(eye, { x: c.x, y: c.y + 0.4, z: c.z }) };
};

// fallen log: walk perpendicular to the log axis (local Z), through its center
{
  const t = pickLog.transform;
  const perpX = Math.sin(t.yaw);
  const perpZ = Math.cos(t.yaw);
  probes.push(across('log_cross', 'fallen_log', pickLog.id.replace(/:vis$/, ''), t.position, perpX, perpZ, 2.4, 'blocked_or_step_over (no walk-through at log height)'));
}
// stump: walk through center along -Z
{
  const t = pickStump.transform;
  probes.push(across('stump_cross', 'tree_stump', pickStump.id.replace(/:vis$/, ''), t.position, 0, 1, 2.2, 'blocked_or_step_over'));
}
// boulder: walk through center along -X
if (pickRock) {
  const t = pickRock.transform;
  probes.push(across('rock_cross', 'boulder', pickRock.id.replace(/:vis$/, ''), t.position, 1, 0, 3.2, 'blocked'));
}
// tent: entrance is local +Z  -> world (sin yaw, cos yaw); side is local +X -> (cos yaw, -sin yaw)
{
  const c = tent.position;
  const ex = Math.sin(tent.rotationY);
  const ez = Math.cos(tent.rotationY);
  const sx = Math.cos(tent.rotationY);
  const sz = -Math.sin(tent.rotationY);
  const startIn = { x: r3(c.x + ex * 3.0), z: r3(c.z + ez * 3.0) };
  const camEye = { x: c.x + ex * 5.2 + sx * 2.4, y: c.y + 2.4, z: c.z + ez * 5.2 + sz * 2.4 };
  const fixedCam = lookAt(camEye, { x: c.x, y: c.y + 0.6, z: c.z });
  probes.push({
    id: 'tent_enter', objectId: tent.id, kind: 'forest_tent_01', center: { x: r3(c.x), y: r3(c.y), z: r3(c.z) },
    start: startIn, end: { x: r3(c.x), z: r3(c.z) }, walkYaw: yawToward(startIn.x, startIn.z, c.x, c.z), maxSteps: 120,
    expect: 'reach center (dist<0.5)', shotYaw: yawToward(startIn.x, startIn.z, c.x, c.z), fixedCam,
  });
  probes.push({
    id: 'tent_exit', objectId: tent.id, kind: 'forest_tent_01', center: { x: r3(c.x), y: r3(c.y), z: r3(c.z) },
    start: { x: r3(c.x), z: r3(c.z) }, end: startIn, walkYaw: yawToward(c.x, c.z, startIn.x, startIn.z), maxSteps: 120,
    expect: 'exit through entrance (reach start point, dist<0.6)', shotYaw: yawToward(c.x, c.z, startIn.x, startIn.z), fixedCam,
  });
  const sideStart = { x: r3(c.x + sx * 2.6), z: r3(c.z + sz * 2.6) };
  probes.push({
    id: 'tent_side_wall', objectId: tent.id, kind: 'forest_tent_01', center: { x: r3(c.x), y: r3(c.y), z: r3(c.z) },
    start: sideStart, end: { x: r3(c.x - sx * 2.6), z: r3(c.z - sz * 2.6) }, walkYaw: yawToward(sideStart.x, sideStart.z, c.x, c.z), maxSteps: 110,
    expect: 'blocked by side wall (never reaches center)', shotYaw: yawToward(sideStart.x, sideStart.z, c.x, c.z), fixedCam,
  });
}
// rotated railing: walk across along its local Z (railing runs along local X)
{
  const c = railing.position;
  probes.push(across('railing_cross', 'wooden_railing_01', railing.id, c, Math.sin(railing.rotationY), Math.cos(railing.rotationY), 2.0, 'blocked'));
}
// barrel
{
  const c = barrel.position;
  probes.push(across('barrel_cross', 'rusty_barrel_01', barrel.id, c, 1, 0, 2.0, 'blocked'));
}
// cabin wall (poi_cabin_cluster bld:0 mod_09 wall_solid z≈-72.1, x 62..66): walk north from outside
const wallCol = (w.colliders as Array<{ id: string; min: P3; max: P3 }>).find((c) => c.id === 'poi:poi_cabin_cluster:bld:0:mod_09:wood_wall_01:wall_solid:col');
if (wallCol) {
  const cx = (wallCol.min.x + wallCol.max.x) / 2;
  const cz = (wallCol.min.z + wallCol.max.z) / 2;
  const c = { x: cx, y: wallCol.min.y, z: cz };
  probes.push(across('cabin_wall', 'building_wall', wallCol.id, c, 0, -1, 2.0, 'blocked'));
}
// cabin stairs to loft: inside bld:0. Stairs climb along +X (x 62.15 → 66.15, top 5.03) with a handrail on
// their +Z side from x=63.1, so a real player enters from +Z at the bottom (x≈62.6) and turns +X.
const stepCols = (w.colliders as Array<{ id: string; min: P3; max: P3 }>).filter((c) => c.id.startsWith('poi:poi_cabin_cluster:bld:0:mod_17:wood_stairs_01:stair_step_'));
if (stepCols.length) {
  const first = stepCols.find((c) => c.id.includes('stair_step_01'))!;
  const last = stepCols.find((c) => c.id.includes('stair_step_15'))!;
  const zMid = r3((first.min.z + first.max.z) / 2);
  const floorY = first.min.y;
  const bx = r3(Math.max(first.min.x + 0.45, 62.6));
  const start = { x: bx, z: r3(first.max.z + 1.05), yOverride: r3(floorY) };
  const mid = { x: bx, z: zMid };
  const end = { x: r3(last.max.x + 1.45), z: zMid };
  probes.push({
    id: 'cabin_stairs_loft', objectId: 'poi:poi_cabin_cluster:bld:0:mod_17:wood_stairs_01', kind: 'stairs_loft',
    center: { x: r3((first.min.x + last.max.x) / 2), y: r3(floorY), z: zMid }, start, end,
    segments: [{ to: mid, maxSteps: 60 }, { to: end, maxSteps: 160 }],
    walkYaw: yawToward(start.x, start.z, mid.x, mid.z), maxSteps: 220,
    expect: `climb to loft (final y ≈ ${r3(last.max.y)})`, shotYaw: yawToward(mid.x, mid.z, end.x, end.z),
  });
}

const s = Object.fromEntries(siteList.map((st) => [st.id, { x: st.center.x, z: st.center.z, y: r3(H(st.center.x, st.center.z)) }])) as Record<string, P3>;
const cab = s.poi_cabin_cluster;
const svc = s.poi_service_station;
const camp = s.poi_forest_camp;

const shots = [
  {
    file: '01_forest_ground.png', desc: `open forest ground eye-level (${best01.x},${best01.z}), ${countWithin(trees, best01.x, best01.z, 12)} trees within 12 m`,
    player: { x: best01.x, z: best01.z }, cam: lookAt({ x: best01.x, y: H(best01.x, best01.z) + 1.62, z: best01.z }, { x: look01.x, y: H(look01.x, look01.z) + 0.25, z: look01.z }),
  },
  {
    file: '02_road_edge.png', desc: `main_road shoulder (${r3(best02.x)},${r3(best02.z)}), looking along road`,
    player: { x: r3(best02.x), z: r3(best02.z) }, cam: { x: r3(best02.x), y: r3(H(best02.x, best02.z) + 1.62), z: r3(best02.z), yaw: r4(best02.yaw), pitch: -0.12 },
  },
  {
    file: '03_flower_glade.png', desc: 'loc_sq_south_glade (-14,52) from 9 m south, looking north',
    player: { x: -14, z: 61 }, cam: lookAt({ x: -14, y: H(-14, 61) + 1.7, z: 61 }, { x: -14, y: H(-14, 47) + 0.15, z: 47 }),
  },
  {
    file: '04_tree_roots_fern.png', desc: `tree ${best04.tree.id} base with ${best04.ferns} ferns within 3.5 m`,
    player: { x: r3(eye04.x), z: r3(eye04.z) }, cam: lookAt({ x: eye04.x, y: H(eye04.x, eye04.z) + 1.35, z: eye04.z }, { x: tp.x, y: tp.y + 0.45, z: tp.z }),
  },
  {
    file: '05_cabin_yard.png', desc: 'poi_cabin_cluster yard (same framing as 08A shot 04)',
    player: { x: cab.x - 1.2, z: cab.z + 2.2 }, cam: lookAt({ x: cab.x + 1.4, y: cab.y + 2.45, z: cab.z + 7.6 }, { x: cab.x + 0.4, y: cab.y + 0.95, z: cab.z - 3.0 }),
  },
  {
    file: '06_topdown.png', desc: 'top-down overview 256x256 (same framing as 08A shot 01)',
    player: { x: 0, z: -10 }, cam: lookAt({ x: 0, y: 175, z: 95 }, { x: 0, y: 0, z: -10 }),
  },
  {
    file: '06b_topdown_low_glade.png', desc: 'low top-down (38 m) over south glade — ground-cover distribution',
    player: { x: -14, z: 52 }, cam: lookAt({ x: -14, y: H(-14, 52) + 38, z: 70 }, { x: -14, y: H(-14, 50), z: 50 }),
  },
];

const benchScenes = [
  {
    id: 'open_forest', desc: 'open forest eye-level, deterministic ±1.2 rad camera yaw sweep (10 s period) at shot-01 pose',
    player: shots[0].player, cam: shots[0].cam, sweep: { amplitude: 1.2, periodSec: 10 },
  },
  {
    id: 'service_station', desc: 'poi_service_station forecourt (08A cam06 framing)',
    player: { x: svc.x + 0.8, z: svc.z + 3.6 }, cam: lookAt({ x: svc.x + 2.4, y: svc.y + 2.45, z: svc.z + 7.4 }, { x: svc.x - 3.6, y: svc.y + 0.95, z: svc.z - 0.6 }),
  },
  {
    id: 'forest_camp', desc: 'poi_forest_camp tents + campfire (08A cam07 framing)',
    player: { x: camp.x - 1.6, z: camp.z + 1.2 }, cam: lookAt({ x: camp.x - 3.8, y: camp.y + 2.45, z: camp.z + 3.8 }, { x: camp.x + 1.8, y: camp.y + 0.95, z: camp.z - 3.8 }),
  },
  {
    id: 'flower_glade', desc: 'south glade eye-level (shot-03 pose) — ground-cover heavy view',
    player: shots[2].player, cam: shots[2].cam,
  },
];

const out = {
  generatedFrom: root,
  generatedAt: new Date().toISOString(),
  seed,
  worldVersion: w.worldVersion,
  gameplayHash: w.gameplayHash,
  colliders: w.colliders.length,
  sites: s,
  shots,
  probes,
  benchScenes,
  notes: {
    log: { id: pickLog.id, transform: pickLog.transform, nearestSpawn: r3(nearestSpawn(pickLog.transform.position.x, pickLog.transform.position.z)) },
    stump: { id: pickStump.id, transform: pickStump.transform, nearestSpawn: r3(nearestSpawn(pickStump.transform.position.x, pickStump.transform.position.z)) },
    rock: pickRock ? { id: pickRock.id, transform: pickRock.transform } : null,
    tent,
    railing,
    barrel,
    fernTree: { id: best04.tree.id, ferns: best04.ferns },
  },
};
const json = JSON.stringify(out, null, 2);
if (outJson) fs.writeFileSync(outJson, json + '\n', 'utf8');
console.log(json);
