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
 * Deflected Zoomers behave like any other deflected projectile though -
 * bouncing off the wall (capped) rather than flying straight through it,
 * until a 3rd-tier deflect stops the bouncing and bursts it straight out.
 */
export class ZoomerProjectile extends LinearProjectile {
  constructor(scene: Phaser.Scene) {
    super(scene, "zoomer-projectile", ZOOMER_PROJECTILE_SPEED, ZOOMER_PROJECTILE_RADIUS);
  }

  step(delta: number, arena: Arena, _playerX: number, _playerY: number): boolean {
    if (!this.move(delta, arena)) {
      return false;
    }
    if (this.deflected && this.deflectTier < 3) {
      this.bounceOffWall(arena);
      if (this.hasUsedAllDeflectedBounces()) {
        return true;
      }
    }
    return this.hasEscaped(arena);
  }
}
