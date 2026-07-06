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

interface GamepadWrapper {
  index: number;
}

/**
 * Phaser's `refreshPads()` has a branch for when the same gamepad slot
 * reports a Gamepad with a different `id` string (a real DualSense-on-Mac
 * quirk - happens on things like a Bluetooth mode switch or reconnect that
 * keeps the same slot): it destroys the old wrapper and stores a brand new
 * one in `this.gamepads[index]`, but never re-points `_pad1`/`_pad2`/etc if
 * they were referencing the old one. `pad1` then permanently returns the
 * destroyed wrapper - `leftStick`/`rightStick` stay frozen at their last
 * values forever (they're plain fields, not getters, so no error), and
 * `isButtonDown`/`getButtonValue` silently see an empty `buttons` array
 * (destroy() clears it) and just always report "not pressed" - the pad
 * looks fully connected but every input silently stops registering, with no
 * console error. Reproduced directly: fake a same-slot id change and watch
 * `pad1.leftStick.x` freeze at its pre-change value forever.
 *
 * Fixed by re-syncing each `_padN` reference to whatever's actually stored
 * in `this.gamepads` at that same index immediately after every refresh.
 */
export function patchPhaserGamepadPluginStalePadReferenceBug(): void {
  const proto = Phaser.Input.Gamepad.GamepadPlugin.prototype as unknown as {
    gamepads: (GamepadWrapper | undefined)[];
    refreshPads: () => void;
    _pad1?: GamepadWrapper;
    _pad2?: GamepadWrapper;
    _pad3?: GamepadWrapper;
    _pad4?: GamepadWrapper;
  };

  const padKeys = ["_pad1", "_pad2", "_pad3", "_pad4"] as const;

  const originalRefreshPads = proto.refreshPads;
  proto.refreshPads = function (this: typeof proto) {
    originalRefreshPads.call(this);
    for (const key of padKeys) {
      const current = this[key];
      if (current && this.gamepads[current.index] !== current) {
        this[key] = this.gamepads[current.index];
      }
    }
  };
}
