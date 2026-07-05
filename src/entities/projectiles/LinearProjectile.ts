import Phaser from "phaser";
import { Arena } from "../../arena/Arena";

/** How far past the arena wall a projectile must drift before it's considered escaped. */
const ESCAPE_MARGIN = 80;

/** How long a projectile sits still at its spawn point, telegraphing its arrival, before it starts moving. */
const SPAWN_TELEGRAPH_MS = 400;
const TELEGRAPH_START_ALPHA = 0.35;

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
  protected telegraphRemainingMs = 0;
  /** World angle (from the arena center) this projectile spawned at - used to keep it riding the perimeter while telegraphing, even as the arena rotates underneath it. */
  private perimeterAngle = 0;

  private readonly maxLifetimeMs: number;
  private lifetimeRemainingMs: number;

  /**
   * maxLifetimeMs is Infinity by default (no cap) - only threat types that can
   * linger indefinitely by bouncing (Basic, Chaser) pass a real value. Zoomer
   * doesn't bounce and already self-clears by exiting the arena, so it has no
   * need for one.
   */
  constructor(scene: Phaser.Scene, textureKey: string, speed: number, radius: number, maxLifetimeMs = Infinity) {
    super(scene, 0, 0, textureKey);
    this.speed = speed;
    this.radius = radius;
    this.maxLifetimeMs = maxLifetimeMs;
    this.lifetimeRemainingMs = maxLifetimeMs;
    scene.add.existing(this);
    this.setActive(false);
    this.setVisible(false);
  }

  activate(x: number, y: number, targetX: number, targetY: number, arena: Arena): void {
    this.setPosition(x, y);
    this.perimeterAngle = Math.atan2(y - arena.bounds.centerY, x - arena.bounds.centerX);
    const angle = Math.atan2(targetY - y, targetX - x);
    this.vx = Math.cos(angle) * this.speed;
    this.vy = Math.sin(angle) * this.speed;
    this.telegraphRemainingMs = SPAWN_TELEGRAPH_MS;
    this.lifetimeRemainingMs = this.maxLifetimeMs;
    this.setAlpha(TELEGRAPH_START_ALPHA);
    this.setActive(true);
    this.setVisible(true);
  }

  deactivate(): void {
    this.setActive(false);
    this.setVisible(false);
  }

  /**
   * Advances the telegraph timer and fades the sprite in while it's still
   * telegraphing; otherwise moves it along its velocity. Returns false while
   * still telegraphing (hasn't started moving yet), so subclasses know to
   * skip bounce/escape checks for this step. While telegraphing, keeps
   * re-anchoring to the arena's current boundary at its original spawn
   * bearing, so a rotating arena carries it along the perimeter instead of
   * leaving it sitting at a fixed point while the wall rotates out from
   * under it (and it launches from a spot that no longer matches the wall).
   */
  protected move(delta: number, arena: Arena): boolean {
    if (this.telegraphRemainingMs > 0) {
      this.telegraphRemainingMs = Math.max(0, this.telegraphRemainingMs - delta);
      const progress = 1 - this.telegraphRemainingMs / SPAWN_TELEGRAPH_MS;
      this.setAlpha(TELEGRAPH_START_ALPHA + (1 - TELEGRAPH_START_ALPHA) * progress);
      const point = arena.boundaryPointAtAngle(this.perimeterAngle);
      this.setPosition(point.x, point.y);
      return false;
    }

    this.lifetimeRemainingMs -= delta;

    const dt = delta / 1000;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    return true;
  }

  protected hasEscaped(arena: Arena): boolean {
    const dx = this.x - arena.bounds.centerX;
    const dy = this.y - arena.bounds.centerY;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    return dist > arena.maxRadiusAtAngle(angle) + ESCAPE_MARGIN;
  }

  /**
   * True once a capped-lifetime projectile has been alive (excluding its
   * spawn telegraph) longer than maxLifetimeMs - a bouncing threat that never
   * happens to escape on its own otherwise lingers indefinitely. Always false
   * for types with no cap (maxLifetimeMs left at the Infinity default).
   */
  protected hasExpired(): boolean {
    return this.lifetimeRemainingMs <= 0;
  }

  /**
   * Advances the projectile. Returns true once it should be despawned (e.g.
   * flew past the wall). playerX/playerY are provided for subclasses (like
   * Chaser) that re-aim at the player mid-flight; most ignore them.
   */
  abstract step(delta: number, arena: Arena, playerX: number, playerY: number): boolean;
}
