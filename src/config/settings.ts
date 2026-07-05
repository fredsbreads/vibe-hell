export type AimMode = "free" | "virtualStick" | "movement";

const AIM_MODE_STORAGE_KEY = "vibehell.aimMode";
const AIM_MODE_CYCLE: AimMode[] = ["free", "virtualStick", "movement"];

/**
 * "free" aims with the right stick (or mouse relative to the player, if no
 * gamepad is connected). "virtualStick" aims with the mouse relative to a
 * fixed on-screen anchor instead of the player's (moving) position - like a
 * real analog stick mapped onto the mouse, so the same mouse position always
 * means the same aim direction regardless of where the player currently is
 * on screen. "movement" aims wherever you're currently moving instead, so
 * Slash needs no separate aim input at all - fully playable with just WASD +
 * Space (dash) + J (slash), no mouse or right stick required.
 * Persisted to localStorage so the choice survives page reloads, not just
 * scene restarts.
 */
export function getAimMode(): AimMode {
  const stored = localStorage.getItem(AIM_MODE_STORAGE_KEY);
  return (AIM_MODE_CYCLE as string[]).includes(stored ?? "") ? (stored as AimMode) : "free";
}
