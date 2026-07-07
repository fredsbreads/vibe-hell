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

  /**
   * Moves and bounces off the arena wall. Returns true if it has drifted well
   * past the wall, used up all its bounces after being deflected, or (while
   * still hostile) lived past its 10s cap, and should be despawned. The 10s
   * cap only applies before deflection - once deflected, its original
   * lifetime countdown (which keeps ticking in the background regardless) no
   * longer applies, so despawning is driven solely by the bounce cap instead
   * of potentially cutting a late-life deflect short. A 3rd-tier deflect
   * stops bouncing entirely (see deflectTier gating below) so it bursts
   * straight through the wall and escapes instead of bouncing again.
   */
  step(delta: number, arena: Arena, _playerX: number, _playerY: number): boolean {
    if (!this.move(delta, arena)) {
      return false;
    }

    if (this.deflectTier < 3) {
      this.bounceOffWall(arena);
      if (this.hasUsedAllDeflectedBounces()) {
        return true;
      }
    }

    if (this.deflected) {
      return this.hasEscaped(arena);
    }

    return this.hasEscaped(arena) || this.hasExpired();
  }
}
