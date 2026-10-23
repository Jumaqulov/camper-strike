import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../constants';
import { MAP, type MaterialKind } from '../map';
import { collidesAt } from '../physics';
import { fullAmmo, WEAPON_SLOTS, WEAPONS } from '../weapons';
import { validateMapSpawns } from '../../server/room';

describe('Legacy Dust Arena baseline (MAP)', () => {
  it('has 100x70m bounds centered at origin', () => {
    assert.deepEqual(MAP.bounds, {
      minX: -50,
      maxX: 50,
      minZ: -35,
      maxZ: 35,
    });
    assert.equal(MAP.bounds.maxX - MAP.bounds.minX, 100);
    assert.equal(MAP.bounds.maxZ - MAP.bounds.minZ, 70);
  });

  it('contains 104 valid AABB collider boxes with expected material distribution', () => {
    assert.equal(MAP.boxes.length, 104);

    const counts: Record<MaterialKind, number> = {
      ground: 0,
      wall: 0,
      concrete: 0,
      crate: 0,
      metal: 0,
      roof: 0,
    };

    for (const b of MAP.boxes) {
      assert.ok(b.max.x > b.min.x, `Box width must be positive: ${JSON.stringify(b)}`);
      assert.ok(b.max.y > b.min.y, `Box height must be positive: ${JSON.stringify(b)}`);
      assert.ok(b.max.z > b.min.z, `Box depth must be positive: ${JSON.stringify(b)}`);
      counts[b.mat]++;
    }

    assert.deepEqual(counts, {
      ground: 1,
      concrete: 36,
      wall: 30,
      roof: 1,
      crate: 32,
      metal: 4,
    });
  });

  it('contains 39 spawn points (13 red, 13 blue, 13 ffa) all inside bounds and free of colliders', () => {
    assert.equal(MAP.spawns.length, 39);

    const byTeam = { red: 0, blue: 0, none: 0 };
    for (const s of MAP.spawns) {
      byTeam[s.team]++;
      assert.ok(
        s.x >= MAP.bounds.minX + PLAYER_RADIUS && s.x <= MAP.bounds.maxX - PLAYER_RADIUS,
        `Spawn X out of bounds: (${s.x}, ${s.z})`,
      );
      assert.ok(
        s.z >= MAP.bounds.minZ + PLAYER_RADIUS && s.z <= MAP.bounds.maxZ - PLAYER_RADIUS,
        `Spawn Z out of bounds: (${s.x}, ${s.z})`,
      );
      assert.equal(
        collidesAt(MAP.boxes, s.x, 0.01, s.z, PLAYER_RADIUS, PLAYER_HEIGHT),
        false,
        `Spawn (${s.x}, ${s.z}) overlaps a collider`,
      );
    }

    assert.deepEqual(byTeam, { red: 13, blue: 13, none: 13 });
    assert.deepEqual(validateMapSpawns(), []);
  });

  it('legacy TDM/FFA fullAmmo() helper populates all 4 weapon slots (baseline behavior before forest_survival)', () => {
    const ammo = fullAmmo();
    assert.equal(WEAPON_SLOTS.length, 4);
    for (const id of WEAPON_SLOTS) {
      assert.equal(ammo[id].mag, WEAPONS[id].magSize);
      assert.equal(ammo[id].reserve, WEAPONS[id].reserve);
    }
  });
});
