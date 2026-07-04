import Phaser from "phaser";

export interface MenuButton {
  label: string;
  onSelect: () => void;
}

const BACKDROP_DEPTH = 20;
const TEXT_DEPTH = 21;
// Minimum screen-pixel movement between frames to count as "the mouse was just
// used" - otherwise a cursor merely resting over a button (e.g. left over from
// an earlier click, while the player has since switched to keyboard/gamepad)
// would keep re-stealing focus back onto itself every frame.
const MOUSE_MOVE_THRESHOLD = 2;

/**
 * A reusable full-screen dimmed overlay with a title, optional subtitle, and
 * a vertical stack of clickable text buttons. Shared by the pause and Game
 * Over screens rather than duplicating the same backdrop/title/button
 * construction twice.
 */
export class MenuOverlay {
  private readonly scene: Phaser.Scene;
  private readonly centerX: number;
  private readonly backdrop: Phaser.GameObjects.Rectangle;
  private readonly titleText: Phaser.GameObjects.Text;
  private readonly subtitleText: Phaser.GameObjects.Text;
  private buttonTexts: Phaser.GameObjects.Text[] = [];
  private buttons: MenuButton[] = [];
  /**
   * Which button is currently highlighted - the single source of truth for
   * both mouse hover and keyboard/gamepad up-down navigation, so a controller
   * user sees exactly the same highlight a mouse user would get by hovering,
   * and moving the mouse re-syncs focus back to whatever it's over.
   */
  private focusedIndex = 0;
  private prevPointerX: number | null = null;
  private prevPointerY: number | null = null;

  constructor(scene: Phaser.Scene, width: number, height: number) {
    this.scene = scene;
    this.centerX = width / 2;
    const centerY = height / 2;

    this.backdrop = scene.add.rectangle(this.centerX, centerY, width, height, 0x000000, 0.65).setDepth(BACKDROP_DEPTH);
    this.titleText = scene.add
      .text(this.centerX, centerY - 70, "", {
        fontFamily: "monospace",
        fontSize: "32px",
        color: "#ffe98a",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(TEXT_DEPTH);
    this.subtitleText = scene.add
      .text(this.centerX, centerY - 20, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#e0e0f0",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(TEXT_DEPTH);

    this.hide();
  }

  show(title: string, subtitle: string, buttons: MenuButton[]): void {
    this.destroyButtons();

    this.backdrop.setVisible(true);
    this.titleText.setVisible(true).setText(title);
    this.subtitleText.setVisible(subtitle.length > 0).setText(subtitle);

    this.buttons = buttons;
    this.focusedIndex = 0;
    // Reset so the cursor's current resting position (e.g. left over from the
    // click that opened this menu) doesn't immediately register as "mouse
    // just moved" on the very first update() and steal focus off button 0.
    this.prevPointerX = null;
    this.prevPointerY = null;

    const startY = this.subtitleText.y + (subtitle.length > 0 ? 50 : 30);
    buttons.forEach((button, i) => {
      const text = this.scene.add
        .text(this.centerX, startY + i * 44, button.label, {
          fontFamily: "monospace",
          fontSize: "22px",
          color: "#59f2c8",
        })
        .setOrigin(0.5)
        .setDepth(TEXT_DEPTH)
        .setInteractive({ useHandCursor: true });

      text.on("pointerdown", () => button.onSelect());

      this.buttonTexts.push(text);
    });
  }

  /** Moves the highlighted button by delta (wrapping), for keyboard/gamepad up-down navigation. */
  moveFocus(delta: number): void {
    const count = this.buttonTexts.length;
    if (count === 0) {
      return;
    }
    this.focusedIndex = ((this.focusedIndex + delta) % count + count) % count;
  }

  /** Activates whichever button is currently highlighted, same as clicking it. */
  confirmFocused(): void {
    this.buttons[this.focusedIndex]?.onSelect();
  }

  /**
   * Re-derives the highlight from the pointer's current position every frame,
   * rather than trusting Phaser's pointerover/pointerout events alone - those
   * only fire on an actual pointermove/pointerdown, so a browser-dropped event
   * (tab loses focus mid-hover, a fast mouse flick coalesced into one big
   * jump, buttons recreated under a stationary cursor, etc.) could otherwise
   * leave a button stuck showing the hover color with nothing left to correct
   * it. Hovering only steals focus if the mouse actually moved this frame -
   * otherwise a cursor merely resting over some button (left over from
   * whatever click opened this menu) would fight keyboard/gamepad navigation
   * by re-claiming focus back onto itself every single frame.
   */
  update(): void {
    if (this.buttonTexts.length === 0) {
      return;
    }
    const pointer = this.scene.input.activePointer;
    const mouseMoved =
      this.prevPointerX !== null &&
      this.prevPointerY !== null &&
      (Math.abs(pointer.x - this.prevPointerX) > MOUSE_MOVE_THRESHOLD ||
        Math.abs(pointer.y - this.prevPointerY) > MOUSE_MOVE_THRESHOLD);
    this.prevPointerX = pointer.x;
    this.prevPointerY = pointer.y;

    if (mouseMoved) {
      this.buttonTexts.forEach((text, i) => {
        if (text.getBounds().contains(pointer.x, pointer.y)) {
          this.focusedIndex = i;
        }
      });
    }
    this.buttonTexts.forEach((text, i) => {
      text.setColor(i === this.focusedIndex ? "#ffffff" : "#59f2c8");
    });
  }

  hide(): void {
    this.backdrop.setVisible(false);
    this.titleText.setVisible(false);
    this.subtitleText.setVisible(false);
    this.destroyButtons();
  }

  private destroyButtons(): void {
    for (const text of this.buttonTexts) {
      text.destroy();
    }
    this.buttonTexts = [];
    this.buttons = [];
  }
}
