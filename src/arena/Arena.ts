import { ArenaBounds } from "../config/arena";
import { ArenaShape, Point } from "./ArenaShape";

/**
 * Stable facade over the current ArenaShape. Player and ProjectileManager
 * hold a single long-lived Arena reference; swapping the underlying shape
 * (e.g. circle -> octagon at a future wave transition) happens here rather
 * than by replacing the object those consumers point to.
 */
export class Arena {
  constructor(
    readonly bounds: ArenaBounds,
    private shape: ArenaShape,
  ) {}

  get currentShape(): ArenaShape {
    return this.shape;
  }

  setShape(shape: ArenaShape): void {
    this.shape = shape;
  }

  update(delta: number): void {
    this.shape.update(delta);
  }

  resetRotation(): void {
    this.shape.resetRotation();
  }

  maxRadiusAtAngle(worldAngle: number): number {
    return this.shape.maxRadiusAtAngle(worldAngle);
  }

  normalAtAngle(worldAngle: number): Point {
    return this.shape.normalAtAngle(worldAngle);
  }

  boundaryPointAtAngle(worldAngle: number): Point {
    return this.shape.boundaryPointAtAngle(worldAngle);
  }

  getRenderVertices(): Point[] | null {
    return this.shape.getRenderVertices();
  }
}
