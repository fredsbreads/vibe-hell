import Phaser from "phaser";
import { ArenaBounds } from "../config/arena";
import { BasicProjectile } from "../entities/projectiles/BasicProjectile";
import { SlashHitbox } from "../entities/Player";

const BASIC_POOL_SIZE = 100;
const BASIC_SPAWN_INTERVAL_MS = 1500;

function isWithinSlashArc(projectile: BasicProjectile, hitbox: SlashHitbox): boolean {
  const dx = projectile.x - hitbox.x;
  const dy = projectile.y - hitbox.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance > hitbox.range + projectile.radius) {
    return false;
  }

  const angleToProjectile = Math.atan2(dy, dx);
  const angleDiff = Phaser.Math.Angle.Wrap(angleToProjectile - hitbox.angle);
  return Math.abs(angleDiff) <= hitbox.arcWidth / 2;
}

/**
 * Owns the pre-instantiated pool of Basic projectiles and the perimeter
 * spawner. Per the GDD's performance directive, entities are toggled active/
 * visible rather than created or destroyed at runtime.
 */
export class ProjectileManager {
  private readonly arena: ArenaBounds;
  private readonly basicPool: BasicProjectile[] = [];
  private basicSpawnTimerMs = BASIC_SPAWN_INTERVAL_MS;

  constructor(scene: Phaser.Scene, arena: ArenaBounds) {
    this.arena = arena;

    for (let i = 0; i < BASIC_POOL_SIZE; i++) {
      this.basicPool.push(new BasicProjectile(scene));
    }
  }

  /** Advances the spawner and all active projectiles. Returns how many escaped the arena unhandled (should be scored). */
  update(delta: number, playerX: number, playerY: number): number {
    this.basicSpawnTimerMs -= delta;
    if (this.basicSpawnTimerMs <= 0) {
      this.spawnBasic(playerX, playerY);
      this.basicSpawnTimerMs = BASIC_SPAWN_INTERVAL_MS;
    }

    let escaped = 0;
    for (const projectile of this.basicPool) {
      if (!projectile.active) {
        continue;
      }
      if (projectile.step(delta, this.arena)) {
        projectile.deactivate();
        escaped++;
      }
    }
    return escaped;
  }

  /** Deactivates any active projectile inside the given slash hitbox. Returns how many were hit. */
  checkSlashHits(hitbox: SlashHitbox | null): number {
    if (!hitbox) {
      return 0;
    }

    let hits = 0;
    for (const projectile of this.basicPool) {
      if (!projectile.active) {
        continue;
      }
      if (isWithinSlashArc(projectile, hitbox)) {
        projectile.deactivate();
        hits++;
      }
    }
    return hits;
  }

  /** Deactivates any active projectile touching the player and returns the damage dealt. */
  checkPlayerCollisions(playerX: number, playerY: number, playerRadius: number): number {
    let damage = 0;
    for (const projectile of this.basicPool) {
      if (!projectile.active) {
        continue;
      }
      const dx = projectile.x - playerX;
      const dy = projectile.y - playerY;
      const minDist = playerRadius + projectile.radius;
      if (dx * dx + dy * dy <= minDist * minDist) {
        projectile.deactivate();
        damage++;
      }
    }
    return damage;
  }

  private spawnBasic(playerX: number, playerY: number): void {
    const projectile = this.basicPool.find((p) => !p.active);
    if (!projectile) {
      return;
    }

    const angle = Math.random() * Math.PI * 2;
    const spawnX = this.arena.centerX + Math.cos(angle) * this.arena.radius;
    const spawnY = this.arena.centerY + Math.sin(angle) * this.arena.radius;
    projectile.activate(spawnX, spawnY, playerX, playerY);
  }
}
