import Phaser from "phaser";

/**
 * Button/axis indices for the W3C Standard Gamepad mapping, which Chrome/Edge
 * report for a DualSense controller (same layout as the DualShock 4 config
 * Phaser ships with). Referenced directly since Phaser has no DualSense config.
 */
export const DualSenseMap = {
  CROSS: 0,
  CIRCLE: 1,
  SQUARE: 2,
  TRIANGLE: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  SHARE: 8,
  OPTIONS: 9,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
} as const;

/**
 * Phaser's Gamepad.isButtonDown()/getButtonValue() index straight into the
 * buttons array with no bounds check, so they throw if the browser's gamepad
 * mapping doesn't populate that index - not every browser/OS/controller-driver
 * combination reports every W3C-standard button (D-pad indices 12-15
 * especially vary), and an uncaught throw here happens inside the scene's
 * update() loop, which silently kills all further per-frame processing -
 * looking exactly like the whole page "froze", clicks included. These wrap
 * every gamepad button read in the game so a partially-reported pad degrades
 * to "that button just isn't seen" instead of crashing the game loop.
 */
export function isPadButtonDown(pad: Phaser.Input.Gamepad.Gamepad | undefined, index: number): boolean {
  return !!pad && index < pad.buttons.length && pad.isButtonDown(index);
}

export function getPadButtonValue(pad: Phaser.Input.Gamepad.Gamepad | undefined, index: number): number {
  return pad && index < pad.buttons.length ? pad.getButtonValue(index) : 0;
}
