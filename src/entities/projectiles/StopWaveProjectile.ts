import Phaser from "phaser";
import { Arena } from "../../arena/Arena";

const STOP_WAVE_SPEED = 70;
const STOP_WAVE_COLOR = 0x5c8df2;

/** How thick the sweeping bar is along its direction of travel. */
const THICKNESS = 56;

/** Fraction of the bar's total length that's carved out as a passable gap. */
const GAP_FRACTION = 0.22;

/** Extra length beyond the arena's own radius, so the bar always fully spans the local width regardless of shape or rotation. */
const HALF_LENGTH_MARGIN = 60;

/** How long the bar sits still at its spawn edge, telegraphing where the gap is, before it starts sweeping. */
const SPAWN_TELEGRAPH_MS = 500;
const TELEGRAPH_ALPHA = 0.35;

/**
 * A Stop Wave: a straight bar spanning the full width of the arena,
 * perpendicular to its direction of travel, sweeping from one side clean
 * across to the opposite side. Per the GDD it's a hard counter to Dash -
 * immune to Slash, and it damages on contact even through dash i-frames -
 * but unlike the other threat types it is NOT destroyed by contact; it's a
 * persistent hazard you get out of the way of, not an obstacle you clear.
 *
 * The bar always carries one gap: a contiguous passable segment of its own
 * length, sized and positioned once at spawn, telegraphed before the sweep
 * begins so there's time to read where it is and move into alignment with
 * it before the bar arrives. This mirrors the perimeter spawner's Safe Lane
 * Volley Rule, applied to the wave's own geometry instead of spawn points.
 *
 * Doesn't extend LinearProjectile: that base assumes a circular hitbox and
 * "escaped once far enough from center," neither of which fits a line that
 * exits at a specific edge opposite where it entered. Rendered directly via
 * its own Graphics object rather than a generated circular texture.
 */
export class StopWaveProjectile {
  active = false;
  x = 0;
  y = 0;

  private travelAngle = 0;
  private halfLength = 0;
  private gapStart = 0;
  private gapEnd = 0;
  private telegraphRemainingMs = 0;
  private distanceTraveled = 0;
  private escapeDistance = 0;
  private readonly graphic: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.graphic = scene.add.graphics();
    this.graphic.setVisible(false);
  }

  /**
   * Spawns at (x, y) on the perimeter, traveling along travelAngle (straight
   * across the arena, not homing on the player - the whole point is that it
   * sweeps the field uniformly). The gap's lateral position is randomized
   * within the bar's length, kept clear of the very ends so it's never
   * trivially unreachable.
   */
  activate(x: number, y: number, travelAngle: number, arena: Arena): void {
    this.x = x;
    this.y = y;
    this.travelAngle = travelAngle;
    this.halfLength = arena.bounds.radius + HALF_LENGTH_MARGIN;

    const gapLength = this.halfLength * 2 * GAP_FRACTION;
    const maxOffset = this.halfLength - gapLength / 2 - 20;
    const gapCenter = (Math.random() * 2 - 1) * maxOffset;
    this.gapStart = gapCenter - gapLength / 2;
    this.gapEnd = gapCenter + gapLength / 2;

    this.telegraphRemainingMs = SPAWN_TELEGRAPH_MS;
    this.distanceTraveled = 0;
    this.escapeDistance = arena.bounds.radius * 2 + HALF_LENGTH_MARGIN * 2;

    this.active = true;
    this.graphic.setVisible(true);
    this.redraw();
  }

  deactivate(): void {
    this.active = false;
    this.graphic.setVisible(false);
  }

  /** Advances the wave. Returns true once it's fully swept past the opposite side and should be despawned. */
  step(delta: number): boolean {
    if (this.telegraphRemainingMs > 0) {
      this.telegraphRemainingMs = Math.max(0, this.telegraphRemainingMs - delta);
      this.redraw();
      return false;
    }

    const dt = delta / 1000;
    const dist = STOP_WAVE_SPEED * dt;
    this.x += Math.cos(this.travelAngle) * dist;
    this.y += Math.sin(this.travelAngle) * dist;
    this.distanceTraveled += dist;
    this.redraw();
    return this.distanceTraveled >= this.escapeDistance;
  }

  /** True if the player's whole circle at this lateral offset fits inside the gap. */
  private isLateralOffsetSafe(lateralOffset: number, radius: number): boolean {
    return lateralOffset - radius >= this.gapStart && lateralOffset + radius <= this.gapEnd;
  }

  /**
   * True if the player's circle overlaps the bar's solid (non-gap) region.
   * Ignored entirely while still telegraphing - the bar isn't hazardous yet.
   */
  checkCollision(playerX: number, playerY: number, playerRadius: number): boolean {
    if (!this.active || this.telegraphRemainingMs > 0) {
      return false;
    }

    const dx = playerX - this.x;
    const dy = playerY - this.y;
    const forward = Math.cos(this.travelAngle) * dx + Math.sin(this.travelAngle) * dy;
    if (Math.abs(forward) > THICKNESS / 2 + playerRadius) {
      return false;
    }

    const lateralAngle = this.travelAngle + Math.PI / 2;
    const lateral = Math.cos(lateralAngle) * dx + Math.sin(lateralAngle) * dy;
    return !this.isLateralOffsetSafe(lateral, playerRadius);
  }

  private redraw(): void {
    this.graphic.clear();
    const alpha = this.telegraphRemainingMs > 0 ? TELEGRAPH_ALPHA : 0.92;
    this.graphic.fillStyle(STOP_WAVE_COLOR, alpha);
    this.drawSegment(-this.halfLength, this.gapStart);
    this.drawSegment(this.gapEnd, this.halfLength);
  }

  /** Draws one solid slab of the bar (the two segments flanking the gap), rotated to travelAngle. */
  private drawSegment(lateralStart: number, lateralEnd: number): void {
    if (lateralEnd <= lateralStart) {
      return;
    }
    const forwardX = Math.cos(this.travelAngle);
    const forwardY = Math.sin(this.travelAngle);
    const lateralAngle = this.travelAngle + Math.PI / 2;
    const lateralX = Math.cos(lateralAngle);
    const lateralY = Math.sin(lateralAngle);
    const halfThick = THICKNESS / 2;

    const corner = (lat: number, thick: number) => ({
      x: this.x + lateralX * lat + forwardX * thick,
      y: this.y + lateralY * lat + forwardY * thick,
    });

    const a = corner(lateralStart, -halfThick);
    const b = corner(lateralEnd, -halfThick);
    const c = corner(lateralEnd, halfThick);
    const d = corner(lateralStart, halfThick);

    this.graphic.beginPath();
    this.graphic.moveTo(a.x, a.y);
    this.graphic.lineTo(b.x, b.y);
    this.graphic.lineTo(c.x, c.y);
    this.graphic.lineTo(d.x, d.y);
    this.graphic.closePath();
    this.graphic.fillPath();
  }
}
