import Phaser from "phaser";
import { ArenaBounds } from "../config/arena";
import { LinearProjectile } from "../entities/projectiles/LinearProjectile";
import { BasicProjectile } from "../entities/projectiles/BasicProjectile";
import { ZoomerProjectile } from "../entities/projectiles/ZoomerProjectile";
import { StopWaveProjectile } from "../entities/projectiles/StopWaveProjectile";
import { ChaserProjectile } from "../entities/projectiles/ChaserProjectile";
import { SlashHitbox } from "../entities/Player";

const BASIC_POOL_SIZE = 100;
const BASIC_SPAWN_INTERVAL_MS = 1500;

const ZOOMER_POOL_SIZE = 100;
const ZOOMER_SPAWN_INTERVAL_MS = 1000;

const STOP_WAVE_POOL_SIZE = 30;
const STOP_WAVE_SPAWN_INTERVAL_MS = 2500;

const CHASER_POOL_SIZE = 60;
const CHASER_SPAWN_INTERVAL_MS = 1800;

function isWithinSlashArc(projectile: LinearProjectile, hitbox: SlashHitbox): boolean {
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

function findInactive<T extends LinearProjectile>(pool: T[]): T | undefined {
  return pool.find((p) => !p.active);
}

function spawnOnPerimeter(
  projectile: LinearProjectile,
  arena: ArenaBounds,
  playerX: number,
  playerY: number,
): void {
  const angle = Math.random() * Math.PI * 2;
  const spawnX = arena.centerX + Math.cos(angle) * arena.radius;
  const spawnY = arena.centerY + Math.sin(angle) * arena.radius;
  projectile.activate(spawnX, spawnY, playerX, playerY);
}

function stepPool(
  pool: LinearProjectile[],
  delta: number,
  arena: ArenaBounds,
  playerX: number,
  playerY: number,
): number {
  let escaped = 0;
  for (const projectile of pool) {
    if (!projectile.active) {
      continue;
    }
    if (projectile.step(delta, arena, playerX, playerY)) {
      projectile.deactivate();
      escaped++;
    }
  }
  return escaped;
}

function checkSlashHitsOnPool(pool: LinearProjectile[], hitbox: SlashHitbox): number {
  let hits = 0;
  for (const projectile of pool) {
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

function checkContactOnPool(
  pool: LinearProjectile[],
  playerX: number,
  playerY: number,
  playerRadius: number,
): number {
  let damage = 0;
  for (const projectile of pool) {
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

/**
 * Owns the pre-instantiated pools for all threat types and their perimeter
 * spawners. Per the GDD's performance directive, entities are toggled
 * active/visible rather than created or destroyed at runtime.
 *
 * Basic spawns automatically. Zoomer, Stop Wave, and Chaser spawning is
 * currently gated behind debug toggles (see MainScene's number-key
 * handlers) until the wave-based difficulty ramp is built.
 */
export class ProjectileManager {
  private readonly arena: ArenaBounds;

  private readonly basicPool: BasicProjectile[] = [];
  private basicSpawnTimerMs = BASIC_SPAWN_INTERVAL_MS;

  private readonly zoomerPool: ZoomerProjectile[] = [];
  private zoomerSpawnTimerMs = ZOOMER_SPAWN_INTERVAL_MS;
  private zoomerSpawningEnabled = false;

  private readonly stopWavePool: StopWaveProjectile[] = [];
  private stopWaveSpawnTimerMs = STOP_WAVE_SPAWN_INTERVAL_MS;
  private stopWaveSpawningEnabled = false;

  private readonly chaserPool: ChaserProjectile[] = [];
  private chaserSpawnTimerMs = CHASER_SPAWN_INTERVAL_MS;
  private chaserSpawningEnabled = false;

  constructor(scene: Phaser.Scene, arena: ArenaBounds) {
    this.arena = arena;

    for (let i = 0; i < BASIC_POOL_SIZE; i++) {
      this.basicPool.push(new BasicProjectile(scene));
    }
    for (let i = 0; i < ZOOMER_POOL_SIZE; i++) {
      this.zoomerPool.push(new ZoomerProjectile(scene));
    }
    for (let i = 0; i < STOP_WAVE_POOL_SIZE; i++) {
      this.stopWavePool.push(new StopWaveProjectile(scene));
    }
    for (let i = 0; i < CHASER_POOL_SIZE; i++) {
      this.chaserPool.push(new ChaserProjectile(scene));
    }
  }

  get isZoomerSpawningEnabled(): boolean {
    return this.zoomerSpawningEnabled;
  }

  get isStopWaveSpawningEnabled(): boolean {
    return this.stopWaveSpawningEnabled;
  }

  get isChaserSpawningEnabled(): boolean {
    return this.chaserSpawningEnabled;
  }

  setZoomerSpawningEnabled(enabled: boolean): void {
    if (enabled && !this.zoomerSpawningEnabled) {
      this.zoomerSpawnTimerMs = 0;
    }
    this.zoomerSpawningEnabled = enabled;
  }

  setStopWaveSpawningEnabled(enabled: boolean): void {
    if (enabled && !this.stopWaveSpawningEnabled) {
      this.stopWaveSpawnTimerMs = 0;
    }
    this.stopWaveSpawningEnabled = enabled;
  }

  setChaserSpawningEnabled(enabled: boolean): void {
    if (enabled && !this.chaserSpawningEnabled) {
      this.chaserSpawnTimerMs = 0;
    }
    this.chaserSpawningEnabled = enabled;
  }

  /** Advances all spawners and active projectiles. Returns how many escaped the arena unhandled (should be scored). */
  update(delta: number, playerX: number, playerY: number): number {
    this.basicSpawnTimerMs -= delta;
    if (this.basicSpawnTimerMs <= 0) {
      const projectile = findInactive(this.basicPool);
      if (projectile) {
        spawnOnPerimeter(projectile, this.arena, playerX, playerY);
      }
      this.basicSpawnTimerMs = BASIC_SPAWN_INTERVAL_MS;
    }

    if (this.zoomerSpawningEnabled) {
      this.zoomerSpawnTimerMs -= delta;
      if (this.zoomerSpawnTimerMs <= 0) {
        const projectile = findInactive(this.zoomerPool);
        if (projectile) {
          spawnOnPerimeter(projectile, this.arena, playerX, playerY);
        }
        this.zoomerSpawnTimerMs = ZOOMER_SPAWN_INTERVAL_MS;
      }
    }

    if (this.stopWaveSpawningEnabled) {
      this.stopWaveSpawnTimerMs -= delta;
      if (this.stopWaveSpawnTimerMs <= 0) {
        const projectile = findInactive(this.stopWavePool);
        if (projectile) {
          spawnOnPerimeter(projectile, this.arena, playerX, playerY);
        }
        this.stopWaveSpawnTimerMs = STOP_WAVE_SPAWN_INTERVAL_MS;
      }
    }

    if (this.chaserSpawningEnabled) {
      this.chaserSpawnTimerMs -= delta;
      if (this.chaserSpawnTimerMs <= 0) {
        const projectile = findInactive(this.chaserPool);
        if (projectile) {
          spawnOnPerimeter(projectile, this.arena, playerX, playerY);
        }
        this.chaserSpawnTimerMs = CHASER_SPAWN_INTERVAL_MS;
      }
    }

    let escaped = 0;
    escaped += stepPool(this.basicPool, delta, this.arena, playerX, playerY);
    escaped += stepPool(this.zoomerPool, delta, this.arena, playerX, playerY);
    escaped += stepPool(this.stopWavePool, delta, this.arena, playerX, playerY);
    escaped += stepPool(this.chaserPool, delta, this.arena, playerX, playerY);
    return escaped;
  }

  /** Deactivates any Basic/Zoomer/Chaser projectile inside the slash hitbox. Stop Waves are immune to Slash. Returns how many were hit. */
  checkSlashHits(hitbox: SlashHitbox | null): number {
    if (!hitbox) {
      return 0;
    }
    return (
      checkSlashHitsOnPool(this.basicPool, hitbox) +
      checkSlashHitsOnPool(this.zoomerPool, hitbox) +
      checkSlashHitsOnPool(this.chaserPool, hitbox)
    );
  }

  /** Deactivates any Basic/Zoomer/Chaser projectile touching the player and returns the damage dealt. Only call while the player isn't invincible. */
  checkPlayerCollisions(playerX: number, playerY: number, playerRadius: number): number {
    return (
      checkContactOnPool(this.basicPool, playerX, playerY, playerRadius) +
      checkContactOnPool(this.zoomerPool, playerX, playerY, playerRadius) +
      checkContactOnPool(this.chaserPool, playerX, playerY, playerRadius)
    );
  }

  /**
   * Stop Waves bypass dash invincibility entirely, so this must be called
   * unconditionally every frame regardless of player.isInvincible - never
   * gate it behind that check the way checkPlayerCollisions is gated.
   */
  checkStopWaveCollisions(playerX: number, playerY: number, playerRadius: number): number {
    return checkContactOnPool(this.stopWavePool, playerX, playerY, playerRadius);
  }
}
