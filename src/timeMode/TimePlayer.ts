import Phaser from "phaser";
import { PlayerInput } from "../input/PlayerInput";
import { Arena } from "../arena/Arena";
import { computeWorldTimescale } from "./worldClock";

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

export interface SlashHitbox {
  x: number;
  y: number;
  angle: number;
  range: number;
  arcWidth: number;
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

  private readonly input: PlayerInput;
  private readonly aimIndicator: Phaser.GameObjects.Graphics;
  private readonly slashGraphic: Phaser.GameObjects.Graphics;

  private isDashing = false;
  private dashTimeRemainingMs = 0;
  private dashLockoutRemainingMs = 0;
  private dashIframeTailRemainingMs = 0;

  private slashAngle = 0;
  private slashActiveRemainingMs = 0;
  private slashCooldownRemainingMs = 0;

  private dead = false;
  private worldTimescaleValue = 1;

  constructor(
    private readonly scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly arena: Arena,
  ) {
    this.input = new PlayerInput(scene);

    this.sprite = scene.physics.add.sprite(x, y, "time-player");
    this.sprite.setCircle(TimePlayer.RADIUS);
    this.sprite.setDepth(5);

    this.aimIndicator = scene.add.graphics();
    this.slashGraphic = scene.add.graphics();
  }

  /** The world timescale computed from this frame's raw stick input - read this AFTER calling update(), and use it to step everything else ("the world") this same frame. */
  get worldTimescale(): number {
    return this.worldTimescaleValue;
  }

  /**
   * Re-syncs input edge-detection to whatever's currently held - call this
   * right after leaving a paused state (or right after constructing a fresh
   * TimePlayer on restart), so a button still held from confirming a menu
   * (Cross/Enter doubles as both "confirm" and Dash) doesn't fire that
   * in-game action the instant control returns to gameplay.
   */
  resyncInputState(): void {
    this.input.resyncHeldState(this.position.x, this.position.y);
  }

  update(realDelta: number): void {
    const state = this.input.read(this.position.x, this.position.y);
    this.aimAngle = state.aimAngle;
    this.worldTimescaleValue = computeWorldTimescale(state.moveX, state.moveY);
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
      this.sprite.setVelocity(move.x, move.y);
    }

    this.clampToArena();
    this.redrawAimIndicator();
  }

  private get position(): { x: number; y: number } {
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    return body.center;
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** Seconds of Dash lockout remaining (world-time-scaled), 0 if ready. */
  get dashCooldownRemainingSec(): number {
    return this.dashLockoutRemainingMs / 1000;
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
    };
  }

  private canDash(): boolean {
    return this.dashLockoutRemainingMs <= 0;
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
    this.dashLockoutRemainingMs = DASH_LOCKOUT_MS;
    this.sprite.setVelocity(dashVelocity.x, dashVelocity.y);
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

  /** Dash lockout and Slash cooldown tick on world-scaled time; everything else about the player stays on real time (see class doc comment). */
  private tickCooldowns(realDelta: number, worldScaledDelta: number): void {
    if (this.dashLockoutRemainingMs > 0) {
      this.dashLockoutRemainingMs = Math.max(0, this.dashLockoutRemainingMs - worldScaledDelta);
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
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    const dx = body.center.x - this.arena.bounds.centerX;
    const dy = body.center.y - this.arena.bounds.centerY;
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
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    const dx = body.center.x - this.arena.bounds.centerX;
    const dy = body.center.y - this.arena.bounds.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = this.arena.maxRadiusAtAngle(angle) - TimePlayer.RADIUS;

    if (dist > maxDist) {
      const scale = maxDist / dist;
      const clampedX = this.arena.bounds.centerX + dx * scale;
      const clampedY = this.arena.bounds.centerY + dy * scale;
      body.position.x = clampedX - body.halfWidth;
      body.position.y = clampedY - body.halfHeight;
    }
  }
}
