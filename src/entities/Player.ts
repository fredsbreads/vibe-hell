import Phaser from "phaser";
import { PlayerInput, InputState } from "../input/PlayerInput";
import { Arena } from "../arena/Arena";

const DASH_TINT = 0xaefff0;
const HURT_TINT = 0xff3b3b;
const HURT_FLASH_MS = 150;
const HURT_SHAKE_DURATION_MS = 120;
const HURT_SHAKE_INTENSITY = 0.008;

const MOVE_SPEED = 320;

// Tolerance for "am I at the wall" checks, absorbing float rounding in the
// boundary reposition math so a hair-under-maxDist position still counts as
// "at the wall" instead of letting a frame of unclipped velocity slip through.
const WALL_EPSILON = 0.5;

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
      this.clipOutwardComponent(move);
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

  /** Whether a dash is currently active - Stop Waves only punish contact made while dashing through one. */
  get isDashActive(): boolean {
    return this.isDashing;
  }

  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
    this.hitGraceRemainingMs = HIT_INVINCIBILITY_MS;
    this.playHurtEffect();
  }

  /**
   * Punishes dashing into a Stop Wave: cancels the dash, strips i-frames, and deals
   * damage, bypassing normal invincibility. Only ever called while isDashActive is
   * true (see MainScene) - walking into a Stop Wave without dashing does nothing.
   */
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

    const dashVelocity = dashDirection.scale(DASH_SPEED);
    // Dash bypasses the normal per-frame movement path entirely (it sets velocity
    // once up front), so without this it could slam full-speed into a wall you're
    // already standing at and get slapped back by the post-hoc safety clamp -
    // a much harder "bounce" than walking into a wall thanks to dash's 900px/s
    // speed. Clip it the same way regular movement is clipped.
    this.clipOutwardComponent(dashVelocity);

    this.isDashing = true;
    this.dashTimeRemainingMs = DASH_DURATION_MS;
    this.dashLockoutRemainingMs = DASH_LOCKOUT_MS;
    this.sprite.setVelocity(dashVelocity.x, dashVelocity.y);

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

  /**
   * Strips the outward-pointing component of a movement/velocity vector if the
   * player is already sitting at (or past) the arena wall at their current
   * position - comparing the wall's outward normal against the requested
   * direction up front, before it's ever handed to physics. This is what
   * actually prevents the wall from feeling bouncy: nothing ever gets applied
   * that would overshoot the boundary in the first place, so there's no
   * overshoot-then-snap-back cycle to begin with. Used for both normal
   * movement and dash, since dash's 900px/s burst would otherwise slam past
   * the wall and get yanked back much harder than walking does.
   */
  private clipOutwardComponent(vector: Phaser.Math.Vector2): void {
    // Reads body.center, NOT sprite.x/y. During Scene.update(), Arcade Physics has
    // already integrated this frame's velocity into the body (that happens earlier,
    // in its own preupdate/update step), but hasn't written it back to the sprite's
    // transform yet - that reconciliation happens in postupdate, which runs AFTER
    // Scene.update(). So sprite.x here is one frame stale relative to where physics
    // actually just put the body. body.center is always current.
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    const dx = body.center.x - this.arena.bounds.centerX;
    const dy = body.center.y - this.arena.bounds.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = this.arena.maxRadiusAtAngle(angle) - Player.RADIUS;
    // WALL_EPSILON matters: clampToArena's reposition (scale = maxDist / dist)
    // doesn't land on EXACTLY maxDist - float division rounding can leave the
    // player a hair under it. With a strict dist < maxDist bail here, that
    // hair-under position reads as "not at the wall yet" for one frame, so a
    // full unclipped step of outward velocity leaks through, overshoots,
    // gets corrected, lands a hair under again, and repeats forever - a
    // sustained push/snap cycle with near-zero net displacement that plays
    // as the player being stuck in place. Treating "within half a pixel of
    // the wall" as "at the wall" closes that gap.
    if (dist < maxDist - WALL_EPSILON) {
      return;
    }

    const normal = this.arena.normalAtAngle(angle);
    const outward = vector.x * normal.x + vector.y * normal.y;
    if (outward > 0) {
      vector.x -= outward * normal.x;
      vector.y -= outward * normal.y;
    }
  }

  /**
   * Pure positional safety net, run after movement/dash each frame. Ordinary
   * play should rarely trigger this now that clipOutwardComponent() stops
   * outward velocity before it's applied - this only catches the cases that
   * aren't about the player's own velocity: a rotating polygon wall sweeping
   * inward past the player's fixed position, or any residual float drift.
   */
  private clampToArena(): void {
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    // body.center, not sprite.x/y - see clipOutwardComponent's comment. Using the
    // stale sprite position here was the actual cause of the "touch the wall and
    // get stuck forever" bug: once the player reached the boundary, this method
    // would recompute the SAME clampedX/Y from the SAME stale sprite.x every frame
    // (since sprite.x only updates once postUpdate runs, which is after this),
    // repeatedly overwriting body.position back to that one frozen value and
    // discarding whatever the real physics step had just integrated - so postUpdate's
    // delta (body.position - prevFrame) collapsed to zero and the sprite never moved
    // again, no matter what the input or velocity was doing.
    const dx = body.center.x - this.arena.bounds.centerX;
    const dy = body.center.y - this.arena.bounds.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = this.arena.maxRadiusAtAngle(angle) - Player.RADIUS;

    if (dist > maxDist) {
      const scale = maxDist / dist;
      const clampedX = this.arena.bounds.centerX + dx * scale;
      const clampedY = this.arena.bounds.centerY + dy * scale;

      // Writing directly to body.position (not sprite.setPosition()) matters here.
      // Arcade's postUpdate runs AFTER Scene.update() every frame and reconciles the
      // sprite from the body via gameObject.x += (body.position.x - prevFrame.x) -
      // an ADDITIVE delta, not an absolute write. If we call sprite.setPosition()
      // here (mid-frame, before that reconciliation happens) and then sync the body
      // from it via updateFromGameObject(), postUpdate's delta-based write-back
      // re-applies that same displacement a second time on top of the sprite we
      // already moved - a genuine double-count, not float error. That's what was
      // producing the "touch the wall and get stuck" bug: the position would
      // overshoot by roughly the size of its own correction, alternate between a
      // handful of quantized offsets frame to frame, and never converge. Setting
      // body.position (and re-deriving its center) leaves the sprite's own x/y
      // untouched so postUpdate's delta is the ONLY write that ever happens.
      body.position.x = clampedX - body.halfWidth;
      body.position.y = clampedY - body.halfHeight;
      body.updateCenter();

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
