import Phaser from "phaser";
import { Player } from "../entities/Player";

export class MainScene extends Phaser.Scene {
  private player!: Player;

  constructor() {
    super("MainScene");
  }

  create(): void {
    const { width, height } = this.scale;

    this.generatePlayerTexture();

    this.add
      .circle(width / 2, height / 2, 300, 0x1a1a2e)
      .setStrokeStyle(4, 0x4a4a6a);

    this.player = new Player(this, width / 2, height / 2);
  }

  update(_time: number, delta: number): void {
    this.player.update(delta);
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
}
