import Phaser from "phaser";
import { Player } from "../entities/Player";
import { ProjectileManager, SAFE_LANE_ARC_RADIANS } from "../managers/ProjectileManager";
import { WaveManager } from "../managers/WaveManager";
import { ArenaBounds, ARENA_RADIUS } from "../config/arena";
import { BASIC_PROJECTILE_RADIUS } from "../entities/projectiles/BasicProjectile";
import { ZOOMER_PROJECTILE_RADIUS } from "../entities/projectiles/ZoomerProjectile";
import { STOP_WAVE_RADIUS } from "../entities/projectiles/StopWaveProjectile";
import { CHASER_PROJECTILE_RADIUS } from "../entities/projectiles/ChaserProjectile";

export class MainScene extends Phaser.Scene {
  private player!: Player;
  private projectileManager!: ProjectileManager;
  private waveManager!: WaveManager;
  private arena!: ArenaBounds;

  private threatsEndured = 0;
  private threatsText!: Phaser.GameObjects.Text;
  private debugText!: Phaser.GameObjects.Text;
  private safeLaneGraphic!: Phaser.GameObjects.Graphics;
  private waveText!: Phaser.GameObjects.Text;
  private waveBannerText!: Phaser.GameObjects.Text;

  constructor() {
    super("MainScene");
  }

  create(): void {
    const { width, height } = this.scale;
    this.arena = { centerX: width / 2, centerY: height / 2, radius: ARENA_RADIUS };

    this.generateCircleTexture("player", Player.RADIUS, 0x59f2c8);
    this.generateCircleTexture("basic-projectile", BASIC_PROJECTILE_RADIUS, 0xff6b4a);
    this.generateCircleTexture("zoomer-projectile", ZOOMER_PROJECTILE_RADIUS, 0xf2e85c);
    this.generateCircleTexture("stopwave-projectile", STOP_WAVE_RADIUS, 0x5c8df2);
    this.generateCircleTexture("chaser-projectile", CHASER_PROJECTILE_RADIUS, 0xd35cf2);

    this.add
      .circle(this.arena.centerX, this.arena.centerY, this.arena.radius, 0x1a1a2e)
      .setStrokeStyle(4, 0x4a4a6a);

    this.safeLaneGraphic = this.add.graphics();

    this.player = new Player(this, this.arena.centerX, this.arena.centerY, this.arena);
    this.projectileManager = new ProjectileManager(this, this.arena);
    this.waveManager = new WaveManager(this.projectileManager);

    this.threatsText = this.add
      .text(width - 12, 12, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#e0e0f0",
      })
      .setOrigin(1, 0);

    this.waveText = this.add
      .text(width / 2, 12, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#e0e0f0",
      })
      .setOrigin(0.5, 0);

    this.waveBannerText = this.add
      .text(this.arena.centerX, this.arena.centerY, "", {
        fontFamily: "monospace",
        fontSize: "36px",
        color: "#ffe98a",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(10);

    this.debugText = this.add
      .text(width - 12, height - 12, "", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#8a8aa0",
        align: "right",
      })
      .setOrigin(1, 1);

    this.setupDebugSpawnToggles();
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

    // Stop Waves are a hard counter: checked unconditionally, bypassing dash i-frames.
    const stopWaveHits = this.projectileManager.checkStopWaveCollisions(
      this.player.sprite.x,
      this.player.sprite.y,
      Player.RADIUS,
    );
    if (stopWaveHits > 0) {
      this.player.interruptDashAndDamage(stopWaveHits);
    }

    this.waveManager.update(delta);

    this.threatsText.setText(`THREATS ENDURED: ${this.threatsEndured}`);
    this.updateDebugText();
    this.updateWaveUi();
    this.redrawSafeLane();
  }

  /** "WAVE X" + time remaining while active; a "WAVE X COMPLETE" banner during the Breather Window intermission. */
  private updateWaveUi(): void {
    const secondsLeft = Math.max(0, Math.ceil(this.waveManager.phaseTimeRemainingMs / 1000));

    if (this.waveManager.phase === "active") {
      this.waveText.setText(`WAVE ${this.waveManager.currentWave}   ${secondsLeft}s`);
      this.waveBannerText.setText("");
    } else {
      this.waveText.setText(`WAVE ${this.waveManager.currentWave} COMPLETE`);
      this.waveBannerText.setText(`WAVE ${this.waveManager.currentWave} COMPLETE\nnext wave in ${secondsLeft}s`);
    }
  }

  /** Renders the Safe Lane Volley Rule's guaranteed-empty arc on the arena wall, so it's an actual visible lane, not just an internal rule. */
  private redrawSafeLane(): void {
    const center = this.projectileManager.safeLaneCenterAngle;
    const half = SAFE_LANE_ARC_RADIANS / 2;

    this.safeLaneGraphic.clear();
    this.safeLaneGraphic.lineStyle(6, 0x59f2c8, 0.3);
    this.safeLaneGraphic.beginPath();
    this.safeLaneGraphic.arc(this.arena.centerX, this.arena.centerY, this.arena.radius, center - half, center + half);
    this.safeLaneGraphic.strokePath();
  }

  /** Debug-only: number keys manually toggle each threat type's spawning on and off for isolated verification. */
  private setupDebugSpawnToggles(): void {
    this.input.keyboard!.on("keydown-ONE", () => {
      this.projectileManager.setZoomerSpawningEnabled(!this.projectileManager.isZoomerSpawningEnabled);
    });
    this.input.keyboard!.on("keydown-TWO", () => {
      this.projectileManager.setStopWaveSpawningEnabled(!this.projectileManager.isStopWaveSpawningEnabled);
    });
    this.input.keyboard!.on("keydown-THREE", () => {
      this.projectileManager.setChaserSpawningEnabled(!this.projectileManager.isChaserSpawningEnabled);
    });
  }

  private updateDebugText(): void {
    const zoomerState = this.projectileManager.isZoomerSpawningEnabled ? "ON" : "off";
    const stopWaveState = this.projectileManager.isStopWaveSpawningEnabled ? "ON" : "off";
    const chaserState = this.projectileManager.isChaserSpawningEnabled ? "ON" : "off";
    this.debugText.setText(
      `[DEBUG] 1: Zoomer ${zoomerState}   2: Stop Wave ${stopWaveState}   3: Chaser ${chaserState}`,
    );
  }

  private generateCircleTexture(key: string, radius: number, color: number): void {
    if (this.textures.exists(key)) {
      return;
    }
    const size = radius * 2;
    const graphics = this.add.graphics();
    graphics.fillStyle(color, 1);
    graphics.fillCircle(radius, radius, radius);
    graphics.generateTexture(key, size, size);
    graphics.destroy();
  }
}
