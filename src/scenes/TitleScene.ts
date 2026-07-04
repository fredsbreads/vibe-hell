import Phaser from "phaser";
import { DualSenseMap, isPadButtonDown } from "../input/DualSenseMap";
import { getAimMode, cycleAimMode } from "../config/settings";

const MIN_START_WAVE = 1;
const MAX_START_WAVE = 20;
const START_WAVE_REGISTRY_KEY = "startWave";

/** How far the left stick must tilt to count as an Up/Down/Left/Right navigation press. */
const STICK_THRESHOLD = 0.5;

const FOCUS_COLOR = "#ffffff";
const UNFOCUSED_COLOR = "#59f2c8";

type FocusRow = 0 | 1;
const WAVE_ROW: FocusRow = 0;
const AIM_ROW: FocusRow = 1;
const ROW_COUNT = 2;

/**
 * The game's title screen, shown on boot and whenever the player backs out
 * from a Game Over. Starts MainScene on Enter/Space, a click on PLAY, or a
 * gamepad Cross press.
 *
 * Below PLAY sit two adjustable rows - the start-wave stepper (handy for
 * testing/demoing harder waves without playing through the early ones) and
 * the aim-mode toggle. Up/Down (arrow keys, D-pad, or the left stick) moves
 * a highlighted focus between these two rows, and Left/Right adjusts
 * whichever one is focused - the same "select a row, then adjust it"
 * pattern a console settings menu uses, rather than a fixed button doing a
 * fixed thing regardless of context.
 */
export class TitleScene extends Phaser.Scene {
  private prevCrossHeld = false;
  private prevDpadUpHeld = false;
  private prevDpadDownHeld = false;
  private prevDpadLeftHeld = false;
  private prevDpadRightHeld = false;
  private started = false;
  private startWave = MIN_START_WAVE;
  private focusedRow: FocusRow = WAVE_ROW;
  private startWaveText!: Phaser.GameObjects.Text;
  private aimModeText!: Phaser.GameObjects.Text;

  constructor() {
    super("TitleScene");
  }

  create(): void {
    const { width, height } = this.scale;
    this.started = false;
    this.focusedRow = WAVE_ROW;
    // Seed from whatever's ACTUALLY currently held, not blindly false - this
    // screen is frequently entered via a gamepad Cross press (confirming
    // "Main Menu" from the pause overlay, or Restart-then-Main-Menu), and
    // that same physical button can still be held for a frame or two after
    // the scene switch. Seeding prevCrossHeld to false in that situation
    // would read the still-held Cross as a brand new press and immediately
    // call startGame() again, bouncing straight back into a fresh run before
    // this screen ever had a chance to actually be looked at, let alone used.
    const pad = this.input.gamepad?.pad1;
    this.prevCrossHeld = isPadButtonDown(pad, DualSenseMap.CROSS);
    this.prevDpadUpHeld = isPadButtonDown(pad, DualSenseMap.DPAD_UP);
    this.prevDpadDownHeld = isPadButtonDown(pad, DualSenseMap.DPAD_DOWN);
    this.prevDpadLeftHeld = isPadButtonDown(pad, DualSenseMap.DPAD_LEFT);
    this.prevDpadRightHeld = isPadButtonDown(pad, DualSenseMap.DPAD_RIGHT);
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
      .text(width / 2, height / 2 + 245, "Up/Down to select · Left/Right to adjust", {
        fontFamily: "monospace",
        fontSize: "11px",
        color: "#4a4a5a",
      })
      .setOrigin(0.5);

    this.input.keyboard!.once("keydown-ENTER", () => this.startGame());
    this.input.keyboard!.once("keydown-SPACE", () => this.startGame());
    this.input.keyboard!.on("keydown-UP", () => this.moveFocus(-1));
    this.input.keyboard!.on("keydown-DOWN", () => this.moveFocus(1));
    this.input.keyboard!.on("keydown-LEFT", () => this.adjustFocusedRow(-1));
    this.input.keyboard!.on("keydown-RIGHT", () => this.adjustFocusedRow(1));

    this.refreshFocusHighlight();
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

    const dpadUpHeld = isPadButtonDown(pad, DualSenseMap.DPAD_UP) || pad.leftStick.y < -STICK_THRESHOLD;
    if (dpadUpHeld && !this.prevDpadUpHeld) {
      this.moveFocus(-1);
    }
    this.prevDpadUpHeld = dpadUpHeld;

    const dpadDownHeld = isPadButtonDown(pad, DualSenseMap.DPAD_DOWN) || pad.leftStick.y > STICK_THRESHOLD;
    if (dpadDownHeld && !this.prevDpadDownHeld) {
      this.moveFocus(1);
    }
    this.prevDpadDownHeld = dpadDownHeld;

    const dpadLeftHeld = isPadButtonDown(pad, DualSenseMap.DPAD_LEFT) || pad.leftStick.x < -STICK_THRESHOLD;
    if (dpadLeftHeld && !this.prevDpadLeftHeld) {
      this.adjustFocusedRow(-1);
    }
    this.prevDpadLeftHeld = dpadLeftHeld;

    const dpadRightHeld = isPadButtonDown(pad, DualSenseMap.DPAD_RIGHT) || pad.leftStick.x > STICK_THRESHOLD;
    if (dpadRightHeld && !this.prevDpadRightHeld) {
      this.adjustFocusedRow(1);
    }
    this.prevDpadRightHeld = dpadRightHeld;
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
    minusButton.on("pointerdown", () => {
      this.focusedRow = WAVE_ROW;
      this.adjustStartWave(-1);
    });

    this.startWaveText = this.add
      .text(centerX, y, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: UNFOCUSED_COLOR,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.startWaveText.on("pointerdown", () => {
      this.focusedRow = WAVE_ROW;
      this.refreshFocusHighlight();
    });

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
    plusButton.on("pointerdown", () => {
      this.focusedRow = WAVE_ROW;
      this.adjustStartWave(1);
    });

    this.refreshStartWaveText();
  }

  /**
   * Cycles between the three aim modes (see settings.ts: free / virtualStick /
   * movement) - Left/Right while this row is focused, or a click. Persisted
   * via settings.ts so it's remembered on the next visit, not just this
   * session.
   */
  private createAimModeToggle(centerX: number, y: number): void {
    this.aimModeText = this.add
      .text(centerX, y, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: UNFOCUSED_COLOR,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.aimModeText.on("pointerdown", () => {
      this.focusedRow = AIM_ROW;
      cycleAimMode(1);
      this.refreshAimModeText();
      this.refreshFocusHighlight();
    });

    this.refreshAimModeText();
  }

  private moveFocus(delta: number): void {
    this.focusedRow = (((this.focusedRow + delta) % ROW_COUNT) + ROW_COUNT) as FocusRow;
    this.refreshFocusHighlight();
  }

  private adjustFocusedRow(delta: 1 | -1): void {
    if (this.focusedRow === WAVE_ROW) {
      this.adjustStartWave(delta);
    } else {
      cycleAimMode(delta);
      this.refreshAimModeText();
    }
  }

  /** Colors whichever row is currently focused white, and the other row teal - mirrors the pause menu's highlight convention. */
  private refreshFocusHighlight(): void {
    this.startWaveText.setColor(this.focusedRow === WAVE_ROW ? FOCUS_COLOR : UNFOCUSED_COLOR);
    this.aimModeText.setColor(this.focusedRow === AIM_ROW ? FOCUS_COLOR : UNFOCUSED_COLOR);
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
