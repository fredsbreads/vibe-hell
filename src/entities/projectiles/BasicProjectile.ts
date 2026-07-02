import Phaser from "phaser";
import { ArenaBounds } from "../../config/arena";
import { LinearProjectile } from "./LinearProjectile";

export const BASIC_PROJECTILE_SPEED = 160;
export const BASIC_PROJECTILE_RADIUS = 8;

/**
 * A pooled Basic threat: aims at the player once on spawn, then travels in a
 * straight line and mirror-bounces off the arena wall, per the GDD's
 * "highly predictable" wave 1-2 deflection rule.
 */
export class BasicProjectile extends LinearProjectile {
  constructor(scene: Phaser.Scene) {
    super(scene, "basic-projectile", BASIC_PROJECTILE_SPEED, BASIC_PROJECTILE_RADIUS);
  }

  /** Moves and bounces off the arena wall. Returns true if it has drifted well past the wall and should be despawned. */
  step(delta: number, arena: ArenaBounds): boolean {
    this.move(delta);

    const dx = this.x - arena.centerX;
    const dy = this.y - arena.centerY;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);
    const maxDist = arena.radius - this.radius;

    if (distFromCenter > maxDist && distFromCenter > 0) {
      const nx = dx / distFromCenter;
      const ny = dy / distFromCenter;

      this.x = arena.centerX + nx * maxDist;
      this.y = arena.centerY + ny * maxDist;

      const dot = this.vx * nx + this.vy * ny;
      this.vx -= 2 * dot * nx;
      this.vy -= 2 * dot * ny;
    }

    return this.hasEscaped(arena);
  }
}
