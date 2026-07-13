import Phaser from "phaser";

export interface MenuButton {
  label: string;
  onSelect: () => void;
  /**
   * Called with -1 (left) or 1 (right) when this button is focused and the
   * player presses D-Pad/stick/arrow-key left or right - for a button that
   * represents an adjustable value (e.g. a numeric setting cycled through a
   * fixed list) rather than a plain one-shot action. Optional: a button
   * without this simply ignores left/right (see adjustFocused()).
   */
  onAdjust?: (direction: -1 | 1) => void;
}

type Layout = "center" | "corner";

const BACKDROP_DEPTH = 20;
const TEXT_DEPTH = 21;
// Minimum screen-pixel movement between frames to count as "the mouse was just
// used" - otherwise a cursor merely resting over a button (e.g. left over from
// an earlier click, while the player has since switched to keyboard/gamepad)
// would keep re-stealing focus back onto itself every frame. Deliberately
// generous (not just enough to filter float jitter): small incidental cursor
// drift - a twitchy trackpad, an OS accessibility nudge, anything short of
// actually aiming at a different button - shouldn't be able to silently steal
// focus away from a deliberate D-pad/stick navigation. Buttons are 44px apart,
// so genuine mouse movement toward a different one clears this easily.
const MOUSE_MOVE_THRESHOLD = 24;
// How long after a menu opens to ignore mouse-hover focus-stealing entirely.
// A menu can appear mid-motion (dying or pausing while actively sweeping the
// mouse to aim), and that residual motion continuing for a frame or two
// afterward easily clears MOUSE_MOVE_THRESHOLD on its own - long enough to
// let that settle, short enough that deliberately moving the mouse to a
// button still feels instant.
const HOVER_GRACE_MS = 300;

/** Top-left anchor for the "corner" layout - below the top HUD row (status/score/timescale text all sit at y=12). */
const CORNER_X = 16;
const CORNER_Y = 90;
const CORNER_BUTTON_SPACING = 30;
/** Padding around the corner layout's tight-fit backdrop, so it doesn't hug the text edge-to-edge. */
const CORNER_BACKDROP_PADDING = 14;

/**
 * A reusable dimmed overlay with a title, optional subtitle, and a vertical
 * stack of clickable text buttons. Shared by the pause and Game Over screens
 * rather than duplicating the same backdrop/title/button construction twice.
 *
 * Supports two layouts (see show()'s layout param): "center" is the original
 * full-screen-dimmed, screen-centered presentation (pause, options, main
 * menu). "corner" is a small tight-fit panel in the top-left instead, sized
 * to just its own content rather than the whole screen - for a menu that
 * needs to stay out of the way of something still happening behind it (the
 * death replay loops continuously behind the Game Over menu, and a
 * full-screen dim would hide it).
 */
export class MenuOverlay {
  private readonly scene: Phaser.Scene;
  private readonly centerX: number;
  private readonly centerY: number;
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
  private hoverGraceRemainingMs = 0;

  constructor(scene: Phaser.Scene, width: number, height: number) {
    this.scene = scene;
    this.centerX = width / 2;
    this.centerY = height / 2;

    this.backdrop = scene.add.rectangle(this.centerX, this.centerY, width, height, 0x000000, 0.65).setDepth(BACKDROP_DEPTH);
    this.titleText = scene.add
      .text(this.centerX, this.centerY - 70, "", {
        fontFamily: "monospace",
        fontSize: "32px",
        color: "#ffe98a",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(TEXT_DEPTH);
    this.subtitleText = scene.add
      .text(this.centerX, this.centerY - 20, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#e0e0f0",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(TEXT_DEPTH);

    this.hide();
  }

  /**
   * preserveFocus keeps whatever button index was already highlighted
   * instead of resetting to 0 - pass true when re-showing the SAME menu
   * after one of its own buttons changed something about itself (a toggle,
   * or a value stepped via onAdjust), so pressing D-Pad right several times
   * in a row to step through a value keeps landing on that same button
   * instead of silently losing focus back to button 0 after the first
   * press. Leave it false (the default) when opening a genuinely different
   * menu, where starting back at the top is what you'd expect.
   */
  show(title: string, subtitle: string, buttons: MenuButton[], layout: Layout = "center", preserveFocus = false): void {
    this.destroyButtons();

    this.backdrop.setVisible(true);
    this.titleText.setVisible(true).setText(title);
    this.subtitleText.setVisible(subtitle.length > 0).setText(subtitle);

    this.buttons = buttons;
    if (!preserveFocus || this.focusedIndex >= buttons.length) {
      this.focusedIndex = 0;
    }
    // Reset so the cursor's current resting position (e.g. left over from the
    // click that opened this menu) doesn't immediately register as "mouse
    // just moved" on the very first update() and steal focus off button 0.
    this.prevPointerX = null;
    this.prevPointerY = null;
    this.hoverGraceRemainingMs = HOVER_GRACE_MS;

    if (layout === "corner") {
      this.layoutCorner(subtitle, buttons);
    } else {
      this.layoutCenter(subtitle, buttons);
    }
  }

  private layoutCenter(subtitle: string, buttons: MenuButton[]): void {
    this.titleText.setOrigin(0.5).setFontSize(32).setPosition(this.centerX, this.centerY - 70);
    this.subtitleText.setOrigin(0.5).setFontSize(16).setPosition(this.centerX, this.centerY - 20);
    this.backdrop.setPosition(this.centerX, this.centerY).setSize(this.scene.scale.width, this.scene.scale.height).setFillStyle(0x000000, 0.65);

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

  /** Small top-left panel sized to just its own content, so whatever's happening on the rest of the screen (the death replay) stays visible around it. */
  private layoutCorner(subtitle: string, buttons: MenuButton[]): void {
    this.titleText.setOrigin(0, 0.5).setFontSize(20).setPosition(CORNER_X, CORNER_Y);
    let nextY = CORNER_Y + CORNER_BUTTON_SPACING;
    this.subtitleText.setOrigin(0, 0.5).setFontSize(13).setPosition(CORNER_X, nextY);
    if (subtitle.length > 0) {
      nextY += CORNER_BUTTON_SPACING;
    }

    buttons.forEach((button, i) => {
      const text = this.scene.add
        .text(CORNER_X, nextY + i * CORNER_BUTTON_SPACING, button.label, {
          fontFamily: "monospace",
          fontSize: "16px",
          color: "#59f2c8",
        })
        .setOrigin(0, 0.5)
        .setDepth(TEXT_DEPTH)
        .setInteractive({ useHandCursor: true });
      text.on("pointerdown", () => button.onSelect());
      this.buttonTexts.push(text);
    });

    const parts: Phaser.GameObjects.Text[] = [this.titleText];
    if (subtitle.length > 0) {
      parts.push(this.subtitleText);
    }
    parts.push(...this.buttonTexts);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const part of parts) {
      const b = part.getBounds();
      minX = Math.min(minX, b.left);
      minY = Math.min(minY, b.top);
      maxX = Math.max(maxX, b.right);
      maxY = Math.max(maxY, b.bottom);
    }
    minX -= CORNER_BACKDROP_PADDING;
    minY -= CORNER_BACKDROP_PADDING;
    maxX += CORNER_BACKDROP_PADDING;
    maxY += CORNER_BACKDROP_PADDING;
    this.backdrop
      .setPosition((minX + maxX) / 2, (minY + maxY) / 2)
      .setSize(maxX - minX, maxY - minY)
      .setFillStyle(0x000000, 0.6);
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

  /** Adjusts whichever button is currently highlighted, if it supports it (see MenuButton.onAdjust) - a no-op for buttons that don't. */
  adjustFocused(direction: -1 | 1): void {
    this.buttons[this.focusedIndex]?.onAdjust?.(direction);
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
   * by re-claiming focus back onto itself every single frame. Also entirely
   * suppressed for HOVER_GRACE_MS right after the menu opens - a menu can
   * appear mid-motion (dying or pausing while actively sweeping the mouse to
   * aim), and that residual motion continuing for a frame or two afterward
   * easily clears MOUSE_MOVE_THRESHOLD on its own, stealing focus off the
   * intended default option before the player had any chance to react.
   */
  update(delta: number): void {
    if (this.buttonTexts.length === 0) {
      return;
    }
    if (this.hoverGraceRemainingMs > 0) {
      this.hoverGraceRemainingMs -= delta;
    }
    const pointer = this.scene.input.activePointer;
    const mouseMoved =
      this.hoverGraceRemainingMs <= 0 &&
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
      text.setColor(i === this.focusedIndex ? "#ffe98a" : "#59f2c8");
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
