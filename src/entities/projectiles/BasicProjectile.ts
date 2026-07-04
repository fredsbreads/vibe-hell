import Phaser from "phaser";
import { Arena } from "../../arena/Arena";
import { LinearProjectile } from "./LinearProjectile";

export const BASIC_PROJECTILE_SPEED = 160;
export const BASIC_PROJECTILE_RADIUS = 8;

// Bouncing off walls means it has no guaranteed exit - without a cap it can
// linger indefinitely if it never happens to bounce out. Capped at 10s so it
// can't quietly accumulate over the course of a wave.
const MAX_LIFETIME_MS = 10000;

/**
 * A pooled Basic threat: aims at the player once on spawn, then travels in a
 * straight line and mirror-bounces off the arena wall, per the GDD's
 * "highly predictable" wave 1-2 deflection rule. Reflects off the true wall
 * normal (a flat edge's normal for polygon arenas, radial for a circle) so
 * the bounce looks correct regardless of arena shape.
 */
export class BasicProjectile extends LinearProjectile {
  constructor(scene: Phaser.Scene) {
    super(scene, "basic-projectile", BASIC_PROJECTILE_SPEED, BASIC_PROJECTILE_RADIUS, MAX_LIFETIME_MS);
  }

  /** Moves and bounces off the arena wall. Returns true if it has drifted well past the wall, or lived past its 10s cap, and should be despawned. */
  step(delta: number, arena: Arena, _playerX: number, _playerY: number): boolean {
    if (!this.move(delta)) {
      return false;
    }

    const dx = this.x - arena.bounds.centerX;
    const dy = this.y - arena.bounds.centerY;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);

    if (distFromCenter > 0) {
      const angle = Math.atan2(dy, dx);
      const maxDist = arena.maxRadiusAtAngle(angle) - this.radius;

      if (distFromCenter > maxDist) {
        const scale = maxDist / distFromCenter;
        this.x = arena.bounds.centerX + dx * scale;
        this.y = arena.bounds.centerY + dy * scale;

        const n = arena.normalAtAngle(angle);
        const dot = this.vx * n.x + this.vy * n.y;
        this.vx -= 2 * dot * n.x;
        this.vy -= 2 * dot * n.y;
      }
    }

    return this.hasEscaped(arena) || this.hasExpired();
  }
}
