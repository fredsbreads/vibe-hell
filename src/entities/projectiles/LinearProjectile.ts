import Phaser from "phaser";
import { ArenaBounds } from "../../config/arena";

/** How far past the arena wall a projectile must drift before it's considered escaped. */
const ESCAPE_MARGIN = 80;

/**
 * Shared base for pooled projectiles that aim at the player once on spawn
 * and travel in a straight line (no wall bounce). Subclasses just supply a
 * speed/radius/texture and decide what "step" means for their trajectory.
 * Toggled via setActive/setVisible rather than created/destroyed for pooling.
 */
export abstract class LinearProjectile extends Phaser.GameObjects.Image {
  readonly radius: number;

  protected readonly speed: number;
  protected vx = 0;
  protected vy = 0;

  constructor(scene: Phaser.Scene, textureKey: string, speed: number, radius: number) {
    super(scene, 0, 0, textureKey);
    this.speed = speed;
    this.radius = radius;
    scene.add.existing(this);
    this.setActive(false);
    this.setVisible(false);
  }

  activate(x: number, y: number, targetX: number, targetY: number): void {
    this.setPosition(x, y);
    const angle = Math.atan2(targetY - y, targetX - x);
    this.vx = Math.cos(angle) * this.speed;
    this.vy = Math.sin(angle) * this.speed;
    this.setActive(true);
    this.setVisible(true);
  }

  deactivate(): void {
    this.setActive(false);
    this.setVisible(false);
  }

  protected move(delta: number): void {
    const dt = delta / 1000;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  protected hasEscaped(arena: ArenaBounds): boolean {
    const dist = Math.hypot(this.x - arena.centerX, this.y - arena.centerY);
    return dist > arena.radius + ESCAPE_MARGIN;
  }

  /** Advances the projectile. Returns true once it should be despawned (e.g. flew past the wall). */
  abstract step(delta: number, arena: ArenaBounds): boolean;
}
