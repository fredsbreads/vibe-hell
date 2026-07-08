import Phaser from "phaser";
import { DualSenseMap, isPadButtonDown } from "../input/DualSenseMap";
import { TitleBackground } from "../timeMode/TitleBackground";

const FOCUS_COLOR = "#ffe98a";

/** Minimal title screen for the time-dilation mode - just PLAY, no wave stepper (there are no waves in an endless-only first pass). */
export class TimeTitleScene extends Phaser.Scene {
  private prevCrossHeld = false;
  private playButton!: Phaser.GameObjects.Text;
  private titleBackground!: TitleBackground;

  constructor() {
    super("TimeTitleScene");
  }

  create(): void {
    const { width, height } = this.scale;

    const pad = this.input.gamepad?.pad1;
    this.prevCrossHeld = isPadButtonDown(pad, DualSenseMap.CROSS);

    this.titleBackground = new TitleBackground(this);

    this.add
      .text(width / 2, height / 2 - 80, "VIBE HELL", {
        fontFamily: "monospace",
        fontSize: "48px",
        color: "#59f2c8",
      })
      .setOrigin(0.5);

    this.playButton = this.add
      .text(width / 2, height / 2 + 40, "PLAY", {
        fontFamily: "monospace",
        fontSize: "28px",
        color: FOCUS_COLOR,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.playButton.on("pointerdown", () => this.startGame());

    this.input.keyboard!.once("keydown-ENTER", () => this.startGame());
    this.input.keyboard!.once("keydown-SPACE", () => this.startGame());
  }

  update(_time: number, delta: number): void {
    this.titleBackground.update(delta);

    const pad = this.input.gamepad?.pad1;
    if (!pad) {
      return;
    }
    const crossHeld = isPadButtonDown(pad, DualSenseMap.CROSS);
    if (crossHeld && !this.prevCrossHeld) {
      this.startGame();
    }
    this.prevCrossHeld = crossHeld;
  }

  private startGame(): void {
    this.scene.start("TimeMainScene");
  }
}
