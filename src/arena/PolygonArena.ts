import { ArenaBounds } from "../config/arena";
import { ArenaShape, Point } from "./ArenaShape";

/** Wraps a value into [-period/2, period/2). */
function wrapToHalfRange(value: number, period: number): number {
  let v = value % period;
  if (v < -period / 2) {
    v += period;
  } else if (v >= period / 2) {
    v -= period;
  }
  return v;
}

/**
 * A regular convex polygon (square, hexagon, octagon, ...) inscribed with
 * circumradius bounds.radius. Vertices sit at bounds.radius from center;
 * walls bulge inward from there down to the apothem at each edge midpoint.
 */
export class PolygonArena extends ArenaShape {
  private readonly sector: number;
  private readonly apothem: number;

  constructor(bounds: ArenaBounds, readonly sides: number, rotationSpeedRadPerMs = 0) {
    super(bounds, rotationSpeedRadPerMs);
    this.sector = (Math.PI * 2) / sides;
    this.apothem = bounds.radius * Math.cos(Math.PI / sides);
  }

  /** Angular offset from worldAngle to the nearest edge's outward-normal direction, in [-sector/2, sector/2). */
  private edgeOffset(worldAngle: number): number {
    const localAngle = worldAngle - this.rotation;
    return wrapToHalfRange(localAngle - this.sector / 2, this.sector);
  }

  maxRadiusAtAngle(worldAngle: number): number {
    const offset = this.edgeOffset(worldAngle);
    return this.apothem / Math.cos(offset);
  }

  normalAtAngle(worldAngle: number): Point {
    const offset = this.edgeOffset(worldAngle);
    const edgeMidWorldAngle = worldAngle - offset;
    return { x: Math.cos(edgeMidWorldAngle), y: Math.sin(edgeMidWorldAngle) };
  }

  getRenderVertices(): Point[] {
    const points: Point[] = [];
    for (let k = 0; k < this.sides; k++) {
      const angle = this.rotation + k * this.sector;
      points.push({
        x: this.bounds.centerX + Math.cos(angle) * this.bounds.radius,
        y: this.bounds.centerY + Math.sin(angle) * this.bounds.radius,
      });
    }
    return points;
  }
}
