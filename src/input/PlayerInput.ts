import Phaser from "phaser";
import { DualSenseMap, getPadButtonValue, isPadButtonDown } from "./DualSenseMap";
import { getAimMode } from "../config/settings";

const STICK_DEADZONE = 0.2;
const TRIGGER_THRESHOLD = 0.5;
// Minimum screen-pixel movement between frames to count as "the mouse was just
// used", so a stationary cursor never fights an idle-but-connected gamepad.
const MOUSE_MOVE_THRESHOLD = 2;

/**
 * Fixed screen-space offset (from the bottom-right corner) of the virtual
 * stick's anchor/neutral point, used by "virtualStick" aim mode and by
 * MainScene to draw the matching on-screen ring. A constant offset from the
 * canvas corner rather than a world position, since the whole point is that
 * this point never moves regardless of where the player is.
 */
export const VIRTUAL_STICK_MARGIN_X = 110;
export const VIRTUAL_STICK_MARGIN_Y = 110;
export const VIRTUAL_STICK_RADIUS = 60;

export function getVirtualStickAnchor(scene: Phaser.Scene): { x: number; y: number } {
  return {
    x: scene.scale.width - VIRTUAL_STICK_MARGIN_X,
    y: scene.scale.height - VIRTUAL_STICK_MARGIN_Y,
  };
}

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
  private prevPointerX: number | null = null;
  private prevPointerY: number | null = null;

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
    const aimMode = getAimMode();

    let moveX = 0;
    let moveY = 0;
    let aimAngle = this.lastAimAngle;
    let dashHeld = false;
    let slashHeld = false;

    // Candidate aim angle from the right stick this frame, or null if the pad
    // isn't connected or its stick is resting in the deadzone.
    let padAimAngle: number | null = null;

    if (pad) {
      moveX = applyDeadzone(pad.leftStick.x, STICK_DEADZONE);
      moveY = applyDeadzone(pad.leftStick.y, STICK_DEADZONE);

      if (aimMode === "free" || aimMode === "virtualStick") {
        const aimX = applyDeadzone(pad.rightStick.x, STICK_DEADZONE);
        const aimY = applyDeadzone(pad.rightStick.y, STICK_DEADZONE);
        if (aimX !== 0 || aimY !== 0) {
          padAimAngle = Math.atan2(aimY, aimX);
        }
      }

      const l2Value = getPadButtonValue(pad, DualSenseMap.L2);
      const crossHeld = isPadButtonDown(pad, DualSenseMap.CROSS);
      dashHeld = l2Value > TRIGGER_THRESHOLD || crossHeld;

      const r2Value = getPadButtonValue(pad, DualSenseMap.R2);
      const r1Held = isPadButtonDown(pad, DualSenseMap.R1);
      slashHeld = r2Value > TRIGGER_THRESHOLD || r1Held;
    }

    if (moveX === 0 && moveY === 0) {
      const kx = (this.keys.right.isDown ? 1 : 0) - (this.keys.left.isDown ? 1 : 0);
      const ky = (this.keys.down.isDown ? 1 : 0) - (this.keys.up.isDown ? 1 : 0);
      moveX = kx;
      moveY = ky;
    }

    const pointer = this.scene.input.activePointer;

    // Only treat the mouse as "just used" if it actually moved since last frame -
    // a stationary cursor sitting over an old position shouldn't count as active
    // input, or it'd permanently fight/override the gamepad (or vice versa)
    // depending purely on which one happened to be checked first.
    const mouseMoved =
      this.prevPointerX !== null &&
      this.prevPointerY !== null &&
      (Math.abs(pointer.x - this.prevPointerX) > MOUSE_MOVE_THRESHOLD ||
        Math.abs(pointer.y - this.prevPointerY) > MOUSE_MOVE_THRESHOLD);
    this.prevPointerX = pointer.x;
    this.prevPointerY = pointer.y;

    if (aimMode === "movement") {
      // Aim wherever you're currently moving instead of needing a separate aim
      // input - makes the game fully playable with just WASD + Space + J, no
      // mouse or right stick required. Holds the last direction while stationary
      // (aimAngle already defaults to lastAimAngle above) rather than aiming
      // nowhere.
      if (moveX !== 0 || moveY !== 0) {
        aimAngle = Math.atan2(moveY, moveX);
      }
    } else if (padAimAngle !== null) {
      // The stick actually moved this frame - it wins over the mouse outright,
      // regardless of whether the mouse also happened to move.
      aimAngle = padAimAngle;
    } else if (mouseMoved && aimMode === "virtualStick") {
      // Aim from a fixed on-screen anchor to the mouse, instead of from the
      // player's (moving) position to the mouse. With player-relative aiming, the
      // mouse position needed to represent "aim east" keeps changing as the player
      // moves around the arena, since it depends on where the player currently is
      // on screen - constantly chasing a moving reference point. Anchoring to a
      // fixed screen point means the same mouse position always means the same
      // aim direction, like a real analog stick mapped onto the mouse.
      const anchor = getVirtualStickAnchor(this.scene);
      const dx = pointer.x - anchor.x;
      const dy = pointer.y - anchor.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        aimAngle = Math.atan2(dy, dx);
      }
    } else if (mouseMoved) {
      // The mouse was just moved, so it takes over aiming even with a gamepad
      // connected - only an idle mouse (no recent movement) yields to holding
      // the last stick-commanded angle instead of snapping to a stale cursor
      // position. That stick-priority-while-idle behavior is what keeps the
      // aim indicator from feeling "detached"/delayed when the stick eases back
      // toward center; letting mouse movement itself take priority is what lets
      // the player actually switch back to mouse aim at will.
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

  /**
   * Re-syncs dash/slash edge-detection to whatever's currently held, without
   * treating it as a fresh press. Dash and Slash share buttons with menu
   * confirm (Cross/Enter and click), and read() isn't called at all while
   * paused - so without this, resuming with the same button still held would
   * see dashHeld/slashHeld flip from their stale pre-pause value to true with
   * no edge in between, firing an action the instant gameplay resumes that
   * the player only meant as a menu confirm. Call this right after leaving a
   * paused state.
   */
  resyncHeldState(playerX: number, playerY: number): void {
    this.read(playerX, playerY);
  }
}
