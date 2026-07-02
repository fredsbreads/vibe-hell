import Phaser from "phaser";
import { ArenaBounds } from "../../config/arena";

export const BASIC_PROJECTILE_SPEED = 160;
export const BASIC_PROJECTILE_RADIUS = 8;

/** How far past the arena wall a projectile must drift before it's considered escaped (safety net for future non-bouncing types). */
const ESCAPE_MARGIN = 80;

/**
 * A pooled Basic threat: aims at the player once on spawn, then travels in a
 * straight line and mirror-bounces off the arena wall, per the GDD's
 * "highly predictable" wave 1-2 deflection rule. Toggled via
 * setActive/setVisible rather than created/destroyed for pooling.
 */
export class BasicProjectile extends Phaser.GameObjects.Image {
  readonly radius = BASIC_PROJECTILE_RADIUS;

  private vx = 0;
  private vy = 0;

  constructor(scene: Phaser.Scene) {
    super(scene, 0, 0, "basic-projectile");
    scene.add.existing(this);
    this.setActive(false);
    this.setVisible(false);
  }

  activate(x: number, y: number, targetX: number, targetY: number): void {
    this.setPosition(x, y);
    const angle = Math.atan2(targetY - y, targetX - x);
    this.vx = Math.cos(angle) * BASIC_PROJECTILE_SPEED;
    this.vy = Math.sin(angle) * BASIC_PROJECTILE_SPEED;
    this.setActive(true);
    this.setVisible(true);
  }

  deactivate(): void {
    this.setActive(false);
    this.setVisible(false);
  }

  /** Moves and bounces off the arena wall. Returns true if it has drifted well past the wall and should be despawned. */
  step(delta: number, arena: ArenaBounds): boolean {
    const dt = delta / 1000;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

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

    return distFromCenter > arena.radius + ESCAPE_MARGIN;
  }
}
