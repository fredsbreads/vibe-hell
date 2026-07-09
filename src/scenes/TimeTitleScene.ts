import Phaser from "phaser";
import { DualSenseMap, isPadButtonDown, getPadButtonValue } from "../input/DualSenseMap";
import { TitleBackground } from "../timeMode/TitleBackground";
import { MenuOverlay } from "../ui/MenuOverlay";
import { getShowSlashRangeIndicator, setShowSlashRangeIndicator } from "../config/settings";

const FOCUS_COLOR = "#ffe98a";
/** Matches PlayerInput's own trigger threshold - R2 is analog, so "pressed" means past this value, not just nonzero. */
const TRIGGER_THRESHOLD = 0.5;

/** Minimal title screen for the time-dilation mode - PLAY plus an OPTIONS screen (currently just the Slash-range-indicator toggle), no wave stepper (there are no waves in an endless-only first pass). */
export class TimeTitleScene extends Phaser.Scene {
  private titleBackground!: TitleBackground;
  private menuOverlay!: MenuOverlay;
  private titleText!: Phaser.GameObjects.Text;
  private playButton!: Phaser.GameObjects.Text;
  private optionsButton!: Phaser.GameObjects.Text;

  /** True while the OPTIONS overlay is up - gates the bare title screen's own shortcuts (Enter/Space/Cross/R2 starting the game) so they don't fire while a submenu is open. */
  private optionsOpen = false;

  private escKey!: Phaser.Input.Keyboard.Key;
  private confirmKey!: Phaser.Input.Keyboard.Key;
  private spaceKey!: Phaser.Input.Keyboard.Key;
  private optionsKey!: Phaser.Input.Keyboard.Key;
  private menuUpKey!: Phaser.Input.Keyboard.Key;
  private menuDownKey!: Phaser.Input.Keyboard.Key;
  private prevEscHeld = false;
  private prevConfirmHeld = false;
  private prevOptionsKeyHeld = false;
  private prevMenuUpHeld = false;
  private prevMenuDownHeld = false;

  constructor() {
    super("TimeTitleScene");
  }

  create(): void {
    const { width, height } = this.scale;

    this.titleBackground = new TitleBackground(this);

    this.titleText = this.add
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

    this.optionsButton = this.add
      .text(width / 2, height / 2 + 90, "OPTIONS", {
        fontFamily: "monospace",
        fontSize: "18px",
        color: "#59f2c8",
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.optionsButton.on("pointerdown", () => this.openOptions());

    this.menuOverlay = new MenuOverlay(this, width, height);

    this.escKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.confirmKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
    this.spaceKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.optionsKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.O);
    this.menuUpKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    this.menuDownKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);

    const pad = this.input.gamepad?.pad1;
    this.prevConfirmHeld = this.readConfirmHeld(pad);
    this.prevEscHeld = this.readEscHeld(pad);
    this.prevOptionsKeyHeld = this.optionsKey.isDown || isPadButtonDown(pad, DualSenseMap.TRIANGLE);
  }

  update(_time: number, delta: number): void {
    this.titleBackground.update(delta);
    this.menuOverlay.update(delta);

    const pad = this.input.gamepad?.pad1;
    const confirmHeld = this.readConfirmHeld(pad);
    const confirmPressed = confirmHeld && !this.prevConfirmHeld;
    this.prevConfirmHeld = confirmHeld;

    const escHeld = this.readEscHeld(pad);
    const escPressed = escHeld && !this.prevEscHeld;
    this.prevEscHeld = escHeld;

    if (this.optionsOpen) {
      const stickY = pad?.leftStick.y ?? 0;
      const upHeld = this.menuUpKey.isDown || isPadButtonDown(pad, DualSenseMap.DPAD_UP) || stickY < -0.5;
      const upPressed = upHeld && !this.prevMenuUpHeld;
      this.prevMenuUpHeld = upHeld;
      if (upPressed) {
        this.menuOverlay.moveFocus(-1);
      }

      const downHeld = this.menuDownKey.isDown || isPadButtonDown(pad, DualSenseMap.DPAD_DOWN) || stickY > 0.5;
      const downPressed = downHeld && !this.prevMenuDownHeld;
      this.prevMenuDownHeld = downHeld;
      if (downPressed) {
        this.menuOverlay.moveFocus(1);
      }

      if (confirmPressed) {
        this.menuOverlay.confirmFocused();
      }
      if (escPressed) {
        this.closeOptions();
      }
      return;
    }

    if (confirmPressed) {
      this.startGame();
      return;
    }

    const optionsKeyHeld = this.optionsKey.isDown || isPadButtonDown(pad, DualSenseMap.TRIANGLE);
    const optionsKeyPressed = optionsKeyHeld && !this.prevOptionsKeyHeld;
    this.prevOptionsKeyHeld = optionsKeyHeld;
    if (optionsKeyPressed) {
      this.openOptions();
    }
  }

  private readConfirmHeld(pad: Phaser.Input.Gamepad.Gamepad | undefined): boolean {
    return (
      this.confirmKey.isDown ||
      this.spaceKey.isDown ||
      isPadButtonDown(pad, DualSenseMap.CROSS) ||
      getPadButtonValue(pad, DualSenseMap.R2) > TRIGGER_THRESHOLD
    );
  }

  private readEscHeld(pad: Phaser.Input.Gamepad.Gamepad | undefined): boolean {
    return this.escKey.isDown || isPadButtonDown(pad, DualSenseMap.OPTIONS) || isPadButtonDown(pad, DualSenseMap.CIRCLE);
  }

  private openOptions(): void {
    this.optionsOpen = true;
    this.titleText.setVisible(false);
    this.playButton.setVisible(false);
    this.optionsButton.setVisible(false);
    const pad = this.input.gamepad?.pad1;
    const stickY = pad?.leftStick.y ?? 0;
    // Resync so whatever button opened this (Enter/O/Triangle) doesn't also
    // immediately register as the first up/down/confirm inside the menu.
    this.prevMenuUpHeld = this.menuUpKey.isDown || isPadButtonDown(pad, DualSenseMap.DPAD_UP) || stickY < -0.5;
    this.prevMenuDownHeld = this.menuDownKey.isDown || isPadButtonDown(pad, DualSenseMap.DPAD_DOWN) || stickY > 0.5;
    this.prevConfirmHeld = this.readConfirmHeld(pad);
    this.showOptionsMenu();
  }

  private showOptionsMenu(): void {
    this.menuOverlay.show("OPTIONS", "", [
      {
        label: `SLASH RANGE INDICATOR: ${getShowSlashRangeIndicator() ? "ON" : "OFF"}`,
        onSelect: () => {
          setShowSlashRangeIndicator(!getShowSlashRangeIndicator());
          this.showOptionsMenu();
        },
      },
      { label: "BACK", onSelect: () => this.closeOptions() },
    ]);
  }

  private closeOptions(): void {
    this.optionsOpen = false;
    this.menuOverlay.hide();
    this.titleText.setVisible(true);
    this.playButton.setVisible(true);
    this.optionsButton.setVisible(true);
  }

  private startGame(): void {
    this.scene.start("TimeMainScene");
  }
}
