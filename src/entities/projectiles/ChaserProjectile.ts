import Phaser from "phaser";
import { ArenaBounds } from "../../config/arena";
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

  step(delta: number, arena: ArenaBounds, playerX: number, playerY: number): boolean {
    if (!this.move(delta)) {
      return false;
    }

    const dx = this.x - arena.centerX;
    const dy = this.y - arena.centerY;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);
    const maxDist = arena.radius - this.radius;

    if (distFromCenter > maxDist && distFromCenter > 0) {
      const nx = dx / distFromCenter;
      const ny = dy / distFromCenter;
      this.x = arena.centerX + nx * maxDist;
      this.y = arena.centerY + ny * maxDist;

      const angle = Math.atan2(playerY - this.y, playerX - this.x);
      this.vx = Math.cos(angle) * this.speed;
      this.vy = Math.sin(angle) * this.speed;
    }

    return this.hasEscaped(arena);
  }
}
