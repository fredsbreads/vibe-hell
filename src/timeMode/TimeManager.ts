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
/** Rejection-sample radius around every other alive enemy - keeps two enemies from spawning on top of (or touching) each other. Comfortably more than 2x Enemy.RADIUS (28) so they land visibly separated, not just non-overlapping. */
const ENEMY_MIN_SPAWN_DIST_FROM_OTHER_ENEMIES = 50;
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
/** Length (px) of the small floating "in" and "out" stub segments drawn at each chained enemy beyond what the primary line reaches - see buildChainHops. Short and local by design: it's a directional cue for that one bounce, not a connecting line across whatever empty space sits before/after it. */
const SLASH_PREVIEW_CHAIN_STUB_LENGTH = 26;
/** Safety cap on how many enemy-to-enemy hops the chain lookahead will follow beyond the primary line - the chain is stopped for real by the first wall bounce or by running out of alive enemies long before this, this just guards against a degenerate arrangement of enemies bouncing back and forth forever. */
const SLASH_PREVIEW_MAX_CHAIN_HOPS = 6;
/** How far (rad, each direction) the aim-snap search looks around the player's raw aim (or, while already locked, around the locked angle) for a nearby angle that chains into an extra enemy - see computeSnappedAimAngle. Comfortably inside SLASH_ARC_WIDTH/2 so a snapped angle can't aim the swing at a completely different projectile than the one the player was actually pointing at. */
const SLASH_SNAP_SEARCH_HALF_WIDTH = 0.22;
/** Angle step (rad) the aim-snap search samples at - fine enough that the snapped angle reads as landing right on the real bounce, not visibly short of it. */
const SLASH_SNAP_SEARCH_STEP = 0.01;
/**
 * How far (rad) raw aim can drift from an already-locked snap angle before
 * the lock actually releases - deliberately wider than
 * SLASH_SNAP_SEARCH_HALF_WIDTH (the window used to find/enter a lock in the
 * first place), so the snap acts like a magnet: easy to fall into, harder
 * to fall back out of. Without this asymmetry, recomputing the same tight
 * window fresh off raw aim every frame meant the lock let go the instant
 * raw aim drifted even slightly past the angle it snapped to - "breaks free
 * too easily". Still comfortably under SLASH_ARC_WIDTH/2 so it can never
 * hold onto a lock the current swing arc wouldn't actually reach.
 */
const SLASH_SNAP_RELEASE_HALF_WIDTH = 0.4;
/**
 * Minimum total enemies a deflect must hit (the primary target itself, plus
 * at least this many MORE from bounces) before an angle counts as "chain-
 * worthy" at all - for both the continuous mouse/keyboard snap and the
 * gamepad flick-lock's candidate list. A single extra bounce is common
 * enough (and easy enough to land on your own) that assisting toward it
 * just felt like noise; this reserves the assist for trajectories actually
 * worth fighting the tiny margin for.
 */
const SLASH_SNAP_MIN_ADDITIONAL_BOUNCES = 2;
const SLASH_SNAP_MIN_TOTAL_HITS = 1 + SLASH_SNAP_MIN_ADDITIONAL_BOUNCES;

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
  /** The aim-snap "magnet" lock - see computeSnappedAimAngle. Null whenever nothing is currently locked. snapLockedAngle exists purely as a tie-break reference (closest-to-last-frame) when multiple candidates share the same chainMatchScore - the chain (not the angle) is the actual identity. */
  private snapLockedChain: Enemy[] | null = null;
  private snapLockedAngle: number | null = null;
  private snapLockedProjectile: TimeProjectile | null = null;

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

  /**
   * Aim assist: the exact angle that chains a deflect into 2+ additional
   * enemies is often only a fraction of a degree wide (see buildChainHops) -
   * far too tight to reliably hit by feel. Shares its underlying candidate
   * search (findChainCandidateAngles) with the gamepad flick-lock
   * (findChainLock) rather than running its own separate narrower search -
   * an earlier version of this method tracked a single locked angle
   * (rather than which ENEMIES it routed through) and re-searched a fixed
   * window around it every frame, which meant the constantly-moving target
   * projectile made even a rock-steady mouse read as jittery: the "best
   * angle within the window" is itself a moving target when the geometry
   * producing it never stops shifting.
   *
   * Instead, this locks onto a CHAIN (an ordered list of enemies - see
   * snapLockedChain) and, every frame, re-derives whichever current
   * candidate shares the longest matching prefix with it (same
   * chainMatchScore idea TimePlayer's flick-lock uses) - the angle is free
   * to drift smoothly frame to frame to keep threading that same chain as
   * things move, but the SELECTION itself only changes when raw aim
   * deliberately moves toward a different candidate. A wider release margin
   * (SLASH_SNAP_RELEASE_HALF_WIDTH vs the tighter SLASH_SNAP_SEARCH_HALF_
   * WIDTH used to newly engage one) means raw aim has to drift meaningfully
   * away before that switch happens, not just wobble past whatever the
   * locked chain's current angle happens to be.
   */
  computeSnappedAimAngle(playerX: number, playerY: number, rawAngle: number, range: number, arcWidth: number): number {
    const rawHitbox: SlashHitbox = { x: playerX, y: playerY, angle: rawAngle, range, arcWidth, swingId: -1 };
    let projectile = this.snapLockedProjectile;
    if (projectile && (!projectile.active || (projectile.deflected && !projectile.isReDeflectable))) {
      projectile = null;
    }
    if (!projectile) {
      projectile = this.findSnapTargetProjectile(playerX, playerY, rawAngle, rawHitbox);
    }
    if (!projectile) {
      this.snapLockedChain = null;
      this.snapLockedAngle = null;
      this.snapLockedProjectile = null;
      return rawAngle;
    }

    const preferredChain = this.snapLockedProjectile === projectile ? this.snapLockedChain : null;
    const candidates = this.findChainCandidateAngles(
      playerX,
      playerY,
      projectile,
      range,
      arcWidth,
      preferredChain,
      this.snapLockedAngle ?? 0,
    );
    if (candidates.length === 0) {
      this.snapLockedChain = null;
      this.snapLockedAngle = null;
      this.snapLockedProjectile = null;
      return rawAngle;
    }

    // Still the same target as last frame - try to keep riding whichever
    // candidate best continues the previously locked chain, as long as raw
    // aim hasn't drifted past the (wider) release margin from its current
    // angle. Ties in match score (two candidates sharing an equally long
    // prefix - e.g. a chain that occasionally ping-pongs into a longer or
    // shorter tail) are broken by proximity to the PREVIOUS frame's angle,
    // not just whichever happens to sort first - otherwise a tie could
    // silently flip the pick between two candidates as their exact extents
    // shift with the moving target, which is its own source of jitter.
    if (this.snapLockedProjectile === projectile && this.snapLockedChain && this.snapLockedAngle !== null) {
      let best: { angle: number; count: number; enemies: Enemy[] } | null = null;
      let bestScore = -1;
      let bestDist = Infinity;
      for (const candidate of candidates) {
        const score = this.chainMatchScore(candidate.enemies, this.snapLockedChain);
        const dist = Math.abs(Phaser.Math.Angle.Wrap(candidate.angle - this.snapLockedAngle));
        if (score > bestScore || (score === bestScore && dist < bestDist)) {
          best = candidate;
          bestScore = score;
          bestDist = dist;
        }
      }
      if (best && bestScore > 0) {
        const rawDist = Math.abs(Phaser.Math.Angle.Wrap(rawAngle - best.angle));
        if (rawDist <= SLASH_SNAP_RELEASE_HALF_WIDTH) {
          this.snapLockedChain = best.enemies;
          this.snapLockedAngle = best.angle;
          return best.angle;
        }
      }
    }

    // No lock survived (or there wasn't one) - engage fresh on whichever
    // candidate is closest to raw aim, same tight window used to newly
    // enter a lock in the first place.
    let closest: { angle: number; count: number; enemies: Enemy[] } | null = null;
    let closestDist = Infinity;
    for (const candidate of candidates) {
      const dist = Math.abs(Phaser.Math.Angle.Wrap(candidate.angle - rawAngle));
      if (dist <= SLASH_SNAP_SEARCH_HALF_WIDTH && dist < closestDist) {
        closest = candidate;
        closestDist = dist;
      }
    }
    if (closest) {
      this.snapLockedChain = closest.enemies;
      this.snapLockedAngle = closest.angle;
      this.snapLockedProjectile = projectile;
      return closest.angle;
    }

    this.snapLockedChain = null;
    this.snapLockedAngle = null;
    this.snapLockedProjectile = null;
    return rawAngle;
  }

  /** Length of the shared leading run between two enemy chains - see TimePlayer's identical helper (kept separate since the two live on opposite sides of the AimAssist boundary and there's nothing to share it through). */
  private chainMatchScore(a: Enemy[], b: Enemy[]): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) {
      i++;
    }
    return i;
  }

  /** The projectile rawAngle would actually deflect right now (same eligibility as checkSlashHits/updateSlashPreview), preferring whichever one is most centered in the arc - the aim-snap search only makes sense relative to a specific projectile's position. */
  private findSnapTargetProjectile(playerX: number, playerY: number, rawAngle: number, rawHitbox: SlashHitbox): TimeProjectile | null {
    let best: TimeProjectile | null = null;
    let bestAngleDist = Infinity;
    for (const projectile of this.projectilePool) {
      if (!projectile.active) {
        continue;
      }
      if (projectile.deflected && !projectile.isReDeflectable) {
        continue;
      }
      if (!this.isWithinSlashArc(projectile.x, projectile.y, projectile.radius, rawHitbox)) {
        continue;
      }
      const angleToProjectile = Math.atan2(projectile.y - playerY, projectile.x - playerX);
      const angleDist = Math.abs(Phaser.Math.Angle.Wrap(angleToProjectile - rawAngle));
      if (angleDist < bestAngleDist) {
        bestAngleDist = angleDist;
        best = projectile;
      }
    }
    return best;
  }

  /**
   * Gamepad-stick aim-lock: unlike computeSnappedAimAngle's continuous
   * "always snap to whatever's closest" magnet (which read as shaky/twitchy
   * on an analog stick, constantly re-evaluating "closest" off a wobbling
   * raw angle every frame), this hands back a fixed target plus the full
   * list of distinct chain-capable angles around it - the caller
   * (TimePlayer) picks one and only moves between them on a discrete flick
   * gesture, never off the stick's continuous position. Aim stays
   * perfectly still between flicks no matter how much the raw stick jitters
   * within its own tilt.
   *
   * currentTarget lets the caller ask "is my existing lock still good"
   * (pass the same projectile back) as well as "what should I lock onto
   * right now" (pass null) with one call: if currentTarget is still
   * active/eligible, its candidates are freshly recomputed and returned as
   * long as it still has any; otherwise (or if currentTarget is null) a new
   * target is searched for near referenceAngle, same eligibility/closest-
   * to-angle rule as computeSnappedAimAngle's target search. Returns null
   * if there's nothing chainable to lock onto at all (caller should fall
   * back to free continuous aim).
   *
   * preferredChain (the caller's currently selected chain, if any) is
   * forwarded straight to findChainCandidateAngles so the candidate the
   * caller is already riding stays represented by whichever sample
   * continues it, rather than by whatever depth happens to be deepest this
   * particular frame - see that method's doc comment for why that matters.
   * preferredAngle (the caller's previously selected ANGLE, not the raw
   * aim) is the tie-break reference for that - deliberately separate from
   * referenceAngle (raw aim, only used to find a NEW target/candidate),
   * since while locked the stick's continuous position doesn't drive aim
   * at all, so raw aim is a poor stand-in for "where the selection actually
   * was."
   */
  findChainLock(
    playerX: number,
    playerY: number,
    currentTarget: TimeProjectile | null,
    referenceAngle: number,
    range: number,
    arcWidth: number,
    preferredChain: Enemy[] | null = null,
    preferredAngle = 0,
  ): { target: TimeProjectile; candidates: { angle: number; count: number; enemies: Enemy[] }[] } | null {
    let target = currentTarget;
    if (target && (!target.active || (target.deflected && !target.isReDeflectable))) {
      target = null;
    }
    if (!target) {
      const rawHitbox: SlashHitbox = { x: playerX, y: playerY, angle: referenceAngle, range, arcWidth, swingId: -1 };
      target = this.findSnapTargetProjectile(playerX, playerY, referenceAngle, rawHitbox);
    }
    if (!target) {
      return null;
    }

    const candidates = this.findChainCandidateAngles(
      playerX,
      playerY,
      target,
      range,
      arcWidth,
      target === currentTarget ? preferredChain : null,
      preferredAngle,
    );
    return candidates.length > 0 ? { target, candidates } : null;
  }

  /**
   * Every distinct "sweet spot" angle around target that chains a deflect
   * into at least SLASH_SNAP_MIN_TOTAL_HITS total enemies (the primary hit
   * plus SLASH_SNAP_MIN_ADDITIONAL_BOUNCES more), one entry per contiguous
   * band of qualifying angles (not one entry per fine-grained sample -
   * buildChainHops' underlying geometry is a step function, so a real
   * bounce opportunity is a whole plateau of angles, not a single point).
   * Sorted by angle so index order matches physical left-to-right/clockwise
   * order for cycling through.
   *
   * A single band isn't always one clean plateau at one bounce count
   * though - a target/player in motion can make a band's ACHIEVABLE depth
   * (3 hits here, 4 a little further along, back to 3, etc., especially
   * with two enemies close enough to ping-pong a deflect between them)
   * flicker between multiple depths frame to frame well before the band as
   * a whole stops qualifying at all. Always reporting whichever depth
   * happens to be deepest THIS frame would mean the reported angle keeps
   * jumping between wherever each depth's own (often quite different, and
   * often much narrower / harder to hold for a deeper chain) sweet spot
   * happens to sit. preferredChain (the currently locked chain, if any)
   * lets the caller ask "what's still the same course" instead: if any
   * sample in the band continues that chain at all (shares a nonzero
   * prefix), the deepest/most-central sample achieving the BEST match is
   * used as the band's representative rather than the band's raw peak -
   * falling back to the true peak only when nothing in the band continues
   * the previous chain (it's genuinely gone).
   *
   * Each candidate also carries the ordered list of enemies its
   * representative sample actually hits (see resolveChain) - since target
   * keeps moving, the exact angle for "the same conceptual candidate"
   * drifts continuously frame to frame, so callers should track a
   * selection by comparing this enemy list, not by re-matching on angle.
   *
   * preferredAngle (typically the previously locked angle) breaks ties
   * among several samples that equally-best continue preferredChain - a
   * chain that flickers can leave its own matching angles split into more
   * than one disjoint stretch within the same band (e.g. matches near the
   * start AND near the end, with a differently-scoring stretch in between),
   * and always taking the first one found (leftmost) rather than whichever
   * is actually closest to where the selection just was is its own source
   * of unnecessary repositioning.
   */
  private findChainCandidateAngles(
    playerX: number,
    playerY: number,
    target: TimeProjectile,
    range: number,
    arcWidth: number,
    preferredChain: Enemy[] | null = null,
    preferredAngle = 0,
  ): { angle: number; count: number; enemies: Enemy[] }[] {
    const angleToTarget = Math.atan2(target.y - playerY, target.x - playerX);
    const dist = Math.hypot(target.x - playerX, target.y - playerY);
    const angularRadius = dist > 0 ? Math.asin(Math.min(1, target.radius / dist)) : Math.PI;
    const halfSpan = arcWidth / 2 + angularRadius;

    const samples: { angle: number; enemies: Enemy[] }[] = [];
    for (let a = angleToTarget - halfSpan; a <= angleToTarget + halfSpan; a += SLASH_SNAP_SEARCH_STEP) {
      const hitbox: SlashHitbox = { x: playerX, y: playerY, angle: a, range, arcWidth, swingId: -1 };
      if (!this.isWithinSlashArc(target.x, target.y, target.radius, hitbox)) {
        continue;
      }
      samples.push({ angle: a, enemies: this.resolveChain(target, a) });
    }

    const candidates: { angle: number; count: number; enemies: Enemy[] }[] = [];
    let i = 0;
    while (i < samples.length) {
      if (samples[i].enemies.length < SLASH_SNAP_MIN_TOTAL_HITS) {
        i++;
        continue;
      }
      let j = i;
      while (j < samples.length && samples[j].enemies.length >= SLASH_SNAP_MIN_TOTAL_HITS) {
        j++;
      }

      let chosen = -1;
      if (preferredChain) {
        let bestScore = 0;
        let bestDist = Infinity;
        for (let k = i; k < j; k++) {
          const score = this.chainMatchScore(samples[k].enemies, preferredChain);
          if (score === 0) {
            continue;
          }
          const dist = Math.abs(Phaser.Math.Angle.Wrap(samples[k].angle - preferredAngle));
          if (score > bestScore || (score === bestScore && dist < bestDist)) {
            bestScore = score;
            bestDist = dist;
            chosen = k;
          }
        }
      }
      if (chosen === -1) {
        let peakCount = 0;
        for (let k = i; k < j; k++) {
          peakCount = Math.max(peakCount, samples[k].enemies.length);
        }
        let peakStart = -1;
        let peakEnd = -1;
        for (let k = i; k < j; k++) {
          if (samples[k].enemies.length === peakCount) {
            if (peakStart === -1) {
              peakStart = k;
            }
            peakEnd = k;
          }
        }
        chosen = Math.round((peakStart + peakEnd) / 2);
      }

      const s = samples[chosen];
      candidates.push({ angle: s.angle, count: s.enemies.length, enemies: s.enemies });
      i = j;
    }
    return candidates;
  }

  /** Every enemy a deflect off projectile at the given angle would hit, in order: whatever the (short, cosmetic) primary line reaches directly, followed by however far the chain-hop lookahead extends beyond that. Mirrors drawPreviewHighlight's own math exactly, so nothing here can "find" a bounce the preview/real deflect wouldn't also show. The ordered identity of this list (particularly its first entry - the primary target) is what findChainCandidateAngles uses to recognize "the same candidate" across frames even as the moving projectile shifts exactly which angle achieves it - see AimAssist.findChainLock. */
  private resolveChain(projectile: TimeProjectile, angle: number): Enemy[] {
    const lineLength = this.previewLineLength(projectile);
    const { hitEnemies, lastBounce } = this.buildPreviewPath(projectile.x, projectile.y, angle, projectile.radius, lineLength);
    const enemies = [...hitEnemies];
    if (lastBounce && lastBounce.wasEnemy) {
      for (const hop of this.buildChainHops(lastBounce.x, lastBounce.y, lastBounce.dirX, lastBounce.dirY, projectile.radius, lastBounce.enemy)) {
        enemies.push(hop.enemy);
      }
    }
    return enemies;
  }

  private drawPreviewRing(x: number, y: number, radius: number, alpha: number): void {
    this.previewGraphic.lineStyle(2, SLASH_PREVIEW_COLOR, alpha);
    this.previewGraphic.strokeCircle(x, y, radius + SLASH_PREVIEW_RING_PADDING);
  }

  /** Trajectory-line length for a given projectile's post-deflect speed - see SLASH_PREVIEW_BASE_LINE_LENGTH. Shared by the drawn preview and the aim-snap chain search so both agree on exactly how far a deflect off this projectile would actually reach. */
  private previewLineLength(projectile: TimeProjectile): number {
    const speedRatio = projectile.deflectSpeed / BASE_DEFLECT_SPEED;
    return Phaser.Math.Clamp(SLASH_PREVIEW_BASE_LINE_LENGTH * speedRatio, SLASH_PREVIEW_MIN_LINE_LENGTH, SLASH_PREVIEW_MAX_LINE_LENGTH);
  }

  private drawPreviewHighlight(projectile: TimeProjectile, trajectoryAngle: number, alpha: number): void {
    this.drawPreviewRing(projectile.x, projectile.y, projectile.radius, alpha);

    // Scale the line length by how much faster/slower this particular
    // projectile's post-deflect speed is than the baseline - so a zoomer
    // (2x speed, 2x deflectSpeed) telegraphs with a visibly longer line.
    const lineLength = this.previewLineLength(projectile);

    const { path, hitEnemies, lastBounce } = this.buildPreviewPath(
      projectile.x,
      projectile.y,
      trajectoryAngle,
      projectile.radius,
      lineLength,
    );
    this.drawDashedPath(path);
    // Any enemy the drawn line itself actually reaches gets the same ring
    // the primary target does - "this too is on the path and would get
    // hit", not just the very first thing in slash range right now.
    for (const enemy of hitEnemies) {
      this.drawPreviewRing(enemy.x, enemy.y, Enemy.RADIUS, alpha);
    }
    // Further enemies down the chain that the (deliberately short) line
    // doesn't reach still get the same ring-plus-in/out-stub treatment as
    // the enemies the primary line hits directly, just as small floating
    // segments instead of one continuous line stretched across whatever
    // empty space separates them - and it keeps going hop to hop for as
    // long as each next thing along the way is another enemy rather than a
    // wall (see buildChainHops).
    if (lastBounce && lastBounce.wasEnemy) {
      const hops = this.buildChainHops(lastBounce.x, lastBounce.y, lastBounce.dirX, lastBounce.dirY, projectile.radius, lastBounce.enemy);
      for (const hop of hops) {
        this.drawPreviewRing(hop.enemy.x, hop.enemy.y, Enemy.RADIUS, alpha);
        this.drawDashedPath([
          { x: hop.point.x - hop.dirIn.x * SLASH_PREVIEW_CHAIN_STUB_LENGTH, y: hop.point.y - hop.dirIn.y * SLASH_PREVIEW_CHAIN_STUB_LENGTH },
          hop.point,
        ]);
        this.drawDashedPath([
          hop.point,
          { x: hop.point.x + hop.dirOut.x * SLASH_PREVIEW_CHAIN_STUB_LENGTH, y: hop.point.y + hop.dirOut.y * SLASH_PREVIEW_CHAIN_STUB_LENGTH },
        ]);
      }
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
   * Also collects every enemy the drawn path itself bounces off (hitEnemies)
   * - the caller rings each of those too, not just the very first thing in
   * slash range right now. This stays deliberately short/cosmetic though
   * (see SLASH_PREVIEW_BOUNCE_BONUS) - it's a guide line, not a full replay
   * of the shot's entire life. Also returns lastBounce - where the drawn
   * path's final bounce happened (if any) and whether it was off an enemy -
   * so the caller can pick up the chain from exactly there via
   * buildChainHops, without duplicating anything this short line already
   * drew. Deliberately doesn't do any of this for hostile projectiles: they
   * don't redirect the path (no bounce happens there, it just destroys them
   * and keeps flying straight), and unlike a stationary enemy they're
   * actively moving, so a "will this still be here when the real shot
   * arrives" prediction would be far less reliable - not worth the
   * complexity for markers that could easily lie.
   */
  private buildPreviewPath(
    startX: number,
    startY: number,
    angle: number,
    radius: number,
    lineLength: number,
  ): {
    path: { x: number; y: number }[];
    hitEnemies: Enemy[];
    lastBounce: { x: number; y: number; dirX: number; dirY: number; wasEnemy: boolean; enemy: Enemy | null } | null;
  } {
    const points: { x: number; y: number }[] = [{ x: startX, y: startY }];
    const hitEnemies: Enemy[] = [];
    let x = startX;
    let y = startY;
    let dirX = Math.cos(angle);
    let dirY = Math.sin(angle);
    let remaining = lineLength;
    let bounces = 0;
    let wallBounceBudget = DEFLECT_MAX_WALL_BOUNCES;
    let lastBounce: { x: number; y: number; dirX: number; dirY: number; wasEnemy: boolean; enemy: Enemy | null } | null = null;
    // The enemy just bounced off, excluded from the very next detection step
    // only - right after a reflection, a grazing hit can leave the march
    // still just barely inside that same enemy's radius, which would
    // otherwise register as an immediate second "bounce" off the body it
    // just left instead of continuing on. Cleared the moment anything else
    // (a wall, or a different enemy) is hit.
    let justBouncedEnemy: Enemy | null = null;

    while (remaining > 0 && bounces <= SLASH_PREVIEW_MAX_BOUNCES) {
      const step = Math.min(SLASH_PREVIEW_MARCH_STEP, remaining);
      const nextX = x + dirX * step;
      const nextY = y + dirY * step;

      const blockingEnemy = this.findEnemyBlockingPoint(nextX, nextY, radius, justBouncedEnemy);
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

        lastBounce = { x, y, dirX, dirY, wasEnemy: true, enemy: blockingEnemy };
        justBouncedEnemy = blockingEnemy;

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
      justBouncedEnemy = null;
      if (wallBounceBudget <= 0) {
        // The real projectile despawns right here - the trace ends at this
        // bounce point instead of drawing a trajectory it wouldn't survive.
        lastBounce = { x, y, dirX, dirY, wasEnemy: false, enemy: null };
        break;
      }

      const n = this.arena.normalAtAngle(angleAtPoint);
      const dot = dirX * n.x + dirY * n.y;
      dirX -= 2 * dot * n.x;
      dirY -= 2 * dot * n.y;

      lastBounce = { x, y, dirX, dirY, wasEnemy: false, enemy: null };

      remaining -= step;
      remaining += SLASH_PREVIEW_BOUNCE_BONUS;
      bounces++;
    }

    points.push({ x, y });
    return { path: points, hitEnemies, lastBounce };
  }

  /**
   * Continues the chain beyond wherever the (deliberately short) primary
   * line left off, hopping from enemy to enemy for as long as the very next
   * thing directly down the ray is another enemy rather than a wall - a
   * wall in the way ends the chain right there, matching "don't chain past
   * a wall bounce". Each hop is a straight-line lookahead (no bounce-off-
   * enemy math needed until an enemy is actually found), then reflects off
   * that enemy's round body the same way the real projectile/primary line
   * does, and looks ahead again from there for the next one - so a whole
   * row of enemies can chain, not just one extra hop.
   */
  private buildChainHops(
    startX: number,
    startY: number,
    dirX: number,
    dirY: number,
    radius: number,
    excludeEnemy: Enemy | null,
  ): { enemy: Enemy; point: { x: number; y: number }; dirIn: { x: number; y: number }; dirOut: { x: number; y: number } }[] {
    const hops: { enemy: Enemy; point: { x: number; y: number }; dirIn: { x: number; y: number }; dirOut: { x: number; y: number } }[] = [];
    let x = startX;
    let y = startY;
    let curDirX = dirX;
    let curDirY = dirY;
    let curExclude = excludeEnemy;

    for (let hop = 0; hop < SLASH_PREVIEW_MAX_CHAIN_HOPS; hop++) {
      const next = this.findNextChainedEnemy(x, y, curDirX, curDirY, radius, curExclude);
      if (!next) {
        break;
      }

      const dx = next.point.x - next.enemy.x;
      const dy = next.point.y - next.enemy.y;
      const distFromEnemy = Math.hypot(dx, dy);
      const nx = dx / distFromEnemy;
      const ny = dy / distFromEnemy;
      const dot = curDirX * nx + curDirY * ny;
      const dirOutX = curDirX - 2 * dot * nx;
      const dirOutY = curDirY - 2 * dot * ny;

      hops.push({
        enemy: next.enemy,
        point: next.point,
        dirIn: { x: curDirX, y: curDirY },
        dirOut: { x: dirOutX, y: dirOutY },
      });

      x = next.point.x;
      y = next.point.y;
      curDirX = dirOutX;
      curDirY = dirOutY;
      curExclude = next.enemy;
    }

    return hops;
  }

  /**
   * Straight-line lookahead: is there another enemy directly down this ray
   * before it would exit the arena? No length cap of its own, since it's
   * not "how far does a visible line reach", just "does the next thing this
   * trajectory would hit happen to be an enemy rather than a wall".
   */
  private findNextChainedEnemy(
    startX: number,
    startY: number,
    dirX: number,
    dirY: number,
    radius: number,
    excludeEnemy: Enemy | null,
  ): { enemy: Enemy; point: { x: number; y: number } } | null {
    let x = startX;
    let y = startY;
    // The arena is finite and convex, so this always terminates well before
    // this many steps - generous purely as a safety bound.
    const maxSteps = Math.ceil((this.arena.bounds.radius * 4) / SLASH_PREVIEW_MARCH_STEP);
    const minDist = Enemy.RADIUS + radius;
    for (let i = 0; i < maxSteps; i++) {
      const nextX = x + dirX * SLASH_PREVIEW_MARCH_STEP;
      const nextY = y + dirY * SLASH_PREVIEW_MARCH_STEP;

      const dx = nextX - this.arena.bounds.centerX;
      const dy = nextY - this.arena.bounds.centerY;
      const angleAtPoint = Math.atan2(dy, dx);
      const maxDist = this.arena.maxRadiusAtAngle(angleAtPoint) - radius;
      if (Math.hypot(dx, dy) > maxDist) {
        return null;
      }

      // Only exclude on the very first step - a step or two past that, the
      // ray has genuinely left the excluded enemy's radius (the distance
      // check above would fail on its own), so it's safe to consider it
      // hittable again from here on, same as any other enemy.
      const enemy = this.findEnemyBlockingPoint(nextX, nextY, radius, i === 0 ? excludeEnemy : null);
      if (enemy) {
        const edx = nextX - enemy.x;
        const edy = nextY - enemy.y;
        const scale = minDist / Math.hypot(edx, edy);
        return { enemy, point: { x: enemy.x + edx * scale, y: enemy.y + edy * scale } };
      }

      x = nextX;
      y = nextY;
    }
    return null;
  }

  /** The first alive enemy (other than excludeEnemy) whose round body would block a point on the preview's march, or null if none does. excludeEnemy exists so a step taken right after bouncing off an enemy doesn't immediately re-detect that same body on a grazing hit - see buildPreviewPath's justBouncedEnemy. */
  private findEnemyBlockingPoint(x: number, y: number, radius: number, excludeEnemy: Enemy | null = null): Enemy | null {
    const minDist = Enemy.RADIUS + radius;
    for (const enemy of this.enemyPool) {
      if (!enemy.isAlive || enemy === excludeEnemy) {
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

  /** Activates one free enemy at a random point in the arena, rejection-sampled to stay at least ENEMY_MIN_SPAWN_DIST_FROM_PLAYER from the player and ENEMY_MIN_SPAWN_DIST_FROM_OTHER_ENEMIES from every other alive enemy. No-op if the pool is full or no valid spot is found within MAX_SPAWN_ATTEMPTS. */
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
      if (distFromPlayer < ENEMY_MIN_SPAWN_DIST_FROM_PLAYER) {
        continue;
      }
      if (this.isTooCloseToOtherEnemy(x, y)) {
        continue;
      }
      enemy.activate(x, y);
      return;
    }
  }

  private isTooCloseToOtherEnemy(x: number, y: number): boolean {
    for (const other of this.enemyPool) {
      if (!other.isAlive) {
        continue;
      }
      const dx = other.x - x;
      const dy = other.y - y;
      if (dx * dx + dy * dy < ENEMY_MIN_SPAWN_DIST_FROM_OTHER_ENEMIES * ENEMY_MIN_SPAWN_DIST_FROM_OTHER_ENEMIES) {
        return true;
      }
    }
    return false;
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
