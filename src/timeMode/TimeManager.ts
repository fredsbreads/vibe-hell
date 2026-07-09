import Phaser from "phaser";
import { Arena } from "../arena/Arena";
import { Enemy } from "./Enemy";
import { TimeProjectile, ProjectileKind, BASE_DEFLECT_SPEED, DEFLECT_MAX_WALL_BOUNCES } from "./TimeProjectile";
import { SlashHitbox } from "./TimePlayer";
import { spawnPop } from "../effects/spawnPop";

const ENEMY_POOL_SIZE = 20;
const ENEMY_SPAWN_INTERVAL_MS = 1500;
const INITIAL_ENEMY_COUNT = 3;
/** Rejection-sample radius around the player - keeps a freshly-spawned enemy from appearing right on top of you. */
const ENEMY_MIN_SPAWN_DIST_FROM_PLAYER = 140;
const MAX_SPAWN_ATTEMPTS = 20;

const PROJECTILE_POOL_SIZE = 60;
const PROJECTILE_RADIUS = 7;
/** Base color for the shared projectile texture - every projectile is tinted per-kind on activate anyway (see TimeProjectile), so this only needs to be a valid opaque placeholder. */
export const PROJECTILE_COLOR = 0xf2e85c;

/** Every kind an enemy can fire, picked with equal odds per shot (see fireProjectile). */
const PROJECTILE_KINDS: ProjectileKind[] = ["straight", "zoomer", "chaser", "ricochet"];

const KILL_POP_COLOR = 0xffe98a;
const DEFLECT_POP_COLOR = 0x59f2c8;
const HIT_POP_COLOR = 0xff3b3b;

/**
 * QoL "would this get deflected right now" preview - a highlight ring plus a
 * dashed line showing the trajectory a hit projectile would fly off along.
 * deflect() always redirects along the hitbox's angle (the player's aim, not
 * the projectile's incoming direction), so the dashed line is drawn along
 * that same angle - it's an exact preview, not an approximation.
 */
const SLASH_PREVIEW_COLOR = 0xffffff;
const SLASH_PREVIEW_RING_PADDING = 5;
/** Base trajectory-line length at BASE_DEFLECT_SPEED - actual length scales with each projectile's real deflectSpeed (see drawPreviewHighlight), so a faster post-deflect shot (a zoomer) telegraphs with a visibly longer line. */
const SLASH_PREVIEW_BASE_LINE_LENGTH = 70;
const SLASH_PREVIEW_MIN_LINE_LENGTH = 30;
const SLASH_PREVIEW_MAX_LINE_LENGTH = 160;
const SLASH_PREVIEW_DASH_LENGTH = 8;
const SLASH_PREVIEW_GAP_LENGTH = 6;
const SLASH_PREVIEW_PULSE_PERIOD_MS = 260;
const SLASH_PREVIEW_MIN_ALPHA = 0.55;
const SLASH_PREVIEW_MAX_ALPHA = 1;
/** March step (px) used to trace the preview line's path against the arena wall - same mirror-bounce math bounceOffWall() applies per-frame to a real projectile, just walked instantly instead of over several frames. Small enough that the approximate bounce point reads as accurate. */
const SLASH_PREVIEW_MARCH_STEP = 4;
/** Safety cap on bounces traced within one preview line - the line is short enough that hitting this in practice would mean a degenerate arena, not normal play. */
const SLASH_PREVIEW_MAX_BOUNCES = 4;
/** Extra length granted to the budget each time the preview path bounces off a wall - without this, a bounce early in the line leaves too little of the length budget for the post-bounce segment to show anything useful. */
const SLASH_PREVIEW_BOUNCE_BONUS = 40;

/**
 * Owns the enemy and projectile pools for the time-dilation mode, and every
 * interaction between them: Slash deflects a hostile projectile or kills an
 * enemy outright (one hit, either way); a deflected/friendly projectile
 * kills any hostile projectile OR enemy it touches, chaining onward each
 * time - through a hostile projectile it just destroys and keeps going,
 * through an enemy it also kills but additionally bounces off (round body,
 * so the angle depends on exactly where it hit - see
 * TimeProjectile.bounceOffPoint), continuing to fly rather than stopping
 * there. A deflected projectile only survives ONE wall bounce, but bouncing
 * off an enemy refreshes that budget - so it can chain through enemies
 * indefinitely, but two wall bounces in a row without an enemy kill in
 * between ends it (see DEFLECT_MAX_WALL_BOUNCES). Bouncing off an enemy also
 * makes the projectile re-deflectable - Slash can pick it up and re-aim it
 * again, though only once it's bounced off something since the last
 * deflect, not the instant it's redirected (see
 * TimeProjectile.isReDeflectable). A still-hostile projectile touching the
 * player is instant death (touching an enemy's body is not).
 *
 * Enemy spawning and every step of both pools runs on the caller-supplied
 * world-scaled delta - "the world" only advances while the player is
 * moving, spawns included.
 */
export class TimeManager {
  private readonly enemyPool: Enemy[] = [];
  private readonly projectilePool: TimeProjectile[] = [];
  private readonly previewGraphic: Phaser.GameObjects.Graphics;
  private enemySpawnTimerMs = ENEMY_SPAWN_INTERVAL_MS;
  private previewPulseMs = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly arena: Arena,
  ) {
    for (let i = 0; i < ENEMY_POOL_SIZE; i++) {
      this.enemyPool.push(new Enemy(scene));
    }
    for (let i = 0; i < PROJECTILE_POOL_SIZE; i++) {
      this.projectilePool.push(new TimeProjectile(scene, "time-projectile", PROJECTILE_RADIUS));
    }
    this.previewGraphic = scene.add.graphics();
  }

  get enemiesAlive(): number {
    return this.enemyPool.filter((e) => e.isAlive).length;
  }

  /** Spawns the run's starting enemies immediately, same placement rules as a normal timed spawn. */
  spawnInitialEnemies(playerX: number, playerY: number): void {
    for (let i = 0; i < INITIAL_ENEMY_COUNT; i++) {
      this.spawnOneEnemy(playerX, playerY);
    }
  }

  /** Advances everything by one frame. realDelta drives the deflect burst window; worldScaledDelta drives every other movement/timer. Returns how many hostile projectiles/enemies a deflected projectile destroyed by contact this frame (scores the same as a direct Slash kill). */
  update(realDelta: number, worldScaledDelta: number, playerX: number, playerY: number): number {
    this.trySpawnEnemy(worldScaledDelta, playerX, playerY);

    for (const enemy of this.enemyPool) {
      if (!enemy.isAlive) {
        continue;
      }
      this.clampEnemyToArena(enemy);
      const fireAngle = enemy.step(worldScaledDelta, playerX, playerY);
      if (fireAngle !== null) {
        this.fireProjectile(enemy.x, enemy.y, fireAngle);
      }
    }

    for (const projectile of this.projectilePool) {
      if (!projectile.active) {
        continue;
      }
      if (projectile.step(realDelta, worldScaledDelta, this.arena, playerX, playerY)) {
        projectile.deactivate();
      }
    }

    return this.checkDeflectedKills();
  }

  /** Deflects a hostile projectile in range (or re-deflects an already-deflected one that's bounced off an enemy since - see TimeProjectile.isReDeflectable), or kills an enemy in range outright (one hit). Returns how many enemies were killed this way (scores the same as a deflected-projectile kill). */
  checkSlashHits(hitbox: SlashHitbox | null): number {
    if (!hitbox) {
      return 0;
    }

    for (const projectile of this.projectilePool) {
      if (!projectile.active) {
        continue;
      }
      if (projectile.deflected && !projectile.isReDeflectable) {
        continue;
      }
      // A swing's hitbox stays active across several frames - without this,
      // a projectile that bounces off an enemy (becoming re-deflectable
      // again) mid-swing could get hit twice by the same physical swing.
      if (projectile.wasHitBySwing(hitbox.swingId)) {
        continue;
      }
      if (this.isWithinSlashArc(projectile.x, projectile.y, projectile.radius, hitbox)) {
        spawnPop(this.scene, projectile.x, projectile.y, DEFLECT_POP_COLOR);
        projectile.deflect(hitbox.angle, hitbox.swingId);
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

  /**
   * QoL preview: highlights every hostile projectile that a Slash swung
   * RIGHT NOW (previewHitbox) would deflect, plus a dashed line showing the
   * direction it would fly off in (see the SLASH_PREVIEW_* doc comment) -
   * and every enemy it would kill outright, ring only, since a killed enemy
   * doesn't fly off anywhere to trace a line for. Null hitbox (Slash not
   * ready) just clears the preview. realDelta drives the highlight's pulse,
   * independent of world dilation - it's a UI aid, not part of "the world".
   */
  updateSlashPreview(previewHitbox: SlashHitbox | null, realDelta: number): void {
    this.previewPulseMs += realDelta;
    this.previewGraphic.clear();
    if (!previewHitbox) {
      return;
    }

    const pulse = (Math.sin((this.previewPulseMs / SLASH_PREVIEW_PULSE_PERIOD_MS) * Math.PI * 2) + 1) / 2;
    const alpha = Phaser.Math.Linear(SLASH_PREVIEW_MIN_ALPHA, SLASH_PREVIEW_MAX_ALPHA, pulse);

    for (const projectile of this.projectilePool) {
      if (!projectile.active) {
        continue;
      }
      if (projectile.deflected && !projectile.isReDeflectable) {
        continue;
      }
      if (!this.isWithinSlashArc(projectile.x, projectile.y, projectile.radius, previewHitbox)) {
        continue;
      }
      this.drawPreviewHighlight(projectile, previewHitbox.angle, alpha);
    }

    for (const enemy of this.enemyPool) {
      if (!enemy.isAlive) {
        continue;
      }
      if (!this.isWithinSlashArc(enemy.x, enemy.y, Enemy.RADIUS, previewHitbox)) {
        continue;
      }
      this.drawPreviewRing(enemy.x, enemy.y, Enemy.RADIUS, alpha);
    }
  }

  private drawPreviewRing(x: number, y: number, radius: number, alpha: number): void {
    this.previewGraphic.lineStyle(2, SLASH_PREVIEW_COLOR, alpha);
    this.previewGraphic.strokeCircle(x, y, radius + SLASH_PREVIEW_RING_PADDING);
  }

  private drawPreviewHighlight(projectile: TimeProjectile, trajectoryAngle: number, alpha: number): void {
    this.drawPreviewRing(projectile.x, projectile.y, projectile.radius, alpha);

    // Scale the line length by how much faster/slower this particular
    // projectile's post-deflect speed is than the baseline - so a zoomer
    // (2x speed, 2x deflectSpeed) telegraphs with a visibly longer line.
    const speedRatio = projectile.deflectSpeed / BASE_DEFLECT_SPEED;
    const lineLength = Phaser.Math.Clamp(
      SLASH_PREVIEW_BASE_LINE_LENGTH * speedRatio,
      SLASH_PREVIEW_MIN_LINE_LENGTH,
      SLASH_PREVIEW_MAX_LINE_LENGTH,
    );

    const { path, hitEnemies } = this.buildPreviewPath(projectile.x, projectile.y, trajectoryAngle, projectile.radius, lineLength);
    this.drawDashedPath(path);
    // Any enemy further down the chain also gets the same ring the primary
    // target does - "this too is on the path and would get hit", not just
    // the very first thing in slash range right now.
    for (const enemy of hitEnemies) {
      this.drawPreviewRing(enemy.x, enemy.y, Enemy.RADIUS, alpha);
    }
  }

  /**
   * Traces the preview trajectory out to lineLength, bending it off the
   * arena wall OR off any alive enemy's round body (mirror-reflect, same
   * math as TimeProjectile.bounceOffWall()/bounceOffPoint()) instead of
   * letting it run straight through either - so a deflect preview shows
   * where the shot would actually go, bounces included, rather than a line
   * that visually cuts through walls or enemies. Each bounce also grants
   * SLASH_PREVIEW_BOUNCE_BONUS extra length, so the post-bounce segment
   * itself is long enough to actually show a direction, rather than being
   * whatever sliver of the original budget happened to be left.
   *
   * Also tracks the exact same wall-bounce budget the real projectile does
   * (DEFLECT_MAX_WALL_BOUNCES, refreshed by an enemy bounce, consumed by a
   * wall bounce) - the trace stops dead the instant that budget would run
   * out, same as the real projectile would despawn there, rather than
   * drawing a trajectory that isn't actually survivable.
   *
   * Marches in small steps rather than solving either intersection
   * analytically, since the arena boundary's distance-per-angle isn't a
   * simple closed form for a rotating polygon anyway - good enough
   * precision for a cosmetic guide line.
   *
   * Also collects every enemy the path bounces off (hitEnemies) - the
   * caller rings each of those too, not just the very first thing in slash
   * range right now, so "this is also on the path and would get hit" is
   * visible as far down the chain as the trace goes. Deliberately doesn't
   * do the same for hostile projectiles: they don't redirect the path (no
   * bounce happens there, it just destroys them and keeps flying straight),
   * and unlike a stationary enemy they're actively moving, so a "will this
   * still be here when the real shot arrives" prediction would be far less
   * reliable - not worth the complexity for markers that could easily lie.
   */
  private buildPreviewPath(
    startX: number,
    startY: number,
    angle: number,
    radius: number,
    lineLength: number,
  ): { path: { x: number; y: number }[]; hitEnemies: Enemy[] } {
    const points: { x: number; y: number }[] = [{ x: startX, y: startY }];
    const hitEnemies: Enemy[] = [];
    let x = startX;
    let y = startY;
    let dirX = Math.cos(angle);
    let dirY = Math.sin(angle);
    let remaining = lineLength;
    let bounces = 0;
    let wallBounceBudget = DEFLECT_MAX_WALL_BOUNCES;

    while (remaining > 0 && bounces <= SLASH_PREVIEW_MAX_BOUNCES) {
      const step = Math.min(SLASH_PREVIEW_MARCH_STEP, remaining);
      const nextX = x + dirX * step;
      const nextY = y + dirY * step;

      const blockingEnemy = this.findEnemyBlockingPoint(nextX, nextY, radius);
      if (blockingEnemy) {
        const dx = nextX - blockingEnemy.x;
        const dy = nextY - blockingEnemy.y;
        const distFromEnemy = Math.hypot(dx, dy);
        const minDist = Enemy.RADIUS + radius;
        const scale = minDist / distFromEnemy;
        x = blockingEnemy.x + dx * scale;
        y = blockingEnemy.y + dy * scale;
        points.push({ x, y });
        hitEnemies.push(blockingEnemy);

        const nx = dx / distFromEnemy;
        const ny = dy / distFromEnemy;
        const dot = dirX * nx + dirY * ny;
        dirX -= 2 * dot * nx;
        dirY -= 2 * dot * ny;

        wallBounceBudget = DEFLECT_MAX_WALL_BOUNCES;
        remaining -= step;
        remaining += SLASH_PREVIEW_BOUNCE_BONUS;
        bounces++;
        continue;
      }

      const dx = nextX - this.arena.bounds.centerX;
      const dy = nextY - this.arena.bounds.centerY;
      const distFromCenter = Math.hypot(dx, dy);
      const angleAtPoint = Math.atan2(dy, dx);
      const maxDist = this.arena.maxRadiusAtAngle(angleAtPoint) - radius;

      if (distFromCenter <= maxDist) {
        x = nextX;
        y = nextY;
        remaining -= step;
        continue;
      }

      const scale = maxDist / distFromCenter;
      x = this.arena.bounds.centerX + dx * scale;
      y = this.arena.bounds.centerY + dy * scale;
      points.push({ x, y });

      wallBounceBudget--;
      if (wallBounceBudget <= 0) {
        // The real projectile despawns right here - the trace ends at this
        // bounce point instead of drawing a trajectory it wouldn't survive.
        break;
      }

      const n = this.arena.normalAtAngle(angleAtPoint);
      const dot = dirX * n.x + dirY * n.y;
      dirX -= 2 * dot * n.x;
      dirY -= 2 * dot * n.y;

      remaining -= step;
      remaining += SLASH_PREVIEW_BOUNCE_BONUS;
      bounces++;
    }

    points.push({ x, y });
    return { path: points, hitEnemies };
  }

  /** The first alive enemy whose round body would block a point on the preview's march, or null if none does. */
  private findEnemyBlockingPoint(x: number, y: number, radius: number): Enemy | null {
    const minDist = Enemy.RADIUS + radius;
    for (const enemy of this.enemyPool) {
      if (!enemy.isAlive) {
        continue;
      }
      const dx = x - enemy.x;
      const dy = y - enemy.y;
      if (dx * dx + dy * dy <= minDist * minDist) {
        return enemy;
      }
    }
    return null;
  }

  private drawDashedPath(points: { x: number; y: number }[]): void {
    const dashPitch = SLASH_PREVIEW_DASH_LENGTH + SLASH_PREVIEW_GAP_LENGTH;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const segLength = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLength === 0) {
        continue;
      }
      const dirX = (b.x - a.x) / segLength;
      const dirY = (b.y - a.y) / segLength;
      for (let traveled = 0; traveled < segLength; traveled += dashPitch) {
        const segStart = traveled;
        const segEnd = Math.min(traveled + SLASH_PREVIEW_DASH_LENGTH, segLength);
        this.previewGraphic.lineBetween(a.x + dirX * segStart, a.y + dirY * segStart, a.x + dirX * segEnd, a.y + dirY * segEnd);
      }
    }
  }

  private fireProjectile(x: number, y: number, angle: number): void {
    const projectile = this.projectilePool.find((p) => !p.active);
    const kind = PROJECTILE_KINDS[Math.floor(Math.random() * PROJECTILE_KINDS.length)];
    projectile?.activate(x, y, angle, kind);
  }

  private trySpawnEnemy(worldScaledDelta: number, playerX: number, playerY: number): void {
    this.enemySpawnTimerMs -= worldScaledDelta;
    if (this.enemySpawnTimerMs > 0) {
      return;
    }
    this.enemySpawnTimerMs = ENEMY_SPAWN_INTERVAL_MS;
    this.spawnOneEnemy(playerX, playerY);
  }

  /** Activates one free enemy at a random point in the arena, rejection-sampled to stay at least ENEMY_MIN_SPAWN_DIST_FROM_PLAYER away. No-op if the pool is full or no valid spot is found within MAX_SPAWN_ATTEMPTS. */
  private spawnOneEnemy(playerX: number, playerY: number): void {
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
          const enemyX = enemy.x;
          const enemyY = enemy.y;
          enemy.deactivate();
          kills++;
          // The enemy still dies in one hit, same as ever - but the
          // projectile now bounces off its round body (deflecting off
          // enemies is the point) and keeps flying, instead of ending its
          // journey there. Refreshes the wall-bounce budget back to full
          // rather than consuming it (see TimeProjectile.bounceOffPoint) -
          // enemy bounces are unlimited, wall bounces are the limited part.
          deflected.bounceOffPoint(enemyX, enemyY);
          break;
        }
      }
    }
    return kills;
  }

  /**
   * The distance check already treats the target as a circle (it passes as
   * soon as the target's EDGE reaches into the range circle, not just its
   * center). The angle check used to only look at the angle to the target's
   * CENTER, with zero tolerance for its radius - so a projectile whose edge
   * visually overlapped the arc's boundary line could still fail if its
   * center sat just outside. Widening the allowed half-angle by
   * asin(radius / distance) - the extra angle a circle of that radius
   * subtends from the hitbox origin - makes the angle check agree with the
   * distance check: touching the arc at all is enough, matching the "does
   * this circle overlap this wedge" test a player would expect from sight.
   */
  private isWithinSlashArc(x: number, y: number, radius: number, hitbox: SlashHitbox): boolean {
    const dx = x - hitbox.x;
    const dy = y - hitbox.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > hitbox.range + radius) {
      return false;
    }
    if (distance <= radius) {
      // The hitbox origin is inside (or touching the center of) the target - no angle to check.
      return true;
    }
    const angleToTarget = Math.atan2(dy, dx);
    const angleDiff = Phaser.Math.Angle.Wrap(angleToTarget - hitbox.angle);
    const angularRadius = Math.asin(radius / distance);
    return Math.abs(angleDiff) <= hitbox.arcWidth / 2 + angularRadius;
  }
}
