import Phaser from "phaser";
import { DualSenseMap, isPadButtonDown } from "../input/DualSenseMap";
import { getAimMode, toggleAimMode } from "../config/settings";

const MIN_START_WAVE = 1;
const MAX_START_WAVE = 20;
const START_WAVE_REGISTRY_KEY = "startWave";

/**
 * The game's title screen, shown on boot and whenever the player backs out
 * from a Game Over. Starts MainScene on Enter/Space, a click on PLAY, or a
 * gamepad Cross press. Includes a start-wave stepper so a run can jump
 * straight into a later wave instead of always beginning at wave 1 - handy
 * for testing/demoing harder waves without playing through the early ones.
 * The wave stepper and aim-mode toggle are also reachable from a gamepad
 * (D-pad left/right and Triangle) so this screen doesn't require a mouse.
 */
export class TitleScene extends Phaser.Scene {
  private prevCrossHeld = false;
  private prevDpadLeftHeld = false;
  private prevDpadRightHeld = false;
  private prevTriangleHeld = false;
  private started = false;
  private startWave = MIN_START_WAVE;
  private startWaveText!: Phaser.GameObjects.Text;
  private aimModeText!: Phaser.GameObjects.Text;

  constructor() {
    super("TitleScene");
  }

  create(): void {
    const { width, height } = this.scale;
    this.started = false;
    this.prevCrossHeld = false;
    this.prevDpadLeftHeld = false;
    this.prevDpadRightHeld = false;
    this.prevTriangleHeld = false;
    // Remembers the last-picked wave across visits to this screen (e.g. after a
    // Game Over -> Main Menu trip), via Phaser's registry, since a fresh create()
    // call would otherwise reset a plain instance field back to its default.
    this.startWave = this.registry.get(START_WAVE_REGISTRY_KEY) ?? MIN_START_WAVE;

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

    this.createWaveStepper(width / 2, height / 2 + 170);
    this.createAimModeToggle(width / 2, height / 2 + 210);

    this.add
      .text(width / 2, height / 2 + 245, "Arrows / D-Pad to adjust wave · Triangle to change aim", {
        fontFamily: "monospace",
        fontSize: "11px",
        color: "#4a4a5a",
      })
      .setOrigin(0.5);

    this.input.keyboard!.once("keydown-ENTER", () => this.startGame());
    this.input.keyboard!.once("keydown-SPACE", () => this.startGame());
    this.input.keyboard!.on("keydown-LEFT", () => this.adjustStartWave(-1));
    this.input.keyboard!.on("keydown-RIGHT", () => this.adjustStartWave(1));
  }

  update(): void {
    const pad = this.input.gamepad?.pad1;
    if (!pad) {
      return;
    }

    const crossHeld = isPadButtonDown(pad, DualSenseMap.CROSS);
    if (crossHeld && !this.prevCrossHeld) {
      this.startGame();
    }
    this.prevCrossHeld = crossHeld;

    const dpadLeftHeld = isPadButtonDown(pad, DualSenseMap.DPAD_LEFT);
    if (dpadLeftHeld && !this.prevDpadLeftHeld) {
      this.adjustStartWave(-1);
    }
    this.prevDpadLeftHeld = dpadLeftHeld;

    const dpadRightHeld = isPadButtonDown(pad, DualSenseMap.DPAD_RIGHT);
    if (dpadRightHeld && !this.prevDpadRightHeld) {
      this.adjustStartWave(1);
    }
    this.prevDpadRightHeld = dpadRightHeld;

    const triangleHeld = isPadButtonDown(pad, DualSenseMap.TRIANGLE);
    if (triangleHeld && !this.prevTriangleHeld) {
      toggleAimMode();
      this.refreshAimModeText();
    }
    this.prevTriangleHeld = triangleHeld;
  }

  private createWaveStepper(centerX: number, y: number): void {
    const minusButton = this.add
      .text(centerX - 110, y, "-", {
        fontFamily: "monospace",
        fontSize: "22px",
        color: "#59f2c8",
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    minusButton.on("pointerover", () => minusButton.setColor("#ffffff"));
    minusButton.on("pointerout", () => minusButton.setColor("#59f2c8"));
    minusButton.on("pointerdown", () => this.adjustStartWave(-1));

    this.startWaveText = this.add
      .text(centerX, y, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#e0e0f0",
      })
      .setOrigin(0.5);

    const plusButton = this.add
      .text(centerX + 110, y, "+", {
        fontFamily: "monospace",
        fontSize: "22px",
        color: "#59f2c8",
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    plusButton.on("pointerover", () => plusButton.setColor("#ffffff"));
    plusButton.on("pointerout", () => plusButton.setColor("#59f2c8"));
    plusButton.on("pointerdown", () => this.adjustStartWave(1));

    this.refreshStartWaveText();
  }

  /**
   * Cycles between the three aim modes (see settings.ts: free / virtualStick /
   * movement) on click. Persisted via settings.ts so it's remembered on the
   * next visit, not just this session.
   */
  private createAimModeToggle(centerX: number, y: number): void {
    this.aimModeText = this.add
      .text(centerX, y, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#59f2c8",
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.aimModeText.on("pointerover", () => this.aimModeText.setColor("#ffffff"));
    this.aimModeText.on("pointerout", () => this.aimModeText.setColor("#59f2c8"));
    this.aimModeText.on("pointerdown", () => {
      toggleAimMode();
      this.refreshAimModeText();
    });

    this.refreshAimModeText();
  }

  private refreshAimModeText(): void {
    const labels: Record<ReturnType<typeof getAimMode>, string> = {
      free: "AIM: FREE (STICK/MOUSE)",
      virtualStick: "AIM: VIRTUAL STICK (MOUSE)",
      movement: "AIM: MOVEMENT (KEYBOARD-ONLY)",
    };
    this.aimModeText.setText(`[ ${labels[getAimMode()]} ]`);
  }

  private adjustStartWave(delta: number): void {
    this.startWave = Phaser.Math.Clamp(this.startWave + delta, MIN_START_WAVE, MAX_START_WAVE);
    this.registry.set(START_WAVE_REGISTRY_KEY, this.startWave);
    this.refreshStartWaveText();
  }

  private refreshStartWaveText(): void {
    this.startWaveText.setText(`START WAVE: ${this.startWave}`);
  }

  private startGame(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.scene.start("MainScene", { startWave: this.startWave });
  }
}
