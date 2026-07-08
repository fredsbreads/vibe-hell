import Phaser from "phaser";
import { Arena } from "../arena/Arena";

const ESCAPE_MARGIN = 80;

/** How many times a deflected projectile can bounce off the wall before despawning - same cap the original game's deflect used. */
const DEFLECT_MAX_BOUNCES = 3;
const DEFLECT_TINT = 0x59f2c8;

/**
 * How long, in real (undilated) ms, a just-deflected projectile keeps moving
 * at full un-scaled speed before dropping into being world-time-scaled like
 * everything else. Without this, redirecting a bullet while the world is
 * nearly frozen would make it look like it barely moved at all - the burst
 * sells "that connected" regardless of the current timescale.
 */
const DEFLECT_BURST_MS = 90;

/** Minimum real-ms gap between trail ghosts, so a slow (near-frozen) projectile doesn't spawn an unreadable pile of overlapping copies in one spot. */
const TRAIL_INTERVAL_MS = 45;
const TRAIL_ALPHA = 0.35;
const TRAIL_FADE_MS = 220;

/**
 * A pooled bullet for the time-dilation mode. Aims at the player once at
 * spawn (an enemy applies its own aim imperfection before calling activate),
 * travels in a straight line, mirror-bounces off the arena wall. Movement is
 * driven by the caller passing in an already-world-scaled delta each frame
 * (see step()) - this class doesn't know about WorldClock itself, it just
 * moves by whatever delta it's handed, which is what makes the deflect burst
 * work: the burst window uses the real delta, everything else uses the
 * world-scaled one.
 */
export class TimeProjectile extends Phaser.GameObjects.Image {
  readonly radius: number;
  private readonly speed: number;

  private vx = 0;
  private vy = 0;
  private isDeflected = false;
  private deflectedBounceCount = 0;
  private deflectBurstRemainingMs = 0;
  private trailTimerMs = 0;

  constructor(scene: Phaser.Scene, textureKey: string, speed: number, radius: number) {
    super(scene, 0, 0, textureKey);
    this.speed = speed;
    this.radius = radius;
    scene.add.existing(this);
    this.setActive(false);
    this.setVisible(false);
  }

  activate(x: number, y: number, aimAngle: number): void {
    this.setPosition(x, y);
    this.vx = Math.cos(aimAngle) * this.speed;
    this.vy = Math.sin(aimAngle) * this.speed;
    this.isDeflected = false;
    this.deflectedBounceCount = 0;
    this.deflectBurstRemainingMs = 0;
    this.trailTimerMs = 0;
    this.clearTint();
    this.setAlpha(1);
    this.setActive(true);
    this.setVisible(true);
  }

  deactivate(): void {
    this.setActive(false);
    this.setVisible(false);
  }

  get deflected(): boolean {
    return this.isDeflected;
  }

  /** Redirects along the player's aim angle at this projectile's own speed, unchanged - friendly from here on, with a brief real-time burst before it starts being world-time-scaled. */
  deflect(aimAngle: number): void {
    this.isDeflected = true;
    this.deflectedBounceCount = 0;
    this.deflectBurstRemainingMs = DEFLECT_BURST_MS;
    this.vx = Math.cos(aimAngle) * this.speed;
    this.vy = Math.sin(aimAngle) * this.speed;
    this.setTintFill(DEFLECT_TINT);
  }

  /**
   * Advances the projectile and bounces it off the wall. worldScaledDelta is
   * whatever the caller has already multiplied by the current world
   * timescale - this class just moves by it, except during the brief
   * post-deflect burst window, where it moves by the real (unscaled) delta
   * instead so the redirect always reads as an immediate, decisive hit.
   * Returns true once it should be despawned.
   */
  step(realDelta: number, worldScaledDelta: number, arena: Arena): boolean {
    let effectiveDelta = worldScaledDelta;
    if (this.deflectBurstRemainingMs > 0) {
      effectiveDelta = realDelta;
      this.deflectBurstRemainingMs = Math.max(0, this.deflectBurstRemainingMs - realDelta);
    }

    this.spawnTrailIfDue(effectiveDelta);

    const dt = effectiveDelta / 1000;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.bounceOffWall(arena);
    if (this.isDeflected && this.deflectedBounceCount >= DEFLECT_MAX_BOUNCES) {
      return true;
    }

    return this.hasEscaped(arena);
  }

  private hasEscaped(arena: Arena): boolean {
    const dx = this.x - arena.bounds.centerX;
    const dy = this.y - arena.bounds.centerY;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    return dist > arena.maxRadiusAtAngle(angle) + ESCAPE_MARGIN;
  }

  private bounceOffWall(arena: Arena): void {
    const dx = this.x - arena.bounds.centerX;
    const dy = this.y - arena.bounds.centerY;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);
    if (distFromCenter === 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = arena.maxRadiusAtAngle(angle) - this.radius;
    if (distFromCenter <= maxDist) {
      return;
    }

    const scale = maxDist / distFromCenter;
    this.x = arena.bounds.centerX + dx * scale;
    this.y = arena.bounds.centerY + dy * scale;

    const n = arena.normalAtAngle(angle);
    const dot = this.vx * n.x + this.vy * n.y;
    this.vx -= 2 * dot * n.x;
    this.vy -= 2 * dot * n.y;

    if (this.isDeflected) {
      this.deflectedBounceCount++;
    }
  }

  /** Fading afterimages so a projectile crawling along at a near-frozen timescale still reads as clearly moving/directional, not just sitting still. */
  private spawnTrailIfDue(effectiveDelta: number): void {
    this.trailTimerMs += effectiveDelta;
    if (this.trailTimerMs < TRAIL_INTERVAL_MS) {
      return;
    }
    this.trailTimerMs = 0;

    const ghost = this.scene.add.image(this.x, this.y, this.texture.key);
    if (this.isDeflected) {
      ghost.setTintFill(DEFLECT_TINT);
    }
    ghost.setAlpha(TRAIL_ALPHA);
    ghost.setScale(this.scaleX, this.scaleY);
    this.scene.tweens.add({
      targets: ghost,
      alpha: 0,
      duration: TRAIL_FADE_MS,
      onComplete: () => ghost.destroy(),
    });
  }
}
