import Phaser from "phaser";
import { ArenaBounds } from "../../config/arena";
import { LinearProjectile } from "./LinearProjectile";

export const STOP_WAVE_SPEED = 55;
export const STOP_WAVE_RADIUS = 40;

/**
 * A pooled Stop Wave threat: a large, slow barrier. Per the GDD it is a hard
 * counter to both of the player's tools - immune to Slash, and it bypasses
 * Dash i-frames entirely (see ProjectileManager.checkStopWaveCollisions,
 * which is checked separately from the other threat types for this reason).
 */
export class StopWaveProjectile extends LinearProjectile {
  constructor(scene: Phaser.Scene) {
    super(scene, "stopwave-projectile", STOP_WAVE_SPEED, STOP_WAVE_RADIUS);
  }

  step(delta: number, arena: ArenaBounds, _playerX: number, _playerY: number): boolean {
    this.move(delta);
    return this.hasEscaped(arena);
  }
}
