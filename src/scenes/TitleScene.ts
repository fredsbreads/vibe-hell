import Phaser from "phaser";
import { DualSenseMap } from "../input/DualSenseMap";

/**
 * The game's title screen, shown on boot and whenever the player backs out
 * from a Game Over. Starts MainScene on Enter/Space, a click on PLAY, or a
 * gamepad Cross press.
 */
export class TitleScene extends Phaser.Scene {
  private prevCrossHeld = false;
  private started = false;

  constructor() {
    super("TitleScene");
  }

  create(): void {
    const { width, height } = this.scale;
    this.started = false;
    this.prevCrossHeld = false;

    this.add
      .text(width / 2, height / 2 - 80, "VIBE HELL", {
        fontFamily: "monospace",
        fontSize: "56px",
        color: "#59f2c8",
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, height / 2 - 20, "twin-stick bullet hell", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#8a8aa0",
      })
      .setOrigin(0.5);

    const playButton = this.add
      .text(width / 2, height / 2 + 60, "PLAY", {
        fontFamily: "monospace",
        fontSize: "28px",
        color: "#ffe98a",
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    playButton.on("pointerover", () => playButton.setColor("#ffffff"));
    playButton.on("pointerout", () => playButton.setColor("#ffe98a"));
    playButton.on("pointerdown", () => this.startGame());

    this.add
      .text(width / 2, height / 2 + 110, "Enter / Click / Cross to start", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#6a6a80",
      })
      .setOrigin(0.5);

    this.input.keyboard!.once("keydown-ENTER", () => this.startGame());
    this.input.keyboard!.once("keydown-SPACE", () => this.startGame());
  }

  update(): void {
    const pad = this.input.gamepad?.pad1;
    if (!pad) {
      return;
    }
    const crossHeld = pad.isButtonDown(DualSenseMap.CROSS);
    if (crossHeld && !this.prevCrossHeld) {
      this.startGame();
    }
    this.prevCrossHeld = crossHeld;
  }

  private startGame(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.scene.start("MainScene");
  }
}
