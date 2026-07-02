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
} as const;
