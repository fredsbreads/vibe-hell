import Phaser from "phaser";

const FIRE_INTERVAL_MS = 1400;
/** Random angular offset applied at fire time, +/- this many radians - "potentially imperfect aim" rather than a hitscan-perfect shot every time. */
const AIM_IMPERFECTION_RAD = 0.35;

/**
 * A pooled enemy for the time-dilation mode: sits in place (no movement
 * pattern yet - deliberately simple for a first pass, since the timescale
 * mechanic itself is already carrying most of the depth) and periodically
 * fires a projectile at the player with a random aim offset. Its own fire
 * cooldown is driven by the caller's world-scaled delta (see step()), same
 * as everything else in "the world" - standing still to stall an enemy's
 * next shot is a real, intentional tactic, not a bug.
 *
 * Dies in exactly one hit (Slash or a deflected/friendly projectile) -
 * touching an enemy's body does not damage the player; only its projectiles
 * do.
 */
export class Enemy extends Phaser.GameObjects.Image {
  static readonly RADIUS = 14;

  private fireCooldownRemainingMs = 0;
  private alive = false;

  constructor(scene: Phaser.Scene) {
    super(scene, 0, 0, "time-enemy");
    scene.add.existing(this);
    this.setActive(false);
    this.setVisible(false);
  }

  activate(x: number, y: number): void {
    this.setPosition(x, y);
    this.fireCooldownRemainingMs = FIRE_INTERVAL_MS;
    this.alive = true;
    this.setActive(true);
    this.setVisible(true);
  }

  deactivate(): void {
    this.alive = false;
    this.setActive(false);
    this.setVisible(false);
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /**
   * Advances the fire cooldown by the caller's world-scaled delta. Returns
   * the angle to fire at (with imperfection applied) once the cooldown
   * elapses, or null otherwise - the caller (the scene) owns actually
   * spawning a TimeProjectile, this class only decides when/which way.
   */
  step(worldScaledDelta: number, playerX: number, playerY: number): number | null {
    this.fireCooldownRemainingMs -= worldScaledDelta;
    if (this.fireCooldownRemainingMs > 0) {
      return null;
    }
    this.fireCooldownRemainingMs = FIRE_INTERVAL_MS;

    const trueAngle = Math.atan2(playerY - this.y, playerX - this.x);
    return trueAngle + (Math.random() * 2 - 1) * AIM_IMPERFECTION_RAD;
  }
}
