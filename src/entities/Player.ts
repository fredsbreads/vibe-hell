import Phaser from "phaser";
import { PlayerInput, InputState } from "../input/PlayerInput";
import { Arena } from "../arena/Arena";

const DASH_TINT = 0xaefff0;
const HURT_TINT = 0xff3b3b;
const HURT_FLASH_MS = 150;
const HURT_SHAKE_DURATION_MS = 120;
const HURT_SHAKE_INTENSITY = 0.008;

const MOVE_SPEED = 320;

const DASH_SPEED = 900;
const DASH_DURATION_MS = 150;
const DASH_COOLDOWN_MS = 200;
const DASH_LOCKOUT_MS = DASH_DURATION_MS + DASH_COOLDOWN_MS;

const SLASH_DURATION_MS = 120;
const SLASH_COOLDOWN_MS = 500;
const SLASH_RANGE = 60;
const SLASH_ARC_WIDTH = 0.9;

const STARTING_HP = 3;

// Brief invincibility after taking a hit, separate from dash i-frames, so a
// cluster of overlapping projectiles can't chain-damage you in the same
// instant with zero chance to react.
const HIT_INVINCIBILITY_MS = 700;
const HIT_BLINK_INTERVAL_MS = 80;

export interface SlashHitbox {
  x: number;
  y: number;
  angle: number;
  range: number;
  arcWidth: number;
}

export class Player {
  static readonly RADIUS = 16;

  readonly sprite: Phaser.Physics.Arcade.Sprite;

  aimAngle = -Math.PI / 2;

  private readonly input: PlayerInput;
  private readonly aimIndicator: Phaser.GameObjects.Graphics;
  private readonly slashGraphic: Phaser.GameObjects.Graphics;
  private readonly statusText: Phaser.GameObjects.Text;

  private isDashing = false;
  private dashTimeRemainingMs = 0;
  private dashLockoutRemainingMs = 0;

  private slashAngle = 0;
  private slashActiveRemainingMs = 0;
  private slashCooldownRemainingMs = 0;

  private hp = STARTING_HP;
  private hitGraceRemainingMs = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly arena: Arena,
  ) {
    this.input = new PlayerInput(scene);

    this.sprite = scene.physics.add.sprite(x, y, "player");
    this.sprite.setCircle(Player.RADIUS);

    this.aimIndicator = scene.add.graphics();
    this.slashGraphic = scene.add.graphics();
    this.statusText = scene.add.text(12, 12, "", {
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#e0e0f0",
      lineSpacing: 6,
    });
  }

  update(delta: number): void {
    const state = this.input.read(this.sprite.x, this.sprite.y);
    this.aimAngle = state.aimAngle;

    this.tickCooldowns(delta);

    if (state.dashPressed && this.canDash()) {
      this.startDash(state);
    }
    if (state.slashPressed && this.canSlash()) {
      this.startSlash(state.aimAngle);
    }

    this.updateDash(delta);
    this.updateSlash(delta);

    if (!this.isDashing) {
      const move = new Phaser.Math.Vector2(state.moveX, state.moveY);
      if (move.lengthSq() > 0) {
        move.normalize().scale(MOVE_SPEED);
      }
      this.sprite.setVelocity(move.x, move.y);
    }

    this.clampToArena();
    this.updateHitGraceVisual();

    this.redrawAimIndicator();
    this.redrawStatusText();
  }

  get currentHp(): number {
    return this.hp;
  }

  get isDead(): boolean {
    return this.hp <= 0;
  }

  /** True during dash i-frames OR the brief post-hit grace window - either source blocks normal contact damage. */
  get isInvincible(): boolean {
    return this.isDashing || this.hitGraceRemainingMs > 0;
  }

  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
    this.hitGraceRemainingMs = HIT_INVINCIBILITY_MS;
    this.playHurtEffect();
  }

  /** Hard counter for Stop Waves: cancels any active dash, strips i-frames, and deals damage, bypassing normal invincibility. */
  interruptDashAndDamage(amount: number): void {
    this.isDashing = false;
    this.dashTimeRemainingMs = 0;
    this.sprite.setVelocity(0, 0);
    this.takeDamage(amount);
  }

  /** The active slash hit-region for this frame, or null if the slash isn't currently active. */
  getActiveSlashHitbox(): SlashHitbox | null {
    if (this.slashActiveRemainingMs <= 0) {
      return null;
    }
    return {
      x: this.sprite.x,
      y: this.sprite.y,
      angle: this.slashAngle,
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

  private startDash(state: InputState): void {
    const moveVector = new Phaser.Math.Vector2(state.moveX, state.moveY);
    const dashDirection =
      moveVector.lengthSq() > 0
        ? moveVector.normalize()
        : new Phaser.Math.Vector2(Math.cos(state.aimAngle), Math.sin(state.aimAngle));

    this.isDashing = true;
    this.dashTimeRemainingMs = DASH_DURATION_MS;
    this.dashLockoutRemainingMs = DASH_LOCKOUT_MS;
    this.sprite.setVelocity(dashDirection.x * DASH_SPEED, dashDirection.y * DASH_SPEED);

    this.sprite.setTint(DASH_TINT);
    this.spawnDashGhost();
  }

  private updateDash(delta: number): void {
    if (!this.isDashing) {
      return;
    }
    this.spawnDashGhost();
    this.dashTimeRemainingMs -= delta;
    if (this.dashTimeRemainingMs <= 0) {
      this.isDashing = false;
      this.sprite.clearTint();
    }
  }

  /** A fading afterimage left behind during a dash, so the burst reads as motion rather than a teleport. */
  private spawnDashGhost(): void {
    const ghost = this.scene.add.image(this.sprite.x, this.sprite.y, "player");
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

  /** Red tint flash + camera shake on taking damage, so a hit reads as an event rather than a silent number change. */
  private playHurtEffect(): void {
    this.sprite.setTint(HURT_TINT);
    this.scene.time.delayedCall(HURT_FLASH_MS, () => {
      if (this.isDashing) {
        this.sprite.setTint(DASH_TINT);
      } else {
        this.sprite.clearTint();
      }
    });
    this.scene.cameras.main.shake(HURT_SHAKE_DURATION_MS, HURT_SHAKE_INTENSITY);
  }

  private startSlash(angle: number): void {
    this.slashAngle = angle;
    this.slashActiveRemainingMs = SLASH_DURATION_MS;
    this.slashCooldownRemainingMs = SLASH_COOLDOWN_MS;
    this.redrawSlashArc();
  }

  private updateSlash(delta: number): void {
    if (this.slashActiveRemainingMs <= 0) {
      return;
    }
    this.slashActiveRemainingMs -= delta;
    if (this.slashActiveRemainingMs <= 0) {
      this.slashGraphic.clear();
    } else {
      // Redraw at the player's current position each frame - getActiveSlashHitbox()
      // already tracks live position for the actual hit detection, but the arc was
      // only ever drawn once at slash-start, so it'd visibly detach from the player
      // if they moved mid-slash even though the hitbox itself was still following.
      this.redrawSlashArc();
    }
  }

  /** Draws the slash arc at the player's current position, along the angle locked in when the slash started. */
  private redrawSlashArc(): void {
    this.slashGraphic.clear();
    this.slashGraphic.lineStyle(4, 0xf2e85c, 1);
    this.slashGraphic.beginPath();
    this.slashGraphic.arc(
      this.sprite.x,
      this.sprite.y,
      SLASH_RANGE,
      this.slashAngle - SLASH_ARC_WIDTH / 2,
      this.slashAngle + SLASH_ARC_WIDTH / 2,
    );
    this.slashGraphic.strokePath();
  }

  private tickCooldowns(delta: number): void {
    if (this.dashLockoutRemainingMs > 0) {
      this.dashLockoutRemainingMs = Math.max(0, this.dashLockoutRemainingMs - delta);
    }
    if (this.slashCooldownRemainingMs > 0) {
      this.slashCooldownRemainingMs = Math.max(0, this.slashCooldownRemainingMs - delta);
    }
    if (this.hitGraceRemainingMs > 0) {
      this.hitGraceRemainingMs = Math.max(0, this.hitGraceRemainingMs - delta);
    }
  }

  /** Blinks the sprite while the post-hit grace window is active, so the player can see they're currently safe. */
  private updateHitGraceVisual(): void {
    if (this.hitGraceRemainingMs <= 0) {
      this.sprite.setAlpha(1);
      return;
    }
    const blinkOn = Math.floor(this.hitGraceRemainingMs / HIT_BLINK_INTERVAL_MS) % 2 === 0;
    this.sprite.setAlpha(blinkOn ? 0.35 : 1);
  }

  private clampToArena(): void {
    const dx = this.sprite.x - this.arena.bounds.centerX;
    const dy = this.sprite.y - this.arena.bounds.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = this.arena.maxRadiusAtAngle(angle) - Player.RADIUS;

    // >= (not just >) matters here: once a prior frame has already snapped the
    // player exactly onto the boundary, dist sits at precisely maxDist. update()
    // unconditionally overwrites velocity from raw input before this runs, so if
    // we only trimmed velocity while strictly past the boundary, a player holding
    // straight into the wall would get one full frame of un-trimmed outward
    // velocity through to the physics step, overshoot, get snapped back next
    // frame, then repeat - a constant push-out/snap-back cycle that reads as
    // bouncy/jittery instead of a smooth slide. Trimming at dist === maxDist too
    // kills the outward component before it ever reaches the physics engine.
    if (dist >= maxDist) {
      const scale = maxDist / dist;
      const clampedX = this.arena.bounds.centerX + dx * scale;
      const clampedY = this.arena.bounds.centerY + dy * scale;

      const body = this.sprite.body as Phaser.Physics.Arcade.Body;
      // setPosition() alone would leave the Arcade body's internal position out of
      // sync, letting it drift past the wall on the next physics step - but unlike
      // body.reset(), updateFromGameObject() re-syncs position without also zeroing
      // velocity. body.reset() was killing ALL velocity (including the along-wall
      // component) every single frame you pressed into the wall, which is what made
      // moving along the perimeter feel like stopping and restarting each frame
      // instead of sliding.
      this.sprite.setPosition(clampedX, clampedY);
      body.updateFromGameObject();

      // Only cancel the outward-pointing component of velocity (against the true
      // wall normal - a flat edge's normal for polygon arenas, radial for a circle),
      // preserving whatever's left tangent to the wall so you slide along it.
      const normal = this.arena.normalAtAngle(angle);
      const outwardSpeed = body.velocity.x * normal.x + body.velocity.y * normal.y;
      if (outwardSpeed > 0) {
        body.velocity.x -= outwardSpeed * normal.x;
        body.velocity.y -= outwardSpeed * normal.y;
      }
    }
  }

  private redrawAimIndicator(): void {
    this.aimIndicator.clear();
    this.aimIndicator.lineStyle(2, 0x59f2c8, 0.8);
    const tipX = this.sprite.x + Math.cos(this.aimAngle) * 36;
    const tipY = this.sprite.y + Math.sin(this.aimAngle) * 36;
    this.aimIndicator.lineBetween(this.sprite.x, this.sprite.y, tipX, tipY);
  }

  private redrawStatusText(): void {
    const dashLabel = this.canDash()
      ? "DASH: READY"
      : `DASH: ${(this.dashLockoutRemainingMs / 1000).toFixed(1)}s`;
    const slashLabel = this.canSlash()
      ? "SLASH: READY"
      : `SLASH: ${(this.slashCooldownRemainingMs / 1000).toFixed(1)}s`;
    const hpLabel = `HP: ${"♥".repeat(this.hp)}${"♡".repeat(STARTING_HP - this.hp)}`;
    this.statusText.setText(`${dashLabel}\n${slashLabel}\n${hpLabel}`);
  }
}
