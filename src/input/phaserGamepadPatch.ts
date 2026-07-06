import Phaser from "phaser";

/**
 * Phaser 3.90's GamepadPlugin indexes `this.gamepads` by the browser's raw
 * gamepad slot number (Gamepad.index), not by insertion order - so if a
 * controller connects into a non-zero slot (e.g. slot 0 sits empty while a
 * Bluetooth pad claims slot 1, which happens easily with a PS5 controller,
 * or if another virtual HID device briefly occupies a slot), the array ends
 * up with holes. `stopListeners()` and `disconnectAll()` both iterate that
 * array with a plain for-loop and call a method on every entry with no null
 * check, throwing "Cannot read properties of undefined (reading
 * 'removeAllListeners')" the next time any scene shuts down (title -> main,
 * restart, etc.) - effectively freezing the game. `destroy()` a few lines
 * down in the same file already guards with `if (this.gamepads[i])`, so this
 * is an inconsistency/bug in Phaser itself rather than intentional.
 *
 * Compacting the array immediately before each original call is a minimal,
 * behavior-preserving fix: every remaining entry is still a real live pad,
 * and nothing else reads `this.gamepads` after either of these run (both are
 * only called during teardown).
 */
export function patchPhaserGamepadPluginSparseArrayBug(): void {
  const proto = Phaser.Input.Gamepad.GamepadPlugin.prototype as unknown as {
    gamepads: unknown[];
    stopListeners: () => void;
    disconnectAll: () => void;
  };

  const originalStopListeners = proto.stopListeners;
  proto.stopListeners = function (this: typeof proto) {
    this.gamepads = this.gamepads.filter(Boolean);
    originalStopListeners.call(this);
  };

  const originalDisconnectAll = proto.disconnectAll;
  proto.disconnectAll = function (this: typeof proto) {
    this.gamepads = this.gamepads.filter(Boolean);
    originalDisconnectAll.call(this);
  };
}
