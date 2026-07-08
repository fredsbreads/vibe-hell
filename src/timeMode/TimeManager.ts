import Phaser from "phaser";
import { Arena } from "../arena/Arena";
import { Enemy } from "./Enemy";
import { TimeProjectile } from "./TimeProjectile";
import { SlashHitbox } from "./TimePlayer";
import { spawnPop } from "../effects/spawnPop";

const ENEMY_POOL_SIZE = 20;
const ENEMY_SPAWN_INTERVAL_MS = 3000;
/** Rejection-sample radius around the player - keeps a freshly-spawned enemy from appearing right on top of you. */
const ENEMY_MIN_SPAWN_DIST_FROM_PLAYER = 140;
const MAX_SPAWN_ATTEMPTS = 20;

const PROJECTILE_POOL_SIZE = 60;
const PROJECTILE_SPEED = 200;
const PROJECTILE_RADIUS = 7;
/** Exported so the scene can generate the matching texture with this same color - single source of truth. */
export const PROJECTILE_COLOR = 0xf2e85c;

const KILL_POP_COLOR = 0xffe98a;
const DEFLECT_POP_COLOR = 0x59f2c8;
const HIT_POP_COLOR = 0xff3b3b;

/**
 * Telegraph aim line, shown for each enemy currently winding up a shot -
 * reveals the actual angle it's about to fire at (imperfection included),
 * not just "something's coming". Kept as its own clearly separable block
 * (one field, one draw call) since this is the half of the telegraph most
 * likely to get cut after playtesting, per the design discussion - the
 * wind-up glow/scale on the enemy itself (see Enemy.ts) is expected to stay
 * either way.
 */
const TELEGRAPH_LINE_LENGTH = 50;
const TELEGRAPH_LINE_COLOR = 0xffe98a;

/**
 * Owns the enemy and projectile pools for the time-dilation mode, and every
 * interaction between them: Slash deflects a hostile projectile or kills an
 * enemy outright (one hit, either way); a deflected/friendly projectile
 * kills any hostile projectile OR enemy it touches for the rest of its
 * life; a still-hostile projectile touching the player is instant death
 * (touching an enemy's body is not).
 *
 * Enemy spawning and every step of both pools runs on the caller-supplied
 * world-scaled delta - "the world" only advances while the player is
 * moving, spawns included.
 */
export class TimeManager {
  private readonly enemyPool: Enemy[] = [];
  private readonly projectilePool: TimeProjectile[] = [];
  private readonly telegraphGraphic: Phaser.GameObjects.Graphics;
  private enemySpawnTimerMs = ENEMY_SPAWN_INTERVAL_MS;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly arena: Arena,
  ) {
    for (let i = 0; i < ENEMY_POOL_SIZE; i++) {
      this.enemyPool.push(new Enemy(scene));
    }
    for (let i = 0; i < PROJECTILE_POOL_SIZE; i++) {
      this.projectilePool.push(new TimeProjectile(scene, "time-projectile", PROJECTILE_SPEED, PROJECTILE_RADIUS, PROJECTILE_COLOR));
    }
    this.telegraphGraphic = scene.add.graphics();
  }

  get enemiesAlive(): number {
    return this.enemyPool.filter((e) => e.isAlive).length;
  }

  /** Advances everything by one frame. realDelta drives the deflect burst window; worldScaledDelta drives every other movement/timer. Returns how many hostile projectiles/enemies a deflected projectile destroyed by contact this frame (scores the same as a direct Slash kill). */
  update(realDelta: number, worldScaledDelta: number, playerX: number, playerY: number): number {
    this.trySpawnEnemy(worldScaledDelta, playerX, playerY);

    this.telegraphGraphic.clear();
    for (const enemy of this.enemyPool) {
      if (!enemy.isAlive) {
        continue;
      }
      this.clampEnemyToArena(enemy);
      const fireAngle = enemy.step(worldScaledDelta, playerX, playerY);
      if (fireAngle !== null) {
        this.fireProjectile(enemy.x, enemy.y, fireAngle);
      } else if (enemy.isTelegraphing) {
        this.drawTelegraphLine(enemy);
      }
    }

    for (const projectile of this.projectilePool) {
      if (!projectile.active) {
        continue;
      }
      if (projectile.step(realDelta, worldScaledDelta, this.arena)) {
        projectile.deactivate();
      }
    }

    return this.checkDeflectedKills();
  }

  /** The telegraph aim line - see the const doc comment above for why this is kept as one easily-removable block. */
  private drawTelegraphLine(enemy: Enemy): void {
    const tipX = enemy.x + Math.cos(enemy.telegraphAngle) * TELEGRAPH_LINE_LENGTH;
    const tipY = enemy.y + Math.sin(enemy.telegraphAngle) * TELEGRAPH_LINE_LENGTH;
    this.telegraphGraphic.lineStyle(2, TELEGRAPH_LINE_COLOR, 0.3 + enemy.telegraphProgress * 0.6);
    this.telegraphGraphic.lineBetween(enemy.x, enemy.y, tipX, tipY);
  }

  /** Deflects a hostile projectile in range, or kills an enemy in range outright (one hit). Returns how many enemies were killed this way (scores the same as a deflected-projectile kill). */
  checkSlashHits(hitbox: SlashHitbox | null): number {
    if (!hitbox) {
      return 0;
    }

    for (const projectile of this.projectilePool) {
      if (!projectile.active || projectile.deflected) {
        continue;
      }
      if (this.isWithinSlashArc(projectile.x, projectile.y, projectile.radius, hitbox)) {
        spawnPop(this.scene, projectile.x, projectile.y, DEFLECT_POP_COLOR);
        projectile.deflect(hitbox.angle);
      }
    }

    let enemyKills = 0;
    for (const enemy of this.enemyPool) {
      if (!enemy.isAlive) {
        continue;
      }
      if (this.isWithinSlashArc(enemy.x, enemy.y, Enemy.RADIUS, hitbox)) {
        spawnPop(this.scene, enemy.x, enemy.y, KILL_POP_COLOR);
        enemy.deactivate();
        enemyKills++;
      }
    }
    return enemyKills;
  }

  /** True (and consumes the projectile) if any still-hostile projectile is touching the player - the caller is responsible for treating this as instant death. Contact with an enemy's body is deliberately not checked here at all. */
  checkPlayerHit(playerX: number, playerY: number, playerRadius: number): boolean {
    for (const projectile of this.projectilePool) {
      if (!projectile.active || projectile.deflected) {
        continue;
      }
      const dx = projectile.x - playerX;
      const dy = projectile.y - playerY;
      const minDist = playerRadius + projectile.radius;
      if (dx * dx + dy * dy <= minDist * minDist) {
        spawnPop(this.scene, projectile.x, projectile.y, HIT_POP_COLOR);
        return true;
      }
    }
    return false;
  }

  private fireProjectile(x: number, y: number, angle: number): void {
    const projectile = this.projectilePool.find((p) => !p.active);
    projectile?.activate(x, y, angle);
  }

  private trySpawnEnemy(worldScaledDelta: number, playerX: number, playerY: number): void {
    this.enemySpawnTimerMs -= worldScaledDelta;
    if (this.enemySpawnTimerMs > 0) {
      return;
    }
    this.enemySpawnTimerMs = ENEMY_SPAWN_INTERVAL_MS;

    const enemy = this.enemyPool.find((e) => !e.isAlive);
    if (!enemy) {
      return;
    }

    for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const maxRadius = this.arena.maxRadiusAtAngle(angle) - Enemy.RADIUS - 10;
      const dist = Math.random() * maxRadius;
      const x = this.arena.bounds.centerX + Math.cos(angle) * dist;
      const y = this.arena.bounds.centerY + Math.sin(angle) * dist;
      const distFromPlayer = Math.hypot(x - playerX, y - playerY);
      if (distFromPlayer >= ENEMY_MIN_SPAWN_DIST_FROM_PLAYER) {
        enemy.activate(x, y);
        return;
      }
    }
  }

  /**
   * Enemies don't move on their own yet, but the arena's boundary does - it
   * rotates continuously, and a polygon's distance-to-wall varies by angle
   * (an edge midpoint sits closer to center than a vertex does). A position
   * that was safely inside at spawn time can end up outside as that varying
   * boundary sweeps past underneath a stationary enemy, clipping it through
   * the wall. Re-clamping every frame against the CURRENT (rotated)
   * boundary keeps it visually pinned just inside the wall instead.
   */
  private clampEnemyToArena(enemy: Enemy): void {
    const dx = enemy.x - this.arena.bounds.centerX;
    const dy = enemy.y - this.arena.bounds.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 0) {
      return;
    }
    const angle = Math.atan2(dy, dx);
    const maxDist = this.arena.maxRadiusAtAngle(angle) - Enemy.RADIUS;
    if (dist > maxDist) {
      const scale = maxDist / dist;
      enemy.x = this.arena.bounds.centerX + dx * scale;
      enemy.y = this.arena.bounds.centerY + dy * scale;
    }
  }

  /** A deflected/friendly projectile destroys any hostile projectile OR enemy it touches, for as long as it's alive. Returns how many kills happened this frame. */
  private checkDeflectedKills(): number {
    let kills = 0;
    for (const deflected of this.projectilePool) {
      if (!deflected.active || !deflected.deflected) {
        continue;
      }
      for (const hostile of this.projectilePool) {
        if (hostile === deflected || !hostile.active || hostile.deflected) {
          continue;
        }
        const dx = hostile.x - deflected.x;
        const dy = hostile.y - deflected.y;
        const minDist = hostile.radius + deflected.radius;
        if (dx * dx + dy * dy <= minDist * minDist) {
          spawnPop(this.scene, hostile.x, hostile.y, KILL_POP_COLOR);
          hostile.deactivate();
          kills++;
        }
      }
      for (const enemy of this.enemyPool) {
        if (!enemy.isAlive) {
          continue;
        }
        const dx = enemy.x - deflected.x;
        const dy = enemy.y - deflected.y;
        const minDist = Enemy.RADIUS + deflected.radius;
        if (dx * dx + dy * dy <= minDist * minDist) {
          spawnPop(this.scene, enemy.x, enemy.y, KILL_POP_COLOR);
          enemy.deactivate();
          kills++;
          // Unlike chaining through hostile projectiles (which a friendly
          // projectile keeps living to potentially do more of), landing the
          // kill on an actual enemy ends its own journey too - a bigger,
          // more final hit than just clearing another bullet out of the air.
          deflected.deactivate();
          break;
        }
      }
    }
    return kills;
  }

  private isWithinSlashArc(x: number, y: number, radius: number, hitbox: SlashHitbox): boolean {
    const dx = x - hitbox.x;
    const dy = y - hitbox.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > hitbox.range + radius) {
      return false;
    }
    const angleToTarget = Math.atan2(dy, dx);
    const angleDiff = Phaser.Math.Angle.Wrap(angleToTarget - hitbox.angle);
    return Math.abs(angleDiff) <= hitbox.arcWidth / 2;
  }
}
