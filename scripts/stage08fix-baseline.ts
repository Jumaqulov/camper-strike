/**
 * STAGE 08-FIX — deterministic world baseline dump (gameplayHash, counts, prop colliders, tent capsule probes).
 * Usage: npx tsx scripts/stage08fix-baseline.ts [seed ...]
 */
import { createForestSquareWorld } from '../src/shared/forestSquare';
import { collidesAtWorld, isSpawnPointSafe } from '../src/shared/physics';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../src/shared/constants';
import { getOutdoorPlacementSummary } from '../src/shared/outdoor/outdoorPlacements';

const seeds = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
if (seeds.length === 0) seeds.push(6501, 1, 42, 1337, 2024, 9001, 77777, 123456);

for (const seed of seeds) {
  const w = createForestSquareWorld({ publicLayoutSeed: seed });
  const byKey = new Map<string, number>();
  for (const v of w.visuals) byKey.set(v.batchKey, (byKey.get(v.batchKey) ?? 0) + 1);
  const colSrc = new Set(w.colliders.map((c) => c.sourceObjectId).filter(Boolean));
  const logs = w.visuals.filter((v) => v.batchKey === 'prop:fallen_log');
  const stumps = w.visuals.filter((v) => v.batchKey === 'prop:tree_stump');
  const logWithCol = logs.filter((v) => colSrc.has(v.sourceObjectId)).length;
  const stumpWithCol = stumps.filter((v) => colSrc.has(v.sourceObjectId)).length;
  const logBlocked = logs.filter((v) =>
    collidesAtWorld(w, v.transform.position.x, v.transform.position.y + 0.01, v.transform.position.z, PLAYER_RADIUS, PLAYER_HEIGHT),
  ).length;
  const stumpBlocked = stumps.filter((v) =>
    collidesAtWorld(w, v.transform.position.x, v.transform.position.y + 0.01, v.transform.position.z, PLAYER_RADIUS, PLAYER_HEIGHT),
  ).length;
  const unsafeSpawns = w.spawnPoints.filter((s) => !isSpawnPointSafe(w, s)).length;
  const tents = (w.poiLayout.outdoorPlacements ?? []).filter((p) => p.assetId === 'forest_tent_01');
  const tentProbe = tents.map((t) => ({
    id: t.id,
    yaw: t.rotationY,
    centerBlocked: collidesAtWorld(w, t.position.x, t.position.y + 0.01, t.position.z, PLAYER_RADIUS, PLAYER_HEIGHT),
  }));
  let summary: unknown = null;
  try {
    summary = getOutdoorPlacementSummary(w.poiLayout.outdoorPlacements ?? []);
  } catch {
    summary = 'n/a';
  }
  console.log(
    JSON.stringify(
      {
        seed,
        worldVersion: w.worldVersion,
        gameplayHash: w.gameplayHash,
        colliders: w.colliders.length,
        spawns: w.spawnPoints.length,
        unsafeSpawns,
        containers: w.containerLocations.length,
        visuals: w.visuals.length,
        trees: byKey.get('tree:pine_tall'),
        batchCounts: Object.fromEntries([...byKey.entries()].sort()),
        logs: logs.length,
        logWithCol,
        logBlocked,
        stumps: stumps.length,
        stumpWithCol,
        stumpBlocked,
        tentProbe,
        outdoorSummary: summary,
      },
      null,
      seed === seeds[0] ? 2 : 0,
    ),
  );
}
