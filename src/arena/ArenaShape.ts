import { ArenaBounds } from "../config/arena";

export interface Point {
  x: number;
  y: number;
}

/**
 * A convex boundary geometry sharing a fixed center/nominal radius
 * (`bounds`). All queries are angle-parameterized from the center - valid
 * for any convex shape, since a ray from an interior center crosses the
 * boundary exactly once. Optionally spins over time via rotationSpeed.
 */
export abstract class ArenaShape {
  private rotationValue = 0;

  constructor(
    readonly bounds: ArenaBounds,
    private readonly rotationSpeedRadPerMs: number = 0,
  ) {}

  get rotation(): number {
    return this.rotationValue;
  }

  /** Back to the starting orientation - used to restart a death replay loop from the exact same arena state the run itself began with. */
  resetRotation(): void {
    this.rotationValue = 0;
  }

  update(delta: number): void {
    if (this.rotationSpeedRadPerMs !== 0) {
      this.rotationValue += this.rotationSpeedRadPerMs * delta;
    }
  }

  /** Distance from center to the boundary along a world-space ray at the given angle. */
  abstract maxRadiusAtAngle(worldAngle: number): number;

  /** Outward unit normal of the wall nearest the given angle - used for bounce reflection. */
  abstract normalAtAngle(worldAngle: number): Point;

  /** Vertices for rendering in world space, or null to render as a smooth circle. */
  abstract getRenderVertices(): Point[] | null;

  boundaryPointAtAngle(worldAngle: number): Point {
    const r = this.maxRadiusAtAngle(worldAngle);
    return {
      x: this.bounds.centerX + Math.cos(worldAngle) * r,
      y: this.bounds.centerY + Math.sin(worldAngle) * r,
    };
  }
}
