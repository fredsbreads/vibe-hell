import Phaser from "phaser";
import { Arena } from "../../arena/Arena";
import { LinearProjectile } from "./LinearProjectile";

export const ZOOMER_PROJECTILE_SPEED = 460;
export const ZOOMER_PROJECTILE_RADIUS = 6;

/**
 * A pooled Zoomer threat: fires dead straight at high speed and does not
 * bounce, so it exits the arena (and gets scored as an escaped threat)
 * rather than lingering. Countered by dashing through it (i-frames), or by
 * a well-timed slash; regular contact deals damage like any other threat.
 */
export class ZoomerProjectile extends LinearProjectile {
  constructor(scene: Phaser.Scene) {
    super(scene, "zoomer-projectile", ZOOMER_PROJECTILE_SPEED, ZOOMER_PROJECTILE_RADIUS);
  }

  step(delta: number, arena: Arena, _playerX: number, _playerY: number): boolean {
    if (!this.move(delta, arena)) {
      return false;
    }
    return this.hasEscaped(arena);
  }
}
