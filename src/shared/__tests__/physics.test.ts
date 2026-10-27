import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JUMP_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS, STEP_HEIGHT } from '../constants';
import {
  applyWorldMovement,
  boxOverlap,
  collidesAt,
  pointInsideBoxes,
  rayBox,
  raycastBoxes,
  rayVsPlayer,
  stepProjectileInWorld,
  type Body,
} from '../physics';
import type { Box } from '../world';
import { boxCollider, makeFlatWorld } from './flatWorldFixture';

const groundBox: Box = {
  min: { x: -20, y: -1, z: -20 },
  max: { x: 20, y: 0, z: 20 },
  mat: 'ground',
};

describe('Shared physics (src/shared/physics.ts)', () => {
  it('detects AABB overlap and clearance via boxOverlap and collidesAt', () => {
    const wall: Box = {
      min: { x: 2, y: 0, z: -1 },
      max: { x: 3, y: 3, z: 1 },
      mat: 'wall',
    };
    const boxes = [groundBox, wall];

    assert.equal(boxOverlap(0, 0.01, 0, PLAYER_RADIUS, PLAYER_HEIGHT, wall), false);
    assert.equal(boxOverlap(2 - PLAYER_RADIUS + 0.05, 0.01, 0, PLAYER_RADIUS, PLAYER_HEIGHT, wall), true);
    assert.equal(collidesAt(boxes, 0, 0.01, 0), false);
    assert.equal(collidesAt(boxes, 2.2, 0.01, 0), true);
  });

  it('settles body onto flat terrain and supports jumping via applyWorldMovement', () => {
    const world = makeFlatWorld([]);
    const body: Body = {
      pos: { x: 0, y: 0.5, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: false,
    };

    for (let i = 0; i < 30; i++) {
      applyWorldMovement(body, 0, 0, false, 1 / 30, world);
    }
    assert.equal(body.onGround, true);
    assert.ok(Math.abs(body.pos.y) < 1e-3, `Expected y ~ 0, got ${body.pos.y}`);

    applyWorldMovement(body, 0, 0, true, 1 / 30, world);
    assert.equal(body.onGround, false);
    assert.ok(body.pos.y > 0, 'Jumping from ground should increase y');
    assert.ok(body.vel.y > JUMP_SPEED - 1.5, 'Vertical velocity should reflect jump impulse minus one gravity step');

    // Sakrashdan keyin yana yerga qo'nadi
    for (let i = 0; i < 90; i++) {
      applyWorldMovement(body, 0, 0, false, 1 / 30, world);
    }
    assert.equal(body.onGround, true);
    assert.ok(Math.abs(body.pos.y) < 1e-3, `Expected landing at y ~ 0, got ${body.pos.y}`);
  });

  it('steps up low obstacles (<= STEP_HEIGHT) but stops at tall walls', () => {
    const lowStepWorld = makeFlatWorld([
      boxCollider('low_step', { x: 1, y: 0, z: -2 }, { x: 3, y: 0.4, z: 2 }, 'concrete'),
    ]);
    assert.ok(0.4 <= STEP_HEIGHT);

    const climber: Body = {
      pos: { x: 0.4, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 10; i++) {
      applyWorldMovement(climber, 5, 0, false, 1 / 30, lowStepWorld);
    }
    assert.ok(climber.pos.y >= 0.4, `Expected climber to step onto 0.4m box, got y=${climber.pos.y}`);
    assert.ok(climber.pos.x > 1.0, `Expected climber to advance past step edge, got x=${climber.pos.x}`);

    const tallWall = boxCollider('tall_wall', { x: 1, y: 0, z: -2 }, { x: 3, y: 2.5, z: 2 }, 'wall');
    const tallWallWorld = makeFlatWorld([tallWall]);
    const blocked: Body = {
      pos: { x: 0.4, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 10; i++) {
      applyWorldMovement(blocked, 5, 0, false, 1 / 30, tallWallWorld);
    }
    assert.ok(
      blocked.pos.x <= tallWall.min.x - PLAYER_RADIUS + 1e-3,
      `Expected tall wall to block x movement, got x=${blocked.pos.x}`,
    );
    assert.equal(blocked.vel.x, 0);
    assert.ok(Math.abs(blocked.pos.y) < 1e-3, 'Blocked body stays on the ground');
  });

  it('clamps the body to world bounds', () => {
    const world = makeFlatWorld([], { size: 20 });
    const runner: Body = {
      pos: { x: 8, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 60; i++) {
      applyWorldMovement(runner, 6, 0, false, 1 / 30, world);
    }
    assert.ok(runner.pos.x <= world.bounds.maxX - PLAYER_RADIUS + 1e-6, `Expected bounds clamp, got x=${runner.pos.x}`);
    assert.ok(runner.pos.x > world.bounds.maxX - PLAYER_RADIUS - 0.5);
  });

  it('computes accurate raycast hits, surface normals, and head/body hitboxes', () => {
    const nearWall: Box = {
      min: { x: -1, y: 0, z: -5 },
      max: { x: 1, y: 3, z: -4 },
      mat: 'wall',
    };
    const farWall: Box = {
      min: { x: -2, y: 0, z: -10 },
      max: { x: 2, y: 3, z: -9 },
      mat: 'wall',
    };

    const hitSingle = rayBox({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, nearWall.min, nearWall.max, 50);
    assert.ok(hitSingle);
    assert.ok(Math.abs(hitSingle.t - 4) < 1e-6);
    assert.equal(hitSingle.nz, 1);

    const hitMulti = raycastBoxes([farWall, nearWall], { x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, 50);
    assert.ok(hitMulti);
    assert.ok(Math.abs(hitMulti.t - 4) < 1e-6, 'raycastBoxes should return closest hit');

    const targetFeet = { x: 0, y: 0, z: -6 };
    const headHit = rayVsPlayer({ x: 0, y: 1.65, z: 0 }, { x: 0, y: 0, z: -1 }, targetFeet, 20);
    assert.ok(headHit);
    assert.equal(headHit.head, true);

    const bodyHit = rayVsPlayer({ x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: -1 }, targetFeet, 20);
    assert.ok(bodyHit);
    assert.equal(bodyHit.head, false);
  });

  it('bounces projectiles off terrain and collider boxes via stepProjectileInWorld (pointInsideBoxes)', () => {
    assert.equal(pointInsideBoxes([groundBox], { x: 0, y: -0.5, z: 0 }), true);
    assert.equal(pointInsideBoxes([groundBox], { x: 0, y: 1.0, z: 0 }), false);

    // 1) Yerga tushgan granata qaytadi va relyef ostiga kirmaydi
    const flat = makeFlatWorld([]);
    const gren = {
      pos: { x: 0, y: 0.3, z: 0 },
      vel: { x: 2, y: -6, z: 0 },
    };
    let bounced = false;
    for (let i = 0; i < 10; i++) {
      if (stepProjectileInWorld(gren, 1 / 30, flat)) bounced = true;
    }
    assert.equal(bounced, true);
    assert.ok(gren.pos.y >= 0, 'Grenade should not penetrate terrain');

    // 2) Devorga uchib borgan granata X bo'yicha orqaga qaytadi
    const wallWorld = makeFlatWorld([
      boxCollider('wall', { x: 3, y: 0, z: -2 }, { x: 4, y: 3, z: 2 }, 'wall'),
    ]);
    const shot = {
      pos: { x: 0, y: 1.2, z: 0 },
      vel: { x: 12, y: 0, z: 0 },
    };
    let wallBounce = false;
    for (let i = 0; i < 20; i++) {
      if (stepProjectileInWorld(shot, 1 / 30, wallWorld)) wallBounce = true;
    }
    assert.equal(wallBounce, true);
    assert.ok(shot.vel.x < 0, `Expected grenade to bounce back from wall, got vel.x=${shot.vel.x}`);
    assert.ok(shot.pos.x < 3, `Grenade must stay outside the wall box, got x=${shot.pos.x}`);
  });
});
