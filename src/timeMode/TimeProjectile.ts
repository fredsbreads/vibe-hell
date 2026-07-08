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
 *
 * Each segment is drawn using the heading the projectile actually had that
 * far back along its path (see headingHistory), not just its current
 * velocity - so a curving chaser (or a ricochet that just re-aimed off a
 * bounce) shows a visibly bent tail instead of a straight line extrapolated
 * from its current direction. Sampled by distance traveled rather than by
 * frame, so the tail always represents the same ~TAIL_LENGTH of actual path
 * regardless of framerate or how dilated the world currently is.
 */
const TAIL_LENGTH = 46;
const TAIL_SEGMENTS = 8;
const TAIL_SEGMENT_LENGTH = TAIL_LENGTH / TAIL_SEGMENTS;
const TAIL_MAX_ALPHA = 0.85;

/**
 * How a hostile projectile moves after firing, picked per-shot by the enemy
 * (see TimeManager.fireProjectile) - equal odds across all four for now.
 * - straight: the original behavior, flies dead straight, mirror-bounces off walls.
 * - zoomer: same as straight, just faster.
 * - chaser: continuously curves toward the player's CURRENT position at a
 *   capped turn rate (see CHASER_TURN_RATE) - still juke-able, since it can't
 *   snap instantly onto you.
 * - ricochet: flies straight like a normal shot, but re-aims dead-on at the
 *   player at the moment of each wall bounce, instead of mirror-reflecting.
 * All of this stops the instant a projectile is deflected - see deflect().
 */
export type ProjectileKind = "straight" | "zoomer" | "chaser" | "ricochet";

const BASE_SPEED = 200;
/** How fast (rad/s, world-time-scaled) a chaser can turn its velocity toward the player. Capped rather than instant so it stays dodgeable. */
const CHASER_TURN_RATE = 2.5;

/** Speed and color per kind - color doubles as the tail's color, so each kind reads as visually distinct at a glance. */
const KIND_CONFIG: Record<ProjectileKind, { speed: number; color: number }> = {
  straight: { speed: BASE_SPEED, color: 0xf2e85c },
  zoomer: { speed: BASE_SPEED * 2, color: 0xff6b35 },
  chaser: { speed: BASE_SPEED, color: 0xc86bff },
  ricochet: { speed: BASE_SPEED, color: 0xff4fc3 },
};

/**
 * A pooled bullet for the time-dilation mode. Aims at the player once at
 * spawn (an enemy applies its own aim imperfection before calling activate),
 * then moves according to its kind (see ProjectileKind) and mirror-bounces
 * off the arena wall (unless it's a ricochet re-aiming instead). Movement is
 * driven by the caller passing in an already-world-scaled delta each frame
 * (see step()) - this class doesn't know about WorldClock itself, it just
 * moves by whatever delta it's handed, which is what makes the deflect burst
 * work: the burst window uses the real delta, everything else uses the
 * world-scaled one.
 */
export class TimeProjectile extends Phaser.GameObjects.Image {
  readonly radius: number;
  private speed = BASE_SPEED;
  private baseColor = KIND_CONFIG.straight.color;
  private kind: ProjectileKind = "straight";
  private readonly tailGraphic: Phaser.GameObjects.Graphics;

  private vx = 0;
  private vy = 0;
  private isDeflected = false;
  private deflectedBounceCount = 0;
  private deflectBurstRemainingMs = 0;

  /** Recent velocity headings (radians), oldest first, sampled every TAIL_SEGMENT_LENGTH of travel - see the TAIL_LENGTH doc comment above. */
  private readonly headingHistory: number[] = [];
  private distanceSinceLastSample = 0;

  constructor(scene: Phaser.Scene, textureKey: string, radius: number) {
    super(scene, 0, 0, textureKey);
    this.radius = radius;
    this.tailGraphic = scene.add.graphics();
    scene.add.existing(this);
    this.setActive(false);
    this.setVisible(false);
  }

  activate(x: number, y: number, aimAngle: number, kind: ProjectileKind = "straight"): void {
    const config = KIND_CONFIG[kind];
    this.kind = kind;
    this.speed = config.speed;
    this.baseColor = config.color;
    this.setPosition(x, y);
    this.vx = Math.cos(aimAngle) * this.speed;
    this.vy = Math.sin(aimAngle) * this.speed;
    this.isDeflected = false;
    this.deflectedBounceCount = 0;
    this.deflectBurstRemainingMs = 0;
    this.headingHistory.length = 0;
    this.headingHistory.push(aimAngle);
    this.distanceSinceLastSample = 0;
    this.setTintFill(this.baseColor);
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

  /** Redirects along the player's aim angle at a boosted speed (see DEFLECT_SPEED_MULTIPLIER) - friendly from here on, with a brief real-time burst before it starts being world-time-scaled. Also ends any chasing/ricochet behavior immediately (see step()/bounceOffWall()), regardless of its original kind. */
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
   * Advances the projectile - turning toward the player first if it's a
   * still-hostile chaser - and bounces it off the wall. worldScaledDelta is
   * whatever the caller has already multiplied by the current world
   * timescale - this class just moves by it, except during the brief
   * post-deflect burst window, where it moves by the real (unscaled) delta
   * instead so the redirect always reads as an immediate, decisive hit.
   * Returns true once it should be despawned.
   */
  step(realDelta: number, worldScaledDelta: number, arena: Arena, playerX: number, playerY: number): boolean {
    let effectiveDelta = worldScaledDelta;
    if (this.deflectBurstRemainingMs > 0) {
      effectiveDelta = realDelta;
      this.deflectBurstRemainingMs = Math.max(0, this.deflectBurstRemainingMs - realDelta);
    }

    const dt = effectiveDelta / 1000;

    if (this.kind === "chaser" && !this.isDeflected) {
      this.turnTowardPlayer(playerX, playerY, dt);
    }

    const moveDist = Math.hypot(this.vx, this.vy) * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.bounceOffWall(arena, playerX, playerY);
    this.sampleHeading(moveDist);
    this.redrawTail();

    if (this.isDeflected && this.deflectedBounceCount >= DEFLECT_MAX_BOUNCES) {
      return true;
    }

    return this.hasEscaped(arena);
  }

  /** Rotates the velocity vector toward the player's current position by up to CHASER_TURN_RATE*dt radians, preserving current speed. */
  private turnTowardPlayer(playerX: number, playerY: number, dt: number): void {
    const speed = Math.hypot(this.vx, this.vy);
    if (speed === 0) {
      return;
    }
    const currentAngle = Math.atan2(this.vy, this.vx);
    const targetAngle = Math.atan2(playerY - this.y, playerX - this.x);
    const newAngle = Phaser.Math.Angle.RotateTo(currentAngle, targetAngle, CHASER_TURN_RATE * dt);
    this.vx = Math.cos(newAngle) * speed;
    this.vy = Math.sin(newAngle) * speed;
  }

  /** Records the current heading once enough path distance has accumulated since the last sample - see the TAIL_LENGTH doc comment. Can push more than one sample in a single call (e.g. a big deflect-burst jump). */
  private sampleHeading(moveDist: number): void {
    this.distanceSinceLastSample += moveDist;
    while (this.distanceSinceLastSample >= TAIL_SEGMENT_LENGTH) {
      this.headingHistory.push(Math.atan2(this.vy, this.vx));
      if (this.headingHistory.length > TAIL_SEGMENTS) {
        this.headingHistory.shift();
      }
      this.distanceSinceLastSample -= TAIL_SEGMENT_LENGTH;
    }
  }

  private hasEscaped(arena: Arena): boolean {
    const dx = this.x - arena.bounds.centerX;
    const dy = this.y - arena.bounds.centerY;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    return dist > arena.maxRadiusAtAngle(angle) + ESCAPE_MARGIN;
  }

  private bounceOffWall(arena: Arena, playerX: number, playerY: number): void {
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

    if (this.kind === "ricochet" && !this.isDeflected) {
      // Re-aim dead-on at the player instead of mirror-reflecting - the wall bounce becomes a fresh shot rather than a predictable carom.
      const speed = Math.hypot(this.vx, this.vy);
      const aimAngle = Math.atan2(playerY - this.y, playerX - this.x);
      this.vx = Math.cos(aimAngle) * speed;
      this.vy = Math.sin(aimAngle) * speed;
    } else {
      const n = arena.normalAtAngle(angle);
      const dot = this.vx * n.x + this.vy * n.y;
      this.vx -= 2 * dot * n.x;
      this.vy -= 2 * dot * n.y;
    }

    if (this.isDeflected) {
      this.deflectedBounceCount++;
    }
  }

  /**
   * Draws a tapered line from the projectile back toward where it came from,
   * redrawn fresh every step. Walks backward one fixed-length segment at a
   * time, using progressively older recorded headings (see headingHistory)
   * for each segment rather than a single current-velocity direction for the
   * whole tail - so it visibly bends along a curving path (chaser, or a
   * ricochet just past a bounce) instead of always reading as a straight
   * line. A handful of progressively shorter/fainter segments fake a taper,
   * since Graphics strokes don't support a real gradient - reads far more
   * clearly as "this is moving in direction X" than a plain fading
   * afterimage trail did, which matters a lot when the projectile itself
   * might be crawling along at a near-frozen world timescale.
   */
  private redrawTail(): void {
    this.tailGraphic.clear();
    const speed = Math.hypot(this.vx, this.vy);
    if (speed === 0) {
      return;
    }
    const color = this.isDeflected ? DEFLECT_TINT : this.baseColor;

    let cursorX = this.x;
    let cursorY = this.y;
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      const historyIndex = Math.max(0, this.headingHistory.length - 1 - i);
      const angle = this.headingHistory[historyIndex];
      const nextX = cursorX - Math.cos(angle) * TAIL_SEGMENT_LENGTH;
      const nextY = cursorY - Math.sin(angle) * TAIL_SEGMENT_LENGTH;
      const alpha = TAIL_MAX_ALPHA * (1 - i / TAIL_SEGMENTS);
      const width = this.radius * (1 - i / TAIL_SEGMENTS) * 0.9;
      this.tailGraphic.lineStyle(Math.max(1, width), color, alpha);
      this.tailGraphic.lineBetween(cursorX, cursorY, nextX, nextY);
      cursorX = nextX;
      cursorY = nextY;
    }
  }
}
