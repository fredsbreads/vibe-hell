import Phaser from "phaser";
import { PlayerInput, InputState } from "../input/PlayerInput";

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
  isInvincible = false;

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

  constructor(scene: Phaser.Scene, x: number, y: number) {
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

    this.redrawAimIndicator();
    this.redrawStatusText();
  }

  get currentHp(): number {
    return this.hp;
  }

  get isDead(): boolean {
    return this.hp <= 0;
  }

  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
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
    this.isInvincible = true;
    this.dashTimeRemainingMs = DASH_DURATION_MS;
    this.dashLockoutRemainingMs = DASH_LOCKOUT_MS;
    this.sprite.setVelocity(dashDirection.x * DASH_SPEED, dashDirection.y * DASH_SPEED);
  }

  private updateDash(delta: number): void {
    if (!this.isDashing) {
      return;
    }
    this.dashTimeRemainingMs -= delta;
    if (this.dashTimeRemainingMs <= 0) {
      this.isDashing = false;
      this.isInvincible = false;
    }
  }

  private startSlash(angle: number): void {
    this.slashAngle = angle;
    this.slashActiveRemainingMs = SLASH_DURATION_MS;
    this.slashCooldownRemainingMs = SLASH_COOLDOWN_MS;

    this.slashGraphic.clear();
    this.slashGraphic.lineStyle(4, 0xf2e85c, 1);
    this.slashGraphic.beginPath();
    this.slashGraphic.arc(
      this.sprite.x,
      this.sprite.y,
      SLASH_RANGE,
      angle - SLASH_ARC_WIDTH / 2,
      angle + SLASH_ARC_WIDTH / 2,
    );
    this.slashGraphic.strokePath();
  }

  private updateSlash(delta: number): void {
    if (this.slashActiveRemainingMs <= 0) {
      return;
    }
    this.slashActiveRemainingMs -= delta;
    if (this.slashActiveRemainingMs <= 0) {
      this.slashGraphic.clear();
    }
  }

  private tickCooldowns(delta: number): void {
    if (this.dashLockoutRemainingMs > 0) {
      this.dashLockoutRemainingMs = Math.max(0, this.dashLockoutRemainingMs - delta);
    }
    if (this.slashCooldownRemainingMs > 0) {
      this.slashCooldownRemainingMs = Math.max(0, this.slashCooldownRemainingMs - delta);
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
