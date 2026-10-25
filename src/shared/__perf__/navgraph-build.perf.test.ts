import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createForestSquareWorld } from '../forestSquare';
import { NavGraph } from '../../server/navgraph';

/**
 * 08B-FINAL-QA — NavGraph(forest_square) build-time budget, split out of the functional suite.
 *
 * Methodology: run alone (`npm run test:perf` → `--test-concurrency=1`), so other test files do not
 * compete for the CPU; record the cold build (first in the process, includes JIT warm-up) and the
 * median of 5 warm builds. The 250 ms budget is the original Stage 04B limit — unchanged.
 */
const BUDGET_MS = 250;
const WARM_RUNS = 5;

describe('PERF — NavGraph(forest_square) qurilish vaqti (serial, warm-up + median)', () => {
  it(`cold build va ${WARM_RUNS} ta warm build median < ${BUDGET_MS} ms`, (t) => {
    const world = createForestSquareWorld({ publicLayoutSeed: 6501 });

    const c0 = performance.now();
    const cold = new NavGraph(world);
    const coldMs = performance.now() - c0;
    assert.equal(cold.nx, 64);

    const warm: number[] = [];
    for (let i = 0; i < WARM_RUNS; i++) {
      const w0 = performance.now();
      new NavGraph(world);
      warm.push(performance.now() - w0);
    }
    const sorted = [...warm].sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)];
    t.diagnostic(
      `cold=${coldMs.toFixed(1)} ms, warm median=${medianMs.toFixed(1)} ms, warm=[${warm.map((x) => x.toFixed(1)).join(', ')}]`,
    );

    assert.ok(coldMs < BUDGET_MS, `NavGraph cold build < ${BUDGET_MS} ms bo'lishi shart (actual=${coldMs.toFixed(1)} ms)`);
    assert.ok(medianMs < BUDGET_MS, `NavGraph warm median < ${BUDGET_MS} ms bo'lishi shart (actual=${medianMs.toFixed(1)} ms)`);
  });
});
