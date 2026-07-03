import Phaser from "phaser";
import { Arena } from "../../arena/Arena";
import { LinearProjectile } from "./LinearProjectile";

export const STOP_WAVE_SPEED = 55;
export const STOP_WAVE_RADIUS = 40;

/**
 * A pooled Stop Wave threat: a large, slow barrier. Per the GDD it is a hard
 * counter to Dash specifically - immune to Slash, and it punishes dashing
 * through it by cancelling the dash and dealing damage even though dash
 * would normally grant i-frames. It only reacts to contact made while
 * dashing; simply walking into one does nothing (see
 * ProjectileManager.checkStopWaveCollisions, which is checked separately
 * from the other threat types and gated behind Player.isDashActive).
 */
export class StopWaveProjectile extends LinearProjectile {
  constructor(scene: Phaser.Scene) {
    super(scene, "stopwave-projectile", STOP_WAVE_SPEED, STOP_WAVE_RADIUS);
  }

  step(delta: number, arena: Arena, _playerX: number, _playerY: number): boolean {
    if (!this.move(delta)) {
      return false;
    }
    return this.hasEscaped(arena);
  }
}
