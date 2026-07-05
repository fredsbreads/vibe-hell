import Phaser from "phaser";
import { Arena } from "../../arena/Arena";
import { LinearProjectile } from "./LinearProjectile";

export const CHASER_PROJECTILE_SPEED = 260;
export const CHASER_PROJECTILE_RADIUS = 7;

// Re-aiming at each bounce means it almost never naturally escapes on its own
// (see class doc below) - without a cap it would linger far longer than any
// other type. Same 10s cap as Basic.
const MAX_LIFETIME_MS = 10000;

/**
 * A pooled Chaser threat: fast and straight-line like a Zoomer, but bounces
 * off the arena wall like Basic - except instead of a predictable mirror
 * reflection, it re-aims dead at the player's current position at the
 * instant of each bounce. It never settles into a fixed rebound path, so
 * unlike Basic/Zoomer it will rarely "naturally" fly off and score itself;
 * Slash, a well-timed Dash, or its own 10s lifetime cap are the reliable ways
 * it goes away. Slower than a pure Zoomer to offset how much more threatening
 * persistent re-aiming is. A deflected Chaser loses the re-aim entirely -
 * it bounces like any other deflected projectile (capped), rather than
 * continuing to hunt anything down.
 */
export class ChaserProjectile extends LinearProjectile {
  constructor(scene: Phaser.Scene) {
    super(scene, "chaser-projectile", CHASER_PROJECTILE_SPEED, CHASER_PROJECTILE_RADIUS, MAX_LIFETIME_MS);
  }

  step(delta: number, arena: Arena, playerX: number, playerY: number): boolean {
    if (!this.move(delta, arena)) {
      return false;
    }

    if (this.deflected) {
      this.bounceOffWall(arena);
      if (this.hasUsedAllDeflectedBounces()) {
        return true;
      }
      return this.hasEscaped(arena) || this.hasExpired();
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

        const reaimAngle = Math.atan2(playerY - this.y, playerX - this.x);
        this.vx = Math.cos(reaimAngle) * this.speed;
        this.vy = Math.sin(reaimAngle) * this.speed;
      }
    }

    return this.hasEscaped(arena) || this.hasExpired();
  }
}
