import Phaser from "phaser";
import { PlayerInput, InputSource, InputState } from "../input/PlayerInput";
import { Arena } from "../arena/Arena";
import { computeWorldTimescale } from "./worldClock";
import { getShowSlashRangeIndicator } from "../config/settings";

const DASH_TINT = 0xaefff0;
const HURT_TINT = 0xff3b3b;

const MOVE_SPEED = 320;
const WALL_EPSILON = 0.5;

const DASH_SPEED = 900;
const DASH_DURATION_MS = 150;
const DASH_COOLDOWN_MS = 200;
const DASH_LOCKOUT_MS = DASH_DURATION_MS + DASH_COOLDOWN_MS;
const DASH_IFRAME_TAIL_MS = 150;

const SLASH_DURATION_MS = 120;
const SLASH_COOLDOWN_MS = 500;
const SLASH_RANGE = 60;
const SLASH_ARC_WIDTH = 0.9;
const SLASH_COLOR = 0xf2e85c;
/** How far (0-1) into the swing the flash-white tint finishes fading to SLASH_COLOR - just the first slice of the swing reads as a flash. */
const SLASH_FLASH_PORTION = 0.25;

/** A persistent, unobtrusive outline of the exact wedge Slash would hit right now - so "is this actually in range" is answerable by eye, not guesswork. Brighter/more visible when Slash is actually ready, faint while on cooldown. */
const SLASH_RANGE_READY_COLOR = 0x59f2c8;
const SLASH_RANGE_COOLDOWN_COLOR = 0x6a6a80;
const SLASH_RANGE_READY_ALPHA = 0.35;
const SLASH_RANGE_COOLDOWN_ALPHA = 0.12;

export interface SlashHitbox {
  x: number;
  y: number;
  angle: number;
  range: number;
  arcWidth: number;
  /**
   * Identifies which physical swing this hitbox belongs to - a swing's
   * hitbox stays active across several frames (SLASH_DURATION_MS), and a
   * projectile can become re-deflectable again (bounce off an enemy) WHILE
   * that same swing is still active, so TimeManager needs to tell "the same
   * swing, later frame" apart from "a genuinely new swing" to avoid hitting
   * the same projectile twice off one button press. -1 for the preview
   * hitbox, which never actually resolves a hit, so this doesn't matter.
   */
  swingId: number;
}

/**
 * A fork of the original game's Player, adapted for the time-dilation mode's
 * two different clocks (see WaveClock doc comment in worldClock.ts):
 *
 * - The player's own movement, aim, and the ACTIVE duration of Dash/Slash
 *   (the moment of acting itself) all run on the real, undilated delta -
 *   always fully responsive, equally skill-testing to time regardless of the
 *   current world timescale.
 * - Dash's lockout and Slash's cooldown (the "waiting to do it again" part)
 *   run on the world-scaled delta instead - standing still to wait out a
 *   cooldown for free doesn't work, because standing still is exactly what
 *   keeps world-time from advancing.
 *
 * 1 HP, no hit-grace window - unlike the original 3-HP game, there's no
 * "cluster of hits in one instant" to guard against, since the very first
 * hit already ends the run.
 */
export class TimePlayer {
  static readonly RADIUS = 16;

  readonly sprite: Phaser.Physics.Arcade.Sprite;

  aimAngle = -Math.PI / 2;

  private input: InputSource;
  private lastInputStateValue: InputState | null = null;
  private readonly aimIndicator: Phaser.GameObjects.Graphics;
  private readonly slashGraphic: Phaser.GameObjects.Graphics;
  private readonly slashRangeGraphic: Phaser.GameObjects.Graphics;

  /**
   * Current velocity, applied to sprite.x/y by hand each update() call
   * (see the end of update()) rather than via sprite.setVelocity() + Arcade
   * Physics' own automatic once-per-real-rendered-frame integration.
   * Deliberate: the death replay calls update() several times per real
   * frame (see TimeMainScene's REPLAY_STEPS_PER_FRAME) to fast-forward
   * playback, each with its own recorded delta - Arcade's auto-integration
   * only ever applies the LAST of those velocities across the REAL frame's
   * own delta, silently discarding the others and drifting the replay's
   * position off the original run's. Manual integration makes movement a
   * pure function of "how many times update() was called, with what
   * deltas" instead of real wall-clock frame timing, which is what actually
   * makes the replay reproduce the recorded run's movement exactly.
   */
  private velocityX = 0;
  private velocityY = 0;

  private isDashing = false;
  private dashTimeRemainingMs = 0;
  private dashLockoutRemainingMs = 0;
  private dashIframeTailRemainingMs = 0;
  /**
   * How many dashes are currently banked and spendable right now - normally
   * 1 (see maxDashChargesValue), but can rise above that off the back of a
   * deflected-projectile kill chain (see setMaxDashCharges). Spending one
   * (see startDash) never has its own individual cooldown while charges
   * remain above 0 - only once it bottoms out at 0 does dashLockoutRemainingMs
   * start ticking again, to regenerate back up to the baseline of 1 (see
   * tickCooldowns). This baseline regen is exactly the original single-dash
   * cooldown behavior; the chain mechanic only ever adds to it.
   */
  private dashCharges = 1;
  /** The current ceiling on dashCharges - always max(1, TimeManager.liveMaxChainCount), kept in sync every frame by the caller via setMaxDashCharges. */
  private maxDashChargesValue = 1;

  private slashAngle = 0;
  private slashActiveRemainingMs = 0;
  private slashCooldownRemainingMs = 0;
  private swingId = 0;

  private dead = false;
  private worldTimescaleValue = 1;
  /** True once the death replay takes over - suppresses the slash-range indicator (see redrawSlashRangeIndicator), since it exists to inform a live decision that isn't being made anymore. */
  private isReplaying = false;

  constructor(
    private readonly scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly arena: Arena,
    inputSource?: InputSource,
  ) {
    this.input = inputSource ?? new PlayerInput(scene);

    this.sprite = scene.physics.add.sprite(x, y, "time-player");
    this.sprite.setCircle(TimePlayer.RADIUS);
    this.sprite.setDepth(5);

    this.aimIndicator = scene.add.graphics();
    this.slashGraphic = scene.add.graphics();
    this.slashRangeGraphic = scene.add.graphics();
  }

  /** The world timescale computed from this frame's raw stick input - read this AFTER calling update(), and use it to step everything else ("the world") this same frame. */
  get worldTimescale(): number {
    return this.worldTimescaleValue;
  }

  /** Whatever InputState update() last read - null before the first update() call. Recorded frame-by-frame during live play to build a replayable run (see ReplayRecorder); not meaningful during replay itself, since that's driven by a RecordedInputSource reading its own already-recorded frames back. */
  get lastInputState(): InputState | null {
    return this.lastInputStateValue;
  }

  /**
   * Swaps the input source post-construction - used to switch from live
   * device input to a RecordedInputSource the moment a run ends, so the
   * death replay can drive the exact same player-update code with recorded
   * input instead of a second parallel implementation.
   */
  setInputSource(source: InputSource): void {
    this.input = source;
  }

  /** Marks this player as driven by the death replay from now on - hides the slash-range indicator, which exists to inform a live aiming decision that no longer applies once the run is over. */
  setReplaying(replaying: boolean): void {
    this.isReplaying = replaying;
  }

  /**
   * Re-syncs input edge-detection to whatever's currently held - call this
   * right after leaving a paused state (or right after constructing a fresh
   * TimePlayer on restart), so a button still held from confirming a menu
   * (Cross/Enter doubles as both "confirm" and Dash) doesn't fire that
   * in-game action the instant control returns to gameplay. No-op (and
   * harmless) when the current input source doesn't support it, e.g. a
   * RecordedInputSource during replay.
   */
  resyncInputState(): void {
    this.input.resyncHeldState?.(this.position.x, this.position.y);
  }

  update(realDelta: number): void {
    const state = this.input.read(this.position.x, this.position.y);
    this.lastInputStateValue = state;
    this.aimAngle = state.aimAngle;
    // Deliberately always DERIVED from this frame's moveX/moveY, live or
    // replayed alike - during a death replay this reproduces the exact same
    // worldScaledDelta sequence the original run had (a pure function of
    // already-recorded input), which is what makes the replay's enemy
    // spawns/projectile timing/RNG draws actually match what really
    // happened, instead of a different run that just started from the same
    // seed. See TimeMainScene's updateReplay for how the replay still plays
    // back faster than the original run without touching this.
    //
    // While dashing, though, the stick is treated as neutral regardless of
    // what it's actually doing - a dash already moves the player at a fixed
    // speed of its own (see startDash), ignoring the held direction, so
    // letting a held stick ALSO keep the world moving during the dash would
    // let players get dash's full i-frames/burst AND world-time progress at
    // the same time just by holding a direction through it. Standing still
    // (or dashing) should read as "the world waits for you" consistently,
    // not conditionally on whether a direction happens to still be held.
    const willDashThisFrame = this.isDashing || (state.dashPressed && this.canDash());
    this.worldTimescaleValue = willDashThisFrame ? computeWorldTimescale(0, 0) : computeWorldTimescale(state.moveX, state.moveY);
    const worldScaledDelta = realDelta * this.worldTimescaleValue;

    this.tickCooldowns(realDelta, worldScaledDelta);

    if (state.dashPressed && this.canDash()) {
      this.startDash(state.moveX, state.moveY);
    }
    if (state.slashPressed && this.canSlash()) {
      this.startSlash(state.aimAngle);
    }

    this.updateDash(realDelta);
    this.updateSlash(realDelta);

    if (!this.isDashing) {
      const move = new Phaser.Math.Vector2(state.moveX, state.moveY);
      // Speed scales with how far the stick is tilted (post-deadzone), not just
      // whether it's tilted at all - a light push should move you slower, full
      // tilt still hits MOVE_SPEED. Keyboard input is always -1/0/1 so this has
      // no effect there; it only matters for analog stick input.
      const tilt = Math.min(1, move.length());
      if (tilt > 0) {
        move.normalize().scale(MOVE_SPEED * tilt);
      }
      this.clipOutwardComponent(move);
      this.velocityX = move.x;
      this.velocityY = move.y;
    }
    // While dashing, velocityX/Y deliberately stay whatever startDash() set -
    // applied here every call just like the non-dashing case above, instead
    // of relying on Arcade to keep re-applying a velocity we set once.
    this.sprite.x += (this.velocityX * realDelta) / 1000;
    this.sprite.y += (this.velocityY * realDelta) / 1000;

    this.clampToArena();
    this.redrawAimIndicator();
    this.redrawSlashRangeIndicator();
  }

  private get position(): { x: number; y: number } {
    return { x: this.sprite.x, y: this.sprite.y };
  }

  get isDead(): boolean {
    return this.dead;
  }

  /**
   * Restarts this same TimePlayer instance in place at (x, y) - used to
   * loop the death replay without recreating the sprite/graphics objects
   * each pass. Clears every piece of run-scoped state (dash/slash
   * cooldowns, dead flag, tint, velocity, aim) back to a fresh run's
   * starting values; does NOT touch the input source - the caller sets
   * that once when entering replay and it stays a RecordedInputSource
   * across every loop, just rewound.
   */
  reset(x: number, y: number): void {
    this.sprite.setPosition(x, y);
    this.velocityX = 0;
    this.velocityY = 0;
    this.sprite.clearTint();

    this.isDashing = false;
    this.dashTimeRemainingMs = 0;
    this.dashLockoutRemainingMs = 0;
    this.dashIframeTailRemainingMs = 0;
    this.dashCharges = 1;
    this.maxDashChargesValue = 1;

    this.slashAngle = 0;
    this.slashActiveRemainingMs = 0;
    this.slashCooldownRemainingMs = 0;
    this.swingId = 0;
    this.slashGraphic.clear();

    this.dead = false;
    this.worldTimescaleValue = 1;
    this.aimAngle = -Math.PI / 2;
    this.lastInputStateValue = null;
  }

  /** Seconds until the baseline dash charge (see dashCharges' doc comment) regenerates, 0 if a charge is already available. */
  get dashCooldownRemainingSec(): number {
    return this.dashLockoutRemainingMs / 1000;
  }

  /** How many dashes are banked and spendable right now. */
  get dashChargesAvailable(): number {
    return this.dashCharges;
  }

  /** The current ceiling on dashChargesAvailable - see setMaxDashCharges. */
  get maxDashCharges(): number {
    return this.maxDashChargesValue;
  }

  /** Seconds of Slash cooldown remaining (world-time-scaled), 0 if ready. */
  get slashCooldownRemainingSec(): number {
    return this.slashCooldownRemainingMs / 1000;
  }

  get isInvincible(): boolean {
    return this.isDashing || this.dashIframeTailRemainingMs > 0;
  }

  get isDashActive(): boolean {
    return this.isDashing;
  }

  takeDamage(): void {
    this.dead = true;
    this.sprite.setTint(HURT_TINT);
  }

  getActiveSlashHitbox(): SlashHitbox | null {
    if (this.slashActiveRemainingMs <= 0) {
      return null;
    }
    return {
      x: this.position.x,
      y: this.position.y,
      angle: this.slashAngle,
      range: SLASH_RANGE,
      arcWidth: SLASH_ARC_WIDTH,
      swingId: this.swingId,
    };
  }

  /**
   * The hitbox a Slash would use if triggered this exact instant, aimed at
   * the player's CURRENT aim angle rather than a locked-in swing angle - for
   * the "what would get hit right now" QoL preview, not an actual swing.
   * Null whenever Slash isn't off cooldown, since canSlash() being false
   * also covers "currently mid-swing" (the cooldown starts the instant a
   * swing does), so there's no separate check needed for that case.
   */
  getPreviewSlashHitbox(): SlashHitbox | null {
    if (!this.canSlash()) {
      return null;
    }
    return {
      x: this.position.x,
      y: this.position.y,
      angle: this.aimAngle,
      range: SLASH_RANGE,
      arcWidth: SLASH_ARC_WIDTH,
      swingId: -1,
    };
  }

  /**
   * Clears Slash's cooldown immediately - call this when a deflected
   * projectile goes on to kill something, rewarding a successful deflect
   * chain with another swing right away instead of waiting out the full
   * cooldown. Clamped to slashActiveRemainingMs rather than always
   * dropping straight to 0: a deflect-kill could in principle land during
   * the same swing that caused it (a very fast bounce), and canSlash()
   * only checks the cooldown, not whether a swing is still active - going
   * below the current swing's own remaining time would let a new swing
   * start while the old one's hitbox/animation is still playing.
   */
  resetSlashCooldown(): void {
    this.slashCooldownRemainingMs = Math.min(this.slashCooldownRemainingMs, this.slashActiveRemainingMs);
  }

  /**
   * Immediately clears the baseline dash regen wait and guarantees at least
   * one dash is ready - call this the instant any deflected projectile hits
   * an enemy (same trigger, same call site, as resetSlashCooldown), so a
   * successful deflect chain also hands back a dash right away instead of
   * making the player wait out the regen timer. Doesn't touch dashCharges if
   * one's already banked - see setMaxDashCharges for how the chain's actual
   * charge COUNT gets synced.
   */
  resetDashCooldown(): void {
    this.dashLockoutRemainingMs = 0;
    if (this.dashCharges < 1) {
      this.dashCharges = 1;
    }
  }

  /**
   * Keeps dashCharges' ceiling in sync with the live deflected-projectile
   * chain (see TimeManager.liveMaxChainCount) - call every frame with
   * Math.max(1, that count). A no-op unless the ceiling actually changed
   * since last frame: rising snaps dashCharges straight up to the new max
   * (a fresh chain hit hands over that many usable dashes immediately, no
   * waiting), falling - the chain's source projectile despawned - resets
   * dashCharges straight down (or back up) to the new max just as
   * immediately, per "if the projectile despawns, their dashes reset."
   * Deliberately snaps rather than clamping the existing count: landing
   * exactly on the new ceiling either way is what makes both directions read
   * as one consistent "reset," not two different rules.
   */
  setMaxDashCharges(maxCharges: number): void {
    if (maxCharges === this.maxDashChargesValue) {
      return;
    }
    this.maxDashChargesValue = maxCharges;
    this.dashCharges = maxCharges;
    this.dashLockoutRemainingMs = 0;
  }

  private canDash(): boolean {
    return this.dashCharges > 0 && !this.isDashing;
  }

  private canSlash(): boolean {
    return this.slashCooldownRemainingMs <= 0;
  }

  private startDash(moveX: number, moveY: number): void {
    const moveVector = new Phaser.Math.Vector2(moveX, moveY);
    const dashDirection =
      moveVector.lengthSq() > 0 ? moveVector.normalize() : new Phaser.Math.Vector2(Math.cos(this.aimAngle), Math.sin(this.aimAngle));

    const dashVelocity = dashDirection.scale(DASH_SPEED);
    this.clipOutwardComponent(dashVelocity);

    this.isDashing = true;
    this.dashTimeRemainingMs = DASH_DURATION_MS;
    this.dashCharges--;
    if (this.dashCharges < 1) {
      // Out of banked charges - fall back to the baseline regen timer, same
      // lockout duration the original single-dash design always used.
      this.dashLockoutRemainingMs = DASH_LOCKOUT_MS;
    }
    this.velocityX = dashVelocity.x;
    this.velocityY = dashVelocity.y;
    this.sprite.setTint(DASH_TINT);
    this.spawnDashGhost();
  }

  private updateDash(realDelta: number): void {
    if (!this.isDashing) {
      return;
    }
    this.spawnDashGhost();
    this.dashTimeRemainingMs -= realDelta;
    if (this.dashTimeRemainingMs <= 0) {
      this.isDashing = false;
      this.dashIframeTailRemainingMs = DASH_IFRAME_TAIL_MS;
      this.sprite.clearTint();
    }
  }

  /** A fading afterimage left behind during a dash, so the burst reads as motion rather than a teleport. */
  private spawnDashGhost(): void {
    const ghost = this.scene.add.image(this.sprite.x, this.sprite.y, "time-player");
    ghost.setTint(DASH_TINT);
    ghost.setAlpha(0.5);
    this.scene.tweens.add({
      targets: ghost,
      alpha: 0,
      scale: 0.7,
      duration: 220,
      onComplete: () => ghost.destroy(),
    });
  }

  private startSlash(angle: number): void {
    this.slashAngle = angle;
    this.slashActiveRemainingMs = SLASH_DURATION_MS;
    this.slashCooldownRemainingMs = SLASH_COOLDOWN_MS;
    this.swingId++;
    this.redrawSlashArc();
  }

  private updateSlash(realDelta: number): void {
    if (this.slashActiveRemainingMs <= 0) {
      return;
    }
    this.slashActiveRemainingMs -= realDelta;
    if (this.slashActiveRemainingMs <= 0) {
      this.slashGraphic.clear();
    } else {
      this.redrawSlashArc();
    }
  }

  /**
   * The arc starts bright/thick (a flash) and tapers down to the settled
   * thin yellow line over the swing's active duration - reads as a moment
   * of impact rather than a static line that just appears and disappears.
   */
  private redrawSlashArc(): void {
    this.slashGraphic.clear();
    const progress = 1 - this.slashActiveRemainingMs / SLASH_DURATION_MS;
    const width = Phaser.Math.Linear(10, 4, progress);
    const alpha = Phaser.Math.Linear(1, 0.5, progress);
    const flashProgress = Math.min(1, progress / SLASH_FLASH_PORTION);
    const color = Phaser.Display.Color.Interpolate.ColorWithColor(
      Phaser.Display.Color.ValueToColor(0xffffff),
      Phaser.Display.Color.ValueToColor(SLASH_COLOR),
      100,
      flashProgress * 100,
    ).color;

    this.slashGraphic.lineStyle(width, color, alpha);
    this.slashGraphic.beginPath();
    this.slashGraphic.arc(this.position.x, this.position.y, SLASH_RANGE, this.slashAngle - SLASH_ARC_WIDTH / 2, this.slashAngle + SLASH_ARC_WIDTH / 2);
    this.slashGraphic.strokePath();
  }

  /**
   * A persistent wedge outline (arc + two radial lines back to the player)
   * showing exactly the region a Slash would hit if triggered this instant -
   * same range/arc-width/current-aim math getPreviewSlashHitbox() and the
   * actual swing both use, so this can never disagree with what's really
   * slashable. Drawn every frame regardless of swing state; brighter when
   * Slash is actually ready, faint while on cooldown. Suppressed entirely
   * during the death replay - it exists to help aim a swing that's about to
   * happen, and nothing being replayed is still being decided live.
   */
  private redrawSlashRangeIndicator(): void {
    this.slashRangeGraphic.clear();
    if (!getShowSlashRangeIndicator() || this.isReplaying) {
      return;
    }
    const ready = this.canSlash();
    const color = ready ? SLASH_RANGE_READY_COLOR : SLASH_RANGE_COOLDOWN_COLOR;
    const alpha = ready ? SLASH_RANGE_READY_ALPHA : SLASH_RANGE_COOLDOWN_ALPHA;
    const { x, y } = this.position;
    const startAngle = this.aimAngle - SLASH_ARC_WIDTH / 2;
    const endAngle = this.aimAngle + SLASH_ARC_WIDTH / 2;

    this.slashRangeGraphic.lineStyle(1.5, color, alpha);
    this.slashRangeGraphic.beginPath();
    this.slashRangeGraphic.arc(x, y, SLASH_RANGE, startAngle, endAngle);
    this.slashRangeGraphic.strokePath();

    this.slashRangeGraphic.lineBetween(x, y, x + Math.cos(startAngle) * SLASH_RANGE, y + Math.sin(startAngle) * SLASH_RANGE);
    this.slashRangeGraphic.lineBetween(x, y, x + Math.cos(endAngle) * SLASH_RANGE, y + Math.sin(endAngle) * SLASH_RANGE);
  }

  /** Dash lockout and Slash cooldown tick on world-scaled time; everything else about the player stays on real time (see class doc comment). */
  private tickCooldowns(realDelta: number, worldScaledDelta: number): void {
    if (this.dashLockoutRemainingMs > 0) {
      this.dashLockoutRemainingMs = Math.max(0, this.dashLockoutRemainingMs - worldScaledDelta);
      if (this.dashLockoutRemainingMs <= 0 && this.dashCharges < 1) {
        this.dashCharges = 1;
      }
    }
    if (this.dashIframeTailRemainingMs > 0) {
      this.dashIframeTailRemainingMs = Math.max(0, this.dashIframeTailRemainingMs - realDelta);
    }
    if (this.slashCooldownRemainingMs > 0) {
      this.slashCooldownRemainingMs = Math.max(0, this.slashCooldownRemainingMs - worldScaledDelta);
    }
  }

  private redrawAimIndicator(): void {
    this.aimIndicator.clear();
    this.aimIndicator.lineStyle(2, 0x59f2c8, 0.8);
    const { x, y } = this.position;
    const tipX = x + Math.cos(this.aimAngle) * 36;
    const tipY = y + Math.sin(this.aimAngle) * 36;
    this.aimIndicator.lineBetween(x, y, tipX, tipY);
  }

  private clipOutwardComponent(velocity: Phaser.Math.Vector2): void {
    const dx = this.sprite.x - this.arena.bounds.centerX;
    const dy = this.sprite.y - this.arena.bounds.centerY;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);
    if (distFromCenter === 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = this.arena.maxRadiusAtAngle(angle) - TimePlayer.RADIUS;

    if (distFromCenter >= maxDist - WALL_EPSILON) {
      const normal = this.arena.normalAtAngle(angle);
      const outwardSpeed = velocity.x * normal.x + velocity.y * normal.y;
      if (outwardSpeed > 0) {
        velocity.x -= outwardSpeed * normal.x;
        velocity.y -= outwardSpeed * normal.y;
      }
    }
  }

  private clampToArena(): void {
    const dx = this.sprite.x - this.arena.bounds.centerX;
    const dy = this.sprite.y - this.arena.bounds.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = this.arena.maxRadiusAtAngle(angle) - TimePlayer.RADIUS;

    if (dist > maxDist) {
      const scale = maxDist / dist;
      this.sprite.x = this.arena.bounds.centerX + dx * scale;
      this.sprite.y = this.arena.bounds.centerY + dy * scale;
    }
  }
}
