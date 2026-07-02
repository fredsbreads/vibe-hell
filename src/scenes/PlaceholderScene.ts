import Phaser from "phaser";

export class PlaceholderScene extends Phaser.Scene {
  constructor() {
    super("PlaceholderScene");
  }

  create(): void {
    const { width, height } = this.scale;

    this.add
      .circle(width / 2, height / 2, 300, 0x1a1a2e)
      .setStrokeStyle(4, 0x4a4a6a);

    this.add
      .text(width / 2, height / 2, "VIBE HELL\nproject scaffold ready", {
        fontFamily: "monospace",
        fontSize: "24px",
        color: "#e0e0f0",
        align: "center",
      })
      .setOrigin(0.5);
  }
}
