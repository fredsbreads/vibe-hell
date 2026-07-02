import Phaser from "phaser";
import { Arena } from "../../arena/Arena";
import { LinearProjectile } from "./LinearProjectile";

export const CHASER_PROJECTILE_SPEED = 260;
export const CHASER_PROJECTILE_RADIUS = 7;

/**
 * A pooled Chaser threat: fast and straight-line like a Zoomer, but bounces
 * off the arena wall like Basic - except instead of a predictable mirror
 * reflection, it re-aims dead at the player's current position at the
 * instant of each bounce. It never settles into a fixed rebound path, so
 * unlike Basic/Zoomer it will rarely "naturally" fly off and score itself;
 * Slash or a well-timed Dash are the reliable counters. Slower than a pure
 * Zoomer to offset how much more threatening persistent re-aiming is.
 */
export class ChaserProjectile extends LinearProjectile {
  constructor(scene: Phaser.Scene) {
    super(scene, "chaser-projectile", CHASER_PROJECTILE_SPEED, CHASER_PROJECTILE_RADIUS);
  }

  step(delta: number, arena: Arena, playerX: number, playerY: number): boolean {
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

        const reaimAngle = Math.atan2(playerY - this.y, playerX - this.x);
        this.vx = Math.cos(reaimAngle) * this.speed;
        this.vy = Math.sin(reaimAngle) * this.speed;
      }
    }

    return this.hasEscaped(arena);
  }
}
