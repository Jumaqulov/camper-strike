import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorldDefinition } from '../../../../shared/world';
// Importing the 08B visual modules must not perturb shared gameplay data.
import '../CharacterAssetRegistry';
import '../../animation/CamperBuddyAnimator';
import '../../animation/locomotionState';

// Stage 08B-CHAR-INTEGRATION — sub-agent D: visual-only change guard

const SRC = fileURLToPath(new URL('../../../../', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('BOSQICH 08B-CHAR — Invariant: faqat vizual o‘zgarish (gameplay daxlsiz)', () => {
  it('1. forest_square seed 6501: gameplayHash 670a9c21f0565c94, worldVersion 2, 36 spawn', () => {
    const w = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 });
    assert.equal(w.gameplayHash, '670a9c21f0565c94');
    assert.equal(w.worldVersion, 2);
    assert.equal(w.spawnPoints.length, 36);
    const again = createWorldDefinition({ mapId: 'forest_square', publicLayoutSeed: 6501 });
    assert.equal(again.gameplayHash, w.gameplayHash, 'deterministik');
  });

  it('2. src/shared va src/server 08B character/animation modullarini import qilmaydi', () => {
    const offenders: string[] = [];
    for (const dir of ['shared', 'server']) {
      for (const file of walk(join(SRC, dir))) {
        const text = readFileSync(file, 'utf8');
        if (/from\s+['"][^'"]*(character\/Character|animation\/(CamperBuddyAnimator|locomotionState))/.test(text)) {
          offenders.push(file);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
