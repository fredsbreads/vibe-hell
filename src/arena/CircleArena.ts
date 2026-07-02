import { ArenaShape, Point } from "./ArenaShape";

export class CircleArena extends ArenaShape {
  maxRadiusAtAngle(_worldAngle: number): number {
    return this.bounds.radius;
  }

  normalAtAngle(worldAngle: number): Point {
    return { x: Math.cos(worldAngle), y: Math.sin(worldAngle) };
  }

  getRenderVertices(): null {
    return null;
  }
}
