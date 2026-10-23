import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JUMP_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS, STEP_HEIGHT } from '../constants';
import type { Box } from '../map';
import {
  applyMovement,
  boxOverlap,
  collidesAt,
   moveBody,
  pointInsideBoxes,
  rayBox,
  raycastBoxes,
  rayVsPlayer,
  stepProjectile,
  type Body,
} from '../physics';

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

  it('settles body onto ground and supports jumping via applyMovement', () => {
    const body: Body = {
      pos: { x: 0, y: 0.5, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: false,
    };

    for (let i = 0; i < 30; i++) {
      applyMovement(body, 0, 0, false, 1 / 30, [groundBox]);
    }
    assert.equal(body.onGround, true);
    assert.ok(Math.abs(body.pos.y) < 1e-3, `Expected y ~ 0, got ${body.pos.y}`);

    applyMovement(body, 0, 0, true, 1 / 30, [groundBox]);
    assert.equal(body.onGround, false);
    assert.ok(body.pos.y > 0, 'Jumping from ground should increase y');
    assert.ok(body.vel.y > JUMP_SPEED - 1.5, 'Vertical velocity should reflect jump impulse minus one gravity step');
  });

  it('steps up low obstacles (<= STEP_HEIGHT) but stops at tall walls', () => {
    const lowStep: Box = {
      min: { x: 1, y: 0, z: -2 },
      max: { x: 3, y: 0.4, z: 2 },
      mat: 'concrete',
    };
    assert.ok(0.4 <= STEP_HEIGHT);

    const climber: Body = {
      pos: { x: 0.4, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 10; i++) {
      applyMovement(climber, 5, 0, false, 1 / 30, [groundBox, lowStep]);
    }
    assert.ok(climber.pos.y >= 0.4, `Expected climber to step onto 0.4m box, got y=${climber.pos.y}`);
    assert.ok(climber.pos.x > 1.0, `Expected climber to advance past step edge, got x=${climber.pos.x}`);

    const tallWall: Box = {
      min: { x: 1, y: 0, z: -2 },
      max: { x: 3, y: 2.5, z: 2 },
      mat: 'wall',
    };
    const blocked: Body = {
      pos: { x: 0.4, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: true,
    };
    for (let i = 0; i < 10; i++) {
      applyMovement(blocked, 5, 0, false, 1 / 30, [groundBox, tallWall]);
    }
    assert.ok(
      blocked.pos.x <= tallWall.min.x - PLAYER_RADIUS + 1e-3,
      `Expected tall wall to block x movement, got x=${blocked.pos.x}`,
    );
    assert.equal(blocked.vel.x, 0);
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

  it('bounces projectiles against collider boxes via stepProjectile and pointInsideBoxes', () => {
    assert.equal(pointInsideBoxes([groundBox], { x: 0, y: -0.5, z: 0 }), true);
    assert.equal(pointInsideBoxes([groundBox], { x: 0, y: 1.0, z: 0 }), false);

    const gren = {
      pos: { x: 0, y: 0.3, z: 0 },
      vel: { x: 2, y: -6, z: 0 },
    };
    let bounced = false;
    for (let i = 0; i < 10; i++) {
      if (stepProjectile(gren, 1 / 30, [groundBox])) bounced = true;
    }
    assert.equal(bounced, true);
    assert.ok(gren.pos.y >= 0, 'Grenade should not penetrate ground box');
  });
});
