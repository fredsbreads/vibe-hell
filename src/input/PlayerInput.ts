import Phaser from "phaser";
import { DualSenseMap } from "./DualSenseMap";

const STICK_DEADZONE = 0.2;
const TRIGGER_THRESHOLD = 0.5;

export interface InputState {
  moveX: number;
  moveY: number;
  aimAngle: number;
  dashHeld: boolean;
  dashPressed: boolean;
  slashHeld: boolean;
  slashPressed: boolean;
}

function applyDeadzone(value: number, deadzone: number): number {
  return Math.abs(value) < deadzone ? 0 : value;
}

/**
 * Reads Left Stick / Right Stick / L2 / R2 / Cross / R1 from a connected
 * DualSense (via Phaser's Gamepad plugin, W3C Standard mapping). Falls back
 * to WASD + mouse aim + Space/J (and left-click/right-click as slash/dash
 * aliases) so the game is playable and testable in this environment without
 * physical controller hardware attached to the browser.
 */
export class PlayerInput {
  private readonly scene: Phaser.Scene;
  private readonly keys: Record<"up" | "down" | "left" | "right" | "dash" | "slash", Phaser.Input.Keyboard.Key>;
  private prevDashHeld = false;
  private prevSlashHeld = false;
  private lastAimAngle = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;

    const keyboard = scene.input.keyboard!;
    this.keys = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      dash: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      slash: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.J),
    };

    // Right-click doubles as dash, so stop it from popping the browser's context menu.
    scene.input.mouse?.disableContextMenu();
  }

  private get pad(): Phaser.Input.Gamepad.Gamepad | undefined {
    return this.scene.input.gamepad?.pad1 ?? undefined;
  }

  read(playerX: number, playerY: number): InputState {
    const pad = this.pad;

    let moveX = 0;
    let moveY = 0;
    let aimAngle = this.lastAimAngle;
    let dashHeld = false;
    let slashHeld = false;

    if (pad) {
      moveX = applyDeadzone(pad.leftStick.x, STICK_DEADZONE);
      moveY = applyDeadzone(pad.leftStick.y, STICK_DEADZONE);

      const aimX = applyDeadzone(pad.rightStick.x, STICK_DEADZONE);
      const aimY = applyDeadzone(pad.rightStick.y, STICK_DEADZONE);
      if (aimX !== 0 || aimY !== 0) {
        aimAngle = Math.atan2(aimY, aimX);
      }

      const l2Value = pad.getButtonValue(DualSenseMap.L2);
      const crossHeld = pad.isButtonDown(DualSenseMap.CROSS);
      dashHeld = l2Value > TRIGGER_THRESHOLD || crossHeld;

      const r2Value = pad.getButtonValue(DualSenseMap.R2);
      const r1Held = pad.isButtonDown(DualSenseMap.R1);
      slashHeld = r2Value > TRIGGER_THRESHOLD || r1Held;
    }

    if (moveX === 0 && moveY === 0) {
      const kx = (this.keys.right.isDown ? 1 : 0) - (this.keys.left.isDown ? 1 : 0);
      const ky = (this.keys.down.isDown ? 1 : 0) - (this.keys.up.isDown ? 1 : 0);
      moveX = kx;
      moveY = ky;
    }

    const pointer = this.scene.input.activePointer;

    // Mouse aim is only a fallback for when there's no gamepad at all - if a pad is
    // connected but its right stick is just resting in the deadzone, we should hold
    // the last stick-commanded angle (aimAngle already defaults to lastAimAngle
    // above), not snap to wherever the untouched mouse cursor happens to be. That
    // fallthrough was what made the aim indicator feel "detached"/delayed: it'd jump
    // to the mouse position every time the stick eased back toward center.
    if (!pad) {
      const dx = pointer.worldX - playerX;
      const dy = pointer.worldY - playerY;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        aimAngle = Math.atan2(dy, dx);
      }
    }

    dashHeld = dashHeld || this.keys.dash.isDown || pointer.rightButtonDown();
    slashHeld = slashHeld || this.keys.slash.isDown || pointer.leftButtonDown();

    const dashPressed = dashHeld && !this.prevDashHeld;
    const slashPressed = slashHeld && !this.prevSlashHeld;
    this.prevDashHeld = dashHeld;
    this.prevSlashHeld = slashHeld;
    this.lastAimAngle = aimAngle;

    return { moveX, moveY, aimAngle, dashHeld, dashPressed, slashHeld, slashPressed };
  }
}
