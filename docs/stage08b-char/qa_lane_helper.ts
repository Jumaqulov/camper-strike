/**
 * STAGE 08B-CHAR QA helper (agent E) — long-lived JSON-lines process used by `scripts/qa-stage08b-char.mjs`.
 *
 * Builds the exact server/client world (`createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed })`)
 * from `<root>/src/shared` and answers geometry questions with the SHARED movement code
 * (`stepPlayerMovement`, same as client prediction + server authority) and the server bot NavGraph:
 *   {cmd:'meta'}                                  → world meta (gameplayHash, worldVersion)
 *   {cmd:'bestLane', minLen, walk?}               → longest straight, flat, collider-free run lane (close-up + side-cam clear)
 *   {cmd:'runRoute', from:{x,z}, length, maxSegments?} → greedy multi-segment clear running route from a position
 *   {cmd:'navPath', from:{x,z}, to:{x,z}}         → NavGraph path (server bot nav) as waypoints
 *   {cmd:'containerApproach', from, containers:[{id,position,interactionRadius}]} → reachable approach points sorted by path length
 *
 * Usage: node <tsx-cli> docs/stage08b-char/qa_lane_helper.ts <root> <seed>   (one JSON request per stdin line)
 */
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? process.cwd();
const seed = Number(process.argv[3] ?? 6501);
const imp = (rel: string) => import(pathToFileURL(path.join(root, rel)).href);

/* eslint-disable @typescript-eslint/no-explicit-any */
const worldMod: any = await imp('src/shared/world.ts');
const netMod: any = await imp('src/shared/netMovement.ts');
const terrMod: any = await imp('src/shared/terrain.ts');
const physMod: any = await imp('src/shared/physics.ts');
const roadsMod: any = await imp('src/shared/forestSquareRoads.ts');
const navMod: any = await imp('src/server/navgraph.ts');
const lootVal: any = await imp('src/shared/loot/validation.ts');

const world: any = worldMod.createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: seed });
const H = (x: number, z: number): number => terrMod.sampleTerrainHeight(world.terrain, x, z);
let nav: any = null;
const getNav = () => (nav ??= navMod.getNav(world));

type XZ = { x: number; z: number };
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fwdOf = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const rightOf = (yaw: number) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });

/** Simulates holding W (pistol speedMul 1.0 → 6.5 m/s run / 3.0 m/s walk) with the shared movement code. */
function simulateStraight(x: number, z: number, yaw: number, maxLen: number, walk = false) {
  const state: any = { pos: { x, y: H(x, z), z }, vel: { x: 0, y: 0, z: 0 }, onGround: true, yaw, pitch: 0, weapon: 'pistol', scoped: false };
  const f = fwdOf(yaw);
  const speed = walk ? 3.0 : 6.5;
  const maxSteps = Math.ceil((maxLen / speed) * 60) + 30;
  const prog: number[] = [];
  let minY = state.pos.y;
  let maxY = state.pos.y;
  let maxStepDy = 0;
  let prevY = state.pos.y;
  let len = 0;
  let lateral = 0;
  for (let i = 0; i < maxSteps; i++) {
    netMod.stepPlayerMovement(
      state,
      { seq: i + 1, spawnId: 1, dt: 1 / 60, moveForward: 1, moveRight: 0, jump: false, walk, scoped: false, weapon: 'pistol', yaw, pitch: 0 },
      world,
    );
    const dx = state.pos.x - x;
    const dz = state.pos.z - z;
    const p = dx * f.x + dz * f.z;
    lateral = Math.max(lateral, Math.abs(dx * -f.z + dz * f.x));
    prog.push(p);
    minY = Math.min(minY, state.pos.y);
    maxY = Math.max(maxY, state.pos.y);
    maxStepDy = Math.max(maxStepDy, Math.abs(state.pos.y - prevY));
    prevY = state.pos.y;
    len = p;
    if (p >= maxLen) break;
    // blocked: progress over the last 20 steps < 35 % of nominal
    if (i > 40 && p - prog[i - 20] < (speed / 60) * 20 * 0.35) break;
    if (lateral > 1.2) break; // slid along an obstacle → not a straight lane any more
  }
  return {
    len: r3(len),
    end: { x: r3(state.pos.x), y: r3(state.pos.y), z: r3(state.pos.z) },
    yRange: r3(maxY - minY),
    maxStepDy: r3(maxStepDy),
    lateral: r3(lateral),
  };
}

function losClear(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const L = Math.hypot(d.x, d.y, d.z) || 1e-6;
  const hit = physMod.raycastWorld(world, a, { x: d.x / L, y: d.y / L, z: d.z / L }, L);
  return !hit || hit.t >= L - 0.05;
}
const camPointClear = (x: number, z: number, h: number) => {
  const y = H(x, z);
  return !physMod.collidesAtWorld(world, x, y + h - 0.3, z, 0.3, 0.6);
};

/** fraction of lane samples from which a side camera at `side` (+1 right, -1 left) sees the player chest */
function sideClearRatio(start: XZ, yaw: number, len: number, side: number, dist = 4.2): number {
  const f = fwdOf(yaw);
  const r = rightOf(yaw);
  let ok = 0;
  let n = 0;
  for (let s = 0; s <= len; s += 2) {
    const px = start.x + f.x * s;
    const pz = start.z + f.z * s;
    const cx = px + r.x * dist * side;
    const cz = pz + r.z * dist * side;
    const cy = H(px, pz) + 1.15;
    n++;
    if (camPointClear(cx, cz, 1.15) && losClear({ x: cx, y: cy, z: cz }, { x: px, y: H(px, pz) + 1.0, z: pz })) ok++;
  }
  return n ? ok / n : 0;
}

function closeupClear(p: XZ, yaw: number, dist = 2.2): number {
  const f = fwdOf(yaw);
  const r = rightOf(yaw);
  const y = H(p.x, p.z);
  const views = [f, r, { x: -f.x, z: -f.z }];
  let ok = 0;
  for (const v of views) {
    const cx = p.x + v.x * dist;
    const cz = p.z + v.z * dist;
    if (camPointClear(cx, cz, 1.0) && losClear({ x: cx, y: y + 1.0, z: cz }, { x: p.x, y: y + 1.0, z: p.z })) ok++;
  }
  return ok / views.length;
}

function bestLane(minLen = 46) {
  const cands: Array<XZ & { yaws: number[] }> = [];
  const yawSweep = Array.from({ length: 24 }, (_, i) => (i / 24) * Math.PI * 2 - Math.PI);
  const roads: Array<{ id: string; width: number; points: XZ[] }> = roadsMod.getForestSquareRoadNetwork(seed);
  for (const rd of roads) {
    for (let i = 0; i < rd.points.length - 1; i += 1) {
      const a = rd.points[i];
      const b = rd.points[i + 1];
      const tanYaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
      cands.push({ x: a.x, z: a.z, yaws: [tanYaw, tanYaw + Math.PI, ...yawSweep.filter((_, k) => k % 3 === 0)] });
    }
  }
  for (let x = -96; x <= 96; x += 16) for (let z = -96; z <= 96; z += 16) cands.push({ x, z, yaws: yawSweep });
  let best: any = null;
  let evaluated = 0;
  for (const c of cands) {
    if (Math.abs(c.x) > 110 || Math.abs(c.z) > 110) continue;
    if (!terrMod.isTerrainWalkable(world.terrain, c.x, c.z)) continue;
    if (physMod.collidesAtWorld(world, c.x, H(c.x, c.z) + 0.05, c.z)) continue;
    for (const yaw of c.yaws) {
      evaluated++;
      const sim = simulateStraight(c.x, c.z, yaw, minLen + 4);
      if (sim.len < 20) continue;
      const lenScore = Math.min(sim.len, minLen + 4);
      const slopePenalty = sim.yRange * 0.6 + sim.maxStepDy * 20;
      let score = lenScore - slopePenalty - sim.lateral * 4;
      if (best && score + 12 < best.score) continue; // cheap prune before the expensive camera checks
      const ccl = closeupClear(c, yaw);
      const sideR = sideClearRatio(c, yaw, Math.min(sim.len, minLen), 1);
      const sideL = sideClearRatio(c, yaw, Math.min(sim.len, minLen), -1);
      const side = sideR >= sideL ? 1 : -1;
      const sideRatio = Math.max(sideR, sideL);
      score += ccl * 6 + sideRatio * 8;
      if (!best || score > best.score) {
        best = {
          start: { x: r3(c.x), y: r3(H(c.x, c.z)), z: r3(c.z) },
          yaw: r3(yaw),
          len: sim.len,
          end: sim.end,
          yRange: sim.yRange,
          maxStepDy: sim.maxStepDy,
          lateral: sim.lateral,
          closeupClear: r3(ccl),
          side,
          sideClearRatio: r3(sideRatio),
          score: r3(score),
        };
      }
    }
  }
  return { ...best, evaluated, candidates: cands.length };
}

function runRoute(from: XZ, length = 40, maxSegments = 5, walk = false) {
  const waypoints: Array<XZ> = [];
  let cur = { x: from.x, z: from.z };
  let prevYaw: number | null = null;
  let total = 0;
  const segs: Array<{ yaw: number; len: number }> = [];
  for (let s = 0; s < maxSegments && total < length; s++) {
    let best: { yaw: number; len: number; end: XZ; score: number } | null = null;
    for (let i = 0; i < 32; i++) {
      const yaw = (i / 32) * Math.PI * 2 - Math.PI;
      if (prevYaw !== null) {
        const d = Math.abs(Math.atan2(Math.sin(yaw - prevYaw), Math.cos(yaw - prevYaw)));
        if (d > (Math.PI * 2) / 3) continue; // no near-reversals
      }
      const sim = simulateStraight(cur.x, cur.z, yaw, length - total + 2, walk);
      const turnPenalty = prevYaw === null ? 0 : Math.abs(Math.atan2(Math.sin(yaw - prevYaw), Math.cos(yaw - prevYaw))) * 2;
      const score = Math.min(sim.len, length - total + 2) - sim.lateral * 3 - turnPenalty - sim.maxStepDy * 15;
      if (!best || score > best.score) best = { yaw, len: sim.len, end: sim.end, score };
    }
    if (!best || best.len < 3) break;
    // stop 1.2 m short of the obstacle so the driver turns before touching it
    const useLen = Math.max(2, best.len - (best.len < length - total ? 1.2 : 0));
    const f = fwdOf(best.yaw);
    const end = { x: r3(cur.x + f.x * useLen), z: r3(cur.z + f.z * useLen) };
    waypoints.push(end);
    segs.push({ yaw: r3(best.yaw), len: r3(useLen) });
    total += useLen;
    prevYaw = best.yaw;
    cur = end;
  }
  return { from, waypoints, segments: segs, totalLen: r3(total) };
}

function navPath(from: XZ, to: XZ) {
  const n = getNav();
  const pts = n.findPath({ x: from.x, y: H(from.x, from.z), z: from.z }, { x: to.x, y: H(to.x, to.z), z: to.z }) as Array<{ x: number; z: number }>;
  const wps = pts.map((p) => ({ x: r3(p.x), z: r3(p.z) }));
  const last = wps[wps.length - 1];
  const finalClear = last ? n.segmentClear({ x: last.x, y: H(last.x, last.z), z: last.z }, { x: to.x, y: H(to.x, to.z), z: to.z }) : false;
  if (last && Math.hypot(last.x - to.x, last.z - to.z) > 0.2) wps.push({ x: r3(to.x), z: r3(to.z) });
  let len = 0;
  let p = from;
  for (const w of wps) {
    len += Math.hypot(w.x - p.x, w.z - p.z);
    p = w;
  }
  return { ok: pts.length > 0, finalClear, waypoints: wps, len: r3(len) };
}

function containerApproach(from: XZ, containers: Array<{ id: string; position: { x: number; y: number; z: number }; interactionRadius: number }>) {
  const out: any[] = [];
  const sorted = [...containers]
    .sort((a, b) => Math.hypot(a.position.x - from.x, a.position.z - from.z) - Math.hypot(b.position.x - from.x, b.position.z - from.z))
    .slice(0, 30);
  for (const c of sorted) {
    const radius = Math.max(0.6, c.interactionRadius + 0.55 - 0.45);
    let bestA: any = null;
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2;
      for (const rr of [radius, radius * 0.75]) {
        const ax = c.position.x + Math.cos(ang) * rr;
        const az = c.position.z + Math.sin(ang) * rr;
        const ay = H(ax, az);
        if (physMod.collidesAtWorld(world, ax, ay + 0.05, az)) continue;
        if (Math.abs(ay + 0.9 - (c.position.y + 0.45)) > 2.2) continue;
        if (!lootVal.hasLineOfSightToContainer(world, { x: ax, y: ay + 1.62, z: az }, c.position, c.id)) continue;
        const np = navPath(from, { x: ax, z: az });
        if (!np.ok || !np.finalClear) continue;
        if (!bestA || np.len < bestA.pathLen)
          bestA = {
            id: c.id,
            approach: { x: r3(ax), z: r3(az) },
            waypoints: np.waypoints,
            pathLen: np.len,
            faceYaw: r3(Math.atan2(-(c.position.x - ax), -(c.position.z - az))),
          };
      }
    }
    if (bestA) out.push(bestA);
  }
  out.sort((a, b) => a.pathLen - b.pathLen);
  return { candidates: out.slice(0, 6) };
}

const handlers: Record<string, (req: any) => unknown> = {
  meta: () => ({
    mapId: world.mapId,
    worldVersion: world.worldVersion,
    gameplayHash: world.gameplayHash,
    publicLayoutSeed: world.publicLayoutSeed,
    spawnPoints: world.spawnPoints.length,
  }),
  bestLane: (r) => bestLane(r.minLen ?? 46),
  runRoute: (r) => runRoute(r.from, r.length ?? 40, r.maxSegments ?? 5, Boolean(r.walk)),
  navPath: (r) => navPath(r.from, r.to),
  containerApproach: (r) => containerApproach(r.from, r.containers ?? []),
  height: (r) => ({ y: r3(H(r.x, r.z)) }),
};

const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true, gameplayHash: world.gameplayHash, worldVersion: world.worldVersion }) + '\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req: any;
  try {
    req = JSON.parse(line);
    const fn = handlers[req.cmd];
    if (!fn) throw new Error(`unknown cmd ${req.cmd}`);
    const t0 = Date.now();
    const result = fn(req);
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, ms: Date.now() - t0, result }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: req?.id ?? null, ok: false, error: String((e as Error)?.stack ?? e) }) + '\n');
  }
});
rl.on('close', () => process.exit(0));
