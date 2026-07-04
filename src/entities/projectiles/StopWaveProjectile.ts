import Phaser from "phaser";
import { Arena } from "../../arena/Arena";

const STOP_WAVE_SPEED = 70;
const STOP_WAVE_COLOR = 0x5c8df2;

// Thin enough to read as a line sweeping through, not a wall - but not
// thinner than that: dash moves at up to ~15px per frame at 60fps, and
// collision is checked once per frame at the player's current position, so a
// thickness much below that risks the dash tunneling straight through
// between two frames without ever registering an overlap.
const THICKNESS = 20;

/** Extra length beyond the arena's own radius, so the bar always fully spans the local width regardless of shape or rotation. */
const HALF_LENGTH_MARGIN = 60;

/** How long the bar sits still at its spawn edge, telegraphing its arrival, before it starts sweeping. */
const SPAWN_TELEGRAPH_MS = 500;
const TELEGRAPH_ALPHA = 0.35;

/**
 * A Stop Wave: a thin, solid bar spanning the full width of the arena,
 * perpendicular to its direction of travel, sweeping clean across from one
 * side to the opposite side. No gap - unlike the perimeter spawner's threats,
 * it isn't meant to be dodged by positioning. It's purely a Dash-specific
 * hard counter: walking through it is completely harmless (see MainScene,
 * which only checks collision at all while the player is dashing), but
 * dashing into it cancels the dash and deals damage, bypassing the i-frames
 * dash would normally grant against everything else.
 *
 * Not destroyed by contact - it's a persistent hazard, not an obstacle you
 * clear. Its lifetime is bounded by crossing the arena's diameter, so unlike
 * the old circular design it can never linger indefinitely.
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
   * sweeps the field uniformly).
   */
  activate(x: number, y: number, travelAngle: number, arena: Arena): void {
    this.x = x;
    this.y = y;
    this.travelAngle = travelAngle;
    this.halfLength = arena.bounds.radius + HALF_LENGTH_MARGIN;

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

  /**
   * True if the player's circle overlaps the bar's thickness band, anywhere
   * along its length (no gap to check). Ignored entirely while still
   * telegraphing - the bar isn't hazardous yet. Purely geometric: it doesn't
   * know or care whether the player is dashing - that decision belongs to
   * the caller (MainScene only checks this at all while dashing).
   */
  checkCollision(playerX: number, playerY: number, playerRadius: number): boolean {
    if (!this.active || this.telegraphRemainingMs > 0) {
      return false;
    }

    const dx = playerX - this.x;
    const dy = playerY - this.y;
    const forward = Math.cos(this.travelAngle) * dx + Math.sin(this.travelAngle) * dy;
    return Math.abs(forward) <= THICKNESS / 2 + playerRadius;
  }

  private redraw(): void {
    this.graphic.clear();
    const alpha = this.telegraphRemainingMs > 0 ? TELEGRAPH_ALPHA : 0.92;
    this.graphic.fillStyle(STOP_WAVE_COLOR, alpha);

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

    const a = corner(-this.halfLength, -halfThick);
    const b = corner(this.halfLength, -halfThick);
    const c = corner(this.halfLength, halfThick);
    const d = corner(-this.halfLength, halfThick);

    this.graphic.beginPath();
    this.graphic.moveTo(a.x, a.y);
    this.graphic.lineTo(b.x, b.y);
    this.graphic.lineTo(c.x, c.y);
    this.graphic.lineTo(d.x, d.y);
    this.graphic.closePath();
    this.graphic.fillPath();
  }
}
