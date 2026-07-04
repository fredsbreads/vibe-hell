import Phaser from "phaser";
import { Arena } from "../arena/Arena";
import { LinearProjectile } from "../entities/projectiles/LinearProjectile";
import { BasicProjectile } from "../entities/projectiles/BasicProjectile";
import { ZoomerProjectile } from "../entities/projectiles/ZoomerProjectile";
import { StopWaveProjectile } from "../entities/projectiles/StopWaveProjectile";
import { ChaserProjectile } from "../entities/projectiles/ChaserProjectile";
import { SlashHitbox } from "../entities/Player";
import { spawnPop } from "../effects/spawnPop";

const SLASH_KILL_POP_COLOR = 0xffe98a;
const HIT_POP_COLOR = 0xff3b3b;

const BASIC_POOL_SIZE = 100;
const BASIC_BASE_SPAWN_INTERVAL_MS = 1500;

const ZOOMER_POOL_SIZE = 100;
const ZOOMER_BASE_SPAWN_INTERVAL_MS = 1000;

// Small pool and longer interval than the other types deliberately: each Stop
// Wave is now a full-arena-spanning sweep, an "event" rather than a bullet, so
// having many active at once would be both visually chaotic and nearly
// impossible to route around all of simultaneously.
const STOP_WAVE_POOL_SIZE = 6;
const STOP_WAVE_BASE_SPAWN_INTERVAL_MS = 6000;

const CHASER_POOL_SIZE = 60;
const CHASER_BASE_SPAWN_INTERVAL_MS = 1800;

/**
 * Fair-Play Spawner Rules (GDD section 4). Two exclusion zones are carved out
 * of the perimeter and a spawn angle is rejection-sampled from what's left:
 *
 * - Dynamic Perimeter Filtering: a zone centered on the perimeter point
 *   closest to the player (i.e. the angle from the arena center through the
 *   player), blocking point-blank spawns.
 * - Safe Lane Volley Rule: a contiguous 20% arc of the perimeter, which
 *   slowly sweeps around the arena over time, guaranteeing a lane the player
 *   can always see and move into rather than a static/campable gap.
 */
export const PLAYER_BLOCK_ARC_RADIANS = Phaser.Math.DegToRad(50);
export const SAFE_LANE_ARC_RADIANS = Math.PI * 2 * 0.2;

// The safe lane's sweep speed/direction is re-rolled each wave (see rerollSafeLaneMotion)
// rather than fixed, so its motion isn't identical wave-to-wave or run-to-run - only the
// period (how long a full sweep takes) is randomized within this range; it always keeps
// moving (never 0) so the gap can't degenerate into a static, campable spot.
const SAFE_LANE_MIN_PERIOD_MS = 14000;
const SAFE_LANE_MAX_PERIOD_MS = 28000;
const MAX_SPAWN_ANGLE_ATTEMPTS = 30;

function angularDistance(a: number, b: number): number {
  return Math.abs(Phaser.Math.Angle.Wrap(a - b));
}

/** Rejection-samples a perimeter angle outside both exclusion zones. Falls back to directly opposite the player if it can't find one. */
function pickSafeSpawnAngle(playerAngle: number, safeLaneCenterAngle: number): number {
  for (let attempt = 0; attempt < MAX_SPAWN_ANGLE_ATTEMPTS; attempt++) {
    const candidate = Math.random() * Math.PI * 2;
    const blockedByPlayer = angularDistance(candidate, playerAngle) <= PLAYER_BLOCK_ARC_RADIANS / 2;
    const blockedBySafeLane = angularDistance(candidate, safeLaneCenterAngle) <= SAFE_LANE_ARC_RADIANS / 2;
    if (!blockedByPlayer && !blockedBySafeLane) {
      return candidate;
    }
  }
  return playerAngle + Math.PI;
}

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
  arena: Arena,
  playerX: number,
  playerY: number,
  safeLaneCenterAngle: number,
): void {
  const playerAngle = Math.atan2(playerY - arena.bounds.centerY, playerX - arena.bounds.centerX);
  const angle = pickSafeSpawnAngle(playerAngle, safeLaneCenterAngle);
  const spawnPoint = arena.boundaryPointAtAngle(angle);
  projectile.activate(spawnPoint.x, spawnPoint.y, playerX, playerY);
}

function stepPool(
  pool: LinearProjectile[],
  delta: number,
  arena: Arena,
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

function checkSlashHitsOnPool(pool: LinearProjectile[], hitbox: SlashHitbox, onHit: (x: number, y: number) => void): number {
  let hits = 0;
  for (const projectile of pool) {
    if (!projectile.active) {
      continue;
    }
    if (isWithinSlashArc(projectile, hitbox)) {
      onHit(projectile.x, projectile.y);
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
  onHit: (x: number, y: number) => void,
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
      onHit(projectile.x, projectile.y);
      projectile.deactivate();
      damage++;
    }
  }
  return damage;
}

// Stop Wave doesn't fit the LinearProjectile model (circular hitbox, escape
// by distance-from-center) - it's a full-width sweeping bar with a gap, so it
// gets its own spawn/step/collision helpers rather than reusing the generic
// ones above.

function findInactiveStopWave(pool: StopWaveProjectile[]): StopWaveProjectile | undefined {
  return pool.find((p) => !p.active);
}

/** Spawns on the perimeter like everything else, but travels straight across the arena rather than homing on the player. */
function spawnStopWave(
  wave: StopWaveProjectile,
  arena: Arena,
  playerX: number,
  playerY: number,
  safeLaneCenterAngle: number,
): void {
  const playerAngle = Math.atan2(playerY - arena.bounds.centerY, playerX - arena.bounds.centerX);
  const angle = pickSafeSpawnAngle(playerAngle, safeLaneCenterAngle);
  const spawnPoint = arena.boundaryPointAtAngle(angle);
  const travelAngle = angle + Math.PI;
  wave.activate(spawnPoint.x, spawnPoint.y, travelAngle, arena);
}

function stepStopWavePool(pool: StopWaveProjectile[], delta: number): number {
  let escaped = 0;
  for (const wave of pool) {
    if (!wave.active) {
      continue;
    }
    if (wave.step(delta)) {
      wave.deactivate();
      escaped++;
    }
  }
  return escaped;
}

/**
 * Unlike checkContactOnPool, contact does NOT deactivate the wave - it's a
 * persistent hazard you get out of the way of, not an obstacle destroyed by
 * touching it. Returns how many waves the player is currently overlapping in
 * their solid (non-gap) section.
 */
function checkStopWaveContact(
  pool: StopWaveProjectile[],
  playerX: number,
  playerY: number,
  playerRadius: number,
  onHit: (x: number, y: number) => void,
): number {
  let hits = 0;
  for (const wave of pool) {
    if (wave.checkCollision(playerX, playerY, playerRadius)) {
      onHit(playerX, playerY);
      hits++;
    }
  }
  return hits;
}

/**
 * Owns the pre-instantiated pools for all threat types and their perimeter
 * spawners. Per the GDD's performance directive, entities are toggled
 * active/visible rather than created or destroyed at runtime.
 *
 * Basic spawns automatically. Zoomer, Stop Wave, and Chaser spawning is
 * gated behind on/off toggles - normally driven by WaveManager as waves
 * progress, but also directly reachable via MainScene's debug number keys.
 */
export class ProjectileManager {
  private readonly scene: Phaser.Scene;
  private readonly arena: Arena;

  private readonly basicPool: BasicProjectile[] = [];
  private basicSpawnTimerMs = BASIC_BASE_SPAWN_INTERVAL_MS;
  private basicSpawningEnabled = true;

  private readonly zoomerPool: ZoomerProjectile[] = [];
  private zoomerSpawnTimerMs = ZOOMER_BASE_SPAWN_INTERVAL_MS;
  private zoomerSpawningEnabled = false;

  private readonly stopWavePool: StopWaveProjectile[] = [];
  private stopWaveSpawnTimerMs = STOP_WAVE_BASE_SPAWN_INTERVAL_MS;
  private stopWaveSpawningEnabled = false;

  private readonly chaserPool: ChaserProjectile[] = [];
  private chaserSpawnTimerMs = CHASER_BASE_SPAWN_INTERVAL_MS;
  private chaserSpawningEnabled = false;

  private safeLaneCenterAngleValue = Math.random() * Math.PI * 2;
  private safeLaneRotationRadPerMs = (Math.PI * 2) / SAFE_LANE_MIN_PERIOD_MS;

  /** Multiplies spawn frequency (shorter intervals = more threats) as waves progress. */
  private difficultyMultiplier = 1;

  constructor(scene: Phaser.Scene, arena: Arena) {
    this.scene = scene;
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

  get isBasicSpawningEnabled(): boolean {
    return this.basicSpawningEnabled;
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

  /** Center angle of the current Safe Lane Volley Rule gap, for the arena's visual indicator. */
  get safeLaneCenterAngle(): number {
    return this.safeLaneCenterAngleValue;
  }

  setBasicSpawningEnabled(enabled: boolean): void {
    if (enabled && !this.basicSpawningEnabled) {
      this.basicSpawnTimerMs = 0;
    }
    this.basicSpawningEnabled = enabled;
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

  /** Scales spawn frequency for every threat type; called by WaveManager as waves progress. */
  setDifficultyMultiplier(multiplier: number): void {
    this.difficultyMultiplier = multiplier;
  }

  /**
   * Picks a new random sweep speed and direction for the Safe Lane, so its
   * motion isn't identical wave-to-wave or run-to-run. Called by WaveManager
   * at the start of every wave. Only rerolls speed/direction, not the
   * lane's current position, so it doesn't visibly jump when this fires.
   */
  rerollSafeLaneMotion(): void {
    const periodMs = SAFE_LANE_MIN_PERIOD_MS + Math.random() * (SAFE_LANE_MAX_PERIOD_MS - SAFE_LANE_MIN_PERIOD_MS);
    const direction = Math.random() < 0.5 ? -1 : 1;
    this.safeLaneRotationRadPerMs = (direction * Math.PI * 2) / periodMs;
  }

  /** Immediately deactivates every active projectile of every type - used for the wave intermission's "Breather Window" wipe. */
  clearAll(): void {
    for (const projectile of [...this.basicPool, ...this.zoomerPool, ...this.stopWavePool, ...this.chaserPool]) {
      projectile.deactivate();
    }
  }

  /** Advances all spawners and active projectiles. Returns how many escaped the arena unhandled (should be scored). */
  update(delta: number, playerX: number, playerY: number): number {
    this.arena.update(delta);

    this.safeLaneCenterAngleValue = Phaser.Math.Angle.Wrap(
      this.safeLaneCenterAngleValue + this.safeLaneRotationRadPerMs * delta,
    );

    if (this.basicSpawningEnabled) {
      this.basicSpawnTimerMs -= delta;
      if (this.basicSpawnTimerMs <= 0) {
        const projectile = findInactive(this.basicPool);
        if (projectile) {
          spawnOnPerimeter(projectile, this.arena, playerX, playerY, this.safeLaneCenterAngleValue);
        }
        this.basicSpawnTimerMs = BASIC_BASE_SPAWN_INTERVAL_MS / this.difficultyMultiplier;
      }
    }

    if (this.zoomerSpawningEnabled) {
      this.zoomerSpawnTimerMs -= delta;
      if (this.zoomerSpawnTimerMs <= 0) {
        const projectile = findInactive(this.zoomerPool);
        if (projectile) {
          spawnOnPerimeter(projectile, this.arena, playerX, playerY, this.safeLaneCenterAngleValue);
        }
        this.zoomerSpawnTimerMs = ZOOMER_BASE_SPAWN_INTERVAL_MS / this.difficultyMultiplier;
      }
    }

    if (this.stopWaveSpawningEnabled) {
      this.stopWaveSpawnTimerMs -= delta;
      if (this.stopWaveSpawnTimerMs <= 0) {
        const wave = findInactiveStopWave(this.stopWavePool);
        if (wave) {
          spawnStopWave(wave, this.arena, playerX, playerY, this.safeLaneCenterAngleValue);
        }
        this.stopWaveSpawnTimerMs = STOP_WAVE_BASE_SPAWN_INTERVAL_MS / this.difficultyMultiplier;
      }
    }

    if (this.chaserSpawningEnabled) {
      this.chaserSpawnTimerMs -= delta;
      if (this.chaserSpawnTimerMs <= 0) {
        const projectile = findInactive(this.chaserPool);
        if (projectile) {
          spawnOnPerimeter(projectile, this.arena, playerX, playerY, this.safeLaneCenterAngleValue);
        }
        this.chaserSpawnTimerMs = CHASER_BASE_SPAWN_INTERVAL_MS / this.difficultyMultiplier;
      }
    }

    let escaped = 0;
    escaped += stepPool(this.basicPool, delta, this.arena, playerX, playerY);
    escaped += stepPool(this.zoomerPool, delta, this.arena, playerX, playerY);
    escaped += stepStopWavePool(this.stopWavePool, delta);
    escaped += stepPool(this.chaserPool, delta, this.arena, playerX, playerY);
    return escaped;
  }

  /** Deactivates any Basic/Zoomer/Chaser projectile inside the slash hitbox. Stop Waves are immune to Slash. Returns how many were hit. */
  checkSlashHits(hitbox: SlashHitbox | null): number {
    if (!hitbox) {
      return 0;
    }
    const onHit = (x: number, y: number) => spawnPop(this.scene, x, y, SLASH_KILL_POP_COLOR);
    return (
      checkSlashHitsOnPool(this.basicPool, hitbox, onHit) +
      checkSlashHitsOnPool(this.zoomerPool, hitbox, onHit) +
      checkSlashHitsOnPool(this.chaserPool, hitbox, onHit)
    );
  }

  /** Deactivates any Basic/Zoomer/Chaser projectile touching the player and returns the damage dealt. Only call while the player isn't invincible. */
  checkPlayerCollisions(playerX: number, playerY: number, playerRadius: number): number {
    const onHit = (x: number, y: number) => spawnPop(this.scene, x, y, HIT_POP_COLOR);
    return (
      checkContactOnPool(this.basicPool, playerX, playerY, playerRadius, onHit) +
      checkContactOnPool(this.zoomerPool, playerX, playerY, playerRadius, onHit) +
      checkContactOnPool(this.chaserPool, playerX, playerY, playerRadius, onHit)
    );
  }

  /**
   * Stop Wave damages on contact with its solid section regardless of dash
   * state - it bypasses dash i-frames entirely, unlike Basic/Zoomer/Chaser.
   * Unlike those types, contact doesn't deactivate it: it's a persistent
   * sweeping hazard, not something destroyed by touching it, so call this
   * every frame (see MainScene, which gates it behind the general post-hit
   * grace window instead, to avoid re-damaging every frame of an ongoing
   * overlap while the bar sweeps past).
   */
  checkStopWaveCollisions(playerX: number, playerY: number, playerRadius: number): number {
    const onHit = (x: number, y: number) => spawnPop(this.scene, x, y, HIT_POP_COLOR);
    return checkStopWaveContact(this.stopWavePool, playerX, playerY, playerRadius, onHit);
  }
}
