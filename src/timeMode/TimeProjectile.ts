import Phaser from "phaser";
import { Arena } from "../arena/Arena";

const ESCAPE_MARGIN = 80;

/** How many times a deflected projectile can bounce off the wall before despawning - same cap the original game's deflect used. */
const DEFLECT_MAX_BOUNCES = 3;
const DEFLECT_TINT = 0x59f2c8;
/** Deflected projectiles fly faster than the hostile speed they arrived at, on top of the real-time burst - reads as more dangerous/decisive, and outruns the enemy that fired it in the first place. */
const DEFLECT_SPEED_MULTIPLIER = 1.6;

/**
 * How long, in real (undilated) ms, a just-deflected projectile keeps moving
 * at full un-scaled speed before dropping into being world-time-scaled like
 * everything else. Without this, redirecting a bullet while the world is
 * nearly frozen would make it look like it barely moved at all - the burst
 * sells "that connected" regardless of the current timescale.
 */
const DEFLECT_BURST_MS = 300;

/**
 * Length (px) of the directional tail drawn behind the projectile, pointing
 * back the way it came. Drawn as several progressively shorter/fainter
 * segments to fake a taper, since Graphics strokes don't support a real
 * gradient. Deliberately long/opaque - this needs to read clearly even when
 * the world (and so the projectile itself) is moving at a near-frozen
 * timescale, where a plain fading-afterimage trail was too subtle to notice.
 */
const TAIL_LENGTH = 46;
const TAIL_SEGMENTS = 5;
const TAIL_MAX_ALPHA = 0.85;

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
  private readonly baseColor: number;
  private readonly tailGraphic: Phaser.GameObjects.Graphics;

  private vx = 0;
  private vy = 0;
  private isDeflected = false;
  private deflectedBounceCount = 0;
  private deflectBurstRemainingMs = 0;

  constructor(scene: Phaser.Scene, textureKey: string, speed: number, radius: number, baseColor: number) {
    super(scene, 0, 0, textureKey);
    this.speed = speed;
    this.radius = radius;
    this.baseColor = baseColor;
    this.tailGraphic = scene.add.graphics();
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
    this.clearTint();
    this.setAlpha(1);
    this.setActive(true);
    this.setVisible(true);
    this.tailGraphic.setVisible(true);
  }

  deactivate(): void {
    this.setActive(false);
    this.setVisible(false);
    this.tailGraphic.setVisible(false);
  }

  get deflected(): boolean {
    return this.isDeflected;
  }

  /** Redirects along the player's aim angle at a boosted speed (see DEFLECT_SPEED_MULTIPLIER) - friendly from here on, with a brief real-time burst before it starts being world-time-scaled. */
  deflect(aimAngle: number): void {
    this.isDeflected = true;
    this.deflectedBounceCount = 0;
    this.deflectBurstRemainingMs = DEFLECT_BURST_MS;
    const deflectSpeed = this.speed * DEFLECT_SPEED_MULTIPLIER;
    this.vx = Math.cos(aimAngle) * deflectSpeed;
    this.vy = Math.sin(aimAngle) * deflectSpeed;
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

    const dt = effectiveDelta / 1000;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.bounceOffWall(arena);
    this.redrawTail();

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

  /**
   * Draws a tapered line from the projectile back toward where it came from
   * (opposite its current velocity), redrawn fresh every step so it always
   * points the right way even after a bounce or a deflect. A handful of
   * progressively shorter/fainter segments fake a taper, since Graphics
   * strokes don't support a real gradient - reads far more clearly as "this
   * is moving in direction X" than a handful of sparse fading afterimages
   * did, which matters a lot when the projectile itself might be crawling
   * along at a near-frozen world timescale.
   */
  private redrawTail(): void {
    this.tailGraphic.clear();
    const speed = Math.hypot(this.vx, this.vy);
    if (speed === 0) {
      return;
    }
    const dirX = this.vx / speed;
    const dirY = this.vy / speed;
    const color = this.isDeflected ? DEFLECT_TINT : this.baseColor;

    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      const segStart = (i / TAIL_SEGMENTS) * TAIL_LENGTH;
      const segEnd = ((i + 1) / TAIL_SEGMENTS) * TAIL_LENGTH;
      const alpha = TAIL_MAX_ALPHA * (1 - i / TAIL_SEGMENTS);
      const width = this.radius * (1 - i / TAIL_SEGMENTS) * 0.9;
      this.tailGraphic.lineStyle(Math.max(1, width), color, alpha);
      this.tailGraphic.lineBetween(this.x - dirX * segStart, this.y - dirY * segStart, this.x - dirX * segEnd, this.y - dirY * segEnd);
    }
  }
}
