import Phaser from "phaser";

export interface MenuButton {
  label: string;
  onSelect: () => void;
}

const BACKDROP_DEPTH = 20;
const TEXT_DEPTH = 21;

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

  /**
   * Re-derives each button's hover color from the pointer's current position
   * every frame, rather than trusting Phaser's pointerover/pointerout events
   * alone. Those events only fire on an actual pointermove/pointerdown - if
   * the browser drops one (tab loses focus mid-hover, a fast physical mouse
   * flick coalesced into one big jump, buttons destroyed and recreated at the
   * same spot under a stationary cursor, etc.) a button can end up stuck
   * showing the hover color with no future event left to correct it. Polling
   * the pointer position instead makes the highlight self-correcting - it can
   * never be more than one frame stale.
   */
  update(): void {
    if (this.buttonTexts.length === 0) {
      return;
    }
    const pointer = this.scene.input.activePointer;
    for (const text of this.buttonTexts) {
      const hovered = text.getBounds().contains(pointer.x, pointer.y);
      text.setColor(hovered ? "#ffffff" : "#59f2c8");
    }
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
  }
}
