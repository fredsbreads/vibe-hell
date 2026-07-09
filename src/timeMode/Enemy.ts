import Phaser from "phaser";
import { SeededRandom } from "./SeededRandom";

const FIRE_INTERVAL_MS = 1400;
/** Random angular offset applied at fire time, +/- this many radians - "potentially imperfect aim" rather than a hitscan-perfect shot every time. */
const AIM_IMPERFECTION_RAD = 0.35;

/**
 * How long before firing the wind-up telegraph (glow + scale) starts
 * (world-time-scaled, like the rest of the cooldown) - the aim angle
 * (imperfection included) is locked in the moment this begins, not
 * re-rolled each frame.
 */
const TELEGRAPH_DURATION_MS = 250;

const BASE_COLOR = 0xff6b4a;
const CHARGED_COLOR = 0xffe98a;

/**
 * A pooled enemy for the time-dilation mode: sits in place (no movement
 * pattern yet - deliberately simple for a first pass, since the timescale
 * mechanic itself is already carrying most of the depth) and periodically
 * fires a projectile at the player with a random aim offset. Its own fire
 * cooldown (and telegraph) is driven by the caller's world-scaled delta (see
 * step()), same as everything else in "the world" - standing still to stall
 * an enemy's next shot is a real, intentional tactic, not a bug.
 *
 * Dies in exactly one hit (Slash or a deflected/friendly projectile) -
 * touching an enemy's body does not damage the player; only its projectiles
 * do.
 */
export class Enemy extends Phaser.GameObjects.Image {
  static readonly RADIUS = 14;

  private fireCooldownRemainingMs = 0;
  private alive = false;
  private telegraphActive = false;
  private telegraphAngleValue = 0;

  constructor(
    scene: Phaser.Scene,
    private readonly rng: SeededRandom,
  ) {
    super(scene, 0, 0, "time-enemy");
    scene.add.existing(this);
    this.setActive(false);
    this.setVisible(false);
  }

  activate(x: number, y: number): void {
    this.setPosition(x, y);
    this.fireCooldownRemainingMs = FIRE_INTERVAL_MS;
    this.alive = true;
    this.telegraphActive = false;
    this.clearTint();
    this.setScale(1);
    this.setActive(true);
    this.setVisible(true);
  }

  deactivate(): void {
    this.alive = false;
    this.telegraphActive = false;
    this.setActive(false);
    this.setVisible(false);
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /**
   * Advances the fire cooldown by the caller's world-scaled delta, and the
   * wind-up visual (tint/scale pulsing toward CHARGED_COLOR) once telegraphing
   * starts. Returns the angle to fire at once the cooldown elapses, or null
   * otherwise - the caller (the scene) owns actually spawning a
   * TimeProjectile, this class only decides when/which way.
   */
  step(worldScaledDelta: number, playerX: number, playerY: number): number | null {
    this.fireCooldownRemainingMs -= worldScaledDelta;

    if (!this.telegraphActive && this.fireCooldownRemainingMs <= TELEGRAPH_DURATION_MS) {
      this.telegraphActive = true;
      const trueAngle = Math.atan2(playerY - this.y, playerX - this.x);
      this.telegraphAngleValue = trueAngle + (this.rng.next() * 2 - 1) * AIM_IMPERFECTION_RAD;
    }

    if (this.telegraphActive) {
      const progress = 1 - Math.max(0, this.fireCooldownRemainingMs) / TELEGRAPH_DURATION_MS;
      this.setTintFill(Phaser.Display.Color.Interpolate.ColorWithColor(
        Phaser.Display.Color.ValueToColor(BASE_COLOR),
        Phaser.Display.Color.ValueToColor(CHARGED_COLOR),
        100,
        progress * 100,
      ).color);
      this.setScale(1 + progress * 0.25);
    }

    if (this.fireCooldownRemainingMs > 0) {
      return null;
    }

    this.fireCooldownRemainingMs = FIRE_INTERVAL_MS;
    this.telegraphActive = false;
    this.clearTint();
    this.setScale(1);
    return this.telegraphAngleValue;
  }
}
