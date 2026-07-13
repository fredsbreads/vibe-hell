import Phaser from "phaser";
import { Arena } from "../arena/Arena";

const ESCAPE_MARGIN = 80;

/**
 * A deflected projectile survives exactly one wall bounce, then despawns on
 * the next one - but landing on an enemy (bounceOffPoint) refreshes that
 * budget back to full. So a deflected shot can chain through enemies
 * indefinitely, but the moment it goes two wall bounces in a row without an
 * enemy kill in between, it's gone after that second one. (Set to 2, not 1:
 * the count increments ON a bounce and the despawn check reads
 * count >= this value right after, so "survive 1, die on the 2nd" needs the
 * threshold one higher than the number of bounces actually survived.)
 * Exported so the slash-deflect preview can trace the exact same rule
 * instead of guessing when the real projectile would actually die.
 */
export const DEFLECT_MAX_WALL_BOUNCES = 2;
/**
 * Minimum real (undilated) ms that must pass between two wall bounces for
 * the second one to actually consume DEFLECT_MAX_WALL_BOUNCES' budget - a
 * bounce landing near a corner (or a shallow-angle carom off two nearby
 * wall segments) can otherwise hit a second wall almost instantly, killing
 * the projectile before the player had any real window to react and
 * re-deflect it between the two. A bounce that lands too soon after the
 * previous one still reflects normally (it's not ignored physically), it
 * just doesn't count against the budget - see bounceOffWall().
 */
const MIN_MS_BETWEEN_WALL_BOUNCES = 150;
/** Not yet re-deflectable (locked) is dark blue; becoming re-deflectable (see isReDeflectable) switches to teal (matches the player's own color) - "you can act on this now." Blue rather than the menu convention's yellow for the ready state would collide with the straight kind's hostile color (0xf2e85c) - a friendly re-deflectable shot getting mistaken for an incoming hostile one at a glance defeats the point. Originally distinguished by kind too, but that's deliberately dropped - only the re-deflectable state matters. */
const DEFLECT_LOCKED_TINT = 0x4d9fff;
const DEFLECT_REDEFLECTABLE_TINT = 0x59f2c8;
/** Deflected projectiles fly faster than the hostile speed they arrived at, on top of the real-time burst - reads as more dangerous/decisive, and outruns the enemy that fired it in the first place. */
const DEFLECT_SPEED_MULTIPLIER = 1.6;

/**
 * How long, in real (undilated) ms, a just-deflected projectile keeps moving
 * at full un-scaled speed before dropping into being world-time-scaled like
 * everything else. Without this, redirecting a bullet while the world is
 * nearly frozen would make it look like it barely moved at all - the burst
 * sells "that connected" regardless of the current timescale.
 */
const DEFLECT_BURST_MS = 300;

/**
 * How many total deflects (the initial deflect plus every re-deflect) the
 * post-deflect burst's speed keeps scaling up with, before it stops - a
 * redeflected-many-times projectile keeps getting objectively faster for
 * its STEADY (world-scaled, post-burst) travel forever, but the brief
 * full-speed burst distance right after each deflect would otherwise keep
 * stretching out further and further too (same fixed DEFLECT_BURST_MS,
 * ever-higher compounding speed = ever-more distance covered in that
 * window). Past this many deflects, the burst's effective speed is capped
 * at whatever it was on the DEFLECT_BURST_SPEED_CAP_DEFLECTS-th deflect -
 * see step()'s burstSpeedScale.
 */
const DEFLECT_BURST_SPEED_CAP_DEFLECTS = 3;

/**
 * Length (px) of the directional tail drawn behind the projectile, pointing
 * back the way it came. Drawn as several progressively shorter/fainter
 * segments to fake a taper, since Graphics strokes don't support a real
 * gradient. Deliberately long/opaque - this needs to read clearly even when
 * the world (and so the projectile itself) is moving at a near-frozen
 * timescale, where a plain fading-afterimage trail was too subtle to notice.
 *
 * Each segment is drawn using the heading the projectile actually had that
 * far back along its path (see headingHistory), not just its current
 * velocity - so a curving chaser (or a ricochet that just re-aimed off a
 * bounce) shows a visibly bent tail instead of a straight line extrapolated
 * from its current direction. Sampled by distance traveled rather than by
 * frame, so the tail always represents the same ~tailLength of actual path
 * regardless of framerate or how dilated the world currently is.
 *
 * That same "a fixed SPATIAL length, not a rate of visible motion" trick is
 * also how speed gets telegraphed: tailLength itself scales with the
 * projectile's CURRENT speed (see updateTailLength), so a fast one shows a
 * visibly longer streak than a slow one no matter how little either has
 * actually moved on screen this frame - direction already worked this way
 * (a near-frozen projectile still shows a full tail), this just extends the
 * same idea to magnitude.
 */
const TAIL_BASE_LENGTH = 46;
const TAIL_MIN_LENGTH = 20;
const TAIL_MAX_LENGTH = 140;
const TAIL_SEGMENTS = 8;
const TAIL_MAX_ALPHA = 0.85;

/**
 * How a hostile projectile moves after firing, picked per-shot by the enemy
 * (see TimeManager.fireProjectile) - equal odds across all four for now.
 * - straight: the original behavior, flies dead straight, mirror-bounces off walls.
 * - zoomer: same as straight, just faster.
 * - chaser: continuously curves toward the player's CURRENT position at a
 *   capped turn rate (see CHASER_TURN_RATE) - still juke-able, since it can't
 *   snap instantly onto you.
 * - ricochet: flies straight like a normal shot, but re-aims dead-on at the
 *   player at the moment of each wall bounce, instead of mirror-reflecting.
 * All of this stops the instant a projectile is deflected - see deflect().
 */
export type ProjectileKind = "straight" | "zoomer" | "chaser" | "ricochet";

const BASE_SPEED = 200;
/** How fast (rad/s, world-time-scaled) a chaser can turn its velocity toward the player. Capped rather than instant so it stays dodgeable. Exported so decorative reuses (e.g. the title screen background) can match the real in-game turn feel. */
export const CHASER_TURN_RATE = 2.5;

/** The deflect speed of a "normal" (non-zoomer) projectile - exported as the reference point the slash preview scales its trajectory-line length against, so a faster post-deflect speed (e.g. a zoomer) reads as a visibly longer line. */
export const BASE_DEFLECT_SPEED = BASE_SPEED * DEFLECT_SPEED_MULTIPLIER;

/** Speed and color per kind - color doubles as the tail's color, so each kind reads as visually distinct at a glance. Exported as the single source of truth for anything else that wants to reuse the same look (e.g. the title screen background). */
export const KIND_CONFIG: Record<ProjectileKind, { speed: number; color: number }> = {
  straight: { speed: BASE_SPEED, color: 0xf2e85c },
  zoomer: { speed: BASE_SPEED * 2, color: 0xff3b3b },
  chaser: { speed: BASE_SPEED, color: 0xc86bff },
  ricochet: { speed: BASE_SPEED, color: 0xffc8de },
};

/**
 * A pooled bullet for the time-dilation mode. Aims at the player once at
 * spawn (an enemy applies its own aim imperfection before calling activate),
 * then moves according to its kind (see ProjectileKind) and mirror-bounces
 * off the arena wall (unless it's a ricochet re-aiming instead). Movement is
 * driven by the caller passing in an already-world-scaled delta each frame
 * (see step()) - this class doesn't know about WorldClock itself, it just
 * moves by whatever delta it's handed, which is what makes the deflect burst
 * work: the burst window uses the real delta, everything else uses the
 * world-scaled one.
 */
export class TimeProjectile extends Phaser.GameObjects.Image {
  readonly radius: number;
  private speed = BASE_SPEED;
  /** speed's value at activate(), before any deflect's compounding - the reference point burstSpeedScale caps against (see step()). Never mutated after activate(). */
  private baseSpeedForKind = BASE_SPEED;
  private baseColor = KIND_CONFIG.straight.color;
  private kind: ProjectileKind = "straight";
  private readonly tailGraphic: Phaser.GameObjects.Graphics;

  private vx = 0;
  private vy = 0;
  private isDeflected = false;
  private wallBounceCount = 0;
  /** Real ms elapsed since the last wall bounce (or since deflect()/bounceOffPoint(), whichever's more recent) - see MIN_MS_BETWEEN_WALL_BOUNCES. */
  private msSinceLastWallBounce = 0;
  private deflectBurstRemainingMs = 0;
  /** Whether this projectile has bounced off an enemy since its last deflect - see the isReDeflectable doc comment. */
  private bouncedOffEnemySinceDeflect = false;
  /** Which swing (see SlashHitbox.swingId) last deflected this projectile - see wasHitBySwing(). */
  private lastHitSwingId = -1;
  /**
   * How many enemies this projectile has bounced off (killed) since it was
   * first deflected - persists across re-deflects (a re-aim doesn't reset the
   * chain, it's still the same flight), reset only in activate(), i.e. when
   * this pooled instance becomes a brand new hostile shot. Drives the
   * player's bonus dash charges - see TimeManager.liveMaxChainCount and
   * TimePlayer.setMaxDashCharges.
   */
  private chainHitCount = 0;
  /** How many times deflect() has been called on this projectile (initial deflect + every re-deflect) - drives the burst speed cap, see DEFLECT_BURST_SPEED_CAP_DEFLECTS. Reset only in activate(). */
  private deflectCount = 0;

  /** Recent velocity headings (radians), oldest first, sampled every tailSegmentLength of travel - see the TAIL_BASE_LENGTH doc comment above. */
  private readonly headingHistory: number[] = [];
  private distanceSinceLastSample = 0;
  /** tailLength / TAIL_SEGMENTS for the CURRENT speed - recomputed each step(), see updateTailLength(). */
  private tailSegmentLength = TAIL_BASE_LENGTH / TAIL_SEGMENTS;

  constructor(scene: Phaser.Scene, textureKey: string, radius: number) {
    super(scene, 0, 0, textureKey);
    this.radius = radius;
    this.tailGraphic = scene.add.graphics();
    scene.add.existing(this);
    this.setActive(false);
    this.setVisible(false);
  }

  activate(x: number, y: number, aimAngle: number, kind: ProjectileKind = "straight"): void {
    const config = KIND_CONFIG[kind];
    this.kind = kind;
    this.speed = config.speed;
    this.baseSpeedForKind = config.speed;
    this.baseColor = config.color;
    this.setPosition(x, y);
    this.vx = Math.cos(aimAngle) * this.speed;
    this.vy = Math.sin(aimAngle) * this.speed;
    this.isDeflected = false;
    this.wallBounceCount = 0;
    this.msSinceLastWallBounce = Infinity;
    this.deflectBurstRemainingMs = 0;
    this.bouncedOffEnemySinceDeflect = false;
    this.lastHitSwingId = -1;
    this.chainHitCount = 0;
    this.deflectCount = 0;
    this.headingHistory.length = 0;
    this.headingHistory.push(aimAngle);
    this.distanceSinceLastSample = 0;
    this.updateTailLength();
    this.setTintFill(this.baseColor);
    this.setAlpha(1);
    this.setActive(true);
    this.setVisible(true);
    this.tailGraphic.setVisible(true);
  }

  /** Recomputes tailSegmentLength from the CURRENT speed - see the TAIL_BASE_LENGTH doc comment for why tail length itself is the speed cue. Clamped so a near-stationary or absurdly-fast (a few-times-redeflected zoomer) projectile still gets a reasonable, legible tail. */
  private updateTailLength(): void {
    const tailLength = Phaser.Math.Clamp((TAIL_BASE_LENGTH * this.speed) / BASE_SPEED, TAIL_MIN_LENGTH, TAIL_MAX_LENGTH);
    this.tailSegmentLength = tailLength / TAIL_SEGMENTS;
  }

  deactivate(): void {
    this.setActive(false);
    this.setVisible(false);
    this.tailGraphic.setVisible(false);
  }

  get deflected(): boolean {
    return this.isDeflected;
  }

  /**
   * True once an already-deflected projectile can be hit by Slash again -
   * only once it's bounced off an enemy since its last deflect, not the
   * instant it's redirected. Lets a friendly shot be "picked up" and re-aimed
   * after it's caromed through a target, instead of being permanently immune
   * to Slash the moment it first turns friendly.
   */
  get isReDeflectable(): boolean {
    return this.isDeflected && this.bouncedOffEnemySinceDeflect;
  }

  /** True if a swing with this exact swingId already deflected this projectile - a swing's hitbox stays active across several frames, and the projectile could become isReDeflectable again (bounce off an enemy) mid-swing, so this stops that same physical swing from hitting it twice. See SlashHitbox.swingId. */
  wasHitBySwing(swingId: number): boolean {
    return this.lastHitSwingId === swingId;
  }

  /** How many enemies this projectile has bounced off (killed) since it was first deflected - see chainHitCount's doc comment. */
  get chainKillCount(): number {
    return this.chainHitCount;
  }

  /** The speed this projectile would fly off at if deflected right now - exposed for the "would this get deflected" QoL preview, so it can telegraph a faster post-deflect speed (e.g. a zoomer) with a longer trajectory line, and so a chain of redeflects reads as compounding rather than resetting. */
  get deflectSpeed(): number {
    return this.speed * DEFLECT_SPEED_MULTIPLIER;
  }

  /** The tint the sprite/tail should currently show - hostile is its own kind color, deflected-but-not-yet-redeflectable (locked) is dark blue, redeflectable is teal. Single source of truth so the sprite tint and the tail color can never disagree. */
  private get currentTintColor(): number {
    if (!this.isDeflected) {
      return this.baseColor;
    }
    return this.isReDeflectable ? DEFLECT_REDEFLECTABLE_TINT : DEFLECT_LOCKED_TINT;
  }

  /**
   * Redirects along the player's aim angle - friendly from here on, with a
   * brief real-time burst before it starts being world-time-scaled. Also
   * ends any chasing/ricochet behavior immediately (see
   * step()/bounceOffWall()), regardless of its original kind. Resets
   * isReDeflectable back to false - it has to bounce off another enemy
   * before it can be re-deflected again. Speed COMPOUNDS: each redeflect
   * multiplies the CURRENT speed by DEFLECT_SPEED_MULTIPLIER again, not the
   * original kind speed, so a projectile that's been redirected multiple
   * times keeps getting faster.
   */
  deflect(aimAngle: number, swingId: number): void {
    this.isDeflected = true;
    this.wallBounceCount = 0;
    // Infinity, not 0: the FIRST wall bounce after a (re-)deflect should
    // always count normally (matching the original "survive 1, die on the
    // 2nd" rule) - the minimum-gap protection only matters for a bounce
    // that follows ANOTHER bounce too quickly, not the first one after a
    // fresh deflect.
    this.msSinceLastWallBounce = Infinity;
    this.bouncedOffEnemySinceDeflect = false;
    this.lastHitSwingId = swingId;
    this.deflectBurstRemainingMs = DEFLECT_BURST_MS;
    this.deflectCount++;
    this.speed *= DEFLECT_SPEED_MULTIPLIER;
    this.vx = Math.cos(aimAngle) * this.speed;
    this.vy = Math.sin(aimAngle) * this.speed;
    this.updateTailLength();
    this.setTintFill(this.currentTintColor);
  }

  /**
   * Mirror-reflects velocity off a round obstacle (an enemy's body) centered
   * at (centerX, centerY), same math as bounceOffWall() but using the normal
   * from that center straight through this projectile's current position
   * instead of the arena's edge normal - the reflection angle depends on
   * exactly where on the circle it hit, same as any round-body bounce would.
   * Refreshes the wall-bounce budget back to full instead of consuming it -
   * enemy bounces themselves are unlimited, and landing one buys another
   * wall bounce. Also marks the projectile as re-deflectable (see
   * isReDeflectable) - the caller (TimeManager) is responsible for actually
   * killing the enemy this bounced off of; this only handles the
   * projectile's own redirect.
   */
  bounceOffPoint(centerX: number, centerY: number): void {
    const dx = this.x - centerX;
    const dy = this.y - centerY;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) {
      return;
    }
    const nx = dx / dist;
    const ny = dy / dist;
    const dot = this.vx * nx + this.vy * ny;
    this.vx -= 2 * dot * nx;
    this.vy -= 2 * dot * ny;

    if (this.isDeflected) {
      this.wallBounceCount = 0;
      // Same reasoning as deflect() - refreshing the budget should also
      // refresh "the next wall bounce always counts", not start it off
      // artificially protected.
      this.msSinceLastWallBounce = Infinity;
      this.bouncedOffEnemySinceDeflect = true;
      this.chainHitCount++;
      this.setTintFill(this.currentTintColor);
    }
  }

  /**
   * Advances the projectile - turning toward the player first if it's a
   * still-hostile chaser - and bounces it off the wall. worldScaledDelta is
   * whatever the caller has already multiplied by the current world
   * timescale - this class just moves by it, except during the brief
   * post-deflect burst window, where it moves by the real (unscaled) delta
   * instead so the redirect always reads as an immediate, decisive hit.
   * Returns true once it should be despawned.
   */
  step(realDelta: number, worldScaledDelta: number, arena: Arena, playerX: number, playerY: number): boolean {
    let effectiveDelta = worldScaledDelta;
    // Caps the burst's effective speed (and so the distance it covers over
    // its fixed DEFLECT_BURST_MS window) at whatever it was on the
    // DEFLECT_BURST_SPEED_CAP_DEFLECTS-th deflect - a projectile redeflected
    // beyond that keeps getting objectively faster for its steady travel
    // (this.speed itself is never capped), only the burst's own distance
    // stops growing further. 1 (no scaling) whenever not currently bursting.
    let burstSpeedScale = 1;
    if (this.deflectBurstRemainingMs > 0) {
      effectiveDelta = realDelta;
      this.deflectBurstRemainingMs = Math.max(0, this.deflectBurstRemainingMs - realDelta);
      const cappedDeflects = Math.min(this.deflectCount, DEFLECT_BURST_SPEED_CAP_DEFLECTS);
      const burstSpeedCap = this.baseSpeedForKind * Math.pow(DEFLECT_SPEED_MULTIPLIER, cappedDeflects);
      burstSpeedScale = this.speed > 0 ? Math.min(1, burstSpeedCap / this.speed) : 1;
    }

    this.msSinceLastWallBounce += effectiveDelta;

    const dt = effectiveDelta / 1000;

    if (this.kind === "chaser" && !this.isDeflected) {
      this.turnTowardPlayer(playerX, playerY, dt);
    }

    const moveDist = Math.hypot(this.vx, this.vy) * burstSpeedScale * dt;
    this.x += this.vx * burstSpeedScale * dt;
    this.y += this.vy * burstSpeedScale * dt;

    this.bounceOffWall(arena, playerX, playerY);
    this.sampleHeading(moveDist);
    this.redrawTail();

    if (this.isDeflected && this.wallBounceCount >= DEFLECT_MAX_WALL_BOUNCES) {
      return true;
    }

    return this.hasEscaped(arena);
  }

  /** Rotates the velocity vector toward the player's current position by up to CHASER_TURN_RATE*dt radians, preserving current speed. */
  private turnTowardPlayer(playerX: number, playerY: number, dt: number): void {
    const speed = Math.hypot(this.vx, this.vy);
    if (speed === 0) {
      return;
    }
    const currentAngle = Math.atan2(this.vy, this.vx);
    const targetAngle = Math.atan2(playerY - this.y, playerX - this.x);
    const newAngle = Phaser.Math.Angle.RotateTo(currentAngle, targetAngle, CHASER_TURN_RATE * dt);
    this.vx = Math.cos(newAngle) * speed;
    this.vy = Math.sin(newAngle) * speed;
  }

  /** Records the current heading once enough path distance has accumulated since the last sample - see the TAIL_BASE_LENGTH doc comment. Can push more than one sample in a single call (e.g. a big deflect-burst jump). */
  private sampleHeading(moveDist: number): void {
    this.distanceSinceLastSample += moveDist;
    while (this.distanceSinceLastSample >= this.tailSegmentLength) {
      this.headingHistory.push(Math.atan2(this.vy, this.vx));
      if (this.headingHistory.length > TAIL_SEGMENTS) {
        this.headingHistory.shift();
      }
      this.distanceSinceLastSample -= this.tailSegmentLength;
    }
  }

  private hasEscaped(arena: Arena): boolean {
    const dx = this.x - arena.bounds.centerX;
    const dy = this.y - arena.bounds.centerY;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    return dist > arena.maxRadiusAtAngle(angle) + ESCAPE_MARGIN;
  }

  private bounceOffWall(arena: Arena, playerX: number, playerY: number): void {
    const dx = this.x - arena.bounds.centerX;
    const dy = this.y - arena.bounds.centerY;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);
    if (distFromCenter === 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = arena.maxRadiusAtAngle(angle) - this.radius;
    if (distFromCenter <= maxDist) {
      return;
    }

    const scale = maxDist / distFromCenter;
    this.x = arena.bounds.centerX + dx * scale;
    this.y = arena.bounds.centerY + dy * scale;

    if (this.kind === "ricochet" && !this.isDeflected) {
      // Re-aim dead-on at the player instead of mirror-reflecting - the wall bounce becomes a fresh shot rather than a predictable carom.
      const speed = Math.hypot(this.vx, this.vy);
      const aimAngle = Math.atan2(playerY - this.y, playerX - this.x);
      this.vx = Math.cos(aimAngle) * speed;
      this.vy = Math.sin(aimAngle) * speed;
    } else {
      const n = arena.normalAtAngle(angle);
      const dot = this.vx * n.x + this.vy * n.y;
      this.vx -= 2 * dot * n.x;
      this.vy -= 2 * dot * n.y;
    }

    if (this.isDeflected) {
      // Only counts against the budget if there was real time since the last
      // one - see MIN_MS_BETWEEN_WALL_BOUNCES. Reset either way: the NEXT
      // bounce should be judged against THIS one's timing, not an earlier one.
      if (this.msSinceLastWallBounce >= MIN_MS_BETWEEN_WALL_BOUNCES) {
        this.wallBounceCount++;
      }
      this.msSinceLastWallBounce = 0;
    }
  }

  /**
   * Draws a tapered line from the projectile back toward where it came from,
   * redrawn fresh every step. Walks backward one fixed-length segment at a
   * time, using progressively older recorded headings (see headingHistory)
   * for each segment rather than a single current-velocity direction for the
   * whole tail - so it visibly bends along a curving path (chaser, or a
   * ricochet just past a bounce) instead of always reading as a straight
   * line. A handful of progressively shorter/fainter segments fake a taper,
   * since Graphics strokes don't support a real gradient - reads far more
   * clearly as "this is moving in direction X" than a plain fading
   * afterimage trail did, which matters a lot when the projectile itself
   * might be crawling along at a near-frozen world timescale.
   */
  private redrawTail(): void {
    this.tailGraphic.clear();
    const speed = Math.hypot(this.vx, this.vy);
    if (speed === 0) {
      return;
    }
    const color = this.currentTintColor;

    let cursorX = this.x;
    let cursorY = this.y;
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      const historyIndex = Math.max(0, this.headingHistory.length - 1 - i);
      const angle = this.headingHistory[historyIndex];
      const nextX = cursorX - Math.cos(angle) * this.tailSegmentLength;
      const nextY = cursorY - Math.sin(angle) * this.tailSegmentLength;
      const alpha = TAIL_MAX_ALPHA * (1 - i / TAIL_SEGMENTS);
      const width = this.radius * (1 - i / TAIL_SEGMENTS) * 0.9;
      this.tailGraphic.lineStyle(Math.max(1, width), color, alpha);
      this.tailGraphic.lineBetween(cursorX, cursorY, nextX, nextY);
      cursorX = nextX;
      cursorY = nextY;
    }
  }
}
