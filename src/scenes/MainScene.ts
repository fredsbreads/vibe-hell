import Phaser from "phaser";
import { Player } from "../entities/Player";
import { ProjectileManager } from "../managers/ProjectileManager";
import { ArenaBounds, ARENA_RADIUS } from "../config/arena";
import { BASIC_PROJECTILE_RADIUS } from "../entities/projectiles/BasicProjectile";

export class MainScene extends Phaser.Scene {
  private player!: Player;
  private projectileManager!: ProjectileManager;
  private arena!: ArenaBounds;

  private threatsEndured = 0;
  private threatsText!: Phaser.GameObjects.Text;

  constructor() {
    super("MainScene");
  }

  create(): void {
    const { width, height } = this.scale;
    this.arena = { centerX: width / 2, centerY: height / 2, radius: ARENA_RADIUS };

    this.generatePlayerTexture();
    this.generateBasicProjectileTexture();

    this.add
      .circle(this.arena.centerX, this.arena.centerY, this.arena.radius, 0x1a1a2e)
      .setStrokeStyle(4, 0x4a4a6a);

    this.player = new Player(this, this.arena.centerX, this.arena.centerY);
    this.projectileManager = new ProjectileManager(this, this.arena);

    this.threatsText = this.add
      .text(width - 12, 12, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#e0e0f0",
      })
      .setOrigin(1, 0);
  }

  update(_time: number, delta: number): void {
    this.player.update(delta);

    const escaped = this.projectileManager.update(delta, this.player.sprite.x, this.player.sprite.y);
    const slashHits = this.projectileManager.checkSlashHits(this.player.getActiveSlashHitbox());
    this.threatsEndured += escaped + slashHits;

    if (!this.player.isInvincible) {
      const damage = this.projectileManager.checkPlayerCollisions(
        this.player.sprite.x,
        this.player.sprite.y,
        Player.RADIUS,
      );
      if (damage > 0) {
        this.player.takeDamage(damage);
      }
    }

    this.threatsText.setText(`THREATS ENDURED: ${this.threatsEndured}`);
  }

  private generatePlayerTexture(): void {
    if (this.textures.exists("player")) {
      return;
    }
    const graphics = this.add.graphics();
    graphics.fillStyle(0x59f2c8, 1);
    graphics.fillCircle(16, 16, 16);
    graphics.generateTexture("player", 32, 32);
    graphics.destroy();
  }

  private generateBasicProjectileTexture(): void {
    if (this.textures.exists("basic-projectile")) {
      return;
    }
    const size = BASIC_PROJECTILE_RADIUS * 2;
    const graphics = this.add.graphics();
    graphics.fillStyle(0xff6b4a, 1);
    graphics.fillCircle(BASIC_PROJECTILE_RADIUS, BASIC_PROJECTILE_RADIUS, BASIC_PROJECTILE_RADIUS);
    graphics.generateTexture("basic-projectile", size, size);
    graphics.destroy();
  }
}
